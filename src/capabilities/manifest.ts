/**
 * 能力清单（Capability Manifest）—— **唯一事实源**。
 *
 * 本文件只做三件事：① 把各分类的声明汇总成一张表；② 按 id 查询；③ 提供从清单派生的判定/投影
 * （规划器查找、可见性归属、kind 投影）。**能力的具体声明在 `defs/*.ts`**，一处一条。
 *
 * 依赖方向：`defs/*` → `capabilities/{types,schemas,planners}` → 叶子模块（zod / core / write-plan）
 * 或服务侧的**常量导出**（见 types.ts 头注的完整规则）；`tools/*` → `capabilities/*`。
 * 反向依赖（capabilities → tools）是禁止的，否则会与 `tools/index.ts` ↔ `tools/*.tools.ts`
 * 之间本就存在的循环叠加成新的求值顺序陷阱。实测无环：`tests/unit/import-cycles.test.ts` 的运行时 import 环棘轮（随 npm test 常态化运行）。
 *
 * 新增能力的登记义务（三件"税"）：
 *   1. 在对应 `defs/<分类>.ts` 里加一条（含 kind / effects / annotations / schema）；
 *   2. 在对应 `tools/<模块>.tools.ts` 里用 `regCap(CAP.<id>, handler)` 注册；
 *   3. `tests/unit/dynamic-surface.test.ts` 会断言"清单里每一条的 handler 都在路由表里"，漏登记
 *      handler 即红；`tests/unit/capability-manifest.test.ts` 反证"注册面 = 六个门面"——具体能力
 *      一个都不直接注册。
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
 * 基础能力表（**不含门面**；门面在下方 `CAPABILITIES` 尾部，但由 `registerAllTools` **最先**注册）。
 * 表内顺序 = 各模块的注册顺序，跟随它的有两个读者：提升进工具面的具体能力的 `tools/list` 顺序、
 * 门面描述里成员清单的排列顺序。**注册面 = 六个门面**——具体能力一个都不直接注册，只经门面
 * 路由调用；分类被提升后，其中的可注册成员才动态进 `tools/list`（`routeOnly` 别名始终不注册），
 * 这一注册面由 `tests/unit/capability-manifest.test.ts` 行为断言，不对表序做假设。
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

/** 全量能力表 = 基础能力 + 六个门面（表内门面在后；注册最先——`tools/list` 最前，见 tools/index.ts） */
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
  // `Object.hasOwn` 守卫（与 isRegisteredCapability 同口径）：CAPABILITIES 是展开得到的普通对象，
  // 普通下标访问会命中原型链属性名（'toString'/'constructor'/'valueOf'/'__proto__' 返回
  // Object.prototype 上的函数/对象而非 undefined），把"未登记"报成"已登记"——实测
  // `shouldRegisterTool('toString', 默认配置)` 曾因此返回 true（fail-open），与本文件
  // "未登记返回 undefined / 未登记 = 不暴露"的契约相反。
  return Object.hasOwn(CAPABILITIES, id) ? (CAPABILITIES as Record<string, Capability | undefined>)[id] : undefined;
}

/**
 * 是否已登记（`Object.hasOwn` 口径，与 `findCapability` 同源）。**未登记 = 不暴露**（fail-closed）：
 * 可见性判定与路由派发据此把原型链属性名（'toString' 等）一律当"未知能力"处理。
 */
export function isRegisteredCapability(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/**
 * 某分类的**成员能力**（排除门面自己）。
 *
 * 门面的 `category` 等于它的 `facadeOf`，所以按分类过滤时若不显式排除门面，门面会把自己也算成
 * 一个成员。凡是要"逐成员"看的地方（门面 kind/effects 派生、索引列表、deny 检查）都必须用它，
 * 否则是自指，结论会随门面自身的 kind 漂移。
 */
export function membersOfCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITY_LIST.filter((c) => c.category === category && c.facadeOf === undefined);
}

/** 某可见性归属下的能力 id 列表（**含门面**：门面的 kind 是成员摘要；测试按它断言三档都还有能力） */
export function capabilitiesOfKind(kind: ToolKind): string[] {
  return CAPABILITY_LIST.filter((c) => c.kind === kind).map((c) => c.id);
}

/**
 * 具体能力（**非门面**）的 id 清单。
 *
 * "某个 kind 是否可达"这类判定必须用它，不能用整个 `TOOL_GROUPS`：门面的 kind 是成员摘要，
 * 拿它判会得出"只读部署里还存在写能力"的假结论——`writeCapableExposed` 会误报边界告警，
 * `checkProfiles` 会漏报"档案声称的 kind 在部署面上根本没有"。
 */
export const CONCRETE_CAPABILITY_IDS: readonly string[] = CAPABILITY_LIST.filter((c) => c.facadeOf === undefined).map(
  (c) => c.id,
);

/**
 * 为一次调用产出资源计划（纯只读分析，无副作用）。声明了 `effects.plan` 的用它的。
 *
 * **未声明时的兜底按 kind 分向**（安全关键）：
 * - 「可能写仓库包」的能力（`write` / `admin`）→ `planFallback`：按入参表面提取写包，**fail-closed**
 *   方向（漏登记 planner 时判得更严）；
 * - **读能力** → `planReadless`：写包/读 schema 恒空。**绝不能沿用写兜底**——那会把
 *   `packageId`（"读哪个包里的视图"）当成**写包**，让读操作被写边界无辜拦下。
 * - 未登记的能力（`undefined`，门面路由会走到这里）→ `planFallback` 记录原名，但门面在此之前
 *   已按"未知能力"拒绝，不会进资源判定。
 */
export function planFor(capability: Capability | undefined, args: Record<string, unknown>): WritePlan {
  if (!capability) return planFallback('(未登记能力)', args);
  // ① 参数声明的资源：角色长在参数对象上，改参数名不会漂移；
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

/** 已声明专用规划器的能力 id（测试据此断言「非 read 档能力都登记了规划器」） */
export function plannedCapabilityIds(): string[] {
  return CAPABILITY_LIST.filter((c) => c.effects.plan !== undefined).map((c) => c.id);
}
