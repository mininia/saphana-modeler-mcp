/**
 * 建模写工具（分组 **write**）：视图的新建/更新/激活/删除/校验与校验动作查询。
 *
 * 各工具经 capabilityRegistrar 按能力清单（capabilities/defs/modeling.ts）注册：写工具
 * gate=preflight（handler 之前先过预检闸门），只读的 hana_view_check_actions gate=none。
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
import { capabilityRegistrar, type CapabilityHandler, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import { surfaceKeyOf } from './surface.js';
import { currentIdentity } from '../core/request-context.js';
import { CAP } from '../capabilities/manifest.js';
import { DELETE_MIGRATION_DECLARATIONS } from '../capabilities/defs/modeling.js';
import type { Envelope } from '../types/hana.js';

/** 把工具面的 set_script 载荷归一成内部 spec 形状（见调用点注释） */
function normalizeSetScriptOp(op: { op: 'set_script'; script: string; scriptColumns: ScriptColumnSpec[] }) {
  return { op: op.op, script: op.script, columns: op.scriptColumns };
}

/**
 * `migration.strategy` 的 handler 入口校验与类型收窄（SSD §1.6 枚举契约的落地处）：
 * schema 刻意是宽松的 `z.string()`——任何取值都能到达 handler，由这里给**中文硬错误**并列出合法值；
 * 用 z.enum 时非法值会落到 SDK 协议层（英文报错、合法值也不可见）。同款先例：health 的 checks/sections。
 * 合法值常量来自 migrate.rules（单一事实源）；delete 通道的子集由 defs/modeling 从全集派生。
 * @returns error=非法值的中文硬错误文案；value=收窄后的声明（未给 migration 时为 undefined）。
 */
function normalizeMigrationStrategy<T extends string>(
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
  // 收窄点：合法性刚在这里判定（= 放宽 schema 的代价所在），T 由常量数组推断并与服务层声明类型同源
  return {
    value: { strategy: migration.strategy as T, ...(migration.note !== undefined ? { note: migration.note } : {}) },
  };
}

/** 工具面 set_script 的输出列（与清单 schema 同形；此处只做结构搬运） */
type ScriptColumnSpec = {
  name: string;
  dataType: string;
  length?: number;
  isMeasure?: boolean;
  aggregationType?: string;
  description?: string;
};

/**
 * changeset 动作的 migration 合法值**随 action 类别走**（与各单对象通道同一张表）：
 * update=字段级策略∪显式承担（MIGRATION_DECLARATIONS）；delete=仅显式承担（DELETE_MIGRATION_DECLARATIONS）；
 * create 无破坏面（新建对象没有下游可断），不接受该声明——给了就是调用方误解，点名拒绝。
 * 非法值中文硬错误（SSD §1.6：schema 刻意宽松，合法值在调用时列出）；收窄点在这里，服务层只记声明。
 * @returns 命中时返回中文硬错误文案（点名第几项与合法值）；全部合法返回 undefined。
 */
function changesetMigrationDeclarationError(
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
    const allowed = action === 'update' ? MIGRATION_DECLARATIONS : DELETE_MIGRATION_DECLARATIONS;
    if (!(allowed as readonly string[]).includes(migration.strategy)) {
      return (
        `变更集第 ${i} 项（从 0 数）action=${action} 的 migration.strategy "${migration.strategy}" 不是合法取值；` +
        `合法值：${allowed.join(' / ')}`
      );
    }
  }
  return undefined;
}

export function registerModelingTools(server: McpServer, ctx: ToolContext): void {
  // 写工具一律经预检闸门注册：判定不通过时在 handler 之前拦截，不进 service（见 tools/index.ts）
  const registrar = capabilityRegistrar(server, ctx);
  const regCap = registrar;
  /** 操作级别名专用注册入口（只登记原始 handler、不注册工具；fail-closed 校验 routeOnly 标记） */
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
      // mode=sql 与 mode=projection 的必填项不同：在 handler 里给明确的可恢复错误（schema 层做不出条件必填）
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

  // 具名 handler：操作级别名（hana_view_update#<op>）要复用它——同一套校验/闸门/归一，别名只是入口形状
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
    // 三选一（P7）：xml / operations / changeset 恰好一个。此前 xml 与 operations 同给要到服务层才被拒
    // （回执形状不同、且已经读了一次定义）；changeset 与任一单对象方式同给 = 调用方语义不明，同样入口即拒。
    // 服务层那条 xml/operations 断言保留为纵深防御（脚本/内部调用不经过工具层）。
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
    // async 只与 changeset 组合（单对象通道的一次 PUT 不值得异步；静默忽略 async 会制造
    // "我提交了任务"的错觉——显式拒绝并指路）
    if (runAsync === true && changeset === undefined) {
      return mcpErrorText(
        'async=true 仅与 changeset 组合（单对象通道请直接同步调用）',
        '长批次用 changeset + async=true：立即返回 taskId，用 hana_task_get 轮询、hana_task_cancel 取消',
      );
    }
    if (changeset) {
      // changeset 模式与单对象通道的旋钮不组合（显式提供即拒）：批内每项各自取锁内基线并完成激活，
      // ifMatch/activate/probeRows/dryRun/顶层 migration 没有落点。先例：hana_data_preview 的
      // 「勘察模式不使用这些参数」（P10-c c2）——静默忽略比报错更难查；dryRun 尤其致命：
      // 被静默忽略 = "承诺零写入、实际逐项写"，安全承诺直接反转。默认值参数按"非默认"判定（probeRows）。
      const inapplicable = [
        ifMatch !== undefined ? 'ifMatch' : undefined,
        activate === true ? 'activate=true' : undefined,
        // 默认值参数按"非默认"判定（param-guards 既有口径）；undefined 也要放行——
        // 经门面路由进来的 args 可能没跑过默认值填充，不能把"没给"当成"给了非默认值"。
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
      // migration 声明的合法性（SSD §1.6 的中文硬错误口径）按 action 类别在入口收窄——工具层不做
      // 相交/破坏性判定（I3），只做"取的值是否可能是合法声明"这一层。
      const migrationError = changesetMigrationDeclarationError(changeset.actions);
      if (migrationError) return mcpErrorText(migrationError);
      // set_script 的命名归一与单对象通道**同一处理**（工具面 scriptColumns → 内部 columns）：
      // 批次复用 applyChangeset → updateCalculationView，归一必须在这一个边界处做完（I3）。
      // 同步与异步两条通道共用这份归一（在进入服务前完成，异步任务体不再重复做工具层判定）。
      const normalizedActions = changeset.actions.map((action) =>
        action.action === 'update' && action.operations
          ? {
              ...action,
              operations: action.operations.map((op) => (op.op === 'set_script' ? normalizeSetScriptOp(op) : op)),
            }
          : action,
      );
      // 异步任务通道（工具化任务 API，2026-10-10）：立即返回 taskId；批次的全部 HANA 交互
      // （整体预检 → 逐项执行 → 逆序补偿）在任务体内跑——预检仍在任何写入之前，"整批拒绝、零写入"
      // 的语义不变。提交失败（运行上限）在此抛中文硬错误，尚未发生任何写。
      if (runAsync === true) {
        const envelope: Envelope = await withErrorEnvelope(async () =>
          submitChangesetTask(ctx.config, ctx.pool, normalizedActions, surfaceKeyOf(currentIdentity())),
        );
        return toToolResult(envelope);
      }
      const envelope: Envelope = await withErrorEnvelope(async () => {
        const report = await applyChangeset(ctx.config, ctx.pool, { actions: normalizedActions });
        // I2：有任何非 ok 的项（failed/compensated/compensation_failed/conflict_external）绝不允许
        // 包装成 success——转业务失败信封（raw.code=changeset_partial），报告原样进 raw.errorDetail.report。
        // 转换实现是单点（changesetPartialError）：异步任务通道的终态结算共用同一份。
        if (report.partial) throw changesetPartialError(report);
        return report;
      });
      return toToolResult(envelope);
    }
    // 单对象通道要求顶层 packageId/objectName 必填（schema 的 superRefine 已强制；changeset 模式下它们可选且不被消费）。
    // 这里再收窄一次：让类型与运行时都确定，并给绕过 schema 的调用（脚本/内部）留中文硬错误而不是静默。
    if (!packageId || !objectName) {
      return mcpErrorText(
        '单对象模式需要 packageId 与 objectName（changeset 模式下这两个字段被忽略）。',
        '要一次改多个对象请改用 changeset: { actions: [...] }',
      );
    }
    // migration.strategy 的枚举契约在 handler 落地（SSD §1.6）：schema 放宽成 z.string() 后，
    // 非法值必须在这里以中文硬错误列出合法值——入口即拒，一条写都不发生。
    const mig = normalizeMigrationStrategy(migration, MIGRATION_DECLARATIONS, 'hana_view_update');
    if ('error' in mig) return mcpErrorText(mig.error);
    const envelope: Envelope = await withErrorEnvelope(() =>
      updateCalculationView(
        ctx.config,
        ctx.pool,
        packageId,
        objectName,
        // 命名归一（P10-c c2）：工具面统一叫 scriptColumns（与 hana_view_create 同名同义），
        // 内部 view-edit 的 spec 仍叫 columns——差异只在这一个边界处，不扩散到模型层。
        { xml, operations: operations?.map((op) => (op.op === 'set_script' ? normalizeSetScriptOp(op) : op)) },
        // P6：dryRun=只读预演，migration=破坏性变更的显式声明位。判定一律在服务层（I3）——
        // 工具层只透传，若在此预判会造出与 view-diff/migrate.rules 漂移的第二份判定。
        // （strategy 的**合法性**校验是例外：schema 为宽松 z.string()，由上面的 normalizeMigrationStrategy 收窄。）
        { ifMatch, activate, probeRows, dryRun, migration: mig.value },
      ),
    );
    // 乐观锁冲突（If-Match 不匹配的 412）不再转硬错误散文：withErrorEnvelope 产出的业务失败信封
    // 原样回给调用方，raw.conflict 带 currentETag/currentVersion，可重读后重放（SSD §1.2 / §4.2）。
    // 判定走共享读取件 conflictOf（I3）——本模块不自解析 raw.code，命中时只记一条服务端日志。
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

  // 操作级条目（`hana_view_update#<op>`，routeOnly）：只登记原始 handler、不注册工具。
  // 别名把入参还原成父工具的一次 operations 调用——与直调父工具完全等价（同一 handler、同一闸门）。
  for (const decl of VIEW_OPS) {
    const opId = `hana_view_update#${decl.id}`;
    // 运行期取条目（清单构建期已保证别名存在；此处 fail-closed 防手工漂移——声明了却不可达是最坏的静默）
    const opCap = findCapability(opId);
    if (!opCap) throw new Error(`清单里缺操作级条目 ${opId}（VIEW_OPS 与 manifest 漂移）`);
    regCapAlias(opCap, async (args, serverCtx) => {
      const { packageId, objectName, ifMatch, dryRun, migration, ...payload } = args as Record<string, unknown>;
      return handleViewUpdate(
        {
          packageId,
          objectName,
          operations: [{ op: decl.id, ...payload }],
          ifMatch,
          dryRun: dryRun === true,
          migration,
          activate: false,
          probeRows: DEFAULT_PROBE_ROWS,
          async: false,
        } as Parameters<typeof handleViewUpdate>[0],
        serverCtx,
      );
    });
  }

  regCap(CAP.hana_view_delete, async ({ packageId, objectName, migration }) => {
    // migration.strategy 的枚举契约在 handler 落地（SSD §1.6）：delete 通道只有 acknowledge_dependents，
    // 非法值（含 update 通道的字段级策略）入口即拒、列出合法值。
    const mig = normalizeMigrationStrategy(migration, DELETE_MIGRATION_DECLARATIONS, 'hana_view_delete');
    if ('error' in mig) return mcpErrorText(mig.error);
    // P6：pool 供服务层查影响半径（直接下游单跳）做破坏性判定；migration 是破坏性变更的显式承担声明。
    // 判定与拒绝都在服务层（I3），工具层只透传——未声明且有下游引用时服务层拒绝且不删除。
    const envelope: Envelope = await withErrorEnvelope(() =>
      deleteCalculationView(ctx.config, ctx.pool, packageId, objectName, { migration: mig.value }),
    );
    // 与 update 同一审计口径（I3）：命中 412 / OBJECT_NOT_FOUND 机读冲突码时记一条服务端日志；
    // 冲突载荷本身照常由信封透出（不在此转换形状）。
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
