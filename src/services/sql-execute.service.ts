/**
 * hana_sql_execute 服务层：在**一条池连接**上执行 SQL 脚本。
 *
 * 分工（与 tools/sql-execute.tools.ts）：
 * - 工具层先跑 `parseSqlScript`，把 problem 变成可恢复的 mcpErrorText（零 I/O）；
 * - 本层**再跑一次同一份规则**（服务层兜底；直调服务也不经过工具层），然后：
 *   · 单条 read → execLimitedOn；单条写/管理类 → execUpdateOn；
 *   · 多语句 → 同一条连接顺序执行；**有写**时用 withTransactionOn 包住（全部成功才 commit，
 *     失败 rollback，finally 恢复 autoCommit=true）。只读多语句不开事务（无副作用可回滚）。
 * - 任何失败都标明**第几条语句**、是否已回滚；DDL 在 HANA 可能隐式提交，回执如实提示。
 *
 * 2026-11 产品决策：SQL 专用 schema 闸门已移除。本层不扫描 schema、不查 CURRENT_SCHEMA、
 * 不参与 HANA_READ_SCHEMA / 写 schema 白名单判定——能访问什么由数据库账号权限约束。
 *
 * 驱动交互全部在 core/hana-client.ts（本文件不 import @sap/hana-client）。
 */

import {
  execLimitedOn,
  execUpdateOn,
  withTransactionOn,
  type HanaConnection,
  type HanaPool,
} from '../core/hana-client.js';
import { HanaBusinessError, normalizeHanaError } from '../core/errors.js';
import {
  SQL_EXEC_TIMEOUT_MS_DEFAULT,
  SQL_MAX_RESULT_BYTES_DEFAULT,
  SQL_MAX_ROWS_DEFAULT,
  SQL_MAX_STATEMENTS_DEFAULT,
} from '../core/limits.js';
import type { HanaConfig } from '../config/config.js';
import { parseSqlScript, type SqlExecutePolicy, type SqlStatementKind } from './sql-execute.rules.js';

/** 从已加载配置取执行策略（默认值取自 core/limits；测试的残缺 config 也不会崩） */
export function sqlExecutePolicyOf(
  config: Pick<HanaConfig, 'sqlAllowMultiStatement' | 'sqlMaxStatements' | 'access' | 'readonlySql'>,
): SqlExecutePolicy {
  const readonly = config.access === 'readonly';
  const policy = config.readonlySql ?? 'select-only';
  return {
    allowMultiStatement: config.sqlAllowMultiStatement === true,
    maxStatements: config.sqlMaxStatements ?? SQL_MAX_STATEMENTS_DEFAULT,
    readOnly: readonly && policy === 'select-only',
    readonlySqlDeny: readonly && policy === 'deny',
  };
}

/** 单条语句的执行结果（SELECT 带列/行；DML/DDL/管理类带 affectedRows） */
export interface SqlExecuteStatementResult {
  /** 从 0 数的语句序号 */
  index: number;
  kind: SqlStatementKind;
  elapsedMs: number;
  affectedRows?: number;
  columns?: string[];
  /** 行数组，与 columns 对齐 */
  rows?: unknown[][];
  rowsFetched?: number;
  truncated?: boolean;
  truncationReason?: 'max-rows' | 'max-bytes';
  bytes?: number;
}

/** 一次调用的完整回执 */
export interface SqlExecuteResult {
  statementCount: number;
  statements: SqlExecuteStatementResult[];
  truncated: boolean;
  /** SQL 指纹（sha256 前 12 位；回执可对照，审计不落原文） */
  sqlHash: string;
  transaction: { used: boolean; committed: boolean; rolledBack: boolean };
  limits: {
    maxRows: number;
    maxResultBytes: number;
    timeoutMs: number;
    maxStatements: number;
  };
  warnings: string[];
}

/** 单条语句失败（内部用：服务层据此回报“第几条 / 是否回滚”） */
class SqlStatementFailure extends HanaBusinessError {
  constructor(
    readonly statementIndex: number,
    readonly statementKind: SqlStatementKind,
    cause: HanaBusinessError,
  ) {
    super(
      `第 ${statementIndex + 1} 条语句执行失败（${statementKind}）：${cause.message}`,
      cause.code,
      cause.sqlState,
      cause.messages,
    );
    this.name = 'SqlStatementFailure';
  }
}

interface ExecGuard {
  timeoutMs: number;
  maxRows: number;
  maxResultBytes: number;
}

/** 顺序执行全部语句；任一失败抛 SqlStatementFailure（带语句下标与类别） */
async function runStatements(
  conn: HanaConnection,
  statements: ReturnType<typeof parseSqlScript>['statements'],
  guard: ExecGuard,
): Promise<SqlExecuteStatementResult[]> {
  const out: SqlExecuteStatementResult[] = [];
  // 字节预算按**整次调用**累计：多条 SELECT 共享同一个 HANA_SQL_MAX_RESULT_BYTES，
  // 不能每条都各拿满额（否则多语句轻松突破部署上限）。
  let remainingBytes = guard.maxResultBytes;
  for (const statement of statements) {
    try {
      if (statement.kind === 'read') {
        const r = await execLimitedOn(conn, statement.sql, {
          ...guard,
          maxResultBytes: Math.max(0, remainingBytes),
        });
        remainingBytes = Math.max(0, remainingBytes - r.bytes);
        out.push({
          index: statement.index,
          kind: statement.kind,
          elapsedMs: r.wallClockMs,
          columns: r.columns,
          rows: r.rows,
          rowsFetched: r.rowsFetched,
          truncated: r.truncated,
          ...(r.truncationReason !== undefined ? { truncationReason: r.truncationReason } : {}),
          bytes: r.bytes,
        });
      } else {
        const r = await execUpdateOn(conn, statement.sql, { timeoutMs: guard.timeoutMs });
        out.push({
          index: statement.index,
          kind: statement.kind,
          elapsedMs: r.wallClockMs,
          ...(r.affectedRows !== undefined ? { affectedRows: r.affectedRows } : {}),
        });
      }
    } catch (e) {
      throw new SqlStatementFailure(statement.index, statement.kind, normalizeHanaError(e));
    }
  }
  return out;
}

/** 失败回执：保留原错误码/消息，补上回滚事实与 DDL 隐式提交提示 */
function failureWithContext(
  failure: unknown,
  opts: { transactionUsed: boolean; rolledBack: boolean; ddlExecuted: boolean; autoCommitRestored: boolean },
): HanaBusinessError {
  const err = normalizeHanaError(failure);
  const index = err instanceof SqlStatementFailure ? err.statementIndex : undefined;
  const kind = err instanceof SqlStatementFailure ? err.statementKind : undefined;
  const notes: string[] = [];
  if (opts.transactionUsed) {
    notes.push(opts.rolledBack ? '本次事务已回滚' : '本次事务回滚未成功（连接可能已不可用）');
  } else if (index !== undefined) {
    notes.push(
      kind === 'read' ? '只读语句失败，前序只读语句无写入影响' : '单条写语句自动提交（语句级原子），未使用显式事务',
    );
  }
  if (opts.ddlExecuted) notes.push('HANA 的 DDL/管理类语句可能隐式提交，回滚不保证撤销其效果');
  if (!opts.autoCommitRestored) notes.push('连接 autoCommit 未能恢复');
  const suffix = notes.length > 0 ? `（${notes.join('；')}）` : '';
  return new HanaBusinessError(
    `${err.message}${suffix}`,
    err.code ?? 'SQL_EXECUTE_FAILED',
    err.sqlState,
    err.messages,
    undefined,
    {
      ...(index !== undefined ? { failedStatement: index } : {}),
      ...(kind !== undefined ? { failedStatementKind: kind } : {}),
      transactionUsed: opts.transactionUsed,
      rolledBack: opts.rolledBack,
      ddlMayImplicitCommit: opts.ddlExecuted,
    },
  );
}

/** 本次调用的行数/超时参数（工具入参；缺省回落 core/limits 默认值） */
export interface SqlExecuteOptions {
  maxRows?: number;
  timeoutMs?: number;
}

/**
 * 执行一份 SQL 脚本（服务层入口）。
 *
 * 失败一律抛 HanaBusinessError（经 withErrorEnvelope 变成 success=false 信封）；
 * 失败回执的 raw.errorDetail 带 failedStatement（0 起）/ rolledBack / ddlMayImplicitCommit。
 */
export async function executeSql(
  pool: HanaPool,
  config: HanaConfig,
  raw: string,
  opts: SqlExecuteOptions = {},
): Promise<SqlExecuteResult> {
  const policy = sqlExecutePolicyOf(config);
  const parsed = parseSqlScript(raw, policy);
  if (parsed.problems.length > 0) {
    const first = parsed.problems[0];
    throw new HanaBusinessError(`${first.message}。${first.hint}`, first.code);
  }
  const guard: ExecGuard = {
    timeoutMs: opts.timeoutMs ?? SQL_EXEC_TIMEOUT_MS_DEFAULT,
    maxRows: opts.maxRows ?? SQL_MAX_ROWS_DEFAULT,
    maxResultBytes: config.sqlMaxResultBytes ?? SQL_MAX_RESULT_BYTES_DEFAULT,
  };
  // read 之外都按“可能写”处理（admin 里的 CALL/GRANT 也可能写；多语句时统一包事务更稳）
  const hasWrite = parsed.statements.some((s) => s.kind !== 'read');
  // DDL 与 admin 都可能隐式提交（GRANT / CREATE USER / ALTER SYSTEM / CALL 等），
  // 回执必须按“可能隐式提交”如实提示，不能只统计 kind='ddl'。
  const implicitCommitRisk = parsed.statements.some((s) => s.kind === 'ddl' || s.kind === 'admin');
  const warnings: string[] = [];

  return pool.withConnection(async (conn) => {
    const transaction = { used: false, committed: false, rolledBack: false };
    let statements: SqlExecuteStatementResult[];
    if (hasWrite && parsed.statements.length > 1) {
      // 多语句 + 有写：同一条连接上自动开事务。rollback 失败也要如实带回（rolledBack=false）。
      const outcome = await withTransactionOn(conn, () => runStatements(conn, parsed.statements, guard));
      transaction.used = true;
      if (!outcome.ok) {
        throw failureWithContext(outcome.error, {
          transactionUsed: true,
          rolledBack: outcome.rolledBack,
          ddlExecuted: implicitCommitRisk,
          autoCommitRestored: outcome.autoCommitRestored,
        });
      }
      transaction.committed = true;
      statements = outcome.value;
      if (implicitCommitRisk) {
        warnings.push('事务内含 DDL/管理类语句：HANA 可能隐式提交，COMMIT/ROLLBACK 不保证覆盖其效果');
      }
      if (!outcome.autoCommitRestored) {
        warnings.push('连接 autoCommit 未能恢复：该连接已被主动断开，不会归还到池中复用');
      }
    } else {
      // 单条语句（read 或写/管理类）与“只读多语句”都不开事务：
      // 单条写本身是语句级原子；只读多语句没有需要回滚的副作用。
      try {
        statements = await runStatements(conn, parsed.statements, guard);
      } catch (e) {
        throw failureWithContext(e, {
          transactionUsed: false,
          rolledBack: false,
          ddlExecuted: false,
          autoCommitRestored: true,
        });
      }
    }

    return {
      statementCount: statements.length,
      statements,
      truncated: statements.some((s) => s.truncated === true),
      sqlHash: parsed.fingerprint,
      transaction,
      limits: {
        maxRows: guard.maxRows,
        maxResultBytes: guard.maxResultBytes,
        timeoutMs: guard.timeoutMs,
        maxStatements: policy.maxStatements ?? SQL_MAX_STATEMENTS_DEFAULT,
      },
      warnings,
    };
  });
}
