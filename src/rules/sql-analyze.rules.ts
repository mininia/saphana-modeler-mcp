import type { RuleObject } from './index.js';

/**
 * SQL 分析规则（hana_sql_analyze）。
 *
 * 来源（搬迁自，保留原文措辞）：
 * - src/server.ts 的 SERVER_INSTRUCTIONS 第 38–42 行（结论/三种取数方式/PlanViz 六栏/护栏/schema 范围/admin 归属）；
 * - src/capabilities/defs/sql-analyze.ts 的 description（三态命名对齐官方 Visualize Plan 流程、降级口径）。
 */

export const sqlAnalyzeRules: readonly RuleObject[] = [
  {
    id: 'sql_analyze',
    title: 'SQL 分析：三态取数、PlanViz 实测与硬护栏',
    detail: [
      '三种取数方式（sql 与 planId 二选一；命名对齐 SAP 官方的 Visualize Plan 流程）：',
      '① sql：只编译不执行，给**估计计划**（对应官方「Visualize Plan」的 Visualized Plan）；',
      '② planId：分析计划缓存里**已执行过**的语句（编号取自 SYS.M_SQL_PLAN_CACHE.PLAN_ID，需 OPTIMIZER ADMIN；',
      '   对应官方「SQL Plan Cache → Visualize Plan」）；',
      '③ sql + analyze=true：**先执行、再分析**——默认走 **PlanViz 通道**（与官方 Executed Plan / F8 同一条路），',
      '   产出逐算子实测：panels 六栏——Plan Graph（父子结构与算子类型分布）、Physical Plan（最耗时算子）、',
      '   Execution Time（独占/含子/CPU/内存）、Timeline（跨度与线程数）、Table Access（按对象聚合访问次数与耗时）、',
      '   Logical Plan（子计划/逻辑内层计划）；结论据此给出只有执行过才知道的判断：瓶颈算子或瓶颈对象、',
      '   实际与估计行数的偏离（统计信息是否陈旧）、真实并行度、大中间结果物化。',
      '   通道不可用时（服务端版本不支持等）**自动降级**为「执行后按语句文本关联计划缓存条目」：此时计划是',
      '   EXPLAIN 的**估计值**、只有**语句级**聚合统计，notes 会写明降级原因，source=sqlExecuted 即降级结果',
      '   （别当逐算子实测读）。',
      '',
      '硬护栏（analyze 执行侧）：只允许 SELECT、单次执行最多 5 分钟（PlanViz 控制面调用 30 秒）、',
      '最多取 100 行即关闭结果集、**不返回数据行**。',
      '语句约束：只接受单条 SELECT/WITH；多语句、绑定占位符（? 或 :name）、DML/DDL/过程调用一律拒绝；',
      '语句内 schema 须落在服务端允许范围内（未限定表名按当前用户默认 schema 判定）。',
      '',
      '默认输出是**一段可读的分析结论**（conclusion：一句话结论 + 逐条发现[risk/warn/info，每条带依据与建议] +',
      '统计[引擎/表与规模/扫描次数/连接次数/预计输出行数]，并附 conclusion.text 整段文本）；**默认不返回原始',
      '执行计划**——要算子明细才传 raw=true（verbose=true 再加 OPERATOR_DETAILS/PROPERTIES）。',
      '结论覆盖：全表扫描与表规模（大表、占位估计值）、是否缺过滤条件、跨执行引擎切换、嵌套循环连接、计划结构异常；',
      'planId/analyze 模式另带运行时统计（次数/平均耗时/内存）。',
      '',
      '归属：write 组（只启用 read 的部署看不到它）——接受任意 SQL 且 analyze 会真跑，',
      '与建模同档做暴露面控制，不是因为它写数据（不写业务数据、不碰仓库）。',
    ].join('\n'),
    tools: ['hana_sql_analyze'],
  },
];
