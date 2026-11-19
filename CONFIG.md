# 配置与权限

> 本文是 [README.md](README.md) 的详细配置参考：连接参数、工具分组、调用方档案、传输方式、安全边界与 HANA 授权要求。

## 必填参数（单环境 / 多环境）

| 参数 | 单环境 | 多环境 |
| --- | --- | --- |
| `HANA_HOST` / `HANA_PORT` | 扁平键，必填 | `HANA_HOST_ENV_<XXXX>` / `HANA_PORT_ENV_<XXXX>`，每个环境必填 |
| `HANA_USER` / `HANA_PASSWORD` | 扁平键，必填 | `HANA_USER_ENV_<XXXX>` / `HANA_PASSWORD_ENV_<XXXX>`，每个环境必填 |

单环境缺失必填项、或多环境某个环境解析不到 `HOST/PORT/USER/PASSWORD`，服务均**启动即失败**。
多环境**不使用扁平连接键**（会被忽略），见下方《参数作用域与完整参数表（单环境 / 多环境）》与《多 HANA 环境》。

连接信息只允许来自环境变量 / `mcp.json` 的 `env`（**仅 stdio 模式生效**）/ `.env` 文件（单环境），
不提供默认值；多环境**完全不读 `.env`**。

`HANA_XS_PORT`（XS 设计时 REST 端口）**非必填，默认 8010**；非默认实例/租户请显式覆盖：
单环境用 `HANA_XS_PORT`，多环境用 `HANA_XS_PORT_ENV_<XXXX>`。

## 配置来源

| 运行方式 | 配置实际来源 |
| --- | --- |
| **stdio**（MCP 客户端拉起进程） | 客户端 `mcp.json` 的 `env` 由客户端注入为子进程环境变量 → 等价于环境变量；凭据三件套（`HANA_HOST`+`HANA_USER`+`HANA_PASSWORD`）齐全时 **不再读 `.env`** |
| **Streamable HTTP**（自行 `npm start` / 容器启动） | 没有客户端拉起进程，**`mcp.json` 不参与**；来源为 shell/容器环境变量 → 兜底 `.env` |

`.env` 查找顺序为 **工作目录 → 项目根**（`dist/` 上两级），且**逐变量生效**——`process.loadEnvFile` 不覆盖已存在的环境变量。因此三件套只有一部分来自外部环境时会跨来源混用（典型：shell 里残留的 `HANA_USER` 覆盖 `.env` 中的用户名，其余仍取 `.env`），可能连接到另一套环境。服务检测到连接目标/凭据来自多个来源时，会在启动日志 **warn** 并列出每个变量的来源，请据此清理多余的环境变量。

## 参数作用域与完整参数表（单环境 / 多环境）

多环境模型按参数性质分三类；**扁平键的含义取决于模式**：

- **单环境**（没有任何 `_ENV_` 变量）：扁平 `HANA_*` 就是唯一环境的配置。
- **多环境**（出现任意**已识别参数**的 `_ENV_` 变量）：
  - **连接参数**：扁平键**忽略**（不参与解析）；只能 `HANA_<PARAM>_ENV_<XXXX>`；
  - **策略/授权参数**：扁平键 = 所有环境共享；`_ENV_<XXXX>` 覆盖单个环境；
  - **进程级参数**：只能扁平写；写 `_ENV_` 启动失败。

**「扁平键」指不带环境后缀的普通变量名，「`_ENV_` 键」指 `HANA_<参数>_ENV_<环境标识>`。** 以 `HANA_HOST` 为例：

- 单环境（扁平键）：`HANA_HOST=hana-dev.example`
- 多环境（`_ENV_` 键）：`HANA_HOST_ENV_DEV=hana-dev.example`、`HANA_HOST_ENV_PROD=hana-prod.example`

表中的「单环境」表示该参数**直接按扁平键读取**：「生效（必填）」= 单环境下必须提供；「生效（可选）」= 可不填（使用默认值或不启用）。多环境列：「必填」= 每个环境必须提供；「可选」= 可不写（使用默认值/共享值）；「不可用」= 该形式启动失败。

| 参数 | 说明 | 默认 | 示例 | 类别 | 单环境（扁平键） | 多环境下的扁平键（如 `HANA_HOST`） | 多环境下的 _ENV_ 键（如 `HANA_HOST_ENV_DEV`） |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `HANA_HOST` | HANA 主机名/IP | — | `hana-host.example` | 连接 | 生效（必填） | 忽略（不生效） | 必填 |
| `HANA_PORT` | SQL 端口（纯数字；不再由实例号推导） | — | `31015` | 连接 | 生效（必填） | 忽略（不生效） | 必填 |
| `HANA_USER` | 数据库账号 | — | — | 连接 | 生效（必填） | 忽略（不生效） | 必填 |
| `HANA_PASSWORD` | 数据库密码；加载后从 process.env 删除 | — | — | 连接 | 生效（必填） | 忽略（不生效） | 必填 |
| `HANA_DB_NAME` | 租户数据库名（MDC 指定租户时填写；非 MDC 可省略） | — | `SYSTEMDB` / 业务租户名 | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_TLS` | SQL 连接 TLS（fail-closed，默认 true；仅可信链路显式 false） | true | `true` | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_SSL_VALIDATE` | TLS 证书校验（默认 true；自签证书环境显式 false） | true | `true` | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_LOCALE` | 连接 Locale | zh | `zh` | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_XS_PORT` | XS Classic 设计时 REST 端口（非默认实例/租户需覆盖，不按实例号推导） | 8010 | `8000` | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_XS_TLS` | XS 写通道走 HTTPS（默认明文 http://，须网络侧隔离） | false | `true` | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_XS_BASE_PATH` | XS 设计时 REST 基础路径 | /sap/hana/xs/dt/base | — | 连接 | 生效（可选） | 忽略（不生效） | 可选 |
| `HANA_WRITE_PACKAGES` | 允许写操作的仓库包前缀；**非空 = readwrite，空 = readonly**；`_ENV_` 显式空 = 该环境只读 | 空 | `ZDEMO1,ZDEMO2.ZDEMO_SD` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_READ_SCHEMA` | 追加允许按名读取的 schema；空 = 仅系统 schema | 空 | `SAPABAP1,OTHER_SCHEMA` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_SQL_TIMEOUT_MS` | 写路径 SQL 语句超时（ms） | 60000 | `120000` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_SQL_ACCESS` | `hana_sql_execute` 的访问模式：`select-only`（默认）/ `readwrite`；对象级 schema/对象访问由 HANA 账号决定 | select-only | `readwrite` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_SQL_ALLOW_MULTI_STATEMENT` | hana_sql_execute 多行/多语句开关（有写时自动事务） | false | `true` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_SQL_MAX_RESULT_BYTES` | 单次 SQL 结果字节上限（1024..52428800） | 1000000 | `2000000` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_SQL_MAX_STATEMENTS` | 单次调用 SQL 语句条数上限（最大 100） | 20 | `50` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_XS_TIMEOUT_MS` | XS REST 请求超时（ms） | 30000 | `60000` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_XS_XFER_TIMEOUT_MS` | XS 传输（xfer）超时（ms） | 300000 | `600000` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_POOL_MAX` | 每环境连接池上限 | 4 | `8` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_POOL_WAIT_MS` | 池排队等待超时（ms） | 30000 | `60000` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_POOL_MAX_WAITERS` | 池排队上限 | 64 | `128` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_TOOL_GROUPS` | 启用的工具**组名或能力 glob**（同一列表）；空 = read/write/admin，sql 默认关闭 | — | `read` / `read,hana_sql_execute` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_TOOL_DENY` | 强制禁用的工具名/组名 glob（优先级最高） | — | `hana_data_preview*` | 策略/授权 | 生效（可选） | 共享（所有环境） | 可选（覆盖单个环境） |
| `HANA_TOOL_SEARCH_GOAL` | 是否启用 `hana_tool_search` 的 goal 模式（配方） | on | `off` | 进程级·能力面 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_PROFILES` | 调用方档案表（只能收紧部署策略；配了必须定义 default） | — | `analyst=read;dev=read+write:hana_view_*;default=read` | 进程级·能力面 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_PROFILE` | stdio / 无档案身份的默认档案名 | — | `default` | 进程级·能力面 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `LOG_LEVEL` | 进程日志级别（默认 info） | — | `debug` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `HANA_TIMEZONE` | 进程时区（设置 TZ；不下发 HANA 会话） | — | `Asia/Shanghai` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_AGENT_LABEL` | 进程级归因标签 | — | `prod-cn-01` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `HANA_ACTIVATION_CONCURRENCY` | 进程内激活并发上限（默认 2，全局信号量） | — | `4` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_PORT` | Streamable HTTP 端口；未设置 = stdio；`0` = 随机端口 | — | `3000` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_HOST` | HTTP 监听地址（默认 127.0.0.1，fail-closed） | — | `0.0.0.0` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_TOKEN` | HTTP Bearer Token（已废弃，等价 `shared`） | — | — | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_TOKENS` | HTTP Token → 身份映射（token ≥16 字符且不得含冒号） | — | `alice:<token>:dev,bob:<token>` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_CLIENT_ENVS` | HTTP 身份 → 环境标识绑定（多环境 HTTP 必填，仅 HTTP 模式） | — | `alice:PRD_CN,bob:PRD_EU` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_ALLOWED_HOSTS` | 允许的 Host 头主机名（默认仅本机名） | — | `localhost,myhost.corp` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_ALLOWED_ORIGINS` | 允许的 Origin 主机名（未设置时继承 `MCP_HTTP_ALLOWED_HOSTS`） | — | `localhost` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `MCP_HTTP_ALLOW_ANONYMOUS` | 显式承认对外监听且无认证的风险 | — | `false` | 进程级·运行时 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `HANA_ENV_MODE` | 模式判断：single / multi（可选，默认自动判断） | — | `multi` | 进程级·治理 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `HANA_ENV_START` | 启动环境标识 | — | `DEV` | 进程级·治理 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `HANA_ENV_SWITCHABLE` | 可切换环境标识列表（逗号分隔；空 = 不可切） | — | `DEV,UAT,PROD` | 进程级·治理 | 生效（可选） | 仅进程级 | 不可用（启动报错） |
| `HANA_ENV_INHERIT` | 兼容模式开关；**本版仅支持 strict** | — | — | 进程级·治理 | 生效（可选） | 仅进程级 | 不可用（启动报错） |

## 多 HANA 环境（单进程、单 active）

默认是单环境，**不需要任何 `_ENV_` 变量**。出现**已识别参数**的 `HANA_<PARAM>_ENV_<XXXX>` 才进入多环境模式；
无法识别的 `_ENV_` 键按按需读取直接忽略（不会把单环境拖入多环境）。`HANA_ENV_START` / `HANA_ENV_SWITCHABLE`
不触发多环境；可用 `HANA_ENV_MODE=single|multi` 显式声明，与自动判断不一致时启动失败。

### 规则

- **键与作用域**：见上方《参数作用域与完整参数表》。简言之：连接参数只能按环境写 `HANA_<PARAM>_ENV_<XXXX>`
  （扁平键忽略，`HOST/PORT/USER/PASSWORD` 每个环境必填）；策略参数扁平写 = 所有环境共享、`_ENV_` 覆盖单个环境
  （`HANA_WRITE_PACKAGES_ENV_<XXXX>=` 显式空 = 该环境无写包）；进程级参数只能扁平写，写 `_ENV_` 启动失败
  （`process_param_scoped`）。
- **环境标识** = `_ENV_<XXXX>` 的 `<XXXX>`，大小写不敏感，内部规范化为大写。`HANA_ENV_START` /
  `HANA_ENV_SWITCHABLE` / `hana_env_switch` 的 `to`/`from`/`confirm` / `MCP_HTTP_CLIENT_ENVS` /
  `expectedEnvironment` 都用它；回执与审计显示大写形式。
- **环境集合** = 所有已识别参数的 `_ENV_` 键的 `<XXXX>`；`HANA_ENV_START` 必须是其中之一（只有一个环境时可省略）；
  `HANA_ENV_SWITCHABLE` 只接受环境标识，仅大小写不同的重复项失败。
- **只读环境**（`HANA_WRITE_PACKAGES` 为空）：只拒绝持久写入（清单 `effects.mutates='persistent'`）；临时对象（节点预览
  中间视图、`_CHKTMP`）与纯读放行。启用 `sql` 组时只允许 SELECT 类（拒绝 `FOR UPDATE` / `FOR SHARE` /
  `NEXTVAL`）；要完全关闭 SQL，不把 `sql` 写进 `HANA_TOOL_GROUPS`。**单环境同样生效**。
- **expectedEnvironment + expectedEpoch（调用信封）**：多环境下**所有**调用都必须带当前环境标识**与代际**；统一写成 `hana_invoke({ capability, args, expectedEnvironment: { key, epoch } })`（或回传 `contextToken`）。旧调用把 `expectedEnvironment`/`expectedEpoch` 放在 `args` 里仍兼容（入口会剥出）。只有环境名挡不住 DEV 4 → PRD 5 → DEV 6 的旧披露。
  披露上下文 `disclosure: { id?, policyRev?, manifestRev? }` 只做一致性检查；`policyRev`/`manifestRev` 不匹配 → `policy_stale`/`manifest_stale`。
- **切换**：`hana_env_list` 发放一次性 `switchToken`（仅 stdio 且 switch 可达）；`hana_env_switch` 是 route-only、
  HTTP 拒绝且不进索引；只影响之后的调用，已提交任务与在途调用仍绑定原环境；旧环境有运行中任务时进入
  `task-draining`，任务/调用结束后回 `idle`；切换前会预检目标连接，目标有运行中任务时需
  `acknowledgeRunningTasks=true`。
- **清理与共享**：`HANA_LABEL` / `HANA_LABEL_ENV_*` / 旧前缀 `HANA_ENV_<NAME>_*` / JSON/YAML 配置文件均不支持
  （单环境残留 `HANA_LABEL` 静默忽略，多环境出现即 `label_removed`）；加载后 `HANA_PASSWORD` 与所有
  `HANA_PASSWORD_ENV_*` 从 `process.env` 删除；同一物理库（`host:port/dbName`）的多个环境标识共享对象锁、
  临时校验登记与预览占用。

### 示例（三个环境）

```dotenv
# 连接参数：每个环境自己写（多环境下扁平 HANA_HOST 等会被忽略）
HANA_HOST_ENV_DEV=hana-dev.example
HANA_PORT_ENV_DEV=30015
HANA_USER_ENV_DEV=DEV_USER
HANA_PASSWORD_ENV_DEV=***
HANA_TLS_ENV_DEV=false

HANA_HOST_ENV_UAT=hana-uat.example
HANA_PORT_ENV_UAT=30015
HANA_USER_ENV_UAT=UAT_USER
HANA_PASSWORD_ENV_UAT=***

HANA_HOST_ENV_PROD=hana-prod.example
HANA_PORT_ENV_PROD=30015
HANA_USER_ENV_PROD=PROD_USER
HANA_PASSWORD_ENV_PROD=***

# 策略/授权：扁平 = 所有环境共享；_ENV_ 覆盖单个环境
# 能力面可以按环境不同（多环境 = 多个单环境）
HANA_TOOL_GROUPS_ENV_DEV=read,write
HANA_TOOL_GROUPS_ENV_PROD=read
HANA_TOOL_DENY_ENV_PROD=hana_view_delete
# 写包非空 = readwrite，空 = readonly
HANA_WRITE_PACKAGES_ENV_DEV=ZDEMO
HANA_READ_SCHEMA=SHARED_SCHEMA

# 启动/可切列表用环境标识（大小写不敏感）
HANA_ENV_START=DEV
HANA_ENV_SWITCHABLE=DEV,UAT,PROD
```

如果环境间共用同一端口/账号，也没有“默认继承”：要么各自写 `_ENV_`，要么把策略键写成扁平共享值
（连接参数不能共享）。

### `.env` 加载规则

`.env` 只在**启动时进程环境还缺少配置**时作为回退读取；它是逐变量补充，不覆盖已有键。

**何时读**（进程环境 = `mcp.json` 的 `env` / shell / 容器注入；启动时按顺序判断）：

1. 已有任一**已识别参数**的 `_ENV_` 键 → **不读 `.env`**。
2. 否则 `HANA_HOST` + `HANA_USER` + `HANA_PASSWORD` 都非空 → **不读 `.env`**。
3. 否则读取：先 `<工作目录>/.env`，再 `<项目根>/.env`。

**怎么读**：

- 用 `process.loadEnvFile` 加载；它**不覆盖**进程环境里已存在的键，只补缺失项。
- 每加载完一个文件检查一次扁平凭据三件套；三件套齐全就停止，不再加载下一个文件。
- 加载结束后，配置解析看到的是“进程环境 + `.env` 补充”的合并结果。

**边界**：

- 多环境配置可以完全写在 `.env` 里；此时进程环境没有 `_ENV_` 键，`.env` 是唯一来源。
- 进程环境已有 `_ENV_` 键时，`.env` 整个被跳过；即使 `.env` 里还有其它环境键也不会补进来。
- 进程环境只有扁平策略键（如 `HANA_WRITE_PACKAGES`）而没有 `_ENV_` 键时，`.env` 仍会加载，可能出现“策略来自进程环境、连接来自 `.env`”的混源；多环境建议把连接与策略放在同一来源。
- 多环境从 `.env` 加载且三件套始终不齐时，会继续尝试项目根 `.env`；两个文件的键按“先加载者优先”合并，建议只保留一个多环境 `.env`。

## 工具分组与可见性控制

业务能力按功能划分为四个业务组；另有独立的 `sql` 组。**注册面上恒有两个平台入口**：`hana_tool_search`（选择）与 `hana_invoke`（执行）——具体能力经本体层发现/披露后执行（见 README「工具面」）。`hana_sql_execute` 不再是常驻工具：显式启用 `sql` 组后经 `hana_tool_search` 发现、由 `hana_invoke` 执行；关闭时对模型完全不可见。可见性配置管的是**可触达上限**（哪些能力可被发现、可被执行）。

| 分组 | 说明 | 能力 |
| --- | --- | --- |
| **read** 数据读取 | 访问 HANA 数据/元数据/系统信息与异步任务状态，不改动仓库 | `hana_system_get_info`、`hana_check_privileges`、`hana_package_list`、`hana_package_list_objects`、`hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used`、`hana_table_list`、`hana_table_columns`、`hana_data_preview`、`hana_data_preview_diagnose`、`hana_task_get`（多环境另含 `hana_env_list`） |
| **write** 写操作 | 改动仓库设计时对象/包、接受任意 SQL 的分析、取消异步任务 | `hana_package_create`、`hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions`、`hana_sql_analyze`、`hana_task_cancel` |
| **admin** 管理操作 | Transfer / Change-Tracking API 与系统监视面 | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist`、`hana_system_health`、`hana_system_activity`、`hana_table_storage`、`hana_system_trend`（多环境另含 route-only `hana_env_switch`） |
| **sql** 直接执行（**默认关闭**） | 在 HANA 上直接执行任意 SQL（读/写/管理类）。**空 `HANA_TOOL_GROUPS` 不会启用它**；须显式把 `sql`（或 `hana_sql_execute`）写进 `HANA_TOOL_GROUPS`。未启用时它不可发现、不可披露、不可执行 | `hana_sql_execute` |

> 分组（kind）是**权限层级**而非"行为画像"：稳定性诊断四件套、`hana_repo_changelist` 行为只读但归 admin；`hana_sql_analyze` 接受任意 SQL 但归 write。客户端注解（`readOnlyHint`）描述行为，两者不互相推导。**环境副作用另由清单的 `effects.mutates` 表达**（`none` / `transient` / `persistent`），不按 kind 推断。
> `hana_view_validate` design 模式会短暂写入 `_CHKTMP` 临时对象，故整工具归 write；其环境口径是 `transient`（只读环境放行）。
> **只有一个权限层——能力层**：两个平台入口在任何分组配置下都常驻 `tools/list`，但只能发现/执行当前 entitlement 内的能力。分组开关决定的是**可发现/可执行的集合**；`hana_invoke` 的授权、schema 与预检一律按**目标能力**判。

### 权限参数（4 个 + SQL 模式）

| 参数 | 管什么 | 缺省/空值 |
| --- | --- | --- |
| `HANA_TOOL_GROUPS` | 能力可见性：组名（`read`/`write`/`admin`/`sql`）或能力 id/glob，逗号分隔；两者可混写 | 空 = read/write/admin（**sql 关闭**） |
| `HANA_TOOL_DENY` | 强制禁用能力/组（优先级最高） | 空 = 不禁用 |
| `HANA_WRITE_PACKAGES` | 可写仓库包前缀；**非空 = readwrite，空 = readonly** | 空 = 只读 |
| `HANA_READ_SCHEMA` | 按名可读 schema（系统 schema 恒可读） | 空 = 仅系统 schema |
| `HANA_SQL_ACCESS` | SQL 直接执行的访问模式：`select-only`（默认）/ `readwrite`；`sql` 组只管可见性 | select-only |

**作用域**：以上 5 个参数都支持 `_ENV_<KEY>` 覆盖（扁平 = 所有环境共享）。多环境下 entitlement（`hana_tool_search` 的候选/契约与 `hana_invoke` 的执行判定）按**当前绑定环境**编译，等价于“多环境 = 多个单环境”。

**推导项与固定项**：

- **只读/可写（非 SQL 能力）**：由 `HANA_WRITE_PACKAGES` 是否为空推导。空 = 只拦 `persistent`，`transient` 与纯读放行。
- **SQL 模式**：由 `HANA_SQL_ACCESS` 独立决定，**与全局写包无关**。`select-only` 只允许 SELECT 类；`readwrite` 才允许 DML/DDL/管理类。对象级 schema/对象访问由 HANA 账号权限决定。
- **审批**：`effects.destructive=true` 的能力在策略放行后**固定**走一次人工确认（`input_required`），不再可配。
- **档案**：`MCP_PROFILES` / `MCP_PROFILE` 仍是可选高级项；档案只能在上述参数范围内收紧。

**已移除、忽略（不生效）**：`HANA_ACCESS`、`HANA_READONLY_SQL`、`HANA_APPROVAL`、`HANA_TOOL_ALLOW`、`MCP_POLICY`（含策略类 `_ENV_` 变体）。出现时只记一条启动 warn，不阻断启动。

配置优先级：`HANA_TOOL_DENY` > `HANA_TOOL_GROUPS`（显式列出的组/能力）> 默认 read/write/admin。
`HANA_TOOL_GROUPS` 里的非组名 token 按**能力 id/glob** 处理；拼错只会匹配不到能力，不会阻断启动。

### 典型部署

- **只读分析师**：`HANA_TOOL_GROUPS=read`，不设 `HANA_WRITE_PACKAGES`（或显式空）。
- **建模开发者**：`HANA_TOOL_GROUPS=read,write` + `HANA_WRITE_PACKAGES=ZDEMO`。
- **需要直接执行 SQL**：`HANA_TOOL_GROUPS=read,write,admin,sql`（或直接写 `hana_sql_execute`）；
  **默认 `HANA_SQL_ACCESS=select-only`（只允许 SELECT 类）**；需要 SQL 写时显式设 `HANA_SQL_ACCESS=readwrite`
  （对象级仍由 HANA 账号权限约束）。
- **关闭特定能力**：`HANA_TOOL_DENY=hana_view_delete` —— 发现、契约与执行都够不着。
- **只读但保留校验/分析**：`HANA_TOOL_GROUPS=read,write` + 空写包；`hana_view_validate`（transient）与
  `hana_sql_analyze`（mutates=none）仍可用，`hana_view_update/delete` 等 persistent 被拒。
- **平台入口**：`hana_tool_search` / `hana_invoke` 不绑 read 分组；未显式 deny ∧ 至少一个具体能力可见时即常驻。

### 直接执行 HANA SQL（hana_sql_execute）

`sql` 组默认关闭：未显式启用时该工具对模型**完全不可见**（不注册、不进索引/描述）。启用方式：
`HANA_TOOL_GROUPS` 加 `sql`（如 `read,write,admin,sql`），或直接写 `hana_sql_execute`；
`HANA_TOOL_DENY` 优先级最高。它是独立分类 `sql` 的能力，启用后经 `hana_tool_search` 发现、由
`hana_invoke` 执行，**不直接出现在 `tools/list`**。

**语句分类与权限**

| 类别 | 典型语句 | 默认行为 | 权限/控制 |
|---|---|---|---|
| 查询 `read` | `SELECT`、`WITH ... SELECT` | 允许 | 始终允许 SELECT 类；`FOR UPDATE` / `FOR SHARE` / `NEXTVAL` 拒绝。对象权限由 HANA 账号决定 |
| 写数据 `dml` | `INSERT` / `UPDATE` / `DELETE` / `UPSERT` / `MERGE` | 拒绝 | 仅 `HANA_SQL_ACCESS=readwrite` 允许；数据库账号权限 |
| DDL | `CREATE` / `ALTER` / `DROP` / `TRUNCATE` / `RENAME` / `COMMENT`（非 USER/REMOTE/SYSTEM） | 拒绝 | 仅 `HANA_SQL_ACCESS=readwrite` 允许；DDL 可能隐式提交 |
| 管理/调用 | `CALL` / `GRANT` / `REVOKE` / `ALTER SYSTEM` / `RECONFIGURE` / `IMPORT` / `EXPORT` / `EXECUTE`、`CREATE/ALTER/DROP USER、REMOTE、SYSTEM` | 拒绝 | 仅 `HANA_SQL_ACCESS=readwrite` 允许；数据库账号权限 |
| 事务控制 | `BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE` / `SET TRANSACTION` | 拒绝 | 规则层硬拒绝：连接池跨调用无法保证事务原子性 |
| 会话状态 | `SET ...`（非 `SET TRANSACTION`） | 拒绝 | 规则层硬拒绝：会污染连接池后续调用 |
| 执行计划 | `EXPLAIN ...` | 拒绝 | 改用 `hana_sql_analyze` |
| 匿名块 | `DO ...` | 不支持 | 改用 `CALL` 或拆成多条语句 |
| 无法判定 | 过程体、动态 SQL 等 | 拒绝 | 规则层硬拒绝（`sql_statement_unsupported`） |

> **先做形状检查（与语句类型无关）**：多语句/多物理行默认拒绝；如需允许，需设置
> `HANA_SQL_ALLOW_MULTI_STATEMENT=true`；单次语句条数受 `HANA_SQL_MAX_STATEMENTS` 限制。
> 通过形状检查后，再按上表做语句分类与权限控制。

**执行细节**

- **多语句事务**：多语句在同一池连接上顺序执行；**有写**时服务端自动开事务（全部成功才 commit，失败 rollback，
  结束后恢复 `autoCommit=true`）。
- **不做 schema 级拦截**：不扫描 FROM/JOIN、不查 CURRENT_SCHEMA、不参与 `HANA_READ_SCHEMA` / 写 schema 白名单；
  能访问哪些对象由 HANA 账号权限决定。请按最小权限原则使用专用数据库账号。
- **DDL 风险**：HANA 可能隐式提交，多语句事务回滚不保证撤销已执行的 DDL；回执会如实提示。

**结果与审计**

- **`maxRows` / `timeoutMs` 是工具参数**：默认 500 行 / 60000ms，上限 10000 行 / 3600000ms；不是环境变量。
- **部署级结果上限**：`HANA_SQL_MAX_RESULT_BYTES` / `HANA_SQL_MAX_STATEMENTS`。SELECT 流式取行、到上限即关闭
  结果集；二进制值 base64 包装并限制单格大小；超限标记 `truncated` 并挂 `resultInfo`。
- **审计不落 SQL 原文**：`capability-audit` 的 target 只记 `op: "sql"` + SQL 的 sha256 前 12 位 + 字符数。
- **`async=true`**：立即返回 `taskId`，用 `hana_task_get` 轮询终态（需 `read` 组可见；取消还需 `write` 组的
  `hana_task_cancel`）；执行中的 SQL 无法中途取消。只启用 `sql` 组的部署不要使用 `async`。

**调用时机（软约束）**

仅在用户明确要求执行 SQL 时调用；不用于探测、验证或替代专用工具。该约束写在工具说明里，服务端无法读取
用户原始消息，属模型侧软约束；需要硬拦截请在客户端把该工具设为需人工确认。

### 策略文档已移除

`MCP_POLICY` 不再是权限入口：已移除并忽略（v1/v2 都不再读取）。权限只由 4 个 env 表达：
`HANA_TOOL_GROUPS` / `HANA_TOOL_DENY` / `HANA_WRITE_PACKAGES` / `HANA_READ_SCHEMA`。
多调用方需要再收紧时，用可选的 `MCP_PROFILES`（档案只能在上述范围内收紧）。

### 调用上下文（contextToken）

`hana_tool_search` 的 `discover` / `contract` / `goal` 回执都带 `contextToken`（HMAC 签名，10 分钟有效）。
执行时把它传给 `hana_invoke({ capability, args, contextToken })`：

- 多环境**所有**调用必须带（读调用也不例外）；
- token 绑定 profile/client/env/epoch/policyRev/manifestRev；切环境、改策略、换清单后旧 token 失效（`context_stale`），重新调 `hana_tool_search` 即可；
- 旧字段 `expectedEnvironment` / `disclosure` / `disclosureId` 仍兼容一个版本，但新调用只需 `contextToken`；
- token **不是授权凭证**：每次 `hana_invoke` 仍按目标能力重新授权与预检。

### 调用方档案（MCP_PROFILES）

多客户端共享一个进程时，每个调用方可以有自己的**面**（能调什么）：

```bash
# name=kinds[:能力glob|glob]，kinds 用 + 连接；; 分隔多个档案
MCP_PROFILES="analyst=read;dev=read+write:hana_view_*|hana_metadata_*;default=read"
MCP_PROFILE=default                                            # stdio 进程用的档案
MCP_HTTP_TOKENS="alice:<token>:dev,bob:<token>:analyst"        # 第三段 = 该身份的档案
```

- 档案的 kinds 合法值为 `read`/`write`/`admin`/`sql`；部署的 `HANA_TOOL_GROUPS` 是天花板，档案要使用 `hana_sql_execute` 时还必须把 `sql` 写进该档案的 kinds（否则能力仍不可触达）。
- **只能收紧、不能放宽**：档案不能把部署级 deny 掉的能力变回来，也不能扩大可写包/可读 schema 范围。越界组合（只读部署里写 `dev=read+write`）**启动即拒绝**。
- **配了 `MCP_PROFILES` 就必须定义 `default`**：HTTP 不带第三段的 Token 与 stdio 进程都落它。
- 判定发生在**调用期**（`authorizeCall`），拦截回执与其它策略拦截同形（不含补救路径）。
- 每次调用都会落地 `capability-audit`（含 `profileId` / `clientId` / `agentLabel` / `resources` / `codes`）。
- 档案名解析失败（配了档案却查不到条目）→ **空档案 = 全拒**（fail-closed）。

实机验收：`npm run smoke:http`（两个档案演示隔离）。

## 传输方式

支持两种 MCP 传输，由 `MCP_HTTP_PORT` 是否设置切换（其余工具/配置完全一致）：

| 传输 | 启用方式 | 适用场景 |
| --- | --- | --- |
| **stdio**（默认） | 不设置 `MCP_HTTP_PORT` | Claude Desktop / Cursor / VS Code 等本地客户端 |
| **Streamable HTTP** | 设置 `MCP_HTTP_PORT`（如 `3000`）后 `npm start`（或 `node dist/index.js`） | 远程/容器化部署、多客户端共享实例 |

**HTTP 要点**

- 端点 `http://<host>:<port>/mcp`（仅此路径）；无状态按请求服务，连接池共享。
- **无会话**：每请求新建协议实例，无 `Mcp-Session-Id`；隔离粒度 = 单进程，所有客户端共享连接池、工具可见性与可写包白名单。
- **安全默认**：仅绑定 `127.0.0.1`，Host/Origin 默认仅本机名；对外暴露需 `MCP_HTTP_HOST=0.0.0.0` + `MCP_HTTP_ALLOWED_HOSTS`（浏览器再放行 `MCP_HTTP_ALLOWED_ORIGINS`）。
- **认证**：`MCP_HTTP_TOKENS`（或旧 `MCP_HTTP_TOKEN`）启用 Bearer 校验，缺失/不匹配 → 401；对外监听且无 Token 默认拒绝启动，确需如此显式 `MCP_HTTP_ALLOW_ANONYMOUS=true`。
- **多环境**：HTTP 下不能用进程级 active，必须 `MCP_HTTP_TOKENS` + `MCP_HTTP_CLIENT_ENVS`，为每个 Token 绑定一个环境标识（即 `_ENV_<XXXX>` 的 `<XXXX>`，大小写不敏感）；`hana_env_switch` 拒绝且不进索引；缺少绑定或存在未绑定 Token → 启动失败。单环境不需要该项。
- 请求体上限 10MB（按字节计）；`Content-Length` 超限直接 413。
- **身份归因**：`MCP_HTTP_TOKENS` 把 Token 映射为 `clientId`，envelope 带 `clientId`（stdio 无）；写操作日志留 `clientId` + 包 + 对象。

**并发与锁（进程内 keyed lock，按包/对象串行化）**

- 写路径按包/对象/目标文件串行化；更新/激活在锁内取 ETag 基线，并发改动返回 412。
- 设计时校验的 `_CHKTMP` 名带短哈希（≤29），只删本次创建过的临时名。
- 412 / delete 404 返回业务失败信封（412 带 `raw.conflict`）；成功回执带 `etag` + `etagSource`。
- 已知例外：跨进程同名创建 last-write-wins；同一设计时文件并发写可能 555（写未发生）；导入跨进程竞态无服务端前置。
- `dryRun=true` 只读预演；破坏性变更须声明 `migration.strategy`，否则 `migration_required` 且零写入。
- 锁均为进程内；多进程/多实例需外部串行化。

**超时与资源**

- XS REST 全部请求有超时（登录/CSRF 更短），xfer 单独放宽：`HANA_XS_TIMEOUT_MS` / `HANA_XS_XFER_TIMEOUT_MS`。
- 写路径 SQL 有语句超时 `HANA_SQL_TIMEOUT_MS`，不设全局默认。
- 池上限/排队超时/排队上限默认 4 / 30s / 64；建议一代理一进程，N 个代理 = N×`HANA_POOL_MAX` 连接。
- 激活有进程内信号量（`HANA_ACTIVATION_CONCURRENCY`，默认 2）；import 上传、建包 POST/DELETE 不在覆盖内。
- keyed lock 排队超时默认 60s，超时不执行。

**缓存与多代理**

- 视图定义缓存 60s TTL + 200 条 LRU；写成功后立即失效本进程缓存。
- 多代理：按依赖连通分量切分，一个分量一个写者；写者 2–4 个后集成开销上升；冲突后 REFRESH（412 的 `currentETag` 重读）→ REPLAN。
- 未内置 OAuth；暴露网络时用 `MCP_HTTP_TOKENS` + 反向代理/VPN/防火墙。日志走 stderr，401 不记录 Authorization 头。

```bash
MCP_HTTP_PORT=3000 MCP_HTTP_TOKENS='shared:your-long-random-token' node dist/index.js
# → 已就绪（streamable HTTP transport，端点 /mcp），监听 http://127.0.0.1:3000/mcp
```

## 工具调用超时

- `hana_sql_analyze(analyze=true)` 同步执行时服务端最多跑 **5 分钟**（另加排队与控制面调用），多数客户端默认更短。
- **首选 `async=true`**：立即返回 `taskId`，用 `hana_task_get` 轮询，不受客户端单次调用超时限制；执行中的 SQL 无法取消。
- 长变更集同理用 `hana_view_update(async=true)`。
- 若必须同步调用，把客户端单次工具调用超时调到 **600000 ms**：`mcp.json` 该 server 条目加 `"timeout": 600000`，或在**启动客户端**的环境里设 `MCP_TOOL_TIMEOUT=600000`。

## 安全边界

- **写操作安全边界**：写工具（create/activate/update/delete/package_create/import）的可写包范围由 `HANA_WRITE_PACKAGES` 控制——**空 = 未启用写边界**：声明写包的请求会被运行期闸门以 `boundary_off` 硬拦；填写后仅允许配置包及其下级子包写操作。只有**服务层**那一层是 fail-open（白名单为空时放行）——脚本/内部调用不走工具层闸门。
- **本地文件边界**：`hana_repo_export` 的 `saveTo` 与 `hana_repo_import` 的 `filePath` 直通服务器本地文件系统。只允许**服务器工作目录内的相对路径**（绝对路径与含 `..` 的路径一律拒绝）；需要更强隔离时让服务进程以专用目录为工作目录启动。
- **XS 写通道为明文 HTTP**：XS REST 默认 `http://`，HANA 账号密码、会话 Cookie 与 CSRF token 全部明文传输；`HANA_TLS`/`HANA_SSL_VALIDATE` 只作用于 SQL 通道。必须由网络侧隔离；XS 端点支持 TLS 时置 `HANA_XS_TLS=true` 并把 `HANA_XS_PORT` 指向 HTTPS 端口。
- **权限策略层**：`src/config/preflight.ts` 是唯一判定入口，能力级（`HANA_TOOL_GROUPS/ALLOW/DENY`）+ 资源级（`HANA_WRITE_PACKAGES` / `HANA_READ_SCHEMA`）+ 部署级（`HANA_TLS` / `MCP_HTTP_*`）。三个调用方共用同一层：服务启动自检、工具层运行期闸门（`runPreflight`）、CLI/实机脚本（`npm run preflight`）。
- **直接执行 SQL 的边界**：`hana_sql_execute`（sql 组，默认关闭）执行的是**调用方提交的任意 SQL**——`HANA_WRITE_PACKAGES` / `HANA_READ_SCHEMA` / 写 schema 白名单都不适用于它（那是仓库包与读取面边界）；服务端不扫描、不拦截 schema，能访问哪些对象由 HANA 账号权限决定。启用前请按最小权限原则使用专用数据库账号。
- **拦截消息不含补救路径**：返回给模型的拦截消息只陈述事实（维度/规则码/请求内容/生效策略），不写"改哪项配置可放行"；补救指引只在运维向位置（启动自检与本文档）。
- **部署级不变量（启动即拒绝）**：① HTTP 非回环监听且无 Bearer Token → 拒绝启动（除非 `MCP_HTTP_ALLOW_ANONYMOUS=true`）；② `HANA_TLS=false`、③ 加密但 `HANA_SSL_VALIDATE=false`、④ XS 写通道明文（未置 `HANA_XS_TLS=true`）→ 告警放行，但每次启动可见。
- **读范围边界**：受约束的是「按名指定 schema 去读」（`schema` 不在 `HANA_READ_SCHEMA` 即被拦）；不约束已激活视图自身定义的读取、`hana_data_preview` 视图预览、仓库包维度与 `hana_table_storage` 省略 schema 时的全库统计。
- **审计**：每次调用落地一条 `capability-audit`；`effects.mutates='persistent'` 的能力每次尝试一条终态 `denied | completed | failed`（临时对象/纯读只记 `allowed`）。持久化由部署方负责。

## HANA 授权要求

连接用户需对以下对象有相应权限（按使用范围勾选）：

**读路径（元数据/预览）**

- `_SYS_REPO`：SELECT（ACTIVE_OBJECT / INACTIVE_OBJECT / PACKAGE_CATALOG）
- `_SYS_BI.BIMC_*`：SELECT（可选，字段清单主通道已改用 `_SYS_REPO` XML 解析）
- `_SYS_BIC`：SELECT（运行时视图数据预览）
- `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV` / `SYS.DROP_INTERMEDIATE_CALCULATION_VIEW_DEV`：EXECUTE（节点级预览）
- `SYS.CHECK_CALCULATION_VIEW`：EXECUTE（runtime 校验）
- 受分析权限保护的 BW 视图还需对应 `ANALYTICAL_PRIVILEGE` 授权（schema SELECT 不能替代）

**写路径（XS Classic 设计时 REST，可写包建模全生命周期）**

- `SYS.REPOSITORY_REST`：EXECUTE
- 仓库写/激活权限：`REPO.EDIT_NATIVE_OBJECTS` / `REPO.ACTIVATE_NATIVE_OBJECTS`（或等价：目标包 root 的 package 权限 + MODELING 角色）
- `REPO.MODIFY_CHANGE` / `REPO.MODIFY_OWN_CONTRIBUTION`：变更会话（workspace）操作
- XS 会话：用户须可登录 XS Classic（实测以 `hana_check_privileges` 排查）
- 写目标包：`REPO.EDIT_NATIVE_OBJECTS` + 包的 owner 或 package 级写特权

**稳定性诊断（`hana_system_health` / `hana_system_activity` / `hana_table_storage` / `hana_system_trend`）**

- **无需额外权限即可用**：`SYS.M_SERVICES`、`M_CS_TABLES`、`M_TABLES`、`M_SQL_PLAN_CACHE` 等实例内视图。
- **`CATALOG READ`（或含它的 `MONITORING` 角色）**：解锁基础设施类监视视图（`M_DISKS`/`M_DISK_USAGE`、`M_HOST_RESOURCE_UTILIZATION`、`M_BACKUP_CATALOG`、`M_SERVICE_REPLICATION`、`M_MEMORY_OBJECTS`、`M_VOLUME_IO_TOTAL_STATISTICS`、`M_ENCRYPTION_OVERVIEW`），以及他人会话的完整可见性。权限不足时不报错、只返回空集 → 对应项标 `unknown`（而非"正常"）。
- **`_SYS_STATISTICS` 的 SELECT**：告警项与整个趋势工具需要它；缺权限报 258 → `unknown`。趋势保留期实测约 42 天。
- **`INIFILE ADMIN`**：`hana_system_health` 的 config 项读全 `M_CONFIGURATION_PARAMETER_VALUES`。
- 权限是否到位可用 `hana_system_health` 的 `visibility` 或 `hana_check_privileges` 确认。

权限不足时先用 `hana_check_privileges` 排查；预览失败用 `hana_data_preview_diagnose` 定位是分析权限还是上游不可达。

## 错误码速查

所有主动拦截都会显式报错，错误码稳定可查；错误信息同时给出原因与处理方案。
下表与 `src/config/error-codes.ts` 的注册表同源（新增码必须同步更新）。

| 错误码 | 含义 | 处理方案 |
|---|---|---|
| `config_invalid` | 配置加载失败（通用明细码） | 按错误信息逐项修正；无法判断时先跑 scripts/migrate-env-config.mjs --check。 |
| `env_mode_mismatch` | HANA_ENV_MODE 与实际检测到的单/多环境模式不一致 | 删掉 HANA_ENV_MODE 让服务自动判断，或改成与 _ENV_ 变量匹配的值。 |
| `label_removed` | HANA_LABEL / HANA_LABEL_ENV_* 已移除 | 删除 LABEL 变量；环境标识直接取 HANA_<PARAM>_ENV_<XXXX> 里的 <XXXX>。 |
| `legacy_env_prefix` | 使用了已废弃的 HANA_ENV_<NAME>_<PARAM> 前缀 | 改成 HANA_<PARAM>_ENV_<NAME>，例如 HANA_ENV_QAS_HOST → HANA_HOST_ENV_QAS。 |
| `env_config_unsupported` | 使用了不支持的 HANA_ENV_CONFIG 文件配置 | 本版只支持扁平环境变量；请把配置写成 HANA_<PARAM>_ENV_<XXXX> / 共享策略键。 |
| `env_key_invalid` | 环境标识非法 | 环境标识必须匹配 [A-Za-z][A-Za-z0-9_]{0,31}；旧 LABEL 里的 - 请改成 _。 |
| `env_key_conflict` | 同一参数存在仅大小写不同的两个 _ENV_ 键 | 只保留一个键，或把两个键统一成同一大小写。 |
| `env_key_unknown` | HANA_ENV_START / HANA_ENV_SWITCHABLE / 切换请求引用了未配置的环境标识 | 先调用 hana_env_list（或看启动摘要）确认可用环境标识；匹配大小写不敏感。 |
| `process_param_scoped` | 进程级参数被写成了 _ENV_ 形式 | 进程级参数只能扁平写；检查 HANA_TOOL_* / MCP_* / LOG_LEVEL / HANA_TIMEZONE 等是否误加 _ENV_。 |
| `missing_connection_param` | 某个多环境缺少连接参数 | 为该环境补 HANA_<PARAM>_ENV_<XXXX>；HOST/PORT/USER/PASSWORD 没有共享回退。 |
| `env_start_required` | 多环境未指定启动环境 | 设置 HANA_ENV_START=<环境标识>；只有一个环境时可省略。 |
| `env_switchable_in_single` | 单环境部署却配置了可切换列表 | 删除 HANA_ENV_SWITCHABLE，或补充 _ENV_ 变量进入多环境模式。 |
| `env_readonly` | 只读环境拒绝了持久写入能力 | 切到 ACCESS=readwrite 的环境，或为该环境使用只读账号；临时对象与纯读不受影响。 |
| `env_assertion_missing` | 多环境调用缺少 expectedEnvironment | 传入当前环境标识（与 hana_env_list 的 current 一致，大小写不敏感）。 |
| `env_assertion_mismatch` | expectedEnvironment 与当前环境不一致 | 先确认是否忘了切回；用 hana_env_list 查看当前环境后重试。 |
| `env_epoch_missing` | 多环境调用缺少 expectedEpoch | 传入 hana_env_list 返回的 epoch（或重新披露取当前代际）。 |
| `env_epoch_stale` | expectedEpoch 已过期（如 DEV 4 → PRD 5 → DEV 6） | 重新调用 hana_env_list / hana_tool_search 取当前代际后重试；旧披露不可复用。 |
| `policy_stale` | 调用方回传的披露 `policyRev` 与当前策略不一致 | 重新调用 hana_tool_search 披露（策略/档案/环境已变化）。 |
| `manifest_stale` | 调用方回传的披露 `manifestRev` 与当前能力清单不一致 | 重新披露；服务端可能已升级。 |
| `env_switch_disabled` | 环境切换未启用 | 需要多环境部署且 HANA_ENV_SWITCHABLE 非空。 |
| `env_switch_http_unsupported` | HTTP 模式不支持进程级环境切换 | 改用一进程一环境，或配置 MCP_HTTP_CLIENT_ENVS 做 Token→环境绑定。 |
| `env_switch_target_not_allowed` | 目标环境不在 HANA_ENV_SWITCHABLE 中 | 把目标环境标识加入 HANA_ENV_SWITCHABLE 后重启。 |
| `env_switch_from_mismatch` | 切换请求的 from 与当前环境不一致 | 用 hana_env_list 重新取 current 后再切换。 |
| `env_switch_epoch_stale` | 切换请求的 epoch 已过期 | 重新调用 hana_env_list 获取最新 epoch/token 后再切换。 |
| `env_switch_token_invalid` | 切换 token 无效或已使用/过期 | 重新调用 hana_env_list 获取一次性 token（默认 60s 有效）。 |
| `env_switch_confirm_mismatch` | confirm 与目标环境标识不一致 | 把 confirm 设为与 to 相同的环境标识（大小写不敏感）。 |
| `env_switch_busy` | 有其它调用在途，切换被拒绝 | 等当前调用结束后重试；切换失败会保持原环境。 |
| `env_already_active` | 目标环境已经是当前 active | 无需切换；如需刷新状态请重新调用 hana_env_list。 |
| `env_switch_target_has_running_tasks` | 目标环境有运行中任务 | 确认可共享池后显式传 acknowledgeRunningTasks=true。 |
| `env_switch_target_unreachable` | 目标环境连接预检失败 | 检查目标环境的 HOST/PORT/USER/PASSWORD 与网络；切换未执行，原环境保持不变。 |
| `boundary_off` | 写边界未启用（HANA_WRITE_PACKAGES 为空） | 配置 HANA_WRITE_PACKAGES（或对应的 _ENV_ 覆盖）；空 = 声明写包的调用被拒。 |
| `target_outside_boundary` | 目标包不在可写范围内 | 把目标包加入 HANA_WRITE_PACKAGES（或其 _ENV_ 覆盖），或改写到允许的包。 |
| `profile_unknown` | 调用方档案无法解析 | 检查 MCP_PROFILE / MCP_HTTP_TOKENS 第三段是否指向已定义的档案。 |
| `kind_not_allowed_by_profile` | 档案不允许该能力分类 | 换用允许该分类的档案，或调整 MCP_PROFILES（只能收紧，不能放宽部署策略）。 |
| `capability_not_in_profile` | 能力不在档案允许的 glob 范围内 | 调整 MCP_PROFILES 的 glob，或换用其它档案。 |
| `write_package_outside_profile` | 目标包不在档案的写包范围内 | 调整档案的 resourceScopes（若已启用），或换用允许该包的档案。 |
| `schema_outside_profile` | schema 不在档案允许的读取范围内 | 调整档案的 resourceScopes（若已启用），或换用允许该 schema 的档案。 |
| `tool_not_exposed` | 能力未对当前调用方暴露 | 检查 HANA_TOOL_GROUPS / HANA_TOOL_DENY 与档案。 |
| `unknown_capability` | 能力 id 不存在或未授权 | 先 `hana_tool_search({mode:"discover"})` 获取可用能力 id。 |
| `schema_not_allowed` | schema 不在读取白名单内 | 把 schema 加入 HANA_READ_SCHEMA（或对应的 _ENV_ 覆盖）。 |
| `tls_plaintext` | SQL 连接未启用 TLS | 设置 HANA_TLS=true（或对应环境的 HANA_TLS_ENV_<XXXX>=true）。 |
| `hana_client_pipe_unavailable` | @sap/hana-client 的内部 IPC 管道（hdbpipe）不可用 | 重启 MCP server；若持续出现，检查 SAP HANA client 运行环境（杀毒软件/临时目录/残留的 HANA 客户端进程）。 |
| `xs_plaintext` | XS 写通道使用明文 HTTP | 设置 HANA_XS_TLS=true，或把 XS 端点限制在可信网络内。 |
| `http_exposed_without_auth` | HTTP 对外监听但未配置认证 | 配置 MCP_HTTP_TOKENS，或显式设置 MCP_HTTP_ALLOW_ANONYMOUS=true 承担风险。 |
| `encrypted_but_unauthenticated` | TLS 未校验证书 | 设置 HANA_SSL_VALIDATE=true，或确认内网自签场景的风险。 |
| `no_request` | 没有可用的调用上下文 | 重试调用；若持续出现请查看服务端日志。 |
| `target_invalid` | 目标对象/包名非法 | 检查对象名与包路径是否符合仓库命名规则。 |
| `profile_glob_matches_nothing` | 档案 glob 没有命中任何能力 | 检查 MCP_PROFILES 的 glob 拼写与能力 id。 |
| `profile_glob_partly_hidden` | 档案 glob 命中的部分能力被部署策略隐藏 | 这是预期收紧；如需使用，调整部署的 HANA_TOOL_*。 |
| `profile_kind_not_in_policy` | 档案声明的 kind 超出部署策略 | 档案只能收紧部署策略；调整 MCP_PROFILES 或部署的 HANA_TOOL_GROUPS。 |
