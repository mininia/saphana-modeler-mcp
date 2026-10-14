import type { HanaPool } from '../core/hana-client.js';
import { closure } from './catalog.service.js';
import { nowIso } from '../core/datetime.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import { parseResourceUri } from './preview.derive.js';
import { HanaBusinessError } from '../core/errors.js';
import { clampLimit } from '../core/num.js';
import { assertSafeRuntimeName, assertSchemaAllowed, quoteIdentifier } from '../core/sql.js';
import { suffixInClause, suffixesOf, VIEW_SUFFIXES } from '../model/view-suffixes.js';
import { parseViewDefinition } from '../model/view-xml.js';
import type {
  ViewCalculatedAttribute,
  ViewDefinition,
  ViewKind,
  ViewOutputField,
  ViewOutputs,
} from '../model/view-types.js';

/**
 * 只读元数据通道（实测结论）：
 * - 视图定义：_SYS_REPO.ACTIVE_OBJECT（CDATA 设计时 XML）
 * - 表列表：SYS.TABLES（按当前用户权限过滤）
 * - 表列：SYS.TABLE_COLUMNS（SYS.COLUMNS 对该环境用户 258 不可用）
 */

/**
 * 视图后缀的取值集合、按 kind 推导与 `IN (?,…)` 占位符拼装的唯一实现位于 `model/view-suffixes`
 * （叶子模块）：catalog.service 不能引用本模块——本模块依赖它导出的 closure，反向 import 会形成
 * 循环依赖，只有不依赖任何一方的模块才能被两侧共用。这里转出三个符号以保持本模块既有 import 面，
 * view-cache / preview-diagnose / repository.service 仍自本模块引用同一实现。
 */
export { suffixInClause, suffixesOf, VIEW_SUFFIXES } from '../model/view-suffixes.js';

/**
 * 「命中总数 + 本次上限 + 截断标记」的通用分页外壳。
 * K 为条目数组的对外字段名（objects/packages 等）：历史契约字段名不同，不能统一改名，
 * 故这里只统一分页三件套与条目类型的拼装方式（见 runPaged）。
 */
export type PagedResult<T, K extends string = 'items'> = {
  /** LIMIT 之前的命中总数 */
  count: number;
  /** 本次返回上限 */
  limit: number;
  /** count > limit 时为 true（按截断约定提示 refine query） */
  truncated: boolean;
} & Record<K, T[]>;

/**
 * 分页查询的唯一装配点：并发执行「计数」与「取数」两条查询，统一产出
 * count/limit/truncated 与截断后的条目 —— 截断判定与结果拼装不再各处手写。
 */
async function runPaged<T, K extends string>(
  key: K,
  limit: number,
  fetchers: { count: () => Promise<number>; items: () => Promise<T[]> },
): Promise<PagedResult<T, K>> {
  const [count, items] = await Promise.all([fetchers.count(), fetchers.items()]);
  return { count, limit, truncated: count > limit, [key]: items.slice(0, limit) } as PagedResult<T, K>;
}

export interface ViewDefinitionResult {
  /** 仓库对象信息 */
  object: {
    packageId: string;
    objectName: string;
    objectSuffix: string;
    versionId: number;
    activatedAt?: string;
    activatedBy?: string;
  };
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
  const suffixes = suffixesOf(opts.kind);
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
     WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN ${suffixInClause(suffixes)}
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
    try {
      result.definition = parseViewDefinition(row.CDATA, row.OBJECT_SUFFIX as ViewKind);
    } catch (e) {
      // 裸 Error 会被 withErrorEnvelope 归入笼统「内部错误」——带上包/对象/版本与解析器原因，
      // 让调用方（含 fieldLineage 的下游候选扫描）能直接定位到是哪个视图的 CDATA 解析失败
      throw new HanaBusinessError(
        `视图 ${row.PACKAGE_ID}/${row.OBJECT_NAME}（v${row.VERSION_ID}）设计时 XML 解析失败：` +
          `${e instanceof Error ? e.message : String(e)}`,
        'CDATA_PARSE_FAILED',
      );
    }
  }
  return result;
}

export interface TableInfo {
  schemaName: string;
  tableName: string;
  tableType: string;
  comments?: string | null;
}

export type TableListResult = PagedResult<TableInfo, 'tables'>;

/** 表列表（SYS.TABLES 按当前用户权限过滤；schema 默认当前 schema）；回执带 count/limit/truncated，超 limit 不静默截断 */
export async function listTables(
  pool: HanaPool,
  opts: { schema?: string; pattern?: string; limit?: number } = {},
): Promise<TableListResult> {
  const limit = clampLimit(opts.limit, 50, 1, 200);
  const schema = opts.schema ?? (await currentSchema(pool));
  // 纵深防御：显式传入的 schema 走白名单（系统 schema + HANA_READ_SCHEMA 追加），
  // 防任意 schema 枚举；默认当前 schema 已由数据库权限约束
  if (opts.schema) assertSchemaAllowed(opts.schema);
  const where = ['SCHEMA_NAME = ?'];
  const params: Array<string | number> = [schema];
  if (opts.pattern) {
    where.push('TABLE_NAME LIKE ?');
    params.push(`%${opts.pattern}%`);
  }
  const whereSql = where.join(' AND ');
  return runPaged('tables', limit, {
    count: async () => {
      const countRow = await pool.query<{ C: number }>(
        `SELECT COUNT(*) AS C FROM SYS.TABLES WHERE ${whereSql}`,
        params,
      );
      return countRow[0]?.C ?? 0;
    },
    items: async () => {
      const rows = await pool.query<{
        SCHEMA_NAME: string;
        TABLE_NAME: string;
        TABLE_TYPE: string;
        COMMENTS: string | null;
      }>(
        `SELECT SCHEMA_NAME, TABLE_NAME, TABLE_TYPE, COMMENTS FROM SYS.TABLES
         WHERE ${whereSql} ORDER BY TABLE_NAME LIMIT ?`,
        [...params, limit],
      );
      return rows.map((r) => ({
        schemaName: r.SCHEMA_NAME,
        tableName: r.TABLE_NAME,
        tableType: r.TABLE_TYPE,
        comments: r.COMMENTS,
      }));
    },
  });
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

export type TableColumnsResult = PagedResult<ColumnInfo, 'columns'>;

/** getTableColumns 的列数上限（clampLimit 的 hi）；回执 truncated 与 repository.service 的自动取列共用同一数值（单点定义） */
export const TABLE_COLUMNS_LIMIT_MAX = 500;

/** 表列结构（SYS.TABLE_COLUMNS）；回执带 count/limit/truncated，超 limit 不静默截断 */
export async function getTableColumns(
  pool: HanaPool,
  schema: string,
  table: string,
  opts: { limit?: number } = {},
): Promise<TableColumnsResult> {
  const limit = clampLimit(opts.limit, 200, 1, TABLE_COLUMNS_LIMIT_MAX);
  // 纵深防御：schema 走白名单、表名做字符集校验（值仍参数绑定，此为第二道防线）
  assertSchemaAllowed(schema);
  assertSafeRuntimeName(table, '表');
  const page = await runPaged('columns', limit, {
    count: async () => {
      const countRow = await pool.query<{ C: number }>(
        `SELECT COUNT(*) AS C FROM SYS.TABLE_COLUMNS WHERE SCHEMA_NAME = ? AND TABLE_NAME = ?`,
        [schema, table],
      );
      return countRow[0]?.C ?? 0;
    },
    items: async () => {
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
    },
  });
  if (page.columns.length === 0) {
    // 必须是 HanaBusinessError：裸 Error 会被 withErrorEnvelope 归入「内部错误」，
    // 「表不存在 / 无权限」这类**调用方可据以修正**（换 schema、换表名）的原因会被吞掉。
    throw new HanaBusinessError(
      `未找到表 ${schema}/${table}（或当前用户无权限）。可用 hana_table_list 确认 schema 下可访问的表`,
      'TABLE_NOT_FOUND',
    );
  }
  return page;
}

/**
 * 当前会话的默认 schema（`SELECT CURRENT_SCHEMA FROM DUMMY`）。
 * 导出供 repository.service 的脚本读取范围校验复用：未限定 schema 的表名按当前 schema 解析，
 * 两处各查一次会让同一条规则出现两个实现，故读法只此一份。
 */
export async function currentSchema(pool: HanaPool): Promise<string> {
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
  /** 该对象依赖的对象（上游，被引用方）——**depth=1 的单跳结果**（兼容字段，形状不变） */
  upstream: CrossRefItem[];
  /** 依赖该对象的对象（下游，引用方）——**depth=1 的单跳结果**（兼容字段，形状不变） */
  downstream: CrossRefItem[];
  /** depth>1 时追加：按方向拆分的闭包成员（不含种子；已去重、已排序） */
  closure?: { upstream: CrossRefItem[]; downstream: CrossRefItem[] };
  /** 实际完整展开的层数（仅 depth>1） */
  depthReached?: number;
  /** 触达 maxNodes 上限被截断（仅 depth>1；不静默丢） */
  truncated?: boolean;
  /** 本次遍历的构建时刻（仅 depth>1；进程时区 ISO） */
  asOf?: string;
}

/**
 * 血缘搜索（ACTIVE_OBJECTCROSSREF）：
 * - upstream：该对象引用了谁（FROM = 本对象）
 * - downstream：谁引用了该对象（TO = 本对象）
 * kind 省略时匹配三种视图类型。
 * 说明：downstream 中 isRuntime=true 表示激活后的运行时目录视图（_SYS_BIC）对本仓库对象的引用。
 *
 * `depth`（跳数，默认 1 = 单跳，upstream/downstream 两个兼容字段的形状不变）——depth>1 时在
 * 单跳结果之外追加 `closure`（多跳闭包，按方向拆分；visited-set 环防护；maxNodes 截断并置
 * truncated）；`asOf` 为构建时刻。
 */
export async function whereUsed(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: {
    kind?: ViewKind;
    direction?: 'upstream' | 'downstream' | 'both';
    depth?: number | 'all';
    maxNodes?: number;
  } = {},
): Promise<WhereUsedResult> {
  const suffixes = suffixesOf(opts.kind);
  const suffixIn = suffixInClause(suffixes);
  const direction = opts.direction ?? 'both';
  const depth = opts.depth ?? 1;

  const mapRow = (r: {
    PACKAGE_ID: string;
    OBJECT_NAME: string;
    OBJECT_SUFFIX: string;
    REF_TYPE: number;
  }): CrossRefItem => ({
    packageId: r.PACKAGE_ID,
    objectName: r.OBJECT_NAME,
    objectSuffix: r.OBJECT_SUFFIX,
    refType: r.REF_TYPE,
    // 运行时目录引用（__RT_CATALOG_VIEW__ / __RT_CATALOG_TABLE__ 等）
    isRuntime: r.OBJECT_SUFFIX.startsWith('__RT_'),
  });

  const upstream =
    direction === 'both' || direction === 'upstream'
      ? await pool.query<{ PACKAGE_ID: string; OBJECT_NAME: string; OBJECT_SUFFIX: string; REF_TYPE: number }>(
          `SELECT TO_PACKAGE_ID AS PACKAGE_ID, TO_OBJECT_NAME AS OBJECT_NAME, TO_OBJECT_SUFFIX AS OBJECT_SUFFIX, REF_TYPE
         FROM "_SYS_REPO"."ACTIVE_OBJECTCROSSREF"
         WHERE FROM_PACKAGE_ID = ? AND FROM_OBJECT_NAME = ? AND FROM_OBJECT_SUFFIX IN ${suffixIn}
         ORDER BY TO_OBJECT_SUFFIX, TO_OBJECT_NAME`,
          [packageId, objectName, ...suffixes],
        )
      : [];
  const downstream =
    direction === 'both' || direction === 'downstream'
      ? await pool.query<{ PACKAGE_ID: string; OBJECT_NAME: string; OBJECT_SUFFIX: string; REF_TYPE: number }>(
          `SELECT FROM_PACKAGE_ID AS PACKAGE_ID, FROM_OBJECT_NAME AS OBJECT_NAME, FROM_OBJECT_SUFFIX AS OBJECT_SUFFIX, REF_TYPE
         FROM "_SYS_REPO"."ACTIVE_OBJECTCROSSREF"
         WHERE TO_PACKAGE_ID = ? AND TO_OBJECT_NAME = ? AND TO_OBJECT_SUFFIX IN ${suffixIn}
         ORDER BY FROM_OBJECT_SUFFIX, FROM_OBJECT_NAME`,
          [packageId, objectName, ...suffixes],
        )
      : [];

  // 种子真实后缀：VIEW_SUFFIXES 是**全等映射**——kind 给定时它本身就是真实值；
  // 省略 kind 时补一次轻量查询；对象不存在时回退 '?'（不额外抛错，回执与闭包遍历都用该种子）。
  let seedSuffix = opts.kind ?? '?';
  if (!opts.kind) {
    const seedRows = await pool.query<{ OBJECT_SUFFIX: string }>(
      `SELECT OBJECT_SUFFIX FROM "_SYS_REPO"."ACTIVE_OBJECT"
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN ${suffixIn}
       ORDER BY VERSION_ID DESC LIMIT 1`,
      [packageId, objectName, ...suffixes],
    );
    seedSuffix = seedRows[0]?.OBJECT_SUFFIX ?? '?';
  }

  const result: WhereUsedResult = {
    object: { packageId, objectName, objectSuffix: seedSuffix },
    upstream: upstream.map(mapRow),
    downstream: downstream.map(mapRow),
  };

  if (depth !== 1) {
    const c = await closure(
      pool,
      { packageId, objectName, objectSuffix: seedSuffix },
      { direction, depth, ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}) },
    );
    const toItem = (e: (typeof c.nodes)[number]): CrossRefItem => ({
      packageId: e.packageId,
      objectName: e.objectName,
      objectSuffix: e.objectSuffix,
      refType: e.refType,
      isRuntime: e.isRuntime,
    });
    result.closure = {
      upstream: c.nodes.filter((n) => n.via === 'upstream').map(toItem),
      downstream: c.nodes.filter((n) => n.via === 'downstream').map(toItem),
    };
    result.depthReached = c.depthReached;
    result.truncated = c.truncated;
    result.asOf = c.asOf;
  }

  return result;
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
 * 从公式字符串中提取引用的字段
 * - 优先识别 SQL 双引号引用（"COLUMN_NAME"，ZDEMO008_CV001 的 ZDEMO_FLD_NEW 即如此）
 * - 剔除字符串字面量、SQL 关键字、函数调用名与 CAST 类型名后，再匹配裸标识符（兼容无引号字段名的老视图）：
 *   裸标识符与函数/类型名同形（SUM/CAST/DECIMAL…），只按有限的关键字黑名单过滤会把它们当源字段 ——
 *   实测 `SUM("AMOUNT")+CAST("QTY" AS DECIMAL)` 会被解析出 SUM/CAST/AS/DECIMAL 等假源字段。
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
  const withoutLiterals = formula.replace(/"(?:[^"\\]|\\.)*"/g, '').replace(/'[^']*'/g, '');
  const SKIP = new Set([
    'CASE',
    'WHEN',
    'THEN',
    'ELSE',
    'END',
    'AND',
    'OR',
    'NOT',
    'NULL',
    'TRUE',
    'FALSE',
    'IF',
    'IN',
    'IS',
    // 公式中常见的其它关键字（CAST 的 AS、BETWEEN/LIKE/DISTINCT/窗口函数/子查询等）
    'AS',
    'BETWEEN',
    'LIKE',
    'ESCAPE',
    'DISTINCT',
    'OVER',
    'PARTITION',
    'BY',
    'ORDER',
    'ASC',
    'DESC',
    'SELECT',
    'FROM',
    'WHERE',
    'GROUP',
    'HAVING',
    'UNION',
    'ALL',
    'EXISTS',
  ]);
  // 2a. 函数调用名：标识符后紧跟 ( 即为函数（SUM/CAST/COALESCE/TO_DECIMAL/自定义 UDF…），不是源字段
  const callNames = new Set<string>();
  const call = /\b([A-Z_][A-Z0-9_]*)\s*(?=\()/g;
  while ((m = call.exec(withoutLiterals)) !== null) {
    callNames.add(m[1]);
  }
  // 2b. 裸标识符；CAST(x AS <类型名>) 的类型名位置由 isCastTypeName 单独剔除
  const bare = /\b([A-Z_][A-Z0-9_]*)\b/g;
  while ((m = bare.exec(withoutLiterals)) !== null) {
    const name = m[1];
    if (SKIP.has(name) || callNames.has(name) || isCastTypeName(withoutLiterals, m.index)) continue;
    columns.add(name);
  }
  return [...columns];
}

/** 裸标识符是否处于 CAST(x AS <类型名>) 的类型位置（前一个非空白 token 是 AS，大小写不敏感） */
function isCastTypeName(text: string, index: number): boolean {
  return /(?:^|\W)AS$/i.test(text.slice(0, index).trimEnd());
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
 * 取视图定义并断言设计时 XML 存在——「无 CDATA」的失败口径只此一份。
 * purpose 说明调用方拿 XML 做什么（字段逻辑/字段清单），让报错保留操作语境。
 */
async function loadDesignTimeDefinition(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  purpose: string,
  opts: { kind?: ViewKind } = {},
): Promise<{ object: ViewDefinitionResult['object']; definition: ViewDefinition }> {
  const result = await getViewDefinition(pool, packageId, objectName, { format: 'json', kind: opts.kind });
  if (!result.definition) {
    throw new HanaBusinessError(`视图 ${packageId}/${objectName} 无 CDATA，${purpose}`);
  }
  return { object: result.object, definition: result.definition };
}

/**
 * 「取定义 → 判 CDATA → 取字段逻辑 → 未找到抛错」的唯一装配点：
 * hana_metadata_get_field_logic 与 fieldLineage（upstream 方向）共用，同一失败场景不再有两套文案。
 */
async function requireFieldLogic(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  fieldId: string,
  opts: { kind?: ViewKind } = {},
): Promise<{ object: ViewDefinitionResult['object']; logic: FieldLogic }> {
  const { object, definition } = await loadDesignTimeDefinition(pool, packageId, objectName, '无法解析字段逻辑', opts);
  const logic = getFieldLogic(definition, fieldId);
  if (!logic) {
    throw new HanaBusinessError(
      `视图 ${packageId}/${objectName} 中未找到字段 ${fieldId}。可先用 hana_metadata_list_fields 按名称片段模糊搜索确认字段 ID`,
    );
  }
  return { object, logic };
}

/**
 * 一键查询视图字段逻辑：取设计时 XML → 解析为结构化 ViewDefinition → 定位字段并返回
 * 其公式 / 源字段 / 元数据。调用方只给包/对象/字段 ID，XML 细节由本模块承担。
 */
export async function getViewFieldLogic(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  fieldId: string,
  opts: { kind?: ViewKind } = {},
): Promise<{ object: ViewDefinitionResult['object']; logic: FieldLogic }> {
  return requireFieldLogic(pool, packageId, objectName, fieldId, opts);
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
  opts: {
    kind?: ViewKind;
    pattern?: string;
    exact?: boolean;
    caseSensitive?: boolean;
    includeNodeCalculated?: boolean;
  } = {},
): Promise<{ object: ViewDefinitionResult['object']; list: ListFieldsResult }> {
  const { object, definition } = await loadDesignTimeDefinition(pool, packageId, objectName, '无法解析字段清单', {
    kind: opts.kind,
  });
  return { object, list: listFields(definition, opts) };
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

export type ObjectSearchResult = PagedResult<ObjectSearchItem, 'objects'>;

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
  const limit = clampLimit(opts.limit, 20, 1, 100);
  const suffixes = suffixesOf(opts.kind);
  const suffixIn = suffixInClause(suffixes);
  return runPaged('objects', limit, {
    // 值一律参数绑定；pattern 仅作为 LIKE 片段，UPPER 两侧做大小写不敏感匹配
    count: async () => {
      const countRow = await pool.query<{ C: number }>(
        `SELECT COUNT(*) AS C FROM "_SYS_REPO"."ACTIVE_OBJECT"
         WHERE UPPER(OBJECT_NAME) LIKE UPPER(?) AND OBJECT_SUFFIX IN ${suffixIn}`,
        [`%${opts.pattern}%`, ...suffixes],
      );
      return countRow[0]?.C ?? 0;
    },
    items: async () => {
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
      return rows.map((r) => ({
        packageId: r.PACKAGE_ID,
        objectName: r.OBJECT_NAME,
        objectSuffix: r.OBJECT_SUFFIX,
        versionId: r.VERSION_ID,
        activatedAt: r.ACTIVATED_AT ?? undefined,
        activatedBy: r.ACTIVATED_BY ?? undefined,
      }));
    },
  });
}

/** by=field 搜索的字段命中条目 */
export interface FieldSearchMatch {
  fieldId: string;
  location: 'output' | 'node';
  nodeId?: string;
  fieldType: FieldMatch['fieldType'];
}

/** by=field 搜索的视图条目 */
export interface FieldSearchItem {
  packageId: string;
  objectName: string;
  objectSuffix: string;
  versionId: number;
  activatedAt?: string;
  activatedBy?: string;
  matchedFields: FieldSearchMatch[];
}

/**
 * by=field 搜索的回执。**口径（诚实性）**：
 * - `count` = **本次扫到的命中视图数**（不是全库总数——字段级没有索引，无法只靠 COUNT 求出）；
 * - `truncated` = 命中结果达到 `limit` **或** 候选被 `maxCandidates` 截断（两者任一都置真）；
 * - `candidatesScanned/maxCandidates` 明示候选口径，调用方可据此调 `pattern` 收窄。
 */
export interface FieldSearchResult {
  count: number;
  limit: number;
  truncated: boolean;
  candidatesScanned: number;
  maxCandidates: number;
  asOf: string;
  objects: FieldSearchItem[];
}

/** by=field 的候选上限默认值（解析成本护栏：每个候选都要 parse 设计时 XML） */
const DEFAULT_MAX_FIELD_CANDIDATES = 100;

/**
 * 按字段搜索视图："谁的输出里含匹配字段"。
 * 实现口径：对候选视图**按需 parse** 设计时 XML（不做全量索引——候选逐个解析，成本由
 * maxCandidates 护栏），复用 `searchFields`（= list_fields 的同一实现）。
 * 候选集 = `ACTIVE_OBJECT` 按 kind 过滤（可选 `pattern` 收窄对象名），
 * 按 (PACKAGE_ID, OBJECT_NAME) 排序取前 `maxCandidates` 条。
 */
export async function searchObjectsByField(
  pool: HanaPool,
  opts: { field: string; pattern?: string; kind?: ViewKind; limit?: number; maxCandidates?: number },
): Promise<FieldSearchResult> {
  const limit = clampLimit(opts.limit, 20, 1, 100);
  const maxCandidates = clampLimit(opts.maxCandidates, DEFAULT_MAX_FIELD_CANDIDATES, 1, 500);
  const suffixes = suffixesOf(opts.kind);
  const suffixIn = suffixInClause(suffixes);
  const nameFilter = opts.pattern ? 'AND UPPER(OBJECT_NAME) LIKE UPPER(?)' : '';

  const rows = await pool.query<{
    PACKAGE_ID: string;
    OBJECT_NAME: string;
    OBJECT_SUFFIX: string;
    VERSION_ID: number;
    ACTIVATED_AT: string | null;
    ACTIVATED_BY: string | null;
    CDATA: string | null;
  }>(
    `SELECT PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, VERSION_ID, ACTIVATED_AT, ACTIVATED_BY, CDATA
     FROM "_SYS_REPO"."ACTIVE_OBJECT"
     WHERE OBJECT_SUFFIX IN ${suffixIn} ${nameFilter}
     ORDER BY PACKAGE_ID, OBJECT_NAME LIMIT ?`,
    // 参数顺序必须与占位符一致：IN (…) → LIKE ?（nameFilter）→ LIMIT ?；
    // 错位（pattern 排到 suffixes 前）会让 pattern 值去比 OBJECT_SUFFIX、把某个 suffix 当成 LIKE 模式 → 候选恒空
    opts.pattern ? [...suffixes, `%${opts.pattern}%`, maxCandidates] : [...suffixes, maxCandidates],
  );

  const objects: FieldSearchItem[] = [];
  for (const r of rows) {
    const cdata = typeof r.CDATA === 'string' ? r.CDATA : '';
    if (!cdata) continue; // 无设计时 XML → 无可解析的字段面，跳过
    let def: ViewDefinition;
    try {
      def = parseViewDefinition(cdata, r.OBJECT_SUFFIX as ViewKind);
    } catch {
      continue; // 宽容：单个候选解析失败不拖垮整次搜索（与 fieldLineage 的下游扫描同策略）
    }
    const matches = searchFields(def, opts.field);
    if (matches.length === 0) continue;
    objects.push({
      packageId: r.PACKAGE_ID,
      objectName: r.OBJECT_NAME,
      objectSuffix: r.OBJECT_SUFFIX,
      versionId: r.VERSION_ID,
      activatedAt: r.ACTIVATED_AT ?? undefined,
      activatedBy: r.ACTIVATED_BY ?? undefined,
      matchedFields: matches.map((m) => ({
        fieldId: m.field.id,
        location: m.location,
        ...(m.nodeId !== undefined ? { nodeId: m.nodeId } : {}),
        fieldType: m.fieldType,
      })),
    });
    if (objects.length >= limit) break;
  }

  return {
    count: objects.length,
    limit,
    truncated: objects.length >= limit || rows.length >= maxCandidates,
    candidatesScanned: rows.length,
    maxCandidates,
    asOf: nowIso(),
    objects,
  };
}

/** 字段消费方（跨对象下游）：谁在哪个节点、用哪个列引用了被查字段 */
export interface FieldConsumer {
  packageId: string;
  objectName: string;
  objectSuffix: string;
  /** 消费方节点 id */
  nodeId: string;
  /** 消费方节点里的目标列（mapping.target） */
  targetColumn: string;
  /** 引用到的源列（= 被查视图的输出列名，mapping.source） */
  sourceColumn: string;
}

/** 字段级血缘回执：upstream=本视图内的字段逻辑；downstream=跨对象消费方 */
export interface FieldLineageResult {
  object: ViewDefinitionResult['object'];
  fieldId: string;
  direction: 'upstream' | 'downstream' | 'both';
  /** 上游：复用 getFieldLogic 的口径（字段不存在/无 CDATA 时抛业务错误，与 get_view 一致） */
  upstream?: FieldLogic;
  /** 下游：逐列归因的消费方（跨对象；按需 parse + view-cache 缓存） */
  downstream: FieldConsumer[];
  /** 通过"无映射输入"（Union 列名对齐）引用本视图的节点——**无法逐列归因，如实另列**，不混入 downstream */
  nameAlignedConsumers: Array<{ packageId: string; objectName: string; nodeId: string }>;
  /** 扫描口径（诚实性）：扫了多少下游候选视图、上限多少；truncated = 闭包被截断或候选超上限 */
  viewsScanned: number;
  maxViews: number;
  /** 读取/解析失败而跳过的候选数（CDATA 坏 / 扫描期间被并发删除）；不静默丢，如实计数 */
  failedCandidates: number;
  truncated: boolean;
  asOf: string;
}

/** 字段级下游扫描的候选视图上限默认值（每个候选都要 parse 设计时 XML，护栏同 by=field） */
const DEFAULT_MAX_LINEAGE_VIEWS = 50;

/**
 * 字段级血缘：
 * - **downstream（主打）**：沿对象图下游闭包找候选视图（`ACTIVE_OBJECTCROSSREF`），逐个按需 parse
 *   （走 `viewDefinitionCache`），在节点的输入映射里找 `mapping.source` == 被查字段的引用——
 *   回答"**谁用了这个字段**"；
 * - **upstream**：本视图内的字段逻辑（公式/脚本/源列/溯源），复用 `getFieldLogic` 的既有口径；
 * - 归因不到列的输入（Union 无 mappings、列名对齐）**另列** `nameAlignedConsumers`，不假装逐列命中。
 */
export async function fieldLineage(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  fieldId: string,
  opts: {
    direction?: 'upstream' | 'downstream' | 'both';
    maxViews?: number;
    maxNodes?: number;
    /**
     * 已取好的种子对象信息：downstream 方向只需要种子的类型后缀，调用方（get_field_logic 的
     * includeUsage 路径）已取过定义时传入它，可省掉对同一视图的第二次 ACTIVE_OBJECT 取数。
     */
    seedObject?: ViewDefinitionResult['object'];
  } = {},
): Promise<FieldLineageResult> {
  const direction = opts.direction ?? 'both';
  const maxViews = clampLimit(opts.maxViews, DEFAULT_MAX_LINEAGE_VIEWS, 1, 200);

  let upstream: FieldLogic | undefined;
  let seedObject: ViewDefinitionResult['object'];
  if (direction !== 'downstream') {
    // upstream 需要本视图的字段逻辑：与 hana_metadata_get_field_logic 走同一取数 + 失败口径
    const required = await requireFieldLogic(pool, packageId, objectName, fieldId);
    upstream = required.logic;
    seedObject = required.object;
  } else {
    seedObject = opts.seedObject ?? (await getViewDefinition(pool, packageId, objectName, { format: 'json' })).object;
  }
  const seedSuffix = seedObject.objectSuffix;

  const downstream: FieldConsumer[] = [];
  const nameAlignedConsumers: Array<{ packageId: string; objectName: string; nodeId: string }> = [];
  let viewsScanned = 0;
  let failedCandidates = 0;
  let truncated = false;

  if (direction !== 'upstream') {
    const c = await closure(
      pool,
      { packageId, objectName, objectSuffix: seedSuffix },
      { direction: 'downstream', depth: 'all', ...(opts.maxNodes !== undefined ? { maxNodes: opts.maxNodes } : {}) },
    );
    const viewSuffixes = new Set(Object.values(VIEW_SUFFIXES));
    // 候选按**层优先**（最近的消费方先扫）再按名字稳定排序——按字母序会把"层级近但名字靠后"的真实消费方挤出上限
    const candidates = c.nodes
      .filter((n) => viewSuffixes.has(n.objectSuffix))
      .sort(
        (a, b) =>
          a.level - b.level || a.packageId.localeCompare(b.packageId) || a.objectName.localeCompare(b.objectName),
      );
    truncated = c.truncated || candidates.length > maxViews;

    const seedPkg = packageId.toLowerCase();
    const seedName = objectName.toLowerCase();
    for (const cand of candidates.slice(0, maxViews)) {
      let def: ViewDefinitionResult;
      try {
        def = await viewDefinitionCache.get(pool, cand.packageId, cand.objectName);
      } catch {
        // 单个候选不可读（CDATA 解析失败 / 扫描期间被并发删除）不拖垮整次扫描——与 by=field
        //（searchObjectsByField）的宽容策略一致；不静默：计入 failedCandidates 如实上报
        failedCandidates++;
        continue;
      }
      if (!def.definition) continue;
      viewsScanned++;

      // 指向被查视图的数据源（resourceUri 为 /包/calculationviews/对象 形态；包路径用 . 归一后比较）
      const dsIds = new Set(
        def.definition.dataSources
          .filter((ds) => {
            if (!ds.resourceUri) return false;
            const r = parseResourceUri(ds.resourceUri);
            return !!r && r.pkg.replace(/\//g, '.').toLowerCase() === seedPkg && r.name.toLowerCase() === seedName;
          })
          .map((ds) => ds.id),
      );
      if (dsIds.size === 0) continue;

      for (const node of def.definition.nodes) {
        for (const input of node.inputs) {
          const refId = input.node.startsWith('#') ? input.node.slice(1) : input.node;
          if (!dsIds.has(refId)) continue;
          if (input.mappings.length === 0) {
            // Union 等按列名对齐的输入：无法逐列归因，如实另列
            nameAlignedConsumers.push({ packageId: cand.packageId, objectName: cand.objectName, nodeId: node.id });
            continue;
          }
          for (const m of input.mappings) {
            if (m.source.toLowerCase() === fieldId.toLowerCase()) {
              downstream.push({
                packageId: cand.packageId,
                objectName: cand.objectName,
                objectSuffix: cand.objectSuffix,
                nodeId: node.id,
                targetColumn: m.target,
                sourceColumn: m.source,
              });
            }
          }
        }
      }
    }
  }

  return {
    object: seedObject,
    fieldId,
    direction,
    ...(upstream !== undefined ? { upstream } : {}),
    downstream,
    nameAlignedConsumers,
    viewsScanned,
    maxViews,
    failedCandidates,
    truncated,
    asOf: nowIso(),
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

export type PackageListResult = PagedResult<PackageItem, 'packages'>;

/**
 * 包清单/包树：来源 _SYS_REPO.PACKAGE_CATALOG（PACKAGE_ID 为 . 分隔的完整路径）。
 * - pattern 按包路径片段模糊过滤（大小写不敏感）；返回 level（层级深度）供客户端组树
 * - 带截断（LIMIT）+ count，供 "Showing N of M" 提示
 */
export async function listPackages(
  pool: HanaPool,
  opts: { pattern?: string; limit?: number } = {},
): Promise<PackageListResult> {
  const limit = clampLimit(opts.limit, 100, 1, 500);
  const pattern = opts.pattern?.trim();
  const where = pattern ? 'WHERE UPPER(PACKAGE_ID) LIKE UPPER(?)' : '';
  const likeParams: string[] = pattern ? [`%${pattern}%`] : [];

  return runPaged('packages', limit, {
    count: async () => {
      const countRow = await pool.query<{ C: number }>(
        `SELECT COUNT(*) AS C FROM "_SYS_REPO"."PACKAGE_CATALOG" ${where}`,
        likeParams,
      );
      return countRow[0]?.C ?? 0;
    },
    items: async () => {
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
      return rows.map((r) => ({
        packageId: r.PACKAGE_ID,
        responsible: r.RESPONSIBLE ?? undefined,
        origLang: r.ORIG_LANG ?? undefined,
        deliveryUnit: r.DELIVERY_UNIT ?? undefined,
        level: r.PACKAGE_ID.split('.').length - 1,
      }));
    },
  });
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

export type PackageObjectsResult = PagedResult<PackageObjectItem, 'objects'> & { packageId: string };

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
  const limit = clampLimit(opts.limit, 100, 1, 500);
  const pattern = opts.pattern?.trim();
  const suffixes = opts.kind ? suffixesOf(opts.kind) : null;
  const suffixIn = suffixes ? suffixInClause(suffixes) : null;
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
  // 表名来自本函数的字面量联合类型，仍统一走 quoteIdentifier（标识符引用只此一种拼法）
  const countOf = async (table: 'ACTIVE_OBJECT' | 'INACTIVE_OBJECT'): Promise<number> => {
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM "_SYS_REPO".${quoteIdentifier(table)} ${where}`,
      params,
    );
    return rows[0]?.C ?? 0;
  };

  const page = await runPaged<PackageObjectItem, 'objects'>('objects', limit, {
    count: async () => {
      const [activeCount, inactiveCount] = await Promise.all([countOf('ACTIVE_OBJECT'), countOf('INACTIVE_OBJECT')]);
      return activeCount + inactiveCount;
    },
    items: async () => {
      const [activeRows, inactiveRows] = await Promise.all([
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
      return all;
    },
  });

  return { packageId, count: page.count, limit: page.limit, truncated: page.truncated, objects: page.objects };
}
