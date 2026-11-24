/**
 * 未知/无权能力的**同一句**回执（三者必须逐字相同）：hana_invoke 的目标解析、契约集合、发现。
 *
 * 放在叶子模块，避免任一工具模块反向 import 另一个造成注册环。
 */
export const UNKNOWN_CAPABILITY_TEXT =
  '未知能力：该能力不存在，或未对当前调用方开放。先 hana_tool_search({mode:"discover"}) 找可用能力，再 contract 取契约与 token，最后用 hana_invoke 执行。';
