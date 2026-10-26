/**
 * 工具功能分组与可见性过滤。
 *
 * 分组映射由能力清单的 kind 字段派生（单一事实源在 capabilities/manifest.ts），
 * 本模块只保留可见性算法：解析 env、glob 匹配、优先级。
 *
 * 三个变量（详见 README「工具分组与可见性控制」）：
 * - HANA_TOOL_GROUPS  启用的分组（逗号分隔）；空=全启用
 * - HANA_TOOL_ALLOW   强制启用的工具名 glob
 * - HANA_TOOL_DENY    强制禁用的工具名 glob（优先级最高；命中父工具会连带关闭其别名）
 * 优先级：deny > allow > 分组开关。
 */

import { splitList } from '../core/text.js';
import { CAPABILITY_LIST, findCapability, membersOfCategory } from '../capabilities/manifest.js';

/** 工具功能分组 */
export type ToolGroup = 'read' | 'write' | 'admin';

/** 全部分组（用于配置校验与日志） */
export const ALL_TOOL_GROUPS: readonly ToolGroup[] = ['read', 'write', 'admin'];

/** 分组中文标签（日志/文档用） */
export const GROUP_LABELS: Record<ToolGroup, string> = {
  read: '数据读取',
  write: '写操作',
  admin: '管理操作',
};

/**
 * 工具→分组映射（由能力清单派生）。新增能力须在 defs 里登记 kind——未登记 = 不暴露（fail-closed）。
 */
export const TOOL_GROUPS: Record<string, ToolGroup> = Object.fromEntries(CAPABILITY_LIST.map((c) => [c.id, c.kind]));

/** 工具过滤配置（来自环境变量，启动时解析一次） */
export interface ToolFilterConfig {
  /** 启用的分组集合。空集合=不限制（全部分组启用，向后兼容默认） */
  enabledGroups: Set<ToolGroup>;
  /** 强制启用的工具名 glob 模式（即便其分组未启用也注册） */
  allowPatterns: string[];
  /** 强制禁用的工具名 glob 模式（优先级最高，覆盖 allow 与分组） */
  denyPatterns: string[];
}

/** 分组名 → 该分组下的全部工具名（由 TOOL_GROUPS 反查，保持单一事实源） */
function toolsOfGroup(group: ToolGroup): string[] {
  return Object.entries(TOOL_GROUPS)
    .filter(([, g]) => g === group)
    .map(([name]) => name);
}

/**
 * 把 allow/deny 里的组名展开成该组的全部工具名；非组名 token 原样保留。
 * 对齐 tableau-mcp 的 INCLUDE_TOOLS/EXCLUDE_TOOLS 支持组名的做法。
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
 * 解析环境变量为 ToolFilterConfig。分组名大小写不敏感，未知分组名抛错（fail-closed）；
 * allow/deny 里的组名展开成工具名。
 */
export function parseToolFilter(rawGroups: string, rawAllow: string, rawDeny: string): ToolFilterConfig {
  const groups = splitList(rawGroups).map((g) => g.toLowerCase());
  if (groups.length > 0) {
    const invalid = groups.filter((g) => !ALL_TOOL_GROUPS.includes(g as ToolGroup));
    if (invalid.length > 0) {
      throw new Error(`HANA_TOOL_GROUPS 含未知分组：${invalid.join(', ')}；合法值：${ALL_TOOL_GROUPS.join(', ')}`);
    }
  }
  return {
    enabledGroups: new Set(groups as ToolGroup[]),
    allowPatterns: expandGroupTokens(splitList(rawAllow)),
    denyPatterns: expandGroupTokens(splitList(rawDeny)),
  };
}

/**
 * 非门面能力的可见性判定（deny 已先行扣除）：allow 优先，其次分组开关。
 * 门面不走这里。
 */
function registerableByName(name: string, filter: ToolFilterConfig): boolean {
  // 按自有属性查表：TOOL_GROUPS 继承 Object.prototype，'toString' 一类名字会取到继承成员。
  if (!Object.prototype.hasOwnProperty.call(TOOL_GROUPS, name)) return false;
  const group = TOOL_GROUPS[name];
  if (group === undefined) return false; // 未登记 = 不暴露（fail-closed）
  if (matchGlob(name, filter.allowPatterns)) return true;
  if (filter.enabledGroups.size === 0) return true;
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
 * 门面层不做限制：门面是入口，不参与分组过滤，谁的能力可用由能力层的 kind 决定
 * （只读部署仍看得到 hana_modeling，只是索引里只剩 read 档成员）。deny 仍最高：
 * 命中门面 id 或 deny 掉它全部成员时门面才消失。
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
  // 2) 门面：入口不参与分组过滤（门面层不做限制）；只有"全部成员被 deny"才让它消失
  //    成员是否被 deny 用同一条别名感知判定，与 1b 保持同一口径
  if (cap.facadeOf !== undefined) {
    return membersOfCategory(cap.facadeOf).some((m) => !deniedByPatterns(m, filter.denyPatterns));
  }
  // 3) 具体能力：allow 优先，其次分组开关
  return registerableByName(name, filter);
}
