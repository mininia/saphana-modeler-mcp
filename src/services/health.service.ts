/**
 * 稳定性健康检查引擎。
 *
 * 职责边界：引擎只做四件事——探测权限上下文、调度规则、把异常归一成 unknown、归并出整体结论。
 * **判定逻辑全在 health.rules.ts 的规则里**，本文件不含任何"什么算异常"的知识。
 *
 * 三态纪律（本模块存在的理由）：HANA 的 M_* 监视视图在权限不足时**静默返回空集而不报错**，
 * 于是"查不到"与"没问题"在 SQL 层长得一模一样。若引擎按两态（正常/异常）设计，
 * 缺权限的部署会拿到一份"全绿"的假报告——比没有检查更危险。
 * 故这里强制：凡是无法判定的，结论必须是 unknown，且整体 verdict 不得为 ok。
 */

import type { HanaPool } from '../core/hana-client.js';
import { classifyHanaError } from '../core/hana-errors.js';
import { logger } from '../core/logger.js';
import { probeVisibility, type Visibility } from './visibility.service.js';
import {
  adviceByReason,
  ALL_CHECKS,
  DEFAULT_CHECKS,
  DEFAULT_THRESHOLDS,
  HEALTH_RULES,
  LEVEL_ORDER,
  reportCheckedAt,
  titleByReason,
  type DiagnosticReportBase,
  type FindingLevel,
  type HealthCategory,
  type HealthFinding,
  type HealthMetric,
  type HealthRule,
  type HealthThresholds,
} from './health.rules.js';

/** 整体结论 */
export type HealthVerdict =
  /** 全部检查项都有结论且都正常 */
  | 'ok'
  /** 有 warning 级发现，且无 critical（可同时有 unknown——判定顺序里 warn 优先于 unknown） */
  | 'warn'
  /** 有 critical 级发现 */
  | 'critical'
  /** 无 warn/critical，但**有检查项无法判定** —— 只能说"已知范围内未见异常" */
  | 'indeterminate';

/** 单次健康检查的完整报告 */
export interface HealthReport extends DiagnosticReportBase {
  verdict: HealthVerdict;
  /** 被检查的库与版本（便于判断这份报告对应哪套环境） */
  database: { name: string; sid: string; version: string; usage: string };
  /**
   * 可见性上下文。`unfiltered=false` 意味着基础设施类视图（磁盘/备份/主机内存/复制）
   * 很可能被行过滤成空集，此时它们的空结果不能读作"正常"。
   */
  visibility: Visibility;
  /** 覆盖度：让调用方知道这份报告覆盖了什么、漏了什么 */
  coverage: {
    requested: HealthCategory[];
    ok: number;
    warn: number;
    critical: number;
    unknown: number;
  };
  /**
   * **读数层**：本次检查取到的全部具体占用数据（内存百分之几、各挂载点用了多少、
   * 备份距今多久…），按规则顺序平铺。
   *
   * 与 findings 的分工：findings 回答"有没有问题"，metrics 回答"现在是多少"。
   * **即使某项判定为 ok，它的读数也在这里**——否则只有结论没有仪表，
   * 用户问"当前内存百分之多少"时无从回答。
   * 判定为 unknown 的项也会在这里留一条"无法判定"，避免该项从读数里静默消失。
   */
  metrics: HealthMetric[];
  /** 逐项结论（**恒含 ok 与 unknown**；是否剔除 ok 由工具层的 includeOk 决定，本层不做过滤） */
  findings: HealthFinding[];
}

/** 单次检查的入参（工具层已完成校验） */
export interface HealthRequest {
  checks: HealthCategory[];
  thresholds: Partial<HealthThresholds>;
}

/**
 * 探测规则上下文所需的库信息。可见性单独由 visibility.service 提供（四个诊断工具共用同一判定，
 * 避免出现"健康检查认为全量可见、活动工具认为被过滤"这类自相矛盾的输出）。
 *
 * 返回 `empty` 标记供上层留 caveat：取不到行时字段全是空串，若不说明，
 * 读者会以为自己拿到了一份"库名就叫空"的报告（静默失败）。
 */
async function probeDatabase(pool: HanaPool): Promise<{ info: HealthReport['database']; empty: boolean }> {
  const db = await pool.query<{ DATABASE_NAME: string; SYSTEM_ID: string; VERSION: string; USAGE: string }>(
    'SELECT DATABASE_NAME, SYSTEM_ID, VERSION, USAGE FROM SYS.M_DATABASE',
  );
  const row = db[0];
  return {
    info: {
      name: row?.DATABASE_NAME ?? '',
      sid: row?.SYSTEM_ID ?? '',
      version: row?.VERSION ?? '',
      usage: row?.USAGE ?? '',
    },
    empty: !row,
  };
}

/** 把规则执行中的异常转成一条 unknown 结论（不让单个规则炸掉整份报告） */
function errorToFinding(rule: HealthRule, e: unknown): HealthFinding {
  const { reason, detail } = classifyHanaError(e);
  return {
    id: rule.id,
    category: rule.category,
    level: 'unknown',
    title: titleByReason[reason],
    evidence: { 错误: detail, 规则用途: rule.purpose },
    // 读数层也留痕：该项读不到这件事本身要可见，否则 metrics 里会少一块而无人察觉
    metrics: [{ name: `${rule.category} 读数`, value: '无法判定', detail: titleByReason[reason], source: '—' }],
    unknownReason: reason,
    advice: adviceByReason[reason],
  };
}

/**
 * 由各项级别归并整体结论。
 *
 * **这是整个功能的核心不变式**：只有"全部检查项都拿到了结论且都正常"才允许给 ok。
 * 只要有一项 unknown（看不见），结论最多是 indeterminate——因为此时"未见异常"与
 * "看不见所以没发现"在证据上无法区分，报 ok 等于把不可见性伪装成健康。
 * 抽成纯函数以便单测直接锁住这条不变式。
 */
export function computeVerdict(levels: readonly FindingLevel[]): HealthVerdict {
  // 顺序取自 health.rules 的 LEVEL_ORDER（与规则内聚合的 worst() 共用同一份全序）——
  // 两处各写一份优先级时只靠注释同步，改一处就会让分项级别与整体 verdict 口径矛盾。
  const worst = levels.reduce<FindingLevel>((a, b) => (LEVEL_ORDER.indexOf(b) > LEVEL_ORDER.indexOf(a) ? b : a), 'ok');
  if (worst === 'critical') return 'critical';
  if (worst === 'warn') return 'warn';
  if (worst === 'unknown') return 'indeterminate';
  return 'ok';
}

/**
 * 执行健康检查。
 *
 * 规则**串行**执行：并发会在连接池上互相等待（池默认 4），而顺序执行的总耗时对本场景可接受
 * （各项均为点查询，实测最慢的备份检查也在 2 秒内）。串行还让日志与输出顺序稳定，便于排障。
 */
export async function runHealth(pool: HanaPool, req: HealthRequest): Promise<HealthReport> {
  const [visibility, dbProbe] = await Promise.all([probeVisibility(pool), probeDatabase(pool)]);
  const database = dbProbe.info;
  const thresholds: HealthThresholds = { ...DEFAULT_THRESHOLDS, ...stripUndefined(req.thresholds) };
  const wanted = new Set(req.checks);
  const rules = HEALTH_RULES.filter((r) => wanted.has(r.category));
  const caveats: string[] = [];
  if (dbProbe.empty) {
    logger.warn({ view: 'SYS.M_DATABASE' }, 'SYS.M_DATABASE 返回 0 行：报告中的库名/版本为空');
    caveats.push('未能读取 SYS.M_DATABASE（返回 0 行）：database 字段为空，无法据此确认这份报告对应哪套环境。');
  }

  const findings: HealthFinding[] = [];
  for (const rule of rules) {
    try {
      findings.push(await rule.run({ pool, unfiltered: visibility.unfiltered, t: thresholds }));
    } catch (e) {
      // 规则抛错 → 归一成 unknown（引擎只负责调度与归一，不猜"什么算异常"）。
      // 留一条服务端日志：调用方看到的是"无法判定"，而排障需要知道原始错误。
      logger.warn({ err: e, rule: rule.id, category: rule.category }, '健康检查规则执行失败，已归一为 unknown');
      findings.push(errorToFinding(rule, e));
    }
  }

  const levels = findings.map((f) => f.level);
  const verdict = computeVerdict(levels);
  const unknownN = levels.filter((l) => l === 'unknown').length;
  const okN = levels.filter((l) => l === 'ok' || l === 'info').length;
  const warnN = levels.filter((l) => l === 'warn').length;
  const critN = levels.filter((l) => l === 'critical').length;

  // 报告级提示：把"有多少项看不见"提到顶层（与 activity/trend/storage 的 caveats 同形），
  // 使调用方不必遍历 findings 才知道这份报告覆盖得完不完整。
  if (unknownN > 0) {
    const unknownCats = findings.filter((f) => f.level === 'unknown').map((f) => f.category);
    caveats.push(
      `有 ${unknownN} 项无法判定（${unknownCats.join(', ')}）——"未见异常"不等于"没有问题"，` +
        '各项的成因与解锁方式见对应 finding 的 unknownReason / advice。',
    );
  }

  return {
    verdict,
    summary: buildSummary(verdict, findings, database.name),
    checkedAt: reportCheckedAt(),
    database,
    visibility,
    coverage: { requested: req.checks, ok: okN, warn: warnN, critical: critN, unknown: unknownN },
    // 读数平铺到顶层：调用方要"看占用情况"时不必去 findings 里翻（且 ok 项默认不在 findings 里）
    metrics: findings.flatMap((f) => f.metrics ?? []),
    findings,
    caveats,
  };
}

/** 过滤掉 undefined，避免 ?? 覆盖掉默认值（{...defaults, ...{a:undefined}} 会把 a 变成 undefined） */
function stripUndefined<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null) out[k as keyof T] = v as T[keyof T];
  }
  return out;
}

function buildSummary(verdict: HealthVerdict, findings: HealthFinding[], dbName: string): string {
  const bad = findings.filter((f) => f.level === 'critical' || f.level === 'warn');
  const unknowns = findings.filter((f) => f.level === 'unknown');
  switch (verdict) {
    case 'ok':
      return `${dbName}：${findings.length} 项检查全部通过，未发现异常。`;
    case 'critical': {
      const crits = findings.filter((f) => f.level === 'critical');
      return (
        `${dbName}：发现 ${crits.length} 项严重问题，需立即处理 —— ${crits.map((f) => f.title).join('；')}` +
        (bad.length > crits.length ? `（另有 ${bad.length - crits.length} 项警告）` : '')
      );
    }
    case 'warn':
      return `${dbName}：未发现严重问题，但有 ${bad.length} 项需要关注 —— ${bad.map((f) => f.title).join('；')}`;
    case 'indeterminate':
      return (
        `${dbName}：已执行的检查项中未见异常，但有 ${unknowns.length} 项**无法判定**` +
        `（${unknowns.map((f) => f.category).join(', ')}），因此不能得出"系统健康"的结论。` +
        '无法判定的原因见各 finding 的 unknownReason 与 advice。'
      );
  }
}

/** 校验并规范化 checks 参数（工具层调用） */
export function normalizeChecks(
  checks?: string[],
): { ok: true; value: HealthCategory[] } | { ok: false; message: string } {
  if (!checks || checks.length === 0) return { ok: true, value: [...DEFAULT_CHECKS] };
  const invalid = checks.filter((c) => !ALL_CHECKS.includes(c as HealthCategory));
  if (invalid.length > 0) {
    return { ok: false, message: `未知的检查项：${invalid.join(', ')}；合法值：${ALL_CHECKS.join(', ')}` };
  }
  return { ok: true, value: checks as HealthCategory[] };
}

export { ALL_CHECKS, DEFAULT_CHECKS, DEFAULT_THRESHOLDS };
export type { HealthCategory, HealthFinding, FindingLevel, HealthThresholds };
