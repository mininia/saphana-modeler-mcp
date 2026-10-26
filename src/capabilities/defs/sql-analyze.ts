/**
 * diagnostics 清单条目：hana_sql_analyze（编译计划 / 计划缓存条目 / 真执行三态分析）。
 * kind=write 属暴露面控制（接受任意 SQL 且 analyze 会真跑），规划器为 planSqlAnalyze。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { planSqlAnalyze } from '../planners.js';
// 入参边界取自规则层（唯一事实源），须与 validateAnalyzeRequest 的校验口径同步
import { DEFAULT_OPERATOR_LIMIT, MAX_LABEL_LENGTH, MAX_OPERATOR_LIMIT } from '../../services/sql-analyze.rules.js';
// 描述里的护栏数字用插值生成（改常量会一起变）
import { ANALYZE_EXECUTION_TIMEOUT_MS, ANALYZE_MAX_ROWS } from '../../core/limits.js';

export const sqlAnalyzeCapabilities = {
  // 接受任意 SQL（analyze=true 时真实执行），plan_id 模式需 OPTIMIZER ADMIN；
  // 归 write 是暴露面控制——不写业务数据，唯一库侧写入是 EXPLAIN 计划行（见下方护栏段）。
  hana_sql_analyze: cap({
    id: 'hana_sql_analyze',
    category: 'diagnostics',
    kind: 'write',
    effects: { plan: planSqlAnalyze, destructive: false, idempotent: false },
    title: 'SQL 分析（执行计划）',
    // 三态命名、PlanViz 六栏与降级口径见 rules=sql_analyze；这里保留取数方式、默认输出与护栏。
    description:
      'SQL 分析：对一条 SELECT/WITH 给出可读的分析结论（默认输出，不需要自己读算子表）。\n' +
      '三种取数方式（sql 与 planId 二选一）：① sql=只编译不执行，给估计计划；② planId=分析计划缓存里已执行过的语句（需 OPTIMIZER ADMIN）；③ sql + analyze=true=先真执行再分析（默认走 PlanViz 通道拿逐算子实测；通道不可用时降级为估计计划 + 语句级统计，source=sqlExecuted）。\n' +
      '返回：conclusion（一句话结论 + 逐条发现[risk/warn/info，带依据与建议] + 统计）；默认不返回原始执行计划，raw=true 才附算子明细（verbose=true 再加 OPERATOR_DETAILS/PROPERTIES）。\n' +
      `护栏：只允许单条 SELECT/WITH、不返回数据行、单次执行最多 ${ANALYZE_EXECUTION_TIMEOUT_MS / 60_000} 分钟、最多取 ${ANALYZE_MAX_ROWS} 行即关闭结果集；语句内 schema 须在服务端允许范围内（sql/analyze 模式未限定表名按当前用户默认 schema 判定，planId 模式按条目编译时的 schema 判定）。\n` +
      '库侧写副作用：EXPLAIN 会向 SYS.EXPLAIN_PLAN_TABLE 写本次计划行（该表全库可读），回读后按唯一名删除；无 DELETE 权限时行残留，回执 planRowsCleaned=false + notes 给清理线索（PlanViz 通道不写该表）。\n' +
      '本工具归 write 组（只启用 read 的部署看不到它）。三态语义、PlanViz 六栏与降级口径见 rules=sql_analyze（hana_system_get_info）。',
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
          `仅 sql 模式：true=先真执行再分析（走 PlanViz 通道拿逐算子实测 + 六栏 panels；不可用时降级为估计计划 + 语句级统计）。护栏：只允许 SELECT、单次执行最多 ${ANALYZE_EXECUTION_TIMEOUT_MS / 60_000} 分钟、最多取 ${ANALYZE_MAX_ROWS} 行、不返回数据行；默认 false`,
        ),
      statementName: z
        .string()
        .min(1)
        .max(MAX_LABEL_LENGTH)
        .optional()
        .describe('输出标签（原样回显便于对照）；不影响服务端生成的唯一语句名'),
      raw: z
        .boolean()
        .default(false)
        .describe('true=附带原始执行计划（算子行 + 缩进文本树）；默认 false，只给分析结论'),
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
    // 不破坏数据，但接受任意 SQL 且 analyze 会真跑——归 write（客户端不应自动放行）
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
