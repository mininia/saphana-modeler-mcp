/**
 * stdio 冒烟测试：真实启动 dist/index.js，走完整 MCP JSON-RPC 握手。
 *
 * 2026-11-19 单一入口契约：
 *   - 常驻工具面**只有两个**：hana_tool_search（选择）+ hana_invoke（执行）；
 *   - 六个分类门面、hana_sql_execute、所有具体能力均不在 tools/list；
 *   - 具体能力经 tool_search 发现/披露，经 hana_invoke 执行；平台入口自身不可作为目标。
 *
 * 只调用**不触库**的路径：discover/contract/goal 只读清单；invoke 的未知能力在入口即拒，
 * schema 错误在派发前拒绝。真实业务调用留在本地 test-verification/（不入库）。
 *
 * 用法：node scripts/smoke-stdio.mjs（package.json 的 smoke 脚本已含 build）
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';
import {
  DEFAULT_SURFACE_ORDER,
  DUMMY_HANA_ENV,
  INVOKE_TOOL,
  TOOL_SEARCH_TOOL,
  assertSameUnknownRefusal,
  requireEnvelope,
} from './smoke-shared.mjs';

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url));
const SERVER_ENTRY = fileURLToPath(new URL('../dist/index.js', import.meta.url));
if (!existsSync(SERVER_ENTRY)) {
  console.error(`[smoke] 未找到构建产物：${SERVER_ENTRY}\n请先构建（npm run build；npm run smoke 已含构建）`);
  process.exit(1);
}

/** 面相关环境变量：用例 A/C 剥离（保证断言与调用方 shell 环境无关），用例 B 读调用方配置做自检 */
const SURFACE_ENV_KEYS = [
  'HANA_TOOL_GROUPS',
  'HANA_TOOL_ALLOW',
  'HANA_TOOL_DENY',
  'HANA_TOOL_GROUPS',
  'HANA_TOOL_ALLOW',
  'HANA_TOOL_DENY',
  'MCP_PROFILES',
  'MCP_PROFILE',
];

const BASE_ENV = { ...process.env, ...DUMMY_HANA_ENV };

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

/** 具体能力（非平台入口）：发现/执行的候选全集 */
const CONCRETE = CAPABILITY_LIST.filter((c) => c.platform !== true);
const GROUP_OF = new Map(CONCRETE.map((c) => [c.id, c.kind]));
const IDS_BY_GROUP = new Map(
  ['read', 'write', 'admin'].map((group) => [group, CONCRETE.filter((c) => c.kind === group).map((c) => c.id)]),
);

const timeout = setTimeout(() => {
  console.error('冒烟测试超时（60s）');
  process.exit(1);
}, 60_000);

async function withServer(env, fn) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: REPO_ROOT,
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
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
      return;
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
    if (init.instructions) console.log('[instructions] 已下发（' + init.instructions.length + ' 字符）');
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    return init;
  };
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

/** 用例 A：工具面 = 两个平台入口 */
async function caseRegisteredSurface() {
  console.log('\n[case A] 工具面 = hana_tool_search + hana_invoke');
  const env = { ...BASE_ENV };
  for (const k of SURFACE_ENV_KEYS) delete env[k];
  await withServer(env, async ({ request, initialize }) => {
    await initialize('smoke-stdio-surface');
    const tools = (await request('tools/list')).tools;
    const names = tools.map((t) => t.name);
    console.log('[tools/list]', names.join(', '));
    if (JSON.stringify(names) !== JSON.stringify(DEFAULT_SURFACE_ORDER)) {
      throw new Error(`工具面应为 ${DEFAULT_SURFACE_ORDER.join(', ')}，实际：${names.join(', ') || '(空)'}`);
    }
    // 具体能力一个都不该直接注册（否则等于留下绕过本体层的捷径）
    for (const cap of CONCRETE) {
      if (names.includes(cap.id)) throw new Error(`${cap.id} 不应直接注册——具体能力只能经本体层选择`);
    }
    const search = tools.find((t) => t.name === TOOL_SEARCH_TOOL);
    const invoke = tools.find((t) => t.name === INVOKE_TOOL);
    if (!search?.annotations?.readOnlyHint) throw new Error('hana_tool_search 应声明 readOnlyHint=true');
    if (invoke?.annotations?.readOnlyHint !== false) throw new Error('hana_invoke 应声明 readOnlyHint=false');
    const invokeProps = Object.keys(invoke.inputSchema?.properties ?? {});
    if (JSON.stringify(invokeProps) !== JSON.stringify(['capability', 'args', 'contextToken'])) {
      throw new Error(`hana_invoke 入参应恰为 capability/args/contextToken，实际：${invokeProps.join(', ')}`);
    }
    if (!(invoke.inputSchema?.required ?? []).includes('contextToken')) {
      throw new Error('hana_invoke 必须把 contextToken 声明为必填');
    }
    console.log('[case A] PASS —— 工具面只有选择与执行两个平台入口');
  });
}

/** 用例 B：可见性过滤自检 + 路由护栏 */
async function caseVisibilityAndGuard() {
  console.log('\n[case B] 可见性过滤 / 路由护栏');
  const env = { ...BASE_ENV };
  for (const k of SURFACE_ENV_KEYS) delete env[k];
  const groups = (process.env.HANA_TOOL_GROUPS ?? '').trim();
  const allow = (process.env.HANA_TOOL_ALLOW ?? '').trim();
  const deny = (process.env.HANA_TOOL_DENY ?? '').trim();
  if (groups) env.HANA_TOOL_GROUPS = groups;
  if (allow) env.HANA_TOOL_ALLOW = allow;
  if (deny) env.HANA_TOOL_DENY = deny;

  const matchGlob = (name, patterns) =>
    patterns.some((p) =>
      p.includes('*')
        ? new RegExp('^' + p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name)
        : p === name,
    );
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
  const capDenied = (id) => {
    if (matchGlob(id, denyPatterns)) return true;
    const parent = id.includes('#') ? id.split('#')[0] : undefined;
    return parent !== undefined && matchGlob(parent, denyPatterns);
  };
  // 单环境冒烟：hana_env_list / hana_env_switch 不可达（多环境才有）
  const ENV_CONTROL_IDS = new Set(['hana_env_list', 'hana_env_switch']);
  const capVisible = (id) => {
    if (ENV_CONTROL_IDS.has(id)) return false;
    if (capDenied(id)) return false;
    if (matchGlob(id, allowPatterns)) return true;
    if (enabledGroups.length === 0) {
      const group = GROUP_OF.get(id);
      return group !== undefined && group !== 'sql';
    }
    const group = GROUP_OF.get(id);
    if (group === undefined) throw new Error(`能力清单里没有 ${id}——镜像表与清单脱节`);
    return enabledGroups.includes(group);
  };
  const anyConcrete = CONCRETE.some((c) => capVisible(c.id));
  const expectedSurface = DEFAULT_SURFACE_ORDER.filter((id) => anyConcrete && !capDenied(id));

  await withServer(env, async ({ request, initialize, call }) => {
    await initialize('smoke-stdio-guard');
    const names = (await request('tools/list')).tools.map((t) => t.name);
    console.log('[tools/list]', names.join(', ') || '(空)');
    if (JSON.stringify(names) !== JSON.stringify(expectedSurface)) {
      throw new Error(`可见面应为 ${expectedSurface.join(', ') || '(空)'}，实际 ${names.join(', ') || '(空)'}`);
    }
    if (!anyConcrete) {
      console.log('[case B] PASS —— 没有可达的具体能力，平台入口一并消失');
      return;
    }

    // discover 只返回 entitlement 内的候选
    const discover = requireEnvelope(
      (await call(TOOL_SEARCH_TOOL, { mode: 'discover', query: 'hana', limit: 50 })).text,
      'discover 回执',
    );
    if (discover.success !== true || discover.data.mode !== 'discover') {
      throw new Error(`discover 应成功，实际：${JSON.stringify(discover).slice(0, 200)}`);
    }
    for (const card of discover.data.candidates) {
      if (card.inputSchema !== undefined) throw new Error('候选卡不得含完整 inputSchema');
      if (!capVisible(card.id)) throw new Error(`候选 ${card.id} 不在当前可见范围内`);
    }

    // 路由护栏：未知能力 / 平台入口自身 → 同一句拒绝文案（带一个有效披露 token）
    const probeCap = discover.data.candidates[0].id;
    const probeContract = requireEnvelope(
      (await call(TOOL_SEARCH_TOOL, { mode: 'contract', tools: [probeCap] })).text,
      'probe contract 回执',
    );
    if (probeContract.success !== true || typeof probeContract.data.contextToken !== 'string') {
      throw new Error(`probe contract 应签发 contextToken，实际：${JSON.stringify(probeContract).slice(0, 200)}`);
    }
    const token = probeContract.data.contextToken;
    const unknown = await call(INVOKE_TOOL, { capability: 'hana_does_not_exist', contextToken: token });
    const toPlatform = await call(INVOKE_TOOL, { capability: TOOL_SEARCH_TOOL, contextToken: token });
    if (!unknown.isError || !toPlatform.isError) throw new Error('未知/平台入口目标必须是硬错误');
    assertSameUnknownRefusal([unknown.text, toPlatform.text]);

    // 具体能力在协议层不可直调
    const direct = await call('hana_data_preview', {});
    if (direct.error === undefined) {
      throw new Error(`具体能力不应可直调，实际拿到了 result：${direct.text.slice(0, 120)}`);
    }
    console.log('[case B] PASS');
  });
}

/** 用例 C：披露零面变更 + 契约路由到 hana_invoke */
async function caseDisclosure() {
  console.log('[case C] 契约披露：零面变更 + call.via=hana_invoke');
  const env = { ...BASE_ENV };
  for (const k of SURFACE_ENV_KEYS) delete env[k];
  await withServer(env, async ({ request, initialize, call, notifications }) => {
    await initialize('smoke-stdio-disclosure');
    const before = (await request('tools/list')).tools.map((t) => t.name);
    if (JSON.stringify(before) !== JSON.stringify(DEFAULT_SURFACE_ORDER)) {
      throw new Error(`前提失败：工具面应为 ${DEFAULT_SURFACE_ORDER.join(', ')}，实际 ${before.join(', ')}`);
    }

    const contract = requireEnvelope(
      (
        await call(TOOL_SEARCH_TOOL, {
          mode: 'contract',
          tools: ['hana_metadata_get_view', 'hana_data_preview_diagnose'],
        })
      ).text,
      'contract 回执',
    );
    if (contract.success !== true || contract.data.mode !== 'contract' || contract.data.tools.length !== 2) {
      throw new Error(`contract 应返回两个完整契约，实际：${JSON.stringify(contract).slice(0, 300)}`);
    }
    for (const t of contract.data.tools) {
      if (!t.inputSchema?.properties || !Array.isArray(t.required)) {
        throw new Error(`${t.id} 的契约缺 inputSchema/required`);
      }
      if (t.call?.via !== INVOKE_TOOL || t.canonicalCall?.via !== INVOKE_TOOL) {
        throw new Error(`${t.id} 的 call.via/canonicalCall.via 应为 ${INVOKE_TOOL}，实际 ${t.call?.via}`);
      }
    }

    const goal = requireEnvelope(
      (
        await call(TOOL_SEARCH_TOOL, {
          mode: 'goal',
          goal: 'diagnose_preview_permission',
          bindings: { packageId: 'ZDEMO.ZDEMO01', objectName: 'ZDEMO11' },
        })
      ).text,
      'goal 回执',
    );
    if (goal.success !== true || goal.data.mode !== 'goal' || !goal.data.steps.length) {
      throw new Error(`goal 应返回配方步骤，实际：${JSON.stringify(goal).slice(0, 300)}`);
    }
    for (const step of goal.data.steps) {
      if (step.via !== INVOKE_TOOL) throw new Error(`配方步骤 ${step.id} 的 via 应为 ${INVOKE_TOOL}`);
    }

    // invoke 的 schema 错误在派发前拒绝（不触库）：token 覆盖 get_view，但参数缺必填
    const token = contract.data.contextToken;
    if (typeof token !== 'string') throw new Error('contract 回执必须签发 contextToken');
    const bad = await call(INVOKE_TOOL, { capability: 'hana_metadata_get_view', args: {}, contextToken: token });
    if (!bad.isError || !/参数不符合/.test(bad.text)) {
      throw new Error(`invoke 非法参数应被拒绝，实际：${bad.text.slice(0, 200)}`);
    }
    // 披露集合之外的能力：在参数校验前被拒绝
    const outside = await call(INVOKE_TOOL, {
      capability: 'hana_metadata_list_fields',
      args: { packageId: 'ZDEMO.ZDEMO01', objectName: 'ZDEMO11' },
      contextToken: token,
    });
    if (!outside.isError || !/capability_not_disclosed/.test(outside.text)) {
      throw new Error(`披露集合外能力应被拒绝，实际：${outside.text.slice(0, 200)}`);
    }

    await sleep(200);
    const after = (await request('tools/list')).tools.map((t) => t.name);
    if (JSON.stringify(after) !== JSON.stringify(before)) {
      throw new Error(`披露/执行不得改变工具面：前 ${before.join(', ')}；后 ${after.join(', ')}`);
    }
    const listChangedCount = notifications.filter((n) => n.method === 'notifications/tools/list_changed').length;
    if (listChangedCount !== 0) throw new Error(`不应发 tools/list_changed，实际 ${listChangedCount} 次`);
    console.log('[case C] PASS —— 披露零面变更，执行统一经 hana_invoke');
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  await caseRegisteredSurface();
  await caseVisibilityAndGuard();
  await caseDisclosure();
  console.log('\n[smoke] PASS');
} catch (e) {
  console.error('[smoke] FAIL:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
}
