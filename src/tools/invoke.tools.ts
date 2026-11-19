/**
 * `hana_invoke`：唯一执行入口。
 *
 * 与旧分类门面路由的区别：
 * - 没有分类扇出边界：`capability` 是全局 id（含操作级别名），但**平台入口自身不可作为目标**；
 * - 没有索引分支：选工具只由 `hana_tool_search` 负责；
 * - 其余不变：按目标能力授权、服务端 schema 校验、跨字段预检、审批与审计。
 *
 * 三条硬约束：
 * 1. 授权按目标能力判定（不是按入口名）；入口自身也先过一遍闸门；
 * 2. 参数在服务端按目标能力 schema 校验（客户端 schema 只是便利）；
 * 3. 未知能力与无权能力逐字同形，不泄漏存在性。
 */

import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { CAP, findCapability, manifestRev } from '../capabilities/manifest.js';
import { isPlatformToolId, type Capability } from '../capabilities/types.js';
import { INVOKE_SCHEMA } from '../capabilities/defs/invoke.js';
import { blockedCallResult, dispatchAuthorized } from '../config/authorize.js';
import { policyFromConfig } from '../config/preflight.js';
import { approvalGate } from '../config/approval.js';
import { capabilityInputSchema, type EnvironmentAssertion } from '../config/environment-policy.js';
import { verifyContextToken } from '../config/context-token.js';
import type { CallerProfile } from '../config/profiles.js';
import { BLOCKED_PREFIX, mcpErrorText } from '../core/errors.js';
import { logger } from '../core/logger.js';
import { currentEnvironmentRuntime } from '../core/environment-context.js';
import { currentIdentity } from '../core/request-context.js';
import { currentExecutionContext } from '../core/execution-context.js';
import { buildContract, policyRevOf } from './contracts.js';
import { capabilityRegistrar, type CapabilityHandler, type ToolContext } from './index.js';
import { getRawHandler } from './handler-registry.js';
import { UNKNOWN_CAPABILITY_TEXT } from './unknown.js';
import { entitlementOf } from './surface.js';
import { toolFilterOf } from './groups.js';

/** 未知/无权能力的**同一句**回执（不变量 D；两者必须逐字相同） */
export { UNKNOWN_CAPABILITY_TEXT };

/**
 * 拒绝分支的 capability-audit 载荷——与 config/authorize.ts 的 CapabilityAuditEvent 同形。
 * profileId 取解析后的生效档案；resources 恒在场（入口无资源维度，按空数组约定）；via 归因到执行入口。
 */
function blockAuditPayload(
  ctx: ToolContext,
  identity: { clientId?: string; transport?: 'http' | 'stdio' } | undefined,
  profile: CallerProfile | undefined,
  capabilityId: string,
  codes: string[],
): Record<string, unknown> {
  const runtime = currentEnvironmentRuntime();
  const execution = currentExecutionContext();
  return {
    ...(execution ? { requestId: execution.requestId } : {}),
    capabilityId,
    result: 'denied',
    verdict: 'block',
    ...(identity?.clientId ? { clientId: identity.clientId } : {}),
    ...(identity?.transport ? { transport: identity.transport } : {}),
    ...(profile ? { profileId: profile.id } : {}),
    ...(ctx.config.agentLabel ? { agentLabel: ctx.config.agentLabel } : {}),
    ...(runtime?.multiEnv
      ? {
          environment: runtime.envKey,
          epoch: runtime.epoch,
          access: runtime.access,
          calledFromEnvironment: runtime.envKey,
        }
      : {}),
    via: 'hana_invoke',
    resources: { writePackages: [], readSchemas: [], readPackages: [] },
    codes,
    denyReason: codes[0] ?? 'denied',
  };
}

/**
 * 参数校验失败时返回给模型的“参数卡”。
 * 错误回执即完整契约（I5）：模型不必再调一次 tool_search，也不会因为只看到
 * “参数不符合 schema” 而继续换工具/猜参数名。
 */
function schemaErrorHint(target: Capability, args: unknown, multiEnv: boolean): string {
  const runtime = currentEnvironmentRuntime();
  const environment = multiEnv && runtime ? { key: runtime.envKey, epoch: runtime.epoch } : undefined;
  const { contract } = buildContract(target, { multiEnv, ...(environment ? { environment } : {}) });
  const record =
    typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  const passed = Object.keys(record);
  const schemaProperties = (contract.inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  const schemaKeys = new Set(Object.keys(schemaProperties ?? {}));
  const unexpectedArgs = passed.filter((name) => schemaKeys.size > 0 && !schemaKeys.has(name));
  // 错误回执只用来纠偏，不搬运大对象：字符串截断，数组/对象只给规模
  const summarize = (value: unknown): unknown => {
    if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
    if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
    if (Array.isArray(value)) return `[${value.length} items]`;
    if (typeof value === 'object') return `{${Object.keys(value).length} keys}`;
    return typeof value;
  };
  const card = {
    capability: target.id,
    required: contract.required,
    inputSchema: contract.inputSchema,
    ...(contract.exampleArgs ? { exampleArgs: contract.exampleArgs } : {}),
    ...(contract.constraints ? { constraints: contract.constraints } : {}),
    ...(contract.requires ? { requires: contract.requires } : {}),
    ...(contract.returns ? { returns: contract.returns } : {}),
    call: contract.call,
    ...(environment ? { currentEnvironment: environment.key, currentEpoch: environment.epoch } : {}),
    ...(unexpectedArgs.length > 0 ? { unexpectedArgs } : {}),
    got: Object.fromEntries(passed.map((name) => [name, summarize(record[name])])),
  };
  return (
    `该能力的完整契约（参数卡）：\n\`\`\`json\n${JSON.stringify(card, null, 2)}\n\`\`\`\n` +
    '按 required/inputSchema/exampleArgs 修正后重新调用 hana_invoke({capability, args})；不要猜参数名。'
  );
}

/** 注册唯一执行入口。必须先于各能力模块登记，目标 handler 才能全部入表。 */
export function registerInvokeTools(server: McpServer, ctx: ToolContext): void {
  const regCap = capabilityRegistrar(server, ctx);
  const handler: CapabilityHandler<typeof INVOKE_SCHEMA> = async (
    { capability, args, expectedEnvironment, disclosure, disclosureId, contextToken },
    serverCtx,
  ) => {
    // 令牌优先：带 token 时由 token 校验环境/代际/策略/清单，旧 disclosure 字段不再参与。
    const disclosureCtx =
      contextToken !== undefined ? undefined : (disclosure ?? (disclosureId ? { id: disclosureId } : undefined));
    const identity = currentIdentity();
    // profile 随 entitlement 一并解析：目标分支的 authorizeCall 直接复用，不二次推导回退规则
    const { ids, profile } = entitlementOf(ctx, identity);

    // ── 目标解析：未登记 / 平台入口 / 不在 entitlement → 逐字同形 ───────────────
    const target = findCapability(capability);
    if (!target || isPlatformToolId(target.id) || !ids.includes(target.id)) {
      logger.warn(blockAuditPayload(ctx, identity, profile, capability, ['unknown_capability']), 'capability-audit');
      return mcpErrorText(UNKNOWN_CAPABILITY_TEXT);
    }

    // 服务端按目标能力的 schema 校验（客户端 schema 只是便利，不是校验层）。
    // 环境断言：contextToken 优先；旧调用把 expectedEnvironment/expectedEpoch 放在 args 里——
    // 剥出来按信封处理，兼容但不写入 args。
    const runtime = currentEnvironmentRuntime();
    const multiEnv = ctx.manager?.multiEnv === true;
    const tokenVerdict =
      contextToken !== undefined
        ? verifyContextToken(contextToken, {
            profileId: profile?.id ?? '(empty)',
            ...(identity?.clientId ? { clientId: identity.clientId } : {}),
            envKey: runtime?.multiEnv ? runtime.envKey : 'DEFAULT',
            epoch: runtime?.epoch ?? 1,
            policyRev: policyRevOf(ctx.config, toolFilterOf(ctx.config, ctx.toolFilter), profile, runtime),
            manifestRev: manifestRev(),
          })
        : undefined;
    if (tokenVerdict !== undefined && !tokenVerdict.ok) {
      logger.warn(blockAuditPayload(ctx, identity, profile, target.id, ['context_stale']), 'capability-audit');
      return mcpErrorText(
        `${BLOCKED_PREFIX}（context_stale: ${tokenVerdict.reason}），请求未执行`,
        '请重新调用 hana_tool_search（discover/contract/goal）获取最新 contextToken；切换环境后必须重新获取。',
      );
    }
    const rawArgs = { ...(args ?? {}) } as Record<string, unknown>;
    let envAssertion: EnvironmentAssertion | undefined = tokenVerdict?.ok
      ? { key: tokenVerdict.payload.e, epoch: tokenVerdict.payload.n }
      : expectedEnvironment;
    if (rawArgs['expectedEnvironment'] !== undefined || rawArgs['expectedEpoch'] !== undefined) {
      const legacyKey = typeof rawArgs['expectedEnvironment'] === 'string' ? rawArgs['expectedEnvironment'] : undefined;
      const legacyEpoch = typeof rawArgs['expectedEpoch'] === 'number' ? rawArgs['expectedEpoch'] : undefined;
      if (!envAssertion && (legacyKey !== undefined || legacyEpoch !== undefined)) {
        envAssertion = {
          ...(legacyKey !== undefined ? { key: legacyKey } : {}),
          ...(legacyEpoch !== undefined ? { epoch: legacyEpoch } : {}),
        };
      }
      delete rawArgs['expectedEnvironment'];
      delete rawArgs['expectedEpoch'];
    }
    const parsed = capabilityInputSchema(target, multiEnv, 'envelope').safeParse(rawArgs);
    if (!parsed.success) {
      // 审计不能缺席：schema 失败也是按目标能力的拒绝。
      logger.warn(blockAuditPayload(ctx, identity, profile, target.id, ['input_schema_invalid']), 'capability-audit');
      const issues = parsed.error.issues
        .slice(0, 5)
        .map((i) => `${i.path.join('.') || '(根)'}: ${i.message}`)
        .join('；');
      return mcpErrorText(`参数不符合 ${target.id} 的 schema：${issues}`, schemaErrorHint(target, rawArgs, multiEnv));
    }

    // 跨字段预检：schema 通过但业务约束不成立（如 by=name 缺 pattern、勘察/视图目标混用）。
    const preflight = target.preflight?.(parsed.data);
    if (preflight) {
      logger.warn(blockAuditPayload(ctx, identity, profile, target.id, ['input_schema_invalid']), 'capability-audit');
      const card = schemaErrorHint(target, rawArgs, multiEnv);
      return mcpErrorText(
        `参数不符合 ${target.id} 的调用约束：${preflight.issues.join('；')}`,
        preflight.hint ? `${preflight.hint}\n${card}` : card,
      );
    }

    // 按目标能力授权 → 派发 → 写能力终态审计：与直调**同一个执行壳**（dispatchAuthorized）。
    return dispatchAuthorized(
      target,
      parsed.data as Record<string, unknown>,
      {
        policy: policyFromConfig(ctx.config, toolFilterOf(ctx.config, ctx.toolFilter)),
        profile,
        agentLabel: ctx.config.agentLabel,
        via: 'hana_invoke',
        policyRevExtras: {
          readonlySql: runtime?.config.readonlySql ?? ctx.config.readonlySql ?? 'select-only',
          approvalPolicy: ctx.config.approvalPolicy,
        },
        ...(envAssertion ? { envAssertion } : {}),
        ...(disclosureCtx ? { disclosure: disclosureCtx } : {}),
      },
      async () => {
        // 派发到原始 handler（闸门已在执行壳里按目标能力跑过；不走 SDK callTool 以免二次过闸）
        const raw = getRawHandler(server, target.id) as CapabilityHandler<typeof target.inputSchema> | undefined;
        if (!raw) {
          // 可触达但本进程没有 handler：编程错误（清单登记与注册不同步）
          logger.error({ capabilityId: target.id, via: 'hana_invoke' }, '执行入口：目标能力的 handler 未注册');
          return mcpErrorText(UNKNOWN_CAPABILITY_TEXT);
        }
        return raw(parsed.data as never, serverCtx as ServerContext);
      },
      (blocked) => blockedCallResult(blocked),
      () =>
        approvalGate(
          target,
          parsed.data as Record<string, unknown>,
          ctx.config.approvalPolicy,
          serverCtx as ServerContext,
          identity?.clientId,
        ),
    );
  };

  regCap(CAP.hana_invoke, handler);
}

/** 保留导出：测试与调用方按同一句话断言未知/无权同形 */
export function invokeContractCard(): string {
  const { contract } = buildContract(CAP.hana_invoke, { multiEnv: false });
  return `hana_invoke 的完整契约：\n\`\`\`json\n${JSON.stringify(contract, null, 2)}\n\`\`\``;
}
