/**
 * 默认时区（IANA 名称）。
 *
 * 定义在本模块而非 config：core 层不得反向依赖 config（config 会 import core），
 * 且 logger 在配置加载之前就要能输出带时区的时间戳。
 * 配置侧（config.ts 的 HANA_TIMEZONE 默认值）与日志侧共用这一个常量，避免两处默认值漂移。
 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** ISO 时间字符串：显式按给定 IANA 时区格式化（默认上海） */
export function toIsoInTimezone(date: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes): string => parts.find((p) => p.type === type)?.value ?? '00';

  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * HANA DATETIME 字面量（`'YYYY-MM-DD HH:MM:SS'`，无毫秒）：写库时间与日志**同一时区口径**。
 *
 * 存在理由：写库侧曾用 `new Date().toISOString().slice(0, 19).replace('T', ' ')`（UTC 口径），
 * 日志侧用 toIsoInTimezone（配置时区）—— 同一进程写出两个相差数小时的"现在"，
 * 事后比对「写入时间 vs 日志时间」永远对不上。两处统一走本函数。
 */
export function toHanaDateTime(date: Date, timezone: string = DEFAULT_TIMEZONE): string {
  return toIsoInTimezone(date, timezone).replace('T', ' ');
}

/**
 * 给定时刻的**进程时区** ISO 串（秒级）：时区口径与日志一致（`process.env.TZ`，由 loadConfig
 * 统一设置；未设置时回落默认时区）。
 *
 * 单点存在理由：读数新鲜度（asOf）、报告时刻（checkedAt）等若各自拼一遍
 * `process.env.TZ ?? DEFAULT_TIMEZONE`，任何时区回退策略的调整都会让同一进程里的两个"现在"静默分叉。
 */
export function toIsoInProcessTz(date: Date = new Date()): string {
  return toIsoInTimezone(date, process.env.TZ ?? DEFAULT_TIMEZONE);
}

/**
 * 「现在」的进程时区 ISO 串（秒级）：读数新鲜度（asOf）等场景的默认入口。
 * 需要固定时刻（测试）时走 toIsoInProcessTz，本函数恒取当前时刻。
 */
export function nowIso(): string {
  return toIsoInProcessTz(new Date());
}
