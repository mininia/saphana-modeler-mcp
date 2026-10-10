import { HanaBusinessError } from '../core/errors.js';
import { escapeXmlAttr } from '../core/xml.js';
import {
  normalizeScriptedColumns,
  scriptedOutputSectionsXml,
  scriptedViewAttributesXml,
  wrapScriptedBody,
  type ScriptedColumnSpec,
} from './view-builder.js';
import type { ViewNode } from './view-types.js';
import { parseViewDefinition } from './view-xml.js';

/**
 * 计算视图「声明式加 join」的确定性 XML 变换（修改 CV 无需模型手写 XML）。
 *
 * 目标形态与 BW query 视图生成器同款（以 ZDEMOBI/COPYOFZDEMO01_CV034_1 的 16 级 join 链为范本）：
 *   1. 新增 <DataSource type="CALCULATION_VIEW">（resourceUri 指向源视图）；
 *   2. 新增 Projection_N 把源视图字段取出来（输出源侧原始列名）；
 *   3. 新增 Join_N（leftOuter 等）：左输入 = 原输出节点全字段透传，右输入 = 条件/带出字段映射，
 *      joinAttribute 用「左侧字段名」；左右列名不同时按 BW 同款做法在 join 输入映射里重命名
 *      （target=左字段 source=右字段，范本：该视图 Join_1 的 target="0MATERIAL" source="4ZDEMO01R014_TH"）；
 *   4. logicalModel：id 与全部 keyMapping/measureMapping 的 columnObjectName 重接线到新 Join 节点，
 *      并为带出字段追加 attribute（order 顺延，带源字段中文描述）。
 *
 * 实现策略：对原始 XML 做「锚点字符串手术」而不是 parse→rebuild——
 * 除插入/替换片段外其余内容逐字节保留（informationModelLayout、layout shapes、hidden 属性等零损耗）。
 * 锚点唯一性（实测 BW 方言）：</dataSources>、</calculationViews>、</logicalModel>、</attributes> 各恰好 1 个。
 */

/** join 条件：leftField=当前视图输出节点上的字段；rightField=源视图上的字段（可不同名） */
export interface JoinConditionSpec {
  leftField: string;
  rightField: string;
}

/** 要透出到视图输出的源字段（不含 join 条件字段） */
export interface JoinFieldSpec {
  id: string;
  description?: string;
}

export interface AddJoinSpec {
  /** DataSource id（一般= 源视图对象名，如 ZDEMO01R014_Q017） */
  sourceId: string;
  /** 源视图仓库 URI（如 /system-local.bw.bw2hana.query.zdemo01r014/calculationviews/ZDEMO01R014_Q017） */
  sourceResourceUri: string;
  joinType: 'inner' | 'leftOuter' | 'rightOuter' | 'fullOuter';
  /** join 条件（≥1；多个条件 = 复合 join） */
  conditions: JoinConditionSpec[];
  /** 带出到输出的源字段 */
  fields: JoinFieldSpec[];
}

export interface AddJoinEditResult {
  xml: string;
  /** 原输出节点（join 的左侧输入，如 Join_16） */
  previousFinalNodeId: string;
  /** 新 join 节点（如 Join_17，成为新输出节点） */
  newJoinNodeId: string;
  /** 新 projection 节点（如 Projection_20） */
  newProjectionNodeId: string;
  /** 新数据源 id */
  newDataSourceId: string;
  /** joinAttribute 名单（= 各条件的 leftField） */
  joinAttributeNames: string[];
  /** 新增的输出字段（id + logicalModel order） */
  addedOutputFields: Array<{ id: string; order: number }>;
}

/** 从节点 id 集合推下一个序号：Projection_19 存在 → 下一个 Projection_20（BW 链里编号可乱序，取 max+1） */
function nextNodeNumber(ids: string[], prefix: string): number {
  let max = 0;
  for (const id of ids) {
    const m = id.match(new RegExp(`^${prefix}_(\\d+)$`));
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/** 输出节点 = 没有任何节点引用的汇点；必须恰好 1 个（BW 链状结构保证） */
function findFinalNode(nodes: ViewNode[]): ViewNode {
  const referenced = new Set(nodes.flatMap((n) => n.inputs.map((i) => i.node.replace(/^#/, ''))));
  const sinks = nodes.filter((n) => !referenced.has(n.id));
  if (sinks.length === 0) throw new HanaBusinessError('视图中找不到输出节点（所有节点都被下游引用，疑似环）');
  if (sinks.length > 1) {
    throw new HanaBusinessError(
      `视图存在 ${sinks.length} 个输出节点（${sinks.map((s) => s.id).join(', ')}），无法确定 join 挂载点；` +
        `当前仅支持单输出链状视图的自动加 join`,
    );
  }
  return sinks[0];
}

/**
 * 读取当前输出节点（join 将挂载的左侧输入）及其字段清单。
 * 供服务层在生成默认带出字段清单时使用（与 addJoinToViewXml 内部同一套判定）。
 */
export function getJoinTargetAttrs(xml: string): { nodeId: string; attributes: string[] } {
  const finalNode = findFinalNode(parseViewDefinition(xml, 'calculationview').nodes);
  const lmId = xml.match(/<logicalModel id="([^"]+)"/)?.[1];
  if (lmId && lmId !== finalNode.id) {
    throw new HanaBusinessError(`输出节点不一致：节点树汇点 ${finalNode.id} ≠ logicalModel 声明 ${lmId}，拒绝变换`);
  }
  return { nodeId: finalNode.id, attributes: finalNode.attributes };
}

/** 默认带出字段：源视图可见（非 hidden）输出属性 − join 条件右字段 − 已存在于左侧链的字段。
 * 例：Q017 可见属性 {4ZDEMO01R014_FLAG, ZDEMO_MAT}、条件右字段 ZDEMO_MAT、左侧已有 0MATERIAL
 * → 默认带出 [4ZDEMO01R014_FLAG]。
 */
export function chooseDefaultJoinFields(
  sourceFields: Array<{ id: string; hidden?: boolean }>,
  conditionRightFields: string[],
  leftAttrs: string[],
): string[] {
  const condSet = new Set(conditionRightFields);
  const leftSet = new Set(leftAttrs);
  return sourceFields.filter((f) => !f.hidden && !condSet.has(f.id) && !leftSet.has(f.id)).map((f) => f.id);
}

/** 全量 XML 更新的护栏校验结果（随 hana_view_update 返回，供模型免回读自检） */
export interface FullXmlGuardResult {
  scenarioId: string;
  /** logicalModel 指向的输出节点 */
  logicalModelNode: string;
  /** 输出字段总数（属性 + 各类度量） */
  outputFieldCount: number;
  dataCategory?: string;
}

/**
 * 全量 XML 更新（hana_view_update xml 方式）的服务端护栏——手工改 XML 两大高频事故在写入前拦下：
 * 1. 场景 id 与目标对象不一致（粘贴了其他对象的定义 / 误改根 id）；
 * 2. logicalModel 指向的输出节点不存在（重构节点后忘记把 id 与 keyMapping/measureMapping 重接线）。
 * 校验失败即抛错（不发起 PUT），通过则返回摘要供模型确认。
 */
export function guardFullXmlUpdate(xml: string, objectName: string): FullXmlGuardResult {
  const def = parseViewDefinition(xml, 'calculationview');
  if (!def.id) throw new HanaBusinessError('XML 缺少根节点 id（Calculation:scenario @id），拒绝全量更新');
  if (def.id.toUpperCase() !== objectName.toUpperCase()) {
    throw new HanaBusinessError(
      `XML 根 id "${def.id}" 与目标对象 "${objectName}" 不一致——疑似粘贴了其他对象的定义或误改了场景 id。` +
        `全量更新要求 scenario id 与对象名一致；如需复制成新对象请改走 hana_repo_import`,
    );
  }
  const lmId = xml.match(/<logicalModel id="([^"]+)"/)?.[1];
  if (!lmId) throw new HanaBusinessError('XML 缺少 <logicalModel id="..."> 声明，无法确定输出节点，拒绝全量更新');
  if (!def.nodes.some((n) => n.id === lmId)) {
    throw new HanaBusinessError(
      `logicalModel 指向的输出节点 "${lmId}" 不存在于节点树（现有节点：${def.nodes.map((n) => n.id).join(', ')}）。` +
        `这是手工改 XML 最常见的遗漏：重构节点后忘记把 logicalModel 的 id 与全部 keyMapping/measureMapping 的 columnObjectName 重接线到新节点`,
    );
  }
  const o = def.outputs;
  return {
    scenarioId: def.id,
    logicalModelNode: lmId,
    outputFieldCount:
      o.attributes.length +
      o.measures.length +
      o.calculatedAttributes.length +
      o.calculatedMeasures.length +
      o.restrictedMeasures.length,
    dataCategory: def.dataCategory,
  };
}

/**
 * logicalModel 输出属性块的生成（add_join 追加带出字段 / add_calculated_column 追加计算列两处共用）：
 * 形状与 BW 方言一致（属性 + keyMapping 指向**节点列**）。
 */
function outputAttributeBlock(id: string, order: number, sourceObject: string, description?: string): string {
  const lines = [
    `      <attribute id="${escapeXmlAttr(id)}" order="${order}"` +
      ` attributeHierarchyActive="false" displayAttribute="false">`,
  ];
  if (description) lines.push(`        <descriptions defaultDescription="${escapeXmlAttr(description)}"/>`);
  lines.push(
    `        <keyMapping columnObjectName="${escapeXmlAttr(sourceObject)}" columnName="${escapeXmlAttr(id)}"/>`,
    `      </attribute>`,
  );
  return lines.join('\n');
}

/**
 * 往 logicalModel 的 <attributes> 段追加输出属性块（单点实现，两处 op 共用）。
 * 锚点要兼容三种形态——Studio 逐行排版 / 自闭合空段 / **单行紧凑 XML**
 * （最后一类是本服务生成器的产出：漏了它，「刚 create 出来的视图」就加不了字段）
 */
function appendLogicalModelAttribute(lmContent: string, blocks: string[]): string {
  if (blocks.length === 0) return lmContent;
  const attrCloseIndented = '\n    </attributes>';
  if (lmContent.includes(attrCloseIndented)) {
    return lmContent.replace(attrCloseIndented, `\n${blocks.join('\n')}${attrCloseIndented}`);
  }
  if (lmContent.includes('<attributes/>')) {
    return lmContent.replace('<attributes/>', `<attributes>\n${blocks.join('\n')}\n    </attributes>`);
  }
  if (lmContent.includes('</attributes>')) {
    return lmContent.replace('</attributes>', `${blocks.join('\n')}\n    </attributes>`);
  }
  throw new HanaBusinessError('logicalModel 中找不到 </attributes> 或 <attributes/> 锚点，无法追加输出字段');
}

/**
 * 对原始设计时 XML 执行「追加一个 join」变换（纯函数；失败即抛错，不产出半成品）。
 */
export function addJoinToViewXml(xml: string, spec: AddJoinSpec): AddJoinEditResult {
  if (spec.conditions.length === 0) throw new HanaBusinessError('join 条件不能为空（至少 1 组 leftField/rightField）');
  // SQL 模式视图的输出就是脚本本身，图形化加 join 无意义（改了也编译不过）——直接指路而不是报"找不到锚点"
  if (/calculationScenarioType="SCRIPT_BASED"/.test(xml)) {
    throw new HanaBusinessError(
      '该视图为 SQL 模式（SCRIPT_BASED）：其输出由脚本决定，不支持 op=add_join。' +
        '请把 join 写进脚本并用 op=set_script 替换，或走 xml 全量通道改造',
    );
  }
  const { nodeId: finalNodeId, attributes: leftAttrs } = getJoinTargetAttrs(xml);
  const nodeIds = parseViewDefinition(xml, 'calculationview').nodes.map((n) => n.id);

  // 条件校验：左字段必须在输出节点上；左字段不得重复（同目标多次映射冲突）
  const seenLeft = new Set<string>();
  for (const c of spec.conditions) {
    if (!leftAttrs.includes(c.leftField)) {
      throw new HanaBusinessError(
        `leftField "${c.leftField}" 不存在于当前输出节点 ${finalNodeId}（现有字段：${leftAttrs.join(', ')}）。` +
          `join 条件的左字段必须是视图已有字段`,
      );
    }
    if (seenLeft.has(c.leftField))
      throw new HanaBusinessError(`join 条件左字段 "${c.leftField}" 重复（同目标字段不允许两组条件）`);
    seenLeft.add(c.leftField);
  }

  // 带出字段校验：不得与左侧已有字段同名（会冲突）；不得重复
  const seenBring = new Set<string>();
  for (const f of spec.fields) {
    if (leftAttrs.includes(f.id))
      throw new HanaBusinessError(`带出字段 "${f.id}" 与视图已有字段同名，将产生冲突；请勿带出或先处理重名`);
    if (seenBring.has(f.id)) throw new HanaBusinessError(`带出字段 "${f.id}" 重复`);
    seenBring.add(f.id);
  }

  const projectionId = `Projection_${nextNodeNumber(nodeIds, 'Projection')}`;
  const joinId = `Join_${nextNodeNumber(nodeIds, 'Join')}`;

  // ── 生成 XML 片段（缩进对齐 BW 方言：节/段 2 空格起，逐层 +2）──────────────
  const mapping = (target: string, source: string): string =>
    `        <mapping xsi:type="Calculation:AttributeMapping"` +
    ` target="${escapeXmlAttr(target)}" source="${escapeXmlAttr(source)}"/>`;

  const dataSourceBlock = [
    `    <DataSource id="${escapeXmlAttr(spec.sourceId)}" type="CALCULATION_VIEW">`,
    `      <viewAttributes allViewAttributes="true"/>`,
    `      <resourceUri>${escapeXmlAttr(spec.sourceResourceUri)}</resourceUri>`,
    `    </DataSource>`,
  ].join('\n');

  // Projection 输出源侧原始列名（join 条件右字段 + 带出字段，去重保序）
  const projFields = [...spec.conditions.map((c) => c.rightField), ...spec.fields.map((f) => f.id)].filter(
    (f, i, a) => a.indexOf(f) === i,
  );
  const projectionBlock = [
    `    <calculationView xsi:type="Calculation:ProjectionView" id="${projectionId}">`,
    `      <descriptions/>`,
    `      <viewAttributes>`,
    ...projFields.map((f) => `        <viewAttribute id="${escapeXmlAttr(f)}"/>`),
    `      </viewAttributes>`,
    `      <calculatedViewAttributes/>`,
    `      <input node="#${escapeXmlAttr(spec.sourceId)}">`,
    ...projFields.map((f) => mapping(f, f)),
    `      </input>`,
    `    </calculationView>`,
  ].join('\n');

  // Join 节点：viewAttributes = 左侧全字段 + 带出字段；左输入 = 左侧字段透传；
  // 右输入 = 条件重命名（target=左字段 source=右字段，与 BW 范本同款）+ 带出字段透传
  const joinAttrs = [...leftAttrs, ...spec.fields.map((f) => f.id)];
  const joinBlock = [
    `    <calculationView xsi:type="Calculation:JoinView" id="${joinId}"` +
      ` joinOrder="OUTSIDE_IN" joinType="${escapeXmlAttr(spec.joinType)}">`,
    `      <descriptions/>`,
    `      <viewAttributes>`,
    ...joinAttrs.map((f) => `        <viewAttribute id="${escapeXmlAttr(f)}"/>`),
    `      </viewAttributes>`,
    `      <calculatedViewAttributes/>`,
    `      <input node="#${escapeXmlAttr(finalNodeId)}">`,
    ...leftAttrs.map((f) => mapping(f, f)),
    `      </input>`,
    `      <input node="#${projectionId}">`,
    ...spec.conditions.map((c) => mapping(c.leftField, c.rightField)),
    ...spec.fields.map((f) => mapping(f.id, f.id)),
    `      </input>`,
    ...spec.conditions.map((c) => `      <joinAttribute name="${escapeXmlAttr(c.leftField)}"/>`),
    `    </calculationView>`,
  ].join('\n');

  // ── 锚点手术（每步断言锚点唯一，打不准就整体失败）────────────────────────
  let out = xml;
  out = replaceSection(out, 'dataSources', { kind: 'append', block: dataSourceBlock });
  out = replaceSection(out, 'calculationViews', { kind: 'append', block: `${projectionBlock}\n${joinBlock}` });

  // logicalModel 重接线（在插入后的最新文本上重新定位，位置已因插入而偏移）：
  // id → 新 join 节点；全部 columnObjectName="旧节点" → 新节点
  // （columnObjectName 同时出现在 keyMapping 与 measureMapping，一并重接线）
  const lmStart = out.indexOf('<logicalModel');
  const lmEnd = out.indexOf('</logicalModel>', lmStart);
  if (lmStart < 0 || lmEnd < 0) throw new HanaBusinessError('XML 中找不到 <logicalModel> 段，无法重接线输出');
  let lmNew = out.slice(lmStart, lmEnd);
  const maxOrder = [...lmNew.matchAll(/order="(\d+)"/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
  const addedOutputFields = spec.fields.map((f, i) => ({ id: f.id, order: maxOrder + i + 1 }));
  const attrBlocks = spec.fields.map((f, i) => outputAttributeBlock(f.id, maxOrder + i + 1, joinId, f.description));
  lmNew = lmNew.replace(/<logicalModel id="[^"]+"/, `<logicalModel id="${joinId}"`);
  lmNew = lmNew.split(`columnObjectName="${finalNodeId}"`).join(`columnObjectName="${joinId}"`);
  lmNew = appendLogicalModelAttribute(lmNew, attrBlocks);
  out = out.slice(0, lmStart) + lmNew + out.slice(lmEnd);

  return {
    xml: out,
    previousFinalNodeId: finalNodeId,
    newJoinNodeId: joinId,
    newProjectionNodeId: projectionId,
    newDataSourceId: spec.sourceId,
    joinAttributeNames: spec.conditions.map((c) => c.leftField),
    addedOutputFields,
  };
}

/** 标签段的定位结果（定位逻辑全仓一份，见 replaceSection） */
interface Section {
  /** 段首：开标签的 `<` 下标 */
  start: number;
  /** 段尾：闭标签之后（自闭合段为标签自身之后） */
  end: number;
  selfClosed: boolean;
  /** 标签独占一行时该行的行首缩进；行内标签前还有其他内容（紧凑 XML）时为 '' */
  indent: string;
  /** append 模式的插入点：闭标签独占一行时取行首（块与子元素对齐），否则取闭标签处 */
  appendAt: number;
}

/**
 * 定位标签段：`<tag …>…</tag>` 或自闭合 `<tag/>`。
 * 锚点必须唯一（开/闭标签各只允许一处）：重复说明文档结构不是我们理解的样子，
 * 改错段比报错更糟。
 */
function locateSection(xml: string, tag: string): Section {
  const opens = [...xml.matchAll(new RegExp(`<${tag}(\\s[^>]*)?/?>`, 'g'))];
  if (opens.length === 0) {
    throw new HanaBusinessError(`XML 中找不到 <${tag}> 段，拒绝变换（该视图形态可能不受支持）`);
  }
  if (opens.length > 1) throw new HanaBusinessError(`XML 中 <${tag}> 段不唯一（${opens.length} 处），拒绝变换`);
  const open = opens[0];
  const start = open.index;
  const end = start + open[0].length;
  const lineStart = xml.lastIndexOf('\n', start) + 1;
  const prefix = xml.slice(lineStart, start);
  const indent = prefix.trim() === '' ? prefix : '';
  if (open[0].endsWith('/>')) return { start, end, selfClosed: true, indent, appendAt: start };
  const close = `</${tag}>`;
  const closeAt = xml.indexOf(close, end);
  if (closeAt < 0) throw new HanaBusinessError(`XML 中 <${tag}> 未闭合，拒绝变换`);
  if (xml.indexOf(close, closeAt + close.length) >= 0) {
    throw new HanaBusinessError(`XML 中 </${tag}> 锚点不唯一，拒绝变换`);
  }
  const closeLineStart = xml.lastIndexOf('\n', closeAt) + 1;
  const closePrefix = xml.slice(closeLineStart, closeAt);
  return {
    start,
    end: closeAt + close.length,
    selfClosed: false,
    indent,
    appendAt: closePrefix.trim() === '' ? closeLineStart : closeAt,
  };
}

/**
 * 标签段的唯一手术入口（原先 findSection / replaceSectionInner / stripSectionWrapper /
 * insertBeforeClose 四个助手各写一遍「找段 + 锚点唯一 + 自闭合 + 缩进」，规则会各自漂移）：
 * - replace：整段（含标签）换掉；
 * - inner：  只换段内容，开/闭标签与缩进沿用原文（内容为空 → 收敛为自闭合段）；
 * - append： 在闭标签前插入块。三种形态都要能落：逐行排版（块与锚点行缩进对齐）、
 *   单行紧凑 XML（无缩进可依，直接插在闭标签前；漏了这一类，「刚 create 出来的视图」就加不了
 *   join）、自闭合空段（如 SQL 模式视图的 `<dataSources/>`：展开成对标签后插入）。
 */
function replaceSection(
  xml: string,
  tag: string,
  rewrite: { kind: 'replace'; text: string } | { kind: 'inner'; content: string } | { kind: 'append'; block: string },
): string {
  const sec = locateSection(xml, tag);
  let text: string;
  if (rewrite.kind === 'replace') {
    text = rewrite.text;
  } else if (rewrite.kind === 'inner') {
    // 与旧实现严格同形：开标签重建为裸 <tag>（不带属性），闭标签前补一个换行 + 行首缩进
    text = rewrite.content === '' ? `<${tag}/>` : `<${tag}>${rewrite.content}\n${sec.indent}</${tag}>`;
  } else if (sec.selfClosed) {
    text = `<${tag}>\n${rewrite.block}\n  </${tag}>`;
  } else {
    const whole = xml.slice(sec.start, sec.end);
    const at = sec.appendAt - sec.start;
    text = `${whole.slice(0, at)}${rewrite.block}\n${whole.slice(at)}`;
  }
  return `${xml.slice(0, sec.start)}${text}${xml.slice(sec.end)}`;
}

/** 取段原文的内部内容（生成器产出的 `<tag>…</tag>` → 内容；自闭合段 → ''） */
function sectionContent(section: string, tag: string): string {
  const m = new RegExp(`^\\s*<${tag}>([\\s\\S]*?)</${tag}>\\s*$`).exec(section);
  return m ? m[1] : '';
}

/* ── op=set_script：替换 SQL 模式视图的脚本与输出列（零 XML）────────────────
 * 与 addJoinToViewXml 同一策略：对原始 XML 做锚点字符串手术，除被替换的片段外逐字节保留。
 * 三处被替换：SqlScriptView 的 <definition>（SQL 正文）、该节点的 <viewAttributes>（列 + datatype）、
 * logicalModel 的 <attributes>/<baseMeasures>（输出字段与类型）。
 * 之所以整体重建输出段而不是增量追加：脚本一换，输出列集合通常会变（增删列都常见），
 * 增量补齐会留下旧列 → 激活报"输出字段不存在于脚本"。 */

/** set_script 的输入（列清单类型直接复用 view-builder，避免同一形状两处声明） */
export interface SetScriptSpec {
  /** 新 SQL 查询（服务端自动包成 BEGIN…VAR_OUT…END 过程体；也可直接给完整过程体） */
  script: string;
  /** 输出列清单（datatype 必填——本环境实测 viewAttribute 缺 datatype 激活失败） */
  columns: ScriptedColumnSpec[];
}

export interface SetScriptEditResult {
  xml: string;
  /** SqlScriptView 节点 id */
  scriptNodeId: string;
  attributeCount: number;
  measureCount: number;
  /** 随度量集合重写的根节点 dataCategory（含度量必须 CUBE，否则激活 40117） */
  dataCategory: 'CUBE' | 'DEFAULT';
  /** 正文（含 BEGIN…VAR_OUT…END 过程体包装）字符数：替换前 → 后，便于确认确实换了内容 */
  scriptBytes: { before: number; after: number };
}

/**
 * 替换 SQL 模式视图的脚本与输出列。
 * @throws 非 SQL 模式（无 SqlScriptView 节点）或锚点缺失时抛错，不产出半成品
 */
export function setScriptInViewXml(xml: string, spec: SetScriptSpec): SetScriptEditResult {
  // 与 create 同一包装规则：正文必须是 BEGIN…VAR_OUT = <查询>;…END 的过程体（见 wrapScriptedBody）
  const script = wrapScriptedBody(spec.script);

  const def = parseViewDefinition(xml, 'calculationview');
  const scriptNodes = def.nodes.filter((n) => n.type === 'SqlScriptView');
  if (scriptNodes.length === 0) {
    throw new HanaBusinessError(
      'set_script 仅适用于 SQL 模式视图（单 SqlScriptView 节点）。当前视图为图形化模型' +
        `（节点：${def.nodes.map((n) => `${n.id}(${n.type})`).join(', ') || '无'}）。` +
        '图形化视图改用 op=add_join，或走 xml 全量方式改造',
    );
  }
  if (scriptNodes.length > 1) {
    throw new HanaBusinessError(
      `视图含 ${scriptNodes.length} 个 SqlScriptView 节点（${scriptNodes.map((n) => n.id).join(', ')}）：` +
        'set_script 只支持单脚本节点的 SQL 模式视图（否则无法确定要替换哪一个），请走 xml 全量方式改造',
    );
  }
  const scriptNode = scriptNodes[0];

  // 列清单：与 create(mode=sql) 共用同一份校验/归一化（各写一份会让规则与转义各自漂移）
  const columns = normalizeScriptedColumns(spec.columns);
  const attributes = columns.filter((c) => !c.isMeasure);
  const measures = columns.filter((c) => c.isMeasure);

  // 1) SqlScriptView 节点块：<definition> 与 <viewAttributes> 都在**节点内**替换
  // （旧实现取全文档第一个 <definition>，文档里若有别的 definition 会写错元素且静默"成功"）
  const nodeOpen = /<calculationView[^>]*xsi:type="Calculation:SqlScriptView"[^>]*>/.exec(xml);
  if (!nodeOpen) throw new HanaBusinessError('XML 中找不到 SqlScriptView 节点开标签，拒绝变换');
  const nodeClose = xml.indexOf('</calculationView>', nodeOpen.index + nodeOpen[0].length);
  if (nodeClose < 0) throw new HanaBusinessError('SqlScriptView 节点未闭合，拒绝变换');
  let nodeBlock = xml.slice(nodeOpen.index, nodeClose);

  // 1a) <definition>：整段替换为新脚本（XML 实体转义，与仓库既有形态一致）
  nodeBlock = replaceSection(nodeBlock, 'definition', {
    kind: 'replace',
    text: `<definition>${escapeXmlAttr(script)}</definition>`,
  });

  // 1b) <viewAttributes>：列 + 显式 datatype/length（与 create 同一生成器）
  nodeBlock = replaceSection(nodeBlock, 'viewAttributes', {
    kind: 'replace',
    text: scriptedViewAttributesXml(columns),
  });

  let out = `${xml.slice(0, nodeOpen.index)}${nodeBlock}${xml.slice(nodeClose)}`;

  // 2) logicalModel：按新列清单整体重建 attributes / baseMeasures（同一生成器）
  const sections = scriptedOutputSectionsXml(columns, scriptNode.id);
  const lmOpen = /<logicalModel[^>]*>/.exec(out);
  if (!lmOpen) throw new HanaBusinessError('XML 中找不到 <logicalModel>，拒绝变换');
  const lmClose = out.indexOf('</logicalModel>', lmOpen.index + lmOpen[0].length);
  if (lmClose < 0) throw new HanaBusinessError('logicalModel 未闭合，拒绝变换');
  let lm = out.slice(lmOpen.index + lmOpen[0].length, lmClose);
  lm = replaceSection(lm, 'attributes', {
    kind: 'inner',
    content: sectionContent(sections.attributes, 'attributes'),
  });
  lm = replaceSection(lm, 'baseMeasures', {
    kind: 'inner',
    content: sectionContent(sections.measures, 'baseMeasures'),
  });
  out = out.slice(0, lmOpen.index + lmOpen[0].length) + lm + out.slice(lmClose);

  // 3) 根节点 dataCategory 随度量集合重写：本环境实测「含度量必须 CUBE」，
  //    否则 set_script 会产出 create 路径刻意规避的「DEFAULT + 有度量」→ 激活被 40117 拒绝
  const dataCategory = measures.length > 0 ? 'CUBE' : 'DEFAULT';
  out = out.replace(
    /(<Calculation:scenario[^>]*\sdataCategory=")[^"]*(")/,
    (_m, a: string, b: string) => `${a}${dataCategory}${b}`,
  );

  return {
    xml: out,
    scriptNodeId: scriptNode.id,
    attributeCount: attributes.length,
    measureCount: measures.length,
    dataCategory,
    scriptBytes: { before: scriptNode.script?.length ?? 0, after: script.length },
  };
}

/* ── op=set_description：改视图描述/显示名（零 XML）────────────────────────────
 * 真实语料（tests/fixtures 全部夹具 + 实机导出）里，「视图描述 / 显示名」只有**一个** XML 锚点：
 * 根元素下的 `<descriptions defaultDescription="…"/>`——HANA Studio 语义里的 Label/显示名与目录里的
 * 描述是同一处 defaultDescription（对象身份是根 id，改它属于改名而不是改描述；语言相关文本走仓库
 * .properties 翻译文件，不写在 XML 内）。故 `description` 与 `displayName` 两个入参名指向同一锚点：
 *   · 只给一个 → 改它；
 *   · 两个都给 → 必须一致（一个锚点写不进两个值；不一致时显式拒绝，不静默取其一）；
 *   · 都不给 → 显式拒绝（静默返回原文会被调用方读成"改成功了"）。
 * 与 addJoinToViewXml / setScriptInViewXml 同一策略：锚点字符串手术，除被替换的那一个属性外逐字节保留。 */

export interface SetDescriptionSpec {
  /** 视图描述（与 displayName 同锚点，见本节头注） */
  description?: string;
  /** 显示名 / Studio 语义的 Label（与 description 同锚点，见本节头注） */
  displayName?: string;
}

export interface SetDescriptionEditResult {
  xml: string;
  /** 实际写入的字段名（['description','displayName'] 的子集，固定序；目标值本就相同 ⇒ []，一个字节未动） */
  changed: string[];
}

/** 根级 descriptions 段的定位结果（局部助手，只服务 setDescriptionInViewXml） */
interface RootDescriptionsAnchor {
  /** 开标签在文档中的下标 */
  start: number;
  /** 开标签原文 */
  open: string;
  /** 现有 defaultDescription 的**原文**（转义形态未解码；元素未带该属性时 undefined） */
  value?: string;
}

/**
 * 定位根元素的 `<descriptions …>` 段——**刻意不用 locateSection**：那个助手要求标签在文档里唯一，
 * 而 `<descriptions>` 在节点/输出字段/变量里大量重复；这里要的是**根元素的第一处**（真实语料中它恒在
 * `<origin/>` 之后、其余子段之前，是唯一没有歧义的定位点）。第一处之前出现别的子段（或找不到该段）⇒
 * 文档结构与已知方言不符：拒绝变换，而不是拿一处节点级描述当视图描述来改。
 */
function locateRootDescriptions(xml: string): RootDescriptionsAnchor {
  // 跳过 <?xml …?> 声明；根元素开标签之后才是候选区
  const decl = /^\s*<\?xml[^>]*\?>/.exec(xml);
  const afterDecl = decl ? decl[0].length : 0;
  const rootOpen = /<[^>]+>/.exec(xml.slice(afterDecl));
  if (!rootOpen) throw new HanaBusinessError('XML 无根元素开标签，拒绝变换');
  const rootEnd = afterDecl + rootOpen.index + rootOpen[0].length;
  const m = /<descriptions(\s[^>]*?)?\/?>/.exec(xml.slice(rootEnd));
  if (!m) throw new HanaBusinessError('XML 中找不到根级 <descriptions> 段（视图描述锚点），拒绝变换');
  const between = xml.slice(rootEnd, rootEnd + m.index);
  if (!/^\s*(?:<origin\s*\/>|<origin\s*>\s*<\/origin\s*>)?\s*$/.test(between)) {
    throw new HanaBusinessError(
      '根元素下 <descriptions> 之前出现了 <origin/> 之外的子段：文档结构与已知方言不符，拒绝变换' +
        '（无法确认该处就是视图描述——改错锚点比报错更糟）',
    );
  }
  const attr = /\sdefaultDescription="([^"]*)"/.exec(m[0]);
  return { start: rootEnd + m.index, open: m[0], value: attr ? attr[1] : undefined };
}

/**
 * 改视图描述与/或显示名（纯函数；只动根级 descriptions 的一个属性，其余逐字节保留）。
 * @throws 两字段都没给 / 两个给的值不一致 / 找不到根级锚点时抛中文业务错误，不产出半成品
 */
export function setDescriptionInViewXml(xml: string, spec: SetDescriptionSpec): SetDescriptionEditResult {
  const given: string[] = [];
  if (spec.description !== undefined) given.push('description');
  if (spec.displayName !== undefined) given.push('displayName');
  if (given.length === 0) {
    throw new HanaBusinessError(
      'set_description 需要至少给出 description 或 displayName 之一（两者都没给 = 无操作，已拒绝）',
    );
  }
  if (spec.description !== undefined && spec.displayName !== undefined && spec.description !== spec.displayName) {
    throw new HanaBusinessError(
      `description 与 displayName 在本环境指向同一个 XML 锚点（根 <descriptions defaultDescription>）：` +
        `两个值不一致（"${spec.description}" vs "${spec.displayName}"）无法同时写入，请只给一个或让两者一致`,
    );
  }
  // 目标值先转义再与锚点现有值比：两边同为**原文**（转义形态）口径一致——含实体的旧值不会因转义差异被误判成"变了"
  const target = escapeXmlAttr(spec.description ?? spec.displayName!);
  const anchor = locateRootDescriptions(xml);
  // 值本就相同 ⇒ 不改一个字节（幂等，也不给调用方制造"改过了"的假象）
  if (anchor.value === target) return { xml, changed: [] };
  const open =
    anchor.value !== undefined
      ? anchor.open.replace(/\sdefaultDescription="[^"]*"/, ` defaultDescription="${target}"`)
      : // 元素存在但没带 defaultDescription（如 <descriptions/>）：最小插入 = 只补这一个属性
        anchor.open.replace(/^<descriptions/, `<descriptions defaultDescription="${target}"`);
  return { xml: xml.slice(0, anchor.start) + open + xml.slice(anchor.start + anchor.open.length), changed: given };
}

/* ── P8 其余 op（2026-10-09）：rename_field / drop_field / add_calculated_column / set_attribute_filter / set_variable ──
 * 与既有三个 op 同一策略：锚点字符串手术（除被改动的片段外逐字节保留）、锚点缺失或结构与已知方言不符即拒绝，
 * 失败不产出半成品。结构面判据与参数面在 services/view-ops.rules.ts（声明↔schema↔实现三方由单测钉住）。
 * 方言依据：tests/fixtures/*.xml 的真实导出形态 + model/view-xml.ts 的解析契约（两侧同源，不各写一份）。 */

/** 输出字段的种类（= logicalModel 里五个小节；与 view-xml 的 ViewOutputKind 对应） */
export type OutputFieldKind =
  'attribute' | 'calculatedAttribute' | 'measure' | 'calculatedMeasure' | 'restrictedMeasure';

/**
 * logicalModel 的五个输出小节。`tags` 兼容两种元素名（与 view-xml.parseOutputList 同口径）：
 * 本仓语料用 kind 名（`<attribute>`/`<measure>`），真实方言也可能用 section 单数（`<calculatedAttribute>` 等）。
 */
const OUTPUT_SECTIONS: ReadonlyArray<{ section: string; kind: OutputFieldKind; tags: readonly string[] }> = [
  { section: 'attributes', kind: 'attribute', tags: ['attribute'] },
  { section: 'calculatedAttributes', kind: 'calculatedAttribute', tags: ['calculatedAttribute', 'attribute'] },
  { section: 'baseMeasures', kind: 'measure', tags: ['measure'] },
  { section: 'calculatedMeasures', kind: 'calculatedMeasure', tags: ['calculatedMeasure', 'measure'] },
  { section: 'restrictedMeasures', kind: 'restrictedMeasure', tags: ['restrictedMeasure', 'measure'] },
];

/**
 * 公式/过滤器可能**按名引用输出字段**的小节——改名/删除前的引用守卫只扫这三处。
 * 为什么不扫全文档：节点列与输出名是**两层名字**（keyMapping 的 columnName 是节点列，attribute 的 id 是输出名），
 * BW 语料里两层常常同名（passThrough）——全文档扫会把"改输出别名"这一正常操作全部误拒。
 */
const REFERENCE_SECTIONS = ['calculatedAttributes', 'calculatedMeasures', 'restrictedMeasures'] as const;

/** 正则元字符转义（id 来自调用方，不能直接拼进 RegExp） */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** logicalModel 段的内容边界（多个助手共用；找不到/未闭合即抛错） */
function logicalModelSpan(xml: string): { contentStart: number; contentEnd: number; content: string } {
  const open = /<logicalModel[^>]*>/.exec(xml);
  if (!open) throw new HanaBusinessError('XML 中找不到 <logicalModel> 段，拒绝变换');
  const closeAt = xml.indexOf('</logicalModel>', open.index + open[0].length);
  if (closeAt < 0) throw new HanaBusinessError('XML 中 <logicalModel> 未闭合，拒绝变换');
  const contentStart = open.index + open[0].length;
  return { contentStart, contentEnd: closeAt, content: xml.slice(contentStart, closeAt) };
}

/** 容器段的**内容**边界；自闭合（`<tag/>`）返回空内容。找不到返回 undefined */
function containerRange(text: string, tag: string): { contentStart: number; contentEnd: number } | undefined {
  // `/?` 与 locateSection 同款：漏了它 `<calculatedViewAttributes/>` 这类自闭合段会整个匹配不到
  const m = new RegExp(`<${tag}(\\s[^>]*)?/?>`).exec(text);
  if (!m) return undefined;
  if (m[0].endsWith('/>')) return { contentStart: m.index + m[0].length, contentEnd: m.index + m[0].length };
  const close = text.indexOf(`</${tag}>`, m.index + m[0].length);
  if (close < 0) throw new HanaBusinessError(`XML 中 <${tag}> 未闭合，拒绝变换`);
  return { contentStart: m.index + m[0].length, contentEnd: close };
}

/**
 * 在文本里定位「开标签上带 id="X"」的元素块（含边界）。
 * 找不到返回 undefined；命中多处即抛错（锚点不唯一 = 结构不是我们理解的样子，改错比报错更糟）。
 */
function findElementBlock(
  text: string,
  tags: readonly string[],
  id: string,
  what: string,
): { start: number; end: number; tag: string } | undefined {
  const idRe = new RegExp(`\\bid="${escapeRegExp(id)}"`);
  const hits: Array<{ start: number; end: number; tag: string }> = [];
  for (const tag of tags) {
    for (const m of text.matchAll(new RegExp(`<${tag}\\b[^>]*>`, 'g'))) {
      if (!idRe.test(m[0])) continue;
      const start = m.index!;
      if (m[0].endsWith('/>')) {
        hits.push({ start, end: start + m[0].length, tag });
        continue;
      }
      const close = text.indexOf(`</${tag}>`, start + m[0].length);
      if (close < 0) throw new HanaBusinessError(`元素 <${tag} id="${id}"> 未闭合，拒绝变换`);
      hits.push({ start, end: close + tag.length + 3, tag }); // +3 = "</>"
    }
  }
  if (hits.length === 0) return undefined;
  if (hits.length > 1) throw new HanaBusinessError(`${what} "${id}" 锚点不唯一（命中 ${hits.length} 处），拒绝变换`);
  return hits[0];
}

/** logicalModel 里的输出字段 id 清单（解析口径与 diff/判定同源：parseViewDefinition） */
function outputFieldIds(xml: string): string[] {
  const o = parseViewDefinition(xml, 'calculationview').outputs;
  return [...o.attributes, ...o.calculatedAttributes, ...o.measures, ...o.calculatedMeasures, ...o.restrictedMeasures]
    .map((f) => f.id)
    .filter(Boolean);
}

/** 在 logicalModel 里按 id 找输出字段（顺带给出它在文档中的绝对边界与所在小节） */
function locateOutputField(xml: string, id: string): { kind: OutputFieldKind; start: number; end: number } | undefined {
  const lm = logicalModelSpan(xml);
  for (const sec of OUTPUT_SECTIONS) {
    const r = containerRange(lm.content, sec.section);
    if (!r) continue;
    const inner = lm.content.slice(r.contentStart, r.contentEnd);
    const blk = findElementBlock(inner, sec.tags, id, '输出字段');
    if (blk) {
      return {
        kind: sec.kind,
        start: lm.contentStart + r.contentStart + blk.start,
        end: lm.contentStart + r.contentStart + blk.end,
      };
    }
  }
  return undefined;
}

/** 指向某输出字段但字段不存在的**统一错误**（列出全部现有字段，便于模型当场纠正） */
function outputFieldMissing(xml: string, id: string, verb: string): HanaBusinessError {
  const ids = outputFieldIds(xml);
  return new HanaBusinessError(
    `输出字段 "${id}" 不存在于 logicalModel，无法${verb}。现有输出字段：${ids.join(', ') || '（无）'}`,
  );
}

/**
 * 引用守卫：被改动的字段不得被 logicalModel 的计算小节**按名引用**（公式/过滤器/限制度量）——
 * 直接改名/删除会让引用静默失效（激活才发现，或更糟：激活成功但口径变了）。服务端不代改公式（fail-closed）。
 */
function assertNotReferencedByCalculated(xml: string, id: string, own: { start: number; end: number }): void {
  const lm = logicalModelSpan(xml);
  const localStart = own.start - lm.contentStart;
  const localEnd = own.end - lm.contentStart;
  // 屏蔽被改字段自身的块（它自己当然含 id）；等长空格替换，保持下标
  const masked = lm.content.slice(0, localStart) + ' '.repeat(localEnd - localStart) + lm.content.slice(localEnd);
  const token = new RegExp(`(?<![A-Za-z0-9_])${escapeRegExp(id)}(?![A-Za-z0-9_])`);
  for (const section of REFERENCE_SECTIONS) {
    const r = containerRange(masked, section);
    if (!r) continue;
    if (token.test(masked.slice(r.contentStart, r.contentEnd))) {
      throw new HanaBusinessError(
        `输出字段 "${id}" 被 logicalModel 的 <${section}> 按名引用（公式/过滤器）：直接改它会让引用失效。` +
          `请先处理引用（或走 xml 全量通道），服务端不代改公式`,
      );
    }
  }
}

/** set_tag_attr：给自闭合标签补/换一个属性（在 `/>` 前插入；已有则替换）。值一律转义 */
function setTagAttribute(tagText: string, name: string, value: string): string {
  const re = new RegExp(`\\s${name}="[^"]*"`);
  const escaped = escapeXmlAttr(value);
  if (re.test(tagText)) return tagText.replace(re, ` ${name}="${escaped}"`);
  return tagText.replace(/\/>$/, ` ${name}="${escaped}"/>`);
}

/** op=rename_field：改输出字段名（输出**别名**——keyMapping 的节点列不动，这是 HANA 里"改输出名"的语义） */
export interface RenameFieldSpec {
  /** 当前输出字段 id */
  field: string;
  /** 新输出名（字母/数字/下划线，1~127 字符；不得与既有输出字段重名） */
  newName: string;
}

export interface RenameFieldResult {
  xml: string;
  field: string;
  newName: string;
  kind: OutputFieldKind;
}

export function renameFieldInViewXml(xml: string, spec: RenameFieldSpec): RenameFieldResult {
  const target = locateOutputField(xml, spec.field);
  if (!target) throw outputFieldMissing(xml, spec.field, '改名');
  if (!/^[A-Za-z0-9_]{1,127}$/.test(spec.newName)) {
    throw new HanaBusinessError(`newName "${spec.newName}" 不合法：只允许字母/数字/下划线，1~127 字符`);
  }
  const ids = outputFieldIds(xml);
  if (ids.includes(spec.newName)) {
    throw new HanaBusinessError(`newName "${spec.newName}" 与既有输出字段重名（现有：${ids.join(', ')}），拒绝变换`);
  }
  assertNotReferencedByCalculated(xml, spec.field, target);
  const block = xml.slice(target.start, target.end);
  // 只改开标签上的 id（值已过白名单，替换串不含 $ 特殊符）
  const replaced = block.replace(new RegExp(`\\bid="${escapeRegExp(spec.field)}"`), `id="${spec.newName}"`);
  return {
    xml: xml.slice(0, target.start) + replaced + xml.slice(target.end),
    field: spec.field,
    newName: spec.newName,
    kind: target.kind,
  };
}

/** op=drop_field：删一个输出字段（连同它的 keyMapping/measureMapping 声明；节点列不动） */
export interface DropFieldResult {
  xml: string;
  field: string;
  kind: OutputFieldKind;
  remaining: { attributes: number; measures: number };
}

export function dropFieldFromViewXml(xml: string, field: string): DropFieldResult {
  const target = locateOutputField(xml, field);
  if (!target) throw outputFieldMissing(xml, field, '删除');
  assertNotReferencedByCalculated(xml, field, target);
  // 连同所在行删（行首缩进 + 行尾换行），避免留下空行噪音
  const lineStart = xml.lastIndexOf('\n', target.start) + 1;
  const before = xml.slice(lineStart, target.start);
  const lineEnd = xml.indexOf('\n', target.end);
  const after = lineEnd >= 0 ? xml.slice(target.end, lineEnd) : '';
  const start = before.trim() === '' ? lineStart : target.start;
  const end = lineEnd >= 0 && after.trim() === '' ? lineEnd + 1 : target.end;
  const out = xml.slice(0, start) + xml.slice(end);
  const beforeOutputs = parseViewDefinition(xml, 'calculationview').outputs;
  const o = parseViewDefinition(out, 'calculationview').outputs;
  const remaining = {
    attributes: o.attributes.length + o.calculatedAttributes.length,
    measures: o.measures.length + o.calculatedMeasures.length + o.restrictedMeasures.length,
  };
  const beforeMeasures =
    beforeOutputs.measures.length + beforeOutputs.calculatedMeasures.length + beforeOutputs.restrictedMeasures.length;
  // 只拦「本次删除**造成**零度量」：视图原本就 0 度量（本来只能存 inactive）时删除不产生新问题，
  // 硬拦反而把「清理一个坏视图」的正常操作挡在门外——那种视图的写入会在激活时以 40117 如实回执。
  if (beforeMeasures > 0 && remaining.measures === 0) {
    throw new HanaBusinessError(
      `删除 "${field}" 后视图将没有任何度量：本 SPS 激活要求 ≥1 度量（否则 40117 No measures defined），已拒绝。` +
        `请先加新度量，或改用 xml 全量通道（激活失败会明确回执）`,
    );
  }
  return { xml: out, field, kind: target.kind, remaining };
}

/** op=add_calculated_column：在节点上新增计算列（calculatedViewAttribute + 公式）并映射为输出属性 */
export interface AddCalculatedColumnSpec {
  /** 新列名（字母/数字/下划线，1~127 字符；不得与节点列、既有输出字段重名） */
  name: string;
  /** 计算表达式（COLUMN_ENGINE 方言，引用同节点列写 "列名"；如 `if("AMOUNT" > 1000, 'HIGH', 'LOW')`） */
  formula: string;
  /** 结果类型（HANA 类型名，如 VARCHAR / NVARCHAR / INTEGER / DECIMAL(15,2)） */
  datatype: string;
  /** 类型长度（如 VARCHAR 的 10；datatype 已带 (n) 时省略） */
  length?: string;
  /** 输出字段的中文描述（选填） */
  description?: string;
  /** 挂载节点（缺省 = logicalModel 指向的输出节点） */
  node?: string;
}

export interface AddCalculatedColumnResult {
  xml: string;
  node: string;
  name: string;
  order: number;
}

export function addCalculatedColumnToViewXml(xml: string, spec: AddCalculatedColumnSpec): AddCalculatedColumnResult {
  if (/calculationScenarioType="SCRIPT_BASED"/.test(xml)) {
    throw new HanaBusinessError(
      '该视图为 SQL 模式（SCRIPT_BASED）：输出列由脚本决定，不支持 add_calculated_column。' +
        '请把计算写进脚本并用 op=set_script 替换，或走 xml 全量通道',
    );
  }
  if (!/^[A-Za-z0-9_]{1,127}$/.test(spec.name)) {
    throw new HanaBusinessError(`name "${spec.name}" 不合法：只允许字母/数字/下划线，1~127 字符`);
  }
  const datatype = spec.datatype.toUpperCase();
  if (!/^[A-Z][A-Z0-9]*(\(\d+(,\d+)?\))?$/.test(datatype)) {
    throw new HanaBusinessError(
      `datatype "${spec.datatype}" 不合法：应为 HANA 类型名（如 VARCHAR、NVARCHAR、INTEGER、DECIMAL(15,2)）`,
    );
  }
  const formula = spec.formula.trim();
  if (formula === '') throw new HanaBusinessError('formula 不能为空');
  if (formula.length > 4000) throw new HanaBusinessError(`formula 过长（${formula.length} > 4000 字符）`);

  const def = parseViewDefinition(xml, 'calculationview');
  const lmNode = /<logicalModel[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
  const nodeId = spec.node ?? lmNode;
  if (!nodeId) throw new HanaBusinessError('XML 中找不到 <logicalModel id="…">，无法确定默认挂载节点');
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new HanaBusinessError(`节点 "${nodeId}" 不存在。现有节点：${def.nodes.map((n) => n.id).join(', ')}`);
  }
  if (node.attributes.includes(spec.name) || node.calculatedAttributes.some((c) => c.id === spec.name)) {
    throw new HanaBusinessError(`名称 "${spec.name}" 已存在于节点 ${nodeId} 的列中，拒绝变换`);
  }
  const ids = outputFieldIds(xml);
  if (ids.includes(spec.name)) {
    throw new HanaBusinessError(`名称 "${spec.name}" 与既有输出字段重名（现有：${ids.join(', ')}），拒绝变换`);
  }

  const nodeBlk = findElementBlock(xml, ['calculationView'], nodeId, '节点');
  if (!nodeBlk) throw new HanaBusinessError(`XML 中找不到节点 <calculationView id="${nodeId}">，拒绝变换`);
  const block = xml.slice(nodeBlk.start, nodeBlk.end);
  const cva = containerRange(block, 'calculatedViewAttributes');
  if (!cva) {
    throw new HanaBusinessError(
      `节点 "${nodeId}" 没有 <calculatedViewAttributes> 段（结构与该节点类型不符），无法挂计算列，拒绝变换`,
    );
  }
  const attrXml = [
    `        <calculatedViewAttribute datatype="${escapeXmlAttr(datatype)}" id="${escapeXmlAttr(spec.name)}"` +
      (spec.length ? ` length="${escapeXmlAttr(spec.length)}"` : '') +
      ` expressionLanguage="COLUMN_ENGINE">`,
    `          <formula>${escapeXmlAttr(formula)}</formula>`,
    `        </calculatedViewAttribute>`,
  ].join('\n');
  const newBlock = replaceSection(block, 'calculatedViewAttributes', { kind: 'append', block: attrXml });

  const lm = logicalModelSpan(xml);
  const maxOrder = [...lm.content.matchAll(/order="(\d+)"/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
  const order = maxOrder + 1;
  const newLm = appendLogicalModelAttribute(lm.content, [
    outputAttributeBlock(spec.name, order, nodeId, spec.description),
  ]);

  // 两处替换都在原文档上算好（节点块在前、logicalModel 在后），**从后往前**落，避免下标漂移
  const edits = [
    { start: nodeBlk.start, end: nodeBlk.end, text: newBlock },
    { start: lm.contentStart, end: lm.contentEnd, text: newLm },
  ].sort((a, b) => b.start - a.start);
  let out = xml;
  for (const e of edits) out = out.slice(0, e.start) + e.text + out.slice(e.end);

  return { xml: out, node: nodeId, name: spec.name, order };
}

/** op=set_attribute_filter：给节点已有属性设置**单值过滤器**（属性级 `<filter>`，BW 常见：排除删除标记） */
export interface SetAttributeFilterSpec {
  /** 要过滤的属性（必须是该节点已有的 viewAttribute） */
  attribute: string;
  /** 过滤值（如 'DELETED' 或 X） */
  value: string;
  /** true=只保留该值；false（默认）=排除该值 */
  including?: boolean;
  /** 所在节点（缺省 = logicalModel 指向的输出节点） */
  node?: string;
}

export interface SetAttributeFilterResult {
  xml: string;
  node: string;
  attribute: string;
  including: boolean;
  /** true=替换了该属性上原有的过滤器；false=新增 */
  replaced: boolean;
}

export function setAttributeFilterInViewXml(xml: string, spec: SetAttributeFilterSpec): SetAttributeFilterResult {
  if (spec.value.length === 0 || spec.value.length > 200) {
    throw new HanaBusinessError(`value 长度须在 1~200 之间（当前 ${spec.value.length}）`);
  }
  const def = parseViewDefinition(xml, 'calculationview');
  const lmNode = /<logicalModel[^>]*\bid="([^"]+)"/.exec(xml)?.[1];
  const nodeId = spec.node ?? lmNode;
  if (!nodeId) throw new HanaBusinessError('XML 中找不到 <logicalModel id="…">，无法确定默认节点');
  const node = def.nodes.find((n) => n.id === nodeId);
  if (!node) {
    throw new HanaBusinessError(`节点 "${nodeId}" 不存在。现有节点：${def.nodes.map((n) => n.id).join(', ')}`);
  }
  if (!node.attributes.includes(spec.attribute)) {
    throw new HanaBusinessError(
      `节点 "${nodeId}" 上没有属性 "${spec.attribute}"（该节点属性：${node.attributes.join(', ') || '（无）'}）。` +
        `属性过滤器只能加在节点已有的 viewAttribute 上`,
    );
  }
  const including = spec.including ?? false;
  const nodeBlk = findElementBlock(xml, ['calculationView'], nodeId, '节点');
  if (!nodeBlk) throw new HanaBusinessError(`XML 中找不到节点 <calculationView id="${nodeId}">，拒绝变换`);
  const block = xml.slice(nodeBlk.start, nodeBlk.end);
  const attrBlk = findElementBlock(block, ['viewAttribute'], spec.attribute, '节点属性');
  if (!attrBlk) {
    throw new HanaBusinessError(`节点 "${nodeId}" 中找不到 <viewAttribute id="${spec.attribute}">，拒绝变换`);
  }
  const filterXml = `<filter xsi:type="Calculation:SingleValueFilter" including="${including}" value="${escapeXmlAttr(spec.value)}"/>`;
  const attrText = block.slice(attrBlk.start, attrBlk.end);
  let newAttrText: string;
  let replaced = false;
  if (attrText.endsWith('/>')) {
    // 自闭合 → 展开并插入（缩进从 8 空格起，与既有生成器形态不冲突：XML 空白无语义）
    newAttrText = attrText.replace(/\/>$/, `>\n        ${filterXml}\n      </viewAttribute>`);
  } else {
    const openLen = attrText.indexOf('>') + 1;
    const inner = attrText.slice(openLen, attrText.lastIndexOf('</viewAttribute>'));
    const single = /^\s*<filter\b[^>]*\/>\s*$/.exec(inner);
    if (single) {
      newAttrText =
        attrText.slice(0, openLen) +
        `\n        ${filterXml}\n      ` +
        attrText.slice(attrText.lastIndexOf('</viewAttribute>'));
      replaced = true;
    } else if (inner.includes('<filter')) {
      throw new HanaBusinessError(
        `属性 "${spec.attribute}" 已有嵌套/多值过滤器（MultiValueFilter）：本 op 只支持单值过滤器的替换，` +
          `请先清空或走 xml 全量通道`,
      );
    } else if (inner.trim() === '') {
      newAttrText =
        attrText.slice(0, openLen) +
        `\n        ${filterXml}\n      ` +
        attrText.slice(attrText.lastIndexOf('</viewAttribute>'));
    } else {
      // 有其他子元素（如 descriptions）：追加在闭合标签前
      const closeAt = attrText.lastIndexOf('</viewAttribute>');
      newAttrText = attrText.slice(0, closeAt) + `  ${filterXml}\n      ` + attrText.slice(closeAt);
    }
  }
  const newBlock = block.slice(0, attrBlk.start) + newAttrText + block.slice(attrBlk.end);
  return {
    xml: xml.slice(0, nodeBlk.start) + newBlock + xml.slice(nodeBlk.end),
    node: nodeId,
    attribute: spec.attribute,
    including,
    replaced,
  };
}

/** op=set_variable：修改已有输入参数（变量）的描述 / 默认值 / 是否必填 */
export interface SetVariableSpec {
  /** 变量 id（必须已存在；新建变量不在本 op 范围） */
  variableId: string;
  /** 默认值（variableProperties/@defaultValue） */
  defaultValue?: string;
  /** 参数描述（variable/<descriptions>/@defaultDescription） */
  description?: string;
  /** 是否必填（variableProperties/@mandatory） */
  mandatory?: boolean;
}

export interface SetVariableResult {
  xml: string;
  variableId: string;
  changed: string[];
}

export function setVariableInViewXml(xml: string, spec: SetVariableSpec): SetVariableResult {
  const changed: string[] = [];
  if (spec.defaultValue !== undefined) changed.push('defaultValue');
  if (spec.description !== undefined) changed.push('description');
  if (spec.mandatory !== undefined) changed.push('mandatory');
  if (changed.length === 0) {
    throw new HanaBusinessError(
      'set_variable 需要至少给出 defaultValue / description / mandatory 之一（都没给 = 无操作，已拒绝）',
    );
  }
  const locals = containerRange(xml, 'localVariables');
  if (!locals) {
    throw new HanaBusinessError('XML 中没有 <localVariables> 段（该视图没有输入参数），无法执行 set_variable');
  }
  const inner = xml.slice(locals.contentStart, locals.contentEnd);
  const blk = findElementBlock(inner, ['variable'], spec.variableId, '变量');
  if (!blk) {
    const varIds = [...inner.matchAll(/<variable\b[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);
    throw new HanaBusinessError(
      `变量 "${spec.variableId}" 不存在（现有：${varIds.join(', ') || '（无）'}）。本 op 只改已有变量，新建走 xml 全量通道`,
    );
  }
  let block = inner.slice(blk.start, blk.end);

  if (spec.defaultValue !== undefined || spec.mandatory !== undefined) {
    const vp = /<variableProperties\b[^>]*\/>/.exec(block);
    if (!vp) {
      throw new HanaBusinessError(
        `变量 "${spec.variableId}" 没有自闭合的 <variableProperties …/> 段（结构与已知方言不符），拒绝变换`,
      );
    }
    let vpText = vp[0];
    if (spec.defaultValue !== undefined) vpText = setTagAttribute(vpText, 'defaultValue', spec.defaultValue);
    if (spec.mandatory !== undefined) vpText = setTagAttribute(vpText, 'mandatory', String(spec.mandatory));
    block = block.slice(0, vp.index) + vpText + block.slice(vp.index + vp[0].length);
  }

  if (spec.description !== undefined) {
    const desc = /<descriptions\b[^>]*\/>/.exec(block);
    if (desc) {
      block =
        block.slice(0, desc.index) +
        setTagAttribute(desc[0], 'defaultDescription', spec.description) +
        block.slice(desc.index + desc[0].length);
    } else {
      // 变量块内没有 <descriptions>：紧跟开标签插入一行
      const openEnd = block.indexOf('>') + 1;
      block = `${block.slice(0, openEnd)}\n      <descriptions defaultDescription="${escapeXmlAttr(spec.description)}"/>${block.slice(openEnd)}`;
    }
  }

  return {
    xml: xml.slice(0, locals.contentStart + blk.start) + block + xml.slice(locals.contentStart + blk.end),
    variableId: spec.variableId,
    changed,
  };
}
