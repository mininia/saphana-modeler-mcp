# saphana-modeler-mcp

> 🌐 中文 | [English](README.en.md)

SAP HANA 经典 Modeler 能力的 MCP 服务器（TypeScript，Node >= 20.12）。面向本地部署 HANA 2.0
（经典 `_SYS_REPO` 仓库建模），提供信息视图（计算视图/属性视图/分析视图）与仓库对象的
**元数据浏览、数据预览、血缘查询与建模写操作**。

通过 MCP 协议接入 Claude / IDE 等客户端（**stdio / Streamable HTTP 双传输**）：调用工具即可浏览、校验与（在配置的可写包内）创建计算视图，无需打开 HANA Studio。

## 项目目标

**让 AI 独立完成 SAP HANA 的开发。**

不是给它一个 SQL 窗口，而是让它像建模工程师那样工作：看懂仓库里已有什么、对象之间怎么关联，
判断该改什么、怎么改，动手改，再自己确认改对了——**语义能被理解，动作能被完成，边界可控**。

当前目标是覆盖经典仓库建模与执行计划分析；未来计划有权限角色、数据传输与运维动作等内容。

## 功能概览

| 分类 | 能力 | 工具 |
| --- | --- | --- |
| 系统 | 版本信息、用户权限与建模能力自检 | `hana_system_get_info`、`hana_check_privileges` |
| 稳定性诊断 | 实例体检（**读数层**：内存%/磁盘与卷 IO/备份距今/内存分配失败率… + **结论层**：磁盘/服务/备份/内存/CPU/告警/阻塞/长事务/复制/配置/弃用特性/加密**十二项**，**三态**：正常/异常/看不见）、会话与阻塞深潜（谁堵谁）、表存储画像（内存/磁盘/碎片/热度/分区/列级/索引级）、历史趋势（过去 N 天的 CPU/内存/磁盘/网络） | `hana_system_health`、`hana_system_activity`、`hana_table_storage`、`hana_system_trend` |
| 包 | 包清单/包树、包内对象（含激活状态）、新建包 | `hana_package_list`、`hana_package_list_objects`、`hana_package_create` |
| 元数据 | 完整定义读取、对象搜索、字段清单、单字段逻辑溯源、血缘 | `hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used` |
| 表目录 | 可访问表清单、表列结构 | `hana_table_list`、`hana_table_columns` |
| 数据预览 | 已激活视图数据预览（整体/节点/推导三通道，支持筛选与输入参数）+ 预览权限诊断 | `hana_data_preview`、`hana_data_preview_diagnose` |
| 建模写操作 | 新建/激活/更新/删除计算视图、设计时+运行时校验、校验动作查询 | `hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions` |
| 仓库传输 | 包导出备份（zip）、设计时文件导入、变更列表 | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist` |
| SQL 分析 | SQL 分析结论（默认）：扫描/规模/连接/引擎切换/结构异常的**逐条发现 + 建议 + 统计**；`analyze=true` 走 PlanViz 拿**逐算子实测**六栏（瓶颈/实际行数/时间轴/并行度）；原始执行计划需 `raw=true` | `hana_sql_analyze` |

> 视图对象的完整定义读取（json/xml）由 `hana_metadata_get_view` 提供；字段级查看用 `hana_metadata_list_fields` / `hana_metadata_get_field_logic`。

## 快速开始

**方式一：npx 一键运行（无需克隆，推荐试用）**

```bash
npx github:mininia/saphana-modeler-mcp   # 自动 clone + 构建 + 启动
```

需配合下方「MCP 客户端接入」的配置，把 `command` 换成 `npx`、`args` 换成 `["github:mininia/saphana-modeler-mcp"]` 即可。

**方式二：克隆本地运行（开发/自定义）**

```bash
git clone https://github.com/mininia/saphana-modeler-mcp.git
cd saphana-modeler-mcp
npm install          # 首次安装后需 npm approve-scripts @sap/hana-client（预编译二进制）
cp .env.example .env # 填写真实 HANA 连接
npm run build
node scripts/smoke-stdio.mjs   # 冒烟：握手 + 工具注册（无需真实 HANA）
```

MCP 接入：将 `mcp.json.example` 复制为 `mcp.json` 并填入真实连接（`mcp.json` 与 `.env` 均已 gitignore，
**请勿提交**）。各客户端接入要点见下方「MCP 客户端接入」。

## 配置参数

连接信息只允许来自环境变量 / `mcp.json` 的 `env`（**仅 stdio 模式生效**）/ `.env` 文件，不提供默认值，缺失时服务启动即失败。

| 运行方式 | 配置实际来源 |
| --- | --- |
| **stdio**（MCP 客户端拉起进程） | 客户端 `mcp.json` 的 `env` 由客户端注入为子进程环境变量 → 等价于环境变量；凭据三件套（`HANA_HOST`+`HANA_USER`+`HANA_PASSWORD`）齐全时 **不再读 `.env`** |
| **Streamable HTTP**（自行 `npm start` / 容器启动） | 没有客户端拉起进程，**`mcp.json` 不参与**；来源为 shell/容器环境变量 → 兜底 `.env` |

`.env` 查找顺序为 **工作目录 → 项目根**（`dist/` 上两级），且**逐变量生效**——`process.loadEnvFile` 不覆盖已存在的环境变量。因此三件套只有一部分来自外部环境时会跨来源混用（典型：shell 里残留的 `HANA_USER` 覆盖 `.env` 中的用户名，其余仍取 `.env`），可能连接到另一套环境。服务检测到连接目标/凭据来自多个来源时，会在启动日志 **warn** 并列出每个变量的来源，请据此清理多余的环境变量。

| 配置项 | 必填 | 说明 | 示例 |
| --- | --- | --- | --- |
| `HANA_HOST` | ✅ | HANA 主机名/IP | `hana-host.example` |
| `HANA_INSTANCE` | 可选 | 实例号（00–99），默认 `00` | `10` |
| `HANA_PORT` | 可选 | SQL 端口；留空按实例号自动推导 | `31015` |
| `HANA_USER` | ✅ | 数据库用户名 | — |
| `HANA_PASSWORD` | ✅ | 密码 | — |
| `HANA_LOCALE` | 可选 | 连接语言，默认 `zh_CN` | `zh_CN` |
| `HANA_DB_NAME` | 可选 | 租户数据库名（MDC 必填） | `SYSTEMDB` / 业务租户名 |
| `HANA_TLS` | 可选 | TLS 加密，默认 `true`（fail-closed；仅可信链路显式 `false`） | `true` |
| `HANA_SSL_VALIDATE` | 可选 | TLS 下校验证书，默认 `true`；自签证书环境显式 `false` | `true` |
| `HANA_TIMEZONE` | 可选 | 进程时区（设置 `TZ`，影响日志时间戳与本地时间语义）；**不下发 HANA 会话**。默认 `Asia/Shanghai` | `Asia/Shanghai` |
| `HANA_SCHEMA_ALLOW` | 可选 | 追加允许查询的 schema（逗号分隔，追加到内置白名单） | `SAPABAP1,OTHER_SCHEMA` |
| `HANA_WRITE_PACKAGES` | 可选 | 允许写操作的仓库包前缀（逗号分隔，含子包）。**空 = 未启用写边界**：声明写包的请求会被运行期闸门以 `boundary_off` 硬拦（要写就必须显式配置；只有服务层那一层是 fail-open，见下方「写操作安全边界」）；填写后仅允许配置包及其下级子包写操作 | `ZDEMO1,ZDEMO2.ZDEMO_SD` |
| `HANA_XS_PORT` | 可选 | XS Classic 设计时 REST 端口（写路径）；省略按实例号推导 `80<instance>` | `8010` |
| `HANA_XS_BASE_PATH` | 可选 | XS 设计时 REST 基础路径，默认 `/sap/hana/xs/dt/base` | — |
| `HANA_POOL_MAX` | 可选 | HANA 连接池并发上限，默认 `4`。**部署建议：每个代理一个进程，N 个代理 = N×该值条 HANA 连接** | `8` |
| `HANA_POOL_WAIT_MS` | 可选 | 池满后的排队等待超时（ms），默认 `30000`；到时仍拿不到连接即以可读错误失败，不会无限期挂住 | `60000` |
| `HANA_POOL_MAX_WAITERS` | 可选 | 排队上限（个），默认 `64`；超出立即失败，防请求无限堆积 | `128` |
| `HANA_SQL_TIMEOUT_MS` | 可选 | 写路径五条 SQL 语句（存在性检查/兜底直写/行探测/影响半径的下游查询/REPOSITORY_REST 调用）的语句超时，默认 `60000`。**不设全局默认是有意的**：`hana_sql_analyze`（最长 5 分钟）与元数据搜索是合法长语句 | `120000` |
| `HANA_XS_TIMEOUT_MS` | 可选 | XS REST 请求默认超时（ms），默认 `30000`；覆盖全部走该出口的调用（含读内容/读元数据；登录/取 CSRF 另有更短的固定超时） | `60000` |
| `HANA_XS_XFER_TIMEOUT_MS` | 可选 | XS Transfer（xfer）导入/导出超时（ms），默认 `300000`（整包上传/下载天然慢，单独放宽） | `600000` |
| `HANA_ACTIVATION_CONCURRENCY` | 可选 | 服务端激活的并发上限（进程内信号量），默认 `2`。**本 SPS 写入即激活**，故保护面是**所有会触发激活的写**（xs_rest 通道的 create/update/activate 文件写，以及设计时校验的临时副本写），不只是显式 `activate=true`；**已知边界（不在覆盖内）：import 走 Transfer API 上传通道**（其超时按 xfer 放宽，长期占用许可会饿死其它写），**建包 POST 与 DELETE 也不在内**（只建目录 / 只删除，不触发服务端激活）。激活是重操作（2–10s/次），多代理并发激活需限流 | `4` |
| `MCP_TOOL_GROUPS` | 可选 | 启用的工具功能分组（逗号分隔 `read`/`write`/`admin`）；**空=不限制（全部分组启用）** | `read` |
| `MCP_TOOL_ALLOW` | 可选 | 强制启用的工具名 glob（即便其分组未启用也注册；逗号分隔，支持 `*` 通配） | `hana_view_validate` |
| `MCP_TOOL_DENY` | 可选 | 强制禁用的工具名 glob（优先级最高，覆盖 allow 与分组；逗号分隔，支持 `*` 通配） | `hana_data_preview*` |
| `MCP_PROFILES` | 可选 | **调用方档案**（`name=kinds[:glob\|glob][;…]`，kinds 用 `+` 连接）。档案**只能收紧**部署策略；配了就必须定义 `default` | `analyst=read;dev=read+write:hana_view_*;default=read` |
| `MCP_PROFILE` | 可选 | 本进程（stdio）与"无档案身份的调用方"使用的档案名，须在 `MCP_PROFILES` 中定义 | `default` |
| `MCP_AGENT_LABEL` | 可选 | 进程级归因标签：写进 envelope 与每条 `capability-audit`；空 = 不产生该字段 | `prod-cn-01` |
| `MCP_CAPABILITY_SURFACE_MAX` | 可选 | 单调用方的**提升预算**（默认 50，1..1000，与 hana-cli 的 `MAX_DYNAMIC_TOOLS` 同值）；按**工具数**算，超出时最旧的分类整体淘汰（FIFO） | `100` |
| `LOG_LEVEL` | 可选 | 日志级别，默认 `info` | `debug` |
| `MCP_HTTP_PORT` | 可选 | Streamable HTTP 端口；设置后以 HTTP 模式启动（端点 `/mcp`），未设置 = stdio（默认）。`0` = 随机端口 | `3000` |
| `MCP_HTTP_HOST` | 可选 | HTTP 监听地址，默认 `127.0.0.1`（仅本机，fail-closed）；对外暴露需显式配置（如 `0.0.0.0`） | `127.0.0.1` |
| `MCP_HTTP_TOKEN` | **已废弃** | 保留仅为向后兼容，等价于 `MCP_HTTP_TOKENS=shared:<token>`（读入同一张 Token→身份表，401 语义与归因不变）；计划在下一个大版本删除。新部署请直接用 `MCP_HTTP_TOKENS` | — |
| `MCP_HTTP_TOKENS` | 可选 | **多客户端 Token → 身份映射**（逗号分隔 `name:token[:profile]`）：每个 Token 对应一个 `clientId`，第三段（可选）指定该身份的**调用方档案**，二者一起进 `envelope` 与审计日志（多客户端共享同一 HANA 账号时的唯一归属来源）。`name` 限 `[A-Za-z0-9_.-]{1,32}`，`token` ≥16 字符**且不得含冒号**（冒号已用于分隔身份与档案）；重复/非法则启动失败。可与 `MCP_HTTP_TOKEN` 并存 | `alice:<token>:dev,bob:<token>` |
| `MCP_HTTP_ALLOWED_HOSTS` | 可选 | 允许的 Host 头主机名（DNS rebinding 防护；逗号分隔，不含端口，IPv6 带方括号），默认仅本机名 | `localhost,myhost.corp` |
| `MCP_HTTP_ALLOWED_ORIGINS` | 可选 | 允许的 Origin 主机名（逗号分隔，不含 scheme/端口；无 Origin 头的请求放行）。**未设置时继承 `MCP_HTTP_ALLOWED_HOSTS`**，显式置空 = 拒绝一切带 Origin 的请求 | `localhost` |
| `MCP_HTTP_ALLOW_ANONYMOUS` | 可选 | 显式承认「对外监听且不配置任何 Bearer Token」的风险（默认 `false`）。**非回环监听 + 无 Token 时默认拒绝启动**（该姿态下写边界/工具分组/schema 白名单全部形同虚设）；确实需要（如已置于带认证的反向代理之后）再显式置 `true` | `false` |

## 传输方式

支持两种 MCP 传输，由 `MCP_HTTP_PORT` 是否设置切换（其余工具/配置完全一致）：

| 传输 | 启用方式 | 适用场景 |
| --- | --- | --- |
| **stdio**（默认） | 不设置 `MCP_HTTP_PORT` | Claude Desktop / Cursor / VS Code 等本地客户端，随客户端进程拉起 |
| **Streamable HTTP** | 设置 `MCP_HTTP_PORT`（如 `3000`）后 `npm start`（或 `node dist/index.js`） | 远程/容器化部署、多客户端共享一个服务实例、支持 `url` 接入的 MCP 客户端 |

HTTP 模式要点：

- 端点 `http://<host>:<port>/mcp`（仅此路径，其余 404）；无状态按请求服务（2025/2026 协议版本客户端均可接入），连接池共享
- **会话与隔离**：本服务**无会话**——每个请求新建协议实例、无 `Mcp-Session-Id`、无会话级状态，因此不存在跨会话串扰与会话劫持面；相应地也没有会话级配额/取消。隔离粒度 = 单个服务进程：所有客户端共享同一连接池、同一工具可见性配置、同一可写包白名单
- **安全默认（fail-closed）**：
  - 仅绑定 `127.0.0.1`，Host/Origin 白名单默认仅本机名（DNS rebinding 防护）。对外暴露需同时：`MCP_HTTP_HOST=0.0.0.0` + `MCP_HTTP_ALLOWED_HOSTS` 放行对外主机名（浏览器类客户端再放行 `MCP_HTTP_ALLOWED_ORIGINS`）
  - **认证**：设置 `MCP_HTTP_TOKEN`（≥16 字符）后所有请求强制 Bearer Token 校验（缺失/不匹配 → 401）；未设置时回环监听即为访问边界。**对外监听且无 Token 时默认拒绝启动**（配置自检的阻断级不变量，见下），确需如此须显式 `MCP_HTTP_ALLOW_ANONYMOUS=true`，届时启动日志每次都会告警
  - 请求体上限 10MB（超限 413）；chunked 流式上传无 Content-Length 头，请交由反向代理限长
- **客户端身份归因**：`MCP_HTTP_TOKENS` 把每个 Token 映射为独立 `clientId`，随请求上下文贯穿到工具层——
  - 每次工具调用返回的 envelope 带 `clientId`（stdio 模式无此字段，形态与既有版本一致）
  - 每个写操作在服务端日志留一条审计记录（`clientId` + 包 + 对象）；stdio 模式日志不含 `clientId`
  - 为什么需要它：数据库身份是进程级单一技术账号（`HANA_USER`），`_SYS_REPO` 的 `OWNER`/`ACTIVATED_BY` 只能记到该账号，**多客户端下仓库侧无法区分调用方**
  - 未配置任何 Token（回环默认边界）时所有请求归为 `anonymous`
- **并发与锁**（多客户端共享一个实例时的实际边界；逐条写明已知例外）：
  - **保护矩阵**（锁均为进程内 keyed lock，按「包/对象」串行化）：
    - **新建**（`hana_view_create`）：进程内按对象互斥（存在性检查 + 写入原子），并发同名创建后者显式报冲突。**已知例外**：XS REST 的 PUT 是 create-or-update，**跨进程同名创建服务端无 409** ⇒ 跨进程并发同名创建 = last-write-wins；回执带写入后的版本与新 ETag（来源见下）
    - **更新**（`hana_view_update`）：锁内先读基线（读时取 ETag），再读内容、PUT——全程同一临界区；并发改动以 412 显式冲突返回，不静默覆盖
    - **激活**（`hana_view_activate`）：**新增 `If-Match`**——锁内「读元数据取基线 → 读内容 → 带 If-Match 的 PUT」在同一临界区，消除「激活把他人刚提交的改动静默回退」的窗口
    - **删除**（`hana_view_delete`）：**新增 `If-Match`**——锁内取基线后删除；服务端语义已实测：正确基线 → 204、陈旧基线 → 412、对象已不存在 → 404
    - **设计时校验**（`hana_view_validate` design 模式）：内容读取移入锁内；临时校验对象 `_CHKTMP` 名带短哈希且**总长不超过 29 字符**；**只删除本次调用确实创建过的临时名**——推导名与既有真实对象重名时拒绝执行（不删不改）
    - **导入**（`hana_repo_import`）：按目标文件名（剥掉设计时后缀）加锁；存在性检查**仅把 404 视为不存在**（403/网络错误一律不吞）；写入后回读校验。**跨进程竞态无服务端前置**，属已知例外
  - **冲突回执（对调用方是破坏性变化）**：412 与 delete 的 404 不再返回 MCP 硬错误文本，而是**业务失败信封**——`success=false`、`messages` 里的 id 为 `'412'` 或 `'OBJECT_NOT_FOUND'`；其中 412 与 **DELETE 动词返回的 404**（对象在删除前读之后才被并发删除）带 `raw.conflict = { httpStatus, providedEtag?, currentETag?, currentVersion?, activatedAt?, currentUnavailable? }`；**删除前置存在性读的 404**（对象本就不存在）只有机读码、不带该载荷。`currentETag` 是**冲突时点补读**得到的当前 ETag（实测 412 响应本身不带 ETag 头），不是本次写的新基线。成功回执带新基线：create/update/activate 的 `etag` 来自**写响应头**（`etagSource=response-header`；响应头缺失时省略 `etag` 并标 `etagSource=unavailable`，**不补读冒充**）——该基线**仅 xs_rest 通道有**：走 repo_rest / inactive_object 通道的 create 不经过 XS 写响应头，回执不带 `etag`/`etagSource`；delete 的来自删除前的基线读、import 的来自写入后的回读（`etagSource=read-back`）。代理可据此「自动重读 → 重放意图」，不必把冲突抛给人
  - **已知边界（实测）**：同一设计时文件的**并发写**在服务端可能以写错误被拒（HTTP **555**、`raw.errorDetail.checkResult.Operations.Write=false`、**写未发生**），而不是 412 前置条件失败。该路径的回执**不带** `raw.conflict`（缺省是刻意的——不拼装伪冲突载荷），但 `raw.errorDetail.httpStatus` 与 `checkResult.Operations.Write` 可机读。调用方应**重读最新版本后重放**——不要把它当冲突自解，也不要当作已写入
  - **预演与破坏性判定（P6）**：`hana_view_update` 支持 `dryRun=true` **只读预演**——读取当前设计时定义、应用本次 xml/operations 变换后返回**归一化结构 diff + 影响半径（直接下游（单跳）；需要传递影响面用 `hana_metadata_where_used(depth)`）+ 破坏性判定**，**一次写都不发生**（不 PUT、不激活、不发 probe），回执以 `mode=dryRun` 与成功写入区分。破坏性变更（判定表：该视图**有下游引用**时的改输出字段类型 / 删字段 / 改名 / 改输出节点接线 / 改数据源）**必须**经 `migration`（`{ strategy: cast | preserve_column | move | acknowledge_dependents }`）显式声明策略才放行（前三个是**字段级迁移策略**——描述下游字段怎么迁：重铸 / 保列新建 / 随改名迁移；`acknowledge_dependents` 是**调用方显式承担下游破坏、不做字段级迁移**的声明位，三种字段级策略都不适用时用它，如整段回退）；未声明 ⇒ 服务端在写入前拒绝（机读码 `migration_required`、破坏项明细 `raw.errorDetail.breaking.items` 随回执给出），**一次写都不发生**。声明只被服务端记录（审计），**不触发任何自动迁移动作**——下游视图的处理交给编排层按影响半径（单跳）决定。删除同理：`hana_view_delete` 对被下游引用的视图要求声明 `migration.strategy=acknowledge_dependents`；无下游引用时**放行语义**与既有版本一致，但删除前会多一次跨引用查询（`_SYS_REPO.ACTIVE_OBJECTCROSSREF` 的影响半径）——该查询失败（无权限/超时）会让删除失败，P6 之前的版本没有这个依赖。另注意一条**判定豁免通道**：`hana_repo_import(overwrite=true)` 可整文件覆盖已有视图定义（备份恢复用的逃生舱），**不做破坏性判定**（不经 dryRun / migration 闸门）；要评估影响请先对目标跑 `dryRun` 或改用 `hana_view_update`
  - **超时与资源治理**（防一个代理拖垮全池）：
    - XS REST 的**全部**请求都有超时——含读内容/读元数据/登录（登录与取 CSRF 用更短的固定超时），xfer 导入导出单独放宽：`HANA_XS_TIMEOUT_MS` / `HANA_XS_XFER_TIMEOUT_MS`
    - 写路径五条 SQL 语句有语句超时（存在性检查/兜底直写/行探测/影响半径的下游查询/`REPOSITORY_REST` 调用），`HANA_SQL_TIMEOUT_MS`；**不设全局默认是有意的**：`hana_sql_analyze`（最长 5 分钟）与元数据搜索是合法长语句
    - 连接池上限 / 排队超时 / 排队上限可配（`HANA_POOL_MAX` / `HANA_POOL_WAIT_MS` / `HANA_POOL_MAX_WAITERS`，默认 4 / 30s / 64）：池满时排队，超限/超时以可读错误返回而不是无限期挂住。**部署建议：每个代理一个进程，N 个代理 = N×`HANA_POOL_MAX` 条 HANA 连接**（⚠ `hana_sql_analyze` 的 `analyze=true` 单次最多执行 5 分钟，期间占住一个池位：并发跑大语句时，其他调用可能等不到连接）
    - 服务端激活有进程内并发信号量（`HANA_ACTIVATION_CONCURRENCY`，默认 2）：**本 SPS 写入即激活**（任何合法 PUT 都会被服务端激活，`activate` 参数只决定失败是否透出），故保护面是**所有会触发服务端激活的写**——xs_rest 通道的 create/update/activate 文件写与设计时校验的临时副本写，不只是显式 `activate=true`；**已知边界（不在覆盖内）**：import 走 Transfer API 上传通道（其超时按 xfer 放宽，长期占用许可会饿死其它写），建包 POST 与 DELETE 也不在内——无实测证据表明它们触发服务端激活（前者只建目录、后者只删除），故不按激活限流。keyed lock 管「同对象」、信号量管「全局并发」，不可互相替代
    - keyed lock 有排队等待超时（默认 60s）：超时者**不执行**该次写——不会出现「报超时但写已经发生」
  - 视图定义缓存：TTL 60s + 容量 200 条 LRU，防止多客户端拉取把内存撑大；写路径成功后**立即失效本进程缓存**（跨进程由 `VERSION_ID` 轻校验兜底）——它只是把「最多 60s 后自愈」变成「立即」，**不是正确性依赖**
  - 上述锁均为**进程内**：多进程/多实例部署同一 HANA 时需外部串行化（本服务设计为单实例）
  - **多代理编排建议（本服务只提供事实，不做编排）**——子代理默认是**多进程**拓扑（每个子代理一个 stdio 进程），进程内锁彼此不可见，正确性只能由 ETag/If-Match 与 HANA 侧状态兜底。据此的推荐切分：
    - **按依赖连通分量切分，一个分量一个写者**：用 `hana_metadata_where_used(depth="all")` 的下游闭包把目标对象分组成连通分量，每个分量只交给一个写者；跨分量之间若只有**只读**依赖，不构成写冲突
    - **为什么不是"提示词约定划分文件"**：外部实证（CAID/OpenHands）显示，共享工作区 + 提示词层软隔离**防不住并发写碰撞**——上下文共享没有事件序，约定一定漏；这正是不变量「每条写路径要么 If-Match、要么幂等」存在的原因（进程内锁只是加速器）
    - **写者数量有天花板**：实证与生产观察都是 2–4 个并发写者之后集成开销上升、稳定性下降；写操作宁可串行化在少量写者上
    - **冲突后的动作顺序**：REFRESH（用 412 回执的 `raw.conflict.currentETag` 重读最新）→ REPLAN（基于最新版本重放意图），**优先于**任何盲目合并；重读后重放即可，不必把冲突抛给人
    - **写者的"影响面"自知**：破坏性判定与变更集回执都带影响半径/下游清单，编排层可据此把「谁碰了谁」对齐到分量划分上；`changeset` 模式内的**对象级读/写集相交**已在服务端整批拒绝，编排层的跨代理切分与它是互补关系（服务端管一次调用内，编排层管多次调用之间）
- 未内置 OAuth 等完整认证体系：暴露到网络时请配置 `MCP_HTTP_TOKEN` / `MCP_HTTP_TOKENS` 并置于反向代理 / VPN / 防火墙之后
- 日志仍走 stderr，不污染 HTTP 协议通道；401 日志不记录 Authorization 头内容；Token 原文不驻留于比对结构、不回显到错误信息

```bash
MCP_HTTP_PORT=3000 MCP_HTTP_TOKEN='your-long-random-token' node dist/index.js
# → 已就绪（streamable HTTP transport，端点 /mcp），监听 http://127.0.0.1:3000/mcp
```

## 工具分组与可见性控制

30 个业务能力（28 + 异步任务查询/取消）按功能划分为三组。**注意（2026-10-09 起，门面制）：注册面上只有六个分类门面**——具体能力不进 `tools/list`，经门面索引 + 门面路由调用（见「动态调用面」）。本节的可见性配置管的是**可触达上限**（哪些能力"存在且有权用"），不等于注册面。可经 mcp.json / .env 的环境变量控制可见性（不可见的工具不出现在 `tools/list`、不可被直调、门面索引里也查不到）。

### 三类分组

| 分组 | 说明 | 能力 |
| --- | --- | --- |
| **read** 数据读取 | 访问 HANA 数据/元数据/系统信息，不改动仓库 | `hana_system_get_info`、`hana_check_privileges`、`hana_package_list`、`hana_package_list_objects`、`hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used`、`hana_table_list`、`hana_table_columns`、`hana_data_preview`、`hana_data_preview_diagnose` |
| **write** 写操作 | 改动仓库设计时对象/包（create/activate/update/delete/设计时校验）、接受任意 SQL 的分析、取消异步任务 | `hana_package_create`、`hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions`、`hana_sql_analyze`、`hana_task_cancel` |
| **admin** 管理操作 | Transfer / Change-Tracking API 与系统监视面（暴露面收敛的一档） | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist`、`hana_system_health`、`hana_system_activity`、`hana_table_storage`、`hana_system_trend` |

> 分组（kind）是**权限层级**而非"行为画像"：本表里既有"行为只读但归 admin 档"的能力（稳定性诊断四件套、
> `hana_repo_changelist`，以及 `hana_repo_export`——它只往**本地**写 saveTo 文件），也有"接受任意 SQL 但归 write 档"的
> `hana_sql_analyze`。客户端注解（`readOnlyHint`）描述的是**行为**，两者不互相推导。
>
> `hana_view_validate` 的 `design` 模式会短暂写入临时校验对象 `_CHKTMP`，故整工具归 `write`；不按 design/runtime 模式做混合划分，只读部署（`MCP_TOOL_GROUPS=read`）不暴露此工具。
>
> 每个非 read 档能力都显式声明了 `effects.plan`（资源计划）：读能力不落写兜底（`packageId` 是"读哪个包"，不是写包），
> 行为只读但归 write/admin 档的能力同样显式声明——否则会把 `packageId` 误判成写包。清单完整性测试钉住这条（`tests/unit/capability-manifest.test.ts`）。
>
> **门面层不做限制（2026-10-09 定稿）。** 权限只有**一层 group（能力层）**：六个门面是**入口**，任何分组配置下都常驻 `tools/list`（只有显式 `MCP_TOOL_DENY` 命中门面 id、或 deny 掉它全部成员才会消失）。分组开关只决定**能力层**——索引 / 路由 / 提升 / 调用一律按**目标能力**的 kind 判。所以只读部署照样看得到 `hana_modeling` / `hana_diagnostics`，只是它们的索引为空（入口在、里面没有你可用的能力）。

### 三个配置变量（优先级：`MCP_TOOL_DENY` > `MCP_TOOL_ALLOW` > `MCP_TOOL_GROUPS`）

> **改名（2026-10-08）**：这三项管的是 **MCP 服务端的暴露策略**，与 HANA 连接无关，故前缀从 `HANA_` 改为 `MCP_`。
> 旧名 `HANA_TOOL_GROUPS` / `HANA_TOOL_ALLOW` / `HANA_TOOL_DENY` **仍然生效**（启动时告警提示迁移）；
> 新旧两名同时给出且取值不同会**启动失败**（避免"生效的是哪一个"含糊）。
> 另外：任何未识别的 `HANA_*` / `MCP_*` / `LOG_*` 变量现在都会在启动日志里告警——
> 此前拼错的变量名会被静默忽略（例如把 `HANA_WRITE_PACKAGES` 写成单数，写边界就悄悄失效了）。

| 变量 | 语义 | 例 |
| --- | --- | --- |
| `MCP_TOOL_GROUPS` | 启用的分组（逗号分隔）；空=不限制 | `read` 仅暴露数据读取，关闭全部写工具 |
| `MCP_TOOL_ALLOW` | 强制启用的工具（即便其分组未启用也注册），支持**组名**与工具名 glob（`*`），用于分组开关外单独放行 | `hana_some_tool` / `write`（整组放行） |
| `MCP_TOOL_DENY` | 强制禁用的工具（优先级最高），同样支持**组名**与 glob | `hana_data_preview*` 关闭所有预览工具；`write` 关闭整组写工具 |

> **组名可直接用于 allow/deny**（`read` / `write` / `admin`），会展开为该组全部工具名——与 tableau-mcp 的
> `INCLUDE_TOOLS`/`EXCLUDE_TOOLS` 组展开、dataworks-mcp 的 `TOOL_CATEGORIES` 同形。
> 例：`MCP_TOOL_GROUPS=read,write` + `MCP_TOOL_DENY=write` ⇒ 等价于只读部署，且不必逐个写 `hana_view_*`。

**典型部署形态：**

- **只读分析师**：`MCP_TOOL_GROUPS=read` —— 可触达上限收窄到 13 个 read 档能力，全部 write/admin 档能力连门面索引里都看不到。注册面仍是六个门面（门面层不做限制），但 `hana_modeling` / `hana_diagnostics` 的**索引为空**——入口可见、里面没有你可用的能力。
- **建模开发者**：`MCP_TOOL_GROUPS=read,write` —— 上限为 read+write 档，六个门面全在注册面上（admin 档的 `hana_repo_export`、诊断四件套等不可达，索引里也不出现）。
- **关闭特定能力**：`MCP_TOOL_DENY=hana_view_delete` —— 仅禁用删除（索引里列不出来、按 id 路由也拒），其余不受影响。

启动时若配置了过滤变量，日志会打印启用分组与被关闭的工具清单，便于确认配置符合预期。未知分组名（如 `MCP_TOOL_GROUPS=read,bogus`）启动即失败（fail-closed）。

### 调用方档案（MCP_PROFILES）

多客户端共享一个进程时，每个调用方可以有自己的**面**（能调什么），而不只是"谁在调"：

```bash
# name=kinds[:能力glob|glob]，kinds 用 + 连接；; 分隔多个档案
MCP_PROFILES="analyst=read;dev=read+write:hana_view_*|hana_metadata_*;default=read"
MCP_PROFILE=default                                            # stdio 进程用的档案
MCP_HTTP_TOKENS="alice:<token>:dev,bob:<token>:analyst"        # 第三段 = 该身份的档案
```

- **只能收紧、不能放宽**：档案永远不能把部署级 `MCP_TOOL_DENY` 掉的能力变回来，也不能扩大可写包/可读 schema 的范围。
  越界组合（如 `MCP_TOOL_GROUPS=read` 的只读部署里写了 `dev=read+write`）**启动即拒绝**——不是漏洞，而是"以为的权限"与"实际权限"分叉。
- **配了 `MCP_PROFILES` 就必须定义 `default`**：HTTP 里不带第三段的 Token 与 stdio 进程都落它，缺了会把"没指定档案"误读成"没有限制"。
- 判定发生在**调用期**（`authorizeCall`），拦截回执与其它策略拦截同形（「被 MCP 安全策略拦截」+ 机读码，**不含**补救路径）。
- 每次调用都会落地 `capability-audit`（含 `profileId` / `clientId` / `agentLabel` / `resources` / `codes`），放行记 info、拦截记 warn。
- 档案名解析失败（配了档案却查不到条目）→ **空档案 = 全拒**（fail-closed）。

实机验收：`npm run smoke:http`（用两个档案演示隔离：只读档案调用写能力得到 `kind_not_allowed_by_profile`，默认档案落回部署边界 `boundary_off`）。

## 动态调用面（分类门面 + 按分类提升）

具体能力**一个都没少**（都在清单里、都能被调到）；**注册面上只有六个分类门面**——具体能力默认不进 `tools/list`，全部**按需索引、按需提升**（参照 SAP hana-cli 的 `discover_by_category` + `hana_execute` 的**静态探路版**）：

```
注册面（这次连接实际注册的工具） = (六个门面 ∪ 已提升分类的成员) ∩ 部署策略 ∩ 调用方档案
可触达上限（你能不能调它）        = 部署策略 ∩ 调用方档案          ← 索引、路由与提升都按它判定
```

模型看到的是三层，**零发现调用**：

| 层 | 内容 | 到模型的方式 |
|---|---|---|
| 门面 | `hana_system` / `hana_discovery` / `hana_data` / `hana_insights` / `hana_modeling` / `hana_diagnostics`，描述带**成员清单** | 常驻 `tools/list` |
| 索引 | 该类的具体能力（id / 标题 / kind / 一句话摘要 / 参数名） | 调门面**不带参数** |
| 提升 | 该类的具体能力变成一等工具（**带完整 schema、可平铺直调**） | 调门面（任何形式）自动触发 |
| 操作级别名 | `hana_view_update#<op>`（8 条）：单发一个 operations 操作的**路由别名**，不注册为工具 | 调门面带 `capability: 'hana_view_update#rename_field'` |

| 干什么 | 怎么做 |
|---|---|
| 看某类有什么 | `hana_modeling({})` → 返回 modeling 类的能力索引（只列你有权用的） |
| 调具体能力（不提升） | `hana_modeling({ capability: 'hana_view_update', args: { … } })` |
| 单发一个操作（别名） | `hana_modeling({ capability: 'hana_view_update#rename_field', args: { packageId, objectName, field: 'A', newName: 'B' } })` —— 与 `hana_view_update({ operations: [{ op: 'rename_field', … }] })` 完全等价（同一 handler、同一闸门）；别名**不进 tools/list**（注册名会与父工具撞名），只经门面路由 |
| 提升整类 | 调 `hana_modeling`（带不带参数都算）→ 该类能力进 `tools/list`，此后可 `hana_view_update({ … })` 平铺直调 |
| 拿掉一整类入口 | `MCP_TOOL_DENY=hana_modeling`，或 deny 掉它全部成员 |
| 拿掉个别能力 | `MCP_TOOL_DENY=hana_view_delete` —— 索引里列不出来，路由与提升也够不着 |
| 按分组收窄 | `MCP_TOOL_GROUPS=read` —— 只收窄**能力层**（六个入口常驻，索引按 kind 过滤），见「工具分组」 |
| 提升预算 | `MCP_CAPABILITY_SURFACE_MAX`（默认 50，与 hana-cli 的 `MAX_DYNAMIC_TOOLS` 同值）：按**工具数**算，超出时**最旧的那个分类整体**淘汰（FIFO）。本仓只有 30 条具体能力，实际不会触发 |

**门面的 kind 只是摘要，不是权限**：`hana_modeling` 与 `hana_diagnostics` 都是 admin（成员里最严的一档），但它们**是否出现**与 group 无关——**门面层不做限制**，六个入口常驻；权限只按**目标能力**判（越界成员在索引里不出现、路由与提升也够不着）。

**安全语义（不因动态化而放松）**：① 门面、路由与提升**永远越不过** `MCP_TOOL_DENY` 与调用方档案（"动态面 ⊆ 静态策略"）——提升只把**可触达**的成员搬进面（不变量 A）；
② 路由与提升后的平铺直调走**同一条** `authorizeCall`，同一条结论、同一段文案；
③ 未知能力、无权能力、**跨类路由**、路由到另一个门面——四者**逐字同形**（错误文案不是存在性探针）；
④ 路由的 `args` 在服务端按目标能力的 schema 校验（客户端看到的 schema 只是便利）；
⑤ 每次调用（含被拒的路由探测）都落 `capability-audit`；提升另记一条 `capability-promotion`。

> **提升是进程内状态**（不变量 F：面是**呈现**设施，不是正确性设施）：按调用方（HTTP = 已认证 `clientId`；stdio = `(stdio)`）隔离，重启后退回"只有门面"、不报错，也不改变任何授权结果。
> **未配置 `MCP_HTTP_TOKENS` 的 HTTP 部署**：所有调用方都是 anonymous，提升会互相串改可见面，故**提升整体关闭**（索引与路由照常可用）——单租户假设。
> stdio 上提升后当场注册到活实例并发 `notifications/tools/list_changed`；HTTP 无会话、推送结构性不可达，客户端重新 `tools/list` 即可。

实机验收：`npm run verify:authz`（覆盖上表全部语义）。

## 环境档案与规则目录（P9）

`hana_system_get_info` 在基础信息之外还返回两样**按需读取**的东西（零新增工具）：

- **`profile`（环境档案）**：本环境的 HANA 版本/SPS、权限档位、激活器行为（`xs_rest` 写入是否即激活）。
  首次调用时探测一次，成功即进程内缓存；**探测失败 fail-open 并标「未探测到」**（附原因），不阻塞任何调用——
  档案是附加信息，不是任何调用的前置条件。
- **`rules`（规则目录）**：规则对象集的查询入口——**不传 `rules`** 只给**目录**（id + title，省 token）；
  传 `'all'` 或逗号分隔的规则 id 给**规则全文**（未知 id 立即硬错误并列出合法值，不会静默给空）。
  方言/边界/踩坑这类细则已从工具描述与会话指令里搬到规则对象，需要时按 id 查。14 个规则 id
  （前 9 个冻结、后 5 个为同批补充）：
  - `sql_mode`、`activation_measure`、`write_boundary`、`write_transport`、`write_receipt`、`preview`、`sql_analyze`、`metadata_graph`、`bw_dialect`
  - `model_basics`、`health_check`、`activity_locks`、`storage_profile`、`trend_timeline`

> **指令瘦身（刻意的）**：工具描述与会话 instructions 里的散文知识已逐条搬进规则对象——instructions 与最长
> 5 个描述的字数合计从约 1.39 万字降到 **≤6251**（由单测锁定上限）。**知识总量没有减**，只是从「每次会话
> 都注入」改为「按需查询」（多代理下收益 ×N，N 个子代理不必各背一份细则）——别把瘦身读成能力缩水。

## 工具速查

下表按**能力 id** 编排（30 个业务能力；另有 8 条 `hana_view_update#<op>` 操作级别名见「动态调用面」），全部带 annotations（`readOnlyHint` / `destructiveHint` / `idempotentHint`）以便 host 自动审批与危险操作确认。

> **这些能力不在注册面上**（2026-10-09 起）：`tools/list` 里只有六个分类门面，本表的每一项都经
> 「调门面不带参数 → 取本类索引 → 调门面带 `capability` + `args`」到达。表里的"工具名"是能力 id，
> 也是路由时 `capability` 的取值。

| 能力 id | 所在门面 | 分组 | 说明 |
| --- | --- | --- | --- |
| `hana_system_get_info` | `hana_system` | 只读 | 版本/SID/主机/实例/当前用户与 schema；另附环境档案 `profile` 与规则目录（`rules`：省略=目录，`all`/规则 id=全文） |
| `hana_check_privileges` | `hana_system` | 只读 | 当前用户权限矩阵与建模能力摘要（排障入口） |
| `hana_metadata_get_view` | `hana_discovery` | 只读 | 视图完整定义：json=结构化定义（节点/数据源/输出字段/变量），xml=原始设计时 XML |
| `hana_package_list` | `hana_discovery` | 只读 | 仓库包清单（含层级深度、负责人，支持片段过滤/截断） |
| `hana_package_list_objects` | `hana_discovery` | 只读 | 包内对象清单（名称/类型/版本/激活状态，支持过滤/截断） |
| `hana_metadata_search_objects` | `hana_discovery` | 只读 | 按名称片段搜索视图（默认 `by=name`）；`by=field` 时按**输出字段**反查"谁输出了匹配字段"（逐候选解析，`maxCandidates` 截断、逐条给 `matchedFields`） |
| `hana_metadata_list_fields` | `hana_discovery` | 只读 | 视图输出字段清单（ID/描述/类型/聚合/来源/是否带公式） |
| `hana_table_list` | `hana_discovery` | 只读 | 指定 schema 下可访问的表 |
| `hana_table_columns` | `hana_discovery` | 只读 | 表的列结构（列名/类型/长度/精度/可空/注释） |
| `hana_metadata_get_field_logic` | `hana_insights` | 只读 | 单字段计算逻辑：公式原文、引用的源字段与溯源、SQLScript 源码；`includeUsage` 时附**字段级下游血缘**（谁消费了这个字段，扫描预算 `usageMaxViews`，无映射消费方另列） |
| `hana_metadata_where_used` | `hana_insights` | 只读 | 血缘/依赖：upstream（依赖谁）/ downstream（谁依赖，含运行时引用）；`depth` 多跳闭包（默认 1；`all` 受 maxNodes 截断，带 `depthReached`/`truncated`/`asOf`） |
| `hana_view_check_actions` | `hana_modeling` | 写 | 查询 CHECK 过程支持的动作清单 |
| `hana_data_preview` | `hana_data` | 只读 | 已激活视图数据预览：整体直查 / 节点中间视图 / XML 推导三通道，支持筛选与输入参数；权限类失败自动附带诊断报告 |
| `hana_data_preview_diagnose` | `hana_data` | 只读 | 数据预览权限诊断：聚焦分析权限保护情况与上游数据源可达性，给出阻塞点与授权建议 |
| `hana_view_create` | `hana_modeling` | 写 | 在可写包内新建计算视图，两种形态：图形化最小形态（单 Projection + 单源表全列透传）与 **SQL 模式**（`mode=sql` + `script`/`scriptColumns`，见 `npm run verify:sql-mode`）；XS REST 写路径 |
| `hana_view_activate` | `hana_modeling` | 写 | 激活设计时计算视图为运行时列视图（XS REST：PUT（带 If-Match 基线）+ SapBackPack Activate，错误明细透传） |
| `hana_view_update` | `hana_modeling` | 写 | 更新计算视图，三选一：operations 声明式补丁（8 个 op——add_join / set_script / set_description / rename_field / drop_field / add_calculated_column / set_attribute_filter / set_variable，服务端确定性变换，模型零 XML；也可经 `hana_view_update#<op>` 别名路由单发）/ 全量 XML 覆盖 / **changeset 多对象变更集**（单次调用内闭合：整体预检含对象级读写集相交检测 → 逐项执行（各自含激活）→ 失败即逆序补偿 → 诚实报告（`notExecuted` 显式枚举未完成项）；上限 10；破坏性动作各自需 migration 声明；**`async=true` 走异步任务**：立即返回 taskId，用 `hana_task_get` 轮询、`hana_task_cancel` 取消）。PUT + If-Match 乐观锁；冲突返回**业务失败信封** `raw.conflict`（含 `currentETag` 等机读字段），不再返回 isError 散文 |
| `hana_task_get` | `hana_modeling` | 读 | 轮询异步任务（`hana_view_update(async=true)` 提交）：status = working/completed/failed/cancelled、进度与终态 result（与同步调用同形的回执信封）。只对**本调用方**的任务可见；任务状态在进程内，服务重启即失效 |
| `hana_task_cancel` | `hana_modeling` | 写 | 请求取消一个运行中的任务：**动作边界生效**（当前动作不打断）、停止后续项并触发与失败相同的**逆序补偿**（已执行项回批前状态，报告 `raw.code=changeset_cancelled`）；已到终态的任务不可取消（如实回执、不报错） |
| `hana_view_delete` | `hana_modeling` | 写 | 删除设计时计算视图（DELETE + If-Match 乐观锁；对象已不存在返回机读 `OBJECT_NOT_FOUND`；建议先查 where_used） |
| `hana_view_validate` | `hana_modeling` | 写 | 双模式：design=激活前校验（模拟激活临时副本，原对象不受影响）；runtime=已激活视图一致性校验（SYS.CHECK_CALCULATION_VIEW） |
| `hana_package_create` | `hana_modeling` | 写 | 新建包/目录（XS REST：POST /base/file/<pkg>/，目标须在可写包范围） |
| `hana_repo_export` | `hana_modeling` | 管理 | 导出包为 zip（XS REST Transfer API；saveTo 落盘或返回 base64） |
| `hana_repo_import` | `hana_modeling` | 管理 | 导入设计时文件（Transfer API 目录目标+分片上传，**落库即激活**（实测，无 inactive 暂存），目标须在可写包范围，导入后回读状态；修改已有对象走 `hana_view_update`） |
| `hana_repo_changelist` | `hana_diagnostics` | 管理 | 仓库变更列表审计（GET /base/change，需系统启用 Change Tracking） |
| `hana_sql_analyze` | `hana_diagnostics` | 写 | SQL 分析：**默认返回可读结论**（一句话结论 + 逐条发现[风险/关注/信息，带依据与建议] + 统计），**默认不给原始计划**（`raw=true` 才返回算子行与文本树）；`sql`=只编译不执行（估计计划）；`planId`=分析计划缓存条目并附运行时统计（需 OPTIMIZER ADMIN）；`sql`+`analyze=true`=先真执行，**默认走 PlanViz 通道**拿与官方 Executed Plan(F8) 同款的**逐算子实测**（`panels` 六栏 + 实测结论；通道不可用时降级为估计计划 + 语句级统计，notes 说明）。执行受硬护栏：只允许 SELECT、单次执行最多 5 分钟、最多取 100 行、**不返回数据行** |
| `hana_system_health` | `hana_diagnostics` | 管理 | 稳定性体检，返回**读数 + 结论**两层。`metrics` 给具体占用（实例内存已用/配额/峰值及百分比、主机物理内存、**数据库与主机驻留内存**、**主机与数据库 CPU**、各挂载点使用率、**各用途卷大小 Data/Log/Trace**、**卷 IO 失败读写/阻塞写/软异常**、**内存对象层：不可换出内存/分配失败率/命中率/收缩失败/可回收性梯度**、备份距今天数、阻塞/长事务/告警数、参数违规与待重启数、在用弃用特性数、加密状态…），**无论判定正常与否都会给**——问"当前内存多少"直接读这里；`findings` 给整体 verdict + 逐项级别/结论/证据/建议。**12 项检查**：磁盘（容量 + IO 两个正交口径）/服务/备份/内存（主机+实例+内存对象层）/CPU/告警/阻塞/长事务/复制/**配置**（违反限制/改了未重启/非默认层覆盖，**不做"参数该设成多少"的比对**）/ **弃用特性**（升级前风险，非当前故障）/ **加密**（恒为 info——是否要求加密是合规决策，只进读数不参与判定）。**三态**：ok / 异常 / `unknown`（看不见）—— 监视视图按权限行级过滤，权限不足时静默返回空集，本工具绝不把它当"正常"；每项要么给读数、要么给一条带成因的 `unknown`，**不得静默消失**。容量单位统一 **GiB**，与 HANA Cockpit 一致 |
| `hana_system_activity` | `hana_diagnostics` | 管理 | 会话与阻塞深潜：被阻塞事务（含**谁堵谁**的连接画像）、长事务（含 undo/版本/持锁，用于判断是否阻碍 MVCC 回收）、长语句。`sections` 选段落、`minDurationSec` 设时长下限 |
| `hana_table_storage` | `hana_diagnostics` | 管理 | 表存储画像，每行带**内存占用 / 磁盘占用 / 分区数 / 碎片率 / 读写次数 / 上次 merge / BW 分类**。**7 种口径**：`memory` 内存 TOP / `disk` 磁盘 TOP（`M_TABLE_PERSISTENCE_STATISTICS.DISK_SIZE`）/ `fragmentation` delta 占比 TOP / `hotness` 读写 TOP / `partition` 分区数 TOP。`schema`/`table` 是**过滤器**，给 `table` 即返回该表的完整画像；`partition` + `schema` + `table` 还会**额外**返回逐分区明细。`partition` 模式**默认只看 BW 活动数据表**（`subtype` 可切换 QUEUE/CHANGE_LOG/PSA/…/ALL）——同一 BW 对象在 HANA 上是一组物理表（活动表/入站队列/变更日志/PSA），表名只差后缀。按 (schema, table) 聚合后再排序——该视图一行是一个分区。另有两种**下钻口径**（单元不是"表"）：`column` 列级内存 TOP（`M_CS_ALL_COLUMNS`，带压缩类型/行数/不同值数/索引类型/最后访问时间；**刻意不返回 `COMPRESSION_RATIO_IN_PERCENTAGE`**——实测该列在本版本会出现 361890% 这种不可能的值）、`index` 索引内存 TOP（`M_CS_INDEXES`，带**该索引占所属表内存的百分比**，实测 73%~83%——只看表内存会把真实成本少算近一半）。体量单位 **MiB**（与 Cockpit 同为 1024 进制） |
| `hana_system_trend` | `hana_diagnostics` | 管理 | 历史趋势，回答"**这周比上周差了吗**"——前面三个工具都是"此刻的快照"，没有一个能回答变化。数据源 `_SYS_STATISTICS.HOST_LOAD_HISTORY_HOST`（一份同时带 CPU/内存/磁盘/网络/swap，不必跨视图对齐时间轴）。`hours` 回溯窗口、`bucketMinutes` 桶宽、`metrics` 选指标组（cpu/memory/disk/network/swap），每桶给 **min/max/avg** 与采样点数。**实测结构**：约 **10 秒一个采样点**、36 万行跨约 42 天；**`SERVER_TIMESTAMP` 是快照写入时刻，`TIME` 才是采样时刻**（同一 SERVER_TIMESTAMP 下有 358 行不同 TIME——用前者做时间轴会把一小时压成一个点），本工具用 `TIME`；`INDEX` 是行唯一键不是服务维度。**保留期有限**：窗口超出时 `retention.coversWindow=false` 且 caveats 说明只回溯到何时——**未覆盖的那段不等于"正常"，只是没有数据**。刻意不给"上升就是坏"的结论，只给首尾桶变化率 |

### 六个分类门面（这些才是 `tools/list` 里看到的工具）

| 门面 | 分类 | 方向 | 成员数 |
| --- | --- | --- | --- |
| `hana_system` | system | 连接与环境：当前连接是谁、连到哪（版本、权限档位、规则库） | 2 |
| `hana_discovery` | discovery | 浏览与查找：找包/对象/表，读定义与字段结构 | 7 |
| `hana_data` | data | 取数预览：看已激活视图/基表的数据（含预览诊断） | 2 |
| `hana_insights` | insights | 结构与血缘分析：影响面（谁依赖它）、字段级计算逻辑 | 2 |
| `hana_modeling` | modeling | 建模与仓库变更：创建/修改/校验/激活/删除设计时对象，导入导出 | 9 |
| `hana_diagnostics` | diagnostics | 运维与性能：健康/会话/存储/趋势、SQL 分析与仓库变更审计 | 6 |

每个门面的**描述里带成员清单**（`- <能力 id>：<标题>`），模型不进任何调用就能看出本类有哪些能力——这是"零发现调用"成立的前提（描述只给抽象概括时，模型得先调一次索引才知道里面有什么，那就把省下的往返又还回去了）。**参数名与一句话摘要不写进描述**：它们属于"已经选中之后"的信息，由索引回执给。

调用形态 `{ capability?, args? }`：**不带参数** → 返回本类索引（id / 标题 / kind / 一句话摘要 / 参数名）；**带 `capability` + `args`** → 直接调用该能力（不经过提升也能调）。两种形式都会把**该分类提升进工具面**——此后它们带完整 schema、可平铺直调（见「动态调用面」）。索引按当前调用方的权限范围过滤——看不到即无权，与不存在不可区分。


> **字段逻辑类回执修正（P6）**：属性列的公式/类型（`formula`/`datatype`）此前恒缺，现在按定义带值——
> `hana_metadata_list_fields` 的 `hasFormula` 与 `hana_metadata_get_field_logic` 的 `formula`/`sourceColumns`
> 取值会随之变化；**这不是回归**，是解析器前置修复的结果。

> **写操作安全边界**：写工具（create/activate/update/delete/package_create/import）的可写包范围由
> `HANA_WRITE_PACKAGES` 配置控制——**空 = 未启用写边界**：声明写包的请求会被运行期闸门以 `boundary_off`
> **硬拦**（"要写就必须显式配置"）；填写后仅允许配置包及其下级子包写操作
> （例：`ZDEMO1,ZDEMO2.ZDEMO_SD` 允许 ZDEMO1、ZDEMO1.X、ZDEMO2.ZDEMO_SD、ZDEMO2.ZDEMO_SD.SUB，拒绝其他）。
> 只有**服务层**那一层是 fail-open（`assertWritePackageAllowed` 在白名单为空时放行）——脚本/内部
> 调用不走工具层闸门，不会被 `boundary_off` 拦住。
> 同名对象拒绝覆盖；update/delete/activate 带 If-Match 乐观锁（create/import 跨进程无服务端前置的
> 已知例外见「传输方式 → 并发与锁」）。
>
> **多对象变更集（`hana_view_update` 的 `changeset` 模式，P7）**：与 operations / xml 三选一的第三种模式，
> 把多个对象的改动收进**单次调用内闭合**的批次——① **整体预检**：逐动作规划 + **对象级**读写集相交检测
> （同包多对象正常批次不误报）+ 破坏性判定，任一被拦或相交 ⇒ **整批拒绝、零写入**（判定在任何写之前完成）；
> ② **逐项执行**：按 (packageId, objectName) 字典序（防 ABBA 死锁），每项各自完成**含激活**；
> ③ 任一项失败 ⇒ **逆序补偿**（update 写回原文 / create 删除新建对象 / delete 写回原文）；
> ④ **诚实报告**：partial=true 时逐项枚举状态（ok / failed / compensated / compensation_failed / conflict_external）、
> `notExecuted` 显式枚举未完成项，绝不把部分完成包装成成功。动作上限 **10**；**破坏性动作（update/delete）各自**
> 在 action 上声明 `migration`——未声明 ⇒ 整体预检在任何写入之前判完 ⇒ 整批拒绝、零写入（不发生补偿）。
> 批**不提供跨项快照隔离**：逐项提交、各自取锁，期间的批外读写对本批可见（回执 `concurrencyNote` 同样写明）。
> changeset 模式下顶层 `packageId`/`objectName` 被忽略（仅供单对象通道；批次目标由各 action 自带）。
>
> **长批次走异步任务（`async=true`，2026-10-10）**：批内每项写入含 2–10s 服务端激活，10 项可到分钟级——
> 同步调用可能被 MCP 客户端**自身**的超时掐断（服务端无从得知客户端超时配置）。`changeset` + `async=true`
> 把批次交给**进程内任务**跑并立即返回 `{ taskId, status: 'working', label, hint }`：
> - 轮询 `hana_task_get({ taskId })` → `status ∈ working/completed/failed/cancelled`、`progress` 与终态 `result`
>   （**与同步调用同形的回执信封**——成功 `data=报告`；失败 `raw.errorDetail` 带逐项明细）；
> - 取消 `hana_task_cancel({ taskId })` → **协作式**：当前动作不打断，本动作结束后停止后续项，并走与失败
>   相同的**逆序补偿**（已执行项回批前状态），报告 `raw.code=changeset_cancelled` 带完整现场；
> - 任务体就是 `applyChangeset` 本体（同一实现/锁/信号量/补偿）：整体预检仍在任何写入之前
>   （预检不通过 ⇒ 整批拒绝、零写入 ⇒ 任务直接落 `failed` 终态）；
> - 边界如实说：同时运行上限 4（超出提交即拒、未发生任何写）、终态保留 30 分钟、注册表上限 100 条；
>   **进程内状态、服务重启即丢**（重启后旧 taskId 回"未知任务"）；任务只对**本调用方**可见
>   （他人任务与不存在的任务回同一句"未知任务"）；未配 Token 的 HTTP 部署按单租户假设（互相可见）。
> 为什么不做协议原生 MCP Tasks（SEP-2663）：本机 SDK（2.3.1）只有线协议词汇、无运行期，且 2026-era
> 上 `tasks/result|list` 恒被 -32601——协议原生路线在 modern 客户端上残缺且要替换 SDK 的 tools/call 处理器；
> 工具化路线的取舍是"模型主动轮询"换"两个协议版本行为一致、零 SDK 侵入"。
>
> **写边界预检（启动即校验）**：服务启动时打印生效的可写包范围——配了则 info 列出白名单；未配
> （边界未启用）且写工具已对客户端暴露则 warn 显式告警。这样"边界到底开没开"不会拖到
> 写操作才暴露。`HANA_WRITE_PACKAGES` 含非法包名（`ZDEMO.`、`ZDE MO`、`*` 等）在配置加载时即失败
> 并给出修复提示，不再被静默保留成永不匹配的前缀（那会导致写操作全被拒或边界形同虚设）。
> 另注意生效值取决于启动来源：以 mcp.json 启动的 stdio 服务以该文件 env 为准，凭据三件套齐备时
> 仓库 `.env` 整个文件被跳过（服务不会去读它）——同一台机器上三处配置可能给出三个不同答案。
>
> **权限策略层（两个权限级功能）**：`src/config/preflight.ts` 是唯一的判定入口，按两个维度组织——
>
> | 维度 | 管什么 | 配置项 | 参考 |
> |---|---|---|---|
> | **能力级** | 哪些工具对外暴露 | `MCP_TOOL_GROUPS` / `ALLOW` / `DENY`（支持组名） | tableau 的 INCLUDE/EXCLUDE_TOOLS；dataworks 的 TOOL_CATEGORIES/NAMES |
> | **资源级** | 能操作哪些资源 | `HANA_WRITE_PACKAGES`（可写包）/ `HANA_SCHEMA_ALLOW`（可读 schema） | tableau 的 BoundedContext；dataworks 交给平台 |
> | （部署级） | 连接侧约束，非任务级 | `HANA_TLS` / `MCP_HTTP_*` | 两家均在 Config 构造期 fail-closed |
>
> 结构是**一个策略对象 + 一组判定器**：`resolvePolicy(source)` 从 env / mcp.json / 已加载 config 取出生效
> 策略 → `checkCapability` / `checkResource` / `checkDeployment` 每维度一个纯函数（统一签名
> `(policy, 请求) → Grant[]`，互不知道对方存在）→ `runPreflight`（任务闸门）或 `describePolicy`（策略自检）
> 组合成 `Verdict { allowed, blocking[], warnings[] }`。规则本体在四个叶子模块
> （`write-boundary` 写包 / `sql` schema / `groups` 工具 / `deployment` 姿态），判定器只做组合、不重写规则；
> 新增一个权限维度 = 加一个 `check*`，不动其它维度。
>
> 三个调用方共用同一层：**服务启动自检**（`describePolicy`，阻断级即拒绝启动）、**工具层运行期闸门**
> （`runPreflight`，拦在 handler 之前）、**CLI / 实机脚本**（`npm run preflight` 退出码判定；
> 加 `--from <mcp.json>` 以客户端注入的那份配置为准，它与仓库 `.env` 不是同一个来源）。
>
> **拦截消息的边界（重要）**：返回给调用方的拦截消息一律以「被 MCP 安全策略拦截」开头，只陈述事实
> （维度 / 规则码 / 请求内容 / 生效策略 / 配置来源），**不包含**"改哪一项配置即可放行"之类的指引——
> 错误消息是给**不受信的一方**（通常是模型）看的，写进绕过方法等于把钥匙递出去。
> 补救指引与豁免开关（如 `MCP_HTTP_ALLOW_ANONYMOUS`）只出现在**运维向**位置：服务启动自检与本文档。
> 该边界由单测强制（拦截消息前缀 + 禁用词匹配），不是靠自觉。
>
> **运行期闸门（工具层，先规划后判定）**：**所有**能力（`src/capabilities/defs/*.ts` 声明的 30 条业务能力 + 8 条操作级别名 + 六个门面，含只读能力）
> 都经 `capabilityRegistrar` 在 handler 之前过同一个闸门 `authorizeCall`（`src/config/authorize.ts`），分两步：
> ① **预规划**（`src/write-plan.ts` + `src/capabilities/planners.ts`）——把这次调用最终会读写什么算清楚，
> 产出 `WritePlan`（写哪些包 / 读哪些 schema / 跨包只读引用 / 无法静态确定的点）。
> **清单里的 `effects.plan` 决定闸门有没有资源维度**：写工具与 `hana_sql_analyze` 声明完整的读写计划；
> 读 `用户指定 schema` 的工具（`hana_table_list` / `hana_table_columns` / `hana_data_preview` 勘察模式 /
> `hana_table_storage`）声明读范围；读 `固定系统 schema`（`_SYS_REPO`/`_SYS_BIC`/`SYS.M_*`）的工具不声明
> （恒可读的面上声明资源只会制造"已被保护"的假象）；
> ② **判定**（预检层按生效权限配置）——不通过直接返回硬错误（`isError`），**不进 handler、不进 service**。
>
> 为什么不能只看参数：`hana_view_update` 的 `add_join`，**join 源在另一个包**，藏在 `operations` 里；
> `hana_view_validate` 参数看着是"校验"，design 模式实际会**写入** `_CHKTMP` 临时对象；
> `hana_repo_import` 的导入内容里可能引用别的包；`hana_view_delete` 的下游依赖会失效。
> 这些都只有把请求解析一遍才知道，`WritePlan` 的 `steps` 与 `uncertain` 会一并进拦截报告，
> 让调用方看清"本来会发生什么"再决定怎么改。
>
> **读工具确实受调用期保护了，但边界要说清**：受约束的是「**按名指定 schema 去读**」这类调用
> （`schema` 不在 `HANA_SCHEMA_ALLOW` 即被拦在 handler 之前）；**不约束**的是：
> ① 已激活视图**自身定义**的读取（`hana_metadata_get_view` 等读 `_SYS_REPO`，属 D-12 的显式决策）；
> ② `hana_data_preview` 视图预览模式（运行时对象恒在 `_SYS_BIC`）；
> ③ **仓库包维度**——权限配置里没有"可读包"这一项，`packageId` 既不受写包边界约束、也不受任何读包边界约束
> （跨包只读引用只进报告、不拦截：加白名单会破坏既有的跨包 join 用法）；
> ④ `hana_table_storage` 省略 `schema` 时的全库统计（范围由数据库权限决定，见该工具描述与计划里的不确定项）。
>
> 判定用服务已加载的配置（不重新解析 env），不存在"判定用的值 ≠ 运行用的值"。
> service 层的 `assertWritePackageAllowed` / `assertSchemaAllowed` 保留为纵深防御
> （脚本/内部调用不经过工具层），并复用同一批判定叶子——注意：**写包白名单为空时这一层是
> fail-open**（`boundary_off` 的硬拦在工具层闸门，见上方「写操作安全边界」）。
> **每次调用**都会落地一条 `capability-audit`（`{capabilityId, verdict, clientId?, transport, resources, codes}`，
> 放行记 info、拦截记 warn）——归因不随入口变化。
> 执行任务前可先自检：`npm run preflight -- <包名...> [--tool <工具名>] [--schema <schema>]`，
> 退出码 `0`=可执行 / `1`=被拦截 / `2`=用法错误；本地模式加 `--from <mcp.json>` 以客户端注入的那份配置为准
> （它与仓库 `.env` 不是同一个来源）。闸门本身的实机验收：`npm run verify:authz`。
>
> **部署级不变量（启动即拒绝）**：单项合法但组合起来构成安全暴露的配置，在启动自检中被拒绝而非只告警
> （对照 tableau-mcp 在 Config 构造期 throw 的做法）。当前规则：① HTTP 非回环监听且无任何 Bearer Token →
> **拒绝启动**（除非显式 `MCP_HTTP_ALLOW_ANONYMOUS=true`）；② `HANA_TLS=false` 明文连接、③ 加密但
> `HANA_SSL_VALIDATE=false`（不防中间人）→ 告警放行，但每次启动都在日志中可见。

## 数据预览

`hana_data_preview` 三条预览通道（返回 `via` 字段标识）：

| 通道 | 触发 | 机制 | 需要权限 |
| --- | --- | --- | --- |
| `direct`（整体预览） | 不传 `node` | `SELECT * FROM "_SYS_BIC"."包/视图名"` | `_SYS_BIC` 数据访问 |
| `intermediate`（节点预览·默认） | 传 `node` | HANA 原生中间视图 `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV`（Studio 节点预览同款）：视图名固定为 `<包/对象>/dp/<节点>`，已存在即复用不重建，查询后仅在本进程无占用且由本服务创建时才 DROP | `EXECUTE` on 上述过程 |
| `derived`（节点预览·只读） | 传 `node` + `forceDerive=true`（显式启用） | 依据视图 XML 推导 SQL，纯只读 | `_SYS_REPO` 读 + 基表 SELECT |

行数规则：无筛选默认 10 行，有筛选默认 100 行，显式 `limit` 上限 1000；`LIMIT n+1` 探测截断 → `truncated`。
节点预览默认只走 `intermediate` 通道：缺 EXECUTE 权限时直接返回「不支持」（附授权提示），不会自动切换到推导。

**权限失败自动诊断**：当预览因权限类原因失败（缺 EXECUTE/SELECT、`_SYS_BIC` 对象不可见的 258/259 等），会自动运行权限诊断并把报告附在 `envelope.raw.diagnosis`，无需额外调用即可定位阻塞点。
也可用 `hana_data_preview_diagnose` 手动前置排查，聚焦预览失败的两大根因：
- 当前 CV 是否受经典分析权限（Analytic Privilege）保护及当前用户授权情况
- 上游数据源（derived 通道实测追溯）是否不可访问

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | tsx 直接运行（开发调试） |
| `npm run build` | tsc 构建到 dist |
| `npm start` | 运行 dist/index.js（stdio） |
| `npm test` | 单元测试（node --test + tsx；测试文件本地保留，未入库） |
| `npm run smoke` | 构建 + stdio 冒烟测试 |
| `npm run smoke:http` | 构建 + Streamable HTTP 冒烟测试（握手/工具注册/Host 防护，无需真实 HANA） |
| `npm run typecheck` | 仅类型检查（同时承担死代码检测：`noUnusedLocals` 会拦下未使用的导入与变量） |
| `npm run format` | Prettier 格式化（`format:check` 只检查不写） |
| `npm run check` | `typecheck` + `test`（提交前跑这个） |
| `npm run verify:system` | 构建 + 真实 HANA 系统工具验收 |
| `npm run verify:p1-5` | 构建 + 读路径/预览/字段逻辑黑盒验收 |
| `npm run verify:lifecycle` | 构建 + 写路径全生命周期验收（create→validate→activate→preview→update冲突→delete→import；脚本在本地 `test-verification/`，不入库） |
| `npm run verify:add-join` | 构建 + 声明式加 join（`op=add_join`）实机验收（含 BW 方言视图场景；脚本在本地 `test-verification/`，不入库） |
| `npm run verify:sql-mode` | 构建 + SQL 模式视图（`mode=sql` 的 `script`/`scriptColumns`）实机验收（脚本在本地 `test-verification/`，不入库） |
| `npm run verify:health` | 构建 + 稳定性诊断四件套验收（**192 项断言**）。含多条回归护栏：防止误用 `M_DISK_USAGE` 的 `FILE_SIZE` 口径导致整机误报；防止卷文件用量（预分配写满属常态）被当成磁盘告警；防止 `COMPRESSION_RATIO_IN_PERCENTAGE` 与 `HASH_COLLISION_COUNT` 这两个**实测不可用**的列被透出；防止趋势时间轴误用 `SERVER_TIMESTAMP`（会把一小时压成一个点）；以及「每一项要么给读数、要么给一条带成因的 unknown」这条纪律 |
| `npm run verify:catalog` | 构建 + 关系图/血缘验收。只读段：`where_used(depth)` 的闭包 ⊇ 单跳、带 `asOf`/`truncated` 且截断时规模受限；`search_objects(by=field)` 的候选口径字段与 `matchedFields`；「无平行工具」否定断言；`depth=1` 形状与旧版逐字段一致、`objectSuffix` 不回 `?`。另有 **A/B 对比段**（同对象在 `cac5d60` 构建的基线 dist 与本 dist 各跑一次 `where_used`，逐字段 diff，两侧 VERSION_ID 一致才继续）与**写型段**（create B → create A → A 加 join 指向 B → 目录现算可见 → 改 A（VERSION_ID 前进）→ 删 A → 目录不再列出 A；含 `runPreflight` 自守卫与收尾清理，`VERIFY_CATALOG_SKIP_WRITE=1` 可跳过）。目标对象用 `VERIFY_CATALOG_PACKAGE/OBJECT` 覆盖；写型包用 `VERIFY_CATALOG_WRITE_PACKAGE` |
| `npm run verify:authz` | 构建 + 调用期闸门验收（阶段一：读路径与写路径的统一闸门）。护栏：读范围越界（`schema` 不在 `HANA_SCHEMA_ALLOW`）在 **handler 之前**被拦、回执含机读码与本次调用预规划且**不含补救路径**；读能力的 `packageId` 不受写包边界约束（读某包里的视图 ≠ 写那个包）；写闸门既有行为不变；未注册工具 = **协议层错误**（与"已注册被拦"的 `isError` 两态可分）；每次调用落地 `capability-audit` 审计事件（放行与拦截都记，含 `resources`/`codes`）|
| `npm run verify:concurrency` | 构建 + 并发语义实机验收（**双进程**并发操作同一对象）。护栏：update 报成功 ⇒ 终态 = 它写入的内容（不静默回退）；每个 412 都带机读载荷 `raw.conflict.currentETag`（陈旧 `ifMatch` 确定性构造）；双删一方成功、另一方得到可机读的 `412`/`OBJECT_NOT_FOUND`；activate/update 交错后 meta 读出的 ETag = 最近一次成功写回执给出的 ETag。脚本在本地 `test-verification/`，不入库 |
| `npm run verify:dry-run` | 构建 + 预演与破坏性判定验收（dryRun 零写入 + 判定表 + migration 闸门）。护栏：预演/被拒调用后 **ACTIVE 与 `_SYS_REPO.INACTIVE_OBJECT`（inactive 侧）**的版本读数均不变（只查 ACTIVE 会漏判「555：文件已写、激活失败」）；未改动对象原样预演 ⇒ 结构 diff 为空（归一化生效，xml 与 operations 两条通道各一条）；未声明 migration 的破坏性变更被拒（机读码 `migration_required`、`raw.errorDetail.breaking.items` 破坏项明细、一次写都没发生；判定表最隐蔽的**改数据源**行单独钉：有下游时经 xml 全量通道改指同样被拒、零写入）；声明策略 ⇒ 放行且回执记录（**只记录、不做自动迁移**）；删除闸门（有下游引用未声明被拒；无下游照常成功）。脚本在本地 `test-verification/`，不入库 |
| `npm run verify:changeset` | 构建 + 变更集（多对象事务）实机验收（SSD §6.6 四场景，确定性构造不依赖随机失败）。护栏：① 3 对象 update 一次 changeset 调用全成功（逐项 `ok`、每项带写回执基线 `etagSource='response-header'`——按代码口径断言，SSD §6.4 的下划线写法属口径差、脚本里点名、`partial=false`）；② 第 3 项 create 已存在对象确定性失败 ⇒ 前 2 项 `compensated` 且内容**逐字回到原文**（get_view 读回比对，不是永真式；出现 `compensation_failed` 即实现缺陷、打印结构化现场 `currentETag/currentVersion`）；③ 有下游对象删列未声明 migration ⇒ **整批拒绝零写入**（D 与同批无害动作的 VERSION_ID + inactive 侧指纹均未变）；④ 批内「写 A + 读 A 作 join 源」⇒ 整批拒绝且拒绝载荷可读出**冲突对象名与两个动作下标**、反例护栏（同包两个不同对象不被判成冲突，包级误拒在此变红）。脚本在本地 `test-verification/`，不入库 |
| `npm run verify:tasks` | 构建 + 异步任务实机验收（`changeset` + `async=true`）。护栏：提交立即返回 `taskId`（未等批次跑完）；轮询到 `completed` 且 `result` 与同步调用同形（`applied` 含 etag/activated）；提交后立即取消的两种时序都断言其一致性（`requested` ⇒ 终态 `cancelled` + 未执行项 `reason=cancelled`；`terminal` ⇒ hint 如实说明「取消未生效」）；未知 taskId 回同一句「未知任务」。脚本在本地 `test-verification/`，不入库 |
| `npm run verify:ops` | 构建 + 操作集实机验收（P8；**8 个 op**）。主用例（`set_description`）：改描述走 operations 通道（模型零 XML）后回执 `applied` 如实给出该 op 及其 `changed`；**其余内容逐字节未变**（读回 XML 把验收标记还原后与改前原文完全相等）；dryRun 联动且预演零写入。后半批（2026-10-10）：`add_calculated_column` / `set_attribute_filter`（含替换路径）/ `set_variable`（先经 xml 通道注入变量）/ `rename_field`（含重名与不存在负例）/ `drop_field`（含删最后一个度量负例）逐个走真实写入并断言**激活通过**（XML 形态与 SAP 方言相符的实机证明）+ 参数守卫全拒且零写入。脚本在本地 `test-verification/`，不入库 |
| `npm run probe:health` | 只读探针：枚举监视视图的可用性/列名/取值域（换环境后先跑它，勿按文档猜） |
| `npm run probe:repo` | 只读探针：仓库读路径（`_SYS_REPO` 对象/属性查询）可用性 |
| `npm run probe:xfer` | 只读探针：CHECK 与 xfer（Transfer API）能力探测 |

## 架构简介

```
src/
  index.ts            入口：加载配置 → 连接池 → stdio / Streamable HTTP transport 分支
  http.ts             Streamable HTTP 传输：createMcpHandler 按请求工厂 + node:http 适配 + Host/Origin 防护
  server.ts           McpServer（server instructions 领域上下文）+ 全部工具注册
  config/             zod 环境变量校验（连接/TLS/时区/白名单/可写包）
  core/               HANA 连接池（上限/排队/等待超时可配）、SQL 转义与白名单、错误 envelope、日志脱敏、
                      请求身份上下文（HTTP 多客户端归因）、写临界区 keyed lock（排队超时）+ 激活信号量、
                      XML 工具、XS REST 客户端（统一超时）、
                      数值/文本/错误码判定的公共实现（num/text/hana-errors）、时区与时间格式化
  model/              视图 TS 类型、XML 双向解析、最小 CV 的 XML 构造
  services/
    metadata.service        只读：包/对象搜索/字段/血缘/表目录
    preview.service         数据预览（直查/节点中间视图/XML 推导）+ 权限失败自动诊断
    preview-diagnose.service 预览权限诊断（分析权限检测 + 上游可达性实测）
    repository.service      写：XS REST 官方写路径（workspace/文件/Transfer API/设计时校验）
                             + REPOSITORY_REST repoV2 信封（读侧/兼容）+ INACTIVE_OBJECT 兜底
                             + 写包白名单（HANA_WRITE_PACKAGES）
    validation.service      运行时视图一致性校验
    system.service          系统信息与权限检查
    sql-analyze.service     SQL 分析（执行计划）主流程：同连接内 EXPLAIN → 按唯一名回读 → 用完即清
    sql-analyze.rules      上述的纯规则层：语句分类/白名单/分析结论（默认输出）与算子渲染
    read-scope.service      未限定表名的读取范围校验（SQL 模式视图与 SQL 分析共用一份判定）
  tools/               MCP 工具薄壳（system/package/metadata/preview/modeling/sql-analyze）
  types/               统一返回信封 Envelope 等
scripts/               通用冒烟脚本（smoke-stdio）；实机验收/探针脚本在本地 test-verification/（不入库）
```

> `tests/` 与 `docs/` 不入库（含环境标识/探测记录，本地保留供开发）；克隆后按需自备测试与文档。
>
> 分层与依赖方向、错误处理约定、公共实现该放哪、"哪些看起来一样但语义不同不能合并"——见 [CONTRIBUTING.md](CONTRIBUTING.md)。

每个工具统一返回信封 `{ success, data?, messages[], raw? }`（HTTP 模式下另带 `clientId` = 由 `MCP_HTTP_TOKENS` 解析出的调用方身份）：硬错误（参数非法/对象不存在）通过 MCP
`isError` 返回并附恢复提示；HANA 业务失败（如激活报错明细）走 `success:false`。

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
- 仓库写/激活权限：`REPO.EDIT_NATIVE_OBJECTS` / `REPO.ACTIVATE_NATIVE_OBJECTS`
  （或等价：目标包 root 的 package 权限 + MODELING 角色）
- `REPO.MODIFY_CHANGE` / `REPO.MODIFY_OWN_CONTRIBUTION`：变更会话（workspace）操作
- XS 会话（`http://<host>:80<instance>/sap/hana/xs/formLogin`）：用户须可登录 XS Classic
  （`PUBLIC` + 应用特权 `sap.hana.xs.admin.roles::RuntimeConfOperator` 所含会话能力；实测以 `hana_check_privileges` 排查）
- 写目标包：`REPO.EDIT_NATIVE_OBJECTS` + 包的 owner 或 package 级写特权

**稳定性诊断（`hana_system_health` / `hana_system_activity` / `hana_table_storage` / `hana_system_trend`）**

- **无需额外权限即可用**：`SYS.M_SERVICES`、`M_DATABASES`、`M_CS_TABLES`、`M_TABLES`、
  `M_SQL_PLAN_CACHE` 等实例内视图，任何用户都能查（表画像与部分体检项因此始终可用）。
- **`CATALOG READ`（或含它的 `MONITORING` 角色）**：解锁**基础设施类**监视视图 ——
  `M_DISKS`/`M_DISK_USAGE`、`M_HOST_RESOURCE_UTILIZATION`、`M_BACKUP_CATALOG`、
  `M_SERVICE_REPLICATION`、`M_MEMORY_OBJECTS`，以及他人会话的完整可见性。
  这些视图**权限不足时不报错、只返回空集**，因此缺权限时体检会把对应项标为 `unknown`（而非"正常"）。
- **`_SYS_STATISTICS` 的 SELECT**：告警项（`STATISTICS_CURRENT_ALERTS`）与**整个趋势工具**需要它；
  缺权限时报 258，同样标记为 `unknown`。**趋势的保留期实测约 42 天**（可配置），窗口超出时如实说明只回溯到何时。
- **配置类读数**（`hana_system_health` 的 `config` 项）需要 `INIFILE ADMIN` 或等效授权才能读全
  `M_CONFIGURATION_PARAMETER_VALUES`；读不全时不一定报错，故该项的非默认层覆盖数会偏小。
- **内存对象层读数**（`M_MEMORY_OBJECTS` / `M_MEMORY_OBJECT_DISPOSITIONS`）与**卷 IO 读数**
  （`M_VOLUME_IO_TOTAL_STATISTICS` / `M_VOLUME_FILES`）同属基础设施类：缺权限时**只影响该层读数**，
  会在 metrics 里留一条「无法判定」，但不会把主机/实例内存与容量的结论一起带偏。
- 权限是否到位可用 `hana_system_health` 返回的 `visibility`（`unfiltered` 布尔值与已持有权限清单）
  或 `hana_check_privileges` 直接确认。

权限不足时先用 `hana_check_privileges` 排查；预览失败用 `hana_data_preview_diagnose` 定位是分析权限还是上游不可达。

## MCP 客户端接入

将 `mcp.json.example` 复制为 `mcp.json`，填入真实连接后按各客户端方式配置：

**Claude Desktop / Cursor / VS Code（MCP 扩展）**

指向本地构建产物，stdio 传输：

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "command": "node",
      "args": ["<仓库绝对路径>/dist/index.js"],
      "env": {
        "HANA_HOST": "hana-host.example",
        "HANA_INSTANCE": "10",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD",
        "HANA_DB_NAME": "SYSTEMDB",
        "HANA_TLS": "false",
        "HANA_WRITE_PACKAGES": "ZDEMO1"
      }
    }
  }
}
```

**或用 npx 一键拉取（免克隆）**：

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "command": "npx",
      "args": ["github:mininia/saphana-modeler-mcp"],
      "env": {
        "HANA_HOST": "hana-host.example",
        "HANA_INSTANCE": "10",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD",
        "HANA_DB_NAME": "SYSTEMDB",
        "HANA_TLS": "false",
        "HANA_WRITE_PACKAGES": "ZDEMO1"
      }
    }
  }
}
```

**Streamable HTTP 接入**（远程/共享部署；先在服务端设置 `MCP_HTTP_PORT` 启动，见「传输方式」）：

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <MCP_HTTP_TOKEN 值>" }
    }
  }
}
```

> HTTP 模式下连接信息等环境变量配置在**服务端**（服务启动的 shell / .env），客户端只填 `url`；
> 服务端配置了 `MCP_HTTP_TOKEN` 时，客户端经 `headers` 携带 Bearer Token（各客户端对 headers 的支持以自身文档为准）。

> **工具调用超时要自行调大（`hana_sql_analyze` 的 `analyze=true`）**：该模式会**真执行**语句，服务端给执行留的上限是 **5 分钟**（最坏再加约 2.5 分钟的排队与控制面调用）。多数客户端会远早于此掐断调用——例如 Claude Code 默认 **60 秒**——大 CV 会在客户端先被中止，服务端那条语句却还在跑，结果拿不到。请把客户端的单次工具调用超时调到 **600000 ms（10 分钟）**：
> - **按 server 配**：在 `mcp.json` 该 server 条目下加 `"timeout": 600000`（毫秒，覆盖 `MCP_TOOL_TIMEOUT`；小于 1000 的值被忽略）
> - **全局配**：在**启动客户端**的环境里设 `MCP_TOOL_TIMEOUT=600000`

## 许可

本项目自有代码以 [MIT](LICENSE) 授权。第三方依赖仅经 npm 依赖声明引用、由使用者自行安装，不随本项目再分发——许可清单与 `@sap/hana-client`（SAP Developer License 3.2）的使用边界见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
