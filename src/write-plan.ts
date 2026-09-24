import type { PolicyRequest } from './config/preflight.js';

/**
 * 写操作预规划（WritePlan）——「先规划，后判定」。
 *
 * 为什么需要它：只从入参里抠一个 `packageId` 去判定是不够的。一次写操作真正触碰的资源
 * 比参数表面多，而这些只有把请求解析一遍才知道：
 *   - hana_view_update 的 add_join：join 源在**另一个包**（跨包只读引用），藏在 operations 里；
 *   - hana_view_validate 的 design 模式：参数看着是"校验"，实际会**写入**一个 _CHKTMP 临时对象；
 *   - hana_repo_import：导入内容里可能引用**别的包**的数据源；
 *   - hana_view_delete：被删除对象的**下游依赖会失效**（波及面）。
 *
 * 本模块只描述「会发生什么」；判定仍由预检层（config/preflight.ts）按生效权限配置做，
 * 不在这里另写一套规则。
 *
 * 规划只做**只读**的分析，不产生任何副作用。
 */
export interface WritePlan {
  /** 工具名 */
  tool: string;
  /** 计划步骤（人类可读、按执行顺序），进拦截报告让调用方看清"将要发生什么" */
  steps: string[];
  /** 将写入 / 创建 / 删除的仓库包（判定依据：HANA_WRITE_PACKAGES） */
  writePackages: string[];
  /** 将读取的 schema（判定依据：HANA_SCHEMA_ALLOW） */
  readSchemas: string[];
  /**
   * 跨包只读引用（如 join 源所在包）。当前权限配置没有"可读包"这一项，
   * 故仅作为可见性信息进报告，不参与拦截。
   */
  readPackages: string[];
  /**
   * 计划无法静态确定的点。必须显式列出而不是假装确定——
   * 例如 filePath 导入的文件内容要到服务端读取时才知道。
   */
  uncertain: string[];
}

/** 计划 → 策略层的判定请求。只做映射，不做判定。 */
export function planToRequest(plan: WritePlan): PolicyRequest {
  return {
    ...(plan.writePackages.length > 0 ? { writePackages: plan.writePackages } : {}),
    ...(plan.readSchemas.length > 0 ? { schemas: plan.readSchemas } : {}),
    tools: [plan.tool],
  };
}

/** 计划 → 人类可读多行文本（进拦截报告 / 执行前日志） */
export function formatWritePlan(plan: WritePlan): string {
  const lines = [`写操作预规划（${plan.tool}）：`];
  plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push(
    `  触碰资源：写包 ${plan.writePackages.length ? plan.writePackages.join(', ') : '(无)'}` +
      `；读 schema ${plan.readSchemas.length ? plan.readSchemas.join(', ') : '(无)'}` +
      `；跨包只读引用 ${plan.readPackages.length ? plan.readPackages.join(', ') : '(无)'}`,
  );
  for (const u of plan.uncertain) lines.push(`  [不确定] ${u}`);
  return lines.join('\n');
}

/** 从 XML 里扫出跨包数据源引用（resourceUri="/<包路径>/..."）。尽力而为：扫不到不影响判定 */
export function scanXmlPackageRefs(xml: string): string[] {
  const out = new Set<string>();
  const re = /[Rr]esourceUri="\/([A-Za-z0-9_.-]+)\//g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) out.add(m[1]);
  return [...out];
}

/**
 * 是否含**未限定 schema** 的表引用（`FROM <名字>` 后面不是 `.`）。
 * 这类表名由 HANA 按当前用户的默认 schema 解析——服务层据此校验那个 schema 是否在允许范围内
 * （扫描器无法得知默认 schema，故这里只做探测，解析交给服务层查 CURRENT_SCHEMA）。
 */
export function hasUnqualifiedTableRef(sql: string): boolean {
  const text = stripSqlLiteralsAndComments(sql);
  const ctes = collectCteNames(text);
  const anchor = /\b(FROM|JOIN)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(text)) !== null) {
    if (regionHasUnqualifiedName(tableNameRegion(text, m.index + m[0].length), ctes)) return true;
    anchor.lastIndex = m.index + m[0].length;
  }
  return false;
}

/**
 * 表名区里的**每一张表**都要看，不能只看紧邻锚点的那一个：
 * `SELECT * FROM SYS.DUMMY, MARA` 里 MARA 才是未限定的那张，只看第一个会漏（评审实测）——
 * 而漏判的后果是"默认 schema 不在允许范围内"这类越界读取直接放行。
 * 按**顶层逗号**分片（括号内的逗号属于函数调用参数，不分片），每片只看头一个标识符。
 */
function regionHasUnqualifiedName(region: string, ctes: Set<string>): boolean {
  for (const part of splitTopLevel(region)) {
    const head = /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$#]*))\s*([.(]?)/.exec(part);
    if (!head) continue;
    const quoted = head[1] !== undefined;
    const name = quoted ? head[1] : head[2];
    const follow = head[3];
    if (follow === '.') continue; // 限定名（另有扫描）
    if (follow === '(') {
      // 表函数：**参数里也能有表名**，必须递归进去看（`APPLY_FILTER(MARA, $$X$$)` 里的 MARA
      // 若不看就等于没做"未限定表名"判定，而这类语句在 analyze=true 下会被真实执行）
      const open = part.indexOf('(', part.indexOf(name) + name.length);
      if (open >= 0 && regionHasUnqualifiedName(part.slice(open + 1), ctes)) return true;
      continue;
    }
    if (quoted) return true;
    const upper = name.toUpperCase();
    // DUMMY 是 SYS 下的伪表（恒 1 行）；CTE 名与保留字都不是表引用
    if (upper === 'DUMMY' || SQL_NON_SCHEMA.has(upper) || ctes.has(upper)) continue;
    return true;
  }
  return false;
}

/** 收集 `WITH <名> AS (` 定义的 CTE 名——它们出现在 FROM 位置时不是表引用 */
function collectCteNames(text: string): Set<string> {
  const names = new Set<string>();
  const re = /\b([A-Za-z_][A-Za-z0-9_$#]*)\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) names.add(m[1].toUpperCase());
  return names;
}

/** 按顶层逗号分片（括号深度 > 0 的逗号属于函数参数，不分片） */
function splitTopLevel(region: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < region.length; i++) {
    const ch = region[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth > 0) depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(region.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(region.slice(start));
  return parts;
}

/** 跳过一段配对括号，返回右括号之后的位置；不配对返回 -1 */
function skipBalanced(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** `(` 前紧邻标识符（或引号标识符的收尾）= 表函数调用；否则 `(` 属于派生表/子查询 */
function isCallParen(before: string): boolean {
  return /[A-Za-z0-9_$#"]$/.test(before.replace(/\s+$/, ''));
}

/**
 * 把**派生表/子查询**的括号内容抹成空白（保持偏移不变）。
 *
 * 为什么必须抹：`SELECT V.A FROM (SELECT T.A FROM SYS.TAB T) V` 里 `T.A` 的 `T` 是派生表的别名，
 * 不是 schema——不抹会被当成 schema 收集，而任何白名单都不可能有 `T`，于是**合法语句被误拒**
 * （实测：main 上返回 `['SYS']`，加括号扫描后变成 `['T','SYS']`）。
 * 派生表内部的表名不会因此漏掉：它自己的 `FROM` 会被锚点单独扫到（`SYS.TAB` 就在内层）。
 * **函数调用的参数不抹**——表函数的参数里可以有表名，而那里没有 FROM 锚点兜底。
 */
function maskDerivedTables(region: string): string {
  let out = '';
  let i = 0;
  while (i < region.length) {
    if (region[i] === '(' && !isCallParen(out)) {
      const end = skipBalanced(region, i);
      if (end > 0) {
        out += ' '.repeat(end - i);
        i = end;
        continue;
      }
    }
    out += region[i];
    i++;
  }
  return out;
}

/**
 * 跳过 `AS` 之后的别名（标识符或引号标识符）。**不能把 `AS` 当成表名区的终点**：
 * `SELECT * FROM SYS.DUMMY AS D, SECRET.T2` 里第一个 AS 之后就截断，逗号列表里后面的表
 * 对扫描器完全不可见（实测 refs 只有 `['SYS']`，SECRET 逃过白名单判定）。
 * 只跳过别名本身，后面的表继续可见；别名里的点（`AS "a.b"`）也不会被当成 schema。
 */
function skipAlias(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '"') {
    i++;
    while (i < text.length && text[i] !== '"') i++;
    return text[i] === '"' ? i + 1 : i;
  }
  while (i < text.length && /[A-Za-z0-9_$#]/.test(text[i])) i++;
  return i;
}

/**
 * 表名区 = FROM/JOIN 锚点之后，到**顶层**子句边界为止。
 *
 * 为什么要跟踪括号深度而不是见到 `(`/`)` 就切：表函数与派生表的表名都在括号里——
 * `APPLY_FILTER("SAPSR3"."MARA", $$X=1$$)`、`CE_COLUMN_TABLE("S"."T")`、`(SELECT * FROM C.T)`，
 * 早切会让它们整体逃过扫描（评审实测：这是读边界被绕过的一类写法）。顶层边界仍然是
 * ON/WHERE/GROUP/… 与语句结尾；顶层的 `=` 也切（旧行为，保留）；`AS` 只跳别名不截断（见 skipAlias）。
 */
function tableNameRegion(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') { depth++; continue; }
    if (ch === ')') {
      if (depth === 0) return text.slice(start, i);
      depth--;
      continue;
    }
    if (depth === 0 && ch === '=') return text.slice(start, i);
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      CLAUSE_KEYWORD.lastIndex = i;
      if (CLAUSE_KEYWORD.test(text)) {
        if (/^AS(?![A-Za-z0-9_$#])/i.test(text.slice(i))) {
          // AS 不是终点：跳过它和紧跟的别名，继续扫同一张表名区里后面的表
          return text.slice(start, i) + ' ' + tableNameRegion(text, skipAlias(text, i + 2));
        }
        return text.slice(start, i);
      }
    }
  }
  return text.slice(start);
}

/** 表名区的顶层子句边界关键字（粘性匹配：只在当前位置判定，避免把 `ONYX` 当 `ON`） */
const CLAUSE_KEYWORD = /\b(?:ON|WHERE|GROUP|ORDER|HAVING|UNION|EXCEPT|INTERSECT|AS)\b/iy;

/** SQL 里不会作为 schema 出现的保留字（表位置上的兜底过滤） */
const SQL_NON_SCHEMA = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'INTO', 'VALUES', 'UNION', 'EXCEPT',
  'INTERSECT', 'LATERAL', 'DUMMY', 'CURRENT_USER', 'SESSION_USER',
]);

/**
 * 去掉 SQL 字符串字面量与注释（避免把 'ABC.DEF' / `-- X.Y` 里的点当成 schema 限定）。
 *
 * 用**单遍状态机**而不是连续 replace：正则顺序敏感——先剥 `--` 行注释会把 `'a--b'` 里的
 * 字面量后半行一并吃掉（实测：`SELECT 'a--b' AS X ... FROM SAPSR3.T` 会扫不出 SAPSR3，
 * 读边界因此静默放行）。状态机同时正确处理引号内的 `--`、注释里的引号与 `''` 转义。
 *
 * 导出给 SQL 分析工具复用：语句分类（首 token）与分号校验都必须跑在剥离后的文本上，
 * 否则 `SELECT 'a;b' FROM T` 会被误判成多语句。**不要再写第二份剥离实现**。
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      i++; // 跳过起始引号
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'") i += 2; // '' 转义
        else if (sql[i] === "'") { i++; break; }
        else i++;
      }
      out += "''";
      continue;
    }
    // 双引号标识符必须**原样保留**（扫描器要读它），但它的内容要按标识符处理：
    // 里面的单引号 / $$ / -- 都不是字面量或注释的起始。缺这一段时
    // `SELECT "a'b" AS X, B.* FROM "SAPSR3"."MARA" B` 会被那个孤立的单引号吞掉后半句，
    // 两个扫描器都看不到 FROM，读边界静默放行（评审实测）。
    if (c === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"') i += 2; // "" 转义
        else if (sql[i] === '"') { i++; break; }
        else i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (c === '-' && next === '-') {
      // 行注释终止于 LF 或 CR（只认 LF 时，CR 结尾的一行会把后续语句一起吞成"注释"，
      // 多语句判定随之失效，但送去执行的是原文 —— 评审实测的洞）
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '$' && next === '$') {
      i += 2;
      while (i < sql.length && !(sql[i] === '$' && sql[i + 1] === '$')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/** 表位置子句的边界关键字：进入这些词即认为 FROM/JOIN 的表名区结束 */
const CLAUSE_BOUNDARY = /[(=)]|\b(ON|WHERE|GROUP|ORDER|HAVING|UNION|EXCEPT|INTERSECT|AS)\b/i;

/**
 * 从 SQL 脚本里扫出 schema 引用（`FROM SCHEMA."表"` / `JOIN "schema".t` / 逗号列表内的后续表）。
 *
 * 三条规则（每条都对应一类真实误判，松紧都必须在两个方向上都验）：
 * 1. 先剥掉字符串字面量与注释——否则 `'ABC.DEF'`、`-- 参考 X.Y` 里的 token 会被当成 schema；
 * 2. 只认**表位置**（`FROM` / `JOIN` 之后到子句边界之间）的限定名：别名限定列（`SRC.COL`）与
 *    CTE 名（`WITH BASE AS … SELECT BASE.X`）不是 schema，误报会把合法调用硬拦在预检；
 * 3. 引号形式（`"SAPSR3"."MARA"`）与大小写写法都要识别（引号内保留原样、未加引号按 HANA 规则折成大写）：
 *    只认全大写未加引号会漏掉 `"SAPSR3"."MARA"` = 读边界被绕过。
 *
 * 仍不覆盖（在计划里以「不确定」显式标注，不假装完整）：未限定 schema 的表名（服务端按当前用户默认
 * schema 解析）与动态 SQL。
 */
export function scanSqlSchemaRefs(sql: string): string[] {
  const text = stripSqlLiteralsAndComments(sql);
  const out = new Set<string>();
  const anchor = /\b(FROM|JOIN)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(text)) !== null) {
    // 表名区 = 锚点之后到**顶层**子句边界（表函数里括号内的表名同样要扫，见 tableNameRegion）；
    // 派生表/子查询的括号内容先抹掉——那里的 `T.A` 是别名限定列不是 schema，抹掉前会误拒合法语句
    // （它内部的表由自己的 FROM 锚点扫到，不会漏）
    collectQualifiedRefs(maskDerivedTables(tableNameRegion(text, m.index + m[0].length)), out);
    anchor.lastIndex = m.index + m[0].length;
  }
  return [...out];
}

/**
 * 扫表名区里的限定名（`SCHEMA.表` / `"SCHEMA"."表"`）。
 *
 * 必须按**标识符 token** 走，不能拿"名字后面跟点"的正则在整个区里找：
 * 引号标识符的内容里可以有任意字符，包括点——`"_SYS_BIC"."PKG/VIEW"`（HANA 运行时视图名的常见形态）
 * 会被正则当成 `_SYS_BIC` 与 `PKG` 两个限定名，凭空多出一个越界的假 schema（实测被策略层拦下）。
 * 所以：引号内的字符只按"引号标识符"整体处理，只有紧跟其后的 `.` 才算限定符。
 */
/** 前一个非空白字符（越界返回 undefined） */
function prevNonSpace(region: string, pos: number): string | undefined {
  let k = pos - 1;
  while (k >= 0 && /\s/.test(region[k])) k--;
  return k >= 0 ? region[k] : undefined;
}

/** 后一个非空白字符（越界返回 undefined） */
function nextNonSpace(region: string, pos: number): string | undefined {
  let k = pos;
  while (k < region.length && /\s/.test(region[k])) k++;
  return k < region.length ? region[k] : undefined;
}

function collectQualifiedRefs(region: string, out: Set<string>): void {
  let i = 0;
  // 多段名里只有**第一段**是 schema：`SCHEMA1.T1.COL` / `"S"."A--B"."C"` 的后续段不算 schema，
  // 否则会多扫出假 schema（如把列名当 schema），把合法调用挡在预检外。
  //
  // 两个判断都只看**紧邻的一个非空白字符**，所以用 prevNonSpace/nextNonSpace 前后扫，**不做切片**：
  // 早先写成 `!/\.\s*$/.test(region.slice(0, pos))` 与 `/^\s*\./.test(region.slice(j))`，每个标识符
  // 拷贝两次整段文本 → 整趟扫描是 O(标识符数 × 区域长度)。实测（本机）：限定名 1000/2000/4000/8000
  // 个 → 6.9/20.2/76.1/329.0 ms（每翻倍约 4×），10 万字符的语句单次 303 ms，而 hana_sql_analyze
  // 每次调用要跑两遍 → 约 0.6 s 的**同步**计算，HTTP 模式下会把整个进程的并发请求一起卡住。
  // 表名区扫描范围扩大（函数参数、AS 之后的表）后这个平方项才变得显眼，故改为零分配的前后扫。
  const isFirstSegment = (pos: number): boolean => prevNonSpace(region, pos) !== '.';
  while (i < region.length) {
    const ch = region[i];
    if (ch === '"') {
      const start = i + 1;
      let j = start;
      while (j < region.length) {
        if (region[j] === '"' && region[j + 1] === '"') j += 2; // "" 转义
        else if (region[j] === '"') break;
        else j++;
      }
      const name = region.slice(start, j);
      const next = j + 1; // 跳过收尾引号
      if (name !== '' && nextNonSpace(region, next) === '.' && isFirstSegment(i)) out.add(name);
      i = next;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < region.length && /[A-Za-z0-9_$#]/.test(region[j])) j++;
      const upper = region.slice(i, j).toUpperCase();
      if (nextNonSpace(region, j) === '.' && !SQL_NON_SCHEMA.has(upper) && isFirstSegment(i)) out.add(upper);
      i = j;
      continue;
    }
    i++;
  }
}
