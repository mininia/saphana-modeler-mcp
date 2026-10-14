import type { McpServer, ServerContext, CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseToolFilter, shouldRegisterTool, type ToolFilterConfig, ALL_TOOL_GROUPS } from './groups.js';
import { logger } from '../core/logger.js';
import { currentIdentity } from '../core/request-context.js';
import { activeProfile } from '../config/profiles.js';
import { policyFromConfig } from '../config/preflight.js';
import { authorizeCall, blockedCallResult } from '../config/authorize.js';
import { registeredNameOf, type Capability } from '../capabilities/types.js';
import { CAPABILITY_LIST, membersOfCategory } from '../capabilities/manifest.js';
import { facadeDescription } from '../capabilities/facades.js';
import { computeSurface, type CallerSurface } from './surface.js';
import {
  getRawHandler,
  hasDynamicHandle,
  recordDynamicHandle,
  recordRawHandler,
  removeDynamicHandle,
} from './handler-registry.js';
import { registerCapabilityTools } from './capability.tools.js';
import { registerSystemTools } from './system.tools.js';
import { registerPackageTools } from './package.tools.js';
import { registerMetadataTools } from './metadata.tools.js';
import { registerPreviewTools } from './preview.tools.js';
import { registerModelingTools } from './modeling.tools.js';
import { registerTaskTools } from './task.tools.js';
import { registerSqlAnalyzeTools } from './sql-analyze.tools.js';
import { registerHealthTools } from './health.tools.js';
import type { HanaPool } from '../core/hana-client.js';
import type { HanaConfig } from '../config/config.js';

export interface ToolContext {
  /** HANA 连接池（懒连接，工具经池访问 HANA） */
  pool: HanaPool;
  /** 已校验配置（含脱敏后摘要供 ping 类工具展示） */
  config: HanaConfig;
  /**
   * 工具可见性过滤配置（由 mcp.json 的 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY 解析而来）。
   * 各 register* 模块经 capabilityRegistrar 按能力清单注册，注册出去的是这次连接的**面**（可触达上限（部署策略 ∩ 档案）∩（门面 ∪ 已提升分类的成员），见 surface.ts）：未进面的能力不出现在 tools/list——具体能力恒为动态调用，仍可经门面路由（判定走同一套闸门）。全空配置=不按分组/名称过滤（面的其余部分照常生效）。
   */
  toolFilter: ToolFilterConfig;
  /**
   * 本次 server 构建使用的**面**：`(门面 ∪ 已提升分类的成员) ∩ 部署策略 ∩ 档案`。
   * HTTP 按请求构建（于是每个身份看到自己的面）；stdio 单实例。省略 = 由 `surfaceOf` 现算。
   */
  surface?: CallerSurface;
}

/**
 * 取这次构建要用的**面**：`ctx.surface` 优先（HTTP 按请求构建、测试注入），否则现算（stdio 单实例）。
 *
 * 放在 ToolContext 上而不是逐层传参：8 个工具模块的签名不必知道"面"这件事，
 * 而 registerAllTools / capabilityRegistrar / registerVisibleTool 三处读到的**必然是同一个**面。
 */
function surfaceOf(ctx: ToolContext): CallerSurface {
  return ctx.surface ?? computeSurface(ctx, currentIdentity());
}

/** 由 mcp.json/.env 配置解析得到 ToolFilterConfig；无效分组名在此抛错（fail-closed：启动即失败） */
export function buildToolFilter(config: HanaConfig): ToolFilterConfig {
  return parseToolFilter(config.toolGroups, config.toolAllow.join(','), config.toolDeny.join(','));
}

/**
 * 返回一个与 McpServer.registerTool 同型（保留泛型推断）的工具注册器，
 * 在调用前按 ctx.toolFilter 过滤：不可见的工具直接跳过（不注册、不进 tools/list）。
 *
 * 类型设计：内部用 any 转发以避开 SDK 重载签名的组合难点，但整体 cast 为
 * `McpServer['registerTool']`，使调用侧（各 tools 模块）的 inputSchema → 回调参数推断
 * 与直接调用 server.registerTool 完全一致，零类型回归。
 *
 * 注意它与**调用期闸门**的分工：这里过滤的是"这次部署要不要注册它"（静态面），
 * 闸门判的是"这次调用能不能成立"（见 config/authorize.ts）。写工具的闸门曾单独有一层
 * `registerWriteTool`，P10-b 起所有能力统一由 `capabilityRegistrar` 包装，故该注册器已删除。
 */
function registerVisibleTool(server: McpServer, ctx: ToolContext): McpServer['registerTool'] {
  // 面：由 ctx.surface 给出（每 server 一份，见 ToolContext 的说明）；测试/脚本可直接注入。
  // 面已经包含了可见性过滤与提升的结果，故此处不再单独咨询 filter。
  const effective = surfaceOf(ctx);
  return ((name: string, config: unknown, cb: unknown) => {
    // 名字 → 能力 id：工具级能力 id 恒等于注册名（操作级条目只经路由，不注册）
    if (!effective.surfaceIds.has(name)) return;
    // 转发到真实 registerTool（类型由外层 cast 保证）
    return (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as McpServer['registerTool'];
}

/**
 * 能力清单条目 → SDK 的 `registerTool` 配置。
 *
 * title / inputSchema / annotations 取自清单（**唯一副本**，工具模块只提供 handler——同一件事
 * 不许有第二处说法）。门面描述是成员清单的投影：注册时按 `surface`（本次连接的可触达上限）重建，
 * 投给模型的文本因此随 deny / 分组开关 / 档案的收窄而收窄，与门面索引、路由同一条判定
 * （清单常量保存的是全集版本，见 `capabilities/facades.ts`）。键名与 `McpServer.registerTool`
 * 的配置对象对应；由 `capabilityRegistrar` 转发给 SDK。
 */
function registrationOf<S extends z.ZodType>(cap: Capability<S>, surface: CallerSurface) {
  const description =
    cap.facadeOf !== undefined
      ? facadeDescription(cap.facadeOf, membersOfCategory(cap.facadeOf), (m) => surface.entitlementIds.has(m.id))
      : cap.description;
  return {
    title: cap.title,
    description,
    inputSchema: cap.inputSchema,
    annotations: cap.annotations,
  };
}

/** handler 签名：与 SDK 的 `ToolCallback` 同形（args 由清单的 schema 推断，ctx 为 ServerContext） */
export type CapabilityHandler<S extends z.ZodType> = (
  args: z.infer<S>,
  ctx: ServerContext,
) => CallToolResult | InputRequiredResult | Promise<CallToolResult | InputRequiredResult>;

/** 按清单注册一个能力的函数（工具模块拿到的就是它） */
export interface CapabilityRegistrar {
  <S extends z.ZodType>(cap: Capability<S>, handler: CapabilityHandler<S>): void;
  /**
   * **只登记原始 handler、不注册工具**（routeOnly 条目专用：操作级别名 `<工具>#<op>`）。
   * 别用主入口去注册它们——注册名 = module = 父工具名，会与父工具撞名。
   * handler 不包闸门：门面路由在派发前已按**目标能力**跑过 authorizeCall（与父工具同一条判定）。
   */
  routeOnly<S extends z.ZodType>(cap: Capability<S>, handler: CapabilityHandler<S>): void;
}

/**
 * 返回**按能力清单注册**的注册器：注册名与配置取自清单条目（**门面描述**按本次连接的可触达上限
 * 重建，见 `registrationOf`），handler 由**统一的调用期闸门**（`authorizeCall`）包住。
 *
 * P10-b 之前，这里按清单的 `gate` 字段二选一（写工具包闸门、读工具只做可见性过滤）——
 * 那是"读工具没有任何调用期判定"的根源（SSD §7.1 事实 1）。现在**所有能力都过同一个闸门**，
 * 差别只在"闸门有没有资源维度"，而那由 `effects.plan` 的有无表达（见 types.ts 的说明）。
 *
 * 注册期过滤仍保留，但它算的是**这次连接的面**：
 * `(门面 ∪ 已提升分类的成员) ∩ 部署策略 ∩ 档案`（见 surface.ts）。具体能力默认不进面——
 * 只经门面路由调用；其分类被提升后才进 `tools/list`（带完整 schema、可平铺直调）。
 * 调用期闸门管的是"这次调用是否成立"（含经门面路由进来的那一次）。两者是"面"与"权"的关系——
 * 面是子集，不是替代（不变量 C：可见 ⇔ 可调用）。
 *
 * 另外：**所有能力的 handler 都会进原始 handler 表**（`handler-registry`），无论它是否在面上——
 * 那是门面路由能"够得着全部能力"的前提；表在进程内，不对外暴露。
 */
export function capabilityRegistrar(server: McpServer, ctx: ToolContext): CapabilityRegistrar {
  const register = registerVisibleTool(server, ctx);
  const surface = surfaceOf(ctx);
  const registrar = function registerCapability<S extends z.ZodType>(
    cap: Capability<S>,
    handler: CapabilityHandler<S>,
  ): void {
    // ① 原始 handler 先入表：门面按目标能力自行授权后直接派发，不再过一遍闸门
    recordRawHandler(server, cap.id, handler);
    // ② 可见则注册（配置来自清单，转发手法与 registerVisibleTool 内部一致）
    (register as (n: string, c: unknown, f: unknown) => unknown)(
      registeredNameOf(cap),
      registrationOf(cap, surface),
      gatedHandler(ctx, cap, handler),
    );
  } as CapabilityRegistrar;
  registrar.routeOnly = <S extends z.ZodType>(cap: Capability<S>, handler: CapabilityHandler<S>): void => {
    // fail-closed：只有清单里标了 routeOnly 的条目才允许走这条入口——标错的（想注册却没注册）会当场炸，
    // 而不是静默地"声明了但永远不可达"
    if (cap.routeOnly !== true) {
      throw new Error(`${cap.id}: routeOnly 注册入口只接受 routeOnly 条目（清单缺 routeOnly 标记？）`);
    }
    recordRawHandler(server, cap.id, handler);
  };
  return registrar;
}

/**
 * 给一个 handler 套上统一的调用期闸门（**唯一实现**：注册路径与"提升后动态注册"共用）。
 *
 * 策略来自**服务已加载的 config**（不重新解析 env——见 policyFromConfig 的说明），
 * 每次调用现算：判定用的值必须等于此刻运行用的值。
 * 档案：身份里带（HTTP Token 第三段）就用它，否则落进程默认（MCP_PROFILE）。
 */
function gatedHandler<S extends z.ZodType>(
  ctx: ToolContext,
  cap: Capability<S>,
  handler: CapabilityHandler<S>,
): (args: Record<string, unknown>, extra: unknown) => unknown {
  return (args, extra) => {
    const identity = currentIdentity();
    const auth = authorizeCall(cap, args, {
      policy: policyFromConfig(ctx.config, ctx.toolFilter),
      profile: activeProfile(ctx.config, identity),
      agentLabel: ctx.config.agentLabel,
    });
    if (!auth.allowed) return blockedCallResult(auth);
    // 放行：转发给真实 handler（类型由外层 cast 保证）
    return (handler as (a: unknown, e: unknown) => unknown)(args, extra);
  };
}

/**
 * 把**已提升**的能力挂到**当前已连接的实例**上（P10-f 的 stdio 路径）。
 *
 * HTTP 不需要它：无状态、每请求新建 server，下一个请求构建时 `computeSurface` 自然带上新提升的
 * 能力（HTTP 无会话、推送结构性不可达，客户端以"重新 tools/list"为准）。
 * stdio 是长连接单实例，必须在**活的实例**上注册，客户端才会看到（并收到 `list_changed`）。
 *
 * 闸门照旧包上（`gatedHandler`）——动态注册的能力与静态注册的走同一条判定，没有例外。
 * 调用方（门面）负责先按 entitlement 过滤；本函数只做"登记"。
 *
 * @returns 真正注册成功的工具名（handler 未登记的跳过——只可能是清单与注册不同步）
 */
export function registerCapabilitiesDynamically(
  server: McpServer,
  ctx: ToolContext,
  caps: readonly Capability[],
): string[] {
  const registered: string[] = [];
  for (const cap of caps) {
    const name = registeredNameOf(cap);
    if (hasDynamicHandle(server, name)) continue; // 幂等：重复提升同一分类不重复挂
    const raw = getRawHandler(server, cap.id);
    if (!raw) {
      // 面内但本进程没有它的 handler：编程错误（清单登记与注册不同步），响亮记录而非静默跳过
      logger.error({ capabilityId: cap.id }, '提升：目标能力的 handler 未注册（清单与注册不同步），本次跳过');
      continue;
    }
    const handle = server.registerTool(
      name,
      registrationOf(cap, surfaceOf(ctx)),
      gatedHandler(ctx, cap, raw as CapabilityHandler<typeof cap.inputSchema>) as never,
    ) as unknown as { remove(): void };
    recordDynamicHandle(server, name, handle);
    registered.push(name);
  }
  return registered;
}

/**
 * 把**已淘汰**的能力从**当前已连接的实例**上摘下来（P10-f 的 stdio 路径）。
 *
 * 只作用于动态注册的工具（静态的门面不参与淘汰）。HTTP 不需要它：下一个请求重建 server 时
 * `computeSurface` 自然不再包含被淘汰的分类。
 *
 * @returns 真正被摘下的工具名
 */
export function unregisterCapabilities(server: McpServer, toolNames: readonly string[]): string[] {
  const removed: string[] = [];
  for (const name of toolNames) {
    if (removeDynamicHandle(server, name)) removed.push(name);
  }
  return removed;
}

/**
 * 启动时打印工具可见性摘要（不泄露敏感信息）。
 * 仅在配置了过滤变量时输出，便于排查「为何某工具没注册」。
 *
 * 这里只按**工具过滤变量**（HANA_TOOL_GROUPS/ALLOW/DENY）列被关闭的条目；操作级别名（routeOnly）
 * 不是工具（任何配置下都不注册），不列入。零工具可见的告警不在这里——那由 `registerAllTools`
 * 按**实际构建的面**（含档案维度）发出，避免同一问题出现两套口径。
 */
export function logToolFilterSummary(filter: ToolFilterConfig): void {
  if (filter.enabledGroups.size === 0 && filter.allowPatterns.length === 0 && filter.denyPatterns.length === 0) {
    return; // 全空 = 不过滤（向后兼容默认），不打扰日志
  }
  const groupSummary =
    filter.enabledGroups.size === 0
      ? '全部分组启用'
      : Array.from(ALL_TOOL_GROUPS)
          .map((g) => `${g}${filter.enabledGroups.has(g) ? '✓' : '✗'}`)
          .join(' ');
  logger.info(
    { enabledGroups: groupSummary, allow: filter.allowPatterns, deny: filter.denyPatterns },
    '工具可见性过滤已启用（HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY）',
  );
  // 列出被关闭的工具名（帮助确认配置符合预期）
  const allNames = CAPABILITY_LIST.filter((c) => c.routeOnly !== true).map((c) => c.id);
  const disabled = allNames.filter((name) => !shouldRegisterTool(name, filter));
  if (disabled.length > 0) {
    logger.info(
      { disabledCount: disabled.length, disabled: disabled.join(', ') },
      '以下工具被配置关闭（不出现在 tools/list）',
    );
  }
}

/**
 * 注册全部工具。
 *
 * 可见性 = 本次构建的**面**（`(门面 ∪ 已提升分类的成员) ∩ 部署策略 ∩ 档案`，见 surface.ts）：
 * 各 register* 模块经 capabilityRegistrar 按清单逐能力注册，注册名不在面内的直接跳过（不注册、不进 tools/list）。
 * 零可见时**什么都不注册**——实测（SDK 2.3.1）此时服务端不声明 tools 能力，客户端 `tools/list` 得到
 * -32601 Method not found；
 * 这类误配（显式 deny 掉全部能力）由下方 warn 与 `npm run preflight` 兜底。
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // 面算一次、贯穿本次构建（HTTP 每请求一个 server；stdio 单实例）。
  const effective = surfaceOf(ctx);
  // 门面**最先注册**：它们是入口，`tools/list` 里排最前。
  // 这也是为了与 stdio 的**动态注册**顺序对齐——提升进来的能力在两种传输下都排在门面之后
  // （HTTP：本次构建按模块顺序注册；stdio：提升时 append 到活实例末尾），
  // 否则同一个逻辑面会因传输方式不同而呈现不同顺序。
  registerCapabilityTools(server, ctx);
  registerSystemTools(server, ctx);
  registerPackageTools(server, ctx);
  registerMetadataTools(server, ctx);
  registerPreviewTools(server, ctx);
  registerModelingTools(server, ctx);
  // 异步任务工具紧随建模模块：清单里两条任务能力登记在 modelingCapabilities 末尾，
  // 注册顺序必须与清单顺序一致（tool-groups/manifest 的顺序断言会核对这一点）
  registerTaskTools(server, ctx);
  registerSqlAnalyzeTools(server, ctx);
  registerHealthTools(server, ctx);

  // 零工具可见时这里什么也不注册。实测（SDK 2.3.1，InMemoryTransport 探针）：零注册时
  // `capabilities` 为空对象、不声明 tools，`tools/list` 返回 -32601 Method not found——
  // "把所有能力都 deny 掉"的部署在客户端侧表现为**协议层报错**，而不是"没有工具"。
  //
  // 不用占位工具顶住 tools/list 的可达性：占位项是**假能力**，会在清单、分组表、预算指标、
  // 快照里处处需要例外，换来的只是把一条协议错误变成一句话。零工具只可能来自显式 deny 掉
  // 全部能力（误配，不是用法），由下方 warn 与 `npm run preflight` 兜底。
  const anyVisible = effective.surfaceIds.size > 0;
  if (!anyVisible) {
    logger.warn(
      '当前配置未启用任何工具：SDK 不会声明 tools 能力，客户端调 tools/list 将得到 -32601。' +
        '请检查 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY（空=全部启用）。',
    );
  }
}
