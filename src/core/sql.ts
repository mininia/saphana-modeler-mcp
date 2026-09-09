/**
 * SQL 标识符与字面量防护：
 * - 所有拼进 SQL 的标识符必须经 quoteIdentifier / assertSafeObjectName 处理
 * - schema 名走白名单（系统 schema + 配置项 HANA_SCHEMA_ALLOW 追加）
 * - 值一律优先参数绑定；确需内联时用 quoteLiteral
 */

/** 系统 schema 白名单（核心模型对象所在；SAPABAP1 为 BW on HANA 业务数据 schema，普通用户按其数据库权限访问） */
const SYSTEM_SCHEMAS = new Set(['_SYS_BIC', '_SYS_BI', '_SYS_REPO', 'SYS', '_SYS_XS', 'SAPABAP1']);

/** 设计时对象名（包/视图）允许的字符集：字母/数字/_/$/#/./-，禁止引号与分号 */
const SAFE_NAME_RE = /^[A-Za-z0-9_$#.\-]+$/;

/** 运行时对象名（表/视图，允许 /，如 /BIC/AYELC070011）：字母/数字/_/$/#/./-/，禁止引号与分号 */
const SAFE_RUNTIME_NAME_RE = /^[A-Za-z0-9_$#.\/\-]+$/;

/** 追加配置允许的 schema（来自 HANA_SCHEMA_ALLOW），大小写不敏感 */
const extraSchemas = new Set<string>();
export function configureExtraSchemas(schemas: string[]): void {
  extraSchemas.clear();
  for (const s of schemas) extraSchemas.add(s.toUpperCase());
}

/** schema 是否在白名单内（含配置追加项） */
export function isSchemaAllowed(schema: string): boolean {
  return SYSTEM_SCHEMAS.has(schema.toUpperCase()) || extraSchemas.has(schema.toUpperCase());
}

/** 校验 schema 名：不在白名单直接抛错（防注入与非授权 schema 探测） */
export function assertSchemaAllowed(schema: string): void {
  if (!isSchemaAllowed(schema)) {
    throw new Error(`schema "${schema}" 不在允许列表中（系统 schema：_SYS_BIC/_SYS_BI/_SYS_REPO/SYS/_SYS_XS，或通过 HANA_SCHEMA_ALLOW 配置追加）`);
  }
}

/** 校验对象名（包/视图）字符集：含引号/分号/空白等一律拒绝（设计时名，不含 /） */
export function assertSafeObjectName(name: string, kind = '对象'): void {
  if (!SAFE_NAME_RE.test(name)) {
    throw new Error(`${kind}名 "${name}" 含非法字符（仅允许字母/数字/_/$/#/./-），已拒绝`);
  }
}

/** 校验运行时对象名（表/视图，允许 /）：含引号/分号/空白等一律拒绝（值仍须参数绑定，此为纵深防御） */
export function assertSafeRuntimeName(name: string, kind = '对象'): void {
  if (!SAFE_RUNTIME_NAME_RE.test(name)) {
    throw new Error(`${kind}名 "${name}" 含非法字符（仅允许字母/数字/_/$/#/./-//），已拒绝`);
  }
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
