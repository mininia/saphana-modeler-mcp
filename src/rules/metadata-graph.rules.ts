import type { RuleObject } from './index.js';

/**
 * 血缘与影响半径规则（关系图 / 字段级血缘）。
 *
 * 来源（搬迁自，保留原文措辞）：
 * - src/server.ts 的 SERVER_INSTRUCTIONS 第 17、27 行（血缘数据源与「改/删前查依赖」）；
 * - src/capabilities/defs/metadata.ts 的 hana_metadata_where_used.description（depth 与闭包口径）、
 *   hana_metadata_get_field_logic.description（includeUsage 字段级血缘）、
 *   hana_metadata_search_objects.description（by=field 反查）；
 * - src/services/repository.service.ts 的 P4/P6 头注（**判定用的是直接下游（单跳）**，传递影响面另查 depth>1）；
 * - src/services/catalog.service.ts 的头注（asOf = 构建时刻）。
 */

export const metadataGraphRules: readonly RuleObject[] = [
  {
    id: 'metadata_graph',
    title: '血缘与影响半径：单跳判定、depth>1 传递',
    detail: [
      '数据源 _SYS_REPO.ACTIVE_OBJECTCROSSREF：upstream=该视图引用了哪些对象（数据源/上游视图）；',
      'downstream=哪些对象引用了该视图（下游视图/运行时目录视图，isRuntime=true 表示激活后 _SYS_BIC 的引用）。',
      '',
      "hana_metadata_where_used 的 depth：默认 1 = 直接依赖（**单跳**，原语义）；depth>1 或 'all' 追加多跳闭包",
      'closure（按方向拆分、去重排序；返回 depthReached/truncated/asOf，触达 maxNodes 上限即 truncated=true，',
      '不静默丢）。',
      '',
      '**写侧判定用的是直接下游（单跳）**：hana_view_update / hana_view_delete 的破坏性判定与影响半径都按',
      'impact() 默认 depth=1 计算（每次写跑全闭包代价太大），口径写死就是为了防止将来有人改默认值、让判定静默漂移；',
      '需要**传递影响面**时另行用 hana_metadata_where_used(depth>1)。判定输入的下游只计**设计时引用**',
      '（__RT_* 运行时目录引用已过滤——不过滤时任何已激活对象的下游恒非空；过滤条数以 runtimeOnly 如实回报，',
      '供「过滤没有静默吃掉引用」复核）。',
      '',
      '字段级血缘：hana_metadata_get_field_logic(includeUsage=true)——谁在哪个节点引用了该字段：',
      '逐列归因的命中在 usage.downstream（含消费方节点与目标列）；列名对齐型输入（Union 无映射）另列',
      'usage.nameAlignedConsumers；带 viewsScanned/truncated/asOf 扫描口径（受 usageMaxViews 约束，默认 50）。',
      '',
      '使用时机：修改/删除视图前用 hana_metadata_where_used 评估影响面；',
      '反向「哪些视图的输出里含某字段」用 hana_metadata_search_objects(by=field)；',
      '扫描类结果一律带 asOf（构建时刻，进程时区 ISO 秒级）——读的是「哪个时点的图」，不是实时；截断时 truncated=true。',
    ].join('\n'),
    tools: ['hana_metadata_where_used', 'hana_metadata_get_field_logic', 'hana_metadata_search_objects'],
  },
];
