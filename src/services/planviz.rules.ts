import {
  formatRows,
  renderConclusionText,
  type Finding,
  type PlanConclusion,
  type PlanStatistics,
  type PlanTableRef,
} from './sql-analyze.rules.js';

/**
 * PlanViz 通道的**纯函数层**：把服务端返回的计划 XML 解析成六栏模型，并据此产出实测结论。
 * 零 I/O——取数在 sql-analyze.service.ts，本文件只做"文本 → 结构 → 判断"。
 *
 * 动作码来自 HANA Studio 客户端本体（com.sap.ndb.planviz.protocol.base.PlanVizAction，55 项枚举），
 * 全部实机验证过：101/102 是旧协议（本版本必报 "Could not find PlanViz context"），103/110 可用。
 */
export const PLANVIZ_ACTION = {
  /** 建立 planviz 会话（VER3；VER2=102、VER10=110 亦可，101 在本版本不可用） */
  ON: 103,
  /** 关闭 planviz 会话 */
  OFF: 900,
  /** 编译语句并返回 Statement ID（queryId） */
  PREPARE: 201,
  /** 取计划（估计版；执行过之后同一个 id 取到的即执行版） */
  GET_PLAN: 301,
  /** 取计划（trace 口径，与 GET_PLAN 实测等价） */
  GET_TRACE: 401,
  /** 取计划 + 表信息（客户端 getTrace() 用的就是这条） */
  GET_TABLE_INFORMATION_TRACE: 402,
} as const;

/** PREPARE 返回的 Statement ID 形态：`<连接号>_<大写十六进制>`。用于拼执行语句前的**形状校验** */
export const QUERY_ID_RE = /^[0-9]+_[0-9A-F]+$/;

/** 子引用（`<Child ID>` 块）：HANA 把**实测行数/取数次数记在边上**，不记在算子自己身上 */
export interface PlanVizChildEdge {
  id: string;
  /** 该子算子的实际输出行数（记在父算子的 Child 块里） */
  rows?: number;
  fetchCount?: number;
}

export interface PlanVizOperator {
  id: string;
  /** 算子类型（Relation/@TypeName，如 TABLE SCAN / AGGREGATION / MATERIALIZE） */
  operator: string;
  status?: string;
  /** 算子显示名（<Name>，通常带表名与过滤细节） */
  name?: string;
  /** 执行引擎（<ExecutionType>，如 ROW / COLUMN / HEX） */
  engine?: string;
  schema?: string;
  object?: string;
  objectType?: string;
  /** 以下时间单位均为**微秒**（HANA 的 ExecutionTime 口径） */
  startUs?: number;
  endUs?: number;
  exclusiveUs?: number;
  inclusiveUs?: number;
  userCpuUs?: number;
  kernelCpuUs?: number;
  estimatedCardinality?: number;
  /** 实际输出行数：**由父算子的 Child 块回填**（根算子没有父，故为 undefined） */
  actualCardinality?: number;
  estimatedCost?: number;
  memoryBytes?: number;
  childIds: string[];
  edges: PlanVizChildEdge[];
  /** 从根算起算出的层深（0=根） */
  level: number;
  /** true=来自 <InnerPlans>（逻辑/估计内层计划），不算主物理计划的算子 */
  inInnerPlan: boolean;
}

export interface PlanVizPlan {
  version?: number;
  planId?: string;
  /** Executed=含逐算子实测；Estimated=只有编译期估计 */
  type: string;
  planType?: string;
  sql: string;
  /** **全部**算子：主计划 + 所有子计划（下推子计划里的热点往往才是真答案，不能只看主计划树） */
  operators: PlanVizOperator[];
  /** 主计划作用域内的算子（不含子计划）——只用于说明"主干有多大" */
  primaryOperators: PlanVizOperator[];
  /** 全部算子里的根（没有被任何算子引用的那些） */
  rootIds: string[];
  /** 主计划作用域内的根 */
  primaryRootIds: string[];
  /** 从根走不到、也不构成任何根的孤立算子数（计划结构异常的信号） */
  orphanCount: number;
  /** 出现过的执行线程数（从 Timestamps 里的 thread 收集；无实测时为 0） */
  threadCount: number;
  timelineStartUs?: number;
  timelineEndUs?: number;
  /** <InnerPlans> 容器个数（每个算子自带的内层计划槽位） */
  innerPlanBlocks: number;
  /** 子计划片段总数（除主计划外的 `<Plan>` 元素：逻辑内层计划 + 下推到别的引擎的子计划） */
  subPlanCount: number;
  /** 其中 PlanType="Logical" 的逻辑/估计内层计划个数 */
  logicalPlanCount: number;
  /** 实测口径是否可用：至少一个算子带 ExecutionTime/Inclusive */
  measured: boolean;
}

/** 六栏 = 官方 PlanViz 界面的六块。默认输出只给可读结论文本；这里是结构化落点 */
export interface PlanVizPanels {
  /** ① Plan Graph：父子结构与算子类型分布 */
  planGraph: {
    operators: number;
    roots: number;
    edges: number;
    byOperator: Array<{ operator: string; count: number }>;
    /** 缩进树（有界：超限时截断并标注） */
    tree: string;
  };
  /** ② Physical Plan：最耗时的算子（无实测时按估计基数排序） */
  physicalPlan: PlanVizOperatorSummary[];
  /** ③ Execution Time：逐算子实测耗时 */
  executionTime: {
    measured: boolean;
    /** 整体执行时间（微秒）：时间轴跨度口径，见 totalInclusiveUs 的说明 */
    totalInclusiveUs?: number;
    operatorsMeasured: number;
    operatorsTotal: number;
    unit: 'us';
  };
  /** ④ Timeline：时间轴跨度与并行度 */
  timeline: {
    measured: boolean;
    spanUs?: number;
    threads: number;
    /** 起止时间最早/最晚的算子（时间轴的两端） */
    slowestSpan?: { operator: string; operatorId: string; startUs: number; endUs: number };
  };
  /** ⑤ Table Access：按访问对象聚合（**已按 PANEL_TABLE_LIMIT 截断**，全量见 statistics.tables） */
  tableAccess: PlanVizObjectAccess[];
  /** ⑥ Logical Plan：内层（逻辑/估计）计划与子计划 */
  logicalPlan: { blocks: number; logicalPlans: number; subPlans: number; operators: number };
}

export interface PlanVizOperatorSummary {
  operatorId: string;
  operator: string;
  name?: string;
  engine?: string;
  exclusiveUs?: number;
  inclusiveUs?: number;
  userCpuUs?: number;
  actualCardinality?: number;
  estimatedCardinality?: number;
  /** 独占耗时占整体执行时间的百分比（无实测时缺省） */
  exclusiveSharePct?: number;
}

/** 面板里逐算子/逐表条目的上限（避免大计划把输出撑爆；raw=true 时另有全量） */
export const PANEL_OPERATOR_LIMIT = 15;
export const PANEL_TABLE_LIMIT = 10;
export const PANEL_TREE_LIMIT = 60;

// ── XML 解析 ─────────────────────────────────────────────────

/** 取 `<tag>…</tag>` 的内容（去 CDATA 包裹）。找不到返回 undefined */
function tag(body: string, name: string): string | undefined {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(body);
  return m ? stripCdata(m[1].trim()) : undefined;
}

function stripCdata(s: string): string {
  const m = /^<!\[CDATA\[([\s\S]*?)\]\]>$/.exec(s.trim());
  return m ? m[1] : s;
}

function attr(head: string, name: string): string | undefined {
  return new RegExp(`\\b${name}="([^"]*)"`).exec(head)?.[1];
}

/** 数字解析：非数字/空一律 undefined（计划里不少字段是空串） */
function numOf(v: string | undefined): number | undefined {
  if (v === undefined || v === '') return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * 取带单位的**时间**字段，统一归一到微秒。
 *
 * ⚠ 必须看 `Unit` 属性：**同一份计划里单位是混用的**——实测那份 10.7MB 计划里有
 * 688 个 `<Exclusive Unit="ms">`（最大 7952.273，即 7.95 s）与 147 个 `Unit="us"`。
 * 一律按 µs 读会把毫秒值缩小 1000 倍，**直接翻转"谁是瓶颈"的结论**（实测症状：
 * 真正的瓶颈算子被算成"占整体 0%"，而 summary 照此报出去）。
 * 缺省按 µs——HANA 计划里绝大多数时间字段是 µs。
 */
function timeUs(body: string, name: string): number | undefined {
  const m = new RegExp(`<${name}(?:\\s+Unit="([^"]*)")?\\s*>([\\s\\S]*?)</${name}>`).exec(body);
  if (m === null) return undefined;
  const v = Number(m[2].trim());
  if (!Number.isFinite(v)) return undefined;
  switch ((m[1] ?? 'us').toLowerCase()) {
    case 'ms':
      return v * 1000;
    case 's':
      return v * 1_000_000;
    default:
      return v;
  }
}

/**
 * 扫描 `<Relation>`：**必须按嵌套处理，正则匹配不成立**。
 *
 * 实测结构（一份 10.7MB 的大计划里）：
 * ```xml
 * <Relation ID="P" TypeName="TREX_SEARCH">
 *   <Name>COLUMN SEARCH</Name><ExecutionTime>…</ExecutionTime>
 *   <Child ID="C">                                ← 边数据（C 的实测行数）
 *     <ExecutedOutputCardinality>3</…>
 *     <Relation ID="C" TypeName="GROUP_BY">…</Relation>   ← 子算子的 Relation 就嵌在 Child 里
 *   </Child>
 * </Relation>
 * ```
 * 也就是说 `<Relation>` 是**物理嵌套**的（`_2` 里嵌着 `_2_1`/`_2_2`）。非贪婪正则会在第一个
 * `</Relation>` 处截断，父算子的 ExecutionTime 与 Child 引用会整段丢失——实测表现为
 * "844 个 Relation 只解析出 361 个、根算子虚增到 251 个"。故改用栈式配对，
 * 并把**自己的字段**（不含嵌套子块）与**边**分开取。
 */
interface RawRelation {
  head: string;
  /** 本算子自己的字段区（已剔除所有嵌套 Relation 块，避免读到子算子的值） */
  own: string;
  start: number;
}

function scanRelations(text: string): RawRelation[] {
  // 根算子写作 `<RootRelation …>`（每个真机样本都有），**不是** `<Relation …>` 的变体写法所以
  // 必须单独认；只匹配 `<Relation` 会把真正的根整段丢掉（实测：15 个算子只解析出 14 个，
  // 算子树从第二层开始、根算子的 ExecutionTime 与 Child 边完全不进六栏）。
  // 自闭合 `<Relation … />` 也要认：按开标签压栈会吞掉后面内容、错挂到别的算子上。
  const tokens = /<(?:Root)?Relation\s+([^>]*?)(\/?)>|<\/(?:Root)?Relation>/g;
  const stack: Array<{ head: string; start: number; openEnd: number; nested: Array<{ s: number; e: number }> }> = [];
  const out: RawRelation[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(text)) !== null) {
    if (!m[0].startsWith('</')) {
      const selfClosing = m[2] === '/';
      if (selfClosing) {
        // 无内容也无子节点：直接产出，并登记给父级以便从父的字段区里剔除
        out.push({ head: m[1], own: '', start: m.index });
        const parent = stack[stack.length - 1];
        if (parent) parent.nested.push({ s: m.index, e: m.index + m[0].length });
        continue;
      }
      stack.push({ head: m[1], start: m.index, openEnd: m.index + m[0].length, nested: [] });
      continue;
    }
    const top = stack.pop();
    if (top === undefined) continue; // 多余的闭合标签：忽略，不中断解析
    const end = m.index + m[0].length;
    let own = text.slice(top.openEnd, m.index);
    for (const span of [...top.nested].reverse()) {
      const a = span.s - top.openEnd;
      const b = span.e - top.openEnd;
      if (a >= 0 && b <= own.length) own = own.slice(0, a) + own.slice(b);
    }
    out.push({ head: top.head, own, start: top.start });
    const parent = stack[stack.length - 1];
    if (parent) parent.nested.push({ s: top.start, e: end });
  }
  return out;
}

/**
 * 求某个元素的**成对区间**（按括号扫描，不用正则配对）。
 *
 * 为什么不能用 `/<X>[\s\S]*?<\/X>/g`：元素会嵌套，非贪婪匹配会在第一个闭合标签处收尾，
 * 剩下的闭合标签会把后续区间整体错位——实测后果是主计划算子被误判成内层计划
 * （那份大计划里 844 个 Relation 被切成"主 361 / 内层 483"，而真实内层区间只有 243 段）。
 *
 * `everyDepth=true` 时每一对开闭都算一段（含嵌套的），否则只给最外层。
 */
function elementRanges(xml: string, name: string, everyDepth = false): Array<{ s: number; e: number }> {
  const tokens = new RegExp(`<${name}(?:\\s[^>]*?)?(\\/)?>|</${name}>`, 'g');
  const ranges: Array<{ s: number; e: number }> = [];
  const open: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = tokens.exec(xml)) !== null) {
    if (m[0].startsWith('</')) {
      const start = open.pop();
      if (start === undefined) continue;
      if (everyDepth || open.length === 0) ranges.push({ s: start, e: m.index + m[0].length });
      continue;
    }
    // 自闭合元素不参与配对
    if (m[1] !== '/') open.push(m.index);
  }
  return ranges;
}

/** 某个位置是否落在任一区间内 */
const within = (ranges: Array<{ s: number; e: number }>, pos: number): boolean =>
  ranges.some((r) => pos >= r.s && pos < r.e);

/** 从算子自己的字段区取边：`<Child ID="X" />` 无数据，`<Child ID="X">…` 里带该孩子的实测行数 */
function parseEdges(own: string): PlanVizChildEdge[] {
  const edges: PlanVizChildEdge[] = [];
  for (const c of own.matchAll(/<Child\s+ID="([^"]+)"\s*\/>/g)) edges.push({ id: c[1] });
  // 边数据在嵌套的 <Relation> 之前，故截到下一个 <Relation 或 </Child 为止
  for (const c of own.matchAll(/<Child\s+ID="([^"]+)"\s*>([\s\S]*?)(?=<Relation\s|<\/Child>|$)/g)) {
    const seg = c[2];
    edges.push({
      id: c[1],
      ...withDefined('rows', numOf(tag(seg, 'ExecutedOutputCardinality'))),
      ...withDefined('fetchCount', numOf(tag(seg, 'FetchCallCount'))),
    });
  }
  // 同一个 id 两种写法都存在时以带数据的那条为准
  const merged = new Map<string, PlanVizChildEdge>();
  for (const e of edges) merged.set(e.id, { ...merged.get(e.id), ...e });
  return [...merged.values()];
}

/**
 * 解析计划 XML（Executed/Estimated 同 schema，见 README 的实测记录）。
 *
 * 内层计划（`<InnerPlans>`，逻辑/估计内层计划）与主计划同形，靠**字符区间**判定归属：
 * 混在一起会让"算子数/线程数/表访问"全部虚高（实测那份 10.7MB 文件里 844 个 Relation
 * 中有 243 段内层计划）。
 */
export function parsePlanVizXml(xml: string): PlanVizPlan {
  const planTag = /<Plan\s+([^>]*)>/.exec(xml)?.[1] ?? '';
  const innerRanges = elementRanges(xml, 'InnerPlans', true);
  // `<Plan>` 是**计划作用域**：最外层那个是主计划，其余（下推到别的引擎的子计划、逻辑内层计划）
  // 是它的子计划。那种上万算子的大计划里，主计划树只占很小一部分，其余全是子计划——
  // 不按作用域切分就会把"253 个算子、179 个根"这种混算结果当成主计划。
  const planRanges = elementRanges(xml, 'Plan', true);
  const primary = planRanges.reduce<{ s: number; e: number } | undefined>(
    (best, r) => (best === undefined || r.e - r.s > best.e - best.s ? r : best),
    undefined,
  );
  const subPlanRanges = planRanges.filter((r) => r !== primary);
  const planHeads = [...xml.matchAll(/<Plan\s+([^>]*?)\/?>/g)].map((m) => m[1]);
  const logicalPlans = planHeads.filter((h) => /PlanType="Logical"/i.test(h)).length;
  /** Timestamps 里出现过的线程号（执行并行度的唯一来源） */
  const threads = new Set<number>();

  const all = scanRelations(xml).map((raw): PlanVizOperator => {
    const { head, own } = raw;
    const et = tag(own, 'ExecutionTime') ?? '';
    collectThreads(tag(et, 'Timestamps'), threads);
    const edges = parseEdges(own);
    const inSubPlan = within(innerRanges, raw.start) || within(subPlanRanges, raw.start);
    return {
      id: attr(head, 'ID') ?? `#${raw.start}`,
      operator: attr(head, 'TypeName') ?? 'UNKNOWN',
      ...withDefined('status', attr(head, 'Status')),
      ...withDefined('name', tag(own, 'Name')),
      ...withDefined('engine', tag(own, 'ExecutionType')),
      ...withDefined('schema', tag(own, 'Schema')),
      ...withDefined('object', tag(own, 'ObjectName')),
      ...withDefined('objectType', tag(own, 'TableType')),
      ...withDefined('startUs', timeUs(et, 'Start')),
      ...withDefined('endUs', timeUs(et, 'End')),
      ...withDefined('exclusiveUs', timeUs(et, 'Exclusive')),
      ...withDefined('inclusiveUs', timeUs(et, 'Inclusive')),
      ...withDefined('userCpuUs', timeUs(own, 'UserCPUTime')),
      ...withDefined('kernelCpuUs', timeUs(own, 'KernelCPUTime')),
      ...withDefined('estimatedCardinality', numOf(tag(own, 'EstimatedOutputCardinality'))),
      // 估计代价：数值在 <EstimatedCost> 内层的 <Inclusive>（带 Unit），外层本身没有 Unit
      ...withDefined('estimatedCost', timeUs(tag(own, 'EstimatedCost') ?? '', 'Inclusive')),
      ...withDefined('memoryBytes', numOf(tag(tag(own, 'MemoryUsage') ?? '', 'Max'))),
      childIds: edges.map((e) => e.id),
      edges,
      level: 0,
      inInnerPlan: inSubPlan,
    };
  });

  const operators = all;
  const primaryOperators = all.filter((o) => !o.inInnerPlan);

  // 层深与根：按 <Child ID> 关系推（根=没有被任何算子引用的那些）。
  // 在**全部算子**上算：子计划里的热点也要能被走到（只看主计划树会漏掉真正的瓶颈）。
  const byId = new Map(operators.map((o) => [o.id, o]));
  const childSet = new Set(operators.flatMap((o) => o.childIds));
  const rootIds = operators.filter((o) => !childSet.has(o.id)).map((o) => o.id);
  const primaryRootIds = primaryOperators.filter((o) => !childSet.has(o.id)).map((o) => o.id);
  const queue = rootIds.map((id) => ({ id, level: 0 }));
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { id, level } = queue.shift() as { id: string; level: number };
    if (seen.has(id)) continue;
    seen.add(id);
    const op = byId.get(id);
    if (!op) continue;
    op.level = level;
    for (const c of op.childIds) queue.push({ id: c, level: level + 1 });
  }

  const measured = operators.some((o) => o.inclusiveUs !== undefined);
  // 实测行数记在**父算子的 Child 块**里：遍历所有边回填给子算子（根算子没有父，天然为 undefined）
  for (const parent of operators) {
    for (const edge of parent.edges) {
      const child = byId.get(edge.id);
      if (child && edge.rows !== undefined) child.actualCardinality = edge.rows;
    }
  }
  const starts = operators.map((o) => o.startUs).filter((v): v is number => v !== undefined);
  const ends = operators.map((o) => o.endUs).filter((v): v is number => v !== undefined);

  return {
    ...withDefined('version', numOf(/\<\?Version (\d+)\?\>/.exec(xml)?.[1])),
    ...withDefined('planId', attr(planTag, 'ID')),
    type: attr(planTag, 'Type') ?? 'Unknown',
    ...withDefined('planType', attr(planTag, 'PlanType')),
    sql: tag(xml, 'SQL') ?? '',
    operators,
    primaryOperators,
    rootIds,
    primaryRootIds,
    // 根已含全部"没人引用"的算子，故走不到的一定是被引用了但父链断裂的（结构异常）
    orphanCount: operators.filter((o) => !seen.has(o.id)).length,
    threadCount: threads.size,
    ...withDefined('timelineStartUs', starts.length > 0 ? Math.min(...starts) : undefined),
    ...withDefined('timelineEndUs', ends.length > 0 ? Math.max(...ends) : undefined),
    innerPlanBlocks: innerRanges.length,
    subPlanCount: subPlanRanges.length,
    logicalPlanCount: logicalPlans,
    measured,
  };
}

/** 从 Timestamps（JSON：`[{Open:[{thread,time}],Close:[…]}]`）里收集执行线程号 */
function collectThreads(raw: string | undefined, into: Set<number>): void {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Array<Record<string, Array<{ thread?: number }>>>;
    for (const span of parsed) {
      for (const phase of Object.values(span ?? {})) {
        for (const point of phase ?? []) {
          if (typeof point?.thread === 'number') into.add(point.thread);
        }
      }
    }
  } catch {
    /* Timestamps 不是合法 JSON：忽略，不因它让整次解析失败 */
  }
}

// ── 六栏组装 ─────────────────────────────────────────────────

const usToMs = (us: number | undefined): string =>
  us === undefined ? '-' : `${(us / 1000).toFixed(us < 10_000 ? 2 : 0)} ms`;

/**
 * 整体执行时间（微秒）。
 *
 * **不能用根算子的含子耗时**：实测发现它可能远小于真实总时长——惰性物化与并行分支的工作
 * 发生在根算子的计时窗口之外（50KB 那份样例里根算子 0.99 ms，而时间轴跨度 42.7 ms）。
 * 时间轴跨度（最早 start → 最晚 end）才是与"墙上时钟"一致的口径，故以它为准，
 * 退路才是所有含子耗时的最大值。
 */
export function totalInclusiveUs(plan: PlanVizPlan): number | undefined {
  if (plan.timelineStartUs !== undefined && plan.timelineEndUs !== undefined) {
    const span = plan.timelineEndUs - plan.timelineStartUs;
    if (span > 0) return span;
  }
  const values = plan.operators.map((o) => o.inclusiveUs).filter((v): v is number => v !== undefined);
  return values.length > 0 ? Math.max(...values) : undefined;
}

/** 按对象聚合的一次表访问 */
export interface PlanVizObjectAccess {
  object: string;
  objectType?: string;
  accesses: number;
  /** 该对象上各算子含子耗时之和（按访问次数累加，可能超过整体执行时间） */
  inclusiveUs?: number;
  /** 该对象上各算子输出行数之和（实测优先） */
  rows?: number;
}

/**
 * 按访问对象聚合。六栏的 Table Access 与结论的"对象瓶颈"**共用这一份口径**，
 * 且**不截断**——截断只发生在面板渲染处（PANEL_TABLE_LIMIT）；统计块用全量，
 * 否则会出现"554 处表访问"与"表 10 张"自相矛盾。
 */
export function aggregateObjects(plan: PlanVizPlan): PlanVizObjectAccess[] {
  const tableMap = new Map<string, PlanVizObjectAccess>();
  for (const o of plan.operators) {
    if (!o.object) continue;
    const key = `${o.schema ?? '?'}.${o.object}`;
    const cur = tableMap.get(key) ?? { object: key, ...withDefined('objectType', o.objectType), accesses: 0 };
    cur.accesses++;
    if (o.inclusiveUs !== undefined) cur.inclusiveUs = (cur.inclusiveUs ?? 0) + o.inclusiveUs;
    if (o.actualCardinality !== undefined) cur.rows = (cur.rows ?? 0) + o.actualCardinality;
    tableMap.set(key, cur);
  }
  return [...tableMap.values()].sort((a, b) => (b.inclusiveUs ?? 0) - (a.inclusiveUs ?? 0) || b.accesses - a.accesses);
}

export function buildPlanVizPanels(plan: PlanVizPlan, opts: { tree?: boolean } = {}): PlanVizPanels {
  const total = totalInclusiveUs(plan);
  const sorted = [...plan.operators].sort(compareOperators);
  const byOperator = new Map<string, number>();
  for (const o of plan.operators) byOperator.set(o.operator, (byOperator.get(o.operator) ?? 0) + 1);
  const edgeCount = plan.operators.reduce((n, o) => n + o.childIds.filter((c) => plan.operators.some((x) => x.id === c)).length, 0);

  const span = plan.timelineStartUs !== undefined && plan.timelineEndUs !== undefined
    ? plan.timelineEndUs - plan.timelineStartUs
    : undefined;
  const withSpan = plan.operators.filter((o) => o.startUs !== undefined && o.endUs !== undefined);
  const slowestSpan = withSpan.length > 0
    ? withSpan.reduce((a, b) => ((b.endUs as number) - (b.startUs as number) > (a.endUs as number) - (a.startUs as number) ? b : a))
    : undefined;

  return {
    planGraph: {
      operators: plan.operators.length,
      roots: plan.rootIds.length,
      edges: edgeCount,
      byOperator: [...byOperator].map(([operator, count]) => ({ operator, count })).sort((a, b) => b.count - a.count),
      // 文本树属于"原始计划"，与 EXPLAIN 版一样只在 raw=true 时给
      tree: opts.tree === false ? '' : renderPlanVizTree(plan, PANEL_TREE_LIMIT),
    },
    physicalPlan: sorted.slice(0, PANEL_OPERATOR_LIMIT).map((o) => toSummary(o, total)),
    executionTime: {
      measured: plan.measured,
      ...withDefined('totalInclusiveUs', total),
      operatorsMeasured: plan.operators.filter((o) => o.inclusiveUs !== undefined).length,
      operatorsTotal: plan.operators.length,
      unit: 'us',
    },
    timeline: {
      measured: span !== undefined,
      ...withDefined('spanUs', span),
      threads: plan.threadCount,
      ...(slowestSpan
        ? {
            slowestSpan: {
              operator: slowestSpan.name ?? slowestSpan.operator,
              operatorId: slowestSpan.id,
              startUs: slowestSpan.startUs as number,
              endUs: slowestSpan.endUs as number,
            },
          }
        : {}),
    },
    tableAccess: aggregateObjects(plan).slice(0, PANEL_TABLE_LIMIT),
    logicalPlan: {
      blocks: plan.innerPlanBlocks,
      logicalPlans: plan.logicalPlanCount,
      subPlans: plan.subPlanCount,
      operators: plan.operators.filter((o) => o.inInnerPlan).length,
    },
  };
}

/** 排序口径：有实测按独占耗时降序，否则按估计基数降序（估计计划没有耗时） */
function compareOperators(a: PlanVizOperator, b: PlanVizOperator): number {
  if (a.exclusiveUs !== undefined || b.exclusiveUs !== undefined) {
    return (b.exclusiveUs ?? -1) - (a.exclusiveUs ?? -1);
  }
  return (b.actualCardinality ?? b.estimatedCardinality ?? -1) - (a.actualCardinality ?? a.estimatedCardinality ?? -1);
}

function toSummary(o: PlanVizOperator, total: number | undefined): PlanVizOperatorSummary {
  const share = o.exclusiveUs !== undefined && total !== undefined && total > 0
    ? Math.round((o.exclusiveUs / total) * 1000) / 10
    : undefined;
  return {
    operatorId: o.id,
    operator: o.operator,
    ...withDefined('name', o.name),
    ...withDefined('engine', o.engine),
    ...withDefined('exclusiveUs', o.exclusiveUs),
    ...withDefined('inclusiveUs', o.inclusiveUs),
    ...withDefined('userCpuUs', o.userCpuUs),
    ...withDefined('actualCardinality', o.actualCardinality),
    ...withDefined('estimatedCardinality', o.estimatedCardinality),
    ...withDefined('exclusiveSharePct', share),
  };
}

/** 缩进文本树（只画主计划；超限截断并标注，绝不静默丢算子） */
export function renderPlanVizTree(plan: PlanVizPlan, limit: number): string {
  const byId = new Map(plan.operators.map((o) => [o.id, o]));
  const lines: string[] = [];
  let count = 0;
  let truncated = false;
  const walk = (id: string, depth: number): void => {
    if (count >= limit) {
      truncated = true;
      return;
    }
    const op = byId.get(id);
    if (!op) return;
    count++;
    const time = op.inclusiveUs !== undefined ? ` [含子 ${usToMs(op.inclusiveUs)}]` : '';
    const card = op.actualCardinality !== undefined ? ` [${formatRows(op.actualCardinality)} 行]` : '';
    lines.push(`${'  '.repeat(depth)}${op.operator}${op.object ? ` ${op.schema ?? '?'}.${op.object}` : ''}${time}${card}`);
    for (const c of op.childIds) walk(c, depth + 1);
  };
  for (const r of plan.rootIds) walk(r, 0);
  // 关系缺失导致根判不出来时兜底平铺，而不是给一棵空树
  if (lines.length === 0) {
    for (const op of plan.operators.slice(0, limit)) lines.push(`${op.operator}${op.object ? ` ${op.object}` : ''}`);
  }
  return truncated ? `${lines.join('\n')}\n…（树已截断，完整算子见 raw=true）` : lines.join('\n');
}

// ── 实测结论 ─────────────────────────────────────────────────

/** 中间结果物化的算子类型（大行数时值得提示） */
const MATERIALIZE_RE = /(MATERIALIZ|ITAB|TEMP|BUFFER)/i;
/** 实际/估计行数偏离达到该倍率时提示统计信息可能陈旧 */
const CARDINALITY_SKEW = 10;
/** 单算子独占耗时占比超过该值即视为瓶颈 */
const DOMINANT_SHARE = 0.5;
/** 单对象含子耗时占比超过该值即优先按"对象瓶颈"报（实测里常见：时间全压在一个大对象上） */
const OBJECT_DOMINANT_SHARE = 0.2;
/** 换算成 ERROR/FAIL 类的算子状态（正常终止态是 "Finished"，不能当异常报） */
const ABNORMAL_STATUS_RE = /(ERROR|FAIL|ABORT|CANCEL|EXCEPTION|TIMEOUT|INVALID)/i;

export interface PlanVizAnalysisContext {
  statement: string;
  /** 计划来源口径：实测（Executed）还是估计（Estimated） */
  measured: boolean;
}

/**
 * 由 PlanViz 计划产出结论。
 *
 * 与 EXPLAIN 版结论的关键差别：这里有**实测值**，所以能给出 EXPLAIN 永远给不了的三类判断——
 * ① 瓶颈算子（谁真的慢、占整体多少）；② 实际行数与估计行数的偏离（统计信息是否陈旧）；
 * ③ 真实并行度（用到了几个线程）。
 */
export function analyzePlanVizPlan(plan: PlanVizPlan, ctx: PlanVizAnalysisContext): PlanConclusion {
  const findings: Finding[] = [];
  const total = totalInclusiveUs(plan);
  const measured = plan.measured;
  const sorted = [...plan.operators].sort(compareOperators);
  const dominant = sorted.find((o) => o.exclusiveUs !== undefined);
  // 对象按**同一口径**聚合（含子耗时），与 findings 的判据共用，避免"结论说 A、正文说 B"
  const objects = aggregateObjects(plan);
  const dominantObject = objects[0];

  const opShare = dominant?.exclusiveUs !== undefined && total !== undefined && total > 0 ? dominant.exclusiveUs / total : 0;
  // 对象含子耗时会按访问次数累加，可能超过整体；封顶 100%，不制造"占 140%"这种数字
  const objShare = dominantObject?.inclusiveUs !== undefined && total !== undefined && total > 0
    ? Math.min(dominantObject.inclusiveUs / total, 1)
    : 0;
  const bottleneck = pickBottleneck(dominant, dominantObject, opShare, objShare);

  // ① 瓶颈：**对象级含子耗时**与**算子级独占耗时**两条口径都要看，而且它们会背离——
  //    实测那份 10.7MB 计划（1063 个算子、39 线程、整体 7.97 s）里时间高度集中：单个算子独占 7.95 s，
  //    占整体 99.8%；而同时"独占合计/整体"是 584%（并行下各线程的独占耗时互相重叠、不可相加），
  //    所以"独占占比低"这类判断只有在 Naive 合计都低于 10% 时才成立。两条口径都算、按占比取更显著的那个报。
  if (measured && total !== undefined && total > 0) {
    if (bottleneck?.kind === 'object') {
      const o = bottleneck.object;
      // 内部临时对象（列引擎中间物化 `#_SYS_QO_COL_L:…` 之类）名字不好读，但结论要能落在它身上
      const internal = /^[?.]|#_SYS_/i.test(o.object);
      findings.push({
        level: bottleneck.share >= DOMINANT_SHARE ? 'risk' : 'info',
        title: `${internal ? '耗时集中在引擎内部中间结果' : '耗时集中在对象'} ${o.object}（含子 ${usToMs(o.inclusiveUs)}，占整体 ${(bottleneck.share * 100).toFixed(1)}%）`,
        evidence: `${o.objectType ?? '对象'}，本次被访问 ${o.accesses} 次` +
          `${o.rows !== undefined ? `，累计输出 ${formatRows(o.rows)} 行` : ''}；整体执行 ${usToMs(total)}`,
        advice: internal
          ? '这是引擎为中间结果分配的临时对象（不是业务表）：说明时间花在把中间结果落下来/再读回去，方向是减少中间结果规模（更早过滤、聚合下推、避免重复子查询）'
          : '优化点在这个对象的定义/过滤条件/下推能力上，而不是 SQL 里某个算子的写法',
      });
    } else if (bottleneck?.kind === 'operator' && dominant !== undefined) {
      findings.push({
        level: bottleneck.share >= DOMINANT_SHARE ? 'risk' : 'info',
        title: `最慢算子：${dominant.name ?? dominant.operator}（独占 ${usToMs(dominant.exclusiveUs)}，占整体 ${(bottleneck.share * 100).toFixed(1)}%）`,
        evidence: `算子 #${dominant.id}（${dominant.operator}${dominant.engine ? `，${dominant.engine} 引擎` : ''}）` +
          `${dominant.actualCardinality !== undefined ? `，实际输出 ${formatRows(dominant.actualCardinality)} 行` : ''}；` +
          `整体执行 ${usToMs(total)}`,
        ...(bottleneck.share >= DOMINANT_SHARE
          ? { advice: '耗时高度集中在这一个算子上：优先看它的过滤条件与连接方式，改动能直接体现到总时长' }
          : { advice: '耗时较分散，单点优化收益有限；可对照下面几条逐项看' }),
      });
    }

    // 独占耗时合计占比极低 = 时间根本不在算子计算上，这类计划再怎么"优化 SQL 写法"也没用
    const exclusiveSum = plan.operators.reduce((n, o) => n + (o.exclusiveUs ?? 0), 0);
    if (exclusiveSum / total < 0.1 && plan.operators.length > 1) {
      findings.push({
        level: 'info',
        title: `全部算子的独占耗时合计只占整体的 ${((exclusiveSum / total) * 100).toFixed(1)}%`,
        evidence: `独占合计 ${usToMs(exclusiveSum)}，整体 ${usToMs(total)}，相差 ${usToMs(total - exclusiveSum)}`,
        advice: '时间不在算子自身的计算上（在等待、取数、下推引擎或并行分支上）：先把上面的对象级耗时与引擎切换看清楚，再决定动不动 SQL',
      });
    }
  }

  if (!measured) {
    findings.push({
      level: 'info',
      title: '本计划是**估计版**，没有逐算子实测耗时',
      evidence: `${plan.operators.length} 个算子全部没有 ExecutionTime（Type="${plan.type}"）`,
      advice: '要看真实耗时/实际行数/时间轴，用 analyze=true 让它真执行一次（执行受硬护栏：只允许 SELECT、单次执行最多 5 分钟、最多取 100 行、不返回数据行）',
    });
  }

  // ② 统计信息陈旧：估计行数与实际行数严重偏离（只有执行过才知道）
  const skewed = plan.operators
    .filter((o) => o.actualCardinality !== undefined && o.estimatedCardinality !== undefined
      && o.estimatedCardinality > 0 && o.actualCardinality > 0)
    .map((o) => ({ op: o, ratio: (o.actualCardinality as number) / (o.estimatedCardinality as number) }))
    .filter((x) => x.ratio >= CARDINALITY_SKEW || x.ratio <= 1 / CARDINALITY_SKEW)
    .sort((a, b) => Math.max(b.ratio, 1 / b.ratio) - Math.max(a.ratio, 1 / a.ratio))
    .slice(0, 3);
  for (const { op, ratio } of skewed) {
    findings.push({
      level: 'warn',
      title: `行数估计偏离：${op.name ?? op.operator} 估计 ${formatRows(op.estimatedCardinality as number)} 行，实际 ${formatRows(op.actualCardinality as number)} 行（${ratio >= 1 ? '多' : '少'} ${ratio >= 1 ? ratio.toFixed(1) : (1 / ratio).toFixed(1)} 倍）`,
      evidence: `算子 #${op.id}（${op.operator}）：估算偏差会让优化器选错连接方式/连接顺序`,
      advice: '统计信息可能已过期：对该表做一次统计信息更新（或触发重编译）后再看计划',
    });
  }

  // ③ 真实并行度：单线程跑大计划是常见的"看起来慢"的原因
  if (measured && plan.operators.length >= 10 && plan.threadCount <= 1) {
    findings.push({
      level: 'info',
      title: `本次执行只用到 ${plan.threadCount || 1} 个线程（${plan.operators.length} 个算子）`,
      evidence: 'ExecutionTime/Timestamps 里的线程号只有一个',
      advice: '并行度受限可能来自数据量偏小、分区不足或该算子本身不可并行；数据量确实大时值得查分区与并行参数',
    });
  }

  // ④ 大行数的中间物化
  const materialized = plan.operators
    .filter((o) => MATERIALIZE_RE.test(o.operator) && (o.actualCardinality ?? 0) >= 100_000)
    .sort((a, b) => (b.actualCardinality ?? 0) - (a.actualCardinality ?? 0))
    .slice(0, 2);
  for (const op of materialized) {
    findings.push({
      level: 'warn',
      title: `中间结果 ${op.name ?? op.operator} 物化了 ${formatRows(op.actualCardinality as number)} 行`,
      evidence: `算子 #${op.id}（${op.operator}）${op.inclusiveUs !== undefined ? `，含子耗时 ${usToMs(op.inclusiveUs)}` : ''}`,
      advice: '中间结果过大通常意味着过滤/聚合下推不足；检查是否能在更早的算子（扫描或连接）就减少行数',
    });
  }

  // ⑤ 同一对象的重复访问（用**全量**对象聚合，不用被面板截断的那份）
  const repeated = objects.filter((t) => t.accesses > 1).slice(0, 3);
  for (const t of repeated) {
    findings.push({
      level: 'warn',
      title: `对象 ${t.object} 被访问 ${t.accesses} 次`,
      evidence: `${t.objectType ?? '对象'}${t.inclusiveUs !== undefined ? `，累计含子耗时 ${usToMs(t.inclusiveUs)}` : ''}`,
      advice: '重复扫描通常意味着多次读同一份数据；可考虑合并为一次读取或调整连接顺序',
    });
  }

  // ⑥ 算子状态异常（正常终止态是 "Finished"，只有 ERROR/FAIL 类才算异常）
  const badStatus = plan.operators.filter((o) => o.status !== undefined && ABNORMAL_STATUS_RE.test(o.status)).slice(0, 3);
  for (const op of badStatus) {
    findings.push({
      level: 'risk',
      title: `算子执行状态异常：${op.name ?? op.operator} → ${op.status}`,
      evidence: `算子 #${op.id}（${op.operator}）`,
      advice: '该算子在本次执行中未正常完成，计划的耗时统计对它不可信；先解决它的报错再看其余结论',
    });
  }

  const levelOrder: Record<Finding['level'], number> = { risk: 0, warn: 1, info: 2 };
  findings.sort((a, b) => levelOrder[a.level] - levelOrder[b.level]);

  const statistics = planVizStatistics(plan, objects);
  const conclusion: PlanConclusion = {
    summary: summarize(plan, total, measured, bottleneck),
    findings,
    statistics,
    text: '',
  };
  // 文本渲染与 EXPLAIN 版共用同一函数：调用方拿到的"一段可读结论"格式一致
  return { ...conclusion, text: renderConclusionText(conclusion, ctx.statement) };
}

/** 瓶颈判定结果（summary 与 findings 共用，避免"第一句话与正文打架"） */
type Bottleneck =
  | { kind: 'object'; share: number; object: PlanVizObjectAccess }
  | { kind: 'operator'; share: number; operator: PlanVizOperator };

/**
 * 挑瓶颈。两条口径都要够显著才有资格被叫作瓶颈，否则返回 undefined——
 * **宁可不说，也不报"瓶颈占 0%"**：实测症状就是 summary 印出"瓶颈是 ESX SEARCH（占 0%）"，
 * 而同一响应的 findings 说时间在别处，读的人只会去优化错的地方。
 */
function pickBottleneck(
  dominant: PlanVizOperator | undefined,
  dominantObject: PlanVizObjectAccess | undefined,
  opShare: number,
  objShare: number,
): Bottleneck | undefined {
  if (dominantObject !== undefined && dominantObject.inclusiveUs !== undefined
    && objShare >= OBJECT_DOMINANT_SHARE && objShare >= opShare) {
    return { kind: 'object', share: objShare, object: dominantObject };
  }
  if (dominant !== undefined && dominant.exclusiveUs !== undefined && opShare >= OBJECT_DOMINANT_SHARE) {
    return { kind: 'operator', share: opShare, operator: dominant };
  }
  return undefined;
}

function summarize(
  plan: PlanVizPlan,
  total: number | undefined,
  measured: boolean,
  bottleneck: Bottleneck | undefined,
): string {
  const head = measured
    ? `${plan.type === 'Executed' ? '实测' : '估计'}计划：${plan.operators.length} 个算子，整体执行 ${usToMs(total)}`
    : `估计计划：${plan.operators.length} 个算子（未执行，无实测耗时）`;
  const engines = [...new Set(plan.operators.map((o) => o.engine).filter((e): e is string => e !== undefined))];
  const parts = [head];
  if (engines.length > 0) parts.push(`引擎 ${engines.join('/')}`);
  if (plan.operators.some((o) => o.object)) parts.push(`${plan.operators.filter((o) => o.object).length} 处表访问`);
  if (plan.subPlanCount > 0) parts.push(`${plan.subPlanCount} 个子计划`);
  if (measured && bottleneck !== undefined) {
    const pct = Math.round(bottleneck.share * 100);
    parts.push(
      bottleneck.kind === 'object'
        ? `瓶颈是对象 ${bottleneck.object.object}（占 ${pct}%）`
        : `瓶颈是 ${bottleneck.operator.name ?? bottleneck.operator.operator}（占 ${pct}%）`,
    );
  } else if (measured) {
    parts.push('耗时较分散，没有单一瓶颈');
  }
  return `${parts.join('，')}。`;
}

/**
 * 把 PlanViz 计划折算成与 EXPLAIN 版同形的统计块，调用方不必区分两种来源。
 *
 * ⚠ 两处口径差异必须显式处理，否则同一字段名在两条通道下含义不同：
 * - `tables` 用**全量**对象聚合（不是被 PANEL_TABLE_LIMIT 截断的面板），否则统计行会印出"表 10 张"而 summary 说几百处访问；
 * - `estimatedRows` 是**估计**口径，取主计划根的 `EstimatedOutputCardinality`——实测行数在 panels 里，
 *   塞进 estimatedRows 会让渲染出的"预计输出 N 行"变成实测值（同一字段在两条通道下不可比）。
 */
export function planVizStatistics(plan: PlanVizPlan, objects: PlanVizObjectAccess[]): PlanStatistics {
  const tables: PlanTableRef[] = objects.map((t) => ({
    name: t.object,
    ...withDefined('type', t.objectType),
    ...withDefined('size', t.rows),
    ...withDefined('access', t.accesses > 1 ? `重复访问 ×${t.accesses}` : undefined),
  }));
  const engines = [...new Set(plan.operators.map((o) => o.engine).filter((e): e is string => e !== undefined))];
  // 主计划作用域内的根才是"这条语句的根算子"（全部算子里的根包含子计划片段的根）
  const rootId = plan.primaryRootIds[0] ?? plan.rootIds[0];
  const rootOp = rootId !== undefined ? plan.operators.find((o) => o.id === rootId) : undefined;
  return {
    operatorCount: plan.operators.length,
    engines,
    engineSwitch: engines.length > 1,
    tables,
    // 口径要对上 PlanViz 的 TypeName：表访问算子的特征是有 object（TABLE/TREX_SEARCH 之类都算），
    // 用 EXPLAIN 的 /SCAN|SEARCH/ 去匹配会数到搜索包装算子头上、GROUP_BY（下划线）又匹配不到 /GROUP BY/
    scans: plan.operators.filter((o) => o.object !== undefined).length,
    joins: plan.operators.filter((o) => /JOIN/i.test(o.operator)).length,
    aggregations: plan.operators.filter((o) => /GROUP_BY|AGGREGAT/i.test(o.operator)).length,
    ...(rootOp?.estimatedCardinality !== undefined ? { estimatedRows: rootOp.estimatedCardinality } : {}),
    ...(rootOp ? { rootOperator: rootOp.operator } : {}),
  };
}

/** 微秒 → 毫秒文本（结论文本里用；导出让 service 层的文本渲染复用同一口径） */
export function formatMicros(us: number | undefined): string {
  return usToMs(us);
}

/** 通用版（EXPLAIN 版那个只收 number）：计划里可选字段多，字符串/数组也要按同法省略 undefined */
function withDefined<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}
