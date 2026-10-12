import type { ViewKind } from './view-types.js';

/**
 * 设计时视图的后缀映射：视图类型 → `_SYS_REPO.ACTIVE_OBJECT.OBJECT_SUFFIX`。
 *
 * 视图后缀取值集合、按 kind 推导与 `IN` 占位符拼装的唯一实现：catalog.service 直接引用本模块；
 * metadata.service 转出这三个导出（view-cache / preview-diagnose / repository.service 经该处引用）。
 * ViewKind 增删类型时由 `Record<ViewKind, string>` 在编译期强制同步，按 kind 过滤的查询不会漏类型，
 * 也不存在第二份按 kind 过滤的后缀清单。仓库内另有字面同名的手写清单——capabilities/schemas 的
 * VIEW_KIND 枚举、core/xs-rest 的 TEXT_OBJECT_SUFFIXES——各有来源声明与同步义务，不在本单点覆盖内。
 *
 * 当前三项后缀与 ViewKind 同名（全等映射）——「kind 给定，类型名即真实后缀」的推导依赖该性质。
 */
export const VIEW_SUFFIXES: Record<ViewKind, string> = {
  calculationview: 'calculationview',
  attributeview: 'attributeview',
  analyticview: 'analyticview',
};

/** 后缀集合：kind 指定时只取该类型，省略时取全部三种（不指定 kind = 匹配全部视图类型） */
export function suffixesOf(kind?: ViewKind): string[] {
  return kind ? [VIEW_SUFFIXES[kind]] : Object.values(VIEW_SUFFIXES);
}

/** `IN (?,?,…)` 占位符串：长度由 suffixes 决定，值一律走参数绑定 */
export function suffixInClause(suffixes: readonly string[]): string {
  return `(${suffixes.map(() => '?').join(',')})`;
}
