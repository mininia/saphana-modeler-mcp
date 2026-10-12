/**
 * 数值归一、舍入与单位换算的**单一实现**。
 *
 * 存在理由：num/round 曾在 activity/health/storage/trend 四个服务里各写一份（逐字节相同），
 * 字节常量也散在三处。诊断类输出大量依赖「空值当 0」与「保留 2 位」的统一口径 ——
 * 分散实现下任何一处改动，都会让同一个指标在不同报告里呈现不同数值。
 *
 * ⚠️ 刻意**不**合并的同类函数（语义不同，合并会引入静默的 NaN/0 变化）：
 * - sql-analyze.service 的 num：返回 `number | undefined`（非数即 undefined，用于"缺失"判定）
 * - planviz.rules 的 numOf：同样区分"没有值"与"值为 0"
 * 两者由各自模块保留；本模块的 num 一律把空值收敛为 0。
 */

/**
 * 空值安全转数：null/undefined → 0；不可转与非有限值（如 'abc'、NaN、±Infinity）同样归 0
 * （HANA 聚合列常返回 null；非有限值若漏进报告会经 JSON 序列化成 null，"缺值"与"值非法"不可区分）。
 */
export function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/** 保留 d 位小数（默认 2 位，避免 evidence 里出现 18 位浮点尾巴） */
export function round(v: number, d = 2): number {
  return Number(v.toFixed(d));
}

/**
 * 取值收敛到 [lo, hi]：v 为空/未定义时取默认 d。
 * 参数顺序 (v, d, lo, hi) 与调用点原手写式 `Math.min(Math.max(v ?? d, lo), hi)` 逐字对应，
 * 替换后行为完全一致（含「传 NaN 得 NaN」这一原样语义）——这里只消除重复，不修语义。
 */
export function clampLimit(v: number | null | undefined, d: number, lo: number, hi: number): number {
  return Math.min(Math.max(v ?? d, lo), hi);
}

/** 字节单位（二进制口径：HANA 内存/磁盘读数按 1024 进制） */
export const KIB = 1024;
export const MIB = 1024 * 1024;
export const GIB = 1024 ** 3;

/** 串行时间换算：1 秒 = 1e6 微秒（HANA 统计视图的耗时列单位为微秒） */
export const US_PER_SECOND = 1e6;

/**
 * 微秒 → 耗时文本（**毫秒制**，如 `0.99 ms` / `7952 ms`；undefined → `-`）。
 *
 * 口径说明（照搬 sql-analyze 面板与结论的既有实现，刻意不做单位自适应）：
 * - 恒用毫秒：不切到秒 —— 执行计划的时间读法以毫秒为惯例，混用两种单位反而要读者换算
 * - < 10 000 µs（即 < 10 ms）保留 2 位小数（`0.99 ms` 有意义），否则取整（`7952 ms` 不带小数尾巴）
 * - undefined → `-`：计划里的时长字段可选，"没有值"与"值为 0"必须能区分
 *
 * 这三条都是**已实机验证过的输出形态**（六栏逐算子实测），不要改成"更好看"的自适应单位。
 * 导出给 service 层复用：面板与结论里的耗时必须由同一个函数产出，
 * 否则会出现"结论说 1.2 秒、面板说 1234 毫秒"的观感矛盾。
 */
export function formatMicros(us: number | undefined): string {
  return us === undefined ? '-' : `${(us / 1000).toFixed(us < 10_000 ? 2 : 0)} ms`;
}
