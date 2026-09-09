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
