# saphana-modeler-mcp

> 🌐 中文 | [English](README.en.md)

SAP HANA 经典 Modeler 能力的 MCP 服务器（TypeScript，Node >= 22.0.0）。面向本地部署 HANA 2.0
（经典 `_SYS_REPO` 仓库建模），提供视图与仓库对象的**元数据浏览、数据预览、血缘查询与建模写操作**。
通过 MCP 协议接入 Claude / IDE 等客户端（**stdio / Streamable HTTP 双传输**），无需打开 HANA Studio。

**让 AI 独立完成 SAP HANA 开发**：看懂仓库里已有什么、对象怎么关联，判断该改什么、动手改、再自己确认改对了——
语义能被理解、动作能被完成、边界可控。

## 功能概览

| 分类 | 能力 | 工具 |
| --- | --- | --- |
| 基础信息 | 版本信息（HANA 与本 MCP 服务自身版本）、用户权限与建模能力自检 | `hana_system_get_info`、`hana_check_privileges` |
| 环境管理（多环境） | 环境列表、只读/可写标识、一次性 token 切换 | `hana_env_list`、`hana_env_switch` |
| 稳定性诊断 | 实例体检、会话与阻塞深潜、表存储画像、历史趋势 | `hana_system_health`、`hana_system_activity`、`hana_table_storage`、`hana_system_trend` |
| 包 | 包清单/包树、包内对象、新建包 | `hana_package_list`、`hana_package_list_objects`、`hana_package_create` |
| 元数据 | 对象搜索（名称/描述）、字段清单、字段逻辑、血缘 | `hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used` |
| 表目录 | 可访问表清单、表注释搜索、列结构 | `hana_table_list`、`hana_table_columns` |
| 数据预览 | 已激活视图预览（整体/节点）+ 数据预览权限诊断 | `hana_data_preview`、`hana_data_preview_diagnose` |
| 建模写操作 | 新建/激活/更新/删除计算视图、设计时+运行时校验 | `hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions` |
| 仓库传输 | 包导出备份、设计时文件导入、变更列表 | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist` |
| SQL 分析 | 可读分析结论；PlanViz 逐算子实测 | `hana_sql_analyze` |
| SQL 执行 | 在 HANA 上直接执行 SQL（读/写/管理类）。**sql 组默认关闭**，需显式启用 | `hana_sql_execute` |

## 快速开始

**npx 一键启动（npm 预构建包，无需克隆/编译）：**

```bash
npx -y @mininia/saphana-modeler-mcp
```

最小 `mcp.json` 见下方「配置」。

> 从源码安装（需 Node >= 22）：`npx -y github:mininia/saphana-modeler-mcp`。

**克隆本地运行：**

```bash
git clone https://github.com/mininia/saphana-modeler-mcp.git
cd saphana-modeler-mcp
npm install          # 构建工具链在 optionalDependencies，勿用 --omit=optional
cp .env.example .env # 填写真实 HANA 连接
npm run build
node scripts/smoke-stdio.mjs   # 冒烟：握手 + 工具注册（无需真实 HANA）
```

## 配置

**必填参数（单环境）：**

| 参数 | 说明 |
| --- | --- |
| `HANA_HOST` / `HANA_PORT` | HANA 主机与 SQL 端口（端口必填，纯数字） |
| `HANA_USER` / `HANA_PASSWORD` | 数据库用户名与密码 |

单环境下 MDC 指定租户时需 `HANA_DB_NAME`；非 MDC 可省略。单环境缺失必填项时服务启动即失败。

单环境下 `HANA_XS_PORT`（XS 设计时 REST 端口）**非必填，默认 8010**；非默认实例/租户请显式覆盖。

**完整参数、配置来源、工具分组与可见性、调用方档案、传输方式、安全边界、HANA 授权要求：见 [CONFIG.md](CONFIG.md)。**

最小 `mcp.json`（npx 启动）：

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "command": "npx",
      "args": ["-y", "@mininia/saphana-modeler-mcp"],
      "env": {
        "HANA_HOST": "hana-host.example",
        "HANA_PORT": "31015",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD"
      }
    }
  }
}
```

**多 HANA 环境（可选）**：用 `HANA_<PARAM>_ENV_<XXXX>` 定义多个环境。连接参数按环境写（扁平 `HANA_HOST` 等会被忽略），`HOST/PORT/USER/PASSWORD` 每个环境必填；`HANA_TOOL_GROUPS` / `HANA_TOOL_DENY` / `HANA_WRITE_PACKAGES` / `HANA_READ_SCHEMA` / `HANA_SQL_ACCESS` 扁平写 = 共享，`_ENV_` 覆盖单个环境。**多环境的 entitlement（search + invoke）按当前环境编译，等价于多个单环境**。环境标识就是 `<XXXX>`（大小写不敏感），用 `hana_env_list` / `hana_env_switch` 切换；HTTP 用 `MCP_HTTP_CLIENT_ENVS` 绑定 Token。完整规则见 [CONFIG.md 的「多 HANA 环境」](CONFIG.md#多-hana-环境单进程单-active)。

多环境 `mcp.json` 示例（npx 启动，三个环境）：

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp-multi": {
      "command": "npx",
      "args": ["-y", "@mininia/saphana-modeler-mcp"],
      "env": {
        "HANA_HOST_ENV_DEV": "hana-dev.example",
        "HANA_PORT_ENV_DEV": "31015",
        "HANA_USER_ENV_DEV": "DEV_USER",
        "HANA_PASSWORD_ENV_DEV": "***",

        "HANA_HOST_ENV_UAT": "hana-uat.example",
        "HANA_PORT_ENV_UAT": "31015",
        "HANA_USER_ENV_UAT": "UAT_USER",
        "HANA_PASSWORD_ENV_UAT": "***",

        "HANA_HOST_ENV_PROD": "hana-prod.example",
        "HANA_PORT_ENV_PROD": "31015",
        "HANA_USER_ENV_PROD": "PROD_USER",
        "HANA_PASSWORD_ENV_PROD": "***",

        "HANA_WRITE_PACKAGES_ENV_DEV": "ZDEMO",

        "HANA_ENV_START": "DEV",
        "HANA_ENV_SWITCHABLE": "DEV,UAT,PROD"
      }
    }
  }
}
```

> 说明：
> 多环境下扁平的连接参数(`HANA_HOST`等)，此类配置会被忽略。
> 每个环境必须显式提供 `HANA_HOST_ENV_*` / `HANA_PORT_ENV_*` / `HANA_USER_ENV_*` / `HANA_PASSWORD_ENV_*`。
> `HANA_WRITE_PACKAGES_ENV_DEV` 仅为 DEV 启用写边界（DEV=readwrite）；UAT 与 PROD 没有写包（只读）。
> 非默认 XS 端口通过`HANA_XS_PORT_ENV_<XXXX>` 配置；HTTP 模式下使用 `MCP_HTTP_CLIENT_ENVS` 将 Token 绑定到环境。

> **stdio 下的环境切换是进程级的**：只影响之后的调用，已提交任务与在途调用仍绑定原环境；并发 agent 共享同一 active 环境，建议一进程一环境。

## 运行方式

- **stdio（默认）**：不设置 `MCP_HTTP_PORT`，由 MCP 客户端拉起进程。
- **Streamable HTTP**：设置 `MCP_HTTP_PORT=3000` 后 `npm start`，端点 `http://127.0.0.1:3000/mcp`。
  对外暴露需配置 `MCP_HTTP_HOST` / `MCP_HTTP_ALLOWED_HOSTS` / `MCP_HTTP_TOKENS`；无 Token 的非回环监听默认拒绝启动。
  详见 [CONFIG.md](CONFIG.md) 的「传输方式」。

## 工具面：本体层选择 + 唯一执行入口

`tools/list` 常驻且**只有两个**平台工具：

| 工具 | 职责 |
| --- | --- |
| `hana_tool_search` | 本体层：`discover` 找候选、`contract` 一次取完整契约、`goal` 取预设配方；**不执行、不授权、不改工具面** |
| `hana_invoke` | 唯一执行入口：`{ capability, args }`，按目标能力重新过授权、schema、预检与审批 |

具体能力（含 `hana_sql_execute`、环境切换、`hana_view_update#<op>` 操作级别名）**永不注册为工具**。
没有分类门面，也没有平铺的具体工具：想调用任何能力，都必须先经 `hana_tool_search` 选择，再用
`hana_invoke` 执行。这两个入口本身都不会改变工具面（无 `list_changed`）。

### 三阶段

| 阶段 | 调用 | 返回 |
| --- | --- | --- |
| 发现 | `hana_tool_search({ mode: "discover", query: "权限 诊断", category: "data" })` | 候选卡（id/标题/用途/授权类别），不含完整 schema |
| 披露 | `hana_tool_search({ mode: "contract", tools: ["hana_metadata_get_view", "hana_data_preview_diagnose"] })` | 完整输入 JSON Schema、required、exampleArgs、constraints、effects、access、returns、`call.via` |
| 执行 | `hana_invoke({ capability: "hana_metadata_get_view", args: { packageId, objectName } })` | 目标能力的原始 envelope |

固定流程用 `goal`：

```jsonc
hana_tool_search({ "mode": "goal", "goal": "diagnose_preview_permission",
                   "bindings": { "packageId": "ZDEMO", "objectName": "ZDEMO_CV_SDR008" } })
```

- 契约里的 `call.via` 恒为 `hana_invoke`；配方步骤的 `steps[].via` 同样如此。
- **权限/预览失败（258/2950）**：先取 `diagnose_preview_permission` 配方（根对象 derived、上游逐个 direct），再按步骤执行；不要先猜参数或用 `hana_data_preview` 取数验证。
- 集合内任一 id 未知/无权 → **整包拒绝**，与未知能力逐字同形。
- 多环境下的**所有**调用需带 `contextToken`（`hana_tool_search` 回执签发；旧 `expectedEnvironment:{key,epoch}` 仍兼容一个版本）；切环境后旧 token 失效（`context_stale`）。
- 预算护栏：`maxTools`（默认 12 / 硬上限 20）、`maxSchemaBytes`（默认 32KB/工具）、`maxResponseBytes`（默认 256KB）；超限给 `budget_exceeded`，不静默丢契约。
- **可显式关闭 goal 模式**：`HANA_TOOL_SEARCH_GOAL=off` 时只保留 `discover`/`contract`，`mode=goal` 返回可恢复错误；工具面与 `hana_invoke` 不变，用于验证不走配方的选择路径。
- **调用上下文**：推荐 `hana_invoke({ capability, args, contextToken })`；`expectedEnvironment` / `disclosure` 是兼容字段。
- **审批固定启用**：`effects.destructive=true` 的能力在策略放行后返回 `input_required`，确认绑定 args/调用方/5 分钟过期；不再有 `HANA_APPROVAL` 开关。
- **SQL 访问模式**：`HANA_SQL_ACCESS=select-only`（默认）只允许 SELECT 类；`readwrite` 才允许 SQL 写；对象级 schema/对象访问由 HANA 账号权限决定。
- 权限模型见 [CONFIG.md 的「权限参数（4 个 + SQL 模式）」](CONFIG.md#权限参数4-个--sql-模式)。
- 多环境部署时 `hana_env_list` / `hana_env_switch` 经本体层发现与执行；单环境不可见。
- 拒绝不泄漏存在性：未知能力、无权能力、平台入口自身目标**逐字同形**。
- 工具分组与可见性规则见 [CONFIG.md 的「工具分组与可见性控制」](CONFIG.md#工具分组与可见性控制)；调用方档案见 [「调用方档案（MCP_PROFILES）」](CONFIG.md#调用方档案mcp_profiles)。

## 数据预览

`hana_data_preview` 三条通道（返回 `via` 标识）：

| 通道 | 触发 | 场景 | 机制 |
| --- | --- | --- | --- |
| `direct` | 不传 `node` | 看视图最终结果 | 直查 `_SYS_BIC` 运行时视图 |
| `intermediate` | 传 `node` | 看某个中间节点的真实输出（Join/Aggregation 等） | HANA 原生中间视图 `<包/对象>/dp/<节点>`；执行用户需 EXECUTE 权限 |
| `derived` | 传 `node` + `forceDerive=true` | 无中间视图权限，或不想创建临时对象时看节点 | 依据视图 XML 推导 SQL，纯只读 |

无筛选默认 10 行，有筛选默认 100 行，显式 `limit` 上限 1000。
权限类失败自动附诊断报告（`raw.diagnosis`），也可用 `hana_data_preview_diagnose` 手动排查。

## 常用命令

| 命令 | 说明 |
| --- | --- |
| `npm run dev` | tsx 直接运行（开发调试） |
| `npm run build` | tsc 构建到 dist |
| `npm start` | 运行 dist/index.js（stdio） |
| `npm test` | 单元测试（node --test + tsx） |
| `npm run smoke` / `smoke:http` | stdio / HTTP 冒烟（无需真实 HANA） |
| `npm run check` | 工具名守卫 + 类型检查 + 单测（提交前跑这个） |
| `npm run format` | Prettier 格式化 |
| `npm run preflight -- <包名...>` | 写操作权限预检（退出码 0/1/2） |
| `npm run verify:*` / `probe:*` | 实机验收/探针；脚本在本地 `test-verification/`（不入库），需真实 HANA |

> `tests/`、`test-verification/`、`docs/` 均不入库；克隆后相关命令需自备本地文件。

## 架构简介

```
src/
  index.ts / http.ts / server.ts   入口、stdio/HTTP 传输、McpServer + 工具注册
  config/                          环境变量校验、权限策略与调用期闸门
  core/                            连接池、SQL 白名单、错误 envelope、日志脱敏、锁与信号量、XS REST
  model/                           视图类型、XML 解析/构造
  capabilities/                    能力清单（kind/effects/schema/本体契约）+ 平台入口
  rules/                           规则正文目录（按 id 查询）
  services/                        元数据/预览/仓库写/SQL 分析/稳定性诊断
  tools/                           MCP 工具薄壳
  types/                           统一返回信封 Envelope
```

每个工具统一返回信封 `{ success, data?, messages[], raw?, resultInfo?, empty? }`（HTTP 模式另带 `clientId`）：
协议级硬错误走 `isError` + 恢复提示；HANA 业务失败走 `success:false`；写路径 412/404 属业务信封。

- `resultInfo`：截断契约（`returnedCount` / `totalAvailable?` / `truncated` / `truncationReason`）。没有该字段 = 不存在被截断。
- `empty`：合法空集（`success:true` + `empty:true` + `EMPTY_RESULT`）；权限不可见/上游失败仍为 `success:false`。
  扫描空间被 cap 截断时可能 0 条 + `truncated:true`（不带 `empty`）——表示"没扫完"，不是"确定没有"。

分层与开发约定见 [CONTRIBUTING.md](CONTRIBUTING.md)；规则全文用 `hana_system_get_info(rules=…)` 查询。

## MCP 客户端接入

**stdio（Claude Desktop / Cursor / VS Code）**：见上方「配置」的最小 `mcp.json`（npx 启动）；
本地构建产物把 `command`/`args` 换成 `node` / `["<仓库绝对路径>/dist/index.js"]`。

**Streamable HTTP**（服务端先设置 `MCP_HTTP_PORT` 启动）：

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <MCP_HTTP_TOKENS 中该客户端对应的 Token>" }
    }
  }
}
```

> **长分析 / 长变更集**：用 `hana_sql_analyze(async=true)` / `hana_view_update(async=true)` 拿 taskId 轮询，
> 避开客户端单次调用超时；同步模式的客户端超时设置见 [CONFIG.md](CONFIG.md) 的「工具调用超时」。

## 许可

本项目自有代码以 [MIT](LICENSE) 授权。第三方依赖经 npm 声明引用、由使用者自行安装；许可清单与
`@sap/hana-client`（SAP Developer License 3.2）的使用边界见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
