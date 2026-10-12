import { normalizeHanaError } from './errors.js';

/**
 * HANA 错误码 → 成因语义的**单点判定**。
 *
 * 存在理由：同一批错误码（7/10/258/259/2950）在 health、preview、preview-diagnose 三处
 * 各有一套判定，且**码集互不相同** —— 结果是同一个错误在不同工具里被解释成不同原因
 * （例如 259 在健康检查里是"版本没这个视图"，在预览诊断里是对象不可见）。
 *
 * 本模块只回答"这个错误**是什么**"，不回答"**要不要**触发诊断/给什么建议"：
 * 后者是各调用点的策略，码集差异因此**显式参数化**暴露出来，而不是被合并成一个更大的集合
 * 悄悄改变某条链路的行为（详见下面对三个码集的说明）。
 *
 * detail 一律经 normalizeHanaError 归一（内含 redactSensitive），避免连接目标/账号
 * 随错误文本进入 evidence 与 metrics。
 */

/** 权限不足类错误码（语句被拒）。7=一般权限错误，258=insufficient privilege，2950=分析权限缺失 */
export const PERMISSION_DENIED_CODES: ReadonlySet<string> = new Set(['7', '258', '2950']);

/** 对象缺失类错误码。259=invalid table name（该版本/该 schema 没有这个对象，授予权限也读不到） */
export const OBJECT_MISSING_CODES: ReadonlySet<string> = new Set(['259']);

/**
 * 预览链路的权限码（实测口径，**不与上面合并**）：
 * XS/预览路径上出现过 code=10，而该路径下 258 由 shouldDiagnoseAccessError 单独处理。
 */
export const PREVIEW_PERMISSION_CODES: ReadonlySet<string> = new Set(['10', '2950']);

/**
 * 「对象对当前用户不可见」类错误码（258/259）。
 * _SYS_BIC 预览语境下常是"缺 SELECT → 运行时对象不可见"的伪装形态，故纳入自动诊断范围。
 */
export const INVISIBLE_OBJECT_CODES: ReadonlySet<string> = new Set(['258', '259']);

/** 权限类错误消息特征：驱动在某些场景不回错误码，只在消息里体现 */
const PERMISSION_MESSAGE_RE = /not authorized|insufficient privilege|无权限/i;

/** unknown 结论的成因（让调用方知道"为什么没结论"，以及补什么能解锁） */
export type UnknownReason =
  /** 该 HANA 版本没有这个视图（换环境也不会出现） */
  | 'view_missing'
  /** 权限不足（语句被拒 258） */
  | 'permission_denied'
  /** 权限不足导致视图静默返回空集（无报错，最危险的一类） */
  | 'filtered'
  /** 查询成功、但关键读数为 0/NULL 等不可用形态（数据形状问题，不是执行出错） */
  | 'read_unavailable'
  /** 功能未启用（如未配系统复制）——这是"确实没有"，不是"看不见" */
  | 'not_configured'
  /** 执行出错 */
  | 'error';

/** 取错误码（统一为字符串；无码返回空串） */
export function hanaErrorCode(e: unknown): string {
  const code = normalizeHanaError(e).code;
  return code ? String(code) : '';
}

/** 错误消息（已脱敏，可直接进 evidence / metrics） */
export function hanaErrorMessage(e: unknown): string {
  return normalizeHanaError(e).message;
}

/** 消息是否体现权限不足（驱动未回错误码时的兜底判定） */
export function isPermissionDeniedMessage(message: string): boolean {
  return PERMISSION_MESSAGE_RE.test(message);
}

/**
 * 是否为权限类错误。
 * @param codes 判定用的码集，默认 PERMISSION_DENIED_CODES；预览链路传 PREVIEW_PERMISSION_CODES
 */
export function isPermissionError(e: unknown, codes: ReadonlySet<string> = PERMISSION_DENIED_CODES): boolean {
  const normalized = normalizeHanaError(e);
  if (normalized.code && codes.has(String(normalized.code))) return true;
  return isPermissionDeniedMessage(normalized.message);
}

/**
 * 是否应自动触发权限诊断：权限类错误 + 对象不可见类错误码。
 * 后者是"缺 SELECT → 运行时对象不可见"的常见伪装形态，纳入诊断避免漏掉这类隐蔽根因。
 */
export function shouldDiagnoseAccessError(e: unknown): boolean {
  if (isPermissionError(e, PREVIEW_PERMISSION_CODES)) return true;
  const code = hanaErrorCode(e);
  return code !== '' && INVISIBLE_OBJECT_CODES.has(code);
}

/**
 * HANA 错误码 → unknown 结论的成因。
 * 语义（保持既有口径不变）：259=该版本没有这个视图；258/7=权限被拒；其余=执行出错。
 */
export function classifyHanaError(e: unknown): { reason: UnknownReason; detail: string } {
  const normalized = normalizeHanaError(e);
  const code = normalized.code ? String(normalized.code) : '';
  const detail = normalized.message;
  if (code !== '' && OBJECT_MISSING_CODES.has(code)) return { reason: 'view_missing', detail };
  if (code !== '' && PERMISSION_DENIED_CODES.has(code)) return { reason: 'permission_denied', detail };
  return { reason: 'error', detail };
}
