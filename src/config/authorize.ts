/**
 * 调用期授权闸门（**唯一入口**）—— SSD §7.3 的 L2「多入口、单闸门」落点。
 *
 * ## 为什么需要它
 *
 * P10-b 之前，「能不能调用」这件事**按入口分裂**：
 * - 写工具（8 个）在 handler 之前过写预检（`registerWriteTool` → `preflightWriteCall`）；
 * - 读工具（21 个）**没有任何调用期判定**——唯一一道闸是注册期的可见性过滤，
 *   而可见性只在注册时被咨询一次（SSD §7.1 事实 1）。
 * 静态工具面下这还行；一旦引入动态调用面（发现 / 提升 / 路由，P10-d），"注册时判过"就不再等于
 * "调用时仍成立"，必须有一个**与入口无关**的判定函数，任何入口都调它。
 *
 * ## 判定内容（**复用同一个判定器与报告**，不新写规则 —— I3）
 *
 * 一次 `authorizeCall` = ①「这次调用会触碰什么」由清单的 `effects.plan` 规划出来（`planFor`）；
 * ② 交给**同一个** `runPreflight`（它组合 `checkCapability` + `checkResource` + `checkDeployment`），
 * 只额外附一行"本次调用的资源计划"进报告。因此两个入口（写预检 / 统一闸门）：
 * - 能力级（`MCP_TOOL_GROUPS/ALLOW/DENY`）：工具是否对客户端暴露；
 * - 资源级：`HANA_WRITE_PACKAGES`（写包，来自计划 `writePackages`）与
 *   `HANA_SCHEMA_ALLOW`（读 schema，来自计划 `readSchemas`）；
 * - 部署级：与具体请求无关的姿态项（明文连接等，只出警告）。
 *
 * **规则粒度由清单决定**：能力声明了 `effects.plan` 才有资源维度；读能力不声明就没有资源结论
 * （`planFor` 对读能力绝不套用写兜底，见其文档）。
 *
 * ## 位置（对 SSD §7.9 的一处实现细化）
 *
 * SSD 写的是 `src/capabilities/authorize.ts`，实现放在 `src/config/` 下——理由是依赖方向：
 * `capabilities/` 是**声明层**，只允许 import 叶子模块（见 types.ts 头注）；而本模块要 import
 * 策略层（preflight.ts）。策略层反过来又经 `tools/groups.ts` → `capabilities/manifest.ts` 依赖清单，
 * 把闸门塞进 capabilities/ 会让两层互相依赖（当前不成环，但等于把"清单不许依赖策略"这条规矩作废）。
 * 放这里还有一个语义理由：本文件紧挨 `check*` 与 `runPreflight`，符合该层"权限判定的唯一入口"自述。
 *
 * ## 归因（不变量 E）
 *
 * 每次调用产出一条 `capability-audit`：`{clientId, transport, capabilityId, verdict, resources, codes}`。
 * 放行记 `info`、拦截记 `warn`。`agentLabel`（`MCP_AGENT_LABEL`）由 P5 落地后自动出现在同一事件里——
 * 此处不提前编造一个恒为空的字段。
 */

import { assembleVerdict, checkDeployment, runPreflight, type Grant, type Policy, type Verdict } from './preflight.js';
import { profileAllows, type CallerProfile } from './profiles.js';
import { isPackageAllowed } from './write-boundary.js';
import { planFor } from '../capabilities/manifest.js';
import { planReadless } from '../capabilities/planners.js';
import type { Capability } from '../capabilities/types.js';
import { isSchemaAllowedWith } from '../core/sql.js';
import { mcpErrorText } from '../core/errors.js';
import { currentAgentLabel, currentIdentity } from '../core/request-context.js';
import { logger } from '../core/logger.js';
import { formatWritePlan, planToRequest, type WritePlan } from '../write-plan.js';

/** 调用方身份（HTTP = 认证后的 clientId；stdio = 进程内单客户端，无身份上下文） */
export interface CallerIdentity {
  /** 客户端身份名（未进入身份上下文时 undefined） */
  clientId?: string;
  /** 传输通道（审计用：区分本地 stdio 与远程 HTTP） */
  transport?: 'http' | 'stdio';
  /** 调用方档案名（HTTP：Token 第三段；stdio：进程默认 MCP_PROFILE） */
  profileId?: string;
}

/** 一次调用的授权上下文 */
export interface AuthorizationContext {
  /** 生效的部署级策略（`policyFromConfig` / `resolvePolicy`） */
  policy: Policy;
  /**
   * 调用方档案（P10-c）。**undefined = 部署没配档案**（此时按隐式 default 处理，不额外收紧）；
   * 配了档案却解析不到具体条目 = 空档案（全拒）——见 `resolveProfile` 的说明。
   */
  profile?: CallerProfile;
  /** 调用方身份（省略 = 取当前请求上下文；stdio 下为 undefined） */
  caller?: CallerIdentity;
  /** 进程级归因标签（`MCP_AGENT_LABEL`），随审计事件落地 */
  agentLabel?: string;
}

/** 一次调用的授权结论 */
export interface AuthorizationResult {
  /** true = 无任何阻断级结论 */
  allowed: boolean;
  /** 本次调用的资源计划（写能力 = 读写计划；读能力 = 读范围声明） */
  plan: WritePlan;
  /** 策略判定总结果（含 blocking/warnings/text/policy） */
  verdict: Verdict;
  /** 审计事件载荷（不变量 E：每次调用都记，无论放行与否） */
  audit: CapabilityAuditEvent;
}

/** `capability-audit` 事件载荷（字段固定：审计链路不随入口变化） */
export interface CapabilityAuditEvent {
  capabilityId: string;
  verdict: 'allow' | 'block';
  clientId?: string;
  transport?: 'http' | 'stdio';
  /** 调用方档案名（P10-c；未配档案时为隐式 default） */
  profileId?: string;
  /** 进程级归因标签（MCP_AGENT_LABEL；未配置时不产生该字段） */
  agentLabel?: string;
  resources: { writePackages: string[]; readSchemas: string[]; readPackages: string[] };
  /** 本次产生的全部规则码（放行时可能含 warn 级） */
  codes: string[];
}

/**
 * 一次性解析出"谁在调用"：身份（clientId/transport/profileId）+ 进程级标签。
 * 供工具层在每次调用时复用（HTTP 的身份来自 ALS，stdio 的为 undefined）。
 */
export function currentCaller(): CallerIdentity {
  const id = currentIdentity();
  return {
    ...(id?.clientId ? { clientId: id.clientId } : {}),
    ...(id?.transport ? { transport: id.transport } : {}),
    ...(id?.profileId ? { profileId: id.profileId } : {}),
  };
}

/**
 * 对一个能力调用做授权判定。
 *
 * @param capability 目标能力（清单条目；未登记时传 undefined —— 此时一律拒绝）
 * @param args 本次调用的入参（用于规划要触碰的资源）
 * @param ctx 授权上下文（策略 + 档案 + 调用方身份/标签）
 */
export function authorizeCall(
  capability: Capability | undefined,
  args: Record<string, unknown>,
  ctx: AuthorizationContext,
): AuthorizationResult {
  const { policy, profile } = ctx;
  const identity = ctx.caller ?? currentCaller();
  const agentLabel = ctx.agentLabel ?? currentAgentLabel();

  // 未登记能力：**在规划之前就拒绝**（不变量 D）。这里刻意不做任何按入参的判定：
  // 一旦让 args 参与，回执里的规则码就会随入参变化——那本身就是一条存在性/形状探针。
  // 路由（P10-d）对"面外"与"不存在"复用同一条路径，故两者回执逐字同形。
  if (!capability) {
    const grants = [
      {
        dimension: 'capability' as const,
        subject: '(未登记能力)',
        code: 'unknown_capability',
        severity: 'block' as const,
        message: '被 MCP 安全策略拦截：该能力不存在或未对当前调用方开放。',
      },
      ...checkDeployment(policy),
    ];
    const verdict = assembleVerdict(policy, grants, ['本次调用：能力 (未登记)——拒绝']);
    const audit: CapabilityAuditEvent = {
      capabilityId: '(未登记能力)',
      verdict: 'block',
      ...(identity.clientId ? { clientId: identity.clientId } : {}),
      ...(identity.transport ? { transport: identity.transport } : {}),
      ...(profile ? { profileId: profile.id } : {}),
      ...(agentLabel ? { agentLabel } : {}),
      resources: { writePackages: [], readSchemas: [], readPackages: [] },
      codes: ['unknown_capability'],
    };
    logger.warn({ ...audit }, 'capability-audit');
    return { allowed: false, plan: planReadless('(未登记能力)'), verdict, audit };
  }

  const plan = planFor(capability, args);
  // 档案维度（P10-c，只能收紧）作为**附加维度**并入同一次判定：
  // 与各 check* 的结论一起分类/成文，报告构造仍只有 assemble 一处（I3）。
  const verdict = runPreflight({
    source: { kind: 'resolved', policy },
    request: planToRequest(plan),
    extraLines: [
      `本次调用：能力 ${capability.id}` +
        `；读 schema ${plan.readSchemas.length ? plan.readSchemas.join(', ') : '(无)'}` +
        `；跨包只读引用 ${plan.readPackages.length ? plan.readPackages.join(', ') : '(无)'}`,
    ],
    extraGrants: checkProfile(capability, plan, profile),
  });

  const audit: CapabilityAuditEvent = {
    capabilityId: capability.id,
    verdict: verdict.allowed ? 'allow' : 'block',
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    ...(identity.transport ? { transport: identity.transport } : {}),
    ...(profile ? { profileId: profile.id } : {}),
    ...(agentLabel ? { agentLabel } : {}),
    resources: {
      writePackages: plan.writePackages,
      readSchemas: plan.readSchemas,
      readPackages: plan.readPackages,
    },
    codes: verdict.blocking.length > 0 ? verdict.blocking.map((g) => g.code) : verdict.warnings.map((g) => g.code),
  };
  logger[verdict.allowed ? 'info' : 'warn']({ ...audit }, 'capability-audit');

  return { allowed: verdict.allowed, plan, verdict, audit };
}

/**
 * 档案维度的判定（P10-c，不变量 A：只能收紧）。
 *
 * 三项：
 * 1. **能力在档案面内**：档案声明的能力 glob 未命中 → 拒（`capability_not_in_profile`）；
 * 2. **kind 被档案允许**：如只读档案调用写能力 → 拒（`kind_not_allowed_by_profile`）；
 * 3. **资源收紧**：档案若声明了 `resourceScopes`，写包/读 schema 必须是它的子集
 *    （env 文法暂不表达该项，但机制在此一次实现——判定只有一份）。
 *
 * 未配档案（`profile === undefined`）= 部署没启用档案机制，跳过全部三项（向后兼容）。
 * 配了档案却解析不到条目（空档案）→ 全部拒（fail-closed，见 resolveProfile）。
 */
function checkProfile(capability: Capability, plan: WritePlan, profile: CallerProfile | undefined): Grant[] {
  if (!profile) return [];
  const out: Grant[] = [];
  // 门面是**入口**，不参与档案判定（2026-10-09 定稿：权限只有一层——能力层）：档案的 kind/glob
  // 管的是"哪些能力可用"，门面常驻（见 tools/surface.ts 的「门面常驻」）。越界由目标能力自己的
  // 判定拦下——门面 handler 派发前会对目标能力再跑一次同一个闸门。
  if (capability.facadeOf === undefined) {
    const allowedByProfile = profileAllows(profile, capability.id, capability.kind);
    if (!allowedByProfile.ok) {
      const code = allowedByProfile.code ?? 'capability_not_in_profile';
      const detail =
        code === 'kind_not_allowed_by_profile'
          ? `档案 "${profile.id}" 不允许 ${capability.kind} 类能力（允许：${profile.allowKinds.join('/') || '(无)'}）`
          : code === 'profile_unknown'
            ? `本进程未解析到可用的调用方档案（配置了 MCP_PROFILES 却查不到对应条目）`
            : `能力 "${capability.id}" 不在档案 "${profile.id}" 允许的能力范围内`;
      out.push({
        dimension: 'profile',
        subject: profile.id,
        code,
        severity: 'block',
        message: `被 MCP 安全策略拦截：${detail}。`,
      });
    }
  }
  const scopes = profile.resourceScopes;
  if (scopes?.writePackages) {
    for (const pkg of plan.writePackages) {
      if (!isPackageAllowed(pkg, scopes.writePackages)) {
        out.push({
          dimension: 'profile',
          subject: pkg,
          code: 'write_package_outside_profile',
          severity: 'block',
          message: `被 MCP 安全策略拦截：目标包 "${pkg}" 不在档案 "${profile.id}" 的可写范围内。`,
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
          message: `被 MCP 安全策略拦截：schema "${schema}" 不在档案 "${profile.id}" 可读的范围内。`,
        });
      }
    }
  }
  return out;
}

/**
 * 拦截时的对调用方回执（§1.3：**不含补救路径**，前缀固定，形状 = `mcpErrorText` 硬错误）。
 *
 * 文案构成 = 首行「被 MCP 安全策略拦截（码），请求未执行」+ 本次调用的资源计划 + 逐条结论 + 尾句。
 * 计划先于结论出现：先让调用方看清「本来会发生什么」，再看「为什么被拦」。
 * 与写闸门时代**逐字同形**（同一 `mcpErrorText(message, hint)` 两段式），只是现在所有能力都走它。
 */
export function blockedCallResult(result: AuthorizationResult) {
  return mcpErrorText(
    `被 MCP 安全策略拦截（${result.verdict.blocking.map((g) => g.code).join(', ')}），请求未执行`,
    // 不给绕过方法：拦截消息面向不受信的一方（通常是模型），写明「改哪项配置可放行」等于把钥匙递出去。
    `${formatWritePlan(result.plan)}\n\n${result.verdict.text}\n\n` +
      '该限制由 MCP 服务端的权限策略施加，调用方无法自行解除。',
  );
}
