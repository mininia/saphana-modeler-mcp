import { readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { tryLoadDotEnv, type HanaConfig } from './config.js';
import {
  checkDeploymentInvariants,
  type DeploymentInvariant,
  type DeploymentPosture,
} from './deployment.js';
import { isPackageAllowed, isValidPackagePrefix, formatWriteBoundaryReport, describeWriteBoundary } from './write-boundary.js';
import { isSchemaAllowedWith } from '../core/sql.js';
import { parseToolFilter, shouldRegisterTool, TOOL_GROUPS, type ToolFilterConfig } from '../tools/groups.js';

/**
 * 权限策略层 —— 能力级 + 资源级两类权限的唯一判定入口。
 *
 * ## 两个权限级功能
 *
 * | 维度 | 管什么 | 配置项 | 参考 |
 * |---|---|---|---|
 * | **能力级** | 哪些工具对外暴露 | HANA_TOOL_GROUPS / ALLOW / DENY | tableau 的 INCLUDE/EXCLUDE_TOOLS（组展开）；dataworks 的 TOOL_CATEGORIES/NAMES |
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

/**
 * 请求被策略拦截时的统一前缀。
 *
 * 为什么要有：拦截消息是**返回给调用方（通常是模型）**的，它需要一眼看出
 * 「这是服务端策略拦截，不是我的参数写错了」，从而停下并交由人决策。
 *
 * 同样重要的一点：这些消息**不得**包含"改哪一项配置即可放行"之类的补救指引——
 * 那等于把绕过方法直接交给被拦的一方。补救指引只应出现在面向运维的位置
 * （服务启动自检、README），不出现在请求响应里。
 */
const BLOCKED_PREFIX = '被 MCP 安全策略拦截';

// ── 一、策略模型 ──────────────────────────────────────────────

/** 生效的权限策略：一次判定所需的全部约束 */
export interface Policy {
  /** 能力级：哪些工具对外暴露 */
  capability: ToolFilterConfig;
  /** 资源级：能操作哪些资源 */
  resource: {
    /** 可写包前缀（大写；空数组 = 不限制。空 = unrestricted，非空 = restricted） */
    writePackages: string[];
    /** 可读 schema 的追加项（系统 schema 恒可读，不在此列） */
    schemaAllow: string[];
  };
  /** 部署姿态：连接侧约束（非任务级，见 checkDeployment） */
  deployment: DeploymentPosture;
  /** 这份策略的来源（人类可读，供日志/报告归因） */
  source: string;
}

/** 缺省部署姿态：stdio、仅本机、加密且校验证书（即无任何部署级风险） */
export const SAFE_DEPLOYMENT_POSTURE: DeploymentPosture = {
  httpPort: undefined,
  httpHost: '127.0.0.1',
  tokenConfigured: false,
  allowAnonymous: false,
  tls: true,
  sslValidate: true,
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
export type Dimension = 'capability' | 'resource' | 'deployment';

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

/** 逗号分隔 → 去空白 → 去空串 */
function splitList(raw: unknown): string[] {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 拆分写包白名单（大写）。
 * 三条来源路径都经此归一，避免"resolved 不做空串过滤、env/file 做"这类不一致。
 */
function splitPackages(raw: unknown): string[] {
  return splitList(raw).map((s) => s.toUpperCase());
}

/** 从一组原始 env 值构造部署姿态（与能力/资源同源，保证判定与运行期一致） */
function deploymentFromEnvValues(env: Record<string, unknown>): DeploymentPosture {
  const port = env.MCP_HTTP_PORT;
  const hasToken =
    String(env.MCP_HTTP_TOKEN ?? '').trim() !== '' || String(env.MCP_HTTP_TOKENS ?? '').trim() !== '';
  // 布尔项与 config.ts 的 boolSchema 同义：'true'/'1'/'TRUE' 为真，其余为假
  const isTrue = (v: unknown): boolean => v === 'true' || v === '1' || v === 'TRUE';
  return {
    httpPort: port == null || String(port).trim() === '' ? undefined : Number(port),
    httpHost: String(env.MCP_HTTP_HOST ?? '127.0.0.1'),
    tokenConfigured: hasToken,
    allowAnonymous: isTrue(env.MCP_HTTP_ALLOW_ANONYMOUS),
    // HANA_TLS / HANA_SSL_VALIDATE 默认 true（fail-closed），仅显式假值才算关闭
    tls: env.HANA_TLS === undefined ? true : isTrue(env.HANA_TLS),
    sslValidate: env.HANA_SSL_VALIDATE === undefined ? true : isTrue(env.HANA_SSL_VALIDATE),
  };
}

/** 从一组原始 env 值构造策略（三条来源路径共用） */
function policyFromEnvValues(env: Record<string, unknown>, source: string): Policy {
  return {
    capability: parseToolFilter(
      String(env.HANA_TOOL_GROUPS ?? ''),
      String(env.HANA_TOOL_ALLOW ?? ''),
      String(env.HANA_TOOL_DENY ?? ''),
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
    deployment: {
      httpPort: config.httpPort,
      httpHost: config.httpHost,
      tokenConfigured: config.httpTokens.length > 0,
      allowAnonymous: config.httpAllowAnonymous,
      tls: config.tls,
      sslValidate: config.sslValidate,
    },
    source: '服务已加载配置',
  };
}

// ── 三、判定器（每个权限维度一个纯函数）──────────────────────

/** 写工具是否真的对客户端可达：无写工具的部署下，写边界不影响实际行为（不产生误导性告警） */
function writeToolsExposed(policy: Policy): boolean {
  return Object.entries(TOOL_GROUPS).some(
    ([name, group]) => group === 'write' && shouldRegisterTool(name, policy.capability),
  );
}

/**
 * 能力级判定：要调用的工具是否会被注册。
 * 未注册的工具调用即 tool not found —— 典型「跑到最后才发现」。
 */
export function checkCapability(policy: Policy, tools: readonly string[]): Grant[] {
  const out: Grant[] = [];
  for (const tool of tools) {
    if (!shouldRegisterTool(tool, policy.capability)) {
      out.push({
        dimension: 'capability',
        subject: tool,
        code: 'tool_not_exposed',
        severity: 'block',
        message:
          `${BLOCKED_PREFIX}：工具 "${tool}" 当前未对客户端暴露（工具可见性配置未启用它），调用会被直接拒绝。`,
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
export function checkResource(policy: Policy, request: PolicyRequest): Grant[] {
  const out: Grant[] = [];
  const targets = request.writePackages ?? [];
  const exposed = writeToolsExposed(policy);

  if (targets.length > 0) {
    // 边界为空 = 不限制（fail-open，配置未填时的默认）：依赖边界生效的写请求在此不成立，必须拦
    if (policy.resource.writePackages.length === 0 && exposed) {
      out.push({
        dimension: 'resource',
        subject: '(写边界未启用)',
        code: 'boundary_off',
        severity: 'block',
        message:
          `${BLOCKED_PREFIX}：服务端未启用写操作包边界（可写包白名单为空 = 所有包均可写），` +
          '本请求依赖边界生效，因此被拒绝。',
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
          code: 'target_outside_boundary',
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
 * 部署级判定：配置组合是否构成安全暴露。
 * 与能力/资源不同，这一维度**与具体请求无关**，任何请求下都应先满足。
 */
export function checkDeployment(policy: Policy): Grant[] {
  // 只取 message（事实陈述）。补救指引与豁免开关是运维向信息，仅在 describePolicy 里追加，
  // 不随 Grant 进入请求响应——`checkDeployment` 的结论也会出现在给调用方的拦截消息中。
  return checkDeploymentInvariants(policy.deployment).map((inv: DeploymentInvariant) => ({
    dimension: 'deployment' as const,
    subject: inv.code,
    code: inv.code,
    severity: inv.severity,
    message: inv.message,
  }));
}

/** 策略自检：与具体请求无关的、关于"这份策略本身"的结论 */
function checkPolicySelf(policy: Policy): Grant[] {
  // 写工具可达但写边界未启用 —— 这是策略级事实，不需要有写请求就该被告知
  if (writeToolsExposed(policy) && policy.resource.writePackages.length === 0) {
    return [
      {
        dimension: 'resource',
        subject: '(写边界未启用)',
        code: 'boundary_off',
        severity: 'warn',
        message:
          'HANA_WRITE_PACKAGES 为空 = 写操作不限制（所有包可写），但写类工具已对客户端暴露。' +
          '若部署依赖写边界，请先在当前启动来源中配置可写包前缀后重启服务。',
      },
    ];
  }
  return [];
}

// ── 四、入口 ──────────────────────────────────────────────────

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
      : '未启用（所有包可写）') +
    `；schema 追加 ${r.schemaAllow.length > 0 ? r.schemaAllow.join(', ') : '(无，仅系统 schema)'}`
  );
}

/**
 * 任务闸门：执行前判定「本次请求声明的能力与资源」是否都被策略允许。
 *
 * 未声明任何请求时一律拦截（不在未知目标下放行）。只读、纯本地：
 * 不写文件、不连 HANA、不发起任何操作。
 */
export function runPreflight(opts: { source: PolicySource; request: PolicyRequest }): Verdict {
  const policy = resolvePolicy(opts.source);
  const request = opts.request;
  const declared =
    (request.tools?.length ?? 0) + (request.writePackages?.length ?? 0) + (request.schemas?.length ?? 0);
  if (declared === 0) {
    return assemble(policy, [
      {
        dimension: 'resource',
        subject: '(未声明请求)',
        code: 'no_request',
        severity: 'block',
        message: '未声明本次需要什么权限（工具 / 可写包 / schema）——无从判定，拒绝在未知目标下放行',
      },
    ], []);
  }
  const grants = [
    ...checkCapability(policy, request.tools ?? []),
    ...checkResource(policy, request),
    ...checkDeployment(policy),
  ];
  const requestLines = [
    `本次声明：工具 ${request.tools?.length ? request.tools.join(', ') : '(无)'}` +
      `；可写包 ${request.writePackages?.length ? request.writePackages.join(', ') : '(无)'}` +
      `；schema ${request.schemas?.length ? request.schemas.join(', ') : '(无)'}`,
  ];
  return assemble(policy, grants, requestLines);
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
  const verdict = assemble(policy, [...checkPolicySelf(policy), ...checkDeployment(policy)], [
    `部署姿态：${policy.deployment.httpPort == null ? 'stdio（不对外监听）' : `HTTP :${policy.deployment.httpPort} @ ${policy.deployment.httpHost}`}` +
      `；Bearer 认证 ${policy.deployment.tokenConfigured ? '已配置' : '未配置'}` +
      `；连接加密 ${policy.deployment.tls ? '开' : '关'}` +
      `；证书校验 ${policy.deployment.sslValidate ? '开' : '关'}`,
  ]);
  const remedies = checkDeploymentInvariants(policy.deployment)
    .filter((inv) => inv.remedy || inv.override)
    .map(
      (inv) =>
        `  [${inv.code}] 处置建议：${inv.remedy ?? ''}` +
        (inv.override ? `${inv.remedy ? '；' : ''}确需如此请显式设置 ${inv.override}=true` : ''),
    );
  return remedies.length > 0 ? { ...verdict, text: `${verdict.text}\n${remedies.join('\n')}` } : verdict;
}

/** 写边界报告（保留给需要原始结构/文本的调用方，如启动日志的历史格式） */
export { formatWriteBoundaryReport, describeWriteBoundary };
