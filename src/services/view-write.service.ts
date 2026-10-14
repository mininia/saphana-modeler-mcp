import { createHash, randomBytes } from 'node:crypto';
import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { ACTIVATION_CONCURRENCY_DEFAULT, ACTIVATION_SEMAPHORE } from '../core/limits.js';
import { logger, redactSensitive } from '../core/logger.js';
import { clampLimit } from '../core/num.js';
import { withSemaphore } from '../core/semaphore.js';
import {
  assertSafeObjectName,
  assertSafeRuntimeName,
  assertSchemaAllowed,
  qualifyName,
  quoteIdentifier,
} from '../core/sql.js';
import { type EtagSource, type FileMeta, type WriteCheckResult, XsRestClient } from '../core/xs-rest.js';
import type { HanaConfig } from '../config/config.js';
import { type ScriptedCalcViewSpec, buildMinCalcViewXml, buildScriptedCalcViewXml } from '../model/view-builder.js';
import { type ViewDiff, diffViewDefinitions } from '../model/view-diff.js';
import {
  type FullXmlGuardResult,
  type OutputFieldKind,
  type SetScriptSpec,
  addCalculatedColumnToViewXml,
  addJoinToViewXml,
  chooseDefaultJoinFields,
  dropFieldFromViewXml,
  getJoinTargetAttrs,
  guardFullXmlUpdate,
  renameFieldInViewXml,
  setAttributeFilterInViewXml,
  setDescriptionInViewXml,
  setScriptInViewXml,
  setVariableInViewXml,
} from '../model/view-edit.js';
import { type ViewDefinition, isNumericType } from '../model/view-types.js';
import { parseViewDefinition } from '../model/view-xml.js';
import { type ClosureResult, type GraphEdge, impact } from './catalog.service.js';
import {
  type BreakingAssessment,
  type MigrationDeclaration,
  assessBreaking,
  assessViewDeletion,
} from './migrate.rules.js';
import { TABLE_COLUMNS_LIMIT_MAX, currentSchema, getTableColumns, getViewDefinition } from './metadata.service.js';
import { slicePage } from './preview.service.js';
import { assertSqlReadScopes } from './read-scope.service.js';
import { getViewOp } from './view-ops.rules.js';
import {
  type ActivationDetail,
  type RepoRestResponse,
  VERSION_CONCURRENCY_CAVEAT,
  activateViaRest,
  activationDetailOf,
  activationSummary,
  assertNoRepoRestError,
  assertWritePackageAllowed,
  deleteViaRest,
  designTimeFile,
  designTimeTarget,
  invalidateViewCache,
  noIfMatchNote,
  normalizeObjectName,
  repositoryRest,
  stripInternalMeta,
  updateViaRest,
  writeLockKey,
  writeReceiptBaseline,
  writeViaInactiveObject,
  writeViaRepoRest,
} from './repo-transport.service.js';

/** 新建 Calculation View 的输入规格 */
export interface CreateCalcViewInput {
  /** 包名（须在 HANA_WRITE_PACKAGES 配置的写边界内；示例值 ZDEMO*，留空 = 写请求被运行期闸门拒绝） */
  packageId: string;
  /** 对象名（不含包名，如 ZDEMO_CV_TEST001） */
  objectName: string;
  description?: string;
  /**
   * 视图形态：
   * - projection（默认）：图形化最小形态 = 单 Projection 节点 + 单个表/视图数据源（source 必填）；
   * - sql：SQL 模式 = 单个 SqlScriptView 节点 + <definition> SQL（scripted 必填，source 不使用）。
   */
  mode?: 'projection' | 'sql';
  /** 源：表/视图（schema 经白名单）+ 列（缺省自动取全列）；mode=projection 时必填 */
  source?: {
    schema: string;
    name: string;
    /** 显式指定映射列（仅需 columnName，dataTypeName 用于度量判定；缺省取表全列） */
    columns?: Array<{ columnName: string; dataTypeName?: string }>;
    measureMode?: 'SUM_NUMERIC' | 'ALL_ATTRIBUTES';
  };
  /** SQL 模式：SQL 脚本 + 输出列清单（mode=sql 时必填；对象名/描述取自本次创建的入参） */
  scripted?: Omit<ScriptedCalcViewSpec, 'objectName' | 'description'>;
  /** 激活开关：true=写后立即尝试激活；false/缺省=仅写设计时对象 */
  activate?: boolean;
  /**
   * 传输通道：
   * - xs_rest（默认）：XS Classic 设计时 REST API（Orion，官方写路径，推荐用于写/激活）
   * - repo_rest：SYS.REPOSITORY_REST 裸 repoV2 JSON（读侧稳定；写侧在部分环境会 40106）
   * - inactive_object：直写 _SYS_REPO.INACTIVE_OBJECT 兜底（需特权账号）
   */
  transport?: 'repo_rest' | 'xs_rest' | 'inactive_object';
  /** 激活成功后探测的行数上限（0=不探测，默认 10）：让「0 行」当场可见，而不是留到人工预览才发现 */
  probeRows?: number;
}

/** 激活后行探测结果：让「激活成功但 0 行」当场可见，而不是靠人工再预览一次 */
export interface RowProbe {
  /** 实际取回的行数（≤ probeRows） */
  sampledRows: number;
  /** true = 命中 probeRows 上限，还有更多行 */
  truncated: boolean;
  columns: string[];
  rows: Record<string, unknown>[];
  /** 0 行时的排查提示（键值补零 / 号码列语义 / 数据所在表与分区） */
  emptyHint?: string;
  /** 探测失败原因（未激活、无 SELECT 权限等）；探测失败不影响写入结果 */
  error?: string;
}

/** 0 行提示：直接给出"下一步查什么"，避免把「激活成功」误当成「逻辑正确」 */
const EMPTY_ROWS_HINT =
  '视图可执行但返回 0 行——这不等于逻辑正确。排查顺序：' +
  '① 用 hana_data_preview 的基表勘察模式（schema+table）核对源表**实际值**与行数，确认数据在哪个表/分区（ADSO 变更日志表 vs 活动数据表）；' +
  '② 核对关联键的**补零/前导零格式**（BW 体系 ID 常见 15 位零填充 vs 不补零，两侧长度不一致会静默丢结果）；' +
  '③ 核对**号码列语义**是否选错（如单据编号可能在 /BIC/Z* 客户字段而非 *NUM 标准字段）。';

/** 新建视图结果 */
export interface CreateCalcViewResult {
  object: { packageId: string; objectName: string; objectSuffix: 'calculationview' };
  xml: string;
  wrote: boolean;
  activated?: boolean;
  /** 激活未通过的一行摘要（首行 + 错误码）；完整明细见 activationDetail */
  activationErrors?: unknown;
  /** 激活未通过的完整明细（含 DDL 全文）：无需再调 hana_view_validate 即可定位 */
  activationDetail?: ActivationDetail;
  /** 度量数量（本环境激活要求 ≥1 个度量；0 时 activationNote 说明） */
  measureCount: number;
  /** measureCount=0 时的实测边界提示（激活会被 40117 "No measures defined" 拒绝） */
  activationNote?: string;
  /** inactive_object 通道专用：需要用户在 Studio 手工激活的提示 */
  manualActivateHint?: string;
  /**
   * 回执警告（仅在确有需要如实标注的事实时产生，不制造恒为空噪音）：
   * 目前来源 = 自动取列超过上限（源表列数 > 500，仅映射前 500 列）与显式列类型未解析
   * （源表列目录被同一上限截断）。命中时不许再按「全列 / 类型齐全」口径读回执。
   */
  warnings?: string[];
  /** 视图形态：projection（图形化最小形态）/ sql（SQL 模式，单 SqlScriptView） */
  mode?: 'projection' | 'sql';
  /** 激活后的行探测（probeRows>0 且对象已激活时才有） */
  rowProbe?: RowProbe;
  /** 写入回执的新基线（写响应头 ETag；可能缺省——响应头没给就不补读拼装，语义见 etagSource） */
  etag?: string;
  /**
   * etag 的来源（见 EtagSource）。写入成功即填充：'response-header'=响应头同刻读数；
   * 'unavailable'=响应头未带 ETag，本次回执没有可用基线——**不许**把补读值冒充成响应头基线。
   */
  etagSource?: EtagSource;
  /** 写入后的服务端版本号（SapBackPack.Version；与 etag 同一次写响应读取，不拼装） */
  version?: number;
  /**
   * 跨进程并发迹象（只有实测到时才产生该字段，不制造恒为空噪音）：
   * PUT 是 create-or-update、服务端不返回 409；锁内检查说「不存在」而写入后 Version > 1
   * ⇒ 本次调用期间有他人写过同名对象（last-write-wins，SSD §4.1 列为 I1 的已知例外）。
   * 需要并发保护时：写入前读基线，更新时显式传 ifMatch。
   */
  concurrencyNote?: string;
}

/** 行探测默认/上限（工具层 zod 默认值与服务层共用同一常量，避免多处各写一遍） */
export const DEFAULT_PROBE_ROWS = 10;

export const MAX_PROBE_ROWS = 100;

/**
 * 激活后的行探测：对刚写入/激活的视图取前 N 行，让「0 行」当场可见。
 * - 只走运行时对象（_SYS_BIC.<包>/<对象>）；视图未激活时不做猜测，直接回报原因
 * - LIMIT probeRows+1 探测是否被截断（不跑 COUNT(*)：大视图上代价不可控）
 * - 任何失败都只进 rowProbe.error，不影响写入结果本身（探测是附加信息，不是前置条件）
 */
export async function probeRuntimeRows(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  probeRows: number,
): Promise<RowProbe> {
  const empty: RowProbe = { sampledRows: 0, truncated: false, columns: [], rows: [] };
  const limit = clampLimit(Math.trunc(probeRows), 1, 1, MAX_PROBE_ROWS);
  try {
    // 写路径 SQL 超时（§4.3）：行探测跟在写后，超时值取自池（假池/旧调用点 undefined = 不加超时）
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${qualifyName('_SYS_BIC', `${packageId}/${objectName}`)} LIMIT ?`,
      [limit + 1],
      { timeoutMs: pool.statementTimeoutMs },
    );
    const { rows: sliced, truncated } = slicePage(rows, limit);
    return {
      sampledRows: sliced.length,
      truncated,
      columns: sliced[0] ? Object.keys(sliced[0]) : [],
      rows: sliced,
      ...(sliced.length === 0 ? { emptyHint: EMPTY_ROWS_HINT } : {}),
    };
  } catch (e) {
    return {
      ...empty,
      error:
        `行探测失败（不影响写入结果）：${e instanceof Error ? e.message : String(e)}。` +
        '对象可能未激活，或当前用户缺少 _SYS_BIC 下该对象的 SELECT 权限（可用 hana_data_preview 复核）',
    };
  }
}

/**
 * 行探测的唯一守卫：仅当「对象确实激活」且「probeRows > 0」时探测，否则返回 undefined。
 * create 与 update 共用同一守卫：各写一份时，改默认值/加守卫要同时找多处，漏一处即行为不一致。
 */
async function probeIfActivated(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  activated: boolean,
  probeRows?: number,
): Promise<RowProbe | undefined> {
  const rows = probeRows ?? DEFAULT_PROBE_ROWS;
  if (!activated || rows <= 0) return undefined;
  return probeRuntimeRows(pool, packageId, objectName, rows);
}

/**
 * SQL 模式的读取范围校验（读边界的最后一道）。
 * 脚本里**限定 schema** 的引用由工具层写计划扫描判定；**未限定**表名（`FROM MARA`）按当前用户的
 * 默认 schema 解析——扫描器无从得知，故这里查出 CURRENT_SCHEMA 再判它是否在允许范围内。
 * 没有这一步时 `SELECT * FROM MARA` 这类写法会完全绕过 HANA_READ_SCHEMA。
 *
 * 判定规则已提取到 read-scope.service（SQL 分析工具要在**已持有连接**上做同一件事），此处只注入读法。
 */
async function assertScriptReadScopes(pool: HanaPool, script: string): Promise<void> {
  return assertSqlReadScopes(script, () => currentSchema(pool), '脚本');
}

/**
 * 设计时定义里的 SQL 脚本正文（SqlScriptView 的 `script`；view-xml 已从 <definition> 取文本并解码实体）。
 * **单点取法**：xml 全量覆盖与服务端导入预扫两个「整份 XML 载荷」通道共用——各写一份 map/filter 的那天，
 * 一处改了取法、另一处的读取范围判定就此静默落空。
 */
export function definitionScriptsOf(def: ViewDefinition): string[] {
  return def.nodes.map((n) => n.script).filter((s): s is string => typeof s === 'string' && s.trim() !== '');
}

/** 检查对象是否已存在（ACTIVE_OBJECT 或 INACTIVE_OBJECT） */
async function objectExists(pool: HanaPool, packageId: string, objectName: string): Promise<boolean> {
  for (const table of ['ACTIVE_OBJECT', 'INACTIVE_OBJECT']) {
    // 表名来自本函数内的字面量常量，仍统一走 quoteIdentifier（纵深防御：标识符引用只此一种拼法）。
    // 写路径 SQL 超时（§4.3）：存在性检查是写前必经腿，超时值取自池（假池/旧调用点 undefined = 不加超时）
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM "_SYS_REPO".${quoteIdentifier(table)}
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX = 'calculationview'`,
      [packageId, objectName],
      { timeoutMs: pool.statementTimeoutMs },
    );
    if ((rows[0]?.C ?? 0) > 0) return true;
  }
  return false;
}

/**
 * 「仅 404（OBJECT_NOT_FOUND）才算不存在、其余错误 rethrow」的 fail-closed 判定（全文单点实现）。
 * 多处用它守「把读异常当成『不存在』会静默覆盖/删除他人对象」的语义（导入存在性守卫、临时副本
 * 探测/清理、三个补偿函数的探测）——各写一份时，任一处被顺手放松都不会在别处显形。
 */
export function isObjectNotFoundError(e: unknown): boolean {
  return e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND';
}

/**
 * 自动取列的硬上限（**单点数值定义**在 metadata.service 的 TABLE_COLUMNS_LIMIT_MAX——它就是
 * getTableColumns 的 clampLimit 上限；本文件引用同一常量，不再手抄 500）：命中即视为**截断**——
 * 源表列数超过上限时只能映射前 N 列，回执必须如实标注（不许按「全列」口径静默建视图）。
 * 截断判定用 getTableColumns 回执的 `truncated`（count > limit，精确），不再用「取满 N 行」推测。
 */
const AUTO_COLUMN_LIMIT = TABLE_COLUMNS_LIMIT_MAX;

/**
 * 生成数据源定义所需的列信息（缺省从表元数据取全列）。
 *
 * 两条分支的口径：
 * - 省略 columns：按表元数据取全列，命中 AUTO_COLUMN_LIMIT 即 truncated=true（回执标注，不静默丢列）；
 * - 显式 columns：调用方**未给 dataTypeName** 的列按列名回查表元数据补齐（度量判定依赖类型——
 *   缺类型会被 isNumericType 判成非数值 ⇒ 默认 SUM_NUMERIC 下 0 度量 ⇒ 激活 40117）；
 *   列名在源表列目录中不存在时报可修正的中文错误（拼错的列名不应写进 PUT）。
 *   元数据目录自身触达上限时可能出现「列存在但落在目录之外」，此时不退化为硬错误（宽表是真实场景），
 *   只保留未解析的类型（由调用方在回执 warnings 标注）。
 */
async function resolveColumns(
  pool: HanaPool,
  source: NonNullable<CreateCalcViewInput['source']>,
): Promise<{
  columns: Array<{ columnName: string; dataTypeName?: string }>;
  truncated: boolean;
  unresolvedTypes: string[];
}> {
  if (source.columns && source.columns.length > 0) {
    const missing = source.columns.filter((c) => !c.dataTypeName);
    if (missing.length === 0) return { columns: source.columns, truncated: false, unresolvedTypes: [] };
    // 只查一次表列目录（与省略分支共用同一助手/上限）
    const page = await getTableColumns(pool, source.schema, source.name, { limit: AUTO_COLUMN_LIMIT });
    const catalog = page.columns;
    const catalogByName = new Map(catalog.map((c) => [c.columnName.toUpperCase(), c]));
    const unresolvedTypes: string[] = [];
    const columns = source.columns.map((c) => {
      if (c.dataTypeName) return c;
      const hit = catalogByName.get(c.columnName.toUpperCase());
      if (hit) return { columnName: c.columnName, dataTypeName: hit.dataTypeName };
      if (page.truncated) {
        // 目录被截断，无法判定「列不存在」还是「列在上限之外」——不误拒，如实记录待回执标注
        unresolvedTypes.push(c.columnName);
        return c;
      }
      throw new HanaBusinessError(
        `显式列 "${c.columnName}" 不存在于源 ${source.schema}/${source.name}。` +
          `可用列：${catalog.map((k) => k.columnName).join(', ')}`,
      );
    });
    return { columns, truncated: false, unresolvedTypes };
  }
  const page = await getTableColumns(pool, source.schema, source.name, { limit: AUTO_COLUMN_LIMIT });
  return {
    columns: page.columns.map((c) => ({ columnName: c.columnName, dataTypeName: c.dataTypeName })),
    truncated: page.truncated,
    unresolvedTypes: [],
  };
}

/**
 * view_update 的声明式操作补丁（op=add_join：给当前视图追加一个 join；op=set_script：替换 SQL 模式脚本；
 * op=set_description：改视图描述/显示名——只动展示属性，不碰结构）
 */
export interface AddJoinOperation {
  op: 'add_join';
  /** join 源视图（仓库对象；BW query 视图/普通 CV/AV 均可，只读即可） */
  sourcePackageId: string;
  sourceObjectName: string;
  /** join 类型（默认 leftOuter） */
  joinType?: 'inner' | 'leftOuter' | 'rightOuter' | 'fullOuter';
  /** join 条件：leftField=当前输出节点已有字段；rightField=源视图字段（可不同名，自动重命名接线） */
  conditions: Array<{ leftField: string; rightField: string }>;
  /** 要透出到输出的源视图字段；缺省=源视图全部可见属性 − join 条件字段 − 左侧已有字段 */
  fields?: string[];
}

/** op=set_script：替换 SQL 模式视图（SqlScriptView）的脚本与输出列（模型零 XML） */
export interface SetScriptOperation extends SetScriptSpec {
  op: 'set_script';
}

/**
 * op=set_description：改视图描述与/或显示名（模型零 XML）。
 * 真实语料里两者是**同一个** XML 锚点（根元素下的 `<descriptions defaultDescription="…"/>`）——
 * 两个字段都给时必须一致（否则见 setDescriptionInViewXml 的中文硬错误：一个锚点写不进两个值）。
 */
export interface SetDescriptionOperation {
  op: 'set_description';
  /** 视图描述（与 displayName 同锚点；见 view-edit 的 setDescriptionInViewXml 头注） */
  description?: string;
  /** 显示名 / Studio 语义的 Label（与 description 同锚点） */
  displayName?: string;
}

export type ViewUpdateOperation =
  | AddJoinOperation
  | SetScriptOperation
  | SetDescriptionOperation
  | RenameFieldOperation
  | DropFieldOperation
  | AddCalculatedColumnOperation
  | SetAttributeFilterOperation
  | SetVariableOperation;

/** op=rename_field：改输出字段名（输出别名——keyMapping 的节点列不动；见 view-edit 的 renameFieldInViewXml） */
export interface RenameFieldOperation {
  op: 'rename_field';
  field: string;
  newName: string;
}

/** op=drop_field：删输出字段（删后视图须仍有 ≥1 度量，否则写入前即拒） */
export interface DropFieldOperation {
  op: 'drop_field';
  field: string;
}

/** op=add_calculated_column：在节点上新增计算列（公式 + 类型）并映射为输出属性 */
export interface AddCalculatedColumnOperation {
  op: 'add_calculated_column';
  name: string;
  formula: string;
  datatype: string;
  length?: string;
  description?: string;
  node?: string;
}

/** op=set_attribute_filter：给节点已有属性设置单值过滤器（口径面变更，破坏性判定按 attribute_filter_changed） */
export interface SetAttributeFilterOperation {
  op: 'set_attribute_filter';
  attribute: string;
  value: string;
  including?: boolean;
  node?: string;
}

/** op=set_variable：修改已有输入参数（口径面变更，破坏性判定按 variable_changed） */
export interface SetVariableOperation {
  op: 'set_variable';
  variableId: string;
  defaultValue?: string;
  description?: string;
  mandatory?: boolean;
}

/** 单条 add_join 操作的应用明细 */
export interface AddJoinOperationResult {
  op: 'add_join';
  source: { packageId: string; objectName: string; kind: string; resourceUri: string };
  join: {
    joinType: string;
    conditions: Array<{ leftField: string; rightField: string }>;
    joinAttributeNames: string[];
    /** 原输出节点（join 左侧输入） */
    previousFinalNode: string;
    /** 新输出节点（本次新增） */
    newJoinNode: string;
    newProjectionNode: string;
    dataSourceId: string;
  };
  /** 新增的输出字段（id + logicalModel order） */
  addedOutputFields: Array<{ id: string; order: number; description?: string }>;
  /** 默认带出字段的说明（显式传 fields 时无） */
  fieldSelectionNote?: string;
}

/** 单条 set_script 操作的应用明细 */
export interface SetScriptOperationResult {
  op: 'set_script';
  /** 被替换脚本的节点 id（SqlScript_1） */
  scriptNodeId: string;
  /** 重建后的输出属性/度量数 */
  attributeCount: number;
  measureCount: number;
  /** 脚本字符数（替换前 → 后） */
  scriptBytes: { before: number; after: number };
}

/** 单条 set_description 操作的应用明细 */
export interface SetDescriptionOperationResult {
  op: 'set_description';
  /** 实际写入的字段名（['description','displayName'] 的子集；目标值本就相同 ⇒ []，一个字节未动） */
  changed: string[];
}

/** 单条 rename_field 操作的应用明细 */
export interface RenameFieldOperationResult {
  op: 'rename_field';
  field: string;
  newName: string;
  /** 输出字段种类（属性 / 计算属性 / 度量 / 计算度量 / 限制度量） */
  kind: OutputFieldKind;
}

/** 单条 drop_field 操作的应用明细 */
export interface DropFieldOperationResult {
  op: 'drop_field';
  field: string;
  kind: OutputFieldKind;
  /** 删除后的输出字段计数（度量恒 ≥1——不满足在写入前即拒） */
  remaining: { attributes: number; measures: number };
}

/** 单条 add_calculated_column 操作的应用明细 */
export interface AddCalculatedColumnOperationResult {
  op: 'add_calculated_column';
  node: string;
  name: string;
  /** 新增输出属性的 order（logicalModel 顺延） */
  order: number;
}

/** 单条 set_attribute_filter 操作的应用明细 */
export interface SetAttributeFilterOperationResult {
  op: 'set_attribute_filter';
  node: string;
  attribute: string;
  including: boolean;
  /** true=替换了该属性上原有的过滤器；false=新增 */
  replaced: boolean;
}

/** 单条 set_variable 操作的应用明细 */
export interface SetVariableOperationResult {
  op: 'set_variable';
  variableId: string;
  changed: string[];
}

/** 任一 operation 的应用明细（按 op 判别） */
export type AppliedOperationResult =
  | AddJoinOperationResult
  | SetScriptOperationResult
  | SetDescriptionOperationResult
  | RenameFieldOperationResult
  | DropFieldOperationResult
  | AddCalculatedColumnOperationResult
  | SetAttributeFilterOperationResult
  | SetVariableOperationResult;

/**
 * 迁移声明闸门的结果记录（SSD §5.4 / D2）——回执审计字段，与 DryRunReport.migration 同一形状。
 * 语义：`required` = 本次变更被判定为破坏性（必须声明才放行）；`provided` = 调用方声明的策略
 * （update 通道为 cast/preserve_column/move 或 acknowledge_dependents，delete 通道为 acknowledge_dependents）；
 * `accepted` = 闸门结论。
 * **不做任何自动迁移动作**：migration 只是「调用方显式承认破坏并声明策略」的声明位，
 * 对下游视图的实际处理由编排层按影响半径决定（自动改下游视图超出本服务边界）。
 */
export interface MigrationGateRecord {
  required: boolean;
  provided?: string;
  accepted: boolean;
  /** 声明附注（调用方随声明提供；仅记录，不参与判定） */
  note?: string;
}

/**
 * dryRun 预演回执（SSD §5.1）：只读预演——一次 PUT、一次 probe、一次缓存失效、一次信号量都不发生。
 * 与 UpdateCalculationViewResult 用 `mode` 字段判别（联合返回类型），调用方一眼可辨「这是预演、什么都没写」。
 */
export interface DryRunReport {
  mode: 'dryRun';
  /**
   * 设计时基线，与本次判定同源（同一次锁内 fileMeta 读）：etag 缺省 = 该次读取没拿到 ETag
   * （不是没去读，也不补读拼装）；versionId = 同一次读取的 SapBackPack.Version 字符串形式
   * （XS REST 通道不暴露 _SYS_REPO.VERSION_ID，需要审计对账请用 hana_metadata_get_view）。
   */
  base: { versionId?: string; etag?: string };
  /**
   * 归一化后的结构 diff（§5.2；布局/文档序/聚合方言等写法差异不产生条目）。
   * baselineUnavailable=true 时它是「未判」的空壳占位（empty=true、各集合为空），不是比较结果。
   */
  diff: ViewDiff;
  /**
   * 破坏性判定（**直接下游（单跳）** × diff；level='none' 表示下游无引用或变更不在判定表内）。
   * level 三值：none=判为非破坏；breaking=判为破坏；unknown=**未判**（基线不可用，判定从未执行——
   * unknown ≠ 非破坏，必须配合 baselineUnavailable 一起读）。
   * 下游只计**设计时引用**（运行时目录引用已过滤，见 designTimeDownstream 的实测说明）。
   */
  breaking: BreakingAssessment;
  /**
   * 影响半径：**直接下游（单跳）**（impact() 默认 depth=1，判定/回执都用这一口径；需要传递影响面
   * 请用 hana_metadata_where_used 的 depth>1）。**已剔除运行时目录引用**——不过滤时任何已激活对象的
   * 下游恒非空，见 designTimeDownstream 的实测说明；truncated=true 时 downstream 与 downstreamCount 只是下界。
   * runtimeOnly = 被过滤掉的运行时引用条数（>0 才产生该字段）：downstream.length + runtimeOnly
   * = 本次单跳检索的原始节点数，调用方据此复核「过滤没有静默吃掉引用」。
   * 选择字段而不是 warnings 上报的理由：它是可机读核对的**计数**（warnings 是解释性文字，
   * 留给「归一化/截断」这类需要解释的提示），脚本能据此机器化对齐、不必解析散文。
   */
  impact: { downstream: GraphEdge[]; truncated: boolean; asOf: string; runtimeOnly?: number };
  /**
   * 闸门在预演里的投影：accepted=false 表示「同样的调用去掉 dryRun 会被服务端拒绝」；
   * 基线不可用（未做判定，breaking.level='unknown'）时如实为 required=false / accepted=true——
   * unknown 不是 breaking，不判就不拦。
   */
  migration: MigrationGateRecord;
  /**
   * 设计时内容为空/缺失（基线不可用）：本次**未做破坏性判定**——diff 是空壳占位、breaking.level='unknown'
   * （**未判 ≠ 判为非破坏**），migration.required 如实为 false（不判就不拦）。仅在该情形产生该字段。
   * 为什么 fail-open：空串基线会被 diff 视作「全部新增」，据以判定会误报破坏、拦住合法写入；
   * 与本仓探测类失败的既有口径一致（fail-open + 响亮标注，warnings 里有一句），不拿假基线拦人。
   */
  baselineUnavailable?: boolean;
  /** 诚实性提示（有则列、无则空数组）：如影响半径被截断、归一化后文本差异不判为变更、基线不可用 */
  warnings: string[];
}

export interface UpdateCalculationViewResult {
  object: { packageId: string; objectName: string; objectSuffix: 'calculationview' };
  updated: boolean;
  /** 实测激活状态（本 SPS 合法模型写入即激活） */
  activated: boolean;
  /** 写入时激活检查失败明细（存在即新内容未激活成功） */
  activationErrors?: string;
  /** 激活未通过的完整明细（含 DDL 全文）：无需再调 hana_view_validate 即可定位 */
  activationDetail?: ActivationDetail;
  meta?: FileMeta;
  /** operations 模式：操作应用明细（xml 全量模式无此字段） */
  operationsResult?: {
    applied: AppliedOperationResult[];
    xmlBytes: { before: number; after: number };
  };
  /** xml 全量模式：护栏校验摘要（operations 模式无此字段），供模型免回读自检 */
  xmlVerification?: FullXmlGuardResult;
  /** 激活后的行探测（probeRows>0 且对象已激活时才有）——与 create 回执同形 */
  rowProbe?: RowProbe;
  /** 写入回执的新基线（写响应头 ETag；可能缺省——响应头没给就不补读拼装，语义见 etagSource） */
  etag?: string;
  /** etag 的来源（见 EtagSource；'response-header'=写响应头同刻读数，'unavailable'=响应头未带 ETag） */
  etagSource?: EtagSource;
  /** 写入后的服务端版本号（SapBackPack.Version；与 etag 同一次写响应读取，不拼装） */
  version?: number;
  /** ETag 基线缺失、本次更新退回无 If-Match 旧行为时的如实说明（正常路径不产生该字段） */
  updateNote?: string;
  /**
   * 破坏性判定（**直接下游（单跳）** × 结构 diff；判定/回执都用 impact() 的默认 depth=1 口径，
   * 需要传递影响面请用 hana_metadata_where_used 的 depth>1）。成功回执必然带出（非破坏时
   * level='none'、items=[]）；Optional 仅表示它不参与写入是否发生的判别。基线不可用时它是「未判」
   * 的空壳占位（level='unknown'、items=[]）——unknown ≠ 非破坏，由 baselineUnavailable 标注。
   */
  breaking?: BreakingAssessment;
  /** 迁移声明闸门记录（update 的声明位；形状见 MigrationGateRecord）。成功回执必然带出（只报告，不阻断） */
  migration?: MigrationGateRecord;
  /**
   * 判定输入中被过滤掉的**运行时目录引用**条数（>0 才产生该字段，不制造恒为空噪音；见 designTimeDownstream）。
   * 用途：让「下游计数被过滤过」可复核——breaking.downstreamCount + runtimeOnly = 本次单跳检索的原始节点数。
   */
  runtimeOnly?: number;
  /**
   * 设计时内容为空/缺失（基线不可用）：本次**未做破坏性判定**（diff 空壳占位、breaking.level='unknown'、
   * migration 闸门一并跳过），仅在该情形产生该字段（配套 warnings 里有一句响亮标注）。为什么 fail-open：
   * 空串基线会被 diff 视作「全部新增」，据以拦截会把合法写入误拦——宁可放行 + 如实标注，也不拿假基线拦人。
   */
  baselineUnavailable?: boolean;
  /**
   * 诚实性提示（仅在有值得标注的事实时产生该字段，不制造恒为空噪音）：
   * 基线不可用（BASELINE_UNAVAILABLE_WARNING）与影响半径被截断（IMPACT_TRUNCATED_WARNING）各一句——
   * 与 dryRun 回执共用同一份文案常量（两处各写一遍必然漂移）。
   */
  warnings?: string[];
  /** 端到端耗时（operations 模式含当前/源定义读取与确定性变换；xml 模式无意义故不返回） */
  elapsedMs?: number;
}

/**
 * 更新写临界区的产出（锁内一次算完，锁外只做回执组装）：
 * - dryRun 分支直接返回只读预演回执（不写库、不发 probe、不改缓存、不取信号量）；
 * - write 分支带回写响应与判定材料——回执的 breaking/warnings/baselineUnavailable 由它们组装。
 * 判定材料只在锁内产出，锁外拿不到；故随返回值一并带出，而不是锁外重算（重算必然漂移）。
 */
type UpdateLockOutcome =
  | { kind: 'dryRun'; report: DryRunReport }
  | {
      kind: 'write';
      meta: FileMeta;
      ifMatch?: string;
      operationsResult: UpdateCalculationViewResult['operationsResult'];
      xmlVerification?: FullXmlGuardResult;
      breaking: BreakingAssessment;
      /** 判定输入中过滤掉的运行时目录引用条数（>0 时随回执带出；见 designTimeDownstream） */
      runtimeOnly: number;
      /** 基线不可用（未做判定）——写路径据此在回执里给 warnings 并（隐含）跳过闸门 */
      baselineUnavailable: boolean;
    };

/**
 * 更新 Calculation View 设计时定义（XS REST：PUT + If-Match ETag 乐观锁；冲突 → 业务失败信封 + 机读码 412）。
 * 两种更新方式二选一（修改 CV 可零 XML）：
 * - input.xml：全量 XML 覆盖（原有方式，复杂改造用）；
 * - input.operations：声明式操作补丁——服务端读设计时当前内容，逐条确定性变换
 *   （view-edit，BW 方言同款），再走原有 PUT 更新路径；模型无需读取也不生成 XML。多条 operations 依序应用（可连续追加多个 join）。
 * 并发：整段「取基线 → 读内容/变换 → PUT」都在同一把 keyed lock 内（锁键与 create/activate/delete/import 同键）。
 * 锁内取基线 ⇒ 锁内不再有他人写入（消除「锁外取基线 + 锁内写新内容」的伪 412）；
 * 调用方显式传 ifMatch 时以传入值为准（跨调用强一致场景；已在入口归一：空串/纯空白 = 未提供），
 * 此时那次 fileMeta 读仍保留为存在性检查。
 * 破坏性判定（SSD §5）：PUT 之前先做「结构化 diff（before=设计时当前内容，两模式同一来源）→ **直接下游（单跳）**
 * 影响半径 → 破坏性判定」，两条分支共用同一份计算（判定输入的下游只计设计时引用、运行时 __RT_* 引用过滤，
 * 见 designTimeDownstream）：
 * - opts.dryRun=true ⇒ 返回 DryRunReport 后立刻收尾：不写库、不发 probe、不改缓存、不取信号量（只读预演）；
 * - 否则破坏性变更（下游有引用且命中判定表）必须有调用方 migration 声明才放行，未声明以 migration_required
 *   拒绝（发生在 PUT 之前 ⇒ 一次写都不发生）；声明只记录、不触发任何自动迁移。
 * - 设计时内容为空/缺失 ⇒ 基线不可用：不做破坏性判定（breaking.level='unknown'、闸门跳过）+ 响亮标注
 *   （fail-open，见 baselineUnavailable 注释）——**未判 ≠ 判为非破坏**，形状上必须可区分。
 */
export async function updateCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  packageId: string,
  objectName: string,
  input: { xml?: string; operations?: ViewUpdateOperation[] },
  opts: {
    ifMatch?: string;
    activate?: boolean;
    probeRows?: number;
    /** true=只读预演（SSD §5.1）：算 diff/影响半径/破坏性判定后返回 DryRunReport，不发起任何写入 */
    dryRun?: boolean;
    /** 破坏性变更的显式声明位（SSD §5.4）：未声明时破坏性变更被拒绝。
     *  取值 = 字段级迁移策略（cast/preserve_column/move）或 acknowledge_dependents（显式承担、不做字段级迁移）。 */
    migration?: { strategy: MigrationDeclaration; note?: string };
  } = {},
  client?: XsRestClient,
): Promise<UpdateCalculationViewResult | DryRunReport> {
  assertWritePackageAllowed(packageId, objectName);
  assertSafeObjectName(objectName, '视图');
  const hasOperations = input.operations !== undefined && input.operations.length > 0;
  if (hasOperations && input.xml) throw new HanaBusinessError('xml 与 operations 二选一，请勿同时提供');
  if (!hasOperations && !input.xml) {
    throw new HanaBusinessError('需要提供 xml（全量 XML 更新）或 operations（声明式操作补丁）之一');
  }
  // 入口统一归一：显式传空串/纯空白不能当「有基线」——否则会静默退化成「无 If-Match 写」，
  // 且因 ifMatch !== undefined 而不产生 updateNote（「是否带 If-Match」与「无基线」的说明字段必须同口径）。
  // 归一后空串与未提供完全同路径：能带 If-Match 时才带，带不了必有 updateNote。
  const baseline = opts.ifMatch?.trim() || undefined;

  const startedAt = Date.now();
  // 写入全程复用同一 XS 会话（读基线 → 变换 → PUT）：省掉一次登录往返，也让读到的基线
  // 与写出的 If-Match 出自同一会话视角
  const { rest, file: designFile } = designTimeTarget(config, objectName, client);
  // 写临界区（keyed lock）覆盖「基线读 → 内容读 → 判定 → PUT」**整段**：
  // - 基线在锁内取（读时取 + 锁内取）⇒ 锁内不再有他人写入，不会出现两个并发 update 各自读基线再互相覆盖；
  // - operations 的逐条变换（含 add_join 的源视图读取）也在锁内，变换基线与 PUT 同源；
  // - 破坏性判定（diff 基线读 + 影响半径查询）同样在锁内：diff 基线与判定一致，且 DryRunReport.base 与
  //   写入路径出自同一次 fileMeta 读（dryRun 只读，取锁不引入副作用，只是与写路径同序排队）；
  // - 锁内顺序 keyed lock → 网络/DB；激活信号量在 writeFile 内部取（晚于本锁，全局锁序不反转）；
  // - 锁不可重入：本临界区内不再取同一把锁（updateViaRest 只做 PUT）。
  // 调用方显式传 ifMatch 时以传入值为准（跨调用强一致场景；空串/纯空白已在入口归一为「未提供」）；
  // 此时那次 fileMeta 读仍保留为存在性检查（对象不存在 → 立即失败，不会经 PUT 误建）。
  // 注意：全量 xml 的内容由调用方给出，若其基于更早的一次读取，服务端无从得知 ——
  // 返回 envelope 里的 412 是唯一的冲突信号，需要更强保证请显式传 ifMatch。
  const outcome = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<UpdateLockOutcome> => {
      const baseMeta = await rest.fileMeta(packageId, designFile);
      // 设计时读取的 ETag 同样归一（空串/纯空白不当有值）：与入口归一同一口径，updateNote 的
      // === undefined 判断才不会漏报「本次没带 If-Match」
      const ifMatch = baseline ?? (baseMeta.ETag?.trim() || undefined);
      let xml: string;
      let beforeXml: string;
      let operationsResult: UpdateCalculationViewResult['operationsResult'];
      let xmlVerification: FullXmlGuardResult | undefined;
      if (hasOperations) {
        // 变换基线取设计时文件当前内容（与 ETag 同会话读取），而非已激活版本（ACTIVE_OBJECT）：
        // 存在未激活的挂起改动时，若以激活版为基线变换再覆盖设计时文件会静默丢失挂起工作。
        const designTimeXml = await rest.fileContent(packageId, designFile);
        if (!designTimeXml || designTimeXml.trim() === '') {
          throw new HanaBusinessError(`视图 ${packageId}/${objectName} 无设计时内容，无法应用 operations`);
        }
        const { xml: updatedXml, applied } = await applyViewUpdateOperations(pool, input.operations!, designTimeXml);
        operationsResult = {
          applied,
          xmlBytes: { before: designTimeXml.length, after: updatedXml.length },
        };
        // diff 基线与变换基线同源（设计时当前内容）；operations 分支无需额外读取
        beforeXml = designTimeXml;
        xml = updatedXml;
      } else {
        // 全量通道护栏：解析性 + scenario id 一致性 + logicalModel 重接线（手工改 XML 两大高频事故，激活前拦下）
        xmlVerification = guardFullXmlUpdate(input.xml!, objectName);
        // SQL 读取范围兜底（与 set_script / create(mode=sql) / import 同一实现，不给全量覆盖留旁路）：
        // 工具层扫描器只认**限定名**；<definition> 里的**未限定表名**按当前用户的默认 schema 解析，
        // 只有服务层查得到 CURRENT_SCHEMA——不补这一道，`SELECT * FROM MARA` 可经本通道把默认 schema
        // 的取数写进仓库（写入即激活），HANA_READ_SCHEMA 对未限定表名的兜底在此半边落空。
        // 首次解析（guardFullXmlUpdate 内）已通过，这里对同一输入二次解析必然成功（同一解析器、确定性）。
        for (const script of definitionScriptsOf(parseViewDefinition(input.xml!))) {
          await assertScriptReadScopes(pool, script);
        }
        // xml 模式的判定/预演基线同样取设计时当前内容（与 operations 分支同源），故在同一锁临界区内
        // 补一次**纯读**（基线读 → 内容读 → 判定 → PUT 仍同临界区，锁序不反转）
        beforeXml = await rest.fileContent(packageId, designFile);
        xml = input.xml!;
      }

      // 判定三件套（dryRun 与闸门共用同一份计算——两处各算一遍必然漂移）：影响半径 → 设计时下游过滤 → 结构 diff → 破坏性判定。
      // 影响半径 seed 用**调用方原名**（本通道的 objectName 就是裸对象名），**不复用锁键的 normalizeObjectName**：
      // 图节点名必须与 _SYS_REPO.ACTIVE_OBJECTCROSSREF 的 OBJECT_NAME 精确等值，而归一会把「本身就以设计时
      // 后缀结尾的合法对象名」（如 A.calculationview）剥成另一个节点 A ⇒ downstream 判空、migration 闸门静默放行。
      // 锁键保留归一（那是「同一设计时文件」的口径，与图节点名是两回事）。
      // depth: 1 显式写死（= impact() 的默认值）：判定/回执只认**直接下游（单跳）**，每次写都跑全闭包代价太大；
      // 写死是为了防止将来有人改 impact 的默认值、让判定口径静默变化——需要传递影响面请用 hana_metadata_where_used(depth>1)。
      const impactResult = await impact(
        pool,
        {
          packageId,
          objectName,
          objectSuffix: 'calculationview',
        },
        { depth: 1 },
      );
      const { diff, breaking, downstream, runtimeOnly, baselineUnavailable } = assessUpdateBreaking(
        beforeXml,
        xml,
        impactResult,
      );

      if (opts.dryRun) {
        // 预演的**唯一**出口：此返回之后不写库、不发 probe、不改缓存、不取信号量（本函数在锁外直接返回报告）
        return {
          kind: 'dryRun' as const,
          report: buildDryRunReport({
            baseMeta,
            beforeXml,
            afterXml: xml,
            diff,
            breaking,
            impactResult,
            downstream,
            runtimeOnly,
            baselineUnavailable,
            migration: opts.migration,
          }),
        };
      }
      // D2 闸门：破坏性变更必须有声明才放行；拒绝发生在 PUT **之前** ⇒ 一次写都不发生。
      // 基线不可用时 breaking 是「未判」（level='unknown'，unknown ≠ 'breaking'）⇒ 本行自然跳过——
      // 这正是基线不可用时的 fail-open 落点。
      assertMigrationDeclared(breaking, opts.migration, `更新 ${packageId}/${objectName}`);

      // 显式挑字段：opts 还带 probeRows（供行探测用），不得作为写参数透传给 updateViaRest
      const meta = await updateViaRest(config, packageId, objectName, xml, { ifMatch, activate: opts.activate }, rest);
      // ifMatch 一并带出锁体：基线缺失（既没显式传、设计时读取也没拿到 ETag）要让回执如实说明，
      // 不能只留在锁内（与 activate 的 activateNote 同形）
      return {
        kind: 'write' as const,
        meta,
        ifMatch,
        operationsResult,
        xmlVerification,
        breaking,
        runtimeOnly,
        baselineUnavailable,
      };
    },
  );

  if (outcome.kind === 'dryRun') {
    // 预演到此为止：零副作用——缓存不失效（没写）、行探测不发起（没有「刚写入并激活」的前提）
    return outcome.report;
  }
  const { meta, ifMatch, operationsResult, xmlVerification, breaking, runtimeOnly, baselineUnavailable } = outcome;
  // 回执的诚实性提示（与 dryRun 回执共用同一份文案常量——两处各写一遍必然漂移）：
  // - 基线不可用：未判（breaking.level='unknown'，unknown ≠ 非破坏）；
  // - 影响半径截断：breaking.impactTruncated 为真时附同一句警告（与 dryRun 回执一字不差）。
  const warnings: string[] = [];
  if (baselineUnavailable) warnings.push(BASELINE_UNAVAILABLE_WARNING);
  if (breaking.impactTruncated) warnings.push(IMPACT_TRUNCATED_WARNING);
  // 写后失效视图缓存（§4.5）：紧贴写路径，把「最多 60s 后自愈」变成「立即」
  invalidateViewCache(packageId, objectName);
  const activated = meta.Attributes?.SapBackPack?.Activated === true;
  const detail = activationDetailOf(meta);
  // 基线缺失是**静默退化**吗？不——与 activate 同形：回执给 updateNote + 日志留痕（仅该情形产生字段，
  // 不制造恒为空噪音）。说明句与 delete/activate 两处共用同一骨架（noIfMatchNote），只有补救指引按动作传入。
  let updateNote: string | undefined;
  if (ifMatch === undefined) {
    updateNote = noIfMatchNote(
      '设计时元数据读取未返回 ETag（且未显式提供 ifMatch）',
      '更新',
      '需要并发保护请先自行读取基线并显式传 ifMatch',
    );
    logger.warn({ packageId, objectName }, updateNote);
  }
  // 行探测：对象确实激活后才探（同 create，让"激活成功但 0 行"当场可见）
  const rowProbe = await probeIfActivated(pool, packageId, objectName, activated, opts.probeRows);
  return {
    object: { packageId, objectName, objectSuffix: 'calculationview' },
    updated: true,
    activated,
    ...(detail ? { activationErrors: activationSummary(detail), activationDetail: detail } : {}),
    meta: stripInternalMeta(meta),
    // 回执基线：etag/etagSource/version 与 meta 同一次写响应（响应头 ETag + SapBackPack），不二次读取不拼装。
    // meta 仍按现状 stripInternalMeta 后透出——它现在会带上响应头 ETag 与 etagSource，这是有意的新基线。
    ...writeReceiptBaseline(meta),
    // 成功回执必带上判定与闸门记录（非破坏时只报告：level='none'、required=false）；
    // 基线不可用时 breaking 是「未判」空壳（level='unknown'）、闸门已跳过（migration.required 如实为 false，
    // unknown 不等于判定为非破坏），由 baselineUnavailable + warnings 响亮标注。
    breaking,
    migration: migrationGateRecord(breaking, opts.migration),
    // 被过滤掉的运行时目录引用条数照实带出（>0 才产生，不制造恒为空噪音）：与删除回执同口径，不许静默过滤。
    ...(runtimeOnly > 0 ? { runtimeOnly } : {}),
    ...(baselineUnavailable ? { baselineUnavailable: true } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    ...(operationsResult ? { operationsResult, elapsedMs: Date.now() - startedAt } : {}),
    ...(xmlVerification ? { xmlVerification } : {}),
    ...(rowProbe ? { rowProbe } : {}),
    ...(updateNote ? { updateNote } : {}),
  };
}

/* ── 破坏性判定与迁移闸门（update 与 delete 共用的判定/拒绝/回执组装）────── */

/**
 * 设计时下游引用（判定输入，**直接下游（单跳）**口径：impact() 默认 depth=1）与运行时引用条数——
 * update 闸门与删除闸门**共用同一份过滤**（一处实现，别写两遍：两个闸门各写一份的那天，过滤口径必然漂移成两种行为）。
 * 判定刻意只认单跳：每次写都要跑一遍，全闭包代价太大；需要传递影响面请用 hana_metadata_where_used(depth>1)。
 *
 * 实测事实（2026-10-08 真实库只读核证）：全库 **2277 个 calculationview 无一例外**都带一条
 * `__RT_CATALOG_VIEW__` 后继行——激活后的运行时目录视图引用本对象自身（isRuntime 的判定见
 * catalog.service.ts:81 与 metadata.service.ts:290 的既有说明）。
 * 因此 `impact()` 的 nodes 对**任何已激活对象恒非空**；不过滤 ⇒「已激活视图的普通删除」与
 * 「任何已激活对象的 DryRun」会被一律判成破坏，删除闸门会拦截所有已激活对象的删除
 * （实测：不加过滤会把本可正常执行的删除一律拦下）。
 * 过滤理由：下游判定只认**设计时引用**——设计时引用才是会因 schema/定义变更而断的东西；
 * 运行时目录视图是激活链自动生成的伴生品、随对象生命周期起落，不构成「下游消费者」。
 * 返回值 runtimeOnly = 被过滤掉的条数：调用方**如实上报**（回执的 runtimeOnly 字段），不许静默过滤。
 */
function designTimeDownstream(impactResult: ClosureResult): { downstream: GraphEdge[]; runtimeOnly: number } {
  const downstream = impactResult.nodes.filter((e) => !e.isRuntime);
  return { downstream, runtimeOnly: impactResult.nodes.length - downstream.length };
}

/**
 * 删除闸门的**判定件**（impact → 运行时引用过滤 → assessViewDeletion）——`deleteCalculationView` 与
 * `applyChangeset` 的整体预检**共用同一实现**（两处各写一份时，「这次删除会不会被拦」的判定
 * 必然漂移成两种行为）。
 * 只判定、不抛错：拒绝由调用点施加（单对象路径走 assertMigrationDeclared；批次预检要一次收齐
 * 全部被拦项，不能在第一项上被异常打断）。
 */
export interface DeletionGateAssessment {
  breaking: BreakingAssessment;
  /** 被过滤掉的运行时目录引用条数（回执如实带出，不许静默过滤；见 designTimeDownstream） */
  runtimeOnly: number;
  /** 判定读取时点（impact().asOf）：判定与 DELETE 之间存在依赖新增窗口，调用方据此核对 */
  asOf: string;
}

/**
 * 评估「删除某个对象」是否命中破坏性判定表（SSD §5.3 最后一行）。
 * 判定用的对象名用**调用方原名**（delete 通道的 objectName 就是裸对象名）：图节点名必须与
 * ACTIVE_OBJECTCROSSREF 的 OBJECT_NAME 精确等值，归一会把「本身以设计时后缀结尾的合法对象名」
 * （如 A.calculationview）剥成 A ⇒ 判到另一个（通常不存在的）节点、downstream 判空。
 * 锁键的归一（writeLockKey 用 normalizeObjectName）与图节点名是两件事，不可复用。
 * depth: 1 显式写死（= impact() 的默认值）：判定/回执只认**直接下游（单跳）**，语义见 designTimeDownstream。
 */
export async function assessDeletionGate(
  pool: HanaPool,
  packageId: string,
  objectName: string,
): Promise<DeletionGateAssessment> {
  const impactResult = await impact(pool, { packageId, objectName, objectSuffix: 'calculationview' }, { depth: 1 });
  const { downstream, runtimeOnly } = designTimeDownstream(impactResult);
  const breaking = assessViewDeletion({ packageId, objectName }, { downstream, truncated: impactResult.truncated });
  return { breaking, runtimeOnly, asOf: impactResult.asOf };
}

/**
 * 基线不可用时的统一告警句（dryRun 回执与写路径回执共用同一句——两处各写一遍必然漂移）。
 * 口径：**不做判定 + 响亮标注**（fail-open）。为什么不是 fail-closed：空串设计时内容是一个**假基线**，
 * 拿它判 diff 会把「无基线」读成「全部新增」，据此拦截会把合法写入误拦——与本仓探测类失败的既有口径
 * 一致（如行探测失败只进 rowProbe.error，不影响写入结果），宁可放行并如实标注，也不拿假基线拦人。
 */
const BASELINE_UNAVAILABLE_WARNING = '设计时内容为空，无法建立 diff 基线：本次未做破坏性判定';

/**
 * 影响半径被截断时的统一告警句（dryRun 回执与写路径回执共用同一句——两处各写一遍必然漂移）。
 * 截断 = 达到 impact() 的节点上限：级别照判（截断不改变「有没有下游」），但 downstream 列表与
 * downstreamCount 只是下界，判定可能低估影响面。两条通道必须一字不差。
 */
const IMPACT_TRUNCATED_WARNING =
  '影响半径检索被截断（达到节点上限）：downstream 列表与 downstreamCount 只是下界，破坏性判定可能低估影响面';

/**
 * 无基线时的**空壳占位** diff 工厂：只在 baselineUnavailable=true 时使用（每次返回新对象，
 * 避免共享可变常量被调用方就地改坏）。它**不是比较结果**（没有可比较的基线），必须与回执的
 * baselineUnavailable + warnings 一起读。刻意不产出「空定义 vs 新 XML」的真 diff：
 * 那会把「无基线」显示成「全部新增」，把读者引向错误结论。
 */
function emptyViewDiff(): ViewDiff {
  return {
    empty: true,
    dataSources: { added: [], removed: [], changed: [] },
    nodes: { added: [], removed: [], changed: [] },
    output: { changed: false },
    outputs: { added: [], removed: [], changed: [] },
    variables: { added: [], removed: [], changed: [] },
    root: { changed: [] },
  };
}

/**
 * 判定用的解析：解析失败转成可读业务错误，不裸抛。
 * 为什么：裸抛（fast-xml-parser 的 Error）会被工具层当成未知内部错误（SdkError），调用方看不出是 XML 的问题；
 * 「判不了」不等于「不是破坏性」——**基线存在但解析不了**时 fail-closed（不写入），而不是静默跳过闸门。
 * 与「基线不可用」（设计时内容为空）刻意区别：那是不存在可信基线，不能拿它判（fail-open + 标注，见
 * BASELINE_UNAVAILABLE_WARNING）；这里是基线和内容都在、只有解析这一层失败，如实报错才是诚实。
 */
function parseForAssessment(xml: string, label: string): ViewDefinition {
  try {
    return parseViewDefinition(xml);
  } catch (e) {
    throw new HanaBusinessError(
      `${label}无法解析，破坏性判定无法执行（未发起写入）：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}

/**
 * 更新判定的核心件（dryRun 与写路径共用同一份计算——两处各算一遍必然漂移）：
 * 设计时下游过滤（运行时 __RT_* 目录引用是激活链伴生品，见 designTimeDownstream）→ 基线可用性 →
 * 结构 diff → 破坏性判定。返回 downstream/runtimeOnly 供回执组装直接引用（判定与回执同源）。
 * 基线不可用（设计时内容为空/纯空白：对象只有激活版本没有设计时内容，或文件被清空）时**不做判定**：
 * 拿空定义当 diff 基线会把「无基线」读成「全部新增」，据此拦截会误拦本可放行的写——宁可 fail-open +
 * 响亮标注（见 BASELINE_UNAVAILABLE_WARNING），也不拿假基线拦人。
 */
function assessUpdateBreaking(
  beforeXml: string,
  xml: string,
  impactResult: ClosureResult,
): {
  diff: ViewDiff;
  breaking: BreakingAssessment;
  downstream: GraphEdge[];
  runtimeOnly: number;
  baselineUnavailable: boolean;
} {
  // 下游判定只认设计时引用：运行时 __RT_* 目录引用在这里被过滤（实测事实与理由见 designTimeDownstream）；
  // 删除闸门走同一个助手——一处实现，两个闸门的过滤口径不会漂移。
  const { downstream, runtimeOnly } = designTimeDownstream(impactResult);
  const baselineUnavailable = beforeXml.trim() === '';
  let diff: ViewDiff;
  let breaking: BreakingAssessment;
  if (baselineUnavailable) {
    // 不做判定：diff 只给**空壳占位**（不可当真）；breaking.level='unknown' 把「未判」钉进形状
    // （unknown ≠ 非破坏：判定从未执行必须与「判为非破坏」在形状上可区分）；migration.required 因此如实为
    // false——**不做判定 ≠ 判定为非破坏**（unknown 不是 breaking，不判就不拦）。
    // level='unknown' 由 migrate.rules.BreakingAssessment 承载（跨代理冻结接口：none | breaking | unknown）。
    diff = emptyViewDiff();
    breaking = {
      level: 'unknown',
      items: [],
      downstreamCount: downstream.length,
      impactTruncated: impactResult.truncated,
    };
  } else {
    diff = diffViewDefinitions(parseForAssessment(beforeXml, '当前设计时内容'), parseForAssessment(xml, '新的 XML'));
    breaking = assessBreaking(diff, { downstream, truncated: impactResult.truncated });
  }
  return { diff, breaking, downstream, runtimeOnly, baselineUnavailable };
}

/**
 * 闸门谓词（**单一实现**）：破坏性且未声明 ⇒ 该动作会被拒。
 * `assertMigrationDeclared`（单对象路径：判到即抛）与 `applyChangeset` 的整体预检（批次：判而不抛，
 * 把整批被拦项一次收齐再统一拒绝）共用同一谓词——两处各写一份时，预检与执行期闸门的口径必然漂移。
 */
export function migrationGateRejected(
  breaking: BreakingAssessment,
  migration: { strategy: string; note?: string } | undefined,
): boolean {
  return breaking.level === 'breaking' && migration === undefined;
}

/**
 * D2 闸门（SSD §5.4）：破坏性变更必须有调用方的显式 migration 声明才放行；只判定与拒绝，
 * **不做任何自动迁移动作**（自动改下游视图超出本服务边界，交给编排层按影响半径处理）。
 * 拒绝点在任何写动作之前 ⇒「一次写都不发生」；消息只陈述事实（命中哪几条 rule/target + 限制由服务端
 * 判定施加），**不给补救指引**（SSD §1.3：写明怎么放行等于教调用方绕过）；机读材料在 rawDetail.breaking.items。
 * level='unknown'（基线不可用 ⇒ 未判）不是 breaking ⇒ 不拦（不判就不拦；unknown ≠ 非破坏，由回执标注）。
 */
function assertMigrationDeclared(
  breaking: BreakingAssessment,
  migration: { strategy: string; note?: string } | undefined,
  actionLabel: string,
): void {
  if (!migrationGateRejected(breaking, migration)) return;
  throw HanaBusinessError.withRawDetail(
    `${actionLabel} 被拒绝：本次变更命中 ${breaking.items.length} 项破坏性规则` +
      `（${summarizeBreakingItems(breaking.items)}），调用方未声明 migration 迁移策略。` +
      `该限制由服务端在写入之前判定施加，本次未发生任何写入。`,
    'migration_required',
    // 机读载荷：调用方据此逐条决定策略（计划 §4.2）；形状与成功回执的 breaking 字段一致
    { breaking },
  );
}

/** 破坏项一行摘要（消息里的人读部分；机读部分在 rawDetail/回执的 items）：超过 5 条折为「等共 N 项」 */
export function summarizeBreakingItems(items: BreakingAssessment['items']): string {
  const shown = items.slice(0, 5).map((item) => `${item.rule}(${item.target})`);
  return items.length > shown.length ? `${shown.join('、')}、等共 ${items.length} 项` : shown.join('、');
}

/**
 * 闸门结果记录（回执审计）。`accepted` = 闸门结论：写路径走到回执时必然为 true（否则早已被拒）；
 * dryRun 里它回答「同样的调用去掉 dryRun 会不会被放行」——预演需要能看见未声明时会被拒的事实。
 * level='unknown'（基线不可用 ⇒ 未判）⇒ required=false / accepted=true：不判就不拦（unknown ≠ 非破坏）。
 */
function migrationGateRecord(
  breaking: BreakingAssessment,
  migration: { strategy: string; note?: string } | undefined,
): MigrationGateRecord {
  return {
    required: breaking.level === 'breaking',
    ...(migration ? { provided: migration.strategy } : {}),
    // 与单对象路径的闸门谓词**同一实现**（`accepted = !rejected`）：两处各写一份必然漂移。
    accepted: !migrationGateRejected(breaking, migration),
    ...(migration?.note ? { note: migration.note } : {}),
  };
}

/**
 * 组装 dryRun 回执（SSD §5.1 形状）。
 * base/impact 都必须与判定同源：base 取自锁内那次 fileMeta 读，impact 就是本次判定的那次影响半径查询
 * （两处各查一次会给出互相矛盾的版本/半径，预演就不可信了）。
 * 两处过滤/占位在组装期如实标注、不静默：下游列表已剔运行时引用（runtimeOnly 给条数）；
 * 基线不可用时 warnings 给一句、baselineUnavailable 置位（diff/breaking 是空壳占位，别当真）。
 */
function buildDryRunReport(args: {
  baseMeta: FileMeta;
  beforeXml: string;
  afterXml: string;
  diff: ViewDiff;
  breaking: BreakingAssessment;
  impactResult: ClosureResult;
  /** 已过滤运行时引用的下游列表（与 breaking 判定同源：同一份 designTimeDownstream 结果，直接下游单跳） */
  downstream: GraphEdge[];
  /** 被过滤掉的运行时引用条数（>0 才在回执里产生该字段） */
  runtimeOnly: number;
  /** 基线不可用（未做判定；diff/breaking 为空壳占位） */
  baselineUnavailable: boolean;
  migration: { strategy: string; note?: string } | undefined;
}): DryRunReport {
  const base: DryRunReport['base'] = {};
  const version = args.baseMeta.SapBackPack?.Version;
  if (version !== undefined) base.versionId = String(version);
  const etag = args.baseMeta.ETag?.trim();
  if (etag) base.etag = etag;
  // 诚实性提示（有则列、无则空数组）：只列「调用方可能误读回执」的几类事实
  const warnings: string[] = [];
  if (args.baselineUnavailable) {
    warnings.push(BASELINE_UNAVAILABLE_WARNING);
  }
  if (args.impactResult.truncated) {
    warnings.push(IMPACT_TRUNCATED_WARNING);
  }
  // 基线不可用时 diff 是空壳占位（empty=true 而非「比较结果」）：此时不许给出「文本有变化但不判为变更」的提示
  // （那句只在真的比较过、结论为「无结构差异」时才成立）——否则会把「未判」误读成「已判为无变更」。
  if (!args.baselineUnavailable && args.diff.empty && args.beforeXml !== args.afterXml) {
    warnings.push('归一化比较后无结构差异：原始 XML 文本有变化（布局/文档序/聚合方言等写法差异），这些差异不判为变更');
  }
  return {
    mode: 'dryRun',
    base,
    diff: args.diff,
    breaking: args.breaking,
    impact: {
      downstream: args.downstream,
      truncated: args.impactResult.truncated,
      asOf: args.impactResult.asOf,
      ...(args.runtimeOnly > 0 ? { runtimeOnly: args.runtimeOnly } : {}),
    },
    migration: migrationGateRecord(args.breaking, args.migration),
    warnings,
    ...(args.baselineUnavailable ? { baselineUnavailable: true } : {}),
  };
}

/** 删除结果（回执基线是**删除前**读到的 ETag/版本——对象删掉后没有可读的基线） */
export interface DeleteCalculationViewResult {
  object: { packageId: string; objectName: string; objectSuffix: 'calculationview' };
  deleted: boolean;
  /** 删除前读到的基线 ETag（缺省 = 删除前读也没拿到，回执如实缺省，不拼装） */
  etag?: string;
  /** 基线来源：删除前读（'read-back'）；删除前读未拿到 ETag 时为 'unavailable' */
  etagSource?: EtagSource;
  /** 删除前读到的服务端版本号（与 etag 同一次读取） */
  version?: number;
  /** ETag 基线缺失、本次删除退回无 If-Match 旧行为时的如实说明（正常路径不产生该字段） */
  deleteNote?: string;
  /**
   * 破坏性判定（**直接下游（单跳）**有引用 ⇒ level='breaking'；无引用 ⇒ 'none'；判定/回执都用
   * impact() 的默认 depth=1 口径，需要传递影响面请用 hana_metadata_where_used 的 depth>1）。
   * 成功回执必然带出（只报告，不阻断）。
   * 下游只计**设计时引用**：运行时 __RT_* 目录引用已在判定输入处过滤（见 designTimeDownstream 的实测说明，
   * 不过滤的话任何已激活对象的删除都会被误拦）。
   */
  breaking?: BreakingAssessment;
  /** 迁移声明闸门记录（删除通道的声明位 strategy 固定为 acknowledge_dependents；形状见 MigrationGateRecord） */
  migration?: MigrationGateRecord;
  /**
   * 判定读取时点（impact().asOf，进程时区 ISO 秒级）：删除闸门的判定发生在锁**外**，判定与 DELETE
   * 之间存在依赖新增窗口（见 deleteCalculationView 头注）——本字段是下游集合的读取时点，调用方据此
   * 判断窗口大小（判定之后新增的依赖不会体现在 breaking/下游计数里）。
   */
  impactAsOf: string;
  /**
   * 判定输入中被过滤掉的**运行时目录引用**条数（>0 才产生该字段，不制造恒为空噪音；见 designTimeDownstream）。
   * 与 update 回执同口径：downstreamCount + runtimeOnly = 本次单跳检索的原始节点数，过滤可复核、不静默。
   */
  runtimeOnly?: number;
}

/**
 * 删除 Calculation View 设计时对象（XS REST：锁内取基线 + If-Match DELETE；412/404 以机读码透出）。
 *
 * 破坏性判定（SSD §5.3 判定表「删除整个视图」行 + §5.4 / D2 闸门——**对 SSD 的扩展**）：
 * SSD §5.4 只写了 update 的 migration 参数，但判定把「删除整个视图（下游有引用）」列为破坏、
 * 处置口径是「先解除依赖或调用方显式承担」，D2 又要求破坏性变更阻断 ⇒ 按最忠实读法：删除同样进闸门，
 * 声明位 strategy 固定为 acknowledge_dependents（删除没有可自动化的迁移策略）。
 * 下游无引用 ⇒ 不阻断，回执带 breaking.level='none'。
 * 「下游」= **直接下游（单跳）的设计时下游**（impact() 默认 depth=1）：运行时 __RT_* 目录引用在判定
 * 输入处过滤（与 update 闸门共用 designTimeDownstream）——实测每个已激活对象都带一条
 * __RT_CATALOG_VIEW__ 自引用行，不过滤则本闸门会拦截所有已激活对象的删除。
 * 影响半径查询放在锁**外**（deleteViaRest 自持锁且锁不可重入；更根本地，**本对象的锁挡不住别人加依赖**——
 * 加依赖是去写「依赖方」对象，取的是依赖方的锁。放锁内只会拉长临界区、买不到任何保护；跨进程真相
 * 仍是 ETag + 服务端语义，见 SSD §4.1）。判定与 DELETE 之间的依赖新增窗口由此如实存在——回执带
 * impactAsOf（判定读取时点），调用方据此核对窗口；判定刻意只认单跳（每次写都跑全闭包代价太大），
 * 需要传递影响面请用 hana_metadata_where_used(depth>1)。
 *
 * `opts.ifMatch`（可选）：调用方传入**预读**的删除基线（变更集 delete 项用），
 * 使「预读 → 删除」之间的第三方写入以 412 暴露（该项 conflict_external）；不传 = 锁内自取删除前基线。
 */
export async function deleteCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: {
    migration?: { strategy: 'acknowledge_dependents'; note?: string };
    /**
     * 调用方**预读**的删除基线（可选、向后兼容）：透传给 deleteViaRest 作为 DELETE 的
     * If-Match ⇒ 「预读 → 删除」之间的第三方写入必得 412（不再被锁内重取的基线吸收）。
     * 不传 = 锁内自取删除前基线（单对象通道语义）。
     */
    ifMatch?: string;
  } = {},
  client?: XsRestClient,
): Promise<DeleteCalculationViewResult> {
  assertWritePackageAllowed(packageId, objectName);
  assertSafeObjectName(objectName, '视图');
  // 判定件与变更集整体预检共用（assessDeletionGate：impact → 运行时引用过滤 → assessViewDeletion）——
  // 两处各写一份时「这次删除会不会被拦」的判定必然漂移（见该函数头注）。
  const gate = await assessDeletionGate(pool, packageId, objectName);
  // D2 闸门：下游有引用且未声明 ⇒ 在 DELETE 之前拒绝（一次写都不发生；deleteViaRest 尚未被调用）
  assertMigrationDeclared(gate.breaking, opts.migration, `删除 ${packageId}/${objectName}`);
  const baseline = await deleteViaRest(config, packageId, objectName, client, opts.ifMatch);
  // 写后失效视图缓存（§4.5）：删除也是写（运行时对象下线由服务端激活链处理，缓存立即失效更诚实）
  invalidateViewCache(packageId, objectName);
  const result: DeleteCalculationViewResult = {
    object: { packageId, objectName, objectSuffix: 'calculationview' },
    deleted: true,
    etag: baseline.etag,
    etagSource: baseline.etag !== undefined ? 'read-back' : 'unavailable',
    version: baseline.version,
    // 成功回执必带上判定与闸门记录（无下游时只报告：level='none'、required=false）
    breaking: gate.breaking,
    migration: migrationGateRecord(gate.breaking, opts.migration),
    // 判定读取时点（impact().asOf）：判定在锁外、与 DELETE 之间有依赖新增窗口（见函数头注）——
    // 如实带出「下游集合是什么时刻读的」，调用方据此核对窗口（判定之后新增的依赖不体现在本次判定里）。
    impactAsOf: gate.asOf,
    // 被过滤掉的运行时目录引用条数照实带出（>0 才产生）：与 update 回执同口径，不许静默过滤。
    ...(gate.runtimeOnly > 0 ? { runtimeOnly: gate.runtimeOnly } : {}),
  };
  // 基线缺失是**静默退化**吗？不——与 activate 同形：回执给 deleteNote + 日志留痕（仅该情形产生字段）。
  if (baseline.ifMatchMissing) {
    result.deleteNote = noIfMatchNote(
      '删除前元数据读取未返回 ETag',
      '删除',
      '需要并发保护请先自行读取基线（读取 → 核对 → 再删除）',
    );
    logger.warn({ packageId, objectName }, result.deleteNote);
  }
  return result;
}

/* ── operations 声明式补丁（修改 CV 零 XML）──────────────────
 * 由 updateCalculationView 的 operations 模式调用：读当前定义 → 逐条确定性变换 → 复用原 PUT 路径。
 * 变换规则与 BW query 视图生成器同款（范本：ZDEMOBI/COPYOFZDEMO01_CV034_1 的 join 链），
 * 全部在服务端确定性完成——模型只传声明式参数，不读也不生成 XML。 */

/** 视图类型 → DataSource resourceUri 的目录段名 */
const KIND_URI_SEGMENT: Record<string, string> = {
  calculationview: 'calculationviews',
  attributeview: 'attributeviews',
  analyticview: 'analyticviews',
};

/**
 * operations 模式的逐条变换（由 updateCalculationView 在写临界区内调用）：以设计时当前内容为基线，
 * 按声明顺序应用操作，返回变换后的 XML 与逐条明细。除 add_join 要读 join 源视图外，其余 op 都只改
 * 当前视图自身（无跨包读取）；set_script 的脚本要过读取范围判定（限定名按 schema 白名单、
 * 未限定名按 CURRENT_SCHEMA，见 assertScriptReadScopes）。
 * 任一条失败即抛错、不产出半成品——变换全部在 PUT 之前完成，失败时一次写都不发生。
 */
async function applyViewUpdateOperations(
  pool: HanaPool,
  operations: readonly ViewUpdateOperation[],
  designTimeXml: string,
): Promise<{ xml: string; applied: AppliedOperationResult[] }> {
  const applied: AppliedOperationResult[] = [];
  let currentXml = designTimeXml;
  for (const op of operations) {
    // 未知 op id 的兜底（工具层 zod 之外的脚本/内部调用）：getViewOp 未命中即抛中文硬错误并列出合法值；
    // 不加这一道，拼错的 id 会落进链尾的 add_join 分支被当 add_join 处理。
    getViewOp(op.op);
    // 按 op 分派：add_join 读源视图定义后接线；其余 op 都只改当前视图自身（无跨包读取），
    // 口径面对（set_attribute_filter / set_variable）同样零跨对象访问——读取范围声明是空的。
    if (op.op === 'set_script') {
      await assertScriptReadScopes(pool, op.script);
      const r = setScriptInViewXml(currentXml, op);
      applied.push({
        op: 'set_script',
        scriptNodeId: r.scriptNodeId,
        attributeCount: r.attributeCount,
        measureCount: r.measureCount,
        scriptBytes: r.scriptBytes,
      });
      currentXml = r.xml;
    } else if (op.op === 'set_description') {
      // 形状校验（别静默无操作）：两个字段都没给 = 调用方漏参，入口即拒（与 view-edit 的守卫同义）
      if (op.description === undefined && op.displayName === undefined) {
        throw new HanaBusinessError(
          'set_description 需要至少给出 description 或 displayName 之一（两者都没给 = 无操作，已拒绝）',
        );
      }
      const r = setDescriptionInViewXml(currentXml, op);
      applied.push({ op: 'set_description', changed: r.changed });
      currentXml = r.xml;
    } else if (op.op === 'rename_field') {
      const r = renameFieldInViewXml(currentXml, op);
      applied.push({ op: 'rename_field', field: r.field, newName: r.newName, kind: r.kind });
      currentXml = r.xml;
    } else if (op.op === 'drop_field') {
      const r = dropFieldFromViewXml(currentXml, op.field);
      applied.push({ op: 'drop_field', field: r.field, kind: r.kind, remaining: r.remaining });
      currentXml = r.xml;
    } else if (op.op === 'add_calculated_column') {
      const r = addCalculatedColumnToViewXml(currentXml, op);
      applied.push({ op: 'add_calculated_column', node: r.node, name: r.name, order: r.order });
      currentXml = r.xml;
    } else if (op.op === 'set_attribute_filter') {
      const r = setAttributeFilterInViewXml(currentXml, op);
      applied.push({
        op: 'set_attribute_filter',
        node: r.node,
        attribute: r.attribute,
        including: r.including,
        replaced: r.replaced,
      });
      currentXml = r.xml;
    } else if (op.op === 'set_variable') {
      const r = setVariableInViewXml(currentXml, op);
      applied.push({ op: 'set_variable', variableId: r.variableId, changed: r.changed });
      currentXml = r.xml;
    } else {
      const r = await applyAddJoinOperation(pool, op, currentXml);
      applied.push(r.result);
      currentXml = r.xml;
    }
  }
  return { xml: currentXml, applied };
}

/**
 * 应用一条 add_join 操作（读源视图定义 + 确定性变换；不写库）：
 * 1. 校验条件/字段名（join 条件左字段必须是当前输出节点已有字段；右字段必须是源视图输出字段）
 * 2. 读源视图定义取可用字段目录（1 次 SQL）
 * 3. 解析带出字段（显式校验，缺省自动选择）
 * 4. view-edit 变换：新增 DataSource + Projection + Join，logicalModel 重接线（字符串手术零损耗）
 */
async function applyAddJoinOperation(
  pool: HanaPool,
  op: AddJoinOperation,
  currentXml: string,
): Promise<{ xml: string; result: AddJoinOperationResult }> {
  assertSafeObjectName(op.sourcePackageId, 'join 源包');
  assertSafeObjectName(op.sourceObjectName, 'join 源视图');
  // 条件数与条件字段的守卫留在本层：本函数是服务层公共 API（脚本/内部调用不经过工具面 zod），
  // 非法输入应在读 join 源（1 次 SQL）之前失败。工具面 schema 对条件数有同一上限（.max(10)），
  // 两处同值是有意的重复——放宽其一必须同步另一个，否则工具面能过、服务层拒。
  if (op.conditions.length === 0) {
    throw new HanaBusinessError('join 条件不能为空：至少提供一组 {leftField, rightField}');
  }
  if (op.conditions.length > 10) {
    throw new HanaBusinessError('join 条件过多（>10 组），请确认建模意图');
  }
  for (const c of op.conditions) {
    assertSafeRuntimeName(c.leftField, 'join 条件左字段');
    assertSafeRuntimeName(c.rightField, 'join 条件右字段');
  }
  for (const f of op.fields ?? []) {
    assertSafeRuntimeName(f, '带出字段');
  }
  const joinType = op.joinType ?? 'leftOuter';
  const target = getJoinTargetAttrs(currentXml);

  // 源视图定义（可用字段目录）
  const source = await getViewDefinition(pool, op.sourcePackageId, op.sourceObjectName);
  const sourceKind = source.definition?.kind ?? source.object.objectSuffix;
  if (!source.definition) {
    throw new HanaBusinessError(`join 源 ${op.sourcePackageId}/${op.sourceObjectName} 无可解析定义（无 CDATA）`);
  }
  const sourceAttrs = source.definition.outputs.attributes;
  if (sourceAttrs.length === 0) {
    throw new HanaBusinessError(
      `join 源 ${op.sourcePackageId}/${op.sourceObjectName} 没有输出属性字段，无法作为 join 源`,
    );
  }
  const sourceAttrById = new Map(sourceAttrs.map((a) => [a.id, a]));
  const uriSegment = KIND_URI_SEGMENT[sourceKind];
  if (!uriSegment) {
    throw new HanaBusinessError(`join 源类型 ${sourceKind} 不受支持（仅 calculationview/attributeview/analyticview）`);
  }

  // join 条件右字段必须是源视图的**输出字段**：右字段拼错也要在写入前拦下——引用不存在列的 XML
  // 一旦覆盖设计时文件，只能靠服务端激活兜底/再写一次修正。
  // 可选目录并入全部输出类别（属性/计算属性/度量）：它们都是源视图对外暴露的列，join on 计算键
  // 在 BW 场景真实存在；只收 attributes 会把合法调用误拒。
  const sourceOutputIds = new Set<string>([
    ...sourceAttrs.map((a) => a.id),
    ...source.definition.outputs.calculatedAttributes.map((a) => a.id),
    ...source.definition.outputs.measures.map((m) => m.id),
    ...source.definition.outputs.calculatedMeasures.map((m) => m.id),
    ...source.definition.outputs.restrictedMeasures.map((m) => m.id),
  ]);
  for (const c of op.conditions) {
    if (!sourceOutputIds.has(c.rightField)) {
      throw new HanaBusinessError(
        `join 条件右字段 "${c.rightField}" 不存在于 join 源 ${op.sourceObjectName}。` +
          `可用字段：${[...sourceOutputIds].join(', ')}`,
      );
    }
  }

  // 解析带出字段（显式校验，缺省自动选择）。
  // 本循环只做「需要源视图目录/当前输出节点目录」的校验（存在性、与条件右字段重复、与左侧字段重名）；
  // 变换层不变量（条件非空、带出字段重复、与左侧字段重名）由 view-edit 兜底硬拒——本层同判的只有
  // 「条件非空」与「与左侧字段重名」两项，属纵深防御（服务层被直接调用时不把正确性押在 model 层）；
  // 「带出字段重复」本层**不判**（唯一硬拒在 view-edit）。**不去重**：重复字段是要报错的输入，
  // 静默收敛会让「带了却少带」无从察觉（与变更集载荷「静默忽略比报错更难查」同一口径）。
  const conditionRightFields = op.conditions.map((c) => c.rightField);
  let fieldIds: string[];
  let fieldSelectionNote: string | undefined;
  if (op.fields && op.fields.length > 0) {
    for (const f of op.fields) {
      if (!sourceAttrById.has(f)) {
        throw new HanaBusinessError(
          `带出字段 "${f}" 不存在于 join 源 ${op.sourceObjectName}。可用字段：${sourceAttrs.map((a) => a.id).join(', ')}`,
        );
      }
      if (conditionRightFields.includes(f)) {
        throw new HanaBusinessError(
          `带出字段 "${f}" 同时是 join 条件右字段：该字段已通过条件映射进入 join，无需重复带出`,
        );
      }
      if (target.attributes.includes(f)) {
        throw new HanaBusinessError(
          `带出字段 "${f}" 与当前视图已有字段同名（输出节点 ${target.nodeId}），会产生冲突；请去除该字段`,
        );
      }
    }
    fieldIds = [...op.fields];
  } else {
    fieldIds = chooseDefaultJoinFields(sourceAttrs, conditionRightFields, target.attributes);
    fieldSelectionNote =
      `fields 未指定：已自动带出源视图可见属性中可新增的 ${fieldIds.length} 个字段` +
      `（排除 join 条件字段与左侧已有字段；hidden 字段不带出）`;
  }

  const sourceResourceUri = `/${source.object.packageId}/${uriSegment}/${source.object.objectName}`;
  const edit = addJoinToViewXml(currentXml, {
    sourceId: source.object.objectName,
    sourceResourceUri,
    joinType,
    conditions: op.conditions,
    fields: fieldIds.map((id) => ({ id, description: sourceAttrById.get(id)?.description })),
  });

  return {
    xml: edit.xml,
    result: {
      op: 'add_join',
      source: {
        packageId: source.object.packageId,
        objectName: source.object.objectName,
        kind: sourceKind,
        resourceUri: sourceResourceUri,
      },
      join: {
        joinType,
        conditions: op.conditions,
        joinAttributeNames: edit.joinAttributeNames,
        previousFinalNode: edit.previousFinalNodeId,
        newJoinNode: edit.newJoinNodeId,
        newProjectionNode: edit.newProjectionNodeId,
        dataSourceId: edit.newDataSourceId,
      },
      addedOutputFields: edit.addedOutputFields.map((f) => ({
        ...f,
        description: sourceAttrById.get(f.id)?.description,
      })),
      ...(fieldSelectionNote ? { fieldSelectionNote } : {}),
    },
  };
}

/**
 * 新建 Calculation View：
 * 1. 校验包（写边界由 HANA_WRITE_PACKAGES 配置）/对象名/源 schema
 * 2. 检查对象不存在
 * 3. 取源列 → 生成设计时 XML
 * 4. 按通道写入仓库（repo_rest 直通 REST；inactive_object 直写 INACTIVE_OBJECT）—— 与存在性检查一起
 *    构成串行临界区（见下）
 * 5.（可选）激活
 * 注：client 为**可选共享会话**（与 updateCalculationView/deleteCalculationView 的既有形状对齐）——
 * 变更集内多对象批复用一个会话（省掉逐对象登录往返），单测也可注入桩；既有调用点零改动。
 */
export async function createCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  input: CreateCalcViewInput,
  client?: XsRestClient,
): Promise<CreateCalcViewResult> {
  assertWritePackageAllowed(input.packageId, input.objectName);
  assertSafeObjectName(input.objectName, '视图');

  const mode = input.mode ?? 'projection';

  // 快速失败（权威检查在下方临界区内复核）：对象已存在时不必再取源列、生成 XML
  if (await objectExists(pool, input.packageId, input.objectName)) {
    throw new HanaBusinessError(
      `对象 ${input.packageId}/${input.objectName} 已存在，拒绝覆盖。请换一个对象名或先删除旧对象`,
    );
  }

  let xml: string;
  let measureCount: number;
  /** 回执警告（仅在确有需要如实标注的事实时产生；projection 取列分支填充，见 resolveColumns） */
  const columnWarnings: string[] = [];
  /** projection 分支实际使用的 measureMode（0 度量时的回执文案要按它区分原因，不许再建议"用 SUM_NUMERIC 重建"） */
  let measureModeUsed: 'SUM_NUMERIC' | 'ALL_ATTRIBUTES' | undefined;
  if (mode === 'sql') {
    // SQL 模式：单 SqlScriptView + <definition> SQL，输出列由调用方声明（datatype 必填）
    if (!input.scripted) {
      throw new HanaBusinessError('mode=sql 需要提供 scripted（script + columns），或改用 mode=projection');
    }
    await assertScriptReadScopes(pool, input.scripted.script);
    xml = buildScriptedCalcViewXml({
      ...input.scripted,
      objectName: input.objectName,
      description: input.description,
    });
    measureCount = input.scripted.columns.filter((c) => c.isMeasure === true).length;
  } else {
    if (!input.source) {
      throw new HanaBusinessError('mode=projection 需要提供 source（schema + name），或改用 mode=sql');
    }
    assertSchemaAllowed(input.source.schema);
    const resolved = await resolveColumns(pool, input.source);
    const columns = resolved.columns;
    // 显式列中类型未解析（元数据目录被 500 列上限截断，无法确认列是否存在）：如实进回执 warnings，
    // 并说明它对度量判定的影响（缺类型 = 非数值 ⇒ SUM_NUMERIC 下不计入度量）
    if (resolved.unresolvedTypes.length > 0) {
      columnWarnings.push(
        `显式列 ${resolved.unresolvedTypes.join(', ')} 的类型未能从 ${input.source.schema}/${input.source.name} 列目录解析` +
          `（目录超过 ${AUTO_COLUMN_LIMIT} 列上限被截断，无法确认列是否存在）：这些列按「非数值」参与度量判定；` +
          '如需要它们在 SUM_NUMERIC 下成为度量，请先确认源表列类型',
      );
    }
    if (resolved.truncated) {
      // 源表列数超上限时只映射前 500 列——绝不按「全列」口径静默建视图（缺列要到查询出数才暴露）
      columnWarnings.push(
        `源表 ${input.source.schema}/${input.source.name} 的列数超过自动取列上限（${AUTO_COLUMN_LIMIT}）：` +
          `本次仅映射前 ${AUTO_COLUMN_LIMIT} 列（measureCount 也只按这些列统计）；` +
          '需要完整列清单请显式传 columns（或改用 mode=sql 指定输出列）',
      );
    }
    const measureMode = input.source.measureMode ?? 'ALL_ATTRIBUTES';
    xml = buildMinCalcViewXml({
      objectName: input.objectName,
      description: input.description,
      schema: input.source.schema,
      table: input.source.name,
      columns: columns.map((c) => ({ columnName: c.columnName, dataTypeName: c.dataTypeName })),
      measureMode,
    });

    // 度量计数（与 builder 的 SUM_NUMERIC 判定一致：数值类型进 baseMeasures）
    // 类型表单点定义在 model/view-types（与 view-builder 共用同一份），
    // 回执里的度量数必须与生成的 XML 用同一判定，否则两边都"看起来对"却互相矛盾。
    measureCount = measureMode === 'SUM_NUMERIC' ? columns.filter((c) => isNumericType(c.dataTypeName)).length : 0;
    measureModeUsed = measureMode;
  }

  const result: CreateCalcViewResult = {
    object: { packageId: input.packageId, objectName: input.objectName, objectSuffix: 'calculationview' },
    xml,
    wrote: false,
    measureCount,
    mode,
    ...(columnWarnings.length > 0 ? { warnings: columnWarnings } : {}),
  };
  if (measureCount === 0) {
    result.activationNote =
      '本环境（SPS08 实测）激活要求视图至少包含 1 个度量（40117 "No measures defined"）。' +
      (mode === 'sql'
        ? '当前 SQL 模式视图无度量列：把至少一个数值输出列的 columns[].isMeasure 置为 true，否则只能保存设计时对象'
        : measureModeUsed === 'SUM_NUMERIC'
          ? // measureMode 本来就是 SUM_NUMERIC 时不许再「建议用 SUM_NUMERIC 重建」（空转建议）；
            // 真因是源表（或显式列）里没有被判为数值的列，如实指出即可
            '当前视图在 measureMode=SUM_NUMERIC 下没有数值类型的列（类型取自源表列目录）：' +
            '请核对源表与显式列名（显式列的类型由源表列目录补齐；类型缺失的列按非数值处理），' +
            '或改用 measureMode=ALL_ATTRIBUTES 明确只要属性'
          : '当前视图无度量，仅可保存设计时对象；measureMode=ALL_ATTRIBUTES 下所有列都是属性，' +
            '如需度量请改用 measureMode=SUM_NUMERIC（需源表含数值列）');
  }

  const transport = input.transport ?? 'xs_rest';
  // 写临界区（keyed lock，key=包/归一后的对象名）：存在性复核 + 写入必须原子。
  // 仓库 PUT 是 create-or-update（服务端不会返回 409），两个并发同名 create 会双双通过入口检查，
  // 后者静默覆盖前者；ETag 乐观锁覆盖不到这条路径，故进程内按对象互斥。
  // 锁不可重入：本临界区内不再取同一把锁——后面的「非 xs_rest 后置激活」在锁外调用
  // activateCalculationView（它自己会取同一把锁），锁先释放再取，不成重入。
  await withKeyedLock(writeLockKey(input.packageId, normalizeObjectName(input.objectName)), async () => {
    if (await objectExists(pool, input.packageId, input.objectName)) {
      throw new HanaBusinessError(
        `对象 ${input.packageId}/${input.objectName} 已存在，拒绝覆盖` +
          `（并发创建冲突：本次请求处理期间已有同名对象建成）。请换一个对象名或先删除旧对象`,
      );
    }
    if (transport === 'xs_rest') {
      // 官方 REST 写路径（PUT create-or-update）。实测：合法模型「写入即激活」，
      // activated 为写入后的实测状态（非请求参数）；激活检查失败明细从响应体 CheckResult 透出。
      // 激活失败（HTTP 555 + Write:true）时 writeFile 按非致命结果返回——文件已写入、只是没激活，
      // 这里照常回报 activated=false + 完整明细，调用方一次调用即可定位。
      const meta = await updateViaRest(
        config,
        input.packageId,
        input.objectName,
        xml,
        {
          activate: input.activate ?? false,
        },
        client,
      );
      result.wrote = true;
      result.activated = meta.Attributes?.SapBackPack?.Activated === true;
      const detail = activationDetailOf(meta);
      if (detail) {
        result.activationErrors = activationSummary(detail);
        result.activationDetail = detail;
      }
      // 回执基线：etag/etagSource/version 与 activated 读数取自**同一次写响应**（响应头 ETag + SapBackPack），
      // 不二次读取不拼装（§4.2#1 约定：回执里的读数必须来自同一时刻的同一次读取）
      const receiptBaseline = writeReceiptBaseline(meta);
      const version = receiptBaseline.version;
      result.etag = receiptBaseline.etag;
      result.etagSource = receiptBaseline.etagSource;
      result.version = receiptBaseline.version;
      // 跨进程并发迹象（诚实化）：写入前锁内检查为「不存在」而写后版本号 > 1 ⇒ **通常**意味着期间有他人写过。
      // 措辞刻意写成可证伪的推断（免责句见 VERSION_CONCURRENCY_CAVEAT）。没有并发迹象时不产生该字段（不制造恒为空噪音）。
      if (version !== undefined && version > 1) {
        result.concurrencyNote =
          `写入后版本号为 ${version}（>1）：这通常意味着本次调用期间有他人写过同名对象，` +
          `本次写入可能覆盖了对方的内容（PUT 为 create-or-update、服务端没有 409 前置，` +
          `跨进程同名创建属 last-write-wins 的已知例外）；${VERSION_CONCURRENCY_CAVEAT}。` +
          `需要并发保护请在写入前读取基线并显式传 ifMatch`;
      }
    } else if (transport === 'inactive_object') {
      await writeViaInactiveObject(pool, input.packageId, input.objectName, xml, config.timezone);
      result.wrote = true;
      result.manualActivateHint =
        `设计时对象已写入 _SYS_REPO.INACTIVE_OBJECT（${input.packageId}/${input.objectName}），` +
        `请在 HANA Studio 中打开该对象并执行「激活」（直写内部表非官方支持，供 ZDEMO 验证用）`;
    } else {
      await writeViaRepoRest(pool, input.packageId, input.objectName, xml);
      result.wrote = true;
    }
  });

  // 写后失效视图缓存（§4.5）：写成功才失效；失败路径整段抛出，缓存本就未被本次写入污染
  if (result.wrote) invalidateViewCache(input.packageId, input.objectName);

  if (result.wrote && input.activate && transport !== 'xs_rest') {
    result.activated = await activateCalculationView(config, pool, input.packageId, input.objectName, 'repo_rest').then(
      () => true,
      (e) => {
        result.activationErrors = e instanceof HanaBusinessError ? e.message : String(e);
        return false;
      },
    );
  }

  // 行探测：对象确实激活后才探，避免在未激活对象上做无意义查询
  const rowProbe = await probeIfActivated(
    pool,
    input.packageId,
    input.objectName,
    result.activated === true,
    input.probeRows,
  );
  if (rowProbe) result.rowProbe = rowProbe;

  return result;
}

/** 激活回执（transport + 写响应 meta + 回执基线；repo_rest 通道不产生 etag/version） */
export interface ActivateCalculationViewResult {
  transport: string;
  meta?: FileMeta;
  repoResp?: RepoRestResponse;
  /** 激活写回执的新基线（xs_rest：写响应头 ETag；缺省 = 响应头没给，语义见 etagSource） */
  etag?: string;
  /** etag 的来源（见 EtagSource；'response-header'=写响应头同刻读数，'unavailable'=响应头未带 ETag） */
  etagSource?: EtagSource;
  /** 激活后的服务端版本号（SapBackPack.Version；与 etag 同一次写响应读取，不拼装） */
  version?: number;
  /** ETag 基线缺失、退回无 If-Match 旧行为时的如实说明（正常路径不产生该字段） */
  activateNote?: string;
}

/**
 * 激活 Calculation View：xs_rest=PUT+SapBackPack.Activate+If-Match（官方写路径）；repo_rest=裸 repoV2（兼容，部分环境会 40106）。
 * 临界区（keyed lock，与 update/create/delete/validate/import 同键）包住 activateViaRest 的锁内三步；
 * create 的「非 xs_rest 后置激活」也经本函数走同一条锁 + 同一条错误语义
 * （create 的锁在调用它之前已释放，不存在重入——withKeyedLock 不是可重入锁）。
 */
export async function activateCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  packageId: string,
  objectName: string,
  transport: 'xs_rest' | 'repo_rest' = 'xs_rest',
  client?: XsRestClient,
): Promise<ActivateCalculationViewResult> {
  assertWritePackageAllowed(packageId, objectName);
  // 对象名守卫：与 create/update/delete/import/validate 同形——含 '/' 或 '..' 的对象名会直达
  // XS REST URL 路径拼接（encodePath 的纵深防御之外，入口守卫集合必须一致）。
  // 工具面 zod 虽已挡，脚本/内部调用不经过它。
  assertSafeObjectName(objectName, '视图');
  const lockKey = writeLockKey(packageId, normalizeObjectName(objectName));
  if (transport === 'xs_rest') {
    const { meta, ifMatch } = await withKeyedLock(lockKey, () =>
      activateViaRest(config, packageId, objectName, client),
    );
    // 显式激活的语义就是「必须激活成功」：writeFile 对 555（写成功/激活失败）按非致命返回，
    // 这里必须把失败重新显性化——否则调用方拿到 success:true 却面对一个未激活的对象
    // （工具描述承诺「失败会透传编译错误明细（不误报成功）」）。
    if (meta.Attributes?.SapBackPack?.Activated !== true) {
      const detail = activationDetailOf(meta);
      const errDetail = detail?.message ?? describeActivationFailure(meta);
      // 原始载荷与 create/update 路径同形（envelope.raw.errorDetail）；只填有值的槽，构造函数签名不变
      throw HanaBusinessError.withRawDetail(
        `激活失败：${packageId}/${objectName} 写入成功但未激活。${errDetail}`,
        detail?.errorCode,
        { httpStatus: meta['_httpStatus'], ...(detail ?? {}) },
      );
    }
    // 写后失效视图缓存（§4.5）：激活成功即运行时对象换版，立即失效比等 TTL 更诚实
    invalidateViewCache(packageId, objectName);
    const result: ActivateCalculationViewResult = { transport: 'xs_rest', meta };
    // 回执基线：etag/etagSource/version 与 meta 同一次写响应（响应头 ETag + SapBackPack），不拼装
    const receiptBaseline = writeReceiptBaseline(meta);
    result.etag = receiptBaseline.etag;
    result.etagSource = receiptBaseline.etagSource;
    result.version = receiptBaseline.version;
    // **先**读 etag/version 再剥仅供进程内判定的内部字段（`_httpStatus`）：与 create/update 的成功回执
    // 同形（那两处都走 stripInternalMeta），不把内部字段泄漏给调用方
    result.meta = stripInternalMeta(meta);
    if (!ifMatch) {
      // 基线缺失（理论上不该发生）：本次激活退回无 If-Match 旧行为——并发第三方修改不会被 412 拦截。
      // 如实体现（回执 + 日志），不静默。本通道没有可传入基线的参数，故不给补救指引。
      result.activateNote = noIfMatchNote('fileMeta 未返回 ETag，无法建立 If-Match 基线', '激活');
      logger.warn({ packageId, objectName }, result.activateNote);
    }
    return result;
  }
  // repo_rest：信号量在锁内取（全局锁序 keyed lock → 信号量 → DB）。xs_rest 的激活信号量已在
  // writeFile 内部取——此处绝不重复取，也不在函数顶层包裹（limit=1 时会自锁死）。
  const resp = await withKeyedLock(lockKey, () =>
    withSemaphore(ACTIVATION_SEMAPHORE, config.activationConcurrency ?? ACTIVATION_CONCURRENCY_DEFAULT, () =>
      repositoryRest(pool, {
        action: 'activate',
        what: 'objects',
        activationMode: 'activate',
        objects: [{ package: packageId, name: objectName, suffix: 'calculationview' }],
      }),
    ),
  );
  assertNoRepoRestError(resp, 'activate');
  // 写后失效视图缓存（§4.5）
  invalidateViewCache(packageId, objectName);
  return { transport: 'repo_rest', repoResp: resp };
}

/** 激活检查未通过但响应体没有 CheckResult 时的兜底说明 */
function describeActivationFailure(meta: FileMeta & { CheckResult?: WriteCheckResult }): string {
  return meta.CheckResult
    ? '激活检查未通过（响应体 CheckResult 明细见 raw.errorDetail）'
    : '服务端未返回 Activated=true（未见 CheckResult 明细；可用 hana_view_validate 复核）';
}

/* ── 设计时校验（激活前 Check）────────────────────────
 * 实测定案（SPS08）：本 SPS 上所有写动词对合法模型
 * 一律「写入即激活」（裸 PUT / Activate / Workspace / Check 全相同），Check 只是能把激活检查
 * 结果放进响应体。因此「无副作用的设计时校验」= 临时副本方案：
 *   内容写到 <截断基名>_<短哈希>_CHKTMP 临时对象（附 Check，读 CheckResult 判定）→ 删除临时对象。
 * 短哈希掺入**进程随机 nonce**（见 tempCheckName）：进程内同名恒定（残片可自愈）、跨进程永不撞名
 * （互不干扰）；副本归属由「不可猜的名字 + 进程内登记表」证明，不再按对象实例验身份（见下）。
 * 校验通过与否，原对象的激活状态都不受影响（合法副本被激活后随删除一起下线）。 */

/** 设计时校验（临时副本 Check）结果 */
export interface DesignCheckResult {
  packageId: string;
  objectName: string;
  /** true=激活检查通过；false=激活将失败 */
  consistent: boolean;
  /** 不一致时的编译/激活错误明细 */
  errors?: string;
  /** 服务端错误码（如 40117） */
  errorCode?: string;
  /** 临时校验对象名（正常路径校验后已删除；删除未完成时见 tempResidue） */
  tempObject: string;
  /**
   * 临时副本清理**未完成**（仅在异常路径产生该字段）：残留物仍在仓库里，且可能**已被激活为运行时对象**
   * （本 SPS 写入即激活），需要人工或后续调用清理。reason = 失败原因（经 redactSensitive 脱敏：本字段
   * 会进**成功信封**的 data，脱敏口径必须与失败信封一致）。校验本身也抛错时，同一残留信息会挂到抛出的
   * 错误上（消息含残留对象名 + rawDetail，见 withTempResidueDetail）——「清理失败不静默」对调用方同样成立。
   */
  tempResidue?: { tempObject: string; reason: string };
}

/** 临时校验对象名总长上限：HANA 对象名上限 30 字符，留 1 字符安全余量 ⇒ 29（SSD §4.1 validate 行写死） */
export const TEMP_CHECK_NAME_MAX = 29;

/** 临时副本固定后缀（7 字符，含前导下划线） */
const TEMP_CHECK_SUFFIX = '_CHKTMP';

/** 短哈希长度（sha256 十六进制前 6 位） */
const TEMP_CHECK_HASH_LEN = 6;

/** 基名预算（由总长上限反推）：29 − 7（后缀）− 6（哈希）− 1（分隔下划线）= 15 */
const TEMP_CHECK_BASE_BUDGET = TEMP_CHECK_NAME_MAX - TEMP_CHECK_SUFFIX.length - TEMP_CHECK_HASH_LEN - 1;

/**
 * 进程唯一随机段（nonce）：进程启动时生成一次（node:crypto 的 randomBytes，**不用 Math.random**——
 * 它不保证跨进程唯一性，且可被他进程猜出）。掺进短哈希的输入后：
 * - 同一进程内对同一对象名恒定同名 ⇒ 上次中断遗留的登记残片可被本进程后续调用认领清理；
 * - 跨进程永不撞名 ⇒ 甲进程的残留清理不可能删到乙进程正在用的副本（实测删除链：只按对象名推导
 *   临时名时，跨进程同名会让一方的清理删到另一方的副本）。
 * 已知边界：进程重启后 nonce 翻新，旧名残片不再被新进程推导命中（不会被误删，但只能人工清理）。
 */
const TEMP_CHECK_PROCESS_NONCE = randomBytes(6).toString('hex');

/**
 * 临时校验对象名（**内部用途**，导出仅供单测断言）：截断基名 + '_' + 短哈希 + '_CHKTMP'，总长 ≤ 29。
 * 哈希 = sha256(**完整**对象名 + '|' + 进程 nonce) 前 6 位十六进制（node:crypto）：进程内确定性可复现，
 * 跨进程必然不同名（nonce = 48 位随机）。哈希覆盖**完整**对象名的作用：两个前缀相同但长度不同的
 * 对象名截断后不再撞成同一个临时名（只按截断前缀派生时两者会撞，且截断长度也满足不了 29 字符预算）。
 */
export function tempCheckName(objectName: string): string {
  return tempCheckNameWithNonce(objectName, TEMP_CHECK_PROCESS_NONCE);
}

/**
 * 带显式 nonce 的名字推导（**仅单测断言跨进程隔离用**）：同一对象名 + 不同 nonce ⇒ 不同临时名。
 * 生产路径一律走 tempCheckName——进程 nonce 不暴露，调用方拼不出非本进程的名字。
 */
export function tempCheckNameWithNonce(objectName: string, nonce: string): string {
  const hash = createHash('sha256')
    .update(`${objectName}|${nonce}`, 'utf8')
    .digest('hex')
    .slice(0, TEMP_CHECK_HASH_LEN);
  return `${objectName.slice(0, TEMP_CHECK_BASE_BUDGET)}_${hash}${TEMP_CHECK_SUFFIX}`;
}

/**
 * 本进程「创建过的临时校验对象」登记集合（键 = 包名/临时文件名）。
 * 不变量（明确断言）：登记表只可能记录「本进程用**本进程 nonce** 推导出的名字」——
 * 唯一写入点紧跟 tempCheckName 之后，且删除只允许删登记过的名字。
 * 推论（fail-closed）：一个带本进程 nonce 的名字若已存在却不在登记表里，只可能是「他人猜到了本进程
 * 随机段」（nonce = 48 位随机，实际等价于该名字已被一份**真实对象**占用）⇒ 按撞真实对象处理：
 * 不写不删 + 抛 TEMP_NAME_CONFLICT。反之，登记在册的名字按构造就是我们的副本，删/覆盖都无越界风险
 * （上次中断的残留因此可被下一次同对象校验自愈）。
 * 进程重启：登记表清空且 nonce 翻新——旧名残片不会被新进程推导命中（不会被误删，但需人工清理）。
 */
const tempCheckRegistry = new Set<string>();

/** 清空临时校验登记（**仅测试用**：跨用例隔离，与 resetKeyedLocks 对称） */
export function resetTempCheckRegistry(): void {
  tempCheckRegistry.clear();
}

/**
 * 把「临时校验副本清理未完成」的残留信息附加到**校验自身抛出的错误**上：
 * checkFile 抛错与清理失败同时发生时，调用方不能只看到「校验失败」却看不到仓库里还留着一个
 * （可能已激活的）副本——消息里给残留对象名，rawDetail 给结构化残留载荷。
 * HanaBusinessError 的机读槽位（code/sqlState/messages/diagnosis）原样搬运，不因附加残留而丢失；
 * 非业务错误包成 withRawDetail 形状（rawDetail 经失败信封的 errorDetail 透传）。
 */
function withTempResidueDetail(
  err: unknown,
  packageId: string,
  tempFile: string,
  residue: NonNullable<DesignCheckResult['tempResidue']>,
): HanaBusinessError {
  const base = err instanceof Error ? redactSensitive(err.message) : redactSensitive(String(err));
  const message =
    `${base}。另外，临时校验副本清理未完成：残留对象 ${packageId}/${tempFile} 仍在仓库中` +
    `（本 SPS 写入即激活，可能已是运行时对象），需人工或后续校验流程清理`;
  if (err instanceof HanaBusinessError) {
    // 该路径的 checkFile 失败载荷只有 message（xs-rest 不加 rawDetail），故 rawDetail 槽可安全装残留载荷
    const rebuilt = new HanaBusinessError(message, err.code, err.sqlState, err.messages, err.diagnosis, residue);
    if (err.conflict) rebuilt.conflict = err.conflict;
    return rebuilt;
  }
  return HanaBusinessError.withRawDetail(message, undefined, residue);
}

/**
 * 对设计时对象做「激活前校验」（临时副本 + Check，原对象不受影响；可写包边界由 HANA_WRITE_PACKAGES 配置）。
 * 并发（§4.1 validate 行）：
 * - 内容读取在锁内（与写入序列同源：锁外读时，窗口内的并发写入会让校验对象与当时的设计时内容名实不符）；
 * - 临时名由 tempCheckName 按「对象名 + 进程 nonce」推导（总长 ≤29、带短哈希）：进程内同名恒定、
 *   跨进程永不撞名。同一进程的并发校验互删副本、跨进程的残留互删都从命名层消除；
 *   锁只需把「探测 → 预清理 → 写入校验 → 收尾清理」整段按对象串行化；
 * - 写入前探测推导名是否已是既有对象：**存在且不在登记表里** ⇒ 不写不删、抛 TEMP_NAME_CONFLICT（如实报告）。
 * 为什么**不**用 If-Match 按「对象实例」验身份（该机制已否决，**勿再加回**）：
 *   ① 预清理的基线取自**本次探测读数**，恒等于当前占用者 ⇒ 它只能证明「这个名字上有对象」，
 *      证明不了「它属于本进程」——自指，挡不住跨进程同名时的误删（实测删除链：留残片的一方登记未撤销时，
 *      后续进程探测到同一占用者、用本次读数当基线，把它删掉）；
 *   ② 归属现在由「不可猜的 nonce 名 + 进程内登记表」证明（见 tempCheckRegistry 不变量），实例基线不再承担该职责；
 *   ③ 同一进程内 checkFile 的写会推进 ETag，旧基线做 If-Match 必得伪 412，重试路径会把自己的副本误报成残片。
 * 失败语义：推导名撞无法归属的同名对象时**抛错**（而不是 skipped 回执）——校验未执行不是校验结果，
 * 失败信封可机读、也不会让调用方把「没执行」误当成「通过」。
 */
export async function checkCalculationViewDesignTime(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  client?: XsRestClient,
): Promise<DesignCheckResult> {
  assertWritePackageAllowed(packageId, objectName);
  assertSafeObjectName(objectName, '视图');
  const { rest, file } = designTimeTarget(config, objectName, client);
  const tempObject = tempCheckName(objectName);
  const tempFile = designTimeFile(tempObject);
  const registryKey = `${packageId}/${tempFile}`;
  // 临界区（keyed lock，key=包/归一后的对象名）：同一对象的并发校验会推导出同一个临时名，
  // 并行会让一方删到另一方正在用的副本——把「探测 → 预清理 → 写入校验 → 收尾清理」整段按对象串行化。
  // 锁不可重入：本临界区内不再取同一把锁（fileContent/fileMeta/checkFile/deleteFile 都不取锁）。
  return withKeyedLock(writeLockKey(packageId, normalizeObjectName(objectName)), async () => {
    // 内容快照与写入序列同源：设计时内容在锁内读，否则锁内写入的将是锁外读到的旧快照
    const content = await rest.fileContent(packageId, file);
    // 写入前探测：推导名是否**已是既有对象**——404（OBJECT_NOT_FOUND，xs-rest 契约）视为不存在；
    // 其它错误（403/网络等）必须 rethrow——吞掉会让故障中的调用方误删/误写真实对象。
    let tempExists = false;
    try {
      await rest.fileMeta(packageId, tempFile);
      tempExists = true;
    } catch (e) {
      if (!isObjectNotFoundError(e)) throw e;
    }
    if (tempExists && !tempCheckRegistry.has(registryKey)) {
      // 推导名已被占用且不在登记表里 ⇒ 按撞真实对象处理（登记表不变量见 tempCheckRegistry 注释）：
      // 临时名含本进程启动时生成的随机段，他人持有它等价于「猜到了本进程的随机段」。不写不删、明确失败。
      // 选择「明确失败」而非 skipped 回执：校验未执行不是校验结果，失败信封可机读、
      // 也不会让调用方把「没执行」误当成「通过」。
      throw new HanaBusinessError(
        `临时校验对象 ${packageId}/${tempFile} 已是既有对象且不属于本进程：本次校验未执行（不写不删）。` +
          `临时名含本进程启动时生成的随机段，按构造只有本进程能推导出它——出现同名占用等价于` +
          `「该名字已被一份真实对象占用」（或极小概率的截断哈希撞名）。` +
          `请人工确认该名字的占用者后处理（重命名或删除）再重试`,
        'TEMP_NAME_CONFLICT',
      );
    }
    // 预清理（登记表里有 = 本进程上次中断的残留；best-effort）：只删登记过的名字——那名字按构造
    // 就是我们的副本，覆盖自己的残片无风险，故**任何失败都不阻断写入**；失败只记账（logger.warn，不静默）。
    if (tempCheckRegistry.has(registryKey)) {
      try {
        await rest.deleteFile(packageId, tempFile);
      } catch (e) {
        // 404 = 残片已不存在（清理完成）；其它失败如实记账，随后照常重写这个名字
        if (!isObjectNotFoundError(e)) {
          logger.warn(
            { packageId, tempObject, err: e },
            '临时校验残片预清理失败：不阻断本次校验（名字按构造属于本进程，覆盖无风险），随后照常写入',
          );
        }
      }
    }
    // 写入前登记：只有登记过的名字才允许被清理（归属证明 = 进程内登记表 + 不可猜的 nonce 名）
    tempCheckRegistry.add(registryKey);
    let consistent = false;
    let errors: string | undefined;
    let errorCode: string | undefined;
    let tempResidue: DesignCheckResult['tempResidue'] = undefined;
    let checkFailed = false;
    let checkFailure: unknown;
    try {
      const r = await rest.checkFile(packageId, tempFile, content);
      consistent = r.consistent;
      errors = r.message;
      errorCode = r.errorCode;
    } catch (e) {
      // 校验自身的失败先留住，不在此抛出：收尾清理的残留信息要能附加到**同一个**错误上
      checkFailed = true;
      checkFailure = e;
    }
    // 收尾清理本次创建的副本。刻意不用 finally：finally 里无法把残留信息附加到同一刻抛出的异常上
    // （若在 finally 中抛出，调用方只会看到校验失败、看不到残留对象名）。
    // 只删登记过的名字（未登记的名字在探测处已叫停，绝不删）。404 = 已不存在（清理完成）；
    // 其它失败 ⇒ 保留登记（下一次同对象校验认领清理）+ 填 tempResidue + warn，不静默。
    if (tempCheckRegistry.has(registryKey)) {
      try {
        await rest.deleteFile(packageId, tempFile);
        tempCheckRegistry.delete(registryKey);
      } catch (e) {
        if (isObjectNotFoundError(e)) {
          tempCheckRegistry.delete(registryKey);
        } else {
          // reason 经 redactSensitive：tempResidue 会进**成功信封**的 data——脱敏口径与失败信封
          // 一致，防止内网地址/账号经这条路径带出去
          const reason = e instanceof Error ? redactSensitive(e.message) : redactSensitive(String(e));
          tempResidue = { tempObject, reason: `清理未完成：${reason}` };
          logger.warn(
            { packageId, tempObject, err: e },
            '临时校验副本清理未完成：残留可能已被激活为运行时对象，需人工或后续调用清理',
          );
        }
      }
    }
    // 校验失败时残留信息不随异常丢失：挂到抛出的错误上（消息含残留对象名 + rawDetail）
    if (checkFailed) {
      throw tempResidue ? withTempResidueDetail(checkFailure, packageId, tempFile, tempResidue) : checkFailure;
    }
    return {
      packageId,
      objectName,
      consistent,
      errors,
      errorCode,
      tempObject,
      ...(tempResidue ? { tempResidue } : {}),
    };
  });
}
