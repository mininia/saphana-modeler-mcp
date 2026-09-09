import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withErrorEnvelope } from '../core/errors.js';
import { getTableColumns, getViewDefinition, getViewFieldList, getViewFieldLogic, listTables, searchObjects, whereUsed } from '../services/metadata.service.js';
import { registerVisibleTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

const VIEW_KIND = z.enum(['calculationview', 'attributeview', 'analyticview']);

export function registerMetadataTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);
  reg(
    'hana_metadata_get_view',
    {
      title: '读取视图完整定义',
      description:
        '读取指定视图的完整定义：format=json 返回解析后的结构化定义（数据源/节点/输出字段/变量/计算逻辑），' +
        'format=xml 返回仓库原始设计时 XML（备份/人工编辑回传用）。' +
        '选择指引：理解视图逻辑/梳理字段用 format=json（更小更聚焦）；仅当要用 hana_view_update 的 xml 全量方式改造时才读 format=xml；' +
        '加 join 类修改优先直接用 hana_view_update 的 operations 声明式模式（免读 XML）。' +
        'kind 省略时自动匹配 calculationview/attributeview/analyticview 三种类型。' +
        '只看字段清单用 hana_metadata_list_fields；只看某字段计算逻辑用 hana_metadata_get_field_logic；' +
        '按名称片段定位完整包名/对象名用 hana_metadata_search_objects',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MGF'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名，如 ZDEMO02_CV008'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
        format: z.enum(['json', 'xml']).default('json').describe('返回格式：json=结构化定义；xml=仓库原始设计时 XML'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ packageId, objectName, kind, format }) => {
      const envelope: Envelope = await withErrorEnvelope(() =>
        getViewDefinition(ctx.pool, packageId, objectName, { kind, format }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_metadata_search_objects',
    {
      title: '按名称片段搜索仓库视图',
      description:
        '在 _SYS_REPO.ACTIVE_OBJECT 中按视图对象名片段模糊搜索（大小写不敏感），返回包名/对象名/类型/版本/激活信息，' +
        '用于定位视图的完整包名与对象名。默认只搜三种视图类型（排除 UI5 仓库资源）；kind 可限定类型；带截断并返回总命中数。' +
        '典型场景：hana_metadata_list_fields / hana_metadata_get_field_logic 报"未找到视图"时，先用本工具按片段定位，' +
        '再把完整包名/对象名传给对应工具',
      inputSchema: z.object({
        pattern: z.string().min(1).max(100).describe('视图对象名片段，如 ZDEMO02 或 CV008；大小写不敏感'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时搜全部三种视图'),
        limit: z.number().int().min(1).max(100).default(20).describe('返回条数上限，默认 20，最大 100'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ pattern, kind, limit }) => {
      const envelope: Envelope = await withErrorEnvelope(() => searchObjects(ctx.pool, { pattern, kind, limit }));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_metadata_list_fields',
    {
      title: '列出视图字段清单',
      description:
        '梳理视图的字段清单：字段 ID、中文描述、类型（属性/度量）、聚合方式、来源（节点.列）、是否带计算逻辑。' +
        '默认只列输出字段（视图对外暴露的字段）；pattern 按字段 ID 片段模糊过滤，exact=true 精确匹配。' +
        '回答"某视图有哪些字段/梳理字段/有没有某字段"用本工具；' +
        '拿到字段 ID 后用 hana_metadata_get_field_logic 看该字段的完整计算逻辑',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_SD'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名，如 ZDEMO008_CV001'),
        pattern: z.string().optional().describe('字段 ID 过滤片段（如 ZDEMO_FLD）；省略=全部字段'),
        exact: z.boolean().default(false).describe('true=按字段 ID 精确匹配（pattern 必填）'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
        includeNodeCalculated: z.boolean().default(false).describe('true=附带节点内部的计算列（不进输出的中间计算字段）'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ packageId, objectName, pattern, exact, kind, includeNodeCalculated }) => {
      const envelope: Envelope = await withErrorEnvelope(() =>
        getViewFieldList(ctx.pool, packageId, objectName, { kind, pattern, exact, includeNodeCalculated }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_metadata_get_field_logic',
    {
      title: '获取单字段计算逻辑',
      description:
        '获取视图中指定字段的计算逻辑：公式原文（SQL/COLUMN_ENGINE）、公式引用的源字段、源字段沿节点映射的溯源、' +
        '字段元数据（中文描述/类型/长度）。SqlScriptView（SQL 脚本）节点返回脚本源码（script），脚本即该字段的逻辑来源。' +
        '回答"某视图某字段什么逻辑/公式怎么写的/怎么算出来的"用本工具，一次调用即可，' +
        '不返回整份视图定义，结果精准聚焦单字段。' +
        '功能边界：字段的来源映射（节点.列）看 hana_metadata_list_fields 的 source，视图的上游/下游依赖看 hana_metadata_where_used；' +
        '字段 ID 不确定时先用 hana_metadata_list_fields 按名称片段模糊搜索',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_SD'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名，如 ZDEMO008_CV001'),
        fieldId: z.string().min(1).describe('字段 ID（精确），如 ZDEMO_FLD_NEW；不确定时先 hana_metadata_list_fields 搜索'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ packageId, objectName, fieldId, kind }) => {
      const envelope: Envelope = await withErrorEnvelope(() =>
        getViewFieldLogic(ctx.pool, packageId, objectName, fieldId, { kind }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_metadata_where_used',
    {
      title: '血缘/依赖关系搜索',
      description:
        '查询视图的依赖关系（来源：_SYS_REPO.ACTIVE_OBJECTCROSSREF）：' +
        'upstream=该视图引用了哪些对象（数据源/上游视图）；downstream=哪些对象引用了该视图（下游视图/运行时目录视图）。' +
        'downstream 中 isRuntime=true 表示激活后的运行时对象（_SYS_BIC）对仓库视图的引用。' +
        '修改/删除视图前用本工具评估影响面',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MKC'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时匹配三种类型'),
        direction: z.enum(['upstream', 'downstream', 'both']).default('both').describe('血缘方向：upstream=依赖谁，downstream=谁依赖'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ packageId, objectName, kind, direction }) => {
      const envelope: Envelope = await withErrorEnvelope(() => whereUsed(ctx.pool, packageId, objectName, { kind, direction }));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_table_list',
    {
      title: '列出 schema 下的表',
      description:
        '列出指定 schema（默认当前用户 schema）下当前用户可访问的表（SYS.TABLES 按权限过滤）。' +
        '支持名称模糊匹配与条数限制。建模选数据源时用 hana_table_columns 查看具体列结构',
      inputSchema: z.object({
        schema: z.string().optional().describe('schema 名（默认当前用户 schema；如 SAPABAP1/_SYS_BIC）'),
        pattern: z.string().optional().describe('表名模糊匹配（LIKE %pattern%，大小写敏感）'),
        limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限，默认 50，最大 200'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ schema, pattern, limit }) => {
      const envelope: Envelope = await withErrorEnvelope(() => listTables(ctx.pool, { schema, pattern, limit }));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_table_columns',
    {
      title: '获取表列结构',
      description:
        '返回指定表的列结构：列名/位置/数据类型/长度/精度/可空/默认值/注释（来源：SYS.TABLE_COLUMNS）。' +
        '表不存在或当前用户无权限时返回 isError 并提示用 hana_table_list 确认可访问的表',
      inputSchema: z.object({
        schema: z.string().describe('schema 名，如 SAPABAP1 / _SYS_BIC'),
        table: z.string().describe('表名，如 /BIC/AYELC070011'),
        limit: z.number().int().min(1).max(500).default(200).describe('返回列数上限，默认 200，最大 500'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ schema, table, limit }) => {
      const envelope: Envelope = await withErrorEnvelope(() => getTableColumns(ctx.pool, schema, table, { limit }));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
}
