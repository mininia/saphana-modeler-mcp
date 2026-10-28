import type { RuleObject } from './index.js';

/**
 * 结果契约规则（P0-1 / P0-2）：截断与空集的读法。
 *
 * 为什么进规则库：这是模型**每次读回执**都要用的口径，但它不是某个工具的参数语义；
 * 放进每条工具描述会重复 30 次，放进 instructions 会挤占常驻预算。按需查询最合适。
 */
export const resultRules: readonly RuleObject[] = [
  {
    id: 'result_contract',
    title: '回执结果契约：resultInfo 截断 / empty 空集',
    detail: [
      'envelope.resultInfo 是**统一截断契约**（只在有 limit/cap 语义时出现）：',
      '- returnedCount=本次实际返回条数；totalAvailable=可用总数（知道时才给）；',
      '- truncated=true 表示还有条目没返回；truncationReason 区分 requested-limit（调用方 limit）/',
      '  server-cap（服务端默认上限、候选/节点/扫描上限）/ safety-cap（固定安全上限）。',
      '- 没有该字段 = 本次结果不存在"被截断"这回事（不要自己从数组长度推断）。',
      '',
      'envelope.empty=true 表示**合法空集**：success 仍为 true，messages 里有 EMPTY_RESULT 说明。',
      '空集不是错误；权限不可见/上游失败仍是 success=false。合法空集不会被标成 truncated。',
      '例外：**扫描空间被截断**时可能出现 returnedCount=0 + truncated=true（reason=server-cap/safety-cap）——',
      '  这表示"扫过的部分没命中、但没扫完"（如按字段搜索的候选上限），不是 empty；不要把 0 条一律读成"确定没有"。',
      '',
      '兼容：data.truncated / data.count / data.limit 仍保留（一个版本），但新读法以 envelope.resultInfo 为准。',
      '典型误读：把"恰好 N 条"当成截断——有 totalAvailable 时以它为准（totalAvailable==returnedCount 即完整）。',
    ].join('\n'),
    tools: [],
  },
];
