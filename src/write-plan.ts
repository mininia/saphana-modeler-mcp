import type { PolicyRequest } from './config/preflight.js';

/**
 * 写操作预规划（WritePlan）——「先规划，后判定」。
 *
 * 为什么需要它：只从入参里抠一个 `packageId` 去判定是不够的。一次写操作真正触碰的资源
 * 比参数表面多，而这些只有把请求解析一遍才知道：
 *   - hana_view_update 的 add_join：join 源在**另一个包**（跨包只读引用），藏在 operations 里；
 *   - hana_view_validate 的 design 模式：参数看着是"校验"，实际会**写入**一个 _CHKTMP 临时对象；
 *   - hana_repo_import：导入内容里可能引用**别的包**的数据源；
 *   - hana_view_delete：被删除对象的**下游依赖会失效**（波及面）。
 *
 * 本模块只描述「会发生什么」；判定仍由预检层（config/preflight.ts）按生效权限配置做，
 * 不在这里另写一套规则。
 *
 * 声明细化到**对象级**（`reads`/`writes`）：变更集批内相交检测不能用包级粒度
 * （同包多对象的正常批次会因 writePackages 全相同被整批误拒），判定粒度必须是 `{packageId, objectName}`。
 *
 * 规划只做**只读**的分析，不产生任何副作用。
 */
export interface WritePlan {
  /** 工具名 */
  tool: string;
  /** 计划步骤（人类可读、按执行顺序），进拦截报告让调用方看清"将要发生什么" */
  steps: string[];
  /** 将写入 / 创建 / 删除的仓库包（判定依据：HANA_WRITE_PACKAGES） */
  writePackages: string[];
  /** 将读取的 schema（判定依据：HANA_SCHEMA_ALLOW） */
  readSchemas: string[];
  /**
   * 跨包只读引用（如 join 源所在包）。当前权限配置没有"可读包"这一项，
   * 故仅作为可见性信息进报告，不参与拦截。
   */
  readPackages: string[];
  /**
   * 本次将读取（引用）的仓库对象（对象级）。解析不出的引用落 uncertain，不在这里假装确定。
   * 可选：未做对象级声明的规划器/调用方不填（既有调用方零改动）。
   * 未声明（undefined）与「已声明无」（`[]`）语义不同——前者表示对象级静态不可知，后者才表示确实没有；
   * 拦截报告（formatWritePlan）按这一区别原样展示。
   *
   * **不参与拦截判定**：包级判定只消费 writePackages/readSchemas（planToRequest）；批内相交检测由
   * 执行侧（changeset.plan）用同一套推导（objectRefsOfUpdate）另行计算，不经本字段。
   */
  reads?: ObjectRef[];
  /** 本次将写入/创建/删除的仓库对象（对象级）。可选；语义与消费面同 reads（含"不参与拦截判定"）。 */
  writes?: ObjectRef[];
  /**
   * 计划无法静态确定的点。必须显式列出而不是假装确定——
   * 例如 filePath 导入的文件内容要到服务端读取时才知道。
   */
  uncertain: string[];
}

/**
 * 仓库对象引用（对象级）——批内相交检测的判定粒度。
 * 为什么必须到对象级：包级相交会把「同包多对象正常批次」整批误拒（10 个对象同包 ⇒ writePackages 全相同 ⇒ 全拒）。
 */
export interface ObjectRef {
  packageId: string;
  objectName: string;
}

/** 对象级引用判等（相交检测与去重的唯一口径；不要再各写一份字段比较） */
export function sameObjectRef(a: ObjectRef, b: ObjectRef): boolean {
  return a.packageId === b.packageId && a.objectName === b.objectName;
}

/** 计划 → 策略层的判定请求。只做映射，不做判定。 */
export function planToRequest(plan: WritePlan): PolicyRequest {
  return {
    ...(plan.writePackages.length > 0 ? { writePackages: plan.writePackages } : {}),
    ...(plan.readSchemas.length > 0 ? { schemas: plan.readSchemas } : {}),
    tools: [plan.tool],
  };
}

/** 计划 → 人类可读多行文本（进拦截报告 / 执行前日志） */
export function formatWritePlan(plan: WritePlan): string {
  // 标题用「调用预规划」而非「写操作预规划」：P10-b 起读能力也有资源计划（planRead），
  // 同一份报告要同时服务"这次会写什么"与"这次会读什么"。
  const lines = [`调用预规划（${plan.tool}）：`];
  plan.steps.forEach((s, i) => lines.push(`  ${i + 1}. ${s}`));
  lines.push(
    `  触碰资源：写包 ${plan.writePackages.length ? plan.writePackages.join(', ') : '(无)'}` +
      `；读 schema ${plan.readSchemas.length ? plan.readSchemas.join(', ') : '(无)'}` +
      `；跨包只读引用 ${plan.readPackages.length ? plan.readPackages.join(', ') : '(无)'}`,
  );
  // 对象级读写集（可选）：未声明（undefined）= 静态不可知，不印；已声明（含 `[]`）如实印出——
  // 「已声明无」与「未声明」在报告里必须可区分，否则读报告的人会把"不可知"当成"没有引用"。
  for (const [label, refs] of [
    ['写', plan.writes],
    ['读', plan.reads],
  ] as const) {
    if (refs === undefined) continue;
    const listed = refs.map((r) => `${r.packageId}/${r.objectName}`).join(', ');
    lines.push(`  对象级${label}集：${listed === '' ? '(无)' : listed}`);
  }
  for (const u of plan.uncertain) lines.push(`  [不确定] ${u}`);
  return lines.join('\n');
}

/**
 * 单份 resourceUri 扫描件：包级（`scanXmlPackageRefs`）与对象级（`scanXmlObjectRefs`）两个导出都从它派生，
 * **不得再写第二份 URI 扫描器**——两份正则必然漂移（一处改了大小写/字符集，另一处就静默漏扫）。
 * 这里只负责「取出引用值」，形态解析交给各自的投影（包级与对象级口径不同，见各自注释）。
 *
 * 两种 XML 方言形态必须都认（同一条正则的交替分支，**不是**第二份扫描器）：
 *   - **元素形态** `<resourceUri>/…</resourceUri>`：本仓生成/存储的 CV XML 就长这样
 *     （view-edit.ts 的 dataSourceBlock、view-xml.ts 的 parseDataSource 都按元素读，fixture-join-chain.xml 亦是）。
 *     只认属性形态时真实载荷里的跨对象读集**恒为空** ⇒ 批内 write∩read 冲突不判、不拒（评审实测）；
 *   - **属性形态** `resourceUri="/…"`：BW 导出样本/旧载荷的写法，既有用例保留。
 * 元素形态允许标签与值之间存在空白（值 trim 后仍须以 / 开头，与属性形态同一口径）。
 * 对合法闭合的值与「只认属性形态」的旧实现逐字等价；截断/未闭合引号的畸形 XML 旧实现会误报，这里直接跳过（更严）。
 */
function scanXmlResourceUriValues(xml: string): string[] {
  const out: string[] = [];
  const re = /[Rr]esourceUri="(\/[^"]*)"|<[Rr]esourceUri>\s*(\/[^<]*?)\s*<\/[Rr]esourceUri>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml)) !== null) {
    const value = (m[1] ?? m[2]).trim();
    if (value !== '') out.push(value);
  }
  return out;
}

/**
 * 从 XML 里扫出跨包数据源引用（`/…/` 形态的 resourceUri，元素与属性两种写法都认，见扫描件头注）。
 * 尽力而为：扫不到不影响判定。
 *
 * 口径与既有实现一致：只取**首个路径段**（本服务生成的数据源 resourceUri 用点分包 id
 * `/ZDEMO.ZDEMO_MKC/calculationviews/X`，首段即完整包名）。斜杠分段的旧格式这里只报首段——
 * readPackages 是可见性信息、不参与拦截；精确到对象的解读归 `scanXmlObjectRefs`。
 * 对合法闭合的属性值与既有实现逐字等价；截断/未闭合引号的畸形 XML 旧实现会误报，这里直接跳过（更严）。
 */
export function scanXmlPackageRefs(xml: string): string[] {
  const out = new Set<string>();
  for (const value of scanXmlResourceUriValues(xml)) {
    const m = /^\/([A-Za-z0-9_.-]+)\//.exec(value);
    if (m) out.add(m[1]);
  }
  return [...out];
}

/**
 * 视图类目录段（与 repository.service 的 KIND_URI_SEGMENT 同源枚举）：只有这些目录段下的
 * resourceUri 才认作视图对象引用，其他形态一律不认（不猜）。
 */
const VIEW_URI_SEGMENTS = new Set(['calculationviews', 'attributeviews', 'analyticviews']);

/**
 * 从 XML 里解析仓库对象引用（resourceUri → 对象级）。与包级扫描**同一个扫描件**
 * （scanXmlResourceUriValues，元素/属性两种形态都收），不另写 URI 正则/表名扫描器。
 *
 * 形态：`/包路径段…/视图目录段/对象名`
 *   - 点分包路径 `/ZDEMO.ZDEMO_MKC/calculationviews/X` → `{ packageId: 'ZDEMO.ZDEMO_MKC', objectName: 'X' }`；
 *   - 斜杠分段包路径 `/pkg/sub/calculationviews/X` → 按 metadata.service 的「/ → .」归一口径
 *     得 `{ packageId: 'pkg.sub', objectName: 'X' }`。
 *
 * 解析不出的形态（段数不足 / 目录段不是视图类 / 无前导斜杠）**跳过不猜**——
 * 对象级引用会被批内相交检测直接消费，猜错可能把正常批次误拒，或让真实冲突漏检。
 * 跳过不猜的引用**不在扫描件里静默丢弃**：带降级出口的投影（scanXmlObjectRefsWithUnresolved）
 * 把它们如实带回给调用方落 uncertain——只看 refs 时「跳过不猜」与「根本没有引用」无从区分。
 */
export function scanXmlObjectRefs(xml: string): ObjectRef[] {
  return scanXmlObjectRefsWithUnresolved(xml).refs;
}

/**
 * `scanXmlObjectRefs` 的**带降级出口**投影（同一实现的两个视图，不是第二份扫描器）：
 * 解析出的对象照旧（去重保序）；解析不出的 resourceUri 值**如实带回**给调用方逐条落自己的
 * uncertain（hana_repo_import 的内联内容分支与 objectRefsOfUpdate 都是这么用的）。
 * unresolved 按值去重（同一个解析不出的 URI 出现多处只报一条，不制造重复噪音）。
 */
export function scanXmlObjectRefsWithUnresolved(xml: string): { refs: ObjectRef[]; unresolved: string[] } {
  const refs: ObjectRef[] = [];
  const unresolved: string[] = [];
  for (const value of scanXmlResourceUriValues(xml)) {
    const ref = parseXmlResourceUri(value);
    if (!ref) {
      if (!unresolved.includes(value)) unresolved.push(value);
      continue;
    }
    if (!refs.some((r) => sameObjectRef(r, ref))) refs.push(ref);
  }
  return { refs, unresolved };
}

/** resourceUri 值 → 对象级引用；不是「包路径…/视图目录段/对象名」形态时返回 null（跳过不猜） */
function parseXmlResourceUri(value: string): ObjectRef | null {
  if (!value.startsWith('/')) return null;
  const segments = value.split('/').filter((s) => s !== '');
  if (segments.length < 3) return null; // 至少：包段 + 视图目录段 + 对象名
  const objectName = segments[segments.length - 1];
  if (!VIEW_URI_SEGMENTS.has(segments[segments.length - 2])) return null;
  const packageId = segments.slice(0, -2).join('.'); // 斜杠分段归一为点分包 id（与 metadata.service 同口径）
  if (packageId === '' || objectName === '') return null;
  return { packageId, objectName };
}

/** 非空字符串窄化（宽松入参 → 运行时判形；本文件不 import services 的类型——分层：本文件是运行期叶子） */
function nonEmptyStr(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const t = v.trim();
  return t === '' ? undefined : t;
}

/**
 * 对象级引用去重（保持先到先得的次序，保证计划输出确定性）。
 * 判等走 `sameObjectRef`——对象级判等与容器去重都只有这一处实现，规划器与批内相交检测共用。
 */
export function dedupeRefs(refs: ObjectRef[]): ObjectRef[] {
  const out: ObjectRef[] = [];
  for (const r of refs) if (!out.some((x) => sameObjectRef(x, r))) out.push(r);
  return out;
}

/**
 * 从一次 update 载荷（xml 或 operations）推出对象级读/写集（writes=目标对象本身）。
 *
 * 为什么共享在本文件：规划器与 P7 服务侧都要用它（服务层逐 action 推读写集做相交检测），
 * 放这里双方都引它、又不产生环（本文件是运行期叶子，不 import services）。
 *
 * 口径：
 * - writes = 目标对象本身；packageId/objectName 有一个为空就**不声明**（不造空引用）；
 * - reads = xml 里 resourceUri 解析出的对象 + operations 里 add_join 的源对象；
 *   set_script 只替换自身脚本，不产生跨对象引用；
 * - 只有源包没有源对象名的 join 源**不猜**对象级引用（包级引用照旧由 readPackages 承担），
 *   但**不静默**：解析不出的引用逐条落 `uncertain`（§6.2 降级口径——"不判"与"没有引用"必须可区分）。
 */
export function objectRefsOfUpdate(input: {
  packageId: string;
  objectName: string;
  xml?: string;
  operations?: unknown[];
}): { reads: ObjectRef[]; writes: ObjectRef[]; uncertain: string[] } {
  const writes: ObjectRef[] = [];
  const reads: ObjectRef[] = [];
  const uncertain: string[] = [];
  const pkg = nonEmptyStr(input.packageId);
  const objectName = nonEmptyStr(input.objectName);
  if (pkg && objectName) writes.push({ packageId: pkg, objectName });
  if (typeof input.xml === 'string') {
    const scanned = scanXmlObjectRefsWithUnresolved(input.xml);
    reads.push(...scanned.refs);
    for (const value of scanned.unresolved) {
      uncertain.push(
        `XML 里的 resourceUri "${value}" 不是「包路径…/视图目录段/对象名」形态：` +
          '无法解析为对象级引用，不参与批内相交检测（不猜）',
      );
    }
  }
  if (Array.isArray(input.operations)) {
    input.operations.forEach((raw, i) => {
      if (typeof raw !== 'object' || raw === null) return;
      const op = raw as { op?: unknown; sourcePackageId?: unknown; sourceObjectName?: unknown };
      if (op.op === 'set_script') return;
      const sp = nonEmptyStr(op.sourcePackageId);
      const so = nonEmptyStr(op.sourceObjectName);
      if (sp && so) {
        reads.push({ packageId: sp, objectName: so });
        return;
      }
      // 给了源坐标的"一半"：确实声明了引用、只是对象级解析不出 ⇒ 落 uncertain（不猜另一半）。
      // 两个字段都没给的操作不产生任何引用声明，不算"解析不出"，不在这里制造噪音。
      if (sp || so) {
        uncertain.push(
          `操作 ${i + 1}（${nonEmptyStr(op.op) ?? '未知操作'}）只给出源坐标之一` +
            `（sourcePackageId=${sp ?? '(缺)'}、sourceObjectName=${so ?? '(缺)'}）：` +
            '无法解析为对象级引用，不参与批内相交检测（不猜）',
        );
      }
    });
  }
  return { reads: dedupeRefs(reads), writes: dedupeRefs(writes), uncertain };
}

/**
 * 是否含**未限定 schema** 的表引用（`FROM <名字>` 后面不是 `.`）。
 * 这类表名由 HANA 按当前用户的默认 schema 解析——服务层据此校验那个 schema 是否在允许范围内
 * （扫描器无法得知默认 schema，故这里只做探测，解析交给服务层查 CURRENT_SCHEMA）。
 *
 * **CTE 名逐语句收集**（作用域=语句，与表名区的 `;` 语句边界同一口径，见 tableNameRegion /
 * splitSqlStatements）：CTE 只在本语句内可见。对整份脚本取并集时，前一条语句定义的 CTE 名会把
 * 后续语句里**同名的真实表**一并抑制，hasUnqualifiedTableRef 返回 false ⇒ 服务层
 * （read-scope.service）的默认 schema 白名单判定整段跳过、越界读取放行。实测：
 * `BEGIN VAR_OUT = WITH AMOUNT AS (…) SELECT * FROM AMOUNT; SELECT * FROM AMOUNT; END`
 * 里后半句的 AMOUNT 是真实表，必须按未限定表名报出（带列清单与引号名形态同理）。
 */
export function hasUnqualifiedTableRef(sql: string): boolean {
  const text = stripSqlLiteralsAndComments(sql);
  for (const stmt of splitSqlStatements(text)) {
    const ctes = collectCteNames(stmt); // 语句级作用域：不得并集到整份脚本（见上）
    const anchor = /\b(FROM|JOIN)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = anchor.exec(stmt)) !== null) {
      if (regionHasUnqualifiedName(tableNameRegion(stmt, m.index + m[0].length), ctes)) return true;
      anchor.lastIndex = m.index + m[0].length;
    }
  }
  return false;
}

/**
 * 按**顶层 `;`** 切分语句（引号标识符按 token 整体跳过——`FROM "A;B"` 里的分号不是语句边界；
 * 括号内不切）。服务于 CTE 的**语句级作用域**：WITH 定义只在本语句内可见，
 * 逐语句收集 CTE 名才不会让前一条语句的 CTE 名抑制后续语句里的同名真实表。
 *
 * 只切 `;`、**不切**语句起始关键字：关键字（如 CASE…END 的 END）会出现在单条语句内部，
 * 按它切会把同一条语句里的 CTE 名拆到两个片段、`FROM <CTE>` 被当成未限定表误报，
 * 合法脚本被默认 schema 白名单误拦；`;` 才是 SQL 语句的真正分隔符（CTE 作用域与之一致）。
 * 未闭合引号时剩余部分整段收进当前语句（与 tableNameRegion 的未闭合处理同一口径）。
 */
function splitSqlStatements(text: string): string[] {
  const out: string[] = [];
  let start = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipQuotedIdentifier(text, i);
      if (end < 0) break; // 未闭合引号：剩余部分原样收进当前语句
      i = end - 1; // -1 抵消循环自增
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth > 0) depth--;
    } else if (ch === ';' && depth === 0) {
      out.push(text.slice(start, i));
      start = i + 1;
    }
  }
  out.push(text.slice(start));
  return out;
}

/**
 * 表名区里的**每一张表**都要看，不能只看紧邻锚点的那一个：
 * `SELECT * FROM SYS.DUMMY, MARA` 里 MARA 才是未限定的那张，只看第一个会漏（评审实测）——
 * 而漏判的后果是"默认 schema 不在允许范围内"这类越界读取直接放行。
 * 按**顶层逗号**分片（括号内的逗号属于函数调用参数，不分片），每片只看头一个标识符。
 * 以 `(` 开头的分片是**括号 join**（`FROM (MARA A JOIN …)`）或子查询：括号 join 的首表没有
 * 别的锚点可见路径（`FROM (MARA …)` 里 MARA 在 FROM 锚点之后的第一个括号里），必须递归进
 * 括号内容判定；子查询不归这里管——它内部的表由自己的 FROM 锚点扫到。
 */
function regionHasUnqualifiedName(region: string, ctes: Set<string>): boolean {
  for (const part of splitTopLevel(region)) {
    const paren = leadingParen(part);
    if (paren >= 0) {
      const end = skipBalanced(part, paren);
      if (end > 0) {
        const inner = part.slice(paren + 1, end - 1);
        if (!startsWithSubquery(inner) && regionHasUnqualifiedName(inner, ctes)) return true;
      }
      continue;
    }
    const head = /^\s*(?:"([^"]+)"|([A-Za-z_][A-Za-z0-9_$#]*))\s*([.(]?)/.exec(part);
    if (!head) continue;
    const quoted = head[1] !== undefined;
    const name = quoted ? head[1] : head[2];
    const follow = head[3];
    if (follow === '.') continue; // 限定名（另有扫描）
    if (follow === '(') {
      // 表函数：**参数里也能有表名**，必须递归进去看（`APPLY_FILTER(MARA, $$X$$)` 里的 MARA
      // 若不看就等于没做"未限定表名"判定，而这类语句在 analyze=true 下会被真实执行）
      const open = part.indexOf('(', part.indexOf(name) + name.length);
      if (open >= 0 && regionHasUnqualifiedName(part.slice(open + 1), ctes)) return true;
      continue;
    }
    // 引号标识符：引号 CTE 名按大小写敏感比对（collectCteNames 对引号名原样收集）。
    // 不查 ctes 时 `WITH "B" AS (…) … FROM "B"` 会被当成未限定表名误报（合法脚本被拦）
    if (quoted) {
      if (ctes.has(name)) continue;
      return true;
    }
    const upper = name.toUpperCase();
    // DUMMY 是 SYS 下的伪表（恒 1 行）；CTE 名与保留字都不是表引用
    if (upper === 'DUMMY' || SQL_NON_SCHEMA.has(upper) || ctes.has(upper)) continue;
    return true;
  }
  return false;
}

/** 分片是否以 `(` 开头（括号 join / 子查询 / 括号包裹的表引用）；是则返回该括号的偏移，否则 -1 */
function leadingParen(part: string): number {
  let i = 0;
  while (i < part.length && /\s/.test(part[i])) i++;
  return part[i] === '(' ? i : -1;
}

/**
 * 收集 `WITH <名> [(<列清单>)] AS (` 定义的 CTE 名——它们出现在 FROM 位置时不是表引用。
 * **按单条语句调用**（文本不跨 `;`）：CTE 作用域是语句级，对整份脚本取并集会让前一条语句的
 * CTE 名抑制后续语句里的同名真实表（见 hasUnqualifiedTableRef / splitSqlStatements）。
 * 三种形态都要收（每种都对应一类实测误报）：
 * - 未引号名：按 HANA 标识符规则折成大写（未引号引用也折大写，故比对一致）；
 * - 引号名（`"B"`）：**原样**收集、比对大小写敏感（`"B"` 与 `"b"` 是不同标识符）；
 * - 带列清单（`WITH C (A) AS (…)`）：列清单是合法写法，必须跳过，否则 `FROM C` 被当成未限定表。
 * 用前视断言代替 `\b`：`\b` 在引号前不成立（前一个字符通常是非单词字符），引号名会漏收。
 */
function collectCteNames(text: string): Set<string> {
  const names = new Set<string>();
  const re = /(?<![\w$#"])([A-Za-z_][A-Za-z0-9_$#]*|"[^"]+")\s*(?:\([^)]*\))?\s+AS\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const raw = m[1];
    names.add(raw.startsWith('"') ? raw.slice(1, -1) : raw.toUpperCase());
  }
  return names;
}

/** 按顶层逗号分片（括号深度 > 0 的逗号属于函数参数，不分片） */
function splitTopLevel(region: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < region.length; i++) {
    const ch = region[i];
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth > 0) depth--;
    } else if (ch === ',' && depth === 0) {
      parts.push(region.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(region.slice(start));
  return parts;
}

/** 跳过一段配对括号，返回右括号之后的位置；不配对返回 -1 */
function skipBalanced(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')') {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** 跳过一段引号标识符（含 `""` 转义），返回收尾引号之后的偏移；未闭合返回 -1 */
function skipQuotedIdentifier(text: string, open: number): number {
  let i = open + 1;
  while (i < text.length) {
    if (text[i] === '"' && text[i + 1] === '"')
      i += 2; // "" 转义
    else if (text[i] === '"') return i + 1;
    else i++;
  }
  return -1;
}

/** 括号内容是否是子查询（派生表 / CTE 体 / LATERAL 子查询）：以 SELECT 或 WITH 开头 */
function startsWithSubquery(inner: string): boolean {
  return /^\s*(?:SELECT|WITH)\b/i.test(inner);
}

/**
 * 把**派生表/子查询**的括号内容抹成空白（保持偏移不变），并按括号内容区分其余括号：
 *
 * - **子查询**（内容以 SELECT/WITH 开头）：整段抹除。`SELECT V.A FROM (SELECT T.A FROM SYS.TAB T) V`
 *   里 `T.A` 的 `T` 是派生表的别名，不是 schema——不抹会被当成 schema 收集，而任何白名单都不可能有
 *   `T`，于是**合法语句被误拒**（实测：main 上返回 `['SYS']`，加括号扫描后变成 `['T','SYS']`）。
 *   派生表内部的表名不会因此漏掉：它自己的 `FROM` 会被锚点单独扫到（`SYS.TAB` 就在内层）。
 *   判定**以内容为先**，不看 `(` 前面是什么 token：`JOIN (SELECT …)`、`LATERAL (SELECT …)` 的
 *   `(` 前恰好是标识符字符（N/L），先前"`(` 前是标识符即函数调用"的判定会把子查询当函数参数
 *   留下，里面的别名限定列（`X.K`）被扫成 schema → 合法语句被 schema_not_allowed 硬拦（评审实测）。
 * - **非子查询括号**（表函数调用、括号 join）：**不整段抹**——表函数参数里可以有表名
 *   （`APPLY_FILTER("S"."T", …)`），括号 join 的首表更是没有别的锚点可见路径
 *   （`FROM (SECRET.T1 A JOIN ZEMP.T2 B ON …)`），抹掉等于整个表引用漏扫。
 *   改为**递归**进括号内容：表名继续参与扫描；里面若还有子查询照样按子查询抹除；
 *   并把括号 join 的 **join 条件（顶层 ON …）** 抹掉——`ON A.X=B.X` 里的限定名是列不是 schema
 *   （不抹会被当成 schema 收集，合法语句被误拒）。
 *   函数参数里的表名不会因此漏：递归同样保留它们，只有子查询与 join 条件被抹。
 */
function maskDerivedTables(region: string): string {
  let out = '';
  let i = 0;
  while (i < region.length) {
    const ch = region[i];
    if (ch === '"') {
      // 引号标识符按 token 整体跳过：内容里的 `(`、`ON`、逗号都不是语法结构
      const end = skipQuotedIdentifier(region, i);
      if (end < 0) {
        out += region.slice(i); // 未闭合引号：原样保留，交给后续扫描
        break;
      }
      out += region.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '(') {
      const end = skipBalanced(region, i);
      if (end > 0) {
        const inner = region.slice(i + 1, end - 1);
        if (startsWithSubquery(inner)) {
          out += ' '.repeat(end - i); // 子查询：整段抹除
          i = end;
          continue;
        }
        out += '(' + maskDerivedTables(inner) + ')'; // 表函数/括号 join：递归保留表名、抹条件
        i = end;
        continue;
      }
    }
    // 括号 join 底下的 join 条件：顶层 ON 之后整段抹掉（`ON A.X=B.X` 的限定名是列不是 schema）。
    // 表名区扫描（tableNameRegion）已把顶层 ON 截断，这里处理的是冒泡进括号 join 内容的条件；
    // 条件里出现的表名都有自己的 FROM/JOIN 锚点兜底，不会漏。
    if (
      (ch === 'O' || ch === 'o') &&
      (i === 0 || !/[A-Za-z0-9_$#]/.test(region[i - 1])) &&
      /^ON(?![A-Za-z0-9_$#])/i.test(region.slice(i))
    ) {
      const resume = skipJoinCondition(region, i + 2);
      const stop = resume < 0 ? region.length : resume - 1; // 逗号本身保留：它是表名区的分片符
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/**
 * 跳过 `AS` 之后的别名（标识符或引号标识符）。**不能把 `AS` 当成表名区的终点**：
 * `SELECT * FROM SYS.DUMMY AS D, SECRET.T2` 里第一个 AS 之后就截断，逗号列表里后面的表
 * 对扫描器完全不可见（实测 refs 只有 `['SYS']`，SECRET 逃过白名单判定）。
 * 只跳过别名本身，后面的表继续可见；别名里的点（`AS "a.b"`）也不会被当成 schema。
 */
function skipAlias(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i])) i++;
  if (text[i] === '"') {
    i++;
    while (i < text.length && text[i] !== '"') i++;
    return text[i] === '"' ? i + 1 : i;
  }
  while (i < text.length && /[A-Za-z0-9_$#]/.test(text[i])) i++;
  return i;
}

/**
 * 表名区 = FROM/JOIN 锚点之后，到**顶层**子句边界为止。
 *
 * 为什么要跟踪括号深度而不是见到 `(`/`)` 就切：表函数与派生表的表名都在括号里——
 * `APPLY_FILTER("SAPSR3"."MARA", $$X=1$$)`、`CE_COLUMN_TABLE("S"."T")`、`(SELECT * FROM C.T)`，
 * 早切会让它们整体逃过扫描（评审实测：这是读边界被绕过的一类写法）。顶层边界仍然是
 * ON/WHERE/GROUP/… 与语句结尾；顶层的 `=` 也切（旧行为，保留）；`AS` 只跳别名不截断（见 skipAlias）。
 *
 * `ON` 不是**整段**表名区的终点：`JOIN … ON 条件, SECRET.T3` 里 ON 之后的顶层逗号列表仍可能有
 * 表引用（标准 SQL 的 FROM 逗号列表允许在 join 链之后再以逗号追加表），命中 ON 时越过条件表达式、
 * 在下一个顶层逗号处恢复扫描（条件本身不参与扫描——里面的 `A.X` 是列不是 schema）。
 * 引号标识符按 token 整体跳过：`FROM "ON"."T"` 的引号名里出现子句关键字不能截断表名区。
 *
 * **语句边界**：`;` 与语句起始关键字（STATEMENT_KEYWORD，如 BEGIN/END/SELECT）在顶层同样收住——
 * 表名区不得跨语句。多语句过程体（`BEGIN … ; … END`）里每条语句有自己的 FROM/JOIN 锚点，
 * 表名区越过边界后会把后续语句的列限定名/列名当成表引用（实测：合法脚本被闸门误拒）；
 * 后续语句自己的表引用由它自己的锚点扫到，在这里收住不会漏。
 *
 * WITH/FOR **不是**边界：它们是**表引用子句关键字**（`WITH HINT(…)` / `WITH PARAMETERS(…)` /
 * `FOR SYSTEM_TIME AS OF …`），出现在表名区里表示表级子句、不是新语句的起点，须继续扫其后的
 * 顶层逗号列表（`FROM SYS.T1 WITH HINT(NO_INLINE), SECRET.T2` 的 SECRET 不能漏；见 STATEMENT_KEYWORD 注）。
 */
function tableNameRegion(text: string, start: number): string {
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipQuotedIdentifier(text, i);
      if (end < 0) return text.slice(start); // 未闭合引号：整段原样收下
      i = end - 1; // -1 抵消循环自增；引号内容不参与关键字判定
      continue;
    }
    if (ch === '(') {
      depth++;
      continue;
    }
    if (ch === ')') {
      if (depth === 0) return text.slice(start, i);
      depth--;
      continue;
    }
    if (depth === 0 && ch === ';') return text.slice(start, i); // 语句边界：表名区不跨语句
    if (depth === 0 && ch === '=') return text.slice(start, i);
    if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      CLAUSE_KEYWORD.lastIndex = i;
      if (CLAUSE_KEYWORD.test(text)) {
        if (/^AS(?![A-Za-z0-9_$#])/i.test(text.slice(i))) {
          // AS 不是终点：跳过它和紧跟的别名，继续扫同一张表名区里后面的表
          return text.slice(start, i) + ' ' + tableNameRegion(text, skipAlias(text, i + 2));
        }
        if (/^ON(?![A-Za-z0-9_$#])/i.test(text.slice(i))) {
          // ON 条件之后的顶层逗号列表里还有表（`… ON a=b, SECRET.T3`）：越过条件，从逗号后恢复扫描
          const resume = skipJoinCondition(text, i + 2);
          if (resume >= 0) return text.slice(start, i) + ', ' + tableNameRegion(text, resume);
        }
        return text.slice(start, i);
      }
      STATEMENT_KEYWORD.lastIndex = i;
      if (STATEMENT_KEYWORD.test(text)) return text.slice(start, i); // 语句起始关键字：同样收住
    }
  }
  return text.slice(start);
}

/** 表名区的顶层子句边界关键字（粘性匹配：只在当前位置判定，避免把 `ONYX` 当 `ON`） */
const CLAUSE_KEYWORD = /\b(?:ON|WHERE|GROUP|ORDER|HAVING|UNION|EXCEPT|INTERSECT|AS)\b/iy;

/**
 * 语句起始关键字——表名区与 ON 恢复扫描的**语句边界**（与 `;` 同一口径，仅深度 0 生效）。
 *
 * 为什么需要：SQLScript 过程体 / SQL 模式视图 <definition> 是多语句脚本（语句以 `;` 分隔），
 * 每条语句有自己独立的 FROM/JOIN 锚点。表名区（或 ON 恢复扫描）越过语句边界后，会把后续语句里的
 * 列限定名（`X.COL`）、select 列表头当成表引用 —— 扫出假 schema / 假未限定表名，合法脚本被
 * 闸门误拒（多语句过程体实测）。字符串与注释已被剥离、引号标识符整 token 跳过，因此表位置上的
 * 这些词只可能是新语句的起点；本语句自己的表引用都在边界之前，收住不会漏扫。
 * `END` 例外（CASE 表达式的收尾）见 skipJoinCondition 的深度计数。
 *
 * **WITH / FOR 故意不在此列**（独立复核 ①–④：把两者并进来手段过宽）：它们同时是**表引用子句关键字**
 * —— `WITH HINT(…)` / `WITH PARAMETERS(…)` / `FOR SYSTEM_TIME AS OF …`（以及 `FOR UPDATE`）跟在
 * FROM 表引用之后，是**表级子句**而不是新语句的起点。区分口径：本文件只在 FROM/JOIN 锚点**之后**的
 * 表名区里做关键字判定，而真正的语句起点前面必有 `;`（已单独收住，或就是扫描起点）——所以表名区里
 * 出现的 WITH/FOR 不可能是语句起点，遇到它们应**继续扫**其后的顶层逗号列表。当硬边界用的后果：
 * `… WITH HINT(NO_INLINE), SECRET.T2` 里逗号追加的 SECRET 整体漏扫，schema 白名单可再次被绕过。
 */
const STATEMENT_KEYWORD =
  /\b(?:SELECT|INSERT|UPDATE|UPSERT|DELETE|MERGE|CREATE|DROP|ALTER|TRUNCATE|CALL|DO|BEGIN|END|IF|WHILE|LOOP|RETURN|DECLARE|EXPORT|IMPORT|GRANT|REVOKE|EXPLAIN|SET)\b/iy;

/**
 * 从 join 条件处（`ON` 关键字之后）扫到**下一个顶层逗号**——那里恢复表名区扫描（逗号列表的下一张表）。
 * 条件表达式里的逗号都在括号内（depth > 0）不分片；引号标识符里的内容（含逗号）按 token 跳过。
 * 条件之后没有表引用时（下一个是其他子句、回到外层括号或语句结尾）返回 -1，表名区照旧在此结束。
 *
 * **语句边界**：`;` 与语句起始关键字（STATEMENT_KEYWORD）同样返回 -1 —— 恢复扫描不得跨语句
 * （跨过去会在后续语句里找到顶层逗号并恢复表名区扫描，后续语句的列名/列限定名被当成表引用，
 * 合法脚本被误拒）。`END` 例外：它可能是 ON 条件里 CASE 表达式的收尾（不是语句边界），
 * 用 CASE 深度计数区分——带 `CASE…END` 的条件之后，顶层逗号列表仍要恢复扫描（2.2 修复不退化）。
 * 表引用子句关键字是 WITH/FOR 时同样不收住（它们不在 STATEMENT_KEYWORD 里，见其注）：
 * 条件之后跟着表级子句时，继续找其后的顶层逗号列表。
 */
function skipJoinCondition(text: string, from: number): number {
  let depth = 0;
  let caseDepth = 0; // ON 条件里未闭合的 CASE 数（只在深度 0 计数）
  for (let i = from; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') {
      const end = skipQuotedIdentifier(text, i);
      if (end < 0) return -1;
      i = end - 1; // -1 抵消循环自增
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) return -1; // 回到外层括号：条件之后没有逗号列表
      depth--;
    } else if (ch === ',' && depth === 0) return i + 1;
    else if (ch === ';' && depth === 0)
      return -1; // 语句边界：恢复扫描不得跨语句
    else if (depth === 0 && /[A-Za-z_]/.test(ch)) {
      CLAUSE_KEYWORD.lastIndex = i;
      // ON 例外：join 链可以不带逗号直接接下一个 ON（`… ON x JOIN C ON y, SECRET.T`），
      // 越过它继续找顶层逗号；其余子句关键字说明条件之后不会再跟表引用，就此收住。
      if (CLAUSE_KEYWORD.test(text) && !/^ON(?![A-Za-z0-9_$#])/i.test(text.slice(i))) return -1;
      if (/^CASE(?![A-Za-z0-9_$#])/i.test(text.slice(i))) {
        caseDepth++; // CASE…END 的收尾 END 不是语句边界（见函数头注）
        continue;
      }
      STATEMENT_KEYWORD.lastIndex = i;
      if (!STATEMENT_KEYWORD.test(text)) continue;
      if (/^END(?![A-Za-z0-9_$#])/i.test(text.slice(i)) && caseDepth > 0) caseDepth--;
      else return -1; // 语句起始关键字：条件扫描不跨进下一条语句
    }
  }
  return -1;
}

/** SQL 里不会作为 schema 出现的保留字（表位置上的兜底过滤） */
const SQL_NON_SCHEMA = new Set([
  'SELECT',
  'FROM',
  'WHERE',
  'GROUP',
  'ORDER',
  'HAVING',
  'INTO',
  'VALUES',
  'UNION',
  'EXCEPT',
  'INTERSECT',
  'LATERAL',
  'DUMMY',
  'CURRENT_USER',
  'SESSION_USER',
]);

/**
 * 去掉 SQL 字符串字面量与注释（避免把 'ABC.DEF' / `-- X.Y` 里的点当成 schema 限定）。
 *
 * 用**单遍状态机**而不是连续 replace：正则顺序敏感——先剥 `--` 行注释会把 `'a--b'` 里的
 * 字面量后半行一并吃掉（实测：`SELECT 'a--b' AS X ... FROM SAPSR3.T` 会扫不出 SAPSR3，
 * 读边界因此静默放行）。状态机同时正确处理引号内的 `--`、注释里的引号与 `''` 转义。
 *
 * 导出给 SQL 分析工具复用：语句分类（首 token）与分号校验都必须跑在剥离后的文本上，
 * 否则 `SELECT 'a;b' FROM T` 会被误判成多语句。**不要再写第二份剥离实现**。
 */
export function stripSqlLiteralsAndComments(sql: string): string {
  let out = '';
  let i = 0;
  while (i < sql.length) {
    const c = sql[i];
    const next = sql[i + 1];
    if (c === "'") {
      i++; // 跳过起始引号
      while (i < sql.length) {
        if (sql[i] === "'" && sql[i + 1] === "'")
          i += 2; // '' 转义
        else if (sql[i] === "'") {
          i++;
          break;
        } else i++;
      }
      out += "''";
      continue;
    }
    // 双引号标识符必须**原样保留**（扫描器要读它），但它的内容要按标识符处理：
    // 里面的单引号 / $$ / -- 都不是字面量或注释的起始。缺这一段时
    // `SELECT "a'b" AS X, B.* FROM "SAPSR3"."MARA" B` 会被那个孤立的单引号吞掉后半句，
    // 两个扫描器都看不到 FROM，读边界静默放行（评审实测）。
    if (c === '"') {
      const start = i;
      i++;
      while (i < sql.length) {
        if (sql[i] === '"' && sql[i + 1] === '"')
          i += 2; // "" 转义
        else if (sql[i] === '"') {
          i++;
          break;
        } else i++;
      }
      out += sql.slice(start, i);
      continue;
    }
    if (c === '-' && next === '-') {
      // 行注释终止于 LF 或 CR（只认 LF 时，CR 结尾的一行会把后续语句一起吞成"注释"，
      // 多语句判定随之失效，但送去执行的是原文 —— 评审实测的洞）
      while (i < sql.length && sql[i] !== '\n' && sql[i] !== '\r') i++;
      out += ' ';
      continue;
    }
    if (c === '/' && next === '*') {
      i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    if (c === '$' && next === '$') {
      i += 2;
      while (i < sql.length && !(sql[i] === '$' && sql[i + 1] === '$')) i++;
      i += 2;
      out += ' ';
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * 从 SQL 脚本里扫出 schema 引用（`FROM SCHEMA."表"` / `JOIN "schema".t` / 逗号列表内的后续表）。
 *
 * 三条规则（每条都对应一类真实误判，松紧都必须在两个方向上都验）：
 * 1. 先剥掉字符串字面量与注释——否则 `'ABC.DEF'`、`-- 参考 X.Y` 里的 token 会被当成 schema；
 * 2. 只认**表位置**（`FROM` / `JOIN` 之后到子句边界之间）的限定名：别名限定列（`SRC.COL`）与
 *    CTE 名（`WITH BASE AS … SELECT BASE.X`）不是 schema，误报会把合法调用硬拦在预检；
 * 3. 引号形式（`"SAPSR3"."MARA"`）与大小写写法都要识别（引号内保留原样、未加引号按 HANA 规则折成大写）：
 *    只认全大写未加引号会漏掉 `"SAPSR3"."MARA"` = 读边界被绕过。
 *
 * 多语句脚本（SQLScript 过程体 `BEGIN … END`）**逐语句扫描**：表名区止于语句边界（`;` 与
 * 语句起始关键字，见 tableNameRegion），每条语句的表引用由它自己的 FROM/JOIN 锚点扫到——
 * 越过语句边界会把后续语句的列限定名（`X.COL`）扫成假 schema，合法脚本被闸门误拒。
 * `WITH HINT` / `WITH PARAMETERS` / `FOR SYSTEM_TIME AS OF` 这类**表引用子句关键字**不是语句边界：
 * 它们之后的顶层逗号列表（逗号追加的表）仍照扫（见 STATEMENT_KEYWORD 注）。
 *
 * 仍不覆盖（在计划里以「不确定」显式标注，不假装完整）：未限定 schema 的表名（服务端按当前用户默认
 * schema 解析）与动态 SQL。
 */
export function scanSqlSchemaRefs(sql: string): string[] {
  const text = stripSqlLiteralsAndComments(sql);
  const out = new Set<string>();
  const anchor = /\b(FROM|JOIN)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = anchor.exec(text)) !== null) {
    // 表名区 = 锚点之后到**顶层**子句边界（表函数里括号内的表名同样要扫，见 tableNameRegion）；
    // 派生表/子查询的括号内容先抹掉——那里的 `T.A` 是别名限定列不是 schema，抹掉前会误拒合法语句
    // （它内部的表由自己的 FROM 锚点扫到，不会漏）
    collectQualifiedRefs(maskDerivedTables(tableNameRegion(text, m.index + m[0].length)), out);
    anchor.lastIndex = m.index + m[0].length;
  }
  return [...out];
}

/**
 * 扫表名区里的限定名（`SCHEMA.表` / `"SCHEMA"."表"`）。
 *
 * 必须按**标识符 token** 走，不能拿"名字后面跟点"的正则在整个区里找：
 * 引号标识符的内容里可以有任意字符，包括点——`"_SYS_BIC"."PKG/VIEW"`（HANA 运行时视图名的常见形态）
 * 会被正则当成 `_SYS_BIC` 与 `PKG` 两个限定名，凭空多出一个越界的假 schema（实测被策略层拦下）。
 * 所以：引号内的字符只按"引号标识符"整体处理，只有紧跟其后的 `.` 才算限定符。
 */
/** 前一个非空白字符（越界返回 undefined） */
function prevNonSpace(region: string, pos: number): string | undefined {
  let k = pos - 1;
  while (k >= 0 && /\s/.test(region[k])) k--;
  return k >= 0 ? region[k] : undefined;
}

/** 后一个非空白字符（越界返回 undefined） */
function nextNonSpace(region: string, pos: number): string | undefined {
  let k = pos;
  while (k < region.length && /\s/.test(region[k])) k++;
  return k < region.length ? region[k] : undefined;
}

function collectQualifiedRefs(region: string, out: Set<string>): void {
  let i = 0;
  // 多段名里只有**第一段**是 schema：`SCHEMA1.T1.COL` / `"S"."A--B"."C"` 的后续段不算 schema，
  // 否则会多扫出假 schema（如把列名当 schema），把合法调用挡在预检外。
  //
  // 两个判断都只看**紧邻的一个非空白字符**，所以用 prevNonSpace/nextNonSpace 前后扫，**不做切片**：
  // 早先写成 `!/\.\s*$/.test(region.slice(0, pos))` 与 `/^\s*\./.test(region.slice(j))`，每个标识符
  // 拷贝两次整段文本 → 整趟扫描是 O(标识符数 × 区域长度)。实测（本机）：限定名 1000/2000/4000/8000
  // 个 → 6.9/20.2/76.1/329.0 ms（每翻倍约 4×），10 万字符的语句单次 303 ms，而 hana_sql_analyze
  // 每次调用要跑两遍 → 约 0.6 s 的**同步**计算，HTTP 模式下会把整个进程的并发请求一起卡住。
  // 表名区扫描范围扩大（函数参数、AS 之后的表）后这个平方项才变得显眼，故改为零分配的前后扫。
  const isFirstSegment = (pos: number): boolean => prevNonSpace(region, pos) !== '.';
  while (i < region.length) {
    const ch = region[i];
    if (ch === '"') {
      const start = i + 1;
      let j = start;
      while (j < region.length) {
        if (region[j] === '"' && region[j + 1] === '"')
          j += 2; // "" 转义
        else if (region[j] === '"') break;
        else j++;
      }
      const name = region.slice(start, j);
      const next = j + 1; // 跳过收尾引号
      if (name !== '' && nextNonSpace(region, next) === '.' && isFirstSegment(i)) out.add(name);
      i = next;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < region.length && /[A-Za-z0-9_$#]/.test(region[j])) j++;
      const upper = region.slice(i, j).toUpperCase();
      if (nextNonSpace(region, j) === '.' && !SQL_NON_SCHEMA.has(upper) && isFirstSegment(i)) out.add(upper);
      i = j;
      continue;
    }
    i++;
  }
}
