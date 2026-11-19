/**
 * 调用方面（surface）与可触达上限（entitlement）。
 *
 * 工具面固定为**两个平台入口**：
 * - `hana_tool_search`：本体层（发现 / 契约 / 配方），不改工具面、不执行；
 * - `hana_invoke`：唯一执行入口，按目标能力统一授权后派发。
 *
 * 具体能力（含 `hana_sql_execute`、环境切换、操作级别名）**永不注册**为工具；
 * entitlement 仍是“可发现 + 可执行”的天花板（部署策略 ∩ 档案）。
 *
 * 关系：surfaceIds ⊆ entitlementIds ⊆ 部署策略（可见性逐层收紧）。面是呈现设施，不是授权设施：
 * 每次调用仍过 `authorizeCall`（见 config/authorize.ts）。
 */

import { CAPABILITY_LIST, findCapability } from '../capabilities/manifest.js';
import {
  CAPABILITY_CATALOG,
  PLATFORM_TOOL_IDS,
  type BusinessCategory,
  type Capability,
} from '../capabilities/types.js';
import { activeProfile, profileAllows, type CallerProfile } from '../config/profiles.js';
import { compilePolicySnapshot } from '../config/policy-snapshot.js';
import { capabilityInputSchema } from '../config/environment-policy.js';
import type { HanaConfig } from '../config/config.js';
import { currentIdentity } from '../core/request-context.js';
import { matchGlob, shouldRegisterTool, toolFilterOf, type ToolFilterConfig } from './groups.js';

/**
 * 面的计算只需要「策略 + 配置」。刻意不 import ./index.js 的 ToolContext（会成环）；
 * ToolContext 在结构上满足本接口（鸭子类型）。
 */
export interface SurfaceContext {
  config: HanaConfig;
  toolFilter: ToolFilterConfig;
  /** 多环境管理器（可选；测试/单环境可省略） */
  manager?: {
    multiEnv: boolean;
    switchable: readonly string[];
  };
}

/** stdio 进程（单客户端）的归属键（异步任务归属用） */
const STDIO_SURFACE_KEY = '(stdio)';

/** 调用方键（异步任务归属用） */
function surfaceKeyOf(identity: { clientId?: string } | undefined): string {
  return identity?.clientId ?? STDIO_SURFACE_KEY;
}

/** 当前调用方的归属键（异步任务归属等共用）：HTTP 用 clientId，stdio 用 (stdio)。 */
export function currentSurfaceKey(): string {
  return surfaceKeyOf(currentIdentity());
}

/**
 * 调用方的可触达能力（entitlement）：部署静态面 ∩ 档案。
 *
 * 编译委托给 `config/policy-snapshot.ts`：平台入口按「未显式 deny ∧
 * 至少一个具体能力 entitled」出现；它们不单独受分组/档案 kind 限制。
 */
export function entitlementOf(
  ctx: SurfaceContext,
  identity: { clientId?: string; profileId?: string } | undefined,
): { ids: string[]; profile: CallerProfile | undefined } {
  const profile = activeProfile(ctx.config, identity);
  const snapshot = compilePolicySnapshot({
    config: ctx.config,
    // 多环境：toolGroups/toolDeny 可由 _ENV_ 覆盖；entitlement 按当前绑定环境编译。
    toolFilter: toolFilterOf(ctx.config, ctx.toolFilter),
    ...(profile ? { profile } : {}),
    multiEnv: ctx.manager?.multiEnv === true,
    switchable: ctx.manager?.switchable ?? [],
    ...(ctx.config.httpPort != null ? { httpPort: ctx.config.httpPort } : {}),
  });
  return { ids: [...snapshot.entitlement], profile };
}

/** 一次 server 构建使用的面（HTTP 每请求一份；stdio 单实例一份） */
export interface CallerSurface {
  /** 归属键（clientId / '(stdio)'） */
  key: string;
  /** 可触达上限（部署静态面 ∩ 档案）——发现、契约与执行的判定依据 */
  entitlementIds: Set<string>;
  /** 实际注册出去的工具集 = entitlement 里的平台入口 */
  surfaceIds: Set<string>;
}

/**
 * 计算这次连接的面：只有两个平台入口。
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
  const surfaceIds = new Set<string>();
  for (const id of PLATFORM_TOOL_IDS) {
    if (entitlementIds.has(id)) surfaceIds.add(id);
  }
  return { key: surfaceKeyOf(identity), entitlementIds, surfaceIds };
}

/** 面内的能力条目（按 id 排序：确定性顺序，跨传输/跨调用方比对列表时顺序稳定） */
export function surfaceCapabilities(ids: ReadonlySet<string>): Capability[] {
  return CAPABILITY_LIST.filter((c) => ids.has(c.id)).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/** 能力的一句话摘要（发现/契约摘要用）：优先 routing.intent，其次描述首句 */
export function summaryOf(cap: Capability): string {
  const firstLine = (cap.routing?.intent ?? cap.description.split('\n')[0] ?? '').replace(/\s+/g, ' ').trim();
  const stop = firstLine.search(/[。；]/);
  const head = stop > 0 ? firstLine.slice(0, stop) : firstLine;
  return head.length > 120 ? `${head.slice(0, 119)}…` : head;
}

/** 索引里的单个参数信息（够模型决定怎么填，但不是完整 schema） */
export interface ParamDetail {
  name: string;
  required: boolean;
  type: string;
  description?: string;
}

function unwrapZodField(field: unknown): any {
  let f: any = field;
  for (let i = 0; i < 8 && f && typeof f === 'object' && f._def; i += 1) {
    const t = f._def.type;
    if (t === 'optional' || t === 'default' || t === 'nullable' || t === 'readonly' || t === 'catch') {
      f = f._def.innerType;
      continue;
    }
    break;
  }
  return f;
}

function zodTypeLabel(field: unknown): string {
  const f = unwrapZodField(field);
  const t = f?._def?.type as string | undefined;
  switch (t) {
    case 'array':
      return `${zodTypeLabel(f?._def?.element)}[]`;
    case 'string':
    case 'number':
    case 'boolean':
    case 'enum':
    case 'literal':
    case 'union':
    case 'record':
    case 'object':
      return t;
    default:
      return t ?? 'unknown';
  }
}

function zodDescription(field: unknown): string | undefined {
  let f: any = field;
  for (let i = 0; i < 8 && f && typeof f === 'object'; i += 1) {
    if (typeof f.description === 'string' && f.description.length > 0) return f.description;
    f = f._def?.innerType;
  }
  return undefined;
}

/**
 * 能力的参数面（发现/契约辅助）：名字 + 必填 + 粗类型 + 参数说明。
 * 不返回完整 schema（那是 `hana_tool_search(mode=contract)` 的收益）。
 */
export function paramDetailsOf(
  cap: Capability,
  multiEnv = false,
  mode: 'args' | 'envelope' = 'envelope',
): ParamDetail[] {
  // 契约默认走信封：expectedEnvironment/expectedEpoch 不在 args 里。
  const schema = capabilityInputSchema(cap, multiEnv, mode);
  const shape = (schema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) return [];
  return Object.entries(shape).map(([name, field]) => {
    let required = false;
    try {
      const parsed = (field as { safeParse?: (value: unknown) => { success: boolean } }).safeParse?.(undefined);
      required = parsed ? !parsed.success : false;
    } catch {
      required = false;
    }
    const description = zodDescription(field);
    return { name, required, type: zodTypeLabel(field), ...(description ? { description } : {}) };
  });
}

/** 必填参数名（契约的 required 快捷字段；与 paramDetailsOf 同源） */
export function requiredParamsOf(cap: Capability, multiEnv = false, mode: 'args' | 'envelope' = 'envelope'): string[] {
  return paramDetailsOf(cap, multiEnv, mode)
    .filter((p) => p.required)
    .map((p) => p.name);
}

/** 按 id 解析能力（路由用）；未登记返回 undefined */
export function resolveCapability(id: string): Capability | undefined {
  return findCapability(id);
}

/**
 * 能力面省略说明：让调用方知道「为什么有些能力不可达」，同时**默认不泄漏**被隐藏的能力名。
 *
 * 三类口径：
 * - 部署策略 / deny：说明句 + 涉及**类别**，默认不点名能力，不提示重试；
 * - 分组 / allow 过滤：只列本次启用的类别；
 * - 档案收紧：说明句 + 涉及类别（同样不点名）。
 *
 * 全量面返回 `{ status: 'full' }`——正常部署**不追加任何噪音**。
 * `names=true` 是调试口径，才会输出被隐藏的能力 id。
 */
export interface SurfaceExplanation {
  status: 'full' | 'restricted';
  /** 本次部署启用的类别（有成员可见的类别） */
  enabledCategories?: BusinessCategory[];
  /** 一个可见成员都没有的类别 */
  omittedCategories?: BusinessCategory[];
  /** 可读说明（不含能力名，除非调试开关） */
  notes?: string[];
  /** 被隐藏的能力 id（仅调试口径 names=true） */
  omittedNames?: string[];
}

export function explainSurface(
  ctx: SurfaceContext,
  identity: { clientId?: string; profileId?: string } | undefined,
  opts: { names?: boolean } = {},
): SurfaceExplanation {
  const profile = activeProfile(ctx.config, identity);
  const filter = toolFilterOf(ctx.config, ctx.toolFilter);
  // `sql` 组是**默认关闭**的敏感能力；`tool_search` 是平台入口，不参与业务类别说明。
  const concrete = CAPABILITY_LIST.filter(
    (c) =>
      c.platform !== true && c.category !== 'tool_search' && (c.kind !== 'sql' || shouldRegisterTool(c.id, filter)),
  );
  const denied: Capability[] = [];
  const groupHidden: Capability[] = [];
  const profileHidden: Capability[] = [];

  for (const cap of concrete) {
    if (!shouldRegisterTool(cap.id, filter)) {
      const deniedById =
        matchGlob(cap.id, filter.denyPatterns) ||
        (cap.routeOnly === true && matchGlob(cap.module, filter.denyPatterns));
      (deniedById ? denied : groupHidden).push(cap);
    } else if (profileAllows(profile, cap.id, cap.kind).ok) {
      // 允许
    } else {
      profileHidden.push(cap);
    }
  }

  const hidden = [...denied, ...groupHidden, ...profileHidden];
  if (hidden.length === 0) return { status: 'full' };

  const categoriesOf = (caps: readonly Capability[]): string[] => {
    const set = new Set(caps.map((c) => c.category));
    const categories: string[] = CAPABILITY_CATALOG.map((e) => e.id).filter((id) => set.has(id));
    return [...categories, ...(set.has('sql') ? ['SQL 执行'] : [])];
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
