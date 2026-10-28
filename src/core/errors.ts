import { ProtocolError, SdkError, SdkErrorCode } from '@modelcontextprotocol/server';
import type { Envelope, HanaMessage } from '../types/hana.js';
import { isEmptyResultMarked, liftResultInfo } from './result-info.js';
import { logger, redactSensitive } from './logger.js';
import { currentAgentLabel, currentClientId } from './request-context.js';

/**
 * 乐观锁冲突（412）/ 目标缺失（404）的机读载荷，经 withErrorEnvelope 进 envelope.raw.conflict。
 *
 * 关于 currentETag：它是**冲突时点的补读值**（捕获 412 后立刻再读一次 fileMeta），
 * **不是**本次写的新基线——实测 412 响应不带 ETag 头，只能补读；
 * 这一次额外往返不可省，且补读结果不许被当成"最新基线"回写或重试。
 * 补读本身失败（如对象已被并发删除）时原因写进 currentUnavailable——
 * 不许把补读失败静默成 undefined（"查不到"与"没去查"必须可区分）。
 */
export interface ConflictInfo {
  /** 原始 HTTP 状态：412 或 404 */
  httpStatus: number;
  /** 调用方提交的基线（If-Match），用于自我诊断 */
  providedEtag?: string;
  /** 冲突时点补读 fileMeta 所得的当前 ETag（不是本次写的新基线！） */
  currentETag?: string;
  /** 冲突时点的 SapBackPack.Version */
  currentVersion?: number;
  /** 冲突时点的 SapBackPack.ActivatedAt */
  activatedAt?: number;
  /** 补读失败时的原因（如对象已被删除）——不许把补读失败静默成 undefined */
  currentUnavailable?: string;
}

/**
 * HANA 业务错误：驱动/SQL 层错误归一化载体（对齐既有 BW 建模服务错误对象的 code/sqlState/messages 三元组形状）。
 * - code：HANA/SAP 错误码（如 '7'=权限不足、'259'=对象不存在、'-10709'=连接失败）
 * - sqlState：SQLSTATE
 * - messages：可选的结构化消息列表（激活错误明细等）
 * - diagnosis：可选的排障报告（如数据预览权限诊断），经 withErrorEnvelope 进 envelope.raw.diagnosis
 */
export class HanaBusinessError extends Error {
  /**
   * 冲突载荷：412/404 的机读形状，经 withErrorEnvelope 进 envelope.raw.conflict。
   * 非 readonly（可写）：由 withConflict 工厂在构造后赋值，构造器保持原签名不变。
   */
  conflict?: ConflictInfo;

  constructor(
    message: string,
    public readonly code?: string,
    public readonly sqlState?: string,
    public readonly messages: HanaMessage[] = [],
    /** 排障报告（如预览权限诊断）；由失败路径自动附加，envelope.raw.diagnosis 透传给调用方 */
    public readonly diagnosis?: unknown,
    /**
     * 服务端原始错误载荷（如 XS 写失败的 CheckResult + 响应体）。
     * 与 diagnosis 同为「失败后无需二次调用即可定位」的附加信息，envelope.raw.errorDetail 透传。
     */
    public readonly rawDetail?: unknown,
  ) {
    super(message);
    this.name = 'HanaBusinessError';
  }

  /**
   * 便捷构造：只带「服务端原始错误载荷」（→ envelope.raw.errorDetail）。
   *
   * 位置参数构造器有 6 个槽，而这条失败路径（如 XS 激活失败）实际只有 message/code/rawDetail
   * 三个有值 —— 直接调用会写成 `new HanaBusinessError(msg, code, undefined, [], undefined, detail)`，
   * 占位噪声把「到底带了什么」淹没。本工厂只暴露有值的字段，构造器签名保持不变。
   */
  static withRawDetail(message: string, code: string | undefined, rawDetail: unknown): HanaBusinessError {
    return new HanaBusinessError(message, code, undefined, [], undefined, rawDetail);
  }

  /**
   * 便捷构造：只带「冲突载荷」（→ envelope.raw.conflict）。
   *
   * 冲突错误实际只有 message/code/conflict 三个有值，其余槽位（sqlState/messages/diagnosis/rawDetail）
   * 与本场景无关——与 withRawDetail 同理，只暴露有值的字段，避免 `undefined, []` 占位噪声。
   * code 收敛为两个机读值（412=乐观锁冲突、OBJECT_NOT_FOUND=对象不存在），工具层按码分流。
   */
  static withConflict(message: string, code: '412' | 'OBJECT_NOT_FOUND', conflict: ConflictInfo): HanaBusinessError {
    const err = new HanaBusinessError(message, code);
    err.conflict = conflict;
    return err;
  }
}

/** 归一化任意驱动回调错误 → HanaBusinessError（message 经脱敏，防止连接目标/账号进错误返回） */
export function normalizeHanaError(e: unknown): HanaBusinessError {
  if (e instanceof HanaBusinessError) return e;
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const { code, message, sqlState } = e as { code?: string; message?: string; sqlState?: string };
    return new HanaBusinessError(
      redactSensitive(String(message ?? 'HANA 未知错误')),
      code ? String(code) : undefined,
      sqlState,
    );
  }
  const message = e instanceof Error ? e.message : String(e);
  return new HanaBusinessError(redactSensitive(message));
}

/**
 * 归一化任意未知异常为 SdkError（对外只给通用文案，细节留在服务端日志；
 * 调用方在抛出前已用 logger 记录原始错误）。
 */
export function wrapUnknownError(_e: unknown): SdkError {
  return new SdkError(SdkErrorCode.InvalidResult, '内部错误，详情见服务端日志');
}

/**
 * tool handler 统一错误归一化（双通道约定）：
 * - HANA 业务错误（HanaBusinessError）→ 信封 success:false + messages
 * - v2 MCP 错误（ProtocolError/SdkError）→ 透传抛出（协议层处理）
 * - 未知错误 → 包装为 SdkError 抛出
 * 信封统一附带当前客户端身份（HTTP 模式；stdio 无身份上下文则不带该字段）。
 */
export async function withErrorEnvelope<T>(fn: () => Promise<T>): Promise<Envelope> {
  // 身份/归因在请求上下文中读取（工具 handler 运行在 HTTP 请求的 AsyncLocalStorage 上下文内；
  // agentLabel 是进程级的，stdio 下同样有值）
  const clientId = currentClientId();
  const agentLabel = currentAgentLabel();
  const withIdentity = (e: Envelope): Envelope => ({
    ...e,
    ...(clientId ? { clientId } : {}),
    ...(agentLabel ? { agentLabel } : {}),
  });
  try {
    const data = await fn();
    // P0-1 / P0-2 的唯一提升点：服务层把 resultInfo 挂在 data 上（见 core/result-info.ts），
    // 信封在这里把它搬到顶层并从 data 摘掉——所有工具共用同一段逻辑，handler 不各自拼字段。
    const lifted = liftResultInfo(data);
    // 空集：有 resultInfo 时以 returnedCount=0 且 **未被截断** 为准（0 条 + 扫描上限截断 = 没看完，
    // 不是空集）；没有 limit 语义的列表用 Symbol 标记（不撞业务字段）。
    const empty =
      lifted.info !== undefined ? lifted.info.returnedCount === 0 && !lifted.info.truncated : isEmptyResultMarked(data);
    // 固定安全上限（如计划回读硬顶）除 resultInfo.truncationReason 外再给一条稳定码，
    // 让只读 messages 的调用方也能发现"结论基于不完整数据"。
    const safetyCapHit = lifted.info?.truncationReason === 'safety-cap';
    const messages: HanaMessage[] = [
      ...(empty
        ? [{ type: 'I' as const, id: 'EMPTY_RESULT', text: '未匹配到任何结果（空集是合法结果，不是错误）。' }]
        : []),
      ...(safetyCapHit
        ? [{ type: 'W' as const, id: 'SAFETY_CAP_EXCEEDED', text: '结果触达固定安全上限，已截断（详见 resultInfo）。' }]
        : []),
    ];
    return withIdentity({
      success: true,
      ...(lifted.info !== undefined ? { resultInfo: lifted.info } : {}),
      ...(empty ? { empty: true as const } : {}),
      data: lifted.data,
      messages,
    });
  } catch (e) {
    if (e instanceof HanaBusinessError) {
      const raw = e.code ? { code: e.code } : undefined;
      // 排障报告（如预览权限诊断）与服务端原始错误载荷（如 XS CheckResult）随错误透传给调用方，
      // 便于失败后一次定位阻塞点——避免"失败 → 再调一次校验才看到 DDL 全文"的固定 +1 轮。
      const extra = {
        ...(e.diagnosis != null ? { diagnosis: e.diagnosis } : {}),
        ...(e.rawDetail != null ? { errorDetail: e.rawDetail } : {}),
        // 冲突载荷（412/404 的机读形状）与 code 同一层显式并入——不许落在 errorDetail 里反推
        ...(e.conflict ? { conflict: e.conflict } : {}),
      };
      const rawWithDiagnosis = Object.keys(extra).length > 0 ? { ...(raw ?? {}), ...extra } : raw;
      return withIdentity({
        success: false,
        messages:
          e.messages.length > 0
            ? e.messages.map((m) => ({ ...m, text: redactSensitive(m.text) }))
            : [{ type: 'E', id: e.code, number: e.sqlState, text: redactSensitive(e.message) }],
        raw: rawWithDiagnosis,
      });
    }
    if (e instanceof ProtocolError || e instanceof SdkError) {
      throw e;
    }
    logger.error({ err: e }, '工具调用发生未知错误');
    throw wrapUnknownError(e);
  }
}

/**
 * 从失败信封读取冲突码（工具层与测试共用的**唯一**读取实现）。
 *
 * 业务失败信封里只有 raw.code 是机读码；conflict 是失败信封中与 code 同层的**显式字段**
 * （withErrorEnvelope 只产出 raw.code / diagnosis / errorDetail / conflict 这一层，
 * 不会从 errorDetail 里反推）——故这里直接读 raw.code / raw.conflict，不做散文匹配。
 * 语义：success !== false → undefined；raw.code 不是 '412'/'OBJECT_NOT_FOUND' → undefined；
 * 命中 → { code, conflict }（raw.conflict 缺失/形状不对时只回 code，调用方仍可按码分流）。
 */
export function conflictOf(
  envelope: Envelope,
): { code: '412' | 'OBJECT_NOT_FOUND'; conflict?: ConflictInfo } | undefined {
  if (envelope.success !== false) return undefined;
  const raw = asRecord(envelope.raw);
  if (!raw) return undefined;
  const code = raw['code'];
  if (code !== '412' && code !== 'OBJECT_NOT_FOUND') return undefined;
  const conflict = raw['conflict'];
  return isConflictInfo(conflict) ? { code, conflict } : { code };
}

/** Envelope.raw 是 unknown：读出对象视图（局部小工具，仅本文件使用；数组同样以对象处理，字段读不到即自然落空） */
function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' ? (v as Record<string, unknown>) : undefined;
}

/** ConflictInfo 的最小形状校验（httpStatus 必须是数字）：raw 是透传数据，不信任其形状 */
function isConflictInfo(v: unknown): v is ConflictInfo {
  const rec = asRecord(v);
  return rec !== undefined && typeof rec['httpStatus'] === 'number';
}

/**
 * 硬错误返回：参数非法 / 对象不存在等不可恢复错误，返回 MCP isError
 * 并附恢复提示（把死胡同变成下一步）。工具 handler 直接 return 此对象。
 */
export function mcpErrorText(
  message: string,
  hint?: string,
): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  const text = hint ? `${message}。${hint}` : message;
  return { isError: true, content: [{ type: 'text', text }] };
}

/**
 * 请求被策略拦截时的统一前缀（对外形状契约：客户端与冒烟脚本按该文本断言）。
 *
 * 拦截消息是**返回给调用方（通常是模型）**的，它需要一眼看出「这是服务端策略拦截，
 * 不是我的参数写错了」，从而停下并交由人决策。
 * 三个使用方（config/authorize.ts、config/preflight.ts、services/repository.service.ts）
 * 都从这里取——services → config/preflight 会经能力清单成环，故定义放在叶子层。
 *
 * 同样重要的一点：这些消息**不得**包含"改哪一项配置即可放行"之类的补救指引——
 * 那等于把绕过方法直接交给被拦的一方。补救指引只应出现在面向运维的位置
 * （服务启动自检、README），不出现在请求响应里。
 */
export const BLOCKED_PREFIX = '被 MCP 安全策略拦截';
