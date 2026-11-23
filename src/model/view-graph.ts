import { HanaBusinessError } from '../core/errors.js';
import { escapeXmlAttr } from '../core/xml.js';
import {
  logicalModelAttributeXml,
  logicalModelMeasureXml,
  scenarioDataCategory,
  scenarioRootAttrsXml,
} from './view-builder.js';
import { type ViewNode, aggGroupBy, aggMeasures } from './view-types.js';
import { parseViewDefinition } from './view-xml.js';
import { autoLayoutViewXml, ensureCubeDataCategory, replaceGraphSections } from './view-edit.js';

/**
 * 图形化计算视图的「模块图」：sources + nodes（模块实例）+ output。
 * 与过程式的 add_join/add_union 不同，节点实例由调用方按 id 声明、按 inputs 接线，服务端一次性构建；
 * 同一个模块可以实例化多次（Join_1 / Join_2 都是 join）。
 */

export type GraphSourceSpec =
  | { id: string; type: 'table'; schema: string; name: string }
  | { id: string; type: 'calculationview'; packageId: string; objectName: string };

export type GraphJoinType = 'inner' | 'leftOuter' | 'rightOuter' | 'fullOuter';

export type GraphNodeSpec =
  | {
      id: string;
      type: 'projection';
      input: string;
      /** 输出列（缺省与 source 同名；mappings 可重命名） */
      fields: string[];
      /** 输出列 ← 输入列；缺省同名 */
      mappings?: Array<{ id: string; source: string }>;
    }
  | {
      id: string;
      type: 'join';
      inputs: [string, string];
      joinType?: GraphJoinType;
      conditions: Array<{ leftField: string; rightField: string }>;
      /** join 节点输出列；条件左字段自动包含 */
      fields: string[];
    }
  | {
      id: string;
      type: 'union';
      inputs: string[];
      /** union 输出列（各输入按 mappings 对齐；缺省同名） */
      fields: string[];
      mappings?: Array<{ id: string; sources: string[] }>;
    }
  | {
      id: string;
      type: 'aggregation';
      input: string;
      groupBy: string[];
      measures: Array<{ field: string; aggregationType: string }>;
    }
  | {
      id: string;
      type: 'rank';
      input: string;
      partitionBy: string[];
      orderBy: Array<{ field: string; direction?: 'ASC' | 'DESC' }>;
      threshold: number;
    };

export interface GraphOutputFieldSpec {
  id: string;
  kind?: 'attribute' | 'measure';
  aggregationType?: string;
  description?: string;
}

export interface GraphSpec {
  sources: GraphSourceSpec[];
  nodes: GraphNodeSpec[];
  /** 输出节点 id */
  output: string;
  /** 输出字段；缺省=输出节点的全部列（create） */
  outputFields?: GraphOutputFieldSpec[];
}

/** update 的增量补丁：按 id 合并 sources/nodes；remove 删除；output/outputFields 可改 */
export interface GraphPatch {
  sources?: GraphSourceSpec[];
  nodes?: GraphNodeSpec[];
  remove?: string[];
  output?: string;
  outputFields?: GraphOutputFieldSpec[];
  removeOutputFields?: string[];
}

export interface ResolvedField {
  id: string;
  kind: 'attribute' | 'measure';
  aggregationType?: string;
  description?: string;
  dataType?: string;
}

export interface ResolvedSource {
  spec: GraphSourceSpec;
  fields: ResolvedField[];
  /** CV 源的 resourceUri（service 解析；table 源不用） */
  resourceUri?: string;
}

export interface ResolvedNode {
  spec: GraphNodeSpec;
  fields: ResolvedField[];
}

export interface ResolvedGraph {
  sources: ResolvedSource[];
  nodes: ResolvedNode[];
  output: string;
  outputFields: ResolvedField[];
}

/** 从现有 XML 解析出的图（update 增量合并的基线） */
export interface ParsedGraph {
  graph: GraphSpec;
  /** logicalModel 的 calculated/restricted/localDimensions 内层 XML（保留原样） */
  calculatedAttributes: string;
  calculatedMeasures: string;
  restrictedMeasures: string;
  localDimensions: string;
}

function byId<T extends { id: string }>(items: readonly T[]): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    if (map.has(item.id)) throw new HanaBusinessError(`模块 id 重复："${item.id}"（id 必须唯一）`);
    map.set(item.id, item);
  }
  return map;
}

function fieldMap(fields: readonly ResolvedField[]): Map<string, ResolvedField> {
  return new Map(fields.map((f) => [f.id, f]));
}

function sortedTopologically(nodes: readonly GraphNodeSpec[]): GraphNodeSpec[] {
  const nodeById = byId(nodes);
  const state = new Map<string, 'visiting' | 'done'>();
  const out: GraphNodeSpec[] = [];
  const visit = (id: string): void => {
    const node = nodeById.get(id);
    if (!node) return;
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') throw new HanaBusinessError(`模块图存在环（经过 ${id}），无法构建`);
    state.set(id, 'visiting');
    const inputs = node.type === 'join' ? node.inputs : node.type === 'union' ? node.inputs : [node.input];
    for (const input of inputs) visit(input);
    state.set(id, 'done');
    out.push(node);
  };
  for (const n of nodes) visit(n.id);
  return out;
}

/**
 * 纯函数：校验模块图并计算每个节点的输出列（类型从 source 继承）。
 * 源字段由 service 解析后传入（table/CV 的列与属性/度量分类）。
 */
export function resolveGraph(
  sources: readonly ResolvedSource[],
  nodes: readonly GraphNodeSpec[],
  output: string,
  outputFields?: readonly GraphOutputFieldSpec[],
): ResolvedGraph {
  const sourceById = new Map(sources.map((s) => [s.spec.id, s]));
  const nodeById = new Map(nodes.map((n) => [n.id, n]));
  if (sourceById.size !== sources.length) throw new HanaBusinessError('source id 重复（id 必须唯一）');
  if (nodeById.size !== nodes.length) throw new HanaBusinessError('node id 重复（id 必须唯一）');
  for (const n of nodes) {
    if (sourceById.has(n.id)) throw new HanaBusinessError(`source 与 node 使用了同一个 id："${n.id}"`);
  }
  const resolvedNodes = new Map<string, ResolvedNode>();
  const visiting = new Set<string>();

  const fieldsOf = (id: string): ResolvedField[] => {
    const source = sourceById.get(id);
    if (source) return source.fields;
    const node = nodeById.get(id);
    if (!node) throw new HanaBusinessError(`模块图引用了不存在的 id："${id}"（既不是 source 也不是 node）`);
    const resolved = resolvedNodes.get(id);
    if (resolved) return resolved.fields;
    if (visiting.has(id)) throw new HanaBusinessError(`模块图存在环（经过 ${id}），无法解析`);
    visiting.add(id);
    const fields = resolveNodeFields(node, fieldsOf);
    visiting.delete(id);
    resolvedNodes.set(id, { spec: node, fields });
    return fields;
  };

  for (const n of sortedTopologically(nodes)) fieldsOf(n.id);

  const outputNode = nodeById.get(output);
  if (!outputNode) throw new HanaBusinessError(`output 指向的节点 "${output}" 不存在`);
  const outputNodeFields = fieldsOf(output);
  const outputResolved: ResolvedField[] =
    outputFields === undefined
      ? outputNodeFields.map((f) => ({ ...f }))
      : outputFields.map((spec) => {
          const base = outputNodeFields.find((f) => f.id === spec.id);
          if (!base) {
            throw new HanaBusinessError(
              `输出字段 "${spec.id}" 不在输出节点 ${output} 上。可用字段：${outputNodeFields.map((f) => f.id).join(', ')}`,
            );
          }
          return {
            id: spec.id,
            kind: spec.kind ?? base.kind,
            aggregationType: spec.aggregationType ?? base.aggregationType,
            description: spec.description ?? base.description,
            dataType: base.dataType,
          };
        });
  if (outputResolved.length === 0) {
    throw new HanaBusinessError(`输出节点 ${output} 没有可输出的字段（graph.outputFields 为空且节点无列）`);
  }
  return {
    sources: [...sources],
    nodes: nodes.map((n) => resolvedNodes.get(n.id)!),
    output,
    outputFields: outputResolved,
  };
}

function resolveNodeFields(node: GraphNodeSpec, fieldsOf: (id: string) => ResolvedField[]): ResolvedField[] {
  switch (node.type) {
    case 'projection': {
      const input = fieldMap(fieldsOf(node.input));
      const mapping = new Map((node.mappings ?? []).map((m) => [m.id, m.source]));
      return node.fields.map((id) => {
        const source = mapping.get(id) ?? id;
        const base = input.get(source);
        if (!base) {
          throw new HanaBusinessError(
            `projection ${node.id} 的列 "${id}" 来源 "${source}" 不在输入 ${node.input} 上（可用：${[...input.keys()].join(', ')}）`,
          );
        }
        return { ...base, id };
      });
    }
    case 'join': {
      const left = fieldMap(fieldsOf(node.inputs[0]));
      const right = fieldMap(fieldsOf(node.inputs[1]));
      for (const c of node.conditions) {
        if (!left.has(c.leftField)) {
          throw new HanaBusinessError(`join ${node.id} 左字段 "${c.leftField}" 不在输入 ${node.inputs[0]} 上`);
        }
        if (!right.has(c.rightField)) {
          throw new HanaBusinessError(`join ${node.id} 右字段 "${c.rightField}" 不在输入 ${node.inputs[1]} 上`);
        }
      }
      return node.fields.map((id) => {
        const l = left.get(id);
        const r = right.get(id);
        if (!l && !r) {
          throw new HanaBusinessError(`join ${node.id} 的输出列 "${id}" 不在任一侧输入上`);
        }
        const base = l ?? r!;
        if (l && r && l.kind !== r.kind) {
          throw new HanaBusinessError(
            `join ${node.id} 的列 "${id}" 在两侧类型不同（左=${l.kind}，右=${r.kind}）；请先 projection 统一`,
          );
        }
        return { ...base, id };
      });
    }
    case 'union': {
      const inputs = node.inputs.map((id) => fieldMap(fieldsOf(id)));
      const mapping = new Map((node.mappings ?? []).map((m) => [m.id, m.sources]));
      return node.fields.map((id) => {
        const sources = mapping.get(id);
        if (sources && sources.length !== inputs.length) {
          throw new HanaBusinessError(`union ${node.id} 的字段 "${id}" 映射数必须等于输入数 ${inputs.length}`);
        }
        let kind: 'attribute' | 'measure' | undefined;
        let description: string | undefined;
        let dataType: string | undefined;
        let aggregationType: string | undefined;
        inputs.forEach((input, i) => {
          const source = sources?.[i] ?? id;
          const f = input.get(source);
          if (!f) {
            throw new HanaBusinessError(`union ${node.id} 的第 ${i + 1} 个输入没有字段 "${source}"（输出列 "${id}"）`);
          }
          if (kind !== undefined && kind !== f.kind) {
            throw new HanaBusinessError(
              `union ${node.id} 的列 "${id}" 在各输入类型不一致（${kind} vs ${f.kind}）；请先 projection 统一`,
            );
          }
          kind = f.kind;
          description ??= f.description;
          dataType ??= f.dataType;
          aggregationType ??= f.aggregationType;
        });
        return { id, kind: kind!, aggregationType, description, dataType };
      });
    }
    case 'aggregation': {
      const input = fieldMap(fieldsOf(node.input));
      const groupBy = node.groupBy.map((id) => {
        const f = input.get(id);
        if (!f) throw new HanaBusinessError(`aggregation ${node.id} 的分组字段 "${id}" 不在输入 ${node.input} 上`);
        if (f.kind === 'measure') {
          throw new HanaBusinessError(`aggregation ${node.id} 的分组字段 "${id}" 是度量；分组维度必须是属性`);
        }
        return { ...f, id, kind: 'attribute' as const };
      });
      const measures = node.measures.map((m) => {
        const f = input.get(m.field);
        if (!f) throw new HanaBusinessError(`aggregation ${node.id} 的度量 "${m.field}" 不在输入 ${node.input} 上`);
        if (f.kind === 'attribute') {
          throw new HanaBusinessError(
            `aggregation ${node.id} 的度量 "${m.field}" 是属性；请先在 projection 中标记为度量`,
          );
        }
        return { ...f, id: m.field, kind: 'measure' as const, aggregationType: m.aggregationType };
      });
      const seen = new Set<string>();
      for (const f of [...groupBy, ...measures]) {
        if (seen.has(f.id)) throw new HanaBusinessError(`aggregation ${node.id} 的输出列 "${f.id}" 重复`);
        seen.add(f.id);
      }
      return [...groupBy, ...measures];
    }
    case 'rank': {
      const input = fieldMap(fieldsOf(node.input));
      for (const id of [...node.partitionBy, ...node.orderBy.map((o) => o.field)]) {
        if (!input.has(id)) throw new HanaBusinessError(`rank ${node.id} 的字段 "${id}" 不在输入 ${node.input} 上`);
      }
      return [...input.values()];
    }
    default: {
      const never: never = node;
      throw new HanaBusinessError(`未知模块类型：${JSON.stringify(never)}`);
    }
  }
}

/* ── XML 渲染 ─────────────────────────────────────────────────────── */

function dataSourceBlock(source: ResolvedSource): string[] {
  const id = escapeXmlAttr(source.spec.id);
  if (source.spec.type === 'table') {
    return [
      `    <DataSource id="${id}" type="DATA_BASE_TABLE">`,
      `      <viewAttributes allViewAttributes="true"/>`,
      `      <columnObject schemaName="${escapeXmlAttr(source.spec.schema)}" columnObjectName="${escapeXmlAttr(source.spec.name)}"/>`,
      `    </DataSource>`,
    ];
  }
  return [
    `    <DataSource id="${id}" type="CALCULATION_VIEW">`,
    `      <viewAttributes allViewAttributes="true"/>`,
    `      <resourceUri>${escapeXmlAttr(source.resourceUri ?? '')}</resourceUri>`,
    `    </DataSource>`,
  ];
}

function mapping(target: string, source: string): string {
  return (
    `        <mapping xsi:type="Calculation:AttributeMapping"` +
    ` target="${escapeXmlAttr(target)}" source="${escapeXmlAttr(source)}"/>`
  );
}

function renderNode(
  node: ResolvedNode,
  allSources: Map<string, ResolvedSource>,
  allNodes: Map<string, ResolvedNode>,
): string {
  const fieldsOf = (id: string): ResolvedField[] => allSources.get(id)?.fields ?? allNodes.get(id)?.fields ?? [];
  const lines: string[] = [];
  const push = (...xs: string[]): void => {
    lines.push(...xs);
  };
  switch (node.spec.type) {
    case 'projection': {
      const input = fieldsOf(node.spec.input);
      const sourceOf = new Map((node.spec.mappings ?? []).map((m) => [m.id, m.source]));
      push(
        `    <calculationView xsi:type="Calculation:ProjectionView" id="${escapeXmlAttr(node.spec.id)}">`,
        `      <descriptions/>`,
        `      <viewAttributes>`,
        ...node.fields.map((f) => `        <viewAttribute id="${escapeXmlAttr(f.id)}"/>`),
        `      </viewAttributes>`,
        `      <calculatedViewAttributes/>`,
        `      <input node="#${escapeXmlAttr(node.spec.input)}">`,
        ...node.fields.map((f) => mapping(f.id, sourceOf.get(f.id) ?? f.id)),
        `      </input>`,
        `    </calculationView>`,
      );
      void input;
      break;
    }
    case 'join': {
      const left = fieldMap(fieldsOf(node.spec.inputs[0]));
      const right = fieldMap(fieldsOf(node.spec.inputs[1]));
      const conditionLeft = new Set(node.spec.conditions.map((c) => c.leftField));
      const leftMappings = node.fields.filter((f) => left.has(f.id)).map((f) => mapping(f.id, f.id));
      const rightMappings = [
        ...node.spec.conditions.map((c) => mapping(c.leftField, c.rightField)),
        ...node.fields.filter((f) => !left.has(f.id) && right.has(f.id)).map((f) => mapping(f.id, f.id)),
      ];
      push(
        `    <calculationView xsi:type="Calculation:JoinView" id="${escapeXmlAttr(node.spec.id)}" joinOrder="OUTSIDE_IN" joinType="${escapeXmlAttr(node.spec.joinType ?? 'leftOuter')}">`,
        `      <descriptions/>`,
        `      <viewAttributes>`,
        ...node.fields.map((f) => `        <viewAttribute id="${escapeXmlAttr(f.id)}"/>`),
        `      </viewAttributes>`,
        `      <calculatedViewAttributes/>`,
        `      <input node="#${escapeXmlAttr(node.spec.inputs[0])}">`,
        ...leftMappings,
        `      </input>`,
        `      <input node="#${escapeXmlAttr(node.spec.inputs[1])}">`,
        ...rightMappings,
        `      </input>`,
        ...node.spec.conditions.map((c) => `      <joinAttribute name="${escapeXmlAttr(c.leftField)}"/>`),
        `    </calculationView>`,
      );
      void conditionLeft;
      break;
    }
    case 'union': {
      const inputs = node.spec.inputs.map((id) => fieldMap(fieldsOf(id)));
      const mappingBy = new Map((node.spec.mappings ?? []).map((m) => [m.id, m.sources]));
      push(
        `    <calculationView xsi:type="Calculation:UnionView" id="${escapeXmlAttr(node.spec.id)}">`,
        `      <descriptions/>`,
        `      <viewAttributes>`,
        ...node.fields.map((f) => `        <viewAttribute id="${escapeXmlAttr(f.id)}"/>`),
        `      </viewAttributes>`,
        `      <calculatedViewAttributes/>`,
        ...node.spec.inputs.flatMap((inputId, i) => [
          `      <input node="#${escapeXmlAttr(inputId)}">`,
          ...node.fields.map((f) => mapping(f.id, mappingBy.get(f.id)?.[i] ?? f.id)),
          `      </input>`,
        ]),
        `    </calculationView>`,
      );
      void inputs;
      break;
    }
    case 'aggregation': {
      push(
        `    <calculationView xsi:type="Calculation:AggregationView" id="${escapeXmlAttr(node.spec.id)}">`,
        `      <descriptions/>`,
        `      <viewAttributes>`,
        ...node.spec.groupBy.map((f) => `        <viewAttribute id="${escapeXmlAttr(f)}"/>`),
        ...node.spec.measures.map(
          (m) =>
            `        <viewAttribute id="${escapeXmlAttr(m.field)}" aggregationType="${escapeXmlAttr(m.aggregationType)}"/>`,
        ),
        `      </viewAttributes>`,
        `      <calculatedViewAttributes/>`,
        `      <input node="#${escapeXmlAttr(node.spec.input)}">`,
        ...[...node.spec.groupBy, ...node.spec.measures.map((m) => m.field)].map((f) => mapping(f, f)),
        `      </input>`,
        `    </calculationView>`,
      );
      break;
    }
    case 'rank': {
      push(
        `    <calculationView xsi:type="Calculation:RankView" id="${escapeXmlAttr(node.spec.id)}">`,
        `      <descriptions/>`,
        `      <viewAttributes>`,
        ...node.fields.map((f) => `        <viewAttribute id="${escapeXmlAttr(f.id)}"/>`),
        `      </viewAttributes>`,
        `      <calculatedViewAttributes/>`,
        `      <input node="#${escapeXmlAttr(node.spec.input)}">`,
        ...node.fields.map((f) => mapping(f.id, f.id)),
        `      </input>`,
        `      <windowFunction>`,
        ...node.spec.partitionBy.map(
          (p) => `        <partitionViewAttributeName>${escapeXmlAttr(p)}</partitionViewAttributeName>`,
        ),
        ...node.spec.orderBy.map(
          (o) => `        <order byViewAttributeName="${escapeXmlAttr(o.field)}" direction="${o.direction ?? 'ASC'}"/>`,
        ),
        `        <rankThreshold><value>${node.spec.threshold}</value></rankThreshold>`,
        `      </windowFunction>`,
        `    </calculationView>`,
      );
      break;
    }
    default: {
      const never: never = node.spec;
      throw new HanaBusinessError(`未知模块类型：${JSON.stringify(never)}`);
    }
  }
  return lines.join('\n');
}

function section(tag: string, inner: string): string {
  return inner.trim() === '' ? `    <${tag}/>` : `    <${tag}>\n${inner}\n    </${tag}>`;
}

function logicalModelBlock(
  output: string,
  fields: readonly ResolvedField[],
  calculated: { attributes: string; measures: string; restricted: string; localDimensions: string },
): string {
  const attrs = fields.filter((f) => f.kind === 'attribute');
  const measures = fields.filter((f) => f.kind === 'measure');
  const attrBlocks = attrs.map((f, i) => logicalModelAttributeXml(f.id, i + 1, output, f.description));
  const measureBlocks = measures.map((f, i) =>
    logicalModelMeasureXml(f.id, attrs.length + i + 1, output, f.aggregationType ?? 'sum', f.description),
  );
  return [
    `  <logicalModel id="${escapeXmlAttr(output)}">`,
    `    <descriptions/>`,
    section('attributes', attrBlocks.join('\n')),
    section('calculatedAttributes', calculated.attributes),
    section('baseMeasures', measureBlocks.join('\n')),
    section('calculatedMeasures', calculated.measures),
    section('restrictedMeasures', calculated.restricted),
    section('localDimensions', calculated.localDimensions),
    `  </logicalModel>`,
  ].join('\n');
}

export function renderGraphSections(
  graph: ResolvedGraph,
  calculated: { attributes: string; measures: string; restricted: string; localDimensions: string } = {
    attributes: '',
    measures: '',
    restricted: '',
    localDimensions: '',
  },
): { dataSources: string; calculationViews: string; logicalModel: string } {
  const sourceById = new Map(graph.sources.map((s) => [s.spec.id, s]));
  const nodeById = new Map(graph.nodes.map((n) => [n.spec.id, n]));
  const viewBlocks = sortedTopologically(graph.nodes.map((n) => n.spec)).map((spec) =>
    renderNode(nodeById.get(spec.id)!, sourceById, nodeById),
  );
  return {
    dataSources: ['  <dataSources>', ...graph.sources.flatMap(dataSourceBlock), '  </dataSources>'].join('\n'),
    calculationViews: ['  <calculationViews>', ...viewBlocks, '  </calculationViews>'].join('\n'),
    logicalModel: logicalModelBlock(graph.output, graph.outputFields, calculated),
  };
}

/**
 * 从零构建图形化 Calculation View 的设计时 XML。
 * 模块图由调用方声明；服务端按 inputs 拓扑排序后一次性写入。
 */
export function buildGraphViewXml(
  objectName: string,
  description: string,
  graph: ResolvedGraph,
  opts: { layout?: boolean } = {},
): string {
  const sections = renderGraphSections(graph);
  const measureCount = graph.outputFields.filter((f) => f.kind === 'measure').length;
  let xml = [
    `<Calculation:scenario xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"` +
      ` xmlns:Calculation="http://www.sap.com/ndb/BiModelCalculation.ecore"` +
      ` schemaVersion="2.3" id="${escapeXmlAttr(objectName)}"` +
      ` dataCategory="${scenarioDataCategory(measureCount)}"` +
      scenarioRootAttrsXml() +
      ` calculationScenarioType="TREE_BASED">`,
    `  <origin/>`,
    `  <descriptions defaultDescription="${escapeXmlAttr(description)}"/>`,
    `  <metadata changedAt=""/>`,
    `  <localVariables/>`,
    `  <variableMappings/>`,
    sections.dataSources,
    sections.calculationViews,
    sections.logicalModel,
    `</Calculation:scenario>`,
  ].join('\n');
  if (opts.layout !== false) xml = autoLayoutViewXml(xml).xml;
  return xml;
}

/* ── 从现有 XML 解析图（update 增量合并基线）────────────────────── */

function innerSection(xml: string, tag: string): string {
  const m = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
}

function sourceResourceUriToSpec(id: string, resourceUri: string): GraphSourceSpec {
  const m = /^\/([^/]+)\/calculationviews\/([^/]+)$/.exec(resourceUri);
  if (!m) throw new HanaBusinessError(`无法从 resourceUri 解析 CV 源：${resourceUri}`);
  return { id, type: 'calculationview', packageId: m[1], objectName: m[2] };
}

function nodeSpecFromViewNode(node: ViewNode): GraphNodeSpec {
  switch (node.type) {
    case 'ProjectionView': {
      if (node.inputs.length !== 1) throw new HanaBusinessError(`projection ${node.id} 的输入数不是 1`);
      const input = node.inputs[0];
      const fields = node.attributes;
      const mappings = input.mappings
        .filter((m) => m.target !== m.source)
        .map((m) => ({ id: m.target, source: m.source }));
      return {
        id: node.id,
        type: 'projection',
        input: input.node.replace(/^#/, ''),
        fields,
        ...(mappings.length ? { mappings } : {}),
      };
    }
    case 'JoinView': {
      if (node.inputs.length !== 2) throw new HanaBusinessError(`join ${node.id} 的输入数不是 2`);
      const right = new Map(node.inputs[1].mappings.map((m) => [m.target, m.source]));
      return {
        id: node.id,
        type: 'join',
        inputs: [node.inputs[0].node.replace(/^#/, ''), node.inputs[1].node.replace(/^#/, '')],
        joinType: (node.joinType as GraphJoinType | undefined) ?? 'leftOuter',
        conditions: node.joinAttributes.map((name) => ({ leftField: name, rightField: right.get(name) ?? name })),
        fields: node.attributes,
      };
    }
    case 'UnionView': {
      const mappings = node.inputs.map((i) => new Map(i.mappings.map((m) => [m.target, m.source])));
      const map = node.attributes.map((id) => ({
        id,
        sources: node.inputs.map((_, i) => mappings[i].get(id) ?? id),
      }));
      const hasRename = map.some((m) => m.sources.some((s) => s !== m.id));
      return {
        id: node.id,
        type: 'union',
        inputs: node.inputs.map((i) => i.node.replace(/^#/, '')),
        fields: node.attributes,
        ...(hasRename ? { mappings: map } : {}),
      };
    }
    case 'AggregationView': {
      if (node.inputs.length !== 1) throw new HanaBusinessError(`aggregation ${node.id} 的输入数不是 1`);
      return {
        id: node.id,
        type: 'aggregation',
        input: node.inputs[0].node.replace(/^#/, ''),
        groupBy: aggGroupBy(node),
        measures: aggMeasures(node).map((m) => ({ field: m.column, aggregationType: m.aggregationType ?? 'sum' })),
      };
    }
    case 'RankView': {
      if (!node.rank || node.inputs.length !== 1)
        throw new HanaBusinessError(`rank ${node.id} 缺少 windowFunction 或输入`);
      return {
        id: node.id,
        type: 'rank',
        input: node.inputs[0].node.replace(/^#/, ''),
        partitionBy: node.rank.partitionBy,
        orderBy: node.rank.orderBy.map((o) => ({
          field: o.column,
          direction: o.direction as 'ASC' | 'DESC' | undefined,
        })),
        threshold: node.rank.threshold,
      };
    }
    default:
      throw new HanaBusinessError(`graph 更新不支持节点类型 "${node.type}"（${node.id}）；请用 xml 全量通道`);
  }
}

/**
 * 解析现有设计时 XML 为模块图 + 逻辑层计算字段原文（update 增量合并基线）。
 * 仅支持图形化视图；SQL 模式/未知节点直接拒绝。
 */
export function parseGraphFromViewXml(xml: string): ParsedGraph {
  if (/calculationScenarioType="SCRIPT_BASED"/.test(xml)) {
    throw new HanaBusinessError('SQL 模式视图不支持 graph 增量合并；请用 operations=set_script 或 xml 全量通道');
  }
  const def = parseViewDefinition(xml, 'calculationview');
  const lmId = /<logicalModel[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
  if (!lmId) throw new HanaBusinessError('XML 中缺少 <logicalModel id="…">，无法解析图');
  const sources: GraphSourceSpec[] = def.dataSources.map((d) => {
    if (d.type === 'CALCULATION_VIEW') {
      if (!d.resourceUri) throw new HanaBusinessError(`数据源 ${d.id} 是 CV 但缺少 resourceUri`);
      return sourceResourceUriToSpec(d.id, d.resourceUri);
    }
    if (d.type === 'DATA_BASE_VIEW') {
      throw new HanaBusinessError(`graph 更新不支持 DATA_BASE_VIEW 源（${d.id}）；请改用 xml 全量通道`);
    }
    if (!d.schemaName || !d.columnObjectName) {
      throw new HanaBusinessError(`数据源 ${d.id} 缺少 schemaName/columnObjectName`);
    }
    return { id: d.id, type: 'table', schema: d.schemaName, name: d.columnObjectName };
  });
  const nodes = def.nodes.map(nodeSpecFromViewNode);
  const outputFields: GraphOutputFieldSpec[] = [
    ...def.outputs.attributes.map((f) => ({ id: f.id, kind: 'attribute' as const, description: f.description })),
    ...def.outputs.measures.map((f) => ({
      id: f.id,
      kind: 'measure' as const,
      aggregationType: f.aggregationType,
      description: f.description,
    })),
  ];
  return {
    graph: { sources, nodes, output: lmId, outputFields },
    calculatedAttributes: innerSection(xml, 'calculatedAttributes'),
    calculatedMeasures: innerSection(xml, 'calculatedMeasures'),
    restrictedMeasures: innerSection(xml, 'restrictedMeasures'),
    localDimensions: innerSection(xml, 'localDimensions'),
  };
}

/** update：按 id 把 patch 合并进现有图；remove 删除节点/数据源 */
export function mergeGraphPatch(parsed: ParsedGraph, patch: GraphPatch): GraphSpec {
  const sources = new Map(parsed.graph.sources.map((s) => [s.id, s]));
  const nodes = new Map(parsed.graph.nodes.map((n) => [n.id, n]));
  for (const s of patch.sources ?? []) sources.set(s.id, s);
  for (const n of patch.nodes ?? []) nodes.set(n.id, n);
  for (const id of patch.remove ?? []) {
    const had = sources.delete(id) || nodes.delete(id);
    if (!had) throw new HanaBusinessError(`remove 指向的 id "${id}" 不存在于现有图中`);
  }
  const output = patch.output ?? parsed.graph.output;
  const fields = new Map((parsed.graph.outputFields ?? []).map((f) => [f.id, f]));
  for (const f of patch.outputFields ?? []) fields.set(f.id, f);
  for (const id of patch.removeOutputFields ?? []) {
    if (!fields.delete(id)) throw new HanaBusinessError(`removeOutputFields 指向的字段 "${id}" 不存在`);
  }
  return {
    sources: [...sources.values()],
    nodes: [...nodes.values()],
    output,
    outputFields: [...fields.values()],
  };
}

export interface MergeGraphOptions {
  /** 是否重写 layout（默认 true） */
  layout?: boolean;
}

/**
 * update：把增量补丁合并进现有 XML。保留对象根属性/描述/变量等非图段；
 * 重建 dataSources / calculationViews / logicalModel。现有计算字段原文原样保留
 * （仅当输出节点不变；改变输出节点时拒绝，避免悬空/公式失效）。
 */
export function mergeGraphIntoViewXml(
  xml: string,
  patch: GraphPatch,
  resolvedSources: readonly ResolvedSource[],
  opts: MergeGraphOptions = {},
): string {
  const parsed = parseGraphFromViewXml(xml);
  const merged = mergeGraphPatch(parsed, patch);
  const outputChanged = merged.output !== parsed.graph.output;
  const hasCalculated =
    parsed.calculatedAttributes.trim() !== '' ||
    parsed.calculatedMeasures.trim() !== '' ||
    parsed.restrictedMeasures.trim() !== '';
  if (outputChanged && hasCalculated) {
    throw new HanaBusinessError(
      'graph 更新改变了输出节点，但现有 logicalModel 含计算/限制度量字段；本版不代迁这些字段。' +
        '请保持 output 不变，或改用 xml 全量通道',
    );
  }
  const resolved = resolveGraph(resolvedSources, merged.nodes, merged.output, merged.outputFields);
  const sections = renderGraphSections(resolved, {
    attributes: parsed.calculatedAttributes,
    measures: parsed.calculatedMeasures,
    restricted: parsed.restrictedMeasures,
    localDimensions: parsed.localDimensions,
  });
  let out = replaceGraphSections(xml, sections);
  if (resolved.outputFields.some((f) => f.kind === 'measure')) out = ensureCubeDataCategory(out);
  if (opts.layout !== false) out = autoLayoutViewXml(out).xml;
  return out;
}
