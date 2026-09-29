import { pino, type DestinationStream } from 'pino';
import { DEFAULT_TIMEZONE, toIsoInTimezone } from './datetime.js';

/**
 * 结构化日志（pino）。密码/Token/Authorization 一律脱敏：
 * - 结构化字段：redact 路径直接剔除
 * - 自由文本（如请求体）：经 redactSensitive 掩码
 * 输出到 stderr：MCP stdio transport 独占 stdout，日志不得混入协议通道。
 *
 * 配置来源：本模块必须在 loadConfig **之前**就可用（配置校验失败时也要能报错，
 * 且启动期告警早于配置就绪），故创建时先用**未经校验**的进程环境变量兜底。
 * loadConfig 成功后由入口调用 applyLoggerConfig 换成**已校验**的取值 —— 日志级别与
 * 时区因此与其余模块同源（config），不再各自直读 process.env 造成「判定值 ≠ 运行值」。
 */

const DEFAULT_LOG_LEVEL = 'info';

/** 生效中的日志配置：引导期为 env 兜底，配置就绪后被 applyLoggerConfig 覆盖 */
const runtime = {
  level: process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  timezone: process.env.HANA_TIMEZONE ?? DEFAULT_TIMEZONE,
};

/** 敏感自由文本掩码规则（HANA 环境） */
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/(HANA_PASSWORD|PASSWORD|PASSWD|PWD)=([^&\s;]+)/gi, '$1=****'],
  [/(uid|user|username)\s*[:=]\s*([^,;\s]+)/gi, '$1: ****'],
  [/(Authorization|api[_-]?key|secret|token)\s*[:=]\s*[^&\r\n,;]*/gi, '$1: ****'],
  // 连接目标 IP（HANA 驱动连接错误消息格式，如 "Connection to '192.0.2.10:30015' failed"）：
  // 掩码主机 IP，保留端口，防止内网拓扑进入日志/错误（不匹配 ISO 时间戳，避免误伤）
  [/\b((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/g, '****:$2'],
];

/** 对日志/错误中的自由文本做敏感信息掩码（纯函数，可单测） */
export function redactSensitive(text: string): string {
  let out = text;
  for (const [re, repl] of SENSITIVE_PATTERNS) {
    out = out.replace(re, repl);
  }
  return out;
}

/** 创建 logger（可注入目标流，便于测试捕获） */
export function createLogger(stream: DestinationStream = process.stderr) {
  return pino(
    {
      level: runtime.level,
      redact: {
        paths: [
          // 凭据类字段（含嵌套，* 前缀通配任意层级）
          'password',
          '*.password',
          'pwd',
          '*.pwd',
          'passwd',
          '*.passwd',
          'secret',
          '*.secret',
          'token',
          '*.token',
          'apiKey',
          '*.apiKey',
          'client_secret',
          '*.client_secret',
          'authorization',
          '*.authorization',
          // 连接身份与目标（防内网拓扑/账号进日志）
          'HANA_PASSWORD',
          'uid',
          '*.uid',
          'username',
          '*.username',
          'serverNode',
          '*.serverNode',
          'host',
          '*.host',
          'databaseName',
          '*.databaseName',
        ],
        censor: '****',
      },
      // 错误对象序列化：只保留 type/message/code，剥离完整 stack（含绝对路径），message 过自由文本掩码
      serializers: {
        err: (e: unknown) => {
          const err = (e ?? {}) as { type?: string; message?: string; code?: string };
          return {
            type: err.type ?? 'Error',
            message: redactSensitive(String(err.message ?? '')),
            ...(err.code !== undefined ? { code: err.code } : {}),
          };
        },
      },
      // 输出层统一接线自由文本掩码：结构化 redact 覆盖不到的自由文本（如错误消息内嵌 host:port）在此兜底
      hooks: {
        streamWrite: (s: string) => redactSensitive(s),
      },
      base: undefined,
      // 时间戳按配置时区（默认上海）格式化；pino 内置 isoTime 恒为 UTC，不能体现时区配置
      timestamp: () => `,"time":"${toIsoInTimezone(new Date(), runtime.timezone)}"`,
    },
    stream,
  );
}

/** 默认 logger（输出到 stderr） */
export const logger = createLogger();

/**
 * 用**已校验**的配置覆盖引导期默认值（入口在 loadConfig 之后调用一次）。
 * 同时更新 runtime，使此后新建的 logger 实例（含测试注入目标流的那些）也用同一套配置。
 */
export function applyLoggerConfig(cfg: { level: string; timezone: string }): void {
  runtime.level = cfg.level;
  runtime.timezone = cfg.timezone;
  logger.level = cfg.level;
}
