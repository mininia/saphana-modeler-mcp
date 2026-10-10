import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, resolve } from 'node:path';
import type { HanaPool } from '../core/hana-client.js';
import { nowIso, toHanaDateTime } from '../core/datetime.js';
import { HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { ACTIVATION_CONCURRENCY_DEFAULT, ACTIVATION_SEMAPHORE } from '../core/limits.js';
import { logger, redactSensitive } from '../core/logger.js';
import { clampLimit } from '../core/num.js';
import { currentAgentLabel, currentClientId } from '../core/request-context.js';
import { withSemaphore } from '../core/semaphore.js';
import {
  assertSafeObjectName,
  assertSafeRuntimeName,
  assertSchemaAllowed,
  qualifyName,
  quoteIdentifier,
} from '../core/sql.js';
import { isPackageAllowed } from '../config/write-boundary.js';
import {
  XsRestClient,
  extractCheckResult,
  type EtagSource,
  type FileMeta,
  type WriteCheckResult,
} from '../core/xs-rest.js';
import type { HanaConfig } from '../config/config.js';
import { buildMinCalcViewXml, buildScriptedCalcViewXml, type ScriptedCalcViewSpec } from '../model/view-builder.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import { diffViewDefinitions, type ViewDiff } from '../model/view-diff.js';
import {
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
  type FullXmlGuardResult,
  type OutputFieldKind,
  type SetScriptSpec,
} from '../model/view-edit.js';
import { isNumericType, type ViewDefinition } from '../model/view-types.js';
import { parseViewDefinition } from '../model/view-xml.js';
import { impact, type ClosureResult, type GraphEdge } from './catalog.service.js';
import {
  planChangeset,
  type ChangesetAction,
  type ChangesetConflict,
  type ChangesetPlanResult,
} from './changeset.plan.js';
import {
  assessBreaking,
  assessViewDeletion,
  type BreakingAssessment,
  type BreakingItem,
  type MigrationDeclaration,
} from './migrate.rules.js';
import { currentSchema, getTableColumns, getViewDefinition, VIEW_SUFFIXES } from './metadata.service.js';
import { assertSqlReadScopes } from './read-scope.service.js';

/**
 * 仓库写服务：
 * - REPOSITORY_REST：SYS.REPOSITORY_REST(IN BLOB, OUT BLOB) —— Studio 同款仓库 REST 通道（首选）
 *   协议（实测 + SAP-archive/xsk 开源佐证）：IN/OUT 均为 repoV2 二进制信封 ——
 *     "repoV2"(6B ASCII) + attachmentCount(4B 小端, 原始槽数=1+2*文件数) + contentLength(4B 小端, JSON 字节数)
 *     + JSON UTF-8 + 附件区（每槽 [4B 小端长度][内容]，1 文件=2 槽：名称槽+内容槽；读对象时 XML 在槽 0）。
 * - INACTIVE_OBJECT 直写：兜底（实测 SAPABAP1 无直写权限，实际不可用，保留供有权限账号参考）。
 * 安全护栏：写操作的包名边界由 HANA_WRITE_PACKAGES 配置（**两层口径**：空白名单在本判定层 fail-open、
 * 不限制；端到端空白名单 = 声明写包的调用被运行期闸门以 boundary_off 拒绝，详见 config/write-boundary.ts 文件头），
 * 对象名校验，凭据不落日志。
 *
 * 并发（P5 §4.1/§4.3）：
 * - **全局锁序写死：keyed lock → 信号量 → 网络/DB**。任何新写路径不得反向获取，否则构成锁序反转
 *   （T1 持信号量等锁、T2 持锁等信号量 = 死锁）。
 * - **锁不可重入**：withKeyedLock 对同一 key 是排队串行、不是可重入锁——持锁期间不得再取同一把锁。
 * - 五条写路径（create / update / activate / delete / import，另加 validate 的临时副本流程）对同一对象
 *   统一使用 writeLockKey(packageId, normalizeObjectName(objectName)) 同一把锁。
 */

/**
 * 允许写操作的仓库包前缀（大写）。进程级，由 configureWritePackages 接线。
 * - 空数组 = 本判定层不限制（fail-open，配置项未填时的默认）；**端到端不等于「所有包可写」**——
 *   写工具暴露时，声明写包的调用会被运行期闸门以 boundary_off 拒绝（两层口径见 config/write-boundary.ts 文件头）
 * - 非空 = 仅允许这些包及其下级子包（包名以「配置前缀」或「配置前缀.」开头）
 */
let WRITE_ALLOWED_PACKAGES: string[] = [];

/**
 * 接线写操作包白名单（来自 HANA_WRITE_PACKAGES）。
 * 由 index.ts 启动时调用一次；输入统一转大写、去空白。
 * 空数组 = 本判定层不限制（fail-open；端到端表现为「声明写包的调用被闸门拒绝」，见文件头两层口径）；
 * 非空 = 仅配置包及其子包可写。
 */
export function configureWritePackages(packages: string[]): void {
  WRITE_ALLOWED_PACKAGES = packages.map((p) => p.trim().toUpperCase()).filter((p) => p.length > 0);
}

/** 包名安全字符集校验（写操作前纵深防御；值仍参数绑定） */
function isSafePackageName(packageId: string): boolean {
  return /^[A-Za-z0-9_.\-]+$/.test(packageId);
}

/**
 * 校验写入包名是否在配置的可写包范围内，并记录写操作审计日志。
 * - 白名单为空 → 本服务层不限制（fail-open，配置未填时的默认）；端到端空白名单 = 声明写包的调用
 *   被闸门拒绝（两层口径见 config/write-boundary.ts 文件头）
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
  // §4.4 归因：agentLabel 是进程级标签（MCP_AGENT_LABEL）——多代理拓扑下每个子代理一个进程，
  // 仓库侧（_SYS_REPO 的 OWNER/ACTIVATED_BY）只能看到共享技术账号，日志里没有它就分不清
  // 「哪个代理写了这个包」。有则附、无则省（未配置时不产生恒为空字段，写法与 config/authorize.ts 一致）。
  const agentLabel = currentAgentLabel();
  logger.info(
    {
      clientId: currentClientId(),
      ...(agentLabel ? { agentLabel } : {}),
      packageId,
      ...(objectName ? { objectName } : {}),
    },
    '仓库写操作请求（审计：记录调用方与目标，结果见返回 envelope）',
  );
}

/**
 * 写临界区的锁 key：包 + 对象名（对象名先过 normalizeObjectName——带设计时后缀的文件名与裸对象名
 * 必须落到同一把锁，否则 import 与 create/update 互不阻塞，等于没加锁）。
 * 键的维度是「**同一设计时文件**」：同一文件无论以裸对象名还是带后缀文件名寻址都是同一个键；
 * 不同文件互不阻塞，同一文件上的 check-then-act 序列严格串行。
 *
 * 全局锁序（SSD §4.3，写死）：**keyed lock → 信号量 → 网络/DB**。任何新写路径不得反向获取，
 * 否则与 update 的「持锁 → 写时经 writeFile 取激活信号量」构成锁序反转 = 死锁。
 * 锁**不可重入**：withKeyedLock 对同一 key 是排队串行，持锁期间再取同一把锁会自等（排队内自锁）；
 * 现有各路径均满足「各自只取一次、不嵌套」（详见各调用点注释）。
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
 * REPOSITORY_REST 的调用封装（repoV2 信封）——本文件内部通道（写路径与读 XML 兜底），故不导出：
 * 对外只有高层的 create/update/activate/delete 语义，避免调用方绕过包/对象校验直连裸 REST。
 * @param request JSON 请求对象
 * @param files 文件槽内容（写对象时传 [名称, 内容]；读时 []）
 * @param outParamIndex OUT 参数在 CALL 语句中的序号（默认 1，即第 2 个参数）
 */
async function repositoryRest(
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
  // CALL SYS.REPOSITORY_REST(?, ?)：只绑定 IN（第 1 个 ?），OUT 经 getParameterValue(1) 读回（driver 约定）。
  // 写路径 SQL 超时（§4.3）：REPOSITORY_REST 一挂住就占着池位（池上限 4），必须可设上限；
  // 假池/未配超时的池拿到 undefined 时行为与今天一致（不加超时）
  const outs = await pool.callProcedure('CALL SYS.REPOSITORY_REST(?, ?)', [idata], 1, {
    timeoutMs: pool.statementTimeoutMs,
  });
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
    throw new HanaBusinessError(`仓库 ${action} 失败：${msg}（code=${code}${arg ? `, arg=${arg}` : ''}）`, code);
  }
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

/**
 * 写路径成功后的视图缓存失效（SSD §4.5，五条写路径统一经此助手，不各写一遍）。
 * 对象名一律传**裸名**（与 viewDefinitionCache.get 的 key 构造 `${pkg}/${obj}/…` 一致；
 * 带后缀不会命中前缀，只会静默退化成「等 60s 自愈」）。
 * 定位：失效只是把「最多 60s 后自愈」变成「立即」，**不是正确性依赖**——
 * 缓存条目自带 VERSION_ID 轻校验 + TTL，跨进程的真相始终在 _SYS_REPO。
 */
function invalidateViewCache(packageId: string, objectName: string): void {
  viewDefinitionCache.invalidate(packageId, objectName);
}

/* 写回执基线（ETag）来源的类型 EtagSource 单点定义在 core/xs-rest.ts（三值）：
 * 'response-header'=写响应的响应头同刻读数（真正的新基线）；'read-back'=独立回读（删除前的基线 / 导入后的回读，
 * 不与写响应同源）；'unavailable'=这次读取没拿到 ETag——回执如实缺省，**不许补读拼装**冒充新基线。 */

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
 *
 * 判定规则已提取到 read-scope.service（SQL 分析工具要在**已持有连接**上做同一件事），此处只注入读法。
 */
async function assertScriptReadScopes(pool: HanaPool, script: string): Promise<void> {
  return assertSqlReadScopes(script, () => currentSchema(pool), '脚本');
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

/** 生成数据源定义所需的列信息（缺省从表元数据取全列） */
async function resolveColumns(
  pool: HanaPool,
  source: NonNullable<CreateCalcViewInput['source']>,
): Promise<Array<{ columnName: string; dataTypeName?: string }>> {
  if (source.columns && source.columns.length > 0) return source.columns;
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
  timezone: string,
): Promise<void> {
  // 写库时间与日志同口径（此前此处用 UTC 的 toISOString，与日志相差一个时区）
  const now = toHanaDateTime(new Date(), timezone);
  // 写路径 SQL 超时（§4.3）：兜底直写同样是写前必经腿（假池/旧调用点 undefined = 不加超时）
  await pool.execute(
    `INSERT INTO "_SYS_REPO"."INACTIVE_OBJECT"
       (PACKAGE_ID, OBJECT_NAME, OBJECT_SUFFIX, OWNER, WORKSPACE, VERSION_ID, LAST_CHANGED_AT, IS_DELETION, EDIT, CDATA)
     VALUES (?, ?, 'calculationview', CURRENT_USER, '', 0, ?, 0, 0, ?)`,
    [packageId, objectName, now, xml],
    { timeoutMs: pool.statementTimeoutMs },
  );
}

/** 设计时文件后缀（= _SYS_REPO.OBJECT_SUFFIX 的 calculationview；写通道共用同一常量，不再各处手拼） */
const CALC_VIEW_FILE_SUFFIX = '.calculationview';

/**
 * 已知的设计时后缀全集（锁键归一的判定依据）。
 * 单一事实源：本文件的 CALC_VIEW_FILE_SUFFIX（设计时文件名用）+ metadata.service 的 VIEW_SUFFIXES
 * （calc/attribute/analyticview 三种）。不手抄字符串清单——复制一份的那天，后缀名改了这里就成了静默漏网。
 */
const DESIGN_TIME_SUFFIXES: readonly string[] = [
  ...new Set([CALC_VIEW_FILE_SUFFIX, ...Object.values(VIEW_SUFFIXES).map((suffix) => `.${suffix}`)]),
];

/**
 * 锁键归一（SSD §4.1）：**循环**剥掉已知的设计时后缀直到稳定，得到**裸对象名**。
 * 为什么需要：import 传的是设计时文件名（X.calculationview），create/update/validate 传裸对象名——
 * 带后缀与不带后缀的键互不阻塞，同一文件上的并发写等于没加锁（本文件全部 withKeyedLock 统一走本函数）。
 * 为什么是**循环**而不是只剥一层：裸对象名本身可能就以设计时后缀结尾（就叫 A.calculationview），
 * 只剥一层时 update 传裸名 A.calculationview → 键 A，而 import 传同名文件 A.calculationview.calculationview
 * → 键 A.calculationview：同一设计时文件仍落两条键，等于没互斥。循环剥离到稳定即消除该错配。
 * 语义：不区分大小写比较（后缀按小写匹配），返回值保持原样大小写；无已知后缀则原样返回。
 */
export function normalizeObjectName(name: string): string {
  let normalized = name;
  for (;;) {
    const lower = normalized.toLowerCase();
    const hit = DESIGN_TIME_SUFFIXES.find((suffix) => lower.endsWith(suffix));
    if (!hit) return normalized;
    normalized = normalized.slice(0, normalized.length - hit.length);
  }
}

/** 设计时对象在 XS 仓库中的文件名（<对象名>.calculationview） */
function designTimeFile(objectName: string): string {
  return `${objectName}${CALC_VIEW_FILE_SUFFIX}`;
}

/**
 * XS 设计时文件通道的唯一入口：解析会话（调用方未显式传入则新建）+ 目标文件路径。
 * 写/激活/更新/删除四路此前各自重复这两步（建客户端 + `${objectName}.calculationview`），
 * 是「同一个拼法写四遍」的唯一来源；集中后凭据只在此处进入客户端。
 */
function designTimeTarget(
  config: HanaConfig,
  objectName: string,
  client?: XsRestClient,
): { rest: XsRestClient; file: string } {
  return { rest: client ?? new XsRestClient(config), file: designTimeFile(objectName) };
}

/** XS REST 写路径（实测：PUT 为 create-or-update，写 inactive 无需 workspace 上下文，无 40106） */
async function writeViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  xml: string,
  opts: { activate?: boolean } = {},
  /**
   * 可选的共享会话（P7 追加）：create 路径不传（自建会话），变更集的 delete-补偿（回写原文）要复用
   * 调用方传入的客户端——单测可注入桩、多对象批也省去重复登录。追加在末尾，既有调用点零改动。
   */
  client?: XsRestClient,
): Promise<FileMeta> {
  const { rest, file } = designTimeTarget(config, objectName, client);
  return rest.writeFile(packageId, file, xml, {
    activate: opts.activate ?? false,
  });
}

/**
 * XS REST 通道：激活设计时对象（PUT + SapBackPack {"Activate":true}，失败 555 + 编译明细）。
 * 锁内三步：① fileMeta 取 ETag 基线 ② fileContent 读当前内容 ③ writeFile(activate, If-Match=基线)。
 * 三步必须同临界区（锁由调用方 activateCalculationView 持有）：fileMeta 若在锁外，并发 update 会让
 * 激活拿旧基线写新内容 → 必然伪 412。
 * 锁不可重入：本函数自身不取锁，也不得被持锁状态下的其它路径直呼。
 */
async function activateViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  client?: XsRestClient,
): Promise<{ meta: FileMeta & { CheckResult?: WriteCheckResult }; ifMatch?: string }> {
  const { rest, file } = designTimeTarget(config, objectName, client);
  const baseMeta = await rest.fileMeta(packageId, file);
  const content = await rest.fileContent(packageId, file);
  // ETag 缺失时（理论上不该发生）退回不带 If-Match 的旧行为，由调用方把这件事写进回执/日志（不静默）
  const meta = await rest.writeFile(packageId, file, content, {
    activate: true,
    ...(baseMeta.ETag ? { ifMatch: baseMeta.ETag } : {}),
  });
  return { meta, ifMatch: baseMeta.ETag };
}

/**
 * XS REST 通道：更新设计时对象（PUT 新内容 + If-Match ETag 乐观锁）。
 * 无 ifMatch 时**明确不带 If-Match** 写（不补读基线）：退化事实由调用方的 updateNote 说明，不静默。
 * 注：参数较多（6 个，含可选 opts/client），tools 层调用点未同步改造，故签名保持现状。
 */
export async function updateViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  xml: string,
  opts: { ifMatch?: string; activate?: boolean } = {},
  client?: XsRestClient,
): Promise<FileMeta> {
  const { rest, file } = designTimeTarget(config, objectName, client);
  // ifMatch 由调用方在**锁内**捕获（「读时取」：窗口一直覆盖到 PUT，期间任何并发写入都使基线失效——
  // 锁内取则进程内不再有他人写入；跨进程仍由服务端 412 兜底）。
  // 旧实现在此处补读一次 fileMeta 取当前 ETag 当基线——那次补读若发生在第三方写入之后，会把冲突基线
  // 悄悄刷新（PUT 不再 412），与 §4.2「禁止补读拼装」同型；故删除该回退分支：没有基线就不带 If-Match。
  return rest.writeFile(packageId, file, xml, {
    activate: opts.activate ?? false,
    ...(opts.ifMatch ? { ifMatch: opts.ifMatch } : {}),
  });
}

/**
 * XS REST 通道：删除设计时对象（锁内两步：取基线 → 带 If-Match 的 DELETE）。
 * 实测（§4.9#C）：正确基线 → 204、陈旧基线 → 412、对象已不存在 → 404（core 层已把它们分类成
 * 机读码 + conflict 载荷）。基线是**删除前读**得到的——对象删掉后没有可读的基线。
 * 基线缺失（读取未返回 ETag）时退回不带 If-Match 删除：退化事实经 ifMatchMissing 带出（调用方如实上报）。
 * 锁不可重入：本函数取一次锁，调用方不得再在持锁状态下调用它。
 *
 * `ifMatch`（P7 修复批，可选、不传=现状）：调用方**预读**的删除基线。变更集的 delete 项把「写入前紧贴
 * 本项读到的 ETag」显式传入，使「预读 → 删除」之间的第三方写入必得 412（该项 ⇒ conflict_external）；
 * 不传时按现状在锁内自取基线（单对象通道语义零改动）。
 */
async function deleteViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  client?: XsRestClient,
  ifMatch?: string,
): Promise<{ etag?: string; version?: number; ifMatchMissing: boolean }> {
  return withKeyedLock(writeLockKey(packageId, normalizeObjectName(objectName)), async () => {
    const { rest, file } = designTimeTarget(config, objectName, client);
    // fileMeta 顺带做存在性判定（404 → OBJECT_NOT_FOUND 机读码）
    const baseMeta = await rest.fileMeta(packageId, file);
    // 基线归一（修 3）：空串/纯空白 ETag 不当「有基线」——「是否带 If-Match」的真值判断与 ifMatchMissing
    // 的 === undefined 判断必须同口径，否则会静默退化成「无基线删除且不产生 deleteNote」。
    // 显式基线优先（P7 修复批）：以调用方**预读**的 ETag 为准，不用锁内这次重取的读数——重取会把
    // 「预读 → 删除」窗口内的第三方写入悄悄刷新成新基线（DELETE 无 412），补偿随后把预读原文写回，
    // 第三方的已提交版本被静默丢弃（P7 评审 blocker 的探针复现）；锁内这次 fileMeta 读只保留存在性判定作用。
    const explicit = ifMatch?.trim() || undefined;
    const baseline = explicit ?? (baseMeta.ETag?.trim() || undefined);
    await rest.deleteFile(packageId, file, baseline ? { ifMatch: baseline } : {});
    return { etag: baseline, version: baseMeta.SapBackPack?.Version, ifMatchMissing: baseline === undefined };
  });
}

/**
 * 包创建（XS REST：POST /base/file/<pkg>/ 建目录）。
 * 按 SSD §4.1 明确**不加锁、不需要 If-Match**：这是**幂等**操作——重复建包 200/201 均被接受
 * （xs-rest 的 createPackage 对已存在返回 200），任何时序下终态一致，满足并发不变量 I1。
 */
export async function createPackageViaRest(
  config: HanaConfig,
  packageId: string,
  description?: string,
): Promise<FileMeta> {
  assertWritePackageAllowed(packageId);
  const rest = new XsRestClient(config);
  const segments = packageId.split('.');
  const leafName = segments[segments.length - 1];
  return rest.createPackage(packageId, leafName, description);
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

/** op=set_attribute_filter：给节点已有属性设置单值过滤器（口径面变更，P6 以 attribute_filter_changed 判定） */
export interface SetAttributeFilterOperation {
  op: 'set_attribute_filter';
  attribute: string;
  value: string;
  including?: boolean;
  node?: string;
}

/** op=set_variable：修改已有输入参数（口径面变更，P6 以 variable_changed 判定） */
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
 * 迁移声明闸门的结果记录（P6，SSD §5.4 / D2）——回执审计字段，与 DryRunReport.migration 同一形状。
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
 * dryRun 预演回执（P6，SSD §5.1）：只读预演——一次 PUT、一次 probe、一次缓存失效、一次信号量都不发生。
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
   * P4 影响半径：**直接下游（单跳）**（impact() 默认 depth=1，判定/回执都用这一口径；需要传递影响面
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
   * P6 破坏性判定（**直接下游（单跳）** × 结构 diff；判定/回执都用 impact() 的默认 depth=1 口径，
   * 需要传递影响面请用 hana_metadata_where_used 的 depth>1）。成功回执必然带出（非破坏时
   * level='none'、items=[]）；Optional 仅表示它不参与写入是否发生的判别。基线不可用时它是「未判」
   * 的空壳占位（level='unknown'、items=[]）——unknown ≠ 非破坏，由 baselineUnavailable 标注。
   */
  breaking?: BreakingAssessment;
  /** P6 迁移声明闸门记录（update 的声明位；形状见 MigrationGateRecord）。成功回执必然带出（只报告，不阻断） */
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
 * 更新 Calculation View 设计时定义（XS REST：PUT + If-Match ETag 乐观锁；冲突 → 业务失败信封 + 机读码 412）。
 * 两种更新方式二选一（修改 CV 可零 XML）：
 * - input.xml：全量 XML 覆盖（原有方式，复杂改造用）；
 * - input.operations：声明式操作补丁——服务端读设计时当前内容，逐条确定性变换
 *   （view-edit，BW 方言同款），再走原有 PUT 更新路径；模型无需读取也不生成 XML。多条 operations 依序应用（可连续追加多个 join）。
 * 并发：整段「取基线 → 读内容/变换 → PUT」都在同一把 keyed lock 内（锁键与 create/activate/delete/import 同键）。
 * 锁内取基线 ⇒ 锁内不再有他人写入（消除「锁外取基线 + 锁内写新内容」的伪 412）；
 * 调用方显式传 ifMatch 时以传入值为准（跨调用强一致场景；已在入口归一：空串/纯空白 = 未提供），
 * 此时那次 fileMeta 读仍保留为存在性检查。
 * P6（SSD §5）：PUT 之前先做「结构化 diff（before=设计时当前内容，两模式同一来源）→ **直接下游（单跳）**
 * 影响半径 → 破坏性判定」，两条分支共用同一份计算（判定输入的下游只计设计时引用、运行时 __RT_* 引用过滤，
 * 见 designTimeDownstream）：
 * - opts.dryRun=true ⇒ 返回 DryRunReport 后立刻收尾：不写库、不发 probe、不改缓存、不取信号量（只读预演）；
 * - 否则破坏性变更（下游有引用且命中判定表）必须有调用方 migration 声明才放行，未声明以 migration_required
 *   拒绝（发生在 PUT 之前 ⇒ 一次写都不发生）；声明只记录、不触发任何自动迁移。
 * - 设计时内容为空/缺失 ⇒ 基线不可用：不做破坏性判定（breaking.level='unknown'、闸门跳过）+ 响亮标注
 *   （fail-open，见 baselineUnavailable 注释）——**未判 ≠ 判为非破坏**，形状上必须可区分。
 * 注：参数较多（7 个，含可选 opts/client），tools 层调用点未同步改造，故签名保持现状。
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
  // 入口统一归一（修 3）：显式传空串/纯空白不能当「有基线」——否则会静默退化成「无 If-Match 写」，
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
  // - P6 的判定（diff 基线读 + 影响半径查询）同样在锁内：diff 基线与判定一致，且 DryRunReport.base 与
  //   写入路径出自同一次 fileMeta 读（dryRun 只读，取锁不引入副作用，只是与写路径同序排队）；
  // - 锁内顺序 keyed lock → 网络/DB；激活信号量在 writeFile 内部取（晚于本锁，全局锁序不反转）；
  // - 锁不可重入：本临界区内不再取同一把锁（updateViaRest 只做 PUT）。
  // 调用方显式传 ifMatch 时以传入值为准（跨调用强一致场景；空串/纯空白已在入口归一为「未提供」）；
  // 此时那次 fileMeta 读仍保留为存在性检查（对象不存在 → 立即失败，不会经 PUT 误建）。
  // 注意：全量 xml 的内容由调用方给出，若其基于更早的一次读取，服务端无从得知 ——
  // 返回 envelope 里的 412 是唯一的冲突信号，需要更强保证请显式传 ifMatch。
  const outcome = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<
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
        }
    > => {
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
        const applied: AppliedOperationResult[] = [];
        let currentXml = designTimeXml;
        for (const op of input.operations!) {
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
        operationsResult = {
          applied,
          xmlBytes: { before: designTimeXml.length, after: currentXml.length },
        };
        // diff 基线与变换基线同源（设计时当前内容）；operations 分支无需额外读取
        beforeXml = designTimeXml;
        xml = currentXml;
      } else {
        // 全量通道护栏：解析性 + scenario id 一致性 + logicalModel 重接线（手工改 XML 两大高频事故，激活前拦下）
        xmlVerification = guardFullXmlUpdate(input.xml!, objectName);
        // P6：xml 模式此前只读了 fileMeta——判定与 dryRun 的 diff 基线必须是设计时当前内容（与 operations 同源），
        // 故在同一锁临界区内补一次**纯读**（不违反任何 P5 不变量：基线读 → 内容读 → 判定 → PUT 仍同临界区）
        beforeXml = await rest.fileContent(packageId, designFile);
        xml = input.xml!;
      }

      // P6 判定三件套（dryRun 与闸门共用同一份计算——两处各算一遍必然漂移）：影响半径 → 设计时下游过滤 → 结构 diff → 破坏性判定。
      // 影响半径 seed 的对象名先归一（与锁键同口径）：带设计时后缀的文件名与裸对象名指向同一仓库对象。
      // depth: 1 显式写死（= impact() 的默认值）：判定/回执只认**直接下游（单跳）**，每次写都跑全闭包代价太大；
      // 写死是为了防止将来有人改 impact 的默认值、让判定口径静默变化——需要传递影响面请用 hana_metadata_where_used(depth>1)。
      const impactResult = await impact(
        pool,
        {
          packageId,
          objectName: normalizeObjectName(objectName),
          objectSuffix: 'calculationview',
        },
        { depth: 1 },
      );
      // 下游判定只认设计时引用：运行时 __RT_* 目录引用在这里被过滤（实测事实与理由见 designTimeDownstream）；
      // 删除闸门走同一个助手——一处实现，两个闸门的过滤口径不会漂移。
      const { downstream, runtimeOnly } = designTimeDownstream(impactResult);
      // 缺陷 2（基线不可用）：设计时内容为空/纯空白（对象只有激活版本没有设计时内容，或文件被清空）时，
      // 拿空定义作 diff 基线会把「无基线」当成「全部新增」——对下游存在的对象误报破坏（甚至拦住本可放行的写）。
      // 口径：宁可 fail-open + 响亮标注（与本仓探测类失败的既有口径一致），也不拿一个假基线去拦合法写入。
      // operations 模式不受影响：它在本步之前就要求设计时内容非空（没有基线根本无法应用变换，无从 fail-open）。
      const baselineUnavailable = beforeXml.trim() === '';
      let diff: ViewDiff;
      let breaking: BreakingAssessment;
      if (baselineUnavailable) {
        // 不做判定：diff 只给**空壳占位**（不可当真）；breaking.level='unknown' 把「未判」钉进形状
        // （评审 #15：此前 level='none' 与「判定为非破坏」不可区分，调用方会把未判读成非破坏）；
        // 真实语义由回执的 baselineUnavailable + warnings 标注。migration.required 因此如实为 false：
        // **不做判定 ≠ 判定为非破坏**（unknown 不是 breaking，不判就不拦）。
        // level='unknown' 由 migrate.rules.BreakingAssessment 承载（跨代理冻结接口：none | breaking | unknown）。
        diff = emptyViewDiff();
        breaking = {
          level: 'unknown',
          items: [],
          downstreamCount: downstream.length,
          impactTruncated: impactResult.truncated,
        };
      } else {
        diff = diffViewDefinitions(
          parseForAssessment(beforeXml, '当前设计时内容'),
          parseForAssessment(xml, '新的 XML'),
        );
        breaking = assessBreaking(diff, { downstream, truncated: impactResult.truncated });
      }

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
      // 这正是缺陷 2 裁定的 fail-open 落点。
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
  // P6 回执的诚实性提示（与 dryRun 回执共用同一份文案常量——两处各写一遍必然漂移）：
  // - 基线不可用：未判（breaking.level='unknown'，unknown ≠ 非破坏）；
  // - 影响半径截断：dryRun 早有明确警告句，写路径此前只有 breaking.impactTruncated 布尔（评审 #18 收口，
  //   两条通道同一句文案）。
  const warnings: string[] = [];
  if (baselineUnavailable) warnings.push(BASELINE_UNAVAILABLE_WARNING);
  if (breaking.impactTruncated) warnings.push(IMPACT_TRUNCATED_WARNING);
  // 写后失效视图缓存（§4.5）：紧贴写路径，把「最多 60s 后自愈」变成「立即」
  invalidateViewCache(packageId, objectName);
  const activated = meta.Attributes?.SapBackPack?.Activated === true;
  const detail = activationDetailOf(meta);
  // 基线缺失是**静默退化**吗？不——与 activate 同形：回执给 updateNote + 日志留痕（仅该情形产生字段，
  // 不制造恒为空噪音）。后果如实说明：本次 PUT 未带 If-Match，期间（含读取之后）的第三方修改不会以 412 暴露。
  // 显式传空串/纯空白已在入口归一为「缺失」，同样走到这里（不会静默无说明）。
  let updateNote: string | undefined;
  if (ifMatch === undefined) {
    updateNote =
      '设计时元数据读取未返回 ETag（且未显式提供 ifMatch）：本次更新未带 If-Match，' +
      '基线读取之后发生的第三方修改不会以 412 暴露（写入结果仍以服务端实际执行结果为准）；' +
      '需要并发保护请先自行读取基线并显式传 ifMatch';
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
    etag: meta.ETag,
    etagSource: meta.etagSource ?? 'unavailable',
    version: meta.SapBackPack?.Version,
    // P6：成功回执必带上判定与闸门记录（非破坏时只报告：level='none'、required=false）；
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

/* ── P6 判定与闸门（update 与 delete 共用的判定/拒绝/回执组装）────── */

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
 * （实证会打挂 P5 验收里的双删场景）。
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
 * `applyChangeset` 的整体预检**共用同一实现**（I3：两处各写一份时，「这次删除会不会被拦」的判定
 * 必然漂移成两种行为，正是 P7 实机验收场景③暴露的那类缺口）。
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
 * 判定用的对象名先归一（与锁键同口径）：带设计时后缀的文件名与裸对象名必须指向同一个图节点。
 * depth: 1 显式写死（= impact() 的默认值）：判定/回执只认**直接下游（单跳）**，语义见 designTimeDownstream。
 */
export async function assessDeletionGate(
  pool: HanaPool,
  packageId: string,
  objectName: string,
): Promise<DeletionGateAssessment> {
  const bareName = normalizeObjectName(objectName);
  const impactResult = await impact(
    pool,
    { packageId, objectName: bareName, objectSuffix: 'calculationview' },
    { depth: 1 },
  );
  const { downstream, runtimeOnly } = designTimeDownstream(impactResult);
  const breaking = assessViewDeletion(
    { packageId, objectName: bareName },
    { downstream, truncated: impactResult.truncated },
  );
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
 * downstreamCount 只是下界，判定可能低估影响面。两条通道必须一字不差（评审 #18）。
 */
const IMPACT_TRUNCATED_WARNING =
  '影响半径检索被截断（达到节点上限）：downstream 列表与 downstreamCount 只是下界，破坏性判定可能低估影响面';

/**
 * 无基线时的**空壳占位** diff 工厂：只在 baselineUnavailable=true 时使用（每次返回新对象，
 * 避免共享可变常量被调用方就地改坏）。它**不是比较结果**（没有可比较的基线），必须与回执的
 * baselineUnavailable + warnings 一起读。刻意不产出「空定义 vs 新 XML」的真 diff：
 * 那会把「无基线」显示成「全部新增」，正是本次修复的误导源。
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
 * 闸门谓词（**单一实现**）：破坏性且未声明 ⇒ 该动作会被拒。
 * `assertMigrationDeclared`（单对象路径：判到即抛）与 `applyChangeset` 的整体预检（批次：判而不抛，
 * 把整批被拦项一次收齐再统一拒绝）共用同一谓词——两处各写一份时，预检与执行期闸门的口径必然漂移。
 */
function migrationGateRejected(
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
function summarizeBreakingItems(items: BreakingAssessment['items']): string {
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
    accepted: breaking.level !== 'breaking' || migration !== undefined,
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
   * P6 破坏性判定（**直接下游（单跳）**有引用 ⇒ level='breaking'；无引用 ⇒ 'none'；判定/回执都用
   * impact() 的默认 depth=1 口径，需要传递影响面请用 hana_metadata_where_used 的 depth>1）。
   * 成功回执必然带出（只报告，不阻断）。
   * 下游只计**设计时引用**：运行时 __RT_* 目录引用已在判定输入处过滤（见 designTimeDownstream 的实测说明，
   * 不过滤的话任何已激活对象的删除都会被误拦）。
   */
  breaking?: BreakingAssessment;
  /** P6 迁移声明闸门记录（删除通道的声明位 strategy 固定为 acknowledge_dependents；形状见 MigrationGateRecord） */
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
 * P6（SSD §5.3 判定表「删除整个视图」行 + §5.4 / D2 闸门——**对 SSD 的扩展**）：
 * SSD §5.4 只写了 update 的 migration 参数，但计划 §4.2 判定表把「删除整个视图（下游有引用）」列为破坏、
 * 处置口径是「先解除依赖或调用方显式承担」，D2 又要求破坏性变更阻断 ⇒ 按最忠实读法：删除同样进闸门，
 * 声明位 strategy 固定为 acknowledge_dependents（删除没有可自动化的迁移策略）。此前对下游只给一句
 * uncertain 提示（planWrite 的写法），不进判定——本轮按计划缺口 3 收口。
 * 下游无引用 ⇒ 行为与今天完全一致（不阻断），回执带 breaking.level='none'。
 * 「下游」= **直接下游（单跳）的设计时下游**（impact() 默认 depth=1）：运行时 __RT_* 目录引用在判定
 * 输入处过滤（与 update 闸门共用 designTimeDownstream）——实测每个已激活对象都带一条
 * __RT_CATALOG_VIEW__ 自引用行，不过滤则本闸门会拦截所有已激活对象的删除。
 * 影响半径查询放在锁**外**（deleteViaRest 自持锁且锁不可重入；更根本地，**本对象的锁挡不住别人加依赖**——
 * 加依赖是去写「依赖方」对象，取的是依赖方的锁。放锁内只会拉长临界区、买不到任何保护；跨进程真相
 * 仍是 ETag + 服务端语义，见 SSD §4.1）。判定与 DELETE 之间的依赖新增窗口由此如实存在——回执带
 * impactAsOf（判定读取时点），调用方据此核对窗口；判定刻意只认单跳（每次写都跑全闭包代价太大），
 * 需要传递影响面请用 hana_metadata_where_used(depth>1)。
 *
 * P7 修复批（opt-in）：opts.ifMatch 允许调用方传入**预读**的删除基线（变更集 delete 项用），
 * 使「预读 → 删除」之间的第三方写入以 412 暴露（该项 conflict_external）；不传 = 锁内自取（现状）。
 */
export async function deleteCalculationView(
  config: HanaConfig,
  pool: HanaPool,
  packageId: string,
  objectName: string,
  opts: {
    migration?: { strategy: 'acknowledge_dependents'; note?: string };
    /**
     * 调用方**预读**的删除基线（P7 修复批，可选、向后兼容）：透传给 deleteViaRest 作为 DELETE 的
     * If-Match ⇒ 「预读 → 删除」之间的第三方写入必得 412（不再被锁内重取的基线吸收）。
     * 不传 = 现状：锁内自取删除前基线（单对象通道零改动）。
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
    // P6：成功回执必带上判定与闸门记录（无下游时只报告：level='none'、required=false）
    breaking: gate.breaking,
    migration: migrationGateRecord(gate.breaking, opts.migration),
    // 判定读取时点（impact().asOf）：判定在锁外、与 DELETE 之间有依赖新增窗口（见函数头注）——
    // 如实带出「下游集合是什么时刻读的」，调用方据此核对窗口（判定之后新增的依赖不体现在本次判定里）。
    impactAsOf: gate.asOf,
    // 被过滤掉的运行时目录引用条数照实带出（>0 才产生）：与 update 回执同口径，不许静默过滤。
    ...(gate.runtimeOnly > 0 ? { runtimeOnly: gate.runtimeOnly } : {}),
  };
  // 基线缺失是**静默退化**吗？不——与 activate 同形：回执给 deleteNote + 日志留痕（仅该情形产生字段）。
  // 后果如实说明：本次 DELETE 未带 If-Match，删除前读取之后发生的第三方写入不会被 412 拦截（删除照常执行）。
  if (baseline.ifMatchMissing) {
    result.deleteNote =
      '删除前元数据读取未返回 ETag：本次删除未带 If-Match，' +
      '删除前读取之后发生的第三方写入不会被 412 拦截（删除仍以服务端实际执行结果为准）；' +
      '需要并发保护请先自行读取基线（读取 → 核对 → 再删除）';
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
 * 注：client 为 P7 追加的**可选共享会话**（与 updateCalculationView/deleteCalculationView 的既有形状对齐）——
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
    // 类型表已单点化到 model/view-types（此前此处与 view-builder 各存一份逐项相同的集合），
    // 回执里的度量数必须与生成的 XML 用同一判定，否则两边都"看起来对"却互相矛盾。
    measureCount = measureMode === 'SUM_NUMERIC' ? columns.filter((c) => isNumericType(c.dataTypeName)).length : 0;
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
      const meta = await writeViaRest(
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
      // 回执基线：etag/version 与 activated 读数取自**同一次写响应**（响应头 ETag + SapBackPack），
      // 不二次读取不拼装（§4.2#1 约定：回执里的读数必须来自同一时刻的同一次读取）
      const version = meta.SapBackPack?.Version;
      result.etag = meta.ETag;
      result.etagSource = meta.etagSource ?? 'unavailable';
      result.version = version;
      // 跨进程并发迹象（诚实化）：写入前锁内检查为「不存在」而写后版本号 > 1 ⇒ **通常**意味着期间有他人写过。
      // 措辞刻意写成可证伪的推断：服务端若对同名重建沿用旧版本计数，delete→重建同样会看到 >1，那不是并发迹象。
      // 没有并发迹象时不产生该字段（不制造恒为空噪音）。
      if (version !== undefined && version > 1) {
        result.concurrencyNote =
          `写入后版本号为 ${version}（>1）：这通常意味着本次调用期间有他人写过同名对象，` +
          `本次写入可能覆盖了对方的内容（PUT 为 create-or-update、服务端没有 409 前置，` +
          `跨进程同名创建属 last-write-wins 的已知例外）；但若该对象此前被删除重建过、` +
          `服务端沿用了旧的版本计数，版本号也可能不回退、并不代表有人写过。` +
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
 * 注：参数较多（6 个，含可选 client），tools 层调用点未同步改造，故签名保持现状。
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
    result.etag = meta.ETag;
    result.etagSource = meta.etagSource ?? 'unavailable';
    result.version = meta.SapBackPack?.Version;
    // **先**读 etag/version 再剥仅供进程内判定的内部字段（`_httpStatus`）：与 create/update 的成功回执
    // 同形（那两处都走 stripInternalMeta），不把内部字段泄漏给调用方
    result.meta = stripInternalMeta(meta);
    if (!ifMatch) {
      // ETag 缺失（理论上不该发生）：本次激活退回无 If-Match 旧行为——并发第三方修改不会被 412 拦截。
      // 如实体现（回执 + 日志），不静默。
      result.activateNote =
        'fileMeta 未返回 ETag，无法建立 If-Match 基线：本次激活退回不带 If-Match 的旧行为，' +
        '并发的第三方修改不会以 412 暴露（激活结果仍以服务端实际执行结果为准）';
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
 * 注：4 个参数（saveTo/client 可选），tools 层调用点未同步改造，故签名保持现状。
 */
export async function exportPackageViaRest(
  config: HanaConfig,
  packageId: string,
  saveTo?: string,
  client?: XsRestClient,
): Promise<ExportPackageResult> {
  assertSafeObjectName(packageId, '包');
  const rest = client ?? new XsRestClient(config);
  const { buffer, url } = await rest.exportPackageZip(packageId);
  const result: ExportPackageResult = { packageId, sizeBytes: buffer.length, url };
  if (saveTo) {
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
  /** 回读基线：导入**写完之后**独立回读到的 ETag（与写动作不同源，语义见 etagSource；回读失败时缺省） */
  etag?: string;
  /** etag 的来源（见 EtagSource）：'read-back'=独立回读；'unavailable'=回读未拿到 ETag 或回读失败（后者见 readBackError） */
  etagSource?: EtagSource;
  /** 回读到的服务端版本号（与 etag 同一次读取，不拼装） */
  version?: number;
  /**
   * 写入后回读失败的原因（仅回读失败时产生该字段，此时 meta 缺省）。
   * 与 etagSource='unavailable' 的区别（「查不到与没去查必须可区分」）：unavailable 只表示这次读取没带 ETag
   * （读到了对象但无 ETag），readBackError 表示**回读本身失败了**（没读到，原因在此）——导入结果仍以
   * imported=true 为准（写入确实发生了），回读只是附加信息。
   */
  readBackError?: string;
  /**
   * 跨进程并发迹象（只有实测到时才产生该字段，不制造恒为空噪音）：
   * 写前检查为「不存在」而回读版本号 > 1 ⇒ 本次调用期间有他人写过该对象（导入的新对象可能已被覆盖）。
   * 跨进程无服务端前置（xfer 导入没有 If-Match），属 SSD §4.1 的已知例外。
   */
  concurrencyNote?: string;
}

/**
 * 导入单个设计时文件（POST+PUT /base/xfer/import，官方 Transfer API）。
 * 导入是写操作：目标包仅允许 ZDEMO（含子包）。
 * 【默认拒绝覆盖】目标文件已存在时抛错并指引改用 hana_view_update（已有对象的修改走更新通道，
 * 禁止 delete+重建或静默覆盖）；确需覆盖导入（如备份恢复）须显式 overwrite=true。
 * 来源：content 内联内容（须配 fileName），或 filePath 本地文件（默认取 basename 做目标文件名）。
 * 并发（§4.1 import 行）：整段「存在性检查 → 导入 → 回读」在同一把 keyed lock 内；锁键用
 * normalizeObjectName(文件名) 剥掉后缀——与外层 create/update/activate/delete/validate 对同一对象同键。
 * 守卫收紧：只有 404（OBJECT_NOT_FOUND）才算「不存在」，其它错误 rethrow（fail-closed）。
 * 注：3 个参数（input/client），tools 层调用点未同步改造，故签名保持现状。
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
    if (!fileName)
      throw new HanaBusinessError('内联内容导入必须提供 fileName（目标文件名，如 ZDEMO_CV_X.calculationview）');
    content = input.content;
  } else if (input.filePath) {
    content = await readFile(input.filePath);
    fileName ??= basename(input.filePath);
  } else {
    throw new HanaBusinessError('导入需要提供 content 或 filePath 之一');
  }
  assertSafeObjectName(fileName!, '目标文件名');
  const targetFile = fileName!;
  const rest = client ?? new XsRestClient(config);
  // 存在性检查 → 导入 → 回读整段同一临界区（锁键已剥后缀，与 create/update 同对象同键）；
  // 锁不可重入：本临界区内不再取同一把锁（fileMeta/importFile 都不取锁）。
  return withKeyedLock(writeLockKey(input.targetPackageId, normalizeObjectName(targetFile)), async () => {
    if (!input.overwrite) {
      // 默认拒绝覆盖：已有对象的修改应走 hana_view_update（PUT + If-Match），保持版本演进而非删除重建
      let existing: FileMeta | undefined;
      try {
        existing = await rest.fileMeta(input.targetPackageId, targetFile);
      } catch (e) {
        // 守卫收紧（fail-closed）：**仅** 404（OBJECT_NOT_FOUND）视为不存在；403/网络错误等一律 rethrow——
        // 把读异常当成「不存在」会让无权限/故障中的调用方静默覆盖已有对象
        if (!(e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND')) throw e;
        existing = undefined;
      }
      if (existing) {
        throw new HanaBusinessError(
          `目标对象 ${input.targetPackageId}/${targetFile} 已存在，导入默认拒绝覆盖。` +
            `请改用 hana_view_update 对已有对象做修改（读取 → 修改 → 更新），或显式传 overwrite=true 覆盖导入`,
        );
      }
    }
    await rest.importFile(input.targetPackageId, targetFile, content);
    // 写后失效视图缓存（§4.5）：对象名用剥掉后缀的裸名（与 get() 的 key 构造一致）
    invalidateViewCache(input.targetPackageId, normalizeObjectName(targetFile));
    // 落库状态回读（inactive / active 语义由服务端决定，如实呈现）。
    // 失败保持现状：meta undefined 但 imported=true（写入已发生，回读只是附加信息，不掩盖导入结果）——
    // 但失败原因必须可见（回执 readBackError + 日志）：不能只留一个 etagSource='unavailable'，
    // 那与「回读成功但无 ETag」不可区分（违反本仓「查不到与没去查必须可区分」）。
    let meta: FileMeta | undefined;
    let readBackError: string | undefined;
    try {
      meta = await rest.fileMeta(input.targetPackageId, targetFile);
    } catch (e) {
      meta = undefined;
      readBackError = e instanceof Error ? e.message : String(e);
      logger.warn(
        { packageId: input.targetPackageId, fileName: targetFile, err: e },
        '导入后回读失败：落库状态未知（导入本身已发生，imported=true 不变）',
      );
    }
    const result: ImportObjectResult = {
      object: { packageId: input.targetPackageId, fileName: targetFile },
      imported: true,
      meta,
      ...(readBackError ? { readBackError } : {}),
    };
    const version = meta?.SapBackPack?.Version;
    if (meta?.ETag !== undefined) {
      // 回执基线 = 回读值（与写动作不同源，故标 read-back 而非 response-header）
      result.etag = meta.ETag;
      result.etagSource = 'read-back';
    } else {
      result.etagSource = 'unavailable';
    }
    result.version = version;
    // 跨进程竞态（§4.1 import 行）：写前检查为「不存在」而回读版本号 > 1 ⇒ **通常**意味着期间有他人写过该对象。
    // 该字段只在 overwrite !== true 时产生：overwrite=true 时写前未做检查，回读到的 Version>1 可能本就是
    // 该对象的既有历史版本——报「本次调用期间有他人写过」会把推断说成事实，故不产生该字段。
    // 措辞同 create 路径：可证伪的推断（服务端若对同名重建沿用旧版本计数，delete→重建也会 >1）。
    if (!input.overwrite && version !== undefined && version > 1) {
      result.concurrencyNote =
        `导入回读的版本号已是 ${version}（>1）：这通常意味着本次调用期间有他人写过该对象，` +
        `导入的内容可能已被对方覆盖（xfer 导入没有 If-Match 前置，跨进程导入属 last-write-wins 的已知例外）；` +
        `但若该对象此前被删除重建过、服务端沿用了旧的版本计数，版本号也可能不回退、并不代表有人写过`;
    }
    return result;
  });
}

/** 变更列表查询（GET /base/change，只读；Change-Tracking API） */
export async function listChangesViaRest(
  config: HanaConfig,
  opts: { user?: string; status?: number } = {},
  client?: XsRestClient,
): Promise<unknown> {
  const rest = client ?? new XsRestClient(config);
  return rest.changeList(opts);
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
 * - 跨进程永不撞名 ⇒ 甲进程的残留清理不可能删到乙进程正在用的副本（复验批实测的 P1/P2/P3 删除链，
 *   根因就是旧实现只按对象名推导、跨进程同名）。
 * 已知边界：进程重启后 nonce 翻新，旧名残片不再被新进程推导命中（不会被误删，但只能人工清理）。
 */
const TEMP_CHECK_PROCESS_NONCE = randomBytes(6).toString('hex');

/**
 * 临时校验对象名（**内部用途**，导出仅供单测断言）：截断基名 + '_' + 短哈希 + '_CHKTMP'，总长 ≤ 29。
 * 哈希 = sha256(**完整**对象名 + '|' + 进程 nonce) 前 6 位十六进制（node:crypto）：进程内确定性可复现，
 * 跨进程必然不同名（nonce = 48 位随机）。哈希覆盖**完整**对象名的作用：两个前缀相同但长度不同的
 * 对象名截断后不再撞成同一个临时名（旧实现 slice(0,22) 会撞，且 22+7 > 29 也不满足长度预算）。
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
 * 不变量（修 1 明确断言）：登记表只可能记录「本进程用**本进程 nonce** 推导出的名字」——
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
 * 把「临时校验副本清理未完成」的残留信息附加到**校验自身抛出的错误**上（修 2b）：
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
 * 对设计时对象做「激活前校验」（临时副本 + Check，原对象不受影响；仅 ZDEMO）。
 * 并发（§4.1 validate 行）：
 * - 内容读取在锁内（与写入序列同源：此前在锁外读，窗口内并发写入会让校验对象名实不符）；
 * - 临时名由 tempCheckName 按「对象名 + 进程 nonce」推导（总长 ≤29、带短哈希）：进程内同名恒定、
 *   跨进程永不撞名。同一进程的并发校验互删副本、跨进程的残留互删都从命名层消除；
 *   锁只需把「探测 → 预清理 → 写入校验 → 收尾清理」整段按对象串行化；
 * - 写入前探测推导名是否已是既有对象：**存在且不在登记表里** ⇒ 不写不删、抛 TEMP_NAME_CONFLICT（如实报告）。
 * 为什么**不**用 If-Match 按「对象实例」验身份（上一版机制已删除，**勿再加回**）：
 *   ① 预清理的基线取自**本次探测读数**，恒等于当前占用者 ⇒ 它只能证明「这个名字上有对象」，
 *      证明不了「它属于本进程」——自指，挡不住跨进程同名时的误删（复验批实测：P1 留残片 →
 *      P2 探测到该占用者、预清理 412 抛 TEMP_NAME_CONFLICT 但登记未撤销 → P3 再次校验探测到同一个
 *      占用者、用本次读数当基线，把占用者删掉）；
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
    // 内容快照与写入序列同源：设计时内容在锁内读（此前在锁外读，锁内写入的将是锁外读到的旧快照）
    const content = await rest.fileContent(packageId, file);
    // 写入前探测：推导名是否**已是既有对象**。fileMeta 的 404 带 OBJECT_NOT_FOUND 码（xs-rest 契约），
    // 据此判定「不存在」；其它错误（403/网络等）必须 rethrow——吞掉会让故障中的调用方误删/误写真实对象。
    let tempExists = false;
    try {
      await rest.fileMeta(packageId, tempFile);
      tempExists = true;
    } catch (e) {
      if (!(e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND')) throw e;
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
        if (!(e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND')) {
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
      // 校验自身的失败先留住，不在此抛出：收尾清理的残留信息要能附加到**同一个**错误上（修 2b）
      checkFailed = true;
      checkFailure = e;
    }
    // 收尾清理本次创建的副本。刻意不用 finally：finally 里无法把残留信息附加到同一刻抛出的异常上
    // （复验批点名的缺陷——调用方只看到校验失败，看不到残留对象名）。
    // 只删登记过的名字（未登记的名字在探测处已叫停，绝不删）。404 = 已不存在（清理完成）；
    // 其它失败 ⇒ 保留登记（下一次同对象校验认领清理）+ 填 tempResidue + warn，不静默。
    if (tempCheckRegistry.has(registryKey)) {
      try {
        await rest.deleteFile(packageId, tempFile);
        tempCheckRegistry.delete(registryKey);
      } catch (e) {
        if (e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND') {
          tempCheckRegistry.delete(registryKey);
        } else {
          // reason 经 redactSensitive（修 2a）：tempResidue 会进**成功信封**的 data——脱敏口径与失败信封
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
    // 校验失败时残留信息不随异常丢失（修 2b）：挂到抛出的错误上（消息含残留对象名 + rawDetail）
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

/* ── P7 变更集（多对象事务）：SSD §6.1 第 2–4 步 + §6.3 补偿 + §6.4 报告 ────────
 * 单次调用内闭合的四步：① planChangeset 整体预检（形状非法 / 相交 / **破坏性未声明** ⇒ 整批拒绝零写入，
 * 破坏性判定见 precheckChangesetGates——在任何写之前）② 逐项执行（各自完成含激活）
 * ③ 失败 ⇒ 逆序补偿 ④ 组装报告（partial 与 notExecuted 显式枚举，绝不把部分完成包装成 success）。
 *
 * 【对 SSD §6.1「整批持有 keyed lock」的实测偏差】原文要求「逐个 withKeyedLock 并整批持有至批结束」——
 * 在本仓**不可实现且会自锁死**：withKeyedLock 不可重入，而三个写路径各自会取同一把对象锁
 * （createCalculationView 的临界区 / updateCalculationView 的整段判定与 PUT / deleteCalculationView →
 * deleteViaRest），批内先持锁再调用它们 = 排队等自己。本批的裁定：
 *   - **逐项执行、各自取锁**：动作已按 (packageId, objectName) 字典序稳定排序（planChangeset），
 *     任意两批不会形成顺序相反的加锁环 ⇒ 不构成 ABBA 死锁；
 *   - 批的一致性由另两条既有保证兜住：批内**对象级相交检测**（§6.2，相交 ⇒ 零写入）与
 *     **每项自己的 If-Match 基线**（写前预读的 ETag 显式传给写路径 ⇒ 批外并发写以 412 暴露 ⇒
 *     `conflict_external`），而不是靠整批持锁的隔离；
 *   - 代价如实说：批**不提供跨项快照隔离**——逐项提交，失败即逆序补偿，期间的批外读写对本批可见。
 * 该裁定同时写进回执（ChangesetReport.concurrencyNote），调用方不必读代码就知道这条偏差与理由。
 *
 * 依赖说明（I3）：读写集推导/排序/相交检测全部由 changeset.plan（其内部走 write-plan 的共享扫描件）
 * 承担，本文件**不出现第二份**扫描器；写路径一律复用既有服务函数，不另写一份。
 */

/**
 * 变更集单项报告（SSD §6.4 形状）。
 *
 * `index` 是**调用方原始顺序**的下标（不是执行序位置）：执行按 planChangeset 的字典序，
 * 但报告一律按调用方自己的顺序说话——否则「第 3 项失败」在报告里会指向另一个动作。
 */
export interface ChangesetReportItem {
  index: number;
  packageId: string;
  objectName: string;
  action: string;
  status: 'ok' | 'failed' | 'compensated' | 'compensation_failed' | 'conflict_external';
  /**
   * 该项**写成功后**回执里的新基线（= 该项的补偿基线，SSD §6.3）。
   * 为什么不能用写前基线：本项自己的 PUT 已推进版本，拿写前基线做补偿的 If-Match 必得伪 412。
   * delete 项恒无此字段：删除后不存在可作基线的 ETag——它的补偿材料是原文（回写），不是 ETag。
   */
  etag?: string;
  /** etag 的来源（代码既有 EtagSource 连字符取值）：'response-header'=写响应头同刻读数；'unavailable'=回执没带基线 */
  etagSource?: EtagSource;
  /** 失败原因（失败的项与补偿失败的项都带出）；code 为机读码（如 412 / migration_required / OBJECT_NOT_FOUND） */
  error?: { code?: string; text: string };
  /**
   * 补偿失败 / 批外冲突的**结构化现场**（评审要求：不许只塞进 error.text）。
   * 来源：412 冲突载荷的补读（currentETag/currentVersion）或补偿前探测读数；取不到就不产生该字段。
   */
  currentETag?: string;
  currentVersion?: number;
  /** 本项**自身**执行耗时 ms（写入前预读 + 写入/激活）；不含补偿耗时（补偿计入报告总 elapsedMs） */
  elapsedMs?: number;
  /**
   * 该项写成功后服务端回报的**激活状态**（修 2；来源：update → UpdateCalculationViewResult.activated、
   * create → CreateCalcViewResult.activated——均取自写响应的 SapBackPack.Activated 同刻读数）。
   * SSD §6.1 第 3 步要求各项「各自完成（**含激活**）」：activated === false 的项按 `failed` 处理
   * （触发停止 + 逆序补偿 + partial=true），activated === true 照旧 ok。
   * delete 项没有激活概念，如实缺省（不产生该字段）。
   */
  activated?: boolean;
  /**
   * 激活未通过的一行摘要（修 2；来源与单对象通道回执的 activationErrors 同源：错误码 + 首行）。
   * 完整激活明细（含 Type/Procedure DDL）不随变更集报告透出——失败项的 error.text 里给复核线索。
   */
  activationErrors?: string;
}

/**
 * 未执行项（不变量 2：所有「部分成功」都要**显式枚举未完成项**，不许打包成 success，也不许让调用方
 * 靠 requested 与 applied 的差集自行推断）。两个来源：
 * - 批被**整体预检拒绝**（载荷形状非法 / 批内相交 / 破坏性未声明 ⇒ 整批拒绝、零写入）：全部动作都未执行，
 *   reason='batch_rejected'——此时没有报告可返回（调用以业务错误终止），同一形状的枚举随**三条拒绝路径**
 *   的载荷 errorDetail.notExecuted 带出（修 4：三条路径统一携带，机读方不会在其中任何一条落空）；
 * - 某项失败后**中止**（SSD §6.1：任一项失败即停止）：该项之后（执行序）的动作一件都不执行，
 *   reason='aborted_after_failure'。
 */
export interface ChangesetNotExecutedItem {
  /** 调用方原始顺序的下标（与 ChangesetReportItem.index 同一口径） */
  index: number;
  packageId: string;
  objectName: string;
  action: string;
  reason: 'batch_rejected' | 'aborted_after_failure' | 'cancelled';
  /** 为什么没执行（如「因第 N 项失败而中止」）；无补充信息时缺省（不制造恒为空噪音） */
  detail?: string;
}

/**
 * partial 报告 ⇒ 业务失败错误（I2：绝不把部分完成包装成 success）。
 *
 * **单点实现**：同步工具通道（hana_view_update 的 changeset 分支）与异步任务通道（async-task.service
 * 的终态结算）共用这一份——两处各写一遍文案与载荷必然漂移，而这是调用方据以判读批次结局的关键回执。
 * 逐项 status/etag/elapsedMs 与结构化补偿现场原样进 rawDetail.report，机读方按 {applied, partial} 形状读。
 */
export function changesetPartialError(report: ChangesetReport): HanaBusinessError {
  const skipped = report.requested - report.applied.length;
  return HanaBusinessError.withRawDetail(
    `变更集未全部成功（partial=true）：共 ${report.requested} 项——` +
      report.applied
        .map((x) => `第 ${x.index} 项 ${x.action} ${x.packageId}/${x.objectName} ⇒ ${x.status}`)
        .join('；') +
      // 首次失败即停止（不继续执行后续项）：未执行项不进 applied，这里如实点名数量，别让调用方以为漏报了
      (skipped > 0 ? `；另有 ${skipped} 项在首次失败后未执行` : '') +
      '。逐项明细与补偿现场见 raw.errorDetail.report。',
    'changeset_partial',
    { report },
  );
}

/**
 * 变更集报告（SSD §6.4；I2：部分成功显式枚举）。
 *
 * `applied` 只装**实际执行过**的动作：它可能少于 `requested`——差额就是「首次失败之后按其后未执行的动作」
 * （SSD §6.1：任一项失败即停止）。未执行项**不进 applied**（状态枚举里没有 skipped，宁可少报也不凭空标
 * ok/failed），整体信号由 partial 承担。
 *
 * `notExecuted` 是**必填**字段（对 SSD §6.4 形状的扩展，不变量 2）：未执行项显式枚举，别让调用方靠
 * applied 的差集推断（机读方容易漏）。全成功时为空数组（不制造噪音）。
 *
 * `concurrencyNote` 是 always present 的**偏差声明**（见文件段落头注）：批不整批持锁，逐项执行各自取锁。
 */
export interface ChangesetReport {
  requested: number;
  applied: ChangesetReportItem[];
  /** 本次**没有执行**的动作（前项失败后中止；批被预检拒绝的情形见 ChangesetNotExecutedItem）：显式枚举（不变量 2） */
  notExecuted: ChangesetNotExecutedItem[];
  /** 有任何非 ok ⇒ true。绝不允许把部分完成包装成 success（I2） */
  partial: boolean;
  /**
   * true = 因**取消请求**而停止（工具化任务 API 的 hana_task_cancel）——与失败中止走同一条
   * 「停止 → 逆序补偿 → 如实报告」路径，此字段让调用方区分两种停止原因（未取消时不产生该键）。
   */
  cancelled?: boolean;
  /** 报告组装时刻（进程时区 ISO 秒级，与 impact().asOf 同一口径） */
  asOf: string;
  /** 总耗时 ms（SSD §6.5：批时长如实给——每对象含 2–10s 激活） */
  elapsedMs: number;
  /** 并发裁定说明（always present）：为什么不整批持锁 + 防 ABBA 与正确性由什么兜住（见段落头注） */
  concurrencyNote: string;
}

/**
 * 并发裁定文案（单一常量：段落头注、报告字段、单测断言同一份，避免三处各写一遍而漂移）。
 * always present：它不是「实测到的异常」，而是本批**恒定成立**的并发语义——调用方必须知道批不提供隔离。
 */
const CHANGESET_LOCKING_NOTE =
  '并发裁定（对 SSD §6.1「整批持有 keyed lock」的实测偏差）：本批逐项执行、各自取锁，不整批持锁——' +
  'withKeyedLock 不可重入，而 create/update/delete 各写路径自身会取同一把对象锁，批内先持锁再调用它们等于自锁死。' +
  '防 ABBA 死锁由执行序保证（动作已按 (packageId, objectName) 字典序稳定排序，任意两批不会形成相反加锁环）；' +
  '批的一致性由另两条兜住：批内对象级相交检测（§6.2，相交 ⇒ 整批拒绝零写入）与每项自己的 If-Match 基线' +
  '（批外并发写 ⇒ 该项 412 ⇒ conflict_external）。代价如实说：本批**不提供跨项快照隔离**——逐项提交，' +
  '失败即逆序补偿（§6.3），期间的批外读写对本批可见。';

/** 执行期的内部记录 = 报告项 + 补偿材料（原文 / 写成功后的新基线） */
interface ChangesetRecord {
  index: number;
  action: ChangesetAction;
  status: ChangesetReportItem['status'];
  /** 写成功后的新 ETag（**补偿基线**；create/update 才有；delete 后无基线可言） */
  postEtag?: string;
  etagSource?: EtagSource;
  /** 该项写入后服务端回报的激活状态（修 2：update/create 才有；delete 无激活概念 ⇒ 缺省） */
  activated?: boolean;
  /** 激活未通过的一行摘要（修 2；与单对象通道回执的 activationErrors 同源） */
  activationErrors?: string;
  /** 写入前紧贴本项预读的原文（update/delete 的补偿材料；create 无原文，补偿=删除） */
  originalXml?: string;
  error?: { code?: string; text: string };
  currentETag?: string;
  currentVersion?: number;
  elapsedMs: number;
}

/** 单项执行的**成功**结果：补偿材料随之带出（失败即抛出，由调用方记成 failed/conflict_external） */
interface ChangesetActionOutcome {
  originalXml?: string;
  postEtag?: string;
  etagSource?: EtagSource;
  /**
   * 激活状态（修 2）：写响应同刻读数。走到「成功结果」里只可能是 true 或缺省——
   * activated === false 的项在 executeChangesetAction 内即抛 ChangesetActivationError（按 failed 处理），
   * 不会作为成功结果返回；缺省 = 该项没有激活概念（delete）。
   */
  activated?: boolean;
}

/**
 * 变更集项的**激活失败**（修 2，内部错误：只在 executeChangesetAction → applyChangeset 的 catch 之间流转）。
 * 为什么要有这个专用类型：写成功但激活未通过（HTTP 555，文件已写）必须按 failed 处理，而报告项要同时
 * 如实带出 activated=false 与 activationErrors 摘要——普通错误携带不了这两个读数，用 rawDetail 塞又
 * 会把它（若意外逃逸）当服务端原始载荷回显，语义不对。它 extends HanaBusinessError ⇒ 既有
 * changesetErrorOf（脱敏文本 + 机读码）与 changesetFailureStatus（非 412 ⇒ failed）路径零改动复用。
 */
class ChangesetActivationError extends HanaBusinessError {
  constructor(
    message: string,
    /** 激活失败摘要（单对象通道回执 activationErrors 同源；服务端未附明细时缺省） */
    readonly activationErrors: string | undefined,
    /** 服务端激活错误码（如 40117），取自 activationDetail.errorCode */
    code?: string,
  ) {
    super(message, code);
    this.name = 'ChangesetActivationError';
  }
}

/** 单项补偿结果：只两态——回到批前状态（compensated）或如实失败（带结构化现场） */
type ChangesetCompensationOutcome =
  | { status: 'compensated' }
  | {
      status: 'compensation_failed';
      error: { code?: string; text: string };
      currentETag?: string;
      currentVersion?: number;
    };

/**
 * 执行一次变更集（SSD §6.1 的 1–4 步，单次调用内闭合）。
 *
 * 失败语义：**整批拒绝**发生在第 1 步（载荷形状非法 ⇒ changeset_invalid（修 3：形状校验已前移到任何 I/O
 * 之前）；批内相交 ⇒ changeset_conflict；**破坏性未声明 ⇒ migration_required**），三者都在任何写动作
 * 之前、零写入，且机读载荷统一带 notExecuted（修 4）；第 2 步起的失败（含修 2 的「写成功但激活失败」）
 * 一律走「停止 → 逆序补偿 → 如实报告」，绝不包装成 success。
 *
 * P7 修复批（实机验收场景③暴露的缺口）：破坏性判定从「逐项执行内部」**提到整体预检**——此前批内
 * 破坏性未声明的动作要跑到它自己那一步才被 P6 闸门拒，前面的动作已经写过库、版本已推进，随后才逆序
 * 补偿；审计上可见两次写入。SSD §6.1 第 1 步要求的是「任一被拦 ⇒ 整批拒绝、零写入」，故预检阶段
 * （冲突检测之后、逐项执行之前）先把每个动作的判定跑一遍（只读，见 precheckChangesetGates）。
 */
export async function applyChangeset(
  config: HanaConfig,
  pool: HanaPool,
  input: { actions: ChangesetAction[] },
  client?: XsRestClient,
  hooks?: {
    /** 协作式取消检查点：**每个动作开始前**调一次；true ⇒ 本项与后续项都不执行，走与失败相同的逆序补偿 */
    shouldAbort?: () => boolean;
    /** 每完成一项后回调（异步任务的进度回报用；同步路径不传） */
    onStep?: (info: { done: number; total: number; index: number; status: string }) => void;
  },
): Promise<ChangesetReport> {
  const startedAt = Date.now();
  const actions = readChangesetActions(input);
  // 第 1 步：整体预检（纯函数、零 I/O）。三条拒绝路径都在任何写动作之前 ⇒ 整批拒绝、零写入：
  //   ① planChangeset（数量 / action 取值）⇒ changeset_invalid
  //   ② 载荷形状校验（修 3，前移到本步：确定性形状错误不许 fail-open 到执行期）⇒ changeset_invalid
  //   ③ 相交检测 ⇒ changeset_conflict + rawDetail.conflicts（含冲突对象与两个**原始下标**）
  // 每条拒绝的机读载荷都带 notExecuted（修 4）：机读方按 notExecuted 读「哪些没做」时不会落空。
  const plan = planChangesetOrThrow(actions);
  const shapeErrors = changesetPayloadShapeErrors(actions);
  if (shapeErrors.length > 0) throw changesetInvalidPayloadError(shapeErrors, actions);
  if (plan.conflicts.length > 0) throw changesetConflictError(plan.conflicts, actions);

  // 第 1.5 步（整体预检的判定面，SSD §6.1 第 1 步「任一被拦 ⇒ 整批拒绝、零写入」）：逐动作做破坏性
  // 判定（**任何写之前**；判定本身只读，见 precheckChangesetGates）。任一被拦 ⇒ 整批拒绝、零写入。
  const rejected = await precheckChangesetGates(config, pool, plan, client);
  if (rejected.length > 0) throw changesetMigrationRequiredError(actions, rejected);

  // 第 2 步：逐项执行（按 planChangeset 的字典序执行序；每项各自完成、含激活）。
  // 任一项失败 ⇒ **立刻停止**（不继续执行后续项），进入第 3 步。
  const executed: ChangesetRecord[] = [];
  const notExecuted: ChangesetNotExecutedItem[] = [];
  let aborted = false;
  let cancelledByRequest = false;
  for (let i = 0; i < plan.order.length; i++) {
    const step = plan.order[i]!;
    // 取消检查点（异步任务 API）：在**动作开始前**判定——当前动作不打断（写/激活是原子步），
    // 停止后与失败同路（逆序补偿），不会留下半批状态。
    if (hooks?.shouldAbort?.()) {
      for (const pending of plan.order.slice(i)) {
        notExecuted.push({
          index: pending.originalIndex,
          packageId: pending.action.packageId,
          objectName: pending.action.objectName,
          action: pending.action.action,
          reason: 'cancelled',
          detail: '收到取消请求，本项未执行（已执行的项按逆序补偿回批前状态）',
        });
      }
      aborted = true;
      cancelledByRequest = true;
      break;
    }
    const itemStartedAt = Date.now();
    try {
      const outcome = await executeChangesetAction(config, pool, step.action, client);
      executed.push({
        ...outcome,
        index: step.originalIndex,
        action: step.action,
        status: 'ok',
        elapsedMs: Date.now() - itemStartedAt,
      });
      hooks?.onStep?.({ done: executed.length, total: plan.order.length, index: step.originalIndex, status: 'ok' });
    } catch (e) {
      // 修 2：写成功但激活失败（HTTP 555）在 executeChangesetAction 内以 ChangesetActivationError 抛出——
      // 该项按 failed 记录，并如实带出 activated=false 与 activationErrors 摘要（报告形状见字段注释）。
      const activationFailure = e instanceof ChangesetActivationError ? e : undefined;
      executed.push({
        index: step.originalIndex,
        action: step.action,
        // 失败项的状态判定（SSD §6.4）：错误码 412（写冲突）⇒ conflict_external；其它 ⇒ failed
        status: changesetFailureStatus(e),
        elapsedMs: Date.now() - itemStartedAt,
        error: changesetErrorOf(e),
        ...changesetConflictEvidence(e),
        ...(activationFailure
          ? {
              activated: false,
              ...(activationFailure.activationErrors !== undefined
                ? { activationErrors: activationFailure.activationErrors }
                : {}),
            }
          : {}),
      });
      // 不变量 2：失败项之后（执行序）的动作一件都不执行——**显式枚举**进 notExecuted，
      // 别让调用方拿 requested 与 applied 求差集推断（机读方容易漏）。
      for (const pending of plan.order.slice(i + 1)) {
        notExecuted.push({
          index: pending.originalIndex,
          packageId: pending.action.packageId,
          objectName: pending.action.objectName,
          action: pending.action.action,
          reason: 'aborted_after_failure',
          detail: `因第 ${step.originalIndex} 项失败而按序停止（本项未执行）`,
        });
      }
      hooks?.onStep?.({
        done: executed.length,
        total: plan.order.length,
        index: step.originalIndex,
        status: 'failed',
      });
      aborted = true;
      break;
    }
  }

  // 第 3 步：逆序补偿——**只有中途失败（aborted）才补偿**：全成功时什么都不回退（否则等于自己把批撤销）。
  // 补偿对象是已 ok 的项，按**执行序的逆序**（executed 的排列就是执行序，倒着走即可）。
  // 一项补偿失败不阻断其余项：每项各自尽力回到批前状态，失败的原样报（compensation_failed + 结构化现场）。
  if (aborted) {
    for (let i = executed.length - 1; i >= 0; i--) {
      const record = executed[i]!;
      if (record.status !== 'ok') continue;
      const outcome = await compensateChangesetItem(config, record, client);
      record.status = outcome.status;
      if (outcome.status === 'compensation_failed') {
        record.error = outcome.error;
        if (outcome.currentETag !== undefined) record.currentETag = outcome.currentETag;
        if (outcome.currentVersion !== undefined) record.currentVersion = outcome.currentVersion;
      }
    }
  }

  // 第 4 步：组装报告（按调用方原始下标升序；partial 与 notExecuted 显式枚举，I2）
  const applied: ChangesetReportItem[] = executed
    .map((r) => ({
      index: r.index,
      packageId: r.action.packageId,
      objectName: r.action.objectName,
      action: r.action.action,
      status: r.status,
      ...(r.postEtag !== undefined ? { etag: r.postEtag } : {}),
      ...(r.etagSource !== undefined ? { etagSource: r.etagSource } : {}),
      // 修 2：激活状态与失败摘要如实带出（ok 项 activated===true；激活失败项 activated===false + 摘要；
      // delete 项没有激活概念 ⇒ 两个字段都不产生）
      ...(r.activated !== undefined ? { activated: r.activated } : {}),
      ...(r.activationErrors !== undefined ? { activationErrors: r.activationErrors } : {}),
      ...(r.error !== undefined ? { error: r.error } : {}),
      ...(r.currentETag !== undefined ? { currentETag: r.currentETag } : {}),
      ...(r.currentVersion !== undefined ? { currentVersion: r.currentVersion } : {}),
      elapsedMs: r.elapsedMs,
    }))
    .sort((a, b) => a.index - b.index);
  return {
    requested: actions.length,
    applied,
    notExecuted: notExecuted.sort((a, b) => a.index - b.index),
    partial: applied.some((x) => x.status !== 'ok'),
    // 因取消请求而停止（与失败同路径补偿）：如实标注，让调用方区分"失败中止"与"按你的取消停下"
    ...(cancelledByRequest ? { cancelled: true } : {}),
    asOf: nowIso(),
    elapsedMs: Date.now() - startedAt,
    concurrencyNote: CHANGESET_LOCKING_NOTE,
  };
}

/**
 * 全部动作的「未执行」枚举（reason='batch_rejected'，修 4）：三条零写入拒绝路径
 * （migration_required / changeset_conflict / changeset_invalid）的机读载荷**统一**携带同一形状——
 * 机读方按 notExecuted 读「哪些没做」时不会在其中任何一条路径上落空（此前只有 migration_required 带）。
 * `detailOf` 只给**被拦项**加一句为什么（其余不加，不制造恒为空噪音）。
 */
function changesetNotExecutedAll(
  actions: ChangesetAction[],
  detailOf?: (index: number) => string | undefined,
): ChangesetNotExecutedItem[] {
  return actions.map((action, index) => {
    const detail = detailOf?.(index);
    return {
      index,
      packageId: action.packageId,
      objectName: action.objectName,
      action: action.action,
      reason: 'batch_rejected' as const,
      ...(detail !== undefined ? { detail } : {}),
    };
  });
}

/** 第 1 步的入参判形：动作来自 JSON，类型层保证不了（非数组一律按形状错误拒绝、零写入） */
function readChangesetActions(input: { actions: ChangesetAction[] }): ChangesetAction[] {
  const actions: unknown = input?.actions;
  if (!Array.isArray(actions)) {
    const message = '变更集未执行（整批拒绝、零写入）：changeset.actions 必须是数组';
    // 修 4：机读载荷与另两条拒绝路径同形（无动作可枚举 ⇒ notExecuted 为空数组，如实缺省而非编造条目）
    throw HanaBusinessError.withRawDetail(message, 'changeset_invalid', { errors: [message], notExecuted: [] });
  }
  return actions as ChangesetAction[];
}

/**
 * 第 1 步：planChangeset（纯函数）。它抛的 Error 是**形状校验**（动作数超上限 / 未知 action），
 * 转成业务错误 changeset_invalid——消息原样保留（点名第几项与非法值），调用方据此改参数后重试。
 * 修 4：机读载荷带 errors（原因）+ notExecuted（覆盖全部动作，reason='batch_rejected'）。
 */
function planChangesetOrThrow(actions: ChangesetAction[]): ChangesetPlanResult {
  try {
    return planChangeset(actions);
  } catch (e) {
    const cause = e instanceof Error ? e.message : String(e);
    throw HanaBusinessError.withRawDetail(`变更集未执行（整批拒绝、零写入）：${cause}`, 'changeset_invalid', {
      errors: [cause],
      notExecuted: changesetNotExecutedAll(actions),
    });
  }
}

/**
 * 修 3：第 1 步的**载荷形状校验**（纯函数、任何 I/O 之前）——逐 action 判「该动作的载荷能不能表达」。
 * 为什么必须前移：此前本步只查数量与 action 取值，「update 既无 xml 也无 operations」「两者同给」
 * 这类**确定性**错误要等第 2 步执行到该项、由 updateCalculationView 抛错才失败——执行序上更早的动作
 * 已真实写入再被补偿，与「任一被拦 ⇒ 整批拒绝、零写入」的公开承诺相悖（评审两路各自命中）。
 * 只判形状，不判取值语义：create 的列/枚举等更深校验仍归 createCalculationView（同一处判定，不复制——
 * 与执行分支的既有注释同口径）；update 的「有 xml / 有 operations」与 updateCalculationView 同义
 * （空串/空数组不算有），判的就是要写的。
 * 「与自身无关的字段」一律拒绝而不是静默忽略（评审 low：静默忽略比报错更难查）——例如 delete 带 xml、
 * create 带 operations、update 带 create 专用的 description/mode/source/scripted。
 */
interface ChangesetPayloadError {
  /** 调用方原始下标（与报告口径一致） */
  index: number;
  message: string;
}

function changesetPayloadShapeErrors(actions: ChangesetAction[]): ChangesetPayloadError[] {
  const errors: ChangesetPayloadError[] = [];
  /** 「与自身无关的字段」检查：存在即报（undefined 才算没给，null 也按给了算——静默忽略更难查） */
  const rejectUnrelated = (index: number, action: ChangesetAction, fields: Array<keyof ChangesetAction>): void => {
    const present = fields.filter((f) => action[f] !== undefined);
    if (present.length > 0) {
      errors.push({
        index,
        message: `${action.action} 动作不接受与自身无关的字段：${present.join('、')}（给了即整批拒绝，不静默忽略）`,
      });
    }
  };
  actions.forEach((action, index) => {
    switch (action.action) {
      case 'update': {
        // 与 updateCalculationView 的入口判定同义（空串/空数组不算「有」）：二选一且必有其一
        const hasXml = typeof action.xml === 'string' && action.xml.length > 0;
        if (action.operations !== undefined && !Array.isArray(action.operations)) {
          errors.push({ index, message: 'operations 必须是数组' });
          break;
        }
        const hasOperations = Array.isArray(action.operations) && action.operations.length > 0;
        if (hasXml && hasOperations) {
          errors.push({ index, message: 'xml 与 operations 二选一，不能同时提供' });
          break;
        }
        if (!hasXml && !hasOperations) {
          errors.push({ index, message: '须提供 xml（全量 XML）或 operations（声明式操作补丁）之一' });
          break;
        }
        rejectUnrelated(index, action, ['description', 'mode', 'source', 'scripted']);
        break;
      }
      case 'delete': {
        // delete 的载荷就是「目标对象」本身；其余字段一律无落点（migration 是它合法的声明位，不在此列）
        rejectUnrelated(index, action, ['xml', 'operations', 'description', 'mode', 'source', 'scripted']);
        break;
      }
      case 'create': {
        rejectUnrelated(index, action, ['xml', 'operations', 'migration']);
        if (action.mode !== undefined && action.mode !== 'projection' && action.mode !== 'sql') {
          errors.push({
            index,
            message: `mode 非法：${JSON.stringify(action.mode)}（合法值：projection / sql）`,
          });
          break;
        }
        // 「须有可表达的定义」：projection（含缺省）要 source，sql 要 scripted——缺了就是确定性错误，
        // 不许拖到执行期才由 createCalculationView 报（那时更早的动作已写过库）
        if (action.mode === 'sql') {
          if (action.scripted === undefined)
            errors.push({ index, message: 'mode=sql 须提供 scripted（script + columns）' });
        } else if (action.source === undefined) {
          errors.push({ index, message: 'mode=projection 须提供 source（schema + name）' });
        }
        break;
      }
    }
  });
  return errors;
}

/**
 * 载荷形状错误 ⇒ 整批拒绝（changeset_invalid，修 3）。机读载荷与另两条零写入拒绝路径同形（修 4）：
 * rawDetail.errors = 逐条「第 N 项：原因」；rawDetail.notExecuted = 覆盖**全部**动作（reason='batch_rejected'，
 * 被拦项多一句自己的原因）。消息只陈述事实（哪几项、什么形状问题），不给补救指引。
 */
function changesetInvalidPayloadError(errors: ChangesetPayloadError[], actions: ChangesetAction[]): HanaBusinessError {
  const shown = errors.slice(0, 5).map((e) => `第 ${e.index} 项 ${e.message}`);
  const summary = errors.length > shown.length ? `${shown.join('；')}；等共 ${errors.length} 项` : shown.join('；');
  const messageByIndex = new Map(errors.map((e) => [e.index, e.message]));
  return HanaBusinessError.withRawDetail(
    `变更集未执行（整批拒绝、零写入）：${errors.length} 项载荷形状非法——${summary}`,
    'changeset_invalid',
    {
      errors: errors.map((e) => `第 ${e.index} 项：${e.message}`),
      notExecuted: changesetNotExecutedAll(actions, (i) => messageByIndex.get(i)),
    },
  );
}

/**
 * 批内对象级相交 ⇒ 整批拒绝、零写入（SSD §6.2）。机读载荷 rawDetail.conflicts 带冲突对象与两个
 * **原始下标**（a<b，均指调用方传入顺序）；消息只陈述事实与冲突项对，不给补救指引（SSD §1.3）。
 * 修 4：rawDetail 同时带 notExecuted（覆盖全部动作，reason='batch_rejected'；相交的项多一句为什么）。
 */
function changesetConflictError(conflicts: ChangesetConflict[], actions: ChangesetAction[]): HanaBusinessError {
  const shown = conflicts
    .slice(0, 5)
    .map((c) => `${c.object.packageId}/${c.object.objectName}（第 ${c.a} 项 与 第 ${c.b} 项，${c.kind}）`);
  const summary =
    conflicts.length > shown.length ? `${shown.join('；')}；等共 ${conflicts.length} 项` : shown.join('；');
  const involved = new Set<number>();
  for (const c of conflicts) {
    involved.add(c.a);
    involved.add(c.b);
  }
  return HanaBusinessError.withRawDetail(
    `变更集被拒绝（整批拒绝、零写入）：批内 ${conflicts.length} 项对象级相交——${summary}。` +
      '同一对象被两个动作以写-写或写-读方式触碰时，任何执行序都无法两全（SSD §6.2），故本批一件都不做。',
    'changeset_conflict',
    {
      conflicts,
      notExecuted: changesetNotExecutedAll(actions, (i) =>
        involved.has(i) ? '该动作与其他动作在批内对象级相交（本批因此整批拒绝）' : undefined,
      ),
    },
  );
}

/**
 * 预检拦下的一个动作（供拒绝载荷与 notExecuted 组装）。`index` = 调用方原始下标（报告口径统一）。
 */
interface ChangesetRejectedAction {
  index: number;
  packageId: string;
  objectName: string;
  /** 该动作命中的破坏项（既有 BreakingItem 形状）：调用方据此逐条决定 migration 声明 */
  items: BreakingItem[];
}

/**
 * 第 1.5 步：**整体预检的破坏性判定**（SSD §6.1 第 1 步 + §6.6 场景③，P7 修复批）。
 * 在任何写之前把「会被 P6 闸门拒」的动作一次判完；任一被拦 ⇒ 由调用方整批拒绝、零写入。
 * 此前判定只藏在逐项执行内部（跑到该项才失败、再逆序补偿），批内更早的对象已被写过、版本已推进——
 * 与「整批拒绝、零写入」相悖（实机验收场景③的直接证据）。
 *
 * 复用与代价（I3）：update 走 **P6 的 dryRun 通道**（updateCalculationView 的 opt-in 只读预演），
 * delete 走 assessDeletionGate（与 deleteCalculationView 同一判定件）——判定只有这一份实现，
 * 不另写 diff/判定。代价如实说：每个 update 动作多一次「读 + 变换 + diff + 影响半径查询」、
 * 每个 delete 动作多一次影响半径查询；批次本就重（每对象含 2–10s 激活），这点只读开销可接受。
 *
 * 「判不了」不等于「会被拒」：dryRun / 判定自身抛错（对象不存在、基线缺失、解析失败、查询故障）时
 * **不拦截**，只记一条 warn——该动作进执行阶段后仍会跑同一套判定与闸门（两层都在，防回归），
 * 失败语义与 P7 既有行为（停止 + 逆序补偿）保持一字不差；把读故障升级成整批拒绝属于新失败面，不在本批口径内。
 */
async function precheckChangesetGates(
  config: HanaConfig,
  pool: HanaPool,
  plan: ChangesetPlanResult,
  client?: XsRestClient,
): Promise<ChangesetRejectedAction[]> {
  const rejected: ChangesetRejectedAction[] = [];
  for (const step of plan.order) {
    const action = step.action;
    try {
      if (action.action === 'update') {
        const report = await updateCalculationView(
          config,
          pool,
          action.packageId,
          action.objectName,
          changesetUpdatePayload(action),
          {
            dryRun: true,
            // 动作自己的声明原样进预演：声明的破坏性动作照常放行（accept 判定在报告里，
            // 执行期它自己的闸门也会放行——两层都在，防回归）
            ...(action.migration
              ? { migration: action.migration as { strategy: MigrationDeclaration; note?: string } }
              : {}),
          },
          client,
        );
        // 防御：dryRun 恒返回预演回执；拿到写入回执说明调用出错——宁可跳过本项判定（执行期闸门仍在）
        if (!('mode' in report)) continue;
        // 复用 P6 的报告字段（与执行期 assertMigrationDeclared 同一谓词的口径）：
        // breaking 且闸门结论为「不接受」 ⇒ 同样的调用去掉 dryRun 会被拒。
        if (report.breaking.level === 'breaking' && report.migration.accepted === false) {
          rejected.push({
            index: step.originalIndex,
            packageId: action.packageId,
            objectName: action.objectName,
            items: report.breaking.items,
          });
        }
      } else if (action.action === 'delete') {
        // 与 deleteCalculationView 的闸门同口径：同一判定件 + 同一谓词（migrationGateRejected）
        const gate = await assessDeletionGate(pool, action.packageId, action.objectName);
        if (migrationGateRejected(gate.breaking, action.migration)) {
          rejected.push({
            index: step.originalIndex,
            packageId: action.packageId,
            objectName: action.objectName,
            items: gate.breaking.items,
          });
        }
      }
      // create 不进预检：createCalculationView 没有 migration 闸门（新对象没有可断的下游引用），
      // 它的失败（如对象已存在）照旧走执行期「停止 + 逆序补偿」。
    } catch (e) {
      logger.warn(
        { packageId: action.packageId, objectName: action.objectName, err: e },
        '变更集整体预检：本项破坏性判定未完成（不拦截，执行期闸门仍会判定）',
      );
    }
  }
  // 报告口径：按调用方原始下标升序（执行序只影响“什么时候判”）
  return rejected.sort((a, b) => a.index - b.index);
}

/**
 * 整批拒绝（破坏性未声明）的错误与机读载荷（SSD §6.1 第 1 步「任一被拦 ⇒ 整批拒绝、零写入」）。
 * - 消息只陈述事实（哪几项命中什么规则 + 由服务端在写入之前判定施加），**不给补救指引**（SSD §1.3）；
 * - rawDetail.breaking 逐项给 { index（原始下标）, packageId, objectName, items }（既有 BreakingItem）；
 * - rawDetail.notExecuted 与 ChangesetReport.notExecuted 同形同义（对 SSD §6.4 形状的扩展，不变量 2）：
 *   批被拒时**没有报告可返回**，未执行项若不在这里显式枚举，调用方只能靠差集推断。
 */
function changesetMigrationRequiredError(
  actions: ChangesetAction[],
  rejected: ChangesetRejectedAction[],
): HanaBusinessError {
  const shown = rejected
    .slice(0, 5)
    .map((r) => `${r.packageId}/${r.objectName}（第 ${r.index} 项：${summarizeBreakingItems(r.items)}）`);
  const summary = rejected.length > shown.length ? `${shown.join('；')}；等共 ${rejected.length} 项` : shown.join('；');
  const rejectedIndexes = new Set(rejected.map((r) => r.index));
  return HanaBusinessError.withRawDetail(
    `变更集被拒绝（整批拒绝、零写入）：批内 ${rejected.length} 个动作的变更命中破坏性规则且未声明 migration——` +
      `${summary}。该限制由服务端在写入之前判定施加：本批 ${actions.length} 个动作一件都未执行，本次未发生任何写入。`,
    'migration_required',
    {
      breaking: rejected,
      // notExecuted 与另两条零写入拒绝路径同形（修 4，共用 changesetNotExecutedAll）：
      // 被拦的项多一句为什么（未被判为破坏的项不加，不制造恒为空噪音）
      notExecuted: changesetNotExecutedAll(actions, (i) =>
        rejectedIndexes.has(i) ? '该动作被整体预检判定为破坏性且未声明 migration（本批因此整批拒绝）' : undefined,
      ),
    },
  );
}

/**
 * update 动作 → updateCalculationView 的入参（二选一载荷）。**单一构造点**：预检的 dryRun 与执行期
 * 的写入必须喂同一份载荷，两处各写一次三元表达式的那天，预检判的和执行写的就可能不是同一件事。
 */
function changesetUpdatePayload(action: ChangesetAction): { xml?: string; operations?: ViewUpdateOperation[] } {
  return action.xml !== undefined
    ? { xml: action.xml }
    : { operations: (action.operations ?? []) as ViewUpdateOperation[] };
}

/**
 * 第 2 步：执行批内一个动作——**复用既有服务函数**，不重写写路径：
 * create → createCalculationView；update → updateCalculationView；delete → deleteCalculationView。
 * 三者的 P6 migration 闸门原样保留：动作带 migration 就透传；未声明且破坏 ⇒ 该项以 migration_required
 * 失败 ⇒ 进入补偿（期望行为——补偿侧再走低层路径绕开闸门，见 compensateChangesetItem）。
 *
 * 为什么**不在外面包 withKeyedLock**：withKeyedLock 不可重入，三个服务函数各自会取同一把对象锁
 * （create 的临界区 / update 的整段判定与 PUT / delete 的 deleteViaRest），批内先持锁再调用 = 自锁死。
 * 这就是 SSD §6.1「整批持有 keyed lock」在本仓不可实现的根因（完整裁定见本段落头注与
 * CHANGESET_LOCKING_NOTE）。
 */
async function executeChangesetAction(
  config: HanaConfig,
  pool: HanaPool,
  action: ChangesetAction,
  client?: XsRestClient,
): Promise<ChangesetActionOutcome> {
  switch (action.action) {
    case 'update': {
      // 写入前**紧贴本项**预读（不批前一次性预取）：原文 = 补偿材料；ETag = 本项自己的冲突检测基线
      // （SSD §6.1 第 2 步）——**不是**补偿基线：本项 PUT 会推进版本，拿写前基线补偿必得伪 412（§6.3）。
      const { rest, file } = designTimeTarget(config, action.objectName, client);
      const meta = await rest.fileMeta(action.packageId, file);
      const originalXml = await rest.fileContent(action.packageId, file);
      const preEtag = meta.ETag?.trim() || undefined;
      const result = await updateCalculationView(
        config,
        pool,
        action.packageId,
        action.objectName,
        // 载荷构造与整体预检的 dryRun **同一处**（changesetUpdatePayload）：判的就是要写的
        changesetUpdatePayload(action),
        {
          // 显式传写前基线：预读之后、PUT 之前的批外写入以 412 暴露（该项 ⇒ conflict_external），
          // 而不是被 update 路径「锁内重取基线」悄悄吸收成 last-write-wins。
          ...(preEtag ? { ifMatch: preEtag } : {}),
          // 批内每项都要「各自完成（含激活）」：显式带 activate（本 SPS 写入即激活，跨 SPS 同一语义）
          activate: true,
          ...(action.migration
            ? { migration: action.migration as { strategy: MigrationDeclaration; note?: string } }
            : {}),
        },
        client,
      );
      if ('mode' in result) {
        // 防御：本路径不传 dryRun，拿到预演回执说明调用出错——宁可失败也不能当写入结果消费
        throw new HanaBusinessError('内部错误：变更集的更新项不应返回 dryRun 预演回执');
      }
      // 修 2：写成功但激活失败（HTTP 555，文件已写、激活未通过）**不算 ok**——SSD §6.1 第 3 步要求
      // 各项「各自完成（含激活）」。按 failed 抛出 ⇒ 停止 + 逆序补偿 + partial=true，绝不把未激活当成功。
      if (result.activated === false) {
        throw changesetActivationFailureError(
          '更新',
          action.packageId,
          action.objectName,
          result.activationErrors,
          result.activationDetail?.errorCode,
        );
      }
      const postEtag = result.etag?.trim() || undefined;
      return {
        originalXml,
        ...(postEtag ? { postEtag } : {}),
        etagSource: result.etagSource ?? 'unavailable',
        ...(result.activated !== undefined ? { activated: result.activated } : {}),
      };
    }
    case 'create': {
      // create 无原文可缓存（补偿=删除，见 §6.3），故不做预读；入参直接复用 hana_view_create 的形状。
      // source/scripted 用断言收窄：ChangesetAction 把它们声明成宽松形状（measureMode: string /
      // columns: unknown[]），枚举与列形状的最终校验在 createCalculationView 内做（同一处判定，不复制）。
      const result = await createCalculationView(
        config,
        pool,
        {
          packageId: action.packageId,
          objectName: action.objectName,
          ...(action.description !== undefined ? { description: action.description } : {}),
          ...(action.mode !== undefined ? { mode: action.mode } : {}),
          ...(action.source !== undefined ? { source: action.source as CreateCalcViewInput['source'] } : {}),
          ...(action.scripted !== undefined ? { scripted: action.scripted as CreateCalcViewInput['scripted'] } : {}),
          activate: true,
        },
        client,
      );
      // 修 2：与 update 同款——写成功但激活未通过（activated=false）按 failed 处理，
      // 不让「含激活」的承诺在 create 分支失效（新建对象未激活 = 该项没完成）。
      if (result.activated === false) {
        throw changesetActivationFailureError(
          '新建',
          action.packageId,
          action.objectName,
          result.activationErrors,
          result.activationDetail?.errorCode,
        );
      }
      const postEtag = result.etag?.trim() || undefined;
      return {
        ...(postEtag ? { postEtag } : {}),
        etagSource: result.etagSource ?? 'unavailable',
        ...(result.activated !== undefined ? { activated: result.activated } : {}),
      };
    }
    case 'delete': {
      // 写入前紧贴本项预读：对象删除后设计时文件不再存在，原文是补偿（回写）的**唯一**材料。
      // 预读到的 ETag 有两个用途（修 1 blocker）：
      //  ① **显式传给删除通道作 If-Match 基线**（deleteCalculationView 的 opts.ifMatch）——旧实现把它丢弃、
      //     由 deleteViaRest 在锁内重取基线：「预读 → 删除」之间若有第三方写入，锁内重取的**新**基线会让
      //     DELETE 放行（无 412），随后补偿把预读原文写回 ⇒ 第三方的已提交版本被静默销毁、报告还写
      //     compensated（P7 评审 blocker 的探针复现）。显式传入后该窗口内的第三方写入必得 412 ⇒ 该项
      //     conflict_external、对象不删、原文不回写，第三方版本零接触。
      //  ② **不是补偿基线**：删除后不存在可作补偿基线的 ETag，删除项的补偿材料始终是原文（§6.3）。
      // 预读未返回 ETag（服务器没给）时不传 ifMatch，退回锁内自取基线的现状——这会让该项失去
      // 「预读 → 删除」窗口的 412 保护，故日志留痕（批报告没有承载它的字段；与 update 的 updateNote
      // 同一条「退化不静默」原则，只是这条批内退化只能经日志可见）。
      const { rest, file } = designTimeTarget(config, action.objectName, client);
      const meta = await rest.fileMeta(action.packageId, file);
      const preEtag = meta.ETag?.trim() || undefined;
      if (preEtag === undefined) {
        logger.warn(
          { packageId: action.packageId, objectName: action.objectName },
          '变更集 delete 项预读未返回 ETag：本次删除退回锁内自取基线，批外并发写入不再以 412 暴露',
        );
      }
      const originalXml = await rest.fileContent(action.packageId, file);
      await deleteCalculationView(
        config,
        pool,
        action.packageId,
        action.objectName,
        {
          ...(preEtag ? { ifMatch: preEtag } : {}),
          ...(action.migration
            ? { migration: action.migration as { strategy: 'acknowledge_dependents'; note?: string } }
            : {}),
        },
        client,
      );
      // 删除后不存在可作补偿基线的 ETag（补偿是回写原文），故不回 postEtag/etagSource；
      // delete 没有激活概念，也不回 activated（修 2 的说明：不要在 delete 项上加 activated）。
      return { originalXml };
    }
  }
}

/**
 * 修 2：写成功但激活失败的**统一构造点**（update/create 两个分支共用，两处各写一份文案必然漂移）。
 * 返回 ChangesetActivationError ⇒ applyChangeset 按 failed 记录该项，并带出 activated=false +
 * activationErrors 摘要。error.text 给摘要与 activationDetail 线索（完整激活明细含 DDL 不随变更集报告
 * 透出——报告项形状只有一行摘要字段；对单个对象复核该明细仍走单对象通道）。
 * `activationErrors` 收 unknown：update 回执是 string，create 回执声明成 unknown（历史上是透传槽）——
 * 归一（非空 string 才收）只在这一处做，两个分支共用。
 */
function changesetActivationFailureError(
  actionLabel: string,
  packageId: string,
  objectName: string,
  activationErrors: unknown,
  errorCode: string | undefined,
): ChangesetActivationError {
  const summary =
    typeof activationErrors === 'string' && activationErrors.length > 0
      ? activationErrors
      : '激活检查未通过（服务端未附明细）';
  return new ChangesetActivationError(
    `${actionLabel} ${packageId}/${objectName} 已写入设计时文件、但未通过激活（${summary}）：` +
      '该项按 failed 处理（SSD §6.1 第 3 步要求各项「各自完成（含激活）」，未激活不算完成）。' +
      '完整激活明细（含 Type/Procedure DDL）不随变更集报告透出，可对被拒对象调用 hana_view_validate 复核',
    typeof activationErrors === 'string' && activationErrors.length > 0 ? activationErrors : undefined,
    errorCode,
  );
}

/**
 * 第 3 步：逆序补偿一项（SSD §6.3）。**必须绕开 P6 的 migration 闸门**：直接用低层写路径
 * （updateViaRest / writeViaRest / 裸 deleteFile），不经 updateCalculationView / deleteCalculationView 的
 * 「diff → 影响半径 → 破坏性判定」。
 *
 * 理由（写死）：补偿是「回到批前状态」的内部动作，前进方向的破坏性**已由闸门判过**；若补偿再走一遍
 * 闸门，一个声明过的破坏性变更在回退时反而会被拒（migration_required），补偿永久失败——
 * 批将永远停在半完成态。
 *
 * 锁：低层路径 updateViaRest/writeViaRest 自身不取锁 ⇒ 本函数在 withKeyedLock(writeLockKey(...)) 内调用；
 * 需要 fileMeta + deleteFile 的序列（create 补偿）把「校验 → 删除」放在**同一临界区**（中途放锁会留下
 * 「校验通过 → 他人改写 → 删掉他人版本」的窗口）。锁不可重入 ⇒ 这里不调用任何自取锁的路径
 * （deleteViaRest 属于这类，故只用它的两个原语自己组合）。
 */
async function compensateChangesetItem(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  try {
    return await runChangesetCompensation(config, record, client);
  } catch (e) {
    // 补偿自身的异常（412/网络/锁超时等）不向上抛：它必须变成 reporting 层可枚举的 compensation_failed，
    // 否则整个批的其余补偿会被一个异常中断、报告也丢掉现场。
    return {
      status: 'compensation_failed',
      error: changesetErrorOf(e),
      ...changesetConflictEvidence(e),
    };
  }
}

/** 补偿分派（错误交给 compensateChangesetItem 统一收口） */
async function runChangesetCompensation(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  switch (record.action.action) {
    case 'update':
      return compensateUpdateAction(config, record, client);
    case 'create':
      return compensateCreateAction(config, record, client);
    case 'delete':
      return compensateDeleteAction(config, record, client);
  }
}

/** update 补偿的临界区裁决（锁内产出；各分支都不是错误，是如实结论） */
type UpdateCompensationVerdict =
  { kind: 'written' } | { kind: 'precondition_failed'; currentETag?: string; currentVersion?: number };

/**
 * update 的补偿：用缓存的原文写回（SSD §6.3 首行）。
 * **写回之前先探测核对版本**（修 1c，探测与写回同一临界区，check-then-act 闭合）：
 * - 对象已存在且当前 ETag === 本项写成功回执的基线 ⇒ 仍是我们的版本 ⇒ 带 If-Match=该基线写回
 *   （If-Match 继续兜住「探测 → PUT」之间的跨进程写入 ⇒ 412 ⇒ compensation_failed + 结构化现场）；
 * - 对象已存在但当前 ETag 不同（被第三方改过/重建；或当前读数没带 ETag，无法证明是我们的版本）⇒
 *   **不写** + compensation_failed + 当前读数——与旧实现（直接 PUT + If-Match 靠服务端 412 拦下）结论
 *   相同，但连一次被拒的写都不发起，第三方版本零接触；
 * - 对象已不存在（第三方在本项写成功后删了它）⇒ 允许回写（批前状态就是「对象存在」，用 PUT 重建）。
 *   这里**刻意不带 If-Match**：「PUT + If-Match 对已删除对象返回 412 还是**重新创建**」在本仓没有实测
 *   （P5 只测过 DELETE 的三态：204/412/404）——补偿不依赖这条未实测行为（评审 low），先探测再决定；
 *   探测到不存在 ⇒ PUT 必为重建（PUT 是 create-or-update，实测语义），带不带 If-Match 都不改变结果。
 * 已知窗口（如实记录）：进程内锁挡不住跨进程在「探测 → PUT」之间写入；带 If-Match 的分支由服务端 412
 * 兜底，重建分支（对象不存在）本就没有可依的基线——与 §4.1 的既有边界同类。
 * 基线缺失（写回执没带 ETag）时**不做**无 If-Match 的覆盖写：那会静默覆盖第三方的改动（与 create/delete
 * 补偿同一条「不静默覆盖」原则），如实报 compensation_failed。
 */
async function compensateUpdateAction(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  const { packageId, objectName } = record.action;
  const originalXml = record.originalXml;
  const postEtag = record.postEtag;
  if (originalXml === undefined) {
    return {
      status: 'compensation_failed',
      error: { text: '补偿材料缺失（写入前未读到原文），未执行写回' },
    };
  }
  if (postEtag === undefined) {
    return {
      status: 'compensation_failed',
      error: {
        text:
          '本项写成功回执未带 ETag（补偿基线不可用）：无法确认对象未被第三方改动，' +
          '按「不静默覆盖」原则未执行写回（无 If-Match 的写回会覆盖他人改动且无从察觉）',
      },
    };
  }
  const verdict = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<UpdateCompensationVerdict> => {
      const { rest, file } = designTimeTarget(config, objectName, client);
      let meta: FileMeta | undefined;
      try {
        meta = await rest.fileMeta(packageId, file);
      } catch (e) {
        // 仅 404（OBJECT_NOT_FOUND）视为「不存在」；其它错误必须抛出（fail-closed）——
        // 把读异常当成「不存在」会让重建分支在故障中误判（与 create/delete 补偿的探测同口径）
        if (!(e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND')) throw e;
        meta = undefined;
      }
      if (meta === undefined) {
        // 重建分支：不带 If-Match 的 PUT（理由见函数头注——不依赖「PUT + If-Match 对已删除对象」的未实测行为）
        await updateViaRest(config, packageId, objectName, originalXml, { activate: true }, client);
        return { kind: 'written' };
      }
      const currentETag = meta.ETag?.trim() || undefined;
      const currentVersion = meta.SapBackPack?.Version;
      if (currentETag !== postEtag) {
        // 已存在但非本项写成功后的版本（第三方改过/重建；或当前读数无 ETag，无法证明归属）：不写，
        // 把当前读数带出去（结构化现场，不许只落 error.text）——「查不到」与「不是我们的版本」在此同判
        return {
          kind: 'precondition_failed',
          ...(currentETag !== undefined ? { currentETag } : {}),
          ...(currentVersion !== undefined ? { currentVersion } : {}),
        };
      }
      await updateViaRest(config, packageId, objectName, originalXml, { ifMatch: postEtag, activate: true }, client);
      return { kind: 'written' };
    },
  );
  if (verdict.kind === 'precondition_failed') {
    return {
      status: 'compensation_failed',
      error: {
        text:
          `补偿未执行：对象 ${packageId}/${objectName} 的当前版本与本次更新成功后的基线不一致` +
          '（期间被第三方改过，或当前读数无法证明版本归属），按「不覆盖第三方改动」原则未执行写回',
      },
      ...(verdict.currentETag !== undefined ? { currentETag: verdict.currentETag } : {}),
      ...(verdict.currentVersion !== undefined ? { currentVersion: verdict.currentVersion } : {}),
    };
  }
  invalidateViewCache(packageId, objectName);
  return { status: 'compensated' };
}

/** create 补偿的临界区裁决（锁内产出；'absent' 与 'precondition_failed' 都不是错误，是如实结论） */
type CreateCompensationVerdict =
  | { kind: 'deleted' }
  | { kind: 'absent' }
  | { kind: 'precondition_failed'; currentETag?: string; currentVersion?: number };

/**
 * create 的补偿：删除新建对象——前置 = **post-create ETag 仍为当前值**（SSD §6.3 第二行）。
 * 为什么必须有前置：无前置的删除可能删掉他人同名新建对象（PUT 是 create-or-update，服务端没有 409）。
 * 「校验 → 删除」同一临界区完成（拆两段会留下「校验通过 → 他人改写 → 删掉他人版本」的窗口）。
 * 对象已不存在（**仅 404** 视为不存在）：批前状态（该对象不存在）已成立 ⇒ compensated；
 * 其它错误（403/网络）如实抛出报失败——「查不到」与「确实没有」必须可区分（与 import 守卫同口径）。
 */
async function compensateCreateAction(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  const { packageId, objectName } = record.action;
  const postEtag = record.postEtag;
  if (postEtag === undefined) {
    return {
      status: 'compensation_failed',
      error: {
        text: '本项创建回执未带 ETag（前置不可校验）：无法证明对象仍是本次创建的那个，按「不删他人对象」原则未执行删除',
      },
    };
  }
  const verdict = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<CreateCompensationVerdict> => {
      const { rest, file } = designTimeTarget(config, objectName, client);
      let meta: FileMeta;
      try {
        meta = await rest.fileMeta(packageId, file);
      } catch (e) {
        if (e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND') return { kind: 'absent' };
        throw e;
      }
      const currentETag = meta.ETag?.trim() || undefined;
      const currentVersion = meta.SapBackPack?.Version;
      if (currentETag !== postEtag) {
        // 他人改过（或读不到基线）：**不删**，把当前读数带出去（结构化现场，不许只落在 error.text）
        return {
          kind: 'precondition_failed',
          ...(currentETag !== undefined ? { currentETag } : {}),
          ...(currentVersion !== undefined ? { currentVersion } : {}),
        };
      }
      await rest.deleteFile(packageId, file, { ifMatch: postEtag });
      return { kind: 'deleted' };
    },
  );
  if (verdict.kind === 'precondition_failed') {
    return {
      status: 'compensation_failed',
      error: {
        text:
          `补偿未执行：对象 ${packageId}/${objectName} 的当前 ETag 与本次创建成功后的基线不一致` +
          '（期间被他人改过），按前置语义不删除——无前置的删除可能删掉他人同名新建对象',
      },
      ...(verdict.currentETag !== undefined ? { currentETag: verdict.currentETag } : {}),
      ...(verdict.currentVersion !== undefined ? { currentVersion: verdict.currentVersion } : {}),
    };
  }
  // deleted 与 absent 都表示批前状态已成立（该对象不存在）：两者都失效一次缓存——
  // 「刚写过」的读数不该继续留在进程内缓存里（absent = 第三方删掉了它，缓存同样已过期）
  invalidateViewCache(packageId, objectName);
  return { status: 'compensated' };
}

/** delete 补偿的临界区裁决 */
type DeleteCompensationVerdict =
  { kind: 'restored' } | { kind: 'exists'; currentETag?: string; currentVersion?: number };

/**
 * delete 的补偿：回写原文（SSD §6.3 末行）。
 * **先探测**：已存在（第三方重建同名对象）⇒ **不写** + compensation_failed——静默覆盖「第三方的重建」
 * 是不可接受的失败模式。探测**仅 404 视为不存在**，其它错误如实报（「查不到」与「确实没有」必须可区分）。
 * 探测到不存在才回写，且**刻意不带 If-Match**（修 1c 的口径，与 update 补偿的重建分支同一理由）：
 * 对象已删除后没有可依的基线，而「PUT + If-Match 对已删除对象返回 412 还是**重新创建**」在本仓没有实测
 * （P5 只测过 DELETE 的三态：204/412/404）——补偿不依赖这条未实测行为，先探测再决定：不存在 ⇒ 裸 PUT
 * 重建（PUT 为 create-or-update，实测语义），确定且不再要求调用方去猜服务端行为。
 * 已知窗口（如实记录）：进程内锁挡不住跨进程在「探测 → PUT」之间重建；裸 PUT 无 If-Match 可依（没有
 * 可用的基线），跨进程真相在服务端——与 §4.1 的既有边界同类。
 */
async function compensateDeleteAction(
  config: HanaConfig,
  record: ChangesetRecord,
  client?: XsRestClient,
): Promise<ChangesetCompensationOutcome> {
  const { packageId, objectName } = record.action;
  const originalXml = record.originalXml;
  if (originalXml === undefined) {
    return {
      status: 'compensation_failed',
      error: { text: '补偿材料缺失（写入前未读到原文），未执行回写' },
    };
  }
  const verdict = await withKeyedLock(
    writeLockKey(packageId, normalizeObjectName(objectName)),
    async (): Promise<DeleteCompensationVerdict> => {
      const { rest, file } = designTimeTarget(config, objectName, client);
      let meta: FileMeta | undefined;
      try {
        meta = await rest.fileMeta(packageId, file);
      } catch (e) {
        // 仅 404（OBJECT_NOT_FOUND）视为「不存在」；其它错误必须抛出（fail-closed）——
        // 把读异常当成「不存在」会静默覆盖第三方刚重建的同名对象
        if (!(e instanceof HanaBusinessError && e.code === 'OBJECT_NOT_FOUND')) throw e;
        meta = undefined;
      }
      if (meta) {
        const currentETag = meta.ETag?.trim() || undefined;
        const currentVersion = meta.SapBackPack?.Version;
        return {
          kind: 'exists',
          ...(currentETag !== undefined ? { currentETag } : {}),
          ...(currentVersion !== undefined ? { currentVersion } : {}),
        };
      }
      // 低层 PUT 回写原文（writeViaRest，不经 createCalculationView 的存在性守卫与闸门）：
      // 对象此刻不存在，PUT 即「重建到批前状态」
      await writeViaRest(config, packageId, objectName, originalXml, { activate: true }, client);
      return { kind: 'restored' };
    },
  );
  if (verdict.kind === 'exists') {
    return {
      status: 'compensation_failed',
      error: {
        text:
          `补偿未执行：对象 ${packageId}/${objectName} 在本批删除之后已被（第三方）重建，` +
          '按 §6.3 不写回原文——静默覆盖他人的重建不可接受',
      },
      ...(verdict.currentETag !== undefined ? { currentETag: verdict.currentETag } : {}),
      ...(verdict.currentVersion !== undefined ? { currentVersion: verdict.currentVersion } : {}),
    };
  }
  invalidateViewCache(packageId, objectName);
  return { status: 'compensated' };
}

/** 失败项的状态判定（SSD §6.4）：错误码 412（写冲突）⇒ conflict_external；其它 ⇒ failed */
function changesetFailureStatus(e: unknown): 'failed' | 'conflict_external' {
  return e instanceof HanaBusinessError && e.code === '412' ? 'conflict_external' : 'failed';
}

/** 错误 → 报告里的 error 形状（文本经 redactSensitive：本字段随**成功信封**的 data 出去，脱敏口径与失败信封一致） */
function changesetErrorOf(e: unknown): { code?: string; text: string } {
  const code = e instanceof HanaBusinessError ? e.code : undefined;
  const text = e instanceof Error ? e.message : String(e);
  return { ...(code !== undefined ? { code } : {}), text: redactSensitive(text) };
}

/**
 * 412/404 冲突载荷（core 层 412 后补读所得）→ 报告的结构化现场。
 * 拿不到就整体缺省（不产生 undefined 噪音）；**绝不**把「没补读到」伪造成某个值——
 * 「查不到」与「没去查」在本仓必须可区分（既有口径）。
 */
function changesetConflictEvidence(e: unknown): { currentETag?: string; currentVersion?: number } {
  const conflict = e instanceof HanaBusinessError ? e.conflict : undefined;
  return {
    ...(conflict?.currentETag !== undefined ? { currentETag: conflict.currentETag } : {}),
    ...(conflict?.currentVersion !== undefined ? { currentVersion: conflict.currentVersion } : {}),
  };
}
