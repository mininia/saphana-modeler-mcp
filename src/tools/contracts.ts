/**
 * ActionContract 投影（Disclose）——把能力清单的 `routing` / `inputSchema` / `effects` 投影成
 * 「一次调用即可照抄」的完整技术契约。
 *
 * 边界：
 * - **不新增第二份能力表**：所有字段都从 `CAPABILITY_LIST` 派生；
 * - 只描述技术层：入参、约束、前置、副作用、调用方式；不存 HANA 数据/权限快照；
 * - 不复制完整输出 schema：只给 `routing.returns` 的结果使用说明；
 * - 不序列化 `effects.plan` 函数（它是服务端资源规划器，不是模型契约）。
 *
 * `canonicalCall` 只说明「这样调」，不代表已执行；授权仍由每次调用的 `authorizeCall` 决定。
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { Capability, CapabilityCategory, MutationScope, ToolKind } from '../capabilities/types.js';
import { manifestRev, planFor } from '../capabilities/manifest.js';
export { manifestRev };
import { declaredResourceRoles } from '../capabilities/resources.js';
import { requiredParamsOf } from './surface.js';
import { capabilityInputSchema, environmentMutationScope } from '../config/environment-policy.js';
import type { HanaConfig } from '../config/config.js';
import { policyRevFromPolicy } from '../config/policy-snapshot.js';
import type { CallerProfile } from '../config/profiles.js';
import type { ToolFilterConfig } from './groups.js';
import type { EnvironmentRuntime } from '../config/environment-runtime.js';
import { substituteBindings } from '../capabilities/recipes.js';

/** 静态运行风险（派生，不手写） */
export type OperationalRisk = 'low' | 'medium' | 'high' | 'destructive';

/** 静态访问画像：环境无关；只回答「需要哪类检查」，不含策略值 */
export interface AccessProfile {
  authorizationClass: ToolKind;
  mutation: MutationScope;
  operationalRisk: OperationalRisk;
  checks: string[];
  control: boolean;
}

/** 披露包的单个工具条目 */
export interface ActionContract {
  id: string;
  title: string;
  category: CapabilityCategory;
  kind: ToolKind;
  intent?: string;
  whenToUse?: readonly string[];
  notFor?: readonly string[];
  priority?: string;
  inputSchema: unknown;
  required: string[];
  exampleArgs?: Record<string, unknown>;
  constraints?: readonly string[];
  requires?: string;
  effects: { mutates: MutationScope; destructive: boolean; idempotent: boolean };
  access: AccessProfile;
  returns?: readonly string[];
  call: { via: string; capability: string; operation?: string };
  canonicalCall: {
    via: string;
    capability: string;
    operation?: string;
    args: Record<string, unknown>;
    /** 环境断言信封（hana_invoke 顶层；args 只放业务参数） */
    envelope?: { expectedEnvironment: { key: string; epoch: number } };
  };
}

/**
 * 写语义探测参数：与 config/preflight.ts 的 WRITE_PROBE_ARGS 同口径。
 * 只用于静态 `access.checks` 的 `write_scope`/`read_scope` 判定（规划器是纯函数，无副作用）。
 */
export const ACCESS_PROBE_ARGS: Readonly<Record<string, unknown>> = {
  packageId: 'PROBE.PKG',
  targetPackageId: 'PROBE.PKG',
  objectName: 'PROBE_OBJ',
};

/** 运行风险派生：`transient` 不是 `read` */
export function operationalRiskOf(cap: Capability): OperationalRisk {
  if (cap.effects.destructive) return 'destructive';
  if (cap.effects.mutates === 'persistent') return 'high';
  if (cap.effects.mutates === 'transient') return 'medium';
  if (cap.kind === 'write' || cap.kind === 'admin' || cap.kind === 'sql') return 'medium';
  return 'low';
}

/** 静态访问画像（环境无关；`expected_environment` 需要 multiEnv 才出现） */
export function accessProfileOf(cap: Capability, multiEnv = false): AccessProfile {
  const roles = new Set(declaredResourceRoles(cap.inputSchema));
  const probe = planFor(cap, { ...ACCESS_PROBE_ARGS });
  const checks: string[] = [];
  if (roles.has('writePackage') || probe.writePackages.length > 0) checks.push('write_scope');
  if (roles.has('readSchema') || probe.readSchemas.length > 0) checks.push('read_scope');
  const mutation = environmentMutationScope(cap);
  if (mutation === 'persistent') checks.push('environment_write');
  if (multiEnv && cap.platform !== true) checks.push('expected_environment');
  if (cap.kind === 'sql') checks.push('sql_policy');
  const risk = operationalRiskOf(cap);
  if (risk === 'destructive') checks.push('approval');
  return {
    authorizationClass: cap.kind,
    mutation,
    operationalRisk: risk,
    checks,
    control: cap.control === true,
  };
}

/**
 * 调用路由：所有具体能力都经唯一执行入口 `hana_invoke`（操作级别名同样如此）。
 * 平台入口自身的契约卡（如 tool_search 参数错误的自我说明）通过它自己的名字调用。
 */
function callOf(cap: Capability): { via: string; capability: string; operation?: string } {
  const opIdx = cap.id.indexOf('#');
  const operation = opIdx >= 0 ? cap.id.slice(opIdx + 1) : undefined;
  return {
    via: cap.platform === true ? cap.id : 'hana_invoke',
    capability: cap.id,
    ...(operation !== undefined ? { operation } : {}),
  };
}

/** 多环境下所有调用要补的断言（披露时给当前值；执行仍逐次校验） */
export interface DisclosureEnvironment {
  key: string;
  epoch: number;
}

function exampleArgsOf(
  cap: Capability,
  multiEnv: boolean,
  bindings: Record<string, unknown>,
  environment?: DisclosureEnvironment,
): {
  args: Record<string, unknown>;
  missing: string[];
  envelope?: { expectedEnvironment: { key: string; epoch: number } };
} {
  const { value, missing } = substituteBindings(cap.routing?.exampleArgs ?? {}, bindings);
  const args = { ...(value as Record<string, unknown>) };
  // bindings 同时作为「调用方目标」覆盖显式示例键（如 packageId/objectName）：canonicalCall 与
  // policy preview 才反映调用方真正要碰的资源，而不是固定的演示对象。未知键不注入（避免制造非法参数）。
  for (const [key, bound] of Object.entries(bindings)) {
    if (Object.hasOwn(args, key)) args[key] = bound;
  }
  let envelope: { expectedEnvironment: { key: string; epoch: number } } | undefined;
  if (multiEnv && cap.platform !== true && environment) {
    // 统一走调用信封：args 只放业务参数，环境断言由 hana_invoke 顶层接收。
    envelope = { expectedEnvironment: { key: environment.key, epoch: environment.epoch } };
  }
  return { args, ...(envelope ? { envelope } : {}), missing };
}

export interface ContractOptions {
  multiEnv: boolean;
  bindings?: Record<string, unknown>;
  environment?: DisclosureEnvironment;
}

/** 投影单个能力 → ActionContract；同时返回 exampleArgs 里缺失的 bindings 键。 */
export function buildContract(
  cap: Capability,
  opts: ContractOptions,
): { contract: ActionContract; missingBindings: string[] } {
  const { args, missing, envelope } = exampleArgsOf(cap, opts.multiEnv, opts.bindings ?? {}, opts.environment);
  const call = callOf(cap);
  // 所有能力统一走信封：args 只含业务参数；环境断言在 canonicalCall.envelope。
  const inputSchema = z.toJSONSchema(capabilityInputSchema(cap, opts.multiEnv, 'envelope'), { io: 'input' });
  const contract: ActionContract = {
    id: cap.id,
    title: cap.title,
    category: cap.category,
    kind: cap.kind,
    ...(cap.routing?.intent !== undefined ? { intent: cap.routing.intent } : {}),
    ...(cap.routing?.whenToUse !== undefined && cap.routing.whenToUse.length > 0
      ? { whenToUse: cap.routing.whenToUse }
      : {}),
    ...(cap.routing?.notFor !== undefined && cap.routing.notFor.length > 0 ? { notFor: cap.routing.notFor } : {}),
    ...(cap.routing?.priority !== undefined ? { priority: cap.routing.priority } : {}),
    inputSchema,
    required: requiredParamsOf(cap, opts.multiEnv, 'envelope'),
    ...(Object.keys(args).length > 0 ? { exampleArgs: args } : {}),
    ...(cap.routing?.constraints !== undefined && cap.routing.constraints.length > 0
      ? { constraints: cap.routing.constraints }
      : {}),
    ...(cap.routing?.requires !== undefined ? { requires: cap.routing.requires } : {}),
    effects: { mutates: cap.effects.mutates, destructive: cap.effects.destructive, idempotent: cap.effects.idempotent },
    access: accessProfileOf(cap, opts.multiEnv),
    ...(cap.routing?.returns !== undefined && cap.routing.returns.length > 0 ? { returns: cap.routing.returns } : {}),
    call,
    canonicalCall: { ...call, args, ...(envelope ? { envelope } : {}) },
  };
  return { contract, missingBindings: missing };
}

// ── 版本与披露哈希（只做日志/缓存/过期关联，不做授权） ──────────────

/** 16 位十六进制摘要（sha256 前 16 位；展示/关联足够，不作为安全边界） */
function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);
}

/**
 * 策略代际：归一化策略 + 档案 + 当前环境（**不含 epoch**——epoch 单独参与 disclosureId）。
 * `hana_tool_search` 只把它写进披露包的 policy.context / disclosureId，不做授权。
 */
export function policyRevOf(
  config: HanaConfig,
  filter: ToolFilterConfig,
  profile: CallerProfile | undefined,
  runtime: EnvironmentRuntime | undefined,
): string {
  // 与快照/执行侧同一个 rev 源（含 manifestRev，不含 epoch）。
  return policyRevFromPolicy(
    {
      capability: filter,
      resource: { writePackages: config.writePackages ?? [], schemaAllow: config.schemaAllow ?? [] },
    },
    profile,
    runtime,
    { approvalPolicy: config.approvalPolicy, readonlySql: runtime?.config.readonlySql ?? config.readonlySql },
  );
}

/** 披露 id = sha256(manifestRev + policyRev + envKey/epoch + 排序后的工具 id + goal) */
export function disclosureIdOf(
  manifest: string,
  policyRev: string,
  runtime: EnvironmentRuntime | undefined,
  toolIds: readonly string[],
  goal?: string,
): string {
  return `sha256:${digest({
    manifest,
    policyRev,
    envKey: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
    epoch: runtime?.epoch ?? 1,
    tools: [...toolIds].sort(),
    goal: goal ?? null,
  })}`;
}

/** 序列化字节数（预算护栏用） */
export function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), 'utf8');
}
