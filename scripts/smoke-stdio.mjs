/**
 * stdio 冒烟测试：真实启动 dist/index.js，走完整 MCP JSON-RPC 握手，
 * 验证 tools/list 注册、annotations 透出，以及**门面索引**、**路由护栏**与**提升（list_changed）**（黑盒协议层）。
 *
 * 只调用**不触库**的路径：门面不带参数调用 = 只读清单；路由到未知/跨类能力 = 入口即拒。
 * 真实的业务调用会触数据库，留在本地 test-verification/（不入库）。
 *
 * 用法：node scripts/smoke-stdio.mjs（package.json 的 smoke 脚本已含 build）
 *
 * 三个用例（分类门面制）：
 *   A. **注册面**：tools/list 应恰好是六个分类门面（顺序固定），占位工具不出现；annotations 透出。
 *   B. **门面行为 + 可见性过滤自检**：每个门面的索引条数与可见成员数一致、不含门面自己；
 *      未知能力与跨类路由回**同一句**未知能力；若另配了 MCP_TOOL_GROUPS / MCP_TOOL_ALLOW /
 *      MCP_TOOL_DENY（旧名 HANA_TOOL_* 同义），额外校验**能力层**收窄结果（门面层不做限制，
 *      六个入口恒在；索引可能为空——入口在、里面没有你可用的能力）：
 *        MCP_TOOL_GROUPS=read node scripts/smoke-stdio.mjs   # 只读部署：六门面恒在；modeling 索引只剩 hana_task_get（read 档），diagnostics 索引为空
 *   C. **提升**：调门面 → 该分类能力进入 tools/list（带完整 schema、可平铺直调）+ list_changed 通知。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import { DUMMY_HANA_ENV, FACADE_ORDER, assertSameUnknownRefusal, requireEnvelope } from './smoke-shared.mjs';

/**
 * 仓库根与 server 入口按**脚本自身位置**解析（与调用方 cwd 无关）：下面的 dist 存在性断言与
 * spawn 共用同一路径。dist 缺失/半成品是首跑常见场景（本脚本自己不做构建），先在入口给明确报错——
 * 不检测的话子进程的 MODULE_NOT_FOUND 会被 60s 全局兜底吞成"冒烟测试超时（60s）"，排障方向错位。
 */
const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(SERVER_ENTRY)) {
  console.error(`[smoke] 未找到构建产物：${SERVER_ENTRY}\n请先构建（npm run build；npm run smoke 已含构建）`);
  process.exit(1);
}

/** 面相关环境变量：用例 A 剥离（保证断言与调用方 shell 环境无关），用例 B 读调用方配置做自检 */
const SURFACE_ENV_KEYS = [
  'MCP_TOOL_GROUPS',
  'MCP_TOOL_ALLOW',
  'MCP_TOOL_DENY',
  'HANA_TOOL_GROUPS',
  'HANA_TOOL_ALLOW',
  'HANA_TOOL_DENY',
  'MCP_PROFILES',
  'MCP_PROFILE',
];

/** dummy 配置（来自共享模块）：仅用于让 config 校验通过，本脚本不调用任何触库工具 */
const BASE_ENV = { ...process.env, ...DUMMY_HANA_ENV };

/**
 * 镜像表**全部从被测构建（dist）的清单派生**，不手写副本：手写副本会随清单演进漂移
 * （漏登新能力或 routeOnly 操作级别名），用例 B 便拿**错的期望**判服务端，输出
 * "索引应含 N 项，实际 M"这类假失败，把排查指向并不存在的服务端索引缺陷。派生后期望与被测
 * 服务端恒为同一份清单（子进程跑 dist/index.js，镜像取自 dist/capabilities/manifest.js——
 * 同一次构建），新增能力只登记清单、本文件零改动。
 *
 * 清单（单一事实源）：src/capabilities/defs/*.ts → dist/capabilities/manifest.js。
 * 用 try 包住：该模块链在**加载期**就会读环境变量（如 LOG_LEVEL 建 logger），构建产物或环境变量
 * 有问题时给它一句明确的报错，而不是把 pino/zod 的原始栈抛给调用方。
 */
let CAPABILITY_LIST;
try {
  ({ CAPABILITY_LIST } = await import('../dist/capabilities/manifest.js'));
} catch (e) {
  console.error(
    `[smoke] 加载构建清单失败（dist/capabilities/manifest.js）：${e.message}\n` +
      `请确认 dist 为最新构建、启动相关环境变量（如 LOG_LEVEL）取值有效`,
  );
  process.exit(1);
}

/**
 * 门面 → 成员能力 id（含 routeOnly 操作级别名）。与 manifest.membersOfCategory 同口径：
 * 成员 = 非门面条目（`facadeOf === undefined`）且分类匹配；门面条目自身的 facadeOf 就是它的分类，
 * 不排除会把门面列进自己的成员表。门面 id = `hana_<分类>`（facadeIdOf），故按 id 反查。
 */
const FACADE_MEMBERS = Object.fromEntries(
  FACADE_ORDER.map((facadeId) => [
    facadeId,
    CAPABILITY_LIST.filter((c) => c.facadeOf === undefined && `hana_${c.category}` === facadeId).map((c) => c.id),
  ]),
);

/** 能力 id → 分组 kind（含门面与 routeOnly 别名；与 tools/groups.ts 的 TOOL_GROUPS 同口径） */
const GROUP_OF = new Map(CAPABILITY_LIST.map((c) => [c.id, c.kind]));

/** 组名 → 该组全部 id（与 groups.ts 的 toolsOfGroup 同语义，供 allow/deny 的组名展开） */
const IDS_BY_GROUP = new Map(
  ['read', 'write', 'admin'].map((group) => [group, CAPABILITY_LIST.filter((c) => c.kind === group).map((c) => c.id)]),
);

const timeout = setTimeout(() => {
  console.error('冒烟测试超时（60s）');
  process.exit(1);
}, 60_000);

/**
 * 启动一个 stdio server，跑完 fn 后关闭。
 * fn 收到 { request, initialize, call, notifications } 四个助手（initialize 必须最先调用）。
 */
async function withServer(env, fn) {
  // 入口用脚本位置解析出的绝对路径、cwd 固定仓库根：从任意目录直跑脚本都落到同一个 dist
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  /** 服务端主动发的通知（id == null），如 notifications/tools/list_changed */
  const notifications = [];
  let nextId = 1;
  /**
   * 子进程提前退出（dist 半成品 / 从旧 cwd 启动失败 / 启动自检拒绝等）时**立刻 reject** 全部挂起请求——
   * 不检测就只剩 60s 全局兜底，会把"服务没起来"误报成"冒烟测试超时（60s）"，排障方向错位。
   * 正常收尾（finally 里 child.kill()）时 pending 已空，这里只是空转一跳。
   */
  const rejectPending = (message) => {
    for (const p of pending.values()) p.reject(new Error(message));
    pending.clear();
  };
  child.on('error', (e) => rejectPending(`服务进程启动失败：${e.message}`));
  child.on('exit', (code) => rejectPending(`服务进程提前退出（code=${code}）`));
  rl.on('line', (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return; // 忽略非 JSON 行（如 pino 意外输出，理论上不应出现）
    }
    if (msg.id == null) {
      notifications.push(msg);
      return;
    }
    if (pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
      else p.resolve(msg.result);
    }
  });
  const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      send({ jsonrpc: '2.0', id, method, params });
    });
  };
  const initialize = async (clientName) => {
    const init = await request('initialize', {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '0.0.1' },
    });
    console.log(`[handshake] ${clientName} negotiated protocol:`, init.protocolVersion);
    // instructions 应在 initialize 结果中（SEP 增强）；仅提示不硬断言
    if (init.instructions) console.log('[instructions] 已下发（' + init.instructions.length + ' 字符）');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return init;
  };
  /**
   * 调一个工具并返回 { isError, text, error }。
   * 未注册的工具名走**协议层错误**（JSON-RPC error，没有 result）——`error` 非空即"不可达"，
   * 与"注册了但被闸门拦下"（isError=true 且有文案）是两种形态，别混。
   */
  const call = async (name, args) => {
    try {
      const r = await request('tools/call', { name, arguments: args });
      return { isError: r.isError === true, text: r.content?.[0]?.text ?? '', error: undefined };
    } catch (e) {
      return { isError: false, text: '', error: e.message };
    }
  };
  try {
    return await fn({ request, initialize, call, notifications });
  } finally {
    rl.close();
    child.kill();
  }
}

/** 断言 annotations 透出（从面上任取一个带 annotations 的工具） */
function assertAnnotations(tools, preferred) {
  const sample =
    tools.find((t) => t.name === preferred) ??
    tools.find((t) => t.annotations?.readOnlyHint) ??
    tools.find((t) => t.annotations);
  console.log('[annotations]', JSON.stringify(sample?.annotations ?? '(未透出)'));
  if (!sample?.annotations) {
    throw new Error('annotations 未按约定透出（tools/list 里没有任何工具带 annotations）');
  }
}

/** 用例 A：注册面 = 六个分类门面（具体能力不进 tools/list） */
async function caseRegisteredSurface() {
  console.log('\n[case A] 注册面 = 六个分类门面');
  const env = { ...BASE_ENV };
  for (const k of SURFACE_ENV_KEYS) delete env[k];
  await withServer(env, async ({ request, initialize }) => {
    await initialize('smoke-stdio-surface');
    const tools = (await request('tools/list')).tools;
    const names = tools.map((t) => t.name);
    console.log('[tools/list]', names.join(', '));
    if (JSON.stringify(names) !== JSON.stringify(FACADE_ORDER)) {
      throw new Error(`注册面应为六个门面（顺序固定 ${FACADE_ORDER.join(', ')}），实际：${names.join(', ') || '(空)'}`);
    }
    // 具体能力一个都不该直接注册（否则等于退回"全常驻"）
    for (const members of Object.values(FACADE_MEMBERS)) {
      for (const id of members) {
        if (names.includes(id)) throw new Error(`${id} 不应直接注册——具体能力恒为动态调用`);
      }
    }
    // 门面入参必须是 { capability?, args? }
    for (const t of tools) {
      const props = Object.keys(t.inputSchema?.properties ?? {});
      if (JSON.stringify(props) !== JSON.stringify(['capability', 'args'])) {
        throw new Error(`${t.name} 的入参应为 capability/args，实际：${props.join(', ') || '(空)'}`);
      }
    }
    assertAnnotations(tools, 'hana_modeling');
    console.log('[case A] PASS —— 注册面只有六个分类门面，具体能力按需索引与路由');
  });
}

/** 用例 B：门面索引 + 路由护栏 +（可选）可见性过滤自检 */
async function caseFacadeBehaviour() {
  console.log('\n[case B] 门面索引 / 路由护栏 / 可见性过滤自检');
  const env = { ...BASE_ENV };
  for (const k of SURFACE_ENV_KEYS) delete env[k];
  // 保留调用方 shell 里的过滤配置（本用例据此做自检）
  const groups = (process.env.MCP_TOOL_GROUPS ?? process.env.HANA_TOOL_GROUPS ?? '').trim();
  const allow = (process.env.MCP_TOOL_ALLOW ?? process.env.HANA_TOOL_ALLOW ?? '').trim();
  const deny = (process.env.MCP_TOOL_DENY ?? process.env.HANA_TOOL_DENY ?? '').trim();
  if (groups) env.MCP_TOOL_GROUPS = groups;
  if (allow) env.MCP_TOOL_ALLOW = allow;
  if (deny) env.MCP_TOOL_DENY = deny;

  const matchGlob = (name, patterns) =>
    patterns.some((p) =>
      p.includes('*')
        ? new RegExp('^' + p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name)
        : p === name,
    );
  // 组名展开成该组全部成员（大小写不敏感，与 groups.ts 的 expandGroupTokens / parseToolFilter 同语义）
  const expandTokens = (raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((t) => IDS_BY_GROUP.get(t.toLowerCase()) ?? [t]);
  const denyPatterns = expandTokens(deny);
  const allowPatterns = expandTokens(allow);
  const enabledGroups = groups
    ? groups
        .split(',')
        .map((g) => g.trim().toLowerCase())
        .filter(Boolean)
    : [];
  /** deny 命中：与 src/tools/groups.ts 的 deniedByPatterns 同语义——操作级别名（`父#op`）跟随父工具 id */
  const capDenied = (id) => {
    if (matchGlob(id, denyPatterns)) return true;
    const parent = id.includes('#') ? id.split('#')[0] : undefined;
    return parent !== undefined && matchGlob(parent, denyPatterns);
  };
  /** 单个具体能力是否可见（deny > allow > 分组；空分组 = 不限制） */
  const capVisible = (id) => {
    if (capDenied(id)) return false;
    if (matchGlob(id, allowPatterns)) return true;
    if (enabledGroups.length === 0) return true;
    const group = GROUP_OF.get(id);
    // 未知 id 直接抛错：清单再变更时当场暴露，而不是落"admin 兜底"把期望算错后误报服务端
    if (group === undefined) throw new Error(`能力清单里没有 ${id}——镜像表与清单脱节，请检查派生逻辑`);
    return enabledGroups.includes(group);
  };
  /** 门面是否注册：**门面层不做限制**——恒在；只有显式 deny（命中门面 id，或全部成员被 deny）才消失 */
  const facadeVisible = (facade) => !capDenied(facade) && FACADE_MEMBERS[facade].some((id) => !capDenied(id));

  await withServer(env, async ({ request, initialize, call }) => {
    await initialize('smoke-stdio-facade');
    const tools = (await request('tools/list')).tools;
    const names = tools.map((t) => t.name);
    console.log('[tools/list]', names.join(', '));

    // ① 可见性过滤自检：注册面应恰好是"该可见的门面"
    const expectedFacades = FACADE_ORDER.filter(facadeVisible);
    if (JSON.stringify(names) !== JSON.stringify(expectedFacades)) {
      throw new Error(
        `门面可见性与过滤配置不符：期望 ${expectedFacades.join(', ') || '(空)'}，实际 ${names.join(', ') || '(空)'}`,
      );
    }
    if (enabledGroups.length > 0 || denyPatterns.length > 0) {
      console.log(
        `[tool-filter] 分组 ${enabledGroups.join(',') || '(不限)'} → 可见门面 ${names.join(', ') || '(空)'}，符合预期`,
      );
    }

    // ② 门面索引：条数 = 可见成员数，且不含门面自己
    for (const facade of expectedFacades) {
      const members = FACADE_MEMBERS[facade].filter(capVisible);
      const idx = requireEnvelope((await call(facade, {})).text, `${facade} 索引回执`);
      if (idx.success !== true)
        throw new Error(`${facade} 索引调用应成功，实际：${(await call(facade, {})).text.slice(0, 200)}`);
      const ids = idx.data.items.map((i) => i.id);
      if (ids.length !== members.length) {
        throw new Error(`${facade} 索引应含 ${members.length} 项，实际 ${ids.length}：${ids.join(', ')}`);
      }
      if (ids.includes(facade)) throw new Error(`${facade} 的索引里不应有门面自己`);
      for (const item of idx.data.items) {
        if (!item.summary || item.summary.length > 120) throw new Error(`${facade} 索引项 ${item.id} 的摘要缺失或过长`);
        if (!Array.isArray(item.params)) throw new Error(`${facade} 索引项 ${item.id} 缺 params（挑选依据）`);
      }
    }
    const sample = expectedFacades.length
      ? requireEnvelope((await call(expectedFacades[0], {})).text, `${expectedFacades[0]} 索引回执`).data.items.map(
          (i) => i.id,
        )
      : [];
    if (sample.length) console.log(`[index] ${expectedFacades[0]} →`, sample.join(', '));

    // ③ 路由护栏：未知能力 / 跨类 / 路由到门面 —— 三者同一句文案，且都不触库
    if (expectedFacades.length >= 2) {
      const [a, b] = expectedFacades;
      const unknown = await call(a, { capability: 'hana_does_not_exist' });
      const cross = await call(a, { capability: FACADE_MEMBERS[b][0] });
      const toFacade = await call(a, { capability: b });
      if (!unknown.isError || !cross.isError || !toFacade.isError) {
        throw new Error('未知/跨类/路由到门面的调用都必须是硬错误');
      }
      assertSameUnknownRefusal([unknown.text, cross.text, toFacade.text]);
      console.log('[route-guard] 未知 / 跨类 / 路由到门面 → 同一句拒绝文案');
    }

    assertAnnotations(tools, 'hana_modeling');
    console.log('[case B] PASS');
  });
}

/**
 * 用例 C：**提升**（对齐 hana-cli 的 Dynamic Tool Promotion）。
 *
 * 调门面 → 该分类的能力进入 tools/list（带完整 schema、可平铺直调）+ `list_changed` 通知。
 * 全流程不触库：只调门面（索引）与一次"未注册工具名"的协议层探测。
 */
async function casePromotion() {
  console.log('\n[case C] 提升：调门面 → 该类能力进 tools/list + list_changed');
  const env = { ...BASE_ENV };
  for (const k of SURFACE_ENV_KEYS) delete env[k];
  await withServer(env, async ({ request, initialize, call, notifications }) => {
    await initialize('smoke-stdio-promotion');
    const before = (await request('tools/list')).tools.map((t) => t.name);
    if (JSON.stringify(before) !== JSON.stringify(FACADE_ORDER)) {
      throw new Error(`前提失败：注册面应为六个门面，实际 ${before.join(', ')}`);
    }
    // 提升前：具体能力名在协议层不可达（JSON-RPC error，而不是"注册了但被闸门拦"）
    const preCall = await call('hana_data_preview', {});
    if (preCall.error === undefined) {
      throw new Error(`提升前 hana_data_preview 不应可直调，实际拿到了 result：${preCall.text.slice(0, 120)}`);
    }

    // 调门面（不带参数）→ 提升 data 类
    const idx = requireEnvelope((await call('hana_data', {})).text, 'hana_data 索引回执');
    if (idx.data.promoted !== true) {
      throw new Error(`调门面应触发提升，实际 promoted=${JSON.stringify(idx.data.promoted)}`);
    }
    await sleep(400);

    const after = (await request('tools/list')).tools.map((t) => t.name);
    console.log('[tools/list after]', after.join(', '));
    for (const id of FACADE_MEMBERS.hana_data) {
      if (!after.includes(id)) throw new Error(`提升后 ${id} 应出现在 tools/list 里`);
    }
    if (after.length !== FACADE_ORDER.length + FACADE_MEMBERS.hana_data.length) {
      throw new Error(`只应多出 data 类的 ${FACADE_MEMBERS.hana_data.length} 个工具，实际：${after.join(', ')}`);
    }
    // 提升后的工具带完整 inputSchema（这是提升相对索引的唯一收益）
    const promoted = (await request('tools/list')).tools.find((t) => t.name === 'hana_data_preview');
    if (!promoted?.inputSchema?.properties || Object.keys(promoted.inputSchema.properties).length === 0) {
      throw new Error('提升后的工具必须带完整 inputSchema（否则提升没有意义）');
    }
    if (!notifications.some((n) => n.method === 'notifications/tools/list_changed')) {
      throw new Error(
        `应收到 notifications/tools/list_changed（实际：${JSON.stringify(notifications.map((n) => n.method))}）`,
      );
    }
    console.log('[case C] PASS —— 提升把该类能力挂成平铺工具并通知客户端刷新');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await caseRegisteredSurface();
  await caseFacadeBehaviour();
  await casePromotion();
  console.log('\n[smoke] PASS');
} catch (e) {
  console.error('[smoke] FAIL:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
