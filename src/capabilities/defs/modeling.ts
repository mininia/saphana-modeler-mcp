/**
 * 建模域（`category: 'modeling'`）的清单条目。
 *
 * 六个入口（顺序 = 注册顺序）：视图的新建/校验/校验动作查询/激活/更新/删除。
 * 除只读的 hana_view_check_actions（gate=none）外均为写工具，gate=preflight 并声明 effects.plan；
 * 可写包范围由 HANA_WRITE_PACKAGES 决定。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { buildViewOpCapabilities } from './view-ops.js';
import { zObjectName, zPackageId, zWritePackageId } from '../schemas.js';
import { tagResource } from '../resources.js';
import {
  planTaskCancel,
  planViewActivate,
  planViewCheckActions,
  planViewCreate,
  planViewDelete,
  planViewUpdate,
  planViewValidate,
} from '../planners.js';
import { DEFAULT_PROBE_ROWS, MAX_PROBE_ROWS } from '../../services/repository.service.js';
import { MIGRATION_DECLARATIONS } from '../../services/migrate.rules.js';
import { CHANGESET_MAX_ACTIONS } from '../../services/changeset.plan.js';

/**
 * `migration.strategy` 的合法值取自**单一事实源** migrate.rules.ts（它导出运行时常量数组，
 * 头注明确要求「工具层/defs 的枚举校验从这里取，不要手抄第二份」）：schema 的 describe 与
 * tool handler 的中文硬错误引用同一份，不各存一份字面量清单。
 * 为什么是宽松 schema + handler 硬错误（SSD §1.6）：z.enum 会把非法值丢给 SDK 协议层
 * （英文报错、合法值也不可见）——先例为 health 工具的 checks/sections。
 */
export const DELETE_MIGRATION_DECLARATIONS = MIGRATION_DECLARATIONS.filter(
  // delete 通道没有可自动化的迁移策略：合法值 = 声明全集里的「显式承担」一项。
  // 从全集**派生**而非手抄字面量；类型谓词同时是编译期护栏——migrate.rules 改名/删除该取值时，
  // 这里先报错，而不是静默漂移成一份空清单（宽松 schema 下空清单会把所有声明全拒）。
  (d): d is 'acknowledge_dependents' => d === 'acknowledge_dependents',
);

/**
 * SQL 模式输出列的 zod 片段（create 的 scriptColumns 与 update 的 set_script.columns **共用一份**）：
 * 各写一份时，任一侧改约束（上限/新增字段）都会让同一份列清单在 create 能过、在 update 被拒。
 */
const SCRIPT_COLUMN_SCHEMA = z.object({
  name: z.string().min(1).max(128).describe('输出列别名（与脚本 SELECT 的别名一致）'),
  dataType: z
    .string()
    .min(1)
    .max(60)
    .describe('HANA 数据类型，如 NVARCHAR / DECIMAL(15,2) / INTEGER / DATE（精度写在类型内）'),
  length: z
    .number()
    .int()
    .min(1)
    .max(2147483647)
    .optional()
    .describe('字符型长度（NVARCHAR/VARCHAR/ALPHANUM/CHAR 必填：该声明会用于生成输出类型，缺了会激活失败）'),
  isMeasure: z.boolean().optional().describe('true=度量列（进 baseMeasures 聚合）；缺省=属性列'),
  aggregationType: z.string().max(30).optional().describe('度量聚合方式（默认 sum，如 sum/count/min/max）'),
  description: z.string().max(200).optional().describe('中文描述（缺省取列名）'),
});

// ── create 通道的字段片段（P7 起同时供 changeset 的 create 动作用）────────────
//
// **单点定义**：hana_view_create 的顶层 schema 与 hana_view_update 的 changeset 动作（create 专用
// description/mode/source/scripted）都从这里取字段 schema——不在两处各写一份平行定义（改约束只改这里，
// 两处同步）。片段本体**不带 .optional()/.default()**：可选性与默认值由各使用处决定（create 顶层参数
// 大多可选、模式决定必填；动作里 source.schema/name 在 source 出现时必须成对给出，与 ChangesetAction 同形）。

/** 视图描述（create 顶层与 changeset create 动作共用；describe 文案两处同义，保持逐字一致） */
const VIEW_DESCRIPTION_FIELD = z.string().max(200).describe('视图描述（默认取对象名）');

/** 视图形态（projection/sql） */
const VIEW_MODE_ENUM = z
  .enum(['projection', 'sql'])
  .describe(
    '视图形态：projection=图形化最小形态（单 Projection + 单源表，需 sourceSchema/sourceName）；sql=SQL 模式（单 SqlScriptView，需 script + scriptColumns）',
  );

/** 源表/视图所在 schema（不含资源标签——标签由 create 顶层的使用处包在最外层） */
const VIEW_SOURCE_SCHEMA_FIELD = z
  .string()
  .describe('mode=projection：源表/视图所在 schema，如 SAPABAP1（须在白名单内）');

/** 源表/视图名 */
const VIEW_SOURCE_NAME_FIELD = z.string().describe('mode=projection：源表/视图名，如某可访问的表');

/** 度量策略 */
const VIEW_MEASURE_MODE_ENUM = z
  .enum(['SUM_NUMERIC', 'ALL_ATTRIBUTES'])
  .describe(
    'mode=projection 的度量策略：SUM_NUMERIC=数值列进 baseMeasures 聚合 sum（默认，本环境激活要求 ≥1 度量）；ALL_ATTRIBUTES=全部列当属性（无度量，仅能保存 inactive，激活会被拒绝）',
  );

/** SQL 脚本正文 */
const VIEW_SCRIPT_FIELD = z
  .string()
  .min(1)
  .max(100000)
  .describe('mode=sql：SQL 脚本正文（表名写全限定名 SCHEMA."表"；输出列别名须与 scriptColumns 的 name 一致）');

/** SQL 模式输出列清单（数组本体，可选性由使用处决定；与 SCRIPT_COLUMN_SCHEMA 配套） */
const VIEW_SCRIPT_COLUMNS_FIELD = z
  .array(SCRIPT_COLUMN_SCHEMA)
  .max(600)
  .describe('mode=sql：输出列清单（顺序即输出顺序；datatype 必填——无法从 SQL 文本推断）');

/** projection 模式要映射的列名清单 */
const VIEW_COLUMNS_FIELD = z
  .array(z.string())
  .max(600)
  .describe('mode=projection：要映射的列名清单；省略=源表全列（自动按类型区分属性/度量）');

/**
 * 声明式操作补丁（add_join / set_script / set_description）的 schema 片段：hana_view_update 的单对象通道与 changeset
 * 动作里的 update **共用同一份**——两处各写一份时，改一个 op 的约束必然漂移（单对象能过、批内被拒，
 * 或反之）；可选性与 describe 由各使用处加。
 */
const VIEW_UPDATE_OPERATIONS_SCHEMA = z
  .array(
    z.discriminatedUnion('op', [
      z.object({
        op: z.literal('add_join').describe('操作类型：追加一个 join'),
        sourcePackageId: zPackageId(
          'join 源视图的包名（只读即可，无需可写），如 system-local.bw.bw2hana.query.zdemo01r014',
        ),
        sourceObjectName: zObjectName('join 源视图对象名（不含包名），如 ZDEMO01R014_Q017'),
        joinType: z
          .enum(['inner', 'leftOuter', 'rightOuter', 'fullOuter'])
          .default('leftOuter')
          .describe('join 类型，默认 leftOuter'),
        conditions: z
          .array(
            z.object({
              leftField: z.string().min(1).describe('当前视图输出节点上的字段（必须已存在）'),
              rightField: z.string().min(1).describe('源视图上的字段（可与左侧不同名，自动重命名接线）'),
            }),
          )
          .min(1)
          .max(10)
          .describe('join 条件（1~10 组）；例：[{leftField:"0MATERIAL", rightField:"ZDEMO_MAT"}]'),
        fields: z
          .array(z.string())
          .max(100)
          .optional()
          .describe('要透出到输出的源视图字段；缺省=自动带出全部可见新增属性（推荐省略）'),
      }),
      z.object({
        op: z.literal('set_script').describe('操作类型：替换 SQL 模式视图（SqlScriptView）的脚本与输出列'),
        script: z
          .string()
          .min(1)
          .max(100000)
          .describe(
            '新 SQL 查询（表名写全限定名 SCHEMA."表"；输出列别名须与 scriptColumns 的 name 一致）。服务端自动包成 BEGIN VAR_OUT = <查询>; END 过程体；也可直接给完整 BEGIN…END 过程体',
          ),
        // 与 hana_view_create 的 scriptColumns **同名同义**（P10-c c2 统一）：都是"SQL 模式的输出列清单"，
        // 且共用同一份 SCRIPT_COLUMN_SCHEMA。曾叫 columns——与 create 路径同一概念两个名字。
        scriptColumns: z
          .array(SCRIPT_COLUMN_SCHEMA)
          .min(1)
          .max(600)
          .describe('新的输出列清单（**整体替换**旧输出：脚本一换输出列集合通常也变，逐列增补会留下旧列导致激活失败）'),
      }),
      z.object({
        op: z.literal('set_description').describe('操作类型：修改视图描述/显示名（只动展示属性，不碰结构、非破坏）'),
        // 两个字段指向**同一个** XML 锚点（根 <descriptions defaultDescription>，见 model/view-edit.ts 的
        // setDescriptionInViewXml 头注）：至少给一个；两个都给且不一致会被服务端以中文业务错误拒绝。
        description: z
          .string()
          .max(200)
          .optional()
          .describe('视图描述（与 displayName 同锚点；两个都给须一致；置空串 = 清空描述）'),
        displayName: z
          .string()
          .max(200)
          .optional()
          .describe('显示名/Label（与 description 同锚点；两个都给须一致，至少给一个）'),
      }),
      z.object({
        op: z.literal('rename_field').describe('操作类型：改输出字段名（只动输出别名，节点列与接线不动）'),
        field: z.string().min(1).max(128).describe('当前输出字段 id（logicalModel 的名称，如 AMOUNT）'),
        newName: z.string().min(1).max(127).describe('新输出名（字母/数字/下划线；不得与既有输出字段重名）'),
      }),
      z.object({
        op: z.literal('drop_field').describe('操作类型：删输出字段（节点列不动；删后须仍有 ≥1 度量）'),
        field: z.string().min(1).max(128).describe('要删除的输出字段 id'),
      }),
      z.object({
        op: z.literal('add_calculated_column').describe('操作类型：新增计算列（节点上写公式，并映射为输出属性）'),
        name: z.string().min(1).max(127).describe('新列名（不得与节点列或既有输出字段重名）'),
        formula: z
          .string()
          .min(1)
          .max(4000)
          .describe(
            '计算表达式（COLUMN_ENGINE 方言：引用同节点列写 "列名"，如 if("AMOUNT" > 1000, \'HIGH\', \'LOW\')）',
          ),
        datatype: z
          .string()
          .min(1)
          .max(32)
          .describe('结果类型（HANA 类型名，如 VARCHAR / NVARCHAR / INTEGER / DECIMAL(15,2)）'),
        length: z.string().max(16).optional().describe('类型长度（如 VARCHAR 的 10；datatype 已带 (n) 时省略）'),
        description: z.string().max(200).optional().describe('输出字段的中文描述（选填）'),
        node: z.string().max(128).optional().describe('挂载节点（缺省 = logicalModel 指向的输出节点）'),
      }),
      z.object({
        op: z
          .literal('set_attribute_filter')
          .describe('操作类型：给节点属性设置单值过滤器（including=true 只保留该值；false 排除该值）'),
        attribute: z.string().min(1).max(128).describe('要过滤的属性（必须是该节点已有的 viewAttribute）'),
        value: z.string().min(1).max(200).describe('过滤值（如 DELETED 或 X）'),
        including: z.boolean().default(false).describe('true=只保留该值；false（默认）=排除该值'),
        node: z.string().max(128).optional().describe('所在节点（缺省 = 输出节点）'),
      }),
      z.object({
        op: z.literal('set_variable').describe('操作类型：修改已有输入参数（描述 / 默认值 / 是否必填）'),
        variableId: z.string().min(1).max(128).describe('变量 id（必须已存在；新建变量走 xml 全量通道）'),
        defaultValue: z.string().max(4000).optional().describe('新默认值（variableProperties/@defaultValue）'),
        description: z
          .string()
          .max(200)
          .optional()
          .describe('参数描述（variable 下 <descriptions> 的 defaultDescription）'),
        mandatory: z.boolean().optional().describe('是否必填（true = 调用方必须传参）'),
      }),
    ]),
  )
  .min(1)
  .max(10);

/**
 * 变更集动作（P7，SSD §6.1）：形状**镜像** `src/services/changeset.plan.ts` 的 `ChangesetAction`——
 * 枚举值、字段名、可选性以那边为准（handler 会把解析结果直接交给 applyChangeset，形状不一致即编译不过）。
 * create 专用字段（description/mode/source/scripted）复用 hana_view_create 的字段片段，不另写平行 schema。
 * `source` 的列形状（columnName/dataTypeName 对象）与 create 顶层入参（列名字符串数组）**不同**：
 * 后者是工具面的人性化写法（服务端再映射），前者是 ChangesetAction 的内部形状——此处按后者镜像。
 */
const CHANGESET_ACTION_SCHEMA = z.object({
  action: z
    .enum(['update', 'create', 'delete'])
    .describe(
      '动作类型：update=更新已有对象（xml/operations 二选一）；create=新建（同 hana_view_create）；delete=删除',
    ),
  packageId: zPackageId('动作目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
  objectName: zObjectName('动作目标对象名（不含包名）'),
  xml: z.string().min(1).optional().describe('action=update 专用：新的完整设计时 XML 全量覆盖（与 operations 二选一）'),
  operations: VIEW_UPDATE_OPERATIONS_SCHEMA.optional().describe(
    'action=update 专用：声明式操作补丁（与 xml 二选一），与顶层 operations 同义',
  ),
  migration: z
    .object({
      // 与顶层通道同一口径（SSD §1.6）：宽松 z.string() + 调用时中文硬错误列合法值；
      // 合法值**随 action 而定**（update=字段级策略∪显式承担；delete=仅显式承担；create 不接受该声明）。
      strategy: z
        .string()
        .describe(
          `破坏性声明的策略（合法值随动作而定——update：${MIGRATION_DECLARATIONS.join(' / ')}；` +
            `delete：${DELETE_MIGRATION_DECLARATIONS.join(' / ')}；create 不接受该声明；非法值在调用时以中文硬错误列出合法值）`,
        ),
      note: z.string().optional().describe('声明附注（仅随回执记录，不参与判定）'),
    })
    .optional()
    .describe(
      '破坏性动作的显式承担声明：破坏性动作（update/delete）各自未声明 ⇒ **整体预检在任何写入之前判完 ⇒ 整批拒绝、零写入、不发生补偿**' +
        '（机读码 migration_required，rawDetail.breaking 逐项列破坏点）；只有预检判不了（只读判定失败）而退化到执行期拒绝时，才走「停止 + 逆序补偿」',
    ),
  description: VIEW_DESCRIPTION_FIELD.optional(),
  mode: VIEW_MODE_ENUM.optional(),
  source: z
    .object({
      schema: VIEW_SOURCE_SCHEMA_FIELD,
      name: VIEW_SOURCE_NAME_FIELD,
      columns: z
        .array(
          z.object({
            columnName: z.string().min(1).max(128).describe('源表的列名'),
            dataTypeName: z
              .string()
              .optional()
              .describe('列数据类型名（用于属性/度量判定）；省略=服务端按源表列类型解析'),
          }),
        )
        .max(600)
        .optional()
        .describe('显式指定映射列；省略=源表全列（自动按类型区分属性/度量）'),
      measureMode: VIEW_MEASURE_MODE_ENUM.default('SUM_NUMERIC'),
    })
    .optional()
    .describe(
      'action=create + mode=projection 专用：源表/视图（与 hana_view_create 的 sourceSchema/sourceName/columns/measureMode 同义，此处按 source 对象组织）',
    ),
  scripted: z
    .object({
      script: VIEW_SCRIPT_FIELD,
      columns: VIEW_SCRIPT_COLUMNS_FIELD,
    })
    .optional()
    .describe(
      'action=create + mode=sql 专用：SQL 脚本与输出列（与 hana_view_create 的 script/scriptColumns 同义，此处按 scripted 对象组织）',
    ),
});

const baseModelingCapabilities = {
  hana_view_create: cap({
    id: 'hana_view_create',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewCreate, destructive: false, idempotent: false },
    title: '新建 Calculation View（计算视图）',
    // 瘦身（P9）：SQL 方言五条、实测边界与并发解释已整体搬进规则 sql_mode / activation_measure /
    // write_transport / write_receipt；这里只留两种形态的参数面、安全约束一句话与回执字段。
    description:
      '在仓库中新建一个 Calculation View。两种形态（mode 二选一）：\n' +
      '① projection（默认）：图形化最小形态 = 单 Projection 节点 + 单源表全列透传——' +
      '需 sourceSchema/sourceName（可选 columns / measureMode）；\n' +
      '② **sql**：SQL 模式（Scripted Calculation View）——需 script + scriptColumns（输出列清单，含类型）。' +
      '**凡「按 SQL 建视图」一律用这个**，服务端按本环境方言生成 XML，模型零 XML。\n' +
      '安全约束：可写包范围由 HANA_WRITE_PACKAGES 配置（留空=拒写 boundary_off）；同名对象已存在时拒绝覆盖。\n' +
      '参数：transport（xs_rest=默认，推荐 / repo_rest / inactive_object）、activate（本 SPS 写入即激活，' +
      '该参数只决定激活失败是否透出）、probeRows（默认 10）。\n' +
      '回执：activated（写入后实测状态）、activationErrors / activationDetail（激活失败完整明细含 DDL 全文，' +
      '无需再调 hana_view_validate）、rowProbe（含 0 行排查提示）。\n' +
      'SQL 方言、scriptColumns↔VAR_OUT 与 ≥1 度量要求、通道差异见 rules=sql_mode,activation_measure,write_transport,write_receipt。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内（如 ZDEMO 或 ZDEMO.SUB）'),
      objectName: zObjectName('新视图对象名（不含包名），如 ZDEMO_CV_TEST001'),
      description: VIEW_DESCRIPTION_FIELD.optional(),
      mode: VIEW_MODE_ENUM.default('projection'),
      sourceSchema: tagResource(VIEW_SOURCE_SCHEMA_FIELD.optional(), 'readSchema'),
      sourceName: VIEW_SOURCE_NAME_FIELD.optional(),
      script: VIEW_SCRIPT_FIELD.optional(),
      scriptColumns: VIEW_SCRIPT_COLUMNS_FIELD.optional(),
      measureMode: VIEW_MEASURE_MODE_ENUM.default('SUM_NUMERIC'),
      activate: z
        .boolean()
        .default(false)
        .describe(
          'xs_rest（默认）实测写入即激活（本参数只决定激活失败是否透出）；非 xs_rest 写入不激活：true=写后尝试激活，false 时 inactive_object 需手工激活',
        ),
      transport: z
        .enum(['repo_rest', 'xs_rest', 'inactive_object'])
        .default('xs_rest')
        .describe(
          '传输通道：xs_rest=XS REST 官方写路径（默认，推荐）；repo_rest=裸 SYS.REPOSITORY_REST（部分环境写会 40106）；inactive_object=直写 _SYS_REPO.INACTIVE_OBJECT（兜底，需手工激活）',
        ),
      columns: VIEW_COLUMNS_FIELD.optional(),
      probeRows: z
        .number()
        .int()
        .min(0)
        .max(MAX_PROBE_ROWS)
        .default(DEFAULT_PROBE_ROWS)
        .describe('激活成功后探测的行数上限（0=不探测）：让「0 行」当场可见，返回 rowProbe（含 emptyHint 排查提示）'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
  }),

  // hana_view_validate 的 design 模式会短暂写入临时校验对象 _CHKTMP，故整工具归 write；
  // 不按 design/runtime 模式做混合划分，只读部署不暴露此工具。
  hana_view_validate: cap({
    id: 'hana_view_validate',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewValidate, destructive: false, idempotent: true },
    title: '校验计算视图一致性',
    description:
      '双模式校验：target=design（默认）对可写包内**设计时对象**做「激活前校验」——把内容写到临时副本 _CHKTMP ' +
      '以触发服务端激活检查（CheckResult 带编译明细）后删除副本，**原对象的激活状态不受影响**；' +
      '临时对象名带短哈希（总长 ≤29），与真实对象重名时本次校验拒绝执行（不删不改）；' +
      'target=runtime 对**已激活的运行时计算视图**做一致性校验（SYS.CHECK_CALCULATION_VIEW，需 schema+viewName，如 「_SYS_BIC」 + 「ZDEMO.ZDEMO_MKC/ZDEMO03_CV003」）。' +
      '激活前建议先 design 校验，激活后可用 runtime 校验复检；支持的动作清单用 hana_view_check_actions 查询。',
    inputSchema: z.object({
      target: z
        .enum(['design', 'runtime'])
        .default('design')
        .describe(
          'design=设计时对象激活前校验（packageId+objectName）；runtime=运行时视图一致性校验（schema+viewName）',
        ),
      packageId: zPackageId('design 模式：目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内').optional(),
      objectName: zObjectName('design 模式：视图对象名（不含包名）').optional(),
      schema: z.string().default('_SYS_BIC').describe('runtime 模式：运行时 schema，默认 _SYS_BIC（须在白名单内）'),
      viewName: z
        .string()
        .optional()
        .describe('runtime 模式：运行时视图名，形如 "ZDEMO.ZDEMO_MKC/ZDEMO03_CV003"（包路径/对象名）'),
      action: z
        .enum(['CHECK_CONSISTENCY'])
        .default('CHECK_CONSISTENCY')
        .describe('runtime 模式：校验动作（calculationview 仅支持 CHECK_CONSISTENCY）'),
    }),
    // design 模式会短暂写入临时校验对象（写后即删），不能标 readOnly
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  }),

  // 归 modeling 而非 insights：它服务于校验流程（hana_view_validate 的前置动作清单），
  // 属"建模与仓库变更"的工作面；kind 随之为 write（校验工作流同档）。
  // 行为只读（SELECT SYS.GET_CHECK_ACTIONS），故显式声明叙述型规划器，不落写兜底。
  hana_view_check_actions: cap({
    id: 'hana_view_check_actions',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewCheckActions, destructive: false, idempotent: true },
    title: '查询校验过程支持的动作清单',
    description:
      '查询 SYS 下某 CHECK 过程支持的 ACTION 全集及说明（来源：SYS.GET_CHECK_ACTIONS）。' +
      '用于在调用 hana_view_validate 前确认可用的动作名，或了解 HANA 提供的表/目录一致性检查能力。' +
      '默认列出计算视图相关（CHECK_CALCULATION_VIEW）。',
    inputSchema: z.object({
      checkProcedureName: z
        .enum([
          'CHECK_CALCULATION_VIEW',
          'CHECK_CALCULATION_MODEL',
          'CHECK_ANALYTICAL_MODEL',
          'CHECK_CALCENGINE',
          'CHECK_CATALOG',
          'CHECK_TABLE_CONSISTENCY',
          'CHECK_TOPOLOGY_TREE',
          'CHECK_ES',
        ])
        .default('CHECK_CALCULATION_VIEW')
        .describe('CHECK 过程名（默认 CHECK_CALCULATION_VIEW）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_view_activate: cap({
    id: 'hana_view_activate',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewActivate, destructive: false, idempotent: false },
    title: '激活 Calculation View（设计时对象）',
    description:
      '将可写包下的 Calculation View 设计时对象激活为运行时列视图（XS REST：PUT + SapBackPack {"Activate":true}）。' +
      '并发改动以 412 机读回执暴露，不静默回退。' +
      '激活前建议先用 hana_view_validate 校验；激活后可用 hana_metadata_get_view 读取定义、hana_data_preview 预览数据。' +
      '失败会透传编译错误明细（不误报成功）。安全约束：写操作包范围由 HANA_WRITE_PACKAGES 配置。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
      objectName: zObjectName('视图对象名（不含包名）'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
  }),

  hana_view_update: cap({
    id: 'hana_view_update',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewUpdate, destructive: true, idempotent: false },
    title: '更新 Calculation View（声明式 operations / 全量 XML / 变更集）',
    // 瘦身（P9）：设计理由、方言、补偿细节与逐字段解释已整体搬进规则 write_receipt / sql_mode /
    // bw_dialect。硬保留（验收脚本断言）：三种方式与互斥、关键参数名、migration 四个合法值、
    // 机读码全集、回执字段名、零写入语义——这些是契约，不是解释。
    description:
      '更新已有 Calculation View，三种方式**三选一（互斥）**：\n' +
      '① operations（推荐）：声明式操作补丁 op=add_join / op=set_script，服务端读取当前定义并确定性变换后走原 PUT ' +
      '更新路径——模型**零 XML**，返回每条操作的应用明细与实测激活状态；\n' +
      '② xml：完整新设计时 XML 全量覆盖（复杂改造用；写入前有服务端护栏，通过后返回 xmlVerification 摘要）；\n' +
      '③ changeset：多对象变更集（动作上限 10，单次调用内闭合）——整体预检不通过则**整批拒绝、零写入**；' +
      '任一项失败即逆序补偿；partial=true 时逐项枚举状态（含 notExecuted），**绝不把部分完成包装成 success**。\n' +
      '①② 都走 XS REST PUT + If-Match ETag 乐观锁：基线读 → 内容读 → PUT 在同一锁临界区内完成（进程内按对象串行化）。\n' +
      '关键参数：ifMatch（乐观锁 ETag，省略=自动取；对基于更早读取的内容做覆盖时**必须显式传**）；activate；' +
      'probeRows（默认 10）；dryRun=true（只读预演：结构 diff + 影响半径 + 破坏性判定，**零写入**，回执带 mode=dryRun）；' +
      'migration.strategy（破坏性变更的显式承担声明，合法值 **cast / preserve_column / move / acknowledge_dependents**；' +
      '未声明 ⇒ migration_required 拒绝且零写入；声明只被记录，不触发任何自动迁移）。\n' +
      '机读码：412（乐观锁冲突，raw.conflict 带当前基线）/ OBJECT_NOT_FOUND / migration_required / ' +
      'changeset_partial / changeset_conflict / changeset_invalid。\n' +
      '回执：新基线 etag 与 etagSource、breaking、migration、rowProbe（0 行附排查提示）、changeset 的逐项 report' +
      '（etag/elapsedMs/状态）。\n' +
      '方言与细节见 rules=write_receipt,sql_mode,bw_dialect（hana_system_get_info(rules=write_receipt,sql_mode,bw_dialect)）。',
    inputSchema: z
      .object({
        // changeset 模式下这两个参数**被忽略**（批次目标由各 action 自带；applyChangeset 不消费顶层目标），
        // 故改为可选——否则合法批次必须填一对幽灵参数，填错还会把整批带到别的包边界上。
        // 非 changeset（xml/operations 单对象通道）时它们仍必填：由链尾的 superRefine 表达（schema 层硬错误，
        // 单对象通道的既有拒绝口径不变）。
        packageId: zWritePackageId(
          '目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内（changeset 模式下被忽略、仅供单对象通道使用——批次目标由各 action 的 packageId 承担）',
        ).optional(),
        objectName: zObjectName(
          '视图对象名（不含包名）（changeset 模式下被忽略、仅供单对象通道使用——批次目标由各 action 的 objectName 承担）',
        ).optional(),
        xml: z
          .string()
          .min(1)
          .optional()
          .describe(
            '方式一：新的完整设计时 XML 全量覆盖（与 operations 二选一；常规加 join / 改 SQL 优先用 operations）',
          ),
        operations: VIEW_UPDATE_OPERATIONS_SCHEMA.optional().describe(
          '方式二（推荐）：声明式操作补丁（与 xml 二选一）；服务端确定性变换，模型零 XML',
        ),
        changeset: z
          .object({
            actions: z
              .array(CHANGESET_ACTION_SCHEMA)
              .max(CHANGESET_MAX_ACTIONS)
              .describe(
                `多对象变更集的动作列表（上限 ${CHANGESET_MAX_ACTIONS}，与 operations 上限对齐）；每个动作自带 packageId/objectName`,
              ),
          })
          .optional()
          .describe(
            '方式三：多对象变更集（与 xml/operations 三选一）——单次调用内闭合：整体预检（含对象级读写集相交检测）→ 逐项执行 → 失败逆序补偿 → 诚实报告（partial=true 时逐项枚举状态）。长批次可加 async=true 走异步任务（立即返回 taskId，hana_task_get 轮询 / hana_task_cancel 取消）',
          ),
        ifMatch: z.string().optional().describe('乐观锁 ETag；省略=自动取当前版本的 ETag'),
        activate: z
          .boolean()
          .default(false)
          .describe(
            'true=更新后请求显式激活（失败 555+activationDetail）；false=不请求显式激活——实测写入即激活，本参数只决定失败是否透出',
          ),
        probeRows: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROBE_ROWS)
          .default(DEFAULT_PROBE_ROWS)
          .describe('激活成功后探测的行数上限（0=不探测）：让「0 行」当场可见（返回 rowProbe 含 emptyHint 排查提示）'),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            'true=只读预演（零写入）：读当前设计时定义 → 应用 operations/xml → 结构 diff → 影响半径 → 破坏性判定；不 PUT、不激活、不发 probe，回执带 mode=dryRun',
          ),
        async: z
          .boolean()
          .default(false)
          .describe(
            'true=**异步任务**（仅与 changeset 组合）：立即返回 taskId，批次在后台执行（整体预检 → 逐项执行 → 逆序补偿）；' +
              '用 hana_task_get 轮询、hana_task_cancel 取消。长批次（多项 × 每项 2–10s 激活）推荐用它避开客户端超时',
          ),
        migration: z
          .object({
            // 末尾的 acknowledge_dependents 与 hana_view_delete 同语义，是本通道的**显式承担**声明位：
            // 三种字段级策略都描述不了「整段回退/删数据源」这类变更，缺了它调用方只能声明假策略过关（污染审计记录）。
            // 刻意用 z.string() 而非 z.enum（SSD §1.6 的枚举契约）：非法值要落到 handler 的中文硬错误
            // 并列出合法值；用 z.enum 会在 SDK 协议层被拒（英文 "Invalid option..."，合法值也不可见）。
            // 合法值常量从 migrate.rules 导入（单一事实源），handler 硬错误引用同一常量。
            strategy: z
              .string()
              .describe(
                `迁移策略声明（合法值：${MIGRATION_DECLARATIONS.join(' / ')}；非法值在调用时以中文硬错误列出合法值）。` +
                  '两类语义：① 字段级迁移策略——cast=下游按新类型重铸、preserve_column=保列新建、move=随改名迁移' +
                  '（描述下游字段怎么迁）；② acknowledge_dependents=调用方**显式承担下游破坏、不做字段级迁移**的声明位' +
                  '（三种字段级策略都不适用时用它，如整段回退）；两类都只被记录，不触发任何自动迁移动作',
              ),
            note: z.string().optional().describe('声明附注（仅随回执记录，不参与判定）'),
          })
          .optional()
          .describe(
            '破坏性变更的显式承担声明：未声明 ⇒ 服务端拒绝且一次写都不发生（raw.errorDetail 带破坏项）；声明只被记录，不触发任何自动迁移动作',
          ),
      })
      .superRefine((val, ctx) => {
        // 「非 changeset 时 packageId/objectName 必填」的表达：用 superRefine 而不是两套 schema，
        // 单对象通道（xml/operations）缺参数时的行为与改前一致——仍是 schema 层硬错误、不进 handler。
        // changeset 模式下两者被忽略（批次目标由各 action 自带），故不再要求。
        if (val.changeset === undefined && (val.packageId === undefined || val.objectName === undefined)) {
          ctx.addIssue({
            code: 'custom',
            message:
              '非 changeset 模式下必须提供 packageId 与 objectName（xml/operations 单对象通道的目标对象）；' +
              'changeset 模式下这两个参数被忽略，请把目标写在各自的 action 上',
          });
        }
      }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
  }),

  hana_view_delete: cap({
    id: 'hana_view_delete',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewDelete, destructive: true, idempotent: false },
    title: '删除 Calculation View（设计时对象）',
    description:
      '删除可写包下的 Calculation View 设计时对象（XS REST：DELETE + If-Match）：陈旧基线 412、对象已不存在 OBJECT_NOT_FOUND（均机读），' +
      '回执带删除前 etag/version。**有下游引用时属破坏性变更**：须显式声明 migration.strategy=acknowledge_dependents 才放行，' +
      '未声明 ⇒ 拒绝且不删除（回执带破坏项与下游计数）。删除会造成依赖方失效（删前建议用 hana_metadata_where_used 查引用）；' +
      '安全约束：写操作包范围由 HANA_WRITE_PACKAGES 配置。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 配置的可写范围内'),
      objectName: zObjectName('视图对象名（不含包名）'),
      migration: z
        .object({
          // SSD §1.6：与 update 通道同款——z.string() 宽松 schema，非法值由 handler 中文硬错误列出合法值
          // （用 z.enum 会落到 SDK 协议层，英文报错且合法值不可见；先例：health 的 checks/sections）。
          strategy: z
            .string()
            .describe(
              `显式承担「有下游引用仍删除」：合法值 ${DELETE_MIGRATION_DECLARATIONS.join(' / ')}（该视图的下游依赖将失效）`,
            ),
          note: z.string().optional().describe('声明附注（仅随回执记录，不参与判定）'),
        })
        .optional()
        .describe('有下游引用（破坏性变更）时的显式承担声明：未声明 ⇒ 服务端拒绝且不删除（回执给破坏项与下游计数）'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: true },
  }),

  /*
   * 异步任务（工具化任务 API，2026-10-10）——服务于 hana_view_update 的长批次（changeset + async=true）。
   * 为什么归 modeling：它们不是通用调度设施，只承载建模写入流程的异步执行；也正因为如此，
   * 任务的能力面与写能力同域（只读档案看得到 hana_task_get、看不到 cancel——cancel 是 write）。
   */
  hana_task_get: cap({
    id: 'hana_task_get',
    category: 'modeling',
    kind: 'read',
    effects: { destructive: false, idempotent: true },
    title: '查询异步任务状态与结果',
    description:
      '轮询 hana_view_update(async=true) 提交的变更集任务：返回 status（working/completed/failed/cancelled）、进度与终态 result ' +
      '（与同步调用同形的回执信封：success=true 时 raw 无；失败时 raw.errorDetail 带逐项明细）。' +
      '只对**本调用方**的任务可见（他人任务与不存在的任务回同一句"未知任务"）；任务状态在进程内，服务重启即失效。',
    inputSchema: z.object({
      taskId: z.string().min(1).max(128).describe('任务 id（hana_view_update(async=true) 的回执里给出）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_task_cancel: cap({
    id: 'hana_task_cancel',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planTaskCancel, destructive: false, idempotent: true },
    title: '取消异步任务（协作式，动作边界生效）',
    description:
      '请求取消一个运行中的变更集任务：**当前动作不打断**，在本动作结束后停止后续项，并触发与失败相同的**逆序补偿**' +
      '（已执行项回到批前状态，终态 result 的 raw.code=changeset_cancelled 带完整报告）。已到终态的任务不可取消（如实回执、不报错）。' +
      '只对**本调用方**的任务可见（他人任务与不存在的任务回同一句"未知任务"）。',
    inputSchema: z.object({
      taskId: z.string().min(1).max(128).describe('要取消的任务 id'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;

/**
 * 建模域全量条目 = 基础清单 + **操作级别名**（`hana_view_update#<op>`，2026-10-10）。
 * 别名从父 schema 的 operations union 与 VIEW_OPS 派生（见 defs/view-ops.ts），标 routeOnly：
 * 有声明、可授权、可出现在门面索引里，但**永不注册为工具**（注册名 = 父工具名）——经门面路由调用。
 */
export const modelingCapabilities = {
  ...baseModelingCapabilities,
  ...buildViewOpCapabilities(baseModelingCapabilities.hana_view_update),
} satisfies Record<string, Capability<z.ZodType>>;
