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
import { registerVisibleTool, registerWriteTool, type ToolContext } from './index.js';
import type { Envelope } from '../types/hana.js';
import { DEFAULT_PROBE_ROWS, MAX_PROBE_ROWS } from '../services/repository.service.js';

/**
 * SQL 模式输出列的 zod 片段（create 的 scriptColumns 与 update 的 set_script.columns **共用一份**）：
 * 各写一份时，任一侧改约束（上限/新增字段）都会让同一份列清单在 create 能过、在 update 被拒。
 */
const SCRIPT_COLUMN_SCHEMA = z.object({
  name: z.string().min(1).max(128).describe('输出列别名（与脚本 SELECT 的别名一致）'),
  dataType: z.string().min(1).max(60)
    .describe('HANA 数据类型，如 NVARCHAR / DECIMAL(15,2) / INTEGER / DATE（精度写在类型内）'),
  length: z.number().int().min(1).max(2147483647).optional()
    .describe('字符型长度（NVARCHAR/VARCHAR/ALPHANUM/CHAR 必填：该声明会用于生成输出类型，缺了会激活失败）'),
  isMeasure: z.boolean().optional().describe('true=度量列（进 baseMeasures 聚合）；缺省=属性列'),
  aggregationType: z.string().max(30).optional().describe('度量聚合方式（默认 sum，如 sum/count/min/max）'),
  description: z.string().max(200).optional().describe('中文描述（缺省取列名）'),
});

export function registerModelingTools(server: McpServer, ctx: ToolContext): void {
  const reg = registerVisibleTool(server, ctx);
  // 写工具一律经预检闸门注册：判定不通过时在 handler 之前拦截，不进 service（见 tools/index.ts）
  const regWrite = registerWriteTool(server, ctx);
  regWrite(
    'hana_view_create',
    {
      title: '新建 Calculation View（计算视图）',
      description:
        '在仓库中新建一个 Calculation View（计算视图）。两种形态（mode 二选一）：\n' +
        '① mode=projection（默认）：图形化最小形态 = 单个 Projection 节点 + 单个表/视图数据源（全列透传）；\n' +
        '② mode=sql：**SQL 模式**（Scripted Calculation View）= 单个 SqlScriptView 节点承载整段 SQL。**推荐用于任何"按 SQL 建视图"的需求**' +
        '——服务端按本环境方言（SCRIPT_BASED + <definition> + viewAttribute 显式 datatype/length）生成正确 XML，模型**零 XML**；' +
        '只需给 script（写普通查询即可，服务端自动包成 `BEGIN VAR_OUT = <查询>; END` 过程体；也可直接给完整 BEGIN…END 过程体）与 ' +
        'scriptColumns（输出列清单，含类型——**它决定 HANA 为输出变量 VAR_OUT 生成的表类型**，缺 datatype/length 会生成空表类型而激活失败，故必填）。\n' +
        'SQL 约定（避免常见坑）：① 表名写**全限定名**（SCHEMA."表"），不要依赖默认 schema；② 输出列的 name 必须与脚本 SELECT 的列别名一致；' +
        '③ 至少一个数值列标 isMeasure=true（本环境激活要求 ≥1 度量，否则 40117）；④ 脚本里建议用 CAST(... AS <类型>) 把输出列类型钉死，' +
        '与 scriptColumns 的 dataType/length 保持一致（声明类型与脚本实际类型不一致会激活失败）；⑤ Oracle 的 CONNECT BY 层级查询改写为 HANA 泛型 ' +
        'HIERARCHY(...) 时：SOURCE 列别名取 NODE_ID/PARENT_ID，START WHERE 用**原始列名**，输出列用 **SOURCE 别名**（不是 HIERARCHY_NODE_ID），' +
        '标量子查询取反向边要包 MAX() 防多行。\n' +
        '安全约束：写操作的可写包范围由 mcp.json 的 HANA_WRITE_PACKAGES 配置（仅配置包及其子包可写；**留空=未配置边界，写工具会被闸门拒绝**）；同名对象已存在时拒绝覆盖' +
        '（并发同名创建在服务端按对象串行化，后到者显式报并发冲突，不会静默覆盖前者）。\n' +
        '流程：校验包名/对象名 → 检查对象不存在 → 取源列或校验脚本列 → 生成设计时 XML → 写入仓库（XS REST PUT）→（可选）显式激活 →（可选）行探测。\n' +
        '实测边界（SPS08）：①激活要求视图至少 1 个度量 → 默认 SUM_NUMERIC（数值列聚合 sum），ALL_ATTRIBUTES（无度量）激活会被 40117 拒绝；' +
        '②本服务器对合法模型「写入即激活」，activate=false 不保证 inactive——返回的 activated 为写入后实测状态' +
        '（激活失败的对象才是 inactive，错误明细在 activationErrors，完整明细见 activationDetail：无需再调 validate 即可看到 DDL 全文）。' +
        '③probeRows（默认 10）在激活成功后回探测前 N 行：**0 行会附带排查提示**，避免"激活成功 = 逻辑正确"的误判（0 行常见根因是键值补零格式、' +
        '号码列选错、数据在另一个表/分区）。\n' +
        '写后可用 hana_view_validate(target=design) 做无副作用激活前校验、hana_data_preview 预览（含基表勘察模式）、hana_metadata_* 查看字段。' +
        'transports：xs_rest=XS REST 官方写路径（默认，推荐）；repo_rest=走 SYS.REPOSITORY_REST（Studio 同款，部分环境写会 40106）；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT（兜底，需 Studio 手工激活，非官方支持）。',
      inputSchema: z.object({
        packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内（如 ZDEMO 或 ZDEMO.SUB）'),
        objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('新视图对象名（不含包名），如 ZDEMO_CV_TEST001'),
        description: z.string().max(200).optional().describe('视图描述（默认取对象名）'),
        mode: z.enum(['projection', 'sql']).default('projection')
          .describe('视图形态：projection=图形化最小形态（单 Projection + 单源表，需 sourceSchema/sourceName）；sql=SQL 模式（单 SqlScriptView，需 script + scriptColumns）'),
        sourceSchema: z.string().optional().describe('mode=projection：源表/视图所在 schema，如 SAPABAP1（须在白名单内）'),
        sourceName: z.string().optional().describe('mode=projection：源表/视图名，如某可访问的表'),
        script: z.string().min(1).max(100000).optional()
          .describe('mode=sql：SQL 脚本正文（表名写全限定名 SCHEMA."表"；输出列别名须与 scriptColumns 的 name 一致）'),
        scriptColumns: z.array(SCRIPT_COLUMN_SCHEMA).max(600).optional()
          .describe('mode=sql：输出列清单（顺序即输出顺序；datatype 必填——无法从 SQL 文本推断）'),
        measureMode: z.enum(['SUM_NUMERIC', 'ALL_ATTRIBUTES']).default('SUM_NUMERIC')
          .describe('mode=projection 的度量策略：SUM_NUMERIC=数值列进 baseMeasures 聚合 sum（默认，本环境激活要求 ≥1 度量）；ALL_ATTRIBUTES=全部列当属性（无度量，仅能保存 inactive，激活会被拒绝）'),
        activate: z.boolean().default(false).describe('true=写入后立即尝试激活（repo_rest 通道）；false=仅写设计时对象'),
        transport: z.enum(['repo_rest', 'xs_rest', 'inactive_object']).default('xs_rest')
          .describe('传输通道：xs_rest=XS REST 官方写路径（默认，推荐）；repo_rest=裸 SYS.REPOSITORY_REST（部分环境写会 40106）；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT（兜底，需手工激活）'),
        columns: z.array(z.string()).max(600).optional().describe('mode=projection：要映射的列名清单；省略=源表全列（自动按类型区分属性/度量）'),
        probeRows: z.number().int().min(0).max(MAX_PROBE_ROWS).default(DEFAULT_PROBE_ROWS)
          .describe('激活成功后探测的行数上限（0=不探测）：让"0 行"当场可见，返回 rowProbe（含 emptyHint 排查提示）'),
      }),
      annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
    },
    async ({ packageId, objectName, description, mode, sourceSchema, sourceName, script, scriptColumns, measureMode, activate, transport, columns, probeRows }) => {
      // mode=sql 与 mode=projection 的必填项不同：在 handler 里给明确的可恢复错误（schema 层做不出条件必填）
      if (mode === 'sql' && (!script || !scriptColumns || scriptColumns.length === 0)) {
        return mcpErrorText(
          'mode=sql 需要同时提供 script（SQL 脚本）与 scriptColumns（输出列清单，含 dataType）。',
          '输出列的类型无法从 SQL 文本推断，必须逐个给出；若只想按源表全列透传，请改用 mode=projection',
        );
      }
      if (mode === 'projection' && (!sourceSchema || !sourceName)) {
        return mcpErrorText(
          'mode=projection 需要提供 sourceSchema 与 sourceName。',
          '若目标是按 SQL 逻辑建模，请改用 mode=sql（给 script + scriptColumns）',
        );
      }
      const envelope: Envelope = await withErrorEnvelope(() =>
        createCalculationView(ctx.config, ctx.pool, {
          packageId,
          objectName,
          description,
          mode,
          ...(mode === 'sql'
            ? { scripted: { script: script!, columns: scriptColumns! } }
            : {
                source: {
                  schema: sourceSchema!,
                  name: sourceName!,
                  measureMode,
                  columns: columns?.map((c) => ({ columnName: c })),
                },
              }),
          activate,
          transport,
          probeRows,
        }),
      );
      return {
        content: [{ type: 'text', text: JSON.stringify(envelope, null, 2) }],
        structuredContent: envelope,
      };
    },
  );

  regWrite(
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
regWrite(
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

    regWrite(
      'hana_view_update',
      {
        title: '更新 Calculation View（声明式 operations 或全量 XML）',
        description:
          '更新已有 Calculation View，两种方式二选一（修改 CV 可零 XML）：' +
          '① operations（推荐）：声明式操作补丁，服务端读取当前定义并确定性变换后走原 PUT 更新路径——**无需读取也不生成任何 XML**。' +
          '支持两类操作（可混用，按序应用）：' +
          'op=add_join（追加一个 join：左侧=当前输出节点，右侧=源视图新 Projection；条件字段左右可不同名，' +
          '自动按 BW 同款「join 输入映射重命名」接线，如左 0MATERIAL = 右 ZDEMO_MAT；fields 缺省自动带出源视图可见新增字段；仅支持单输出链状视图）；' +
          'op=set_script（替换 **SQL 模式视图**的脚本正文与输出列清单：脚本改写、增删输出列都走这条，服务端重建 <definition>、' +
          '节点的 viewAttributes（含 datatype/length）与 logicalModel 输出段；非 SQL 模式视图会明确报错）。' +
          '返回每条操作的应用明细（新增节点/字段、脚本字节数变化）与实测激活状态。' +
          '② xml：传入完整新设计时 XML 全量覆盖（复杂改造用；可先用 hana_metadata_get_view(format=xml) 读取再改，最小 diff）。' +
          'xml 方式写入前有服务端护栏（XML 可解析、根 scenario id 与对象名一致、logicalModel 指向真实节点——手工改 XML 两大高频事故激活前拦下），' +
          '通过后返回 xmlVerification 摘要（输出节点/字段数）供免回读自检。' +
          '两种方式都走 XS REST PUT + If-Match ETag 乐观锁：ETag 基线统一在**请求入口**捕获（读时取），' +
          '到写入之间的任何并发写入都会使基线失效，冲突以 HTTP 412 显式返回（isError + 重读提示），不会静默覆盖他人改动；' +
          '需要跨调用强一致（例如基于更早一次读取的内容）时显式传 ifMatch。' +
          '实测边界：本服务器对合法模型「写入即激活」，返回的 activated 为写入后实测状态；新内容编译失败时对象保持旧激活版本，' +
          '明细在 activationErrors，**完整明细（含 DDL 全文）在 activationDetail——无需再调 hana_view_validate 拿全错误**。' +
          'probeRows（默认 10）在激活成功后回探测前 N 行，0 行会附带排查提示（键值补零 / 号码列语义 / 数据所在表与分区）。' +
          '安全约束：写操作包范围由 HANA_WRITE_PACKAGES 配置。',
        inputSchema: z.object({
          packageId: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
          objectName: z.string().regex(/^[A-Za-z0-9_.\-]+$/).describe('视图对象名（不含包名）'),
          xml: z.string().min(1).optional()
            .describe('方式一：新的完整设计时 XML 全量覆盖（与 operations 二选一；常规加 join / 改 SQL 优先用 operations）'),
          operations: z.array(
            z.discriminatedUnion('op', [
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
              z.object({
                op: z.literal('set_script').describe('操作类型：替换 SQL 模式视图（SqlScriptView）的脚本与输出列'),
                script: z.string().min(1).max(100000)
                  .describe('新 SQL 查询（表名写全限定名 SCHEMA."表"；输出列别名须与 columns 的 name 一致）。服务端自动包成 BEGIN VAR_OUT = <查询>; END 过程体；也可直接给完整 BEGIN…END 过程体'),
                columns: z.array(SCRIPT_COLUMN_SCHEMA).min(1).max(600)
                  .describe('新的输出列清单（**整体替换**旧输出：脚本一换输出列集合通常也变，逐列增补会留下旧列导致激活失败）'),
              }),
            ]),
          ).min(1).max(10).optional()
            .describe('方式二（推荐）：声明式操作补丁（与 xml 二选一）；服务端确定性变换，模型零 XML'),
          ifMatch: z.string().optional().describe('乐观锁 ETag；省略=自动取当前版本的 ETag'),
          activate: z.boolean().default(false).describe('true=更新后立即激活；false=仅更新设计时对象'),
          probeRows: z.number().int().min(0).max(MAX_PROBE_ROWS).default(DEFAULT_PROBE_ROWS)
            .describe('激活成功后探测的行数上限（0=不探测）：让"0 行"当场可见（返回 rowProbe 含 emptyHint 排查提示）'),
        }),
        annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
      },
      async ({ packageId, objectName, xml, operations, ifMatch, activate, probeRows }) => {
        if (!xml && !(operations && operations.length > 0)) {
          return {
            isError: true,
            content: [{ type: 'text', text: '需要提供 xml（全量 XML 更新）或 operations（声明式操作补丁，推荐）之一。' }],
          };
        }
        const envelope: Envelope = await withErrorEnvelope(() =>
          updateCalculationView(ctx.config, ctx.pool, packageId, objectName, { xml, operations }, { ifMatch, activate, probeRows }),
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

    regWrite(
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