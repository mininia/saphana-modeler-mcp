import { scanXmlPackageRefs, type WritePlan } from '../write-plan.js';

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

/** op=add_join 的声明式补丁（结构见 hana_view_update 的 operations schema） */
interface AddJoinOp {
  op?: unknown;
  sourcePackageId?: unknown;
  sourceObjectName?: unknown;
}

/** hana_view_create：写入目标包；读取源 schema；激活会生成 _SYS_BIC 运行时视图 */
function planViewCreate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_create');
  const pkg = asStr(args.packageId);
  const object = asStr(args.objectName) ?? '(未指定对象名)';
  const schema = asStr(args.sourceSchema);
  const source = asStr(args.sourceName);
  add(p.writePackages, pkg);
  add(p.readSchemas, schema);
  p.steps.push(`在包 ${pkg ?? '(未指定)'} 新建设计时 Calculation View ${object}`);
  if (schema && source) p.steps.push(`读取源 ${schema}.${source} 的列定义（按类型区分属性/度量）`);
  p.steps.push('生成并写入设计时 XML（XS REST PUT）');
  if (args.activate === true) p.steps.push('写入后尝试激活 → 生成 _SYS_BIC 运行时列视图');
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

  const ops = Array.isArray(args.operations) ? (args.operations as AddJoinOp[]) : [];
  ops.forEach((op, i) => {
    const sp = asStr(op?.sourcePackageId);
    const so = asStr(op?.sourceObjectName);
    const kind = String(op?.op ?? '?');
    if (sp) {
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
};

/** 已登记专用规划器的工具（测试据此断言"写工具都登记了"） */
export const PLANNED_WRITE_TOOLS: readonly string[] = Object.keys(PLANNERS);

/** 为一次写调用产出计划（纯只读分析，无副作用） */
export function planWrite(toolName: string, args: Record<string, unknown>): WritePlan {
  const planner = PLANNERS[toolName];
  return planner ? planner(args) : planFallback(toolName, args);
}
