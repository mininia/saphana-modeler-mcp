import type { McpServer, ServerContext, CallToolResult, InputRequiredResult } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { shouldRegisterTool, matchGlob, toolFilterOf, type ToolFilterConfig, ALL_TOOL_GROUPS } from './groups.js';
import { logger } from '../core/logger.js';
import { currentIdentity } from '../core/request-context.js';
import { activeProfile } from '../config/profiles.js';
import { policyFromConfig } from '../config/preflight.js';
import { approvalGate } from '../config/approval.js';
import { blockedCallResult, dispatchAuthorized } from '../config/authorize.js';
import { capabilityInputSchema } from '../config/environment-policy.js';
import { registeredNameOf, type Capability } from '../capabilities/types.js';
import { CAPABILITY_LIST, manifestRev } from '../capabilities/manifest.js';
import { computeSurface, type CallerSurface } from './surface.js';
import { policyRevOf } from './contracts.js';
import { recordRawHandler } from './handler-registry.js';
import { registerToolSearchTools } from './tool-search.tools.js';
import { registerInvokeTools } from './invoke.tools.js';
import { registerSystemTools } from './system.tools.js';
import { registerEnvironmentTools } from './env.tools.js';
import { registerPackageTools } from './package.tools.js';
import { registerMetadataTools } from './metadata.tools.js';
import { registerPreviewTools } from './preview.tools.js';
import { registerModelingTools } from './modeling.tools.js';
import { registerTaskTools } from './task.tools.js';
import { registerSqlAnalyzeTools } from './sql-analyze.tools.js';
import { registerSqlExecuteTools } from './sql-execute.tools.js';
import { registerHealthTools } from './health.tools.js';
import type { HanaPool } from '../core/hana-client.js';
import type { HanaConfig } from '../config/config.js';
import type { EnvironmentManager } from '../config/environment-runtime.js';
import {
  currentEnvironmentRuntime,
  reclaimDrainingEnvironment,
  runWithEnvironment,
} from '../core/environment-context.js';
import { createExecutionContext, runWithExecutionContext } from '../core/execution-context.js';

export interface ToolContext {
  /** HANA 连接池（懒连接，工具经池访问 HANA） */
  pool: HanaPool;
  /** 已校验配置（含脱敏摘要供 ping 类工具展示） */
  config: HanaConfig;
  /**
   * 工具可见性过滤配置（由 HANA_TOOL_GROUPS/HANA_TOOL_DENY 解析而来）。
   * 未进 entitlement 的能力不可发现、也不可执行（判定走同一套闸门）。
   */
  toolFilter: ToolFilterConfig;
  /**
   * 多环境管理器。存在时，每次工具调用入口绑定一次 runtime：
   * `ctx.pool` / `ctx.config` 的 getter 优先读绑定值，handler 内不再看全局 active。
   * 省略 = 单环境测试/脚本直调。
   */
  manager?: EnvironmentManager;
  /**
   * 本次 server 构建使用的**面**：两个平台入口（`hana_tool_search` / `hana_invoke`）∩ 部署策略 ∩ 档案。
   * HTTP 按请求构建（于是每个身份看到自己的面）；stdio 单实例。省略 = 由 computeSurface 现算。
   */
  surface?: CallerSurface;
}

/**
 * 取这次构建要用的面：ctx.surface 优先（HTTP 按请求构建、测试注入），否则现算（stdio 单实例）。
 */
function surfaceOf(ctx: ToolContext): CallerSurface {
  return ctx.surface ?? computeSurface(ctx, currentIdentity());
}

/** 由 mcp.json/.env 配置解析得到 ToolFilterConfig；多环境下应按当前环境 config 调用 */
export function buildToolFilter(config: HanaConfig): ToolFilterConfig {
  return toolFilterOf(config);
}

/**
 * 返回与 McpServer.registerTool 同型的注册器，按本次连接的「面」过滤：不可见的工具直接跳过。
 * 与调用期闸门分工：这里管「这次部署注册不注册」，闸门管「这次调用成不成立」。
 */
function registerVisibleTool(server: McpServer, ctx: ToolContext): McpServer['registerTool'] {
  // 面已包含可见性过滤结果，此处不再单独咨询 filter。
  const effective = surfaceOf(ctx);
  return ((name: string, config: unknown, cb: unknown) => {
    // 工具级能力 id 恒等于注册名（操作级条目只经路由，不注册）
    if (!effective.surfaceIds.has(name)) return;
    return (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as McpServer['registerTool'];
}

/**
 * 能力清单条目 → SDK 的 registerTool 配置：title / inputSchema / annotations 全部取自清单。
 * 具体能力默认不注册；只有平台入口会进入工具面。
 */
function registrationOf<S extends z.ZodType>(
  cap: Capability<S>,
  _surface: CallerSurface,
  multiEnv: boolean,
  goalEnabled = true,
) {
  const description =
    cap.id === 'hana_tool_search' && !goalEnabled
      ? `${cap.description}
（本部署已关闭 goal 模式：只用 discover/contract。）`
      : cap.description;
  return {
    title: cap.title,
    description,
    // 多环境下所有具体能力都要求 expectedEnvironment；平台入口/单环境原样返回
    inputSchema: capabilityInputSchema(cap, multiEnv),
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
 * 注册期过滤算的是本次连接的面：具体能力不注册为工具，只登记 handler 供 hana_invoke 派发。
 */
export function capabilityRegistrar(server: McpServer, ctx: ToolContext): CapabilityRegistrar {
  const register = registerVisibleTool(server, ctx);
  const surface = surfaceOf(ctx);
  const registrar = function registerCapability<S extends z.ZodType>(
    cap: Capability<S>,
    handler: CapabilityHandler<S>,
  ): void {
    // ① 原始 handler 先入表：hana_invoke 按目标能力授权后直接派发，不再过一遍闸门
    recordRawHandler(server, cap.id, handler);
    // ② 只有平台入口会进面；具体能力仅登记原始 handler，供 hana_invoke 派发
    (register as (n: string, c: unknown, f: unknown) => unknown)(
      registeredNameOf(cap),
      registrationOf(cap, surface, ctx.manager?.multiEnv === true, ctx.config.toolSearchGoalEnabled !== false),
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
 * 给 handler 套上统一调用期闸门（平台入口注册路径使用）。
 * 具体能力的派发由 hana_invoke 里的 dispatchAuthorized 负责；两条路径共用同一判定壳。
 */
function gatedHandler<S extends z.ZodType>(
  ctx: ToolContext,
  cap: Capability<S>,
  handler: CapabilityHandler<S>,
): (args: Record<string, unknown>, extra: unknown) => unknown {
  return (args, extra) => {
    const identity = currentIdentity();
    // 授权 → 执行 → 写能力终态审计：三个动作收在 dispatchAuthorized 一处，
    // 平台入口调用与 hana_invoke 派发共用同一个壳。
    const run = (): unknown =>
      dispatchAuthorized(
        cap,
        args,
        {
          policy: policyFromConfig(ctx.config, toolFilterOf(ctx.config, ctx.toolFilter)),
          profile: activeProfile(ctx.config, identity),
          agentLabel: ctx.config.agentLabel,
          policyRevExtras: {
            readonlySql: ctx.config.readonlySql ?? 'select-only',
            approvalPolicy: ctx.config.approvalPolicy,
          },
        },
        () => (handler as (a: unknown, e: unknown) => unknown)(args, extra),
        (auth) => blockedCallResult(auth) as never,
        () => approvalGate(cap, args, ctx.config.approvalPolicy, extra as ServerContext, identity?.clientId),
      );
    // 多环境：入口取一次 runtime 并绑定到本次调用（含异步续体）。捕获发生在任何 await 之前，
    // 因此之后切换 active 不会影响这次调用；policyFromConfig(ctx.config) 也读绑定值。
    const manager = ctx.manager;
    // HTTP 请求入口可能已按 Token 绑定 runtime；有绑定就用它，stdio/未绑定才用进程 active。
    const runtime = manager ? (currentEnvironmentRuntime() ?? manager.current()) : undefined;
    const profile = activeProfile(ctx.config, identity);
    const execution = createExecutionContext({
      ...(identity ? { identity } : {}),
      ...(runtime ? { runtime } : {}),
      policyRev: policyRevOf(ctx.config, ctx.toolFilter, profile, runtime),
      manifestRev: manifestRev(),
    });
    const invoke = (): unknown => {
      if (!manager || !runtime) return run();
      runtime.callRefs += 1;
      manager.beginCall();
      return runWithEnvironment(runtime, async () => {
        try {
          return await run();
        } finally {
          runtime.callRefs = Math.max(0, runtime.callRefs - 1);
          manager.endCall();
          // 切走后进入 task-draining 的环境：最后一个在途调用结束（且无任务）时回 idle/关空闲池。
          reclaimDrainingEnvironment(runtime);
        }
      });
    };
    return runWithExecutionContext(execution, invoke);
  };
}

/**
 * 启动时打印工具可见性摘要（仅配置了过滤变量时输出），便于排查「为何某工具没注册」。
 * 操作级别名不是工具，不列入。
 */
export function logToolFilterSummary(filter: ToolFilterConfig, envKey?: string): void {
  const prefix = envKey ? `[${envKey}] ` : '';
  // sql 组是**默认关闭**的独立分组：空配置不等于“全部启用”。只在既未启用、也未被显式 deny 时
  // 提示一次（启动期唯一一次；指数级 HTTP 每请求构建不会再刷）。
  const sqlEnabled = filter.enabledGroups.has('sql') || matchGlob('hana_sql_execute', filter.allowPatterns);
  const sqlDenied = matchGlob('hana_sql_execute', filter.denyPatterns);
  if (!sqlEnabled && !sqlDenied) {
    logger.info(
      `${prefix}sql 组默认关闭：hana_sql_execute 不可发现、不可执行（也不在 tools/list）；` +
        '需显式 HANA_TOOL_GROUPS=sql（或 hana_sql_execute）才启用',
    );
  }
  if (
    filter.enabledGroups.size === 0 &&
    filter.allowPatterns.length === 0 &&
    filter.denyPatterns.length === 0 &&
    filter.groupsExplicit !== true
  ) {
    return; // 全空 = 不过滤 read/write/admin（sql 除外），不打扰日志
  }
  // 空配置下 read/write/admin 默认启用，sql 默认关闭——摘要如实反映，不写成“全部启用”
  const groupSummary = Array.from(ALL_TOOL_GROUPS)
    .map((g) => {
      const on =
        filter.enabledGroups.size === 0 ? filter.groupsExplicit !== true && g !== 'sql' : filter.enabledGroups.has(g);
      return `${g}${on ? '✓' : '✗'}`;
    })
    .join(' ');
  logger.info(
    {
      ...(envKey ? { envKey } : {}),
      enabledGroups: groupSummary,
      allow: filter.allowPatterns,
      deny: filter.denyPatterns,
    },
    `${prefix}工具可见性过滤已启用（HANA_TOOL_GROUPS/HANA_TOOL_DENY）`,
  );
  // 拼错的分组/能力名不会阻断启动：这里显式提示「未命中任何已登记能力」的 token。
  const unmatched = filter.allowPatterns.filter((p) => !CAPABILITY_LIST.some((c) => matchGlob(c.id, [p])));
  if (unmatched.length > 0) {
    logger.warn(
      { ...(envKey ? { envKey } : {}), unmatched },
      `${prefix}HANA_TOOL_GROUPS 中这些 token 未命中任何已登记能力（拼写错误或已改名？）`,
    );
  }
  // 列出被关闭的能力名（帮助确认配置符合预期：它们在发现/执行两层都不可达）
  const allNames = CAPABILITY_LIST.filter((c) => c.routeOnly !== true && c.platform !== true).map((c) => c.id);
  const disabled = allNames.filter((name) => !shouldRegisterTool(name, filter));
  if (disabled.length > 0) {
    logger.info(
      { ...(envKey ? { envKey } : {}), disabledCount: disabled.length, disabled: disabled.join(', ') },
      `${prefix}以下能力被配置关闭（不可发现、不可执行）`,
    );
  }
}

/**
 * 注册全部工具。工具面 = 两个平台入口（见 surface.ts）；具体能力只登记 handler，
 * 供 `hana_invoke` 在内层按目标能力授权后派发。零可见时什么都不注册。
 * 实测（SDK 2.3.1）：零注册时服务端不声明 tools，客户端 tools/list 得到 -32601，
 * 由下方 warn 与 npm run preflight 兜底。
 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  // 面算一次、贯穿本次构建
  const effective = surfaceOf(ctx);
  // 两个平台入口最先注册（选择 → 执行）；其余模块只登记原始 handler。
  registerToolSearchTools(server, ctx);
  registerInvokeTools(server, ctx);
  registerSystemTools(server, ctx);
  // 环境管理紧随 system：多环境才让 hana_env_list / hana_env_switch 可达（均经本体层选择）
  registerEnvironmentTools(server, ctx);
  registerPackageTools(server, ctx);
  registerMetadataTools(server, ctx);
  registerPreviewTools(server, ctx);
  registerModelingTools(server, ctx);
  // 异步任务工具紧随建模模块：注册顺序必须与清单顺序一致（顺序断言会核对）。
  registerTaskTools(server, ctx);
  registerSqlAnalyzeTools(server, ctx);
  // SQL 直接执行紧随 SQL 分析（清单顺序：sqlAnalyzeCapabilities → sqlExecuteCapabilities → health）
  registerSqlExecuteTools(server, ctx);
  registerHealthTools(server, ctx);

  // 零工具只可能来自显式 deny 掉全部能力（误配）：SDK 不声明 tools，客户端表现为协议层 -32601。
  // 不用占位工具顶住——占位是假能力，会在清单/分组/快照里处处需要例外。
  const anyVisible = effective.surfaceIds.size > 0;
  if (!anyVisible) {
    logger.warn(
      '当前配置未启用任何工具：SDK 不会声明 tools 能力，客户端调 tools/list 将得到 -32601。' +
        '请检查 HANA_TOOL_GROUPS/HANA_TOOL_DENY（空=read/write/admin 启用，sql 默认关闭）。',
    );
  }
}
