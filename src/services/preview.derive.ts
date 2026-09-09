import { HanaBusinessError } from '../core/errors.js';
import { assertSafeRuntimeName, assertSchemaAllowed, qualifyName, quoteIdentifier, quoteLiteral } from '../core/sql.js';
import type { ViewDataSource, ViewDefinition, ViewNode, ViewNodeMeasure } from '../model/view-types.js';

/**
 * 节点级数据预览的 SQL 推导（方案 B：依据视图 XML 直接推导，纯只读）。
 *
 * 与 HANA Studio「点击节点 Data Preview 临时建 SQL 虚拟视图」不同：这里不建任何对象，
 * 直接从已解析的 ViewDefinition 自底向上重构成一条嵌套 SELECT，直查基表/引用运行时视图。
 * 好处：零 DDL、零残留、零新增权限；局限：覆盖面受限（见 SUPPORTED_TYPES）。
 *
 * 支持：ProjectionView / JoinView（2 输入，inner/left/right/full outer）/
 *       AggregationView（GROUP BY + sum/count/min/max/avg）/ UnionView / RankView（分组取前 N 条）
 * 明确不支持：SqlScriptView（脚本节点，按需求不解析脚本）、其他
 *
 * 列裁剪（优化 SQL 长度）：从目标节点自顶向下传播「需求列」——中间节点只 SELECT
 * 父级真正需要的输出列，叶子按需选列（不再 SELECT *）；聚合/Join/Rank 的语义必需列
 * （分组/度量/关联键/窗口分组排序）不受裁剪影响，保证结果正确。
 *
 * 纯函数：输入 ViewDefinition + 目标节点 ID，输出可执行的 SELECT（无外层 LIMIT）。
 */
export interface DerivedNodeSql {
  /** 节点 SELECT（不含外层 LIMIT，外层由调用方包裹 + 绑定用户筛选） */
  sql: string;
  /** 预留：参数绑定（当前推导全部内联 XML 字面量，无用户值） */
  params: unknown[];
  /** 节点输出列（顺序稳定） */
  columns: string[];
  /** 节点类型（如 ProjectionView） */
  nodeType: string;
}

const SUPPORTED_TYPES = new Set(['ProjectionView', 'JoinView', 'AggregationView', 'UnionView', 'RankView']);

/** Join 类型映射：HANA XML 方言驼峰（leftOuter/rightOuter/fullOuter），兼容带空格小写 */
const JOIN_TYPE_MAP: Record<string, string> = {
  inner: 'INNER JOIN',
  leftouter: 'LEFT OUTER JOIN',
  rightouter: 'RIGHT OUTER JOIN',
  fullouter: 'FULL OUTER JOIN',
};

const AGG_MAP: Record<string, string> = {
  sum: 'SUM',
  count: 'COUNT',
  min: 'MIN',
  max: 'MAX',
  avg: 'AVG',
};

/** 输入参数/变量引用（$$IP$$ 与 $IP$ 两种形态，BW 变量亦适用） */
const VAR_RE = /\$\$[A-Za-z_][A-Za-z0-9_.]*\$\$|\$[A-Za-z_][A-Za-z0-9_.]*\$/;

/** 派生视图节点 SQL。@throws HanaBusinessError：节点不存在/类型不支持/图不完整/含变量 */
export function deriveNodeSql(def: ViewDefinition, nodeId: string): DerivedNodeSql {
  const target = def.nodes.find((n) => n.id === nodeId);
  if (!target) {
    throw new HanaBusinessError(
      `视图 ${def.id} 中未找到节点 ${nodeId}。可先用 hana_metadata_list_fields 查看节点清单确认 ID`,
    );
  }
  assertSupportedNode(target);

  const nodeMap = new Map(def.nodes.map((n) => ['#' + n.id, n] as const));
  const dsMap = new Map(def.dataSources.map((d) => ['#' + d.id, d] as const));

  // 自底向上拓扑收集：后序 DFS，目标节点可达的全部节点/数据源
  const visited = new Set<string>();
  const order: ViewNode[] = [];
  const visit = (ref: string, stack: Set<string>): void => {
    if (stack.has(ref)) throw new HanaBusinessError(`节点图存在循环引用（${ref}），无法推导节点预览`);
    if (visited.has(ref)) return;
    if (nodeMap.has(ref)) {
      const n = nodeMap.get(ref)!;
      visited.add(ref);
      stack.add(ref);
      for (const inp of n.inputs) visit(inp.node, stack);
      stack.delete(ref);
      order.push(n);
    } else if (dsMap.has(ref)) {
      visited.add(ref); // 叶子数据源
    } else {
      throw new HanaBusinessError(`节点 ${nodeId} 引用了不存在的输入（${ref}），无法推导节点预览`);
    }
  };
  visit('#' + nodeId, new Set());

  // 变量/输入参数检查 + SQL 注入标记防护（推导路径不支持；先于生成 SQL，给出明确指引）
  // - 变量/输入参数：$$IP$$ 与 $IP$
  // - 注入标记：; / -- / /*（多语句已被 HANA 驱动拒绝，此处一并拦截作纵深防御；
  //   注释可改变单语句内 WHERE 语义，拒绝含此类标记的表达式片段）
  const INJECT_RE = /;|\/\*|--/;
  for (const n of order) {
    const frags = [n.filter, ...n.calculatedAttributes.map((ca) => ca.formula)].filter((f): f is string => !!f);
    for (const frag of frags) {
      const m = frag.match(VAR_RE);
      if (m) {
        throw new HanaBusinessError(
          `节点 ${n.id} 含输入参数/变量引用（${m[0]}），节点推导预览暂不支持变量；` +
            `可去掉 node 对视图整体预览（VIRTUAL 视图用 parameters 传入变量值）`,
        );
      }
      const inj = frag.match(INJECT_RE);
      if (inj) {
        throw new HanaBusinessError(
          `节点 ${n.id} 的表达式中含非法字符（${JSON.stringify(inj[0])}），出于安全考虑拒绝推导节点预览`,
        );
      }
    }
  }

  // ==== 列裁剪：自顶向下传播「需求列」 ====
  // emitCols[ref] = 该节点 SELECT 必须产出的输出列（有序）；leafNeed[ref] = 叶子需提供的列（有序，空=SELECT *）
  const emitCols = new Map<string, string[]>();
  const leafNeed = new Map<string, string[]>();
  const targetRef = '#' + nodeId;
  emitCols.set(targetRef, outputColumns(target));

  const propagate = (ref: string): void => {
    const n = nodeMap.get(ref);
    if (!n) return;
    const E = new Set(emitCols.get(ref) ?? []);
    const perInput = n.inputs.map(() => new Set<string>());

    // 1) 本节点输出列 → 各输入源列（经输入映射；BW 常见重命名）
    //    Union 例外：输入无映射，列按名对齐，直接把本节点输出列传给每个输入
    if (n.type === 'UnionView') {
      n.inputs.forEach((_, idx) => {
        for (const c of E) perInput[idx].add(c);
      });
    } else {
      n.inputs.forEach((inp, idx) => {
        for (const m of inp.mappings) if (E.has(m.target)) perInput[idx].add(m.source);
      });
    }
    // 2) 节点自身引用的列（filter/formula/属性过滤）→ 输入源列
    for (const c of referencedColumns(n)) {
      let mapped = false;
      n.inputs.forEach((inp, idx) => {
        const m = inp.mappings.find((mm) => mm.target === c);
        if (m) {
          perInput[idx].add(m.source);
          mapped = true;
        }
      });
      if (!mapped && n.inputs.length === 1) perInput[0].add(c);
    }
    // 3) Join 关联键 / Rank 窗口分组排序：在输入侧直接引用，输入必须提供
    n.joinAttributes.forEach((j) => {
      n.inputs.forEach((inp, idx) => {
        const m = inp.mappings.find((mm) => mm.target === j);
        perInput[idx].add(m ? m.source : j);
      });
    });
    if (n.type === 'RankView' && n.rank) {
      for (const c of [...n.rank.partitionBy, ...n.rank.orderBy.map((o) => o.column)]) {
        n.inputs.forEach((inp, idx) => {
          const m = inp.mappings.find((mm) => mm.target === c);
          perInput[idx].add(m ? m.source : c);
        });
      }
    }

    // 写回并递归
    n.inputs.forEach((inp, idx) => {
      const need = perInput[idx];
      if (dsMap.has(inp.node)) {
        leafNeed.set(inp.node, [...need]);
        return;
      }
      const child = nodeMap.get(inp.node)!;
      const childE = new Set(emitCols.get(inp.node) ?? []);
      for (const c of need) childE.add(c);
      // 聚合语义必需：分组列与度量必须全部产出（保证聚合粒度正确）
      if (child.type === 'AggregationView') {
        for (const g of aggGroupBy(child)) childE.add(g);
        for (const m of aggMeasures(child)) childE.add(m.column);
      }
      emitCols.set(inp.node, outputColumns(child).filter((c) => childE.has(c)));
      propagate(inp.node);
    });
  };
  propagate(targetRef);

  // ==== 自底向上生成（emit 决定 SELECT 列；leafNeed 决定叶子选列） ====
  const memo = new Map<string, string>();
  const gen = (ref: string): string => {
    const cached = memo.get(ref);
    if (cached) return cached;
    if (dsMap.has(ref)) {
      const sql = leafSql(dsMap.get(ref)!, leafNeed.get(ref));
      memo.set(ref, sql);
      return sql;
    }
    const sql = `( ${nodeSql(nodeMap.get(ref)!, gen, emitCols.get(ref) ?? [])} )`;
    memo.set(ref, sql);
    return sql;
  };

  const sql = nodeSql(target, gen, emitCols.get(targetRef) ?? []);
  const columns = outputColumns(target);
  return { sql, params: [], columns, nodeType: target.type };
}

function assertSupportedNode(node: ViewNode): void {
  if (node.type === 'SqlScriptView') {
    throw new HanaBusinessError(
      `节点 ${node.id} 为 SqlScriptView（脚本节点），按约定不解析脚本，不支持节点预览；可改为对视图整体预览`,
    );
  }
  if (node.type === 'RankView' && !node.rank) {
    throw new HanaBusinessError(`节点 ${node.id} 为 RankView 但缺少 windowFunction 定义，无法推导`);
  }
  if (!SUPPORTED_TYPES.has(node.type)) {
    throw new HanaBusinessError(`节点 ${node.id} 类型 ${node.type} 暂不支持推导预览`);
  }
}

/** 叶子数据源：基表（DATA_BASE_TABLE）或外部计算视图（CALCULATION_VIEW，引用其 _SYS_BIC 运行时对象）；按需选列 */
function leafSql(ds: ViewDataSource, need: string[] | undefined): string {
  const cols = need && need.length > 0 ? need.map((c) => quoteIdentifier(c)).join(', ') : '*';
  if (ds.type === 'DATA_BASE_TABLE' && ds.schemaName && ds.columnObjectName) {
    // 纵深防御：叶子表 schema 走白名单（SAPABAP1 等）；不在白名单提示用 HANA_SCHEMA_ALLOW 追加
    // BW on HANA：XML 中 schemaName="ABAP" 是源系统名而非数据库 schema，真实表在 SAPABAP1
    const schema = ds.schemaName === 'ABAP' ? 'SAPABAP1' : ds.schemaName;
    try {
      assertSchemaAllowed(schema);
    } catch {
      throw new HanaBusinessError(
        `叶子表 schema "${schema}" 不在允许列表（系统 schema：_SYS_BIC/_SYS_BI/_SYS_REPO/SYS/_SYS_XS/SAPABAP1，或通过 HANA_SCHEMA_ALLOW 配置追加）`,
      );
    }
    return `( SELECT ${cols} FROM ${quoteIdentifier(schema)}.${quoteIdentifier(ds.columnObjectName)} )`;
  }
  if (ds.type === 'CALCULATION_VIEW' && ds.resourceUri) {
    // resourceUri 形如 /包路径/calculationviews/对象名 → _SYS_BIC."包路径/对象名"（引用上游已激活视图）
    const m = /^\/(.+)\/calculationviews\/([^/]+)$/.exec(ds.resourceUri);
    if (!m) {
      throw new HanaBusinessError(`数据源 ${ds.id} 的 resourceUri "${ds.resourceUri}" 无法解析为 _SYS_BIC 对象`);
    }
    const pkg = m[1];
    const name = m[2];
    assertSafeRuntimeName(pkg, '数据源包名');
    assertSafeRuntimeName(name, '数据源对象名');
    return `( SELECT ${cols} FROM ${qualifyName('_SYS_BIC', `${pkg}/${name}`)} )`;
  }
  throw new HanaBusinessError(
    `数据源 ${ds.id}（type=${ds.type || '?'}）暂不支持推导预览；当前仅支持基表（DATA_BASE_TABLE）与外部计算视图（CALCULATION_VIEW）`,
  );
}

/** 按节点类型生成 SELECT（emit 为本节点必须产出的输出列，有序） */
function nodeSql(node: ViewNode, gen: (ref: string) => string, emit: string[]): string {
  switch (node.type) {
    case 'ProjectionView':
      return projectionSql(node, gen, emit);
    case 'JoinView':
      return joinSql(node, gen, emit);
    case 'AggregationView':
      return aggregationSql(node, gen, emit);
    case 'UnionView':
      return unionSql(node, gen, emit);
    case 'RankView':
      return rankSql(node, gen, emit);
    default:
      throw new HanaBusinessError(`节点 ${node.id} 类型 ${node.type} 暂不支持推导预览`);
  }
}

/** 把公式/过滤表达式中的双引号列引用改写为「别名.列」（join 多输入时避免歧义） */
function qualify(expr: string, resolve: (col: string) => string): string {
  return expr.replace(/"(?:[^"\\]|\\.)*"/g, (m) => {
    const col = m.slice(1, -1).replace(/""/g, '"');
    return resolve(col);
  });
}

/** 表达式最终形态：COLUMN_ENGINE 翻译 → 列引用别名限定 */
function expr(text: string, resolve: (col: string) => string): string {
  return qualify(translateColumnEngine(text), resolve);
}

/** 属性级过滤器 → AND 连接的条件串（无 WHERE 前缀；空则返回 ''）。BW 常见：排除删除标记等 */
function attributeFilterClause(node: ViewNode, resolve: (col: string) => string): string {
  const conds: string[] = [];
  for (const af of node.attributeFilters) {
    if (af.filters.length === 0) continue;
    const including = af.filters.every((f) => f.including);
    const excluding = af.filters.every((f) => !f.including);
    const vals = af.filters.map((f) => quoteLiteral(f.value)).filter((v) => v !== 'NULL');
    if (vals.length === 0) continue;
    const col = resolve(af.id);
    if (including && af.filters.length === 1) conds.push(`${col} = ${vals[0]}`);
    else if (including) conds.push(`${col} IN (${vals.join(', ')})`);
    else if (excluding && af.filters.length === 1) conds.push(`${col} != ${vals[0]}`);
    else if (excluding) conds.push(`${col} NOT IN (${vals.join(', ')})`);
    // 混合 including/excluding 的过滤器语义复杂，保守拒绝以免给出错数据
    else throw new HanaBusinessError(`节点 ${node.id} 的属性 ${af.id} 过滤器混合包含/排除语义，暂不支持推导`);
  }
  return conds.join(' AND ');
}

/**
 * COLUMN_ENGINE 表达式翻译为 SQL（BW 视图常见子集）：
 * - if(cond, then, else) → CASE WHEN cond THEN then ELSE else END
 * - float(x) → CAST(x AS FLOAT)
 * - isnull(x) → (x IS NULL)   // COLUMN_ENGINE 的 isnull 是"判空"函数，HANA SQL 无此函数
 * 递归处理嵌套；未知结构原样保留（由数据库报错，不静默产出错误数据）。
 * 说明：BW 运行时视图（_SYS_BIC）把度量暴露为数值类型 + NULL，算术无需空串容错；
 * 曾尝试 NULLIF(col,'') 容错，但对数值列会把 '' 转数值触发 HANA 339，已回退。
 */
export function translateColumnEngine(exprStr: string): string {
  let result = exprStr;
  for (let i = 0; i < 100; i++) {
    const next = translateOnce(result);
    if (next === result) return result;
    result = next;
  }
  return result;
}

const CE_FN_RE = /\b(if|float|isnull)\s*\(/i;

function translateOnce(s: string): string {
  const m = CE_FN_RE.exec(s);
  if (!m) return s;
  const name = m[1].toLowerCase();
  const open = m.index + m[0].length - 1; // '(' 下标
  const close = findMatchingParen(s, open);
  if (close < 0) return s;
  const args = splitTopLevelArgs(s.slice(open + 1, close));
  const before = s.slice(0, m.index);
  const after = s.slice(close + 1);
  if (name === 'if') {
    if (args.length !== 3) return s;
    return `${before}CASE WHEN ${args[0]} THEN ${args[1]} ELSE ${args[2]} END${after}`;
  }
  if (name === 'float') {
    if (args.length !== 1) return s;
    return `${before}CAST(${args[0]} AS FLOAT)${after}`;
  }
  if (name === 'isnull') {
    if (args.length !== 1) return s;
    return `${before}(${args[0]} IS NULL)${after}`;
  }
  return s;
}

/** 找与 open 括号配对的闭合下标（跳过单引号字面量与双引号标识符） */
function findMatchingParen(s: string, open: number): number {
  let depth = 0;
  let i = open;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'") {
      i = skipQuoted(s, i, "'") + 1; // 跳到闭引号之后
      continue;
    }
    if (ch === '"') {
      i = skipQuoted(s, i, '"') + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
    i++;
  }
  return -1;
}

/** 跳过引号包裹段（处理 '' 转义） */
function skipQuoted(s: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < s.length) {
    if (s[i] === quote) {
      if (s[i + 1] === quote) {
        i += 2; // 转义引号（'' 或 ""）
        continue;
      }
      return i; // 闭引号
    }
    i++;
  }
  return s.length - 1;
}

/** 按顶层逗号切分实参（跳过括号与引号） */
function splitTopLevelArgs(s: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let cur = '';
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch === "'" || ch === '"') {
      const end = skipQuoted(s, i, ch);
      cur += s.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      parts.push(cur.trim());
      cur = '';
      i++;
      continue;
    }
    cur += ch;
    i++;
  }
  if (cur.trim() !== '') parts.push(cur.trim());
  return parts;
}

/** 单一输入节点的通用解析：别名（带引号，防保留字冲突）+ 输入 SQL + 输出列→来源映射 */
function singleInput(node: ViewNode, gen: (ref: string) => string): { alias: string; src: string; map: Map<string, string> } {
  if (node.inputs.length !== 1) {
    throw new HanaBusinessError(`节点 ${node.id} 应有 1 个输入，实际 ${node.inputs.length}，无法推导`);
  }
  const inp = node.inputs[0];
  const alias = '"I1"';
  const map = new Map(inp.mappings.map((m) => [m.target, m.source] as const));
  return { alias, src: gen(inp.node), map };
}

/** 计算列 ID 集合 */
function calculatedIds(node: ViewNode): Set<string> {
  return new Set(node.calculatedAttributes.map((ca) => ca.id));
}

/** 列引用：源列名与目标列名相同则省略 AS 别名（缩短嵌套 SQL；重命名列保留 AS） */
function emitCol(alias: string, source: string, target: string): string {
  const ref = `${alias}.${quoteIdentifier(source)}`;
  return source === target ? ref : `${ref} AS ${quoteIdentifier(target)}`;
}

function projectionSql(node: ViewNode, gen: (ref: string) => string, emit: string[]): string {
  const { alias, src, map } = singleInput(node, gen);
  const resolve = (c: string): string => `${alias}.${quoteIdentifier(map.get(c) ?? c)}`;
  const calc = calculatedIds(node);
  const parts = emit.map((a) => {
    if (calc.has(a)) {
      const ca = node.calculatedAttributes.find((x) => x.id === a)!;
      if (!ca.formula) throw new HanaBusinessError(`节点 ${node.id} 的计算列 ${a} 缺公式，无法推导`);
      return `(${expr(ca.formula, resolve)}) AS ${quoteIdentifier(a)}`;
    }
    return emitCol(alias, map.get(a) ?? a, a);
  });
  if (parts.length === 0) throw new HanaBusinessError(`节点 ${node.id} 无输出列，无法推导`);
  let sql = `SELECT ${parts.join(', ')} FROM ${src} AS ${alias}`;
  const where: string[] = [];
  if (node.filter) where.push(expr(node.filter, resolve));
  const af = attributeFilterClause(node, resolve);
  if (af) where.push(af);
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  return sql;
}

function joinSql(node: ViewNode, gen: (ref: string) => string, emit: string[]): string {
  if (node.inputs.length !== 2) {
    throw new HanaBusinessError(`Join 节点 ${node.id} 有 ${node.inputs.length} 个输入，当前仅支持 2 输入 Join`);
  }
  const joinType = JOIN_TYPE_MAP[(node.joinType ?? 'inner').toLowerCase().replace(/[\s_]/g, '')];
  if (!joinType) {
    throw new HanaBusinessError(`Join 节点 ${node.id} 的 joinType=${node.joinType ?? '?'} 暂不支持（支持 inner/leftOuter/rightOuter/fullOuter）`);
  }
  const inputs = node.inputs.map((inp, i) => ({ inp, alias: `"I${i + 1}"`, src: gen(inp.node) }));
  // 输出列 → 提供它的输入别名与源列（后置覆盖：equi-join 键任一侧等价）
  const colSource = new Map<string, { alias: string; source: string }>();
  for (const { inp, alias } of inputs) {
    for (const m of inp.mappings) colSource.set(m.target, { alias, source: m.source });
  }
  const resolve = (col: string): string => {
    const cs = colSource.get(col);
    return cs ? `${cs.alias}.${quoteIdentifier(cs.source)}` : `${inputs[0].alias}.${quoteIdentifier(col)}`;
  };
  const calc = calculatedIds(node);
  const parts = emit.map((a) => {
    if (calc.has(a)) {
      const ca = node.calculatedAttributes.find((x) => x.id === a)!;
      if (!ca.formula) throw new HanaBusinessError(`节点 ${node.id} 的计算列 ${a} 缺公式，无法推导`);
      return `(${expr(ca.formula, resolve)}) AS ${quoteIdentifier(a)}`;
    }
    const cs = colSource.get(a);
    return cs ? emitCol(cs.alias, cs.source, a) : `${inputs[0].alias}.${quoteIdentifier(a)}`;
  });
  if (parts.length === 0) throw new HanaBusinessError(`节点 ${node.id} 无输出列，无法推导`);
  const from = inputs.map(({ src, alias }) => `${src} AS ${alias}`).join(` ${joinType} `);
  // 关联键：joinAttribute 是 join 输出列名，两侧各自的源列经输入映射解析（BW 常见两侧列名不同）
  const conds = node.joinAttributes.map((a) => {
    const srcOf = (inp: { inp: { mappings: Array<{ target: string; source: string }> }; alias: string }): string => {
      const m = inp.inp.mappings.find((mm) => mm.target === a);
      return `${inp.alias}.${quoteIdentifier(m ? m.source : a)}`;
    };
    return `${srcOf(inputs[0])} = ${srcOf(inputs[1])}`;
  });
  let sql = `SELECT ${parts.join(', ')} FROM ${from}`;
  if (conds.length > 0) sql += ` ON ${conds.join(' AND ')}`;
  const where: string[] = [];
  if (node.filter) where.push(expr(node.filter, resolve));
  const af = attributeFilterClause(node, resolve);
  if (af) where.push(af);
  if (where.length > 0) sql += ` WHERE ${where.join(' AND ')}`;
  return sql;
}

function aggregationSql(node: ViewNode, gen: (ref: string) => string, emit: string[]): string {
  const { alias, src, map } = singleInput(node, gen);
  const resolve = (c: string): string => `${alias}.${quoteIdentifier(map.get(c) ?? c)}`;
  const groupBy = aggGroupBy(node);
  const measures = aggMeasures(node);
  const groupSet = new Set(groupBy);
  const measureMap = new Map(measures.map((m) => [m.column, m.aggregationType] as const));
  const calc = calculatedIds(node);
  const parts = emit.map((a) => {
    if (measureMap.has(a)) {
      const agg = AGG_MAP[(measureMap.get(a) ?? 'sum').toLowerCase()];
      if (!agg) throw new HanaBusinessError(`Aggregation 节点 ${node.id} 的聚合函数 ${measureMap.get(a)} 暂不支持（支持 sum/count/min/max/avg）`);
      return `${agg}(${resolve(a)}) AS ${quoteIdentifier(a)}`;
    }
    if (groupSet.has(a)) return emitCol(alias, map.get(a) ?? a, a);
    if (calc.has(a)) {
      const ca = node.calculatedAttributes.find((x) => x.id === a)!;
      if (!ca.formula) throw new HanaBusinessError(`节点 ${node.id} 的计算列 ${a} 缺公式，无法推导`);
      return `(${expr(ca.formula, resolve)}) AS ${quoteIdentifier(a)}`;
    }
    return emitCol(alias, map.get(a) ?? a, a);
  });
  if (parts.length === 0) throw new HanaBusinessError(`节点 ${node.id} 无分组列与度量，无法推导`);
  let sql = `SELECT ${parts.join(', ')} FROM ${src} AS ${alias}`;
  if (groupBy.length > 0) sql += ` GROUP BY ${groupBy.map((g) => resolve(g)).join(', ')}`;
  if (node.filter) sql += ` HAVING ${expr(node.filter, resolve)}`;
  return sql;
}

function unionSql(node: ViewNode, gen: (ref: string) => string, emit: string[]): string {
  if (emit.length === 0) throw new HanaBusinessError(`Union 节点 ${node.id} 无输出列，无法推导`);
  const selects = node.inputs.map((inp, i) => {
    const alias = `"I${i + 1}"`;
    const src = gen(inp.node);
    const list = emit.map((c) => `${alias}.${quoteIdentifier(c)} AS ${quoteIdentifier(c)}`).join(', ');
    return `SELECT ${list} FROM ${src} AS ${alias}`;
  });
  if (selects.length < 2) throw new HanaBusinessError(`Union 节点 ${node.id} 输入不足（${selects.length}），无法推导`);
  return selects.join(' UNION ALL ');
}

/**
 * Rank 节点推导：取每组前 threshold 条。
 * 语义：ROW_NUMBER() OVER (PARTITION BY 分组字段 ORDER BY 排序字段 ASC/DESC) + WHERE rn <= 阈值
 * （threshold=1 即取分组第一条）。窗口列内部命名不外露；输出仅 emit 列。
 */
function rankSql(node: ViewNode, gen: (ref: string) => string, emit: string[]): string {
  const { alias, src, map } = singleInput(node, gen);
  const rk = node.rank;
  if (!rk || rk.partitionBy.length === 0 || rk.orderBy.length === 0) {
    throw new HanaBusinessError(`Rank 节点 ${node.id} 缺分组/排序定义（windowFunction），无法推导`);
  }
  const resolve = (c: string): string => `${alias}.${quoteIdentifier(map.get(c) ?? c)}`;
  if (emit.length === 0) throw new HanaBusinessError(`Rank 节点 ${node.id} 无输出列，无法推导`);
  const calc = calculatedIds(node);
  const innerParts = emit.map((a) => {
    if (calc.has(a)) {
      const ca = node.calculatedAttributes.find((x) => x.id === a)!;
      if (!ca.formula) throw new HanaBusinessError(`节点 ${node.id} 的计算列 ${a} 缺公式，无法推导`);
      return `(${expr(ca.formula, resolve)}) AS ${quoteIdentifier(a)}`;
    }
    return emitCol(alias, map.get(a) ?? a, a);
  });
  const partition = rk.partitionBy.map((c) => resolve(c)).join(', ');
  const order = rk.orderBy.map((o) => `${resolve(o.column)} ${(o.direction ?? 'ASC').toUpperCase() === 'DESC' ? 'DESC' : 'ASC'}`).join(', ');
  const threshold = Math.max(1, Math.floor(rk.threshold));
  const windowCol = `"__RANK_${node.id.replace(/[^A-Za-z0-9_]/g, '')}"`;
  const outList = emit.map((c) => quoteIdentifier(c)).join(', ');
  // row_number 窗口 + where 过滤（取每组前 threshold 条）
  return (
    `SELECT ${outList} FROM ( ` +
    `SELECT ${innerParts.join(', ')}, ROW_NUMBER() OVER (PARTITION BY ${partition} ORDER BY ${order}) AS ${windowCol} ` +
    `FROM ${src} AS ${alias} ) AS "RANKED" WHERE ${windowCol} <= ${threshold}`
  );
}

/** Aggregation 分组列（格式 A=aggregateBy；格式 B=无聚合函数的 viewAttribute） */
function aggGroupBy(node: ViewNode): string[] {
  const formatA = node.aggregateBy.length > 0 || node.measures.length > 0;
  return formatA ? node.aggregateBy : node.attributes.filter((a) => !node.attributeAggregations.some((m) => m.id === a));
}

/** Aggregation 度量（格式 A=measureMapping；格式 B=带 aggregationType 的 viewAttribute） */
function aggMeasures(node: ViewNode): ViewNodeMeasure[] {
  const formatA = node.aggregateBy.length > 0 || node.measures.length > 0;
  return formatA ? node.measures : node.attributeAggregations.map((m) => ({ column: m.id, aggregationType: m.aggregationType }));
}

/** 节点自身引用的列（filter + 计算列公式 + 属性过滤 ID，均以输出列名表示） */
function referencedColumns(node: ViewNode): string[] {
  const cols: string[] = [];
  const push = (c: string): void => {
    if (c && !cols.includes(c)) cols.push(c);
  };
  const RE = /"((?:[^"\\]|\\.)*)"/g;
  const scan = (s?: string): void => {
    if (!s) return;
    let m: RegExpExecArray | null;
    while ((m = RE.exec(s)) !== null) push(m[1].replace(/""/g, '"'));
  };
  scan(node.filter);
  for (const ca of node.calculatedAttributes) scan(ca.formula);
  for (const af of node.attributeFilters) push(af.id);
  return cols;
}

/** 节点完整输出列（去重保序）：目标节点预览结果列 + 裁剪顺序基准 */
function outputColumns(node: ViewNode): string[] {
  const cols: string[] = [];
  const push = (c: string): void => {
    if (c && !cols.includes(c)) cols.push(c);
  };
  for (const a of node.attributes) push(a);
  for (const ca of node.calculatedAttributes) push(ca.id);
  for (const g of node.aggregateBy) push(g);
  for (const m of node.measures) push(m.column);
  for (const am of node.attributeAggregations) push(am.id);
  return cols;
}
