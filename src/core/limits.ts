/**
 * 并发与超时的默认值（P5 §4.3/§4.6）：单一事实源。
 *
 * 为什么单独一个**无依赖**的叶子模块：这些数值同时被三处引用——
 * ① config.ts 的 zod `.default(...)`（配置未填时的取值）、② 各核心模块自身的兜底
 * （构造器/函数签名默认值）、③ 单元测试的期望值。分散写三遍时，改一处就会出现
 * 「配置默认值 ≠ 运行时兜底值」的分叉，而这类分叉只在某个部署少配一项时才暴露。
 *
 * 不做成 config.ts 的导出：core/* 反向依赖 config 会连出运行期循环
 * （config.ts 已 import core/xs-rest.js 的 XS_BASE_PATH），且会把 @sap/hana-client
 * 原生驱动拖进只读探针脚本的加载路径。本模块只放常量，不 import 任何东西。
 */

/** HANA 连接池并发上限（HANA_POOL_MAX）：池位 = 到数据库的连接数，N 个代理进程 = N×该值 */
export const POOL_MAX_DEFAULT = 4;

/** 池满时的排队上限（HANA_POOL_MAX_WAITERS）：超出立即失败，防请求无限堆积 */
export const POOL_MAX_WAITERS_DEFAULT = 64;

/** 池排队等待超时 ms（HANA_POOL_WAIT_MS）：到时仍未获得连接即失败 */
export const POOL_ACQUIRE_TIMEOUT_MS_DEFAULT = 30_000;

/**
 * 写路径 SQL 语句超时 ms（HANA_SQL_TIMEOUT_MS）。
 * **只给写路径的五条语句**（存在性检查/兜底直写/行探测/影响半径的下游查询/REPOSITORY_REST 调用）设限——
 * 不设全局默认是有意的：`hana_sql_analyze analyze=true`（最长 5 分钟）与元数据搜索（5–30s）
 * 都是合法的长语句，全局超时会把它们误杀。
 */
export const SQL_TIMEOUT_MS_DEFAULT = 60_000;

/** XS REST 请求默认超时 ms（HANA_XS_TIMEOUT_MS）：覆盖走 request() 出口的**全部**调用（含读内容/读元数据） */
export const XS_TIMEOUT_MS_DEFAULT = 30_000;

/** XS REST 传输（xfer 导入/导出）超时 ms（HANA_XS_XFER_TIMEOUT_MS）：整包上传/下载天然慢 */
export const XS_XFER_TIMEOUT_MS_DEFAULT = 300_000;

/**
 * 登录/取 CSRF token 的超时 ms（无 env 旋钮）：这两步只碰 XS 登录端点，
 * 与写动词共用 30s 默认值会在登录端挂死时白等 30s；短超时让"连不上"更快暴露。
 */
export const XS_LOGIN_TIMEOUT_MS = 10_000;

/**
 * 激活并发上限（HANA_ACTIVATION_CONCURRENCY）：**所有会触发服务端激活的写**（create/update/activate/validate
 * 的文件写）共享的并发上限。为什么不是「仅 activate=true 的写」：本 SPS 写入即激活（实测任何合法 PUT 都
 * 触发服务端激活，activate 参数只决定失败是否透出），只按参数限流拦不住并发激活。激活是重操作
 * （2–10s/次），多代理下不限流会互相打爆（XS 会话 / 仓库激活队列 / CPU）。
 */
export const ACTIVATION_CONCURRENCY_DEFAULT = 2;

/**
 * 激活信号量名（keyed lock 管"同对象"，信号量管"全局并发"，两者不可互相替代）。
 * 已声明的两个已知边界（逐条写明，不用含糊的「等」）：
 * - xfer 导入通道有意不取；
 * - createPackage（POST 建包）与 deleteFile（DELETE）不在覆盖内（无实测证据表明它们触发服务端激活）。
 */
export const ACTIVATION_SEMAPHORE = 'hana-activation';

/** keyed lock 排队等待超时 ms（withKeyedLock 的 waitMs 默认值；到点即拒——超时者立刻失败且 fn 永不执行） */
export const LOCK_WAIT_MS_DEFAULT = 60_000;

/** 信号量排队等待超时 ms（与 keyed lock 同形态、同量级） */
export const SEMAPHORE_WAIT_MS_DEFAULT = 60_000;

/*
 * 异步任务（工具化任务 API，2026-10-10）：进程内注册表的三个边界值。
 * 单一事实源同款：此处是唯一常量落点（task-registry 引用、单测引用，不各写一份）。
 */

/** 同时运行的异步任务上限：超出的提交被拒（长批次各占激活信号量，不限并发会互相饿死） */
export const TASK_MAX_RUNNING_DEFAULT = 4;

/** 终态任务（completed/failed/cancelled）的保留时长 ms：到期在后继提交时被清理（惰性清扫，无定时器） */
export const TASK_TTL_MS_DEFAULT = 30 * 60_000;

/** 注册表容量上限（含运行中）：装满时从最旧的终态任务开始淘汰 */
export const TASK_MAX_RETAINED_DEFAULT = 100;
