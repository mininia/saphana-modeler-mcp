import type { HanaPool } from '../core/hana-client.js';
import { toHanaDateTime } from '../core/datetime.js';
import { BLOCKED_PREFIX, HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { logger } from '../core/logger.js';
import { currentAgentLabel, currentClientId } from '../core/request-context.js';
import { PACKAGE_ID_RE } from '../core/sql.js';
import { isPackageAllowed } from '../config/write-boundary.js';
import {
  type EtagSource,
  type FileMeta,
  type WriteCheckResult,
  XsRestClient,
  extractCheckResult,
  isDotOnlySegment,
} from '../core/xs-rest.js';
import type { HanaConfig } from '../config/config.js';
import { viewDefinitionCache } from '../model/view-cache.js';
import { VIEW_SUFFIXES } from './metadata.service.js';

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

/**
 * 包名安全字符集校验（写操作前纵深防御；值仍参数绑定）。
 * 与工具入参共用同一判定 PACKAGE_ID_RE（core/sql.ts，含对纯点串 '.'/'..' 的拒绝）——
 * 手抄第二份正则的那天两处必然漂移（纯点串一旦放行，URL 归一会把请求折叠到上级路径，
 * 与 core/xs-rest 的 encodePath 同口径）。
 * 末尾的 isDotOnlySegment 与 PACKAGE_ID_RE 的 `(?!\.+$)` 同义，属纵深防御：两处判定在两个文件里，
 * 任一被回退时这一道仍拦住纯点串（纯点段另在 encodePath 的 URL 出口有第三道拦截）。
 */
function isSafePackageName(packageId: string): boolean {
  return PACKAGE_ID_RE.test(packageId) && !isDotOnlySegment(packageId);
}

/**
 * 校验写入包名是否在配置的可写包范围内，并记录写操作审计日志。
 * - 白名单为空 → 本服务层不限制（fail-open，配置未填时的默认）；端到端空白名单 = 声明写包的调用
 *   被闸门拒绝（两层口径见 config/write-boundary.ts 文件头）
 * - 白名单非空 → 包名须等于某配置包，或以其为前缀（包名 = 配置包 或 包名以「配置包.」开头）
 *   例：配置 ["ZDEMO","ZDEMO.ZDEMO_SD"] → ZDEMO / ZDEMO.X / ZDEMO.ZDEMO_SD / ZDEMO.ZDEMO_SD.SUB 放行，
 *       OTHER / OTHER.X 拒绝（既不等于配置项，也不以其加「.」开头）。
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
      `${BLOCKED_PREFIX}：目标包 "${packageId}" 不在服务端配置的可写包范围内` +
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
export function writeLockKey(packageId: string, objectName: string): string {
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
 * REPOSITORY_REST 的调用封装（repoV2 信封）——本文件内部通道（写路径与 activate 的 repo_rest 兜底），
 * 故不导出：对外只有高层的 create/update/activate/delete 语义，避免调用方绕过包/对象校验直连裸 REST。
 * @param request JSON 请求对象
 * @param files 文件槽内容（写对象时传 [名称槽, 内容槽]）
 */
export async function repositoryRest(
  pool: HanaPool,
  request: Record<string, unknown>,
  files: Buffer[] = [],
): Promise<RepoRestResponse> {
  const j = Buffer.from(JSON.stringify(request), 'utf8');
  // 附件区：files 的每个元素序列化为**一条** [4B 长度][内容] 记录；头部 count 必须等于实际记录数——
  // 写成 `1 + 文件数 × 2` 会多报（写对象时实际只有 2 条记录），头/体不一致时实测在传输层报
  // Transporter.consume，还会掩盖真实原因「缺仓库会话 40106」。count 从同一个数组推导，杜绝再次漂移。
  const attachmentRecords = files.flatMap((f) => [u32le(f.length), f]);
  const attachmentCount = files.length;
  const idata = Buffer.concat([
    Buffer.from('repoV2', 'ascii'),
    u32le(attachmentCount),
    u32le(j.length),
    j,
    ...attachmentRecords,
  ]);
  // CALL SYS.REPOSITORY_REST(?, ?)：第三个实参 1 = OUT 参数个数；只绑定 IN（第 1 个 ?），
  // OUT 经 getParameterValue(1) 读回（driver 约定）。
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
export function assertNoRepoRestError(resp: RepoRestResponse, action: string): void {
  const code = resp.content['error-code'];
  if (typeof code === 'string' && code !== '0') {
    const msg = String(resp.content['error-msg'] ?? 'unknown');
    const arg = String(resp.content['error-arg'] ?? '');
    throw new HanaBusinessError(`仓库 ${action} 失败：${msg}（code=${code}${arg ? `, arg=${arg}` : ''}）`, code);
  }
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
}

/** 由写响应体的 CheckResult 提取「激活未通过」的完整明细（激活通过则 undefined） */
export function activationDetailOf(meta: FileMeta & { CheckResult?: WriteCheckResult }): ActivationDetail | undefined {
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
export function stripInternalMeta(meta: FileMeta & { CheckResult?: WriteCheckResult }): FileMeta {
  const { _httpStatus, ...rest } = meta as FileMeta & { _httpStatus?: number };
  void _httpStatus;
  return rest as FileMeta;
}

/** 激活失败的一行摘要（首行 + 错误码）：完整文本在 activationDetail.message，避免同一长文本回显两遍 */
export function activationSummary(detail: ActivationDetail, fallback = '激活检查未通过'): string {
  const firstLine = (detail.message ?? '').split('\n')[0].trim();
  return [detail.errorCode, firstLine].filter(Boolean).join(' ') || fallback;
}

/**
 * 写路径成功后的视图缓存失效（SSD §4.5，五条写路径统一经此助手，不各写一遍）。
 * 对象名一律传**裸名**（与 viewDefinitionCache.get 的 key 构造 `${pkg}/${obj}/…` 一致；
 * 带后缀不会命中前缀，只会静默退化成「等 60s 自愈」）。
 * 定位：失效只是把「最多 60s 后自愈」变成「立即」，**不是正确性依赖**——
 * 缓存条目自带 VERSION_ID 轻校验 + TTL，跨进程的真相始终在 _SYS_REPO。
 */
export function invalidateViewCache(packageId: string, objectName: string): void {
  viewDefinitionCache.invalidate(packageId, objectName);
}

/* 写回执基线（ETag）来源的类型 EtagSource 单点定义在 core/xs-rest.ts（三值）：
 * 'response-header'=写响应的响应头同刻读数（真正的新基线）；'read-back'=独立回读（删除前的基线 / 导入后的回读，
 * 不与写响应同源）；'unavailable'=这次读取没拿到 ETag——回执如实缺省，**不许补读拼装**冒充新基线。 */

/**
 * 写响应同刻读数 → 回执基线三件套（etag / etagSource / version）。
 * create/update/activate 三条成功回执共用（各抄一遍的三元组必然漂移）；不补读、不拼装——
 * 响应头没带 ETag 就由 etagSource='unavailable' 如实标注（见 EtagSource 的语义）。
 */
export function writeReceiptBaseline(meta: FileMeta): { etag?: string; etagSource: EtagSource; version?: number } {
  return {
    etag: meta.ETag,
    etagSource: meta.etagSource ?? 'unavailable',
    version: meta.SapBackPack?.Version,
  };
}

/**
 * 版本号 > 1 的「并发迹象」是可证伪的推断（create 与 import 两处回执共用同一句免责说明）：
 * 服务端若对同名重建沿用旧的版本计数，delete → 重建同样会看到 >1——这并不代表有人写过。
 */
export const VERSION_CONCURRENCY_CAVEAT =
  '但若该对象此前被删除重建过、服务端沿用了旧的版本计数，版本号也可能不回退、并不代表有人写过';

/**
 * 「读取未返回 ETag ⇒ 本次写入未带 If-Match」的统一说明（update/delete/activate 三条回执共用同一骨架——
 * 三处各写一份必然漂移）。语义固定：退化事实如实说明（本次动作失去 412 保护，读取之后的第三方修改
 * 不会暴露），hint 给出该动作可行的补救指引（无可行补救时省略）。
 */
export function noIfMatchNote(readLabel: string, actionLabel: string, hint?: string): string {
  const base =
    `${readLabel}：本次${actionLabel}未带 If-Match，读取之后发生的第三方修改不会以 412 暴露` +
    `（${actionLabel}结果仍以服务端实际执行结果为准）`;
  return hint ? `${base}；${hint}` : base;
}

/** REPOSITORY_REST 通道：写对象（object 嵌套 + XML 在附件槽） */
export async function writeViaRepoRest(
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
export async function writeViaInactiveObject(
  pool: HanaPool,
  packageId: string,
  objectName: string,
  xml: string,
  timezone: string,
): Promise<void> {
  // 写库时间与日志同口径（取配置时区的本地时间，不用 UTC——两者相差一个时区会让比对失真）
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
export function designTimeFile(objectName: string): string {
  return `${objectName}${CALC_VIEW_FILE_SUFFIX}`;
}

/**
 * XS 设计时文件通道的唯一入口：解析会话（调用方未显式传入则新建）+ 目标文件路径。
 * 写/激活/更新/删除四路共用这两步（建客户端 + `${objectName}.calculationview`）；
 * 集中后凭据只在此处进入客户端，目标文件名的拼法也只有这一种。
 */
export function designTimeTarget(
  config: HanaConfig,
  objectName: string,
  client?: XsRestClient,
): { rest: XsRestClient; file: string } {
  return { rest: client ?? new XsRestClient(config), file: designTimeFile(objectName) };
}

/**
 * XS REST 通道：激活设计时对象（PUT + SapBackPack {"Activate":true}，失败 555 + 编译明细）。
 * 锁内三步：① fileMeta 取 ETag 基线 ② fileContent 读当前内容 ③ writeFile(activate, If-Match=基线)。
 * 三步必须同临界区（锁由调用方 activateCalculationView 持有）：fileMeta 若在锁外，并发 update 会让
 * 激活拿旧基线写新内容 → 必然伪 412。
 * 锁不可重入：本函数自身不取锁，也不得被持锁状态下的其它路径直呼。
 */
export async function activateViaRest(
  config: HanaConfig,
  packageId: string,
  objectName: string,
  client?: XsRestClient,
): Promise<{ meta: FileMeta & { CheckResult?: WriteCheckResult }; ifMatch?: string }> {
  const { rest, file } = designTimeTarget(config, objectName, client);
  const baseMeta = await rest.fileMeta(packageId, file);
  const content = await rest.fileContent(packageId, file);
  // 基线归一（与 update/delete 同款）：空串/纯空白 ETag 不当「有基线」——纯空白发出去必得伪 412；
  // 且回执按 ifMatch 真值判定，空白值还会吞掉「未带 If-Match」的如实说明（activateNote）。
  // 读取未返回基线时不带 If-Match（理论上不该发生），由调用方把这件事写进回执/日志（不静默）。
  const baseline = baseMeta.ETag?.trim() || undefined;
  const meta = await rest.writeFile(packageId, file, content, {
    activate: true,
    ...(baseline ? { ifMatch: baseline } : {}),
  });
  return { meta, ifMatch: baseline };
}

/**
 * XS REST 通道：写/更新设计时对象（PUT 为 create-or-update，可选 If-Match 乐观锁）——create 通道与
 * 变更集补偿的写回都走这里；activate 通道**不经本函数**：activateViaRest 读基线后自组
 * Activate + If-Match 选项直呼 writeFile——rest.writeFile 在本文件有两个调用点（此处与
 * activateViaRest），选项各自组装，改动其一须同步核对另一。
 * 无 ifMatch 时**明确不带 If-Match** 写（不补读基线）：退化事实由调用方的回执说明，不静默。
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
  // 这里**刻意不补读** fileMeta 取当前 ETag 当基线：补读若发生在第三方写入之后，会把冲突基线悄悄刷新
  // （PUT 不再 412），与 §4.2「禁止补读拼装」同型。没有基线就不带 If-Match，退化事实进回执。
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
 * `ifMatch`（可选）：调用方**预读**的删除基线——变更集的 delete 项把「写入前紧贴本项读到的 ETag」
 * 显式传入，使「预读 → 删除」之间的第三方写入必得 412（该项 ⇒ conflict_external）；
 * 不传 = 锁内自取删除前基线（单对象通道语义零改动）。
 */
export async function deleteViaRest(
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
    // 基线归一：空串/纯空白 ETag 不当「有基线」——「是否带 If-Match」的真值判断与 ifMatchMissing
    // 的 === undefined 判断必须同口径，否则会静默退化成「无基线删除且不产生 deleteNote」。
    // 显式基线优先：以调用方**预读**的 ETag 为准，不用锁内这次重取的读数——重取会把
    // 「预读 → 删除」窗口内的第三方写入悄悄刷新成新基线（DELETE 无 412），补偿随后把预读原文写回，
    // 第三方的已提交版本被静默丢弃；锁内这次 fileMeta 读只保留存在性判定作用。
    const explicit = ifMatch?.trim() || undefined;
    const baseline = explicit ?? (baseMeta.ETag?.trim() || undefined);
    await rest.deleteFile(packageId, file, baseline ? { ifMatch: baseline } : {});
    return { etag: baseline, version: baseMeta.SapBackPack?.Version, ifMatchMissing: baseline === undefined };
  });
}
