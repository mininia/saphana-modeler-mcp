/**
 * stdio 冒烟测试：真实启动 dist/index.js，走完整 MCP JSON-RPC 握手，
 * 验证 tools/list 注册与 annotations 透出（黑盒协议层）。
 *
 * 不调用任何工具（工具全部触数据库），注入 dummy 配置仅用于通过 config 校验；
 * 实机验收脚本在本地 test-verification/（不入库）。
 *
 * 用法：node scripts/smoke-stdio.mjs（package.json 的 smoke 脚本已含 build）
 *
 * 可通过环境变量 HANA_TOOL_GROUPS / HANA_TOOL_ALLOW / HANA_TOOL_DENY 验证工具可见性过滤：
 *   HANA_TOOL_GROUPS=read node scripts/smoke-stdio.mjs   # 只读部署：只应见 read 组工具
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/server';

const child = spawn(process.execPath, ['dist/index.js'], {
  cwd: process.cwd(),
  stdio: ['pipe', 'pipe', 'inherit'],
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
  },
});

const rl = createInterface({ input: child.stdout });
const pending = new Map();
let nextId = 1;

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + '\n');
}

function request(method, params) {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    send({ jsonrpc: '2.0', id, method, params });
  });
}

rl.on('line', (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return; // 忽略非 JSON 行（如 pino 意外输出，理论上不应出现）
  }
  if (msg.id != null && pending.has(msg.id)) {
    const p = pending.get(msg.id);
    pending.delete(msg.id);
    if (msg.error) p.reject(new Error(JSON.stringify(msg.error)));
    else p.resolve(msg.result);
  }
});

const timeout = setTimeout(() => {
  console.error('冒烟测试超时（60s）');
  child.kill();
  process.exit(1);
}, 60_000);

try {
  const init = await request('initialize', {
    protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'smoke-stdio', version: '0.0.1' },
  });
  console.log('[handshake] negotiated protocol:', init.protocolVersion);
  // instructions 应在 initialize 结果中（SEP 增强）；仅提示不硬断言
  if (init.instructions) console.log('[instructions] 已下发（' + init.instructions.length + ' 字符）');

  send({ jsonrpc: '2.0', method: 'notifications/initialized' });

  const tools = await request('tools/list');
  const names = tools.tools.map((t) => t.name);
  console.log('[tools/list]', names.join(', '));

  // 工具可见性过滤自检（HANA_TOOL_GROUPS/HANA_TOOL_ALLOW/HANA_TOOL_DENY）
  const configuredGroups = (process.env.HANA_TOOL_GROUPS ?? '').trim();
  if (configuredGroups) {
    const groups = configuredGroups.split(',').map((g) => g.trim().toLowerCase());
    const allowPatterns = (process.env.HANA_TOOL_ALLOW ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    const denyPatterns = (process.env.HANA_TOOL_DENY ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    // read 组工具全集（分组映射见 src/tools/groups.ts）
    const READ_TOOLS = new Set([
      'hana_system_get_info', 'hana_check_privileges',
      'hana_package_list', 'hana_package_list_objects',
      'hana_metadata_get_view', 'hana_metadata_search_objects', 'hana_metadata_list_fields',
      'hana_metadata_get_field_logic', 'hana_metadata_where_used',
      'hana_table_list', 'hana_table_columns',
      'hana_data_preview', 'hana_data_preview_diagnose',
      'hana_view_check_actions', 'hana_repo_export', 'hana_repo_changelist',
    ]);
    const WRITE_TOOLS = new Set([
      'hana_package_create', 'hana_repo_import', 'hana_view_create', 'hana_view_activate',
      'hana_view_update', 'hana_view_delete', 'hana_view_validate',
    ]);
    const matchGlob = (name, patterns) => patterns.some((p) =>
      p.includes('*')
        ? new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(name)
        : p === name,
    );
    const shouldSee = (name) => {
      if (matchGlob(name, denyPatterns)) return false;
      if (matchGlob(name, allowPatterns)) return true;
      const isRead = READ_TOOLS.has(name);
      const isWrite = WRITE_TOOLS.has(name);
      const group = isRead ? 'read' : isWrite ? 'write' : 'admin';
      return groups.includes(group);
    };
    // 校验可见集合与预期一致（仅对已知 read/write 工具断言）
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) {
      const expected = shouldSee(name);
      const actual = names.includes(name);
      if (expected !== actual) {
        throw new Error(`工具可见性过滤异常：${name} 期望 ${expected ? '可见' : '隐藏'}，实际 ${actual ? '可见' : '隐藏'}`);
      }
    }
    console.log(`[tool-filter] 分组 ${groups.join(',')} → 可见 ${names.length} 个工具，符合预期`);
  }

  const expected = [
    'hana_system_get_info',
    'hana_check_privileges',
    'hana_metadata_list_fields',
    'hana_metadata_get_field_logic',
    'hana_metadata_where_used',
    'hana_table_list',
    'hana_table_columns',
  ];
  // 仅在未配置过滤变量时硬断言这批只读工具存在；配置了过滤则由上方 [tool-filter] 自检覆盖
  const filterConfigured = (process.env.HANA_TOOL_GROUPS ?? '').trim() || (process.env.HANA_TOOL_DENY ?? '').trim();
  const missing = expected.filter((n) => !names.includes(n));
  if (missing.length > 0 && !filterConfigured) {
    throw new Error(`工具未注册: ${missing.join(', ')}（若配置了 HANA_TOOL_GROUPS 限制，请确认这些工具所属分组已启用）`);
  }
  // annotations 应在 tools/list 中透出；优先取只读工具样本，配置过滤只剩占位工具时退而取其任意工具
  const sampleTool =
    tools.tools.find((t) => t.name === 'hana_metadata_get_field_logic') ??
    tools.tools.find((t) => t.annotations?.readOnlyHint);
  console.log('[annotations]', JSON.stringify(sampleTool?.annotations ?? '(未透出)'));
  if (!sampleTool?.annotations?.readOnlyHint) {
    throw new Error('annotations 未按约定透出（readOnlyHint 缺失）');
  }
  console.log('[smoke] PASS');
} catch (e) {
  console.error('[smoke] FAIL:', e.message);
  process.exitCode = 1;
} finally {
  clearTimeout(timeout);
  child.kill();
}
