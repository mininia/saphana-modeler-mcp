/**
 * `hana_tool_search` handler：Discover → Disclose（Contract/Goal）。
 *
 * 三条纪律：
 * - **不改工具面**：不注册/摘除/通知；回执明确写「按 call.via 路由执行」；
 * - **不做授权**：`policy` 只是 preview（与 enforce 同一个 evaluate），执行仍逐次过 authorizeCall；
 * - **不泄漏**：集合内任一 id 未登记/不在 entitlement → 整包拒绝，与未知能力逐字同形，不点名不计数。
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { CAP, findCapability } from '../capabilities/manifest.js';
import type { Capability } from '../capabilities/types.js';
import { discoverCapabilities } from '../capabilities/discovery.js';
import { resourceRoleOf } from '../capabilities/resources.js';
import {
  RECIPES,
  RECIPE_GOALS,
  collectStepRefs,
  isRecipeGoal,
  substituteBindings,
  validateAllRecipes,
  type RecipeStep,
} from '../capabilities/recipes.js';
import {
  TOOL_SEARCH_LIMITS,
  inferToolSearchMode,
  validateToolSearchArgs,
  type ToolSearchArgs,
} from '../capabilities/defs/tool-search.js';
import { evaluate } from '../config/evaluate.js';
import { registerDisclosure } from '../config/disclosure-registry.js';
import { issueContextToken } from '../config/context-token.js';
import { policyFromConfig } from '../config/preflight.js';
import { capabilityInputSchema } from '../config/environment-policy.js';
import { currentEnvironmentRuntime } from '../core/environment-context.js';
import { currentIdentity } from '../core/request-context.js';
import { logger } from '../core/logger.js';
import { mcpErrorText } from '../core/errors.js';
import type { Envelope } from '../types/hana.js';
import {
  buildContract,
  disclosureIdOf,
  jsonBytes,
  manifestRev,
  policyRevOf,
  type ActionContract,
} from './contracts.js';
import { toToolResult } from './common.js';
import { capabilityRegistrar, type CapabilityHandler, type ToolContext } from './index.js';
import { entitlementOf } from './surface.js';
import { toolFilterOf } from './groups.js';
import { UNKNOWN_CAPABILITY_TEXT } from './unknown.js';

type PolicyStatus = 'ready' | 'blocked' | 'partial';
interface Blocker {
  toolId: string;
  code: string;
  stepId?: string;
}

/** 披露回执的 data 形状（envelope.data） */
interface DisclosureData {
  mode: string;
  [key: string]: unknown;
}

/** 参数/预算错误：与工具的 schema 错误同形（isError + 可恢复提示）。 */
function badArgs(message: string, hint?: string) {
  return mcpErrorText(message, hint);
}

/** zod 错误 → 可读参数卡（只取前 5 条） */
function issuesOf(error: { issues: ReadonlyArray<{ path: readonly PropertyKey[]; message: string }> }): string {
  return error.issues
    .slice(0, 5)
    .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
    .join('；');
}

/** 统一按 envelope 返回，并在出口做 maxResponseBytes 护栏（不静默丢契约）。 */
function respond(data: DisclosureData, maxResponseBytes: number, hintOnBudget: string) {
  const envelope: Envelope = { success: true, data, messages: [] };
  // 交付内容 = 格式化 text + structuredContent（同一 envelope 两份）；按真实字节计，不按紧凑 JSON 估。
  const bytes = Buffer.byteLength(JSON.stringify(envelope, null, 2), 'utf8') + jsonBytes(envelope);
  if (bytes > maxResponseBytes) {
    return badArgs(
      `budget_exceeded：完整响应 ${bytes} 字节超过 maxResponseBytes=${maxResponseBytes}，本次未返回披露包`,
      `${hintOnBudget}\n不静默截断契约：请缩小 tools/limit 或提高 maxResponseBytes 后重试。`,
    );
  }
  return toToolResult(envelope);
}

/** 当前环境绑定（多环境才带 key/epoch；单环境返回 undefined）。 */
function disclosureEnvironment(ctx: ToolContext): { key: string; epoch: number } | undefined {
  const runtime = currentEnvironmentRuntime();
  if (ctx.manager?.multiEnv !== true || !runtime) return undefined;
  return { key: runtime.envKey, epoch: runtime.epoch };
}

function environmentField(ctx: ToolContext, ids: ReadonlySet<string>): Record<string, unknown> {
  const runtime = currentEnvironmentRuntime();
  if (ctx.manager?.multiEnv !== true || !runtime) return { multiEnv: false };
  // switchable 只在「hana_env_switch 真的可经 hana_invoke 执行」时为 true：HTTP 进程级切换不支持，
  // 且 switch 还要求 list 可达 / switchable 非空（见 config/policy-snapshot.ts）。
  const switchable =
    ctx.config.httpPort == null && (ctx.manager?.switchable?.length ?? 0) > 0 && ids.has('hana_env_switch');
  return {
    multiEnv: true,
    key: runtime.envKey,
    epoch: runtime.epoch,
    access: runtime.access,
    switchable,
    ...(switchable ? { switchVia: 'hana_env_list' } : {}),
  };
}

/**
 * canonicalCall 里的写包/读 schema 是否仍来自演示示例（bindings 未覆盖）：
 * 这种参数不是调用方真实目标，据此做资源预判会给出假 blocked/ready。
 * readPackage 只报告不拦截，不在此列。
 */
function hasUnboundResourceArgs(
  cap: Capability,
  args: Record<string, unknown>,
  bindings: Record<string, unknown>,
): boolean {
  const shape = (cap.inputSchema as unknown as { shape?: Record<string, unknown> }).shape;
  if (!shape) return false;
  return Object.entries(shape).some(([name, field]) => {
    const role = resourceRoleOf(field);
    if (role !== 'writePackage' && role !== 'readSchema') return false;
    return Object.hasOwn(args, name) && !Object.hasOwn(bindings, name);
  });
}

/** 对一组「工具 + 预览参数」做 preview，汇总 policy.status 与 blockers。 */
function previewPolicy(
  ctx: ToolContext,
  profile: ReturnType<typeof entitlementOf>['profile'],
  items: Array<{
    cap: Capability;
    args: Record<string, unknown>;
    stepId?: string;
    confidence?: 'full' | 'partial' | 'deferred';
    envAssertion?: { key?: string; epoch?: number };
    /** 资源参数仍是演示值：资源维度的结论不可用（其余维度照常预判） */
    resourceArgsUnbound?: boolean;
  }>,
): { status: PolicyStatus; blockers: Blocker[] } {
  const policy = policyFromConfig(ctx.config, toolFilterOf(ctx.config, ctx.toolFilter));
  const runtime = currentEnvironmentRuntime();
  const blockers: Blocker[] = [];
  let partial = false;
  for (const item of items) {
    if (item.confidence === 'deferred' || item.confidence === 'partial') {
      partial = true;
      continue;
    }
    const result = evaluate({
      policy,
      ...(profile ? { profile } : {}),
      capability: item.cap,
      args: item.args,
      mode: 'preview',
      ...(runtime ? { runtime } : {}),
      ...(item.envAssertion ? { envAssertion: item.envAssertion } : {}),
    });
    // 演示资源值只能说明「这些演示包不在边界内」，不能作为该能力的结论；其余维度（能力/环境）照常。
    const relevantBlocking = item.resourceArgsUnbound
      ? result.verdict.blocking.filter((g) => g.dimension !== 'resource')
      : result.verdict.blocking;
    if (relevantBlocking.length > 0) {
      blockers.push({
        toolId: item.cap.id,
        code: relevantBlocking[0]?.code ?? 'blocked',
        ...(item.stepId ? { stepId: item.stepId } : {}),
      });
    } else if (item.resourceArgsUnbound) {
      // 演示值不构成资源结论：即使恰好落在边界内，也不报 ready。
      partial = true;
    }
  }
  return { status: blockers.length > 0 ? 'blocked' : partial ? 'partial' : 'ready', blockers };
}

/** 把工具的完整契约放进参数卡（tool_search 自身的参数错误也可一次纠偏）。 */
function selfContractCard(): string {
  const { contract } = buildContract(CAP.hana_tool_search, { multiEnv: false });
  return (
    'hana_tool_search 的完整契约：\n```json\n' +
    JSON.stringify(
      {
        required: contract.required,
        inputSchema: contract.inputSchema,
        exampleArgs: contract.exampleArgs,
        constraints: contract.constraints,
        call: contract.call,
      },
      null,
      2,
    ) +
    '\n```'
  );
}

/** 集合 fail-closed：任一 id 未登记/是平台入口/不在 entitlement → 与未知能力逐字同形。 */
function resolveRequestedTools(
  ids: ReadonlySet<string>,
  requested: readonly string[],
): { caps: Capability[] } | { error: string } {
  // 去重但保留声明顺序
  const unique = [...new Set(requested)];
  const caps: Capability[] = [];
  for (const id of unique) {
    const cap = findCapability(id);
    if (!cap || cap.platform === true || !ids.has(id)) {
      return { error: UNKNOWN_CAPABILITY_TEXT };
    }
    caps.push(cap);
  }
  return { caps };
}

/** 配方步骤的参数键校验（只查键，不查类型：步骤引用/占位由 AI 最终替换后重新过完整 schema）。 */
function invalidStepKeys(step: RecipeStep, cap: Capability, multiEnv: boolean): string[] {
  const schema = capabilityInputSchema(cap, multiEnv, 'envelope') as unknown as { shape?: Record<string, unknown> };
  const keys = new Set(Object.keys(schema.shape ?? {}));
  return Object.keys(step.args ?? {}).filter((k) => !keys.has(k));
}

export function registerToolSearchTools(server: McpServer, ctx: ToolContext): void {
  // 启动即校验配方：能力不存在/参数键漂移/引用无来源 → 启动失败（fail-closed）。
  const recipeIssues = validateAllRecipes();
  if (recipeIssues.length > 0) {
    throw new Error(`配方声明与能力清单不同步：\n${recipeIssues.join('\n')}`);
  }

  const regCap = capabilityRegistrar(server, ctx);
  const handler: CapabilityHandler<typeof CAP.hana_tool_search.inputSchema> = async (rawArgs) => {
    const args = rawArgs as ToolSearchArgs;
    const pre = validateToolSearchArgs(args);
    if (pre) {
      return badArgs(
        `参数不符合 hana_tool_search 的调用约束：${pre.issues.join('；')}`,
        `${pre.hint ?? ''}\n${selfContractCard()}`,
      );
    }
    const mode = inferToolSearchMode(args);
    if (mode === 'goal' && ctx.config.toolSearchGoalEnabled === false) {
      return badArgs(
        'goal 模式已按部署配置关闭（HANA_TOOL_SEARCH_GOAL=off）；本次未返回配方',
        '改用 mode=discover 找候选、mode=contract 取完整契约，再按 call.via 调 hana_invoke。',
      );
    }
    const identity = currentIdentity();
    const { ids, profile } = entitlementOf(ctx, identity);
    const runtime = currentEnvironmentRuntime();
    const multiEnv = ctx.manager?.multiEnv === true;
    const maxResponseBytes = args.maxResponseBytes ?? TOOL_SEARCH_LIMITS.maxResponseBytesDefault;
    const manifest = manifestRev();
    const pRev = policyRevOf(ctx.config, toolFilterOf(ctx.config, ctx.toolFilter), profile, runtime);
    const pContext = { profileId: profile?.id ?? '(none)', policyRev: pRev };
    const env = disclosureEnvironment(ctx);
    // 上下文令牌：把环境/代际/策略快照打包签名，执行时只需回传这一个字段。
    const contextToken = issueContextToken({
      profileId: profile?.id ?? '(empty)',
      ...(identity?.clientId ? { clientId: identity.clientId } : {}),
      envKey: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
      epoch: runtime?.epoch ?? 1,
      policyRev: pRev,
      manifestRev: manifest,
    });

    if (mode === 'discover') {
      const candidates = discoverCapabilities(new Set(ids), {
        ...(args.query !== undefined ? { query: args.query } : {}),
        ...(args.category !== undefined ? { category: args.category } : {}),
        ...(args.authorizationClass !== undefined ? { authorizationClass: args.authorizationClass } : {}),
        ...(args.operationType !== undefined ? { operationType: args.operationType } : {}),
        ...(args.limit !== undefined ? { limit: args.limit } : {}),
      });
      const data: DisclosureData = {
        mode: 'discover',
        contextToken,
        total: candidates.length,
        candidates,
        next: 'mode=contract, tools=[候选 id] 获取完整契约',
        notes: [
          'discover 只给候选卡，不含 inputSchema；选定后一次 contract 取完整契约。',
          '执行时把 dispatch 回执里的 contextToken 传给 hana_invoke；有效期 10 分钟，过期重新获取。',
        ],
      };
      return respond(data, maxResponseBytes, '候选过多时请加 query/category 或降低 limit。');
    }

    if (mode === 'contract') {
      const requested = args.tools ?? [];
      const maxTools = args.maxTools ?? TOOL_SEARCH_LIMITS.maxToolsDefault;
      if (requested.length > maxTools) {
        return badArgs(
          `budget_exceeded：tools 数量 ${requested.length} 超过 maxTools=${maxTools}`,
          '请缩小 tools 集合或显式提高 maxTools（硬上限 20）。',
        );
      }
      const resolved = resolveRequestedTools(new Set(ids), requested);
      if ('error' in resolved) return badArgs(resolved.error);

      const bindings = args.bindings ?? {};
      const maxSchemaBytes = args.maxSchemaBytes ?? TOOL_SEARCH_LIMITS.maxSchemaBytesDefault;
      const tools: ActionContract[] = [];
      for (const cap of resolved.caps) {
        const built = buildContract(cap, { multiEnv, bindings, ...(env ? { environment: env } : {}) });
        if (built.missingBindings.length > 0) {
          return badArgs(
            `缺少 bindings：${built.missingBindings.join(', ')}`,
            '为每个 ${bindings.x} 提供值，或改用不带占位符的工具集合。',
          );
        }
        const schema = capabilityInputSchema(cap, multiEnv, 'envelope');
        const parsedExample = schema.safeParse(built.contract.canonicalCall.args);
        if (!parsedExample.success) {
          return badArgs(
            `schema_invalid：${cap.id} 的 canonicalCall 未通过完整 schema：${issuesOf(parsedExample.error)}`,
            '这是服务端示例/绑定值与 schema 不同步；请报告该问题，或传入符合 schema 的 bindings。',
          );
        }
        const preflight = cap.preflight?.(parsedExample.data);
        if (preflight) {
          return badArgs(
            `preflight_failed：${cap.id} 的 canonicalCall 未通过调用约束：${preflight.issues.join('；')}`,
            preflight.hint,
          );
        }
        const schemaBytes = jsonBytes(built.contract.inputSchema);
        if (schemaBytes > maxSchemaBytes) {
          return badArgs(
            `budget_exceeded：${cap.id} 的 inputSchema ${schemaBytes} 字节超过 maxSchemaBytes=${maxSchemaBytes}`,
            '请提高 maxSchemaBytes，或从 tools 中移除该工具。',
          );
        }
        tools.push(built.contract);
      }
      const preview = previewPolicy(
        ctx,
        profile,
        resolved.caps.map((cap, i) => ({
          cap,
          args: tools[i].canonicalCall.args,
          ...(tools[i].canonicalCall.envelope?.expectedEnvironment
            ? { envAssertion: tools[i].canonicalCall.envelope.expectedEnvironment }
            : {}),
          // 资源参数仍是演示值 → 资源维度不可预判，其余维度照常（partial，不产出假 blocked）。
          ...(hasUnboundResourceArgs(cap, tools[i].canonicalCall.args, bindings) ? { resourceArgsUnbound: true } : {}),
        })),
      );
      const toolIds = resolved.caps.map((c) => c.id);
      const disclosureId = disclosureIdOf(manifest, pRev, runtime, toolIds);
      registerDisclosure(disclosureId, {
        toolIds,
        envKey: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
        epoch: runtime?.epoch ?? 1,
        policyRev: pRev,
        manifestRev: manifest,
      });
      const data: DisclosureData = {
        mode: 'contract',
        contextToken,
        disclosureId,
        manifestRev: manifest,
        environment: environmentField(ctx, new Set(ids)),
        tools,
        policy: { status: preview.status, context: pContext, blockers: preview.blockers },
        notes: [
          '工具面未改变：回执里的 call.via 恒为 hana_invoke；执行请调 hana_invoke({capability,args,contextToken})。',
          'canonicalCall 只说明“这样调”，不代表已执行；每次 hana_invoke 仍过统一授权与预检。',
        ],
      };
      logger.info(
        {
          disclosureId: data.disclosureId,
          policyRev: pRev,
          environment: multiEnv ? runtime?.envKey : undefined,
          tools: resolved.caps.map((c) => c.id),
        },
        'tool-search-disclosure',
      );
      return respond(data, maxResponseBytes, '请缩小 tools 集合或提高 maxResponseBytes。');
    }

    // mode === 'goal'
    const goal = args.goal as string;
    if (!isRecipeGoal(goal)) {
      return badArgs(
        `未知配方：${goal}`,
        `可用配方：${RECIPE_GOALS.join(', ')}。模式与参数见 hana_tool_search 的完整契约：\n${selfContractCard()}`,
      );
    }
    const recipe = RECIPES[goal];
    const bindings = args.bindings ?? {};
    const missingRequired = recipe.requiresBindings.filter((k) => !Object.hasOwn(bindings, k));
    const substituted = substituteBindings(recipe.steps, bindings);
    const missingAll = [...new Set([...missingRequired, ...substituted.missing])].sort();
    if (missingAll.length > 0) {
      return badArgs(
        `缺少 bindings：${missingAll.join(', ')}`,
        `配方 ${goal} 需要这些键；只列参数名，不要求领域数据。
` +
          '键名必须是配方参数名（diagnose_preview_permission 用 packageId + objectName，不是 viewName）。' +
          '不知道 packageId 时，先 hana_invoke({capability:"hana_metadata_search_objects", args:{pattern:<objectName>, by:"name", category:"model"}}) 找到对象，或 hana_tool_search({mode:"discover", query:<objectName>}) 取契约。',
      );
    }

    const steps: Array<Record<string, unknown>> = [];
    const used: Array<{
      cap: Capability;
      step: RecipeStep;
      args: Record<string, unknown>;
      confidence: 'full' | 'partial' | 'deferred';
      envAssertion?: { key: string; epoch: number };
    }> = [];
    for (const step of substituted.value as RecipeStep[]) {
      const cap = findCapability(step.capability);
      const visible = cap !== undefined && cap.platform !== true && ids.includes(cap.id);
      if (!visible) {
        if (step.optional === true) continue; // 可选能力级不可见 → 静默去掉
        return badArgs(UNKNOWN_CAPABILITY_TEXT); // 必需能力级不可见 → 整包拒绝、不点名
      }
      const stepArgs = (step.args ?? {}) as Record<string, unknown>;
      const badKeys = invalidStepKeys(step, cap, multiEnv);
      if (badKeys.length > 0) {
        return badArgs(
          `配方 ${goal} 的步骤 ${step.id} 参数键不合法：${badKeys.join(', ')}`,
          '这是服务端配方声明与能力清单不同步；请报告该问题。',
        );
      }
      const refs = collectStepRefs(stepArgs);
      const needsFill = (step.fill ?? []).some((k) => stepArgs[k] === undefined);
      const confidence: 'full' | 'partial' | 'deferred' = refs.length > 0 ? 'deferred' : needsFill ? 'partial' : 'full';
      // 绑定/字面参数完成后，必须重新过完整 schema + preflight；引用/待补步骤留给 AI，
      // 但一旦参数齐全就不允许把类型错误/空必填带进披露包。
      if (confidence === 'full') {
        const schema = capabilityInputSchema(cap, multiEnv, 'envelope');
        const parsedStep = schema.safeParse(stepArgs);
        if (!parsedStep.success) {
          return badArgs(
            `schema_invalid：配方步骤 ${step.id} 参数未通过完整 schema：${issuesOf(parsedStep.error)}`,
            '修正 bindings 或改用 contract 模式逐工具披露。',
          );
        }
        const preflight = cap.preflight?.(parsedStep.data);
        if (preflight) {
          return badArgs(
            `preflight_failed：配方步骤 ${step.id} 未通过调用约束：${preflight.issues.join('；')}`,
            preflight.hint,
          );
        }
      }
      const envAssertion = multiEnv && env && cap.platform !== true ? { key: env.key, epoch: env.epoch } : undefined;
      used.push({ cap, step, args: stepArgs, confidence, ...(envAssertion ? { envAssertion } : {}) });
      const contract = buildContract(cap, { multiEnv, ...(env ? { environment: env } : {}) });
      steps.push({
        id: step.id,
        capability: step.capability,
        via: contract.contract.call.via,
        ...(Object.keys(stepArgs).length > 0 ? { args: stepArgs } : {}),
        ...(step.provides ? { provides: step.provides } : {}),
        ...(step.fill ? { fill: step.fill } : {}),
        ...(step.optional === true ? { optional: true } : {}),
        ...(step.note ? { note: step.note } : {}),
        confidence,
      });
    }

    // 工具契约：按步骤出现顺序去重
    const uniqueCaps = [...new Map(used.map((u) => [u.cap.id, u.cap])).values()];
    const maxSchemaBytes = args.maxSchemaBytes ?? TOOL_SEARCH_LIMITS.maxSchemaBytesDefault;
    const tools: ActionContract[] = [];
    for (const cap of uniqueCaps) {
      const built = buildContract(cap, { multiEnv, ...(env ? { environment: env } : {}) });
      const schemaBytes = jsonBytes(built.contract.inputSchema);
      if (schemaBytes > maxSchemaBytes) {
        return badArgs(
          `budget_exceeded：${cap.id} 的 inputSchema ${schemaBytes} 字节超过 maxSchemaBytes=${maxSchemaBytes}`,
          '请提高 maxSchemaBytes，或改用 contract 模式分步披露。',
        );
      }
      tools.push(built.contract);
    }
    const toolIds = uniqueCaps.map((c) => c.id);
    const disclosureId = disclosureIdOf(manifest, pRev, runtime, toolIds, goal);
    registerDisclosure(disclosureId, {
      toolIds,
      envKey: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
      epoch: runtime?.epoch ?? 1,
      policyRev: pRev,
      manifestRev: manifest,
    });
    const preview = previewPolicy(
      ctx,
      profile,
      used.map((u) => ({
        cap: u.cap,
        args: u.args,
        stepId: u.step.id,
        confidence: u.confidence,
        ...(u.envAssertion ? { envAssertion: u.envAssertion } : {}),
      })),
    );
    const data: DisclosureData = {
      mode: 'goal',
      goal,
      contextToken,
      disclosureId: disclosureIdOf(
        manifest,
        pRev,
        runtime,
        uniqueCaps.map((c) => c.id),
        goal,
      ),
      manifestRev: manifest,
      environment: environmentField(ctx, new Set(ids)),
      steps,
      tools,
      policy: { status: preview.status, context: pContext, blockers: preview.blockers },
      notes: [
        'Recipe 是 AI-managed：服务端只给建议路径与契约，不替 AI 执行整条工作流。',
        '多步变更的预检/补偿/部分失败语义仍由 Changeset/Task 负责；配方不是事务。',
        '工具面未改变：steps[].via 恒为 hana_invoke；逐步调 hana_invoke({capability,args,contextToken})。',
      ],
    };
    logger.info(
      { disclosureId: data.disclosureId, policyRev: pRev, goal, tools: uniqueCaps.map((c) => c.id) },
      'tool-search-disclosure',
    );
    return respond(data, maxResponseBytes, '请降低 maxResponseBytes 的期望或改用 contract 分步披露。');
  };

  regCap(CAP.hana_tool_search, handler);
}
