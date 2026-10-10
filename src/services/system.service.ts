import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { getEnvironmentProfile, type EnvironmentProfile } from '../config/profile.js';
import { RULES, RULE_IDS, getRules, type RuleId, type RuleObject } from '../rules/index.js';

/** 规则目录条目（省 token 的索引：只给 id + title；要看全文再传 rules=<id>） */
export interface RuleCatalogEntry {
  id: RuleId;
  title: string;
}

/** hana_system_get_info 的规则查询结果（rules 参数省略时是目录，传了则是命中规则的全文） */
export interface RuleQueryResult {
  /** 'catalog' = 未指定 rules（只给目录）；'full' = 命中了 all/规则 id（给出全文） */
  mode: 'catalog' | 'full';
  /** 规则目录：mode='catalog' 时的内容（id + title，省 token） */
  catalog?: RuleCatalogEntry[];
  /** 命中规则的全文（id/title/detail/errorCodes/tools）：mode='full' 时的内容，不重复列目录 */
  items?: RuleObject[];
}

/** getSystemInfo 的可选项（工具层的 params 原样透传；均可省略） */
export interface SystemInfoOptions {
  /** 规则查询：`'all'` 或规则 id（逗号分隔多个）；省略 = 只给目录（省 token） */
  rules?: string;
  /** 强制重探环境档案（默认走进程内缓存） */
  refreshProfile?: boolean;
}

/** hana_system_get_info 返回的系统信息 */
export interface SystemInfo {
  sid: string;
  database: string;
  host: string;
  version: string;
  usage: string;
  startedAt: string;
  /** M_HOST_INFORMATION 的 KEY/VALUE 摘要 */
  hostInfo: Record<string, string>;
  currentUser: string;
  currentSchema: string;
  /** 环境档案（P9）：首次调用时探测一次并进程内缓存；探测失败 fail-open（detected:false + note），不影响其余信息 */
  profile: EnvironmentProfile;
  /** 规则库（P9）：省略 rules = 目录（id+title）；传 all 或规则 id = 命中规则全文 */
  rules: RuleQueryResult;
}

/** 宽松 schema 的合法值提示（SSD §1.6：schema 只用 z.string()，合法值在此以中文列全，单一事实源 = RULE_IDS） */
function rulesValueHint(): string {
  return `合法值：all（全部规则的全文），或用逗号分隔的规则 id：${RULE_IDS.join(', ')}`;
}

/**
 * `rules` 参数 → 目录/全文（工具面宽松 schema 契约，SSD §1.6）。
 *
 * - 省略 → 目录（id + title，省 token）；
 * - `'all'` → 全部规则的全文（与 id 混写时按 all 处理）；
 * - 逗号分隔的 id → 命中规则的全文；未知 id 由 `getRules` 抛中文硬错误并列出合法 id（与规则模块同一实现）。
 *
 * 空串/纯逗号**明确报错**而不是给空列表——空列表会被读成"没有规则"，而真实原因是参数写空了。
 */
export function resolveRules(raw?: string): RuleQueryResult {
  if (raw === undefined) {
    return { mode: 'catalog', catalog: RULES.map((r) => ({ id: r.id, title: r.title })) };
  }
  const ids = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s !== '');
  if (ids.length === 0) throw new HanaBusinessError(`rules 参数为空。${rulesValueHint()}`);
  if (ids.includes('all')) return { mode: 'full', items: getRules() };
  return { mode: 'full', items: getRules(ids) };
}

/** hana_check_privileges 返回的权限报告 */
export interface PrivilegeReport {
  session: { user: string; schema: string };
  roles: string[];
  systemPrivileges: string[];
  /** 有 SELECT 的 schema 列表 */
  schemaSelect: string[];
  /** REPO.* 仓库权限 */
  repoPrivileges: string[];
  /** 建模能力摘要（结论性判断，供 LLM 快速决策） */
  summary: {
    canReadRepository: boolean;
    canWriteRepository: boolean;
    canActivate: boolean;
    canReadBimc: boolean;
    canReadData: boolean;
  };
}

/**
 * 系统信息（SYS.M_DATABASE + M_HOST_INFORMATION + 会话）+ 环境档案（P9）+ 规则库（P9）。
 *
 * 规则参数**先校验**（写错立即硬错误，不白探一遍档案）；档案在主体信息取到之后才探——
 * 它可能连库（探测失败时 fail-open 不抛错），不该让它的开销或故障抢在主体信息之前。
 */
export async function getSystemInfo(pool: HanaPool, opts?: SystemInfoOptions): Promise<SystemInfo> {
  const rules = resolveRules(opts?.rules);
  const db = await pool.query<{
    SYSTEM_ID: string;
    DATABASE_NAME: string;
    HOST: string;
    START_TIME: string;
    VERSION: string;
    USAGE: string;
  }>('SELECT SYSTEM_ID, DATABASE_NAME, HOST, START_TIME, VERSION, USAGE FROM SYS.M_DATABASE');
  const hostRows = await pool.query<{ KEY: string; VALUE: string }>(
    "SELECT KEY, VALUE FROM SYS.M_HOST_INFORMATION WHERE KEY IN ('sid','sapsystem','net_publicname','os','os_version') ORDER BY KEY",
  );
  const sess = await pool.query<{ CURRENT_USER: string; CURRENT_SCHEMA: string }>(
    'SELECT CURRENT_USER, CURRENT_SCHEMA FROM DUMMY',
  );

  const row = db[0];
  if (!row) {
    // 缺行时**明确报错**，而不是让字段依次取 `?? ''` 悄悄退化成一份"什么都为空"的信息——
    // 那种输出会被读成"这套库就是没有 SID/版本"，而真实原因是这次探测本身失败了。
    logger.warn({ view: 'SYS.M_DATABASE' }, 'SYS.M_DATABASE 未返回任何行，系统信息无法取得');
    throw new HanaBusinessError(
      'SYS.M_DATABASE 未返回任何行：无法取得 SID / 数据库名 / 版本（连接目标可能不是 HANA，或当前用户缺少读该视图的权限）',
      'SYSTEM_INFO_UNAVAILABLE',
    );
  }
  const hostInfo: Record<string, string> = {};
  for (const h of hostRows) hostInfo[h.KEY] = h.VALUE;

  // 环境档案：进程内缓存；刷新只影响档案本身，主体信息每次现查
  const profile = await getEnvironmentProfile(pool, { refresh: opts?.refreshProfile });

  return {
    sid: row.SYSTEM_ID,
    database: row.DATABASE_NAME,
    host: row.HOST,
    version: row.VERSION,
    usage: row.USAGE,
    startedAt: row.START_TIME,
    hostInfo,
    currentUser: sess[0]?.CURRENT_USER ?? '',
    currentSchema: sess[0]?.CURRENT_SCHEMA ?? '',
    profile,
    rules,
  };
}

/** 当前用户权限矩阵 + 建模能力摘要（SYS.EFFECTIVE_ROLES / EFFECTIVE_PRIVILEGES） */
export async function getPrivileges(pool: HanaPool): Promise<PrivilegeReport> {
  const sess = await pool.query<{ CURRENT_USER: string; CURRENT_SCHEMA: string }>(
    'SELECT CURRENT_USER, CURRENT_SCHEMA FROM DUMMY',
  );
  const roles = await pool.query<{ ROLE_NAME: string }>(
    'SELECT ROLE_NAME FROM SYS.EFFECTIVE_ROLES WHERE USER_NAME = CURRENT_USER ORDER BY ROLE_NAME',
  );
  const sysPrivs = await pool.query<{ PRIVILEGE: string }>(
    'SELECT DISTINCT PRIVILEGE FROM SYS.EFFECTIVE_PRIVILEGES WHERE USER_NAME = CURRENT_USER AND OBJECT_NAME IS NULL ORDER BY PRIVILEGE',
  );
  const schemaSel = await pool.query<{ SCHEMA_NAME: string }>(
    "SELECT DISTINCT SCHEMA_NAME FROM SYS.EFFECTIVE_PRIVILEGES WHERE USER_NAME = CURRENT_USER AND PRIVILEGE = 'SELECT' ORDER BY SCHEMA_NAME",
  );
  const repoPrivs = await pool.query<{ PRIVILEGE: string }>(
    "SELECT DISTINCT PRIVILEGE FROM SYS.EFFECTIVE_PRIVILEGES WHERE USER_NAME = CURRENT_USER AND PRIVILEGE LIKE 'REPO%' ORDER BY PRIVILEGE",
  );

  const systemPrivileges = sysPrivs.map((r) => r.PRIVILEGE);
  const schemaSelect = schemaSel.map((r) => r.SCHEMA_NAME);
  const repoPrivileges = repoPrivs.map((r) => r.PRIVILEGE);
  const up = (s: string): string => s.toUpperCase();
  const sysHas = (...names: string[]): boolean => names.some((n) => systemPrivileges.includes(up(n)));

  return {
    session: { user: sess[0]?.CURRENT_USER ?? '', schema: sess[0]?.CURRENT_SCHEMA ?? '' },
    roles: roles.map((r) => r.ROLE_NAME),
    systemPrivileges,
    schemaSelect,
    repoPrivileges,
    summary: {
      canReadRepository: schemaSelect.some((s) => up(s) === '_SYS_REPO'),
      canWriteRepository: repoPrivileges.includes('REPO.MODIFY_CHANGE') || sysHas('REPO.MODIFY_CHANGE'),
      canActivate: sysHas('CREATE ANY') && (repoPrivileges.length > 0 || sysHas('REPO.MODIFY_OWN_CONTRIBUTION')),
      canReadBimc: schemaSelect.some((s) => up(s) === '_SYS_BI'),
      canReadData: schemaSelect.some((s) => up(s) === '_SYS_BIC'),
    },
  };
}
