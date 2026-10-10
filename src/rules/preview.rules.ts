import type { RuleObject } from './index.js';

/**
 * 数据预览规则（视图预览 / 基表勘察 / 节点预览 / 权限诊断）。
 *
 * 来源（搬迁自，保留原文措辞）：
 * - src/server.ts 的 SERVER_INSTRUCTIONS 第 34、36 行；
 * - src/capabilities/defs/preview.ts 的 hana_data_preview.description（两模式与节点通道一段）
 *   与 hana_data_preview_diagnose.description（通道语义与 brief 字段）；
 * - src/services/preview.service.ts 与 preview-diagnose.service.ts 的头注（中间视图命名/释放口径、
 *   权限类失败自动诊断的码集 258/259）。
 */

export const previewRules: readonly RuleObject[] = [
  {
    id: 'preview',
    title: '数据预览：勘察/视图/节点三路与权限诊断',
    detail: [
      '两种目标（二选一）：',
      '① **基表勘察模式**（给 schema + table，跨表建模前**先做这一步**）：直接对源表采样并逐列画像——',
      '   去重值样例、长度区间（uniformLength/minLength/maxLength）、含前导零的值样例（zeroPaddedSamples）、',
      '   采样 NULL 数。用来把三件事核清楚，避免「激活成功但 0 行」的隐性返工：',
      '   (a) 数据在哪张表或分区（BW 变更日志表 vs 活动数据表；换 table 再查一次即可对比行数）；',
      '   (b) 关联键补零格式是否一致（15 位零填充 vs 不补零是跨表关联的头号隐性杀手；两侧长度不一致会静默丢结果）；',
      '   (c) 号码列语义（编号可能在 /BIC/Z* 客户字段而非 *NUM 标准字段）。',
      '   统计**只基于采样行**（sampleRows，默认 200）——不跑 COUNT(*) 这类全表操作，大表上代价可控。',
      '② 视图预览模式（给 packageId + objectName）：对已激活视图整体预览（_SYS_BIC 直查）——支持范围有限，',
      '   不支持即直接返回「不支持」，不做其他尝试；无筛选默认 10 行、有筛选默认 100 行、显式 limit 上限 1000',
      '   （truncated 由多取 1 行探测）；VIRTUAL 视图用 parameters 传输入参数（WITH PARAMETERS PLACEHOLDER）。',
      '   筛选条件（filter）以 AND 连接且值参数绑定；返回 via（direct/intermediate/derived）/columns/rows/truncated。',
      '',
      '节点预览（**仅当用户明确要求看某视图的某个节点时才传 node**）：走 HANA 原生中间视图机制',
      'CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV（Studio 同款，任意节点类型支持）：',
      '- 中间视图名固定为「包/对象/dp/节点」（在 _SYS_BIC 内，人工可直接定位）；',
      '- 已存在同名视图即复用、不重复创建（并发调用、上次残留、他人建的都走这条）；**复用不校验新鲜度**——',
      '  CV 重新激活后同名视图仍是旧定义，需要最新数据时先删掉该视图或改用 forceDerive；',
      '  **但回执附新鲜度判据**（D1）：复用路径的 intermediate.freshness = { createdAt（中间视图创建时间）、',
      '  activatedAt（源对象最近一次激活时间）、stale（createdAt 早于 activatedAt ⇒ 复用到旧定义）}；',
      '  stale=true 时自行决定「先删该视图 / 改 forceDerive / 接受旧数据」——服务端只给判据、不改行为；',
      '- 查询结束后，仅在本进程已无调用占用且视图由本服务创建时才 DROP（结果里 intermediate 回报 reused/dropped），',
      '  否则保留、交由下次调用复用；',
      '- 需要 EXECUTE 权限，缺权限直接返回不支持（不会自动回退）。',
      '只读 XML 推导模式（forceDerive=true，需显式启用）：支持 Projection/Join/Aggregation/Union/Rank，',
      'SqlScriptView/变量/复杂节点不支持；节点预览复用旧定义时也用它绕开。',
      '',
      '权限诊断：权限类失败（缺 EXECUTE/SELECT、_SYS_BIC 对象不可见的 258/259）会自动附带权限诊断报告',
      '（envelope.raw.diagnosis），无需额外调用即可定位阻塞点；hana_data_preview_diagnose 可手动前置排查或',
      '区分「权限缺失」与「对象未激活」：channel=direct（只测当前 CV + 分析权限）；channel=intermediate',
      '（节点预览场景，额外检查中间视图过程 EXECUTE 权限）；channel=derived（默认，追溯并实测上游数据源可达性）；',
      '默认精简只给 brief（upstreamInaccessible / analyticPrivilege / runtimeAccessible / canPreview），',
      'verbose=true 才给完整 checks/baseTables 明细。',
    ].join('\n'),
    errorCodes: ['258', '259'],
    tools: ['hana_data_preview', 'hana_data_preview_diagnose'],
  },
];
