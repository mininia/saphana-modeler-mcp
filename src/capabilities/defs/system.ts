/**
 * system 域清单条目：hana_system_get_info / hana_check_privileges，均为 SYS.M_* 只读查询，kind=read。
 * 固定系统视图无资源维度（不声明 effects.plan），但同样过统一闸门 authorizeCall。
 */

import { z } from 'zod';
import { planReadless } from '../planners.js';
import { cap, type Capability } from '../types.js';

export const systemCapabilities = {
  hana_system_get_info: cap({
    id: 'hana_system_get_info',
    category: 'system',
    kind: 'read',
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '查 HANA 版本/SID/主机/当前用户/规则库（也含本 MCP 服务自身版本）',
      whenToUse: ['确认环境、版本、SPS 或服务版本', '需要查规则库（rules=…）'],
      notFor: ['判断某个具体对象能否预览（用 hana_data_preview_diagnose）'],
      priority: 'primary',
      exampleArgs: { rules: 'preview' },
    },
    title: '获取 HANA 系统信息',
    description:
      '获取 HANA 数据库基础信息：SID/数据库名/主机、版本、用途/状态、启动时间、主机信息、当前用户与 schema（来源：SYS.M_DATABASE / M_HOST_INFORMATION）。\n' +
      '另附 mcpServer（**本 MCP 服务自身**的名字/版本/Node 运行时版本，与数据库 version 区分开）、' +
      'profile（环境档案：版本/SPS、权限档位、激活器行为；探测失败标「未探测到」）与 rules（省略=目录 id+title，传 all 或规则 id=全文）。',
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
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '当前用户的粗粒度权限快照（角色/系统权限/schema SELECT/REPO 权限）',
      whenToUse: ['确认连接账号是否有仓库读写/激活能力', '排查全局权限档位'],
      notFor: [
        '判断某个具体视图/对象能否预览（用 hana_data_preview_diagnose）',
        'schema SELECT 已授予 ≠ 对象可访问：分析权限/结构化权限会另外拦截',
      ],
      priority: 'fallback',
    },
    title: '检查当前用户权限与建模能力',
    description:
      '返回当前 HANA 用户的有效权限矩阵：角色、系统权限、有 SELECT 的 schema 列表、REPO.* 仓库权限，以及建模能力摘要（读仓库/写仓库/激活/读元数据/读数据）。用于排查连接用户是否具备仓库读写与视图激活权限。\n' +
      '注意：这是**粗粒度**权限快照，schema SELECT 已授予 ≠ 某个具体对象可访问（可能受分析权限/结构化权限保护）；对象级/预览权限用 hana_data_preview_diagnose。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_env_list: cap({
    id: 'hana_env_list',
    category: 'system',
    kind: 'read',
    rootTool: true,
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '列出本进程配置的 HANA 环境与当前 active 环境（含切换 token）',
      whenToUse: ['确认当前环境/可切换环境', '切换前拿 from/epoch/switchToken'],
      notFor: ['不要用业务工具的入参猜环境；以回执的 environment 为准'],
      priority: 'primary',
    },
    title: '列出 HANA 环境',
    description:
      '列出本进程配置的 HANA 环境：当前 active 环境标识、每个环境的 access/state/运行任务数，' +
      '以及可切列表与一次性 switchToken。多环境部署才注册；不连 HANA，当前环境不可用时也能查看。' +
      '切换用 hana_system({capability:"hana_env_switch"})，token 由本工具发放。',
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_env_switch: cap({
    id: 'hana_env_switch',
    category: 'system',
    kind: 'admin',
    routeOnly: true,
    control: true,
    effects: { destructive: true, idempotent: false, mutates: 'none', plan: () => planReadless('hana_env_switch') },
    routing: {
      intent: '切换当前 active 环境（多环境、stdio）',
      whenToUse: ['用户明确要求切换环境', '需要写另一个可写环境时'],
      notFor: ['业务调用不要顺带切换；不要在 HTTP 模式尝试'],
      priority: 'admin',
      requires: '先调 hana_env_list 拿 from/epoch/switchToken；仅 stdio',
    },
    title: '切换 HANA 环境',
    description:
      '切换当前 active 环境（多环境、stdio）。必须先用 hana_env_list 获取 from/epoch/switchToken，' +
      'confirm 等于目标环境标识（大小写不敏感）；目标有运行中任务时需 acknowledgeRunningTasks=true。' +
      'HTTP 模式拒绝（多客户端共享进程）。只经 hana_system 门面路由，不注册为平铺工具。',
    inputSchema: z.object({
      to: z.string().min(1).max(32).describe('目标环境标识（见 hana_env_list 返回的 name；大小写不敏感）'),
      from: z.string().min(1).max(32).describe('当前环境标识；必须与 hana_env_list 的 current 一致（大小写不敏感）'),
      epoch: z.number().int().min(1).describe('hana_env_list 返回的 epoch；过期则拒绝'),
      switchToken: z.string().min(8).max(128).describe('hana_env_list 发放的一次性 token'),
      confirm: z.string().min(1).max(32).describe('必须等于 to（大小写不敏感）'),
      acknowledgeRunningTasks: z
        .boolean()
        .optional()
        .describe('目标环境有运行中任务时必须显式 true，表示接受新调用与任务共享池'),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
