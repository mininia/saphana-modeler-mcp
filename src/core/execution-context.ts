/**
 * 执行上下文：一次工具调用在**入口**创建一份不可变上下文，贯穿校验/授权/预检/
 * Provider 路由/连接/Task/审计。
 *
 * 与 `EnvironmentRuntime` 的分工：runtime 持有连接池与配置（可变状态），ExecutionContext
 * 只持有本次调用**钉住**的标识（requestId / principal / envKey / epoch / policyRev /
 * manifestRev / task）。异步续体自动继承；禁止中途重新读全局 active。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { EnvironmentRuntime } from '../config/environment-runtime.js';
import type { RequestIdentity } from './request-context.js';

export interface ExecutionContext {
  requestId: string;
  principal: { clientId?: string; profileId: string };
  envKey: string;
  epoch: number;
  policyRev: string;
  manifestRev: string;
  task?: { taskId: string; environment: string; epoch: number };
}

const storage = new AsyncLocalStorage<ExecutionContext>();

export interface CreateExecutionContextInput {
  identity?: Pick<RequestIdentity, 'clientId' | 'profileId'>;
  runtime?: EnvironmentRuntime;
  policyRev: string;
  manifestRev: string;
}

/** 入口创建上下文（纯函数；不读全局 active 之外的状态）。 */
export function createExecutionContext(input: CreateExecutionContextInput): ExecutionContext {
  return {
    requestId: randomUUID(),
    principal: {
      ...(input.identity?.clientId ? { clientId: input.identity.clientId } : {}),
      profileId: input.identity?.profileId ?? 'default',
    },
    envKey: input.runtime?.envKey ?? 'DEFAULT',
    epoch: input.runtime?.epoch ?? 1,
    policyRev: input.policyRev,
    manifestRev: input.manifestRev,
  };
}

/** 在本次调用的不可变上下文下运行 fn；async handler 的续体自动继承。 */
export function runWithExecutionContext<T>(context: ExecutionContext, fn: () => T): T {
  return storage.run(context, fn);
}

/** 当前调用上下文；未进入上下文（启动期/测试直调）时 undefined。 */
export function currentExecutionContext(): ExecutionContext | undefined {
  return storage.getStore();
}

/** 绑定异步任务（Task 创建时写一次；同一调用上下文内之后只读）。 */
export function bindExecutionContextTask(task: NonNullable<ExecutionContext['task']>): boolean {
  const ctx = storage.getStore();
  if (!ctx) return false;
  storage.enterWith({ ...ctx, task });
  return true;
}

/** 测试隔离用 */
export function resetExecutionContext(): void {
  storage.disable();
}
