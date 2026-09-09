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
import { registerSystemTools } from './system.tools.js';
import { registerPackageTools } from './package.tools.js';
import { registerMetadataTools } from './metadata.tools.js';
import { registerPreviewTools } from './preview.tools.js';
import { registerModelingTools } from './modeling.tools.js';
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

/** 注册全部工具
 *  工具可见性由 ctx.toolFilter（来自 HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY）控制，
 *  各 register* 模块经 registerVisibleTool(server, ctx) 包裹后在注册前过滤。
 *  过滤后零工具可见时强制注册一个占位工具，确保 SDK 声明 tools 能力、tools/list 可达。 */
export function registerAllTools(server: McpServer, ctx: ToolContext): void {
  registerSystemTools(server, ctx);
  registerPackageTools(server, ctx);
  registerMetadataTools(server, ctx);
  registerPreviewTools(server, ctx);
  registerModelingTools(server, ctx);

  // 过滤后零工具可见时注册一个占位只读工具，避免 SDK 不声明 tools 能力导致 tools/list 返回 method not found。
  // 仅在配置了过滤变量时可能出现（全空默认=全部注册，至少 23 个）。
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
