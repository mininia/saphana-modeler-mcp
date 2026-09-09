/**
 * HANA 信息视图的 TS 模型。
 *
 * 设计原则：宽容结构化——只提取「理解视图逻辑」所需的核心结构
 * （数据源/节点树/字段映射/公式/变量/输出字段），未知节点原样透传（raw），
 * 不做严格 schema 校验（不同 SPS 的 XML 方言差异大，见方案 §8）。
 */

export type ViewKind = 'calculationview' | 'attributeview' | 'analyticview';

/** 数据源：计算视图引用 / 数据库表 / 数据库视图 */
export interface ViewDataSource {
  id: string;
  /** CALCULATION_VIEW / DATA_BASE_TABLE / DATA_BASE_VIEW */
  type: string;
  /** 计算视图数据源的仓库 URI（如 /pkg/sub/calculationviews/XXX） */
  resourceUri?: string;
  /** 表/视图数据源的 schema（如 ABAP） */
  schemaName?: string;
  /** 表/视图名（如 /BIC/AZDEMO001） */
  columnObjectName?: string;
}

/** 节点字段映射（target=节点输出字段, source=上游字段） */
export interface ViewNodeMapping {
  target: string;
  source: string;
}

/** 节点输入（一个上游节点 + 其字段映射） */
export interface ViewNodeInput {
  /** 上游节点引用（含 # 前缀，如 #Projection_1 或 #/BIC/TAB） */
  node: string;
  mappings: ViewNodeMapping[];
}

/** 计算字段（节点内计算列 / 公式） */
export interface ViewCalculatedAttribute {
  id: string;
  datatype?: string;
  length?: string;
  /** 公式语言：SQL / COLUMN_ENGINE */
  expressionLanguage?: string;
  formula?: string;
}

/** Aggregation 节点的度量映射（measureMapping：列 + 聚合函数） */
export interface ViewNodeMeasure {
  /** 度量来源列（columnObjectName，如 AMOUNT） */
  column: string;
  /** 聚合函数：sum/count/min/max/avg 等 */
  aggregationType?: string;
}

/** 属性级过滤器（viewAttribute 上的 <filter>，BW 常见：排除删除标记等） */
export interface ViewAttributeFilter {
  /** 是否包含该值：true=WHERE col = value；false=WHERE col != value */
  including: boolean;
  /** 过滤值（如 'X'） */
  value?: string;
  /** 过滤器类型（SingleValueFilter / MultiValueFilter 等） */
  type?: string;
}

/** Rank 节点定义（windowFunction）：取每组前 threshold 条 */
export interface ViewRankDefinition {
  /** 分组字段（partitionViewAttributeName，相当于 ROW_NUMBER 的 PARTITION BY） */
  partitionBy: string[];
  /** 排序字段（order byViewAttributeName + direction，ASC/DESC） */
  orderBy: Array<{ column: string; direction?: string }>;
  /** 阈值（rankThreshold）：每组保留前 N 条 */
  threshold: number;
}

/** 节点树的单个节点（Projection/Join/Aggregation/Union/Rank/Filter/SqlScriptView 等） */
export interface ViewNode {
  id: string;
  /** 节点类型（xsi:type 的本地名，如 ProjectionView/JoinView/AggregationView/SqlScriptView） */
  type: string;
  joinType?: string;
  joinOrder?: string;
  /** Join 的关联字段 */
  joinAttributes: string[];
  /** 节点输出的字段清单 */
  attributes: string[];
  /** 计算列（含公式） */
  calculatedAttributes: ViewCalculatedAttribute[];
  /** Aggregation 分组的维度列（aggregateBy 的 columnObjectName 列表） */
  aggregateBy: string[];
  /** Aggregation 的度量映射（measureMapping 列表） */
  measures: ViewNodeMeasure[];
  /**
   * Aggregation 格式 B（BW/HANA Studio 方言）：写在 viewAttribute 上的聚合函数。
   * 有 aggregationType 的属性 = 度量，无 aggregationType 的属性 = 分组维度（与 aggregateBy/measures 格式二选一）。
   */
  attributeAggregations: Array<{ id: string; aggregationType: string }>;
  /** 属性级过滤器（viewAttribute 上的 filter，如排除删除标记）；推导时生成 WHERE 条件 */
  attributeFilters: Array<{ id: string; filters: ViewAttributeFilter[] }>;
  /** Rank 节点定义（windowFunction）；非 Rank 节点为 undefined */
  rank?: ViewRankDefinition;
  /** SQLScript 源码（SqlScriptView 节点，来自 definition 元素，已解码 XML 实体） */
  script?: string;
  /** 上游输入与字段映射 */
  inputs: ViewNodeInput[];
  /** 过滤表达式 */
  filter?: string;
  /** 其他节点特有属性（如 Aggregation 的 measure 映射），宽容透传 */
  extra: Record<string, unknown>;
}

/** 输出字段（logicalModel 的 attribute/measure） */
export interface ViewOutputField {
  id: string;
  order?: number;
  description?: string;
  key?: boolean;
  /** 是否隐藏字段（BW query 常见：0INFOPROV、文本列 ___T 等；默认选字段时应排除） */
  hidden?: boolean;
  /** 来源（keyMapping/measureMapping 的 columnName） */
  sourceColumn?: string;
  /** 来源对象（keyMapping/measureMapping 的 columnObjectName） */
  sourceObject?: string;
  aggregationType?: string;
  measureType?: string;
  datatype?: string;
  length?: string;
  /** 公式语言：SQL / COLUMN_ENGINE */
  expressionLanguage?: string;
  formula?: string;
}

/** 输入参数（Input Parameter） */
export interface ViewVariable {
  id: string;
  parameter: boolean;
  datatype?: string;
  length?: string;
  defaultValue?: string;
  mandatory?: boolean;
  description?: string;
}

export interface ViewOutputs {
  attributes: ViewOutputField[];
  calculatedAttributes: ViewOutputField[];
  measures: ViewOutputField[];
  calculatedMeasures: ViewOutputField[];
  restrictedMeasures: ViewOutputField[];
}

/** 视图定义的统一结构化模型 */
export interface ViewDefinition {
  kind: ViewKind;
  id: string;
  schemaVersion?: string;
  description?: string;
  /** CUBE / CALCULATION / DIMENSION */
  dataCategory?: string;
  outputViewType?: string;
  checkAnalyticPrivileges?: boolean;
  /** 设计时 XML 的 applyPrivilegeType（如 ANALYTIC_PRIVILEGE / NONE）；分析权限检测用 */
  applyPrivilegeType?: string;
  /** AV 专属：Standard/Time */
  dimensionType?: string;
  dataSources: ViewDataSource[];
  nodes: ViewNode[];
  variables: ViewVariable[];
  outputs: ViewOutputs;
  /** 完整解析树（调试与未知结构透传） */
  raw: unknown;
}
