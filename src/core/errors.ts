import { ProtocolError, SdkError, SdkErrorCode, SdkHttpError } from '@modelcontextprotocol/server';
import type { Envelope, HanaMessage } from '../types/hana.js';
import { logger, redactSensitive } from './logger.js';

export { ProtocolError, SdkError, SdkErrorCode, SdkHttpError };

/**
 * HANA 业务错误：驱动/SQL 层错误归一化载体（对齐 bw7.5 的 SapBusinessError）。
 * - code：HANA/SAP 错误码（如 '7'=权限不足、'259'=对象不存在、'-10709'=连接失败）
 * - sqlState：SQLSTATE
 * - messages：可选的结构化消息列表（激活错误明细等）
 * - diagnosis：可选的排障报告（如数据预览权限诊断），经 withErrorEnvelope 进 envelope.raw.diagnosis
 */
export class HanaBusinessError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly sqlState?: string,
    public readonly messages: HanaMessage[] = [],
    /** 排障报告（如预览权限诊断）；由失败路径自动附加，envelope.raw.diagnosis 透传给调用方 */
    public readonly diagnosis?: unknown,
  ) {
    super(message);
    this.name = 'HanaBusinessError';
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
 * tool handler 统一错误归一化（§5.3 双通道约定）：
 * - HANA 业务错误（HanaBusinessError）→ 信封 success:false + messages
 * - v2 MCP 错误（ProtocolError/SdkError）→ 透传抛出（协议层处理）
 * - 未知错误 → 包装为 SdkError 抛出
 */
export async function withErrorEnvelope<T>(fn: () => Promise<T>): Promise<Envelope> {
  try {
    const data = await fn();
    return { success: true, data, messages: [] };
  } catch (e) {
    if (e instanceof HanaBusinessError) {
      const raw = e.code ? { code: e.code } : undefined;
      // 排障报告（如预览权限诊断）随错误透传给调用方，便于失败后定位阻塞点
      const rawWithDiagnosis = e.diagnosis != null ? { ...(raw ?? {}), diagnosis: e.diagnosis } : raw;
      return {
        success: false,
        messages:
          e.messages.length > 0
            ? e.messages.map((m) => ({ ...m, text: redactSensitive(m.text) }))
            : [{ type: 'E', id: e.code, number: e.sqlState, text: redactSensitive(e.message) }],
        raw: rawWithDiagnosis,
      };
    }
    if (e instanceof ProtocolError || e instanceof SdkError) {
      throw e;
    }
    logger.error({ err: e }, '工具调用发生未知错误');
    throw wrapUnknownError(e);
  }
}

/**
 * 硬错误返回（§5.3）：参数非法 / 对象不存在等不可恢复错误，返回 MCP isError
 * 并附恢复提示（把死胡同变成下一步）。工具 handler 直接 return 此对象。
 */
export function mcpErrorText(message: string, hint?: string): {
  isError: true;
  content: [{ type: 'text'; text: string }];
} {
  const text = hint ? `${message}。${hint}` : message;
  return { isError: true, content: [{ type: 'text', text }] };
}
