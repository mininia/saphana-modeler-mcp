/**
 * 入参 schema 的共享片段（能力清单专用）。
 *
 * 与 `tools/common.ts` 的分工：**入参长什么样**归这里（清单声明用），
 * **返回长什么样**归 `tools/common.ts` 的 `toToolResult`（handler 用）。
 * 这样 `capabilities/` 不需要 import `tools/`（依赖方向硬约束，见 types.ts 头注）。
 *
 * 这些片段此前与返回框架一起挤在 `tools/common.ts`：包名/对象名的正则 `/^[A-Za-z0-9_.\-]+$/`
 * 曾手抄 28 处、VIEW_KIND 曾在三个模块各写一份——收敛在这里后，"入参长什么样"只有一种答案。
 */

import { z } from 'zod';
import { PACKAGE_ID_RE } from '../core/sql.js';
import { tagResource } from './resources.js';

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

// ── 资源形参（P10-c）────────────────────────────────────────────
//
// 下面三个构造器与普通入参的唯一区别是**带资源角色**（见 capabilities/resources.ts 的说明）：
// 规划器据此派生读/写范围，新增能力只要用对构造器，资源维度就自动成立，不靠人记得写 planner。
// 对外**零痕迹**（角色记在模块内 WeakMap，不进 JSON Schema）。

/**
 * 写入目标包（会写这个仓库包）。用它的参数进 `WritePlan.writePackages`，
 * 受 `HANA_WRITE_PACKAGES` 与调用方档案的双重约束。
 */
export function zWritePackageId(usage: string) {
  return tagResource(zPackageId(usage), 'writePackage');
}

/**
 * 只读引用的仓库包（读它里面的对象，不写）。进 `WritePlan.readPackages`——
 * 目前**只报告不拦截**（权限配置里没有"可读包"这一项，加白名单会破坏既有的跨包用法）。
 */
export function zReadPackageId(usage: string) {
  return tagResource(zPackageId(usage), 'readPackage');
}

/**
 * 只读的 schema（读该 schema 下的表/视图/元数据）。进 `WritePlan.readSchemas`，
 * 受 `HANA_READ_SCHEMA` 与调用方档案的约束（系统 schema 恒可读，无需配置）。
 *
 * 各处 schema 参数的**约束并不相同**（有的带 min/max、有的纯 string），故这里不提供构造器，
 * 由声明处用 `tagResource(z.string()…, 'readSchema')` 就地打标——**保持已发布的约束与描述逐字不变**。
 * 声明处直接 `import { tagResource } from './resources.js'` 即可，不在此二次导出。
 */
