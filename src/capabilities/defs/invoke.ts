/**
 * `hana_invoke` 清单条目：**唯一执行入口**（另一个常驻平台工具是 `hana_tool_search`）。
 *
 * 边界：
 * - 只执行**目标能力**；平台入口自身不可作为目标（防递归）；
 * - 授权、schema、预检、审批、审计全部按目标能力判定；
 * - 不按分类扇出：`capability` 是全局 id，操作级别名（`<工具>#<op>`）也走这里；
 * - 未知与无权逐字同形，不泄漏存在性。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';

/** `hana_invoke` 入参：能力 id + 该能力的 args + 披露上下文令牌（必填）。 */
export const INVOKE_SCHEMA = z.object({
  capability: z
    .string()
    .min(1)
    .max(128)
    .describe('要执行的能力 id（必须来自 hana_tool_search 的 contract/配方；不能是平台入口自身）'),
  args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('目标能力的入参对象（按目标能力 schema 校验；省略 = 空对象）'),
  contextToken: z
    .string()
    .min(1)
    .max(4096)
    .describe('contract/goal 回执签发的上下文令牌（必填；绑定该回执的 tools 集合与环境/代际/策略/清单）'),
});

export const invokeCapabilities = {
  hana_invoke: cap({
    id: 'hana_invoke',
    category: 'tool_search',
    kind: 'read',
    platform: true,
    effects: { destructive: false, idempotent: false, mutates: 'none' },
    routing: {
      intent: '执行 hana_tool_search 选中的具体能力（唯一执行入口）',
      whenToUse: [
        '已通过 hana_tool_search 拿到能力 id 与完整契约',
        '按 goal 配方的 steps[] 逐步执行',
        '操作级别名（如 hana_view_update#auto_layout）也经本入口；别名需单独 contract',
      ],
      notFor: [
        '不要凭记忆猜能力 id：先 discover 找 id、contract 取契约与 token',
        '不要把 hana_tool_search / hana_invoke 作为目标能力（平台入口不可递归）',
        '披露不等于授权：本入口每次都会重新过授权与预检',
      ],
      priority: 'primary',
      exampleArgs: {
        capability: 'hana_metadata_get_view',
        args: { packageId: 'ZDEMO.ZDEMO01', objectName: 'ZDEMO11' },
      },
      returns: [
        '目标能力的原始回执（统一 envelope：{ success, data?, messages[], raw? }）',
        '未知/无权能力与不存在逐字同形',
        'contextToken 必填：绑定 contract/goal 回执的 tools 集合；集合外能力被拒绝（capability_not_disclosed）',
      ],
    },
    title: '执行能力',
    description:
      '唯一执行入口：按 contract/配方回执里的 capability + args 执行一个具体能力。\n' +
      '所有具体能力（含 SQL、环境切换、操作级别名）都经本入口。\n' +
      '授权、schema、预检与审批按目标能力判定；披露不等于授权，每次调用都重新过闸门。\n' +
      '不知道能力 id 或参数时不要猜：先 hana_tool_search({mode:"discover"|"contract"|"goal"})。',
    inputSchema: INVOKE_SCHEMA,
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
