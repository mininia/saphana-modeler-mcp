/**
 * 工具层公共构件（各 register* 模块共用）：**handler 的返回框架**。
 *
 * handler 的返回框架（文本 JSON + structuredContent，同一 envelope 序列化一次）曾重复 27 处。
 * 单点收敛的收益：改返回形状只需改这一处，不会漏掉某个 handler。
 *
 * 入参 schema 的共享片段（zPackageId / zObjectName / VIEW_KIND）已随能力清单迁到
 * `src/capabilities/schemas.ts`——那些是**清单声明**用的，这里只留 **handler 返回**用的。
 *
 * 为什么单独成模块而不是放进 tools/index.ts：index.ts 依赖 config/preflight 与 write-plan（写闸门），
 * 而各 .tools.ts 与 index.ts 之间本就存在循环 import；把返回框架放进不依赖任何工具模块的叶子里，
 * 模块求值顺序与 TDZ 都不再有牵连。
 */

import type { Envelope } from '../types/hana.js';

/**
 * handler 统一返回框架：文本 JSON 与 structuredContent **同源**（同一 envelope 序列化一次）。
 */
export function toToolResult(envelope: Envelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}
