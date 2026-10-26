/**
 * system 域清单条目：hana_system_get_info / hana_check_privileges，均为 SYS.M_* 只读查询，kind=read。
 * 固定系统视图无资源维度（不声明 effects.plan），但同样过统一闸门 authorizeCall。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';

export const systemCapabilities = {
  hana_system_get_info: cap({
    id: 'hana_system_get_info',
    category: 'system',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '获取 HANA 系统信息',
    description:
      '获取 HANA 数据库基础信息：SID/数据库名/主机、版本、用途/状态、启动时间、主机信息、当前用户与 schema（来源：SYS.M_DATABASE / M_HOST_INFORMATION）。\n' +
      '另附 profile（环境档案：版本/SPS、权限档位、激活器行为；探测失败标「未探测到」）与 rules（省略=目录 id+title，传 all 或规则 id=全文）。',
    inputSchema: z.object({
      rules: z
        .string()
        .optional()
        .describe('规则库查询：省略=目录（id+title）；all=全部规则全文；或规则 id（逗号分隔多个）'),
      refreshProfile: z
        .boolean()
        .optional()
        .describe('true=强制重探环境档案（默认走进程内缓存）：HANA 侧补授权后想看新档位时用'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_check_privileges: cap({
    id: 'hana_check_privileges',
    category: 'system',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '检查当前用户权限与建模能力',
    description:
      '返回当前 HANA 用户的有效权限矩阵：角色、系统权限、有 SELECT 的 schema 列表、REPO.* 仓库权限，以及建模能力摘要（读仓库/写仓库/激活/读元数据/读数据）。用于排查连接用户是否具备仓库读写与视图激活权限',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
