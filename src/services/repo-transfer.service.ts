import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { withKeyedLock } from '../core/keyed-mutex.js';
import { logger } from '../core/logger.js';
import { assertSafeObjectName, assertSchemaAllowed } from '../core/sql.js';
import { scanSqlSchemaRefs } from '../write-plan.js';
import { type EtagSource, type FileMeta, XsRestClient } from '../core/xs-rest.js';
import type { HanaConfig } from '../config/config.js';
import type { ViewDefinition } from '../model/view-types.js';
import { parseViewDefinition } from '../model/view-xml.js';
import { currentSchema } from './metadata.service.js';
import { assertSqlReadScopes } from './read-scope.service.js';
import {
  VERSION_CONCURRENCY_CAVEAT,
  assertWritePackageAllowed,
  invalidateViewCache,
  normalizeObjectName,
  writeLockKey,
} from './repo-transport.service.js';
import { definitionScriptsOf, isObjectNotFoundError } from './view-write.service.js';

/**
 * 本地文件路径边界（1138/1139）——本地文件读写（hana_repo_export 的 saveTo、hana_repo_import 的
 * filePath）的允许范围。这两个参数直通**服务器本地文件系统**，不在任何 HANA 边界内
 * （HANA_WRITE_PACKAGES 管不到、读 schema 白名单也管不到）：没有约束时，任何能调到该工具的一方
 * （HTTP 多客户端下持 Token 即可）都能覆盖写服务器上任意可写文件（如 ../../.env、C:\...\mcp.json）
 * 或读取任意文件字节发往 HANA。
 *
 * 两档口径：
 * - 配置了本地根（环境变量 MCP_LOCAL_ROOT）⇒ 以它为唯一范围：相对路径按根解析、绝对路径必须落在根内，
 *   解析后一律用 path.relative 复核不含 '..' 逃逸；
 * - 未配置（默认）⇒ 收紧为「**服务器工作目录内的相对路径**」：绝对路径一律拒绝、'..' 逃逸一律拒绝
 *   （即审查口径的最低要求：拒绝绝对路径与含 '..' 的路径）。注意默认档**不覆盖**「工作目录内的
 *   同名文件」（如 cwd 下的 .env/mcp.json）——需要更强的隔离（只允许专用导出目录）请配置本地根。
 * 纯点段在 core 侧的 encodePath 也有同口径拦截（URL 拼接的纵深层）。
 * 错误信息只陈述拦截事实与可用替代（如改取 base64），**不写**开启方式（配置标识符）——
 * 本消息会随 envelope 返回给调用方，写明"改哪项配置可放行"等于教它绕过（同 assertWritePackageAllowed）。
 */
function resolveLocalPath(inputPath: string, param: string): string {
  const rawRoot = process.env.MCP_LOCAL_ROOT;
  const configuredRoot = rawRoot && rawRoot.trim() !== '' ? resolve(rawRoot.trim()) : undefined;
  if (configuredRoot === undefined && isAbsolute(inputPath)) {
    throw new HanaBusinessError(
      `${param} 未配置本地文件根时不接受绝对路径：请改传服务器工作目录内的相对路径（请求未执行）；` +
        (param === 'saveTo' ? '省略 saveTo 可改为返回 base64 内容' : '或改用 content 内联提供内容'),
    );
  }
  const root = configuredRoot ?? process.cwd();
  const abs = resolve(root, inputPath);
  const rel = relative(root, abs);
  // 逃逸判定按**路径段**：'..' 或 '..<分隔符>…' 才算逃逸（'..foo/x' 是合法目录名，不误拒）
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new HanaBusinessError(
      `${param} 超出允许的本地范围：解析后的路径不在${
        configuredRoot === undefined ? '服务器工作目录' : '服务端配置的本地根'
      }之内（请求未执行）；请使用范围内的相对路径`,
    );
  }
  return abs;
}

/**
 * 包创建（XS REST：POST /base/file/<pkg>/ 建目录）。
 * 按 SSD §4.1 明确**不加锁、不需要 If-Match**：这是**幂等**操作——重复建包 200/201 均被接受
 * （xs-rest 的 createPackage 对已存在返回 200），任何时序下终态一致，满足并发不变量 I1。
 */
export async function createPackageViaRest(
  config: HanaConfig,
  packageId: string,
  description?: string,
): Promise<FileMeta> {
  assertWritePackageAllowed(packageId);
  const rest = new XsRestClient(config);
  const segments = packageId.split('.');
  const leafName = segments[segments.length - 1];
  return rest.createPackage(packageId, leafName, description);
}

/* ── Transfer API（xfer）：导出备份 / 导入恢复────────── */

/** 导出包为 zip 的结果 */
export interface ExportPackageResult {
  packageId: string;
  /** zip 字节数 */
  sizeBytes: number;
  /** 实际使用的导出 URL 形态（契约定档用） */
  url: string;
  /** saveTo 提供时：写盘路径；未提供时：base64 内容（小包用，大包建议 saveTo） */
  savedTo?: string;
  base64?: string;
}

/**
 * 导出包为 zip（GET /base/xfer/export，官方 Transfer API）。
 * 导出是读操作：不限制包（与读侧工具同一边界）；saveTo 落盘为本地备份文件。
 * saveTo 的本地路径边界：未配置本地根（MCP_LOCAL_ROOT）时只允许**服务器工作目录内的相对路径**
 * （绝对路径与 '..' 逃逸一律拒绝）；配置了本地根则限定在该根之内（见 resolveLocalPath 的两档口径）——
 * 不设边界时 saveTo 可覆盖写服务器上任意可写文件。
 */
export async function exportPackageViaRest(
  config: HanaConfig,
  packageId: string,
  saveTo?: string,
  client?: XsRestClient,
): Promise<ExportPackageResult> {
  assertSafeObjectName(packageId, '包');
  const rest = client ?? new XsRestClient(config);
  const { buffer, url } = await rest.exportPackageZip(packageId);
  const result: ExportPackageResult = { packageId, sizeBytes: buffer.length, url };
  if (saveTo) {
    const abs = resolveLocalPath(saveTo, 'saveTo');
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, buffer);
    result.savedTo = abs;
  } else {
    result.base64 = buffer.toString('base64');
  }
  return result;
}

/** 导入结果（含落库状态回读） */
export interface ImportObjectResult {
  object: { packageId: string; fileName: string };
  imported: boolean;
  meta?: FileMeta;
  /** 回读基线：导入**写完之后**独立回读到的 ETag（与写动作不同源，语义见 etagSource；回读失败时缺省） */
  etag?: string;
  /** etag 的来源（见 EtagSource）：'read-back'=独立回读；'unavailable'=回读未拿到 ETag 或回读失败（后者见 readBackError） */
  etagSource?: EtagSource;
  /** 回读到的服务端版本号（与 etag 同一次读取，不拼装） */
  version?: number;
  /**
   * 写入后回读失败的原因（仅回读失败时产生该字段，此时 meta 缺省）。
   * 与 etagSource='unavailable' 的区别（「查不到与没去查必须可区分」）：unavailable 只表示这次读取没带 ETag
   * （读到了对象但无 ETag），readBackError 表示**回读本身失败了**（没读到，原因在此）——导入结果仍以
   * imported=true 为准（写入确实发生了），回读只是附加信息。
   */
  readBackError?: string;
  /**
   * 跨进程并发迹象（只有实测到时才产生该字段，不制造恒为空噪音）：
   * 写前检查为「不存在」而回读版本号 > 1 ⇒ 本次调用期间有他人写过该对象（导入的新对象可能已被覆盖）。
   * 跨进程无服务端前置（xfer 导入没有 If-Match），属 SSD §4.1 的已知例外。
   */
  concurrencyNote?: string;
  /**
   * 内容预扫的如实标注（仅当导入内容**无法扫描**时产生，不制造恒为空噪音）：
   * 导入写入前会解析 SQL 模式视图的 <definition> 脚本，跑与 create/set_script 同一份读取范围判定
   * （限定名按 schema 白名单、未限定名按 CURRENT_SCHEMA）——命中即拒绝（零写入）。zip 归档等本服务
   * 不解析的载荷在此说明「本次未做该扫描」，不假装扫过。
   */
  contentScanNote?: string;
}

/**
 * 导入内容的读取范围预扫——写入之前执行，命中即拒绝（零写入）。
 *
 * 为什么需要（与工具层规划的真实分工）：工具层规划对内联内容只扫**静态可解析**的部分
 * （resourceUri、基表 schemaName 与 <definition> 脚本的限定名，见 planners 的 planRepoImport）；
 * filePath 通道的内容要到服务端才读到，规划层只能落 uncertain。服务层就地扫描补的正是这些盲区：
 * filePath 导入的全部脚本 + 任何通道的**未限定表名**（按 CURRENT_SCHEMA 解析，工具层扫描器无从得知）
 * ——不扫的话，SQL 模式视图的 <definition> 里可以带越界 schema 引用，而本通道**导入即激活**，
 * 等于给白名单外 schema 建了一个持久取数口。
 * 判定复用 create(mode=sql) / set_script 的同一份扫描器与读取范围判定，不另写第二份。
 * 「扫不了」的载荷都不静默（承诺的 fallback，「查不到与没去查必须可区分」）：
 * - zip 归档：返回标注（进回执 contentScanNote）；
 * - 不含 XML 根元素（纯文本/JSON/空载荷）：同样返回标注；
 * - 含 <definition> 元素却提取不出脚本正文（如命名空间前缀形态）：**拒绝**（零写入）——
 *   「提取不出」不等于「没有可扫的 SQL」，这里是拒绝与放行的分界（fail-closed 一侧）。
 * pool 可选：**未提供时未限定表名一项无从校验**（CURRENT_SCHEMA 必须查库），
 * 同样在标注里如实说明；工具层调用点（hana_repo_import）传 ctx.pool，故生产路径是全量判定。
 * @returns 无法扫描/未做某项扫描时的中文标注；完整扫描完成时 undefined；
 *          提取不出脚本正文时抛业务错误（内容无法校验，不导入）
 */
async function assertImportPayloadReadScopes(
  pool: HanaPool | undefined,
  content: Buffer | string,
  fileName: string,
): Promise<string | undefined> {
  const buf = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
  if (buf.length >= 2 && buf.subarray(0, 2).toString('ascii') === 'PK') {
    return (
      `导入内容为 zip 归档（${fileName}）：本服务不解析归档，未能扫描其中的 SQL 读取范围` +
      '（归档内的 SQL 模式视图不会经过限定名/未限定名的读取范围判定）'
    );
  }
  const text = buf.toString('utf8');
  let def: ViewDefinition;
  try {
    def = parseViewDefinition(text);
  } catch (e) {
    return (
      `导入内容无法按设计时 XML 解析（${fileName}）：未做 SQL 读取范围扫描` +
      `（${e instanceof Error ? e.message : String(e)}）`
    );
  }
  // 没有可识别的 XML 根元素（纯文本/JSON/空载荷等）时解析器**不抛**（宽容解析），落到这里如实标注——
  // 「提取不出」不等于「没有可扫的 SQL」（同口径的 parsed=false 判定见 planners.scanXmlBaseTableSchemas）。
  if (!Object.keys(def.raw as Record<string, unknown>).some((k) => !k.startsWith('?'))) {
    return `导入内容不含可识别的 XML 根元素（${fileName}）：未做 SQL 读取范围扫描（纯文本/JSON/空载荷等非设计时 XML 形态）`;
  }
  const scripts = definitionScriptsOf(def);
  if (scripts.length === 0) {
    // 「提取不出脚本」≠「没有可扫的 SQL」：本地解析器只认无前缀的元素名（`obj['definition']`），
    // 载荷里确有 <definition> 元素（含命名空间前缀形态）却提取不出正文时，脚本的读取范围
    // （限定名与未限定名）无从判定——fail-closed 拒绝（零写入），不静默放行去落库激活。
    if (/<(?:[A-Za-z_][\w.-]*:)?definition(?=[\s/>])/i.test(text)) {
      throw new HanaBusinessError(
        `导入内容含 <definition> 元素，但本服务未能提取其脚本正文（${fileName}）：` +
          '脚本的读取范围（限定名按可读 schema 白名单、未限定名按当前默认 schema）无法校验，' +
          '本次导入未执行（零写入）。请改用本服务可解析的标准形态（元素名不带命名空间前缀）再重新导入',
      );
    }
    return undefined; // 确无 <definition> 脚本（非 SQL 模式）：没有可扫的 SQL
  }
  for (const script of scripts) {
    for (const schema of scanSqlSchemaRefs(script)) {
      // 限定名越界：与工具层规划器同一判定（HANA_SCHEMA_ALLOW），此处是脚本/绕过工具面调用的兜底
      assertSchemaAllowed(schema);
    }
  }
  if (pool === undefined) {
    return (
      `导入内容含 SQL 模式脚本（${fileName}）：未提供连接，未校验**未限定表名**（按 CURRENT_SCHEMA 的判定）` +
      '；限定名读取范围已校验'
    );
  }
  // 未限定表名按当前连接的默认 schema 判定（与 create/set_script 的服务层兜底同一实现）
  for (const script of scripts) {
    await assertSqlReadScopes(script, () => currentSchema(pool), '导入内容');
  }
  return undefined;
}

/**
 * 导入单个设计时文件（POST+PUT /base/xfer/import，官方 Transfer API）。
 * 导入是写操作：目标包须在 HANA_WRITE_PACKAGES 配置的可写包范围内（示例值 ZDEMO，含子包）。
 * 【默认拒绝覆盖】目标文件已存在时抛错并指引改用 hana_view_update（已有对象的修改走更新通道，
 * 禁止 delete+重建或静默覆盖）；确需覆盖导入（如备份恢复）须显式 overwrite=true。
 * 来源：content 内联内容（须配 fileName），或 filePath 本地文件（默认取 basename 做目标文件名）。
 * filePath 的本地路径边界：未配置本地根（MCP_LOCAL_ROOT）时只允许**服务器工作目录内的相对路径**
 * （绝对路径与 '..' 逃逸一律拒绝）；配置了本地根则限定在该根之内——不设边界时可直接读取服务器
 * 任意可读文件并把字节发往 HANA。读文件失败（不存在/不可读）归一为可修正的中文业务错误，不包装成「内部错误」。
 * 内容预扫：写入前解析 SQL 模式视图的 <definition> 脚本，跑与 create/set_script 同一份
 * 读取范围判定（限定名 + 未限定名），命中即拒绝且零写入；无法解析的载荷（zip 等）在回执如实标注。
 * 并发（§4.1 import 行）：整段「存在性检查 → 导入 → 回读」在同一把 keyed lock 内；锁键用
 * normalizeObjectName(文件名) 剥掉后缀——与外层 create/update/activate/delete/validate 对同一对象同键。
 * 守卫收紧：只有 404（OBJECT_NOT_FOUND）才算「不存在」，其它错误 rethrow（fail-closed）。
 * 注：4 个参数（input/client/pool）。pool 为可选尾参（既有调用点零改动；缺省时
 * 未限定表名一项无从校验，由回执 contentScanNote 如实标注）；工具层调用点应显式传 ctx.pool。
 */
export async function importObjectViaRest(
  config: HanaConfig,
  input: { targetPackageId: string; content?: string; filePath?: string; fileName?: string; overwrite?: boolean },
  client?: XsRestClient,
  pool?: HanaPool,
): Promise<ImportObjectResult> {
  assertWritePackageAllowed(input.targetPackageId);
  let content: Buffer | string;
  let fileName = input.fileName;
  if (input.content !== undefined) {
    if (!fileName)
      throw new HanaBusinessError('内联内容导入必须提供 fileName（目标文件名，如 ZDEMO_CV_X.calculationview）');
    content = input.content;
  } else if (input.filePath) {
    const abs = resolveLocalPath(input.filePath, 'filePath');
    try {
      content = await readFile(abs);
    } catch (e) {
      // 归一为业务错误（可修正）：原生 ENOENT/EACCES 经 withErrorEnvelope 会被报成
      // 「内部错误，详情见服务端日志」，把用户错误说成服务端故障，调用方无从据此改路径。
      const code = (e as NodeJS.ErrnoException).code;
      throw new HanaBusinessError(
        `本地文件不存在或不可读：${input.filePath}（${code ?? (e instanceof Error ? e.message : String(e))}）`,
      );
    }
    fileName ??= basename(abs);
  } else {
    throw new HanaBusinessError('导入需要提供 content 或 filePath 之一');
  }
  assertSafeObjectName(fileName!, '目标文件名');
  const targetFile = fileName!;
  const rest = client ?? new XsRestClient(config);
  // 存在性检查 → 导入 → 回读整段同一临界区（锁键已剥后缀，与 create/update 同对象同键）；
  // 锁不可重入：本临界区内不再取同一把锁（fileMeta/importFile 都不取锁）。
  // 时序契约：content 分支在**取锁前不得有 await**——withKeyedLock 按「同步到达的先后」入队，
  // 锁前插入 await 会把抢锁次序交给事件循环：与并发 update/create 同键时对方反先入队，事件序列出现重叠。
  // 内容预扫因此放在锁内（见下）。filePath 分支读本地文件的 await 是例外（读本地文件不占 HANA 对象锁）。
  return withKeyedLock(writeLockKey(input.targetPackageId, normalizeObjectName(targetFile)), async () => {
    // 读取范围预扫在**任何写之前**完成（命中即拒绝、零写入）；无法扫的载荷拿到一句如实标注进回执。
    // 放在锁内：既保住「锁前零 await」的时序契约，又让扫描与随后的写入同处一个临界区。
    const contentScanNote = await assertImportPayloadReadScopes(pool, content, targetFile);
    if (!input.overwrite) {
      // 默认拒绝覆盖：已有对象的修改应走 hana_view_update（PUT + If-Match），保持版本演进而非删除重建
      let existing: FileMeta | undefined;
      try {
        existing = await rest.fileMeta(input.targetPackageId, targetFile);
      } catch (e) {
        // 守卫收紧（fail-closed）：**仅** 404（OBJECT_NOT_FOUND）视为不存在；403/网络错误等一律 rethrow——
        // 把读异常当成「不存在」会让无权限/故障中的调用方静默覆盖已有对象
        if (!isObjectNotFoundError(e)) throw e;
        existing = undefined;
      }
      if (existing) {
        throw new HanaBusinessError(
          `目标对象 ${input.targetPackageId}/${targetFile} 已存在，导入默认拒绝覆盖。` +
            `请改用 hana_view_update 对已有对象做修改（读取 → 修改 → 更新），或显式传 overwrite=true 覆盖导入`,
        );
      }
    }
    await rest.importFile(input.targetPackageId, targetFile, content);
    // 写后失效视图缓存（§4.5）：对象名用剥掉后缀的裸名（与 get() 的 key 构造一致）
    invalidateViewCache(input.targetPackageId, normalizeObjectName(targetFile));
    // 落库状态回读（inactive / active 语义由服务端决定，如实呈现）。
    // 失败保持现状：meta undefined 但 imported=true（写入已发生，回读只是附加信息，不掩盖导入结果）——
    // 但失败原因必须可见（回执 readBackError + 日志）：不能只留一个 etagSource='unavailable'，
    // 那与「回读成功但无 ETag」不可区分（违反本仓「查不到与没去查必须可区分」）。
    let meta: FileMeta | undefined;
    let readBackError: string | undefined;
    try {
      meta = await rest.fileMeta(input.targetPackageId, targetFile);
    } catch (e) {
      meta = undefined;
      readBackError = e instanceof Error ? e.message : String(e);
      logger.warn(
        { packageId: input.targetPackageId, fileName: targetFile, err: e },
        '导入后回读失败：落库状态未知（导入本身已发生，imported=true 不变）',
      );
    }
    const result: ImportObjectResult = {
      object: { packageId: input.targetPackageId, fileName: targetFile },
      imported: true,
      meta,
      ...(readBackError ? { readBackError } : {}),
      // 内容预扫无法执行时的如实标注（zip 等），不静默略过
      ...(contentScanNote ? { contentScanNote } : {}),
    };
    const version = meta?.SapBackPack?.Version;
    if (meta?.ETag !== undefined) {
      // 回执基线 = 回读值（与写动作不同源，故标 read-back 而非 response-header）
      result.etag = meta.ETag;
      result.etagSource = 'read-back';
    } else {
      result.etagSource = 'unavailable';
    }
    result.version = version;
    // 跨进程竞态（§4.1 import 行）：写前检查为「不存在」而回读版本号 > 1 ⇒ **通常**意味着期间有他人写过该对象。
    // 该字段只在 overwrite !== true 时产生：overwrite=true 时写前未做检查，回读到的 Version>1 可能本就是
    // 该对象的既有历史版本——报「本次调用期间有他人写过」会把推断说成事实，故不产生该字段。
    // 免责句与 create 路径共用同一常量（VERSION_CONCURRENCY_CAVEAT）。
    if (!input.overwrite && version !== undefined && version > 1) {
      result.concurrencyNote =
        `导入回读的版本号已是 ${version}（>1）：这通常意味着本次调用期间有他人写过该对象，` +
        `导入的内容可能已被对方覆盖（xfer 导入没有 If-Match 前置，跨进程导入属 last-write-wins 的已知例外）；` +
        `${VERSION_CONCURRENCY_CAVEAT}。`;
    }
    return result;
  });
}

/** 变更列表查询（GET /base/change，只读；Change-Tracking API） */
export async function listChangesViaRest(
  config: HanaConfig,
  opts: { user?: string; status?: number } = {},
  client?: XsRestClient,
): Promise<unknown> {
  const rest = client ?? new XsRestClient(config);
  return rest.changeList(opts);
}
