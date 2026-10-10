import { aggGroupBy, aggMeasures, normalizeBwSchema } from './view-types.js';
import type {
  ViewDataSource,
  ViewDefinition,
  ViewNode,
  ViewNodeMapping,
  ViewNodeMeasure,
  ViewOutputField,
  ViewOutputs,
  ViewRankDefinition,
  ViewVariable,
} from './view-types.js';

/**
 * 两个 ViewDefinition 的**结构化 diff**（P6 dryRun 的地基，SSD §5.2）。
 *
 * 为什么必须先归一化再比：同一份视图经 Studio 重存、Aggregation 方言改写（格式 A/B）、布局重排后，
 * XML 文本会大面积变化而语义不变——直接比文本/raw 会被假 diff 淹死，破坏性判定随之失真。
 * 所以只比结构化模型（view-types.ts 的 ViewDefinition），并逐条落实 SSD §5.2 的归一化：
 *   1) 数组按**集合**比（文档序无语义）；例外：输出字段 order 当值比、Rank 的 ORDER BY 次序有语义；
 *   2) Aggregation 方言归一：格式 A（aggregateBy+measureMapping）与 B（viewAttribute/@aggregationType）
 *      共用 model/view-types 的 aggGroupBy/aggMeasures 做比较基准（同一份规则，不复制判定）；
 *   3) Union 节点列按名对齐：跳过 mappings 差量比较（列序不同/映射缺失不算变更），只比列名集合；
 *      但**输入集合仍参与比较**（见 8)）；
 *   4) 缺省 ≡ 空：key/hidden/parameter/mandatory 缺省 ≡ false；空串 ≡ 缺段；空数组 ≡ 缺数组；
 *   5) 公式/脚本比**解码后文本**（模型里已是 text() 解码结果），不比 raw/XML 文本；
 *   6) raw 不参与比较：informationModelLayout、<metadata changedAt=""> 等布局噪声只存在于 raw；
 *   7) 数据源 schemaName 先过 normalizeBwSchema（ABAP ↔ SAPABAP1）再比；
 *   8) **输入绑定参与比较**（P6 修复批，评审 #1/#2/#9）：映射索引按 target → 排序后的
 *      (inputNode, source) 列表比（见 mappingIndex）——输入换人（哪怕映射逐字同名）/ 映射重指向 /
 *      Union 输入增删都命中，该节点 fields 记 'inputs'；同一组 (inputNode, source) 的重排不产生
 *      差异（文档序无语义，别制造假 diff）。
 *
 * 确定性：所有数组按 id 升序（字符串码点序，无 locale/环境依赖），同一输入两次调用逐字节一致。
 *
 * 依赖方向说明：Aggregation 方言判定（aggGroupBy/aggMeasures）与 BW schema 别名归一
 * （normalizeBwSchema）均已上移到 model/view-types.ts——预览推导、诊断与 diff 三方共用同一份规则，
 * 本文件（model 层）不再 import services，依赖方向只朝内。
 */

/** logicalModel 的五个输出字段列表（keyMapping 属性 / 计算属性 / 基础度量 / 计算度量 / 受限度量） */
export type ViewOutputList =
  'attributes' | 'calculatedAttributes' | 'measures' | 'calculatedMeasures' | 'restrictedMeasures';

/** 数据源回执条目（added/removed 用；字段取原值——比较才归一化，回执如实反映文件内容） */
export interface ViewDiffDataSource {
  id: string;
  type: string;
  resourceUri?: string;
  schemaName?: string;
  columnObjectName?: string;
}

/** 节点输入映射差量（added/removed 按 target 升序、同 target 按 source 升序） */
export interface ViewDiffMappingDelta {
  added: ViewNodeMapping[];
  removed: ViewNodeMapping[];
  /** 同一 target 的源列从 from 换成 to（仅单源→单源时归入此格，多源增减落 added/removed） */
  retargeted: Array<{ target: string; from: string; to: string }>;
}

export interface ViewDiffNodeChange {
  id: string;
  /** 变更后的节点类型（after 侧，回执反映变革后现状） */
  type: string;
  /**
   * 变化的字段位，取值 ⊂ NODE_FIELDS ∪ {'inputs'}（升序）。
   * 'inputs' = **输入绑定**变化（输入换人 / 映射重指向 / Union 输入增删），由输入绑定比较产出，
   * 与逐字段比较并列（不是 NODE_FIELDS 里的标量字段位，见 mappingIndex 头注）。
   */
  fields: string[];
  mappings: ViewDiffMappingDelta;
}

export interface ViewDiff {
  /** 归一化后无任何结构差异（含 output 未换人、根级属性未变） */
  empty: boolean;
  dataSources: {
    added: ViewDiffDataSource[];
    removed: ViewDiffDataSource[];
    changed: Array<{ id: string; fields: string[] }>;
  };
  nodes: {
    added: Array<{ id: string; type: string }>;
    removed: Array<{ id: string; type: string }>;
    changed: ViewDiffNodeChange[];
  };
  /**
   * 最终输出节点（把结果交给 logicalModel 的那个节点）是否换人。
   *
   * passThrough 是**豁免的证据**，不是结论（判定层据此决定「输出换人 + 既有字段仅 sourceObject 变化」
   * 能否降级为非破坏；证据不成立时不得豁免）：true ⇔ after 定义里 `to` 节点有一条输入
   * （inputs[].node）直接指向 `from` —— 即新输出节点是直接站在旧输出节点之上的直通（add_join 的
   * 机械重挂形态）。changed=true 时恒带该键（布尔：证据成立与否的一手答案）；changed=false 时
   * 不产生 from/to/passThrough（不制造噪音）。
   */
  output: { changed: boolean; from?: string; to?: string; passThrough?: boolean };
  outputs: {
    added: Array<{ list: ViewOutputList; id: string }>;
    removed: Array<{ list: ViewOutputList; id: string }>;
    changed: Array<{ list: ViewOutputList; id: string; fields: string[] }>;
  };
  variables: {
    added: string[];
    removed: string[];
    changed: Array<{ id: string; fields: string[] }>;
  };
  /** ⊂ ['description','dataCategory','outputViewType','checkAnalyticPrivileges','applyPrivilegeType','dimensionType','id','schemaVersion'] */
  root: { changed: string[] };
}

/** 比较 before/after 两个视图定义，回执形状与排序见 ViewDiff（同一输入两次调用逐字节相同） */
export function diffViewDefinitions(before: ViewDefinition, after: ViewDefinition): ViewDiff {
  const dataSources = diffDataSources(before.dataSources, after.dataSources);
  const nodes = diffNodes(before.nodes, after.nodes);
  const output = diffOutputNode(before, after);
  const outputs = diffOutputs(before.outputs, after.outputs);
  const variables = diffVariables(before.variables, after.variables);
  const root = {
    changed: ROOT_FIELDS.filter((f) => rootFieldValue(before, f) !== rootFieldValue(after, f)).sort(cmpStr),
  };
  const empty =
    dataSources.added.length === 0 &&
    dataSources.removed.length === 0 &&
    dataSources.changed.length === 0 &&
    nodes.added.length === 0 &&
    nodes.removed.length === 0 &&
    nodes.changed.length === 0 &&
    !output.changed &&
    outputs.added.length === 0 &&
    outputs.removed.length === 0 &&
    outputs.changed.length === 0 &&
    variables.added.length === 0 &&
    variables.removed.length === 0 &&
    variables.changed.length === 0 &&
    root.changed.length === 0;
  return { empty, dataSources, nodes, output, outputs, variables, root };
}

/* ── 通用小工具 ───────────────────────────────────────────── */

/** 码点序比较（不用 localeCompare：确定性回执要求与环境 locale 无关） */
function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** 按 id 建索引；空 id 是解析噪声（解析器对缺 @_id 的条目填 ''），直接忽略 */
function indexById<T extends { id: string }>(items: T[]): Map<string, T> {
  const m = new Map<string, T>();
  for (const it of items) if (it.id !== '') m.set(it.id, it);
  return m;
}

/** 字符串数组的集合键：去空串、去重、升序后以 NUL 连接（集合语义，文档序无语义） */
function setKey(xs: string[]): string {
  return [...new Set(xs.filter((x) => x !== ''))].sort(cmpStr).join('\u0000');
}

/** 逐条稳定化后的条目集合键：整体升序（数组下标无语义，条目内容已逐条稳定化） */
function listKey(entries: string[]): string {
  return [...entries].sort(cmpStr).join('\u0001');
}

/* ── 数据源 ───────────────────────────────────────────────── */

type DataSourceField = 'type' | 'resourceUri' | 'schemaName' | 'columnObjectName';
const DS_FIELDS: DataSourceField[] = ['type', 'resourceUri', 'schemaName', 'columnObjectName'];

function dsValue(ds: ViewDataSource, field: DataSourceField): string {
  switch (field) {
    case 'type':
      return ds.type.toUpperCase();
    case 'resourceUri':
      return ds.resourceUri ?? '';
    case 'schemaName':
      // 规则 7：BW 源系统名 ABAP 与真实 schema SAPABAP1 是同一物，先归一（与预览/诊断共用同一映射）
      return normalizeBwSchema(ds.schemaName ?? '');
    case 'columnObjectName':
      return ds.columnObjectName ?? '';
  }
}

/** 回执条目：只带 ViewDataSource 的五个字段，可选字段未设置时省略（回执形状稳定） */
function dsEntry(ds: ViewDataSource): ViewDiffDataSource {
  const e: ViewDiffDataSource = { id: ds.id, type: ds.type };
  if (ds.resourceUri !== undefined) e.resourceUri = ds.resourceUri;
  if (ds.schemaName !== undefined) e.schemaName = ds.schemaName;
  if (ds.columnObjectName !== undefined) e.columnObjectName = ds.columnObjectName;
  return e;
}

function diffDataSources(before: ViewDataSource[], after: ViewDataSource[]): ViewDiff['dataSources'] {
  const b = indexById(before);
  const a = indexById(after);
  const added = [...a.keys()]
    .filter((id) => !b.has(id))
    .sort(cmpStr)
    .map((id) => dsEntry(a.get(id)!));
  const removed = [...b.keys()]
    .filter((id) => !a.has(id))
    .sort(cmpStr)
    .map((id) => dsEntry(b.get(id)!));
  const changed: Array<{ id: string; fields: string[] }> = [];
  for (const id of [...a.keys()].filter((k) => b.has(k)).sort(cmpStr)) {
    const fields = DS_FIELDS.filter((f) => dsValue(b.get(id)!, f) !== dsValue(a.get(id)!, f)).sort(cmpStr);
    if (fields.length > 0) changed.push({ id, fields });
  }
  return { added, removed, changed };
}

/* ── 节点 ─────────────────────────────────────────────────── */

type NodeField =
  | 'type'
  | 'joinType'
  | 'joinAttributes'
  | 'attributes'
  | 'calculatedAttributes'
  | 'aggregateBy'
  | 'measures'
  | 'attributeAggregations'
  | 'attributeFilters'
  | 'attributeTypes'
  | 'filter'
  | 'script'
  | 'rank';
/**
 * 逐字段比较的字段位（与 SSD §5.2 的 fields 允许集逐字对齐；改这个清单 = 改契约）。
 * 注意 fields 的完整允许集 = 本清单 ∪ {'inputs'}：'inputs' 由输入绑定比较产出（见 mappingIndex），
 * 不是标量字段位，故不进本数组。
 */
const NODE_FIELDS: NodeField[] = [
  'type',
  'joinType',
  'joinAttributes',
  'attributes',
  'calculatedAttributes',
  'aggregateBy',
  'measures',
  'attributeAggregations',
  'attributeFilters',
  'attributeTypes',
  'filter',
  'script',
  'rank',
];

function measureKey(measures: ViewNodeMeasure[]): string {
  return listKey(
    measures.filter((m) => m.column !== '').map((m) => `${m.column}\u0000${(m.aggregationType ?? '').toLowerCase()}`),
  );
}

/** Rank 归一：partitionBy 是集合（窗口分组顺序无语义）；orderBy 保持**次序**（它定义 SQL ORDER BY，换序即换语义） */
function rankKey(rank: ViewRankDefinition | undefined): string {
  if (!rank) return '';
  const partition = setKey(rank.partitionBy);
  const order = rank.orderBy
    .map((o) => `${o.column}\u0000${(o.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`)
    .join('\u0001');
  return `${partition}\u0002${order}\u0002${rank.threshold}`;
}

/**
 * attributeTypes 比较键：view-types 已声明该字段（P6 解析器从 viewAttribute 的 datatype/length 填充），
 * 直接用声明后的形状按 (id, datatype, length) 三元组比——缺省与显式空串等价（规则 4「缺省 ≡ 空」），
 * 条目按 id 排序（文档序无语义）。此前用稳定 JSON 序列化「结构未知的预留字段」，会把
 * {datatype: undefined} 与缺键当成两种写法（显式 undefined 序列化成 null），是潜在假 diff 源。
 */
function attributeTypesKey(node: ViewNode): string {
  return listKey((node.attributeTypes ?? []).map((t) => `${t.id}\u0000${t.datatype ?? ''}\u0000${t.length ?? ''}`));
}

function nodeFieldValue(node: ViewNode, field: NodeField): string {
  const isAgg = node.type === 'AggregationView';
  switch (field) {
    case 'type':
      return node.type;
    case 'joinType':
      // 缺省 = inner（与推导层 JOIN_TYPE_MAP 同口径）；'left outer' ≡ 'leftOuter'（大小写/空格/下划线无语义）
      return (node.joinType ?? 'inner').toLowerCase().replace(/[\s_]/g, '');
    case 'joinAttributes':
      return setKey(node.joinAttributes);
    case 'attributes':
      return setKey(node.attributes);
    case 'calculatedAttributes':
      // 含公式/类型（改公式或类型必须可见——破坏性判定依赖它）；成对比较不怕条目增删
      return listKey(
        node.calculatedAttributes.map((ca) =>
          [
            ca.id,
            (ca.datatype ?? '').toUpperCase(),
            ca.length ?? '',
            ca.expressionLanguage ?? '',
            ca.formula ?? '',
          ].join('\u0000'),
        ),
      );
    case 'aggregateBy':
      // 规则 2：Aggregation 节点用 aggGroupBy 归一——格式 B 的分组列写在 viewAttribute 集合里
      return setKey(isAgg ? aggGroupBy(node) : node.aggregateBy);
    case 'measures':
      return measureKey(isAgg ? aggMeasures(node) : node.measures);
    case 'attributeAggregations':
      // Aggregation 节点的聚合声明由上面的 measures 归一承载，这里不再单独比（否则 A/B 方言互转必出假 diff）
      return isAgg
        ? ''
        : listKey(node.attributeAggregations.map((m) => `${m.id}\u0000${(m.aggregationType ?? '').toLowerCase()}`));
    case 'attributeFilters':
      // 按 (including, value) 语义元组比；type（SingleValue/MultiValue 形态）是写法不是语义
      return listKey(
        node.attributeFilters.map(
          (af) => `${af.id}\u0000${setKey(af.filters.map((f) => `${f.including ? '1' : '0'}\u0000${f.value ?? ''}`))}`,
        ),
      );
    case 'attributeTypes':
      return attributeTypesKey(node);
    case 'filter':
      return node.filter ?? '';
    case 'script':
      return node.script ?? '';
    case 'rank':
      return rankKey(node.rank);
  }
}

/**
 * 输入绑定索引：target → 排序后的 (inputNode, source) 列表（跨输入合并，但**保留输入归属**）。
 *
 * 为什么必须带 inputNode：只比 target → source 集合时，「Join 左侧输入由 #Proj_A 换成 #Proj_B
 * （两个投影暴露同名同列、映射逐字不变）」完全不产生差异——下游取到的值已变，diff 却报 empty，
 * 这是最隐蔽的语义漂移通道（评审 #1/#2/#9 的实测反例）。列表排序 = 输入次序不参与比较。
 * 没有任何映射的输入不产生条目（此时输入归属在映射层面不可见；Union 走 inputBindingKey 的引用集合分支）。
 */
function mappingIndex(node: ViewNode): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const inp of node.inputs) {
    // 输入引用统一去掉 # 前缀：同一节点的 "#P1"/"P1" 两种写法等价（# 是 XML 引用语法糖，不是身份）
    const input = inp.node.replace(/^#/, '');
    for (const { target, source } of inp.mappings) {
      if (target === '' || source === '') continue; // 解析噪声
      let s = m.get(target);
      if (!s) m.set(target, (s = new Set()));
      s.add(`${input}\u0000${source}`);
    }
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort(cmpStr)] as const));
}

/**
 * 输入绑定的比较键（比较用规范序列化，见文件头规则 8）：
 * - 非 Union：映射索引 target → 排序后的 (inputNode, source)——输入换人（映射逐字同名）/ 映射重指向
 *   都会改变键 ⇒ 命中 'inputs'；
 * - Union：只比输入节点引用集合——「列按名对齐」的既有归一决定 Union 的映射（含缺映射）无语义，
 *   但输入集合必须比：增/删输入改变行集合（哪怕列同名，评审反例 b）；重排不改变集合 ⇒ 不产生差异。
 */
function inputBindingKey(node: ViewNode): string {
  if (node.type === 'UnionView') {
    return setKey(node.inputs.map((i) => i.node.replace(/^#/, '')));
  }
  const idx = mappingIndex(node);
  return [...idx.keys()]
    .sort(cmpStr)
    .map((t) => `${t}\u0002${idx.get(t)!.join('\u0001')}`)
    .join('\u0003');
}

/** target → 源列集合（跨输入合并、丢弃输入归属）：仅用于产出 mappings 差量回执（ViewDiffMappingDelta 的既有形状） */
function mappingSources(node: ViewNode): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  for (const inp of node.inputs) {
    for (const { target, source } of inp.mappings) {
      if (target === '' || source === '') continue; // 解析噪声
      let s = m.get(target);
      if (!s) m.set(target, (s = new Set()));
      s.add(source);
    }
  }
  return new Map([...m].map(([k, v]) => [k, [...v].sort(cmpStr)] as const));
}

function diffMappings(b: ViewNode, a: ViewNode): ViewDiffMappingDelta {
  // 规则 3：Union 列按名对齐——列序不同/映射缺失不算变更，跳过 mappings 差量（输入集合仍比，见 inputBindingKey）
  if (b.type === 'UnionView' || a.type === 'UnionView') return { added: [], removed: [], retargeted: [] };
  const bm = mappingSources(b);
  const am = mappingSources(a);
  const added: ViewNodeMapping[] = [];
  const removed: ViewNodeMapping[] = [];
  const retargeted: Array<{ target: string; from: string; to: string }> = [];
  for (const target of [...new Set([...bm.keys(), ...am.keys()])].sort(cmpStr)) {
    const bs = bm.get(target) ?? [];
    const as2 = am.get(target) ?? [];
    if (bs.length === 1 && as2.length === 1 && bs[0] !== as2[0]) {
      retargeted.push({ target, from: bs[0], to: as2[0] });
      continue;
    }
    for (const s of as2.filter((x) => !bs.includes(x))) added.push({ target, source: s });
    for (const s of bs.filter((x) => !as2.includes(x))) removed.push({ target, source: s });
  }
  const byTargetSource = (x: ViewNodeMapping, y: ViewNodeMapping): number =>
    cmpStr(x.target, y.target) || cmpStr(x.source, y.source);
  added.sort(byTargetSource);
  removed.sort(byTargetSource);
  return { added, removed, retargeted };
}

function nodeChange(b: ViewNode, a: ViewNode): ViewDiffNodeChange | undefined {
  const fields: string[] = NODE_FIELDS.filter((f) => nodeFieldValue(b, f) !== nodeFieldValue(a, f)).sort(cmpStr);
  // 规则 8：输入绑定参与比较——命中即标记 'inputs'（新增允许值），与逐字段位并列（mappings 只是列级明细）
  if (inputBindingKey(b) !== inputBindingKey(a)) fields.push('inputs');
  const mappings = diffMappings(b, a);
  const mappingsChanged = mappings.added.length > 0 || mappings.removed.length > 0 || mappings.retargeted.length > 0;
  if (fields.length === 0 && !mappingsChanged) return undefined;
  return { id: a.id, type: a.type, fields: fields.sort(cmpStr), mappings };
}

function diffNodes(before: ViewNode[], after: ViewNode[]): ViewDiff['nodes'] {
  const b = indexById(before);
  const a = indexById(after);
  const added = [...a.keys()]
    .filter((id) => !b.has(id))
    .sort(cmpStr)
    .map((id) => ({ id, type: a.get(id)!.type }));
  const removed = [...b.keys()]
    .filter((id) => !a.has(id))
    .sort(cmpStr)
    .map((id) => ({ id, type: b.get(id)!.type }));
  const changed: ViewDiffNodeChange[] = [];
  for (const id of [...a.keys()].filter((k) => b.has(k)).sort(cmpStr)) {
    const c = nodeChange(b.get(id)!, a.get(id)!);
    if (c) changed.push(c);
  }
  return { added, removed, changed };
}

/* ── 输出节点 ─────────────────────────────────────────────── */

/** raw 里 logicalModel 的 id（只取一个属性值，不做任何 raw 比较——布局噪声仍不参与 diff） */
function logicalModelId(raw: unknown): string | undefined {
  if (raw === null || typeof raw !== 'object') return undefined;
  const root = Object.entries(raw as Record<string, unknown>).find(([k]) => !k.startsWith('?'))?.[1];
  if (root === null || typeof root !== 'object') return undefined;
  const lm = (root as Record<string, unknown>)['logicalModel'];
  const lmObj = Array.isArray(lm) ? lm[0] : lm;
  const id = lmObj !== null && typeof lmObj === 'object' ? (lmObj as Record<string, unknown>)['@_id'] : undefined;
  return typeof id === 'string' && id !== '' ? id : undefined;
}

/**
 * 输出节点 = 图论汇点（无任何节点引用它）。单汇点时以图为准；
 * 多汇点（残留孤儿节点）/零汇点（环/空节点树）时退化为 XML 里 logicalModel 的显式声明，仍不可判则 undefined。
 */
function resolveOutputNode(def: ViewDefinition): string | undefined {
  const referenced = new Set<string>();
  for (const n of def.nodes) for (const inp of n.inputs) referenced.add(inp.node.replace(/^#/, ''));
  const sinks = def.nodes
    .filter((n) => n.id !== '' && !referenced.has(n.id))
    .map((n) => n.id)
    .sort(cmpStr);
  if (sinks.length === 1) return sinks[0];
  return logicalModelId(def.raw);
}

/**
 * 重挂证据判定：after 定义里 `to` 节点是否有一条输入直接指向 `from`（新输出节点站在旧输出节点
 * 之上的直通形态——add_join 的机械重挂）。只在 from/to 都有值时才有意义；缺任一侧 ⇒ false
 * （无证据可给，豁免不得成立）。
 */
function isPassThrough(after: ViewDefinition, from: string, to: string): boolean {
  const node = after.nodes.find((n) => n.id === to);
  if (!node) return false;
  return node.inputs.some((inp) => inp.node.replace(/^#/, '') === from);
}

function diffOutputNode(before: ViewDefinition, after: ViewDefinition): ViewDiff['output'] {
  const from = resolveOutputNode(before);
  const to = resolveOutputNode(after);
  if (from === to) return { changed: false };
  const out: ViewDiff['output'] = {
    changed: true,
    passThrough: from !== undefined && to !== undefined && isPassThrough(after, from, to),
  };
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

/* ── 输出字段 ─────────────────────────────────────────────── */

const OUTPUT_LISTS: ViewOutputList[] = [
  'attributes',
  'calculatedAttributes',
  'measures',
  'calculatedMeasures',
  'restrictedMeasures',
];

type OutputFieldName =
  | 'datatype'
  | 'length'
  | 'aggregationType'
  | 'measureType'
  | 'sourceColumn'
  | 'sourceObject'
  | 'description'
  | 'key'
  | 'hidden'
  | 'order'
  | 'formula'
  | 'expressionLanguage';
/** 与 SSD §5.2 的 fields 允许集逐字对齐 */
const OUTPUT_FIELDS: OutputFieldName[] = [
  'datatype',
  'length',
  'aggregationType',
  'measureType',
  'sourceColumn',
  'sourceObject',
  'description',
  'key',
  'hidden',
  'order',
  'formula',
  'expressionLanguage',
];

function outputFieldValue(f: ViewOutputField, name: OutputFieldName): string {
  switch (name) {
    case 'datatype':
      return (f.datatype ?? '').toUpperCase();
    case 'length':
      return f.length ?? '';
    case 'aggregationType':
      return (f.aggregationType ?? '').toLowerCase();
    case 'measureType':
      return (f.measureType ?? '').toLowerCase();
    case 'sourceColumn':
      return f.sourceColumn ?? '';
    case 'sourceObject':
      return f.sourceObject ?? '';
    case 'description':
      return f.description ?? '';
    case 'key':
      return f.key ? 'true' : 'false';
    case 'hidden':
      return f.hidden ? 'true' : 'false';
    case 'order':
      // 规则 1 的例外：order 当**值**比（undefined 与具体值可区分；不按数组下标比）
      return f.order === undefined ? '' : String(f.order);
    case 'formula':
      return f.formula ?? '';
    case 'expressionLanguage':
      return f.expressionLanguage ?? '';
  }
}

interface OutputEntry {
  list: ViewOutputList;
  id: string;
}

function diffOutputs(before: ViewOutputs, after: ViewOutputs): ViewDiff['outputs'] {
  const added: OutputEntry[] = [];
  const removed: OutputEntry[] = [];
  const changed: Array<OutputEntry & { fields: string[] }> = [];
  for (const list of OUTPUT_LISTS) {
    const b = indexById(before[list]);
    const a = indexById(after[list]);
    for (const id of a.keys()) if (!b.has(id)) added.push({ list, id });
    for (const id of b.keys()) if (!a.has(id)) removed.push({ list, id });
    for (const id of a.keys()) {
      if (!b.has(id)) continue;
      const fields = OUTPUT_FIELDS.filter(
        (n) => outputFieldValue(b.get(id)!, n) !== outputFieldValue(a.get(id)!, n),
      ).sort(cmpStr);
      if (fields.length > 0) changed.push({ list, id, fields });
    }
  }
  const byIdThenList = (x: OutputEntry, y: OutputEntry): number => cmpStr(x.id, y.id) || cmpStr(x.list, y.list);
  added.sort(byIdThenList);
  removed.sort(byIdThenList);
  changed.sort(byIdThenList);
  return { added, removed, changed };
}

/* ── 变量 ─────────────────────────────────────────────────── */

type VariableField = 'parameter' | 'datatype' | 'length' | 'defaultValue' | 'mandatory' | 'description';
const VARIABLE_FIELDS: VariableField[] = [
  'parameter',
  'datatype',
  'length',
  'defaultValue',
  'mandatory',
  'description',
];

function variableFieldValue(v: ViewVariable, name: VariableField): string {
  switch (name) {
    case 'parameter':
      return v.parameter ? 'true' : 'false';
    case 'mandatory':
      return v.mandatory ? 'true' : 'false';
    case 'datatype':
      return (v.datatype ?? '').toUpperCase();
    case 'length':
      return v.length ?? '';
    case 'defaultValue':
      return v.defaultValue ?? '';
    case 'description':
      return v.description ?? '';
  }
}

function diffVariables(before: ViewVariable[], after: ViewVariable[]): ViewDiff['variables'] {
  const b = indexById(before);
  const a = indexById(after);
  const added = [...a.keys()].filter((id) => !b.has(id)).sort(cmpStr);
  const removed = [...b.keys()].filter((id) => !a.has(id)).sort(cmpStr);
  const changed: Array<{ id: string; fields: string[] }> = [];
  for (const id of [...a.keys()].filter((k) => b.has(k)).sort(cmpStr)) {
    const fields = VARIABLE_FIELDS.filter(
      (f) => variableFieldValue(b.get(id)!, f) !== variableFieldValue(a.get(id)!, f),
    ).sort(cmpStr);
    if (fields.length > 0) changed.push({ id, fields });
  }
  return { added, removed, changed };
}

/* ── 根级属性 ─────────────────────────────────────────────── */

type RootField =
  | 'description'
  | 'dataCategory'
  | 'outputViewType'
  | 'checkAnalyticPrivileges'
  | 'applyPrivilegeType'
  | 'dimensionType'
  | 'id'
  | 'schemaVersion';
/** 与 SSD §5.2 的 fields 允许集逐字对齐 */
const ROOT_FIELDS: RootField[] = [
  'description',
  'dataCategory',
  'outputViewType',
  'checkAnalyticPrivileges',
  'applyPrivilegeType',
  'dimensionType',
  'id',
  'schemaVersion',
];

function rootFieldValue(def: ViewDefinition, name: RootField): string {
  switch (name) {
    case 'description':
      return def.description ?? '';
    case 'dataCategory':
      return def.dataCategory ?? '';
    case 'outputViewType':
      return def.outputViewType ?? '';
    case 'checkAnalyticPrivileges':
      return def.checkAnalyticPrivileges ? 'true' : 'false';
    case 'applyPrivilegeType':
      return def.applyPrivilegeType ?? '';
    case 'dimensionType':
      return def.dimensionType ?? '';
    case 'id':
      return def.id;
    case 'schemaVersion':
      return def.schemaVersion ?? '';
  }
}
