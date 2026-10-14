import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError, normalizeHanaError } from '../core/errors.js';
import { isPermissionError } from '../core/hana-errors.js';
import { logger } from '../core/logger.js';
import { isSchemaAllowed, qualifyName } from '../core/sql.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import { suffixesOf, suffixInClause } from './metadata.service.js';
import { normalizeBwSchema, parseResourceUri } from './preview.derive.js';
import type { ViewDefinition, ViewKind } from '../model/view-types.js';

/**
 * 数据预览权限诊断服务。
 *
 * 触发场景：hana_data_preview 失败且判定为访问类错误时，由 preview.service 自动调用本服务定位阻塞点。
 * 访问类错误的判定单点是 core/hana-errors 的 shouldDiagnoseAccessError：错误码 10/258/259/2950，
 * 或消息命中 not authorized / insufficient privilege / 无权限（码集口径一律以那里为准）；也可经
 * hana_data_preview_diagnose 工具手动调用做前置排查。
 *
 * 按预览通道（direct/intermediate/derived）定向检查各自所需权限：
 * - direct：_SYS_BIC 的 SELECT + 运行时视图存在性
 * - intermediate：SYS.CREATE/DROP_INTERMEDIATE_CALCULATION_VIEW_DEV 的 EXECUTE + _SYS_BIC SELECT
 * - derived：_SYS_REPO/_SYS_BIC SELECT，并解析视图 XML 追溯全部叶子基表逐个校验 SELECT（含白名单检查）
 *
 * 只读：仅查询 SYS.EFFECTIVE_PRIVILEGES / SYS.VIEWS / _SYS_REPO.ACTIVE_OBJECT(INACTIVE_OBJECT)，
 * 不执行任何写/DDL。
 */

/** 预览通道合法值（单源）：defs 的 z.enum 从这里取，不要在别处手抄第二份；新增通道只改这一行 */
export const PREVIEW_CHANNELS = ['direct', 'intermediate', 'derived'] as const;
export type PreviewChannel = (typeof PREVIEW_CHANNELS)[number];

/**
 * 运行时探测失败的「权限不足」码集：258=insufficient privilege，2950=分析权限/授权缺失。
 *
 * 与 core/hana-errors 的 PERMISSION_DENIED_CODES（7/258/2950）**刻意不同**：这里回答的是
 * 「探测失败要不要按权限不足给 BW 补授权指引」，历史判定只认 258/2950（7 是一般错误，
 * 不改变既有结论）；与那里一样用参数化的 isPermissionError 表达口径，而不是并集合。
 */
const INSUFFICIENT_PRIVILEGE_CODES: ReadonlySet<string> = new Set(['258', '2950']);

export interface DiagnosisCheck {
  /** 检查项（如 schema SELECT: _SYS_BIC） */
  item: string;
  /** 需要的权限/条件 */
  required: string;
  /** 是否通过 */
  passed: boolean;
  /** 详情（已授予/缺失/无法判定） */
  detail?: string;
}

export interface BaseTableAccess {
  schema: string;
  table: string;
  /** DATA_BASE_TABLE=基表；CALCULATION_VIEW=引用的外部计算视图（_SYS_BIC 运行时对象） */
  type: 'DATA_BASE_TABLE' | 'CALCULATION_VIEW';
  /** 是否可 SELECT（schema 级授权且 schema 在白名单） */
  selectable: boolean;
  detail?: string;
  /** 实测失败时的 HANA 错误码（精简模式 upstreamInaccessible 用） */
  code?: string;
  /** 实测失败原因（脱敏；精简模式 upstreamInaccessible 用） */
  message?: string;
}

/** 运行时对象实际可达性探测结果（SELECT 1 ... LIMIT 1 实测） */
export interface RuntimeProbe {
  /** 探测对象（_SYS_BIC."包/视图" 或上游引用对象） */
  target: string;
  /** 是否可达（查询成功） */
  accessible: boolean;
  /** 失败时的 HANA 错误码 */
  code?: string;
  /** 失败原因（脱敏后） */
  message?: string;
}

/** 精简诊断结果（默认 verbose=false 返回）：聚焦预览阻塞点，去除全部 checks 明细与 hints 冗余 */
export interface DiagnosisBrief {
  object: { packageId: string; objectName: string; kind?: ViewKind };
  channel: PreviewChannel;
  /**
   * 分析权限结论。**三态**（评审 #1118）：完全不可判定时 `determined:false` 且不写 protected/grantedCount
   * 的肯定值（读不到 XML ≠ 未受保护）；`protected` 只在判定成立时出现。
   */
  analyticPrivilege: {
    /** true = 受经典分析权限保护（checkAnalyticPrivileges=true）；determined=false 时缺省（不是 false） */
    protected?: boolean;
    /** 设计时 applyPrivilegeType 原值（如 ANALYTIC_PRIVILEGE / NONE） */
    applyPrivilegeType?: string;
    /**
     * 当前用户被授予的 ANALYTICAL_PRIVILEGE 条数；**0 = 已确认没有任何授权**。
     * 授权数查询失败等无法判定时**缺省**——不写 0，别把「未知」读成「缺失」（detail 给原因）。
     */
    grantedCount?: number;
    /** false = 设计时 XML 读不到/解析不了：protected/grantedCount 均**无法判定**（非「未受保护」） */
    determined: boolean;
    /** 无法判定或授权数查不到时的原因（透传，排障不用再开 verbose） */
    detail?: string;
  };
  /** 运行时对象（当前 CV）SELECT 1 实测是否可达；**探测未执行**（激活状态不可判定 / 未激活）时缺省——缺省 ≠ 不可达 */
  runtimeAccessible?: boolean;
  /** 上游数据源实测不可访问清单（仅不可达项；可达项不列出） */
  upstreamInaccessible: Array<{
    table: string;
    type: 'DATA_BASE_TABLE' | 'CALCULATION_VIEW';
    code?: string;
    message?: string;
  }>;
  /** 是否可预览（综合判定） */
  canPreview: boolean;
}

/** 分析权限检测结果 */
export interface AnalyticPrivilegeStatus {
  /**
   * 视图是否受分析权限保护。**只认 checkAnalyticPrivileges=true**（评审 #1120）：
   * 仅声明 applyPrivilegeType=ANALYTIC_PRIVILEGE 而未启用校验时不给「受保护」级结论，
   * 该情形由 checkAnalyticPrivilege 的结果另行如实报告（本服务自建视图恒为该形态）。
   */
  protectedByAnalyticPrivilege: boolean;
  /** 设计时 XML 的 applyPrivilegeType 原值 */
  applyPrivilegeType?: string;
  /** 设计时 XML 的 checkAnalyticPrivileges 原值 */
  checkAnalyticPrivileges?: boolean;
  /**
   * 当前用户被授予的 ANALYTICAL_PRIVILEGE 条数；**授权数查询失败（无法判定）时缺省**——
   * 不写 0，别把「未知」读成「缺失」（评审 #1118；detail 里给原因）。
   */
  grantedCount?: number;
  /** 是否通过（不受保护，或受保护且有授权）；无法判定时为 true（不阻断，留给运行时探测） */
  passed: boolean;
  detail: string;
}

export interface ViewActivationStatus {
  exists: boolean;
  activated: boolean;
  versionId?: number;
  objectSuffix?: string;
  /** 查询失败时附带原因（此时 exists/activated 不可信） */
  detail?: string;
}

export interface DiagnosisReport {
  object: { packageId: string; objectName: string; kind?: ViewKind };
  channel: PreviewChannel;
  viewActivation: ViewActivationStatus;
  /** 运行时视图 _SYS_BIC."包/视图" 是否存在（仅 direct/intermediate 通道检查）；SYS.VIEWS 读失败 ⇒ 不可判定、缺省（不写 false） */
  runtimeViewExists?: boolean;
  /** 运行时对象实际可达性探测（SELECT 1 ... LIMIT 1 实测，绕过 schema SELECT 的名义检查） */
  runtimeProbe?: RuntimeProbe;
  /** schema/过程级权限检查清单 */
  checks: DiagnosisCheck[];
  /** derived 通道追溯的叶子基表访问情况 */
  baseTables?: BaseTableAccess[];
  /** 分析权限检测结果（视图受分析权限保护时） */
  analyticPrivilege?: AnalyticPrivilegeStatus;
  /** 精简结果（verbose=false 时填）：聚焦上游不可达 + 分析权限两个核心结论 */
  brief?: DiagnosisBrief;
  summary: {
    canPreview: boolean;
    blockers: string[];
    hints: string[];
  };
  /** 自动触发时附带的原始错误（手动调用为空） */
  triggeredBy?: { code?: string; message: string };
}

export interface DiagnoseOptions {
  kind?: ViewKind;
  channel: PreviewChannel;
  triggeredBy?: { code?: string; message: string };
  /**
   * 详细模式开关。默认 false=精简（仅返回 brief：上游不可达清单 + 分析权限结论 + canPreview）；
   * true=完整（返回全部 checks/baseTables/analyticPrivilege/brief）。自动诊断（preview 失败触发）恒用完整模式。
   */
  verbose?: boolean;
}

/** 诊断入口：按通道定向检查权限与对象可访问性，返回结构化报告 */
export async function diagnosePreview(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: DiagnoseOptions,
): Promise<DiagnosisReport> {
  const checks: DiagnosisCheck[] = [];
  const blockers: string[] = [];
  const hints: string[] = [];

  // 1. 视图激活状态（所有通道前置：未激活则无运行时对象可预览）
  const activation = await checkViewActivation(pool, packageId, objectName, opts.kind);
  if (!activation.detail) {
    if (!activation.exists) {
      blockers.push(`视图 ${packageId}/${objectName} 在 _SYS_REPO 中未找到（未创建或未激活）`);
      hints.push('用 hana_metadata_search_objects 按名称片段确认对象是否存在；包名/对象名大小写敏感（仓库内大写存储）');
    } else if (!activation.activated) {
      blockers.push('对象存在但未激活，无运行时对象可供预览');
      hints.push('先激活视图（ZDEMO 包用 hana_view_activate；其他包在 HANA Studio 激活）后再预览');
    }
  }

  // 2. 运行时视图存在性（direct/intermediate 依赖 _SYS_BIC 运行时对象）
  //    三态（评审 #1121）：只有**确定不存在**（'missing'）才写 blocker；'unknown'（SYS.VIEWS 读失败/
  //    不可见）不可判定——不把权限/瞬时问题误报成「激活失败或运行时未生成」。
  let viewExists: boolean | undefined;
  if (opts.channel === 'direct' || opts.channel === 'intermediate') {
    const existence = await runtimeViewExists(pool, `${packageId}/${objectName}`);
    if (existence === 'exists') viewExists = true;
    else if (existence === 'missing') viewExists = false;
    // 'unknown'：runtimeViewExists 保持缺省（不在回执里写 false 的肯定值）
    if (existence === 'missing' && activation.activated) {
      blockers.push(
        `运行时视图 "_SYS_BIC"."${packageId}/${objectName}" 不存在，但设计时对象已激活（激活可能失败或运行时未生成）`,
      );
      hints.push('用 hana_view_validate(target=runtime) 复检运行时一致性');
    }
  }

  // 3. 通道定向权限检查（仅在 verbose 模式产生完整 checks 明细；精简模式跳过，下游只看 brief）
  const verbose = opts.verbose ?? false;
  let baseTables: BaseTableAccess[] | undefined;
  if (verbose) {
    if (opts.channel === 'direct') {
      await checkSchemaSelect(pool, '_SYS_BIC', '预览运行时视图数据', checks, blockers, hints);
    } else if (opts.channel === 'intermediate') {
      await checkProcedureExecute(pool, 'CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV', checks, blockers, hints);
      await checkProcedureExecute(pool, 'DROP_INTERMEDIATE_CALCULATION_VIEW_DEV', checks, blockers, hints);
      await checkSchemaSelect(pool, '_SYS_BIC', '查询中间视图数据', checks, blockers, hints);
    } else {
      await checkSchemaSelect(pool, '_SYS_REPO', '读取视图设计时 XML（CDATA）', checks, blockers, hints);
      await checkSchemaSelect(pool, '_SYS_BIC', '引用外部计算视图运行时对象', checks, blockers, hints);
      // 叶子遍历只有一个实现（collectLeafAccess）；verbose 通过渲染函数产出 checks/blockers/hints 明细
      const traversal = await collectLeafAccess(pool, packageId, objectName, opts.kind);
      baseTables = renderLeafTraversalVerbose(traversal, checks, blockers, hints);
    }
  }

  // 4. 分析权限检测：视图受分析权限保护时，schema SELECT 通过 ≠ 可查询（BW on HANA 常见根因）。
  //    读设计时 XML 的 applyPrivilegeType/checkAnalyticPrivileges，并查当前用户被授予的 ANALYTICAL_PRIVILEGE 条数。
  //    "受保护"只认 checkAnalyticPrivileges=true（评审 #1120）；XML 读不到 ⇒ 不可判定（评审 #1118）。
  //    精简模式仍需检测（brief 要三态结论），但不写 checks 明细/blockers/hints（那些属于 verbose 产物）。
  const analyticCheck = await checkAnalyticPrivilege(pool, packageId, objectName, opts.kind, verbose ? checks : []);
  const analyticPrivilege = analyticCheck.kind === 'protected' ? analyticCheck.status : undefined;
  if (verbose && analyticPrivilege && !analyticPrivilege.passed) {
    blockers.push(
      `视图受分析权限保护（applyPrivilegeType=${analyticPrivilege.applyPrivilegeType ?? 'ANALYTIC_PRIVILEGE'}, ` +
        `checkAnalyticPrivileges=${analyticPrivilege.checkAnalyticPrivileges}）但当前用户未被授予任何 ANALYTICAL_PRIVILEGE（${analyticPrivilege.grantedCount} 条）。` +
        `HANA 的 schema SELECT 不能替代分析权限——这是 BW on HANA 预览失败最常见的根因`,
    );
    hints.push(
      '由 BW 管理员在 BW 侧分配覆盖该视图的分析权限对象（含对应 InfoProvider/Query 授权）；HANA 层 GRANT SELECT 无法替代',
    );
    hints.push('若仅需排障验证，可临时让 DBA 授予该用户覆盖本视图的分析权限，或用一个已分配分析权限的账号验证');
  }

  // 5 & 6. 运行时实测 + 上游实测：两者相互独立，并行执行避免串行往返。
  //   - 运行时实测（runtimeProbe）：探测 _SYS_BIC."包/视图" 是否真能 SELECT（金标准）。仅对象已激活时探测。
  //   - 上游实测（upstream）：derived 通道精简模式追溯 XML 叶子数据源并实测可达性。
  //   两者查询互不依赖，并发执行；连接池满时自动排队复用。
  const needUpstreamProbe = !verbose && opts.channel === 'derived';
  const shouldProbeRuntime = activation.activated && !activation.detail;

  const [runtimeResult, upstreamResult] = await Promise.all([
    shouldProbeRuntime ? probeRuntimeAccess(pool, packageId, objectName) : Promise.resolve(undefined),
    needUpstreamProbe ? probeUpstream(pool, packageId, objectName, opts.kind) : Promise.resolve(null),
  ]);
  let runtimeProbe: RuntimeProbe | undefined = runtimeResult ?? undefined;
  if (needUpstreamProbe && upstreamResult) {
    baseTables = upstreamResult.baseTables;
  }
  let upstreamInaccessible: DiagnosisBrief['upstreamInaccessible'] =
    needUpstreamProbe && upstreamResult ? upstreamResult.inaccessible : [];

  if (verbose) {
    // verbose 模式：上游清单在第 3 步已填，这里只从其派生不可达清单 + 写 blockers/hints
    if (baseTables) {
      upstreamInaccessible = baseTables
        .filter((b) => !b.selectable)
        .map((b) => ({ table: b.table, type: b.type, code: b.code, message: b.message }));
    }
    if (runtimeProbe && !runtimeProbe.accessible) {
      blockers.push(
        `运行时对象实测不可访问：SELECT 探测失败${runtimeProbe.code ? `（错误码 ${runtimeProbe.code}）` : ''}：${runtimeProbe.message ?? '未知错误'}`,
      );
      // 258/2950 = insufficient privilege（见 INSUFFICIENT_PRIVILEGE_CODES），结合分析权限结果给出针对性指引
      if (
        isPermissionError(
          { code: runtimeProbe.code, message: runtimeProbe.message ?? '' },
          INSUFFICIENT_PRIVILEGE_CODES,
        )
      ) {
        if (analyticPrivilege?.protectedByAnalyticPrivilege) {
          hints.push(
            '错误码 258/2950 + 视图受分析权限保护（checkAnalyticPrivileges=true）→ 确认为分析权限缺失（非 schema SELECT 问题），需在 BW 侧补分析权限授权',
          );
        } else if (analyticCheck.kind === 'unprotected' && analyticCheck.declaredApplyPrivilegeType) {
          // 仅声明 applyPrivilegeType、未启用校验：不给「确认为分析权限缺失」的定论（评审 #1120）——
          // 本服务自建视图恒为该形态（applyPrivilegeType=ANALYTIC_PRIVILEGE + checkAnalyticPrivileges=false）
          hints.push(
            `错误码 258/2950：视图声明了 applyPrivilegeType=${analyticCheck.declaredApplyPrivilegeType} 但未启用校验（checkAnalyticPrivileges≠true）——` +
              '若该视图确受分析权限保护，需在 BW 侧补授权；否则按 _SYS_BIC SELECT / 上游对象权限排查',
          );
        } else if (analyticCheck.kind === 'undetermined') {
          hints.push(
            `错误码 258/2950：设计时 XML 读不到，分析权限保护与否不可判定（${analyticCheck.detail}）——` +
              '先按 _SYS_BIC SELECT、上游对象可访问性逐项排查',
          );
        } else {
          hints.push('错误码 258/2950 通常为权限不足：检查 _SYS_BIC SELECT、分析权限、以及上游对象的可访问性');
        }
      }
    }
    if (runtimeProbe?.accessible) {
      // 实测可达：清除前面因分析权限「推断未授权」产生的 blocker（实测成功才是金标准）
      const apBlockIdx = blockers.findIndex((b) => b.includes('视图受分析权限保护'));
      if (apBlockIdx >= 0) blockers.splice(apBlockIdx, 1);
    }
  }

  // 组装 brief（精简结论）：上游不可达 + 分析权限 + 运行时可达 + canPreview
  const runtimeOk = runtimeProbe?.accessible === true;
  const upstreamBlocked = upstreamInaccessible.length > 0;
  const brief: DiagnosisBrief = {
    object: { packageId, objectName, kind: opts.kind },
    channel: opts.channel,
    analyticPrivilege: briefAnalyticPrivilege(analyticCheck),
    // 实测未执行（激活状态不可判定 / 未激活）时缺省：不把「没测」写成「不可达」（评审 #1118 同型失配）
    ...(runtimeProbe !== undefined ? { runtimeAccessible: runtimeProbe.accessible } : {}),
    upstreamInaccessible,
    // canPreview 判定：运行时实测可达（金标准）且无上游不可达。
    // 分析权限「受保护 + 0 授权」只是设计时推断出的「疑似缺权限」，实测可达即证明可查，故不参与此判定
    // ——运行时探测不可达时 canPreview 已为假，无需再叠加推断；结论由 brief.analyticPrivilege 独立给出。
    canPreview: runtimeOk && !upstreamBlocked,
  };

  return {
    object: { packageId, objectName, kind: opts.kind },
    channel: opts.channel,
    viewActivation: activation,
    runtimeViewExists: viewExists,
    runtimeProbe,
    checks,
    baseTables,
    analyticPrivilege,
    brief,
    summary: { canPreview: brief.canPreview, blockers, hints },
    triggeredBy: opts.triggeredBy,
  };
}

/** 视图激活状态：ACTIVE_OBJECT（已激活）/ INACTIVE_OBJECT（未激活） */
async function checkViewActivation(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind?: ViewKind,
): Promise<ViewActivationStatus> {
  const suffixes = suffixesOf(kind);
  const ph = suffixInClause(suffixes);
  try {
    const active = await pool.query<{ OBJECT_SUFFIX: string; VERSION_ID: number }>(
      `SELECT OBJECT_SUFFIX, VERSION_ID FROM "_SYS_REPO"."ACTIVE_OBJECT"
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN ${ph}
       ORDER BY VERSION_ID DESC LIMIT 1`,
      [packageId, objectName, ...suffixes],
    );
    if (active[0]) {
      return { exists: true, activated: true, versionId: active[0].VERSION_ID, objectSuffix: active[0].OBJECT_SUFFIX };
    }
    const inactive = await pool.query<{ OBJECT_SUFFIX: string }>(
      `SELECT OBJECT_SUFFIX FROM "_SYS_REPO"."INACTIVE_OBJECT"
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN ${ph} LIMIT 1`,
      [packageId, objectName, ...suffixes],
    );
    if (inactive[0]) {
      return { exists: true, activated: false, objectSuffix: inactive[0].OBJECT_SUFFIX };
    }
    return { exists: false, activated: false };
  } catch (e) {
    // 诊断降级：读不到 _SYS_REPO 时激活状态不可判定（结论里以 detail 如实回报，不阻断）
    logger.warn({ packageId, objectName, err: e }, '无法读取 _SYS_REPO，视图激活状态不可判定');
    return { exists: false, activated: false, detail: '无法读取 _SYS_REPO（可能缺少 _SYS_REPO 的 SELECT 权限）' };
  }
}

/**
 * 运行时视图存在性三态（评审 #1111/#1121）：**读失败不得冒充「不存在」**——
 * 'missing' 才是确定的「不存在」，'unknown' 的判读入口（诊断 blocker / 预览的 CREATE 回退）各自定策。
 */
export type RuntimeViewExistence = 'exists' | 'missing' | 'unknown';

/**
 * _SYS_BIC 运行时视图是否存在（SYS.VIEWS 目录查询）。
 * @param viewName 视图名：CV 运行时对象为 "包/对象"；节点预览中间视图为 "包/对象/dp/节点"
 */
export async function runtimeViewExists(pool: HanaPool, viewName: string): Promise<RuntimeViewExistence> {
  try {
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM SYS.VIEWS WHERE SCHEMA_NAME = '_SYS_BIC' AND VIEW_NAME = ?`,
      [viewName],
      { timeoutMs: pool.statementTimeoutMs },
    );
    return (rows[0]?.C ?? 0) > 0 ? 'exists' : 'missing';
  } catch (e) {
    // 诊断降级：SYS 目录读不到（权限/瞬时失败）时**不可判定**（不是「不存在」），留痕便于排障
    logger.warn({ viewName, err: e }, '查询 SYS.VIEWS 失败，运行时视图存在性不可判定');
    return 'unknown';
  }
}

/**
 * 节点预览中间视图的**新鲜度信息回报**：复用到的视图建于何时、源 CV 最近一次激活于何时。
 *
 * 为什么只回报不改行为：复用策略是用户明确口径（存在即复用、**不校验新鲜度**，见 preview.service
 * 头注与 rules=preview）。本函数只提供**判据**——`stale=true`（中间视图创建时间早于源 CV 最近激活）
 * 时调用方自行决定「先删该视图 / 改 forceDerive / 接受旧数据」，服务端不替它做选择。
 *
 * 全部时间戳比较**在 SQL 里做**（`A.LAST_ACT > V.CREATE_TIME`）：两列出自不同口径的系统表，
 * 驱动回传的字符串格式不保证一致，拉回 JS 再 parse 是自找口径分叉。
 *
 * fail-open：任何失败（SYS.VIEWS/_SYS_REPO 不可读、视图刚被并发删掉）都只回 `detail`，
 * **绝不让信息回报把预览本身打挂**——它不是预览结果的一部分，只是附注。
 */
export interface IntermediateFreshness {
  /** 中间视图创建时间（SYS.VIEWS.CREATE_TIME，原样文本） */
  createdAt?: string;
  /** 源对象最近一次激活时间（_SYS_REPO.ACTIVE_OBJECT 的 MAX(ACTIVATED_AT)） */
  activatedAt?: string;
  /** true = 中间视图创建于源对象最近激活**之前** ⇒ 复用到的是旧定义（预览数据可能落后） */
  stale?: boolean;
  /** 无法判定时的原因（读不到时间戳等；此时 createdAt/activatedAt/stale 均缺省） */
  detail?: string;
}

export async function readIntermediateFreshness(
  pool: HanaPool,
  viewName: string,
  packageId: string,
  objectName: string,
): Promise<IntermediateFreshness> {
  try {
    // CROSS JOIN 的右侧是聚合子查询（恒一行）；CASE 在 SQL 内比较两个 TIMESTAMP，避免跨格式 parse。
    // 源对象按 (包, 名) 取 MAX(ACTIVATED_AT)：同名多后缀（CV/AV）时取"最近一次激活"，语义上更保守
    // ——它只会把复用判成"可能旧"，不会把旧定义误判成新。
    const rows = await pool.query<{ CREATED_AT: unknown; ACTIVATED_AT: unknown; STALE: unknown }>(
      `SELECT V.CREATE_TIME AS CREATED_AT, A.LAST_ACT AS ACTIVATED_AT,
              CASE WHEN A.LAST_ACT > V.CREATE_TIME THEN 1 ELSE 0 END AS STALE
         FROM SYS.VIEWS V
         CROSS JOIN (SELECT MAX(ACTIVATED_AT) AS LAST_ACT FROM _SYS_REPO.ACTIVE_OBJECT
                      WHERE PACKAGE_ID = ? AND OBJECT_NAME = ?) A
        WHERE V.SCHEMA_NAME = '_SYS_BIC' AND V.VIEW_NAME = ?`,
      [packageId, objectName, viewName],
      { timeoutMs: pool.statementTimeoutMs },
    );
    const row = rows[0];
    const createdAt = timestampText(row?.CREATED_AT);
    const activatedAt = timestampText(row?.ACTIVATED_AT);
    if (createdAt === undefined || activatedAt === undefined) {
      return { detail: '时间戳不可读（中间视图刚被移除或源对象无激活记录），新鲜度无法判定' };
    }
    return { createdAt, activatedAt, stale: Number(row?.STALE ?? 0) === 1 };
  } catch (e) {
    logger.warn({ viewName, packageId, objectName, err: e }, '中间视图新鲜度读取失败（不影响预览结果）');
    return { detail: '新鲜度时间戳读取失败（不影响预览结果）' };
  }
}

/** TIMESTAMP 列归一为文本：驱动可能回 string 或 Date，两种都收敛成可直接展示的字符串 */
function timestampText(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  return v instanceof Date ? v.toISOString() : String(v);
}

/**
 * 当前用户对某 schema 是否有 **schema 级** SELECT（EFFECTIVE_PRIVILEGES）。
 *
 * `OBJECT_NAME IS NULL` 是对象层级的判别式（与 visibility.service 的区分口径同源）：
 * 该表同时含 schema 级与**对象级**授权行——不加这个过滤时，用户只对 schema 下某一张表有 SELECT
 * 也会命中（BW 常见对象级授权），同 schema 的其它基表被误判「已授予」（评审 #1119）。
 */
async function hasSchemaSelect(pool: HanaPool, schema: string): Promise<boolean> {
  const rows = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND SCHEMA_NAME = ? AND OBJECT_NAME IS NULL AND PRIVILEGE = 'SELECT'`,
    [schema],
  );
  return (rows[0]?.C ?? 0) > 0;
}

/** 检查 schema SELECT 并记录到 checks/blockers/hints */
async function checkSchemaSelect(
  pool: HanaPool,
  schema: string,
  purpose: string,
  checks: DiagnosisCheck[],
  blockers: string[],
  hints: string[],
): Promise<void> {
  const ok = await hasSchemaSelect(pool, schema);
  checks.push({
    item: `schema SELECT: ${schema}`,
    required: `对 schema ${schema} 的 SELECT（${purpose}）`,
    passed: ok,
    detail: ok ? '已授予' : '缺失',
  });
  if (!ok) {
    blockers.push(`缺少 schema ${schema} 的 SELECT 权限（${purpose}）`);
    hints.push(`由 DBA 授予：GRANT SELECT ON SCHEMA ${schema} TO "<user>";（或含该 schema 的 BW 分析授权角色）`);
  }
}

/**
 * 当前用户对过程的 EXECUTE 权限判定 —— 预览前置检查与诊断通道的**唯一**实现。
 *
 * 两种匹配口径都沿用既有实现，SQL 与判定逐字保留：合成单一查询必然改动其中一条链路的口径
 * （属 HANA 侧行为变更，而两条链路的结论用途不同），故口径显式参数化而非取并集：
 * - 'exact'（默认）：OBJECT_NAME 精确 + SCHEMA_NAME='SYS'。诊断通道逐过程核对，
 *   未通过时给出该过程的 GRANT 文案；
 * - 'family'：OBJECT_NAME 前缀（CREATE_/DROP_ 两族）一次问全。预览前置检查只关心
 *   「中间视图这套过程能不能用」——过程名在不同版本可能带 _DEV 等后缀，故用前缀，且不做逐过程结论
 *   （任一族的授权缺失都意味着节点预览不可用，直接返回「不支持」）。
 *
 * @param procName 'exact' 口径的过程名；'family' 口径按固定前缀两族查询，不使用该参数
 */
export async function hasExecutePrivilege(
  pool: HanaPool,
  procName: string,
  match: 'exact' | 'family' = 'exact',
): Promise<boolean> {
  if (match === 'family') {
    // 前缀族口径：固定查 CREATE_/DROP_ 两族，不用 procName（调用方给的具体过程名可能带 _DEV 后缀）
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
       WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'EXECUTE'
       AND (OBJECT_NAME LIKE 'CREATE_INTERMEDIATE_CALCULATION_VIEW%' OR OBJECT_NAME LIKE 'DROP_INTERMEDIATE_CALCULATION_VIEW%')`,
    );
    return (rows[0]?.C ?? 0) > 0;
  }
  const rows = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'EXECUTE' AND SCHEMA_NAME = 'SYS' AND OBJECT_NAME = ?`,
    [procName],
  );
  return (rows[0]?.C ?? 0) > 0;
}

/** 检查 SYS 下过程 EXECUTE 并记录（诊断渲染；判定委托 hasExecutePrivilege 单点） */
async function checkProcedureExecute(
  pool: HanaPool,
  procName: string,
  checks: DiagnosisCheck[],
  blockers: string[],
  hints: string[],
): Promise<void> {
  const ok = await hasExecutePrivilege(pool, procName);
  checks.push({
    item: `EXECUTE: SYS.${procName}`,
    required: `SYS.${procName} 的 EXECUTE`,
    passed: ok,
    detail: ok ? '已授予' : '缺失',
  });
  if (!ok) {
    blockers.push(`缺少 SYS.${procName} 的 EXECUTE 权限`);
    hints.push(`由 DBA 授予：GRANT EXECUTE ON SYS.${procName} TO "<user>";`);
  }
}

/** 叶子数据源的可达性事实（结构化结果：判定只做一次，verbose/brief 只决定怎么渲染） */
type LeafAccess =
  | {
      type: 'DATA_BASE_TABLE';
      schema: string;
      table: string;
      /** schema 是否在白名单内（false 时不查询 SELECT，判定就是不可访问） */
      allowed: boolean;
      /** 白名单内是否有 SELECT（allowed=false 时恒 false） */
      granted: boolean;
    }
  | {
      type: 'CALCULATION_VIEW';
      schema: string;
      table: string;
      /** SELECT 1 实测结果（唯一可达判据） */
      probe: RuntimeProbe;
    };

/** 叶子遍历结果：ok=false 只有原因（verbose 渲染成 blocker，brief 静默按空处理） */
type LeafTraversal =
  | { ok: true; sourceCount: number; leaves: LeafAccess[] }
  | { ok: false; kind: 'xml_error'; message: string }
  | { ok: false; kind: 'no_cdata' };

/** 该叶子是否可访问（唯一判定）：基表=白名单内且有 SELECT；CV=实测可达 */
function isLeafAccessible(leaf: LeafAccess): boolean {
  return leaf.type === 'DATA_BASE_TABLE' ? leaf.allowed && leaf.granted : leaf.probe.accessible;
}

/**
 * derived 通道：解析视图 XML → 追溯全部叶子数据源 → 逐个探测可达性（**唯一实现**）。
 *
 * 叶子遍历与去重只有一份实现（collectLeafAccess＋两个纯渲染函数），verbose/brief 仅在渲染层分叉，
 * 判定与去重规则不会在两份遍历间漂移。
 * 返回的 leaves 与 XML 中的出现**一一对应**（不在这里去重）：渲染层保持既有行为
 * （verbose 对重复出现逐个报 blocker；baseTables/brief 清单按首次出现去重）。
 * 探测并行（Promise.all）：上游数可达十几个，串行往返会成倍拖慢；连接池满时自动排队复用。
 */
async function collectLeafAccess(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
): Promise<LeafTraversal> {
  let def: ViewDefinition | undefined;
  try {
    const result = await viewDefinitionCache.get(pool, packageId, objectName, { kind });
    def = result.definition;
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    // 诊断降级：读不到设计时 XML 就无法追溯上游（verbose 会把这个原因渲染成 blocker，brief 静默按空处理）
    logger.warn({ packageId, objectName, err: e }, '诊断无法读取视图设计时 XML，上游追溯降级');
    return { ok: false, kind: 'xml_error', message };
  }
  if (!def) return { ok: false, kind: 'no_cdata' };

  const probed = await Promise.all(
    collectLeafDataSources(def).map(async (ds): Promise<LeafAccess | null> => {
      if (ds.type === 'DATA_BASE_TABLE' && ds.schemaName && ds.columnObjectName) {
        // BW on HANA：XML 中 schemaName="ABAP" 是源系统名，真实表在 SAPABAP1（与 preview.derive.normalizeBwSchema 同源）
        const schema = normalizeBwSchema(ds.schemaName);
        const allowed = isSchemaAllowed(schema);
        const granted = allowed && (await hasSchemaSelect(pool, schema));
        return { type: 'DATA_BASE_TABLE', schema, table: ds.columnObjectName, allowed, granted };
      }
      if (ds.type === 'CALCULATION_VIEW' && ds.resourceUri) {
        // resourceUri 形如 /包路径/calculationviews/对象名 → _SYS_BIC."包路径/对象名"（与 preview.derive.parseResourceUri 同源）
        const parsed = parseResourceUri(ds.resourceUri);
        if (!parsed) return null; // 解析不出即跳过（与既有行为一致：诊断不报这条）
        const probe = await probeRuntimeAccess(pool, parsed.pkg, parsed.name);
        return { type: 'CALCULATION_VIEW', schema: '_SYS_BIC', table: `${parsed.pkg}/${parsed.name}`, probe };
      }
      return null;
    }),
  );

  return { ok: true, sourceCount: def.dataSources.length, leaves: probed.filter((l): l is LeafAccess => l !== null) };
}

/** verbose 渲染：写 checks/blockers/hints 明细并返回去重后的 baseTables */
function renderLeafTraversalVerbose(
  traversal: LeafTraversal,
  checks: DiagnosisCheck[],
  blockers: string[],
  hints: string[],
): BaseTableAccess[] {
  if (!traversal.ok) {
    if (traversal.kind === 'xml_error') {
      checks.push({
        item: '解析视图 XML',
        required: '读取并解析 _SYS_REPO 设计时 XML',
        passed: false,
        detail: `失败：${traversal.message}`,
      });
      blockers.push(`无法读取/解析视图 XML，derived 通道无法追溯基表：${traversal.message}`);
      hints.push('确认 _SYS_REPO 读权限与视图已激活；脚本节点（SqlScriptView）derived 通道本就不支持');
    } else {
      checks.push({ item: '解析视图 XML', required: '视图存在 CDATA', passed: false, detail: '视图无 CDATA' });
      blockers.push('视图无 CDATA（设计时 XML 为空），derived 通道无法追溯基表');
    }
    return [];
  }
  checks.push({
    item: '解析视图 XML',
    required: '读取并解析 _SYS_REPO 设计时 XML',
    passed: true,
    detail: `解析成功（${traversal.sourceCount} 个数据源）`,
  });

  const result: BaseTableAccess[] = [];
  for (const leaf of traversal.leaves) {
    if (leaf.type === 'DATA_BASE_TABLE') {
      let detail: string;
      if (!leaf.allowed) {
        detail = `schema ${leaf.schema} 不在白名单（系统 schema 或 HANA_READ_SCHEMA 配置）`;
        blockers.push(`基表 ${leaf.schema}.${leaf.table} 不可访问：${detail}`);
        hints.push(`在 .env / mcp.json 设置 HANA_READ_SCHEMA=${leaf.schema} 追加允许的 schema`);
      } else if (!leaf.granted) {
        detail = '缺失';
        blockers.push(`基表 ${leaf.schema}.${leaf.table} 缺少 SELECT 权限`);
        hints.push(`GRANT SELECT ON ${leaf.schema}.${leaf.table} TO "<user>";`);
      } else {
        detail = '已授予';
      }
      pushBaseTable(result, {
        schema: leaf.schema,
        table: leaf.table,
        type: 'DATA_BASE_TABLE',
        selectable: isLeafAccessible(leaf),
        detail,
      });
    } else {
      const { probe } = leaf;
      const detail = probe.accessible
        ? '实测可达'
        : `实测不可达${probe.code ? `(${probe.code})` : ''}：${probe.message ?? ''}`;
      if (!probe.accessible) {
        blockers.push(
          `引用的上游对象 ${leaf.schema}/${leaf.table} 实测不可访问：${probe.message ?? '未知错误'}${probe.code ? `（错误码 ${probe.code}）` : ''}`,
        );
        hints.push(
          `上游对象不可访问多为分析权限缺失（BW Query/受保护 CV）；检查该对象是否受分析权限保护并补授权，或排查其上游链`,
        );
      }
      pushBaseTable(result, {
        schema: leaf.schema,
        table: leaf.table,
        type: 'CALCULATION_VIEW',
        selectable: probe.accessible,
        detail,
        code: probe.accessible ? undefined : probe.code,
        message: probe.accessible ? undefined : probe.message,
      });
    }
  }
  return result;
}

/**
 * brief 渲染：去重后的 baseTables + 不可达清单（不写 checks/blockers/hints 明细，那些是 verbose 产物）。
 * 基表按 schema 白名单 + SELECT 名义检查；外部 CV 以 SELECT 1 实测为准。
 */
function renderLeafTraversalBrief(traversal: LeafTraversal): {
  baseTables: BaseTableAccess[];
  inaccessible: DiagnosisBrief['upstreamInaccessible'];
} {
  if (!traversal.ok) return { baseTables: [], inaccessible: [] };

  // 按原叶子顺序组装（去重），保证结果稳定；去重口径单点在 pushBaseTable（与 verbose 清单同源）
  const baseTables: BaseTableAccess[] = [];
  const inaccessible: DiagnosisBrief['upstreamInaccessible'] = [];
  for (const leaf of traversal.leaves) {
    const item: BaseTableAccess =
      leaf.type === 'DATA_BASE_TABLE'
        ? {
            schema: leaf.schema,
            table: leaf.table,
            type: 'DATA_BASE_TABLE',
            selectable: isLeafAccessible(leaf),
            detail: isLeafAccessible(leaf)
              ? '已授予'
              : leaf.allowed
                ? 'SELECT 缺失'
                : `schema ${leaf.schema} 不在白名单`,
          }
        : {
            schema: leaf.schema,
            table: leaf.table,
            type: 'CALCULATION_VIEW',
            selectable: leaf.probe.accessible,
            detail: leaf.probe.accessible ? '实测可达' : `实测不可达${leaf.probe.code ? `(${leaf.probe.code})` : ''}`,
            code: leaf.probe.accessible ? undefined : leaf.probe.code,
            message: leaf.probe.accessible ? undefined : leaf.probe.message,
          };
    if (!pushBaseTable(baseTables, item)) continue;
    if (!item.selectable) {
      inaccessible.push({ table: item.table, type: item.type, code: item.code, message: item.message });
    }
  }
  return { baseTables, inaccessible };
}

/** 精简模式的上游实测：遍历（collectLeafAccess）→ brief 渲染，形状与既有实现一致 */
async function probeUpstream(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
): Promise<{ baseTables: BaseTableAccess[]; inaccessible: DiagnosisBrief['upstreamInaccessible'] }> {
  return renderLeafTraversalBrief(await collectLeafAccess(pool, packageId, objectName, kind));
}

/** 视图叶子数据源（基表 + 外部计算视图） */
function collectLeafDataSources(
  def: ViewDefinition,
): { type: string; schemaName?: string; columnObjectName?: string; resourceUri?: string }[] {
  return def.dataSources.filter((d) => d.type === 'DATA_BASE_TABLE' || d.type === 'CALCULATION_VIEW');
}

/** 基表去重（按 schema.table，保留首个）；返回是否入列（false = 该键已存在，调用方按重复项处理） */
function pushBaseTable(arr: BaseTableAccess[], item: BaseTableAccess): boolean {
  const key = `${item.schema}.${item.table}`;
  if (arr.some((x) => `${x.schema}.${x.table}` === key)) return false;
  arr.push(item);
  return true;
}

/**
 * 实测运行时对象可达性：`SELECT 1 FROM "_SYS_BIC"."包/视图" LIMIT 1`。
 * 这是判断「能否预览」的金标准——schema SELECT 名义检查通过不代表可查（分析权限/上游阻塞都不体现在 schema SELECT 上）。
 * 失败时归一化为 HanaBusinessError 取 code + 脱敏 message。
 */
async function probeRuntimeAccess(pool: HanaPool, packageId: string, objectName: string): Promise<RuntimeProbe> {
  const target = `"_SYS_BIC"."${packageId}/${objectName}"`;
  try {
    await pool.query(`SELECT 1 FROM ${qualifyName('_SYS_BIC', `${packageId}/${objectName}`)} LIMIT 1`);
    return { target, accessible: true };
  } catch (e) {
    const norm = e instanceof HanaBusinessError ? e : normalizeHanaError(e);
    return {
      target,
      accessible: false,
      code: norm.code,
      message: norm.message,
    };
  }
}

/**
 * 分析权限检测三态（评审 #1118/#1120）：
 * - 'undetermined'：设计时 XML 读不到/无 CDATA——保护与否**无法判定**（不是「未受保护」）；
 * - 'unprotected'：确定不启用分析权限校验（checkAnalyticPrivileges≠true）；仅声明 applyPrivilegeType
 *   时经 declaredApplyPrivilegeType 如实带出（不给「受保护」级结论）；
 * - 'protected'：checkAnalyticPrivileges=true，附授权数检测状态。
 */
type AnalyticPrivilegeOutcome =
  | { kind: 'undetermined'; detail: string }
  | { kind: 'unprotected'; declaredApplyPrivilegeType?: string }
  | { kind: 'protected'; status: AnalyticPrivilegeStatus };

/** brief 的分析权限子对象（评审 #1118）：不可判定时不写 protected=false/grantedCount=0 这类肯定值 */
function briefAnalyticPrivilege(check: AnalyticPrivilegeOutcome): DiagnosisBrief['analyticPrivilege'] {
  if (check.kind === 'undetermined') return { determined: false, detail: check.detail };
  if (check.kind === 'unprotected') {
    return {
      determined: true,
      protected: false,
      ...(check.declaredApplyPrivilegeType !== undefined
        ? { applyPrivilegeType: check.declaredApplyPrivilegeType }
        : {}),
    };
  }
  const s = check.status;
  return {
    determined: true,
    protected: true,
    ...(s.applyPrivilegeType !== undefined ? { applyPrivilegeType: s.applyPrivilegeType } : {}),
    // 授权数不可判定（查询失败）时缺省：不写 0（0 的口径是「已确认没有任何授权」），原因进 detail
    ...(s.grantedCount !== undefined ? { grantedCount: s.grantedCount } : { detail: s.detail }),
  };
}

/**
 * 分析权限检测：读设计时 XML 的 applyPrivilegeType / checkAnalyticPrivileges，并查当前用户被授予的
 * ANALYTICAL_PRIVILEGE 条数。BW 视图几乎都 checkAnalyticPrivileges=true，schema SELECT 无法替代分析权限。
 *
 * 「受保护」只认 checkAnalyticPrivileges=true（评审 #1120）：applyPrivilegeType 单独出现时不给
 * 「受保护 / 确认为分析权限缺失」级结论；XML 读不到时如实返回 'undetermined'（评审 #1118）。
 */
async function checkAnalyticPrivilege(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
  checks: DiagnosisCheck[],
): Promise<AnalyticPrivilegeOutcome> {
  let def: ViewDefinition | undefined;
  try {
    const result = await viewDefinitionCache.get(pool, packageId, objectName, { kind });
    def = result.definition;
  } catch (e) {
    // 读不到 XML ⇒ 保护与否不可判定（不得渲染成「未受保护」）；留痕便于排障
    logger.warn({ packageId, objectName, err: e }, '诊断无法读取视图设计时 XML，分析权限保护与否不可判定');
    return {
      kind: 'undetermined',
      detail: '无法读取/解析视图设计时 XML（可能缺少 _SYS_REPO 的 SELECT 权限）：分析权限保护与否不可判定',
    };
  }
  if (!def) return { kind: 'undetermined', detail: '视图设计时 XML 无 CDATA：分析权限保护与否不可判定' };

  const applyPrivilegeType = def.applyPrivilegeType;
  const checkAnalyticPrivileges = def.checkAnalyticPrivileges;
  const protectedByAnalyticPrivilege = checkAnalyticPrivileges === true;
  const declaredAnalyticPrivilege =
    applyPrivilegeType != null && applyPrivilegeType.toUpperCase() === 'ANALYTIC_PRIVILEGE';

  if (!protectedByAnalyticPrivilege) {
    // 不受（已确认的）分析权限保护：无需检测授权数，记一条通过项
    checks.push({
      item: '分析权限',
      required: '视图启用分析权限校验（checkAnalyticPrivileges=true）时检测 ANALYTICAL_PRIVILEGE 授权',
      passed: true,
      detail: declaredAnalyticPrivilege
        ? '视图声明了 applyPrivilegeType=ANALYTIC_PRIVILEGE 但未启用校验（checkAnalyticPrivileges≠true）：不按「受保护」处置，不检测授权数'
        : '无需分析权限',
    });
    return declaredAnalyticPrivilege
      ? { kind: 'unprotected', declaredApplyPrivilegeType: applyPrivilegeType }
      : { kind: 'unprotected' };
  }

  // 查当前用户被授予的 ANALYTICAL_PRIVILEGE 条数（EFFECTIVE_PRIVILEGES 含角色继承的）
  try {
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
       WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'ANALYTICAL_PRIVILEGE'`,
    );
    const grantedCount = rows[0]?.C ?? 0;
    // grantedCount === 0 且视图受保护 → 高度疑似缺分析权限（最终以运行时探测为准）
    const passed = grantedCount > 0;
    const detail = passed
      ? `受分析权限保护，已授予 ${grantedCount} 条 ANALYTICAL_PRIVILEGE`
      : `受分析权限保护，但当前用户未被授予任何 ANALYTICAL_PRIVILEGE（0 条）——schema SELECT 无法替代`;
    checks.push({
      item: '分析权限',
      required: 'ANALYTICAL_PRIVILEGE 授权（视图 checkAnalyticPrivileges=true）',
      passed,
      detail,
    });
    return {
      kind: 'protected',
      status: {
        protectedByAnalyticPrivilege: true,
        applyPrivilegeType,
        checkAnalyticPrivileges,
        grantedCount,
        passed,
        detail,
      },
    };
  } catch (e) {
    // 查不到授权信息时无法判定，不阻断（运行时探测兜底）；grantedCount **缺省**——不写 0（评审 #1118）
    logger.warn({ packageId, objectName, err: e }, '无法查询 ANALYTICAL_PRIVILEGE 授权数（降级为运行时探测兜底）');
    const detail = '受分析权限保护，但无法查询授权情况（运行时探测兜底判定）';
    checks.push({ item: '分析权限', required: 'ANALYTICAL_PRIVILEGE 授权', passed: true, detail });
    return {
      kind: 'protected',
      status: { protectedByAnalyticPrivilege: true, applyPrivilegeType, checkAnalyticPrivileges, passed: true, detail },
    };
  }
}
