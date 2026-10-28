/**
 * 元数据读取工具（分组 read）：视图定义/字段/字段逻辑/血缘、对象搜索、表清单与表结构。
 * 全部只读，声明取自能力清单；表清单/列结构的 schema 参数进读范围判定，其余读固定仓库面。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withErrorEnvelope, mcpErrorText } from '../core/errors.js';
import { attachPagedInfo, attachResultInfo, markEmptyResult, resultInfoOf } from '../core/result-info.js';
import {
  fieldLineage,
  getTableColumns,
  getViewDefinition,
  getViewFieldList,
  getViewFieldLogic,
  listTables,
  searchObjects,
  searchObjectsByField,
  whereUsed,
} from '../services/metadata.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { CAP } from '../capabilities/manifest.js';
import { toToolResult } from './common.js';
import type { Envelope } from '../types/hana.js';

/**
 * 各工具 limit 的 schema 默认值（单一事实源 = 清单）。
 * zod 在调用前已填默认值，`limit !== undefined` 恒真；用它区分「调用方显式给的上限」与「服务端默认」。
 */
const SEARCH_LIMIT_DEFAULT: number = CAP.hana_metadata_search_objects.inputSchema.shape.limit.parse(undefined);
const TABLE_LIST_LIMIT_DEFAULT: number = CAP.hana_table_list.inputSchema.shape.limit.parse(undefined);
const TABLE_COLUMNS_LIMIT_DEFAULT: number = CAP.hana_table_columns.inputSchema.shape.limit.parse(undefined);

export function registerMetadataTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  regCap(CAP.hana_metadata_get_view, async ({ packageId, objectName, kind, format, version }) => {
    const envelope: Envelope = await withErrorEnvelope(() =>
      getViewDefinition(ctx.pool, packageId, objectName, { kind, format, version }),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_metadata_search_objects, async ({ pattern, by, field, kind, limit, maxCandidates, version }) => {
    // 跨字段条件必填：zod 表达不了（handler 级硬错误 + 可恢复指引）
    const mode = by ?? 'name';
    if (mode === 'name' && !pattern) {
      return mcpErrorText('by=name（默认）需要 pattern', '按对象名搜索请给 pattern；按字段搜索用 by=field + field');
    }
    if (mode === 'field' && !field) {
      return mcpErrorText('by=field 需要 field', '给出字段 ID 片段（如 MATERIAL）；pattern 可选，用于收窄对象名候选');
    }
    const envelope: Envelope = await withErrorEnvelope(async () => {
      if (mode === 'field') {
        const data = await searchObjectsByField(ctx.pool, {
          field: field as string,
          ...(pattern ? { pattern } : {}),
          kind,
          limit,
          version,
          // 未给就用服务默认（100）：不在这里抄第二份默认值
          ...(maxCandidates !== undefined ? { maxCandidates } : {}),
        });
        // 候选扫描被 maxCandidates 截断归 server-cap。零命中时同样保留 resultInfo：
        // `{returnedCount:0, truncated:true, reason:'server-cap'}` 表示"扫过的部分没命中、但没扫完"，
        // 不是合法空集（envelope 不会带 empty）——这正是不让模型误判"搜索已穷尽"的关键。
        return attachResultInfo(
          data,
          resultInfoOf({
            returnedCount: data.objects.length,
            limit: data.limit,
            requestedLimit: limit !== SEARCH_LIMIT_DEFAULT,
            serverCapHit: data.candidatesScanned >= data.maxCandidates,
            truncated: data.truncated,
          }),
        );
      }
      return attachPagedInfo(await searchObjects(ctx.pool, { pattern: pattern as string, kind, limit, version }), {
        requestedLimit: limit !== SEARCH_LIMIT_DEFAULT,
      });
    });
    return toToolResult(envelope);
  });

  regCap(
    CAP.hana_metadata_list_fields,
    async ({ packageId, objectName, pattern, exact, kind, includeNodeCalculated, version }) => {
      // exact=true 必须配 pattern：空 pattern 会按空串精确匹配并返回空清单，调用方会误以为视图没字段。
      if (exact && !pattern) {
        return mcpErrorText(
          'exact=true 需要同时提供 pattern（精确匹配的字段 ID）。',
          '要精确匹配请给 pattern；想看全部字段请去掉 exact（默认 false = 片段匹配）',
        );
      }
      const envelope: Envelope = await withErrorEnvelope(async () => {
        const data = await getViewFieldList(ctx.pool, packageId, objectName, {
          kind,
          pattern,
          exact,
          includeNodeCalculated,
          version,
        });
        // 字段清单没有 limit 语义：空清单是合法结果（pattern 未命中/视图无输出字段），标空集而非截断。
        return data.list.fields.length === 0 ? markEmptyResult(data) : data;
      });
      return toToolResult(envelope);
    },
  );

  regCap(
    CAP.hana_metadata_get_field_logic,
    async ({ packageId, objectName, fieldId, kind, includeUsage, usageMaxViews, version }) => {
      const envelope: Envelope = await withErrorEnvelope(async () => {
        const base = await getViewFieldLogic(ctx.pool, packageId, objectName, fieldId, { kind, version });
        if (!includeUsage) return base;
        const lineage = await fieldLineage(ctx.pool, packageId, objectName, fieldId, {
          direction: 'downstream',
          version,
          // 复用上面已取到的种子对象，避免再查一次对象表
          seedObject: base.object,
          ...(usageMaxViews !== undefined ? { maxViews: usageMaxViews } : {}),
        });
        const usage = {
          version: lineage.version,
          downstream: lineage.downstream,
          nameAlignedConsumers: lineage.nameAlignedConsumers,
          viewsScanned: lineage.viewsScanned,
          maxViews: lineage.maxViews,
          failedCandidates: lineage.failedCandidates,
          truncated: lineage.truncated,
          asOf: lineage.asOf,
        };
        // 字段级下游血缘同样是"扫描空间"：扫描被 maxViews 截断时也要在信封层可见，
        // 否则模型按 result_contract「无 resultInfo = 未截断」会误判血缘完整。
        return attachResultInfo(
          { ...base, usage },
          resultInfoOf({
            returnedCount: usage.downstream.length,
            serverCapHit: usage.truncated === true,
            truncated: usage.truncated,
          }),
        );
      });
      return toToolResult(envelope);
    },
  );

  regCap(CAP.hana_metadata_where_used, async ({ packageId, objectName, kind, direction, depth, version }) => {
    const envelope: Envelope = await withErrorEnvelope(async () => {
      const data = await whereUsed(ctx.pool, packageId, objectName, {
        kind,
        direction,
        version,
        ...(depth !== undefined ? { depth } : {}),
      });
      // depth=1 是单跳全量，没有 cap；depth>1 的闭包受 maxNodes 约束（触达即 truncated）。
      if (depth === undefined || depth === 1) return data;
      const closureCount = (data.closure?.upstream.length ?? 0) + (data.closure?.downstream.length ?? 0);
      return attachResultInfo(
        data,
        resultInfoOf({
          returnedCount: closureCount,
          serverCapHit: data.truncated === true,
          truncated: data.truncated,
        }),
      );
    });
    return toToolResult(envelope);
  });

  regCap(CAP.hana_table_list, async ({ schema, pattern, limit }) => {
    const envelope: Envelope = await withErrorEnvelope(async () =>
      attachPagedInfo(await listTables(ctx.pool, { schema, pattern, limit }), {
        requestedLimit: limit !== TABLE_LIST_LIMIT_DEFAULT,
      }),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_table_columns, async ({ schema, table, limit }) => {
    const envelope: Envelope = await withErrorEnvelope(async () =>
      attachPagedInfo(await getTableColumns(ctx.pool, schema, table, { limit }), {
        requestedLimit: limit !== TABLE_COLUMNS_LIMIT_DEFAULT,
      }),
    );
    return toToolResult(envelope);
  });
}
