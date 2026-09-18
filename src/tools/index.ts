import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import {
  parseToolFilter,
  shouldRegisterTool,
  type ToolFilterConfig,
  type ToolGroup,
  GROUP_LABELS,
  ALL_TOOL_GROUPS,
  TOOL_GROUPS,
} from './groups.js';
import { logger } from '../core/logger.js';
import { mcpErrorText } from '../core/errors.js';
import { currentClientId } from '../core/request-context.js';
import { runPreflight, policyFromConfig } from '../config/preflight.js';
import { formatWritePlan, planToRequest } from '../write-plan.js';
import { planWrite } from './write-plans.js';
import { registerSystemTools } from './system.tools.js';
import { registerPackageTools } from './package.tools.js';
import { registerMetadataTools } from './metadata.tools.js';
import { registerPreviewTools } from './preview.tools.js';
import { registerModelingTools } from './modeling.tools.js';
import { registerSqlAnalyzeTools } from './sql-analyze.tools.js';
import type { HanaPool } from '../core/hana-client.js';
import type { HanaConfig } from '../config/config.js';

export interface ToolContext {
  /** HANA 连接池（懒连接，工具经池访问 HANA） */
  pool: HanaPool;
  /** 已校验配置（含脱敏后摘要供 ping 类工具展示） */
  config: HanaConfig;
  /**
   * 工具可见性过滤配置（由 mcp.json 的 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY 解析而来）。
   * 各 register* 工具模块经 registerVisibleTool(server, ctx) 包裹后决定是否调用 server.registerTool；
   * 未注册的工具不出现在 tools/list、不可被调用。全空配置=不过滤（全部注册，向后兼容）。
   */
  toolFilter: ToolFilterConfig;
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
 */
export function registerVisibleTool(server: McpServer, ctx: ToolContext): McpServer['registerTool'] {
  const filter = ctx.toolFilter;
  // 仅读 filter，不捕获 server/config 以外状态
  return ((name: string, config: unknown, cb: unknown) => {
    if (!shouldRegisterTool(name, filter)) return;
    // 转发到真实 registerTool（类型由外层 cast 保证）
    return (server.registerTool as (n: string, c: unknown, f: unknown) => unknown)(name, config, cb);
  }) as McpServer['registerTool'];
}

/**
 * 返回一个**写工具**注册器：在 handler 之前插入预检闸门（执行前校验）。
 *
 * 为什么需要它：写边界原本只在 service 层（repository.service 的 assertWritePackageAllowed）拦，
 * 也就是说请求**已经进入代码处理**才被拒。而预检层（config/preflight.ts）此前只服务
 * 启动自检与 CLI，在运行路径上从未被调用——等于「闸门在旁路」。
 * 本包装器把预检层放到 handler 之前：不通过就直接返回硬错误，**根本不进 handler 与 service**。
 *
 * service 层的 assert 保留为纵深防御（脚本/内部调用不经过工具层），并改为复用
 * write-boundary 的共享判定规则，避免出现第二套包名比较实现。
 *
 * 判定来源用 ctx.config / ctx.toolFilter（服务已加载并校验过的配置），
 * 不重新解析 env——避免请求路径上出现「判定用的值 ≠ 运行用的值」。
 */
export function registerWriteTool(server: McpServer, ctx: ToolContext): McpServer['registerTool'] {
  const reg = registerVisibleTool(server, ctx);
  return ((name: string, config: unknown, cb: unknown) => {
    const guarded = (args: Record<string, unknown>, extra: unknown) => {
      const blocked = preflightWriteCall(name, args, ctx);
      if (blocked) return blocked;
      // 转发给真实 handler（类型由外层 cast 保证）
      return (cb as (a: unknown, e: unknown) => unknown)(args, extra);
    };
    // 转发到可见性注册器（类型由外层 cast 保证，与 registerVisibleTool 内部同一手法）
    return (reg as (n: string, c: unknown, f: unknown) => unknown)(name, config, guarded);
  }) as McpServer['registerTool'];
}

/**
 * 写调用预检：先规划（这次调用会读写什么），再判定（对照生效策略），
 * 通过返回 undefined，不通过返回 MCP 硬错误（handler 直接 return，不进 service）。
 *
 * 策略来自**服务已加载的 config**（不重新解析 env——见 policyFromConfig 的说明）。
 * 规划的只读分析不产生副作用；判定规则全部来自策略层，此处不另写一套。
 */
function preflightWriteCall(
  toolName: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): ReturnType<typeof mcpErrorText> | undefined {
  const plan = planWrite(toolName, args);
  const verdict = runPreflight({
    source: { kind: 'resolved', policy: policyFromConfig(ctx.config, ctx.toolFilter) },
    request: planToRequest(plan),
  });
  if (verdict.allowed) return undefined;
  logger.warn(
    {
      tool: toolName,
      clientId: currentClientId(),
      writePackages: plan.writePackages,
      readSchemas: plan.readSchemas,
      blocked: verdict.blocking.map((g) => g.code),
    },
    '写操作预检未通过：已在 handler 之前拦截（请求未执行）',
  );
  return mcpErrorText(
    `被 MCP 安全策略拦截（${verdict.blocking.map((g) => g.code).join(', ')}），请求未执行`,
    // 先给"本来会发生什么"，再给"为什么被拦"——但**不给**绕过方法：
    // 拦截消息是返回给调用方（通常是模型）的，写明"改哪项配置可放行"等于把绕过方法交给被拦的一方。
    // 补救指引只出现在面向运维的位置（服务启动自检、README）。
    `${formatWritePlan(plan)}\n\n${verdict.text}\n\n该限制由 MCP 服务端的权限策略施加，调用方无法自行解除。`,
  );
}

/**
 * 启动时打印工具可见性摘要（不泄露敏感信息）。
 * 仅在配置了过滤变量时输出，便于排查「为何某工具没注册」。
 * 若过滤后零工具可见，额外输出 warn（提示配置可能误关了全部工具）。
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
  const allNames = Object.keys(TOOL_GROUPS);
  const disabled = allNames.filter((name) => !shouldRegisterTool(name, filter));
  if (disabled.length > 0) {
    logger.info(
      { disabledCount: disabled.length, disabled: disabled.join(', ') },
      '以下工具被配置关闭（不出现在 tools/list）',
    );
  }
  // 过滤后零工具可见：提示配置可能误关了全部工具（服务会启动但不暴露 tools 能力）
  const visibleCount = allNames.length - disabled.length;
  if (visibleCount === 0) {
    logger.warn(
      { enabledGroups: groupSummary, allow: filter.allowPatterns, deny: filter.denyPatterns },
      '当前配置导致没有任何工具被注册——MCP 客户端将看不到任何工具（tools/list 不被服务端声明）。'
        + '若非预期，请检查 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY 配置。',
    );
  }
}

/**
 * 注册全部工具
 *  工具可见性由 ctx.toolFilter（来自 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY）控制，
 *  各 register* 模块经 registerVisibleTool(server, ctx) 包裹后在注册前过滤。
 *  过滤后零工具可见时强制注册一个占位工具，确保 SDK 声明 tools 能力、tools/list 可达。 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerSystemTools(server, ctx);
  registerPackageTools(server, ctx);
  registerMetadataTools(server, ctx);
  registerPreviewTools(server, ctx);
  registerModelingTools(server, ctx);
  registerSqlAnalyzeTools(server, ctx);

  // 过滤后零工具可见时注册一个占位只读工具，避免 SDK 不声明 tools 能力导致 tools/list 返回 method not found。
  // 仅在配置了过滤变量时可能出现（全空默认=全部注册，至少 24 个）。
  const filter = ctx.toolFilter;
  const anyVisible = Object.keys(TOOL_GROUPS).some((name) => shouldRegisterTool(name, filter));
  if (!anyVisible) {
    server.registerTool(
      'hana_no_tools_available',
      {
        title: '无可用工具',
        description:
          '当前 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY 配置导致没有任何业务工具被启用。' +
          '这是一个占位工具，用于保持 tools/list 可达。请调整可见性配置后重启服务。',
        inputSchema: z.object({}),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async () => ({
        isError: true,
        content: [
          {
            type: 'text',
            text: '当前配置未启用任何工具。请检查 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY（空=全部启用）。',
          },
        ],
      }),
    );
    logger.warn(
      '已注册占位工具 hana_no_tools_available：当前配置未启用任何业务工具。',
    );
  }
}

/** 导出分组元信息供文档/测试/外部使用 */
export { type ToolGroup, GROUP_LABELS, ALL_TOOL_GROUPS, TOOL_GROUPS, shouldRegisterTool };
