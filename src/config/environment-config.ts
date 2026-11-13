/**
 * 多环境配置层（v2）：按参数性质分三类，模式先判断、再做作用域解析。
 *
 * 规则（见 docs/multi-hana-environment-redesign.md §0）：
 * - **单环境**（没有任何 `_ENV_` 变量）：扁平 `HANA_*` 就是唯一环境，行为与旧版一致；
 *   `HANA_LABEL` 残留静默忽略（不告警、不报错）。
 * - **多环境**（出现任意 `_ENV_` 变量）：
 *   - **连接参数**：扁平键硬报错；只能 `HANA_<PARAM>_ENV_<XXXX>`，每个环境必须解析到；
 *   - **策略/授权参数**：扁平键 = 所有环境共享；`_ENV_<XXXX>` 覆盖单个环境；
 *   - **进程级参数**：只能扁平写；`_ENV_` 形式启动失败。
 * - 环境标识 = `_ENV_<XXXX>` 的 `<XXXX>`，大小写不敏感，内部规范化为大写；
 *   不再有 `HANA_LABEL` / `HANA_LABEL_ENV_*`。
 *
 * 本模块只做纯解析与校验，不读 .env、不删 process.env、不建池；生命周期由 config.ts 统一收口。
 */

import { logger } from '../core/logger.js';
import { splitList } from '../core/text.js';
import {
  POOL_ACQUIRE_TIMEOUT_MS_DEFAULT,
  POOL_MAX_DEFAULT,
  POOL_MAX_WAITERS_DEFAULT,
  SQL_MAX_RESULT_BYTES_DEFAULT,
  SQL_MAX_RESULT_BYTES_LIMIT,
  SQL_MAX_RESULT_BYTES_MIN,
  SQL_MAX_STATEMENTS_DEFAULT,
  SQL_MAX_STATEMENTS_LIMIT,
  SQL_TIMEOUT_MS_DEFAULT,
  XS_TIMEOUT_MS_DEFAULT,
  XS_XFER_TIMEOUT_MS_DEFAULT,
} from '../core/limits.js';
import { XS_BASE_PATH } from '../core/xs-rest.js';
import type { HanaConfig } from './config.js';
import { interceptionError } from './error-codes.js';
import { PARAM_REGISTRY, type ParamSpec } from './param-registry.js';
import { findInvalidWritePackages } from './write-boundary.js';

export type EnvironmentAccess = 'readwrite' | 'readonly';
export type ReadonlySqlPolicy = 'select-only' | 'deny';
export type EnvironmentMode = 'single' | 'multi';

/** 一个可运行环境：envKey 是环境标识（规范化为大写），不再有 LABEL/configKey。 */
export interface EnvironmentEntry {
  envKey: string;
  access: EnvironmentAccess;
  config: HanaConfig;
}

/** loadEnvironments 的结果：base 是启动环境（单环境时唯一的那个）。 */
export interface LoadedEnvironments {
  base: EnvironmentEntry;
  entries: EnvironmentEntry[];
  startKey: string;
  switchable: string[];
  multiEnv: boolean;
  mode: EnvironmentMode;
}

/** 环境标识：大小写不敏感，内部规范化为大写。 */
const ENV_KEY_RE = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;
/** 不允许作为环境标识的保留名（DEFAULT 是普通环境键，不在此列） */
const RESERVED_ENV_KEYS = new Set(['START', 'SWITCHABLE', 'CONFIG']);
/** 全局键（不是 `<PARAM>_ENV_<XXXX>`） */
const GLOBAL_ENV_KEYS = new Set([
  'HANA_ENV_START',
  'HANA_ENV_SWITCHABLE',
  'HANA_ENV_MODE',
  'HANA_ENV_INHERIT',
  'HANA_ENV_LOAD_DOTENV',
]);
/** 已移除的 LABEL 键（单环境静默忽略；多环境报 label_removed） */
const REMOVED_LABEL_KEYS = new Set(['HANA_LABEL']);

const TRUE_VALUES = new Set(['true', '1', 'TRUE']);
const FALSE_VALUES = new Set(['false', '0', 'FALSE']);

/** 按名字长度倒序，避免 XS_PORT 被 PORT 抢先匹配 */
const SCOPED_PARAMS = [...PARAM_REGISTRY].sort((a, b) => b.name.length - a.name.length);

/** 策略参数的字段映射（解析结果写回 HanaConfig 的对应字段） */
const POLICY_FIELD = {
  ACCESS: 'access',
  READONLY_SQL: 'readonlySql',
  WRITE_PACKAGES: 'writePackages',
  READ_SCHEMA: 'schemaAllow',
  SQL_TIMEOUT_MS: 'sqlTimeoutMs',
  SQL_ALLOW_MULTI_STATEMENT: 'sqlAllowMultiStatement',
  SQL_MAX_RESULT_BYTES: 'sqlMaxResultBytes',
  SQL_MAX_STATEMENTS: 'sqlMaxStatements',
  XS_TIMEOUT_MS: 'xsTimeoutMs',
  XS_XFER_TIMEOUT_MS: 'xsXferTimeoutMs',
  POOL_MAX: 'poolMax',
  POOL_WAIT_MS: 'poolWaitMs',
  POOL_MAX_WAITERS: 'poolMaxWaiters',
} as const;

/** 多环境下的连接默认值（可选参数）；HOST/PORT/USER/PASSWORD 没有默认，必须显式配置 */
const CONNECTION_DEFAULTS = {
  TLS: true,
  SSL_VALIDATE: true,
  LOCALE: 'zh',
  XS_PORT: 8010,
  XS_TLS: false,
  XS_BASE_PATH,
} as const;

interface OverrideCell {
  parsed: unknown;
  rawKey: string;
}

interface ScannedOverrides {
  envKeys: Set<string>;
  /** envKey → 参数名 → 覆盖值 */
  cells: Map<string, Map<string, OverrideCell>>;
}

function nonEmpty(raw: unknown): string | undefined {
  if (raw === undefined || raw === null) return undefined;
  const s = String(raw).trim();
  return s === '' ? undefined : s;
}

function hasValue(raw: unknown): boolean {
  return nonEmpty(raw) !== undefined;
}

function parsePort(key: string, raw: unknown): number | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (!/^[0-9]+$/.test(s)) {
    throw interceptionError('config_invalid', `${key} 无效：端口必须是纯数字（如 30015）`);
  }
  const n = Number(s);
  if (n < 1 || n > 65535) {
    throw interceptionError('config_invalid', `${key} 无效：端口必须在 1..65535 之间`);
  }
  return n;
}

function parseBool(key: string, raw: unknown): boolean | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (TRUE_VALUES.has(s)) return true;
  if (FALSE_VALUES.has(s)) return false;
  throw interceptionError(
    'config_invalid',
    `${key} 取值非法：合法值为 true/false/1/0/TRUE/FALSE（留空 = 继承共享值/内置默认）`,
  );
}

function parseAccess(key: string, raw: unknown): EnvironmentAccess | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (s !== 'readwrite' && s !== 'readonly') {
    throw interceptionError('config_invalid', `${key} 取值非法：只能是 readwrite / readonly`);
  }
  return s;
}

function parseReadonlySql(key: string, raw: unknown): ReadonlySqlPolicy | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (s !== 'select-only' && s !== 'deny') {
    throw interceptionError('config_invalid', `${key} 取值非法：只能是 select-only / deny`);
  }
  return s;
}

function parseIntRange(key: string, raw: unknown, min: number, max: number): number | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return undefined;
  if (!/^[0-9]+$/.test(s)) {
    throw interceptionError('config_invalid', `${key} 无效：必须是正整数`);
  }
  const n = Number(s);
  if (!Number.isInteger(n) || n < min || n > max) {
    throw interceptionError('config_invalid', `${key} 无效：必须在 ${min}..${max} 之间`);
  }
  return n;
}

function parseWritePackages(key: string, raw: unknown): string[] | undefined {
  const s = nonEmpty(raw);
  // 显式空 = 该环境无写包（与"未配置=继承共享"不同）
  if (s === undefined) return raw === undefined ? undefined : [];
  const entries = splitList(s).map((x) => x.toUpperCase());
  const invalid = findInvalidWritePackages(entries);
  if (invalid.length > 0) {
    throw interceptionError(
      'config_invalid',
      `${key} 含非法包名：${invalid.join(', ')}。合法形式为点分段的仓库包路径（大写字母/数字/下划线/连字符）`,
      '请给出合法的可写包前缀；整体留空 = 该环境无写包。',
    );
  }
  return entries;
}

function parseReadSchema(raw: unknown): string[] | undefined {
  const s = nonEmpty(raw);
  if (s === undefined) return raw === undefined ? undefined : [];
  return splitList(s);
}

/** 解析一个 `_ENV_` 覆盖值；返回 undefined = 未设置（继承共享/内置默认） */
function parseScopedValue(spec: ParamSpec, key: string, raw: unknown): unknown {
  switch (spec.name) {
    case 'HOST':
    case 'USER':
    case 'PASSWORD':
    case 'DB_NAME':
    case 'LOCALE':
    case 'XS_BASE_PATH':
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
    case 'READONLY_SQL':
      return parseReadonlySql(key, raw);
    case 'WRITE_PACKAGES':
      return parseWritePackages(key, raw);
    case 'READ_SCHEMA':
      return parseReadSchema(raw);
    case 'SQL_TIMEOUT_MS':
      return parseIntRange(key, raw, 1, 3_600_000);
    case 'SQL_ALLOW_MULTI_STATEMENT':
      return parseBool(key, raw);
    case 'SQL_MAX_RESULT_BYTES':
      return parseIntRange(key, raw, SQL_MAX_RESULT_BYTES_MIN, SQL_MAX_RESULT_BYTES_LIMIT);
    case 'SQL_MAX_STATEMENTS':
      return parseIntRange(key, raw, 1, SQL_MAX_STATEMENTS_LIMIT);
    case 'XS_TIMEOUT_MS':
      return parseIntRange(key, raw, 1, 3_600_000);
    case 'XS_XFER_TIMEOUT_MS':
      return parseIntRange(key, raw, 1, 86_400_000);
    case 'POOL_MAX':
      return parseIntRange(key, raw, 1, 256);
    case 'POOL_WAIT_MS':
      return parseIntRange(key, raw, 1, 3_600_000);
    case 'POOL_MAX_WAITERS':
      return parseIntRange(key, raw, 1, 100_000);
    default:
      // 进程级/未知参数在扫描阶段已拒绝，不应到这里
      throw interceptionError('process_param_scoped', `${key} 不是环境级参数`);
  }
}

function findScopedParam(rest: string): { spec: ParamSpec; rawEnvKey: string } | undefined {
  for (const spec of SCOPED_PARAMS) {
    const prefix = `${spec.name}_ENV_`;
    if (rest.startsWith(prefix)) return { spec, rawEnvKey: rest.slice(prefix.length) };
  }
  return undefined;
}

/** 校验并规范化环境标识；大小写不敏感，返回大写形式 */
export function canonicalEnvKey(raw: string, keyForError = '环境标识'): string {
  const s = raw.trim();
  if (!ENV_KEY_RE.test(s)) {
    throw interceptionError(
      'env_key_invalid',
      `${keyForError} "${s}" 非法：必须匹配 ${ENV_KEY_RE}（旧 LABEL 里的 - 请改成 _）`,
    );
  }
  const canonical = s.toUpperCase();
  if (RESERVED_ENV_KEYS.has(canonical)) {
    throw interceptionError('env_key_invalid', `${keyForError} "${s}" 使用了保留名 ${canonical}；请换一个环境标识`);
  }
  return canonical;
}

/** 环境标识是否合法（用于判断键是否属于本模块） */
export function isValidEnvKey(raw: string): boolean {
  return ENV_KEY_RE.test(raw.trim());
}

/** 是否由本模块负责的配置键（warnUnknownEnvKeys 跳过；真正解析时再决定报错/忽略） */
export function isEnvironmentConfigKey(key: string): boolean {
  if (GLOBAL_ENV_KEYS.has(key)) return false;
  if (REMOVED_LABEL_KEYS.has(key)) return true;
  if (key.startsWith('HANA_LABEL_ENV_')) return true;
  if (key === 'HANA_ENV_CONFIG') return true;
  if (key.startsWith('HANA_ENV_')) return true;
  if (key.startsWith('HANA_') && key.includes('_ENV_')) return true;
  if (/^(MCP|LOG)_.*_ENV_/.test(key)) return true;
  return false;
}

/** 是否存在 `_ENV_` 形态的键（用于第一层模式判断；不含全局键） */
export function hasScopedEnvironmentKeys(env: NodeJS.ProcessEnv): boolean {
  return Object.keys(env).some((key) => {
    if (GLOBAL_ENV_KEYS.has(key)) return false;
    if (key.startsWith('HANA_') && key.includes('_ENV_')) return true;
    return /^(MCP|LOG)_.*_ENV_/.test(key);
  });
}

/** 扫描所有 `_ENV_` 键；进程级/未知/旧前缀/标签一律响亮失败 */
function scanOverrides(env: NodeJS.ProcessEnv): ScannedOverrides {
  const envKeys = new Set<string>();
  const cells = new Map<string, Map<string, OverrideCell>>();
  const seenRaw = new Map<string, string>(); // `${param}:${canonical}` → raw key

  for (const key of Object.keys(env)) {
    if (GLOBAL_ENV_KEYS.has(key)) continue;
    if (REMOVED_LABEL_KEYS.has(key)) continue; // 多环境时在 buildEnvironments 统一报 label_removed
    if (key === 'HANA_ENV_CONFIG') {
      throw interceptionError('env_config_unsupported', 'HANA_ENV_CONFIG 不支持：v2 只使用扁平环境变量');
    }
    if (key.startsWith('HANA_LABEL_ENV_')) {
      throw interceptionError(
        'label_removed',
        `${key} 已移除：环境标识直接取 _ENV_ 键里的 <XXXX>`,
        '删除 HANA_LABEL_ENV_*；把 HANA_<PARAM>_ENV_<XXXX> 的 <XXXX> 用作环境标识。',
      );
    }
    if (key.startsWith('HANA_ENV_')) {
      throw interceptionError(
        'legacy_env_prefix',
        `${key} 是旧前缀：请改用 HANA_<PARAM>_ENV_<XXXX>`,
        '例如 HANA_ENV_QAS_HOST → HANA_HOST_ENV_QAS。',
      );
    }
    if (!key.startsWith('HANA_')) {
      if (/^(MCP|LOG)_.*_ENV_/.test(key)) {
        throw interceptionError(
          'process_param_scoped',
          `${key} 是进程级参数，不能按环境配置`,
          '进程级参数只能扁平写（HANA_TOOL_* / MCP_* / LOG_LEVEL 等）。',
        );
      }
      continue;
    }

    const rest = key.slice('HANA_'.length);
    const found = findScopedParam(rest);
    if (!found) {
      if (rest.includes('_ENV_')) {
        throw interceptionError(
          'unknown_scoped_param',
          `未知的环境覆盖参数：${key}`,
          '对照 CONFIG.md《参数归类表》使用已登记的参数名。',
        );
      }
      continue; // 扁平 HANA_*（连接/策略）在后续步骤处理
    }

    const { spec, rawEnvKey } = found;
    if (spec.scope !== 'connection' && spec.scope !== 'policy') {
      throw interceptionError(
        'process_param_scoped',
        `${key} 是进程级参数，不能按环境配置`,
        '进程级参数只能扁平写；去掉 _ENV_<XXXX> 后缀。',
      );
    }

    const envKey = canonicalEnvKey(rawEnvKey, key);
    const conflictKey = `${spec.name}:${envKey}`;
    const previousRaw = seenRaw.get(conflictKey);
    if (previousRaw !== undefined && previousRaw !== key) {
      throw interceptionError(
        'env_key_conflict',
        `同一参数存在仅大小写不同的两个键：${previousRaw} 与 ${key}`,
        '只保留一个键，或把两个键统一成同一大小写。',
      );
    }
    seenRaw.set(conflictKey, key);

    const parsed = parseScopedValue(spec, key, env[key]);
    if (parsed === undefined) continue; // 空值 = 继承共享/内置默认
    envKeys.add(envKey);
    const byParam = cells.get(envKey) ?? new Map<string, OverrideCell>();
    byParam.set(spec.name, { parsed, rawKey: key });
    cells.set(envKey, byParam);
  }

  return { envKeys, cells };
}

/** 扁平连接键检查：多环境下不允许出现 */
function assertNoFlatConnectionKeys(env: NodeJS.ProcessEnv): void {
  const offending = PARAM_REGISTRY.filter((p) => p.scope === 'connection' && hasValue(env[p.envVar])).map(
    (p) => p.envVar,
  );
  if (offending.length > 0) {
    throw interceptionError(
      'flat_connection_key_in_multi',
      `检测到多环境配置，但仍在用扁平连接键：${offending.join(', ')}`,
      '把连接参数改成 HANA_<PARAM>_ENV_<XXXX>（例如 HANA_HOST_ENV_DEFAULT）；每个环境都必须能解析到 HOST/PORT/USER/PASSWORD。',
    );
  }
}

function requireConnection(envKey: string, cells: Map<string, OverrideCell> | undefined, name: string): unknown {
  const cell = cells?.get(name);
  if (cell === undefined || cell.parsed === undefined) {
    throw interceptionError(
      'missing_connection_param',
      `环境 ${envKey} 缺少连接参数 HANA_${name}_ENV_${envKey}`,
      `补 HANA_${name}_ENV_${envKey}；HOST/PORT/USER/PASSWORD 没有共享回退。`,
    );
  }
  return cell.parsed;
}

function policyValue<T>(baseConfig: HanaConfig, cells: Map<string, OverrideCell> | undefined, name: string): T {
  const cell = cells?.get(name);
  if (cell !== undefined && cell.parsed !== undefined) return cell.parsed as T;
  const field = POLICY_FIELD[name as keyof typeof POLICY_FIELD];
  return (baseConfig as unknown as Record<string, unknown>)[field] as T;
}

function buildEnvConfig(
  baseConfig: HanaConfig,
  envKey: string,
  cells: Map<string, OverrideCell> | undefined,
): EnvironmentEntry {
  const getConn = (name: string, fallback?: unknown): unknown => {
    const cell = cells?.get(name);
    if (cell !== undefined && cell.parsed !== undefined) return cell.parsed;
    if (fallback !== undefined) return fallback;
    return undefined;
  };

  const host = requireConnection(envKey, cells, 'HOST') as string;
  const port = requireConnection(envKey, cells, 'PORT') as number;
  const user = requireConnection(envKey, cells, 'USER') as string;
  const password = requireConnection(envKey, cells, 'PASSWORD') as string;

  const access = policyValue<EnvironmentAccess>(baseConfig, cells, 'ACCESS') ?? 'readwrite';
  const config: HanaConfig = {
    ...baseConfig,
    host,
    port,
    user,
    password,
    dbName: getConn('DB_NAME') as string | undefined,
    tls: (getConn('TLS', CONNECTION_DEFAULTS.TLS) as boolean | undefined) ?? CONNECTION_DEFAULTS.TLS,
    sslValidate:
      (getConn('SSL_VALIDATE', CONNECTION_DEFAULTS.SSL_VALIDATE) as boolean | undefined) ??
      CONNECTION_DEFAULTS.SSL_VALIDATE,
    locale: (getConn('LOCALE', CONNECTION_DEFAULTS.LOCALE) as string | undefined) ?? CONNECTION_DEFAULTS.LOCALE,
    xsPort: (getConn('XS_PORT', CONNECTION_DEFAULTS.XS_PORT) as number | undefined) ?? CONNECTION_DEFAULTS.XS_PORT,
    xsTls: (getConn('XS_TLS', CONNECTION_DEFAULTS.XS_TLS) as boolean | undefined) ?? CONNECTION_DEFAULTS.XS_TLS,
    xsBasePath:
      (getConn('XS_BASE_PATH', CONNECTION_DEFAULTS.XS_BASE_PATH) as string | undefined) ??
      CONNECTION_DEFAULTS.XS_BASE_PATH,
    access,
    readonlySql: policyValue<ReadonlySqlPolicy>(baseConfig, cells, 'READONLY_SQL') ?? 'select-only',
    writePackages: policyValue<string[]>(baseConfig, cells, 'WRITE_PACKAGES') ?? [],
    schemaAllow: policyValue<string[]>(baseConfig, cells, 'READ_SCHEMA') ?? [],
    sqlTimeoutMs: policyValue<number>(baseConfig, cells, 'SQL_TIMEOUT_MS') ?? SQL_TIMEOUT_MS_DEFAULT,
    sqlAllowMultiStatement: policyValue<boolean>(baseConfig, cells, 'SQL_ALLOW_MULTI_STATEMENT') ?? false,
    sqlMaxResultBytes: policyValue<number>(baseConfig, cells, 'SQL_MAX_RESULT_BYTES') ?? SQL_MAX_RESULT_BYTES_DEFAULT,
    sqlMaxStatements: policyValue<number>(baseConfig, cells, 'SQL_MAX_STATEMENTS') ?? SQL_MAX_STATEMENTS_DEFAULT,
    xsTimeoutMs: policyValue<number>(baseConfig, cells, 'XS_TIMEOUT_MS') ?? XS_TIMEOUT_MS_DEFAULT,
    xsXferTimeoutMs: policyValue<number>(baseConfig, cells, 'XS_XFER_TIMEOUT_MS') ?? XS_XFER_TIMEOUT_MS_DEFAULT,
    poolMax: policyValue<number>(baseConfig, cells, 'POOL_MAX') ?? POOL_MAX_DEFAULT,
    poolWaitMs: policyValue<number>(baseConfig, cells, 'POOL_WAIT_MS') ?? POOL_ACQUIRE_TIMEOUT_MS_DEFAULT,
    poolMaxWaiters: policyValue<number>(baseConfig, cells, 'POOL_MAX_WAITERS') ?? POOL_MAX_WAITERS_DEFAULT,
    envKey,
  };
  return { envKey, access, config };
}

/**
 * 从原始 env 与基础配置构造环境表。
 *
 * 前置：baseConfig 已由 envSchema 解析完成（单环境时连接值必填；多环境时连接值可缺）。
 * 本函数只抛配置错误；不做 I/O。
 */
export function buildEnvironments(
  env: NodeJS.ProcessEnv,
  baseConfig: HanaConfig,
  opts: { start: string; switchable: string[]; mode?: EnvironmentMode },
): LoadedEnvironments {
  const detectedMulti = hasScopedEnvironmentKeys(env);
  const explicitMode = opts.mode;
  if (explicitMode === 'single' && detectedMulti) {
    throw interceptionError(
      'env_mode_mismatch',
      'HANA_ENV_MODE=single，但检测到 _ENV_ 变量',
      '删掉 HANA_ENV_MODE 让服务自动判断，或改成 multi。',
    );
  }
  if (explicitMode === 'multi' && !detectedMulti) {
    throw interceptionError(
      'env_mode_mismatch',
      'HANA_ENV_MODE=multi，但没有检测到任何 _ENV_ 变量',
      '补充 HANA_<PARAM>_ENV_<XXXX>，或删掉 HANA_ENV_MODE。',
    );
  }
  const multiEnv = detectedMulti;

  // 单环境：扁平配置就是唯一环境；HANA_LABEL 静默忽略。
  if (!multiEnv) {
    const startKey =
      nonEmpty(opts.start) === undefined ? 'DEFAULT' : canonicalEnvKey(String(opts.start), 'HANA_ENV_START');
    if (startKey !== 'DEFAULT') {
      throw interceptionError(
        'env_key_unknown',
        `HANA_ENV_START="${opts.start}" 未配置：单环境只接受 DEFAULT（或留空）`,
        '单环境无需设置 HANA_ENV_START；多环境请补充 _ENV_ 变量。',
      );
    }
    if (opts.switchable.length > 0) {
      throw interceptionError(
        'env_switchable_in_single',
        '单环境部署配置了 HANA_ENV_SWITCHABLE',
        '删除 HANA_ENV_SWITCHABLE，或补充 _ENV_ 变量进入多环境模式。',
      );
    }
    const missing: string[] = [];
    if (!hasValue(baseConfig.host)) missing.push('HANA_HOST');
    if (!baseConfig.port) missing.push('HANA_PORT');
    if (!hasValue(baseConfig.user)) missing.push('HANA_USER');
    if (!hasValue(baseConfig.password)) missing.push('HANA_PASSWORD');
    if (missing.length > 0) {
      throw interceptionError(
        'missing_connection_param',
        `单环境缺少必填连接参数：${missing.join(', ')}`,
        '补齐 HANA_HOST/HANA_PORT/HANA_USER/HANA_PASSWORD；或配置 _ENV_ 变量进入多环境模式。',
      );
    }
    baseConfig.envKey = 'DEFAULT';
    const entry: EnvironmentEntry = {
      envKey: 'DEFAULT',
      access: baseConfig.access ?? 'readwrite',
      config: baseConfig,
    };
    return {
      base: entry,
      entries: [entry],
      startKey: 'DEFAULT',
      switchable: [],
      multiEnv: false,
      mode: 'single',
    };
  }

  // 多环境：LABEL 已移除；扁平连接键硬报错。
  if (Object.keys(env).some((k) => k === 'HANA_LABEL')) {
    throw interceptionError(
      'label_removed',
      'HANA_LABEL 已移除：环境标识直接取 _ENV_ 键里的 <XXXX>',
      '删除 HANA_LABEL；把 HANA_<PARAM>_ENV_<XXXX> 的 <XXXX> 用作环境标识。',
    );
  }
  assertNoFlatConnectionKeys(env);

  const { envKeys, cells } = scanOverrides(env);
  if (envKeys.size === 0) {
    // 只出现了被忽略的空覆盖；仍然算多环境，但没有可用环境
    throw interceptionError(
      'env_mode_mismatch',
      '检测到多环境配置，但没有解析出任何环境标识',
      '检查 _ENV_ 变量是否为空值；至少给一个环境配置连接参数。',
    );
  }

  const entries: EnvironmentEntry[] = [];
  for (const envKey of [...envKeys].sort((a, b) => a.localeCompare(b))) {
    const entry = buildEnvConfig(baseConfig, envKey, cells.get(envKey));
    // 共享 readwrite 的安全提示：没显式覆盖 ACCESS 时提醒一次
    const explicitAccess = cells.get(envKey)?.has('ACCESS') === true;
    if (entry.access === 'readwrite' && !explicitAccess) {
      logger.warn(
        { envKey },
        '多环境环境未显式覆盖 ACCESS，使用共享值/默认 readwrite；如果它是生产环境，请设置 HANA_ACCESS_ENV_<XXXX>=readonly',
      );
    }
    entries.push(entry);
  }

  const startRaw = nonEmpty(opts.start);
  let startKey: string;
  if (startRaw === undefined) {
    if (entries.length > 1) {
      throw interceptionError(
        'env_start_required',
        `多环境未设置 HANA_ENV_START；可用环境标识：${entries.map((e) => e.envKey).join(', ')}`,
      );
    }
    startKey = entries[0].envKey;
  } else {
    startKey = canonicalEnvKey(startRaw, 'HANA_ENV_START');
  }
  if (!envKeys.has(startKey)) {
    throw interceptionError(
      'env_key_unknown',
      `HANA_ENV_START="${opts.start}" 未配置；可用环境标识：${[...envKeys].join(', ')}`,
    );
  }

  const switchable: string[] = [];
  const seenSwitchable = new Set<string>();
  for (const raw of opts.switchable) {
    const key = canonicalEnvKey(raw, 'HANA_ENV_SWITCHABLE');
    if (seenSwitchable.has(key)) {
      throw interceptionError('config_invalid', `HANA_ENV_SWITCHABLE 含重复环境标识：${key}（大小写不敏感）`);
    }
    if (!envKeys.has(key)) {
      throw interceptionError(
        'env_key_unknown',
        `HANA_ENV_SWITCHABLE 含未知环境标识：${key}；可用环境标识：${[...envKeys].join(', ')}`,
      );
    }
    seenSwitchable.add(key);
    switchable.push(key);
  }

  const base = entries.find((e) => e.envKey === startKey) ?? entries[0];
  return {
    base,
    entries,
    startKey,
    switchable,
    multiEnv: true,
    mode: 'multi',
  };
}

/** 供 config.ts 复用的轻量解析：把 raw 值当逗号列表（与 envSchema 的 transform 同源）。 */
export function parseSwitchable(raw: unknown): string[] {
  return splitList(raw);
}
