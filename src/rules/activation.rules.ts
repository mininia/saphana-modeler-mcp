import type { RuleObject } from './index.js';

/**
 * 激活要求（度量）规则。
 *
 * 本文件是这些语义的模型可查全文：改动 view-builder 的度量判定 / measureMode 行为、
 * 或 hana_view_create 工具描述里的对应措辞时必须同步此处。
 */

export const activationRules: readonly RuleObject[] = [
  {
    id: 'activation_measure',
    title: '激活要求 ≥1 度量；measureMode 的两种取值',
    detail: [
      '激活硬要求（实测 SPS08）：视图至少 1 个度量——否则激活被拒，机读码 40117（"No measures defined"）。',
      '',
      'measureMode 两种取值（hana_view_create 的 projection 模式，changeset 的 create 动作里同样按 source.measureMode 组织）：',
      '- SUM_NUMERIC（默认）：数值列进 baseMeasures、聚合 sum；',
      '- ALL_ATTRIBUTES：全部列当属性（无度量）——仅能保存 inactive，激活会被拒绝（40117）。',
      '',
      'SQL 模式的对应写法：至少一个数值列标 isMeasure=true（见规则 sql_mode）。',
      '激活前可用 hana_view_validate(target=design) 做无副作用预检：把内容写到临时副本 _CHKTMP 触发服务端激活检查',
      '（CheckResult 带编译明细）后删除副本，原对象的激活状态不受影响。',
    ].join('\n'),
    errorCodes: ['40117'],
    tools: ['hana_view_create', 'hana_view_update'],
  },
];
