# saphana-modeler-mcp

> 🌐 中文 | [English](README.en.md)

SAP HANA 经典 Modeler 能力的 MCP 服务器（TypeScript，Node >= 20.12）。面向本地部署 HANA 2.0
（经典 `_SYS_REPO` 仓库建模），提供信息视图（计算视图/属性视图/分析视图）与仓库对象的
**元数据浏览、数据预览、血缘查询与建模写操作**。

通过 MCP 协议接入 Claude / IDE 等客户端（**stdio / Streamable HTTP 双传输**）：调用工具即可浏览、校验与（在配置的可写包内）创建计算视图，无需打开 HANA Studio。

## 功能概览

| 分类 | 能力 | 工具 |
| --- | --- | --- |
| 系统 | 版本信息、用户权限与建模能力自检 | `hana_system_get_info`、`hana_check_privileges` |
| 包 | 包清单/包树、包内对象（含激活状态）、新建包 | `hana_package_list`、`hana_package_list_objects`、`hana_package_create` |
| 元数据 | 完整定义读取、对象搜索、字段清单、单字段逻辑溯源、血缘 | `hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used` |
| 表目录 | 可访问表清单、表列结构 | `hana_table_list`、`hana_table_columns` |
| 数据预览 | 已激活视图数据预览（整体/节点/推导三通道，支持筛选与输入参数）+ 预览权限诊断 | `hana_data_preview`、`hana_data_preview_diagnose` |
| 建模写操作 | 新建/激活/更新/删除计算视图、设计时+运行时校验、校验动作查询 | `hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions` |
| 仓库传输 | 包导出备份（zip）、设计时文件导入、变更列表 | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist` |
| SQL 分析 | SQL 分析结论（默认）：扫描/规模/连接/引擎切换/结构异常的**逐条发现 + 建议 + 统计**；可选实际执行后分析；原始执行计划需 `raw=true` | `hana_sql_analyze` |

> 视图对象的完整定义读取（json/xml）由 `hana_metadata_get_view` 提供；字段级查看用 `hana_metadata_list_fields` / `hana_metadata_get_field_logic`。
> 修改计算视图优先用 `hana_view_update` 的 operations 声明式模式（零 XML）；复杂改造用全量 XML 通道（先用 `hana_metadata_get_view(format=xml)` 读取，最小修改后回传）。

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
| `HANA_INSTANCE` | ✅ | 实例号（00–99） | `10` |
| `HANA_PORT` | 可选 | SQL 端口；留空按实例号自动推导 | `31015` |
| `HANA_USER` | ✅ | 数据库用户名 | — |
| `HANA_PASSWORD` | ✅ | 密码 | — |
| `HANA_LOCALE` | 可选 | 连接语言，默认 `zh_CN` | `zh_CN` |
| `HANA_DB_NAME` | 可选 | 租户数据库名（MDC 必填） | `SYSTEMDB` / 业务租户名 |
| `HANA_TLS` | 可选 | TLS 加密，默认 `true`（fail-closed；仅可信链路显式 `false`） | `true` |
| `HANA_SSL_VALIDATE` | 可选 | TLS 下校验证书，默认 `true`；自签证书环境显式 `false` | `true` |
| `HANA_TIMEZONE` | 可选 | 会话时区，默认 `Asia/Shanghai` | `Asia/Shanghai` |
| `HANA_SCHEMA_ALLOW` | 可选 | 追加允许查询的 schema（逗号分隔，追加到内置白名单） | `SAPABAP1,OTHER_SCHEMA` |
| `HANA_WRITE_PACKAGES` | 可选 | 允许写操作的仓库包前缀（逗号分隔，含子包）。**空=不限制（全部可写）**；填写后仅允许配置包及其下级子包写操作 | `ZDEMO1,ZDEMO2.ZDEMO_SD` |
| `HANA_XS_PORT` | 可选 | XS Classic 设计时 REST 端口（写路径）；省略按实例号推导 `80<instance>` | `8010` |
| `HANA_XS_BASE_PATH` | 可选 | XS 设计时 REST 基础路径，默认 `/sap/hana/xs/dt/base` | — |
| `HANA_TOOL_GROUPS` | 可选 | 启用的工具功能分组（逗号分隔 `read`/`write`/`admin`）；**空=不限制（全部分组启用）** | `read` |
| `HANA_TOOL_ALLOW` | 可选 | 强制启用的工具名 glob（即便其分组未启用也注册；逗号分隔，支持 `*` 通配） | `hana_view_validate` |
| `HANA_TOOL_DENY` | 可选 | 强制禁用的工具名 glob（优先级最高，覆盖 allow 与分组；逗号分隔，支持 `*` 通配） | `hana_data_preview*` |
| `LOG_LEVEL` | 可选 | 日志级别，默认 `info` | `debug` |
| `MCP_HTTP_PORT` | 可选 | Streamable HTTP 端口；设置后以 HTTP 模式启动（端点 `/mcp`），未设置 = stdio（默认）。`0` = 随机端口 | `3000` |
| `MCP_HTTP_HOST` | 可选 | HTTP 监听地址，默认 `127.0.0.1`（仅本机，fail-closed）；对外暴露需显式配置（如 `0.0.0.0`） | `127.0.0.1` |
| `MCP_HTTP_TOKEN` | 可选 | HTTP Bearer Token（≥16 字符）：设置后所有请求须带 `Authorization: Bearer <token>`（timing-safe 比较），缺失/不匹配 → 401；对外暴露时强烈建议配置。单一 Token 无法区分调用方，所有请求归为身份 `shared` | — |
| `MCP_HTTP_TOKENS` | 可选 | **多客户端 Token → 身份映射**（逗号分隔 `name:token`）：每个 Token 对应一个 `clientId`，进 `envelope.clientId` 与审计日志（多客户端共享同一 HANA 账号时的唯一归属来源）。`name` 限 `[A-Za-z0-9_.-]{1,32}`，`token` ≥16 字符；重复/非法则启动失败。可与 `MCP_HTTP_TOKEN` 并存 | `alice:<token>,bob:<token>` |
| `MCP_HTTP_ALLOWED_HOSTS` | 可选 | 允许的 Host 头主机名（DNS rebinding 防护；逗号分隔，不含端口，IPv6 带方括号），默认仅本机名 | `localhost,myhost.corp` |
| `MCP_HTTP_ALLOWED_ORIGINS` | 可选 | 允许的 Origin 主机名（逗号分隔，不含 scheme/端口；无 Origin 头的请求放行），默认仅本机名 | `localhost` |
| `MCP_HTTP_ALLOW_ANONYMOUS` | 可选 | 显式承认「对外监听且不配置任何 Bearer Token」的风险（默认 `false`）。**非回环监听 + 无 Token 时默认拒绝启动**（该姿态下写边界/工具分组/schema 白名单全部形同虚设）；确实需要（如已置于带认证的反向代理之后）再显式置 `true` | `false` |

端口自动推导规则：

- SYSTEMDB / 单容器：`3<instance>13`（如 instance=10 → 31013）
- 租户数据库（MDC）：`3<instance>15`（如 instance=10 → 31015）

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
- **并发与锁**（多客户端共享一个实例时的实际边界）：
  - 更新（`hana_view_update`）：XS REST 的 `If-Match` ETag 乐观锁，基线在**请求入口**捕获，到写入之间的并发改动以 412 显式冲突返回，不静默覆盖
  - 新建（`hana_view_create`）/设计时校验（`hana_view_validate` design 模式）：存在性检查与写入、临时校验副本的「清理 → 写入 → 删除」在服务端按对象串行化（进程内 keyed lock），并发同名创建后者显式报冲突
  - 连接池：上限 4 个连接，池满时排队（队列上限 64、等待超时 30s，超限/超时以可读错误返回而不是无限期挂住），避免单个客户端的慢查询拖住其他客户端
  - 视图定义缓存：TTL 60s + 容量 200 条 LRU，防止多客户端拉取把内存撑大
  - 上述锁均为**进程内**：多进程/多实例部署同一 HANA 时需外部串行化（本服务设计为单实例）
- 未内置 OAuth 等完整认证体系：暴露到网络时请配置 `MCP_HTTP_TOKEN` / `MCP_HTTP_TOKENS` 并置于反向代理 / VPN / 防火墙之后
- 日志仍走 stderr，不污染 HTTP 协议通道；401 日志不记录 Authorization 头内容；Token 原文不驻留于比对结构、不回显到错误信息

```bash
MCP_HTTP_PORT=3000 MCP_HTTP_TOKEN='your-long-random-token' node dist/index.js
# → 已就绪（streamable HTTP transport，端点 /mcp），监听 http://127.0.0.1:3000/mcp
```

## 工具分组与可见性控制

24 个工具按功能划分为三组，可经 mcp.json / .env 的环境变量控制哪些工具对 MCP 客户端可见（不注册即不出现在 `tools/list`、不可被调用）。配置全空 = 全部启用（向后兼容默认）。

### 三类分组

| 分组 | 说明 | 工具 |
| --- | --- | --- |
| **read** 数据读取 | 只读访问 HANA 数据/元数据/系统信息/审计/导出，不改动仓库 | `hana_system_get_info`、`hana_check_privileges`、`hana_package_list`、`hana_package_list_objects`、`hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used`、`hana_table_list`、`hana_table_columns`、`hana_data_preview`、`hana_data_preview_diagnose`、`hana_view_check_actions`、`hana_repo_export`、`hana_repo_changelist` |
| **write** 写操作 | 改动仓库设计时对象/包（create/activate/update/delete/import/设计时校验） | `hana_package_create`、`hana_repo_import`、`hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate` |
| **admin** 管理操作 | 高权限/管理类：生命周期/审计/权限管理，以及**接受任意 SQL** 的高权限分析 | `hana_sql_analyze` |

> `hana_view_validate` 的 `design` 模式会短暂写入临时校验对象 `_CHKTMP`，故整工具归 `write`；不按 design/runtime 模式做混合划分，只读部署（`HANA_TOOL_GROUPS=read`）不暴露此工具。
>
> `hana_sql_analyze` 归 `admin`（不是 `write`）：它**不写业务数据、不碰仓库**，归最严一组是**暴露面控制**——接受任意 SQL 文本（`analyze=true` 时还会真实执行），且 `planId` 模式需要 `OPTIMIZER ADMIN` 权限。**只启用 read/write 的部署看不到它**（`HANA_TOOL_GROUPS=read,write` 不含 admin）。

### 三个配置变量（优先级：`HANA_TOOL_DENY` > `HANA_TOOL_ALLOW` > `HANA_TOOL_GROUPS`）

| 变量 | 语义 | 例 |
| --- | --- | --- |
| `HANA_TOOL_GROUPS` | 启用的分组（逗号分隔）；空=不限制 | `read` 仅暴露数据读取，关闭全部写工具 |
| `HANA_TOOL_ALLOW` | 强制启用的工具（即便其分组未启用也注册），支持**组名**与工具名 glob（`*`），用于分组开关外单独放行 | `hana_some_tool` / `write`（整组放行） |
| `HANA_TOOL_DENY` | 强制禁用的工具（优先级最高），同样支持**组名**与 glob | `hana_data_preview*` 关闭所有预览工具；`write` 关闭整组写工具 |

> **组名可直接用于 allow/deny**（`read` / `write` / `admin`），会展开为该组全部工具名——与 tableau-mcp 的
> `INCLUDE_TOOLS`/`EXCLUDE_TOOLS` 组展开、dataworks-mcp 的 `TOOL_CATEGORIES` 同形。
> 例：`HANA_TOOL_GROUPS=read,write` + `HANA_TOOL_DENY=write` ⇒ 等价于只读部署，且不必逐个写 `hana_view_*`。

**典型部署形态：**

- **只读分析师**：`HANA_TOOL_GROUPS=read` —— 只暴露 16 个只读工具，全部写/校验工具不可见。
- **建模开发者**：`HANA_TOOL_GROUPS=read,write` —— 暴露读取与写操作（默认形态，等价于全空）。
- **关闭特定工具**：`HANA_TOOL_DENY=hana_view_delete` —— 仅禁用删除，其余不受影响。

启动时若配置了过滤变量，日志会打印启用分组与被关闭的工具清单，便于确认配置符合预期。未知分组名（如 `HANA_TOOL_GROUPS=read,bogus`）启动即失败（fail-closed）。

## 工具速查

共 24 个工具，全部带 annotations（`readOnlyHint` / `destructiveHint` / `idempotentHint`）以便 host 自动审批与危险操作确认。

| 工具 | 类型 | 说明 |
| --- | --- | --- |
| `hana_system_get_info` | 只读 | 版本/SID/主机/实例/当前用户与 schema |
| `hana_check_privileges` | 只读 | 当前用户权限矩阵与建模能力摘要（排障入口） |
| `hana_metadata_get_view` | 只读 | 视图完整定义：json=结构化定义（节点/数据源/输出字段/变量），xml=原始设计时 XML |
| `hana_package_list` | 只读 | 仓库包清单（含层级深度、负责人，支持片段过滤/截断） |
| `hana_package_list_objects` | 只读 | 包内对象清单（名称/类型/版本/激活状态，支持过滤/截断） |
| `hana_metadata_search_objects` | 只读 | 按名称片段搜索视图（返回包名/对象名/类型/版本/激活信息） |
| `hana_metadata_list_fields` | 只读 | 视图输出字段清单（ID/描述/类型/聚合/来源/是否带公式） |
| `hana_metadata_get_field_logic` | 只读 | 单字段计算逻辑：公式原文、引用的源字段与溯源、SQLScript 源码 |
| `hana_metadata_where_used` | 只读 | 血缘/依赖：upstream（依赖谁）/ downstream（谁依赖，含运行时引用） |
| `hana_table_list` | 只读 | 指定 schema 下可访问的表 |
| `hana_table_columns` | 只读 | 表的列结构（列名/类型/长度/精度/可空/注释） |
| `hana_data_preview` | 只读 | 已激活视图数据预览：整体直查 / 节点中间视图 / XML 推导三通道，支持筛选与输入参数；权限类失败自动附带诊断报告 |
| `hana_data_preview_diagnose` | 只读 | 数据预览权限诊断：聚焦分析权限保护情况与上游数据源可达性，给出阻塞点与授权建议 |
| `hana_view_create` | 写 | 在可写包内新建计算视图（最小形态：单 Projection + 单源表全列透传；XS REST 写路径） |
| `hana_view_activate` | 写 | 激活设计时计算视图为运行时列视图（XS REST：PUT + SapBackPack Activate，错误明细透传） |
| `hana_view_update` | 写 | 更新计算视图，二选一：operations 声明式补丁（op=add_join 服务端确定性变换，模型零 XML）/ 全量 XML 覆盖（PUT + If-Match 乐观锁；冲突返回 isError + 重读提示） |
| `hana_view_delete` | 写 | 删除设计时计算视图（DELETE；建议先查 where_used） |
| `hana_view_validate` | 校验 | 双模式：design=激活前校验（模拟激活临时副本，原对象不受影响）；runtime=已激活视图一致性校验（SYS.CHECK_CALCULATION_VIEW） |
| `hana_view_check_actions` | 只读 | 查询 CHECK 过程支持的动作清单 |
| `hana_package_create` | 写 | 新建包/目录（XS REST：POST /base/file/<pkg>/，目标须在可写包范围） |
| `hana_repo_export` | 备份 | 导出包为 zip（XS REST Transfer API；saveTo 落盘或返回 base64） |
| `hana_repo_import` | 写 | 导入设计时文件（Transfer API 目录目标+分片上传，落库 inactive，目标须在可写包范围，导入后回读状态） |
| `hana_repo_changelist` | 只读 | 仓库变更列表审计（GET /base/change，需系统启用 Change Tracking） |
| `hana_sql_analyze` | 分析 | SQL 分析：**默认返回可读结论**（一句话结论 + 逐条发现[风险/关注/信息，带依据与建议] + 统计），**默认不给原始计划**（`raw=true` 才返回算子行与文本树）；`sql`=只编译不执行；`planId`=分析计划缓存条目并附运行时统计（需 OPTIMIZER ADMIN）；`sql`+`analyze=true`=先实际执行再分析（30s 超时、最多取 100 行、**不返回数据行**） |

> **PlanViz 未实现（预留扩展点）**：逐算子的实际执行细节（inclusive/exclusive 耗时、实际行数、时间线）只有 PlanViz 的 Executed Plan 提供，需要服务端开启 plan trace 并把 XML 落盘再取回，属运维面能力，本期不做。
> 预留方式是：`source` 为可扩展枚举（后续可加 `planviz` 而不破坏既有取值）、服务入口带 options 形状、本行文档记录路径与前置条件。**不写空实现/僵尸分支**——不可用的路径宁可不出现。

> **写操作安全边界**：写工具（create/activate/update/delete/package_create/import）的可写包范围由
> `HANA_WRITE_PACKAGES` 配置控制——**空=不限制（全部可写）**；填写后仅允许配置包及其下级子包写操作
> （例：`ZDEMO1,ZDEMO2.ZDEMO_SD` 允许 ZDEMO1、ZDEMO1.X、ZDEMO2.ZDEMO_SD、ZDEMO2.ZDEMO_SD.SUB，拒绝其他）。
> 同名对象拒绝覆盖；update/delete 带 ETag 乐观锁。
>
> **写边界预检（启动即校验）**：服务启动时打印生效的可写包范围——配了则 info 列出白名单；未配
> （=不限制）且写工具已对客户端暴露则 warn 显式告警。这样"以为配了边界、实际全库可写"不会拖到
> 写操作才暴露。`HANA_WRITE_PACKAGES` 含非法包名（`ZDEMO.`、`ZDE MO`、`*` 等）在配置加载时即失败
> 并给出修复提示，不再被静默保留成永不匹配的前缀（那会导致写操作全被拒或边界形同虚设）。
> 另注意生效值取决于启动来源：以 mcp.json 启动的 stdio 服务以该文件 env 为准，凭据三件套齐备时
> 仓库 `.env` 整个文件被跳过（服务不会去读它）——同一台机器上三处配置可能给出三个不同答案。
>
> **权限策略层（两个权限级功能）**：`src/config/preflight.ts` 是唯一的判定入口，按两个维度组织——
>
> | 维度 | 管什么 | 配置项 | 参考 |
> |---|---|---|---|
> | **能力级** | 哪些工具对外暴露 | `HANA_TOOL_GROUPS` / `ALLOW` / `DENY`（支持组名） | tableau 的 INCLUDE/EXCLUDE_TOOLS；dataworks 的 TOOL_CATEGORIES/NAMES |
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
> **运行期闸门（工具层，先规划后判定）**：所有写工具（`hana_view_*`、`hana_package_create`、`hana_repo_import`）
> 与 `hana_sql_analyze`（归 admin 组，但闸门按组无关的「规划→判定」逻辑同样适用）
> 经 `registerWriteTool` 注册，请求进入 handler **之前**分两步：
> ① **预规划**（`src/write-plan.ts` + `src/tools/write-plans.ts`）——把这次调用最终会读写什么算清楚，
> 产出 `WritePlan`（写哪些包 / 读哪些 schema / 跨包只读引用 / 无法静态确定的点）；
> ② **判定**（预检层按生效权限配置）——不通过直接返回硬错误（`isError`），**不进 handler、不进 service**。
>
> 为什么不能只看参数：`hana_view_update` 的 `add_join`，**join 源在另一个包**，藏在 `operations` 里；
> `hana_view_validate` 参数看着是"校验"，design 模式实际会**写入** `_CHKTMP` 临时对象；
> `hana_repo_import` 的导入内容里可能引用别的包；`hana_view_delete` 的下游依赖会失效。
> 这些都只有把请求解析一遍才知道，`WritePlan` 的 `steps` 与 `uncertain` 会一并进拦截报告，
> 让调用方看清"本来会发生什么"再决定怎么改。
>
> 判定用服务已加载的配置（不重新解析 env），不存在"判定用的值 ≠ 运行用的值"。
> 跨包只读引用当前**只报告不拦截**（权限配置里没有"可读包"这一项，加白名单会破坏既有的跨包 join 用法）。
> service 层的 `assertWritePackageAllowed` 保留为纵深防御（脚本/内部调用不经过工具层），并复用同一判定规则。
> 执行任务前可先自检：`npm run preflight -- <包名...> [--tool <工具名>] [--schema <schema>]`，
> 退出码 `0`=可执行 / `1`=被拦截 / `2`=用法错误；本地模式加 `--from <mcp.json>` 以客户端注入的那份配置为准
> （它与仓库 `.env` 不是同一个来源）。
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
| `npm run typecheck` | 仅类型检查 |
| `npm run verify:system` | 构建 + 真实 HANA 系统工具验收 |
| `npm run verify:p1-5` | 构建 + 读路径/预览/字段逻辑黑盒验收 |
| `npm run verify:lifecycle` | 构建 + 写路径全生命周期验收（create→validate→activate→preview→update冲突→delete→import；脚本在本地 `test-verification/`，不入库） |

## 架构简介

```
src/
  index.ts            入口：加载配置 → 连接池 → stdio / Streamable HTTP transport 分支
  http.ts             Streamable HTTP 传输：createMcpHandler 按请求工厂 + node:http 适配 + Host/Origin 防护
  server.ts           McpServer（server instructions 领域上下文）+ 全部工具注册
  config/             zod 环境变量校验（连接/TLS/时区/白名单/可写包）
  core/               HANA 连接池（有界排队+等待超时）、SQL 转义与白名单、错误 envelope、日志脱敏、
                      请求身份上下文（HTTP 多客户端归因）、写临界区 keyed lock、XML 工具、XS REST 客户端
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

## 许可

本项目自有代码以 [MIT](LICENSE) 授权。第三方依赖仅经 npm 依赖声明引用、由使用者自行安装，不随本项目再分发——许可清单与 `@sap/hana-client`（SAP Developer License 3.2）的使用边界见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
