/**
 * 能力清单（Capability Manifest）——唯一事实源：汇总各分类声明、按 id 查询、派生判定与投影。
 * 具体声明在 defs/*.ts，一处一条。
 *
 * 依赖方向：defs/* → capabilities/{types,schemas,planners} → 叶子模块；tools/* → capabilities/*。
 * 反向依赖（capabilities → tools）禁止。无环由 tests/unit/import-cycles.test.ts 守护。
 *
 * 新增能力的登记义务：① defs/<分类>.ts 加条目（kind / effects / annotations / schema）；
 * ② tools/<模块>.tools.ts 用 regCap(CAP.<id>, handler) 注册；③ manifest 完整性测试会核对。
 */

import type { z } from 'zod';
import type { Capability, CapabilityCategory, ToolKind } from './types.js';
import { planFallback, planReadless } from './planners.js';
import { buildFacades } from './facades.js';
import { deriveResourcesFromParams, mergeDeclaredIntoPlan } from './resources.js';
import type { WritePlan } from '../write-plan.js';
import { systemCapabilities } from './defs/system.js';
import { packageCapabilities } from './defs/package.js';
import { metadataCapabilities } from './defs/metadata.js';
import { previewCapabilities } from './defs/preview.js';
import { modelingCapabilities } from './defs/modeling.js';
import { sqlAnalyzeCapabilities } from './defs/sql-analyze.js';
import { healthCapabilities } from './defs/health.js';

/**
 * 基础能力表（不含门面）。表内顺序 = 模块注册顺序，也是门面描述里成员的排列顺序。
 * 注册面 = 六个门面：具体能力只经门面路由调用；分类提升后才动态进 tools/list。
 * 保持每个条目的精确 schema 类型（satisfies 只约束、不拓宽），handler 参数推断依赖它。
 */
const BASE_CAPABILITIES = {
  ...systemCapabilities,
  ...packageCapabilities,
  ...metadataCapabilities,
  ...previewCapabilities,
  ...modelingCapabilities,
  ...sqlAnalyzeCapabilities,
  ...healthCapabilities,
} satisfies Record<string, Capability<z.ZodType>>;

/**
 * 六个分类门面（从基础表派生）。单独导出是为了让注册点拿到精确键类型，门面 handler 的参数才有推断。
 */
export const FACADES = buildFacades(Object.values(BASE_CAPABILITIES));

/** 全量能力表 = 基础能力 + 六个门面（表内门面在后；注册最先，见 tools/index.ts） */
export const CAPABILITIES = {
  ...BASE_CAPABILITIES,
  ...FACADES,
} satisfies Record<string, Capability<z.ZodType>>;

/** 清单的简写别名（工具模块里写作 `CAP.hana_view_create`） */
export const CAP = CAPABILITIES;

/** 全量条目（弱类型视图，供遍历/投影用） */
export const CAPABILITY_LIST: readonly Capability[] = Object.values(CAPABILITIES);

/** 按 id 查能力；未登记返回 undefined（调用方一律按"未知能力"处理，不泄漏存在性） */
export function findCapability(id: string): Capability | undefined {
  // Object.hasOwn 守卫：CAPABILITIES 是普通对象，下标访问会命中原型链属性名（'toString' 等），
  // 把「未登记」报成「已登记」——实测曾因此 fail-open。
  return Object.hasOwn(CAPABILITIES, id) ? (CAPABILITIES as Record<string, Capability | undefined>)[id] : undefined;
}

/**
 * 是否已登记（与 findCapability 同口径）。未登记 = 不暴露：可见性判定与路由据此把原型链属性名当未知能力。
 */
export function isRegisteredCapability(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/**
 * 某分类的成员能力（排除门面自己）。按分类过滤时若不排除门面会自指，结论随门面 kind 漂移。
 */
export function membersOfCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITY_LIST.filter((c) => c.category === category && c.facadeOf === undefined);
}

/** 某可见性归属下的能力 id 列表（**含门面**：门面的 kind 是成员摘要；测试按它断言三档都还有能力） */
export function capabilitiesOfKind(kind: ToolKind): string[] {
  return CAPABILITY_LIST.filter((c) => c.kind === kind).map((c) => c.id);
}

/**
 * 具体能力（非门面）的 id 清单。判断「某个 kind 是否可达」必须用它：
 * 门面的 kind 是成员摘要，拿它判会得出「只读部署里还存在写能力」的假结论。
 */
export const CONCRETE_CAPABILITY_IDS: readonly string[] = CAPABILITY_LIST.filter((c) => c.facadeOf === undefined).map(
  (c) => c.id,
);

/**
 * 为一次调用产出资源计划（纯只读分析，无副作用）。未声明 effects.plan 时按 kind 兜底：
 * - write/admin → planFallback（按入参提取写包，fail-closed）；
 * - read → planReadless（写包/读 schema 恒空）。绝不能沿用写兜底——那会把「读哪个包」当成写包。
 */
export function planFor(capability: Capability | undefined, args: Record<string, unknown>): WritePlan {
  if (!capability) return planFallback('(未登记能力)', args);
  // ① 参数声明的资源：角色长在参数对象上，改参数名不会漂移。
  const declared = deriveResourcesFromParams(capability.inputSchema, args);
  // ② 规划器负责嵌套解析（operations 数组）、文本扫描（SQL/XML）与写叙述；资源取并集（更严方向）。
  const bespoke = capability.effects.plan?.(args);
  const base =
    bespoke ?? (capability.kind === 'read' ? planReadless(capability.id) : planFallback(capability.id, args));
  return mergeDeclaredIntoPlan(capability.id, declared, base);
}

/** 已声明专用规划器的能力 id（测试据此断言「非 read 档能力都登记了规划器」） */
export function plannedCapabilityIds(): string[] {
  return CAPABILITY_LIST.filter((c) => c.effects.plan !== undefined).map((c) => c.id);
}
