import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import {
  hanaErrorMessage,
  isPermissionError,
  shouldDiagnoseAccessError,
  PREVIEW_PERMISSION_CODES,
} from '../core/hana-errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { logger } from '../core/logger.js';
import { clampLimit } from '../core/num.js';
import { assertSafeRuntimeName, assertSchemaAllowed, quoteIdentifier, quoteLiteral, qualifyName } from '../core/sql.js';
import { truncateWithNote } from '../core/text.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import type { ViewKind } from '../model/view-types.js';
import { deriveNodeSql } from './preview.derive.js';
import {
  diagnosePreview,
  hasExecutePrivilege,
  readIntermediateFreshness,
  runtimeViewExists,
  type IntermediateFreshness,
  type PreviewChannel,
} from './preview-diagnose.service.js';

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
 *   存在性查询失败（不可判定）时仍尝试创建，CREATE 撞「对象已存在」按复用继续（评审 #1111）；
 * - 释放时先判断占用：本进程内还有调用在用、或视图非本服务创建 → 保留；无人占用才 DROP；
 *   DROP 失败（本进程外的会话正在读）同样保留，交由下次调用复用。
 *   注意：复用不校验视图新鲜度——CV 在视图创建后被重新激活时，同名视图仍是旧定义，
 *   结果里以 `intermediate.reused` 如实回报，需要最新数据时先删掉该视图或改用 forceDerive。
 *
 * 行数规则：无筛选默认 10 行，有筛选默认 100 行；显式 limit 上限 1000。
 * 截断判定：多取 1 行探测是否还有更多（LIMIT n+1 → truncated）。
 */
/**
 * 筛选操作符合法值（单源）：PreviewFilter 的 op 类型、服务侧 SQL 校验与工具 schema 都从这里取，
 * 不要在别处手抄第二份。
 */
export const PREVIEW_FILTER_OPS = ['=', '!=', '<', '<=', '>', '>=', 'LIKE'] as const;
export type PreviewFilterOp = (typeof PREVIEW_FILTER_OPS)[number];

export interface PreviewFilter {
  column: string;
  op: PreviewFilterOp;
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

/** 基表勘察输入：schema + table（+ 可选列清单 / 采样行数） */
export interface TableInspectOptions {
  schema: string;
  table: string;
  /** 要勘察的列；缺省=按元数据取（上限 50 列） */
  columns?: string[];
  /** 采样行数（进入统计与样例的行数上限），默认 200，最大 2000 */
  sampleRows?: number;
  /** 筛选条件（与视图预览同语义，AND 连接、参数绑定） */
  filter?: PreviewFilter[];
}

/**
 * 单列勘察结果：**基于采样行**（不跑 COUNT(DISTINCT) 这类全表扫描——BW 大表上代价不可控）。
 * 目标是把「关联键到底长什么样」一次说清：值样例 + 长度区间 + 是否含前导零。
 */
export interface TableColumnProfile {
  name: string;
  dataType?: string;
  length?: number;
  /** 采样行中的 NULL 数 */
  nullCount: number;
  /** 采样行中的去重值数 */
  distinctInSample: number;
  /** 长度区间（采样行；仅字符型有意义） */
  minLength?: number;
  maxLength?: number;
  /** true=采样内所有非空值长度一致（补零差异排查的关键信号） */
  uniformLength?: boolean;
  /** 去重后的值样例（最多 10 个，超长值截断显示） */
  samples: string[];
  /** 含前导零的值样例（BW 体系 ID 补零差异的头号信号；无则缺省） */
  zeroPaddedSamples?: string[];
}

export interface TableInspectResult {
  table: { schema: string; table: string };
  /** 本次实际采样的行数（≤ sampleRows 且 ≤ 实际行数） */
  sampledRows: number;
  /** true = 采样达到 sampleRows 上限（表可能还有更多行） */
  truncated: boolean;
  /** 采样是否为空（表为空 / 筛选后为空 / 无 SELECT 权限时给出 error） */
  empty: boolean;
  /** 0 行时的排查提示 */
  emptyHint?: string;
  columns: TableColumnProfile[];
  /** 样例行（前若干行，便于直接看真实值形态） */
  rows: Record<string, unknown>[];
  sql: string;
  /** 采样方式说明（统计口径，避免把采样值当成全表结论） */
  samplingNote: string;
}

export interface PreviewResult {
  object: { packageId: string; objectName: string; objectSuffix?: string };
  /** 目标节点 */
  node?: string;
  nodeType?: string;
  /** 预览通道：direct（整体直查）/ intermediate（HANA 中间视图）/ derived（XML 推导） */
  via?: PreviewChannel;
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
  /**
   * 新鲜度回报（**仅复用时有**）：复用到的中间视图建于何时、源对象最近激活于何时。
   * 服务端**不据此改变行为**（复用策略是用户明确口径：存在即复用、不校验新鲜度）——
   * 只把差异摆出来，`stale=true` 时由调用方决定删视图 / 改 forceDerive / 接受旧数据。
   * 新建路径没有该字段：刚由当前定义生成，新鲜度是构造性成立的。
   */
  freshness?: IntermediateFreshness;
}

const MAX_LIMIT = 1000;
/** 服务侧操作符白名单（纵深防御：绕过工具 schema 的直接服务调用同样要校验）；取自 PREVIEW_FILTER_OPS 单源 */
const OPS: ReadonlySet<string> = new Set<string>(PREVIEW_FILTER_OPS);
/** 输入参数名允许字符集（WITH PARAMETERS 内是字面量，仍做纵深防御） */
const PARAM_NAME_RE = /^[A-Za-z0-9_.-]+$/;
/** 中间视图：VERSION=0（Repo1 经典仓库）/1（HDI） */
const INTERMEDIATE_VERSION = 0;
/** 中间视图所在 schema */
const INTERMEDIATE_SCHEMA = '_SYS_BIC';
/** HANA 标识符长度上限（SQL Reference）；超限提前给可读错误，而非让 CREATE 抛晦涩语法错 */
const MAX_IDENTIFIER_LEN = 127;
/**
 * 中间视图控制面调用（CREATE / DROP）的语句超时：这两个 CALL 一挂住就占着池位（池上限 4），
 * 不设超时会让几个请求拖垮整个工具面（评审 #1112）。控制面调用不该跑几分钟，给固定小上限。
 */
const INTERMEDIATE_CONTROL_TIMEOUT_MS = 30_000;
/** CREATE 撞「对象已存在」的错误消息特征（服务端无稳定错误码，只有消息文本；按特征识别） */
const ALREADY_EXISTS_RE = /already exists|已存在/i;

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

/**
 * LIMIT n+1 → truncated 的**统一截断判定与切片**（service 层共用的单点，勿内联复制）。
 * 各调用路径（预览三条通道、基表勘察、写路径的激活后行探测）多取 1 行后统一走这里：
 * 判定与切片分开写时，漏取一行 / 多切一行都会让 truncated 与 rows 不自洽。
 */
export function slicePage<T>(rows: T[], limit: number): { rows: T[]; truncated: boolean } {
  const truncated = rows.length > limit;
  return { rows: truncated ? rows.slice(0, limit) : rows, truncated };
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
  const limit = clampLimit(opts.limit, opts.filter && opts.filter.length > 0 ? 100 : 10, 1, MAX_LIMIT);
  // 空 parameters 对象（{}）折叠为「未传」（评审 #1113）：{} 为真值，会让直接预览拼出
  // `WITH PARAMETERS ()`（空参数列表是 HANA 语法错），也会让节点预览的无参校验误报「不支持输入参数」
  const parameters = opts.parameters && Object.keys(opts.parameters).length > 0 ? opts.parameters : undefined;

  // 节点预览：默认仅走 HANA 中间视图；缺权限直接返回「不支持」（不自动回退其他尝试）
  if (opts.node) {
    if (parameters) {
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
      // 前置权限检查：无 EXECUTE 直接提示无权限，不尝试 CREATE。
      // family 口径：一次问 CREATE_/DROP_ 中间视图过程族（过程名可能带 _DEV 等后缀）；
      // 判定唯一实现在 preview-diagnose.hasExecutePrivilege。
      if (!(await hasExecutePrivilege(pool, 'CREATE_INTERMEDIATE_CALCULATION_VIEW', 'family'))) {
        throw new HanaBusinessError(
          `无权限：当前用户缺少 SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV 的执行权限，无法进行节点预览。` +
            `可授予 EXECUTE 后重试，或显式 forceDerive=true 使用只读推导模式`,
        );
      }
      try {
        return await previewNodeViaIntermediate(pool, packageId, objectName, opts, limit);
      } catch (e) {
        if (classifyPreviewError(e).permission) {
          // 权限拒绝：节点预览主路径不可用（失败可能是中间视图创建/查询任一步骤的授权问题）。
          // 归一为泛化提示，保留原始错误码供诊断（envelope.raw）；服务端留痕便于排障
          logger.warn({ packageId, objectName, node: opts.node, err: e }, '节点预览被权限拒绝（中间视图通道）');
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
  if (parameters) base += ` WITH PARAMETERS (${buildParameters(parameters)})`;
  const where = buildWhere(opts.filter);
  const sql = `${base}${where.clause} LIMIT ?`;
  const rows = await withPermissionDiagnosis(pool, packageId, objectName, opts.kind, 'direct', () =>
    // 语句超时与写路径同源（pool.statementTimeoutMs）：无上限的慢预览会占着池位拖垮整个工具面（评审 #1112）
    pool.query<Record<string, unknown>>(sql, [...where.params, limit + 1], { timeoutMs: pool.statementTimeoutMs }),
  );
  const { rows: sliced, truncated } = slicePage(rows, limit);
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
    if (!classifyPreviewError(e).diagnose) throw e;
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
      if (rethrow === e || !(rethrow instanceof HanaBusinessError) || !rethrow.diagnosis) {
        // 诊断降级：不掩盖原错、不阻断调用，但服务端留痕（诊断本身为何失败）
        logger.warn({ packageId, objectName, channel, err: rethrow }, '预览权限诊断失败，回退原始错误');
        throw e;
      }
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
  /** 仅复用路径回报新鲜度；新鲜度查询在锁内做——此刻视图必然还在（锁外读会撞上并发 DROP 的窗口） */
  let freshness: IntermediateFreshness | undefined;
  await withKeyedLock(intermediateLockKey(viewName), async () => {
    // 存在性三态（评审 #1111/#1121）：'unknown'（SYS.VIEWS 读失败/不可见）不得冒充「不存在」——
    // 它照走 CREATE，但容忍「对象已存在」并回退到复用；只有 'missing' 是确定的「不存在」。
    const existence = await runtimeViewExists(pool, viewName);
    if (existence === 'exists') {
      reused = true;
      freshness = await readIntermediateFreshness(pool, viewName, packageId, objectName);
    } else {
      try {
        await pool.execute(
          `CALL SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV(?, ?, ?, ?, ?)`,
          [INTERMEDIATE_SCHEMA, viewRef, node, viewName, INTERMEDIATE_VERSION],
          { timeoutMs: INTERMEDIATE_CONTROL_TIMEOUT_MS },
        );
        intermediateOwned.add(viewName); // 本服务创建的才可清理（预存在的他人对象不在此列）
      } catch (e) {
        // 存在性不可判定（读失败）或跨进程竞态（两进程同判「不存在」，一方先 CREATE）下，
        // 对象其实在场 ⇒ CREATE 撞「对象已存在」：按复用继续（重读新鲜度），不让只读预览打成假失败
        // （评审 #1111）。其余错误照常上抛。
        if (ALREADY_EXISTS_RE.test(hanaErrorMessage(e))) {
          logger.warn({ viewName, err: e }, '中间视图已存在（存在性不可判定或并发创建）：跳过创建，按复用继续');
          reused = true;
          freshness = await readIntermediateFreshness(pool, viewName, packageId, objectName);
        } else {
          throw e;
        }
      }
    }
    intermediateInUse.set(viewName, (intermediateInUse.get(viewName) ?? 0) + 1);
  });

  let rows: Record<string, unknown>[];
  let sql: string;
  let release: { dropped: boolean; reason?: string };
  try {
    const where = buildWhere(opts.filter);
    sql = `SELECT * FROM ${qualifyName(INTERMEDIATE_SCHEMA, viewName)}${where.clause} LIMIT ?`;
    // 语句超时（评审 #1112）：重 join 视图上的 SELECT 可能长时间不返回（LIMIT 不保证提前返回）
    rows = await pool.query<Record<string, unknown>>(sql, [...where.params, limit + 1], {
      timeoutMs: pool.statementTimeoutMs,
    });
  } finally {
    // 无论成败都解除占用（失败路径下由释放策略决定是否清理）。
    // 释放做成 **best-effort**：锁等待超时（keyed lock 的排队上限）或锁内异常都不得让整个预览请求失败
    // （那不是「预览失败」，是一次假失败）；但**占用计数必须递减**——它才是泄漏源：只增不减会让该视图
    // 从此不再被 DROP（且每次都用一次假失败换来一次泄漏）。锁体里的递减位于**任何可失败操作之前**
    // （纯 Map 操作不可能抛），故锁体一旦开始执行就必然完成递减；下面的兜底只覆盖「锁体根本没跑」
    // （锁等待超时被跳过 / 获取失败）的情形，不会双扣。兜底递减在锁外做（此时锁体没跑，没有并发方
    // 在改这个计数；计数只是 DROP 的尽力而为门槛，不是正确性依赖），并如实保留「视图未释放」。
    try {
      release = await releaseIntermediateView(pool, viewName);
    } catch (e) {
      decrementIntermediateInUse(viewName);
      logger.warn(
        { viewName, err: e },
        '中间视图释放未完成（锁等待超时或锁内异常）：占用计数已兜底递减，视图保留供后续复用',
      );
      release = { dropped: false, reason: '释放未完成（锁等待超时或异常）：视图保留供后续复用，占用计数已兜底递减' };
    }
  }
  const { rows: sliced, truncated } = slicePage(rows, limit);
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
      ...(freshness ? { freshness } : {}),
    },
  };
}

/**
 * 占用计数递减（单点实现：锁体与兜底路径共用同一套算术，避免两处各写一遍导致口径漂移）。
 * ≤0 时移除条目；返回剩余计数。
 */
function decrementIntermediateInUse(viewName: string): number {
  const remaining = (intermediateInUse.get(viewName) ?? 1) - 1;
  if (remaining > 0) intermediateInUse.set(viewName, remaining);
  else intermediateInUse.delete(viewName);
  return remaining;
}

/**
 * 释放中间视图：仅当「本进程已无调用占用」且「由本服务创建」时才 DROP。
 * 保留的三种情形（均不报错、不影响本次预览结果）：
 * - 本进程内还有并发调用在用（引用计数 > 0）
 * - 视图非本服务创建（他人 / 上一次进程的残留）→ 误删他人对象风险，宁可留着
 * - DROP 失败：本进程之外的会话（如 HANA Studio）正在读该视图而占用锁 → 交由下次调用复用
 * 与取用共用同一把锁：保证不会在「刚判定无人占用」之后、DROP 之前被新调用复用。
 * 计数递减放在锁体**最前**（任何可失败操作之前）：调用方（previewNodeViaIntermediate 的 finally）
 * 在锁等待超时等情形会做兜底递减，锁体外无并发方在改这个计数，故不会双扣；反之，锁体一旦开始
 * 执行就必然完成递减——"递减无论如何都要发生"是调用方的硬要求（它是泄漏源）。
 */
async function releaseIntermediateView(
  pool: HanaPool,
  viewName: string,
): Promise<{ dropped: boolean; reason?: string }> {
  return withKeyedLock(intermediateLockKey(viewName), async () => {
    const remaining = decrementIntermediateInUse(viewName);
    if (remaining > 0) {
      return { dropped: false, reason: `仍有 ${remaining} 个预览调用在使用该视图` };
    }
    if (!intermediateOwned.has(viewName)) {
      return { dropped: false, reason: '视图非本服务创建（他人或历史残留），不主动删除' };
    }
    try {
      await pool.execute(
        `CALL SYS.DROP_INTERMEDIATE_CALCULATION_VIEW_DEV(?, ?, ?)`,
        [INTERMEDIATE_SCHEMA, viewName, INTERMEDIATE_VERSION],
        { timeoutMs: INTERMEDIATE_CONTROL_TIMEOUT_MS },
      );
      intermediateOwned.delete(viewName);
      return { dropped: true };
    } catch (e) {
      // 占用中（其他会话正在读）或权限不足：保留视图供下次复用（清理失败不得掩盖原始错误）
      logger.warn({ viewName, err: e }, '中间视图 DROP 被拒绝，已保留供后续复用');
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
  const rows = await pool.query<Record<string, unknown>>(sql, [...where.params, limit + 1], {
    timeoutMs: pool.statementTimeoutMs,
  });
  const { rows: sliced, truncated } = slicePage(rows, limit);
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

/**
 * 预览失败错误的**统一判定**（单点：权限判定与诊断触发共用同一口径，避免两处各写一份判定而漂移）：
 * - permission：权限类（码集 PREVIEW_PERMISSION_CODES=10/2950 + 权限消息正则，见 core/hana-errors）
 *   → 归一为「无权限」提示（含本服务自有的「无权限：」前缀）；
 * - diagnose：是否自动触发权限诊断 = 权限类 + 对象不可见类（258/259）。后两者在 _SYS_BIC 预览语境下
 *   常是「缺 SELECT → 运行时对象对当前用户不可见」的伪装形态（HANA 对无权访问的对象倾向返回 259
 *   而非权限码），纳入诊断避免漏掉这类隐蔽根因；诊断报告自身会区分「真缺权限」与「对象确实未激活」。
 */
function classifyPreviewError(e: unknown): { permission: boolean; diagnose: boolean } {
  return {
    permission: isPermissionError(e, PREVIEW_PERMISSION_CODES),
    diagnose: shouldDiagnoseAccessError(e),
  };
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

/* ── 基表勘察 ─────────────────────────────────────────────────────────
 * 为什么需要：跨表建模前必须核对「源表实际值长什么样」——数据在哪张表/哪个分区、关联键是否补零、
 * 号码列到底在哪一列。没有这条通道，就只能「建临时透传视图 → 激活 → 预览 → 删除」：
 * 每核对一次是 4 次写操作，而且「0 行」要等激活之后才发现。
 *
 * 统计口径：**只基于采样行**（默认 200 行）。不跑 COUNT(*)/COUNT(DISTINCT) 这类全表操作——
 * BW 大表上代价不可控，而"值形态"（补零、长度、号码列）看采样就够。
 * schema 走白名单（HANA_READ_SCHEMA），列名/表名走运行时名校验，值一律参数绑定。
 */

/** 值样例最多返回个数 */
const PROFILE_SAMPLE_VALUES = 10;
/** 样例值显示长度上限（超长列值截断，避免把宽表整行塞进上下文） */
const PROFILE_VALUE_CHARS = 80;
/** 勘察默认采样行数 / 上限 */
const INSPECT_DEFAULT_ROWS = 200;
const INSPECT_MAX_ROWS = 2000;

/** 值 → 展示字符串（null/undefined 映为 'NULL'；超长值按 core/text 的统一截断文案标注） */
function displayValue(v: unknown): string {
  if (v === null || v === undefined) return 'NULL';
  const s = typeof v === 'string' ? v : typeof v === 'object' ? JSON.stringify(v) : String(v);
  return truncateWithNote(s, PROFILE_VALUE_CHARS);
}

/** 单列统计（纯函数；输入为采样行） */
function profileColumn(
  name: string,
  values: unknown[],
  meta?: { dataType?: string; length?: number },
): TableColumnProfile {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  const nullCount = values.length - nonNull.length;
  const distinct = new Map<string, unknown>();
  for (const v of nonNull) {
    const key = typeof v === 'string' ? v : String(v);
    if (!distinct.has(key)) distinct.set(key, v);
  }
  // 长度统计只取**字符串值**：数值列上 String(5).length 之类的长度没有业务含义，
  // 却会被当成"补零不一致"的信号（README/指令里 minLength/maxLength 就是给字符型键用的）
  const stringValues = nonNull.filter((v) => typeof v === 'string') as string[];
  const lengths = stringValues.map((v) => v.length);
  const minLength = lengths.length > 0 ? Math.min(...lengths) : undefined;
  const maxLength = lengths.length > 0 ? Math.max(...lengths) : undefined;
  const zeroPadded = nonNull.filter((v) => typeof v === 'string' && /^0\d/.test(v)).map(displayValue);
  return {
    name,
    ...(meta?.dataType ? { dataType: meta.dataType } : {}),
    ...(meta?.length !== undefined ? { length: meta.length } : {}),
    nullCount,
    distinctInSample: distinct.size,
    ...(minLength !== undefined ? { minLength, maxLength, uniformLength: minLength === maxLength } : {}),
    samples: [...distinct.values()].slice(0, PROFILE_SAMPLE_VALUES).map(displayValue),
    ...(zeroPadded.length > 0 ? { zeroPaddedSamples: [...new Set(zeroPadded)].slice(0, 5) } : {}),
  };
}

/**
 * 基表/视图勘察：采样 N 行 + 逐列统计（去重值样例、长度区间、前导零样例）。
 * 与视图预览共用筛选语义（filter 为 AND 连接、值参数绑定）。
 */
export async function inspectTable(pool: HanaPool, opts: TableInspectOptions): Promise<TableInspectResult> {
  // core/sql 的断言直接抛 HanaBusinessError（带 code），由 withErrorEnvelope 归一为结构化信封；
  // 此处不再包一层改写文案（改写既丢错误码，又让白名单描述与 core 漂移）。
  assertSchemaAllowed(opts.schema);
  assertSafeRuntimeName(opts.table, '表/视图');
  const sampleRows = clampLimit(opts.sampleRows, INSPECT_DEFAULT_ROWS, 1, INSPECT_MAX_ROWS);
  const { clause, params } = buildWhere(opts.filter);

  // 列清单：显式给出则校验后用；缺省按元数据取（有上限，避免宽表把上下文塞满）。
  // 取不到列时 getTableColumns 会抛「未找到表…（或当前用户无权限）」——比在这里重写一条更精确，直接透传。
  // 元数据里的类型/长度一并留下：画像里的 dataType/length 就是给「NUMC(10) vs CHAR(18)」这类判断用的。
  const metaByName = new Map<string, { dataType?: string; length?: number }>();
  let columnNames = opts.columns?.map((c) => c.trim());
  for (const c of columnNames ?? []) assertSafeRuntimeName(c, '列名');
  try {
    const { getTableColumns } = await import('./metadata.service.js');
    const { columns: cols } = await getTableColumns(pool, opts.schema, opts.table, { limit: 50 });
    for (const c of cols) metaByName.set(c.columnName, { dataType: c.dataTypeName, length: c.length ?? undefined });
    if (!columnNames || columnNames.length === 0) columnNames = cols.map((c) => c.columnName);
  } catch (e) {
    // 显式给了列清单时元数据失败不致命（仍可采样）；缺省取列时失败必须上抛（否则无从采起）
    if (!columnNames || columnNames.length === 0) throw e;
    // 降级留痕：画像里不会有 dataType/length，但采样与值形态信号仍然给出
    logger.warn({ schema: opts.schema, table: opts.table, err: e }, '列元数据读取失败，按显式列清单继续采样');
  }

  const target = `${quoteIdentifier(opts.schema)}.${quoteIdentifier(opts.table)}`;
  const selectList = columnNames.map((c) => quoteIdentifier(c)).join(', ');
  const sql = `SELECT ${selectList} FROM ${target}${clause} LIMIT ?`;
  const rows = await pool.query<Record<string, unknown>>(sql, [...params, sampleRows + 1], {
    timeoutMs: pool.statementTimeoutMs,
  });
  const { rows: sliced, truncated } = slicePage(rows, sampleRows);

  const profiles = columnNames.map((name) =>
    profileColumn(
      name,
      sliced.map((r) => r[name]),
      metaByName.get(name),
    ),
  );

  return {
    table: { schema: opts.schema, table: opts.table },
    sampledRows: sliced.length,
    truncated,
    empty: sliced.length === 0,
    ...(sliced.length === 0
      ? {
          emptyHint:
            '该表（在当前筛选下）没有数据。BW 场景常见原因：数据在**另一张表**——变更日志表（...1 结尾）vs 活动数据表（...2 结尾）、' +
            '或数据在另一个分区/年份段；请对候选表逐一勘察行数对比（本工具支持直接换 table 再查）',
        }
      : {}),
    columns: profiles,
    // 样例行只回前 10 行：够看值形态，又不至于把宽表刷屏
    rows: sliced.slice(0, 10),
    sql,
    samplingNote:
      `统计基于前 ${sliced.length} 行采样（sampleRows=${sampleRows}${truncated ? '，已截断、表还有更多行' : ''}）；` +
      'distinctInSample / minLength / maxLength 均为**采样口径**，不代表全表精确值',
  };
}
