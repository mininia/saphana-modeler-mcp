import type { RuleObject } from './index.js';
import { VIEW_OPS } from '../services/view-ops.rules.js';

/**
 * 视图操作集（operations 通道的 8 个 op）与异步任务规则（2026-10-10）。
 *
 * 来源（搬迁自，保留原文措辞）：
 * - src/capabilities/defs/modeling.ts 的 hana_view_update.description（operations 三方式与参数面一段）；
 * - src/services/view-ops.rules.ts 各 op 的 detail（方言/守卫口径的单一事实源，本规则**引用**它生成，
 *   不复制——op 增删时本规则自动跟随，避免第二份清单漂移）；
 * - src/services/async-task.service.ts 与 core/task-registry.ts 的头注（任务语义与诚实边界）。
 */

/** 由 VIEW_OPS 声明生成 op 目录（每行：`op=id：summary（参数名）`）——单一事实源在 view-ops.rules.ts */
function viewOpsCatalog(): string[] {
  return VIEW_OPS.map((op) => `- op=${op.id}（${op.params.join(' / ')}）：${op.summary}`);
}

export const viewOpsRules: readonly RuleObject[] = [
  {
    id: 'view_ops',
    title: 'operations 的 8 个声明式 op 与各自守卫',
    detail: [
      'hana_view_update 的三方式之一（与 xml / changeset 三选一）：operations = 声明式操作补丁数组',
      '（1~10 条，按序应用；可单发一个 op，便于模型零 XML 完成常见改造）。8 个 op：',
      ...viewOpsCatalog(),
      '',
      '共同口径：',
      '- 变换基线取**设计时文件当前内容**（与 ETag 同会话读取）——存在未激活的挂起改动时以激活版为基线会静默丢失挂起工作；',
      '- 逐条按序应用、每条失败即整体拒绝（此前已应用的变换不落库——变换是纯函数，拼装完才发起一次 PUT）；',
      '- 破坏性判定与闸门是 P6 同一套（结构 diff × 下游引用）：判定表打不到结构面的 op（如 set_description）',
      '  即便有下游也放行；口径类 op（set_attribute_filter / set_variable）按"行集合/参数语义变化"判破坏；',
      '- 每条的 effect 声明在 src/services/view-ops.rules.ts（destructive / 触碰面 / 数据源引用），',
      '  与工具 schema 的一致性由单测机械钉住。',
      '',
      '各 op 的方言与守卫要点（实现细节，报错时按这里的口径给指引）：',
      ...VIEW_OPS.map((op) => `· ${op.id}：${op.detail ?? op.summary}`),
    ].join('\n'),
    tools: ['hana_view_update'],
  },
  {
    id: 'async_task',
    title: '长变更集异步任务（async + 查询/取消）',
    detail: [
      '**动机**：批内每项写入含 2–10s 服务端激活，10 项批次可到分钟级；同步调用可能被 MCP 客户端自身超时掐断，',
      '而服务端无从得知客户端的超时配置。async=true 把批次交给进程内任务跑、立即返回 taskId。',
      '',
      '用法（仅与 changeset 组合；单对象通道传 async 会被拒绝）：',
      '- 提交：hana_view_update({changeset:{actions:[…]}, async:true}) ⇒ {taskId, status:"working", label, hint}；',
      '- 轮询：hana_task_get({taskId}) ⇒ {status, progress, result?}；status ∈ working/completed/failed/cancelled；',
      '  终态 result 就是**与同步调用同形的回执信封**（success=true 时 data=报告；失败时 raw.errorDetail 带逐项明细）；',
      '- 取消：hana_task_cancel({taskId}) ⇒ 协作式——**当前动作不打断**，本动作结束后停止后续项，',
      '  并走与失败相同的**逆序补偿**（已执行项回到批前状态）；报告 raw.code=changeset_cancelled 带完整现场。',
      '',
      '语义与边界（诚实清单）：',
      '- 任务体就是 applyChangeset 本体（同一实现/锁/信号量/补偿）：整体预检仍在任何写入之前，',
      '  "预检不通过 ⇒ 整批拒绝、零写入"的语义不变（预检失败会直接落成 failed 终态）；',
      '- 同时运行上限 4 个（超出提交即拒，未发生任何写）；终态任务保留 30 分钟（惰性清扫）、注册表上限 100 条；',
      '- **进程内状态、服务重启即丢**：重启后 hana_task_get 对旧 taskId 回"未知任务"；多进程部署各自持任务，不共享；',
      '- 归属隔离：任务只对**本调用方**可见（HTTP = 已认证 clientId；stdio = 进程自身）。他人任务与不存在的任务',
      '  回同一句"未知任务"（不泄漏存在性）。**未配 Token 的 HTTP 部署**按单租户假设：所有调用方互相可见，',
      '  与动态面提升表同一裁定；',
      '- 取消到达太晚（批次已执行完）不报错：终态 completed，hana_task_get 的 hint 如实说明"取消未生效"。',
    ].join('\n'),
    tools: ['hana_view_update', 'hana_task_get', 'hana_task_cancel'],
  },
];
