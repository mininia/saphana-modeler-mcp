/**
 * 稳定性诊断工具（分组 **read**）。
 *
 * 三个工具对应三种形状，刻意不合并：
 *  - hana_system_health   —— 阈值判定，回答"有没有问题"（结论 + 覆盖度）
 *  - hana_system_activity —— 拓扑与明细，回答"问题在哪、谁造成的"（阻塞链/长事务/长语句）
 *  - hana_table_storage   —— 排序画像，回答"该优化谁"（内存/碎片/热度 TOP N）
 * 合并成一个"大而全"的工具会让每次调用都吐出几屏数据，且默认成本高到没人敢调。
 *
 * 三者共用 visibility.service 的可见性判定：都必须在"看不见"时如实说明，
 * 而不是把空结果当正常——这是本项目对 HANA 监视视图行级过滤语义的统一处理。
 *
 * 全部只读（仅 SELECT 系统视图），故归 read 组、走 registerVisibleTool，不经写预检。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { runHealth, normalizeChecks, ALL_CHECKS, type HealthCategory } from '../services/health.service.js';
import { runActivity, normalizeSections, ALL_SECTIONS } from '../services/activity.service.js';
import {
  runTrend, normalizeTrendMetrics, ALL_TREND_METRICS, DEFAULT_BUCKET_MINUTES, MAX_HOURS,
} from '../services/trend.service.js';
import {
  runTableStorage, normalizeMode, normalizeSubtype, validateSchemaName, validateTableName,
  ALL_MODES, type StorageMode,
} from '../services/storage.service.js';
import { registerVisibleTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

/** 阈值覆盖参数（全部可选；未传的用 DEFAULT_THRESHOLDS，由引擎 merge） */
const thresholdSchema = z.object({
  diskWarnPct: z.number().min(0).max(100).optional(),
  diskCritPct: z.number().min(0).max(100).optional(),
  memWarnPct: z.number().min(0).max(100).optional(),
  memCritPct: z.number().min(0).max(100).optional(),
  cpuWarnPct: z.number().min(0).max(100).optional(),
  cpuCritPct: z.number().min(0).max(100).optional(),
  backupWarnHours: z.number().min(0).optional(),
  backupCritHours: z.number().min(0).optional(),
  txWarnSec: z.number().min(0).optional(),
  txCritSec: z.number().min(0).optional(),
  blockedWarnSec: z.number().min(0).optional(),
  blockedCritSec: z.number().min(0).optional(),
  memPutFailWarnPct: z.number().min(0).max(100).optional(),
  memPutFailCritPct: z.number().min(0).max(100).optional(),
  memShrinkFailWarn: z.number().min(0).optional(),
  ioFailedWarn: z.number().min(0).optional(),
  ioBlockedWriteWarn: z.number().min(0).optional(),
  configRestartWarn: z.number().min(0).optional(),
  deprecatedFeatureWarn: z.number().min(0).optional(),
  topN: z.number().int().min(1).max(100).optional(),
}).optional();

export function registerHealthTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);

  // ── 1) 健康总览 ────────────────────────────────────────
  reg(
    'hana_system_health',
    {
      title: 'HANA 稳定性体检',
      description:
        '对 HANA 实例做一次稳定性体检，返回**结论 + 读数**两层：\n'
        + '① `metrics` —— **具体占用情况**：实例内存已用/配额/峰值及百分比、主机物理内存、数据库与主机驻留内存、\n'
        + '   主机 CPU 与数据库服务 CPU、各挂载点使用率、各用途卷大小（Data/Log/Trace）、备份距今天数、\n'
        + '   被阻塞事务数、长事务数与最长时长、活动告警数、服务数等。**无论判定为正常与否都会给出**，\n'
        + '   所以问"当前内存百分之多少"直接读这里。\n'
        + '   容量类数值的单位是 **GiB（1024³）**，与 HANA Cockpit / HANA Studio 的显示一致'
        + '（若用 GB(10⁹) 会与之恒差 1.0737 倍，核对时容易误以为读错了库）。\n'
        + '② `findings` —— 逐项结论：整体 verdict（ok/warn/critical/indeterminate）+ 每项的级别、\n'
        + '   一句话结论、实测证据与建议。\n'
        + '检查项（checks 参数选择，默认全做）：\n'
        + '  • disk         各挂载点文件系统使用率 + 各用途卷大小 + **卷 IO 健康**（SYS.M_DISKS / M_DISK_USAGE / '
        + 'M_VOLUME_IO_TOTAL_STATISTICS / M_VOLUME_FILES）。容量与 IO 是两个正交读数：'
        + '容量充足但读写失败/阻塞写非零，说明存储链路有问题而不是空间不够\n'
        + '  • services     服务进程是否全部 ACTIVE（SYS.M_SERVICES）\n'
        + '  • backup       距上次成功全备的时长 + 近 7 天失败备份数（SYS.M_BACKUP_CATALOG）\n'
        + '  • memory       实例内存占配额比、主机物理内存、数据库/主机驻留内存（M_HOST_RESOURCE_UTILIZATION / M_SERVICE_MEMORY / HOST_LOAD_HISTORY_HOST）'
        + ' + **内存对象层**（M_MEMORY_OBJECTS / M_MEMORY_OBJECT_DISPOSITIONS）：'
        + '不可换出内存、分配失败率、命中率、收缩失败次数、可回收性梯度（临时/可换页/提前卸载/短中长/不可换出/可收缩）\n'
        + '  • cpu          主机 CPU 使用率（统计服务相邻快照差值）与数据库服务 CPU（M_SERVICE_STATISTICS）\n'
        + '  • alerts       统计服务器当前告警（_SYS_STATISTICS.STATISTICS_CURRENT_ALERTS）\n'
        + '  • blocked      当前被阻塞事务与最长等待（SYS.M_BLOCKED_TRANSACTIONS）\n'
        + '  • transactions 长时间未提交的活跃事务（SYS.M_TRANSACTIONS）\n'
        + '  • replication  系统复制状态（SYS.M_SERVICE_REPLICATION）\n'
        + '  • config       配置漂移（SYS.M_CONFIGURATION_PARAMETER_VALUES）：违反取值限制、改了未重启生效、非默认层覆盖分布。'
        + '**不做"参数应该设成多少"的比对**——推荐值会随版本过时而变成噪声\n'
        + '  • lifecycle    已弃用特性的使用情况（SYS.M_FEATURE_USAGE）——衡量的**不是当前健康度**，'
        + '而是升级前风险：已弃用却仍在被调用的特性，会在版本升级时一次性中断\n'
        + '  • encryption   数据/日志/备份加密状态（SYS.M_ENCRYPTION_OVERVIEW，权威视图）。'
        + '**恒为 info 级**：是否要求加密是合规决策不是稳定性缺陷，只进读数、不参与判定\n'
        + '**关键语义**：HANA 的监视视图按权限**行级过滤**，权限不足时静默返回空集而不报错。'
        + '故本工具是**三态**：ok / 异常 / unknown（看不见）。凡无法判定的项一律标 unknown，'
        + '整体 verdict 会退化为 indeterminate 而**不会**谎报 ok；报告里的 visibility 与 coverage '
        + '会说明"覆盖了什么、漏了什么、为什么漏"，读数里也会为该类项留一条"无法判定"而不让它静默消失。\n'
        + '不包含明细：要看阻塞链与长事务明细用 hana_system_activity，要看表级存储用 hana_table_storage，'
        + '要看历史趋势用 hana_system_trend。',
      inputSchema: z.object({
        checks: z.array(z.string()).optional()
          .describe(`要执行的检查项（默认全部：${ALL_CHECKS.join(', ')}）`),
        thresholds: thresholdSchema
          .describe('阈值覆盖（只覆盖传入的项；其余用默认值，如磁盘 warn 80 / critical 90）'),
        includeOk: z.boolean().default(false)
          .describe('true=findings 里也返回通过项（ok），便于确认"到底查了哪些"；默认 false 只返回非 ok 项'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ checks, thresholds, includeOk }) => {
      const norm = normalizeChecks(checks);
      if (!norm.ok) return mcpErrorText(norm.message);
      const envelope: Envelope = await withErrorEnvelope(async () => {
        const report = await runHealth(ctx.pool, { checks: norm.value, thresholds: thresholds ?? {} });
        return includeOk
          ? report
          : { ...report, findings: report.findings.filter((f) => f.level !== 'ok') };
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  // ── 2) 会话与阻塞深潜 ──────────────────────────────────
  reg(
    'hana_system_activity',
    {
      title: 'HANA 会话与阻塞深潜',
      description:
        '回答"问题在哪、谁造成的"：当前被阻塞的事务（含**谁堵了谁**的连接画像）、长时间未提交的事务、'
        + '长时间运行的语句。三段可用 sections 选择，默认全查。\n'
        + '数据来源：SYS.M_BLOCKED_TRANSACTIONS / M_TRANSACTIONS / M_ACTIVE_STATEMENTS，'
        + '并用 M_CONNECTIONS 按需补齐连接的用户/客户端主机/应用名（只按涉及的连接 ID 查，不整表拉回）。\n'
        + '注意（与常见做法不同）：HANA 2.0 **没有** M_LOCKS 视图（实测 2.00.085 报 259 不存在），'
        + '阻塞信息一律走 M_BLOCKED_TRANSACTIONS，它自带 LOCK_OWNER_CONNECTION_ID，可直接建链。\n'
        + '长语句的耗时口径：M_ACTIVE_STATEMENTS 没有"本次已耗时"列，这里用 LAST_EXECUTED_TIME 与当前时间'
        + '之差近似（COMPILED_TIME / LAST_EXECUTED_TIME 都放在明细里供复核）。\n'
        + '**权限影响**：缺 CATALOG READ / MONITORING 时这些视图只返回自己的会话，'
        + '此时"0 条"会附带 caveats 说明它可能是"看不见"而非"没有"。',
      inputSchema: z.object({
        sections: z.array(z.string()).optional()
          .describe(`要查询的段落（默认全部：${ALL_SECTIONS.join(', ')}）`),
        minDurationSec: z.number().int().min(0).max(86400).default(30)
          .describe('事务/语句的时长下限（秒），低于该值不返回；阻塞段不受此参数影响（只要有阻塞就报）'),
        limit: z.number().int().min(1).max(200).default(20)
          .describe('每段最多返回的条数'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ sections, minDurationSec, limit }) => {
      const norm = normalizeSections(sections);
      if (!norm.ok) return mcpErrorText(norm.message);
      const envelope: Envelope = await withErrorEnvelope(() =>
        runActivity(ctx.pool, { sections: norm.value, minDurationSec, limit }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  // ── 3) 表存储画像 ──────────────────────────────────────
  reg(
    'hana_table_storage',
    {
      title: 'HANA 表存储与碎片画像',
      description:
        '按五种口径给出列存表排行榜，每行同时带**内存占用 / 磁盘占用 / 分区数 / 碎片率 / 读写次数 / 上次 merge 时间**：\n'
        + '  • memory        内存占用 TOP N —— "谁在吃内存"（M_CS_TABLES.MEMORY_SIZE_IN_TOTAL）\n'
        + '  • disk          磁盘占用 TOP N —— "谁在占盘"（M_TABLE_PERSISTENCE_STATISTICS.DISK_SIZE）\n'
        + '  • fragmentation delta 占总量之比 TOP N —— "谁该做 merge"（配 lastMergeTime 看多久没合并）\n'
        + '  • hotness       读/写次数 TOP N —— "谁在被访问"，用作优化收益排序的依据\n'
        + '  • partition     分区数 TOP N —— "谁被分区了、分了多少"；\n'
        + '                  **默认只看 BW 活动数据表**（subtype 参数可切换），因为同一个 BW 对象在 HANA 上\n'
        + '                  是一组物理表（活动表 / 入站队列 QUEUE / 变更日志 CHANGE_LOG / PSA），表名只差后缀；\n'
        + '                  **同时给 schema 与 table 时**改为返回该表的**逐分区明细**（每分区内存/记录/上次 merge）\n'
        + '  • column        列级内存 TOP N —— "**这张表里哪一列在吃内存**"（M_CS_ALL_COLUMNS，实测 109 万行）。\n'
        + '                  每行带：列内存（含 main/delta/可分页）、**压缩类型**、行数、不同值数、\n'
        + '                  该列的索引类型（FULL/NONE）、是否已加载、最后访问时间、分区数。\n'
        + '                  **刻意不返回 `COMPRESSION_RATIO_IN_PERCENTAGE`**：实测该列在本版本会出现 361890% 这种\n'
        + '                  不可能的值（口径反推为 内存÷UNCOMPRESSED_SIZE×100，而后者大量为 NULL），\n'
        + '                  返回它等于邀请调用方按错误语义判断。压缩改用**类型**表达——\n'
        + '                  "同为 CLUSTD 列，一张用 DEFAULT 一张用 INDIRECT"才是可行动的线索\n'
        + '  • index         索引内存 TOP N —— "**索引又占了多少**"（M_CS_INDEXES，实测 84,513 行、合计 11 GiB）。\n'
        + '                  每行带索引内存、拼接列内存、分区数，以及**该索引占所属表内存的百分比**。\n'
        + '                  实测这个比例在 **73%~83%**：`SAPABAP1./BIC/AZDEMO001` 表内存 3303.6 MiB、\n'
        + '                  另有一个 2748.8 MiB 的 INVERTED VALUE 索引 —— **只看表内存会把这张表的真实成本少算近一半**。\n'
        + '                  不给 `HASH_COLLISION_COUNT`：实测该列全库只有 `-1` 一个取值，无信号\n'
        + '**成本提示（实测，调用前务必知道）**：`column` / `index` 在不给 `table` 时**固定约 7~9 秒**——'
        + '`M_CS_ALL_COLUMNS`（109 万行）与 `M_CS_INDEXES` **不吃 `SCHEMA_NAME` 谓词消减**'
        + '（实测带与不带 schema 过滤都是约 6.7 秒），只有**同时给 schema 与 table** 才降到约 0.5 秒（13 倍差）。'
        + '即：单表下钻很便宜、全局排行很贵；连续刷多个 schema 时请预期这个量级。\n'
        + '所有表级口径都**先在 SQL 侧按 (schema, table) 聚合再排序**：M_CS_TABLES 的一行是一个**分区**'
        + '（实测 74836 行 = 71565 张表），直接排序取 TOP 会得到"最大的分区"而不是"最大的表"。\n'
        + '分区数取 `COUNT(DISTINCT PART_ID)`，实测与 `M_TABLE_PARTITIONS` 的节点数**逐行一致**'
        + '（19=19 / 22=22 / 8=8），即**表分区**；delta 在 M_CS_TABLES 里是**列**（MEMORY_SIZE_IN_DELTA）\n'
        + '而不是行，"同一 (表, PART_ID) 多行"在全库实测 0 例，故分区数不会混入 delta。\n'
        + '体量单位是 **MiB（1024²）**：与 HANA Cockpit 的 1024 进制一致（实例级用 GiB，见表画像以外的工具）。'
        + '用 MiB 而非 GiB 是因为表级数据要保留小数分辨率——热度榜里大量表在 0.2 MiB 量级，'
        + '换算成 GiB 会变成 0.0002，排行与阈值都会失去意义。**进制统一为 2 的幂，量级按数据尺度选**。\n'
        + '两个易错口径已规避：① `M_TABLES.TABLE_SIZE` **不是**磁盘占用（实测与内存总量完全相同），'
        + '磁盘只能取 `DISK_SIZE`；② 热度用 `M_CS_TABLES.READ_COUNT/WRITE_COUNT`，'
        + '不用 `M_TABLE_STATISTICS.SELECT_COUNT`（实测未采集，全为 0）。\n'
        + '碎片率阈值参考：<10% 健康 / 10–25% 观察 / 25–50% 建议安排 merge / >50% 尽快处理。'
        + '注意小表的碎片率是噪声（实测有 0.2 MiB 的表碎片率 51%），fragmentation 模式用 minSizeMiB 过滤。'
        + '合并操作本身开销大（CPU/IO），建议在低峰期做，且本工具**只诊断不执行**。',
      inputSchema: z.object({
        mode: z.enum(['memory', 'disk', 'fragmentation', 'hotness', 'partition', 'column', 'index']).default('memory')
          .describe(`画像口径（默认 memory）；合法值：${ALL_MODES.join(', ')}`),
        schema: z.string().min(1).max(127).optional()
          .describe('限定 schema（可选，不传则统计当前用户可见的全部 schema）'),
        table: z.string().min(1).max(256).optional()
          .describe('限定单表（可选，**所有口径**都生效）。单表查询会返回该表的完整画像：'
            + '内存 MiB / 磁盘 MiB / 分区数 / 碎片率 / 记录数 / 读写次数 / 上次 merge。'
            + '与 schema 一起配合 mode=partition 时还会**额外**返回逐分区明细。'
            + 'BW 对象名形如 /BIC/AZDEMO001，斜杠是合法字符'),
        topN: z.number().int().min(1).max(200).default(20)
          .describe('返回条数'),
        minSizeMiB: z.number().min(0).max(1024 * 1024).default(100)
          .describe('仅 fragmentation 模式：忽略小于该体积（MiB）的表，避免小表噪声'),
        subtype: z.enum(['ALL', 'ACTIVE', 'QUEUE', 'CHANGE_LOG', 'PSA', 'FACT_IMO', 'FACT_E', 'FACT_F', 'ERROR_STACK'])
          .default('ACTIVE')
          .describe('BW 分类过滤（partition 模式有意义，默认 ACTIVE=只看活动数据表）。'
            + '同一个 BW 对象在 HANA 上是一组物理表：活动表=ACTIVE、入站队列=QUEUE、变更日志=CHANGE_LOG、'
            + 'PSA 暂存区=PSA、InfoCube 事实表=FACT_IMO。传 ALL 不过滤。非 BW 表不受此过滤影响'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ mode, schema, table, topN, minSizeMiB, subtype }) => {
      const m = normalizeMode(mode);
      if (!m.ok) return mcpErrorText(m.message);
      const st = normalizeSubtype(subtype);
      if (!st.ok) return mcpErrorText(st.message);
      if (schema) {
        const v = validateSchemaName(schema);
        if (!v.ok) return mcpErrorText(v.message);
      }
      if (table) {
        const v = validateTableName(table);
        if (!v.ok) return mcpErrorText(v.message);
      }
      const envelope: Envelope = await withErrorEnvelope(() =>
        runTableStorage(ctx.pool, {
          mode: m.value as StorageMode, schema, table, topN, minSizeMiB,
          // 只在调用方真的传了 subtype 时才透传——服务层用"有没有传"区分默认与显式指定
          ...(subtype ? { subtype: st.value } : {}),
        }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
  // ── 4) 历史趋势 ────────────────────────────────────────
  reg(
    'hana_system_trend',
    {
      title: 'HANA 历史趋势',
      description:
        '回答"**这周比上周差了吗**"——前面三个工具都是"此刻的快照"，没有一个能回答变化，'
        + '而容量与性能问题最常见的形态恰恰是"此刻正常、但连续两周单调上升"。\n'
        + '数据源：`_SYS_STATISTICS.HOST_LOAD_HISTORY_HOST`。选它是因为**一份就够**——'
        + '同一张表同时带 CPU、内存（已用/总量/配额）、磁盘（已用/总量）、网络、swap，'
        + '不必跨视图对齐时间轴（跨视图对齐会引入"两边采样时刻差几秒"这类无法解释的错位）。\n'
        + '**实测结构**（照文档猜会写错，这三条决定了输出长什么样）：\n'
        + '  • 约 **10 秒一个采样点**，实测 362,545 行跨约 42 天（1012 个 SNAPSHOT_ID × 358 采样/小时）\n'
        + '  • **`SERVER_TIMESTAMP` 是快照写入时刻，`TIME` 才是采样时刻**：同一 SERVER_TIMESTAMP 下有 358 行'
        + '不同 TIME。用 SERVER_TIMESTAMP 做时间轴会把一整小时的采样压成一个点。本工具用 `TIME`\n'
        + '  • `INDEX` 是 `<host>:<TIME>` 的行唯一键（36 万行有 36 万个取值），**不是服务维度**\n'
        + '参数：`hours` 回溯窗口、`bucketMinutes` 桶宽、`metrics` 选指标组。'
        + '每个桶给出所选指标的 **min / max / avg** 与采样点数。\n'
        + '单位：内存/磁盘 GiB（与 Cockpit 一致），CPU 与占比用 %，网络用 KiB。'
        + '**网络与 swap 是"每个采样周期（约 10 秒）内的量"，不是速率**——乘除 10 才是每秒。\n'
        + '**保留期是有限的**（实测该实例约 42 小时×24，且可配置）。窗口超出时报告里的 `retention.coversWindow` '
        + '为 false、caveats 会说明只回溯到什么时候——**未覆盖的那段不等于"正常"，只是没有数据**。\n'
        + '注意本工具**不给"上升就是坏"的简单结论**：配额内的自然增长未必异常，'
        + '真正可行动的是增长速率与"离配额还有多远"，故 summary 里给首尾桶的变化率，判断留给人。',
      inputSchema: z.object({
        hours: z.number().min(1).max(MAX_HOURS).default(24)
          .describe(`回溯窗口（小时，默认 24，上限 ${MAX_HOURS}）。超出历史层保留期时会如实说明只取到哪一段`),
        bucketMinutes: z.number().int().min(1).max(1440).default(DEFAULT_BUCKET_MINUTES)
          .describe('聚合桶宽（分钟，默认 60）。每个桶给 min/max/avg'),
        metrics: z.array(z.enum(['cpu', 'memory', 'disk', 'network', 'swap'])).optional()
          .describe(`要返回的指标组（默认全部：${ALL_TREND_METRICS.join(', ')}）。'
            + 'cpu=CPU%，memory=内存已用 GiB 与占配额%，disk=磁盘已用 GiB 与占比%，'
            + 'network=网络进出 KiB，swap=swap 字节数`),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ hours, bucketMinutes, metrics }) => {
      const norm = normalizeTrendMetrics(metrics);
      if (!norm.ok) return mcpErrorText(norm.message);
      const envelope: Envelope = await withErrorEnvelope(() =>
        runTrend(ctx.pool, { hours, bucketMinutes, metrics: norm.value }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
}

export type { HealthCategory };
