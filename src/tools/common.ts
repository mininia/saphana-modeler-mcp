/**
 * 工具层公共构件：handler 的统一返回框架（文本 JSON + structuredContent，同一 envelope 序列化一次）。
 * 单独成模块是为了不依赖任何工具模块，避免 tools/index.ts 与各 .tools.ts 的循环 import。
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
