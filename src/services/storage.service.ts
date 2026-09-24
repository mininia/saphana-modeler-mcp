/**
 * 表存储画像服务（hana_table_storage 的落地实现）。
 *
 * ## 数据源与量级
 * - `SYS.M_CS_TABLES`——实测 74836 行 = 71565 张表 × 分区（PART_ID）。**一行是一个分区**，
 *   所以一切查询必须先在 SQL 侧按 (SCHEMA_NAME, TABLE_NAME) 聚合再排序，否则取到的是
 *   "最大的分区"而不是"最大的表"。实测聚合查询约 1.3 秒。
 * - `SYS.M_TABLE_PERSISTENCE_STATISTICS`——**磁盘占用口径**（`DISK_SIZE`），实测 73757 行。
 *   它只对 top-N 的结果按需二次查询，不参与主查询的 join（避免把两次全表扫描叠在一起）。
 *
 * ## 三个易错的口径（都实测确认过）
 * 1. **`M_TABLES.TABLE_SIZE` 不是磁盘占用**：实测 `/BIC/AZDEMO001` 的 `TABLE_SIZE`(3464067684)
 *    与 `M_CS_TABLES` 的内存总量**完全相同**，是内存口径。磁盘占用只能取 `DISK_SIZE`。
 * 2. **热度用 `M_CS_TABLES.READ_COUNT/WRITE_COUNT`**，不用 `M_TABLE_STATISTICS.SELECT_COUNT`
 *    （后者实测 4103 行里非零读计数为 0，未采集）。
 * 3. **碎片率是 delta 占总量之比**，且小表的比值是噪声（实测有 0.2 MiB 的表碎片率 51%），
 *    故 fragmentation 模式用 `minSizeMiB` 过滤——不设它，排行榜会被小表占满。
 *
 * ## 隐私/性能边界
 * `M_TABLE_PARTITIONS` 视图（逐分区的物理布局）实测单次查询 **13.6 秒**，故**不使用**；
 * 逐分区明细改从 `M_CS_TABLES` 取（实测 19 个分区 81ms），够用且快得多。
 */

import type { HanaPool } from '../core/hana-client.js';
import { probeVisibility, emptyIsAmbiguous, type Visibility } from './visibility.service.js';

/**
 * 画像口径。
 *
 * 前五种以**表**为单位（一行一张表）；`column` / `index` 下钻一层，
 * 分别以**列**和**索引**为单位，返回在 `columns` / `indexes` 字段里（形状不同，故不复用 `rows`）。
 */
export type StorageMode = 'memory' | 'disk' | 'fragmentation' | 'hotness' | 'partition' | 'column' | 'index';
export const ALL_MODES: readonly StorageMode[] = [
  'memory', 'disk', 'fragmentation', 'hotness', 'partition', 'column', 'index',
];

/**
 * BW 表分类（来自 `M_TABLE_PARTITIONS` 的 `GROUP_TYPE`/`SUBTYPE`，实测为**表级**属性：
 * 全库范围内没有任何表出现两种分类）。
 *
 * 为什么需要它：同一个 BW 对象在 HANA 上是一组物理表，光看表名分不清谁是谁。
 * 实测本实例的分布（按表数）：
 *   BW_DSO / ACTIVE      2388 张  ← **aDSO 活动数据表**（业务上"真正的那张表"）
 *   BW_DSO / QUEUE       2238 张  ← aDSO 入站队列（delta 侧，随时被清空）
 *   BW_DSO / CHANGE_LOG  2238 张  ← aDSO 变更日志
 *   BW_PSA / PSA         1667 张  ← 持久暂存区（delta 侧）
 *   BW_CUBE / FACT_IMO   1035 张  ← InfoCube 事实表
 * 命名规律也在实测中确认：同一 aDSO 的物理表只差后缀（如活动表 `/BIC/AZDEMO_DSO012`、
 * 入站队列 `/BIC/AZDEMO_DSO0140`），光看表名分不清谁是谁。
 *
 * ⚠ **只看 `SUBTYPE` 是不够的**：入站队列与活动表可能同名不同后缀，必须靠分类区分。
 */
export interface BwClass {
  /** 如 BW_DSO / BW_PSA / BW_CUBE；非 BW 表为空串 */
  groupType: string;
  /** 如 ACTIVE / QUEUE / CHANGE_LOG / PSA / FACT_IMO；非 BW 表为空串 */
  subtype: string;
  /** BW 对象名（aDSO/PSA/Cube 的业务名），如 ZDEMO_DSO01 */
  object: string;
}

/** subtype 参数取值（'ALL' = 不过滤） */
export const ALL_SUBTYPES = [
  'ALL', 'ACTIVE', 'QUEUE', 'CHANGE_LOG', 'PSA', 'FACT_IMO', 'FACT_E', 'FACT_F', 'ERROR_STACK',
] as const;

/** 默认只看活动表（含 InfoCube 事实表这类"活动数据"侧；未分类的表照常列出，非 BW 系统不受影响） */
export const DEFAULT_SUBTYPE = 'ACTIVE';

/** 判定某分类是否属于"活动数据侧" */
function isActiveLike(subtype: string): boolean {
  return subtype.startsWith('ACTIVE') || subtype === 'FACT_IMO';
}

export interface StorageRequest {
  mode: StorageMode;
  /** 限定 schema（可选；不传则统计当前用户可见的全部 schema） */
  schema?: string;
  /** 限定单表（可选）。所有口径下都是过滤器 */
  table?: string;
  topN: number;
  /** fragmentation 模式下忽略小于该体积（MiB）的表，避免小表的噪声 */
  minSizeMiB: number;
  /**
   * 按 BW 分类过滤（仅 partition 模式与单表查询有意义）。默认 'ACTIVE' = 只看活动表。
   * 'ALL' = 不过滤。其余取值见 ALL_SUBTYPES。
   */
  subtype?: string;
}

/** 表级画像的一行 */
export interface TableStorageRow {
  schema: string;
  table: string;
  /** 内存占用（M_CS_TABLES.MEMORY_SIZE_IN_TOTAL），**MiB** */
  memoryMiB: number;
  mainMiB: number;
  deltaMiB: number;
  /** 磁盘占用（M_TABLE_PERSISTENCE_STATISTICS.DISK_SIZE），**MiB**；取不到时为 null */
  diskMiB: number | null;
  /** delta 内存占总量之比（%）——碎片化的内存口径 */
  fragmentationPct: number;
  /** 分区数（M_CS_TABLES 里该表的行数，即 COUNT(DISTINCT PART_ID)） */
  partitions: number;
  records: number;
  readCount: number;
  writeCount: number;
  mergeCount: number;
  lastMergeTime: string | null;
  /**
   * BW 分类（仅当本次查询需要时填充——取它要查 M_TABLE_PARTITIONS，实测单 schema 批量约 1.2 秒，
   * 故排行榜类查询不带，单表查询与 partition 模式才取）。非 BW 表为 null。
   */
  bwClass: BwClass | null;
}

/** 单个分区的明细（partition 模式指定表时返回） */
export interface PartitionRow {
  partId: number;
  host: string;
  /** MiB */
  memoryMiB: number;
  deltaMiB: number;
  fragmentationPct: number;
  records: number;
  lastMergeTime: string | null;
}

/**
 * 列级明细（column 模式返回）。来源 `M_CS_ALL_COLUMNS`（实测 1,097,254 行）。
 *
 * ⚠ 该视图有一列 `COMPRESSION_RATIO_IN_PERCENTAGE`，**实测不能当"压缩质量"读**：
 * 本机出现过 361890% 这样的值。反推其口径为 `MEMORY_SIZE_IN_TOTAL ÷ UNCOMPRESSED_SIZE × 100`，
 * 而 `UNCOMPRESSED_SIZE` 在本版本大量为 NULL、非 NULL 时也远小于内存量。
 * 按"比值低=压缩差"建规则会全线误报。故这里只给**压缩类型**（那列取值干净：
 * DEFAULT / INDIRECT / SPARSE / RLE / CLUSTERED / PREFIXED）与实际内存量，
 * 让人自己看"同样的数据类型为什么这张表用 INDIRECT 而那张用 DEFAULT"。
 */
export interface ColumnRow {
  schema: string;
  table: string;
  column: string;
  /** 列内存（各分区求和），MiB */
  memoryMiB: number;
  mainMiB: number;
  deltaMiB: number;
  /** 其中**可分页加载**的部分（这部分内存可被卸载/换出而不必重新计算），MiB */
  pageLoadableMiB: number;
  /** 压缩类型（DEFAULT / INDIRECT / SPARSE / RLE / CLUSTERED / PREFIXED …） */
  compressionType: string;
  /** 列内不同值个数（**多分区表取最大分区**：字典按分区建，跨分区不能相加） */
  distinctCount: number;
  /** 该列的行数（各分区求和） */
  count: number;
  /** 该列的索引类型（FULL / NONE / …）——索引内存见 mode=index */
  indexType: string;
  loaded: string;
  lastAccessTime: string | null;
  parts: number;
}

/**
 * 索引级明细（index 模式返回）。来源 `M_CS_INDEXES`（实测 84,513 行）。
 *
 * **为什么不给 `HASH_COLLISION_COUNT`**：实测该列全库只有 `-1` 一种取值（84310 行无一例外），
 * 在本版本没有信号，拿它判"索引碰撞"会恒为"正常"。索引的价值在内存开销上。
 *
 * **为什么带 `占表内存`**：实测 `SAPABAP1./BIC/AZDEMO001` 的单个 INVERTED VALUE 索引
 * 占 2748.76 MiB，与表自身内存同量级——只列表内存的表画像会漏掉这一整块，
 * 让人以为"这张表才占这么多内存"，实际连带索引要翻倍。
 */
export interface IndexRow {
  schema: string;
  table: string;
  indexName: string;
  indexType: string;
  memoryMiB: number;
  /** 拼接列部分占用的内存，MiB */
  concatMiB: number;
  parts: number;
  /** 所属表的内存，MiB；取不到时 null */
  tableMemoryMiB: number | null;
  /** 索引内存占表内存的百分比（索引/表×100）；表内存取不到时 null */
  ofTablePct: number | null;
}

export interface StorageReport {
  mode: StorageMode;
  checkedAt: string;
  schemaFilter: string | null;
  tableFilter: string | null;
  /** 本次统计覆盖的表数（聚合后的表数，非行数） */
  tableCount: number;
  visibility: Visibility;
  rows: TableStorageRow[];
  /** 仅 partition + 指定 table 时返回：该表的逐分区明细 */
  partitions?: PartitionRow[];
  /** 仅 column 模式返回：列级明细（按列内存降序） */
  columns?: ColumnRow[];
  /** 仅 index 模式返回：索引级明细（按索引内存降序） */
  indexes?: IndexRow[];
  summary: string;
  /** 结果可能有偏时的提示（空集 + 无全量权限） */
  caveat?: string;
  /** partition 模式按 subtype 过滤时的说明：列出了什么、滤掉了什么、怎么切换 */
  subtypeNote?: string;
}

const num = (v: unknown): number => (v == null ? 0 : Number(v));
const round = (v: number, d = 2): number => Number(v.toFixed(d));

/**
 * 表级体量的单位：**MiB（2²⁰）**。
 *
 * 为什么是二进制单位：HANA Cockpit / HANA Studio 的容量显示全部是 1024 进制（实例级用 GiB，
 * 见 health.rules.ts 的 toGiB）。若这里用 MB(10⁶)，同一块内存会得到两个都"看起来合理"的数字，
 * 两者相差 4.9% —— 这种偏差不会报错，只会让人对着 Cockpit 反复核对。
 *
 * 为什么是 MiB 而不是 GiB：表级数据要保留小数分辨率。实测热度榜里大量表的体量在 0.2 MiB 量级，
 * 换算成 GiB 会变成 0.0002，排行与阈值都失去意义。**进制统一为 2 的幂，量级按数据尺度选**。
 */
const MIB = 1024 * 1024;

/** 各口径的排序表达式（白名单映射，不接受外部拼接） */
const ORDER_BY: Record<StorageMode, string> = {
  memory: 'MEM_BYTES DESC',
  disk: 'MEM_BYTES DESC', // 磁盘量在二次查询里取，主排序仍按内存近似（见下方注释）
  fragmentation: 'FRAG_PCT DESC, MEM_BYTES DESC',
  hotness: 'READS DESC, WRITES DESC',
  partition: 'PARTS DESC, MEM_BYTES DESC',
  // column / index 不走表级主查询（各自有独立的聚合视图与排序），这两项仅为满足类型完备；
  // 若将来有人让它们落到主查询路径，会立刻因为语义不对而被 review 发现。
  column: 'MEM_BYTES DESC',
  index: 'MEM_BYTES DESC',
};

/** column / index 两种下钻口径：不走 M_CS_TABLES 主查询，由各自的分支提前返回 */
function isDrilldownMode(m: StorageMode): boolean {
  return m === 'column' || m === 'index';
}

/** 各口径的 HAVING 子句（都是对聚合结果的过滤） */
function havingOf(req: StorageRequest): { sql: string; params: number[] } {
  switch (req.mode) {
    case 'fragmentation':
      return { sql: 'HAVING SUM(MEMORY_SIZE_IN_TOTAL) >= ?', params: [Math.round(req.minSizeMiB * MIB)] };
    case 'partition':
      return { sql: 'HAVING COUNT(DISTINCT PART_ID) > 1', params: [] };
    default:
      return { sql: '', params: [] };
  }
}

/** 主查询：按表聚合 M_CS_TABLES，返回所有口径共用的原始数值 */
async function queryTables(
  pool: HanaPool,
  req: StorageRequest,
  conds: string[],
  params: (string | number)[],
  orderBy: string,
  limit: number,
): Promise<TableStorageRow[]> {
  const having = havingOf(req);
  const rows = await pool.query<{
    SCHEMA_NAME: string; TABLE_NAME: string; MEM_BYTES: unknown; MAIN_BYTES: unknown;
    DELTA_BYTES: unknown; FRAG_PCT: unknown; RECORDS: unknown; READS: unknown;
    WRITES: unknown; MERGES: unknown; LAST_MERGE: string | null; PARTS: unknown;
  }>(
    `SELECT SCHEMA_NAME, TABLE_NAME,
            SUM(MEMORY_SIZE_IN_TOTAL) AS MEM_BYTES,
            SUM(MEMORY_SIZE_IN_MAIN) AS MAIN_BYTES,
            SUM(MEMORY_SIZE_IN_DELTA) AS DELTA_BYTES,
            SUM(MEMORY_SIZE_IN_DELTA) * 100.0 / NULLIF(SUM(MEMORY_SIZE_IN_TOTAL), 0) AS FRAG_PCT,
            SUM(RECORD_COUNT) AS RECORDS,
            SUM(READ_COUNT) AS READS, SUM(WRITE_COUNT) AS WRITES, SUM(MERGE_COUNT) AS MERGES,
            MAX(LAST_MERGE_TIME) AS LAST_MERGE,
            COUNT(DISTINCT PART_ID) AS PARTS
     FROM SYS.M_CS_TABLES
     WHERE ${conds.join(' AND ')}
     GROUP BY SCHEMA_NAME, TABLE_NAME
     ${having.sql}
     ORDER BY ${orderBy}
     LIMIT ?`,
    [...params, ...having.params, limit],
  );
  return rows.map((r) => ({
    schema: r.SCHEMA_NAME,
    table: r.TABLE_NAME,
    memoryMiB: round(num(r.MEM_BYTES) / MIB, 1),
    mainMiB: round(num(r.MAIN_BYTES) / MIB, 1),
    deltaMiB: round(num(r.DELTA_BYTES) / MIB, 1),
    diskMiB: null, // 由 attachDiskSize 补齐
    fragmentationPct: round(num(r.FRAG_PCT), 3),
    partitions: num(r.PARTS),
    records: num(r.RECORDS),
    readCount: num(r.READS),
    writeCount: num(r.WRITES),
    mergeCount: num(r.MERGES),
    lastMergeTime: r.LAST_MERGE ?? null,
    bwClass: null, // 由 attachBwClass 按需补齐
  }));
}

/**
 * 补齐 BW 分类（GROUP_TYPE / SUBTYPE / BW 对象名），并返回分类统计。
 *
 * **性能关键**：必须按 schema 分组、用 `SCHEMA_NAME = ? AND TABLE_NAME IN (...)` 查询。
 * 实测三种写法的代价（对同一批 20 张表）：
 *   SCHEMA_NAME = ? AND TABLE_NAME IN (...)   → 1.2 秒  ✅ 采用
 *   SCHEMA_NAME||'.'||TABLE_NAME IN (...)     → 8.1 秒  ❌ 拼接谓词让视图的剪枝失效
 *   (SCHEMA_NAME=? AND ...) OR (...) 多分片   → 5.6 秒  ❌
 * 全表 GROUP BY 更是要 9.7 秒。故只对**已选出的 topN 行**取，且排行榜类查询默认不取。
 */
async function attachBwClass(pool: HanaPool, rows: TableStorageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const bySchema = new Map<string, TableStorageRow[]>();
  for (const r of rows) {
    const list = bySchema.get(r.schema);
    if (list) list.push(r); else bySchema.set(r.schema, [r]);
  }
  for (const [schema, list] of bySchema) {
    try {
      const names = list.map((r) => r.table);
      const placeholders = names.map(() => '?').join(', ');
      const cls = await pool.query<{ TABLE_NAME: string; GROUP_TYPE: string; SUBTYPE: string; GROUP_NAME: string }>(
        `SELECT DISTINCT TABLE_NAME, GROUP_TYPE, SUBTYPE, GROUP_NAME
         FROM SYS.M_TABLE_PARTITIONS
         WHERE SCHEMA_NAME = ? AND TABLE_NAME IN (${placeholders})`,
        [schema, ...names],
      );
      const map = new Map(cls.map((c) => [c.TABLE_NAME, c]));
      for (const r of list) {
        const c = map.get(r.table);
        r.bwClass = c
          ? { groupType: c.GROUP_TYPE ?? '', subtype: c.SUBTYPE ?? '', object: c.GROUP_NAME ?? '' }
          : null;
      }
    } catch {
      // M_TABLE_PARTITIONS 不可用时（该视图实测较慢且可能受权限影响）不阻断主流程：
      // 分类只是标签，缺了不影响内存/磁盘/分区数等核心读数
      for (const r of list) r.bwClass = r.bwClass ?? null;
    }
  }
}

/**
 * 某行是否通过 subtype 过滤。
 *
 * 未分类的表（非 BW，如 HOLOGRES.* 的虚拟表）的取舍是**有意区分**的：
 * - **未显式指定 subtype**（即走默认的活动表过滤）→ 放行。否则在非 BW 系统上默认过滤会把结果清空，
 *   而 DEFAULT 的用意是"排除 delta 侧的表"，不是"只允许 BW 表"。
 * - **显式指定了 subtype**（如 QUEUE/PSA）→ 不放行。此时调用方的意图是"只要这一类"，
 *   把无分类的表混进来是噪声。
 */
function passSubtype(r: TableStorageRow, subtype: string, explicit: boolean): boolean {
  if (subtype === 'ALL') return true;
  if (!r.bwClass || (!r.bwClass.groupType && !r.bwClass.subtype)) return !explicit;
  if (subtype === 'ACTIVE') return isActiveLike(r.bwClass.subtype);
  return r.bwClass.subtype === subtype;
}

/**
 * 给已选出的表补齐磁盘占用。
 *
 * 为什么二次查询而不是 join：主查询已经在 M_CS_TABLES（74836 行）上做过一次聚合，
 * 再 join 一张 73757 行的视图会把两次扫描叠在一起；而结果集只有 topN（默认 20）行，
 * 按 (schema, table) 精确回查这 20 张表是毫秒级的事。
 */
async function attachDiskSize(pool: HanaPool, rows: TableStorageRow[]): Promise<void> {
  if (rows.length === 0) return;
  const keys = rows.map((r) => `${r.schema}.${r.table}`);
  const placeholders = keys.map(() => '?').join(', ');
  const disk = await pool.query<{ KEY: string; DISK_SIZE: unknown }>(
    `SELECT SCHEMA_NAME || '.' || TABLE_NAME AS KEY, SUM(DISK_SIZE) AS DISK_SIZE
     FROM SYS.M_TABLE_PERSISTENCE_STATISTICS
     WHERE SCHEMA_NAME || '.' || TABLE_NAME IN (${placeholders})
     GROUP BY SCHEMA_NAME, TABLE_NAME`,
    keys,
  );
  const byKey = new Map(disk.map((d) => [d.KEY, num(d.DISK_SIZE)]));
  for (const r of rows) {
    const v = byKey.get(`${r.schema}.${r.table}`);
    r.diskMiB = v === undefined ? null : round(v / MIB, 1);
  }
}

/** partition + 指定 table：该表的逐分区明细 */
async function queryPartitions(pool: HanaPool, schema: string, table: string): Promise<PartitionRow[]> {
  const rows = await pool.query<{
    PART_ID: unknown; HOST: string; MEM: unknown; DELTA: unknown; RECS: unknown; LAST_MERGE: string | null;
  }>(
    `SELECT PART_ID, HOST, MEMORY_SIZE_IN_TOTAL AS MEM, MEMORY_SIZE_IN_DELTA AS DELTA,
            RECORD_COUNT AS RECS, LAST_MERGE_TIME AS LAST_MERGE
     FROM SYS.M_CS_TABLES
     WHERE SCHEMA_NAME = ? AND TABLE_NAME = ? AND IS_REPLICA = 'FALSE'
     ORDER BY PART_ID`,
    [schema, table],
  );
  return rows.map((r) => ({
    partId: num(r.PART_ID),
    host: r.HOST ?? '',
    memoryMiB: round(num(r.MEM) / MIB, 2),
    deltaMiB: round(num(r.DELTA) / MIB, 2),
    fragmentationPct: num(r.MEM) > 0 ? round((num(r.DELTA) / num(r.MEM)) * 100, 3) : 0,
    records: num(r.RECS),
    lastMergeTime: r.LAST_MERGE ?? null,
  }));
}

/**
 * column 模式：列级聚合查询。
 *
 * M_CS_ALL_COLUMNS 实测 **1,097,254 行**（列 × 分区），必须 SQL 侧聚合 + LIMIT。
 *
 * 刻意**不返回 `COMPRESSION_RATIO_IN_PERCENTAGE`**：实测该列在本版本会产生 361890% 这种
 * 不可能的值（反推口径是 `MEMORY_SIZE_IN_TOTAL ÷ UNCOMPRESSED_SIZE × 100`，而
 * `UNCOMPRESSED_SIZE` 大量为 NULL 且远小于内存量）。返回它等于邀请调用方按错误的语义做判断。
 * 压缩相关信息改用 `COMPRESSION_TYPE`（取值干净：DEFAULT/INDIRECT/SPARSE/RLE/…）
 * 搭配实际内存量来表达——"同为 CLUSTD 列，一张用 DEFAULT 一张用 INDIRECT"才是可行动的线索。
 */
async function queryColumns(pool: HanaPool, req: StorageRequest, limit: number): Promise<ColumnRow[]> {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (req.schema) { conds.push('SCHEMA_NAME = ?'); params.push(req.schema); }
  if (req.table) { conds.push('TABLE_NAME = ?'); params.push(req.table); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT SCHEMA_NAME, TABLE_NAME, COLUMN_NAME,
            SUM(MEMORY_SIZE_IN_TOTAL) AS MEM_BYTES,
            SUM(MEMORY_SIZE_IN_MAIN) AS MAIN_BYTES,
            SUM(MEMORY_SIZE_IN_DELTA) AS DELTA_BYTES,
            SUM(MEMORY_SIZE_IN_PAGE_LOADABLE_MAIN) AS PAGELOAD_BYTES,
            MAX(COMPRESSION_TYPE) AS COMPRESSION_TYPE,
            MAX("COUNT") AS ROWS_CNT,
            MAX(DISTINCT_COUNT) AS DISTINCT_CNT,
            MAX(INDEX_TYPE) AS INDEX_TYPE,
            MAX(LOADED) AS LOADED,
            MAX(LAST_ACCESS_TIME) AS LAST_ACCESS,
            COUNT(DISTINCT PART_ID) AS PARTS
     FROM SYS.M_CS_ALL_COLUMNS
     ${where}
     GROUP BY SCHEMA_NAME, TABLE_NAME, COLUMN_NAME
     ORDER BY SUM(MEMORY_SIZE_IN_TOTAL) DESC
     LIMIT ?`,
    [...params, limit],
  );
  return rows.map((r) => ({
    schema: String(r.SCHEMA_NAME),
    table: String(r.TABLE_NAME),
    column: String(r.COLUMN_NAME),
    memoryMiB: round(num(r.MEM_BYTES) / MIB, 2),
    mainMiB: round(num(r.MAIN_BYTES) / MIB, 2),
    deltaMiB: round(num(r.DELTA_BYTES) / MIB, 2),
    pageLoadableMiB: round(num(r.PAGELOAD_BYTES) / MIB, 2),
    compressionType: String(r.COMPRESSION_TYPE ?? ''),
    count: num(r.ROWS_CNT),
    // 多分区表上这是"最大分区内"的不同值数：字典是按分区建的，跨分区不能相加
    distinctCount: num(r.DISTINCT_CNT),
    indexType: String(r.INDEX_TYPE ?? ''),
    loaded: String(r.LOADED ?? ''),
    lastAccessTime: (r.LAST_ACCESS as string) ?? null,
    parts: num(r.PARTS),
  }));
}

/**
 * index 模式：索引级聚合查询。
 *
 * M_CS_INDEXES 实测 **84,513 行**，其中 `INVERTED VALUE` 84331 行、合计 **11.00 GiB**
 * —— 列存表的隐式倒排索引是实例级内存的一块实质开销。
 *
 * 取完后用 `attachTableMemory` 补上所属表的内存，给出"索引占表内存的比例"。
 * 实测这个比例在 73%~83% 之间：`SAPABAP1./BIC/AZDEMO001` 表内存 3303.6 MiB、
 * 索引另占 2748.8 MiB —— **只列表内存的表画像会把这张表的真实成本少算近一半。**
 */
async function queryIndexes(pool: HanaPool, req: StorageRequest, limit: number): Promise<IndexRow[]> {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (req.schema) { conds.push('SCHEMA_NAME = ?'); params.push(req.schema); }
  if (req.table) { conds.push('TABLE_NAME = ?'); params.push(req.table); }
  const where = conds.length > 0 ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = await pool.query<Record<string, unknown>>(
    `SELECT SCHEMA_NAME, TABLE_NAME, INDEX_NAME,
            MAX(INDEX_TYPE) AS INDEX_TYPE,
            SUM(MEMORY_SIZE_IN_TOTAL) AS MEM_BYTES,
            SUM(MEMORY_SIZE_IN_CONCAT) AS CONCAT_BYTES,
            COUNT(DISTINCT PART_ID) AS PARTS
     FROM SYS.M_CS_INDEXES
     ${where}
     GROUP BY SCHEMA_NAME, TABLE_NAME, INDEX_NAME
     ORDER BY SUM(MEMORY_SIZE_IN_TOTAL) DESC
     LIMIT ?`,
    [...params, limit],
  );
  const out: IndexRow[] = rows.map((r) => ({
    schema: String(r.SCHEMA_NAME),
    table: String(r.TABLE_NAME),
    indexName: String(r.INDEX_NAME),
    indexType: String(r.INDEX_TYPE ?? ''),
    memoryMiB: round(num(r.MEM_BYTES) / MIB, 2),
    concatMiB: round(num(r.CONCAT_BYTES) / MIB, 2),
    parts: num(r.PARTS),
    tableMemoryMiB: null,
    ofTablePct: null,
  }));
  await attachTableMemory(pool, out);
  return out;
}

/**
 * 为索引行补上"所属表的内存"与"索引占表内存比"。
 *
 * **一次全表聚合，不做 per-schema 循环。** 实测（同一实例）：
 *   `M_CS_TABLES` 全表 GROUP BY                      1442 ms   ← 采用
 *   `M_CS_TABLES` WHERE SCHEMA_NAME = ? GROUP BY    6648 ms   ← 按 schema 反而慢 4.6 倍
 * 谓词非但没让视图剪枝，还更贵；而 top-N 的 200 个索引可横跨 26 个 schema，
 * 循环就是最多 26 次这样的查询。这与 `M_TABLE_PARTITIONS` 的"拼接谓词让剪枝失效"是同类现象：
 * **这些视图不吃谓词消减**。
 *
 * ⚠ 但别高估这一改的收益：index 模式的整体耗时**不在这里**，而在 `M_CS_INDEXES` 自身的聚合
 * （实测 7.6 秒，改前改后一样）。改成单次查询的价值是少掉最多 26 次往返与随之而来的连接池占用，
 * 不是把 9 秒变成 1 秒——**瓶颈在那个视图本身，改不掉**。
 */
async function attachTableMemory(pool: HanaPool, rows: IndexRow[]): Promise<void> {
  if (rows.length === 0) return;
  try {
    const mem = await pool.query<{ SCHEMA_NAME: string; TABLE_NAME: string; MEM: unknown }>(
      `SELECT SCHEMA_NAME, TABLE_NAME, SUM(MEMORY_SIZE_IN_TOTAL) AS MEM
       FROM SYS.M_CS_TABLES
       WHERE IS_REPLICA = 'FALSE'
       GROUP BY SCHEMA_NAME, TABLE_NAME`,
    );
    // 用 NUL 作分隔符：schema/表名里不会出现它，避免 '.' 在 BW 名（/BIC/A…）里造成的歧义
    const map = new Map(mem.map((m) => [`${m.SCHEMA_NAME}\u0000${m.TABLE_NAME}`, num(m.MEM)]));
    for (const r of rows) {
      const m = map.get(`${r.schema}\u0000${r.table}`);
      if (m == null || m <= 0) continue;
      r.tableMemoryMiB = round(m / MIB, 2);
      r.ofTablePct = round((r.memoryMiB / (m / MIB)) * 100, 1);
    }
  } catch {
    // 表内存取不到不影响索引内存本身这个读数——两列留 null，调用方自会看到
  }
}

/**
 * 执行表存储画像。
 *
 * 两条**形状不同**的路径，不要合并：
 *  - 表级口径（memory/disk/fragmentation/hotness/partition）走 M_CS_TABLES 聚合 + 二次补齐；
 *  - 下钻口径（column/index）单元不是"表"，各查自己的视图，**提前返回**。
 * disk 与 partition 另需更宽的候选集（前者防漏掉"内存小、落盘大"的表，后者防非活动表挤占名次），
 * 故 baseLimit 按口径取值，不统一用 topN。
 */
export async function runTableStorage(pool: HanaPool, req: StorageRequest): Promise<StorageReport> {
  const visibility = await probeVisibility(pool);

  const params: (string | number)[] = [];
  const conds = ["IS_REPLICA = 'FALSE'"]; // 实测取值仅 FALSE；显式过滤以便将来出现副本时不会重复计数
  if (req.schema) {
    conds.push('SCHEMA_NAME = ?');
    params.push(req.schema);
  }
  // table 在**所有口径**下都是一个过滤器（"只看这张表"），不只是 partition 模式的开关。
  // 每一行本来就同时带内存/磁盘/分区/碎片/读写，故单表查询用任意口径都能拿到完整画像。
  if (req.table) {
    conds.push('TABLE_NAME = ?');
    params.push(req.table);
  }

  // partition + schema + table → 升级为逐分区明细（并同时给出表级汇总，免得调用方再查一次）
  if (req.mode === 'partition' && req.schema && req.table) {
    const parts = await queryPartitions(pool, req.schema, req.table);
    const rows = await queryTables(pool, req, conds, params, ORDER_BY.partition, 1);
    await attachDiskSize(pool, rows);
    await attachBwClass(pool, rows);
    const t = rows[0];
    const vacuous = parts.length === 0;
    return {
      mode: req.mode,
      checkedAt: new Date().toISOString(),
      schemaFilter: req.schema,
      tableFilter: req.table,
      tableCount: vacuous ? 0 : 1,
      visibility,
      rows,
      partitions: parts,
      summary: vacuous
        ? `${req.schema}.${req.table} 没有列存分区信息（表不存在、是行存表，或当前用户不可见）`
        : `${req.schema}.${req.table}${describeClass(t)}：内存 ${t?.memoryMiB ?? '?'} MiB ｜ 磁盘 ${t?.diskMiB ?? '?'} MiB`
          + ` ｜ ${parts.length} 个分区 ｜ 碎片 ${t?.fragmentationPct ?? '?'}%`
          + ` ｜ 记录 ${parts.reduce((s, p) => s + p.records, 0)} 条`,
      caveat: emptyIsAmbiguous(parts.length, visibility.unfiltered),
    };
  }

  // column / index 是**下钻口径**：单元是"列"/"索引"而不是"表"，视图与排序都不同，
  // 故不走下面的表级主查询路径，各自提前返回（与 partition+table 的逐分区明细同一处理方式）。
  if (isDrilldownMode(req.mode)) {
    const now = new Date().toISOString();
    const head = `${req.schema ?? '全部 schema'}${req.table ? `.${req.table}` : ''}`;
    if (req.mode === 'column') {
      const columns = await queryColumns(pool, req, req.topN);
      return {
        mode: req.mode,
        checkedAt: now,
        schemaFilter: req.schema ?? null,
        tableFilter: req.table ?? null,
        tableCount: new Set(columns.map((c) => `${c.schema}.${c.table}`)).size,
        visibility,
        rows: [],
        columns,
        summary: columns.length === 0
          ? `${head} 未找到列存列信息（对象不存在、是行存表，或该列已全部卸载）`
          : `${columns.length} 个最大的列（${head}）：合计 ${round(columns.reduce((s, c) => s + c.memoryMiB, 0), 1)} MiB ｜ `
            + `最大 ${columns[0].schema}.${columns[0].table}.${shortId(columns[0].column)} ${columns[0].memoryMiB} MiB`
            + `（压缩 ${columns[0].compressionType}，${columns[0].count} 行，索引 ${columns[0].indexType}）`,
        caveat: emptyIsAmbiguous(columns.length, visibility.unfiltered),
      };
    }
    const indexes = await queryIndexes(pool, req, req.topN);
    const withRatio = indexes.filter((i) => i.ofTablePct != null);
    const avgRatio = withRatio.length > 0
      ? round(withRatio.reduce((s, i) => s + (i.ofTablePct ?? 0), 0) / withRatio.length, 1)
      : null;
    return {
      mode: req.mode,
      checkedAt: now,
      schemaFilter: req.schema ?? null,
      tableFilter: req.table ?? null,
      tableCount: new Set(indexes.map((i) => `${i.schema}.${i.table}`)).size,
      visibility,
      rows: [],
      indexes,
      summary: indexes.length === 0
        ? `${head} 未找到列存索引信息（对象不存在，或该表没有列存索引）`
        : `${indexes.length} 个最大的索引（${head}）：合计 ${round(indexes.reduce((s, i) => s + i.memoryMiB, 0), 1)} MiB ｜ `
          + `最大 ${indexes[0].schema}.${indexes[0].table} ${indexes[0].memoryMiB} MiB`
          + `（${indexes[0].indexType}${indexes[0].ofTablePct != null ? `，占该表内存 ${indexes[0].ofTablePct}%` : ''}）`
          + (avgRatio != null ? ` ｜ 平均占表内存 ${avgRatio}%` : ''),
      caveat: emptyIsAmbiguous(indexes.length, visibility.unfiltered),
    };
  }

  // 默认值由服务层持有：这样能区分"未指定"（走默认 ACTIVE，放行非 BW 表）与"显式指定 ACTIVE"（严格匹配）
  const subtypeExplicit = req.subtype != null && req.subtype !== '';
  const subtype = req.subtype ?? DEFAULT_SUBTYPE;
  // 需要 BW 分类的场景：单表查询（看这一张是谁）、partition 模式（要按活动表过滤）
  const needBwClass = !!req.table || req.mode === 'partition';
  // disk 模式的候选集要放宽：主排序按内存近似（列存表的磁盘量与内存量大多相差 <1%），
  // 但为了不漏掉"内存小、落盘大"的少数表（实测有内存 34.9 MiB / 磁盘 4757.9 MiB 的），
  // 先取更宽的候选再按磁盘量重排截断。
  // partition 模式的起始候选也放宽到 topN×4：实测前几名里常混着 PSA/入站队列（delta 侧），
  // 若起始只取 topN，几乎每次都要触发一轮放宽重查（实测 8.3 秒 vs 放宽后 5 秒）。
  const baseLimit = req.mode === 'disk' ? Math.max(req.topN * 10, 200)
    : req.mode === 'partition' ? Math.max(req.topN * 4, 20)
      : req.topN;

  let limit = baseLimit;
  let rows = await queryTables(pool, req, conds, params, ORDER_BY[req.mode], limit);
  await attachDiskSize(pool, rows);

  let finalRows: TableStorageRow[];
  let subtypeNote: string | undefined;

  if (req.mode === 'partition' && !req.table) {
    // 按 subtype 过滤会改变"前 N 张"的构成，故采用**渐进放宽**：先按 topN 取；若过滤后不足 topN，
    // 说明非活动表挤占了名次，再翻倍重取（最多 2 次翻倍）。
    // 为什么不一次性取大候选集：实测取 400 张候选取分类要 ~6.8 秒，而按 topN 取只要 ~4.8 秒——
    // 非活动表通常只占少数，绝大多数调用一轮即足，不该为极少数情况每次都付全量代价。
    let rounds = 0;
    for (;;) {
      await attachBwClass(pool, rows);
      const kept = rows.filter((r) => passSubtype(r, subtype, subtypeExplicit));
      // rows.length < limit 说明已到全量末尾，再放宽也取不到更多
      const canWiden = subtype !== 'ALL' && kept.length < req.topN && rows.length >= limit && rounds < 2;
      if (!canWiden) {
        finalRows = kept.slice(0, req.topN); // 候选集可能大于 topN，这里才截断
        if (subtype !== 'ALL') {
          const bySubtype = new Map<string, number>();
          for (const d of rows.filter((r) => !passSubtype(r, subtype, subtypeExplicit))) {
            const k = d.bwClass?.subtype ? `${d.bwClass.groupType}/${d.bwClass.subtype}` : '未分类';
            bySubtype.set(k, (bySubtype.get(k) ?? 0) + 1);
          }
          const dist = [...bySubtype.entries()].map(([k, v]) => `${k} ${v} 张`).join('、');
          subtypeNote = `已按 subtype=${subtype} 过滤（只看活动数据表）；在分区数前 ${rows.length} 张候选内`
            + `另有 ${dist || '无'} 未列出——传 subtype='ALL' 或具体值（${ALL_SUBTYPES.filter((s) => s !== 'ALL').join('/')}）可切换`;
        }
        break;
      }
      rounds++;
      limit *= 2;
      rows = await queryTables(pool, req, conds, params, ORDER_BY[req.mode], limit);
      await attachDiskSize(pool, rows);
    }
  } else {
    if (needBwClass) await attachBwClass(pool, rows);
    finalRows = req.mode === 'disk'
      ? [...rows].sort((a, b) => (b.diskMiB ?? -1) - (a.diskMiB ?? -1)).slice(0, req.topN)
      : rows;
  }

  const total = await pool.query<{ N: unknown }>(
    `SELECT COUNT(DISTINCT SCHEMA_NAME || '.' || TABLE_NAME) AS N
     FROM SYS.M_CS_TABLES WHERE ${conds.join(' AND ')}`,
    params,
  );

  const tableCount = num(total[0]?.N);
  const caveat = emptyIsAmbiguous(finalRows.length, visibility.unfiltered);

  return {
    mode: req.mode,
    checkedAt: new Date().toISOString(),
    schemaFilter: req.schema ?? null,
    tableFilter: req.table ?? null,
    tableCount,
    visibility,
    rows: finalRows,
    summary: req.table && finalRows.length === 1
      ? describeTable(finalRows[0])
      : buildSummary(req, finalRows, tableCount),
    caveat,
    ...(subtypeNote ? { subtypeNote } : {}),
  };
}

/** BW 分类的可读后缀，如「（aDSO 活动表 ZDEMO_DSO01）」 */
function describeClass(t: TableStorageRow | undefined): string {
  const c = t?.bwClass;
  if (!c || (!c.groupType && !c.subtype)) return '';
  const label = c.subtype === 'ACTIVE' || c.subtype === 'ACTIVE_IMO' ? '活动表'
    : c.subtype === 'QUEUE' ? '入站队列（delta 侧）'
      : c.subtype === 'CHANGE_LOG' ? '变更日志'
        : c.subtype === 'PSA' ? 'PSA（暂存区）'
          : c.subtype || c.groupType;
  return `（${c.groupType} ${label}${c.object ? ` ${c.object}` : ''}）`;
}

/** 单表画像的一句话描述（各口径通用——每行本来就带全部字段） */
function describeTable(t: TableStorageRow): string {
  return `${t.schema}.${t.table}${describeClass(t)}：内存 ${t.memoryMiB} MiB ｜ 磁盘 ${t.diskMiB ?? '未知'} MiB`
    + ` ｜ ${t.partitions} 个分区 ｜ 碎片 ${t.fragmentationPct}%`
    + ` ｜ 记录 ${t.records} 条 ｜ 读 ${t.readCount} / 写 ${t.writeCount} / merge ${t.mergeCount}`
    + ` ｜ 上次 merge ${t.lastMergeTime ?? '未知'}`;
}

/**
 * 摘要里的标识符截断。
 * BW 的合成列名可以极长（实测 `/BIC/AZDEMO001` 有一个 88 字符的 `$REQUEST$MATNR$…` 列），
 * 直接拼进一句话摘要会把整行撑爆，反而看不见结论。
 */
function shortId(s: string, max = 48): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function buildSummary(req: StorageRequest, rows: TableStorageRow[], tableCount: number): string {
  if (rows.length === 0) {
    return req.mode === 'fragmentation'
      ? `没有超过 ${req.minSizeMiB} MiB 的列存表（统计范围内共 ${tableCount} 张表）`
      : `未取到表存储数据（统计范围内共 ${tableCount} 张表）`;
  }
  const top = rows[0];
  switch (req.mode) {
    case 'memory':
      return `内存占用最高：${top.schema}.${top.table} ${top.memoryMiB} MiB`
        + `（delta ${top.deltaMiB} MiB / 共 ${tableCount} 张表，列出前 ${rows.length} 张）`;
    case 'disk':
      return `磁盘占用最高：${top.schema}.${top.table} ${top.diskMiB ?? '?'} MiB`
        + `（内存 ${top.memoryMiB} MiB / 共 ${tableCount} 张表，列出前 ${rows.length} 张）`;
    case 'fragmentation':
      return `碎片率最高：${top.schema}.${top.table} ${top.fragmentationPct}%`
        + `（delta ${top.deltaMiB} MiB，上次 merge ${top.lastMergeTime ?? '未知'}；`
        + `仅统计 >= ${req.minSizeMiB} MiB 的表）`;
    case 'hotness':
      return `读最频繁：${top.schema}.${top.table} ${top.readCount} 次读 / ${top.writeCount} 次写`
        + `（列出前 ${rows.length} 张）`;
    case 'partition': {
      const cls = describeClass(top);
      return `${top.partitions} 个分区：${top.schema}.${top.table}${cls}`
        + `（内存 ${top.memoryMiB} MiB / 记录 ${top.records} 条；共列出 ${rows.length} 张）`;
    }
    default:
      // column / index 已在 runTableStorage 里提前返回，不会走到这里。
      // 故意抛错而不是返回兜底文案：万一将来有人把下钻口径接到表级路径上，
      // 应当立刻炸掉，而不是安静地给出一份"用表级数字描述列级结果"的错误摘要。
      throw new Error(`buildSummary 不支持下钻口径 ${req.mode}（应由 runTableStorage 的分支提前返回）`);
  }
}

/** 校验 subtype 参数（工具层调用） */
export function normalizeSubtype(subtype?: string): { ok: true; value: string } | { ok: false; message: string } {
  if (!subtype) return { ok: true, value: DEFAULT_SUBTYPE };
  const up = subtype.toUpperCase();
  if (!ALL_SUBTYPES.includes(up as (typeof ALL_SUBTYPES)[number])) {
    return { ok: false, message: `未知的 subtype：${subtype}；合法值：${ALL_SUBTYPES.join(', ')}` };
  }
  return { ok: true, value: up };
}

/** 校验 mode 参数（工具层调用） */
export function normalizeMode(mode?: string): { ok: true; value: StorageMode } | { ok: false; message: string } {
  if (!mode) return { ok: true, value: 'memory' };
  if (!ALL_MODES.includes(mode as StorageMode)) {
    return { ok: false, message: `未知的画像口径：${mode}；合法值：${ALL_MODES.join(', ')}` };
  }
  return { ok: true, value: mode as StorageMode };
}

/**
 * schema/表名校验：只允许 HANA 标识符字符。
 *
 * 虽然查询里用的是绑定参数（无注入风险），仍做形状校验——非法值（含引号/分号/空格）几乎必然是
 * 调用方搞错了参数，早失败比返回空结果更容易排障。表名放宽到含 `/` 与 `%`：BW 的
 * 信息提供者对象名形如 `/BIC/AZDEMO001`，这类名字完全合法。
 */
export function validateSchemaName(schema: string): { ok: true } | { ok: false; message: string } {
  if (!/^[A-Za-z_][A-Za-z0-9_$#]{0,126}$/.test(schema)) {
    return {
      ok: false,
      message: `非法的 schema 名：${schema}。只允许字母/数字/下划线/美元符/井号，且不以数字开头（无需加引号）`,
    };
  }
  return { ok: true };
}

export function validateTableName(table: string): { ok: true } | { ok: false; message: string } {
  if (!/^[A-Za-z_/][A-Za-z0-9_$#/]{0,255}$/.test(table)) {
    return {
      ok: false,
      message: `非法的表名：${table}。只允许字母/数字/下划线/美元符/井号/斜杠，且不以数字开头（无需加引号）`,
    };
  }
  return { ok: true };
}
