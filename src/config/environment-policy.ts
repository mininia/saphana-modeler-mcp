/**
 * 环境维度判定。
 *
 * 判据唯一：清单的 `effects.mutates`，不按 kind/组名推断。
 * - 只读闸门：ACCESS=readonly 只拦 persistent；transient/none 放行。
 *   hana_sql_execute 在 select-only 下交给 SQL 规则层，deny 下整体拒绝。
 * - 环境断言（envKey/epoch）由 `contextToken` 在 `hana_invoke` 入口统一校验并拒绝
 *   （`context_stale`）；本模块只保留副作用闸门，不再读取任何 args 级旧字段。
 *
 * 本模块只产出 Grant（与 profile/资源维度同一条判定链），不改写任何配置。
 */

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
 * 必须真正生效）。环境/代际的匹配已由 contextToken 校验，不在这里重复判。
 */
export function environmentGrants(capability: Capability, runtime: EnvironmentRuntime | undefined): Grant[] {
  if (!runtime) return [];
  // 平台入口是外层网关：它自己的 args 是 {capability,args}，环境结论由目标能力单独判定。
  if (capability.platform === true) return [];
  const scope = environmentMutationScope(capability);

  const grants: Grant[] = [];
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
