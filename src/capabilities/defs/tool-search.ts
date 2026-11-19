/**
 * `hana_tool_search` 清单条目：**契约披露**入口。
 *
 * 它是两个常驻平台入口之一（另一个是执行入口 `hana_invoke`）；没有分类成员。
 * 三模式（互斥）：
 * - discover：确定性过滤候选（关键词/分类/授权类别/操作类型），只给候选卡；
 * - contract：按 `tools[]` 一次返回完整 ActionContract；
 * - goal：返回预设技术配方（步骤/引用/失败边界）。
 *
 * 它**不执行**目标能力、不连 HANA、不写审计；执行统一走 `hana_invoke`，并逐次过 authorizeCall。
 */

import { z } from 'zod';
import { ALL_CAPABILITY_CATEGORIES, TOOL_KINDS, cap, type Capability } from '../types.js';

/** 披露包的默认/硬上限（预算参数只是护栏） */
export const TOOL_SEARCH_LIMITS = {
  /** 单次 contract 的默认工具数 */
  maxToolsDefault: 12,
  /** 单次 contract 的硬上限（schema 也按它收口） */
  maxToolsHard: 20,
  /** discover 的默认/最大候选数 */
  discoverLimitDefault: 20,
  discoverLimitMax: 50,
  /** 单个工具 Schema 的默认字节上限（32KB） */
  maxSchemaBytesDefault: 32 * 1024,
  /** 完整响应的默认字节上限（256KB） */
  maxResponseBytesDefault: 256 * 1024,
} as const;

/** 三模式 */
export const TOOL_SEARCH_MODES = ['discover', 'contract', 'goal'] as const;
export type ToolSearchMode = (typeof TOOL_SEARCH_MODES)[number];

/** 三模式入参（一处声明；handler/预检/测试都按同一份类型读） */
export interface ToolSearchArgs {
  mode?: ToolSearchMode;
  query?: string;
  category?: (typeof ALL_CAPABILITY_CATEGORIES)[number];
  authorizationClass?: (typeof TOOL_KINDS)[number];
  operationType?: string;
  limit?: number;
  tools?: string[];
  goal?: string;
  bindings?: Record<string, unknown>;
  maxTools?: number;
  maxSchemaBytes?: number;
  maxResponseBytes?: number;
}

/**
 * 省略 mode 时按参数推断：有 tools → contract；有 goal → goal；否则 discover。
 * 显式 mode 与参数冲突由 {@link validateToolSearchArgs} 拒绝，不静默纠正。
 */
export function inferToolSearchMode(args: ToolSearchArgs): ToolSearchMode {
  if (args.mode !== undefined) return args.mode;
  if ((args.tools?.length ?? 0) > 0) return 'contract';
  if (args.goal !== undefined) return 'goal';
  return 'discover';
}

const DISCOVER_ONLY_KEYS = ['query', 'category', 'authorizationClass', 'operationType', 'limit'] as const;

function hasDiscoverFilters(args: ToolSearchArgs): boolean {
  return DISCOVER_ONLY_KEYS.some((k) => args[k] !== undefined);
}

/**
 * 跨字段预检（schema 通过后、派发前）：三模式互斥 + 各模式必填 + `bindings` 只用于
 * contract/goal。返回 issues 即参数卡，不派发。
 */
export function validateToolSearchArgs(args: ToolSearchArgs): { issues: string[]; hint?: string } | undefined {
  const issues: string[] = [];
  const mode = args.mode;
  const filters = hasDiscoverFilters(args);
  const hasTools = (args.tools?.length ?? 0) > 0;
  const hasGoal = args.goal !== undefined;

  if (mode === undefined) {
    if (hasTools && hasGoal) issues.push('tools 与 goal 互斥：一次只能披露工具集或配方。');
    if (hasTools && filters) issues.push('tools 与 discover 过滤参数互斥：contract 模式只用 tools/bindings。');
    if (hasGoal && filters) issues.push('goal 与 discover 过滤参数互斥：goal 模式只用 goal/bindings。');
    if (!hasTools && !hasGoal && args.bindings !== undefined) {
      issues.push('bindings 只用于 contract/goal；discover 模式不接受它。');
    }
  } else if (mode === 'discover') {
    if (hasTools) issues.push('mode=discover 不接受 tools；要披露契约请用 mode=contract。');
    if (hasGoal) issues.push('mode=discover 不接受 goal；要取配方请用 mode=goal。');
    if (args.bindings !== undefined) issues.push('mode=discover 不接受 bindings。');
  } else if (mode === 'contract') {
    if (!hasTools) issues.push('mode=contract 需要 tools[]（至少一个能力 id）。');
    if (hasGoal) issues.push('mode=contract 不接受 goal。');
    if (filters)
      issues.push('mode=contract 不接受 discover 过滤参数（query/category/authorizationClass/operationType/limit）。');
  } else if (mode === 'goal') {
    if (!hasGoal) issues.push('mode=goal 需要 goal（配方名）。');
    if (hasTools) issues.push('mode=goal 不接受 tools。');
    if (filters)
      issues.push('mode=goal 不接受 discover 过滤参数（query/category/authorizationClass/operationType/limit）。');
  }

  if (issues.length === 0) return undefined;
  return {
    issues,
    hint:
      '三模式互斥：discover（query/category/authorizationClass/operationType/limit）→ ' +
      'contract（tools/bindings）→ goal（goal/bindings）。省略 mode 时按 tools/goal 推断。',
  };
}

export const toolSearchCapabilities = {
  hana_tool_search: cap({
    id: 'hana_tool_search',
    category: 'tool_search',
    kind: 'read',
    platform: true,
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '按意图发现候选工具、一次取完整调用契约、或取预设技术配方',
      whenToUse: [
        '不确定该用哪个工具（先用 mode=discover）',
        '已知工具集，想一次拿到完整输入 Schema/约束/路由（mode=contract）',
        '权限/预览失败（258/2950）→ goal=diagnose_preview_permission（根对象 derived + 上游 direct）',
        '按固定流程做事（如改视图、健康体检），取建议步骤（mode=goal）',
      ],
      notFor: ['直接执行目标能力：披露只给契约，执行必须用 hana_invoke({capability,args})'],
      priority: 'primary',
      exampleArgs: { mode: 'discover', query: '权限 诊断 预览', category: 'data' },
      returns: [
        'discover：data.candidates[] 候选卡（不含 inputSchema）',
        'contract：data.tools[] 完整契约 + data.policy',
        'goal：data.steps[] 配方 + data.tools[] 被引用能力的契约',
        '所有模式都不改变 tools/list；执行统一用 hana_invoke({capability,args})',
      ],
    },
    title: '发现工具 / 获取调用契约',
    description:
      '三模式（互斥）：discover 按关键词/分类/授权类别/操作类型确定性找候选；contract 按 tools[] 一次返回完整输入 Schema、必填、约束、结果说明、路由；goal 返回预设技术配方。\n' +
      '披露不改变工具面、不做授权：回执里的 call.via 恒为 hana_invoke，每次调用仍过统一授权与预检。\n' +
      '不知道工具 id 时先 discover；已知工具集直接 contract；固定流程用 goal（权限诊断 goal=diagnose_preview_permission，不要先猜参数）。\n' +
      'goal 的 bindings 键=配方参数名（packageId/objectName，不是 viewName）；不知道 packageId 先 discover/search_objects。\n' +
      '工具面只有两个入口：先用本工具选择，再用 hana_invoke 执行；具体能力不注册为工具。',
    inputSchema: z.object({
      mode: z
        .enum(TOOL_SEARCH_MODES)
        .optional()
        .describe('discover / contract / goal；省略时按 tools/goal 推断，三者互斥'),
      query: z.string().min(1).max(200).optional().describe('discover：关键词（空白分隔；匹配 id/标题/用途/正反例）'),
      category: z.enum(ALL_CAPABILITY_CATEGORIES).optional().describe('discover：按分类过滤'),
      authorizationClass: z.enum(TOOL_KINDS).optional().describe('discover：按授权类别过滤（read/write/admin/sql）'),
      operationType: z
        .string()
        .min(1)
        .max(64)
        .regex(/^[a-z0-9_]+$/)
        .optional()
        .describe('discover：操作级别名过滤（如 add_join；匹配 <工具>#<op>）'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(TOOL_SEARCH_LIMITS.discoverLimitMax)
        .optional()
        .describe(
          `discover：候选上限（默认 ${TOOL_SEARCH_LIMITS.discoverLimitDefault}，最大 ${TOOL_SEARCH_LIMITS.discoverLimitMax}）`,
        ),
      tools: z
        .array(z.string().min(1).max(128))
        .min(1)
        .max(TOOL_SEARCH_LIMITS.maxToolsHard)
        .optional()
        .describe('contract：要披露的能力 id（可含操作级别名 <工具>#<op>）；按声明顺序返回'),
      goal: z.string().min(1).max(64).optional().describe('goal：配方名（见工具描述/错误回执里的可用列表）'),
      bindings: z
        .record(z.string(), z.unknown())
        .optional()
        .describe(
          'contract/goal：占位值（${bindings.x}）；不是 string-only。goal 的键必须是配方参数名：diagnose_preview_permission 用 packageId + objectName（不是 viewName）；不知道 packageId 时先用 discover/search_objects 找到对象。',
        ),
      maxTools: z
        .number()
        .int()
        .min(1)
        .max(TOOL_SEARCH_LIMITS.maxToolsHard)
        .optional()
        .describe(
          `contract：本次工具数上限（默认 ${TOOL_SEARCH_LIMITS.maxToolsDefault}，硬上限 ${TOOL_SEARCH_LIMITS.maxToolsHard}）`,
        ),
      maxSchemaBytes: z
        .number()
        .int()
        .min(1024)
        .max(1024 * 1024)
        .optional()
        .describe(`单个工具 Schema 字节上限（默认 ${TOOL_SEARCH_LIMITS.maxSchemaBytesDefault}）`),
      maxResponseBytes: z
        .number()
        .int()
        .min(4096)
        .max(4 * 1024 * 1024)
        .optional()
        .describe(`完整响应字节上限（默认 ${TOOL_SEARCH_LIMITS.maxResponseBytesDefault}）`),
    }),
    preflight: (args) => validateToolSearchArgs(args as ToolSearchArgs),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
