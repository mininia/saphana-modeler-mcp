/**
 * stdio 冒烟测试：真实启动 dist/index.js，走完整 MCP JSON-RPC 握手，
 * 验证 tools/list 注册、annotations 透出，以及**门面索引**与**路由护栏**（黑盒协议层）。
 *
 * 只调用**不触库**的路径：门面不带参数调用 = 只读清单；路由到未知/跨类能力 = 入口即拒。
 * 真实的业务调用会触数据库，留在本地 test-verification/（不入库）。
 *
 * 用法：node scripts/smoke-stdio.mjs（package.json 的 smoke 脚本已含 build）
 *
 * 两个用例（2026-10-09 起，分类门面制）：
 *   A. **注册面**：tools/list 应恰好是六个分类门面（顺序固定），占位工具不出现；annotations 透出。
 *   B. **门面行为 + 可见性过滤自检**：每个门面的索引条数与可见成员数一致、不含门面自己；
 *      未知能力与跨类路由回**同一句**未知能力；若另配了 MCP_TOOL_GROUPS / MCP_TOOL_ALLOW /
 *      MCP_TOOL_DENY（旧名 HANA_TOOL_* 同义），额外校验**能力层**收窄结果（门面层不做限制，
 *      六个入口恒在；索引可能为空——入口在、里面没有你可用的能力）：
 *        MCP_TOOL_GROUPS=read node scripts/smoke-stdio.mjs   # 只读部署：六门面恒在，modeling/diagnostics 索引为空
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

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

/** dummy 配置：仅用于让 config 校验通过，本脚本不调用任何触库工具 */
const BASE_ENV = {
  ...process.env,
  HANA_HOST: 'dummy.local',
  HANA_INSTANCE: '00',
  HANA_PORT: '',
  HANA_USER: 'dummy',
  HANA_PASSWORD: 'dummy',
  HANA_LOCALE: 'zh_CN',
  HANA_TLS: 'false',
  HANA_TIMEZONE: 'Asia/Shanghai',
};

/**
 * 分类 → 成员能力（与 src/capabilities/defs/*.ts 的 category 声明一致）。
 * 门面层不做限制后，这张表用于两件事：门面索引条数（按能力层过滤后的成员数）与 deny 传播
 * （"deny 掉全部成员 → 门面消失"）。
 */
const FACADE_MEMBERS = {
  hana_system: ['hana_system_get_info', 'hana_check_privileges'],
  hana_discovery: [
    'hana_package_list',
    'hana_package_list_objects',
    'hana_metadata_get_view',
    'hana_metadata_search_objects',
    'hana_metadata_list_fields',
    'hana_table_list',
    'hana_table_columns',
  ],
  hana_data: ['hana_data_preview', 'hana_data_preview_diagnose'],
  hana_insights: ['hana_metadata_get_field_logic', 'hana_metadata_where_used'],
  hana_modeling: [
    'hana_package_create',
    'hana_repo_export',
    'hana_repo_import',
    'hana_view_create',
    'hana_view_activate',
    'hana_view_update',
    'hana_view_delete',
    'hana_view_validate',
    'hana_view_check_actions',
    // 异步任务（2026-10-10）：服务变更集流程的轮询/取消入口
    'hana_task_get',
    'hana_task_cancel',
    // 操作级别名（routeOnly）：可路由、进门面索引，但不注册为工具（上面的"不应直接注册"断言照样覆盖它们）
    'hana_view_update#add_join',
    'hana_view_update#set_script',
    'hana_view_update#set_description',
    'hana_view_update#rename_field',
    'hana_view_update#drop_field',
    'hana_view_update#add_calculated_column',
    'hana_view_update#set_attribute_filter',
    'hana_view_update#set_variable',
  ],
  hana_diagnostics: [
    'hana_repo_changelist',
    'hana_sql_analyze',
    'hana_system_health',
    'hana_system_activity',
    'hana_table_storage',
    'hana_system_trend',
  ],
};

/** 门面注册顺序（= FACADE_CATEGORIES） */
const FACADE_ORDER = [
  'hana_system',
  'hana_discovery',
  'hana_data',
  'hana_insights',
  'hana_modeling',
  'hana_diagnostics',
];

/** 能力 → 分组（分组映射单一事实源 = src/capabilities/defs/*.ts，src/tools/groups.ts 派生）。
 *  组名展开（deny=read 之类）用的是**清单全条目**，门面也按各自派生的 kind 进组——此处与之一致。 */
const READ_CAPS = new Set([
  'hana_system_get_info',
  'hana_check_privileges',
  'hana_package_list',
  'hana_package_list_objects',
  'hana_metadata_get_view',
  'hana_metadata_search_objects',
  'hana_metadata_list_fields',
  'hana_metadata_get_field_logic',
  'hana_metadata_where_used',
  'hana_table_list',
  'hana_table_columns',
  'hana_data_preview',
  'hana_data_preview_diagnose',
  // 派生 kind 为 read 的四个门面（toolsOfGroup 展开时会带上它们）
  'hana_system',
  'hana_discovery',
  'hana_data',
  'hana_insights',
]);
const WRITE_CAPS = new Set([
  'hana_package_create',
  'hana_view_create',
  'hana_view_activate',
  'hana_view_update',
  'hana_view_delete',
  'hana_view_validate',
  'hana_view_check_actions',
  'hana_sql_analyze',
]);
const ADMIN_CAPS = new Set([
  'hana_repo_export',
  'hana_repo_import',
  'hana_repo_changelist',
  'hana_system_health',
  'hana_system_activity',
  'hana_table_storage',
  'hana_system_trend',
  // 派生 kind 为 admin 的两个门面
  'hana_modeling',
  'hana_diagnostics',
]);

const timeout = setTimeout(() => {
  console.error('冒烟测试超时（60s）');
  process.exit(1);
}, 60_000);

/**
 * 启动一个 stdio server，跑完 fn 后关闭。
 * fn 收到 { request, send, initialize } 三个助手（initialize 必须最先调用）。
 */
async function withServer(env, fn) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'inherit'],
    env,
  });
  const rl = createInterface({ input: child.stdout });
  const pending = new Map();
  /** 服务端主动发的通知（id == null），如 notifications/tools/list_changed */
  const notifications = [];
  let nextId = 1;
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
    return await fn({ request, send, initialize, call, notifications });
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

/** 解析门面索引回执（envelope，JSON 文本，可能带 BOM） */
function indexOf(text) {
  return JSON.parse(text.replace(/^﻿/, ''));
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
        ? new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name)
        : p === name,
    );
  // 组名展开成该组全部成员（allow/deny 支持组名，与 parseToolFilter 同语义）
  const expandTokens = (raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .flatMap((t) => {
        if (t === 'read') return [...READ_CAPS];
        if (t === 'write') return [...WRITE_CAPS];
        if (t === 'admin') return [...ADMIN_CAPS];
        return [t];
      });
  const denyPatterns = expandTokens(deny);
  const allowPatterns = expandTokens(allow);
  const enabledGroups = groups
    ? groups
        .split(',')
        .map((g) => g.trim().toLowerCase())
        .filter(Boolean)
    : [];
  /** 单个具体能力是否可见（deny > allow > 分组；空分组 = 不限制） */
  const capVisible = (id) => {
    if (matchGlob(id, denyPatterns)) return false;
    if (matchGlob(id, allowPatterns)) return true;
    if (enabledGroups.length === 0) return true;
    const group = READ_CAPS.has(id) ? 'read' : WRITE_CAPS.has(id) ? 'write' : 'admin';
    return enabledGroups.includes(group);
  };
  /** 门面是否注册：**门面层不做限制**——恒在；只有显式 deny（命中门面 id，或全部成员被 deny）才消失 */
  const facadeVisible = (facade) =>
    !matchGlob(facade, denyPatterns) && FACADE_MEMBERS[facade].some((id) => !matchGlob(id, denyPatterns));

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
      const idx = indexOf((await call(facade, {})).text);
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
      ? indexOf((await call(expectedFacades[0], {})).text).data.items.map((i) => i.id)
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
      if (unknown.text !== cross.text || unknown.text !== toFacade.text) {
        throw new Error(`拒绝文案必须逐字相同，实际：\n${unknown.text}\n${cross.text}\n${toFacade.text}`);
      }
      if (!unknown.text.includes('未知能力')) throw new Error('拒绝文案应说"未知能力"');
      console.log('[route-guard] 未知 / 跨类 / 路由到门面 → 同一句拒绝文案');
    }

    assertAnnotations(tools, 'hana_modeling');
    console.log('[case B] PASS');
  });
}

/**
 * 用例 C：**提升**（P10-f，对齐 hana-cli 的 Dynamic Tool Promotion）。
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
    const idx = indexOf((await call('hana_data', {})).text);
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
