import { XMLBuilder, XMLParser, type X2jOptions, type XmlBuilderOptions } from 'fast-xml-parser';

/**
 * HANA 仓库对象 XML（_SYS_REPO CDATA 内容）解析/构造公共配置。
 * 公共解析选项沉淀于此；解析器与构造器分别在 metadata、modeling 服务中实现。
 *
 * 要点：
 * - 视图 XML 大小写敏感、含属性，且节点间有顺序语义 → 关闭属性前缀、保留大小写
 * - CDATA（如 SQLScript 源码）必须保留
 */
const PARSER_OPTIONS: Partial<X2jOptions> = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  preserveOrder: false,
  parseAttributeValue: false,
  parseTagValue: false,
  trimValues: false,
  cdataPropName: '#cdata',
  processEntities: false,
};

const BUILDER_OPTIONS: Partial<XmlBuilderOptions> = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  cdataPropName: '#cdata',
  format: false,
  suppressEmptyNode: false,
  processEntities: false,
};

/** 创建仓库 XML 解析器（共享配置） */
export function createXmlParser(): XMLParser {
  return new XMLParser(PARSER_OPTIONS);
}

/** 创建仓库 XML 构造器（共享配置） */
export function createXmlBuilder(): XMLBuilder {
  return new XMLBuilder(BUILDER_OPTIONS);
}

/**
 * XML 转义（元素文本与属性值通用的最严口径）：
 * `&` `<` `>` 必须在元素文本内转义，属性值还需转义 `"` —— 统一按最严处理，
 * 避免"同一段文本用在文本位与属性位得到不同转义结果"这类隐患。
 *
 * 此前 view-builder 与 view-edit 各有一份逐字节相同的实现（后者注释自认同规则），
 * 归此单点后 XML 转义只有一种答案。
 */
export function escapeXmlAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/*
 * 解码方向**不在此处**：仓库 XML 的实体解码还需要处理数字实体（&#xD; / &#10;）
 * 与 CR/LF 归一，见 model/view-xml.ts 的 decodeEntities —— 那是权威实现。
 * 这里刻意不放一个"简化版解码器"：两套只差几个实体的实现比只有一套更危险。
 */
