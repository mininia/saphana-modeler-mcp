import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * 请求级身份上下文（AsyncLocalStorage）。
 *
 * 背景：stdio 传输是「一个进程一个客户端」，HTTP 传输是「一个进程多个客户端」——后者需要把
 * 「本次调用属于哪个客户端」透传到工具层/服务层/日志，而工具回调签名里只有业务入参，
 * 没有请求维度。用 ALS 承载，免去逐层穿参；服务层与日志按「有则附、无则省」处理，
 * stdio 模式下不产生任何额外字段（保持既有 envelope 形态）。
 *
 * 注意：仅用于身份归因（审计/日志/envelope.clientId），不承载 HANA 凭据——
 * 数据库身份仍是进程级单一技术账号（见 config.user）。
 */
export interface RequestIdentity {
  /** 客户端身份名（HTTP：MCP_HTTP_TOKENS 映射；未配置任何 Token 时为 anonymous） */
  clientId: string;
  /** 传输通道（审计用：区分本地 stdio 与远程 HTTP） */
  transport: 'http' | 'stdio';
  /**
   * 调用方档案名（P10-c）：来自 MCP_HTTP_TOKENS 第三段，或 stdio 进程的 MCP_PROFILE。
   * 未配 MCP_PROFILES 时缺省（= 隐式 default，不收紧任何权限）。
   */
  profileId?: string;
}

const storage = new AsyncLocalStorage<RequestIdentity>();

/**
 * 进程级归因标签（`MCP_AGENT_LABEL`）：一进程一个值，随 envelope 与日志落地。
 *
 * 为什么是模块级而不是请求级：它标的是"这条记录来自哪套部署/哪个代理进程"，
 * 与具体请求无关（HTTP 多客户端共享同一进程时，它标识的是**服务端进程**而非调用方）。
 * 与 `RequestIdentity` 分开存，避免 stdio 模式（无身份上下文）拿不到它。
 */
let processAgentLabel: string | undefined;

/** 设置进程级归因标签（启动时由 config 注入；空串 = 清除）。供测试隔离使用。 */
export function setProcessAgentLabel(label: string | undefined): void {
  const trimmed = (label ?? '').trim();
  processAgentLabel = trimmed === '' ? undefined : trimmed;
}

/** 在身份上下文中运行 fn（HTTP 请求入口调用；fn 内发起的异步续体自动继承该上下文） */
export function runWithIdentity<T>(identity: RequestIdentity, fn: () => T): T {
  return storage.run(identity, fn);
}

/** 当前请求身份（stdio 模式或未进入上下文时为 undefined） */
export function currentIdentity(): RequestIdentity | undefined {
  return storage.getStore();
}

/** 当前客户端身份名（审计日志/envelope 用；无身份上下文时 undefined） */
export function currentClientId(): string | undefined {
  return storage.getStore()?.clientId;
}

/** 当前进程级归因标签（未设置时 undefined——此时 envelope 与日志都不产生该字段） */
export function currentAgentLabel(): string | undefined {
  return processAgentLabel;
}
