/**
 * 环境维度判定（多环境）。
 *
 * 判据唯一：清单的 `effects.mutates`，不按 kind/组名推断。
 * - 只读闸门：ACCESS=readonly 只拦 persistent；transient/none 放行。
 *   hana_sql_execute 在 select-only 下交给 SQL 规则层，deny 下整体拒绝。
 * - expectedEnvironment：多环境下所有 mutates != none 的调用必须自报当前环境标识
 *   （防环境漂移，不是授权凭证；大小写不敏感）。
 *
 * 本模块只产出 Grant（与 profile/资源维度同一条判定链），不改写任何配置。
 */

import { z } from 'zod';
import type { Capability, MutationScope } from '../capabilities/types.js';
import { BLOCKED_PREFIX } from '../core/errors.js';
import type { Grant } from './preflight.js';
import type { EnvironmentRuntime } from './environment-runtime.js';

/** 环境副作用口径：门面/control 不碰 HANA 记 none，其余取 effects.mutates */
export function environmentMutationScope(capability: Capability): MutationScope {
  if (capability.facadeOf !== undefined || capability.control === true) return 'none';
  return capability.effects.mutates;
}

function block(subject: string, code: string, message: string): Grant {
  return { dimension: 'environment', subject, code, severity: 'block', message: `${BLOCKED_PREFIX}：${message}` };
}

/**
 * 环境维度结论（并入 authorizeCall 的 extraGrants）。
 * runtime 未绑定（测试/脚本直调）时返回空数组；**单环境也执行只读闸门**（HANA_ACCESS=readonly
 * 必须真正生效），但不要求 expectedEnvironment。
 */
export function environmentGrants(
  capability: Capability,
  args: Record<string, unknown>,
  runtime: EnvironmentRuntime | undefined,
): Grant[] {
  if (!runtime) return [];
  const scope = environmentMutationScope(capability);
  if (scope === 'none') return [];

  const grants: Grant[] = [];
  if (runtime.multiEnv) {
    const expected = typeof args['expectedEnvironment'] === 'string' ? args['expectedEnvironment'] : undefined;
    if (expected === undefined || expected.trim() === '') {
      grants.push(
        block(
          capability.id,
          'env_assertion_missing',
          `多环境非纯读调用必须显式携带 expectedEnvironment（当前环境标识=${runtime.envKey}），本次未执行`,
        ),
      );
    } else if (expected.trim().toUpperCase() !== runtime.envKey) {
      grants.push(
        block(
          capability.id,
          'env_assertion_mismatch',
          `expectedEnvironment=${expected} 与当前环境标识=${runtime.envKey} 不一致，本次未执行；` +
            '请确认是否忘了切回（先 hana_env_list 查看当前环境）',
        ),
      );
    }
  }

  if (runtime.access === 'readonly' && scope === 'persistent') {
    const sqlPolicy = runtime.config.readonlySql ?? 'select-only';
    if (capability.id === 'hana_sql_execute' && sqlPolicy === 'select-only') {
      // 交给 SQL 规则层逐条判定；这里只保证 expectedEnvironment 已通过。
    } else {
      grants.push(
        block(
          capability.id,
          'env_readonly',
          `当前环境 ${runtime.envKey} 为只读（ACCESS=readonly），持久写入能力不可用；` +
            '临时对象与纯读不受影响，本次未执行',
        ),
      );
    }
  }
  return grants;
}

/** 多环境下给非纯读能力（mutates != none，含临时对象）加必填 expectedEnvironment；单环境/纯读原样返回 */
export function capabilityInputSchema(capability: Capability, multiEnv: boolean): z.ZodType {
  if (!multiEnv || environmentMutationScope(capability) === 'none') return capability.inputSchema;
  const schema = capability.inputSchema;
  if (schema instanceof z.ZodObject) {
    return schema.extend({
      expectedEnvironment: z
        .string()
        .min(1)
        .max(32)
        .describe('当前环境标识，必须与 hana_env_list 返回的 current 一致（大小写不敏感；多环境非纯读调用必填）'),
    });
  }
  return schema;
}
