/**
 * 工具功能分组与可见性过滤。
 *
 * **分组的单一事实源已上移到能力清单**（`src/capabilities/manifest.ts` 的 `kind` 字段）：
 * 本模块不再自己维护工具→分组映射，而是从清单**派生** `TOOL_GROUPS`，
 * 只保留"可见性怎么算"（解析 env、glob 匹配、优先级）这部分纯逻辑。
 *
 * 三类分组：
 * - read  数据读取：只读访问 HANA 数据/元数据/系统信息/审计/导出（GET 类，不改动仓库）
 * - write 写操作：改动仓库设计时对象/包（create/activate/update/delete/import/设计时校验）
 * - admin 管理操作：高权限/管理类（传输/变更追踪 API、仓库变更审计，以及监视视图读权限档的稳定性诊断）
 *
 * 可见性由 mcp.json / .env 的三个变量控制（详见 README「工具分组与可见性控制」）：
 * - HANA_TOOL_GROUPS  启用的分组（逗号分隔）；空=全启用（默认，向后兼容）
 * - HANA_TOOL_ALLOW   强制启用的工具名 glob（即便其分组未启用也注册）
 * - HANA_TOOL_DENY    强制禁用的工具名 glob（优先级最高，覆盖 allow 与分组）；
 *                    命中父工具名会连带关闭它的操作级别名（`父名#<op>`），见 shouldRegisterTool
 * 优先级：deny > allow > 分组开关。
 *
 * 依赖方向：本模块 import 能力清单（清单不 import 本模块），故没有环。
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
 * 工具→分组映射（**由能力清单派生**，保持单一事实源）。
 * 新增能力时在清单的 `defs/<分类>.ts` 里登记 `kind`——只加注册代码而不登记清单，
 * 该能力既不注册也不可见（未登记 = 不暴露，fail-closed），并由 manifest 完整性测试拦下。
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
 * 把 allow/deny 里的**组名**展开成该组的全部工具名。
 *
 * 对齐两家参考的做法：tableau-mcp 的 INCLUDE_TOOLS/EXCLUDE_TOOLS 支持组名
 * （`isWebToolGroupName(v) ? webToolGroups[v] : []`），dataworks-mcp 直接按
 * TOOL_CATEGORIES 过滤。此前我们只认工具名 glob，想关掉一整组只能逐个写
 * `hana_view_*` 这类通配，既啰嗦又容易漏。
 *
 * 非组名的 token（工具名或 glob）原样保留。
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
 * glob 匹配：支持 * 通配（如 hana_metadata_* 匹配所有元数据工具）。
 * 不含 * 时按精确相等。空模式列表=不匹配任何工具。
 * 其余正则元字符（**含 `?`**）一律转义为字面量：本模式文法只有 `*` 一个通配——
 * 漏转义会让 `?` 变成"前一个字符可选"的正则量词，静默改变 allow/deny/档案的权限口径。
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
 * 解析环境变量为 ToolFilterConfig。
 * - 分组名大小写不敏感（统一转小写校验）；未知分组名抛错（fail-closed，启动即失败）。
 * - allow/deny 里的**组名**会展开成该组的全部工具名（见 expandGroupTokens），其余 token 原样保留
 *   （工具名大小写敏感，均为 hana_* 小写）。
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
 * 非门面能力的可见性判定（deny 已在调用方先行扣除）：allow 优先，其次分组开关。
 * 门面不走这里——入口不参与分组过滤（见 `shouldRegisterTool` 的「门面层不做限制」）。
 */
function registerableByName(name: string, filter: ToolFilterConfig): boolean {
  // 查表按**自有属性**判（与 manifest.isRegisteredCapability 同口径）：TOOL_GROUPS 继承 Object.prototype，
  // 'toString' / 'valueOf' / '__proto__' 一类名字会取到继承成员而不是 undefined——
  // 漏了这道判定，下面这条「未登记 = 不暴露」在它们身上就是 fail-open 的。
  if (!Object.prototype.hasOwnProperty.call(TOOL_GROUPS, name)) return false;
  const group = TOOL_GROUPS[name];
  if (group === undefined) return false; // 未登记 = 不暴露（fail-closed）
  if (matchGlob(name, filter.allowPatterns)) return true;
  if (filter.enabledGroups.size === 0) return true;
  return filter.enabledGroups.has(group);
}

/**
 * deny 命中判定：工具名命中 deny 模式即真；**操作级别名**（routeOnly，id = `父工具#op`）
 * 再按父工具 id 判一次——别名经门面路由直达父 handler，父被 deny 时别名必须一并失效，
 * 否则"禁用该写工具"的意图会被别名静默绕过。allow 方向**不**扩展（父 allow 不覆盖别名）：
 * 那是收紧方向的不对称，保持 fail-closed。
 */
function deniedByPatterns(cap: { id: string; module: string; routeOnly?: boolean }, patterns: string[]): boolean {
  if (matchGlob(cap.id, patterns)) return true;
  return cap.routeOnly === true && matchGlob(cap.module, patterns);
}

/**
 * 判定单个能力是否应注册（是否对 MCP 客户端可见）。
 * 优先级：deny（强制禁用）> allow（强制启用）> 分组开关。
 * 默认（全空配置）= 全部启用，行为与未引入该机制前完全一致（向后兼容）。
 *
 * **门面层不做限制（2026-10-09 定稿）**：权限只有**一层 group（能力层）**——门面（`hana_<分类>`）
 * 是**入口**，不参与分组开关过滤。六个入口常驻注册面，谁的能力可用由分组开关在**能力层**决定
 * （索引/路由/提升/调用一律按目标能力的 kind 判）。所以只读部署仍看得到 `hana_modeling` /
 * `hana_diagnostics`，只是索引里只剩 read 档成员（`hana_modeling` 剩 `hana_task_get`，`hana_diagnostics` 为空）——那是**可用性收窄**，
 * 不是自锁死：反过来也成立（只启用 write 时 `hana_diagnostics` 索引里有 `hana_sql_analyze`）。
 * deny 仍然最高优先级：命中门面 id、或 deny 掉它**全部**成员，门面才消失（显式移除 ≠ 分层限制）。
 *
 * **未登记 = 不暴露**（fail-closed）：名字不在能力清单里时返回 false。
 * 此前是"按 read 兜底"（fail-open）——那意味着一个漏登记的写工具会在只读部署里被注册出来。
 * 未登记的能力本来就没有注册代码、不可调用，这里只是让"不可见"与"不可调用"一致。
 *
 * **deny 覆盖操作级别名**：父工具（如 `hana_view_update`）被 deny 时，它的 `#<op>` 别名
 * （routeOnly，经门面路由直达父 handler）一并失效——否则"禁用该写工具"会被别名绕过。
 * allow 方向不扩展（父 allow 不覆盖别名，需写 `hana_view_update*`）：收紧方向的不对称。
 *
 * @param name 能力 id（工具级 = 工具名）
 * @param filter 过滤配置
 * @returns true=注册（客户端可见）/ false=跳过（不出现在 tools/list、不可调用）
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
