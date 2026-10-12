/**
 * 异步任务工具（工具化任务 API）：hana_task_get（read）/ hana_task_cancel（write）。
 *
 * 任务由 `hana_view_update(async=true)` 提交（见 services/async-task.service.ts）；这两个工具是它的
 * 轮询/取消入口。归属判定在服务层（owner 不匹配 ⇒ 与不存在同形），工具层只做信封与文案；
 * 归属键的派生只有一处实现（surface.currentSurfaceKey），提交侧与查询/取消侧共用，不会各自漂移。
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

  // params 必须透传：清单里已声明 taskId 为必填，handler 不读取则 schema 校验通过但调用拿不到值
  regCap(CAP.hana_task_get, async (params) => {
    const view = taskViewFor(params.taskId, currentSurfaceKey());
    // 未知/他人任务：机读码与散文同源（不进业务失败信封——它不是"调用失败"，是查无此任务；
    // 与门面路由的"未知能力"同一形态：硬错误文本、不泄漏存在性）
    if (!view) return mcpErrorText(UNKNOWN_TASK_TEXT);
    const envelope: Envelope = await withErrorEnvelope(async () => view);
    return toToolResult(envelope);
  });

  regCap(CAP.hana_task_cancel, async (params) => {
    const r = cancelTaskFor(params.taskId, currentSurfaceKey());
    if (!r.ok) return mcpErrorText(UNKNOWN_TASK_TEXT);
    // 回执 = 任务视图 + 本次取消请求的处置结果（cancelOutcome）：requested=本次首次受理；
    // already_requested=此前已受理（重复取消与首次取消的回执由此可区分）；terminal=任务已到终态、本次未受理。
    const envelope: Envelope = await withErrorEnvelope(async () => ({ ...r.view, cancelOutcome: r.outcome }));
    return toToolResult(envelope);
  });
}
