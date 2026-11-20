/**
 * 读取类清单条目：discovery（浏览/查找）与 insights（结构与血缘分析）两域，全部 kind=read。
 * 资源维度由 effects.plan 表达：表清单/列结构声明读 schema 规划器，其余读 _SYS_REPO 固定面不声明。
 */

import { z } from 'zod';
import { tagResource } from '../resources.js';
import { cap, type Capability } from '../types.js';
import { planTableColumns, planTableList } from '../planners.js';
import { VIEW_KIND, VERSION_SCOPE, zObjectName, zReadPackageId } from '../schemas.js';

/**
 * hana_metadata_search_objects 的跨字段规则（纯函数）。
 *
 * 这些规则 zod 表达不了（条件必填/互斥），由 preflight 与 handler 共用同一份实现，
 * 入口与直接调用两处的判定不会漂移。
 */
export function validateSearchObjectsArgs(args: {
  pattern?: string;
  by?: 'name' | 'field' | 'description' | 'both';
  field?: string;
  category?: 'model' | 'table' | 'columnView' | 'tableFunction' | 'all';
  kind?: string;
  packageId?: string;
  schema?: string;
  lang?: string;
  version?: string;
}): { message: string; hint: string } | undefined {
  const mode = args.by ?? 'name';
  const cat = args.category ?? 'model';
  if (mode === 'name' && !args.pattern) {
    return {
      message: 'by=name（默认）需要 pattern',
      hint: '按对象名搜索请给 pattern；按字段搜索用 by=field + field；按描述搜索用 by=description + pattern',
    };
  }
  if ((mode === 'description' || mode === 'both') && !args.pattern) {
    return {
      message: `by=${mode} 需要 pattern`,
      hint: '给出名称/描述片段；描述搜索覆盖模型/表/列视图，表函数目录无描述列',
    };
  }
  if (mode === 'field' && !args.field) {
    return {
      message: 'by=field 需要 field',
      hint: '给出字段 ID 片段（如 MATERIAL）；pattern 可选，用于收窄对象名候选',
    };
  }
  if (mode === 'field' && cat !== 'model') {
    return {
      message: 'by=field 只支持 category=model',
      hint: '字段来自仓库视图设计时 XML；目录对象请用 by=name/description',
    };
  }
  if (mode === 'field' && (args.packageId || args.schema || args.lang)) {
    return {
      message: 'by=field 不支持 packageId/schema/lang',
      hint: '用 pattern 收窄候选对象名；字段反查只读仓库视图',
    };
  }
  if (cat === 'tableFunction' && mode === 'description') {
    return {
      message: '表函数目录没有描述/注释列',
      hint: 'SYS.FUNCTIONS 无描述列；表函数请用 by=name 或 by=both',
    };
  }
  if ((cat === 'table' || cat === 'columnView' || cat === 'tableFunction') && args.packageId) {
    return { message: 'packageId 只用于 category=model/all 的模型部分', hint: '目录对象请用 schema 过滤' };
  }
  if (cat === 'model' && args.schema) {
    return { message: 'schema 只用于目录类别', hint: '仓库视图请用 packageId 过滤' };
  }
  if ((cat === 'table' || cat === 'columnView' || cat === 'tableFunction') && args.kind) {
    return { message: 'kind 只用于 category=model/all 的模型部分', hint: '目录对象请用 category/schema 过滤' };
  }
  if ((cat === 'table' || cat === 'columnView' || cat === 'tableFunction') && args.version === 'inactive') {
    return { message: 'version 只用于 category=model/all 的模型部分', hint: '目录对象只有当前状态' };
  }
  if ((cat === 'table' || cat === 'columnView' || cat === 'tableFunction') && args.lang) {
    return { message: 'lang 只用于 category=model/all 的模型部分', hint: '目录对象的注释没有语言变体' };
  }
  return undefined;
}

export const metadataCapabilities = {
  hana_metadata_get_view: cap({
    id: 'hana_metadata_get_view',
    category: 'discovery',
    kind: 'read',
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '读取指定视图的完整定义（数据源/节点/输出字段/变量/计算逻辑）',
      whenToUse: ['理解视图逻辑/数据源/节点结构', '需要 XML 备份或全量 update'],
      notFor: ['只看字段清单用 hana_metadata_list_fields', '权限/预览失败用 hana_data_preview_diagnose'],
      priority: 'primary',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008' },
      returns: [
        'data.view 为结构化定义（数据源/节点/字段/变量）',
        'data.xml 为仓库原始设计时 XML',
        '不分页；超大对象可能截断',
      ],
    },
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
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '按名称/描述/字段跨类别搜索，定位包名或对象名',
      whenToUse: ['只有对象名片段、不知道包名', '按注释或字段找对象'],
      notFor: ['已知 packageId+objectName 时直接 get_view/list_fields'],
      priority: 'primary',
      exampleArgs: { pattern: 'ZDEMO02_CV', by: 'name', category: 'model' },
      returns: ['model=objects；目录类别=items；all=groups+counts', 'limit 为每类上限（默认 20）'],
    },
    preflight: (args) => {
      const rule = validateSearchObjectsArgs(args as Parameters<typeof validateSearchObjectsArgs>[0]);
      return rule ? { issues: [rule.message], hint: rule.hint } : undefined;
    },
    title: '搜索元数据对象（名称 / 描述 / 字段，跨类别）',
    description:
      '按 by 搜索元数据：name（默认，对象名）/description（描述或注释）/both（名称或描述）/field（输出字段，仅 model）。\n' +
      'category 对齐 HANA Studio Find：model（默认）/table/columnView/tableFunction/all（分组返回，limit 为每类上限）。\n' +
      '描述来源：模型=仓库 caption 文本表（不解析 XML，可切 version）；表=SYS.TABLES.COMMENTS；列视图=SYS.VIEWS.COMMENTS；表函数无描述列、只能按名称。\n' +
      '过滤：模型用 packageId/kind/version；目录类别用 schema（省略=可读范围）。返回 model=objects、目录=items、all=groups+counts；细则见 rules=metadata_graph。',
    inputSchema: z.object({
      pattern: z
        .string()
        .min(1)
        .max(100)
        .optional()
        .describe('名称/描述片段（by=name/description/both 必填；by=field 可选）'),
      by: z
        .enum(['name', 'field', 'description', 'both'])
        .optional()
        .describe('name=对象名（默认）/description=描述/both=两者/field=输出字段（仅 model）'),
      field: z.string().min(1).max(100).optional().describe('字段 ID 片段（by=field 必填），如 MATERIAL'),
      category: z
        .enum(['model', 'table', 'columnView', 'tableFunction', 'all'])
        .default('model')
        .describe('model（默认）/table/columnView/tableFunction/all'),
      kind: VIEW_KIND.optional().describe('视图类型（仅 model/all 的模型部分）；省略时匹配三种视图'),
      packageId: zReadPackageId('包名（仅 model/all 的模型部分，精确匹配）').optional(),
      schema: tagResource(z.string().trim().optional().describe('schema（仅目录类别；省略=可读范围）'), 'readSchema'),
      lang: z.string().trim().max(20).optional().describe('模型 caption 语言（默认空串，如 zh_CN）'),
      version: VERSION_SCOPE.default('active').describe('模型版本（默认 active；inactive=未激活；仅 model/all）'),
      limit: z.number().int().min(1).max(100).default(20).describe('每类返回上限（默认 20，最大 100）'),
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
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '列出视图字段清单（ID/描述/类型/聚合/来源/是否带逻辑）',
      whenToUse: ['回答有哪些字段/有没有某字段', '拿字段 ID 后再看计算逻辑'],
      notFor: ['看单字段计算逻辑用 hana_metadata_get_field_logic'],
      priority: 'primary',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008' },
      returns: ['data.fields[] 字段 ID/描述/类型/聚合/来源/是否带逻辑', '不分页；字段数受对象定义限制'],
    },
    preflight: (args) => {
      const v = args as { exact?: boolean; pattern?: string };
      return v.exact === true && !v.pattern
        ? {
            issues: ['exact=true 需要同时提供 pattern（精确匹配的字段 ID）。'],
            hint: '要精确匹配请给 pattern；想看全部字段请去掉 exact（默认 false = 片段匹配）',
          }
        : undefined;
    },
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
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '回答某字段怎么算的（公式原文/源字段/溯源/字段级下游）',
      whenToUse: ['字段来源/计算逻辑', '字段级下游血缘（includeUsage=true）'],
      notFor: ['视图级依赖用 hana_metadata_where_used', '字段 ID 不确定先用 hana_metadata_list_fields'],
      priority: 'primary',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008', fieldId: 'MATERIAL' },
      returns: [
        'data.logic：公式原文/源字段/节点溯源/字段元数据',
        'includeUsage=true 时附字段级下游血缘（受 usageMaxViews 约束）',
        '单字段聚焦；不返回整视图定义',
      ],
    },
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
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '查视图上下游依赖（它依赖谁/谁依赖它）',
      whenToUse: ['改/删前查影响面', '找视图的上游数据源'],
      notFor: ['字段级逻辑用 hana_metadata_get_field_logic'],
      priority: 'primary',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008', direction: 'both' },
      returns: [
        'data.upstream[]/downstream[]：packageId/objectName/objectSuffix/refType/isRuntime',
        'depth>1 时 closure 带跳数口径；truncated 表示达到上限',
      ],
    },
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
    effects: { plan: planTableList, destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '列出 schema 下可访问的表/视图名与注释',
      whenToUse: ['找表名/确认当前用户可访问的表'],
      notFor: ['跨 schema 注释搜索用 hana_metadata_search_objects(category=table, by=description)'],
      priority: 'primary',
      exampleArgs: { schema: 'SAPABAP1', pattern: '/BIC/AZDEMO', limit: 50 },
    },
    title: '列出 schema 下的表（名称 / 注释）',
    description:
      '列出指定 schema（默认当前用户 schema）下可访问的表（SYS.TABLES 按权限过滤）；by 可按表名/注释匹配，tableType 过滤类型。\n' +
      '跨 schema 注释搜索用 hana_metadata_search_objects(category=table, by=description)；列结构用 hana_table_columns。',
    inputSchema: z.object({
      schema: tagResource(
        z.string().trim().optional().describe('schema 名（默认当前用户 schema；如 SAPABAP1/_SYS_BIC）'),
        'readSchema',
      ),
      pattern: z.string().optional().describe('按 by 匹配的片段（LIKE %pattern%；省略=不过滤）'),
      by: z
        .enum(['name', 'comment', 'both'])
        .default('name')
        .describe('name=表名（默认，大小写敏感）/comment=注释（不区分大小写）/both'),
      tableType: z.enum(['ROW', 'COLUMN', 'VIRTUAL']).optional().describe('表类型（SYS.TABLES.TABLE_TYPE）'),
      limit: z.number().int().min(1).max(200).default(50).describe('返回条数上限，默认 50，最大 200'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_table_columns: cap({
    id: 'hana_table_columns',
    category: 'discovery',
    kind: 'read',
    effects: { plan: planTableColumns, destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '取指定表/视图的列结构（列名/类型/长度/可空/默认值/注释）',
      whenToUse: ['已知表名，查列定义', 'BW 视图（名含冒号）的列类型'],
      notFor: [
        '设计时 CV 的输出字段用 hana_metadata_list_fields；BW 底层视图的列类型用本工具',
        '表不存在先用 hana_table_list 确认',
      ],
      priority: 'primary',
      exampleArgs: { schema: 'SAPABAP1', table: '/BIC/AZDEMO001' },
    },
    title: '获取表/视图列结构',
    description:
      '返回指定表/视图的列结构：列名/位置/数据类型/长度/精度/可空/默认值/注释。先查 SYS.TABLE_COLUMNS，空则回退 SYS.VIEW_COLUMNS（BW 的 CALC 视图，如 0BW:... 只在这里）；对象不存在或当前用户无权限时返回 isError，可先用 hana_table_list 确认可访问的表',
    inputSchema: z.object({
      schema: tagResource(z.string().trim().describe('schema 名，如 SAPABAP1 / _SYS_BIC'), 'readSchema'),
      table: z.string().describe('表/视图名，如 /BIC/AZDEMO001 或 0BW:RS2HANA:QUERY:...PROJ_BNR（允许冒号）'),
      limit: z.number().int().min(1).max(500).default(200).describe('返回列数上限，默认 200，最大 500'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
