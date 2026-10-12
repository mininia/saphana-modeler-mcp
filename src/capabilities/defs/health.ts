/**
 * 稳定性诊断（分类 diagnostics）的能力清单条目：hana_system_health / hana_system_activity /
 * hana_table_storage / hana_system_trend。
 *
 * 本文件是这四项能力声明（title / description / inputSchema / annotations）的**唯一事实源**；
 * 注册侧（tools/health.tools.ts）经 capabilityRegistrar 从清单取声明，只提供 handler。
 * 条目顺序 = 注册顺序（regCap 调用顺序），保持 tools/list 的呈现顺序不变。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { tagResource } from '../resources.js';
import { planSystemViewRead, planTableStorage } from '../planners.js';
import { ALL_CHECKS, DEFAULT_THRESHOLDS } from '../../services/health.service.js';
import { ALL_SECTIONS } from '../../services/activity.service.js';
import { ALL_TREND_METRICS, DEFAULT_BUCKET_MINUTES, MAX_HOURS } from '../../services/trend.service.js';
import { ALL_MODES, ALL_SUBTYPES } from '../../services/storage.service.js';

/** 阈值覆盖参数（全部可选；未传的用 DEFAULT_THRESHOLDS，由引擎 merge）。
 *  默认值一律从 DEFAULT_THRESHOLDS 插值（唯一事实源），描述里写明单位——
 *  这些数值进的是判定，模型看不懂单位就会给出「看起来对」的错阈值。 */
const thresholdSchema = z
  .object({
    diskWarnPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(`磁盘/文件系统使用率 warn 阈值（%，默认 ${DEFAULT_THRESHOLDS.diskWarnPct}）`),
    diskCritPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(`磁盘/文件系统使用率 critical 阈值（%，默认 ${DEFAULT_THRESHOLDS.diskCritPct}）`),
    memWarnPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(`内存使用率 warn 阈值（%，默认 ${DEFAULT_THRESHOLDS.memWarnPct}）`),
    memCritPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(`内存使用率 critical 阈值（%，默认 ${DEFAULT_THRESHOLDS.memCritPct}）`),
    cpuWarnPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(`CPU 使用率 warn 阈值（%，默认 ${DEFAULT_THRESHOLDS.cpuWarnPct}）`),
    cpuCritPct: z
      .number()
      .int()
      .min(0)
      .max(100)
      .optional()
      .describe(`CPU 使用率 critical 阈值（%，默认 ${DEFAULT_THRESHOLDS.cpuCritPct}）`),
    backupWarnHours: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`距上次成功全备的时长 warn 阈值（小时，默认 ${DEFAULT_THRESHOLDS.backupWarnHours}）`),
    backupCritHours: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`距上次成功全备的时长 critical 阈值（小时，默认 ${DEFAULT_THRESHOLDS.backupCritHours}）`),
    txWarnSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`未提交活跃事务的时长 warn 阈值（秒，默认 ${DEFAULT_THRESHOLDS.txWarnSec}）`),
    txCritSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`未提交活跃事务的时长 critical 阈值（秒，默认 ${DEFAULT_THRESHOLDS.txCritSec}）`),
    blockedWarnSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`被阻塞事务的等待时长 warn 阈值（秒，默认 ${DEFAULT_THRESHOLDS.blockedWarnSec}）`),
    blockedCritSec: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`被阻塞事务的等待时长 critical 阈值（秒，默认 ${DEFAULT_THRESHOLDS.blockedCritSec}）`),
    // ⚠ 这两个是百分比的**小数**阈值，故刻意**不加 .int()**：加了会让默认值本身都无法显式传入。
    memPutFailWarnPct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(`内存分配失败率 warn 阈值（%，默认 ${DEFAULT_THRESHOLDS.memPutFailWarnPct}）`),
    memPutFailCritPct: z
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(`内存分配失败率 critical 阈值（%，默认 ${DEFAULT_THRESHOLDS.memPutFailCritPct}）`),
    memShrinkFailWarn: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`内存收缩失败次数 warn 阈值（次，达到即告警，默认 ${DEFAULT_THRESHOLDS.memShrinkFailWarn}）`),
    ioFailedWarn: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`卷读写失败次数 warn 阈值（次，达到即告警，默认 ${DEFAULT_THRESHOLDS.ioFailedWarn}）`),
    ioBlockedWriteWarn: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`卷阻塞写次数 warn 阈值（次，达到即告警，默认 ${DEFAULT_THRESHOLDS.ioBlockedWriteWarn}）`),
    configRestartWarn: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`待重启才生效的配置项数量 warn 阈值（项，达到即告警，默认 ${DEFAULT_THRESHOLDS.configRestartWarn}）`),
    deprecatedFeatureWarn: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe(`在用的已弃用特性数量 warn 阈值（项，达到即告警，默认 ${DEFAULT_THRESHOLDS.deprecatedFeatureWarn}）`),
    topN: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe(`各排行榜明细返回条数（默认 ${DEFAULT_THRESHOLDS.topN}）`),
  })
  .optional();

export const healthCapabilities = {
  // 稳定性诊断四件套：仅 SELECT 系统视图（SYS.M_* / _SYS_STATISTICS.*），零副作用。
  // 权限层级归 admin（监视视图读权限档；与 hana_sql_analyze 同域的暴露面收敛），
  // 但它们**行为只读**（不接受任意 SQL，也不写任何东西）——故各自显式声明叙述型规划器，
  // 不落写兜底（写兜底会把参数表面的 packageId 当写包，凭空造出资源结论）。
  // 需要收敛时用 MCP_TOOL_DENY="hana_system_health,..."。
  hana_system_health: cap({
    id: 'hana_system_health',
    category: 'diagnostics',
    kind: 'admin',
    effects: {
      plan: planSystemViewRead('hana_system_health', '实例稳定性体检（内存/CPU/挂载点/备份/阻塞/告警）'),
      destructive: false,
      idempotent: true,
    },
    title: 'HANA 稳定性体检',
    // 口径解释、每项「为什么」与实测说明都在 rules=health_check（按需经 hana_system_get_info 查询）——
    // 这里只留骨架（两层结构/名字清单/三态语义）与查询指针，避免同一段知识两处漂移。
    description:
      '对 HANA 实例做一次稳定性体检（只读），返回**结论 + 读数**两层：\n' +
      '① metrics —— 具体占用情况（实例/主机内存、CPU、挂载点与卷、备份、阻塞与长事务、告警、服务数等；' +
      '容量类单位 GiB(1024³)），**无论判定正常与否都会给出**；\n' +
      '② findings —— 逐项结论：整体 verdict（ok/warn/critical/indeterminate）+ 每项级别、结论、证据与建议。\n' +
      `检查项（checks 参数选择，默认全做）：${ALL_CHECKS.join(', ')}。\n` +
      '**三态语义**：监视视图按权限行级过滤，权限不足时静默返回空集——凡无法判定的项一律标 unknown、' +
      '整体 verdict 至多退化为 indeterminate（有 warn/critical 时按更重的一级报），而**不会**谎报 ok（visibility/coverage 说明覆盖与缺口）。\n' +
      '每项查什么、单位口径与阈值语义见 rules=health_check（hana_system_get_info(rules=health_check)）。',
    inputSchema: z.object({
      // 刻意用 z.string() 而非 z.enum(ALL_CHECKS)：非法值要落到 handler 的 normalizeChecks，
      // 由它给出**中文**硬错误并列出合法值（合法值同时写进 describe，tools/list 里也可发现）。
      // 用 z.enum 会在协议层被拒，调用方拿到的是英文 "Invalid option: expected one of ..." ——
      // 这是实机验收（verify-health「非法检查项 → 硬错误且列出合法值」）锁定的契约，别改回枚举。
      checks: z
        .array(z.string())
        .optional()
        .describe(`要执行的检查项（默认全部：${ALL_CHECKS.join(', ')}）`),
      thresholds: thresholdSchema.describe(
        `阈值覆盖（只覆盖传入的项；其余用默认值，如磁盘 warn ${DEFAULT_THRESHOLDS.diskWarnPct} / critical ${DEFAULT_THRESHOLDS.diskCritPct}）`,
      ),
      includeOk: z
        .boolean()
        .default(false)
        .describe('true=findings 里也返回通过项（ok），便于确认「到底查了哪些」；默认 false 只返回非 ok 项'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_system_activity: cap({
    id: 'hana_system_activity',
    category: 'diagnostics',
    kind: 'admin',
    effects: {
      plan: planSystemViewRead('hana_system_activity', '阻塞事务/长事务/长语句深潜'),
      destructive: false,
      idempotent: true,
    },
    title: 'HANA 会话与阻塞深潜',
    // 与其余三个诊断工具同形：描述只留骨架、参数面与模型高频踩坑的那一句（M_LOCKS 不存在），
    // 逐项口径与实测见 rules=activity_locks——同一段知识只在一处维护。
    description:
      '回答「问题在哪、谁造成的」：当前被阻塞的事务（含**谁堵了谁**的连接画像）、长时间未提交的事务、' +
      '长时间运行的语句。三段可用 sections 选择，默认全查。\n' +
      '注意（与常见做法不同）：HANA 2.0 **没有** M_LOCKS 视图（实测 2.00.085 报 259 不存在），' +
      '阻塞信息一律走 M_BLOCKED_TRANSACTIONS，它自带 LOCK_OWNER_CONNECTION_ID，可直接建链。\n' +
      '数据来源、长语句耗时口径与权限影响（缺权限时「0 条」可能是「看不见」而非「没有」）见 ' +
      'rules=activity_locks（hana_system_get_info(rules=activity_locks)）。',
    inputSchema: z.object({
      // 同 checks：非法段落由 normalizeSections 给中文硬错误（verify-health 锁定的契约）
      sections: z
        .array(z.string())
        .optional()
        .describe(`要查询的段落（默认全部：${ALL_SECTIONS.join(', ')}）`),
      minDurationSec: z
        .number()
        .int()
        .min(0)
        .max(86400)
        .default(30)
        .describe('事务/语句的时长下限（秒），低于该值不返回；阻塞段不受此参数影响（只要有阻塞就报）'),
      limit: z.number().int().min(1).max(200).default(20).describe('每段最多返回的条数'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_table_storage: cap({
    id: 'hana_table_storage',
    category: 'diagnostics',
    kind: 'admin',
    effects: { plan: planTableStorage, destructive: false, idempotent: true },
    title: 'HANA 表存储与碎片画像',
    // 实测坑、成本量级与逐列口径都在 rules=storage_profile（按需经 hana_system_get_info 查询）；
    // 这里保留「五口径+两下钻分别是什么、返回结构、单位、只诊断不执行」。
    description:
      '列存表存储画像，七种口径（5 个表级排行榜 + 2 个列/索引下钻），表级每行带内存/磁盘占用、分区数、碎片率、' +
      '读写次数、上次 merge 时间：\n' +
      '• memory 内存 TOP N「谁在吃内存」；• disk 磁盘 TOP N「谁在占盘」；\n' +
      '• fragmentation delta 占比 TOP N「谁该做 merge」；• hotness 读写次数 TOP N「谁在被访问」；\n' +
      '• partition 分区数 TOP N「谁被分区了」（默认按 ACTIVE 过滤 BW 活动数据表，未分类/非 BW 表不受影响；' +
      'subtype 可显式切换；同时给 schema 与 table 时' +
      '改为该表的逐分区明细）；\n' +
      '• column / index 列级与索引内存 TOP N「表里哪列/哪个索引在吃内存」（明细在 columns / indexes 字段）。\n' +
      '体量单位 MiB（1024²）；**只诊断不执行**（merge 等操作请人工在低峰期做）。' +
      '口径陷阱与实测数值（易错列、成本量级）见 rules=storage_profile（hana_system_get_info(rules=storage_profile)）。',
    inputSchema: z.object({
      // 同 checks：刻意用 z.string() 而非 z.enum(ALL_MODES)——非法值要落到 handler 的 normalizeMode，
      // 由它给出中文硬错误并列出合法值（合法值同时写在 describe 里）；z.enum 会在协议层被英文拒绝，
      // 且合法值在协议报错里不可见（SSD §1.6 的枚举契约）。
      mode: z
        .string()
        .default('memory')
        .describe(`画像口径（默认 memory）；合法值：${ALL_MODES.join(', ')}`),
      schema: tagResource(
        z
          .string()
          .trim()
          .min(1)
          .max(127)
          .optional()
          .describe('限定 schema（可选，不传则统计当前用户可见的全部 schema）'),
        'readSchema',
      ),
      table: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe(
          '限定单表（可选，**所有口径**都生效）。单表查询会返回该表的完整画像：' +
            '内存 MiB / 磁盘 MiB / 分区数 / 碎片率 / 记录数 / 读写次数 / 上次 merge。' +
            '与 schema 一起配合 mode=partition 时还会**额外**返回逐分区明细。' +
            'BW 对象名形如 /BIC/AZDEMO001，斜杠是合法字符',
        ),
      topN: z.number().int().min(1).max(200).default(20).describe('返回条数'),
      minSizeMiB: z
        .number()
        .min(0)
        .max(1024 * 1024)
        .default(100)
        .describe('仅 fragmentation 模式：忽略小于该体积（MiB）的表，避免小表噪声'),
      // 同 mode：宽松 schema + handler 中文硬错误（normalizeSubtype 把非法值与合法值一并列出）。
      subtype: z
        .string()
        .optional()
        .describe(
          'BW 分类过滤（partition 模式有意义；**省略 = 按 ACTIVE 处理但未分类/非 BW 表照常列出**，' +
            '显式指定则严格匹配）。' +
            '同一个 BW 对象在 HANA 上是一组物理表：活动表=ACTIVE、入站队列=QUEUE、变更日志=CHANGE_LOG、' +
            `PSA 暂存区=PSA、InfoCube 事实表=FACT_IMO。传 ALL 不过滤；合法值：${ALL_SUBTYPES.join(', ')}`,
        ),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_system_trend: cap({
    id: 'hana_system_trend',
    category: 'diagnostics',
    kind: 'admin',
    effects: {
      plan: planSystemViewRead('hana_system_trend', '历史趋势（_SYS_STATISTICS 时间轴聚合）'),
      destructive: false,
      idempotent: true,
    },
    title: 'HANA 历史趋势',
    // 实测结构（采样粒度、TIME vs SERVER_TIMESTAMP、INDEX 含义）与保留期口径的完整说明
    // 在 rules=trend_timeline；这里只留参数面、单位口径与输出字段约定。
    description:
      '回答「这周比上周差了吗」——对 _SYS_STATISTICS.HOST_LOAD_HISTORY_HOST 做时间轴聚合：' +
      'hours 回溯窗口（默认 24）、bucketMinutes 桶宽（默认 60）、metrics 选指标组（cpu/memory/disk/network/swap），' +
      '每桶给出所选指标的 min/max/avg 与采样点数。\n' +
      '单位：内存/磁盘 GiB（与 Cockpit 一致）、CPU 与占比用 %、网络用 KiB（网络与 swap 是每采样周期内的量，不是速率）。\n' +
      '**保留期有限**：窗口超出时 retention.coversWindow=false——未覆盖段不读作「正常」。\n' +
      '时间轴口径（用 TIME 而非 SERVER_TIMESTAMP）与「不给上升就是坏」的判定边界见 rules=trend_timeline。',
    inputSchema: z.object({
      hours: z
        .number()
        .min(1)
        .max(MAX_HOURS)
        .default(24)
        .describe(`回溯窗口（小时，默认 24，上限 ${MAX_HOURS}）。超出历史层保留期时会如实说明只取到哪一段`),
      bucketMinutes: z
        .number()
        .int()
        .min(1)
        .max(1440)
        .default(DEFAULT_BUCKET_MINUTES)
        .describe('聚合桶宽（分钟，默认 60）。每个桶给 min/max/avg'),
      // 同 mode：宽松 schema + handler 中文硬错误（normalizeTrendMetrics 把非法值与合法值一并列出）。
      metrics: z
        .array(z.string())
        .optional()
        .describe(
          `要返回的指标组（默认全部：${ALL_TREND_METRICS.join(', ')}）。` +
            'cpu=CPU%，memory=内存已用 GiB 与占配额%，disk=磁盘已用 GiB 与占比%，' +
            'network=网络进出 KiB，swap=swap 字节数',
        ),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
