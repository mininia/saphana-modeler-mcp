/**
 * 披露 id 注册表（P2）：只用于**过期关联/一致性检查**，不是授权凭证。
 *
 * `hana_tool_search` 发出披露包时登记 id → (toolIds/envKey/epoch/policyRev/manifestRev)；
 * 执行入口收到 `disclosure.id`/`disclosureId` 时按当前上下文核对。进程内、有界、带 TTL：
 * 重启/跨进程即视为旧披露（`disclosure_stale`），不会把注册表当会话或授权。
 */

export interface DisclosureRecord {
  toolIds: readonly string[];
  envKey: string;
  epoch: number;
  policyRev: string;
  manifestRev: string;
}

interface Stored extends DisclosureRecord {
  expiresAt: number;
}

const TTL_MS = 10 * 60_000;
const MAX = 256;
const records = new Map<string, Stored>();

function sweep(now: number): void {
  for (const [id, rec] of records) {
    if (rec.expiresAt <= now) records.delete(id);
  }
  while (records.size >= MAX) {
    const oldest = records.keys().next();
    if (oldest.done) break;
    records.delete(oldest.value);
  }
}

/** 登记一次披露（同一 id 覆盖；只存元数据，不存 bindings/参数值）。 */
export function registerDisclosure(id: string, record: DisclosureRecord): void {
  const now = Date.now();
  sweep(now);
  records.set(id, { ...record, expiresAt: now + TTL_MS });
}

/**
 * 当前上下文下该披露 id 是否仍有效：
 * - 未登记/过期 → false（旧包/重启/跨进程）；
 * - 工具不在该披露的集合内 → false（不能拿 A 的包给 B 用）；
 * - envKey/epoch/policyRev/manifestRev 任一不一致 → false。
 */
export function isDisclosureCurrent(
  id: string,
  toolId: string,
  current: { envKey: string; epoch: number; policyRev: string; manifestRev: string },
): boolean {
  const rec = records.get(id);
  if (!rec || rec.expiresAt <= Date.now()) return false;
  return (
    rec.toolIds.includes(toolId) &&
    rec.envKey === current.envKey &&
    rec.epoch === current.epoch &&
    rec.policyRev === current.policyRev &&
    rec.manifestRev === current.manifestRev
  );
}

/** 测试隔离 */
export function resetDisclosureRegistry(): void {
  records.clear();
}
