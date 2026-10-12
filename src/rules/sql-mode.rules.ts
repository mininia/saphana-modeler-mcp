import type { RuleObject } from './index.js';

/**
 * SQL 模式（Scripted Calculation View）的方言规则。
 *
 * 本文件是这些契约的模型可查全文：改动 view-builder / view-edit 的 SQL 模式生成与变换行为、
 * 或 src/capabilities/defs/modeling.ts 里对应工具描述时，必须同步此处，否则规则给模型的口径
 * 与实际行为不符。
 */

export const sqlModeRules: readonly RuleObject[] = [
  {
    id: 'sql_mode',
    title: 'SQL 模式视图：正文包过程体、列类型定输出表类型',
    detail: [
      'SQL 模式（Scripted Calculation View）= hana_view_create 的 mode=sql：单个 SqlScriptView 节点承载整段 SQL。',
      '**凡「按 SQL 建视图」一律用这个**——服务端按本环境方言（SCRIPT_BASED + <definition> + viewAttribute 显式',
      'datatype/length）生成正确 XML，模型**零 XML**；只需给 script 与 scriptColumns。',
      '（mode=projection 是图形化最小形态：单 Projection + 单源表全列透传，用于表直接透传。）',
      '',
      '正文约定：**写普通查询即可**——服务端自动包成 `BEGIN VAR_OUT = <查询>; END` 过程体',
      '（`<definition>` 被原样拼进生成的 create procedure DDL：正文必须是过程体块、输出只能赋给 OUT 形参',
      'VAR_OUT——裸 SELECT 会报 incorrect syntax near "SELECT"，`VAR_OUT = SELECT …` 报 near "="，',
      '`DO BEGIN … END` 报 near "BEGIN"）；也可直接给完整 BEGIN…END 过程体。',
      '',
      '输出列（scriptColumns，输出列清单）：',
      '- datatype 必填——**它决定 HANA 为输出变量 VAR_OUT 生成的表类型**：缺 datatype/length 会生成空表类型、',
      '  激活必失败（无法从 SQL 文本推断，故必填）；顺序即输出顺序；',
      '- 输出列别名与 scriptColumns[].name 一致；',
      '- 至少一个数值列标 isMeasure=true（本环境激活要求 ≥1 度量，否则 40117——见规则 activation_measure）。',
      '',
      'SQL 写法避坑（实测）：',
      '① 表名写**全限定名** SCHEMA."表"，不要依赖默认 schema；',
      '② 脚本里建议用 CAST(... AS <类型>) 把输出列类型钉死，与 scriptColumns 的 dataType/length 保持一致',
      '   （声明类型与脚本实际类型不一致会激活失败）；',
      '③ Oracle 的 CONNECT BY 层级查询改写为 HANA 泛型 HIERARCHY(...) 时：SOURCE 列别名取 NODE_ID/PARENT_ID，',
      '   START WHERE 用**原始列名**，输出列用 **SOURCE 别名**（不是 HIERARCHY_NODE_ID），',
      '   标量子查询取反向边要包 MAX() 防多行。',
      '',
      '改脚本用 hana_view_update 的 op=set_script（同样零 XML）：服务端重建 <definition>、节点的 viewAttributes',
      '（含 datatype/length）与 logicalModel 输出段；非 SQL 模式视图会明确报错。',
      'scriptColumns 在这里是**整体替换**旧输出（脚本一换输出列集合通常也变，逐列增补会留下旧列导致激活失败）。',
    ].join('\n'),
    tools: ['hana_view_create', 'hana_view_update'],
  },
];
