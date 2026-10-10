/**
 * `diagnostics`（运维与性能）域的清单条目：SQL 分析（执行计划与运行时统计）。
 *
 * 本域当前只有 hana_sql_analyze 一条：SQL 的三态分析（编译看估计计划 / 解释计划缓存条目 /
 * 真执行后逐算子实测），`kind: 'write'`——闸门只做「规划 + 判定」，
 * 规划器为 planners.ts 的 planSqlAnalyze（理由见条目上方注释）。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { planSqlAnalyze } from '../planners.js';
// 入参上限/默认值取自规则层（唯一事实源）：schema 的边界必须与 validateAnalyzeRequest 的校验口径同步
import { DEFAULT_OPERATOR_LIMIT, MAX_LABEL_LENGTH, MAX_OPERATOR_LIMIT } from '../../services/sql-analyze.rules.js';

export const sqlAnalyzeCapabilities = {
  // hana_sql_analyze：接受任意 SQL 文本（analyze=true 时**真实执行**），且 plan_id 模式需要
  // OPTIMIZER ADMIN。它不写业务数据、不碰仓库——归 write 是**暴露面控制**（与建模同一档，
  // 依赖的 OPTIMIZER ADMIN 由服务端护栏与 HANA 权限兜底），不是因为它有副作用。
  hana_sql_analyze: cap({
    id: 'hana_sql_analyze',
    category: 'diagnostics',
    kind: 'write',
    effects: { plan: planSqlAnalyze, destructive: false, idempotent: false },
    title: 'SQL 分析（执行计划）',
    // 瘦身（P9）：三态命名对齐与 PlanViz 六栏/降级口径已整体搬进 rules=sql_analyze；
    // 这里保留取数方式、默认输出、护栏与 admin 归属（暴露面事实）。
    description:
      'SQL 分析：对一条 SELECT/WITH 给出**可读的分析结论**（默认输出，不需要自己读算子表）。\n' +
      '三种取数方式（sql 与 planId 二选一）：① sql=只编译不执行，给估计计划；' +
      '② planId=分析计划缓存里已执行过的语句（需 OPTIMIZER ADMIN）；③ sql + analyze=true=先真执行再分析' +
      '（默认走 PlanViz 通道拿逐算子实测；通道不可用时自动降级为估计计划 + 语句级统计，source=sqlExecuted）。\n' +
      '返回：conclusion（一句话结论 + 逐条发现[risk/warn/info，每条带依据与建议] + 统计 + conclusion.text）；' +
      '**默认不返回原始执行计划**，raw=true 才附算子明细（verbose=true 再加 OPERATOR_DETAILS/PROPERTIES）。\n' +
      '护栏：只允许单条 SELECT/WITH、不返回数据行、单次执行最多 5 分钟、最多取 100 行即关闭结果集；' +
      '语句内 schema 须在服务端允许范围内（未限定表名按当前用户默认 schema 判定）。\n' +
      '本工具归 **write** 组（只启用 read 的部署看不到它）。三态语义、PlanViz 六栏与降级口径见 rules=sql_analyze' +
      '（hana_system_get_info(rules=sql_analyze)）。',
    inputSchema: z.object({
      sql: z
        .string()
        .min(1)
        .max(100000)
        .optional()
        .describe('要分析的语句（仅 SELECT/WITH；与 planId 二选一）。默认只编译不执行'),
      planId: z
        .number()
        .int()
        .positive()
        .optional()
        .describe('计划缓存条目编号（与 sql 二选一）：SYS.M_SQL_PLAN_CACHE.PLAN_ID；需 OPTIMIZER ADMIN'),
      analyze: z
        .boolean()
        .default(false)
        .describe(
          '仅 sql 模式：true=先真执行再分析（走 PlanViz 通道拿逐算子实测 + 六栏 panels；通道不可用时降级为估计计划 + 语句级统计）。护栏：只允许 SELECT、单次执行最多 5 分钟、最多取 100 行、不返回数据行；默认 false',
        ),
      statementName: z
        .string()
        .min(1)
        .max(MAX_LABEL_LENGTH)
        .optional()
        .describe('输出标签（原样回显便于对照）；不影响服务端生成并使用的唯一语句名'),
      raw: z
        .boolean()
        .default(false)
        .describe('true=附带**原始执行计划**（算子行 + 缩进文本树）；默认 false，只给分析结论'),
      verbose: z
        .boolean()
        .default(false)
        .describe('仅 raw=true 时生效：附带算子明细 OPERATOR_DETAILS/PROPERTIES（服务端截断至 4000 字符）'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(MAX_OPERATOR_LIMIT)
        .default(DEFAULT_OPERATOR_LIMIT)
        .describe(`raw=true 时返回算子条数上限（默认 ${DEFAULT_OPERATOR_LIMIT}，最大 ${MAX_OPERATOR_LIMIT}）`),
    }),
    // 不破坏任何数据，但接受任意 SQL 且 analyze 模式会真跑——分组为 admin，客户端不应自动放行
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
