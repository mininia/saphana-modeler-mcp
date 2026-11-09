// @sap/hana-client 为 CJS 模块且 exports 为动态赋值，ESM 命名/namespace 导入拿不到真实导出
// （cjs-module-lexer 静态检测失败，namespace 只有 default）。统一用 default 导入：运行时即 module.exports。
import hanaClient from '@sap/hana-client';
import type { HanaConfig } from '../config/config.js';
import { HanaBusinessError, normalizeHanaError } from './errors.js';
import {
  POOL_ACQUIRE_TIMEOUT_MS_DEFAULT,
  POOL_MAX_DEFAULT,
  POOL_MAX_WAITERS_DEFAULT,
  SQL_MAX_CELL_BYTES_DEFAULT,
  SQL_TIMEOUT_MS_DEFAULT,
} from './limits.js';

type Connection = hanaClient.Connection;
type ConnectionOptions = hanaClient.ConnectionOptions;
type HanaParameterList = hanaClient.HanaParameterList;

/**
 * 已持有连接与结果集类型（供服务层声明签名用）。
 * 服务层不应直接 import 驱动：驱动交互集中在本模块，这里只把类型转出去。
 */
export type HanaConnection = hanaClient.Connection;
export type HanaStatement = hanaClient.Statement;
export type HanaResultSet = hanaClient.ResultSet;

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

/**
 * 「调用方给出的语句超时」判定：只有**有限正数**才启用带超时的执行路径。
 * 其余取值（undefined / 0 / 负数 / NaN / Infinity）一律按未给处理，保持既有 conn.exec 行为——
 * 把非法值当"超时 0ms"之类的静默改义会直接打断正常调用。
 */
function positiveTimeoutMs(opts?: { timeoutMs?: number }): number | undefined {
  const t = opts?.timeoutMs;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : undefined;
}

/**
 * 连接存活判定（同步）。
 *
 * 驱动 d.ts 只把 Connection.isValid 声明成回调形态（`isValid(fn?): void`），但运行期无参调用
 * 是**同步返回布尔**的（本机实测：未连接对象返回 false）——类型面缺这个同步重载，故在此用最小
 * 接口把运行期契约写清楚。
 * 判定自身抛错视同失效（宁可丢一条可疑连接，也不把失效连接循环复用）；
 * 没有 isValid 的对象（如测试替身）不做判定、按存活处理，保持既有行为。
 */
interface SyncValidConnection {
  isValid(): boolean;
}
function connectionAlive(conn: Connection): boolean {
  const probe = conn as unknown as SyncValidConnection;
  if (typeof probe.isValid !== 'function') return true;
  try {
    return probe.isValid() === true;
  } catch {
    return false;
  }
}

/** 连接池可调参数（默认值面向「一个 MCP 服务实例服务多个 HTTP 客户端」的场景） */
export interface HanaPoolOptions {
  /** 连接并发上限（默认 POOL_MAX_DEFAULT=4；HANA_POOL_MAX） */
  max?: number;
  /**
   * 池满时的排队上限（默认 POOL_MAX_WAITERS_DEFAULT=64；HANA_POOL_MAX_WAITERS）：
   * 超出立即失败，防单客户端打满池后请求无限堆积
   */
  maxWaiters?: number;
  /**
   * 排队等待超时 ms（默认 POOL_ACQUIRE_TIMEOUT_MS_DEFAULT=30s；HANA_POOL_WAIT_MS）：
   * 到时仍未获得连接即失败，防单个慢查询把全部调用方无限期挂住
   */
  acquireTimeoutMs?: number;
  /**
   * 写路径语句超时 ms（默认 SQL_TIMEOUT_MS_DEFAULT=60s；HANA_SQL_TIMEOUT_MS）。
   * **不**作为全局默认：hana_sql_analyze（最长 5 分钟）与元数据搜索（5–30s）是合法长语句，
   * 全局设限会误杀它们——需要上限的调用点经 query/execute/execOn/callProcedure 的 opts 逐处传入。
   */
  statementTimeoutMs?: number;
}

/**
 * 简单 HANA 连接池（@sap/hana-client 原生驱动）：
 * - 懒连接：首次 acquire 才建连
 * - 池满时请求排队等待，但有**队列上限与等待超时**（HTTP 多客户端下，无界排队会让一个客户端的
 *   慢查询把其他客户端全部挂死；有界排队把「挂死」变成可解释的失败）
 * - 暴露 query/execute/withConnection/execOn 入口，service 层只用这几个
 *   （另有**已持有连接**上的执行原语 execStreamingOn / execPreparedOn，见文件末尾：
 *   真执行任意语句、限量取行与超时都在那里落地，服务层同样不得自己碰驱动）
 * - **连接存活检查**：acquire 命中空闲连接、release 归还连接时都经 connectionAlive
 *   （驱动 conn.isValid）判定；失效连接 disconnect 后丢弃——不进空闲队列、也不转交等待者
 *   （否则之后每个取到它的请求都会在第一条语句上莫名失败）。已知能造成这种连接的一条路径是
 *   PlanViz 通道（`EXECUTE PLANVIZ STATEMENT ID` 传错 id 会被 HANA 直接断开；`QUERY_ID_RE`
 *   会在拼接执行语句前先做形状校验）；丢弃后有等待者时改为现建一条交接，
 *   池容量不因一条死连接被永久占掉。
 */
export class HanaPool {
  private readonly options: ConnectionOptions;
  private readonly max: number;
  private readonly maxWaiters: number;
  private readonly acquireTimeoutMs: number;
  /** 写路径语句超时的默认来源（HANA_SQL_TIMEOUT_MS）；调用方也可经各入口的 opts.timeoutMs 逐条覆盖 */
  readonly statementTimeoutMs: number;
  private idle: Connection[] = [];
  private inUse = 0;
  private readonly waiters: Waiter[] = [];

  constructor(config: HanaConfig, opts: HanaPoolOptions = {}) {
    this.options = buildConnectionOptions(config);
    this.max = opts.max ?? POOL_MAX_DEFAULT;
    this.maxWaiters = opts.maxWaiters ?? POOL_MAX_WAITERS_DEFAULT;
    this.acquireTimeoutMs = opts.acquireTimeoutMs ?? POOL_ACQUIRE_TIMEOUT_MS_DEFAULT;
    this.statementTimeoutMs = opts.statementTimeoutMs ?? SQL_TIMEOUT_MS_DEFAULT;
  }

  /** 获取一个可用连接（池满则排队；队列满或等待超时以 HanaBusinessError 失败） */
  async acquire(): Promise<Connection> {
    // 空闲连接可能已在服务端被掐断：逐条判定，失效的断开丢弃后继续找下一条（有存活者就不建连）
    while (this.idle.length > 0) {
      const conn = this.idle.pop() as Connection;
      if (!connectionAlive(conn)) {
        void disconnectAsync(conn);
        continue;
      }
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

  /** 归还连接（存活检查；移交给下一个存活等待者，无等待者则入空闲队列） */
  release(conn: Connection): void {
    this.inUse--;
    if (!connectionAlive(conn)) {
      // 失效连接：断开后丢弃，不进空闲队列、也不转交等待者（转交只会让下一位再失败一次）
      void disconnectAsync(conn);
      // 丢弃使池空出一格：有等待者就现建一条交接，避免它们白等到 acquireTimeout
      this.serveWaiterWithFreshConnection();
      return;
    }
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

  /**
   * 丢弃失效连接后，给队首存活等待者现建一条连接（无等待者则什么都不做）。
   * 建连失败只拒绝该等待者（其余等待者继续等后续释放/超时），排队语义不变。
   */
  private serveWaiterWithFreshConnection(): void {
    let head = this.waiters.shift();
    while (head?.settled) head = this.waiters.shift();
    if (!head) return;
    const waiter = head; // const 收窄：下面的回调里 waiter 恒为定义
    this.inUse++;
    connectAsync(hanaClient.createConnection(), this.options).then(
      (fresh) => {
        if (waiter.settled) {
          // 等待者已超时退出：连接不能丢，按普通归还处理（交给下一位或入空闲队列）
          this.release(fresh);
          return;
        }
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(fresh);
      },
      (e) => {
        this.inUse--;
        if (waiter.settled) return;
        waiter.settled = true;
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.reject(e);
      },
    );
  }

  /**
   * 在**已持有连接**上执行一条语句（query / execute / execOn 三条入口共用的分派）：
   * opts.timeoutMs 为有限正数时走 execPreparedOn（prepare/exec + stmt.setTimeout，结束即 drop），
   * 否则保持既有的 conn.exec 一次往返。
   *
   * 两条路径的返回形状不同（超时路径恒为行数组；非超时路径 SELECT 给行数组、DDL/DML 给驱动结果
   * 对象），按调用方声明的 T 收窄：query 传 T[]；execOn 的既有调用点把 T 声明成行数组类型。
   */
  private async runOn<T>(
    conn: Connection,
    sql: string,
    params: HanaParameterList | undefined,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const timeoutMs = positiveTimeoutMs(opts);
    if (timeoutMs !== undefined) {
      return (await execPreparedOn(conn, sql, params ?? [], { timeoutMs })) as T;
    }
    return execAsync<T>(conn, sql, params);
  }

  /**
   * 执行查询并整体返回行（SELECT 语义；行数上限由调用方 SQL 保证）。
   * opts.timeoutMs 给出有限正数时改走 execPreparedOn（prepare/exec + stmt.setTimeout + drop），
   * 否则保持既有的 conn.exec 一次往返——**存量调用点不传第三参，行为与签名向后兼容**。
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: HanaParameterList,
    opts?: { timeoutMs?: number },
  ): Promise<T[]> {
    return this.withConnection((conn) => this.runOn<T[]>(conn, sql, params, opts));
  }

  /**
   * 执行 DDL/DML（非超时路径返回驱动结果对象，如 execReturnType）。
   * ⚠ 走超时路径（opts.timeoutMs）时返回的是 **T[]**——DDL/INSERT 得到空数组（execPreparedOn 的行数组形状）；
   * 两种形状对既有调用点无影响（它们都不使用返回值）。
   */
  async execute(sql: string, params?: HanaParameterList, opts?: { timeoutMs?: number }): Promise<unknown> {
    return this.withConnection((conn) => this.runOn(conn, sql, params, opts));
  }

  /**
   * 在**已持有的连接**上执行一条语句（配合 withConnection 使用）。
   *
   * 为什么需要它：有些操作要在一段连贯的会话里完成多步（例如 SQL 执行计划：EXPLAIN 写入后**立即**
   * 按语句名回读、用完再按名删除）。query/execute 各自 acquire 一条连接，多步之间可能被别的请求
   * 插入，也可能落到不同连接上，语义就不连贯了。
   *
   * 带 opts.timeoutMs（有限正数）时改走 execPreparedOn：语句超时落到 stmt.setTimeout 且结束即 drop；
   * 否则保持既有 conn.exec 行为。两种路径的运行时结果都是「行数组」（T 按既有调用点声明成行数组类型）。
   *
   * ⚠️ 持有 conn 期间**只能**走本方法，不可再调 query/execute：那会二次 acquire
   * （并发下互相等池位直至 acquireTimeout 失败）。
   */
  async execOn<T = Record<string, unknown>>(
    conn: Connection,
    sql: string,
    params?: HanaParameterList,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    return this.runOn<T>(conn, sql, params, opts);
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
   * opts.timeoutMs（有限正数）会设到语句上：REPOSITORY_REST 这类控制面调用一挂住就占着池位
   * （池上限 4），几个这样的请求就足以让全部工具调用排队超时，必须可设上限。
   *
   * 说明：这里直接 prepare/exec 而不是走 conn.exec 封装——OUT 参数必须在 exec 完成后
   * 从同一 stmt 上读回（getParameterValue），而 conn.exec 的回调只给行，拿不到语句对象。
   */
  async callProcedure(
    sql: string,
    inParams: HanaParameterList | undefined,
    outParamCount: number,
    opts?: { timeoutMs?: number },
  ): Promise<unknown[]> {
    const timeoutMs = positiveTimeoutMs(opts);
    const conn = await this.acquire();
    let stmt: HanaStatement | undefined;
    try {
      return await new Promise<unknown[]>((resolve, reject) => {
        // prepare 与 exec 的**同步**抛错必须归一化：语法 / REPOSITORY_REST 不存在 / 无 EXECUTE
        // 权限都在 prepare 阶段报，穿透出去会被工具层当成"未知错误"，调用方只看到「内部错误」，
        // code 与消息全丢——与 execPreparedOn 同口径
        try {
          stmt = conn.prepare(sql);
          const statement = stmt; // const 收窄：下面的回调里 statement 恒为定义
          const inCount = Array.isArray(inParams) ? inParams.length : inParams ? 1 : 0;
          const cb = (err: Error): void => {
            if (err) return reject(normalizeHanaError(err));
            try {
              const outs: unknown[] = [];
              for (let i = 0; i < outParamCount; i++) {
                const v = statement.getParameterValue(inCount + i);
                outs.push(Buffer.isBuffer(v) ? Buffer.from(v) : v);
              }
              resolve(outs);
            } catch (e) {
              reject(normalizeHanaError(e));
            }
          };
          if (timeoutMs !== undefined) {
            try {
              statement.setTimeout(timeoutMs);
            } catch (e) {
              // 同步抛错也要归一化（与 execPreparedOn 同口径），连接由外层 finally 归还
              reject(normalizeHanaError(e));
              return;
            }
          }
          if (inParams === undefined || inParams === null) statement.exec([], cb);
          else statement.exec(inParams as Array<string | number | boolean | Buffer | null>, cb);
        } catch (e) {
          reject(normalizeHanaError(e));
        }
      });
    } finally {
      // 与 execPreparedOn 同清理契约：无论成功/失败/超时，语句都 drop，不把句柄留在池连接上
      try {
        stmt?.drop();
      } catch {
        /* 释放语句失败无关结果 */
      }
      this.release(conn);
    }
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

  /**
   * 关闭全部空闲连接（进程退出时调用）并清空内存中的密码副本。
   * **环境切换不要用它**：它会擦除 pwd，池对象不可复用；切换用 closeIdle。
   */
  async closeAll(): Promise<void> {
    await this.closeIdle();
    // 凭据生命周期：连接池关闭后清除密码，避免常驻内存
    (this.options as ConnectionOptions & { pwd?: string }).pwd = '';
  }

  /**
   * 只关闭空闲连接，不清密码、不改变池对象可用性。
   * 用于环境切换/空闲回收：之后仍可 acquire 新建连接（密码还在 options 里）。
   */
  async closeIdle(): Promise<void> {
    await Promise.all(this.idle.splice(0).map((c) => disconnectAsync(c)));
  }

  /** 池状态（调试/测试用） */
  stats(): { idle: number; inUse: number; max: number; waiting: number } {
    return { idle: this.idle.length, inUse: this.inUse, max: this.max, waiting: this.waiters.length };
  }
}

// ── 已持有连接上的执行原语 ────────────────────────────────────────
//
// 为什么这两个函数**必须**在这里（而不是各服务自己写）：Statement/ResultSet 是驱动原语，
// 文件头已约定「驱动交互集中在本模块」。此前 sql-analyze.service 为了"真执行一条语句 + 限量取行"
// 直接调 conn.prepare / stmt.setTimeout / stmt.execQuery / rs.next / rs.close ——
// 那条路径（接受任意 SQL 文本并真执行）恰恰是最危险的一条，却绕过了本模块的全部护栏，
// 且 close/drop 的清理只存在于那个调用点的 finally 里（另一处调用就漏一套）。
// 收进本模块后：**护栏与驱动原语在同一处**，调用方只能整份拿走，拿不走半份。

/**
 * 流式执行的护栏参数。**两个字段都必填**：真执行一条任意语句必须有时间上限与取行上限，
 * 做成可选就等于把"跑飞"变成"可配置地跑飞"。
 */
export interface ExecStreamingOptions {
  /** 语句超时 ms（驱动 Statement.setTimeout）；控制面元数据调用请另给更小的值，不跟执行一起放宽 */
  timeoutMs: number;
  /** 最多拉取多少行即停止，并**立刻关闭结果集** */
  maxRows: number;
}

/** 流式执行的结果统计（**不含数据行**：本入口只计数，行内容一律不读不放） */
export interface ExecStreamingStats {
  /** 墙钟耗时（含 prepare 与取行） */
  wallClockMs: number;
  rowsFetched: number;
  /** 本次生效的取行上限（回显，便于调用方如实回报） */
  maxRows: number;
  /** 本次生效的语句超时（回显） */
  timeoutMs: number;
  /** 以下三个是服务端统计；驱动/服务端不给时**字段缺省**（不报 null） */
  serverProcessingTime?: number;
  serverCpuTime?: number;
  serverMemoryUsage?: number;
}

/**
 * 在**已持有的连接**上流式执行一条语句（配合 withConnection 使用，与 execOn 同为"已持有连接"用法）。
 *
 * 本方法自己保证的护栏（调用方**无法**绕过）：
 * - **超时**：opts.timeoutMs 经 stmt.setTimeout 生效（不设超时的执行会一直占着池位）；
 * - **取行上限**：最多 next 到 opts.maxRows 行即停止拉取，**提前关闭结果集**——
 *   一条没有 LIMIT 的 SELECT 足以把进程打爆，而调用方往往**不能**改写语句（改写就不是同一条语句了）；
 * - **不返回数据行**：行只计数、内容不读不放（要取数请走取数通道，本入口不成为数据出口）；
 * - **清理**：无论成功/失败/超时，finally 里 rs.close() + stmt.drop()，不留结果集与语句。
 *
 * 用 ResultSet 流式取行而不是 conn.exec：后者把全部结果一次拉回内存。
 * prepare（语法/对象/权限）与 next 的错误都经 normalizeHanaError 归一后抛出。
 */
export async function execStreamingOn(
  conn: Connection,
  sql: string,
  opts: ExecStreamingOptions,
): Promise<ExecStreamingStats> {
  const startedAt = Date.now();
  let stmt: HanaStatement | undefined;
  let rs: HanaResultSet | undefined;
  try {
    // prepare 就会解析对象与权限：语法错误 / 表不存在 / 无权限都在这里**同步**抛出。
    // 不放在 try 里会被调用方当成"未知错误"包装掉（只看到"内部错误"），与"失败一次给全"的约定相反。
    stmt = conn.prepare(sql);
    stmt.setTimeout(opts.timeoutMs);
    const statement = stmt;
    rs = await new Promise<HanaResultSet>((resolve, reject) => {
      // 参数显式标注：execQuery 有一个 `options: {[key: string]: any}` 重载，
      // 函数实参同时也匹配它，不标注就推断不出回调参数类型
      const onResult = (err: Error | null, resultSet?: HanaResultSet): void => {
        if (err) reject(normalizeHanaError(err));
        else if (!resultSet) reject(new HanaBusinessError('执行语句未返回结果集'));
        else resolve(resultSet);
      };
      statement.execQuery(onResult);
    });
    let rowsFetched = 0;
    const resultSet = rs;
    while (rowsFetched < opts.maxRows) {
      const hasNext = await new Promise<boolean>((resolve, reject) => {
        resultSet.next((err: Error | null, more?: boolean) =>
          err ? reject(normalizeHanaError(err)) : resolve(more === true),
        );
      });
      if (!hasNext) break;
      rowsFetched++; // 行数据丢弃：本入口只回报统计
    }
    const stat = (read: () => number): number | undefined => {
      try {
        const v = read();
        return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
      } catch {
        return undefined;
      }
    };
    const out: ExecStreamingStats = {
      wallClockMs: Date.now() - startedAt,
      rowsFetched,
      maxRows: opts.maxRows,
      timeoutMs: opts.timeoutMs,
    };
    const processing = stat(() => rs!.getServerProcessingTime());
    if (processing !== undefined) out.serverProcessingTime = processing;
    const cpu = stat(() => rs!.getServerCPUTime());
    if (cpu !== undefined) out.serverCpuTime = cpu;
    const memory = stat(() => rs!.getServerMemoryUsage());
    if (memory !== undefined) out.serverMemoryUsage = memory;
    return out;
  } catch (e) {
    // prepare / next 的同步或异步错误统一归一化（已归一化的原样返回）
    throw normalizeHanaError(e);
  } finally {
    try {
      rs?.close();
    } catch {
      /* 结果集关闭失败不掩盖原始错误 */
    }
    try {
      stmt?.drop();
    } catch {
      /* 同上 */
    }
  }
}

/**
 * 在**已持有的连接**上准备并执行一条语句，整体取回结果行（`{CALL ...}` 之类的控制面调用）。
 *
 * 与 execOn 的分工：execOn 缺省走 conn.exec（一条语句一次往返）；给出 opts.timeoutMs 时
 * 与本方法同路径（prepare/exec + setTimeout）。本方法恒走 prepare/exec（可带绑定参数、可设语句超时），
 * 并在 finally 里 drop 语句——
 * 控制面调用一挂住就会占着池位（池上限 4），几个这样的请求足以让全部工具调用排队超时。
 *
 * prepare（语法 / 对象不存在 / 无权限都在这一阶段同步抛出）与 exec 的同步抛错都经
 * normalizeHanaError 归一后抛出（与 execStreamingOn 同口径）——不归一就会被调用方当成
 * "未知错误"包装掉，调用方只看到「内部错误」，code 与消息全丢。
 */
export async function execPreparedOn<T = Record<string, unknown>>(
  conn: Connection,
  sql: string,
  params: HanaParameterList,
  opts: { timeoutMs: number },
): Promise<T[]> {
  let stmt: HanaStatement | undefined;
  try {
    // prepare 同 execStreamingOn：语法错误 / 表不存在 / 无权限都在这里**同步**抛出，必须收进
    // 归一范围（见函数头注），否则同一失败走 conn.exec 路径有 code、走本路径只剩「内部错误」
    stmt = conn.prepare(sql);
    const statement = stmt;
    return await new Promise<T[]>((resolve, reject) => {
      const onDone = (err: Error | null, rows?: T[]): void => {
        if (err) reject(normalizeHanaError(err));
        else resolve(rows ?? []);
      };
      try {
        statement.setTimeout(opts.timeoutMs);
        statement.exec<T[]>(params, onDone);
      } catch (e) {
        // 同步抛错也要归一化后 reject（不能让它穿透 Promise 执行器变成未捕获异常）
        reject(normalizeHanaError(e));
      }
    });
  } catch (e) {
    // prepare 的同步抛错与执行侧 reject 统一归一（已归一化的原样返回）
    throw normalizeHanaError(e);
  } finally {
    try {
      stmt?.drop();
    } catch {
      /* 释放语句失败无关结果 */
    }
  }
}

// ── hana_sql_execute 的执行原语 ─────────────────────────────────
//
// 与 execStreamingOn 的分工：那一条路只计数、不返回数据行（SQL 分析只需要统计）；
// 这里要把**列名 + 行**带回给调用方，因此额外承担：取行上限、累计字节上限、二进制单元格
// base64 包装（含单格上限）、bigint 转字符串。超时/清理契约与 execStreamingOn 完全一致：
// prepare 同步抛错归一化、finally 里 rs.close() + stmt.drop()。

/** `execLimitedOn` 的护栏参数（全部必填：任意 SQL 的执行必须有时间/行数/字节上限） */
export interface ExecLimitedOptions {
  /** 语句超时 ms（驱动 Statement.setTimeout） */
  timeoutMs: number;
  /** 最多返回多少行（取满后再探测一次是否还有下一行，据此如实标记 truncated） */
  maxRows: number;
  /** 返回结果的累计字节上限（估算：字符串按 UTF-8 字节、二进制按 base64 长度） */
  maxResultBytes: number;
  /** 单个二进制单元格最多带出多少原始字节（默认 SQL_MAX_CELL_BYTES_DEFAULT） */
  maxCellBytes?: number;
}

/** 二进制列的包装形态（JSON 无法直接表达 Buffer） */
export interface BinaryCellValue {
  type: 'binary';
  base64: string;
  /** 原始字节数（即使被单格上限截断也如实给原长） */
  bytes: number;
  /** true = 原始值超过单格上限，只带出了前 maxCellBytes 字节 */
  truncated: boolean;
}

export interface ExecLimitedResult {
  columns: string[];
  /** 行数组，与 columns 对齐（不用对象键：重复列名会互相覆盖） */
  rows: unknown[][];
  /** 实际返回的行数 */
  rowsFetched: number;
  truncated: boolean;
  truncationReason?: 'max-rows' | 'max-bytes';
  /** 累计估算字节数 */
  bytes: number;
  wallClockMs: number;
  maxRows: number;
  maxResultBytes: number;
  timeoutMs: number;
}

/** 回调式 ResultSet.next 的 Promise 包装 */
function nextAsync(rs: HanaResultSet): Promise<boolean> {
  return new Promise((resolve, reject) => {
    rs.next((err: Error | null, more?: boolean) => (err ? reject(normalizeHanaError(err)) : resolve(more === true)));
  });
}

/**
 * 回调式 ResultSet.getValues 的 Promise 包装。
 * 含 LOB 列时同步 `getValues()` 会阻塞事件循环（驱动自身的 `getValuesCanBlock()` 正是为此提供），
 * 单进程 HTTP 下会把所有并发客户端一起卡住；此时改用异步重载逐行取值。
 */
function getValuesAsync(rs: HanaResultSet): Promise<unknown> {
  return new Promise((resolve, reject) => {
    rs.getValues((err: Error | null, values?: unknown) => (err ? reject(normalizeHanaError(err)) : resolve(values)));
  });
}

/** 单个值 → 可 JSON 序列化的值 + 估算字节数 */
function normalizeCell(value: unknown, maxCellBytes: number): { value: unknown; bytes: number } {
  if (Buffer.isBuffer(value)) {
    const cut = value.length > maxCellBytes ? value.subarray(0, maxCellBytes) : value;
    const cell: BinaryCellValue = {
      type: 'binary',
      base64: cut.toString('base64'),
      bytes: value.length,
      truncated: value.length > maxCellBytes,
    };
    return { value: cell, bytes: cell.base64.length + 48 };
  }
  // 驱动对大整数可能给 bigint；JSON.stringify 对 bigint 直接抛错
  if (typeof value === 'bigint') return { value: value.toString(), bytes: 24 };
  if (value instanceof Date) return { value: value.toISOString(), bytes: 28 };
  if (typeof value === 'string') return { value, bytes: Buffer.byteLength(value, 'utf8') + 2 };
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return { value, bytes: 8 };
  }
  try {
    const json = JSON.stringify(value);
    return { value, bytes: json === undefined ? 8 : Buffer.byteLength(json, 'utf8') };
  } catch {
    // 循环引用等病态值：退化为字符串，保证结果可序列化
    return { value: String(value), bytes: 32 };
  }
}

/**
 * 在**已持有的连接**上流式执行一条 SELECT：返回列名 + 限量行。
 *
 * - 行数上限：取满 `maxRows` 后**再探测一次 next**（不读值）——据此区分“恰好 N 行”与“还有更多”；
 *   有更多则标记 truncated=true 并立刻关闭结果集；
 * - 字节上限：累计估算字节超过 `maxResultBytes` 时丢弃当前行并停止，标记 truncated（reason=max-bytes）；
 * - 二进制：Buffer → `{ type:'binary', base64, bytes, truncated }`，单格超过 maxCellBytes 只带前缀；
 * - LOB：`getValuesCanBlock()` 为 true 时走异步取值，避免同步读取 LOB 阻塞事件循环；
 * - bigint → 字符串；Date → ISO 字符串；
 * - 清理：无论成功/失败/超时，finally 里 rs.close() + stmt.drop()。
 */
export async function execLimitedOn(
  conn: Connection,
  sql: string,
  opts: ExecLimitedOptions,
): Promise<ExecLimitedResult> {
  const startedAt = Date.now();
  const maxCellBytes = opts.maxCellBytes ?? SQL_MAX_CELL_BYTES_DEFAULT;
  let stmt: HanaStatement | undefined;
  let rs: HanaResultSet | undefined;
  try {
    // prepare 的同步抛错必须收进归一化范围（语法/对象不存在/无权限都在这一阶段）
    stmt = conn.prepare(sql);
    stmt.setTimeout(opts.timeoutMs);
    const statement = stmt;
    rs = await new Promise<HanaResultSet>((resolve, reject) => {
      const onResult = (err: Error | null, resultSet?: HanaResultSet): void => {
        if (err) reject(normalizeHanaError(err));
        else if (!resultSet) reject(new HanaBusinessError('执行语句未返回结果集'));
        else resolve(resultSet);
      };
      statement.execQuery(onResult);
    });
    const resultSet = rs;
    const columns = resultSet.getColumnInfo().map((c) => c.columnName);
    // 统一按列顺序取值（对象形态在重复列名下会覆盖；数组与 columns 一一对应）
    resultSet.setAsArrayDefault(true);

    const rows: unknown[][] = [];
    let bytes = 0;
    let truncated = false;
    let truncationReason: 'max-rows' | 'max-bytes' | undefined;
    while (rows.length < opts.maxRows) {
      const hasNext = await nextAsync(resultSet);
      if (!hasNext) break;
      // 测试替身可能没有该方法（真实驱动一定有）；缺失时按同步取值处理，保持旧行为。
      const canBlock = typeof resultSet.getValuesCanBlock === 'function' && resultSet.getValuesCanBlock() === true;
      const raw = canBlock ? await getValuesAsync(resultSet) : resultSet.getValues<unknown>();
      const values = Array.isArray(raw) ? raw : columns.map((name) => (raw as Record<string, unknown> | null)?.[name]);
      const cells = values.map((v) => normalizeCell(v, maxCellBytes));
      const rowBytes = cells.reduce((sum, c) => sum + c.bytes, 0);
      if (bytes + rowBytes > opts.maxResultBytes) {
        truncated = true;
        truncationReason = 'max-bytes';
        break; // 当前行不放进去（宁可少一行，也不让结果超预算）
      }
      rows.push(cells.map((c) => c.value));
      bytes += rowBytes;
    }
    // 行数上限：再探一行（只判存在、不读值）才能如实说“恰好 N 行”还是“还有更多”
    if (!truncated && rows.length >= opts.maxRows) {
      const hasMore = await nextAsync(resultSet);
      if (hasMore) {
        truncated = true;
        truncationReason = 'max-rows';
      }
    }
    return {
      columns,
      rows,
      rowsFetched: rows.length,
      truncated,
      ...(truncationReason !== undefined ? { truncationReason } : {}),
      bytes,
      wallClockMs: Date.now() - startedAt,
      maxRows: opts.maxRows,
      maxResultBytes: opts.maxResultBytes,
      timeoutMs: opts.timeoutMs,
    };
  } catch (e) {
    throw normalizeHanaError(e);
  } finally {
    try {
      rs?.close();
    } catch {
      /* 结果集关闭失败不掩盖原始错误 */
    }
    try {
      stmt?.drop();
    } catch {
      /* 同上 */
    }
  }
}

export interface ExecUpdateOptions {
  /** 语句超时 ms */
  timeoutMs: number;
}

export interface ExecUpdateResult {
  /** DML 返回影响行数（驱动 exec 给数字）；DDL 通常没有该字段 */
  affectedRows?: number;
  wallClockMs: number;
  timeoutMs: number;
}

/**
 * 在**已持有的连接**上执行一条 DML/DDL：prepare → setTimeout → stmt.exec。
 * 驱动对 DML 的 exec 回调返回数字（影响行数）；DDL 可能返回 undefined/对象，此时不编造 0。
 * 失败也 drop 语句；错误归一化（prepare 同步抛错同样归一）。
 */
export async function execUpdateOn(conn: Connection, sql: string, opts: ExecUpdateOptions): Promise<ExecUpdateResult> {
  const startedAt = Date.now();
  let stmt: HanaStatement | undefined;
  try {
    stmt = conn.prepare(sql);
    const statement = stmt;
    const result = await new Promise<unknown>((resolve, reject) => {
      const onDone = (err: Error | null, res?: unknown): void => {
        if (err) reject(normalizeHanaError(err));
        else resolve(res);
      };
      try {
        statement.setTimeout(opts.timeoutMs);
        statement.exec(onDone);
      } catch (e) {
        // 同步抛错也要归一化后 reject（不能让它穿透 Promise 执行器变成未捕获异常）
        reject(normalizeHanaError(e));
      }
    });
    const affectedRows =
      typeof result === 'number'
        ? result
        : result !== null &&
            typeof result === 'object' &&
            typeof (result as { affectedRows?: unknown }).affectedRows === 'number'
          ? (result as { affectedRows: number }).affectedRows
          : undefined;
    return {
      ...(affectedRows !== undefined ? { affectedRows } : {}),
      wallClockMs: Date.now() - startedAt,
      timeoutMs: opts.timeoutMs,
    };
  } catch (e) {
    throw normalizeHanaError(e);
  } finally {
    try {
      stmt?.drop();
    } catch {
      /* 释放语句失败无关结果 */
    }
  }
}

/** 事务包装的结局（**不抛错**：失败与回滚状态一并带回，服务层据此如实回报再决定是否上抛） */
export type TransactionOutcome<T> =
  | { ok: true; value: T; rolledBack: false; autoCommitRestored: boolean }
  | { ok: false; error: HanaBusinessError; rolledBack: boolean; autoCommitRestored: boolean };

/** 回调式 commit/rollback/setAutoCommit 的 Promise 包装 */
function commitAsync(conn: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.commit((err: Error | null) => (err ? reject(normalizeHanaError(err)) : resolve()));
  });
}

function rollbackAsync(conn: Connection): Promise<void> {
  return new Promise((resolve, reject) => {
    conn.rollback((err: Error | null) => (err ? reject(normalizeHanaError(err)) : resolve()));
  });
}

function setAutoCommitAsync(conn: Connection, flag: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    try {
      conn.setAutoCommit(flag);
      resolve();
    } catch (e) {
      reject(normalizeHanaError(e));
    }
  });
}

/**
 * 在**同一条池连接**上执行一段事务：setAutoCommit(false) → fn → commit；
 * fn/commit 失败 → rollback；**finally 一定恢复 setAutoCommit(true)**——
 * 绝不能把 autoCommit=false 的连接还给池（下一个借用者会在不知情的情况下把写入挂在未提交事务里）。
 *
 * 返回值带 `rolledBack` / `autoCommitRestored`：调用方必须如实回报（DDL 在 HANA 可能隐式提交，
 * 回滚不保证撤销其效果——这由服务层的回执文案说明，不在这里假装成功）。
 */
export async function withTransactionOn<T>(conn: Connection, fn: () => Promise<T>): Promise<TransactionOutcome<T>> {
  try {
    await setAutoCommitAsync(conn, false);
  } catch (e) {
    // autoCommit 状态未知：这条连接不能再还给池（否则下一个借用者可能在不知情的事务里写入）
    await disconnectAsync(conn);
    throw e;
  }
  type Body = { ok: true; value: T; rolledBack: false } | { ok: false; error: HanaBusinessError; rolledBack: boolean };
  let outcome: Body;
  try {
    const value = await fn();
    await commitAsync(conn);
    outcome = { ok: true, value, rolledBack: false };
  } catch (e) {
    let rolledBack = false;
    try {
      await rollbackAsync(conn);
      rolledBack = true;
    } catch {
      /* 回滚失败：rolledBack=false 如实带回，不掩盖原始错误 */
    }
    outcome = { ok: false, error: normalizeHanaError(e), rolledBack };
  }
  let autoCommitRestored = true;
  try {
    await setAutoCommitAsync(conn, true);
  } catch {
    // 连接可能已不可用：标记后由池的存活检查决定丢弃；服务层据此给 warning
    autoCommitRestored = false;
  }
  if (!autoCommitRestored) {
    // 不能把 autoCommit=false 的连接还给池：主动断开，release 的 isValid 检查会丢弃它
    // （而不是仅靠“可能不可用”的假设——isValid=true 并不代表事务状态已恢复）。
    await disconnectAsync(conn);
  }
  return { ...outcome, autoCommitRestored };
}
