import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DEFAULT_TIMEZONE } from '../core/datetime.js';
import { logger } from '../core/logger.js';
import {
  ACTIVATION_CONCURRENCY_DEFAULT,
  POOL_ACQUIRE_TIMEOUT_MS_DEFAULT,
  POOL_MAX_DEFAULT,
  POOL_MAX_WAITERS_DEFAULT,
  SQL_TIMEOUT_MS_DEFAULT,
  XS_TIMEOUT_MS_DEFAULT,
  XS_XFER_TIMEOUT_MS_DEFAULT,
} from '../core/limits.js';
import { IDENTITY_NAME_HINT, IDENTITY_NAME_RE, splitList } from '../core/text.js';
import { XS_BASE_PATH } from '../core/xs-rest.js';
import { findInvalidWritePackages } from './write-boundary.js';
import { IMPLICIT_DEFAULT_PROFILE_ID, parseProfiles, type CallerProfile } from './profiles.js';
import { DEFAULT_HTTP_HOST, DEFAULT_SSL_VALIDATE, DEFAULT_TLS } from './deployment.js';

/** 默认 Locale（仅本文件使用）。2026-10-14 起由 zh_CN 改为 zh（不带国家码） */
const DEFAULT_LOCALE = 'zh';

/**
 * 布尔环境变量的真值集合（其余取值在 boolSchema 下 fail-fast 拒绝）。
 * preflight 的原生 env 解析（mcp.json 路径）读的是原始值、无法走 zod，
 * 但它必须与这里的真值口径**同源**，故共用 {@link isEnvTrue} 的口径。
 */
const ENV_TRUE_VALUES = ['true', '1', 'TRUE'] as const;
const ENV_FALSE_VALUES = ['false', '0', 'FALSE'] as const;
/** boolSchema 的合法取值全集（真值 + 假值；其它取值在启动时即报错，不被静默当成假） */
const BOOL_ENV_VALUES = [...ENV_TRUE_VALUES, ...ENV_FALSE_VALUES] as const;

/**
 * 真值判定（与 boolSchema 同一集合）。
 * 供读原始 env 的调用点复用（preflight 的 mcp.json / 进程 env 路径）——那边拿不到 zod，
 * 非真值一律按假处理；语义差异见 preflight.deploymentFromEnvValues 的注释。
 */
export function isEnvTrue(v: unknown): boolean {
  return (ENV_TRUE_VALUES as readonly string[]).includes(String(v));
}

/**
 * 「非空值」判定与取值的唯一原语（空串/全空白视同未设置 = undefined；非空串返回 trim 后的字符串）。
 * hasValue 是它的布尔投影；emptyAsUnset 的「空」判定也委托它——字符串域的"空"只有这一处口径，
 * 将来调整空白定义只改这里，不会出现 hasValue 与各 preprocess 分叉。
 */
function nonEmptyEnvValue(v: unknown): string | undefined {
  if (v === undefined || v === null) return undefined;
  const s = String(v).trim();
  return s === '' ? undefined : s;
}

/** 值是否存在且非空（空串/全空白视为未设置）。判定委托 {@link nonEmptyEnvValue}（唯一原语） */
export function hasValue(v: unknown): boolean {
  return nonEmptyEnvValue(v) !== undefined;
}

/**
 * 布尔环境变量解析：'true'/'1'/'TRUE' → true，'false'/'0'/'FALSE' → false，
 * 其余取值**启动即失败**（zod 枚举拒绝）。避免 z.coerce.boolean() 把字符串 'false' 强转为 true 的经典坑。
 * @param defaultValue 未配置时的默认值（fail-closed：安全相关开关默认 true）
 */
const boolSchema = (defaultValue: boolean) =>
  z
    .enum(BOOL_ENV_VALUES)
    .default(defaultValue ? 'true' : 'false')
    .transform(isEnvTrue);

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

/**
 * 空串/纯空白按「未设置」处理（"空"的判定委托 {@link nonEmptyEnvValue}，唯一原语）。
 * 非字符串值原样通过；非空字符串也原样返回、不 trim（需要去掉首尾空白的消费方见 {@link trimmedOrUnset}）。
 * 不先归一就交给下游会报出与真实原因无关的错：z.coerce.number('') 解析成 0 撞下限、parseInt('') 得 NaN。
 */
const emptyAsUnset = (v: unknown): unknown =>
  typeof v === 'string' && nonEmptyEnvValue(v) === undefined ? undefined : v;

/** 同 emptyAsUnset，但非空字符串顺带去掉首尾空白（端口串等格式严格项：先归一再校验） */
const trimmedOrUnset = (v: unknown): unknown => {
  const s = emptyAsUnset(v);
  return typeof s === 'string' ? s.trim() : s;
};

/**
 * 数字型环境变量（正整数、可留空）：池、超时与激活并发这类运行旋钮共用，默认值见 core/limits.js。
 * - 空串按「未设置」处理（见 emptyAsUnset）；
 * - 非数字/越界取值启动即失败（fail-closed，与本文件其余部分同口径）——这些值静默取错
 *   只表现为「莫名变慢/莫名失败」，比启动失败难查得多；
 * - 默认值一律从 core/limits.js 取常量，不写数字字面量（避免「配置默认值 ≠ 运行时兜底值」分叉）。
 */
const intEnvSchema = (defaultValue: number, min: number, max: number) =>
  z.preprocess(emptyAsUnset, z.coerce.number().int().min(min).max(max).default(defaultValue));

/** 提升预算默认值（zod default 与 parseSurfaceMax 的错误消息共用，防两处字面量漂移） */
const SURFACE_MAX_DEFAULT = 50;

const envSchema = z.object({
  // 安全要求：连接信息（主机/端口/库名/用户名/密码）一律只允许来自环境变量 / mcp.json，
  // 禁止默认值或硬编码真实环境值
  HANA_HOST: z.string().min(1),
  /**
   * SQL 端口（**必填**）。2026-10-14 起不再有实例号（HANA_INSTANCE 已删除）：
   * 端口一律由部署方显式给出，服务端不按 `3<实例>13/15` 推导——那条规则只覆盖默认实例与
   * 首个租户，非默认租户（如 `3<实例>4<序号>` 这类）推不出来，猜错的表现是连到另一套库或
   * 直接连不上（本机 31041 即属此类），而报错发生在首次工具调用时。宁要一行配置，不要猜。
   * 只接受纯数字（空串/纯空白按未设置，见 emptyAsUnset）：'3.5'/'30115abc'/'30,015'
   * 这类笔误在 parseInt 下会被静默截断成 3 / 30115 / 30 并连到从未配置过的端口，失败要拖到
   * 首次工具调用才暴露、报错里的端口还与会话里写的对不上——故格式校验与 HANA_XS_PORT 同口径。
   */
  HANA_PORT: z.preprocess(
    trimmedOrUnset,
    z
      .string({ error: 'HANA_PORT 必填：请给出 SQL 端口（如 30015 / 31041）' })
      .regex(/^[0-9]+$/, '无效的 SQL 端口：必须是纯数字（如 30015；不含小数点/千分位等其它字符）'),
  ),
  HANA_USER: z.string().min(1),
  HANA_PASSWORD: z.string().min(1),
  /** 连接 Locale（默认 zh），影响服务器端语言/错误消息 */
  HANA_LOCALE: z.string().min(1).default(DEFAULT_LOCALE),
  /** 租户数据库名（MDC 环境必填，如 SYSTEMDB / 业务租户名） */
  HANA_DB_NAME: z.string().min(1).optional(),
  /**
   * 是否启用 TLS 加密连接。默认 true（fail-closed：未显式配置时不允许明文传输凭据/数据）。
   * 仅当确认网络链路可信（如 localhost）且需兼容自签证书时才显式置 false。
   */
  HANA_TLS: boolSchema(DEFAULT_TLS),
  /**
   * TLS 下是否校验服务器证书。默认 true（防止中间人替换证书窃取认证与数据）。
   * 内网自签证书环境需跳过校验时显式置 false（应与 HANA_TLS=false 权衡，避免加密但不认证）。
   */
  HANA_SSL_VALIDATE: boolSchema(DEFAULT_SSL_VALIDATE),
  HANA_TIMEZONE: timeZoneSchema,
  /**
   * 启用的工具功能分组（逗号分隔：read/write/admin）。
   * 空/未填 = 不限制（全部分组启用，向后兼容默认）。
   * 例：HANA_TOOL_GROUPS="read" → 仅暴露数据读取，关闭全部写工具（含校验）。
   * 合法值校验在 src/tools/groups.ts 的 parseToolFilter 完成（启动即失败）。
   *
   * 名称：HANA_ 前缀——与 HANA_WRITE_PACKAGES / HANA_READ_SCHEMA 同类，都是「这个 HANA 面
   * 向客户端暴露/放行多少」的部署级范围声明（2026-10-14 复核回退：曾于 2026-10-08 改名
   * MCP_TOOL_*，现改回 HANA_ 前缀并与其余两个范围声明对齐）。**无别名层**：MCP_TOOL_* 不再识别，
   * 仍写旧名会命中「未识别 HANA_/MCP_/LOG_ 环境变量」启动告警（见 warnUnknownEnvKeys）。
   */
  HANA_TOOL_GROUPS: z
    .string()
    .default('')
    .transform((s) => s.trim()),
  /**
   * 强制启用的工具名 glob（逗号分隔，支持 * 通配；即便其分组未启用也注册）。
   * 用于在分组开关之外单独放行个别工具。例：HANA_TOOL_ALLOW="hana_some_tool"
   */
  HANA_TOOL_ALLOW: z.string().default('').transform(splitList),
  /**
   * 强制禁用的工具名 glob（逗号分隔，支持 * 通配；优先级最高，覆盖 allow 与分组）。
   * 例：HANA_TOOL_DENY="hana_data_preview_*" 关闭所有预览工具。
   */
  HANA_TOOL_DENY: z.string().default('').transform(splitList),
  /**
   * 工具面省略说明的调试开关（P1-7）：默认关闭，只说明"哪些类别被收窄/加载失败"，**不点名**被隐藏的能力。
   * 置 `names` 才在说明里输出被隐藏/失败的能力名（排障用；会泄漏能力存在性，不要常开）。
   */
  HANA_EXPLAIN_SURFACE: z.preprocess(emptyAsUnset, z.enum(['names']).optional()),
  /**
   * 调用方档案定义：`name=kinds[:glob|glob][;name2=…]`，kinds 用 + 连接。
   * 例：MCP_PROFILES="analyst=read;dev=read+write:hana_view_*|hana_metadata_*;default=read"
   * 档案**只能收紧**部署策略；配了档案就必须定义 default（HTTP 无档案参数的 Token 与 stdio 都落它）。
   * 解析即校验（src/config/profiles.ts），非法条目启动失败。
   */
  MCP_PROFILES: z
    .string()
    .default('')
    .transform((s) => s.trim()),
  /**
   * 本进程（stdio）使用的档案名，须存在于 MCP_PROFILES；默认 'default'。
   * HTTP 模式下每个 Token 的档案来自 MCP_HTTP_TOKENS 的第三段，本项只作为**缺省档案**。
   */
  MCP_PROFILE: z
    .string()
    .default('default')
    .transform((s) => s.trim()),
  /**
   * 进程级归因标签（可选）：写进 envelope 与每一条审计日志，用于区分"这条记录来自哪套部署"。
   * 例：MCP_AGENT_LABEL="prod-cn-01"。空 = 不产生该字段（不制造恒为空的噪音）。
   */
  MCP_AGENT_LABEL: z
    .string()
    .default('')
    .transform((s) => s.trim()),
  /**
   * 单调用方的**提升预算**：按**工具数**算（只数能注册为工具的成员，操作级条目不注册也不计），
   * 超出时**最旧的那个分类**整体淘汰（FIFO）。与 hana-cli 的 `MAX_DYNAMIC_TOOLS` 同值同义。
   * 上限的意义是能力增长时不静默失控；空串按未设置处理（与其余数字旋钮同口径）。
   */
  MCP_CAPABILITY_SURFACE_MAX: z.preprocess(
    emptyAsUnset,
    z
      .string()
      .default(String(SURFACE_MAX_DEFAULT))
      .transform((s) => s.trim()),
  ),
  /** 额外允许的 SQL 查询 schema（逗号分隔，追加到 core/sql.ts 白名单；默认仅系统 schema）。
   *  2026-10-14 由 HANA_SCHEMA_ALLOW 改名而来（原名只说明「allow」，看不出 allow 什么）；
   *  **无别名层**：旧名不再识别，仍写旧名会命中未识别环境变量启动告警。 */
  HANA_READ_SCHEMA: z.string().default('').transform(splitList),
  /**
   * 允许写操作的仓库包（逗号分隔的包前缀；含子包）。
   * 填写后仅允许指定包及其下级子包写操作。
   * **空/未填不是「所有包可写」**：端到端表现为写不可用——写工具已暴露时，任何声明写包的调用
   * 都会被运行期闸门以 boundary_off 拒绝（只有服务层的纵深防御是 fail-open，见 config/write-boundary.ts 头注）。
   * 例：HANA_WRITE_PACKAGES="ZDEMO,ZDEMO.ZDEMO_SD" → 允许 ZDEMO、ZDEMO.X、ZDEMO.ZDEMO_SD、ZDEMO.ZDEMO_SD.SUB，
   * 拒绝 OTHER、OTHER.X（既不等于配置项，也不以其加「.」开头）。
   */
  HANA_WRITE_PACKAGES: z
    .string()
    .default('')
    .transform((s) => {
      const entries = splitList(s).map((x) => x.toUpperCase());
      // 非法条目（"ZDEMO." / "ZDE MO" / "*" 等）会被静默保留成永不匹配的前缀：
      // 表现为「所有写操作被拒」或「边界形同虚设」，两种都只会在写链路末端才暴露，
      // 故在配置加载时即失败（fail-closed），并把修复方式写进错误消息。
      const invalid = findInvalidWritePackages(entries);
      if (invalid.length > 0) {
        throw new Error(
          `HANA_WRITE_PACKAGES 含非法包名：${invalid.join(', ')}。合法形式为点分段的仓库包路径` +
            '（大写字母/数字/下划线/连字符，如 ZDEMO 或 ZDEMO.ZDEMO_SD）。' +
            '请给出至少一个合法的可写包前缀；填 * 等通配符无效，而整体留空会让写工具被闸门拦下（见该项说明）',
        );
      }
      return entries;
    }),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /**
   * XS Classic 设计时 REST 端口（直连 HTTP）。**写/导出等走 XS 通道的能力使用**。
   * 默认 `8010`（适配多数单实例部署）；非默认实例/租户请显式覆盖——仍不按实例号推导
   * `80<instance>`（HANA_INSTANCE 已删除，那条规则推不出非默认租户）。
   * 与 HANA_PORT 同口径：空串按未设置（→ 默认 8010）、纯数字校验在装载时做，越界（如 '0'/'99999'）
   * 在 loadConfig 统一收口——不让坏值拖到首次 XS REST 调用才以驱动层错误暴露。
   */
  HANA_XS_PORT: z.preprocess(
    trimmedOrUnset,
    z
      .string()
      .regex(/^[0-9]+$/, 'XS 端口必须是数字')
      .default('8010'),
  ),
  /** XS 设计时 REST 基础路径（默认 /sap/hana/xs/dt/base） */
  HANA_XS_BASE_PATH: z.string().min(1).default(XS_BASE_PATH),
  /* ── 并发与超时旋钮：池、SQL/XS 超时、激活并发 ──
   * 全部为 intEnvSchema（数字型、可留空、留空 = 默认值；非法值启动即失败）；
   * 前缀 HANA_ 的理由：这些都是与 HANA 连接侧资源相关的运行参数（与 HANA_XS_PORT/HANA_READ_SCHEMA 同类），
   * 不属 MCP_ 工具面/传输面。默认值与运行时兜底值同源（core/limits.js）。 */
  /** 连接池上限 HANA_POOL_MAX：每代理进程的 HANA 连接数上限（N 个代理进程 = N×该值条连接） */
  HANA_POOL_MAX: intEnvSchema(POOL_MAX_DEFAULT, 1, 256),
  /** 池排队等待超时 ms HANA_POOL_WAIT_MS：防单个慢查询把全部调用方无限期挂住（到点失败而不是一直等） */
  HANA_POOL_WAIT_MS: intEnvSchema(POOL_ACQUIRE_TIMEOUT_MS_DEFAULT, 1, 3_600_000),
  /** 池排队上限 HANA_POOL_MAX_WAITERS：池满时有界排队，超限立即失败，防请求无限堆积 */
  HANA_POOL_MAX_WAITERS: intEnvSchema(POOL_MAX_WAITERS_DEFAULT, 1, 100_000),
  /** 写路径语句超时 ms HANA_SQL_TIMEOUT_MS：防一条挂死的写语句占住池位直到进程重启（只给写路径，不加全局默认，理由见 core/limits.js） */
  HANA_SQL_TIMEOUT_MS: intEnvSchema(SQL_TIMEOUT_MS_DEFAULT, 1, 3_600_000),
  /** XS REST 请求超时 ms HANA_XS_TIMEOUT_MS：覆盖走 request() 出口的全部调用，防一条挂死的 XS 请求占住池位直到进程重启 */
  HANA_XS_TIMEOUT_MS: intEnvSchema(XS_TIMEOUT_MS_DEFAULT, 1, 3_600_000),
  /** XS 传输（xfer 导入/导出）超时 ms HANA_XS_XFER_TIMEOUT_MS：整包上传/下载天然慢，单独放宽上限，同样防挂死 */
  HANA_XS_XFER_TIMEOUT_MS: intEnvSchema(XS_XFER_TIMEOUT_MS_DEFAULT, 1, 86_400_000),
  /** 激活并发上限 HANA_ACTIVATION_CONCURRENCY：激活是重操作（2–10s/次），不限流会被并发激活占满 HANA 侧资源 */
  HANA_ACTIVATION_CONCURRENCY: intEnvSchema(ACTIVATION_CONCURRENCY_DEFAULT, 1, 64),
  /**
   * Streamable HTTP transport 端口。未设置 = stdio 传输（默认，向后兼容）；
   * 设置后以 Streamable HTTP 模式监听（端点 /mcp）。0 = 随机端口（测试用）。
   * 空串（`MCP_HTTP_PORT=`）按"未设置"处理（见 emptyAsUnset，与 HANA_PORT 等同一约定），
   * 也避免出现「配置解析成 0（= 进 HTTP 模式）而策略判定成 stdio」的分叉。
   */
  MCP_HTTP_PORT: z.preprocess(emptyAsUnset, z.coerce.number().int().min(0).max(65535).optional()),
  /**
   * Streamable HTTP 监听地址。默认 127.0.0.1（仅本机，fail-closed）；
   * 对外暴露需显式配置（如 0.0.0.0），并同步放行 MCP_HTTP_ALLOWED_HOSTS/ORIGINS。
   */
  MCP_HTTP_HOST: z.string().min(1).default(DEFAULT_HTTP_HOST),
  /**
   * [DEPRECATED] Streamable HTTP Bearer Token。等价于 MCP_HTTP_TOKENS="shared:<token>"
   * ——读入**同一张 Token → 身份映射表**（clientId=shared），401 语义与归因行为完全不变。
   * 保留为别名只为向后兼容（现有只配本项的部署不需要改配置）；新部署请只配 MCP_HTTP_TOKENS，
   * 本项计划在下一个大版本删除。
   * sha256 摘要后 timingSafeEqual 比较，防时序侧信道。≥16 字符防弱凭据。
   */
  MCP_HTTP_TOKEN: z
    .string()
    // 先 trim 再查长度（与 MCP_HTTP_TOKENS 路径同口径）：长度下限在 trim 之前会被空白填充绕过——
    // 'a' + 15 个空格能通过 16 字符校验，实际口令只有 1 字符；纯空白则 trim 成空串、同样被拒
    //（不允许"看起来配了 Token、实际按未配置处理"，那会静默改变这些部署的认证语义）。
    .transform((s) => s.trim())
    .refine((s) => s.length >= 16, 'MCP_HTTP_TOKEN 长度须 ≥16 字符（防弱凭据）')
    .optional(),
  /**
   * 多客户端 Token → 身份映射（逗号分隔的 `name:token`）。
   * 用于 HTTP 模式下把请求归属到具体客户端：envelope.clientId、审计日志与排障都据此归因
   * （多客户端共享同一 HANA 技术账号，仓库侧的修改记录无法区分调用方，归属信息只有这里能给）。
   * name 限 [A-Za-z0-9_.-]{1,32}；token ≥16 字符；name/token 重复或格式非法在启动时即失败。
   * 可与 MCP_HTTP_TOKEN（deprecated 别名，映射为身份 shared）并存。格式：alice:<token>,bob:<token>
   */
  MCP_HTTP_TOKENS: z
    .string()
    .default('')
    .transform((s) => s.trim()),
  /**
   * 允许的 Host 头主机名（DNS rebinding 防护；逗号分隔，不含端口，IPv6 带方括号）。
   * 默认仅本机名；经对外主机名访问时须追加对应主机名。
   */
  MCP_HTTP_ALLOWED_HOSTS: z.string().default('localhost,127.0.0.1,[::1]').transform(splitList),
  /**
   * 允许的 Origin 主机名（浏览器类客户端防护；逗号分隔，不含 scheme/端口）。
   * 无 Origin 头的请求一律放行（非浏览器 MCP 客户端不发 Origin）。
   * **未设置时继承 MCP_HTTP_ALLOWED_HOSTS**（默认即回环名）——对外暴露时只在一个变量里放行，
   * 不放松安全：默认仍是回环名；显式置空则拒绝一切带 Origin 的请求。
   */
  MCP_HTTP_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((s) => (s === undefined ? undefined : splitList(s))),
  /**
   * 显式承认「HTTP 对外监听且不配置任何 Bearer Token」的风险（默认 false = 拒绝启动）。
   * 非回环监听 + 无 Token 时，任何可达者都能调用全部工具（含写操作）且无法归因，
   * 故默认 fail-closed；确实需要（如已置于带认证的反向代理之后）再显式置 true。
   */
  MCP_HTTP_ALLOW_ANONYMOUS: boolSchema(false),
});

/** HTTP Token → 客户端身份映射条目（MCP_HTTP_TOKENS 解析结果） */
export interface HttpClientIdentity {
  /** 客户端身份名（进 envelope.clientId / 审计日志） */
  clientId: string;
  /** 该身份的 Bearer Token（仅驻内存，不落日志/不回显） */
  token: string;
  /**
   * 该身份使用的调用方档案（MCP_HTTP_TOKENS 的第三段）；缺省 = 进程默认档案（MCP_PROFILE）。
   * 只影响**调用期授权**（能调什么），不影响注册期可见性（工具面仍是部署级）。
   */
  profileId?: string;
}

/** 仅配置 MCP_HTTP_TOKEN（无 per-client 区分）时的身份名：如实表达「共享凭据」 */
const SHARED_CLIENT_ID = 'shared';

/**
 * 解析 HTTP 客户端身份映射：MCP_HTTP_TOKENS 的 `name:token[:profile]` 列表 + 可选单一 MCP_HTTP_TOKEN。
 *
 * 三段式：第三段是**调用方档案名**（须在 MCP_PROFILES 中定义，启动自检核对）。
 * 两段式仍完全兼容（= 不给档案，落进程默认档案）。
 *
 * fail-closed：名字/Token 重复、Token 过短、分段数非法、**Token 段含 `:`** 一律抛错（启动失败），
 * 不静默降级为「无身份」。最后一条是刻意的：旧配置里真有 token 含 `:` 时，按"第一个冒号切分"
 * 会被**静默改义**（后半截变成档案名）——宁可用"响亮失败 + 迁移提示"换一次人工确认。
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
  const entries = splitList(raw);
  entries.forEach((entry, idx) => {
    // 分段：name:token（两段，兼容）或 name:token:profile（三段）。
    // >3 段或空段一律失败——那通常意味着 Token 里带了 `:`，按旧口径会被静默改义。
    const parts = entry.split(':');
    if (parts.length < 2 || parts.length > 3 || parts.some((p) => p.trim() === '')) {
      // 不回显 entry 原文（可能含 Token）
      throw new Error(
        `MCP_HTTP_TOKENS 第 ${idx + 1} 项格式非法：应为 name:token 或 name:token:profile；` +
          '若 Token 本身含冒号，请更换 Token（冒号已用于分隔身份与档案）',
      );
    }
    const clientId = parts[0].trim();
    const token = parts[1].trim();
    const profileId = parts.length === 3 ? parts[2].trim() : undefined;
    if (!IDENTITY_NAME_RE.test(clientId)) {
      throw new Error(`MCP_HTTP_TOKENS 第 ${idx + 1} 项的客户端名非法：${IDENTITY_NAME_HINT}`);
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
    clients.push({ clientId, token, ...(profileId ? { profileId } : {}) });
  });
  return clients;
}

export interface HanaConfig {
  /** HANA 主机名/IP（真实值仅存在于本地 mcp.json/.env） */
  host: string;
  /** SQL 端口（来自必填的 HANA_PORT；2026-10-14 起不再由实例号推导） */
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
  /** 额外允许的查询 schema（来自 HANA_READ_SCHEMA，追加到 sql.ts 白名单） */
  schemaAllow: string[];
  /**
   * 允许写操作的仓库包前缀（大写）。非空=仅允许这些包及其下级子包；**空数组=本判定层不限制**，
   * 但端到端不是「所有包可写」——声明写包的调用会被运行期闸门以 boundary_off 拒绝（见同名字段在
   * envSchema 的说明与 config/write-boundary.ts 头注）。
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
  /** 工具面省略说明的调试开关（来自 HANA_EXPLAIN_SURFACE=names）；未配置 = 不点名被隐藏的能力 */
  explainSurface?: 'names';
  /**
   * 调用方档案表（来自 MCP_PROFILES；空表 = 只有隐式 default 档案，不额外收紧）。
   * 档案只作用于**调用期授权**（config/authorize.ts），不改变注册期可见性。
   */
  profiles: Map<string, CallerProfile>;
  /** 本进程（stdio）与"无档案身份的调用方"使用的档案名（来自 MCP_PROFILE，默认 'default'） */
  profileId: string;
  /** 进程级归因标签（来自 MCP_AGENT_LABEL；空 = 不产生该字段） */
  agentLabel: string;
  /** 单调用方的提升预算（来自 MCP_CAPABILITY_SURFACE_MAX；按工具数、最旧分类整体淘汰） */
  surfaceMax: number;
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
  /** 显式承认「对外监听且不认证」的风险（来自 MCP_HTTP_ALLOW_ANONYMOUS，默认 false） */
  httpAllowAnonymous: boolean;
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
  /**
   * XS Classic 设计时 REST 直连端口（来自 HANA_XS_PORT，**默认 8010**）。
   * 不再按实例号推导；非默认实例/租户由部署方显式覆盖。
   */
  xsPort: number;
  /** XS 设计时 REST 基础路径（默认 /sap/hana/xs/dt/base） */
  xsBasePath: string;
  /** HANA 连接池并发上限（来自 HANA_POOL_MAX，默认 4）；N 个代理进程 = N×该值条 HANA 连接 */
  poolMax: number;
  /** 池排队等待超时 ms（来自 HANA_POOL_WAIT_MS，默认 30000） */
  poolWaitMs: number;
  /** 池满时的排队上限（来自 HANA_POOL_MAX_WAITERS，默认 64） */
  poolMaxWaiters: number;
  /** 写路径语句超时 ms（来自 HANA_SQL_TIMEOUT_MS，默认 60000）：写路径五条语句的超时来源，不做全局默认 */
  sqlTimeoutMs: number;
  /** XS REST 请求超时 ms（来自 HANA_XS_TIMEOUT_MS，默认 30000） */
  xsTimeoutMs: number;
  /** XS 传输（xfer 导入/导出）超时 ms（来自 HANA_XS_XFER_TIMEOUT_MS，默认 300000） */
  xsXferTimeoutMs: number;
  /** 激活并发上限（来自 HANA_ACTIVATION_CONCURRENCY，默认 2） */
  activationConcurrency: number;
}

/**
 * 连接目标与凭据：这组变量决定「连到哪个库、以谁的身份」，跨来源混用会导致静默误连
 * （例：shell 里残留的 HANA_USER 覆盖 .env 里的用户名，其余变量仍来自 .env）。
 * 仅这组参与「来源一致性」判定——日志级别/工具分组/HTTP 端口等调优项混用无此风险。
 *
 * HANA_XS_PORT 同属此组：它决定写通道（XS REST）连到哪个端点，且 XS 走**明文 HTTP**——
 * 混用时同样会静默连到另一套环境，且在 TLS 的 HANA_PORT 之外多一条不太被注意的明文链路。
 */
const CONNECTION_KEYS = [
  'HANA_HOST',
  'HANA_PORT',
  'HANA_XS_PORT',
  'HANA_DB_NAME',
  'HANA_USER',
  'HANA_PASSWORD',
] as const;

type ConnectionKey = (typeof CONNECTION_KEYS)[number];

/** 凭据三件套（缺一不可；齐备即完全跳过 .env） */
const CREDENTIAL_KEYS: readonly ConnectionKey[] = ['HANA_HOST', 'HANA_USER', 'HANA_PASSWORD'];

/** 来源标签：mcp.json env（客户端注入）/ shell / 容器注入都归此列 */
const SOURCE_PROCESS_ENV = '进程环境变量';

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

  const candidates: Array<{ dir: string; label: string }> = [{ dir: process.cwd(), label: '.env（工作目录）' }];
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
 * 不经 envSchema、由运行期直读 process.env 的受支持变量：它们同样"生效"，必须进 known 集合，
 * 否则启动告警会把它们误报成「不生效（拼写错误？已改名？已移除？）」——运维按服务自己的处置建议
 * 设置了变量，反而被劝退（如撤回 HANA_XS_TLS 会静默退回 XS 明文通道）。
 * - HANA_XS_TLS：XS 写通道 scheme（core/xs-rest.ts 的 xsSchemeFromEnv 直读；core 层不依赖 config
 *   运行时模块，走不了 zod。deployment.ts 的 xs_plaintext 处置建议与 preflight 判定都指向它）。
 * 新增这类运行期直读变量时同步登记于此（与运行期直读点必须同名）。
 *
 * MCP_LOCAL_ROOT 已于 2026-10-14 删除（本地文件根的旋钮取消：导入/导出一律以客户端工作目录
 * 为根、只接受其内的相对路径，见 services/repo-transfer.service.ts）。它不再进 known 集合，
 * 存量配置里残留该键会命中未识别告警。
 */
const RUNTIME_DIRECT_ENV_KEYS = ['HANA_XS_TLS'] as const;

/**
 * 未识别的 HANA_/MCP_/LOG_ 环境变量告警（拼错、已改名、已被删除的名字）。
 *
 * 为什么值得一条告警：envSchema 对未知键**静默剥离**，于是一个拼错的变量名会表现为
 * 「该项配置没生效」，而运维看到的值与生效值不一致——本仓库已经踩过一次
 * （`.dsh/mcp.json` 里写成 `HANA_WRITE_PACKAGE`（少一个 S），写边界因此静默失效）。
 * 只对这三个前缀告警，避免把 PATH/无关变量卷进来。
 * known 集合 = envSchema 键 + 运行期直读键（见 RUNTIME_DIRECT_ENV_KEYS）：
 * **生效的**变量一个都不许进这条告警，否则就是反方向的「生效值 ≠ 运维以为的值」。
 * 2026-10-14 起本仓**没有别名层**（HANA_TOOL_* 回退正名、HANA_SCHEMA_ALLOW → HANA_READ_SCHEMA、
 * HANA_INSTANCE / MCP_LOCAL_ROOT 删除都是硬切换），所以这条告警也是旧名/已删名唯一的提示处。
 */
function warnUnknownEnvKeys(env: Record<string, unknown>): void {
  const known = new Set<string>([...Object.keys(envSchema.shape), ...RUNTIME_DIRECT_ENV_KEYS]);
  const suspicious = Object.keys(env).filter((k) => /^(HANA_|MCP_|LOG_)/.test(k) && !known.has(k));
  if (suspicious.length > 0) {
    logger.warn(
      { keys: suspicious },
      '存在未识别的 HANA_/MCP_/LOG_ 环境变量：它们不生效（拼写错误？已改名？已移除？）',
    );
  }
}

/**
 * 档案配置自检（启动即失败，不给"以为生效其实没有"的机会）：
 * 0. **未配置 MCP_PROFILES 时也不放过显式档案名**：MCP_PROFILE 非 default、或任一 Token 带第三段
 *    → 拒绝启动（没有条目可解析，静默忽略就是"生效值 ≠ 运维以为的值"；Token 里含一个冒号的
 *    旧写法也会在此响亮失败，见 parseHttpClients）；
 * 1. 配了 MCP_PROFILES 就必须定义 `default` —— HTTP 里不带第三段的 Token 与 stdio 进程都落它，
 *    缺了会把"没指定档案"误读成"没有限制"；
 * 2. MCP_PROFILE 指向的档案必须存在；
 * 3. 每个 Token 的第三段档案必须存在。
 * （"档案 ⊆ 部署策略"的越界检查在 preflight 的 describePolicy 里，因为它需要完整策略。）
 */
function assertProfileConfig(
  profiles: Map<string, CallerProfile>,
  processProfileId: string,
  rawTokens: string,
  singleToken?: string,
): void {
  // Token 表先解析（**先于空表早退**）：它既是格式校验（含"Token 段含 : 一律失败"），
  // 也让下面的"第三段档案必须已定义"在未配置档案的部署里同样生效——否则
  // `name:<恰好含一个冒号的 Token>` 会被切成三段静默改义（Token 段截半、后半段被当档案名忽略）。
  const clients = parseHttpClients(rawTokens, singleToken);
  if (profiles.size === 0) {
    // 未配置档案：一切走隐式 default（不收紧）；但**显式写了档案名**就没有任何条目可解析，
    // 静默忽略会让"生效值 ≠ 运维以为的值"，必须响亮失败（本文件最常防的一类问题）。
    if (processProfileId !== IMPLICIT_DEFAULT_PROFILE_ID) {
      throw new Error(
        `MCP_PROFILE="${processProfileId}" 未在 MCP_PROFILES 中定义（当前未配置任何档案）：` +
          '请配置 MCP_PROFILES（并含 default 档案），或去掉 MCP_PROFILE / 改回 default',
      );
    }
    const withProfile = clients.find((c) => c.profileId !== undefined);
    if (withProfile) {
      throw new Error(
        `MCP_HTTP_TOKENS 中客户端 "${withProfile.clientId}" 指定了档案 "${withProfile.profileId}"，` +
          '但 MCP_PROFILES 未配置任何档案（无从解析）：请配置 MCP_PROFILES，或去掉 Token 的第三段；' +
          '若 Token 本身含冒号，请更换 Token（冒号已用于分隔身份与档案）',
      );
    }
    return;
  }
  if (!profiles.has(IMPLICIT_DEFAULT_PROFILE_ID)) {
    throw new Error(
      `MCP_PROFILES 未定义 default 档案：HTTP 中不带档案段的 Token 与 stdio 进程都落 default，` +
        `缺了它会让"未指定档案"变成"没有限制"。请补一条 default=<kinds>`,
    );
  }
  if (!profiles.has(processProfileId)) {
    throw new Error(
      `MCP_PROFILE="${processProfileId}" 未在 MCP_PROFILES 中定义：合法值 ${[...profiles.keys()].join(', ')}`,
    );
  }
  // Token 的档案段（只报身份名，不回显 Token）
  for (const client of clients) {
    if (client.profileId !== undefined && !profiles.has(client.profileId)) {
      throw new Error(
        `MCP_HTTP_TOKENS 中客户端 "${client.clientId}" 指定的档案 "${client.profileId}" 未在 MCP_PROFILES 中定义：` +
          `合法值 ${[...profiles.keys()].join(', ')}`,
      );
    }
  }
}

/**
 * 解析提升预算（MCP_CAPABILITY_SURFACE_MAX）：1..1000 的整数，缺省 {@link SURFACE_MAX_DEFAULT}
 * （与 hana-cli 的 `MAX_DYNAMIC_TOOLS` 同值）。越界一律启动失败——配错却静默取默认，表现为
 * "面突然被提前淘汰"，是很难查的。
 */
function parseSurfaceMax(raw: string): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new Error(
      `MCP_CAPABILITY_SURFACE_MAX 非法：应为 1..1000 的整数（当前 "${raw}"，默认 ${SURFACE_MAX_DEFAULT}）`,
    );
  }
  return n;
}

/**
 * 加载并校验配置。HANA_HOST/HANA_PORT/HANA_USER/HANA_PASSWORD 必填（无默认值），
 * 缺失或非法抛 zod 校验错误（服务启动即失败，不给半配置运行的机会）。
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): HanaConfig {
  const dotenv = tryLoadDotEnv(env);
  // 无别名层（2026-10-14）：envSchema 是唯一真值源，旧名/已删名一律不认，
  // 由 warnUnknownEnvKeys 以「未识别环境变量」告警兜住（不再做旧名归一）
  warnUnknownEnvKeys(env);
  const parsed = envSchema.parse(env);
  const profiles = parseProfiles(parsed.MCP_PROFILES);
  assertProfileConfig(profiles, parsed.MCP_PROFILE, parsed.MCP_HTTP_TOKENS, parsed.MCP_HTTP_TOKEN);

  // SQL 端口：schema 已保证非空且为纯数字，这里只做范围收口
  const port = parseInt(parsed.HANA_PORT, 10);
  if (port < 1 || port > 65535) {
    throw new Error(`无效的 SQL 端口: ${parsed.HANA_PORT}`);
  }

  // XS 端口：默认 8010（envSchema 已给默认值）。'0'/'99999' 这类越界值若放行，要到首次
  // XS REST 调用才以驱动层错误暴露，故在装载时收口；不按实例号推导（HANA_INSTANCE 已删除），
  // 非默认实例/租户由部署方用 HANA_XS_PORT 覆盖。
  const xsPort = parseInt(parsed.HANA_XS_PORT, 10);
  if (xsPort < 1 || xsPort > 65535) {
    throw new Error(`无效的 XS 端口: ${parsed.HANA_XS_PORT}`);
  }
  if (!hasValue(env.HANA_XS_PORT)) {
    // 默认值 8010 是便利不是猜测的许可证：非默认实例/租户必须显式覆盖。XS 通道是明文 HTTP，
    // 端口指错会把 HANA 账号与会话发到另一个服务——每次启动留一条可见告警。
    logger.warn(
      'HANA_XS_PORT 未配置，使用默认 8010；非默认实例/租户请显式覆盖（XS 通道为明文 HTTP，端口错误会把凭据发到错误端点）',
    );
  }

  // 将解析后的时区应用到整个进程（影响 new Date() 等本地时间语义）
  process.env.TZ = parsed.HANA_TIMEZONE;

  // 凭据生命周期：取出密码后即从进程环境移除，避免常驻 process.env 被同机进程/子进程/调试器读取
  delete process.env.HANA_PASSWORD;
  // HTTP Bearer Token 与密码同属"能触发全部工具（含写）的凭据"，同一威胁模型下一并移除：
  // 值已进 config.httpTokens 内存副本，后续判定不再读 env（服务进程内禁止重新解析 env，
  // 见 index.ts 与 preflight.policyFromConfig 的说明）
  delete process.env.MCP_HTTP_TOKEN;
  delete process.env.MCP_HTTP_TOKENS;

  // 连接目标/凭据的来源归因：多于一个来源 = 混用（如 shell 残留的 HANA_USER + .env 其余项）
  const connectionSourceMixed = new Set(Object.values(dotenv.sources)).size > 1;

  // 弃用提示（不打印任何值）：TOKEN 仍完全生效，只是提醒迁移到 TOKENS
  if (hasValue(parsed.MCP_HTTP_TOKEN)) {
    logger.warn(
      'MCP_HTTP_TOKEN 已弃用（仍生效）：它等价于 MCP_HTTP_TOKENS="shared:<token>"，' +
        '两者读入同一张 Token→身份映射表；请在下一个大版本前改用 MCP_HTTP_TOKENS',
    );
  }

  return {
    host: parsed.HANA_HOST,
    port,
    user: parsed.HANA_USER,
    password: parsed.HANA_PASSWORD,
    locale: parsed.HANA_LOCALE,
    dbName: parsed.HANA_DB_NAME,
    tls: parsed.HANA_TLS,
    sslValidate: parsed.HANA_SSL_VALIDATE,
    timezone: parsed.HANA_TIMEZONE,
    schemaAllow: parsed.HANA_READ_SCHEMA,
    writePackages: parsed.HANA_WRITE_PACKAGES,
    toolGroups: parsed.HANA_TOOL_GROUPS,
    toolAllow: parsed.HANA_TOOL_ALLOW,
    toolDeny: parsed.HANA_TOOL_DENY,
    explainSurface: parsed.HANA_EXPLAIN_SURFACE,
    profiles,
    profileId: parsed.MCP_PROFILE,
    agentLabel: parsed.MCP_AGENT_LABEL,
    surfaceMax: parseSurfaceMax(parsed.MCP_CAPABILITY_SURFACE_MAX),
    logLevel: parsed.LOG_LEVEL,
    xsPort,
    xsBasePath: parsed.HANA_XS_BASE_PATH,
    // 并发/超时旋钮（默认值来自 core/limits.js；接线处见 index.ts 的 HanaPool 构造与各调用点）
    poolMax: parsed.HANA_POOL_MAX,
    poolWaitMs: parsed.HANA_POOL_WAIT_MS,
    poolMaxWaiters: parsed.HANA_POOL_MAX_WAITERS,
    sqlTimeoutMs: parsed.HANA_SQL_TIMEOUT_MS,
    xsTimeoutMs: parsed.HANA_XS_TIMEOUT_MS,
    xsXferTimeoutMs: parsed.HANA_XS_XFER_TIMEOUT_MS,
    activationConcurrency: parsed.HANA_ACTIVATION_CONCURRENCY,
    httpPort: parsed.MCP_HTTP_PORT,
    httpHost: parsed.MCP_HTTP_HOST,
    // Token → 身份映射（MCP_HTTP_TOKENS + deprecated 别名 MCP_HTTP_TOKEN 合并进同一张表；非空即强制 Bearer 校验）
    httpTokens: parseHttpClients(parsed.MCP_HTTP_TOKENS, parsed.MCP_HTTP_TOKEN),
    httpAllowedHosts: parsed.MCP_HTTP_ALLOWED_HOSTS,
    // Origin 白名单未设置时继承 Host 白名单（默认即回环名；显式置空 = 拒绝一切带 Origin 的请求）
    httpAllowedOrigins: parsed.MCP_HTTP_ALLOWED_ORIGINS ?? parsed.MCP_HTTP_ALLOWED_HOSTS,
    httpAllowAnonymous: parsed.MCP_HTTP_ALLOW_ANONYMOUS,
    connectionSources: dotenv.sources,
    connectionSourceMixed,
  };
}
