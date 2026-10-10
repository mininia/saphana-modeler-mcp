/**
 * 异步任务工具（工具化任务 API，2026-10-10）：hana_task_get（read）/ hana_task_cancel（write）。
 *
 * 任务由 `hana_view_update(async=true)` 提交（见 services/async-task.service.ts）；这两个工具是它的
 * 轮询/取消入口。归属判定在服务层（owner 不匹配 ⇒ 与不存在同形），工具层只做信封与文案。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { currentIdentity } from '../core/request-context.js';
import { CAP } from '../capabilities/manifest.js';
import { cancelTaskFor, taskViewFor, UNKNOWN_TASK_TEXT } from '../services/async-task.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { surfaceKeyOf } from './surface.js';
import type { Envelope } from '../types/hana.js';

/**
 * 任务归属键 = 提升表同款口径（surfaceKeyOf）：HTTP 用已认证 clientId，stdio 用 '(stdio)'。
 * 未配 Token 的 HTTP 部署所有调用方都是 anonymous——与提升一致按单租户假设（互相可见，写进 README）。
 * 单点实现：hana_view_update(async) 的提交侧用同一个 surfaceKeyOf(currentIdentity())（I3）。
 */
function taskOwner(): string {
  return surfaceKeyOf(currentIdentity());
}

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  // params 必须透传（P9 教训：清单里声明的参数没接进 handler = 广告了但没人处理）
  regCap(CAP.hana_task_get, async (params) => {
    const view = taskViewFor(params.taskId, taskOwner());
    // 未知/他人任务：机读码与散文同源（不进业务失败信封——它不是"调用失败"，是查无此任务；
    // 与门面路由的"未知能力"同一形态：硬错误文本、不泄漏存在性）
    if (!view) return mcpErrorText(UNKNOWN_TASK_TEXT);
    const envelope: Envelope = await withErrorEnvelope(async () => view);
    return toToolResult(envelope);
  });

  regCap(CAP.hana_task_cancel, async (params) => {
    const r = cancelTaskFor(params.taskId, taskOwner());
    if (!r.ok) return mcpErrorText(UNKNOWN_TASK_TEXT);
    const envelope: Envelope = await withErrorEnvelope(async () => r.view);
    return toToolResult(envelope);
  });
}
