/**
 * 工具功能分组与可见性过滤。
 *
 * 分组映射由能力清单的 kind 字段派生（单一事实源在 capabilities/manifest.ts），
 * 本模块只保留可见性算法：解析 env、glob 匹配、优先级。
 *
 * **只有两个能力面变量**：
 * - `HANA_TOOL_GROUPS`：组名（read/write/admin/sql）或能力 id/glob，同一逗号列表；
 *   空 = read/write/admin（sql 关闭）；显式列出 = 只启用列出的组/工具。
 * - `HANA_TOOL_DENY`：强制禁用的能力 glob（优先级最高；命中父工具会连带关闭其别名）。
 * 优先级：deny > 显式 enable > 默认组。
 */

import { splitList } from '../core/text.js';
import { CAPABILITY_LIST, findCapability } from '../capabilities/manifest.js';

/**
 * 工具功能分组。
 *
 * `sql` 是**默认关闭**的敏感分组（直接执行 HANA SQL）：空配置下只启用 read/write/admin，
 * 绝不因为「空=全部」顺带开启它；须显式 `HANA_TOOL_GROUPS=sql`（或直接写
 * `hana_sql_execute`），`HANA_TOOL_DENY` 仍最高。
 */
export type ToolGroup = 'read' | 'write' | 'admin' | 'sql';

/** 全部分组（用于配置校验与日志；顺序 = 日志里的展示顺序） */
export const ALL_TOOL_GROUPS: readonly ToolGroup[] = ['read', 'write', 'admin', 'sql'];

/** 分组中文标签（日志/文档用） */
export const GROUP_LABELS: Record<ToolGroup, string> = {
  read: '数据读取',
  write: '写操作',
  admin: '管理操作',
  sql: 'SQL 直接执行（默认关闭）',
};

/**
 * 工具→分组映射（由能力清单派生）。新增能力须在 defs 里登记 kind——未登记 = 不暴露（fail-closed）。
 */
export const TOOL_GROUPS: Record<string, ToolGroup> = Object.fromEntries(CAPABILITY_LIST.map((c) => [c.id, c.kind]));

/** 工具过滤配置（来自环境变量；启动时解析一次） */
export interface ToolFilterConfig {
  /** 启用的分组集合。空集合 + groupsExplicit=false = 默认 read/write/admin（sql 关闭） */
  enabledGroups: Set<ToolGroup>;
  /** 显式列出的能力 id/glob（即使不在启用分组内也可见） */
  allowPatterns: string[];
  /** 强制禁用的能力 id/glob（优先级最高，覆盖 allow 与分组） */
  denyPatterns: string[];
  /**
   * true = `HANA_TOOL_GROUPS` 被显式设置（非空）：
   * - 只写 glob 时，不会因为「组集合为空」回退到默认 read/write/admin；
   * - 显式只写组名时，未列出的组不启用。
   */
  groupsExplicit?: boolean;
}

/** 分组名 → 该分组下的全部工具名（由 TOOL_GROUPS 反查，保持单一事实源） */
function toolsOfGroup(group: ToolGroup): string[] {
  // 平台入口的 kind 只是注册占位；把它们展开进 read 组会让 `HANA_TOOL_DENY=read`
  // 连带把 tools/list 清空（写/管理能力还在 entitlement 内，却没有任何入口可达）。
  return Object.entries(TOOL_GROUPS)
    .filter(([name, g]) => g === group && findCapability(name)?.platform !== true)
    .map(([name]) => name);
}

/**
 * 把 deny 里的组名展开成该组的全部工具名；非组名 token 原样保留。
 * deny 用组名是「禁一整类」；enable 不用展开——组名直接进 enabledGroups。
 */
function expandGroupTokens(tokens: string[]): string[] {
  const out: string[] = [];
  for (const t of tokens) {
    const lower = t.toLowerCase();
    if (ALL_TOOL_GROUPS.includes(lower as ToolGroup)) {
      out.push(...toolsOfGroup(lower as ToolGroup));
    } else {
      out.push(t);
    }
  }
  return out;
}

/**
 * glob 匹配：只支持 * 通配，不含 * 时按精确相等；空模式列表=不匹配任何工具。
 * 其余正则元字符（含 ?）一律转义——漏转义会让 ? 变成量词，静默改变权限口径。
 */
export function matchGlob(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => {
    if (!p.includes('*')) return p === name;
    // * → .*，其余字符（含 ?）转义为字面量
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(name);
  });
}

/**
 * 解析 `HANA_TOOL_GROUPS` / `HANA_TOOL_DENY`（运行时路径）。
 *
 * `HANA_TOOL_GROUPS` 的 token 分两类：
 * - 组名（大小写不敏感）→ `enabledGroups`；
 * - 其余 → 能力 id/glob（`allowPatterns`）。
 * 空串 = 默认 read/write/admin（sql 关闭）；非空 = 显式声明（只写 glob 也不回退默认组）。
 */
function parseEnableAndDeny(rawEnable: string, rawDeny: string): ToolFilterConfig {
  const tokens = splitList(rawEnable);
  const groups: ToolGroup[] = [];
  const globs: string[] = [];
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (ALL_TOOL_GROUPS.includes(lower as ToolGroup)) groups.push(lower as ToolGroup);
    else globs.push(token);
  }
  return {
    enabledGroups: new Set(groups),
    allowPatterns: globs,
    denyPatterns: expandGroupTokens(splitList(rawDeny)),
    ...(tokens.length > 0 ? { groupsExplicit: true } : {}),
  };
}

/** 三参数签名（groups, allow, deny）：仅测试/内部兼容，不对应任何 env 变量 */
function parseLegacy(groupsRaw: string, allowRaw: string, denyRaw: string): ToolFilterConfig {
  const groups = splitList(groupsRaw).map((g) => g.toLowerCase());
  if (groups.length > 0) {
    const invalid = groups.filter((g) => !ALL_TOOL_GROUPS.includes(g as ToolGroup));
    if (invalid.length > 0) {
      throw new Error(`HANA_TOOL_GROUPS 含未知分组：${invalid.join(', ')}；合法值：${ALL_TOOL_GROUPS.join(', ')}`);
    }
  }
  return {
    enabledGroups: new Set(groups as ToolGroup[]),
    allowPatterns: expandGroupTokens(splitList(allowRaw)),
    denyPatterns: expandGroupTokens(splitList(denyRaw)),
    ...(groups.length > 0 ? { groupsExplicit: true } : {}),
  };
}

export function parseToolFilter(rawEnable: string, rawDeny: string): ToolFilterConfig;
/** @deprecated 三参数仅内部/测试兼容；env 侧只有 HANA_TOOL_GROUPS/HANA_TOOL_DENY */
export function parseToolFilter(rawGroups: string, rawAllow: string, rawDeny: string): ToolFilterConfig;
export function parseToolFilter(a: string, b: string, c?: string): ToolFilterConfig {
  return c === undefined ? parseEnableAndDeny(a, b) : parseLegacy(a, b, c);
}

/**
 * 从**某个环境**的配置构造过滤器。多环境下 `toolGroups` / `toolDeny` 可由
 * `HANA_TOOL_GROUPS_ENV_<KEY>` / `HANA_TOOL_DENY_ENV_<KEY>` 覆盖：
 * entitlement（发现/执行）必须按当前绑定环境编译，而不是进程级单例。
 */
export function toolFilterOf(
  config: { toolGroups?: string; toolDeny?: readonly string[] },
  fallback?: ToolFilterConfig,
): ToolFilterConfig {
  // 测试/脚本的最小 config 可能没有这两个字段：此时回退到调用方显式传入的 filter。
  if (fallback && config.toolGroups === undefined && config.toolDeny === undefined) return fallback;
  return parseToolFilter(config.toolGroups ?? '', (config.toolDeny ?? []).join(','));
}

/**
 * 具体能力的可见性判定（deny 已先行扣除）：allow 优先，其次分组开关。
 * 平台入口不走这里。
 *
 * **空配置的例外**：`enabledGroups.size === 0` 表示「默认启用 read/write/admin」，
 * 但 `sql` 组**默认关闭**——它接受任意 SQL（含写/管理类），不能靠「空=全部」顺带放开。
 * 显式 `HANA_TOOL_GROUPS=sql` 或 allow 命中才启用；deny 已在调用方先行扣除。
 */
function registerableByName(name: string, filter: ToolFilterConfig): boolean {
  // 按自有属性查表：TOOL_GROUPS 继承 Object.prototype，'toString' 一类名字会取到继承成员。
  if (!Object.prototype.hasOwnProperty.call(TOOL_GROUPS, name)) return false;
  const group = TOOL_GROUPS[name];
  if (group === undefined) return false; // 未登记 = 不暴露（fail-closed）
  if (matchGlob(name, filter.allowPatterns)) return true;
  if (filter.enabledGroups.size === 0) {
    // 空配置：默认 read/write/admin（sql 除外）
    if (filter.groupsExplicit !== true) return group !== 'sql';
    // 显式空 groups = 不启用任何分组（HANA_TOOL_GROUPS 非空但只含 glob 时）
    return false;
  }
  return filter.enabledGroups.has(group);
}

/**
 * deny 命中判定：工具名命中即真；操作级别名再按父工具 id 判一次（父被 deny 时别名一并失效）。
 */
function deniedByPatterns(cap: { id: string; module: string; routeOnly?: boolean }, patterns: string[]): boolean {
  if (matchGlob(cap.id, patterns)) return true;
  return cap.routeOnly === true && matchGlob(cap.module, patterns);
}

/**
 * 判定单个能力是否应注册（是否对 MCP 客户端可见）。优先级：deny > allow > 分组开关。
 * 全空配置 = 全部启用（向后兼容）。
 *
 * 平台入口不做限制：入口不参与分组过滤，谁的能力可用由 entitlement 决定。
 * deny 仍最高：显式 deny 平台入口会让整个选择/执行链消失。
 *
 * 未登记 = 不暴露（fail-closed）；deny 覆盖操作级别名（父被 deny 时别名一并失效），
 * allow 方向不扩展（需写 hana_view_update*）。
 *
 * @param name 能力 id（工具级 = 工具名）
 * @returns true=注册 / false=跳过（不出现在 tools/list、不可调用）
 */
export function shouldRegisterTool(name: string, filter: ToolFilterConfig): boolean {
  // 1) deny 最高优先级：命中即不注册
  if (matchGlob(name, filter.denyPatterns)) return false;
  const cap = findCapability(name);
  if (cap === undefined) return false; // 未登记 = 不暴露（fail-closed）
  // 1b) 按条目再判一次 deny：操作级别名会跟随父工具 id（见 deniedByPatterns）
  if (deniedByPatterns(cap, filter.denyPatterns)) return false;
  // 1c) 平台入口（hana_tool_search / hana_invoke）：不受 HANA_TOOL_GROUPS 分组限制
  //     （只读部署/只开写组都应能发现并执行能力）。是否真的可见由 entitlement 的
  //     「至少一个具体能力可见」决定（见 config/policy-snapshot.ts）。
  if (cap.platform === true) return true;
  // 2) 具体能力：allow 优先，其次分组开关
  return registerableByName(name, filter);
}
