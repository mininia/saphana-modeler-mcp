/**
 * Node 版本兼容校验。
 *
 * 最低要求：Node >= 22.0.0（与 package.json 的 engines 声明一致；基线 v22.23.4：
 * typecheck / build / 单测 / 两条 smoke 全过）。
 *
 * 为什么是 22：
 * - 运行时只依赖 `process.loadEnvFile`（20.12 起提供）；20.12.2 上 stdio / HTTP 两条冒烟
 *   已实测通过。但 Node 20 已于 2026-04-30 EOL，声明下限不应落在停止安全更新的版本上；
 *   22 是仍在维护的最老 LTS（支持到 2027-04）。
 * - 声明下限必须能真正跑通 `npm test`：Windows 下 npm 默认经 cmd.exe 执行脚本，cmd 不展开
 *   glob；Node 21+ 的 `node --test` 才展开（20.x 不展开，直接报 Could not find）。20.x 的
 *   node:test 还会把刻意 unref 的定时器判成 pending-promise 并 cancel 整个用例文件；
 *   `pretest` 用到的 `fs.globSync` 同样要 22+。
 * 启动时校验，不满足则拒绝启动并给出明确指引，避免在能力缺失下静默运行。
 *
 * 能力边界：本检查在入口 main() 里执行，而依赖 import 早于它求值 —— 过旧的 Node（如 18.x）
 * 可能在依赖加载期（pino 等）就直接崩掉，看不到下面的中文指引；20.12 实测能加载依赖并拿到
 * 本检查的明确报错。要覆盖更旧版本，需把检查前移到极薄的 bin 入口后再动态 import 依赖。
 */
export const MIN_NODE_MAJOR = 22;
export const MIN_NODE_MINOR = 0;

export interface NodeVersionResult {
  ok: boolean;
  /** 当前 Node 版本（如 22.23.4） */
  current: string;
  /** 最低要求（如 >=22.0） */
  required: string;
}

/** 校验当前 Node 版本是否满足最低要求 */
export function checkNodeVersion(version = process.versions.node): NodeVersionResult {
  const [majorStr, minorStr] = version.split('.');
  const major = Number(majorStr);
  const minor = Number(minorStr);
  const ok =
    Number.isFinite(major) &&
    (major > MIN_NODE_MAJOR || (major === MIN_NODE_MAJOR && Number.isFinite(minor) && minor >= MIN_NODE_MINOR));
  return { ok, current: version, required: `>=${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}` };
}
