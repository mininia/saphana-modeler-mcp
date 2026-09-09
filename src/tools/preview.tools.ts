import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { withErrorEnvelope } from '../core/errors.js';
import { previewData, type PreviewFilter } from '../services/preview.service.js';
import { diagnosePreview } from '../services/preview-diagnose.service.js';
import { registerVisibleTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

const VIEW_KIND = z.enum(['calculationview', 'attributeview', 'analyticview']);
const FILTER_OP = z.enum(['=', '!=', '<', '<=', '>', '>=', 'LIKE']);
const CHANNEL = z.enum(['direct', 'intermediate', 'derived']);

export function registerPreviewTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);
  reg(
    'hana_data_preview',
    {
      title: '数据预览',
      description:
        '对已激活视图做数据预览（支持范围有限，不支持时直接返回「不支持」，不做其他尝试）。' +
        '默认对视图整体预览（_SYS_BIC 直查）：无筛选默认返回前 10 行，有筛选默认返回前 100 行，' +
        'VIRTUAL 视图用 parameters 传输入参数（如 {"P_CURRENCY": "CNY"}）。' +
        '仅当用户明确要求看某视图中的某个节点时才传 node：调用 HANA 原生中间视图机制 ' +
        'SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV（HANA Studio 节点预览同款）让 HANA 为节点生成 SQL 虚拟视图并查询，' +
        '用完自动 DROP；该通道任意节点类型均支持，但需要 EXECUTE 权限（缺权限直接返回不支持，不会自动回退）。' +
        '如需只读 XML 推导模式（支持 Projection/Join/Aggregation/Union/Rank，SqlScriptView/变量/复杂节点不支持），' +
        '可显式传 forceDerive=true。筛选条件（filter）以 AND 连接且值参数绑定；返回 via（direct/intermediate/derived）/columns/rows/truncated，' +
        '行数规则：limit 省略时按有无筛选默认 10/100，显式上限 1000。' +
        '权限类失败（缺 EXECUTE/SELECT、_SYS_BIC 对象不可见的 258/259）会自动附带权限诊断报告（envelope.raw.diagnosis），' +
        '无需额外调用即可看到阻塞点与授权建议；手动前置排查用 hana_data_preview_diagnose',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MGF'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名，如 ZDEMO02_CV008'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
        node: z.string().regex(/^[A-Za-z0-9_]+$/).min(1).max(200).optional().describe(
          '要预览的节点 ID（如 Projection_1 / Join_1 / Aggregation_1）；省略 = 视图整体预览。仅当用户明确要求看某节点时传入',
        ),
        filter: z.array(z.object({
          column: z.string().min(1).max(128).describe('筛选列名（大小写敏感，如 CUST_ID）'),
          op: FILTER_OP.describe('操作符（= != < <= > >= LIKE）'),
          value: z.union([z.string(), z.number()]).describe('筛选值（参数绑定，无需转义）'),
        })).optional().describe('筛选条件（AND 连接）；提供筛选时默认返回前 100 行，否则前 10 行'),
        parameters: z.record(z.string(), z.string()).optional().describe(
          'VIRTUAL 视图输入参数（WITH PARAMETERS PLACEHOLDER），如 {"P_CURRENCY": "CNY"}；仅直接预览路径有效',
        ),
        limit: z.number().int().min(1).max(1000).optional().describe('返回行数上限；省略时按有无筛选默认 10/100'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async (params) => {
      const envelope: Envelope = await withErrorEnvelope(() =>
        previewData(ctx.pool, params.packageId, params.objectName, {
          kind: params.kind,
          node: params.node,
          filter: params.filter as PreviewFilter[] | undefined,
          parameters: params.parameters,
          limit: params.limit,
        }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_data_preview_diagnose',
    {
      title: '诊断数据预览权限',
      description:
        '定位「为什么某视图数据预览失败」——聚焦预览失败的两大根因：①当前 CV 是否受经典分析权限（Analytic Privilege）保护及当前用户是否被授权；' +
        '②上游数据源（derived 通道实测追溯）是否不可访问。只读，不改任何对象。\n' +
        '\n用法：\n' +
        '- 最简：只传 packageId + objectName，默认 derived 通道 + verbose=false，一次返回 brief 结论。\n' +
        '- 多数场景这样调即可，无需理解通道概念。\n' +
        '\n返回（默认精简，看 data.brief）：\n' +
        '- analyticPrivilege.protected：当前 CV 是否受经典分析权限保护\n' +
        '- analyticPrivilege.grantedCount：当前用户被授予的 ANALYTICAL_PRIVILEGE 条数（0=缺失）\n' +
        '- upstreamInaccessible：不可访问的上游数据源清单（仅不可达项，含错误码；仅 derived 通道追溯）\n' +
        '- runtimeAccessible：当前 CV 运行时对象实测是否可达（SELECT 1 探测）\n' +
        '- canPreview：综合判定（true=可预览，false=有阻塞）\n' +
        '\n参数何时调整：\n' +
        '- channel=direct（不追溯上游，只测当前 CV + 分析权限）：只关心当前视图本身权限、或视图无上游追溯需求时\n' +
        '- channel=intermediate：节点预览场景，额外检查中间视图过程 EXECUTE 权限\n' +
        '- verbose=true：需要完整 checks 明细与 blockers/hints（一般排障用不到，hana_data_preview 失败时已自动附完整诊断）\n' +
        '\n注意：hana_data_preview 在权限类失败时已自动附带完整诊断（envelope.raw.diagnosis），通常无需手动调用本工具；本工具主要用于预览前主动排查或独立定位。',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图包名，层级用 . 分隔，如 ZDEMO.ZDEMO_MGF'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名，如 ZDEMO02_CV008'),
        kind: VIEW_KIND.optional().describe('视图类型；省略时自动匹配三种类型'),
        channel: CHANNEL.default('derived').describe(
          '预览通道，多数场景用默认 derived 即可：derived（默认，追溯并实测上游数据源可达性）；' +
          'direct（仅测当前 CV，不追溯上游）；intermediate（节点预览场景，额外检查中间视图过程 EXECUTE 权限）',
        ),
        verbose: z.boolean().default(false).describe(
          'false（默认）=精简，只返回 brief（上游不可达 + 分析权限结论 + canPreview）；' +
          'true=完整，返回全部 checks/baseTables/analyticPrivilege 明细与 blockers/hints（一般排障用不到）',
        ),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ packageId, objectName, kind, channel, verbose }) => {
      const envelope: Envelope = await withErrorEnvelope(() =>
        diagnosePreview(ctx.pool, packageId, objectName, { kind, channel, verbose }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
}
