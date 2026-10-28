/**
 * 包与仓库清单条目，顺序 = 注册顺序：discovery（包树/包内对象）、modeling（建包/导入导出）、
 * diagnostics（变更审计）。kind：浏览 read；建包 write；导入导出与变更列表 admin。
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
      '列出 _SYS_REPO 仓库包（PACKAGE_CATALOG）：包路径、负责人、层级深度、原始语言、传递单元。packageId 为 . 分隔的完整路径（level 供客户端组树）；pattern 按包路径片段模糊过滤（大小写不敏感）。结果带截断与总命中数。',
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
      '列出指定包内的仓库对象（ACTIVE_OBJECT 已激活 + INACTIVE_OBJECT 未激活合并）：对象名、类型后缀、版本号、激活状态、变更时间/人。kind 可限定视图类型；pattern 按对象名片段过滤（大小写不敏感）。结果带截断。',
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
      '在仓库中新建包（目录），用于组织设计时对象（XS REST：POST /base/file/<pkg>/）。重复建包 200/201 均被接受（幂等），故不加锁。目标包须在 HANA_WRITE_PACKAGES 可写范围内。创建后可用 hana_package_list / hana_package_list_objects 观察。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名（完整路径）；须在 HANA_WRITE_PACKAGES 可写范围内，如 ZDEMO.SUB'),
      description: z.string().max(200).optional().describe('包描述（可选）'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  }),

  // readOnlyHint=false 仅因 saveTo 写本地文件；仓库侧是纯读 GET，故必须显式声明 planRepoExport
  // （否则写兜底会把 packageId 误判成写包）。
  hana_repo_export: cap({
    id: 'hana_repo_export',
    category: 'modeling',
    kind: 'admin',
    effects: { plan: planRepoExport, destructive: false, idempotent: true },
    title: '导出包为 zip 备份（Transfer API）',
    description:
      '把仓库包导出为 zip 归档（Transfer API：GET /base/xfer/export），用于设计时对象备份与迁移。对 HANA 仓库只读。\n' +
      "saveTo 提供时把 zip 写到该本地路径：只接受服务器工作目录内的相对路径（绝对路径与含 '..' 的路径一律拒绝）；省略时返回 base64 内容（小包适用，大包建议 saveTo）。",
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
      '把本地设计时文件（.calculationview XML 或导出的 zip）导入仓库（Transfer API：POST 目录目标 + PUT /base/xfer/import）。实测（SPS08）导入即激活，不存在 inactive 暂存；修改已有对象请走 hana_view_update。\n' +
      '来源二选一：filePath（本地路径，默认取文件名）或 content + fileName（内联内容）。\n' +
      '默认只用于新对象：目标文件已存在时拒绝，确需覆盖（备份恢复）显式传 overwrite=true。目标包须在 HANA_WRITE_PACKAGES 可写范围内。\n' +
      'import 覆盖不可自动回滚：覆盖前先用 hana_repo_export 留档，恢复=重新导入该 zip。\n' +
      '导入前的读取范围校验、contentScanNote 与导入后回读口径见 rules=write_receipt；跨进程并发导入无服务端前置，属已知例外。',
    inputSchema: z.object({
      targetPackageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 可写范围内'),
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
      '查询当前用户的仓库变更列表（Change-Tracking API：GET /base/change，只读）。可按 user/status 过滤；用于写操作后的审计观察。未启用 Change Tracking 时返回空列表。',
    inputSchema: z.object({
      user: z.string().max(60).optional().describe('按贡献者用户过滤；省略=当前用户可见范围'),
      status: z.number().int().min(0).max(9).optional().describe('按变更状态过滤（数值语义随 SPS；省略=全部）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
