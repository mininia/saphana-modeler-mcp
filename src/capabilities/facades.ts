/**
 * 分类门面（facade）—— 动态调用面的**唯一入口层**（2026-10-09 定稿）。
 *
 * ## 它替代了什么
 *
 * P10-d 曾有两条元入口：`hana_capability_search`（发现 + 提升进面）与 `hana_invoke`（按 id 路由）。
 * 那套的代价是**发现要多付一次调用**：模型得先想到"我该去搜"，而第一次搜还得先问"有哪几类"——
 * 分类目录本身要靠一次不产生任何工作的调用来交换。分类门面把这层变成白送的：**分类直接长在
 * `tools/list` 上**，模型读一遍工具列表就知道方向。
 *
 * ## 三层分工（改代码前先读）
 *
 * | 层 | 内容 | 到模型的方式 |
 * |---|---|---|
 * | 门面（本文件） | `hana_<分类>`，描述只给**方向** | 常驻 tools/list，零调用 |
 * | 索引 | 该类的具体能力（id / 一句话摘要 / 参数名），从清单**派生** | 调门面（不带参数） |
 * | 调用 | 具体能力，只回 I/O | 调门面（带 capability + args） |
 *
 * **关键约束：门面的描述只放方向，不放索引。** 索引若写进描述，就是把第二层的内容塞进第一层——
 * 描述每次会话常驻，而索引只在"挑具体工具"那一刻需要。方向句从 `CAPABILITY_CATALOG` 生成，
 * 不手写（手写 = 第二份事实源，新增能力时必漂移）。
 *
 * ## kind 与可见性（两个正交的决定，别混）
 *
 * - `kind` 取成员里**最严**的一档（read < write < admin），只用于日志与组名展开（`toolsOfGroup`）。
 * - 门面**自己**是否可注册不看这个 kind：**门面层不做限制**（2026-10-09 定稿）——权限只有一层
 *   （能力层），六个入口常驻，谁的能力可用由分组开关按**目标能力**的 kind 判（见 `tools/groups.ts`
 *   的 `shouldRegisterTool`）。所以只读部署照样看得到 `hana_modeling`/`hana_diagnostics`，
 *   只是它们的索引为空——入口在、里面没有你可用的能力。
 *
 * ## 依赖方向
 *
 * 本模块只 import `types.ts` 与 `planners.ts`（叶子），不 import `defs/*`——
 * 门面是**从清单派生**的，不是清单的第四个事实源。装配点在 `manifest.ts`。
 */
import { z } from 'zod';
import { planFacade } from './planners.js';
import { CAPABILITY_CATALOG, FACADE_CATEGORIES, type Capability, type FacadeCategory, type ToolKind } from './types.js';
/** 门面 id：`hana_<分类名>`——id 即分类，模型读工具名就知道该往哪走 */
export function facadeIdOf(category: FacadeCategory): FacadeId {
  return `hana_${category}`;
}
/** 门面 id 的联合类型 */
export type FacadeId = `hana_${FacadeCategory}`;
/** 全部门面 id（顺序 = `FACADE_CATEGORIES`，即注册顺序） */
export const FACADE_IDS = FACADE_CATEGORIES.map(facadeIdOf) as readonly FacadeId[];
/**
 * 是否门面 id。用**正向清单**判定，不用前缀猜：
 * `hana_system_get_info` 也以 `hana_system` 开头，前缀写法会把它误判成门面。
 */
export function isFacadeId(id: string): id is FacadeId {
  return (FACADE_IDS as readonly string[]).includes(id);
}
/**
 * 门面入参（6 个门面共用同一 schema）。
 *
 * 扇出到哪一类由"是哪个门面"决定，**不在入参里重复表达**——`hana_modeling` 天然只能路由到
 * modeling 类的能力，因此不需要一个 `category` 字段（多一个字段就多一个可与门面自身矛盾的输入）。
 * `args` 声明为自由对象：目标能力的 schema 由服务端校验，客户端 schema 只是便利（与既有路由同口径）。
 */
export const FACADE_SCHEMA = z.object({
  capability: z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe('要调用的能力 id（见本类索引）。省略 = 只取本类能力索引，不做调用'),
  args: z
    .record(z.string(), z.unknown())
    .default({})
    .describe('目标能力的入参对象（按目标能力的 schema 校验；省略 = 空对象）'),
});
/** 门面入参（handler 的参数类型） */
export type FacadeArgs = z.infer<typeof FACADE_SCHEMA>;
/** 六个门面（键 = 门面 id，字面量联合） */
export type FacadeCapabilities = { [K in FacadeCategory as `hana_${K}`]: Capability<typeof FACADE_SCHEMA> };
/** 档位严格度（read < write < admin）：门面的 kind 取成员里最大的那个 */
const KIND_SEVERITY: Record<ToolKind, number> = { read: 0, write: 1, admin: 2 };
function strictestKind(members: readonly Capability[]): ToolKind {
  return members.reduce<ToolKind>((acc, c) => (KIND_SEVERITY[c.kind] > KIND_SEVERITY[acc] ? c.kind : acc), 'read');
}
/**
 * 门面描述：**方向句 + 成员清单（id：标题）**。
 *
 * 为什么是"清单"而不是一句概括：描述常驻 `tools/list`，是模型的**唯一入口**——
 * 写成"建模与仓库变更：创建/修改/校验/激活/删除设计时对象"这种抽象概括时，模型看不出里面
 * 到底有 `hana_view_update` 还是 `hana_repo_import`，只能先调一次索引才知道，那就把"零发现调用"
 * 又还回去了（这是 2026-10-09 实测暴露的问题：描述"太模糊，根本不知道里面有什么能力"）。
 *
 * 为什么**只**给 id + 标题：参数名与每项的一句话摘要属于"已经选中它之后"才需要的信息，
 * 由**调门面不带参数**的索引回执给（见 tools/capability.tools.ts）。描述里塞进参数名，
 * 就是把第二层的内容搬进第一层——那份文本每次会话都注入，而索引只在挑选那一刻需要。
 *
 * 两处都从清单生成，所以"描述里有的"与"索引里给的"不可能漂移。
 */
function facadeDescription(entry: (typeof CAPABILITY_CATALOG)[number], members: readonly Capability[]): string {
  // 描述是**常驻文本**（每次会话都注入）：只列主干能力；routeOnly 的操作级别名（`<工具>#<op>`）
  // 只报数量、不逐条列——它们只在"已经选中某工具之后"才需要，由**调门面取索引**给出（索引含两者）。
  // 两处都从清单派生，所以"描述里有的"与"索引里给的"不可能漂移。
  const primary = members.filter((m) => m.routeOnly !== true);
  const aliases = members.filter((m) => m.routeOnly === true);
  return [
    `${entry.name}：${entry.description}。`,
    `本类共 ${primary.length} 项能力：`,
    // 按声明顺序（= 生命周期顺序，如 create → validate → activate → update → delete），非字典序
    ...primary.map((m) => `- ${m.id}：${m.title}`),
    ...(aliases.length > 0
      ? [
          `另有 ${aliases.length} 项**操作级别名**（\`<工具>#<操作>\`，如 \`hana_view_update#add_join\`）：` +
            `不常驻、不注册为工具，只经本门面路由调用——调本门面取索引可看全量（含别名）。`,
        ]
      : []),
    `调用：\`{ capability: "<上表 id>", args: { … } }\`；不带参数只返回索引。` +
      `调本工具会把本类能力**提升进工具面**——此后它们出现在 tools/list 里，带完整参数 schema、可按工具名平铺调用。`,
    `授权与参数校验都按**目标能力**判定；不在你权限内的能力不会出现在索引里。`,
  ].join('\n');
}

/**
 * 从**基础能力清单**派生六个门面条目。
 *
 * 派生而非手写声明：门面的 title / description / kind / effects 全部是成员的函数，
 * 手写就等于把"这一类里有什么"又说了一遍——P9 的 I3（一条规则一份实现）不允许。
 *
 * @param base 基础能力（不含门面自身；由 `manifest.ts` 装配后传入）
 */
export function buildFacades(base: readonly Capability[]): FacadeCapabilities {
  const out: Record<string, Capability<typeof FACADE_SCHEMA>> = {};
  for (const category of FACADE_CATEGORIES) {
    const id = facadeIdOf(category);
    const members = base.filter((c) => c.category === category);
    if (members.length === 0) {
      // 空门面 = 一个指向虚空的入口，模型调它只会拿到空索引。宁可启动失败（与清单的 fail-closed 同向）
      throw new Error(`分类 "${category}" 下没有任何已登记能力：门面 ${id} 会是一个空入口`);
    }
    const entry = CAPABILITY_CATALOG.find((c) => c.id === category);
    if (!entry) {
      throw new Error(`分类 "${category}" 不在 CAPABILITY_CATALOG 里：门面的标题与方向句无从生成`);
    }
    const kind = strictestKind(members);
    // 成员的函数，不是手写常量：门面能路由到什么，就声明成什么
    const destructive = members.some((c) => c.effects.destructive);
    const idempotent = members.every((c) => c.effects.idempotent);
    out[id] = {
      id,
      module: id,
      category,
      kind,
      facadeOf: category,
      effects: { plan: planFacade(id), destructive, idempotent },
      title: entry.name,
      description: facadeDescription(entry, members),
      inputSchema: FACADE_SCHEMA,
      annotations: {
        // 与 kind / effects 一致（测试会断言三个字段不许互相矛盾）
        readOnlyHint: kind === 'read',
        idempotentHint: idempotent,
        destructiveHint: destructive,
        openWorldHint: false,
      },
    };
  }
  return out as FacadeCapabilities;
}
