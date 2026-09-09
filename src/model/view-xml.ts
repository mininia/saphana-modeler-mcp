import { createXmlParser } from '../core/xml.js';
import type {
  ViewAttributeFilter,
  ViewCalculatedAttribute,
  ViewDataSource,
  ViewDefinition,
  ViewKind,
  ViewNode,
  ViewNodeInput,
  ViewNodeMapping,
  ViewOutputField,
  ViewRankDefinition,
  ViewVariable,
} from './view-types.js';

/**
 * 仓库 XML（_SYS_REPO.ACTIVE_OBJECT.CDATA）→ 结构化 ViewDefinition。
 * 三种命名空间：
 * - Calculation View: Calculation:scenario（BiModelCalculation.ecore）
 * - Attribute View:   Dimension:dimension（BiModelDimension.ecore）
 * - Analytic View:    Cube:cube（BiModelCube.ecore）
 *
 * 宽容策略：字段全部可选链 + 数组归一化；不认识的节点不进模型但保留在 raw。
 */

type XmlNode = Record<string, unknown> | undefined | null;

/** Rank 节点 windowFunction 解析：partitionViewAttributeName + `<order byViewAttributeName direction>` + rankThreshold */
function parseRank(obj: Record<string, unknown>): ViewRankDefinition | undefined {
  if (localType(obj['@_xsi:type']) !== 'RankView') return undefined;
  const wf = obj['windowFunction'];
  const o = wf && typeof wf === 'object' && !Array.isArray(wf) ? (wf as Record<string, unknown>) : undefined;
  if (!o) return undefined;
  // partitionViewAttributeName 是文本元素（可多个）
  const partitionBy = toArray<unknown>(o['partitionViewAttributeName'])
    .map((p) => (typeof p === 'string' ? p : text(p)))
    .filter((p): p is string => !!p);
  // `<order byViewAttributeName="COL" direction="ASC"/>`：fast-xml-parser 解析为 order.{@_byViewAttributeName,@_direction}
  const orderBy = toArray<XmlNode>(o['order'])
    .map((ord) => ({
      column: str(ord, '@_byViewAttributeName') ?? '',
      direction: str(ord, '@_direction'),
    }))
    .filter((x) => x.column);
  const thObj = o['rankThreshold'];
  const thRaw = thObj && typeof thObj === 'object' ? (thObj as Record<string, unknown>)['value'] : undefined;
  const threshold = Number(text(thRaw));
  if (partitionBy.length === 0 || orderBy.length === 0 || !Number.isFinite(threshold)) return undefined;
  return { partitionBy, orderBy, threshold };
}

/** 数组归一化：undefined/null/空元素字符串（''，fast-xml-parser 对 <dataSources/> 等空段的结果）→ []，单对象 → [obj]，数组原样 */
function toArray<T>(x: unknown): T[] {
  if (x === undefined || x === null || x === '') return [];
  return Array.isArray(x) ? (x as T[]) : [x as T];
}

/** 取对象属性（字符串） */
function str(node: XmlNode, key: string): string | undefined {
  if (!node || typeof node !== 'object') return undefined;
  const v = (node as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : undefined;
}

/** 取文本（节点可能是字符串或对象；CDATA 与普通文本都支持） */
function text(x: unknown): string | undefined {
  let raw: string | undefined;
  if (typeof x === 'string') raw = x;
  else if (x && typeof x === 'object') {
    const o = x as Record<string, unknown>;
    // fast-xml-parser：普通文本 → #text，CDATA（SQLScript 等）→ #cdata
    if ('#text' in o && typeof o['#text'] === 'string') raw = o['#text'];
    else if ('#cdata' in o && typeof o['#cdata'] === 'string') raw = o['#cdata'];
  }
  if (raw === undefined) return undefined;
  // 解析器 processEntities=false（保留 CDATA 原样），这里对公式/脚本等文本节点
  // 解码 XML 实体，还原真实 SQL/表达式（ZDEMO008_CV001 的公式含 &quot; 与 &#xD;）
  return raw
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#xD;|&#13;|&#x0D;/gi, '') // CR：HANA 公式中总伴随 LF，直接移除
    .replace(/&#10;|&#xA;|&#x0A;/gi, '\n') // LF：还原为换行
    .replace(/&amp;/g, '&');
}

/** xsi:type 的本地名：'Calculation:ProjectionView' → 'ProjectionView' */
function localType(xsiType: unknown): string {
  const s = typeof xsiType === 'string' ? xsiType : '';
  const idx = s.lastIndexOf(':');
  return idx >= 0 ? s.slice(idx + 1) : s;
}

/** descriptions 元素的 defaultDescription */
function defaultDescription(node: XmlNode): string | undefined {
  const d = node && typeof node === 'object' ? (node as Record<string, unknown>)['descriptions'] : undefined;
  if (Array.isArray(d)) return str(d[0] as XmlNode, '@_defaultDescription');
  return str(d as XmlNode, '@_defaultDescription');
}

function parseDataSource(ds: XmlNode): ViewDataSource {
  const columnObject = ds && typeof ds === 'object' ? (ds as Record<string, unknown>)['columnObject'] : undefined;
  const co = Array.isArray(columnObject) ? (columnObject[0] as XmlNode) : (columnObject as XmlNode);
  return {
    id: str(ds, '@_id') ?? '',
    type: str(ds, '@_type') ?? '',
    resourceUri: str(ds, 'resourceUri') ?? str(ds, 'resourceURI'),
    schemaName: str(co, '@_schemaName'),
    columnObjectName: str(co, '@_columnObjectName'),
  };
}

function parseCalculatedAttribute(ca: XmlNode): ViewCalculatedAttribute {
  return {
    id: str(ca, '@_id') ?? '',
    datatype: str(ca, '@_datatype'),
    length: str(ca, '@_length'),
    expressionLanguage: str(ca, '@_expressionLanguage'),
    formula: text((ca as Record<string, unknown> | undefined)?.['formula']),
  };
}

function parseNode(node: XmlNode): ViewNode {
  const obj = (node ?? {}) as Record<string, unknown>;
  /** 取子节点（宽容：obj[key] 可能是 undefined/单对象/数组） */
  const child = (key: string): unknown => obj[key];
  /** 取嵌套段下的子列表，如 viewAttributes > viewAttribute（空段/空元素不产生幽灵条目） */
  const nested = (section: string, item: string): XmlNode[] => {
    const sec = child(section);
    const items = sec && typeof sec === 'object' && !Array.isArray(sec) ? (sec as Record<string, unknown>)[item] : undefined;
    // 空段（<calculatedViewAttributes/> 解析为空串/空对象）不能当成一个条目
    return toArray<XmlNode>(items ?? obj[item]).filter((x) => x != null && typeof x === 'object');
  };
  const inputs = toArray<XmlNode>(child('input')).map((inp): ViewNodeInput => {
    const mappings = toArray<XmlNode>((inp as Record<string, unknown> | undefined)?.['mapping']).map(
      (m): ViewNodeMapping => ({
        target: str(m, '@_target') ?? '',
        source: str(m, '@_source') ?? '',
      }),
    );
    return { node: str(inp, '@_node') ?? '', mappings };
  });
  const joinAttrs = toArray<XmlNode>(child('joinAttribute')).map((j) => str(j, '@_name') ?? '');
  const filterText = text(child('filter'));
  // Aggregation 节点：分组列（aggregateBy）与度量映射（measureMapping，含聚合函数）
  const aggregateBy = toArray<XmlNode>(child('aggregateBy')).map((a) => str(a, '@_columnObjectName') ?? '').filter(Boolean);
  const measures = toArray<XmlNode>(child('measureMapping')).map((m) => ({
    column: str(m, '@_columnObjectName') ?? '',
    aggregationType: str(m, '@_aggregationType'),
  })).filter((m) => m.column);
  // viewAttribute：ID + 聚合函数（格式 B）+ 属性级过滤器（SingleValue/MultiValue 展开为列表）
  const viewAttrs = nested('viewAttributes', 'viewAttribute').map((a) => {
    const aobj = (a ?? {}) as Record<string, unknown>;
    const filters: ViewAttributeFilter[] = [];
    const walk = (x: unknown): void => {
      for (const ff of toArray<XmlNode>(x)) {
        const fo = (ff ?? {}) as Record<string, unknown>;
        const ftype = localType(fo['@_xsi:type']);
        if (ftype === 'MultiValueFilter') {
          walk(fo['filter']); // 展开多值
        } else {
          const including = str(ff, '@_including') === 'true';
          const value = str(ff, '@_value');
          if (value !== undefined) filters.push({ including, value, type: ftype });
        }
      }
    };
    walk(aobj['filter']);
    return { id: str(a, '@_id') ?? '', aggregationType: str(a, '@_aggregationType'), filters };
  });
  // SqlScriptView 的 SQLScript 源码存于 <definition> 元素（含 &quot; 实体，text() 解码）
  const scriptText = text(child('definition'));
  // Rank 节点：windowFunction（partitionViewAttributeName 文本 + `<order byViewAttributeName direction>` 怪标签 + rankThreshold）
  const rank = parseRank(obj);
  return {
    id: str(node, '@_id') ?? '',
    type: localType(obj['@_xsi:type']),
    joinType: str(node, '@_joinType'),
    joinOrder: str(node, '@_joinOrder'),
    joinAttributes: joinAttrs,
    attributes: viewAttrs.map((a) => a.id),
    calculatedAttributes: nested('calculatedViewAttributes', 'calculatedViewAttribute').map(parseCalculatedAttribute),
    aggregateBy,
    measures,
    attributeAggregations: viewAttrs.filter((a) => a.aggregationType).map((a) => ({ id: a.id, aggregationType: a.aggregationType! })),
    attributeFilters: viewAttrs.filter((a) => a.filters.length > 0).map((a) => ({ id: a.id, filters: a.filters })),
    rank,
    script: scriptText,
    inputs,
    filter: filterText,
    extra: Object.fromEntries(
      Object.entries(obj).filter(([k]) => !['@_id', '@_xsi:type', '@_joinType', '@_joinOrder', 'viewAttributes', 'calculatedViewAttributes', 'input', 'joinAttribute', 'aggregateBy', 'measureMapping', 'windowFunction', 'filter', 'definition', 'descriptions'].includes(k)),
    ),
  };
}

function parseVariable(v: XmlNode): ViewVariable {
  const props = v && typeof v === 'object' ? (v as Record<string, unknown>)['variableProperties'] : undefined;
  const p = Array.isArray(props) ? (props[0] as XmlNode) : (props as XmlNode);
  return {
    id: str(v, '@_id') ?? '',
    parameter: str(v, '@_parameter') === 'true',
    datatype: str(p, '@_datatype'),
    length: str(p, '@_length'),
    defaultValue: str(p, '@_defaultValue'),
    mandatory: str(p, '@_mandatory') === 'true',
    description: defaultDescription(v),
  };
}

function parseOutputField(field: XmlNode, kind: 'attribute' | 'measure'): ViewOutputField {
  const obj = (field ?? {}) as Record<string, unknown>;
  const mapping = obj['keyMapping'] ?? obj['measureMapping'];
  const m = Array.isArray(mapping) ? (mapping[0] as XmlNode) : (mapping as XmlNode);
  return {
    id: str(field, '@_id') ?? '',
    order: str(field, '@_order') ? Number(str(field, '@_order')) : undefined,
    key: str(field, '@_key') === 'true',
    hidden: str(field, '@_hidden') === 'true',
    description: defaultDescription(field),
    sourceColumn: str(m, '@_columnName'),
    sourceObject: str(m, '@_columnObjectName'),
    ...(kind === 'measure'
      ? {
          aggregationType: str(field, '@_aggregationType'),
          measureType: str(field, '@_measureType'),
          datatype: str(field, '@_datatype'),
          length: str(field, '@_length'),
          expressionLanguage: str(field, '@_expressionLanguage'),
          formula: text(obj['formula']),
        }
      : {}),
  };
}

function parseOutputList(root: XmlNode, section: string, kind: 'attribute' | 'measure'): ViewOutputField[] {
  const sec = root && typeof root === 'object' ? (root as Record<string, unknown>)[section] : undefined;
  const items = sec && typeof sec === 'object' ? (sec as Record<string, unknown>)[kind === 'attribute' ? 'attribute' : 'measure'] : undefined;
  return toArray<XmlNode>(items).map((f) => parseOutputField(f, kind));
}

/** 根节点名 → ViewKind（宽容匹配：根名可能带/不带命名空间前缀） */
function detectKind(rootName: string): ViewKind {
  const n = rootName.toLowerCase();
  if (n.includes('dimension')) return 'attributeview';
  if (n.includes('cube')) return 'analyticview';
  return 'calculationview';
}

/**
 * 解析仓库对象 XML → ViewDefinition。
 * @param xml 设计时 XML（CDATA）
 * @param kind 期望类型；缺省时按根节点名自动识别
 */
export function parseViewDefinition(xml: string, kind?: ViewKind): ViewDefinition {
  const parsed = createXmlParser().parse(xml) as Record<string, unknown>;
  // 跳过 ?xml 声明等特殊节点，取真正的根元素（如 Calculation:scenario / Dimension:dimension）
  const rootEntry = Object.entries(parsed).find(([k]) => !k.startsWith('?')) ?? [];
  const rootName = rootEntry[0] ?? '';
  const root = rootEntry[1] as XmlNode;
  const obj = (root ?? {}) as Record<string, unknown>;
  const detected = kind ?? detectKind(rootName);

  const dataSources = toArray<XmlNode>(
    (() => {
      const sec = obj['dataSources'];
      const items = sec && typeof sec === 'object' && !Array.isArray(sec) ? (sec as Record<string, unknown>)['DataSource'] : undefined;
      return items ?? obj['dataSource'] ?? sec;
    })(),
  ).map(parseDataSource);
  const nodes = toArray<XmlNode>(
    (() => {
      const sec = obj['calculationViews'];
      const items = sec && typeof sec === 'object' && !Array.isArray(sec) ? (sec as Record<string, unknown>)['calculationView'] : undefined;
      return items ?? obj['calculationView'] ?? sec;
    })(),
  ).map(parseNode);
  const variables = toArray<XmlNode>(
    (() => {
      const sec = obj['localVariables'];
      const items = sec && typeof sec === 'object' && !Array.isArray(sec) ? (sec as Record<string, unknown>)['variable'] : undefined;
      return items ?? obj['localVariable'] ?? sec;
    })(),
  ).map(parseVariable);
  const logicalModel = obj['logicalModel'] as XmlNode;
  // 输出字段所在段：CV 用 logicalModel，AV（无 logicalModel）用根级 attributes
  const outputSection: XmlNode = logicalModel ?? obj;

  return {
    kind: detected,
    id: str(root, '@_id') ?? '',
    schemaVersion: str(root, '@_schemaVersion'),
    description: defaultDescription(root),
    dataCategory: str(root, '@_dataCategory'),
    outputViewType: str(root, '@_outputViewType'),
    checkAnalyticPrivileges: str(root, '@_checkAnalyticPrivileges') === 'true',
    applyPrivilegeType: str(root, '@_applyPrivilegeType'),
    dimensionType: str(root, '@_dimensionType'),
    dataSources,
    nodes,
    variables,
    outputs: {
      attributes: parseOutputList(outputSection, 'attributes', 'attribute'),
      calculatedAttributes: parseOutputList(outputSection, 'calculatedAttributes', 'attribute'),
      measures: parseOutputList(outputSection, 'baseMeasures', 'measure'),
      calculatedMeasures: parseOutputList(outputSection, 'calculatedMeasures', 'measure'),
      restrictedMeasures: parseOutputList(outputSection, 'restrictedMeasures', 'measure'),
    },
    raw: parsed,
  };
}
