/**
 * stdio / HTTP 两个冒烟脚本共享的契约常量与助手。
 *
 * 这里只放**同一黑盒契约**在多处使用、且必须保持一致的部分：门面注册顺序、dummy HANA 配置、
 * 门面回执（envelope）解析、路由护栏的拒绝文案断言。各脚本的黑盒用例主体留在各自文件
 * （它们覆盖的传输层与守卫链不同：stdio 走 JSON-RPC 进程管道，HTTP 走守卫链与调用方档案）。
 */

/**
 * 注册面 = 六个分类门面，顺序 = src/capabilities/facades.ts 的 FACADE_CATEGORIES。
 * 这是**契约**而非清单镜像，故手写保留：新增/重排/改名门面属于契约变更，测试应当报红。
 * 具体能力与门面成员表则必须从被测构建 dist 派生，不得手抄（见 smoke-stdio 的镜像表）。
 */
export const FACADE_ORDER = [
  'hana_system',
  'hana_discovery',
  'hana_data',
  'hana_insights',
  'hana_modeling',
  'hana_diagnostics',
];

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
 * 解析门面回执文本为 envelope（JSON，可能带 BOM）；不是 JSON 时返回 null。
 *
 * null 是**有意义的返回值**：路由拒绝、边界拦截等回执是纯文本文案而非 envelope，经门面回执
 * 原样带回（HTTP 冒烟的 callFacade 对两类回执共用同一解析）。对"必须是 envelope"的回执
 * （门面索引）不要用可选链/`?? []` 吞掉 null——那会把断言变成空真（回执坏了也判通过），
 * 应当改用 requireEnvelope。
 */
export function parseEnvelope(text) {
  try {
    return JSON.parse(String(text ?? '').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

/**
 * 解析**必须**是 envelope 的回执（门面索引等）：解析失败直接抛错并带上场景名。
 * 与 parseEnvelope 的分工是显式的——索引回执坏掉要当场失败，而不是让调用方拿到 null 后空转断言。
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
