/**
 * 确定性能力发现（Discover）——只回答「有哪些候选」，不返回完整 Schema、不执行。
 *
 * 为什么不做语义检索：服务端看不到用户原始请求，引入 LLM/向量都是重依赖；模型本身就是意图识别器。
 * 这里只做**可解释的关键词/标签过滤**：分类、授权类别、操作级别名、关键词。
 *
 * 候选 = 当前调用方 entitlement 内的**具体能力**（排除平台入口自身）。
 * 工具面只有 `hana_tool_search` / `hana_invoke`，把平台入口列进候选没有意义。
 */

import { CAPABILITY_LIST } from './manifest.js';
import type { Capability, CapabilityCategory, ToolKind } from './types.js';

/** discover 的过滤入参（与 defs/tool-search.ts 的 schema 同源语义） */
export interface DiscoveryQuery {
  query?: string;
  category?: CapabilityCategory;
  authorizationClass?: ToolKind;
  operationType?: string;
  limit?: number;
}

/** 候选卡（只够模型决定「选不选它」，不含 inputSchema） */
export interface CandidateCard {
  id: string;
  title: string;
  category: CapabilityCategory;
  authorizationClass: ToolKind;
  priority: 'primary' | 'fallback' | 'advanced' | 'admin';
  /** 操作级别名时给出 `#` 后段（如 add_join） */
  operation?: string;
  intent?: string;
  whenToUse?: readonly string[];
  notFor?: readonly string[];
}

const PRIORITY_RANK: Record<NonNullable<Capability['routing']>['priority'] & string, number> = {
  primary: 0,
  fallback: 1,
  advanced: 2,
  admin: 3,
};

function priorityOf(cap: Capability): CandidateCard['priority'] {
  return cap.routing?.priority ?? 'primary';
}

function operationOf(cap: Capability): string | undefined {
  const idx = cap.id.indexOf('#');
  return idx >= 0 ? cap.id.slice(idx + 1) : undefined;
}

/**
 * 单个 token 的匹配分（0 = 未命中）。权重顺序 = 「模型先看什么」：
 * id 精确 > id 片段 > 标题 > 用途 > 适用条件 > 反例 > 描述。
 */
function tokenScore(cap: Capability, token: string): number {
  const id = cap.id.toLowerCase();
  if (id === token) return 100;
  if (id.includes(token)) return 50;
  const fields: Array<[string, number]> = [
    [cap.title, 30],
    [cap.routing?.intent ?? '', 20],
    [(cap.routing?.whenToUse ?? []).join(' '), 10],
    [(cap.routing?.notFor ?? []).join(' '), 5],
    [cap.description, 2],
  ];
  let best = 0;
  for (const [text, weight] of fields) {
    if (text.toLowerCase().includes(token) && weight > best) best = weight;
  }
  return best;
}

/** 关键词打分：每个 token 取最高字段分，累加；返回命中 token 数与总分。 */
function keywordScore(cap: Capability, tokens: readonly string[]): { matched: number; score: number } {
  let matched = 0;
  let score = 0;
  for (const token of tokens) {
    const s = tokenScore(cap, token);
    if (s > 0) {
      matched += 1;
      score += s;
    }
  }
  return { matched, score };
}

function matchesFilters(cap: Capability, q: DiscoveryQuery): boolean {
  if (q.category !== undefined && cap.category !== q.category) return false;
  if (q.authorizationClass !== undefined && cap.kind !== q.authorizationClass) return false;
  if (q.operationType !== undefined && operationOf(cap) !== q.operationType) return false;
  return true;
}

/** 隐藏未 entitled 的能力名：候选卡只描述「你能用的」，不作为存在性探针。 */
function redactIds(text: string, entitledIds: ReadonlySet<string>): string {
  return text
    .replace(/hana_[a-z0-9_]+(?:#[a-z0-9_]+)?/g, (id) => (entitledIds.has(id) ? id : '相关能力'))
    .replace(/\s+/g, ' ')
    .trim();
}

function toCard(cap: Capability, entitledIds: ReadonlySet<string>): CandidateCard {
  const op = operationOf(cap);
  return {
    id: cap.id,
    title: cap.title,
    category: cap.category,
    authorizationClass: cap.kind,
    priority: priorityOf(cap),
    ...(op !== undefined ? { operation: op } : {}),
    ...(cap.routing?.intent !== undefined ? { intent: redactIds(cap.routing.intent, entitledIds) } : {}),
    ...(cap.routing?.whenToUse !== undefined && cap.routing.whenToUse.length > 0
      ? { whenToUse: cap.routing.whenToUse.map((t) => redactIds(t, entitledIds)) }
      : {}),
    ...(cap.routing?.notFor !== undefined && cap.routing.notFor.length > 0
      ? { notFor: cap.routing.notFor.map((t) => redactIds(t, entitledIds)) }
      : {}),
  };
}

/**
 * 在一次调用方的 entitlement 内做确定性发现。
 *
 * @param entitledIds 当前调用方的可触达能力 id（含门面；本函数会排除门面与 tool_search）
 * @param q 过滤条件（query 为空 = 只按标签过滤并按 priority/声明顺序排序）
 */
export function discoverCapabilities(entitledIds: ReadonlySet<string>, q: DiscoveryQuery = {}): CandidateCard[] {
  const tokens = (q.query ?? '')
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);
  const capIndex = new Map(CAPABILITY_LIST.map((c, i) => [c.id, i]));

  const scored: Array<{ cap: Capability; matched: number; score: number; index: number }> = [];
  for (const cap of CAPABILITY_LIST) {
    if (cap.platform === true) continue; // 平台入口自身不是候选
    if (!entitledIds.has(cap.id)) continue;
    if (!matchesFilters(cap, q)) continue;

    const { matched, score } = tokens.length > 0 ? keywordScore(cap, tokens) : { matched: 0, score: 0 };
    // query 非空时至少命中一个 token；不做 AND，避免「权限 诊断 预览」这类多词查询把
    // 只覆盖部分词的相关工具整类漏掉（排序已按命中数/分数拉开）。
    if (tokens.length > 0 && matched === 0) continue;
    scored.push({ cap, matched, score, index: capIndex.get(cap.id) ?? Number.MAX_SAFE_INTEGER });
  }

  scored.sort((a, b) => {
    if (a.matched !== b.matched) return b.matched - a.matched;
    if (a.score !== b.score) return b.score - a.score;
    const pa = PRIORITY_RANK[priorityOf(a.cap)];
    const pb = PRIORITY_RANK[priorityOf(b.cap)];
    if (pa !== pb) return pa - pb;
    return a.index - b.index;
  });

  const limit = Math.max(1, Math.min(q.limit ?? 20, 50));
  return scored.slice(0, limit).map((s) => toCard(s.cap, entitledIds));
}
