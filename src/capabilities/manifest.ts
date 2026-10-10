/**
 * 能力清单（Capability Manifest）—— **唯一事实源**（P10-a）。
 *
 * 本文件只做三件事：① 把各分类的声明汇总成一张表；② 按 id 查询；③ 提供从清单派生的判定/投影
 * （规划器查找、可见性归属、tier 投影）。**能力的具体声明在 `defs/*.ts`**，一处一条。
 *
 * 依赖方向：`defs/*` → `capabilities/{types,schemas,planners}` → 叶子模块（zod / core / write-plan）
 * 或服务侧的**常量导出**（见 types.ts 头注的完整规则）；`tools/*` → `capabilities/*`。
 * 反向依赖（capabilities → tools）是禁止的，否则会与 `tools/index.ts` ↔ `tools/*.tools.ts`
 * 之间本就存在的循环叠加成新的求值顺序陷阱。实测无环：`test-verification/check-import-cycles.mjs`。
 *
 * 新增能力的三件"税"（SSD §1.5 的登记义务在清单上的落点）：
 *   1. 在对应 `defs/<分类>.ts` 里加一条（含 kind / gate / effects / annotations / schema）；
 *   2. 在对应 `tools/<模块>.tools.ts` 里用 `regCap(CAP.<id>, handler)` 注册；
 *   3. `tests/unit/capability-manifest.test.ts` 会断言"注册的 ∩ 清单的 = 全部"，漏任一步即红。
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
 * 基础能力表（**不含门面**）。**顺序 = 注册顺序**（tools/list 的呈现顺序）——与 `tools/index.ts`
 * 里 `registerAllTools` 调用各模块的顺序严格一致（测试会断言这一点）。
 * 展开保持每个条目的**精确 schema 类型**（`satisfies` 只做约束、不拓宽）——
 * handler 的参数推断依赖它，退化会让 `async ({ packageId }) => …` 直接编译不过（故意的）。
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
 * 六个分类门面（从基础表**派生**，见 facades.ts）。
 *
 * 单独导出是为了让注册点拿到**精确键类型**：`FACADES[facadeIdOf(category)]` 的类型是
 * `Capability<typeof FACADE_SCHEMA>`，于是门面 handler 的参数有推断；经 `CAPABILITIES` 的
 * 弱类型视图取值会退化成 `z.ZodType`（handler 参数变 `any`）。
 */
export const FACADES = buildFacades(Object.values(BASE_CAPABILITIES));

/** 全量能力表 = 基础能力 + 六个门面（门面在后：它们放最后注册） */
export const CAPABILITIES = {
  ...BASE_CAPABILITIES,
  ...FACADES,
} satisfies Record<string, Capability<z.ZodType>>;

/** 能力 id 的联合类型 */
export type CapabilityId = keyof typeof CAPABILITIES;

/** 清单的简写别名（工具模块里写作 `CAP.hana_view_create`） */
export const CAP = CAPABILITIES;

/** 全量条目（弱类型视图，供遍历/投影用） */
export const CAPABILITY_LIST: readonly Capability[] = Object.values(CAPABILITIES);

/** 按 id 查能力；未登记返回 undefined（调用方一律按"未知能力"处理，不泄漏存在性） */
export function findCapability(id: string): Capability | undefined {
  return (CAPABILITIES as Record<string, Capability | undefined>)[id];
}

/**
 * 是否已登记。**未登记 = 不暴露**（fail-closed）：可见性判定与路由派发都先问它。
 */
export function isRegisteredCapability(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/** 某分类下的能力（门面索引与门面 kind 推导用；分类从清单派生，不另维护分类表） */
export function capabilitiesOfCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITY_LIST.filter((c) => c.category === category);
}

/**
 * 某分类的**成员能力**（排除门面自己）。
 *
 * 门面的 `category` 等于它的 `facadeOf`，所以 `capabilitiesOfCategory` 会把门面自己也列进去。
 * 凡是要"逐成员"看的地方（门面 kind/effects 派生、索引列表、deny 检查）都必须用它，
 * 否则门面会把自己算成一个成员——那是自指，结论会随门面自身的 kind 漂移。
 */
export function membersOfCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITY_LIST.filter((c) => c.category === category && c.facadeOf === undefined);
}

/** 某可见性归属下的能力 id 列表（供 MCP_TOOL_GROUPS 组名展开，保持单一事实源） */
export function capabilitiesOfKind(kind: ToolKind): string[] {
  return CAPABILITY_LIST.filter((c) => c.kind === kind).map((c) => c.id);
}

/**
 * 是否门面条目（`facadeOf !== undefined`）。
 *
 * **门面不改权限判定（唯一实现）**：门面是**入口**，权限只有一层（能力层）——门面自身不参与
 * kind 判定，成员也不替它判。可见性（`tools/groups.ts`）、可触达（`tools/surface.ts`）、档案
 * （`config/authorize.ts`）三处共用这一条结论：**门面常驻**（除显式 deny / 全部成员被 deny），
 * 能用哪些能力一律按**目标能力**判。
 *
 * 曾经的做法是"门面按成员判：成员里有一个可见就可见"（`facadeSatisfies`）。它带来两个耦合：
 * ① 分组开关能整类藏掉入口（只读部署连 `hana_modeling` 这个入口都看不到）；
 * ② 把"门面 kind 是成员摘要"这件事实推进了权限判定。2026-10-09 定稿改为**门面层不做限制**：
 * 入口常驻、能力层收窄——只读部署照样看得到 `hana_modeling`/`hana_diagnostics`，
 * 只是它们的索引为空（入口在、里面没有你可用的能力）。
 */
export function isFacade(cap: Capability): boolean {
  return cap.facadeOf !== undefined;
}

/**
 * 具体能力（**非门面**）的 id 清单。
 *
 * "某个 kind 是否可达"这类判定必须用它，不能用整个 `TOOL_GROUPS`：门面的 kind 是成员摘要，
 * 拿它判会得出"只读部署里还存在写能力"的假结论——`writeToolsExposed` 会误报边界告警，
 * `checkProfiles` 会漏报"档案声称的 kind 在部署面上根本没有"。
 */
export const CONCRETE_CAPABILITY_IDS: readonly string[] = CAPABILITY_LIST.filter((c) => c.facadeOf === undefined).map(
  (c) => c.id,
);

/**
 * 为一次调用产出资源计划（纯只读分析，无副作用）。声明了 `effects.plan` 的用它的。
 *
 * **未声明时的兜底按 kind 分向**（P10-b，安全关键）：
 * - 「可能写仓库包」的能力（`write` / `admin`）→ `planFallback`：按入参表面提取写包，**fail-closed**
 *   方向（漏登记 planner 时判得更严）；
 * - **读能力** → `planReadless`：写包/读 schema 恒空。**绝不能沿用写兜底**——那会把
 *   `packageId`（"读哪个包里的视图"）当成**写包**，让读操作被写边界无辜拦下。
 * - 未登记的能力（`undefined`，门面路由会走到这里）→ `planFallback` 记录原名，但门面在此之前
 *   已按"未知能力"拒绝，不会进资源判定。
 */
export function planFor(capability: Capability | undefined, args: Record<string, unknown>): WritePlan {
  if (!capability) return planFallback('(未登记能力)', args);
  // ① 参数声明的资源（P10-c）：角色长在参数对象上，改参数名不会漂移；
  //    新增能力只要用对构造器（zWritePackageId / zReadPackageId / tagResource(...,'readSchema')），
  //    资源维度就自动成立——不再依赖"作者记得写规划器"。
  const declared = deriveResourcesFromParams(capability.inputSchema, args);
  // ② 规划器（可选）负责规划器才能做的事：解析嵌套结构（operations 数组）、扫描文本（SQL/XML/脚本）
  //    与写叙述（steps/uncertain，会进拦截报告）。它声明的资源与①取并集（更严方向）。
  const bespoke = capability.effects.plan?.(args);
  const base =
    bespoke ?? (capability.kind === 'read' ? planReadless(capability.id) : planFallback(capability.id, args));
  return mergeDeclaredIntoPlan(capability.id, declared, base);
}

/** 已声明专用规划器的能力 id（测试据此断言「写能力都登记了」，替代此前的 PLANNED_WRITE_TOOLS） */
export function plannedCapabilityIds(): string[] {
  return CAPABILITY_LIST.filter((c) => c.effects.plan !== undefined).map((c) => c.id);
}
