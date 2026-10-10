/**
 * XS Classic 设计时 REST 客户端（Orion 1.0 / SAP HANA REST API）。
 *
 * 职责：打通 SAP HANA REST API 的会话与写通道（官方「写路径」直连 HTTP）。
 * 背景（SAP 官方文档 §8.2 + 实测）：
 * - 40106 "session version" 根因 = 缺 repository workspace / version / ChangeId 上下文；
 * - 裸 repoV2 JSON 调 SYS.REPOSITORY_REST 永远拿不到该上下文；
 * - 官方解法 = 经 XS Engine（80<instance>）/sap/hana/xs/dt/base/* 的 REST API：
 *   form login → cookie → X-CSRF-Token → workspace / file / xfer 等端点。
 *
 * 实测契约（SPS08）：
 * 1. GET /sap/hana/xs/formLogin/token.xsjs + Header "X-CSRF-Token: Fetch" → 返回 X-CSRF-Token（此时为 "unsafe"）
 * 2. POST /sap/hana/xs/formLogin/login.xscfunc + form(xs-username, xs-password) + 上述 token → Session Cookie(xsId…)
 * 3. GET /sap/hana/xs/dt/base/info + Header "X-CSRF-Token: Fetch" → 返回**真正的** X-CSRF-Token（写动词必需）
 * 4. 写（POST/PUT/DELETE）带 Orion-Version: 1.0 + X-CSRF-Token；写内容用头 SapBackPack: {…}
 * 5. 文件写入一律 PUT（POST 到文件路径 → 400 "Bad Request Header or Body"）；PUT 是 create-or-update，
 *    也不触发 40106（PUT 本身不需要 workspace 上下文；本 SPS 也不存在「写 inactive」结果，见下条 6）
 * 6. 【关键实测】本 SPS 对**合法模型一律写入即激活**：裸 PUT / {"Activate":true} / {"Workspace":…} /
 *    {"Check":true} 全都激活（Activated=true、Version 递增）；区别仅在响应——
 *    {"Check":true} 与裸 PUT 把激活检查结果放响应体 CheckResult（失败 202 Warning），
 *    {"Activate":true} 失败为 HTTP 555 + error_msg。写 inactive 经本 API 不可达（激活失败的对象才是 inactive）
 * 7. 乐观锁：过期 If-Match → 412（引号可选）
 * 8. Transfer API：导出 GET /xfer/export/<pkg>.zip（201 + zip）；导入 POST /xfer/import/<pkg>/（目录目标+
 *    Slug 文件名，200 + Location）→ PUT 分片（Content-Range，201）→ 落库【实测：落库即激活，
 *    Activated=true / Version=1，**不存在 inactive 暂存**，见计划 §6 P0 ④】
 *    （目标含文件名会写进 <pkg>/<file>/<file> 错误路径，禁用）
 * 9. 【P5 实测】写成功响应的**响应头**带新 ETag（与随后 fileMeta 读值逐字一致、随每次写前进）——
 *    回执基线直接取响应头，禁补读拼装；412 响应**不带** ETag 头，冲突载荷只能在 412 后补读一次；
 *    DELETE 执行 If-Match：正确基线 → 204、陈旧基线 → 412、对象已不存在 → 404（重复删为 404 而非 412）
 *
 * 并发与超时（P5 §4.3/§4.6）：request() 出口统一超时（opts.timeoutMs 覆盖：写动词 30s、xfer 300s、
 * login/refreshCsrf 10s）；**所有会触发服务端激活的写**（writeFile 的 PUT 与 checkFile 的临时副本检查写，
 * 见上条 6：本 SPS 任何合法 PUT 都会激活）全程在激活信号量内——只按 activate=true 限流拦不住并发激活；
 * importFile 走 xfer 上传通道，是有意不纳入信号量的已知边界（xfer 超时放宽到 300s，长期占许可会饿死其它写，
 * 见其 JSDoc）。全局锁序 keyed lock → 信号量 → 网络/DB。
 *
 * 安全：凭据一律来自 config（不落日志）；请求体/头不做 debug 级日志。
 */
import type { HanaConfig } from '../config/config.js';
import { HanaBusinessError, type ConflictInfo } from './errors.js';
import {
  ACTIVATION_CONCURRENCY_DEFAULT,
  ACTIVATION_SEMAPHORE,
  XS_LOGIN_TIMEOUT_MS,
  XS_TIMEOUT_MS_DEFAULT,
  XS_XFER_TIMEOUT_MS_DEFAULT,
} from './limits.js';
import { logger } from './logger.js';
import { withSemaphore } from './semaphore.js';

/**
 * XS Classic 设计时 REST 基础路径的默认值（官方默认安装路径）。
 *
 * 定义在这里而非 config，是因为构造 XsRestClient 时要对**任何** HanaConfig 都成立 ——
 * 包括单元测试里刻意构造的极简桩（只有 host/instance/user/password）。缺了兜底，
 * 一个传了不完整配置的调用方会在构造器里拿到 `undefined.replace` 的 TypeError，
 * 而那个报错完全指不出"少了哪个字段"。
 * config.ts 的 HANA_XS_BASE_PATH 默认值引用本常量，故默认值全仓只有这一份定义。
 */
export const XS_BASE_PATH = '/sap/hana/xs/dt/base';

/** SapBackPack 头 JSON 的字段（集中在常量表，便于按 SPS 调字段名/大小写） */
export interface SapBackPack {
  /** 是否写后立即激活（activate 链路） */
  Activate?: boolean;
  /**
   * 仓库 workspace 名。官方语义是「写 inactive 版本用」，但实测本 SPS 写入即激活、无 inactive 暂存：
   * 带 Workspace 的写照样自动激活，字段保留仅为跨 SPS 兼容。
   */
  Workspace?: string;
  /** 乐观锁基线版本号（来自 GET ?parts=meta 的 SapBackPack.Version / ETag） */
  Version?: number;
  /** 变更列表 ID（可选，本实现暂不使用） */
  ChangeId?: string;
}

/**
 * 回执基线（ETag）的来源（P5 §4.2#1 的诚实性字段；服务层 repository.service 的回执同用此类型）：
 * - 'response-header'：取自**本次写响应的响应头** ETag——与写动作同响应、同刻读取，是真正的新基线；
 * - 'read-back'：基线来自一次**独立**读（删除前记录的基线 / 导入完成后的回读）——只代表读那一刻的状态，
 *   不与写响应同源（读与写之间可能有第三方写入），下游不得把它当作「本次写的新基线」；
 * - 'unavailable'：这次没有拿到 ETag——回执如实缺省，**不许**补读拼装冒充新基线。
 */
export type EtagSource = 'response-header' | 'read-back' | 'unavailable';

/** GET ?parts=meta 返回的文件元数据 JSON 中的关键字段 */
export interface FileMeta {
  Name: string;
  Location: string;
  Directory: boolean;
  LocalTimeStamp?: number;
  ContentType?: string;
  Attributes?: { SapBackPack?: { Activated?: boolean; IsDeletion?: boolean } };
  /** 乐观锁 ETag（字符串，实测为毫秒时间戳） */
  ETag?: string;
  /**
   * 回执基线的来源（仅写回执填充，P5 §4.2#1，三值语义见 EtagSource）。不许把补读 fileMeta 冒充成
   * 写响应头——PUT 与补读之间的第三方写入会被谎报为"本次写的新基线"，下游补偿会以第三方版本为基线静默覆盖。
   */
  etagSource?: EtagSource;
  SapBackPack?: {
    Version?: number;
    Type?: number;
    ActivatedAt?: number;
    ActivatedBy?: string;
    ObjectStatus?: string;
    IsDeletion?: boolean;
  };
  [key: string]: unknown;
}

/** 简化的 HTTP 响应体（文本；raw 请求时附二进制） */
export interface XsResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  /** 原始字节（仅 raw 请求，如 xfer export 的 zip；文本解码会破坏二进制） */
  buffer?: Buffer;
}

/** checkFile 结果（PUT + SapBackPack {"Check":true} 的响应体关键字段，实测 202/200 均可能） */
export interface CheckFileResult {
  /** true=激活检查通过（CheckResult.Operations.Activate === true） */
  consistent: boolean;
  /** 不一致时的错误明细（error_msg / Message） */
  message?: string;
  /** 服务端错误码（如 40117） */
  errorCode?: string;
  /**
   * 回执基线（ETag）：**只认本次 Check 响应的响应头**，与 writeFile 的 stampWriteEtag 同款口径——
   * 响应头缺失即缺省，**禁止**补读 fileMeta 冒充同刻读数（补读值与本次写不同源，拿它当基线会证错对象）。
   * 调用方据此做「实例级验身份」的基线：之后读到的 ETag 与它逐字一致，才说明对象还是同一次写入的实例。
   */
  etag?: string;
  /** 原始响应体（审计用） */
  raw: string;
}

/** 写响应体内的自动激活检查结果（实测：每次 PUT 服务端都会跑激活检查并回填） */
export interface WriteCheckResult {
  Operations?: { Write?: boolean; Activate?: boolean };
  error_code?: number | string;
  error_msg?: string;
  errorCode?: number | string;
  errorMsg?: string;
  /** 其余字段（如各 SPS 版本附带的 DDL/明细字段）原样保留：错误详情不猜字段名，整块透传 */
  [key: string]: unknown;
}

/** 从写响应体提取激活检查结果（无则 undefined）；raw 保留原始 CheckResult 供调用方原样透出 */
export function extractCheckResult(
  body: unknown,
): { consistent: boolean; message?: string; errorCode?: string; raw: WriteCheckResult } | undefined {
  const cr = (body as { CheckResult?: WriteCheckResult | string } | null | undefined)?.CheckResult;
  if (cr === undefined || cr === null) return undefined;
  // CheckResult 也可能是裸文本（非对象）：仍按「激活检查未通过」回报，不静默丢信号
  if (typeof cr !== 'object') {
    return { consistent: false, message: String(cr), raw: { error_msg: String(cr) } };
  }
  const activated = cr.Operations?.Activate === true;
  const code = cr.error_code ?? cr.errorCode;
  const msg = cr.error_msg ?? cr.errorMsg;
  return {
    consistent: activated,
    message: activated ? undefined : msg ? String(msg) : '激活检查未通过',
    errorCode: code !== undefined ? String(code) : undefined,
    raw: cr,
  };
}

/**
 * 错误明细长度上限（字符）。
 * 激活失败的明细里含 Type/Procedure DDL 全文（实测数 KB），截断会让调用方必须再调一次校验才能拿全——
 * 故上限设得足够宽；仅在极端响应体下兜底，且截断处显式标注，不静默丢内容。
 */
export const MAX_ERROR_DETAIL_CHARS = 8000;

/** 截断兜底（超限时显式标注，不静默丢内容） */
function capDetail(text: string): string {
  return text.length > MAX_ERROR_DETAIL_CHARS
    ? `${text.slice(0, MAX_ERROR_DETAIL_CHARS)}\n…（错误明细超过 ${MAX_ERROR_DETAIL_CHARS} 字符已截断；请求体不做日志，如需剩余部分请重跑该对象的设计时校验）`
    : text;
}

/**
 * 从 XS 错误响应体提取**完整**错误明细。
 * 字段名跨 SPS 版本不统一（error_msg / message / Message / error / CheckResult.error_msg 等），
 * 故按优先级逐个尝试；都取不到才退回响应体原文。截断上限见 MAX_ERROR_DETAIL_CHARS——
 * 上限设小了（如 300 字符）调用方就必须再调一次 validate 才能拿全 Type/Procedure DDL。
 */
export function extractErrorDetail(body: string): string {
  const j = safeJson<Record<string, unknown>>(body);
  if (!j) return capDetail(body.replace(/\s+/g, ' ').trim());
  const cr = (j['CheckResult'] ?? {}) as Record<string, unknown>;
  const candidates = [
    j['error_msg'],
    j['errorMessage'],
    j['error_msg_detail'],
    j['message'],
    j['Message'],
    j['error'],
    cr['error_msg'],
    cr['errorMsg'],
    cr['message'],
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.trim() !== '') return capDetail(c);
  }
  const code = j['error_code'] ?? j['errorCode'] ?? cr['error_code'] ?? cr['errorCode'];
  if (code !== undefined) {
    // 有错误码但无消息字段：至少把码与响应体一并给出，别让调用方只看到状态码
    return capDetail(`错误码 ${String(code)}：${JSON.stringify(j).slice(0, MAX_ERROR_DETAIL_CHARS)}`);
  }
  return capDetail(JSON.stringify(j).slice(0, MAX_ERROR_DETAIL_CHARS));
}

/**
 * XS 设计时 REST 失败错误（携带服务端原始响应，供上层一次调用把详情给全）。
 * - httpStatus：原始状态码（如 555 = 激活失败；并发写/删被服务端以写错误拒绝时同为 555）
 * - checkResult：响应体里的 CheckResult 原文（含 Write/Activate 与错误字段）
 * - body：完整响应体（已按上限截断，截断处有标注）
 *
 * 【承载范围】自 assertOk 统一改造后，它承载**任何** XS 非 2xx 响应（不再只是 writeFile 的写路径；
 * 名字保留不改，避免大范围改动）。唯一目的是让 HTTP 状态机读（envelope.raw.errorDetail.httpStatus）——
 * 调用方按状态分流（如 555 服务端并发写拒绝），不必正则解析失败文案；412/404 等已有专门机读分类的
 * 语义仍在各调用方**先行**分流，不走这条通用出口。
 */
export class XsWriteError extends HanaBusinessError {
  constructor(
    message: string,
    public readonly httpStatus: number,
    public readonly checkResult?: WriteCheckResult,
    public readonly body?: string,
    code?: string,
  ) {
    // 原始载荷挂到 rawDetail → envelope.raw.errorDetail：调用方一次拿到 HTTP 状态 + CheckResult + 响应体
    super(message, code, undefined, [], undefined, {
      httpStatus,
      ...(checkResult ? { checkResult } : {}),
      ...(body ? { body } : {}),
    });
    this.name = 'XsWriteError';
  }
}

/** XS REST 空会话/令牌异常分类：写前置必须登录，否则给清晰提示 */
export class XsAuthError extends HanaBusinessError {}

/**
 * XS REST 会话：
 * - 持有独立 HTTP agent（Node 原生 fetch，经 global fetch 或 http/https）
 * - cookie 由 fetch 的 Set-Cookie 手工维护（Node fetch 无 cookie jar）
 * - CSRF token 缓存，失效（401/403 x-csrf-token: Required）时自动重取
 */
export class XsRestClient {
  private readonly baseUrl: string;
  private readonly basePath: string;
  private readonly user: string;
  private readonly password: string;
  /** 走 request() 出口的全部请求的默认超时（HANA_XS_TIMEOUT_MS） */
  private readonly timeoutMs: number;
  /** xfer 导入/导出超时（HANA_XS_XFER_TIMEOUT_MS）：整包上传/下载天然慢 */
  private readonly xferTimeoutMs: number;
  /** 激活并发上限（HANA_ACTIVATION_CONCURRENCY）：所有会触发服务端激活的写共享（每次写恰好取一次，§4.6） */
  private readonly activationConcurrency: number;
  private cookies = new Map<string, string>();
  private csrfToken?: string;

  constructor(config: HanaConfig) {
    const host = config.host;
    const port = config.xsPort ?? Number(`80${config.instance}`);
    this.baseUrl = `http://${host}:${port}`;
    // 默认值单点在 XS_BASE_PATH（本文件），config 的 HANA_XS_BASE_PATH zod default 引用同一常量；
    // 这里保留兜底是因为 XsRestClient 要对"字段缺失的配置"也能给出可用行为，而不是 TypeError
    this.basePath = (config.xsBasePath ?? XS_BASE_PATH).replace(/\/+$/, '');
    this.user = config.user;
    this.password = config.password;
    // 默认值单点在 core/limits.ts（zod default 与运行时兜底引用同一常量，防"配置默认值 ≠ 兜底值"分叉）
    this.timeoutMs = config.xsTimeoutMs ?? XS_TIMEOUT_MS_DEFAULT;
    this.xferTimeoutMs = config.xsXferTimeoutMs ?? XS_XFER_TIMEOUT_MS_DEFAULT;
    this.activationConcurrency = config.activationConcurrency ?? ACTIVATION_CONCURRENCY_DEFAULT;
  }

  /** 完整 REST 基础路径，如 http://host:8010/sap/hana/xs/dt/base */
  get restBase(): string {
    return `${this.baseUrl}${this.basePath}`;
  }

  /** 建立 XS 会话：token.xsjs（unsafe token）→ login.xscfunc（cookie） */
  async login(): Promise<void> {
    // 1) 拿 XS 登录用的 CSRF token（此时固定返回 "unsafe"，仅满足协议要求）
    // 登录/取 token 只碰 XS 登录端点：短超时让"连不上"快速暴露，不套写动词的 30s
    await this.request(
      `${this.baseUrl}/sap/hana/xs/formLogin/token.xsjs`,
      {
        method: 'GET',
        headers: { 'X-CSRF-Token': 'Fetch' },
      },
      { timeoutMs: XS_LOGIN_TIMEOUT_MS },
    );
    // 2) 表单登录拿会话 cookie
    const body = new URLSearchParams({ 'xs-username': this.user, 'xs-password': this.password });
    const resp = await this.request(
      `${this.baseUrl}/sap/hana/xs/formLogin/login.xscfunc`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'X-CSRF-Token': this.csrfToken ?? 'unsafe',
        },
        body: body.toString(),
      },
      { timeoutMs: XS_LOGIN_TIMEOUT_MS },
    );
    if (resp.status !== 200) {
      throw new XsAuthError(
        `XS 登录失败（HTTP ${resp.status}）。请确认 HANA_USER/HANA_PASSWORD 是可用 XS Classic 会话账号`,
      );
    }
    const parsed = safeJson<{ login?: boolean; pwdChange?: boolean }>(resp.body);
    if (parsed?.login !== true) {
      throw new XsAuthError(`XS 登录被拒绝：${resp.body.slice(0, 200) || '无错误详情'}`);
    }
    // 3) 从 dt 端点取「真正的」写 CSRF token
    await this.refreshCsrf();
  }

  /** 从 dt 端点取写动词必需的 CSRF token（带 X-CSRF-Token: Fetch 时服务端会签发） */
  async refreshCsrf(): Promise<string> {
    const resp = await this.request(
      `${this.restBase}/info`,
      {
        method: 'GET',
        headers: { 'Orion-Version': '1.0', 'X-CSRF-Token': 'Fetch' },
      },
      { timeoutMs: XS_LOGIN_TIMEOUT_MS },
    );
    const token = resp.headers['x-csrf-token'] ?? resp.headers['X-CSRF-Token'];
    if (token && token !== 'unsafe' && token !== 'Required') {
      this.csrfToken = token;
    }
    if (!this.csrfToken) {
      throw new XsAuthError(`无法获取 XS 写操作 CSRF token（/base/info 未返回 X-CSRF-Token）`);
    }
    return this.csrfToken;
  }

  /** 确保已登录（懒登录；MCP 工具首次写操作时触发） */
  private async ensureSession(): Promise<void> {
    if (this.cookies.size === 0) await this.login();
  }

  /**
   * 基础请求：维护 cookie、失败时归一化为 HanaBusinessError（raw=true 时保留原始字节）。
   * 超时统一从这个出口生效（opts.timeoutMs 缺省 this.timeoutMs）——fileContent/fileMeta/login/
   * refreshCsrf/workspace/xfer 全部走这里；调用方已带 signal 时尊重之（不叠加 timeout）。
   */
  private async request(
    url: string,
    init: RequestInit & { redirect?: NonNullable<RequestInit['redirect']> },
    opts: { raw?: boolean; timeoutMs?: number } = {},
  ): Promise<XsResponse> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.cookies.size > 0) {
      headers['Cookie'] = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    // 没有超时，一条挂死的请求会占住池位直到进程重启——AbortSignal.timeout 到点以
    // DOMException('TimeoutError') 中止 fetch（Node >=17.3 原生支持）
    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const signal = init.signal ?? AbortSignal.timeout(timeoutMs);
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, headers, redirect: init.redirect ?? 'manual', signal });
    } catch (e) {
      const path = url.replace(/^https?:\/\/[^/]+/, '');
      const name = e instanceof Error ? e.name : undefined;
      // 超时（AbortSignal.timeout → 'TimeoutError'；外部 signal 中止 → 'AbortError'）与非超时网络错误分开报
      if (name === 'TimeoutError' || name === 'AbortError') {
        throw new HanaBusinessError(
          `XS REST 请求超时（超过 ${timeoutMs}ms）：${path}。服务端可能正忙或链路不通；本次调用未完成，可稍后重试`,
        );
      }
      const msg = e instanceof Error ? e.message : String(e);
      throw new HanaBusinessError(`XS REST 请求失败（${path}）：${msg}`);
    }
    // 吸收 Set-Cookie（可能多个）
    const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
    for (const sc of setCookies) {
      const pair = sc.split(';')[0];
      const eq = pair.indexOf('=');
      if (eq > 0) this.cookies.set(pair.slice(0, eq).trim(), pair.slice(eq + 1).trim());
    }
    const outHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => {
      outHeaders[k.toLowerCase()] = v;
    });
    if (opts.raw) {
      const buffer = Buffer.from(await resp.arrayBuffer());
      return { status: resp.status, headers: outHeaders, body: buffer.toString('utf8'), buffer };
    }
    const body = await resp.text();
    return { status: resp.status, headers: outHeaders, body };
  }

  /** 带会话+写 CSRF 的请求（写动词由调用方决定是否需要 CSRF；write=true 时带上） */
  private async authed(
    url: string,
    init: RequestInit & { redirect?: NonNullable<RequestInit['redirect']> },
    opts: { csrf?: boolean; raw?: boolean; timeoutMs?: number } = {},
  ): Promise<XsResponse> {
    await this.ensureSession();
    const headers: Record<string, string> = {
      'Orion-Version': '1.0',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (opts.csrf !== false && this.csrfToken && init.method !== 'GET') {
      headers['X-CSRF-Token'] ??= this.csrfToken;
    }
    let resp = await this.request(url, { ...init, headers }, { raw: opts.raw, timeoutMs: opts.timeoutMs });
    // CSRF token 失效（403 + x-csrf-token: Required）→ 重取一次并重试
    if (resp.status === 403 && resp.headers['x-csrf-token'] === 'Required') {
      await this.refreshCsrf();
      headers['X-CSRF-Token'] = this.csrfToken!;
      resp = await this.request(url, { ...init, headers }, { raw: opts.raw, timeoutMs: opts.timeoutMs });
    }
    return resp;
  }

  /**
   * 写回执的新基线 = 写响应的响应头 ETag（实测 §4.9#A：与随后 fileMeta 读值逐字一致）。
   * 响应头缺失时**删除**响应体里可能携带的 ETag 并标 etagSource:'unavailable'——禁止补读 fileMeta
   * 冒充新基线：PUT 与补读之间的第三方写入会被谎报为"本次写的新基线"（下游补偿会静默覆盖）。
   */
  private stampWriteEtag(meta: FileMeta, resp: XsResponse): void {
    const headerEtag = resp.headers['etag'];
    if (headerEtag) {
      meta.ETag = headerEtag;
      meta.etagSource = 'response-header';
    } else {
      delete meta.ETag;
      meta.etagSource = 'unavailable';
    }
  }

  /**
   * 412 冲突载荷的补读（P5 §4.2）：实测 412 响应**不带** ETag 头，只能立刻再读一次 fileMeta，
   * 把「冲突时点」的当前版本带进 ConflictInfo 供调用方自我诊断——currentETag 不是本次写的新基线。
   * 补读失败绝不掩盖 412：原因写进 currentUnavailable（如对象已被并发删除），不静默成 undefined。
   */
  private async conflictAt(
    packageId: string,
    objectName: string | undefined,
    httpStatus: number,
    providedEtag?: string,
  ): Promise<ConflictInfo> {
    const conflict: ConflictInfo = { httpStatus, providedEtag };
    try {
      const meta = await this.fileMeta(packageId, objectName);
      if (meta.ETag !== undefined) conflict.currentETag = meta.ETag;
      if (meta.SapBackPack?.Version !== undefined) conflict.currentVersion = meta.SapBackPack.Version;
      if (meta.SapBackPack?.ActivatedAt !== undefined) conflict.activatedAt = meta.SapBackPack.ActivatedAt;
    } catch (e) {
      conflict.currentUnavailable = `补读当前版本失败：${e instanceof Error ? e.message : String(e)}`;
    }
    return conflict;
  }

  /** 错误信息提取：优先 HANA 错误字段（完整不截断），否则响应体原文 */
  private describeError(resp: XsResponse, action: string): string {
    const detail = extractErrorDetail(resp.body);
    return `XS ${action} 失败（HTTP ${resp.status}）：${detail || '无错误详情'}`;
  }

  /**
   * 断言 2xx 且返回体非空合法 JSON（写操作响应体可为空，如 204）。
   *
   * 非 2xx 统一经 XsWriteError 抛出（P5 §4.9#E 后续修复）：文案保持 describeError 原样不变（人读），
   * 同时把 HTTP 状态 + 截断后的响应体落进 rawDetail → envelope.raw.errorDetail（机读）——实测并发
   * DELETE/PUT 会被服务端以 555 写错误拒绝，此前只把状态写进散文，调用方无法机读分流。
   * 412/404 等已有专门机读分类的语义在各自调用方**先行**分流（那是 P5 冲突协议），不走这条出口。
   */
  private assertOk(resp: XsResponse, action: string, allowEmpty = false): void {
    if (resp.status < 200 || resp.status >= 300) {
      // 响应体可能是 JSON（CheckResult 等）：解析出来一并带上；解析不到就省略该参（不硬造形状）
      const cr = safeJson<{ CheckResult?: WriteCheckResult }>(resp.body)?.CheckResult;
      throw new XsWriteError(
        this.describeError(resp, action),
        resp.status,
        cr && typeof cr === 'object' ? cr : undefined,
        capDetail(resp.body),
      );
    }
    if (!allowEmpty && resp.body.trim() === '') {
      throw new HanaBusinessError(`XS ${action} 返回空响应（HTTP ${resp.status}）`);
    }
  }

  /** GET /base/info：版本与命令清单（自检用） */
  async info(): Promise<unknown> {
    const resp = await this.authed(`${this.restBase}/info`, { method: 'GET' });
    this.assertOk(resp, 'info');
    return safeJson(resp.body);
  }

  /** GET /base/workspace：当前用户 workspace 列表（含 Id） */
  async listWorkspaces(): Promise<unknown> {
    const resp = await this.authed(`${this.restBase}/workspace`, { method: 'GET' });
    this.assertOk(resp, 'workspace 列表');
    return {
      workspaces: safeJson<{ UserName?: string; Id?: string; Workspaces?: unknown[] }>(resp.body),
    };
  }
  /** GET /base/workspace 原始体（当前用户 workspace 列表） */
  async workspace(): Promise<{ UserName?: string; Id?: string; Workspaces?: Array<{ Name?: string; Id?: string }> }> {
    const resp = await this.authed(`${this.restBase}/workspace`, { method: 'GET' });
    this.assertOk(resp, 'workspace 列表');
    return (
      safeJson<{ UserName?: string; Id?: string; Workspaces?: Array<{ Name?: string; Id?: string }> }>(resp.body) ?? {}
    );
  }

  /**
   * POST /base/workspace：建立 workspace（XS 会话级）。官方语义是「写 inactive 版本的前置上下文」，
   * 但本 SPS 写入即激活、无 inactive 暂存（实测带 Workspace 的写照样自动激活），该通道对写结果无影响。
   * 实测：201，JSON 体 {"Name":…} + Slug 头。
   */
  async createWorkspace(name: string): Promise<unknown> {
    const resp = await this.authed(`${this.restBase}/workspace`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Slug: name },
      body: JSON.stringify({ Name: name }),
    });
    // 允许 200/201（部分 SPS 对已存在 workspace 返回 200）
    if (resp.status !== 200 && resp.status !== 201) {
      throw new HanaBusinessError(this.describeError(resp, `创建 workspace ${name}`));
    }
    return safeJson(resp.body) ?? {};
  }

  /**
   * get-or-create workspace：列表命中直接复用，否则创建。
   * @param name 建议名（如 'ZDEMO'）；按名字精确匹配复用，避免重复创建。
   */
  async getOrCreateWorkspace(name: string): Promise<string> {
    const list = await this.workspace();
    const existing = (list.Workspaces ?? []).find((w) => w.Name === name);
    if (existing?.Name) return existing.Name;
    await this.createWorkspace(name);
    return name;
  }

  /**
   * GET /base/file/<path>?parts=meta：文件元数据（ETag / 激活状态 / workspace 版本）。
   * packageId 层级用 '.'，文件后缀即设计时对象后缀。
   */
  async fileMeta(packageId: string, objectName?: string): Promise<FileMeta> {
    const path = objectName ? `${packageId}/${objectName}` : packageId;
    const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}?parts=meta`, {
      method: 'GET',
    });
    // 404 带机读码（P5 §4.2#3）：import 守卫据此把「读异常即当不存在」收紧为「仅 404 视为不存在」
    if (resp.status === 404) {
      throw new HanaBusinessError(`对象不存在：${path}`, 'OBJECT_NOT_FOUND');
    }
    this.assertOk(resp, `读取元数据 ${path}`);
    return safeJson<FileMeta>(resp.body) ?? ({} as FileMeta);
  }

  /** GET /base/file/<path>：文件正文（读设计时内容） */
  async fileContent(packageId: string, objectName: string): Promise<string> {
    const path = `${packageId}/${objectName}`;
    const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}`, { method: 'GET' });
    if (resp.status === 404) {
      throw new HanaBusinessError(`对象不存在：${path}`, 'OBJECT_NOT_FOUND');
    }
    this.assertOk(resp, `读取内容 ${path}`, true);
    return resp.body;
  }

  /**
   * POST /base/file/<pkg>/：创建包（目录）。
   * 实测：201，JSON 体 {"Name":…,"Directory":true} + Slug 头。
   */
  async createPackage(packageId: string, packageName: string, description?: string): Promise<FileMeta> {
    const parent = packageId.split('.').slice(0, -1).join('.');
    const target = parent || packageId;
    const body = JSON.stringify({
      Name: packageName,
      Directory: true,
      ...(description ? { Description: description } : {}),
    });
    const resp = await this.authed(`${this.restBase}/file/${encodePath(target)}/`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Slug: packageName,
      },
      body,
    });
    this.assertOk(resp, `创建包 ${packageId}`);
    return safeJson<FileMeta>(resp.body) ?? ({} as FileMeta);
  }

  /**
   * PUT /base/file/<pkg>/<object>：写设计时文件（create-or-update）。
   * 实测契约（SPS08）：
   * - POST 到文件路径一律 400 "Bad Request Header or Body" → 统一用 PUT（无 If-Match 时可创建新对象）
   * - PUT 会顺带跑一次激活检查并把结果放响应体（CheckResult），失败为 202 Warning，不影响写入
   * - opts.activate → SapBackPack {"Activate":true}，激活失败为 HTTP 555 + error_msg 明细
   * - opts.ifMatch → 乐观锁；不匹配返回 412（412 响应不带 ETag，冲突载荷经补读 fileMeta 取得）
   * - opts.workspace → SapBackPack {"Workspace":…}（实测本 SPS 不改变行为：合法模型照样自动激活）
   * - **所有** PUT 都在激活信号量内执行（写入即激活，见文件头 §6）——带不带 activate 都触发服务端激活
   */
  async writeFile(
    packageId: string,
    objectName: string,
    content: string,
    opts: { activate?: boolean; workspace?: string; version?: number; ifMatch?: string } = {},
  ): Promise<FileMeta & { CheckResult?: WriteCheckResult }> {
    const path = `${packageId}/${objectName}`;
    const sapBackPack: SapBackPack = {};
    if (opts.activate) {
      sapBackPack.Activate = true;
      if (opts.version !== undefined) sapBackPack.Version = opts.version;
    } else if (opts.workspace) {
      sapBackPack.Workspace = opts.workspace;
    }
    const headers: Record<string, string> = {
      'Content-Type': 'application/xml; charset=utf-8',
      ...(Object.keys(sapBackPack).length > 0 ? { SapBackPack: JSON.stringify(sapBackPack) } : {}),
    };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    /** PUT + 状态处理（412 补读、555 分支、ETag 回执）——整段在激活信号量内执行（写入即激活） */
    const put = async (): Promise<FileMeta & { CheckResult?: WriteCheckResult }> => {
      const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}`, {
        method: 'PUT',
        headers,
        body: content,
      });
      // 乐观锁冲突（显式 If-Match 与服务端不符）：412 Precondition Failed。
      // 只认「带 If-Match 的 412」，避免激活失败等其他 4xx 被误分类。
      if (opts.ifMatch && resp.status === 412) {
        throw HanaBusinessError.withConflict(
          `写文件 ${path} 冲突：版本已被他人修改（If-Match 不匹配，HTTP 412）。${this.describeError(resp, '写文件')}`,
          '412',
          // 412 响应不带 ETag（实测），补读冲突时点的当前版本——多一次往返不可省；补读失败原因进 currentUnavailable
          await this.conflictAt(packageId, objectName, 412, opts.ifMatch),
        );
      }
      const parsed = safeJson<FileMeta & { CheckResult?: WriteCheckResult }>(resp.body);
      // 附带原始 HTTP 状态（非标准字段，仅服务端内部消费）：activationDetailOf 用它区分
      // 555（写成功/激活失败）与 202（Check 未通过），故此处必须写入真实状态，不能缺省
      if (parsed) parsed['_httpStatus'] = resp.status;
      if (resp.status < 200 || resp.status >= 300) {
        const cr = parsed?.CheckResult;
        // 激活失败（HTTP 555）：CheckResult.Operations.Write=true 表示**文件已写入**，只有激活没通过。
        // 这不是"写失败"——按非致命结果原样返回，调用方一次即可拿到 activated=false + 完整 CheckResult
        // （CheckResult 必须原样带出：丢掉它，调用方就得再调一次设计时校验才能看到 DDL 全文）。
        if (resp.status === 555 && cr?.Operations?.Write === true) {
          logger.warn(
            { path, httpStatus: resp.status, errorCode: cr.error_code ?? cr.errorCode },
            'XS 写入成功但激活失败：按非致命结果返回（错误明细随响应体透出，调用方无需二次校验）',
          );
          const written = parsed as FileMeta & { CheckResult?: WriteCheckResult };
          // 文件确实写入了（只是激活没通过）：回执同样按响应头给新基线/如实标 unavailable
          this.stampWriteEtag(written, resp);
          return written;
        }
        throw new XsWriteError(this.describeError(resp, `写文件 ${path}`), resp.status, cr, capDetail(resp.body));
      }
      // 成功回执的新基线 = 响应头 ETag（§4.2#1）；响应头缺失即标 unavailable，不补读拼装
      const meta = (parsed ?? {}) as FileMeta & { CheckResult?: WriteCheckResult };
      this.stampWriteEtag(meta, resp);
      return meta;
    };
    // 本 SPS 写入即激活（见文件头 §6）：任何合法 PUT（裸 PUT / Check / Workspace / Activate）都会触发
    // 服务端激活，所以**所有**写都过同一激活信号量，不再按 activate 参数分流；每次写恰好取一次。
    // 全局锁序 keyed lock → 信号量 → 网络/DB：信号量必须在 keyed lock 之内获取（服务层先包锁），
    // 否则与 update 的 lock→semaphore 构成锁序反转（T1 持信号量等锁、T2 持锁等信号量）= 死锁。
    // 调用方（如 activateCalculationView）**绝不**在顶层再包一层：许可已在这里取，重复取等于同一逻辑
    // 操作占两份许可（limit=1 时自锁死）。
    return withSemaphore(ACTIVATION_SEMAPHORE, this.activationConcurrency, put);
  }

  /**
   * PUT + SapBackPack {"Check":true}：激活检查（Studio「Team > Check」同款动词）。
   * 【实测注意】本 SPS 上合法模型会在这次 PUT 中被**直接激活**（Activated=true）——
   * Check 不抑制激活，只把检查结果放进响应体。需要对原对象做无副作用校验时，
   * 调用方应把内容写到临时对象上再 checkFile 并删除临时对象。
   */
  async checkFile(packageId: string, objectName: string, content: string): Promise<CheckFileResult> {
    const path = `${packageId}/${objectName}`;
    // 这次 PUT 同样会触发服务端激活（Check 不抑制激活，见上），故与正式写共享激活信号量（恰好取一次）
    const resp = await withSemaphore(ACTIVATION_SEMAPHORE, this.activationConcurrency, () =>
      this.authed(`${this.restBase}/file/${encodePath(path)}`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/xml; charset=utf-8',
          SapBackPack: JSON.stringify({ Check: true }),
        },
        body: content,
      }),
    );
    const j = safeJson<{
      HttpCode?: number;
      Message?: string;
      CheckResult?: {
        Operations?: { Write?: boolean; Activate?: boolean };
        error_code?: number | string;
        error_msg?: string;
        errorCode?: number | string;
        errorMsg?: string;
      };
    }>(resp.body);
    if (!j?.CheckResult && (resp.status < 200 || resp.status >= 300)) {
      throw new HanaBusinessError(this.describeError(resp, '校验'));
    }
    const cr = j?.CheckResult;
    const activated = cr?.Operations?.Activate === true;
    const code = cr?.error_code ?? cr?.errorCode;
    // 消息优先取结构化字段；取不到就退回完整响应体文本（含 Type/Procedure DDL 明细），不截断
    const msg = cr?.error_msg ?? cr?.errorMsg ?? j?.Message ?? (activated ? undefined : extractErrorDetail(resp.body));
    // 回执基线只认响应头（与 writeFile 的 stampWriteEtag 同规则）：缺失即缺省，不补读 fileMeta 拼装——
    // 补读只能拿到「读那一刻」的版本，冒充本次写的新基线会让实例级验身份证到错对象
    const headerEtag = resp.headers['etag'];
    return {
      consistent: activated,
      message: activated ? undefined : msg ? String(msg) : `校验未通过（HTTP ${resp.status}）`,
      errorCode: code !== undefined ? String(code) : undefined,
      ...(headerEtag ? { etag: headerEtag } : {}),
      raw: resp.body,
    };
  }

  /**
   * DELETE /base/file/<path>：删除设计时对象/包（204 成功）。
   * 实测（§4.9#C）：DELETE 执行 If-Match——正确基线 → 204、陈旧基线 → 412、对象已不存在 → 404
   * （重复删为 404 而非 412）。412/404 必须先于通用 assertOk 分类，落到机读冲突形状（envelope.raw.conflict）。
   */
  async deleteFile(packageId: string, objectName?: string, opts: { ifMatch?: string } = {}): Promise<XsResponse> {
    const path = objectName ? `${packageId}/${objectName}` : packageId;
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}`, {
      method: 'DELETE',
      headers,
    });
    // 乐观锁冲突：与 writeFile 同款——412 响应不带 ETag，补读冲突时点版本（补读失败不掩盖 412）
    if (opts.ifMatch && resp.status === 412) {
      throw HanaBusinessError.withConflict(
        `删除 ${path} 冲突：版本已被他人修改（If-Match 不匹配，HTTP 412）。${this.describeError(resp, '删除')}`,
        '412',
        await this.conflictAt(packageId, objectName, 412, opts.ifMatch),
      );
    }
    // 对象已不存在（含重复删除）：机读 OBJECT_NOT_FOUND，调用方按码分流（delete 场景映射为业务失败信封）
    if (resp.status === 404) {
      throw HanaBusinessError.withConflict(`对象不存在：${path}`, 'OBJECT_NOT_FOUND', {
        httpStatus: 404,
        providedEtag: opts.ifMatch,
        currentUnavailable: '对象已不存在（无法读取当前版本）',
      });
    }
    this.assertOk(resp, `删除 ${path}`, true);
    return resp;
  }

  /**
   * GET /base/xfer/export/<pkg>.zip：导出包为 zip（Transfer API，官方 §8.2.5）。
   * 实测契约（SPS08）：`/xfer/export/ZDEMO.zip` 与 `/xfer/export/ZDEMO`（裸包名）返回
   * 201 + zip（PK 魔数）；`/xfer/export/ZDEMO/ZDEMO.zip` 报 404 "Package not found: ZDEMO/ZDEMO"
   * （首个路径段之后的段被并进包名）。另 meta 的 Parents[].ExportLocation 亦为 <pkg>.zip 形态。
   */
  async exportPackageZip(packageId: string): Promise<{ buffer: Buffer; url: string }> {
    const variants = [
      encodePath(packageId) + '.zip', // /xfer/export/ZDEMO.zip（实测规范形态）
      encodePath(packageId), // /xfer/export/ZDEMO（实测同样可行）
    ];
    let lastError = '';
    for (const v of variants) {
      // xfer 传输天然慢：整包导出按 xfer 超时计（默认 300s），不套写动词的 30s
      const resp = await this.authed(
        `${this.restBase}/xfer/export/${v}`,
        { method: 'GET' },
        { raw: true, timeoutMs: this.xferTimeoutMs },
      );
      if (
        resp.status >= 200 &&
        resp.status < 300 &&
        resp.buffer &&
        resp.buffer.subarray(0, 2).toString('ascii') === 'PK'
      ) {
        return { buffer: resp.buffer, url: `${this.restBase}/xfer/export/${v}` };
      }
      lastError = `HTTP ${resp.status}: ${resp.body.replace(/\s+/g, ' ').slice(0, 200)}`;
    }
    throw new HanaBusinessError(`XS 导出包 ${packageId} 失败：${lastError || '所有 URL 变体均未返回 zip'}`);
  }

  /**
   * Transfer API 导入（官方 §8.2.5 + 实测定案）：POST 发起 + PUT 分片上传（本实现单分片整体上传）。
   * 【实测】POST 目标必须是**目录** `/xfer/import/<pkg>/`（带尾斜杠）+ `Slug: <文件名>`——
   * 目标含文件名（`/xfer/import/<pkg>/<file>`）会把文件写进 `<pkg>/<file>/<file>` 错误嵌套路径，
   * 不注册为仓库对象；目录目标则正确落库（计划 §6 P0 ④ 实测：落库即激活 Activated=true / Version=1，
   * **不存在 inactive 暂存**）。
   * POST（200 + Location）→ PUT <Location> 带 Content-Range: bytes 0-(n-1)/n → 201 + 'Upload finished'。
   * 【已知边界（有意）】本通道**不纳入**激活信号量：xfer 上传超时放宽到 300s，长期占许可会饿死其它写；
   * 写入即激活的限流承诺由 writeFile/checkFile 承担（文档侧应如实声明该边界）。
   */
  async importFile(
    packageId: string,
    fileName: string,
    content: Buffer | string,
    opts: { contentType?: string } = {},
  ): Promise<{ location: string; range?: string }> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const total = buf.length;
    // 整包上传天然慢：POST 发起与 PUT 分片都按 xfer 超时计（默认 300s）
    const post = await this.authed(
      `${this.restBase}/xfer/import/${encodePath(packageId)}/`,
      {
        method: 'POST',
        headers: {
          Slug: fileName,
          'X-Xfer-Content-Length': String(total),
          'X-Xfer-Options': 'raw',
        },
      },
      { timeoutMs: this.xferTimeoutMs },
    );
    // 发起步骤成功即 200 + Location 头（响应体可为空）
    this.assertOk(post, `发起导入 ${packageId}/${fileName}`, true);
    const location = post.headers['location'] ?? post.headers['contentlocation'];
    if (!location) {
      throw new HanaBusinessError(
        `XS 导入 ${packageId}/${fileName} 未返回上传 Location（HTTP ${post.status}）：${post.body.slice(0, 200)}`,
      );
    }
    const uploadUrl = /^https?:\/\//i.test(location) ? location : `${this.baseUrl}${location}`;
    // 实测：文本内容必须显式声明 charset=utf-8——缺省时 XS 层按 Latin-1 解码请求体，
    // 中文等非 ASCII 描述会被双重编码成乱码
    const contentType =
      opts.contentType ??
      (fileName.endsWith('.xml') || fileName.endsWith('.calculationview')
        ? 'application/xml; charset=utf-8'
        : 'application/octet-stream');
    const put = await this.authed(
      uploadUrl,
      {
        method: 'PUT',
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes 0-${total - 1}/${total}`,
        },
        body: new Uint8Array(buf),
      },
      { timeoutMs: this.xferTimeoutMs },
    );
    // 成功即 201 + Location（目标文件路径）+ 'Upload finished'（响应体可为空）
    this.assertOk(put, `上传分片 ${packageId}/${fileName}`, true);
    return { location, range: put.headers['range'] };
  }

  /**
   * GET /base/change：变更列表（Change-Tracking API，只读）。
   * SapBackPack 可带 User / Status 过滤（官方 §8.2.4）。
   */
  async changeList(opts: { user?: string; status?: number } = {}): Promise<unknown> {
    const sbp: Record<string, unknown> = {};
    if (opts.user) sbp['User'] = opts.user;
    if (opts.status !== undefined) sbp['Status'] = opts.status;
    const resp = await this.authed(`${this.restBase}/change`, {
      method: 'GET',
      headers: Object.keys(sbp).length > 0 ? { SapBackPack: JSON.stringify(sbp) } : {},
    });
    this.assertOk(resp, '变更列表');
    return safeJson(resp.body) ?? { raw: resp.body.slice(0, 2000) };
  }
}

/** 路径片段 URL 编码（保留 '/'，'..' 等非法序列由上层白名单拦截） */
function encodePath(path: string): string {
  return path
    .split('/')
    .map((s) => encodeURIComponent(s))
    .join('/');
}

/** 安全 JSON 解析（失败返回 undefined，不抛） */
function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}
