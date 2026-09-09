import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { assertSafeRuntimeName, assertSchemaAllowed } from '../core/sql.js';
import { parseViewDefinition } from '../model/view-xml.js';
import type {
  ViewCalculatedAttribute,
  ViewDataSource,
  ViewDefinition,
  ViewKind,
  ViewNode,
  ViewNodeMapping,
  ViewOutputField,
  ViewOutputs,
} from '../model/view-types.js';

/**
 * 只读元数据通道（实测结论）：
 * - 视图定义：_SYS_REPO.ACTIVE_OBJECT（CDATA 设计时 XML）
 * - 表列表：SYS.TABLES（按当前用户权限过滤）
 * - 表列：SYS.TABLE_COLUMNS（SYS.COLUMNS 对该环境用户 258 不可用）
 */

/** 视图类型 → ACTIVE_OBJECT.OBJECT_SUFFIX 映射（导出供视图解析缓存复用） */
export const VIEW_SUFFIXES: Record<ViewKind, string> = {
  calculationview: 'calculationview',
  attributeview: 'attributeview',
  analyticview: 'analyticview',
};

export interface ViewDefinitionResult {
  /** 仓库对象信息 */
  object: { packageId: string; objectName: string; objectSuffix: string; versionId: number; activatedAt?: string; activatedBy?: string };
  /** 结构化视图定义（format=json） */
  definition?: ViewDefinition;
  /** 原始 XML（format=xml） */
  xml?: string;
}

/**
 * 读取视图定义。kind 省略时按三个类型逐一匹配（取最新激活）。
 * format=json 返回解析后的结构化模型（含节点逻辑/公式/变量/输出字段）；
 * format=xml 返回原始 CDATA（备份/对比用）。
 */
export async function getViewDefinition(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: { kind?: ViewKind; format?: 'json' | 'xml' } = {},
): Promise<ViewDefinitionResult> {
  const suffixes = opts.kind ? [VIEW_SUFFIXES[opts.kind]] : Object.values(VIEW_SUFFIXES);
  const rows = await pool.query<{
    PACKAGE_ID: string;
    OBJECT_NAME: string;
    OBJECT_SUFFIX: string;
    VERSION_ID: number;
    ACTIVATED_AT: string;
    ACTIVATED_BY: string;
    CDATA: string | null;
  }>(
    `SELECT PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, VERSION_ID, ACTIVATED_AT, ACTIVATED_BY, CDATA
     FROM "_SYS_REPO"."ACTIVE_OBJECT"
     WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN (${suffixes.map(() => '?').join(',')})
     ORDER BY VERSION_ID DESC LIMIT 1`,
    [packageId, objectName, ...suffixes],
  );
  const row = rows[0];
  if (!row) {
    // 必须抛 HanaBusinessError：普通 Error 会被 withErrorEnvelope 当成未知错误包成「内部错误」，
    // 用户无法据此修正包名/对象名（包名/对象名在 _SYS_REPO 中大小写敏感、存储为大写）
    throw new HanaBusinessError(
      `未找到视图 ${packageId}/${objectName}（类型：${suffixes.join('/')}）。` +
        `可先用 hana_metadata_search_objects 按名称片段搜索定位；` +
        `包名/对象名大小写敏感（仓库内为大写存储），如 ZDEMO.ZDEMO_MGF/ZDEMO02_CV008`,
    );
  }
  const result: ViewDefinitionResult = {
    object: {
      packageId: row.PACKAGE_ID,
      objectName: row.OBJECT_NAME,
      objectSuffix: row.OBJECT_SUFFIX as ViewKind,
      versionId: row.VERSION_ID,
      activatedAt: row.ACTIVATED_AT,
      activatedBy: row.ACTIVATED_BY,
    },
  };
  if (opts.format === 'xml' || !row.CDATA) {
    result.xml = row.CDATA ?? undefined;
  }
  if (opts.format !== 'xml' && row.CDATA) {
    result.definition = parseViewDefinition(row.CDATA, row.OBJECT_SUFFIX as ViewKind);
  }
  return result;
}

export interface TableInfo {
  schemaName: string;
  tableName: string;
  tableType: string;
  comments?: string | null;
}

/** 表列表（SYS.TABLES 按当前用户权限过滤；schema 默认当前 schema） */
export async function listTables(
  pool: HanaPool,
  opts: { schema?: string; pattern?: string; limit?: number } = {},
): Promise<TableInfo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200);
  const schema = opts.schema ?? (await currentSchema(pool));
  // 纵深防御：显式传入的 schema 走白名单（系统 schema + HANA_SCHEMA_ALLOW 追加），
  // 防任意 schema 枚举；默认当前 schema 已由数据库权限约束
  if (opts.schema) assertSchemaAllowed(opts.schema);
  const where = ['SCHEMA_NAME = ?'];
  const params: Array<string | number> = [schema];
  if (opts.pattern) {
    where.push('TABLE_NAME LIKE ?');
    params.push(`%${opts.pattern}%`);
  }
  params.push(limit);
  const rows = await pool.query<{
    SCHEMA_NAME: string;
    TABLE_NAME: string;
    TABLE_TYPE: string;
    COMMENTS: string | null;
  }>(
    `SELECT SCHEMA_NAME, TABLE_NAME, TABLE_TYPE, COMMENTS FROM SYS.TABLES
     WHERE ${where.join(' AND ')} ORDER BY TABLE_NAME LIMIT ?`,
    params,
  );
  return rows.map((r) => ({
    schemaName: r.SCHEMA_NAME,
    tableName: r.TABLE_NAME,
    tableType: r.TABLE_TYPE,
    comments: r.COMMENTS,
  }));
}

export interface ColumnInfo {
  columnName: string;
  position: number;
  dataTypeName: string;
  length?: number | null;
  scale?: number | null;
  isNullable: boolean;
  defaultValue?: string | null;
  comments?: string | null;
}

/** 表列结构（SYS.TABLE_COLUMNS） */
export async function getTableColumns(
  pool: HanaPool,
  schema: string,
  table: string,
  opts: { limit?: number } = {},
): Promise<ColumnInfo[]> {
  const limit = Math.min(Math.max(opts.limit ?? 200, 1), 500);
  // 纵深防御：schema 走白名单、表名做字符集校验（值仍参数绑定，此为第二道防线）
  assertSchemaAllowed(schema);
  assertSafeRuntimeName(table, '表');
  const rows = await pool.query<{
    COLUMN_NAME: string;
    POSITION: number;
    DATA_TYPE_NAME: string;
    LENGTH: number | null;
    SCALE: number | null;
    IS_NULLABLE: string;
    DEFAULT_VALUE: string | null;
    COMMENTS: string | null;
  }>(
    `SELECT COLUMN_NAME, POSITION, DATA_TYPE_NAME, LENGTH, SCALE, IS_NULLABLE, DEFAULT_VALUE, COMMENTS
     FROM SYS.TABLE_COLUMNS
     WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?
     ORDER BY POSITION LIMIT ?`,
    [schema, table, limit],
  );
  if (rows.length === 0) {
    throw new Error(`未找到表 ${schema}/${table}（或当前用户无权限）。可用 hana_table_list 确认 schema 下可访问的表`);
  }
  return rows.map((r) => ({
    columnName: r.COLUMN_NAME,
    position: r.POSITION,
    dataTypeName: r.DATA_TYPE_NAME,
    length: r.LENGTH,
    scale: r.SCALE,
    isNullable: r.IS_NULLABLE === 'TRUE',
    defaultValue: r.DEFAULT_VALUE,
    comments: r.COMMENTS,
  }));
}

async function currentSchema(pool: HanaPool): Promise<string> {
  const rows = await pool.query<{ CURRENT_SCHEMA: string }>('SELECT CURRENT_SCHEMA FROM DUMMY');
  return rows[0]?.CURRENT_SCHEMA ?? '';
}

export interface CrossRefItem {
  packageId: string;
  objectName: string;
  objectSuffix: string;
  refType: number;
  /** 是否运行时目录视图引用（FROM 侧为 __RT_CATALOG_VIEW__，即激活后的运行时对象） */
  isRuntime: boolean;
}

export interface WhereUsedResult {
  object: { packageId: string; objectName: string; objectSuffix: string };
  /** 该对象依赖的对象（上游，被引用方） */
  upstream: CrossRefItem[];
  /** 依赖该对象的对象（下游，引用方） */
  downstream: CrossRefItem[];
}

/**
 * 血缘搜索（ACTIVE_OBJECTCROSSREF）：
 * - upstream：该对象引用了谁（FROM = 本对象）
 * - downstream：谁引用了该对象（TO = 本对象）
 * kind 省略时匹配三种视图类型。
 * 说明：downstream 中 isRuntime=true 表示激活后的运行时目录视图（_SYS_BIC）对本仓库对象的引用。
 */
export async function whereUsed(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: { kind?: ViewKind; direction?: 'upstream' | 'downstream' | 'both' } = {},
): Promise<WhereUsedResult> {
  const suffixes = opts.kind ? [VIEW_SUFFIXES[opts.kind]] : Object.values(VIEW_SUFFIXES);
  const suffixIn = `(${suffixes.map(() => '?').join(',')})`;
  const direction = opts.direction ?? 'both';

  const mapRow = (r: { PACKAGE_ID: string; OBJECT_NAME: string; OBJECT_SUFFIX: string; REF_TYPE: number }): CrossRefItem => ({
    packageId: r.PACKAGE_ID,
    objectName: r.OBJECT_NAME,
    objectSuffix: r.OBJECT_SUFFIX,
    refType: r.REF_TYPE,
    // 运行时目录引用（__RT_CATALOG_VIEW__ / __RT_CATALOG_TABLE__ 等）
    isRuntime: r.OBJECT_SUFFIX.startsWith('__RT_'),
  });

  const upstream = direction === 'both' || direction === 'upstream'
    ? await pool.query<{ PACKAGE_ID: string; OBJECT_NAME: string; OBJECT_SUFFIX: string; REF_TYPE: number }>(
        `SELECT TO_PACKAGE_ID AS PACKAGE_ID, TO_OBJECT_NAME AS OBJECT_NAME, TO_OBJECT_SUFFIX AS OBJECT_SUFFIX, REF_TYPE
         FROM "_SYS_REPO"."ACTIVE_OBJECTCROSSREF"
         WHERE FROM_PACKAGE_ID = ? AND FROM_OBJECT_NAME = ? AND FROM_OBJECT_SUFFIX IN ${suffixIn}
         ORDER BY TO_OBJECT_SUFFIX, TO_OBJECT_NAME`,
        [packageId, objectName, ...suffixes],
      )
    : [];
  const downstream = direction === 'both' || direction === 'downstream'
    ? await pool.query<{ PACKAGE_ID: string; OBJECT_NAME: string; OBJECT_SUFFIX: string; REF_TYPE: number }>(
        `SELECT FROM_PACKAGE_ID AS PACKAGE_ID, FROM_OBJECT_NAME AS OBJECT_NAME, FROM_OBJECT_SUFFIX AS OBJECT_SUFFIX, REF_TYPE
         FROM "_SYS_REPO"."ACTIVE_OBJECTCROSSREF"
         WHERE TO_PACKAGE_ID = ? AND TO_OBJECT_NAME = ? AND TO_OBJECT_SUFFIX IN ${suffixIn}
         ORDER BY FROM_OBJECT_SUFFIX, FROM_OBJECT_NAME`,
        [packageId, objectName, ...suffixes],
      )
    : [];

  return {
    object: { packageId, objectName, objectSuffix: opts.kind ?? '?' },
    upstream: upstream.map(mapRow),
    downstream: downstream.map(mapRow),
  };
}

/**
 * 在视图定义中查找计算属性（节点内计算列）by ID
 * 适用于类似 ZDEMO008_CV001 中查找 ZDEMO_FLD_NEW 的场景
 */
export function findCalculatedAttribute(
  definition: ViewDefinition,
  attributeId: string,
): ViewCalculatedAttribute | undefined {
  for (const node of definition.nodes) {
    const attr = node.calculatedAttributes.find(ca => ca.id === attributeId);
    if (attr) {
      return attr;
    }
  }
  // 也检查输出中的计算属性
  return definition.outputs.calculatedAttributes.find(ca => ca.id === attributeId);
}

/**
 * 在视图定义中查找节点 by ID
 */
export function findNode(definition: ViewDefinition, nodeId: string): ViewNode | undefined {
  return definition.nodes.find(node => node.id === nodeId);
}

/**
 * 在视图定义中查找输出字段（属性/度量）by ID
 */
export function findOutputField(
  definition: ViewDefinition,
  fieldId: string,
): ViewOutputField | undefined {
  const allOutputs = [
    ...definition.outputs.attributes,
    ...definition.outputs.calculatedAttributes,
    ...definition.outputs.measures,
    ...definition.outputs.calculatedMeasures,
    ...definition.outputs.restrictedMeasures,
  ];
  return allOutputs.find(field => field.id === fieldId);
}

/**
 * 搜索视图中的字段/属性（支持模糊匹配）
 * 返回匹配的字段及其位置信息
 */
export interface FieldMatch {
  field: ViewOutputField | ViewCalculatedAttribute;
  location: 'output' | 'node';
  nodeId?: string;
  fieldType: 'attribute' | 'calculatedAttribute' | 'measure' | 'calculatedMeasure' | 'restrictedMeasure';
}

export function searchFields(
  definition: ViewDefinition,
  pattern: string,
  opts: { caseSensitive?: boolean; exact?: boolean } = {},
): FieldMatch[] {
  const matches: FieldMatch[] = [];
  const { caseSensitive = false, exact = false } = opts;
  const searchStr = caseSensitive ? pattern : pattern.toLowerCase();

  const isMatch = (id: string): boolean => {
    const target = caseSensitive ? id : id.toLowerCase();
    return exact ? target === searchStr : target.includes(searchStr);
  };

  // 搜索输出字段
  const outputFieldTypes: Array<[keyof ViewOutputs, FieldMatch['fieldType']]> = [
    ['attributes', 'attribute'],
    ['calculatedAttributes', 'calculatedAttribute'],
    ['measures', 'measure'],
    ['calculatedMeasures', 'calculatedMeasure'],
    ['restrictedMeasures', 'restrictedMeasure'],
  ];

  for (const [key, type] of outputFieldTypes) {
    for (const field of definition.outputs[key] as ViewOutputField[]) {
      if (isMatch(field.id)) {
        matches.push({ field, location: 'output', fieldType: type });
      }
    }
  }

  // 搜索节点内的计算属性
  for (const node of definition.nodes) {
    for (const attr of node.calculatedAttributes) {
      if (isMatch(attr.id)) {
        matches.push({ field: attr, location: 'node', nodeId: node.id, fieldType: 'calculatedAttribute' });
      }
    }
  }

  return matches;
}

/**
 * 获取计算属性的公式（简化版，适用于 ZDEMO008_CV001 类似场景）
 * @param definition 视图定义
 * @param attributeId 计算属性 ID（如 "ZDEMO_FLD_NEW"）
 * @returns 公式字符串，未找到返回 undefined
 */
export function getCalculatedAttributeFormula(
  definition: ViewDefinition,
  attributeId: string,
): string | undefined {
  const attr = findCalculatedAttribute(definition, attributeId);
  return attr?.formula;
}

/**
 * 获取视图的数据源汇总信息
 * 返回所有引用的表、视图和其他计算视图
 */
export interface DataSourceSummary {
  id: string;
  type: string;
  schemaName?: string;
  tableName?: string;
  resourceUri?: string;
  /** 是否为计算视图引用 */
  isCalculationView: boolean;
}

export function getDataSourcesSummary(definition: ViewDefinition): DataSourceSummary[] {
  return definition.dataSources.map(ds => ({
    id: ds.id,
    type: ds.type,
    schemaName: ds.schemaName,
    tableName: ds.columnObjectName,
    resourceUri: ds.resourceUri,
    isCalculationView: ds.type === 'CALCULATION_VIEW',
  }));
}

/**
 * 获取视图的节点链路（数据流）
 * 从数据源到输出的节点连接关系
 */
export interface NodeConnection {
  from: string;  // 源节点 ID
  to: string;    // 目标节点 ID
  mappings: ViewNodeMapping[];  // 字段映射
}

export function getNodeConnections(definition: ViewDefinition): NodeConnection[] {
  const connections: NodeConnection[] = [];

  for (const node of definition.nodes) {
    for (const input of node.inputs) {
      connections.push({
        from: input.node,
        to: node.id,
        mappings: input.mappings,
      });
    }
  }

  return connections;
}

/**
 * 从公式字符串中提取引用的字段
 * - 优先识别 SQL 双引号引用（"COLUMN_NAME"，ZDEMO008_CV001 的 ZDEMO_FLD_NEW 即如此）
 * - 剔除字符串字面量与关键字后，再匹配裸标识符（兼容无引号字段名的老视图）
 */
export function extractFormulaSourceColumns(formula: string | undefined): string[] {
  if (!formula) return [];
  const columns = new Set<string>();
  // 1. SQL 双引号引用 "COLUMN_NAME" —— 最明确的字段引用
  const quoted = /"((?:[^"\\]|\\.)*)"/g;
  let m: RegExpExecArray | null;
  while ((m = quoted.exec(formula)) !== null) {
    columns.add(m[1]);
  }
  // 2. 剔除双引号引用与单引号字符串字面量后，匹配裸标识符
  const withoutLiterals = formula
    .replace(/"(?:[^"\\]|\\.)*"/g, '')
    .replace(/'[^']*'/g, '');
  const bare = /\b([A-Z_][A-Z0-9_]*)\b/g;
  const SKIP = new Set(['CASE', 'WHEN', 'THEN', 'ELSE', 'END', 'AND', 'OR', 'NOT', 'NULL', 'TRUE', 'FALSE', 'IF', 'IN', 'IS']);
  while ((m = bare.exec(withoutLiterals)) !== null) {
    if (!SKIP.has(m[1])) columns.add(m[1]);
  }
  return [...columns];
}

/** 字段逻辑完整信息（ZDEMO008_CV001 的 ZDEMO_FLD_NEW 一类的计算字段） */
export interface FieldLogic {
  /** 字段基本信息 */
  field: {
    id: string;
    /** 业务描述（取自同 ID 输出字段；纯节点内计算列通常无描述） */
    description?: string;
    datatype?: string;
    length?: string;
    expressionLanguage?: string;
  };
  /** 公式原文（SQL / COLUMN_ENGINE，已解码 XML 实体） */
  formula?: string;
  /** SQLScript 源码（字段所在节点为 SqlScriptView 时，脚本即该字段的逻辑来源） */
  script?: string;
  /** 公式引用的源字段（形如 "ZDEMO_FLDM__ZDEMO_TYPE"） */
  sourceColumns: string[];
  /** 源字段溯源：公式所在节点输入映射中，各源字段来自哪个上游节点 */
  sourceTrace: FormulaSource[];
  /** 字段位置：输出(output) 或 某节点(node) */
  location: 'output' | 'node';
  /** 所属节点 ID（location=node 时有值） */
  nodeId?: string;
  /** 字段类型 */
  fieldType: 'attribute' | 'calculatedAttribute' | 'measure' | 'calculatedMeasure' | 'restrictedMeasure';
  /** 同名字段的所有出现位置（同一字段 ID 可能同时出现在输出与节点中） */
  occurrences: Array<{
    location: 'output' | 'node';
    nodeId?: string;
    fieldType: FieldMatch['fieldType'];
    hasFormula: boolean;
  }>;
  /**
   * 功能边界（解耦约定）：
   * - 字段的输出映射来源（节点.列）请查 hana_metadata_list_fields 的 source
   * - 视图的上游/下游依赖请查 hana_metadata_where_used
   * 本接口只回答"字段的逻辑"：公式/脚本、引用的源字段、溯源。
   */
}

/** 公式源字段溯源结果 */
export interface FormulaSource {
  /** 公式中引用的字段名 */
  column: string;
  /** 提供该字段的上游节点引用（如 #Join_10），节点输入映射无法解析时为 undefined */
  viaNode?: string;
  /** 上游节点中的源字段名 */
  source?: string;
}

/**
 * 解析单个字段的完整逻辑（ZDEMO008_CV001 示例优化核心）：
 * - 定位字段：输出字段 / 节点计算属性
 * - 同一字段 ID 多处出现时，优先带公式的匹配（节点计算属性 > 输出计算属性/度量 > 其他）
 * - 提取公式 + 引用的源字段（自动解析 "COLUMN" 引用）
 * - 公式源字段溯源到上游节点输入映射
 * - SqlScriptView 节点：返回脚本源码（script），公式字段为空
 * - 附带字段元数据（description 从同 ID 输出字段补齐 / datatype / length / expressionLanguage）
 * 功能边界：本接口只回答"字段逻辑"，不含输出映射来源（list_fields）与上游依赖（where_used）。
 */
export function getFieldLogic(definition: ViewDefinition, fieldId: string): FieldLogic | undefined {
  const matches = searchFields(definition, fieldId, { exact: true });
  if (matches.length === 0) return undefined;

  // 同一 ID 多处出现时优先带公式的匹配（节点计算属性 > 输出计算字段 > 任意带公式 > 首个）
  const withFormula = matches.filter((m) => m.field.formula);
  const pick =
    withFormula.find((m) => m.location === 'node' && m.fieldType === 'calculatedAttribute') ??
    withFormula.find((m) => m.fieldType === 'calculatedAttribute' || m.fieldType === 'calculatedMeasure') ??
    withFormula[0] ??
    matches[0];

  const formula = pick.field.formula;
  const sourceColumns = extractFormulaSourceColumns(formula);

  // 业务描述：pick 命中节点计算列时通常没有描述，从同 ID 输出字段补齐
  const pickDesc = 'description' in pick.field ? pick.field.description : undefined;
  const description =
    pickDesc ??
    matches
      .map((m) => ('description' in m.field ? (m.field as ViewOutputField).description : undefined))
      .find((d) => d);

  // SqlScriptView 节点：字段逻辑来自脚本。节点内计算列从所在节点取；
  // 输出字段经输出映射（keyMapping.columnObjectName）指向脚本节点。
  const outputField = matches.find((m) => m.location === 'output')?.field as ViewOutputField | undefined;
  const scriptNodeId = pick.nodeId ?? outputField?.sourceObject;
  const scriptNode = scriptNodeId ? definition.nodes.find((n) => n.id === scriptNodeId) : undefined;

  return {
    field: {
      id: pick.field.id,
      description,
      datatype: pick.field.datatype,
      length: pick.field.length,
      expressionLanguage: pick.field.expressionLanguage,
    },
    formula,
    script: scriptNode?.script,
    sourceColumns,
    sourceTrace: resolveFormulaSources(definition, pick, sourceColumns),
    location: pick.location,
    nodeId: pick.nodeId,
    fieldType: pick.fieldType,
    occurrences: matches.map((m) => ({
      location: m.location,
      nodeId: m.nodeId,
      fieldType: m.fieldType,
      hasFormula: !!m.field.formula,
    })),
  };
}

/** 把公式引用的源字段解析到上游节点（沿所在节点的输入映射） */
function resolveFormulaSources(
  definition: ViewDefinition,
  match: FieldMatch,
  sourceColumns: string[],
): FormulaSource[] {
  if (sourceColumns.length === 0 || match.location !== 'node' || !match.nodeId) return [];
  const node = definition.nodes.find((n) => n.id === match.nodeId);
  if (!node) return sourceColumns.map((column) => ({ column }));

  return sourceColumns.map((column) => {
    for (const input of node.inputs) {
      const m = input.mappings.find((mm) => mm.target === column);
      if (m) return { column, viaNode: input.node, source: m.source };
    }
    // 目标字段可能在节点自身的计算链上（未直接映射），标记为同节点
    return { column, viaNode: node.id, source: column };
  });
}

/**
 * 一键查询视图字段逻辑（ZDEMO008_CV001 示例的完整管线）：
 * 1. 查询 _SYS_REPO.ACTIVE_OBJECT 取视图 XML
 * 2. 解析为结构化 ViewDefinition
 * 3. 定位字段并返回其公式 / 源字段 / 元数据
 *
 * 等价于 tmp_zdemo_fld_new.cjs 的整段手写逻辑，但无需关心 XML 细节。
 */
export async function getViewFieldLogic(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  fieldId: string,
  opts: { kind?: ViewKind } = {},
): Promise<{ object: ViewDefinitionResult['object']; logic: FieldLogic }> {
  const result = await getViewDefinition(pool, packageId, objectName, { format: 'json', kind: opts.kind });
  if (!result.definition) {
    throw new HanaBusinessError(`视图 ${packageId}/${objectName} 无 CDATA，无法解析字段逻辑`);
  }
  const logic = getFieldLogic(result.definition, fieldId);
  if (!logic) {
    throw new HanaBusinessError(
      `视图 ${packageId}/${objectName} 中未找到字段 ${fieldId}。可先用 hana_metadata_list_fields 按名称片段模糊搜索确认字段 ID`,
    );
  }
  return { object: result.object, logic };
}

/** 字段清单条目（listFields / hana_metadata_list_fields 返回） */
export interface ViewFieldSummary {
  id: string;
  /** 业务描述（输出字段的中文名，如 "报表梯种整合-新"） */
  description?: string;
  fieldType: FieldMatch['fieldType'];
  location: 'output' | 'node';
  nodeId?: string;
  key?: boolean;
  aggregationType?: string;
  /** 输出字段的来源（节点.列，如 Join_12.ZDEMO_FLD_NEW） */
  source?: string;
  /** 是否带计算公式（带公式的字段可用 hana_metadata_get_field_logic 深挖逻辑） */
  hasFormula: boolean;
}

export interface ListFieldsResult {
  counts: {
    attributes: number;
    measures: number;
    calculatedMeasures: number;
    restrictedMeasures: number;
    nodeCalculatedAttributes: number;
    matched: number;
  };
  fields: ViewFieldSummary[];
}

/**
 * 视图字段清单（梳理字段 / 按名片段找字段）：
 * - 默认只列输出字段（视图对外暴露的字段）；includeNodeCalculated=true 时附节点内计算列
 * - pattern 省略/空串 = 全部字段；否则模糊匹配（exact=true 精确匹配）
 * - 不含节点树/映射细节，比 getViewDefinition 轻量得多
 */
export function listFields(
  definition: ViewDefinition,
  opts: { pattern?: string; exact?: boolean; caseSensitive?: boolean; includeNodeCalculated?: boolean } = {},
): ListFieldsResult {
  const o = definition.outputs;
  const counts: ListFieldsResult['counts'] = {
    attributes: o.attributes.length,
    measures: o.measures.length,
    calculatedMeasures: o.calculatedMeasures.length,
    restrictedMeasures: o.restrictedMeasures.length,
    nodeCalculatedAttributes: definition.nodes.reduce((n, node) => n + node.calculatedAttributes.length, 0),
    matched: 0,
  };

  const matches = searchFields(definition, opts.pattern ?? '', {
    caseSensitive: opts.caseSensitive,
    exact: opts.exact,
  });
  const fields: ViewFieldSummary[] = [];
  for (const m of matches) {
    if (m.location === 'node' && !opts.includeNodeCalculated) continue;
    const f = m.field;
    const of = f as ViewOutputField;
    const hasMapping = 'sourceObject' in f && 'sourceColumn' in f;
    fields.push({
      id: f.id,
      description: 'description' in f ? of.description : undefined,
      fieldType: m.fieldType,
      location: m.location,
      nodeId: m.nodeId,
      key: 'key' in f ? of.key : undefined,
      aggregationType: 'aggregationType' in f ? of.aggregationType : undefined,
      source: hasMapping && of.sourceObject && of.sourceColumn ? `${of.sourceObject}.${of.sourceColumn}` : undefined,
      hasFormula: !!f.formula,
    });
  }
  counts.matched = fields.length;
  return { counts, fields };
}

/** 一键查询视图字段清单（取 XML → 解析 → listFields） */
export async function getViewFieldList(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: { kind?: ViewKind; pattern?: string; exact?: boolean; caseSensitive?: boolean; includeNodeCalculated?: boolean } = {},
): Promise<{ object: ViewDefinitionResult['object']; list: ListFieldsResult }> {
  const result = await getViewDefinition(pool, packageId, objectName, { format: 'json', kind: opts.kind });
  if (!result.definition) {
    throw new HanaBusinessError(`视图 ${packageId}/${objectName} 无 CDATA，无法解析字段清单`);
  }
  return { object: result.object, list: listFields(result.definition, opts) };
}

/** 仓库对象搜索结果条目（ACTIVE_OBJECT 命中行） */
export interface ObjectSearchItem {
  packageId: string;
  objectName: string;
  objectSuffix: string;
  versionId: number;
  activatedAt?: string;
  activatedBy?: string;
}

export interface ObjectSearchResult {
  /** 总命中数（LIMIT 之前） */
  count: number;
  /** 本次返回上限 */
  limit: number;
  /** count > limit 时为 true（按截断约定提示 refine query） */
  truncated: boolean;
  objects: ObjectSearchItem[];
}

/**
 * 按名称片段搜索仓库对象（视图定位用）：
 * - 来源：_SYS_REPO.ACTIVE_OBJECT，按 OBJECT_NAME 模糊匹配（UPPER 大小写不敏感）
 * - 默认只搜三种视图类型（calculationview/attributeview/analyticview），排除 UI5 仓库资源
 * - kind 指定时只搜该类型；带截断（LIMIT）+ count，供 "Showing N of M" 提示
 * 典型用途：hana_metadata_list_fields 报"未找到视图"时，先用本工具按片段定位包名/对象名。
 */
export async function searchObjects(
  pool: HanaPool,
  opts: { pattern: string; kind?: ViewKind; limit?: number } = { pattern: '' },
): Promise<ObjectSearchResult> {
  const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
  const suffixes = opts.kind ? [VIEW_SUFFIXES[opts.kind]] : Object.values(VIEW_SUFFIXES);
  const suffixIn = `(${suffixes.map(() => '?').join(',')})`;
  // 值一律参数绑定；pattern 仅作为 LIKE 片段，UPPER 两侧做大小写不敏感匹配
  const countRow = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM "_SYS_REPO"."ACTIVE_OBJECT"
     WHERE UPPER(OBJECT_NAME) LIKE UPPER(?) AND OBJECT_SUFFIX IN ${suffixIn}`,
    [`%${opts.pattern}%`, ...suffixes],
  );
  const count = countRow[0]?.C ?? 0;
  const rows = await pool.query<{
    PACKAGE_ID: string;
    OBJECT_NAME: string;
    OBJECT_SUFFIX: string;
    VERSION_ID: number;
    ACTIVATED_AT: string | null;
    ACTIVATED_BY: string | null;
  }>(
    `SELECT PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, VERSION_ID, ACTIVATED_AT, ACTIVATED_BY
     FROM "_SYS_REPO"."ACTIVE_OBJECT"
     WHERE UPPER(OBJECT_NAME) LIKE UPPER(?) AND OBJECT_SUFFIX IN ${suffixIn}
     ORDER BY PACKAGE_ID, OBJECT_NAME LIMIT ?`,
    [`%${opts.pattern}%`, ...suffixes, limit],
  );
  return {
    count,
    limit,
    truncated: count > limit,
    objects: rows.map((r) => ({
      packageId: r.PACKAGE_ID,
      objectName: r.OBJECT_NAME,
      objectSuffix: r.OBJECT_SUFFIX,
      versionId: r.VERSION_ID,
      activatedAt: r.ACTIVATED_AT ?? undefined,
      activatedBy: r.ACTIVATED_BY ?? undefined,
    })),
  };
}

/** 包清单条目（_SYS_REPO.PACKAGE_CATALOG） */
export interface PackageItem {
  packageId: string;
  responsible?: string;
  origLang?: string;
  deliveryUnit?: string;
  /** 包层级深度（0 = 顶层包；每多一级 . 加 1） */
  level: number;
}

export interface PackageListResult {
  /** 总命中数（LIMIT 之前） */
  count: number;
  /** 本次返回上限 */
  limit: number;
  /** count > limit 时为 true（按截断约定提示 refine query） */
  truncated: boolean;
  packages: PackageItem[];
}

/**
 * 包清单/包树：来源 _SYS_REPO.PACKAGE_CATALOG（PACKAGE_ID 为 . 分隔的完整路径）。
 * - pattern 按包路径片段模糊过滤（大小写不敏感）；返回 level（层级深度）供客户端组树
 * - 带截断（LIMIT）+ count，供 "Showing N of M" 提示
 */
export async function listPackages(
  pool: HanaPool,
  opts: { pattern?: string; limit?: number } = {},
): Promise<PackageListResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const pattern = opts.pattern?.trim();
  const where = pattern ? 'WHERE UPPER(PACKAGE_ID) LIKE UPPER(?)' : '';
  const likeParams: string[] = pattern ? [`%${pattern}%`] : [];

  const countRow = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM "_SYS_REPO"."PACKAGE_CATALOG" ${where}`,
    likeParams,
  );
  const count = countRow[0]?.C ?? 0;
  const rows = await pool.query<{
    PACKAGE_ID: string;
    RESPONSIBLE: string | null;
    ORIG_LANG: string | null;
    DELIVERY_UNIT: string | null;
  }>(
    `SELECT PACKAGE_ID, RESPONSIBLE, ORIG_LANG, DELIVERY_UNIT
     FROM "_SYS_REPO"."PACKAGE_CATALOG" ${where}
     ORDER BY PACKAGE_ID LIMIT ?`,
    [...likeParams, limit],
  );
  return {
    count,
    limit,
    truncated: count > limit,
    packages: rows.map((r) => ({
      packageId: r.PACKAGE_ID,
      responsible: r.RESPONSIBLE ?? undefined,
      origLang: r.ORIG_LANG ?? undefined,
      deliveryUnit: r.DELIVERY_UNIT ?? undefined,
      level: r.PACKAGE_ID.split('.').length - 1,
    })),
  };
}

/** 包内对象条目（ACTIVE_OBJECT / INACTIVE_OBJECT 合并） */
export interface PackageObjectItem {
  packageId: string;
  objectName: string;
  objectSuffix: string;
  /** 对象状态：active=已激活（ACTIVE_OBJECT）；inactive=未激活/变更中（INACTIVE_OBJECT） */
  status: 'active' | 'inactive';
  versionId: number;
  /** active=ACTIVATED_AT；inactive=LAST_CHANGED_AT */
  changedAt?: string;
  /** active=ACTIVATED_BY；inactive=OWNER */
  changedBy?: string;
}

export interface PackageObjectsResult {
  packageId: string;
  /** 总命中数（LIMIT 之前，active + inactive） */
  count: number;
  /** 本次返回上限 */
  limit: number;
  /** count > limit 时为 true */
  truncated: boolean;
  objects: PackageObjectItem[];
}

/**
 * 包内对象清单：合并 _SYS_REPO.ACTIVE_OBJECT（已激活）与 INACTIVE_OBJECT（未激活）。
 * - kind 省略时返回该包全部对象类型；kind 指定时只返回该视图类型
 * - pattern 按对象名片段模糊过滤（大小写不敏感）；带截断 + count
 */
export async function listPackageObjects(
  pool: HanaPool,
  packageId: string,
  opts: { pattern?: string; kind?: ViewKind; limit?: number } = {},
): Promise<PackageObjectsResult> {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const pattern = opts.pattern?.trim();
  const suffixes = opts.kind ? [VIEW_SUFFIXES[opts.kind]] : null;
  const suffixIn = suffixes ? `(${suffixes.map(() => '?').join(',')})` : null;
  const clauses = ['PACKAGE_ID = ?'];
  const params: Array<string | number> = [packageId];
  if (suffixIn) {
    clauses.push(`OBJECT_SUFFIX IN ${suffixIn}`);
    params.push(...suffixes!);
  }
  if (pattern) {
    clauses.push('UPPER(OBJECT_NAME) LIKE UPPER(?)');
    params.push(`%${pattern}%`);
  }
  const where = `WHERE ${clauses.join(' AND ')}`;

  const [activeCount, inactiveCount, activeRows, inactiveRows] = await Promise.all([
    pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM "_SYS_REPO"."ACTIVE_OBJECT" ${where}`,
      params,
    ),
    pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM "_SYS_REPO"."INACTIVE_OBJECT" ${where}`,
      params,
    ),
    pool.query<{
      PACKAGE_ID: string;
      OBJECT_NAME: string;
      OBJECT_SUFFIX: string;
      VERSION_ID: number;
      ACTIVATED_AT: string | null;
      ACTIVATED_BY: string | null;
    }>(
      `SELECT PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, VERSION_ID, ACTIVATED_AT, ACTIVATED_BY
       FROM "_SYS_REPO"."ACTIVE_OBJECT" ${where}
       ORDER BY OBJECT_NAME LIMIT ?`,
      [...params, limit],
    ),
    pool.query<{
      PACKAGE_ID: string;
      OBJECT_NAME: string;
      OBJECT_SUFFIX: string;
      VERSION_ID: number;
      LAST_CHANGED_AT: string | null;
      OWNER: string | null;
    }>(
      `SELECT PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, VERSION_ID, LAST_CHANGED_AT, OWNER
       FROM "_SYS_REPO"."INACTIVE_OBJECT" ${where}
       ORDER BY OBJECT_NAME LIMIT ?`,
      [...params, limit],
    ),
  ]);

  const all: PackageObjectItem[] = [
    ...activeRows.map<PackageObjectItem>((r) => ({
      packageId: r.PACKAGE_ID,
      objectName: r.OBJECT_NAME,
      objectSuffix: r.OBJECT_SUFFIX,
      status: 'active',
      versionId: r.VERSION_ID,
      changedAt: r.ACTIVATED_AT ?? undefined,
      changedBy: r.ACTIVATED_BY ?? undefined,
    })),
    ...inactiveRows.map<PackageObjectItem>((r) => ({
      packageId: r.PACKAGE_ID,
      objectName: r.OBJECT_NAME,
      objectSuffix: r.OBJECT_SUFFIX,
      status: 'inactive',
      versionId: r.VERSION_ID,
      changedAt: r.LAST_CHANGED_AT ?? undefined,
      changedBy: r.OWNER ?? undefined,
    })),
  ];
  // 排序：已激活优先，同名按类型，稳定可读
  all.sort((a, b) => {
    if (a.status !== b.status) return a.status === 'active' ? -1 : 1;
    if (a.objectName !== b.objectName) return a.objectName < b.objectName ? -1 : 1;
    return a.objectSuffix < b.objectSuffix ? -1 : 1;
  });

  const count = (activeCount[0]?.C ?? 0) + (inactiveCount[0]?.C ?? 0);
  return {
    packageId,
    count,
    limit,
    truncated: count > limit,
    objects: all.slice(0, limit),
  };
}