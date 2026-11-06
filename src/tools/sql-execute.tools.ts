/**
 * hana_sql_execute 工具层：SQL 直接执行（默认关闭的 `sql` 组，独立第七根工具）。
 *
 * 执行前先跑规则层（零 I/O）把可恢复问题变成 isError；执行走统一错误信封；
 * 有截断时用 `resultInfoOf` 挂统一截断契约（信封提升到 envelope.resultInfo）。
 * `async=true` 时只做规则预检并提交后台任务，立即返回 taskId（与 hana_sql_analyze 同一套任务 API）。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { attachResultInfo, resultInfoOf } from '../core/result-info.js';
import type { HanaPool } from '../core/hana-client.js';
import type { HanaConfig } from '../config/config.js';
import type { Envelope } from '../types/hana.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { currentSurfaceKey } from './surface.js';
import { toToolResult } from './common.js';
import { CAP } from '../capabilities/manifest.js';
import { parseSqlScript } from '../services/sql-execute.rules.js';
import { executeSql, sqlExecutePolicyOf } from '../services/sql-execute.service.js';
import { submitBackgroundTask } from '../services/async-task.service.js';

interface SqlExecuteParams {
  sql: string;
  maxRows: number;
  timeoutMs: number;
}

/** 同步与异步任务体共用的信封装配（结果契约与两条通道逐字段同形） */
async function executeEnvelope(pool: HanaPool, config: HanaConfig, params: SqlExecuteParams): Promise<Envelope> {
  return withErrorEnvelope(async () => {
    const result = await executeSql(pool, config, params.sql, {
      maxRows: params.maxRows,
      timeoutMs: params.timeoutMs,
    });
    const returnedRows = result.statements.reduce((sum, s) => sum + (s.rowsFetched ?? 0), 0);
    const info = result.truncated
      ? resultInfoOf({ returnedCount: returnedRows, serverCapHit: true, truncated: true })
      : undefined;
    return attachResultInfo(result, info);
  });
}

/**
 * SQL 直接执行工具。经 capabilityRegistrar 注册；资源维度不声明（SQL 专用 schema 闸门已移除），
 * 授权只按 `sql` 组 + 调用方档案判定；能访问什么由数据库账号权限约束。
 */
export function registerSqlExecuteTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  regCap(CAP.hana_sql_execute, async ({ sql, maxRows, timeoutMs, async: asyncMode }) => {
    // 规则层先校验：空/NUL/占位符/多行/多语句/事务控制/EXPLAIN/DO 都由它给稳定码与中文提示
    const parsed = parseSqlScript(sql, sqlExecutePolicyOf(ctx.config));
    if (parsed.problems.length > 0) {
      const first = parsed.problems[0];
      return mcpErrorText(first.message, first.hint);
    }
    const params: SqlExecuteParams = { sql, maxRows, timeoutMs };
    if (asyncMode) {
      // 只做规则预检后立即返回；执行结果在任务终态 result 里（与同步信封同形）。
      // 标签只带指纹，不把 SQL 原文抄进任务列表。
      const envelope = await withErrorEnvelope(async () =>
        submitBackgroundTask(currentSurfaceKey(), {
          kind: 'sql_execute',
          capabilityId: 'hana_sql_execute',
          label: `sql_execute ${parsed.fingerprint}`,
          run: () => executeEnvelope(ctx.pool, ctx.config, params),
        }),
      );
      return toToolResult(envelope);
    }
    return toToolResult(await executeEnvelope(ctx.pool, ctx.config, params));
  });
}
