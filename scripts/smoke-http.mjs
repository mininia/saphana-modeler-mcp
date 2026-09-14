/**
 * Streamable HTTP 冒烟测试：真实启动 dist/index.js（MCP_HTTP_PORT=0 随机端口），
 * 走完整 MCP streamable HTTP 握手（initialize → notifications/initialized → tools/list），
 * 并验证安全守卫链：Bearer Token（缺失/错误 → 401）、伪造 Host（→ 403）、
 * 非 /mcp 路径（→ 404）、超限 Content-Length（→ 413）、无状态回退（GET /mcp → 405）。
 *
 * 不调用任何工具（工具全部触数据库），注入 dummy 配置仅用于通过 config 校验；
 * 实机验收脚本在本地 test-verification/（不入库）。
 *
 * 用法：node scripts/smoke-http.mjs（package.json 的 smoke:http 脚本已含 build）
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import http from 'node:http';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

// 测试专用 dummy token（长度须满足 config 校验 ≥16 字符；非真实凭据）
const TOKEN = 'smoke-http-dummy-token-0123456789';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  // stderr 需捕获以从 pino 就绪日志解析实际端口（MCP_HTTP_PORT=0 随机端口），同时回显便于排障
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    // dummy 配置：仅用于让 config 校验通过，本脚本不调用任何触库工具
    HANA_HOST: 'dummy.local',
    HANA_INSTANCE: '00',
    HANA_PORT: '',
    HANA_USER: 'dummy',
    HANA_PASSWORD: 'dummy',
    HANA_LOCALE: 'zh_CN',
    HANA_TLS: 'false',
    HANA_TIMEZONE: 'Asia/Shanghai',
    MCP_HTTP_PORT: '0',
    MCP_HTTP_TOKEN: TOKEN,
  },
});

let port;
const stderrRl = createInterface({ input: child.stderr });
stderrRl.on('line', (line) => {
  console.error(line);
  try {
    const j = JSON.parse(line);
    if (typeof j.httpPort === 'number' && j.httpPort > 0) port = j.httpPort;
  } catch {
    /* 非 JSON 行（tsx 转译等）忽略 */
  }
});

const timeout = setTimeout(() => {
  console.error('冒烟测试超时（60s）');
  child.kill();
  process.exit(1);
}, 60_000);

/** 等待就绪日志给出端口（最多 15s） */
async function waitPort() {
  for (let i = 0; i < 150 && port == null; i++) {
    if (child.exitCode != null) throw new Error(`服务进程提前退出（code=${child.exitCode}）`);
    await new Promise((r) => setTimeout(r, 100));
  }
  if (port == null) throw new Error('未从就绪日志解析到端口（httpPort 字段缺失）');
  return port;
}

let nextId = 1;

/** 解析响应体：application/json 直接 parse；SSE 流取含 id 的最后一条 data 事件 */
async function readMessage(res) {
  const text = await res.text();
  const ct = res.headers.get('content-type') ?? '';
  if (ct.includes('text/event-stream')) {
    const msgs = text
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => {
        try {
          return JSON.parse(l.slice(5).trim());
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return msgs.reverse().find((m) => m.id != null) ?? msgs[msgs.length - 1];
  }
  return JSON.parse(text);
}

/** POST /mcp JSON-RPC；authorization 传 null 时不带 Authorization 头（测 401） */
async function rpc(method, params, { authorization = `Bearer ${TOKEN}` } = {}) {
  const headers = {
    'content-type': 'application/json',
    // Streamable HTTP 规范要求 accept 同时声明 JSON 与 SSE
    accept: 'application/json, text/event-stream',
  };
  if (authorization != null) headers.authorization = authorization;
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id: nextId++, method, params }),
  });
  const msg = await readMessage(res);
  return { status: res.status, msg, result: msg?.result };
}

/** 伪造 Host 头请求（node:http 才能覆盖 Host；undici fetch 会以 URL 为准） */
function rpcWithHost(host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/mcp', method: 'POST', headers: { host, 'content-type': 'application/json' } },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify({ jsonrpc: '2.0', id: nextId++, method: 'tools/list' }));
  });
}

/** 声明超限 Content-Length（实际只发极短 body）：服务端在守卫层即应 413 */
function rpcWithDeclaredLength(contentLength) {
  return new Promise((resolve) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method: 'POST',
        headers: {
          host: '127.0.0.1',
          authorization: `Bearer ${TOKEN}`,
          'content-type': 'application/json',
          'content-length': String(contentLength),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      },
    );
    // 413 后服务器可能不等 body 直接复位连接，客户端侧错误不影响判定
    req.on('error', () => {});
    req.end('{}');
  });
}

try {
  await waitPort();
  console.log('[listen] 127.0.0.1:' + port + '/mcp（MCP_HTTP_PORT=0 随机端口，Token 已启用）');

  // 守卫链先行：缺 Token / 错 Token / 错路径 / 伪造 Host / 超限 body
  const noAuth = await rpc('tools/list', undefined, { authorization: null });
  console.log('[auth-guard] 缺 Token → HTTP', noAuth.status);
  if (noAuth.status !== 401) throw new Error(`缺 Token 期望 401，实际 ${noAuth.status}`);
  const badAuth = await rpc('tools/list', undefined, { authorization: 'Bearer wrong-token-wrong-token' });
  console.log('[auth-guard] 错 Token → HTTP', badAuth.status);
  if (badAuth.status !== 401) throw new Error(`错 Token 期望 401，实际 ${badAuth.status}`);
  const notFound = await fetch(`http://127.0.0.1:${port}/other`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  console.log('[path-guard] 非 /mcp 路径 → HTTP', notFound.status);
  if (notFound.status !== 404) throw new Error(`非 /mcp 路径期望 404，实际 ${notFound.status}`);
  const evilStatus = await rpcWithHost('evil.example');
  console.log('[host-guard] 伪造 Host → HTTP', evilStatus);
  if (evilStatus !== 403) throw new Error(`伪造 Host 期望 403，实际 ${evilStatus}`);
  const tooLarge = await rpcWithDeclaredLength(10 * 1024 * 1024 + 1);
  console.log('[size-guard] 超限 Content-Length → HTTP', tooLarge);
  if (tooLarge !== 413) throw new Error(`超限 body 期望 413，实际 ${tooLarge}`);

  // 正常握手（带正确 Token）
  const init = await rpc('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smoke-http', version: '0.0.1' },
  });
  if (init.status !== 200) throw new Error(`initialize 期望 200，实际 ${init.status}`);
  console.log('[handshake] negotiated protocol:', init.result?.protocolVersion);
  if (!init.result?.serverInfo?.name) throw new Error('initialize 未返回 serverInfo');

  // notifications/initialized（无 id 通知；stateless 模式无会话头需要回传）
  const notified = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
  });
  console.log('[initialized] HTTP', notified.status);

  const { result: tools } = await rpc('tools/list');
  const names = tools.tools.map((t) => t.name);
  console.log('[tools/list]', names.length, '个工具');
  const missing = ['hana_system_get_info', 'hana_metadata_where_used', 'hana_data_preview'].filter(
    (n) => !names.includes(n),
  );
  if (missing.length > 0) throw new Error(`工具未注册: ${missing.join(', ')}`);
  const sampleTool = tools.tools.find((t) => t.name === 'hana_metadata_get_field_logic');
  if (!sampleTool?.annotations?.readOnlyHint) throw new Error('annotations 未按约定透出（readOnlyHint 缺失）');
  console.log('[annotations]', JSON.stringify(sampleTool.annotations));

  // 无状态服务：GET /mcp（2025-era 会话操作）应 405（软校验，仅提示）
  const getStatus = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.status);
  console.log('[stateless] GET /mcp → HTTP', getStatus, getStatus === 405 ? '（无状态回退符合预期）' : '');

  console.log('[smoke:http] PASS');
} catch (e) {
  console.error('[smoke:http] FAIL:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill();
}
