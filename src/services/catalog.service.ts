import type { HanaPool } from '../core/hana-client.js';
import { nowIso } from '../core/datetime.js';

/**
 * 关系图（catalog）：对象级多跳遍历与影响半径（P4 交付，只读零风险）。
 *
 * 设计口径（SSD §3.2/§3.3，2026-10-08 侦察定）：
 * - 对象图**直查** `_SYS_REPO.ACTIVE_OBJECTCROSSREF`（不做启动期全量索引、不做持久化）；
 * - 遍历按层 BFS：每层一次批量 SQL（frontier 分块，避免参数上限），visited-set 用
 *   `(packageId, objectName, objectSuffix)` 三元组去重（CV 理论无环，防御性保留）；
 * - **只沿设计时视图类型继续展开**（calculationview/attributeview/analyticview，与
 *   whereUsed 的 kind 口径同源）；非视图邻居（TABLE、`__RT_*` 运行时目录视图）只收进结果、
 *   不再从它们继续展开——否则运行时副本会与设计时对象形成平行图；
 * - 所有结果带 `asOf`（构建时刻，进程时区），可能被截断时带 `truncated`（I2 诚实性）。
 */

export interface GraphNode {
  packageId: string;
  objectName: string;
  objectSuffix: string;
}

export interface GraphEdge extends GraphNode {
  refType: number;
  /** 运行时目录视图引用（OBJECT_SUFFIX 以 __RT_ 开头），与 whereUsed 的判定一致 */
  isRuntime: boolean;
  /** 该节点是**首次从哪个方向**被纳入闭包的（both 遍历下用于按方向拆分结果） */
  via: 'upstream' | 'downstream';
  /** 距种子的跳数（1=直接依赖；按需消费方（如字段级血缘）用它做"最近优先"排序） */
  level: number;
}

export interface ClosureResult {
  seed: GraphNode;
  direction: 'upstream' | 'downstream' | 'both';
  /** 闭包成员（不含种子），已按 (objectSuffix, packageId, objectName) 排序 */
  nodes: GraphEdge[];
  /** 实际完整展开的层数（depth='all' 时到图穷为止） */
  depthReached: number;
  /** 触达 maxNodes 上限而截断（结果不完整，调用方必须如实告知） */
  truncated: boolean;
  /** 本次遍历的构建时刻（进程时区 ISO，秒级） */
  asOf: string;
}

export interface ClosureOptions {
  direction?: 'upstream' | 'downstream' | 'both';
  /** 跳数；'all' = 走到图穷（仍受 maxNodes 约束）。默认 1（= whereUsed 原语义） */
  depth?: number | 'all';
  /** 闭包成员上限，默认 500；触达即截断并置 truncated */
  maxNodes?: number;
}

/** 与 metadata.service.VIEW_SUFFIXES 同源的三种设计时视图类型（此处硬编码会漂移，故显式声明来源） */
const VIEW_SUFFIXES = ['calculationview', 'attributeview', 'analyticview'] as const;

export const DEFAULT_MAX_NODES = 500;
/** 单条 SQL 的 frontier 分块大小（每节点 2 个绑定参数，50 → 100 参数，远离 HANA 上限） */
const FRONTIER_CHUNK = 50;

const keyOf = (n: GraphNode): string => `${n.packageId}/${n.objectName}/${n.objectSuffix}`;

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

interface CrossRefRow {
  PACKAGE_ID: string;
  OBJECT_NAME: string;
  OBJECT_SUFFIX: string;
  REF_TYPE: number;
}

const mapRow = (r: CrossRefRow): Omit<GraphEdge, 'via' | 'level'> => ({
  packageId: r.PACKAGE_ID,
  objectName: r.OBJECT_NAME,
  objectSuffix: r.OBJECT_SUFFIX,
  refType: r.REF_TYPE,
  isRuntime: r.OBJECT_SUFFIX.startsWith('__RT_'),
});

/**
 * 单层批量展开：从 frontier 的每个节点取一跳邻居。
 * - upstream：本对象引用了谁（WHERE FROM = frontier，取 TO 侧）
 * - downstream：谁引用了本对象（WHERE TO = frontier，取 FROM 侧）
 * suffix 过滤施加在 **frontier 侧**（与 whereUsed 的 kind 语义逐字一致：kind 只约束种子对象）。
 */
export async function expandLevel(
  pool: HanaPool,
  frontier: readonly GraphNode[],
  direction: 'upstream' | 'downstream',
): Promise<Array<Omit<GraphEdge, 'via' | 'level'>>> {
  if (frontier.length === 0) return [];
  const suffixIn = `(${VIEW_SUFFIXES.map(() => '?').join(',')})`;
  const out: Array<Omit<GraphEdge, 'via' | 'level'>> = [];

  for (const part of chunk(frontier, FRONTIER_CHUNK)) {
    const wherePairs = part.map(() => '(FROM_PACKAGE_ID = ? AND FROM_OBJECT_NAME = ?)').join(' OR ');
    const wherePairsTo = part.map(() => '(TO_PACKAGE_ID = ? AND TO_OBJECT_NAME = ?)').join(' OR ');
    const pairParams = part.flatMap((n) => [n.packageId, n.objectName]);

    const sql =
      direction === 'upstream'
        ? `SELECT TO_PACKAGE_ID AS PACKAGE_ID, TO_OBJECT_NAME AS OBJECT_NAME, TO_OBJECT_SUFFIX AS OBJECT_SUFFIX, REF_TYPE
             FROM "_SYS_REPO"."ACTIVE_OBJECTCROSSREF"
             WHERE (${wherePairs}) AND FROM_OBJECT_SUFFIX IN ${suffixIn}`
        : `SELECT FROM_PACKAGE_ID AS PACKAGE_ID, FROM_OBJECT_NAME AS OBJECT_NAME, FROM_OBJECT_SUFFIX AS OBJECT_SUFFIX, REF_TYPE
             FROM "_SYS_REPO"."ACTIVE_OBJECTCROSSREF"
             WHERE (${wherePairsTo}) AND TO_OBJECT_SUFFIX IN ${suffixIn}`;

    // 写路径 SQL 超时（§4.3）：P6 起本查询进了写路径（update 判定在锁内、delete 判定在锁外，每次写前各查一次），
    // 不设超时就不受 HANA_SQL_TIMEOUT_MS 约束——与 P5 写路径四处同一写法（超时值取自池）。
    // 假池/旧调用点拿到 undefined 时行为与今天一致（hana-client 的 positiveTimeoutMs 按「未给」处理）。
    const rows = await pool.query<CrossRefRow>(sql, [...pairParams, ...VIEW_SUFFIXES], {
      timeoutMs: pool.statementTimeoutMs,
    });
    out.push(...rows.map(mapRow));
  }
  return out;
}

/**
 * 闭包遍历（按层 BFS）。语义承诺：
 * - `depth=1` 的结果与 whereUsed 的单跳查询**同源同序**（同一条 SQL 形状 + 同一排序键）；
 * - 环防护：visited-set 含种子，任一层命中已访问节点即跳过；
 * - `depth='all'` 仍受 maxNodes 约束，触达即 `truncated:true`（不静默丢）。
 */
export async function closure(pool: HanaPool, seed: GraphNode, opts: ClosureOptions = {}): Promise<ClosureResult> {
  const direction = opts.direction ?? 'both';
  const depth = opts.depth ?? 1;
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const dirs: Array<'upstream' | 'downstream'> = direction === 'both' ? ['upstream', 'downstream'] : [direction];

  const visited = new Set<string>([keyOf(seed)]);
  const nodes: GraphEdge[] = [];
  let frontier: GraphNode[] = [seed];
  let depthReached = 0;
  let truncated = false;

  while (frontier.length > 0) {
    if (depth !== 'all' && depthReached >= depth) break;
    const next: GraphNode[] = [];
    for (const dir of dirs) {
      const edges = await expandLevel(pool, frontier, dir);
      for (const e of edges) {
        const k = keyOf(e);
        if (visited.has(k)) continue;
        visited.add(k);
        nodes.push({ ...e, via: dir, level: depthReached + 1 });
        next.push(e);
        if (nodes.length >= maxNodes) {
          truncated = true;
          break;
        }
      }
      if (truncated) break;
    }
    depthReached++;
    if (truncated) break;
    frontier = next;
  }

  nodes.sort(
    (a, b) =>
      a.objectSuffix.localeCompare(b.objectSuffix) ||
      a.packageId.localeCompare(b.packageId) ||
      a.objectName.localeCompare(b.objectName),
  );

  return { seed, direction, nodes, depthReached, truncated, asOf: nowIso() };
}

/**
 * 影响半径：下游**直接引用（单跳）**的语义别名（P6 破坏性判定与编排层切分工作用）。
 * 默认 depth=1 是刻意的口径：P6 的破坏性判定/回执每次写都要跑一遍，跑到图穷（depth='all'）代价太大。
 * 需要传递影响面（多跳闭包）请用 `hana_metadata_where_used` 的 depth>1，不要在本函数默认值上加码；
 * 回执与注释一律把判定输入称作「直接下游（单跳）」，别写成「闭包」——那会让人高估判定覆盖面。
 */
export async function impact(
  pool: HanaPool,
  seed: GraphNode,
  opts: { depth?: number | 'all'; maxNodes?: number } = {},
): Promise<ClosureResult> {
  return closure(pool, seed, { direction: 'downstream', ...opts });
}
