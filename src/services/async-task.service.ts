/**
 * 异步任务服务（工具化任务 API）：把**长变更集**交给进程内任务跑，立即返回 taskId。
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
 * - 终态载荷 = **与同步通道同形的信封**（三条终态路径都由 withErrorEnvelope 构造，恒带 messages 与身份
 *   字段）：成功 ⇒ `{success:true,data:<报告>}`；部分成功 ⇒ `changeset_partial`（共用
 *   `changesetPartialError`）；按取消停止 ⇒ `changeset_cancelled`（报告进 rawDetail.report）。
 *   轮询方拿到的读法与同步调用的读取代码完全一致。
 * - **不新开写路径**：任务体就是 `applyChangeset` 本体（同一实现、同一锁、同一信号量、同一补偿）。
 * - 归属：owner = 已认证 clientId / '(stdio)'；`hana_task_get|cancel` 对他人任务与不存在任务
 *   **逐字同形**（不泄漏存在性，与"未知能力"同一条原则）。
 * - 诚实边界：进程内、重启即丢；未配 Token 的 HTTP 部署按单租户假设（所有调用方 anonymous，
 *   互相可见任务——与提升表同一裁定，写进 README）。
 */

import type { HanaConfig } from '../config/config.js';
import type { HanaPool } from '../core/hana-client.js';
import type { XsRestClient } from '../core/xs-rest.js';
import type { Envelope } from '../types/hana.js';
import { HanaBusinessError, withErrorEnvelope } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { truncateWithNote } from '../core/text.js';
import {
  createTask,
  getTask,
  isCancelRequested,
  isTerminal,
  patchTask,
  requestCancel,
  type TaskKind,
  type TaskRecord,
  type TaskStatus,
} from '../core/task-registry.js';
import { TASK_TTL_MS_DEFAULT } from '../core/limits.js';
import { applyChangeset, changesetPartialError, type ChangesetReport } from './repository.service.js';
import type { ChangesetAction } from './changeset.plan.js';

/** 未知任务与"他人任务"的**同一句**回执（不泄漏存在性） */
export const UNKNOWN_TASK_TEXT = '未知任务：该任务不存在，或不属于当前调用方。';

/**
 * 异步任务执行侧终态审计（P0-4）：提交调用只记 `deferred:true` 的 completed（= 已受理），
 * **真正的写入结局**在这里按任务终态记一条 completed/failed（带 taskId）。
 * 取消按 failed + failureDetail=changeset_cancelled 记——它确实没有完成，且已触发补偿。
 */
function auditTaskTerminal(
  taskId: string,
  capabilityId: string,
  result: 'completed' | 'failed',
  detail?: string,
  writePackages: readonly string[] = [],
): void {
  const owner = getTask(taskId)?.owner ?? '(unknown)';
  const event = {
    capabilityId,
    result,
    verdict: 'allow' as const,
    ...(owner !== '(stdio)' && owner !== '(unknown)' ? { clientId: owner } : {}),
    ...(owner === '(stdio)' ? { transport: 'stdio' as const } : {}),
    via: 'async-task',
    taskId,
    ...(detail !== undefined ? { failureDetail: detail } : {}),
    resources: { writePackages: [...new Set(writePackages)], readSchemas: [], readPackages: [] },
    codes: [],
  };
  logger[result === 'failed' ? 'warn' : 'info'](event, 'capability-audit');
}

/** 终态保留时长（分钟）——模型面文案引用它，避免把 TTL 数字手抄成第二事实源 */
const TERMINAL_TTL_MINUTES = TASK_TTL_MS_DEFAULT / 60_000;

/**
 * 任务视图（hana_task_get 的载荷；result 只在终态出现）。
 * 除 taskId（= 记录的 id）与终态门控的 result 外，字段全部派生自 TaskRecord——
 * 记录形状一变这里就编译报错，而不是静默少字段。
 */
export interface TaskView extends Omit<TaskRecord, 'id' | 'owner' | 'result'> {
  taskId: string;
  terminal: boolean;
  result?: unknown;
  hint: string;
}

/** 提交回执（hana_view_update(async=true) 的载荷：立即返回，无需等待） */
export interface TaskSubmission {
  taskId: string;
  status: TaskStatus;
  kind: TaskKind;
  label: string;
  submittedAt: string;
  /** 进度形状取自 TaskRecord（current 在提交时还没有，Pick 掉） */
  progress: Pick<TaskRecord['progress'], 'total' | 'done'>;
  hint: string;
}

/** 任务的一句话标签（轮询方据此认领；对象名最多列 3 个） */
function labelOf(actions: ChangesetAction[]): string {
  const names = actions.map((a) => `${a.packageId}/${a.objectName}`).slice(0, 3);
  return `changeset ${actions.length} 项：${names.join('、')}${actions.length > 3 ? ' 等' : ''}`;
}

/** 提交回执的统一装配（changeset 与 background 两条入口同形） */
function submissionOf(record: TaskRecord, hint: string): TaskSubmission {
  return {
    taskId: record.id,
    status: record.status,
    kind: record.kind,
    label: record.label,
    submittedAt: record.createdAt,
    progress: { total: record.progress.total, done: 0 },
    hint,
  };
}

/**
 * 提交一个异步变更集任务并立即返回句柄。
 *
 * 调用方（工具层）必须已做完形状校验与 set_script 命名归一——任务体不重复做工具层的判定
 * （一条规则一份实现：归一发生在进入本函数之前的那一个边界）。
 *
 * `client` 可选注入（与 `applyChangeset` 的第四参同义）：缺省时由 applyChangeset 内部按 XS REST
 * 惯例自建（每次写调用重新登录）；单测据此注入桩、零网络跑通全流程。
 */
export function submitChangesetTask(
  config: HanaConfig,
  pool: HanaPool,
  actions: ChangesetAction[],
  owner: string,
  client?: XsRestClient,
): TaskSubmission {
  const record = createTask(owner, labelOf(actions), actions.length, 'changeset'); // 容量超限时在此抛中文硬错误（未提交任何写）
  // 双保险（评审 #1106/#1107/#1110）：任务体自身已保证「不 throw」（见下方 failTask），这里再兜一层——
  // 任何逃逸的拒约在此落 failed 终态，而不是变成未处理的 Promise 拒约（Node ≥20 默认会终止整个进程，
  // 且任务记录会永久停在 working、占满运行槽位）。
  void runChangesetTask(config, pool, record.id, actions, client).catch((e) => failTask(record.id, e));
  return submissionOf(
    record,
    '任务已在后台执行（本响应不代表任何写入结果）。用 hana_task_get({taskId}) 轮询状态；' +
      '要停止用 hana_task_cancel({taskId})——取消在动作边界生效并触发与失败相同的逆序补偿。' +
      `任务状态在进程内：服务重启即失效；终态任务约保留 ${TERMINAL_TTL_MINUTES} 分钟（注册表饱和时` +
      '最旧的终态会被提前清理），之后该 taskId 按「未知任务」处理。',
  );
}

/** 通用后台任务：调用方提供**已绑定请求上下文**的 run()（返回与同步通道同形的信封） */
export interface BackgroundTaskSpec {
  /** 任务种类（决定回执措辞与取消语义） */
  kind: TaskKind;
  /** 产生该任务的工具 id（终态审计归因；如 hana_sql_analyze） */
  capabilityId: string;
  /** 一句话标签（轮询方认领用） */
  label: string;
  /** 实际执行；抛错会被归一为 failed 终态（与同步通道的错误 envelope 同形） */
  run: () => Promise<Envelope>;
  /** 进度总数（默认 1） */
  total?: number;
}

/**
 * 提交一个通用后台任务（P：sql_analyze 长语句走这里）。
 * 与 changeset 共用同一个注册表、归属、TTL 与终态审计；差别只在任务体由调用方提供。
 */
export function submitBackgroundTask(owner: string, spec: BackgroundTaskSpec): TaskSubmission {
  const record = createTask(owner, spec.label, spec.total ?? 1, spec.kind);
  void runBackgroundTask(record.id, spec).catch((e) => failTask(record.id, e, spec.capabilityId));
  return submissionOf(
    record,
    '任务已在后台执行（本响应不代表执行结果）。用 hana_task_get({taskId}) 轮询状态与终态 result。' +
      (spec.kind === 'sql_analyze'
        ? '取消对**已开始执行的 SQL 无法生效**：分析会跑完并如实返回结果，终态会说明取消未生效。'
        : '要停止用 hana_task_cancel({taskId})。') +
      `任务状态在进程内：服务重启即失效；终态任务约保留 ${TERMINAL_TTL_MINUTES} 分钟。`,
  );
}

/** 业务失败信封 → 终态判据（success=false 不能算 completed） */
function envelopeFailureOf(envelope: Envelope): { failed: boolean; code?: string; text?: string } {
  if (envelope.success !== false) return { failed: false };
  const raw = envelope.raw as { code?: unknown } | undefined;
  const code =
    raw !== null && typeof raw === 'object' && typeof raw.code === 'string'
      ? raw.code
      : (envelope.messages.find((m) => m.type === 'E')?.id ?? envelope.messages[0]?.id);
  const text = envelope.messages.find((m) => m.type === 'E')?.text ?? envelope.messages[0]?.text;
  return { failed: true, ...(code !== undefined ? { code } : {}), ...(text !== undefined ? { text } : {}) };
}

/** 通用任务体（不 throw：所有结局落终态；异常交由 failTask 归一） */
async function runBackgroundTask(taskId: string, spec: BackgroundTaskSpec): Promise<void> {
  try {
    // 取消在**执行前**生效（进入 run 之后无法安全打断；SQL 分析尤其如此）
    if (isCancelRequested(taskId)) {
      const envelope = await withErrorEnvelope(async () => {
        throw new HanaBusinessError('任务已按取消请求停止（尚未开始执行）。', 'task_cancelled');
      });
      patchTask(taskId, { status: 'cancelled', result: envelope, errorText: '已按取消请求停止（尚未开始执行）' });
      auditTaskTerminal(taskId, spec.capabilityId, 'failed', 'task_cancelled');
      return;
    }
    patchTask(taskId, { current: '执行中' });
    const envelope = await spec.run();
    // 与 changeset 同一条铁律：**业务失败不得包装成 completed**。任务体的 run() 通常用
    // withErrorEnvelope（业务错误已转成 success=false 的信封，不会抛），必须在这里看信封判终态。
    const failure = envelopeFailureOf(envelope);
    if (failure.failed) {
      patchTask(taskId, {
        status: 'failed',
        result: envelope,
        errorText: truncateWithNote(failure.text ?? '任务执行失败', 200, 'none'),
      });
      auditTaskTerminal(taskId, spec.capabilityId, 'failed', failure.code ?? 'business_failure');
      return;
    }
    patchTask(taskId, { status: 'completed', result: envelope, done: spec.total ?? 1 });
    auditTaskTerminal(taskId, spec.capabilityId, 'completed');
  } catch (e) {
    await failTask(taskId, e, spec.capabilityId);
  }
}

/**
 * 任务体（后台执行；**不 throw**——一切结局都落成终态记录：异常路径经下方 catch 内的 failTask 兜底）。
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
      // 取消停止：与失败同路径（已执行项已逆序补偿回批前状态）；报告进 rawDetail.report 供判读。
      // 文案**从 report.applied 逐项 status 派生**（评审 #1108/#1109）：补偿失败时不得宣称"已回滚"——
      // 把部分回滚说成全部回滚正是 I2 禁止的「把部分完成包装成成功」。
      const compensated = report.applied.filter((x) => x.status === 'compensated').length;
      const compFailed = report.applied.filter((x) => x.status === 'compensation_failed').length;
      const compUnresolved = report.applied.length - compensated - compFailed;
      const outcomeText =
        compFailed === 0 && compUnresolved === 0
          ? `已执行 ${report.applied.length} 项并全部逆序补偿。`
          : `已执行 ${report.applied.length} 项：${compensated} 项已回批前状态、${compFailed} 项补偿失败` +
            (compUnresolved > 0 ? `、${compUnresolved} 项未完成补偿` : '') +
            '——未回批前状态的对象可能停在后写版本，须人工处置。';
      const envelope = await withErrorEnvelope(async () => {
        throw HanaBusinessError.withRawDetail(
          `变更集已按取消请求停止（cancelled=true）：共 ${report.requested} 项，${outcomeText}` +
            '逐项明细与补偿现场见 raw.errorDetail.report。',
          'changeset_cancelled',
          { report },
        );
      });
      patchTask(taskId, {
        status: 'cancelled',
        result: envelope,
        errorText:
          compFailed + compUnresolved > 0
            ? `已按取消请求停止；${compFailed + compUnresolved} 项未回批前状态，须人工处置（逐项见 raw.errorDetail.report）`
            : '已按取消请求停止并补偿',
      });
      auditTaskTerminal(
        taskId,
        'hana_view_update',
        'failed',
        'changeset_cancelled',
        actions.map((a) => a.packageId),
      );
      return;
    }
    if (report.partial) {
      const envelope = await withErrorEnvelope(async () => {
        throw changesetPartialError(report);
      });
      patchTask(taskId, { status: 'failed', result: envelope, errorText: '变更集未全部成功（partial）' });
      auditTaskTerminal(
        taskId,
        'hana_view_update',
        'failed',
        'changeset_partial',
        actions.map((a) => a.packageId),
      );
      return;
    }
    // 成功终态同样经 withErrorEnvelope：三条终态路径的信封逐字段同形（messages 恒在，轮询方
    // 用同一段代码读三种结局——裸对象字面量会让 messages 在读方踩空）。
    const envelope = await withErrorEnvelope(async () => report);
    patchTask(taskId, { status: 'completed', result: envelope, done: report.applied.length });
    auditTaskTerminal(
      taskId,
      'hana_view_update',
      'completed',
      undefined,
      actions.map((a) => a.packageId),
    );
  } catch (e) {
    // 整批拒绝（changeset_invalid / changeset_conflict / migration_required / 批级基础设施错误）
    await failTask(taskId, e);
  }
}

/**
 * 失败终态的统一落点（评审 #1106/#1107/#1110）：**无论什么异常都落成 failed 终态，本函数自身不 throw**。
 *
 * 为什么不能直接 `await withErrorEnvelope(async () => { throw e; })`：withErrorEnvelope 对非
 * HanaBusinessError（ProtocolError/SdkError/未知异常）的既定语义是**重新抛出**（core/errors.ts），
 * 任务体的 promise 又在提交侧被 void 丢弃——于是记录永久停在 working（清扫只动终态、永久占用运行
 * 槽位），且未处理的 Promise 拒约在 Node ≥20 默认策略下会终止整个 MCP 服务进程。故先归一为
 * HanaBusinessError（业务错误原样；其余泛化文案 + code=internal，原始异常只留服务端日志），
 * 再交给 withErrorEnvelope 落标准信封（与同步通道同形）。
 */
async function failTask(taskId: string, e: unknown, capabilityId = 'hana_view_update'): Promise<void> {
  let error: HanaBusinessError;
  if (e instanceof HanaBusinessError) {
    error = e;
  } else {
    logger.error(
      { taskId, capabilityId, err: e },
      '异步任务抛出非业务异常：归一为内部错误落终态（原始异常不向调用方泄漏）',
    );
    error = new HanaBusinessError(
      `任务执行发生内部错误（${e instanceof Error ? e.name : typeof e}），详情见服务端日志`,
      'internal',
    );
  }
  const envelope = await withErrorEnvelope(async () => {
    throw error;
  });
  patchTask(taskId, { status: 'failed', result: envelope, errorText: truncateWithNote(error.message, 200, 'none') });
  auditTaskTerminal(taskId, capabilityId, 'failed', error.code ?? 'internal');
}

/**
 * 视图：**归属校验在此**（owner 不匹配 ⇒ 与不存在同形返回 undefined）。
 * hint 按状态给下一步动作；取消请求到达太晚（批次已完成或已按失败停止）时如实说明未生效。
 */
export function taskViewFor(id: string, owner: string): TaskView | undefined {
  const t = getTask(id);
  if (!t || t.owner !== owner) return undefined;
  return viewOf(t);
}

function viewOf(t: TaskRecord): TaskView {
  const terminal = isTerminal(t.status);
  // 取消请求到达太晚、未生效的终态：completed（批次已走完）或 failed（批次先按失败停止）——
  // 两者都如实说明取消未生效（终态是批次自身的结局，不是这次取消的结果）
  const lateCancel = t.cancelRequested && (t.status === 'completed' || t.status === 'failed');
  const lateCancelHint =
    t.kind === 'sql_analyze'
      ? t.status === 'completed'
        ? '注意：取消请求到达时分析已执行完毕（未生效）——终态为 completed。'
        : '注意：取消请求到达时分析已按失败结束（未生效）——终态为 failed，失败原因见 result。'
      : t.status === 'completed'
        ? '注意：取消请求到达时批次已执行完毕（未生效）——终态为 completed。'
        : '注意：取消请求到达时批次已按失败停止（未生效）——终态为 failed，失败原因见 result。';
  return {
    taskId: t.id,
    kind: t.kind,
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
      ? t.cancelRequested
        ? t.kind === 'sql_analyze'
          ? '取消已受理：正在执行的 SQL 不会被中途打断，执行结束后终态会说明取消未生效；继续轮询即可（无需重复取消）。'
          : // 取消已受理（协作式：动作边界生效）——不能再劝一次「要停止用 hana_task_cancel」，
            // 那会让调用方重复刚做过的动作
            '取消已受理：当前动作结束后停止并执行逆序补偿，继续 hana_task_get 轮询即可（无需重复取消）。'
        : t.kind === 'sql_analyze'
          ? '任务仍在执行：稍后再次 hana_task_get 轮询（执行中的 SQL 无法取消）。'
          : '任务仍在执行：稍后再次 hana_task_get 轮询；要停止用 hana_task_cancel。'
      : lateCancel
        ? lateCancelHint
        : '任务已到终态；result 即最终回执' +
          (t.kind === 'changeset' ? '（success=false 时 raw.errorDetail 里有逐项明细）。' : '。') +
          `终态记录约保留 ${TERMINAL_TTL_MINUTES} 分钟（注册表饱和时会提前清理）——过期或进程重启后，` +
          '同一 taskId 回「未知任务」。',
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
  return { ok: true, outcome: r.outcome, view: viewOf(r.record) };
}
