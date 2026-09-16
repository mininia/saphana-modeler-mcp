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
  const anchor = /\b(FROM|JOIN)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(text)) !== null) {
    const rest = text.slice(m.index + m[0].length);
    // 只看紧邻的那个标识符：后面跟 `.` 说明是限定名（已由 scanSqlSchemaRefs 处理）
    const ident = /^\s*("?)([A-Za-z_][A-Za-z0-9_$#]*)\1\s*(\.)?/.exec(rest);
    if (ident && !ident[3]) return true;
    anchor.lastIndex = m.index + m[0].length;
  }
  return false;
}

/** SQL 里不会作为 schema 出现的保留字（表位置上的兜底过滤） */
const SQL_NON_SCHEMA = new Set([
  'SELECT', 'FROM', 'WHERE', 'GROUP', 'ORDER', 'HAVING', 'INTO', 'VALUES', 'UNION', 'EXCEPT',
  'INTERSECT', 'LATERAL', 'DUMMY', 'PUBLIC', 'CURRENT_USER', 'SESSION_USER',
]);

/**
 * 去掉 SQL 字符串字面量与注释（避免把 'ABC.DEF' / `-- X.Y` 里的点当成 schema 限定）。
 *
 * 用**单遍状态机**而不是连续 replace：正则顺序敏感——先剥 `--` 行注释会把 `'a--b'` 里的
 * 字面量后半行一并吃掉（实测：`SELECT 'a--b' AS X ... FROM SAPSR3.T` 会扫不出 SAPSR3，
 * 读边界因此静默放行）。状态机同时正确处理引号内的 `--`、注释里的引号与 `''` 转义。
 */
function stripSqlLiteralsAndComments(sql: string): string {
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
    if (c === '-' && next === '-') {
      while (i < sql.length && sql[i] !== '\n') i++;
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
    // 表名区 = 锚点之后到子句边界（`(`、`)`、`=`、ON/WHERE/GROUP/… 或语句结束）
    const rest = text.slice(m.index + m[0].length);
    const boundary = rest.search(CLAUSE_BOUNDARY);
    const region = boundary >= 0 ? rest.slice(0, boundary) : rest;
    // 区内所有「限定名.」都算：第一张表 + 逗号列表里的后续表
    const qualified = /("?)([A-Za-z_][A-Za-z0-9_$#]*)\1\s*\./g;
    let q: RegExpExecArray | null;
    while ((q = qualified.exec(region)) !== null) {
      const quoted = q[1] === '"';
      const name = quoted ? q[2] : q[2].toUpperCase();
      if (!quoted && SQL_NON_SCHEMA.has(name)) continue;
      out.add(name);
    }
    anchor.lastIndex = m.index + m[0].length;
  }
  return [...out];
}
