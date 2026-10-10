/**
 * 调用方面（surface）、可触达上限（entitlement）与**提升**（P10-f）。
 *
 * ## 三个词，别混
 *
 * - **entitlement（可触达上限）** = 部署静态面 ∩ 调用方档案。它是**天花板**：能力是否"存在且你有权用"。
 *   门面索引、路由与提升都按它判定——所以"面外"的能力在三处都表现得**与不存在完全一样**（不变量 D）。
 * - **promoted（已提升）** = 该调用方调用过的**分类**。提升把该分类的**具体能力**搬进 surface，
 *   此后它们是 `tools/list` 里的一等工具、可平铺直调、带完整 schema。
 * - **surface（静态面）** = `(门面 ∪ 已提升分类的成员) ∩ entitlement`。它是**这次连接实际注册出去的工具集**。
 *
 * 关系：`surface ⊆ entitlement ⊆ 部署策略`（不变量 A：动态面 ⊆ 静态策略）。
 *
 * ## 提升是**按分类**的（2026-10-09 定稿，对齐 hana-cli 的 Dynamic Tool Promotion）
 *
 * 粒度取分类而不是单个能力，有两个理由：
 * 1. **对齐既有约定**：模型的动作本来就是"我要做建模"（选一个门面），按分类提升与这个粒度同形；
 * 2. **淘汰单位与提升单位一致**：上限 `MCP_CAPABILITY_SURFACE_MAX`（默认 50）按**工具数**算，
 *    超出时**最旧的那个分类**整体淘汰（hana-cli 同款 FIFO）——单一能力的淘汰会让面里
 *    出现"同类里有一半在面上"的破碎状态，比整体进出更难解释。
 *    本仓当前只有 28 条具体能力，上限实际不会触发；它存在的意义是**能力增长时不静默失控**。
 *
 * ## 状态的范围（不变量 F：面是**呈现**设施，不是正确性设施）
 *
 * - 键 = 调用方：HTTP 用**已认证 clientId**；stdio 用 `(stdio)`（单客户端进程）。
 * - **未配 Token 的 HTTP 部署**（所有调用方都是 anonymous）→ 提升**整体关闭**：
 *   单租户假设，不能让一个调用方的提升改变另一个的可见面。
 * - **进程内状态、重启即退回**：重启后退回"只有门面"，不报错，也不改变任何授权结果
 *   （授权每次调用现算，见 `config/authorize.ts`）。
 */

import { CAPABILITY_LIST, findCapability, membersOfCategory } from '../capabilities/manifest.js';
import { FACADE_CATEGORIES, type Capability, type FacadeCategory } from '../capabilities/types.js';
import { resolveProfile, type CallerProfile } from '../config/profiles.js';
import type { HanaConfig } from '../config/config.js';
import { matchGlob, shouldRegisterTool, type ToolFilterConfig } from './groups.js';

/**
 * 面的计算只需要"策略 + 配置"两件事。**刻意不 import `./index.js` 的 ToolContext**：
 * registrar 要用本模块（index → surface），反向 import 会成环。
 * `ToolContext` 在结构上满足本接口（鸭子类型），调用点无需转换。
 */
export interface SurfaceContext {
  config: HanaConfig;
  toolFilter: ToolFilterConfig;
}

/** HTTP 未配 Token 时的匿名身份名（与 src/http.ts 的同名常量一致；此处只用于判定"未认证"） */
const ANONYMOUS_CLIENT_ID = 'anonymous';

/** stdio 进程（单客户端）的提升键 */
export const STDIO_SURFACE_KEY = '(stdio)';

/** 提升注册表：调用方键 → 已提升的分类（按提升顺序，FIFO 淘汰用最旧在前） */
const promotedByCaller = new Map<string, FacadeCategory[]>();

/** 重置全部提升状态（测试隔离用；仓库约定：模块级可变状态必须配显式重置入口） */
export function resetPromotedSurfaces(): void {
  promotedByCaller.clear();
}

/** 某调用方已提升的分类（FIFO 顺序，最旧在前） */
export function promotedCategoriesFor(key: string): readonly FacadeCategory[] {
  return promotedByCaller.get(key) ?? [];
}

/** 该调用方是否启用提升（未配 Token 的 HTTP 部署关闭） */
export function canPromote(identity: { clientId?: string } | undefined): boolean {
  // 无身份上下文 = stdio（单客户端，无串扰面）→ 允许
  if (identity === undefined) return true;
  // HTTP 未配 Token 时所有调用方都是 anonymous → 关闭（单租户假设，见头注）
  return identity.clientId !== ANONYMOUS_CLIENT_ID;
}

/** 调用方键（提升注册表的键） */
export function surfaceKeyOf(identity: { clientId?: string } | undefined): string {
  return identity?.clientId ?? STDIO_SURFACE_KEY;
}

/** 一批分类覆盖的工具数（上限按它算） */
function toolCountOf(categories: readonly FacadeCategory[]): number {
  return categories.reduce((sum, c) => sum + membersOfCategory(c).length, 0);
}

/**
 * 把一批分类提升到某调用方的面。返回本次实际新增与被 FIFO 淘汰的分类。
 *
 * 语义：
 * - 已提升的分类不重复计入，**也不刷新顺序**（顺序 = 首次提升时间）；
 * - 超出 `max` 时从**最旧**的一端整体淘汰；**刚提升的那个分类不参与本次淘汰**
 *   （否则"提升一个超大分类"会立刻把自己淘汰掉，面永远空转）；
 * - 不在此处做授权判定：调用方（门面）已按 entitlement 过滤过。
 */
export function promoteCategories(
  key: string,
  categories: readonly FacadeCategory[],
  max: number,
): { added: FacadeCategory[]; evicted: FacadeCategory[] } {
  const current = [...(promotedByCaller.get(key) ?? [])];
  const added: FacadeCategory[] = [];
  for (const c of categories) {
    if (!current.includes(c)) {
      current.push(c);
      added.push(c);
    }
  }
  const newlyAdded = new Set(added);
  const evicted: FacadeCategory[] = [];
  while (toolCountOf(current) > max) {
    // 从最旧的一端找第一个"不是本次刚加进来的"分类淘汰
    const idx = current.findIndex((c) => !newlyAdded.has(c));
    if (idx < 0) break; // 只剩本次新增的（单个分类就超上限）：保面可用，不再淘汰
    evicted.push(...current.splice(idx, 1));
  }
  promotedByCaller.set(key, current);
  return { added, evicted };
}

/**
 * 调用方的可触达能力（entitlement）：部署静态面 ∩ 档案。
 *
 * 注意它**包含**门面与非门面两类条目：门面是入口，非门面是路由/提升目标——路由目标虽然不一定进
 * `tools/list`，但必须"有权调用"，所以它们的资格也在这里判。
 *
 * **门面常驻（2026-10-09 定稿，门面层不做限制）**：门面是入口，不参与能力层的权限判定——
 * 分组开关（`shouldRegisterTool`）与档案都只管**具体能力**。否则一个按 glob 收紧的档案
 * （如只允许 `hana_metadata_*`）会把六个门面全部拒掉，本次连接一个工具都注册不出来（自锁死）；
 * 入口常在、索引可能为空，才是"可用性收窄"的正确表达。
 */
export function entitlementOf(
  ctx: SurfaceContext,
  identity: { clientId?: string; profileId?: string } | undefined,
): {
  ids: string[];
  profile: CallerProfile | undefined;
} {
  const profile = resolveProfile(ctx.config.profiles, identity?.profileId ?? ctx.config.profileId);
  /** 单个能力的可触达判定：可见性配置 + 档案（门面只过 deny 那一关，见上） */
  const entitled = (c: Capability): boolean => {
    if (!shouldRegisterTool(c.id, ctx.toolFilter)) return false;
    if (c.facadeOf !== undefined) return true; // 门面：入口不参与能力层判定（分组/档案都不拦它）
    // 档案维度：未配档案（隐式 default）时 resolveProfile 返回全 kind 的档案，等价于不收紧
    if (profile === undefined) return false; // 配了档案却查不到 → 空档案（全拒），与 authorizeCall 同口径
    if (!profile.allowKinds.includes(c.kind)) return false;
    if (profile.allowCapabilities && !matchGlob(c.id, profile.allowCapabilities)) return false;
    return true;
  };
  const ids = CAPABILITY_LIST.filter(entitled).map((c) => c.id);
  return { ids, profile };
}

/** 一次 server 构建使用的面（HTTP 每请求一份；stdio 单实例一份） */
export interface CallerSurface {
  /** 提升注册表的键（clientId / '(stdio)'） */
  key: string;
  /** 该调用方是否启用提升（未配 Token 的 HTTP 部署为 false） */
  canPromote: boolean;
  /** 可触达上限（部署静态面 ∩ 档案）——门面索引、路由与提升的判定依据 */
  entitlementIds: Set<string>;
  /** 实际注册出去的工具集 = `(门面 ∪ 已提升分类的成员) ∩ entitlement` */
  surfaceIds: Set<string>;
  /** 已提升的分类（FIFO 顺序） */
  promoted: readonly FacadeCategory[];
}

/**
 * 计算这次连接的面。
 *
 * @param ctx 工具上下文（策略 / 配置）
 * @param identity 调用方身份（HTTP 请求内取；stdio 为 undefined）
 */
export function computeSurface(
  ctx: SurfaceContext,
  identity: { clientId?: string; profileId?: string } | undefined,
): CallerSurface {
  const { ids } = entitlementOf(ctx, identity);
  const entitlementIds = new Set(ids);
  const key = surfaceKeyOf(identity);
  const allowed = canPromote(identity);
  const promoted = allowed ? promotedCategoriesFor(key) : [];
  // routeOnly 条目（操作级别名）不参与 surface：它们没有自己的注册名（= 父工具名，注册即撞名），
  // 提升只把**可平铺直调**的成员搬进 tools/list；别名照旧经门面路由可用（entitlement 不受影响）。
  const promotedMembers = new Set(
    promoted.flatMap((c) =>
      membersOfCategory(c)
        .filter((m) => m.routeOnly !== true)
        .map((m) => m.id),
    ),
  );

  const surfaceIds = new Set<string>();
  for (const c of CAPABILITY_LIST) {
    if (!entitlementIds.has(c.id)) continue;
    // 门面：常驻（它们是入口，提升不改变这一点）
    if (c.facadeOf !== undefined) surfaceIds.add(c.id);
    // 具体能力：只有其分类被提升过才进面
    else if (promotedMembers.has(c.id)) surfaceIds.add(c.id);
  }
  return { key, canPromote: allowed, entitlementIds, surfaceIds, promoted };
}

/** 面内的能力条目（按 id 排序：确定性顺序，SSD §7.6 的列表语义） */
export function surfaceCapabilities(ids: ReadonlySet<string>): Capability[] {
  return CAPABILITY_LIST.filter((c) => ids.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 能力的一句话摘要（门面索引用）：取描述的首句 */
export function summaryOf(cap: Capability): string {
  const firstLine = cap.description.split('\n')[0];
  const stop = firstLine.search(/[。；]/);
  const head = stop > 0 ? firstLine.slice(0, stop) : firstLine;
  return head.length > 120 ? `${head.slice(0, 119)}…` : head;
}

/**
 * 能力的参数名清单（门面索引用；只给名字不给 schema）。
 *
 * 完整 schema **由提升给出**：提升后该能力是 `tools/list` 里的一等工具，客户端直接拿到它的
 * JSON Schema。索引里的参数名是"提升之前"的挑选依据——先给名字，决定要不要提升。
 */
export function paramNamesOf(cap: Capability): string[] {
  const shape = (cap.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/** 按 id 解析能力（路由用）；未登记返回 undefined */
export function resolveCapability(id: string): Capability | undefined {
  return findCapability(id);
}

/** 分类目录的合法值（门面 id ↔ 分类的对应由 `facadeIdOf` 给出） */
export { FACADE_CATEGORIES };
