import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError, normalizeHanaError } from '../core/errors.js';
import { isSchemaAllowed, qualifyName } from '../core/sql.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import { VIEW_SUFFIXES } from './metadata.service.js';
import type { ViewDefinition, ViewKind } from '../model/view-types.js';

/**
 * 数据预览权限诊断服务。
 *
 * 触发场景：hana_data_preview 失败且判定为权限类错误（not authorized / insufficient privilege /
 * HANA 错误码 7/258/2950）时，由 preview.service 自动调用本服务定位阻塞点；也可经
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

export type PreviewChannel = 'direct' | 'intermediate' | 'derived';

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
  /** 当前 CV 是否受经典分析权限保护 */
  analyticPrivilege: {
    protected: boolean;
    /** 设计时 applyPrivilegeType 原值（如 ANALYTIC_PRIVILEGE / NONE） */
    applyPrivilegeType?: string;
    /** 当前用户被授予的 ANALYTICAL_PRIVILEGE 条数 */
    grantedCount: number;
  };
  /** 运行时对象（当前 CV）实测是否可达 */
  runtimeAccessible: boolean;
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
  /** 视图是否受分析权限保护（applyPrivilegeType=ANALYTIC_PRIVILEGE 或 checkAnalyticPrivileges=true） */
  protectedByAnalyticPrivilege: boolean;
  /** 设计时 XML 的 applyPrivilegeType 原值 */
  applyPrivilegeType?: string;
  /** 设计时 XML 的 checkAnalyticPrivileges 原值 */
  checkAnalyticPrivileges?: boolean;
  /** 当前用户被授予的 ANALYTICAL_PRIVILEGE 条数 */
  grantedCount: number;
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
  /** 运行时视图 _SYS_BIC."包/视图" 是否存在（仅 direct/intermediate 通道检查） */
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
  let runtimeViewExists: boolean | undefined;
  if (opts.channel === 'direct' || opts.channel === 'intermediate') {
    runtimeViewExists = await checkRuntimeViewExists(pool, packageId, objectName);
    if (runtimeViewExists === false && activation.activated) {
      blockers.push(`运行时视图 "_SYS_BIC"."${packageId}/${objectName}" 不存在，但设计时对象已激活（激活可能失败或运行时未生成）`);
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
      baseTables = await checkBaseTables(pool, packageId, objectName, opts.kind, checks, blockers, hints);
    }
  }

  // 4. 分析权限检测：视图受分析权限保护时，schema SELECT 通过 ≠ 可查询（BW on HANA 常见根因）。
  //    读设计时 XML 的 applyPrivilegeType/checkAnalyticPrivileges，并查当前用户被授予的 ANALYTICAL_PRIVILEGE 条数。
  //    BW 视图几乎都 checkAnalyticPrivileges=true，故对所有通道都检测（避免漏判 direct/intermediate 的隐蔽阻塞）。
  //    精简模式仍需检测（brief 要结论），但不写 checks 明细/blockers/hints（那些属于 verbose 产物）。
  const analyticPrivilege = await checkAnalyticPrivilege(pool, packageId, objectName, opts.kind, verbose ? checks : []);
  if (verbose && analyticPrivilege && !analyticPrivilege.passed) {
    blockers.push(
      `视图受分析权限保护（applyPrivilegeType=${analyticPrivilege.applyPrivilegeType ?? 'ANALYTIC_PRIVILEGE'}, ` +
        `checkAnalyticPrivileges=${analyticPrivilege.checkAnalyticPrivileges}）但当前用户未被授予任何 ANALYTICAL_PRIVILEGE（${analyticPrivilege.grantedCount} 条）。` +
        `HANA 的 schema SELECT 不能替代分析权限——这是 BW on HANA 预览失败最常见的根因`,
    );
    hints.push('由 BW 管理员在 BW 侧分配覆盖该视图的分析权限对象（含对应 InfoProvider/Query 授权）；HANA 层 GRANT SELECT 无法替代');
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
    // verbose 模式：上游清单在第 3 步 checkBaseTables 已填，这里只从其派生不可达清单 + 写 blockers/hints
    if (baseTables) {
      upstreamInaccessible = baseTables
        .filter((b) => !b.selectable)
        .map((b) => ({ table: b.table, type: b.type, code: b.code, message: b.message }));
    }
    if (runtimeProbe && !runtimeProbe.accessible) {
      blockers.push(
        `运行时对象实测不可访问：SELECT 探测失败${runtimeProbe.code ? `（错误码 ${runtimeProbe.code}）` : ''}：${runtimeProbe.message ?? '未知错误'}`,
      );
      // 错误码 258/2950 = insufficient privilege，结合分析权限结果给出针对性指引
      if (runtimeProbe.code === '258' || runtimeProbe.code === '2950' || /not authorized|insufficient privilege/i.test(runtimeProbe.message ?? '')) {
        if (analyticPrivilege?.protectedByAnalyticPrivilege) {
          hints.push('错误码 258/2950 + 视图受分析权限保护 → 确认为分析权限缺失（非 schema SELECT 问题），需在 BW 侧补分析权限授权');
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
  const apBlocked = analyticPrivilege?.protectedByAnalyticPrivilege === true && (analyticPrivilege?.grantedCount ?? 0) === 0;
  const brief: DiagnosisBrief = {
    object: { packageId, objectName, kind: opts.kind },
    channel: opts.channel,
    analyticPrivilege: {
      protected: analyticPrivilege?.protectedByAnalyticPrivilege ?? false,
      applyPrivilegeType: analyticPrivilege?.applyPrivilegeType,
      grantedCount: analyticPrivilege?.grantedCount ?? 0,
    },
    runtimeAccessible: runtimeOk,
    upstreamInaccessible,
    // canPreview 判定：运行时实测可达（金标准）且无上游不可达。
    // 分析权限「推断未授权」仅在运行时实测也不可达时才计入阻断（实测可达则以其为准，不阻断）。
    canPreview: runtimeOk && !upstreamBlocked && !(apBlocked && !runtimeOk),
  };

  return {
    object: { packageId, objectName, kind: opts.kind },
    channel: opts.channel,
    viewActivation: activation,
    runtimeViewExists,
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
  const suffixes = kind ? [VIEW_SUFFIXES[kind]] : Object.values(VIEW_SUFFIXES);
  const ph = suffixes.map(() => '?').join(',');
  try {
    const active = await pool.query<{ OBJECT_SUFFIX: string; VERSION_ID: number }>(
      `SELECT OBJECT_SUFFIX, VERSION_ID FROM "_SYS_REPO"."ACTIVE_OBJECT"
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN (${ph})
       ORDER BY VERSION_ID DESC LIMIT 1`,
      [packageId, objectName, ...suffixes],
    );
    if (active[0]) {
      return { exists: true, activated: true, versionId: active[0].VERSION_ID, objectSuffix: active[0].OBJECT_SUFFIX };
    }
    const inactive = await pool.query<{ OBJECT_SUFFIX: string }>(
      `SELECT OBJECT_SUFFIX FROM "_SYS_REPO"."INACTIVE_OBJECT"
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX IN (${ph}) LIMIT 1`,
      [packageId, objectName, ...suffixes],
    );
    if (inactive[0]) {
      return { exists: true, activated: false, objectSuffix: inactive[0].OBJECT_SUFFIX };
    }
    return { exists: false, activated: false };
  } catch {
    return { exists: false, activated: false, detail: '无法读取 _SYS_REPO（可能缺少 _SYS_REPO 的 SELECT 权限）' };
  }
}

/** 运行时视图 _SYS_BIC."包/视图" 是否存在 */
async function checkRuntimeViewExists(pool: HanaPool, packageId: string, objectName: string): Promise<boolean> {
  try {
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM SYS.VIEWS WHERE SCHEMA_NAME = '_SYS_BIC' AND VIEW_NAME = ?`,
      [`${packageId}/${objectName}`],
    );
    return (rows[0]?.C ?? 0) > 0;
  } catch {
    return false;
  }
}

/** 当前用户对某 schema 是否有 SELECT（EFFECTIVE_PRIVILEGES） */
async function hasSchemaSelect(pool: HanaPool, schema: string): Promise<boolean> {
  const rows = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND SCHEMA_NAME = ? AND PRIVILEGE = 'SELECT'`,
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

/** 检查 SYS 下过程 EXECUTE 并记录 */
async function checkProcedureExecute(
  pool: HanaPool,
  procName: string,
  checks: DiagnosisCheck[],
  blockers: string[],
  hints: string[],
): Promise<void> {
  const rows = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'EXECUTE' AND SCHEMA_NAME = 'SYS' AND OBJECT_NAME = ?`,
    [procName],
  );
  const ok = (rows[0]?.C ?? 0) > 0;
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

/** derived 通道：解析视图 XML，追溯全部叶子数据源并逐个校验访问性 */
async function checkBaseTables(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
  checks: DiagnosisCheck[],
  blockers: string[],
  hints: string[],
): Promise<BaseTableAccess[]> {
  let def: ViewDefinition | undefined;
  try {
    const result = await viewDefinitionCache.get(pool, packageId, objectName, { kind });
    def = result.definition;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    checks.push({ item: '解析视图 XML', required: '读取并解析 _SYS_REPO 设计时 XML', passed: false, detail: `失败：${msg}` });
    blockers.push(`无法读取/解析视图 XML，derived 通道无法追溯基表：${msg}`);
    hints.push('确认 _SYS_REPO 读权限与视图已激活；脚本节点（SqlScriptView）derived 通道本就不支持');
    return [];
  }
  if (!def) {
    checks.push({ item: '解析视图 XML', required: '视图存在 CDATA', passed: false, detail: '视图无 CDATA' });
    blockers.push('视图无 CDATA（设计时 XML 为空），derived 通道无法追溯基表');
    return [];
  }
  checks.push({
    item: '解析视图 XML',
    required: '读取并解析 _SYS_REPO 设计时 XML',
    passed: true,
    detail: `解析成功（${def.dataSources.length} 个数据源）`,
  });

  const leaves = collectLeafDataSources(def);
  const result: BaseTableAccess[] = [];
  for (const ds of leaves) {
    if (ds.type === 'DATA_BASE_TABLE' && ds.schemaName && ds.columnObjectName) {
      // BW on HANA：XML 中 schemaName="ABAP" 是源系统名，真实表在 SAPABAP1（与 preview.derive.leafSql 一致）
      const schema = ds.schemaName === 'ABAP' ? 'SAPABAP1' : ds.schemaName;
      const allowed = isSchemaAllowed(schema);
      let selectable = false;
      let detail: string;
      if (!allowed) {
        detail = `schema ${schema} 不在白名单（系统 schema 或 HANA_SCHEMA_ALLOW 配置）`;
        blockers.push(`基表 ${schema}.${ds.columnObjectName} 不可访问：${detail}`);
        hints.push(`在 .env / mcp.json 设置 HANA_SCHEMA_ALLOW=${schema} 追加允许的 schema`);
      } else {
        selectable = await hasSchemaSelect(pool, schema);
        detail = selectable ? '已授予' : '缺失';
        if (!selectable) {
          blockers.push(`基表 ${schema}.${ds.columnObjectName} 缺少 SELECT 权限`);
          hints.push(`GRANT SELECT ON ${schema}.${ds.columnObjectName} TO "<user>";`);
        }
      }
      pushBaseTable(result, { schema, table: ds.columnObjectName, type: 'DATA_BASE_TABLE', selectable: selectable && allowed, detail });
    } else if (ds.type === 'CALCULATION_VIEW' && ds.resourceUri) {
      // resourceUri 形如 /包路径/calculationviews/对象名 → _SYS_BIC."包路径/对象名"（与 preview.derive.leafSql 一致）
      const m = /^\/(.+)\/calculationviews\/([^/]+)$/.exec(ds.resourceUri);
      if (m) {
        const pkg = m[1];
        const name = m[2];
        // 实测可达性优先于 schema SELECT 名义检查：BW Query 等受分析权限保护的对象，
        // schema SELECT 通过但仍可能不可查。直接探测 SELECT 1 才是金标准。
        const probe = await probeRuntimeAccess(pool, pkg, name);
        const selectable = probe.accessible;
        const detail = selectable ? '实测可达' : `实测不可达${probe.code ? `(${probe.code})` : ''}：${probe.message ?? ''}`;
        if (!selectable) {
          blockers.push(`引用的上游对象 ${pkg}/${name} 实测不可访问：${probe.message ?? '未知错误'}${probe.code ? `（错误码 ${probe.code}）` : ''}`);
          hints.push(`上游对象不可访问多为分析权限缺失（BW Query/受保护 CV）；检查该对象是否受分析权限保护并补授权，或排查其上游链`);
        }
        pushBaseTable(result, {
          schema: '_SYS_BIC', table: `${pkg}/${name}`, type: 'CALCULATION_VIEW', selectable, detail,
          code: selectable ? undefined : probe.code, message: selectable ? undefined : probe.message,
        });
      }
    }
  }
  return result;
}

/**
 * 上游实测（精简模式）：解析视图 XML 叶子数据源并实测每个上游对象可达性，
 * 仅返回可达性清单 + 不可达清单（不写 checks/blockers/hints 明细，那些是 verbose 产物）。
 * 基表（DATA_BASE_TABLE）按 schema 白名单 + SELECT 名义检查；外部 CV（CALCULATION_VIEW）实测 SELECT 1。
 * 探测并行（Promise.all）：上游数可达十几个，串行往返会成倍拖慢；连接池满时自动排队复用。
 */
async function probeUpstream(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
): Promise<{ baseTables: BaseTableAccess[]; inaccessible: DiagnosisBrief['upstreamInaccessible'] }> {
  let def: ViewDefinition | undefined;
  try {
    const result = await viewDefinitionCache.get(pool, packageId, objectName, { kind });
    def = result.definition;
  } catch {
    return { baseTables: [], inaccessible: [] };
  }
  if (!def) return { baseTables: [], inaccessible: [] };

  const leaves = collectLeafDataSources(def);
  // 并行探测所有叶子（连接池满时自动排队复用，远快于串行往返）
  const probed = await Promise.all(
    leaves.map(async (ds): Promise<BaseTableAccess | null> => {
      if (ds.type === 'DATA_BASE_TABLE' && ds.schemaName && ds.columnObjectName) {
        const schema = ds.schemaName === 'ABAP' ? 'SAPABAP1' : ds.schemaName;
        const allowed = isSchemaAllowed(schema);
        const selectable = allowed && (await hasSchemaSelect(pool, schema));
        return {
          schema, table: ds.columnObjectName, type: 'DATA_BASE_TABLE', selectable,
          detail: selectable ? '已授予' : allowed ? 'SELECT 缺失' : `schema ${schema} 不在白名单`,
        };
      }
      if (ds.type === 'CALCULATION_VIEW' && ds.resourceUri) {
        const m = /^\/(.+)\/calculationviews\/([^/]+)$/.exec(ds.resourceUri);
        if (m) {
          const pkg = m[1];
          const name = m[2];
          const probe = await probeRuntimeAccess(pool, pkg, name);
          return {
            schema: '_SYS_BIC', table: `${pkg}/${name}`, type: 'CALCULATION_VIEW', selectable: probe.accessible,
            detail: probe.accessible ? '实测可达' : `实测不可达${probe.code ? `(${probe.code})` : ''}`,
            code: probe.accessible ? undefined : probe.code, message: probe.accessible ? undefined : probe.message,
          };
        }
      }
      return null;
    }),
  );

  // 按原叶子顺序组装（去重），保证结果稳定
  const baseTables: BaseTableAccess[] = [];
  const inaccessible: DiagnosisBrief['upstreamInaccessible'] = [];
  for (const item of probed) {
    if (!item) continue;
    const existed = baseTables.some((x) => `${x.schema}.${x.table}` === `${item.schema}.${item.table}`);
    if (existed) continue;
    baseTables.push(item);
    if (!item.selectable) {
      inaccessible.push({ table: item.table, type: item.type, code: item.code, message: item.message });
    }
  }
  return { baseTables, inaccessible };
}

/** 视图叶子数据源（基表 + 外部计算视图） */
function collectLeafDataSources(def: ViewDefinition): { type: string; schemaName?: string; columnObjectName?: string; resourceUri?: string }[] {
  return def.dataSources.filter((d) => d.type === 'DATA_BASE_TABLE' || d.type === 'CALCULATION_VIEW');
}

/** 基表去重（按 schema.table，保留首个） */
function pushBaseTable(arr: BaseTableAccess[], item: BaseTableAccess): void {
  const key = `${item.schema}.${item.table}`;
  if (!arr.some((x) => `${x.schema}.${x.table}` === key)) arr.push(item);
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
 * 分析权限检测：读设计时 XML 的 applyPrivilegeType / checkAnalyticPrivileges，并查当前用户被授予的
 * ANALYTICAL_PRIVILEGE 条数。BW 视图几乎都 checkAnalyticPrivileges=true，schema SELECT 无法替代分析权限。
 * @returns 受保护且有明确判定时返回状态；无法读取 XML 或不受保护时返回 undefined（不阻断）
 */
async function checkAnalyticPrivilege(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
  checks: DiagnosisCheck[],
): Promise<AnalyticPrivilegeStatus | undefined> {
  let def: ViewDefinition | undefined;
  try {
    const result = await viewDefinitionCache.get(pool, packageId, objectName, { kind });
    def = result.definition;
  } catch {
    return undefined; // 无法读 XML 时不阻断（运行时探测兜底）
  }
  if (!def) return undefined;

  const applyPrivilegeType = def.applyPrivilegeType;
  const checkAnalyticPrivileges = def.checkAnalyticPrivileges;
  const protectedByAnalyticPrivilege =
    (applyPrivilegeType != null && applyPrivilegeType.toUpperCase() === 'ANALYTIC_PRIVILEGE') ||
    checkAnalyticPrivileges === true;

  if (!protectedByAnalyticPrivilege) {
    // 不受分析权限保护：无需检测，记一条通过项
    checks.push({
      item: '分析权限',
      required: '视图不受分析权限保护（applyPrivilegeType != ANALYTIC_PRIVILEGE 且 checkAnalyticPrivileges != true）',
      passed: true,
      detail: '无需分析权限',
    });
    return undefined;
  }

  // 查当前用户被授予的 ANALYTICAL_PRIVILEGE 条数（EFFECTIVE_PRIVILEGES 含角色继承的）
  let grantedCount = 0;
  let detail: string;
  try {
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
       WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'ANALYTICAL_PRIVILEGE'`,
    );
    grantedCount = rows[0]?.C ?? 0;
  } catch {
    // 查不到授权信息时无法判定，不阻断（运行时探测兜底）
    detail = '受分析权限保护，但无法查询授权情况（运行时探测兜底判定）';
    checks.push({ item: '分析权限', required: 'ANALYTICAL_PRIVILEGE 授权', passed: true, detail });
    return {
      protectedByAnalyticPrivilege: true,
      applyPrivilegeType,
      checkAnalyticPrivileges,
      grantedCount: 0,
      passed: true,
      detail,
    };
  }

  // grantedCount === 0 且视图受保护 → 高度疑似缺分析权限（最终以运行时探测为准）
  const passed = grantedCount > 0;
  detail = passed
    ? `受分析权限保护，已授予 ${grantedCount} 条 ANALYTICAL_PRIVILEGE`
    : `受分析权限保护，但当前用户未被授予任何 ANALYTICAL_PRIVILEGE（0 条）——schema SELECT 无法替代`;
  checks.push({
    item: '分析权限',
    required: 'ANALYTICAL_PRIVILEGE 授权（视图 applyPrivilegeType=ANALYTIC_PRIVILEGE）',
    passed,
    detail,
  });
  return {
    protectedByAnalyticPrivilege: true,
    applyPrivilegeType,
    checkAnalyticPrivileges,
    grantedCount,
    passed,
    detail,
  };
}
