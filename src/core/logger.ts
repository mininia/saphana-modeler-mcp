import { pino, type DestinationStream } from 'pino';
import { DEFAULT_TIMEZONE } from '../config/config.js';
import { toIsoInTimezone } from './datetime.js';

/**
 * 结构化日志（pino）。密码/Token/Authorization 一律脱敏：
 * - 结构化字段：redact 路径直接剔除
 * - 自由文本（如请求体）：经 redactSensitive 掩码
 * 输出到 stderr：MCP stdio transport 独占 stdout，日志不得混入协议通道。
 */

/** 敏感自由文本掩码规则（HANA 环境） */
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  [/(HANA_PASSWORD|PASSWORD|PASSWD|PWD)=([^&\s;]+)/gi, '$1=****'],
  [/(uid|user|username)\s*[:=]\s*([^,;\s]+)/gi, '$1: ****'],
  [/(Authorization|api[_-]?key|secret|token)\s*[:=]\s*[^&\r\n,;]*/gi, '$1: ****'],
  // 连接目标 IP（HANA 驱动连接错误消息格式，如 "Connection to '10.1.2.3:31041' failed"）：
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
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        paths: [
          // 凭据类字段（含嵌套，* 前缀通配任意层级）
          'password', '*.password',
          'pwd', '*.pwd',
          'passwd', '*.passwd',
          'secret', '*.secret',
          'token', '*.token',
          'apiKey', '*.apiKey',
          'client_secret', '*.client_secret',
          'authorization', '*.authorization',
          // 连接身份与目标（防内网拓扑/账号进日志）
          'HANA_PASSWORD',
          'uid', '*.uid',
          'username', '*.username',
          'serverNode', '*.serverNode',
          'host', '*.host',
          'databaseName', '*.databaseName',
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
      timestamp: () =>
        `,"time":"${toIsoInTimezone(new Date(), process.env.HANA_TIMEZONE ?? DEFAULT_TIMEZONE)}"`,
    },
    stream,
  );
}

/** 默认 logger（输出到 stderr） */
export const logger = createLogger();
