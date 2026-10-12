import { HanaBusinessError } from './errors.js';
import { LOCK_WAIT_MS_DEFAULT, normalizeWaitMs } from './limits.js';

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
 * - 排队等待超时（默认 LOCK_WAIT_MS_DEFAULT）：**入队即计时，到点即拒**（与信号量同一套语义）——
 *   waitMs 到点若仍未开始执行，立刻 reject（LOCK_WAIT_TIMEOUT_CODE），并把该排队项标记为已跳过：
 *   轮到它时**直接跳过、绝不执行 fn**（链尾照旧吞错，后续排队者不受影响）；已经开始的 fn 不受
 *   超时影响（定时器已清）。仍然不做「报超时但 fn 照跑」：那会产生幽灵写，调用方已收到失败、
 *   写却发生了，与变更集的补偿/回滚交错时会破坏「部分成功显式枚举」。
 *   必须到点即拒：若等轮到自己才检查超时标志，持锁者卡住（例如锁内的 DB 读挂住）时排队者的
 *   promise 永不 settle，waitMs 形同虚设，与本模块「排队不会无限期」的承诺相反。
 * - 队列排空后条目立即移除，Map 不随 key 数量增长
 * - 仅进程内有效：多进程/多实例部署需外部锁（本服务为单进程 HTTP 服务，进程内即足够）
 *
 * 这条超时也提醒本锁的定位：**锁是加速器，不是正确性设施**——它让并发的 check-then-act 按序
 * 进入、少一次「对象已存在」式的伪失败，而不是提供跨进程保证。跨进程的真相始终是 ETag 与
 * 服务端语义（412/404）。因此等待超时只承诺两件事：排队不会无限期、超时不会假成功（fn 绝不
 * 执行）；它不承诺锁外的并发状态不被人改动——锁失效（多进程、超时跳出）时由 ETag 兜底。
 *
 * 边界（别把这条超时当持锁者的时限）：waitMs 保证的是「**排队**有上界」，不是「持锁者一定有界」——
 * 持锁者自身的时限由写路径各自的 XS/SQL 超时负责；持锁者真挂死时，后续每个排队者仍在各自
 * waitMs 内失败退出（不会被无限拖住），已跳过的位次等持锁者 settle 后一次性滑过、绝不执行 fn。
 */

/** 锁等待超时的机读错误码（HanaBusinessError.code → 失败信封 raw.code；值即名字，日志可直读） */
export const LOCK_WAIT_TIMEOUT = 'LOCK_WAIT_TIMEOUT';

/** 错误码别名（调用方/测试按此名引用；导出名即契约，勿改） */
export const LOCK_WAIT_TIMEOUT_CODE = LOCK_WAIT_TIMEOUT;

/** withKeyedLock 的可选项 */
export interface KeyedLockOptions {
  /**
   * 排队等待上限 ms（缺省 LOCK_WAIT_MS_DEFAULT）。显式 0 按 0ms 处理：
   * 只给真正无需等待的调用留预算，任何可见的排队都视为超时。
   * NaN / Infinity / 负数不是合法输入，一律回落 LOCK_WAIT_MS_DEFAULT（见 limits.ts 的 normalizeWaitMs）。
   */
  waitMs?: number;
}

/** 每个 key 当前的链尾（恒为不 reject —— 错误在链尾处被吞掉，不传染后续排队者） */
const tails = new Map<string, Promise<void>>();

/**
 * 以 key 为粒度串行执行 fn：同 key 调用按到达顺序排队，不同 key 并行。
 * 返回 fn 的返回值（或抛出 fn 的错误）；排队等待超过 waitMs 时立刻以锁超时错误失败，
 * 且该排队项被跳过——fn **不会执行**。
 */
export async function withKeyedLock<T>(key: string, fn: () => Promise<T>, opts: KeyedLockOptions = {}): Promise<T> {
  const waitMs = normalizeWaitMs(opts.waitMs, LOCK_WAIT_MS_DEFAULT);
  // 接在当前链尾之后（prev 已 settled 或 pending，但永不 reject）
  const prev = tails.get(key) ?? Promise.resolve();

  // 到点即拒：超时 promise 与「轮到自己」的 run 抢跑，谁先 settle 谁定调用方看到的结果。
  // 关键点：不看「轮到自己」这个时点——否则持锁者卡住时排队者永不 settle，waitMs 失效。
  let started = false; // true = fn 已开始执行（此后不再受排队超时约束）
  let skipped = false; // true = 已对调用方到点拒；轮到本条目时必须跳过 fn（幽灵写禁令）
  let timeoutError: HanaBusinessError | undefined;
  let rejectWait: ((e: unknown) => void) | undefined;
  const timeoutHit = new Promise<never>((_, reject) => {
    rejectWait = reject;
  });
  // 文案对操作类型保持中立：同一把锁既服务写路径，也服务只读的节点预览（dp: 键），
  // 「写操作 / 未执行任何写动作」的措辞会把只读预览的超时误报成写冲突
  const timeoutMessage = `等待对象锁超时（${waitMs}ms）：键 ${key} 上仍有未完成的操作。本次调用未执行，请稍后重试`;
  const timer = setTimeout(() => {
    if (started || skipped) return; // 已开始执行（清过定时器，这里兜底）或已跳过：不得再拒
    skipped = true;
    timeoutError = new HanaBusinessError(timeoutMessage, LOCK_WAIT_TIMEOUT_CODE);
    rejectWait?.(timeoutError);
  }, waitMs);
  // 等待定时器不阻塞进程退出（与连接池 acquire 的 waiter 同款处理）
  timer.unref?.();

  const run = prev.then(async () => {
    if (skipped) {
      // 已到点拒过：本队列位次无条件跳过，绝不执行 fn。该错误不会到达调用方（race 已先行失败），
      // 只被链尾吞掉；skipped=true 必与 timeoutError 在定时器里同时置位
      throw timeoutError ?? new HanaBusinessError(timeoutMessage, LOCK_WAIT_TIMEOUT_CODE);
    }
    // fn 自身的耗时不受锁等待超时约束：一开始执行就清掉等待定时器
    started = true;
    clearTimeout(timer);
    return fn();
  });
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  // 链尾清理由本条目结算后自行发起，不放在调用方的 finally：到点拒时本条目可能还挂在未 settle 的
  // 链上，此刻删 Map 会让后来的调用以为无人持锁、另起一条并行链与仍在执行的持锁者撞车（互斥失效）
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return Promise.race([run, timeoutHit]);
}

/** 当前排队中的 key 数（调试/测试用：验证队列排空后条目被清理，无泄漏） */
export function keyedLockSize(): number {
  return tails.size;
}

/**
 * 清空全部锁条目（**仅测试用**）：跨用例隔离。
 * 与 view-cache 的 clear() 对称 —— 模块级可变状态都要有显式的重置入口，
 * 否则测试之间只能靠"跑完自然排空"隐式隔离。
 */
export function resetKeyedLocks(): void {
  tails.clear();
}
