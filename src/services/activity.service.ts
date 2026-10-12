/**
 * 会话与阻塞深潜服务（hana_system_activity 的落地实现）。
 *
 * 为什么单列一个工具而不并进健康检查：形状不同。健康检查回答"有没有问题"（阈值判定），
 * 这里回答"问题在哪、谁造成的"（拓扑与明细）。把明细塞进健康检查会让后者每次都吐出几屏数据。
 *
 * 视图选择（实测）：
 *  - 阻塞用 `M_BLOCKED_TRANSACTIONS`，**不是** `M_LOCKS`（后者在 HANA 2.00.085 上不存在，
 *    参考实现的 blocking 命令正是栽在这里）。
 *  - `M_BLOCKED_TRANSACTIONS` 自带 LOCK_OWNER_CONNECTION_ID，可直接建出"谁堵谁"的链。
 */

import type { HanaPool } from '../core/hana-client.js';
import { num, round, US_PER_SECOND } from '../core/num.js';
import { truncateWithNote } from '../core/text.js';
import { logger } from '../core/logger.js';
import { probeVisibility, emptyIsAmbiguous, type Visibility } from './visibility.service.js';
import {
  addCaveat,
  countBlockedTransactions,
  countLongTransactions,
  fetchBlockedTransactions,
  fetchLongTransactions,
  formatDuration,
  reportCheckedAt,
  waitingObjectName,
  type DiagnosticReportBase,
} from './health.rules.js';

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

export interface ActivityReport extends DiagnosticReportBase {
  minDurationSec: number;
  /**
   * 可见性上下文。缺 CATALOG READ / MONITORING 时，这些视图只返回**自己**的会话/事务/语句，
   * 于是"0 个阻塞"可能只是"看不到别人的阻塞"——结论会附 caveat 说明，不会冒充"集群无阻塞"。
   */
  visibility: Visibility;
  /**
   * 各段条数：`count` 是**满足条件的真实总数**（来自不带 LIMIT 的 COUNT(*)），
   * `items` 只含前 limit 条明细——两者不等时报告会附一条 caveat 说明成因
   * （count > limit 即被 limit 截断；count ≤ limit 则是两次查询之间的竞态，重查可得）。
   * 禁止把 count 读成"本次明细条数"。
   */
  blocking?: { count: number; items: BlockingItem[] };
  transactions?: { count: number; items: LongTransactionItem[] };
  statements?: { count: number; items: LongStatementItem[] };
  summary: string;
  /** 结果可能被行过滤（缺权限且某段为空），或规模少报（limit 截断、计数与明细竞态）时的提示 */
  caveats: string[];
}

/** 取一批连接的画像：按需 IN 查询，避免把 M_CONNECTIONS（实测 8810 行）整表拉回 */
async function fetchConnections(pool: HanaPool, ids: number[]): Promise<Map<number, ConnInfo>> {
  const uniq = Array.from(new Set(ids.filter((i) => Number.isFinite(i))));
  const map = new Map<number, ConnInfo>();
  if (uniq.length === 0) return map;
  const placeholders = uniq.map(() => '?').join(', ');
  const rows = await pool.query<{
    CONNECTION_ID: unknown;
    USER_NAME: string;
    CLIENT_HOST: string;
    CLIENT_APPLICATION: string;
    CURRENT_SCHEMA_NAME: string;
    CONNECTION_TYPE: string;
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
    if (!map.has(id)) map.set(id, truncateWithNote(r.STATEMENT_STRING, 400)); // ORDER BY 保证首次遇到的就是最新
  }
  return map;
}

async function collectBlocking(pool: HanaPool, limit: number): Promise<NonNullable<ActivityReport['blocking']>> {
  // 取数与"对象"串同 health 的 blocked 规则共用（health.rules 的 fetchBlockedTransactions /
  // waitingObjectName）：同一视图、同一行在两个工具里必须给出同一个对象名。
  const rows = await fetchBlockedTransactions(pool, limit);
  const conns = await fetchConnections(
    pool,
    rows.flatMap((r) => [num(r.BLOCKED_CONNECTION_ID), num(r.LOCK_OWNER_CONNECTION_ID)]),
  );
  // 计数不带 LIMIT：明细被截断时 count 仍是真实总数（否则 200 个阻塞事务会被报成 limit 个）。
  // Math.max 是防御：两条查询之间数据变化时，总数不得小于已列出的条数。
  return {
    count: Math.max(await countBlockedTransactions(pool), rows.length),
    items: rows.map((r) => ({
      waitingSec: round(num(r.WAIT_SEC), 1),
      blockedConnection: num(r.BLOCKED_CONNECTION_ID),
      ownerConnection: num(r.LOCK_OWNER_CONNECTION_ID),
      blockedSince: r.BLOCKED_TIME,
      object: waitingObjectName(r),
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
  // 取数同 health 的 transactions 规则共用（health.rules 的 fetchLongTransactions）
  const rows = await fetchLongTransactions(pool, minDurationSec, limit);
  const ids = rows.map((r) => num(r.CONNECTION_ID));
  const conns = await fetchConnections(pool, ids);
  const stmts = await fetchCurrentStatements(pool, ids);
  // 同 collectBlocking：count 用不带 LIMIT 的 COUNT(*) 取真实总数（明细只含前 limit 条）
  return {
    count: Math.max(await countLongTransactions(pool, minDurationSec), rows.length),
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
    CONNECTION_ID: unknown;
    STATEMENT_ID: string;
    STATEMENT_HASH: string;
    STATEMENT_STATUS: string;
    ELAPSED_SEC: unknown;
    COMPILED_TIME: string;
    LAST_EXECUTED_TIME: string;
    USED_MEMORY_SIZE: unknown;
    MAX_LOCKWAIT_TIME: unknown;
    APPLICATION_SOURCE: string;
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
  // 同 collectBlocking：count 用不带 LIMIT 的 COUNT(*) 取真实总数（明细只含前 limit 条）
  const cnt = await pool.query<{ N: unknown }>(
    `SELECT COUNT(*) AS N
     FROM SYS.M_ACTIVE_STATEMENTS
     WHERE STATEMENT_STATUS = 'ACTIVE'
       AND LAST_EXECUTED_TIME IS NOT NULL
       AND LAST_EXECUTED_TIME < ADD_SECONDS(CURRENT_TIMESTAMP, -?)`,
    [minDurationSec],
  );
  return {
    count: Math.max(num(cnt[0]?.N), rows.length),
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
        lockWaitSec: round(num(r.MAX_LOCKWAIT_TIME) / US_PER_SECOND, 2),
        application: r.APPLICATION_SOURCE ?? '',
        statement: truncateWithNote(r.STATEMENT_STRING, 400),
        connectionInfo: conns.get(id) ?? null,
      };
    }),
  };
}

/** 执行会话与阻塞深潜 */
export async function runActivity(pool: HanaPool, req: ActivityRequest): Promise<ActivityReport> {
  const visibility = await probeVisibility(pool);
  const report: ActivityReport = {
    checkedAt: reportCheckedAt(),
    minDurationSec: req.minDurationSec,
    visibility,
    caveats: [],
    // 先占位，各段收集完后统一覆写（放在这里是为了让对象字面量一次满足类型）
    summary: '',
  };
  const parts: string[] = [];

  if (req.sections.includes('blocking')) {
    report.blocking = await collectBlocking(pool, req.limit);
    // 分支看**明细条数**（绝不对空数组取 [0]）；count 是真实总数，可能 > 明细条数
    // （被 limit 截断，或计数与明细两次查询之间的瞬间竞态——后者只报总数并提示重查）
    if (report.blocking.items.length === 0) {
      if (report.blocking.count === 0) {
        parts.push('当前无被阻塞的事务');
        pushCaveat(report, visibility, '阻塞');
      } else {
        parts.push(`${report.blocking.count} 个事务被阻塞（明细未取到，重查可得）`);
      }
    } else {
      parts.push(`${report.blocking.count} 个事务被阻塞，最长 ${formatDuration(report.blocking.items[0].waitingSec)}`);
      pushTruncationCaveat(report, report.blocking, req.limit, '阻塞');
    }
  }
  if (req.sections.includes('transactions')) {
    report.transactions = await collectTransactions(pool, req.minDurationSec, req.limit);
    if (report.transactions.items.length === 0) {
      if (report.transactions.count === 0) {
        parts.push(`无超过 ${req.minDurationSec} 秒的活跃事务`);
        pushCaveat(report, visibility, '长事务');
      } else {
        parts.push(`${report.transactions.count} 个长事务（明细未取到，重查可得）`);
      }
    } else {
      parts.push(
        `${report.transactions.count} 个长事务，最长 ${formatDuration(report.transactions.items[0].elapsedSec)}`,
      );
      pushTruncationCaveat(report, report.transactions, req.limit, '长事务');
    }
  }
  if (req.sections.includes('statements')) {
    report.statements = await collectStatements(pool, req.minDurationSec, req.limit);
    if (report.statements.items.length === 0) {
      if (report.statements.count === 0) {
        parts.push(`无超过 ${req.minDurationSec} 秒的活跃语句`);
        pushCaveat(report, visibility, '长语句');
      } else {
        parts.push(`${report.statements.count} 条长语句（明细未取到，重查可得）`);
      }
    } else {
      parts.push(`${report.statements.count} 条长语句，最长 ${formatDuration(report.statements.items[0].elapsedSec)}`);
      pushTruncationCaveat(report, report.statements, req.limit, '长语句');
    }
  }

  report.summary = parts.join('；') + '。';
  return report;
}

/**
 * 空结果 + 无全量权限 → 附一条 caveat（不让"0 条"被读成"没问题"）。
 * 同时记一条服务端日志：caveat 意味着结论被降级，排障时需要知道是哪一段、在什么权限档位下发生的。
 */
function pushCaveat(report: ActivityReport, visibility: Visibility, what: string): void {
  const c = emptyIsAmbiguous(0, visibility.unfiltered);
  if (c) {
    logger.warn({ section: what, unfiltered: visibility.unfiltered }, '空结果可能来自行过滤，已附加 caveat');
    addCaveat(report.caveats, `${what}：${c}`);
  }
}

/**
 * 真实总数 > 返回明细条数 → 附一条 caveat。
 * 少报规模与"把看不见当正常"同样误导：200 个被阻塞事务被读成 limit 个，影响面与排障优先级会判错。
 *
 * 成因有两种，措辞不能混：count 来自与明细**不同时刻**的 COUNT(*)——
 *  - 明细取满 limit（items.length === limit）：多出来的差额只能是被 limit 截掉的；
 *  - 明细没取满却仍与 count 不等：limit 截不出这种差距，只能是两次查询之间的瞬时竞态，应如实说明成因。
 */
function pushTruncationCaveat(
  report: ActivityReport,
  section: { count: number; items: readonly unknown[] },
  limit: number,
  what: string,
): void {
  if (section.count <= section.items.length) return;
  if (section.items.length >= limit) {
    addCaveat(
      report.caveats,
      `${what}：实际 ${section.count} 条，明细已按 limit=${limit} 截断为前 ${section.items.length} 条`,
    );
  } else {
    addCaveat(
      report.caveats,
      `${what}：实际 ${section.count} 条，明细取到 ${section.items.length} 条（计数与明细两次查询之间数据变化，重查可得）`,
    );
  }
}

/** 校验 sections 参数（工具层调用） */
export function normalizeSections(
  sections?: string[],
): { ok: true; value: ActivitySection[] } | { ok: false; message: string } {
  if (!sections || sections.length === 0) return { ok: true, value: [...ALL_SECTIONS] };
  const invalid = sections.filter((s) => !ALL_SECTIONS.includes(s as ActivitySection));
  if (invalid.length > 0) {
    return { ok: false, message: `未知的段落：${invalid.join(', ')}；合法值：${ALL_SECTIONS.join(', ')}` };
  }
  return { ok: true, value: sections as ActivitySection[] };
}
