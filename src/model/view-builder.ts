import { HanaBusinessError } from '../core/errors.js';
import { assertSafeRuntimeName, isSafeRuntimeName } from '../core/sql.js';
import { createXmlBuilder, escapeXmlAttr } from '../core/xml.js';
import { CHAR_TYPES, isNumericType } from './view-types.js';

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
  /**
   * 源表列（列名 + 类型名）。
   * 刻意保持内联形状，不用 metadata.service 的 ColumnInfo：调用方是把查到的列映射成
   * `{columnName, dataTypeName}` 字面量再传进来，而 ColumnInfo 还要求 position/isNullable 等
   * 本生成器用不到的字段——挂上它会让调用点被迫造多余字段，把本层与元数据服务的形状耦在一起。
   */
  columns: Array<{ columnName: string; dataTypeName?: string }>;
  /** 度量策略：SUM_NUMERIC=数值列进 baseMeasures 聚合 sum；ALL_ATTRIBUTES=全部当属性（默认后者最保守） */
  measureMode?: 'SUM_NUMERIC' | 'ALL_ATTRIBUTES';
}

/**
 * scenario 根节点的固定属性（六个）：图形化对象树与 SQL 字符串模板共用同一份值。
 * 两处各写一套时，任一处随 SPS 调整都会让 create(图形化) 与 create(SQL) 产出的根属性分叉——
 * 表现为激活被拒且难以归因。defaultClient/defaultLanguage 是激活期由 HANA 替换的占位符，
 * 其余值对齐 Studio 导出。
 */
const SCENARIO_ROOT_ATTRS = {
  applyPrivilegeType: 'ANALYTIC_PRIVILEGE',
  checkAnalyticPrivileges: 'false',
  defaultClient: '$$client$$',
  defaultLanguage: '$$language$$',
  outputViewType: 'Projection',
  enforceSqlExecution: 'false',
} as const;

/** 共享固定属性 → 对象树形态（fast-xml-parser 的属性键前缀 '@_'） */
function scenarioRootAttrsObject(): Record<string, string> {
  return Object.fromEntries(Object.entries(SCENARIO_ROOT_ATTRS).map(([k, v]) => [`@_${k}`, v]));
}

/** 共享固定属性 → 字符串模板形态（` k="v"` 串；值均为无实体字符的常量，无需转义） */
function scenarioRootAttrsXml(): string {
  return Object.entries(SCENARIO_ROOT_ATTRS)
    .map(([k, v]) => ` ${k}="${v}"`)
    .join('');
}

/**
 * 根节点 dataCategory 的单点判定（图形化 create / SQL create / op=set_script 三条写路径共用）：
 * 本环境（SPS08 实测）含度量的 CV 必须 dataCategory="CUBE"（对齐 Studio 导出），含度量却标
 * DEFAULT 会被激活器以 40117 "No measures defined" 拒绝。
 */
export function scenarioDataCategory(measureCount: number): 'CUBE' | 'DEFAULT' {
  return measureCount > 0 ? 'CUBE' : 'DEFAULT';
}

/**
 * 生成最小 Calculation View 设计时 XML。
 * 结构对齐 Studio 导出的标准结构（Projection + dataSources + logicalModel）。
 */
export function buildMinCalcViewXml(spec: MinCalcViewSpec): string {
  const { objectName, schema, table } = spec;
  const desc = spec.description ?? objectName;
  // 源表名/schema 校验：显式列分支会让上游的列校验（getTableColumns 的 assertSafeRuntimeName）短路，
  // 未校验的名字会裸拼进 <columnObject> 的属性位——该位置（fast-xml-parser 对象树，processEntities=false）
  // 只自动转义双引号，`&`/`<`/`>` 会产出非法 XML 写进仓库（激活报看不懂的解析错）。运行时名口径与仓库
  // 其余写路径一致（isSafeRuntimeName，允许 /），在入口单点拒绝。
  assertSafeRuntimeName(schema, 'schema');
  assertSafeRuntimeName(table, '源表');
  // 列名过滤用运行时名口径（允许 /）：与 core/sql 的 SAFE_RUNTIME_NAME_RE 字符集逐字符相同。
  // 刻意不收紧成设计时名口径（assertSafeObjectName / SAFE_NAME_RE，禁 /）：那会改变"哪些列被映射"
  // 的行为——本生成器在已实机验证的写路径上，收紧必须是带测试的独立决定，不能藏在去重里。
  const requested = spec.columns ?? [];
  const columns = requested.filter((c) => isSafeRuntimeName(c.columnName));
  if (columns.length === 0) {
    // 抛业务错误而不是裸 Error：裸 Error 会被 withErrorEnvelope 降级成"内部错误"，
    // 把"源表无可映射列"这个可操作原因吞掉
    throw new HanaBusinessError(
      `源表 ${schema}/${table} 无可映射列（或列名含非法字符），无法生成视图`,
      'NO_MAPPABLE_COLUMNS',
    );
  }
  // 部分列名非法 ⇒ fail-closed 拒绝而不是静默丢弃：回执的度量数是按原始列清单统计的，丢弃会让
  // 「回执有 N 个度量、生成的 XML 里 0 个度量」同时成立（激活被 40117 拒时无从归因），调用方
  // 点名要的列也会无声消失。与 SQL 模式 normalizeScriptedColumns「含非法字符，已拒绝」同口径。
  const dropped = requested.filter((c) => !isSafeRuntimeName(c.columnName));
  if (dropped.length > 0) {
    throw new HanaBusinessError(
      `列名 ${dropped.map((c) => `"${c.columnName}"`).join('、')} 含非法字符，已拒绝` +
        '（仅允许字母/数字/_/$/#/./-//）；请从 columns 中剔除或改用合法列名',
    );
  }
  // 重复列名守卫（与 SQL 模式 normalizeScriptedColumns 同文案口径）：重复列名会让同一
  // viewAttribute/mapping/logicalModel id 声明两份，激活被服务端拒（模型拿到的只有难归因的
  // 激活失败）；两个模式对同类输入必须给同一份精确中文拒绝。
  const seenColumn = new Set<string>();
  for (const c of columns) {
    if (seenColumn.has(c.columnName)) {
      throw new HanaBusinessError(`输出列名 "${c.columnName}" 重复，已拒绝（列名须唯一）`);
    }
    seenColumn.add(c.columnName);
  }

  const dsId = 'SRC_1';
  const nodeId = 'Projection_1';
  const measureMode = spec.measureMode ?? 'ALL_ATTRIBUTES';
  const measures =
    measureMode === 'SUM_NUMERIC' ? columns.filter((c) => isNumericType(c.dataTypeName)).map((c) => c.columnName) : [];
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
      // 固定根属性（含 dataCategory 的 CUBE/DEFAULT 判定）与 SQL 形态共用单点实现
      ...scenarioRootAttrsObject(),
      '@_dataCategory': scenarioDataCategory(measures.length),
      '@_calculationScenarioType': 'TREE_BASED',
      origin: {},
      descriptions: { '@_defaultDescription': escapeXmlAttr(desc) },
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
 * 生成器把本环境方言（SCRIPT_BASED / <definition> / viewAttribute datatype 三者缺一不可）
 * 固化在服务端：模型只给「SQL + 输出列清单」，不写也不读 XML；方言细节与避坑见 rules=sql_mode
 * （src/rules/sql-mode.rules.ts），这里不复制正文。
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
const SCRIPT_NODE_ID = 'SqlScript_1';

/**
 * 脚本正文包装：把「查询式 SQL」包成 HANA 认的过程体（`BEGIN VAR_OUT = …; END`）。
 *
 * `<definition>` 会被原样拼进生成的 create procedure DDL——正文必须是过程体块、输出只能赋给
 * OUT 形参 `VAR_OUT`；失败形态与 datatype↔VAR_OUT 表类型的耦合见 rules=sql_mode
 * （hana_system_get_info(rules=sql_mode)）。
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

/**
 * 数据类型写法校验（允许精度写法，如 DECIMAL(15,2)、NVARCHAR(60)）。
 * 列名字符集不在此处：用 core/sql 的 isSafeRuntimeName（全仓唯一的运行时名字符集事实源，见
 * buildMinCalcViewXml 的说明）；"必须给 length 的字符型"用 view-types 的 CHAR_TYPES（同一份集合）。
 */
const DATA_TYPE_RE = /^[A-Z][A-Z0-9_ ]*(\(\s*\d+\s*(,\s*\d+\s*)?\))?$/;

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
    if (!isSafeRuntimeName(name)) throw new HanaBusinessError(`输出列名 "${c.name}" 含非法字符，已拒绝`);
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

/** 单个 SQL 模式 viewAttribute 元素（datatype 必填；字符型的 length 由调用方校验） */
function scriptedViewAttributeXml(c: NormalizedScriptedColumn, indent: string): string {
  const length = c.length !== undefined ? ` length="${String(c.length)}"` : '';
  const id = escapeXmlAttr(c.name);
  return `${indent}  <viewAttribute id="${id}" datatype="${escapeXmlAttr(c.dataType)}"${length}/>`;
}

/** SqlScriptView 节点的 <viewAttributes> 段（本环境实测必须带 datatype，字符型还需 length） */
export function scriptedViewAttributesXml(cols: NormalizedScriptedColumn[], indent = '      '): string {
  const items = cols.map((c) => scriptedViewAttributeXml(c, indent)).join('\n');
  return `${indent}<viewAttributes>\n${items}\n${indent}</viewAttributes>`;
}

/**
 * 单个 logicalModel <attribute> 元素（属性列）：order 由调用方按输出顺序算，indent 为父段缩进。
 *
 * 单一实现：SQL 模式 create / op=set_script 重建输出段与 op=add_join / add_calculated_column
 * 追加输出字段共用——两处各写一份时，元素属性集的增删会只落一边，create 出的视图与 update
 * 追加的字段形态分叉。description 缺省时不写 <descriptions>（追加字段可以没有描述）。
 */
export function logicalModelAttributeXml(
  id: string,
  order: number,
  sourceObject: string,
  description?: string,
  indent = '    ',
): string {
  const lines = [
    `${indent}  <attribute id="${escapeXmlAttr(id)}" order="${String(order)}"` +
      ` attributeHierarchyActive="false" displayAttribute="false">`,
  ];
  if (description !== undefined) {
    lines.push(`${indent}    <descriptions defaultDescription="${escapeXmlAttr(description)}"/>`);
  }
  lines.push(
    `${indent}    <keyMapping columnObjectName="${escapeXmlAttr(sourceObject)}" columnName="${escapeXmlAttr(id)}"/>`,
    `${indent}  </attribute>`,
  );
  return lines.join('\n');
}

/** 单个 logicalModel <measure> 元素（度量列；order 接在属性之后） */
function scriptedMeasureXml(c: NormalizedScriptedColumn, order: number, nodeId: string, indent: string): string {
  const id = escapeXmlAttr(c.name);
  return (
    `${indent}  <measure id="${id}" order="${String(order)}"` +
    ` aggregationType="${escapeXmlAttr(c.aggregationType)}" measureType="simple">\n` +
    `${indent}    <descriptions defaultDescription="${escapeXmlAttr(c.description)}"/>\n` +
    `${indent}    <measureMapping columnObjectName="${escapeXmlAttr(nodeId)}" columnName="${id}"/>\n` +
    `${indent}  </measure>`
  );
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
    .map((c, i) => logicalModelAttributeXml(c.name, i + 1, nodeId, c.description, indent))
    .join('\n');
  const measureItems = measures
    .map((c, i) => scriptedMeasureXml(c, attributes.length + i + 1, nodeId, indent))
    .join('\n');
  /** 段包裹：空集合收敛为自闭合段 */
  const wrapSection = (tag: string, items: string): string =>
    items === '' ? `${indent}<${tag}/>` : `${indent}<${tag}>\n${items}\n${indent}</${tag}>`;
  return {
    attributes: wrapSection('attributes', attrItems),
    measures: wrapSection('baseMeasures', measureItems),
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
    `<Calculation:scenario xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
      ` xmlns:Calculation="http://www.sap.com/ndb/BiModelCalculation.ecore"` +
      ` schemaVersion="2.3" id="${escapeXmlAttr(objectName)}"` +
      ` dataCategory="${scenarioDataCategory(measureCount)}"` +
      scenarioRootAttrsXml() +
      // SQL 模式的判定标志：激活器据此按脚本节点（而非图形化节点树）编译
      ` calculationScenarioType="SCRIPT_BASED">`,
    `  <origin/>`,
    `  <descriptions defaultDescription="${escapeXmlAttr(desc)}"/>`,
    `  <metadata changedAt=""/>`,
    `  <localVariables/>`,
    `  <variableMappings/>`,
    // SQL 模式无图形化数据源，数据源在脚本里以表名直接引用
    `  <dataSources/>`,
    `  <calculationViews>`,
    `    <calculationView xsi:type="Calculation:SqlScriptView" id="${SCRIPT_NODE_ID}">`,
    `      <descriptions/>`,
    scriptedViewAttributesXml(columns),
    `      <definition>${escapeXmlAttr(script)}</definition>`,
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
