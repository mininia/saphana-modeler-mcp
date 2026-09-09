import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withErrorEnvelope } from '../core/errors.js';
import { assertSafeObjectName } from '../core/sql.js';
import { listPackageObjects, listPackages } from '../services/metadata.service.js';
import {
  createPackageViaRest,
  exportPackageViaRest,
  importObjectViaRest,
  listChangesViaRest,
} from '../services/repository.service.js';
import { registerVisibleTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

const VIEW_KIND = z.enum(['calculationview', 'attributeview', 'analyticview']);

/** 包/对象浏览工具：包树 + 包内对象清单（只读） */
export function registerPackageTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);
  reg(
    'hana_package_list',
    {
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
    },
    async ({ pattern, limit }) => {
      const envelope: Envelope = await withErrorEnvelope(() => listPackages(ctx.pool, { pattern, limit }));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_package_list_objects',
    {
      title: '列出包内对象',
      description:
        '列出指定包内的仓库对象（来源：_SYS_REPO.ACTIVE_OBJECT 已激活 + INACTIVE_OBJECT 未激活合并）：' +
        '对象名、类型后缀、版本号、激活状态、变更时间/人。kind 可限定视图类型；pattern 按对象名片段模糊过滤（大小写不敏感）。' +
        '结果带截断（注明 Showing N of M），用于查看某包下有哪些视图/对象及其激活状态',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('包名（完整路径），如 ZDEMO.ZDEMO_MGF 或 ZDEMO'),
        pattern: z.string().optional().describe('对象名片段过滤（如 CV001），大小写不敏感；省略=全部对象'),
        kind: VIEW_KIND.optional().describe('视图类型；省略=该包全部对象类型'),
        limit: z.number().int().min(1).max(500).default(100).describe('返回条数上限，默认 100，最大 500'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ packageId, pattern, kind, limit }) => {
      const envelope: Envelope = await withErrorEnvelope(() => {
        assertSafeObjectName(packageId, '包');
        return listPackageObjects(ctx.pool, packageId, { pattern, kind, limit });
      });
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

    reg(
      'hana_package_create',
      {
        title: '新建包（目录）',
        description:
          '在仓库中新建一个包（目录），用于组织设计时对象（XS REST：POST /base/file/<pkg>/）。' +
          '安全约束：新建包路径须在 HANA_WRITE_PACKAGES 配置的可写范围内（空=全部可写；非空=仅配置包及其子包）。' +
          '创建后可用 hana_package_list / hana_package_list_objects 观察。',
        inputSchema: z.object({
          packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名（完整路径）；须在 HANA_WRITE_PACKAGES 配置的可写范围内，如 ZDEMO.SUB'),
          description: z.string().max(200).optional().describe('包描述（可选）'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
      },
      async ({ packageId, description }) => {
        const envelope: Envelope = await withErrorEnvelope(() =>
          createPackageViaRest(ctx.config, packageId, description),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );

    reg(
      'hana_repo_export',
      {
        title: '导出包为 zip 备份（Transfer API）',
        description:
          '把仓库包导出为 zip 归档（XS REST Transfer API：GET /base/xfer/export），用于设计时对象备份与迁移。' +
          '导出是读操作，不限制包。saveTo 提供时把 zip 写到该本地路径（相对路径按服务器工作目录解析），' +
          '省略时返回 base64 内容（小包适用，大包建议 saveTo）。',
        inputSchema: z.object({
          packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('要导出的包名（完整路径），如 ZDEMO 或 ZDEMO.SUB'),
          saveTo: z.string().max(500).optional().describe('zip 落盘路径（本地文件）；省略=返回 base64'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
      },
      async ({ packageId, saveTo }) => {
        const envelope: Envelope = await withErrorEnvelope(() => exportPackageViaRest(ctx.config, packageId, saveTo));
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );

    reg(
      'hana_repo_import',
      {
        title: '导入设计时文件（Transfer API）',
        description:
          '把本地设计时文件（如 .calculationview XML 或导出的 zip）导入仓库（XS REST Transfer API：POST 目录目标+PUT /base/xfer/import）。' +
          '实测：导入的文件落库为 **inactive** 设计对象（可用 hana_view_validate(target=design) 校验后 hana_view_activate 激活）。' +
          '来源二选一：filePath=本地文件路径（默认取文件名做目标文件名），或 content+fileName=内联内容。' +
          '导入后回读对象元数据。' +
          '【默认路径】本工具只用于**新对象**导入：目标文件已存在时默认拒绝，已有对象的修改请走 hana_view_update（读取 → 修改 → 更新，版本演进），' +
          '确需覆盖导入（备份恢复）显式传 overwrite=true。安全约束：目标包须在 HANA_WRITE_PACKAGES 配置的可写范围内（空=全部可写；非空=仅配置包及其子包）。',
        inputSchema: z.object({
          targetPackageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
          filePath: z.string().max(1000).optional().describe('本地源文件路径（xml/zip）；与 content 二选一'),
          content: z.string().optional().describe('内联文件内容（xml 文本）；须同时提供 fileName'),
          fileName: z.string().max(200).optional().describe('目标文件名（如 ZDEMO_CV_X.calculationview）；filePath 导入时省略=用源文件名'),
          overwrite: z.boolean().default(false)
            .describe('目标文件已存在时的处理：false（默认）=拒绝并提示改用 hana_view_update；true=覆盖导入（备份恢复场景）'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
      },
      async ({ targetPackageId, filePath, content, fileName, overwrite }) => {
        const envelope: Envelope = await withErrorEnvelope(() =>
          importObjectViaRest(ctx.config, { targetPackageId, filePath, content, fileName, overwrite }),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );

    reg(
      'hana_repo_changelist',
      {
        title: '查询仓库变更列表（只读）',
        description:
          '查询当前用户的仓库变更列表（XS REST Change-Tracking API：GET /base/change，只读）。' +
          '可按 user/status 过滤；用于激活/写操作后的审计观察。系统未启用 Change Tracking 时返回空列表。',
        inputSchema: z.object({
          user: z.string().max(60).optional().describe('按贡献者用户过滤；省略=当前用户可见范围'),
          status: z.number().int().min(0).max(9).optional().describe('按变更状态过滤（数值语义随 SPS；省略=全部）'),
        }),
        annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      },
      async ({ user, status }) => {
        const envelope: Envelope = await withErrorEnvelope(() => listChangesViaRest(ctx.config, { user, status }));
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );
}