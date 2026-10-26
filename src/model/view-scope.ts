/**
 * 仓库对象的版本视角（只读元数据/血缘的数据源选择）。
 *
 * - active（默认，兼容既有行为）：`_SYS_REPO.ACTIVE_OBJECT` / `ACTIVE_OBJECTCROSSREF` —— 已激活版本；
 * - inactive：`_SYS_REPO.INACTIVE_OBJECT` / `INACTIVE_OBJECTCROSSREF` —— 未激活/有挂起改动的版本。
 *
 * 语义边界（实测 SPS08）：
 * - inactive 只对**有挂起改动**的对象存在；对象已全部激活时没有 inactive 行，查询按「未找到」处理，
 *   不会回退去读 active（默认口径始终是 active，显式要 inactive 就只读 inactive）；
 * - 两张 crossref 列结构一致（FROM_/TO_PACKAGE_ID、OBJECT_NAME、OBJECT_SUFFIX、REF_TYPE），
 *   未激活对象的上游引用已在 `INACTIVE_OBJECTCROSSREF` 中登记（实测有数据）。
 *
 * 本模块是叶子模块：metadata.service 与 catalog.service 都要用表名映射，而两者互为依赖方向
 *（metadata → catalog 的 closure），把映射放在任何一方都会形成环。
 */

/** 版本视角 */
export type VersionScope = 'active' | 'inactive';

/** 对象定义表（CDATA 所在表） */
export const OBJECT_TABLE: Record<VersionScope, 'ACTIVE_OBJECT' | 'INACTIVE_OBJECT'> = {
  active: 'ACTIVE_OBJECT',
  inactive: 'INACTIVE_OBJECT',
};

/** 对象交叉引用表（血缘数据源） */
export const CROSSREF_TABLE: Record<VersionScope, 'ACTIVE_OBJECTCROSSREF' | 'INACTIVE_OBJECTCROSSREF'> = {
  active: 'ACTIVE_OBJECTCROSSREF',
  inactive: 'INACTIVE_OBJECTCROSSREF',
};
