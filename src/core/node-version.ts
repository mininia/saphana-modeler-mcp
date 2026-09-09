/**
 * Node 版本兼容校验。
 *
 * 最低要求：Node >= 20.12（`process.loadEnvFile` 自 20.12 / 21.7 提供，22+ 均可用；
 * 低于此版本 .env 无法自动加载，会静默退化为仅环境变量配置）。
 * 启动时校验，不满足则拒绝启动并给出明确指引，避免在能力缺失下静默运行。
 */
export const MIN_NODE_MAJOR = 20;
export const MIN_NODE_MINOR = 12;

export interface NodeVersionResult {
  ok: boolean;
  /** 当前 Node 版本（如 20.12.1） */
  current: string;
  /** 最低要求（如 >=20.12） */
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
