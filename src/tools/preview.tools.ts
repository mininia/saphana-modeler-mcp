/**
 * 数据预览工具（分组 **read**）：hana_data_preview（视图预览 / 基表勘察两种目标）、
 * hana_data_preview_diagnose（预览失败的权限诊断）。
 *
 * 全部只读：不写仓库、不写任何表。节点预览经 HANA 原生中间视图机制建临时视图，
 * 仅当「本进程已无占用且视图由本服务创建」时才 DROP（见 preview.service 的说明）。
 * 经 capabilityRegistrar 按能力清单注册；该模块全部 gate=none，无调用期闸门。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { inspectTable, previewData } from '../services/preview.service.js';
import { diagnosePreview } from '../services/preview-diagnose.service.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { CAP } from '../capabilities/manifest.js';
import type { Envelope } from '../types/hana.js';

export function registerPreviewTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  regCap(CAP.hana_data_preview, async (params) => {
    // 目标形态判定（P10-c c2）：**参数混用一律硬错误**，不再"视图优先、勘察参数被静默忽略"。
    // 此前四个模式参数同给时视图模式静默胜出、schema/table 被丢掉——那是最难查的一类回执。
    const target = resolvePreviewTarget(params);
    if ('error' in target) return mcpErrorText(target.error, target.hint);
    if (target.mode === 'inspect') {
      const envelope: Envelope = await withErrorEnvelope(() =>
        inspectTable(ctx.pool, {
          schema: target.schema,
          table: target.table,
          columns: params.columns,
          sampleRows: params.sampleRows,
          filter: params.filter,
        }),
      );
      return toToolResult(envelope);
    }
    const envelope: Envelope = await withErrorEnvelope(() =>
      previewData(ctx.pool, target.packageId, target.objectName, {
        kind: params.kind,
        node: params.node,
        filter: params.filter,
        parameters: params.parameters,
        limit: params.limit,
        forceDerive: params.forceDerive,
      }),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_data_preview_diagnose, async ({ packageId, objectName, kind, channel, verbose }) => {
    const envelope: Envelope = await withErrorEnvelope(() =>
      diagnosePreview(ctx.pool, packageId, objectName, { kind, channel, verbose }),
    );
    return toToolResult(envelope);
  });
}

/** 目标形态判定结果（纯函数，便于单测） */
export type PreviewTarget =
  | { mode: 'inspect'; schema: string; table: string }
  | { mode: 'view'; packageId: string; objectName: string }
  | { mode: 'invalid'; error: string; hint?: string };

/**
 * 判定 `hana_data_preview` 的目标形态（P10-c c2）。
 *
 * 规则（**混用即报错**，不静默取舍）：
 * 1. 两组目标参数都给 → 报错（此前"视图优先"会让 schema/table 被静默忽略）；
 * 2. 视图组（packageId + objectName）齐全 → view；此时**勘察专用参数**（columns）不得出现；
 * 3. 勘察组（schema + table）齐全 → inspect；此时**预览专用参数**（kind/node/parameters/limit/forceDerive）
 *    不得出现（`sampleRows`/`forceDerive` 带默认值，故按"非默认"判定）；
 * 4. 两组都不全 → 按缺哪一半给可恢复提示。
 *
 * 依据：入参 schema 里这些参数的 describe 已写明"勘察模式："/"预览模式："，
 * 但此前没有任何校验——写明了却不执行，等于把"静默忽略"留给调用方去踩。
 */
export function resolvePreviewTarget(params: {
  schema?: string;
  table?: string;
  packageId?: string;
  objectName?: string;
  columns?: string[];
  kind?: string;
  node?: string;
  parameters?: Record<string, string>;
  limit?: number;
  forceDerive?: boolean;
}): PreviewTarget {
  const hasInspect = params.schema !== undefined || params.table !== undefined;
  const hasView = params.packageId !== undefined || params.objectName !== undefined;

  if (hasInspect && hasView) {
    return {
      mode: 'invalid',
      error: '勘察（schema + table）与视图预览（packageId + objectName）二选一，请勿混用。',
      hint: '两种目标不要同时给：基表勘察传 schema+table；视图预览传 packageId+objectName',
    };
  }

  if (hasView) {
    if (!params.packageId || !params.objectName) {
      return {
        mode: 'invalid',
        error: '视图预览需要同时提供 packageId 与 objectName。',
        hint: '对象名不含包名；基表勘察请改传 schema + table',
      };
    }
    if (params.columns && params.columns.length > 0) {
      return {
        mode: 'invalid',
        error: 'columns 仅用于基表勘察模式，视图预览不使用它。',
        hint: '要看视图的输出列，用 hana_metadata_list_fields；逐列画像只对基表/视图做勘察时有效',
      };
    }
    return { mode: 'view', packageId: params.packageId, objectName: params.objectName };
  }

  if (hasInspect) {
    if (!params.schema || !params.table) {
      return {
        mode: 'invalid',
        error: '勘察模式需要同时提供 schema 与 table。',
        hint: '视图预览请改传 packageId + objectName；两者不要混用',
      };
    }
    const viewOnly = [
      params.kind !== undefined ? 'kind' : undefined,
      params.node !== undefined ? 'node' : undefined,
      params.parameters !== undefined ? 'parameters' : undefined,
      params.limit !== undefined ? 'limit' : undefined,
      params.forceDerive === true ? 'forceDerive' : undefined,
    ].filter((x): x is string => x !== undefined);
    if (viewOnly.length > 0) {
      return {
        mode: 'invalid',
        error: `勘察模式不使用这些参数：${viewOnly.join(', ')}（它们只在视图预览模式下生效）。`,
        hint: '基表勘察用 sampleRows/columns/filter；视图预览用 kind/node/parameters/limit/forceDerive',
      };
    }
    return { mode: 'inspect', schema: params.schema, table: params.table };
  }

  return {
    mode: 'invalid',
    error: '需要指定目标：视图预览传 packageId + objectName；基表勘察传 schema + table。',
  };
}
