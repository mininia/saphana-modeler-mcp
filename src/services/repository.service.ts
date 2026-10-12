/**
 * 仓库写服务：
 * - REPOSITORY_REST：SYS.REPOSITORY_REST(IN BLOB, OUT BLOB) —— Studio 同款仓库 REST 通道（首选）
 *   协议（实测 + SAP-archive/xsk 开源佐证）：IN/OUT 均为 repoV2 二进制信封 ——
 *     "repoV2"(6B ASCII) + attachmentCount(4B 小端, = 附件区**实际序列化记录数**) + contentLength(4B 小端, JSON 字节数)
 *     + JSON UTF-8 + 附件区（每条 [4B 小端长度][内容]；写对象时 = [名称槽, 内容槽] 共 2 条；读对象时 XML 在槽 0）。
 *     头部 count 与记录数必须一致：旧式 `1 + 文件数 × 2` 会多报（实测报 Transporter.consume），修法见 repositoryRest。
 * - INACTIVE_OBJECT 直写：兜底（实测 SAPABAP1 无直写权限，实际不可用，保留供有权限账号参考）。
 * 安全护栏：写操作的包名边界由 HANA_WRITE_PACKAGES 配置（**两层口径**：空白名单在本判定层 fail-open、
 * 不限制；端到端空白名单 = 声明写包的调用被运行期闸门以 boundary_off 拒绝，详见 config/write-boundary.ts 文件头），
 * 对象名校验，凭据不落日志。
 *
 * 并发（锁序不变量，任何新写路径必须遵守）：
 * - **全局锁序写死：keyed lock → 信号量 → 网络/DB**。任何新写路径不得反向获取，否则构成锁序反转
 *   （T1 持信号量等锁、T2 持锁等信号量 = 死锁）。
 * - **锁不可重入**：withKeyedLock 对同一 key 是排队串行、不是可重入锁——持锁期间不得再取同一把锁。
 * - 五条写路径（create / update / activate / delete / import，另加 validate 的临时副本流程）对同一对象
 *   统一使用 writeLockKey(packageId, normalizeObjectName(objectName)) 同一把锁。
 */

export {
  configureWritePackages,
  assertWritePackageAllowed,
  normalizeObjectName,
  updateViaRest,
} from './repo-transport.service.js';
export type { RepoRestResponse, ActivationDetail } from './repo-transport.service.js';
export {
  createPackageViaRest,
  exportPackageViaRest,
  importObjectViaRest,
  listChangesViaRest,
} from './repo-transfer.service.js';
export type { ExportPackageResult, ImportObjectResult } from './repo-transfer.service.js';
export {
  DEFAULT_PROBE_ROWS,
  MAX_PROBE_ROWS,
  probeRuntimeRows,
  updateCalculationView,
  assessDeletionGate,
  deleteCalculationView,
  createCalculationView,
  activateCalculationView,
  TEMP_CHECK_NAME_MAX,
  tempCheckName,
  tempCheckNameWithNonce,
  resetTempCheckRegistry,
  checkCalculationViewDesignTime,
} from './view-write.service.js';
export type {
  CreateCalcViewInput,
  RowProbe,
  CreateCalcViewResult,
  AddJoinOperation,
  SetScriptOperation,
  SetDescriptionOperation,
  ViewUpdateOperation,
  RenameFieldOperation,
  DropFieldOperation,
  AddCalculatedColumnOperation,
  SetAttributeFilterOperation,
  SetVariableOperation,
  AddJoinOperationResult,
  SetScriptOperationResult,
  SetDescriptionOperationResult,
  RenameFieldOperationResult,
  DropFieldOperationResult,
  AddCalculatedColumnOperationResult,
  SetAttributeFilterOperationResult,
  SetVariableOperationResult,
  AppliedOperationResult,
  MigrationGateRecord,
  DryRunReport,
  UpdateCalculationViewResult,
  DeletionGateAssessment,
  DeleteCalculationViewResult,
  ActivateCalculationViewResult,
  DesignCheckResult,
} from './view-write.service.js';
export { changesetPartialError, applyChangeset } from './changeset.exec.js';
export type { ChangesetReportItem, ChangesetNotExecutedItem, ChangesetReport } from './changeset.exec.js';
