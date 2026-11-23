/**
 * 建模写工具（分组 write）：视图新建/更新/激活/删除/校验与校验动作查询。
 * 声明取自能力清单（capabilities/defs/modeling.ts）；所有能力经统一调用期闸门 authorizeCall。
 * 可写包范围由 HANA_WRITE_PACKAGES 决定。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { conflictOf, mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { submitChangesetTask } from '../services/async-task.service.js';
import { VIEW_OPS } from '../services/view-ops.rules.js';
import {
  DEFAULT_PROBE_ROWS,
  activateCalculationView,
  applyChangeset,
  changesetPartialError,
  checkCalculationViewDesignTime,
  createCalculationView,
  deleteCalculationView,
  updateCalculationView,
} from '../services/repository.service.js';
import { CHANGESET_MAX_ACTIONS } from '../services/changeset.plan.js';
import { getCheckActions, validateCalculationView } from '../services/validation.service.js';
import { MIGRATION_DECLARATIONS } from '../services/migrate.rules.js';
import { findCapability } from '../capabilities/manifest.js';
import { aliasArgsToParentCall } from '../capabilities/planners.js';
import { capabilityRegistrar, type CapabilityHandler, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { currentSurfaceKey } from './surface.js';
import { CAP } from '../capabilities/manifest.js';
import { DELETE_MIGRATION_DECLARATIONS } from '../capabilities/defs/modeling.js';
import type { Envelope } from '../types/hana.js';

/** 工具面 set_script 载荷 → 内部 spec 形状 */
function normalizeSetScriptOp(op: { op: 'set_script'; script: string; scriptColumns: ScriptColumnSpec[] }) {
  return { op: op.op, script: op.script, columns: op.scriptColumns };
}

/**
 * migration.strategy 的入口校验与类型收窄。
 * schema 刻意宽松（z.string()）：非法值在这里给中文硬错误并列出合法值，不落到 SDK 协议层的英文报错。
 * 合法值常量来自 migrate.rules（单一事实源）。
 */
export function normalizeMigrationStrategy<T extends string>(
  migration: { strategy: string; note?: string } | undefined,
  allowed: readonly T[],
  channel: string,
): { error: string } | { value: { strategy: T; note?: string } | undefined } {
  if (!migration) return { value: undefined };
  if (!(allowed as readonly string[]).includes(migration.strategy)) {
    return {
      error: `${channel} 的 migration.strategy "${migration.strategy}" 不是合法取值；合法值：${allowed.join(' / ')}`,
    };
  }
  // 合法性刚在这里判定，T 由常量数组推断并与服务层声明类型同源
  return {
    value: { strategy: migration.strategy as T, ...(migration.note !== undefined ? { note: migration.note } : {}) },
  };
}

/** 工具面 set_script 的输出列（与清单 schema 同形） */
type ScriptColumnSpec = {
  name: string;
  dataType: string;
  length?: number;
  isMeasure?: boolean;
  aggregationType?: string;
  description?: string;
};

/**
 * changeset 动作的 migration 合法值随 action 走：update=全集；delete=仅显式承担；create 不接受。
 * 判定与文案复用 normalizeMigrationStrategy，另加 create 拒绝分支与「第几项」前缀。
 */
export function changesetMigrationDeclarationError(
  actions: ReadonlyArray<{ action: 'update' | 'create' | 'delete'; migration?: { strategy: string } }>,
): string | undefined {
  for (let i = 0; i < actions.length; i++) {
    const { action, migration } = actions[i];
    if (!migration) continue;
    if (action === 'create') {
      return (
        `变更集第 ${i} 项（从 0 数）的 action=create 不接受 migration 声明：` +
        '新建对象没有下游破坏面，该声明只对 update / delete 动作有意义'
      );
    }
    const allowed: readonly string[] = action === 'update' ? MIGRATION_DECLARATIONS : DELETE_MIGRATION_DECLARATIONS;
    const mig = normalizeMigrationStrategy(migration, allowed, `变更集第 ${i} 项（从 0 数）action=${action}`);
    if ('error' in mig) return mig.error;
  }
  return undefined;
}

export function registerModelingTools(server: McpServer, ctx: ToolContext): void {
  // 注册器给每个 handler 套上统一调用期闸门（authorizeCall），判定不通过不进 service。
  const registrar = capabilityRegistrar(server, ctx);
  const regCap = registrar;
  /** 操作级别名专用入口（只登记 handler、不注册工具；校验 routeOnly 标记） */
  const regCapAlias = registrar.routeOnly;

  regCap(
    CAP.hana_view_create,
    async ({
      packageId,
      objectName,
      description,
      mode,
      sourceSchema,
      sourceName,
      sourcePackageId,
      sourceObjectName,
      sourceColumns,
      operations,
      graph,
      layout,
      script,
      scriptColumns,
      measureMode,
      activate,
      transport,
      columns,
      probeRows,
    }) => {
      // mode=sql 与 graphical/projection 的必填项不同：schema 层做不出条件必填，这里给可恢复错误
      const hasTableSource = sourceSchema !== undefined || sourceName !== undefined;
      const hasCvSource = sourcePackageId !== undefined || sourceObjectName !== undefined;
      if (mode === 'sql') {
        if (!script || !scriptColumns || scriptColumns.length === 0) {
          return mcpErrorText(
            'mode=sql 需要同时提供 script（SQL 脚本）与 scriptColumns（输出列清单，含 dataType）。',
            '输出列的类型无法从 SQL 文本推断，必须逐个给出；若只想按源表全列透传，请改用 mode=graphical',
          );
        }
        if (
          hasTableSource ||
          hasCvSource ||
          sourceColumns !== undefined ||
          (operations?.length ?? 0) > 0 ||
          graph !== undefined
        ) {
          return mcpErrorText(
            'mode=sql 不接受 sourceSchema/sourceName、sourcePackageId/sourceObjectName、sourceColumns、operations 或 graph。',
            'SQL 模式直接用 script 里的 FROM 引用源；需要图形化源/join 请改用 mode=graphical',
          );
        }
      } else if (graph !== undefined) {
        if (
          hasTableSource ||
          hasCvSource ||
          sourceColumns !== undefined ||
          columns !== undefined ||
          (operations?.length ?? 0) > 0
        ) {
          return mcpErrorText(
            'graph 与 source*/sourceColumns/columns/operations 互斥：模块图的源与节点都写在 graph 中。',
            '用 graph.sources 声明物理表/CV 源，graph.nodes 声明 join/union 等模块实例；不要同时给 sourceSchema/sourceName 或 operations',
          );
        }
      } else {
        if (hasTableSource && hasCvSource) {
          return mcpErrorText(
            '初始源二选一：物理表（sourceSchema/sourceName）与 CV（sourcePackageId/sourceObjectName）不能同时提供。',
            'CV 作为初始源用 sourcePackageId/sourceObjectName；物理表用 sourceSchema/sourceName',
          );
        }
        if (!hasTableSource && !hasCvSource) {
          return mcpErrorText(
            'mode=graphical/projection 需要初始源：物理表给 sourceSchema/sourceName，或用 CV 给 sourcePackageId/sourceObjectName。',
            '若目标是按 SQL 逻辑建模，请改用 mode=sql（给 script + scriptColumns）',
          );
        }
        if (hasCvSource && (!sourcePackageId || !sourceObjectName)) {
          return mcpErrorText(
            'CV 初始源需要同时提供 sourcePackageId 与 sourceObjectName。',
            '两者缺一无法定位源 CV；也可改用物理表 sourceSchema/sourceName',
          );
        }
        if (hasTableSource && (!sourceSchema || !sourceName)) {
          return mcpErrorText(
            '物理表初始源需要同时提供 sourceSchema 与 sourceName。',
            '两者缺一无法定位源表；也可改用 CV 源 sourcePackageId/sourceObjectName',
          );
        }
        if (hasTableSource && sourceColumns !== undefined) {
          return mcpErrorText('sourceColumns 仅用于 CV 初始源；物理表源请用 columns（列名清单，类型由服务端回查）。');
        }
        if (hasCvSource && sourceColumns !== undefined && columns !== undefined) {
          return mcpErrorText(
            'CV 初始源的 columns 与 sourceColumns 二选一：columns 只给列名（类型查 _SYS_BIC），sourceColumns 显式给类型。',
          );
        }
      }
      const source =
        mode === 'sql' || graph !== undefined
          ? undefined
          : hasCvSource
            ? {
                packageId: sourcePackageId!,
                objectName: sourceObjectName!,
                measureMode,
                ...(sourceColumns !== undefined
                  ? {
                      columns: sourceColumns.map((c) => ({
                        columnName: c.name,
                        dataTypeName: c.dataType,
                      })),
                    }
                  : columns !== undefined
                    ? { columns: columns.map((c) => ({ columnName: c })) }
                    : {}),
              }
            : {
                schema: sourceSchema!,
                name: sourceName!,
                measureMode,
                // 工具面 columns 是列名字符串数组：类型由服务层按列名回查源表列目录补齐。
                // 缺类型会让默认 SUM_NUMERIC 下 0 度量、视图无法激活。
                ...(columns !== undefined ? { columns: columns.map((c) => ({ columnName: c })) } : {}),
              };
      const envelope: Envelope = await withErrorEnvelope(() =>
        createCalculationView(ctx.config, ctx.pool, {
          packageId,
          objectName,
          description,
          mode,
          ...(mode === 'sql'
            ? { scripted: { script: script!, columns: scriptColumns! } }
            : graph !== undefined
              ? { graph, layout }
              : { source: source! }),
          ...(operations !== undefined && operations.length > 0
            ? { operations: operations.map((op) => (op.op === 'set_script' ? normalizeSetScriptOp(op) : op)) }
            : {}),
          activate,
          transport,
          probeRows,
        }),
      );
      return toToolResult(envelope);
    },
  );

  regCap(CAP.hana_view_validate, async ({ target, packageId, objectName, schema, viewName, action }) => {
    if (target === 'design') {
      if (!packageId || !objectName) {
        return mcpErrorText(
          'design 模式需要 packageId 与 objectName（设计时对象激活前校验）。',
          '要校验运行时视图请改传 target=runtime 并给 schema + viewName',
        );
      }
      const envelope: Envelope = await withErrorEnvelope(() =>
        checkCalculationViewDesignTime(ctx.config, packageId, objectName),
      );
      return toToolResult(envelope);
    }
    if (!viewName) {
      return mcpErrorText(
        'runtime 模式需要 viewName（形如 「ZDEMO.ZDEMO_MKC/ZDEMO03_CV003」）。',
        '要校验设计时对象请改传 target=design 并给 packageId + objectName',
      );
    }
    const envelope: Envelope = await withErrorEnvelope(() =>
      validateCalculationView(ctx.pool, schema, viewName, action),
    );
    return toToolResult(envelope);
  });

  regCap(CAP.hana_view_check_actions, async ({ checkProcedureName }) => {
    const envelope: Envelope = await withErrorEnvelope(() => getCheckActions(ctx.pool, checkProcedureName));
    return toToolResult(envelope);
  });

  regCap(CAP.hana_view_activate, async ({ packageId, objectName }) => {
    const envelope: Envelope = await withErrorEnvelope(() =>
      activateCalculationView(ctx.config, ctx.pool, packageId, objectName, 'xs_rest'),
    );
    return toToolResult(envelope);
  });

  // 具名 handler：操作级别名复用同一套校验/闸门/归一，别名只是入口形状
  const handleViewUpdate: CapabilityHandler<typeof CAP.hana_view_update.inputSchema> = async ({
    packageId,
    objectName,
    xml,
    operations,
    graph,
    layout,
    changeset,
    ifMatch,
    activate,
    probeRows,
    dryRun,
    migration,
    async: runAsync,
  }) => {
    // 四选一（xml / operations / graph / changeset）：入口即拒，服务层的断言保留为纵深防御。
    const provided = [
      xml !== undefined ? 'xml' : undefined,
      operations && operations.length > 0 ? 'operations' : undefined,
      graph !== undefined ? 'graph' : undefined,
      changeset !== undefined ? 'changeset' : undefined,
    ].filter((x): x is string => x !== undefined);
    if (provided.length > 1) {
      return mcpErrorText(
        `xml / operations / graph / changeset 四选一，请勿同时提供（本次同时收到：${provided.join(' + ')}）`,
        '节点组合用 graph（增量合并）；字段/脚本/描述用 operations；全量改造用 xml；多对象批次用 changeset',
      );
    }
    if (provided.length === 0) {
      return mcpErrorText(
        '需要提供 graph（模块图增量合并）、operations（视图级操作补丁）、xml（全量 XML）或 changeset（多对象变更集）之一',
        `节点组合用 graph；单对象字段/脚本改动用 operations；多对象批次用 changeset（actions 上限 ${CHANGESET_MAX_ACTIONS}）`,
      );
    }
    // async 只与 changeset 组合：静默忽略会制造「已提交任务」的错觉，显式拒绝并指路
    if (runAsync === true && changeset === undefined) {
      return mcpErrorText(
        'async=true 仅与 changeset 组合（单对象通道请直接同步调用）',
        '长批次用 changeset + async=true：立即返回 taskId，用 hana_task_get 轮询、hana_task_cancel 取消',
      );
    }
    if (changeset) {
      // changeset 与单对象旋钮不组合（显式提供即拒）：批内各项自成一体，这些参数没有落点。
      // dryRun 尤其致命：被静默忽略 = 承诺零写入、实际逐项写。默认值参数按「非默认」判定。
      const inapplicable = [
        ifMatch !== undefined ? 'ifMatch' : undefined,
        activate === true ? 'activate=true' : undefined,
        // 直调 handler 的 args 可能没跑过默认值填充：undefined 要放行。
        probeRows !== undefined && probeRows !== DEFAULT_PROBE_ROWS ? 'probeRows' : undefined,
        dryRun === true ? 'dryRun=true' : undefined,
        migration !== undefined ? 'migration' : undefined,
        layout !== undefined ? 'layout' : undefined,
      ].filter((x): x is string => x !== undefined);
      if (inapplicable.length > 0) {
        return mcpErrorText(
          `changeset 模式与单对象通道参数（${inapplicable.join(' / ')}）不组合`,
          '批内每项各自取锁内基线并完成激活、不发起行探测；破坏性动作的 migration 声明放在各自的 action 上',
        );
      }
      if (changeset.actions.length === 0) {
        return mcpErrorText(
          'changeset.actions 不能为空（空批次会返回一次什么都没做的"成功"）',
          `给出 1~${CHANGESET_MAX_ACTIONS} 个动作，或改用 xml/operations 的单对象通道`,
        );
      }
      // migration 合法值在入口收窄（工具层不做相交/破坏性判定）。
      const migrationError = changesetMigrationDeclarationError(changeset.actions);
      if (migrationError) return mcpErrorText(migrationError);
      // set_script 命名归一与单对象通道同一处理，同步/异步两条通道共用（进入服务前完成）。
      const normalizedActions = changeset.actions.map((action) =>
        action.action === 'update' && action.operations
          ? {
              ...action,
              operations: action.operations.map((op) => (op.op === 'set_script' ? normalizeSetScriptOp(op) : op)),
            }
          : action,
      );
      // 异步任务通道：立即返回 taskId；预检→逐项→补偿都在任务体内跑，「整批拒绝、零写入」语义不变。
      if (runAsync === true) {
        const envelope: Envelope = await withErrorEnvelope(async () =>
          submitChangesetTask(ctx.config, ctx.pool, normalizedActions, currentSurfaceKey()),
        );
        return toToolResult(envelope);
      }
      const envelope: Envelope = await withErrorEnvelope(async () => {
        const report = await applyChangeset(ctx.config, ctx.pool, { actions: normalizedActions });
        // 有任何非 ok 项（failed/compensated/…）绝不允许包装成 success——转业务失败信封，
        // 报告原样进 raw.errorDetail.report（转换实现单点：changesetPartialError）。
        if (report.partial) throw changesetPartialError(report);
        return report;
      });
      return toToolResult(envelope);
    }
    // schema 的 superRefine 已强制单对象通道必填；这里再收窄一次，兼容绕过 schema 的调用。
    if (!packageId || !objectName) {
      return mcpErrorText(
        '单对象模式需要 packageId 与 objectName（changeset 模式下这两个字段被忽略）。',
        '要一次改多个对象请改用 changeset: { actions: [...] }',
      );
    }
    // migration.strategy 的合法性在入口收窄：非法值一条写都不发生。
    const mig = normalizeMigrationStrategy(migration, MIGRATION_DECLARATIONS, 'hana_view_update');
    if ('error' in mig) return mcpErrorText(mig.error);
    const envelope: Envelope = await withErrorEnvelope(() =>
      updateCalculationView(
        ctx.config,
        ctx.pool,
        packageId,
        objectName,
        // 命名归一：工具面叫 scriptColumns，内部 view-edit spec 叫 columns——差异只在这一个边界。
        {
          xml,
          operations: operations?.map((op) => (op.op === 'set_script' ? normalizeSetScriptOp(op) : op)),
          ...(graph !== undefined ? { graph, layout } : {}),
        },
        // dryRun/migration 的判定一律在服务层；工具层只做 strategy 的合法性收窄。
        { ifMatch, activate, probeRows, dryRun, migration: mig.value },
      ),
    );
    // 412 乐观锁冲突按业务失败信封原样返回（raw.conflict 带 currentETag/currentVersion）；
    // 这里只记一条服务端日志，命中判定走共享的 conflictOf。
    const conflict = conflictOf(envelope);
    if (conflict) {
      logger.warn(
        { packageId, objectName, code: conflict.code, currentETag: conflict.conflict?.currentETag },
        '视图更新冲突：已按业务失败信封返回（调用方从 raw.conflict 取机读载荷）',
      );
    }
    return toToolResult(envelope);
  };
  regCap(CAP.hana_view_update, handleViewUpdate);

  // 操作级条目（hana_view_update#<op>）：只登记 handler、不注册工具；
  // 别名把入参还原成父工具的一次 operations 调用，与直调父工具完全等价。
  for (const decl of VIEW_OPS) {
    const opId = `hana_view_update#${decl.id}`;
    // fail-closed：清单里缺别名条目说明声明漂移，当场报错而不是静默不可达。
    const opCap = findCapability(opId);
    if (!opCap) throw new Error(`清单里缺操作级条目 ${opId}（VIEW_OPS 与 manifest 漂移）`);
    regCapAlias(opCap, async (args, serverCtx) => {
      // 身份参数与 op 载荷的切分共用 aliasArgsToParentCall，不在此手抄清单。
      const call = aliasArgsToParentCall(decl.id, args as Record<string, unknown>);
      return handleViewUpdate(
        {
          ...call,
          dryRun: call.dryRun === true,
          activate: false,
          probeRows: DEFAULT_PROBE_ROWS,
          async: false,
        } as Parameters<typeof handleViewUpdate>[0],
        serverCtx,
      );
    });
  }

  regCap(CAP.hana_view_delete, async ({ packageId, objectName, migration }) => {
    // delete 通道只有 acknowledge_dependents；非法值入口即拒并列出合法值。
    const mig = normalizeMigrationStrategy(migration, DELETE_MIGRATION_DECLARATIONS, 'hana_view_delete');
    if ('error' in mig) return mcpErrorText(mig.error);
    // pool 供服务层查直接下游做破坏性判定；未声明且有下游时服务层拒绝且不删除。
    const envelope: Envelope = await withErrorEnvelope(() =>
      deleteCalculationView(ctx.config, ctx.pool, packageId, objectName, { migration: mig.value }),
    );
    // 与 update 同一审计口径：命中机读冲突码记一条日志，载荷照常由信封透出。
    const conflict = conflictOf(envelope);
    if (conflict) {
      logger.warn(
        { packageId, objectName, code: conflict.code, currentETag: conflict.conflict?.currentETag },
        '视图删除冲突：已按业务失败信封返回（调用方从 raw.conflict 取机读载荷）',
      );
    }
    return toToolResult(envelope);
  });
}
