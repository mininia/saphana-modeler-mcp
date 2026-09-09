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
  /** 预留：Streamable HTTP transport 端口（当前 stdio 传输） */
  MCP_HTTP_PORT: z.coerce.number().int().min(1).max(65535).optional(),
});

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
  /** 预留 HTTP 端口 */
  httpPort?: number;
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
 * 尝试加载 .env（Node 原生 process.loadEnvFile，无 dotenv 依赖）。
 * - 外部注入（mcp.json env / 真实环境变量）已提供 主机+用户+密码 三件套时跳过（外部配置优先，不覆盖）
 * - 否则按候选路径补齐：当前工作目录 .env → 项目根 .env
 *   （本模块位于 dist/config/config.js，需上两级才到项目根；MCP 客户端常以工作区为 cwd，凭据文件在项目根）
 */
export function tryLoadDotEnv(env: NodeJS.ProcessEnv = process.env): void {
  if (env.HANA_HOST && env.HANA_USER && env.HANA_PASSWORD) return;
  const load = (process as NodeJS.Process & { loadEnvFile?: (p?: string) => void }).loadEnvFile;
  if (typeof load !== 'function') return;
  const candidates = [process.cwd()];
  try {
    // dist/config/config.js → 项目根（.env 所在目录），需上两级
    candidates.push(fileURLToPath(new URL('../../', import.meta.url)));
  } catch {
    /* 推导失败则只试 cwd */
  }
  for (const dir of candidates) {
    const p = `${dir.replace(/[\\/]$/, '')}${process.platform === 'win32' ? '\\' : '/'}.env`;
    try {
      load(p);
      if (env.HANA_PASSWORD) break; // 密码补齐即停
    } catch {
      // 该路径无 .env，试下一个
    }
  }
}

/**
 * 加载并校验配置。HANA_HOST/HANA_INSTANCE/HANA_USER/HANA_PASSWORD 必填（无默认值），
 * 缺失或非法抛 zod 校验错误（服务启动即失败，不给半配置运行的机会）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HanaConfig {
  tryLoadDotEnv();
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
  };
}
