/**
 * 写边界预检（纯叶子模块：不 import 本项目任何模块，供 config 校验、启动流程、
 * 实机验证脚本共用一份判定规则，避免"配置说一套、运行时做一套"）。
 *
 * 存在理由——写边界是静默降级最容易发生的地方：
 * - HANA_WRITE_PACKAGES 为空在本模块的判定层是 fail-open（isPackageAllowed 放行一切），**但端到端不是**
 *   「所有包可写」：写工具已暴露时，任何声明写包的调用都会被运行期闸门以 boundary_off 硬拦
 *   （config/preflight.ts 的 checkResource）＝ 实际表现为「写不可用」。这个两层口径的差别是本模块
 *   最容易读错的地方，故在报告文案里一律按端到端事实陈述；
 * - 且服务启动原本不打印生效边界；
 * - 配置来源常常不是你以为的那一个（客户端 mcp.json 里根本没写这一项；.env 因凭据三件套
 *   齐备被整文件跳过；改了 .env 但实际走的是 mcp.json 的 env）；
 * - 二者叠加的结果是：要么写操作全部被拒、要么边界根本没生效却一路放行，
 *   而这两种都只有跑完整条写链路才会暴露。
 *
 * 本模块把「生效写边界」变成执行前就能断言的对象：先校验再执行，不等到最后才发现。
 */

/**
 * 单个包名片段的安全字符集。与 repository.service 的 isSafePackageName 及工具入参
 * schema 的包名字符集保持一致（大写字母/数字/下划线/连字符），避免两处规则漂移。
 */
const SEGMENT_RE = /^[A-Z0-9_-]+$/;

/**
 * 包前缀是否合法：非空、点分段且每段非空、每段限于安全字符集。
 * 非法条目在旧实现里会被静默保留成一个永不匹配的前缀（`.filter(Boolean)` 只去空串），
 * 结果要么所有写操作被拒、要么边界形同虚设，所以改为配置加载时即失败。
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

/** 预检发现的问题；空数组 = 通过 */
export interface WriteBoundaryIssue {
  code: 'boundary_off' | 'target_outside_boundary';
  message: string;
}

/** 生效写边界报告（启动日志与验证脚本共用） */
export interface WriteBoundaryReport {
  /** 生效的可写包前缀（大写；空数组 = 本判定层不限制，端到端见文件头的两层口径说明） */
  writePackages: string[];
  /** false = 白名单为空（端到端表现为「声明写包的调用被闸门拒绝」）；true = 仅白名单及其子包可写 */
  restrictionEnabled: boolean;
  /** 是否有写类工具会被注册给客户端（由工具可见性过滤判定；false 时边界不影响实际可达性） */
  writeToolsExposed: boolean;
  /** 本次执行计划写入的包（可选；用于断言目标包确实落在边界内） */
  targetPackages: string[];
  /** 预检问题（空 = 通过） */
  issues: WriteBoundaryIssue[];
}

/**
 * 生成写边界报告。
 *
 * @param writePackages 生效的可写包前缀（已大写；来自 loadConfig().writePackages）
 * @param writeToolsExposed 是否有写类工具对客户端可见（无写工具时边界无实际影响，不出告警）
 * @param targetPackages 本次执行计划写入的包；传入后会逐包断言是否落在边界内
 */
export function describeWriteBoundary(
  writePackages: readonly string[],
  writeToolsExposed: boolean,
  targetPackages: readonly string[] = [],
): WriteBoundaryReport {
  const issues: WriteBoundaryIssue[] = [];
  const restrictionEnabled = writePackages.length > 0;

  // 边界未启用 + 写工具可达：端到端表现为「写不可用」——任何声明写包的调用都会被运行期闸门
  // 以 boundary_off 拒绝（服务层 isPackageAllowed 的 fail-open 到不了那一步）。
  // 不阻断启动，但必须显式告警：否则"以为配了边界、实际写全被拦"只能靠调用时才发现。
  if (!restrictionEnabled && writeToolsExposed) {
    issues.push({
      code: 'boundary_off',
      message:
        'HANA_WRITE_PACKAGES 为空 = 写边界未启用：写类工具虽已对客户端暴露，但任何声明写包的调用都会被运行期闸门以 boundary_off 拒绝（端到端等于写不可用）。' +
        '若本次执行/验证需要写入，请先在当前启动来源中配置可写包前缀（如 ZDEMO）后重启服务。',
    });
  }

  // 目标包越界：跑完整条链路后才会以"写操作被拒"的形式暴露，提前在这里拦下
  for (const target of targetPackages) {
    if (!isPackageAllowed(target, writePackages)) {
      issues.push({
        code: 'target_outside_boundary',
        message:
          `目标包 "${target}" 不在生效的可写包范围内（当前白名单：${writePackages.join(', ')}）。` +
          '继续执行会在首个写操作处被拒绝；请修正配置来源或改用白名单内的包。',
      });
    }
  }

  return {
    writePackages: [...writePackages],
    restrictionEnabled,
    writeToolsExposed,
    targetPackages: [...targetPackages],
    issues,
  };
}

/**
 * 报告 → 人类可读多行文本（启动日志 / 脚本控制台共用）。
 * 只含包名，不含任何连接信息或凭据。
 */
export function formatWriteBoundaryReport(report: WriteBoundaryReport): string {
  const lines: string[] = [];
  lines.push(
    report.restrictionEnabled
      ? `写操作包边界：已启用，仅白名单及其子包可写 → ${report.writePackages.join(', ')}`
      : '写操作包边界：未启用（HANA_WRITE_PACKAGES 为空）：声明写包的写调用会被闸门以 boundary_off 拒绝，端到端等于写不可用',
  );
  if (!report.writeToolsExposed) {
    lines.push('  注：当前工具可见性配置下没有写类工具注册，该边界不影响实际可达性');
  }
  if (report.targetPackages.length > 0) {
    lines.push(`  本次目标包：${report.targetPackages.join(', ')}`);
  }
  for (const issue of report.issues) {
    lines.push(`  [${issue.code}] ${issue.message}`);
  }
  return lines.join('\n');
}
