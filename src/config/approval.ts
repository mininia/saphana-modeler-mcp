/**
 * 破坏性操作审批：`effects.destructive=true` 的能力在策略放行后，要求宿主/人工确认。
 *
 * 机制：MCP 多轮往返（multi-round-trip）的 `input_required` + `elicitation/create`。
 * 审批结果绑定**能力 + 参数摘要 + 调用方 + 环境 + 过期时间**（HMAC 签名的 requestState）；
 * 参数或身份变化、状态过期 → 重新请求，不复用旧同意。
 *
 * 审批只覆盖真正需要的少数能力（delete / import；update 的 changeset delete 动作单独判定），
 * 由 `HANA_APPROVAL_POLICY` 控制：默认 `off`（不逐次确认），`destructive` 时对上述能力要求人工确认。
 * 审批不是授权：`authorizeCall` 仍先判策略。`dryRun=true` 的零写入预演不触发审批。
 *
 * **能力前提**：`elicitation/create` 需要客户端在 initialize（2025 协议）或每请求 envelope
 * （2026 协议）里声明 `elicitation`。未声明的客户端无法完成人工确认——服务端不能代替宿主，
 * 因此在派发前就返回明确的硬错误（而不是把无法满足的 `input_required` 交给 SDK 变成晦涩的
 * 协议层失败）。控制面切换等自带确认协议的能力不应标 `destructive`，见 capabilities/defs/system.ts。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  inputRequired,
  acceptedContent,
  CLIENT_CAPABILITIES_META_KEY,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { Capability } from '../capabilities/types.js';
import { currentIdentity } from '../core/request-context.js';
import { currentEnvironmentRuntime } from '../core/environment-context.js';
import { mcpErrorText } from '../core/errors.js';
import { logger } from '../core/logger.js';

export type ApprovalPolicy = 'off' | 'destructive';

/** 审批闸门的两种结局：等待确认（input_required）或无法发起确认（硬错误）。 */
export type ApprovalGateResult = InputRequiredResult | ReturnType<typeof mcpErrorText>;

const SECRET = randomBytes(32);
const TTL_MS = 5 * 60_000;

export const APPROVAL_CONFIRM_SCHEMA = z.object({
  confirm: z.boolean().describe('勾选/填 true 即同意本次破坏性操作'),
});

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function argsHash(capability: Capability, args: Record<string, unknown>): string {
  return createHash('sha256')
    .update(`${capability.id}\n${stableJson(args)}`)
    .digest('hex');
}

function sign(payload: string): string {
  return createHmac('sha256', SECRET).update(payload).digest('base64url');
}

/** 已消费的 nonce（审批单次有效）；过期清理。 */
const consumedNonces = new Map<string, number>();

function consumeNonce(nonce: string, expiresAt: number): boolean {
  const now = Date.now();
  for (const [n, exp] of consumedNonces) if (exp <= now) consumedNonces.delete(n);
  if (consumedNonces.has(nonce)) return false;
  consumedNonces.set(nonce, expiresAt);
  return true;
}

function encodeState(
  capability: Capability,
  args: Record<string, unknown>,
  principal: string,
  expiresAt: number,
  env: { key: string; epoch: number },
): string {
  const payload = Buffer.from(
    JSON.stringify({
      c: capability.id,
      h: argsHash(capability, args),
      p: principal,
      e: expiresAt,
      n: randomBytes(12).toString('base64url'),
      env,
    }),
  ).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function decodeState(
  raw: unknown,
  capability: Capability,
  args: Record<string, unknown>,
  principal: string,
  env: { key: string; epoch: number },
): boolean {
  if (typeof raw !== 'string') return false;
  const [payload, sig] = raw.split('.');
  if (!payload || !sig) return false;
  const expected = sign(payload);
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return false;
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {
      c: string;
      h: string;
      p: string;
      e: number;
      n: string;
      env: { key: string; epoch: number };
    };
    return (
      decoded.c === capability.id &&
      decoded.h === argsHash(capability, args) &&
      decoded.p === principal &&
      decoded.e > Date.now() &&
      decoded.env?.key === env.key &&
      decoded.env?.epoch === env.epoch &&
      typeof decoded.n === 'string' &&
      consumeNonce(decoded.n, decoded.e)
    );
  } catch {
    return false;
  }
}

/**
 * 当前部署的审批策略与本次调用是否需要审批。
 *
 * 审批要求来自能力声明 `approval`（与 `effects.destructive` 解耦）：delete / import 恒需确认，
 * update 仅在 changeset 含 delete 动作时确认，SQL 执行不确认。`HANA_APPROVAL_POLICY=off`（默认）
 * 时整层跳过；`destructive` 时按上述声明逐次判定。`dryRun=true` 的零写入预演不触发审批。
 */
export function approvalRequired(
  capability: Capability,
  args: Record<string, unknown>,
  policy: ApprovalPolicy | undefined,
): boolean {
  if (policy !== 'destructive') return false;
  if (capability.approval === 'always') return true;
  if (typeof capability.approval === 'function') return capability.approval(args) === true;
  return false;
}

/**
 * 当前请求的客户端是否声明了可用的表单式 elicitation。
 *
 * 与 SDK 的 `missingClientCapabilities` 同口径：
 * - 2026 协议：能力来自每请求 envelope（`io.modelcontextprotocol/clientCapabilities`）；
 * - 2025 协议：能力来自 initialize 的声明（`server.getClientCapabilities()`）；
 * - 裸 `elicitation: {}` 按 2025 语义视为支持 form；显式声明了 `form` 才算支持。
 *
 * 无法读取能力视图（无 initialize 的无状态 legacy 服务、伪造上下文）→ false（fail-closed）：
 * 此时 SDK 也无法把 elicitation 发出去。
 */
export function clientSupportsElicitation(
  server: { server?: { getClientCapabilities?: () => unknown } } | undefined,
  serverCtx: ServerContext | undefined,
): boolean {
  const envelope = (serverCtx?.mcpReq as { envelope?: Record<string, unknown> } | undefined)?.envelope;
  const declared = envelope?.[CLIENT_CAPABILITIES_META_KEY] ?? server?.server?.getClientCapabilities?.();
  if (declared === undefined || declared === null || typeof declared !== 'object') return false;
  const elicitation = (declared as Record<string, unknown>)['elicitation'];
  if (elicitation === undefined || elicitation === null) return false;
  // SDK 对非对象声明视为“已声明”（不检查成员）；对象声明要求 form 或空对象（2025 裸声明）。
  if (typeof elicitation !== 'object' || Array.isArray(elicitation)) return true;
  return Object.keys(elicitation).length === 0 || 'form' in elicitation;
}

/**
 * 破坏性写面向当前客户端的实际姿态（供 hana_system_get_info 等披露面使用）：
 * - confirm_via_host：策略要求人工确认，且客户端声明了 elicitation；
 * - allowed_without_confirmation：部署未开启审批（HANA_APPROVAL_POLICY=off，默认）；
 * - blocked：策略要求审批，但客户端无法承载 elicitation（fail-closed）。
 */
export type DestructiveWritePosture = 'confirm_via_host' | 'allowed_without_confirmation' | 'blocked';

export interface ApprovalState {
  policy: ApprovalPolicy;
  clientSupportsElicitation: boolean;
  destructiveWrites: DestructiveWritePosture;
  /** 可操作说明（只描述事实与安全替代路径，不提供策略绕过方法） */
  hint?: string;
}

export function approvalStateForClient(policy: ApprovalPolicy | undefined, clientCanElicit: boolean): ApprovalState {
  if (policy !== 'destructive') {
    return {
      policy: 'off',
      clientSupportsElicitation: clientCanElicit,
      destructiveWrites: 'allowed_without_confirmation',
      hint: '人工审批未开启（默认）：删除/导入等需要审批的操作不逐次确认。',
    };
  }
  if (clientCanElicit) {
    return { policy: 'destructive', clientSupportsElicitation: true, destructiveWrites: 'confirm_via_host' };
  }
  return {
    policy: 'destructive',
    clientSupportsElicitation: false,
    destructiveWrites: 'blocked',
    hint:
      '当前客户端未声明 elicitation/form 能力：需要审批的操作（hana_view_delete / hana_repo_import 等）会在执行前被拒；' +
      'dryRun=true 的只读预演不受影响。请让操作者改用支持 elicitation 的宿主。',
  };
}

/**
 * 策略放行后的审批闸门：
 * - 未开启审批 / 本次调用无审批要求 → undefined（放行）；
 * - `dryRun=true` → undefined（零写入预演，不需要人工确认；见下）；
 * - 已有**匹配当前参数/身份/未过期**的同意 → undefined（放行）；
 * - 客户端未声明 elicitation → 硬错误（无法发起人工确认，调用不执行）；
 * - 否则返回 `input_required`（宿主/人工确认）。
 */
export function approvalGate(
  capability: Capability,
  args: Record<string, unknown>,
  policy: ApprovalPolicy | undefined,
  serverCtx: ServerContext,
  principalId?: string,
  envArg?: { key: string; epoch: number },
  /** 调用方从连接/请求能力声明算出的“客户端能收 elicitation”；省略视为能（SDK 仍会兜底拒绝） */
  clientCanElicit = true,
): ApprovalGateResult | undefined {
  if (!approvalRequired(capability, args, policy)) return undefined;
  // dryRun 是零写入预演（当前仅 view_update 声明）：审批只约束真实写入，预演不请求人工确认。
  // 与 dispatchAuthorized 的审计口径同源——dryRun 成功记 allowed + dryRun:true，不记 completed。
  if (args['dryRun'] === true) return undefined;
  const principal = principalId ?? currentIdentity()?.clientId ?? '(stdio)';
  const runtime = currentEnvironmentRuntime();
  const env = envArg ?? { key: runtime?.envKey ?? 'DEFAULT', epoch: runtime?.epoch ?? 1 };
  const responses = serverCtx?.mcpReq?.inputResponses;
  const accepted = acceptedContent(responses, 'approve', APPROVAL_CONFIRM_SCHEMA);
  const rawState = typeof serverCtx?.mcpReq?.requestState === 'function' ? serverCtx.mcpReq.requestState() : undefined;
  if (accepted?.confirm === true && decodeState(rawState, capability, args, principal, env)) {
    logger.info({ capabilityId: capability.id, principal, verdict: 'approved' }, 'approval');
    return undefined;
  }
  const target =
    typeof args['packageId'] === 'string' && typeof args['objectName'] === 'string'
      ? `${args['packageId']}/${args['objectName']}`
      : '(未命名目标)';
  // 先确认客户端能承载 elicitation 再发 input_required：否则 SDK 的 legacy shim / 2026 能力门
  // 会在协议层失败，回执既不是业务信封也没有可操作的恢复提示。
  if (!clientCanElicit) {
    logger.warn(
      { capabilityId: capability.id, principal, verdict: 'unsupported', environment: env.key, epoch: env.epoch },
      'approval',
    );
    return mcpErrorText(
      `无法请求人工确认（当前客户端未声明 elicitation/form 能力）：破坏性操作 ${capability.id}（${target}）未执行`,
      '审批由宿主发起，服务端不能代替。请让操作者改用声明 elicitation 能力的 MCP 客户端/宿主后重试；' +
        'dryRun=true 的只读预演不需要审批，可先做结构 diff。不要重复同一参数组合，' +
        '也不要检索或修改本机安装/配置文件——这是部署侧的能力缺失，不是可在调用侧修复的参数问题。',
    );
  }
  logger.info(
    { capabilityId: capability.id, principal, verdict: 'requested', ttlSec: Math.round(TTL_MS / 1000) },
    'approval',
  );
  return inputRequired({
    inputRequests: {
      approve: inputRequired.elicit({
        message: `确认执行破坏性操作 ${capability.id}（${target}）？同意仅对本次参数有效，${Math.round(TTL_MS / 60_000)} 分钟后过期。`,
        requestedSchema: APPROVAL_CONFIRM_SCHEMA,
      }),
    },
    requestState: encodeState(capability, args, principal, Date.now() + TTL_MS, env),
  });
}
