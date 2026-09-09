import { McpServer } from '@modelcontextprotocol/server';
import { buildToolFilter, logToolFilterSummary, registerAllTools, type ToolContext } from './tools/index.js';

/**
 * Server 级领域上下文（instructions）：
 * 一次性注入，替代在各工具描述中重复；MCP host 会在会话开始时注入给 LLM。
 */
export const SERVER_INSTRUCTIONS = `saphana-modeler-mcp：SAP HANA 经典 Modeler（HANA 2.0 本地部署，仓库建模）的 MCP 服务器。

背景：设计时对象（信息视图/权限/过程）以 XML 存储于 _SYS_REPO 仓库（Package 组织）；激活后生成运行时列视图到 _SYS_BIC schema；元数据可查 _SYS_BI.BIMC_* 与 SYS.OBJECT_DEPENDENCIES。

对象类型：
- calculationview（Calculation View，图形化节点模型，HANA 2.0 推荐）
- attributeview / analyticview（Attribute/Analytic View，主数据维度/星型模型；HANA 2.0 已标记废弃，仅存量支持）
- analyticprivilege（Analytic Privilege，数据访问权限）
- procedure（SQLScript 过程）、virtualtable、decisiontable

命名与引用约定：
- 包名与对象名区分大小写；引用已激活视图用 "_SYS_BIC"."包/视图名"（包层级用 . 分隔）
- 写操作（hana_view_*）必须先 validate 再 activate；删除/更新会波及依赖方，依赖关系用 hana_metadata_where_used 查询

工具命名：hana_system_*（系统信息）、hana_metadata_*（只读元数据：字段清单/单字段逻辑/血缘/表）、hana_package_*（包）、hana_data_preview（数据预览）、hana_view_*/hana_privilege_*（建模写操作）。

建模写操作（hana_view_*）约定：写操作的可写包范围由 mcp.json 的 HANA_WRITE_PACKAGES 配置（**空=不限制，全部可写；非空=仅配置包及其下级子包**，如配置 ZDEMO 则允许 ZDEMO、ZDEMO.SUB，拒绝其他）；先检查对象不存在（防覆盖），写操作支持两个通道（repo_rest=走 SYS.REPOSITORY_REST 的 Studio 同款通道，推荐；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT 兜底，激活需用户在 Studio 手工完成）。新建 Calculation View 目前为最小形态（单 Projection + 单源表全列透传），写后可用 hana_data_preview 验证、hana_metadata_* 查看字段。

数据预览（hana_data_preview）约定：支持范围有限，不支持即直接返回「不支持」，不做其他尝试。默认对已激活视图整体预览（_SYS_BIC 直查），无筛选默认 10 行、有筛选默认 100 行，VIRTUAL 视图用 parameters 传输入参数；仅当用户明确要求看某视图的某个节点时才传 node——走 HANA 原生中间视图机制（CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV，Studio 同款，任意节点类型支持，查询后自动 DROP），需要 EXECUTE 权限，缺权限直接返回不支持；只读 XML 推导模式（forceDerive=true，Projection/Join/Aggregation/Union/Rank）需显式启用。权限类失败（缺 EXECUTE/SELECT、_SYS_BIC 对象不可见的 258/259）会自动附带权限诊断报告（envelope.raw.diagnosis），无需额外调用即可定位阻塞点；hana_data_preview_diagnose 可手动前置排查或区分「权限缺失」与「对象未激活」。

统一返回 envelope：{ success, data?, messages[], raw? }。硬错误（参数非法/对象不存在）返回 isError 并附恢复提示。`;

/**
 * 创建 MCP Server（协议层）：McpServer（含 instructions）+ 工具注册（v2 config-object 范式）。
 * pool 为懒连接；真实工具经 pool 访问 HANA。
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'saphana-modeler-mcp', version: '1.0.0' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, ctx);
  logToolFilterSummary(ctx.toolFilter);
  return server;
}
