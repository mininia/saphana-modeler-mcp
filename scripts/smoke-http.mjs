/**
 * Streamable HTTP 冒烟测试：真实启动 dist/index.js（MCP_HTTP_PORT=0 随机端口），
 * 走完整 MCP streamable HTTP 握手（initialize → notifications/initialized → tools/list），
 * 并验证安全守卫链：Bearer Token（缺失/错误 → 401）、伪造 Host（→ 403）、
 * 非 /mcp 路径（→ 404）、超限 Content-Length（→ 413）、无状态回退（GET /mcp → 405）、
 * 多客户端 Token → 身份映射（不同 Token 归因到不同 clientId）、
 * **分类门面注册面**（tools/list 恒为六个门面，具体能力恒为动态调用）与 **门面索引/路由不越权**
 * （档案改的是索引内容，不是注册面；路由的写调用仍落回部署边界 boundary_off）。
 *
 * 不调用任何触库工具（dummy 配置仅用于通过 config 校验；被拦/被拒都发生在 handler 之前）；
 * 调用方 shell 的面/边界策略环境变量（MCP_TOOL_GROUPS 等三个过滤项与旧名 HANA_TOOL_ 系列、
 * MCP_CAPABILITY_SURFACE_MAX 提升预算、HANA_WRITE_PACKAGES、MCP_HTTP_ALLOWED_HOSTS/ORIGINS 等）
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
import { DUMMY_HANA_ENV, FACADE_ORDER, assertSameUnknownRefusal, parseEnvelope } from './smoke-shared.mjs';

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
 * ① 只读分组（MCP_TOOL_GROUPS=read 等）与脚本自设的 MCP_PROFILES(read+write) 冲突 →
 *    启动自检 profile_kind_not_in_policy 拒绝启动 → 报「服务进程提前退出（code=1）」；
 *    继承的 MCP_PROFILE 指向脚本档案表外的名字同样触发启动失败；
 * ② HANA_WRITE_PACKAGES 非空 → boundary_off 断言假失败；若恰覆盖目标包，平铺写调用会
 *    越过边界被派发进 handler（破坏头注"不触库"承诺）；
 * ③ MCP_HTTP_ALLOWED_HOSTS 放行 evil.example → 伪造 Host 的 403 断言变 401 假失败。
 * 脚本自设值（MCP_PROFILES/MCP_HTTP_PORT/MCP_HTTP_TOKEN(S)/MCP_HTTP_TOKENS 等）在下方显式覆盖。
 */
const STRIPPED_ENV_KEYS = [
  // 工具面过滤（HANA_TOOL_* 为已弃用的同义旧名，resolveEnvAliases 仍生效）
  'MCP_TOOL_GROUPS',
  'MCP_TOOL_ALLOW',
  'MCP_TOOL_DENY',
  'HANA_TOOL_GROUPS',
  'HANA_TOOL_ALLOW',
  'HANA_TOOL_DENY',
  // 提升预算（按工具数、最旧分类整体 FIFO 淘汰）：继承的小预算会在"[profiles] 提升生效"断言处
  // 产生确定性假失败（beta 先提升 modeling 再提升 discovery，预算 5/1 会把 hana_task_get 淘汰出局）
  'MCP_CAPABILITY_SURFACE_MAX',
  // 调用方档案：MCP_PROFILES 由本脚本自设；MCP_PROFILE 是 stdio/缺省档案名
  'MCP_PROFILES',
  'MCP_PROFILE',
  // 资源边界（写包白名单 / 读 schema 白名单）
  'HANA_WRITE_PACKAGES',
  'HANA_SCHEMA_ALLOW',
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
  console.log('[tools/list]', names.length, '个工具（注册面：六个分类门面）');
  // 注册面恒为六个分类门面（具体能力不进 tools/list，恒为动态调用）。
  // 档案维度不改注册面——它改的是每个门面**索引里列什么**（面权解耦），下方 [profiles] 段钉住。
  if (JSON.stringify(names) !== JSON.stringify(FACADE_ORDER)) {
    throw new Error(`注册面应为六个分类门面，实际：${names.join(', ') || '(空)'}`);
  }
  const sampleTool = tools.tools.find((t) => t.name === 'hana_system');
  if (!sampleTool?.annotations?.readOnlyHint) {
    throw new Error('annotations 未按约定透出（hana_system 的 readOnlyHint 缺失）');
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

  // 调用方档案隔离 + 门面索引/路由 + 路由不越权：
  // 注册面恒为六个门面（档案**不改**注册面）；档案改的是**门面索引里列什么**与**能路由到什么**。
  // 全流程在 handler 之前被拦/被拒，**不触达 HANA**（冒烟无需数据库）。
  const writeArgs = { packageId: 'ZDEMO', objectName: 'SMOKE_NEVER_CREATED' };
  /** 调一个门面并解析 envelope（索引调用与路由调用共用；路由拒绝是纯文本，解析得 null） */
  const callFacade = async (facade, args, init) => {
    const r = await rpc('tools/call', { name: facade, arguments: args }, init);
    return {
      isError: r.result?.isError === true,
      text: r.result?.content?.[0]?.text ?? '',
      envelope: parseEnvelope(r.result?.content?.[0]?.text),
    };
  };

  // 面 = 门面 ∩ 档案（两层都改）：shared（read+write）看到六个门面；
  // 门面层不做限制：六个入口对谁都常驻；档案只收窄**能力层**——beta（只读）的 modeling 索引只剩 hana_task_get、diagnostics 为空。
  const sharedList = await rpc('tools/list');
  const sharedNames = (sharedList.result?.tools ?? []).map((t) => t.name);
  if (JSON.stringify(sharedNames) !== JSON.stringify(FACADE_ORDER)) {
    throw new Error(`默认档案的注册面应为六个门面，实际：${sharedNames.join(', ') || '(空)'}`);
  }
  // 提升前：具体能力名在协议层不可达（这条必须在任何门面调用之前）
  const prePromotion = await rpc('tools/call', { name: 'hana_view_delete', arguments: writeArgs });
  if (prePromotion.msg?.error?.code !== -32602 || !/not found/.test(prePromotion.msg.error.message)) {
    throw new Error(`提升前的具体能力应走协议层 not found，实际：${JSON.stringify(prePromotion.msg).slice(0, 200)}`);
  }
  const betaList = await rpc('tools/list', undefined, { authorization: `Bearer ${BETA_TOKEN}` });
  const betaNames = (betaList.result?.tools ?? []).map((t) => t.name);
  if (JSON.stringify(betaNames) !== JSON.stringify(FACADE_ORDER)) {
    throw new Error(`门面层不做限制：只读档案的注册面同样是六个门面，实际：${betaNames.join(', ') || '(空)'}`);
  }
  const sharedModeling = await callFacade('hana_modeling', {});
  const betaModeling = await rpc(
    'tools/call',
    { name: 'hana_modeling', arguments: {} },
    { authorization: `Bearer ${BETA_TOKEN}` },
  );
  const idsOf = (c) => (c.envelope?.data?.items ?? []).map((i) => i.id);
  // modeling 索引口径 = 9 基础成员 + 2 任务工具（read/write 各一）+ 8 条操作级别名（write），按档案 kind 过滤：
  //   · read+write 档案：9 − 2(admin 的 Transfer API) + 2 + 8 = 17；
  //   · 只读档案：只剩 read 档的 hana_task_get（入口在、里面只有你能用的）。
  if (
    idsOf(sharedModeling).length !== 17 ||
    idsOf(sharedModeling).some((id) => id === 'hana_repo_export' || id === 'hana_repo_import')
  ) {
    throw new Error(
      `read+write 档案的 modeling 索引应有 17 项（9 基础 − 2 个 admin 档的 Transfer API + 2 任务工具 + 8 操作级别名），实际：${idsOf(sharedModeling).join(', ')}`,
    );
  }
  // 注意：parseEnvelope 返回 envelope 本身（不是 callFacade 的 {envelope} 包装）——写成 idsOf(parseEnvelope(...))
  // 会恒得 []，让索引断言变成空真。
  const betaEnvelope = parseEnvelope(betaModeling.result?.content?.[0]?.text);
  const betaIds = (betaEnvelope?.data?.items ?? []).map((i) => i.id);
  if (betaModeling.result?.isError === true || JSON.stringify(betaIds) !== JSON.stringify(['hana_task_get'])) {
    throw new Error(
      `只读档案的 modeling 索引应恰为 ['hana_task_get']（入口在、里面只有 read 档成员），实际：${JSON.stringify(betaIds)}`,
    );
  }
  const betaDiscovery = await callFacade('hana_discovery', {}, { authorization: `Bearer ${BETA_TOKEN}` });
  if (idsOf(betaDiscovery).length !== 7) {
    throw new Error(`纯读门面的索引应完整（discovery 7 项），实际：${idsOf(betaDiscovery).join(', ')}`);
  }
  if (sharedModeling.envelope?.data?.promoted !== true) {
    throw new Error('调门面应触发提升（shared 身份，已配 Token → 提升启用）');
  }
  console.log(
    '[profiles] 面按档案收窄：六个入口对谁都常驻（门面层不做限制），索引按能力层过滤（beta 的 modeling 只剩 hana_task_get，diagnostics 为空）',
  );

  // 提升后：该分类的能力进入 tools/list（带完整 schema、可平铺直调）——按调用方隔离，beta 不受影响
  const afterPromotion = await rpc('tools/list');
  const afterNames = (afterPromotion.result?.tools ?? []).map((t) => t.name);
  for (const id of ['hana_view_create', 'hana_view_delete', 'hana_view_update', 'hana_package_create']) {
    if (!afterNames.includes(id))
      throw new Error(`提升后 ${id} 应出现在 tools/list 里，实际：${afterNames.join(', ')}`);
  }
  if (afterNames.includes('hana_repo_import')) {
    throw new Error('提升不越权：read+write 档案不应拿到 admin 档的 hana_repo_import（Transfer API）');
  }
  const promotedTool = afterPromotion.result.tools.find((t) => t.name === 'hana_view_delete');
  if (!promotedTool?.inputSchema?.properties || Object.keys(promotedTool.inputSchema.properties).length === 0) {
    throw new Error('提升后的工具必须带完整 inputSchema（这是提升相对索引的唯一收益）');
  }
  // beta 调的是纯读门面（discovery）→ 它按**自己的档案**提升了该类，且**提升不越权**：
  // 进面的全是 read 档成员，写/admin 档一个都进不来。这同时证明提升按调用方隔离。
  const betaAfter = await rpc('tools/list', undefined, { authorization: `Bearer ${BETA_TOKEN}` });
  const betaAfterNames = (betaAfter.result?.tools ?? []).map((t) => t.name);
  const expectedBeta = [
    ...FACADE_ORDER,
    // 提升进来的按清单**声明顺序**追加（= 注册顺序），不是字典序。
    // 本用例之前 beta 已调过 hana_modeling 索引（只读档案在其中只有 read 档的 hana_task_get），
    // 那次调用同样触发提升 ⇒ hana_task_get 也在面上。顺序 = 模块注册顺序（facades → system →
    // package → metadata → preview → modeling → task → …），故 task_get 排在 discovery 七项**之后**。
    'hana_package_list',
    'hana_package_list_objects',
    'hana_metadata_get_view',
    'hana_metadata_search_objects',
    'hana_metadata_list_fields',
    'hana_table_list',
    'hana_table_columns',
    'hana_task_get',
  ];
  if (JSON.stringify(betaAfterNames) !== JSON.stringify(expectedBeta)) {
    throw new Error(
      `只读档案提升后应只多出已提升分类的读能力（此前 modeling 的 hana_task_get + 本次 discovery 的 7 项），实际：${betaAfterNames.join(', ')}`,
    );
  }
  for (const id of ['hana_view_delete', 'hana_view_create', 'hana_repo_import', 'hana_system_health']) {
    if (betaAfterNames.includes(id)) throw new Error(`提升不越权：只读档案不应拿到 ${id}`);
  }
  console.log(
    '[profiles] 提升生效且按调用方隔离：shared 提升出 9 个 modeling 工具（9 个基础成员 − 2 个 admin 的 Transfer API + 2 个任务工具），' +
      'beta 只拿到它的读能力（modeling 的 hana_task_get + discovery 的 7 项）',
  );

  // 提升只改呈现、不改授权：提升后的平铺直调照样过闸门——
  // 落回部署边界（writePackages 为空），**不触库**
  const flatCall = await rpc('tools/call', { name: 'hana_view_delete', arguments: writeArgs });
  const flatText = flatCall.result?.content?.[0]?.text ?? '';
  if (flatCall.result?.isError !== true || !flatText.includes('boundary_off')) {
    throw new Error(`提升后的平铺调用应落回部署边界（boundary_off），实际：${flatText.slice(0, 200)}`);
  }
  // 未提升的分类仍是协议层 not found（discovery 没被提升过）
  const notPromoted = await rpc('tools/call', { name: 'hana_metadata_get_view', arguments: {} });
  if (notPromoted.msg?.error?.code !== -32602 || !/not found/.test(notPromoted.msg.error.message)) {
    throw new Error(`未提升分类的能力应走协议层 not found，实际：${JSON.stringify(notPromoted.msg).slice(0, 200)}`);
  }

  // schema 校验失败也要落审计：经门面路由提交非法参数 → 目标能力的 block 记录。
  const badSchema = await callFacade('hana_modeling', { capability: 'hana_view_delete', args: {} });
  if (!badSchema.isError || !/参数不符合/.test(badSchema.text)) {
    throw new Error(`经路由提交非法参数应被服务端拒绝（schema 不通过），实际：${badSchema.text.slice(0, 200)}`);
  }

  // 路由护栏：未知能力 / 跨类 / 路由到门面 / **档案外** —— 四者同一句文案。
  // beta（只读）在**它自己的面内**路由 hana_view_delete 走的就是"跨类 + 档案外"这一条：
  // 连存在性都探不出来（面外的门面则是协议层 not found，见上）。
  const guardRefs = [];
  guardRefs.push(await callFacade('hana_modeling', { capability: 'hana_does_not_exist' }));
  guardRefs.push(await callFacade('hana_modeling', { capability: 'hana_metadata_get_view' })); // discovery 类
  guardRefs.push(await callFacade('hana_modeling', { capability: 'hana_discovery' })); // 目标是门面
  guardRefs.push(
    await callFacade(
      'hana_discovery',
      { capability: 'hana_view_delete', args: writeArgs },
      { authorization: `Bearer ${BETA_TOKEN}` },
    ),
  );
  for (const g of guardRefs) {
    if (!g.isError) throw new Error(`护栏路径必须是硬错误，实际：${g.text.slice(0, 200)}`);
  }
  assertSameUnknownRefusal(guardRefs.map((g) => g.text));

  // 路由不越权：alpha（read+write）能路由到 hana_view_delete，但**落回部署边界**
  const routed = await callFacade(
    'hana_modeling',
    { capability: 'hana_view_delete', args: writeArgs },
    { authorization: `Bearer ${ALPHA_TOKEN}` },
  );
  if (!routed.isError || !routed.text.includes('boundary_off')) {
    throw new Error(`经门面路由的写调用应落回部署边界（boundary_off），实际：${routed.text.slice(0, 200)}`);
  }
  if (routed.text !== flatText) {
    throw new Error('平铺直调与经门面路由必须得到同一段文案（同一条授权判定）');
  }
  // 拦截文案红线：不得含配置标识符（HANA_*/MCP_* 变量名）或补救路径；这是机器断言，勿放宽。
  // 正则覆盖全部标识符形态——部署级 warn（如明文连接）也会随 verdict.text 进拦截回执
  if (/HANA_[A-Z_]+|MCP_[A-Z_]+|请配置|请调整/.test(routed.text)) {
    throw new Error('拦截文案不得包含配置标识符或补救路径');
  }
  if (/请配置|请调整|改用/.test(prePromotion.msg?.error?.message ?? '')) {
    throw new Error('协议层 not found 文案不得包含补救路径');
  }
  console.log('[profiles] 四类拒绝同形；平铺直调与门面路由同文案；未提升分类仍 not found');

  // 审计事件带 profileId：门面索引（allow）与被拦的写路由（block）都要留痕
  if (!profileSummary.includes('3 份档案')) {
    throw new Error(`启动日志缺少档案摘要（实际：${profileSummary || '无'}）`);
  }
  if (
    !audits.some(
      (a) =>
        a.clientId === 'alpha' &&
        a.profileId === 'alpha-profile' &&
        a.capabilityId === 'hana_modeling' &&
        a.verdict === 'allow',
    )
  ) {
    throw new Error(`capability-audit 未记录 alpha 的门面调用（已收 ${audits.length} 条）`);
  }
  if (
    !audits.some(
      (a) =>
        a.clientId === 'alpha' &&
        a.profileId === 'alpha-profile' &&
        a.capabilityId === 'hana_view_delete' &&
        a.verdict === 'block',
    )
  ) {
    throw new Error(`capability-audit 未记录 alpha 经门面路由后被拦的写调用（已收 ${audits.length} 条）`);
  }
  // 路由拒绝也落审计——按 id 探测能力若不留痕，越权探测就不可见
  if (!audits.some((a) => a.capabilityId === 'hana_does_not_exist' && a.verdict === 'block' && a.via)) {
    throw new Error(`capability-audit 未记录未知能力的路由探测（已收 ${audits.length} 条）`);
  }
  // 参数校验失败也留痕：归因到目标能力 + input_schema_invalid 机读码
  if (
    !audits.some(
      (a) =>
        a.capabilityId === 'hana_view_delete' &&
        a.verdict === 'block' &&
        a.via === 'hana_modeling' &&
        a.codes?.includes('input_schema_invalid'),
    )
  ) {
    throw new Error(`capability-audit 未记录 schema 校验失败的路由调用（已收 ${audits.length} 条）`);
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
