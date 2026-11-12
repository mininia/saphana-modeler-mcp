# Changelog

> 回溯自 git 提交与版本标签，只记对外可见的变化。
>
> 约定：每次提交前把变化补到对应版本条目下；每条 1–3 行，只写对外可见变化。

## 1.4.2 - 2026-11-12

- 元数据查询功能优化：`hana_metadata_search_objects` 支持按描述/注释搜索（`by=description|both`）——模型读仓库 caption 文本表（不解析 XML），表/列视图读 `COMMENTS`；表函数目录无描述列。
- 同一工具新增对象类别 `category=model|table|columnView|tableFunction|all`（对齐 HANA Studio Find 页签）与 `packageId`/`schema`/`lang` 过滤；`category=all` 按类别分组返回 `groups`+`counts`。
- `hana_table_list` 支持 `by=name|comment|both` 与 `tableType`（ROW/COLUMN/VIRTUAL）过滤。

## 1.4.1 - 2026-11-12

- 修复新增权限维度与工具权限控制的冲突：环境只读闸门改按清单 `effects.mutates` 判定，只拦持久写入；`hana_data_preview` 等临时对象能力在 `HANA_ACCESS=readonly` 下恢复可用。
- 多环境 `expectedEnvironment` 与审计终态同步该口径：非纯读（含临时对象）才要求断言，只有持久写入记 `completed/failed`。

## 1.4.0 - 2026-11-10

- 新增 `hana_sql_execute`：独立的第七个根工具（`sql` 组，默认关闭且对模型完全不可见），直接执行读/写/管理类 SQL；默认单条语句+单物理行，多语句自动事务，`async=true` 返回 taskId；审计只记 SQL 指纹与字符数，不落原文。
- 支持单进程多 HANA 环境：共用 `HANA_*` + `HANA_<PARAM>_ENV_<XXXX>` 只覆盖差异、`LABEL` 系统标识、一次性 token 切换、只读闸门与 HTTP `MCP_HTTP_CLIENT_ENVS` Token→环境绑定；同库多 `LABEL` 共享对象锁与预览占用。
- 安全/修复：拒绝修改会话状态的 `SET`；LOB 结果异步取值；单环境 `HANA_ACCESS=readonly` 生效；只读环境不误拦行为只读的 admin；门面索引补齐 `expectedEnvironment`；切换后 `task-draining` 自动回收。

## 1.3.1 - 2026-10-29

- Node 下限从 `>=24.18.1` 降至 `>=22.0.0`（22.23.4 上 typecheck/build/1070 单测/两条 smoke 全绿；Node 20 已 EOL，运行时在 20.12.2 上实测可跑）。
- 修复 stdio/HTTP 冒烟脚本的 dummy 配置：`HANA_PORT` 为空导致 `npm run smoke` 启动即失败；同时移除已废弃的 `HANA_INSTANCE`。
- 发布到 npm：`npx -y @mininia/saphana-modeler-mcp`（预构建 dist，无需本地编译）。

## 1.3.0 - 2026-10-27

- 结果契约：新增 `resultInfo`（截断原因）与 `empty`（合法空集）；旧字段 `data.truncated/count/limit` 兼容保留。
- 审计：写能力每次尝试一条终态 `denied | completed | failed`。
- 工具面：门面回执新增 `status/warnings/notes` 与 `surface` 说明；`HANA_EXPLAIN_SURFACE=names` 调试开关。
- `hana_sql_analyze` 新增 `async=true`：后台任务 + `hana_task_get` 轮询，不受客户端单次调用超时限制。
- `HANA_XS_PORT` 改为非必填、默认 `8010`（非默认实例/租户仍需显式覆盖）。
- 修复：异步分析失败落 `failed`；提升失败可重试；并发 COUNT 竞态不再报内部错误。
- 安全/工程：XS `Location` 同源校验；`check:tool-names` 与面预算守卫。
- 文档：README 精简，详细配置与权限移至 `CONFIG.md`。

## 1.2.2 - 2026-10-26

- 元数据读取支持 `version=inactive`；写回执在目标无激活版本时标注 `noActiveVersion`。
- 精简全部工具说明与工具层注释。

## 1.2.1 - 2026-10-14

- 环境变量面收窄：无别名层；`HANA_PORT` 必填；`HANA_SCHEMA_ALLOW → HANA_READ_SCHEMA`；`MCP_TOOL_* → HANA_TOOL_*`。
- 代码自审查修复。

## 1.2.0 - 2026-10-10

- 架构升级：能力清单单一事实源、六个分类门面 + 动态提升、调用期统一闸门。
- 框架与代码风格统一、环境变量调整。

## 1.1.1 - 2026-09-24

- 补充 admin 模块工具。

## 1.1.0 - 2026-09-21

- `analyze=true` 接入 PlanViz：六栏 + 逐算子实测，通道不可用时自动降级。

## 1.0.2 - 2026-09-18（未打 tag）

- 新增 `hana_sql_analyze`（执行计划分析）。
- Calculation View script mode：声明式 SQL 视图、错误明细、基表勘察。
- 修复：引号标识符内点号误判、plan_id 读取范围与失败清理线索。

## 1.0.1 - 2026-09-15

- 新增 Streamable HTTP 传输（与 stdio 并存）；权限策略层（能力级 + 资源级）与写操作预规划闸门。
- HTTP 多客户端加固（写串行化、ETag 读时取、Token 归因）；节点预览中间视图确定性命名/复用/释放。
- 修复 npx github 安装；新增英文 README。

## 1.0.0 - 2026-09-09

- 初始版本：HANA 经典 Modeler MCP 服务（元数据读取、数据预览、建模写操作、仓库传输、稳定性诊断）。
