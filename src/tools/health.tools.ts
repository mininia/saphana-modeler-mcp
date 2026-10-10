/**
 * 稳定性诊断工具（分组 **read**）。
 *
 * 四个工具对应四种形状，刻意不合并：
 *  - hana_system_health   —— 阈值判定，回答「有没有问题」（结论 + 覆盖度）
 *  - hana_system_activity —— 拓扑与明细，回答「问题在哪、谁造成的」（阻塞链/长事务/长语句）
 *  - hana_table_storage   —— 排序画像，回答「该优化谁」（内存/碎片/热度 TOP N）
 *  - hana_system_trend    —— 时间轴趋势，回答「在变好还是变坏」
 * 合并成一个「大而全」的工具会让每次调用都吐出几屏数据，且默认成本高到没人敢调。
 *
 * 四者共用 visibility.service 的可见性判定：都必须在「看不见」时如实说明，
 * 而不是把空结果当正常——这是本项目对 HANA 监视视图行级过滤语义的统一处理。
 *
 * 全部只读（仅 SELECT 系统视图），故归 read 组，经 capabilityRegistrar 按能力清单注册；
 * 该模块全部 gate=none，无调用期闸门。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { runHealth, normalizeChecks } from '../services/health.service.js';
import { runActivity, normalizeSections } from '../services/activity.service.js';
import { runTrend, normalizeTrendMetrics } from '../services/trend.service.js';
import {
  runTableStorage,
  normalizeMode,
  normalizeSubtype,
  validateSchemaName,
  validateTableName,
} from '../services/storage.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { CAP } from '../capabilities/manifest.js';
import { toToolResult } from './common.js';
import type { Envelope } from '../types/hana.js';

export function registerHealthTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  // ── 1) 健康总览 ────────────────────────────────────────
  regCap(CAP.hana_system_health, async ({ checks, thresholds, includeOk }) => {
    const norm = normalizeChecks(checks);
    if (!norm.ok) return mcpErrorText(norm.message);
    const envelope: Envelope = await withErrorEnvelope(async () => {
      const report = await runHealth(ctx.pool, { checks: norm.value, thresholds: thresholds ?? {} });
      return includeOk ? report : { ...report, findings: report.findings.filter((f) => f.level !== 'ok') };
    });
    return toToolResult(envelope);
  });

  // ── 2) 会话与阻塞深潜 ──────────────────────────────────
  regCap(CAP.hana_system_activity, async ({ sections, minDurationSec, limit }) => {
    const norm = normalizeSections(sections);
    if (!norm.ok) return mcpErrorText(norm.message);
    const envelope: Envelope = await withErrorEnvelope(() =>
      runActivity(ctx.pool, { sections: norm.value, minDurationSec, limit }),
    );
    return toToolResult(envelope);
  });

  // ── 3) 表存储画像 ──────────────────────────────────────
  regCap(CAP.hana_table_storage, async ({ mode, schema, table, topN, minSizeMiB, subtype }) => {
    const modeResult = normalizeMode(mode);
    if (!modeResult.ok) return mcpErrorText(modeResult.message);
    const subtypeResult = normalizeSubtype(subtype);
    if (!subtypeResult.ok) return mcpErrorText(subtypeResult.message);
    if (schema) {
      const schemaCheck = validateSchemaName(schema);
      if (!schemaCheck.ok) return mcpErrorText(schemaCheck.message);
    }
    if (table) {
      const tableCheck = validateTableName(table);
      if (!tableCheck.ok) return mcpErrorText(tableCheck.message);
    }
    const envelope: Envelope = await withErrorEnvelope(() =>
      runTableStorage(ctx.pool, {
        mode: modeResult.value,
        schema,
        table,
        topN,
        minSizeMiB,
        // subtype 在 schema 上带默认值（ACTIVE），故此处恒透传；服务层按显式取值区分默认与指定
        subtype: subtypeResult.value,
      }),
    );
    return toToolResult(envelope);
  });

  // ── 4) 历史趋势 ────────────────────────────────────────
  regCap(CAP.hana_system_trend, async ({ hours, bucketMinutes, metrics }) => {
    const norm = normalizeTrendMetrics(metrics);
    if (!norm.ok) return mcpErrorText(norm.message);
    const envelope: Envelope = await withErrorEnvelope(() =>
      runTrend(ctx.pool, { hours, bucketMinutes, metrics: norm.value }),
    );
    return toToolResult(envelope);
  });
}
