/**
 * 分类门面（facade）——动态调用面的唯一入口层。
 *
 * 为什么不做搜索式元入口：搜索要多付一次发现调用；分类直接长在 tools/list 上，读一遍就知道方向。
 *
 * 三层分工：
 * | 层 | 内容 | 到模型的方式 |
 * |---|---|---|
 * | 门面 | `hana_<分类>`：方向句 + 主干成员 `id：标题`（按可触达上限过滤） | 常驻 tools/list |
 * | 索引 | 具体能力（id / 摘要 / 参数名），从清单派生 | 调门面（不带参数） |
 * | 调用 | 具体能力，只回 I/O | 调门面（带 capability + args） |
 *
 * 关键约束：描述只列主干成员（routeOnly 别名只报数量）；索引不进描述（描述常驻，索引只在挑选时需要）。
 * 门面自己是否可注册不看 kind：门面层不做限制，六个入口常驻，能力可用性由能力层 kind 决定。
 * 本模块只 import types.ts 与 planners.ts，不 import defs/*——门面从清单派生，装配点在 manifest.ts。
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
 * 门面入参（6 个门面共用同一 schema）。
 * 扇出到哪一类由「是哪个门面」决定，不在入参里重复表达；args 由服务端按目标能力校验。
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
/** 六个门面（键 = 门面 id，字面量联合） */
export type FacadeCapabilities = { [K in FacadeCategory as `hana_${K}`]: Capability<typeof FACADE_SCHEMA> };
/** 档位严格度（read < write < admin）：门面的 kind 取成员里最大的那个 */
const KIND_SEVERITY: Record<ToolKind, number> = { read: 0, write: 1, admin: 2 };
function strictestKind(members: readonly Capability[]): ToolKind {
  return members.reduce<ToolKind>((acc, c) => (KIND_SEVERITY[c.kind] > KIND_SEVERITY[acc] ? c.kind : acc), 'read');
}
/**
 * 门面描述（唯一生成器，两个调用点）：
 * - buildFacades 以「全可见」调用 → 清单常量保存全集版本；
 * - tools/index.ts 注册时以本次连接的可触达上限为谓词重建 → 文本随 deny/分组/档案收窄。
 *
 * 描述常驻 tools/list，是模型的唯一入口：必须点名主干成员（`id：标题`），否则模型只能先调索引；
 * 但只给 id + 标题——参数名与摘要属于「选中之后」的信息，由调门面取索引给出。
 * 描述、索引、路由是同一判定的三个视图，谁也不许更宽。
 */
export function facadeDescription(
  category: FacadeCategory,
  members: readonly Capability[],
  isVisible: (member: Capability) => boolean,
): string {
  const entry = CAPABILITY_CATALOG.find((c) => c.id === category);
  if (!entry) {
    throw new Error(`分类 "${category}" 不在 CAPABILITY_CATALOG 里：门面的方向句无从生成`);
  }
  // 描述常驻：只列主干能力；routeOnly 别名只报数量，全量由调门面取索引给出。
  const primary = members.filter((m) => m.routeOnly !== true && isVisible(m));
  const aliases = members.filter((m) => m.routeOnly === true && isVisible(m));
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
    `调用：\`{ capability: "<上表 id>", args: { … } }\`；不带参数只返回索引。调本门面会把本类能力提升进工具面（此后可按工具名平铺调用）。`,
    `授权与参数校验按目标能力判定；不在你权限内的能力不会出现在索引里。`,
  ].join('\n');
}

/**
 * 从基础能力清单派生六个门面条目。title / description / kind / effects 全是成员的函数，不手写。
 *
 * @param base 基础能力（不含门面自身；由 manifest.ts 装配后传入）
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
      // 常量描述保存**全集**（全可见）；投给客户端的文本由 tools/index.ts 在注册时按连接重建
      description: facadeDescription(category, members, () => true),
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
