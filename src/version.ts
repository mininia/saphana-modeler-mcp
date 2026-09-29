import { createRequire } from 'node:module';

/**
 * 服务版本号的**唯一来源**：package.json。
 *
 * 存在理由：`server.ts` 曾把版本号硬编码在 `new McpServer({ name, version })` 里，
 * 与 package.json 各存一份 —— 发版时改了 package.json 却漏改这里，客户端看到的
 * serverInfo.version 就是旧版本，而没有任何检查会发现（版本号不参与编译期校验）。
 *
 * 用 createRequire 而非 `import pkg from '../package.json'`：后者会把 rootDir（src）
 * 之外的文件拉进编译单元，与 tsconfig 的 `rootDir: "src"` 冲突。
 *
 * 路径解析：本模块构建后位于 dist/version.js，源码位于 src/version.ts，
 * 两者都在包根下一级，故 `../package.json` 在两种形态下都指向包根 ——
 * 开发（tsx 跑 src）与安装后运行（node 跑 dist）行为一致。
 */
const require = createRequire(import.meta.url);

/** 读取 package.json 的 version；读不到时返回 undefined（由调用方决定如何降级） */
function readVersion(): string | undefined {
  try {
    const pkg = require('../package.json') as { version?: unknown };
    return typeof pkg?.version === 'string' && pkg.version.length > 0 ? pkg.version : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 对外声明的服务版本（MCP serverInfo.version）。
 * 读不到 package.json 时用 `0.0.0` 标记「未知」—— 不猜、也不沿用可能过期的字面量：
 * 一个明显异常的版本号会被注意到，一个"看起来正常"的旧版本号不会。
 */
export const SERVER_VERSION = readVersion() ?? '0.0.0';

/** 服务名（同样是 protocol 元数据，与 package.json 的 name 保持一致） */
export const SERVER_NAME = 'saphana-modeler-mcp';
