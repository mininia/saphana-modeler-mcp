/**
 * 包与仓库操作清单条目，按 AI 能力分类拆到三域：`discovery`（列包/列对象）、`modeling`
 * （建包、导入导出）、`diagnostics`（仓库变更审计）。
 *
 * 六个入口（顺序 = 注册顺序）：包树、包内对象为只读浏览；包创建、仓库导入为写操作；
 * 仓库导出在 HANA 侧是纯读的 GET，仅 saveTo 写本地文件；变更列表为只读审计。
 * 权限层级（kind）：包树/包内对象归 read；建包归 write；导入导出与变更列表归 admin
 * （Transfer / Change-Tracking API 同档，暴露面收敛）。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { VIEW_KIND } from '../schemas.js';
import { zReadPackageId, zWritePackageId } from '../schemas.js';
import { planPackageCreate, planRepoChangelist, planRepoExport, planRepoImport } from '../planners.js';

export const packageCapabilities = {
  hana_package_list: cap({
    id: 'hana_package_list',
    category: 'discovery',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '列出仓库包（包树）',
    description:
      '列出 _SYS_REPO 仓库的包（PACKAGE_CATALOG）：包路径、负责人、层级深度、原始语言、传递单元。' +
      'packageId 为 . 分隔的完整路径（层级深度 level 供客户端组树）；pattern 按包路径片段模糊过滤（大小写不敏感）。' +
      '结果带截断（返回 limit 条并给出总命中数），用于浏览包层级、定位目标包',
    inputSchema: z.object({
      pattern: z.string().optional().describe('包路径片段过滤（如 ZDEMO 或 ZDEMO_SUB），大小写不敏感；省略=全部包'),
      limit: z.number().int().min(1).max(500).default(100).describe('返回条数上限，默认 100，最大 500'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_package_list_objects: cap({
    id: 'hana_package_list_objects',
    category: 'discovery',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '列出包内对象',
    description:
      '列出指定包内的仓库对象（来源：_SYS_REPO.ACTIVE_OBJECT 已激活 + INACTIVE_OBJECT 未激活合并）：' +
      '对象名、类型后缀、版本号、激活状态、变更时间/人。kind 可限定视图类型；pattern 按对象名片段模糊过滤（大小写不敏感）。' +
      '结果带截断（注明 Showing N of M），用于查看某包下有哪些视图/对象及其激活状态',
    inputSchema: z.object({
      packageId: zReadPackageId('包名（完整路径），如 ZDEMO.ZDEMO_MGF 或 ZDEMO'),
      pattern: z.string().optional().describe('对象名片段过滤（如 CV001），大小写不敏感；省略=全部对象'),
      kind: VIEW_KIND.optional().describe('视图类型；省略=该包全部对象类型'),
      limit: z.number().int().min(1).max(500).default(100).describe('返回条数上限，默认 100，最大 500'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_package_create: cap({
    id: 'hana_package_create',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planPackageCreate, destructive: false, idempotent: true },
    title: '新建包（目录）',
    description:
      '在仓库中新建一个包（目录），用于组织设计时对象（XS REST：POST /base/file/<pkg>/）。' +
      '重复建包 200/201 均被接受（幂等），因此不加锁、不需要 If-Match。' +
      '安全约束：目标包须在 HANA_WRITE_PACKAGES 配置的可写范围内（语义见 hana_system_get_info(rules=write_boundary)）。' +
      '创建后可用 hana_package_list / hana_package_list_objects 观察。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名（完整路径）；须在 HANA_WRITE_PACKAGES 配置的可写范围内，如 ZDEMO.SUB'),
      description: z.string().max(200).optional().describe('包描述（可选）'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  }),

  // readOnlyHint=false 仅因 saveTo 会在**本地**写文件；仓库侧（HANA）是纯读的 GET。
  // 权限层级归 admin（与 Transfer API 的另两条 hana_repo_import / hana_repo_changelist 同档）。
  // 因它**对仓库只读**，必须显式声明规划器（planRepoExport）：不声明会落到写兜底，
  // 把 packageId（"导出哪个包"）误判成写包，让导出被写边界无辜拦下。
  hana_repo_export: cap({
    id: 'hana_repo_export',
    category: 'modeling',
    kind: 'admin',
    effects: { plan: planRepoExport, destructive: false, idempotent: true },
    title: '导出包为 zip 备份（Transfer API）',
    description:
      '把仓库包导出为 zip 归档（XS REST Transfer API：GET /base/xfer/export），用于设计时对象备份与迁移。' +
      "导出是读操作，不限制包。saveTo 提供时把 zip 写到该本地路径：只接受服务器工作目录内的相对路径（绝对路径与含 '..' 的路径一律拒绝；没有可配的本地根），" +
      '省略时返回 base64 内容（小包适用，大包建议 saveTo）。' +
      '**对 HANA 仓库只读**：唯一的写入是 saveTo 指定的本地文件（因此注解 readOnlyHint=false）；' +
      '权限层级归 admin（暴露面收敛，与 Transfer API 其余两条同档）——只读部署（HANA_TOOL_GROUPS=read）' +
      '不再直接看见它，需要导出时把它加进 HANA_TOOL_ALLOW（或启用 admin 组）。',
    inputSchema: z.object({
      packageId: zReadPackageId('要导出的包名（完整路径），如 ZDEMO 或 ZDEMO.SUB'),
      saveTo: z
        .string()
        .max(500)
        .optional()
        .describe(
          'zip 落盘路径（本地文件；只接受服务器工作目录内的相对路径，绝对路径与 .. 一律拒绝）；省略=返回 base64',
        ),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  }),

  hana_repo_import: cap({
    id: 'hana_repo_import',
    category: 'modeling',
    kind: 'admin',
    effects: { plan: planRepoImport, destructive: true, idempotent: false },
    title: '导入设计时文件（Transfer API）',
    description:
      '把本地设计时文件（如 .calculationview XML 或导出的 zip）导入仓库（XS REST Transfer API：POST 目录目标+PUT /base/xfer/import）。' +
      '实测（SPS08）：导入是官方 Transfer API 通道，落库后服务端**立即激活**（Activated=true），不存在 inactive 暂存；如需修改已有对象请走 hana_view_update。' +
      '来源二选一：filePath=本地文件路径（默认取文件名做目标文件名），或 content+fileName=内联内容。' +
      '导入后回读对象元数据：回执带 ETag/etagSource 与并发迹象（跨进程并发导入无服务端前置，属已知例外）。' +
      '【默认路径】本工具只用于**新对象**导入：目标文件已存在时默认拒绝，已有对象的修改请走 hana_view_update（读取 → 修改 → 更新，版本演进），' +
      '确需覆盖导入（备份恢复）显式传 overwrite=true。安全约束：目标包须在 HANA_WRITE_PACKAGES 配置的可写范围内（语义见 hana_system_get_info(rules=write_boundary)）。' +
      '导入写入前会解析 SQL 模式视图的 <definition> 脚本做读取范围校验（限定名按可读 schema 白名单、未限定名按当前默认 schema），命中即整次拒绝且零写入；zip 归档等无法解析的载荷会在回执 contentScanNote 里如实标注未做该扫描；含 <definition> 元素却提取不出脚本正文（如元素带命名空间前缀）的载荷整次拒绝（零写入）。',
    inputSchema: z.object({
      targetPackageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
      filePath: z
        .string()
        .max(1000)
        .optional()
        .describe(
          '本地源文件路径（xml/zip）；与 content 二选一。只接受服务器工作目录内的相对路径（绝对路径与 .. 一律拒绝）',
        ),
      content: z.string().optional().describe('内联文件内容（xml 文本）；须同时提供 fileName'),
      fileName: z
        .string()
        .max(200)
        .optional()
        .describe('目标文件名（如 ZDEMO_CV_X.calculationview）；filePath 导入时省略=用源文件名'),
      overwrite: z
        .boolean()
        .default(false)
        .describe(
          '目标文件已存在时的处理：false（默认）=拒绝并提示改用 hana_view_update；true=覆盖导入（备份恢复场景）',
        ),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
  }),

  hana_repo_changelist: cap({
    id: 'hana_repo_changelist',
    category: 'diagnostics',
    kind: 'admin',
    effects: { plan: planRepoChangelist, destructive: false, idempotent: true },
    title: '查询仓库变更列表（只读）',
    description:
      '查询当前用户的仓库变更列表（XS REST Change-Tracking API：GET /base/change，只读）。' +
      '可按 user/status 过滤；用于激活/写操作后的审计观察。系统未启用 Change Tracking 时返回空列表。',
    inputSchema: z.object({
      user: z.string().max(60).optional().describe('按贡献者用户过滤；省略=当前用户可见范围'),
      status: z.number().int().min(0).max(9).optional().describe('按变更状态过滤（数值语义随 SPS；省略=全部）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
