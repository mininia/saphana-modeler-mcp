/**
 * 多环境运行时：每个环境一个独立 HanaPool / config / 缓存作用域。
 *
 * v2 模型：环境标识（envKey）直接取自 `HANA_<PARAM>_ENV_<XXXX>` 的 `<XXXX>`，
 * 大小写不敏感，内部规范化为大写。没有 LABEL / configKey 两层概念。
 *
 * 切换状态机：
 * - 切换前校验 allowlist / from / epoch / token / confirm / 在途调用 / 目标任务 / 目标连接；
 * - 校验与 active+epoch 更新在同步临界区内完成（中间无 await）；
 * - 旧环境有运行中任务 → task-draining（保留池）；否则 idle 并只关闭空闲连接；
 * - 池选项按环境从各自 config 派生（POOL_* / SQL_TIMEOUT_MS 可按环境不同）。
 */

import { randomUUID } from 'node:crypto';
import { HanaPool, type HanaPoolOptions } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { countRunningTasksForEnvironment } from '../core/task-registry.js';
import type { HanaConfig } from './config.js';
import { canonicalEnvKey, type EnvironmentAccess, type LoadedEnvironments } from './environment-config.js';

export type EnvironmentState = 'active' | 'task-draining' | 'idle';

/** 一个可运行环境；envKey 是环境标识（规范化为大写）。 */
export interface EnvironmentRuntime {
  envKey: string;
  access: EnvironmentAccess;
  config: HanaConfig;
  pool: HanaPool;
  state: EnvironmentState;
  /** 每次实际切换递增；任务/回执据此还原执行时的环境版本 */
  epoch: number;
  /** 业务调用对池的租约（切换时用于延迟关闭） */
  callRefs: number;
  /** 运行中异步任务对池的租约 */
  taskRefs: number;
  /** 是否多环境部署（单环境不产生环境字段，保持旧输出） */
  multiEnv: boolean;
}

/** 切换入参（工具层已做 schema 校验；to/from/confirm 大小写不敏感） */
export interface SwitchEnvironmentInput {
  to: string;
  from: string;
  epoch: number;
  switchToken: string;
  confirm: string;
  acknowledgeRunningTasks?: boolean;
}

/** 切换成功回执（不包含 host/user/password） */
export interface SwitchEnvironmentOutcome {
  previous: string;
  current: string;
  previousEpoch: number;
  epoch: number;
  previousState: EnvironmentState;
  currentState: EnvironmentState;
  sourceTasks: number;
  targetTasks: number;
  pools: { kept: string[]; closed: string[] };
  notice: string;
}

interface SwitchTokenRecord {
  from: string;
  epoch: number;
  expiresAt: number;
}

const SWITCH_TOKEN_TTL_MS = 60_000;
const SWITCH_TOKEN_MAX = 64;

/** 池工厂（测试注入用；生产默认 new HanaPool） */
export type EnvironmentPoolFactory = (config: HanaConfig, options: HanaPoolOptions) => HanaPool;

/** 进程内环境管理器：单 active、按环境标识索引。 */
export class EnvironmentManager {
  private readonly runtimes = new Map<string, EnvironmentRuntime>();
  private readonly loaded: LoadedEnvironments;
  private activeKey: string;
  private currentEpoch = 1;
  private activeCalls = 0;
  private readonly switchTokens = new Map<string, SwitchTokenRecord>();

  constructor(
    loaded: LoadedEnvironments,
    poolOptions: HanaPoolOptions = {},
    poolFactory: EnvironmentPoolFactory = (config, options) => new HanaPool(config, options),
  ) {
    this.loaded = loaded;
    this.activeKey = loaded.startKey;
    for (const entry of loaded.entries) {
      // 池选项按环境派生：POOL_* / SQL_TIMEOUT_MS 在 v2 属于策略层，可按环境不同。
      const options: HanaPoolOptions = {
        ...poolOptions,
        max: entry.config.poolMax ?? poolOptions.max,
        maxWaiters: entry.config.poolMaxWaiters ?? poolOptions.maxWaiters,
        acquireTimeoutMs: entry.config.poolWaitMs ?? poolOptions.acquireTimeoutMs,
        statementTimeoutMs: entry.config.sqlTimeoutMs ?? poolOptions.statementTimeoutMs,
      };
      this.runtimes.set(entry.envKey, {
        envKey: entry.envKey,
        access: entry.access,
        config: entry.config,
        pool: poolFactory(entry.config, options),
        state: entry.envKey === loaded.startKey ? 'active' : 'idle',
        epoch: 1,
        callRefs: 0,
        taskRefs: 0,
        multiEnv: loaded.multiEnv,
      });
    }
  }

  /** 当前 active 环境（调用入口绑定的就是它） */
  current(): EnvironmentRuntime {
    const rt = this.runtimes.get(this.activeKey);
    if (!rt) {
      // 构造期已校验 startKey 必然存在；这里只防未来代码改动破坏不变量
      throw new Error(`内部错误：active 环境 ${this.activeKey} 不在环境表中`);
    }
    return rt;
  }

  /** 按环境标识取环境；未知返回 undefined（工具层负责转成业务错误） */
  get(envKey: string): EnvironmentRuntime | undefined {
    return this.runtimes.get(envKey);
  }

  /** 全部环境（按环境标识排序） */
  list(): EnvironmentRuntime[] {
    return [...this.runtimes.values()];
  }

  get startKey(): string {
    return this.loaded.startKey;
  }

  get switchable(): readonly string[] {
    return this.loaded.switchable;
  }

  get multiEnv(): boolean {
    return this.loaded.multiEnv;
  }

  get epoch(): number {
    return this.currentEpoch;
  }

  /** 在途同步调用数（含 switch 自身）；切换要求 === 1，保证没有别的调用被撕裂 */
  get activeCallCount(): number {
    return this.activeCalls;
  }

  beginCall(): void {
    this.activeCalls += 1;
  }

  endCall(): void {
    this.activeCalls = Math.max(0, this.activeCalls - 1);
  }

  /**
   * 发放一次性切换 token。只有配置了 switchable 才发；过期/超量的惰性清理。
   * 它不是“人类同意”，只是让切换必须基于最近一次 list 读到的 from+epoch。
   */
  issueSwitchToken(): { token: string; expiresAt: number } | undefined {
    if (!this.loaded.multiEnv || this.loaded.switchable.length === 0) return undefined;
    // HTTP 多客户端共享进程：不发放 token，handler 层也会拒绝
    if (this.loaded.base.config.httpPort != null) return undefined;
    const now = Date.now();
    for (const [token, rec] of this.switchTokens) {
      if (rec.expiresAt <= now) this.switchTokens.delete(token);
    }
    while (this.switchTokens.size >= SWITCH_TOKEN_MAX) {
      const oldest = this.switchTokens.keys().next();
      if (oldest.done) break;
      this.switchTokens.delete(oldest.value);
    }
    const token = randomUUID();
    const expiresAt = now + SWITCH_TOKEN_TTL_MS;
    this.switchTokens.set(token, { from: this.activeKey, epoch: this.currentEpoch, expiresAt });
    return { token, expiresAt };
  }

  private consumeSwitchToken(token: string, from: string, epoch: number): boolean {
    const rec = this.switchTokens.get(token);
    this.switchTokens.delete(token);
    return rec !== undefined && rec.expiresAt > Date.now() && rec.from === from && rec.epoch === epoch;
  }

  /**
   * 事务式切换：校验 → 目标连接预检 → 同步提交 active+epoch → 异步清理旧池。
   * 任何失败都保持原 active/epoch 不变（不先关旧池、不先改状态）。
   * to/from/confirm 大小写不敏感，内部按规范化后的环境标识比较。
   */
  async switchTo(input: SwitchEnvironmentInput): Promise<SwitchEnvironmentOutcome> {
    const { epoch, switchToken, acknowledgeRunningTasks } = input;
    const to = canonicalEnvKey(input.to, 'hana_env_switch.to');
    const from = canonicalEnvKey(input.from, 'hana_env_switch.from');
    const confirm = canonicalEnvKey(input.confirm, 'hana_env_switch.confirm');
    const base = this.loaded.base.config;

    if (base.httpPort != null) {
      throw new HanaBusinessError(
        'HTTP 模式不支持进程级环境切换：多客户端共享同一进程，切换会影响其他客户端。' +
          'HTTP 部署请一进程一环境，或使用 Token→环境绑定',
        'env_switch_http_unsupported',
      );
    }

    const target = this.runtimes.get(to);
    if (!target) {
      throw new HanaBusinessError(
        `未知环境：${to}。可用环境标识：${this.list()
          .map((r) => r.envKey)
          .join(', ')}`,
        'env_key_unknown',
      );
    }
    if (!this.loaded.switchable.includes(to)) {
      throw new HanaBusinessError(
        `环境 ${to} 不在 HANA_ENV_SWITCHABLE 中，不可切换。可切列表：${this.loaded.switchable.join(', ') || '(空)'}`,
        'env_switch_target_not_allowed',
      );
    }
    if (this.activeKey === to) {
      throw new HanaBusinessError(`环境 ${to} 已经是当前 active，无需切换`, 'env_already_active');
    }
    if (from !== this.activeKey) {
      throw new HanaBusinessError(
        `切换基线不匹配：请求 from=${from}，当前 active=${this.activeKey}。请重新调用 hana_env_list`,
        'env_switch_from_mismatch',
      );
    }
    if (epoch !== this.currentEpoch) {
      throw new HanaBusinessError(
        `切换 epoch 过期：请求 epoch=${epoch}，当前 epoch=${this.currentEpoch}。请重新调用 hana_env_list`,
        'env_switch_epoch_stale',
      );
    }
    if (!this.consumeSwitchToken(switchToken, from, epoch)) {
      throw new HanaBusinessError(
        '切换 token 无效/已过期/已使用：请重新调用 hana_env_list 获取新 token',
        'env_switch_token_invalid',
      );
    }
    if (confirm !== to) {
      throw new HanaBusinessError(
        `确认串不匹配：confirm 必须等于目标环境标识（${to}，大小写不敏感）`,
        'env_switch_confirm_mismatch',
      );
    }
    if (this.activeCalls > 1) {
      throw new HanaBusinessError(
        '切换被拒绝：当前还有其他在途工具调用。请等它结束后重试（切换不会强切）',
        'env_switch_busy',
      );
    }

    const targetTasks = countRunningTasksForEnvironment(target.envKey);
    if (targetTasks > 0 && acknowledgeRunningTasks !== true) {
      throw new HanaBusinessError(
        `目标环境 ${target.envKey} 还有 ${targetTasks} 个运行中的任务；` +
          '如确认要切过去（新调用会与该任务共享池），请传 acknowledgeRunningTasks=true',
        'env_switch_target_has_running_tasks',
      );
    }

    // 目标连接预检：失败不破坏当前环境（不先关旧池、不先改 active）。
    try {
      await target.pool.query('SELECT 1 FROM DUMMY', undefined, { timeoutMs: 5_000 });
    } catch (e) {
      throw new HanaBusinessError(
        `目标环境 ${target.envKey} 连接预检失败，切换未执行（当前环境保持不变）：` +
          (e instanceof Error ? e.message : '未知错误'),
        'env_switch_target_unreachable',
      );
    }

    // ── 同步提交临界区：从这里到返回不得有 await ────────────────────────────
    const previous = this.current();
    const previousEpoch = this.currentEpoch;
    const sourceTasks = countRunningTasksForEnvironment(previous.envKey);
    this.currentEpoch += 1;
    this.activeKey = target.envKey;

    // 本次 switch 调用自己也持有 1 个 callRef；>1 才代表还有别的在途调用。
    // 有运行中任务或别的在途调用 → task-draining（保留池）；否则 idle（只 closeIdle）。
    previous.state = sourceTasks > 0 || previous.taskRefs > 0 || previous.callRefs > 1 ? 'task-draining' : 'idle';
    previous.epoch = this.currentEpoch;
    target.state = 'active';
    target.epoch = this.currentEpoch;
    // 切换后旧 token 全部失效；调用方必须重新 list 才能再切
    this.switchTokens.clear();

    const kept: string[] = [];
    const closed: string[] = [];
    if (previous.state === 'idle') {
      closed.push(previous.envKey);
      // 提交后才异步清空闲连接；不清 pwd，池对象仍可复用
      void previous.pool.closeIdle();
    } else {
      kept.push(previous.envKey);
    }
    if (targetTasks > 0) kept.push(target.envKey);

    return {
      previous: previous.envKey,
      current: target.envKey,
      previousEpoch,
      epoch: this.currentEpoch,
      previousState: previous.state,
      currentState: target.state,
      sourceTasks,
      targetTasks,
      pools: { kept: [...new Set(kept)], closed },
      notice:
        '切换只影响本次响应之后的调用；已开始的调用仍绑定原环境。' +
        '非纯读调用（含临时对象）请携带 expectedEnvironment=<当前环境标识>；需要切回时重新调用 hana_env_list 获取新 token。',
    };
  }

  /** 进程收尾：关闭所有已创建池（连接懒建，通常只有 active 有连接） */
  async closeAll(): Promise<void> {
    await Promise.allSettled(this.list().map((rt) => rt.pool.closeAll()));
  }
}
