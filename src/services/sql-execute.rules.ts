/**
 * hana_sql_execute 的规则层：**零 I/O、无 HANA 依赖**，可在碰数据库之前单独测试。
 *
 * 这里只定下两类“必须在执行前定下来”的判定（handler 用它给可恢复错误，服务层再用同一份兜底）：
 * 1. 脚本形状：空/NUL/绑定占位符/物理多行/多语句（后两者由 HANA_SQL_ALLOW_MULTI_STATEMENT 解锁）；
 * 2. 逐语句分类：read / dml / ddl / admin / transaction / unknown。**WITH 必须看 CTE 之后的主语句**
 *    （`WITH x AS (SELECT …) DELETE FROM Z.T` 是 dml，不是 read——这是已知绕过，测试钉住）。
 *
 * 2026-11 产品决策：**SQL 专用 schema 闸门已移除**——本模块不扫描 read/write schema，
 * 不参与 HANA_READ_SCHEMA / 写 schema 白名单判定；能访问什么由 HANA 账号权限决定。
 * 管理类语句也默认允许（受数据库权限约束）；仅显式事务控制、会修改会话状态的 SET、
 * EXPLAIN、DO 匿名块仍拒绝。
 *
 * 语句切分复用 write-plan.ts 的 splitSqlStatements（**不写第二份**：它已处理引号标识符/字符串/
 * 注释与括号内的分号）；引号标识符屏蔽复用 sql-analyze.rules 的 maskQuotedIdentifiers。
 * 语句分类与占位符判定必须跑在剥离字面量/注释后的文本上，否则 `SELECT 'a;b'`、
 * `"A?B"` 会被误判。
 */

import { createHash } from 'node:crypto';
import { maskQuotedIdentifiers } from './sql-analyze.rules.js';
import { SQL_MAX_STATEMENTS_DEFAULT } from '../core/limits.js';
import { splitSqlStatements, stripSqlLiteralsAndComments } from '../write-plan.js';

/** 语句类别（读/写/管理/事务；unknown = 无法安全判定，一律拒绝） */
export type SqlStatementKind = 'read' | 'dml' | 'ddl' | 'admin' | 'transaction' | 'unknown';

/** 可恢复的校验问题（handler 据此返回 mcpErrorText，服务层据此抛 HanaBusinessError） */
export interface SqlProblem {
  /** 稳定机器码（测试与日志按码断言） */
  code: string;
  message: string;
  hint: string;
}

/** 一次执行的部署策略（多语句开关 + 语句条数上限；maxRows/timeoutMs 是工具参数） */
export interface SqlExecutePolicy {
  /** HANA_SQL_ALLOW_MULTI_STATEMENT：同时解锁“多物理行”与“多语句” */
  allowMultiStatement: boolean;
  /** 单次调用允许的语句条数（默认 HANA_SQL_MAX_STATEMENTS 默认值） */
  maxStatements?: number;
  /** 只读环境（ACCESS=readonly + HANA_READONLY_SQL=select-only）：只允许 read 类语句 */
  readOnly?: boolean;
  /** 只读环境 + HANA_READONLY_SQL=deny：整体拒绝 hana_sql_execute */
  readonlySqlDeny?: boolean;
}

/** 单条已分类语句 */
export interface ParsedSqlStatement {
  /** 从 0 数的语句序号（错误信息里报第 index+1 条） */
  index: number;
  /** 将送去执行的原样语句（去掉语句间分隔符后的 trim 文本，不做改写） */
  sql: string;
  kind: SqlStatementKind;
}

/** 整份脚本的解析结果 */
export interface ParsedSqlScript {
  statements: ParsedSqlStatement[];
  problems: SqlProblem[];
  /** SQL 的 sha256 前 12 位（审计/回执用；不回显原文） */
  fingerprint: string;
}

/** HANA 具名参数 `:name`；`::` 不是参数（排除第二个冒号） */
const NAMED_PARAM_RE = /(?<!:):[A-Za-z_][A-Za-z0-9_]*/;

/** 物理换行（含 Unicode 行分隔符） */
const PHYSICAL_NEWLINE_RE = /[\n\r\u2028\u2029]/;

/** `sqlFingerprint`：sha256 前 12 位——审计只记指纹，不落 SQL 原文 */
export function sqlFingerprint(sql: string): string {
  return createHash('sha256').update(sql, 'utf8').digest('hex').slice(0, 12);
}

// ── 轻量词法辅助（只服务本文件的分类；不做完整 SQL 解析）──────────

function skipWs(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/** 跳过引号标识符（含 `""` 转义），返回收尾引号之后的位置；未闭合返回 -1 */
function skipQuoted(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === '"' && text[i + 1] === '"') i += 2;
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return -1;
}

/** 跳过配对括号（引号标识符内的括号不算），返回右括号之后的位置；不配对返回 -1 */
function skipBalancedSql(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '"') {
      const end = skipQuoted(text, i);
      if (end < 0) return -1;
      i = end - 1;
      continue;
    }
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

interface IdentToken {
  /** 各段（未加引号的已折大写；引号段保留原样） */
  parts: string[];
  /** 每段是否来自引号标识符（与 parts 对齐） */
  quoted: boolean[];
  /** token 结束位置（最后一段之后） */
  end: number;
}

/** 读一个（可能多段的）SQL 标识符；不是标识符返回 undefined */
function readIdentifier(text: string, from: number): IdentToken | undefined {
  let i = skipWs(text, from);
  const parts: string[] = [];
  const quoted: boolean[] = [];
  for (;;) {
    if (text[i] === '"') {
      const end = skipQuoted(text, i);
      if (end < 0) return undefined;
      parts.push(text.slice(i + 1, end - 1).replace(/""/g, '"'));
      quoted.push(true);
      i = end;
    } else if (i < text.length && /[A-Za-z_]/.test(text[i])) {
      const start = i;
      while (i < text.length && /[A-Za-z0-9_$#]/.test(text[i])) i++;
      parts.push(text.slice(start, i).toUpperCase());
      quoted.push(false);
    } else {
      return parts.length > 0 ? { parts, quoted, end: i } : undefined;
    }
    const afterWs = skipWs(text, i);
    if (text[afterWs] === '.') {
      i = afterWs + 1;
      continue;
    }
    return { parts, quoted, end: i };
  }
}

/** 读一个裸关键字（引号标识符不算关键字）；返回大写值与结束位置 */
function readWord(text: string, from: number): { word: string; end: number } | undefined {
  const i = skipWs(text, from);
  if (i >= text.length || !/[A-Za-z_]/.test(text[i])) return undefined;
  let j = i;
  while (j < text.length && /[A-Za-z0-9_$#]/.test(text[j])) j++;
  return { word: text.slice(i, j).toUpperCase(), end: j };
}

// ── 语句分类 ────────────────────────────────────────────────

/** WITH 之后的主语句关键字（处理多个 CTE、列清单、`RECURSIVE`）；解析不出返回 undefined */
function mainKeywordAfterWith(text: string): string | undefined {
  const withWord = readWord(text, 0);
  if (withWord?.word !== 'WITH') return undefined;
  let i = withWord.end;
  const maybeRecursive = readWord(text, i);
  if (maybeRecursive?.word === 'RECURSIVE') i = maybeRecursive.end;
  for (;;) {
    const name = readIdentifier(text, i);
    if (!name) return undefined;
    i = name.end;
    // 可选列清单：WITH C (A, B) AS (…)
    const afterName = skipWs(text, i);
    if (text[afterName] === '(') {
      const end = skipBalancedSql(text, afterName);
      if (end < 0) return undefined;
      i = end;
    }
    const as = readWord(text, i);
    if (as?.word !== 'AS') return undefined;
    const open = skipWs(text, as.end);
    if (text[open] !== '(') return undefined;
    const bodyEnd = skipBalancedSql(text, open);
    if (bodyEnd < 0) return undefined;
    i = bodyEnd;
    const next = skipWs(text, i);
    if (text[next] === ',') {
      i = next + 1;
      continue;
    }
    const main = readWord(text, next);
    return main?.word;
  }
}

/** 语句首关键字（WITH 取 CTE 之后的主语句；引号开头视为 unknown） */
function leadingKeyword(text: string): string | undefined {
  const first = readWord(text, 0);
  if (!first) return undefined;
  if (first.word === 'WITH') return mainKeywordAfterWith(text);
  return first.word;
}

/** 判定一条语句的类别（纯分类，不产出 problem） */
export function classifySqlStatement(statement: string): SqlStatementKind {
  const text = stripSqlLiteralsAndComments(statement);
  const first = readWord(text, 0);
  const keyword = first?.word === 'WITH' ? mainKeywordAfterWith(text) : first?.word;
  if (!keyword) return 'unknown';
  // 主语句关键字（WITH 之后的那个）位置不可直接复用 first.end；只有非 WITH 形态才需要它
  const keywordEnd = first?.word === keyword ? first.end : 0;

  // 显式事务控制：一律拒绝（连接池跨调用无法保证事务原子性）
  if (['BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE'].includes(keyword)) return 'transaction';
  if (keyword === 'SET') {
    const next = readWord(text, keywordEnd);
    return next?.word === 'TRANSACTION' ? 'transaction' : 'admin';
  }

  if (keyword === 'SELECT') return 'read';
  if (['INSERT', 'UPDATE', 'DELETE', 'UPSERT', 'MERGE'].includes(keyword)) return 'dml';
  if (['TRUNCATE', 'RENAME', 'COMMENT', 'CREATE', 'ALTER', 'DROP'].includes(keyword)) {
    // 管理类 DDL（用户/远程源/ALTER SYSTEM）优先于普通 ddl
    if (keyword === 'CREATE') {
      let i = keywordEnd;
      const orWord = readWord(text, i);
      if (orWord?.word === 'OR') {
        const replaceWord = readWord(text, orWord.end);
        if (replaceWord?.word === 'REPLACE') i = replaceWord.end;
      }
      const what = readWord(text, i);
      if (what?.word === 'USER' || what?.word === 'REMOTE') return 'admin';
    }
    if (keyword === 'ALTER' || keyword === 'DROP') {
      const what = readWord(text, keywordEnd);
      if (what?.word === 'USER' || what?.word === 'REMOTE' || what?.word === 'SYSTEM') return 'admin';
    }
    return 'ddl';
  }
  if (['CALL', 'DO', 'IMPORT', 'EXPORT', 'EXECUTE', 'GRANT', 'REVOKE', 'RECONFIGURE', 'EXPLAIN'].includes(keyword)) {
    return 'admin';
  }
  return 'unknown';
}

/** 是否为 EXPLAIN（需要专门提示改用 hana_sql_analyze） */
function isExplain(statement: string): boolean {
  return leadingKeyword(stripSqlLiteralsAndComments(statement)) === 'EXPLAIN';
}

// ── 脚本解析（执行前的唯一入口）─────────────────────────────

function problem(code: string, message: string, hint: string): SqlProblem {
  return { code, message, hint };
}

/**
 * 解析并校验一份待执行 SQL 脚本。
 *
 * 返回 problems 非空时**一律不得执行**（handler 取第一条给可恢复错误；服务层再跑一次同一函数兜底）。
 * 语句按顶层分号切分；空语句（连续分号/尾分号）忽略。
 */
export function parseSqlScript(raw: string, opts: SqlExecutePolicy): ParsedSqlScript {
  const sql = String(raw ?? '').trim();
  const fingerprint = sqlFingerprint(sql);
  const problems: SqlProblem[] = [];
  const statements: ParsedSqlStatement[] = [];
  const result: ParsedSqlScript = { statements, problems, fingerprint };
  if (sql === '') {
    problems.push(problem('sql_empty', 'sql 为空', '请提供要执行的 SQL 语句'));
    return result;
  }
  if (sql.includes('\u0000')) {
    problems.push(problem('sql_nul', 'SQL 含 NUL 字符', '请去掉文本中的不可见 NUL 字节后重试'));
    return result;
  }
  if (opts.readonlySqlDeny === true) {
    problems.push(
      problem(
        'sql_readonly_denied',
        '当前环境为只读，且 HANA_READONLY_SQL=deny：hana_sql_execute 整体不可用',
        '如需只读查询，请由部署方设置 HANA_READONLY_SQL=select-only；写操作请切换到 ACCESS=readwrite 的环境',
      ),
    );
    return result;
  }
  const strippedAll = stripSqlLiteralsAndComments(sql);
  const maskedAll = maskQuotedIdentifiers(strippedAll);
  if (maskedAll.includes('?') || NAMED_PARAM_RE.test(maskedAll)) {
    problems.push(
      problem(
        'sql_placeholder',
        'SQL 含绑定占位符（? 或 :name）',
        '本工具不接受绑定参数；请把参数替换为字面量（注意转义），或改用固定语句',
      ),
    );
  }
  if (!opts.allowMultiStatement && PHYSICAL_NEWLINE_RE.test(sql)) {
    problems.push(
      problem(
        'sql_multi_line',
        '默认只接受单物理行（检测到换行符 \n / \r / U+2028 / U+2029）',
        '请把语句写成一行；确实需要多行/多语句时由部署方配置 HANA_SQL_ALLOW_MULTI_STATEMENT=true',
      ),
    );
  }

  const rawStatements = splitSqlStatements(sql)
    .map((s) => s.trim())
    // 只有注释/字面量的片段不是语句（常见形态：`SELECT 1 FROM DUMMY; -- done` 的尾注释）。
    // 不剔掉会把尾注释当成一条 unknown 语句，默认单语句调用被无谓拒绝。
    .filter((s) => s !== '' && stripSqlLiteralsAndComments(s).trim() !== '');
  if (rawStatements.length === 0) {
    problems.push(problem('sql_empty', 'SQL 不含可执行语句', '请提供至少一条 SQL 语句'));
    return result;
  }
  if (!opts.allowMultiStatement && rawStatements.length > 1) {
    problems.push(
      problem(
        'sql_multi_statement',
        `默认只接受单条语句（检测到 ${rawStatements.length} 条）`,
        '多语句执行需由部署方配置 HANA_SQL_ALLOW_MULTI_STATEMENT=true；该开关同时解锁多行与多语句',
      ),
    );
  }
  const maxStatements = opts.maxStatements ?? SQL_MAX_STATEMENTS_DEFAULT;
  if (rawStatements.length > maxStatements) {
    problems.push(
      problem(
        'sql_too_many_statements',
        `语句条数超过上限（${rawStatements.length} > ${maxStatements}）`,
        '请拆成多次调用；上限由部署方的 HANA_SQL_MAX_STATEMENTS 决定',
      ),
    );
  }

  rawStatements.forEach((statement, index) => {
    const stripped = stripSqlLiteralsAndComments(statement);
    const kind = classifySqlStatement(statement);
    statements.push({ index, sql: statement, kind });

    // 只读环境：只允许 read 类；再额外拒绝 read 类里会加锁/改序列状态的构造。
    // 这是运行期护栏，真正的边界仍是只读数据库账号。
    if (opts.readOnly === true) {
      if (kind !== 'read') {
        problems.push(
          problem(
            'sql_readonly_violation',
            `只读环境只允许 SELECT 类语句（第 ${index + 1} 条被判定为 ${kind}）`,
            '当前环境 ACCESS=readonly；写操作请切换到可写环境，或由部署方设置 HANA_READONLY_SQL=deny 完全关闭',
          ),
        );
        return;
      }
      // 引号标识符可能是合法列名（"NEXTVAL"），必须与占位符检查同口径先遮蔽再匹配。
      const upper = maskQuotedIdentifiers(stripped).toUpperCase();
      if (/\bFOR\s+(UPDATE|SHARE)\b/.test(upper) || /\bNEXTVAL\b/.test(upper)) {
        problems.push(
          problem(
            'sql_readonly_mutation',
            `只读环境不允许加锁或序列自增（第 ${index + 1} 条含 FOR UPDATE/FOR SHARE 或 NEXTVAL）`,
            '请去掉 FOR UPDATE/FOR SHARE/NEXTVAL 后重试；只读环境不应改变行锁或序列状态',
          ),
        );
        return;
      }
    }

    if (kind === 'transaction') {
      problems.push(
        problem(
          'sql_transaction_control',
          `不允许显式事务控制语句（第 ${index + 1} 条：${leadingKeyword(stripped) ?? '?'}）`,
          '连接池跨调用无法保证事务原子性；多语句执行由服务端自动开事务（有写时全部成功才提交）',
        ),
      );
      return;
    }
    if (kind === 'unknown') {
      problems.push(
        problem(
          'sql_statement_unsupported',
          `不支持或无法安全判定的语句（第 ${index + 1} 条）`,
          '只支持 SELECT / 常见 DML / DDL / 管理类语句；过程体、动态 SQL 与其它语句不在本工具范围内',
        ),
      );
      return;
    }
    if (kind === 'admin') {
      // SET（非 TRANSACTION）修改会话状态：连接归还池后 CURRENT_SCHEMA 等状态会带给后续
      // 无关调用（HTTP 多客户端下还会跨身份传播），因此与事务控制同口径拒绝。
      if (leadingKeyword(stripped) === 'SET') {
        problems.push(
          problem(
            'sql_session_state_unsupported',
            `不支持修改会话状态的 SET 语句（第 ${index + 1} 条）`,
            '连接池会把会话状态带给后续调用；请去掉 SET，需要默认 schema 时由数据库账号侧设置',
          ),
        );
        return;
      }
      if (isExplain(statement)) {
        problems.push(
          problem(
            'sql_explain_not_supported',
            `EXPLAIN 语句不在 hana_sql_execute 范围内（第 ${index + 1} 条）`,
            '请改用 hana_sql_analyze（sql 模式只看估计计划，或 sql + analyze=true 真执行后再分析）',
          ),
        );
        return;
      }
      // DO 匿名块内部用分号分隔多条语句，和“一次调用按顶层分号切分”的模型冲突：
      // 支持它需要绕过切分并放弃逐语句分类，而它本来就等价于任意管理脚本。
      if (leadingKeyword(stripped) === 'DO') {
        problems.push(
          problem(
            'sql_anonymous_block_not_supported',
            `DO 匿名块不支持（第 ${index + 1} 条）`,
            '请改用 CALL 存储过程；或把块内语句拆成多条，并配置 HANA_SQL_ALLOW_MULTI_STATEMENT=true',
          ),
        );
        return;
      }
      // 其它管理类语句默认允许（受数据库账号权限约束）。
    }
  });

  return result;
}
