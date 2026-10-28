/**
 * 调用期授权闸门（**唯一入口**）：所有能力调用的授权判定都收敛到 `authorizeCall`。
 *
 * ## 为什么需要它
 *
 * 「能不能调用」不能靠注册期过滤替代：
 * - 可见性只在注册时被咨询一次（见 tools/surface.ts），而工具面按连接/调用方计算，
 *   "注册时判过"不等于"调用时仍成立"；
 * - 同一进程可能有多个调用方（HTTP 多客户端 + 调用方档案），各自的收紧维度不同；
 * - 存在不经 `tools/list` 的入口（门面路由），注册期判定根本到不了那里。
 * 所以必须有一个**与入口无关**的判定函数，任何入口都调它。
 *
 * ## 判定内容（**复用同一个判定器与报告**，不另写规则）
 *
 * 一次 `authorizeCall` = ①「这次调用会触碰什么」由清单的 `effects.plan` 规划出来（`planFor`）；
 * ② 交给**同一个** `runPreflight`（它组合 `checkCapability` + `checkResource` + `checkDeployment`），
 * 只额外附一行"本次调用的资源计划"进报告。因此两个入口（写预检 / 统一闸门）：
 * - 能力级（`HANA_TOOL_GROUPS/ALLOW/DENY`）：工具是否对客户端暴露；
 * - 资源级：`HANA_WRITE_PACKAGES`（写包，来自计划 `writePackages`）与
 *   `HANA_READ_SCHEMA`（读 schema，来自计划 `readSchemas`）；
 * - 部署级：与具体请求无关的姿态项（明文连接等，只出警告）。
 *
 * **规则粒度由清单决定**：能力声明了 `effects.plan` 才有资源维度；读能力不声明就没有资源结论
 * （`planFor` 对读能力绝不套用写兜底，见其文档）。
 *
 * ## 位置（为什么在 src/config/ 而不是 capabilities/）
 *
 * 依赖方向决定：`capabilities/` 是**声明层**，只允许 import 叶子模块（见 types.ts 头注）；
 * 而本模块要 import 策略层（preflight.ts）。策略层反过来又经 `tools/groups.ts` →
 * `capabilities/manifest.ts` 依赖清单，把闸门塞进 capabilities/ 会让两层互相依赖
 * （等于把"清单不许依赖策略"这条规矩作废）。
 * 放这里还有一个语义理由：本文件紧挨 `check*` 与 `runPreflight`，符合该层"权限判定的唯一入口"自述。
 *
 * ## 归因（每次调用都记一条审计，无论放行与否）
 *
 * 每次调用产出一条 `capability-audit`：`{clientId, transport, capabilityId, verdict, resources, codes}`。
 * 放行记 `info`、拦截记 `warn`。`agentLabel`（`MCP_AGENT_LABEL`）取当前进程级标签（未配置时不产生
 * 该字段）——不提前编造一个恒为空的占位。
 */

import { assembleVerdict, checkDeployment, runPreflight, type Grant, type Policy, type Verdict } from './preflight.js';
import { profileAllows, type CallerProfile } from './profiles.js';
import { isPackageAllowed } from './write-boundary.js';
import { planFor } from '../capabilities/manifest.js';
import { planReadless } from '../capabilities/planners.js';
import type { Capability } from '../capabilities/types.js';
import { isSchemaAllowedWith } from '../core/sql.js';
import { BLOCKED_PREFIX, mcpErrorText } from '../core/errors.js';
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
   * 调用方档案。**未配档案的部署由 `resolveProfile` 返回隐式 default**（不额外收紧）；
   * 这里的 undefined 只代表"配了档案表却解析不到对应条目" = 空档案 → **全拒**（fail-closed，
   * 见 `resolveProfile` 与 `checkProfile` 的说明）。
   */
  profile?: CallerProfile;
  /** 调用方身份（省略 = 取当前请求上下文；stdio 下为 undefined） */
  caller?: CallerIdentity;
  /** 进程级归因标签（`MCP_AGENT_LABEL`），随审计事件落地 */
  agentLabel?: string;
  /** 归因入口（门面路由时 = 门面 id；平铺直调缺省）——只进审计，不参与判定 */
  via?: string;
}

/** 一次调用的授权结论 */
export interface AuthorizationResult {
  /** true = 无任何阻断级结论 */
  allowed: boolean;
  /** 本次调用的资源计划（写能力 = 读写计划；读能力 = 读范围声明） */
  plan: WritePlan;
  /** 策略判定总结果（含 blocking/warnings/text/policy） */
  verdict: Verdict;
  /** 审计事件载荷（每次调用都记，无论放行与否；字段固定，不随入口变化） */
  audit: CapabilityAuditEvent;
}

/**
 * 审计终态（P0-4）：
 * - 读能力：`allowed | denied`（授权判定即终态，无后续副作用）；
 * - 写能力（含 destructive 的 admin）：`denied | completed | failed`——**每次尝试恰好一条终态记录**。
 *   放行时闸门不单独记 `allowed`，由调用方在本次执行结束后记 `completed`/`failed`；
 *   拦截仍由闸门记 `denied`（此时根本没有执行阶段）。
 */
export type AuditResult = 'allowed' | 'denied' | 'completed' | 'failed';

/** 审计里的非敏感目标标识（包/对象/op；不放 SQL、不放请求体） */
export interface AuditTarget {
  packageId?: string;
  objectName?: string;
  op?: string;
}

/** `capability-audit` 事件载荷（字段固定：审计链路不随入口变化） */
export interface CapabilityAuditEvent {
  capabilityId: string;
  /** 终态（P0-4）：读 = allowed|denied；写 = denied|completed|failed */
  result: AuditResult;
  /**
   * `allow|block` 投影（兼容旧日志读取方）。
   * `completed`/`failed` 都投影为 `allow`：它们是在**已授权**之后发生的执行结局。
   */
  verdict: 'allow' | 'block';
  clientId?: string;
  transport?: 'http' | 'stdio';
  /** 调用方档案名（未配档案时为隐式 default） */
  profileId?: string;
  /** 进程级归因标签（MCP_AGENT_LABEL；未配置时不产生该字段） */
  agentLabel?: string;
  /** 归因入口（门面路由时 = 门面 id） */
  via?: string;
  /** 非敏感目标（包/对象/op） */
  target?: AuditTarget;
  resources: { writePackages: string[]; readSchemas: string[]; readPackages: string[] };
  /** 本次产生的全部规则码（放行时可能含 warn 级） */
  codes: string[];
  /** 拒绝原因（稳定规则码；仅 denied） */
  denyReason?: string;
  /** 执行失败原因（稳定码；仅 failed；不放原始报文） */
  failureDetail?: string;
  /** true = 本次调用只是把工作交给异步任务（终态在执行侧另记一条，带 taskId） */
  deferred?: boolean;
}

/**
 * 写能力判定（P0-4 的「写」口径）：kind=write，或声明了 destructive 的 admin
 * （如 hana_repo_import——它确实覆盖仓库文件，不能按只读记 allowed）。
 * 门面是**入口**，不是执行单元：它自己的判定不落终态（真正的目标能力会落），
 * 否则每次调门面都会多出一条 `hana_modeling completed` 的假写记录。
 */
export function isMutationCapability(capability: Capability): boolean {
  if (capability.facadeOf !== undefined) return false;
  return capability.kind === 'write' || capability.effects.destructive === true;
}

/** 从入参提取非敏感目标标识（只认 string；SQL/请求体一律不进审计） */
export function auditTargetOf(args: Record<string, unknown>): AuditTarget | undefined {
  const target: AuditTarget = {
    ...(typeof args['packageId'] === 'string' ? { packageId: args['packageId'] } : {}),
    ...(typeof args['objectName'] === 'string' ? { objectName: args['objectName'] } : {}),
    ...(typeof args['op'] === 'string' ? { op: args['op'] } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

/**
 * 调用方身份（clientId/transport/profileId，取自请求上下文 ALS；stdio 无身份时为空对象）。
 * authorizeCall 在调用方未显式传身份时用它兜底。
 */
function currentCaller(): CallerIdentity {
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

  // 未登记能力：**在规划之前就拒绝**——拒绝依据不得依赖入参：
  // 一旦让 args 参与，回执里的规则码就会随入参变化——那本身就是一条存在性/形状探针。
  // 路由对"面外"与"不存在"复用同一条路径，故两者回执逐字同形。
  if (!capability) {
    const grants = [
      {
        dimension: 'capability' as const,
        subject: '(未登记能力)',
        code: 'unknown_capability',
        severity: 'block' as const,
        message: `${BLOCKED_PREFIX}：该能力不存在或未对当前调用方开放。`,
      },
      ...checkDeployment(policy),
    ];
    const verdict = assembleVerdict(policy, grants, ['本次调用：能力 (未登记)——拒绝']);
    const unknownTarget = auditTargetOf(args);
    const audit: CapabilityAuditEvent = {
      capabilityId: '(未登记能力)',
      result: 'denied',
      verdict: 'block',
      ...(identity.clientId ? { clientId: identity.clientId } : {}),
      ...(identity.transport ? { transport: identity.transport } : {}),
      ...(profile ? { profileId: profile.id } : {}),
      ...(agentLabel ? { agentLabel } : {}),
      ...(ctx.via ? { via: ctx.via } : {}),
      ...(unknownTarget ? { target: unknownTarget } : {}),
      resources: { writePackages: [], readSchemas: [], readPackages: [] },
      codes: ['unknown_capability'],
      denyReason: 'unknown_capability',
    };
    logger.warn({ ...audit }, 'capability-audit');
    return { allowed: false, plan: planReadless('(未登记能力)'), verdict, audit };
  }

  const plan = planFor(capability, args);
  // 档案维度（只能收紧）作为**附加维度**并入同一次判定：
  // 与各 check* 的结论一起分类/成文，报告构造仍只有 assemble 一处。
  const verdict = runPreflight({
    source: { kind: 'resolved', policy },
    request: planToRequest(plan),
    extraLines: [
      `本次调用：能力 ${capability.id}` +
        `；读 schema ${plan.readSchemas.length ? plan.readSchemas.join(', ') : '(无)'}` +
        `；跨包只读引用 ${plan.readPackages.length ? plan.readPackages.join(', ') : '(无)'}`,
    ],
    extraGrants: checkProfile(capability, plan, profile, (policy.profiles?.size ?? 0) > 0),
  });

  const target = auditTargetOf(args);
  const audit: CapabilityAuditEvent = {
    capabilityId: capability.id,
    result: verdict.allowed ? 'allowed' : 'denied',
    verdict: verdict.allowed ? 'allow' : 'block',
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    ...(identity.transport ? { transport: identity.transport } : {}),
    ...(profile ? { profileId: profile.id } : {}),
    ...(agentLabel ? { agentLabel } : {}),
    ...(ctx.via ? { via: ctx.via } : {}),
    ...(target ? { target } : {}),
    resources: {
      writePackages: plan.writePackages,
      readSchemas: plan.readSchemas,
      readPackages: plan.readPackages,
    },
    codes: verdict.blocking.length > 0 ? verdict.blocking.map((g) => g.code) : verdict.warnings.map((g) => g.code),
    ...(verdict.allowed ? {} : { denyReason: verdict.blocking[0]?.code ?? 'blocked' }),
  };
  // P0-4：读能力的授权结论就是终态；写能力放行时**不记**（终态由执行侧记 completed/failed），
  // 拦截则由闸门记 denied——每次写尝试在日志里恰好一条终态记录。
  if (!verdict.allowed) logger.warn({ ...audit }, 'capability-audit');
  else if (!isMutationCapability(capability)) logger.info({ ...audit }, 'capability-audit');

  return { allowed: verdict.allowed, plan, verdict, audit };
}

/**
 * 执行侧终态审计（P0-4）：写能力在本次执行结束后记 `completed` 或 `failed`。
 * 读能力不记（它们的终态在 authorizeCall 已记 allowed|denied）。
 *
 * @param auth authorizeCall 的返回值（沿用身份、资源计划与规则码，不另算一份）
 * @param failureDetail 失败时的稳定码（枚举值/业务码），**不放异常原文或请求体**
 */
export function auditTerminal(
  capability: Capability,
  auth: AuthorizationResult,
  outcome: 'completed' | 'failed',
  failureDetail?: string,
  deferred = false,
): void {
  if (!isMutationCapability(capability)) return;
  // 沿用授权记录的身份/资源/规则码；只替换终态字段（denied 才会带 denyReason，这里必然没有）
  const { denyReason: _denyReason, ...base } = auth.audit;
  const event: CapabilityAuditEvent = {
    ...base,
    result: outcome,
    verdict: 'allow',
    ...(failureDetail !== undefined ? { failureDetail } : {}),
    // 只有**确实创建了任务**（回执带 taskId）才标 deferred；异步提交被拒时不得留一条找不到任务的记录
    ...(deferred ? { deferred: true } : {}),
  };
  logger[outcome === 'failed' ? 'warn' : 'info']({ ...event }, 'capability-audit');
}

/**
 * 从工具返回值提取失败稳定码（不读散文：只看机读字段）。
 * - MCP isError：`is_error`（硬错误在 core/errors 已给恢复提示，不进审计原文）
 * - 业务失败信封：`raw.code`；没有机读码时用 `business_failure`（不读 messages 散文）
 */
function failureCodeOf(value: unknown): { failed: boolean; detail?: string; deferred?: boolean } {
  if (value === null || typeof value !== 'object') return { failed: false };
  const rec = value as Record<string, unknown>;
  if (rec['isError'] === true) return { failed: true, detail: 'is_error' };
  const envelope = rec['structuredContent'] as
    { success?: unknown; raw?: unknown; data?: { taskId?: unknown } } | undefined;
  if (envelope === undefined || typeof envelope !== 'object') return { failed: false };
  if (envelope.success !== false) {
    return { failed: false, deferred: typeof envelope.data?.taskId === 'string' };
  }
  const raw = envelope.raw as { code?: unknown } | undefined;
  const code = raw !== null && typeof raw === 'object' && typeof raw.code === 'string' ? raw.code : undefined;
  return { failed: true, detail: code ?? 'business_failure' };
}

/**
 * 已授权调用的统一执行壳（P0-4）：授权 → 执行 → 写能力记终态。
 * 门面路由与平铺直调共用它，保证两条入口的审计字段与终态口径一致。
 *
 * @param onBlocked 拦截回执的构造器（两处形状不同：直调回 blockedCallResult，路由回同样的硬错误）
 */
export async function dispatchAuthorized<T>(
  capability: Capability,
  args: Record<string, unknown>,
  ctx: AuthorizationContext,
  dispatch: () => T | Promise<T>,
  onBlocked: (result: AuthorizationResult) => T,
): Promise<T> {
  const auth = authorizeCall(capability, args, ctx);
  if (!auth.allowed) return onBlocked(auth);
  try {
    const value = await dispatch();
    const outcome = failureCodeOf(value);
    auditTerminal(capability, auth, outcome.failed ? 'failed' : 'completed', outcome.detail, outcome.deferred);
    return value;
  } catch (e) {
    // 异常路径同样必须落一条终态（否则「每次写尝试恰好一条」在失败时失效）
    const detail =
      e !== null && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : e instanceof Error
          ? e.name
          : 'unknown_error';
    auditTerminal(capability, auth, 'failed', detail);
    throw e;
  }
}

/**
 * 档案维度的判定（只能收紧，不能放宽）。
 *
 * 三项：
 * 1. **能力在档案面内**：档案声明的能力 glob 未命中 → 拒（`capability_not_in_profile`）；
 * 2. **kind 被档案允许**：如只读档案调用写能力 → 拒（`kind_not_allowed_by_profile`）；
 * 3. **资源收紧**：档案若声明了 `resourceScopes`，写包/读 schema 必须是它的**子集**
 *    （两个方向同口径：声明了但为空 = 什么都不允许；env 文法暂不表达该项，但机制在此一次实现）。
 *
 * `profile === undefined` 的两种情形**分开处理**（fail-closed）：
 * - 部署没启用档案机制（`profilesEnabled=false`，策略里没有档案表）：跳过全部三项（向后兼容）；
 * - 部署配了档案表却解析不到条目（空档案）：产出一条 `profile_unknown` block，**全拒**——
 *   `resolveProfile` 对"未配档案"返回隐式 default，undefined 只代表这一种情形，
 *   与 profiles.ts / tools/surface.ts 声明的"空档案 = 全拒"同口径。
 */
function checkProfile(
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
  // 规则：权限只有一层（能力层）——门面是**入口**，不参与档案判定；档案的 kind/glob
  // 管的是"哪些能力可用"，门面常驻（见 tools/surface.ts 的「门面常驻」）。越界由目标能力自己的
  // 判定拦下——门面 handler 派发前会对目标能力再跑一次同一个闸门。
  if (capability.facadeOf === undefined) {
    const allowedByProfile = profileAllows(profile, capability.id, capability.kind);
    if (!allowedByProfile.ok) {
      const code = allowedByProfile.code ?? 'capability_not_in_profile';
      // profile_unknown 在此不可达：本函数已先对 undefined 档案产出 block（见上），
      // 走到这里 profile 必有值——profileAllows 对该情形只返回这两条码
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
      // 子集语义（与 readSchemas 分支同一读法）：**声明了但为空 = 一个包都不许写**。
      // 不能直接复用 isPackageAllowed 对空白名单的口径——那是"本判定层不限制"（见 write-boundary.ts），
      // 与本字段"写包子集"的定义相反：想让档案只读却写成 [] 的档案会悄悄变成"可写部署白名单内的任意包"。
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

/**
 * 拦截时对调用方的回执（**不含补救路径**，前缀固定，形状 = `mcpErrorText` 硬错误）。
 *
 * 文案构成 = 首行「被 MCP 安全策略拦截（码），请求未执行」+ 本次调用的资源计划 + 逐条结论 + 尾句。
 * 计划先于结论出现：先让调用方看清「本来会发生什么」，再看「为什么被拦」。
 * 所有能力（含写）走同一条两段式 `mcpErrorText(message, hint)`，回执形状不随入口变化。
 */
export function blockedCallResult(result: AuthorizationResult) {
  return mcpErrorText(
    `${BLOCKED_PREFIX}（${result.verdict.blocking.map((g) => g.code).join(', ')}），请求未执行`,
    // 不给绕过方法：拦截消息面向不受信的一方（通常是模型），写明「改哪项配置可放行」等于把钥匙递出去。
    `${formatWritePlan(result.plan)}\n\n${result.verdict.text}\n\n` +
      '该限制由 MCP 服务端的权限策略施加，调用方无法自行解除。',
  );
}
