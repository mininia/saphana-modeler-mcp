/**
 * 能力清单（Capability Manifest）—— 类型与声明辅助。
 *
 * **为什么需要它**：一个能力「是什么」由这里的一条声明回答——`kind`（可见性）/
 * `effects`（读写与破坏性；资源维度由 `plan` 的有无表达）/ `annotations`（客户端提示，不构成授权），
 * 各字段互不派生。清单是唯一事实源：注册、发现、契约披露与调用期判定都从这里读。
 *
 * **依赖方向（硬约束）**：`capabilities/` **不 import `tools/`**（反向依赖会与 `tools/index.ts` ↔
 * `tools/*.tools.ts` 之间本就存在的环叠加，让 manifest 的求值顺序变得不确定）；各 `tools/*.tools.ts`
 * 反过来 import 本目录。
 *
 * 允许 import 的还有**纯常量/纯规则叶子**：`core/*`、`write-plan`，以及服务侧导出「入参合法值」的常量
 * （如 `services/health.service` 的 `ALL_CHECKS`、`services/sql-analyze.rules` 的上限值）——
 * 这些常量同时被 schema 与服务实现使用，抄第二份就会漂移。
 * 代价是 manifest 会连带求值这些服务模块；**底线是不成环**，由
 * `tests/unit/import-cycles.test.ts`（运行时 import 图遍历 + 棘轮）常态化保证：涉及 `capabilities/` 的环为 0。
 * `capabilities/` 内**不得调用任何 I/O 或 service 函数**——它是声明层，只在注册与判定时被读取。
 *
 * **未登记 = 不暴露**：清单是唯一事实源，未登记的能力既不注册也不可见（fail-closed）。
 */

import type { ToolAnnotations } from '@modelcontextprotocol/server';
import type { z } from 'zod';
import type { WritePlan } from '../write-plan.js';

/** 能力的可见性归属（= 原 TOOL_GROUPS 的分组语义；由 HANA_TOOL_GROUPS 过滤） */
export type ToolKind = 'read' | 'write' | 'admin' | 'sql';

/**
 * HANA 侧副作用口径（环境只读闸门 / expectedEnvironment / 审计终态的唯一事实源）。
 * 只描述 HANA 侧：本地文件写入与进程内控制面算 none。
 * - none：纯读；
 * - transient：只建可回收临时对象（_SYS_BIC 中间视图、_CHKTMP）；
 * - persistent：改仓库设计时对象或数据。
 * 静态声明取最重路径，不从 kind / destructive / annotations 推导。
 */
export type MutationScope = 'none' | 'transient' | 'persistent';

/**
 * 能力路由卡（呈现元数据，**不参与授权判定**）。
 *
 * 目的不是关键词检索，而是让模型在发现/契约里**选得对**：
 * - `intent` 回答“这是什么问题的工具”，发现卡的摘要优先取它；
 * - `whenToUse` / `notFor` 做正负例消歧（尤其是权限、预览、SQL 分析这几组近邻能力）；
 * - `priority` 决定摘要分组与发现排序信号；
 * - `requires` 写前置条件（如只读环境不可用）；
 * - `exampleArgs` 给一条 canonical 参数示例，避免模型猜参数名；
 * - `constraints` 写跨字段约束（如“视图预览需 packageId+objectName”）。
 *
 * 全部字段可选：未声明的能力仍按描述首句/声明顺序呈现。
 */
export interface CapabilityRouting {
  intent?: string;
  whenToUse?: readonly string[];
  notFor?: readonly string[];
  priority?: 'primary' | 'fallback' | 'advanced' | 'admin';
  requires?: string;
  exampleArgs?: Readonly<Record<string, unknown>>;
  constraints?: readonly string[];
  /**
   * 结果使用说明（契约披露用）：主要结构 / 分页 / 条数上限 / 完整-摘要-引用 / 失败与部分成功。
   * **不复制完整输出 schema**——那是第二事实源；这里只给模型「拿到结果后怎么用」。
   */
  returns?: readonly string[];
}

/** 路由预检结果：issues 非空 = 无效调用；hint 是恢复指引（可选）。 */
export interface CapabilityPreflightResult {
  issues: string[];
  hint?: string;
}

/**
 * 路由预检：schema 通过后、**派发之前**的纯跨字段校验。
 *
 * 为什么需要它：zod 只表达单字段类型/枚举，表达不了「by=name 需要 pattern」「勘察与视图目标二选一」
 * 这类跨字段规则；在这里统一拦下，错误回执才能带可恢复提示。
 *
 * 约束：纯函数、无 I/O；返回 issues 即无效调用，由入口返回参数卡。handler 仍保留自己的
 * 校验作为防御纵深（防绕过入口直接调用）。
 */
export type CapabilityPreflight = (args: unknown) => CapabilityPreflightResult | undefined;

/**
 * 能力分类（**AI 能力视角**）：分类轴 = "AI 想干什么"，用于发现过滤与分类描述。
 *
 * 工具面只有两个平台入口（`hana_tool_search` 选择、`hana_invoke` 执行），具体能力一律经本体层
 * 选择后执行。分类只回答“它属于哪类问题”，不创建任何可绕过本体层的入口。
 *
 * `sql` 是独立分类（直接执行 SQL，默认关闭）；`tool_search` 承载平台入口。
 */
export type CapabilityCategory =
  'system' | 'discovery' | 'data' | 'insights' | 'modeling' | 'diagnostics' | 'sql' | 'tool_search';

/** 全部能力分类（zod 枚举 / 发现过滤 / 测试遍历用；业务域在前、独立分类在后） */
export const ALL_CAPABILITY_CATEGORIES = [
  'system',
  'discovery',
  'data',
  'insights',
  'modeling',
  'diagnostics',
  'sql',
  'tool_search',
] as const satisfies readonly CapabilityCategory[];

/** 全部可见性归属（zod 枚举 / 发现过滤用） */
export const TOOL_KINDS = ['read', 'write', 'admin', 'sql'] as const satisfies readonly ToolKind[];

/**
 * 常驻工具面：只有两个平台入口。
 * - `hana_tool_search`：本体层（发现 / 契约 / 配方），不改工具面、不执行；
 * - `hana_invoke`：唯一执行入口，按目标能力统一授权后派发。
 *
 * 具体能力（含 `hana_sql_execute`、环境切换、操作级别名）一律不注册为工具。
 */
export const PLATFORM_TOOL_IDS = ['hana_tool_search', 'hana_invoke'] as const;
export type PlatformToolId = (typeof PLATFORM_TOOL_IDS)[number];

/** 是否平台入口（常驻面 / 不可作为 invoke 目标 / 不参与 profile 与分组判定） */
export function isPlatformToolId(id: string): id is PlatformToolId {
  return (PLATFORM_TOOL_IDS as readonly string[]).includes(id);
}

/**
 * 分类目录（**单一事实源**）：id + 名称 + 一句话说明。发现回执与分类说明从这里派生，
 * 目录与业务分类不会漂移。`tool_search` / `sql` 不进目录。
 */
export const CAPABILITY_CATALOG = [
  {
    id: 'system',
    name: '连接与环境',
    description: '当前连接是谁/连到哪（版本、权限档位、规则库）',
  },
  {
    id: 'discovery',
    name: '浏览与查找',
    description: '找包/对象/表，读定义与字段结构',
  },
  {
    id: 'data',
    name: '取数预览',
    description: '看已激活视图/基表的数据（含预览诊断）',
  },
  {
    id: 'insights',
    name: '结构与血缘分析',
    description: '影响面（谁依赖它）、字段级计算逻辑',
  },
  // 校验能力清单（hana_view_check_actions）归 modeling——它服务于校验流程，
  // 与 hana_view_validate 同类；本域只留"看结构、看血缘"两件事。
  {
    id: 'modeling',
    name: '建模与仓库变更',
    description: '创建/修改/校验/激活/删除设计时对象，导入导出',
  },
  {
    id: 'diagnostics',
    name: '运维与性能',
    description: '健康/会话/存储/趋势与仓库审计（SQL 分析为高级/低频）',
  },
] as const;

/**
 * **业务域分类**——六个业务域。发现过滤可以按它分组，但**不创建常驻入口**：
 * 所有具体能力都经 `hana_tool_search` 选择、`hana_invoke` 执行。
 */
export const BUSINESS_CATEGORIES = [
  'system',
  'discovery',
  'data',
  'insights',
  'modeling',
  'diagnostics',
] as const satisfies readonly CapabilityCategory[];

/** 业务域分类（字面量联合） */
export type BusinessCategory = (typeof BUSINESS_CATEGORIES)[number];

/**
 * 资源计划的档位**由 `effects.plan` 是否存在唯一表达**：所有能力都过同一个调用期闸门
 * （`authorizeCall`），闸门与闸门之间唯一的区别是**有没有资源维度**——那正是 `effects.plan`
 * 的有无。不为它再立一个字段：两个字段表达同一件事就是第二个事实源（本仓库最要防的问题），
 * 也不靠"两处必须相等"的测试来兜。
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
   * 语义：**声明了它 = 这个能力的闸门带资源维度**（写包边界 + 读 schema 白名单照它判定）；
   * 不声明 = 只有能力级（可见性）判定，没有资源维度。所以：
   * - 会**写仓库包**的能力必须声明（`tests/unit/capability-manifest.test.ts` 强制），
   *   否则会退到 `planFallback`（按参数表面兜底，fail-closed 方向）；
   * - 读**用户指定 schema** 的能力应当声明（`planRead`）：这是读范围统一判定的落点；
   * - 读**固定系统 schema**（`_SYS_REPO`/`_SYS_BIC`/`SYS.M_*`）的能力不声明——恒可读的面上声明资源
   *   只会制造"已被保护"的假象（已激活视图自身定义的读取不做约束）。
   */
  plan?: CapabilityPlanner;
  /** 是否可能破坏既有对象/数据（migration 闸门据此判定） */
  destructive: boolean;
  /** 同参数重复调用是否等价（客户端重试安全性的依据） */
  idempotent: boolean;
  /** HANA 侧副作用口径（见 MutationScope）；必填，防止再按 kind 猜行为 */
  mutates: MutationScope;
}

/**
 * 清单条目。`inputSchema` 是**声明式 zod schema 的唯一副本**：
 * 工具的注册配置由它生成（见 tools/index.ts 的 capabilityRegistrar），
 * 派发时的路由参数也由它在服务端校验（客户端拿到的 JSON Schema 只是便利，不是校验层）。
 */
export interface Capability<S extends z.ZodType = z.ZodType> {
  /** 能力 id：工具级 = 工具名原样；操作级 = `<工具>#<op>`（如 hana_view_update#auto_layout） */
  id: string;
  /** 对模型可见的入口工具名（恒等于 id 前缀）：工具级 = id 本身；操作级 = 父工具名 */
  module: string;
  /** 分类（= 入口模块域；搜索/晋升按它分组） */
  category: CapabilityCategory;
  /** 可见性归属（HANA_TOOL_GROUPS 过滤依据） */
  kind: ToolKind;
  effects: CapabilityEffects;
  /**
   * 人工审批要求（与 `effects.destructive` 解耦）：
   * - `'always'`：每次调用都要确认（如 delete / import）；
   * - 函数：按本次 `args` 判定（如 changeset 里含 delete 动作）；
   * - 省略：不需要审批（如普通 update / SQL 执行）。
   * 仅在部署开启审批（`HANA_APPROVAL_POLICY=destructive`）时生效；`dryRun=true` 仍直接放行。
   */
  approval?: 'always' | ((args: Record<string, unknown>) => boolean);
  /**
   * **平台入口**：常驻 `tools/list` 的极简入口（仅 `hana_tool_search` / `hana_invoke`）。
   *
   * 平台入口不参与分组、档案、资源与环境判定；它们本身不执行任何 HANA 操作：
   * - `hana_tool_search` 只做发现/契约/配方，不改工具面；
   * - `hana_invoke` 只按目标能力做统一授权后派发，目标能力逐次过同一闸门。
   *
   * 可见性由 `config/policy-snapshot.ts` 统一编译：未显式 deny ∧ 至少一个具体能力
   * 在 entitlement 内。平台入口不构成绕过本体层的执行捷径：
   * 它要求调用方先给出能力 id，而能力 id 只能从 `hana_tool_search` 得到。
   */
  platform?: true;
  /**
   * **只经路由**的能力（操作级条目 `<工具>#<op>`）：有清单声明、可路由、可授权，
   * 但**永不注册为工具**（注册名 = module = 父工具名，注册即撞名）。
   * 三个落点必须一致（各有一处显式判定，别只改一处）：
   *   · `computeSurface`（surface.ts）不把它们搬进 tools/list；
   *   · handler 注册走 `CapabilityRegistrar.routeOnly`（只登记原始 handler 表，不注册工具）；
   *   · 发现/契约把它们标为可路由条目（`operation` 给出 op）。
   */
  routeOnly?: boolean;
  /**
   * 控制面能力（如 hana_env_switch）：只经 `hana_invoke` 路由、不注册为工具；
   * 与 routeOnly 的区别是**不参与环境副作用推导**（控制动作本身不碰 HANA 数据）。
   */
  control?: boolean;
  title: string;
  /** 路由卡：发现/契约的选择辅助（可选；不参与授权判定） */
  routing?: CapabilityRouting;
  /** 纯跨字段预检：schema 通过后、派发前执行；返回 issues 即无效调用（不派发）。 */
  preflight?: CapabilityPreflight;
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
 * 注册侧据此把 handler 的参数推断成 `z.infer<S>`（零类型回归）。
 */
export function cap<S extends z.ZodType>(spec: CapabilitySpec<S>): Capability<S> {
  return { ...spec, module: spec.module ?? spec.id.split('#')[0] };
}

/** 注册用的工具名（操作级能力挂在父工具名下） */
export function registeredNameOf(c: Capability): string {
  return c.module;
}
