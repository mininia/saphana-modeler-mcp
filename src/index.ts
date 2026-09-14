#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { loadConfig } from './config/config.js';
import { HanaPool } from './core/hana-client.js';
import { logger } from './core/logger.js';
import { checkNodeVersion } from './core/node-version.js';
import { configureExtraSchemas } from './core/sql.js';
import { configureWritePackages } from './services/repository.service.js';
import { buildToolFilter, logToolFilterSummary, type ToolContext } from './tools/index.js';
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
  // 接线 schema 白名单扩展（HANA_SCHEMA_ALLOW），使配置项真正生效
  configureExtraSchemas(config.schemaAllow);
  // 接线写操作包白名单（HANA_WRITE_PACKAGES）：空=不限制；非空=仅配置包及其子包可写
  configureWritePackages(config.writePackages);
  // 解析工具可见性过滤（HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY）；无效分组名在此抛错
  const toolFilter = buildToolFilter(config);
  // 安全要求：连接信息/用户名/密码不得以任何形式出现，不落日志
  logger.info('saphana-modeler-mcp 配置加载完成（连接信息与凭据不落日志）');
  // 一次性启动摘要：stdio 构建一次即用；HTTP 模式 server 按请求经工厂构建，摘要不能进工厂
  logToolFilterSummary(toolFilter);

  const pool = new HanaPool(config);
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
    const server = createServer(ctx);
    const transport = new StdioServerTransport();
    await server.connect(transport);
    logger.info('saphana-modeler-mcp 已就绪（stdio transport）');
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
