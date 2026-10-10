/**
 * 异步任务服务（工具化任务 API，2026-10-10）：把**长变更集**交给进程内任务跑，立即返回 taskId。
 *
 * ## 为什么是它（而不是协议原生 tasks）
 *
 * 见 core/task-registry.ts 头注：SDK 2.3.1 的 Tasks 无运行期，2026-era 上 tasks/result|list 恒不可服务，
 * 协议原生路线要替换 SDK 的 tools/call 处理器——本仓取工具化路线：`hana_view_update(async=true)`
 * 提交任务，`hana_task_get` 轮询、`hana_task_cancel` 取消，两个 era 行为一致、零 SDK 侵入。
 *
 * ## 语义（与注册表头注配套，别只读一处）
 *
 * - 提交即返回：`hana_view_update(async=true)` 只做**形状/策略**校验（工具层已做），把变更集的
 *   **全部 HANA 交互**（整体预检 → 逐项执行 → 补偿）放进后台执行——预检仍在任何写入之前（在任务内），
 *   「整体预检不通过 ⇒ 整批拒绝、零写入」的语义不变。
 * - 终态载荷 = **与同步通道同形的信封**：成功 ⇒ `{success:true,data:<报告>}`；部分成功 ⇒
 *   `changeset_partial`（共用 `changesetPartialError`）；按取消停止 ⇒ `changeset_cancelled`（报告进
 *   rawDetail.report）。轮询方拿到的读法与同步调用的读取代码完全一致。
 * - **不新开写路径**：任务体就是 `applyChangeset` 本体（同一实现、同一锁、同一信号量、同一补偿）。
 * - 归属：owner = 已认证 clientId / '(stdio)'；`hana_task_get|cancel` 对他人任务与不存在任务
 *   **逐字同形**（不泄漏存在性，与"未知能力"同一条原则）。
 * - 诚实边界：进程内、重启即丢；未配 Token 的 HTTP 部署按单租户假设（所有调用方 anonymous，
 *   互相可见任务——与提升表同一裁定，写进 README）。
 */

import type { HanaConfig } from '../config/config.js';
import type { HanaPool } from '../core/hana-client.js';
import type { XsRestClient } from '../core/xs-rest.js';
import { HanaBusinessError, withErrorEnvelope } from '../core/errors.js';
import {
  createTask,
  getTask,
  isCancelRequested,
  isTerminal,
  patchTask,
  requestCancel,
  type TaskRecord,
  type TaskStatus,
} from '../core/task-registry.js';
import { applyChangeset, changesetPartialError, type ChangesetReport } from './repository.service.js';
import type { ChangesetAction } from './changeset.plan.js';

/** 未知任务与"他人任务"的**同一句**回执（不泄漏存在性） */
export const UNKNOWN_TASK_TEXT = '未知任务：该任务不存在，或不属于当前调用方。';

/** 任务视图（hana_task_get 的载荷；result 只在终态出现） */
export interface TaskView {
  taskId: string;
  label: string;
  status: TaskStatus;
  terminal: boolean;
  createdAt: string;
  updatedAt: string;
  cancelRequested: boolean;
  progress: { total: number; done: number; current?: string };
  result?: unknown;
  errorText?: string;
  hint: string;
}

/** 提交回执（hana_view_update(async=true) 的载荷：立即返回，无需等待） */
export interface TaskSubmission {
  taskId: string;
  status: TaskStatus;
  label: string;
  submittedAt: string;
  progress: { total: number; done: number };
  hint: string;
}

/** 任务的一句话标签（轮询方据此认领；对象名最多列 3 个） */
function labelOf(actions: ChangesetAction[]): string {
  const names = actions.map((a) => `${a.packageId}/${a.objectName}`).slice(0, 3);
  return `changeset ${actions.length} 项：${names.join('、')}${actions.length > 3 ? ' 等' : ''}`;
}

/**
 * 提交一个异步变更集任务并立即返回句柄。
 *
 * 调用方（工具层）必须已做完形状校验与 set_script 命名归一——任务体不重复做工具层的判定
 * （I3：一条规则一份实现；归一发生在进入本函数之前的那一个边界）。
 *
 * `client` 可选注入（与 `applyChangeset` 的第四参同义）：缺省时由 applyChangeset 内部按 XS REST
 * 惯例自建（每次写调用重新登录，见 P5 的既有口径）；单测据此注入桩、零网络跑通全流程。
 */
export function submitChangesetTask(
  config: HanaConfig,
  pool: HanaPool,
  actions: ChangesetAction[],
  owner: string,
  client?: XsRestClient,
): TaskSubmission {
  const record = createTask(owner, labelOf(actions), actions.length); // 容量超限时在此抛中文硬错误（未提交任何写）
  void runChangesetTask(config, pool, record.id, actions, client);
  return {
    taskId: record.id,
    status: record.status,
    label: record.label,
    submittedAt: record.createdAt,
    progress: { total: record.progress.total, done: 0 },
    hint:
      '任务已在后台执行（本响应不代表任何写入结果）。用 hana_task_get({taskId}) 轮询状态；' +
      '要停止用 hana_task_cancel({taskId})——取消在动作边界生效并触发与失败相同的逆序补偿。' +
      '任务状态在进程内，服务重启即失效。',
  };
}

/**
 * 任务体（后台执行；**不 throw**——一切结局都落成终态记录）。
 * 与同步通道共用 applyChangeset：预检、逐项执行、逆序补偿、报告组装零分叉。
 */
async function runChangesetTask(
  config: HanaConfig,
  pool: HanaPool,
  taskId: string,
  actions: ChangesetAction[],
  client?: XsRestClient,
): Promise<void> {
  try {
    const report: ChangesetReport = await applyChangeset(config, pool, { actions }, client, {
      shouldAbort: () => isCancelRequested(taskId),
      onStep: (info) => {
        patchTask(taskId, { done: info.done, current: `第 ${info.index} 项 ${info.status}` });
      },
    });
    if (report.cancelled) {
      // 取消停止：与失败同路径（已执行项已逆序补偿回批前状态）；报告进 rawDetail.report 供判读
      const envelope = await withErrorEnvelope(async () => {
        throw HanaBusinessError.withRawDetail(
          `变更集已按取消请求停止（cancelled=true）：共 ${report.requested} 项，已执行 ${report.applied.length} 项并全部逆序补偿。` +
            '逐项明细与补偿现场见 raw.errorDetail.report。',
          'changeset_cancelled',
          { report },
        );
      });
      patchTask(taskId, { status: 'cancelled', result: envelope, errorText: '已按取消请求停止并补偿' });
      return;
    }
    if (report.partial) {
      const envelope = await withErrorEnvelope(async () => {
        throw changesetPartialError(report);
      });
      patchTask(taskId, { status: 'failed', result: envelope, errorText: '变更集未全部成功（partial）' });
      return;
    }
    patchTask(taskId, { status: 'completed', result: { success: true, data: report }, done: report.applied.length });
  } catch (e) {
    // 整批拒绝（changeset_invalid / changeset_conflict / migration_required / 批级基础设施错误）
    const envelope = await withErrorEnvelope(async () => {
      throw e;
    });
    patchTask(taskId, {
      status: 'failed',
      result: envelope,
      errorText: e instanceof HanaBusinessError ? e.message.slice(0, 200) : String(e).slice(0, 200),
    });
  }
}

/**
 * 视图：**归属校验在此**（owner 不匹配 ⇒ 与不存在同形返回 undefined）。
 * hint 按状态给下一步动作；取消请求到达太晚（批次已完成）时如实说明未生效。
 */
export function taskViewFor(id: string, owner: string): TaskView | undefined {
  const t = getTask(id);
  if (!t || t.owner !== owner) return undefined;
  return { ...viewOf(t) };
}

function viewOf(t: TaskRecord): TaskView {
  const terminal = isTerminal(t.status);
  const lateCancel = t.cancelRequested && t.status === 'completed';
  return {
    taskId: t.id,
    label: t.label,
    status: t.status,
    terminal,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
    cancelRequested: t.cancelRequested,
    progress: { ...t.progress },
    ...(terminal && t.result !== undefined ? { result: t.result } : {}),
    ...(t.errorText !== undefined ? { errorText: t.errorText } : {}),
    hint: !terminal
      ? '任务仍在执行：稍后再次 hana_task_get 轮询；要停止用 hana_task_cancel。'
      : lateCancel
        ? '注意：取消请求到达时批次已执行完毕（未生效）——终态为 completed。'
        : '任务已到终态；result 即最终回执（success=false 时 raw.errorDetail 里有逐项明细）。进程重启后本任务不再可查。',
  };
}

/** 取消请求：协作式（动作边界生效）；终态任务不可取消（如实回执，不报错） */
export function cancelTaskFor(
  id: string,
  owner: string,
): { ok: false } | { ok: true; outcome: 'requested' | 'already_requested' | 'terminal'; view: TaskView } {
  const t = getTask(id);
  if (!t || t.owner !== owner) return { ok: false };
  const r = requestCancel(id);
  if (r.outcome === 'not_found' || !r.record) return { ok: false }; // 竞态兜底（清扫只动终态，正常到不了）
  return { ok: true, outcome: r.outcome === 'terminal' ? 'terminal' : r.outcome, view: viewOf(r.record) };
}
