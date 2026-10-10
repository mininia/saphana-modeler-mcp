import type { RuleObject } from './index.js';

/**
 * 建模基础规则（服务定位 / 仓库与运行时布局 / 对象类型 / 命名与引用约定 / 工具命名）。
 *
 * 来源（搬迁自，保留原文措辞）：src/server.ts 的 SERVER_INSTRUCTIONS 第 15、17、19–29 行。
 *
 * 为什么单列一条（非冻结 id）：瘦身批会把 instructions 压到最短，这些「背景事实」是其余规则的
 * 上下文（对象是什么、放哪、怎么引用）——没有落点就只能整段留常驻或整段丢，故按同一规范补条目。
 */

export const modelBasicsRules: readonly RuleObject[] = [
  {
    id: 'model_basics',
    title: '建模基础：对象类型、命名引用与仓库布局',
    detail: [
      '服务定位：saphana-modeler-mcp = SAP HANA 经典 Modeler（HANA 2.0 本地部署，仓库建模）的 MCP 服务器。',
      '',
      '背景（仓库/运行时布局）：设计时对象（信息视图/权限/过程）以 XML 存储于 _SYS_REPO 仓库（Package 组织）；',
      '激活后生成运行时列视图到 _SYS_BIC schema；元数据可查 _SYS_BI.BIMC_*；对象血缘用 hana_metadata_where_used',
      '（数据源 _SYS_REPO.ACTIVE_OBJECTCROSSREF）。',
      '',
      '对象类型：',
      '- calculationview（Calculation View，图形化节点模型，HANA 2.0 推荐）',
      '- attributeview / analyticview（Attribute/Analytic View，主数据维度/星型模型；HANA 2.0 已标记废弃，仅存量支持）',
      '- analyticprivilege（Analytic Privilege，数据访问权限）',
      '- procedure（SQLScript 过程）、virtualtable、decisiontable',
      '',
      '命名与引用约定：',
      '- 包名与对象名区分大小写；引用已激活视图用 "_SYS_BIC"."包/视图名"（包层级用 . 分隔）；',
      '- 写操作（hana_view_*）必须先 validate 再 activate；删除/更新会波及依赖方，依赖关系用',
      '  hana_metadata_where_used 查询（写侧的破坏性判定口径见规则 metadata_graph）。',
      '',
      '工具命名：hana_system_*（系统信息）、hana_metadata_*（只读元数据：字段清单/单字段逻辑/血缘/表）、',
      'hana_package_*（包）、hana_data_preview（数据预览）、hana_view_*（建模写操作）。',
    ].join('\n'),
    tools: [
      'hana_system_get_info',
      'hana_metadata_get_view',
      'hana_metadata_list_fields',
      'hana_metadata_get_field_logic',
      'hana_metadata_where_used',
      'hana_package_list',
      'hana_data_preview',
      'hana_view_create',
    ],
  },
];
