import type { HanaConnection, HanaPool, HanaResultSet, HanaStatement } from '../core/hana-client.js';
import { HanaBusinessError, normalizeHanaError } from '../core/errors.js';
import { assertSchemaAllowed } from '../core/sql.js';
import { scanSqlSchemaRefs } from '../write-plan.js';
import { assertSqlReadScopes } from './read-scope.service.js';
import {
  ANALYZE_MAX_ROWS,
  ANALYZE_TIMEOUT_MS,
  DEFAULT_OPERATOR_LIMIT,
  HARD_OPERATOR_CAP,
  MAX_OPERATOR_LIMIT,
  analyzePlan,
  buildExplainStatement,
  generateStatementName,
  parseSqlStatement,
  renderPlan,
  validateAnalyzeRequest,
  type PlanConclusion,
  type PlanOperator,
  type PlanRow,
  type RequestProblem,
} from './sql-analyze.rules.js';

/**
 * hana_sql_analyze 服务层：SQL 执行计划（EXPLAIN PLAN）+ 可选的实际执行与运行时统计。
 *
 * 三条硬约束**全部来自真机实测**（test-verification/probe-explain-plan.mjs 与 verify-sql-analyze.mjs）：
 * 1. **计划表是全库可读的**（与最初推断相反，实测跨连接可见；行里记录写入者 CONNECTION_ID，
 *    断开连接也**不会**清掉）。所以：**唯一语句名是唯一的正确性保证**——同名是**追加**而非替换
 *    （实测同名两次 → 回读 4 行），而名字处于全库命名空间，复用/撞名会把别人的计划混进来，
 *    那是**错结果**不是慢结果。CONNECTION_ID 过滤是"只读自己这次写的"第二道；
 *    回读仍放在同一次 `withConnection` 内（写入与回读同连接，且清理也在同一条连接上完成），
 *    但注意这只是工程上的收拢，**不再是正确性前提**。
 * 2. **用完即清**：行不随连接销毁、会全库累积（实测），且该表**可 DELETE**（实测 2 行→0，33ms）——
 *    故回读后按唯一名删掉本次写入的行，避免长期运行后计划表被历史行塞满（失败不影响结果）。
 * 3. **EXPLAIN 不含实际执行信息**：编译期只有估计值；真实运行时统计只存在于计划缓存
 *    （M_SQL_PLAN_CACHE），故 analyze 模式是"先用**完全相同的语句文本**执行一次，
 *    再按文本关联到计划缓存条目"——这也正是 SAP 文档给的标准做法（重编译/参数感知计划）。
 *
 * 分组归 admin 的含义：本工具**不写业务数据、不碰仓库**，它是暴露面控制
 * （接受任意 SQL 文本 + 可选真实执行），不要把它当成有副作用的写工具。
 */

const PLAN_TABLE = 'SYS.EXPLAIN_PLAN_TABLE';
const PLAN_CACHE = 'SYS.M_SQL_PLAN_CACHE';

/**
 * 回读列：**不选 NCLOB**——OPERATOR_DETAILS / OPERATOR_PROPERTIES 列定义是 NCLOB（上限 2GB），
 * 默认整段拉回来会拖爆响应；verbose 时也在**服务端** SUBSTRING 截断。
 */
const READ_COLUMNS = [
  'OPERATOR_ID',
  'PARENT_OPERATOR_ID',
  'LEVEL',
  'POSITION',
  'OPERATOR_NAME',
  'EXECUTION_ENGINE',
  'SCHEMA_NAME',
  'TABLE_NAME',
  'TABLE_TYPE',
  'TABLE_SIZE',
  'OUTPUT_SIZE',
  'SUBTREE_COST',
];
const DETAIL_MAX_CHARS = 4000;
const VERBOSE_COLUMNS = [
  `SUBSTRING(OPERATOR_DETAILS, 1, ${DETAIL_MAX_CHARS}) AS OPERATOR_DETAILS`,
  `SUBSTRING(OPERATOR_PROPERTIES, 1, ${DETAIL_MAX_CHARS}) AS OPERATOR_PROPERTIES`,
];

/** 计划缓存里我们真正要的列（该视图约 120 列，SELECT * 是浪费） */
const CACHE_COLUMNS = [
  'PLAN_ID',
  'USER_NAME',
  // 条目编译时的 session schema：未限定表名当初就是按它解析的，判读取范围要用它而不是调用方的
  'SCHEMA_NAME',
  'STATEMENT_STRING',
  'EXECUTION_COUNT',
  'TOTAL_EXECUTION_TIME',
  'AVG_EXECUTION_TIME',
  'MAX_EXECUTION_TIME',
  'TOTAL_EXECUTION_CPU_TIME',
  'TOTAL_EXECUTION_MEMORY_SIZE',
  'TOTAL_LOCK_WAIT_DURATION',
  'TOTAL_RESULT_RECORD_COUNT',
  'LAST_EXECUTION_TIMESTAMP',
].join(', ');

/**
 * 按语句原文关联计划缓存条目时**必须用 LIKE 而不是 `=`**：
 * M_SQL_PLAN_CACHE.STATEMENT_STRING 是 LOB 列，等值比较会直接报
 * "Cannot compare NLocator and NLocator"（实测），LIKE 可用。
 * 因此 `%`/`_`/转义符本身都要转义——HANA 对象名里下划线极常见，漏转义会让匹配变成通配。
 */
const LIKE_ESCAPE_CHAR = '\\';
const LIKE_ESCAPE_SQL = `ESCAPE '${LIKE_ESCAPE_CHAR}'`;

function escapeLikePattern(text: string): string {
  return text
    .split(LIKE_ESCAPE_CHAR)
    .join(LIKE_ESCAPE_CHAR + LIKE_ESCAPE_CHAR)
    .replace(/[%_]/g, (m) => LIKE_ESCAPE_CHAR + m);
}

export interface SqlAnalyzeOptions {
  /** 要分析的语句（与 planId 二选一） */
  sql?: string;
  /** 计划缓存条目编号（与 sql 二选一） */
  planId?: number;
  /** 先实际执行（带行数上限与超时护栏）再分析；仅 sql 模式 */
  analyze?: boolean;
  /** 输出标签（**不进 SQL**；服务端始终用内部生成的唯一语句名） */
  statementName?: string;
  /** 附带**原始执行计划**（算子行 + 缩进文本树）；默认 false——默认只给分析结论 */
  raw?: boolean;
  /** 仅 raw=true 时生效：算子明细 OPERATOR_DETAILS/PROPERTIES（服务端截断） */
  verbose?: boolean;
  limit?: number;
}

/** 计划缓存条目的运行时统计（全聚合值，单位为 HANA 列定义） */
export interface RuntimeStats {
  planId?: number;
  userName?: string;
  executionCount?: number;
  totalExecutionTime?: number;
  avgExecutionTime?: number;
  maxExecutionTime?: number;
  totalCpuTime?: number;
  totalMemorySize?: number;
  totalLockWaitDuration?: number;
  totalResultRecordCount?: number;
  lastExecutionTimestamp?: string;
}

/** analyze 模式的实际执行结果（**不返回数据行**：取数有 hana_data_preview，本工具不是取数通道） */
export interface ExecutionStats {
  wallClockMs: number;
  rowsFetched: number;
  /** 取行上限（达到即停止拉取并关闭结果集） */
  maxRows: number;
  timeoutMs: number;
  serverProcessingTime?: number;
  serverCpuTime?: number;
  serverMemoryUsage?: number;
}

export interface SqlAnalyzeResult {
  /** sql=按语句文本编译解释；planCacheEntry=解释计划缓存条目；sqlExecuted=先执行再分析 */
  source: 'sql' | 'planCacheEntry' | 'sqlExecuted';
  /** 服务端生成的唯一语句名（回读凭它过滤） */
  statementName: string;
  /** 调用方给的输出标签（原样回显） */
  label?: string;
  /** 被解释的语句原文（plan_id 模式取自缓存） */
  statement: string;
  /** 写入这个计划的连接号（计划表**全库可读**，此值用于"只读自己这次写的行"的第二道过滤） */
  connectionId: number | null;
  /** 回读是否按 CONNECTION_ID 过滤（false=退化为仅按语句名过滤，如实回报） */
  connectionFiltered: boolean;
  /** **默认输出**：可读的分析结论（一句话结论 + 逐条发现 + 统计） */
  conclusion: PlanConclusion;
  /** 原始执行计划（仅 raw=true 时返回）：紧凑算子行 */
  operators?: PlanOperator[];
  /** 原始执行计划（仅 raw=true 时返回）：按层级缩进的文本树 */
  planText?: string;
  operatorCount: number;
  /** 是否因 limit 截断（raw=true 时才有意义） */
  truncated: boolean;
  rootCount: number;
  orphanCount: number;
  /** plan_id / analyze 模式：该计划的运行时统计 */
  runtime?: RuntimeStats;
  /** analyze 模式：本次实际执行的耗时与服务端统计 */
  execution?: ExecutionStats;
  /** 命中多条缓存条目（多 host）时如实回报条数 */
  cacheRows?: number;
  /** 本次写入 SYS.EXPLAIN_PLAN_TABLE 的行是否已清理（false=无 DELETE 权限等，行会留库） */
  planRowsCleaned?: boolean;
  notes: string[];
}

interface PlanCacheRow {
  PLAN_ID: number | null;
  USER_NAME?: string | null;
  /** 编译该计划时的 session schema（`FROM T` 的解析基准） */
  SCHEMA_NAME?: string | null;
  STATEMENT_STRING: string | null;
  EXECUTION_COUNT?: number | null;
  TOTAL_EXECUTION_TIME?: number | null;
  AVG_EXECUTION_TIME?: number | null;
  MAX_EXECUTION_TIME?: number | null;
  TOTAL_EXECUTION_CPU_TIME?: number | null;
  TOTAL_EXECUTION_MEMORY_SIZE?: number | null;
  TOTAL_LOCK_WAIT_DURATION?: number | null;
  TOTAL_RESULT_RECORD_COUNT?: number | null;
  LAST_EXECUTION_TIMESTAMP?: string | null;
}

interface SessionInfo {
  schema: string;
  connectionId: number | null;
}

/** plan_id / analyze 模式共享的"计划来源" */
type ExplainTarget = { sql: string } | { planId: number };

/** 入口：分析一条语句（sql）或一个计划缓存条目（planId） */
export async function analyzeSql(pool: HanaPool, opts: SqlAnalyzeOptions): Promise<SqlAnalyzeResult> {
  const problem = validateAnalyzeRequest(opts);
  if (problem) throw toBusinessError(problem);

  const verbose = opts.verbose === true;
  const raw = opts.raw === true;
  const limit = clampLimit(opts.limit);
  const statementName = generateStatementName();
  const label = opts.statementName;

  return pool.withConnection(async (conn): Promise<SqlAnalyzeResult> => {
    const session = await readSessionInfo(pool, conn);
    const base = { statementName, session, verbose, raw, limit, ...(label !== undefined ? { label } : {}) };
    const cleanup = () => cleanupPlanRows(pool, conn, statementName);
    try {
      const result =
        opts.planId !== undefined
          ? await analyzeCacheEntry(pool, conn, { ...base, planId: opts.planId })
          : opts.analyze === true
            ? await analyzeByExecution(pool, conn, { ...base, sql: String(opts.sql) })
            : await analyzeText(pool, conn, { ...base, sql: String(opts.sql) });
      const cleaned = await cleanup();
      return withCleanupNote(result, statementName, cleaned);
    } catch (e) {
      // 失败路径同样可能已经写入计划行（EXPLAIN 成功、回读失败）：尽力清理，但不掩盖原始错误。
      // 清理**也**失败时必须让调用方知道——否则错误信息里既没有语句名、也没有"有行残留"这件事，
      // 补救线索直接丢失（成功路径本来就会回报这些）
      const cleaned = await cleanup();
      throw withCleanupDiagnosis(e, statementName, cleaned);
    }
  });
}

/**
 * 删掉本次写入的计划行。
 *
 * 为什么必须清：实测该表**全库可读且不随连接销毁**，每调用一次就留 N 行（N=算子数），
 * 长期运行会让计划表被历史行塞满，也会让别人看到我们分析过的语句。
 * 实测 `DELETE FROM SYS.EXPLAIN_PLAN_TABLE WHERE STATEMENT_NAME = ?` 真生效（2 行→0，33ms）。
 *
 * 清理失败不影响本次结果（只读账号可能没有 DELETE 权限）——如实回报，不吞不报。
 */
async function cleanupPlanRows(
  pool: HanaPool,
  conn: HanaConnection,
  statementName: string,
): Promise<boolean> {
  try {
    await pool.execOn(conn, `DELETE FROM ${PLAN_TABLE} WHERE STATEMENT_NAME = ?`, [statementName]);
    return true;
  } catch {
    return false;
  }
}

function withCleanupNote(
  result: SqlAnalyzeResult,
  statementName: string,
  cleaned: boolean,
): SqlAnalyzeResult {
  return {
    ...result,
    planRowsCleaned: cleaned,
    ...(cleaned ? {} : { notes: [...result.notes, cleanupHint(statementName)] }),
  };
}

/**
 * 失败路径：清理没成功时，把补救线索并入**错误诊断**（经 withErrorEnvelope 进 envelope.raw.diagnosis）。
 * 与成功路径的 note 同一份措辞，保证"失败也不丢核心信息"。
 * 非 HanaBusinessError（协议层错误等）原样抛出——那类错误不该被包装成业务错误。
 */
function withCleanupDiagnosis(e: unknown, statementName: string, cleaned: boolean): unknown {
  if (cleaned || !(e instanceof HanaBusinessError)) return e;
  const prev = (e.diagnosis ?? {}) as Record<string, unknown>;
  return new HanaBusinessError(
    e.message,
    e.code,
    e.sqlState,
    e.messages,
    { ...prev, planRowsCleaned: false, statementName, cleanupHint: cleanupHint(statementName) },
    e.rawDetail,
  );
}

/** 计划行残留时的统一提示（成功路径进 notes，失败路径进 diagnosis） */
function cleanupHint(statementName: string): string {
  return (
    `本次写入的计划行未能清理（当前用户可能没有 SYS.EXPLAIN_PLAN_TABLE 的 DELETE 权限）：` +
    `该表中 STATEMENT_NAME='${statementName}' 的行需手工清理`
  );
}

/** 模式一：按语句文本编译解释，**不执行** */
async function analyzeText(
  pool: HanaPool,
  conn: HanaConnection,
  args: BaseArgs & { sql: string },
): Promise<SqlAnalyzeResult> {
  await assertReadScopes(args.sql, args.session.schema, '语句');
  await runExplain(pool, conn, args.statementName, { sql: args.sql });
  return finish(pool, conn, args, {
    source: 'sql',
    statement: args.sql,
    notes: ['计划为**编译期估计**，不含实际执行信息；要看实际统计请用 planId 或 analyze=true'],
  });
}

/**
 * 模式二：解释计划缓存里的已有条目（**不执行**）。
 *
 * 入口先取条目再解释，同时堵三个洞（不取的话一个都堵不住）：
 * - 计划缓存里也有 INSERT/DELETE/CALL 条目，`FOR SQL PLAN CACHE ENTRY` 照样能解释 → 按同一分类器拒；
 * - plan_id 模式下 planner 拿不到语句文本，读边界会整体失效 → 取到文本后跑同一套 schema 扫描；
 * - 有 OPTIMIZER ADMIN 时能解释**别人**的条目，输出会回显对方语句与对象名 → 上面两道就是闸门。
 */
async function analyzeCacheEntry(
  pool: HanaPool,
  conn: HanaConnection,
  args: BaseArgs & { planId: number },
): Promise<SqlAnalyzeResult> {
  const rows = await pool.execOn<PlanCacheRow[]>(
    conn,
    `SELECT ${CACHE_COLUMNS} FROM ${PLAN_CACHE} WHERE PLAN_ID = ? ORDER BY EXECUTION_COUNT DESC`,
    [args.planId],
  );
  if (rows.length === 0) {
    throw new HanaBusinessError(
      `计划缓存中没有 PLAN_ID=${args.planId} 的条目，或当前用户看不到它`,
      undefined,
      undefined,
      [],
      {
        planId: args.planId,
        hint: 'planId 取自 SYS.M_SQL_PLAN_CACHE.PLAN_ID；条目可能已被逐出计划缓存，请重新获取编号',
      },
    );
  }
  const entry = rows[0];
  const statement = entry.STATEMENT_STRING ?? '';
  // 未限定表名按**条目自己的** schema 判，而不是调用方的 CURRENT_SCHEMA：
  // 计划缓存的条目是全局的（PLAN_ID 定位、与"谁来解释"无关），条目里就存着编译时的
  // session schema（M_SQL_PLAN_CACHE.SCHEMA_NAME）——那才是 `FROM T` 当初的解析基准。
  // 用调用方的 schema 去判别人的语句，两个方向都会错：误拒（作者 schema 合规、我们不合规）
  // 与误放（反过来）。取不到该列时不误拦（与 read-scope.service 的既有约定一致），但如实说明。
  const entrySchema = (entry.SCHEMA_NAME ?? '').trim();
  const notes: string[] = [];
  if (entrySchema === '') {
    notes.push(
      '条目未记录编译时的 schema（M_SQL_PLAN_CACHE.SCHEMA_NAME 为空）：本次不对未限定表名做读取范围判定；' +
        '限定名引用仍按白名单校验',
    );
  }
  await assertEntryAnalyzable(statement, entrySchema, args.planId);

  await runExplain(pool, conn, args.statementName, { planId: args.planId });
  if (rows.length > 1) {
    notes.push(`PLAN_ID 命中 ${rows.length} 条记录（多 host 部署常见），按执行次数最多的一条解释`);
  }
  return finish(pool, conn, args, {
    source: 'planCacheEntry',
    statement,
    runtime: toRuntime(entry),
    cacheRows: rows.length,
    notes,
  });
}

/**
 * 模式三：**先实际执行再分析**（可选，默认关闭）。
 *
 * 为什么必须"执行"才能拿到运行时统计：EXPLAIN 只给估计值，实际数据只在计划缓存/PlanViz 里
 * （SAP 文档原话：Actual execution information is only available in the Plan Visualizer）。
 * 执行后再按**完全相同的语句文本**关联缓存条目，得到的还是**重编译（参数感知）**计划——
 * 这正是文档推荐的做法。
 *
 * 护栏（服务层常量，不做成参数）：语句超时 30s、最多取 100 行即关闭结果集、只允许 SELECT、
 * 执行前先过读取范围。**不返回数据行**。
 */
async function analyzeByExecution(
  pool: HanaPool,
  conn: HanaConnection,
  args: BaseArgs & { sql: string },
): Promise<SqlAnalyzeResult> {
  await assertReadScopes(args.sql, args.session.schema, '语句');
  const execution = await executeGuarded(conn, args.sql);

  // 按"完全相同的文本"关联计划缓存条目：文本一致才能拿到同一个（重编译）计划。
  // 用 LIKE + ESCAPE 而非等值（STATEMENT_STRING 是 LOB，等值比较会报 NLocator 错误，实测）。
  // 查询本身失败也不该让整次调用失败——语句**已经执行成功**了，与"找不到条目"是同一种降级。
  let entry: PlanCacheRow | undefined;
  const notes: string[] = [];
  try {
    const rows = await pool.execOn<PlanCacheRow[]>(
      conn,
      `SELECT ${CACHE_COLUMNS} FROM ${PLAN_CACHE} WHERE USER_NAME = CURRENT_USER AND STATEMENT_STRING LIKE ? ${LIKE_ESCAPE_SQL} ORDER BY EXECUTION_COUNT DESC`,
      [escapeLikePattern(args.sql)],
    );
    entry = rows[0];
  } catch (e) {
    notes.push(
      `读取计划缓存失败（${(e as Error).message}）：常见原因是当前用户没有 SYS.M_SQL_PLAN_CACHE 的读取权限；` +
        '本次退回编译期计划，运行时统计不可用',
    );
  }

  let runtime: RuntimeStats | undefined;
  if (entry && typeof entry.PLAN_ID === 'number') {
    try {
      await runExplain(pool, conn, args.statementName, { planId: entry.PLAN_ID });
      runtime = toRuntime(entry);
      notes.unshift('计划来自实际执行后的计划缓存条目（参数感知的重编译计划）');
    } catch (e) {
      // 解释缓存条目要 OPTIMIZER ADMIN：语句已经执行成功，不该因这一步整体失败 → 退回解释文本。
      // ⚠️ 必须换一个**新的语句名**：同名是追加而非替换，复用名字会把两条计划的算子混在一起
      // （根算子变 2 个、扫描数翻倍，结论静默出错）——正是唯一命名要防的事。
      notes.push(`按计划缓存条目解释失败（${(e as Error).message}），已退回编译期计划；运行时统计不可用`);
      await runExplain(pool, conn, generateStatementName(), { sql: args.sql });
      notes.push('退回路径使用独立的计划标识，不与失败那次混行');
    }
  } else if (!entry) {
    notes.push(
      '执行后未按语句文本在计划缓存中找到条目（文本可能被规范化或条目已被逐出），退回编译期计划；运行时统计不可用',
    );
    await runExplain(pool, conn, args.statementName, { sql: args.sql });
  }

  return finish(pool, conn, args, {
    source: 'sqlExecuted',
    statement: args.sql,
    execution,
    ...(runtime ? { runtime } : {}),
    notes,
  });
}

interface BaseArgs {
  statementName: string;
  session: SessionInfo;
  raw: boolean;
  verbose: boolean;
  limit: number;
  label?: string;
}

/** 回读计划 + 组装输出（三种模式共用收尾） */
async function finish(
  pool: HanaPool,
  conn: HanaConnection,
  args: BaseArgs,
  extra: {
    source: SqlAnalyzeResult['source'];
    statement: string;
    runtime?: RuntimeStats;
    execution?: ExecutionStats;
    cacheRows?: number;
    notes: string[];
  },
): Promise<SqlAnalyzeResult> {
  const { rows, totalRows, connectionFiltered } = await readPlanBack(
    pool,
    conn,
    args.statementName,
    args.session.connectionId,
    args.raw && args.verbose,
    args.limit,
  );
  if (totalRows > rows.length) {
    extra.notes.push(
      `计划过大：共 ${totalRows} 个算子，只回读并分析了前 ${rows.length} 个（结论基于这部分，可能不完整）`,
    );
  }
  const render = renderPlan(rows, args.limit);
  // 默认只给结论：原始算子表/文本树对模型是噪声，退到 raw=true
  const conclusion = analyzePlan(rows, {
    statement: extra.statement,
    ...(extra.runtime ? { runtime: extra.runtime } : {}),
  });
  return {
    source: extra.source,
    statementName: args.statementName,
    ...(args.label !== undefined ? { label: args.label } : {}),
    statement: extra.statement,
    connectionId: args.session.connectionId,
    connectionFiltered,
    conclusion,
    ...(args.raw ? { operators: render.operators, planText: render.planText } : {}),
    operatorCount: render.operatorCount,
    truncated: args.raw ? render.truncated : false,
    rootCount: render.rootCount,
    orphanCount: render.orphanCount,
    ...(extra.runtime ? { runtime: extra.runtime } : {}),
    ...(extra.execution ? { execution: extra.execution } : {}),
    ...(extra.cacheRows !== undefined ? { cacheRows: extra.cacheRows } : {}),
    notes: extra.notes,
  };
}

async function readSessionInfo(pool: HanaPool, conn: HanaConnection): Promise<SessionInfo> {
  const rows = await pool.execOn<{ CURRENT_SCHEMA: string; CURRENT_CONNECTION: number }[]>(
    conn,
    'SELECT CURRENT_SCHEMA, CURRENT_CONNECTION FROM DUMMY',
  );
  const row = rows[0];
  return {
    schema: row?.CURRENT_SCHEMA ?? '',
    connectionId: typeof row?.CURRENT_CONNECTION === 'number' ? row.CURRENT_CONNECTION : null,
  };
}

/** 读取范围（服务层纵深防御：内部调用不经过工具层预检） */
async function assertReadScopes(
  sql: string,
  defaultSchema: string,
  noun: string,
  schemaLabel = '当前用户默认 schema',
): Promise<void> {
  for (const schema of scanSqlSchemaRefs(sql)) {
    try {
      assertSchemaAllowed(schema);
    } catch {
      throw new HanaBusinessError(
        `${noun}引用的 schema "${schema}" 不在服务端允许读取的范围内，已拒绝分析`,
        undefined,
        undefined,
        [],
        { statementHead: statementHead(sql) },
      );
    }
  }
  // 未限定表名按默认 schema 判定（与 SQL 模式视图共用同一份规则）
  await assertSqlReadScopes(sql, async () => defaultSchema, noun, schemaLabel);
}

/** plan_id 模式：条目文本同样要过分类器与读取范围（否则解释就等于绕过全部边界） */
async function assertEntryAnalyzable(
  statement: string,
  defaultSchema: string,
  planId: number,
): Promise<void> {
  // 计划缓存里绝大多数条目本就是参数化语句（`… WHERE A = ?`），而解释缓存条目**不需要参数值**，
  // 所以这里必须放行占位符——否则 plan_id 模式对最典型的那类条目完全不可用
  const info = parseSqlStatement(statement, { allowPlaceholders: true });
  if (info.problems.length > 0) {
    throw new HanaBusinessError(
      `计划缓存条目（PLAN_ID=${planId}）不是可分析的查询语句：${info.problems[0].message}`,
      undefined,
      undefined,
      [],
      {
        planId,
        statementHead: statementHead(statement),
        hint: `${info.problems[0].hint}；本工具只分析 SELECT/WITH 查询，要分析别的语句请自行在数据库端进行`,
      },
    );
  }
  await assertReadScopes(
    statement,
    defaultSchema,
    `计划缓存条目（PLAN_ID=${planId}）里的语句`,
    '该条目编译时的 schema',
  );
}

/** 语句开头摘要（进错误信息，让调用方不必再查一次就知道是哪条） */
function statementHead(statement: string, max = 120): string {
  const oneLine = statement.replace(/\s+/g, ' ').trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

async function runExplain(
  pool: HanaPool,
  conn: HanaConnection,
  statementName: string,
  target: ExplainTarget,
): Promise<void> {
  try {
    await pool.execOn(conn, buildExplainStatement(statementName, target));
  } catch (e) {
    throw await explainFailure(pool, conn, e, target);
  }
}

/**
 * EXPLAIN 失败时**一次给全**：plan_id 模式最常见的阻塞点是缺 OPTIMIZER ADMIN，
 * 在同一条连接上查一次权限，让调用方不必"失败 → 再查权限"多跑一轮。
 */
async function explainFailure(
  pool: HanaPool,
  conn: HanaConnection,
  e: unknown,
  target: ExplainTarget,
): Promise<HanaBusinessError> {
  const err = normalizeHanaError(e);
  if (!('planId' in target)) return err;
  try {
    const rows = await pool.execOn<{ PRIVILEGE: string }[]>(
      conn,
      "SELECT PRIVILEGE FROM SYS.EFFECTIVE_PRIVILEGES WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'OPTIMIZER ADMIN'",
    );
    const granted = rows.length > 0;
    return new HanaBusinessError(err.message, err.code, err.sqlState, err.messages, {
      requires: 'OPTIMIZER ADMIN',
      granted,
      hint: granted
        ? '权限具备，失败可能来自条目本身（已被逐出计划缓存？请重新取 PLAN_ID）'
        : '解释计划缓存条目需要 OPTIMIZER ADMIN 系统权限；改用 sql 参数只解释语句文本则不需要该权限',
    });
  } catch {
    return err;
  }
}

/** 回读计划行（按连接过滤 → 命中 0 行时去掉该过滤重试一次，如实回报） */
async function readPlanBack(
  pool: HanaPool,
  conn: HanaConnection,
  statementName: string,
  connectionId: number | null,
  withDetails: boolean,
  limit: number,
): Promise<{ rows: PlanRow[]; totalRows: number; connectionFiltered: boolean }> {
  const columns = withDetails ? [...READ_COLUMNS, ...VERBOSE_COLUMNS] : READ_COLUMNS;
  const base = `SELECT ${columns.join(', ')} FROM ${PLAN_TABLE} WHERE STATEMENT_NAME = ?`;

  let connectionFiltered = connectionId !== null;
  let rows =
    connectionId === null
      ? await pool.execOn<PlanRow[]>(conn, `${base} ORDER BY OPERATOR_ID`, [statementName])
      : await pool.execOn<PlanRow[]>(conn, `${base} AND CONNECTION_ID = ? ORDER BY OPERATOR_ID`, [
          statementName,
          connectionId,
        ]);

  if (rows.length === 0 && connectionFiltered) {
    // CONNECTION_ID 的语义在不同版本/部署下若有差异，不要让工具整体不可用：去掉该过滤再试，
    // 名字本身已经唯一，结果仍然正确——但要如实告诉调用方"这轮没按连接过滤"。
    rows = await pool.execOn<PlanRow[]>(conn, `${base} ORDER BY OPERATOR_ID`, [statementName]);
    connectionFiltered = false;
  }
  if (rows.length === 0) {
    throw new HanaBusinessError(
      `EXPLAIN PLAN 已执行，但按 STATEMENT_NAME=${statementName} 回读不到任何算子行`,
      undefined,
      undefined,
      [],
      {
        statementName,
        connectionId,
        hint: 'EXPLAIN 已执行却按该语句名读不到行：通常意味着写入被拒，或该行刚被并发清理。请重试；持续失败请反馈',
      },
    );
  }
  // 硬上限在这里**一次性**截断：结论、渲染、计数必须来自同一份行，
  // 否则会出现"统计说 6000 个算子、算子表里只有 5000"这种自相矛盾的响应
  return { rows: rows.slice(0, HARD_OPERATOR_CAP), totalRows: rows.length, connectionFiltered };
}

/**
 * 带护栏的实际执行：语句超时 + 最多取 ANALYZE_MAX_ROWS 行后立即关闭结果集。
 *
 * 用 ResultSet 流式取行而不是 `conn.exec`：后者会把全部结果一次拉回内存，
 * 一条没有 LIMIT 的 SELECT 足以把服务打爆。**不改变语句文本**（不能套 LIMIT——
 * 套了就不是同一条语句，计划缓存关联随之失效）。
 */
async function executeGuarded(conn: HanaConnection, sql: string): Promise<ExecutionStats> {
  const startedAt = Date.now();
  let stmt: HanaStatement | undefined;
  let rs: HanaResultSet | undefined;
  try {
    // prepare 就会解析对象与权限：语法错误 / 表不存在 / 无权限都在这里**同步**抛出。
    // 不放在 try 里会被当成"未知错误"包装掉（调用方只看到"内部错误，详情见服务端日志"），
    // 与本工具"失败一次给全"的约定相反。
    stmt = conn.prepare(sql);
    stmt.setTimeout(ANALYZE_TIMEOUT_MS);
    rs = await new Promise<HanaResultSet>((resolve, reject) => {
      // 参数显式标注：execQuery 有一个 `options: {[key: string]: any}` 重载，函数实参同时也匹配它，
      // 不标注就推断不出回调参数类型
      const onResult = (err: Error | null, resultSet?: HanaResultSet): void => {
        if (err) reject(normalizeHanaError(err));
        else if (!resultSet) reject(new HanaBusinessError('执行语句未返回结果集'));
        else resolve(resultSet);
      };
      stmt!.execQuery(onResult);
    });
    let rowsFetched = 0;
    const resultSet = rs;
    while (rowsFetched < ANALYZE_MAX_ROWS) {
      const hasNext = await new Promise<boolean>((resolve, reject) => {
        resultSet.next((err: Error | null, more?: boolean) =>
          err ? reject(normalizeHanaError(err)) : resolve(more === true),
        );
      });
      if (!hasNext) break;
      rowsFetched++; // 行数据丢弃：本工具只回报统计，不回报数据
    }
    const stat = (read: () => number): number | undefined => {
      try {
        const v = read();
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      } catch {
        return undefined;
      }
    };
    return {
      wallClockMs: Date.now() - startedAt,
      rowsFetched,
      maxRows: ANALYZE_MAX_ROWS,
      timeoutMs: ANALYZE_TIMEOUT_MS,
      ...withDefined('serverProcessingTime', stat(() => rs!.getServerProcessingTime())),
      ...withDefined('serverCpuTime', stat(() => rs!.getServerCPUTime())),
      ...withDefined('serverMemoryUsage', stat(() => rs!.getServerMemoryUsage())),
    };
  } catch (e) {
    // prepare / next 的同步或异步错误统一归一化（已经归一化的原样返回）
    throw normalizeHanaError(e);
  } finally {
    try {
      rs?.close();
    } catch {
      /* 结果集关闭失败不掩盖原始错误 */
    }
    try {
      stmt?.drop();
    } catch {
      /* 同上 */
    }
  }
}

/** 只在有值时展开字段（避免响应里出现一堆 null） */
function withDefined<K extends string>(key: K, value: number | undefined): Partial<Record<K, number>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, number>);
}

function toRuntime(row: PlanCacheRow): RuntimeStats {
  const out: RuntimeStats = {};
  const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
  const put = <K extends keyof RuntimeStats>(key: K, value: RuntimeStats[K] | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  put('planId', num(row.PLAN_ID));
  if (row.USER_NAME) out.userName = row.USER_NAME;
  put('executionCount', num(row.EXECUTION_COUNT));
  put('totalExecutionTime', num(row.TOTAL_EXECUTION_TIME));
  put('avgExecutionTime', num(row.AVG_EXECUTION_TIME));
  put('maxExecutionTime', num(row.MAX_EXECUTION_TIME));
  put('totalCpuTime', num(row.TOTAL_EXECUTION_CPU_TIME));
  put('totalMemorySize', num(row.TOTAL_EXECUTION_MEMORY_SIZE));
  put('totalLockWaitDuration', num(row.TOTAL_LOCK_WAIT_DURATION));
  put('totalResultRecordCount', num(row.TOTAL_RESULT_RECORD_COUNT));
  if (row.LAST_EXECUTION_TIMESTAMP) out.lastExecutionTimestamp = row.LAST_EXECUTION_TIMESTAMP;
  return out;
}

function clampLimit(limit: number | undefined): number {
  if (typeof limit !== 'number' || !Number.isFinite(limit) || limit <= 0) return DEFAULT_OPERATOR_LIMIT;
  return Math.min(Math.floor(limit), MAX_OPERATOR_LIMIT);
}

function toBusinessError(problem: RequestProblem): HanaBusinessError {
  return new HanaBusinessError(`${problem.message}。${problem.hint}`);
}
