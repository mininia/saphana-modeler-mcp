/**
 * 破坏性判定表——纯函数、零 I/O，判定输入只有两样：
 * 归一化后的结构 diff（src/model/view-diff.ts）与影响半径（下游引用集合）。
 *
 * 三条刻意为之的语义，改代码前先读这里：
 *
 * 1. **分级门槛 = 下游是否引用**：同样变更，下游没人引用就是非破坏，有人引用才破坏。
 *    因此 items 只在「下游非空」时产生——调用方拿到的每一条都是真的会断下游的破坏项，
 *    不存在"列出来但其实不算数"的条目（判定表逐行实现，见各 collect* 的注释）。
 *
 * 2. **描述 / 显示名 / 隐藏标志的变更永不破坏**（即便有下游）——下游消费的是字段与取数口径，
 *    不依赖 description / order / hidden / key 这类展示属性。这是刻意的，不要"顺手"升级为破坏。
 *
 * 3. **requiresStrategy 只对「可迁移的字段级变更」给出策略**：删字段 / 改类型 / 改名 →
 *    cast / preserve_column / move；视图删除、接线变更、数据源变更都没有可自动化的策略，如实给空数组。
 *    是否放行由调用层按 D2 闸门语义决定（声明 + 回执记录），本模块只判定、不阻断。
 *
 * 明确**不在表内**的（不产生条目，别顺手加）：新增输出字段、节点增删、变量增删、仅新增数据源、
 * `diff.output.changed` 单独，以及 outputs.changed 的展示类字段位（description / hidden / key / order）。
 * 判定表是白名单：扩一条规则 = 先在本文件（文件头与对应 collect* 的头注）把新口径写清，再加实现。
 *
 * 三条**口径面规则**——编辑能力（节点过滤器 / 属性过滤器 / 变量默认值）会改变下游取到的数据，
 * 不能从闸门旁边走过去：
 *   - `node_filter_changed`：节点过滤器表达式变更（view-diff 的 nodes.changed fields 含 'filter'）；
 *   - `attribute_filter_changed`：属性级值过滤器变更（fields 含 'attributeFilters'）；
 *   - `variable_changed`：输入参数的**语义字段**（parameter/datatype/length/defaultValue/mandatory）
 *     变更——description-only 的变更不产生条目（与第 2 条「描述永不破坏」同口径）；
 *     变量**增删**仍在表外：新增参数不改变既有取数，删除参数的影响面属"参数不再被接受"，
 *     交调用方按 xml 通道自行承担。
 *
 * 四条附加信号面（「补洞」性质，唯一收紧是重挂豁免要证据）：
 *   - 节点级类型声明（attributeTypes）变更按节点成条（列级关联为何不可达见该函数头注）；
 *   - 输入接线变化（fields 'inputs'——输入换人/增减，映射逐字同名也含）独立成 node_input_changed 条；
 *   - SQL 模式视图的脚本变更进判定（改基表最隐蔽）：保守口径、不解析 SQL，见 collectScriptChanges；
 *   - 机械重挂豁免必须带「恒等直通」证据（output.passThrough：透明节点 + 直通边映射非空且全恒等），
 *     见 collectOutputNodeRewiring 第 2 条。
 * level 的类型扩出 'unknown'：本模块不产生它——留给服务层在「基线不可用、判定未执行」时如实标注。
 *
 * 「改输出节点接线」「改输入数据源 / 基表」的判据统一为"**既有输出字段的取数解析变没变**"，
 * 而不是"节点 / 数据源有没有变动"（判据来源是实机 op=add_join 的变换结果：数据源仅新增 + 输出节点
 * 换人 + 既有字段 sourceObject 机械重挂，详见 collectOutputNodeRewiring / collectDataSourceChanges
 * 的头注与 tests/unit/migrate.rules.test.ts 的实证用例）——这些形态必须判非破坏，否则闸门会拦下
 * 良性的加 join。改各 collect* 前先读它们的头注，别改成按现象粗判。
 *
 * diff 的字段名 / 分类以 view-diff.ts 的契约为准；本模块不做任何再归一化，
 * 也绝不读 raw / XML 文本。
 */

import { OUTPUT_FIELD_CATEGORY, type OutputFieldCategory, type ViewDiff } from '../model/view-diff.js';

/** 迁移策略（Cast / 保列新建 / Move）——**字段级**的迁移动作，也就是 BreakingItem.requiresStrategy 的取值范围 */
export type MigrationStrategy = 'cast' | 'preserve_column' | 'move';

/**
 * 声明位允许的取值 = 字段级迁移策略 ∪ 「显式承担下游破坏」。
 *
 * 为什么与 MigrationStrategy 分开而不是直接加进去：`BreakingItem.requiresStrategy` 是「**可以**用什么动作迁」，
 * 语义上不该出现 acknowledge_dependents —— 它是调用方对破坏的**承担声明**，不是字段级迁移动作
 * （整段回退、删掉自己上一步加的数据源这类变更，三种字段级策略都描述不了；delete 通道的 migration 也正是这个值）。
 * 声明只被记录，不触发任何自动迁移动作。
 */
export type MigrationDeclaration = MigrationStrategy | 'acknowledge_dependents';

export type BreakingRuleId =
  | 'output_field_type_changed' // 改字段数据类型（含节点级 attributeTypes 声明——按节点成条，见该规则头注）
  | 'output_field_removed' // 删字段（含改名 —— 改名表现为 删+增）
  | 'output_node_rewired' // 既有输出字段解析变化 / 节点输入映射重指向（下游 keyMapping 会断）
  | 'node_input_changed' // 节点输入接线变化（输入换人/增减；映射逐字同名也命中，见该规则头注）
  | 'data_source_changed' // 删 / 改输入数据源、基表（语义漂移，最隐蔽；仅新增不构成破坏）
  | 'script_changed' // SQLScript 脚本文本变更（SQL 模式视图的改基表/口径通道；保守口径，不解析 SQL）
  | 'node_filter_changed' // 节点过滤器表达式变更（行集合变化——与 data_source_changed 同属口径漂移）
  | 'attribute_filter_changed' // 属性级值过滤器变更（同上；BW 常见形态：排除删除标记的增删改）
  | 'variable_changed' // 输入参数语义字段变更（默认值/类型/必填——未传参的下游取到的值会变）
  | 'view_deleted'; // 删除整个视图

/** 一条破坏项（命中一条规则一条，不合并） */
export interface BreakingItem {
  rule: BreakingRuleId;
  /** 具体字段 / 节点 / 数据源 id（视图删除时用视图名） */
  target: string;
  /** 一句中文事实描述（给调用方看；只陈述事实，不含补救指引） */
  detail: string;
  /** 可用迁移策略；无可用策略时为 []（删除 / 接线 / 数据源与脚本类语义漂移——字段级策略都不是它们的修法） */
  requiresStrategy: MigrationStrategy[];
}

export interface BreakingAssessment {
  /**
   * 判定结论。**本模块只产生 'none' / 'breaking'**；'unknown' 不由本模块产生——它留给服务层在
   * 「基线不可用、判定根本没有执行」时如实标注：让「未判」与「判为非破坏」在**形状上**可区分
   * （两者同形时只有 warnings 里的一句话能看出差别）。
   */
  level: 'none' | 'breaking' | 'unknown';
  items: BreakingItem[];
  /** 下游引用条数；impactTruncated 为真时它只是下界 */
  downstreamCount: number;
  /** 影响半径是否被截断——级别照判，但调用方必须知道下游计数是下界 */
  impactTruncated: boolean;
}

/** 影响半径中本判定用到的字段子集（下游引用：包 + 对象名 + 后缀） */
export interface DownstreamRef {
  packageId: string;
  objectName: string;
  objectSuffix: string;
}

/** 判定输入之二：下游引用集合与截断标记 */
export interface BreakingImpact {
  downstream: DownstreamRef[];
  truncated: boolean;
}

/** 数据源 delta 的条目形状（added / removed 同形，直接复用 diff 的声明，避免第二份形状漂移） */
type DataSourceDelta = ViewDiff['dataSources']['added'][number];
/** 输出字段 delta 的条目形状（五张输出列表的条目至少含 list + id） */
type OutputFieldDelta = ViewDiff['outputs']['removed'][number];

/**
 * 字段级变更的可用策略：改名（删+增）配 move、改类型配 cast、删字段又要保下游列名配 preserve_column。
 * 共享常量只读，放进 item 时复制一份，防调用方就地改坏判定结果。
 * 合法值的对外单一事实源是下面的 MIGRATION_DECLARATIONS（工具层/defs 从它取，不要在别处手抄第二份）；
 * 本清单只是它的字段级子集。
 */
const MIGRATION_STRATEGIES: readonly MigrationStrategy[] = ['cast', 'preserve_column', 'move'];

/** 声明位合法值全集 = 字段级策略 ∪ acknowledge_dependents（delete 通道与语义漂移类变更的声明值）；同样是单一事实源 */
export const MIGRATION_DECLARATIONS: readonly MigrationDeclaration[] = [
  ...MIGRATION_STRATEGIES,
  'acknowledge_dependents',
];

function fieldStrategies(): MigrationStrategy[] {
  return [...MIGRATION_STRATEGIES];
}

/**
 * 判定表入口：diff + 下游影响半径 → 破坏性结论。
 * 接线 / 字段 / 数据源三类规则共用同一门槛「下游有引用」，故统一在门槛内收集。
 */
export function assessBreaking(diff: ViewDiff, impact: BreakingImpact): BreakingAssessment {
  const items: BreakingItem[] = [];

  // 「下游有引用」= impact.downstream 非空（判定表门槛：无引用一律非破坏）
  if (impact.downstream.length > 0) {
    collectOutputFieldRemovals(diff, items);
    collectOutputFieldTypeChanges(diff, items);
    collectNodeAttributeTypeChanges(diff, items);
    collectOutputNodeRewiring(diff, items);
    collectNodeInputChanges(diff, items);
    collectDataSourceChanges(diff, items);
    collectScriptChanges(diff, items);
    collectDataFilterChanges(diff, items);
    collectVariableChanges(diff, items);
  }

  return summarize(items, impact);
}

/**
 * 规则：删字段（含改名——改名表现为 删旧名 + 增新名，破坏由"删"这一半触发；增字段不产生条目）。
 * 下游有引用 → 破坏，策略 cast / preserve_column / move。
 */
function collectOutputFieldRemovals(diff: ViewDiff, items: BreakingItem[]): void {
  for (const field of diff.outputs.removed) {
    items.push({
      rule: 'output_field_removed',
      // 五张输出列表间 id 可重名，target 必须带 list 才能唯一定位
      target: outputFieldRef(field),
      detail: `输出字段 ${field.id}（${field.list}）被删除；改名会表现为"删旧名+增新名"，下游按旧名引用同样会断`,
      requiresStrategy: fieldStrategies(),
    });
  }
}

/**
 * 规则：改字段数据类型（仅认 datatype / length 两个字段位）。
 * 展示类字段位（description/order/hidden/key 等）不在判定表内，一律不产生条目（见文件头第 2 条）；
 * 取数解析类字段位（sourceColumn/sourceObject/aggregationType 等）由 collectOutputNodeRewiring
 * 判定——同一字段两位同变时按各自规则各出一条，不合并。
 */
function collectOutputFieldTypeChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const field of diff.outputs.changed) {
    const typeFields = field.fields.filter((f) => fieldCategory(f) === 'type');
    if (typeFields.length === 0) continue;
    items.push({
      rule: 'output_field_type_changed',
      target: outputFieldRef(field),
      detail: `输出字段 ${field.id}（${field.list}）的类型声明变更（${typeFields.join('、')}），下游按原类型消费会受影响`,
      requiresStrategy: fieldStrategies(),
    });
  }
}

/**
 * 规则：节点级类型声明变更（attributeTypes）——SQL 模式视图（本服务 view-builder
 * 就这么写）与部分 BW/Studio 方言把列类型写在**节点**的 viewAttribute 上；logicalModel 输出字段不带
 * datatype ⇒ 输出侧（outputs.changed）完全看不到类型变化，只判 outputs.changed 会漏成 none。
 *
 * 为什么按**节点**成条、而不是「按 keyMapping 关联到输出字段」：判定输入只有 diff + impact，
 * 而 diff 里节点侧只带变化的**字段名**（不含列级新旧值、不含节点列清单），输出侧条目只带
 * {list,id,fields}（不含 sourceObject/sourceColumn）——「哪个节点列变了、哪些输出字段指它」两个关联键
 * 在结构 diff 里都不存在。列级关联要么改 diff 形状、要么把 after 侧定义塞进判定输入，两者都动既有契约，
 * 故取节点级近似：一个变更节点一条、target=节点 id，detail 如实说明关联不可达。
 *
 * 「关联不到的节点列不产生破坏项」的取舍：列级信息本就没有，也不回退为按节点列逐个冒充 target（那要先
 * 知道列清单，同样拿不到）；节点内未被任何输出字段引用的列会随节点整体成条——保守方向（类型声明变更
 * 意味着该节点取数口径有变化，下游有引用时宁过不漏），不要「顺手」改成按列猜。
 *
 * requiresStrategy 与输出字段类型规则同口径（改类型可 cast / 保列新建 / move）。
 */
function collectNodeAttributeTypeChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const node of diff.nodes.changed) {
    if (!node.fields.includes('attributeTypes')) continue;
    items.push({
      rule: 'output_field_type_changed',
      target: node.id,
      detail:
        `节点 ${node.id}（${node.type}）的节点级类型声明（viewAttribute 的 datatype/length）变更：` +
        '列类型写在节点上，下游按原类型消费会受影响；结构 diff 不携带列级新旧值，无法逐一关联到输出字段，按节点整体成条',
      requiresStrategy: fieldStrategies(),
    });
  }
}

/**
 * 输出字段位的分类查询。分类单源在 view-diff 的 OUTPUT_FIELD_CATEGORY（Record<OutputFieldName, …>，
 * 新增字段位没在那里补齐就编译不过）；本模块不手抄「解析类」子集——手抄时 view-diff 新加的字段位
 * 会静默落进「展示类、永不破坏」（fail-open），与变量侧"除 description 外都是语义"的默认方向相反。
 * 表外字段（diff 契约保证不会出现）按 undefined 处理：与展示类同效，不产生条目。
 */
function fieldCategory(field: string): OutputFieldCategory | undefined {
  return (OUTPUT_FIELD_CATEGORY as Readonly<Record<string, OutputFieldCategory | undefined>>)[field];
}

/**
 * 规则：改输出节点接线——判据是**既有输出字段的解析变没变**
 * （diff.outputs.changed 的 fields 含解析类字段位任一），不是"节点 / 数据源有没有变动"。
 * 改这个函数前先读下面三条（否则下一个人容易改成现象级粗判）：
 *
 * 1. `diff.output.changed`（最终输出节点换人）**单独不构成破坏**：字段解析不变 = 下游 keyMapping
 *    不会断（判定表给这行写的判据就是"下游 keyMapping 会断"）。
 * 2. 输出节点换人伴随的 sourceObject 机械重挂**不计入破坏——但要证据**，且证据必须闭到「恒等直通」：
 *    add_join 等变换会把 logicalModel 的 keyMapping/measureMapping 的 columnObjectName 从旧输出节点
 *    **整体**改指新输出节点。实机变换（tests/fixtures 的 join 链 + op=add_join）产出的 diff 实证：
 *    既有字段 fields=['sourceObject']、sourceColumn（列名）不变，且 diff.output.passThrough=true——
 *    after 定义里新输出节点 to 确有一条输入直指旧输出节点 from（机械重挂的一手证据）。列名未变、值沿
 *    新节点直通 ⇒ 解析没有变；不看这条豁免，良性的加 join 会被判破坏（该豁免防的正是这个假阳性）。
 *    证据为什么必须闭到「透明直通」：直通边只证明「有边」，证明不了「值沿新节点直通」——
 *    把直通输入写成非恒等映射（target=KEY_A source=AMT）时列名未变而值已换，静默语义漂移。
 *    passThrough 的判定（view-diff.isPassThrough）：to 类型 ∈ {Projection, Join}（Join 须 joinType =
 *    leftOuter——过滤型 join（inner/rightOuter/fullOuter，含缺省 inner）会改行集合）、自身无聚合/
 *    过滤器/Rank/脚本，且 to→from 那条边的映射非空且**全部恒等**（target === source）。
 *    纯形态匹配（"换人 + 仅 sourceObject 变化"）不够：真实世界里破坏性的重接线同样长这样，只是
 *    新输出节点与旧节点毫无直通关系——证据不成立（passThrough=false/缺省）时必须照判破坏。
 *    字段若还伴随其他解析位变化，仍照常判破坏（见下面循环）。
 * 3. 节点输入映射重指向（mappings.retargeted 非空）**保留原判**：同一列改从另一个上游取数，列值会变
 *    （语义漂移）；它不产生 add_join 的假阳性（实机 add_join 的 nodes.changed 为空），故逐条照判、不合并。
 *
 * 下游有引用 → 破坏；无可用迁移策略（接线断没有"cast 一下"的修法）。
 */
function collectOutputNodeRewiring(diff: ViewDiff, items: BreakingItem[]): void {
  for (const field of diff.outputs.changed) {
    const resolutionFields = field.fields.filter((f) => fieldCategory(f) === 'resolution');
    if (resolutionFields.length === 0) continue;
    // 第 2 条豁免：输出节点换人 + 仅 sourceObject 这一位变化（机械重挂形态），**且证据成立**。
    // 证据是 view-diff 算好的 passThrough，语义 =「透明直通」：to 类型 ∈ {Projection, Join}（Join 须
    // joinType = leftOuter——过滤型 join 会改行集合）、自身无聚合/过滤器/Rank/脚本，
    // 且 **to→from 那条边的映射非空且全部恒等**（target === source）。
    // 直通边只证明「有边」，证明不了「值沿新节点直通」：映射把该字段的列改写成别的来源
    // （target=KEY_A source=AMT——列名未变而值已换）时 passThrough=false ⇒ 照判破坏。
    // 证据不成立时不豁免，按解析变化照判。
    const onlyRehosted =
      diff.output.changed &&
      diff.output.passThrough === true &&
      resolutionFields.length === 1 &&
      resolutionFields[0] === 'sourceObject';
    if (onlyRehosted) continue;
    items.push({
      rule: 'output_node_rewired',
      // 五张输出列表间 id 可重名，target 必须带 list 才能唯一定位
      target: outputFieldRef(field),
      detail: `输出字段 ${field.id}（${field.list}）的取数解析变更（${resolutionFields.join('、')}），既有字段名下的取数口径已变，下游按原解析消费会受影响`,
      requiresStrategy: [],
    });
  }
  for (const node of diff.nodes.changed) {
    for (const mapping of node.mappings.retargeted) {
      items.push({
        rule: 'output_node_rewired',
        // mapping.target 是映射在节点内的目标列；带节点 id 才能跨节点唯一定位
        target: `${node.id}/${mapping.target}`,
        detail: `节点 ${node.id} 的输入映射 ${mapping.target} 由 ${mapping.from} 改指 ${mapping.to}，下游 keyMapping 会断`,
        requiresStrategy: [],
      });
    }
  }
}

/**
 * 规则：节点输入接线变更（node_input_changed）——view-diff 的输入绑定比较
 * 命中时在 nodes.changed[].fields 记 'inputs'（输入换人 / 输入增减 / 映射重指向都命中；Union 输入集合
 * 增删同样命中，重排不命中——文档序无语义，别在这边自行再加归一）。
 *
 * 为什么必须独立一条：输入换人但映射**逐字同名**（如 Join 左输入 #Proj_A → #Proj_B，两者暴露同名同列）
 * 时逐映射差量为空、dataSources 也无变化，'inputs' 是唯一信号；但下游按原列名取到的值已经变了（语义
 * 漂移，最隐蔽）。命中即破坏的并集语义：与逐映射的 output_node_rewired 条目**不合并、都不丢**
 * （同一次变更里两类条目各说各的事实——模块文件头第 1 条：调用方拿到的每条都是真的）。
 * 判定表「改输出节点接线」判据的延伸：下游有引用 ⇒ 破坏；接线断没有字段级修法，策略如实给空。
 */
function collectNodeInputChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const node of diff.nodes.changed) {
    if (!node.fields.includes('inputs')) continue;
    items.push({
      rule: 'node_input_changed',
      target: node.id,
      detail: `节点 ${node.id}（${node.type}）的输入接线变更（输入换人 / 输入增减 / 映射重指向）：同一列名下的取数来源已变，下游按原接线消费会受影响`,
      requiresStrategy: [],
    });
  }
}

/**
 * 规则：改 / 删输入数据源 / 基表——**仅新增不构成破坏**（判据同样是"既有取数语义变没变"）。
 *   - removed 非空：既有源被移除，视图取数口径变化（语义漂移，最隐蔽）⇒ 下游有引用时破坏；
 *   - changed 非空（契约保证 fields 非空，⊂ [type, resourceUri, schemaName, columnObjectName]，
 *     全是取数口径类字段）：既有源的口径变更 ⇒ 同判；
 *   - 仅 added（removed / changed 为空）：**不判破坏**——新增源若被接进既有输出字段，该字段的解析位
 *     变化会由 collectOutputNodeRewiring 捕获（"sourceObject 变化会捕获"那条就是为这个场景留的）；
 *     没接进既有字段的新增源（如 add_join 的新源只喂新增输出字段）不改变任何既有语义。
 *     把 added 也算破坏会拦下良性的 add join，这正是该分支不存在的理由。
 * 无可用迁移策略（口径漂移不是字段级 cast 能兜的，交给编排层按 impact 处理）。
 */
function collectDataSourceChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const source of diff.dataSources.removed) {
    items.push({
      rule: 'data_source_changed',
      target: source.id,
      detail: `移除输入数据源 ${source.id}（${describeDataSource(source)}），视图取数口径变化（语义漂移）`,
      requiresStrategy: [],
    });
  }
  for (const source of diff.dataSources.changed) {
    items.push({
      rule: 'data_source_changed',
      target: source.id,
      detail: `输入数据源 ${source.id} 的 ${source.fields.join('、')} 变更；语义漂移最隐蔽——下游引用的列名可能没变，值已不是原来那批`,
      requiresStrategy: [],
    });
  }
}

/**
 * 规则：SQLScript 脚本变更（script_changed）——**保守口径**：
 * 脚本文本变化 + 下游有引用 ⇒ 破坏；不解析 SQL（不做「脚本引用的源集合」比较）。
 *
 * 为什么不复用现有扫描件：本仓可复用的 SQL 扫描件只有 write-plan 的
 * scanSqlSchemaRefs / hasUnqualifiedTableRef（read-scope.service 的 assertSqlReadScopes 族依赖注入式
 * 异步读取、且是校验不是抽取）。前者虽是纯函数，但只抽 **schema**、抽不出被引用的对象；而实测的漂移
 * 形态常是**同 schema 换表**（`FROM ZTEST_SIGN.HEADER` → `FROM ZTEST_SIGN.ITEM` 实测 schema 集合不变；
 * 实测语料（ZDEMO 族）的脚本也全走 _SYS_BIC）——只比 schema 集合等于把这行漂移继续放行；逐对象抽取器不
 * 存在，现写一份 = 第二份表名扫描器（write-plan 是单点实现，注释明确「不要再写第二份剥离/扫描实现」）。
 * 故不解析 SQL：任何脚本文本变化都按语义漂移要求显式声明（fail-closed——宁过不漏），WHERE/格式类
 * 良性变更也会命中，这是保守口径的明示代价。
 *
 * 「源集合未变时只给 warning」的分支无法在**本模块**落地：判定出口没有 warnings 通道（在服务层组装
 * DryRunReport 时才有），且「源集合未变」用现有扫描件根本证不出来（对象级不可见）——不要为了凑这个
 * 分支塞半份扫描器。requiresStrategy：语义漂移没有可自动化的字段级动作（同 data_source_changed 口径），
 * 如实给空数组；放行与否由调用层按 D2 闸门（显式声明）决定。
 */
function collectScriptChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const node of diff.nodes.changed) {
    if (!node.fields.includes('script')) continue;
    items.push({
      rule: 'script_changed',
      target: node.id,
      detail: `节点 ${node.id}（${node.type}）的 SQLScript 脚本文本变更；本服务的结构 diff 不解析 SQL：脚本变更一律按语义漂移要求显式声明`,
      requiresStrategy: [],
    });
  }
}

/**
 * 规则：取数口径面变更——节点过滤器（fields 含 'filter'）与属性级值过滤器（fields 含 'attributeFilters'）。
 *
 * 为什么进表：两者都不动输出字段与接线，但改变**行集合**——下游按原字段名取到的数据变了。
 * 这与 data_source_changed 判的是同一件事（"既有取数语义变没变"），故同判：
 * 下游有引用 ⇒ 破坏；无字段级迁移动作（口径漂移不是 cast 能兜的），requiresStrategy 如实给空。
 * 判定覆盖两个方向：**加**过滤器（如新排除删除标记）与**改/删**过滤器都会改变行集合，一律成条——
 * 不存在"仅新增不构成破坏"的豁免（那条豁免针对的是"新增源没接进既有字段"，这里不存在对应形态）。
 */
function collectDataFilterChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const node of diff.nodes.changed) {
    if (node.fields.includes('filter')) {
      items.push({
        rule: 'node_filter_changed',
        target: node.id,
        detail: `节点 ${node.id}（${node.type}）的过滤器表达式变更；行集合变化（语义漂移）——下游取到的数据不再是原来那批`,
        requiresStrategy: [],
      });
    }
    if (node.fields.includes('attributeFilters')) {
      items.push({
        rule: 'attribute_filter_changed',
        target: node.id,
        detail: `节点 ${node.id}（${node.type}）的属性级过滤器变更；行集合变化（语义漂移）——下游取到的数据不再是原来那批`,
        requiresStrategy: [],
      });
    }
  }
}

/**
 * 规则：输入参数（变量）**语义字段**变更（defaultValue / mandatory / datatype / length / parameter）。
 *
 * 为什么进表：改默认值影响**所有未显式传参的下游调用**——同一句 SELECT 取到的值变了，
 * 属口径漂移；类型/长度/parameter 标志同理。判定与 collectDataFilterChanges 同口径（下游有引用 ⇒ 破坏，
 * 无字段级策略）。
 *
 * **description-only 的变更不产生条目**：描述是展示属性，与第 2 条「描述 / 显示名永不破坏」同口径——
 * 这里用「除 description 外还有语义字段命中」表达，字段混改（描述 + 默认值）时正常成条。
 */
function collectVariableChanges(diff: ViewDiff, items: BreakingItem[]): void {
  for (const variable of diff.variables.changed) {
    const semantic = variable.fields.filter((f) => f !== 'description');
    if (semantic.length === 0) continue; // 纯描述变更：展示属性，不进判定表
    items.push({
      rule: 'variable_changed',
      target: variable.id,
      detail: `输入参数 ${variable.id} 的 ${semantic.join('、')} 变更；未显式传参的下游调用取到的值/约束会变（语义漂移）`,
      requiresStrategy: [],
    });
  }
}

/**
 * 判定表独立入口：删除整个视图（调用方在 hana_view_delete 前用；判定表最后一行）。
 * 下游无引用 → 非破坏；有引用 → 破坏，且**没有迁移策略**——
 * 是否放行由调用层按 D2（先解除依赖或调用方显式承担）决定，本模块只如实判定。
 */
export function assessViewDeletion(
  target: { packageId: string; objectName: string },
  impact: BreakingImpact,
): BreakingAssessment {
  const items: BreakingItem[] = [];
  if (impact.downstream.length > 0) {
    items.push({
      rule: 'view_deleted',
      // 契约：视图删除时 target 用视图名（packageId 进 detail，供调用方定位）
      target: target.objectName,
      detail: `删除视图 ${target.packageId}/${target.objectName}，下游有 ${impact.downstream.length} 个对象引用它，依赖会断`,
      requiresStrategy: [],
    });
  }
  return summarize(items, impact);
}

/** 输出字段的定位串：五张输出列表间 id 可重名，带 list 才唯一 */
function outputFieldRef(field: OutputFieldDelta): string {
  return `${field.list}/${field.id}`;
}

/** 数据源的一句话标识：优先 schema.对象，其次 resourceUri，最后退回类型名（ABAP / HANA 两种方言都能读） */
function describeDataSource(source: DataSourceDelta): string {
  const object = [source.schemaName, source.columnObjectName].filter(Boolean).join('.');
  return object || source.resourceUri || source.type;
}

/**
 * 归并回执：level 只看 items（每一条都是"有下游"前提下的真破坏项）；truncated 原样带出，
 * 级别照判——截断只影响下游计数的可信度（是下界），不改变"有没有下游"这个事实。
 */
function summarize(items: BreakingItem[], impact: BreakingImpact): BreakingAssessment {
  items.sort(compareBreakingItems);
  return {
    level: items.length > 0 ? 'breaking' : 'none',
    items,
    downstreamCount: impact.downstream.length,
    impactTruncated: impact.truncated,
  };
}

/** items 顺序确定性：先 rule 再 target，同键再按 detail，保证同一输入两次调用逐字节相同 */
function compareBreakingItems(a: BreakingItem, b: BreakingItem): number {
  return compareStrings(a.rule, b.rule) || compareStrings(a.target, b.target) || compareStrings(a.detail, b.detail);
}

/** 码元序比较（不用 localeCompare：ICU 口径随环境漂移，回执确定性优先） */
function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
