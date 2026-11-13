/**
 * 环境上下文（AsyncLocalStorage）：保存**本次调用已解析好的 runtime**。
 *
 * 它不是进程级 current：没有“上一次切到哪”的继承，也不承载凭据以外的可变状态。
 * 调用入口取一次 runtime 写入本上下文，handler / 服务 / 回执 / 审计全程读绑定值；
 * 异步续体自动继承，不受之后 active 变化影响。
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import type { EnvironmentRuntime } from '../config/environment-runtime.js';

const storage = new AsyncLocalStorage<EnvironmentRuntime>();

/** 在指定环境 runtime 下运行 fn；async handler 的续体自动继承 */
export function runWithEnvironment<T>(runtime: EnvironmentRuntime, fn: () => T): T {
  return storage.run(runtime, fn);
}

/** 当前调用绑定的环境；未进入上下文时 undefined（测试/脚本直调可回退 active） */
export function currentEnvironmentRuntime(): EnvironmentRuntime | undefined {
  return storage.getStore();
}

/**
 * 当前环境的系统标识（环境标识）。缓存 key / 锁 key 用它分键：
 * 同一进程内不同环境（如 DEV 与 PRD）的同名对象不会互相命中或互相阻塞。
 * 未进入上下文（启动期/测试直调）回退 `DEFAULT`——与单环境行为一致。
 */
export function currentEnvironmentKey(): string {
  return storage.getStore()?.envKey ?? 'DEFAULT';
}

/**
 * 当前环境指向的**物理库**作用域（host:port/dbName）。
 *
 * 锁 key / 临时校验副本登记 / 预览中间视图归属必须按物理库分键：两个环境标识指向同一租户时，
 * 它们共享同一份对象命名空间，按环境标识分键会让 check-then-act 失去互斥（并发写丢 ETag 基线、
 * 校验互删副本、预览提前 DROP）。未进入上下文（启动期/测试直调）回退 `default`。
 */
export function currentDatabaseScopeKey(): string {
  const config = storage.getStore()?.config;
  if (!config) return 'default';
  return `${config.host.trim().toLowerCase()}:${config.port}:${(config.dbName ?? '').trim().toUpperCase()}`;
}

/**
 * task-draining 环境在最后一个任务/调用结束后回收：状态回 idle 并关闭空闲连接。
 * 切换时旧环境因运行中任务保留池；任务/调用归零后若无人回收，状态会永远停在 task-draining
 * （hana_env_list 长期误报，空闲连接保留到进程退出）。
 */
export function reclaimDrainingEnvironment(runtime: EnvironmentRuntime): void {
  if (runtime.state !== 'task-draining' || runtime.taskRefs > 0 || runtime.callRefs > 0) return;
  runtime.state = 'idle';
  void runtime.pool.closeIdle();
}

/** 清空上下文（仅测试隔离用） */
export function resetEnvironmentContext(): void {
  storage.disable();
}
