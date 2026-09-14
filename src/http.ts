import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler } from '@modelcontextprotocol/server';
import type { HanaConfig } from './config/config.js';
import { logger } from './core/logger.js';
import { createServer } from './server.js';
import type { ToolContext } from './tools/index.js';

/**
 * Streamable HTTP 传输（MCP 官方 Streamable HTTP 规范，端点 /mcp）：
 * - createMcpHandler 按请求经工厂新建 McpServer（无状态服务；2025-era 流量内置 stateless 回退，
 *   新旧协议版本客户端均可接入）；连接池经 ToolContext 共享，懒连接不随会话重建
 * - toNodeHandler 把 fetch 形态 handler 适配到 node:http
 * - 守卫链挂在 handler 之前（路径 → Host → Origin → Bearer Token → 请求体上限）；
 *   Host/Origin 为 DNS rebinding 防护（SDK 官方建议位置），Token 为暴露网络时的最低认证
 * - 默认仅绑定 127.0.0.1（fail-closed）；对外暴露需显式 MCP_HTTP_HOST=0.0.0.0
 *   并同步放行 MCP_HTTP_ALLOWED_HOSTS / MCP_HTTP_ALLOWED_ORIGINS（强烈建议同时配 MCP_HTTP_TOKEN）
 */

/** MCP 端点唯一路径（忽略 querystring；其余路径一律 404，缩小暴露面） */
const MCP_HTTP_PATH = '/mcp';

/** 请求体上限：Content-Length 超限直接 413（防暴露场景下大 body 打满内存） */
const MCP_HTTP_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** 请求守卫：返回 false 表示已自行应答（403/404/401/413），调用方不得再处理该请求 */
type RequestGuard = (req: IncomingMessage, res: ServerResponse) => boolean;

/** 仅放行 MCP_HTTP_PATH（忽略 querystring） */
const pathGuard: RequestGuard = (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === MCP_HTTP_PATH) return true;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `not found; the MCP endpoint is ${MCP_HTTP_PATH}` }));
  return false;
};

/** Bearer Token 校验（可选）：未配置 token 时恒放行（回环默认边界）；配置后强制校验 */
const bearerTokenGuard = (expected: string | undefined): RequestGuard => {
  if (!expected) return () => true;
  // sha256 摘要定长后 timingSafeEqual，防时序侧信道；摘要不回泄 token
  const expectedDigest = createHash('sha256').update(expected).digest();
  return (req, res) => {
    const header = req.headers.authorization;
    const provided =
      typeof header === 'string' && /^Bearer /i.test(header) ? header.slice('Bearer '.length).trim() : '';
    const providedDigest = createHash('sha256').update(provided).digest();
    if (timingSafeEqual(expectedDigest, providedDigest)) return true;
    // 安全要求：不记录/不回显 Authorization 头内容
    logger.warn('saphana-modeler-mcp HTTP 401（Bearer Token 缺失或不匹配）');
    res.writeHead(401, {
      'content-type': 'application/json',
      'www-authenticate': 'Bearer realm="mcp"',
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Unauthorized: missing or invalid bearer token' },
      }),
    );
    return false;
  };
};

/** Content-Length 超限拒绝（413）；流式（chunked）请求无该头，交由代理层限长（README 已注明） */
const bodySizeGuard: RequestGuard = (req, res) => {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (!Number.isFinite(declared) || declared <= MCP_HTTP_MAX_BODY_BYTES) return true;
  res.writeHead(413, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: 'payload too large' }));
  return false;
};

/** 回环地址判定（用于"对外监听但无 Token"的启动告警） */
const isLoopbackHost = (host: string): boolean => ['127.0.0.1', '::1', 'localhost'].includes(host);

/**
 * 启动 HTTP 监听。resolve 于 listen 成功后，携带实际端口（配置 0 = 随机端口，如冒烟测试）。
 * close() 供进程退出时收尾：先停新请求，再关闭 handler（中止在途请求）。
 */
export async function startHttpServer(
  ctx: ToolContext,
  config: HanaConfig,
): Promise<{ port: number; close: () => Promise<void> }> {
  const handler = createMcpHandler(() => createServer(ctx), {
    onerror: (e) => logger.error({ err: e }, 'saphana-modeler-mcp HTTP handler 内部错误'),
  });
  const nodeHandler = toNodeHandler(handler, {
    onerror: (e) => logger.error({ err: e }, 'saphana-modeler-mcp HTTP 适配层错误'),
  });
  const validateHost = hostHeaderValidation(config.httpAllowedHosts);
  const validateOrigin = originValidation(config.httpAllowedOrigins);
  const validateToken = bearerTokenGuard(config.httpToken);

  const server = createHttpServer((req, res) => {
    // 守卫链：路径 → Host → Origin → Token → 请求体上限；任一不过即终止（guard 已自行应答）
    if (!pathGuard(req, res)) return;
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    if (!validateToken(req, res)) return;
    if (!bodySizeGuard(req, res)) return;
    void nodeHandler(req, res);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 调用方已在 httpPort 非空分支内；?? 0 仅为类型兜底（0 = 随机端口）
    server.listen(config.httpPort ?? 0, config.httpHost, () => resolve());
  });
  // listen 成功后移除 reject 监听，改挂运行期错误日志（避免 unhandled 'error' 事件直接崩进程）
  server.removeAllListeners('error');
  server.on('error', (e) => logger.error({ err: e }, 'saphana-modeler-mcp HTTP server 错误'));

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : (config.httpPort ?? 0);

  if (config.httpToken) {
    logger.info('saphana-modeler-mcp HTTP 已启用 Bearer Token 校验（MCP_HTTP_TOKEN）');
  } else if (!isLoopbackHost(config.httpHost.trim())) {
    logger.warn(
      'saphana-modeler-mcp HTTP 对外监听但未设置 MCP_HTTP_TOKEN：任何可达者均可调用全部工具（含写操作），建议配置 Token 或置于反向代理/防火墙之后',
    );
  }

  const close = async (): Promise<void> => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port, close };
}
