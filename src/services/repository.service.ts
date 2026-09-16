import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { logger } from '../core/logger.js';
import { currentClientId } from '../core/request-context.js';
import { assertSafeObjectName, assertSafeRuntimeName, assertSchemaAllowed, qualifyName } from '../core/sql.js';
import { isPackageAllowed } from '../config/write-boundary.js';
import { XsRestClient, extractCheckResult, type FileMeta, type WriteCheckResult } from '../core/xs-rest.js';
import type { HanaConfig } from '../config/config.js';
import { buildMinCalcViewXml, buildScriptedCalcViewXml, type ScriptedCalcViewSpec } from '../model/view-builder.js';
import { addJoinToViewXml, chooseDefaultJoinFields, getJoinTargetAttrs, guardFullXmlUpdate, setScriptInViewXml, type FullXmlGuardResult, type SetScriptSpec } from '../model/view-edit.js';
import { getViewDefinition } from './metadata.service.js';

/**
 * 仓库写服务：
 * - REPOSITORY_REST：SYS.REPOSITORY_REST(IN BLOB, OUT BLOB) —— Studio 同款仓库 REST 通道（首选）
 *   协议（实测 + SAP-archive/xsk 开源佐证）：IN/OUT 均为 repoV2 二进制信封 ——
 *     "repoV2"(6B ASCII) + attachmentCount(4B 小端, 原始槽数=1+2*文件数) + contentLength(4B 小端, JSON 字节数)
 *     + JSON UTF-8 + 附件区（每槽 [4B 小端长度][内容]，1 文件=2 槽：名称槽+内容槽；读对象时 XML 在槽 0）。
 * - INACTIVE_OBJECT 直写：兜底（实测 SAPABAP1 无直写权限，实际不可用，保留供有权限账号参考）。
 * 安全护栏：写操作的包名边界由 HANA_WRITE_PACKAGES 配置（空=全部可写；非空=仅配置包及其子包），
 * 对象名校验，凭据不落日志。
 */

/**
 * 允许写操作的仓库包前缀（大写）。进程级，由 configureWritePackages 接线。
 * - 空数组 = 不限制（fail-open：所有包可写，配置项未填时的默认）
 * - 非空 = 仅允许这些包及其下级子包（包名以「配置前缀」或「配置前缀.」开头）
 */
let WRITE_ALLOWED_PACKAGES: string[] = [];

/**
 * 接线写操作包白名单（来自 HANA_WRITE_PACKAGES）。
 * 由 index.ts 启动时调用一次；输入统一转大写、去空白。
 * 空数组 = 不限制（fail-open）；非空 = 仅配置包及其子包可写。
 */
export function configureWritePackages(packages: string[]): void {
  WRITE_ALLOWED_PACKAGES = packages
    .map((p) => p.trim().toUpperCase())
    .filter((p) => p.length > 0);
}

/** 包名安全字符集校验（写操作前纵深防御；值仍参数绑定） */
function isSafePackageName(packageId: string): boolean {
  return /^[A-Za-z0-9_.\-]+$/.test(packageId);
}

/**
 * 校验写入包名是否在配置的可写包范围内，并记录写操作审计日志。
 * - 白名单为空 → 不限制（fail-open，配置未填时的默认）
 * - 白名单非空 → 包名须等于某配置包，或以其为前缀（包名 = 配置包 或 包名以「配置包.」开头）
 *   例：配置 ["ZDEMO","ZDEMO.ZDEMO_SD"] → ZDEMO / ZDEMO.X / ZDEMO.ZDEMO_SD / ZDEMO.ZDEMO_SD.SUB 放行，
 *       ZDEMO.ZDEMO_MKC / ZDEMO 拒绝。
 * 所有写路径（新建/更新/删除/激活/校验/导入/建包）都经本函数，故审计日志挂在此处：
 * HTTP 模式下多个客户端共享同一 HANA 技术账号，仓库侧（_SYS_REPO 的 OWNER/ACTIVATED_BY）
 * 只能看到该账号，归属信息只有进程侧能给。stdio 模式无身份上下文，日志不含 clientId 字段。
 */
export function assertWritePackageAllowed(packageId: string, objectName?: string): void {
  if (!isSafePackageName(packageId)) {
    throw new HanaBusinessError(`包名 "${packageId}" 含非法字符，已拒绝`);
  }
  if (!isPackageAllowed(packageId, WRITE_ALLOWED_PACKAGES)) {
    // 纵深防御（脚本/内部调用不经过工具层闸门）。消息只陈述拦截事实，**不给**绕过方法：
    // 本消息会随 envelope 返回给调用方（通常是模型），写明"改哪项配置可放行"等于教它绕过。
    throw new HanaBusinessError(
      `被 MCP 安全策略拦截：目标包 "${packageId}" 不在服务端配置的可写包范围内` +
        `（生效范围：${WRITE_ALLOWED_PACKAGES.join(', ') || '(空)'}）。请求未执行。`,
    );
  }
  logger.info(
    { clientId: currentClientId(), packageId, ...(objectName ? { objectName } : {}) },
    '仓库写操作请求（审计：记录调用方与目标，结果见返回 envelope）',
  );
}

/**
 * 写临界区的锁 key：包 + 对象。
 * 不同对象的写操作互不阻塞，同一对象上的 check-then-act 序列严格串行。
 */
function writeLockKey(packageId: string, objectName: string): string {
  return `${packageId}/${objectName}`;
}

const u32le = (n: number): Buffer => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n, 0);
  return b;
};

/** repoV2 信封响应：content=JSON，attachments=文件槽 */
export interface RepoRestResponse {
  attachmentCount: number;
  content: Record<string, unknown>;
  attachments: Buffer[];
}

/** 解码 repoV2 响应（无信封的裸 JSON 也能容忍） */
function decodeRepoV2(buf: Buffer): RepoRestResponse {
  if (buf.subarray(0, 6).toString('ascii') !== 'repoV2') {
    return { attachmentCount: 0, content: JSON.parse(buf.toString('utf8')), attachments: [] };
  }
  const attachmentCount = buf.readUInt32LE(6);
  const contentLen = buf.readUInt32LE(10);
  const content = JSON.parse(buf.subarray(14, 14 + contentLen).toString('utf8'));
  let p = 14 + contentLen;
  const attachments: Buffer[] = [];
  for (let i = 0; i < attachmentCount && p + 4 <= buf.length; i++) {
    const len = buf.readUInt32LE(p);
    p += 4;
    attachments.push(buf.subarray(p, p + len));
    p += len;
  }
  return { attachmentCount, content, attachments };
}

/**
 * REPOSITORY_REST 的调用封装（repoV2 信封）：
 * @param request JSON 请求对象
 * @param files 文件槽内容（写对象时传 [名称, 内容]；读时 []）
 * @param outParamIndex OUT 参数在 CALL 语句中的序号（默认 1，即第 2 个参数）
 */
export async function repositoryRest(
  pool: HanaPool,
  request: Record<string, unknown>,
  files: Buffer[] = [],
): Promise<RepoRestResponse> {
  const j = Buffer.from(JSON.stringify(request), 'utf8');
  // 附件槽：1 文件 = 2 槽（名称 + 内容；读对象 XML 在槽 0，写时镜像该布局）
  const attachmentCount = 1 + files.length * 2;
  const idata = Buffer.concat([
    Buffer.from('repoV2', 'ascii'),
    u32le(attachmentCount),
    u32le(j.length),
    j,
    ...files.flatMap((f) => [u32le(f.length), f]),
  ]);
  // CALL SYS.REPOSITORY_REST(?, ?)：只绑定 IN（第 1 个 ?），OUT 经 getParameterValue(1) 读回（driver 约定）
  const outs = await pool.callProcedure('CALL SYS.REPOSITORY_REST(?, ?)', [idata], 1);
  const odata = outs[0];
  const buf = Buffer.isBuffer(odata) ? odata : Buffer.from(String(odata), 'utf8');
  return decodeRepoV2(buf);
}

/** 判定并抛出 REPOSITORY_REST 业务错误（error-code != 0） */
function assertNoRepoRestError(resp: RepoRestResponse, action: string): void {
  const code = resp.content['error-code'];
  if (typeof code === 'string' && code !== '0') {
    const msg = String(resp.content['error-msg'] ?? 'unknown');
    const arg = String(resp.content['error-arg'] ?? '');
    throw new HanaBusinessError(
      `仓库 ${action} 失败：${msg}（code=${code}${arg ? `, arg=${arg}` : ''}）`,
      code,
    );
  }
}

/** 读取对象设计时 XML（read object，XML 在附件槽 0） */
export async function readObjectXml(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  suffix = 'calculationview',
): Promise<string> {
  const resp = await repositoryRest(pool, {
    action: 'read',
    what: 'object',
    object: { package: packageId, name: objectName, suffix },
  });
  const xml = resp.attachments.find((a) => a.length > 0);
  if (!xml) {
    throw new HanaBusinessError(
      `read object 未返回设计时 XML（${packageId}/${objectName}）。响应 content: ${JSON.stringify(resp.content).slice(0, 300)}`,
    );
  }
  return xml.toString('utf8');
}

/** 新建 Calculation View 的输入规格 */
export interface CreateCalcViewInput {
  /** 包名（仅 ZDEMO*） */
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
   * - repo_rest（默认）：SYS.REPOSITORY_REST 裸 repoV2 JSON（读侧稳定；写侧在部分环境会 40106）
   * - xs_rest：XS Classic 设计时 REST API（Orion，官方写路径，推荐用于写/激活）
   * - inactive_object：直写 _SYS_REPO.INACTIVE_OBJECT 兜底（需特权账号）
   */
  transport?: 'repo_rest' | 'xs_rest' | 'inactive_object';
  /** 激活成功后探测的行数上限（0=不探测，默认 10）：让「0 行」当场可见，而不是留到人工预览才发现 */
  probeRows?: number;
}

/**
 * 激活未通过时的完整明细（一次调用给全：HTTP 状态 + CheckResult 原文 + 完整错误文本）。
 * 存在理由：激活失败的完整明细（含 Type/Procedure DDL）一次给全——否则调用方得「失败 → 再调一次
 * hana_view_validate」才能拿全，每轮固定多一次往返。
 */
export interface ActivationDetail {
  /** 服务端 HTTP 状态（555=激活失败；202/200 为 Check 未通过） */
  httpStatus?: number;
  /** CheckResult 原文（含 Operations.Write/Activate 与各 SPS 附带的明细字段，字段名不猜、整块透传） */
  checkResult?: WriteCheckResult;
  /** 错误码（如 40117 / 34011） */
  errorCode?: string;
  /** 完整错误文本（未截断；含 Type/Procedure DDL 明细） */
  message?: string;
  /** 原始响应体（仅在错误路径且未被 CheckResult 覆盖时有值） */
  body?: string;
}

/** 由写响应体的 CheckResult 提取「激活未通过」的完整明细（激活通过则 undefined） */
function activationDetailOf(meta: FileMeta & { CheckResult?: WriteCheckResult }): ActivationDetail | undefined {
  const chk = extractCheckResult(meta);
  if (!chk || chk.consistent) return undefined;
  // httpStatus 来自 writeFile 附带的原始状态（555=写成功/激活失败，202=Check 未通过）：
  // 调用方据此区分这两类失败，必须透传真实状态值，不能写死默认值或缺省
  const httpStatus = typeof meta['_httpStatus'] === 'number' ? (meta['_httpStatus'] as number) : undefined;
  return {
    checkResult: chk.raw,
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(chk.errorCode ? { errorCode: chk.errorCode } : {}),
    ...(chk.message ? { message: chk.message } : {}),
  };
}

/** 去掉仅供进程内判定用的内部字段（`_httpStatus`），不回显给调用方 */
function stripInternalMeta(meta: FileMeta & { CheckResult?: WriteCheckResult }): FileMeta {
  const { _httpStatus, ...rest } = meta as FileMeta & { _httpStatus?: number };
  void _httpStatus;
  return rest as FileMeta;
}

/** 激活失败的一行摘要（首行 + 错误码）：完整文本在 activationDetail.message，避免同一长文本回显两遍 */
function activationSummary(detail: ActivationDetail, fallback = '激活检查未通过'): string {
  const firstLine = (detail.message ?? '').split('\n')[0].trim();
  return [detail.errorCode, firstLine].filter(Boolean).join(' ') || fallback;
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
  /** 视图形态：projection（图形化最小形态）/ sql（SQL 模式，单 SqlScriptView） */
  mode?: 'projection' | 'sql';
  /** 激活后的行探测（probeRows>0 且对象已激活时才有） */
  rowProbe?: RowProbe;
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
  const limit = Math.min(Math.max(Math.trunc(probeRows), 1), MAX_PROBE_ROWS);
  try {
    const rows = await pool.query<Record<string, unknown>>(
      `SELECT * FROM ${qualifyName('_SYS_BIC', `${packageId}/${objectName}`)} LIMIT ?`,
      [limit + 1],
    );
    const truncated = rows.length > limit;
    const sliced = truncated ? rows.slice(0, limit) : rows;
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
 * 没有这一步时 `SELECT * FROM MARA` 这类写法会完全绕过 HANA_SCHEMA_ALLOW。
 */
async function assertScriptReadScopes(pool: HanaPool, script: string): Promise<void> {
  const { hasUnqualifiedTableRef } = await import('../write-plan.js');
  if (!hasUnqualifiedTableRef(script)) return;
  const rows = await pool.query<{ CURRENT_SCHEMA: string }>('SELECT CURRENT_SCHEMA FROM DUMMY');
  const schema = rows[0]?.CURRENT_SCHEMA ?? '';
  if (schema === '') return; // 取不到默认 schema 时不误拦（写包边界与限定名扫描仍在）
  try {
    assertSchemaAllowed(schema);
  } catch {
    throw new HanaBusinessError(
      `脚本含未限定 schema 的表名，按当前用户默认 schema "${schema}" 解析，而它不在服务端允许读取的范围内。` +
        '请把表名写成全限定名（SCHEMA."表"），或由部署方调整可读 schema 配置',
    );
  }
}

/** 检查对象是否已存在（ACTIVE_OBJECT 或 INACTIVE_OBJECT） */
async function objectExists(
  pool: HanaPool,
  packageId: string,
  objectName: string,
): Promise<boolean> {
  for (const table of ['ACTIVE_OBJECT', 'INACTIVE_OBJECT']) {
    const rows = await pool.query<{ C: number }>(
      `SELECT COUNT(*) AS C FROM "_SYS_REPO"."${table}"
       WHERE PACKAGE_ID = ? AND OBJECT_NAME = ? AND OBJECT_SUFFIX = 'calculationview'`,
      [packageId, objectName],
    );
    if ((rows[0]?.C ?? 0) > 0) return true;
  }
  return false;
}

/** 生成数据源定义所需的列信息（缺省从表元数据取全列） */
async function resolveColumns(
  pool: HanaPool,
  source: NonNullable<CreateCalcViewInput['source']>,
): Promise<Array<{ columnName: string; dataTypeName?: string }>> {
  if (source.columns && source.columns.length > 0) return source.columns;
  const { getTableColumns } = await import('./metadata.service.js');
  const cols = await getTableColumns(pool, source.schema, source.name, { limit: 500 });
  return cols.map((c) => ({ columnName: c.columnName, dataTypeName: c.dataTypeName }));
}

/** REPOSITORY_REST 通道：写对象（object 嵌套 + XML 在附件槽） */
async function writeViaRepoRest(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  xml: string,
): Promise<RepoRestResponse> {
  const resp = await repositoryRest(
    pool,
    {
      action: 'write',
      what: 'object',
      object: { package: packageId, name: objectName, suffix: 'calculationview' },
    },
    [Buffer.from(`${packageId}::${objectName}`, 'utf8'), Buffer.from(xml, 'utf8')],
  );
  assertNoRepoRestError(resp, 'write');
  return resp;
}

/** INACTIVE_OBJECT 兜底通道：直写设计时 XML（官方不支持；实测 SAPABAP1 无权限，仅特权账号可用） */
async function writeViaInactiveObject(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  xml: string,
): Promise<void> {
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
  await pool.execute(
    `INSERT INTO "_SYS_REPO"."INACTIVE_OBJECT"
       (PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, OWNER, WORKSPACE, VERSION_ID, LAST_CHANGED_AT, IS_DELETION, EDIT, CDATA)
     VALUES (?, ?, 'calculationview', CURRENT_USER, '', 0, ?, 0, 0, ?)`,
    [packageId, objectName, now, xml],
  );
}
/** 构造 XS REST 客户端（凭据来自 config，不落日志） */
function makeRestClient(config: HanaConfig): XsRestClient {
  return new XsRestClient(config);
}

/** XS REST 写路径（实测：PUT 为 create-or-update，写 inactive 无需 workspace 上下文，无 40106） */
async function writeViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  xml: string,
  opts: { activate?: boolean } = {},
): Promise<FileMeta> {
  const rest = makeRestClient(config);
  return rest.writeFile(packageId, `${objectName}.calculationview`, xml, {
    activate: opts.activate ?? false,
  });
}

/** XS REST 通道：激活设计时对象（PUT + SapBackPack {"Activate":true}，失败 555 + 编译明细） */
async function activateViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
): Promise<FileMeta> {
  const rest = makeRestClient(config);
  // 激活基于服务端当前版本：PUT 传回原内容 + Activate:true（无需 If-Match，激活失败 555 透传）
  const content = await rest.fileContent(packageId, `${objectName}.calculationview`);
  return rest.writeFile(packageId, `${objectName}.calculationview`, content, {
    activate: true,
  });
}

/** XS REST 通道：更新设计时对象（PUT 新内容 + If-Match ETag 乐观锁） */
export async function updateViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  xml: string,
  opts: { ifMatch?: string; activate?: boolean } = {},
  client?: XsRestClient,
): Promise<FileMeta> {
  const rest = client ?? makeRestClient(config);
  // ifMatch 由调用方在请求入口捕获（「读时取」：窗口一直覆盖到 PUT，期间任何并发写入都使基线失效）。
  // 仅当调用方未提供时才在此取当前 ETag —— 此时基线必然匹配，等于没有并发保护（保留分支仅为向后兼容）。
  const ifMatch = opts.ifMatch ?? (await rest.fileMeta(packageId, `${objectName}.calculationview`)).ETag;
  return rest.writeFile(packageId, `${objectName}.calculationview`, xml, {
    activate: opts.activate ?? false,
    ifMatch,
  });
}

/** XS REST 通道：删除设计时对象（DELETE） */
async function deleteViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
): Promise<void> {
  const rest = makeRestClient(config);
  await rest.deleteFile(packageId, `${objectName}.calculationview`);
}

/** 包创建（XS REST：POST /base/file/<pkg>/ 建目录） */
export async function createPackageViaRest(config: HanaConfig, packageId: string, description?: string): Promise<FileMeta> {
  assertWritePackageAllowed(packageId);
  const rest = makeRestClient(config);
  const segments = packageId.split('.');
  const leafName = segments[segments.length - 1];
  return rest.createPackage(packageId, leafName, description);
}
/** view_update 的声明式操作补丁（op=add_join：给当前视图追加一个 join；op=set_script：替换 SQL 模式脚本） */
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

export type ViewUpdateOperation = AddJoinOperation | SetScriptOperation;

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

/** 任一 operation 的应用明细（按 op 判别） */
export type AppliedOperationResult = AddJoinOperationResult | SetScriptOperationResult;

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
  /** 端到端耗时（operations 模式含当前/源定义读取与确定性变换；xml 模式无意义故不返回） */
  elapsedMs?: number;
}

/**
 * 更新 Calculation View 设计时定义（XS REST：PUT + If-Match ETag 乐观锁；冲突返回 isError+重读提示）。
 * 两种更新方式二选一（修改 CV 可零 XML）：
 * - input.xml：全量 XML 覆盖（原有方式，复杂改造用）；
 * - input.operations：声明式操作补丁——服务端读设计时当前内容，逐条确定性变换
 *   （view-edit，BW 方言同款），再走原有 PUT 更新路径；模型无需读取也不生成 XML。多条 operations 依序应用（可连续追加多个 join）。
 * 并发：两种方式都在**请求入口**捕获当前 ETag 作基线（「读时取」），到 PUT 之间任何并发写入
 * 都会使基线失效并以 412 显式暴露；调用方显式传 ifMatch 时以传入值为准（跨调用强一致场景）。
 */
export async function updateCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  packageId: string,
  objectName: string,
  input: { xml?: string; operations?: ViewUpdateOperation[] },
  opts: { ifMatch?: string; activate?: boolean; probeRows?: number } = {},
  client?: XsRestClient,
): Promise<UpdateCalculationViewResult> {
  assertWritePackageAllowed(packageId, objectName);
  assertSafeObjectName(objectName, '视图');
  const hasOperations = input.operations !== undefined && input.operations.length > 0;
  if (hasOperations && input.xml) throw new HanaBusinessError('xml 与 operations 二选一，请勿同时提供');
  if (!hasOperations && !input.xml) {
    throw new HanaBusinessError('需要提供 xml（全量 XML 更新）或 operations（声明式操作补丁）之一');
  }

  const startedAt = Date.now();
  // 写入全程复用同一 XS 会话（读基线 → 变换 → PUT）：省掉一次登录往返，也让读到的基线
  // 与写出的 If-Match 出自同一会话视角
  const rest = client ?? makeRestClient(config);
  // 乐观锁基线：请求入口（最早时刻）取当前 ETag —— 读时取。
  // 全量 xml 模式此前在「写入前」才取 ETag，基线必然匹配，等于没有并发保护；现在两种方式一致。
  // 调用方显式传 ifMatch 时以传入值为准（跨调用强一致场景），此处仍读一次元数据作为存在性检查
  // （对象不存在 → 立即失败，不会经 PUT 误建）。
  // 注意：全量 xml 的内容由调用方给出，若其基于更早的一次读取，服务端无从得知 ——
  // 返回 envelope 里的 412 是唯一的冲突信号，需要更强保证请显式传 ifMatch。
  const baseMeta = await rest.fileMeta(packageId, `${objectName}.calculationview`);
  const ifMatch = opts.ifMatch ?? baseMeta.ETag;
  let xml: string;
  let operationsResult: UpdateCalculationViewResult['operationsResult'];
  let xmlVerification: FullXmlGuardResult | undefined;
  if (hasOperations) {
    // 变换基线取设计时文件当前内容（与 ETag 同会话读取），而非已激活版本（ACTIVE_OBJECT）：
    // 存在未激活的挂起改动时，若以激活版为基线变换再覆盖设计时文件会静默丢失挂起工作。
    const designTimeXml = await rest.fileContent(packageId, `${objectName}.calculationview`);
    if (!designTimeXml || designTimeXml.trim() === '') {
      throw new HanaBusinessError(`视图 ${packageId}/${objectName} 无设计时内容，无法应用 operations`);
    }
    const applied: AppliedOperationResult[] = [];
    let currentXml = designTimeXml;
    for (const op of input.operations!) {
      // 按 op 分派：add_join 读源视图定义后接线；set_script 只改当前视图自身（无跨包读取）
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
      } else {
        const r = await applyAddJoinOperation(pool, op, currentXml);
        applied.push(r.result);
        currentXml = r.xml;
      }
    }
    operationsResult = {
      applied,
      xmlBytes: { before: designTimeXml.length, after: currentXml.length },
    };
    xml = currentXml;
  } else {
    // 全量通道护栏：解析性 + scenario id 一致性 + logicalModel 重接线（手工改 XML 两大高频事故，激活前拦下）
    xmlVerification = guardFullXmlUpdate(input.xml!, objectName);
    xml = input.xml!;
  }

  const meta = await updateViaRest(config, packageId, objectName, xml, { ...opts, ifMatch }, rest);
  const activated = meta.Attributes?.SapBackPack?.Activated === true;
  const detail = activationDetailOf(meta);
  // 行探测：对象确实激活后才探（同 create，让"激活成功但 0 行"当场可见）
  const rowProbe = await probeIfActivated(pool, packageId, objectName, activated, opts.probeRows);
  return {
    object: { packageId, objectName, objectSuffix: 'calculationview' },
    updated: true,
    activated,
    ...(detail ? { activationErrors: activationSummary(detail), activationDetail: detail } : {}),
    meta: stripInternalMeta(meta),
    ...(operationsResult ? { operationsResult, elapsedMs: Date.now() - startedAt } : {}),
    ...(xmlVerification ? { xmlVerification } : {}),
    ...(rowProbe ? { rowProbe } : {}),
  };
}

/** 删除 Calculation View 设计时对象（XS REST：DELETE） */
export async function deleteCalculationView(
  config: HanaConfig,
  packageId: string,
  objectName: string,
): Promise<{ object: { packageId: string; objectName: string; objectSuffix: 'calculationview' }; deleted: boolean }> {
  assertWritePackageAllowed(packageId, objectName);
  assertSafeObjectName(objectName, '视图');
  await deleteViaRest(config, packageId, objectName);
  return {
    object: { packageId, objectName, objectSuffix: 'calculationview' },
    deleted: true,
  };
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
 * 应用一条 add_join 操作（读源视图定义 + 确定性变换；不写库）：
 * 1. 校验条件/字段名（join 条件左字段必须是当前输出节点已有字段）
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

  // 解析带出字段（显式校验，缺省自动选择）
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
    fieldIds = [...new Set(op.fields)];
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
 * 1. 校验包（仅 ZDEMO）/对象名/源 schema
 * 2. 检查对象不存在
 * 3. 取源列 → 生成设计时 XML
 * 4. 按通道写入仓库（repo_rest 直通 REST；inactive_object 直写 INACTIVE_OBJECT）—— 与存在性检查一起
 *    构成串行临界区（见下）
 * 5.（可选）激活
 */
export async function createCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  input: CreateCalcViewInput,
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
    const columns = await resolveColumns(pool, input.source);
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
    const NUMERIC = new Set(['TINYINT', 'SMALLINT', 'INTEGER', 'INT', 'BIGINT', 'DECIMAL', 'SMALLDECIMAL', 'REAL', 'DOUBLE', 'FLOAT', 'SECONDDATE', 'DATE', 'TIME', 'TIMESTAMP', 'LONGDATE']);
    measureCount = measureMode === 'SUM_NUMERIC'
      ? columns.filter((c) => NUMERIC.has((c.dataTypeName ?? '').toUpperCase())).length
      : 0;
  }

  const result: CreateCalcViewResult = {
    object: { packageId: input.packageId, objectName: input.objectName, objectSuffix: 'calculationview' },
    xml,
    wrote: false,
    measureCount,
    mode,
  };
  if (measureCount === 0) {
    result.activationNote =
      '本环境（SPS08 实测）激活要求视图至少包含 1 个度量（40117 "No measures defined"）。' +
      (mode === 'sql'
        ? '当前 SQL 模式视图无度量列：把至少一个数值输出列的 columns[].isMeasure 置为 true，否则只能保存设计时对象'
        : '当前视图无度量，仅可保存设计时对象；建议用 measureMode=SUM_NUMERIC（需源表含数值列）重建');
  }

  const transport = input.transport ?? 'xs_rest';
  // 写临界区（keyed lock，key=包/对象）：存在性复核 + 写入必须原子。
  // 仓库 PUT 是 create-or-update（服务端不会返回 409），两个并发同名 create 会双双通过入口检查，
  // 后者静默覆盖前者；ETag 乐观锁覆盖不到这条路径，故进程内按对象互斥。
  await withKeyedLock(writeLockKey(input.packageId, input.objectName), async () => {
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
      const meta = await writeViaRest(config, input.packageId, input.objectName, xml, {
        activate: input.activate ?? false,
      });
      result.wrote = true;
      result.activated = meta.Attributes?.SapBackPack?.Activated === true;
      const detail = activationDetailOf(meta);
      if (detail) {
        result.activationErrors = activationSummary(detail);
        result.activationDetail = detail;
      }
    } else if (transport === 'inactive_object') {
      await writeViaInactiveObject(pool, input.packageId, input.objectName, xml);
      result.wrote = true;
      result.manualActivateHint =
        `设计时对象已写入 _SYS_REPO.INACTIVE_OBJECT（${input.packageId}/${input.objectName}），` +
        `请在 HANA Studio 中打开该对象并执行「激活」（直写内部表非官方支持，供 ZDEMO 验证用）`;
    } else {
      await writeViaRepoRest(pool, input.packageId, input.objectName, xml);
      result.wrote = true;
    }
  });

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
  const rowProbe = await probeIfActivated(pool, input.packageId, input.objectName, result.activated === true, input.probeRows);
  if (rowProbe) result.rowProbe = rowProbe;

  return result;
}

/** 激活 Calculation View：xs_rest=PUT+SapBackPack.Activate（官方写路径）；repo_rest=裸 repoV2（兼容，部分环境会 40106） */
export async function activateCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  packageId: string,
  objectName: string,
  transport: 'xs_rest' | 'repo_rest' = 'xs_rest',
): Promise<{ transport: string; meta?: FileMeta; repoResp?: RepoRestResponse }> {
  assertWritePackageAllowed(packageId, objectName);
  if (transport === 'xs_rest') {
    const meta = await activateViaRest(config, packageId, objectName);
    // 显式激活的语义就是「必须激活成功」：writeFile 对 555（写成功/激活失败）按非致命返回，
    // 这里必须把失败重新显性化——否则调用方拿到 success:true 却面对一个未激活的对象
    // （工具描述承诺「失败会透传编译错误明细（不误报成功）」）。
    if (meta.Attributes?.SapBackPack?.Activated !== true) {
      const detail = activationDetailOf(meta);
      const errDetail = detail?.message ?? describeActivationFailure(meta);
      throw new HanaBusinessError(
        `激活失败：${packageId}/${objectName} 写入成功但未激活。${errDetail}`,
        detail?.errorCode,
        undefined,
        [],
        undefined,
        // 原始载荷与 create/update 路径同形（envelope.raw.errorDetail）
        { httpStatus: meta['_httpStatus'], ...(detail ?? {}) },
      );
    }
    return { transport: 'xs_rest', meta };
  }
  const resp = await repositoryRest(pool, {
    action: 'activate',
    what: 'objects',
    activationMode: 'activate',
    objects: [{ package: packageId, name: objectName, suffix: 'calculationview' }],
  });
  assertNoRepoRestError(resp, 'activate');
  return { transport: 'repo_rest', repoResp: resp };
}

/** 激活检查未通过但响应体没有 CheckResult 时的兜底说明 */
function describeActivationFailure(meta: FileMeta & { CheckResult?: WriteCheckResult }): string {
  return meta.CheckResult
    ? '激活检查未通过（响应体 CheckResult 明细见 raw.errorDetail）'
    : '服务端未返回 Activated=true（未见 CheckResult 明细；可用 hana_view_validate 复核）';
}

/* ── Transfer API（xfer）：导出备份 / 导入恢复────────── */

/** 导出包为 zip 的结果 */
export interface ExportPackageResult {
  packageId: string;
  /** zip 字节数 */
  sizeBytes: number;
  /** 实际使用的导出 URL 形态（契约定档用） */
  url: string;
  /** saveTo 提供时：写盘路径；未提供时：base64 内容（小包用，大包建议 saveTo） */
  savedTo?: string;
  base64?: string;
}

/**
 * 导出包为 zip（GET /base/xfer/export，官方 Transfer API）。
 * 导出是读操作：不限制包（与读侧工具同一边界）；saveTo 落盘为本地备份文件。
 */
export async function exportPackageViaRest(
  config: HanaConfig,
  packageId: string,
  saveTo?: string,
  client?: XsRestClient,
): Promise<ExportPackageResult> {
  assertSafeObjectName(packageId, '包');
  const rest = client ?? makeRestClient(config);
  const { buffer, url } = await rest.exportPackageZip(packageId);
  const result: ExportPackageResult = { packageId, sizeBytes: buffer.length, url };
  if (saveTo) {
    const { mkdir, writeFile } = await import('node:fs/promises');
    const { dirname, resolve } = await import('node:path');
    const abs = resolve(saveTo);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buffer);
    result.savedTo = abs;
  } else {
    result.base64 = buffer.toString('base64');
  }
  return result;
}

/** 导入结果（含落库状态回读） */
export interface ImportObjectResult {
  object: { packageId: string; fileName: string };
  imported: boolean;
  meta?: FileMeta;
}

/**
 * 导入单个设计时文件（POST+PUT /base/xfer/import，官方 Transfer API）。
 * 导入是写操作：目标包仅允许 ZDEMO（含子包）。
 * 【默认拒绝覆盖】目标文件已存在时抛错并指引改用 hana_view_update（已有对象的修改走更新通道，
 * 禁止 delete+重建或静默覆盖）；确需覆盖导入（如备份恢复）须显式 overwrite=true。
 * 来源：content 内联内容（须配 fileName），或 filePath 本地文件（默认取 basename 做目标文件名）。
 */
export async function importObjectViaRest(
  config: HanaConfig,
  input: { targetPackageId: string; content?: string; filePath?: string; fileName?: string; overwrite?: boolean },
  client?: XsRestClient,
): Promise<ImportObjectResult> {
  assertWritePackageAllowed(input.targetPackageId);
  let content: Buffer | string;
  let fileName = input.fileName;
  if (input.content !== undefined) {
    if (!fileName) throw new HanaBusinessError('内联内容导入必须提供 fileName（目标文件名，如 ZDEMO_CV_X.calculationview）');
    content = input.content;
  } else if (input.filePath) {
    const { readFile } = await import('node:fs/promises');
    const { basename } = await import('node:path');
    content = await readFile(input.filePath);
    fileName ??= basename(input.filePath);
  } else {
    throw new HanaBusinessError('导入需要提供 content 或 filePath 之一');
  }
  assertSafeObjectName(fileName!, '目标文件名');
  const rest = client ?? makeRestClient(config);
  // 默认拒绝覆盖：已有对象的修改应走 hana_view_update（PUT + If-Match），保持版本演进而非删除重建
  if (!input.overwrite) {
    let existing: FileMeta | undefined;
    try {
      existing = await rest.fileMeta(input.targetPackageId, fileName!);
    } catch {
      existing = undefined;
    }
    if (existing) {
      throw new HanaBusinessError(
        `目标对象 ${input.targetPackageId}/${fileName} 已存在，导入默认拒绝覆盖。` +
          `请改用 hana_view_update 对已有对象做修改（读取 → 修改 → 更新），或显式传 overwrite=true 覆盖导入`,
      );
    }
  }
  await rest.importFile(input.targetPackageId, fileName!, content);
  // 落库状态回读（inactive / active 语义由服务端决定，如实呈现）
  let meta: FileMeta | undefined;
  try {
    meta = await rest.fileMeta(input.targetPackageId, fileName!);
  } catch {
    meta = undefined;
  }
  return { object: { packageId: input.targetPackageId, fileName: fileName! }, imported: true, meta };
}

/** 变更列表查询（GET /base/change，只读；Change-Tracking API） */
export async function listChangesViaRest(
  config: HanaConfig,
  opts: { user?: string; status?: number } = {},
  client?: XsRestClient,
): Promise<unknown> {
  const rest = client ?? makeRestClient(config);
  return rest.changeList(opts);
}

/* ── 设计时校验（激活前 Check）────────────────────────
 * 实测定案（SPS08）：本 SPS 上所有写动词对合法模型
 * 一律「写入即激活」（裸 PUT / Activate / Workspace / Check 全相同），Check 只是能把激活检查
 * 结果放进响应体。因此「无副作用的设计时校验」= 临时副本方案：
 *   内容写到 <NAME>_CHKTMP 临时对象（附 Check，读 CheckResult 判定）→ 删除临时对象。
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
  /** 临时校验对象名（校验后已删除） */
  tempObject: string;
}

/** 临时校验对象名（截断到 22 字符防超长；+7 后缀 ≤ 29 ≤ HANA 30 字符对象名上限） */
function tempCheckName(objectName: string): string {
  return `${objectName.slice(0, 22)}_CHKTMP`;
}

/** 对设计时对象做「激活前校验」（临时副本 + Check，原对象不受影响；仅 ZDEMO） */
export async function checkCalculationViewDesignTime(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  client?: XsRestClient,
): Promise<DesignCheckResult> {
  assertWritePackageAllowed(packageId, objectName);
  assertSafeObjectName(objectName, '视图');
  const rest = client ?? makeRestClient(config);
  const suffix = '.calculationview';
  const content = await rest.fileContent(packageId, `${objectName}${suffix}`);
  const tempObject = tempCheckName(objectName);
  // 临界区（keyed lock，key=包/对象）：临时对象名由对象名确定性推导（<NAME>_CHKTMP），
  // 同一对象的并发校验会互相删掉对方的临时对象 —— 把「清理残留 → 写入校验 → 删除副本」
  // 整段按对象串行化（校验内容是本次调用开头读到的快照，不受串行化影响）。
  return withKeyedLock(writeLockKey(packageId, objectName), async () => {
    // 残留清理（上次校验异常中断可能遗留临时对象；best-effort）
    try {
      await rest.deleteFile(packageId, `${tempObject}${suffix}`);
    } catch {
      /* 不存在即忽略 */
    }
    let consistent: boolean;
    let errors: string | undefined;
    let errorCode: string | undefined;
    try {
      const r = await rest.checkFile(packageId, `${tempObject}${suffix}`, content);
      consistent = r.consistent;
      errors = r.message;
      errorCode = r.errorCode;
    } finally {
      try {
        await rest.deleteFile(packageId, `${tempObject}${suffix}`);
      } catch {
        /* 清理失败不掩盖校验结果 */
      }
    }
    return { packageId, objectName, consistent, errors, errorCode, tempObject };
  });
}