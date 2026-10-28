/**
 * 分类门面工具：`hana_<分类>`——六个常驻入口，兼任索引与路由。
 *
 * - 不带 capability：取本类索引（id / 标题 / kind / 一句话摘要 / 参数名）；
 * - 带 capability + args：路由到该能力，授权与参数校验都按目标能力判定。
 *
 * 三条硬约束（不变量 B、D、E）：
 * 1. 授权按目标能力判定（不是按门面名）；门面自身也先过一遍闸门；
 * 2. 参数在服务端按目标能力 schema 校验（客户端 schema 只是便利）；
 * 3. 未知能力与无权能力逐字同形；门面还有扇出边界（路由不到别的分类/门面）。
 */

import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { FACADE_CATEGORIES, registeredNameOf, type FacadeCategory } from '../capabilities/types.js';
import { FACADE_SCHEMA, facadeIdOf } from '../capabilities/facades.js';
import { CAPABILITY_LIST, FACADES, membersOfCategory } from '../capabilities/manifest.js';
import { blockedCallResult, dispatchAuthorized } from '../config/authorize.js';
import { policyFromConfig } from '../config/preflight.js';
import type { CallerProfile } from '../config/profiles.js';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { currentIdentity } from '../core/request-context.js';
import type { Envelope } from '../types/hana.js';
import { toToolResult } from './common.js';
import {
  capabilityRegistrar,
  registerCapabilitiesDynamically,
  unregisterCapabilities,
  type CapabilityHandler,
  type ToolContext,
} from './index.js';
import { getRawHandler, hasDynamicHandle } from './handler-registry.js';
import {
  computeSurface,
  entitlementOf,
  explainSurface,
  paramNamesOf,
  promoteCategories,
  resolveCapability,
  summaryOf,
  surfaceCapabilities,
} from './surface.js';

/** 未知/无权能力的**同一句**回执（不变量 D；两者必须逐字相同） */
export const UNKNOWN_CAPABILITY_TEXT = '未知能力：该能力不存在，或未对当前调用方开放。';

/**
 * 门面路由拒绝分支的 capability-audit 载荷——与 config/authorize.ts 的 CapabilityAuditEvent 同形。
 * profileId 取解析后的生效档案；resources 恒在场（路由入口无资源维度，按空数组约定）；via 归因到门面。
 */
function blockAuditPayload(
  ctx: ToolContext,
  identity: { clientId?: string; transport?: 'http' | 'stdio' } | undefined,
  profile: CallerProfile | undefined,
  facadeId: string,
  capabilityId: string,
  codes: string[],
): Record<string, unknown> {
  return {
    capabilityId,
    result: 'denied',
    verdict: 'block',
    ...(identity?.clientId ? { clientId: identity.clientId } : {}),
    ...(identity?.transport ? { transport: identity.transport } : {}),
    ...(profile ? { profileId: profile.id } : {}),
    ...(ctx.config.agentLabel ? { agentLabel: ctx.config.agentLabel } : {}),
    via: facadeId,
    resources: { writePackages: [], readSchemas: [], readPackages: [] },
    codes,
    denyReason: codes[0] ?? 'denied',
  };
}

/**
 * 注册六个门面，由 registerAllTools 最先调用。
 * 路由不依赖注册顺序：目标 handler 在调用期按 id 从原始表解析。
 */
export function registerCapabilityTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  for (const category of FACADE_CATEGORIES) {
    regCap(FACADES[`hana_${category}`], facadeHandler(server, ctx, category));
  }
}

/**
 * 调门面时把该分类提升进调用方的面（对齐 hana-cli 的 discover_by_category）。
 *
 * 提升只改呈现（该分类能力进入 tools/list、带完整 schema），不改授权——每次调用照旧按目标能力过闸门。
 * 索引调用与路由调用都触发提升：两者都表明「接下来要在这个分类里干活」。
 * 超出 MCP_CAPABILITY_SURFACE_MAX 时最旧分类整体出局，并从活实例上摘下来。
 */
async function promoteOnFacadeCall(
  server: McpServer,
  ctx: ToolContext,
  identity: { clientId?: string; transport?: 'http' | 'stdio'; profileId?: string } | undefined,
  category: FacadeCategory,
): Promise<{ report: Record<string, unknown> }> {
  const before = computeSurface(ctx, identity);
  if (!before.canPromote) {
    // 未配 Token 的 HTTP 部署：所有调用方共用 anonymous 身份，提升会互相串改可见面 → 整体关闭。
    // 该类能力仍可经门面路由调用。
    logger.info(
      { clientId: identity?.clientId, category },
      '提升未启用（部署未配置 MCP_HTTP_TOKENS，单租户假设）：本类能力仍可经门面路由调用',
    );
    return {
      report: {
        promoted: false,
        status: 'skipped',
        notes: ['部署未配置 MCP_HTTP_TOKENS：提升整体关闭（单租户假设）；本类能力仍可经门面路由调用。'],
        hint: '本次未提升（部署未配置 Token）：直接用 { capability, args } 调用即可，不必等提升。',
      },
    };
  }

  const { added, evicted } = promoteCategories(before.key, [category], ctx.config.surfaceMax);
  const after = computeSurface(ctx, identity);

  // 本类对当前调用方可提升的成员（可触达且非 routeOnly 别名）。
  // 只读部署下调用写类门面时它是空的：回执不得说「已提升」。
  const promotableMembers = membersOfCategory(category).filter(
    (m) => m.routeOnly !== true && before.entitlementIds.has(m.id),
  );
  const anyEntitledMember = membersOfCategory(category).some((m) => before.entitlementIds.has(m.id));

  // 淘汰按注册表口径说：出局分类里原本在面上的工具整体离开工具面。
  // HTTP 每请求新建 server，摘除恒为空；但注册表淘汰是真的——报告必须据此说，否则模型以为工具还在。
  const evictedTools = evicted.flatMap((c) =>
    membersOfCategory(c)
      .filter((m) => before.surfaceIds.has(m.id))
      .map((m) => m.id),
  );
  // 活实例动作（stdio 长连接才有意义）：把出局工具从本进程注册面摘掉；HTTP 下恒为空数组
  const removed = unregisterCapabilities(server, evictedTools);

  // 新增：stdio 是长连接单实例，必须在**活的实例**上注册，客户端才会看到（并收到 list_changed）。
  // 重试口径：stdio 下把「面上但本实例仍无 handle」的都再试一次——上次瞬时失败的成员能在下一次
  // 门面调用里补齐（HTTP 每请求重建 server，下一次请求自然带上，不需要这里重试）。
  const gained = CAPABILITY_LIST.filter((c) => after.surfaceIds.has(c.id) && !before.surfaceIds.has(c.id));
  const toRegister =
    identity === undefined
      ? CAPABILITY_LIST.filter(
          (c) =>
            c.facadeOf === undefined && after.surfaceIds.has(c.id) && !hasDynamicHandle(server, registeredNameOf(c)),
        )
      : gained;
  const registration = registerCapabilitiesDynamically(server, ctx, toRegister);
  const registered = registration.registered;
  const failures = registration.failures;

  if (added.length > 0 || evictedTools.length > 0) {
    logger.info(
      {
        capabilityId: facadeIdOf(category),
        verdict: 'allow',
        ...(identity?.clientId ? { clientId: identity.clientId } : {}),
        promotedCategory: added,
        promotedTools: registered,
        evictedTools,
        ...(removed.length > 0 ? { removedFromInstance: removed } : {}),
        ...(failures.length > 0 ? { failures } : {}),
      },
      'capability-promotion',
    );
  }

  // 回执不撒谎：promoted 只认真正进面的新增；hint 按可触达成员与新增结果分支。
  const baseHint =
    failures.length > 0
      ? `本类有 ${failures.length} 项能力本次加载失败（已成功 ${registered.length} 项）。可重试一次：再次调用本门面补齐；若仍失败请检查服务端日志，勿反复重试。`
      : !anyEntitledMember
        ? `本类在你这套权限下没有可用能力（索引为空），提升不会产生新工具。`
        : promotableMembers.length === 0
          ? `本类可触达的只有经门面路由的操作级别名（不注册为工具），提升不会产生新工具；` +
            `直接用 { capability, args } 调用即可。`
          : added.length > 0 && registered.length > 0
            ? `本类能力已**提升进你的工具面**：下一次 tools/list 即可见（带完整参数 schema），可直接按工具名平铺调用，` +
              `也可以继续用 { capability, args } 经本门面调用。提升在本连接内保持有效。`
            : `本类能力此前已提升过，仍在你的工具面上（tools/list 里可直接调用）。`;
  const evictedHint =
    evictedTools.length > 0
      ? ` 已达面上限（MCP_CAPABILITY_SURFACE_MAX），以下工具被移出你的工具面：${evictedTools.join(', ')}` +
        `（仍可经门面路由调用）。`
      : '';

  // P1-7：策略性省略只说到类别，不点名被隐藏的能力（names 调试开关才列 id）。
  const explainNames = ctx.config.explainSurface === 'names';
  const hiddenMembers = membersOfCategory(category).filter((m) => !before.entitlementIds.has(m.id));
  const notes: string[] = [];
  if (hiddenMembers.length > 0) {
    notes.push(`本类有 ${hiddenMembers.length} 项能力因部署策略或调用方档案不可见，未提升。`);
    if (explainNames) notes.push(`未提升的能力：${hiddenMembers.map((m) => m.id).join(', ')}`);
  }
  const warnings =
    failures.length > 0
      ? [
          `本类有 ${failures.length} 项能力加载失败（可重试一次：再次调用本门面；仍失败请查服务端日志）。` +
            (explainNames ? `失败能力：${failures.map((f) => f.capabilityId).join(', ')}` : ''),
        ]
      : [];
  const status = failures.length > 0 ? 'partial' : registered.length > 0 ? 'loaded' : 'already-loaded';

  return {
    report: {
      promoted: registered.length > 0,
      status,
      promotedTools: registered,
      ...(warnings.length > 0 ? { warnings } : {}),
      ...(notes.length > 0 ? { notes } : {}),
      ...(evictedTools.length > 0 ? { evictedTools } : {}),
      hint: baseHint + evictedHint,
    },
  };
}

/** 某个门面的 handler（索引 + 路由两用） */ function facadeHandler(
  server: McpServer,
  ctx: ToolContext,
  category: FacadeCategory,
): CapabilityHandler<typeof FACADE_SCHEMA> {
  const facadeId = facadeIdOf(category);
  return async ({ capability, args }, serverCtx) => {
    const identity = currentIdentity();
    // profile 随 entitlement 一并解析：路由分支的 authorizeCall 直接复用，不二次推导回退规则
    const { ids, profile } = entitlementOf(ctx, identity);

    // ── 提升：调门面 = 选定这一类（hana-cli 的 discover_by_category 语义）──────────
    // 提升只改呈现，不改授权（每次调用照旧按目标能力过闸门）。
    const promotion = await promoteOnFacadeCall(server, ctx, identity, category);

    // ── 索引调用：不带目标 = 取本类可触达能力的索引 ─────────────────────────
    if (capability === undefined) {
      // 排除门面自己（它的 category 等于它的 facadeOf，不过滤会把自己列进自己的索引）
      const members = surfaceCapabilities(new Set(ids)).filter(
        (c) => c.category === category && c.facadeOf === undefined,
      );
      const surfaceExplanation = explainSurface(ctx, identity, {
        names: ctx.config.explainSurface === 'names',
      });
      const envelope: Envelope = await withErrorEnvelope(async () => ({
        facade: facadeId,
        category,
        total: members.length,
        items: members.map((c) => ({
          id: c.id,
          title: c.title,
          kind: c.kind,
          summary: summaryOf(c),
          params: paramNamesOf(c),
        })),
        // P1-7：面被收窄时才说明（全量面不追加噪音）；默认只到类别，不点名被隐藏的能力。
        ...(surfaceExplanation.status === 'restricted' ? { surface: surfaceExplanation } : {}),
        ...promotion.report,
      }));
      return toToolResult(envelope);
    }

    // ── 路由调用：带目标 = 按目标能力授权 + 校验后派发 ───────────────────────
    const target = resolveCapability(capability);
    // 四类拒绝同形（不变量 D）：未登记 / 目标是门面 / 不在本分类 / 不在可触达范围。
    // 第三条是扇出边界，第四条不给存在性探针。
    if (!target || target.facadeOf !== undefined || target.category !== category || !ids.includes(target.id)) {
      // 审计不能缺席（不变量 E）：记请求的 id（哪怕不存在），与已登记能力的拦截记录同形。
      logger.warn(
        blockAuditPayload(ctx, identity, profile, facadeId, capability, ['unknown_capability']),
        'capability-audit',
      );
      return mcpErrorText(UNKNOWN_CAPABILITY_TEXT);
    }

    // 服务端按目标能力的 schema 校验（客户端 schema 只是便利，不是校验层）
    const parsed = target.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      // 审计不能缺席：schema 失败也是按目标能力的拒绝，否则与纯索引调用在审计里不可区分。
      logger.warn(
        blockAuditPayload(ctx, identity, profile, facadeId, target.id, ['input_schema_invalid']),
        'capability-audit',
      );
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('；');
      return mcpErrorText(
        `参数不符合 ${target.id} 的 schema：${issues}`,
        `用 ${facadeId}({}) 取本类索引可看它的参数名；完整 schema 由服务端按目标能力校验`,
      );
    }

    // 按目标能力授权 → 派发 → 写能力终态审计：与平铺直调**同一个执行壳**（dispatchAuthorized）。
    // 归因 via=门面 id（审计里能区分「经门面路由」与「提升后平铺直调」）。
    return dispatchAuthorized(
      target,
      parsed.data as Record<string, unknown>,
      {
        policy: policyFromConfig(ctx.config, ctx.toolFilter),
        // 复用 entitlementOf 解析出的同一次档案，不二次推导回退规则
        profile,
        agentLabel: ctx.config.agentLabel,
        via: facadeId,
      },
      () => {
        // 派发到原始 handler（闸门已在执行壳里按目标能力跑过；不走 SDK callTool 以免二次过闸）
        const handler = getRawHandler(server, target.id) as CapabilityHandler<typeof target.inputSchema> | undefined;
        if (!handler) {
          // 可触达但本进程没有 handler：编程错误（清单登记与注册不同步）
          logger.error(
            { capabilityId: target.id, via: facadeId },
            '门面路由：目标能力的 handler 未注册（清单与注册不同步）',
          );
          return mcpErrorText(UNKNOWN_CAPABILITY_TEXT);
        }
        return handler(parsed.data as never, serverCtx as ServerContext);
      },
      (blocked) => blockedCallResult(blocked),
    );
  };
}
