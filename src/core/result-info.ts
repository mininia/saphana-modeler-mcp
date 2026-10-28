/**
 * 统一截断契约 `resultInfo`（P0-1）与空集语义（P0-2）的**唯一实现**。
 *
 * 规则（对齐 Tableau v4.29 的定调：「返回结果少于匹配数时，必须说出来」）：
 * - 无 limit / cap 生效 → **不出现** `resultInfo`（没有"可能被截断"这回事，就不加噪音字段）；
 * - 调用方显式给的 limit 截断 → `truncationReason='requested-limit'`；
 * - 服务端默认 limit / 上限钳制 / 候选与节点上限 → `'server-cap'`；
 * - 固定安全上限（如分析行数硬顶）→ `'safety-cap'`，调用方要能在 `messages` 里看到稳定码；
 * - **恰好 N 条不等于截断**：知道总数时用 `totalAvailable > returnedCount` 判定；
 *   不知道总数时（如预览的 n+1 探测失败）才按"取满上限"判真；
 * - **空集不是截断**：`returnedCount=0` 时 truncated 恒为 false（P0-2）。
 *
 * 落点：服务层用 {@link attachResultInfo} 把契约挂到返回对象上，`withErrorEnvelope`
 * （core/errors.ts）在构造信封时把它**提升到 envelope 顶层**并从 data 里摘掉——
 * 所有工具共享同一段提升逻辑，工具 handler 不各自拼结果字段。
 *
 * 兼容：业务 data 里既有的 `truncated` / `count` / `limit` 字段保留一个版本（调用方仍可读），
 * 但**新代码以 envelope.resultInfo 为准**；两者不一致时以 resultInfo 为契约（由本模块的
 * 不变量保证它至少与 count/limit 自洽）。
 */

/** 截断原因（互斥，取最强的一条） */
export type TruncationReason = 'requested-limit' | 'server-cap' | 'safety-cap';

/** 一次结果的规模与截断口径（envelope.resultInfo 的形状） */
export interface ResultInfo {
  /** 本次实际返回的条目数 */
  returnedCount: number;
  /** 可用总数（仅当服务端知道时给出；不知道就省略，而不是猜） */
  totalAvailable?: number;
  /** 是否有条目因 limit/cap 未返回 */
  truncated: boolean;
  /** 截断原因；truncated=false 时不出现 */
  truncationReason?: TruncationReason;
}

/** data 上的传输字段名（withErrorEnvelope 识别后提升到 envelope 顶层） */
export const RESULT_INFO_KEY = 'resultInfo';

/**
 * 空集标记（Symbol）：用于**没有 limit 语义**的列表类结果（如字段清单）。
 * 刻意不用字符串字段——业务数据里本来就有 `empty: boolean` 这类字段（TableInspectResult），
 * 字符串标记会与真实业务字段撞名；Symbol 不会被对象展开复制，也不会出现在 structuredContent 里。
 */
export const EMPTY_RESULT_MARK: unique symbol = Symbol('saphana.emptyResult');

/** 合法截断原因集合（供校验与文档引用） */
export const TRUNCATION_REASONS: readonly TruncationReason[] = ['requested-limit', 'server-cap', 'safety-cap'];

/** resultInfo 构造入参：调用方只给「知道的事实」，截断判定与原因归并在这里统一完成 */
export interface ResultInfoSpec {
  /** 本次实际返回的条目数（必须是非负整数） */
  returnedCount: number;
  /**
   * 可用总数。知道就**必须**给（用它区分「恰好 N 条」与「至少 N+1 条」）；
   * 不知道时省略，由 limit 取满与否来判。
   */
  totalAvailable?: number;
  /** 本次生效的 limit（回执里的 data.limit；服务端默认值也算） */
  limit?: number;
  /** `limit` 是调用方显式请求的（false/省略 = 服务端默认或钳制后的值） */
  requestedLimit?: boolean;
  /** 独立的服务端上限被触达（候选视图数 / 多跳节点数 / 下游扫描数等） */
  serverCapHit?: boolean;
  /** 固定安全上限被触达（如 analyze 行数硬顶） */
  safetyCapHit?: boolean;
  /** 服务层已经算好的截断结论（给了就以它为准，但仍受"空集不是截断"约束） */
  truncated?: boolean;
}

/**
 * 构造 `resultInfo`。
 *
 * @returns 无 limit/cap 语义且未显式给 truncated 时返回 undefined（信封不出现该字段）
 * @throws 内部口径错误（非法计数 / 总数小于返回数）——这是编程错误，静默纠正会让契约说谎
 */
export function resultInfoOf(spec: ResultInfoSpec): ResultInfo | undefined {
  const returned = spec.returnedCount;
  if (!Number.isInteger(returned) || returned < 0) {
    throw new Error(`resultInfo 内部口径错误：returnedCount 必须是非负整数（收到 ${String(returned)}）`);
  }
  if (spec.totalAvailable !== undefined && !Number.isInteger(spec.totalAvailable)) {
    throw new Error(`resultInfo 内部口径错误：totalAvailable 必须是整数（收到 ${String(spec.totalAvailable)}）`);
  }
  // 并发 COUNT 与明细查询可能看到不同快照（count < items）：总数不可信时**省略**而不是抛错——
  // 一次良性竞态不该把列表调用变成「内部错误」。明细本身仍是可用的。
  const totalAvailable =
    spec.totalAvailable !== undefined && spec.totalAvailable >= returned ? spec.totalAvailable : undefined;
  const hasLimit = spec.limit !== undefined;
  const hasCap = spec.serverCapHit === true || spec.safetyCapHit === true || totalAvailable !== undefined;
  if (!hasLimit && !hasCap && spec.truncated === undefined) return undefined;

  const derived =
    // 知道总数时以总数为准：它是唯一能区分「恰好 N」与「至少 N+1」的依据，
    // 也压过上游可能过粗的 truncated（例如 count==limit 但实际没有更多）。
    totalAvailable !== undefined
      ? totalAvailable > returned
      : (spec.truncated ??
        ((hasLimit && returned >= spec.limit!) || spec.serverCapHit === true || spec.safetyCapHit === true));

  // 0 条 + 截断只在「总数已知 >0」或「扫描空间被 server/safety cap 截断」时成立：
  // 这表示"没取到/没看完"，不是"确定为无"；单纯的空集（未取满 limit、无 cap）仍是 truncated:false。
  const truncated =
    returned === 0
      ? (totalAvailable !== undefined && totalAvailable > 0) || spec.serverCapHit === true || spec.safetyCapHit === true
      : derived;

  const info: ResultInfo = {
    returnedCount: returned,
    ...(totalAvailable !== undefined ? { totalAvailable } : {}),
    truncated,
  };
  if (info.truncated) info.truncationReason = truncationReasonOf(spec);
  return info;
}

/** 截断原因归并：安全上限 > 服务端上限 > 调用方 limit（报告最强的一条） */
function truncationReasonOf(spec: ResultInfoSpec): TruncationReason {
  if (spec.safetyCapHit === true) return 'safety-cap';
  if (spec.serverCapHit === true) return 'server-cap';
  // 调用方没显式给 limit（走的是默认值/钳制值）→ 服务端口径
  return spec.requestedLimit === true ? 'requested-limit' : 'server-cap';
}

/**
 * 把 `resultInfo` 挂到服务层返回对象上。`undefined` 时原样返回（不制造空字段）。
 * 返回值仍是同一个对象类型——调用方继续读原有字段，不需要知道提升发生在信封层。
 */
export function attachResultInfo<T extends object>(data: T, info: ResultInfo | undefined): T {
  if (info === undefined) return data;
  return { ...data, [RESULT_INFO_KEY]: info };
}

/**
 * 分页外壳（`count/limit/truncated` + 一个条目数组）的通用适配器。
 * 服务层的 `runPaged` 与 field 搜索等共用这一形状；条目数组字段名各不相同（objects/packages/…），
 * 这里取**第一个数组属性**，不抄第二份字段名映射。
 */
export function attachPagedInfo<
  T extends {
    count: number;
    limit: number;
    truncated: boolean;
  },
>(data: T, opts: { requestedLimit?: boolean; serverCapHit?: boolean; totalAvailable?: number } = {}): T {
  const itemsKey = Object.keys(data).find((k) => Array.isArray((data as Record<string, unknown>)[k]));
  if (itemsKey === undefined) {
    throw new Error('attachPagedInfo：分页结果里找不到条目数组（count/limit/truncated 外壳必须带一个数组字段）');
  }
  const items = (data as unknown as Record<string, unknown[]>)[itemsKey]!;
  return attachResultInfo(
    data,
    resultInfoOf({
      returnedCount: items.length,
      totalAvailable: opts.totalAvailable ?? data.count,
      limit: data.limit,
      requestedLimit: opts.requestedLimit,
      ...(opts.serverCapHit !== undefined ? { serverCapHit: opts.serverCapHit } : {}),
      truncated: data.truncated,
    }),
  );
}

/**
 * 标记「合法的空集」（P0-2）：用于没有 limit 语义、却可能出现"什么都没匹配到"的列表结果。
 * 空集**不是错误**：信封仍是 success=true，只额外带 `empty:true` 与一句可读说明。
 */
export function markEmptyResult<T extends object>(data: T): T {
  Object.defineProperty(data, EMPTY_RESULT_MARK, { value: true, enumerable: false, configurable: true });
  return data;
}

/** 读取空集标记（withErrorEnvelope 与测试共用；非对象/无标记 → false） */
export function isEmptyResultMarked(data: unknown): boolean {
  return (
    data !== null && typeof data === 'object' && (data as Record<PropertyKey, unknown>)[EMPTY_RESULT_MARK] === true
  );
}

/** 校验一个值是否是合法 ResultInfo（信封提升点用它拒绝内部口径错误） */
export function isResultInfo(v: unknown): v is ResultInfo {
  if (v === null || typeof v !== 'object') return false;
  const r = v as Record<string, unknown>;
  const count = r['returnedCount'];
  const total = r['totalAvailable'];
  const truncated = r['truncated'];
  const reason = r['truncationReason'];
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) return false;
  if (total !== undefined && (typeof total !== 'number' || !Number.isInteger(total) || total < count)) return false;
  if (typeof truncated !== 'boolean') return false;
  if (truncated === false) return reason === undefined;
  return typeof reason === 'string' && (TRUNCATION_REASONS as readonly string[]).includes(reason);
}

/**
 * 从服务层 data 上摘下 `resultInfo`（返回副本，不改原对象）。
 * 非对象、无该字段 → `info` undefined。
 */
export function liftResultInfo(data: unknown): { data: unknown; info?: ResultInfo } {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return { data };
  if (!Object.prototype.hasOwnProperty.call(data, RESULT_INFO_KEY)) return { data };
  const { [RESULT_INFO_KEY]: candidate, ...rest } = data as Record<string, unknown>;
  if (!isResultInfo(candidate)) {
    throw new Error('信封构造失败：data.resultInfo 不符合统一截断契约（内部编程错误）');
  }
  return { data: rest, info: candidate };
}
