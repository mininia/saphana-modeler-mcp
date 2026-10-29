# 开发约定

本文件记录本仓库的代码约定。**新增代码请照此写**；这些约定不是审美偏好，每一条后面都写着"不这么做会出什么问题"。

## 检查命令

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 类型检查。**同时承担死代码检测**：`noUnusedLocals` / `noUnusedParameters` 会拦下未使用的导入与变量 |
| `npm run check:tool-names` | 工具名一致性守卫：instructions / 规则库 / 描述里的 `hana_*` 必须是清单里登记的能力（改名的漂移在这里红） |
| `npm test` | 单元测试（1000+ 项；测试文件在本地 `tests/`，不入库，见下） |
| `npm run check` | 工具名守卫 + 类型检查 + 单测（提交前跑这个） |
| `npm run format` | Prettier 格式化（`format:check` 只检查不写） |

> 开发与检查要求 Node >= 22.0.0（与 package.json 的 engines 下限一致；启动期校验只比较 major.minor，即 >= 22.0 放行、patch 位不受校验，见 `core/node-version.ts`）。不要用 Node 20：它已 EOL，而且 npm 在 Windows 固定用 cmd.exe 执行脚本、cmd 不展开 glob，Node 20 的 --test 也不展开（报 Could not find 或静默 0 用例）；`pretest` 用到的 `fs.globSync` 也要 22+。

`tests/` 与 `test-verification/` 均不入库（列在 `.gitignore`）：克隆后本地没有测试文件，`npm test` 需自备 `tests/` 才能跑；`verify:*` / `probe:*` 仅在保留本地实机脚本的环境可用，且需要真实 HANA 连接，不在常规检查范围内。

## 打包与发布

- 产出发布件一律用 `npm run release:pack`：先 `npm run build`，再用 `npm pack --dry-run --json` 断言 `dist/index.js` 在打包清单中，最后才 `npm pack` 产出 tarball。
- 禁止走 `--ignore-scripts` 类打包路径（npm pack / npm publish --ignore-scripts）：会跳过 `prepare`（= `npm run build`），静默产出只含 LICENSE/README/package.json 的无代码空壳包——装得上、跑不了。

### 发布检查清单（每次发版逐项勾）

- [ ] `CHANGELOG.md` 有本次条目——**提交前**补到当前版本段（不设 Unreleased），每条 1–3 行，只写对外可见变化；
- [ ] `npm run check` 全绿（含 `check:tool-names`、类型检查、单测；测试文件在本地 `tests/`，CI 环境需自备）；
- [ ] `npm run format:check` 通过；
- [ ] 版本号 bump（`package.json`；`src/version.ts` 从它读取，不要另改）；
- [ ] **工具面变化**：新增/删除/改名的工具写明 old → new 映射，并在 `scripts/check-tool-names.mjs` 的 `REMOVED_TOOL_NAMES` 留档（若删名后仍有旧引用）；
- [ ] **schema 变化**：入参/回执字段的增删改在 CHANGELOG 标注「客户端需重连」；
- [ ] **行为变化**：截断口径（`resultInfo`）、空集语义（`empty`）、审计终态（`denied/completed/failed`）的变化必须写；
- [ ] 面预算通过（`tests/unit/surface-budget.test.ts`：能力数 / tools/list 字节 / 单条描述 / 规则库字节）；
- [ ] `npm run release:pack` 产出 tarball，并确认打包清单含 `dist/index.js`；
- [ ] 可选：npm `latest` / `next` 双 dist-tag（预发用 `next`，验收后提升到 `latest`）。

## 工具链

- **Prettier**：`.prettierrc.json`，printWidth 120、单引号、分号、`endOfLine: auto`。格式问题不用手改，交给 `npm run format`。
- **没有 ESLint**：`@typescript-eslint/parser` 目前 peer 要求 `typescript <6.1.0`，而本项目用 TS 7（Go 原生版，`typescript` 包已不含经典 JS API），装不上。因此 lint 的职责这样分摊：
  - 格式 → Prettier
  - 未使用变量/导入、隐式覆盖（漏写 `override`）、switch 穿透 → `tsconfig.json` 的 `noUnusedLocals` / `noUnusedParameters` / `noImplicitOverride` / `noFallthroughCasesInSwitch`
  - `console.*` → 靠约定与 code review（MCP stdio transport 独占 stdout，日志必须走 logger，见下）

## 分层与依赖方向

```
types ← core ← model ← services ← tools ← server ← index
              ↖ config
```

- **依赖只能从左指向右**（`core` 不得 import `config`，`model` 不得 import `services`）。`import type` 边不受此限：类型导入在编译期擦除，不构成运行时依赖（`core/hana-client.ts`、`core/xs-rest.ts` 以 `import type` 反向引用 `config/config.js` 的 `HanaConfig` 即此类）——即「`core` 不得 import `config`」的准确口径是「不得 import `config` 的运行时值」。`core/logger.ts` 曾反向 import `config/config.js` 只因需要一个时区默认值 —— 该常量已下移到 `core/datetime.ts`。
- **已登记的例外**：`model/view-cache.ts` 与 `services/metadata.service.ts` 互相 import（前者取视图定义与 VERSION_ID 做缓存与版本校验，后者复用该缓存），是本仓库唯一一处 `model` 反向依赖 `services` 的运行时边，已登记在 `tests/unit/import-cycles.test.ts` 的环白名单里。两侧的导入值都只在函数体内使用、ESM 求值期不互相解引用，环才能成立；改动任一侧前先读 `model/view-cache.ts` 头注。
- `config/` 依赖 `core/`，不依赖 `services/`。
- `config/write-boundary.ts` 刻意是**纯叶子模块**（不 import 本项目任何模块），供 config 校验、启动流程、实机脚本共用同一份判定规则。

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

| 做什么 | 唯一的家在 |
| --- | --- |
| 结果截断 / 空集语义（`resultInfo`、`empty`） | `core/result-info.ts`（服务层 `attach*`，信封在 `core/errors.ts` 提升） |
| 写能力终态审计（`denied/completed/failed`） | `config/authorize.ts` 的 `dispatchAuthorized`（两条入口共用） |

## 注册期 / 调用期分层（不要合并）

- **注册期**（`tools/surface.ts` 的 `computeSurface`）只决定**呈现**：哪些工具进 `tools/list`、门面索引列什么、哪些可路由。它**不做授权结论**，也不产生"已授权"状态。
- **调用期**（`config/authorize.ts` 的 `authorizeCall`）决定**调用成不成立**：能力级（分组/deny/档案）+ 资源级（写包/读 schema）+ 部署级。门面路由、提升后平铺直调、直接工具调用**三条入口必须都经过它**（由 `dispatchAuthorized` 统一执行）。
- 典型反例：把"写包不在 `HANA_WRITE_PACKAGES`"塞进 `computeSurface`。那样能力会从工具面消失，模型只能看到"没有这个工具"，而拿不到资源边界的拦截报告；且 HTTP 每请求重建面后，同一配置下不同请求的"工具存不存在"会漂移。**资源判定永远在调用期**。
- 防退化测试：`tests/unit/contract-layers.test.ts`（面内但越界仍被拒、三条入口同文案、deny 不出现在索引、注册面恒为六个门面）。

## 文档的分层（单一事实源）

| 层 | 写什么 | 不写什么 |
| --- | --- | --- |
| `SERVER_INSTRUCTIONS`（`src/server.ts`） | 骨架：服务是什么、引用约定、工具两层、写操作一句话、envelope、规则库指针 | 方言细节、参数语义、踩坑长文 |
| 工具 `description`（`capabilities/defs/*.ts`） | 一句话定位 + 选择指引 + `rules=<id>` 指针 | 规则正文的复述 |
| `src/rules/*.rules.ts` | **唯一详细正文**：方言、边界、通道、回执、为什么 | — |

**新细节只能进规则库**；`description` / instructions 只留指针。理由：常驻文本的成本按会话计，而规则库按需查询。改完跑 `npm run check:tool-names` 与面预算测试（`tests/unit/instructions-budget.test.ts`、`surface-budget.test.ts`）。

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

写路径（`hana_view_*` / `hana_package_create` / `hana_repo_import` 等）已有实机验证与硬边界。改动前先跑 `hana-write-preflight` 预检（按 `HANA_WRITE_PACKAGES` / `HANA_TOOL_GROUPS` / `HANA_READ_SCHEMA` 判定），不要绕过。

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
