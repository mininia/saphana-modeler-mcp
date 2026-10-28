/**
 * 操作级能力条目（`<工具>#<op>`）——从父工具 schema 与 VIEW_OPS 派生，零手写副本。
 *
 * - 参数面：身份字段取父 schema 同名字段，载荷字段取 operations 判别式 union 对应成员（去掉 op）；
 * - effect 面：destructive 来自 services/view-ops.rules.ts（op 的唯一事实源）；
 * - 计划面：planViewOpAlias 把入参还原成父工具的一次 operations 调用，交给父规划器。
 *
 * 条目标 routeOnly: true：可授权、可出现在门面索引，但永不注册为工具——调用方式：
 *   hana_modeling({ capability: "hana_view_update#add_join", args: { packageId, objectName, … } })
 * 与 hana_view_update({ …, operations: [{ op: "add_join", … }] }) 完全等价（同一 handler、同一闸门）。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { VIEW_UPDATE_IDENTITY_FIELDS, planViewOpAlias } from '../planners.js';
import { VIEW_OPS } from '../../services/view-ops.rules.js';

/** 从 `operations` 的判别式 union 抽出「op 值 → 该成员的字段形状（去判别式）」 */
function operationsMemberShapes(parent: Capability): Map<string, Record<string, z.ZodTypeAny>> {
  const shape = (parent.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  const opsParam = shape?.['operations'] as
    { def?: { innerType?: { def?: { element?: { options?: unknown[] } } } } } | undefined;
  const options = opsParam?.def?.innerType?.def?.element?.options;
  if (!Array.isArray(options) || options.length === 0) {
    throw new Error(`${parent.id}: 读不到 operations 判别式 union（schema 结构变了）——操作级条目的派生逻辑需要同步`);
  }
  const out = new Map<string, Record<string, z.ZodTypeAny>>();
  for (const option of options) {
    const memberShape = (option as { shape?: Record<string, z.ZodTypeAny> }).shape;
    const opValue = (memberShape?.['op'] as { value?: unknown } | undefined)?.value;
    if (!memberShape || typeof opValue !== 'string') {
      throw new Error(`${parent.id}: operations union 的某个成员缺对象形状或缺字符串判别式 op`);
    }
    const { op: _op, ...payload } = memberShape;
    out.set(opValue, payload);
  }
  return out;
}

/**
 * 派生一个父工具的全部操作级条目（键 = `<父 id>#<op>`）。
 *
 * @throws 声明与 schema 两侧漂移时（VIEW_OPS 有而 union 没有、或身份字段缺失）——构建期即失败
 */
export function buildViewOpCapabilities(parent: Capability): Record<string, Capability<z.ZodType>> {
  const parentShape = (parent.inputSchema as unknown as { shape?: Record<string, z.ZodTypeAny> }).shape;
  if (!parentShape) throw new Error(`${parent.id}: inputSchema 不是对象形状，无法派生操作级条目`);
  const identity: Record<string, z.ZodTypeAny> = {};
  for (const key of VIEW_UPDATE_IDENTITY_FIELDS) {
    const field = parentShape[key];
    if (field === undefined) throw new Error(`${parent.id}: 身份字段 ${key} 不在父 schema 里——操作级条目派生需要它`);
    identity[key] = field;
  }
  const shapes = operationsMemberShapes(parent);

  const out: Record<string, Capability<z.ZodType>> = {};
  for (const decl of VIEW_OPS) {
    const payload = shapes.get(decl.id);
    if (!payload) {
      throw new Error(
        `VIEW_OPS 声明了 op=${decl.id}，但 ${parent.id} 的 operations union 里没有它（声明与 schema 漂移）`,
      );
    }
    const id = `${parent.id}#${decl.id}`;
    out[id] = cap({
      id,
      module: parent.id,
      routeOnly: true,
      category: parent.category,
      kind: parent.kind,
      effects: {
        // 计划经父工具的规划器（同一套读写集判定；不另写一份）
        plan: (args) => planViewOpAlias(decl.id, args),
        destructive: decl.effects.destructive,
        idempotent: parent.effects.idempotent,
      },
      title: decl.title,
      description:
        `op=${decl.id}：${decl.summary}。${decl.detail ?? ''}\n` +
        (decl.effects.destructive
          ? '此项为破坏性变更、不可自动回滚：改前用 hana_metadata_get_view(format=xml) 留档，恢复=用该 XML 重新 update。\n'
          : '') +
        `经门面路由调用（本条目不注册为工具）：args = 父工具身份参数（packageId / objectName 必填；` +
        `ifMatch / dryRun / migration 可选）+ 本 op 参数。与 ` +
        `${parent.id}({ operations: [{ op: "${decl.id}", … }] }) 完全等价（同一 handler、同一闸门与破坏性判定）。`,
      // 身份字段复用父 schema 的同名字段（保留其 .default()/.optional() 语义）；载荷字段来自 union 成员
      inputSchema: z.object({ ...identity, ...payload }),
      // 注解从本条的 effects 派生（set_description 这类非破坏 op 的 destructiveHint 必须为 false）。
      annotations: {
        readOnlyHint: parent.kind === 'read',
        idempotentHint: parent.effects.idempotent,
        destructiveHint: decl.effects.destructive,
        openWorldHint: false,
      },
    });
  }
  return out;
}
