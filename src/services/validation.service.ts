import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError, normalizeHanaError } from '../core/errors.js';
import { assertSchemaAllowed } from '../core/sql.js';

/**
 * 视图校验服务：
 * 基于 SYS.CHECK_CALCULATION_VIEW(ACTIONNAME, SCHEMA_NAME, VIEW_NAME) 对**已激活的运行时列视图**做一致性校验。
 * - ACTIONNAME 合法值经 SYS.GET_CHECK_ACTIONS 查询（calculationview 相关仅 CHECK_CONSISTENCY）
 * - 校验对象是运行时视图（_SYS_BIC."包路径/视图名"），非设计时仓库对象
 * - 成功=视图一致（无输出）；失败=CALCULATION ENGINE 抛错，携错误细节
 */

/** CHECK 过程支持的 action 条目 */
export interface CheckAction {
  action: string;
  description?: string;
}

/** GET_CHECK_ACTIONS：查询某 CHECK 过程支持的全部 ACTION 与说明 */
export async function getCheckActions(pool: HanaPool, checkProcedureName: string): Promise<CheckAction[]> {
  // 过程名白名单（防注入：仅允许 SYS 下 CHECK_* 系过程）
  const SAFE: Record<string, string> = {
    CHECK_CALCULATION_VIEW: 'CHECK_CALCULATION_VIEW',
    CHECK_CATALOG: 'CHECK_CATALOG',
    CHECK_CALCENGINE: 'CHECK_CALCENGINE',
    CHECK_TABLE_CONSISTENCY: 'CHECK_TABLE_CONSISTENCY',
    CHECK_TOPOLOGY_TREE: 'CHECK_TOPOLOGY_TREE',
    CHECK_ES: 'CHECK_ES',
    CHECK_CALCULATION_MODEL: 'CHECK_CALCULATION_MODEL',
    CHECK_ANALYTICAL_MODEL: 'CHECK_ANALYTICAL_MODEL',
  };
  const proc = SAFE[checkProcedureName.toUpperCase()];
  if (!proc) {
    throw new HanaBusinessError(
      `不支持的 check 过程 "${checkProcedureName}"。可用：${Object.values(SAFE).join(' / ')}`,
    );
  }
  // CALL 返回结果集（table 输出），走 query 通道
  const rows = await pool.query<{ ACTION: string; DESCRIPTION?: string }>(
    `CALL SYS.GET_CHECK_ACTIONS('${proc}')`,
  );
  return rows.map((r) => ({ action: r.ACTION, description: r.DESCRIPTION }));
}

export interface ViewValidateResult {
  /** 校验目标（运行时视图） */
  checked: { schema: string; viewName: string; action: string };
  /** 校验通过 */
  consistent: boolean;
}

/**
 * 校验已激活的计算视图（运行时一致性检查）：
 * - schema：运行时 schema，通常 _SYS_BIC（走白名单校验）
 * - viewName：运行时列视图名，形如 "包路径/视图名"（如 ZDEMO.ZDEMO_COF/CFZDEMO02_CV003）
 * - action：默认 CHECK_CONSISTENCY（GET_CHECK_ACTIONS 查得的唯一 calculationview 动作）
 *
 * 注意：本工具校验的是「激活后的运行时视图」，不校验设计时 XML。
 * 校验通过 = 视图一致（无异常）；失败 = 抛出 HanaBusinessError（含 CALCULATION ENGINE 错误细节）。
 */
export async function validateCalculationView(
  pool: HanaPool,
  schema: string,
  viewName: string,
  action = 'CHECK_CONSISTENCY',
): Promise<ViewValidateResult> {
  assertSchemaAllowed(schema);
  // 运行时名允许 /（_SYS_BIC 的 "包/视图" 形态）；值仍参数绑定
  if (!/^[A-Za-z0-9_$#./\-]+$/.test(viewName)) {
    throw new HanaBusinessError(`运行时视图名 "${viewName}" 含非法字符，已拒绝`);
  }
  // action 白名单：calculationview 相关仅 CHECK_CONSISTENCY（实测 GET_CHECK_ACTIONS 结论）
  const SAFE_ACTIONS = new Set(['CHECK_CONSISTENCY']);
  if (!SAFE_ACTIONS.has(action)) {
    throw new HanaBusinessError(
      `不支持的校验动作 "${action}"。calculationview 可用：${[...SAFE_ACTIONS].join(' / ')}（可用 hana_view_check_actions 查询完整清单）`,
    );
  }

  try {
    // 无 OUT 参数；成功即无异常返回
    await pool.callProcedure('CALL SYS.CHECK_CALCULATION_VIEW(?, ?, ?)', [action, schema, viewName], 0);
    return { checked: { schema, viewName, action }, consistent: true };
  } catch (e) {
    // CE 校验失败：向上转成带细节的业务错误（normalizeHanaError 保留 code/message）
    const norm = normalizeHanaError(e);
    throw new HanaBusinessError(
      `视图 ${schema}/${viewName} 一致性校验失败：${norm.message}`,
      norm.code,
      norm.sqlState,
    );
  }
}