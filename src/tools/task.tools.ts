/**
 * 异步任务工具（工具化任务 API）：hana_task_get（read）/ hana_task_cancel（write）。
 * 任务由 hana_view_update(async=true) 提交；归属判定在服务层（owner 不匹配与不存在同形）。
 * 归属键只有一处派生（surface.currentSurfaceKey），提交侧与查询/取消侧共用。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { CAP } from '../capabilities/manifest.js';
import { cancelTaskFor, taskViewFor, UNKNOWN_TASK_TEXT } from '../services/async-task.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { currentSurfaceKey } from './surface.js';
import type { Envelope } from '../types/hana.js';

export function registerTaskTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  // params 必须整体透传：清单已声明 taskId 必填，handler 不读取就拿不到值。
  regCap(CAP.hana_task_get, async (params) => {
    const view = taskViewFor(params.taskId, currentSurfaceKey());
    // 未知/他人任务：硬错误文本、不泄漏存在性（与门面路由的「未知能力」同形）。
    if (!view) return mcpErrorText(UNKNOWN_TASK_TEXT);
    const envelope: Envelope = await withErrorEnvelope(async () => view);
    return toToolResult(envelope);
  });

  regCap(CAP.hana_task_cancel, async (params) => {
    const r = cancelTaskFor(params.taskId, currentSurfaceKey());
    if (!r.ok) return mcpErrorText(UNKNOWN_TASK_TEXT);
    // 回执 = 任务视图 + cancelOutcome（requested=首次受理；already_requested=此前已受理；terminal=已终态）。
    const envelope: Envelope = await withErrorEnvelope(async () => ({ ...r.view, cancelOutcome: r.outcome }));
    return toToolResult(envelope);
  });
}
