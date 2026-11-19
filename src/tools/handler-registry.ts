/**
 * 原始 handler 注册表：按能力 id 记住未经闸门包装的 handler，供 hana_invoke 派发。
 *
 * 具体能力不在注册面上，这张表是它们唯一的落地处：hana_invoke 按 id 取到任意能力。
 * 部署隐藏的能力（deny / 分组关闭）handler 仍在表里，但派发前的授权判定会先拒绝。
 * 每 server 一份（WeakMap）：HTTP 每请求新建、stdio 单实例，随实例回收，不构成跨请求全局状态。
 * 闸门只在平台入口注册路径加装一次；hana_invoke 自己按目标能力跑一次 authorizeCall，两处同源不重复。
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
