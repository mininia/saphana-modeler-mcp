/**
 * 操作级 effect 声明（hana_view_update 的 operations 通道各 op 的效应面与参数面清单的单一事实源）。
 *
 * 为什么要有这个文件：hana_view_update 的 operations 读写面若只在 PLANNERS['hana_view_update']（按**工具名**
 * 声明）里整体覆盖，「这个 op 碰什么」就没有单一落点，新增 op 只能靠读变换实现反推。effect 声明必须与操作
 * 定义**同处**（按操作类型声明）：本模块就是那唯一一份声明——每条 op 一句话摘要 + 结构面 effect + 参数面清单。
 * 工具面 schema（判别式与字段）在 `capabilities/defs/modeling.ts`；
 * 两侧对齐由 tests/unit/view-ops.rules.test.ts 逐字段交叉断言（一条规则一份实现，任一侧漂移即红）。
 *
 * 语义（每个字段都给了判据；改声明前先读这五条）：
 *
 * 1. `destructive` = **可能触碰结构面/口径面**（可能破坏既有对象/数据/下游语义），不是「经判定会破坏下游」。
 *    判据：true ⇔ 变换会改动 输出字段 / 节点接线映射 / 数据源引用 / **取数口径（过滤器、变量默认值）**
 *    四者之一（= 下游赖以消费的面）；false ⇔ 变换只落在展示属性（描述/显示名——破坏性判定表明确
 *    「描述/显示名变更永不破坏」）。
 *    ⚠ **它不是闸门**：真正的放行判定是 assessBreaking（结构 diff × 下游引用，见 services/migrate.rules.ts），
 *    「可能触碰结构」与「真的破坏下游」之间隔着下游引用门槛，别把本字段当第二道闸用：
 *      · add_join 的实测 diff 形态（数据源仅新增 + 既有输出字段仅 sourceObject 机械重挂且 passThrough
 *        证据成立 + 只新增输出字段）判**非破坏**（否则闸门会拦下良性的加 join，见
 *        migrate.rules.ts 头注）——但它照样声明 destructive=true：口径是「可能触碰」，
 *        与「已知变换结果当前恰好判非破坏」不矛盾；谁拿本字段去要求「必须给 migration 声明」，
 *        就会把这条良性路径重新拦死。
 *      · set_script 恒为 true：脚本一变，判定表按 script_changed 要求显式声明（保守口径），且输出列集合常变。
 *
 * 2. `touchesOutputFields` = 输出字段面被触碰：logicalModel 的输出属性/度量增删改名、SQL 模式节点
 *    viewAttributes 的列与 datatype 重写（后者归 output_field_type_changed 信号，故算输出字段面，
 *    不算接线面）。
 *
 * 3. `touchesMapping` = **节点接线/映射**面被触碰（output_node_rewired / node_input_changed 信号面）：
 *    节点增删、输入换人/增减、mapping 的 target/source 重指向、logicalModel 的 columnObjectName 重挂
 *    （diff 里表现为既有输出字段的 sourceObject 等**解析类字段位**变化）。与第 2 条正交：
 *    set_script 重建输出段（2=true）但不动任何节点接线（3=false）。
 *
 * 4. `dataSourceRefs` = 对**跨对象数据源引用**的访问方向，与 planViewUpdate 的既有实读声明同口径
 *    （单一事实源在那里；本字段只是把「这个 op 属于哪一类」提前写成静态声明）：
 *      · 'read'  = 变换要读外部对象/范围——add_join 读 join 源视图（跨包只读引用，planViewUpdate 并进
 *                  readPackages）；set_script 的脚本 schema 限定名进 readSchemas（HANA_SCHEMA_ALLOW 面）。
 *      · 'write' = 会写外部数据源——当前**无 op 如此**（所有 op 只写目标对象自身的 XML；该值留给将来的 op）。
 *      · 'none'  = 不涉及任何跨对象引用（其余 op 都只改目标对象自身的 XML）。
 *
 * 5. **口径面**（第 1 条判据的第四个面）：`set_attribute_filter`（属性级单值过滤器，BW 常见的排除
 *    删除标记）与 `set_variable`（改输入参数默认值/必填）都不动输出字段与接线，但会改变**取数结果**——
 *    下游按原字段名取到的行集合/参数语义变了。它们照样声明 destructive=true（口径面被触碰），
 *    且判定表以 attribute_filter_changed / variable_changed 判「有下游 ⇒ 破坏」，不让这两类编辑
 *    从闸门旁边走过去。
 *
 * 依赖方向：声明层叶子——只 import core/errors（未知 id 要以中文硬错误暴露，与工具层错误口径一致），
 * 不做 I/O、不 import services/tools（同 src/rules/index.ts 的约定）。
 *
 * 覆盖范围：8 个 op 全量声明（清单见 `ViewOpId`）。`mode=spec`（目标态覆盖）有意不做——它只对
 * 「本服务生成过的视图」有可选意义，当前无实际需求。
 */

import { HanaBusinessError } from '../core/errors.js';

/** 操作 id（冻结）：`hana_view_update.operations` 可用的 op 判别式。与工具面 schema 的 discriminatedUnion 一一对应 */
export type ViewOpId =
  | 'add_join'
  | 'set_script'
  | 'set_description'
  | 'rename_field'
  | 'drop_field'
  | 'add_calculated_column'
  | 'set_attribute_filter'
  | 'set_variable';

/** 操作对**目标视图**的副作用画像（三条结构位 + 数据源位互相独立；判据见文件头注） */
export interface OpEffects {
  /** 是否可能触碰结构面（输出字段 / 节点接线映射 / 数据源引用）——**不是**「经判定会破坏下游」，也不是闸门；判据见头注 1 */
  destructive: boolean;
  /** 输出字段面：增删输出属性/度量、重写列集合与 datatype（output_field_* 信号面） */
  touchesOutputFields: boolean;
  /** 节点接线/映射面：节点增删、输入换人、mapping 重指向、logicalModel columnObjectName 重挂（*_rewired / input_changed 信号面） */
  touchesMapping: boolean;
  /** 跨对象数据源引用：'read' 要读外部对象/范围；'write' 会写外部数据源（当前无此 op）；'none' 无跨对象引用 */
  dataSourceRefs: 'read' | 'write' | 'none';
}

/**
 * 一条 op 声明。
 * `params` = 该 op 在工具 schema 里的**参数面**（全部字段名，含可选；**不含判别式 `op`**——`op` 是
 * 操作身份不是参数，交叉断言里另行钉住「`op` 字面量 = id」）。顺序对齐 schema 的字段声明顺序，
 * 便于两处对照阅读。
 */
export interface ViewOpDeclaration {
  id: ViewOpId;
  /** 短标题（门面索引里的展示名，如「加 join」；操作级能力条目 `<工具>#<op>` 的 title 用它） */
  title: string;
  summary: string;
  effects: OpEffects;
  params: string[];
  /** 可选：方言/坑/注意（一句话级别；细则在 rules=bw_dialect / sql_mode / write_receipt） */
  detail?: string;
}

/** 全量 op 声明（只读；顺序 = 列示顺序，不构成契约）。每条的依据是变换实现（model/view-edit.ts）与实测结论（view-diff / migrate.rules），不是拍脑袋 */
export const VIEW_OPS: readonly ViewOpDeclaration[] = [
  {
    // 依据（addJoinToViewXml）：新增 <DataSource>（读源视图定义 → 跨包只读引用）+ Projection/Join 节点；
    // 重接 logicalModel 全部 keyMapping/measureMapping 的 columnObjectName（机械重挂，diff 里表现为既有
    // 输出字段的 sourceObject 变化）；追加新的输出属性。「只增不改既有解析」⇒ 实测判非破坏；
    // 但结构面（数据源/节点接线/输出字段）全被触碰 ⇒ destructive=true（口径见头注 1）。
    id: 'add_join',
    title: '加 join',
    summary: '追加一个 join：读源视图定义，新增数据源/节点/输出字段并把输出重挂到新 join 节点',
    effects: { destructive: true, touchesOutputFields: true, touchesMapping: true, dataSourceRefs: 'read' },
    params: ['sourcePackageId', 'sourceObjectName', 'joinType', 'conditions', 'fields'],
    detail:
      '仅图形化（非 SCRIPT_BASED）单输出链状视图可变换（锚点唯一才动手）；leftField 必须已存在于当前输出节点，' +
      '带出字段不得与既有字段重名；源视图只读即可（可跨包）。实测口径：良性形态（仅新增 + 机械重挂且 passThrough 成立）判非破坏。',
  },
  {
    // 依据（setScriptInViewXml）：替换 <definition> 与节点 viewAttributes，并整体重建 logicalModel 输出段——
    // 输出列集合/类型可能变（删列/改类型），判定表按 script_changed + output_field_type_changed 判，对下游可能破坏。
    // 节点接线不动（SqlScriptView 单节点、无输入）⇒ touchesMapping=false；脚本 schema 限定名进读范围。
    id: 'set_script',
    title: '替换 SQL 脚本',
    summary: '替换 SQL 模式视图的脚本与输出列（重建 definition / viewAttributes / logicalModel 输出）',
    effects: { destructive: true, touchesOutputFields: true, touchesMapping: false, dataSourceRefs: 'read' },
    params: ['script', 'scriptColumns'],
    detail:
      '仅限单 SqlScriptView 节点的 SQL 模式视图；输出列清单**整体替换**（旧列不保留；理由见规则 sql_mode），' +
      '列 datatype 必填，含度量时服务端自动把根 dataCategory 重写为 CUBE（否则激活被 40117 拒）；' +
      '脚本文本一变即按 script_changed 的保守口径要求显式声明（不解析 SQL），脚本内 schema 限定名同时纳入读取范围核对。',
  },
  {
    // 依据（破坏性判定表，services/migrate.rules.ts）：描述/显示名（展示类属性）变更**永不破坏**（即便有下游）——下游消费的是字段与
    // 取数口径，不依赖 description/显示名。变换只做展示属性的最小替换，三个结构位全 false、无跨对象引用。
    id: 'set_description',
    title: '改描述/显示名',
    summary: '修改视图描述与/或显示名（只动展示属性，不碰结构）',
    effects: { destructive: false, touchesOutputFields: false, touchesMapping: false, dataSourceRefs: 'none' },
    params: ['description', 'displayName'],
    detail:
      '两个字段至少给一个（都不给 = 无操作，调用时以中文业务错误拒绝）。本仓方言里「描述」与「显示名」指向**同一处** ' +
      'XML 锚点（根 <descriptions defaultDescription>）：两个都给时要求两者一致，不一致以中文业务错误拒绝。' +
      '判定表明列：描述/显示名变更永不破坏——有下游引用时也无需 migration 声明。',
  },
  {
    // 依据（renameFieldInViewXml）：只改 logicalModel 输出字段的 id（输出**别名**）——keyMapping 的
    // columnName（节点列）不动，这是 HANA 里"改输出名"的语义。对下游而言旧名消失 ⇒
    // output_field_removed（改名 = 删旧 + 增新）在有下游时判破坏，策略 move（随改名迁移）。
    id: 'rename_field',
    title: '改输出字段名',
    summary: '改输出字段名（只动输出别名，节点列与接线不动）',
    effects: { destructive: true, touchesOutputFields: true, touchesMapping: false, dataSourceRefs: 'none' },
    params: ['field', 'newName'],
    detail:
      '只改 logicalModel 里的输出字段（属性/度量/计算字段；节点列叫什么不受影响）。被 logicalModel 的 ' +
      'calculatedAttributes/calculatedMeasures/restrictedMeasures 按名引用的字段**拒绝改名**（服务端不代改公式）。' +
      '有下游引用时属破坏性变更（删旧名 + 增新名），需 migration 声明（move = 随改名迁移）。',
  },
  {
    // 依据（dropFieldFromViewXml）：删 logicalModel 输出字段声明（keyMapping/measureMapping 随块删除；
    // 节点列不动）。output_field_removed 在有下游时判破坏（cast/preserve_column/move）。
    // 附带硬约束：删到 0 个度量时拒绝——本 SPS 激活要求 ≥1 度量（40117）。
    id: 'drop_field',
    title: '删输出字段',
    summary: '删输出字段（连它的 keyMapping/measureMapping 声明一起删；节点列不动）',
    effects: { destructive: true, touchesOutputFields: true, touchesMapping: false, dataSourceRefs: 'none' },
    params: ['field'],
    detail:
      '被 logicalModel 的 calculatedAttributes/calculatedMeasures/restrictedMeasures 按名引用的字段**拒绝删除**。' +
      '删除后视图必须仍有 ≥1 个度量（否则激活被 40117 拒，服务端在写入前即拒绝、零写入）。',
  },
  {
    // 依据（addCalculatedColumnToViewXml）：在节点上新增 <calculatedViewAttribute>（公式）+ 在 logicalModel
    // 追加输出属性（仅新增，不动既有字段/接线）。实测口径：**仅新增**输出字段不构成破坏（与
    // add_join 的良性形态同类）；但结构面被触碰 ⇒ destructive=true（口径见头注 1）。
    id: 'add_calculated_column',
    title: '加计算列',
    summary: '新增计算列（节点上写公式的 calculatedViewAttribute，并映射为输出属性）',
    effects: { destructive: true, touchesOutputFields: true, touchesMapping: false, dataSourceRefs: 'none' },
    params: ['name', 'formula', 'datatype', 'length', 'description', 'node'],
    detail:
      '列名不得与节点列或既有输出字段重名；公式为 COLUMN_ENGINE 方言（引用同节点列写 "列名"）；' +
      'datatype 必填（本环境实测 viewAttribute 类元素缺类型声明激活失败）。挂载节点缺省 = 输出节点，' +
      '且该节点必须有 <calculatedViewAttributes> 段。是属性列（不做计算度量；度量请走 xml 全量通道）。',
  },
  {
    // 依据（setAttributeFilterInViewXml）：给节点已有 viewAttribute 写属性级单值过滤器（BW 方言常见的
    // <filter xsi:type="Calculation:SingleValueFilter" including="…" value="…"/>）。它不动输出字段与接线，
    // 但**改变行集合**（下游取到的数据变了）⇒ 口径面（本文件头注第 5 条），判定表以
    // attribute_filter_changed 在有下游时判破坏（与"改输入数据源/基表"同类：语义漂移）。
    id: 'set_attribute_filter',
    title: '设属性过滤器',
    summary: '给节点属性设置单值过滤器（including=true 只保留该值；false 排除该值）',
    effects: { destructive: true, touchesOutputFields: false, touchesMapping: false, dataSourceRefs: 'none' },
    params: ['attribute', 'value', 'including', 'node'],
    detail:
      '只支持**已有 viewAttribute** 上的单值过滤器；该属性已有嵌套/多值过滤器（MultiValueFilter）时拒绝替换' +
      '（请走 xml 全量通道）。修改已有过滤器 = 替换。节点缺省 = 输出节点。',
  },
  {
    // 依据（setVariableInViewXml）：改已有输入参数的描述/默认值/必填。不动输出字段与接线，但改了
    // **参数默认语义**（未传参的下游取到的值变了）⇒ 口径面（头注第 5 条），判定表以 variable_changed
    // 在有下游时判破坏。只改已有变量：新建变量涉及默认值/类型/参数映射的完整语义，留给 xml 通道。
    id: 'set_variable',
    title: '改输入参数',
    summary: '修改已有输入参数（描述 / 默认值 / 是否必填）',
    effects: { destructive: true, touchesOutputFields: false, touchesMapping: false, dataSourceRefs: 'none' },
    params: ['variableId', 'defaultValue', 'description', 'mandatory'],
    detail:
      '三个字段至少给一个（都没给 = 无操作，拒绝）。只改已有变量（不存在即拒绝并列出现有 id）；' +
      '变量结构须为 <variable><variableProperties …/></variable>（本仓方言），否则拒绝。' +
      '有下游引用时属破坏性变更（参数默认语义变化），需 migration 声明。',
  },
];

/** id → 声明的模块内索引（仅供 getViewOp；不改变 VIEW_OPS 的对外顺序） */
const VIEW_OP_BY_ID: ReadonlyMap<string, ViewOpDeclaration> = new Map(VIEW_OPS.map((op) => [op.id, op]));

/**
 * 按 id 取声明。未知 id **抛中文硬错误并列出合法值**（口径同 src/rules/index.ts 的 getRules：
 * 静默给空会被读成「这条 op 没有声明」；调用方拿到的 id 可能是模型拼出来的，必须当场看到合法清单）。
 * 参数类型写 ViewOpId（编译期收口）；运行期仍兜底未知值——供 JS 调用方与反序列化数据。
 */
export function getViewOp(id: ViewOpId): ViewOpDeclaration {
  const decl = VIEW_OP_BY_ID.get(id);
  if (decl === undefined) {
    throw new HanaBusinessError(`未知操作 id："${String(id)}"。合法 id：${VIEW_OPS.map((op) => op.id).join(', ')}`);
  }
  return decl;
}
