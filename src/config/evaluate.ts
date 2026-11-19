/**
 * 统一判定入口（P1）——`hana_tool_search` 的 preview 与 `authorizeCall` 的 enforce 共用同一函数。
 *
 * 为什么必须同一个：披露如果另写一套策略判断，就会「预测 A、执行 B」。这里只把现有判定器
 * （`planFor` + `runPreflight` + `checkProfile` + `environmentGrants`）组合一次，语义与 P1 之前
 * 逐项不变；区别只有 `mode`：
 * - `preview`：不写审计、不派发、不连 HANA；
 * - `enforce`：由 `authorizeCall` 包装为「evaluate + 审计 + blocked 回执」。
 *
 * 判定顺序固定：能力（entitlement/profile）→ 资源（写包/schema）→ 环境（只读/断言/代际）。
 * SQL 规则层（select-only/deny）与 P3 审批不在本函数内。
 */

import { manifestRev, planFor } from '../capabilities/manifest.js';
import { planReadless } from '../capabilities/planners.js';
import type { Capability } from '../capabilities/types.js';
import { BLOCKED_PREFIX } from '../core/errors.js';
import { isSchemaAllowedWith } from '../core/sql.js';
import { planToRequest, type WritePlan } from '../write-plan.js';
import type { Grant, Policy, Verdict } from './preflight.js';
import { assembleVerdict, checkDeployment, runPreflight } from './preflight.js';
import { profileAllows, type CallerProfile } from './profiles.js';
import { isPackageAllowed } from './write-boundary.js';
import { environmentGrants, type EnvironmentAssertion } from './environment-policy.js';
import { policyRevFromPolicy } from './policy-snapshot.js';
import { isDisclosureCurrent } from './disclosure-registry.js';
import type { EnvironmentRuntime } from './environment-runtime.js';

export type EvaluateMode = 'preview' | 'enforce';
export type CheckState = 'pass' | 'fail' | 'unknown' | 'not_applicable';

export interface EvaluateChecks {
  capability: CheckState;
  resource: CheckState;
  environment: CheckState;
  approval: CheckState;
}

export interface EvaluationInput {
  policy: Policy;
  profile?: CallerProfile;
  capability: Capability | undefined;
  args: Record<string, unknown>;
  mode: EvaluateMode;
  runtime?: EnvironmentRuntime;
  /** 调用信封里的环境断言（P2）；省略时回退 args.expectedEnvironment/expectedEpoch */
  envAssertion?: EnvironmentAssertion;
  /** 调用信封里的披露上下文：只做一致性检查（不是授权凭证） */
  disclosure?: { id?: string; policyRev?: string; manifestRev?: string };
  /** rev 的补充输入（readonlySql/approvalPolicy；与披露侧同一 rev 材料） */
  policyRevExtras?: { readonlySql?: string; approvalPolicy?: string };
  /** preview 侧可声明置信度（如 goal 步骤含未解析引用时为 deferred） */
  confidence?: 'full' | 'partial' | 'deferred';
}

export interface EvaluationResult {
  /** 本次判定模式（preview 不派发/不写授权审计；enforce 由 authorizeCall 包装） */
  mode: EvaluateMode;
  status: 'allowed' | 'blocked' | 'unknown';
  allowed: boolean;
  codes: string[];
  warnings: string[];
  checks: EvaluateChecks;
  plan: WritePlan;
  verdict: Verdict;
  confidence: 'full' | 'partial' | 'deferred';
}

/**
 * 档案维度（只能收紧）：与 authorize.ts 原实现逐条一致。
 *
 * `profile === undefined` 的两种情形分开处理：
 * - 部署未启用档案机制（policy.profiles 为空）：跳过；
 * - 配了档案表却解析不到（空档案）：`profile_unknown` block，全拒。
 */
export function checkProfileGrants(
  capability: Capability,
  plan: WritePlan,
  profile: CallerProfile | undefined,
  profilesEnabled: boolean,
): Grant[] {
  if (!profile) {
    if (!profilesEnabled) return [];
    return [
      {
        dimension: 'profile',
        subject: '(空档案)',
        code: 'profile_unknown',
        severity: 'block',
        message: `${BLOCKED_PREFIX}：本进程未解析到可用的调用方档案（已启用档案机制，但本次调用解析不到对应条目）。`,
      },
    ];
  }
  const out: Grant[] = [];
  // 平台入口是入口，不参与档案 kind/glob 判定；越界由目标能力自己的判定拦下。
  // 平台入口的可见性已由 entitlement 的「至少一个具体能力可见」约束（见 policy-snapshot）。
  if (capability.platform !== true) {
    const allowedByProfile = profileAllows(profile, capability.id, capability.kind);
    if (!allowedByProfile.ok) {
      const code = allowedByProfile.code ?? 'capability_not_in_profile';
      const detail =
        code === 'kind_not_allowed_by_profile'
          ? `档案 "${profile.id}" 不允许 ${capability.kind} 类能力（允许：${profile.allowKinds.join('/') || '(无)'}）`
          : `能力 "${capability.id}" 不在档案 "${profile.id}" 允许的能力范围内`;
      out.push({
        dimension: 'profile',
        subject: profile.id,
        code,
        severity: 'block',
        message: `${BLOCKED_PREFIX}：${detail}。`,
      });
    }
  }
  const scopes = profile.resourceScopes;
  if (scopes?.writePackages) {
    for (const pkg of plan.writePackages) {
      // 子集语义：声明了但为空 = 一个包都不许写（与 readSchemas 分支同口径）。
      if (scopes.writePackages.length === 0 || !isPackageAllowed(pkg, scopes.writePackages)) {
        out.push({
          dimension: 'profile',
          subject: pkg,
          code: 'write_package_outside_profile',
          severity: 'block',
          message: `${BLOCKED_PREFIX}：目标包 "${pkg}" 不在档案 "${profile.id}" 的可写范围内。`,
        });
      }
    }
  }
  if (scopes?.readSchemas) {
    for (const schema of plan.readSchemas) {
      if (!isSchemaAllowedWith(schema, scopes.readSchemas)) {
        out.push({
          dimension: 'profile',
          subject: schema,
          code: 'schema_outside_profile',
          severity: 'block',
          message: `${BLOCKED_PREFIX}：schema "${schema}" 不在档案 "${profile.id}" 可读的范围内。`,
        });
      }
    }
  }
  return out;
}

function checksOf(verdict: Verdict): EvaluateChecks {
  const has = (dimension: Grant['dimension']): boolean => verdict.blocking.some((g) => g.dimension === dimension);
  // 档案是能力层的叠加：档案拒绝 = 能力不可见（与未知能力同形）
  const capabilityBlocked = has('capability') || has('profile');
  return {
    capability: capabilityBlocked ? 'fail' : 'pass',
    resource: has('resource') ? 'fail' : 'pass',
    environment: has('environment') ? 'fail' : 'pass',
    approval: 'not_applicable',
  };
}

/**
 * 披露上下文一致性检查：policyRev / manifestRev 不匹配 → 拒绝。
 * `disclosure.id` 只做日志关联（它是整包/集合哈希，单工具路由无法重算），不在此校验。
 */
function disclosureGrants(
  disclosure: EvaluationInput['disclosure'],
  capability: Capability,
  policy: Policy,
  profile: CallerProfile | undefined,
  runtime: EnvironmentRuntime | undefined,
  extras?: { readonlySql?: string; approvalPolicy?: string },
): Grant[] {
  if (!disclosure) return [];
  const out: Grant[] = [];
  const currentManifest = manifestRev();
  const currentPolicyRev = policyRevFromPolicy(policy, profile, runtime, extras);
  if (disclosure.id !== undefined) {
    const currentEnv = {
      envKey: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
      epoch: runtime?.epoch ?? 1,
      policyRev: currentPolicyRev,
      manifestRev: currentManifest,
    };
    if (!isDisclosureCurrent(disclosure.id, capability.id, currentEnv)) {
      out.push({
        dimension: 'environment',
        subject: 'disclosureId',
        code: 'disclosure_stale',
        severity: 'block',
        message: `${BLOCKED_PREFIX}：披露包已过期或不属于本次调用（工具/环境/代际/策略任一不一致），请重新披露。`,
      });
    }
  }
  if (disclosure.manifestRev !== undefined && disclosure.manifestRev !== currentManifest) {
    out.push({
      dimension: 'environment',
      subject: 'manifestRev',
      code: 'manifest_stale',
      severity: 'block',
      message: `${BLOCKED_PREFIX}：披露包的能力清单代际已过期，请重新披露。`,
    });
  }
  if (disclosure.policyRev !== undefined && disclosure.policyRev !== currentPolicyRev) {
    out.push({
      dimension: 'environment',
      subject: 'policyRev',
      code: 'policy_stale',
      severity: 'block',
      message: `${BLOCKED_PREFIX}：披露包的策略代际已过期，请重新披露。`,
    });
  }
  return out;
}

/**
 * 对一个能力调用做统一判定。未登记能力返回 `status:'unknown'`（不规划、不泄漏入参形状）。
 */
export function evaluate(input: EvaluationInput): EvaluationResult {
  const { policy, profile, capability, args } = input;
  const runtime = input.runtime;

  if (!capability) {
    const grants: Grant[] = [
      {
        dimension: 'capability',
        subject: '(未登记能力)',
        code: 'unknown_capability',
        severity: 'block',
        message: `${BLOCKED_PREFIX}：该能力不存在或未对当前调用方开放。`,
      },
      ...checkDeployment(policy),
    ];
    const verdict = assembleVerdict(policy, grants, ['本次调用：能力 (未登记)——拒绝']);
    return {
      mode: input.mode,
      status: 'unknown',
      allowed: false,
      codes: ['unknown_capability'],
      warnings: verdict.warnings.map((g) => g.code),
      checks: { capability: 'unknown', resource: 'unknown', environment: 'unknown', approval: 'not_applicable' },
      plan: planReadless('(未登记能力)'),
      verdict,
      confidence: input.confidence ?? 'full',
    };
  }

  const plan = planFor(capability, args);
  const verdict = runPreflight({
    source: { kind: 'resolved', policy },
    request: planToRequest(plan),
    extraLines: [
      `本次调用：能力 ${capability.id}` +
        `；读 schema ${plan.readSchemas.length ? plan.readSchemas.join(', ') : '(无)'}` +
        `；跨包只读引用 ${plan.readPackages.length ? plan.readPackages.join(', ') : '(无)'}`,
    ],
    extraGrants: [
      ...checkProfileGrants(capability, plan, profile, (policy.profiles?.size ?? 0) > 0),
      ...environmentGrants(capability, args, runtime, input.envAssertion),
      ...disclosureGrants(input.disclosure, capability, policy, profile, runtime, input.policyRevExtras),
    ],
  });

  const codes = verdict.blocking.length > 0 ? verdict.blocking.map((g) => g.code) : verdict.warnings.map((g) => g.code);
  return {
    mode: input.mode,
    status: verdict.allowed ? 'allowed' : 'blocked',
    allowed: verdict.allowed,
    codes,
    warnings: verdict.warnings.map((g) => g.code),
    checks: checksOf(verdict),
    plan,
    verdict,
    confidence: input.confidence ?? 'full',
  };
}
