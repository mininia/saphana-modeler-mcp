import { scanSqlSchemaRefs, scanXmlPackageRefs, hasUnqualifiedTableRef, type WritePlan } from '../write-plan.js';

/**
 * 写工具预规划器（单一事实源）：工具名 → 入参 → WritePlan。
 *
 * 每个写工具在此登记一份规划器，说明「这次调用最终会读写什么」。判定不在这里做——
 * 由预检层按生效权限配置判定（见 src/config/preflight.ts），本模块只负责把"将要发生什么"算清楚。
 *
 * 约定：新增写工具时必须同时登记规划器——否则落到 fallback，只按参数表面判定，
 * 并在计划里显式标注"未规划其内部实际触碰"，不静默假装已规划。
 */

const asStr = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() !== '' ? v : undefined;

function emptyPlan(tool: string): WritePlan {
  return { tool, steps: [], writePackages: [], readSchemas: [], readPackages: [], uncertain: [] };
}

/** 去重追加 */
function add(list: string[], ...items: (string | undefined)[]): void {
  for (const it of items) {
    if (it && !list.includes(it)) list.push(it);
  }
}

/** 声明式操作补丁的入参形状（结构见 hana_view_update 的 operations schema：add_join / set_script） */
interface DeclarativeOp {
  op?: unknown;
  sourcePackageId?: unknown;
  sourceObjectName?: unknown;
  /** op=set_script 的 SQL 正文 */
  script?: unknown;
}

/** hana_view_create：写入目标包；读取源 schema（或扫描 SQL 模式脚本里的 schema 引用）；激活会生成 _SYS_BIC 运行时视图 */
function planViewCreate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_create');
  const pkg = asStr(args.packageId);
  const object = asStr(args.objectName) ?? '(未指定对象名)';
  const schema = asStr(args.sourceSchema);
  const source = asStr(args.sourceName);
  const script = asStr(args.script);
  // 与服务层同一判定：mode 缺省即 projection（此时 script 会被忽略，计划也不该按 SQL 模式描述）
  const isSqlMode = args.mode === 'sql';
  add(p.writePackages, pkg);
  add(p.readSchemas, schema);
  p.steps.push(
    isSqlMode
      ? `在包 ${pkg ?? '(未指定)'} 新建 SQL 模式设计时 Calculation View ${object}（单 SqlScriptView + <definition>）`
      : `在包 ${pkg ?? '(未指定)'} 新建设计时 Calculation View ${object}`,
  );
  if (isSqlMode) {
    if (script) {
      const refs = scanSqlSchemaRefs(script);
      add(p.readSchemas, ...refs);
      p.steps.push(`按脚本中出现的 schema 限定名核对读取范围（共 ${refs.length} 个候选，来自 FROM/JOIN 表位置）`);
      p.uncertain.push(
        'SQL 模式：脚本内 schema 引用按 FROM/JOIN 表位置扫描（含引号/小写写法），' +
          '未限定 schema 的表名（按当前用户默认 schema 解析）与动态 SQL 不在本计划内',
      );
    }
    p.steps.push('按本环境方言生成设计时 XML（SCRIPT_BASED + definition + viewAttribute datatype）');
  } else if (schema && source) {
    p.steps.push(`读取源 ${schema}.${source} 的列定义（按类型区分属性/度量）`);
  }
  p.steps.push('生成并写入设计时 XML（XS REST PUT）');
  if (args.activate === true) p.steps.push('写入后尝试激活 → 生成 _SYS_BIC 运行时列视图');
  if (typeof args.probeRows === 'number' && args.probeRows > 0) {
    p.steps.push(`激活后回探测前 ${args.probeRows} 行（只读 _SYS_BIC 运行时对象）`);
  }
  return p;
}

/**
 * hana_view_update：写入目标包；**operations 模式下的 join 源在另一个包**（跨包只读引用）。
 * 这是"只看 packageId 参数会漏掉"的典型——join 源写在同一调用的另一个字段里。
 */
function planViewUpdate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_update');
  const pkg = asStr(args.packageId);
  const object = asStr(args.objectName) ?? '(未指定)';
  add(p.writePackages, pkg);
  p.steps.push(`读取 ${pkg ?? '?'}/${object} 的当前定义（同时取 ETag 作并发基线）`);

  const ops = Array.isArray(args.operations) ? (args.operations as DeclarativeOp[]) : [];
  ops.forEach((op, i) => {
    const sp = asStr(op?.sourcePackageId);
    const so = asStr(op?.sourceObjectName);
    const kind = String(op?.op ?? '?');
    if (kind === 'set_script') {
      // 替换脚本：只改当前视图自身（无跨包读取），但脚本内的 schema 限定名属于读取范围
      const script = asStr(op?.script);
      if (script) add(p.readSchemas, ...scanSqlSchemaRefs(script));
      p.steps.push(`应用操作 ${i + 1}（set_script）：替换 SQL 模式视图的脚本与输出列（重建 definition/viewAttributes/logicalModel 输出）`);
      p.uncertain.push(`操作 ${i + 1}（set_script）：脚本内的 schema 引用按启发式扫描，未限定 schema 的表名不在本计划内`);
    } else if (sp) {
      add(p.readPackages, sp);
      p.steps.push(`应用操作 ${i + 1}（${kind}）：join 源 ${sp}/${so ?? '?'} —— 跨包只读引用`);
    } else {
      p.steps.push(`应用操作 ${i + 1}（${kind}）`);
    }
  });

  const xml = asStr(args.xml);
  if (xml) {
    add(p.readPackages, ...scanXmlPackageRefs(xml));
    p.steps.push('以传入的完整 XML 全量覆盖当前定义');
    p.uncertain.push('全量 XML 模式：其中的跨包数据源引用按 resourceUri 扫描得出，可能不完整');
  }
  p.steps.push('PUT 更新设计时对象（按 activate 决定是否激活）');
  return p;
}

/** hana_view_delete：写入目标包；下游依赖会失效（波及面） */
function planViewDelete(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_delete');
  const pkg = asStr(args.packageId);
  add(p.writePackages, pkg);
  p.steps.push(`删除 ${pkg ?? '?'}/${asStr(args.objectName) ?? '?'} 的设计时对象`);
  p.uncertain.push('删除会使依赖该视图的下游对象失效（可先用 hana_metadata_where_used 查波及面）');
  return p;
}

/** hana_view_activate：写入目标包；生成 _SYS_BIC 运行时对象 */
function planViewActivate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_activate');
  const pkg = asStr(args.packageId);
  add(p.writePackages, pkg);
  p.steps.push(`激活 ${pkg ?? '?'}/${asStr(args.objectName) ?? '?'} → 生成 _SYS_BIC 运行时列视图`);
  return p;
}

/**
 * hana_view_validate：**参数看着是"校验"，design 模式实际会写一个 _CHKTMP 临时对象**
 * （写后即删）——正是"只看工具名/描述会误判为只读"的典型；runtime 模式才是纯只读。
 */
function planViewValidate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_validate');
  const target = asStr(args.target) ?? 'design';
  if (target === 'runtime') {
    const schema = asStr(args.schema) ?? '_SYS_BIC';
    add(p.readSchemas, schema);
    p.steps.push(`运行时一致性校验 ${schema}.${asStr(args.viewName) ?? '?'}（只读，不写仓库）`);
    return p;
  }
  const pkg = asStr(args.packageId);
  add(p.writePackages, pkg);
  p.steps.push(`在包 ${pkg ?? '?'} 写入临时副本 _CHKTMP 触发服务端激活检查`);
  p.steps.push('删除临时副本（原对象的激活状态不受影响）');
  return p;
}

/** hana_package_create：写入目标包路径 */
function planPackageCreate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_package_create');
  const pkg = asStr(args.packageId);
  add(p.writePackages, pkg);
  p.steps.push(`创建包 ${pkg ?? '?'}（XS REST POST 建目录）`);
  return p;
}

/**
 * hana_repo_import：内容写入目标包；**导入内容里可能引用别的包的数据源**。
 * filePath 模式下文件内容要到服务端读取时才知道，显式标注为不确定。
 */
function planRepoImport(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_repo_import');
  const tpkg = asStr(args.targetPackageId);
  add(p.writePackages, tpkg);
  const content = asStr(args.content);
  const filePath = asStr(args.filePath);
  if (content) {
    add(p.readPackages, ...scanXmlPackageRefs(content));
    p.steps.push(`导入内联内容到包 ${tpkg ?? '?'}（落库为 inactive 设计对象）`);
  } else if (filePath) {
    p.steps.push(`导入本地文件到包 ${tpkg ?? '?'}（落库为 inactive 设计对象）`);
    p.uncertain.push('filePath 导入：文件内容要到服务端读取时才知道，其中的跨包引用未纳入本计划');
  } else {
    p.steps.push(`导入到包 ${tpkg ?? '?'}（未提供 content/filePath，实际不会发生导入）`);
  }
  if (args.overwrite === true) p.steps.push('目标文件已存在时覆盖（overwrite=true）');
  p.steps.push('导入后回读对象元数据');
  return p;
}

/**
 * hana_sql_analyze：**不写任何仓库包**（工具不碰仓库），但会读语句里出现的 schema——
 * 与 SQL 模式视图同一套扫描。plan_id 模式拿不到语句文本（文本在服务端取到），
 * 读取范围静态不可判定，如实标注；服务层取到条目后会跑同一套规则再拦一次。
 */
function planSqlAnalyze(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_sql_analyze');
  const sql = asStr(args.sql);
  const planId = args.planId;

  if (typeof planId === 'number') {
    p.steps.push(`解释计划缓存条目 PLAN_ID=${planId}（只编译不执行）`);
    p.uncertain.push(
      'plan_id 模式不解析语句文本：读取范围取决于该缓存条目本身，静态无法判定' +
        '（服务层取到条目文本后按同一套 schema 规则拦截）',
    );
  } else if (sql) {
    const refs = scanSqlSchemaRefs(sql);
    add(p.readSchemas, ...refs);
    p.steps.push(
      args.analyze === true
        ? '先实际执行该语句（30s 超时 + 最多取 100 行 + **不返回数据行**），再按文本关联计划缓存条目解释其重编译计划'
        : '编译（**不执行**）该语句',
    );
    p.steps.push(`按语句中出现的 schema 限定名核对读取范围（共 ${refs.length} 个候选，来自 FROM/JOIN 表位置）`);
    if (hasUnqualifiedTableRef(sql)) {
      p.uncertain.push('语句含未限定 schema 的表名（按当前用户默认 schema 解析，由服务层查 CURRENT_SCHEMA 后判定）');
    }
    p.uncertain.push('schema 引用按 FROM/JOIN 表位置启发式扫描；动态 SQL 与表函数内部访问不在本计划内');
  }
  // 该表**不是**只读的：EXPLAIN 会把本次的算子行写进去，且全库可读（实测），故收尾必须按名删除
  p.steps.push('执行 EXPLAIN PLAN → 向 SYS.EXPLAIN_PLAN_TABLE 写入本次算子行（该表全库可读）');
  p.steps.push('按唯一 STATEMENT_NAME 回读本次计划');
  p.steps.push('回读后按同一唯一名删除本次写入的计划行');
  return p;
}

/** 未登记专用规划器的工具：按入参约定提取，并显式标注"未规划内部实际触碰" */
function planFallback(toolName: string, args: Record<string, unknown>): WritePlan {
  const p = emptyPlan(toolName);
  const pkg = asStr(args.packageId) ?? asStr(args.targetPackageId);
  const schema = asStr(args.sourceSchema) ?? asStr(args.schema);
  add(p.writePackages, pkg);
  add(p.readSchemas, schema);
  p.steps.push(`未登记专用规划器：按入参约定提取 包 ${pkg ?? '(无)'}、schema ${schema ?? '(无)'}`);
  p.uncertain.push('该工具没有专用规划器，本次只按参数表面判定，未规划其内部实际触碰');
  return p;
}

const PLANNERS: Record<string, (args: Record<string, unknown>) => WritePlan> = {
  hana_view_create: planViewCreate,
  hana_view_update: planViewUpdate,
  hana_view_delete: planViewDelete,
  hana_view_activate: planViewActivate,
  hana_view_validate: planViewValidate,
  hana_package_create: planPackageCreate,
  hana_repo_import: planRepoImport,
  hana_sql_analyze: planSqlAnalyze,
};

/** 已登记专用规划器的工具（测试据此断言"写工具都登记了"） */
export const PLANNED_WRITE_TOOLS: readonly string[] = Object.keys(PLANNERS);

/** 为一次写调用产出计划（纯只读分析，无副作用） */
export function planWrite(toolName: string, args: Record<string, unknown>): WritePlan {
  const planner = PLANNERS[toolName];
  return planner ? planner(args) : planFallback(toolName, args);
}
