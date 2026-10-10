/**
 * 分类门面工具（P10-e 的动态层）：`hana_<分类>` —— 六个常驻入口，兼任**索引**与**路由**。
 *
 * 对应关系（改代码前先读）：
 * - 不带 `capability` 调用 = **取本类索引**（id / 标题 / kind / 一句话摘要 / 参数名）。
 *   这就是"挑具体工具时读的说明"——索引在这里，不在门面的描述里（描述每次会话常驻、只该给方向）；
 * - 带 `capability` + `args` = **路由**到该能力。授权与参数校验都按**目标能力**判定。
 *
 * ## 三条硬约束（不变量 B、D、E）
 *
 * 1. **授权按目标能力判定**——不是按门面这个名字。门面自己先过一遍闸门（它是被注册的工具，
 *    与别的工具没有区别），派发前再按目标能力跑一次：两条路径（若目标本身在面上 vs 经门面路由）
 *    必须得到同一条结论、同一段文案。
 * 2. **参数在服务端按目标能力的 schema 校验**——客户端从 tools/list 拿到的 JSON Schema 只是便利，
 *    不是校验层（门面的 `args` 声明为自由对象，正是为此）。
 * 3. **未知能力与无权能力逐字同形**——调用方无法用错误文案做存在性探针。门面还多一条扇出边界：
 *    `hana_modeling` 路由不到 `browse` 类的能力，也路由不到另一个门面。
 */

import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { FACADE_CATEGORIES, type FacadeCategory } from '../capabilities/types.js';
import { FACADE_SCHEMA, facadeIdOf } from '../capabilities/facades.js';
import { CAPABILITY_LIST, FACADES, membersOfCategory } from '../capabilities/manifest.js';
import { authorizeCall, blockedCallResult } from '../config/authorize.js';
import { policyFromConfig } from '../config/preflight.js';
import { resolveProfile } from '../config/profiles.js';
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
import { getRawHandler } from './handler-registry.js';
import {
  computeSurface,
  entitlementOf,
  paramNamesOf,
  promoteCategories,
  resolveCapability,
  summaryOf,
  surfaceCapabilities,
} from './surface.js';

/** 未知/无权能力的**同一句**回执（不变量 D；两者必须逐字相同） */
export const UNKNOWN_CAPABILITY_TEXT = '未知能力：该能力不存在，或未对当前调用方开放。';

/**
 * 注册六个门面。放最后注册（`registerAllTools` 里）：门面路由要靠原始 handler 表，
 * 表里必须先有全部目标能力的 handler。
 */
export function registerCapabilityTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  for (const category of FACADE_CATEGORIES) {
    regCap(FACADES[`hana_${category}`], facadeHandler(server, ctx, category));
  }
}

/**
 * 调门面时把该分类**提升**进调用方的面（P10-f，hana-cli 的 `discover_by_category` 语义）。
 *
 * ## 提升做了什么、没做什么
 *
 * - **做了**：该分类的具体能力进入 `tools/list`——带完整参数 schema、可按工具名**平铺直调**。
 *   这是提升唯一的收益：模型不必再从索引里猜参数。
 * - **没做**：授权。提升只改**呈现**；每次调用照旧按**目标能力**过闸门（`gatedHandler` 与路由分支
 *   里的 `authorizeCall` 各一次）。所以"提升越权"在这套里不成立——不变量 A 的落点。
 *
 * ## 为什么索引调用与路由调用都触发
 *
 * 两者都表明"接下来要在这个分类里干活"。hana-cli 的 discover 也是列清单与提升绑在一起的；
 * 不绑的话模型要先想清楚"我会不会多次用到它"，那是个它无法预判的问题。
 *
 * ## 淘汰
 *
 * 超出 `MCP_CAPABILITY_SURFACE_MAX` 时最旧的分类整体出局，且**真的从活实例上摘下来**
 * （`unregisterCapabilities` → SDK 句柄的 `remove()`）——只改注册表不摘工具，上限就形同虚设。
 */
async function promoteOnFacadeCall(
  server: McpServer,
  ctx: ToolContext,
  identity: { clientId?: string; transport?: 'http' | 'stdio'; profileId?: string } | undefined,
  category: FacadeCategory,
): Promise<{ report: Record<string, unknown> }> {
  const before = computeSurface(ctx, identity);
  if (!before.canPromote) {
    // 未配 Token 的 HTTP 部署：所有调用方共用一个 anonymous 身份，提升会互相串改可见面 → 整体关闭。
    // 该类能力仍可经门面路由调用，只是不会变成平铺工具。
    logger.info(
      { clientId: identity?.clientId, category },
      '提升未启用（部署未配置 MCP_HTTP_TOKENS，单租户假设）：本类能力仍可经门面路由调用',
    );
    return {
      report: {
        promoted: false,
        hint: '本次未提升（部署未配置 Token）：直接用 { capability, args } 调用即可，不必等提升。',
      },
    };
  }

  const { added, evicted } = promoteCategories(before.key, [category], ctx.config.surfaceMax ?? 50);
  const after = computeSurface(ctx, identity);

  // 淘汰：把出局分类的工具从活实例上摘掉（HTTP 无此需要——下一个请求重建时自然不带）
  const evictedNames = evicted.flatMap((c) => membersOfCategory(c).map((m) => m.id));
  const evictedInSurface = evictedNames.filter((n) => before.surfaceIds.has(n));
  const removed = unregisterCapabilities(server, evictedInSurface);

  // 新增：stdio 是长连接单实例，必须在**活的实例**上注册，客户端才会看到（并收到 list_changed）
  const gained = CAPABILITY_LIST.filter((c) => after.surfaceIds.has(c.id) && !before.surfaceIds.has(c.id));
  const registered = registerCapabilitiesDynamically(server, ctx, gained);

  if (added.length > 0 || removed.length > 0) {
    logger.info(
      {
        capabilityId: facadeIdOf(category),
        verdict: 'allow',
        ...(identity?.clientId ? { clientId: identity.clientId } : {}),
        promotedCategory: added,
        promotedTools: registered,
        evictedTools: removed,
      },
      'capability-promotion',
    );
  }

  return {
    report: {
      promoted: added.length > 0,
      promotedTools: registered,
      ...(removed.length > 0 ? { evictedTools: removed } : {}),
      hint:
        added.length > 0
          ? `本类能力已**提升进你的工具面**：下一次 tools/list 即可见（带完整参数 schema），可直接按工具名平铺调用，` +
            `也可以继续用 { capability, args } 经本门面调用。提升在本连接内保持有效。`
          : `本类能力此前已提升过，仍在你的工具面上（tools/list 里可直接调用）。`,
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
    const { ids } = entitlementOf(ctx, identity);

    // ── 提升：**调门面 = 选定这一类**（hana-cli 的 discover_by_category 语义）──────────
    // 索引调用与路由调用都触发：两者都表明"接下来要在这个分类里干活"。
    // 提升只改**呈现**（把该类能力搬进 tools/list、带上完整 schema），不改授权——
    // 每次调用照旧按目标能力过闸门（见下方路由分支与 gatedHandler）。
    const promotion = await promoteOnFacadeCall(server, ctx, identity, category);

    // ── 索引调用：不带目标 = 取本类可触达能力的索引 ─────────────────────────
    if (capability === undefined) {
      // 排除门面自己（它的 category 等于它的 facadeOf，不过滤会把自己列进自己的索引）
      const members = surfaceCapabilities(new Set(ids)).filter(
        (c) => c.category === category && c.facadeOf === undefined,
      );
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
        ...promotion.report,
      }));
      return toToolResult(envelope);
    }

    // ── 路由调用：带目标 = 按目标能力授权 + 校验后派发 ───────────────────────
    const target = resolveCapability(capability);
    // 四类拒绝**同形**（不变量 D）：未登记 / 目标是门面 / 不在本门面的分类 / 不在可触达范围。
    // 第三条是门面的扇出边界：跨类路由不给存在性探针。
    if (!target || target.facadeOf !== undefined || target.category !== category || !ids.includes(target.id)) {
      // 审计不能因为"回执统一"而缺席（不变量 E）：否则按 id 探测能力的存在性不会留任何痕迹。
      // 记的是**请求的 id**（哪怕它不存在），与已登记能力的拦截记录同形。
      logger.warn(
        {
          capabilityId: capability,
          verdict: 'block',
          ...(identity?.clientId ? { clientId: identity.clientId } : {}),
          ...(identity?.transport ? { transport: identity.transport } : {}),
          ...(identity?.profileId ? { profileId: identity.profileId } : {}),
          ...(ctx.config.agentLabel ? { agentLabel: ctx.config.agentLabel } : {}),
          via: facadeId,
          codes: ['unknown_capability'],
        },
        'capability-audit',
      );
      return mcpErrorText(UNKNOWN_CAPABILITY_TEXT);
    }

    // 服务端按目标能力的 schema 校验（客户端 schema 只是便利，不是校验层）
    const parsed = target.inputSchema.safeParse(args ?? {});
    if (!parsed.success) {
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('；');
      return mcpErrorText(
        `参数不符合 ${target.id} 的 schema：${issues}`,
        `用 ${facadeId}({}) 取本类索引可看它的参数名；完整 schema 由服务端按目标能力校验`,
      );
    }

    // 按**目标能力**授权（不是门面）：与"目标本身在面上"的路径走同一个 authorizeCall
    const auth = authorizeCall(target, parsed.data as Record<string, unknown>, {
      policy: policyFromConfig(ctx.config, ctx.toolFilter),
      profile: resolveProfile(ctx.config.profiles, identity?.profileId ?? ctx.config.profileId),
      agentLabel: ctx.config.agentLabel,
    });
    if (!auth.allowed) return blockedCallResult(auth);

    // 派发到目标能力的**原始 handler**（未经闸门包装：闸门已在上面按目标能力跑过；
    // 不走 SDK 的 callTool 是为了避免二次过闸，也让"两条路径同一条判定"这件事在代码里可见）
    const handler = getRawHandler(server, target.id) as CapabilityHandler<typeof target.inputSchema> | undefined;
    if (!handler) {
      // 可触达但本进程没有它的 handler：只可能是编程错误（清单登记与注册不同步）
      logger.error(
        { capabilityId: target.id, via: facadeId },
        '门面路由：目标能力的 handler 未注册（清单与注册不同步）',
      );
      return mcpErrorText(UNKNOWN_CAPABILITY_TEXT);
    }
    return handler(parsed.data as never, serverCtx as ServerContext);
  };
}
