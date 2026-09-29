/**
 * 工具层公共构件（各 register* 模块共用）。
 *
 * 三件事此前在每个模块里各写一份：
 * - handler 的返回框架（文本 JSON + structuredContent）重复了 27 处；
 * - 包名/对象名的入参正则 `/^[A-Za-z0-9_.\-]+$/` 手抄了 28 处；
 * - 视图类型枚举 VIEW_KIND 在 metadata/package/preview 三个模块各写一份。
 * 归到这里后，「工具入参长什么样」「返回长什么样」都只有一种答案。
 *
 * 为什么单独成模块而不是放进 tools/index.ts：index.ts 依赖 config/preflight 与 write-plan（写闸门），
 * 而各 .tools.ts 与 index.ts 之间本就存在循环 import；把纯 schema 片段与返回框架放进
 * 不依赖任何工具模块的叶子里，模块求值顺序与 TDZ 都不再有牵连。
 */

import { z } from 'zod';
import { PACKAGE_ID_RE } from '../core/sql.js';
import type { Envelope } from '../types/hana.js';

/** 包名/对象名入参的统一描述前缀（字符集即 PACKAGE_ID_RE；写明约束，避免模型靠猜） */
const ID_CHARSET_PREFIX = '仅允许字母/数字/下划线/点/连字符';

/** 包名入参（工具入参的严格口径）：usage 写该处参数的语义（如「目标包名；须在可写范围内」） */
export function zPackageId(usage: string) {
  return z.string().regex(PACKAGE_ID_RE).describe(`${ID_CHARSET_PREFIX}；${usage}`);
}

/** 对象名入参（与包名同一白名单）：usage 写该处参数的语义（如「视图对象名（不含包名）」） */
export function zObjectName(usage: string) {
  return z.string().regex(PACKAGE_ID_RE).describe(`${ID_CHARSET_PREFIX}；${usage}`);
}

/** 视图类型（calculationview / attributeview / analyticview）：三个模块共用一份，避免枚举漂移 */
export const VIEW_KIND = z.enum(['calculationview', 'attributeview', 'analyticview']);

/**
 * handler 统一返回框架：文本 JSON 与 structuredContent **同源**（同一 envelope 序列化一次）。
 * 单点收敛的收益：改返回形状（如新增字段的呈现方式）只需改这一处，不会漏掉某个 handler。
 */
export function toToolResult(envelope: Envelope) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(envelope, null, 2) }],
    structuredContent: envelope,
  };
}
