import { HanaBusinessError } from '../core/errors.js';
import { createXmlBuilder } from '../core/xml.js';
import type { ColumnInfo } from '../services/metadata.service.js';

/**
 * 视图 XML 生成器：
 * 生成 HANA 2.0 经典的 Calculation:scenario（BiModelCalculation.ecore）设计时 XML。
 * 两种形态：
 * - 图形化最小形态（buildMinCalcViewXml）：单 Projection 节点 + 单个表数据源（全列透传）+ logicalModel 输出；
 * - SQL 模式（buildScriptedCalcViewXml）：单 SqlScriptView 节点（<definition> SQL）+ logicalModel 输出。
 * 生成的 XML 必须能被 view-xml.ts 的 parseViewDefinition 正确解析（round-trip 单测保证）。
 */

export interface MinCalcViewSpec {
  /** 对象名（不含包名），如 ZDEMO_CV_TEST001 */
  objectName: string;
  /** 视图描述 */
  description?: string;
  /** 源表 schema（经白名单校验后传入） */
  schema: string;
  /** 源表名 */
  table: string;
  /** 源表列（列名 + 类型 + 是否度量：数值且非主键 → 度量） */
  columns: Array<{ columnName: string; dataTypeName?: string }>;
  /** 度量策略：SUM_NUMERIC=数值列进 baseMeasures 聚合 sum；ALL_ATTRIBUTES=全部当属性（默认后者最保守） */
  measureMode?: 'SUM_NUMERIC' | 'ALL_ATTRIBUTES';
}

/** 判定某列是否按默认策略当作度量（数值类型 + 名称以常见度量子串结束可选） */
const NUMERIC_TYPES = new Set([
  'TINYINT', 'SMALLINT', 'INTEGER', 'INT', 'BIGINT',
  'DECIMAL', 'SMALLDECIMAL', 'REAL', 'DOUBLE', 'FLOAT',
  'SECONDDATE', 'DATE', 'TIME', 'TIMESTAMP', 'LONGDATE',
]);

function isNumericMeasure(col: { columnName: string; dataTypeName?: string }): boolean {
  const t = (col.dataTypeName ?? '').toUpperCase();
  return NUMERIC_TYPES.has(t);
}

/** XML 转义（元素文本内 & < > 必须转义；属性值还需转义 "） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * 生成最小 Calculation View 设计时 XML。
 * 结构对齐 Studio 导出的标准结构（Projection + dataSources + logicalModel）。
 */
export function buildMinCalcViewXml(spec: MinCalcViewSpec): string {
  const { objectName, schema, table } = spec;
  const desc = spec.description ?? objectName;
  const columns = (spec.columns ?? []).filter((c) => /^[A-Za-z0-9_$#./-]+$/.test(c.columnName));
  if (columns.length === 0) {
    throw new Error(`源表 ${schema}/${table} 无可映射列（或列名含非法字符），无法生成视图`);
  }

  const dsId = 'SRC_1';
  const nodeId = 'Projection_1';
  const measureMode = spec.measureMode ?? 'ALL_ATTRIBUTES';
  const measures =
    measureMode === 'SUM_NUMERIC'
      ? columns.filter((c) => isNumericMeasure(c)).map((c) => c.columnName)
      : [];
  const measureSet = new Set(measures);
  const attributes = columns.filter((c) => !measureSet.has(c.columnName)).map((c) => c.columnName);

  const dataSource = {
    '@_id': dsId,
    '@_type': 'DATA_BASE_TABLE',
    // 注意：fast-xml-parser 会把字符串 'true' 序列化为无值布尔属性，须用大写 'TRUE' 才输出 ="TRUE"
    viewAttributes: { '@_allViewAttributes': 'TRUE' },
    columnObject: { '@_schemaName': schema, '@_columnObjectName': table },
  };

  // 目标字段序：属性在前、度量在后（解析器只 care 映射关系，顺序不影响正确性）
  const allFields = [...attributes, ...measures];
  const mappings = allFields.map((f) => ({
    '@_xsi:type': 'Calculation:AttributeMapping',
    '@_target': f,
    '@_source': f,
  }));

  const viewAttributes = allFields.map((f) => ({ '@_id': f }));

  const projectionNode = {
    '@_xsi:type': 'Calculation:ProjectionView',
    '@_id': nodeId,
    descriptions: {},
    viewAttributes: { viewAttribute: viewAttributes },
    calculatedViewAttributes: {},
    input: {
      '@_node': `#${dsId}`,
      mapping: mappings,
    },
  };

  // logicalModel：attributes + baseMeasures
  const attributeEls = attributes.map((f, i) => ({
    '@_id': f,
    '@_order': String(i + 1),
    descriptions: { '@_defaultDescription': f },
    keyMapping: { '@_columnObjectName': nodeId, '@_columnName': f },
  }));
  const measureEls = measures.map((f, i) => ({
    '@_id': f,
    '@_order': String(attributes.length + i + 1),
    '@_aggregationType': 'sum',
    '@_measureType': 'simple',
    descriptions: { '@_defaultDescription': f },
    measureMapping: { '@_columnObjectName': nodeId, '@_columnName': f },
  }));

  const obj = {
    'Calculation:scenario': {
      '@_xmlns:xsi': 'http://www.w3.org/2001/XMLSchema-instance',
      '@_xmlns:Calculation': 'http://www.sap.com/ndb/BiModelCalculation.ecore',
      '@_schemaVersion': '2.3',
      '@_id': objectName,
      '@_applyPrivilegeType': 'ANALYTIC_PRIVILEGE',
      '@_checkAnalyticPrivileges': 'false',
      '@_defaultClient': '$$client$$',
      '@_defaultLanguage': '$$language$$',
      // 实测（SPS08）：含度量的 CV 必须 dataCategory="CUBE"（对齐 Studio 导出），
      // DEFAULT 无度量会被激活器以 40117 "No measures defined" 拒绝
      '@_dataCategory': measureSet.size > 0 ? 'CUBE' : 'DEFAULT',
      '@_outputViewType': 'Projection',
      '@_calculationScenarioType': 'TREE_BASED',
      '@_enforceSqlExecution': 'false',
      origin: {},
      descriptions: { '@_defaultDescription': esc(desc) },
      metadata: { '@_changedAt': '' },
      localVariables: {},
      variableMappings: {},
      dataSources: {
        DataSource: dataSource,
      },
      calculationViews: {
        calculationView: projectionNode,
      },
      logicalModel: {
        '@_id': nodeId,
        descriptions: {},
        attributes: { attribute: attributeEls },
        calculatedAttributes: {},
        baseMeasures: { measure: measureEls },
        calculatedMeasures: {},
        restrictedMeasures: {},
        localDimensions: {},
      },
    },
  };

  const builder = createXmlBuilder();
  // 实测（SPS08）：激活器的 EMF/XMI 反序列化对布尔属性严格小写，"TRUE" 解析失败
  // → 数据源无属性（34011 "Attributes are mandatory"）。fast-xml-parser 会把字符串 'true'
  // 序列化为无值属性，故构造时用 'TRUE' 占位、在此统一回写为小写。
  return (builder.build(obj) as string).replace(/allViewAttributes="TRUE"/g, 'allViewAttributes="true"');
}

/* ── SQL 模式（Scripted Calculation View）────────────────────────────
 * 「SQL 模式」= 单个 SqlScriptView 节点承载整段 SQL，输出列由脚本的 SELECT 决定。
 *
 * 本环境的方言要点（三者缺一不可，否则激活被拒）：
 *   1. 根节点 calculationScenarioType="SCRIPT_BASED"（不是图形化模型的 TREE_BASED）；
 *   2. SQL 正文放在 <definition> 元素内（XML 实体转义，不是 CDATA）；
 *   3. 每个 viewAttribute 必须显式声明 datatype（字符型还要 length）。
 * 生成器把这些约束固化在服务端：模型只给「SQL + 输出列清单」，不写也不读 XML。
 *
 * 注意：脚本内的表名若未限定 schema，激活时会按当前用户的默认 schema 解析——建议脚本里显式写 schema。"表"。
 */

/** 脚本输出列（顺序即 logicalModel 输出顺序） */
export interface ScriptedColumnSpec {
  /** 输出列名（须与脚本 SELECT 的列别名一致） */
  name: string;
  /** HANA 数据类型（如 NVARCHAR / DECIMAL / DATE），必填——本环境缺 datatype 会激活失败 */
  dataType: string;
  /** 字符型长度（NVARCHAR/VARCHAR/ALPHANUM 等必填） */
  length?: number;
  /** true=度量列（进 baseMeasures + 聚合）；缺省=属性列 */
  isMeasure?: boolean;
  /** 度量聚合方式（默认 sum；仅 isMeasure=true 有效） */
  aggregationType?: string;
  /** 中文描述（缺省取列名） */
  description?: string;
}

/** SQL 模式视图规格 */
export interface ScriptedCalcViewSpec {
  objectName: string;
  description?: string;
  /** SQL 脚本正文（HANA SQLScript；表名建议显式 schema 限定） */
  script: string;
  /** 输出列清单（datatype 必填） */
  columns: ScriptedColumnSpec[];
}

/** SqlScriptView 节点 id（单节点形态，固定） */
export const SCRIPT_NODE_ID = 'SqlScript_1';

/**
 * 脚本正文包装：把「查询式 SQL」包成 HANA 认的过程体。
 *
 * 实机结论（SPS08，2026-09）：`<definition>` 会被**原样拼接**到生成的 DDL 末尾——
 *   create procedure "<...>/proc" ( OUT var_out "<...>/tabletype/VAR_OUT" ) language sqlscript ... as <definition>
 * 因此正文必须是**过程体（块）**，而不是裸语句；且输出必须赋值给 OUT 形参 `VAR_OUT`：
 *   裸 `SELECT ...`      → sql syntax error: incorrect syntax near "SELECT"
 *   `VAR_OUT = SELECT …` → incorrect syntax near "="
 *   `DO BEGIN … END`     → incorrect syntax near "BEGIN"
 *   `BEGIN VAR_OUT = … END` → 激活通过（本函数产出形态）
 * 同时：HANA 由本 XML 的 viewAttribute datatype/length 生成 VAR_OUT 的表类型
 * （`create type "…/proc/tabletype/VAR_OUT" as table ("KEY_A" NVARCHAR(60), …)`）——
 * 声明缺失时该类型为空表（`as table ()`），这也正是「viewAttribute 必须带 datatype」的真因。
 *
 * 宽容处理：调用方若已给出完整过程体（以 BEGIN 开头，或 DO BEGIN 的匿名块写法）则原样使用。
 */
export function wrapScriptedBody(script: string): string {
  const s = script.replace(/\r\n?/g, '\n').trim();
  if (s === '') throw new HanaBusinessError('SQL 脚本为空（script），无法生成 SQL 模式视图');
  // 已是过程体：原样使用（DO BEGIN 的匿名块在过程体位置不被接受，剥掉 DO 前缀）
  const asBlock = s.replace(/^\s*DO\s+(?=BEGIN\b)/i, '');
  if (/^\s*BEGIN\b/i.test(asBlock)) return asBlock;
  // 查询式：包成块并赋值给 OUT 形参（去掉查询自带尾分号，避免 ";;"）
  const query = s.replace(/[\s;]+$/, '');
  // 末行为行注释时，分号会被注释吞掉 → 把分号放到下一行（实机：那样报的是"END 附近语法错"，很难归因）
  const endsWithLineComment = /--[^\n]*$/.test(query);
  return endsWithLineComment ? `BEGIN\n  VAR_OUT = ${query}\n;\nEND` : `BEGIN\n  VAR_OUT = ${query};\nEND`;
}

/** 列名/类型字符集校验（类型允许精度写法，如 DECIMAL(15,2)、NVARCHAR(60)） */
const COLUMN_NAME_RE = /^[A-Za-z0-9_$#./-]+$/;
const DATA_TYPE_RE = /^[A-Z][A-Z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;
/** 必须显式给 length 的字符型（缺 length 时 HANA 生成的 VAR_OUT 表类型会与脚本实际类型不符） */
const CHAR_TYPES = new Set(['NVARCHAR', 'VARCHAR', 'NCHAR', 'CHAR', 'ALPHANUM', 'SHORTTEXT']);

/** 归一化后的脚本输出列（两条写路径共用同一份校验与归一化结果） */
export interface NormalizedScriptedColumn {
  name: string;
  dataType: string;
  length?: number;
  isMeasure: boolean;
  aggregationType: string;
  description: string;
}

/**
 * 输出列校验 + 归一化（**单一实现**：create 与 op=set_script 共用）。
 * 两处各写一份必然漂移（转义、属性、缺 length 校验会只在一边有），故本函数是唯一入口。
 */
export function normalizeScriptedColumns(columns: ScriptedColumnSpec[]): NormalizedScriptedColumn[] {
  if (columns.length === 0) {
    throw new HanaBusinessError(
      'SQL 模式需要显式声明输出列（columns）：本环境实测 viewAttribute 必须带 datatype，' +
        '无法从 SQL 文本推断类型；请按脚本 SELECT 的列清单逐个给出 {name, dataType, length?}',
    );
  }
  const seen = new Set<string>();
  return columns.map((c) => {
    const name = c.name.trim();
    if (!COLUMN_NAME_RE.test(name)) throw new HanaBusinessError(`输出列名 "${c.name}" 含非法字符，已拒绝`);
    if (seen.has(name)) throw new HanaBusinessError(`输出列名 "${name}" 重复，已拒绝（列名须唯一）`);
    seen.add(name);
    const dataType = c.dataType.trim().toUpperCase();
    if (!DATA_TYPE_RE.test(dataType)) {
      throw new HanaBusinessError(
        `输出列 "${name}" 的 dataType "${c.dataType}" 不是合法的 HANA 类型写法` +
          '（形如 NVARCHAR / DECIMAL(15,2)；如需精度请在 dataType 内给出）',
      );
    }
    if (c.length !== undefined && (!Number.isInteger(c.length) || c.length <= 0)) {
      throw new HanaBusinessError(`输出列 "${name}" 的 length 必须为正整数（收到 ${String(c.length)}）`);
    }
    // 字符型必须给 length：「未给」与「给了但非法」是两种错，上面拦了后者，此处补前者——
    // 本环境实测 viewAttribute 的 datatype/length 决定 HANA 生成的输出表类型，
    // 缺 length 时声明的类型与脚本结果类型不一致 → 激活失败
    if (CHAR_TYPES.has(dataType) && c.length === undefined) {
      throw new HanaBusinessError(
        `输出列 "${name}" 为字符型（${dataType}）但未给 length：本环境该列的类型声明会用于生成输出表类型，` +
          '缺 length 会与实际结果类型不符导致激活失败，请补 length',
      );
    }
    return {
      name,
      dataType,
      length: c.length,
      isMeasure: c.isMeasure === true,
      aggregationType: (c.aggregationType ?? 'sum').toLowerCase(),
      description: c.description ?? name,
    };
  });
}

/** SqlScriptView 节点的 <viewAttributes> 段（本环境实测必须带 datatype，字符型还需 length） */
export function scriptedViewAttributesXml(cols: NormalizedScriptedColumn[], indent = '      '): string {
  const items = cols
    .map((c) => `${indent}  <viewAttribute id="${esc(c.name)}" datatype="${esc(c.dataType)}"${c.length !== undefined ? ` length="${String(c.length)}"` : ''}/>`)
    .join('\n');
  return `${indent}<viewAttributes>\n${items}\n${indent}</viewAttributes>`;
}

/** logicalModel 的 <attributes> 与 <baseMeasures> 段（输出字段与类型；属性在前、度量在后） */
export function scriptedOutputSectionsXml(
  cols: NormalizedScriptedColumn[],
  nodeId: string,
  indent = '    ',
): { attributes: string; measures: string } {
  const attributes = cols.filter((c) => !c.isMeasure);
  const measures = cols.filter((c) => c.isMeasure);
  const attrItems = attributes
    .map(
      (c, i) =>
        `${indent}  <attribute id="${esc(c.name)}" order="${String(i + 1)}" attributeHierarchyActive="false" displayAttribute="false">\n` +
        `${indent}    <descriptions defaultDescription="${esc(c.description)}"/>\n` +
        `${indent}    <keyMapping columnObjectName="${esc(nodeId)}" columnName="${esc(c.name)}"/>\n` +
        `${indent}  </attribute>`,
    )
    .join('\n');
  const measureItems = measures
    .map(
      (c, i) =>
        `${indent}  <measure id="${esc(c.name)}" order="${String(attributes.length + i + 1)}" aggregationType="${esc(c.aggregationType)}" measureType="simple">\n` +
        `${indent}    <descriptions defaultDescription="${esc(c.description)}"/>\n` +
        `${indent}    <measureMapping columnObjectName="${esc(nodeId)}" columnName="${esc(c.name)}"/>\n` +
        `${indent}  </measure>`,
    )
    .join('\n');
  return {
    attributes: attrItems === '' ? `${indent}<attributes/>` : `${indent}<attributes>\n${attrItems}\n${indent}</attributes>`,
    measures: measureItems === '' ? `${indent}<baseMeasures/>` : `${indent}<baseMeasures>\n${measureItems}\n${indent}</baseMeasures>`,
  };
}

/**
 * 生成 SQL 模式 Calculation View 设计时 XML（Calculation:scenario + SqlScriptView + logicalModel）。
 *
 * 用**字符串拼装**而非对象树：op=set_script 是对已有文档做锚点手术（字符串），两条路径共用
 * scriptedViewAttributesXml / scriptedOutputSectionsXml，保证 create 与 update 产出同一形态
 * ——列清单的校验与 XML 片段必须只有一份实现，两边各写一套时转义/属性规则会各自漂移，
 * 同一份列清单在 create 能过、在 set_script 被拒。
 */
export function buildScriptedCalcViewXml(spec: ScriptedCalcViewSpec): string {
  const { objectName } = spec;
  const desc = spec.description ?? objectName;
  // 正文按过程体包装（BEGIN … VAR_OUT = <查询>; … END）：<definition> 会被原样拼进
  // create procedure … as <definition>，裸语句不是合法过程体（见 wrapScriptedBody 注释）
  const script = wrapScriptedBody(spec.script);
  const columns = normalizeScriptedColumns(spec.columns);
  const measureCount = columns.filter((c) => c.isMeasure).length;
  const { attributes, measures } = scriptedOutputSectionsXml(columns, SCRIPT_NODE_ID);

  // SQL 正文必须**手工实体转义**：XML 构造器配置 processEntities=false（不自动转义），
  // 直接把含 < > & 的 SQL 塞进元素会产出非法 XML（激活必然失败）。仓库既有对象的公式/脚本
  // 同款使用实体转义（见 view-xml.ts 的 text() 解码注释），故与既有形态一致。
  return [
    `<Calculation:scenario xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:Calculation="http://www.sap.com/ndb/BiModelCalculation.ecore"` +
      ` schemaVersion="2.3" id="${esc(objectName)}" applyPrivilegeType="ANALYTIC_PRIVILEGE" checkAnalyticPrivileges="false"` +
      ` defaultClient="$$client$$" defaultLanguage="$$language$$"` +
      // 含度量 → CUBE（与图形化形态同规则；无度量会被激活器以 40117 拒绝）
      ` dataCategory="${measureCount > 0 ? 'CUBE' : 'DEFAULT'}" outputViewType="Projection"` +
      // SQL 模式的判定标志：激活器据此按脚本节点（而非图形化节点树）编译
      ` calculationScenarioType="SCRIPT_BASED" enforceSqlExecution="false">`,
    `  <origin/>`,
    `  <descriptions defaultDescription="${esc(desc)}"/>`,
    `  <metadata changedAt=""/>`,
    `  <localVariables/>`,
    `  <variableMappings/>`,
    // SQL 模式无图形化数据源，数据源在脚本里以表名直接引用
    `  <dataSources/>`,
    `  <calculationViews>`,
    `    <calculationView xsi:type="Calculation:SqlScriptView" id="${SCRIPT_NODE_ID}">`,
    `      <descriptions/>`,
    scriptedViewAttributesXml(columns),
    `      <definition>${esc(script)}</definition>`,
    `    </calculationView>`,
    `  </calculationViews>`,
    `  <logicalModel id="${SCRIPT_NODE_ID}">`,
    `    <descriptions/>`,
    attributes,
    `    <calculatedAttributes/>`,
    measures,
    `    <calculatedMeasures/>`,
    `    <restrictedMeasures/>`,
    `    <localDimensions/>`,
    `  </logicalModel>`,
    `</Calculation:scenario>`,
  ].join('\n');
}