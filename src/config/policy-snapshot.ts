/**
 * 策略快照（PolicySnapshot）——把「能力面 / 资源范围 / 环境」在**调用入口**编译成一个不可变形状。
 *
 * 目的：让 `hana_tool_search` 的 `policy` 与 `authorizeCall` 引用同一份 entitlement/scope/rev，
 * 而不是在披露侧再写一套四参数交叉。
 *
 * 三条边界：
 * - 档案是**叠加层**：kind/glob 折进 entitlement，writePackages/readSchemas 与部署 scope 求交，
 *   不是第五个独立闸门；
 * - 空值三态分开：`unconfigured` / `system-only` / `deny-all` / `allowlist` 不共用一个 `[]`；
 * - `epoch` 是运行时代际，**不进 rev**（只参与 disclosureId/缓存过期关联）。
 */

import { createHash } from 'node:crypto';
import { CAPABILITY_LIST, findCapability, manifestRev } from '../capabilities/manifest.js';
import { isPlatformToolId, PLATFORM_TOOL_IDS, type Capability } from '../capabilities/types.js';
import { IMPLICIT_DEFAULT_PROFILE, profileAllows, type CallerProfile } from './profiles.js';
import { isPackageAllowed } from './write-boundary.js';
import { isSchemaAllowedWith } from '../core/sql.js';
import { shouldRegisterTool, type ToolFilterConfig } from '../tools/groups.js';
import type { HanaConfig } from './config.js';
import type { EnvironmentRuntime } from './environment-runtime.js';

export type WriteScopeMode = 'unconfigured' | 'allowlist' | 'deny-all';
export type ReadScopeMode = 'unconfigured' | 'system-only' | 'allowlist';

export interface PolicySnapshot {
  /** 策略代际（sha256 前 16 位；不含 epoch） */
  rev: string;
  /** 可见能力（含操作级别名/平台入口）；空 = 全拒 */
  entitlement: ReadonlySet<string>;
  scope: {
    write: {
      mode: WriteScopeMode;
      persistent: boolean;
      packages: readonly string[];
      sqlPolicy: 'select-only' | 'deny';
    };
    read: {
      mode: ReadScopeMode;
      schemas: readonly string[];
    };
  };
  environment: {
    multiEnv: boolean;
    envKey: string;
    epoch: number;
    access: 'readwrite' | 'readonly';
  };
  profileId: string;
}

export interface SnapshotInput {
  config: HanaConfig;
  toolFilter: ToolFilterConfig;
  profile?: CallerProfile;
  multiEnv: boolean;
  switchable: readonly string[];
  /** HTTP 部署不支持进程级切换：hana_env_switch 不可见 */
  httpPort?: number;
  runtime?: EnvironmentRuntime;
}

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * 策略代际（唯一计算源）：清单代际 + 归一化能力/资源/档案 + 当前环境。
 * **不含 epoch**（epoch 单独参与 disclosureId/缓存键）。
 */
export interface PolicyRevInput {
  capability: ToolFilterConfig;
  resource: { writePackages: readonly string[]; schemaAllow: readonly string[] };
}

export function policyRevFromPolicy(
  policy: PolicyRevInput,
  profile: CallerProfile | undefined,
  runtime: EnvironmentRuntime | undefined,
  extras?: { readonlySql?: string; approvalPolicy?: string },
): string {
  const material = {
    manifest: manifestRev(),
    capability: {
      groups: [...policy.capability.enabledGroups].sort(),
      allow: [...policy.capability.allowPatterns].sort(),
      deny: [...policy.capability.denyPatterns].sort(),
    },
    resource: {
      writePackages: [...(policy.resource.writePackages ?? [])].sort(),
      schemaAllow: [...(policy.resource.schemaAllow ?? [])].sort(),
    },
    profile: profile
      ? {
          id: profile.id,
          allowKinds: [...profile.allowKinds].sort(),
          allowCapabilities: [...(profile.allowCapabilities ?? [])].sort(),
          resourceScopes: profile.resourceScopes ?? null,
        }
      : null,
    env: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
    access: runtime?.access ?? 'readwrite',
    readonlySql: extras?.readonlySql ?? runtime?.config.readonlySql ?? 'select-only',
    approvalPolicy: extras?.approvalPolicy ?? 'off',
  };
  return `sha256:${digest(material)}`;
}

/**
 * 编译 entitlement：部署静态面 ∩ 档案 + 环境管理能力条件 + 平台入口规则。
 *
 * 平台入口（`hana_tool_search` / `hana_invoke`）不单独开权限例外：未显式 deny ∧
 * 至少一个具体能力在 entitlement 内即可见；它们只能操作 entitlement 内的能力。
 */
function compileEntitlement(input: SnapshotInput): Set<string> {
  const { toolFilter, profile, multiEnv, switchable } = input;
  const envList = findCapability('hana_env_list');
  const envListVisible =
    multiEnv &&
    envList !== undefined &&
    shouldRegisterTool(envList.id, toolFilter) &&
    profileAllows(profile, envList.id, envList.kind).ok;
  const envCapabilityVisible = (c: Capability): boolean => {
    if (c.id === 'hana_env_list') return multiEnv;
    if (c.id === 'hana_env_switch') {
      return envListVisible && switchable.length > 0 && input.httpPort == null;
    }
    return true;
  };

  const concreteEntitled: string[] = [];
  const out = new Set<string>();
  for (const cap of CAPABILITY_LIST) {
    if (isPlatformToolId(cap.id)) continue; // 平台入口最后按「有具体能力」追加
    if (!envCapabilityVisible(cap)) continue;
    if (!shouldRegisterTool(cap.id, toolFilter)) continue;
    if (!profileAllows(profile, cap.id, cap.kind).ok) continue;
    out.add(cap.id);
    concreteEntitled.push(cap.id);
  }

  if (concreteEntitled.length > 0) {
    for (const id of PLATFORM_TOOL_IDS) {
      if (shouldRegisterTool(id, toolFilter)) out.add(id);
    }
  }
  return out;
}

function compileWriteScope(config: HanaConfig, profile: CallerProfile | undefined, persistentEnv: boolean) {
  const base = [...(config.writePackages ?? [])];
  if (base.length === 0) {
    return {
      mode: (config.writePackagesExplicit ? 'deny-all' : 'unconfigured') as 'deny-all' | 'unconfigured',
      packages: [] as string[],
      persistent: false,
    };
  }
  const declared = profile?.resourceScopes?.writePackages;
  if (declared !== undefined) {
    // 子集语义：档案声明了但为空 = 一个都不许写
    const packages = declared.filter((pkg) => isPackageAllowed(pkg, base));
    if (packages.length === 0) return { mode: 'deny-all' as const, packages: [] as string[], persistent: false };
    return { mode: 'allowlist' as const, packages, persistent: persistentEnv };
  }
  return { mode: 'allowlist' as const, packages: base, persistent: persistentEnv };
}

function compileReadScope(config: HanaConfig, profile: CallerProfile | undefined) {
  const base = [...(config.schemaAllow ?? [])];
  const declared = profile?.resourceScopes?.readSchemas;
  if (declared !== undefined) {
    // 档案声明了但为空 = 只保留系统 schema（系统 schema 恒可读）
    const schemas = base.filter((schema) => isSchemaAllowedWith(schema, declared));
    return schemas.length === 0
      ? { mode: 'system-only' as const, schemas: [] as string[] }
      : { mode: 'allowlist' as const, schemas };
  }
  return base.length === 0
    ? {
        mode: (config.schemaAllowExplicit ? 'system-only' : 'unconfigured') as 'system-only' | 'unconfigured',
        schemas: [] as string[],
      }
    : { mode: 'allowlist' as const, schemas: base };
}

/** 把一个入口的配置/档案/环境编译成不可变快照。 */
export function compilePolicySnapshot(input: SnapshotInput): PolicySnapshot {
  // 与 activeProfile 同口径：未配档案表 = 隐式 default（不收紧）；配了但解析不到才是空档案。
  const effectiveProfile =
    input.profile ?? ((input.config.profiles?.size ?? 0) === 0 ? IMPLICIT_DEFAULT_PROFILE : undefined);
  const effectiveInput: SnapshotInput = { ...input, ...(effectiveProfile ? { profile: effectiveProfile } : {}) };
  const entitlement = compileEntitlement(effectiveInput);
  const runtime = input.runtime;
  const environment = {
    multiEnv: runtime?.multiEnv ?? input.multiEnv,
    envKey: runtime?.envKey ?? 'DEFAULT',
    epoch: runtime?.epoch ?? 1,
    access: runtime?.access ?? input.config.access ?? ('readwrite' as const),
  };
  const write = compileWriteScope(input.config, effectiveProfile, environment.access === 'readwrite');
  const read = compileReadScope(input.config, effectiveProfile);
  const rev = policyRevFromPolicy(
    {
      capability: input.toolFilter,
      resource: { writePackages: input.config.writePackages ?? [], schemaAllow: input.config.schemaAllow ?? [] },
    },
    effectiveProfile,
    input.runtime,
    {
      approvalPolicy: input.config.approvalPolicy,
      readonlySql: input.runtime?.config.readonlySql ?? input.config.readonlySql,
    },
  );
  return {
    rev,
    entitlement,
    scope: {
      write: { ...write, sqlPolicy: runtime?.config.readonlySql ?? 'select-only' },
      read,
    },
    environment,
    profileId: effectiveProfile?.id ?? '(empty)',
  };
}
