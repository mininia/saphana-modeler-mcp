/**
 * 建模域（category: 'modeling'）清单条目（顺序 = 注册顺序）：
 * 六个视图工具（create / validate / check_actions / activate / update / delete）+ 两个异步任务工具。
 * 可写包范围由 HANA_WRITE_PACKAGES 决定。
 */

import { z } from 'zod';
import { cap, type Capability } from '../types.js';
import { buildViewOpCapabilities } from './view-ops.js';
import { zObjectName, zPackageId, zWritePackageId } from '../schemas.js';
import { VIEW_OPS } from '../../services/view-ops.rules.js';
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
import { TASK_TTL_MS_DEFAULT } from '../../core/limits.js';
import { CHECK_PROCEDURES } from '../../services/validation.service.js';

/**
 * delete 通道的合法 migration 值：只有「显式承担」一项，从全集派生（migrate.rules 是单一事实源）。
 * schema 用宽松 z.string()、由 handler 报中文硬错误——z.enum 会把英文报错丢在协议层且不列合法值。
 */
export const DELETE_MIGRATION_DECLARATIONS = MIGRATION_DECLARATIONS.filter(
  // 类型谓词兼作编译期护栏：migrate.rules 改名/删值时这里先报错，不会静默漂移成空清单。
  (d): d is 'acknowledge_dependents' => d === 'acknowledge_dependents',
);

/**
 * hana_view_update 的审批谓词：**只有 changeset 里的 delete 动作**按删除处理，需要人工确认。
 * 单对象 operations/xml（含字段/节点改造）不触发审批；参数在闸门前已过 schema，
 * 这里只做纯读取，缺字段/形状不符一律 false（不会误放行 delete）。
 */
function changesetHasDelete(args: Record<string, unknown>): boolean {
  const changeset = args['changeset'];
  if (changeset === null || typeof changeset !== 'object') return false;
  const actions = (changeset as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return false;
  return actions.some(
    (action) => action !== null && typeof action === 'object' && (action as { action?: unknown }).action === 'delete',
  );
}

/** SQL 模式输出列（create 的 scriptColumns 与 update 的 set_script.columns 共用一份，避免约束漂移）。 */
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

// ── create 通道字段片段（hana_view_create 顶层与 changeset 的 create 动作共用）──
// 单点定义：改约束只改这里。片段不带 .optional()/.default()，可选性与默认值由使用处决定。

/** 视图描述（create 顶层与 changeset create 动作共用） */
const VIEW_DESCRIPTION_FIELD = z.string().max(200).describe('视图描述（默认取对象名）');

/** 视图形态（graphical/projection 与 sql；graphical 是 projection 的别名） */
const VIEW_MODE_ENUM = z
  .enum(['graphical', 'projection', 'sql'])
  .transform((m) => (m === 'graphical' ? 'projection' : m))
  .describe(
    '视图形态：graphical=可视化/图形化（projection 的同义值；用 graph 声明 join/union/projection/aggregation/rank 模块实例，' +
      '无 graph 时为单 Projection + 初始源）；sql=SQL 模式（需 script + scriptColumns）',
  );

/**
 * 物理表源的 schema（hana_view_create 另有 CV 源参数 sourcePackageId/sourceObjectName）。
 * 不在参数层打 readSchema 标签：仅 mode=projection 消费，打标会误拦「SQL 模式带残留 sourceSchema」的合法调用；
 * 读取范围由规划器按模式声明。.trim() 在声明侧归一，保证闸门与服务层判定同一个值。
 */
const VIEW_SOURCE_SCHEMA_FIELD = z
  .string()
  .trim()
  .describe(
    'mode=projection 的物理表源：schema，如 SAPABAP1（须在白名单内）。hana_view_create 也支持 CV 源 sourcePackageId/sourceObjectName（本 changeset 动作仅物理表）',
  );

/** 源物理表名 / CV 输出列 */
const VIEW_SOURCE_NAME_FIELD = z
  .string()
  .describe(
    'mode=projection 的物理表源：物理表名（服务端读它的列目录，如 T000）。hana_view_create 也支持 CV 源 sourcePackageId/sourceObjectName（本 changeset 动作仅物理表）',
  );

/** 度量策略 */
const VIEW_MEASURE_MODE_ENUM = z
  .enum(['SUM_NUMERIC', 'ALL_ATTRIBUTES'])
  .describe(
    'mode=projection 的度量策略：SUM_NUMERIC=数值列进 baseMeasures（默认，本环境激活要求 ≥1 度量）；ALL_ATTRIBUTES=全部列当属性（无度量，仅能保存 inactive，激活会被拒）',
  );

/** SQL 脚本正文 */
const VIEW_SCRIPT_FIELD = z
  .string()
  .min(1)
  .max(100000)
  .describe('mode=sql：SQL 脚本正文（表名写全限定名 SCHEMA."表"；输出列别名须与 scriptColumns 一致）');

/** SQL 模式输出列清单（数组本体，可选性由使用处决定） */
const VIEW_SCRIPT_COLUMNS_FIELD = z
  .array(SCRIPT_COLUMN_SCHEMA)
  .max(600)
  .describe('mode=sql：输出列清单（顺序即输出顺序；datatype 必填，无法从 SQL 文本推断）');

/** projection 模式要映射的列名清单 */
const VIEW_COLUMNS_FIELD = z
  .array(z.string())
  .max(600)
  .describe(
    'mode=projection：要映射的列名清单；省略=源表全列（自动区分属性/度量，超过 500 列只映射前 500，warnings 会标注）；显式列的类型由服务端回查源表列目录补齐（列不存在时报中文硬错误）',
  );

/**
 * 图形化模块图（graph）：sources + nodes（模块实例）+ output。
 * 与过程式 add_* 操作不同：节点实例由 id 标识、按 inputs 接线，同一模块可实例化多次
 * （Join_1 / Join_2 都是 join）；服务端拓扑排序后一次构建。
 */
const GRAPH_SOURCE_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(128).describe('源 id（在 graph 内唯一）'),
    type: z.literal('table').describe('物理表源'),
    schema: z.string().min(1).max(128).describe('schema（须在 HANA_READ_SCHEMA 内）'),
    name: z.string().min(1).max(128).describe('表名'),
  }),
  z.object({
    id: z.string().min(1).max(128).describe('源 id（在 graph 内唯一）'),
    type: z.literal('calculationview').describe('计算视图源'),
    packageId: zPackageId('CV 源包名（只读即可）'),
    objectName: zObjectName('CV 源对象名'),
  }),
]);

const GRAPH_OUTPUT_FIELD_SCHEMA = z.object({
  id: z.string().min(1).max(128).describe('输出字段 id（必须在输出节点上）'),
  kind: z.enum(['attribute', 'measure']).optional().describe('输出分类；缺省继承输出节点的列分类'),
  aggregationType: z.string().max(30).optional().describe('度量聚合方式（缺省 sum）'),
  description: z.string().max(200).optional().describe('字段描述'),
});

const GRAPH_NODE_SCHEMA = z.discriminatedUnion('type', [
  z.object({
    id: z.string().min(1).max(128).describe('模块实例 id，如 P_MAT / Join_1（在 graph 内唯一）'),
    type: z.literal('projection'),
    input: z.string().min(1).max(128).describe('输入 source/node id'),
    fields: z.array(z.string().min(1).max(128)).min(1).max(600).describe('输出列'),
    mappings: z
      .array(z.object({ id: z.string().min(1).max(128), source: z.string().min(1).max(128) }))
      .max(600)
      .optional()
      .describe('输出列 ← 输入列重命名；缺省同名'),
  }),
  z.object({
    id: z.string().min(1).max(128),
    type: z.literal('join'),
    inputs: z.tuple([z.string().min(1).max(128), z.string().min(1).max(128)]).describe('[左输入, 右输入]'),
    joinType: z.enum(['inner', 'leftOuter', 'rightOuter', 'fullOuter']).default('leftOuter'),
    conditions: z
      .array(
        z.object({
          leftField: z.string().min(1).max(128).describe('左输入字段'),
          rightField: z.string().min(1).max(128).describe('右输入字段（可不同名）'),
        }),
      )
      .min(1)
      .max(10),
    fields: z.array(z.string().min(1).max(128)).min(1).max(600).describe('join 节点输出列'),
  }),
  z.object({
    id: z.string().min(1).max(128),
    type: z.literal('union'),
    inputs: z.array(z.string().min(1).max(128)).min(2).max(20).describe('输入 source/node id（≥2）'),
    fields: z.array(z.string().min(1).max(128)).min(1).max(600).describe('union 输出列'),
    mappings: z
      .array(
        z.object({
          id: z.string().min(1).max(128),
          sources: z.array(z.string().min(1).max(128)).min(2).max(20).describe('按 inputs 顺序给出的源字段'),
        }),
      )
      .max(600)
      .optional()
      .describe('各输入的重命名映射；缺省同名'),
  }),
  z.object({
    id: z.string().min(1).max(128),
    type: z.literal('aggregation'),
    input: z.string().min(1).max(128),
    groupBy: z.array(z.string().min(1).max(128)).max(100).default([]).describe('分组维度（属性）'),
    measures: z
      .array(
        z.object({
          field: z.string().min(1).max(128),
          aggregationType: z.string().min(1).max(30).default('sum'),
        }),
      )
      .min(1)
      .max(100)
      .describe('度量及聚合方式'),
  }),
  z.object({
    id: z.string().min(1).max(128),
    type: z.literal('rank'),
    input: z.string().min(1).max(128),
    partitionBy: z.array(z.string().min(1).max(128)).min(1).max(50),
    orderBy: z
      .array(
        z.object({
          field: z.string().min(1).max(128),
          direction: z.enum(['ASC', 'DESC']).default('ASC'),
        }),
      )
      .min(1)
      .max(50),
    threshold: z.number().int().min(1).max(1000000),
  }),
]);

const GRAPH_SCHEMA = z.object({
  sources: z.array(GRAPH_SOURCE_SCHEMA).min(1).max(50).describe('源（物理表 / CV）'),
  nodes: z.array(GRAPH_NODE_SCHEMA).min(1).max(100).describe('模块实例（按 id/inputs 接线，可重复使用同一模块）'),
  output: z.string().min(1).max(128).describe('输出节点 id'),
  outputFields: z.array(GRAPH_OUTPUT_FIELD_SCHEMA).max(600).optional().describe('输出字段；缺省=输出节点的全部列'),
});

/** graph 增量补丁：按 id 合并 sources/nodes；remove 删除；output/outputFields 可改 */
const GRAPH_PATCH_SCHEMA = z.object({
  sources: z.array(GRAPH_SOURCE_SCHEMA).max(50).optional().describe('新增/替换的源（按 id 合并，未提及的保留）'),
  nodes: z.array(GRAPH_NODE_SCHEMA).max(100).optional().describe('新增/替换的模块实例（按 id 合并，未提及的保留）'),
  remove: z.array(z.string().min(1).max(128)).max(100).optional().describe('要删除的 source/node id（仍被引用则拒绝）'),
  output: z.string().min(1).max(128).optional().describe('新的输出节点 id；省略=保持现有输出'),
  outputFields: z.array(GRAPH_OUTPUT_FIELD_SCHEMA).max(600).optional().describe('新增/覆盖输出字段（按 id 合并）'),
  removeOutputFields: z.array(z.string().min(1).max(128)).max(600).optional().describe('要删除的输出字段 id'),
});

/**
 * 声明式操作补丁（operations）：hana_view_update 单对象通道与 changeset 的 update 动作共用一份。
 * 可选性与 describe 由使用处加；op 全集与 effect 见 services/view-ops.rules.ts（VIEW_OPS）。
 */
const VIEW_UPDATE_OPERATIONS_SCHEMA = z
  .array(
    z.discriminatedUnion('op', [
      z.object({
        op: z
          .literal('auto_layout')
          .describe('操作类型：按节点 DAG 自动分层重写布局（Auto Layout / auto-layer；纯展示，不影响激活）'),
        columnGap: z.number().int().min(40).max(1000).optional().describe('同层横向间距（默认 120）'),
        rowGap: z.number().int().min(30).max(1000).optional().describe('同层节点纵向间距（默认 90）'),
      }),
      z.object({
        op: z.literal('set_script').describe('操作类型：替换 SQL 模式视图的脚本与输出列'),
        script: z
          .string()
          .min(1)
          .max(100000)
          .describe(
            '新 SQL 查询（表名写全限定名 SCHEMA."表"；别名须与 scriptColumns 一致）。服务端自动包成 BEGIN VAR_OUT = <查询>; END；也可直接给完整 BEGIN…END 过程体',
          ),
        // 与 hana_view_create 的 scriptColumns 同名同义，共用同一份 SCRIPT_COLUMN_SCHEMA。
        scriptColumns: z.array(SCRIPT_COLUMN_SCHEMA).min(1).max(600).describe('新的输出列清单（整体替换旧输出）'),
      }),
      z.object({
        op: z.literal('set_description').describe('操作类型：修改视图描述/显示名（只动展示属性，非破坏）'),
        // 两个字段指向同一个 XML 锚点：至少给一个；都给且不一致会被服务端拒绝。
        description: z
          .string()
          .max(200)
          .optional()
          .describe('视图描述（与 displayName 同锚点；两个都给须一致；空串=清空描述）'),
        displayName: z
          .string()
          .max(200)
          .optional()
          .describe('显示名/Label（与 description 同锚点；两个都给须一致，至少给一个）'),
      }),
      z.object({
        op: z.literal('rename_field').describe('操作类型：改输出字段名（只动别名，节点列与接线不动）'),
        field: z.string().min(1).max(128).describe('当前输出字段 id（logicalModel 名称，如 AMOUNT）'),
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
  // 上限与 changeset 动作数共用同一常量（改常量时两处同变）。
  .max(CHANGESET_MAX_ACTIONS);

/**
 * 变更集动作：形状镜像 services/changeset.plan.ts 的 ChangesetAction（handler 直接交给 applyChangeset）。
 * create 专用字段复用 hana_view_create 的片段；source 的列形状按 ChangesetAction 镜像（对象数组）。
 */
const CHANGESET_ACTION_SCHEMA = z.object({
  action: z
    .enum(['update', 'create', 'delete'])
    .describe(
      '动作类型：update=更新已有对象（xml/operations 二选一）；create=新建（同 hana_view_create）；delete=删除',
    ),
  packageId: zPackageId('动作目标包名；须在 HANA_WRITE_PACKAGES 可写范围内'),
  objectName: zObjectName('动作目标对象名（不含包名）'),
  xml: z.string().min(1).optional().describe('action=update：新的完整设计时 XML 全量覆盖（与 operations 二选一）'),
  operations: VIEW_UPDATE_OPERATIONS_SCHEMA.optional().describe(
    'action=update：声明式操作补丁（与 xml 二选一，与顶层 operations 同义）',
  ),
  migration: z
    .object({
      // 与顶层通道同一口径：宽松 z.string() + 调用时中文硬错误；合法值随 action 而定。
      strategy: z
        .string()
        .describe(
          `破坏性声明策略（合法值随动作而定——update：${MIGRATION_DECLARATIONS.join(' / ')}；` +
            `delete：${DELETE_MIGRATION_DECLARATIONS.join(' / ')}；create 不接受；非法值调用时以中文硬错误列出）`,
        ),
      note: z.string().optional().describe('声明附注（仅随回执记录，不参与判定）'),
    })
    .optional()
    .describe(
      '破坏性动作的显式承担声明：未声明 ⇒ 整体预检在任何写入前拒绝（整批拒绝、零写入）；只有预检无法判定而退化到执行期拒绝时，才走「停止 + 逆序补偿」',
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
            columnName: z.string().min(1).max(128).describe('源表列名'),
            dataTypeName: z.string().optional().describe('列类型名（用于属性/度量判定）；省略=服务端按源表解析'),
          }),
        )
        .max(600)
        .optional()
        .describe('显式映射列；省略=源表全列（自动区分属性/度量）'),
      measureMode: VIEW_MEASURE_MODE_ENUM.default('SUM_NUMERIC'),
    })
    .optional()
    .describe(
      'action=create + mode=projection：源物理表（当前实现；与 hana_view_create 的 sourceSchema/sourceName/columns/measureMode 同义）',
    ),
  scripted: z
    .object({
      script: VIEW_SCRIPT_FIELD,
      columns: VIEW_SCRIPT_COLUMNS_FIELD,
    })
    .optional()
    .describe('action=create + mode=sql：SQL 脚本与输出列（与 hana_view_create 的 script/scriptColumns 同义）'),
});

const baseModelingCapabilities = {
  hana_view_create: cap({
    id: 'hana_view_create',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewCreate, destructive: false, idempotent: false, mutates: 'persistent' },
    routing: {
      intent: '在仓库中新建 Calculation View（graph 模块图 / SQL 模式）',
      whenToUse: [
        '用户明确要新建视图',
        '用 join/union/projection/aggregation/rank 模块组合计算视图',
        '需要零 XML 的 SQL 模式建视图',
      ],
      notFor: [
        '修改已有视图用 hana_view_update，不要 delete+重建',
        '用户明确要可视化 CV 时不要静默改用 SQL 模式；用 graph（sources + nodes + output）声明模块图，或先与用户确认',
      ],
      priority: 'primary',
      requires: '目标包在 HANA_WRITE_PACKAGES 可写范围内',
      constraints: [
        'graph 与 source*/operations 互斥：模块图把源和节点都写在 graph 里；不走 graph 时才用 sourceSchema/sourceName 或 sourcePackageId/sourceObjectName 的单 Projection 形态',
        'graph.nodes 按 id/inputs 接线，同一模块可实例化多次（Join_1/Join_2 都是 join）；服务端拓扑排序后一次写入',
        'CV 源必须已激活；table 源按 SYS.TABLE_COLUMNS/VIEW_COLUMNS 取列，数值类型=度量',
      ],
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV009', mode: 'graphical' },
    },
    title: '新建 Calculation View（计算视图）',
    // SQL 方言、实测边界与并发解释见规则 sql_mode / activation_measure / write_transport / write_receipt。
    description:
      '在仓库中新建一个 Calculation View，mode 三选一（graphical 是 projection 的别名）：\n' +
      '① graphical/projection（默认）：用 graph 声明模块图（sources + nodes + output）——join/union/projection/aggregation/rank 都是模块实例，' +
      '按 id/inputs 接线，同一模块可用多遍；服务端拓扑排序后一次性构建（自动布局默认开启）。' +
      '不使用 graph 时退化为「单 Projection + 初始源」：物理表（sourceSchema/sourceName）或 CV（sourcePackageId/sourceObjectName）。\n' +
      '② sql：SQL 模式（Scripted Calculation View）——需 script + scriptColumns。按 SQL 建视图一律用它，模型零 XML。\n' +
      '如果用户明确要求「可视化/图形化 CV」，优先用 graph；属性/度量是 logicalModel 的输出分类，不是 join 节点的属性。不要静默改成 SQL 模式。\n' +
      '安全约束：可写包由 HANA_WRITE_PACKAGES 限定（留空=拒写 boundary_off）；同名对象已存在时拒绝覆盖。\n' +
      '回执：activated（写入后实测状态）、activationErrors/activationDetail（激活失败完整明细，无需再调 hana_view_validate）、rowProbe（0 行附排查提示）。\n' +
      'SQL 方言、scriptColumns↔VAR_OUT 与 ≥1 度量要求、通道差异见 rules=sql_mode,activation_measure,write_transport,write_receipt。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 可写范围内（如 ZDEMO 或 ZDEMO.SUB）'),
      objectName: zObjectName('新视图对象名（不含包名），如 ZDEMO_CV_TEST001'),
      description: VIEW_DESCRIPTION_FIELD.optional(),
      mode: VIEW_MODE_ENUM.default('projection'),
      sourceSchema: VIEW_SOURCE_SCHEMA_FIELD.optional(),
      sourceName: VIEW_SOURCE_NAME_FIELD.optional(),
      sourcePackageId: zPackageId(
        'mode=projection 的 CV 初始源：源 CV 包名（只读即可），如 system-local.bw.bw2hana.query.zdemo01r014；与 sourceSchema/sourceName 二选一',
      ).optional(),
      sourceObjectName: zObjectName(
        'mode=projection 的 CV 初始源：源 CV 对象名（不含包名），如 ZDEMO01R014_Q017；与 sourceSchema/sourceName 二选一',
      ).optional(),
      sourceColumns: z
        .array(SCRIPT_COLUMN_SCHEMA)
        .max(600)
        .optional()
        .describe(
          'CV 初始源的显式输出列（name/dataType；省略=按 _SYS_BIC 的 SYS.VIEW_COLUMNS 取可见列）。' +
            '源 CV 的隐藏 Join 键不在 VIEW_COLUMNS 里时，用本字段显式给出列名与类型',
        ),
      operations: VIEW_UPDATE_OPERATIONS_SCHEMA.optional().describe(
        '图形化 create 的视图级声明式操作（如 auto_layout / set_description / set_script）：在内存中应用到基础 XML 后再一次性 PUT；' +
          '节点组合（join/union/projection/aggregation/rank）请写在 graph 中，不要用逐个 add_*。mode=sql 不接受',
      ),
      graph: GRAPH_SCHEMA.optional().describe(
        '图形化模块图：sources + nodes（模块实例）+ output。与 source*/operations 互斥；节点按 id/inputs 接线，同一模块可实例化多次；' +
          '服务端拓扑排序后一次构建，默认写自动布局',
      ),
      layout: z.boolean().optional().describe('graph 构建后是否写自动布局（默认 true）'),
      script: VIEW_SCRIPT_FIELD.optional(),
      scriptColumns: VIEW_SCRIPT_COLUMNS_FIELD.optional(),
      measureMode: VIEW_MEASURE_MODE_ENUM.default('SUM_NUMERIC'),
      activate: z
        .boolean()
        .default(false)
        .describe(
          'xs_rest（默认）写入即激活，本参数只决定激活失败是否透出；非 xs_rest 写入不激活：true=写后尝试激活，false 时 inactive_object 需手工激活',
        ),
      transport: z
        .enum(['repo_rest', 'xs_rest', 'inactive_object'])
        .default('xs_rest')
        .describe(
          '传输通道：xs_rest=XS REST 官方写路径（默认，推荐）；repo_rest=裸 SYS.REPOSITORY_REST（部分环境写会 40106）；inactive_object=直写 INACTIVE_OBJECT（兜底，需手工激活）',
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

  // hana_view_validate 的 design 模式会短暂写入临时校验对象 _CHKTMP，故整工具归 write。
  hana_view_validate: cap({
    id: 'hana_view_validate',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewValidate, destructive: false, idempotent: true, mutates: 'transient' },
    routing: {
      intent: '校验计算视图一致性（激活前设计时 / 运行时）',
      whenToUse: ['改完或激活前做 CheckResult 校验', '对已激活的图形化视图做一致性校验'],
      notFor: ['只是预览数据用 hana_data_preview', 'SQL 模式视图的 runtime 校验不适用，改用 hana_data_preview'],
      priority: 'primary',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008', target: 'design' },
      returns: [
        'CheckResult 编译明细（成功/失败与具体错误）',
        'design 模式临时副本写后即删；清理失败回执 tempResidue',
        'runtime 模式校验已激活视图一致性',
        'SQL 模式 / SCRIPT_BASED 视图返回 VALIDATE_UNSUPPORTED（不是视图不一致）',
      ],
    },
    title: '校验计算视图一致性',
    description:
      '双模式校验：\n' +
      'target=design（默认）：对可写包内设计时对象做激活前校验——临时副本 _CHKTMP 触发服务端激活检查（CheckResult 带编译明细）后删除，原对象激活状态不受影响；副本名带短哈希（总长 ≤29），与真实对象重名时本次拒绝执行（不删不改）；清理未完成时回执 tempResidue（对象名+原因），需人工清理，不静默。\n' +
      'target=runtime：对已激活的运行时计算视图做一致性校验（SYS.CHECK_CALCULATION_VIEW，需 schema+viewName，如 _SYS_BIC + "ZDEMO.ZDEMO_MKC/ZDEMO03_CV003"）。SQL 模式 / SCRIPT_BASED 视图可能返回 VALIDATE_UNSUPPORTED（CHECK 过程无法解析其 scenario）；这不是视图不一致，改用 hana_data_preview 或 SELECT ... LIMIT 0 验证运行时对象。\n' +
      '激活前建议先 design 校验，激活后可用 runtime 复检；支持的动作清单用 hana_view_check_actions 查询。',
    inputSchema: z.object({
      target: z
        .enum(['design', 'runtime'])
        .default('design')
        .describe(
          'design=设计时对象激活前校验（packageId+objectName）；runtime=运行时视图一致性校验（schema+viewName）',
        ),
      packageId: zPackageId('design 模式：目标包名；须在 HANA_WRITE_PACKAGES 可写范围内').optional(),
      objectName: zObjectName('design 模式：视图对象名（不含包名）').optional(),
      schema: z.string().default('_SYS_BIC').describe('runtime 模式：运行时 schema，默认 _SYS_BIC（须在白名单内）'),
      viewName: z
        .string()
        .optional()
        .describe('runtime 模式：运行时视图名，如 "ZDEMO.ZDEMO_MKC/ZDEMO03_CV003"（包路径/对象名）'),
      action: z
        .enum(['CHECK_CONSISTENCY'])
        .default('CHECK_CONSISTENCY')
        .describe('runtime 模式：校验动作（calculationview 仅支持 CHECK_CONSISTENCY）'),
    }),
    // design 模式会短暂写入临时校验对象（写后即删），不能标 readOnly
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false, destructiveHint: false },
  }),

  // 服务于 hana_view_validate；行为只读（SELECT SYS.GET_CHECK_ACTIONS），随校验工作流归 write。
  hana_view_check_actions: cap({
    id: 'hana_view_check_actions',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewCheckActions, destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '查询校验过程支持的动作清单',
      whenToUse: ['不确定 hana_view_validate 支持哪些检查动作'],
      notFor: ['普通校验直接调 hana_view_validate'],
      priority: 'advanced',
    },
    title: '查询校验过程支持的动作清单',
    description:
      '查询 SYS.GET_CHECK_ACTIONS：某 CHECK 过程支持的 ACTION 全集及说明。用于调用 hana_view_validate 前确认动作名，或了解 HANA 的表/目录一致性检查能力。默认列出计算视图相关（CHECK_CALCULATION_VIEW）。',
    inputSchema: z.object({
      // 合法值 = validation.service 导出的过程名常量：枚举与调用白名单共用同一份字面量。
      checkProcedureName: z
        .enum(CHECK_PROCEDURES)
        .default('CHECK_CALCULATION_VIEW')
        .describe('CHECK 过程名（默认 CHECK_CALCULATION_VIEW）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_view_activate: cap({
    id: 'hana_view_activate',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewActivate, destructive: false, idempotent: false, mutates: 'persistent' },
    routing: {
      intent: '把设计时 Calculation View 激活为运行时视图',
      whenToUse: ['设计时对象改完需要生效', '激活失败需要看编译错误明细'],
      notFor: ['写入/导入即激活的场景不要重复激活'],
      priority: 'primary',
      requires: '目标包在 HANA_WRITE_PACKAGES 可写范围内',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008' },
      returns: [
        '激活结果 + 编译错误明细（失败不误报成功）',
        '412 并发冲突按机读回执返回',
        '激活后运行时视图在 _SYS_BIC',
      ],
    },
    title: '激活 Calculation View（设计时对象）',
    description:
      '将可写包下的 Calculation View 设计时对象激活为运行时视图（XS REST：PUT + SapBackPack {"Activate":true}）。并发改动以 412 机读回执暴露，不静默回退。失败透传编译错误明细，不误报成功。\n' +
      '激活前建议用 hana_view_validate 校验；激活后可用 hana_metadata_get_view 读定义、hana_data_preview 预览数据。写包范围由 HANA_WRITE_PACKAGES 限定。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 可写范围内'),
      objectName: zObjectName('视图对象名（不含包名）'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: false, openWorldHint: false, destructiveHint: false },
  }),

  hana_view_update: cap({
    id: 'hana_view_update',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planViewUpdate, destructive: true, idempotent: false, mutates: 'persistent' },
    // 审批只覆盖 changeset 的 delete 动作；普通 update（含 operations/xml）不确认。
    approval: changesetHasDelete,
    routing: {
      intent: '更新已有 Calculation View（graph 增量合并 / 视图级 operations / 全量 XML / 变更集）',
      whenToUse: [
        '修改已有视图的模块图（join/union 等）用 graph',
        '改字段/脚本/描述用 operations',
        '需要 dryRun 预演破坏性变更',
      ],
      notFor: ['新建用 hana_view_create；不要 delete+重建'],
      priority: 'primary',
      requires: '目标包在 HANA_WRITE_PACKAGES 可写范围内',
      exampleArgs: {
        packageId: 'ZDEMO.ZDEMO_MGF',
        objectName: 'ZDEMO02_CV008',
        graph: { nodes: [{ id: 'P1', type: 'projection', input: 'S1', fields: ['A'] }] },
      },
      returns: [
        'graph 模式：重建后的结构段与实测激活状态（增量合并，未提及节点保留）',
        'operations 模式：每条操作的应用明细 + 实测激活状态',
        'dryRun=true：mode=dryRun + 结构 diff/影响半径/breaking，零写入',
        '412 冲突：raw.conflict 带当前 ETag/版本；changeset 逐项 report',
      ],
    },
    title: '更新 Calculation View（graph / 视图级 operations / 全量 XML / 变更集）',
    // 以下为契约锁定项（改描述时勿删）：四方式互斥、关键参数名、migration 合法值、机读码全集、
    // 回执字段名、零写入语义。
    description:
      '更新已有 Calculation View，四种方式四选一（互斥）：\n' +
      '① graph（节点组合推荐）：模块图增量补丁——按 id 合并 sources/nodes（未提及的保留），remove 删除，output/outputFields 可改；' +
      '服务端重建 dataSources/calculationViews/logicalModel 后走原 PUT 路径，默认重写自动布局；\n' +
      '② operations：视图级声明式操作 op=' +
      VIEW_OPS.map((o) => o.id).join(' / ') +
      '，服务端读取当前定义并确定性变换后走原 PUT 路径——模型零 XML，返回每条操作的应用明细与实测激活状态；\n' +
      '③ xml：完整设计时 XML 全量覆盖（复杂改造用；写入前有服务端护栏，通过后返回 xmlVerification 摘要）；\n' +
      `④ changeset：多对象变更集（动作上限 ${CHANGESET_MAX_ACTIONS}，单次调用内闭合）——整体预检不通过则整批拒绝、零写入；` +
      '任一项失败即逆序补偿；partial=true 时逐项枚举状态（含 notExecuted），绝不把部分完成包装成 success。\n' +
      '①②③ 都走 XS REST PUT + If-Match ETag 乐观锁：基线读 → 内容读 → PUT 在同一进程内锁临界区完成。\n' +
      '关键参数：ifMatch（省略=自动取；基于更早读取的内容覆盖时必须显式传）、activate、probeRows（默认 10）、' +
      'dryRun=true（只读预演：结构 diff + 影响半径 + 破坏性判定，零写入，回执 mode=dryRun）、' +
      'migration.strategy（破坏性变更的显式承担声明，合法值 cast / preserve_column / move / acknowledge_dependents；' +
      '未声明 ⇒ migration_required 拒绝且零写入；声明只被记录，不触发自动迁移）。\n' +
      '机读码：412（乐观锁冲突，raw.conflict 带当前基线）/ OBJECT_NOT_FOUND / migration_required / ' +
      'changeset_partial / changeset_conflict / changeset_invalid。\n' +
      '回执：新基线 etag 与 etagSource、breaking、migration、rowProbe（0 行附排查提示）、changeset 逐项 report' +
      '（etag/elapsedMs/状态）。\n' +
      '原地覆盖、无自动回滚：改前用 hana_metadata_get_view(format=xml) 留档，恢复=用该 XML 重新 update。\n' +
      '方言与细节见 rules=write_receipt,sql_mode,bw_dialect,view_ops（hana_system_get_info）。',
    inputSchema: z
      .object({
        // changeset 模式下这两个参数被忽略（目标由各 action 自带），故可选；
        // 单对象通道的必填由链尾 superRefine 表达。
        packageId: zWritePackageId(
          '目标包名；须在 HANA_WRITE_PACKAGES 可写范围内（changeset 模式下忽略，批次目标由各 action 承担）',
        ).optional(),
        objectName: zObjectName('视图对象名（不含包名）（changeset 模式下忽略，批次目标由各 action 承担）').optional(),
        xml: z
          .string()
          .min(1)
          .optional()
          .describe('方式三：完整设计时 XML 全量覆盖（与 operations/graph 三选一；复杂改造用）'),
        operations: VIEW_UPDATE_OPERATIONS_SCHEMA.optional().describe(
          '方式二：视图级声明式操作补丁（与 xml/graph 三选一）；节点组合请走 graph，不要逐个 add_*',
        ),
        graph: GRAPH_PATCH_SCHEMA.optional().describe(
          '方式三：模块图增量补丁（与 xml/operations 三选一）——按 id 合并 sources/nodes（未提及的保留），remove 删除，' +
            'output/outputFields 可改；服务端重建结构段后走同一 PUT 路径，默认重写自动布局',
        ),
        layout: z.boolean().optional().describe('graph 合并后是否重写自动布局（默认 true）'),
        changeset: z
          .object({
            actions: z
              .array(CHANGESET_ACTION_SCHEMA)
              .max(CHANGESET_MAX_ACTIONS)
              .describe(
                `多对象变更集动作列表（上限 ${CHANGESET_MAX_ACTIONS}，与 operations 上限对齐）；每个动作自带 packageId/objectName`,
              ),
          })
          .optional()
          .describe(
            '方式三：多对象变更集（与 xml/operations 三选一）——预检（含对象级读写集相交检测）→ 逐项执行 → 失败逆序补偿 → 诚实报告（partial=true 逐项枚举）。长批次可加 async=true 走异步任务（hana_task_get 轮询 / hana_task_cancel 取消）',
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
          .describe('激活成功后探测的行数上限（0=不探测）：让「0 行」当场可见（返回 rowProbe 含 emptyHint）'),
        dryRun: z
          .boolean()
          .default(false)
          .describe(
            'true=只读预演（零写入）：读当前设计时定义 → 应用 graph/operations/xml → 结构 diff → 影响半径 → 破坏性判定；不 PUT、不激活、不 probe，回执带 mode=dryRun',
          ),
        async: z
          .boolean()
          .default(false)
          .describe(
            'true=异步任务（仅与 changeset 组合）：立即返回 taskId，后台执行预检→逐项→逆序补偿；用 hana_task_get 轮询、hana_task_cancel 取消。长批次推荐用它避开客户端超时',
          ),
        migration: z
          .object({
            // 合法值常量导入自 migrate.rules（单一事实源）；刻意用 z.string()，非法值由 handler 给中文硬错误。
            strategy: z
              .string()
              .describe(
                `迁移策略声明（合法值：${MIGRATION_DECLARATIONS.join(' / ')}；非法值调用时以中文硬错误列出）。` +
                  '两类语义：① 字段级迁移——cast=下游按新类型重铸、preserve_column=保列新建、move=随改名迁移；' +
                  '② acknowledge_dependents=调用方显式承担下游破坏、不做字段级迁移（整段回退等场景）。两类都只被记录，不触发自动迁移',
              ),
            note: z.string().optional().describe('声明附注（仅随回执记录，不参与判定）'),
          })
          .optional()
          .describe(
            '破坏性变更的显式承担声明：未声明 ⇒ 服务端拒绝且零写入（raw.errorDetail 带破坏项）；声明只被记录，不触发自动迁移',
          ),
      })
      .superRefine((val, ctx) => {
        // 非 changeset 时 packageId/objectName 必填：单对象通道在 schema 层拒绝（不进 handler）。
        if (val.changeset === undefined && (val.packageId === undefined || val.objectName === undefined)) {
          ctx.addIssue({
            code: 'custom',
            message:
              '非 changeset 模式下必须提供 packageId 与 objectName（graph/operations/xml 单对象通道的目标对象）；' +
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
    effects: { plan: planViewDelete, destructive: true, idempotent: false, mutates: 'persistent' },
    // 删除不可恢复：审批开启时每次都要确认。
    approval: 'always',
    routing: {
      intent: '删除可写包下的 Calculation View 设计时对象',
      whenToUse: ['用户明确要求删除对象'],
      notFor: ['修改已有视图不要 delete+重建（用 hana_view_update）'],
      priority: 'advanced',
      requires: '目标包在 HANA_WRITE_PACKAGES 可写范围内；有下游引用需 migration.strategy=acknowledge_dependents',
      exampleArgs: { packageId: 'ZDEMO.ZDEMO_MGF', objectName: 'ZDEMO02_CV008' },
    },
    title: '删除 Calculation View（设计时对象）',
    description:
      '删除可写包下的 Calculation View 设计时对象（XS REST：DELETE + If-Match）：陈旧基线 412、对象已不存在 OBJECT_NOT_FOUND（均机读），回执带删除前 etag/version。\n' +
      '有下游引用时属破坏性变更：须显式声明 migration.strategy=acknowledge_dependents 才放行，未声明即拒绝且不删除（回执带破坏项与下游计数）。删除会造成依赖方失效（删前建议用 hana_metadata_where_used 查引用）；写包范围由 HANA_WRITE_PACKAGES 限定。\n' +
      '删除不可恢复：恢复方式 = 用事先导出的备份（hana_repo_export 或 hana_metadata_get_view(format=xml) 留档）经 hana_repo_import 重新导入。',
    inputSchema: z.object({
      packageId: zWritePackageId('目标包名；须在 HANA_WRITE_PACKAGES 可写范围内'),
      objectName: zObjectName('视图对象名（不含包名）'),
      migration: z
        .object({
          // 与 update 通道同款：z.string() 宽松 schema，非法值由 handler 中文硬错误列出合法值。
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
   * 异步任务（工具化任务 API）：只服务 hana_view_update 的 changeset+async 长批次，故归 modeling；
   * cancel 是 write，只读档案看不到它。
   */
  hana_task_get: cap({
    id: 'hana_task_get',
    category: 'modeling',
    kind: 'read',
    effects: { destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '轮询异步任务状态与结果（change set / SQL 长分析）',
      whenToUse: ['调用返回 taskId 后轮询', '查任务终态 result'],
      notFor: ['同步调用不需要任务查询'],
      priority: 'primary',
      exampleArgs: { taskId: 'task-...' },
    },
    title: '查询异步任务状态与结果',
    description:
      '轮询异步任务：`hana_view_update(async=true)` 的变更集、或 `hana_sql_analyze(async=true)` 的长分析。返回 kind、status（working/completed/failed/cancelled）、进度与终态 result（与同步调用同形的回执信封）。\n' +
      '只对本调用方可见（他人任务与不存在的任务回同一句「未知任务」）；任务状态在进程内，服务重启即失效——' +
      `终态任务约保留 ${TASK_TTL_MS_DEFAULT / 60_000} 分钟（注册表饱和时最旧的终态会被提前清理）。`,
    inputSchema: z.object({
      taskId: z.string().min(1).max(128).describe('任务 id（async=true 调用的回执里给出）'),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  }),

  hana_task_cancel: cap({
    id: 'hana_task_cancel',
    category: 'modeling',
    kind: 'write',
    effects: { plan: planTaskCancel, destructive: false, idempotent: true, mutates: 'none' },
    routing: {
      intent: '取消异步任务（协作式，动作边界生效）',
      whenToUse: ['用户明确要求取消正在运行的任务'],
      notFor: ['不要用它代替失败重试；执行中的 SQL 无法取消'],
      priority: 'advanced',
      exampleArgs: { taskId: 'task-...' },
    },
    title: '取消异步任务（协作式）',
    description:
      '请求取消一个运行中的异步任务。变更集（changeset）：当前动作不打断，结束后停止后续项并触发与失败相同的逆序补偿（终态 raw.code=changeset_cancelled 带完整报告）。SQL 分析：执行中的语句无法取消，分析会跑完并如实返回结果，终态会说明取消未生效。已到终态的任务不可取消（如实回执、不报错）。只对本调用方可见。',
    inputSchema: z.object({
      taskId: z.string().min(1).max(128).describe('要取消的任务 id'),
    }),
    annotations: { readOnlyHint: false, idempotentHint: true, openWorldHint: false },
  }),
} satisfies Record<string, Capability<z.ZodType>>;

/**
 * 建模域全量条目 = 基础清单 + 操作级别名（`hana_view_update#<op>`）。
 * 别名从父 schema 与 VIEW_OPS 派生，标 routeOnly：可授权、可出现在发现/契约里，但永不注册为工具。
 */
export const modelingCapabilities = {
  ...baseModelingCapabilities,
  ...buildViewOpCapabilities(baseModelingCapabilities.hana_view_update),
} satisfies Record<string, Capability<z.ZodType>>;
