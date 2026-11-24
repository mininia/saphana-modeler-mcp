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

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { isPlatformToolId, type Capability, type CapabilityCategory, type ToolKind } from './types.js';
import { planFallback, planReadless } from './planners.js';
import { deriveResourcesFromParams, mergeDeclaredIntoPlan } from './resources.js';
import type { WritePlan } from '../write-plan.js';
import { systemCapabilities } from './defs/system.js';
import { packageCapabilities } from './defs/package.js';
import { metadataCapabilities } from './defs/metadata.js';
import { previewCapabilities } from './defs/preview.js';
import { modelingCapabilities } from './defs/modeling.js';
import { sqlAnalyzeCapabilities } from './defs/sql-analyze.js';
import { sqlExecuteCapabilities } from './defs/sql-execute.js';
import { toolSearchCapabilities } from './defs/tool-search.js';
import { invokeCapabilities } from './defs/invoke.js';
import { healthCapabilities } from './defs/health.js';

/**
 * 全量能力表。表内顺序 = 模块注册顺序，也是发现排序的稳定次序。
 * 工具面只有两个平台入口（`hana_tool_search` / `hana_invoke`）；其余条目只经本体层选择后执行。
 * 保持每个条目的精确 schema 类型（satisfies 只约束、不拓宽），handler 参数推断依赖它。
 */
const BASE_CAPABILITIES = {
  ...systemCapabilities,
  ...packageCapabilities,
  ...metadataCapabilities,
  ...previewCapabilities,
  ...modelingCapabilities,
  ...sqlAnalyzeCapabilities,
  // SQL 直接执行（kind=sql，默认关闭的独立分组；不是常驻工具）
  ...sqlExecuteCapabilities,
  // 动作本体：选择入口 + 执行入口（平台工具，常驻 tools/list）
  ...toolSearchCapabilities,
  ...invokeCapabilities,
  ...healthCapabilities,
} satisfies Record<string, Capability<z.ZodType>>;

/** 全量能力表（平台入口也在内；表内顺序 = 声明顺序） */
export const CAPABILITIES = BASE_CAPABILITIES satisfies Record<string, Capability<z.ZodType>>;

/** 清单的简写别名（工具模块里写作 `CAP.hana_view_create`） */
export const CAP = CAPABILITIES;

/** 全量条目（弱类型视图，供遍历/投影用） */
export const CAPABILITY_LIST: readonly Capability[] = Object.values(CAPABILITIES);

/** 按 id 查能力；未登记返回 undefined（调用方一律按"未知能力"处理，不泄漏存在性） */
export function findCapability(id: string): Capability | undefined {
  // Object.hasOwn 守卫：CAPABILITIES 是普通对象，下标访问会命中原型链属性名（'toString' 等），
  // 把「未登记」报成「已登记」（fail-open）。
  return Object.hasOwn(CAPABILITIES, id) ? (CAPABILITIES as Record<string, Capability | undefined>)[id] : undefined;
}

/**
 * 是否已登记（与 findCapability 同口径）。未登记 = 不暴露：可见性判定与路由据此把原型链属性名当未知能力。
 */
export function isRegisteredCapability(id: string): boolean {
  return Object.prototype.hasOwnProperty.call(CAPABILITIES, id);
}

/**
 * 某分类的成员能力。平台入口不参与业务分类成员遍历（`tool_search` 分类自身除外）。
 */
export function membersOfCategory(category: CapabilityCategory): Capability[] {
  return CAPABILITY_LIST.filter((c) => c.category === category && c.platform !== true);
}

/** 某可见性归属下的能力 id 列表（**不含平台入口**：平台入口没有业务 kind） */
export function capabilitiesOfKind(kind: ToolKind): string[] {
  return CAPABILITY_LIST.filter((c) => c.kind === kind && c.platform !== true).map((c) => c.id);
}

/**
 * 具体能力（非平台入口）的 id 清单。判断「某个 kind 是否可达」必须用它：
 * 平台入口的 kind 只是注册占位，拿它判会得出「只读部署里还存在写能力」的假结论。
 */
export const CONCRETE_CAPABILITY_IDS: readonly string[] = CAPABILITY_LIST.filter((c) => !isPlatformToolId(c.id)).map(
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

/** 16 位十六进制摘要（sha256 前 16 位；展示/关联足够，不作为安全边界） */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

let manifestRevCache: string | undefined;

/**
 * 能力清单代际：id/title/description/routing/inputSchema 的稳定投影。
 * 清单变化 → manifestRev 变化 → 旧 contextToken/disclosureId 失效（token 才是执行凭证）。
 */
export function manifestRev(): string {
  if (manifestRevCache !== undefined) return manifestRevCache;
  const material = [...CAPABILITY_LIST]
    .map((c) => ({
      id: c.id,
      title: c.title,
      description: c.description,
      kind: c.kind,
      category: c.category,
      platform: c.platform === true,
      routeOnly: c.routeOnly === true,
      control: c.control === true,
      effects: { mutates: c.effects.mutates, destructive: c.effects.destructive, idempotent: c.effects.idempotent },
      routing: c.routing ?? null,
      schema: z.toJSONSchema(c.inputSchema, { io: 'input' }),
    }))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  manifestRevCache = `sha256:${digest(material)}`;
  return manifestRevCache;
}
