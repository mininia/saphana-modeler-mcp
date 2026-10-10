/**
 * 异步任务注册表（工具化任务 API，2026-10-10）——**进程内、无 I/O、无定时器**。
 *
 * ## 为什么是"工具化"而不是协议原生 tasks
 *
 * SDK 2.3.1 的 Tasks（SEP-2663）只有线协议词汇、没有运行期，且 2026-07-28 era 上
 * `tasks/result` / `tasks/list` 恒被 -32601（era gate 无解）——协议原生路线在 modern 客户端上残缺，
 * 要接它还得替换 SDK 的 tools/call 处理器（自行复刻参数/输出校验与投影）。本仓选择**工具化任务 API**：
 * `hana_view_update(async=true)` 立即返回 taskId，`hana_task_get` / `hana_task_cancel` 轮询与取消——
 * 两个 era 行为一致、零 SDK 侵入。代价如实说：模型主动轮询，而不是客户端按协议自动轮询。
 *
 * ## 语义边界（逐条写死，别让下一个人重新推演）
 *
 * - **进程内状态、重启即丢**：任务不落盘、不跨进程共享（多进程拓扑下没有可信的共享存储，
 *   与 P10 提升表同一裁定）。重启后 `hana_task_get` 对旧 id 一律回"未知任务"。
 * - **归属隔离**：每条记录记 `owner`（HTTP = 已认证 clientId；stdio = `(stdio)`）。查询/取消只对
 *   记录者可见——**他人任务与不存在的任务逐字同形**（与"未知能力"同一条不泄漏原则）。
 *   未配 Token 的 HTTP 部署里所有调用方都是 anonymous：与提升一致按单租户假设处理，写进 README。
 * - **取消是协作式**：置位 `cancelRequested`，执行侧在每个动作**开始前**检查并停下
 *   （当前动作不打断），随后走与失败相同的逆序补偿路径——不会留下半批状态。
 * - **容量与保留**：同时运行上限 `TASK_MAX_RUNNING_DEFAULT`（超出提交即拒）；
 *   终态任务保留 `TASK_TTL_MS_DEFAULT`（惰性清扫——下一次提交时清），注册表容量
 *   `TASK_MAX_RETAINED_DEFAULT`（装满淘汰最旧终态）。
 */

import { randomUUID } from 'node:crypto';
import { HanaBusinessError } from './errors.js';
import { TASK_MAX_RETAINED_DEFAULT, TASK_MAX_RUNNING_DEFAULT, TASK_TTL_MS_DEFAULT } from './limits.js';

export type TaskStatus = 'working' | 'completed' | 'failed' | 'cancelled';

/** 终态（不再变化、可被清理） */
const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled']);

export interface TaskRecord {
  id: string;
  /** 归属键：HTTP 已认证 clientId / stdio 的 '(stdio)'（未配 Token 的 HTTP = 'anonymous'） */
  owner: string;
  /** 一句话说明（如 `changeset PKG/CV_A +2`），给轮询方认领用 */
  label: string;
  status: TaskStatus;
  createdAt: string;
  updatedAt: string;
  /** 已请求取消（协作式；执行侧在动作边界检查） */
  cancelRequested: boolean;
  progress: { total: number; done: number; current?: string };
  /** 终态载荷（成功 = 报告/envelope；失败 = 错误 envelope）；working 时缺省 */
  result?: unknown;
  /** 终态为 failed 时的一句话（与 result 里的机读码配套，便于快速判读） */
  errorText?: string;
}

/** 进程内注册表（插入序 = 创建序；淘汰按插入序从最旧的终态开始） */
const tasks = new Map<string, TaskRecord>();

/** 测试隔离用（仓库约定：模块级可变状态必须配显式重置入口） */
export function resetTaskRegistry(): void {
  tasks.clear();
}

export function countRunningTasks(): number {
  let n = 0;
  for (const t of tasks.values()) if (!TERMINAL.has(t.status)) n++;
  return n;
}

export function countTasks(): number {
  return tasks.size;
}

/** 惰性清扫：过期终态 + 超容（都只在 createTask 时跑，无定时器/无后台循环） */
function sweep(now: number): void {
  for (const [id, t] of tasks) {
    if (TERMINAL.has(t.status) && now - Date.parse(t.updatedAt) > TASK_TTL_MS_DEFAULT) tasks.delete(id);
  }
  while (tasks.size >= TASK_MAX_RETAINED_DEFAULT) {
    const oldest = [...tasks.values()].find((t) => TERMINAL.has(t.status));
    if (!oldest) break; // 全是运行中：交给运行上限兜底，不再淘汰
    tasks.delete(oldest.id);
  }
}

/**
 * 创建一个运行中的任务。**容量检查在这里**（超出运行上限抛中文业务错误——调用方立即知道
 * "现在提交不了"，而不是拿到一个永远排队中的假句柄）。
 */
export function createTask(owner: string, label: string, total: number): TaskRecord {
  const now = Date.now();
  sweep(now);
  const running = countRunningTasks();
  if (running >= TASK_MAX_RUNNING_DEFAULT) {
    throw new HanaBusinessError(
      `异步任务已达运行上限（${TASK_MAX_RUNNING_DEFAULT} 个并发）：本次未提交任何写操作。` +
        `请先等待运行中的任务结束（hana_task_get 轮询），或改用同步模式（去掉 async）`,
    );
  }
  const iso = new Date(now).toISOString();
  const record: TaskRecord = {
    id: randomUUID(),
    owner,
    label,
    status: 'working',
    createdAt: iso,
    updatedAt: iso,
    cancelRequested: false,
    progress: { total, done: 0 },
  };
  tasks.set(record.id, record);
  return record;
}

/** 按 id 取记录（**不做归属校验**——调用方一律经 async-task.service 的带归属入口） */
export function getTask(id: string): TaskRecord | undefined {
  return tasks.get(id);
}

/** 更新记录（进度/终态）；终态一经写入不可再改（防止迟到的回调把 cancelled 覆盖成 completed） */
export function patchTask(
  id: string,
  patch: {
    done?: number;
    current?: string;
    status?: TaskStatus;
    result?: unknown;
    errorText?: string;
  },
): TaskRecord | undefined {
  const t = tasks.get(id);
  if (!t) return undefined;
  if (TERMINAL.has(t.status) && patch.status !== undefined && patch.status !== t.status) return t;
  if (patch.done !== undefined) t.progress.done = patch.done;
  if (patch.current !== undefined) t.progress = { ...t.progress, current: patch.current };
  if (patch.status !== undefined) t.status = patch.status;
  if (patch.result !== undefined) t.result = patch.result;
  if (patch.errorText !== undefined) t.errorText = patch.errorText;
  t.updatedAt = new Date().toISOString();
  return t;
}

/** 执行侧的取消检查点（每个动作开始前调一次；未知 id 视为已取消——记录都没了就别再干活） */
export function isCancelRequested(id: string): boolean {
  const t = tasks.get(id);
  return t === undefined || t.cancelRequested;
}

export function requestCancel(id: string): {
  outcome: 'not_found' | 'requested' | 'already_requested' | 'terminal';
  record?: TaskRecord;
} {
  const t = tasks.get(id);
  if (!t) return { outcome: 'not_found' };
  if (TERMINAL.has(t.status)) return { outcome: 'terminal', record: t };
  if (t.cancelRequested) return { outcome: 'already_requested', record: t };
  t.cancelRequested = true;
  t.updatedAt = new Date().toISOString();
  return { outcome: 'requested', record: t };
}

/** 是否终态（对外回执的 `terminal` 字段与测试共用同一判定） */
export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.has(status);
}
