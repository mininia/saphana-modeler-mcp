import { createXmlBuilder } from '../core/xml.js';
import type { ColumnInfo } from '../services/metadata.service.js';

/**
 * 视图 XML 生成器：
 * 生成 HANA 2.0 经典的 Calculation:scenario（BiModelCalculation.ecore）设计时 XML，
 * 最小形态 = 单 Projection 节点 + 单个表数据源（全列透传）+ logicalModel 输出。
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