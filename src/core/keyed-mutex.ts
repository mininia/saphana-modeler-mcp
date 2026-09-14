/**
 * 进程内按 key 串行化（keyed mutex）：把「先查后写」（check-then-act）的临界区锁起来。
 *
 * 背景：HTTP 模式下单个服务实例服务多个客户端，同一对象上的「检查 → 写入」序列会被并发交错
 * （典型：写仓库前的存在性检查、临时校验对象的「清理残留 → 写入 → 删除」序列）。XS REST 的
 * If-Match ETag 乐观锁只覆盖「读全文 → 改 → 写回」的窗口，覆盖不到这类 check-then-act，
 * 必须在进程内互斥。
 *
 * 语义：
 * - 同一 key 的 fn 严格串行（FIFO）；不同 key 互不阻塞
 * - fn 抛错只影响本次调用，不阻断后续排队者（锁必然释放）
 * - 队列排空后条目立即移除，Map 不随 key 数量增长
 * - 仅进程内有效：多进程/多实例部署需外部锁（本服务为单进程 HTTP 服务，进程内即足够）
 */

/** 每个 key 当前的链尾（恒为 settled 且不 reject —— 错误在链尾处被吞掉，不传染后续排队者） */
const tails = new Map<string, Promise<void>>();

/**
 * 以 key 为粒度串行执行 fn：同 key 调用按到达顺序排队，不同 key 并行。
 * 返回 fn 的返回值（或抛出 fn 的错误）。
 */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  // 接在当前链尾之后（prev 已 settled 或 pending，但永不 reject）
  const prev = tails.get(key) ?? Promise.resolve();
  const run = prev.then(fn);
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  try {
    return await run;
  } finally {
    // 运行期间若无新排队者，本条目即链尾 —— 立即清理，避免 Map 随对象数无界增长
    if (tails.get(key) === tail) tails.delete(key);
  }
}

/** 当前排队中的 key 数（调试/测试用：验证队列排空后条目被清理，无泄漏） */
export function keyedLockSize(): number {
  return tails.size;
}
