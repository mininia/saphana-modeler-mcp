/**
 * stdio / HTTP 两个冒烟脚本共享的契约常量与助手。
 *
 * 这里只放**同一黑盒契约**在多处使用、且必须保持一致的部分：平台工具面、dummy HANA 配置、
 * envelope 解析、拒绝文案断言。各脚本的黑盒用例主体留在各自文件。
 */

/**
 * 常驻工具面 = 两个平台入口，顺序 = tools/index.ts 的注册顺序。
 * 这是**契约**而非清单镜像，故手写保留：新增/重排/改名平台入口属于契约变更，测试应当报红。
 */
export const TOOL_SEARCH_TOOL = 'hana_tool_search';
export const INVOKE_TOOL = 'hana_invoke';
export const DEFAULT_SURFACE_ORDER = [TOOL_SEARCH_TOOL, INVOKE_TOOL];

/** dummy HANA 配置：两个脚本都不调用触库工具，仅用于让 config 校验通过（HANA_PORT 必填） */
export const DUMMY_HANA_ENV = {
  HANA_HOST: 'dummy.local',
  HANA_PORT: '30015',
  HANA_USER: 'dummy',
  HANA_PASSWORD: 'dummy',
  HANA_LOCALE: 'zh_CN',
  HANA_TLS: 'false',
  HANA_TIMEZONE: 'Asia/Shanghai',
};

/**
 * 解析工具回执文本为 envelope（JSON，可能带 BOM）；不是 JSON 时返回 null。
 *
 * null 是**有意义的返回值**：路由拒绝、边界拦截等回执是纯文本文案而非 envelope。
 * 对"必须是 envelope"的回执不要用可选链/`?? []` 吞掉 null——那会把断言变成空真
 * （回执坏了也判通过），应当改用 requireEnvelope。
 */
export function parseEnvelope(text) {
  try {
    return JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * 解析**必须**是 envelope 的回执（discover/contract/goal 等）：解析失败直接抛错并带上场景名。
 * 与 parseEnvelope 的分工是显式的——披露回执坏掉要当场失败，而不是让调用方拿到 null 后空转断言。
 */
export function requireEnvelope(text, what) {
  const envelope = parseEnvelope(text);
  if (envelope === null) {
    throw new Error(`${what}：回执不是可解析的 envelope——${String(text ?? '').slice(0, 200)}`);
  }
  return envelope;
}

/**
 * 路由护栏断言：多路探测（未知能力 / 跨类 / 路由到门面 / 档案外）的拒绝文案必须**逐字相同**，
 * 且含「未知能力」。文案不一致 = 护栏在某个入口漏判或多判，且不得借机泄露目标是否存在。
 */
export function assertSameUnknownRefusal(texts) {
  const first = texts[0];
  if (texts.some((t) => t !== first)) {
    throw new Error(`拒绝文案必须逐字相同：\n${texts.join('\n---\n')}`);
  }
  if (!first.includes('未知能力')) {
    throw new Error(`拒绝文案应说"未知能力"，实际：${first.slice(0, 200)}`);
  }
}
