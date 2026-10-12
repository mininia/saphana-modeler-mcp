/**
 * 数据预览工具（分组 **read**）：hana_data_preview（视图预览 / 基表勘察两种目标）、
 * hana_data_preview_diagnose（预览失败的权限诊断）。
 *
 * 不写仓库、不写任何表；但带 node 的视图预览会在 _SYS_BIC 真建中间视图（DDL），
 * 仅当「本进程已无占用且视图由本服务创建」时才 DROP（见 preview.service 的说明）——
 * 故 hana_data_preview 的注解是 readOnlyHint=false（注解静态，不能随参数切换）。
 * 注册经 capabilityRegistrar；调用期所有能力统一过 authorizeCall，差异只在资源维度由
 * effects.plan 有无表达——两能力均为 read：hana_data_preview 声明了资源计划（inspect 的
 * schema 经 tagResource('readSchema') 进读范围判定）；diagnose 未声明资源计划，
 * packageId 仅进「跨包只读引用」（报告用，不拦截）。
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
    // 目标形态判定：**参数混用一律硬错误**——静默取舍会让被丢弃的一侧成为最难查的一类回执。
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
 * `sampleRows` 的默认值——**从入参 schema 机械派生**（单一事实源 = capabilities/defs/preview.ts 上
 * `sampleRows` 的 `.default(…)`；带默认值 → 按"非默认"判定越界）。
 *
 * 它曾是与 schema 默认值仅靠注释同步的字面量：schema 默认值一改而常量没跟，未传 sampleRows 的视图预览
 * （值已被 schema 归一为默认值）就会在下面被全部拒为「sampleRows 仅用于基表勘察模式」——而调用方根本
 * 没传它。派生后这种漂移在结构上不可能发生；若日后去掉该字段的 `.default()`，本模块会在**加载期**
 * 就抛错（`parse(undefined)` 返回 undefined、与 `: number` 标注无关——类型检查拦不住这条），
 * 属 fail-loud：不会静默退化成旧行为。
 */
const SAMPLE_ROWS_DEFAULT: number = CAP.hana_data_preview.inputSchema.shape.sampleRows.parse(undefined);

/**
 * 判定 `hana_data_preview` 的目标形态。
 *
 * 规则（**混用即报错**，不静默取舍——被丢弃的一侧会变成最难查的一类回执）：
 * 1. 两组目标参数都给 → 报错；
 * 2. 视图组（packageId + objectName）齐全 → view；此时**勘察专用参数**（columns / sampleRows）
 *    不得出现——`sampleRows` 在 schema 上带默认值（见 SAMPLE_ROWS_DEFAULT，从 schema 派生），故按"非默认"判定
 *    （显式传入该默认值本身与"未传"不可区分：值到达 handler 时已被 schema 归一）；
 * 3. 勘察组（schema + table）齐全 → inspect；此时**预览专用参数**（kind/node/parameters/limit/forceDerive）
 *    不得出现——`forceDerive` 默认 false，故按"非默认"（=== true）判定；
 * 4. 两组都不全 → 按缺哪一半给可恢复提示。
 *
 * 依据：入参 schema 的 describe 已把这些参数标成"勘察模式："/"预览模式："——标了就得判，
 * 写明却不执行等于把"静默忽略"留给调用方去踩。
 */
export function resolvePreviewTarget(params: {
  schema?: string;
  table?: string;
  packageId?: string;
  objectName?: string;
  columns?: string[];
  sampleRows?: number;
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
    // sampleRows 在入参 schema 上带默认值（SAMPLE_ROWS_DEFAULT 即该默认值），故按"非默认"判定——与 forceDerive 同法
    if (params.sampleRows !== undefined && params.sampleRows !== SAMPLE_ROWS_DEFAULT) {
      return {
        mode: 'invalid',
        error: 'sampleRows 仅用于基表勘察模式，视图预览不使用它。',
        hint: '基表勘察用 sampleRows/columns/filter；视图预览用 kind/node/parameters/limit/forceDerive',
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
