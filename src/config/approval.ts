/**
 * 破坏性操作审批：`effects.destructive=true` 的能力在策略放行后，要求宿主/人工确认。
 *
 * 机制：MCP 多轮往返（multi-round-trip）的 `input_required` + `elicitation/create`。
 * 审批结果绑定**能力 + 参数摘要 + 调用方 + 环境 + 过期时间**（HMAC 签名的 requestState）；
 * 参数或身份变化、状态过期 → 重新请求，不复用旧同意。
 *
 * 破坏性能力一旦策略允许就必须经过一次人工确认（无开关）；审批不是授权：`authorizeCall` 仍先判策略。
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import {
  inputRequired,
  acceptedContent,
  type InputRequiredResult,
  type ServerContext,
} from '@modelcontextprotocol/server';
import type { Capability } from '../capabilities/types.js';
import { currentIdentity } from '../core/request-context.js';
import { currentEnvironmentRuntime } from '../core/environment-context.js';
import { logger } from '../core/logger.js';

export type ApprovalPolicy = 'off' | 'destructive';

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

/** 当前部署的审批策略（固定为 destructive；参数保留用于测试/兼容）。 */
export function approvalRequired(capability: Capability, policy: ApprovalPolicy | undefined): boolean {
  return policy === 'destructive' && capability.effects.destructive === true;
}

/**
 * 策略放行后的审批闸门：
 * - 未启用/非破坏性 → undefined（放行）；
 * - 已有**匹配当前参数/身份/未过期**的同意 → undefined（放行）；
 * - 否则返回 `input_required`（宿主/人工确认）。
 */
export function approvalGate(
  capability: Capability,
  args: Record<string, unknown>,
  policy: ApprovalPolicy | undefined,
  serverCtx: ServerContext,
  principalId?: string,
  envArg?: { key: string; epoch: number },
): InputRequiredResult | undefined {
  if (!approvalRequired(capability, policy)) return undefined;
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
  logger.info(
    { capabilityId: capability.id, principal, verdict: 'requested', ttlSec: Math.round(TTL_MS / 1000) },
    'approval',
  );
  const target =
    typeof args['packageId'] === 'string' && typeof args['objectName'] === 'string'
      ? `${args['packageId']}/${args['objectName']}`
      : '(未命名目标)';
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
