import { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools, type ToolContext } from './tools/index.js';
import { computeSurface } from './tools/surface.js';
import { currentIdentity } from './core/request-context.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * Server 级领域上下文（instructions）：
 * 一次性注入，替代在各工具描述中重复；MCP host 会在会话开始时注入给 LLM。
 *
 * 写法：**一行一个数组元素、join('\n')**（而不是一整块模板串）——超长单行在源码里
 * 无法审阅也无法 diff；按句拆行后仍由 '\n' 连接，正文内容与顺序保持不变。
 *
 * **只留骨架**：这里只留每次会话都必须知道的骨架（服务是什么/对象与引用约定/
 * 工具族/写操作一句话/envelope/规则库指针）。方言、边界、通道、回执、预览与分析的
 * 解释性段落**已逐句搬进规则库**（src/rules/*.rules.ts），需要时经
 * hana_system_get_info(rules=…) 按需查询——砍下的每一句都能在对应规则的 detail 里找到原文。
 * 字数硬指标见本地保留的 tests/unit/instructions-budget.test.ts（该测试不入库）的 BUDGET（口径与数值的单一事实源）。
 */
export const SERVER_INSTRUCTIONS = [
  'saphana-modeler-mcp：SAP HANA 经典 Modeler（HANA 2.0 本地部署，仓库建模）的 MCP 服务。',
  '',
  '对象类型：calculationview / attributeview / analyticview（后两者已废弃，仅存量支持）、analyticprivilege、procedure 等；设计时对象存 _SYS_REPO 仓库（Package 组织），激活后生成 _SYS_BIC 下的运行时列视图。',
  '命名与引用：包名/对象名区分大小写；运行时引用已激活视图写 "_SYS_BIC"."包/视图名"（包层级用 . 分隔）。',
  '',
  '工具是**两层**：常驻的只有六个分类门面（hana_system / hana_discovery / hana_data / hana_insights / hana_modeling / hana_diagnostics），其余能力默认隐藏。',
  '用法：**不带参数**调门面 → 返回本类能力索引（id / 一句话摘要 / 参数名），据此挑具体能力；**带 capability + args** 调门面 → 直接调用该能力。',
  '调门面还会把**该分类的能力提升进工具面**：此后它们是 tools/list 里的一等工具（带完整参数 schema、可按工具名平铺调用）。未用到的分类不会占上下文。',
  '能力族：hana_system_*（系统信息，含规则库）、hana_metadata_* 与 hana_table_*（只读元数据与血缘）、hana_package_* / hana_repo_*（包与传输）、hana_data_preview*（数据预览/基表勘察）、hana_view_*（建模写操作）、hana_system_health / hana_system_activity / hana_system_trend / hana_table_storage（稳定性诊断）、hana_sql_analyze（SQL 分析）。',
  '',
  '写操作（hana_view_*）：先 validate 再 activate；改/删前先用 hana_metadata_where_used 查依赖。',
  '统一返回 envelope：{ success, data?, messages[], raw? }（HTTP 模式下额外带 clientId = 本次调用的客户端身份，见 MCP_HTTP_TOKENS）；硬错误返回 isError 并附恢复提示。',
  '',
  '细则（SQL 方言、写边界与通道、回执与冲突、预览、分析、血缘、稳定性口径等）一律以规则库为准：调用 hana_system_get_info(rules=…)，不传 rules 得规则目录（id+title），传 all 或规则 id（逗号分隔）得全文。',
].join('\n');

/**
 * 创建 MCP Server（协议层）：McpServer（含 instructions）+ 工具注册（v2 config-object 范式）。
 * pool 为懒连接；真实工具经 pool 访问 HANA。
 * 注意：Streamable HTTP 模式下本函数作为按请求工厂被 createMcpHandler 反复调用（无状态服务），
 * 只做纯构建 —— 一次性启动日志（工具过滤摘要等）由入口负责。
 */
export function createServer(ctx: ToolContext): McpServer {
  // 调用方面：**每次构建钉住一份**——HTTP 按请求构建，于是每个身份看到自己的面（门面 ∩ 授权）；
  // stdio 单实例。纯函数，不含跨调用状态。见 tools/surface.ts。
  const server = new McpServer(
    // 版本号取自 package.json（src/version.ts），不在此硬编码：发版时不会漏改而报旧版本
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );
  registerAllTools(server, ctx.surface ? ctx : { ...ctx, surface: computeSurface(ctx, currentIdentity()) });
  return server;
}
