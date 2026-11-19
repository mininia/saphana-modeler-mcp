/**
 * 预设技术配方（Recipe）——**ai_managed**：服务端只给建议路径与契约，不替 AI 执行整条工作流。
 *
 * 与 Changeset/Task 的边界：配方不提供事务、补偿或原子性；多步变更仍按 Changeset 语义处理。
 *
 * 本模块只依赖能力清单与叶子模块（无 I/O、无 config），负责：
 * - 配方声明；
 * - `${bindings.x}` 替换（`${steps.<id>.<field>}` 保留给 AI 从前序结果代入）；
 * - `provides` 的受限路径语法与边界码（`binding_source_missing` / `binding_value_empty` /
 *   `binding_ambiguous`）；
 * - 启动/测试期结构校验（能力存在、参数键合法、引用有来源）。
 */

import { findCapability } from './manifest.js';
import type { Capability } from './types.js';

/** 配方名（有限枚举；不做 NLU） */
export const RECIPE_GOALS = [
  'diagnose_preview_permission',
  'read_view_definition',
  'modify_view',
  'health_check',
  'lineage',
] as const;
export type RecipeGoal = (typeof RECIPE_GOALS)[number];

export interface RecipeStep {
  id: string;
  /** 工具级或操作级别名 */
  capability: string;
  /** `${bindings.x}` 在披露时替换；`${steps.<id>.<field>}` 留给 AI */
  args?: Record<string, unknown>;
  /** 只声明被后续步骤引用的字段（不恢复完整输出 schema） */
  provides?: Record<string, { from: string; select: string }>;
  /** AI 自行补的参数键（如 update.operations、fieldId） */
  fill?: string[];
  optional?: boolean;
  /** 给 AI 的使用说明（不参与执行） */
  note?: string;
}

export interface Recipe {
  goal: RecipeGoal;
  title: string;
  description: string;
  requiresBindings: string[];
  steps: RecipeStep[];
}

const P = (name: string): string => `\${bindings.${name}}`;
const S = (step: string, field: string): string => `\${steps.${step}.${field}}`;

export const RECIPES: Record<RecipeGoal, Recipe> = {
  diagnose_preview_permission: {
    goal: 'diagnose_preview_permission',
    title: '诊断视图预览权限（258/2950）',
    description:
      '先读定义，再诊断根对象（derived），最后对上游逐个 direct 诊断。' +
      '根对象与上游都用 hana_data_preview_diagnose；不要用 hana_data_preview 取数验证权限。',
    requiresBindings: ['packageId', 'objectName'],
    steps: [
      {
        id: 'search',
        capability: 'hana_metadata_search_objects',
        args: { pattern: P('objectName'), by: 'name', category: 'model' },
        optional: true,
        note: '仅当不知道包名时使用；已知 packageId 可跳过。',
      },
      {
        id: 'definition',
        capability: 'hana_metadata_get_view',
        args: { packageId: P('packageId'), objectName: P('objectName') },
        note: '取数据源/节点结构；返回的每个上游对象用于下一步逐个诊断。',
      },
      {
        id: 'diagnose_root',
        capability: 'hana_data_preview_diagnose',
        args: { packageId: P('packageId'), objectName: P('objectName'), channel: 'derived' },
      },
      {
        id: 'diagnose_upstream',
        capability: 'hana_data_preview_diagnose',
        args: { channel: 'direct' },
        fill: ['packageId', 'objectName'],
        note: '对 definition 返回的每个上游/数据源对象重复：填入其 packageId/objectName。',
      },
    ],
  },

  read_view_definition: {
    goal: 'read_view_definition',
    title: '读取视图定义',
    description: '读结构化定义或原始 XML；只看字段用 list_fields，权限问题用 diagnose 配方。',
    requiresBindings: ['packageId', 'objectName'],
    steps: [
      {
        id: 'search',
        capability: 'hana_metadata_search_objects',
        args: { pattern: P('objectName'), by: 'name', category: 'model' },
        optional: true,
        note: '仅当不知道包名时使用。',
      },
      {
        id: 'definition',
        capability: 'hana_metadata_get_view',
        args: { packageId: P('packageId'), objectName: P('objectName'), format: 'json' },
        fill: ['format'],
        note: 'format=xml 仅在需要原始设计时 XML（备份/人工编辑回传）时使用。',
      },
    ],
  },

  modify_view: {
    goal: 'modify_view',
    title: '修改视图（建议顺序）',
    description:
      '读定义 → 查依赖 → design 校验 → update（operations 由 AI 填）→ 激活。' +
      '这不是事务：多步变更的预检/补偿/部分失败语义仍由 Changeset/Task 机制负责。',
    requiresBindings: ['packageId', 'objectName'],
    steps: [
      {
        id: 'definition',
        capability: 'hana_metadata_get_view',
        args: { packageId: P('packageId'), objectName: P('objectName') },
      },
      {
        id: 'dependencies',
        capability: 'hana_metadata_where_used',
        args: { packageId: P('packageId'), objectName: P('objectName'), direction: 'both' },
      },
      {
        id: 'validate',
        capability: 'hana_view_validate',
        args: { packageId: P('packageId'), objectName: P('objectName'), target: 'design' },
      },
      {
        id: 'update',
        capability: 'hana_view_update',
        args: { packageId: P('packageId'), objectName: P('objectName') },
        fill: ['operations'],
        note: '按选中的操作级别名填 operations；每次 update 仍过完整 schema 与预检。',
      },
      {
        id: 'activate',
        capability: 'hana_view_activate',
        args: { packageId: P('packageId'), objectName: P('objectName') },
      },
    ],
  },

  health_check: {
    goal: 'health_check',
    title: 'HANA 运维体检',
    description: '健康 → 会话 → 存储 → 趋势；四个诊断步骤相互独立，可只执行需要的部分。',
    requiresBindings: [],
    steps: [
      { id: 'health', capability: 'hana_system_health' },
      { id: 'activity', capability: 'hana_system_activity' },
      { id: 'storage', capability: 'hana_table_storage' },
      { id: 'trend', capability: 'hana_system_trend' },
    ],
  },

  lineage: {
    goal: 'lineage',
    title: '血缘 / 字段逻辑',
    description: '先查上下游依赖，再对第一个上游对象取字段逻辑；provides 声明了从哪里取字段，避免服务端猜。',
    requiresBindings: ['packageId', 'objectName'],
    steps: [
      {
        id: 'usage',
        capability: 'hana_metadata_where_used',
        args: { packageId: P('packageId'), objectName: P('objectName'), direction: 'both' },
        provides: {
          upstreamPackageId: { from: 'usage', select: '$.data.upstream[0].packageId' },
          upstreamObjectName: { from: 'usage', select: '$.data.upstream[0].objectName' },
        },
      },
      {
        id: 'field_logic',
        capability: 'hana_metadata_get_field_logic',
        args: {
          packageId: S('usage', 'upstreamPackageId'),
          objectName: S('usage', 'upstreamObjectName'),
        },
        fill: ['fieldId'],
        note: 'fieldId 由 AI 从上游对象字段清单中选择；没有上游对象时本步骤 skipped。',
      },
    ],
  },
};

/** 判断一个字符串是否是合法配方名 */
export function isRecipeGoal(value: string): value is RecipeGoal {
  return (RECIPE_GOALS as readonly string[]).includes(value);
}

/** 绑定占位：`${bindings.<key>}`（key 允许点分，便于嵌套） */
const BINDING_RE = /\$\{bindings\.([A-Za-z0-9_.-]+)\}/g;
/** 步骤引用：`${steps.<stepId>.<field>}`（field 允许点分/索引，保持字符串形式，由 AI 替换） */
const STEP_REF_RE = /\$\{steps\.([A-Za-z0-9_]+)\.([A-Za-z0-9_.\[\]]+)\}/g;

export interface SubstitutionResult<T> {
  value: T;
  /** 缺失的 bindings 键（只列参数名，不列领域值） */
  missing: string[];
}

/**
 * 替换 `${bindings.x}`。整串占位保留原类型（数字/对象）；嵌在长字符串里按字符串拼接。
 * 缺失的键不替换、原样保留，并记入 `missing`（供 handler 一次性报错）。
 */
export function substituteBindings<T>(value: T, bindings: Record<string, unknown>): SubstitutionResult<T> {
  const missing = new Set<string>();

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const exact = /^\$\{bindings\.([A-Za-z0-9_.-]+)\}$/.exec(v);
      if (exact) {
        const key = exact[1];
        if (Object.hasOwn(bindings, key)) return bindings[key];
        missing.add(key);
        return v;
      }
      return v.replace(BINDING_RE, (whole, key: string) => {
        if (!Object.hasOwn(bindings, key)) {
          missing.add(key);
          return whole;
        }
        const replaced = bindings[key];
        return typeof replaced === 'string' ? replaced : JSON.stringify(replaced);
      });
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v !== null && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v as Record<string, unknown>)) out[k] = walk(child);
      return out;
    }
    return v;
  };

  const replaced = walk(value) as T;
  return { value: replaced, missing: [...missing] };
}

/** 收集一个值里出现的 `${steps.<id>.<field>}` 引用 */
export function collectStepRefs(value: unknown): Array<{ step: string; field: string }> {
  const out: Array<{ step: string; field: string }> = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'string') {
      for (const m of v.matchAll(STEP_REF_RE)) out.push({ step: m[1], field: m[2] });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v !== null && typeof v === 'object') Object.values(v as Record<string, unknown>).forEach(walk);
  };
  walk(value);
  return out;
}

/**
 * 受限路径语法：`$` 后接 `.key` 与 `[n]`（如 `$.data.upstream[0].packageId`）。
 * 不引入完整 JSONPath；非法路径在启动/测试期就报错，而不是等 AI 去猜。
 */
export function isValidSelectPath(select: string): boolean {
  if (select === '$') return true;
  return /^\$(?:\.[A-Za-z0-9_]+|\[\d+\])+$/.test(select);
}

/** 路径解析结果（边界码与 §10.1 对齐） */
export type SelectResult =
  { status: 'ok'; value: unknown } | { status: 'missing' } | { status: 'empty' } | { status: 'ambiguous' };

/**
 * 按受限路径取值（单测/配方校验用；运行期由 AI 从前序结果代入）。
 * - 路径不存在 → missing；
 * - 命中 null/空串/空数组 → empty；
 * - 需要穿过一个多元素数组却没写索引 → ambiguous（不猜）。
 */
export function resolveSelect(root: unknown, select: string): SelectResult {
  if (!isValidSelectPath(select)) return { status: 'missing' };
  const segments: Array<string | number> = [];
  for (const m of select.matchAll(/\.([A-Za-z0-9_]+)|\[(\d+)\]/g)) {
    segments.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  }
  let cur: unknown = root;
  for (let i = 0; i < segments.length; i += 1) {
    const seg = segments[i];
    if (Array.isArray(cur)) {
      if (typeof seg !== 'number') return { status: 'ambiguous' };
      if (seg >= cur.length) return { status: 'missing' };
      cur = cur[seg];
      continue;
    }
    if (cur === null || typeof cur !== 'object') return { status: 'missing' };
    if (typeof seg === 'number') return { status: 'missing' };
    if (!Object.hasOwn(cur as Record<string, unknown>, seg)) return { status: 'missing' };
    cur = (cur as Record<string, unknown>)[seg];
  }
  if (cur === null || cur === undefined) return { status: 'empty' };
  if (typeof cur === 'string' && cur === '') return { status: 'empty' };
  if (Array.isArray(cur) && cur.length === 0) return { status: 'empty' };
  if (Array.isArray(cur) && cur.length > 1) return { status: 'ambiguous' };
  return { status: 'ok', value: cur };
}

/** 某个能力的参数键集合（zod object 的顶层 shape；非 object schema 返回空集） */
export function paramKeysOf(cap: Capability): Set<string> {
  const shape = (cap.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  return new Set(shape ? Object.keys(shape) : []);
}

/** 某个能力的必填参数键（与 paramDetailsOf 同口径：safeParse(undefined) 失败 = 必填） */
export function requiredKeysOf(cap: Capability): Set<string> {
  const shape = (cap.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) return new Set();
  const out = new Set<string>();
  for (const [name, field] of Object.entries(shape)) {
    const parsed = (field as { safeParse?: (v: unknown) => { success: boolean } }).safeParse?.(undefined);
    if (parsed && !parsed.success) out.add(name);
  }
  return out;
}

const hasPlaceholder = (value: unknown): boolean => {
  if (typeof value === 'string') return value.includes('${');
  if (Array.isArray(value)) return value.some(hasPlaceholder);
  if (value !== null && typeof value === 'object')
    return Object.values(value as Record<string, unknown>).some(hasPlaceholder);
  return false;
};

/**
 * 配方结构校验（启动/测试期）。返回空数组 = 合法；否则每条是一处可读问题。
 * 运行时按 entitlement 过滤、按 bindings 替换；这里只保证「配方本身不可能指向不存在的东西」。
 */
export function validateRecipe(recipe: Recipe): string[] {
  const issues: string[] = [];
  if (recipe.goal.trim() === '') issues.push('goal 为空');
  if (recipe.steps.length === 0) issues.push('steps 为空');
  const ids = recipe.steps.map((s) => s.id);
  if (new Set(ids).size !== ids.length) issues.push('step id 重复');
  const seen = new Set<string>();

  recipe.steps.forEach((step) => {
    const where = `step ${step.id}`;
    const cap = findCapability(step.capability);
    if (!cap) {
      issues.push(`${where}: 能力 ${step.capability} 未登记`);
      seen.add(step.id);
      return;
    }
    if (cap.platform === true) issues.push(`${where}: 平台入口 ${step.capability} 不能作为配方步骤`);
    const keys = paramKeysOf(cap);
    for (const key of Object.keys(step.args ?? {})) {
      if (!keys.has(key)) issues.push(`${where}: 参数 ${key} 不在 ${step.capability} 的 schema 里`);
    }
    for (const key of step.fill ?? []) {
      if (!keys.has(key)) issues.push(`${where}: fill 参数 ${key} 不在 ${step.capability} 的 schema 里`);
    }
    if (keys.size > 0) {
      // 参数键必须覆盖必填项：args 里有（含占位）或 fill 里声明由 AI 补
      for (const req of requiredKeysOf(cap)) {
        if (step.args?.[req] === undefined && !(step.fill ?? []).includes(req)) {
          issues.push(`${where}: 缺少必填参数 ${req}（args 或 fill 至少给一个）`);
        }
      }
    }
    for (const ref of collectStepRefs(step.args)) {
      if (!seen.has(ref.step)) issues.push(`${where}: 引用了非前序步骤 ${ref.step}`);
    }
    for (const [provided, mapping] of Object.entries(step.provides ?? {})) {
      if (provided.trim() === '') issues.push(`${where}: provides 键为空`);
      if (!seen.has(mapping.from) && mapping.from !== step.id) {
        issues.push(`${where}: provides.${provided}.from=${mapping.from} 不是前序步骤`);
      }
      if (!isValidSelectPath(mapping.select)) {
        issues.push(`${where}: provides.${provided}.select=${mapping.select} 不是受支持路径`);
      }
    }
    if (cap.preflight && cap.routing?.exampleArgs && !hasPlaceholder(cap.routing.exampleArgs)) {
      const pre = cap.preflight(cap.routing.exampleArgs);
      if (pre) issues.push(`${where}: exampleArgs 未通过 preflight：${pre.issues.join('；')}`);
    }
    seen.add(step.id);
  });

  return issues;
}

/** 全部配方结构校验（启动/测试期调用一次） */
export function validateAllRecipes(): string[] {
  return RECIPE_GOALS.flatMap((goal) => validateRecipe(RECIPES[goal]).map((issue) => `${goal}: ${issue}`));
}
