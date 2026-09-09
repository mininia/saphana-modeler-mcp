/**
 * 工具功能分组与可见性过滤（单一事实源）。
 *
 * 本模块为纯叶子模块（无外部依赖，不 import config/services/logger），可被 config 与 tools 双向引用而无环。
 *
 * 三类分组：
 * - read  数据读取：只读访问 HANA 数据/元数据/系统信息/审计/导出（GET 类，不改动仓库）
 * - write 写操作：改动仓库设计时对象/包（create/activate/update/delete/import/设计时校验）
 * - admin 管理操作：生命周期/审计/权限管理类（当前为空占位，预留给 hana_privilege_create 等后续工具）
 *
 * 可见性由 mcp.json / .env 的三个变量控制（详见 README「工具分组与可见性控制」）：
 * - HANA_TOOL_GROUPS  启用的分组（逗号分隔）；空=全启用（默认，向后兼容）
 * - HANA_TOOL_ALLOW   强制启用的工具名 glob（即便其分组未启用也注册）
 * - HANA_TOOL_DENY    强制禁用的工具名 glob（优先级最高，覆盖 allow 与分组）
 * 优先级：deny > allow > 分组开关。
 */

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
 * 工具→分组映射（单一事实源）。
 * 新增工具时必须在此登记其分组（测试会断言映射与实际注册一致，防漏配）。
 * 未登记的工具按 'read' 兜底（仅当 read 分组启用时注册），属编程错误，应由测试拦截。
 */
export const TOOL_GROUPS: Record<string, ToolGroup> = {
  // —— 数据读取（read）——
  hana_system_get_info: 'read',
  hana_check_privileges: 'read',
  hana_package_list: 'read',
  hana_package_list_objects: 'read',
  hana_metadata_get_view: 'read',
  hana_metadata_search_objects: 'read',
  hana_metadata_list_fields: 'read',
  hana_metadata_get_field_logic: 'read',
  hana_metadata_where_used: 'read',
  hana_table_list: 'read',
  hana_table_columns: 'read',
  hana_data_preview: 'read',
  hana_data_preview_diagnose: 'read',
  hana_view_check_actions: 'read',
  hana_repo_export: 'read',
  hana_repo_changelist: 'read',

  // —— 写操作（write）——
  // hana_view_validate 的 design 模式会短暂写入临时校验对象 _CHKTMP，故整工具归 write；
  // 不按 design/runtime 模式做混合划分，只读部署不暴露此工具。
  hana_package_create: 'write',
  hana_repo_import: 'write',
  hana_view_create: 'write',
  hana_view_activate: 'write',
  hana_view_update: 'write',
  hana_view_delete: 'write',
  hana_view_validate: 'write',

  // —— 管理操作（admin，占位）——
  // 预留：hana_privilege_create 等管理类工具登记于此
};

/** 工具过滤配置（来自环境变量，启动时解析一次） */
export interface ToolFilterConfig {
  /** 启用的分组集合。空集合=不限制（全部分组启用，向后兼容默认） */
  enabledGroups: Set<ToolGroup>;
  /** 强制启用的工具名 glob 模式（即便其分组未启用也注册） */
  allowPatterns: string[];
  /** 强制禁用的工具名 glob 模式（优先级最高，覆盖 allow 与分组） */
  denyPatterns: string[];
}

/** 逗号分隔 → 去空白 → 去空串 */
function splitTrim(s: string): string[] {
  return s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/**
 * glob 匹配：支持 * 通配（如 hana_metadata_* 匹配所有元数据工具）。
 * 不含 * 时按精确相等。空模式列表=不匹配任何工具。
 */
export function matchGlob(name: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  return patterns.some((p) => {
    if (!p.includes('*')) return p === name;
    // * → .*，其余字符转义
    const re = new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
    return re.test(name);
  });
}

/**
 * 解析环境变量为 ToolFilterConfig。
 * - 分组名大小写不敏感（统一转小写校验）；未知分组名抛错（fail-closed，启动即失败）。
 * - allow/deny 保留原样（工具名大小写敏感，均为 hana_* 小写）。
 */
export function parseToolFilter(
  rawGroups: string,
  rawAllow: string,
  rawDeny: string,
): ToolFilterConfig {
  const groups = splitTrim(rawGroups).map((g) => g.toLowerCase());
  if (groups.length > 0) {
    const invalid = groups.filter((g) => !ALL_TOOL_GROUPS.includes(g as ToolGroup));
    if (invalid.length > 0) {
      throw new Error(
        `HANA_TOOL_GROUPS 含未知分组：${invalid.join(', ')}；合法值：${ALL_TOOL_GROUPS.join(', ')}`,
      );
    }
  }
  return {
    enabledGroups: new Set(groups as ToolGroup[]),
    allowPatterns: splitTrim(rawAllow),
    denyPatterns: splitTrim(rawDeny),
  };
}

/**
 * 判定单个工具是否应注册（是否对 MCP 客户端可见）。
 * 优先级：deny（强制禁用）> allow（强制启用）> 分组开关。
 * 默认（全空配置）= 全部启用，行为与未引入该机制前完全一致（向后兼容）。
 *
 * @param name 工具名
 * @param filter 过滤配置
 * @returns true=注册（客户端可见）/ false=跳过（不出现在 tools/list、不可调用）
 */
export function shouldRegisterTool(name: string, filter: ToolFilterConfig): boolean {
  // 1) deny 最高优先级：命中即不注册
  if (matchGlob(name, filter.denyPatterns)) return false;
  // 2) allow 次之：命中即强制注册（即便其分组未启用）
  if (matchGlob(name, filter.allowPatterns)) return true;
  // 3) 分组开关：未登记分组的工具按 read 兜底
  const group = TOOL_GROUPS[name] ?? 'read';
  // enabledGroups 为空 = 不限制（全部分组启用）
  if (filter.enabledGroups.size === 0) return true;
  return filter.enabledGroups.has(group);
}
