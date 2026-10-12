import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { hasValue, isEnvTrue, tryLoadDotEnv, type HanaConfig } from './config.js';
import {
  DEFAULT_HTTP_HOST,
  DEFAULT_SSL_VALIDATE,
  DEFAULT_TLS,
  checkDeploymentInvariants,
  type DeploymentInvariant,
  type DeploymentPosture,
} from './deployment.js';
import { isPackageAllowed, isValidPackagePrefix, WRITE_BOUNDARY_CODES } from './write-boundary.js';
import { BLOCKED_PREFIX } from '../core/errors.js';
import { isSchemaAllowedWith } from '../core/sql.js';
import { splitList } from '../core/text.js';
import {
  ALL_TOOL_GROUPS,
  parseToolFilter,
  shouldRegisterTool,
  TOOL_GROUPS,
  type ToolFilterConfig,
} from '../tools/groups.js';
import { CONCRETE_CAPABILITY_IDS, findCapability, planFor } from '../capabilities/manifest.js';
import { describeProfiles, matchedCapabilities, type CallerProfile } from './profiles.js';
import { resolveEnvAliases } from './config.js';

/**
 * 权限策略层 —— 能力级 + 资源级两类权限的唯一判定入口。
 *
 * ## 两个权限级功能
 *
 * | 维度 | 管什么 | 配置项 | 参考 |
 * |---|---|---|---|
 * | **能力级** | 哪些工具对外暴露 | MCP_TOOL_GROUPS / ALLOW / DENY | tableau 的 INCLUDE/EXCLUDE_TOOLS（组展开）；dataworks 的 TOOL_CATEGORIES/NAMES |
 * | **资源级** | 能操作哪些资源 | HANA_WRITE_PACKAGES（可写包）/ HANA_SCHEMA_ALLOW（可读 schema） | tableau 的 BoundedContext；dataworks 交给平台 |
 * | （部署级） | 连接侧约束，非任务级 | HANA_TLS / MCP_HTTP_* | —— 两家的 Config 构造期 fail-closed |
 *
 * ## 结构
 *
 * ```
 *   规则叶子（纯函数，零 I/O）          本层                            调用方
 *   ─────────────────────────         ──────────────────────          ──────────────
 *   write-boundary.ts  写包规则   ┐
 *   sql.ts             schema规则 ├─→ checkResource()   ┐
 *   groups.ts          工具规则   ──→ checkCapability() ├─→ runPreflight()  → Verdict
 *   deployment.ts      姿态规则   ──→ checkDeployment() ┘   describePolicy()
 *                                                         ↑
 *                             resolvePolicy(source) ───────┘
 *                             （从 env / mcp.json / 已加载 config 取出生效值）
 * ```
 *
 * 判定器统一签名 `(policy, 请求) → Grant[]`：每个维度一个纯函数，互不知道对方存在，
 * 由入口组合。新增一个权限维度 = 加一个 `check*`，不动其它维度。
 *
 * 为什么必须收成一层的核心原因：生效值取决于**启动来源**，同一台机器上三处配置
 * （客户端 mcp.json 的 env / 仓库 .env / 进程环境变量）可能给出三个不同答案，且凭据三件套
 * 齐备时服务器会整个跳过 .env。「从哪读」和「怎么判定」散在各调用方，就会各判各的、谁都拦不住。
 */

// ── 一、策略模型 ──────────────────────────────────────────────

/** 生效的权限策略：一次判定所需的全部约束 */
export interface Policy {
  /** 能力级：哪些工具对外暴露 */
  capability: ToolFilterConfig;
  /** 资源级：能操作哪些资源 */
  resource: {
    /**
     * 可写包前缀（大写；空数组 = 写边界未启用——声明写包的写请求会被闸门以 boundary_off 拒绝，
     * 只有服务层 assertWritePackageAllowed 那一层是 fail-open，见 checkResource）
     */
    writePackages: string[];
    /** 可读 schema 的追加项（系统 schema 恒可读，不在此列） */
    schemaAllow: string[];
  };
  /** 部署姿态：连接侧约束（非任务级，见 checkDeployment） */
  deployment: DeploymentPosture;
  /**
   * 调用方档案表（仅服务进程路径有值，脚本/CLI 的 env 路径为 undefined）。
   * 只参与**配置自检**（checkProfiles）与调用期授权（authorize.ts），不改注册期可见性。
   */
  profiles?: ReadonlyMap<string, CallerProfile>;
  /** 这份策略的来源（人类可读，供日志/报告归因） */
  source: string;
}

/** 缺省部署姿态：stdio、仅本机、加密且校验证书（即无任何部署级风险）。
 *  三个安全默认值取自 deployment.ts 的常量（与 config 的 zod 默认值同一份，
 *  保证"判定用的默认值 = 运行用的默认值"）。
 *  例外：xsPlaintext 是 XS 写通道的事实默认（缺省明文，仅 HANA_XS_TLS=true 才切 https，见
 *  core/xs-rest.ts），不属"安全默认值"，须持续告警直到部署方显式加密该通道。 */
export const SAFE_DEPLOYMENT_POSTURE: DeploymentPosture = {
  httpPort: undefined,
  httpHost: DEFAULT_HTTP_HOST,
  tokenConfigured: false,
  allowAnonymous: false,
  tls: DEFAULT_TLS,
  sslValidate: DEFAULT_SSL_VALIDATE,
  xsPlaintext: true,
};

/** 策略来源：三种互斥取法 */
export type PolicySource =
  /** 已解析好的值（服务启动路径：config 已是权威值，无需再解一遍 env） */
  | {
      kind: 'resolved';
      policy: Omit<Policy, 'source' | 'deployment'> & {
        source?: string;
        /** 省略 = 视为无部署级风险（stdio / 仅本机） */
        deployment?: DeploymentPosture;
      };
    }
  /** 进程环境变量 + .env 兜底（与服务器 tryLoadDotEnv 同源；仓库内跑脚本走这条） */
  | { kind: 'env'; env?: NodeJS.ProcessEnv }
  /** 指定 mcp.json（客户端注入路径，如本地模式的 .dsh/mcp.json） */
  | { kind: 'file'; path: string; server?: string };

/** 一次判定要声明的请求：需要用到哪些能力/资源 */
export interface PolicyRequest {
  /** 要调用的工具名 */
  tools?: readonly string[];
  /** 要写入的仓库包 */
  writePackages?: readonly string[];
  /** 要读取的 schema（非系统 schema） */
  schemas?: readonly string[];
}

/** 判定维度 */
export type Dimension = 'capability' | 'resource' | 'deployment' | 'profile';

/** 单条判定结论 */
export interface Grant {
  dimension: Dimension;
  /** 被判定对象（工具名 / 包名 / schema / 姿态项） */
  subject: string;
  /** 机器可读码（调用方据此判分支，不解析文本） */
  code: string;
  /** block = 必须拒绝；warn = 放行但需在日志中可见 */
  severity: 'block' | 'warn';
  message: string;
}

/** 判定总结果 */
export interface Verdict {
  /** true = 无任何 block 级结论 */
  allowed: boolean;
  /** 阻断级结论（非空即不可放行） */
  blocking: Grant[];
  /** 警告级结论（放行，但需人工可见） */
  warnings: Grant[];
  /** 本次用的策略（供调用方展示/二次判断） */
  policy: Policy;
  /** 人类可读报告（含来源归因与逐条结论） */
  text: string;
}

// ── 二、来源解析 ──────────────────────────────────────────────

/**
 * 拆分写包白名单（大写）。
 * 三条来源路径都经此归一，避免"resolved 不做空串过滤、env/file 做"这类不一致。
 */
function splitPackages(raw: unknown): string[] {
  return splitList(raw).map((s) => s.toUpperCase());
}

/**
 * 从一组原始 env 值构造部署姿态（与能力/资源同源，保证判定与运行期一致）。
 *
 * 与 config.ts 的 boolSchema 共用同一套**真值集合**（ENV_TRUE_VALUES + isEnvTrue），
 * 但强度不同，且这里的强度**刻意更低**：boolSchema 走 zod 枚举，取值既非真值也非假值时
 * 启动即失败；本函数读的是 mcp.json / 原生 env 的原始值（拿不到 zod 校验），非真值一律按假处理
 * （不在此处报错，也不静默当成真）。两边共享同一常量，保证真值口径不分叉；
 * 默认值同样取自 deployment.ts 的单一常量。
 */
function deploymentFromEnvValues(env: Record<string, unknown>): DeploymentPosture {
  const port = env.MCP_HTTP_PORT;
  const hasToken = hasValue(env.MCP_HTTP_TOKEN) || hasValue(env.MCP_HTTP_TOKENS);
  return {
    httpPort: hasValue(port) ? Number(port) : undefined,
    httpHost: String(env.MCP_HTTP_HOST ?? DEFAULT_HTTP_HOST),
    tokenConfigured: hasToken,
    allowAnonymous: isEnvTrue(env.MCP_HTTP_ALLOW_ANONYMOUS),
    // HANA_TLS / HANA_SSL_VALIDATE 默认 true（fail-closed），仅显式给了值才按真值判定
    tls: env.HANA_TLS === undefined ? DEFAULT_TLS : isEnvTrue(env.HANA_TLS),
    sslValidate: env.HANA_SSL_VALIDATE === undefined ? DEFAULT_SSL_VALIDATE : isEnvTrue(env.HANA_SSL_VALIDATE),
    // HANA_XS_TLS 口径相反：XS 写通道缺省明文，仅显式真值才判 https（与 core/xs-rest.ts 的
    // xsSchemeFromEnv 同源——那是唯一的运行期 scheme 判定处）
    xsPlaintext: !isEnvTrue(env.HANA_XS_TLS),
  };
}

/** 从一组原始 env 值构造策略（三条来源路径共用） */
function policyFromEnvValues(env: Record<string, unknown>, source: string): Policy {
  // 旧名归一（HANA_TOOL_* → MCP_TOOL_*）：与 loadConfig 同一实现，避免两条解析路径分叉
  const e = resolveEnvAliases(env);
  return {
    capability: parseToolFilter(
      String(e.MCP_TOOL_GROUPS ?? ''),
      String(e.MCP_TOOL_ALLOW ?? ''),
      String(e.MCP_TOOL_DENY ?? ''),
    ),
    resource: {
      writePackages: splitPackages(env.HANA_WRITE_PACKAGES),
      schemaAllow: splitList(env.HANA_SCHEMA_ALLOW),
    },
    deployment: deploymentFromEnvValues(env),
    source,
  };
}

/** 从 mcp.json 收集候选 server 条目（兼容 .dsh 的 servers[] 与标准 mcpServers{} 两种形态） */
function collectServerEntries(json: unknown): Array<{ name: string; env: Record<string, unknown>; enabled: boolean }> {
  const out: Array<{ name: string; env: Record<string, unknown>; enabled: boolean }> = [];
  const j = json as { servers?: unknown; mcpServers?: Record<string, unknown>; env?: unknown } | null;
  if (Array.isArray(j?.servers)) {
    for (const s of j.servers) {
      const e = s as { name?: string; env?: unknown; enabled?: unknown } | null;
      if (e && typeof e === 'object' && e.env && typeof e.env === 'object') {
        out.push({ name: e.name ?? '(未命名)', env: e.env as Record<string, unknown>, enabled: e.enabled !== false });
      }
    }
  }
  if (j?.mcpServers && typeof j.mcpServers === 'object') {
    for (const [name, s] of Object.entries(j.mcpServers)) {
      const e = s as { env?: unknown } | null;
      if (e && typeof e === 'object' && e.env && typeof e.env === 'object') {
        out.push({ name, env: e.env as Record<string, unknown>, enabled: true });
      }
    }
  }
  if (j?.env && typeof j.env === 'object') {
    out.push({ name: '(文件根 env)', env: j.env as Record<string, unknown>, enabled: true });
  }
  return out;
}

/** 读指定 mcp.json，取出唯一确定的 env 来源；有歧义时报错要求显式指定，不做静默猜测 */
function resolveFromFile(path: string, server?: string): Policy {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(abs, 'utf8'));
  } catch (e) {
    throw new Error(`读取配置失败 ${abs}：${(e as Error).message}`);
  }
  const entries = collectServerEntries(json);
  if (entries.length === 0) {
    throw new Error(`${abs} 中未找到任何 env 配置（servers[].env / mcpServers{}.env）`);
  }
  let hit = entries.find((e) => e.name === server);
  if (server && !hit) {
    throw new Error(`${abs} 中没有名为 "${server}" 的 server（可选：${entries.map((e) => e.name).join(', ')}）`);
  }
  if (!hit) {
    // 多个 server 时取第一个启用的；若它们的写包白名单不一致就报错要求显式 --server，不静默猜测
    const enabled = entries.filter((e) => e.enabled);
    const distinct = new Set(enabled.map((e) => splitPackages(e.env.HANA_WRITE_PACKAGES).join(',')));
    if (enabled.length > 1 && distinct.size > 1) {
      throw new Error(
        `${abs} 中多个启用的 server 配置了不同的 HANA_WRITE_PACKAGES，无法确定用哪个；` +
          `请用 --server 指定（可选：${enabled.map((e) => e.name).join(', ')}）`,
      );
    }
    hit = enabled[0] ?? entries[0];
  }
  return policyFromEnvValues(hit.env, `${abs} 的 server "${hit.name}" env（客户端注入路径）`);
}

/**
 * 进程环境变量 + .env 兜底（与服务器 tryLoadDotEnv 同源），并给出「值实际来自哪里」的归因。
 *
 * ⚠️ **只允许给独立进程用**（CLI、实机验证脚本）。**绝不可在服务进程内 `loadConfig()` 之后调用**：
 * 那时 `HANA_PASSWORD` 已被 loadConfig 从环境中删除，三件套不再齐备，本函数会认为"外部未提供凭据"
 * 而真的去读 .env —— 既把密码重新写回 `process.env`，又让判定值与 `config` 里的运行值分叉。
 * 服务进程内请用 {@link policyFromConfig}。
 */
function resolveFromEnv(env: NodeJS.ProcessEnv = process.env): Policy {
  const preexisting = env.HANA_WRITE_PACKAGES;
  tryLoadDotEnv(env);
  const source =
    preexisting !== undefined
      ? '进程环境变量（若由脚本 loadEnvFile 后透传，则实为仓库 .env）'
      : env.HANA_WRITE_PACKAGES !== undefined
        ? '仓库 .env（进程环境变量未提供）'
        : '未提供（进程环境变量与 .env 均无该键）';
  return policyFromEnvValues(env as Record<string, unknown>, source);
}

/** 解析生效策略 */
export function resolvePolicy(source: PolicySource): Policy {
  if (source.kind === 'resolved') {
    return {
      capability: source.policy.capability,
      // 与 env/file 两条路径统一归一（大写 + 去空串）
      resource: {
        writePackages: splitPackages(source.policy.resource.writePackages.join(',')),
        schemaAllow: splitList(source.policy.resource.schemaAllow.join(',')),
      },
      deployment: source.policy.deployment ?? SAFE_DEPLOYMENT_POSTURE,
      ...(source.policy.profiles ? { profiles: source.policy.profiles } : {}),
      source: source.policy.source ?? '已解析配置（服务已加载）',
    };
  }
  return source.kind === 'file' ? resolveFromFile(source.path, source.server) : resolveFromEnv(source.env);
}

/**
 * 从**已加载的配置**构造策略（服务进程内的唯一正确做法）。
 *
 * 为什么不复用 resolveFromEnv：那是给**独立进程**（CLI / 实机脚本）用的，它会调
 * `tryLoadDotEnv` 去读 .env。服务进程内 `loadConfig()` 已经解析过配置，并且在解析后
 * **删除了 `process.env.HANA_PASSWORD`**（凭据生命周期控制，见 config.ts）。此时三件套不再齐备，
 * `tryLoadDotEnv` 会认为"外部未提供凭据"而**真的去读 .env**，后果有两个：
 *   1. 把已删除的密码重新写回 `process.env`，常驻整个服务生命周期 —— 直接推翻那条控制；
 *   2. 判定看到的 token/端口等来自 .env，而 `config` 里是另一套值 —— 出现
 *      「判定用的值 ≠ 运行用的值」，启动自检会放过实际不设防的部署。
 * 所以服务进程内一律走本函数，不要走 resolveFromEnv。
 */
export function policyFromConfig(config: HanaConfig, capability: ToolFilterConfig): Policy {
  return {
    capability,
    resource: {
      writePackages: config.writePackages,
      schemaAllow: config.schemaAllow,
    },
    profiles: config.profiles,
    deployment: {
      httpPort: config.httpPort,
      httpHost: config.httpHost,
      tokenConfigured: config.httpTokens.length > 0,
      allowAnonymous: config.httpAllowAnonymous,
      tls: config.tls,
      sslValidate: config.sslValidate,
      // HANA_XS_TLS 不经 HanaConfig 传递（core/xs-rest.ts 运行期直读进程环境变量）：
      // 这里读同一来源，保证判定值与 XS 通道实际 scheme 同源
      xsPlaintext: !isEnvTrue(process.env.HANA_XS_TLS),
    },
    source: '服务已加载配置',
  };
}

// ── 三、判定器（每个权限维度一个纯函数）──────────────────────

/**
 * 写语义探测参数：只为让清单声明的写语义显形——两个顶层写包形参名（`zWritePackageId` 的用法）
 * 与对象名各给一个值；`hana_view_validate` 一类的规划器写分支（design 模式）据此进入写路径。
 * 与 capability-manifest.test.ts 的探测调用同口径；探测无副作用（规划器是纯函数，入参 → WritePlan）。
 */
const WRITE_PROBE_ARGS: Record<string, unknown> = {
  packageId: 'PROBE.PKG',
  targetPackageId: 'PROBE.PKG',
  objectName: 'PROBE_OBJ',
};

/**
 * 能力的**实际写语义**：资源计划（`planFor`——清单声明的唯一投影）在探测调用下是否声明写包。
 *
 * 判据必须是计划而不是组名（kind）：write/admin 组里混着**行为只读**的成员
 * （`hana_sql_analyze`、`hana_view_check_actions`、`hana_task_cancel`，以及 admin 档的
 * `hana_repo_export` / `hana_repo_changelist` / health 四件套），按组名判会让
 * 「read,admin 分组 + deny 掉唯一写包能力（`hana_repo_import`）」这类**实际无写能力**的部署
 * 也报 boundary_off，运维文案与事实不符。`planFor` 同时覆盖两个声明源：
 * 参数声明（如 `hana_repo_import.targetPackageId` 的打标写包形参）与规划器写分支
 * （如 `hana_view_validate` 的 design 模式写 _CHKTMP 临时对象）。
 */
function writesRepositoryPackages(name: string): boolean {
  const cap = findCapability(name);
  return cap !== undefined && planFor(cap, WRITE_PROBE_ARGS).writePackages.length > 0;
}

/**
 * 「可能写仓库包」的能力是否真的对客户端可达：无此类能力的部署下，写边界不影响实际行为
 * （不产生误导性告警）。判据 = 暴露面里存在**实际写语义**的能力（见 writesRepositoryPackages），
 * **不按组名**——真阳性场景不漏：`hana_repo_import` 是 admin 档的写能力，「只暴露 admin 组 +
 * 空白名单」的部署仍会报 boundary_off。
 *
 * 只看**具体能力**（`CONCRETE_CAPABILITY_IDS`），不看门面：门面的 kind 是成员摘要，
 * `hana_modeling` 是 admin 却也含 write 档成员——拿它当"写能力可达"的证据会给每一次
 * describePolicy 都刷出假的 boundary_off。
 */
function writeCapableExposed(policy: Policy): boolean {
  return CONCRETE_CAPABILITY_IDS.some(
    (name) => shouldRegisterTool(name, policy.capability) && writesRepositoryPackages(name),
  );
}

/**
 * 能力级判定：要调用的工具是否会被注册。
 * 未注册的工具调用即 tool not found —— 典型「跑到最后才发现」。
 */
function checkCapability(policy: Policy, tools: readonly string[]): Grant[] {
  const out: Grant[] = [];
  for (const tool of tools) {
    if (!shouldRegisterTool(tool, policy.capability)) {
      out.push({
        dimension: 'capability',
        subject: tool,
        code: 'tool_not_exposed',
        severity: 'block',
        message: `${BLOCKED_PREFIX}：工具 "${tool}" 当前未对客户端暴露（工具可见性配置未启用它），调用会被直接拒绝。`,
      });
    }
  }
  return out;
}

/**
 * 资源级判定：要写入的包 / 要读取的 schema 是否在授权范围内。
 *
 * 写包门禁只对「本次确实要写包」的请求生效——只读请求不该被空写白名单的 boundary_off 拦住，
 * 否则读操作在未配置写边界的部署上寸步难行。
 */
function checkResource(policy: Policy, request: PolicyRequest): Grant[] {
  const out: Grant[] = [];
  const targets = request.writePackages ?? [];

  if (targets.length > 0) {
    // 边界为空 = 写边界未启用（服务层 assertWritePackageAllowed 那层是 fail-open，但本闸门必须拦）：
    // 依赖边界生效的写请求在此不成立，放行等于给出错误的安全保证。
    // **不附加"存在已暴露的写能力"条件**：本分支只在请求确实声明了写包时进入（只读请求不在此），
    // 而声明写包的能力不限于 kind==='write'——admin 档的 hana_repo_import 同样写仓库包，附加该条件
    // 会让这类调用在空白名单部署里 fail-open（与 checkPolicySelf 的 writeCapableExposed 同口径）。
    if (policy.resource.writePackages.length === 0) {
      out.push({
        dimension: 'resource',
        subject: '(写边界未启用)',
        code: WRITE_BOUNDARY_CODES.boundaryOff,
        severity: 'block',
        message:
          // 拦截文案不含补救：**不得**出现变量名/「请配置」这类改法（调用方看到的就是模型，
          // 写明改哪项配置等于教它绕过）。补救只出现在运维入口 describePolicy 与启动自检。
          `${BLOCKED_PREFIX}：服务端未启用写操作包边界（可写包白名单为空），` + '本请求依赖边界生效，因此被拒绝。',
      });
    }
    for (const target of targets) {
      if (!isValidPackagePrefix(target.trim().toUpperCase())) {
        out.push({
          dimension: 'resource',
          subject: target,
          code: 'target_invalid',
          severity: 'block',
          message: `${BLOCKED_PREFIX}：目标包 "${target}" 不是合法的仓库包路径（点分段、每段仅字母/数字/下划线/连字符）`,
        });
        continue;
      }
      if (!isPackageAllowed(target, policy.resource.writePackages)) {
        out.push({
          dimension: 'resource',
          subject: target,
          code: WRITE_BOUNDARY_CODES.targetOutsideBoundary,
          severity: 'block',
          message:
            `${BLOCKED_PREFIX}：目标包 "${target}" 不在服务端配置的可写包范围内` +
            `（生效范围：${policy.resource.writePackages.join(', ')}）。`,
        });
      }
    }
  }

  for (const schema of request.schemas ?? []) {
    if (!isSchemaAllowedWith(schema, policy.resource.schemaAllow)) {
      out.push({
        dimension: 'resource',
        subject: schema,
        code: 'schema_not_allowed',
        severity: 'block',
        message:
          `${BLOCKED_PREFIX}：schema "${schema}" 不在服务端允许读取的范围内` +
          '（系统 schema 恒可读，其余须由部署方显式追加）。',
      });
    }
  }
  return out;
}

/**
 * 部署不变量里归**启动告警**的一类：只进运维自检 `describePolicy`，不进任务闸门（runPreflight）
 * 与调用审计（authorizeCall 放行时把全部 warnings 映射为 audit.codes）。
 *
 * 为什么 xs_plaintext 必须分流：它是 XS 写通道的**缺省事实**——未显式置 HANA_XS_TLS=true 的部署
 * （默认部署）恒命中，与"这次调用触碰了什么"无关。若随每次调用结论下发，每条放行审计的 codes
 * 都会被它**无条件**塞满，审计码不再表达本次调用；而按运维要求它仍须在启动自检里持续可见
 * （部署方据此加密通道或做网络侧隔离）。
 */
const STARTUP_ONLY_DEPLOYMENT_CODES: ReadonlySet<DeploymentInvariant['code']> = new Set(['xs_plaintext']);

/** 部署不变量 → 判定结论（唯一映射处）：只取 message（事实陈述）。补救指引与豁免开关是运维向
 *  信息，仅在 describePolicy 里追加，不随 Grant 进入请求响应——`checkDeployment` 的结论也会
 *  出现在给调用方的拦截消息中。 */
function deploymentGrants(invariants: readonly DeploymentInvariant[]): Grant[] {
  return invariants.map((inv) => ({
    dimension: 'deployment' as const,
    subject: inv.code,
    code: inv.code,
    severity: inv.severity,
    message: inv.message,
  }));
}

/**
 * 部署级判定：配置组合是否构成安全暴露。
 * 与能力/资源不同，这一维度**与具体请求无关**，任何请求下都应先满足。
 *
 * 产出**任务级**结论：启动告警类（见 STARTUP_ONLY_DEPLOYMENT_CODES）不在其中，
 * 它们由 `checkDeploymentStartup` 只在 describePolicy 里并入。
 */
export function checkDeployment(policy: Policy): Grant[] {
  return deploymentGrants(
    checkDeploymentInvariants(policy.deployment).filter((inv) => !STARTUP_ONLY_DEPLOYMENT_CODES.has(inv.code)),
  );
}

/** 启动告警类部署结论（**只供 describePolicy**，理由见 STARTUP_ONLY_DEPLOYMENT_CODES） */
function checkDeploymentStartup(policy: Policy): Grant[] {
  return deploymentGrants(
    checkDeploymentInvariants(policy.deployment).filter((inv) => STARTUP_ONLY_DEPLOYMENT_CODES.has(inv.code)),
  );
}

/** 策略自检：与具体请求无关的、关于"这份策略本身"的结论 */
function checkPolicySelf(policy: Policy): Grant[] {
  // 可能写仓库包的能力可达但写边界未启用 —— 这是策略级事实，不需要有写请求就该被告知。
  // 口径必须与 checkResource 一致：空白名单不是「不限制」，而是「声明写包的写请求会被硬拦」——
  // 写能力已暴露时等于写不可用（只有服务层 assertWritePackageAllowed 那层是 fail-open）。
  if (writeCapableExposed(policy) && policy.resource.writePackages.length === 0) {
    return [
      {
        dimension: 'resource',
        subject: '(写边界未启用)',
        code: WRITE_BOUNDARY_CODES.boundaryOff,
        severity: 'warn',
        message:
          '可写包白名单为空（HANA_WRITE_PACKAGES 未配置）：部署仍暴露了可能写仓库包的能力（其资源计划会声明写包），' +
          '对任何声明写包的调用，运行期闸门都会以 boundary_off 拒绝（端到端等于写不可用）。' +
          '需要写入请在当前启动来源中配置可写包前缀后重启服务。',
      },
    ];
  }
  return [];
}

// ── 四、入口 ──────────────────────────────────────────────────

/**
 * 判定结果组装：分类 + 生成报告文本。**报告构造只此一处**——
 * 调用期闸门（`authorize.ts`）在"目标能力未登记"时也用它，保证两种拒绝的回执同形。
 */
export function assembleVerdict(policy: Policy, grants: Grant[], requestLines: readonly string[]): Verdict {
  return assemble(policy, grants, [...requestLines]);
}

/** 判定结果组装：分类 + 生成报告文本 */
function assemble(policy: Policy, grants: Grant[], requestLines: string[]): Verdict {
  const blocking = grants.filter((g) => g.severity === 'block');
  const warnings = grants.filter((g) => g.severity === 'warn');
  const lines: string[] = [
    `策略来源：${policy.source}`,
    `能力级（工具可见性）：${formatCapability(policy.capability)}`,
    `资源级（可写包）：${formatResource(policy.resource)}`,
    ...requestLines,
  ];
  for (const g of [...blocking, ...warnings]) {
    lines.push(`  [${g.code}·${g.severity}] (${g.dimension}) ${g.message}`);
  }
  return { allowed: blocking.length === 0, blocking, warnings, policy, text: lines.join('\n') };
}

function formatCapability(c: ToolFilterConfig): string {
  const none = c.enabledGroups.size === 0 && c.allowPatterns.length === 0 && c.denyPatterns.length === 0;
  if (none) return '未过滤（全部工具注册）';
  const parts: string[] = [];
  if (c.enabledGroups.size > 0) parts.push(`启用分组 ${[...c.enabledGroups].join('/')}`);
  else parts.push('启用分组 全部');
  if (c.allowPatterns.length > 0) parts.push(`allow ${c.allowPatterns.join(', ')}`);
  if (c.denyPatterns.length > 0) parts.push(`deny ${c.denyPatterns.join(', ')}`);
  return parts.join('；');
}

function formatResource(r: Policy['resource']): string {
  return (
    (r.writePackages.length > 0
      ? `仅白名单及其子包可写 → ${r.writePackages.join(', ')}`
      : '未启用（空白名单：声明写包的调用会被 boundary_off 拒绝）') +
    `；schema 追加 ${r.schemaAllow.length > 0 ? r.schemaAllow.join(', ') : '(无，仅系统 schema)'}`
  );
}

/**
 * 任务闸门：执行前判定「本次请求声明的能力与资源」是否都被策略允许。
 *
 * 未声明任何请求时一律拦截（不在未知目标下放行）。只读、纯本地：
 * 不写文件、不连 HANA、不发起任何操作。
 *
 * `extraLines` 供调用期闸门（`authorize.ts`）把"本次调用的资源计划"补进同一份报告——
 * 报告构造只有这一处（`assemble`），新增入口只加行、不另写一套。
 */
export function runPreflight(opts: {
  source: PolicySource;
  request: PolicyRequest;
  extraLines?: readonly string[];
  /** 调用方档案等**请求级附加维度**的结论（与各 check* 的结论合并后统一分类/成文） */
  extraGrants?: readonly Grant[];
}): Verdict {
  const policy = resolvePolicy(opts.source);
  const request = opts.request;
  const declared = (request.tools?.length ?? 0) + (request.writePackages?.length ?? 0) + (request.schemas?.length ?? 0);
  if (declared === 0) {
    return assemble(
      policy,
      [
        {
          dimension: 'resource',
          subject: '(未声明请求)',
          code: 'no_request',
          severity: 'block',
          message: '未声明本次需要什么权限（工具 / 可写包 / schema）——无从判定，拒绝在未知目标下放行',
        },
      ],
      [],
    );
  }
  const grants = [
    ...checkCapability(policy, request.tools ?? []),
    ...checkResource(policy, request),
    ...checkDeployment(policy),
    ...(opts.extraGrants ?? []),
  ];
  const requestLines = [
    `本次声明：工具 ${request.tools?.length ? request.tools.join(', ') : '(无)'}` +
      `；可写包 ${request.writePackages?.length ? request.writePackages.join(', ') : '(无)'}` +
      `；schema ${request.schemas?.length ? request.schemas.join(', ') : '(无)'}`,
    ...(opts.extraLines ?? []),
  ];
  return assemble(policy, grants, requestLines);
}

/**
 * 档案自检：**档案只能收紧，不能放宽**。
 *
 * 判定口径（两条，方向不同、严重度不同）：
 * - **block**：档案声明允许某个 kind，而该 kind 在部署面上**一个能力都不可见**
 *   （分组未启用、或被 deny 全关掉）。这是"运维以为的权限"与"实际权限"的直接矛盾——
 *   天花板仍在（不是漏洞），但必须显式纠偏，否则运维会按错误的认知排查问题。
 * - **warn**：档案的能力 glob 有部分落在部署已隐藏的面上（或与自身 allowKinds 不匹配）。
 *   宽 glob（如 `hana_*`）几乎必然命中一些被隐藏的能力，若一律 block 会让档案无法使用；
 *   实际效果仍由天花板决定，故只提示。
 *
 * 只在**配置自检**路径（describePolicy）里跑，不进 runPreflight——
 * 它是"关于配置本身"的结论，与具体请求无关，每调用一次都重算是噪音。
 */
export function checkProfiles(policy: Policy): Grant[] {
  const profiles = policy.profiles;
  if (!profiles || profiles.size === 0) return [];
  const out: Grant[] = [];
  const capabilityIds = Object.keys(TOOL_GROUPS);
  // 各 kind 在部署面上是否还有可见能力（把 deny / 分组 / 未登记 一并算进去）。
  // **只数具体能力**：门面的 kind 是成员摘要，把它算进来会让"只读部署 + dev 档案声称允许 write"
  // 这类真矛盾漏报（门面可见 ≠ 其成员全部可触达）。
  const exposedKinds = ALL_TOOL_GROUPS.filter((k) =>
    CONCRETE_CAPABILITY_IDS.some((name) => TOOL_GROUPS[name] === k && shouldRegisterTool(name, policy.capability)),
  );
  for (const profile of profiles.values()) {
    const kindsOutside = profile.allowKinds.filter((k) => !exposedKinds.includes(k));
    if (kindsOutside.length > 0) {
      out.push({
        dimension: 'profile',
        subject: profile.id,
        code: 'profile_kind_not_in_policy',
        severity: 'block',
        message:
          `${BLOCKED_PREFIX}：档案 "${profile.id}" 声明允许 ${kindsOutside.join('/')} 类能力，` +
          `但部署策略下这些分组没有任何能力可见（当前可见分组：${exposedKinds.join('/') || '(无)'}）。` +
          '档案只能收紧不能放宽，请把该档案改成部署实际暴露的 kind。',
      });
    }
    if (profile.allowCapabilities) {
      const hit = matchedCapabilities(profile, capabilityIds);
      if (hit.length === 0) {
        out.push({
          dimension: 'profile',
          subject: profile.id,
          code: 'profile_glob_matches_nothing',
          severity: 'warn',
          message: `档案 "${profile.id}" 的能力 glob（${profile.allowCapabilities.join('|')}）没有命中任何已登记能力（拼写错误？）`,
        });
      } else {
        const hidden = hit.filter((id) => !shouldRegisterTool(id, policy.capability));
        if (hidden.length > 0) {
          out.push({
            dimension: 'profile',
            subject: profile.id,
            code: 'profile_glob_partly_hidden',
            severity: 'warn',
            message:
              `档案 "${profile.id}" 的能力 glob 命中了 ${hidden.length} 个部署已隐藏的能力（${hidden.slice(0, 5).join(', ')}…）：` +
              '这些能力不会因档案而可见（天花板不变），本提示仅用于核对 glob 是否符合预期。',
          });
        }
      }
    }
  }
  return out;
}

/**
 * 策略自检：只反映当前生效的策略本身，不对应任何具体请求。
 * 供服务启动自检、环境诊断等「想知道策略长什么样」的场景使用。
 *
 * 这是**运维向**入口：只有这里会追加补救指引与豁免开关（那是运维需要的信息），
 * 请求响应路径（runPreflight）不会带这些。
 */
export function describePolicy(source: PolicySource): Verdict {
  const policy = resolvePolicy(source);
  const verdict = assemble(
    policy,
    [
      ...checkPolicySelf(policy),
      ...checkDeployment(policy),
      // 启动告警类部署结论（xs_plaintext 等）：只在运维自检里可见，不进任务闸门/调用审计
      ...checkDeploymentStartup(policy),
      ...checkProfiles(policy),
    ],
    [
      `部署姿态：${policy.deployment.httpPort == null ? 'stdio（不对外监听）' : `HTTP :${policy.deployment.httpPort} @ ${policy.deployment.httpHost}`}` +
        `；Bearer 认证 ${policy.deployment.tokenConfigured ? '已配置' : '未配置'}` +
        `；连接加密 ${policy.deployment.tls ? '开' : '关'}` +
        `；证书校验 ${policy.deployment.sslValidate ? '开' : '关'}`,
      ...(policy.profiles ? [`调用方档案：${describeProfiles(policy.profiles)}`] : []),
    ],
  );
  const remedies = checkDeploymentInvariants(policy.deployment)
    .filter((inv) => inv.remedy || inv.override)
    .map(
      (inv) =>
        `  [${inv.code}] 处置建议：${inv.remedy ?? ''}` +
        (inv.override ? `${inv.remedy ? '；' : ''}确需如此请显式设置 ${inv.override}=true` : ''),
    );
  return remedies.length > 0 ? { ...verdict, text: `${verdict.text}\n${remedies.join('\n')}` } : verdict;
}
