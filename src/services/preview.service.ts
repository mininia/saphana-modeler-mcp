import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { assertSafeRuntimeName, quoteIdentifier, quoteLiteral, qualifyName } from '../core/sql.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import type { ViewKind } from '../model/view-types.js';
import { deriveNodeSql } from './preview.derive.js';
import { diagnosePreview, runtimeViewExists, type PreviewChannel } from './preview-diagnose.service.js';

/**
 * hana_data_preview 数据预览。支持范围有限；
 * **凡不支持即直接返回「不支持」，不做其他尝试/回退。**
 *
 * 三种路径：
 * - 默认（无 node）：对已激活视图整体预览 —— `SELECT * FROM "_SYS_BIC"."包/视图名"`，
 *   无需解析 XML；VIRTUAL 视图用 parameters 传输入参数（WITH PARAMETERS PLACEHOLDER）。
 * - 节点（有 node，默认）：调用 HANA 原生机制 `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV`
 *   （HANA Studio 节点预览同款）——HANA 为指定节点生成 SQL 虚拟视图，用完按占用情况释放。
 *   类型/连接键/表达式由 HANA 自身计算，任意节点类型均支持。需 EXECUTE 权限；缺权限直接返回「不支持」。
 * - 节点（有 node + forceDerive=true，显式启用）：XML 推导只读模式（preview.derive.ts），
 *   支持类型受限（见文档），不自动启用。
 *
 * 中间视图命名与生命周期（确定性命名 + 复用 + 有条件释放）：
 * - 视图名固定为 `<包路径/对象名>/dp/<节点名>`（见 intermediateViewName），人工可在 _SYS_BIC 中直接定位；
 * - 创建前先查 SYS.VIEWS：已存在则**不重复创建**，直接复用（并发调用、上次残留、他人建的都走这条）；
 * - 释放时先判断占用：本进程内还有调用在用、或视图非本服务创建 → 保留；无人占用才 DROP；
 *   DROP 失败（本进程外的会话正在读）同样保留，交由下次调用复用。
 *   注意：复用不校验视图新鲜度——CV 在视图创建后被重新激活时，同名视图仍是旧定义，
 *   结果里以 `intermediate.reused` 如实回报，需要最新数据时先删掉该视图或改用 forceDerive。
 *
 * 行数规则：无筛选默认 10 行，有筛选默认 100 行；显式 limit 上限 1000。
 * 截断判定：多取 1 行探测是否还有更多（LIMIT n+1 → truncated）。
 */
export interface PreviewFilter {
  column: string;
  op: '=' | '!=' | '<' | '<=' | '>' | '>=' | 'LIKE';
  value: string | number;
}

export interface PreviewOptions {
  kind?: ViewKind;
  /** 目标节点 ID（如 Projection_1/Join_1/Aggregation_1）；省略 = 视图整体预览 */
  node?: string;
  /** 筛选条件（AND 连接，值参数绑定）；提供时默认 limit 100，否则 10 */
  filter?: PreviewFilter[];
  /** VIRTUAL 视图输入参数（WITH PARAMETERS PLACEHOLDER）；仅直接预览路径有效 */
  parameters?: Record<string, string>;
  limit?: number;
  /** 强制走 XML 推导（跳过中间视图主路径），默认自动 */
  forceDerive?: boolean;
}

export interface PreviewResult {
  object: { packageId: string; objectName: string; objectSuffix?: string };
  /** 目标节点 */
  node?: string;
  nodeType?: string;
  /** 预览通道：direct（整体直查）/ intermediate（HANA 中间视图）/ derived（XML 推导） */
  via?: 'direct' | 'intermediate' | 'derived';
  /** 结果列名 */
  columns: string[];
  rows: Record<string, unknown>[];
  limit: number;
  /** rows.length === limit 且还有更多时为 true */
  truncated: boolean;
  /** 实际执行的 SQL（调试/审计用） */
  sql: string;
  /** 中间视图通道的视图信息（其余通道无此字段） */
  intermediate?: IntermediateViewInfo;
}

/** 节点预览中间视图的命名与生命周期回报 */
export interface IntermediateViewInfo {
  /** 确定性视图名：`<包路径/对象名>/dp/<节点名>`（位于 _SYS_BIC） */
  viewName: string;
  /** true = 已存在同名视图，本次未执行创建（复用） */
  reused: boolean;
  /** true = 预览结束后已 DROP */
  dropped: boolean;
  /** dropped=false 时说明保留原因 */
  keptBecause?: string;
}

const MAX_LIMIT = 1000;
const OPS = new Set(['=', '!=', '<', '<=', '>', '>=', 'LIKE']);
/** 输入参数名允许字符集（WITH PARAMETERS 内是字面量，仍做纵深防御） */
const PARAM_NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** 中间视图：VERSION=0（Repo1 经典仓库）/1（HDI） */
const INTERMEDIATE_VERSION = 0;
/** 中间视图所在 schema */
const INTERMEDIATE_SCHEMA = '_SYS_BIC';
/** HANA 标识符长度上限（SQL Reference）；超限提前给可读错误，而非让 CREATE 抛晦涩语法错 */
const MAX_IDENTIFIER_LEN = 127;

/**
 * 节点预览中间视图名：`<包路径/对象名>/dp/<节点名>`（确定性命名，与 _SYS_BIC 里 CV 运行时对象同名风格）。
 * 确定性命名带来「可人工定位」与「可直接复用」，代价是名字与 CV+节点一一对应 —— 见文件头关于新鲜度的说明。
 * 节点名按运行时名白名单校验（不做字符替换：替换会让不同节点名映射到同一视图，进而串数据）。
 */
function intermediateViewName(viewRef: string, node: string): string {
  assertSafeRuntimeName(node, '节点名');
  const name = `${viewRef}/dp/${node}`;
  if (name.length > MAX_IDENTIFIER_LEN) {
    throw new HanaBusinessError(
      `节点预览视图名过长（${name.length} > ${MAX_IDENTIFIER_LEN} 字符）：${name}。` +
        `可改用显式 forceDerive=true 的 XML 推导模式预览该节点`,
    );
  }
  return name;
}

/** 中间视图占用/归属状态的操作锁 key（与写路径的 "包/对象" key 命名空间隔离） */
function intermediateLockKey(viewName: string): string {
  return `dp:${viewName}`;
}

/** 视图名 → 本进程内正在使用该中间视图的预览调用数 */
const intermediateInUse = new Map<string, number>();
/** 本服务创建过（因而有权清理）的中间视图名；预存在的他人对象不入册 → 释放时不动 */
const intermediateOwned = new Set<string>();

export async function previewData(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: PreviewOptions = {},
): Promise<PreviewResult> {
  // 包名/对象名字符集校验（纵深防御；值一律参数绑定）
  assertSafeRuntimeName(packageId, '包名');
  assertSafeRuntimeName(objectName, '对象名');
  const limit = Math.min(Math.max(opts.limit ?? (opts.filter && opts.filter.length > 0 ? 100 : 10), 1), MAX_LIMIT);

  // 节点预览：默认仅走 HANA 中间视图；缺权限直接返回「不支持」（不自动回退其他尝试）
  if (opts.node) {
    if (opts.parameters) {
      throw new HanaBusinessError(
        '节点预览暂不支持输入参数（parameters）；可去掉 node 对视图整体预览（VIRTUAL 视图变量在直接预览时传入）',
      );
    }
    if (opts.forceDerive) {
      // 显式启用的只读 XML 推导模式
      return withPermissionDiagnosis(pool, packageId, objectName, opts.kind, 'derived', () =>
        previewNodeViaDerivation(pool, packageId, objectName, opts, limit),
      );
    }
    // 前置权限检查 + 中间视图预览整体包在诊断包装内：任一权限类失败自动定位阻塞点
    return withPermissionDiagnosis(pool, packageId, objectName, opts.kind, 'intermediate', async () => {
      // 前置权限检查：无 EXECUTE 直接提示无权限，不尝试 CREATE
      if (!(await hasIntermediatePermission(pool))) {
        throw new HanaBusinessError(
          `无权限：当前用户缺少 SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV 的执行权限，无法进行节点预览。` +
            `可授予 EXECUTE 后重试，或显式 forceDerive=true 使用只读推导模式`,
        );
      }
      try {
        return await previewNodeViaIntermediate(pool, packageId, objectName, opts, limit);
      } catch (e) {
        if (isPermissionError(e)) {
          // 泛化提示（失败可能是中间视图创建/查询任一步骤的授权问题），保留原始错误码供诊断（envelope.raw）
          throw new HanaBusinessError(
            `无权限：节点预览被拒绝（缺少中间视图创建或查询所需权限/相关授权）。` +
              `可授予 EXECUTE on SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV 后重试，或显式 forceDerive=true 使用只读推导模式`,
            e instanceof HanaBusinessError ? e.code : undefined,
            e instanceof HanaBusinessError ? e.sqlState : undefined,
          );
        }
        throw e;
      }
    });
  }

  // 直接路径：已激活视图运行时对象（包层级用 . 分隔）
  let base = `SELECT * FROM ${qualifyName('_SYS_BIC', `${packageId}/${objectName}`)}`;
  if (opts.parameters) base += ` WITH PARAMETERS (${buildParameters(opts.parameters)})`;
  const where = buildWhere(opts.filter);
  const sql = `${base}${where.clause} LIMIT ?`;
  const rows = await withPermissionDiagnosis(pool, packageId, objectName, opts.kind, 'direct', () =>
    pool.query<Record<string, unknown>>(sql, [...where.params, limit + 1]),
  );
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    object: { packageId, objectName, objectSuffix: opts.kind },
    node: opts.node,
    via: 'direct',
    columns: sliced[0] ? Object.keys(sliced[0]) : [],
    rows: sliced,
    limit,
    truncated,
    sql,
  };
}

/**
 * 预览失败时若为**权限类**错误，自动运行权限诊断并把报告附到错误上（经 envelope.raw.diagnosis 透传给调用方）。
 * 仅权限类失败诊断（参数非法/语法错误/对象不存在等不触发，避免无谓查询与噪声）。
 * 诊断自身若失败，静默回退到原始错误（不掩盖原错、不阻断调用）。
 */
async function withPermissionDiagnosis<T>(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  kind: ViewKind | undefined,
  channel: PreviewChannel,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (!shouldAutoDiagnose(e)) throw e;
    try {
      const diagnosis = await diagnosePreview(pool, packageId, objectName, {
        kind,
        channel,
        verbose: true, // 自动诊断走完整模式（envelope.raw.diagnosis 需要完整 blockers/hints 供排障）
        triggeredBy: {
          code: e instanceof HanaBusinessError ? e.code : undefined,
          message: e instanceof Error ? e.message : String(e),
        },
      });
      // 重新抛出带诊断的错误（保留原 message/code/sqlState/messages）
      if (e instanceof HanaBusinessError) {
        throw new HanaBusinessError(e.message, e.code, e.sqlState, e.messages, diagnosis);
      }
      throw new HanaBusinessError(e instanceof Error ? e.message : String(e), undefined, undefined, [], diagnosis);
    } catch (rethrow) {
      // 诊断失败：抛原始错误（若 rethrow 已是带诊断的新错误则用它，否则回退原始 e）
      if (rethrow === e || !(rethrow instanceof HanaBusinessError) || !rethrow.diagnosis) throw e;
      throw rethrow;
    }
  }
}

/**
 * 节点预览主路径：HANA 原生中间视图（Studio 节点预览同款机制）。
 * CALL CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV(schema, view, node, view_name, version=0)
 * → SELECT * FROM "_SYS_BIC"."<包/对象/dp/节点>" → 按占用情况释放（见 release）。
 *
 * 取用与释放都在同一把 keyed lock 内完成（key=视图名），保证「创建 / 复用 / 占用计数 / 释放」
 * 这一组操作对同一视图严格串行：
 * - 两个并发调用不会同时判定「不存在」而重复 CREATE（后者会因对象已存在失败）；
 * - 也不会出现「A 释放并 DROP 的瞬间 B 刚判定复用」——B 要么在 A 之前登记占用（A 遂不删），
 *   要么在 A 删除之后进入（判定不存在 → 自行创建）。
 */
async function previewNodeViaIntermediate(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: PreviewOptions,
  limit: number,
): Promise<PreviewResult> {
  const node = opts.node!;
  const viewRef = `${packageId}/${objectName}`;
  const viewName = intermediateViewName(viewRef, node);

  // 取用：已存在（并发刚建的 / 上次残留 / 他人建的）则跳过创建，直接复用
  let reused = false;
  await withKeyedLock(intermediateLockKey(viewName), async () => {
    if (await runtimeViewExists(pool, viewName)) {
      reused = true;
    } else {
      await pool.execute(`CALL SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV(?, ?, ?, ?, ?)`, [
        INTERMEDIATE_SCHEMA,
        viewRef,
        node,
        viewName,
        INTERMEDIATE_VERSION,
      ]);
      intermediateOwned.add(viewName); // 本服务创建的才可清理（预存在的他人对象不在此列）
    }
    intermediateInUse.set(viewName, (intermediateInUse.get(viewName) ?? 0) + 1);
  });

  let rows: Record<string, unknown>[];
  let sql: string;
  let release: { dropped: boolean; reason?: string };
  try {
    const where = buildWhere(opts.filter);
    sql = `SELECT * FROM ${qualifyName(INTERMEDIATE_SCHEMA, viewName)}${where.clause} LIMIT ?`;
    rows = await pool.query<Record<string, unknown>>(sql, [...where.params, limit + 1]);
  } finally {
    // 无论成败都解除占用（失败路径下由释放策略决定是否清理）
    release = await releaseIntermediateView(pool, viewName);
  }
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    object: { packageId, objectName, objectSuffix: opts.kind },
    node,
    via: 'intermediate',
    columns: sliced[0] ? Object.keys(sliced[0]) : [],
    rows: sliced,
    limit,
    truncated,
    sql,
    intermediate: {
      viewName,
      reused,
      dropped: release.dropped,
      ...(release.dropped ? {} : { keptBecause: release.reason }),
    },
  };
}

/**
 * 释放中间视图：仅当「本进程已无调用占用」且「由本服务创建」时才 DROP。
 * 保留的三种情形（均不报错、不影响本次预览结果）：
 * - 本进程内还有并发调用在用（引用计数 > 0）
 * - 视图非本服务创建（他人 / 上一次进程的残留）→ 误删他人对象风险，宁可留着
 * - DROP 失败：本进程之外的会话（如 HANA Studio）正在读该视图而占用锁 → 交由下次调用复用
 * 与取用共用同一把锁：保证不会在「刚判定无人占用」之后、DROP 之前被新调用复用。
 */
async function releaseIntermediateView(
  pool: HanaPool,
  viewName: string,
): Promise<{ dropped: boolean; reason?: string }> {
  return withKeyedLock(intermediateLockKey(viewName), async () => {
    const remaining = (intermediateInUse.get(viewName) ?? 1) - 1;
    if (remaining > 0) {
      intermediateInUse.set(viewName, remaining);
      return { dropped: false, reason: `仍有 ${remaining} 个预览调用在使用该视图` };
    }
    intermediateInUse.delete(viewName);
    if (!intermediateOwned.has(viewName)) {
      return { dropped: false, reason: '视图非本服务创建（他人或历史残留），不主动删除' };
    }
    try {
      await pool.execute(`CALL SYS.DROP_INTERMEDIATE_CALCULATION_VIEW_DEV(?, ?, ?)`, [
        INTERMEDIATE_SCHEMA,
        viewName,
        INTERMEDIATE_VERSION,
      ]);
      intermediateOwned.delete(viewName);
      return { dropped: true };
    } catch {
      // 占用中（其他会话正在读）或权限不足：保留视图供下次复用（清理失败不得掩盖原始错误）
      return { dropped: false, reason: '视图正被其他会话占用或 DROP 被拒绝，已保留供后续复用' };
    }
  });
}

/** 节点预览 fallback：XML 推导（无 SYS 过程 EXECUTE 权限时的只读替代） */
async function previewNodeViaDerivation(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: PreviewOptions,
  limit: number,
): Promise<PreviewResult> {
  const result = await viewDefinitionCache.get(pool, packageId, objectName, { kind: opts.kind });
  if (!result.definition) {
    throw new HanaBusinessError(`视图 ${packageId}/${objectName} 无 CDATA，无法推导节点预览`);
  }
  const derived = deriveNodeSql(result.definition, opts.node!);
  const where = buildWhere(opts.filter);
  const sql = `SELECT * FROM (${derived.sql}) AS "PREVIEW"${where.clause} LIMIT ?`;
  const rows = await pool.query<Record<string, unknown>>(sql, [...where.params, limit + 1]);
  const truncated = rows.length > limit;
  const sliced = truncated ? rows.slice(0, limit) : rows;
  return {
    object: { packageId, objectName, objectSuffix: opts.kind },
    node: opts.node,
    nodeType: derived.nodeType,
    via: 'derived',
    columns: derived.columns,
    rows: sliced,
    limit,
    truncated,
    sql,
  };
}

/** 是否为权限类错误（缺 EXECUTE/授权）→ 映射为「无权限」提示 */
function isPermissionError(e: unknown): boolean {
  if (e instanceof HanaBusinessError) {
    const msg = e.message;
    // 含本服务自有「无权限：」前缀（前置权限检查/中间视图失败归一化），或 HANA 权限类消息/错误码
    if (/not authorized|insufficient privilege|is not authorized|无权限/i.test(msg)) return true;
    if (e.code === '10' || e.code === '2950') return true;
    return false;
  }
  const msg = e instanceof Error ? e.message : String(e);
  return /not authorized|insufficient privilege|无权限/i.test(msg);
}

/**
 * 是否应自动触发权限诊断：权限类错误 + HANA 访问类错误码（258=无效表名 / 259=对象不存在）。
 * 后两者在 _SYS_BIC 预览语境下常是「缺 SELECT → 运行时对象对当前用户不可见」的伪装形态
 * （HANA 对无权访问的对象倾向返回 259 而非权限码），纳入诊断避免漏掉这类隐蔽根因。
 * 诊断报告自身会区分「真缺失权限」与「对象确实未激活/不存在」，给出准确结论。
 */
function shouldAutoDiagnose(e: unknown): boolean {
  if (isPermissionError(e)) return true;
  if (e instanceof HanaBusinessError && (e.code === '258' || e.code === '259')) return true;
  return false;
}

/** 前置权限检查：当前用户是否有 SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV 等中间视图过程的 EXECUTE */
async function hasIntermediatePermission(pool: HanaPool): Promise<boolean> {
  const rows = await pool.query<{ C: number }>(
    `SELECT COUNT(*) AS C FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'EXECUTE'
     AND (OBJECT_NAME LIKE 'CREATE_INTERMEDIATE_CALCULATION_VIEW%' OR OBJECT_NAME LIKE 'DROP_INTERMEDIATE_CALCULATION_VIEW%')`,
  );
  return (rows[0]?.C ?? 0) > 0;
}

/** 构建 WHERE 子句：AND 连接，列名校验 + 双引号，值参数绑定 */
function buildWhere(filter?: PreviewFilter[]): { clause: string; params: Array<string | number> } {
  if (!filter || filter.length === 0) return { clause: '', params: [] };
  const parts: string[] = [];
  const params: Array<string | number> = [];
  for (const f of filter) {
    if (!OPS.has(f.op)) throw new HanaBusinessError(`不支持的筛选操作符 "${f.op}"（支持 =/!=/</<=/>/>=/LIKE）`);
    assertSafeRuntimeName(f.column, '筛选列');
    parts.push(`${quoteIdentifier(f.column)} ${f.op} ?`);
    params.push(f.value);
  }
  return { clause: ` WHERE ${parts.join(' AND ')}`, params };
}

/** WITH PARAMETERS PLACEHOLDER（VIRTUAL 视图输入参数） */
function buildParameters(parameters: Record<string, string>): string {
  return Object.entries(parameters)
    .map(([k, v]) => {
      if (!PARAM_NAME_RE.test(k)) throw new HanaBusinessError(`输入参数名 "${k}" 含非法字符`);
      return `'PLACEHOLDER' = (${quoteLiteral(`$$${k}$$`)}, ${quoteLiteral(v)})`;
    })
    .join(', ');
}
