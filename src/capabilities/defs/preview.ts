/**
 * data（取数预览）清单条目：hana_data_preview（视图预览 / 基表勘察）、hana_data_preview_diagnose。
 * 均为 read；带 node 的视图预览会在 _SYS_BIC 建中间视图，故 preview 的 readOnlyHint=false。
 * preview 声明资源计划（inspect 的 schema 进读范围），diagnose 不声明（packageId 仅作只读引用报告）。
 */

import { z } from 'zod';
import { tagResource } from '../resources.js';
import { cap, type Capability } from '../types.js';
import { planDataPreview } from '../planners.js';
import { VIEW_KIND, zObjectName } from '../schemas.js';
import { zReadPackageId } from '../schemas.js';
import { PREVIEW_FILTER_OPS } from '../../services/preview.service.js';
import { PREVIEW_CHANNELS } from '../../services/preview-diagnose.service.js';

/** 操作符/通道合法值单源在服务层，此处只做 schema 包装。 */
const FILTER_OP = z.enum(PREVIEW_FILTER_OPS);
const CHANNEL = z.enum(PREVIEW_CHANNELS);

/** 筛选条件项：zod 直接产出 PreviewFilter（不写 as 断言，避免与服务层类型漂移）。 */
const FILTER_ITEM = z.object({
  column: z.string().min(1).max(128).describe('筛选列名（大小写敏感，如 CUST_ID）'),
  op: FILTER_OP.describe('操作符（= != < <= > >= LIKE）'),
  value: z.union([z.string(), z.number()]).describe('筛选值（参数绑定，无需转义）'),
});

export const previewCapabilities = {
  hana_data_preview: cap({
    id: 'hana_data_preview',
    category: 'data',
    kind: 'read',
    effects: { plan: planDataPreview, destructive: false, idempotent: true, mutates: 'transient' },
    routing: {
      intent: '预览已激活视图/基表数据（含节点预览与基表画像）',
      whenToUse: ['需要看实际数据/抽样值（不是权限验证）', '跨表建模前做基表画像'],
      notFor: [
        '权限/可达性验证（含上游逐个确认）一律用 hana_data_preview_diagnose；本工具是取数工具',
        '节点预览成功不代表整体视图可预览；整体权限以不带 node 的预览/诊断为准',
      ],
      priority: 'primary',
      constraints: [
        '视图预览需 packageId+objectName；基表勘察需 schema+table',
        '权限/可达性验证用 diagnose；不要用本工具逐个预览上游（SELECT * 投影全部列，宽视图即使 limit=1 也可能很慢）',
      ],
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008', limit: 5 },
    },
    title: '数据预览 / 基表勘察',
    // 细则（勘察画像、节点预览机制、权限诊断）见 rules=preview；此处只留目标形态与参数面。
    description:
      '数据预览，两种目标二选一：\n' +
      '① 基表勘察（schema + table [+ columns] [+ sampleRows]）：对源表采样并逐列画像（去重值样例/长度区间/前导零/NULL 数），跨表建模前先做；统计只基于采样行（默认 200）。\n' +
      '② 视图预览（packageId + objectName [+ kind]）：对已激活视图整体预览（_SYS_BIC 直查），支持 filter（AND 连接、值参数绑定）、parameters（VIRTUAL 输入参数）、limit（省略时按有无筛选默认 10/100，上限 1000）。\n' +
      '仅当明确要求看某节点时才传 node（原生中间视图机制，需 EXECUTE 权限）；forceDerive=true = 只读 XML 推导模式。\n' +
      '节点预览/派生 SQL 成功只证明该节点数据链路可达，不代表整体运行时视图的权限校验通过；整体权限以不带 node 的预览/诊断为准。\n' +
      '本工具是取数工具，按 SELECT * 投影全部列；宽视图即使 limit=1 也可能很慢。权限/可达性验证（含上游逐个确认）用 hana_data_preview_diagnose（内部 SELECT 1 LIMIT 1，不返回业务数据）。\n' +
      '权限类失败自动附诊断报告（raw.diagnosis），手动排查用 hana_data_preview_diagnose；支持范围与细则见 rules=preview。',
    inputSchema: z.object({
      schema: tagResource(
        z
          .string()
          .trim()
          .optional()
          .describe('勘察模式：表/视图所在 schema（须在白名单内，如 SAPABAP1）；与 table 成对提供'),
        'readSchema',
      ),
      table: z.string().optional().describe('勘察模式：表或视图名，如 /BIC/AZDEMO001 或某视图名'),
      columns: z
        .array(z.string())
        .max(200)
        .optional()
        .describe('勘察模式：要画像的列；缺省=按元数据取（最多 50 列）。跨表关联前建议显式给出两个 key 列'),
      sampleRows: z
        .number()
        .int()
        .min(1)
        .max(2000)
        .default(200)
        .describe('勘察模式：采样行数（统计口径，非全表统计），默认 200'),
      packageId: zReadPackageId('预览模式：包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MGF').optional(),
      objectName: zObjectName('预览模式：视图对象名，如 ZDEMO02_CV008').optional(),
      kind: VIEW_KIND.optional().describe('预览模式：视图类型；省略时自动匹配三种类型'),
      node: z
        .string()
        .max(200)
        .regex(/^[A-Za-z0-9_]+$/)
        .optional()
        .describe(
          '预览模式：要预览的节点 ID（如 Projection_1 / Join_1 / Aggregation_1）；省略 = 视图整体预览。仅当用户明确要求看某节点时传入',
        ),
      filter: z
        .array(FILTER_ITEM)
        .optional()
        .describe('筛选条件（AND 连接）；提供筛选时默认返回前 100 行，否则前 10 行'),
      parameters: z
        .record(z.string(), z.string())
        .optional()
        .describe('VIRTUAL 视图输入参数（WITH PARAMETERS PLACEHOLDER），如 {"P_CURRENCY": "CNY"}；仅直接预览路径有效'),
      limit: z.number().int().min(1).max(1000).optional().describe('返回行数上限；省略时按有无筛选默认 10/100'),
      forceDerive: z
        .boolean()
        .default(false)
        .describe(
          'true=只读 XML 推导模式（节点类型支持面与缺权限行为见 rules=preview）；' +
            '默认 false=优先走原生中间视图机制。节点预览复用旧定义时也用它绕开',
        ),
    }),
    // readOnlyHint=false：node 预览会在 _SYS_BIC 建中间视图（释放失败/被占用时保留）。
    // 注解是静态的，按最重路径声明；destructiveHint=false（只动本服务自己的中间视图）。
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  }),
  hana_data_preview_diagnose: cap({
    id: 'hana_data_preview_diagnose',
    category: 'data',
    kind: 'read',
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '回答某个视图/对象为什么不能预览/没权限（258/2950）',
      whenToUse: [
        '已激活视图预览报 258/2950',
        '判断是经典分析权限、SQL 结构化权限、上游不可达还是运行时权限',
        '逐个确认上游对象是否可访问（根对象与上游都用本工具）',
      ],
      notFor: [
        '只是读定义/字段用 hana_metadata_get_view / list_fields',
        '只是看用户全局权限用 hana_check_privileges',
        'SQL 执行计划/性能用 hana_sql_analyze（只读环境不可用）',
      ],
      priority: 'primary',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008', channel: 'derived' },
      constraints: [
        '根对象与上游逐个确认都用本工具；内部 SELECT 1 LIMIT 1，不返回业务数据',
        '不要用 hana_data_preview 取数验证权限（宽视图按 SELECT * 投影会慢）',
      ],
    },
    title: '诊断数据预览权限',
    // 通道语义与 brief 字段解释见 rules=preview。
    description:
      '定位「为什么某视图数据预览失败」，覆盖三类根因：①经典分析权限（ANALYTICAL_PRIVILEGE，checkAnalyticPrivileges=true）；②SQL 结构化权限（SQL analytic privilege：applyPrivilegeType=SQL_ANALYTIC_PRIVILEGE，查 SYS.EFFECTIVE_STRUCTURED_PRIVILEGES）；③上游数据源不可达/运行时对象不可访问。只读。\n' +
      '用法：最简只传 packageId + objectName（默认 derived + verbose=false），一次返回 brief 结论。\n' +
      '返回（data.brief）：analyticPrivilege（经典 AP 三态）、structuredPrivilege（checked/determined/passed/grantedCount/statusCounts/deniedObjects/privileges；deniedObjects 直接给出未授权对象，privileges 含各对象 STATUS，不含 UNCHECKED）、upstreamInaccessible、runtimeAccessible（SELECT 1 实测；缺省≠不可达）、canPreview、nextActions（可执行下一步）。\n' +
      'STATUS 语义：APPLIED=已生效；NOT AUTHORIZED=命中检查但未获授权（该对象无 APPLIED 条目，实测会出现）；NOT GRANTED=未授予；NO MATCHING ATTRIBUTE=过滤器属性不在视图；NO FILTER VALUES FOUND=动态过滤器无值。无行=没有适用条目（通常缺授权）。\n' +
      '参数：channel=direct/intermediate/derived；verbose=true 才返回完整 checks/baseTables/privileges 明细与 blockers/hints。\n' +
      '若所有能建模的根因都通过但运行时仍 258/2950，会明确报「未建模根因」并给 Authorization Dependency Viewer / owner GRANT OPTION / SQL SECURITY 等下一步。\n' +
      '注意：根对象权限类失败时，hana_data_preview 已自动附完整诊断，通常无需再手动调用；但上游逐个确认仍用本工具（channel=direct 或 derived），不要用 hana_data_preview 取数验证。',
    inputSchema: z.object({
      packageId: zReadPackageId('视图包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MGF'),
      objectName: zObjectName('视图对象名，如 ZDEMO02_CV008'),
      kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
      channel: CHANNEL.default('derived').describe(
        '预览通道，多数场景用默认 derived 即可：derived（默认，追溯并实测上游数据源可达性）；' +
          'direct（仅测当前 CV，不追溯上游）；intermediate（节点预览场景，额外检查中间视图过程 EXECUTE 权限）',
      ),
      verbose: z
        .boolean()
        .default(false)
        .describe(
          'false（默认）=精简，只返回 brief（上游不可达 + 分析权限结论 + canPreview）；' +
            'true=完整，返回全部 checks/baseTables/analyticPrivilege 明细与 blockers/hints（一般排障用不到）',
        ),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;
