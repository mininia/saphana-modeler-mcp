/**
 * 规则对象集（P9 · 环境档案与指令经济学，SSD §9）：把原先散在 `SERVER_INSTRUCTIONS`（server.ts）
 * 与各工具 description（capabilities/defs/*.ts）里的**散文知识**搬进可单测、可查询的结构化对象。
 *
 * 为什么要有这一层（三条，改代码前先读）：
 *   1. **省 token**：instructions 与工具描述每次会话都注入，多代理下开销 ×N；规则对象不进常驻文本，
 *      模型按需查（经 hana_system_get_info 的 rules 参数），描述只引用 id——I3：一条规则一份实现，
 *      manifest 的 description 不复写规则内容。
 *   2. **不丢知识**：被瘦身批砍下的每一句话，都必须能在某条规则的 detail 里找到（**原文措辞保留**——
 *      那是实测/踩坑换来的）。瘦身批删除任何一句前，先在这里指出它的落点。
 *   3. **可单测**：id 唯一/冻结、title 有界、tools 必须真实存在于能力清单——见 tests/unit/rules.test.ts，
 *      防止「描述引用到不存在的规则 id」这类静默失效。
 *
 * id 契约：前 9 个是**冻结清单**（FROZEN_RULE_IDS；瘦身批写进 instructions/描述时引用，不要改名）；
 * 其余 id（model_basics 与稳定性诊断族）是同批搬迁的**补充落点**——本次瘦身体的硬指标要求
 * description top5 大幅收缩，其中 hana_table_storage / hana_system_health 的解释性散文没有冻结条目可落，
 * 故按同一规范补条目，避免「砍了没处查」。
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
  // ── 补充落点（非冻结清单；同为稳定 id）────────────────────────────────
  'model_basics',
  'health_check',
  'activity_locks',
  'storage_profile',
  'trend_timeline',
  // ── 2026-10-10 新增（P8 五 op + 异步任务 API）──────────────────────────
  'view_ops',
  'async_task',
] as const;

/** 规则 id 的字面量联合（编译期契约） */
export type RuleId = (typeof RULE_IDS)[number];

/**
 * 冻结的 9 个 id：瘦身批按这些 id 引用（本批规格指定）。类型标注成为编译期护栏——
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
  /** 稳定 id：工具描述与 instructions 用它引用（瘦身批会写进文本，**不要改名**） */
  id: RuleId;
  /** 一句话（≤40 字）：可进 instructions/描述的摘要句 */
  title: string;
  /** 完整散文（就是被砍下来的那部分：方言/边界/踩坑/为什么）；经 hana_system_get_info(rules=…) 可查 */
  detail: string;
  /** 相关机读码（如 40117） */
  errorCodes?: string[];
  /** 适用工具（工具名，便于按工具查规则） */
  tools?: string[];
}

/** 全量规则表（只读；顺序 = RULE_IDS）。瘦身批按 id 引用，不要改名、不要删条目。 */
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
