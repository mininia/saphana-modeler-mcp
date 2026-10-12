import { HanaBusinessError } from './errors.js';
import { normalizeWaitMs, SEMAPHORE_WAIT_MS_DEFAULT } from './limits.js';

/**
 * 进程内全局并发闸门（信号量）：按 name 分组限制「同时执行」的操作数。
 *
 * 为什么与 keyed mutex 并存、不可互相替代：
 * - keyed lock 管「同一对象互斥」——同 key 串行、不同 key 并行，不关心同时在跑多少；
 * - 信号量管「全局并发上限」——不看对象只看总量。激活是 2–10s 的重操作，多代理并发下
 *   不限流会互相打爆（XS 会话 / 仓库激活队列 / CPU），这正是本闸门的目标场景
 *   （HANA_ACTIVATION_CONCURRENCY，默认 2，见 limits.ts）。
 *
 * 定位（免得被当成正确性设施）：这是**性能/资源设施**——只在进程内有效，多进程/多实例
 * 部署时各进程各限各的（真上多实例应改为跨进程配额）。正确性（并发冲突的检测与拒绝）
 * 由 ETag 乐观锁与服务端语义（412/404）兜底，不依赖本闸门。
 *
 * 语义：
 * - 按 name 分组 FIFO；同时执行数不超过 limit（limit 非正/非有限/小数都会收敛，见 normalizeLimit）
 * - 排队等待超时（默认 SEMAPHORE_WAIT_MS_DEFAULT）：入队即计时，到时即失败退出，fn **不会执行**、
 *   不占许可；后续等待者照常获得许可（放行时跳过已退出者）
 * - 释放走 finally：fn 抛错也必然归还许可
 * - 队列排空（无执行中、无等待者）后条目立即移除，Map 不随 name 数量增长
 */

/** 信号量等待超时的机读错误码（HanaBusinessError.code → 失败信封 raw.code；值即名字，日志可直读） */
export const SEMAPHORE_WAIT_TIMEOUT = 'SEMAPHORE_WAIT_TIMEOUT';

/** 错误码别名（与 SEMAPHORE_WAIT_TIMEOUT 同值；仅本模块构造超时错误时引用） */
const SEMAPHORE_WAIT_TIMEOUT_CODE = SEMAPHORE_WAIT_TIMEOUT;

/** withSemaphore 的可选项 */
export interface SemaphoreOptions {
  /**
   * 排队等待上限 ms（缺省 SEMAPHORE_WAIT_MS_DEFAULT）。显式 0 按 0ms 处理：
   * 只给真正无需等待的调用留预算，任何可见的排队都视为超时。
   * NaN / Infinity / 负数不是合法输入，一律回落 SEMAPHORE_WAIT_MS_DEFAULT
   * （收敛逻辑与 keyed lock 共用在 limits.ts 的 normalizeWaitMs）。
   */
  waitMs?: number;
}

/** 队列等待者（与连接池 acquire 的 waiter 同形态：定时器 + settled 标记） */
interface Waiter {
  /** true = 已超时退出或已获放行；超时回调与放行方据此互斥，保证恰好了结一次 */
  settled: boolean;
  timer?: NodeJS.Timeout;
  resolve: () => void;
}

/** 一个 name 的闸门（limit 可由调用更新；排空即从 Map 删除） */
interface Gate {
  limit: number;
  active: number;
  queue: Waiter[];
}

/** 按 name 分组的闸门（排空即删，保证 Map 不随 name 数量增长） */
const gates = new Map<string, Gate>();

/**
 * 在 name 队列中取得一个许可后执行 fn（同 name 同时执行数不超过 limit），执行完自动归还。
 * 排队等待超过 waitMs 时抛 SEMAPHORE_WAIT_TIMEOUT（对外契约名；模块内私有别名 SEMAPHORE_WAIT_TIMEOUT_CODE
 * 与它同值，仅实现细节），fn **不会执行**。
 */
export async function withSemaphore<T>(
  name: string,
  limit: number,
  fn: () => Promise<T>,
  opts: SemaphoreOptions = {},
): Promise<T> {
  const gate = await acquireGate(name, normalizeLimit(limit), normalizeWaitMs(opts.waitMs, SEMAPHORE_WAIT_MS_DEFAULT));
  try {
    return await fn();
  } finally {
    // 释放必须在 finally：fn 抛错也要归还许可，否则后续等待者永久排队
    releaseGate(name, gate);
  }
}

/** 当前 name 的执行中 / 排队中计数（调试与测试断言用；没有条目的 name 返回全 0） */
export function semaphoreStats(name: string): { active: number; waiting: number } {
  const gate = gates.get(name);
  return gate ? { active: gate.active, waiting: gate.queue.length } : { active: 0, waiting: 0 };
}

/**
 * 清空全部信号量条目（**仅测试用**）：跨用例隔离（与 resetKeyedLocks 对称）。
 * 在途调用仍持有自己的 Gate 引用，其释放只作用于该引用；
 * 清理时的归属检查保证不会误删清空后重建的同名条目。
 */
export function resetSemaphores(): void {
  gates.clear();
}

/** limit 收敛：非正 / 非有限 / 小数一律不可用——0 或负数会让所有人永久排队，小数无意义 */
function normalizeLimit(limit: number): number {
  return Number.isFinite(limit) && limit >= 1 ? Math.floor(limit) : 1;
}

/**
 * 取许可：有空位且无人在排队时直接通过（FIFO：绝不插到等待者前面）；否则入队等放行或超时。
 * 返回所挂靠的 Gate —— 释放按此引用操作，即使中途 resetSemaphores 清过条目也不会错记到新条目上。
 */
function acquireGate(name: string, limit: number, waitMs: number): Promise<Gate> {
  const existing = gates.get(name);
  const gate: Gate = existing ?? { limit, active: 0, queue: [] };
  if (!existing) gates.set(name, gate);
  // 同一 name 的 limit 以最近一次调用为准（本服务的调用方传同一常量；改小只是暂缓放行）
  gate.limit = limit;

  if (gate.active < gate.limit && gate.queue.length === 0) {
    gate.active++;
    return Promise.resolve(gate);
  }
  return new Promise<Gate>((resolve, reject) => {
    const waiter: Waiter = {
      settled: false,
      resolve: () => resolve(gate),
    };
    waiter.timer = setTimeout(() => {
      if (waiter.settled) return; // 已获放行（放行方已清定时器，这里兜底抢跑）：不得再抛超时
      waiter.settled = true;
      // 立刻摘除：不占许可、不挡后面的等待者。超时者不会被留到「轮到自己」再抛——那只是让调用方白等
      const i = gate.queue.indexOf(waiter);
      if (i >= 0) gate.queue.splice(i, 1);
      reject(
        new HanaBusinessError(
          `等待 ${name} 队列超时（${waitMs}ms，并发上限 ${gate.limit}）：本次操作未执行，请稍后重试`,
          SEMAPHORE_WAIT_TIMEOUT_CODE,
        ),
      );
      cleanupIfDrained(name, gate);
    }, waitMs);
    // 等待定时器不阻塞进程退出（与连接池 acquire 的 waiter 同款处理）
    waiter.timer.unref?.();
    gate.queue.push(waiter);
  });
}

/** 归还一个许可：按 FIFO 放行后续等待者（跳过已超时退出者），必要时清理空条目 */
function releaseGate(name: string, gate: Gate): void {
  gate.active--;
  while (gate.active < gate.limit) {
    const next = gate.queue.shift();
    if (!next) break;
    if (next.settled) continue; // 已超时退出：不占许可，继续看下一位
    next.settled = true;
    if (next.timer) clearTimeout(next.timer);
    gate.active++;
    next.resolve();
  }
  cleanupIfDrained(name, gate);
}

/** 排空（无执行中、无等待者）即删条目；归属检查（Map 里仍是本对象）防误删后来重建的同名条目 */
function cleanupIfDrained(name: string, gate: Gate): void {
  if (gate.active === 0 && gate.queue.length === 0 && gates.get(name) === gate) gates.delete(name);
}
