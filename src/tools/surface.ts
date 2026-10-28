/**
 * 调用方面（surface）、可触达上限（entitlement）与提升。
 *
 * - entitlement = 部署静态面 ∩ 调用方档案，是天花板：门面索引、路由与提升都按它判定，
 *   面外能力在三处都表现得与不存在完全一样（不变量 D）。
 * - promoted = 该调用方调用过的分类；提升把该分类的具体能力搬进 surface，此后可按工具名平铺直调。
 * - surface = (门面 ∪ 已提升分类的成员) ∩ entitlement，是本次连接实际注册的工具集。
 * 关系：surface ⊆ entitlement ⊆ 部署策略（不变量 A）。
 *
 * 提升按分类（粒度对齐 hana-cli 的 Dynamic Tool Promotion）：淘汰单位与提升单位一致，
 * 上限 MCP_CAPABILITY_SURFACE_MAX 按工具数算（routeOnly 不注册也不计），超出时最旧分类整体淘汰。
 *
 * 状态在进程内、重启即退回只有门面（不变量 F：面是呈现设施，不是正确性设施）：
 * HTTP 键 = 已认证 clientId；stdio 键 = (stdio)。未配 Token 的 HTTP 部署提升整体关闭（单租户假设）。
 */

import { CAPABILITY_LIST, findCapability, membersOfCategory } from '../capabilities/manifest.js';
import { CAPABILITY_CATALOG, type Capability, type FacadeCategory } from '../capabilities/types.js';
import { activeProfile, profileAllows, type CallerProfile } from '../config/profiles.js';
import type { HanaConfig } from '../config/config.js';
import { ANONYMOUS_CLIENT_ID, currentIdentity } from '../core/request-context.js';
import { matchGlob, shouldRegisterTool, type ToolFilterConfig } from './groups.js';

/**
 * 面的计算只需要「策略 + 配置」。刻意不 import ./index.js 的 ToolContext（会成环）；
 * ToolContext 在结构上满足本接口（鸭子类型）。
 */
export interface SurfaceContext {
  config: HanaConfig;
  toolFilter: ToolFilterConfig;
}

/** stdio 进程（单客户端）的提升键 */
const STDIO_SURFACE_KEY = '(stdio)';

/** 提升注册表：调用方键 → 已提升的分类（按提升顺序，FIFO 淘汰用最旧在前） */
const promotedByCaller = new Map<string, FacadeCategory[]>();

/** 重置全部提升状态（测试隔离用） */
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
function surfaceKeyOf(identity: { clientId?: string } | undefined): string {
  return identity?.clientId ?? STDIO_SURFACE_KEY;
}

/**
 * 当前调用方的归属键（提升注册表与异步任务归属共用）：HTTP 用 clientId，stdio 用 (stdio)。
 * 两处必须同源——各自现算会让「自己提交的任务查不到」且没有任何报错。
 */
export function currentSurfaceKey(): string {
  return surfaceKeyOf(currentIdentity());
}

/**
 * 一批分类覆盖的工具数（提升预算按它算）。与 computeSurface 同口径：只数可注册成员，
 * routeOnly 别名不计入（计入会让「面从未超上限」的部署被提前淘汰）。
 */
function toolCountOf(categories: readonly FacadeCategory[]): number {
  return categories.reduce((sum, c) => sum + membersOfCategory(c).filter((m) => m.routeOnly !== true).length, 0);
}

/**
 * 把一批分类提升到某调用方的面。返回本次实际新增与被 FIFO 淘汰的分类。
 * - 已提升的分类不重复计入，也不刷新顺序；
 * - 超出 max 时从最旧的一端整体淘汰，本次刚提升的分类不参与淘汰（否则会立刻淘汰自己）；
 * - 不做授权判定：调用方已按 entitlement 过滤。
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
 * 调用方的可触达能力（entitlement）：部署静态面 ∩ 档案，包含门面与非门面两类条目。
 * 门面常驻：入口不参与能力层判定，否则按 glob 收紧的档案会把门面全拒、一个工具都注册不出来。
 */
export function entitlementOf(
  ctx: SurfaceContext,
  identity: { clientId?: string; profileId?: string } | undefined,
): {
  ids: string[];
  profile: CallerProfile | undefined;
} {
  const profile = activeProfile(ctx.config, identity);
  /** 单个能力的可触达判定：可见性配置 + 档案（门面只过 deny 那一关，见上） */
  const entitled = (c: Capability): boolean => {
    if (!shouldRegisterTool(c.id, ctx.toolFilter)) return false;
    if (c.facadeOf !== undefined) return true; // 门面：入口不参与能力层判定（分组/档案都不拦它）
    // 档案维度与调用期闸门共用 profileAllows（单点实现）：undefined 档案 → profile_unknown → false
    return profileAllows(profile, c.id, c.kind).ok;
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
  // routeOnly 别名不进 surface：它们没有自己的注册名（注册即撞父工具名），只经门面路由可用。
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

/** 面内的能力条目（按 id 排序：确定性顺序，跨传输/跨调用方比对列表时顺序稳定） */
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
 * 完整 schema 由提升给出（提升后它是 tools/list 的一等工具）。
 */
export function paramNamesOf(cap: Capability): string[] {
  const shape = (cap.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return shape ? Object.keys(shape) : [];
}

/** 按 id 解析能力（路由用）；未登记返回 undefined */
export function resolveCapability(id: string): Capability | undefined {
  return findCapability(id);
}

/**
 * 工具面省略说明（P1-7）：让模型知道「为什么有些能力不在」，同时**默认不泄漏**被隐藏的能力名。
 *
 * 三类口径（与清单/计划一致）：
 * - 部署策略 / deny：说明句 + 涉及**类别**，默认不点名能力，不提示重试；
 * - 分组 / allow 过滤：只列本次启用的类别；
 * - 档案收紧：说明句 + 涉及类别（同样不点名）。
 * 瞬时注册失败不在本函数（它发生在提升时，见 tools/capability.tools.ts 的 warnings）。
 *
 * 全量面返回 `{ status: 'full' }`——正常部署**不追加任何噪音**。
 * `names=true` 是 `HANA_EXPLAIN_SURFACE=names` 的调试口径，才会输出被隐藏的能力 id。
 */
export interface SurfaceExplanation {
  status: 'full' | 'restricted';
  /** 本次部署启用的类别（有成员可见的类别） */
  enabledCategories?: FacadeCategory[];
  /** 一个可见成员都没有的类别 */
  omittedCategories?: FacadeCategory[];
  /** 可读说明（不含能力名，除非调试开关） */
  notes?: string[];
  /** 被隐藏的能力 id（仅调试开关 `HANA_EXPLAIN_SURFACE=names`） */
  omittedNames?: string[];
}

export function explainSurface(
  ctx: SurfaceContext,
  identity: { clientId?: string; profileId?: string } | undefined,
  opts: { names?: boolean } = {},
): SurfaceExplanation {
  const profile = activeProfile(ctx.config, identity);
  const concrete = CAPABILITY_LIST.filter((c) => c.facadeOf === undefined);
  const denied: Capability[] = [];
  const groupHidden: Capability[] = [];
  const profileHidden: Capability[] = [];

  for (const cap of concrete) {
    if (!shouldRegisterTool(cap.id, ctx.toolFilter)) {
      // deny 与分组/allow 过滤分开归因：前者是部署策略，后者是"本次启用了哪些类别"
      const deniedById =
        matchGlob(cap.id, ctx.toolFilter.denyPatterns) ||
        (cap.routeOnly === true && matchGlob(cap.module, ctx.toolFilter.denyPatterns));
      (deniedById ? denied : groupHidden).push(cap);
    } else if (!profileAllows(profile, cap.id, cap.kind).ok) {
      profileHidden.push(cap);
    }
  }

  const hidden = [...denied, ...groupHidden, ...profileHidden];
  if (hidden.length === 0) return { status: 'full' };

  const categoriesOf = (caps: readonly Capability[]): FacadeCategory[] => {
    const set = new Set(caps.map((c) => c.category));
    return CAPABILITY_CATALOG.map((e) => e.id).filter((id) => set.has(id));
  };
  const hiddenIds = new Set(hidden.map((c) => c.id));
  const enabledCategories = CAPABILITY_CATALOG.map((e) => e.id).filter((cat) =>
    concrete.some((c) => c.category === cat && !hiddenIds.has(c.id)),
  );
  const omittedCategories = CAPABILITY_CATALOG.map((e) => e.id)
    .filter((cat) => concrete.some((c) => c.category === cat))
    .filter((cat) => !enabledCategories.includes(cat));

  const notes: string[] = [];
  if (denied.length > 0) {
    notes.push(`部分能力因部署策略不可见（涉及类别：${categoriesOf(denied).join('、')}）。`);
  }
  if (groupHidden.length > 0) {
    notes.push(`本次部署启用的类别：${enabledCategories.join('、') || '(无)'}（未启用的能力不可见）。`);
  }
  if (profileHidden.length > 0) {
    notes.push(`部分能力因调用方档案不可见（涉及类别：${categoriesOf(profileHidden).join('、')}）。`);
  }

  return {
    status: 'restricted',
    enabledCategories,
    ...(omittedCategories.length > 0 ? { omittedCategories } : {}),
    notes,
    ...(opts.names ? { omittedNames: hidden.map((c) => c.id) } : {}),
  };
}
