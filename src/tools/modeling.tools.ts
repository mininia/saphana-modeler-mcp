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
      script,
      scriptColumns,
      measureMode,
      activate,
      transport,
      columns,
      probeRows,
    }) => {
      // mode=sql 与 projection 的必填项不同：schema 层做不出条件必填，这里给可恢复错误
      if (mode === 'sql' && (!script || !scriptColumns || scriptColumns.length === 0)) {
        return mcpErrorText(
          'mode=sql 需要同时提供 script（SQL 脚本）与 scriptColumns（输出列清单，含 dataType）。',
          '输出列的类型无法从 SQL 文本推断，必须逐个给出；若只想按源表全列透传，请改用 mode=projection',
        );
      }
      if (mode === 'projection' && (!sourceSchema || !sourceName)) {
        return mcpErrorText(
          'mode=projection 需要提供 sourceSchema 与 sourceName。',
          '若目标是按 SQL 逻辑建模，请改用 mode=sql（给 script + scriptColumns）',
        );
      }
      const envelope: Envelope = await withErrorEnvelope(() =>
        createCalculationView(ctx.config, ctx.pool, {
          packageId,
          objectName,
          description,
          mode,
          ...(mode === 'sql'
            ? { scripted: { script: script!, columns: scriptColumns! } }
            : {
                source: {
                  schema: sourceSchema!,
                  name: sourceName!,
                  measureMode,
                  // 工具面 columns 是列名字符串数组：类型由服务层按列名回查源表列目录补齐。
                  // 缺类型会让默认 SUM_NUMERIC 下 0 度量、视图无法激活。
                  columns: columns?.map((c) => ({ columnName: c })),
                },
              }),
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
    changeset,
    ifMatch,
    activate,
    probeRows,
    dryRun,
    migration,
    async: runAsync,
  }) => {
    // 三选一（xml / operations / changeset）：入口即拒，服务层的断言保留为纵深防御。
    const provided = [
      xml !== undefined ? 'xml' : undefined,
      operations && operations.length > 0 ? 'operations' : undefined,
      changeset !== undefined ? 'changeset' : undefined,
    ].filter((x): x is string => x !== undefined);
    if (provided.length > 1) {
      return mcpErrorText(
        `xml / operations / changeset 三选一，请勿同时提供（本次同时收到：${provided.join(' + ')}）`,
        '单对象改造用 operations（推荐）或 xml；多对象批次用 changeset（单次调用内闭合，失败逆序补偿）',
      );
    }
    if (provided.length === 0) {
      return mcpErrorText(
        '需要提供 xml（全量 XML 更新）、operations（声明式操作补丁，推荐）或 changeset（多对象变更集）之一',
        `单对象用 operations 免读写 XML（加 join / 改 SQL）；多对象批次用 changeset（actions 上限 ${CHANGESET_MAX_ACTIONS}）`,
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
        // 经门面路由进来的 args 可能没跑过默认值填充：undefined 要放行。
        probeRows !== undefined && probeRows !== DEFAULT_PROBE_ROWS ? 'probeRows' : undefined,
        dryRun === true ? 'dryRun=true' : undefined,
        migration !== undefined ? 'migration' : undefined,
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
        { xml, operations: operations?.map((op) => (op.op === 'set_script' ? normalizeSetScriptOp(op) : op)) },
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
