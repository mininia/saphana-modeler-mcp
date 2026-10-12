/**
 * 原始 handler 注册表：按能力 id 记住**未经闸门包装**的 handler，供门面路由派发。
 *
 * 为什么需要它：MCP 的注册面只给出"名字 → 被 SDK 调用的回调"，而路由要能调到**任意能力**——
 * 具体能力默认一个都不在注册面上（分类被提升后，其中可注册的成员会经
 * `registerCapabilitiesDynamically` 进入 `tools/list`），所以这张表就是它们唯一的落地处：
 * - **注册面上的能力**（六个分类门面 + 已提升分类的成员）：经 `registeredNameOf` 注册，客户端可直接调用；
 * - **其余全部具体能力**：不进 `tools/list`，只从这里取（门面路由够得着它们）。
 * - **部署隐藏的能力**（deny / 分组关闭）：它们的 handler 仍在表里，但门面路由的授权判定会先拒绝
 *   （不变量 A：天花板不因路由而松动）。
 *
 * 表是**每 server 一份**（WeakMap）：HTTP 每请求新建 server（无状态），stdio 单实例——键随实例回收，
 * 不构成跨请求的全局状态；也不会泄漏给客户端（进程内数据，不进 tools/list）。
 *
 * 分工：`capabilityRegistrar` 在这里登记 handler，再（若可见）注册该工具；门面路由只从这里取。
 * 闸门只在 **注册路径**上加装一次——路由路径自己按目标能力跑一次 `authorizeCall`，两处同源不重复。
 */

import type { McpServer } from '@modelcontextprotocol/server';

const handlersByServer = new WeakMap<McpServer, Map<string, unknown>>();

/** 登记一个能力的原始 handler（重复登记同一 id 会覆盖：同一 server 内后者优先） */
export function recordRawHandler(server: McpServer, capabilityId: string, handler: unknown): void {
  let map = handlersByServer.get(server);
  if (!map) {
    map = new Map();
    handlersByServer.set(server, map);
  }
  map.set(capabilityId, handler);
}

/** 取原始 handler（未登记返回 undefined——路由据此按"未知能力"拒绝） */
export function getRawHandler(server: McpServer, capabilityId: string): unknown {
  return handlersByServer.get(server)?.get(capabilityId);
}

/** 已登记的能力 id（测试与诊断用） */
export function registeredHandlerIds(server: McpServer): string[] {
  return [...(handlersByServer.get(server)?.keys() ?? [])];
}

/** SDK 注册句柄里我们用到的那部分（完整类型在 SDK 的 RegisteredTool，这里只取需要的能力） */
interface ToolHandle {
  remove(): void;
}

/**
 * **动态注册**的工具句柄（每 server 一份）：
 * 提升进来的能力必须能**撤下**——FIFO 淘汰若只改注册表而不摘工具，上限就形同虚设
 * （`tools/list` 里仍然看得到、也调得动）。SDK 的 `registerTool` 返回的句柄才带 `remove()`。
 *
 * 静态注册（门面、以及被部署直接放行的能力）**不进这里**：它们不参与淘汰。
 */
const dynamicHandlesByServer = new WeakMap<McpServer, Map<string, ToolHandle>>();

function dynamicHandles(server: McpServer): Map<string, ToolHandle> {
  let map = dynamicHandlesByServer.get(server);
  if (!map) {
    map = new Map();
    dynamicHandlesByServer.set(server, map);
  }
  return map;
}

/** 该工具名是否已动态注册过（提升是幂等的：重复提升同一分类不重复挂） */
export function hasDynamicHandle(server: McpServer, toolName: string): boolean {
  return dynamicHandlesByServer.get(server)?.has(toolName) ?? false;
}

/** 记下一个动态注册的工具句柄 */
export function recordDynamicHandle(server: McpServer, toolName: string, handle: ToolHandle): void {
  dynamicHandles(server).set(toolName, handle);
}

/** 摘下一个动态注册的工具（存在才摘）；返回是否真的摘了 */
export function removeDynamicHandle(server: McpServer, toolName: string): boolean {
  const map = dynamicHandlesByServer.get(server);
  const handle = map?.get(toolName);
  if (!map || !handle) return false;
  handle.remove();
  map.delete(toolName);
  return true;
}
