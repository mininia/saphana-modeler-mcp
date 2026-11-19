/**
 * 调用期授权闸门（**唯一入口**）：所有能力调用的授权判定都收敛到 `authorizeCall`。
 *
 * 为什么不能靠注册期过滤：可见性只在注册时咨询一次（见 tools/surface.ts），而工具面按连接/调用方
 * 计算；同一进程可能有多个调用方（HTTP 多客户端 + 调用方档案）；且存在不经 `tools/list` 的入口
 * （经 `hana_invoke` 派发的具体能力）。所以必须有**与入口无关**的判定函数，任何入口都调它。
 *
 * 判定内容（**复用同一个判定器与报告**）：清单的 `effects.plan` 规划出「这次会触碰什么」，
 * 交给**同一个** `runPreflight`（checkCapability + checkResource + checkDeployment），只额外附一行
 * 资源计划进报告。能力级（HANA_TOOL_GROUPS/HANA_TOOL_DENY）、资源级（HANA_WRITE_PACKAGES /
 * HANA_READ_SCHEMA）、部署级（姿态项，只出警告）判据因此一致。规则粒度由清单决定：读能力不声明
 * `effects.plan` 就没有资源结论（planFor 对读能力绝不套用写兜底）。
 *
 * 位置（为什么在 src/config/）：依赖方向决定——`capabilities/` 是声明层，只允许 import 叶子模块；
 * 本模块要 import 策略层（preflight.ts），而策略层经 tools/groups.ts → manifest.ts 依赖清单，
 * 把闸门塞进 capabilities/ 会让两层互相依赖（作废"清单不许依赖策略"这条规矩）。
 *
 * 归因：每次调用产出一条 `capability-audit`：`{clientId, transport, capabilityId, verdict, resources,
 * codes}`；放行记 info、拦截记 warn。审批等待由 approval 事件记录，确认后补放行/终态记录。
 * `agentLabel`（MCP_AGENT_LABEL）取进程级标签（未配置时不产生该字段）。
 */

import type { ApprovalGateResult } from './approval.js';
import { assembleVerdict, checkDeployment, type Policy, type Verdict } from './preflight.js';
import { evaluate, type EvaluationResult } from './evaluate.js';
import { environmentMutationScope, type EnvironmentAssertion } from './environment-policy.js';
import type { CallerProfile } from './profiles.js';
import { planReadless } from '../capabilities/planners.js';
import type { Capability } from '../capabilities/types.js';
import { BLOCKED_PREFIX, mcpErrorText } from '../core/errors.js';
import { currentAgentLabel, currentIdentity } from '../core/request-context.js';
import { currentEnvironmentRuntime } from '../core/environment-context.js';
import { currentExecutionContext } from '../core/execution-context.js';
import { logger } from '../core/logger.js';
import { formatWritePlan, type WritePlan } from '../write-plan.js';
import { sqlFingerprint } from '../services/sql-execute.rules.js';

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
   * 调用方档案。未配档案的部署由 `resolveProfile` 返回隐式 default（不额外收紧）；
   * 这里的 undefined 只代表"配了档案表却解析不到对应条目" = 空档案 → **全拒**（fail-closed）。
   */
  profile?: CallerProfile;
  /** 调用方身份（省略 = 取当前请求上下文；stdio 下为 undefined） */
  caller?: CallerIdentity;
  /** 进程级归因标签（`MCP_AGENT_LABEL`），随审计事件落地 */
  agentLabel?: string;
  /** 归因入口（经 `hana_invoke` 派发时 = "hana_invoke"；平台入口自身缺省）——只进审计，不参与判定 */
  via?: string;
  /** 调用信封里的环境断言；省略时回退 args.expectedEnvironment/expectedEpoch */
  envAssertion?: EnvironmentAssertion;
  /** 调用信封里的披露上下文（只做一致性检查，不是授权凭证） */
  disclosure?: { id?: string; policyRev?: string; manifestRev?: string };
  /** rev 补充输入（readonlySql/approvalPolicy） */
  policyRevExtras?: { readonlySql?: string; approvalPolicy?: string };
  /**
   * true = 由 dispatchAuthorized 统一记「放行后」的审计：审批确认前不记 allowed，
   * 避免被拒/待确认的破坏性调用在日志里呈现为已放行。
   */
  deferAllowAudit?: boolean;
}

/** 一次调用的授权结论 */
export interface AuthorizationResult {
  /** true = 无任何阻断级结论 */
  allowed: boolean;
  /** 本次调用的资源计划（写能力 = 读写计划；读能力 = 读范围声明） */
  plan: WritePlan;
  /** 策略判定总结果（含 blocking/warnings/text/policy） */
  verdict: Verdict;
  /** 四层检查态（能力/资源/环境/审批；与 hana_tool_search 的 preview 同源） */
  checks?: EvaluationResult['checks'];
  /** 审计事件载荷（放行/拦截至少一条；审批等待由 approval 事件记录） */
  audit: CapabilityAuditEvent;
}

/**
 * 审计终态：
 * - none/transient：`allowed | denied`（授权即终态，无持久副作用）；
 * - persistent：`denied | completed | failed`——每次尝试恰好一条终态记录。
 */
export type AuditResult = 'allowed' | 'denied' | 'completed' | 'failed';

/** 审计里的非敏感目标标识（包/对象/op；不放 SQL、不放请求体） */
export interface AuditTarget {
  packageId?: string;
  objectName?: string;
  op?: string;
  /** SQL 的 sha256 前 12 位（`args.sql` 为字符串时；**不落原文**） */
  sqlHash?: string;
  /** SQL 字符数（规模画像；**不落原文**） */
  sqlChars?: number;
}

/** `capability-audit` 事件载荷（字段固定：审计链路不随入口变化） */
export interface CapabilityAuditEvent {
  /** 本次调用的执行上下文 id（入口绑定，贯穿审计） */
  requestId?: string;
  capabilityId: string;
  /** 终态：读 = allowed|denied；写 = denied|completed|failed */
  result: AuditResult;
  /**
   * `allow|block` 投影（保留给既有日志读取方）。
   * `completed`/`failed` 都投影为 `allow`：它们是在**已授权**之后发生的执行结局。
   */
  verdict: 'allow' | 'block';
  clientId?: string;
  transport?: 'http' | 'stdio';
  /** 调用方档案名（未配档案时为隐式 default） */
  profileId?: string;
  /** 执行环境标识；仅多环境部署产生 */
  environment?: string;
  /** 执行时的环境 epoch；仅多环境部署产生 */
  epoch?: number;
  /** 执行环境的只读/可写策略；仅多环境部署产生 */
  access?: 'readwrite' | 'readonly';
  /** 调用发起时的环境标识；仅多环境部署产生 */
  calledFromEnvironment?: string;
  /** 进程级归因标签（MCP_AGENT_LABEL；未配置时不产生该字段） */
  agentLabel?: string;
  /** 归因入口（经 `hana_invoke` 派发时 = "hana_invoke"） */
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
  /** true = dryRun 零写入预演成功（result=allowed，不记 completed） */
  dryRun?: boolean;
}

/**
 * 审计终态口径：只有 persistent 记 completed/failed；none/transient 同读能力记 allowed。
 * 与写包推导的只读态同源（environmentMutationScope），不按 kind 推断。
 */
export function isPersistentMutation(capability: Capability): boolean {
  return environmentMutationScope(capability) === 'persistent';
}

/** 从入参提取非敏感目标标识（只认 string；SQL/请求体一律不进审计） */
export function auditTargetOf(args: Record<string, unknown>): AuditTarget | undefined {
  const sql = args['sql'];
  // 与规则层 parseSqlScript 同口径（trim 后求指纹）：否则仅首尾空格就会让审计与回执对不上。
  const sqlText = typeof sql === 'string' ? sql.trim() : undefined;
  const target: AuditTarget = {
    ...(typeof args['packageId'] === 'string' ? { packageId: args['packageId'] } : {}),
    ...(typeof args['objectName'] === 'string' ? { objectName: args['objectName'] } : {}),
    ...(typeof args['op'] === 'string' ? { op: args['op'] } : {}),
    // SQL 原文**绝不进审计**：只记稳定指纹与长度（同一条 SQL 可对照，但无法从日志还原语句）
    ...(sqlText !== undefined ? { op: 'sql', sqlHash: sqlFingerprint(sqlText), sqlChars: sqlText.length } : {}),
  };
  return Object.keys(target).length > 0 ? target : undefined;
}

/** 当前请求上下文的调用方身份（clientId/transport/profileId；stdio 无身份时为空对象）。 */
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
  const runtime = currentEnvironmentRuntime();
  const execution = currentExecutionContext();
  // 单环境不产生环境字段（保持输出形状兼容）。
  const envAudit = runtime?.multiEnv
    ? {
        environment: runtime.envKey,
        epoch: runtime.epoch,
        access: runtime.access,
        calledFromEnvironment: runtime.envKey,
      }
    : {};

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
      ...(execution ? { requestId: execution.requestId } : {}),
      capabilityId: '(未登记能力)',
      result: 'denied',
      verdict: 'block',
      ...(identity.clientId ? { clientId: identity.clientId } : {}),
      ...(identity.transport ? { transport: identity.transport } : {}),
      ...(profile ? { profileId: profile.id } : {}),
      ...(agentLabel ? { agentLabel } : {}),
      ...envAudit,
      ...(ctx.via ? { via: ctx.via } : {}),
      ...(unknownTarget ? { target: unknownTarget } : {}),
      resources: { writePackages: [], readSchemas: [], readPackages: [] },
      codes: ['unknown_capability'],
      denyReason: 'unknown_capability',
    };
    logger.warn({ ...audit }, 'capability-audit');
    return { allowed: false, plan: planReadless('(未登记能力)'), verdict, audit };
  }

  // 统一判定入口：preview（hana_tool_search）与 enforce（本函数）共用同一个 evaluate。
  const evaluated = evaluate({
    policy,
    ...(profile ? { profile } : {}),
    capability,
    args,
    mode: 'enforce',
    ...(runtime ? { runtime } : {}),
    ...(ctx.envAssertion ? { envAssertion: ctx.envAssertion } : {}),
    ...(ctx.disclosure ? { disclosure: ctx.disclosure } : {}),
    ...(ctx.policyRevExtras ? { policyRevExtras: ctx.policyRevExtras } : {}),
  });
  const plan = evaluated.plan;
  const verdict = evaluated.verdict;

  const target = auditTargetOf(args);
  const audit: CapabilityAuditEvent = {
    ...(execution ? { requestId: execution.requestId } : {}),
    capabilityId: capability.id,
    result: verdict.allowed ? 'allowed' : 'denied',
    verdict: verdict.allowed ? 'allow' : 'block',
    ...(identity.clientId ? { clientId: identity.clientId } : {}),
    ...(identity.transport ? { transport: identity.transport } : {}),
    ...(profile ? { profileId: profile.id } : {}),
    ...(agentLabel ? { agentLabel } : {}),
    ...envAudit,
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
  // 非持久写入授权即终态；persistent 放行时不记，由执行侧记 completed/failed。
  // 审批等待由 approval 事件记录；dispatchAuthorized 在审批通过后补 allowed（deferAllowAudit）。
  // 平台入口本身不执行 HANA：放行不写 capability-audit，拦截仍记；
  // 目标能力的审计由 hana_invoke 的内层 dispatchAuthorized 负责。
  const auditOnAllow =
    ctx.deferAllowAudit !== true && isPersistentMutation(capability) === false && capability.platform !== true;
  if (!verdict.allowed) logger.warn({ ...audit }, 'capability-audit');
  else if (auditOnAllow) logger.info({ ...audit }, 'capability-audit');

  return { allowed: verdict.allowed, plan, verdict, checks: evaluated.checks, audit };
}

/**
 * 执行侧终态审计：写能力在本次执行结束后记 `completed` 或 `failed`。
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
  if (!isPersistentMutation(capability)) return;
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
 * 已授权调用的统一执行壳：授权 → 执行 → 写能力记终态。
 * 平台入口包装与 `hana_invoke` 派发共用它，保证审计字段与终态口径一致。
 *
 * @param onBlocked 拦截回执的构造器
 */
export async function dispatchAuthorized<T>(
  capability: Capability,
  args: Record<string, unknown>,
  ctx: AuthorizationContext,
  dispatch: () => T | Promise<T>,
  onBlocked: (result: AuthorizationResult) => T,
  /** 审批：策略放行后、派发前调用；返回 input_required（等待确认）或硬错误（无法发起确认）则本次不执行 */
  approval?: () => ApprovalGateResult | undefined,
): Promise<T> {
  const auth = authorizeCall(capability, args, { ...ctx, deferAllowAudit: true });
  if (!auth.allowed) return onBlocked(auth);
  const gate = approval?.();
  if (gate) {
    // 审批无法发起（如客户端未声明 elicitation）：派发没有发生；持久写入补一条终态，
    // 保持「每次写尝试恰好一条终态」的口径。等待确认仍只记 approval 事件。
    if ((gate as { isError?: unknown }).isError === true) {
      auditTerminal(capability, auth, 'failed', 'approval_unsupported');
    }
    return gate as T;
  }
  // 审批已通过（或不需要）：非持久能力在这里补放行记录，确认前不记 allowed。
  const dryRun = args['dryRun'] === true;
  const dryRunField = dryRun ? { dryRun: true } : {};
  if (!isPersistentMutation(capability) && capability.platform !== true) {
    logger.info({ ...auth.audit, ...dryRunField }, 'capability-audit');
  }
  try {
    const value = await dispatch();
    // dryRun 是零写入预演：成功也不能记 completed（会被读成真的写了持久变更）。
    if (dryRun && isPersistentMutation(capability)) {
      logger.info({ ...auth.audit, result: 'allowed', verdict: 'allow', ...dryRunField }, 'capability-audit');
      return value;
    }
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
