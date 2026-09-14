import { fileURLToPath } from 'node:url';
import { z } from 'zod';

/** 默认时区（IANA 名称），默认上海；可在 mcp.json env / .env 用 HANA_TIMEZONE 覆盖 */
export const DEFAULT_TIMEZONE = 'Asia/Shanghai';

/** 默认 Locale，与 HANA Studio 登录页默认值一致 */
export const DEFAULT_LOCALE = 'zh_CN';

/**
 * 布尔环境变量解析：'true'/'1'/'TRUE' → true，其余 → false。
 * 避免 z.coerce.boolean() 把字符串 'false' 强转为 true 的经典坑。
 * @param defaultValue 未配置时的默认值（fail-closed：安全相关开关默认 true）
 */
const boolSchema = (defaultValue: 'true' | 'false') =>
  z
    .enum(['true', 'false', '1', '0', 'TRUE', 'FALSE'])
    .default(defaultValue)
    .transform((v) => v === 'true' || v === '1' || v === 'TRUE');

/** 时区校验：必须是合法 IANA 名称（如 Asia/Shanghai、UTC），非法值在配置加载时即报错 */
const timeZoneSchema = z
  .string()
  .min(1)
  .default(DEFAULT_TIMEZONE)
  .refine((tz) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return true;
    } catch {
      return false;
    }
  }, '非法 IANA 时区名称（如 Asia/Shanghai、UTC）');

/** 实例号校验（00-99） */
const instanceSchema = z
  .string()
  .regex(/^[0-9]{2}$/, '实例号必须是两位数字（00-99）')
  .default('00');

const envSchema = z.object({
  // 安全要求：连接信息（主机/端口/库名/用户名/密码）一律只允许来自环境变量 / mcp.json，
  // 禁止默认值或硬编码真实环境值
  HANA_HOST: z.string().min(1),
  HANA_INSTANCE: instanceSchema,
  /** SQL 端口（可选）。若留空，按实例号自动推导：3<instance>13/15 */
  HANA_PORT: z.string().optional(),
  HANA_USER: z.string().min(1),
  HANA_PASSWORD: z.string().min(1),
  /** 连接 Locale（默认 zh_CN），影响服务器端语言/错误消息 */
  HANA_LOCALE: z.string().min(1).default(DEFAULT_LOCALE),
  /** 租户数据库名（MDC 环境必填，如 SYSTEMDB / 业务租户名） */
  HANA_DB_NAME: z.string().min(1).optional(),
  /**
   * 是否启用 TLS 加密连接。默认 true（fail-closed：未显式配置时不允许明文传输凭据/数据）。
   * 仅当确认网络链路可信（如 localhost）且需兼容自签证书时才显式置 false。
   */
  HANA_TLS: boolSchema('true'),
  /**
   * TLS 下是否校验服务器证书。默认 true（防止中间人替换证书窃取认证与数据）。
   * 内网自签证书环境需跳过校验时显式置 false（应与 HANA_TLS=false 权衡，避免加密但不认证）。
   */
  HANA_SSL_VALIDATE: boolSchema('true'),
  HANA_TIMEZONE: timeZoneSchema,
  /**
   * 启用的工具功能分组（逗号分隔：read/write/admin）。
   * 空/未填 = 不限制（全部分组启用，向后兼容默认）。
   * 例：HANA_TOOL_GROUPS="read" → 仅暴露数据读取，关闭全部写工具（含校验）。
   * 合法值校验在 src/tools/groups.ts 的 parseToolFilter 完成（启动即失败）。
   */
  HANA_TOOL_GROUPS: z.string().default('').transform((s) => s.trim()),
  /**
   * 强制启用的工具名 glob（逗号分隔，支持 * 通配；即便其分组未启用也注册）。
   * 用于在分组开关之外单独放行个别工具。例：HANA_TOOL_ALLOW="hana_some_tool"
   */
  HANA_TOOL_ALLOW: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * 强制禁用的工具名 glob（逗号分隔，支持 * 通配；优先级最高，覆盖 allow 与分组）。
   * 例：HANA_TOOL_DENY="hana_data_preview_*" 关闭所有预览工具。
   */
  HANA_TOOL_DENY: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  /** 额外允许的 SQL 查询 schema（逗号分隔，追加到 core/sql.ts 白名单；默认仅系统 schema） */
  HANA_SCHEMA_ALLOW: z.string().default('').transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * 允许写操作的仓库包（逗号分隔的包前缀；含子包）。
   * 空/未填 = 不限制（所有包均可写）；填写后仅允许指定包及其下级子包写操作。
   * 例：HANA_WRITE_PACKAGES="ZDEMO,ZDEMO.ZDEMO_SD" → 允许 ZDEMO、ZDEMO.X、ZDEMO.ZDEMO_SD、ZDEMO.ZDEMO_SD.SUB，
   * 拒绝 ZDEMO.ZDEMO_MKC（不在配置的包前缀下）。
   */
  HANA_WRITE_PACKAGES: z.string().default('').transform((s) => s.split(',').map((x) => x.trim().toUpperCase()).filter(Boolean)),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
/**
     * XS Classic 设计时 REST 端口（直连 HTTP）。
     * 缺省按实例号推导 80<instance>（与官方文档 §8.2 / 本库实测一致）。
     */
    HANA_XS_PORT: z.string().regex(/^[0-9]+$/, 'XS 端口必须是数字').optional(),
    /** XS 设计时 REST 基础路径（默认 /sap/hana/xs/dt/base） */
    HANA_XS_BASE_PATH: z.string().min(1).default('/sap/hana/xs/dt/base'),
  /**
   * Streamable HTTP transport 端口。未设置 = stdio 传输（默认，向后兼容）；
   * 设置后以 Streamable HTTP 模式监听（端点 /mcp）。0 = 随机端口（测试用）。
   */
  MCP_HTTP_PORT: z.coerce.number().int().min(0).max(65535).optional(),
  /**
   * Streamable HTTP 监听地址。默认 127.0.0.1（仅本机，fail-closed）；
   * 对外暴露需显式配置（如 0.0.0.0），并同步放行 MCP_HTTP_ALLOWED_HOSTS/ORIGINS。
   */
  MCP_HTTP_HOST: z.string().min(1).default('127.0.0.1'),
  /**
   * Streamable HTTP Bearer Token（可选）。设置后所有请求须带 `Authorization: Bearer <token>`，
   * 缺失/不匹配 → 401（sha256 摘要后 timingSafeEqual 比较，防时序侧信道）。
   * HTTP 模式暴露到网络时的最低限度认证；默认未设置（回环监听即为访问边界）。≥16 字符防弱凭据。
   */
  MCP_HTTP_TOKEN: z
    .string()
    .min(16, 'MCP_HTTP_TOKEN 长度须 ≥16 字符（防弱凭据）')
    .optional()
    .transform((s) => s?.trim()),
  /**
   * 多客户端 Token → 身份映射（逗号分隔的 `name:token`）。
   * 用于 HTTP 模式下把请求归属到具体客户端：envelope.clientId、审计日志与排障都据此归因
   * （多客户端共享同一 HANA 技术账号，仓库侧的修改记录无法区分调用方，归属信息只有这里能给）。
   * name 限 [A-Za-z0-9_.-]{1,32}；token ≥16 字符；name/token 重复或格式非法在启动时即失败。
   * 可与 MCP_HTTP_TOKEN 并存（后者映射为身份 shared）。格式：alice:<token>,bob:<token>
   */
  MCP_HTTP_TOKENS: z.string().default('').transform((s) => s.trim()),
  /**
   * 允许的 Host 头主机名（DNS rebinding 防护；逗号分隔，不含端口，IPv6 带方括号）。
   * 默认仅本机名；经对外主机名访问时须追加对应主机名。
   */
  MCP_HTTP_ALLOWED_HOSTS: z
    .string()
    .default('localhost,127.0.0.1,[::1]')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
  /**
   * 允许的 Origin 主机名（浏览器类客户端防护；逗号分隔，不含 scheme/端口）。
   * 无 Origin 头的请求一律放行（非浏览器 MCP 客户端不发 Origin）。默认仅本机名。
   */
  MCP_HTTP_ALLOWED_ORIGINS: z
    .string()
    .default('localhost,127.0.0.1,[::1]')
    .transform((s) => s.split(',').map((x) => x.trim()).filter(Boolean)),
});

/** HTTP Token → 客户端身份映射条目（MCP_HTTP_TOKENS 解析结果） */
export interface HttpClientIdentity {
  /** 客户端身份名（进 envelope.clientId / 审计日志） */
  clientId: string;
  /** 该身份的 Bearer Token（仅驻内存，不落日志/不回显） */
  token: string;
}

/** 仅配置 MCP_HTTP_TOKEN（无 per-client 区分）时的身份名：如实表达「共享凭据」 */
export const SHARED_CLIENT_ID = 'shared';

/** 客户端身份名合法字符集（防怪异名字进日志/审计） */
const CLIENT_ID_RE = /^[A-Za-z0-9_.-]{1,32}$/;

/**
 * 解析 HTTP 客户端身份映射：MCP_HTTP_TOKENS 的 `name:token` 列表 + 可选单一 MCP_HTTP_TOKEN。
 * fail-closed：名字/Token 重复、Token 过短、格式非法一律抛错（启动失败），不静默降级为「无身份」。
 * 错误信息不含 Token 原文（配置错误会进日志，凭据不得回显）。
 */
export function parseHttpClients(raw: string, singleToken?: string): HttpClientIdentity[] {
  const clients: HttpClientIdentity[] = [];
  const names = new Set<string>();
  const tokens = new Set<string>();
  if (singleToken) {
    clients.push({ clientId: SHARED_CLIENT_ID, token: singleToken });
    names.add(SHARED_CLIENT_ID);
    tokens.add(singleToken);
  }
  const entries = raw.split(',').map((s) => s.trim()).filter(Boolean);
  entries.forEach((entry, idx) => {
    const sep = entry.indexOf(':');
    if (sep <= 0 || sep === entry.length - 1) {
      // 不回显 entry 原文（可能含 Token）
      throw new Error(`MCP_HTTP_TOKENS 第 ${idx + 1} 项格式非法：应为 name:token 形式`);
    }
    const clientId = entry.slice(0, sep).trim();
    const token = entry.slice(sep + 1).trim();
    if (!CLIENT_ID_RE.test(clientId)) {
      throw new Error(
        `MCP_HTTP_TOKENS 第 ${idx + 1} 项的客户端名非法：仅允许字母/数字/下划线/点/连字符且长度 ≤32`,
      );
    }
    if (token.length < 16) {
      throw new Error(`MCP_HTTP_TOKENS 中客户端 "${clientId}" 的 Token 长度须 ≥16 字符（防弱凭据）`);
    }
    if (names.has(clientId)) {
      throw new Error(`MCP_HTTP_TOKENS 客户端名重复：${clientId}`);
    }
    if (tokens.has(token)) {
      throw new Error(`MCP_HTTP_TOKENS 中客户端 "${clientId}" 的 Token 与另一条目重复（同一 Token 只能对应一个身份）`);
    }
    names.add(clientId);
    tokens.add(token);
    clients.push({ clientId, token });
  });
  return clients;
}

export interface HanaConfig {
  /** HANA 主机名/IP（真实值仅存在于本地 mcp.json/.env） */
  host: string;
  /** 实例号（00-99） */
  instance: string;
  /** SQL 端口 */
  port: number;
  user: string;
  password: string;
  /** 连接 Locale */
  locale: string;
  /** 租户数据库名（可选） */
  dbName?: string;
  /** TLS 加密连接（默认 true，fail-closed） */
  tls: boolean;
  /** TLS 下是否校验服务器证书（默认 true） */
  sslValidate: boolean;
  /** 默认时区（IANA 名称） */
  timezone: string;
  /** 额外允许的查询 schema（追加到 sql.ts 白名单） */
  schemaAllow: string[];
  /**
   * 允许写操作的仓库包前缀（大写）。空数组=不限制（所有包可写）；非空=仅允许这些包及其下级子包。
   * 来自 mcp.json/.env 的 HANA_WRITE_PACKAGES（逗号分隔）。运行时由 configureWritePackages 接线。
   */
  writePackages: string[];
  /**
   * 启用的工具功能分组（原始逗号分隔字符串，保留原样供 groups.ts 解析）。
   * 空=不限制（全部分组启用）；非空=仅启用指定分组（read/write/admin）。
   */
  toolGroups: string;
  /** 强制启用的工具名 glob 列表（覆盖分组开关；来自 HANA_TOOL_ALLOW） */
  toolAllow: string[];
  /** 强制禁用的工具名 glob 列表（最高优先级；来自 HANA_TOOL_DENY） */
  toolDeny: string[];
  logLevel: string;
  /** Streamable HTTP 端口。undefined = stdio 传输（默认）；设置 = HTTP 模式监听（0 = 随机端口） */
  httpPort?: number;
  /** Streamable HTTP 监听地址（默认 127.0.0.1，仅本机） */
  httpHost: string;
  /** Streamable HTTP Bearer Token（可选；设置后强制校验 Authorization 头） */
  httpTokens: HttpClientIdentity[];
  /** 允许的 Host 头主机名（DNS rebinding 防护，来自 MCP_HTTP_ALLOWED_HOSTS） */
  httpAllowedHosts: string[];
  /** 允许的 Origin 主机名（无 Origin 头放行，来自 MCP_HTTP_ALLOWED_ORIGINS） */
  httpAllowedOrigins: string[];
  /**
   * 连接目标/凭据各变量的实际来源标签（仅已设置项，不含值；来自 tryLoadDotEnv）。
   * 例：{ HANA_USER: '进程环境变量', HANA_HOST: '.env（工作目录）' }
   */
  connectionSources: Partial<Record<string, string>>;
  /**
   * true = 连接目标与凭据来自多个来源（进程环境变量与 .env 逐变量混用）。
   * 风险：某个变量的外部残留值会静默覆盖 .env 里的同名值，可能连到另一套环境 —— 入口处告警。
   */
  connectionSourceMixed: boolean;
/** XS Classic 设计时 REST 直连端口（80<instance>）；未配置时运行时按实例号推导 */
    xsPort?: number;
    /** XS 设计时 REST 基础路径（默认 /sap/hana/xs/dt/base） */
    xsBasePath: string;
}

/**
 * 根据实例号和是否有租户库推导 SQL 端口：
 * - 单容器 / SYSTEMDB: 3<instance>13
 * - 租户数据库 (MDC): 3<instance>15
 */
function derivePort(instance: string, dbName?: string): number {
  const prefix = `3${instance}`;
  // 如果有租户库名且不是 SYSTEMDB，使用 15 端口；否则 13 端口
  const suffix = dbName && dbName.toUpperCase() !== 'SYSTEMDB' ? '15' : '13';
  return parseInt(prefix + suffix, 10);
}

/**
 * 连接目标与凭据：这组变量决定「连到哪个库、以谁的身份」，跨来源混用会导致静默误连
 * （例：shell 里残留的 HANA_USER 覆盖 .env 里的用户名，其余变量仍来自 .env）。
 * 仅这组参与「来源一致性」判定——日志级别/工具分组/HTTP 端口等调优项混用无此风险。
 */
const CONNECTION_KEYS = [
  'HANA_HOST',
  'HANA_INSTANCE',
  'HANA_PORT',
  'HANA_DB_NAME',
  'HANA_USER',
  'HANA_PASSWORD',
] as const;

type ConnectionKey = (typeof CONNECTION_KEYS)[number];

/** 凭据三件套（缺一不可；齐备即完全跳过 .env） */
const CREDENTIAL_KEYS: readonly ConnectionKey[] = ['HANA_HOST', 'HANA_USER', 'HANA_PASSWORD'];

/** 来源标签：mcp.json env（客户端注入）/ shell / 容器注入都归此列 */
const SOURCE_PROCESS_ENV = '进程环境变量';

/** 值是否存在且非空（`HANA_PORT=` 这类空值视为未设置） */
function hasValue(v: string | undefined): boolean {
  return v !== undefined && v.trim() !== '';
}

/** .env 查找结果（只记录来源标签与文件，不记录任何值） */
export interface DotEnvLoadResult {
  /** 实际加载成功的 .env 文件标签（按尝试顺序） */
  loadedFiles: string[];
  /** 连接目标/凭据各变量的来源标签（仅含已设置且非空的键） */
  sources: Partial<Record<ConnectionKey, string>>;
}

/**
 * 尝试加载 .env（Node 原生 process.loadEnvFile，无 dotenv 依赖）。
 * - 外部注入（mcp.json env / 真实环境变量）已提供 主机+用户+密码 三件套时跳过（外部配置优先，不覆盖）
 * - 否则按候选路径补齐：当前工作目录 .env → 项目根 .env
 *   （本模块位于 dist/config/config.js，需上两级才到项目根；MCP 客户端常以工作区为 cwd，凭据文件在项目根）
 * - **逐变量生效**：loadEnvFile 不覆盖已存在的变量，因此「三件套只有一部分来自外部」时会出现
 *   .env 与环境变量混用 —— 返回值记录每个变量的实际来源，由 loadConfig 判定并告警。
 *
 * 注意：HTTP 模式下没有 MCP 客户端拉起本进程，mcp.json 的 env 不会注入 ——
 * 配置来源实际为 shell/容器环境变量 → .env 兜底（见 README「配置参数」）。
 */
export function tryLoadDotEnv(env: NodeJS.ProcessEnv = process.env): DotEnvLoadResult {
  const sources: Partial<Record<ConnectionKey, string>> = {};
  for (const key of CONNECTION_KEYS) {
    if (hasValue(env[key])) sources[key] = SOURCE_PROCESS_ENV;
  }
  // 三件套齐备 → 完全不读 .env（外部注入优先，不被邻近 .env 干扰）
  if (CREDENTIAL_KEYS.every((k) => hasValue(env[k]))) {
    return { loadedFiles: [], sources };
  }
  const load = (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return { loadedFiles: [], sources };

  const candidates: Array<{ dir: string; label: string }> = [
    { dir: process.cwd(), label: '.env（工作目录）' },
  ];
  try {
    // dist/config/config.js → 项目根（.env 所在目录），需上两级
    candidates.push({ dir: fileURLToPath(new URL('../../', import.meta.url)), label: '.env（项目根）' });
  } catch {
    /* 推导失败则只试 cwd */
  }

  const loadedFiles: string[] = [];
  for (const { dir, label } of candidates) {
    // 归因基线：本次加载前已有值的键属于更早的来源（外部注入或前一个 .env 文件）
    const before = new Set<ConnectionKey>(CONNECTION_KEYS.filter((k) => hasValue(env[k])));
    const p = `${dir.replace(/[\\/]$/, '')}${process.platform === 'win32' ? '\\' : '/'}.env`;
    try {
      load(p);
    } catch {
      continue; // 该路径无 .env，试下一个
    }
    loadedFiles.push(label);
    for (const key of CONNECTION_KEYS) {
      if (!before.has(key) && hasValue(env[key])) sources[key] = label;
    }
    // 三件套齐备即停（避免继续合并下一个 .env 造成更多来源混用）
    if (CREDENTIAL_KEYS.every((k) => hasValue(env[k]))) break;
  }
  return { loadedFiles, sources };
}

/**
 * 加载并校验配置。HANA_HOST/HANA_INSTANCE/HANA_USER/HANA_PASSWORD 必填（无默认值），
 * 缺失或非法抛 zod 校验错误（服务启动即失败，不给半配置运行的机会）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HanaConfig {
  const dotenv = tryLoadDotEnv(env);
  const parsed = envSchema.parse(env);
  
  // 解析端口：显式配置优先，否则按实例号推导
  const derivedPort = derivePort(parsed.HANA_INSTANCE, parsed.HANA_DB_NAME);
  const explicitPort = parsed.HANA_PORT?.trim();
  const port = explicitPort ? parseInt(explicitPort, 10) : derivedPort;
  
  if (isNaN(port) || port < 1 || port > 65535) {
    throw new Error(`无效的 SQL 端口: ${explicitPort || derivedPort}`);
  }
  
  // 将解析后的时区应用到整个进程（影响 new Date() 等本地时间语义）
  process.env.TZ = parsed.HANA_TIMEZONE;

  // 凭据生命周期：取出密码后即从进程环境移除，避免常驻 process.env 被同机进程/子进程/调试器读取
  delete process.env.HANA_PASSWORD;

  // 连接目标/凭据的来源归因：多于一个来源 = 混用（如 shell 残留的 HANA_USER + .env 其余项）
  const connectionSourceMixed = new Set(Object.values(dotenv.sources)).size > 1;

  return {
    host: parsed.HANA_HOST,
    instance: parsed.HANA_INSTANCE,
    port,
    user: parsed.HANA_USER,
    password: parsed.HANA_PASSWORD,
    locale: parsed.HANA_LOCALE,
    dbName: parsed.HANA_DB_NAME,
    tls: parsed.HANA_TLS,
    sslValidate: parsed.HANA_SSL_VALIDATE,
    timezone: parsed.HANA_TIMEZONE,
    schemaAllow: parsed.HANA_SCHEMA_ALLOW,
    writePackages: parsed.HANA_WRITE_PACKAGES,
    toolGroups: parsed.HANA_TOOL_GROUPS,
    toolAllow: parsed.HANA_TOOL_ALLOW,
    toolDeny: parsed.HANA_TOOL_DENY,
    logLevel: parsed.LOG_LEVEL,
xsPort: parsed.HANA_XS_PORT ? parseInt(parsed.HANA_XS_PORT, 10) : parseInt(`80${parsed.HANA_INSTANCE}`, 10),
    xsBasePath: parsed.HANA_XS_BASE_PATH,
    httpPort: parsed.MCP_HTTP_PORT,
    httpHost: parsed.MCP_HTTP_HOST,
    // Token → 身份映射（MCP_HTTP_TOKENS + 单一 MCP_HTTP_TOKEN 合并；非空即强制 Bearer 校验）
    httpTokens: parseHttpClients(parsed.MCP_HTTP_TOKENS, parsed.MCP_HTTP_TOKEN),
    httpAllowedHosts: parsed.MCP_HTTP_ALLOWED_HOSTS,
    httpAllowedOrigins: parsed.MCP_HTTP_ALLOWED_ORIGINS,
    connectionSources: dotenv.sources,
    connectionSourceMixed,
  };
}
