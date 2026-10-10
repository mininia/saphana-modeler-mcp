import { objectRefsOfUpdate, sameObjectRef, type ObjectRef } from '../write-plan.js';

/**
 * 变更集（多对象事务）的**规划与相交检测** —— SSD §6.1 第 1 步 + §6.2。纯函数、零 I/O。
 *
 * 为什么需要它：批内动作可能互相依赖（一项写、另一项读同一个对象），无论怎么排执行序都有一方
 * 会踩到另一方（读方读到被覆盖前/后的版本，或写方按已过期的基线提交）。这类批必须**整批拒绝、
 * 零写入**。判定依据不能靠 agent 自报，必须从动作载荷里推导——本模块就是那次推导。
 *
 * 粒度为什么是**对象级**（SSD §6.2 评审修订）：包级相交会把「同包多对象」的正常批次全部误拒
 * （10 个同包对象 ⇒ writePackages 集合相同 ⇒ 全拒），不可用。这里只比 (packageId, objectName)。
 *
 * 依赖说明（I3）：读写集推导复用 write-plan.ts 的共享件（objectRefsOfUpdate，其内部走
 * scanXmlObjectRefs）；本文件**不**出现第二份 resourceUri / 表名扫描器。
 *
 * 降级口径（§6.2）：解析不出对象级的引用**不参与相交判定**（也不升级为拒绝），但逐条落
 * `ChangesetPlanResult.uncertain`（含第几项与原因）——「不判」与「没有引用」必须可区分。
 */

export type ChangesetActionKind = 'update' | 'create' | 'delete';

/**
 * 批内一个动作。update/delete 按 SSD §6.1 的形状；create 无法只用一份 xml 表达
 * （xml 全量还原通道只对 update 成立），故**扩展**出 create 入参（description/mode/source/scripted），
 * 直接复用 hana_view_create 的入参名——扩展只加字段，不改变 update/delete 通道的语义。
 */
export interface ChangesetAction {
  action: ChangesetActionKind;
  packageId: string;
  objectName: string;
  /** update 专用（与 hana_view_update 的 xml/operations 同义，二选一） */
  xml?: string;
  operations?: unknown[];
  /** update/delete 的破坏性声明位（P6 语义，原样透传；破坏性判定不在本模块做） */
  migration?: { strategy: string; note?: string };
  /** create 专用 */
  description?: string;
  mode?: 'projection' | 'sql';
  source?: {
    schema: string;
    name: string;
    columns?: Array<{ columnName: string; dataTypeName?: string }>;
    measureMode?: string;
  };
  scripted?: { script: string; columns: unknown[] };
}

/**
 * 冲突对：`a`/`b` 为两个冲突动作在**调用方 original 顺序**下的下标（恒有 a < b，先出现的为 a），
 * 报告要能指回「调用方的第几项」；`object` 是被两个动作以冲突方式同时触碰的那个对象。
 * write_read 时写/读各是哪一侧，对照 `ChangesetPlanResult.refs` 即可分辨。
 */
export interface ChangesetConflict {
  kind: 'write_read' | 'write_write';
  a: number;
  b: number;
  object: ObjectRef;
}

export interface ChangesetPlanResult {
  /**
   * 按 (packageId, objectName) 字典序**稳定排序**后的执行序（SSD §6.1 的防 ABBA 死锁协议：
   * 批内动作统一按同一全局序取锁，任意两批不会形成顺序相反的加锁环）；
   * 元素带回 originalIndex，报告按 originalIndex 说话、执行按本数组的顺序。
   */
  order: Array<{ action: ChangesetAction; originalIndex: number }>;
  conflicts: ChangesetConflict[];
  /** 每个动作的对象级读写集，**按原始顺序**排列（refs[k].originalIndex === k），诊断/回执用 */
  refs: Array<{ originalIndex: number; reads: ObjectRef[]; writes: ObjectRef[] }>;
  /**
   * §6.2 降级口径的**出口**：解析不出对象级的引用（join 源只给半个坐标、create 的 scripted 脚本内容、
   * xml 里非「包路径…/视图目录段/对象名」形态的 resourceUri）**不参与相交判定**，但必须如实上报——
   * 此前这类引用被静默丢弃，「不判」与「没有引用」在回执里无从区分。
   * 逐条中文说明、含第几项（originalIndex，从 0 数）与解析不出的原因；
   * 全部解析成功时为空数组（不制造噪音）。按 originalIndex 升序排列。
   * 合并进调用方各自的 uncertain 通道（服务层/规划器）由消费侧按需做——本模块只保证有出口。
   */
  uncertain: string[];
}

/**
 * 动作数上限（SSD §6.1 D3：与 operations 上限对齐）。超限抛 Error——服务层负责转成业务错误。
 * 纯校验只做在这一处（单一实现）：服务层与回执都从这一次判定取材，避免两处各判一次而漂移。
 */
export const CHANGESET_MAX_ACTIONS = 10;

/**
 * 规划一次变更集：推导每个动作的对象级读写集 → 成对相交检测 → 产出稳定排序的执行序。
 *
 * 校验口径（本模块只做这两条纯校验，其余形状归工具 schema 与服务层）：
 * - 动作数 > CHANGESET_MAX_ACTIONS ⇒ 抛 Error；
 * - 未知 action ⇒ 抛 Error（点名第几项与非法值）。
 */
export function planChangeset(actions: ChangesetAction[]): ChangesetPlanResult {
  if (actions.length > CHANGESET_MAX_ACTIONS) {
    throw new Error(
      `变更集动作数超上限：${actions.length} 项 > ${CHANGESET_MAX_ACTIONS}（SSD §6.1 D3，与 operations 上限对齐），请拆成多批`,
    );
  }
  const planned: PlannedAction[] = actions.map((action, originalIndex) => {
    // 运行期护栏：动作来自 JSON，类型层保证不了 action 的取值
    if (!isActionKind(action.action)) {
      throw new Error(
        `变更集第 ${originalIndex} 项（从 0 数）的 action 非法：${JSON.stringify(action.action)}（合法值：update / create / delete）`,
      );
    }
    const refs = refsOfAction(action);
    return {
      action,
      originalIndex,
      reads: refs.reads,
      writes: refs.writes,
      // 逐条补「第几项」坐标：推导件只说明原因，谁持有原始下标谁负责带上（报告一律按 originalIndex 说话）
      uncertain: refs.uncertain.map(
        (u) =>
          `变更集第 ${originalIndex} 项（从 0 数，${action.action} ${action.packageId}/${action.objectName}）：${u}`,
      ),
    };
  });

  return {
    // 排序在副本上做，不动调用方数组；同键按 originalIndex 稳定（显式回落，不依赖引擎）
    order: planned.map(({ action, originalIndex }) => ({ action, originalIndex })).sort(compareExecutionOrder),
    conflicts: detectConflicts(planned),
    refs: planned.map(({ originalIndex, reads, writes }) => ({ originalIndex, reads, writes })),
    // 按原始顺序展开（planned 即原始序），条目自带「第 N 项」前缀
    uncertain: planned.flatMap((p) => p.uncertain),
  };
}

/** 内部中间形状：一次推导，order / conflicts / refs / uncertain 四处消费 */
interface PlannedAction {
  action: ChangesetAction;
  originalIndex: number;
  reads: ObjectRef[];
  writes: ObjectRef[];
  uncertain: string[];
}

/** 合法的动作种类 */
function isActionKind(value: unknown): value is ChangesetActionKind {
  return value === 'update' || value === 'create' || value === 'delete';
}

/**
 * 单个动作的对象级读写集推导。update 走共享件；create/delete 的形状固定在各自分支里（含为什么）。
 * 第三项 `uncertain` 是 §6.2 的降级出口：推导中**解析不出对象级**的引用逐条落在这里（原因文案），
 * 由 planChangeset 补上「第几项」前缀后随结果返回——不猜，但也不静默。
 */
function refsOfAction(action: ChangesetAction): { reads: ObjectRef[]; writes: ObjectRef[]; uncertain: string[] } {
  const target: ObjectRef = { packageId: action.packageId, objectName: action.objectName };
  switch (action.action) {
    case 'update': {
      const derived = objectRefsOfUpdate({
        packageId: action.packageId,
        objectName: action.objectName,
        xml: action.xml,
        operations: action.operations,
      });
      // 目标对象恒被写入（update 改的就是它本身）：即便共享件漏报也必须进写集——写集漏一个对象
      // 就等于相交检测漏一次拒绝。
      return {
        reads: dedupeRefs(derived.reads),
        writes: dedupeRefs([target, ...derived.writes]),
        uncertain: derived.uncertain,
      };
    }
    case 'create': {
      // source 是 schema 下的物理表/视图，不是仓库对象 ⇒ 不进对象级读集（SSD §6.2 的粒度到此为止）；
      // scripted.script 不解析：SQL 里的仓库对象引用需要再写一份扫描器（I3 禁止），宁漏不猜——
      // 但**不静默**：脚本里可能藏着仓库对象引用，如实落 uncertain（§6.2 降级口径把"不判"与"没有"区分开）。
      const script = typeof action.scripted?.script === 'string' ? action.scripted.script.trim() : '';
      const uncertain: string[] =
        script === ''
          ? []
          : [
              'create 的 scripted 脚本内容不解析（不写第二份 SQL/仓库对象扫描器，宁漏不猜）：' +
                '脚本中可能引用的仓库对象不进对象级读集，也不参与批内相交检测',
            ];
      return { reads: [], writes: [target], uncertain };
    }
    case 'delete':
      // 补偿阶段要先读原文，但那是执行机制不是依赖声明：目标对象已进写集，读方与它的相交
      // 由「写∩读」覆盖，delete 不必再把自己声明成读方。
      return { reads: [], writes: [target], uncertain: [] };
  }
}

/**
 * 成对相交检测（SSD §6.2）：遍历所有 i<j 动作对，按对象求交——写∩写 与 写∩读（双向）。
 * 不短路、不只报第一对：报告要能一次看清整批的全部冲突项对。
 * 只做**跨动作**判定：同一动作内「自己读自己写」（如 add_join 源指向自身）不影响批的一致性，
 * 由单对象更新路径自身保证。
 */
function detectConflicts(planned: PlannedAction[]): ChangesetConflict[] {
  const conflicts: ChangesetConflict[] = [];
  for (let i = 0; i < planned.length; i++) {
    for (let j = i + 1; j < planned.length; j++) {
      const left = planned[i];
      const right = planned[j];
      // 写∩写：同一对象被两项写——后写覆盖先写，无论执行序如何都不成立
      for (const object of intersectRefs(left.writes, right.writes)) {
        conflicts.push({ kind: 'write_write', a: left.originalIndex, b: right.originalIndex, object });
      }
      // 写∩读（双向）：一项写、另一项读同一对象 ⇒ 读方可能读到覆盖前/后的版本，执行序无法两全。
      // 两个方向合并去重：同一对动作里同一对象两个方向都命中时只报一条。
      const writeRead: ObjectRef[] = [];
      for (const object of [...intersectRefs(left.writes, right.reads), ...intersectRefs(left.reads, right.writes)]) {
        if (!writeRead.some((r) => sameObjectRef(r, object))) writeRead.push(object);
      }
      for (const object of writeRead) {
        conflicts.push({ kind: 'write_read', a: left.originalIndex, b: right.originalIndex, object });
      }
    }
  }
  return conflicts;
}

/** 集合交：按 left 的次序返回同时出现在 right 里的对象（判等/去重一律走共享的 sameObjectRef——对象级判等只此一个口径） */
function intersectRefs(left: ObjectRef[], right: ObjectRef[]): ObjectRef[] {
  const out: ObjectRef[] = [];
  for (const ref of left) {
    if (right.some((r) => sameObjectRef(r, ref)) && !out.some((r) => sameObjectRef(r, ref))) out.push(ref);
  }
  return out;
}

/** 读写集去重（保持首次出现顺序）：重复对象没有信息量，还会在相交检测里放大成重复冲突对 */
function dedupeRefs(refs: ObjectRef[]): ObjectRef[] {
  const out: ObjectRef[] = [];
  for (const ref of refs) if (!out.some((r) => sameObjectRef(r, ref))) out.push(ref);
  return out;
}

/**
 * 执行序比较：先包、再对象名，均按**码点序**（JS 字符串 < 比较即 UTF-16 code unit 序；仓库标识符都在
 * BMP 内，与码点序一致）。刻意不用 localeCompare：ICU 版本/运行环境会让顺序漂移，而批执行序必须
 * 在任何环境下同一份输入给同一份顺序。相同键按 originalIndex 稳定（显式回落，不依赖引擎排序的稳定性）。
 */
function compareExecutionOrder(
  left: { action: ChangesetAction; originalIndex: number },
  right: { action: ChangesetAction; originalIndex: number },
): number {
  return (
    compareCodePoints(left.action.packageId, right.action.packageId) ||
    compareCodePoints(left.action.objectName, right.action.objectName) ||
    left.originalIndex - right.originalIndex
  );
}

/** 码点序比较（-1 / 0 / 1） */
function compareCodePoints(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}
