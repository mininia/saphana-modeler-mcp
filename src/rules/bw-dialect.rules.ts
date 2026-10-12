import type { RuleObject } from './index.js';

/**
 * BW / Studio 方言规则（join 重命名、聚合两形态、schema 别名、读数新鲜度口径）。
 *
 * 这些方言契约与实测注记的权威落点（hana_system_get_info(rules=bw_dialect)）：改契约先改这里。
 * 相关代码路径（view-edit / view-builder / view-diff / view-cache 等）的头注可给指针、也可为解释
 * 自身行为复述个别口径（如聚合归一化基准、缓存新鲜度校验），但都不作权威——完整契约以本文件为准。
 */

export const bwDialectRules: readonly RuleObject[] = [
  {
    id: 'bw_dialect',
    title: 'BW 方言：join 重命名、聚合两形态、schema 别名',
    detail: [
      'join 输入映射重命名（BW 同款，op=add_join 据此接线）：左右列名不同时，在 join 输入映射里重命名——',
      'target=左字段、source=右字段（范本：某 16 级 join 链视图的 Join_1，target="0MATERIAL"',
      'source="4ZDEMO01R014_TH"）；joinAttribute 用**左侧字段名**。',
      '目标形态与 BW query 视图生成器同款：新增 DataSource（type=CALCULATION_VIEW，resourceUri 指向源视图）→',
      '新增 Projection 把源视图字段取出来 → 新增 Join（左输入=原输出节点全字段透传，右输入=条件/带出字段映射）→',
      'logicalModel 的 id 与**全部** keyMapping/measureMapping 的 columnObjectName 重接线到新 Join 节点、',
      '并为带出字段追加 attribute（order 顺延，带源字段中文描述）。',
      '变换实现为对 XML 的「锚点字符串手术」（</dataSources>、</calculationViews>、</logicalModel>、</attributes>',
      '等锚点实测各恰好 1 个），除插入/替换外逐字节保留（informationModelLayout、layout shapes、hidden 零损耗）。',
      '',
      'Aggregation 节点的两种方言（解析 / 比对 / 生成共用同一归一，禁止各写一份）：',
      '- 格式 A：aggregateBy（分组列）+ measureMapping（度量映射：列 + 聚合函数）；',
      '- 格式 B：viewAttribute 带 @aggregationType = 度量，无 aggregationType 的属性 = 分组维度。',
      '归一判据：节点有 aggregateBy 或 measures 时按格式 A 取，否则按格式 B 从 viewAttribute 提取。',
      '',
      'schema 别名 ABAP↔SAPABAP1：BW on HANA 的设计时 XML 中 schemaName="ABAP" 是**源系统名**而非数据库 schema，',
      '真实表在 SAPABAP1；比对（view-diff）、预览（preview.derive）、诊断（preview-diagnose）共用同一映射',
      'normalizeBwSchema，先归一再比较。',
      '',
      '读数新鲜度（asOf 口径）：血缘/关系图结果带 asOf=构建时刻（进程时区 ISO 秒级）——报的是「哪个时点的图」；',
      '视图定义解析缓存（view-cache）TTL 60 秒 + 命中时轻量 VERSION_ID 校验（只 SELECT 版本列、不取 CDATA），',
      '版本变了即失效重取；缓存 key 覆盖包/对象/类型（同一份 _SYS_REPO.CDATA 对所有调用方相同）。',
    ].join('\n'),
    tools: ['hana_view_update', 'hana_data_preview', 'hana_metadata_where_used', 'hana_metadata_get_field_logic'],
  },
];
