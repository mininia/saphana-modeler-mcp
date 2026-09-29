/**
 * 历史趋势（`hana_system_trend`）——回答"**这周比上周差了吗**"。
 *
 * 为什么单独一个工具：现有三个诊断工具的形状都是"此刻的快照"
 * （体检=阈值判定 / 深潜=拓扑明细 / 画像=排序），没有一个能回答"变化"。
 * 而"变化"恰恰是容量与性能问题最常见的形态：某个指标此刻正常、但连续两周单调上升。
 *
 * 数据源：`_SYS_STATISTICS.HOST_LOAD_HISTORY_HOST`。选它是因为**一份就够**——
 * 同一张表同时带 CPU、内存（已用/总量/配额）、磁盘（已用/总量）、网络、swap，
 * 不必跨视图对齐时间轴（跨视图对齐会引入"两边的采样时刻差几秒"这类无法解释的错位）。
 *
 * ⚠ 实测结构（决定了查询怎么写，照文档猜会写错）：
 *   - 该视图**每约 10 秒一个采样点**（同一小时的 358 个采样点落在同一个 `SNAPSHOT_ID` 里）。
 *     实测 1012 个 SNAPSHOT_ID × 358 采样/小时 = 362545 行，跨约 42 天。
 *   - **`SERVER_TIMESTAMP` 是快照写入时刻，`TIME` 才是采样时刻**。同一 SERVER_TIMESTAMP
 *     下有 358 行不同的 TIME —— 用 SERVER_TIMESTAMP 做时间轴会把一整小时的采样压成一个点，
 *     趋势图会退化成 1012 根柱子。故时间轴一律用 `TIME`（实测该列无 NULL）。
 *   - `INDEX` 是 `<host>:<TIME>` 的**行唯一键**（362545 行有 362545 个取值），
 *     不是服务维度，不能拿它做 GROUP BY。
 *
 * 保留期实测约 42 天且**可配置**，故窗口超出时如实报告"只回溯到 X"，而不是假装数据齐全。
 */

import type { HanaPool } from '../core/hana-client.js';
import { GIB, KIB, num, round } from '../core/num.js';
import { logger } from '../core/logger.js';
import { probeVisibility, emptyIsAmbiguous, type Visibility } from './visibility.service.js';
import { addCaveat, reportCheckedAt, type DiagnosticReportBase } from './health.rules.js';

/** 可选的指标组 */
export type TrendMetric = 'cpu' | 'memory' | 'disk' | 'network' | 'swap';
export const ALL_TREND_METRICS: readonly TrendMetric[] = ['cpu', 'memory', 'disk', 'network', 'swap'];

export interface TrendRequest {
  /** 回溯窗口（小时） */
  hours: number;
  /** 聚合桶宽（分钟） */
  bucketMinutes: number;
  /** 要返回的指标组 */
  metrics: TrendMetric[];
}

export interface TrendValue {
  min: number;
  max: number;
  avg: number;
}

/** 一个时间桶 */
export interface TrendPoint {
  index: number;
  from: string;
  to: string;
  /** 该桶内的采样点数（约 10 秒一个） */
  samples: number;
  values: Record<string, TrendValue>;
}

export interface TrendReport extends DiagnosticReportBase {
  window: { from: string; to: string; hours: number; bucketMinutes: number; buckets: number };
  metrics: TrendMetric[];
  /**
   * 数据源实际能回溯的范围。`coversWindow=false` 表示请求的窗口比保留期还长，
   * 返回的数据只是窗口的后半段——**这一点必须让调用方看到**，否则会误以为"更早之前没有数据"
   * 等于"更早之前一切正常"。
   */
  retention: { earliest: string; latest: string; spansHours: number; coversWindow: boolean } | null;
  points: TrendPoint[];
  summary: string;
  visibility: Visibility;
  caveats: string[];
}

export const DEFAULT_BUCKET_MINUTES = 60;
/** 窗口上限（90 天）：超过保留期没有意义，且能防住误传超大值把库拖住 */
export const MAX_HOURS = 24 * 90;

/** 校验并规范化 metrics 参数 */
export function normalizeTrendMetrics(
  metrics?: string[],
): { ok: true; value: TrendMetric[] } | { ok: false; message: string } {
  if (!metrics || metrics.length === 0) return { ok: true, value: [...ALL_TREND_METRICS] };
  const invalid = metrics.filter((m) => !ALL_TREND_METRICS.includes(m as TrendMetric));
  if (invalid.length > 0) {
    return { ok: false, message: `未知的趋势指标：${invalid.join(', ')}；合法值：${ALL_TREND_METRICS.join(', ')}` };
  }
  return { ok: true, value: metrics as TrendMetric[] };
}

/*
 * 各指标组产出的数值列（键名即输出字段名，带单位后缀以免误读）——与下方 `put(...)` 调用
 * 一一对应，原先那份 `METRIC_KEYS` 常量表零引用（死代码）已删除，但把口径留在这里：
 *   cpu     → cpuPct
 *   memory  → memoryUsedGiB / memoryUsedPct（占**配额**比，与 Cockpit 的 "Used %" 同口径）
 *   disk    → diskUsedGiB / diskUsedPct
 *   network → networkInKiB / networkOutKiB
 *   swap    → swapInBytes / swapOutBytes
 * ⚠ 采样间隔约 10 秒，故 network / swap 是"每个采样周期内的量"，**不是速率**。
 */

/**
 * 执行趋势查询。
 *
 * 聚合**在 SQL 侧按时间桶完成**：实测该视图 36 万行、约 10 秒一个采样点，
 * 24 小时窗口就有 8600 行，42 天窗口 36 万行——拉回明细再在 JS 里分桶既慢又没必要。
 * 桶的划分用 `FLOOR(SECONDS_BETWEEN(窗口起点, TIME) / 桶宽秒数)`，
 * 起点由 `ADD_SECONDS(CURRENT_TIMESTAMP, -窗口秒数)` 在库内算，避免客户端与库的时钟差。
 */
export async function runTrend(pool: HanaPool, req: TrendRequest): Promise<TrendReport> {
  const visibility = await probeVisibility(pool);
  const caveats: string[] = [];
  const windowSec = req.hours * 3600;
  const bucketSec = req.bucketMinutes * 60;

  // 保留期：单独一次查询。取不到时不阻断趋势本身（只说明"窗口外还有多少数据"未知）。
  let retention: TrendReport['retention'] = null;
  try {
    const r = await pool.query<{ T0: string; T1: string }>(
      `SELECT MIN(TIME) AS T0, MAX(TIME) AS T1 FROM _SYS_STATISTICS.HOST_LOAD_HISTORY_HOST`,
    );
    if (r[0]?.T0 && r[0]?.T1) {
      // ⚠ 口径不一致（已知，暂不在此处修）：这里用 `new Date(时间串)` 在**客户端**解析 HANA 的
      // TIME 值（无时区后缀 → 按进程时区解释），而窗口与分桶基准是**库内的 CURRENT_TIMESTAMP**。
      // 两者相差一个时区偏移时，spansHours 会有整小时级偏差（DST 切换处再差 1 小时）。
      // 正解是把跨度的计算下推到 SQL（如 SECONDS_BETWEEN(MIN(TIME), MAX(TIME))/3600.0），
      // 那要改这条既有语句的文本；本模块的实机验收已通过，**没有实机环境不凭空改 SQL**，
      // 故保留现状并由下面的 Number.isFinite 兜底把"解析失败"如实报出来。
      const spansHours = round((new Date(r[0].T1).getTime() - new Date(r[0].T0).getTime()) / 3_600_000, 1);
      const coversWindow = spansHours >= req.hours;
      retention = { earliest: r[0].T0, latest: r[0].T1, spansHours, coversWindow };
      if (!coversWindow) {
        caveats.push(
          `请求窗口 ${req.hours} 小时超出了历史层保留期（实测该实例约 ${spansHours} 小时）——` +
            `返回的只是窗口的后半段。**未覆盖的那部分不等于"正常"**，只是没有数据。` +
            '要拉长保留期需调整统计服务的收集配置。',
        );
      }
      // 时间串的可解析性：MIN/MAX(TIME) 原样来自库（驱动可能给字符串或 Date），
      // 若解析不出有限值，spansHours 会是 NaN 而 coversWindow 恒为 false——
      // 结论方向没错（"不能说覆盖了窗口"），但必须把"这是解析失败而非真的保留期不足"讲清楚。
      if (!Number.isFinite(spansHours)) {
        logger.warn({ view: 'HOST_LOAD_HISTORY_HOST' }, '保留期时间串无法解析为有限时长，已按"未确认覆盖"处理');
        caveats.push(
          '历史层保留期的起止时刻无法解析为时长（时间串缺少时区/格式不可识别），' +
            '故无法确认请求窗口是否被保留期截断——请以 retention 里的原始 earliest/latest 自行核对。',
        );
      }
    }
  } catch (e) {
    // 这条 catch 原先完全静默（只推 caveat）；记一条日志便于区分"视图不可读"与"确实没有保留期数据"
    logger.warn({ err: e, view: 'HOST_LOAD_HISTORY_HOST' }, '未能确定历史层保留期');
    caveats.push('未能确定历史层保留期（统计服务视图不可读或权限不足），无法判断窗口是否被截断。');
  }

  const rows = await pool.query<Record<string, unknown>>(
    `WITH P AS (SELECT ADD_SECONDS(CURRENT_TIMESTAMP, -?) AS T0, ? AS BS FROM DUMMY)
     SELECT FLOOR(SECONDS_BETWEEN(P.T0, H.TIME) / P.BS) AS BUCKET,
            MIN(H.TIME) AS B0, MAX(H.TIME) AS B1, COUNT(*) AS N,
            MIN(H.CPU) AS CPU_MIN, MAX(H.CPU) AS CPU_MAX, AVG(H.CPU) AS CPU_AVG,
            MIN(H.MEMORY_USED) AS MEM_MIN, MAX(H.MEMORY_USED) AS MEM_MAX, AVG(H.MEMORY_USED) AS MEM_AVG,
            MAX(H.MEMORY_ALLOCATION_LIMIT) AS MEM_LIMIT, MAX(H.MEMORY_SIZE) AS MEM_TOTAL,
            MIN(H.DISK_USED) AS DISK_MIN, MAX(H.DISK_USED) AS DISK_MAX, AVG(H.DISK_USED) AS DISK_AVG,
            MAX(H.DISK_SIZE) AS DISK_TOTAL,
            AVG(H.NETWORK_IN) AS NIN_AVG, MIN(H.NETWORK_IN) AS NIN_MIN, MAX(H.NETWORK_IN) AS NIN_MAX,
            AVG(H.NETWORK_OUT) AS NOUT_AVG, MIN(H.NETWORK_OUT) AS NOUT_MIN, MAX(H.NETWORK_OUT) AS NOUT_MAX,
            MIN(H.SWAP_IN) AS SWAP_IN_MIN, AVG(H.SWAP_IN) AS SWAP_IN_AVG, MAX(H.SWAP_IN) AS SWAP_IN,
            MIN(H.SWAP_OUT) AS SWAP_OUT_MIN, AVG(H.SWAP_OUT) AS SWAP_OUT_AVG, MAX(H.SWAP_OUT) AS SWAP_OUT
     FROM _SYS_STATISTICS.HOST_LOAD_HISTORY_HOST H, P
     WHERE H.TIME >= P.T0
     GROUP BY FLOOR(SECONDS_BETWEEN(P.T0, H.TIME) / P.BS)
     ORDER BY 1`,
    [windowSec, bucketSec],
  );

  if (rows.length === 0) {
    // 窗口边界与"非空"分支取**同一个口径**：都来自库内时间（非空分支透传 TIME 的 MIN/MAX，
    // 这里没有行可取，就单独向库要一次窗口起止）。原先这里用 `new Date().toISOString()`（JS 的 UTC），
    // 与非空分支的库内值放在一起会得到两套时间基准——同一字段在不同分支含义不同，是最难发现的坑。
    let winFrom = '';
    let winTo = '';
    try {
      const w = await pool.query<{ T0: unknown; T1: unknown }>(
        'SELECT ADD_SECONDS(CURRENT_TIMESTAMP, -?) AS T0, CURRENT_TIMESTAMP AS T1 FROM DUMMY',
        [windowSec],
      );
      winFrom = String(w[0]?.T0 ?? '');
      winTo = String(w[0]?.T1 ?? '');
    } catch (e) {
      // 库内时钟都取不到时如实说明（window.from/to 留空）——不退回客户端时钟，避免两套基准
      logger.warn({ err: e }, '空窗口分支未能从库内取得窗口起止时刻');
      caveats.push('未能从库内取到窗口起止时刻（DUMMY 查询失败）：window.from/to 为空串。');
    }
    addCaveat(caveats, emptyIsAmbiguous(0, visibility.unfiltered));
    return {
      checkedAt: reportCheckedAt(),
      window: {
        from: winFrom,
        to: winTo,
        hours: req.hours,
        bucketMinutes: req.bucketMinutes,
        buckets: 0,
      },
      metrics: req.metrics,
      retention,
      points: [],
      summary: '指定窗口内没有任何历史采样点（可能是保留期设置过短，或统计服务未收集主机负载历史）。',
      visibility,
      caveats,
    };
  }

  const wanted = new Set(req.metrics);
  const points: TrendPoint[] = rows.map((r) => {
    const memLimit = num(r.MEM_LIMIT);
    const memTotal = num(r.MEM_TOTAL);
    const diskTotal = num(r.DISK_TOTAL);
    const values: Record<string, TrendValue> = {};
    const put = (key: string, min: unknown, max: unknown, avg: unknown, scale = 1, d = 2): void => {
      values[key] = {
        min: round(num(min) / scale, d),
        max: round(num(max) / scale, d),
        avg: round(num(avg) / scale, d),
      };
    };
    if (wanted.has('cpu')) put('cpuPct', r.CPU_MIN, r.CPU_MAX, r.CPU_AVG, 1, 1);
    if (wanted.has('memory')) {
      put('memoryUsedGiB', r.MEM_MIN, r.MEM_MAX, r.MEM_AVG, GIB);
      // 占配额比（与 Cockpit 的 "Used %" 同口径：实例已用 ÷ 分配配额，不是 ÷ 物理内存）
      put('memoryUsedPct', r.MEM_MIN, r.MEM_MAX, r.MEM_AVG, memLimit / 100, 2);
      values.memoryLimitGiB = { min: round(memLimit / GIB), max: round(memLimit / GIB), avg: round(memLimit / GIB) };
      values.physicalGiB = { min: round(memTotal / GIB), max: round(memTotal / GIB), avg: round(memTotal / GIB) };
    }
    if (wanted.has('disk')) {
      put('diskUsedGiB', r.DISK_MIN, r.DISK_MAX, r.DISK_AVG, GIB);
      put('diskUsedPct', r.DISK_MIN, r.DISK_MAX, r.DISK_AVG, diskTotal / 100, 2);
      values.diskTotalGiB = { min: round(diskTotal / GIB), max: round(diskTotal / GIB), avg: round(diskTotal / GIB) };
    }
    if (wanted.has('network')) {
      put('networkInKiB', r.NIN_MIN, r.NIN_MAX, r.NIN_AVG, KIB, 1);
      put('networkOutKiB', r.NOUT_MIN, r.NOUT_MAX, r.NOUT_AVG, KIB, 1);
    }
    if (wanted.has('swap')) {
      put('swapInBytes', r.SWAP_IN_MIN, r.SWAP_IN, r.SWAP_IN_AVG, 1, 0);
      put('swapOutBytes', r.SWAP_OUT_MIN, r.SWAP_OUT, r.SWAP_OUT_AVG, 1, 0);
    }
    return {
      index: num(r.BUCKET),
      from: String(r.B0 ?? ''),
      to: String(r.B1 ?? ''),
      samples: num(r.N),
      values,
    };
  });

  // 趋势判读：只看两件事——① 首尾桶的量级变化 ② 是否有 swap
  // 刻意**不给"上升就是坏"的简单结论**：内存/磁盘的自然增长未必异常（配额内），
  // 真正可行动的是"增长速率"与"是否接近配额"，故把它们放进 summary 供人判断。
  const first = points[0];
  const last = points[points.length - 1];
  const trendOf = (key: string): string => {
    const a = first.values[key]?.avg;
    const b = last.values[key]?.avg;
    if (a == null || b == null) return '';
    if (a === 0) return `${key} 起点为 0（无法算变化率）`;
    const delta = b - a;
    const pct = round((delta / Math.abs(a)) * 100, 1);
    const dir = Math.abs(pct) < 1 ? '基本持平' : delta > 0 ? '上升' : '下降';
    return `${key} ${a} → ${b}（${dir} ${Math.abs(pct)}%）`;
  };
  const parts = [trendOf('cpuPct'), trendOf('memoryUsedGiB'), trendOf('diskUsedGiB')].filter(Boolean);
  const swaps = points.reduce((s, p) => s + (p.values.swapInBytes?.max ?? 0) + (p.values.swapOutBytes?.max ?? 0), 0);

  if (retention && !retention.coversWindow) {
    caveats.push(`实际取到 ${points.length} 个桶（${first.from} → ${last.to}）。`);
  }
  if (swaps > 0) {
    caveats.push(`窗口内检测到 swap 活动（合计 ${swaps} 字节）——HANA 出现 swap 意味着物理内存不足，属明确异常信号。`);
  }
  if (req.bucketMinutes * 60 < 10) {
    caveats.push('桶宽小于采样间隔（约 10 秒），部分桶可能只有很少采样点，min/max 会显得跳动。');
  }

  return {
    checkedAt: reportCheckedAt(),
    window: {
      // 与非空分支同一口径：窗口边界即**库内 TIME 的首尾桶**（不是客户端时钟算出来的）
      from: first.from,
      to: last.to,
      hours: req.hours,
      bucketMinutes: req.bucketMinutes,
      buckets: points.length,
    },
    metrics: req.metrics,
    retention,
    points,
    summary:
      `${points.length} 个桶（每桶 ${req.bucketMinutes} 分钟，共 ${points.reduce((s, p) => s + p.samples, 0)} 个采样点）：` +
      (parts.length > 0 ? parts.join(' ｜ ') : '（未选择 cpu/memory/disk 指标）'),
    visibility,
    caveats,
  };
}
