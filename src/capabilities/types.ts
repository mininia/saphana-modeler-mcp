/**
 * 能力清单（Capability Manifest）—— 类型与声明辅助（P10-a）。
 *
 * **为什么需要它**：在 P10 之前，「一个工具是什么」这件事分散在**四处且互不派生**——
 *   1. `src/tools/groups.ts` 的分组（可见性归属）；
 *   2. `src/tools/index.ts` 里选哪个注册器（有没有调用期闸门）；
 *   3. `src/tools/write-plans.ts` 的 PLANNERS（这次调用会读写什么）；
 *   4. 各 `*.tools.ts` 内联的 `annotations`（给客户端的提示）。
 * 单靠"注册期过滤"这套是够用的；但动态调用面（门面索引 / 路由：模型按分类入口拿到索引、
 * 再按能力 id 路由调用）要在**调用期**
 * 按 `(能力, 参数, 资源, 调用方)` 判定，四处分散的事实源撑不住——没有一处能回答"这个能力是什么"。
 * 本清单把四者收敛成**一条声明**，且四者是**正交字段**：`kind`（可见性）/ `gate`（闸门）/
 * `effects`（读写与破坏性）/ `annotations`（客户端提示，不构成授权）谁也不派生谁。
 *
 * **依赖方向（硬约束）**：`capabilities/` **不 import `tools/`**（反向依赖会与 `tools/index.ts` ↔
 * `tools/*.tools.ts` 之间本就存在的环叠加，让 manifest 的求值顺序变得不确定）；各 `tools/*.tools.ts`
 * 反过来 import 本目录。
 *
 * 允许 import 的还有**纯常量/纯规则叶子**：`core/*`、`write-plan`，以及服务侧导出「入参合法值」的常量
 * （如 `services/health.service` 的 `ALL_CHECKS`、`services/sql-analyze.rules` 的上限值）——
 * 这些常量同时被 schema 与服务实现使用，抄第二份就违反 I3（一条规则一份实现）。
 * 代价是 manifest 会连带求值这些服务模块；**底线是不成环**，由
 * `test-verification/check-import-cycles.mjs`（运行时 import 图遍历）实测：涉及 `capabilities/` 的环为 0。
 * `capabilities/` 内**不得调用任何 I/O 或 service 函数**——它是声明层，只在注册与判定时被读取。
 *
 * **未登记 = 不暴露**：清单是唯一事实源，未登记的能力既不注册也不可见（fail-closed）。
 * 此前 `shouldRegisterTool` 对未登记名字按 `read` 兜底（fail-open），已一并纠正。
 */

import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { WritePlan } from '../write-plan.js';

/** 能力的可见性归属（= 原 TOOL_GROUPS 的分组语义；由 MCP_TOOL_GROUPS 过滤） */
export type ToolKind = 'read' | 'write' | 'admin';

/**
 * 能力分类（**AI 能力视角**，2026-10-09 重构；参照 SAP HANA MCP Server 的 six areas）：
 * 分类轴 = "AI 想干什么"，而不是"代码长在哪"——门面、索引、提升都按它分组。
 *
 * **六个域，与门面一一对应**：`FACADE_CATEGORIES` 就是这六个（见下方它的说明）。
 * 曾有第七个 `capability` 域（放"发现/路由/占位"这类元能力），随 P10-f 的两条元入口与占位工具
 * 全部删除而消失——**没有成员的分类是个空概念**，留着只会让"分类 ⊂ 门面"这条对应关系不再成立。
 */
export type CapabilityCategory = 'system' | 'discovery' | 'data' | 'insights' | 'modeling' | 'diagnostics';

/**
 * 分类目录（**单一事实源**）：id + 名称 + 一句话说明。门面工具（`hana_<分类>`）的
 * 标题与描述**从这里生成**（见 facades.ts），所以目录与门面正文不可能漂移。
 */
export const CAPABILITY_CATALOG = [
  { id: 'system', name: '连接与环境', description: '当前连接是谁/连到哪（版本、权限档位、规则库）' },
  { id: 'discovery', name: '浏览与查找', description: '找包/对象/表，读定义与字段结构' },
  { id: 'data', name: '取数预览', description: '看已激活视图/基表的数据（含预览诊断）' },
  { id: 'insights', name: '结构与血缘分析', description: '影响面（谁依赖它）、字段级计算逻辑' },
  // 校验能力清单（hana_view_check_actions）自本次分类调整起归 modeling——它服务于校验流程，
  // 与 hana_view_validate 同类；本域只留"看结构、看血缘"两件事。
  { id: 'modeling', name: '建模与仓库变更', description: '创建/修改/校验/激活/删除设计时对象，导入导出' },
  { id: 'diagnostics', name: '运维与性能', description: '健康/会话/存储/趋势、SQL 分析与仓库变更审计' },
] as const;

/**
 * **有门面的分类**——就是上面六个业务域，与 `CapabilityCategory` 当前**取值完全相同**。
 *
 * 仍然分成两个类型是刻意的：前者是"能力归属哪一类"（声明用），本类型是"哪几类需要常驻入口"
 * （注册/判定用）。二者混成一个会让"新增一个分类"隐式多出一个门面，而门面的入参 schema、
 * kind 推导、可见性规则都得跟着成立——那不该是加一行目录就能带来的后果。
 * （历史上两者确实不同：曾有第七个 `capability` 域，只放占位能力、不做门面。）
 */
export const FACADE_CATEGORIES = [
  'system',
  'discovery',
  'data',
  'insights',
  'modeling',
  'diagnostics',
] as const satisfies readonly CapabilityCategory[];

/** 有门面的分类（字面量联合） */
export type FacadeCategory = (typeof FACADE_CATEGORIES)[number];

/**
 * 资源计划的档位（P10-b 起**由 `effects.plan` 是否存在唯一表达**，不再有独立的 `gate` 字段）。
 *
 * P10-a 期间曾有 `gate: 'preflight' | 'none'`（= 今天"用 registerWriteTool 还是 registerVisibleTool"的选择）。
 * P10-b 把**所有**能力都挂上同一个调用期闸门（`authorizeCall`）后，那个字段描述的"有没有闸门"恒为真，
 * 留下来的唯一区别是**闸门有没有资源维度**——而这正是 `effects.plan` 的有无。两个字段表达同一件事
 * 就是第二个事实源（本仓库最要防的问题），故删除 `gate`，不做"两处必须相等"的测试来兜。
 */

/**
 * 规划器：入参 → WritePlan（纯只读分析，无副作用）。
 * 声明它 = 该能力「会触碰的资源」是可判定的；不声明则落到 `planFallback`（显式标注"未规划"）。
 */
export type CapabilityPlanner = (args: Record<string, unknown>) => WritePlan;

/** 能力的副作用画像（与 annotations 分离：这是**策略**字段，annotations 只是**提示**） */
export interface CapabilityEffects {
  /**
   * 本次调用会读写什么（纯只读分析，无副作用）。
   *
   * 语义（P10-b）：**声明了它 = 这个能力的闸门带资源维度**（写包边界 + 读 schema 白名单照它判定）；
   * 不声明 = 只有能力级（可见性）判定，没有资源维度。所以：
   * - 会**写仓库包**的能力必须声明（`tests/unit/capability-manifest.test.ts` 强制），
   *   否则会退到 `planFallback`（按参数表面兜底，fail-closed 方向）；
   * - 读**用户指定 schema** 的能力应当声明（`planRead`）：这是读范围从"服务层逐点接线"升级为
   *   "调用期统一判定"的落点；
   * - 读**固定系统 schema**（`_SYS_REPO`/`_SYS_BIC`/`SYS.M_*`）的能力不声明——恒可读的面上声明资源
   *   只会制造"已被保护"的假象（D-12：已激活视图自身定义的读取不做约束）。
   */
  plan?: CapabilityPlanner;
  /** 是否可能破坏既有对象/数据（P6 的 migration 闸门据此判定） */
  destructive: boolean;
  /** 同参数重复调用是否等价（客户端重试安全性的依据） */
  idempotent: boolean;
}

/**
 * 清单条目。`inputSchema` 是**声明式 zod schema 的唯一副本**：
 * 工具的注册配置由它生成（见 tools/index.ts 的 capabilityRegistrar），
 * P10-d 的路由参数也由它在服务端校验（客户端拿到的 JSON Schema 只是便利，不是校验层）。
 */
export interface Capability<S extends z.ZodType = z.ZodType> {
  /** 能力 id：工具级 = 工具名原样；操作级 = `<工具>#<op>`（如 hana_view_update#add_join） */
  id: string;
  /** 对模型可见的入口工具名（恒等于 id 前缀）：工具级 = id 本身；操作级 = 父工具名 */
  module: string;
  /** 分类（= 入口模块域；搜索/晋升按它分组） */
  category: CapabilityCategory;
  /** 可见性归属（MCP_TOOL_GROUPS 过滤依据） */
  kind: ToolKind;
  effects: CapabilityEffects;
  /**
   * **门面归属**：声明了它 = 该能力是某分类的常驻入口（`hana_<分类>`），永远在面上、不可被隐藏。
   *
   * 为什么只有这一个暴露位（2026-10-09 定稿）：不再有"tier-1 / tier-2 / 提升"这套分层。
   * **具体能力恒为动态调用**——它们不进 `tools/list`，模型从门面拿到索引后再经门面路由调用。
   * 于是注册面恒等于"6 个门面 ∩ 授权"，没有进程内可变状态、没有跨调用方的提升表。
   * 门面若也被藏掉，模型就没有任何入口（自锁死），故 `alwaysResident` 的语义并入本字段。
   */
  facadeOf?: FacadeCategory;
  /**
   * **只经路由**的能力（操作级条目 `<工具>#<op>`，2026-10-10）：有清单声明、可路由、可授权、
   * 可出现在门面索引里，但**永不注册为工具**（注册名 = module = 父工具名，注册即撞名）。
   * 三个落点必须一致（各有一处显式判定，别只改一处）：
   *   · `registerVisibleTool`/`registerCapabilitiesDynamically`（surface.ts）不把它们搬进 tools/list；
   *   · handler 注册走 `CapabilityRegistrar.routeOnly`（只登记原始 handler 表，不注册工具）；
   *   · 门面描述只列非 routeOnly 成员（索引两者都列）。
   */
  routeOnly?: boolean;
  title: string;
  description: string;
  inputSchema: S;
  /** 客户端提示（protocol hints），**不参与任何授权判定** */
  annotations: ToolAnnotations;
}

/** 声明形态：`module` 可省（缺省 = id 前缀），由 `cap()` 归一 */
export type CapabilitySpec<S extends z.ZodType> = Omit<Capability<S>, 'module'> & {
  module?: string;
};

/**
 * 声明一条能力。泛型保留 `inputSchema` 的**精确类型**——
 * 注册侧据此把 handler 的参数推断成 `z.infer<S>`（与内联 schema 时代完全一致，零类型回归）。
 */
export function cap<S extends z.ZodType>(spec: CapabilitySpec<S>): Capability<S> {
  return { ...spec, module: spec.module ?? spec.id.split('#')[0] };
}

/** 注册用的工具名（操作级能力挂在父工具名下） */
export function registeredNameOf(c: Capability): string {
  return c.module;
}
