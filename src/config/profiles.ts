/**
 * 调用方档案（CallerProfile）—— MCP_PROFILES 的权限载体。
 *
 * ## 它解决什么
 *
 * 所有能力都过同一个调用期闸门（见 config/authorize.ts 的 authorizeCall），但闸门只知道
 * **部署级策略**（进程的 `HANA_TOOL_GROUPS/ALLOW/DENY` + `HANA_WRITE_PACKAGES` + `HANA_READ_SCHEMA`）。
 * 多客户端共享一个进程时（HTTP），每个调用方需要**自己的**面：只读的数据分析师、
 * 能建模但只能碰自己包的开发者、完全只读的 CI 探针。
 *
 * **只能收紧，不能放宽**：档案是"在部署策略之内再砍一刀"，
 * 它永远不能把部署级 DENY 的能力变回可见，也不能扩大可写包/可读 schema 的范围。
 * 越界组合（档案声称允许 write 而部署只暴露 read）在**启动自检**里 block 拒绝启动——
 * 那不是安全漏洞（天花板仍在），而是"运维以为的权限"与"实际权限"分叉，必须显式暴露。
 *
 * ## 文法
 *
 * ```
 * MCP_PROFILES = "name=kinds[:glob|glob][;name2=…]"
 *              kinds = read|write|admin 用 + 连接
 *              glob  = 能力 id 的 * 通配（| 分隔），复用 matchGlob
 * ```
 * 例：`analyst=read;dev=read+write:hana_view_*|hana_metadata_*;ci=read`
 *
 * 解析即校验（fail-fast）：名字非法/重复、kind 未知、条目格式错误、glob 为空——一律抛错。
 * 错误消息**不含凭据**（档案里没有凭据），但也不回显整条 env（保持与其它解析器一致的口径）。
 *
 * ## 未配置时的行为
 *
 * `MCP_PROFILES` 为空 ⇒ 只有**隐式 default 档案**（允许全部 kind、不限能力）——
 * 即"面 == 部署策略"：未启用档案机制的部署行为不变（向后兼容）。
 * 一旦配置了 `MCP_PROFILES`，就必须**同时定义 `default`**：HTTP 里没带第三段的 Token
 * 与 stdio 进程都要落到它，否则"没有档案"会被误读成"没有限制"。
 */

import { ALL_TOOL_GROUPS, matchGlob } from '../tools/groups.js';
import type { ToolKind } from '../capabilities/types.js';
import { IDENTITY_NAME_HINT, IDENTITY_NAME_RE } from '../core/text.js';

/** 全部 kind：直接取分组清单（tools/groups.ts 的 ALL_TOOL_GROUPS 是单一来源，此处不再手抄字面量） */
const ALL_KINDS: readonly ToolKind[] = ALL_TOOL_GROUPS;

/** 隐式默认档案 id（未配置 MCP_PROFILES 时唯一存在的档案） */
export const IMPLICIT_DEFAULT_PROFILE_ID = 'default';

/**
 * 调用方档案：在部署策略**之内**再收紧。
 * 与 `CallerIdentity`（谁来调用）分离：同一份档案可被多个身份使用（多个 Token 共享一个档案）。
 */
export interface CallerProfile {
  /** 档案名（MCP_PROFILES 里的 name / Token 第三段 / MCP_PROFILE） */
  id: string;
  /** 允许的能力归属（kind）。空数组 = 什么都不允许（fail-closed 的兜底形态） */
  allowKinds: ToolKind[];
  /** 允许的能力 id glob（`*` 通配）。缺省 = 不额外限制（= 部署策略允许的全部） */
  allowCapabilities?: string[];
  /**
   * 资源范围收紧（可选）：写包 / 读 schema 的**子集**。
   * 两个方向同口径：**声明了但为空数组 = 什么都不允许**（子集语义，fail-closed）——
   * 声明 `writePackages: []` 的档案在部署白名单内也一个包都写不了（不是"不收紧"）。
   * 当前 env 文法**不表达**它（文法只定义 kinds 与 glob 两段）——
   * 保留字段是为了让调用方（测试、未来的文法扩展、编程式构造）能直接设置，
   * 判定逻辑（config/authorize.ts 的 checkProfile）一次实现，不必等文法。
   */
  resourceScopes?: {
    writePackages?: string[];
    readSchemas?: string[];
  };
}

/** 未配置 MCP_PROFILES 时的隐式档案：不收紧任何维度 */
export const IMPLICIT_DEFAULT_PROFILE: CallerProfile = {
  id: IMPLICIT_DEFAULT_PROFILE_ID,
  allowKinds: [...ALL_KINDS],
};

/**
 * 解析 `MCP_PROFILES`。空串 = 空表（调用方应改用隐式 default 档案）。
 * 任何非法条目 **抛错**（启动失败），不做静默忽略——权限配置写错必须响亮。
 */
export function parseProfiles(raw: string): Map<string, CallerProfile> {
  const out = new Map<string, CallerProfile>();
  const text = raw.trim();
  if (text === '') return out;
  text.split(';').forEach((entryRaw, idx) => {
    const entry = entryRaw.trim();
    if (entry === '') throw new Error(`MCP_PROFILES 第 ${idx + 1} 项为空：条目形如 name=read+write:hana_view_*`);
    const eq = entry.indexOf('=');
    if (eq <= 0 || eq === entry.length - 1) {
      throw new Error(`MCP_PROFILES 第 ${idx + 1} 项格式非法：应为 name=kinds[:glob|glob]（kinds 用 + 连接）`);
    }
    const id = entry.slice(0, eq).trim();
    if (!IDENTITY_NAME_RE.test(id)) {
      throw new Error(`MCP_PROFILES 第 ${idx + 1} 项的档案名非法：${IDENTITY_NAME_HINT}`);
    }
    if (out.has(id)) throw new Error(`MCP_PROFILES 档案名重复：${id}`);

    const rest = entry.slice(eq + 1).trim();
    const colon = rest.indexOf(':');
    const kindsRaw = (colon >= 0 ? rest.slice(0, colon) : rest).trim();
    const globsRaw = colon >= 0 ? rest.slice(colon + 1).trim() : '';

    const kinds = kindsRaw
      .split('+')
      .map((k) => k.trim().toLowerCase())
      .filter((k) => k !== '');
    if (kinds.length === 0) {
      throw new Error(`MCP_PROFILES 档案 "${id}" 未声明任何 kind：应为 read/write/admin 用 + 连接`);
    }
    const invalid = kinds.filter((k) => !ALL_KINDS.includes(k as ToolKind));
    if (invalid.length > 0) {
      throw new Error(
        `MCP_PROFILES 档案 "${id}" 含未知 kind：${invalid.join(', ')}；合法值：${ALL_KINDS.join(', ')}（用 + 连接）`,
      );
    }

    // 冒号存在但 glob 段为空（如 `a=read:`）= 写法残缺，响亮失败；
    // 完全不写冒号（`a=read`）才是"不额外限制能力"
    if (colon >= 0 && globsRaw === '') {
      throw new Error(
        `MCP_PROFILES 档案 "${id}" 的 glob 段为空：要么整段省略（a=read），要么给出能力 glob（a=read:hana_view_*）`,
      );
    }
    const allowCapabilities = globsRaw === '' ? undefined : globsRaw.split('|').map((g) => g.trim());
    if (allowCapabilities?.some((g) => g === '')) {
      throw new Error(`MCP_PROFILES 档案 "${id}" 的能力 glob 含空项：应为 a|b 形式（仅 * 通配）`);
    }

    out.set(id, {
      id,
      // 去重且保持 ALL_KINDS 的稳定顺序（日志/报告里顺序一致，便于比对）
      allowKinds: ALL_KINDS.filter((k) => kinds.includes(k)),
      ...(allowCapabilities ? { allowCapabilities } : {}),
    });
  });
  return out;
}

/**
 * 取调用方生效的档案：优先用身份里带的（HTTP Token 第三段），否则用进程默认（`MCP_PROFILE`）。
 *
 * **未定义时返回 undefined**（而非隐式放宽）：调用方（`authorizeCall`）会把它当成
 * "空档案"→ 全拒。启动自检已保证配了 `MCP_PROFILES` 就一定解析得到，故这条路径只在
 * "配置被绕过"或编程错误时出现——此时 fail-closed 是对的方向。
 */
export function resolveProfile(
  profiles: ReadonlyMap<string, CallerProfile> | undefined,
  profileId: string | undefined,
): CallerProfile | undefined {
  // 缺表 = 未启用档案机制（等价于空表）：务实处理——测试/脚本会构造"最小 config"，
  // 那里没有档案字段；把它当致命错误会让一次工具调用崩在"内部错误"上，而不是给出策略结论。
  if (!profiles || profiles.size === 0) return IMPLICIT_DEFAULT_PROFILE;
  if (profileId === undefined) return undefined;
  return profiles.get(profileId);
}

/**
 * 本次调用的**生效档案**：身份自带的档案优先（HTTP Token 第三段），否则落进程默认（`MCP_PROFILE`）。
 *
 * 回退规则只此一处：注册面（tools/surface.ts 的 entitlement）、调用期闸门（tools/index.ts 的
 * gatedHandler）与门面路由（tools/capability.tools.ts）都经它取值——档案是权限收窄的唯一载体，
 * 任一处手抄这条回退都会让权限口径静默分裂。
 */
export function activeProfile(
  config: { profiles: ReadonlyMap<string, CallerProfile> | undefined; profileId: string },
  identity: { profileId?: string } | undefined,
): CallerProfile | undefined {
  return resolveProfile(config.profiles, identity?.profileId ?? config.profileId);
}

/** 档案面是否覆盖某个能力（kind + 能力 id glob）；只做**否定**判定，不做肯定授权 */
export function profileAllows(
  profile: CallerProfile | undefined,
  capabilityId: string,
  kind: ToolKind,
): { ok: boolean; code?: 'profile_unknown' | 'kind_not_allowed_by_profile' | 'capability_not_in_profile' } {
  if (!profile) return { ok: false, code: 'profile_unknown' };
  if (!profile.allowKinds.includes(kind)) return { ok: false, code: 'kind_not_allowed_by_profile' };
  if (profile.allowCapabilities && !matchGlob(capabilityId, profile.allowCapabilities)) {
    return { ok: false, code: 'capability_not_in_profile' };
  }
  return { ok: true };
}

/** 档案摘要（启动日志用；含每份档案的 kind 与 glob，不含任何凭据） */
export function describeProfiles(profiles: ReadonlyMap<string, CallerProfile>): string {
  if (profiles.size === 0) {
    return `未配置 MCP_PROFILES：只有隐式 ${IMPLICIT_DEFAULT_PROFILE_ID} 档案（面 == 部署策略，不额外收紧）`;
  }
  const parts = [...profiles.values()].map(
    (p) => `${p.id}[${p.allowKinds.join('+')}${p.allowCapabilities ? `:${p.allowCapabilities.join('|')}` : ''}]`,
  );
  return `已配置 ${profiles.size} 份档案：${parts.join(' ')}`;
}

/** 该档案的能力 glob 命中了给定 id 集合中的哪些（未声明 glob 时返回空数组 = "不限制"，不是"全命中"） */
export function matchedCapabilities(profile: CallerProfile, ids: readonly string[]): string[] {
  if (!profile.allowCapabilities) return [];
  return ids.filter((id) => matchGlob(id, profile.allowCapabilities as string[]));
}
