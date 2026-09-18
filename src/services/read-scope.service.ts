/**
 * SQL 读取范围的最后一道校验（**服务层**，与工具层预检分工不同）。
 *
 * 分工：
 * - 工具层预检（src/tools/write-plans.ts 的规划器 + config/preflight.ts）负责**限定名**：
 *   扫描 `SCHEMA."表"` 后按 HANA_SCHEMA_ALLOW 判定，并把扫描盲区写进计划；
 * - 本模块负责**未限定表名**（`FROM MARA`）：它由 HANA 按当前用户的默认 schema 解析，
 *   扫描器无从得知，只能查 CURRENT_SCHEMA 再判。没有这一步时 `SELECT * FROM MARA`
 *   会完全绕过 HANA_SCHEMA_ALLOW。
 *
 * 为什么由调用方注入"怎么读当前 schema"：SQL 分析工具必须把这条查询放在**已持有的连接**上
 * （它的执行计划缓冲按连接隔离），不能走 pool.query 另取一条连接；存储过程那条路径则没这约束。
 * 判定规则本身只有一份，读法由调用方给。
 *
 * 从 repository.service 的 assertScriptReadScopes 提取而来（原先只有 SQL 模式视图在用），
 * 避免出现第二份"未限定表名"判定——两份实现漂移时，先被绕过的一定是边界。
 */

import { HanaBusinessError } from '../core/errors.js';
import { assertSchemaAllowed } from '../core/sql.js';
import { hasUnqualifiedTableRef } from '../write-plan.js';

/**
 * 读取当前用户默认 schema 的取数函数（注入：pool.query 或已持有连接上的 execOn）。
 * 返回空串表示取不到——此时不误拦（限定名扫描与写包边界仍在）。
 */
export type CurrentSchemaReader = () => Promise<string>;

/**
 * 语句含未限定表名且默认 schema 不在允许范围时抛错。
 *
 * @param sql 待校验语句（原样文本即可：判据是剥离字面量/注释后的表位置）
 * @param readCurrentSchema 取当前用户默认 schema
 * @param noun 报错里的主语（"脚本" / "语句"），影响可读性不影响判定
 */
export async function assertSqlReadScopes(
  sql: string,
  readCurrentSchema: CurrentSchemaReader,
  noun = '脚本',
): Promise<void> {
  if (!hasUnqualifiedTableRef(sql)) return;
  const schema = (await readCurrentSchema()) || '';
  if (schema === '') return;
  try {
    assertSchemaAllowed(schema);
  } catch {
    throw new HanaBusinessError(
      `${noun}含未限定 schema 的表名，按当前用户默认 schema "${schema}" 解析，而它不在服务端允许读取的范围内。` +
        '请把表名写成全限定名（SCHEMA."表"），或由部署方调整可读 schema 配置',
    );
  }
}
