/**
 * Streamable HTTP 冒烟测试：真实启动 dist/index.js（MCP_HTTP_PORT=0 随机端口），
 * 走完整 MCP streamable HTTP 握手（initialize → notifications/initialized → tools/list），
 * 并验证安全守卫链：Bearer Token（缺失/错误 → 401）、伪造 Host（→ 403）、
 * 非 /mcp 路径（→ 404）、超限 Content-Length（→ 413）、无状态回退（GET /mcp → 405）、
 * 多客户端 Token → 身份映射（不同 Token 归因到不同 clientId）、
 * **稳定注册面**（tools/list 恒为 hana_tool_search + hana_invoke，具体能力恒不注册）与 **本体层不越权**
 * （档案改的是可发现/可执行的能力，不是注册面；执行统一经 hana_invoke，写调用仍落回部署边界 boundary_off）。
 *
 * 不调用任何触库工具（dummy 配置仅用于通过 config 校验；被拦/被拒都发生在 handler 之前）；
 * 调用方 shell 的面/边界策略环境变量（HANA_TOOL_GROUPS 等三个过滤项与旧名 HANA_TOOL_ 系列、
 * HANA_WRITE_PACKAGES、MCP_HTTP_ALLOWED_HOSTS/ORIGINS 等）
 * 在 spawn 前剥离（见 STRIPPED_ENV_KEYS）
 * ——继承的部署档位会造成假失败，最坏时让写调用越过边界被派发进 handler（破坏"不触库"承诺）；
 * 实机验收脚本在本地 test-verification/（不入库）。
 *
 * 用法：node scripts/smoke-http.mjs（package.json 的 smoke:http 脚本已含 build）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import {
  CLIENT_CAPABILITIES_META_KEY,
  LATEST_PROTOCOL_VERSION,
  PROTOCOL_VERSION_META_KEY,
} from '@modelcontextprotocol/server';
import {
  DEFAULT_SURFACE_ORDER,
  DUMMY_HANA_ENV,
  INVOKE_TOOL,
  TOOL_SEARCH_TOOL,
  assertSameUnknownRefusal,
} from './smoke-shared.mjs';

/**
 * 仓库根与 server 入口按**脚本自身位置**解析（与调用方 cwd 无关，与 smoke-stdio 同口径）：
 * 下面的 dist 存在性断言与 spawn 共用同一路径。dist 缺失/半成品是首跑常见场景（本脚本自己
 * 不做构建；npm run smoke:http 才含构建），先在入口给明确报错——不检测的话从任意目录直跑时
 * 子进程的原始 MODULE_NOT_FOUND 栈会直接外泄，最终只报「服务进程提前退出（code=1）」，
 * 排障方向错位。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(SERVER_ENTRY)) {
  console.error(`[smoke:http] 未找到构建产物：${SERVER_ENTRY}\n请先构建（npm run build；npm run smoke:http 已含构建）`);
  process.exit(1);
}

// modern 协议修订（2026-07-28）。注意：不要用 SDK 的 LATEST_PROTOCOL_VERSION 判断 modern——
// 它是遗留兼容常量（值 2025-11-25）；modern 的判据是 server/discover 的 supportedVersions。
const MODERN_PROTOCOL_VERSION = '2026-07-28';

// 测试专用 dummy token（长度须满足 config 校验 ≥16 字符；非真实凭据）
const TOKEN = 'smoke-http-dummy-token-0123456789';
// 多客户端身份映射（MCP_HTTP_TOKENS）：alpha / beta 各自独立身份
const ALPHA_TOKEN = 'smoke-http-alpha-token-0123456789';
const BETA_TOKEN = 'smoke-http-beta-token-0123456789';

/**
 * 面/边界相关的策略环境变量：spawn 前从继承环境剥离，只保留本脚本自设值
 * （与 smoke-stdio 的 SURFACE_ENV_KEYS 同口径）。不剥离的后果（实测）：
 * ① 只读分组（HANA_TOOL_GROUPS=read 等）与脚本自设的 MCP_PROFILES(read+write) 冲突 →
 *    启动自检 profile_kind_not_in_policy 拒绝启动 → 报「服务进程提前退出（code=1）」；
 *    继承的 MCP_PROFILE 指向脚本档案表外的名字同样触发启动失败；
 * ② HANA_WRITE_PACKAGES 非空 → boundary_off 断言假失败；若恰覆盖目标包，平铺写调用会
 *    越过边界被派发进 handler（破坏头注"不触库"承诺）；
 * ③ MCP_HTTP_ALLOWED_HOSTS 放行 evil.example → 伪造 Host 的 403 断言变 401 假失败。
 * 脚本自设值（MCP_PROFILES/MCP_HTTP_PORT/MCP_HTTP_TOKEN(S)/MCP_HTTP_TOKENS 等）在下方显式覆盖。
 */
const STRIPPED_ENV_KEYS = [
  // 工具面过滤（HANA_TOOL_* 为已弃用的同义旧名，resolveEnvAliases 仍生效）
  'HANA_TOOL_GROUPS',
  'HANA_TOOL_ALLOW',
  'HANA_TOOL_DENY',
  'HANA_TOOL_GROUPS',
  'HANA_TOOL_ALLOW',
  'HANA_TOOL_DENY',
  // 调用方档案：MCP_PROFILES 由本脚本自设；MCP_PROFILE 是 stdio/缺省档案名
  'MCP_PROFILES',
  'MCP_PROFILE',
  // 资源边界（写包白名单 / 读 schema 白名单）
  'HANA_WRITE_PACKAGES',
  'HANA_READ_SCHEMA',
  // HTTP 守卫放行项（Host / Origin）
  'MCP_HTTP_ALLOWED_HOSTS',
  'MCP_HTTP_ALLOWED_ORIGINS',
];
const baseEnv = { ...process.env };
for (const key of STRIPPED_ENV_KEYS) delete baseEnv[key];

// 入口用脚本位置解析出的绝对路径、cwd 固定仓库根：从任意目录直跑脚本都落到同一个 dist
const child = spawn(process.execPath, [SERVER_ENTRY], {
  cwd: REPO_ROOT,
  // stderr 需捕获以从 pino 就绪日志解析实际端口（MCP_HTTP_PORT=0 随机端口），同时回显便于排障
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...baseEnv,
    // dummy HANA 配置（与 stdio 冒烟同源，见 smoke-shared）：仅用于让 config 校验通过，本脚本不调用任何触库工具
    ...DUMMY_HANA_ENV,
    MCP_HTTP_PORT: '0',
    MCP_HTTP_TOKEN: TOKEN,
    // 三段式：第三段是调用方档案；alpha 读写、beta 只读，用于验证档案隔离
    MCP_PROFILES: 'alpha-profile=read+write;beta-profile=read;default=read+write',
    MCP_HTTP_TOKENS: `alpha:${ALPHA_TOKEN}:alpha-profile,beta:${BETA_TOKEN}:beta-profile`,
    // 身份归因日志是 debug 级（每请求一条），冒烟测试需要它来验证 Token → 身份映射
    LOG_LEVEL: 'debug',
  },
});

let port;
/** 每请求一条的身份归属日志（clientId） */
const observedClientIds = [];
/** 启动日志里声明的身份映射表 */
let startupClientIds = [];
/** 启动日志里的档案摘要 */
let profileSummary = '';
/** capability-audit 审计事件（每次调用一条，含 verdict/profileId） */
const audits = [];
const stderrRl = createInterface({ input: child.stderr });
stderrRl.on('line', (line) => {
  console.error(line);
  try {
    const j = JSON.parse(line);
    if (typeof j.httpPort === 'number' && j.httpPort > 0) port = j.httpPort;
    if (Array.isArray(j.clientIds)) startupClientIds = j.clientIds;
    if (typeof j.clientId === 'string' && typeof j.msg === 'string' && j.msg.includes('归属客户端身份')) {
      observedClientIds.push(j.clientId);
    }
    // 调用方档案摘要（启动日志）与逐调用的 capability-audit（含 profileId）
    if (typeof j.profiles === 'string') profileSummary = j.profiles;
    if (j.msg === 'capability-audit') audits.push(j);
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

/** 等待身份归属日志出现指定 clientId（最多 3s；日志与响应同批到达，通常立即可见） */
async function waitForClientId(id) {
  for (let i = 0; i < 30 && !observedClientIds.includes(id); i++) {
    await new Promise((r) => setTimeout(r, 100));
  }
  return observedClientIds.includes(id);
}

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

/** POST /mcp JSON-RPC；authorization 传 null 时不带 Authorization 头（测 401）；headers 追加自定义头（如 Mcp-Method） */
async function rpc(method, params, { authorization = `Bearer ${TOKEN}`, headers: extraHeaders = {} } = {}) {
  const headers = {
    'content-type': 'application/json',
    // Streamable HTTP 规范要求 accept 同时声明 JSON 与 SSE
    accept: 'application/json, text/event-stream',
    ...extraHeaders,
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
  // 4–10MiB 区间必须放行到 handler：本仓守卫与 SDK 两层共用 10MiB 上限——只配一层时 SDK 默认 4MiB 会先 413
  const midBody = JSON.stringify({
    jsonrpc: '2.0',
    id: nextId++,
    method: 'tools/list',
    params: {},
    pad: 'x'.repeat(5 * 1024 * 1024),
  });
  const midRange = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${TOKEN}`,
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    },
    body: midBody,
  });
  console.log('[size-guard] ≈5MiB body（< 10MiB 上限）→ HTTP', midRange.status);
  if (midRange.status === 413)
    throw new Error('4–10MiB 区间被 413 拒绝：SDK 层 maxRequestBodySize 与守卫未同值（默认 4MiB 先拒）');
  await midRange.arrayBuffer();

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
  console.log('[tools/list]', names.length, '个工具（注册面：hana_tool_search + hana_invoke）');
  // 注册面恒为两个平台入口（具体能力不进 tools/list）。档案维度不改注册面——
  // 它改的是可发现/可执行的能力集合，下方 [profiles] 段钉住。
  if (JSON.stringify(names) !== JSON.stringify(DEFAULT_SURFACE_ORDER)) {
    throw new Error(`注册面应为 ${DEFAULT_SURFACE_ORDER.join(', ')}，实际：${names.join(', ') || '(空)'}`);
  }
  const sampleTool = tools.tools.find((t) => t.name === TOOL_SEARCH_TOOL);
  if (!sampleTool?.annotations?.readOnlyHint) {
    throw new Error('annotations 未按约定透出（hana_tool_search 的 readOnlyHint 缺失）');
  }
  console.log('[annotations]', JSON.stringify(sampleTool.annotations));

  // 无状态服务：GET /mcp（2025-era 会话操作）必须 405 = stateless 回退姿态
  // （硬断言：SDK legacy 默认姿态若变化——如 reject / modern-only strict——这里必须红，不允许静默改变）
  const getStatus = await fetch(`http://127.0.0.1:${port}/mcp`, {
    headers: { authorization: `Bearer ${TOKEN}` },
  }).then((r) => r.status);
  console.log('[stateless] GET /mcp → HTTP', getStatus);
  if (getStatus !== 405) {
    throw new Error(
      `GET /mcp 期望 405（stateless 回退），实际 ${getStatus}——SDK legacy 姿态可能已变化，核对 createMcpHandler 的 legacy 选项`,
    );
  }

  // modern（2026-07-28）协议探针：每请求 _meta envelope（两个键必填）+ Mcp-Method 头（缺则 method-header-missing）
  // 装配证据：SDK 2.0.0 dist 已含双 era 服务与 server/discover（常量未导出，只能经本探针断言）
  const discover = await rpc(
    'server/discover',
    {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MODERN_PROTOCOL_VERSION,
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
    // MCP-Protocol-Version 头：SDK 2.3.1 起为 modern 请求的**必需**头（缺失回 -32020
    // "the body envelope names protocol version … but the required MCP-Protocol-Version header is absent"；
    // 2.0.0 只在头存在时才做交叉校验——升级行为差异的实机证据）
    {
      headers: {
        'Mcp-Method': 'server/discover',
        'MCP-Protocol-Version': MODERN_PROTOCOL_VERSION,
      },
    },
  );
  const modernVersions = discover.result?.supportedVersions ?? [];
  console.log('[modern] server/discover → HTTP', discover.status, 'supportedVersions:', JSON.stringify(modernVersions));
  if (discover.status !== 200) console.log('[modern] error body:', JSON.stringify(discover.msg));
  // 断言"包含"而非"等于"：上游可能在未来版本扩容 modern revision 列表
  if (discover.status !== 200 || !modernVersions.includes(MODERN_PROTOCOL_VERSION)) {
    throw new Error(
      `modern 探针失败：期望 supportedVersions 含 ${MODERN_PROTOCOL_VERSION}（HTTP ${discover.status}），实际 ${JSON.stringify(modernVersions)}`,
    );
  }

  // 客户端身份映射：不同 Token → 不同 clientId（envelope.clientId 与审计日志的取值来源）
  await rpc('tools/list', undefined, { authorization: `Bearer ${ALPHA_TOKEN}` });
  await rpc('tools/list', undefined, { authorization: `Bearer ${BETA_TOKEN}` });
  for (const id of ['alpha', 'beta']) {
    if (!(await waitForClientId(id))) {
      throw new Error(`未观测到客户端身份 ${id} 的请求归属日志（已观测：${observedClientIds.join(',') || '无'}）`);
    }
  }
  for (const id of ['alpha', 'beta', 'shared']) {
    if (!startupClientIds.includes(id)) {
      throw new Error(`启动日志的身份映射缺少 ${id}（实际：${startupClientIds.join(',') || '无'}）`);
    }
  }
  console.log('[identity] Token → 身份映射生效：', startupClientIds.join(', '));

  // 调用方档案隔离 + 本体层选择/执行 + 路由不越权：
  // 注册面恒为两个平台入口；档案改的是**可发现/可执行**的能力集合。
  // 全流程在 handler 之前被拦/被拒，**不触达 HANA**（冒烟无需数据库）。
  const writeArgs = { packageId: 'ZDEMO', objectName: 'SMOKE_NEVER_CREATED' };
  const callTool = async (name, args, init) => {
    const r = await rpc('tools/call', { name, arguments: args }, init);
    return {
      isError: r.result?.isError === true,
      text: r.result?.content?.[0]?.text ?? '',
      msg: r.msg,
    };
  };
  /** 取一个覆盖目标能力的 contextToken（contract 回执签发；执行入口必填）。 */
  const contractToken = async (capability, init) => {
    const r = await callTool(TOOL_SEARCH_TOOL, { mode: 'contract', tools: [capability] }, init);
    if (r.isError) throw new Error(`contract ${capability} 失败：${r.text.slice(0, 200)}`);
    const env = JSON.parse(r.text.replace(/^﻿/, ''));
    const token = env?.data?.contextToken;
    if (typeof token !== 'string') throw new Error(`contract ${capability} 未签发 contextToken`);
    return token;
  };
  const alphaDeleteToken = await contractToken('hana_view_delete');
  const alphaProfileDeleteToken = await contractToken('hana_view_delete', {
    authorization: `Bearer ${ALPHA_TOKEN}`,
  });
  const betaReadToken = await contractToken('hana_metadata_get_view', {
    authorization: `Bearer ${BETA_TOKEN}`,
  });

  // 注册面不随档案变化
  const sharedList = await rpc('tools/list');
  const sharedNames = (sharedList.result?.tools ?? []).map((t) => t.name);
  if (JSON.stringify(sharedNames) !== JSON.stringify(DEFAULT_SURFACE_ORDER)) {
    throw new Error(
      `默认档案的工具面应为 ${DEFAULT_SURFACE_ORDER.join(', ')}，实际：${sharedNames.join(', ') || '(空)'}`,
    );
  }
  // 任何本体层调用之前：具体能力名在协议层不可达（面在构建期确定）
  const preSelection = await rpc('tools/call', { name: 'hana_view_delete', arguments: writeArgs });
  if (preSelection.msg?.error?.code !== -32602 || !/not found/.test(preSelection.msg.error.message)) {
    throw new Error(`具体能力应走协议层 not found，实际：${JSON.stringify(preSelection.msg).slice(0, 200)}`);
  }
  const betaList = await rpc('tools/list', undefined, { authorization: `Bearer ${BETA_TOKEN}` });
  const betaNames = (betaList.result?.tools ?? []).map((t) => t.name);
  if (JSON.stringify(betaNames) !== JSON.stringify(DEFAULT_SURFACE_ORDER)) {
    throw new Error(
      `只读档案的工具面同样是 ${DEFAULT_SURFACE_ORDER.join(', ')}，实际：${betaNames.join(', ') || '(空)'}`,
    );
  }

  // 档案隔离在“可发现”层：alpha 能发现写能力，beta 不能。
  const alphaWrites = await callTool(TOOL_SEARCH_TOOL, { mode: 'discover', authorizationClass: 'write', limit: 50 });
  const betaWrites = await callTool(
    TOOL_SEARCH_TOOL,
    { mode: 'discover', authorizationClass: 'write', limit: 50 },
    { authorization: `Bearer ${BETA_TOKEN}` },
  );
  const alphaWriteIds = JSON.parse(alphaWrites.text.replace(/^﻿/, '')).data.candidates.map((c) => c.id);
  const betaWriteIds = JSON.parse(betaWrites.text.replace(/^﻿/, '')).data.candidates.map((c) => c.id);
  if (!alphaWriteIds.includes('hana_view_delete')) {
    throw new Error(`read+write 档案应能发现 hana_view_delete，实际：${alphaWriteIds.join(', ')}`);
  }
  if (betaWriteIds.length !== 0) {
    throw new Error(`只读档案不应发现写能力，实际：${betaWriteIds.join(', ')}`);
  }
  // beta 无法披露/执行写能力（与不存在同形）
  const betaContract = await callTool(
    TOOL_SEARCH_TOOL,
    { mode: 'contract', tools: ['hana_view_delete'] },
    { authorization: `Bearer ${BETA_TOKEN}` },
  );
  if (!betaContract.isError || !betaContract.text.includes('未知能力')) {
    throw new Error(`只读档案披露写能力应被拒，实际：${betaContract.text.slice(0, 200)}`);
  }
  const betaInvoke = await callTool(
    INVOKE_TOOL,
    { capability: 'hana_view_delete', args: writeArgs, contextToken: betaReadToken },
    { authorization: `Bearer ${BETA_TOKEN}` },
  );
  if (!betaInvoke.isError || !betaInvoke.text.includes('未知能力')) {
    throw new Error(`只读档案执行写能力应被拒，实际：${betaInvoke.text.slice(0, 200)}`);
  }

  // 稳定工具面：披露/执行都不触发注册
  const afterCalls = await rpc('tools/list');
  const afterNames = (afterCalls.result?.tools ?? []).map((t) => t.name);
  if (JSON.stringify(afterNames) !== JSON.stringify(DEFAULT_SURFACE_ORDER)) {
    throw new Error(`本体层调用不得改变工具面，实际：${afterNames.join(', ')}`);
  }
  console.log('[surface] 本体层调用不改工具面：两个平台入口恒在（按档案收窄的只是可发现/可执行集合）');

  // schema 校验失败也要落审计：经 hana_invoke 提交非法参数 → 目标能力的 block 记录。
  const badSchema = await callTool(INVOKE_TOOL, {
    capability: 'hana_view_delete',
    args: {},
    contextToken: alphaDeleteToken,
  });
  if (!badSchema.isError || !/参数不符合/.test(badSchema.text)) {
    throw new Error(`经执行入口提交非法参数应被服务端拒绝，实际：${badSchema.text.slice(0, 200)}`);
  }

  // 路由护栏：未知能力 / 平台入口自身 / 档案外 —— 三者同一句文案。
  const guardRefs = [];
  guardRefs.push(await callTool(INVOKE_TOOL, { capability: 'hana_does_not_exist', contextToken: alphaDeleteToken }));
  guardRefs.push(await callTool(INVOKE_TOOL, { capability: TOOL_SEARCH_TOOL, contextToken: alphaDeleteToken }));
  guardRefs.push(
    await callTool(
      INVOKE_TOOL,
      { capability: 'hana_view_delete', args: writeArgs, contextToken: betaReadToken },
      { authorization: `Bearer ${BETA_TOKEN}` },
    ),
  );
  for (const g of guardRefs) {
    if (!g.isError) throw new Error(`护栏路径必须是硬错误，实际：${g.text.slice(0, 200)}`);
  }
  assertSameUnknownRefusal(guardRefs.map((g) => g.text));

  // 路由不越权：alpha（read+write）能执行 hana_view_delete，但**落回部署边界**
  const routed = await callTool(
    INVOKE_TOOL,
    { capability: 'hana_view_delete', args: writeArgs, contextToken: alphaProfileDeleteToken },
    { authorization: `Bearer ${ALPHA_TOKEN}` },
  );
  if (!routed.isError || !routed.text.includes('boundary_off')) {
    throw new Error(`经执行入口的写调用应落回部署边界（boundary_off），实际：${routed.text.slice(0, 200)}`);
  }
  // 拦截文案红线：不得含配置标识符（HANA_*/MCP_* 变量名）或补救路径；这是机器断言，勿放宽。
  if (/HANA_[A-Z_]+|MCP_[A-Z_]+|请配置|请调整/.test(routed.text)) {
    throw new Error('拦截文案不得包含配置标识符或补救路径');
  }
  if (/请配置|请调整|改用/.test(preSelection.msg?.error?.message ?? '')) {
    throw new Error('协议层 not found 文案不得包含补救路径');
  }
  console.log('[profiles] 未知/平台入口/档案外拒绝同形；执行入口的写调用落回部署边界；具体能力恒 not found');

  // 审计事件带 profileId：目标能力（不是平台入口）留痕
  if (!profileSummary.includes('3 份档案')) {
    throw new Error(`启动日志缺少档案摘要（实际：${profileSummary || '无'}）`);
  }
  if (
    !audits.some(
      (a) =>
        a.clientId === 'alpha' &&
        a.profileId === 'alpha-profile' &&
        a.capabilityId === 'hana_view_delete' &&
        a.verdict === 'block' &&
        a.via === INVOKE_TOOL,
    )
  ) {
    throw new Error(`capability-audit 未记录 alpha 经执行入口被拦的写调用（已收 ${audits.length} 条）`);
  }
  // 路由拒绝也落审计——按 id 探测能力若不留痕，越权探测就不可见
  if (!audits.some((a) => a.capabilityId === 'hana_does_not_exist' && a.verdict === 'block' && a.via === INVOKE_TOOL)) {
    throw new Error(`capability-audit 未记录未知能力的探测（已收 ${audits.length} 条）`);
  }
  // 参数校验失败也留痕：归因到目标能力 + input_schema_invalid 机读码
  if (
    !audits.some(
      (a) =>
        a.capabilityId === 'hana_view_delete' &&
        a.verdict === 'block' &&
        a.via === INVOKE_TOOL &&
        a.codes?.includes('input_schema_invalid'),
    )
  ) {
    throw new Error(`capability-audit 未记录 schema 校验失败的调用（已收 ${audits.length} 条）`);
  }
  console.log('[profiles]', profileSummary);

  console.log('[smoke:http] PASS');
} catch (e) {
  console.error('[smoke:http] FAIL:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill();
}
