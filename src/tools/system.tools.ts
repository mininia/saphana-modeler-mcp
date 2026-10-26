/**
 * 系统信息工具（分组 read）：hana_system_get_info、hana_check_privileges。
 * 均为 SYS.M_* 只读查询，不声明 effects.plan（固定系统视图无资源维度），但同样过统一闸门。
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
  // params 必须整体透传：rules 的校验与取全文在 service 内；少了这一行 rules 就是死参数。
  regCap(CAP.hana_system_get_info, async (params) => {
    const envelope: Envelope = await withErrorEnvelope(() => getSystemInfo(ctx.pool, params));
    return toToolResult(envelope);
  });

  regCap(CAP.hana_check_privileges, async (_params) => {
    const envelope: Envelope = await withErrorEnvelope(() => getPrivileges(ctx.pool));
    return toToolResult(envelope);
  });
}
