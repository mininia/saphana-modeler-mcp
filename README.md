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
| 系统 | 版本信息、用户权限与建模能力自检 | `hana_system_get_info`、`hana_check_privileges` |
| 稳定性诊断 | 实例体检（读数 + 12 项结论、三态）、会话与阻塞深潜、表存储画像、历史趋势 | `hana_system_health`、`hana_system_activity`、`hana_table_storage`、`hana_system_trend` |
| 包 | 包清单/包树、包内对象、新建包 | `hana_package_list`、`hana_package_list_objects`、`hana_package_create` |
| 元数据 | 完整定义、对象搜索、字段清单、单字段逻辑、血缘 | `hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used` |
| 表目录 | 可访问表清单、列结构 | `hana_table_list`、`hana_table_columns` |
| 数据预览 | 已激活视图预览（整体/节点/推导三通道）+ 权限诊断 | `hana_data_preview`、`hana_data_preview_diagnose` |
| 建模写操作 | 新建/激活/更新/删除计算视图、设计时+运行时校验 | `hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate`、`hana_view_check_actions` |
| 仓库传输 | 包导出备份、设计时文件导入、变更列表 | `hana_repo_export`、`hana_repo_import`、`hana_repo_changelist` |
| SQL 分析 | 可读分析结论；`analyze=true` 走 PlanViz 逐算子实测；`async=true` 后台执行并轮询；`raw=true` 给原始计划 | `hana_sql_analyze` |

## 快速开始

**npx 一键启动（npm 预构建包，无需克隆/编译）：**

```bash
npx -y @mininia/saphana-modeler-mcp
```

最小 `mcp.json` 见下方「配置」。

> 从源码安装（会本地构建，需 Node >= 22）：`npx -y github:mininia/saphana-modeler-mcp`。

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

**必填参数：**

| 参数 | 说明 |
| --- | --- |
| `HANA_HOST` / `HANA_PORT` | HANA 主机与 SQL 端口（端口必填，纯数字） |
| `HANA_USER` / `HANA_PASSWORD` | 数据库用户名与密码 |

MDC 环境还需 `HANA_DB_NAME`。缺失必填项时服务启动即失败。

`HANA_XS_PORT`（XS 设计时 REST 端口）**非必填，默认 8010**；非默认实例/租户请显式覆盖。

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

> 本地 clone 运行：把 `command`/`args` 换成 `"node"` / `["<仓库绝对路径>/dist/index.js"]`。

## 运行方式

- **stdio（默认）**：不设置 `MCP_HTTP_PORT`，由 MCP 客户端拉起进程。
- **Streamable HTTP**：设置 `MCP_HTTP_PORT=3000` 后 `npm start`，端点 `http://127.0.0.1:3000/mcp`。
  对外暴露需配置 `MCP_HTTP_HOST` / `MCP_HTTP_ALLOWED_HOSTS` / `MCP_HTTP_TOKENS`；无 Token 的非回环监听默认拒绝启动。
  详见 [CONFIG.md](CONFIG.md) 的「传输方式」。

## 工具面：六个分类门面 + 按需提升

`tools/list` 常驻的只有六个分类门面；具体能力默认隐藏，经门面索引 + 路由调用，调门面时按分类提升进工具面。

| 门面 | 方向 | 成员数 |
| --- | --- | --- |
| `hana_system` | 连接与环境：当前连接是谁、连到哪 | 2 |
| `hana_discovery` | 浏览与查找：找包/对象/表，读定义与字段结构 | 7 |
| `hana_data` | 取数预览：看已激活视图/基表的数据 | 2 |
| `hana_insights` | 结构与血缘分析：影响面、字段级计算逻辑 | 2 |
| `hana_modeling` | 建模与仓库变更：创建/修改/校验/激活/删除、导入导出 | 11 |
| `hana_diagnostics` | 运维与性能：健康/会话/存储/趋势、SQL 分析、变更审计 | 6 |

```jsonc
// 取本类索引（id / 标题 / kind / 摘要 / 参数名）
hana_modeling({})
// 调具体能力（不提升也能调）
hana_modeling({ "capability": "hana_view_update", "args": { … } })
// 提升整类：此后可平铺直调，带完整 schema
hana_view_update({ … })
```

- 权限只有**一层（能力层）**：门面是入口，常驻；索引/路由/提升/调用一律按**目标能力**判。
- 拒绝不泄漏存在性：未知能力、无权能力、跨类路由**逐字同形**。
- 操作级别名 `hana_view_update#<op>`（8 条）只经门面路由，不注册为工具。
- 工具分组、档案与动态面细节见 [CONFIG.md](CONFIG.md)。

## 数据预览

`hana_data_preview` 三条通道（返回 `via` 标识）：

| 通道 | 触发 | 机制 |
| --- | --- | --- |
| `direct` | 不传 `node` | 直查 `_SYS_BIC` 运行时视图 |
| `intermediate` | 传 `node` | HANA 原生中间视图 `<包/对象>/dp/<节点>`，存在即复用，按占用释放 |
| `derived` | 传 `node` + `forceDerive=true` | 依据视图 XML 推导 SQL，纯只读 |

无筛选默认 10 行，有筛选默认 100 行，显式 `limit` 上限 1000；截断见回执 `resultInfo`。
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
  capabilities/                    能力清单（kind/effects/schema）+ 分类门面
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
