import type { McpServer, ServerContext, CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { parseToolFilter, shouldRegisterTool, type ToolFilterConfig, ALL_TOOL_GROUPS } from './groups.js';
import { logger } from '../core/logger.js';
import { currentIdentity } from '../core/request-context.js';
import { activeProfile } from '../config/profiles.js';
import { policyFromConfig } from '../config/preflight.js';
import { blockedCallResult, dispatchAuthorized } from '../config/authorize.js';
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
  /** 已校验配置（含脱敏摘要供 ping 类工具展示） */
  config: HanaConfig;
  /**
   * 工具可见性过滤配置（由 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY 解析而来）。
   * 未进面的能力不出现在 tools/list，但仍可经门面路由调用（判定走同一套闸门）。
   */
  toolFilter: ToolFilterConfig;
  /**
   * 本次 server 构建使用的**面**：`(门面 ∪ 已提升分类的成员) ∩ 部署策略 ∩ 档案`。
   * HTTP 按请求构建（于是每个身份看到自己的面）；stdio 单实例。省略 = 由 `surfaceOf` 现算。
   */
  surface?: CallerSurface;
}

/**
 * 取这次构建要用的面：ctx.surface 优先（HTTP 按请求构建、测试注入），否则现算（stdio 单实例）。
 */
function surfaceOf(ctx: ToolContext): CallerSurface {
  return ctx.surface ?? computeSurface(ctx, currentIdentity());
}

/** 由 mcp.json/.env 配置解析得到 ToolFilterConfig；无效分组名在此抛错（fail-closed：启动即失败） */
export function buildToolFilter(config: HanaConfig): ToolFilterConfig {
  return parseToolFilter(config.toolGroups, config.toolAllow.join(','), config.toolDeny.join(','));
}

/**
 * 返回与 McpServer.registerTool 同型的注册器，按本次连接的「面」过滤：不可见的工具直接跳过。
 * 与调用期闸门分工：这里管「这次部署注册不注册」，闸门管「这次调用成不成立」。
 */
function registerVisibleTool(server: McpServer, ctx: ToolContext): McpServer['registerTool'] {
  // 面已包含可见性过滤与提升结果，此处不再单独咨询 filter。
  const effective = surfaceOf(ctx);
  return ((name: string, config: unknown, cb: unknown) => {
    // 工具级能力 id 恒等于注册名（操作级条目只经路由，不注册）
    if (!effective.surfaceIds.has(name)) return;
    return (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as McpServer['registerTool'];
}

/**
 * 能力清单条目 → SDK 的 registerTool 配置：title / inputSchema / annotations 全部取自清单。
 * 门面描述按 surface 重建，文本随 deny / 分组 / 档案的收窄而收窄。
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
   * 只登记 handler、不注册工具（routeOnly 条目专用）。
   * 别用主入口注册它们——注册名 = module = 父工具名，会撞名。
   */
  routeOnly<S extends z.ZodType>(cap: Capability<S>, handler: CapabilityHandler<S>): void;
}

/**
 * 返回按能力清单注册的注册器：配置取自清单，handler 由统一调用期闸门（authorizeCall）包住。
 * 所有能力过同一个闸门，差别只在「有没有资源维度」（由 effects.plan 的有无表达）。
 * 注册期过滤算的是本次连接的面：具体能力默认只经门面路由调用，分类被提升后才进 tools/list。
 */
export function capabilityRegistrar(server: McpServer, ctx: ToolContext): CapabilityRegistrar {
  const register = registerVisibleTool(server, ctx);
  const surface = surfaceOf(ctx);
  const registrar = function registerCapability<S extends z.ZodType>(
    cap: Capability<S>,
    handler: CapabilityHandler<S>,
  ): void {
    // ① 原始 handler 先入表：门面按目标能力授权后直接派发，不再过一遍闸门
    recordRawHandler(server, cap.id, handler);
    // ② 可见则注册（配置来自清单）
    (register as (n: string, c: unknown, f: unknown) => unknown)(
      registeredNameOf(cap),
      registrationOf(cap, surface),
      gatedHandler(ctx, cap, handler),
    );
  } as CapabilityRegistrar;
  registrar.routeOnly = <S extends z.ZodType>(cap: Capability<S>, handler: CapabilityHandler<S>): void => {
    // fail-closed：只有标了 routeOnly 的条目才允许走这条入口，标错的当场炸而不是静默不可达。
    if (cap.routeOnly !== true) {
      throw new Error(`${cap.id}: routeOnly 注册入口只接受 routeOnly 条目（清单缺 routeOnly 标记？）`);
    }
    recordRawHandler(server, cap.id, handler);
  };
  return registrar;
}

/**
 * 给 handler 套上统一调用期闸门（注册路径与动态注册共用）。
 * 策略来自已加载的 config（不重新解析 env）；档案：身份里带就用它，否则落进程默认。
 */
function gatedHandler<S extends z.ZodType>(
  ctx: ToolContext,
  cap: Capability<S>,
  handler: CapabilityHandler<S>,
): (args: Record<string, unknown>, extra: unknown) => unknown {
  return (args, extra) => {
    const identity = currentIdentity();
    // 授权 → 执行 → 写能力终态审计：三个动作收在 dispatchAuthorized 一处，
    // 门面路由与平铺直调共用同一个壳（P0-4）。
    return dispatchAuthorized(
      cap,
      args,
      {
        policy: policyFromConfig(ctx.config, ctx.toolFilter),
        profile: activeProfile(ctx.config, identity),
        agentLabel: ctx.config.agentLabel,
      },
      () => (handler as (a: unknown, e: unknown) => unknown)(args, extra),
      (auth) => blockedCallResult(auth) as never,
    );
  };
}

/**
 * 动态提升的注册结果（P1-6）：成功清单 + 可重试的失败清单。
 * `failures` 是**瞬时/编程**失败（handler 未登记、注册器抛错），重试门面调用可能补齐；
 * 策略性省略（deny/档案）在面计算阶段就被排除，不会走到这里。
 */
export interface DynamicRegistrationResult {
  registered: string[];
  failures: { capabilityId: string; reason: string }[];
}

/**
 * 把已提升的能力挂到当前已连接的实例上（stdio 路径）。
 * HTTP 无会话、每请求新建 server，下一个请求自然带上新能力，不需要它。
 * 闸门照旧包上——动态注册与静态注册走同一条判定。
 */
export function registerCapabilitiesDynamically(
  server: McpServer,
  ctx: ToolContext,
  caps: readonly Capability[],
): DynamicRegistrationResult {
  const registered: string[] = [];
  const failures: { capabilityId: string; reason: string }[] = [];
  for (const cap of caps) {
    const name = registeredNameOf(cap);
    if (hasDynamicHandle(server, name)) continue; // 幂等：重复提升同一分类不重复挂
    const raw = getRawHandler(server, cap.id);
    if (!raw) {
      // 面内但本进程没有 handler：编程错误，响亮记录而非静默跳过
      logger.error({ capabilityId: cap.id }, '提升：目标能力的 handler 未注册（清单与注册不同步），本次跳过');
      failures.push({ capabilityId: cap.id, reason: 'handler_missing' });
      continue;
    }
    try {
      const handle = server.registerTool(
        name,
        registrationOf(cap, surfaceOf(ctx)),
        gatedHandler(ctx, cap, raw as CapabilityHandler<typeof cap.inputSchema>) as never,
      ) as unknown as { remove(): void };
      recordDynamicHandle(server, name, handle);
      registered.push(name);
    } catch (e) {
      // 单个注册失败不拖垮整类：记 warning，交由调用方回报 partial（可重试）
      logger.error({ capabilityId: cap.id, err: e }, '提升：能力注册失败（本次跳过，重试门面调用可补齐）');
      failures.push({ capabilityId: cap.id, reason: 'register_failed' });
    }
  }
  return { registered, failures };
}

/**
 * 把已淘汰的能力从当前已连接的实例上摘下来（stdio 路径；静态门面不参与淘汰）。
 * HTTP 不需要它：下一个请求重建 server 时面里自然不再包含被淘汰的分类。
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
 * 启动时打印工具可见性摘要（仅配置了过滤变量时输出），便于排查「为何某工具没注册」。
 * 操作级别名不是工具，不列入。
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
 * 注册全部工具。可见性 = 本次构建的面（见 surface.ts）；零可见时什么都不注册。
 * 实测（SDK 2.3.1）：零注册时服务端不声明 tools，客户端 tools/list 得到 -32601，
 * 由下方 warn 与 npm run preflight 兜底。
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // 面算一次、贯穿本次构建
  const effective = surfaceOf(ctx);
  // 门面最先注册（入口排最前）；stdio 的动态注册也是 append 到末尾，两种传输顺序一致。
  registerCapabilityTools(server, ctx);
  registerSystemTools(server, ctx);
  registerPackageTools(server, ctx);
  registerMetadataTools(server, ctx);
  registerPreviewTools(server, ctx);
  registerModelingTools(server, ctx);
  // 异步任务工具紧随建模模块：注册顺序必须与清单顺序一致（顺序断言会核对）。
  registerTaskTools(server, ctx);
  registerSqlAnalyzeTools(server, ctx);
  registerHealthTools(server, ctx);

  // 零工具只可能来自显式 deny 掉全部能力（误配）：SDK 不声明 tools，客户端表现为协议层 -32601。
  // 不用占位工具顶住——占位是假能力，会在清单/分组/快照里处处需要例外。
  const anyVisible = effective.surfaceIds.size > 0;
  if (!anyVisible) {
    logger.warn(
      '当前配置未启用任何工具：SDK 不会声明 tools 能力，客户端调 tools/list 将得到 -32601。' +
        '请检查 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY（空=全部启用）。',
    );
  }
}
