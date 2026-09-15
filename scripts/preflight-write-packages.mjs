#!/usr/bin/env node
/**
 * preflight-write-packages.mjs —— 写边界执行前预检的 CLI 入口（退出码判定）。
 *
 * 本文件只是薄壳：真正「从哪读配置、怎么判定」在预检层 src/config/preflight.ts（编译产物
 * dist/config/preflight.js）。本脚本不重写任何判定规则，避免出现第二套实现。
 *
 * 用途：在执行任何会写入 HANA 仓库的任务（verify:* 脚本、hana_view_ 系列写工具、
 * hana_package_create / hana_repo_import、手工写包）之前，先用它判定「目标包是否落在
 * 生效的可写包范围内」。不通过就不要开始执行——而不是跑到某个写操作上才被服务端拒绝，
 * 或边界根本没生效却一路放行。
 *
 * 用法：
 *   node scripts/preflight-write-packages.mjs <包名...> [--tool <工具名>...] [--schema <schema>...]
 *                                            [--from <mcp.json>] [--server <名字>]
 *
 * 退出码：
 *   0 = 声明的能力全部落在生效配置允许范围内，可以执行
 *   1 = 预检未通过（写包越界 / 工具不可见 / schema 不允许 / 未声明任何能力），不应继续执行
 *   2 = 用法或环境错误（参数缺失、配置读不到、dist 未构建）
 *
 * 配置来源（三处配置可能给出三个不同答案，故必须选对）：
 *   默认            = 与服务启动同源的解析链：进程环境变量，缺失时用仓库 .env 兜底
 *                     （凭据三件套齐备时跳过 .env——与服务器 tryLoadDotEnv 的行为一致）
 *   --from <文件>   = 以该 mcp.json 的 env 为准。本地模式（.dsh/mcp.json）经客户端注入的正是
 *                     这份，它与仓库 .env 不是同一个来源，必须单独校验
 *
 * 只读：不写任何文件、不连 HANA、不发起任何写操作。
 */
const EXIT_OK = 0;
const EXIT_BLOCKED = 1;
const EXIT_USAGE = 2;

function usage() {
  console.log(`用法: node scripts/preflight-write-packages.mjs <包名...> [--tool <工具名>...] [--schema <schema>...]
                                          [--from <mcp.json>] [--server <名字>]

  <包名...>          本次执行将写入的仓库包（可多个），如 ZDEMO 或 ZDEMO.SUB
  --tool <工具名>    本次将调用的工具（可重复），如 --tool hana_view_create
  --schema <名>      本次将读取的 schema（可重复），如 --schema SAPABW
  --from <文件>      以指定 mcp.json 的 env 为配置来源（本地模式用，如 .dsh/mcp.json）
  --server <名字>    --from 指向的文件含多个 server 时，指定用哪一个

至少声明一项能力（包/工具/schema），否则无从判定、一律拦截。
退出码: 0=通过 / 1=预检未通过（不要执行） / 2=用法或环境错误`);
}

/** 解析命令行（极简：只认本脚本需要的几个形式） */
function parseArgs(argv) {
  const targets = [];
  const tools = [];
  const schemas = [];
  let fromFile;
  let serverName;
  const need = (v, flag) => {
    if (!v) throw new Error(`${flag} 缺少取值`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--help' || a === '-h') return { help: true, targets, tools, schemas, fromFile, serverName };
    if (a === '--from') { fromFile = need(argv[++i], '--from'); continue; }
    if (a === '--server') { serverName = need(argv[++i], '--server'); continue; }
    if (a === '--tool') { tools.push(need(argv[++i], '--tool')); continue; }
    if (a === '--schema') { schemas.push(need(argv[++i], '--schema')); continue; }
    if (a.startsWith('--')) throw new Error(`未知参数：${a}`);
    targets.push(a);
  }
  return { help: false, targets, tools, schemas, fromFile, serverName };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    usage();
    return EXIT_OK;
  }
  // CLI 边界：一项能力都不声明属于用法错误（层里另有 no_needs 守卫，防程序化调用传空）
  if (opts.targets.length === 0 && opts.tools.length === 0 && opts.schemas.length === 0) {
    console.error('[preflight] 未声明任何能力（写包 / 工具 / schema）——无从判定，拒绝在未知目标下放行');
    usage();
    return EXIT_USAGE;
  }

  // 预检层（单一事实源）——判定规则不在本脚本里重写
  let preflight;
  try {
    preflight = await import('../dist/config/preflight.js');
  } catch {
    console.error('[preflight] 无法加载 dist/ —— 请先执行 `npm run build`');
    return EXIT_USAGE;
  }

  const source = opts.fromFile
    ? { kind: 'file', path: opts.fromFile, server: opts.serverName }
    : { kind: 'env' };
  const verdict = preflight.runPreflight({
    source,
    request: { writePackages: opts.targets, tools: opts.tools, schemas: opts.schemas },
  });

  console.log('[preflight] 执行前校验');
  console.log(
    verdict.text
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n'),
  );

  if (!verdict.allowed) {
    // 不在这里给"改哪一项配置即可放行"——本脚本常由 agent 运行，输出会回到模型眼里。
    // 拦截必须只陈述事实并把决定权交回部署方。
    console.error(
      '\n[preflight] ✗ 被 MCP 安全策略拦截——请勿开始执行：声明的能力/资源未全部被服务端策略允许。' +
        '该限制由 MCP 服务端的权限策略施加，需由服务部署方调整；请停止当前任务并上报，不要尝试绕过。',
    );
    return EXIT_BLOCKED;
  }
  const declared = [
    opts.targets.length ? `写包 ${opts.targets.join(', ')}` : '',
    opts.tools.length ? `工具 ${opts.tools.join(', ')}` : '',
    opts.schemas.length ? `schema ${opts.schemas.join(', ')}` : '',
  ].filter(Boolean);
  console.log(`\n[preflight] ✓ 通过——${declared.join('；')} 均在生效配置允许范围内，可以执行`);
  return EXIT_OK;
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    console.error(`[preflight] 用法或环境错误：${e.message}`);
    process.exit(EXIT_USAGE);
  });
