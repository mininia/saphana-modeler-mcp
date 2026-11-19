/**
 * 环境维度判定（多环境）。
 *
 * 判据唯一：清单的 `effects.mutates`，不按 kind/组名推断。
 * - 只读闸门：ACCESS=readonly 只拦 persistent；transient/none 放行。
 *   hana_sql_execute 在 select-only 下交给 SQL 规则层，deny 下整体拒绝。
 * - expectedEnvironment：多环境下**所有**调用都必须自报当前环境标识与代际
 *   （防环境漂移，不是授权凭证；大小写不敏感）。
 *
 * 本模块只产出 Grant（与 profile/资源维度同一条判定链），不改写任何配置。
 */

import { z } from 'zod';
import type { Capability, MutationScope } from '../capabilities/types.js';
import { BLOCKED_PREFIX } from '../core/errors.js';
import type { Grant } from './preflight.js';
import type { EnvironmentRuntime } from './environment-runtime.js';

/** 环境副作用口径：平台入口/control 不碰 HANA 记 none，其余取 effects.mutates */
export function environmentMutationScope(capability: Capability): MutationScope {
  if (capability.platform === true || capability.control === true) return 'none';
  return capability.effects.mutates;
}

function block(subject: string, code: string, message: string): Grant {
  return { dimension: 'environment', subject, code, severity: 'block', message: `${BLOCKED_PREFIX}：${message}` };
}

/**
 * 环境维度结论（并入 authorizeCall 的 extraGrants）。
 * runtime 未绑定（测试/脚本直调）时返回空数组；**单环境也执行只读闸门**（空写包推导的 readonly
 * 必须真正生效），但不要求 expectedEnvironment。
 */
export interface EnvironmentAssertion {
  key?: string;
  epoch?: number;
}

export function environmentGrants(
  capability: Capability,
  args: Record<string, unknown>,
  runtime: EnvironmentRuntime | undefined,
  assertion?: EnvironmentAssertion,
): Grant[] {
  if (!runtime) return [];
  // 平台入口是外层网关：它自己的 args 是 {capability,args}，环境断言由 hana_invoke
  // 在解析目标后按目标能力统一确认；外层不再重复判一次。
  if (capability.platform === true) return [];
  const scope = environmentMutationScope(capability);

  const grants: Grant[] = [];
  if (runtime.multiEnv) {
    // 信封优先；args 回退兼容无信封的直调
    const expected =
      assertion?.key ?? (typeof args['expectedEnvironment'] === 'string' ? args['expectedEnvironment'] : undefined);
    if (expected === undefined || expected.trim() === '') {
      grants.push(
        block(
          capability.id,
          'env_assertion_missing',
          `多环境调用必须携带 contextToken（或 expectedEnvironment；当前环境标识=${runtime.envKey}），本次未执行`,
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
    // 只靠环境名会误判：DEV → PRD → 再回 DEV 期间签发的凭证必须靠代际失效。
    const epoch = assertion?.epoch ?? (typeof args['expectedEpoch'] === 'number' ? args['expectedEpoch'] : undefined);
    if (epoch === undefined || !Number.isInteger(epoch) || epoch < 1) {
      grants.push(
        block(
          capability.id,
          'env_epoch_missing',
          `多环境调用必须携带 contextToken（或 expectedEpoch；当前 epoch=${runtime.epoch}），本次未执行`,
        ),
      );
    } else if (epoch !== runtime.epoch) {
      grants.push(
        block(
          capability.id,
          'env_epoch_stale',
          `expectedEpoch=${epoch} 与当前 ${runtime.envKey}/epoch ${runtime.epoch} 不一致，本次未执行；` +
            '请重新获取环境列表/重新披露后再调用',
        ),
      );
    }
  }

  if (runtime.access === 'readonly' && scope === 'persistent') {
    if (capability.id === 'hana_sql_execute') {
      // SQL 有独立 HANA_SQL_ACCESS（select-only / readwrite）；全局只读不拦它，
      // 语句类别由 SQL 规则层判定，对象级访问由 HANA 账号权限约束。
    } else {
      grants.push(
        block(
          capability.id,
          'env_readonly',
          `当前环境 ${runtime.envKey} 为只读（写包为空），持久写入能力不可用；` + '临时对象与纯读不受影响，本次未执行',
        ),
      );
    }
  }
  return grants;
}

/** 多环境下给所有具体能力加必填 expectedEnvironment；单环境/平台入口原样返回 */
export function capabilityInputSchema(
  capability: Capability,
  multiEnv: boolean,
  mode: 'args' | 'envelope' = 'args',
): z.ZodType {
  // 平台入口的环境断言在 hana_invoke 顶层信封；具体能力在多环境下统一追加。
  if (mode === 'envelope' || !multiEnv || capability.platform === true) return capability.inputSchema;
  const schema = capability.inputSchema;
  if (schema instanceof z.ZodObject) {
    return schema.extend({
      expectedEnvironment: z
        .string()
        .min(1)
        .max(32)
        .describe('当前环境标识，必须与 hana_env_list 返回的 current 一致（大小写不敏感；多环境调用必填）'),
      expectedEpoch: z
        .number()
        .int()
        .min(1)
        .describe('当前环境代际 epoch，必须与 hana_env_list 返回的 epoch 一致（多环境调用必填）'),
    });
  }
  return schema;
}
