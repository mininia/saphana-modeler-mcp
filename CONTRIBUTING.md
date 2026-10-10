# 开发约定

本文件记录本仓库的代码约定。**新增代码请照此写**；这些约定不是审美偏好，每一条后面都写着"不这么做会出什么问题"。

## 检查命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 类型检查。**同时承担死代码检测**：`noUnusedLocals` / `noUnusedParameters` 会拦下未使用的导入与变量 |
| `npm test` | 单元测试（483+ 项） |
| `npm run check` | 上面两个一起跑（提交前跑这个） |
| `npm run format` | Prettier 格式化（`format:check` 只检查不写） |

实机验收脚本（`verify:*` / `probe:*`）需要真实 HANA 连接，不在常规检查范围内。

## 工具链

- **Prettier**：`.prettierrc.json`，printWidth 120、单引号、分号、`endOfLine: auto`。格式问题不用手改，交给 `npm run format`。
- **没有 ESLint**：`@typescript-eslint/parser` 目前 peer 要求 `typescript <6.1.0`，而本项目用 TS 7（Go 原生版，`typescript` 包已不含经典 JS API），装不上。因此 lint 的职责这样分摊：
  - 格式 → Prettier
  - 未使用变量/导入、隐式返回、switch 穿透 → `tsconfig.json` 的 `noUnusedLocals` / `noUnusedParameters` / `noImplicitOverride` / `noFallthroughCasesInSwitch`
  - `console.*` → 靠约定与 code review（MCP stdio transport 独占 stdout，日志必须走 logger，见下）

## 分层与依赖方向

```
types ← core ← model ← services ← tools ← server ← index
              ↖ config
```

- **依赖只能从左指向右**（`core` 不得 import `config`，`model` 不得 import `services`）。`core/logger.ts` 曾反向 import `config/config.js` 只因需要一个时区默认值 —— 该常量已下移到 `core/datetime.ts`。
- `config/` 依赖 `core/`，不依赖 `services/`。
- `core/write-boundary.ts` 刻意是**纯叶子模块**（不 import 本项目任何模块），供 config 校验、启动流程、实机脚本共用同一份判定规则。

## 错误处理

| 场景 | 用什么 | 为什么 |
| --- | --- | --- |
| HANA/业务错误（可归因、调用方可据此修正） | `throw new HanaBusinessError(message, code)` | 经 `withErrorEnvelope` 变成 `success:false` + `messages[]`，原因能到达调用方 |
| 参数非法 / 对象不存在等不可恢复错误 | 返回 `mcpErrorText(message, hint)` | MCP 硬错误 + 恢复提示，把死胡同变成下一步 |
| 未知异常 | 由 `withErrorEnvelope` 兜底 | 对外只给「内部错误，详情见服务端日志」，细节留在日志 |

**不要抛裸 `Error`**。裸 `Error` 会被 `withErrorEnvelope` 归入"未知错误"，调用方只看到「内部错误」——`schema 不在允许列表`、`对象名含非法字符` 这类**可操作**的原因会被整体吞掉。`core/sql.ts` 的断言因此全部抛 `HanaBusinessError`。

## 公共实现只有一份

"同一件事两处实现"是本仓库最需要防的问题：两处都是"对的"，但会漂移，而漂移的表现是**同一份数据在不同工具里给出不同结论**（回执说 3 个度量、XML 里 5 个），排查成本极高。

| 做什么 | 唯一的家在 |
| --- | --- |
| 数值归一 `num` / 舍入 `round` / 字节常量 / 微秒换算 | `core/num.ts` |
| 文本列表解析 `splitList` / 截断 `truncateWithNote` | `core/text.ts` |
| 错误码 → 成因（`classifyHanaError` 等） | `core/hana-errors.ts` |
| SQL 标识符转义、schema 白名单、对象名字符集 | `core/sql.ts` |
| XML 解析/构造选项、`escapeXmlAttr` | `core/xml.ts` |
| 时间格式化、默认时区 | `core/datetime.ts` |
| 视图数值类型表、`isNumericType` | `model/view-types.ts` |
| 仓库写边界判定 | `config/write-boundary.ts`（纯叶子） |
| 工具分组登记表 | `capabilities/defs/*.ts`（能力清单，**唯一事实源**；`tools/groups.ts` 从它派生） |
| 工具入参 schema 片段（包名/对象名/视图类型） | `capabilities/schemas.ts` |
| 写调用规划器（会读写什么） | `capabilities/planners.ts`（在清单条目里以 `effects.plan` 声明） |
| 调用期授权闸门 | `config/authorize.ts`（**所有能力**过同一个闸门；资源维度由清单的 `effects.plan` 决定） |

**注意"看起来一样但语义不同"的情况，不要合并**。例如 `core/num.ts` 的 `num`（空值→0）与 `sql-analyze.service` 的 `num`（非数→`undefined`，用于区分"没有值"和"值为 0"）语义不同，合并会引入静默的 `NaN`/`0` 变化。同理 `core/hana-errors.ts` 里几个错误码集**刻意不统一**：不同调用点的码集差异是策略差异，用参数化暴露出来，而不是合并成一个大集合悄悄改变行为。这类"不可合并"的地方都在代码里写了理由。

## 日志

- 一律走 `core/logger.ts` 的 `logger`，输出到 **stderr**（stdio transport 独占 stdout，`console.log` 会污染协议通道）。
- 统一签名：`logger.warn({ 结构化字段 }, '中文消息')`。敏感值（密码/Token/Authorization/连接目标）由 logger 的 redact + `redactSensitive` 双层兜底，但**不要主动把凭据放进字段**。
- 降级与吞异常必须留痕：诊断类代码里"没读到"和"读到 0"是两回事，静默 catch 会让报告少一块而无人察觉。

## 配置

- 环境变量统一在 `config/config.ts` 的 `envSchema` 里声明、校验、给默认值。**其它模块不得直接读 `process.env`**（`core/logger.ts` 是唯一例外：它必须在 `loadConfig` 之前可用，故先用 env 兜底，再由入口调 `applyLoggerConfig` 换成已校验的值）。
- 安全边界类项（TLS、Token、Host/Origin 白名单、写包边界、工具分组、schema 白名单）**默认值一律 fail-closed**，不因便利而放松。
- 非法配置在**启动时**失败并给出修复指引，不要留到运行期才暴露。

## 模块内约定

- 导出函数用 `function` 声明（便于 hoisting 与一致的 JSDoc 位置）；内部小工具可用箭头函数。
- 导出符号一律带 JSDoc：首行一句话摘要 + 需要时 `@param` / `@returns`。
- import 顺序：`node:` 内置 → 第三方包 → `core`/`config` → 同级，组内按字母序；相对导入一律带 `.js` 后缀。
- 公开函数的返回值类型**要命名**，不要用匿名结构。
- 模块级可变状态（如 `core/sql.ts` 的追加 schema、`core/keyed-mutex.ts` 的锁表、`model/view-cache.ts` 的缓存）必须配一个显式的重置/清空入口，供测试隔离使用。

## 涉及 HANA 写路径时

写路径（`hana_view_*` / `hana_package_create` / `hana_repo_import` 等）已有实机验证与硬边界。改动前先跑 `hana-write-preflight` 预检（按 `HANA_WRITE_PACKAGES` / `MCP_TOOL_GROUPS` / `HANA_SCHEMA_ALLOW` 判定），不要绕过。

## 新增一个能力时（三件"税"）

1. **清单**：在 `src/capabilities/defs/<分类>.ts` 加一条（`id` / `category` / `kind` / `effects` / `title` / `description` / `inputSchema` / `annotations`；`facadeOf` 只给六个分类门面）。
   **资源形参要用带角色的构造器**：写目标包 `zWritePackageId(...)`、只读引用的包 `zReadPackageId(...)`、
   只读 schema `tagResource(z.string()…, 'readSchema')`（**必须包在最外层**——`.optional()`/`.describe()` 会换掉对象）。
   资源维度由此**自动成立**；`effects.plan` 只用来补参数声明表达不了的东西：分支叙述、`uncertain`、嵌套结构（`operations[]`）
   与文本扫描（SQL/XML/脚本）。会写仓库包的能力**必须**有其中之一（测试强制）；
   混合模式的参数（如 `hana_view_validate.packageId`：design 写、runtime 不写）**不要打无条件标签**，交给规划器按模式声明。
   **忘了登记 = 能力不暴露也不可调用**（fail-closed），`tests/unit/capability-manifest.test.ts` 会拦。
2. **注册**：在对应 `src/tools/<模块>.tools.ts` 里 `regCap(CAP.<id>, handler)`——注册名、schema、描述、注解都从清单取，模块里只写 handler。
3. **闸门**：不需要做任何事。所有能力都经 `capabilityRegistrar` → `config/authorize.ts` 的 `authorizeCall`；
   **不要在工具模块里自己判权限**（那会绕开「多入口、单闸门」这条不变量）。判定结果由策略层出，报告由 `preflight.ts` 出一份。
