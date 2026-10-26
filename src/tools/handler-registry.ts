/**
 * 原始 handler 注册表：按能力 id 记住未经闸门包装的 handler，供门面路由派发。
 *
 * 具体能力默认不在注册面上，这张表是它们唯一的落地处：门面路由按 id 取到任意能力。
 * 部署隐藏的能力（deny / 分组关闭）handler 仍在表里，但路由前的授权判定会先拒绝。
 * 每 server 一份（WeakMap）：HTTP 每请求新建、stdio 单实例，随实例回收，不构成跨请求全局状态。
 * 闸门只在注册路径加装一次；路由路径自己按目标能力跑一次 authorizeCall，两处同源不重复。
 */

import type { McpServer } from '@modelcontextprotocol/server';

const handlersByServer = new WeakMap<McpServer, Map<string, unknown>>();

/** 登记一个能力的原始 handler（同一 server 内重复登记会覆盖） */
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

/** SDK 注册句柄里我们用到的那部分 */
interface ToolHandle {
  remove(): void;
}

/**
 * 动态注册的工具句柄（每 server 一份）：提升进来的能力必须能撤下，
 * 否则 FIFO 淘汰只改注册表、tools/list 里仍看得到也调得动。静态注册的条目不进这里。
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
