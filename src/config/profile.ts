/**
 * 环境档案（EnvironmentProfile，P9 / SSD §9）——"本环境实际是什么样"的探测结果。
 *
 * ## 为什么要有它
 *
 * SPS/版本、权限档位、激活器行为这类**事实**原先只存在于散文（instructions 与工具描述）里，
 * 每个会话、每个子代理都要重新读一遍；搬进档案后：进程内探测一次，模型经 `hana_system_get_info`
 * 的 `profile` 字段按需查（**零新增工具**）。
 *
 * ## 三条硬约束（改代码前先读）
 *
 * 1. **fail-open**：档案是附加信息，不是任何调用的前置条件——探测失败一律返回
 *    `{detected:false, note}` 且**绝不抛错**；连不上 HANA 时，工具自身的报错照常给出（那才是调用方要看的）。
 * 2. **不阻塞启动**：连接池是懒连接，`index.ts` 不在启动时探测；首次被调用（hana_system_get_info）才探。
 * 3. **不另写探测 SQL**：权限档位复用 `hana_check_privileges` 的实现（`services/system.service` 的
 *    `getPrivileges`）——两处各写一套判定口径，迟早会漂移成两个不同的"档位"。
 *
 * ## 缓存语义
 *
 * 探测成功（`detected:true`，含"部分字段缺失"）即进程内缓存；**失败不缓存**——一次瞬时故障
 * （HANA 未起 / 连接抖动）若被固化，会把档案永久钉死在"未探测到"，而失败路径的成本只是一次查询报错。
 * `refresh:true` 强制重探（测试经 `resetEnvironmentProfileCache()` 清空）。
 */

import type { HanaPool } from '../core/hana-client.js';
import { logger, redactSensitive } from '../core/logger.js';

/** 环境档案（经 hana_system_get_info 的 profile 字段暴露） */
export interface EnvironmentProfile {
  /** false = 未探测到（探测失败/无权限/未连接）：此时其余字段缺省，note 给原因——**fail-open，不阻塞任何调用** */
  detected: boolean;
  /** 未探测到的原因（整体未探测到，或个别字段缺省时的逐条说明） */
  note?: string;
  /** HANA 版本（从 SYS.M_DATABASE / M_DATABASE_ACTIVE 一类可读源取；探测不到就缺省） */
  version?: string;
  /** SPS 号（如 SPS08）。由版本串推出；形不成已知形状就缺省——宁可没有，不可猜 */
  sps?: string;
  /** 权限档位（复用 hana_check_privileges 的既有判定口径；取值见 probePrivilegeTier 的映射表） */
  privilegeTier?: string;
  /** 激活器行为：本环境写入是否即激活（实测过的事实；探测不到就缺省 + note） */
  activator?: { writeActivates: boolean; evidence?: string };
}

/**
 * 版本可读源（按序尝试）：SYS.M_DATABASE 是本仓库既有实现（getSystemInfo）用过的源；
 * 主源被权限（错误码 7）或存在性（259）拒绝时回退 ACTIVE 视图——两者都读不到才算"未探测到"。
 */
const VERSION_SOURCES = ['SYS.M_DATABASE', 'SYS.M_DATABASE_ACTIVE'] as const;

/**
 * 版本串 → SPS 号。
 *
 * 口径：HANA 2.0 版本串的第三段 = SPS×10 + 修订（本仓库实机环境 `2.00.085` = SPS08，
 * 见 `src/core/xs-rest.ts` 头注释的实测契约与各处「实测（SPS08）」标注）。
 * 只认 `2.00.xxx` 这一形状——形不成就不猜（缺省会让激活器行为一并缺省 + note）。
 */
function spsOf(version: string): string | undefined {
  const m = /^2\.00\.(\d{3})/.exec(version);
  if (!m) return undefined;
  return `SPS${String(Math.floor(Number(m[1]) / 10)).padStart(2, '0')}`;
}

/**
 * 激活器行为的**实测事实表**（按 SPS 记录）：探测只能取到版本，事实来自实机验证。
 * 事实源：`src/core/xs-rest.ts` 头注释 §6（SPS08 实测契约）与规则对象 `write_transport`。
 *
 * 表里没有的 SPS 一律**不猜**（缺省 + note）：把 SPS08 的结论套到别的环境，等于让档案撒谎——
 * 档案的价值全在于"它说的是本环境实测过的事实"。
 */
const ACTIVATOR_FACTS: Record<string, { writeActivates: boolean; evidence: string }> = {
  SPS08: {
    writeActivates: true,
    evidence:
      '实测（SPS08）：xs_rest 通道对合法模型一律「写入即激活」（Activated=true、Version 递增），activate 只决定激活失败是否透出',
  },
};

/** 单个探测步骤失败的原因文案（失败是常态路径：原因要短，且经脱敏——查询错误里可能带连接目标） */
function reasonOf(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return redactSensitive(raw).trim() || '未知原因';
}

/** 版本探测：按序尝试可读源，取第一段非空 VERSION；全部失败才抛（由调用方转 fail-open） */
async function probeVersion(pool: HanaPool): Promise<string> {
  let lastError: unknown;
  for (const view of VERSION_SOURCES) {
    try {
      const rows = await pool.query<{ VERSION?: unknown }>(`SELECT VERSION FROM ${view}`);
      const version = rows[0]?.VERSION;
      // 空行/空串按"这个源没给出答案"处理，继续试下一个源——静默退化成一串空字段比报"未探测到"更糟
      if (typeof version === 'string' && version.trim() !== '') return version.trim();
      lastError = new Error(`${view} 未返回 VERSION`);
    } catch (e) {
      lastError = e;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/**
 * 权限档位：复用 `getPrivileges` 的判定口径（不另写探测 SQL），把它的能力摘要压成一档。
 *
 * 档位映射（细节永远可由 `hana_check_privileges` 展开）：
 * - `modeling-write`：可写仓库 + 可激活（建模写链路可用）
 * - `repo-readonly`：能读仓库（_SYS_REPO），不能写
 * - `data-readonly`：读不到仓库，但有其它 schema 的 SELECT
 * - `none`：既无仓库权限也无 schema SELECT
 */
async function probePrivilegeTier(pool: HanaPool): Promise<string> {
  // 动态 import：本模块 ← services/system.service（getSystemInfo 要档案），而档案又要复用
  // getPrivileges 的判定——静态互引会形成 import 环（tests/unit/import-cycles.test.ts 的棘轮会拦）。
  // 调用期取值：那时两个模块都已求值完，不存在"模块级数据尚未初始化"的窗口。
  const { getPrivileges } = await import('../services/system.service.js');
  const { summary, schemaSelect } = await getPrivileges(pool);
  if (summary.canWriteRepository && summary.canActivate) return 'modeling-write';
  if (summary.canReadRepository) return 'repo-readonly';
  if (schemaSelect.length > 0) return 'data-readonly';
  return 'none';
}

/** 实际探测：版本是第一锚点（它探不到 = 连不上/无权限，整体标"未探测到"）；其余字段各自尽力 */
async function probe(pool: HanaPool): Promise<EnvironmentProfile> {
  const version = await probeVersion(pool);
  const sps = spsOf(version);
  const missing: string[] = [];

  // 权限档位与激活器行为各自独立：一个缺失不该拖垮另一个（部分可用 > 整体不可用），逐条记进 note
  let privilegeTier: string | undefined;
  try {
    privilegeTier = await probePrivilegeTier(pool);
  } catch (e) {
    missing.push(`权限档位未探测到：${reasonOf(e)}`);
  }

  let activator: EnvironmentProfile['activator'];
  const fact = sps === undefined ? undefined : ACTIVATOR_FACTS[sps];
  if (fact !== undefined) activator = { ...fact };
  else missing.push(`激活器行为未探测到：版本 ${sps ?? version} 没有实测记录`);

  return {
    detected: true,
    ...(missing.length > 0 ? { note: missing.join('；') } : {}),
    version,
    ...(sps !== undefined ? { sps } : {}),
    ...(privilegeTier !== undefined ? { privilegeTier } : {}),
    ...(activator !== undefined ? { activator } : {}),
  };
}

/** 进程内缓存（探测成功才写；一个进程只服务一个 HANA 目标，故不按池分键） */
let cached: EnvironmentProfile | undefined;
/** 并发去重：首次探测被多个请求同时触发时只探一次（HTTP 多客户端下这是常态路径） */
let inflight: Promise<EnvironmentProfile> | undefined;

/**
 * 取环境档案（进程内缓存，`opts.refresh` 强制重探）。**绝不抛错**：探测失败返回
 * `{detected:false, note:'未探测到：<原因>'}`——档案是附加信息，不阻塞任何调用。
 */
export async function getEnvironmentProfile(pool: HanaPool, opts?: { refresh?: boolean }): Promise<EnvironmentProfile> {
  const refresh = opts?.refresh === true;
  if (!refresh && cached !== undefined) return cached;
  if (!refresh && inflight !== undefined) return inflight;

  const started = probe(pool)
    .then((profile) => {
      cached = profile; // 成功（含部分字段缺失）才缓存；失败不缓存，留给下一次重试
      return profile;
    })
    .catch((e: unknown): EnvironmentProfile => {
      logger.warn({ err: e }, '环境档案探测失败（fail-open，不阻塞调用）');
      return { detected: false, note: `未探测到：${reasonOf(e)}` };
    })
    .finally(() => {
      if (inflight === started) inflight = undefined;
    });
  inflight = started;
  return started;
}

/** 清空档案缓存（仅测试用，与 resetKeyedLocks / resetTempCheckRegistry 等 reset* 入口对称） */
export function resetEnvironmentProfileCache(): void {
  cached = undefined;
  inflight = undefined;
}
