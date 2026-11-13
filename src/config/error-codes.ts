/**
 * 拦截错误码注册表（用户可查的单一真源）。
 *
 * 约定（见 docs/multi-hana-environment-redesign.md §5.1/§5.2）：
 * - 所有主动拦截显式抛错，错误信息 = 错误码 + 原因 + 处理方案；不得静默忽略/回退；
 * - 启动期与运行期共用同一张表；CONFIG.md 的《错误码速查》从这里生成/校验；
 * - 错误信息不得包含密码/Token；`interceptionError` 只拼接原因与处理方案，不回显环境变量值。
 */

export type ErrorCodeCategory = 'config' | 'environment' | 'authorization' | 'connection';

export interface ErrorCodeSpec {
  code: string;
  category: ErrorCodeCategory;
  summary: string;
  /** 默认处理方案；调用点可覆盖为更具体的下一步 */
  remediation: string;
}

export const ERROR_CODES: readonly ErrorCodeSpec[] = [
  // ── 配置加载 / 环境标识 ──
  {
    code: 'config_invalid',
    category: 'config',
    summary: '配置加载失败（通用明细码）',
    remediation: '按错误信息逐项修正；无法判断时先跑 scripts/migrate-env-config.mjs --check。',
  },
  {
    code: 'env_mode_mismatch',
    category: 'config',
    summary: 'HANA_ENV_MODE 与实际检测到的单/多环境模式不一致',
    remediation: '删掉 HANA_ENV_MODE 让服务自动判断，或改成与 _ENV_ 变量匹配的值。',
  },
  {
    code: 'label_removed',
    category: 'config',
    summary: 'HANA_LABEL / HANA_LABEL_ENV_* 已移除',
    remediation: '删除 LABEL 变量；环境标识直接取 HANA_<PARAM>_ENV_<XXXX> 里的 <XXXX>。',
  },
  {
    code: 'legacy_env_prefix',
    category: 'config',
    summary: '使用了已废弃的 HANA_ENV_<NAME>_<PARAM> 前缀',
    remediation: '改成 HANA_<PARAM>_ENV_<NAME>，例如 HANA_ENV_QAS_HOST → HANA_HOST_ENV_QAS。',
  },
  {
    code: 'env_config_unsupported',
    category: 'config',
    summary: '使用了不支持的 HANA_ENV_CONFIG 文件配置',
    remediation: 'v2 只支持扁平环境变量；请把配置写成 HANA_<PARAM>_ENV_<XXXX> / 共享策略键。',
  },
  {
    code: 'env_key_invalid',
    category: 'config',
    summary: '环境标识非法',
    remediation: '环境标识必须匹配 [A-Za-z][A-Za-z0-9_]{0,31}；旧 LABEL 里的 - 请改成 _。',
  },
  {
    code: 'env_key_conflict',
    category: 'config',
    summary: '同一参数存在仅大小写不同的两个 _ENV_ 键',
    remediation: '只保留一个键，或把两个键统一成同一大小写。',
  },
  {
    code: 'env_key_unknown',
    category: 'config',
    summary: 'HANA_ENV_START / HANA_ENV_SWITCHABLE / 切换请求引用了未配置的环境标识',
    remediation: '先调用 hana_env_list（或看启动摘要）确认可用环境标识；匹配大小写不敏感。',
  },
  {
    code: 'process_param_scoped',
    category: 'config',
    summary: '进程级参数被写成了 _ENV_ 形式',
    remediation: '进程级参数只能扁平写；检查 HANA_TOOL_* / MCP_* / LOG_LEVEL / HANA_TIMEZONE 等是否误加 _ENV_。',
  },
  {
    code: 'missing_connection_param',
    category: 'config',
    summary: '某个多环境缺少连接参数',
    remediation: '为该环境补 HANA_<PARAM>_ENV_<XXXX>；HOST/PORT/USER/PASSWORD 没有共享回退。',
  },
  {
    code: 'env_start_required',
    category: 'config',
    summary: '多环境未指定启动环境',
    remediation: '设置 HANA_ENV_START=<环境标识>；只有一个环境时可省略。',
  },
  {
    code: 'env_switchable_in_single',
    category: 'config',
    summary: '单环境部署却配置了可切换列表',
    remediation: '删除 HANA_ENV_SWITCHABLE，或补充 _ENV_ 变量进入多环境模式。',
  },

  // ── 环境与切换 ──
  {
    code: 'env_readonly',
    category: 'environment',
    summary: '只读环境拒绝了持久写入能力',
    remediation: '切到 ACCESS=readwrite 的环境，或为该环境使用只读账号；临时对象与纯读不受影响。',
  },
  {
    code: 'env_assertion_missing',
    category: 'environment',
    summary: '多环境非纯读调用缺少 expectedEnvironment',
    remediation: '传入当前环境标识（与 hana_env_list 的 current 一致，大小写不敏感）。',
  },
  {
    code: 'env_assertion_mismatch',
    category: 'environment',
    summary: 'expectedEnvironment 与当前环境不一致',
    remediation: '先确认是否忘了切回；用 hana_env_list 查看当前环境后重试。',
  },
  {
    code: 'env_switch_disabled',
    category: 'environment',
    summary: '环境切换未启用',
    remediation: '需要多环境部署且 HANA_ENV_SWITCHABLE 非空。',
  },
  {
    code: 'env_switch_http_unsupported',
    category: 'environment',
    summary: 'HTTP 模式不支持进程级环境切换',
    remediation: '改用一进程一环境，或配置 MCP_HTTP_CLIENT_ENVS 做 Token→环境绑定。',
  },
  {
    code: 'env_switch_target_not_allowed',
    category: 'environment',
    summary: '目标环境不在 HANA_ENV_SWITCHABLE 中',
    remediation: '把目标环境标识加入 HANA_ENV_SWITCHABLE 后重启。',
  },
  {
    code: 'env_switch_from_mismatch',
    category: 'environment',
    summary: '切换请求的 from 与当前环境不一致',
    remediation: '用 hana_env_list 重新取 current 后再切换。',
  },
  {
    code: 'env_switch_epoch_stale',
    category: 'environment',
    summary: '切换请求的 epoch 已过期',
    remediation: '重新调用 hana_env_list 获取最新 epoch/token 后再切换。',
  },
  {
    code: 'env_switch_token_invalid',
    category: 'environment',
    summary: '切换 token 无效或已使用/过期',
    remediation: '重新调用 hana_env_list 获取一次性 token（默认 60s 有效）。',
  },
  {
    code: 'env_switch_confirm_mismatch',
    category: 'environment',
    summary: 'confirm 与目标环境标识不一致',
    remediation: '把 confirm 设为与 to 相同的环境标识（大小写不敏感）。',
  },
  {
    code: 'env_switch_busy',
    category: 'environment',
    summary: '有其它调用在途，切换被拒绝',
    remediation: '等当前调用结束后重试；切换失败会保持原环境。',
  },
  {
    code: 'env_already_active',
    category: 'environment',
    summary: '目标环境已经是当前 active',
    remediation: '无需切换；如需刷新状态请重新调用 hana_env_list。',
  },
  {
    code: 'env_switch_target_has_running_tasks',
    category: 'environment',
    summary: '目标环境有运行中任务',
    remediation: '确认可共享池后显式传 acknowledgeRunningTasks=true。',
  },
  {
    code: 'env_switch_target_unreachable',
    category: 'environment',
    summary: '目标环境连接预检失败',
    remediation: '检查目标环境的 HOST/PORT/USER/PASSWORD 与网络；切换未执行，原环境保持不变。',
  },

  // ── 能力与资源授权 ──
  {
    code: 'boundary_off',
    category: 'authorization',
    summary: '写边界未启用（HANA_WRITE_PACKAGES 为空）',
    remediation: '配置 HANA_WRITE_PACKAGES（或对应的 _ENV_ 覆盖）；空 = 声明写包的调用被拒。',
  },
  {
    code: 'target_outside_boundary',
    category: 'authorization',
    summary: '目标包不在可写范围内',
    remediation: '把目标包加入 HANA_WRITE_PACKAGES（或其 _ENV_ 覆盖），或改写到允许的包。',
  },
  {
    code: 'profile_unknown',
    category: 'authorization',
    summary: '调用方档案无法解析',
    remediation: '检查 MCP_PROFILE / MCP_HTTP_TOKENS 第三段是否指向已定义的档案。',
  },
  {
    code: 'kind_not_allowed_by_profile',
    category: 'authorization',
    summary: '档案不允许该能力分类',
    remediation: '换用允许该分类的档案，或调整 MCP_PROFILES（只能收紧，不能放宽部署策略）。',
  },
  {
    code: 'capability_not_in_profile',
    category: 'authorization',
    summary: '能力不在档案允许的 glob 范围内',
    remediation: '调整 MCP_PROFILES 的 glob，或换用其它档案。',
  },
  {
    code: 'write_package_outside_profile',
    category: 'authorization',
    summary: '目标包不在档案的写包范围内',
    remediation: '调整档案的 resourceScopes（若已启用），或换用允许该包的档案。',
  },
  {
    code: 'schema_outside_profile',
    category: 'authorization',
    summary: 'schema 不在档案允许的读取范围内',
    remediation: '调整档案的 resourceScopes（若已启用），或换用允许该 schema 的档案。',
  },
  {
    code: 'tool_not_exposed',
    category: 'authorization',
    summary: '能力未对当前调用方暴露',
    remediation: '检查 HANA_TOOL_GROUPS / HANA_TOOL_ALLOW / HANA_TOOL_DENY 与档案。',
  },
  {
    code: 'unknown_capability',
    category: 'authorization',
    summary: '能力 id 不存在',
    remediation: '通过门面索引获取可用能力 id。',
  },
  {
    code: 'schema_not_allowed',
    category: 'authorization',
    summary: 'schema 不在读取白名单内',
    remediation: '把 schema 加入 HANA_READ_SCHEMA（或对应的 _ENV_ 覆盖）。',
  },

  // ── 连接与部署 ──
  {
    code: 'tls_plaintext',
    category: 'connection',
    summary: 'SQL 连接未启用 TLS',
    remediation: '设置 HANA_TLS=true（或对应环境的 HANA_TLS_ENV_<XXXX>=true）。',
  },
  {
    code: 'xs_plaintext',
    category: 'connection',
    summary: 'XS 写通道使用明文 HTTP',
    remediation: '设置 HANA_XS_TLS=true，或把 XS 端点限制在可信网络内。',
  },
  {
    code: 'http_exposed_without_auth',
    category: 'connection',
    summary: 'HTTP 对外监听但未配置认证',
    remediation: '配置 MCP_HTTP_TOKENS，或显式设置 MCP_HTTP_ALLOW_ANONYMOUS=true 承担风险。',
  },
  {
    code: 'encrypted_but_unauthenticated',
    category: 'connection',
    summary: 'TLS 未校验证书',
    remediation: '设置 HANA_SSL_VALIDATE=true，或确认内网自签场景的风险。',
  },
  {
    code: 'no_request',
    category: 'connection',
    summary: '没有可用的调用上下文',
    remediation: '重试调用；若持续出现请查看服务端日志。',
  },
  {
    code: 'target_invalid',
    category: 'connection',
    summary: '目标对象/包名非法',
    remediation: '检查对象名与包路径是否符合仓库命名规则。',
  },
  {
    code: 'profile_glob_matches_nothing',
    category: 'authorization',
    summary: '档案 glob 没有命中任何能力',
    remediation: '检查 MCP_PROFILES 的 glob 拼写与能力 id。',
  },
  {
    code: 'profile_glob_partly_hidden',
    category: 'authorization',
    summary: '档案 glob 命中的部分能力被部署策略隐藏',
    remediation: '这是预期收紧；如需使用，调整部署的 HANA_TOOL_*。',
  },
  {
    code: 'profile_kind_not_in_policy',
    category: 'authorization',
    summary: '档案声明的 kind 超出部署策略',
    remediation: '档案只能收紧部署策略；调整 MCP_PROFILES 或部署的 HANA_TOOL_GROUPS。',
  },
];

export const ERROR_CODE_BY_CODE = new Map(ERROR_CODES.map((e) => [e.code, e]));

/** 取错误码定义；未登记时返回 undefined（调用点应优先使用已登记码） */
export function errorCodeSpec(code: string): ErrorCodeSpec | undefined {
  return ERROR_CODE_BY_CODE.get(code);
}

/**
 * 构造拦截错误：`[code] 原因。处理方案：…`。
 * 只拼接原因与处理方案，**不读取/回显环境变量值**（调用点也不得把密码/Token 放进 detail）。
 */
export function interceptionError(code: string, detail: string, remediation?: string): Error {
  const spec = errorCodeSpec(code);
  const next = remediation ?? spec?.remediation ?? '请对照 CONFIG.md《错误码速查》处理。';
  return new Error(`[${code}] ${detail} 处理方案：${next}`);
}

/** 生成 CONFIG.md 速查表行（文档/测试共用；中文列：错误码 | 含义 | 处理方案） */
export function formatErrorCodeTable(category?: ErrorCodeCategory): string {
  const rows = ERROR_CODES.filter((e) => category === undefined || e.category === category).map(
    (e) => `| \`${e.code}\` | ${e.summary} | ${e.remediation} |`,
  );
  return ['| 错误码 | 含义 | 处理方案 |', '|---|---|---|', ...rows].join('\n');
}
