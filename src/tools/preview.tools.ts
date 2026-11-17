/**
 * 数据预览工具（分组 read）：hana_data_preview（视图预览 / 基表勘察）、hana_data_preview_diagnose。
 * 带 node 的视图预览会在 _SYS_BIC 建中间视图，故 preview 的注解 readOnlyHint=false。
 * preview 声明资源计划（inspect 的 schema 进读范围）；diagnose 的 packageId 仅作只读引用报告。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { attachResultInfo, resultInfoOf } from '../core/result-info.js';
import { inspectTable, previewData } from '../services/preview.service.js';
import { diagnosePreview } from '../services/preview-diagnose.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { CAP } from '../capabilities/manifest.js';
import { resolvePreviewTarget, SAMPLE_ROWS_DEFAULT } from '../capabilities/preview-target.js';
import type { Envelope } from '../types/hana.js';

// 单测历史从本模块 import resolvePreviewTarget：保留 re-export，实现已移到 capabilities 叶子层。
export { resolvePreviewTarget, type PreviewTarget } from '../capabilities/preview-target.js';

export function registerPreviewTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  regCap(CAP.hana_data_preview, async (params) => {
    // 目标形态判定：参数混用一律硬错误（静默取舍会让被丢弃的一侧成为最难查的回执）。
    const target = resolvePreviewTarget(params);
    if ('error' in target) return mcpErrorText(target.error, target.hint);
    if (target.mode === 'inspect') {
      const envelope: Envelope = await withErrorEnvelope(async () => {
        const data = await inspectTable(ctx.pool, {
          schema: target.schema,
          table: target.table,
          columns: params.columns,
          sampleRows: params.sampleRows,
          filter: params.filter,
        });
        // 采样口径：sampledRows 是本次实际读到的行数，sampleRows 是上限；
        // truncated=true 表示"表里还有更多行没进样本"（统计结论只覆盖样本）。
        return attachResultInfo(
          data,
          resultInfoOf({
            returnedCount: data.sampledRows,
            limit: params.sampleRows,
            // sampleRows 带 schema 默认值：按「非默认」判定调用方是否显式指定（同 resolvePreviewTarget）
            requestedLimit: params.sampleRows !== SAMPLE_ROWS_DEFAULT,
            truncated: data.truncated,
          }),
        );
      });
      return toToolResult(envelope);
    }
    const envelope: Envelope = await withErrorEnvelope(async () => {
      const data = await previewData(ctx.pool, target.packageId, target.objectName, {
        kind: params.kind,
        node: params.node,
        filter: params.filter,
        parameters: params.parameters,
        limit: params.limit,
        forceDerive: params.forceDerive,
      });
      return attachResultInfo(
        data,
        resultInfoOf({
          returnedCount: data.rows.length,
          limit: data.limit,
          requestedLimit: params.limit !== undefined,
          truncated: data.truncated,
        }),
      );
    });
    return toToolResult(envelope);
  });

  regCap(CAP.hana_data_preview_diagnose, async ({ packageId, objectName, kind, channel, verbose }) => {
    const envelope: Envelope = await withErrorEnvelope(() =>
      diagnosePreview(ctx.pool, packageId, objectName, { kind, channel, verbose }),
    );
    return toToolResult(envelope);
  });
}
