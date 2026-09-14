// @sap/hana-client 为 CJS 模块且 exports 为动态赋值，ESM 命名/namespace 导入拿不到真实导出
// （cjs-module-lexer 静态检测失败，namespace 只有 default）。统一用 default 导入：运行时即 module.exports。
import hanaClient from '@sap/hana-client';
import type { HanaConfig } from '../config/config.js';
import { HanaBusinessError, normalizeHanaError } from './errors.js';

type Connection = hanaClient.Connection;
type ConnectionOptions = hanaClient.ConnectionOptions;
type HanaParameterList = hanaClient.HanaParameterList;

/** 连接参数（security：真实凭据仅来自 config，不落日志） */
function buildConnectionOptions(config: HanaConfig): ConnectionOptions {
  return {
    serverNode: `${config.host}:${config.port}`,
    uid: config.user,
    pwd: config.password,
    ...(config.dbName ? { databaseName: config.dbName } : {}),
    locale: config.locale,
    encrypt: config.tls,
    // 证书校验与 TLS 解耦：TLS 开启时默认校验证书（防 MITM 替换自签证书）；
    // 内网自签证书环境需显式 HANA_SSL_VALIDATE=false 跳过，而非无条件关闭
    sslValidateCertificate: config.tls ? config.sslValidate : false,
    connectTimeout: 15_000,
    autoCommit: true,
  };
}

/** 回调式 connect 的 Promise 包装 */
function connectAsync(conn: Connection, options: ConnectionOptions): Promise<Connection> {
  return new Promise((resolve, reject) => {
    conn.connect(options, (err) => (err ? reject(normalizeHanaError(err)) : resolve(conn)));
  });
}

/** 回调式 exec 的 Promise 包装（SELECT → 行数组；DDL/DML → 结果对象） */
function execAsync<T>(conn: Connection, sql: string, params?: HanaParameterList): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = (err: Error, results?: T): void => (err ? reject(normalizeHanaError(err)) : resolve(results as T));
    if (params !== undefined && params !== null) conn.exec<T>(sql, params, cb);
    else conn.exec<T>(sql, cb);
  });
}

/** 回调式 disconnect 的 Promise 包装（忽略断开错误） */
function disconnectAsync(conn: Connection): Promise<void> {
  return new Promise((resolve) => {
    try {
      conn.disconnect(() => resolve());
    } catch {
      resolve();
    }
  });
}

/** 池内等待者（持有定时器与「已了结」标记，供超时退出与连接移交判定） */
interface Waiter {
  resolve: (conn: Connection) => void;
  reject: (e: Error) => void;
  /** true = 已超时退出或已被移交连接；release 据此跳过僵尸等待者，避免连接丢失 */
  settled: boolean;
  timer?: NodeJS.Timeout;
}

/** 连接池可调参数（默认值面向「一个 MCP 服务实例服务多个 HTTP 客户端」的场景） */
export interface HanaPoolOptions {
  /** 连接并发上限（默认 4） */
  max?: number;
  /** 池满时的排队上限（默认 64）：超出立即失败，防单客户端打满池后请求无限堆积 */
  maxWaiters?: number;
  /** 排队等待超时 ms（默认 30s）：到时仍未获得连接即失败，防单个慢查询把全部调用方无限期挂住 */
  acquireTimeoutMs?: number;
}

/**
 * 简单 HANA 连接池（@sap/hana-client 原生驱动）：
 * - 懒连接：首次 acquire 才建连；连接失效时自动重建一次
 * - 池满时请求排队等待，但有**队列上限与等待超时**（HTTP 多客户端下，无界排队会让一个客户端的
 *   慢查询把其他客户端全部挂死；有界排队把「挂死」变成可解释的失败）
 * - 暴露 query/execute/withConnection 三个入口，service 层只用这几个
 */
export class HanaPool {
  private readonly options: ConnectionOptions;
  private readonly max: number;
  private readonly maxWaiters: number;
  private readonly acquireTimeoutMs: number;
  private idle: Connection[] = [];
  private inUse = 0;
  private readonly waiters: Waiter[] = [];

  constructor(config: HanaConfig, opts: HanaPoolOptions = {}) {
    this.options = buildConnectionOptions(config);
    this.max = opts.max ?? 4;
    this.maxWaiters = opts.maxWaiters ?? 64;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? 30_000;
  }

  /** 获取一个可用连接（池满则排队；队列满或等待超时以 HanaBusinessError 失败） */
  async acquire(): Promise<Connection> {
    if (this.idle.length > 0) {
      const conn = this.idle.pop() as Connection;
      this.inUse++;
      return conn;
    }
    if (this.inUse < this.max) {
      this.inUse++;
      try {
        return await connectAsync(hanaClient.createConnection(), this.options);
      } catch (e) {
        this.inUse--;
        throw e;
      }
    }
    // 池满：排队（有界 + 超时）
    if (this.waiters.length >= this.maxWaiters) {
      throw new HanaBusinessError(
        `HANA 连接池繁忙：等待队列已满（${this.waiters.length} 个请求在排队，池上限 ${this.max} 个连接）。请降低并发或稍后重试`,
      );
    }
    return new Promise<Connection>((resolve, reject) => {
      const waiter: Waiter = { resolve, reject, settled: false };
      waiter.timer = setTimeout(() => {
        if (waiter.settled) return;
        waiter.settled = true;
        // 自我摘除，避免占用队列名额与后续无谓的移交尝试
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        reject(
          new HanaBusinessError(
            `HANA 连接池等待超时（${this.acquireTimeoutMs}ms）：${this.max} 个连接全部被占满（可能有长查询在跑）。请稍后重试或降低并发`,
          ),
        );
      }, this.acquireTimeoutMs);
      // 不因等待定时器而阻止进程退出（退出流程由 index.ts 的 exit 钩子收尾）
      waiter.timer.unref?.();
      this.waiters.push(waiter);
    });
  }

  /** 归还连接（移交给下一个存活等待者，无等待者则入空闲队列） */
  release(conn: Connection): void {
    this.inUse--;
    for (;;) {
      const next = this.waiters.shift();
      if (!next) {
        this.idle.push(conn);
        return;
      }
      // 已超时退出的等待者：跳过并把连接继续传给下一位（否则连接就此丢失、池容量泄漏）
      if (next.settled) continue;
      next.settled = true;
      if (next.timer) clearTimeout(next.timer);
      this.inUse++;
      next.resolve(conn);
      return;
    }
  }

  /** 执行查询并整体返回行（SELECT 语义；行数上限由调用方 SQL 保证） */
  async query<T = Record<string, unknown>>(sql: string, params?: HanaParameterList): Promise<T[]> {
    return this.withConnection((conn) => execAsync<T[]>(conn, sql, params));
  }

  /** 执行 DDL/DML（返回驱动结果对象，如 execReturnType） */
  async execute(sql: string, params?: HanaParameterList): Promise<unknown> {
    return this.withConnection((conn) => execAsync(conn, sql, params));
  }

  /**
   * 调用带 OUT/INOUT 参数的存储过程并读回输出参数。
   *
   * 驱动约定（@sap/hana-client 实测）：
   * - SQL 文本中 IN/OUT 全部写 ? 占位；绑定数组**只传 IN 参数**（OUT 参数不得入绑定数组，
   *   否则驱动报 "Too many parameters" code=-20013）；
   * - 执行成功后用 stmt.getParameterValue(i)（i 从 0 起）读回输出参数。
   * 适配 HANA 内置过程（如 SYS.REPOSITORY_REST(IN BLOB, OUT BLOB)）。
   *
   * 说明：hana-client 没有暴露 stmt 对象到 withConnection 之外，这里单独建连接完成调用。
   */
  async callProcedure(
    sql: string,
    inParams: HanaParameterList | undefined,
    outParamCount: number,
  ): Promise<unknown[]> {
    const conn = await this.acquire();
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        const stmt = conn.prepare(sql);
        const cb = (err: Error): void => {
          if (err) return reject(normalizeHanaError(err));
          try {
            const outs: unknown[] = [];
            for (let i = 0; i < outParamCount; i++) {
              const v = stmt.getParameterValue(inCount + i);
              outs.push(Buffer.isBuffer(v) ? Buffer.from(v) : v);
            }
            resolve(outs);
          } catch (e) {
            reject(normalizeHanaError(e));
          }
        };
        const inCount = Array.isArray(inParams) ? inParams.length : inParams ? 1 : 0;
        if (inParams === undefined || inParams === null) stmt.exec([], cb);
        else stmt.exec(inParams as Array<string | number | boolean | Buffer | null>, cb);
      });
    } finally {
      this.release(conn);
    }
  }

  /** 事务性执行：fn 内做多步操作，全部成功 commit，异常 rollback（MCP 写操作用） */
  async withTransaction<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    return this.withConnection(async (conn) => {
      conn.setAutoCommit(false);
      try {
        const result = await fn(conn);
        await new Promise<void>((resolve, reject) =>
          conn.commit((err) => (err ? reject(normalizeHanaError(err)) : resolve())),
        );
        return result;
      } catch (e) {
        try {
          conn.rollback(() => undefined);
        } catch {
          /* 回滚失败不掩盖原始错误 */
        }
        throw e;
      } finally {
        conn.setAutoCommit(true);
      }
    });
  }

  /** 统一获取-执行-归还 */
  async withConnection<T>(fn: (conn: Connection) => Promise<T>): Promise<T> {
    const conn = await this.acquire();
    try {
      return await fn(conn);
    } finally {
      this.release(conn);
    }
  }

  /** 关闭全部空闲连接（进程退出时调用）并清空内存中的密码副本 */
  async closeAll(): Promise<void> {
    await Promise.all(this.idle.splice(0).map((c) => disconnectAsync(c)));
    // 凭据生命周期：连接池关闭后清除密码，避免常驻内存
    (this.options as ConnectionOptions & { pwd?: string }).pwd = '';
  }

  /** 池状态（调试/测试用） */
  stats(): { idle: number; inUse: number; max: number; waiting: number } {
    return { idle: this.idle.length, inUse: this.inUse, max: this.max, waiting: this.waiters.length };
  }
}
