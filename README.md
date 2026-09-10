# saphana-modeler-mcp

> 🌐 中文 | [English](README.en.md)

SAP HANA 经典 Modeler 能力的 MCP 服务器（TypeScript，Node >= 20.12）。面向本地部署 HANA 2.0
（经典 `_SYS_REPO` 仓库建模），提供信息视图（计算视图/属性视图/分析视图）与仓库对象的
**元数据浏览、数据预览、血缘查询与建模写操作**。

通过 MCP stdio 协议接入 Claude / IDE 等客户端：调用工具即可浏览、校验与（在配置的可写包内）创建计算视图，无需打开 HANA Studio。

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

连接信息只允许来自环境变量 / `mcp.json` 的 `env` / 项目根 `.env`，不提供默认值，缺失时服务启动即失败。

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
| `MCP_HTTP_PORT` | 预留 | streamable HTTP 端口（当前主线为 stdio） | — |

端口自动推导规则：

- SYSTEMDB / 单容器：`3<instance>13`（如 instance=10 → 31013）
- 租户数据库（MDC）：`3<instance>15`（如 instance=10 → 31015）

## 工具分组与可见性控制

23 个工具按功能划分为三组，可经 mcp.json / .env 的环境变量控制哪些工具对 MCP 客户端可见（不注册即不出现在 `tools/list`、不可被调用）。配置全空 = 全部启用（向后兼容默认）。

### 三类分组

| 分组 | 说明 | 工具 |
| --- | --- | --- |
| **read** 数据读取 | 只读访问 HANA 数据/元数据/系统信息/审计/导出，不改动仓库 | `hana_system_get_info`、`hana_check_privileges`、`hana_package_list`、`hana_package_list_objects`、`hana_metadata_get_view`、`hana_metadata_search_objects`、`hana_metadata_list_fields`、`hana_metadata_get_field_logic`、`hana_metadata_where_used`、`hana_table_list`、`hana_table_columns`、`hana_data_preview`、`hana_data_preview_diagnose`、`hana_view_check_actions`、`hana_repo_export`、`hana_repo_changelist` |
| **write** 写操作 | 改动仓库设计时对象/包（create/activate/update/delete/import/设计时校验） | `hana_package_create`、`hana_repo_import`、`hana_view_create`、`hana_view_activate`、`hana_view_update`、`hana_view_delete`、`hana_view_validate` |
| **admin** 管理操作 | 生命周期/审计/权限管理类（当前为空占位，预留给 `hana_privilege_create` 等后续工具） | （暂无） |

> `hana_view_validate` 的 `design` 模式会短暂写入临时校验对象 `_CHKTMP`，故整工具归 `write`；不按 design/runtime 模式做混合划分，只读部署（`HANA_TOOL_GROUPS=read`）不暴露此工具。

### 三个配置变量（优先级：`HANA_TOOL_DENY` > `HANA_TOOL_ALLOW` > `HANA_TOOL_GROUPS`）

| 变量 | 语义 | 例 |
| --- | --- | --- |
| `HANA_TOOL_GROUPS` | 启用的分组（逗号分隔）；空=不限制 | `read` 仅暴露数据读取，关闭全部写工具 |
| `HANA_TOOL_ALLOW` | 强制启用的工具名 glob（即便其分组未启用也注册；支持 `*`），用于分组开关外单独放行个别工具 | `hana_some_tool` |
| `HANA_TOOL_DENY` | 强制禁用的工具名 glob（优先级最高；支持 `*`） | `hana_data_preview*` 关闭所有预览工具 |

**典型部署形态：**

- **只读分析师**：`HANA_TOOL_GROUPS=read` —— 只暴露 16 个只读工具，全部写/校验工具不可见。
- **建模开发者**：`HANA_TOOL_GROUPS=read,write` —— 暴露读取与写操作（默认形态，等价于全空）。
- **关闭特定工具**：`HANA_TOOL_DENY=hana_view_delete` —— 仅禁用删除，其余不受影响。

启动时若配置了过滤变量，日志会打印启用分组与被关闭的工具清单，便于确认配置符合预期。未知分组名（如 `HANA_TOOL_GROUPS=read,bogus`）启动即失败（fail-closed）。

## 工具速查

共 23 个工具，全部带 annotations（`readOnlyHint` / `destructiveHint` / `idempotentHint`）以便 host 自动审批与危险操作确认。

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

> **写操作安全边界**：写工具（create/activate/update/delete/package_create/import）的可写包范围由
> `HANA_WRITE_PACKAGES` 配置控制——**空=不限制（全部可写）**；填写后仅允许配置包及其下级子包写操作
> （例：`ZDEMO1,ZDEMO2.ZDEMO_SD` 允许 ZDEMO1、ZDEMO1.X、ZDEMO2.ZDEMO_SD、ZDEMO2.ZDEMO_SD.SUB，拒绝其他）。
> 同名对象拒绝覆盖；update/delete 带 ETag 乐观锁。

## 数据预览

`hana_data_preview` 三条预览通道（返回 `via` 字段标识）：

| 通道 | 触发 | 机制 | 需要权限 |
| --- | --- | --- | --- |
| `direct`（整体预览） | 不传 `node` | `SELECT * FROM "_SYS_BIC"."包/视图名"` | `_SYS_BIC` 数据访问 |
| `intermediate`（节点预览·默认） | 传 `node` | HANA 原生中间视图 `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV`（Studio 节点预览同款），CREATE 临时视图 → SELECT → 自动 DROP | `EXECUTE` on 上述过程 |
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
| `npm run typecheck` | 仅类型检查 |
| `npm run verify:system` | 构建 + 真实 HANA 系统工具验收 |
| `npm run verify:p1-5` | 构建 + 读路径/预览/字段逻辑黑盒验收 |
| `npm run verify:lifecycle` | 构建 + 写路径全生命周期验收（create→validate→activate→preview→update冲突→delete→import；脚本在本地 `test-verification/`，不入库） |

## 架构简介

```
src/
  index.ts            入口：加载配置 → 连接池 → 创建 MCP server → stdio
  server.ts           McpServer（server instructions 领域上下文）+ 全部工具注册
  config/             zod 环境变量校验（连接/TLS/时区/白名单/可写包）
  core/               HANA 连接池、SQL 转义与白名单、错误 envelope、日志脱敏、XML 工具、XS REST 客户端
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
  tools/               MCP 工具薄壳（system/package/metadata/preview/modeling）
  types/               统一返回信封 Envelope 等
scripts/               通用冒烟脚本（smoke-stdio）；实机验收/探针脚本在本地 test-verification/（不入库）
```

> `tests/` 与 `docs/` 不入库（含环境标识/探测记录，本地保留供开发）；克隆后按需自备测试与文档。

每个工具统一返回信封 `{ success, data?, messages[], raw? }`：硬错误（参数非法/对象不存在）通过 MCP
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

## 许可

本项目自有代码以 [MIT](LICENSE) 授权。第三方依赖仅经 npm 依赖声明引用、由使用者自行安装，不随本项目再分发——许可清单与 `@sap/hana-client`（SAP Developer License 3.2）的使用边界见 [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md)。
