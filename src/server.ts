import { McpServer } from '@modelcontextprotocol/server';
import { registerAllTools, type ToolContext } from './tools/index.js';
import { computeSurface } from './tools/surface.js';
import { currentIdentity } from './core/request-context.js';
import { SERVER_NAME, SERVER_VERSION } from './version.js';

/**
 * Server 级领域上下文（instructions）：一次性注入，替代在各工具描述中重复；
 * MCP host 会在会话开始时注入给 LLM。
 *
 * 写法：**一行一个数组元素、join('\n')**（而不是一整块模板串）——超长单行在源码里
 * 无法审阅也无法 diff；按句拆行后仍由 '\n' 连接，正文内容与顺序保持不变。
 *
 * **只留骨架**（服务是什么/对象与引用约定/工具族/写操作一句话/envelope/规则库指针）：
 * 方言、边界、通道、回执、预览与分析的细则在规则库 src/rules/*.rules.ts，经
 * hana_system_get_info(rules=…) 按需查询。
 */
export const SERVER_INSTRUCTIONS = [
  'saphana-modeler-mcp：SAP HANA 经典 Modeler（HANA 2.0 本地部署，仓库建模）的 MCP 服务。',
  '',
  '对象类型：calculationview / attributeview / analyticview（后两者已废弃，仅存量支持）、analyticprivilege、procedure 等；设计时对象存 _SYS_REPO 仓库（Package 组织），激活后生成 _SYS_BIC 下的运行时列视图。',
  '命名与引用：包名/对象名区分大小写；运行时引用已激活视图写 "_SYS_BIC"."包/视图名"（包层级用 . 分隔）。',
  '',
  '工具面只有两个入口：**hana_tool_search**（选择）与 **hana_invoke**（执行）；具体能力不注册为工具。',
  '选择（必须先做）：不确定用什么 → hana_tool_search({mode:"discover", query/category/...})；已知工具集或参数不确定 → ({mode:"contract", tools:[...]}) 一次拿完整 Schema/required/exampleArgs；固定流程 → ({mode:"goal", goal:"...", bindings:{...}})；bindings 的键是配方参数名（如 packageId/objectName，不是 viewName）。',
  '执行：按回执里的 capability + args 调 hana_invoke({capability, args, contextToken})；操作级别名（如 hana_view_update#auto_layout）同样经它。多环境所有调用必须带 hana_tool_search 的 contextToken（旧 expectedEnvironment:{key,epoch} 兼容）。',
  '**不要凭记忆猜能力 id 或参数**：没有 contract/配方就不要调用 hana_invoke；错误回执会附完整契约。',
  '披露与契约不等于授权：每次 hana_invoke 仍按目标能力重新过授权、schema 与预检；不在你权限内的能力不会出现在候选/契约里。',
  '按问题选路径：权限/预览失败（258/2950）→ goal=diagnose_preview_permission（根对象 derived、上游逐个 direct）；读定义/字段/找对象 → discover "定义/字段/对象"；字段逻辑/血缘 → discover "血缘/字段逻辑"；建模写 → discover/contract 建模能力；健康/会话/存储/趋势 → discover "健康/趋势"；SQL 计划/性能 → hana_sql_analyze（高级，只读环境不可用）；直接执行 SQL → 仅当部署启用 sql 组且用户明确要求。',
  '',
  '写操作（hana_view_*）：先 validate 再 activate；改/删前先用 where_used 查依赖；改已有视图用 hana_view_update(operations)，不要 delete+重建。',
  '统一返回 envelope：{ success, data?, messages[], raw? }（HTTP 模式下额外带 clientId = 本次调用的客户端身份，见 MCP_HTTP_TOKENS）；硬错误返回 isError 并附恢复提示。',
  '',
  '细则（SQL 方言、写边界与通道、回执与冲突、预览、分析、血缘、稳定性口径等）一律以规则库为准：先用 hana_tool_search 找到 hana_system_get_info，再 hana_invoke({capability:"hana_system_get_info", args:{rules:…}})；不传 rules 得规则目录（id+title），传 all 或规则 id（逗号分隔）得全文。',
].join('\n');

/**
 * goal 模式关闭时的补充说明（仅 HANA_TOOL_SEARCH_GOAL=off 注入）。
 */
export const GOAL_DISABLED_INSTRUCTIONS = [
  'goal 模式已按部署配置关闭：hana_tool_search 只用 discover/contract；不要请求 goal，直接按 contract 的 call.via 调 hana_invoke。',
].join('\n');

/**
 * 多环境补充说明（仅多环境部署注入；单环境保持 SERVER_INSTRUCTIONS 逐字不变）。
 * 环境身份以每次回执的 environment 字段为准；切换是显式管理操作，不隐含在业务工具参数里。
 */
export const MULTI_ENV_INSTRUCTIONS = [
  '多环境：每次回执带 environment（执行环境标识）与 calledFromEnvironment；以回执为准，不要假设“上次切到哪”。',
  '查看/切换：先 hana_tool_search({mode:"discover"}) 取 contextToken，再 hana_invoke({capability:"hana_env_list", contextToken})（拿当前环境标识、from、epoch、一次性 switchToken）；切换用 hana_invoke({capability:"hana_env_switch", args:{…}})（confirm 必须等于目标环境标识，大小写不敏感）；切换只影响之后的调用，任务按提交时环境执行。',
  '多环境所有调用必须带 hana_tool_search 的 contextToken（旧 expectedEnvironment/expectedEpoch 兼容）；只读环境（写包为空）只拒绝持久写入能力，临时对象与纯读放行，hana_sql_execute 默认只允许 SELECT 类语句。',
].join('\n');

/**
 * 创建 MCP Server（协议层）：McpServer（含 instructions）+ 工具注册。
 * pool 为懒连接；真实工具经 pool 访问 HANA。
 * 注意：Streamable HTTP 模式下本函数作为按请求工厂被 createMcpHandler 反复调用（无状态服务），
 * 只做纯构建 —— 一次性启动日志（工具过滤摘要等）由入口负责。
 */
export function createServer(ctx: ToolContext): McpServer {
  // 调用方面：**每次构建钉住一份**——HTTP 按请求构建，于是每个身份看到自己的面
  // （授权后的可见能力集）；stdio 单实例。纯函数，不含跨调用状态。见 tools/surface.ts。
  const instructionParts = [SERVER_INSTRUCTIONS];
  if (ctx.config.toolSearchGoalEnabled === false) instructionParts.push(GOAL_DISABLED_INSTRUCTIONS);
  if (ctx.manager?.multiEnv) instructionParts.push(MULTI_ENV_INSTRUCTIONS);
  const instructions = instructionParts.join('\n\n');
  const server = new McpServer(
    // 版本号取自 package.json（src/version.ts），不在此硬编码：发版时不会漏改而报旧版本
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions },
  );
  // 不要把 ctx 展开成字面量：`{ ...ctx }` 会**求值一次** pool/config getter，把多环境的
  // 动态绑定固化成启动时的 base 环境。用原型继承保留 getter，只额外挂本次构建的 surface。
  const effectiveCtx: ToolContext = ctx.surface
    ? ctx
    : (Object.assign(Object.create(ctx) as ToolContext, {
        surface: computeSurface(ctx, currentIdentity()),
      }) as ToolContext);
  registerAllTools(server, effectiveCtx);
  return server;
}
