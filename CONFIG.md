# 配置与权限

> 本文是 [README.md](README.md) 的详细配置参考：连接参数、工具分组、调用方档案、传输方式、安全边界与 HANA 授权要求。

## 必填参数

| 配置项 | 说明 |
| --- | --- |
| `HANA_HOST` | HANA 主机名/IP |
| `HANA_PORT` | SQL 端口（纯数字；不再由实例号推导） |
| `HANA_USER` | 数据库用户名 |
| `HANA_PASSWORD` | 密码 |

缺失必填项时服务**启动即失败**。连接信息只允许来自环境变量 / `mcp.json` 的 `env`（**仅 stdio 模式生效**）/ `.env` 文件，不提供默认值。

`HANA_XS_PORT`（XS 设计时 REST 端口）**非必填，默认 8010**；非默认实例/租户请显式覆盖。

## 配置来源

| 运行方式 | 配置实际来源 |
| --- | --- |
| **stdio**（MCP 客户端拉起进程） | 客户端 `mcp.json` 的 `env` 由客户端注入为子进程环境变量 → 等价于环境变量；凭据三件套（`HANA_HOST`+`HANA_USER`+`HANA_PASSWORD`）齐全时 **不再读 `.env`** |
| **Streamable HTTP**（自行 `npm start` / 容器启动） | 没有客户端拉起进程，**`mcp.json` 不参与**；来源为 shell/容器环境变量 → 兜底 `.env` |

`.env` 查找顺序为 **工作目录 → 项目根**（`dist/` 上两级），且**逐变量生效**——`process.loadEnvFile` 不覆盖已存在的环境变量。因此三件套只有一部分来自外部环境时会跨来源混用（典型：shell 里残留的 `HANA_USER` 覆盖 `.env` 中的用户名，其余仍取 `.env`），可能连接到另一套环境。服务检测到连接目标/凭据来自多个来源时，会在启动日志 **warn** 并列出每个变量的来源，请据此清理多余的环境变量。

## 完整参数表

| 配置项 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `HANA_HOST` | ✅ | HANA 主机名/IP | `hana-host.example` |
| `HANA_PORT` | ✅ | SQL 端口（**必填**，不再由实例号推导——`3<实例>13/15` 推不出非默认租户；只接受纯数字） | `31015` / `31041` |
| `HANA_USER` | ✅ | 数据库用户名 | — |
| `HANA_PASSWORD` | ✅ | 密码 | — |
| `HANA_LOCALE` | 可选 | 连接语言，默认 `zh` | `zh` |
| `HANA_DB_NAME` | 可选 | 租户数据库名（MDC 必填） | `SYSTEMDB` / 业务租户名 |
| `HANA_TLS` | 可选 | TLS 加密，默认 `true`（fail-closed；仅可信链路显式 `false`） | `true` |
| `HANA_SSL_VALIDATE` | 可选 | TLS 下校验证书，默认 `true`；自签证书环境显式 `false` | `true` |
| `HANA_TIMEZONE` | 可选 | 进程时区（设置 `TZ`，影响日志时间戳与本地时间语义）；**不下发 HANA 会话**。默认 `Asia/Shanghai` | `Asia/Shanghai` |
| `HANA_READ_SCHEMA` | 可选 | 追加允许查询的 schema（逗号分隔，追加到内置白名单） | `SAPABAP1,OTHER_SCHEMA` |
| `HANA_WRITE_PACKAGES` | 可选 | 允许写操作的仓库包前缀（逗号分隔，含子包）。**空 = 未启用写边界**：声明写包的请求会被运行期闸门以 `boundary_off` 硬拦（要写就必须显式配置）；填写后仅允许配置包及其下级子包写操作 | `ZDEMO1,ZDEMO2.ZDEMO_SD` |
| `HANA_XS_PORT` | 可选 | XS Classic 设计时 REST 端口；**默认 `8010`**（非默认实例/租户需覆盖，仍不按实例号推导） | `8000` |
| `HANA_XS_BASE_PATH` | 可选 | XS 设计时 REST 基础路径，默认 `/sap/hana/xs/dt/base` | — |
| `HANA_XS_TLS` | 可选 | XS 写通道走 HTTPS（默认明文 `http://`，须网络侧隔离） | `true` |
| `HANA_POOL_MAX` | 可选 | HANA 连接池并发上限，默认 `4` | `8` |
| `HANA_POOL_WAIT_MS` | 可选 | 池满后的排队等待超时（ms），默认 `30000` | `60000` |
| `HANA_POOL_MAX_WAITERS` | 可选 | 排队上限（个），默认 `64` | `128` |
| `HANA_SQL_TIMEOUT_MS` | 可选 | 写路径五条 SQL 语句的语句超时，默认 `60000` | `120000` |
| `HANA_XS_TIMEOUT_MS` | 可选 | XS REST 请求默认超时（ms），默认 `30000` | `60000` |
| `HANA_XS_XFER_TIMEOUT_MS` | 可选 | XS Transfer（xfer）导入/导出超时（ms），默认 `300000` | `600000` |
| `HANA_ACTIVATION_CONCURRENCY` | 可选 | 服务端激活的并发上限（进程内信号量），默认 `2` | `4` |
| `HANA_TOOL_GROUPS` | 可选 | 启用的工具功能分组（逗号分隔 `read`/`write`/`admin`）；**空=不限制** | `read` |
| `HANA_TOOL_ALLOW` | 可选 | 强制启用的工具名/组名 glob（逗号分隔，支持 `*`） | `hana_view_validate` / `write` |
| `HANA_TOOL_DENY` | 可选 | 强制禁用的工具名/组名 glob（优先级最高） | `hana_data_preview*` |
| `HANA_EXPLAIN_SURFACE` | 可选 | 仅调试：置 `names` 时门面索引的 `surface` 说明列出被隐藏/加载失败的能力名 | `names` |
| `MCP_PROFILES` | 可选 | 调用方档案（见下）。档案只能收紧部署策略；配了就必须定义 `default` | `analyst=read;dev=read+write:hana_view_*;default=read` |
| `MCP_PROFILE` | 可选 | 本进程（stdio）与"无档案身份调用方"使用的档案名 | `default` |
| `MCP_AGENT_LABEL` | 可选 | 进程级归因标签：写进 envelope 与每条 `capability-audit` | `prod-cn-01` |
| `MCP_CAPABILITY_SURFACE_MAX` | 可选 | 单调用方的提升预算（默认 50，按工具数算，超出时最旧分类整体淘汰） | `100` |
| `LOG_LEVEL` | 可选 | 日志级别，默认 `info` | `debug` |
| `MCP_HTTP_PORT` | 可选 | Streamable HTTP 端口；设置后以 HTTP 模式启动（端点 `/mcp`），未设置 = stdio。`0` = 随机端口 | `3000` |
| `MCP_HTTP_HOST` | 可选 | HTTP 监听地址，默认 `127.0.0.1`（fail-closed） | `0.0.0.0` |
| `MCP_HTTP_TOKEN` | **已废弃** | 等价于 `MCP_HTTP_TOKENS=shared:<token>`；计划在下一个大版本删除 | — |
| `MCP_HTTP_TOKENS` | 可选 | 多客户端 Token → 身份映射（`name:token[:profile]`）；`token` ≥16 字符且不得含冒号 | `alice:<token>:dev,bob:<token>` |
| `MCP_HTTP_ALLOWED_HOSTS` | 可选 | 允许的 Host 头主机名（逗号分隔，默认仅本机名） | `localhost,myhost.corp` |
| `MCP_HTTP_ALLOWED_ORIGINS` | 可选 | 允许的 Origin 主机名；未设置时继承 `MCP_HTTP_ALLOWED_HOSTS` | `localhost` |
| `MCP_HTTP_ALLOW_ANONYMOUS` | 可选 | 显式承认「对外监听且不配置 Token」的风险，默认 `false`（非回环 + 无 Token 时拒绝启动） | `false` |

## 工具分组与可见性控制

30 个业务能力（28 + 异步任务查询/取消）按功能划分为三组。**注册面上只有六个分类门面**——具体能力经门面索引 + 路由调用（见 README「工具面」）。可见性配置管的是**可触达上限**（哪些能力存在且有权用），不等于注册面。

| 分组 | 说明 | 能力 |
| --- | --- | --- |
| **read** 数据读取 | 访问 HANA 数据/元数据/系统信息与异步任务状态，不改动仓库 | `hana_system_get_info`、`hana_check_privileges`、`hana_package_list`、`hana_package_list_objects`、`hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used`、`hana_table_list`、`hana_table_columns`、`hana_data_preview`、`hana_data_preview_diagnose`、`hana_task_get` |
| **write** 写操作 | 改动仓库设计时对象/包、接受任意 SQL 的分析、取消异步任务 | `hana_package_create`、`hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions`、`hana_sql_analyze`、`hana_task_cancel` |
| **admin** 管理操作 | Transfer / Change-Tracking API 与系统监视面 | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist`、`hana_system_health`、`hana_system_activity`、`hana_table_storage`、`hana_system_trend` |

> 分组（kind）是**权限层级**而非"行为画像"：稳定性诊断四件套、`hana_repo_changelist` 行为只读但归 admin；`hana_sql_analyze` 接受任意 SQL 但归 write。客户端注解（`readOnlyHint`）描述行为，两者不互相推导。
>
> `hana_view_validate` design 模式会短暂写入 `_CHKTMP` 临时对象，故整工具归 write。
>
> **门面层不做限制**：六个门面在任何分组配置下都常驻 `tools/list`（只有显式 `HANA_TOOL_DENY` 命中门面 id、或 deny 掉它全部成员才会消失）。分组开关只决定**能力层**；索引/路由/提升/调用一律按**目标能力**的 kind 判。

配置变量优先级：`HANA_TOOL_DENY` > `HANA_TOOL_ALLOW` > `HANA_TOOL_GROUPS`。

- `HANA_TOOL_GROUPS`：启用的分组（逗号分隔）；空=不限制。
- `HANA_TOOL_ALLOW`：强制启用（即便分组未启用），支持组名与工具名 glob。
- `HANA_TOOL_DENY`：强制禁用（优先级最高），支持组名与 glob。

> **没有别名层**：`MCP_TOOL_*` 不再识别；未识别的 `HANA_*` / `MCP_*` / `LOG_*` 变量会在启动日志告警（防拼写错误静默失效）。
>
> 组名可直接用于 allow/deny（`read` / `write` / `admin`），展开为该组全部工具名。例：`HANA_TOOL_GROUPS=read,write` + `HANA_TOOL_DENY=write` ⇒ 等价只读部署。

**典型部署形态：**

- **只读分析师**：`HANA_TOOL_GROUPS=read` —— 可触达上限收窄到 14 个 read 档能力；`hana_diagnostics` 索引为空，`hana_modeling` 只剩 `hana_task_get`。
- **建模开发者**：`HANA_TOOL_GROUPS=read,write` —— admin 档不可达。
- **关闭特定能力**：`HANA_TOOL_DENY=hana_view_delete` —— 索引、路由、提升都够不着。

未知分组名（如 `HANA_TOOL_GROUPS=read,bogus`）启动即失败（fail-closed）。

### 调用方档案（MCP_PROFILES）

多客户端共享一个进程时，每个调用方可以有自己的**面**（能调什么）：

```bash
# name=kinds[:能力glob|glob]，kinds 用 + 连接；; 分隔多个档案
MCP_PROFILES="analyst=read;dev=read+write:hana_view_*|hana_metadata_*;default=read"
MCP_PROFILE=default                                            # stdio 进程用的档案
MCP_HTTP_TOKENS="alice:<token>:dev,bob:<token>:analyst"        # 第三段 = 该身份的档案
```

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

HTTP 模式要点：

- 端点 `http://<host>:<port>/mcp`（仅此路径，其余 404）；无状态按请求服务（2025/2026 协议版本客户端均可接入），连接池共享。
- **无会话**：每个请求新建协议实例、无 `Mcp-Session-Id`、无会话级状态，因此不存在跨会话串扰与会话劫持面；隔离粒度 = 单个服务进程：所有客户端共享同一连接池、同一工具可见性配置、同一可写包白名单。
- **安全默认（fail-closed）**：仅绑定 `127.0.0.1`，Host/Origin 白名单默认仅本机名。对外暴露需同时：`MCP_HTTP_HOST=0.0.0.0` + `MCP_HTTP_ALLOWED_HOSTS` 放行对外主机名（浏览器类客户端再放行 `MCP_HTTP_ALLOWED_ORIGINS`）。
- **认证**：设置 `MCP_HTTP_TOKENS`（或向后兼容的 `MCP_HTTP_TOKEN`）后所有请求强制 Bearer Token 校验（缺失/不匹配 → 401）；未设置时回环监听即为访问边界。**对外监听且无 Token 时默认拒绝启动**，确需如此须显式 `MCP_HTTP_ALLOW_ANONYMOUS=true`。
- 请求体上限 10MB（按字节计）：声明的 `Content-Length` 超限直接 413；流式上传同样按字节计数、本地拦截。
- **客户端身份归因**：`MCP_HTTP_TOKENS` 把每个 Token 映射为独立 `clientId`，随请求上下文贯穿到工具层；每次工具调用返回的 envelope 带 `clientId`（stdio 无此字段）；每个写操作在服务端日志留一条审计记录（`clientId` + 包 + 对象）。
- **并发与锁**（进程内 keyed lock，按「包/对象」串行化）：
  - **新建**：进程内按对象互斥，并发同名创建后者显式报冲突。**已知例外**：XS PUT 是 create-or-update，跨进程同名创建 = last-write-wins。
  - **更新**：锁内先读基线（读时取 ETag），再读内容、PUT；并发改动以 412 显式冲突返回。
  - **激活**：锁内「读元数据取基线 → 读内容 → 带 If-Match 的 PUT」在同一临界区。
  - **删除**：锁内取基线后删除；正确基线 → 204、陈旧基线 → 412、对象已不存在 → 404。
  - **设计时校验**：临时对象 `_CHKTMP` 名带短哈希（总长 ≤29）；只删除本次调用创建过的临时名——重名时拒绝执行（不删不改）。
  - **导入**：按目标文件名加锁；存在性检查仅把 404 视为不存在；写入后回读校验。**跨进程竞态无服务端前置**，属已知例外。
  - **冲突回执**：412 与 delete 的 404 返回业务失败信封（`success=false` + 机读码），412 带 `raw.conflict`（`currentETag` 是冲突时点补读值，不是新基线）。成功回执带新基线 `etag` 与 `etagSource`（`response-header` / `read-back` / `unavailable`）。
  - **已知边界**：同一设计时文件并发写可能以 555 写错误被拒（写未发生），回执不带 `raw.conflict`；调用方应重读最新版本后重放。
  - **预演与破坏性判定**：`hana_view_update(dryRun=true)` 只读预演（结构 diff + 影响半径 + 破坏性判定，零写入）；破坏性变更须声明 `migration.strategy`（`cast` / `preserve_column` / `move` / `acknowledge_dependents`），未声明 ⇒ `migration_required` 拒绝且零写入。声明只被记录，不触发自动迁移。
- **超时与资源治理**：
  - XS REST 全部请求都有超时（登录/取 CSRF 更短）；xfer 导入导出单独放宽：`HANA_XS_TIMEOUT_MS` / `HANA_XS_XFER_TIMEOUT_MS`。
  - 写路径五条 SQL 语句有语句超时（`HANA_SQL_TIMEOUT_MS`）；不设全局默认是有意的（`hana_sql_analyze` 与元数据搜索是合法长语句）。
  - 连接池上限/排队超时/排队上限可配（默认 4 / 30s / 64）；部署建议：每个代理一个进程，N 个代理 = N×`HANA_POOL_MAX` 条连接。
  - 服务端激活有进程内并发信号量（`HANA_ACTIVATION_CONCURRENCY`，默认 2）：本 SPS 写入即激活，保护面是**所有会触发激活的写**；import 上传通道、建包 POST 与 DELETE 不在覆盖内。
  - keyed lock 排队等待超时默认 60s：超时者不执行该次写。
- 视图定义缓存：TTL 60s + 容量 200 条 LRU；写路径成功后立即失效本进程缓存（跨进程由 `VERSION_ID` 轻校验兜底）。
- 上述锁均为**进程内**：多进程/多实例部署同一 HANA 时需外部串行化（本服务设计为单实例）。
- **多代理编排建议**：按依赖连通分量切分，一个分量一个写者；写者数量 2–4 个后集成开销上升；冲突后按 REFRESH（412 的 `currentETag` 重读）→ REPLAN 处理。
- 未内置 OAuth 等完整认证体系：暴露到网络时配置 `MCP_HTTP_TOKENS` 并置于反向代理 / VPN / 防火墙之后。
- 日志走 stderr，不污染 HTTP 协议通道；401 日志不记录 Authorization 头内容。

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
- **拦截消息不含补救路径**：返回给模型的拦截消息只陈述事实（维度/规则码/请求内容/生效策略），不写"改哪项配置可放行"；补救指引只在运维向位置（启动自检与本文档）。
- **部署级不变量（启动即拒绝）**：① HTTP 非回环监听且无 Bearer Token → 拒绝启动（除非 `MCP_HTTP_ALLOW_ANONYMOUS=true`）；② `HANA_TLS=false`、③ 加密但 `HANA_SSL_VALIDATE=false`、④ XS 写通道明文（未置 `HANA_XS_TLS=true`）→ 告警放行，但每次启动可见。
- **读范围边界**：受约束的是「按名指定 schema 去读」（`schema` 不在 `HANA_READ_SCHEMA` 即被拦）；不约束已激活视图自身定义的读取、`hana_data_preview` 视图预览、仓库包维度与 `hana_table_storage` 省略 schema 时的全库统计。
- **审计**：每次调用落地一条 `capability-audit`；写能力每次尝试一条终态 `denied | completed | failed`。持久化由部署方负责。

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
