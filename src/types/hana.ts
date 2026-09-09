/**
 * 通用类型与 Envelope 约定（对齐 bw7.5-modeler-mcp 的 §2.2 风格）：
 * 所有工具 handler 统一返回 { content:[{type:'text'}], structuredContent: envelope }，
 * 其中 envelope = { success, data?, messages[], raw? }。
 * - 业务校验失败（如激活报错明细）：envelope.success=false + messages
 * - 硬错误（参数非法/对象不存在）：MCP isError + 恢复提示（见 core/errors.ts 的 mcpErrorText）
 */

/** HANA 业务消息（对齐 SAP 消息结构，类型映射自 HANA error/warning） */
export interface HanaMessage {
  /** S=成功 I=信息 W=警告 E=错误 */
  type: 'S' | 'I' | 'W' | 'E';
  /** SAP 错误类（如 7=权限不足, 259=表不存在） */
  id?: string;
  number?: string;
  text: string;
}

/** 工具统一返回信封 */
export interface Envelope {
  success: boolean;
  data?: unknown;
  messages: HanaMessage[];
  /** 透传原始返回（如 HANA 原生错误对象），供调试 */
  raw?: unknown;
}
