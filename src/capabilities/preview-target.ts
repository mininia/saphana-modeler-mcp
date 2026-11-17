/**
 * 数据预览目标形态判定（纯函数）。
 *
 * 放在 capabilities/ 叶子层：`defs/preview.ts` 用它做**提升前**的跨字段预检，
 * `tools/preview.tools.ts` 用它做 handler 的防御性复核——同一份实现，不抄第二份。
 * 本模块不得 import defs/tools/service（避免成环）。
 */

/** 目标形态判定结果 */
export type PreviewTarget =
  | { mode: 'inspect'; schema: string; table: string }
  | { mode: 'view'; packageId: string; objectName: string }
  | { mode: 'invalid'; error: string; hint?: string };

/** sampleRows 的 schema 默认值（单一事实源：defs/preview.ts 的 .default(…) 也从这里取） */
export const SAMPLE_ROWS_DEFAULT = 200;

/**
 * 判定 hana_data_preview 的目标形态：参数混用即报错，不静默取舍。
 * - 两组目标参数都给 → 报错；两组都不全 → 按缺哪一半给可恢复提示；
 * - 视图组齐全 → view，勘察专用参数（columns / sampleRows）按「非默认」判定后拒绝；
 * - 勘察组齐全 → inspect，预览专用参数（kind/node/parameters/limit/forceDerive）出现即拒绝。
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
    // sampleRows 带 schema 默认值，按「非默认」判定（与 forceDerive 同法）
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
