/**
 * 写边界规则叶（纯叶子模块：不 import 本项目任何模块）——「包名/包前缀是否可写」的
 * **唯一判定实现**，供配置加载（config.ts 的 fail-fast 校验）与运行期闸门
 * （config/preflight.ts 的 checkResource）共用，避免"配置说一套、运行时做一套"。
 *
 * 存在理由——写边界是静默降级最容易发生的地方：
 * - HANA_WRITE_PACKAGES 为空在本模块的判定层是 fail-open（isPackageAllowed 放行一切），**但端到端不是**
 *   「所有包可写」：写工具已暴露时，任何声明写包的调用都会被运行期闸门以 boundary_off 硬拦
 *   （config/preflight.ts 的 checkResource）＝ 实际表现为「写不可用」。这个两层口径的差别是本模块
 *   最容易读错的地方——服务层直调放行、端到端被闸门拦住，是刻意的纵深防御，不是规则漂移；
 * - 配置来源常常不是你以为的那一个（客户端 mcp.json 里根本没写这一项；.env 因凭据三件套
 *   齐备被整文件跳过；改了 .env 但实际走的是 mcp.json 的 env）；
 * - 二者叠加的结果是：要么写操作全部被拒、要么边界根本没生效却一路放行，
 *   而这两种都只有跑完整条写链路才会暴露。
 * 所以非法条目**不静默保留**（那会变成永不匹配的前缀）：配置加载时即失败。
 */

/**
 * 单个包名片段的安全字符集（**闸门口径**）：每段只允许大写字母/数字/下划线/连字符。
 * 生产调用点（config.ts 的加载校验、preflight.ts 的 checkResource）先做大写归一化再进来。
 *
 * 与工具入参口径（core/sql.ts 的 PACKAGE_ID_RE，服务层 isSafePackageName 复用同一条）
 * 的关系是**刻意不同**：入参口径允许小写、允许点出现在任意位置（只拒纯点串），
 * 服务层会放行闸门会拒的名字——这是分层纵深防御，两处不承诺等价。
 */
const SEGMENT_RE = /^[A-Z0-9_-]+$/;

/**
 * 包前缀是否合法：非空、点分段且每段非空、每段限于安全字符集。
 * 只 `filter(Boolean)` 去空串会把非法条目保留成一个永不匹配的前缀——结果要么所有写操作被拒、
 * 要么边界形同虚设，所以配置加载时即失败，不静默降级。
 */
export function isValidPackagePrefix(prefix: string): boolean {
  if (prefix.length === 0) return false;
  return prefix.split('.').every((seg) => SEGMENT_RE.test(seg));
}

/** 挑出非法条目（空数组 = 全部合法）；配置加载据此 fail-fast */
export function findInvalidWritePackages(entries: readonly string[]): string[] {
  return entries.filter((e) => !isValidPackagePrefix(e));
}

/**
 * 包是否落在白名单内：等于某前缀，或以「前缀.」开头（含子包）。
 * 判定规则与 repository.service 的 assertWritePackageAllowed 完全一致。
 * 空白名单 = 本判定层不限制（fail-open）。注意这只是**服务层**的纵深防御口径：
 * 端到端不是「所有包可写」——写工具暴露时闸门会先以 boundary_off 拦住声明写包的请求（见文件头）。
 */
export function isPackageAllowed(packageId: string, allowedPrefixes: readonly string[]): boolean {
  if (allowedPrefixes.length === 0) return true;
  const pkg = packageId.toUpperCase();
  return allowedPrefixes.some((p) => pkg === p || pkg.startsWith(`${p}.`));
}

/**
 * 写边界规则码（对外形状契约：脚本与测试按码断言，闸门与审计按码判分支）。
 * 定义只此一处——运行期闸门（preflight.ts）从这里取，改动全形状一致。
 */
export const WRITE_BOUNDARY_CODES = {
  boundaryOff: 'boundary_off',
  targetOutsideBoundary: 'target_outside_boundary',
} as const;
