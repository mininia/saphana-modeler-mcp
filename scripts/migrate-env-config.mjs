#!/usr/bin/env node
/**
 * 多环境配置迁移检查（只读，不修改文件）。
 *
 * 用法：
 *   node scripts/migrate-env-config.mjs --file mcp.json --check
 *   node scripts/migrate-env-config.mjs --file .env --suggest
 *
 * 检查项：
 * - 多环境下扁平连接键（必须改成 HANA_<PARAM>_ENV_<XXXX>）；
 * - HANA_LABEL / HANA_LABEL_ENV_*（已移除，建议用旧 LABEL 的大写形式做环境键）；
 * - 每个环境缺失的 HOST/PORT/USER/PASSWORD；
 * - 大小写不敏感的重复 _ENV_ 键；
 * - HANA_ENV_START / HANA_ENV_SWITCHABLE 是否需要改用环境标识。
 *
 * 不读取 .env 的隐式合并：只分析指定文件里的 env。
 */

import { readFileSync } from 'node:fs';

const CONNECTION = [
  'HOST',
  'PORT',
  'USER',
  'PASSWORD',
  'DB_NAME',
  'TLS',
  'SSL_VALIDATE',
  'LOCALE',
  'XS_PORT',
  'XS_TLS',
  'XS_BASE_PATH',
];
const REQUIRED = ['HOST', 'PORT', 'USER', 'PASSWORD'];
const GLOBAL = new Set([
  'HANA_ENV_START',
  'HANA_ENV_SWITCHABLE',
  'HANA_ENV_MODE',
  'HANA_ENV_INHERIT',
  'HANA_ENV_LOAD_DOTENV',
]);

const args = process.argv.slice(2);
const argOf = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : def;
};
const file = argOf('--file', 'mcp.json');
const suggest = args.includes('--suggest');

const mask = (key, value) => (/PASSWORD|TOKEN/i.test(key) ? '***' : value);

function parseDotEnv(text) {
  const env = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const m = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    env[m[1]] = value;
  }
  return env;
}

function loadTargets() {
  const raw = readFileSync(file, 'utf8');
  if (file.endsWith('.json')) {
    const data = JSON.parse(raw);
    const servers = data.mcpServers ?? data.servers ?? {};
    const out = [];
    for (const [name, server] of Object.entries(servers)) {
      if (server && typeof server === 'object' && server.env && typeof server.env === 'object') {
        out.push({ name, env: server.env });
      }
    }
    return out;
  }
  return [{ name: file, env: parseDotEnv(raw) }];
}

function analyze(name, env) {
  const lines = [];
  const keys = Object.keys(env);
  const scoped = keys.filter(
    (k) => (k.startsWith('HANA_') && k.includes('_ENV_') && !GLOBAL.has(k)) || /^(MCP|LOG)_.*_ENV_/.test(k),
  );
  if (scoped.length === 0) {
    lines.push(`[单环境] ${name}: 未发现 _ENV_ 变量，无需迁移。`);
    return { lines, suggestions: [] };
  }

  lines.push(`[多环境] ${name}: 发现 ${scoped.length} 个 _ENV_ 变量。`);
  const suggestions = [];

  // 扁平连接键
  const flat = CONNECTION.filter((p) => (env[`HANA_${p}`] ?? '').trim() !== '');
  if (flat.length > 0) {
    lines.push(`  ✖ 扁平连接键：${flat.map((p) => `HANA_${p}`).join(', ')}`);
    lines.push('    → 多环境下必须改成 HANA_<PARAM>_ENV_<XXXX>；扁平值不会生效。');
    for (const p of flat) {
      suggestions.push(
        `HANA_${p}_ENV_DEFAULT=${mask(`HANA_${p}`, env[`HANA_${p}`])}  # 迁移建议：原扁平值归到 DEFAULT 环境`,
      );
    }
  }

  // LABEL
  const labels = keys.filter((k) => k === 'HANA_LABEL' || k.startsWith('HANA_LABEL_ENV_'));
  if (labels.length > 0) {
    lines.push(`  ✖ 已移除的 LABEL：${labels.join(', ')}`);
    lines.push('    → 删除 LABEL；环境标识直接取 _ENV_ 键的 <XXXX>。');
    for (const k of labels) suggestions.push(`# 删除 ${k}=${mask(k, env[k])}`);
  }

  // 环境键与大小写冲突
  const byParamEnv = new Map();
  const envKeys = new Set();
  for (const k of scoped) {
    if (!k.startsWith('HANA_')) continue;
    const rest = k.slice('HANA_'.length);
    const m = rest.match(/^([A-Z_]+?)_ENV_(.+)$/);
    if (!m) continue;
    const param = m[1];
    const rawKey = m[2];
    if (!/^[A-Za-z][A-Za-z0-9_]{0,31}$/.test(rawKey)) {
      lines.push(`  ✖ 非法环境标识：${k}（<XXXX> 必须匹配 [A-Za-z][A-Za-z0-9_]{0,31}）`);
      continue;
    }
    const canonical = rawKey.toUpperCase();
    envKeys.add(canonical);
    const id = `${param}:${canonical}`;
    const previous = byParamEnv.get(id);
    if (previous && previous !== k) {
      lines.push(`  ✖ 仅大小写不同的重复键：${previous} 与 ${k}`);
    }
    byParamEnv.set(id, k);
  }

  // 每个环境缺的必填连接参数
  for (const envKey of [...envKeys].sort()) {
    const missing = REQUIRED.filter((p) => {
      const keysForParam = keys.filter((k) => {
        if (!k.startsWith(`HANA_${p}_ENV_`)) return false;
        return k.slice(`HANA_${p}_ENV_`.length).toUpperCase() === envKey;
      });
      return keysForParam.every((k) => (env[k] ?? '').trim() === '');
    });
    if (missing.length > 0) {
      lines.push(`  ✖ 环境 ${envKey} 缺少连接参数：${missing.map((p) => `HANA_${p}_ENV_${envKey}`).join(', ')}`);
    }
  }

  // START / SWITCHABLE
  const start = (env.HANA_ENV_START ?? '').trim();
  if (start !== '' && !envKeys.has(start.toUpperCase())) {
    lines.push(`  ✖ HANA_ENV_START=${start} 不在环境集合内；可用：${[...envKeys].join(', ') || '(无)'}`);
  }
  const switchable = (env.HANA_ENV_SWITCHABLE ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const key of switchable) {
    if (!envKeys.has(key.toUpperCase())) {
      lines.push(`  ✖ HANA_ENV_SWITCHABLE 含未知环境标识：${key}`);
    }
  }

  // 可选：建议把环境键改名为旧 LABEL 大写形式
  const labelMap = new Map();
  for (const k of labels) {
    if (k === 'HANA_LABEL') labelMap.set('DEFAULT', env[k]);
    else labelMap.set(k.slice('HANA_LABEL_ENV_'.length).toUpperCase(), env[k]);
  }
  if (labelMap.size > 0) {
    lines.push('  → 建议把环境键改成旧 LABEL 的大写形式（保持回执/审计名字不变）：');
    for (const [key, label] of labelMap) {
      lines.push(`    ${key} → ${String(label).trim().toUpperCase().replace(/-/g, '_')}`);
    }
  }

  lines.push('  → 策略/授权参数（ACCESS / WRITE_PACKAGES / READ_SCHEMA / 超时与池）扁平值继续作为共享值，无需迁移。');
  lines.push('  → 用 --suggest 输出建议行；本脚本只读，不会改写文件。');
  return { lines, suggestions };
}

let failed = false;
try {
  const targets = loadTargets();
  for (const target of targets) {
    const { lines, suggestions } = analyze(target.name, target.env);
    console.log(lines.join('\n'));
    if (suggest) {
      console.log('  --- 建议行 ---');
      for (const s of suggestions) console.log(`  ${s}`);
    }
    console.log('');
    if (lines.some((l) => l.trim().startsWith('✖'))) failed = true;
  }
} catch (e) {
  console.error(`迁移检查失败：${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
process.exit(failed ? 2 : 0);
