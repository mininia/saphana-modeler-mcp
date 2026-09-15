import { createHash, timingSafeEqual } from 'node:crypto';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { hostHeaderValidation, originValidation, toNodeHandler } from '@modelcontextprotocol/node';
import { createMcpHandler, type AuthInfo } from '@modelcontextprotocol/server';
import type { HanaConfig, HttpClientIdentity } from './config/config.js';
import { isLoopbackHost } from './config/deployment.js';
import { logger } from './core/logger.js';
import { runWithIdentity } from './core/request-context.js';
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
 *
 * 会话与身份：本服务**无会话**（每次请求新建 server、无 Mcp-Session-Id、无 per-session 状态），
 * 因此不存在跨会话串扰；客户端身份经 Token → 身份映射（MCP_HTTP_TOKENS）解析后写入
 * AsyncLocalStorage 请求上下文，供工具层/envelope/审计日志归因（stdio 模式无此上下文）。
 */

/** MCP 端点唯一路径（忽略 querystring；其余路径一律 404，缩小暴露面） */
const MCP_HTTP_PATH = '/mcp';

/** 请求体上限：Content-Length 超限直接 413（防暴露场景下大 body 打满内存） */
const MCP_HTTP_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** 未配置任何 Token（回环默认边界）时的客户端身份名 */
const ANONYMOUS_CLIENT_ID = 'anonymous';

/** 请求守卫：返回 false 表示已自行应答（403/404/401/413），调用方不得再处理该请求 */
type RequestGuard = (req: IncomingMessage, res: ServerResponse) => boolean;

/** 携带身份信息的请求（toNodeHandler 会将 req.auth 透传为 handler 的 authInfo，故按 SDK 约定挂载） */
type AuthedRequest = IncomingMessage & { auth?: AuthInfo };

/** 仅放行 MCP_HTTP_PATH（忽略 querystring） */
const pathGuard: RequestGuard = (req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === MCP_HTTP_PATH) return true;
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: `not found; the MCP endpoint is ${MCP_HTTP_PATH}` }));
  return false;
};

/**
 * Bearer Token 校验（可选）：未配置任何 Token 时恒放行（回环默认边界）；配置后强制校验。
 * 命中的身份写入 req.auth —— SDK 约定位置（toNodeHandler 会把 req.auth 透传为 handler 的
 * authInfo），请求入口据此进入身份上下文，使工具层/日志/envelope 可归因到具体客户端。
 */
const bearerTokenGuard = (clients: HttpClientIdentity[]): RequestGuard => {
  if (clients.length === 0) return () => true;
  // sha256 摘要定长后 timingSafeEqual，防时序侧信道；摘要不回泄 token；token 原文不驻留在比对结构中
  const digests = clients.map((c) => ({
    clientId: c.clientId,
    digest: createHash('sha256').update(c.token).digest(),
  }));
  return (req, res) => {
    const header = req.headers.authorization;
    const provided =
      typeof header === 'string' && /^Bearer /i.test(header) ? header.slice('Bearer '.length).trim() : '';
    const providedDigest = createHash('sha256').update(provided).digest();
    let matched: string | undefined;
    // 不提前 break：比较次数与配置条目数一致，不泄露「命中的是第几个身份」
    for (const c of digests) {
      if (timingSafeEqual(c.digest, providedDigest)) matched = c.clientId;
    }
    if (matched !== undefined) {
      // 凭据不回存：token 字段填掩码（本进程此后不再需要原文，避免经 authInfo 流入日志/错误/下游）
      (req as AuthedRequest).auth = {
        token: '****',
        clientId: matched,
        scopes: [],
        extra: { transport: 'http' },
      };
      return true;
    }
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
  const validateToken = bearerTokenGuard(config.httpTokens);

  const server = createHttpServer((req, res) => {
    // 守卫链：路径 → Host → Origin → Token → 请求体上限；任一不过即终止（guard 已自行应答）
    if (!pathGuard(req, res)) return;
    if (!validateHost(req, res)) return;
    if (!validateOrigin(req, res)) return;
    if (!validateToken(req, res)) return;
    if (!bodySizeGuard(req, res)) return;
    // 身份上下文：贯穿本次请求的全部异步续体（工具层/服务层/审计日志/envelope 均据此归因）
    const clientId = (req as AuthedRequest).auth?.clientId ?? ANONYMOUS_CLIENT_ID;
    logger.debug({ clientId }, 'saphana-modeler-mcp HTTP 请求已归属客户端身份');
    void runWithIdentity({ clientId, transport: 'http' }, () => nodeHandler(req, res));
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

  if (config.httpTokens.length > 0) {
    logger.info(
      { clientIds: config.httpTokens.map((c) => c.clientId) },
      'saphana-modeler-mcp HTTP 已启用 Bearer Token 校验（每个 Token 映射到独立客户端身份）',
    );
  } else if (!isLoopbackHost(config.httpHost.trim())) {
    // 走到这里说明已显式设置了 MCP_HTTP_ALLOW_ANONYMOUS=true（否则启动自检已拒绝启动）。
    // 仍然每次启动都提醒：这是被显式承认的风险，不是被忽略的风险。
    logger.warn(
      'saphana-modeler-mcp HTTP 对外监听且未设置 MCP_HTTP_TOKEN / MCP_HTTP_TOKENS' +
        '（已由 MCP_HTTP_ALLOW_ANONYMOUS 显式放行）：任何可达者均可调用全部工具（含写操作），' +
        '且所有调用都归为身份 anonymous、无法归因。请确认前置的反向代理/防火墙已完成认证',
    );
  }

  const close = async (): Promise<void> => {
    await handler.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { port, close };
}
