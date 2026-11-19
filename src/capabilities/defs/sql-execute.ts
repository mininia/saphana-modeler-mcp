/**
 * 独立分类 `sql` 的清单条目：hana_sql_execute（直接执行 HANA SQL）。
 *
 * kind=`sql` 是独立且默认关闭的分组（见 tools/groups.ts）。
 * 它不是常驻工具：显式启用后经 `hana_tool_search` 发现/披露，再由 `hana_invoke` 执行；
 * 授权（sql 组 + 调用方档案）在发现与执行两层都生效。
 *
 * SQL 专用 schema 闸门已按产品决策移除：服务端不扫描/拦截 schema，访问范围由数据库账号权限约束。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { planSqlExecute } from '../planners.js';
import {
  SQL_EXEC_TIMEOUT_MS_DEFAULT,
  SQL_EXEC_TIMEOUT_MS_LIMIT,
  SQL_MAX_ROWS_DEFAULT,
  SQL_MAX_ROWS_LIMIT,
} from '../../core/limits.js';

export const sqlExecuteCapabilities = {
  hana_sql_execute: cap({
    id: 'hana_sql_execute',
    category: 'sql',
    kind: 'sql',
    effects: { plan: planSqlExecute, destructive: true, idempotent: false, mutates: 'persistent' },
    routing: {
      intent: '在 HANA 上直接执行 SQL（读/写/管理类；默认关闭）',
      whenToUse: ['用户明确要求执行某条 SQL，且部署已启用 sql 组'],
      notFor: ['建模/读元数据/预览用专用工具；EXPLAIN 用 hana_sql_analyze'],
      priority: 'advanced',
      requires: 'sql 组显式启用（HANA_TOOL_GROUPS 含 sql 或 hana_sql_execute）',
      exampleArgs: { sql: 'SELECT * FROM DUMMY' },
    },
    title: '直接执行 HANA SQL',
    description:
      '在 HANA 上直接执行 SQL（读/写/管理类）；SELECT 返回列名+行，DML/DDL 返回 affectedRows。\n' +
      '**仅在用户明确要求执行 SQL 时才调用**；不要主动探测、验证或替代专用工具。\n' +
      '默认单条语句+单物理行；多行/多语句需部署方开启 HANA_SQL_ALLOW_MULTI_STATEMENT（有写时自动事务，失败回滚）。显式事务控制与修改会话状态的 SET 一律拒绝；管理类默认允许（受 DB 账号权限约束）；DO 块/过程体用 CALL；EXPLAIN 用 hana_sql_analyze。\n' +
      `maxRows/timeoutMs 为调用参数（默认 ${SQL_MAX_ROWS_DEFAULT} 行/${SQL_EXEC_TIMEOUT_MS_DEFAULT}ms，上限 ${SQL_MAX_ROWS_LIMIT} 行/${SQL_EXEC_TIMEOUT_MS_LIMIT}ms），超出标记 truncated；async=true 返回 taskId，用 hana_task_get 轮询（执行中的 SQL 无法取消）。\n` +
      '不做 schema 级拦截，访问范围由 HANA 账号权限决定；sql 组默认关闭，需部署方显式启用。',
    inputSchema: z.object({
      sql: z.string().describe('要执行的 SQL（默认单条、单物理行；不接受绑定占位符 ? / :name）'),
      maxRows: z
        .number()
        .int()
        .min(1)
        .max(SQL_MAX_ROWS_LIMIT)
        .default(SQL_MAX_ROWS_DEFAULT)
        .describe(`最多回读的行数（默认 ${SQL_MAX_ROWS_DEFAULT}，最大 ${SQL_MAX_ROWS_LIMIT}）`),
      timeoutMs: z
        .number()
        .int()
        .min(1)
        .max(SQL_EXEC_TIMEOUT_MS_LIMIT)
        .default(SQL_EXEC_TIMEOUT_MS_DEFAULT)
        .describe(`单条语句执行超时 ms（默认 ${SQL_EXEC_TIMEOUT_MS_DEFAULT}，最大 ${SQL_EXEC_TIMEOUT_MS_LIMIT}）`),
      async: z
        .boolean()
        .default(false)
        .describe('true=后台执行并立即返回 taskId，用 hana_task_get 轮询；执行中的 SQL 无法取消'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
