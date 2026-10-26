/**
 * 读取类清单条目：discovery（浏览/查找）与 insights（结构与血缘分析）两域，全部 kind=read。
 * 资源维度由 effects.plan 表达：表清单/列结构声明读 schema 规划器，其余读 _SYS_REPO 固定面不声明。
 */

import { z } from 'zod';
import { tagResource } from '../resources.js';
import { cap, type Capability } from '../types.js';
import { planTableColumns, planTableList } from '../planners.js';
import { VIEW_KIND, VERSION_SCOPE, zObjectName, zReadPackageId } from '../schemas.js';

export const metadataCapabilities = {
  hana_metadata_get_view: cap({
    id: 'hana_metadata_get_view',
    category: 'discovery',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '读取视图完整定义',
    description:
      '读取指定视图的完整定义：format=json 返回结构化定义（数据源/节点/输出字段/变量/计算逻辑），format=xml 返回仓库原始设计时 XML（备份/人工编辑回传用）。\n' +
      'version 默认 active=已激活版本；传 inactive 读取未激活/有挂起改动的版本（查不到按未找到处理，不回退 active；对象有挂起改动时默认读到的是旧激活版）。\n' +
      '选择指引：理解逻辑/字段用 json；要用 hana_view_update 的 xml 全量方式改造时才读 xml；加 join 类修改优先直接用 operations。kind 省略时自动匹配三种视图类型。\n' +
      '只看字段用 hana_metadata_list_fields；看单字段逻辑用 hana_metadata_get_field_logic；按片段定位包名/对象名用 hana_metadata_search_objects。',
    inputSchema: z.object({
      packageId: zReadPackageId('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MGF'),
      objectName: zObjectName('视图对象名，如 ZDEMO02_CV008'),
      kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
      format: z.enum(['json', 'xml']).default('json').describe('返回格式：json=结构化定义；xml=仓库原始设计时 XML'),
      version: VERSION_SCOPE.default('active').describe(
        '版本视角：active=已激活版本（默认）；inactive=未激活/有挂起改动的版本（查不到按未找到，不回退 active）',
      ),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_metadata_search_objects: cap({
    id: 'hana_metadata_search_objects',
    category: 'discovery',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '搜索仓库视图（按名称 / 按字段）',
    description:
      '两种模式（by）：\n' +
      'by=name（默认）：按视图对象名片段模糊搜索仓库对象（大小写不敏感），返回包名/对象名/类型/版本/激活信息，用于定位完整包名与对象名；version 默认 active，可传 inactive。\n' +
      'by=field：找哪些视图的输出里含某字段（field 为字段 ID 片段）——逐候选解析设计时 XML，受 maxCandidates（默认 100）与 limit 约束，回执带 candidatesScanned/truncated/asOf；pattern 可选，用于收窄候选。\n' +
      '默认只搜三种视图类型；kind 可限定。典型场景：list_fields / get_field_logic 报「未找到视图」时先用本工具定位。字段级反查与依赖口径见 rules=metadata_graph。',
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('视图对象名片段（by=name 必填；by=field 可选，用于收窄候选），大小写不敏感'),
      by: z
        .enum(['name', 'field'])
        .optional()
        .describe('搜索维度：name=按对象名（默认）；field=按输出字段（需同时给 field）'),
      field: z.string().min(1).max(100).optional().describe('字段 ID 片段（by=field 必填），如 MATERIAL'),
      kind: VIEW_KIND.optional().describe('视图类型；省略时搜全部三种视图'),
      version: VERSION_SCOPE.default('active').describe(
        '版本视角：active=已激活对象（默认）；inactive=未激活/有挂起改动的对象',
      ),
      limit: z.number().int().min(1).max(100).default(20).describe('返回条数上限，默认 20，最大 100'),
      maxCandidates: z
        .number()
        .int()
        .min(1)
        .max(500)
        .optional()
        .describe('by=field 的候选视图上限（默认 100，最大 500）：每个候选要解析设计时 XML，属成本护栏'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_metadata_list_fields: cap({
    id: 'hana_metadata_list_fields',
    category: 'discovery',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '列出视图字段清单',
    description:
      '列出视图字段清单：字段 ID、中文描述、类型（属性/度量）、聚合方式、来源（节点.列）、是否带计算逻辑。默认只列输出字段；pattern 按字段 ID 片段过滤，exact=true 精确匹配。version 默认 active，可传 inactive。\n' +
      '回答「有哪些字段/有没有某字段」用它；拿到字段 ID 后用 hana_metadata_get_field_logic 看完整计算逻辑。',
    inputSchema: z.object({
      packageId: zReadPackageId('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_SD'),
      objectName: zObjectName('视图对象名，如 ZDEMO008_CV001'),
      pattern: z.string().optional().describe('字段 ID 过滤片段（如 ZDEMO_FLD）；省略=全部字段'),
      exact: z.boolean().default(false).describe('true=按字段 ID 精确匹配（pattern 必填）'),
      kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
      version: VERSION_SCOPE.default('active').describe(
        '版本视角：active=已激活版本（默认）；inactive=未激活/有挂起改动的版本',
      ),
      includeNodeCalculated: z.boolean().default(false).describe('true=附带节点内部的计算列（不进输出的中间计算字段）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_metadata_get_field_logic: cap({
    id: 'hana_metadata_get_field_logic',
    category: 'insights',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '获取单字段计算逻辑',
    description:
      '获取单个字段的计算逻辑：公式原文（SQL/COLUMN_ENGINE）、引用的源字段、沿节点映射的溯源、字段元数据（描述/类型/长度）。SqlScriptView 节点返回脚本源码。version 默认 active，可传 inactive（字段逻辑与血缘同视角）。\n' +
      '回答「某字段怎么算的」用它，一次调用聚焦单字段。字段级下游血缘用 includeUsage=true（口径见 rules=metadata_graph）。\n' +
      '边界：来源映射看 hana_metadata_list_fields 的 source；视图级依赖看 hana_metadata_where_used；字段 ID 不确定时先用 list_fields 模糊搜索。',
    inputSchema: z.object({
      packageId: zReadPackageId('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_SD'),
      objectName: zObjectName('视图对象名，如 ZDEMO008_CV001'),
      fieldId: z
        .string()
        .min(1)
        .describe('字段 ID（精确），如 ZDEMO_FLD_NEW；不确定时先 hana_metadata_list_fields 搜索'),
      kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
      version: VERSION_SCOPE.default('active').describe(
        '版本视角：active=已激活版本（默认）；inactive=未激活/有挂起改动的版本（字段逻辑与 includeUsage 血缘都按该视角）',
      ),
      includeUsage: z
        .boolean()
        .default(false)
        .describe(
          '是否附带**字段级下游血缘**：谁在哪个节点引用了该字段（跨对象扫下游候选视图，受 usageMaxViews 约束）',
        ),
      usageMaxViews: z
        .number()
        .int()
        .min(1)
        .max(200)
        .optional()
        .describe('下游扫描的候选视图上限（默认 50）；被截断时回执 truncated=true 并给出 viewsScanned'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_metadata_where_used: cap({
    id: 'hana_metadata_where_used',
    category: 'insights',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '血缘/依赖关系搜索',
    description:
      '查询视图的依赖关系：upstream=该视图引用了哪些对象（数据源/上游视图），downstream=哪些对象引用了该视图。\n' +
      'version 默认 active（ACTIVE_OBJECTCROSSREF）；inactive 查未激活/有挂起改动版本的血缘（INACTIVE_OBJECTCROSSREF，与 active 互不回退）。\n' +
      '多跳波及面用 depth>1；返回口径（isRuntime、closure/depthReached/truncated/asOf）与使用时机见 rules=metadata_graph。',
    inputSchema: z.object({
      packageId: zReadPackageId('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MKC'),
      objectName: zObjectName('视图对象名'),
      kind: VIEW_KIND.optional().describe('视图类型；省略时匹配三种类型'),
      version: VERSION_SCOPE.default('active').describe(
        '版本视角：active=已激活版本的血缘（默认）；inactive=未激活/有挂起改动版本的血缘',
      ),
      direction: z
        .enum(['upstream', 'downstream', 'both'])
        .default('both')
        .describe('血缘方向：upstream=依赖谁，downstream=谁依赖'),
      // depth 是"宽松 schema 契约"的例外（数值参数用严格联合类型，非法值走协议层拒绝）
      depth: z
        .union([z.number().int().min(1).max(50), z.literal('all')])
        .optional()
        .describe('跳数：默认 1=直接依赖（单跳）；>1 或 all 追加多跳闭包 closure（可能 truncated）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_table_list: cap({
    id: 'hana_table_list',
    category: 'discovery',
    kind: 'read',
    effects: { plan: planTableList, destructive: false, idempotent: true },
    title: '列出 schema 下的表',
    description:
      '列出指定 schema（默认当前用户 schema）下当前用户可访问的表（SYS.TABLES 按权限过滤），支持名称模糊匹配与条数限制。建模选数据源时用 hana_table_columns 查看列结构',
    inputSchema: z.object({
      schema: tagResource(
        z.string().trim().optional().describe('schema 名（默认当前用户 schema；如 SAPABAP1/_SYS_BIC）'),
        'readSchema',
      ),
      pattern: z.string().optional().describe('表名模糊匹配（LIKE %pattern%，大小写敏感）'),
      limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限，默认 50，最大 200'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_table_columns: cap({
    id: 'hana_table_columns',
    category: 'discovery',
    kind: 'read',
    effects: { plan: planTableColumns, destructive: false, idempotent: true },
    title: '获取表列结构',
    description:
      '返回指定表的列结构：列名/位置/数据类型/长度/精度/可空/默认值/注释（来源：SYS.TABLE_COLUMNS）。表不存在或当前用户无权限时返回 isError，可先用 hana_table_list 确认可访问的表',
    inputSchema: z.object({
      schema: tagResource(z.string().trim().describe('schema 名，如 SAPABAP1 / _SYS_BIC'), 'readSchema'),
      table: z.string().describe('表名，如 /BIC/AZDEMO001'),
      limit: z.number().int().min(1).max(500).default(200).describe('返回列数上限，默认 200，最大 500'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
