import type { HanaPool } from '../core/hana-client.js';
import { nowIso } from '../core/datetime.js';
import { HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { logger, redactSensitive } from '../core/logger.js';
import { type EtagSource, type FileMeta, type WriteCheckResult, XsRestClient } from '../core/xs-rest.js';
import type { HanaConfig } from '../config/config.js';
import {
  type ChangesetAction,
  type ChangesetConflict,
  type ChangesetPlanResult,
  planChangeset,
} from './changeset.plan.js';
import type { BreakingItem, MigrationDeclaration } from './migrate.rules.js';
import {
  type ActivationDetail,
  activationDetailOf,
  designTimeTarget,
  invalidateViewCache,
  normalizeObjectName,
  updateViaRest,
  writeLockKey,
} from './repo-transport.service.js';
import {
  type CreateCalcViewInput,
  type ViewUpdateOperation,
  assessDeletionGate,
  createCalculationView,
  deleteCalculationView,
  isObjectNotFoundError,
  migrationGateRejected,
  summarizeBreakingItems,
  updateCalculationView,
} from './view-write.service.js';

/* ── 变更集（多对象事务）：SSD §6.1 第 2–4 步 + §6.3 补偿 + §6.4 报告 ────────
 * 单次调用内闭合的四步：① planChangeset 整体预检（形状非法 / 相交 / **破坏性未声明** ⇒ 整批拒绝零写入，
 * 破坏性判定见 precheckChangesetGates——在任何写之前）② 逐项执行（各自完成含激活）
 * ③ 失败 ⇒ 逆序补偿 ④ 组装报告（partial 与 notExecuted 显式枚举，绝不把部分完成包装成 success）。
 *
 * 【对 SSD §6.1「整批持有 keyed lock」的实测偏差】原文要求「逐个 withKeyedLock 并整批持有至批结束」——
 * 在本仓**不可实现且会自锁死**：withKeyedLock 不可重入，而三个写路径各自会取同一把对象锁
 * （createCalculationView 的临界区 / updateCalculationView 的整段判定与 PUT / deleteCalculationView →
 * deleteViaRest），批内先持锁再调用它们 = 排队等自己。本批的裁定：
 *   - **逐项执行、各自取锁**：动作已按 (packageId, objectName) 字典序稳定排序（planChangeset），
 *     任意两批不会形成顺序相反的加锁环 ⇒ 不构成 ABBA 死锁；
 *   - 批的一致性由另两条既有保证兜住：批内**对象级相交检测**（§6.2，相交 ⇒ 零写入）与
 *     **每项自己的 If-Match 基线**（写前预读的 ETag 显式传给写路径 ⇒ 批外并发写以 412 暴露 ⇒
 *     `conflict_external`），而不是靠整批持锁的隔离；
 *   - 代价如实说：批**不提供跨项快照隔离**——逐项提交，失败即逆序补偿，期间的批外读写对本批可见。
 * 该裁定同时写进回执（ChangesetReport.concurrencyNote），调用方不必读代码就知道这条偏差与理由。
 *
 * 依赖说明（I3）：读写集推导/排序/相交检测全部由 changeset.plan（其内部走 write-plan 的共享扫描件）
 * 承担，本文件**不出现第二份**扫描器；写路径一律复用既有服务函数，不另写一份。
 */

/**
 * 变更集单项报告（SSD §6.4 形状）。
 *
 * `index` 是**调用方原始顺序**的下标（不是执行序位置）：执行按 planChangeset 的字典序，
 * 但报告一律按调用方自己的顺序说话——否则「第 3 项失败」在报告里会指向另一个动作。
 */
export interface ChangesetReportItem {
  index: number;
  packageId: string;
  objectName: string;
  action: string;
  status: 'ok' | 'failed' | 'compensated' | 'compensation_failed' | 'conflict_external';
  /**
   * 该项**写成功后**回执里的新基线（= 该项的补偿基线，SSD §6.3）。
   * 为什么不能用写前基线：本项自己的 PUT 已推进版本，拿写前基线做补偿的 If-Match 必得伪 412。
   * delete 项恒无此字段：删除后不存在可作基线的 ETag——它的补偿材料是原文（回写），不是 ETag。
   */
  etag?: string;
  /** etag 的来源（代码既有 EtagSource 连字符取值）：'response-header'=写响应头同刻读数；'unavailable'=回执没带基线 */
  etagSource?: EtagSource;
  /** 失败原因（失败的项与补偿失败的项都带出）；code 为机读码（如 412 / migration_required / OBJECT_NOT_FOUND） */
  error?: { code?: string; text: string };
  /**
   * 补偿失败 / 批外冲突的**结构化现场**（不许只塞进 error.text：机读方要按 currentETag/currentVersion 核对）。
   * 来源：412 冲突载荷的补读（currentETag/currentVersion）或补偿前探测读数；取不到就不产生该字段。
   */
  currentETag?: string;
  currentVersion?: number;
  /** 本项**自身**执行耗时 ms（写入前预读 + 写入/激活）；不含补偿耗时（补偿计入报告总 elapsedMs） */
  elapsedMs?: number;
  /**
   * 该项写成功后服务端回报的**激活状态**（来源：update → UpdateCalculationViewResult.activated、
   * create → CreateCalcViewResult.activated——均取自写响应的 SapBackPack.Activated 同刻读数）。
   * SSD §6.1 第 3 步要求各项「各自完成（**含激活**）」：activated === false 的项按 `failed` 处理
   * （触发停止 + 逆序补偿 + partial=true），activated === true 照旧 ok。
   * delete 项没有激活概念，如实缺省（不产生该字段）。
   */
  activated?: boolean;
  /**
   * 激活未通过的一行摘要（来源与单对象通道回执的 activationErrors 同源：错误码 + 首行）。
   * 完整激活明细（含 Type/Procedure DDL）不随变更集报告透出——失败项的 error.text 里给复核线索。
   */
  activationErrors?: string;
  /**
   * 该项写成功回执里的诚实性警告（当前来源：create 通道的 CreateCalcViewResult.warnings——
   * 自动取列命中上限的截断标注与显式列类型未解析）。批量通道不许把它静默丢弃：同一载荷走单对象
   * 通道会看到警告、走批却看不到时，调用方会按「全列/类型齐全」的错误口径读回执。
   * 无警告的项不产生该字段（不制造恒为空噪音）。
   */
  warnings?: string[];
}

/**
 * 未执行项（不变量 2：所有「部分成功」都要**显式枚举未完成项**，不许打包成 success，也不许让调用方
 * 靠 requested 与 applied 的差集自行推断）。两个来源：
 * - 批被**整体预检拒绝**（载荷形状非法 / 批内相交 / 破坏性未声明 ⇒ 整批拒绝、零写入）：全部动作都未执行，
 *   reason='batch_rejected'——此时没有报告可返回（调用以业务错误终止），同一形状的枚举随**三条拒绝路径**
 *   的载荷 errorDetail.notExecuted 带出（三条路径统一携带，机读方不会在其中任何一条落空）；
 * - 某项失败后**中止**（SSD §6.1：任一项失败即停止）：该项之后（执行序）的动作一件都不执行，
 *   reason='aborted_after_failure'。
 */
export interface ChangesetNotExecutedItem {
  /** 调用方原始顺序的下标（与 ChangesetReportItem.index 同一口径） */
  index: number;
  packageId: string;
  objectName: string;
  action: string;
  reason: 'batch_rejected' | 'aborted_after_failure' | 'cancelled';
  /** 为什么没执行（如「因第 N 项失败而中止」）；无补充信息时缺省（不制造恒为空噪音） */
  detail?: string;
}

/**
 * partial 报告 ⇒ 业务失败错误（I2：绝不把部分完成包装成 success）。
 *
 * **单点实现**：同步工具通道（hana_view_update 的 changeset 分支）与异步任务通道（async-task.service
 * 的终态结算）共用这一份——两处各写一遍文案与载荷必然漂移，而这是调用方据以判读批次结局的关键回执。
 * 逐项 status/etag/elapsedMs 与结构化补偿现场原样进 rawDetail.report，机读方按 {applied, partial} 形状读。
 */
export function changesetPartialError(report: ChangesetReport): HanaBusinessError {
  const skipped = report.requested - report.applied.length;
  return HanaBusinessError.withRawDetail(
    `变更集未全部成功（partial=true）：共 ${report.requested} 项——` +
      report.applied
        .map((x) => `第 ${x.index} 项 ${x.action} ${x.packageId}/${x.objectName} ⇒ ${x.status}`)
        .join('；') +
      // 首次失败即停止（不继续执行后续项）：未执行项不进 applied，这里如实点名数量，别让调用方以为漏报了
      (skipped > 0 ? `；另有 ${skipped} 项在首次失败后未执行` : '') +
      '。逐项明细与补偿现场见 raw.errorDetail.report。',
    'changeset_partial',
    { report },
  );
}

/**
 * 变更集报告（SSD §6.4；I2：部分成功显式枚举）。
 *
 * `applied` 只装**实际执行过**的动作：它可能少于 `requested`——差额就是「首次失败之后按其后未执行的动作」
 * （SSD §6.1：任一项失败即停止）。未执行项**不进 applied**（状态枚举里没有 skipped，宁可少报也不凭空标
 * ok/failed），整体信号由 partial 承担。
 *
 * `notExecuted` 是**必填**字段（对 SSD §6.4 形状的扩展，不变量 2）：未执行项显式枚举，别让调用方靠
 * applied 的差集推断（机读方容易漏）。全成功时为空数组（不制造噪音）。
 *
 * `uncertain` 只在非空时产生：planChangeset 的「解析不出对象级坐标」条目原样带入——相交检测对它们是
 * 「不判」而非「判过没有」，成功回执必须让两者可区分（没有引用 vs 解析不了而没判）。
 * 全成功且全部可解析时该字段缺省（不制造噪音）。
 *
 * `concurrencyNote` 是 always present 的**偏差声明**（见文件段落头注）：批不整批持锁，逐项执行各自取锁。
 */
export interface ChangesetReport {
  requested: number;
  applied: ChangesetReportItem[];
  /** 本次**没有执行**的动作（前项失败后中止；批被预检拒绝的情形见 ChangesetNotExecutedItem）：显式枚举（不变量 2） */
  notExecuted: ChangesetNotExecutedItem[];
  /** 批内**未参与相交判定**的引用（解析不出对象级坐标；逐条含第几项与原因）：仅非空时产生 */
  uncertain?: string[];
  /** 有任何非 ok ⇒ true。绝不允许把部分完成包装成 success（I2） */
  partial: boolean;
  /**
   * true = 因**取消请求**而停止（工具化任务 API 的 hana_task_cancel）——与失败中止走同一条
   * 「停止 → 逆序补偿 → 如实报告」路径，此字段让调用方区分两种停止原因（未取消时不产生该键）。
   */
  cancelled?: boolean;
  /** 报告组装时刻（进程时区 ISO 秒级，与 impact().asOf 同一口径） */
  asOf: string;
  /** 总耗时 ms（SSD §6.5：批时长如实给——每对象含 2–10s 激活） */
  elapsedMs: number;
  /** 并发裁定说明（always present）：为什么不整批持锁 + 防 ABBA 与正确性由什么兜住（见段落头注） */
  concurrencyNote: string;
}

/**
 * 并发裁定文案（单一常量：段落头注、报告字段、单测断言同一份，避免三处各写一遍而漂移）。
 * always present：它不是「实测到的异常」，而是本批**恒定成立**的并发语义——调用方必须知道批不提供隔离。
 */
const CHANGESET_LOCKING_NOTE =
  '并发裁定（对 SSD §6.1「整批持有 keyed lock」的实测偏差）：本批逐项执行、各自取锁，不整批持锁——' +
  'withKeyedLock 不可重入，而 create/update/delete 各写路径自身会取同一把对象锁，批内先持锁再调用它们等于自锁死。' +
  '防 ABBA 死锁由执行序保证（动作已按 (packageId, objectName) 字典序稳定排序，任意两批不会形成相反加锁环）；' +
  '批的一致性由另两条兜住：批内对象级相交检测（§6.2，相交 ⇒ 整批拒绝零写入）与每项自己的 If-Match 基线' +
  '（批外并发写 ⇒ 该项 412 ⇒ conflict_external）。代价如实说：本批**不提供跨项快照隔离**——逐项提交，' +
  '失败即逆序补偿（§6.3），期间的批外读写对本批可见。';

/** 执行期的内部记录 = 报告项 + 补偿材料（原文 / 写成功后的新基线） */
interface ChangesetRecord {
  index: number;
  action: ChangesetAction;
  status: ChangesetReportItem['status'];
  /** 写成功后的新 ETag（**补偿基线**；create/update 才有；delete 后无基线可言） */
  postEtag?: string;
  etagSource?: EtagSource;
  /** 该项写入后服务端回报的激活状态（update/create 才有；delete 无激活概念 ⇒ 缺省） */
  activated?: boolean;
  /** 激活未通过的一行摘要（与单对象通道回执的 activationErrors 同源） */
  activationErrors?: string;
  /** 该项写成功回执里的警告（如 create 的自动取列截断标注）；无警告时缺省 */
  warnings?: string[];
  /** 写入前紧贴本项预读的原文（update/delete 的补偿材料；create 无原文，补偿=删除） */
  originalXml?: string;
  error?: { code?: string; text: string };
  currentETag?: string;
  currentVersion?: number;
  elapsedMs: number;
}

/** 单项执行的**成功**结果：补偿材料随之带出（失败即抛出，由调用方记成 failed/conflict_external） */
interface ChangesetActionOutcome {
  originalXml?: string;
  postEtag?: string;
  etagSource?: EtagSource;
  /**
   * 激活状态：写响应同刻读数。走到「成功结果」里只可能是 true 或缺省——
   * activated === false 的项在 executeChangesetAction 内即抛 ChangesetActivationError（按 failed 处理），
   * 不会作为成功结果返回；缺省 = 该项没有激活概念（delete）。
   */
  activated?: boolean;
  /** 写成功回执里的警告（如 create 的自动取列截断标注）；无警告时不产生该字段 */
  warnings?: string[];
}

/**
 * 变更集项的**激活失败**（内部错误：只在 executeChangesetAction → applyChangeset 的 catch 之间流转）。
 * 为什么要有这个专用类型：写成功但激活未通过（HTTP 555，文件已写）必须按 failed 处理，而报告项要同时
 * 如实带出 activated=false 与 activationErrors 摘要——普通错误携带不了这两个读数，用 rawDetail 塞又
 * 会把它（若意外逃逸）当服务端原始载荷回显，语义不对。它 extends HanaBusinessError ⇒ 既有
 * changesetErrorOf（脱敏文本 + 机读码）与 changesetFailureStatus（非 412 ⇒ failed）路径零改动复用。
 */
class ChangesetActivationError extends HanaBusinessError {
  constructor(
    message: string,
    /** 激活失败摘要（单对象通道回执 activationErrors 同源；服务端未附明细时缺省） */
    readonly activationErrors: string | undefined,
    /** 服务端激活错误码（如 40117），取自 activationDetail.errorCode */
    code?: string,
  ) {
    super(message, code);
    this.name = 'ChangesetActivationError';
  }
}

/** 单项补偿结果：只两态——回到批前状态（compensated）或如实失败（带结构化现场） */
type ChangesetCompensationOutcome =
  | { status: 'compensated' }
  | {
      status: 'compensation_failed';
      error: { code?: string; text: string };
      currentETag?: string;
      currentVersion?: number;
    };

/**
 * 执行一次变更集（SSD §6.1 的 1–4 步，单次调用内闭合）。
 *
 * 失败语义：**整批拒绝**发生在第 1 步（载荷形状非法 ⇒ changeset_invalid（形状校验在任何 I/O 之前）；
 * 批内相交 ⇒ changeset_conflict；**破坏性未声明 ⇒ migration_required**），三者都在任何写动作
 * 之前、零写入，且机读载荷统一带 notExecuted；第 2 步起的失败（含「写成功但激活失败」）
 * 一律走「停止 → 逆序补偿 → 如实报告」，绝不包装成 success。
 *
 * 破坏性判定在冲突检测之后、逐项执行之前一次判完（只读，见 precheckChangesetGates）：任一被拦 ⇒
 * 整批拒绝、零写入。若判定只藏在逐项执行内部，批内更早的动作已写过库、版本已推进，随后才逆序补偿——
 * 审计上可见两次写入，与「整批拒绝、零写入」的公开承诺相悖。
 */
export async function applyChangeset(
  config: HanaConfig,
  pool: HanaPool,
  input: { actions: ChangesetAction[] },
  client?: XsRestClient,
  hooks?: {
    /** 协作式取消检查点：**每个动作开始前**调一次；true ⇒ 本项与后续项都不执行，走与失败相同的逆序补偿 */
    shouldAbort?: () => boolean;
    /** 每完成一项后回调（异步任务的进度回报用；同步路径不传） */
    onStep?: (info: { done: number; total: number; index: number; status: string }) => void;
  },
): Promise<ChangesetReport> {
  const startedAt = Date.now();
  const actions = readChangesetActions(input);
  // 第 1 步：整体预检（纯函数、零 I/O）。三条拒绝路径都在任何写动作之前 ⇒ 整批拒绝、零写入：
  //   ① planChangeset（数量 / action 取值）⇒ changeset_invalid
  //   ② 载荷形状校验（前移到本步：确定性形状错误不许 fail-open 到执行期）⇒ changeset_invalid
  //   ③ 相交检测 ⇒ changeset_conflict + rawDetail.conflicts（含冲突对象与两个**原始下标**）
  // 每条拒绝的机读载荷都带 notExecuted：机读方按 notExecuted 读「哪些没做」时不会落空。
  const plan = planChangesetOrThrow(actions);
  const shapeErrors = changesetPayloadShapeErrors(actions);
  if (shapeErrors.length > 0) throw changesetInvalidPayloadError(shapeErrors, actions);
  if (plan.conflicts.length > 0) throw changesetConflictError(plan.conflicts, actions);

  // 批内共享一个 XS 会话：调用方未显式注入 client 时，本批自建**一个**实例传给预检/执行/补偿
  // （逐项自建会话 = 每项固定多付 3 次登录往返 + 一个服务端 XS 会话）。
  // 懒建（三条纯函数拒绝路径仍在建 client 之前）：只在确有 I/O 之前创建，避免零写入拒绝也触发建连前置。
  const batchClient = client ?? new XsRestClient(config);
  // 第 1.5 步（整体预检的判定面，SSD §6.1 第 1 步「任一被拦 ⇒ 整批拒绝、零写入」）：逐动作做破坏性
  // 判定（**任何写之前**；判定本身只读，见 precheckChangesetGates）。任一被拦 ⇒ 整批拒绝、零写入。
  const rejected = await precheckChangesetGates(config, pool, plan, batchClient);
  if (rejected.length > 0) throw changesetMigrationRequiredError(actions, rejected);

  // 第 2 步：逐项执行（按 planChangeset 的字典序执行序；每项各自完成、含激活）。
  // 任一项失败 ⇒ **立刻停止**（不继续执行后续项），进入第 3 步。
  const executed: ChangesetRecord[] = [];
  const notExecuted: ChangesetNotExecutedItem[] = [];
  let aborted = false;
  let cancelledByRequest = false;
  for (let i = 0; i < plan.order.length; i++) {
    const step = plan.order[i]!;
    // 取消检查点（异步任务 API）：在**动作开始前**判定——当前动作不打断（写/激活是原子步），
    // 停止后与失败同路（逆序补偿），不会留下半批状态。
    if (hooks?.shouldAbort?.()) {
      for (const pending of plan.order.slice(i)) {
        notExecuted.push({
          index: pending.originalIndex,
          packageId: pending.action.packageId,
          objectName: pending.action.objectName,
          action: pending.action.action,
          reason: 'cancelled',
          detail: '收到取消请求，本项未执行（已执行的项按逆序补偿回批前状态）',
        });
      }
      aborted = true;
      cancelledByRequest = true;
      break;
    }
    const itemStartedAt = Date.now();
    try {
      const outcome = await executeChangesetAction(config, pool, step.action, batchClient);
      executed.push({
        ...outcome,
        index: step.originalIndex,
        action: step.action,
        status: 'ok',
        elapsedMs: Date.now() - itemStartedAt,
      });
      hooks?.onStep?.({ done: executed.length, total: plan.order.length, index: step.originalIndex, status: 'ok' });
    } catch (e) {
      // 写成功但激活失败（HTTP 555）在 executeChangesetAction 内以 ChangesetActivationError 抛出——
      // 该项按 failed 记录，并如实带出 activated=false 与 activationErrors 摘要（报告形状见字段注释）。
      const activationFailure = e instanceof ChangesetActivationError ? e : undefined;
      executed.push({
        index: step.originalIndex,
        action: step.action,
        // 失败项的状态判定（SSD §6.4）：错误码 412（写冲突）⇒ conflict_external；其它 ⇒ failed
        status: changesetFailureStatus(e),
        elapsedMs: Date.now() - itemStartedAt,
        error: changesetErrorOf(e),
        ...changesetConflictEvidence(e),
        ...(activationFailure
          ? {
              activated: false,
              ...(activationFailure.activationErrors !== undefined
                ? { activationErrors: activationFailure.activationErrors }
                : {}),
            }
          : {}),
      });
      // 不变量 2：失败项之后（执行序）的动作一件都不执行——**显式枚举**进 notExecuted，
      // 别让调用方拿 requested 与 applied 求差集推断（机读方容易漏）。
      for (const pending of plan.order.slice(i + 1)) {
        notExecuted.push({
          index: pending.originalIndex,
          packageId: pending.action.packageId,
          objectName: pending.action.objectName,
          action: pending.action.action,
          reason: 'aborted_after_failure',
          detail: `因第 ${step.originalIndex} 项失败而按序停止（本项未执行）`,
        });
      }
      hooks?.onStep?.({
        done: executed.length,
        total: plan.order.length,
        index: step.originalIndex,
        status: 'failed',
      });
      aborted = true;
      break;
    }
  }

  // 第 3 步：逆序补偿——**只有中途失败（aborted）才补偿**：全成功时什么都不回退（否则等于自己把批撤销）。
  // 补偿对象是已 ok 的项，按**执行序的逆序**（executed 的排列就是执行序，倒着走即可）。
  // 一项补偿失败不阻断其余项：每项各自尽力回到批前状态，失败的原样报（compensation_failed + 结构化现场）。
  if (aborted) {
    for (let i = executed.length - 1; i >= 0; i--) {
      const record = executed[i]!;
      if (record.status !== 'ok') continue;
      const outcome = await compensateChangesetItem(config, record, batchClient);
      record.status = outcome.status;
      if (outcome.status === 'compensation_failed') {
        record.error = outcome.error;
        if (outcome.currentETag !== undefined) record.currentETag = outcome.currentETag;
        if (outcome.currentVersion !== undefined) record.currentVersion = outcome.currentVersion;
      }
    }
  }

  // 第 4 步：组装报告（按调用方原始下标升序；partial 与 notExecuted 显式枚举，I2）
  const applied: ChangesetReportItem[] = executed
    .map((r) => ({
      index: r.index,
      packageId: r.action.packageId,
      objectName: r.action.objectName,
      action: r.action.action,
      status: r.status,
      ...(r.postEtag !== undefined ? { etag: r.postEtag } : {}),
      ...(r.etagSource !== undefined ? { etagSource: r.etagSource } : {}),
      // 激活状态与失败摘要如实带出（ok 项 activated===true；激活失败项 activated===false + 摘要；
      // delete 项没有激活概念 ⇒ 两个字段都不产生）
      ...(r.activated !== undefined ? { activated: r.activated } : {}),
      ...(r.activationErrors !== undefined ? { activationErrors: r.activationErrors } : {}),
      // 写成功回执的警告照实带出（如 create 的自动取列截断标注；无警告的项不产生该字段）
      ...(r.warnings !== undefined ? { warnings: r.warnings } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.currentETag !== undefined ? { currentETag: r.currentETag } : {}),
      ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}),
      elapsedMs: r.elapsedMs,
    }))
    .sort((a, b) => a.index - b.index);
  return {
    requested: actions.length,
    applied,
    notExecuted: notExecuted.sort((a, b) => a.index - b.index),
    // 相交检测的盲区如实带出（仅非空时产生）：plan.uncertain 里的引用**未参与**相交判定——
    // 成功回执必须让「解析不出、没判」与「确实没有引用」可区分（见 changeset.plan 的降级口径）。
    ...(plan.uncertain.length > 0 ? { uncertain: plan.uncertain } : {}),
    partial: applied.some((x) => x.status !== 'ok'),
    // 因取消请求而停止（与失败同路径补偿）：如实标注，让调用方区分"失败中止"与"按你的取消停下"
    ...(cancelledByRequest ? { cancelled: true } : {}),
    asOf: nowIso(),
    elapsedMs: Date.now() - startedAt,
    concurrencyNote: CHANGESET_LOCKING_NOTE,
  };
}

/**
 * 全部动作的「未执行」枚举（reason='batch_rejected'）：三条零写入拒绝路径
 * （migration_required / changeset_conflict / changeset_invalid）的机读载荷**统一**携带同一形状——
 * 机读方按 notExecuted 读「哪些没做」时不会在其中任何一条路径上落空。
 * `detailOf` 只给**被拦项**加一句为什么（其余不加，不制造恒为空噪音）。
 */
function changesetNotExecutedAll(
  actions: ChangesetAction[],
  detailOf?: (index: number) => string | undefined,
): ChangesetNotExecutedItem[] {
  return actions.map((action, index) => {
    const detail = detailOf?.(index);
    return {
      index,
      packageId: action.packageId,
      objectName: action.objectName,
      action: action.action,
      reason: 'batch_rejected' as const,
      ...(detail !== undefined ? { detail } : {}),
    };
  });
}

/** 第 1 步的入参判形：动作来自 JSON，类型层保证不了（非数组一律按形状错误拒绝、零写入） */
function readChangesetActions(input: { actions: ChangesetAction[] }): ChangesetAction[] {
  const actions: unknown = input?.actions;
  if (!Array.isArray(actions)) {
    const message = '变更集未执行（整批拒绝、零写入）：changeset.actions 必须是数组';
    // 机读载荷与另两条拒绝路径同形（无动作可枚举 ⇒ notExecuted 为空数组，如实缺省而非编造条目）
    throw HanaBusinessError.withRawDetail(message, 'changeset_invalid', { errors: [message], notExecuted: [] });
  }
  return actions as ChangesetAction[];
}

/**
 * 第 1 步：planChangeset（纯函数）。它抛的 Error 是**形状校验**（动作数超上限 / 未知 action），
 * 转成业务错误 changeset_invalid——消息原样保留（点名第几项与非法值），调用方据此改参数后重试。
 * 机读载荷带 errors（原因）+ notExecuted（覆盖全部动作，reason='batch_rejected'）。
 */
function planChangesetOrThrow(actions: ChangesetAction[]): ChangesetPlanResult {
  try {
    return planChangeset(actions);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw HanaBusinessError.withRawDetail(`变更集未执行（整批拒绝、零写入）：${cause}`, 'changeset_invalid', {
      errors: [cause],
      notExecuted: changesetNotExecutedAll(actions),
    });
  }
}

/**
 * 第 1 步的**载荷形状校验**（纯函数、任何 I/O 之前）——逐 action 判「该动作的载荷能不能表达」。
 * 为什么必须前移：「update 既无 xml 也无 operations」「两者同给」这类**确定性**错误若拖到第 2 步执行到
 * 该项、由 updateCalculationView 抛错才失败，执行序上更早的动作已真实写入再被补偿，与「任一被拦 ⇒
 * 整批拒绝、零写入」的公开承诺相悖。
 * 只判形状，不判取值语义：create 的列/枚举等更深校验仍归 createCalculationView（同一处判定，不复制——
 * 与执行分支的既有注释同口径）；update 的「有 xml / 有 operations」与 updateCalculationView 同义
 * （空串/空数组不算有），判的就是要写的。
 * 「与自身无关的字段」一律拒绝而不是静默忽略（静默忽略比报错更难查）——例如 delete 带 xml、
 * create 带 operations、update 带 create 专用的 description/mode/source/scripted。
 */
interface ChangesetPayloadError {
  /** 调用方原始下标（与报告口径一致） */
  index: number;
  message: string;
}

function changesetPayloadShapeErrors(actions: ChangesetAction[]): ChangesetPayloadError[] {
  const errors: ChangesetPayloadError[] = [];
  /** 「与自身无关的字段」检查：存在即报（undefined 才算没给，null 也按给了算——静默忽略更难查） */
  const rejectUnrelated = (index: number, action: ChangesetAction, fields: Array<keyof ChangesetAction>): void => {
    const present = fields.filter((f) => action[f] !== undefined);
    if (present.length > 0) {
      errors.push({
        index,
        message: `${action.action} 动作不接受与自身无关的字段：${present.join('、')}（给了即整批拒绝，不静默忽略）`,
      });
    }
  };
  actions.forEach((action, index) => {
    switch (action.action) {
      case 'update': {
        // 与 updateCalculationView 的入口判定同义（空串/空数组不算「有」）：二选一且必有其一
        const hasXml = typeof action.xml === 'string' && action.xml.length > 0;
        if (action.operations !== undefined && !Array.isArray(action.operations)) {
          errors.push({ index, message: 'operations 必须是数组' });
          break;
        }
        const hasOperations = Array.isArray(action.operations) && action.operations.length > 0;
        if (hasXml && hasOperations) {
          errors.push({ index, message: 'xml 与 operations 二选一，不能同时提供' });
          break;
        }
        if (!hasXml && !hasOperations) {
          errors.push({ index, message: '须提供 xml（全量 XML）或 operations（声明式操作补丁）之一' });
          break;
        }
        rejectUnrelated(index, action, ['description', 'mode', 'source', 'scripted']);
        break;
      }
      case 'delete': {
        // delete 的载荷就是「目标对象」本身；其余字段一律无落点（migration 是它合法的声明位，不在此列）
        rejectUnrelated(index, action, ['xml', 'operations', 'description', 'mode', 'source', 'scripted']);
        break;
      }
      case 'create': {
        rejectUnrelated(index, action, ['xml', 'operations', 'migration']);
        if (action.mode !== undefined && action.mode !== 'projection' && action.mode !== 'sql') {
          errors.push({
            index,
            message: `mode 非法：${JSON.stringify(action.mode)}（合法值：projection / sql）`,
          });
          break;
        }
        // 「须有可表达的定义」：projection（含缺省）要 source，sql 要 scripted——缺了就是确定性错误，
        // 不许拖到执行期才由 createCalculationView 报（那时更早的动作已写过库）
        if (action.mode === 'sql') {
          if (action.scripted === undefined)
            errors.push({ index, message: 'mode=sql 须提供 scripted（script + columns）' });
        } else if (action.source === undefined) {
          errors.push({ index, message: 'mode=projection 须提供 source（schema + name）' });
        }
        break;
      }
    }
  });
  return errors;
}

/**
 * 「前 N 条 + 等共 M 项」截断摘要（三条零写入拒绝文案共用同一上限与措辞——各写一份时改一处必漏两处）。
 * 只用于消息里的人读部分；机读列表始终全量进 rawDetail 对应字段。
 */
function cappedSummary<T>(items: T[], format: (item: T) => string, limit = 5): string {
  const shown = items.slice(0, limit).map(format);
  return items.length > shown.length ? `${shown.join('；')}；等共 ${items.length} 项` : shown.join('；');
}

/**
 * 载荷形状错误 ⇒ 整批拒绝（changeset_invalid）。机读载荷与另两条零写入拒绝路径同形：
 * rawDetail.errors = 逐条「第 N 项：原因」；rawDetail.notExecuted = 覆盖**全部**动作（reason='batch_rejected'，
 * 被拦项多一句自己的原因）。消息只陈述事实（哪几项、什么形状问题），不给补救指引。
 */
function changesetInvalidPayloadError(errors: ChangesetPayloadError[], actions: ChangesetAction[]): HanaBusinessError {
  const summary = cappedSummary(errors, (e) => `第 ${e.index} 项 ${e.message}`);
  const messageByIndex = new Map(errors.map((e) => [e.index, e.message]));
  return HanaBusinessError.withRawDetail(
    `变更集未执行（整批拒绝、零写入）：${errors.length} 项载荷形状非法——${summary}`,
    'changeset_invalid',
    {
      errors: errors.map((e) => `第 ${e.index} 项：${e.message}`),
      notExecuted: changesetNotExecutedAll(actions, (i) => messageByIndex.get(i)),
    },
  );
}

/**
 * 批内对象级相交 ⇒ 整批拒绝、零写入（SSD §6.2）。机读载荷 rawDetail.conflicts 带冲突对象与两个
 * **原始下标**（a<b，均指调用方传入顺序）；消息只陈述事实与冲突项对，不给补救指引（SSD §1.3）。
 * rawDetail 同时带 notExecuted（覆盖全部动作，reason='batch_rejected'；相交的项多一句为什么）。
 */
function changesetConflictError(conflicts: ChangesetConflict[], actions: ChangesetAction[]): HanaBusinessError {
  const summary = cappedSummary(
    conflicts,
    (c) => `${c.object.packageId}/${c.object.objectName}（第 ${c.a} 项 与 第 ${c.b} 项，${c.kind}）`,
  );
  const involved = new Set<number>();
  for (const c of conflicts) {
    involved.add(c.a);
    involved.add(c.b);
  }
  return HanaBusinessError.withRawDetail(
    `变更集被拒绝（整批拒绝、零写入）：批内 ${conflicts.length} 项对象级相交——${summary}。` +
      '同一对象被两个动作以写-写或写-读方式触碰时，任何执行序都无法两全（SSD §6.2），故本批一件都不做。',
    'changeset_conflict',
    {
      conflicts,
      notExecuted: changesetNotExecutedAll(actions, (i) =>
        involved.has(i) ? '该动作与其他动作在批内对象级相交（本批因此整批拒绝）' : undefined,
      ),
    },
  );
}

/**
 * 预检拦下的一个动作（供拒绝载荷与 notExecuted 组装）。`index` = 调用方原始下标（报告口径统一）。
 */
interface ChangesetRejectedAction {
  index: number;
  packageId: string;
  objectName: string;
  /** 该动作命中的破坏项（既有 BreakingItem 形状）：调用方据此逐条决定 migration 声明 */
  items: BreakingItem[];
}

/**
 * 第 1.5 步：**整体预检的破坏性判定**（SSD §6.1 第 1 步 + §6.6）。
 * 在任何写之前把「会被迁移闸门拒」的动作一次判完；任一被拦 ⇒ 由调用方整批拒绝、零写入。
 * 若判定只藏在逐项执行内部（跑到该项才失败、再逆序补偿），批内更早的对象已被写过、版本已推进——
 * 与「整批拒绝、零写入」相悖。
 *
 * 复用与代价（I3）：update 走 updateCalculationView 的只读 dryRun 预演，delete 走 assessDeletionGate
 * （与 deleteCalculationView 同一判定件）——判定只有这一份实现，不另写 diff/判定。代价如实说：
 * 每个 update 动作多一次「读 + 变换 + diff + 影响半径查询」、每个 delete 动作多一次影响半径查询；
 * 批次本就重（每对象含 2–10s 激活），这点只读开销可接受。
 *
 * 「判不了」不等于「会被拒」：dryRun / 判定自身抛错（对象不存在、基线缺失、解析失败、查询故障）时
 * **不拦截**，只记一条 warn——该动作进执行阶段后仍会跑同一套判定与闸门（两层都在，防回归），
 * 失败语义维持既有行为（停止 + 逆序补偿）；把读故障升级成整批拒绝属于新失败面，不在本批口径内。
 */
async function precheckChangesetGates(
  config: HanaConfig,
  pool: HanaPool,
  plan: ChangesetPlanResult,
  client?: XsRestClient,
): Promise<ChangesetRejectedAction[]> {
  const rejected: ChangesetRejectedAction[] = [];
  for (const step of plan.order) {
    const action = step.action;
    try {
      if (action.action === 'update') {
        const report = await updateCalculationView(
          config,
          pool,
          action.packageId,
          action.objectName,
          changesetUpdatePayload(action),
          {
            dryRun: true,
            // 动作自己的声明原样进预演：声明的破坏性动作照常放行（accept 判定在报告里，
            // 执行期它自己的闸门也会放行——两层都在，防回归）
            ...(action.migration
              ? { migration: action.migration as { strategy: MigrationDeclaration; note?: string } }
              : {}),
          },
          client,
        );
        // 防御：dryRun 恒返回预演回执；拿到写入回执说明调用出错——宁可跳过本项判定（执行期闸门仍在）
        if (!('mode' in report)) continue;
        // 与执行期 assertMigrationDeclared **同一谓词**（migrationGateRejected）：被拦 ⇔ 同样的调用
        // 去掉 dryRun 会被拒。两处判据各写一份时，预检放行/执行拒绝的漂移就是「先写后补偿」的来源。
        if (migrationGateRejected(report.breaking, action.migration)) {
          rejected.push({
            index: step.originalIndex,
            packageId: action.packageId,
            objectName: action.objectName,
            items: report.breaking.items,
          });
        }
      } else if (action.action === 'delete') {
        // 与 deleteCalculationView 的闸门同口径：同一判定件 + 同一谓词（migrationGateRejected）
        const gate = await assessDeletionGate(pool, action.packageId, action.objectName);
        if (migrationGateRejected(gate.breaking, action.migration)) {
          rejected.push({
            index: step.originalIndex,
            packageId: action.packageId,
            objectName: action.objectName,
            items: gate.breaking.items,
          });
        }
      }
      // create 不进预检：createCalculationView 没有 migration 闸门（新对象没有可断的下游引用），
      // 它的失败（如对象已存在）照旧走执行期「停止 + 逆序补偿」。
    } catch (e) {
      logger.warn(
        { packageId: action.packageId, objectName: action.objectName, err: e },
        '变更集整体预检：本项破坏性判定未完成（不拦截，执行期闸门仍会判定）',
      );
    }
  }
  // 报告口径：按调用方原始下标升序（执行序只影响“什么时候判”）
  return rejected.sort((a, b) => a.index - b.index);
}

/**
 * 整批拒绝（破坏性未声明）的错误与机读载荷（SSD §6.1 第 1 步「任一被拦 ⇒ 整批拒绝、零写入」）。
 * - 消息只陈述事实（哪几项命中什么规则 + 由服务端在写入之前判定施加），**不给补救指引**（SSD §1.3）；
 * - rawDetail.breaking 逐项给 { index（原始下标）, packageId, objectName, items }（既有 BreakingItem）；
 * - rawDetail.notExecuted 与 ChangesetReport.notExecuted 同形同义（对 SSD §6.4 形状的扩展，不变量 2）：
 *   批被拒时**没有报告可返回**，未执行项若不在这里显式枚举，调用方只能靠差集推断。
 */
function changesetMigrationRequiredError(
  actions: ChangesetAction[],
  rejected: ChangesetRejectedAction[],
): HanaBusinessError {
  const summary = cappedSummary(
    rejected,
    (r) => `${r.packageId}/${r.objectName}（第 ${r.index} 项：${summarizeBreakingItems(r.items)}）`,
  );
  const rejectedIndexes = new Set(rejected.map((r) => r.index));
  return HanaBusinessError.withRawDetail(
    `变更集被拒绝（整批拒绝、零写入）：批内 ${rejected.length} 个动作的变更命中破坏性规则且未声明 migration——` +
      `${summary}。该限制由服务端在写入之前判定施加：本批 ${actions.length} 个动作一件都未执行，本次未发生任何写入。`,
    'migration_required',
    {
      breaking: rejected,
      // notExecuted 与另两条零写入拒绝路径同形（共用 changesetNotExecutedAll）：
      // 被拦的项多一句为什么（未被判为破坏的项不加，不制造恒为空噪音）
      notExecuted: changesetNotExecutedAll(actions, (i) =>
        rejectedIndexes.has(i) ? '该动作被整体预检判定为破坏性且未声明 migration（本批因此整批拒绝）' : undefined,
      ),
    },
  );
}

/**
 * update 动作 → updateCalculationView 的入参（二选一载荷）。**单一构造点**：预检的 dryRun 与执行期
 * 的写入必须喂同一份载荷，两处各写一次三元表达式的那天，预检判的和执行写的就可能不是同一件事。
 * 「有 xml」的谓词与形状校验（changesetPayloadShapeErrors）及 updateCalculationView 入口**同谓词**：
 * 空串不算有——若按 `!== undefined` 取 xml，xml:'' + 合法 operations 会被构造成 {xml:''}，
 * 执行期才以「需要提供 xml 或 operations」失败，报出的原因与调用方给的载荷正好相反。
 */
function changesetUpdatePayload(action: ChangesetAction): { xml?: string; operations?: ViewUpdateOperation[] } {
  return typeof action.xml === 'string' && action.xml.length > 0
    ? { xml: action.xml }
    : { operations: (action.operations ?? []) as ViewUpdateOperation[] };
}

/**
 * 第 2 步：执行批内一个动作——**复用既有服务函数**，不重写写路径：
 * create → createCalculationView；update → updateCalculationView；delete → deleteCalculationView。
 * 三者的 migration 闸门原样保留：动作带 migration 就透传；未声明且破坏 ⇒ 该项以 migration_required
 * 失败 ⇒ 进入补偿（期望行为——补偿侧再走低层路径绕开闸门，见 compensateChangesetItem）。
 *
 * 为什么**不在外面包 withKeyedLock**：withKeyedLock 不可重入，三个服务函数各自会取同一把对象锁
 * （create 的临界区 / update 的整段判定与 PUT / delete 的 deleteViaRest），批内先持锁再调用 = 自锁死。
 * 这就是 SSD §6.1「整批持有 keyed lock」在本仓不可实现的根因（完整裁定见本段落头注与
 * CHANGESET_LOCKING_NOTE）。
 */
async function executeChangesetAction(
  config: HanaConfig,
  pool: HanaPool,
  action: ChangesetAction,
  client?: XsRestClient,
): Promise<ChangesetActionOutcome> {
  switch (action.action) {
    case 'update': {
      // 写入前**紧贴本项**预读（不批前一次性预取）：原文 = 补偿材料；ETag = 本项自己的冲突检测基线
      // （SSD §6.1 第 2 步）——**不是**补偿基线：本项 PUT 会推进版本，拿写前基线补偿必得伪 412（§6.3）。
      const { rest, file } = designTimeTarget(config, action.objectName, client);
      const meta = await rest.fileMeta(action.packageId, file);
      const originalXml = await rest.fileContent(action.packageId, file);
      const preEtag = meta.ETag?.trim() || undefined;
      if (preEtag === undefined) {
        // 与 delete 分支同口径的「退化不静默」：预读未返回 ETag 时本次更新退回锁内自取基线，
        // 批外并发写入不再以 412 暴露——批报告没有承载它的字段，这条退化只能经日志可见。
        logger.warn(
          { packageId: action.packageId, objectName: action.objectName },
          '变更集 update 项预读未返回 ETag：本次更新退回锁内自取基线，批外并发写入不再以 412 暴露',
        );
      }
      const result = await updateCalculationView(
        config,
        pool,
        action.packageId,
        action.objectName,
        // 载荷构造与整体预检的 dryRun **同一处**（changesetUpdatePayload）：判的就是要写的
        changesetUpdatePayload(action),
        {
          // 显式传写前基线：预读之后、PUT 之前的批外写入以 412 暴露（该项 ⇒ conflict_external），
          // 而不是被 update 路径「锁内重取基线」悄悄吸收成 last-write-wins。
          ...(preEtag ? { ifMatch: preEtag } : {}),
          // 批内每项都要「各自完成（含激活）」：显式带 activate（本 SPS 写入即激活，跨 SPS 同一语义）
          activate: true,
          ...(action.migration
            ? { migration: action.migration as { strategy: MigrationDeclaration; note?: string } }
            : {}),
        },
        client,
      );
      if ('mode' in result) {
        // 防御：本路径不传 dryRun，拿到预演回执说明调用出错——宁可失败也不能当写入结果消费
        throw new HanaBusinessError('内部错误：变更集的更新项不应返回 dryRun 预演回执');
      }
      // 写成功但激活失败（HTTP 555，文件已写、激活未通过）**不算 ok**——SSD §6.1 第 3 步要求
      // 各项「各自完成（含激活）」。按 failed 抛出 ⇒ 停止 + 逆序补偿 + partial=true，绝不把未激活当成功。
      if (result.activated === false) {
        throw changesetActivationFailureError(
          '更新',
          action.packageId,
          action.objectName,
          result.activationErrors,
          result.activationDetail?.errorCode,
        );
      }
      const postEtag = result.etag?.trim() || undefined;
      return {
        originalXml,
        ...(postEtag ? { postEtag } : {}),
        etagSource: result.etagSource ?? 'unavailable',
        ...(result.activated !== undefined ? { activated: result.activated } : {}),
      };
    }
    case 'create': {
      // create 无原文可缓存（补偿=删除，见 §6.3），故不做预读；入参直接复用 hana_view_create 的形状。
      // source/scripted 用断言收窄：ChangesetAction 把它们声明成宽松形状（measureMode: string /
      // columns: unknown[]），枚举与列形状的最终校验在 createCalculationView 内做（同一处判定，不复制）。
      const result = await createCalculationView(
        config,
        pool,
        {
          packageId: action.packageId,
          objectName: action.objectName,
          ...(action.description !== undefined ? { description: action.description } : {}),
          ...(action.mode !== undefined ? { mode: action.mode } : {}),
          ...(action.source !== undefined ? { source: action.source as CreateCalcViewInput['source'] } : {}),
          ...(action.scripted !== undefined ? { scripted: action.scripted as CreateCalcViewInput['scripted'] } : {}),
          activate: true,
        },
        client,
      );
      // 与 update 分支同款——写成功但激活未通过（activated=false）按 failed 处理，
      // 不让「含激活」的承诺在 create 分支失效（新建对象未激活 = 该项没完成）。
      if (result.activated === false) {
        throw changesetActivationFailureError(
          '新建',
          action.packageId,
          action.objectName,
          result.activationErrors,
          result.activationDetail?.errorCode,
        );
      }
      const postEtag = result.etag?.trim() || undefined;
      return {
        ...(postEtag ? { postEtag } : {}),
        etagSource: result.etagSource ?? 'unavailable',
        ...(result.activated !== undefined ? { activated: result.activated } : {}),
        // 单对象通道的诚实面（warnings）随报告带出：批量通道静默丢弃「仅映射前 N 列」这类标注
        // 会让调用方按「全列」口径读回执——两通道口径必须一致（无警告不产生该字段）。
        ...(result.warnings !== undefined && result.warnings.length > 0 ? { warnings: result.warnings } : {}),
      };
    }
    case 'delete': {
      // 写入前紧贴本项预读：对象删除后设计时文件不再存在，原文是补偿（回写）的**唯一**材料。
      // 预读到的 ETag 有两个用途：
      //  ① **显式传给删除通道作 If-Match 基线**（deleteCalculationView 的 opts.ifMatch）——若丢弃它、
      //     由 deleteViaRest 在锁内重取基线：「预读 → 删除」之间若有第三方写入，锁内重取的**新**基线
      //     会让 DELETE 放行（无 412），随后补偿把预读原文写回 ⇒ 第三方的已提交版本被静默销毁、
      //     报告还写 compensated。显式传入后该窗口内的第三方写入必得 412 ⇒ 该项 conflict_external、
      //     对象不删、原文不回写，第三方版本零接触。
      //  ② **不是补偿基线**：删除后不存在可作补偿基线的 ETag，删除项的补偿材料始终是原文（§6.3）。
      // 预读未返回 ETag（服务器没给）时不传 ifMatch，退回锁内自取基线——这会让该项失去
      // 「预读 → 删除」窗口的 412 保护，故日志留痕（批报告没有承载它的字段；与 update 分支
      // 同一「退化不静默」原则，只是这条批内退化只能经日志可见）。
      const { rest, file } = designTimeTarget(config, action.objectName, client);
      const meta = await rest.fileMeta(action.packageId, file);
      const preEtag = meta.ETag?.trim() || undefined;
      if (preEtag === undefined) {
        logger.warn(
          { packageId: action.packageId, objectName: action.objectName },
          '变更集 delete 项预读未返回 ETag：本次删除退回锁内自取基线，批外并发写入不再以 412 暴露',
        );
      }
      const originalXml = await rest.fileContent(action.packageId, file);
      await deleteCalculationView(
        config,
        pool,
        action.packageId,
        action.objectName,
        {
          ...(preEtag ? { ifMatch: preEtag } : {}),
          ...(action.migration
            ? { migration: action.migration as { strategy: 'acknowledge_dependents'; note?: string } }
            : {}),
        },
        client,
      );
      // 删除后不存在可作补偿基线的 ETag（补偿是回写原文），故不回 postEtag/etagSource；
      // delete 没有激活概念，也不回 activated（不要在 delete 项上加 activated 字段）。
      return { originalXml };
    }
  }
}

/**
 * 写成功但激活失败的**统一构造点**（update/create 两个分支共用，两处各写一份文案必然漂移）。
 * 返回 ChangesetActivationError ⇒ applyChangeset 按 failed 记录该项，并带出 activated=false +
 * activationErrors 摘要。error.text 给摘要与 activationDetail 线索（完整激活明细含 DDL 不随变更集报告
 * 透出——报告项形状只有一行摘要字段；对单个对象复核该明细仍走单对象通道）。
 * `activationErrors` 收 unknown：update 回执是 string，create 回执声明成 unknown（历史上是透传槽）——
 * 归一（非空 string 才收）只在这一处做，两个分支共用。
 */
function changesetActivationFailureError(
  actionLabel: string,
  packageId: string,
  objectName: string,
  activationErrors: unknown,
  errorCode: string | undefined,
): ChangesetActivationError {
  const summary =
    typeof activationErrors === 'string' && activationErrors.length > 0
      ? activationErrors
      : '激活检查未通过（服务端未附明细）';
  return new ChangesetActivationError(
    `${actionLabel} ${packageId}/${objectName} 已写入设计时文件、但未通过激活（${summary}）：` +
      '该项按 failed 处理（SSD §6.1 第 3 步要求各项「各自完成（含激活）」，未激活不算完成）。' +
      '完整激活明细（含 Type/Procedure DDL）不随变更集报告透出，可对被拒对象调用 hana_view_validate 复核',
    typeof activationErrors === 'string' && activationErrors.length > 0 ? activationErrors : undefined,
    errorCode,
  );
}

/**
 * 第 3 步：逆序补偿一项（SSD §6.3）。**必须绕开 migration 闸门**：直接用低层写路径
 * （updateViaRest / 裸 deleteFile），不经 updateCalculationView / deleteCalculationView 的
 * 「diff → 影响半径 → 破坏性判定」。
 *
 * 理由（写死）：补偿是「回到批前状态」的内部动作，前进方向的破坏性**已由闸门判过**；若补偿再走一遍
 * 闸门，一个声明过的破坏性变更在回退时反而会被拒（migration_required），补偿永久失败——
 * 批将永远停在半完成态。
 *
 * 锁：低层路径 updateViaRest/deleteFile 自身不取锁 ⇒ 本函数在 withKeyedLock(writeLockKey(...)) 内调用；
 * 需要 fileMeta + deleteFile 的序列（create 补偿）把「校验 → 删除」放在**同一临界区**（中途放锁会留下
 * 「校验通过 → 他人改写 → 删掉他人版本」的窗口）。锁不可重入 ⇒ 这里不调用任何自取锁的路径
 * （deleteViaRest 属于这类，故只用它的两个原语自己组合）。
 */
async function compensateChangesetItem(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  try {
    return await runChangesetCompensation(config, record, client);
  } catch (e) {
    // 补偿自身的异常（412/网络/锁超时等）不向上抛：它必须变成 reporting 层可枚举的 compensation_failed，
    // 否则整个批的其余补偿会被一个异常中断、报告也丢掉现场。
    return {
      status: 'compensation_failed',
      error: changesetErrorOf(e),
      ...changesetConflictEvidence(e),
    };
  }
}

/** 补偿分派（错误交给 compensateChangesetItem 统一收口） */
async function runChangesetCompensation(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  switch (record.action.action) {
    case 'update':
      return compensateUpdateAction(config, record, client);
    case 'create':
      return compensateCreateAction(config, record, client);
    case 'delete':
      return compensateDeleteAction(config, record, client);
  }
}

/**
 * 补偿写回 PUT 的激活失败证据：updateViaRest 对 555（文件已写、激活未通过）按**非致命**返回，
 * 补偿若丢掉返回值直接判 written/restored，回执会把「设计时已回写、激活版本未回退」的不一致态
 * 谎报成「已回到批前状态」（前进方向 executeChangesetAction 已把 activated=false 判 failed，
 * 补偿侧必须同口径）。
 * @returns undefined = 写回未暴露激活问题；否则为激活明细（含 HTTP 状态/错误码/摘要）
 */
function compensationActivationFailure(
  meta: FileMeta & { CheckResult?: WriteCheckResult },
): ActivationDetail | undefined {
  const detail = activationDetailOf(meta);
  if (detail) return detail;
  // CheckResult 缺失时仍以原始 HTTP 状态兜底（writeFile 把真实状态写进 _httpStatus，555 = 激活失败）
  const httpStatus = typeof meta['_httpStatus'] === 'number' ? (meta['_httpStatus'] as number) : undefined;
  return httpStatus === 555 ? { httpStatus } : undefined;
}

/**
 * 补偿写回激活失败的统一文案（update/delete 两个补偿分支共用；两处各写一份文案必然漂移）。
 * 只陈述事实（哪一层回了、哪一层没回、可以做什么复核），不给「怎么绕过」的指引。
 */
function compensationNotActivatedError(
  packageId: string,
  objectName: string,
  detail: ActivationDetail,
): { code?: string; text: string } {
  const firstLine = (detail.message ?? '').split('\n')[0].trim();
  return {
    ...(detail.errorCode !== undefined ? { code: detail.errorCode } : {}),
    text:
      `补偿未完成（激活未通过）：${packageId}/${objectName} 的设计时原文已回写，` +
      `但本次写回的激活未通过（HTTP ${detail.httpStatus ?? 555}${detail.errorCode ? `，错误码 ${detail.errorCode}` : ''}）。` +
      '对象可能停在「设计时 = 批前内容、激活版本 ≠ 批前版本」的不一致态，未构成「已回到批前状态」；' +
      '可用 hana_view_validate 复核、hana_view_activate 重试激活' +
      (firstLine ? `。激活明细（首行）：${firstLine}` : ''),
  };
}

/** 补偿失败的结构化现场：探测读数里的 currentETag/currentVersion（取不到就不产生字段，不制造噪音） */
type CompensationEvidence = { currentETag?: string; currentVersion?: number };

/** 探测读数 → 冲突现场（三个补偿分支共用同一归一：ETag 去空白、空串不算基线；Version 原样） */
function conflictEvidenceOf(meta: FileMeta): CompensationEvidence {
  const currentETag = meta.ETag?.trim() || undefined;
  const currentVersion = meta.SapBackPack?.Version;
  return {
    ...(currentETag !== undefined ? { currentETag } : {}),
    ...(currentVersion !== undefined ? { currentVersion } : {}),
  };
}

/**
 * 补偿探测的共用件：fileMeta 读一次，**仅** 404（OBJECT_NOT_FOUND）视为「不存在」（返回 undefined）；
 * 其它错误（403/网络等）一律抛出——把读异常当成「不存在」会让补偿在故障中误判
 * （重建分支误写 / 误判「第三方已重建」），见各补偿函数的裁决语义。
 */
async function probeDesignTimeMeta(rest: XsRestClient, packageId: string, file: string): Promise<FileMeta | undefined> {
  try {
    return await rest.fileMeta(packageId, file);
  } catch (e) {
    if (isObjectNotFoundError(e)) return undefined;
    throw e;
  }
}

/** update 补偿的临界区裁决（锁内产出；各分支都不是错误，是如实结论） */
type UpdateCompensationVerdict =
  | { kind: 'written' }
  | { kind: 'precondition_failed'; evidence: CompensationEvidence }
  | { kind: 'written_not_activated'; detail: ActivationDetail };

/**
 * update 的补偿：用缓存的原文写回（SSD §6.3 首行）。
 * **写回之前先探测核对版本**（探测与写回同一临界区，check-then-act 闭合）：
 * - 对象已存在且当前 ETag === 本项写成功回执的基线 ⇒ 仍是我们的版本 ⇒ 带 If-Match=该基线写回
 *   （If-Match 继续兜住「探测 → PUT」之间的跨进程写入 ⇒ 412 ⇒ compensation_failed + 结构化现场）；
 * - 对象已存在但当前 ETag 不同（被第三方改过/重建；或当前读数没带 ETag，无法证明是我们的版本）⇒
 *   **不写** + compensation_failed + 当前读数——与「直接 PUT + If-Match 靠服务端 412 拦下」结论
 *   相同，但连一次被拒的写都不发起，第三方版本零接触；
 * - 对象已不存在（第三方在本项写成功后删了它）⇒ 允许回写（批前状态就是「对象存在」，用 PUT 重建）。
 *   这里**刻意不带 If-Match**：「PUT + If-Match 对已删除对象返回 412 还是**重新创建**」在本仓没有实测
 *   （只实测过 DELETE 的三态：204/412/404）——补偿不依赖这条未实测行为，先探测再决定；
 *   探测到不存在 ⇒ PUT 必为重建（PUT 是 create-or-update，实测语义），带不带 If-Match 都不改变结果。
 * 已知窗口（如实记录）：进程内锁挡不住跨进程在「探测 → PUT」之间写入；带 If-Match 的分支由服务端 412
 * 兜底，重建分支（对象不存在）本就没有可依的基线——与 §4.1 的既有边界同类。
 * 基线缺失（写回执没带 ETag）时**不做**无 If-Match 的覆盖写：那会静默覆盖第三方的改动（与 create/delete
 * 补偿同一条「不静默覆盖」原则），如实报 compensation_failed。
 * 写回结果必须消费：本次 PUT 若返回 555（文件已写、激活未通过），文件层虽已回写、激活版本并未
 * 回退——按 compensation_failed 回报（compensationNotActivatedError），不许静默落成 compensated。
 */
async function compensateUpdateAction(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  const { packageId, objectName } = record.action;
  const originalXml = record.originalXml;
  const postEtag = record.postEtag;
  if (originalXml === undefined) {
    return {
      status: 'compensation_failed',
      error: { text: '补偿材料缺失（写入前未读到原文），未执行写回' },
    };
  }
  if (postEtag === undefined) {
    return {
      status: 'compensation_failed',
      error: {
        text:
          '本项写成功回执未带 ETag（补偿基线不可用）：无法确认对象未被第三方改动，' +
          '按「不静默覆盖」原则未执行写回（无 If-Match 的写回会覆盖他人改动且无从察觉）',
      },
    };
  }
  const verdict = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<UpdateCompensationVerdict> => {
      const { rest, file } = designTimeTarget(config, objectName, client);
      const meta = await probeDesignTimeMeta(rest, packageId, file);
      if (meta === undefined) {
        // 重建分支：不带 If-Match 的 PUT（理由见函数头注——不依赖「PUT + If-Match 对已删除对象」的未实测行为）
        const restored = await updateViaRest(config, packageId, objectName, originalXml, { activate: true }, client);
        // 写回结果必须消费——555（文件已写、激活未通过）不许静默落成 written
        const activationFailure = compensationActivationFailure(restored);
        if (activationFailure) return { kind: 'written_not_activated', detail: activationFailure };
        return { kind: 'written' };
      }
      const evidence = conflictEvidenceOf(meta);
      if (evidence.currentETag !== postEtag) {
        // 已存在但非本项写成功后的版本（第三方改过/重建；或当前读数无 ETag，无法证明归属）：不写，
        // 把当前读数带出去（结构化现场，不许只落 error.text）——「查不到」与「不是我们的版本」在此同判
        return { kind: 'precondition_failed', evidence };
      }
      // 带 If-Match 的写回同样要消费返回值的激活结果——555 不许静默落成 written
      const restored = await updateViaRest(
        config,
        packageId,
        objectName,
        originalXml,
        { ifMatch: postEtag, activate: true },
        client,
      );
      const activationFailure = compensationActivationFailure(restored);
      if (activationFailure) return { kind: 'written_not_activated', detail: activationFailure };
      return { kind: 'written' };
    },
  );
  if (verdict.kind === 'precondition_failed') {
    return {
      status: 'compensation_failed',
      error: {
        text:
          `补偿未执行：对象 ${packageId}/${objectName} 的当前版本与本次更新成功后的基线不一致` +
          '（期间被第三方改过，或当前读数无法证明版本归属），按「不覆盖第三方改动」原则未执行写回',
      },
      ...verdict.evidence,
    };
  }
  if (verdict.kind === 'written_not_activated') {
    // 文件层已回写（设计时内容 = 批前原文），但激活未通过 ⇒ 不是「已回到批前状态」。
    // 缓存仍要失效：确实发生过一次写（设计时内容变了）。
    invalidateViewCache(packageId, objectName);
    return {
      status: 'compensation_failed',
      error: compensationNotActivatedError(packageId, objectName, verdict.detail),
    };
  }
  invalidateViewCache(packageId, objectName);
  return { status: 'compensated' };
}

/** create 补偿的临界区裁决（锁内产出；'absent' 与 'precondition_failed' 都不是错误，是如实结论） */
type CreateCompensationVerdict =
  { kind: 'deleted' } | { kind: 'absent' } | { kind: 'precondition_failed'; evidence: CompensationEvidence };

/**
 * create 的补偿：删除新建对象——前置 = **post-create ETag 仍为当前值**（SSD §6.3 第二行）。
 * 为什么必须有前置：无前置的删除可能删掉他人同名新建对象（PUT 是 create-or-update，服务端没有 409）。
 * 「校验 → 删除」同一临界区完成（拆两段会留下「校验通过 → 他人改写 → 删掉他人版本」的窗口）。
 * 对象已不存在（**仅 404** 视为不存在）：批前状态（该对象不存在）已成立 ⇒ compensated；
 * 其它错误（403/网络）如实抛出报失败——「查不到」与「确实没有」必须可区分（与 import 守卫同口径）。
 */
async function compensateCreateAction(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  const { packageId, objectName } = record.action;
  const postEtag = record.postEtag;
  if (postEtag === undefined) {
    return {
      status: 'compensation_failed',
      error: {
        text: '本项创建回执未带 ETag（前置不可校验）：无法证明对象仍是本次创建的那个，按「不删他人对象」原则未执行删除',
      },
    };
  }
  const verdict = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<CreateCompensationVerdict> => {
      const { rest, file } = designTimeTarget(config, objectName, client);
      const meta = await probeDesignTimeMeta(rest, packageId, file);
      if (meta === undefined) return { kind: 'absent' };
      const evidence = conflictEvidenceOf(meta);
      if (evidence.currentETag !== postEtag) {
        // 他人改过（或读不到基线）：**不删**，把当前读数带出去（结构化现场，不许只落在 error.text）
        return { kind: 'precondition_failed', evidence };
      }
      await rest.deleteFile(packageId, file, { ifMatch: postEtag });
      return { kind: 'deleted' };
    },
  );
  if (verdict.kind === 'precondition_failed') {
    return {
      status: 'compensation_failed',
      error: {
        text:
          `补偿未执行：对象 ${packageId}/${objectName} 的当前 ETag 与本次创建成功后的基线不一致` +
          '（期间被他人改过），按前置语义不删除——无前置的删除可能删掉他人同名新建对象',
      },
      ...verdict.evidence,
    };
  }
  // deleted 与 absent 都表示批前状态已成立（该对象不存在）：两者都失效一次缓存——
  // 「刚写过」的读数不该继续留在进程内缓存里（absent = 第三方删掉了它，缓存同样已过期）
  invalidateViewCache(packageId, objectName);
  return { status: 'compensated' };
}

/** delete 补偿的临界区裁决 */
type DeleteCompensationVerdict =
  | { kind: 'restored' }
  | { kind: 'exists'; evidence: CompensationEvidence }
  | { kind: 'written_not_activated'; detail: ActivationDetail };

/**
 * delete 的补偿：回写原文（SSD §6.3 末行）。
 * **先探测**：已存在（第三方重建同名对象）⇒ **不写** + compensation_failed——静默覆盖「第三方的重建」
 * 是不可接受的失败模式。探测**仅 404 视为不存在**，其它错误如实报（「查不到」与「确实没有」必须可区分）。
 * 探测到不存在才回写，且**刻意不带 If-Match**（与 update 补偿的重建分支同一理由）：
 * 对象已删除后没有可依的基线，而「PUT + If-Match 对已删除对象返回 412 还是**重新创建**」在本仓没有实测
 * （只实测过 DELETE 的三态：204/412/404）——补偿不依赖这条未实测行为，先探测再决定：不存在 ⇒ 裸 PUT
 * 重建（PUT 为 create-or-update，实测语义），确定且不再要求调用方去猜服务端行为。
 * 已知窗口（如实记录）：进程内锁挡不住跨进程在「探测 → PUT」之间重建；裸 PUT 无 If-Match 可依（没有
 * 可用的基线），跨进程真相在服务端——与 §4.1 的既有边界同类。
 * 回写结果必须消费：重建 PUT 若返回 555（文件已写、激活未通过）⇒ 批前状态（对象存在且激活）并未
 * 恢复，按 compensation_failed 回报，不许静默落成 restored。
 */
async function compensateDeleteAction(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  const { packageId, objectName } = record.action;
  const originalXml = record.originalXml;
  if (originalXml === undefined) {
    return {
      status: 'compensation_failed',
      error: { text: '补偿材料缺失（写入前未读到原文），未执行回写' },
    };
  }
  const verdict = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<DeleteCompensationVerdict> => {
      const { rest, file } = designTimeTarget(config, objectName, client);
      const meta = await probeDesignTimeMeta(rest, packageId, file);
      if (meta) {
        return { kind: 'exists', evidence: conflictEvidenceOf(meta) };
      }
      // 低层 PUT 回写原文（updateViaRest，不经 createCalculationView 的存在性守卫与闸门）：
      // 对象此刻不存在，PUT 即「重建到批前状态」
      const restored = await updateViaRest(config, packageId, objectName, originalXml, { activate: true }, client);
      // 重建同样要消费写回的激活结果——555 不许静默落成 restored
      const activationFailure = compensationActivationFailure(restored);
      if (activationFailure) return { kind: 'written_not_activated', detail: activationFailure };
      return { kind: 'restored' };
    },
  );
  if (verdict.kind === 'exists') {
    return {
      status: 'compensation_failed',
      error: {
        text:
          `补偿未执行：对象 ${packageId}/${objectName} 在本批删除之后已被（第三方）重建，` +
          '按 §6.3 不写回原文——静默覆盖他人的重建不可接受',
      },
      ...verdict.evidence,
    };
  }
  if (verdict.kind === 'written_not_activated') {
    // 原文已重建回文件层，但激活未通过 ⇒ 批前状态（对象存在且激活）并未恢复。
    // 缓存仍要失效：对象确实被重建过（设计时内容变了）。
    invalidateViewCache(packageId, objectName);
    return {
      status: 'compensation_failed',
      error: compensationNotActivatedError(packageId, objectName, verdict.detail),
    };
  }
  invalidateViewCache(packageId, objectName);
  return { status: 'compensated' };
}

/** 失败项的状态判定（SSD §6.4）：错误码 412（写冲突）⇒ conflict_external；其它 ⇒ failed */
function changesetFailureStatus(e: unknown): 'failed' | 'conflict_external' {
  return e instanceof HanaBusinessError && e.code === '412' ? 'conflict_external' : 'failed';
}

/** 错误 → 报告里的 error 形状（文本经 redactSensitive：本字段随**成功信封**的 data 出去，脱敏口径与失败信封一致） */
function changesetErrorOf(e: unknown): { code?: string; text: string } {
  const code = e instanceof HanaBusinessError ? e.code : undefined;
  const text = e instanceof Error ? e.message : String(e);
  return { ...(code !== undefined ? { code } : {}), text: redactSensitive(text) };
}

/**
 * 412/404 冲突载荷（core 层 412 后补读所得）→ 报告的结构化现场。
 * 拿不到就整体缺省（不产生 undefined 噪音）；**绝不**把「没补读到」伪造成某个值——
 * 「查不到」与「没去查」在本仓必须可区分（既有口径）。
 */
function changesetConflictEvidence(e: unknown): { currentETag?: string; currentVersion?: number } {
  const conflict = e instanceof HanaBusinessError ? e.conflict : undefined;
  return {
    ...(conflict?.currentETag !== undefined ? { currentETag: conflict.currentETag } : {}),
    ...(conflict?.currentVersion !== undefined ? { currentVersion: conflict.currentVersion } : {}),
  };
}
