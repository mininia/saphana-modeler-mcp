/**
 * 文本解析与截断的公共实现。
 *
 * 这两件事此前在每个模块里各写一份：逗号分隔列表解析有 7+ 处（含 zod transform 里的内联链），
 * 截断文案有 4 处且格式各不相同。归到这里后，"配置里的逗号列表怎么解析"只有一种答案。
 */

/**
 * 逗号分隔列表 → 去空白 → 去空串。
 * 用于环境变量（HANA_READ_SCHEMA / MCP_HTTP_ALLOWED_HOSTS / HANA_TOOL_DENY 等）的统一解析。
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
  let head = text.slice(0, max);
  // slice 按 UTF-16 码元切：切点落在代理对（emoji 等增补平面字符）中间时，head 末尾是孤立高代理项，
  // UTF-8 编码后渲染成"�"。回退一个码元，宁可少一格也不产出坏字符（各调用点因此自然免疫）。
  const lastUnit = head.charCodeAt(head.length - 1);
  if (lastUnit >= 0xd800 && lastUnit <= 0xdbff) head = head.slice(0, -1);
  return note === 'chars' ? `${head}…（已截断，共 ${text.length} 字符）` : `${head}…`;
}

/**
 * 身份名（MCP_HTTP_TOKENS 的客户端名 / MCP_PROFILES 的档案名）允许的字符集与长度：
 * 字母/数字/下划线/点/连字符，1–32 字符（防怪异名字进日志/审计）。
 * 两个解析器（config.ts 的 parseHttpClients / profiles.ts 的 parseProfiles）共用这一处，
 * 避免字符集与报错口径分叉。
 */
export const IDENTITY_NAME_RE = /^[A-Za-z0-9_.-]{1,32}$/;

/** 身份名非法的统一说明（调用方在前面补上"第 N 项的 X 名非法："前缀） */
export const IDENTITY_NAME_HINT = '仅允许字母/数字/下划线/点/连字符且长度 ≤32';
