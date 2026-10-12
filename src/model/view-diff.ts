import { aggGroupBy, aggMeasures, normalizeBwSchema, sinkNodes } from './view-types.js';
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
 * 两个 ViewDefinition 的**结构化 diff**（dryRun 的地基，SSD §5.2）。
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
 *   8) **输入绑定参与比较**：映射索引按 target → 排序后的
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
const OUTPUT_LISTS = [
  'attributes',
  'calculatedAttributes',
  'measures',
  'calculatedMeasures',
  'restrictedMeasures',
] as const;
export type ViewOutputList = (typeof OUTPUT_LISTS)[number];

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
   * 能否降级为非破坏；证据不成立时不得豁免）：true ⇔ after 定义里 `to` 节点是**透明直通型**的——
   * 类型 ∈ {ProjectionView, JoinView}（JoinView 还要求 joinType = leftOuter——inner/rightOuter/
   * fullOuter 会改 from 侧行集合）、自身没有任何会改行集合/取数口径的配置
   * （aggregateBy / measures / attributeAggregations / attributeFilters / filter / rank / script），
   * 且它引用 `from` 的那条输入边的映射**全部恒等**（target === source）且至少一条。
   * 只看「有一条输入直指 from」不够：在旧输出节点上压一个 Aggregation / 带 filter 的新节点再整体重挂，
   * 形态同样命中，但列名不变、值已变（新节点自身不透明时不是直通证据）。changed=true 时恒带该键
   * （布尔：证据成立与否的一手答案）；changed=false 时不产生 from/to/passThrough（不制造噪音）。
   * from/to 各自缺省 = 该侧输出不可判（图论汇点与 logicalModel 声明分歧，见 resolveOutputNode），
   * 不是「没有输出节点」。两侧都不可判时不短路成 changed=false——退化比较两侧 logicalModel 声明
   * id，声明换人（半重挂对）即如实报 changed=true（不可判 ≠ 未换人，见 diffOutputNode）；声明相同
   * （含两侧都无声明——AV 等无节点树形态）才报 changed=false。
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

/** 数据源逐字段比较的字段位 */
const DS_FIELDS = ['type', 'resourceUri', 'schemaName', 'columnObjectName'] as const;
type DataSourceField = (typeof DS_FIELDS)[number];

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

/**
 * 节点逐字段比较的字段位（与 SSD §5.2 的 fields 允许集逐字对齐；改这个清单 = 改契约）。
 * 注意 fields 的完整允许集 = 本清单 ∪ {'inputs'}：'inputs' 由输入绑定比较产出（见 mappingIndex），
 * 不是标量字段位，故不进本数组。
 */
const NODE_FIELDS = [
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
] as const;
type NodeField = (typeof NODE_FIELDS)[number];

/**
 * joinType 归一（与推导层 preview.derive 的 JOIN_TYPE_MAP 同口径）：缺省 = inner；
 * 'left outer' ≡ 'leftOuter'（大小写/空格/下划线无语义）。字段比较与 isPassThrough 的透明性判定
 * 共用这一处——同一份 XML 不会被两个口径各自解读。
 */
function normalizeJoinType(node: ViewNode): string {
  return (node.joinType ?? 'inner').toLowerCase().replace(/[\s_]/g, '');
}

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
 * attributeTypes 比较键：view-types 已声明该字段（解析器从 viewAttribute 的 datatype/length 填充），
 * 直接用声明后的形状按 (id, datatype, length) 三元组比——缺省与显式空串等价（规则 4「缺省 ≡ 空」），
 * 条目按 id 排序（文档序无语义）。datatype 先 toUpperCase 再比（HANA 类型名大小写不敏感，口径同
 * outputs/variables 的 datatype 字段）：仅大小写不同不是节点级类型变更——否则有下游时会造成假破坏
 * 与无意义的 migration_required 拒写。不要退回对象序列化：它会把「显式空串」与「缺省/undefined」
 * 劈成两种写法（'' 序列化为 ""，而 undefined 与缺键同等丢键）——恰好违反规则 4「缺省 ≡ 空」，
 * 制造假 diff；本键的 `?? ''` 归一正是为此。
 */
function attributeTypesKey(node: ViewNode): string {
  return listKey(
    (node.attributeTypes ?? []).map((t) => `${t.id}\u0000${(t.datatype ?? '').toUpperCase()}\u0000${t.length ?? ''}`),
  );
}

function nodeFieldValue(node: ViewNode, field: NodeField): string {
  const isAgg = node.type === 'AggregationView';
  switch (field) {
    case 'type':
      return node.type;
    case 'joinType':
      return normalizeJoinType(node);
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
 * 遍历节点的全部输入映射（两处映射索引**唯一**的迭代实现）：`#` 前缀归一是引用语法糖、空 target/source
 * 是解析噪声——过滤口径必须两处一致，否则 'inputs' 判定与 mappings 差量回执会对同一份文件各说各话。
 * 回调拿到「输入节点 id（已去 #）+ target + source」。
 */
function forEachMapping(node: ViewNode, visit: (target: string, input: string, source: string) => void): void {
  for (const inp of node.inputs) {
    // 输入引用统一去掉 # 前缀：同一节点的 "#P1"/"P1" 两种写法等价（# 是 XML 引用语法糖，不是身份）
    const input = inp.node.replace(/^#/, '');
    for (const { target, source } of inp.mappings) {
      if (target === '' || source === '') continue; // 解析噪声
      visit(target, input, source);
    }
  }
}

/**
 * 输入绑定索引：target → 排序后的 (inputNode, source) 列表（跨输入合并，但**保留输入归属**）。
 *
 * 为什么必须带 inputNode：只比 target → source 集合时，「Join 左侧输入由 #Proj_A 换成 #Proj_B
 * （两个投影暴露同名同列、映射逐字不变）」完全不产生差异——下游取到的值已变，diff 却报 empty，
 * 这是最隐蔽的语义漂移通道。列表排序 = 输入次序不参与比较。
 * 没有任何映射的输入不产生条目（此时输入归属在映射层面不可见；Union 走 inputBindingKey 的引用集合分支）。
 */
function mappingIndex(node: ViewNode): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  forEachMapping(node, (target, input, source) => {
    let s = m.get(target);
    if (!s) m.set(target, (s = new Set()));
    s.add(`${input}\u0000${source}`);
  });
  return new Map([...m].map(([k, v]) => [k, [...v].sort(cmpStr)] as const));
}

/**
 * 输入绑定的比较键（比较用规范序列化，见文件头规则 8）：
 * - 非 Union：映射索引 target → 排序后的 (inputNode, source)——输入换人（映射逐字同名）/ 映射重指向
 *   都会改变键 ⇒ 命中 'inputs'；
 * - Union：只比输入节点引用集合——「列按名对齐」的既有归一决定 Union 的映射（含缺映射）无语义，
 *   但输入集合必须比：增/删输入改变行集合（哪怕列同名）；重排不改变集合 ⇒ 不产生差异。
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

/**
 * target → 源列集合（同一 forEachMapping 迭代的投影：跨输入合并、丢弃输入归属）：
 * 仅用于产出 mappings 差量回执（ViewDiffMappingDelta 的既有形状）——与 inputBindingKey 的
 * 'inputs' 判定同源，两者不会对同一份文件给出互相矛盾的解释。
 */
function mappingSources(node: ViewNode): Map<string, string[]> {
  const m = new Map<string, Set<string>>();
  forEachMapping(node, (target, _input, source) => {
    let s = m.get(target);
    if (!s) m.set(target, (s = new Set()));
    s.add(source);
  });
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
  // 规则 8：输入绑定参与比较——命中即标记 'inputs'（新增允许值），与逐字段位并列（mappings 只是列级明细）。
  // mappings 差量不需要单独充当「节点有变更」的判据：非 Union 节点的映射集合变化必然已把 'inputs'
  // 推进 fields（mappingSources 与 inputBindingKey 走同一迭代），Union 的 mappings 差量恒为空。
  if (inputBindingKey(b) !== inputBindingKey(a)) fields.push('inputs');
  if (fields.length === 0) return undefined;
  return { id: a.id, type: a.type, fields: fields.sort(cmpStr), mappings: diffMappings(b, a) };
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
 * 输出节点判定 = 图论汇点与 XML 里 logicalModel 显式声明**两口径一致**时才可判：
 * - 单汇点且与声明一致（或 XML 无声明——AV 等形态）：该汇点；
 * - 单汇点与声明分歧（半重挂/脏视图）：不可判 ⇒ undefined，**不静默选边**——否则回执的
 *   output.from/to/passThrough 建立在错节点上（声明输出真的换人却被报成「未换人」）；
 * - 多汇点（残留孤儿节点）/零汇点（环/空节点树）：退化为显式声明，仍不可判则 undefined。
 * 汇点枚举共用 view-types.sinkNodes（引用语法的唯一实现，与 view-edit 的 add_join 判定同源）；
 * 空 id 节点是解析噪声（见 indexById 头注），不进汇点集合。
 * 两侧都不可判（本函数两侧均为 undefined）不是可比较结论：diffOutputNode 对它退化为比较两侧的
 * logicalModel 声明（不可判 ≠ 未换人）。
 */
function resolveOutputNode(def: ViewDefinition): string | undefined {
  const declared = logicalModelId(def.raw);
  const sinks = sinkNodes(def.nodes)
    .filter((n) => n.id !== '')
    .map((n) => n.id)
    .sort(cmpStr);
  if (sinks.length === 1) {
    if (declared !== undefined && declared !== sinks[0]) return undefined; // 两口径分歧：不可判
    return sinks[0];
  }
  return declared;
}

/**
 * 重挂证据判定：after 定义里 `to` 节点是否是对 `from` 的**透明直通重挂**（add_join 的机械重挂形态）。
 * 只在 from/to 都有值时才有意义；缺任一侧 ⇒ false（无证据可给，豁免不得成立）。
 *
 * 证据必须闭到「直通」语义，不是「有一条输入边」：在旧输出节点上压一个会改变语义的
 * 新节点（Aggregation 聚合 / 带 filter 的行集合变化）再整体重挂输出，同样「有一条输入直指 from」，
 * 列名不变而值已变——旧证据会把它误豁免成非破坏。故还要求：
 *   - `to` 节点类型 ∈ {ProjectionView, JoinView}（透明的重映射节点；Aggregation/Rank/SqlScript 不算）；
 *   - `to` 节点自身没有任何会改行集合/取数口径的配置（aggregateBy / measures / attributeAggregations /
 *     attributeFilters / filter / rank / script）；JoinView 还要求 joinType = leftOuter——过滤型
 *     join（inner/rightOuter/fullOuter，含缺省 = inner）会改变 from 侧行集合，不能作直通证据；
 *   - `to` 引用 `from` 的那条输入边上的映射**全部恒等**（target === source）且至少一条——
 *     没有映射 = 直通无从证明（Union 列按名对齐等形态不算证据，fail-closed）。
 */
function isPassThrough(after: ViewDefinition, from: string, to: string): boolean {
  const node = after.nodes.find((n) => n.id === to);
  if (!node) return false;
  if (node.type !== 'ProjectionView' && node.type !== 'JoinView') return false;
  // JoinView 的 joinType 决定行集合是否被改：只有左外连接保留左侧输入（add_join 的机械重挂里 from
  // 恒为左输入）的全部行——inner 丢无匹配左行、rightOuter 丢左行、fullOuter 增补未匹配行，都会改
  // 行集合，不能算透明直通。缺省 joinType = inner（同 normalizeJoinType），一并拒绝。
  if (node.type === 'JoinView' && normalizeJoinType(node) !== 'leftouter') return false;
  if (
    node.aggregateBy.length > 0 ||
    node.measures.length > 0 ||
    node.attributeAggregations.length > 0 ||
    node.attributeFilters.length > 0 ||
    node.filter !== undefined ||
    node.rank !== undefined ||
    node.script !== undefined
  ) {
    return false;
  }
  const edge = node.inputs.find((inp) => inp.node.replace(/^#/, '') === from);
  if (!edge) return false;
  return edge.mappings.length > 0 && edge.mappings.every((m) => m.target === m.source);
}

function diffOutputNode(before: ViewDefinition, after: ViewDefinition): ViewDiff['output'] {
  const from = resolveOutputNode(before);
  const to = resolveOutputNode(after);
  // 只有两侧都判到、且判到同一节点，才是「未换人」。
  if (from !== undefined && from === to) return { changed: false };
  // 两侧都不可判（undefined === undefined）不能短路成 changed=false：那正是把「不可判」呈现为
  // 「未换人」——声明输出真的换人（如 P1→P2 的半重挂对）会被报成未换。changed 的一手依据是
  // 「把结果交给 logicalModel 的那个节点」，此时退化比较两侧 logicalModel 声明 id：相同（含两侧
  // 都无声明——AV 等无节点树形态）报无变化；不同即如实报 changed=true（from/to 缺省 = 该侧不可判；
  // passThrough=false——两侧不可判时不给豁免证据）。
  if (from === undefined && to === undefined && logicalModelId(before.raw) === logicalModelId(after.raw)) {
    return { changed: false };
  }
  const out: ViewDiff['output'] = {
    changed: true,
    passThrough: from !== undefined && to !== undefined && isPassThrough(after, from, to),
  };
  if (from !== undefined) out.from = from;
  if (to !== undefined) out.to = to;
  return out;
}

/* ── 输出字段 ─────────────────────────────────────────────── */

/** 输出字段逐字段比较的字段位（与 SSD §5.2 的 fields 允许集逐字对齐） */
const OUTPUT_FIELDS = [
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
] as const;
export type OutputFieldName = (typeof OUTPUT_FIELDS)[number];

/**
 * 输出字段位的分类——判定表的判据面，分类决策的**单一事实源**：
 *   - 'type'：       数据类型声明（datatype / length）——改类型可 cast / 保列新建 / move；
 *   - 'resolution'： 取数解析（sourceColumn / sourceObject / aggregationType / measureType / formula /
 *                    expressionLanguage）——解析变了，下游按原解析消费会受影响；
 *   - 'display'：    展示属性（description / key / hidden / order）——即便有下游引用也永不破坏。
 * 用 Record<OutputFieldName, …> 穷尽收口：新增字段位不在这里补录就编译不过——
 * 消费方（services/migrate.rules 的判定表）从本映射取分类，不手抄子集，
 * 避免新字段位被静默归入「展示类、永不破坏」。
 */
export type OutputFieldCategory = 'type' | 'resolution' | 'display';

/** OUTPUT_FIELDS 每一位 → 分类（穷尽映射，见 OutputFieldCategory） */
export const OUTPUT_FIELD_CATEGORY: Record<OutputFieldName, OutputFieldCategory> = {
  datatype: 'type',
  length: 'type',
  sourceColumn: 'resolution',
  sourceObject: 'resolution',
  aggregationType: 'resolution',
  measureType: 'resolution',
  formula: 'resolution',
  expressionLanguage: 'resolution',
  description: 'display',
  key: 'display',
  hidden: 'display',
  order: 'display',
};

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

/** 变量逐字段比较的字段位 */
const VARIABLE_FIELDS = ['parameter', 'datatype', 'length', 'defaultValue', 'mandatory', 'description'] as const;
type VariableField = (typeof VARIABLE_FIELDS)[number];

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

/** 根级属性逐字段比较的字段位（与 SSD §5.2 的 fields 允许集逐字对齐） */
const ROOT_FIELDS = [
  'description',
  'dataCategory',
  'outputViewType',
  'checkAnalyticPrivileges',
  'applyPrivilegeType',
  'dimensionType',
  'id',
  'schemaVersion',
] as const;
type RootField = (typeof ROOT_FIELDS)[number];

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
