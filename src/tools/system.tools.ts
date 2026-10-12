/**
 * 系统信息工具（分组 **read**）：hana_system_get_info（数据库/主机基础信息）、
 * hana_check_privileges（当前用户权限矩阵与建模能力摘要）。
 *
 * 两者都是对 SYS.M_* 的只读查询，经 capabilityRegistrar 按能力清单注册；kind=read 且不声明
 * effects.plan（固定系统视图，没有写包/读 schema 资源维度），但每次调用同样过统一闸门
 * authorizeCall——可见性与档案判定对读能力一样生效。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { withErrorEnvelope } from '../core/errors.js';
import { getPrivileges, getSystemInfo } from '../services/system.service.js';
import { CAP } from '../capabilities/manifest.js';
import { capabilityRegistrar, type ToolContext } from './index.js';
import { toToolResult } from './common.js';
import type { Envelope } from '../types/hana.js';

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  // params 必须透传：rules 参数的合法值校验与规则取全文都在 service 内（工具面宽松 schema 契约，SSD §1.6）。
  // 少了这一行，清单里声明的 rules 就成了"广告了但没人处理"的死参数——模型按描述查规则全文只会永远拿到目录。
  regCap(CAP.hana_system_get_info, async (params) => {
    const envelope: Envelope = await withErrorEnvelope(() => getSystemInfo(ctx.pool, params));
    return toToolResult(envelope);
  });

  regCap(CAP.hana_check_privileges, async (_params) => {
    const envelope: Envelope = await withErrorEnvelope(() => getPrivileges(ctx.pool));
    return toToolResult(envelope);
  });
}
