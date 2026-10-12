/**
 * 资源形参声明：让"哪个入参是**资源**"由**参数自己**声明，而不是靠规划器逐个手抠。
 *
 * ## 为什么
 *
 * 若由规划器自己从 args 里按名字取资源（`asStr(args.schema)`、`asStr(args.packageId)`…），
 * 每加一个"读某 schema"的能力，作者都必须记得写一个规划器、且名字必须恰好命中——
 * 漏了不会有任何提示，只是该能力的读范围判定**静默失效**。声明式下：
 * **资源维度随参数走**，新增能力只要用对构造器，判定自动成立（漏声明由测试拦）。
 *
 * ## 为什么不用 zod 的 `.meta()`
 *
 * zod 4 的 `.meta()` 会把自定义键**写进 `z.toJSONSchema()` 的输出**（实测 `{"resource":"readSchema"}`
 * 出现在发布给客户端的 JSON Schema 里）。那有两个问题：
 * ① 发布面被改了——客户端/严格 JSON Schema 校验器会看到并可能拒绝未知关键字；
 * ② 它是"协议可见"的，而资源角色是**服务端策略**信息，没必要外泄（顺序/归属本身也是线索）。
 * 故改用模块内 `WeakMap`：声明仍然**长在参数对象上**（改参数名不会漂移），但对外零痕迹。
 *
 * ## 约定（重要）
 *
 * 只给**角色无条件**的参数打标。混合模式的参数留给规划器显式声明——
 * 典型反例：`hana_view_validate.packageId` 在 `target=design` 时是写目标（写 `_CHKTMP`），
 * 在 `target=runtime` 时完全不写。给它打 `writePackage` 会让"运行时校验"凭空要求写权限。
 */

import type { z } from 'zod';
import type { WritePlan } from '../write-plan.js';

/** 资源角色：写目标包 / 只读引用包 / 只读 schema */
export type ResourceRole = 'writePackage' | 'readPackage' | 'readSchema';

/**
 * 角色表：**按参数对象**记录（WeakMap → 键随对象被 GC，不构成全局表；同名不同工具的参数互不影响）。
 * 用 WeakMap 而不是 Map 的另一个好处：模块级状态不会泄漏到测试之间（新 schema 对象天然是"干净"的）。
 */
const ROLES = new WeakMap<object, ResourceRole>();

/**
 * 给一个 schema 实例打上资源角色（返回同一对象）。
 *
 * ⚠️ **必须包在链的最外层**：zod 的 `.optional()`/`.describe()`/`.min()` 都返回**新对象**，
 * 标签随旧对象被丢弃（实测踩过一次：`tagResource(z.string(),'readSchema').describe(...)`
 * 读回来是 undefined）。正确写法：`tagResource(z.string().optional().describe('…'), 'readSchema')`。
 */
export function tagResource<T extends z.ZodType>(schema: T, role: ResourceRole): T {
  ROLES.set(schema, role);
  return schema;
}

/**
 * 读出一个参数（可能是 `optional()`/`default()` 包裹过的）的资源角色。
 * 包装器不继承内层的 WeakMap 键，故需向内解包——最多解 4 层（本仓库最深是 `optional(default(x))`）。
 */
export function resourceRoleOf(schema: unknown): ResourceRole | undefined {
  let cur = schema as { def?: { innerType?: unknown; element?: unknown } } | undefined;
  for (let i = 0; i < 4 && cur; i++) {
    const role = ROLES.get(cur as object);
    if (role) return role;
    cur = cur.def?.innerType as typeof cur;
  }
  return undefined;
}

/** 从一次调用中派生出的资源（三个数组，与 `WritePlan` 同口径） */
export interface DeclaredResources {
  writePackages: string[];
  readSchemas: string[];
  readPackages: string[];
}

/**
 * 从能力的 `inputSchema` 与本次入参派生出**声明的资源**。
 *
 * 口径：
 * - 只看**顶层**参数（嵌套结构如 `operations[].sourcePackageId` 由规划器处理——那里需要解析数组语义）；
 * - 只认**非空字符串**（`undefined`/空串不算声明）；
 * - 参数名不参与判定（角色长在对象上），故改名不会漂移；
 * - **多对象批次模式例外**（见下）：`changeset` 在场时顶层写包声明不并入。
 */
export function deriveResourcesFromParams(inputSchema: z.ZodType, args: Record<string, unknown>): DeclaredResources {
  const out: DeclaredResources = { writePackages: [], readSchemas: [], readPackages: [] };
  const shape = (inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) return out;
  // 多对象批次模式（hana_view_update 的 changeset，P7）：批次执行**完全不消费**顶层 packageId
  // （applyChangeset 只认 actions，逐动作自带 packageId），它只是单对象通道的目标位。
  // 把顶层 packageId 并进 writePackages 就是**幽灵写声明**：调用方随手填一个别的包（如只读包）
  // 会让完全合法的批次被闸门以 target_outside_boundary **整批拒绝**，计划文本与 capability-audit
  // 的资源里也会列出这个批次从不写入的包。批次写包由 actions 的并集承担（规划器逐动作并进
  // writePackages）——那不是本层的职责，本层只需不制造幽灵声明。
  // 只在 schema 里确有 changeset 参数时才抑制（角色判定仍按参数自己走，其他能力不受影响）；
  // 判定用宽松形状（`typeof === 'object'`）而非具体字段：与 args 可能未经 zod 解析（门面路由路径）同口径。
  const changesetMode = shape.changeset !== undefined && typeof args.changeset === 'object' && args.changeset !== null;
  for (const [name, field] of Object.entries(shape)) {
    const role = resourceRoleOf(field);
    if (!role) continue;
    if (changesetMode && role === 'writePackage') continue;
    const value = args[name];
    if (typeof value !== 'string') continue;
    // **不做 trim**（I3 单一口径：判定值必须等于服务层实际拿到的值）。入参归一在**声明侧**完成——
    // readSchema 类形参的 zod schema 带 `.trim()`（defs/*.ts），经 SDK / 门面路由解析后，闸门、计划、
    // 服务层拿到的是同一个字符串。这里若再 trim，未经 zod 解析的调用（直调 handler 等）就会出现
    // "闸门按 trim 后的值判、服务层按原值判"的双口径——正是评审点名的"闸门放行、服务报不在白名单"。
    // 只跳过"去掉首尾空白后为空"的值：空串/纯空白不算声明（模型偶尔用它表示"不指定"）。
    if (value.trim() === '') continue;
    const target =
      role === 'writePackage' ? out.writePackages : role === 'readPackage' ? out.readPackages : out.readSchemas;
    if (!target.includes(value)) target.push(value);
  }
  return out;
}

/** 该能力是否声明了任何资源形参（用于测试与报告） */
export function declaredResourceRoles(inputSchema: z.ZodType): ResourceRole[] {
  const shape = (inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) return [];
  const roles = Object.values(shape)
    .map((f) => resourceRoleOf(f))
    .filter((r): r is ResourceRole => r !== undefined);
  return [...new Set(roles)];
}

/**
 * 把"参数声明的资源"与"规划器给出的资源"合并（并集 = 更严的方向；同一资源不会重复）。
 *
 * 对象级字段（`reads`/`writes`）**原样透传**（P7 修正）：此前只搬 tool/steps/三个包级数组/uncertain，
 * 规划器声明的对象级读写集在这里被静默丢掉——`planFor(...)` 的结果恒为 `reads/writes === undefined`，
 * 声明形同虚设。参数声明层（deriveResourcesFromParams）只认顶层字符串资源，不产生对象级引用，
 * 所以这里没有"合并"可言，透传即正确。**可选字段语义**：`undefined` 时不产生键——
 * 未声明（静态不可知）与"已声明无"（`[]`）是两回事，不许在此把前者归一成后者。
 */
export function mergeDeclaredIntoPlan(tool: string, declared: DeclaredResources, base: WritePlan): WritePlan {
  const union = (a: readonly string[], b: readonly string[]) => [...a, ...b.filter((x) => !a.includes(x))];
  const derivedOnly = {
    writePackages: declared.writePackages.filter((x) => !base.writePackages.includes(x)),
    readSchemas: declared.readSchemas.filter((x) => !base.readSchemas.includes(x)),
    readPackages: declared.readPackages.filter((x) => !base.readPackages.includes(x)),
  };
  const hasDerived =
    derivedOnly.writePackages.length + derivedOnly.readSchemas.length + derivedOnly.readPackages.length > 0;
  return {
    tool,
    steps: hasDerived
      ? [
          ...base.steps,
          `资源形参声明：写包 ${derivedOnly.writePackages.join(', ') || '(无)'}；` +
            `读 schema ${derivedOnly.readSchemas.join(', ') || '(无)'}；` +
            `只读引用 ${derivedOnly.readPackages.join(', ') || '(无)'}`,
        ]
      : base.steps,
    writePackages: union(base.writePackages, declared.writePackages),
    readSchemas: union(base.readSchemas, declared.readSchemas),
    readPackages: union(base.readPackages, declared.readPackages),
    ...(base.reads !== undefined ? { reads: base.reads } : {}),
    ...(base.writes !== undefined ? { writes: base.writes } : {}),
    uncertain: base.uncertain,
  };
}
