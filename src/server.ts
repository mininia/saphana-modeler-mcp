import { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools, type ToolContext } from './tools/index.js';

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

建模写操作（hana_view_*）约定：写操作的可写包范围由 mcp.json 的 HANA_WRITE_PACKAGES 配置（**非空=仅配置包及其下级子包可写**，如配置 ZDEMO 则允许 ZDEMO、ZDEMO.SUB，拒绝其他；**留空=未配置边界，此时写工具会被运行期闸门以 boundary_off 直接拒绝**——要写就必须显式配置）；先检查对象不存在（防覆盖），写操作支持两个通道（repo_rest=走 SYS.REPOSITORY_REST 的 Studio 同款通道，推荐；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT 兜底，激活需用户在 Studio 手工完成）。
新建 Calculation View（hana_view_create）两种形态：mode=projection（图形化最小形态：单 Projection + 单源表全列透传）；**mode=sql（SQL 模式，Scripted Calculation View：单 SqlScriptView 承载整段 SQL）——凡"按 SQL 建视图"一律用这个**，服务端按本环境方言生成 XML，模型零 XML，只需给 script + scriptColumns（输出列清单，datatype 必填：**它决定 HANA 为输出变量 VAR_OUT 生成的表类型，缺类型即生成空表类型、激活必失败**）。SQL 写法约定：表名写全限定名 SCHEMA."表"；输出列别名与 scriptColumns[].name 一致；**正文写普通查询即可（服务端自动包成 BEGIN VAR_OUT = 查询; END 过程体，裸 SELECT 不是合法过程体）**；至少一个数值列标 isMeasure=true（激活要求 ≥1 度量）。改 SQL 模式视图的脚本用 hana_view_update 的 op=set_script（同样零 XML）。
写后回执自带校验信号：activationErrors + activationDetail（**激活失败的完整明细含 DDL 全文，无需再调 hana_view_validate 拿全错误**）；probeRows（默认 10）在激活成功后回探测前 N 行，**0 行会附带排查提示**——"激活成功 ≠ 逻辑正确"。
跨表建模前的数据核对（强烈建议先做）：hana_data_preview 的**基表勘察模式**（schema + table [+ columns]）直接对源表采样并逐列画像（去重值样例 / 长度区间 / 含前导零样例 / NULL 数），用于确认 ①数据在哪张表或分区（BW 变更日志表 vs 活动数据表）②关联键补零格式是否一致（15 位零填充 vs 不补零是跨表关联的头号隐性杀手）③号码列语义（编号可能在 /BIC/Z* 客户字段而非 *NUM 标准字段）。统计基于采样行（sampleRows，默认 200），不跑全表 COUNT。

数据预览（hana_data_preview 的视图预览模式）约定：支持范围有限，不支持即直接返回「不支持」，不做其他尝试。默认对已激活视图整体预览（_SYS_BIC 直查），无筛选默认 10 行、有筛选默认 100 行，VIRTUAL 视图用 parameters 传输入参数；仅当用户明确要求看某视图的某个节点时才传 node——走 HANA 原生中间视图机制（CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV，Studio 同款，任意节点类型支持；中间视图名固定为「包/对象/dp/节点」，已存在即复用，查询后仅在本进程无占用且由本服务创建时才 DROP），需要 EXECUTE 权限，缺权限直接返回不支持；只读 XML 推导模式（forceDerive=true，Projection/Join/Aggregation/Union/Rank）需显式启用。权限类失败（缺 EXECUTE/SELECT、_SYS_BIC 对象不可见的 258/259）会自动附带权限诊断报告（envelope.raw.diagnosis），无需额外调用即可定位阻塞点；hana_data_preview_diagnose 可手动前置排查或区分「权限缺失」与「对象未激活」。

SQL 分析（hana_sql_analyze）约定：**默认输出是一段可读的分析结论**（conclusion：一句话结论 + 逐条发现[risk/warn/info，每条带依据与建议] + 统计[引擎/表与规模/扫描次数/连接次数/预计输出行数]，并附 conclusion.text 整段文本），**默认不返回原始执行计划**——要算子明细才传 raw=true（verbose=true 再加算子细节）。结论覆盖：全表扫描与表规模（大表、占位估计值）、是否缺过滤条件、跨执行引擎切换、嵌套循环连接、计划结构异常；planId/analyze 模式另带运行时统计（次数/平均耗时/内存）。三种取数方式（sql 与 planId 二选一）：sql（只编译不执行）；planId（分析计划缓存里已执行过的语句，编号取自 SYS.M_SQL_PLAN_CACHE.PLAN_ID，需 OPTIMIZER ADMIN）；sql + analyze=true（**先实际执行再分析**——EXPLAIN 只有估计值，实测数据只存在于执行之后；执行受硬护栏：只允许 SELECT、30 秒超时、最多取 100 行即关闭结果集、**不返回数据行**；执行后按相同语句文本关联计划缓存条目，故拿到的是重编译（参数感知）计划）。语句内 schema 须落在服务端允许范围内（未限定表名按当前用户默认 schema 判定）；只接受单条 SELECT/WITH：多语句、绑定占位符（? 或 :name）、DML/DDL/过程调用一律拒绝。该工具归 **admin** 组，只启用 read/write 的部署看不到它。

统一返回 envelope：{ success, data?, messages[], raw? }（HTTP 模式下额外带 clientId = 本次调用的客户端身份，见 MCP_HTTP_TOKENS）。硬错误（参数非法/对象不存在）返回 isError 并附恢复提示。`;

/**
 * 创建 MCP Server（协议层）：McpServer（含 instructions）+ 工具注册（v2 config-object 范式）。
 * pool 为懒连接；真实工具经 pool 访问 HANA。
 * 注意：Streamable HTTP 模式下本函数作为按请求工厂被 createMcpHandler 反复调用（无状态服务），
 * 只做纯构建 —— 一次性启动日志（工具过滤摘要等）由入口负责。
 */
export function createServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'saphana-modeler-mcp', version: '1.0.2' },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, ctx);
  return server;
}
