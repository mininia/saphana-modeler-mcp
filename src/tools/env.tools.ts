/**
 * 环境管理工具：hana_env_list（root，只读）+ hana_env_switch（route-only，admin）。
 *
 * 只在多环境部署注册：
 * - list：看当前环境标识、每个环境的 access/state/任务数、可切列表与一次性 token；
 * - switch：必须经 hana_system 门面路由，校验 allowlist/from/epoch/token/confirm/在途调用/目标任务/目标连接。
 *
 * 两个 handler 都不碰 HANA（list 只读内存；switch 的预检由 manager 负责），
 * 因此当前环境不可用时仍能查看/切换。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { CAP } from '../capabilities/manifest.js';
import type { Envelope } from '../types/hana.js';
import { withErrorEnvelope, HanaBusinessError } from '../core/errors.js';
import { currentEnvironmentRuntime } from '../core/environment-context.js';
import { currentIdentity } from '../core/request-context.js';
import { logger } from '../core/logger.js';
import { countRunningTasksForEnvironment } from '../core/task-registry.js';
import { toToolResult } from './common.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { entitlementOf } from './surface.js';

function listEnvelope(ctx: ToolContext): Envelope['data'] {
  const manager = ctx.manager;
  if (!manager) throw new Error('内部错误：环境管理器未初始化');
  // HTTP 请求可能按 Token 绑定了 runtime；以绑定值为准，stdio 才是进程 active。
  const current = currentEnvironmentRuntime() ?? manager.current();
  const httpMode = ctx.config.httpPort != null;
  // 只有切换能力对当前调用方可达时才发 token/提示切换：read 组部署下 switch 不可达，
  // 发出去的 token 永远换不了一次切换；反之 admin-only 部署下 list 本身不会进面。
  const switchEntitled = entitlementOf(ctx, currentIdentity()).ids.includes('hana_env_switch');
  const switchable = !httpMode && manager.switchable.length > 0 && switchEntitled;
  // HTTP 模式不发放 token（多客户端共享进程，全局切换会串扰）
  const token = switchable ? manager.issueSwitchToken() : undefined;
  return {
    current: current.envKey,
    currentState: httpMode ? 'active' : current.state,
    epoch: current.epoch,
    switchable,
    ...(token ? { switchToken: token.token, switchTokenExpiresAt: new Date(token.expiresAt).toISOString() } : {}),
    environments: manager.list().map((rt) => ({
      name: rt.envKey,
      access: rt.access,
      // HTTP 下进程级 state 不适用：以本请求绑定环境为 current，其余显示 idle
      state: httpMode ? (rt.envKey === current.envKey ? 'active' : 'idle') : rt.state,
      current: rt.envKey === current.envKey,
      switchable: switchable && manager.switchable.includes(rt.envKey),
      runningTasks: countRunningTasksForEnvironment(rt.envKey),
      poolOpen: rt.pool.stats().inUse + rt.pool.stats().idle > 0,
    })),
    hint: httpMode
      ? 'HTTP 多客户端共享进程：不支持运行时切换；请一进程一环境或使用 Token→环境绑定。'
      : !switchEntitled
        ? '当前调用方没有 hana_env_switch 权限（admin 组/档案）：只能查看，不能切换。'
        : manager.switchable.length > 0
          ? '切换用 hana_system({ capability: "hana_env_switch", args: { to, from: current, epoch, switchToken, confirm: to } })；token 一次性、60s 有效。'
          : '当前没有可切环境（HANA_ENV_SWITCHABLE 为空）：只能查看，不能切换。',
  };
}

/** 注册环境管理工具。handler 恒登记（门面路由表完整），是否可见由 surface 按 multiEnv/switchable 决定 */
export function registerEnvironmentTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);

  regCap(CAP.hana_env_list, async () => {
    if (!ctx.manager?.multiEnv) {
      return toToolResult(
        await withErrorEnvelope(async () => {
          throw new Error('内部错误：单环境部署不应调用 hana_env_list');
        }),
      );
    }
    return toToolResult(await withErrorEnvelope(async () => listEnvelope(ctx)));
  });

  regCap.routeOnly(CAP.hana_env_switch, async (args) => {
    const { to, from, epoch, switchToken, confirm, acknowledgeRunningTasks } = args;
    return toToolResult(
      await withErrorEnvelope(async () => {
        const manager = ctx.manager;
        if (!manager?.multiEnv || manager.switchable.length === 0) {
          throw new HanaBusinessError(
            '环境切换未启用：需要多环境部署且 HANA_ENV_SWITCHABLE 非空',
            'env_switch_disabled',
          );
        }
        const outcome = await manager.switchTo({
          to,
          from,
          epoch,
          switchToken,
          confirm,
          acknowledgeRunningTasks,
        });
        // 独立的环境切换审计事件（能力审计按 mutates=none 记 allowed，不落写终态）
        logger.info(
          {
            previous: outcome.previous,
            current: outcome.current,
            previousEpoch: outcome.previousEpoch,
            epoch: outcome.epoch,
            sourceTasks: outcome.sourceTasks,
            targetTasks: outcome.targetTasks,
          },
          'environment-switch',
        );
        return outcome;
      }),
    );
  });
}
