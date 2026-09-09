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
 *    写 inactive 不需要 workspace 上下文（PUT 本身不触发 40106）
 * 6. 【关键实测】本 SPS 对**合法模型一律写入即激活**：裸 PUT / {"Activate":true} / {"Workspace":…} /
 *    {"Check":true} 全都激活（Activated=true、Version 递增）；区别仅在响应——
 *    {"Check":true} 与裸 PUT 把激活检查结果放响应体 CheckResult（失败 202 Warning），
 *    {"Activate":true} 失败为 HTTP 555 + error_msg。写 inactive 经本 API 不可达（激活失败的对象才是 inactive）
 * 7. 乐观锁：过期 If-Match → 412（引号可选）
 * 8. Transfer API：导出 GET /xfer/export/<pkg>.zip（201 + zip）；导入 POST /xfer/import/<pkg>/（目录目标+
 *    Slug 文件名，200 + Location）→ PUT 分片（Content-Range，201）→ 落库为 inactive 对象
 *    （目标含文件名会写进 <pkg>/<file>/<file> 错误路径，禁用）
 *
 * 安全：凭据一律来自 config（不落日志）；请求体/头不做 debug 级日志。
 */
import type { HanaConfig } from '../config/config.js';
import { HanaBusinessError } from './errors.js';
import { logger } from './logger.js';

/** XS HTTP 服务端口（80<instance>，与官方文档 §8.2 及本库实测一致） */
export const XS_BASE_PATH = '/sap/hana/xs/dt/base';

/** SapBackPack 头 JSON 的字段（集中在常量表，便于按 SPS 调字段名/大小写） */
export interface SapBackPack {
  /** 是否写后立即激活（activate 链路） */
  Activate?: boolean;
  /** 仓库 workspace 名（写 inactive 版本用；inactive 写入不带 Activate 时指定） */
  Workspace?: string;
  /** 乐观锁基线版本号（来自 GET ?parts=meta 的 SapBackPack.Version / ETag） */
  Version?: number;
  /** 变更列表 ID（可选，本实现暂不使用） */
  ChangeId?: string;
}

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
  SapBackPack?: { Version?: number; Type?: number; ActivatedAt?: number; ActivatedBy?: string; ObjectStatus?: string; IsDeletion?: boolean };
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
}

/** 从写响应体提取激活检查结果（无则 undefined） */
export function extractCheckResult(body: unknown): { consistent: boolean; message?: string; errorCode?: string } | undefined {
  const cr = (body as { CheckResult?: WriteCheckResult } | null | undefined)?.CheckResult;
  if (!cr) return undefined;
  const activated = cr.Operations?.Activate === true;
  const code = cr.error_code ?? cr.errorCode;
  const msg = cr.error_msg ?? cr.errorMsg;
  return {
    consistent: activated,
    message: activated ? undefined : (msg ? String(msg) : '激活检查未通过'),
    errorCode: code !== undefined ? String(code) : undefined,
  };
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
  private cookies = new Map<string, string>();
  private csrfToken?: string;

  constructor(config: HanaConfig) {
    const host = config.host;
    const port = config.xsPort ?? Number(`80${config.instance}`);
    this.baseUrl = `http://${host}:${port}`;
    this.basePath = config.xsBasePath?.replace(/\/+$/, '') ?? XS_BASE_PATH;
    this.user = config.user;
    this.password = config.password;
  }

  /** 完整 REST 基础路径，如 http://host:8010/sap/hana/xs/dt/base */
  get restBase(): string {
    return `${this.baseUrl}${this.basePath}`;
  }

  /** 建立 XS 会话：token.xsjs（unsafe token）→ login.xscfunc（cookie） */
  async login(): Promise<void> {
    // 1) 拿 XS 登录用的 CSRF token（此时固定返回 "unsafe"，仅满足协议要求）
    await this.request(`${this.baseUrl}/sap/hana/xs/formLogin/token.xsjs`, {
      method: 'GET',
      headers: { 'X-CSRF-Token': 'Fetch' },
    });
    // 2) 表单登录拿会话 cookie
    const body = new URLSearchParams({ 'xs-username': this.user, 'xs-password': this.password });
    const resp = await this.request(`${this.baseUrl}/sap/hana/xs/formLogin/login.xscfunc`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'X-CSRF-Token': this.csrfToken ?? 'unsafe',
      },
      body: body.toString(),
    });
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
    const resp = await this.request(`${this.restBase}/info`, {
      method: 'GET',
      headers: { 'Orion-Version': '1.0', 'X-CSRF-Token': 'Fetch' },
    });
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

  /** 基础请求：维护 cookie、失败时归一化为 HanaBusinessError（raw=true 时保留原始字节） */
  private async request(
    url: string,
    init: RequestInit & { redirect?: NonNullable<RequestInit['redirect']> },
    opts: { raw?: boolean } = {},
  ): Promise<XsResponse> {
    const headers: Record<string, string> = { ...(init.headers as Record<string, string> | undefined) };
    if (this.cookies.size > 0) {
      headers['Cookie'] = [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
    }
    let resp: Response;
    try {
      resp = await fetch(url, { ...init, headers, redirect: init.redirect ?? 'manual' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new HanaBusinessError(`XS REST 请求失败（${url.replace(/^https?:\/\/[^/]+/, '')}）：${msg}`);
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
    opts: { csrf?: boolean; raw?: boolean } = {},
  ): Promise<XsResponse> {
    await this.ensureSession();
    const headers: Record<string, string> = {
      'Orion-Version': '1.0',
      ...(init.headers as Record<string, string> | undefined),
    };
    if (opts.csrf !== false && this.csrfToken && init.method !== 'GET') {
      headers['X-CSRF-Token'] ??= this.csrfToken;
    }
    let resp = await this.request(url, { ...init, headers }, { raw: opts.raw });
    // CSRF token 失效（403 + x-csrf-token: Required）→ 重取一次并重试
    if (resp.status === 403 && resp.headers['x-csrf-token'] === 'Required') {
      await this.refreshCsrf();
      headers['X-CSRF-Token'] = this.csrfToken!;
      resp = await this.request(url, { ...init, headers }, { raw: opts.raw });
    }
    return resp;
  }

  /** 错误信息提取：优先 JSON 错误体，否则状态码 */
  private describeError(resp: XsResponse, action: string): string {
    const j = safeJson<Record<string, unknown>>(resp.body);
    const detail =
      j && typeof j['message'] === 'string'
        ? String(j['message'])
        : j && typeof j['error'] === 'string'
          ? String(j['error'])
          : resp.body.replace(/\s+/g, ' ').slice(0, 300);
    return `XS ${action} 失败（HTTP ${resp.status}）：${detail || '无错误详情'}`;
  }

  /** 断言 2xx 且返回体非空合法 JSON（写操作响应体可为空，如 204） */
  private assertOk(resp: XsResponse, action: string, allowEmpty = false): void {
    if (resp.status < 200 || resp.status >= 300) {
      throw new HanaBusinessError(this.describeError(resp, action));
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
      return safeJson<{ UserName?: string; Id?: string; Workspaces?: Array<{ Name?: string; Id?: string }> }>(resp.body) ?? {};
    }

    /**
     * POST /base/workspace：建立 workspace（XS 会话级，仓库写 inactive 版本的前置上下文）。
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
    if (resp.status === 404) {
      throw new HanaBusinessError(`对象不存在：${path}`);
    }
    this.assertOk(resp, `读取元数据 ${path}`);
    return safeJson<FileMeta>(resp.body) ?? ({} as FileMeta);
  }

  /** GET /base/file/<path>：文件正文（读设计时内容） */
  async fileContent(packageId: string, objectName: string): Promise<string> {
    const path = `${packageId}/${objectName}`;
    const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}`, { method: 'GET' });
    if (resp.status === 404) {
      throw new HanaBusinessError(`对象不存在：${path}`);
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
    const resp = await this.authed(
      `${this.restBase}/file/${encodePath(target)}/`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Slug: packageName,
        },
        body,
      },
    );
    this.assertOk(resp, `创建包 ${packageId}`);
    return safeJson<FileMeta>(resp.body) ?? ({} as FileMeta);
  }

  /**
   * PUT /base/file/<pkg>/<object>：写设计时文件（create-or-update）。
   * 实测契约（SPS08）：
   * - POST 到文件路径一律 400 "Bad Request Header or Body" → 统一用 PUT（无 If-Match 时可创建新对象）
   * - PUT 会顺带跑一次激活检查并把结果放响应体（CheckResult），失败为 202 Warning，不影响写入
   * - opts.activate → SapBackPack {"Activate":true}，激活失败为 HTTP 555 + error_msg 明细
   * - opts.ifMatch → 乐观锁；不匹配返回 412
   * - opts.workspace → SapBackPack {"Workspace":…}（实测本 SPS 不改变行为：合法模型照样自动激活）
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
      ...(Object.keys(sapBackPack).length > 0 ? { 'SapBackPack': JSON.stringify(sapBackPack) } : {}),
    };
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    const resp = await this.authed(
      `${this.restBase}/file/${encodePath(path)}`,
      {
        method: 'PUT',
        headers,
        body: content,
      },
    );
    // 乐观锁冲突（显式 If-Match 与服务端不符）：412 Precondition Failed。
    // 只认「带 If-Match 的 412」，避免激活失败等其他 4xx 被误分类。
    if (opts.ifMatch && resp.status === 412) {
      throw new HanaBusinessError(
        `写文件 ${path} 冲突：版本已被他人修改（If-Match 不匹配，HTTP 412）。${this.describeError(resp, '写文件')}`,
        '412',
      );
    }
    this.assertOk(resp, `写文件 ${path}`, true);
    return safeJson<FileMeta & { CheckResult?: WriteCheckResult }>(resp.body) ?? ({} as FileMeta);
  }

  /**
   * PUT + SapBackPack {"Check":true}：激活检查（Studio「Team > Check」同款动词）。
   * 【实测注意】本 SPS 上合法模型会在这次 PUT 中被**直接激活**（Activated=true）——
   * Check 不抑制激活，只把检查结果放进响应体。需要对原对象做无副作用校验时，
   * 调用方应把内容写到临时对象上再 checkFile 并删除临时对象。
   */
  async checkFile(packageId: string, objectName: string, content: string): Promise<CheckFileResult> {
    const path = `${packageId}/${objectName}`;
    const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/xml; charset=utf-8',
        'SapBackPack': JSON.stringify({ Check: true }),
      },
      body: content,
    });
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
    const msg = cr?.error_msg ?? cr?.errorMsg ?? (activated ? undefined : j?.Message);
    return {
      consistent: activated,
      message: activated ? undefined : (msg ? String(msg) : `校验未通过（HTTP ${resp.status}）`),
      errorCode: code !== undefined ? String(code) : undefined,
      raw: resp.body,
    };
  }

  /** DELETE /base/file/<path>：删除设计时对象/包（204 成功） */
  async deleteFile(packageId: string, objectName?: string, opts: { ifMatch?: string } = {}): Promise<XsResponse> {
    const path = objectName ? `${packageId}/${objectName}` : packageId;
    const headers: Record<string, string> = {};
    if (opts.ifMatch) headers['If-Match'] = opts.ifMatch;
    const resp = await this.authed(`${this.restBase}/file/${encodePath(path)}`, {
      method: 'DELETE',
      headers,
    });
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
      const resp = await this.authed(`${this.restBase}/xfer/export/${v}`, { method: 'GET' }, { raw: true });
      if (resp.status >= 200 && resp.status < 300 && resp.buffer && resp.buffer.subarray(0, 2).toString('ascii') === 'PK') {
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
   * 不注册为仓库对象；目录目标则正确落库为 **inactive** 设计对象（_SYS_REPO.INACTIVE_OBJECT 可见）。
   * POST（200 + Location）→ PUT <Location> 带 Content-Range: bytes 0-(n-1)/n → 201 + 'Upload finished'。
   */
  async importFile(
    packageId: string,
    fileName: string,
    content: Buffer | string,
    opts: { contentType?: string } = {},
  ): Promise<{ location: string; range?: string }> {
    const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const total = buf.length;
    const post = await this.authed(`${this.restBase}/xfer/import/${encodePath(packageId)}/`, {
      method: 'POST',
      headers: {
        Slug: fileName,
        'X-Xfer-Content-Length': String(total),
        'X-Xfer-Options': 'raw',
      },
    });
    // 发起步骤成功即 200 + Location 头（响应体可为空）
    this.assertOk(post, `发起导入 ${packageId}/${fileName}`, true);
    const location = post.headers['location'] ?? post.headers['contentlocation'];
    if (!location) {
      throw new HanaBusinessError(`XS 导入 ${packageId}/${fileName} 未返回上传 Location（HTTP ${post.status}）：${post.body.slice(0, 200)}`);
    }
    const uploadUrl = /^https?:\/\//i.test(location) ? location : `${this.baseUrl}${location}`;
    // 实测：文本内容必须显式声明 charset=utf-8——缺省时 XS 层按 Latin-1 解码请求体，
    // 中文等非 ASCII 描述会被双重编码成乱码
    const contentType = opts.contentType ?? (fileName.endsWith('.xml') || fileName.endsWith('.calculationview') ? 'application/xml; charset=utf-8' : 'application/octet-stream');
    const put = await this.authed(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Range': `bytes 0-${total - 1}/${total}`,
      },
      body: new Uint8Array(buf),
    });
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
  return path.split('/').map((s) => encodeURIComponent(s)).join('/');
}

/** 安全 JSON 解析（失败返回 undefined，不抛） */
function safeJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T;
  } catch {
    return undefined;
  }
}