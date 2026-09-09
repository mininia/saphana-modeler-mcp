import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withErrorEnvelope } from '../core/errors.js';
import { getPrivileges, getSystemInfo } from '../services/system.service.js';
import { registerVisibleTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

export function registerSystemTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);
  reg(
    'hana_system_get_info',
    {
      title: '获取 HANA 系统信息',
      description:
        '获取 HANA 数据库基础信息：SID/数据库名/主机、版本（如 2.00.085.00.xxxx）、用途/状态、' +
        '启动时间、主机信息（实例号等）、当前用户与 schema（来源：SYS.M_DATABASE / M_HOST_INFORMATION）',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (_params) => {
      const envelope: Envelope = await withErrorEnvelope(() => getSystemInfo(ctx.pool));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_check_privileges',
    {
      title: '检查当前用户权限与建模能力',
      description:
        '返回当前 HANA 用户的有效权限矩阵：角色、系统权限、有 SELECT 的 schema 列表、' +
        'REPO.* 仓库权限，以及建模能力摘要（读仓库/写仓库/激活/读元数据/读数据）。' +
        '用于排查连接用户是否具备仓库读/写与视图激活权限',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (_params) => {
      const envelope: Envelope = await withErrorEnvelope(() => getPrivileges(ctx.pool));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
}
