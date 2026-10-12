import type { HanaPool } from '../core/hana-client.js';
import { HanaBusinessError, normalizeHanaError } from '../core/errors.js';
import { assertSafeRuntimeName, assertSchemaAllowed } from '../core/sql.js';

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

/**
 * 允许作为校验目标的 CHECK 过程清单（防注入：仅 SYS 下 CHECK_* 系过程）。
 *
 * 单一事实源：hana_view_check_actions 的参数枚举（capabilities/defs/modeling.ts）与规划器
 * 兜底默认值都由它派生——清单两处手写时，schema 放行的值可能被服务层以中文硬错误拒绝。
 */
export const CHECK_PROCEDURES = [
  'CHECK_CALCULATION_VIEW',
  'CHECK_CATALOG',
  'CHECK_CALCENGINE',
  'CHECK_TABLE_CONSISTENCY',
  'CHECK_TOPOLOGY_TREE',
  'CHECK_ES',
  'CHECK_CALCULATION_MODEL',
  'CHECK_ANALYTICAL_MODEL',
] as const;

const SAFE_CHECK_PROCEDURES = new Set<string>(CHECK_PROCEDURES);

/** GET_CHECK_ACTIONS：查询某 CHECK 过程支持的全部 ACTION 与说明 */
export async function getCheckActions(pool: HanaPool, checkProcedureName: string): Promise<CheckAction[]> {
  // 白名单只做存在性判定（大小写不敏感）；CALL 用清单里的原值，不接受调用方任意字符串
  const upper = checkProcedureName.toUpperCase();
  const proc = SAFE_CHECK_PROCEDURES.has(upper) ? upper : undefined;
  if (!proc) {
    throw new HanaBusinessError(`不支持的 check 过程 "${checkProcedureName}"。可用：${CHECK_PROCEDURES.join(' / ')}`);
  }
  // CALL 返回结果集（table 输出），走 query 通道
  const rows = await pool.query<{ ACTION: string; DESCRIPTION?: string }>(`CALL SYS.GET_CHECK_ACTIONS('${proc}')`);
  return rows.map((r) => ({ action: r.ACTION, description: r.DESCRIPTION }));
}

export interface ViewValidateResult {
  /** 校验目标（运行时视图） */
  checked: { schema: string; viewName: string; action: string };
  /** 校验通过 */
  consistent: boolean;
}

/**
 * 判定错误属于"校验根本没执行"的基础设施侧（连接失败 / 池满排队超时），而不是校验过程给出的结论。
 *
 * 只认确定性的基础设施特征，不做大面积猜测：
 *  - 连接池的三处抛出（队列满 / 排队超时 / 建连失败，见 core/hana-client.ts）都不带错误码，
 *    消息形如「HANA 连接池…」；
 *  - 驱动层传输错误带负数错误码（如 -10709 建连失败）或 ETIMEDOUT / ECONNRESET 等网络特征。
 * 命中即由调用方加机读码 VALIDATE_INFRA；CE 校验错误（有 HANA 错误码、消息不是连接/池特征）
 * 仍按"一致性校验失败"归。
 */
function isInfraFailure(e: HanaBusinessError): boolean {
  const code = e.code ? Number(e.code) : Number.NaN;
  if (Number.isFinite(code) && code < 0) return true;
  return /连接池|等待队列已满|连接超时|等待超时|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EPIPE|socket hang up|hdbpipe|Connection failed/i.test(
    e.message,
  );
}

/**
 * 校验已激活的计算视图（运行时一致性检查）：
 * - schema：运行时 schema，通常 _SYS_BIC（走白名单校验）
 * - viewName：运行时列视图名，形如 "包路径/视图名"（如 ZDEMO.ZDEMO_COF/CFZDEMO02_CV003）
 * - action：默认 CHECK_CONSISTENCY（GET_CHECK_ACTIONS 查得的唯一 calculationview 动作）
 *
 * 注意：本工具校验的是「激活后的运行时视图」，不校验设计时 XML。
 * 校验通过 = 视图一致（无异常）；失败 = 抛出 HanaBusinessError（含 CALCULATION ENGINE 错误细节）；
 * 基础设施故障（连接/池满）未执行校验时抛出 code='VALIDATE_INFRA' 的错误——调用方据机读码区分
 * "视图真的不一致"与"这次根本没跑"（后者去修视图是白费功夫）。
 */
export async function validateCalculationView(
  pool: HanaPool,
  schema: string,
  viewName: string,
  action = 'CHECK_CONSISTENCY',
): Promise<ViewValidateResult> {
  assertSchemaAllowed(schema);
  // 运行时名允许 /（_SYS_BIC 的 "包/视图" 形态）；值仍参数绑定。
  // 字符集与错误文案统一走 core/sql（原先这里是 SAFE_RUNTIME_NAME_RE 的手抄副本，两份会漂移）
  assertSafeRuntimeName(viewName, '运行时视图名');
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
    // 先分类再包装：只有"校验真的跑了并给出不一致"才叫一致性校验失败。
    // 连接/传输类故障下"没跑起来"不能与"视图不一致"共用一个文案与机读码——
    // 否则调用方（尤其是模型）会照着"视图有问题"去改一个本身没问题的视图。
    const norm = normalizeHanaError(e);
    if (isInfraFailure(norm)) {
      throw new HanaBusinessError(
        `视图 ${schema}/${viewName} 一致性校验未执行（连接/资源故障，不是视图不一致）：${norm.message}`,
        'VALIDATE_INFRA',
        norm.sqlState,
      );
    }
    throw new HanaBusinessError(`视图 ${schema}/${viewName} 一致性校验失败：${norm.message}`, norm.code, norm.sqlState);
  }
}
