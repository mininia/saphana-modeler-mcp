#!/usr/bin/env node
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/config.js';
import { HanaPool } from './core/hana-client.js';
import { applyLoggerConfig, logger } from './core/logger.js';
import { checkNodeVersion } from './core/node-version.js';
import { setProcessAgentLabel } from './core/request-context.js';
import { configureExtraSchemas } from './core/sql.js';
import { configureWritePackages } from './services/repository.service.js';
import { buildToolFilter, logToolFilterSummary, type ToolContext } from './tools/index.js';
import { describePolicy, policyFromConfig } from './config/preflight.js';
import { describeProfiles } from './config/profiles.js';
import { startHttpServer } from './http.js';
import { createServer } from './server.js';

/** 入口：Node 版本校验 → 加载配置 → 构建连接池（懒连接，不阻塞启动）→ stdio / Streamable HTTP transport 启动 */
async function main(): Promise<void> {
  // 启动前置：Node 版本兼容校验（process.loadEnvFile 等特性依赖 >=20.12）
  const nodeVersion = checkNodeVersion();
  if (!nodeVersion.ok) {
    console.error(
      `[saphana-modeler-mcp] 不兼容的 Node 版本：需要 ${nodeVersion.required}，当前 ${nodeVersion.current}。请升级 Node.js 后重试`,
    );
    process.exit(1);
  }

  const config = loadConfig();
  // 日志配置换成**已校验**的取值（此前 logger 用 env 兜底：它必须早于配置可用）。
  // 级别与时区与其余模块同源读 config，避免 logger 直读 process.env 造成判定值 ≠ 运行值。
  applyLoggerConfig({ level: config.logLevel, timezone: config.timezone });
  // 连接目标/凭据跨来源混用（如 shell 残留 HANA_USER + .env 提供其余项）→ 可能连到另一套环境，必须显式告警。
  // 只输出「哪个变量来自哪里」，不含任何值（连接信息/账号名一律不落日志）。
  if (config.connectionSourceMixed) {
    logger.warn(
      { sources: config.connectionSources },
      '连接目标与凭据来自多个来源（进程环境变量与 .env 混用）：已存在的环境变量不会被 .env 覆盖，' +
        '请核对这些变量确实指向同一套环境（清掉多余的环境变量，或全部集中到三者之一）',
    );
  }
  // 接线 schema 白名单扩展（HANA_SCHEMA_ALLOW），使配置项真正生效
  configureExtraSchemas(config.schemaAllow);
  // 接线写操作包白名单（HANA_WRITE_PACKAGES）——两层口径（与 config/write-boundary.ts 头注一致）：
  // 服务层空白名单是 fail-open（isPackageAllowed 放行一切）；端到端不是「所有包可写」——写工具已暴露时，
  // 任何声明写包的调用都会被运行期闸门以 boundary_off 拒绝（等于写不可用）
  configureWritePackages(config.writePackages);
  // 进程级归因标签（MCP_AGENT_LABEL）：写进 envelope 与每条 capability-audit，未配置时不产生该字段
  setProcessAgentLabel(config.agentLabel);
  // 解析工具可见性过滤（MCP_TOOL_GROUPS/MCP_TOOL_ALLOW/MCP_TOOL_DENY，旧名 HANA_TOOL_* 仍生效）；无效分组名在此抛错
  const toolFilter = buildToolFilter(config);
  // 安全要求：连接信息/用户名/密码不得以任何形式出现，不落日志
  logger.info('saphana-modeler-mcp 配置加载完成（连接信息与凭据不落日志）');
  // 一次性启动摘要：stdio 构建一次即用；HTTP 模式 server 按请求经工厂构建，摘要不能进工厂
  logToolFilterSummary(toolFilter);
  // 调用方档案摘要（P10-c）：配了才打印；「档案 ⊆ 部署策略」的越界结论在下面的自检里（block 即拒绝启动）
  if (config.profiles.size > 0) {
    logger.info(
      { profiles: describeProfiles(config.profiles), processProfile: config.profileId },
      '调用方档案已启用（MCP_PROFILES/MCP_PROFILE）',
    );
  }
  // 权限策略自检（能力级 / 资源级 / 部署级一并打出，含来源归因）。
  // 阻断级结论（如对外监听且无任何认证）直接拒绝启动——那种姿态下能力级与资源级全部形同虚设。
  // 注意：必须用**已加载的 config** 构造策略，不可用 { kind: 'env' } 重新解析 ——
  // 那会在 loadConfig 删除 HANA_PASSWORD 之后再读一次 .env（重新写回凭据），并让判定值与运行值分叉。
  const verdict = describePolicy({ kind: 'resolved', policy: policyFromConfig(config, toolFilter) });
  if (verdict.blocking.length > 0) {
    throw new Error(
      `权限策略自检未通过（${verdict.blocking.map((g) => g.code).join(', ')}），拒绝启动：\n${verdict.text}`,
    );
  }
  if (verdict.warnings.length > 0) {
    logger.warn({ writePackages: verdict.policy.resource.writePackages }, verdict.text);
  } else {
    logger.info({ writePackages: verdict.policy.resource.writePackages }, verdict.text);
  }

  // 池与超时参数（HANA_POOL_*/HANA_SQL_TIMEOUT_MS，默认值见 core/limits.ts 单一事实源）。
  // 部署含义：max 是**每代理池大小**——N 个代理进程 = N×poolMax 条到 HANA 的连接，
  // 多进程部署时 HANA 侧连接数按进程数线性放大，调大前先核对 DB 侧连接预算。
  const pool = new HanaPool(config, {
    max: config.poolMax,
    maxWaiters: config.poolMaxWaiters,
    acquireTimeoutMs: config.poolWaitMs,
    statementTimeoutMs: config.sqlTimeoutMs,
  });
  const ctx: ToolContext = { pool, config, toolFilter };
  let httpClose: (() => Promise<void>) | undefined;

  if (config.httpPort != null) {
    // Streamable HTTP 模式（端点 /mcp；server 按请求经工厂构建，连接池共享）
    const { port, close } = await startHttpServer(ctx, config);
    httpClose = close;
    logger.info(
      { httpHost: config.httpHost, httpPort: port },
      'saphana-modeler-mcp 已就绪（streamable HTTP transport，端点 /mcp）',
    );
  } else {
    // stdio：交给 serveStdio 做 **era 判定**（D-9，SSD §2.1b）——同一条 stdin/stdout 上
    // 2025-11-25 老客户端与 modern（2026-07-28）客户端都能被服务：
    //   · 开场是 `initialize`（无 modern envelope claim）→ legacy 支路：行为与直连 StdioServerTransport 完全一致，
    //     `legacy: 'serve'` 默认值显式写出以固化"既有握手语义不变"（11 个实机脚本与 smoke 零回归的前提）；
    //   · 开场带 modern 声明（如 `server/discover`）→ modern 支路：SDK 在工厂产物上补装 modern-only handlers。
    // 工厂返回的实例被**钉住整个连接**；门面动态提升（capability.tools.ts）挂的正是这个实例——
    // 各工具的 handler 闭包里捕获的就是自己注册时的那个 server（见 createServer 的装配顺序）。
    // onerror 只做带外报告（绝不改变已写出的报文，SDK 原文）；用 logger 落一条告警便于排障。
    serveStdio(() => createServer(ctx), {
      legacy: 'serve',
      onerror: (error) => logger.warn({ err: error }, 'stdio 通道带外错误（不影响已写出的报文）'),
    });
    logger.info('saphana-modeler-mcp 已就绪（stdio transport：legacy 2025-11-25 + modern 2026-07-28）');
  }

  // 进程退出时关闭空闲连接与 HTTP handler（尽力而为；exit 回调不可 await）
  process.on('exit', () => {
    void pool.closeAll();
    void httpClose?.();
  });
}

main().catch((e) => {
  logger.fatal({ err: e }, 'saphana-modeler-mcp 启动失败');
  process.exit(1);
});
