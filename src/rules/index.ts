/**
 * 规则对象集：散文知识（方言 / 边界 / 踩坑 / 为什么）的结构化落点——可单测、可按需查询。
 *
 * 为什么要有这一层（改代码前先读）：
 *   1. **省 token**：instructions 与工具描述是常驻文本；规则对象不进常驻文本，模型按需查
 *      （经 hana_system_get_info 的 rules 参数）——I3：一条规则一份实现，manifest 的 description
 *      只引用规则 id，不复写规则内容。
 *   2. **不丢知识**：每条 detail 都是实测/踩坑换来的口径；要从常驻文本里删一句话，先在规则里指出
 *      它的落点（原文措辞保留）。
 *   3. **可单测**：id 唯一/冻结、title 有界、tools 必须真实存在于能力清单——见 tests/unit/rules.test.ts，
 *      防止「描述引用到不存在的规则 id」这类静默失效。
 *
 * id 契约（持久约定，勿动）：
 *   - FROZEN_RULE_IDS 里的 9 个 id 已被 instructions / 工具描述以文本引用——**不要改名**；
 *   - 已删条目的 id 不要复用（旧引用会静默指向新语义）；其余 id（补充落点）同为稳定 id；
 *   - 新增规则追加到 RULE_IDS 末尾并补条目（顺序 = 对外列示顺序）。
 *
 * 依赖方向：本模块只依赖 core/errors（未知 id 要以中文硬错误暴露，与工具层错误口径一致），
 * 不被 tools/ 与 capabilities/ 反向依赖；leaf 文件（*.rules.ts）只提供数据、不做 I/O。
 */

import { HanaBusinessError } from '../core/errors.js';
import { sqlModeRules } from './sql-mode.rules.js';
import { activationRules } from './activation.rules.js';
import { writeRules } from './write.rules.js';
import { previewRules } from './preview.rules.js';
import { sqlAnalyzeRules } from './sql-analyze.rules.js';
import { metadataGraphRules } from './metadata-graph.rules.js';
import { bwDialectRules } from './bw-dialect.rules.js';
import { modelBasicsRules } from './model-basics.rules.js';
import { stabilityRules } from './stability.rules.js';
import { viewOpsRules } from './view-ops.rules.js';
import { resultRules } from './result.rules.js';

/**
 * 全部规则 id（顺序 = RULES 的对外列示顺序）。`as const` 的两个作用：
 *   1. 派生 RuleId 字面量联合——id 写错在编译期就报（RuleObject.id 的类型收窄）；
 *   2. 运行时可枚举（hana_system_get_info 的合法值清单从 RULES/RULE_IDS 单一事实源取）。
 */
export const RULE_IDS = [
  'sql_mode',
  'activation_measure',
  'write_boundary',
  'write_transport',
  'write_receipt',
  'preview',
  'sql_analyze',
  'metadata_graph',
  'bw_dialect',
  // ── 补充落点（非冻结；同为稳定 id，勿改名/复用）──────────────────────
  'model_basics',
  'health_check',
  'activity_locks',
  'storage_profile',
  'trend_timeline',
  // ── 视图操作（op 别名）与异步任务 API ────────────────────────────────
  'view_ops',
  'async_task',
  // ── 回执结果契约（P0-1 / P0-2）────────────────────────────────────
  'result_contract',
] as const;

/** 规则 id 的字面量联合（编译期契约） */
export type RuleId = (typeof RULE_IDS)[number];

/**
 * 冻结的 9 个 id：被 instructions / 工具描述以文本引用（改名即断引用）。类型标注是编译期护栏——
 * 从 RULE_IDS 里删掉任一 id，这里立刻编译不过（防「冻结清单悄悄缩水」）。
 * 运行时的「一个不少」断言在 tests/unit/rules.test.ts。
 */
export const FROZEN_RULE_IDS: readonly RuleId[] = [
  'sql_mode',
  'activation_measure',
  'write_boundary',
  'write_transport',
  'write_receipt',
  'preview',
  'sql_analyze',
  'metadata_graph',
  'bw_dialect',
];

/** 规则对象：id 稳定（被文本引用）、title 是一句摘要（可进 instructions）、detail 是完整散文（按需查） */
export interface RuleObject {
  /** 稳定 id：工具描述与 instructions 用它引用（**不要改名**） */
  id: RuleId;
  /** 一句话（≤40 字）：可进 instructions/描述的摘要句 */
  title: string;
  /** 完整散文（方言/边界/踩坑/为什么）；经 hana_system_get_info(rules=…) 可查 */
  detail: string;
  /** 相关机读码（如 40117） */
  errorCodes?: string[];
  /** 适用工具（工具名，便于按工具查规则） */
  tools?: string[];
}

/** 全量规则表（只读；顺序 = RULE_IDS）。id 被常驻文本引用：不要改名、不要删条目。 */
export const RULES: readonly RuleObject[] = [
  ...sqlModeRules,
  ...activationRules,
  ...writeRules,
  ...previewRules,
  ...sqlAnalyzeRules,
  ...metadataGraphRules,
  ...bwDialectRules,
  ...modelBasicsRules,
  ...stabilityRules,
  ...viewOpsRules,
  ...resultRules,
];

/**
 * 按 id 取规则；**不传 = 全部**（调用方拿数组副本，避免外部改动内部数组）。
 *
 * 未知 id **抛错**而不是静默给空：调用方（hana_system_get_info 的 rules 参数）拿到的是
 * 模型拼出来的 id，静默空结果会被读成「这条规则不存在知识」——必须让它当场看到合法值清单，
 * 错误口径与工具层一致（中文硬错误，走 withErrorEnvelope 进 success=false 信封）。
 */
export function getRules(ids?: readonly string[]): RuleObject[] {
  if (ids === undefined) return [...RULES];
  const byId = new Map<string, RuleObject>(RULES.map((rule) => [rule.id, rule]));
  const found: RuleObject[] = [];
  const unknown: string[] = [];
  for (const id of ids) {
    const rule = byId.get(id);
    if (rule === undefined) unknown.push(id);
    else found.push(rule);
  }
  if (unknown.length > 0) {
    // 一次列出全部未知 id（批量查询时不必逐个试），并给出合法值全集
    throw new HanaBusinessError(
      `未知规则 id：${unknown.map((id) => `"${id}"`).join('、')}。合法 id：${RULE_IDS.join(', ')}`,
    );
  }
  return found;
}
