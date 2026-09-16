import { parseViewDefinition } from './view-xml.js';
import { HanaBusinessError } from '../core/errors.js';
import {
  normalizeScriptedColumns,
  scriptedOutputSectionsXml,
  scriptedViewAttributesXml,
  wrapScriptedBody,
  type ScriptedColumnSpec,
} from './view-builder.js';
import type { ViewNode } from './view-types.js';

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

/** XML 属性值转义（与 view-builder 的 esc 同规则） */
function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
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
    outputFieldCount: o.attributes.length + o.measures.length + o.calculatedAttributes.length + o.calculatedMeasures.length + o.restrictedMeasures.length,
    dataCategory: def.dataCategory,
  };
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
    if (seenLeft.has(c.leftField)) throw new HanaBusinessError(`join 条件左字段 "${c.leftField}" 重复（同目标字段不允许两组条件）`);
    seenLeft.add(c.leftField);
  }

  // 带出字段校验：不得与左侧已有字段同名（会冲突）；不得重复
  const seenBring = new Set<string>();
  for (const f of spec.fields) {
    if (leftAttrs.includes(f.id)) throw new HanaBusinessError(`带出字段 "${f.id}" 与视图已有字段同名，将产生冲突；请勿带出或先处理重名`);
    if (seenBring.has(f.id)) throw new HanaBusinessError(`带出字段 "${f.id}" 重复`);
    seenBring.add(f.id);
  }

  const projectionId = `Projection_${nextNodeNumber(nodeIds, 'Projection')}`;
  const joinId = `Join_${nextNodeNumber(nodeIds, 'Join')}`;

  // ── 生成 XML 片段（缩进对齐 BW 方言：节/段 2 空格起，逐层 +2）──────────────
  const mapping = (target: string, source: string): string =>
    `        <mapping xsi:type="Calculation:AttributeMapping" target="${esc(target)}" source="${esc(source)}"/>`;

  const dataSourceBlock = [
    `    <DataSource id="${esc(spec.sourceId)}" type="CALCULATION_VIEW">`,
    `      <viewAttributes allViewAttributes="true"/>`,
    `      <resourceUri>${esc(spec.sourceResourceUri)}</resourceUri>`,
    `    </DataSource>`,
  ].join('\n');

  // Projection 输出源侧原始列名（join 条件右字段 + 带出字段，去重保序）
  const projFields = [...spec.conditions.map((c) => c.rightField), ...spec.fields.map((f) => f.id)]
    .filter((f, i, a) => a.indexOf(f) === i);
  const projectionBlock = [
    `    <calculationView xsi:type="Calculation:ProjectionView" id="${projectionId}">`,
    `      <descriptions/>`,
    `      <viewAttributes>`,
    ...projFields.map((f) => `        <viewAttribute id="${esc(f)}"/>`),
    `      </viewAttributes>`,
    `      <calculatedViewAttributes/>`,
    `      <input node="#${esc(spec.sourceId)}">`,
    ...projFields.map((f) => mapping(f, f)),
    `      </input>`,
    `    </calculationView>`,
  ].join('\n');

  // Join 节点：viewAttributes = 左侧全字段 + 带出字段；左输入 = 左侧字段透传；
  // 右输入 = 条件重命名（target=左字段 source=右字段，与 BW 范本同款）+ 带出字段透传
  const joinAttrs = [...leftAttrs, ...spec.fields.map((f) => f.id)];
  const joinBlock = [
    `    <calculationView xsi:type="Calculation:JoinView" id="${joinId}" joinOrder="OUTSIDE_IN" joinType="${esc(spec.joinType)}">`,
    `      <descriptions/>`,
    `      <viewAttributes>`,
    ...joinAttrs.map((f) => `        <viewAttribute id="${esc(f)}"/>`),
    `      </viewAttributes>`,
    `      <calculatedViewAttributes/>`,
    `      <input node="#${esc(finalNodeId)}">`,
    ...leftAttrs.map((f) => mapping(f, f)),
    `      </input>`,
    `      <input node="#${projectionId}">`,
    ...spec.conditions.map((c) => mapping(c.leftField, c.rightField)),
    ...spec.fields.map((f) => mapping(f.id, f.id)),
    `      </input>`,
    ...spec.conditions.map((c) => `      <joinAttribute name="${esc(c.leftField)}"/>`),
    `    </calculationView>`,
  ].join('\n');

  // ── 锚点手术（每步断言锚点唯一，打不准就整体失败）────────────────────────
  let out = xml;
  out = insertBeforeClose(out, 'dataSources', dataSourceBlock);
  out = insertBeforeClose(out, 'calculationViews', `${projectionBlock}\n${joinBlock}`);

  // logicalModel 重接线（在插入后的最新文本上重新定位，位置已因插入而偏移）：
  // id → 新 join 节点；全部 columnObjectName="旧节点" → 新节点
  // （columnObjectName 同时出现在 keyMapping 与 measureMapping，一并重接线）
  const lmStart = out.indexOf('<logicalModel');
  const lmEnd = out.indexOf('</logicalModel>', lmStart);
  if (lmStart < 0 || lmEnd < 0) throw new HanaBusinessError('XML 中找不到 <logicalModel> 段，无法重接线输出');
  let lmNew = out.slice(lmStart, lmEnd);
  const maxOrder = [...lmNew.matchAll(/order="(\d+)"/g)].reduce((m, x) => Math.max(m, Number(x[1])), 0);
  const addedOutputFields = spec.fields.map((f, i) => ({ id: f.id, order: maxOrder + i + 1 }));
  const attrBlocks = spec.fields.map((f, i) => {
    const lines = [
      `      <attribute id="${esc(f.id)}" order="${String(maxOrder + i + 1)}" attributeHierarchyActive="false" displayAttribute="false">`,
    ];
    if (f.description) lines.push(`        <descriptions defaultDescription="${esc(f.description)}"/>`);
    lines.push(
      `        <keyMapping columnObjectName="${joinId}" columnName="${esc(f.id)}"/>`,
      `      </attribute>`,
    );
    return lines.join('\n');
  });
  lmNew = lmNew.replace(/<logicalModel id="[^"]+"/, `<logicalModel id="${joinId}"`);
  lmNew = lmNew.split(`columnObjectName="${finalNodeId}"`).join(`columnObjectName="${joinId}"`);
  // 追加输出字段：锚点要兼容三种形态——Studio 逐行排版 / 自闭合空段 / **单行紧凑 XML**
  // （最后一类是本服务生成器的产出：漏了它，「刚 create 出来的视图」就加不了 join）
  const attrCloseIndented = '\n    </attributes>';
  if (lmNew.includes(attrCloseIndented)) {
    lmNew = lmNew.replace(
      attrCloseIndented,
      `${attrBlocks.length > 0 ? `\n${attrBlocks.join('\n')}` : ''}${attrCloseIndented}`,
    );
  } else if (lmNew.includes('<attributes/>') && attrBlocks.length > 0) {
    lmNew = lmNew.replace('<attributes/>', `<attributes>\n${attrBlocks.join('\n')}\n    </attributes>`);
  } else if (lmNew.includes('</attributes>') && attrBlocks.length > 0) {
    lmNew = lmNew.replace('</attributes>', `${attrBlocks.join('\n')}\n    </attributes>`);
  } else if (attrBlocks.length > 0) {
    throw new HanaBusinessError('logicalModel 中找不到 </attributes> 或 <attributes/> 锚点，无法追加输出字段');
  }
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

/**
 * 在「</tag>」闭合锚点前插入块。三种形态都要能落：
 * - 逐行排版（Studio 导出）：与锚点行缩进对齐；
 * - **单行紧凑 XML**（本服务自己的生成器 format:false 产出）：无缩进可依，直接插在闭合标签前
 *   （元素间无需空白，仍是合法 XML）——漏了这一类，「刚 create 出来的视图」就加不了 join；
 * - 自闭合空段（`<tag/>`，如 SQL 模式视图的 `<dataSources/>`）：展开成对标签后插入。
 */
function insertBeforeClose(xml: string, tag: string, block: string): string {
  const close = `</${tag}>`;
  const first = xml.indexOf(close);
  if (first < 0) {
    const selfClosed = new RegExp(`<${tag}\\s*/>`).exec(xml);
    if (selfClosed) {
      return `${xml.slice(0, selfClosed.index)}<${tag}>\n${block}\n  </${tag}>${xml.slice(selfClosed.index + selfClosed[0].length)}`;
    }
    throw new HanaBusinessError(`XML 中找不到 <${tag}> 段，拒绝变换（该视图形态可能不受支持）`);
  }
  if (xml.indexOf(close, first + 1) >= 0) throw new HanaBusinessError(`XML 中 </${tag}> 锚点不唯一，拒绝变换`);
  const lineStart = xml.lastIndexOf('\n', first);
  const prefix = xml.slice(lineStart + 1, first);
  if (prefix.trim() === '') {
    // 逐行排版：块与既有子元素对齐
    return `${xml.slice(0, lineStart + 1)}${block}\n${prefix}${xml.slice(first)}`;
  }
  // 紧凑/单行：无缩进可依，插在闭合标签前（块自带换行）
  return `${xml.slice(0, first)}${block}\n${xml.slice(first)}`;
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

/** 取标签段的起止下标：`<tag ...>…</tag>` 或自闭合 `<tag/>`（自闭合时 start=end 段为空） */
function findSection(xml: string, tag: string): { start: number; end: number; selfClosed: boolean } {
  const open = new RegExp(`<${tag}(\\s[^>]*)?/?>`).exec(xml);
  if (!open || open.index < 0) throw new HanaBusinessError(`XML 中找不到 <${tag}> 节点，拒绝变换`);
  if (open[0].endsWith('/>')) return { start: open.index, end: open.index + open[0].length, selfClosed: true };
  const close = xml.indexOf(`</${tag}>`, open.index + open[0].length);
  if (close < 0) throw new HanaBusinessError(`XML 中 <${tag}> 未闭合，拒绝变换`);
  return { start: open.index, end: close + `</${tag}>`.length, selfClosed: false };
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
  const dsection = findSection(nodeBlock, 'definition');
  nodeBlock = `${nodeBlock.slice(0, dsection.start)}<definition>${esc(script)}</definition>${nodeBlock.slice(dsection.end)}`;

  // 1b) <viewAttributes>：列 + 显式 datatype/length（与 create 同一生成器）
  const vaSection = findSection(nodeBlock, 'viewAttributes');
  const vaBlock = scriptedViewAttributesXml(columns);
  nodeBlock = `${nodeBlock.slice(0, vaSection.start)}${vaBlock}${nodeBlock.slice(vaSection.end)}`;

  let out = `${xml.slice(0, nodeOpen.index)}${nodeBlock}${xml.slice(nodeClose)}`;

  // 2) logicalModel：按新列清单整体重建 attributes / baseMeasures（同一生成器）
  const sections = scriptedOutputSectionsXml(columns, scriptNode.id);
  const lmOpen = /<logicalModel[^>]*>/.exec(out);
  if (!lmOpen) throw new HanaBusinessError('XML 中找不到 <logicalModel>，拒绝变换');
  const lmClose = out.indexOf('</logicalModel>', lmOpen.index + lmOpen[0].length);
  if (lmClose < 0) throw new HanaBusinessError('logicalModel 未闭合，拒绝变换');
  let lm = out.slice(lmOpen.index + lmOpen[0].length, lmClose);
  lm = replaceSectionInner(lm, 'attributes', stripSectionWrapper(sections.attributes, 'attributes'));
  lm = replaceSectionInner(lm, 'baseMeasures', stripSectionWrapper(sections.measures, 'baseMeasures'));
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

/** 取某节点块的原文（从 `<calculationView ... id="X">` 到其闭合标签） */
function sliceNodeBlock(xml: string, nodeId: string): string {
  const open = new RegExp(`<calculationView[^>]*\\sid="${nodeId}"[^>]*>`).exec(xml);
  if (!open) return '';
  const close = xml.indexOf('</calculationView>', open.index + open[0].length);
  return close < 0 ? xml.slice(open.index) : xml.slice(open.index, close);
}

/** 去掉生成器输出的外层标签，只取内部内容（replaceSectionInner 自己负责包裹） */
function stripSectionWrapper(section: string, tag: string): string {
  const m = new RegExp(`^\\s*<${tag}>([\\s\\S]*?)</${tag}>\\s*$`).exec(section);
  if (!m) return ''; // 自闭合（<attributes/>）→ 无内部内容
  return m[1];
}

/** 把某段（如 logicalModel 内的 <attributes>）的**内容**替换为给定文本；自闭合形态展开为成对标签 */
function replaceSectionInner(scope: string, tag: string, inner: string): string {
  const sec = findSection(scope, tag);
  const lineStart = scope.lastIndexOf('\n', sec.start);
  const rawIndent = lineStart >= 0 ? scope.slice(lineStart + 1, sec.start) : '';
  const indent = rawIndent.trim() === '' ? rawIndent : '';
  const replacement = inner === '' ? `<${tag}/>` : `<${tag}>${inner}\n${indent}</${tag}>`;
  return `${scope.slice(0, sec.start)}${replacement}${scope.slice(sec.end)}`;
}
