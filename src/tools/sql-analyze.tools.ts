import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { analyzeSql } from '../services/sql-analyze.service.js';
import { validateAnalyzeRequest } from '../services/sql-analyze.rules.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { CAP } from '../capabilities/manifest.js';
import type { Envelope } from '../types/hana.js';

/**
 * SQL 分析工具（hana_sql_analyze，条目 kind: 'write'——只启用 read 的部署看不到它）。
 *
 * 经 capabilityRegistrar 按能力清单注册：预检闸门带资源维度——由 effects.plan（planSqlAnalyze）
 * 表达，在 handler 之前按「本次会读哪些 schema」对照生效策略判定（只做规划 + 判定，不执行）。
 * 闸门对所有能力统一生效、与工具归哪个分组无关；本工具不声明可写包，写边界的 boundary_off 不适用于它。
 */
export function registerSqlAnalyzeTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  regCap(CAP.hana_sql_analyze, async ({ sql, planId, analyze, statementName, raw, verbose, limit }) => {
    // 「sql 与 planId 恰有其一」 zod 表达不了：在 handler 里给可恢复错误（与 hana_view_create 同法）
    const problem = validateAnalyzeRequest({ sql, planId, analyze, statementName });
    if (problem) return mcpErrorText(problem.message, problem.hint);

    const envelope: Envelope = await withErrorEnvelope(() =>
      analyzeSql(ctx.pool, { sql, planId, analyze, statementName, raw, verbose, limit }),
    );
    return toToolResult(envelope);
  });
}
