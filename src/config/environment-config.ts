/**
 * 多环境配置层：扁平环境变量的解析与继承。
 *
 * 约定（2026-11-09 定稿，见 docs/multi-hana-environment-config-guide.md）：
 * - 共用参数保持原名（HANA_HOST / HANA_PORT / ...），它们也是 default 环境；
 * - 命名环境用 `HANA_<PARAM>_ENV_<XXXX>` 覆盖；
 * - `HANA_LABEL` / `HANA_LABEL_ENV_<XXXX>` 是 MCP 识别的系统标识（LABEL）；
 * - 多环境 = 至少出现一个 `_ENV_` 覆盖；只设置 LABEL / START / SWITCHABLE 不触发多环境；
 * - 旧前缀 `HANA_ENV_<NAME>_<PARAM>`、JSON/YAML 配置文件在 v1 不支持，出现即失败。
 *
 * 本模块只做纯解析与校验，不读 .env、不删 process.env、不建池；生命周期由 config.ts 统一收口。
 */

import { logger } from '../core/logger.js';
import { splitList } from '../core/text.js';
import type { HanaConfig } from './config.js';

export type EnvironmentAccess = 'readwrite' | 'readonly';
export type ReadonlySqlPolicy = 'select-only' | 'deny';

/** 一个可运行环境：LABEL 是系统标识，configKey 是配置键命名空间（default / XXXX）。 */
export interface EnvironmentEntry {
  label: string;
  configKey: string;
  access: EnvironmentAccess;
  config: HanaConfig;
}

/** loadEnvironments 的结果：base 恒在 entries[0]。 */
export interface LoadedEnvironments {
  base: EnvironmentEntry;
  entries: EnvironmentEntry[];
  startLabel: string;
  switchable: string[];
  /** 至少配置了一个命名环境（一个 `_ENV_` 覆盖） */
  multiEnv: boolean;
}

/** 环境名（`_ENV_` 后面的配置键命名空间） */
const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
/** 系统标识（LABEL）；`default` 是基础环境保留值 */
const LABEL_RE = /^[A-Z][A-Z0-9_]{0,31}$/;
/** 不允许作为配置键/环境名的保留字 */
const RESERVED_KEYS = new Set(['DEFAULT', 'START', 'SWITCHABLE', 'CONFIG']);

/**
 * 全局键（不是 `<PARAM>_ENV_<XXXX>`）。
 * `HANA_ENV_LOAD_DOTENV` 已移除：保留在此以免被“旧前缀”校验硬拒绝，由 warnUnknownEnvKeys 告警。
 */
const GLOBAL_ENV_KEYS = new Set(['HANA_ENV_START', 'HANA_ENV_SWITCHABLE', 'HANA_ENV_LOAD_DOTENV']);

/** 允许在 `_ENV_` 后覆盖的参数；按长度倒序匹配，避免 XS_BASE_PATH 被 XS_PORT 抢先。 */
const OVERRIDE_PARAMS = [
  'XS_BASE_PATH',
  'SSL_VALIDATE',
  'DB_NAME',
  'PASSWORD',
  'XS_TLS',
  'XS_PORT',
  'LOCALE',
  'ACCESS',
  'LABEL',
  'HOST',
  'PORT',
  'USER',
  'TLS',
] as const;

type OverrideParam = (typeof OVERRIDE_PARAMS)[number];

const TRUE_VALUES = new Set(['true', '1', 'TRUE']);
const FALSE_VALUES = new Set(['false', '0', 'FALSE']);

interface EnvironmentOverride {
  configKey: string;
  label?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  dbName?: string;
  tls?: boolean;
  sslValidate?: boolean;
  locale?: string;
  xsPort?: number;
  xsTls?: boolean;
  xsBasePath?: string;
  access?: EnvironmentAccess;
}

function nonEmpty(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s === '' ? undefined : s;
}

function parsePort(key: string, raw: unknown): number | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (!/^[0-9]+$/.test(s)) {
    throw new Error(`${key} 无效：端口必须是纯数字（如 30015）`);
  }
  const n = Number(s);
  if (n < 1 || n > 65535) {
    throw new Error(`${key} 无效：端口必须在 1..65535 之间`);
  }
  return n;
}

function parseBool(key: string, raw: unknown): boolean | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  throw new Error(`${key} 取值非法：合法值为 true/false/1/0/TRUE/FALSE（留空 = 继承共用值）`);
}

function parseAccess(key: string, raw: unknown): EnvironmentAccess | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (s !== 'readwrite' && s !== 'readonly') {
    throw new Error(`${key} 取值非法：只能是 readwrite / readonly`);
  }
  return s;
}

function parseLabel(key: string, raw: unknown): string | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (!LABEL_RE.test(s)) {
    throw new Error(`${key} 非法：LABEL 必须匹配 ${LABEL_RE}（如 PRD_CN；default 保留给基础环境）`);
  }
  return s;
}

function validateEnvKey(key: string): void {
  if (!ENV_KEY_RE.test(key) || RESERVED_KEYS.has(key)) {
    throw new Error(
      `环境配置键 ${key} 非法：必须匹配 ${ENV_KEY_RE}，且不能使用保留名 ` + `${[...RESERVED_KEYS].join(' / ')}`,
    );
  }
}

function validateLabel(label: string, configKey: string, allowDefault: boolean): void {
  if (allowDefault && label === 'default') return;
  if (!LABEL_RE.test(label)) {
    throw new Error(
      `环境 ${configKey} 的 LABEL "${label}" 非法：必须匹配 ${LABEL_RE}（如 PRD_CN）；` + '只允许基础环境使用 default',
    );
  }
}

/** 解析一个 `_ENV_` 覆盖的值；空值 = 继承共用值。 */
function parseOverride(param: OverrideParam, key: string, raw: unknown): unknown {
  switch (param) {
    case 'HOST':
    case 'USER':
    case 'DB_NAME':
    case 'LOCALE':
    case 'XS_BASE_PATH':
      return nonEmpty(raw);
    case 'PASSWORD':
      return nonEmpty(raw);
    case 'PORT':
    case 'XS_PORT':
      return parsePort(key, raw);
    case 'TLS':
    case 'SSL_VALIDATE':
    case 'XS_TLS':
      return parseBool(key, raw);
    case 'ACCESS':
      return parseAccess(key, raw);
    case 'LABEL':
      return parseLabel(key, raw);
  }
}

function assignOverride(ov: EnvironmentOverride, param: OverrideParam, value: unknown): void {
  switch (param) {
    case 'HOST':
      ov.host = value as string;
      break;
    case 'PORT':
      ov.port = value as number;
      break;
    case 'USER':
      ov.user = value as string;
      break;
    case 'PASSWORD':
      ov.password = value as string;
      break;
    case 'DB_NAME':
      ov.dbName = value as string;
      break;
    case 'TLS':
      ov.tls = value as boolean;
      break;
    case 'SSL_VALIDATE':
      ov.sslValidate = value as boolean;
      break;
    case 'LOCALE':
      ov.locale = value as string;
      break;
    case 'XS_PORT':
      ov.xsPort = value as number;
      break;
    case 'XS_TLS':
      ov.xsTls = value as boolean;
      break;
    case 'XS_BASE_PATH':
      ov.xsBasePath = value as string;
      break;
    case 'ACCESS':
      ov.access = value as EnvironmentAccess;
      break;
    case 'LABEL':
      ov.label = value as string;
      break;
  }
}

/**
 * 是否是本模块负责的配置键（用于 warnUnknownEnvKeys 跳过误报）：
 * - 全局键在 envSchema 里已识别；
 * - `<PARAM>_ENV_<XXXX>` 由本模块解析；
 * - 旧前缀 `HANA_ENV_*` / `HANA_ENV_CONFIG` 由本模块**响亮拒绝**，不该只给一条“未识别”告警。
 */
export function isEnvironmentConfigKey(key: string): boolean {
  if (!key.startsWith('HANA_')) return false;
  if (GLOBAL_ENV_KEYS.has(key)) return false;
  return key.startsWith('HANA_ENV_') || key.includes('_ENV_');
}

/**
 * 从原始 env 与基础配置构造环境表。
 *
 * 前置：baseConfig 已由 envSchema 解析完成，且包含 base 的连接值。
 * 本函数只抛配置错误；不做 I/O。
 */
export function buildEnvironments(
  env: NodeJS.ProcessEnv,
  baseConfig: HanaConfig,
  opts: { start: string; switchable: string[] },
): LoadedEnvironments {
  const baseLabel = baseConfig.environment ?? 'default';
  validateLabel(baseLabel, 'default', true);
  const baseAccess = baseConfig.access ?? 'readwrite';

  // 补齐基础配置里的环境元数据（loadConfig 的返回值也带这些字段）
  baseConfig.environment = baseLabel;
  baseConfig.configKey = 'default';
  baseConfig.access = baseAccess;
  baseConfig.readonlySql ??= 'select-only';
  baseConfig.xsTls ??= false;

  const overrides = new Map<string, EnvironmentOverride>();

  for (const key of Object.keys(env)) {
    if (!key.startsWith('HANA_') || GLOBAL_ENV_KEYS.has(key)) continue;

    if (key === 'HANA_ENV_CONFIG') {
      throw new Error('HANA_ENV_CONFIG 在 v1 不支持：多环境请使用扁平 env 的 HANA_<PARAM>_ENV_<XXXX> 覆盖写法');
    }
    if (key.startsWith('HANA_ENV_')) {
      throw new Error(
        `${key} 是旧前缀/不支持的写法：请改用 HANA_<PARAM>_ENV_<XXXX>（例如 HANA_HOST_ENV_PRD_EU）；` +
          'v1 不提供 JSON/YAML 配置文件',
      );
    }

    const rest = key.slice('HANA_'.length);
    const param = OVERRIDE_PARAMS.find((p) => rest.startsWith(`${p}_ENV_`));
    if (!param) {
      if (rest.includes('_ENV_')) {
        throw new Error(
          `未知的环境覆盖参数：${key}。支持的参数：` + OVERRIDE_PARAMS.map((p) => `HANA_${p}_ENV_<XXXX>`).join('、'),
        );
      }
      continue; // 其余 HANA_* 是基础参数，不在这里处理
    }

    const configKey = rest.slice(`${param}_ENV_`.length);
    validateEnvKey(configKey);
    const value = parseOverride(param, key, env[key]);
    if (value === undefined) continue; // 空值 = 继承共用值

    const ov = overrides.get(configKey) ?? { configKey };
    assignOverride(ov, param, value);
    overrides.set(configKey, ov);
  }

  const labels = new Set<string>([baseLabel]);
  const named: EnvironmentEntry[] = [];
  for (const ov of [...overrides.values()].sort((a, b) => a.configKey.localeCompare(b.configKey))) {
    const label = ov.label ?? ov.configKey;
    validateLabel(label, ov.configKey, false);
    if (labels.has(label)) {
      throw new Error(`LABEL 重复：${label}。LABEL 是系统标识，必须唯一；请修改 HANA_LABEL 或 HANA_LABEL_ENV_<XXXX>`);
    }
    labels.add(label);

    const access = ov.access ?? baseAccess;
    if (ov.access === undefined && baseAccess === 'readwrite') {
      logger.warn(
        { configKey: ov.configKey, label },
        '命名环境继承 HANA_ACCESS=readwrite；如果它是生产环境，请显式设置 HANA_ACCESS_ENV_<XXXX>=readonly',
      );
    }
    if (ov.user !== undefined && ov.password === undefined) {
      logger.warn(
        { configKey: ov.configKey, label },
        '命名环境覆盖了 USER 但没有覆盖 PASSWORD：将使用共用密码，请确认这是预期',
      );
    }
    if (ov.password !== undefined && ov.user === undefined) {
      logger.warn(
        { configKey: ov.configKey, label },
        '命名环境覆盖了 PASSWORD 但没有覆盖 USER：将使用共用账号，请确认这是预期',
      );
    }

    const config: HanaConfig = {
      ...baseConfig,
      host: ov.host ?? baseConfig.host,
      port: ov.port ?? baseConfig.port,
      user: ov.user ?? baseConfig.user,
      password: ov.password ?? baseConfig.password,
      locale: ov.locale ?? baseConfig.locale,
      dbName: ov.dbName ?? baseConfig.dbName,
      tls: ov.tls ?? baseConfig.tls,
      sslValidate: ov.sslValidate ?? baseConfig.sslValidate,
      xsPort: ov.xsPort ?? baseConfig.xsPort,
      xsBasePath: ov.xsBasePath ?? baseConfig.xsBasePath,
      xsTls: ov.xsTls ?? baseConfig.xsTls,
      access,
      environment: label,
      configKey: ov.configKey,
      readonlySql: baseConfig.readonlySql,
    };
    named.push({ label, configKey: ov.configKey, access, config });
  }

  const entries = [{ label: baseLabel, configKey: 'default', access: baseAccess, config: baseConfig }, ...named];
  const startLabel = nonEmpty(opts.start) ?? baseLabel;
  if (!labels.has(startLabel)) {
    throw new Error(`HANA_ENV_START="${startLabel}" 未配置：可用 LABEL = ${[...labels].join(', ')}`);
  }

  const seen = new Set<string>();
  for (const label of opts.switchable) {
    if (seen.has(label)) {
      throw new Error(`HANA_ENV_SWITCHABLE 含重复 LABEL：${label}`);
    }
    if (!labels.has(label)) {
      throw new Error(`HANA_ENV_SWITCHABLE 含未知 LABEL：${label}；可用 LABEL = ${[...labels].join(', ')}`);
    }
    seen.add(label);
  }

  return {
    base: entries[0],
    entries,
    startLabel,
    switchable: [...opts.switchable],
    multiEnv: named.length > 0,
  };
}

/** 供 config.ts 复用的轻量解析：把 raw 值当逗号列表（与 envSchema 的 transform 同源）。 */
export function parseSwitchable(raw: unknown): string[] {
  return splitList(raw);
}
