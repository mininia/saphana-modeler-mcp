import {
  hasUnqualifiedTableRef,
  objectRefsOfUpdate,
  sameObjectRef,
  scanSqlSchemaRefs,
  scanXmlObjectRefs,
  scanXmlPackageRefs,
  type ObjectRef,
  type WritePlan,
} from '../write-plan.js';
import type { CapabilityPlanner } from './types.js';

/**
 * 能力规划器实现：入参 → WritePlan（「这次调用最终会读写什么」）。
 *
 * 每个规划器说明一次调用**实际触碰**的资源。判定不在这里做——由预检层按生效权限配置判定
 * （见 src/config/preflight.ts），本模块只负责把「将要发生什么」算清楚。
 *
 * 「哪个能力用哪个规划器」**不在这里登记**：那是能力清单（`capabilities/defs/*.ts` 的
 * `effects.plan`）的事——单一事实源只有 manifest 一处。未声明规划器的能力落到
 * `planFallback`，只按参数表面判定并显式标注「未规划内部实际触碰」，不静默假装已规划。
 */

const asStr = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() !== '' ? v : undefined);

/** 取对象型参数（如 migration 声明位；schema 保证形状，规划器仍按宽松 Record 防御式读取） */
const asObj = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : undefined;

function emptyPlan(tool: string): WritePlan {
  return { tool, steps: [], writePackages: [], readSchemas: [], readPackages: [], uncertain: [] };
}

/** 去重追加 */
function add(list: string[], ...items: (string | undefined)[]): void {
  for (const it of items) {
    if (it && !list.includes(it)) list.push(it);
  }
}

/** 对象级引用的去重追加（SSD §6.2；判等用共享件 sameObjectRef，不在这里另写字段比较） */
function addRefs(list: ObjectRef[], ...items: ObjectRef[]): void {
  for (const it of items) {
    if (!list.some((x) => sameObjectRef(x, it))) list.push(it);
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
export function planViewCreate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_create');
  const pkg = asStr(args.packageId);
  const objectArg = asStr(args.objectName);
  const object = objectArg ?? '(未指定对象名)';
  const schema = asStr(args.sourceSchema);
  const source = asStr(args.sourceName);
  const script = asStr(args.script);
  // 与服务层同一判定：mode 缺省即 projection（此时 script 会被忽略，计划也不该按 SQL 模式描述）
  const isSqlMode = args.mode === 'sql';
  // 写包（packageId）与源 schema（sourceSchema）由**参数声明**派生，此处不再重复声明
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
  // 对象级写集（SSD §6.2）：新建的即是目标对象本身。参数不全时不声明——不造空引用，也不假装确定。
  if (pkg && objectArg) p.writes = [{ packageId: pkg, objectName: objectArg }];
  return p;
}

/**
 * hana_view_update：写入目标包；**operations 模式下的 join 源在另一个包**（跨包只读引用）。
 * 这是「只看 packageId 参数会漏掉」的典型——join 源写在同一调用的另一个字段里。
 */
export function planViewUpdate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_update');
  const pkg = asStr(args.packageId);
  const objectArg = asStr(args.objectName);
  const object = objectArg ?? '(未指定)';
  // changeset（SSD §6.1，P7）：与 xml/operations 三选一的多对象批次——不再是单个目标对象，
  // 各动作的读写集取并集（见文件末尾），排序与相交判定由 P7 执行侧消费。
  // 包级维度同样按"批内全部动作"取并集：writePackages = 各 action 的包（预检报告与写边界判定
  // 必须覆盖整批，见下方对象级段落）；载荷里的 schema 引用同样**逐动作扫描**并入 readSchemas
  // （与单对象通道同一套扫描器，见下方逐动作段落——漏扫 = 单对象被拦的载荷换进批次就能写）。
  const cs = asObj(args.changeset);
  const csActions = cs && Array.isArray(cs.actions) ? (cs.actions as unknown[]) : undefined;
  if (csActions) {
    p.steps.push('变更集模式（changeset）：逐动作整体预检并做对象级读写集相交检测，任一被拦或相交 ⇒ 整批拒绝、零写入');
    p.steps.push(
      `批内 ${csActions.length} 个动作，按对象名字典序执行（(packageId, objectName) 稳定排序，防 ABBA 死锁）`,
    );
  } else {
    // 写包由参数声明派生（zWritePackageId）
    p.steps.push(`读取 ${pkg ?? '?'}/${object} 的当前定义（同时取 ETag 作并发基线）`);
  }

  const ops = Array.isArray(args.operations) ? (args.operations as DeclarativeOp[]) : [];
  ops.forEach((op, i) => {
    const sp = asStr(op?.sourcePackageId);
    const so = asStr(op?.sourceObjectName);
    const kind = String(op?.op ?? '?');
    if (kind === 'set_description') {
      // 描述/显示名只改目标对象自身的展示属性（根 <descriptions defaultDescription>）：**不产生任何
      // 跨对象读引用**——readPackages/readSchemas 都不进（对象级写集就是目标对象本身，由下方
      // objectRefsOfUpdate 统一产出：它只把带源坐标的 op 当读引用，本 op 天然没有源坐标）。
      p.steps.push(
        `应用操作 ${i + 1}（set_description）：只修改 ${pkg ?? '?'}/${object} 自身的描述/显示名` +
          '（展示属性，不碰结构与取数口径、无跨对象读引用）',
      );
    } else if (kind === 'set_script') {
      // 替换脚本：只改当前视图自身（无跨包读取），但脚本内的 schema 限定名属于读取范围
      const script = asStr(op?.script);
      if (script) add(p.readSchemas, ...scanSqlSchemaRefs(script));
      p.steps.push(
        `应用操作 ${i + 1}（set_script）：替换 SQL 模式视图的脚本与输出列（重建 definition/viewAttributes/logicalModel 输出）`,
      );
      p.uncertain.push(
        `操作 ${i + 1}（set_script）：脚本内的 schema 引用按启发式扫描，未限定 schema 的表名不在本计划内`,
      );
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

  // ── 对象级读/写集（SSD §6.2，P7）──
  // 用共享件 objectRefsOfUpdate 推（不在本文件另写 URI/字段解析）：writes=目标对象；
  // reads=operations 的 join 源对象 + xml 里 resourceUri 指向的对象。
  // changeset 模式下顶层 packageId/objectName 被忽略（schema 已改为可选、批次不消费——见 defs/modeling 的
  // superRefine；资源声明层也不再把它并进 writePackages，见 capabilities/resources.ts），
  // 故对象级集合**完全由 actions 并集构成**——把顶层目标也算成"将写入"会在批外对象上造出幽灵写声明。
  const outerRefs = csActions
    ? { reads: [] as ObjectRef[], writes: [] as ObjectRef[], uncertain: [] as string[] }
    : objectRefsOfUpdate({ packageId: pkg ?? '', objectName: objectArg ?? '', xml, operations: ops });
  const writes: ObjectRef[] = [...outerRefs.writes];
  const reads: ObjectRef[] = [...outerRefs.reads];
  // 共享扫描件的降级出口（§6.2）：解析不出的引用（缺半边源坐标 / 非视图形态的 resourceUri）逐条进 uncertain，
  // 保证「解析不出」与「没有引用」可区分——单对象通道的报错文案已自带操作序号，直接透传即可。
  p.uncertain.push(...outerRefs.uncertain);
  if (csActions) {
    csActions.forEach((action, i) => {
      const rec = asObj(action);
      if (!rec) return;
      const actionPkg = asStr(rec.packageId);
      // 批内每个动作都指向它自己的包：**必须并进 writePackages**——否则预检报告会失真
      // （报告说"要写 A 包"、实际还写 B 包）。这不是新拦截维度，是同一个维度（写边界判定）算错。
      add(p.writePackages, actionPkg);
      const actionXml = asStr(rec.xml);
      const actionOps = Array.isArray(rec.operations) ? (rec.operations as unknown[]) : undefined;
      // action 级读写集用**同一共享件**推：update=目标+xml/operations 的引用；create/delete=目标本身
      // （create 的 source 是表＝schema 级读取，不是仓库对象引用；delete 没有跨对象读）。
      const r = objectRefsOfUpdate({
        packageId: actionPkg ?? '',
        objectName: asStr(rec.objectName) ?? '',
        xml: actionXml,
        operations: actionOps,
      });
      addRefs(writes, ...r.writes);
      addRefs(reads, ...r.reads);
      // 共享扫描件的降级出口（§6.2）在批内必须**点名第几项**：批是多载荷拼装，脱离定位的
      // 「解析不出的引用」无法回指到调用方的哪个 action（报告与 conflicts 的下标口径一致，从 0 数）。
      for (const note of r.uncertain) p.uncertain.push(`变更集第 ${i} 项（从 0 数）：${note}`);

      // ── 载荷 schema 扫描（SSD §1.5 登记义务③；P7 修复批）──
      // 复用单对象分支**同一套扫描器**（scanSqlSchemaRefs，不写第二份）：changeset 只是把同一份载荷
      // 装进 actions 数组，载荷里的 schema 限定引用与单对象通道逐字同源。此前这里只聚合写包与对象引用，
      // 后果是**单对象通道会被闸门以 schema_not_allowed 拦下的载荷，换进批次就能写进去**（评审实测）：
      // 服务层 assertScriptReadScopes 只查**未限定表名**（限定名归工具层预检），批内漏扫 = 读取范围静默失守。
      // 解析不出的引用（未限定表名 / 动态 SQL）照旧落 uncertain，并点名「第几项」以便调用方定位。
      const actionKind = String(rec.action ?? '?');
      if (actionKind === 'create') {
        // 与 createCalculationView 的 mode 口径一致（缺省=projection）：只扫**会被真正消费**的那份载荷
        const mode = asStr(rec.mode) ?? 'projection';
        if (mode === 'sql') {
          const script = asStr(asObj(rec.scripted)?.script);
          if (script) {
            const refs = scanSqlSchemaRefs(script);
            add(p.readSchemas, ...refs);
            p.steps.push(
              `变更集第 ${i} 项（从 0 数，create/mode=sql）：按脚本中出现的 schema 限定名核对读取范围` +
                `（共 ${refs.length} 个候选，来自 FROM/JOIN 表位置）`,
            );
            p.uncertain.push(
              `变更集第 ${i} 项（从 0 数，create/mode=sql）：脚本内 schema 引用按 FROM/JOIN 表位置启发式扫描，` +
                '未限定 schema 的表名（按当前用户默认 schema 解析）与动态 SQL 不在本计划内',
            );
          }
        } else {
          const source = asObj(rec.source);
          const schema = asStr(source?.schema);
          if (schema) {
            // 与单对象 create 通道同一语义：源 schema 走 HANA_SCHEMA_ALLOW 判定（服务层另有 assertSchemaAllowed 兜底）
            add(p.readSchemas, schema);
            p.steps.push(
              `变更集第 ${i} 项（从 0 数，create）：读取源 ${schema}.${asStr(source?.name) ?? '?'} 的列定义` +
                '（源 schema 纳入读取范围判定）',
            );
          }
        }
      } else if (actionKind === 'update' && actionXml === undefined && actionOps) {
        // update 的载荷二选一，口径与 changesetUpdatePayload 一致（xml 在场时 operations 不被消费）：
        // 只扫真正会被消费的那份，避免对不会被读取的载荷做过度声明。
        actionOps.forEach((raw, opIndex) => {
          const op = asObj(raw);
          if (op?.op !== 'set_script') return;
          const script = asStr(op.script);
          if (!script) return;
          const refs = scanSqlSchemaRefs(script);
          add(p.readSchemas, ...refs);
          p.steps.push(
            `变更集第 ${i} 项（从 0 数，update）操作 ${opIndex + 1}（set_script）：脚本内 schema 限定名纳入读取范围核对` +
              `（共 ${refs.length} 个候选）`,
          );
          p.uncertain.push(
            `变更集第 ${i} 项（从 0 数，update）操作 ${opIndex + 1}（set_script）：脚本内的 schema 引用按启发式扫描，` +
              '未限定 schema 的表名不在本计划内',
          );
        });
      }
    });
    // readPackages = 各 action 的读对象所在包，**排除已在写集里的**：批内"写 A 包的对象、读 A 包的另一对象"
    // 是同包内部依赖，不是跨包只读引用（写集里的包已由写边界判定覆盖）。
    for (const ref of reads) {
      if (!p.writePackages.includes(ref.packageId)) add(p.readPackages, ref.packageId);
    }
  }
  p.writes = writes;
  p.reads = reads;
  p.steps.push('PUT 更新设计时对象（本 SPS 实测写入即激活；activate 只决定激活失败是否作为本次失败透出）');
  // dryRun 是只读预演：追加一行说明，让调用方从计划就能看出本次不写库。
  // **写包声明刻意保留**（packageId 的参数标记派生，见 manifest 的资源派生）：预演同样要读目标对象的设计时定义
  // 并跑破坏性判定，「要对目标包有写权限才谈得上预演一次写」——不给 dryRun 开只读旁路，也避免同一次调用
  // 在两个模式下出现两套包边界口径。
  if (args.dryRun === true) {
    p.steps.push(
      '预演模式（dryRun=true）：只读当前定义并做结构 diff / 影响半径 / 破坏性判定，不发起任何写入（不 PUT、不激活、不发 probe）',
    );
  }
  // migration：破坏性变更的显式承担声明——只进回执记录，不触发任何自动迁移动作（自动改下游视图超出本服务边界）
  const migration = asObj(args.migration);
  if (migration) {
    // acknowledge_dependents 不是字段级迁移策略而是「显式承担下游破坏」的声明位（与 delete 通道同语义），
    // 文案必须分开：写成「已声明迁移策略」会把"承担破坏"误读成"有一次自动迁移"。
    const strategy = asStr(migration.strategy);
    p.steps.push(
      strategy === 'acknowledge_dependents'
        ? '已声明显式承担下游破坏（仅记录，不触发自动迁移）'
        : `已声明迁移策略 ${strategy ?? '?'}（仅记录，不触发自动迁移）`,
    );
  }
  return p;
}

/** hana_view_delete：写入目标包；下游影响半径是破坏性判定的输入（服务层按它决定放行/拒绝） */
export function planViewDelete(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_delete');
  const pkg = asStr(args.packageId);
  const objectArg = asStr(args.objectName);
  // 写包由参数声明派生
  p.steps.push(`删除 ${pkg ?? '?'}/${objectArg ?? '?'} 的设计时对象`);
  // 对象级写集（SSD §6.2）：删除的即是目标对象本身；下游依赖是 breaking 判定输入（P6 已落地），不在此展开。
  if (pkg && objectArg) p.writes = [{ packageId: pkg, objectName: objectArg }];
  // 「下游依赖会失效」不再是模糊提醒，而是判定输入的说明：服务层删前查影响半径（_SYS_REPO.ACTIVE_OBJECTCROSSREF
  // 下游闭包），有下游引用属破坏性变更——未声明 migration.strategy=acknowledge_dependents 时拒绝且不删除（零写入）。
  p.steps.push(
    '删前按影响半径判定下游引用（_SYS_REPO.ACTIVE_OBJECTCROSSREF 下游闭包）：有下游引用属破坏性变更，未声明 migration 时会被拒绝且不删除',
  );
  // 静态不可判定的部分保留在 uncertain：运行时依赖集合本计划算不出（有没有下游决定本次是否被拒），
  // 不假装能预先给出判定结果；查波及面的入口照旧。
  p.uncertain.push(
    '删除会使依赖该视图的下游对象失效：是否放行取决于运行时下游引用（由服务层按影响半径判定），可先用 hana_metadata_where_used 查波及面',
  );
  // migration：有下游引用（破坏性）时的显式承担声明——只进回执记录，不触发任何自动迁移动作
  const migration = asObj(args.migration);
  if (migration) {
    p.steps.push(`已声明迁移策略 ${asStr(migration.strategy) ?? '?'}（仅记录，不触发自动迁移）`);
  }
  return p;
}

/** hana_view_activate：写入目标包；生成 _SYS_BIC 运行时对象 */
export function planViewActivate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_view_activate');
  const pkg = asStr(args.packageId);
  // 写包由参数声明派生
  p.steps.push(`激活 ${pkg ?? '?'}/${asStr(args.objectName) ?? '?'} → 生成 _SYS_BIC 运行时列视图`);
  return p;
}

/**
 * hana_view_validate：**参数看着是「校验」，design 模式实际会写一个 _CHKTMP 临时对象**
 * （写后即删）——正是「只看工具名/描述会误判为只读」的典型；runtime 模式才是纯只读。
 */
export function planViewValidate(args: Record<string, unknown>): WritePlan {
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
  // 对象级写集**刻意不声明**（writes 留 undefined，而不是 []）：临时副本名 = 截断基名 + **进程 nonce** + _CHKTMP
  // （P5 §4.1），静态不可知——写进 writes 就是假装确定，而相交检测只应消费确定项（宁缺毋假）。
  // 如实落 uncertain；包级写声明保留（临时对象仍受包级写边界约束）。
  p.uncertain.push(
    'design 模式写入的临时副本名含进程 nonce（截断基名+短哈希+_CHKTMP），静态不可知：不进入对象级写集（相交检测不消费）',
  );
  return p;
}

/** hana_package_create：写入目标包路径 */
export function planPackageCreate(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_package_create');
  const pkg = asStr(args.packageId);
  // 写包由参数声明派生
  p.steps.push(`创建包 ${pkg ?? '?'}（XS REST POST 建目录）`);
  return p;
}

/**
 * hana_repo_import：内容写入目标包；**导入内容里可能引用别的包的数据源**。
 * filePath 模式下文件内容要到服务端读取时才知道，显式标注为不确定。
 */
export function planRepoImport(args: Record<string, unknown>): WritePlan {
  const p = emptyPlan('hana_repo_import');
  const tpkg = asStr(args.targetPackageId);
  // 写包由参数声明派生（zWritePackageId）；导入内容里的跨包引用仍需扫描，故保留 readPackages
  const content = asStr(args.content);
  const filePath = asStr(args.filePath);
  if (content) {
    add(p.readPackages, ...scanXmlPackageRefs(content));
    // 对象级读集（SSD §6.2）：内联内容里 resourceUri 指向的仓库对象可静态解析；
    // filePath 模式内容要到服务端才读到，保持既有口径落 uncertain（不声明对象级读集）。
    p.reads = scanXmlObjectRefs(content);
    p.steps.push(`导入内联内容到包 ${tpkg ?? '?'}（落库即激活，实测无 inactive 暂存）`);
  } else if (filePath) {
    p.steps.push(`导入本地文件到包 ${tpkg ?? '?'}（落库即激活，实测无 inactive 暂存）`);
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
export function planSqlAnalyze(args: Record<string, unknown>): WritePlan {
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
        ? '先实际执行该语句（单次执行最多 5 分钟 + 最多取 100 行 + **不返回数据行**），再按文本关联计划缓存条目解释其重编译计划'
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

/**
 * 兜底规划器（能力清单里未声明 `effects.plan` 时使用）。
 *
 * **只对"可能写仓库包"的能力启用**（见 manifest.planFor 的 kind 分支）：它按入参表面提取
 * `packageId`/`targetPackageId` 当**写包**，对写能力是 fail-closed 方向（漏登记 planner 时更严），
 * 但若用在读能力上就完全错了——把"读某包里的视图"当成"写那个包"，会被写边界无辜拦下。
 * 保留它的意义：让「漏登记」表现为一条显式的「未规划」结论，而不是静默按参数表面判定后放行。
 */
export function planFallback(toolName: string, args: Record<string, unknown>): WritePlan {
  const p = emptyPlan(toolName);
  const pkg = asStr(args.packageId) ?? asStr(args.targetPackageId);
  const schema = asStr(args.sourceSchema) ?? asStr(args.schema);
  add(p.writePackages, pkg);
  add(p.readSchemas, schema);
  p.steps.push(`未登记专用规划器：按入参约定提取 包 ${pkg ?? '(无)'}、schema ${schema ?? '(无)'}`);
  p.uncertain.push('该工具没有专用规划器，本次只按参数表面判定，未规划其内部实际触碰');
  return p;
}

// ── 读能力规划器（planRead，P10-b）────────────────────────────────
//
// 读能力的计划用**同一形状**：`writePackages` 恒空（读能力不写仓库包），
// 重点在 `readSchemas`——它决定 `HANA_SCHEMA_ALLOW` 在**调用期**怎么判（此前只有服务层逐点接线）。
// 只声明**能从入参静态确定**的资源；确定不了的进 `uncertain`（与写侧同一口径：不假装完整）。

/** 只有叙述的计划（资源由参数声明派生，此处不声明任何资源——避免两个真值源） */
function narrativePlan(tool: string, steps: string[], uncertain: string[] = []): WritePlan {
  const p = emptyPlan(tool);
  p.steps.push(...steps);
  p.uncertain.push(...uncertain);
  return p;
}

/**
 * 无资源维度的读能力计划（未声明 planner 的读能力用它）：写包/读 schema 都空，
 * 只说明「本能力不触碰可由入参指定的 schema」——避免落到写兜底把 packageId 当写包。
 */
export function planReadless(tool: string): WritePlan {
  return narrativePlan(tool, []);
}

/**
 * 分类门面（`hana_<分类>`）的计划：**不声明任何资源**，只说明"这次要路由到谁 / 只是取索引"。
 *
 * 为什么门面不声明资源：门面自己从不触碰 HANA。资源维度属于**目标能力**——门面 handler 在派发前
 * 会对目标能力再跑一次 `authorizeCall`（同一条判定、同一份报告，见 tools/capability.tools.ts）。
 * 这里若也声明资源，同一件事就有了两个真值源；而且门面从入参静态确定不了目标要碰什么
 * （`args` 是自由对象，按目标能力的 schema 才解析得出）。
 *
 * 未给 `capability` 的索引调用同理：它只读清单，不触碰任何资源。
 */
/**
 * 操作级条目（`<父工具>#<op>`，2026-10-10）的计划：把别名入参**还原成父工具的一次 operations 调用**，
 * 交给父工具的规划器——读写集判定不另写一份（add_join 的源包照样进 readPackages、set_script 的
 * 脚本 schema 照样进 readSchemas）。
 *
 * 入参切分：父工具身份参数（packageId/objectName 与选项 ifMatch/dryRun/migration）留在外层，
 * 其余字段即该 op 的载荷。选项参数（ifMatch/dryRun/migration）不进 op 载荷——它们是父工具通道的旋钮。
 */
export function planViewOpAlias(op: string, args: Record<string, unknown>): WritePlan {
  const { packageId, objectName, ifMatch: _ifMatch, dryRun: _dryRun, migration: _migration, ...payload } = args;
  // 刻意**不加**任何别名专属叙述：别名与父工具是同一个操作，计划文本必须逐字一致
  // （拦截文案可由调用方按字节比对；多一行叙述就会让"两条路径同一条判定"不再可证）。
  return planViewUpdate({
    packageId,
    objectName,
    operations: [{ op, ...payload }],
  });
}

/**
 * 异步任务取消（hana_task_cancel）的计划：**不声明任何资源**——它只置位进程内取消标志，
 * 不触碰 HANA（批次的实际写入/补偿都发生在任务体里，走的是既有 changeset 路径与各自的闸门）。
 * kind 是 write（暴露面控制：只读档案不该拿到取消写流程的入口），故必须声明 planner 而不是走读兜底。
 */
export function planTaskCancel(args: Record<string, unknown>): WritePlan {
  const taskId = asStr(args.taskId);
  return narrativePlan('hana_task_cancel', [
    `置位进程内任务 ${taskId ?? '?'} 的取消标志（无仓库写入）；` +
      '批次已执行项的逆序补偿由任务体按既有 changeset 路径完成（那些写入走各自的闸门，不在本次声明范围）',
  ]);
}

export function planFacade(facadeId: string): CapabilityPlanner {
  return (args) => {
    const target = asStr(args.capability);
    const p = emptyPlan(facadeId);
    p.steps.push(
      target
        ? `门面路由：本次调用的是 ${target}（读写范围由目标能力自身的计划判定）`
        : '读取本类能力索引：只读清单，不触碰任何 HANA 资源',
    );
    if (target) {
      p.uncertain.push('门面自身不声明资源；目标能力会独立跑一次同一个闸门，资源结论以那一次为准');
    }
    return p;
  };
}

/** hana_table_list：列出某 schema 的表。schema 省略时按当前用户默认 schema 解析（服务端查 CURRENT_SCHEMA） */
export function planTableList(args: Record<string, unknown>): WritePlan {
  const schema = asStr(args.schema);
  return narrativePlan(
    'hana_table_list',
    [
      schema
        ? `列出 schema ${schema} 下当前用户可访问的表（SYS.TABLES，按权限过滤）`
        : '列出**当前用户默认 schema** 下可访问的表（SYS.TABLES，按权限过滤）',
    ],
    schema ? [] : ['未给 schema：默认 schema 在服务端由 CURRENT_SCHEMA 解析后判定（本计划无法静态确定，故此处不声明）'],
  );
}

/** hana_table_columns：读某张表的列结构（schema 为必填入参） */
export function planTableColumns(args: Record<string, unknown>): WritePlan {
  const schema = asStr(args.schema);
  const table = asStr(args.table) ?? '?';
  return narrativePlan('hana_table_columns', [`读取 ${schema ?? '?'}.${table} 的列结构（SYS.TABLE_COLUMNS）`]);
}

/**
 * hana_data_preview：两种目标（与工具描述一致）。
 * - **勘察模式**（schema+table）：真实数据来自用户指定的 schema → 声明读范围；
 * - **视图预览模式**（packageId+objectName）：运行时 schema 恒为 `_SYS_BIC`（系统 schema，恒可读），
 *   故不声明读 schema；`node` 参数会走 HANA 原生中间视图机制在 `_SYS_BIC` 里**建/删临时视图**，
 *   如实写进 uncertain（当前没有任何边界能判定这类系统 schema 内的临时对象，只是不隐瞒）。
 * - `forceDerive` 的叶子基表来自**设计时 XML**（非入参），执行期逐叶子断言（preview.derive.ts）→ uncertain。
 */
export function planDataPreview(args: Record<string, unknown>): WritePlan {
  const schema = asStr(args.schema);
  const table = asStr(args.table);
  const pkg = asStr(args.packageId);
  const obj = asStr(args.objectName);
  const node = asStr(args.node);
  const uncertain: string[] = [];
  const steps: string[] = [];
  if (schema && table) {
    steps.push(`对 ${schema}.${table} 采样并逐列画像（真实数据读取；采样行数由 sampleRows 决定，不做全表统计）`);
  } else if (pkg && obj) {
    steps.push(`预览已激活视图 ${pkg}/${obj}（运行时对象在 _SYS_BIC = 系统 schema，恒可读）`);
    if (node) {
      uncertain.push(
        `node=${node}：走 HANA 原生中间视图机制，会在 _SYS_BIC 内创建临时视图 <包/对象>/dp/<节点> 并在释放后删除` +
          '（系统 schema 内的临时对象，不在任何读范围边界内，此处如实声明）',
      );
    }
    if (args.forceDerive === true) {
      uncertain.push('forceDerive：叶子基表的 schema 来自**设计时 XML**（非入参），执行期逐叶子断言，静态不可判定');
    }
  } else {
    steps.push('未给出完整的 (schema+table) 或 (packageId+objectName)：本次不会发出数据查询');
    uncertain.push('两种目标都没给全时，服务端会直接报参数错误，不产生读取');
  }
  return narrativePlan('hana_data_preview', steps, uncertain);
}

/**
 * hana_table_storage：表/列存储画像。**schema 参数此前不做任何白名单判定**（只做形状校验，
 * 省略即全库扫描）——本规划器把它纳入读范围判定的输入，是 P10-b「读范围补齐」的落点之一。
 */
export function planTableStorage(args: Record<string, unknown>): WritePlan {
  const schema = asStr(args.schema);
  const table = asStr(args.table);
  const mode = asStr(args.mode) ?? 'memory';
  return narrativePlan(
    'hana_table_storage',
    [
      schema
        ? `统计 schema ${schema}${table ? ` 的表 ${table}` : ''} 的存储画像（口径 ${mode}，只读 M_CS_*/M_TABLE_* 监视视图）`
        : `统计**当前用户可见的全部 schema** 的存储画像（口径 ${mode}，只读监视视图）`,
    ],
    schema ? [] : ['未给 schema：本次会在服务端可见的全部 schema 上统计（范围由数据库权限决定，本计划无法静态确定）'],
  );
}

/**
 * hana_repo_export：Transfer API 导出。**对仓库只读**——`packageId` 是"导出哪个包"（只读引用），
 * 绝不能被当作写包（那会让导出被写边界无辜拦下）。权限层级归 admin 后必须显式声明本规划器，
 * 否则会落到写兜底（`planFallback` 正会把 `packageId` 读成写包）。
 * `saveTo` 在**本地**写文件，不在任何 HANA 仓库边界内，如实写进 uncertain 而不是伪造成资源。
 */
export function planRepoExport(args: Record<string, unknown>): WritePlan {
  const pkg = asStr(args.packageId);
  const saveTo = asStr(args.saveTo);
  return narrativePlan(
    'hana_repo_export',
    [`导出仓库包 ${pkg ?? '?'} 为 zip（GET /base/xfer/export；对仓库只读，packageId 不参与写边界判定）`],
    [
      ...(saveTo ? [`saveTo=${saveTo}：在**本地**写文件（不在 HANA 仓库边界内，仓库侧策略不涉及它）`] : []),
      ...(pkg ? [] : ['未给 packageId：服务端会直接报参数错误，不产生导出']),
    ],
  );
}

/** hana_repo_changelist：Change-Tracking 只读审计（GET /base/change）；无写包/读 schema 维度 */
export function planRepoChangelist(args: Record<string, unknown>): WritePlan {
  const user = asStr(args.user);
  return narrativePlan('hana_repo_changelist', [
    `查询${user ? `用户 ${user} 的` : '当前用户的'}仓库变更列表（GET /base/change，只读）`,
  ]);
}

/** hana_view_check_actions：只读系统过程（SELECT SYS.GET_CHECK_ACTIONS 的动作清单）；无资源维度 */
export function planViewCheckActions(args: Record<string, unknown>): WritePlan {
  const proc = asStr(args.checkProcedureName) ?? 'CHECK_CALCULATION_VIEW';
  return narrativePlan('hana_view_check_actions', [
    `查询 CHECK 过程 ${proc} 支持的 ACTION 全集（SELECT SYS.GET_CHECK_ACTIONS，只读）`,
  ]);
}

/**
 * 「只读系统视图」类能力的叙述型规划器工厂（稳定性诊断四件套；`hana_table_storage` 另有
 * `planTableStorage`，它还要把 schema 参数纳入读范围判定）。
 *
 * 这些能力**行为只读**（仅 SELECT SYS.M_* / _SYS_STATISTICS.*），权限层级（kind）归 admin。
 * 必须显式声明：不声明会落到写兜底（按参数表面瞎猜资源）。也不声明任何资源——监视视图在系统
 * schema（恒可读面），既无写包也无用户 schema 维度。
 */
export function planSystemViewRead(tool: string, subject: string): CapabilityPlanner {
  return () =>
    narrativePlan(
      tool,
      [`只读系统视图：${subject}（按权限行级过滤；无写包/读 schema 维度）`],
      ['监视视图按权限行级过滤，权限不足时静默返回空集——覆盖缺口由结果里的 visibility/coverage 字段表达'],
    );
}

/**
 * 规划器实现（`effects.plan` 的落点）——**能力清单是唯一的事实源**：
 * 「哪个能力用哪个规划器」由 `capabilities/defs/*.ts` 的 `effects.plan` 声明，
 * 本文件只提供实现，不再自带 name → planner 的映射表（此前在 src/tools/write-plans.ts）。
 */
