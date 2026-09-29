/**
 * 文本解析与截断的公共实现。
 *
 * 这两件事此前在每个模块里各写一份：逗号分隔列表解析有 7+ 处（含 zod transform 里的内联链），
 * 截断文案有 4 处且格式各不相同。归到这里后，"配置里的逗号列表怎么解析"只有一种答案。
 */

/**
 * 逗号分隔列表 → 去空白 → 去空串。
 * 用于环境变量（HANA_SCHEMA_ALLOW / MCP_HTTP_ALLOWED_HOSTS / HANA_TOOL_DENY 等）的统一解析。
 */
export function splitList(raw: unknown): string[] {
  if (raw == null) return [];
  return String(raw)
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
}

/** 截断说明的风格：`chars` 附总长（用于语句/列值），`none` 只加省略号（用于标识符） */
export type TruncateNote = 'chars' | 'none';

/**
 * 超长文本截断，并**明确告知被截断**（避免把截断后的内容当成完整内容读）。
 * 阈值由调用方决定：面向语句、列值、标识符三类场景的合理长度本就不同，
 * 统一阈值反而是错的 —— 这里只统一"怎么截、怎么说明"。
 */
export function truncateWithNote(text: string | null | undefined, max: number, note: TruncateNote = 'chars'): string {
  if (text == null) return '';
  if (text.length <= max) return text;
  const head = text.slice(0, max);
  return note === 'chars' ? `${head}…（已截断，共 ${text.length} 字符）` : `${head}…`;
}
