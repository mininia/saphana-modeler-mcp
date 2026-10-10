/**
 * `data`（取数预览）域的清单条目：hana_data_preview（视图预览 / 基表勘察两种目标）、
 * hana_data_preview_diagnose（预览失败的权限诊断）。
 *
 * 全部只读：不写仓库、不写任何表。节点预览经 HANA 原生中间视图机制建临时视图，
 * 仅当「本进程已无占用且视图由本服务创建」时才 DROP（见 preview.service 的说明）。
 * gate 均为 none：无调用期闸门，仅注册期可见性过滤。
 */

import { z } from 'zod';
import { tagResource } from '../resources.js';
import { cap, type Capability } from '../types.js';
import { planDataPreview } from '../planners.js';
import { VIEW_KIND, zObjectName } from '../schemas.js';
import { zReadPackageId } from '../schemas.js';

const FILTER_OP = z.enum(['=', '!=', '<', '<=', '>', '>=', 'LIKE']);
const CHANNEL = z.enum(['direct', 'intermediate', 'derived']);

/** 筛选条件项：zod 直接产出 PreviewFilter（不写 `as PreviewFilter[]` 断言，避免与服务层类型漂移） */
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
    effects: { plan: planDataPreview, destructive: false, idempotent: true },
    title: '数据预览 / 基表勘察',
    // 瘦身（P9）：勘察画像字段、节点预览机制（命名/复用/DROP）与权限诊断细节已整体搬进
    // rules=preview；这里只留「两种目标是什么、参数面、权限诊断存在性」。
    description:
      '数据预览，两种目标二选一：\n' +
      '① **基表勘察**（schema + table [+ columns] [+ sampleRows]）：对源表采样并逐列画像' +
      '（去重值样例 / 长度区间 / 前导零样例 / NULL 数），跨表建模前先做这一步；统计只基于采样行（默认 200）。\n' +
      '② **视图预览**（packageId + objectName [+ kind]）：对已激活视图整体预览（_SYS_BIC 直查），' +
      '支持范围有限、不支持即直接返回「不支持」；filter（AND 连接、值参数绑定）、parameters（VIRTUAL 输入参数）、' +
      'limit（省略时按有无筛选默认 10/100，上限 1000）。\n' +
      '仅当用户明确要求看某节点时才传 node（HANA 原生中间视图机制，需 EXECUTE 权限）；' +
      'forceDerive=true = 只读 XML 推导模式（支持 Projection/Join/Aggregation/Union/Rank）。\n' +
      '权限类失败会自动附带诊断报告（envelope.raw.diagnosis），手动前置排查用 hana_data_preview_diagnose；' +
      '机制与口径细则见 rules=preview（hana_system_get_info(rules=preview)）。',
    inputSchema: z.object({
      schema: tagResource(
        z.string().optional().describe('勘察模式：表/视图所在 schema（须在白名单内，如 SAPABAP1）；与 table 成对提供'),
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
          'true=只读 XML 推导模式（支持 Projection/Join/Aggregation/Union/Rank；SqlScriptView/变量/复杂节点不支持）；' +
            '默认 false=优先走原生中间视图机制（需 EXECUTE 权限，缺权限会返回不支持）。节点预览复用旧定义时也用它绕开',
        ),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),
  hana_data_preview_diagnose: cap({
    id: 'hana_data_preview_diagnose',
    category: 'data',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '诊断数据预览权限',
    // 瘦身（P9）：通道语义与 brief 字段的逐条解释并入 rules=preview；保留用法与存在性。
    description:
      '定位「为什么某视图数据预览失败」，聚焦两大根因：①当前 CV 是否受经典分析权限（Analytic Privilege）保护、' +
      '当前用户是否被授权；②上游数据源是否不可访问。只读，不改任何对象。\n' +
      '用法：最简只传 packageId + objectName（默认 derived 通道 + verbose=false），一次返回 brief 结论。\n' +
      '返回（data.brief）：analyticPrivilege.protected / grantedCount（0=缺失）、upstreamInaccessible（仅不可达项）、' +
      'runtimeAccessible（SELECT 1 实测）、canPreview（综合判定，false=有阻塞）。\n' +
      '参数：channel=direct（不追溯上游）/ intermediate（节点预览场景，另查中间视图过程 EXECUTE）/ derived（默认）；' +
      'verbose=true 才给完整 checks/baseTables 明细与 blockers/hints。\n' +
      '注意：hana_data_preview 权限类失败时已自动附完整诊断（envelope.raw.diagnosis），通常无需手动调用本工具。' +
      '通道口径细则见 rules=preview。',
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
