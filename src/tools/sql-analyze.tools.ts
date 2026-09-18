import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { analyzeSql } from '../services/sql-analyze.service.js';
import {
  DEFAULT_OPERATOR_LIMIT,
  MAX_LABEL_LENGTH,
  MAX_OPERATOR_LIMIT,
  validateAnalyzeRequest,
} from '../services/sql-analyze.rules.js';
import { registerWriteTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

/**
 * SQL 分析工具（hana_sql_analyze，分组 **admin**）。
 *
 * 走 registerWriteTool 而不是 registerVisibleTool：要的就是它**在 handler 之前**的预检闸门
 * （规划本次会读哪些 schema → 对照生效策略判定）。该闸门只做"规划 + 判定"，与工具归哪个分组无关；
 * 因为本工具不声明可写包，写边界的 boundary_off 不适用于它。
 */
export function registerSqlAnalyzeTools(server: McpServer, ctx: ToolContext): void {
  const regWrite = registerWriteTool(server, ctx);
  regWrite(
    'hana_sql_analyze',
    {
      title: 'SQL 分析（执行计划）',
      description:
        'SQL 分析：对一条 SELECT/WITH 给出**可读的分析结论**（默认输出，不需要你自己读算子表）。' +
        '默认返回 conclusion：一句话结论 + 逐条发现（级别 risk/warn/info，每条带**依据**与**建议**）' +
        '+ 统计（执行引擎/涉及的表与规模/扫描次数/连接次数/预计输出行数），另附 conclusion.text 整段文本。\n' +
        '结论覆盖：全表扫描与表规模（大表扫描、规模占位估计值）、是否缺过滤条件、跨执行引擎切换、' +
        '嵌套循环连接、计划结构异常；planId/analyze 模式还会带上运行时统计（执行次数/平均耗时/内存）。\n' +
        '**默认不返回原始执行计划**；确需算子明细时传 raw=true（算子行 + 缩进文本树，verbose=true 再加 OPERATOR_DETAILS/PROPERTIES）。\n' +
        '三种取数方式（sql 与 planId 二选一）：① sql：只编译不执行；' +
        '② planId：分析计划缓存里**已执行过**的语句（编号取自 SYS.M_SQL_PLAN_CACHE.PLAN_ID，需 OPTIMIZER ADMIN）；' +
        '③ sql + analyze=true：**先实际执行再分析**——EXPLAIN 只有估计值，实测耗时/内存只存在于执行之后；' +
        '执行受硬护栏：只允许 SELECT、30 秒超时、最多取 100 行即关闭结果集、**不返回数据行**，' +
        '执行后按相同语句文本关联计划缓存条目，因此拿到的还是重编译（参数感知）的计划。\n' +
        '读取范围：语句内的 schema 必须落在服务端允许范围内（未限定表名按当前用户默认 schema 判定）。\n' +
        '限制：一次只分析**一条 SELECT/WITH**；多语句、绑定占位符（? 或 :name）、DML/DDL/过程调用一律拒绝。',
      inputSchema: z.object({
        sql: z.string().min(1).max(100000).optional()
          .describe('要分析的语句（仅 SELECT/WITH；与 planId 二选一）。默认只编译不执行'),
        planId: z.number().int().positive().optional()
          .describe('计划缓存条目编号（与 sql 二选一）：SYS.M_SQL_PLAN_CACHE.PLAN_ID；需 OPTIMIZER ADMIN'),
        analyze: z.boolean().default(false)
          .describe('仅 sql 模式：true=先实际执行再分析（30s 超时、最多取 100 行、不返回数据行）；默认 false'),
        statementName: z.string().min(1).max(MAX_LABEL_LENGTH).optional()
          .describe('输出标签（原样回显便于对照）；不影响服务端生成并使用的唯一语句名'),
        raw: z.boolean().default(false)
          .describe('true=附带**原始执行计划**（算子行 + 缩进文本树）；默认 false，只给分析结论'),
        verbose: z.boolean().default(false)
          .describe('仅 raw=true 时生效：附带算子明细 OPERATOR_DETAILS/PROPERTIES（服务端截断至 4000 字符）'),
        limit: z.number().int().min(1).max(MAX_OPERATOR_LIMIT).default(DEFAULT_OPERATOR_LIMIT)
          .describe(`raw=true 时返回算子条数上限（默认 ${DEFAULT_OPERATOR_LIMIT}，最大 ${MAX_OPERATOR_LIMIT}）`),
      }),
      // 不破坏任何数据，但接受任意 SQL 且 analyze 模式会真跑——分组为 admin，客户端不应自动放行
      annotations: { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ sql, planId, analyze, statementName, raw, verbose, limit }) => {
      // "sql 与 planId 恰有其一" zod 表达不了：在 handler 里给可恢复错误（与 hana_view_create 同法）
      const problem = validateAnalyzeRequest({ sql, planId, analyze, statementName });
      if (problem) return mcpErrorText(problem.message, problem.hint);

      const envelope: Envelope = await withErrorEnvelope(() =>
        analyzeSql(ctx.pool, { sql, planId, analyze, statementName, raw, verbose, limit }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
}
