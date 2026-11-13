/**
 * 环境参数注册表：所有可配置项的**作用域分类**单一真源。
 *
 * 为什么需要它：v2 的多环境模型按参数性质分三类——
 * - **连接参数**：多环境下只能按环境写 `HANA_<PARAM>_ENV_<XXXX>`；扁平键忽略；
 * - **策略/授权参数**：扁平静默作为所有环境的共享值；`_ENV_` 覆盖单个环境；
 * - **进程级参数**：只能扁平写；写 `_ENV_` 启动失败。
 *
 * 分类不只是文档：`environment-config.ts` 用它解析 `_ENV_` 键，测试用它做
 * “注册表参数 ⊆ CONFIG.md 参数表”的漂移校验。新增参数必须同时登记在这里。
 */

/** 参数作用域 */
export type ParamScope = 'connection' | 'policy' | 'process' | 'governance';

/** 进程级参数的子分组（仅用于文档/启动摘要） */
export type ProcessGroup = 'capability' | 'runtime' | 'governance';

export interface ParamSpec {
  /** 参数名（`_ENV_` 前缀的一部分，如 HOST、WRITE_PACKAGES） */
  name: string;
  /** 完整环境变量名（如 HANA_HOST、MCP_HTTP_PORT） */
  envVar: string;
  scope: ParamScope;
  /** 进程级子分组；非进程级参数不填 */
  processGroup?: ProcessGroup;
  /** 多环境下连接参数是否必填（无内置默认） */
  requiredInMultiEnv?: boolean;
  /** 敏感值（密码等），错误信息与日志不得回显 */
  secret?: boolean;
  /** 内置默认值（文档用；实际解析在 config.ts / environment-config.ts） */
  defaultValue?: string;
  /** 中文说明（CONFIG.md 与启动摘要复用） */
  description: string;
}

export const PARAM_REGISTRY: readonly ParamSpec[] = [
  // ── 连接参数：多环境下只能 _ENV_<XXXX> ──
  {
    name: 'HOST',
    envVar: 'HANA_HOST',
    scope: 'connection',
    requiredInMultiEnv: true,
    description: 'HANA 主机名/IP',
  },
  {
    name: 'PORT',
    envVar: 'HANA_PORT',
    scope: 'connection',
    requiredInMultiEnv: true,
    description: 'SQL 端口（纯数字）',
  },
  {
    name: 'USER',
    envVar: 'HANA_USER',
    scope: 'connection',
    requiredInMultiEnv: true,
    description: '数据库账号',
  },
  {
    name: 'PASSWORD',
    envVar: 'HANA_PASSWORD',
    scope: 'connection',
    requiredInMultiEnv: true,
    secret: true,
    description: '数据库密码；加载后从 process.env 删除',
  },
  {
    name: 'DB_NAME',
    envVar: 'HANA_DB_NAME',
    scope: 'connection',
    description: '租户数据库名（MDC 租户）',
  },
  {
    name: 'TLS',
    envVar: 'HANA_TLS',
    scope: 'connection',
    defaultValue: 'true',
    description: 'SQL 连接 TLS（fail-closed，默认 true）',
  },
  {
    name: 'SSL_VALIDATE',
    envVar: 'HANA_SSL_VALIDATE',
    scope: 'connection',
    defaultValue: 'true',
    description: 'TLS 证书校验（默认 true）',
  },
  {
    name: 'LOCALE',
    envVar: 'HANA_LOCALE',
    scope: 'connection',
    defaultValue: 'zh',
    description: '连接 Locale',
  },
  {
    name: 'XS_PORT',
    envVar: 'HANA_XS_PORT',
    scope: 'connection',
    defaultValue: '8010',
    description: 'XS Classic 设计时 REST 端口',
  },
  {
    name: 'XS_TLS',
    envVar: 'HANA_XS_TLS',
    scope: 'connection',
    defaultValue: 'false',
    description: 'XS 写通道走 HTTPS',
  },
  {
    name: 'XS_BASE_PATH',
    envVar: 'HANA_XS_BASE_PATH',
    scope: 'connection',
    defaultValue: '/sap/hana/xs/dt/base',
    description: 'XS 设计时 REST 基础路径',
  },

  // ── 策略/授权参数：扁平 = 所有环境共享；_ENV_ = 覆盖单个环境 ──
  {
    name: 'ACCESS',
    envVar: 'HANA_ACCESS',
    scope: 'policy',
    defaultValue: 'readwrite',
    description: '环境只读/可写策略（readwrite / readonly）',
  },
  {
    name: 'READONLY_SQL',
    envVar: 'HANA_READONLY_SQL',
    scope: 'policy',
    defaultValue: 'select-only',
    description: '只读环境的 SQL 策略（select-only / deny）',
  },
  {
    name: 'WRITE_PACKAGES',
    envVar: 'HANA_WRITE_PACKAGES',
    scope: 'policy',
    defaultValue: '',
    description: '允许写操作的仓库包前缀；空 = 无写包',
  },
  {
    name: 'READ_SCHEMA',
    envVar: 'HANA_READ_SCHEMA',
    scope: 'policy',
    defaultValue: '',
    description: '追加允许按名读取的 schema',
  },
  {
    name: 'SQL_TIMEOUT_MS',
    envVar: 'HANA_SQL_TIMEOUT_MS',
    scope: 'policy',
    defaultValue: '60000',
    description: '写路径 SQL 语句超时（ms）',
  },
  {
    name: 'SQL_ALLOW_MULTI_STATEMENT',
    envVar: 'HANA_SQL_ALLOW_MULTI_STATEMENT',
    scope: 'policy',
    defaultValue: 'false',
    description: 'hana_sql_execute 多行/多语句开关',
  },
  {
    name: 'SQL_MAX_RESULT_BYTES',
    envVar: 'HANA_SQL_MAX_RESULT_BYTES',
    scope: 'policy',
    defaultValue: '1000000',
    description: '单次 SQL 结果字节上限',
  },
  {
    name: 'SQL_MAX_STATEMENTS',
    envVar: 'HANA_SQL_MAX_STATEMENTS',
    scope: 'policy',
    defaultValue: '20',
    description: '单次调用 SQL 语句条数上限',
  },
  {
    name: 'XS_TIMEOUT_MS',
    envVar: 'HANA_XS_TIMEOUT_MS',
    scope: 'policy',
    defaultValue: '30000',
    description: 'XS REST 请求超时（ms）',
  },
  {
    name: 'XS_XFER_TIMEOUT_MS',
    envVar: 'HANA_XS_XFER_TIMEOUT_MS',
    scope: 'policy',
    defaultValue: '300000',
    description: 'XS 传输（xfer）超时（ms）',
  },
  {
    name: 'POOL_MAX',
    envVar: 'HANA_POOL_MAX',
    scope: 'policy',
    defaultValue: '4',
    description: '每环境连接池上限',
  },
  {
    name: 'POOL_WAIT_MS',
    envVar: 'HANA_POOL_WAIT_MS',
    scope: 'policy',
    defaultValue: '30000',
    description: '池排队等待超时（ms）',
  },
  {
    name: 'POOL_MAX_WAITERS',
    envVar: 'HANA_POOL_MAX_WAITERS',
    scope: 'policy',
    defaultValue: '64',
    description: '池排队上限',
  },

  // ── 进程级 · 能力面 ──
  {
    name: 'TOOL_GROUPS',
    envVar: 'HANA_TOOL_GROUPS',
    scope: 'process',
    processGroup: 'capability',
    description: '启用的工具功能分组',
  },
  {
    name: 'TOOL_ALLOW',
    envVar: 'HANA_TOOL_ALLOW',
    scope: 'process',
    processGroup: 'capability',
    description: '强制启用的工具名/组名 glob',
  },
  {
    name: 'TOOL_DENY',
    envVar: 'HANA_TOOL_DENY',
    scope: 'process',
    processGroup: 'capability',
    description: '强制禁用的工具名/组名 glob',
  },
  {
    name: 'EXPLAIN_SURFACE',
    envVar: 'HANA_EXPLAIN_SURFACE',
    scope: 'process',
    processGroup: 'capability',
    description: '工具面省略说明的调试开关',
  },
  {
    name: 'CAPABILITY_SURFACE_MAX',
    envVar: 'MCP_CAPABILITY_SURFACE_MAX',
    scope: 'process',
    processGroup: 'capability',
    description: '单调用方提升预算（按工具数）',
  },
  {
    name: 'PROFILES',
    envVar: 'MCP_PROFILES',
    scope: 'process',
    processGroup: 'capability',
    description: '调用方档案表（只能在部署策略内收紧）',
  },
  {
    name: 'PROFILE',
    envVar: 'MCP_PROFILE',
    scope: 'process',
    processGroup: 'capability',
    description: 'stdio / 无档案身份的默认档案名',
  },

  // ── 进程级 · 部署/运行时 ──
  {
    name: 'LOG_LEVEL',
    envVar: 'LOG_LEVEL',
    scope: 'process',
    processGroup: 'runtime',
    description: '进程日志级别',
  },
  {
    name: 'TIMEZONE',
    envVar: 'HANA_TIMEZONE',
    scope: 'process',
    processGroup: 'runtime',
    description: '进程时区（设置 TZ）',
  },
  {
    name: 'AGENT_LABEL',
    envVar: 'MCP_AGENT_LABEL',
    scope: 'process',
    processGroup: 'runtime',
    description: '进程级归因标签',
  },
  {
    name: 'ACTIVATION_CONCURRENCY',
    envVar: 'HANA_ACTIVATION_CONCURRENCY',
    scope: 'process',
    processGroup: 'runtime',
    description: '进程内激活并发上限（全局信号量）',
  },
  {
    name: 'HTTP_PORT',
    envVar: 'MCP_HTTP_PORT',
    scope: 'process',
    processGroup: 'runtime',
    description: 'Streamable HTTP 端口；未设置 = stdio',
  },
  {
    name: 'HTTP_HOST',
    envVar: 'MCP_HTTP_HOST',
    scope: 'process',
    processGroup: 'runtime',
    description: 'HTTP 监听地址',
  },
  {
    name: 'HTTP_TOKEN',
    envVar: 'MCP_HTTP_TOKEN',
    scope: 'process',
    processGroup: 'runtime',
    secret: true,
    description: 'HTTP Bearer Token（已废弃，等价 shared）',
  },
  {
    name: 'HTTP_TOKENS',
    envVar: 'MCP_HTTP_TOKENS',
    scope: 'process',
    processGroup: 'runtime',
    secret: true,
    description: 'HTTP Token → 身份映射',
  },
  {
    name: 'HTTP_CLIENT_ENVS',
    envVar: 'MCP_HTTP_CLIENT_ENVS',
    scope: 'process',
    processGroup: 'runtime',
    description: 'HTTP 身份 → 环境标识绑定',
  },
  {
    name: 'HTTP_ALLOWED_HOSTS',
    envVar: 'MCP_HTTP_ALLOWED_HOSTS',
    scope: 'process',
    processGroup: 'runtime',
    description: '允许的 Host 头主机名',
  },
  {
    name: 'HTTP_ALLOWED_ORIGINS',
    envVar: 'MCP_HTTP_ALLOWED_ORIGINS',
    scope: 'process',
    processGroup: 'runtime',
    description: '允许的 Origin 主机名',
  },
  {
    name: 'HTTP_ALLOW_ANONYMOUS',
    envVar: 'MCP_HTTP_ALLOW_ANONYMOUS',
    scope: 'process',
    processGroup: 'runtime',
    description: '显式承认对外监听且无认证的风险',
  },

  // ── 进程级 · 环境治理 ──
  {
    name: 'ENV_MODE',
    envVar: 'HANA_ENV_MODE',
    scope: 'governance',
    processGroup: 'governance',
    description: '模式判断：single / multi（可选，默认自动判断）',
  },
  {
    name: 'ENV_START',
    envVar: 'HANA_ENV_START',
    scope: 'governance',
    processGroup: 'governance',
    description: '启动环境标识',
  },
  {
    name: 'ENV_SWITCHABLE',
    envVar: 'HANA_ENV_SWITCHABLE',
    scope: 'governance',
    processGroup: 'governance',
    description: '可切换环境标识列表',
  },
  {
    name: 'ENV_INHERIT',
    envVar: 'HANA_ENV_INHERIT',
    scope: 'governance',
    processGroup: 'governance',
    description: '兼容模式开关；本版仅支持 strict（legacy 未实现）',
  },
];

export const CONNECTION_PARAMS = PARAM_REGISTRY.filter((p) => p.scope === 'connection');
export const POLICY_PARAMS = PARAM_REGISTRY.filter((p) => p.scope === 'policy');
export const PROCESS_PARAMS = PARAM_REGISTRY.filter((p) => p.scope === 'process' || p.scope === 'governance');

/** 参数名 → 注册项（大小写敏感；`_ENV_` 解析按注册表名精确匹配） */
export const PARAM_BY_NAME = new Map(PARAM_REGISTRY.map((p) => [p.name, p]));

/** 完整环境变量名 → 注册项 */
export const PARAM_BY_ENV_VAR = new Map(PARAM_REGISTRY.map((p) => [p.envVar, p]));
