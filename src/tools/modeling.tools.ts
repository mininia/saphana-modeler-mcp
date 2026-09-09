import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { mcpErrorText, withErrorEnvelope } from '../core/errors.js';
import {
  activateCalculationView,
  checkCalculationViewDesignTime,
  createCalculationView,
  deleteCalculationView,
  updateCalculationView,
} from '../services/repository.service.js';
import { getCheckActions, validateCalculationView } from '../services/validation.service.js';
import { registerVisibleTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';

export function registerModelingTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);
  reg(
    'hana_view_create',
    {
      title: '新建 Calculation View（计算视图）',
      description:
        '在仓库中新建一个 Calculation View（计算视图）。当前仅支持最小形态：单个 Projection 节点 + 单个表/视图数据源（全列透传）。' +
        '安全约束：写操作的可写包范围由 mcp.json 的 HANA_WRITE_PACKAGES 配置（空=全部可写；非空=仅配置包及其子包）；同名对象已存在时拒绝覆盖。' +
        '流程：校验包名/对象名 → 检查对象不存在 → 取源列 → 生成设计时 XML → 写入仓库（XS REST PUT）→（可选）显式激活。' +
        '实测边界（SPS08）：①激活要求视图至少 1 个度量 → 默认 SUM_NUMERIC（数值列聚合 sum），ALL_ATTRIBUTES（无度量）激活会被 40117 拒绝；' +
        '②本服务器对合法模型「写入即激活」，activate=false 不保证 inactive——返回的 activated 为写入后实测状态（激活失败的对象才是 inactive，错误明细在 activationErrors）。' +
        '写后可用 hana_view_validate(target=design) 做无副作用激活前校验、hana_data_preview 预览、hana_metadata_* 查看字段。' +
        'transports：xs_rest=XS REST 官方写路径（默认，推荐）；repo_rest=走 SYS.REPOSITORY_REST（Studio 同款，部分环境写会 40106）；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT（兜底，需 Studio 手工激活，非官方支持）。',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内（如 ZDEMO 或 ZDEMO.SUB）'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('新视图对象名（不含包名），如 ZDEMO_CV_TEST001'),
        description: z.string().max(200).optional().describe('视图描述（默认取对象名）'),
        sourceSchema: z.string().describe('源表/视图所在 schema，如 SAPABAP1（须在白名单内）'),
        sourceName: z.string().describe('源表/视图名，如某可访问的表'),
        measureMode: z.enum(['SUM_NUMERIC', 'ALL_ATTRIBUTES']).default('SUM_NUMERIC')
          .describe('度量策略：SUM_NUMERIC=数值列进 baseMeasures 聚合 sum（默认，本环境激活要求 ≥1 度量）；ALL_ATTRIBUTES=全部列当属性（无度量，仅能保存 inactive，激活会被拒绝）'),
        activate: z.boolean().default(false).describe('true=写入后立即尝试激活（repo_rest 通道）；false=仅写设计时对象'),
        transport: z.enum(['repo_rest', 'xs_rest', 'inactive_object']).default('xs_rest')
          .describe('传输通道：xs_rest=XS REST 官方写路径（默认，推荐）；repo_rest=裸 SYS.REPOSITORY_REST（部分环境写会 40106）；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT（兜底，需手工激活）'),
        columns: z.array(z.string()).max(600).optional().describe('要映射的列名清单；省略=源表全列（自动按类型区分属性/度量）'),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ packageId, objectName, description, sourceSchema, sourceName, measureMode, activate, transport, columns }) => {
      const envelope: Envelope = await withErrorEnvelope(() =>
        createCalculationView(ctx.config, ctx.pool, {
          packageId,
          objectName,
          description,
          source: {
            schema: sourceSchema,
            name: sourceName,
            measureMode,
            columns: columns?.map((c) => ({ columnName: c })),
          },
          activate,
          transport,
        }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_view_validate',
    {
      title: '校验计算视图一致性',
      description:
        '双模式校验：target=design（默认）对可写包内**设计时对象**做「激活前校验」——把内容写到临时副本 _CHKTMP ' +
        '以触发服务端激活检查（CheckResult 带编译明细）后删除副本，**原对象的激活状态不受影响**；' +
        'target=runtime 对**已激活的运行时计算视图**做一致性校验（SYS.CHECK_CALCULATION_VIEW，需 schema+viewName，如 "_SYS_BIC" + "ZDEMO.ZDEMO_MKC/ZDEMO03_CV003"）。' +
        '激活前建议先 design 校验，激活后可用 runtime 校验复检；支持的动作清单用 hana_view_check_actions 查询。',
      inputSchema: z.object({
        target: z.enum(['design', 'runtime']).default('design')
          .describe('design=设计时对象激活前校验（packageId+objectName）；runtime=运行时视图一致性校验（schema+viewName）'),
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).optional()
          .describe('design 模式：目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).optional()
          .describe('design 模式：视图对象名（不含包名）'),
        schema: z.string().default('_SYS_BIC').describe('runtime 模式：运行时 schema，默认 _SYS_BIC（须在白名单内）'),
        viewName: z.string().optional().describe('runtime 模式：运行时视图名，形如 "ZDEMO.ZDEMO_MKC/ZDEMO03_CV003"（包路径/对象名）'),
        action: z.enum(['CHECK_CONSISTENCY']).default('CHECK_CONSISTENCY').describe('runtime 模式：校验动作（calculationview 仅支持 CHECK_CONSISTENCY）'),
      }),
      // design 模式会短暂写入临时校验对象（写后即删），不能标 readOnly
      annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
    },
    async ({ target, packageId, objectName, schema, viewName, action }) => {
      if (target === 'design') {
        if (!packageId || !objectName) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'design 模式需要 packageId 与 objectName（设计时对象激活前校验）。' }],
          };
        }
        const envelope: Envelope = await withErrorEnvelope(() =>
          checkCalculationViewDesignTime(ctx.config, packageId, objectName),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      }
      if (!viewName) {
        return {
          isError: true,
          content: [{ type: 'text', text: 'runtime 模式需要 viewName（形如 "ZDEMO.ZDEMO_MKC/ZDEMO03_CV003"）。' }],
        };
      }
      const envelope: Envelope = await withErrorEnvelope(() => validateCalculationView(ctx.pool, schema, viewName, action));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  reg(
    'hana_view_check_actions',
    {
      title: '查询校验过程支持的动作清单',
      description:
        '查询 SYS 下某 CHECK 过程支持的 ACTION 全集及说明（来源：SYS.GET_CHECK_ACTIONS）。' +
        '用于在调用 hana_view_validate 前确认可用的动作名，或了解 HANA 提供的表/目录一致性检查能力。' +
        '默认列出计算视图相关（CHECK_CALCULATION_VIEW）。',
      inputSchema: z.object({
        checkProcedureName: z.enum([
          'CHECK_CALCULATION_VIEW',
          'CHECK_CALCULATION_MODEL',
          'CHECK_ANALYTICAL_MODEL',
          'CHECK_CALCENGINE',
          'CHECK_CATALOG',
          'CHECK_TABLE_CONSISTENCY',
          'CHECK_TOPOLOGY_TREE',
          'CHECK_ES',
        ]).default('CHECK_CALCULATION_VIEW').describe('CHECK 过程名（默认 CHECK_CALCULATION_VIEW）'),
      }),
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ checkProcedureName }) => {
      const envelope: Envelope = await withErrorEnvelope(() => getCheckActions(ctx.pool, checkProcedureName));
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );
reg(
      'hana_view_activate',
      {
        title: '激活 Calculation View（设计时对象）',
        description:
          '将可写包下的 Calculation View 设计时对象激活为运行时列视图（XS REST：PUT + SapBackPack {"Activate":true}）。' +
          '激活前建议先用 hana_view_validate 校验；激活后可用 hana_metadata_get_view 读取定义、hana_data_preview 预览数据。' +
          '失败会透传编译错误明细（不误报成功）。安全约束：写操作包范围由 HANA_WRITE_PACKAGES 配置。',
        inputSchema: z.object({
          packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
          objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名（不含包名）'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
      },
      async ({ packageId, objectName }) => {
        const envelope: Envelope = await withErrorEnvelope(() =>
          activateCalculationView(ctx.config, ctx.pool, packageId, objectName, 'xs_rest'),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );

    reg(
      'hana_view_update',
      {
        title: '更新 Calculation View（声明式 operations 或全量 XML）',
        description:
          '更新已有 Calculation View，两种方式二选一（修改 CV 可零 XML）：' +
          '① operations（推荐）：声明式操作补丁，服务端读取当前定义并确定性变换后走原 PUT 更新路径——**无需读取也不生成任何 XML**。' +
          '当前支持 op=add_join：给视图追加一个 join（左侧=当前输出节点，右侧=源视图新 Projection；条件字段左右可不同名，' +
          '自动按 BW 同款「join 输入映射重命名」接线，如左 0MATERIAL = 右 ZDEMO_MAT；fields 缺省自动带出源视图可见新增字段）。' +
          '多条 operations 依序应用（可连续追加多个 join）。返回新增节点/字段明细与实测激活状态。' +
          '仅支持单输出链状视图（BW query 拼装链均满足）。' +
          '② xml：传入完整新设计时 XML 全量覆盖（复杂改造用；可先用 hana_metadata_get_view(format=xml) 读取再改，最小 diff）。' +
          'xml 方式写入前有服务端护栏（XML 可解析、根 scenario id 与对象名一致、logicalModel 指向真实节点——手工改 XML 两大高频事故激活前拦下），' +
          '通过后返回 xmlVerification 摘要（输出节点/字段数）供免回读自检。' +
          '两种方式都走 XS REST PUT + If-Match ETag 乐观锁：operations 模式在读取基线（设计时当前内容）时即捕获 ETag 全程持锁，' +
          'xml 模式缺省在写入时取当前 ETag；显式传 ifMatch 不一致（并发冲突）返回 isError 并提示重读最新版本。' +
          '实测边界：本服务器对合法模型「写入即激活」，返回的 activated 为写入后实测状态；新内容编译失败时对象保持旧激活版本，明细在 activationErrors。' +
          '安全约束：写操作包范围由 HANA_WRITE_PACKAGES 配置。',
        inputSchema: z.object({
          packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
          objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名（不含包名）'),
          xml: z.string().min(1).optional()
            .describe('方式一：新的完整设计时 XML 全量覆盖（与 operations 二选一；常规加 join/加字段类修改优先用 operations）'),
          operations: z.array(
            z.object({
              op: z.literal('add_join').describe('操作类型：追加一个 join'),
              sourcePackageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/)
                .describe('join 源视图的包名（只读即可，无需可写），如 system-local.bw.bw2hana.query.zdemo01r014'),
              sourceObjectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/)
                .describe('join 源视图对象名（不含包名），如 ZDEMO01R014_Q017'),
              joinType: z.enum(['inner', 'leftOuter', 'rightOuter', 'fullOuter']).default('leftOuter')
                .describe('join 类型，默认 leftOuter'),
              conditions: z.array(z.object({
                leftField: z.string().min(1).describe('当前视图输出节点上的字段（必须已存在）'),
                rightField: z.string().min(1).describe('源视图上的字段（可与左侧不同名，自动重命名接线）'),
              })).min(1).max(10)
                .describe('join 条件（1~10 组）；例：[{leftField:"0MATERIAL", rightField:"ZDEMO_MAT"}]'),
              fields: z.array(z.string()).max(100).optional()
                .describe('要透出到输出的源视图字段；缺省=自动带出全部可见新增属性（推荐省略）'),
            }),
          ).min(1).max(10).optional()
            .describe('方式二（推荐）：声明式操作补丁（与 xml 二选一）；服务端确定性变换，模型零 XML'),
          ifMatch: z.string().optional().describe('乐观锁 ETag；省略=自动取当前版本的 ETag'),
          activate: z.boolean().default(false).describe('true=更新后立即激活；false=仅更新设计时对象'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
      },
      async ({ packageId, objectName, xml, operations, ifMatch, activate }) => {
        if (!xml && !(operations && operations.length > 0)) {
          return {
            isError: true,
            content: [{ type: 'text', text: '需要提供 xml（全量 XML 更新）或 operations（声明式操作补丁，推荐）之一。' }],
          };
        }
        const envelope: Envelope = await withErrorEnvelope(() =>
          updateCalculationView(ctx.config, ctx.pool, packageId, objectName, { xml, operations }, { ifMatch, activate }),
        );
        // 乐观锁冲突（显式 If-Match 与服务端不符）：硬错误 isError + 重读提示
        const rawCode = (envelope.raw as { code?: string } | undefined)?.code;
        if (envelope.success === false && rawCode === '412') {
          return mcpErrorText(
            '更新冲突：对象已被他人修改（版本乐观锁 If-Match 不匹配）。',
            '请先用 hana_metadata_get_view(packageId, objectName, format=xml) 重读最新内容，基于新版本修改后重试',
          );
        }
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );

    reg(
      'hana_view_delete',
      {
        title: '删除 Calculation View（设计时对象）',
        description:
          '删除可写包下的 Calculation View 设计时对象（XS REST：DELETE）。删除前建议用 hana_metadata_where_used 查看被谁引用，' +
          '删除会造成依赖方失效。删除后对象从 hana_metadata_search_objects / hana_package_list_objects 消失。' +
          '安全约束：写操作包范围由 HANA_WRITE_PACKAGES 配置。',
        inputSchema: z.object({
          packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
          objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名（不含包名）'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
      },
      async ({ packageId, objectName }) => {
        const envelope: Envelope = await withErrorEnvelope(() =>
          deleteCalculationView(ctx.config, packageId, objectName),
        );
        return {
          content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
          structuredContent: envelope,
        };
      },
    );
}