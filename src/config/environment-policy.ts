/**
 * 环境维度判定（多环境）。
 *
 * 两条规则：
 * 1. **只读闸门**：当前环境 ACCESS=readonly 时，阻断变更类能力；
 *    hana_sql_execute 例外——select-only 下交给 SQL 规则层逐条判定 read/dml，deny 下整体拒绝。
 * 2. **expectedEnvironment**：多环境下所有变更类调用必须显式自报当前 LABEL，防止“忘了切回”的整串漂移。
 *    它不是授权凭证；真正的写权限仍由全局策略与数据库账号决定。
 *
 * 本模块只产出 Grant（与 profile/资源维度同一条判定链），不改写任何配置。
 */

import { z } from 'zod';
import type { Capability } from '../capabilities/types.js';
import { BLOCKED_PREFIX } from '../core/errors.js';
import type { Grant } from './preflight.js';
import type { EnvironmentRuntime } from './environment-runtime.js';

/** 环境控制面能力：不是数据变更，不参与只读闸门与 expectedEnvironment */
const ENV_CONTROL_IDS = new Set(['hana_env_list', 'hana_env_switch', 'hana_task_get', 'hana_task_cancel']);

/**
 * 是否属于“会改变目标环境状态”的能力（只读闸门 + expectedEnvironment 用）。
 * 口径 = 写层（write/sql）或声明 destructive 的能力；**行为只读的 admin**（稳定性诊断、
 * 仓库导出、变更列表）不参与，否则只读环境会连监控/备份都不可用（与 CONFIG.md 的
 * “变更类能力”一致）。hana_data_preview 会创建中间视图，单独计入。
 */
export function isEnvironmentMutation(capability: Capability): boolean {
  if (capability.facadeOf !== undefined) return false;
  if (ENV_CONTROL_IDS.has(capability.id)) return false;
  return (
    capability.kind === 'write' ||
    capability.kind === 'sql' ||
    capability.effects.destructive === true ||
    capability.id === 'hana_data_preview'
  );
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
  if (!isEnvironmentMutation(capability)) return [];

  const grants: Grant[] = [];
  if (runtime.multiEnv) {
    const expected = typeof args['expectedEnvironment'] === 'string' ? args['expectedEnvironment'] : undefined;
    if (expected === undefined || expected.trim() === '') {
      grants.push(
        block(
          capability.id,
          'env_assertion_missing',
          `多环境变更类调用必须显式携带 expectedEnvironment（当前 LABEL=${runtime.label}），本次未执行`,
        ),
      );
    } else if (expected.trim() !== runtime.label) {
      grants.push(
        block(
          capability.id,
          'env_assertion_mismatch',
          `expectedEnvironment=${expected} 与当前环境 LABEL=${runtime.label} 不一致，本次未执行；` +
            '请确认是否忘了切回（先 hana_env_list 查看当前环境）',
        ),
      );
    }
  }

  if (runtime.access === 'readonly') {
    const sqlPolicy = runtime.config.readonlySql ?? 'select-only';
    if (capability.id === 'hana_sql_execute' && sqlPolicy === 'select-only') {
      // 交给 SQL 规则层逐条判定；这里只保证 expectedEnvironment 已通过。
    } else {
      grants.push(
        block(
          capability.id,
          'env_readonly',
          `当前环境 ${runtime.label} 为只读（ACCESS=readonly），变更类能力不可用；本次未执行`,
        ),
      );
    }
  }
  return grants;
}

/**
 * 多环境下给变更类能力 schema 增加必填 expectedEnvironment。
 * 读能力不加字段；单环境原样返回（零回归）。
 */
export function capabilityInputSchema(capability: Capability, multiEnv: boolean): z.ZodType {
  if (!multiEnv || !isEnvironmentMutation(capability)) return capability.inputSchema;
  const schema = capability.inputSchema;
  if (schema instanceof z.ZodObject) {
    return schema.extend({
      expectedEnvironment: z
        .string()
        .min(1)
        .max(32)
        .describe('当前环境 LABEL，必须与 hana_env_list 返回的 current 逐字一致（多环境变更类调用必填）'),
    });
  }
  return schema;
}
