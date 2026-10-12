/**
 * 监视视图可见性探测（hana_system_health / hana_system_activity / hana_table_storage /
 * hana_system_trend 四个工具共用）。
 *
 * 为什么需要单独一层：HANA 的 `M_*` 监视视图**按调用者权限做行级过滤**——权限不足时
 * 既不报错也不提示，只是返回更少的行，甚至一行都没有。于是：
 *   - 缺少 CATALOG READ 的用户看 M_DISK_USAGE，得到空集 → 看起来"磁盘没问题"
 *   - 缺少 CATALOG READ 的用户看 M_BLOCKED_TRANSACTIONS，得到空集 → 看起来"没人被阻塞"
 *   - 缺少 CATALOG READ 的用户看 M_CONNECTIONS，只看到自己的连接 → 看起来"并发很低"
 * 三者都会输出**假的健康结论**。
 *
 * 判定依据：`CATALOG READ` 系统权限（预定义 `MONITORING` 角色含之，持该角色者同样命中）
 * 决定监视视图是否返回未过滤数据。这是实测结论（同一账号在两套环境下的行数差 15 倍，
 * 见 docs/health-monitoring-findings.md §一/§二）。
 *
 * ⚠️ 这是**启发式**：unfiltered=true 只说明"有权限拿到全量"，不代表具体某个视图一定有数据。
 * 反之 unfiltered=false 也不代表完全看不到——很多实例内视图（服务、表、计划缓存）本就不需要该权限。
 * 故它只用于回答一个问题：**"空集"该不该被当作"没问题"**。
 */

import type { HanaPool } from '../core/hana-client.js';
import { logger } from '../core/logger.js';

export interface Visibility {
  /** 是否持有 CATALOG READ（MONITORING 角色含之；决定监视视图的行是否可能被静默过滤） */
  unfiltered: boolean;
  /**
   * 当前用户持有的全部系统权限（已排序，便于排障时对照）。
   * 探测失败时为空数组——此时以 note 为准（空数组≠"没有权限"，而是"读不到"）。
   */
  heldPrivileges: string[];
  /** 可直接进输出的说明文本 */
  note: string;
}

/**
 * 探测当前连接的可见性上下文。
 *
 * ⚠️ 与 system.service.getPrivileges 的「系统权限矩阵」查询是同一张表上的两件事（那份在
 * system.service.ts 内，不属本文件）：
 * - 那边要"用户持有哪些系统权限"的**完整清单**（OBJECT_NAME IS NULL，不筛 SCHEMA_NAME），用于建模能力摘要；
 * - 这边只判定 CATALOG READ 是否在列（OBJECT_NAME/SCHEMA_NAME 均 NULL = 纯系统权限，
 *   排除对象级/ schema 级授权行）。角色不在这条查询的结果里（角色清单在 SYS.EFFECTIVE_ROLES）；
 *   预定义 MONITORING 角色内含 CATALOG READ，故持该角色者仍会被命中。
 * 两者口径与用途不同，刻意不合并；若后续要抽公共查询，必须同时确认两处口径。
 *
 * 查询失败**不**上抛：四个诊断工具都在入口直接 await 本函数，抛错会让整份报告连
 * "哪一段看不见"都拿不到。按**不可见**降级（fail-closed：空结果继续附不确定性提示），
 * 与 trend/storage 的辅助查询口径一致；note 与日志都会写明这是探测失败而非真的没有权限。
 */
export async function probeVisibility(pool: HanaPool): Promise<Visibility> {
  let held: string[] = [];
  let probeFailed = false;
  try {
    const privs = await pool.query<{ PRIVILEGE: string }>(
      `SELECT DISTINCT PRIVILEGE FROM SYS.EFFECTIVE_PRIVILEGES
     WHERE USER_NAME = CURRENT_USER AND OBJECT_NAME IS NULL AND SCHEMA_NAME IS NULL`,
    );
    held = privs.map((r) => String(r.PRIVILEGE).toUpperCase()).sort();
  } catch (e) {
    probeFailed = true;
    logger.warn({ err: e }, '监视视图可见性探测失败（SYS.EFFECTIVE_PRIVILEGES 不可读），按不可见处理');
  }
  const unfiltered = held.includes('CATALOG READ');
  return {
    unfiltered,
    heldPrivileges: held,
    note: probeFailed
      ? '可见性探测失败（SYS.EFFECTIVE_PRIVILEGES 不可读）：无法确认当前用户是否持有 CATALOG READ，按不可见处理——' +
        '**"空结果"不等于"没问题"**，相关结论会标记为 unknown 或附不确定性提示。'
      : unfiltered
        ? '当前用户持有 CATALOG READ，监视视图返回未过滤数据，空结果可读作"确实没有"。'
        : '当前用户**不**持有 CATALOG READ：磁盘、备份、主机内存、复制、他人会话等数据可能被静默过滤。' +
          '**此时"空结果"不等于"没问题"**，相关结论会标记为 unknown 或附不确定性提示。',
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
  return '当前用户缺少 CATALOG READ，本项返回空结果可能是被行过滤所致，不能据此认定"无异常"。';
}
