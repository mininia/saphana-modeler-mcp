/**
 * 监视视图可见性探测（健康检查 / 会话深潜 / 表画像三个工具共用）。
 *
 * 为什么需要单独一层：HANA 的 `M_*` 监视视图**按调用者权限做行级过滤**——权限不足时
 * 既不报错也不提示，只是返回更少的行，甚至一行都没有。于是：
 *   - 没有 MONITORING 的用户看 M_DISK_USAGE，得到空集 → 看起来"磁盘没问题"
 *   - 没有 MONITORING 的用户看 M_BLOCKED_TRANSACTIONS，得到空集 → 看起来"没人被阻塞"
 *   - 没有 MONITORING 的用户看 M_CONNECTIONS，只看到自己的连接 → 看起来"并发很低"
 * 三者都会输出**假的健康结论**。
 *
 * 判定依据：`CATALOG READ` 系统权限（或含它的 `MONITORING` 角色）决定监视视图是否返回未过滤数据。
 * 这是实测结论（同一账号在两套环境下的行数差 15 倍，见 docs/health-monitoring-findings.md §一/§二）。
 *
 * ⚠️ 这是**启发式**：unfiltered=true 只说明"有权限拿到全量"，不代表具体某个视图一定有数据。
 * 反之 unfiltered=false 也不代表完全看不到——很多实例内视图（服务、表、计划缓存）本就不需要该权限。
 * 故它只用于回答一个问题：**"空集"该不该被当作"没问题"**。
 */

import type { HanaPool } from '../core/hana-client.js';

export interface Visibility {
  /** 是否持有 CATALOG READ / MONITORING（决定监视视图的行是否可能被静默过滤） */
  unfiltered: boolean;
  /** 当前用户持有的全部系统权限（已排序，便于排障时对照） */
  heldPrivileges: string[];
  /** 可直接进输出的说明文本 */
  note: string;
}

/** 探测当前连接的可见性上下文 */
export async function probeVisibility(pool: HanaPool): Promise<Visibility> {
  const privs = await pool.query<{ PRIVILEGE: string }>(
    `SELECT DISTINCT PRIVILEGE FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND OBJECT_NAME IS NULL AND SCHEMA_NAME IS NULL`,
  );
  const held = privs.map((r) => String(r.PRIVILEGE).toUpperCase()).sort();
  const unfiltered = held.includes('CATALOG READ') || held.includes('MONITORING');
  return {
    unfiltered,
    heldPrivileges: held,
    note: unfiltered
      ? '当前用户持有 CATALOG READ / MONITORING，监视视图返回未过滤数据，空结果可读作"确实没有"。'
      : '当前用户**不**持有 CATALOG READ / MONITORING：磁盘、备份、主机内存、复制、他人会话等数据可能被静默过滤。'
        + '**此时"空结果"不等于"没问题"**，相关结论会标记为 unknown 或附不确定性提示。',
  };
}

/**
 * 给"空结果"定性：在未过滤权限下，空集是"确实没有"；否则是"看不见"。
 * @param count 实际取到的行数
 * @param unfiltered probeVisibility 的结果
 * @returns 需要附加给调用方的告警文案；count>0 或 unfiltered 时返回 undefined
 */
export function emptyIsAmbiguous(count: number, unfiltered: boolean): string | undefined {
  if (count > 0 || unfiltered) return undefined;
  return '当前用户缺少 CATALOG READ / MONITORING，本项返回空结果可能是被行过滤所致，不能据此认定"无异常"。';
}
