import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { attachResultInfo, resultInfoOf } from '../core/result-info.js';
import type { HanaPool } from '../core/hana-client.js';
import { analyzeSql } from '../services/sql-analyze.service.js';
import { validateAnalyzeRequest } from '../services/sql-analyze.rules.js';
import { submitBackgroundTask } from '../services/async-task.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { currentSurfaceKey } from './surface.js';
import { toToolResult } from './common.js';
import { CAP } from '../capabilities/manifest.js';
import type { Envelope } from '../types/hana.js';

/** limit 的 schema 默认值（单一事实源 = 清单） */
const OPERATOR_LIMIT_DEFAULT: number = CAP.hana_sql_analyze.inputSchema.shape.limit.parse(undefined);

/** 一次分析的入参（同步与异步通道共用） */
interface AnalyzeParams {
  sql?: string;
  planId?: number;
  analyze: boolean;
  statementName?: string;
  raw: boolean;
  verbose: boolean;
  limit: number;
}

/**
 * 执行分析并装配与同步通道**逐字段同形**的信封（异步任务体也用它）。
 * 结果契约（resultInfo）在这里统一挂载：同步返回与任务终态读法一致。
 */
async function analyzeEnvelope(pool: HanaPool, params: AnalyzeParams): Promise<Envelope> {
  return withErrorEnvelope(async () => {
    const result = await analyzeSql(pool, params);
    // 安全上限：回读路径的 HARD_OPERATOR_CAP（总行数 > 实际分析行数）。
    const safetyCapHit = result.totalOperatorCount > result.operatorCount;
    // raw=true：返回的算子行受 limit/安全上限约束，resultInfo 描述这批行。
    // raw=false：不返回算子行——只有安全上限截断了**分析所依据的计划**时才带 resultInfo
    // （此时它表示"结论基于不完整的计划"），普通结论不制造这个顶层字段。
    const info = params.raw
      ? resultInfoOf({
          returnedCount: result.operators?.length ?? 0,
          totalAvailable: result.totalOperatorCount,
          limit: params.limit,
          requestedLimit: params.limit !== OPERATOR_LIMIT_DEFAULT,
          safetyCapHit,
          truncated: (result.operators?.length ?? 0) < result.totalOperatorCount,
        })
      : safetyCapHit
        ? resultInfoOf({
            returnedCount: result.operatorCount,
            totalAvailable: result.totalOperatorCount,
            safetyCapHit: true,
            truncated: true,
          })
        : undefined;
    return attachResultInfo(result, info);
  });
}

/** 任务标签（轮询方认领用；不把整条 SQL 抄进任务列表） */
function analyzeLabel(params: AnalyzeParams): string {
  const who = params.statementName ?? (params.planId !== undefined ? `planId ${params.planId}` : 'sql');
  const label = `sql_analyze ${who}`;
  return label.length > 80 ? `${label.slice(0, 79)}…` : label;
}

/**
 * SQL 分析工具（hana_sql_analyze）。经 capabilityRegistrar 注册；
 * 资源维度由 effects.plan（planSqlAnalyze）表达，在 handler 之前按「本次会读哪些 schema」判定。
 *
 * `async=true`：只做形状校验后立即返回 taskId，真正的分析在后台任务里跑（与 changeset 共用任务 API）。
 */
export function registerSqlAnalyzeTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  regCap(CAP.hana_sql_analyze, async ({ sql, planId, analyze, async, statementName, raw, verbose, limit }) => {
    // 「sql 与 planId 恰有其一」zod 表达不了：在 handler 里给可恢复错误
    const problem = validateAnalyzeRequest({ sql, planId, analyze, statementName });
    if (problem) return mcpErrorText(problem.message, problem.hint);

    const params: AnalyzeParams = { sql, planId, analyze, statementName, raw, verbose, limit };
    if (async) {
      // 只做形状校验后立即返回；分析结果在任务终态 result 里（与同步信封同形）
      const envelope = await withErrorEnvelope(async () =>
        submitBackgroundTask(currentSurfaceKey(), {
          kind: 'sql_analyze',
          capabilityId: 'hana_sql_analyze',
          label: analyzeLabel(params),
          run: () => analyzeEnvelope(ctx.pool, params),
        }),
      );
      return toToolResult(envelope);
    }
    return toToolResult(await analyzeEnvelope(ctx.pool, params));
  });
}
