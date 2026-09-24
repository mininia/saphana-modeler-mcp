/**
 * 会话与阻塞深潜服务（hana_system_activity 的落地实现）。
 *
 * 为什么单列一个工具而不并进健康检查：形状不同。健康检查回答"有没有问题"（阈值判定），
 * 这里回答"问题在哪、谁造成的"（拓扑与明细）。把明细塞进健康检查会让后者每次都吐出几屏数据。
 *
 * 视图选择（实测，见 docs/health-monitoring-findings.md §六）：
 *  - 阻塞用 `M_BLOCKED_TRANSACTIONS`，**不是** `M_LOCKS`（后者在 HANA 2.00.085 上不存在，
 *    参考实现的 blocking 命令正是栽在这里）。
 *  - `M_BLOCKED_TRANSACTIONS` 自带 LOCK_OWNER_CONNECTION_ID，可直接建出"谁堵谁"的链。
 */

import type { HanaPool } from '../core/hana-client.js';
import { probeVisibility, emptyIsAmbiguous, type Visibility } from './visibility.service.js';
import { formatDuration } from './health.rules.js';

/** 可查询的段落 */
export type ActivitySection = 'blocking' | 'transactions' | 'statements';
export const ALL_SECTIONS: readonly ActivitySection[] = ['blocking', 'transactions', 'statements'];

export interface ActivityRequest {
  sections: ActivitySection[];
  /** 只报告持续超过该秒数的事务/语句 */
  minDurationSec: number;
  /** 每段最多返回多少条 */
  limit: number;
}

/** 一次连接的画像（从 M_CONNECTIONS 按需取，避免全表拉回） */
interface ConnInfo {
  user: string;
  clientHost: string;
  application: string;
  schema: string;
  type: string;
}

/** 阻塞链的一项 */
export interface BlockingItem {
  waitingSec: number;
  blockedConnection: number;
  ownerConnection: number;
  blockedSince: string;
  object: string;
  lockType: string;
  lockMode: string;
  /** "堵住别人"那一方是谁（用户/客户端/应用） */
  owner: ConnInfo | null;
  /** 被堵住那一方是谁 */
  blocked: ConnInfo | null;
}

export interface LongTransactionItem {
  connection: number;
  transaction: number;
  startTime: string;
  elapsedSec: number;
  undoBytes: number;
  createdVersions: number;
  allocatedVersionBytes: number;
  acquiredLocks: number;
  lockWaitCount: number;
  connectionInfo: ConnInfo | null;
  /** 该连接当前正在执行的语句（取自 M_ACTIVE_STATEMENTS，已截断） */
  currentStatement: string | null;
}

export interface LongStatementItem {
  connection: number;
  statementId: string;
  statementHash: string;
  status: string;
  /** 自"上次开始执行"起的秒数（近似值，见下方说明） */
  elapsedSec: number;
  compiledTime: string;
  lastExecutedTime: string;
  usedMemoryBytes: number;
  lockWaitSec: number;
  application: string;
  statement: string;
  connectionInfo: ConnInfo | null;
}

export interface ActivityReport {
  checkedAt: string;
  minDurationSec: number;
  /**
   * 可见性上下文。缺 CATALOG READ / MONITORING 时，这些视图只返回**自己**的会话/事务/语句，
   * 于是"0 个阻塞"可能只是"看不到别人的阻塞"——结论会附 caveat 说明，不会冒充"集群无阻塞"。
   */
  visibility: Visibility;
  blocking?: { count: number; items: BlockingItem[] };
  transactions?: { count: number; items: LongTransactionItem[] };
  statements?: { count: number; items: LongStatementItem[] };
  summary: string;
  /** 结果可能被行过滤时的提示（仅在缺权限且某段为空时出现） */
  caveats: string[];
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round = (v: number, d = 2): number => Number(v.toFixed(d));
const truncate = (s: string | null | undefined, n = 400): string =>
  s == null ? '' : s.length > n ? `${s.slice(0, n)}…（已截断，共 ${s.length} 字符）` : s;

/** 取一批连接的画像：按需 IN 查询，避免把 M_CONNECTIONS（实测 8810 行）整表拉回 */
async function fetchConnections(pool: HanaPool, ids: number[]): Promise<Map<number, ConnInfo>> {
  const uniq = Array.from(new Set(ids.filter((i) => Number.isFinite(i))));
  const map = new Map<number, ConnInfo>();
  if (uniq.length === 0) return map;
  const placeholders = uniq.map(() => '?').join(', ');
  const rows = await pool.query<{
    CONNECTION_ID: unknown; USER_NAME: string; CLIENT_HOST: string; CLIENT_APPLICATION: string;
    CURRENT_SCHEMA_NAME: string; CONNECTION_TYPE: string;
  }>(
    `SELECT CONNECTION_ID, USER_NAME, CLIENT_HOST, CLIENT_APPLICATION, CURRENT_SCHEMA_NAME, CONNECTION_TYPE
     FROM SYS.M_CONNECTIONS WHERE CONNECTION_ID IN (${placeholders})`,
    uniq,
  );
  for (const r of rows) {
    map.set(num(r.CONNECTION_ID), {
      user: r.USER_NAME ?? '',
      clientHost: r.CLIENT_HOST ?? '',
      application: r.CLIENT_APPLICATION ?? '',
      schema: r.CURRENT_SCHEMA_NAME ?? '',
      type: r.CONNECTION_TYPE ?? '',
    });
  }
  return map;
}

/** 取一批连接当前正在执行的语句（取每连接最新一条） */
async function fetchCurrentStatements(pool: HanaPool, ids: number[]): Promise<Map<number, string>> {
  const uniq = Array.from(new Set(ids.filter((i) => Number.isFinite(i))));
  const map = new Map<number, string>();
  if (uniq.length === 0) return map;
  const placeholders = uniq.map(() => '?').join(', ');
  const rows = await pool.query<{ CONNECTION_ID: unknown; STATEMENT_STRING: string; COMPILED_TIME: string }>(
    `SELECT CONNECTION_ID, STATEMENT_STRING, COMPILED_TIME
     FROM SYS.M_ACTIVE_STATEMENTS
     WHERE CONNECTION_ID IN (${placeholders})
     ORDER BY COMPILED_TIME DESC`,
    uniq,
  );
  for (const r of rows) {
    const id = num(r.CONNECTION_ID);
    if (!map.has(id)) map.set(id, truncate(r.STATEMENT_STRING)); // ORDER BY 保证首次遇到的就是最新
  }
  return map;
}

async function collectBlocking(pool: HanaPool, limit: number): Promise<NonNullable<ActivityReport['blocking']>> {
  const rows = await pool.query<{
    BLOCKED_CONNECTION_ID: unknown; LOCK_OWNER_CONNECTION_ID: unknown; BLOCKED_TIME: string;
    WAITING_SCHEMA_NAME: string; WAITING_TABLE_NAME: string; WAITING_OBJECT_NAME: string;
    LOCK_TYPE: string; LOCK_MODE: string; WAIT_SEC: unknown;
  }>(
    `SELECT BLOCKED_CONNECTION_ID, LOCK_OWNER_CONNECTION_ID, BLOCKED_TIME,
            WAITING_SCHEMA_NAME, WAITING_TABLE_NAME, WAITING_OBJECT_NAME,
            LOCK_TYPE, LOCK_MODE,
            SECONDS_BETWEEN(BLOCKED_TIME, CURRENT_TIMESTAMP) AS WAIT_SEC
     FROM SYS.M_BLOCKED_TRANSACTIONS ORDER BY WAIT_SEC DESC LIMIT ?`,
    [limit],
  );
  const conns = await fetchConnections(
    pool,
    rows.flatMap((r) => [num(r.BLOCKED_CONNECTION_ID), num(r.LOCK_OWNER_CONNECTION_ID)]),
  );
  return {
    count: rows.length,
    items: rows.map((r) => ({
      waitingSec: round(num(r.WAIT_SEC), 1),
      blockedConnection: num(r.BLOCKED_CONNECTION_ID),
      ownerConnection: num(r.LOCK_OWNER_CONNECTION_ID),
      blockedSince: r.BLOCKED_TIME,
      object: [r.WAITING_SCHEMA_NAME, r.WAITING_TABLE_NAME || r.WAITING_OBJECT_NAME]
        .filter(Boolean).join('.'),
      lockType: r.LOCK_TYPE,
      lockMode: r.LOCK_MODE,
      owner: conns.get(num(r.LOCK_OWNER_CONNECTION_ID)) ?? null,
      blocked: conns.get(num(r.BLOCKED_CONNECTION_ID)) ?? null,
    })),
  };
}

async function collectTransactions(
  pool: HanaPool,
  minDurationSec: number,
  limit: number,
): Promise<NonNullable<ActivityReport['transactions']>> {
  const rows = await pool.query<{
    CONNECTION_ID: unknown; TRANSACTION_ID: unknown; START_TIME: string; ELAPSED_SEC: unknown;
    UNDO_LOG_AMOUNT: unknown; CREATED_VERSION_COUNT: unknown; ALLOCATED_VERSION_SIZE: unknown;
    ACQUIRED_LOCK_COUNT: unknown; LOCK_WAIT_COUNT: unknown;
  }>(
    `SELECT CONNECTION_ID, TRANSACTION_ID, START_TIME,
            SECONDS_BETWEEN(START_TIME, CURRENT_TIMESTAMP) AS ELAPSED_SEC,
            UNDO_LOG_AMOUNT, CREATED_VERSION_COUNT, ALLOCATED_VERSION_SIZE,
            ACQUIRED_LOCK_COUNT, LOCK_WAIT_COUNT
     FROM SYS.M_TRANSACTIONS
     WHERE TRANSACTION_STATUS = 'ACTIVE' AND TRANSACTION_TYPE = 'USER TRANSACTION'
       AND START_TIME < ADD_SECONDS(CURRENT_TIMESTAMP, -?)
     ORDER BY ELAPSED_SEC DESC LIMIT ?`,
    [minDurationSec, limit],
  );
  const ids = rows.map((r) => num(r.CONNECTION_ID));
  const conns = await fetchConnections(pool, ids);
  const stmts = await fetchCurrentStatements(pool, ids);
  return {
    count: rows.length,
    items: rows.map((r) => {
      const id = num(r.CONNECTION_ID);
      return {
        connection: id,
        transaction: num(r.TRANSACTION_ID),
        startTime: r.START_TIME,
        elapsedSec: round(num(r.ELAPSED_SEC), 1),
        undoBytes: num(r.UNDO_LOG_AMOUNT),
        createdVersions: num(r.CREATED_VERSION_COUNT),
        allocatedVersionBytes: num(r.ALLOCATED_VERSION_SIZE),
        acquiredLocks: num(r.ACQUIRED_LOCK_COUNT),
        lockWaitCount: num(r.LOCK_WAIT_COUNT),
        connectionInfo: conns.get(id) ?? null,
        currentStatement: stmts.get(id) ?? null,
      };
    }),
  };
}

async function collectStatements(
  pool: HanaPool,
  minDurationSec: number,
  limit: number,
): Promise<NonNullable<ActivityReport['statements']>> {
  // 耗时口径说明：M_ACTIVE_STATEMENTS **没有**"本次执行已耗时"这一列（实测 47 列里没有，
  // 只有历史聚合统计）。这里取 LAST_EXECUTED_TIME（本次执行的开始时刻）与当前时间之差，
  // 并把 COMPILED_TIME / LAST_EXECUTED_TIME 一并放进 evidence 供复核。
  // 注意 M_EXPENSIVE_STATEMENTS 才有现成的 DURATION_MICROSEC，但它在两套实测环境里都是空表。
  const rows = await pool.query<{
    CONNECTION_ID: unknown; STATEMENT_ID: string; STATEMENT_HASH: string; STATEMENT_STATUS: string;
    ELAPSED_SEC: unknown; COMPILED_TIME: string; LAST_EXECUTED_TIME: string;
    USED_MEMORY_SIZE: unknown; MAX_LOCKWAIT_TIME: unknown; APPLICATION_SOURCE: string;
    STATEMENT_STRING: string;
  }>(
    `SELECT CONNECTION_ID, STATEMENT_ID, STATEMENT_HASH, STATEMENT_STATUS,
            SECONDS_BETWEEN(LAST_EXECUTED_TIME, CURRENT_TIMESTAMP) AS ELAPSED_SEC,
            COMPILED_TIME, LAST_EXECUTED_TIME, USED_MEMORY_SIZE, MAX_LOCKWAIT_TIME,
            APPLICATION_SOURCE, STATEMENT_STRING
     FROM SYS.M_ACTIVE_STATEMENTS
     WHERE STATEMENT_STATUS = 'ACTIVE'
       AND LAST_EXECUTED_TIME IS NOT NULL
       AND LAST_EXECUTED_TIME < ADD_SECONDS(CURRENT_TIMESTAMP, -?)
     ORDER BY ELAPSED_SEC DESC LIMIT ?`,
    [minDurationSec, limit],
  );
  const ids = rows.map((r) => num(r.CONNECTION_ID));
  const conns = await fetchConnections(pool, ids);
  return {
    count: rows.length,
    items: rows.map((r) => {
      const id = num(r.CONNECTION_ID);
      return {
        connection: id,
        statementId: String(r.STATEMENT_ID ?? ''),
        statementHash: String(r.STATEMENT_HASH ?? ''),
        status: r.STATEMENT_STATUS ?? '',
        elapsedSec: round(num(r.ELAPSED_SEC), 1),
        compiledTime: r.COMPILED_TIME,
        lastExecutedTime: r.LAST_EXECUTED_TIME,
        usedMemoryBytes: num(r.USED_MEMORY_SIZE),
        lockWaitSec: round(num(r.MAX_LOCKWAIT_TIME) / 1e6, 2),
        application: r.APPLICATION_SOURCE ?? '',
        statement: truncate(r.STATEMENT_STRING),
        connectionInfo: conns.get(id) ?? null,
      };
    }),
  };
}

/** 执行会话与阻塞深潜 */
export async function runActivity(pool: HanaPool, req: ActivityRequest): Promise<ActivityReport> {
  const visibility = await probeVisibility(pool);
  const report: ActivityReport = {
    checkedAt: new Date().toISOString(),
    minDurationSec: req.minDurationSec,
    visibility,
    caveats: [],
    // 先占位，各段收集完后统一覆写（放在这里是为了让对象字面量一次满足类型）
    summary: '',
  };
  const parts: string[] = [];

  if (req.sections.includes('blocking')) {
    report.blocking = await collectBlocking(pool, req.limit);
    if (report.blocking.count === 0) {
      parts.push('当前无被阻塞的事务');
      pushCaveat(report, visibility, '阻塞');
    } else {
      parts.push(`${report.blocking.count} 个事务被阻塞，最长 ${formatDuration(report.blocking.items[0].waitingSec)}`);
    }
  }
  if (req.sections.includes('transactions')) {
    report.transactions = await collectTransactions(pool, req.minDurationSec, req.limit);
    if (report.transactions.count === 0) {
      parts.push(`无超过 ${req.minDurationSec} 秒的活跃事务`);
      pushCaveat(report, visibility, '长事务');
    } else {
      parts.push(`${report.transactions.count} 个长事务，最长 ${formatDuration(report.transactions.items[0].elapsedSec)}`);
    }
  }
  if (req.sections.includes('statements')) {
    report.statements = await collectStatements(pool, req.minDurationSec, req.limit);
    if (report.statements.count === 0) {
      parts.push(`无超过 ${req.minDurationSec} 秒的活跃语句`);
      pushCaveat(report, visibility, '长语句');
    } else {
      parts.push(`${report.statements.count} 条长语句，最长 ${formatDuration(report.statements.items[0].elapsedSec)}`);
    }
  }

  report.summary = parts.join('；') + '。';
  return report;
}

/** 空结果 + 无全量权限 → 附一条 caveat（不让"0 条"被读成"没问题"） */
function pushCaveat(report: ActivityReport, visibility: Visibility, what: string): void {
  const c = emptyIsAmbiguous(0, visibility.unfiltered);
  if (c) report.caveats.push(`${what}：${c}`);
}

/** 校验 sections 参数（工具层调用） */
export function normalizeSections(sections?: string[]): { ok: true; value: ActivitySection[] } | { ok: false; message: string } {
  if (!sections || sections.length === 0) return { ok: true, value: [...ALL_SECTIONS] };
  const invalid = sections.filter((s) => !ALL_SECTIONS.includes(s as ActivitySection));
  if (invalid.length > 0) {
    return { ok: false, message: `未知的段落：${invalid.join(', ')}；合法值：${ALL_SECTIONS.join(', ')}` };
  }
  return { ok: true, value: sections as ActivitySection[] };
}
