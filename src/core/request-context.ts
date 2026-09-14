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
}

const storage = new AsyncLocalStorage<RequestIdentity>();

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
