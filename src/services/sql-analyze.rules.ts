/**
 * SQL 分析（hana_sql_analyze）的规则层：**零 I/O、无 HANA 依赖**，可单独测试。
 *
 * 这里放三类"必须在碰 HANA 之前定下来"的判定：
 * 1. 语句能不能进 EXPLAIN、能不能真的执行（类型 / 多语句 / 绑定占位符）
 * 2. 产物标识的生成与校验（唯一 STATEMENT_NAME、plan_id、输出标签）—— **本工具唯一的注入面**
 * 3. 计划行 → 可读产物（紧凑算子行 + 缩进文本树 + 截断）
 *
 * 语句剥离复用 write-plan.ts 的 stripSqlLiteralsAndComments（**不要写第二份**：分类与分号校验
 * 必须跑在剥离后的文本上，否则 `SELECT 'a;b' FROM T` 会被误判成多语句）。
 */

import { randomBytes } from 'node:crypto';
import { quoteLiteral } from '../core/sql.js';
import { stripSqlLiteralsAndComments } from '../write-plan.js';

/** 允许**解释**的语句首 token（HANA 的 EXPLAIN PLAN 支持 DML，我们只放行查询类） */
const EXPLAINABLE_TOKENS = new Set(['SELECT', 'WITH']);

/**
 * 允许**实际执行**的语句首 token。
 * analyze 模式额外收紧：HANA 允许 `WITH x AS (…) DELETE FROM t`，首 token 检查挡不住 DML，
 * 所以执行路径只认 SELECT（WITH 仅允许在"只编译不执行"的解释路径使用）。
 */
const EXECUTABLE_TOKEN = 'SELECT';

/** 算子行数上限（返回给调用方的算子条数） */
export const DEFAULT_OPERATOR_LIMIT = 200;
export const MAX_OPERATOR_LIMIT = 1000;

/** 回读硬上限：无论 limit 多大都不超过（防超大计划撑爆响应） */
export const HARD_OPERATOR_CAP = 5000;

/**
 * analyze 模式护栏（服务层常量，不暴露为工具参数）：
 * 实际执行任意 SELECT 必须有硬边界，参数化只会把"跑飞"变成"可配置地跑飞"。
 */
export const ANALYZE_MAX_ROWS = 100;
export const ANALYZE_TIMEOUT_MS = 30_000;

/** statement_name 列上限 256，生成名留足余量 */
export const MAX_LABEL_LENGTH = 64;

/** 可恢复的校验问题（handler 据此返回 mcpErrorText，服务层据此抛 HanaBusinessError） */
export interface RequestProblem {
  message: string;
  hint: string;
}

export interface SqlStatementInfo {
  /** 原样语句：送去 EXPLAIN / 执行的就是它（**不做任何改写**，改写会改变计划） */
  sql: string;
  /** 剥离字面量/注释后的首个有效 token（大写；空语句为 ''） */
  firstToken: string;
  kind: 'select' | 'with' | 'other';
  /** 校验问题（空数组 = 可解释）；按"最具体"排序，handler 取第一条 */
  problems: RequestProblem[];
}

/** HANA 具名参数 `:name`；`::` 不是参数（排除第二个冒号） */
const NAMED_PARAM_RE = /(?<!:):[A-Za-z_][A-Za-z0-9_]*/;

/**
 * 解析并校验一条待分析语句。
 * 分号规则：**允许**结尾单独一个分号（剥离后只剩空白），**其余一律拒绝**（多语句）。
 * 注意此处不裁剪原文——`EXPLAIN PLAN … FOR <原样语句>` 里的尾分号只是终止符，无害；
 * 裁剪反而要处理"注释里也有分号"的位置映射问题。
 *
 * `allowPlaceholders`：计划缓存里的语句**本来就是参数化的**（`… WHERE A = ?`），
 * 而 `EXPLAIN PLAN … FOR SQL PLAN CACHE ENTRY` 不需要参数值就能出计划——
 * 所以 plan_id 模式必须放行占位符，否则计划缓存里最常见的那类条目一条都用不了。
 */
export function parseSqlStatement(raw: string, opts: { allowPlaceholders?: boolean } = {}): SqlStatementInfo {
  const sql = String(raw ?? '').trim();
  const stripped = stripSqlLiteralsAndComments(sql);
  // 剥离后的文本若去掉尾部一个分号后仍有分号 → 多语句
  const body = stripped.replace(/;\s*$/, '');
  const firstToken = (/[A-Za-z_][A-Za-z0-9_]*/.exec(body)?.[0] ?? '').toUpperCase();
  const kind = firstToken === 'SELECT' ? 'select' : firstToken === 'WITH' ? 'with' : 'other';

  const problems: RequestProblem[] = [];
  if (sql === '') {
    problems.push({ message: 'sql 为空', hint: '请提供一条 SELECT/WITH 查询语句' });
  } else if (body.includes(';')) {
    problems.push({
      message: '语句含多个分号分隔的语句（只允许结尾一个分号）',
      hint: '本工具一次只分析一条语句；请去掉多余的分号与后续语句',
    });
  } else if (!opts.allowPlaceholders && (NAMED_PARAM_RE.test(body) || body.includes('?'))) {
    problems.push({
      message: '语句含绑定占位符（? 或 :name）',
      hint: 'EXPLAIN/执行都需要具体参数值才能定计划；请把参数替换为字面量后再分析',
    });
  } else if (!EXPLAINABLE_TOKENS.has(firstToken)) {
    problems.push({
      message: `不支持分析该语句类型（首 token：${firstToken || '(无法识别)'}）`,
      hint: '只支持 SELECT 与 WITH 查询；DML/DDL/过程调用不在本工具范围内',
    });
  }
  return { sql, firstToken, kind, problems };
}

/** 一次调用的入参（与工具 schema 同形，便于 handler 与服务层共用同一份校验） */
export interface AnalyzeRequestLike {
  sql?: string;
  planId?: number;
  analyze?: boolean;
  statementName?: string;
}

/**
 * 入参组合校验（**单一事实源**）：handler 用它产出 mcpErrorText，服务层用它抛业务错误。
 * zod 表达不了"sql 与 planId 恰有其一"，所以放在这里。
 */
export function validateAnalyzeRequest(opts: AnalyzeRequestLike): RequestProblem | undefined {
  const hasSql = typeof opts.sql === 'string' && opts.sql.trim() !== '';
  const hasPlanId = opts.planId !== undefined && opts.planId !== null;

  if (hasSql && hasPlanId) {
    return {
      message: 'sql 与 planId 只能二选一',
      hint: '分析自己提供的语句用 sql；分析计划缓存里已执行过的语句用 planId',
    };
  }
  if (!hasSql && !hasPlanId) {
    return {
      message: '必须提供 sql 或 planId 之一',
      hint: 'sql=要分析的语句（只编译不执行，analyze=true 时才真跑）；planId=计划缓存条目编号',
    };
  }
  // 标签校验与模式无关：plan_id 模式同样只回显，别让两条路径的规则漂移
  if (opts.statementName !== undefined) {
    const labelProblem = validateLabel(opts.statementName);
    if (labelProblem) return labelProblem;
  }
  if (hasPlanId) {
    const problem = validatePlanId(opts.planId);
    if (problem) return problem;
    if (opts.analyze) {
      return {
        message: 'analyze 不能与 planId 一起使用',
        hint: 'analyze 是"先执行再分析"；planId 指向的计划缓存条目本来就已经执行过，直接用即可',
      };
    }
    return undefined;
  }
  const info = parseSqlStatement(String(opts.sql));
  if (info.problems.length > 0) return info.problems[0];
  if (opts.analyze && info.firstToken !== EXECUTABLE_TOKEN) {
    return {
      message: 'analyze=true 只接受 SELECT 语句（当前语句以 WITH 开头）',
      hint: 'WITH 可搭配 DELETE/UPDATE，执行路径无法从首个关键字判定类型；去掉 analyze 可只解释不执行',
    };
  }
  // 加锁读（FOR UPDATE / FOR SHARE）：EXPLAIN 只编译无妨，但 analyze=true 会**真的加行锁**，
  // 而结果集取满 100 行就关闭——锁的持有时间取决于驱动/事务处理，可能挡住别人的 DML。
  if (opts.analyze && LOCKING_READ_RE.test(stripSqlLiteralsAndComments(info.sql))) {
    return {
      message: 'analyze=true 不接受加锁读（FOR UPDATE / FOR SHARE）',
      hint: '执行会对数据行加锁、可能阻塞其他会话；去掉加锁子句，或改用 analyze=false 只编译不执行',
    };
  }
  return undefined;
}

/** 加锁读子句（在**剥离字面量后**的文本上判，避免把注释/字符串里的同名文本当子句） */
const LOCKING_READ_RE = /\bFOR\s+(?:UPDATE|SHARE)\b/i;

/** plan_id 校验：必须为正安全整数（防字符串透传成注入面） */
export function validatePlanId(v: unknown): RequestProblem | undefined {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v <= 0) {
    return {
      message: `planId 非法（${JSON.stringify(v)}）`,
      hint: 'planId 是 M_SQL_PLAN_CACHE.PLAN_ID 的正整数编号；请从 SAP HANA Studio / SQL Analyzer 等工具取得',
    };
  }
  return undefined;
}

/** 输出标签校验：只回显、不进 SQL，因此只需限长与去控制字符 */
export function validateLabel(v: unknown): RequestProblem | undefined {
  if (typeof v !== 'string') {
    return { message: 'statementName 必须是字符串', hint: '它只作为输出标签使用' };
  }
  if (v.length > MAX_LABEL_LENGTH) {
    return {
      message: `statementName 过长（${v.length} > ${MAX_LABEL_LENGTH}）`,
      hint: '它只作为输出标签，缩短即可',
    };
  }
  if ([...v].some((ch) => { const c = ch.charCodeAt(0); return c < 0x20 || c === 0x7f; })) {
    return { message: 'statementName 含控制字符', hint: '请使用可打印字符' };
  }
  return undefined;
}

/**
 * 生成本次调用的唯一 STATEMENT_NAME。
 *
 * 为什么必须唯一：真机实测**同名是追加而非替换**（同名解释两次 → 回读 4 行），
 * 复用名字会把上一次的计划混进结果——返回的是**错结果**，不是慢结果。
 */
export function generateStatementName(): string {
  return `MCP_${Date.now().toString(36).toUpperCase()}_${randomBytes(4).toString('hex').toUpperCase()}`;
}

/**
 * 拼 EXPLAIN PLAN 语句。
 *
 * ⚠️ 本工具**唯一**的注入面：EXPLAIN 是工具语句，statement_name 与 plan_id 都**不能参数绑定**，
 * 只能内联。因此 statementName 由服务端生成（纯字母数字下划线）+ quoteLiteral 二次转义；
 * planId 必须已验证为安全整数。
 */
export function buildExplainStatement(
  statementName: string,
  target: { sql: string } | { planId: number },
): string {
  const label = quoteLiteral(statementName);
  const entry = 'sql' in target ? target.sql : `SQL PLAN CACHE ENTRY ${target.planId}`;
  return `EXPLAIN PLAN SET STATEMENT_NAME = ${label} FOR ${entry}`;
}

/** 回读计划表的原始行（列名与 SYS.EXPLAIN_PLAN_TABLE 一致，仅取所需列） */
export interface PlanRow {
  OPERATOR_ID: number | null;
  PARENT_OPERATOR_ID: number | null;
  LEVEL: number | null;
  POSITION: number | null;
  OPERATOR_NAME: string | null;
  EXECUTION_ENGINE: string | null;
  SCHEMA_NAME: string | null;
  TABLE_NAME: string | null;
  TABLE_TYPE: string | null;
  TABLE_SIZE: number | null;
  OUTPUT_SIZE: number | null;
  SUBTREE_COST: number | null;
  OPERATOR_DETAILS?: string | null;
  OPERATOR_PROPERTIES?: string | null;
}

/** 输出用算子（紧凑：可选字段缺省即不出现，避免响应里全是 null） */
export interface PlanOperator {
  operatorId: number | null;
  parentId: number | null;
  level: number;
  position: number | null;
  operator: string;
  engine?: string;
  schema?: string;
  table?: string;
  tableType?: string;
  tableSize?: number;
  outputSize?: number;
  cost?: number;
  details?: string;
  properties?: string;
}

export interface PlanRender {
  operators: PlanOperator[];
  /** 缩进文本树（模型/人可读性最好的一栏） */
  planText: string;
  /** 截断前的算子总数 */
  operatorCount: number;
  /** 是否因 limit 截断 */
  truncated: boolean;
  /** 根算子数（正常为 1；0 或 >1 说明计划不完整，如实回报而不是掩盖） */
  rootCount: number;
  /** 父算子不在结果集内的行数（异常计划信号；不因此报错，如实回报） */
  orphanCount: number;
}

/** 根判据兜底：NULL（实测根为 NULL）/ 0 / 自引用都算根 */
function isRoot(row: PlanRow): boolean {
  const parent = row.PARENT_OPERATOR_ID;
  return parent == null || parent === 0 || parent === row.OPERATOR_ID;
}

/** 计划行 → 可读产物（硬上限截断在前，limit 截断在后） */
export function renderPlan(rows: PlanRow[], limit: number): PlanRender {
  const all = rows.slice(0, HARD_OPERATOR_CAP);
  const ids = new Set(all.map((r) => r.OPERATOR_ID));
  const rootCount = all.filter(isRoot).length;
  const orphanCount = all.filter((r) => !isRoot(r) && !ids.has(r.PARENT_OPERATOR_ID)).length;

  const shown = all.slice(0, limit);
  const operators = shown.map(toOperator);
  return {
    operators,
    planText: operators.map(renderLine).join('\n'),
    operatorCount: all.length,
    truncated: shown.length < all.length,
    rootCount,
    orphanCount,
  };
}

function toOperator(row: PlanRow): PlanOperator {
  // HANA 的算子名自带缩进空格（如 "  DUMMY TABLE SCAN"），我们按 LEVEL 自行缩进，故先 trim
  const op: PlanOperator = {
    operatorId: row.OPERATOR_ID ?? null,
    parentId: row.PARENT_OPERATOR_ID ?? null,
    level: row.LEVEL ?? 1,
    position: row.POSITION ?? null,
    operator: (row.OPERATOR_NAME ?? '').trim(),
  };
  if (row.EXECUTION_ENGINE) op.engine = row.EXECUTION_ENGINE;
  if (row.SCHEMA_NAME) op.schema = row.SCHEMA_NAME;
  if (row.TABLE_NAME) op.table = row.TABLE_NAME;
  if (row.TABLE_TYPE) op.tableType = row.TABLE_TYPE;
  if (row.TABLE_SIZE != null) op.tableSize = row.TABLE_SIZE;
  if (row.OUTPUT_SIZE != null) op.outputSize = row.OUTPUT_SIZE;
  if (row.SUBTREE_COST != null) op.cost = row.SUBTREE_COST;
  if (row.OPERATOR_DETAILS) op.details = row.OPERATOR_DETAILS;
  if (row.OPERATOR_PROPERTIES) op.properties = row.OPERATOR_PROPERTIES;
  return op;
}

function renderLine(op: PlanOperator): string {
  const indent = '  '.repeat(Math.max(0, op.level - 1));
  const parts = [op.operator];
  if (op.table) {
    const qualified = op.schema ? `${op.schema}.${op.table}` : op.table;
    parts.push(`→ ${qualified}${op.tableType ? `（${op.tableType}）` : ''}`);
  }
  // HEX 是 SQL 引擎的常态（每行都打是噪声）；其余引擎（COLUMN/ROW/OLAP/ESX）恰恰是要看的"引擎切换"
  if (op.engine && op.engine !== 'HEX') parts.push(`[${op.engine}]`);
  if (op.cost && op.cost > 0) parts.push(`cost=${op.cost}`);
  if (op.details) parts.push(`(${op.details})`);
  return `${indent}${parts.join(' ')}`;
}

// ── 分析结论（**默认输出**：把算子计划翻译成人能读懂的结论）────────
//
// 为什么要这一层：原始算子表对模型和人都是噪声（200 行算子、缩写名、估计值）。
// 验收标准要的是"一段可理解的 SQL 分析结论"，所以默认只给结论，原始计划退到 raw=true。
//
// 每条结论都必须**可回溯**：evidence 指到具体算子/表，不做无依据的断言；
// 拿不准的（如表规模是估计值、文本启发式）如实标注，不假装确定。

/** 发现级别：risk=可能有问题，warn=需关注，info=说明性 */
export type FindingLevel = 'risk' | 'warn' | 'info';

export interface Finding {
  level: FindingLevel;
  /** 现象（一句话） */
  title: string;
  /** 依据：来自计划里的哪一行/哪张表（可回溯，不做无依据断言） */
  evidence: string;
  /** 建议的下一步（信息类可为空） */
  advice?: string;
}

export interface PlanTableRef {
  schema?: string;
  name: string;
  type?: string;
  /** 表规模估计（EXPLAIN 的估计值，列视图场景可能不准，见统计里的 caveat） */
  size?: number;
  /** 访问方式（触发它的算子名） */
  access?: string;
}

export interface PlanStatistics {
  operatorCount: number;
  /** 计划用到的执行引擎（去重、保持出现顺序） */
  engines: string[];
  /** 是否跨多个引擎（引擎切换有额外开销） */
  engineSwitch: boolean;
  tables: PlanTableRef[];
  scans: number;
  joins: number;
  aggregations: number;
  /** 最大输入表（按 TABLE_SIZE 估计） */
  largestTable?: { name: string; size: number };
  /** 根算子的估计输出行数 */
  estimatedRows?: number;
  rootOperator?: string;
}

export interface PlanConclusion {
  /** 一句话结论 */
  summary: string;
  /** 逐条发现（risk → warn → info，同级保持计划顺序） */
  findings: Finding[];
  statistics: PlanStatistics;
  /** 整段可读文本（「一段可理解的 SQL 分析结论」的落点） */
  text: string;
}

/** 大表阈值（行）：达到即提示"全表扫描代价" */
const LARGE_TABLE_ROWS = 1_000_000;
const MEDIUM_TABLE_ROWS = 100_000;

/**
 * 列视图场景下 EXPLAIN 可能给出的**占位规模**（SAP 文档：最底层信息可能是与真实无关的固定值）。
 * 命中时如实提示"别据此判断真实数据量"，而不是把它当事实写进结论。
 */
const PLACEHOLDER_TABLE_SIZE = 10000;

/** 逐表发现的上限（按规模排序取前 N 张，避免 UNION 密集计划把结论撑爆） */
const MAX_TABLE_FINDINGS = 5;

const SCAN_RE = /(TABLE SCAN|INDEX SEARCH|COLUMN SEARCH|ROW SEARCH|FULL SCAN)/i;
const JOIN_RE = /\bJOIN\b/i;
const NESTED_LOOP_RE = /NESTED\s*LOOP/i;
const AGGREGATION_RE = /(AGGREGATION|GROUP BY)/i;

export interface PlanAnalysisContext {
  /** 被分析的语句（用于"有没有过滤条件"这类文本启发的判定，会标注为启发式） */
  statement: string;
  /** 可选：计划缓存里的运行时统计（plan_id / analyze 模式才有） */
  runtime?: {
    executionCount?: number;
    avgExecutionTime?: number;
    totalExecutionTime?: number;
    totalMemorySize?: number;
  };
}

/** 行数的人类可读格式（万/亿），避免结论里出现 12345678 这种读不出量级的数字 */
export function formatRows(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (n < 10000) return String(n);
  if (n < 100000000) return `${(n / 10000).toFixed(1)} 万`;
  return `${(n / 100000000).toFixed(2)} 亿`;
}

/** 某算子的全部后代（含自身之外的所有层级）；带 visited 防畸形计划里的环 */
function descendants(rows: PlanRow[], rootId: number | null): PlanRow[] {
  if (rootId === null) return [];
  const byParent = new Map<number | null, PlanRow[]>();
  for (const r of rows) {
    const key = r.PARENT_OPERATOR_ID ?? null;
    const list = byParent.get(key);
    if (list) list.push(r);
    else byParent.set(key, [r]);
  }
  const out: PlanRow[] = [];
  const seen = new Set<number>();
  const stack = [...(byParent.get(rootId) ?? [])];
  while (stack.length > 0) {
    const r = stack.pop() as PlanRow;
    if (r.OPERATOR_ID !== null && seen.has(r.OPERATOR_ID)) continue;
    if (r.OPERATOR_ID !== null) seen.add(r.OPERATOR_ID);
    out.push(r);
    if (r.OPERATOR_ID !== null) stack.push(...(byParent.get(r.OPERATOR_ID) ?? []));
  }
  return out;
}

const LEVEL_ORDER: Record<FindingLevel, number> = { risk: 0, warn: 1, info: 2 };

/**
 * 计划行 → 可读结论。**纯函数**：只做识别与措辞，不查任何东西。
 *
 * 识别口径都是有意的保守启发式（算子名 + 文本），拿不准就不断言；每条 finding 都带 evidence。
 */
export function analyzePlan(rows: PlanRow[], ctx: PlanAnalysisContext): PlanConclusion {
  const findings: Finding[] = [];
  const engines: string[] = [];
  // 按表**去重**：自连接/UNION 会让同一张表出现多次扫描，逐条列会把结论写成
  // "涉及 2 张表"（其实是 1 张）并输出重复发现；扫描次数另用 scans 单独统计
  const tableMap = new Map<string, PlanTableRef>();
  let scans = 0;
  let joins = 0;
  let aggregations = 0;

  for (const row of rows) {
    const name = (row.OPERATOR_NAME ?? '').trim();
    const engine = row.EXECUTION_ENGINE ?? '';
    if (engine && !engines.includes(engine)) engines.push(engine);
    if (SCAN_RE.test(name)) {
      scans++;
      if (row.TABLE_NAME) {
        const qualified = row.SCHEMA_NAME ? `${row.SCHEMA_NAME}.${row.TABLE_NAME}` : row.TABLE_NAME;
        const ref: PlanTableRef = {
          ...(row.SCHEMA_NAME ? { schema: row.SCHEMA_NAME } : {}),
          name: qualified,
          ...(row.TABLE_TYPE ? { type: row.TABLE_TYPE } : {}),
          ...(row.TABLE_SIZE != null ? { size: row.TABLE_SIZE } : {}),
          access: name,
        };
        const existing = tableMap.get(qualified);
        if (!existing || (ref.size ?? -1) > (existing.size ?? -1)) tableMap.set(qualified, ref);
      }
    }
    if (JOIN_RE.test(name)) joins++;
    if (AGGREGATION_RE.test(name)) aggregations++;
  }

  const tables = [...tableMap.values()];
  const largest = tables.filter((t) => t.size != null).sort((a, b) => (b.size ?? 0) - (a.size ?? 0))[0];

  const root = rows.find((r) => isRoot(r));

  // ── 1. 扫描与规模 ──
  if (scans === 0) {
    findings.push({
      level: 'info',
      title: '计划中没有表访问算子（常量/无源查询）',
      evidence: `共 ${rows.length} 个算子，未识别到 TABLE SCAN / SEARCH 类算子`,
    });
  } else {
    // DUMMY 是 HANA 的哑表（恒 1 行）：对它的扫描没有优化空间，报"未见过滤条件"只会是噪声
    const realTables = tables.filter((t) => !/(^|\.)DUMMY$/i.test(t.name));
    const text = stripSqlLiteralsAndComments(ctx.statement);
    const hasFilter = /\b(WHERE|ON|HAVING)\b/i.test(text);
    if (realTables.length > 0 && !hasFilter) {
      const named = tables.map((t) => t.access).filter((a): a is string => Boolean(a));
      const unnamed = Math.max(0, scans - named.length);
      findings.push({
        level: 'warn',
        title: `语句未见过滤条件，扫描算子会读取整表（扫描 ${scans} 次）`,
        evidence:
          '语句文本中没有 WHERE/ON/HAVING（文本启发式）；扫描算子：' +
          `${named.join('、') || '(未记录表名)'}` +
          (unnamed > 0 ? `，另有 ${unnamed} 个扫描算子未解析出表名` : ''),
        advice: '确认是否必须全表；能加过滤条件（时间范围/分区键/状态）就先加，再对比结论里的规模变化',
      });
    }
    // 逐表发现按规模从大到小**限量**：UNION 密集的计划扫几百张表时，
    // 逐条列会把结论撑成几十 KB 且毫无信息增量
    const ranked = [...tables].sort((a, b) => (b.size ?? -1) - (a.size ?? -1));
    for (const t of ranked.slice(0, MAX_TABLE_FINDINGS)) {
      if (t.size == null) {
        findings.push({
          level: 'info',
          title: `表 ${t.name} 的规模在计划里未知`,
          evidence: `算子「${t.access}」的 TABLE_SIZE 为空`,
          advice: '规模未知时不要据此判断代价；需要真实行数用 hana_data_preview 的基表勘察模式采样核实',
        });
      } else if (t.size >= LARGE_TABLE_ROWS) {
        findings.push({
          level: 'risk',
          title: `对约 ${formatRows(t.size)} 行的表 ${t.name} 做了扫描`,
          evidence: `算子「${t.access}」：TABLE_SIZE=${t.size}`,
          advice: '优先确认能否用过滤/分区裁剪缩小输入；必要时由 DBA 评估索引或把计算下推到更小的源',
        });
      } else if (t.size === PLACEHOLDER_TABLE_SIZE) {
        findings.push({
          level: 'info',
          title: `表 ${t.name} 的规模显示为 ${PLACEHOLDER_TABLE_SIZE}，可能是占位估计值`,
          evidence: `算子「${t.access}」：TABLE_SIZE=${t.size}（EXPLAIN 在列视图场景下可能给出与真实无关的固定值）`,
          advice: '要真实量级请用 hana_data_preview 的基表勘察模式采样，不要按该数字判断优化空间',
        });
      } else if (t.size >= MEDIUM_TABLE_ROWS) {
        findings.push({
          level: 'warn',
          title: `扫描的表 ${t.name} 规模中等偏大（约 ${formatRows(t.size)} 行）`,
          evidence: `算子「${t.access}」：TABLE_SIZE=${t.size}`,
          advice: '结合是否全表读取一起看；有过滤条件时确认过滤是否被下推',
        });
      }
    }
    if (ranked.length > MAX_TABLE_FINDINGS) {
      findings.push({
        level: 'info',
        title: `另有 ${ranked.length - MAX_TABLE_FINDINGS} 张表未逐条列出（按规模排序后只列前 ${MAX_TABLE_FINDINGS} 张）`,
        evidence: `本次共识别 ${ranked.length} 张表；其余表名可在 raw=true 的算子里看到`,
      });
    }
  }

  // ── 2. 引擎切换 ──
  if (engines.length > 1) {
    const switchable = engines.filter((e) => e !== 'HEX');
    findings.push({
      level: 'warn',
      title: `计划跨越多个执行引擎（${engines.join(' → ')}），存在引擎切换开销`,
      evidence: `算子的 EXECUTION_ENGINE 取值：${engines.join(', ')}`,
      advice: switchable.length > 0
        ? `重点看 ${switchable.join('/')} 与其它引擎的衔接处：行表/计算视图混用时切换代价明显，必要时统一存储类型或拆开计算`
        : '切换到列/行引擎的边界通常在大表读取处，可结合上面的表规模一起看',
    });
  }

  // ── 3. 连接算子 ──
  if (joins > 0) {
    const nested = rows.filter((r) => NESTED_LOOP_RE.test(r.OPERATOR_NAME ?? ''));
    if (nested.length > 0) {
      const involved = new Set<string>();
      for (const n of nested) {
        for (const d of descendants(rows, n.OPERATOR_ID)) {
          if (SCAN_RE.test(d.OPERATOR_NAME ?? '') && d.TABLE_NAME) {
            const size = d.TABLE_SIZE;
            involved.add(`${d.SCHEMA_NAME ? `${d.SCHEMA_NAME}.` : ''}${d.TABLE_NAME}${size != null ? `(${formatRows(size)} 行)` : ''}`);
          }
        }
      }
      findings.push({
        level: 'warn',
        title: `存在嵌套循环连接（${nested.length} 处），大表上代价高`,
        evidence: involved.size > 0
          ? `嵌套循环下游的表：${[...involved].join('、')}`
          : `算子：${nested.map((n) => (n.OPERATOR_NAME ?? '').trim()).join('、')}`,
        advice: '确认连接键两侧是否都有过滤/索引；数据量大时哈希连接通常更合适，可交由 DBA 评估',
      });
    } else {
      findings.push({
        level: 'info',
        title: `使用连接算子 ${joins} 处`,
        evidence: rows.filter((r) => JOIN_RE.test(r.OPERATOR_NAME ?? '')).map((r) => (r.OPERATOR_NAME ?? '').trim()).join('、'),
      });
    }
  }

  // ── 4. 计划结构异常 ──
  const rootCount = rows.filter(isRoot).length;
  const ids = new Set(rows.map((r) => r.OPERATOR_ID));
  const orphanCount = rows.filter((r) => !isRoot(r) && !ids.has(r.PARENT_OPERATOR_ID)).length;
  if (rootCount !== 1 || orphanCount > 0) {
    findings.push({
      level: 'warn',
      title: `计划结构不完整（根算子 ${rootCount} 个、孤儿算子 ${orphanCount} 个，通常应为 1 与 0）`,
      evidence: `共回读 ${rows.length} 行算子`,
      advice: '本次结论可能不完整，请重试；持续如此请反馈',
    });
  }

  // ── 5. 运行时统计（有则给） ──
  const rt = ctx.runtime;
  if (rt && (rt.executionCount != null || rt.avgExecutionTime != null)) {
    const avg = rt.avgExecutionTime;
    const execCount = rt.executionCount ?? 0;
    if (avg != null && avg >= 1_000_000) {
      findings.push({
        level: 'warn',
        title: `已执行 ${execCount} 次，平均耗时约 ${(avg / 1_000_000).toFixed(1)} 秒（HANA 列定义单位为微秒）`,
        evidence: `M_SQL_PLAN_CACHE：EXECUTION_COUNT=${execCount}，AVG_EXECUTION_TIME=${avg}`,
        advice: '这是热点语句；结合上面的扫描/连接结论定位瓶颈，或先用 hana_data_preview 核对数据量级',
      });
    } else {
      findings.push({
        level: 'info',
        title: `运行时统计：执行 ${execCount} 次${avg != null ? `，平均 ${avg} 微秒` : ''}`,
        evidence: `M_SQL_PLAN_CACHE：EXECUTION_COUNT=${execCount}${avg != null ? `，AVG_EXECUTION_TIME=${avg}` : ''}`,
      });
    }
  }

  // ── 汇总 ──
  const statistics: PlanStatistics = {
    operatorCount: rows.length,
    engines,
    engineSwitch: engines.length > 1,
    tables,
    scans,
    joins,
    aggregations,
    ...(largest && largest.size != null ? { largestTable: { name: largest.name, size: largest.size } } : {}),
    ...(root?.OUTPUT_SIZE != null ? { estimatedRows: root.OUTPUT_SIZE } : {}),
    ...(root ? { rootOperator: (root.OPERATOR_NAME ?? '').trim() } : {}),
  };

  const findings2 = [...findings].sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
  const summary = buildSummary(statistics, findings2);
  const conclusion: PlanConclusion = { summary, findings: findings2, statistics, text: '' };
  conclusion.text = renderConclusionText(conclusion, ctx.statement);
  return conclusion;
}

function buildSummary(stats: PlanStatistics, findings: Finding[]): string {
  const parts = [`语句编译为 ${stats.operatorCount} 个算子`];
  if (stats.tables.length > 0) {
    const biggest = stats.largestTable;
    parts.push(
      `涉及 ${stats.tables.length} 张表${biggest ? `（最大 ${biggest.name} 约 ${formatRows(biggest.size)} 行）` : ''}`,
    );
  }
  if (stats.scans > 0) parts.push(`扫描 ${stats.scans} 次`);
  if (stats.joins > 0) parts.push(`连接 ${stats.joins} 次`);
  if (stats.estimatedRows != null) parts.push(`预计输出约 ${formatRows(stats.estimatedRows)} 行`);
  const notable = findings.filter((f) => f.level !== 'info').slice(0, 2);
  return (
    parts.join('，') +
    (notable.length > 0 ? `；主要关注：${notable.map((f) => f.title).join('；')}` : '；未发现明显风险')
  );
}

const LEVEL_LABEL: Record<FindingLevel, string> = { risk: '风险', warn: '关注', info: '信息' };

/** 结论 → 整段可读文本 */
export function renderConclusionText(conclusion: PlanConclusion, statement: string): string {
  const lines: string[] = [];
  const oneLine = statement.replace(/\s+/g, ' ').trim();
  lines.push(`语句：${oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine}`);
  lines.push(`结论：${conclusion.summary}`);
  if (conclusion.findings.length > 0) {
    lines.push('发现：');
    for (const f of conclusion.findings) {
      lines.push(`  [${LEVEL_LABEL[f.level]}] ${f.title}`);
      lines.push(`        依据：${f.evidence}`);
      if (f.advice) lines.push(`        建议：${f.advice}`);
    }
  }
  const s = conclusion.statistics;
  const stats: string[] = [`算子 ${s.operatorCount}`];
  if (s.engines.length > 0) stats.push(`引擎 ${s.engines.join('/')}${s.engineSwitch ? '（跨引擎）' : ''}`);
  stats.push(`表 ${s.tables.length} 张`);
  stats.push(`扫描 ${s.scans}`);
  if (s.joins > 0) stats.push(`连接 ${s.joins}`);
  if (s.aggregations > 0) stats.push(`聚合 ${s.aggregations}`);
  if (s.estimatedRows != null) stats.push(`预计输出 ${formatRows(s.estimatedRows)} 行`);
  lines.push(`统计：${stats.join('｜')}`);
  return lines.join('\n');
}
