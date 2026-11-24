/**
 * 上下文令牌（`contextToken`）——把调用期的环境断言与披露上下文收成一个不可伪造的字符串。
 *
 * `hana_tool_search` 在回执中签发，`hana_invoke` 执行时回传；令牌绑定调用方、环境、epoch、
 * 策略代际、清单代际，以及**本次披露的能力集合**（`t`）：
 * - 服务端只验签与比较代际，不需要会话/registry；
 * - 客户端无法伪造环境、epoch、policyRev、manifestRev 或披露集合；
 * - `hana_invoke` 只能执行 `t` 内的能力：discover 的 token 为空（候选不可直接执行），
 *   contract/goal 的 token 才包含可执行能力；
 * - 令牌**不是授权凭证**：每次调用仍过 `authorizeCall`，它只证明「这份策略上下文还新鲜」。
 *
 * 进程内随机密钥：重启即失效（重新获取即可）；多副本 HTTP 需共享密钥。
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/** 令牌默认有效期 */
export const CONTEXT_TOKEN_TTL_MS = 10 * 60_000;

export interface ContextTokenPayload {
  /** 版本 */
  v: 1;
  /** profileId */
  p: string;
  /** clientId（stdio 省略） */
  c?: string;
  /** envKey */
  e: string;
  /** epoch */
  n: number;
  /** policyRev */
  pr: string;
  /** manifestRev */
  mr: string;
  /** 本次披露的能力集合（排序去重；discover 为空 = 不授予任何可执行能力） */
  t: string[];
  /** 过期时间（毫秒时间戳） */
  x: number;
}

const SECRET = randomBytes(32);

function b64url(value: Buffer): string {
  return value.toString('base64url');
}

function sign(body: string): string {
  return createHmac('sha256', SECRET).update(body).digest('base64url');
}

export interface IssueContextTokenInput {
  profileId: string;
  clientId?: string;
  envKey: string;
  epoch: number;
  policyRev: string;
  manifestRev: string;
  /** 本次披露的能力集合；discover 传空数组（候选不等于可执行） */
  toolIds: readonly string[];
  /** 测试注入；默认 Date.now() */
  now?: number;
  /** 测试/特殊部署可调；默认 {@link CONTEXT_TOKEN_TTL_MS} */
  ttlMs?: number;
}

/** 签发上下文令牌（无需 I/O）。 */
export function issueContextToken(input: IssueContextTokenInput): string {
  const now = input.now ?? Date.now();
  const payload: ContextTokenPayload = {
    v: 1,
    p: input.profileId,
    ...(input.clientId !== undefined ? { c: input.clientId } : {}),
    e: input.envKey,
    n: input.epoch,
    pr: input.policyRev,
    mr: input.manifestRev,
    t: [...new Set(input.toolIds)].sort(),
    x: now + (input.ttlMs ?? CONTEXT_TOKEN_TTL_MS),
  };
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${body}.${sign(body)}`;
}

export interface ContextTokenCheckInput {
  profileId: string;
  clientId?: string;
  envKey: string;
  epoch: number;
  policyRev: string;
  manifestRev: string;
  /** 测试注入；默认 Date.now() */
  now?: number;
}

export type ContextTokenReason = 'invalid' | 'expired' | 'principal' | 'environment' | 'epoch' | 'policy' | 'manifest';

export type ContextTokenVerdict =
  { ok: true; payload: ContextTokenPayload } | { ok: false; reason: ContextTokenReason };

function isValidPayload(value: unknown): value is ContextTokenPayload {
  if (value === null || typeof value !== 'object') return false;
  const p = value as Record<string, unknown>;
  return (
    p['v'] === 1 &&
    typeof p['p'] === 'string' &&
    (p['c'] === undefined || typeof p['c'] === 'string') &&
    typeof p['e'] === 'string' &&
    typeof p['n'] === 'number' &&
    typeof p['pr'] === 'string' &&
    typeof p['mr'] === 'string' &&
    Array.isArray(p['t']) &&
    p['t'].every((id) => typeof id === 'string') &&
    typeof p['x'] === 'number'
  );
}

/** 令牌是否包含该能力（discover 的 token 为空集：候选不等于可执行）。 */
export function tokenDiscloses(payload: ContextTokenPayload, capabilityId: string): boolean {
  return payload.t.includes(capabilityId);
}

/**
 * 校验上下文令牌。顺序固定：签名 → 过期 → 身份 → 环境 → 代际 → 策略 → 清单。
 * 任一项不一致都返回 `context_stale`（reason 用于消息/审计，不泄漏策略值）。
 */
export function verifyContextToken(token: string, current: ContextTokenCheckInput): ContextTokenVerdict {
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'invalid' };
  const body = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  const expected = sign(body);
  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'invalid' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (!isValidPayload(parsed)) return { ok: false, reason: 'invalid' };
  const payload = parsed;

  const now = current.now ?? Date.now();
  if (!Number.isFinite(payload.x) || payload.x <= now) return { ok: false, reason: 'expired' };
  if (payload.p !== current.profileId || payload.c !== current.clientId) return { ok: false, reason: 'principal' };
  if (payload.e !== current.envKey) return { ok: false, reason: 'environment' };
  if (payload.n !== current.epoch) return { ok: false, reason: 'epoch' };
  if (payload.pr !== current.policyRev) return { ok: false, reason: 'policy' };
  if (payload.mr !== current.manifestRev) return { ok: false, reason: 'manifest' };
  return { ok: true, payload };
}
