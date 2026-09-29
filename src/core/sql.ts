import { HanaBusinessError } from './errors.js';

/**
 * SQL 标识符与字面量防护：
 * - 所有拼进 SQL 的标识符必须经 quoteIdentifier / assertSafeObjectName 处理
 * - schema 名走白名单（系统 schema + 配置项 HANA_SCHEMA_ALLOW 追加）
 * - 值一律优先参数绑定；确需内联时用 quoteLiteral
 *
 * 错误出口：本模块的断言一律抛 HanaBusinessError（带 code），**不抛裸 Error**。
 * 原因：裸 Error 会被 withErrorEnvelope 归入"未知错误"，对外只剩「内部错误，详情见服务端日志」——
 * 「schema 不在允许列表」「对象名含非法字符」这类**调用方可据以修正**的原因会被整体吞掉。
 */

/** 系统 schema 白名单（核心模型对象所在；SAPABAP1 为 BW on HANA 业务数据 schema，普通用户按其数据库权限访问） */
const SYSTEM_SCHEMAS = new Set(['_SYS_BIC', '_SYS_BI', '_SYS_REPO', 'SYS', '_SYS_XS', 'SAPABAP1']);

/** 白名单不可枚举时的兜底文案（正常情况下由 describeSchemaWhitelist 生成） */
const SCHEMA_HINT = '或通过 HANA_SCHEMA_ALLOW 配置追加';

/**
 * 设计时对象名（包/视图）允许的字符集：字母/数字/_/$/#/./-，禁止引号与分号。
 *
 * ⚠️ 与 PACKAGE_ID_RE 的关系：本正则是**仓库侧**对象名的宽松口径（BW 对象的 `$`、`#` 合法，
 * 例如 /BIC 命名空间），PACKAGE_ID_RE 是**工具入参**的严格口径。二者刻意不同：
 * 工具入参收紧是纵深防御，仓库侧收紧会误杀既有对象。不要"为统一而统一"。
 */
const SAFE_NAME_RE = /^[A-Za-z0-9_$#.\-]+$/;

/** 运行时对象名（表/视图，允许 /，如 /BIC/AZDEMO001）：禁止引号与分号 */
const SAFE_RUNTIME_NAME_RE = /^[A-Za-z0-9_$#./\-]+$/;

/**
 * 包名（packageId / 对象名）的**工具入参**字符集：字母/数字/_/./-。
 * 比 SAFE_NAME_RE 严格（不含 $ # /）——这是暴露给模型与外部调用方的契约，
 * 全仓 28 处 zod schema 共用此常量，避免各写一份导致规则漂移。
 */
export const PACKAGE_ID_RE = /^[A-Za-z0-9_.\-]+$/;

/** schema 名与表名（工具入参口径）：不以数字开头，长度按 HANA 标识符上限 127 */
const TOOL_SCHEMA_ID_RE = /^[A-Za-z_][A-Za-z0-9_$#]{0,126}$/;
const TOOL_TABLE_NAME_RE = /^[A-Za-z_/][A-Za-z0-9_$#/]{0,255}$/;

/** 追加配置允许的 schema（来自 HANA_SCHEMA_ALLOW），大小写不敏感 */
const extraSchemas = new Set<string>();
export function configureExtraSchemas(schemas: string[]): void {
  extraSchemas.clear();
  for (const s of schemas) extraSchemas.add(s.toUpperCase());
}

/** 当前生效的追加 schema 快照（只读；测试与诊断用，替代直接读模块状态） */
export function extraSchemaSnapshot(): readonly string[] {
  return [...extraSchemas];
}

/**
 * schema 是否在「系统 schema + 给定追加项」内（**纯函数**，不读也不改进程状态）。
 * 供预检层按任意配置来源（如某个 mcp.json）判定用，与运行时的 isSchemaAllowed 共用同一规则，
 * 避免出现两套白名单判定。
 */
export function isSchemaAllowedWith(schema: string, extra: readonly string[]): boolean {
  const s = schema.toUpperCase();
  return SYSTEM_SCHEMAS.has(s) || extra.some((e) => e.toUpperCase() === s);
}

/** schema 是否在白名单内（含 configureExtraSchemas 配置的追加项） */
export function isSchemaAllowed(schema: string): boolean {
  return isSchemaAllowedWith(schema, extraSchemaSnapshot());
}

/**
 * 白名单的可读描述（供**所有**拒绝文案与排障提示共用）。
 *
 * 单点生成的原因：手写枚举曾在多处与实际白名单漂移 —— 报错文案漏列 SAPABAP1，
 * 调用方按报错去排查会得出"我加的 schema 明明在白名单里"这类错误结论。
 * 文案由 SYSTEM_SCHEMAS 生成后，白名单变更不可能再与文案脱节。
 */
export function describeSchemaWhitelist(): string {
  return [...SYSTEM_SCHEMAS].join('/');
}

/** 校验 schema 名：不在白名单直接抛错（防注入与非授权 schema 探测） */
export function assertSchemaAllowed(schema: string): void {
  if (!isSchemaAllowed(schema)) {
    throw new HanaBusinessError(
      `schema "${schema}" 不在允许列表中（系统 schema：${describeSchemaWhitelist()}，${SCHEMA_HINT}）`,
      'SCHEMA_NOT_ALLOWED',
    );
  }
}

/** 校验对象名（包/视图）字符集：含引号/分号/空白等一律拒绝（设计时名，不含 /） */
export function assertSafeObjectName(name: string, kind = '对象'): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new HanaBusinessError(
      `${kind}名 "${name}" 含非法字符（仅允许字母/数字/_/$/#/./-），已拒绝`,
      'INVALID_OBJECT_NAME',
    );
  }
}

/** 校验运行时对象名（表/视图，允许 /）：含引号/分号/空白等一律拒绝（值仍须参数绑定，此为纵深防御） */
export function assertSafeRuntimeName(name: string, kind = '对象'): void {
  if (!SAFE_RUNTIME_NAME_RE.test(name)) {
    throw new HanaBusinessError(
      `${kind}名 "${name}" 含非法字符（仅允许字母/数字/_/$/#/./-//），已拒绝`,
      'INVALID_OBJECT_NAME',
    );
  }
}

/** 纯判定版（不抛错）：用于需要自行组织错误文案的调用点 */
export function isSafeObjectName(name: string): boolean {
  return SAFE_NAME_RE.test(name);
}

/** 纯判定版（不抛错）：运行时对象名（允许 /） */
export function isSafeRuntimeName(name: string): boolean {
  return SAFE_RUNTIME_NAME_RE.test(name);
}

/** 工具入参口径的 schema 名校验（不以数字开头、限长 126） */
export function isSafeToolSchemaId(name: string): boolean {
  return TOOL_SCHEMA_ID_RE.test(name);
}

/** 工具入参口径的表名校验（允许 / 前缀，限长 256） */
export function isSafeToolTableName(name: string): boolean {
  return TOOL_TABLE_NAME_RE.test(name);
}

/** HANA 双引号标识符：包裹双引号，内部双引号按 SQL 规则翻倍转义 */
export function quoteIdentifier(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** SQL 字符串字面量：包裹单引号，内部单引号翻倍转义；null/undefined → NULL */
export function quoteLiteral(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

/** 组合 schema.对象 的完整引用（带校验）：如 _SYS_BIC + package1/view1 → "_SYS_BIC"."package1/view1" */
export function qualifyName(schema: string, objectName: string): string {
  assertSchemaAllowed(schema);
  return `${quoteIdentifier(schema)}.${quoteIdentifier(objectName)}`;
}
