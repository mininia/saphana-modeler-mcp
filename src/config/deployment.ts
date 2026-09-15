/**
 * 部署不变量（纯叶子模块：无依赖、无 I/O）——启动期「配置组合是否自洽」的判定规则。
 *
 * 借鉴 tableau-mcp（github.com/tableau/tableau-mcp）在 Config 构造期直接 throw 的做法：
 * 单项配置各自合法，**组合起来却构成安全暴露**的情况，必须在启动时就拒绝，
 * 而不是留一条 warn 让服务带着敞口跑起来。其典型例子是
 * `TRANSPORT=http` 必须配 `OAUTH_ISSUER`，否则 throw（除非显式 DANGEROUSLY_DISABLE_OAUTH=true）。
 *
 * 本模块只放规则（纯函数），调用方：
 * - 预检层 preflight.ts：解析出生效姿态后据此产出不变量结论（启动自检 / 报告）
 * - http.ts：复用 isLoopbackHost 判定监听地址
 *
 * 为什么单独成模块：写边界有 write-boundary.ts，部署姿态也该有自己的规则叶子，
 * 避免判定散落在启动入口、HTTP 层与预检层三处各写一遍。
 */

/** 回环地址判定（"仅本机可达" = 无认证时的访问边界） */
export const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

/** 监听地址是否仅本机可达 */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host.trim().toLowerCase());
}

/** 显式承认"对外监听且不认证"风险的开关名（对照 tableau-mcp 的 DANGEROUSLY_* 约定） */
export const ALLOW_ANONYMOUS_ENV = 'MCP_HTTP_ALLOW_ANONYMOUS';

/** 部署姿态：与"权限"有关的连接侧配置 */
export interface DeploymentPosture {
  /** HTTP 传输端口；undefined = stdio 传输（不对外监听） */
  httpPort?: number;
  /** HTTP 监听地址 */
  httpHost: string;
  /** 是否配置了任何 Bearer Token（MCP_HTTP_TOKEN / MCP_HTTP_TOKENS） */
  tokenConfigured: boolean;
  /** 是否显式承认"对外监听且不认证"（MCP_HTTP_ALLOW_ANONYMOUS=true） */
  allowAnonymous: boolean;
  /** 连接是否 TLS 加密（HANA_TLS，默认 true） */
  tls: boolean;
  /** TLS 下是否校验证书（HANA_SSL_VALIDATE，默认 true） */
  sslValidate: boolean;
}

/** 部署不变量结论 */
export interface DeploymentInvariant {
  code: 'http_exposed_without_auth' | 'tls_plaintext' | 'encrypted_but_unauthenticated';
  /** block = 拒绝启动；warn = 放行但必须显式可见 */
  severity: 'block' | 'warn';
  /**
   * 事实陈述：哪里不自洽、后果是什么。
   * **不得包含补救指引**——本字段可能随请求响应返回给调用方（通常是模型），
   * 写明"改哪项配置可放行"等于把绕过方法交给被拦的一方。
   */
  message: string;
  /** 补救指引：**只面向运维**（服务启动自检 / README），不得进入请求响应 */
  remedy?: string;
  /** 显式豁免该项所需的环境变量（同样只面向运维） */
  override?: string;
}

/**
 * 检查部署姿态的不变量。
 * 空数组 = 无问题。`severity: 'block'` 的项应当阻止启动（调用方决定如何处置）。
 */
export function checkDeploymentInvariants(posture: DeploymentPosture): DeploymentInvariant[] {
  const out: DeploymentInvariant[] = [];

  // 对外监听 + 无任何凭据 = 任何可达者都能调用全部工具（含写操作），且调用无法归因。
  // 这是最严重的一种：写边界、工具分组、schema 白名单全部形同虚设。默认 host 是 127.0.0.1，
  // 因此只有显式改成非回环地址才会触发——那一定是"要让外部访问"的有意配置，必须同时上认证。
  if (
    posture.httpPort != null &&
    !isLoopbackHost(posture.httpHost) &&
    !posture.tokenConfigured &&
    !posture.allowAnonymous
  ) {
    out.push({
      code: 'http_exposed_without_auth',
      severity: 'block',
      message:
        `HTTP 监听地址为 "${posture.httpHost}"（非回环 = 对外可达），且未配置任何 Bearer Token：` +
        '任何能连上该端口的人都能调用全部工具（含写操作），且调用无法归因。',
      remedy:
        '请配置 MCP_HTTP_TOKEN 或 MCP_HTTP_TOKENS、将监听地址改回 127.0.0.1，' +
        '或将其置于带认证的反向代理之后',
      override: ALLOW_ANONYMOUS_ENV,
    });
  }

  // 明文连接：HANA_TLS 默认 true（fail-closed），显式置 false 属有意为之（可信网络/自签环境），
  // 不阻断启动，但要让它在启动日志里可见——凭据与数据都走明文。
  if (!posture.tls) {
    out.push({
      code: 'tls_plaintext',
      severity: 'warn',
      message: 'HANA_TLS=false：连接未加密，凭据与查询数据以明文传输。',
      remedy: '仅在确认链路可信（如本机/隔离网）时使用',
    });
  } else if (!posture.sslValidate) {
    // 加密但不校验证书 = 可被中间人替换证书，加密了但没认证对端
    out.push({
      code: 'encrypted_but_unauthenticated',
      severity: 'warn',
      message: 'HANA_SSL_VALIDATE=false：连接已加密但未校验服务器证书，无法防中间人替换证书。',
      remedy: '仅应在内网自签证书环境使用',
    });
  }

  return out;
}
