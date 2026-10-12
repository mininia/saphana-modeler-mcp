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
 * 兜底值非法（级别不在 pino 白名单 / 时区不被 Intl 接受）时退回默认值告警，
 * 不把模块求值变成崩溃点（见 createBootstrapLogger）。
 * loadConfig 成功后由入口调用 applyLoggerConfig 换成**已校验**的取值 —— 日志级别与
 * 时区因此与其余模块同源（config），不再各自直读 process.env 造成「判定值 ≠ 运行值」。
 */

const DEFAULT_LOG_LEVEL = 'info';

/** 生效中的日志配置：引导期为 env 兜底，配置就绪后被 applyLoggerConfig 覆盖 */
const runtime = {
  level: process.env.LOG_LEVEL ?? DEFAULT_LOG_LEVEL,
  timezone: process.env.HANA_TIMEZONE ?? DEFAULT_TIMEZONE,
};

/** 键值掩码替换函数签名：与 `RegExp#replace` 回调一致（三个捕获组之后是 offset 与原串） */
type SensitiveValueReplacer = (
  match: string,
  key: string,
  sep: string,
  value: string,
  offset: number,
  full: string,
) => string;

/**
 * 敏感自由文本掩码规则（HANA 环境）。
 *
 * 三组键值模式共用同一形状：`键名 + 分隔符（可选引号） + 值`，替换时只动值。
 * - 自由文本（`token=abc`）归一为固定形态的 `token: ****`；
 * - JSON 引号形态（`"token":"abc"` → `"token":"****"`）：只认 `键名[:=]值` 时，
 *   键名后面先跟的 `"` 会让整组失配——错误信封 / XS 响应体里的凭据会原样漏出；
 *   引号字节兼容裸 `"`（errors.ts 等直调点传入的未序列化原文）与转义 `\"`（streamWrite
 *   钩子看到的 pino **已序列化**整行——字符串内的引号恒被转义），替换按命中形态补同款引号，
 *   绝不补错形态（转义形态下补裸 `"` 会打破整行）；
 * - 行结构保护是**有限的**，不是伞形承诺：值段以转义对（`\` 与其后一字符）为最小单位、
 *   遇裸 `"` `}` 即停，且分隔符吞下的引号只有在「确为所在字符串的收尾引号、且值段为空」
 *   （空值收尾）时才整段原样放行；收尾引号后紧跟仍会落入值段的字符（如 `["x token: "]`
 *   的 `]`、`PASSWORD= ","` 的 `,`）时掩码会连收尾引号一起吃掉，产出采集器 / jq 会直接
 *   丢的破行日志——取舍是「宁丢行、不漏值」（被丢的恰是审计行）。转义形态不受此限：掩码
 *   只增删转义对与值内容、不动裸引号，已序列化整行的引号结构保持。
 */
const SENSITIVE_PATTERNS: Array<[RegExp, SensitiveValueReplacer]> = [
  [/(HANA_PASSWORD|PASSWORD|PASSWD|PWD)(\\?"?\s*[:=]\s*\\?"?)((?:[^&\s;"}\\]|\\.)+)/gi, sensitiveValueReplacer('=')],
  [/(uid|user|username)(\\?"?\s*[:=]\s*\\?"?)((?:[^,;\s"}\\]|\\.)+)/gi, sensitiveValueReplacer(': ')],
  [
    /(Authorization|api[_-]?key|secret|token)(\\?"?\s*[:=]\s*\\?"?)((?:[^&\r\n,;"}\\]|\\.)*)/gi,
    sensitiveValueReplacer(': '),
  ],
  // 连接目标 IP（HANA 驱动连接错误消息格式，如 "Connection to '192.0.2.10:30015' failed"）：
  // 掩码主机 IP，保留端口，防止内网拓扑进入日志/错误（不匹配 ISO 时间戳，避免误伤）
  [/\b((?:\d{1,3}\.){3}\d{1,3}):(\d{2,5})\b/g, (_match, _ip, port) => `****:${port}`],
];

/**
 * 生成键值掩码替换函数：保留键名与分隔符（含引号），只把值换成 ****。
 * - 无引号（自由文本）：输出归一为 `键名 + bareSep + ****`（如 `HANA_PASSWORD=****`、`token: ****`）；
 * - 带引号（JSON 位置）：引号原样保留；值本身不带引号（数字 / 布尔 / null）时补一对引号，
 *   否则会产出 `"token":****` 这种非法 JSON；补出的引号形态与命中的一致——裸 `"` 或转义 `\"`
 *   （streamWrite 钩子看到的是 pino 已序列化整行，补裸引号会打破整行）；
 * - 键带引号但值是 `{` / `[` 开头（对象 / 数组）：原样放行——本层只做标量掩码，强行替换会把
 *   整行打成非法 JSON（对象内容不是字符串掩码能安全吞掉的），而结构化凭据另有 pino redact 兜底。
 */
function sensitiveValueReplacer(bareSep: string): SensitiveValueReplacer {
  /** 在 full 前 end 个字符内，未转义的双引号数量是否为奇数（奇数 = 该位置处于字符串字面量内部） */
  const endsInsideString = (full: string, end: number): boolean => {
    let quotes = 0;
    let backslashes = 0;
    for (let i = 0; i < end && i < full.length; i++) {
      const ch = full[i];
      if (ch === '\\') {
        backslashes++;
        continue;
      }
      if (ch === '"' && backslashes % 2 === 0) quotes++;
      backslashes = 0;
    }
    return quotes % 2 === 1;
  };
  return (match, key, sep, value, offset, full) => {
    // 引号字节有两种形态：裸 `"`（未序列化原文）与转义 `\"`（pino 已序列化整行）。补出的引号
    // 必须同款：转义形态下补裸 `"` 会打断所在字符串、打破整行（见 SENSITIVE_PATTERNS 注释）。
    const escaped = sep.includes('\\"');
    const quote = escaped ? '\\"' : '"';
    if (!sep.includes('"')) return `${key}${bareSep}****`;
    if (sep.endsWith('"')) {
      // 空值收尾保护只针对裸形态：此时吞下的引号可能并不是值的开引号，而是所在字符串的收尾引号
      //（整行以 `token: "` 这类空值结尾时）：补 `****` 会落在字符串外、留下未闭合引号。按引号奇偶
      // 判定掩码结束位置是否仍在字符串内；不在且值为空（本就没有内容可掩）时原样放行，整行保持
      // 合法 JSON。转义形态下 `\"` 是内容引号、不会是字符串收尾，无需奇偶判定，空值也照掩。
      if (!escaped && value === '' && !endsInsideString(full, offset + match.length)) return match;
      // 转义形态下值段的收尾 `\"` 会作为转义对被吞进值里，原样补回，掩码结果仍是转义引号包着的值。
      if (escaped && value.endsWith('\\"')) return `${key}${sep}****${quote}`;
      return `${key}${sep}****`;
    }
    if (value.startsWith('{') || value.startsWith('[')) return match;
    return `${key}${sep}${quote}****${quote}`;
  };
}

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

/**
 * 引导期建 logger。
 *
 * LOG_LEVEL / HANA_TIMEZONE 此时**未经校验**，非法值会让 pino 在构造期就抛（级别白名单与
 * Intl 时区都在这一步求值），而本模块在 loadConfig **之前**就被 import——在模块求值期抛出，
 * 等于让配置层的中文校验文案（config.ts 的 level enum / timeZoneSchema）永远没有机会打印，
 * 用户只能看到驱动内部的英文报错。故失败时退回默认级别与时区并告警：值是否合法交给 loadConfig
 * 判定（它随后给出明确结论）。
 */
function createBootstrapLogger(): ReturnType<typeof createLogger> {
  try {
    return createLogger();
  } catch {
    const bad = { logLevel: runtime.level, timezone: runtime.timezone };
    runtime.level = DEFAULT_LOG_LEVEL;
    runtime.timezone = DEFAULT_TIMEZONE;
    const fallback = createLogger();
    fallback.warn(
      bad,
      'LOG_LEVEL / HANA_TIMEZONE 的引导期取值无法生效（日志级别或时区非法），已临时退回默认值；配置校验随后给出结论',
    );
    return fallback;
  }
}

/** 默认 logger（输出到 stderr） */
export const logger = createBootstrapLogger();

/**
 * 用**已校验**的配置覆盖引导期默认值（入口在 loadConfig 之后调用一次）。
 * 同时更新 runtime，使此后新建的 logger 实例（含测试注入目标流的那些）也用同一套配置。
 */
export function applyLoggerConfig(cfg: { level: string; timezone: string }): void {
  runtime.level = cfg.level;
  runtime.timezone = cfg.timezone;
  logger.level = cfg.level;
}
