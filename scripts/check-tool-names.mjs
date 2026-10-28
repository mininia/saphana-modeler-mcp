#!/usr/bin/env node
/**
 * 工具名一致性守卫（P1-8）——零依赖、只读源码文本。
 *
 * 为什么需要它：工具改名后，instructions / 规则库 / 描述里的旧名会静默指向不存在的工具，
 * 模型照着调用只会拿到「未知能力」。Tableau 曾因同类漂移一个多月才发现。
 *
 * 口径：
 * - 扫描范围 = SERVER_INSTRUCTIONS（src/server.ts）、规则库（src/rules/*.rules.ts）、
 *   能力声明与门面（src/capabilities 目录下的 .ts）、工具层文案（src/tools 目录下的 .ts）；
 * - 提取 `hana_*` token（字母/数字/下划线），**token 级**匹配：`hana_view_update#add_join`
 *   会被切成 `hana_view_update`，不会误判为未知能力；
 * - 以下 token 是占位/通配，不参与断言：`hana_`、以 `_` 结尾的 `hana_xxx_*` 家族写法；
 * - 合法集合 = 清单里登记的 id（从 defs 的 `id: '...'` 与分类目录派生的六个门面）
 *   ∪ 显式 REMOVED_TOOL_NAMES（改名/删除留档，附说明）；
 * - 扫描 0 个文件 = 失败（防止路径写错后"全绿"）。
 *
 * 退出码：0 全绿；1 有未登记 token；2 扫描面为空。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 已删除/改名的工具名留档（每条必须写原因；不要让旧引用静默消失） */
const REMOVED_TOOL_NAMES = new Set([
  // 示例形态（当前为空）：'hana_old_tool', // 2026-10-xx 改名为 hana_new_tool
]);

/** 扫描范围（目录递归 / 单文件） */
const SCAN_TARGETS = [
  { path: 'src/server.ts', kind: 'file' },
  { path: 'src/rules', kind: 'dir', match: /\.rules\.ts$/ },
  { path: 'src/capabilities', kind: 'dir', match: /\.ts$/ },
  { path: 'src/tools', kind: 'dir', match: /\.ts$/ },
];

/** 读取清单里登记的工具 id（defs 的 `id: 'hana_...'`）+ 六个门面 */
function registeredNames() {
  const names = new Set();
  const defsDir = join(ROOT, 'src/capabilities/defs');
  for (const file of readdirSync(defsDir)) {
    if (!file.endsWith('.ts')) continue;
    const text = readFileSync(join(defsDir, file), 'utf8');
    for (const m of text.matchAll(/\bid:\s*'((?:hana_)[a-z0-9_]+)'/g)) names.add(m[1]);
  }
  // 门面 id 由分类目录派生（src/capabilities/types.ts 的 FACADE_CATEGORIES）
  const types = readFileSync(join(ROOT, 'src/capabilities/types.ts'), 'utf8');
  const block = types.match(/export const FACADE_CATEGORIES\s*=\s*\[([\s\S]*?)\]/);
  if (!block) {
    console.error('工具名守卫中止：读不到 FACADE_CATEGORIES（派生门面名的唯一来源）');
    process.exit(2);
  }
  for (const m of block[1].matchAll(/'([a-z]+)'/g)) names.add(`hana_${m[1]}`);
  return names;
}

/** 展开扫描范围 → [{ file, text }] */
function collectFiles() {
  const files = [];
  const push = (abs) => files.push({ file: abs, text: readFileSync(abs, 'utf8') });
  for (const target of SCAN_TARGETS) {
    const abs = join(ROOT, target.path);
    let stat;
    try {
      stat = statSync(abs);
    } catch {
      continue;
    }
    if (target.kind === 'file' && stat.isFile()) {
      push(abs);
      continue;
    }
    if (target.kind === 'dir' && stat.isDirectory()) {
      // 递归：src/capabilities 的描述都在 defs/ 子目录里，只扫顶层等于漏掉最大的漂移面。
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const child = join(dir, entry.name);
          if (entry.isDirectory()) walk(child);
          else if (target.match.test(entry.name)) push(child);
        }
      };
      walk(abs);
    }
  }
  return files;
}

/** 跳过说明性占位：`hana_`、`hana_xxx_`（通配家族、`hana_<分类>` 模板被截出来的半截 token） */
function isPlaceholder(token) {
  return token === 'hana_' || token.endsWith('_');
}

function main() {
  const registered = registeredNames();
  const files = collectFiles();
  if (files.length === 0) {
    console.error('工具名守卫中止：扫描面为 0 个文件（路径写错？源码结构变了？）');
    process.exit(2);
  }

  const offenders = [];
  for (const { file, text } of files) {
    const lines = text.split(/\r?\n/);
    lines.forEach((line, idx) => {
      for (const m of line.matchAll(/\bhana_[a-z0-9_]+/g)) {
        const token = m[0];
        if (isPlaceholder(token)) continue;
        if (registered.has(token) || REMOVED_TOOL_NAMES.has(token)) continue;
        offenders.push({ file: relative(ROOT, file), line: idx + 1, token });
      }
    });
  }

  if (offenders.length > 0) {
    console.error(`工具名守卫失败：${offenders.length} 处引用了未登记的工具名（改名后文档/文案漂移？）`);
    for (const o of offenders) console.error(`  ${o.file}:${o.line}  ${o.token}`);
    console.error('处置：改回已登记 id，或在 scripts/check-tool-names.mjs 的 REMOVED_TOOL_NAMES 留档。');
    process.exit(1);
  }

  console.log(`工具名守卫通过：扫描 ${files.length} 个文件，全部 hana_* token 均在清单内。`);
}

main();
