import type { HanaPool } from '../core/hana-client.js';

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

/** 系统信息（SYS.M_DATABASE + M_HOST_INFORMATION + 会话） */
export async function getSystemInfo(pool: HanaPool): Promise<SystemInfo> {
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
  const hostInfo: Record<string, string> = {};
  for (const h of hostRows) hostInfo[h.KEY] = h.VALUE;

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
