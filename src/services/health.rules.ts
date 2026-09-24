/**
 * 稳定性健康检查的**规则表**（单一事实源）。
 *
 * 设计要点（每条都来自实机实测，见 docs/health-monitoring-findings.md）：
 *
 * 1. **数据化而非硬编码**：一条规则 = {id, 类别, 用途, 静默过滤?, run()}，引擎只负责调度与归并结论。
 *    新增检查项 = 加一条规则，不改引擎。
 *
 * 2. **每条规则自己认领"看不见"**：HANA 的 M_* 监视视图在权限不足时**静默返回空集而不报错**。
 *    若把空集当健康，缺权限的部署会得到一份"全绿"的假报告。故规则必须显式区分三种"看不见"：
 *      - 视图不存在（HANA 259）→ view_missing
 *      - 权限不足被拒（HANA 258）→ permission_denied
 *      - 权限不足被静默过滤成空集 → 由 `silentlyFiltered` + 引擎传入的 unfiltered 标记共同判定
 *    引擎负责把抛出的错误归一到 unknown，规则负责在"查得到但可能是被过滤的空集"时自己判。
 *
 * 3. **磁盘口径**：用 M_DISKS（文件系统容量）而非 M_DISK_USAGE（HANA 各用途已分配文件的大小占比）。
 *    实测后者在一台完全健康的机器上 7 类里 5 类都是 100%，按它报警会整机误报。见 §三 of findings。
 *
 * 4. **大表必带时间窗/聚合**：M_BACKUP_CATALOG 实测 258105 行、M_CS_TABLES 74836 行，
 *    任何无窗口的全表扫描都是事故。
 */

import type { HanaPool } from '../core/hana-client.js';

/** 单项检查的结论级别 */
export type FindingLevel =
  | 'ok'
  | 'info'
  /** 有异常但不致命 */
  | 'warn'
  /** 需要立即处理 */
  | 'critical'
  /** **看不见**——不是"正常"，是"无法判定"。绝不可折叠成 ok */
  | 'unknown';

/** unknown 的成因（让调用方知道"为什么没结论"，以及补什么能解锁） */
export type UnknownReason =
  /** 该 HANA 版本没有这个视图（换环境也不会出现） */
  | 'view_missing'
  /** 权限不足（语句被拒 258） */
  | 'permission_denied'
  /** 权限不足导致视图静默返回空集（无报错，最危险的一类） */
  | 'filtered'
  /** 功能未启用（如未配系统复制）——这是"确实没有"，不是"看不见" */
  | 'not_configured'
  /** 执行出错 */
  | 'error';

/**
 * 一条"读数"——与 finding 的区别：finding 回答"有没有问题"，metric 回答"现在是多少"。
 *
 * 为什么两者都要：只给结论的话，"内存正常"这种话无法回答"当前内存百分之多少"。
 * 规则即使判定为 ok 也必须把读数交出来，否则调用方只能看到绿灯、看不到仪表。
 */
export interface HealthMetric {
  /** 指标名（可读，如"主机内存使用率"） */
  name: string;
  value: number | string;
  /** 单位（% / GB / 秒 / 条 …）；无量纲时省略 */
  unit?: string;
  /** 补充读数（如 "304.6/536.6 GB"），便于一眼看到绝对值而不必去看 evidence */
  detail?: string;
  /** 取值来源视图，便于复核 */
  source: string;
}

/** 单项检查的结论 */
export interface HealthFinding {
  /** 规则 id，如 'disk.filesystem' */
  id: string;
  category: HealthCategory;
  level: FindingLevel;
  /** 一句话结论（可直接读） */
  title: string;
  /** 支撑该结论的实测数值（调用方可据此复核，而非只能相信结论） */
  evidence: Record<string, unknown>;
  /** 本次检查取到的具体读数（**即使 level=ok 也会有**） */
  metrics?: HealthMetric[];
  /** 下一步建议（仅在非 ok 时给） */
  advice?: string;
  /** 仅 level='unknown' 时有值 */
  unknownReason?: UnknownReason;
}

/** 检查类别（= 工具的 checks 参数取值） */
export type HealthCategory =
  | 'disk'
  | 'services'
  | 'backup'
  | 'memory'
  | 'cpu'
  | 'alerts'
  | 'blocked'
  | 'transactions'
  | 'replication'
  /** 配置漂移：参数违规、改了未重启生效、非默认层覆盖 */
  | 'config'
  /** 已弃用特性是否仍在使用（升级前风险，与"当前是否故障"无关） */
  | 'lifecycle'
  /** 数据/日志/备份加密状态（合规读数，不是稳定性判定） */
  | 'encryption';

/** 阈值（可被工具参数覆盖） */
export interface HealthThresholds {
  /** 文件系统使用率（%） */
  diskWarnPct: number;
  diskCritPct: number;
  /** 主机物理内存使用率（%） */
  memWarnPct: number;
  memCritPct: number;
  /** 主机 CPU 使用率（%） */
  cpuWarnPct: number;
  cpuCritPct: number;
  /** 距上次成功全备的小时数 */
  backupWarnHours: number;
  backupCritHours: number;
  /** 长事务持续时间（秒） */
  txWarnSec: number;
  txCritSec: number;
  /** 阻塞等待时长（秒） */
  blockedWarnSec: number;
  blockedCritSec: number;
  /**
   * 内存对象分配失败率（%，PUT_FAILURE_COUNT / PUT_COUNT）。
   * 用**比率**而非绝对次数：该计数器自实例启动起累计，绝对值随运行时长单调增长，
   * 拿绝对值定阈值等于"实例跑得越久越容易报警"。
   */
  memPutFailWarnPct: number;
  memPutFailCritPct: number;
  /** 内存对象收缩失败次数（FAILED_SHRINK_COUNT）≥ 该值即告警；健康机上实测恒为 0 */
  memShrinkFailWarn: number;
  /** 卷 IO 失败读写次数 ≥ 该值即告警（IO 错误是硬故障信号，实测健康机为 0） */
  ioFailedWarn: number;
  /** 卷阻塞写请求数 ≥ 该值即告警（写被阻塞意味着日志卷卡住，会拖停整库） */
  ioBlockedWriteWarn: number;
  /** 待重启生效的配置参数数 ≥ 该值即告警（改了没生效） */
  configRestartWarn: number;
  /** 在用的已弃用特性数 ≥ 该值即告警 */
  deprecatedFeatureWarn: number;
  /** 回报的明细条数上限 */
  topN: number;
}

/**
 * 默认阈值。取值依据：
 * - 磁盘 80/90：通用运维惯例；HANA 自身对内存告警的阈值实测为 95%/98%（见
 *   _SYS_STATISTICS.STATISTICS_ALERT_THRESHOLDS），故这里取更保守的 80/90 以便提前介入。
 * - CPU 80/95：CPU 打满会直接表现为响应时间劣化；80% 起提示，95% 视为饱和。
 * - 备份 24/72 小时：每日全备是 BW 系统的常规节奏，超过一天即需关注。
 * - 长事务 300/1800 秒：HANA 事务锁等待默认超时为 30 分钟（indexserver.ini [transaction]
 *   lock_wait_timeout），故 1800 秒与"会被强制回滚"的量级对齐。
 *
 * 后四项（内存对象 / 卷 IO / 配置 / 弃用特性）的阈值全部来自**健康机上的实测基线**，
 * 不是行业惯例抄来的。取值时刻意比实测基线宽 2~3 个数量级以避免误报——
 * 它们的价值在于"出现即异常"，而不在于逼近临界：
 * - memPutFail 0.01/0.1 %：实测健康机 2.1e-4 %（9670 次失败 / 45.8 亿次 put）
 * - memShrinkFail 1：实测健康机 FAILED_SHRINK_COUNT = 0（收缩失败 = 内存回收不动）
 * - ioFailed 1 / ioBlockedWrite 1：实测健康机 13 个卷的失败读写、短读、重试、阻塞写**全为 0**，
 *   且同期 TOTAL_WRITES = 559790 —— 计数器确实在走，故"0"是真的 0，不是没采集
 * - configRestart 1：改了未重启生效，实测健康机 0 项
 * - deprecatedFeature 1：实测健康机 25 条已弃用特性中 **7 条仍被调用**（累计 65.5 万次）
 */
export const DEFAULT_THRESHOLDS: HealthThresholds = {
  diskWarnPct: 80,
  diskCritPct: 90,
  memWarnPct: 80,
  memCritPct: 90,
  cpuWarnPct: 80,
  cpuCritPct: 95,
  backupWarnHours: 24,
  backupCritHours: 72,
  txWarnSec: 300,
  txCritSec: 1800,
  blockedWarnSec: 5,
  blockedCritSec: 60,
  memPutFailWarnPct: 0.01,
  memPutFailCritPct: 0.1,
  memShrinkFailWarn: 1,
  ioFailedWarn: 1,
  ioBlockedWriteWarn: 1,
  configRestartWarn: 1,
  deprecatedFeatureWarn: 1,
  topN: 5,
};

/** 规则运行上下文 */
export interface HealthRuleContext {
  pool: HanaPool;
  /**
   * 当前用户是否持有 CATALOG READ 或 MONITORING。
   * false 时，标了 silentlyFiltered 的视图**返回空集也不能当作"没有异常"**。
   */
  unfiltered: boolean;
  t: HealthThresholds;
}

/** 一条健康检查规则 */
export interface HealthRule {
  id: string;
  category: HealthCategory;
  /** 这条规则在查什么（进输出，让调用方知道覆盖了什么） */
  purpose: string;
  /**
   * 该视图在缺少 CATALOG READ/MONITORING 时是否会被静默过滤成空集。
   * 决定"查得到 0 行"该判 ok 还是判 filtered。
   */
  silentlyFiltered: boolean;
  run(ctx: HealthRuleContext): Promise<HealthFinding>;
}

/** 数值归一：HANA 的 DECIMAL/BIGINT 经驱动可能回来是字符串 */
const num = (v: unknown): number => (v == null ? 0 : Number(v));
/** 保留小数位（避免 evidence 里出现 18 位浮点尾巴） */
const round = (v: number, d = 2): number => Number(v.toFixed(d));

/**
 * 字节 → **GiB**（1024³）。
 *
 * 单位选择不是风格问题：HANA Cockpit / HANA Studio 的"Used Memory 451.00 / Total Disk Size 499.76"
 * 全部是 GiB。若这里按 GB(10⁹) 输出，同一台机器同一时刻会显示 484.26 / 536.60，
 * 而比值恒为 2³⁰/10⁹ = 1.0737 —— DBA 拿工具的数字去和 Cockpit 核对时会以为读错了库。
 * 故一律用 GiB，并在单位标签里写明。
 */
const GIB = 1024 ** 3;
const toGiB = (bytes: unknown, d = 2): number => round(num(bytes) / GIB, d);

/** 按阈值给级别 */
function grade(value: number, warn: number, crit: number): FindingLevel {
  if (value >= crit) return 'critical';
  if (value >= warn) return 'warn';
  return 'ok';
}

/**
 * 时长的可读格式化（秒 → 天/小时/分钟/秒）。
 * 长事务动辄持续数十万秒（实测有个从系统启动起就挂着的，323 天），
 * 直接报秒数或分钟数没有可读性，会让读者跳过这个结论。
 */
export function formatDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return '未知';
  if (sec < 60) return `${round(sec, 1)} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  if (sec < 86400) return `${round(sec / 3600, 1)} 小时`;
  return `${round(sec / 86400, 1)} 天`;
}

/**
 * 多个级别取最重。
 *
 * ⚠ **顺序里必须有 `unknown`**。早先的实现写的是 `['ok','info','warn','critical']`——
 * 漏了 unknown，于是 `indexOf('unknown')` 返回 -1，它**永远输给任何其它级别**：
 * 只要其余分项是 ok，整条规则就报 ok。这与本项目存在的理由（"看不见 ≠ 没问题"）直接冲突，
 * 而且因为它发生在**聚合层**而不是某条规则里，比规则内部的同类错误更难发现——
 * 规则各自都写对了（`usedPct < 0 ? 'unknown' : grade(...)`），是汇总时把它丢掉的。
 *
 * 分级与引擎的 `computeVerdict` 保持一致：critical > warn > unknown > info > ok
 * （即 warn 优先于 unknown，因为"确实有问题"比"看不出来"更该先说）。
 */
function worst(levels: FindingLevel[]): FindingLevel {
  const order: FindingLevel[] = ['ok', 'info', 'unknown', 'warn', 'critical'];
  return levels.reduce<FindingLevel>((a, b) => (order.indexOf(b) > order.indexOf(a) ? b : a), 'ok');
}

/**
 * "查得到但 0 行"时的兜底判定。
 * 有这个 helper 是因为：**空集是歧义的**——可能是真没有，也可能是权限把行滤掉了。
 * 只有在确认"未被过滤"（unfiltered=true）时，0 行才能当作"确实没有"。
 *
 * @param what 该项在读数里的名字（unknown 时用来说明"哪一项读不到"）
 */
function emptyMeans(
  ctx: HealthRuleContext,
  rule: HealthRule,
  whatIfAbsent: HealthFinding,
  what?: string,
): HealthFinding {
  if (rule.silentlyFiltered && !ctx.unfiltered) {
    return {
      id: rule.id,
      category: rule.category,
      level: 'unknown',
      title: `无法判定：该视图对当前用户不可见（缺 CATALOG READ / MONITORING）`,
      evidence: { 说明: '视图可查询但返回空集，且当前用户不具备解除行过滤所需的权限' },
      // 读数留痕：让"看不到"这件事本身可见，而不是让该项从 metrics 里静默消失
      metrics: what ? [{ name: what, value: '无法判定', detail: '视图被权限过滤成空集', source: '—' }] : undefined,
      unknownReason: 'filtered',
      advice: '为该 HANA 用户授予 MONITORING 角色或 CATALOG READ 系统权限后重试。'
        + '在此之前，本项的空结果不能读作"正常"。',
    };
  }
  return whatIfAbsent;
}

// ────────────────────────────────────────────────────────────
// 各规则的实现
// ────────────────────────────────────────────────────────────

/**
 * 一个**附加读数层**取不到数据时的留痕。
 *
 * 与 `emptyMeans` 的分工：那个处理"整项判不了"，这个处理"主结论仍成立、但这一层没读到"。
 *
 * 为什么必须留痕：实测受限环境上 `M_MEMORY_OBJECTS` 是**返回 0 行而不是报错**（环境 A 0 行 vs
 * 环境 B 306 行），若只是 `if (行数 > 0) { push 读数 }`，这一层会从 `metrics` 里**静默消失**——
 * 读者看到一份看似完整的读数，却不知道里面少了一块。这正是本项目最反对的那种"看不见 = 没问题"。
 *
 * @param carriesJudgment 该层是否参与判级。
 *   true（内存对象层、卷 IO 层）——取不到就不能给"正常"的结论，返回 `unknown`；
 *   false（卷文件用量这类**明确不判级**的纯读数）——只留痕，不影响结论级别。
 */
export function emptyLayer(
  ctx: HealthRuleContext,
  name: string,
  source: string,
  carriesJudgment: boolean,
): { metric: HealthMetric; level: FindingLevel } {
  return {
    metric: {
      name,
      value: '无法判定',
      detail: ctx.unfiltered
        ? '视图返回空集。该实例正在运行时本不应为空，请核对视图名与版本——此层未取到数据，不代表正常'
        : '视图返回空集，且当前用户不具备解除行过滤所需的权限（缺 CATALOG READ / MONITORING）'
          + '——此层未取到数据，**不代表正常**',
      source,
    },
    level: carriesJudgment ? 'unknown' : 'ok',
  };
}

const diskRule: HealthRule = {
  id: 'disk.filesystem',
  category: 'disk',
  purpose: '各挂载点文件系统使用率 + 各用途卷大小（来源 SYS.M_DISKS / SYS.M_DISK_USAGE）',
  silentlyFiltered: true,
  async run(ctx) {
    // 口径一：M_DISKS 的 TOTAL_SIZE/USED_SIZE 是**文件系统容量与已用**——判"磁盘还剩多少"看这里。
    // 同一挂载点上多个 USAGE_TYPE 会各占一行且数值相同（如 /backup 同时是
    // DATA_BACKUP 与 LOG_BACKUP+CATALOG_BACKUP），故按 (HOST, MOUNT_PATH) 聚合取 MAX，
    // 用 SUM 会重复计数。
    const rows = await ctx.pool.query<{
      HOST: string; MOUNT_PATH: string; TOTAL: unknown; USED: unknown; TYPES: unknown;
    }>(
      `SELECT HOST, MOUNT_PATH, MAX(TOTAL_SIZE) AS TOTAL, MAX(USED_SIZE) AS USED,
              COUNT(DISTINCT USAGE_TYPE) AS TYPES
       FROM SYS.M_DISKS
       GROUP BY HOST, MOUNT_PATH
       ORDER BY (MAX(USED_SIZE) * 1.0 / NULLIF(MAX(TOTAL_SIZE), 0)) DESC`,
    );
    if (rows.length === 0) {
      return emptyMeans(ctx, diskRule, {
        id: diskRule.id, category: 'disk', level: 'unknown',
        title: '未取得任何文件系统信息',
        evidence: {}, unknownReason: 'error',
      }, '文件系统使用率');
    }
    // 口径二：M_DISK_USAGE.FILE_SIZE 是该用途**卷文件**的大小（HANA 分配给它的空间），
    // 与文件系统剩余空间无关（写满自己是常态，实测 7 类里 5 类接近 100%）。
    // 但它本身是有意义的读数——HANA Cockpit 概览页的 "Data/Log/Trace Volume Size" 就是它。
    // 下面把两个口径按 USAGE_TYPE 配对，给出与 Cockpit 磁盘卡片一致的三元组。
    const volRows = await ctx.pool.query<{ HOST: string; USAGE_TYPE: string; VOL: unknown }>(
      `SELECT HOST, USAGE_TYPE, MAX(FILE_SIZE) AS VOL FROM SYS.M_DISK_USAGE GROUP BY HOST, USAGE_TYPE`,
    );
    const fsRows = await ctx.pool.query<{
      HOST: string; MOUNT_PATH: string; USAGE_TYPE: string; TOTAL: unknown; USED: unknown;
    }>(
      `SELECT HOST, MOUNT_PATH, USAGE_TYPE, MAX(TOTAL_SIZE) AS TOTAL, MAX(USED_SIZE) AS USED
       FROM SYS.M_DISKS GROUP BY HOST, MOUNT_PATH, USAGE_TYPE`,
    );
    const volOf = (row: { HOST: string; USAGE_TYPE: string }): number =>
      num(volRows.find((v) => v.HOST === row.HOST && v.USAGE_TYPE === row.USAGE_TYPE)?.VOL);

    const mounts = rows.map((r) => ({
      host: r.HOST,
      mount: r.MOUNT_PATH,
      usedGiB: toGiB(r.USED, 1),
      totalGiB: toGiB(r.TOTAL, 1),
      usedPct: num(r.TOTAL) > 0 ? round((num(r.USED) / num(r.TOTAL)) * 100, 1) : -1,
      usageTypes: num(r.TYPES),
    }));
    // 卷三元组：按 USAGE_TYPE 与文件系统配对（Cockpit 磁盘卡片的形状）
    const volumes = fsRows
      .filter((f) => !f.USAGE_TYPE.includes('+')) // 复合类型（LOG_BACKUP+CATALOG_BACKUP）无法一对一配对
      .map((f) => ({
        用途: f.USAGE_TYPE,
        挂载点: f.MOUNT_PATH,
        卷大小GiB: toGiB(volOf(f)),
        文件系统已用GiB: toGiB(f.USED, 1),
        文件系统总量GiB: toGiB(f.TOTAL, 1),
        使用率: num(f.TOTAL) > 0 ? round((num(f.USED) / num(f.TOTAL)) * 100, 1) : -1,
      }))
      .sort((a, b) => b.文件系统已用GiB - a.文件系统已用GiB);

    // ── 卷 IO 层：容量回答"还剩多少"，回答不了"盘慢不慢" ──────────────
    // M_VOLUME_IO_TOTAL_STATISTICS 一份带失败读写、短读、重试读写、阻塞写请求与 IO 时间。
    //   • 失败读写 = **硬故障信号**（坏道、路径抖动、多路径切换），>0 就是出过错
    //   • 阻塞写请求 = 最危险的一条：日志卷写被阻塞会直接把整库挂起
    // 实测健康机（13 个卷）失败读写/短读/重试/阻塞写**全为 0**，而同期 TOTAL_WRITES = 559790
    // —— 计数器确实在走，所以那个 0 是真的 0，不是"没采集"。
    const ioMetrics: HealthMetric[] = [];
    let ioLevel: FindingLevel = 'ok';
    try {
      const io = await ctx.pool.query<Record<string, unknown>>(
        `SELECT SUM(TOTAL_FAILED_READS) AS FR, SUM(TOTAL_FAILED_WRITES) AS FW,
                SUM(TOTAL_SHORT_READS) AS SR, SUM(TOTAL_SHORT_WRITES) AS SW,
                SUM(TOTAL_FULL_RETRY_READS) AS RR, SUM(TOTAL_FULL_RETRY_WRITES) AS RW,
                SUM(BLOCKED_WRITE_REQUESTS) AS BW, MAX(MAX_BLOCKED_WRITE_REQUESTS) AS MBW,
                SUM(TOTAL_READS) AS R, SUM(TOTAL_WRITES) AS W,
                SUM(TOTAL_IO_TIME) AS IOT, COUNT(*) AS N
         FROM SYS.M_VOLUME_IO_TOTAL_STATISTICS`,
      );
      const v = io[0];
      if (num(v?.N) === 0) {
        // 附加层取不到 → 必须留痕；本层参与判级（失败读写是硬故障信号），故同时降为 unknown
        const el = emptyLayer(ctx, '卷 IO 健康', 'SYS.M_VOLUME_IO_TOTAL_STATISTICS', true);
        ioMetrics.push(el.metric);
        ioLevel = el.level;
      } else {
        const failed = num(v.FR) + num(v.FW);
        const blocked = num(v.BW);
        const soft = num(v.SR) + num(v.SW) + num(v.RR) + num(v.RW);
        ioLevel = worst([
          failed >= ctx.t.ioFailedWarn ? 'warn' : 'ok',
          blocked >= ctx.t.ioBlockedWriteWarn ? 'warn' : 'ok',
        ]);
        ioMetrics.push(
          {
            name: '卷读写失败次数',
            value: failed,
            unit: '次',
            detail: `读失败 ${num(v.FR)} / 写失败 ${num(v.FW)}（共 ${num(v.N)} 个卷；`
              + `累计读 ${num(v.R)} 次、写 ${num(v.W)} 次）。非零即说明存储链路出过错`,
            source: 'SYS.M_VOLUME_IO_TOTAL_STATISTICS',
          },
          {
            name: '卷阻塞写请求',
            value: blocked,
            unit: '次',
            detail: `历史峰值 ${num(v.MBW)} 次。写被阻塞会拖停整库（尤其日志卷）`,
            source: 'SYS.M_VOLUME_IO_TOTAL_STATISTICS',
          },
          {
            name: '卷 IO 软异常',
            value: soft,
            unit: '次',
            detail: `短读 ${num(v.SR)}、短写 ${num(v.SW)}、整块重试读 ${num(v.RR)}、重试写 ${num(v.RW)}`
              + '（重试成功通常无感，持续增长则说明链路不稳）',
            source: 'SYS.M_VOLUME_IO_TOTAL_STATISTICS',
          },
          {
            name: '卷累计 IO 时间',
            value: round(num(v.IOT) / 1e6, 1),
            unit: '秒',
            detail: '各卷 TOTAL_IO_TIME 合计（微秒→秒）',
            source: 'SYS.M_VOLUME_IO_TOTAL_STATISTICS',
          },
        );
      }
    } catch (e) {
      ioMetrics.push({
        name: '卷 IO 健康',
        value: '无法判定',
        detail: `M_VOLUME_IO_TOTAL_STATISTICS 不可读（${String((e as { message?: string })?.message ?? e).slice(0, 120)}）；`
          + '该视图需 MONITORING / CATALOG READ。缺它只影响 IO 层读数，不影响上方容量结论',
        source: 'SYS.M_VOLUME_IO_TOTAL_STATISTICS',
      });
    }

    // 卷文件用量：**与 M_DISK_USAGE 同一个陷阱**——卷文件是 HANA 预分配的，写满自己是常态。
    // 实测本机 LOG 卷 106 个文件 8.77/8.77 GiB = 100%，而 /hana/log 文件系统只用了 6.5%。
    // 故这里**只给读数、不参与判级**，并在 detail 里写明它不能被读成"磁盘满了"。
    try {
      const vf = await ctx.pool.query<{ FILE_TYPE: string; N: unknown; U: unknown; T: unknown }>(
        `SELECT FILE_TYPE, COUNT(*) AS N, SUM(USED_SIZE) AS U, SUM(TOTAL_SIZE) AS T
         FROM SYS.M_VOLUME_FILES GROUP BY FILE_TYPE ORDER BY SUM(TOTAL_SIZE) DESC`,
      );
      const parts = vf.filter((f) => num(f.T) > 0).map((f) => {
        const pct = round((num(f.U) / num(f.T)) * 100, 1);
        return {
          文件类型: f.FILE_TYPE,
          文件数: num(f.N),
          已用GiB: toGiB(f.U, 1),
          总量GiB: toGiB(f.T, 1),
          占比: pct,
        };
      });
      if (parts.length === 0) {
        // 卷文件用量是**明确不判级**的纯读数（预分配写满属常态），故取不到只留痕、不降级
        ioMetrics.push(emptyLayer(ctx, '卷文件用量', 'SYS.M_VOLUME_FILES', false).metric);
      } else {
        ioMetrics.push({
          name: '卷文件用量',
          value: parts.map((p) => `${p.文件类型} ${p.占比}%`).join(' ｜ '),
          detail: parts.map((p) => `${p.文件类型}: ${p.已用GiB}/${p.总量GiB} GiB（${p.文件数} 个文件）`).join('；')
            + '。**此读数不参与判级**：卷文件由 HANA 预分配，接近 100% 属常态，'
            + '判容量只看上方的文件系统使用率',
          source: 'SYS.M_VOLUME_FILES',
        });
      }
    } catch { /* 卷文件明细取不到不影响容量判定 */ }

    const level = worst([
      ...mounts.map((m) => (m.usedPct < 0
        ? 'unknown' as FindingLevel
        : grade(m.usedPct, ctx.t.diskWarnPct, ctx.t.diskCritPct))),
      ioLevel,
    ]);
    const peak = mounts.reduce((a, b) => (b.usedPct > a.usedPct ? b : a), mounts[0]);
    const ioFailedTotal = ioMetrics.find((m) => m.name === '卷读写失败次数')?.value;
    const ioBlockedTotal = ioMetrics.find((m) => m.name === '卷阻塞写请求')?.value;
    return {
      id: diskRule.id,
      category: 'disk',
      level,
      title: ioLevel !== 'ok'
        ? `卷 IO 出现异常：${num(ioFailedTotal) > 0 ? `读写失败 ${ioFailedTotal} 次` : ''}`
          + `${num(ioBlockedTotal) > 0 ? `${num(ioFailedTotal) > 0 ? '，' : ''}阻塞写请求 ${ioBlockedTotal} 次` : ''}`
          + `（容量侧最高使用率 ${peak.usedPct}%，${peak.mount}）`
        : level === 'ok'
          ? `文件系统剩余空间充足（最高使用率 ${peak.usedPct}%，${peak.mount}）`
          : `文件系统使用率偏高：${peak.mount} 已用 ${peak.usedPct}%（${peak.usedGiB}/${peak.totalGiB} GiB）`,
      evidence: {
        阈值: `文件系统 warn ${ctx.t.diskWarnPct}% / critical ${ctx.t.diskCritPct}%；`
          + `卷读写失败 ≥ ${ctx.t.ioFailedWarn} 次即告警；阻塞写 ≥ ${ctx.t.ioBlockedWriteWarn} 次即告警`,
        挂载点: mounts,
        卷与文件系统: volumes,
        说明: '"卷大小"是 HANA 分配给该用途的文件大小（M_DISK_USAGE.FILE_SIZE），'
          + '与"文件系统还剩多少"无关，接近满属正常；判容量只看使用率。单位统一为 GiB（与 HANA Cockpit 一致）。'
          + '本项同时给**容量**（还剩多少）与**IO**（盘稳不稳）两个正交读数：'
          + '容量充足但读写失败非零，说明存储链路有问题而不是空间不够。',
      },
      metrics: [
        ...mounts.map((m) => ({
          name: `文件系统 ${m.mount}`,
          value: m.usedPct,
          unit: '%',
          detail: `已用 ${m.usedGiB} / 总量 ${m.totalGiB} GiB`,
          source: 'SYS.M_DISKS',
        })),
        ...volumes.filter((v) => v.卷大小GiB > 0).map((v) => ({
          name: `卷大小 ${v.用途}`,
          value: v.卷大小GiB,
          unit: 'GiB',
          detail: `挂载点 ${v.挂载点}，该文件系统已用 ${v.文件系统已用GiB}/${v.文件系统总量GiB} GiB（${v.使用率}%）`,
          source: 'SYS.M_DISK_USAGE',
        })),
        ...ioMetrics,
      ],
      advice: level === 'ok' ? undefined
        : ioLevel !== 'ok'
          ? '卷 IO 出错要先查存储侧，不是查数据库：确认多路径状态、HBA/交换机链路、存储端告警。'
            + '**阻塞写请求尤其要紧**——日志卷写阻塞会直接挂起整库，出现即需立即介入。'
            + '失败读写非零时建议同时核对操作系统层面的 IO 日志。'
          : '优先处理 /hana/log（日志卷写满会导致整库挂起）；备份卷可清理过期备份集（backup catalog 中已删除的条目对应的文件）。'
            + '注意：不要用 M_DISK_USAGE 的 FILE_SIZE 占比判断容量，那是卷文件自身的大小占比，接近 100% 属正常。',
    };
  },
};

const cpuRule: HealthRule = {
  id: 'cpu.utilization',
  category: 'cpu',
  purpose: '主机 CPU 使用率与数据库服务占用（来源 _SYS_STATISTICS.HOST_RESOURCE_UTILIZATION_STATISTICS / '
    + 'SYS.M_SERVICE_STATISTICS）',
  // 统计服务视图需 _SYS_STATISTICS 的 SELECT；缺权限时会报 258（由引擎归一为 unknown）
  silentlyFiltered: true,
  async run(ctx) {
    // CPU 无法单次读出一个百分比：M_HOST_RESOURCE_UTILIZATION 的 TOTAL_CPU_*_TIME 是从开机起的
    // **累计计数器**，一次采样只能得到绝对值。
    // 正解是用统计服务：HOST_RESOURCE_UTILIZATION_STATISTICS 按 ~60 秒落一次快照，
    // 并把相邻两次的差值**预先算好**放在 *_DELTA 列里 —— 取最近一行就能直接得出区间 CPU 使用率。
    let hostPct = -1;
    let window: { snapshot: string; seconds: number; idle: number; sys: number; user: number; wio: number } | null = null;
    let statsErr: string | null = null;
    let statsErrCode = '';
    try {
      const rows = await ctx.pool.query<{
        SERVER_TIMESTAMP: string; SNAPSHOT_DELTA: unknown; TOTAL_CPU_IDLE_TIME_DELTA: unknown;
        TOTAL_CPU_SYSTEM_TIME_DELTA: unknown; TOTAL_CPU_USER_TIME_DELTA: unknown; TOTAL_CPU_WIO_TIME_DELTA: unknown;
      }>(
        `SELECT SERVER_TIMESTAMP, SNAPSHOT_DELTA, TOTAL_CPU_IDLE_TIME_DELTA,
                TOTAL_CPU_SYSTEM_TIME_DELTA, TOTAL_CPU_USER_TIME_DELTA, TOTAL_CPU_WIO_TIME_DELTA
         FROM _SYS_STATISTICS.HOST_RESOURCE_UTILIZATION_STATISTICS
         ORDER BY SERVER_TIMESTAMP DESC LIMIT 1`,
      );
      if (rows.length > 0) {
        const d = rows[0];
        const idle = num(d.TOTAL_CPU_IDLE_TIME_DELTA);
        const sys = num(d.TOTAL_CPU_SYSTEM_TIME_DELTA);
        const user = num(d.TOTAL_CPU_USER_TIME_DELTA);
        const wio = num(d.TOTAL_CPU_WIO_TIME_DELTA);
        const total = idle + sys + user + wio;
        if (total > 0) hostPct = round(((total - idle) / total) * 100, 2);
        window = { snapshot: d.SERVER_TIMESTAMP, seconds: round(num(d.SNAPSHOT_DELTA) / 1000), idle, sys, user, wio };
      }
    } catch (e) {
      statsErr = String((e as { message?: string })?.message ?? e);
      statsErrCode = String((e as { code?: string })?.code ?? '');
    }

    // 数据库服务自身的 CPU：各服务 PROCESS_CPU 之和（-1 = 该服务不提供，剔除）
    const svc = await ctx.pool.query<{ SERVICE_NAME: string; PROCESS_CPU: unknown; TOTAL_CPU: unknown }>(
      `SELECT SERVICE_NAME, PROCESS_CPU, TOTAL_CPU FROM SYS.M_SERVICE_STATISTICS`,
    );
    const svcCpu = svc.filter((s) => num(s.PROCESS_CPU) >= 0);
    const dbPct = svcCpu.reduce((sum, s) => sum + num(s.PROCESS_CPU), 0);
    const top = svcCpu.slice().sort((a, b) => num(b.PROCESS_CPU) - num(a.PROCESS_CPU)).slice(0, ctx.t.topN);

    if (hostPct < 0) {
      // 成因按错误码分：259 是"该版本没这个视图"（授予权限也没用），258 才是缺权限。
      // 早先这里一律标 permission_denied，会把版本差异误导成"去加权限"。
      const reason: UnknownReason = statsErrCode === '259'
        ? 'view_missing'
        : statsErrCode === '258' || statsErrCode === '7' ? 'permission_denied' : 'error';
      return {
        id: cpuRule.id, category: 'cpu', level: 'unknown',
        title: reason === 'view_missing'
          ? '无法判定：该 HANA 版本没有 CPU 统计视图（版本差异，非权限问题）'
          : '无法判定：取不到 CPU 使用率（需要 _SYS_STATISTICS 的 SELECT 权限）',
        evidence: { 统计服务查询错误: statsErr, 错误码: statsErrCode, 规则用途: cpuRule.purpose },
        metrics: [{ name: 'CPU 使用率', value: '无法判定', detail: statsErr ?? '统计服务无快照', source: '—' }],
        unknownReason: reason,
        advice: reason === 'view_missing'
          ? '这是版本能力差异，授予权限也读不到；请对照目标 HANA 版本的统计服务视图清单。'
          : '授予该用户 _SYS_STATISTICS 的 SELECT（或 MONITORING 角色）后可读。'
            + 'M_HOST_RESOURCE_UTILIZATION 的 CPU 列是从开机起的累计计数器，单次读取算不出百分比，故不能替代。',
      };
    }
    const level = grade(hostPct, ctx.t.cpuWarnPct, ctx.t.cpuCritPct);
    return {
      id: cpuRule.id,
      category: 'cpu',
      level,
      title: level === 'ok'
        ? `CPU 充裕：主机使用率 ${hostPct}%（数据库服务合计 ${dbPct}%）`
        : `主机 CPU 使用率偏高：${hostPct}%（数据库服务合计 ${dbPct}%）`,
      evidence: {
        阈值: `warn ${ctx.t.cpuWarnPct}% / critical ${ctx.t.cpuCritPct}%`,
        统计窗口: window,
        服务CPU: svcCpu.map((s) => ({ 服务: s.SERVICE_NAME, CPU: `${num(s.PROCESS_CPU)}%` })),
        说明: '主机 CPU 来自统计服务的相邻快照差值（区间均值，非瞬时值），'
          + '与 HANA Cockpit 概览页同源；数据库服务 CPU 是各服务 PROCESS_CPU 之和（daemon 等不提供该值的以 -1 剔除）',
      },
      metrics: [
        {
          name: '主机 CPU 使用率', value: hostPct, unit: '%',
          detail: window
            ? `统计区间 ${window.snapshot}（${window.seconds} 秒）：idle ${window.idle} / sys ${window.sys} / user ${window.user} / wio ${window.wio}`
            : undefined,
          source: '_SYS_STATISTICS.HOST_RESOURCE_UTILIZATION_STATISTICS',
        },
        {
          name: '数据库服务 CPU 合计', value: dbPct, unit: '%',
          detail: top.map((s) => `${s.SERVICE_NAME} ${num(s.PROCESS_CPU)}%`).join('、') || '（无）',
          source: 'SYS.M_SERVICE_STATISTICS',
        },
      ],
      advice: level === 'ok' ? undefined
        : 'CPU 饱和会直接表现为响应时间劣化。用 hana_system_activity 看是否有长语句在跑；'
          + '用 hana_sql_analyze 分析高代价语句的执行计划（planId 模式可分析已执行过的语句）。',
    };
  },
};

const servicesRule: HealthRule = {
  id: 'services.status',
  category: 'services',
  purpose: '各服务进程的运行状态（来源 SYS.M_SERVICES）',
  // M_SERVICES 不需要监控权限，任何用户都能看到全部服务
  silentlyFiltered: false,
  async run(ctx) {
    const rows = await ctx.pool.query<{
      SERVICE_NAME: string; HOST: string; ACTIVE_STATUS: string; COORDINATOR_TYPE: string;
    }>('SELECT SERVICE_NAME, HOST, ACTIVE_STATUS, COORDINATOR_TYPE FROM SYS.M_SERVICES ORDER BY SERVICE_NAME');
    if (rows.length === 0) {
      return {
        id: servicesRule.id, category: 'services', level: 'unknown',
        title: '未取得任何服务信息（M_SERVICES 返回空）',
        evidence: {}, unknownReason: 'error',
      };
    }
    const down = rows.filter((r) => r.ACTIVE_STATUS !== 'YES');
    return {
      id: servicesRule.id,
      category: 'services',
      level: down.length > 0 ? 'critical' : 'ok',
      title: down.length > 0
        ? `${down.length} 个服务未处于 ACTIVE 状态：${down.map((d) => d.SERVICE_NAME).join(', ')}`
        : `${rows.length} 个服务全部处于 ACTIVE 状态`,
      evidence: {
        服务总数: rows.length,
        非活动: down.map((d) => ({ 服务: d.SERVICE_NAME, 主机: d.HOST, 状态: d.ACTIVE_STATUS })),
        服务清单: rows.map((r) => `${r.SERVICE_NAME}@${r.HOST}${r.COORDINATOR_TYPE === 'MASTER' ? '(master)' : ''}`),
      },
      metrics: [
        { name: '服务总数', value: rows.length, unit: '个', source: 'SYS.M_SERVICES' },
        { name: '非 ACTIVE 服务', value: down.length, unit: '个', source: 'SYS.M_SERVICES' },
      ],
      advice: down.length > 0
        ? '服务未启动/未就绪会直接导致连接失败或功能不可用。检查对应服务的 trace 文件与崩溃转储，必要时用 HANA Cockpit 重启该服务。'
        : undefined,
    };
  },
};

const backupRule: HealthRule = {
  id: 'backup.last_success',
  category: 'backup',
  purpose: '距上次成功全量备份的时长 + 近期失败备份数（来源 SYS.M_BACKUP_CATALOG）',
  silentlyFiltered: true,
  async run(ctx) {
    // 必须带时间窗：该视图实测 258105 行，无窗口的 ORDER BY 会拖全表。
    // 90 天窗口足以覆盖"最后一次成功全备"，若窗内为空则本身就说明备份长期未成功。
    const last = await ctx.pool.query<{
      ENTRY_TYPE_NAME: string; STATE_NAME: string; SYS_START_TIME: string; BACKUP_ID: unknown;
    }>(
      `SELECT ENTRY_TYPE_NAME, STATE_NAME, SYS_START_TIME, BACKUP_ID
       FROM SYS.M_BACKUP_CATALOG
       WHERE ENTRY_TYPE_NAME = 'complete data backup' AND STATE_NAME = 'successful'
         AND SYS_START_TIME > ADD_DAYS(CURRENT_TIMESTAMP, -90)
       ORDER BY SYS_START_TIME DESC LIMIT 1`,
    );
    const failed = await ctx.pool.query<{ N: unknown }>(
      `SELECT COUNT(*) AS N FROM SYS.M_BACKUP_CATALOG
       WHERE STATE_NAME = 'failed' AND SYS_START_TIME > ADD_DAYS(CURRENT_TIMESTAMP, -7)`,
    );
    const failedN = num(failed[0]?.N);

    if (last.length === 0) {
      // 空集是歧义的：可能真没备份，也可能被权限滤掉了
      return emptyMeans(ctx, backupRule, {
        id: backupRule.id, category: 'backup', level: 'critical',
        title: '近 90 天内没有成功的全量备份记录',
        evidence: { 查询窗口: '90 天', 近期失败备份数: failedN },
        metrics: [
          { name: '距上次成功全备', value: '90 天以上或从未', source: 'SYS.M_BACKUP_CATALOG' },
          { name: '近 7 天失败备份', value: failedN, unit: '次', source: 'SYS.M_BACKUP_CATALOG' },
        ],
        advice: '数据库当前不具备可恢复性。立即确认备份任务是否在运行（HANA Cockpit → Backup，'
          + '或检查 backint/SQL 备份脚本），并尽快完成一次全量备份 + 日志备份。',
      }, '距上次成功全备');
    }
    const ageHours = await ctx.pool.query<{ H: unknown }>(
      `SELECT SECONDS_BETWEEN(SYS_START_TIME, CURRENT_TIMESTAMP) / 3600.0 AS H
       FROM SYS.M_BACKUP_CATALOG WHERE BACKUP_ID = ? LIMIT 1`,
      [num(last[0].BACKUP_ID)],
    );
    const hours = round(num(ageHours[0]?.H), 1);
    const level = grade(hours, ctx.t.backupWarnHours, ctx.t.backupCritHours);
    const failLevel: FindingLevel = failedN > 0 ? 'warn' : 'ok';
    const finalLevel = worst([level, failLevel]);
    return {
      id: backupRule.id,
      category: 'backup',
      level: finalLevel,
      title: finalLevel === 'ok'
        ? `备份正常：上次成功全备于 ${round(hours / 24, 1)} 天前，近 7 天无失败记录`
        : `备份需关注：上次成功全备于 ${round(hours / 24, 1)} 天前（${hours} 小时）`
          + (failedN > 0 ? `，近 7 天有 ${failedN} 次失败` : ''),
      evidence: {
        阈值: `warn ${ctx.t.backupWarnHours}h / critical ${ctx.t.backupCritHours}h`,
        上次成功全备: last[0].SYS_START_TIME,
        距今小时: hours,
        备份ID: String(last[0].BACKUP_ID),
        近7天失败数: failedN,
      },
      metrics: [
        {
          name: '距上次成功全备',
          value: round(hours / 24, 2),
          unit: '天',
          detail: `${hours} 小时（${last[0].SYS_START_TIME}）`,
          source: 'SYS.M_BACKUP_CATALOG',
        },
        { name: '近 7 天失败备份', value: failedN, unit: '次', source: 'SYS.M_BACKUP_CATALOG' },
      ],
      advice: finalLevel === 'ok' ? undefined
        : '检查备份任务是否按计划执行、备份卷是否有足够空间；失败条目可在 SYS.M_BACKUP_CATALOG 中按 STATE_NAME=\'failed\' 查看 MESSAGE 列的具体原因。',
    };
  },
};

const memoryRule: HealthRule = {
  id: 'memory.host',
  category: 'memory',
  purpose: '主机物理内存、实例内存占配额比与驻留内存（来源 SYS.M_HOST_RESOURCE_UTILIZATION / '
    + 'SYS.M_SERVICE_MEMORY / _SYS_STATISTICS.HOST_LOAD_HISTORY_HOST）',
  silentlyFiltered: true,
  async run(ctx) {
    const rows = await ctx.pool.query<{
      HOST: string; FREE_PHYSICAL_MEMORY: unknown; USED_PHYSICAL_MEMORY: unknown;
      ALLOCATION_LIMIT: unknown; INSTANCE_TOTAL_MEMORY_USED_SIZE: unknown;
      INSTANCE_TOTAL_MEMORY_PEAK_USED_SIZE: unknown;
    }>(
      `SELECT HOST, FREE_PHYSICAL_MEMORY, USED_PHYSICAL_MEMORY, ALLOCATION_LIMIT,
              INSTANCE_TOTAL_MEMORY_USED_SIZE, INSTANCE_TOTAL_MEMORY_PEAK_USED_SIZE
       FROM SYS.M_HOST_RESOURCE_UTILIZATION`,
    );
    if (rows.length === 0) {
      return emptyMeans(ctx, memoryRule, {
        id: memoryRule.id, category: 'memory', level: 'unknown',
        title: '未取得主机内存信息',
        evidence: {}, unknownReason: 'error',
      }, '内存使用率');
    }
    const hosts = rows.map((r) => {
      const total = num(r.FREE_PHYSICAL_MEMORY) + num(r.USED_PHYSICAL_MEMORY);
      const limit = num(r.ALLOCATION_LIMIT);
      return {
        host: r.HOST,
        hostUsedPct: total > 0 ? round((num(r.USED_PHYSICAL_MEMORY) / total) * 100, 1) : -1,
        hostUsedGiB: toGiB(r.USED_PHYSICAL_MEMORY, 1),
        hostFreeGiB: toGiB(r.FREE_PHYSICAL_MEMORY, 1),
        hostTotalGiB: toGiB(total, 1),
        instanceUsedGiB: toGiB(r.INSTANCE_TOTAL_MEMORY_USED_SIZE),
        instancePeakGiB: toGiB(r.INSTANCE_TOTAL_MEMORY_PEAK_USED_SIZE),
        allocationLimitGiB: toGiB(limit),
        // 与 HANA Cockpit 的 "Used 20.31 % / Peak 27.71 %" 同口径：实例已用（峰值）/ 配额
        instanceOfLimitPct: limit > 0 ? round((num(r.INSTANCE_TOTAL_MEMORY_USED_SIZE) / limit) * 100, 2) : -1,
        instancePeakOfLimitPct: limit > 0 ? round((num(r.INSTANCE_TOTAL_MEMORY_PEAK_USED_SIZE) / limit) * 100, 2) : -1,
      };
    });
    const level = worst(hosts.map((h) => (h.hostUsedPct < 0
      ? 'unknown' as FindingLevel
      : grade(h.hostUsedPct, ctx.t.memWarnPct, ctx.t.memCritPct))));
    const peak = hosts.reduce((a, b) => (b.hostUsedPct > a.hostUsedPct ? b : a), hosts[0]);

    // 驻留内存：Cockpit 概览页的 "Database Resident / Total Resident"。
    // Database Resident = Σ 各服务 PHYSICAL_MEMORY_SIZE（实测 185.42 GiB，与 Cockpit 逐位吻合）；
    // Total Resident 取主机级统计（同一来源也提供 Total Resident 的读数）。
    // 这两项都属"读数"而非"判定"——故取不到时只记 metric 说明，不影响本项结论。
    const svc = await ctx.pool.query<{ PHYS_SUM: unknown; USED_SUM: unknown; N: unknown }>(
      `SELECT SUM(PHYSICAL_MEMORY_SIZE) AS PHYS_SUM, SUM(TOTAL_MEMORY_USED_SIZE) AS USED_SUM,
              COUNT(*) AS N
       FROM SYS.M_SERVICE_MEMORY`,
    );
    const residentMetrics: HealthMetric[] = [];
    if (num(svc[0]?.N) > 0) {
      residentMetrics.push({
        name: '数据库驻留内存',
        value: toGiB(svc[0].PHYS_SUM),
        unit: 'GiB',
        detail: `${num(svc[0].N)} 个服务的物理内存合计（Cockpit 的 "Database Resident"）；`
          + `已用合计 ${toGiB(svc[0].USED_SUM)} GiB`,
        source: 'SYS.M_SERVICE_MEMORY',
      });
    }
    try {
      const lh = await ctx.pool.query<{ MEMORY_TOTAL_RESIDENT: unknown; MEMORY_RESIDENT: unknown }>(
        `SELECT MEMORY_TOTAL_RESIDENT, MEMORY_RESIDENT
         FROM _SYS_STATISTICS.HOST_LOAD_HISTORY_HOST ORDER BY SERVER_TIMESTAMP DESC LIMIT 1`,
      );
      if (lh.length > 0) {
        residentMetrics.push({
          name: '主机驻留内存',
          value: toGiB(lh[0].MEMORY_TOTAL_RESIDENT),
          unit: 'GiB',
          detail: `全主机驻留（Cockpit 的 "Total Resident"）；统计口径的 MEMORY_RESIDENT=${toGiB(lh[0].MEMORY_RESIDENT)} GiB`,
          source: '_SYS_STATISTICS.HOST_LOAD_HISTORY_HOST',
        });
      }
    } catch { /* 无 _SYS_STATISTICS 授权时跳过，不影响内存判定 */ }

    // ── 内存对象层：内存被**谁**占着、以及**回收得动吗** ────────────────
    // 上一层（主机/实例内存）只回答"用了多少"，回答不了"还能不能腾出来"。
    // M_MEMORY_OBJECTS 补的正是后半句，而且它带分配失败与收缩失败的计数器。
    //
    // ⚠️ 该视图的列名与常见资料**完全不同**：它没有 COMPONENT，也没有 USED_SIZE
    //    （照抄 hana-cli 的 memoryAnalysis 会直接报 260）。真实列以 OBJECT_SIZE /
    //    NON_SWAPPABLE_SIZE / PUT_FAILURE_COUNT / EVICT_COUNT / FAILED_SHRINK_COUNT 为准。
    const objMetrics: HealthMetric[] = [];
    let objLevel: FindingLevel = 'ok';
    try {
      const mo = await ctx.pool.query<{
        SIZE: unknown; NOSWAP: unknown; SWAP: unknown; PUTS: unknown; PUTFAIL: unknown;
        HIT: unknown; MISS: unknown; EVICT: unknown; TEVICT: unknown;
        FSHRINK: unknown; SHRINK: unknown; N: unknown;
      }>(
        `SELECT SUM(OBJECT_SIZE) AS SIZE, SUM(NON_SWAPPABLE_SIZE) AS NOSWAP, SUM(SWAPPABLE_SIZE) AS SWAP,
                SUM(PUT_COUNT) AS PUTS, SUM(PUT_FAILURE_COUNT) AS PUTFAIL,
                SUM(GET_HIT_COUNT) AS HIT, SUM(GET_MISS_COUNT) AS MISS,
                SUM(EVICT_COUNT) AS EVICT, SUM(TEMP_EVICT_COUNT) AS TEVICT,
                SUM(FAILED_SHRINK_COUNT) AS FSHRINK, SUM(SHRINK_COUNT) AS SHRINK,
                COUNT(*) AS N
         FROM SYS.M_MEMORY_OBJECTS`,
      );
      const r = mo[0];
      if (num(r?.N) === 0) {
        // 实测受限环境（环境 A）该视图就是返回 0 行而非报错，且它参与判级（分配失败/收缩失败）
        const el = emptyLayer(ctx, '内存对象归因', 'SYS.M_MEMORY_OBJECTS', true);
        objMetrics.push(el.metric);
        objLevel = el.level;
      } else {
        const size = num(r.SIZE);
        const noswapPct = size > 0 ? round((num(r.NOSWAP) / size) * 100, 1) : -1;
        const putFailPct = num(r.PUTS) > 0 ? round((num(r.PUTFAIL) / num(r.PUTS)) * 100, 5) : -1;
        const hits = num(r.HIT);
        const miss = num(r.MISS);
        const hitPct = hits + miss > 0 ? round((hits / (hits + miss)) * 100, 3) : -1;
        const failedShrink = num(r.FSHRINK);

        // 判级只看两个有明确物理含义的信号：
        // ① 分配失败率（拿比率不拿绝对值——该计数器自启动起累计，绝对值随运行时长单调增长）
        // ② 收缩失败次数（SHRINK 是 HANA 主动回收内存的动作，失败即"回收不动"）
        objLevel = worst([
          putFailPct < 0 ? 'unknown' : grade(putFailPct, ctx.t.memPutFailWarnPct, ctx.t.memPutFailCritPct),
          failedShrink >= ctx.t.memShrinkFailWarn ? 'warn' : 'ok',
        ]);

        objMetrics.push(
          {
            // 只作读数、**不作判定**：行存数据页（Persistency/DataPages/RowStore）天然 100% 不可换出，
            // 全局占比没有统一健康线，按它报警必然误伤带行存的系统。它是留给趋势对比的基线，不是阈值。
            name: '不可换出内存',
            value: toGiB(r.NOSWAP),
            unit: 'GiB',
            detail: `占内存对象总量 ${noswapPct}%（总量 ${toGiB(size)} GiB，可换出 ${toGiB(r.SWAP)} GiB）；`
              + '**此项只作读数**——行存数据页天然不可换出，无统一健康线，异常与否看趋势变化',
            source: 'SYS.M_MEMORY_OBJECTS',
          },
          {
            name: '内存对象分配失败率',
            value: putFailPct,
            unit: '%',
            detail: `失败 ${num(r.PUTFAIL)} 次 / 共 ${num(r.PUTS)} 次 put；`
              + `阈值 warn ${ctx.t.memPutFailWarnPct}% / critical ${ctx.t.memPutFailCritPct}%`,
            source: 'SYS.M_MEMORY_OBJECTS',
          },
          {
            name: '内存对象命中率',
            value: hitPct,
            unit: '%',
            detail: `命中 ${hits} / 未命中 ${miss}`,
            source: 'SYS.M_MEMORY_OBJECTS',
          },
          {
            name: '内存收缩失败次数',
            value: failedShrink,
            unit: '次',
            detail: `成功的收缩 ${num(r.SHRINK)} 次；失败即"HANA 想回收内存但回收不动"`,
            source: 'SYS.M_MEMORY_OBJECTS',
          },
          {
            name: '内存换出次数',
            value: num(r.EVICT),
            unit: '次',
            detail: `其中临时对象换出 ${num(r.TEVICT)} 次（临时对象换出属正常，长期不回落才需要看）`,
            source: 'SYS.M_MEMORY_OBJECTS',
          },
        );

        // 可回收性梯度：SAP 官方判内存压力的分类口径（越靠右越"钉死"）
        try {
          const dp = await ctx.pool.query<Record<string, unknown>>(
            `SELECT SUM(TEMPORARY_OBJECT_SIZE) AS TEMP, SUM(PAGE_LOADABLE_COLUMNS_OBJECT_SIZE) AS PAGELOAD,
                    SUM(EARLY_UNLOAD_OBJECT_SIZE) AS EARLY, SUM(SHORT_TERM_OBJECT_SIZE) AS SHORT,
                    SUM(MID_TERM_OBJECT_SIZE) AS MID, SUM(LONG_TERM_OBJECT_SIZE) AS LONG,
                    SUM(NON_SWAPPABLE_OBJECT_SIZE) AS NOSWAP, SUM(SHRINKABLE_OBJECT_SIZE) AS SHRINK
             FROM SYS.M_MEMORY_OBJECT_DISPOSITIONS`,
          );
          const d = dp[0];
          if (d) {
            objMetrics.push({
              name: '内存可回收性梯度',
              value: `不可换出 ${toGiB(d.NOSWAP)} GiB`,
              detail: `临时 ${toGiB(d.TEMP)} ｜ 可换页 ${toGiB(d.PAGELOAD)} ｜ 提前卸载 ${toGiB(d.EARLY)} ｜ `
                + `短期 ${toGiB(d.SHORT)} ｜ 中期 ${toGiB(d.MID)} ｜ 长期 ${toGiB(d.LONG)} ｜ `
                + `不可换出 ${toGiB(d.NOSWAP)} ｜ 可收缩 ${toGiB(d.SHRINK)} GiB`,
              source: 'SYS.M_MEMORY_OBJECT_DISPOSITIONS',
            });
          }
        } catch { /* 可回收性梯度取不到不影响上方的分配失败/收缩失败判定 */ }
      }
    } catch (e) {
      // 归因层取不到时**只留读数痕迹**，不改本项结论——主机/实例内存的判定本身仍然成立。
      // 但不能静默：否则 metrics 里会少一块而读者无从察觉（与引擎的告警设计同一条纪律）。
      objMetrics.push({
        name: '内存对象归因',
        value: '无法判定',
        detail: `M_MEMORY_OBJECTS 不可读（${String((e as { message?: string })?.message ?? e).slice(0, 120)}）；`
          + '该视图需 MONITORING / CATALOG READ。缺它只影响"内存被谁占着"的归因，不影响上方内存使用率结论',
        source: 'SYS.M_MEMORY_OBJECTS',
      });
    }

    // 结论取"主机内存使用率"与"内存对象层信号"中更重的一个：
    // 前者是"用了多少"，后者是"还腾得出来吗"，两者都可能先亮红灯。
    const finalLevel = worst([level, objLevel]);
    const objTrouble = objLevel !== 'ok' && objLevel !== 'unknown';
    return {
      id: memoryRule.id,
      category: 'memory',
      level: finalLevel,
      // 标题必须覆盖 finalLevel='unknown' 这一支：主机内存正常、但内存对象层读不到时，
      // 若落到最后那个分支会输出"主机内存使用率偏高"——把"判不了"说成"有问题"，
      // 与"把看不见说成正常"是同一种错误的镜像。
      title: objTrouble
        ? `内存对象层出现异常信号：${objMetrics.filter((m) => m.name.includes('失败')).map((m) => `${m.name} ${m.value}${m.unit ?? ''}`).join('，')}`
          + `（主机使用率 ${peak.hostUsedPct}%，实例已用 ${peak.instanceUsedGiB} / 配额 ${peak.allocationLimitGiB} GiB）`
        : finalLevel === 'unknown'
          ? `主机内存未见异常（使用率最高 ${peak.hostUsedPct}%），但**内存对象层无法判定**——`
            + '不能据此认为"内存回收正常"'
          : finalLevel === 'ok'
            ? `内存充足：主机使用率最高 ${peak.hostUsedPct}%（实例已用 ${peak.instanceUsedGiB} / 配额 ${peak.allocationLimitGiB} GiB，占 ${peak.instanceOfLimitPct}%）`
            : `主机内存使用率偏高：${peak.host} 已用 ${peak.hostUsedPct}%（${peak.hostUsedGiB}/${peak.hostTotalGiB} GiB）`,
      evidence: {
        阈值: `主机内存 warn ${ctx.t.memWarnPct}% / critical ${ctx.t.memCritPct}%；`
          + `分配失败率 warn ${ctx.t.memPutFailWarnPct}% / critical ${ctx.t.memPutFailCritPct}%；`
          + `收缩失败 ≥ ${ctx.t.memShrinkFailWarn} 次即告警`,
        主机: hosts,
        内存对象层: objMetrics,
        说明: 'instanceOfLimitPct / instancePeakOfLimitPct 与 HANA Cockpit 概览页的 '
          + '"Used % / Peak %" 同口径（实例已用/峰值 ÷ 分配配额），比主机使用率更贴近 HANA 自身的压力。'
          + '单位统一为 GiB（与 HANA Cockpit 一致）。'
          + '内存对象层的判级只依据"分配失败率"与"收缩失败次数"两个有明确物理含义的信号；'
          + '"不可换出内存"只给读数不判级——行存数据页天然 100% 不可换出，全局占比无统一健康线。',
      },
      metrics: [
        ...hosts.flatMap((h) => [
          {
            name: `实例内存已用（${h.host}）`,
            value: h.instanceUsedGiB,
            unit: 'GiB',
            detail: `占配额 ${h.instanceOfLimitPct}% ｜ 峰值 ${h.instancePeakGiB} GiB（占 ${h.instancePeakOfLimitPct}%）`
              + ` ｜ 配额 ${h.allocationLimitGiB} GiB`,
            source: 'SYS.M_HOST_RESOURCE_UTILIZATION',
          },
          {
            name: `主机物理内存（${h.host}）`,
            value: h.hostUsedPct,
            unit: '%',
            detail: `已用 ${h.hostUsedGiB} / 总 ${h.hostTotalGiB} GiB，空闲 ${h.hostFreeGiB} GiB`,
            source: 'SYS.M_HOST_RESOURCE_UTILIZATION',
          },
        ]),
        ...residentMetrics,
        ...objMetrics,
      ],
      advice: finalLevel === 'ok' ? undefined
        : objTrouble
          ? '内存对象层的失败计数（分配失败 / 收缩失败）指向"HANA 想拿内存但拿不到"。'
            + '先看 hana_table_storage（mode=memory）定位占用最大的表，再看 hana_system_activity '
            + '是否有长事务钉住版本导致内存无法回收；若主机物理内存也已接近用满，需评估扩容或调低配额。'
          : finalLevel === 'unknown'
            // 主机内存读到了、对象层没读到：此时给"内存紧张"的处置建议是误导，该说的是怎么解锁这一层
            ? '主机与实例内存的使用率已读到且未见异常，**但内存对象层（分配失败 / 收缩失败 / 可回收性）没读到**，'
              + '所以"内存回收是否正常"这一问题尚无结论。'
              + '该视图需 MONITORING 角色或 CATALOG READ 系统权限，授权后重查即可补上这一层。'
            : '先看是 HANA 涨还是别的进程涨：对比 instanceUsedGiB 与 allocationLimitGiB。若 HANA 内部涨，'
              + '用 hana_table_storage（mode=memory）定位哪张表占得多，用 hana_system_activity 看是否有长事务阻止版本回收。',
    };
  },
};

const alertsRule: HealthRule = {
  id: 'alerts.current',
  category: 'alerts',
  purpose: '统计服务器当前告警（来源 _SYS_STATISTICS.STATISTICS_CURRENT_ALERTS）',
  // _SYS_STATISTICS 需要显式授权；无权限时是报错(258)而非静默空集，
  // 但配置了 MONITORING 角色即可读，故仍标 silentlyFiltered 以便空集时也能给出解释。
  silentlyFiltered: true,
  async run(ctx) {
    // 用统计服务器的当前告警而非 M_ALERTS：后者在 HANA 2.00.085 上**不存在**（实测两套环境皆 259）。
    // ALERT_RATING 实测取值 1（info）与 2（warning）；配合 STATISTICS_ALERT_THRESHOLDS 的
    // SEVERITY 2/3（同一条告警的告警级/错误级阈值）可确定分级为 1=info / 2=warn / >=3=error 及以上。
    const rows = await ctx.pool.query<{
      ALERT_ID: unknown; ALERT_NAME: string; ALERT_RATING: unknown; ALERT_TIMESTAMP: string;
      ALERT_HOST: string; ALERT_DETAILS: string; INDEX: string;
    }>(
      `SELECT ALERT_ID, ALERT_NAME, ALERT_RATING, ALERT_TIMESTAMP, ALERT_HOST, ALERT_DETAILS, INDEX
       FROM _SYS_STATISTICS.STATISTICS_CURRENT_ALERTS
       WHERE ALERT_RATING >= 2
       ORDER BY ALERT_RATING DESC, ALERT_TIMESTAMP DESC
       LIMIT ?`,
      [ctx.t.topN],
    );
    const toFinding = (
      level: FindingLevel,
      title: string,
      evidence: Record<string, unknown>,
      metrics?: HealthMetric[],
    ): HealthFinding => ({
      id: alertsRule.id, category: 'alerts', level, title, evidence, metrics,
      advice: level === 'ok' ? undefined
        : '逐条核对 ALERT_DETAILS。阈值类告警（内存/磁盘）的当前阈值可用 '
          + '_SYS_STATISTICS.STATISTICS_ALERT_THRESHOLDS 查看；'
          + '告警的采集与邮件通知在 HANA Cockpit → Alerts 中配置。',
    });
    if (rows.length === 0) {
      return emptyMeans(ctx, alertsRule, toFinding(
        'ok',
        '当前无 warning 及以上级别的告警',
        { 说明: 'ALERT_RATING >= 2 的记录为 0 条' },
        [{ name: '活动告警（≥warning）', value: 0, unit: '条', source: '_SYS_STATISTICS.STATISTICS_CURRENT_ALERTS' }],
      ), '活动告警数');
    }
    const items = rows.map((r) => ({
      等级: num(r.ALERT_RATING),
      告警: r.ALERT_NAME,
      对象: r.INDEX || undefined,
      主机: r.ALERT_HOST,
      时间: r.ALERT_TIMESTAMP,
      详情: r.ALERT_DETAILS,
    }));
    const hasError = items.some((i) => i.等级 >= 3);
    const byLevel = items.reduce<Record<string, number>>((acc, i) => {
      acc[`等级 ${i.等级}`] = (acc[`等级 ${i.等级}`] ?? 0) + 1;
      return acc;
    }, {});
    return toFinding(
      hasError ? 'critical' : 'warn',
      `${items.length} 条活动告警（最高等级 ${items[0].等级}）：${items[0].告警}`,
      { 阈值: '1=info（已忽略），2=warning，>=3=error', 告警: items },
      [
        { name: '活动告警（≥warning）', value: items.length, unit: '条', detail: JSON.stringify(byLevel), source: '_SYS_STATISTICS.STATISTICS_CURRENT_ALERTS' },
        ...items.slice(0, 5).map((i) => ({
          name: `告警：${i.告警}`, value: i.等级, unit: '级', detail: i.详情, source: 'STATISTICS_CURRENT_ALERTS',
        })),
      ],
    );
  },
};

const blockedRule: HealthRule = {
  id: 'blocked.transactions',
  category: 'blocked',
  purpose: '当前被阻塞的事务及其等待时长（来源 SYS.M_BLOCKED_TRANSACTIONS）',
  // 监视视图按权限行级过滤，别人的阻塞事务在无权限时看不见。本视图两套环境都恰好 0 行、
  // 无法直接证伪，故按"疑罪从有"处理（见下方 emptyMeans 处的说明）
  silentlyFiltered: true,
  async run(ctx) {
    const rows = await ctx.pool.query<{
      BLOCKED_CONNECTION_ID: unknown; LOCK_OWNER_CONNECTION_ID: unknown; BLOCKED_TIME: string;
      WAITING_SCHEMA_NAME: string; WAITING_TABLE_NAME: string; WAITING_OBJECT_NAME: string;
      LOCK_TYPE: string; LOCK_MODE: string; WAIT_SEC: unknown;
    }>(
      `SELECT BLOCKED_CONNECTION_ID, LOCK_OWNER_CONNECTION_ID, BLOCKED_TIME,
              WAITING_SCHEMA_NAME, WAITING_TABLE_NAME, WAITING_OBJECT_NAME,
              LOCK_TYPE, LOCK_MODE,
              SECONDS_BETWEEN(BLOCKED_TIME, CURRENT_TIMESTAMP) AS WAIT_SEC
       FROM SYS.M_BLOCKED_TRANSACTIONS
       ORDER BY WAIT_SEC DESC LIMIT ?`,
      [ctx.t.topN],
    );
    if (rows.length === 0) {
      // 同 transactions：监视视图按权限行级过滤，别人的阻塞事务在无权限时看不见。
      // 本视图两套环境都恰好为 0 行，**无法直接证伪**，故按"疑罪从有"处理——
      // 两种错的代价不对称：漏报阻塞会让人以为没事，多报一次 unknown 只是提示去授权。
      return emptyMeans(ctx, blockedRule, {
        id: blockedRule.id, category: 'blocked', level: 'ok',
        title: '当前没有被阻塞的事务',
        evidence: { 说明: 'SYS.M_BLOCKED_TRANSACTIONS 返回 0 行' },
        metrics: [{ name: '被阻塞事务', value: 0, unit: '个', source: 'SYS.M_BLOCKED_TRANSACTIONS' }],
      }, '被阻塞事务');
    }
    const items = rows.map((r) => ({
      被阻塞连接: num(r.BLOCKED_CONNECTION_ID),
      阻塞者连接: num(r.LOCK_OWNER_CONNECTION_ID),
      等待秒数: round(num(r.WAIT_SEC), 1),
      阻塞时间: r.BLOCKED_TIME,
      对象: `${r.WAITING_SCHEMA_NAME ?? ''}.${r.WAITING_TABLE_NAME || r.WAITING_OBJECT_NAME || ''}`,
      锁类型: r.LOCK_TYPE,
      锁模式: r.LOCK_MODE,
    }));
    const level = worst(items.map((i) => grade(i.等待秒数, ctx.t.blockedWarnSec, ctx.t.blockedCritSec)));
    return {
      id: blockedRule.id,
      category: 'blocked',
      level,
      title: `${items.length} 个事务被阻塞，最长等待 ${formatDuration(items[0].等待秒数)}（对象 ${items[0].对象}）`,
      evidence: {
        阈值: `warn ${ctx.t.blockedWarnSec}s / critical ${ctx.t.blockedCritSec}s`,
        阻塞明细: items,
        说明: '阻塞者连接（LOCK_OWNER_CONNECTION_ID）即"堵住别人"的那一方',
      },
      metrics: [
        { name: '被阻塞事务', value: items.length, unit: '个', source: 'SYS.M_BLOCKED_TRANSACTIONS' },
        {
          name: '最长等待', value: items[0].等待秒数, unit: '秒',
          detail: `对象 ${items[0].对象}，阻塞者连接 ${items[0].阻塞者连接}`,
          source: 'SYS.M_BLOCKED_TRANSACTIONS',
        },
      ],
      advice: '用 hana_system_activity 查看阻塞者连接正在执行什么语句（sections=blocking）。'
        + 'HANA 的事务锁等待默认 30 分钟后强制回滚（indexserver.ini [transaction] lock_wait_timeout），'
        + '在此之前应主动处理：请应用侧尽快提交或回滚，必要时终止阻塞会话。',
    };
  },
};

const transactionsRule: HealthRule = {
  id: 'transactions.long_running',
  category: 'transactions',
  purpose: '长时间未提交的活跃事务（来源 SYS.M_TRANSACTIONS）',
  // **实测证伪了"不需要标记"**：同一实例上，环境 A（7 项系统权限）查到 59 行、
  // 环境 B（23 项 + MONITORING）查到 130 行——同一视图行数随权限翻倍，
  // 它确实按行过滤。缺权限时"查不到长事务"不能读作"没有长事务"。
  silentlyFiltered: true,
  async run(ctx) {
    // 把阈值下推到 SQL，避免把全部活跃事务拉回来再过滤
    const rows = await ctx.pool.query<{
      HOST: string; CONNECTION_ID: unknown; TRANSACTION_ID: unknown; START_TIME: string;
      ELAPSED_SEC: unknown; UNDO_LOG_AMOUNT: unknown; CREATED_VERSION_COUNT: unknown;
      ALLOCATED_VERSION_SIZE: unknown; ACQUIRED_LOCK_COUNT: unknown;
    }>(
      `SELECT HOST, CONNECTION_ID, TRANSACTION_ID, START_TIME,
              SECONDS_BETWEEN(START_TIME, CURRENT_TIMESTAMP) AS ELAPSED_SEC,
              UNDO_LOG_AMOUNT, CREATED_VERSION_COUNT, ALLOCATED_VERSION_SIZE, ACQUIRED_LOCK_COUNT
       FROM SYS.M_TRANSACTIONS
       WHERE TRANSACTION_STATUS = 'ACTIVE' AND TRANSACTION_TYPE = 'USER TRANSACTION'
         AND START_TIME < ADD_SECONDS(CURRENT_TIMESTAMP, -?)
       ORDER BY ELAPSED_SEC DESC LIMIT ?`,
      [ctx.t.txWarnSec, ctx.t.topN],
    );
    if (rows.length === 0) {
      // 走 emptyMeans 而不是写死 ok：M_TRANSACTIONS 实测**确实按行过滤**
      // （同一实例，环境 A 7 项权限看到 59 行、环境 B 23 项权限看到 130 行），
      // 所以"查不到长事务"在没有全量权限时不能读作"没有长事务"。
      return emptyMeans(ctx, transactionsRule, {
        id: transactionsRule.id, category: 'transactions', level: 'ok',
        title: `没有超过 ${ctx.t.txWarnSec} 秒未提交的活跃事务`,
        evidence: { 说明: `SYS.M_TRANSACTIONS 中 ACTIVE 的 USER TRANSACTION 无超过阈值者` },
        metrics: [
          { name: `超过 ${ctx.t.txWarnSec} 秒的活跃事务`, value: 0, unit: '个', source: 'SYS.M_TRANSACTIONS' },
        ],
      }, `超过 ${ctx.t.txWarnSec} 秒的活跃事务`);
    }
    const items = rows.map((r) => ({
      连接: num(r.CONNECTION_ID),
      事务: num(r.TRANSACTION_ID),
      开始时间: r.START_TIME,
      持续秒数: round(num(r.ELAPSED_SEC), 1),
      undo字节: num(r.UNDO_LOG_AMOUNT),
      创建的版本数: num(r.CREATED_VERSION_COUNT),
      已分配版本字节: num(r.ALLOCATED_VERSION_SIZE),
      持有锁数: num(r.ACQUIRED_LOCK_COUNT),
    }));
    const level = worst(items.map((i) => grade(i.持续秒数, ctx.t.txWarnSec, ctx.t.txCritSec)));
    // 无 undo、无锁的长事务通常是"客户端关了自动提交却一直不提交"的空转事务：
    // 它仍会钉住 MVCC 快照、阻止旧版本回收，但紧迫性低于持锁者，故在建议里区分开。
    const idleOnes = items.filter((i) => i.undo字节 === 0 && i.持有锁数 === 0);
    return {
      id: transactionsRule.id,
      category: 'transactions',
      level,
      title: `${items.length} 个长事务，最长 ${formatDuration(items[0].持续秒数)}未提交`
        + `（连接 ${items[0].连接}）`,
      evidence: {
        阈值: `warn ${ctx.t.txWarnSec}s / critical ${ctx.t.txCritSec}s`,
        长事务: items,
        其中无undo无锁的: idleOnes.length,
      },
      metrics: [
        {
          name: `超过 ${ctx.t.txWarnSec} 秒的活跃事务`, value: items.length, unit: '个',
          detail: `其中 ${idleOnes.length} 个无 undo 无锁`, source: 'SYS.M_TRANSACTIONS',
        },
        {
          name: '最长未提交时长', value: items[0].持续秒数, unit: '秒',
          detail: `${formatDuration(items[0].持续秒数)}（连接 ${items[0].连接}）`,
          source: 'SYS.M_TRANSACTIONS',
        },
      ],
      advice: '长事务会阻止 MVCC 旧版本回收，导致内存与日志持续增长，最终表现为"无原因的内存上涨"。'
        + (idleOnes.length > 0
          ? `其中 ${idleOnes.length} 个无 undo 也无锁，通常是客户端关闭了自动提交却长期不提交——这类只需请应用侧提交或断连即可。`
          : '当前长事务持有锁或有 undo 量，需尽快确认其业务合理性。')
        + ' 若持续时长远超系统启动时间，说明该连接自启动起就一直挂着（多为运维工具或应用侧连接池遗留）；'
        + '连接用户为 SYSTEM/SYS 的还需确认是否为 HANA 自身组件。'
        + ' 用 hana_system_activity（sections=transactions）看这些连接在做什么。',
    };
  },
};

const replicationRule: HealthRule = {
  id: 'replication.status',
  category: 'replication',
  purpose: '系统复制的状态（来源 SYS.M_SERVICE_REPLICATION）',
  silentlyFiltered: true,
  async run(ctx) {
    const rows = await ctx.pool.query<{
      HOST: string; SITE_NAME: string; SECONDARY_SITE_NAME: string; REPLICATION_MODE: string;
      REPLICATION_STATUS: string; REPLICATION_STATUS_DETAILS: string;
    }>(
      `SELECT HOST, SITE_NAME, SECONDARY_SITE_NAME, REPLICATION_MODE,
              REPLICATION_STATUS, REPLICATION_STATUS_DETAILS
       FROM SYS.M_SERVICE_REPLICATION`,
    );
    if (rows.length === 0) {
      return emptyMeans(ctx, replicationRule, {
        id: replicationRule.id, category: 'replication', level: 'info',
        title: '未配置系统复制（M_SERVICE_REPLICATION 为空）',
        evidence: { 说明: '该实例没有系统复制关系，此项无需关注' },
        metrics: [{ name: '系统复制', value: '未配置', source: 'SYS.M_SERVICE_REPLICATION' }],
        unknownReason: 'not_configured',
      }, '系统复制状态');
    }
    const items = rows.map((r) => ({
      主机: r.HOST,
      主站: r.SITE_NAME,
      备站: r.SECONDARY_SITE_NAME,
      模式: r.REPLICATION_MODE,
      状态: r.REPLICATION_STATUS,
      详情: r.REPLICATION_STATUS_DETAILS,
    }));
    const bad = items.filter((i) => i.状态 !== 'ACTIVE');
    return {
      id: replicationRule.id,
      category: 'replication',
      level: bad.length > 0 ? 'critical' : 'ok',
      title: bad.length > 0
        ? `系统复制异常：${bad.length}/${items.length} 个站点状态非 ACTIVE（${bad[0].状态}）`
        : `系统复制正常（${items.length} 个站点均 ACTIVE）`,
      evidence: { 站点: items },
      metrics: [
        { name: '复制站点数', value: items.length, unit: '个', source: 'SYS.M_SERVICE_REPLICATION' },
        { name: '非 ACTIVE 站点', value: bad.length, unit: '个', detail: bad.map((b) => `${b.主站}→${b.备站}: ${b.状态}`).join('；') || undefined, source: 'SYS.M_SERVICE_REPLICATION' },
      ],
      advice: bad.length > 0
        ? '复制中断意味着失去高可用保护——主库此时故障将丢失备库上的数据。'
          + '检查网络、备站服务状态与复制积压（M_SERVICE_REPLICATION 的 BACKLOG_SIZE/REPLAY_BACKLOG_SIZE）。'
        : undefined,
    };
  },
};

// ────────────────────────────────────────────────────────────
// 第二批规则（配置 / 生命周期 / 加密）
// ────────────────────────────────────────────────────────────

/**
 * 配置漂移。
 *
 * 只报**客观事实**，不做"参数该设成多少"的比对——推荐值是会随版本过时的硬编码知识，
 * 一旦写死就会在升级后变成噪声源。这里只回答三个能直接验证的问题：
 *   ① 有没有参数**违反了自身声明的限制**（VIOLATED_RESTRICTIONS）
 *   ② 有没有参数**改了但没重启生效**（RESTART_REQUIRED = TRUE）
 *   ③ 有多少参数被**非 DEFAULT 层**覆盖（SYSTEM / DATABASE / HOST / TENANT），覆盖在哪个文件
 * 第 ③ 项本身不是问题（运维本来就要改参数），它是**排查事故时的关键线索**：
 * "为什么这套库和那套库行为不一样"的答案通常就在这几十条覆盖里。
 */
const configRule: HealthRule = {
  id: 'config.drift',
  category: 'config',
  purpose: '配置参数：违反限制、改了未重启生效、非默认层覆盖（来源 SYS.M_CONFIGURATION_PARAMETER_VALUES）',
  silentlyFiltered: true,
  async run(ctx) {
    const agg = await ctx.pool.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS N,
              SUM(CASE WHEN VIOLATED_RESTRICTIONS IS NOT NULL AND VIOLATED_RESTRICTIONS != '' THEN 1 ELSE 0 END) AS VIOLATED,
              SUM(CASE WHEN RESTART_REQUIRED = 'TRUE' THEN 1 ELSE 0 END) AS RESTART
       FROM SYS.M_CONFIGURATION_PARAMETER_VALUES`,
    );
    if (num(agg[0]?.N) === 0) {
      return emptyMeans(ctx, configRule, {
        id: configRule.id, category: 'config', level: 'unknown',
        title: '未取得任何配置参数',
        evidence: {}, unknownReason: 'error',
      }, '配置参数');
    }
    const total = num(agg[0].N);
    const violated = num(agg[0].VIOLATED);
    const restart = num(agg[0].RESTART);

    // 非默认层的覆盖分布（③）——按文件 + 层聚合，最多报 topN 组
    const layers = await ctx.pool.query<{ FILE_NAME: string; LAYER_NAME: string; N: unknown }>(
      `SELECT FILE_NAME, LAYER_NAME, COUNT(*) AS N
       FROM SYS.M_CONFIGURATION_PARAMETER_VALUES
       WHERE LAYER_NAME != 'DEFAULT'
       GROUP BY FILE_NAME, LAYER_NAME
       ORDER BY COUNT(*) DESC
       LIMIT ?`,
      [ctx.t.topN],
    );
    const driftedTotal = await ctx.pool.query<{ N: unknown }>(
      `SELECT COUNT(*) AS N FROM SYS.M_CONFIGURATION_PARAMETER_VALUES WHERE LAYER_NAME != 'DEFAULT'`,
    );

    // 违规与待重启的明细（各取 topN 条）——只在这两项非零时才查，避免无谓往返
    const violatedRows = violated > 0
      ? await ctx.pool.query<Record<string, unknown>>(
        `SELECT FILE_NAME, SECTION, KEY, VALUE, LAYER_NAME, VIOLATED_RESTRICTIONS
         FROM SYS.M_CONFIGURATION_PARAMETER_VALUES
         WHERE VIOLATED_RESTRICTIONS IS NOT NULL AND VIOLATED_RESTRICTIONS != ''
         ORDER BY FILE_NAME, SECTION, KEY LIMIT ?`,
        [ctx.t.topN],
      )
      : [];
    const restartRows = restart > 0
      ? await ctx.pool.query<Record<string, unknown>>(
        `SELECT FILE_NAME, SECTION, KEY, VALUE, LAYER_NAME
         FROM SYS.M_CONFIGURATION_PARAMETER_VALUES
         WHERE RESTART_REQUIRED = 'TRUE'
         ORDER BY FILE_NAME, SECTION, KEY LIMIT ?`,
        [ctx.t.topN],
      )
      : [];

    const level: FindingLevel = worst([
      violated > 0 ? 'warn' : 'ok',
      restart >= ctx.t.configRestartWarn ? 'warn' : 'ok',
    ]);
    const parts: string[] = [];
    if (violated > 0) parts.push(`${violated} 项参数违反自身声明的限制`);
    if (restart > 0) parts.push(`${restart} 项已改但未重启生效`);

    return {
      id: configRule.id,
      category: 'config',
      level,
      title: level === 'ok'
        ? `配置参数未见异常（共 ${total} 项，非默认层覆盖 ${num(driftedTotal[0]?.N)} 项）`
        : `配置需关注：${parts.join('；')}`,
      evidence: {
        阈值: `待重启生效 ≥ ${ctx.t.configRestartWarn} 项即告警；违反限制 > 0 即告警`,
        参数总数: total,
        违反限制: violated,
        待重启生效: restart,
        非默认层覆盖总数: num(driftedTotal[0]?.N),
        覆盖分布: layers.map((l) => ({ 文件: l.FILE_NAME, 层: l.LAYER_NAME, 项数: num(l.N) })),
        违规明细: violatedRows,
        待重启明细: restartRows,
        说明: '本项**不做"参数应该设成多少"的比对**——推荐值会随版本过时而变成噪声。'
          + '只报三种可验证的事实：违反限制、改了未生效、非默认层覆盖。'
          + '第三项本身不是问题，但它是"这套库为什么和那套库行为不同"的答案所在。',
      },
      metrics: [
        {
          name: '参数违规限制', value: violated, unit: '项',
          detail: violated > 0 ? '参数值违反了系统声明的取值限制，需按 VIOLATED_RESTRICTIONS 调整' : '无',
          source: 'SYS.M_CONFIGURATION_PARAMETER_VALUES',
        },
        {
          name: '参数待重启生效', value: restart, unit: '项',
          detail: restart > 0 ? '改动已落配置但尚未生效，重启后才会起作用' : '无',
          source: 'SYS.M_CONFIGURATION_PARAMETER_VALUES',
        },
        {
          name: '非默认层参数覆盖', value: num(driftedTotal[0]?.N), unit: '项',
          detail: `占全部 ${total} 项的 ${total > 0 ? round((num(driftedTotal[0]?.N) / total) * 100, 1) : 0}%；`
            + layers.map((l) => `${l.FILE_NAME}[${l.LAYER_NAME}] ${num(l.N)}`).join('，'),
          source: 'SYS.M_CONFIGURATION_PARAMETER_VALUES',
        },
      ],
      advice: level === 'ok' ? undefined
        : '违规项按 VIOLATED_RESTRICTIONS 给出的限制调整；待重启项在下一个维护窗口重启对应服务生效'
          + '（部分参数只需重启单个服务，见 RESTART_REQUIRED 所在分层）。'
          + '调整前先用 hana_system_get_info / 本工具的 config 项留一份当前值，便于回退对照。',
    };
  },
};

/**
 * 已弃用特性是否仍在使用。
 *
 * 这一项**不回答"当前是否故障"**，回答的是"升级前还欠什么"。
 * 实测本机 25 条已弃用特性中 7 条仍在被调用，其中 XS Classic 的 XSJS 单日调用 47 万次、
 * 最近一次就在今天——这类负载不会立刻出问题，但会在版本升级时一次性断掉。
 */
const lifecycleRule: HealthRule = {
  id: 'lifecycle.deprecated_features',
  category: 'lifecycle',
  purpose: '已弃用特性的使用情况（来源 SYS.M_FEATURE_USAGE）——升级前风险，不是当前故障',
  silentlyFiltered: false,
  async run(ctx) {
    const agg = await ctx.pool.query<Record<string, unknown>>(
      `SELECT COUNT(*) AS N,
              SUM(CASE WHEN IS_DEPRECATED = 'TRUE' THEN 1 ELSE 0 END) AS DEPRECATED,
              SUM(CASE WHEN IS_DEPRECATED = 'TRUE' AND CALL_COUNT > 0 THEN 1 ELSE 0 END) AS IN_USE,
              SUM(CASE WHEN IS_DEPRECATED = 'TRUE' AND CALL_COUNT > 0 THEN CALL_COUNT ELSE 0 END) AS CALLS
       FROM SYS.M_FEATURE_USAGE`,
    );
    const total = num(agg[0]?.N);
    const deprecated = num(agg[0]?.DEPRECATED);
    const inUse = num(agg[0]?.IN_USE);
    const calls = num(agg[0]?.CALLS);

    const top = inUse > 0
      ? await ctx.pool.query<Record<string, unknown>>(
        `SELECT COMPONENT_NAME, FEATURE_NAME, CALL_COUNT, LAST_TIMESTAMP, LAST_USER_NAME, LAST_APPLICATION_NAME
         FROM SYS.M_FEATURE_USAGE
         WHERE IS_DEPRECATED = 'TRUE' AND CALL_COUNT > 0
         ORDER BY CALL_COUNT DESC LIMIT ?`,
        [ctx.t.topN],
      )
      : [];

    const level: FindingLevel = inUse >= ctx.t.deprecatedFeatureWarn ? 'warn' : 'ok';
    return {
      id: lifecycleRule.id,
      category: 'lifecycle',
      level,
      title: level === 'ok'
        ? `无已弃用特性在使用（${total} 项特性中 ${deprecated} 项已弃用，调用量均为 0）`
        : `${inUse} 项**已弃用特性仍在使用**（累计 ${calls} 次调用）——不影响当前运行，但会在版本升级时中断`,
      evidence: {
        阈值: `在用弃用特性 ≥ ${ctx.t.deprecatedFeatureWarn} 项即告警`,
        特性总数: total,
        已弃用特性数: deprecated,
        在用弃用特性数: inUse,
        弃用特性累计调用: calls,
        明细: top,
        说明: '本项衡量的是**升级风险**而非当前健康度：已被 SAP 标记为弃用的特性仍在被调用，'
          + '在升级到后续 SPS/版本时会被移除，届时对应功能会一次性中断。'
          + '调用量为 0 的弃用特性不计入（已弃用但没用 = 无需处理）。',
      },
      metrics: [
        {
          name: '在用弃用特性数', value: inUse, unit: '项',
          detail: `全部 ${total} 项特性中，已弃用 ${deprecated} 项，其中 ${inUse} 项仍在被调用`,
          source: 'SYS.M_FEATURE_USAGE',
        },
        {
          name: '弃用特性调用次数', value: calls, unit: '次',
          detail: top.length > 0
            ? top.map((t) => `${t.COMPONENT_NAME}/${t.FEATURE_NAME} ${num(t.CALL_COUNT)} 次`).join('；')
            : '无',
          source: 'SYS.M_FEATURE_USAGE',
        },
      ],
      advice: level === 'ok' ? undefined
        : '按调用量排序逐个评估替代方案：调用量最大且最近仍在被调用的项优先。'
          + '明细里的 LAST_USER_NAME / LAST_APPLICATION_NAME 指出**是谁在用**，'
          + '据此找对应应用团队确认迁移计划，而不是直接关停。'
          + '注意这不会影响当前运行——它是升级前的待办清单，不是当下的故障。',
    };
  },
};

/**
 * 加密状态。
 *
 * **这是合规读数，不是稳定性判定**——未启用加密是否算问题取决于合规要求，
 * 工具无从判断，故本项恒为 info 级（info 不会把整体 verdict 拉离 ok）。
 * 之所以仍要做成一"项"：它是最常被问到的运维问题之一，读数应当出现在报告里，
 * 而不是让人再去翻界面。数据源用 `SYS.M_ENCRYPTION_OVERVIEW` 这个**权威视图**——
 * 参考实现是从 INI 里读 `encryption=on` 字符串再比对，既漏了"控制态与生效态不同步"，
 * 也比这个视图更容易与实情不符。
 */
const encryptionRule: HealthRule = {
  id: 'encryption.status',
  category: 'encryption',
  purpose: '数据/日志/备份加密状态（来源 SYS.M_ENCRYPTION_OVERVIEW）——合规读数，不作稳定性判定',
  silentlyFiltered: true,
  async run(ctx) {
    const rows = await ctx.pool.query<Record<string, unknown>>(
      `SELECT SCOPE, IS_ENCRYPTION_ACTIVE, CONFIGURATION_CONTROL, LAST_CHANGE_TIME
       FROM SYS.M_ENCRYPTION_OVERVIEW ORDER BY SCOPE`,
    );
    if (rows.length === 0) {
      return emptyMeans(ctx, encryptionRule, {
        id: encryptionRule.id, category: 'encryption', level: 'unknown',
        title: '未取得加密状态',
        evidence: {}, unknownReason: 'error',
      }, '加密状态');
    }
    const scopes = rows.map((r) => ({
      SCOPE: String(r.SCOPE),
      IS_ENCRYPTION_ACTIVE: String(r.IS_ENCRYPTION_ACTIVE),
      生效: String(r.IS_ENCRYPTION_ACTIVE) === 'TRUE' ? '已加密' : '未加密',
      CONFIGURATION_CONTROL: r.CONFIGURATION_CONTROL,
      LAST_CHANGE_TIME: r.LAST_CHANGE_TIME,
    }));
    const onCount = scopes.filter((s) => s.IS_ENCRYPTION_ACTIVE === 'TRUE').length;
    return {
      id: encryptionRule.id,
      category: 'encryption',
      // 恒为 info：未加密是不是问题取决于合规要求，工具无从判断，更不能据此把 verdict 拉成 warn
      level: 'info',
      title: `加密状态（读数）：${scopes.length} 个范围中 ${onCount} 个已启用 —— `
        + scopes.map((s) => `${s.SCOPE} ${s.生效}`).join('，'),
      evidence: {
        范围: scopes,
        说明: 'SYS.M_ENCRYPTION_OVERVIEW 是加密状态的**权威视图**（比从 INI 读 encryption 字符串可靠）。'
          + '本项恒为 info 级：是否要求加密是合规决策，不是稳定性缺陷，'
          + '故只把读数放进报告，不参与 warn/critical 判定，也不会让整体 verdict 变成非 ok。',
      },
      metrics: scopes.map((s) => ({
        name: `加密状态 ${s.SCOPE}`,
        value: s.生效,
        detail: `控制方 ${String(s.CONFIGURATION_CONTROL ?? '')}，最后变更 ${String(s.LAST_CHANGE_TIME ?? '')}`,
        source: 'SYS.M_ENCRYPTION_OVERVIEW',
      })),
    };
  },
};

/** 规则表（按类别，工具的 checks 参数即取此处的 category） */
export const HEALTH_RULES: readonly HealthRule[] = [
  diskRule,
  servicesRule,
  backupRule,
  memoryRule,
  cpuRule,
  alertsRule,
  blockedRule,
  transactionsRule,
  replicationRule,
  configRule,
  lifecycleRule,
  encryptionRule,
];

/** 默认执行的检查项：全部（都是便宜的查询；重查询在 hana_table_storage / hana_system_activity 里） */
export const DEFAULT_CHECKS: readonly HealthCategory[] = HEALTH_RULES.map((r) => r.category);

/** 全部类别（参数校验用） */
export const ALL_CHECKS: readonly HealthCategory[] = HEALTH_RULES.map((r) => r.category);

/** 取某类别下的规则 */
export function rulesOf(category: HealthCategory): HealthRule[] {
  return HEALTH_RULES.filter((r) => r.category === category);
}
