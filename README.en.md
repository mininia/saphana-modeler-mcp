# saphana-modeler-mcp

> 🌐 [中文](README.md) | English

An MCP server for SAP HANA classic Modeler capabilities (TypeScript, Node >= 24.18.1; older versions may crash while loading dependencies, so please upgrade). Targeting on-premise HANA 2.0
(classic `_SYS_REPO` repository modeling), it provides **metadata browsing, data preview, lineage query, and
modeling write operations** for information views (calculation views / attribute views / analytic views) and
repository objects.

Connect via the MCP protocol (both **stdio and Streamable HTTP** transports) to clients such as Claude / IDE: invoke tools to browse, validate, and
(within configured writable packages) create calculation views — no HANA Studio required.

## Project goal

**Let AI complete SAP HANA development on its own.**

Not by handing it a SQL window, but by letting it work the way a modeling engineer does: understand what already
exists and how the objects relate, decide what to change and how, make the change, then confirm it worked —
**semantics it can understand, actions it can complete, boundaries that stay in control**.

The current goal is classic repository modeling and execution-plan analysis; privileges and roles, data transfer and
operations actions are among the plans for the future.

## Overview

| Category | Capability | Tools |
| --- | --- | --- |
| System | Version info, user privileges & modeling capability self-check | `hana_system_get_info`, `hana_check_privileges` |
| Package | Package list/tree, objects in a package (with activation status), create package | `hana_package_list`, `hana_package_list_objects`, `hana_package_create` |
| Metadata | Full definition read, object search, field list, single-field logic tracing, lineage | `hana_metadata_get_view`, `hana_metadata_search_objects`, `hana_metadata_list_fields`, `hana_metadata_get_field_logic`, `hana_metadata_where_used` |
| Table catalog | Accessible table list, table column structure | `hana_table_list`, `hana_table_columns` |
| Data preview | Activated-view data preview (overall / node / derived — three channels, with filtering & input parameters) + preview privilege diagnosis | `hana_data_preview`, `hana_data_preview_diagnose` |
| Modeling write | Create/activate/update/delete calculation views, design-time + runtime validation, validation action query | `hana_view_create`, `hana_view_activate`, `hana_view_update`, `hana_view_delete`, `hana_view_validate`, `hana_view_check_actions` |
| Repository transport | Package export backup (zip), design-time file import, change list | `hana_repo_export`, `hana_repo_import`, `hana_repo_changelist` |
| SQL analysis | SQL analysis conclusion (default): per-item findings + advice + statistics on scans/sizes/joins/engine switches/structure; `analyze=true` goes through the PlanViz channel for **per-operator measured** six panels (bottleneck / actual rows / timeline / parallelism); raw plan only via `raw=true` | `hana_sql_analyze` |
| Stability diagnostics | Instance health check (**readings layer**: memory %, disk & volume IO, backup age, memory allocation failure rate … + **conclusions layer**: twelve checks — disk / services / backup / memory / CPU / alerts / blocked / long transactions / replication / config / deprecated features / encryption; **three states**: ok / abnormal / invisible), session & blocking deep dive, table storage profile (memory / disk / fragmentation / hotness / partition / column / index), historical trend (CPU / memory / disk / network over the past N hours) | `hana_system_health`, `hana_system_activity`, `hana_table_storage`, `hana_system_trend` |

> Full definition read (json/xml) of view objects is provided by `hana_metadata_get_view`; field-level inspection uses `hana_metadata_list_fields` / `hana_metadata_get_field_logic`.

## Quick Start

**Option 1: one-shot via npx (no clone required — recommended for trial)**

```bash
npx github:mininia/saphana-modeler-mcp   # auto clone + build + launch
```

Pair this with the "MCP Client Setup" section below — set `command` to `npx` and `args` to `["github:mininia/saphana-modeler-mcp"]`.

**Option 2: clone & run locally (development / customization)**

```bash
git clone https://github.com/mininia/saphana-modeler-mcp.git
cd saphana-modeler-mcp
npm install          # the @sap/hana-client install-script approval ships in package.json's allowScripts; only if your local npm still flags the script as unreviewed do you need: npm approve-scripts @sap/hana-client
cp .env.example .env # fill in real HANA connection
npm run build
node scripts/smoke-stdio.mjs   # smoke test: handshake + tool registration (no real HANA needed)
```

> Cloning builds from source: `prepare` compiles right after install, and the build toolchain (`typescript`, `@types/node`) lives in `optionalDependencies` — do **not** install with `--omit=optional` (`NODE_ENV=production` and `--omit=dev` are unaffected).

MCP setup: copy `mcp.json.example` to `mcp.json` and fill in real connection details (both `mcp.json` and `.env` are gitignored — **do not commit**). See "MCP Client Setup" below.

## Configuration

Connection info is only allowed from environment variables / `mcp.json` `env` (**stdio mode only**) / a `.env` file. No defaults are provided — the server fails fast on startup if any required value is missing.

| How it runs | Where configuration actually comes from |
| --- | --- |
| **stdio** (spawned by an MCP client) | The client's `mcp.json` `env` block is injected as child-process environment variables → equivalent to environment variables; once the credential triple (`HANA_HOST`+`HANA_USER`+`HANA_PASSWORD`) is complete, `.env` is **not read at all** |
| **Streamable HTTP** (you run `npm start` / a container) | Nothing spawns the process on your behalf, so **`mcp.json` plays no part**; the source is the shell/container environment → `.env` as fallback |

`.env` is looked up in the **working directory first, then the project root** (`dist/` two levels up), and it applies **per variable** — `process.loadEnvFile` never overwrites variables that already exist. So if only part of the credential triple comes from the external environment, the two sources get mixed (the classic case: a leftover `HANA_USER` in your shell silently wins over the one in `.env` while everything else comes from `.env`), which can connect you to a different environment. When the server detects connection targets/credentials coming from more than one source it logs a startup **warning** naming each variable's source — use it to clean up the stray variables.

| Option | Required | Description | Example |
| --- | --- | --- | --- |
| `HANA_HOST` | ✅ | HANA hostname/IP | `hana-host.example` |
| `HANA_PORT` | ✅ | SQL port (**required**; no longer derived from an instance number — `3<instance>13/15` cannot express non-default tenants; digits only) | `31015` / `31041` |
| `HANA_USER` | ✅ | Database username | — |
| `HANA_PASSWORD` | ✅ | Password | — |
| `HANA_LOCALE` | optional | Connection locale, default `zh` | `zh` |
| `HANA_DB_NAME` | optional | Tenant database name (required for MDC) | `SYSTEMDB` / tenant name |
| `HANA_TLS` | optional | TLS encryption, default `true` (fail-closed; set `false` only on trusted links) | `true` |
| `HANA_SSL_VALIDATE` | optional | Validate certificate under TLS, default `true`; set `false` for self-signed certs | `true` |
| `HANA_TIMEZONE` | optional | Process timezone (sets `TZ`, affecting log timestamps and local-time semantics); **not pushed down to the HANA session**. Default `Asia/Shanghai` | `Asia/Shanghai` |
| `HANA_READ_SCHEMA` | optional | Extra queryable schemas (comma-separated, appended to built-in allowlist) | `SAPABAP1,OTHER_SCHEMA` |
| `HANA_WRITE_PACKAGES` | optional | Writable repository package prefixes (comma-separated, incl. sub-packages). **Empty = write boundary not enabled**: requests that declare write packages are hard-blocked by the runtime gate with `boundary_off` (writing requires an explicit configuration; only the service layer is fail-open — see the write-boundary note below); when set, only configured packages and their sub-packages are writable | `ZDEMO1,ZDEMO2.ZDEMO_SD` |
| `HANA_XS_PORT` | optional | XS Classic design-time REST port (**required** for XS-channel capabilities: writes, imports/exports); no longer derived as `80<instance>`, and XS-channel calls fail outright when unset (read-only deployments may omit it) | `8010` |
| `HANA_XS_BASE_PATH` | optional | XS design-time REST base path, default `/sap/hana/xs/dt/base` | — |
| `HANA_POOL_MAX` | optional | HANA connection pool size, default `4` (saturation behavior and deployment sizing: see "Transports → Timeouts & resource governance") | `8` |
| `HANA_POOL_WAIT_MS` | optional | Queue wait timeout when the pool is saturated (ms), default `30000` | `60000` |
| `HANA_POOL_MAX_WAITERS` | optional | Queue cap (entries), default `64` | `128` |
| `HANA_SQL_TIMEOUT_MS` | optional | Statement timeout for the write-path SQL statements, default `60000`; which statements are covered and why there is no global statement timeout: see "Transports → Timeouts & resource governance" | `120000` |
| `HANA_XS_TIMEOUT_MS` | optional | Default XS REST request timeout (ms), default `30000`; coverage — including the shorter fixed login/CSRF timeout — is described in "Transports → Timeouts & resource governance" | `60000` |
| `HANA_XS_XFER_TIMEOUT_MS` | optional | XS Transfer (xfer) import/export timeout (ms), default `300000` (transfers are relaxed separately from the default XS timeout) | `600000` |
| `HANA_ACTIVATION_CONCURRENCY` | optional | Server-side activation concurrency limit (in-process semaphore), default `2`; what it covers, and its known boundaries (import via the Transfer API channel, package-create POST / DELETE): see "Transports → Timeouts & resource governance" | `4` |
| `HANA_TOOL_GROUPS` | optional | Enabled tool groups (comma-separated `read`/`write`/`admin`); **empty = no restriction (all enabled)** | `read` |
| `HANA_TOOL_ALLOW` | optional | Force-enabled tool name globs (registered even if their group is disabled; comma-separated, supports `*`) | `hana_view_validate` |
| `HANA_TOOL_DENY` | optional | Force-disabled tool name globs (highest priority, overrides allow & groups; comma-separated, supports `*`) | `hana_data_preview*` |
| `MCP_PROFILES` | optional | **Caller profiles** (`name=kinds[:glob\|glob][;…]`, kinds joined by `+`). Profiles can only *tighten* the deployment policy; defining any profile requires a `default` one | `analyst=read;dev=read+write:hana_view_*;default=read` |
| `MCP_PROFILE` | optional | Profile used by this process (stdio) and by callers without a profile in their token; must be defined in `MCP_PROFILES` | `default` |
| `MCP_AGENT_LABEL` | optional | Process-level attribution label, written into the envelope and every `capability-audit` record; empty = the field is not emitted | `prod-cn-01` |
| `MCP_CAPABILITY_SURFACE_MAX` | optional | Per-caller **promotion budget** (default 50, 1..1000, same value as hana-cli's `MAX_DYNAMIC_TOOLS`); counted in **tools**, oldest whole category evicted first (FIFO) | `100` |
| `LOG_LEVEL` | optional | Log level, default `info` | `debug` |
| `MCP_HTTP_PORT` | optional | Streamable HTTP port; when set the server starts in HTTP mode (endpoint `/mcp`), unset = stdio (default). `0` = random port | `3000` |
| `MCP_HTTP_HOST` | optional | HTTP listen address, default `127.0.0.1` (loopback only, fail-closed); set explicitly (e.g. `0.0.0.0`) to expose | `127.0.0.1` |
| `MCP_HTTP_TOKEN` | **deprecated** | Kept for backward compatibility only; equivalent to `MCP_HTTP_TOKENS=shared:<token>` (read into the same token→identity table; 401 semantics and attribution unchanged). Scheduled for removal in the next major version — use `MCP_HTTP_TOKENS` for new deployments | — |
| `MCP_HTTP_TOKENS` | optional | Comma-separated `name:token[:profile]` — each token maps to a `clientId` (+ optional caller profile; the two together enter the envelope and the audit log — the only attribution source when clients share one HANA account). `name` is limited to `[A-Za-z0-9_.-]{1,32}`; each `token` must be ≥16 characters (weak-credential guard) **and must not contain `:`** (the colon separates identity from profile); duplicates/invalid entries fail startup; may coexist with `MCP_HTTP_TOKEN` | `alice:<token>:dev,bob:<token>` |
| `MCP_HTTP_ALLOWED_HOSTS` | optional | Allowed `Host` header hostnames (DNS rebinding protection; comma-separated, no ports, IPv6 in brackets), defaults to loopback names only | `localhost,myhost.corp` |
| `MCP_HTTP_ALLOWED_ORIGINS` | optional | Allowed `Origin` hostnames (comma-separated, no scheme/port; requests without an Origin header pass). **Defaults to inheriting `MCP_HTTP_ALLOWED_HOSTS`**; explicitly empty = reject every request carrying an Origin | `localhost` |
| `MCP_HTTP_ALLOW_ANONYMOUS` | optional | Explicitly accepts the risk of "listening externally with no Bearer token" (default `false`). **A non-loopback bind with no token is refused at startup** (in that posture the write boundary, tool groups and schema allowlist are all moot); set it to `true` only when something in front already authenticates (e.g. a reverse proxy) | `false` |

## Transports

Two MCP transports are supported, switched by whether `MCP_HTTP_PORT` is set (all tools/config behave identically):

| Transport | How to enable | Use case |
| --- | --- | --- |
| **stdio** (default) | leave `MCP_HTTP_PORT` unset | Local clients (Claude Desktop / Cursor / VS Code) that spawn the server as a child process |
| **Streamable HTTP** | set `MCP_HTTP_PORT` (e.g. `3000`) and run `npm start` (or `node dist/index.js`) | Remote/containerized deployment, one shared server for multiple clients, MCP clients that connect via `url` |

HTTP mode notes:

- Endpoint `http://<host>:<port>/mcp` (this path only; others → 404); stateless per-request serving (both 2025/2026 protocol-version clients connect), shared connection pool
- **Sessions & isolation**: there are no sessions — every request gets a fresh protocol instance, no `Mcp-Session-Id`, no session-scoped state, so there is no cross-session leakage or session-hijacking surface (and, correspondingly, no session-level quotas or cancellation). The isolation boundary is the server process: all clients share one connection pool, one tool-visibility config and one writable-package allowlist
- **Secure defaults (fail-closed)**:
  - Binds `127.0.0.1` only; the Host/Origin allowlists default to loopback names (DNS rebinding protection). To expose externally you need all of: `MCP_HTTP_HOST=0.0.0.0` + `MCP_HTTP_ALLOWED_HOSTS` including the external hostname (plus `MCP_HTTP_ALLOWED_ORIGINS` for browser-like clients)
  - **Authentication**: set `MCP_HTTP_TOKENS` (or the backward-compatible `MCP_HTTP_TOKEN`; each token ≥16 chars) to enforce bearer-token validation on every request (missing/mismatched → 401); unset = the loopback binding is the access boundary. **External listening without a token is refused at startup** (a blocking deployment invariant, see above); if you really need it, set `MCP_HTTP_ALLOW_ANONYMOUS=true`, and the startup log will warn on every boot
  - Request body capped at 10MB (byte-counted): a declared `Content-Length` over the cap gets a direct 413; chunked uploads are byte-counted locally against the same cap too (the server refuses and closes the connection) — no reverse-proxy limit needed
- **Client identity attribution**: `MCP_HTTP_TOKENS` maps each token to its own `clientId`, carried through the request context into the tool layer —
  - every tool result envelope carries `clientId` (absent in stdio mode, so the envelope shape is unchanged there)
  - every write leaves one audit line in the server log (`clientId` + package + object); stdio logs carry no `clientId`
  - why it matters: the database identity is a single process-level technical account (`HANA_USER`), so `_SYS_REPO`'s `OWNER`/`ACTIVATED_BY` can only ever name that account — with multiple clients the repository side cannot tell callers apart
  - with no token configured (loopback default) every request is attributed to `anonymous`
- **Concurrency & locking** (the real limits when one instance serves multiple clients; every known exception is spelled out):
  - **Protection matrix** (all locks are in-process keyed locks serializing per package/object):
    - **Create** (`hana_view_create`): in-process per-object mutual exclusion (existence check + write are atomic); the loser of a concurrent same-name create gets an explicit conflict error. **Known exception**: the XS REST PUT is create-or-update and the server has **no 409** ⇒ a cross-process concurrent same-name create is last-write-wins; the result carries the post-write version and the new ETag (sources below)
    - **Update** (`hana_view_update`): the baseline is read inside the lock (read-time fetch), then content read and PUT — all within one critical section; concurrent changes surface as an explicit 412 instead of silently overwriting
    - **Activate** (`hana_view_activate`): **new `If-Match`** — inside the lock, "read metadata for the baseline → read content → PUT with If-Match" share one critical section, closing the window where an activation silently reverts someone else's just-committed change
    - **Delete** (`hana_view_delete`): **new `If-Match`** — baseline read inside the lock, then delete; measured server semantics: correct baseline → 204, stale baseline → 412, object already gone → 404
    - **Design-time validation** (`hana_view_validate` design mode): the content read moves inside the lock; the temporary validation object's `_CHKTMP` name carries a short hash and is **at most 29 characters**; **only temp names this call actually created are deleted** — if the derived name collides with an existing real object the call refuses to run (no delete, no modify)
    - **Import** (`hana_repo_import`): locked by target file name (design-time suffix stripped); the existence check treats **only 404 as "does not exist"** (403/network errors are never swallowed); a read-back verifies the write. A cross-process race has no server-side guard and is a known exception
  - **Conflict results (breaking change)**: 412, and 404 in the delete case, no longer come back as MCP hard-error text but as a **business-failure envelope** — `success=false`, a message whose id is `'412'` or `'OBJECT_NOT_FOUND'`. 412 and the 404 returned by the **DELETE verb itself** (the object was concurrently deleted after the pre-delete read) carry `raw.conflict = { httpStatus, providedEtag?, currentETag?, currentVersion?, activatedAt?, currentUnavailable? }`; a 404 from the **pre-delete existence read** (the object never existed) carries only the machine-readable code and no such payload. `currentETag` is re-read at conflict time (the measured 412 response carries no ETag header) and is **not** this write's new baseline. Success results carry the new baseline: create/update/activate take the `etag` from the **write response header** (`etagSource=response-header`; when the header is missing the `etag` is omitted and marked `etagSource=unavailable` — never faked by a re-read) — that baseline **exists only on the xs_rest channel**: a create via repo_rest / inactive_object does not go through the XS write response header and its result carries neither `etag` nor `etagSource`; delete takes it from the pre-delete baseline read and import from the post-write read-back (`etagSource=read-back`). Agents can therefore "re-read automatically → replay the intent" instead of handing the conflict to a human
  - **Known boundary (measured)**: a **concurrent write to the same design-time file** may be rejected server-side with a write error (HTTP **555**, `raw.errorDetail.checkResult.Operations.Write=false`, **the write did not happen**) instead of a 412 precondition failure. That path's result carries **no** `raw.conflict` (its absence is deliberate — no fabricated conflict payload), but `raw.errorDetail.httpStatus` and `checkResult.Operations.Write` are machine-readable. Callers should **re-read the latest version and replay** — do not self-resolve it as a conflict, and do not treat it as written
  - **Dry-run & destructive assessment**: `hana_view_update` supports `dryRun=true` — a **read-only rehearsal** that reads the current design-time definition, applies the submitted xml/operations transform and returns a **normalized structural diff + impact radius (direct downstream (single hop); for the transitive blast radius use `hana_metadata_where_used(depth)`) + destructive assessment**, with **not a single write** (no PUT, no activation, no probe); the result is marked `mode=dryRun` to distinguish it from a real write. A breaking change (assessment table: for a view that **has downstream references** — output-field type change / field drop / rename / output-node re-wiring / data-source change) is admitted **only** when `migration` (`{ strategy: cast | preserve_column | move | acknowledge_dependents }`) explicitly declares a strategy (the first three are **field-level migration strategies** — how the downstream field is migrated: recast / keep the column / follow the rename; `acknowledge_dependents` is the **caller explicitly accepting the downstream breakage, with no field-level migration** declaration — use it when none of the three applies, e.g. a wholesale rollback); without it the server refuses before writing (machine-readable `migration_required`, with the breaking items in `raw.errorDetail.breaking.items`), again **without a single write**. A declaration is merely recorded server-side for audit — it triggers **no automatic migration**; handling downstream views stays with the orchestrator via the impact radius (single hop). Deletion works the same way: `hana_view_delete` requires `migration.strategy=acknowledge_dependents` for a view that has downstream references; with none, no declaration is needed, but a cross-reference query (`_SYS_REPO.ACTIVE_OBJECTCROSSREF`, the impact radius) runs before the DELETE — if that query fails (missing privilege / timeout) the delete fails. One **assessment-exempt channel** must also be kept in mind: `hana_repo_import(overwrite=true)` can overwrite an existing view definition wholesale (an escape hatch meant for backup/restore) and **performs no destructive assessment** (it bypasses dryRun / the `migration` gate); to assess impact first, run `dryRun` against the target or use `hana_view_update` instead
  - **Timeouts & resource governance** (so one agent cannot stall the whole pool):
    - **every** XS REST request has a timeout — including content reads / metadata reads / login (login and CSRF fetch use a shorter fixed timeout), with transfers (xfer import/export) relaxed separately: `HANA_XS_TIMEOUT_MS` / `HANA_XS_XFER_TIMEOUT_MS`
    - the five write-path SQL statements (existence check / fallback direct write / row probe / impact-radius downstream query / `REPOSITORY_REST` call) carry a statement timeout, `HANA_SQL_TIMEOUT_MS`; **no global default is deliberate**: `hana_sql_analyze` (up to 5 minutes) and metadata search are legitimately long statements
    - pool max / queue timeout / queue cap are configurable (`HANA_POOL_MAX` / `HANA_POOL_WAIT_MS` / `HANA_POOL_MAX_WAITERS`, defaults 4 / 30s / 64): when saturated the pool queues, and overflow/timeout return a readable error instead of hanging indefinitely. **Deployment advice: one process per agent — N agents = N×`HANA_POOL_MAX` HANA connections** (⚠ a single `hana_sql_analyze` run with `analyze=true` may execute for up to 5 minutes and hold a pool slot the whole time: with several big statements in flight, other calls may never get a connection)
    - server-side activation has an in-process concurrency semaphore (`HANA_ACTIVATION_CONCURRENCY`, default 2): **on this SPS every write activates** (any valid PUT activates server-side; the `activate` parameter only decides whether failures surface), so the protection surface is **every write that triggers server-side activation** — xs_rest-channel create/update/activate file writes and the design-time validation temp-copy write — not just explicit `activate=true`; **known boundaries (not covered)**: import goes through the Transfer API upload channel (its timeout is relaxed per xfer; a long-held permit would starve other writes), and package-create POST and DELETE are not covered either — there is no measured evidence that they trigger server-side activation (the former only creates a directory, the latter only deletes), so they are not throttled as activations. The keyed lock governs "same object", the semaphore governs "global concurrency" — neither replaces the other
    - the keyed lock has a queue wait timeout (default 60s): a timed-out waiter **does not execute** — there is no "reported timeout but the write still happened"
  - View-definition cache: 60s TTL plus a 200-entry LRU cap, so multi-client fetching cannot grow memory without bound; a successful write invalidates **this process's** cache immediately (cross-process staleness is caught by the `VERSION_ID` light check) — this only upgrades "self-heals within 60s" to "immediately" and is **not** a correctness dependency
  - All of the above locks are **in-process**: multi-process/multi-instance deployments against the same HANA need external serialization (this server is designed as a single instance)
  - **Multi-agent orchestration advice (this server supplies facts, it does not orchestrate)** — sub-agents default to a **multi-process** topology (one stdio process per sub-agent), where in-process locks are invisible to each other and correctness rests only on ETag/If-Match and HANA-side state. The recommended split:
    - **Partition by dependency connected components, one writer per component**: use the downstream closure of `hana_metadata_where_used(depth="all")` to group target objects into connected components and hand each component to exactly one writer; read-only dependencies across components are not write conflicts
    - **Why not "prompt-level file partitioning"**: external evidence (CAID/OpenHands) shows a shared workspace plus prompt-level soft isolation **cannot prevent concurrent-write collisions** — shared context has no event ordering and conventions leak; this is exactly why the invariant "every write path is either If-Match or idempotent" exists (in-process locks are only an accelerator)
    - **There is a ceiling on writer count**: both the evidence and production observation show integration overhead rising and stability dropping beyond 2–4 concurrent writers; prefer serializing writes onto a few writers
    - **Action order after a conflict**: REFRESH (re-read the latest using `raw.conflict.currentETag` from the 412 receipt) → REPLAN (replay the intent against the latest version), **before** any blind merge; re-read and replay rather than escalating the conflict to a human
    - **Writers know their blast radius**: breaking-change verdicts and changeset receipts carry the impact radius / downstream list, so the orchestrator can align "who touched whom" with the component split; the **object-level read/write-set intersection** inside `changeset` mode is rejected wholesale server-side, which complements (not replaces) cross-agent partitioning — the server covers a single call, the orchestrator covers the calls between them
- No built-in OAuth or similar full auth system: when exposing to a network, set `MCP_HTTP_TOKENS` (or the backward-compatible `MCP_HTTP_TOKEN`) and place it behind a reverse proxy / VPN / firewall
- Logs still go to stderr and never pollute the HTTP protocol channel; 401 logs never record the Authorization header value; token plaintext is neither kept in the comparison structures nor echoed into error messages

```bash
MCP_HTTP_PORT=3000 MCP_HTTP_TOKENS='shared:your-long-random-token' node dist/index.js
# → ready (streamable HTTP transport, endpoint /mcp), listening on http://127.0.0.1:3000/mcp
```

## Dynamic surface (category facades + per-category promotion)

Every concrete capability stays (nothing was removed — all of them are still reachable); **the registered surface holds only
the six category facades** — concrete capabilities are indexed and promoted on demand
(mirrors SAP hana-cli's `discover_by_category` + `hana_execute`):

```
registered surface = (six facades ∪ members of promoted categories) ∩ deployment policy ∩ caller profile
reachable entitlement (may you call it) = deployment policy ∩ caller profile  ← index, routing and promotion judge by this
```

The model sees three layers and needs **zero discovery calls**:

| Layer | Content | How it reaches the model |
|---|---|---|
| Facade | `hana_system` / `hana_discovery` / `hana_data` / `hana_insights` / `hana_modeling` / `hana_diagnostics`, descriptions carry the **member list** | resident in `tools/list` |
| Index | the category's concrete capabilities (id / title / kind / one-line summary / param names) | call a facade **with no arguments** |
| Promotion | the category's capabilities become first-class tools (**full schema, flat call**) | any facade call triggers it |
| Operation aliases | `hana_view_update#<op>` (8 of them): **route-only** aliases for issuing a single `operations` op — never registered as tools | call a facade with `capability: 'hana_view_update#rename_field'` |

| What | How |
|---|---|
| See what a category holds | `hana_modeling({})` → the modeling index (only what you are entitled to) |
| Call a capability without promoting | `hana_modeling({ capability: 'hana_view_update', args: { … } })` |
| Issue a single op via its alias | `hana_modeling({ capability: 'hana_view_update#rename_field', args: { packageId, objectName, field: 'A', newName: 'B' } })` — fully equivalent to `hana_view_update({ operations: [{ op: 'rename_field', … }] })` (same handler, same gate); aliases never enter `tools/list` (their registered name would collide with the parent tool) |
| Promote a whole category | call `hana_modeling` (with or without arguments) → its capabilities enter `tools/list`; afterwards call them flat: `hana_view_update({ … })` |
| Remove a whole category entry | `HANA_TOOL_DENY=hana_modeling`, or deny all of its members |
| Remove a single capability | `HANA_TOOL_DENY=hana_view_delete` — it disappears from the index, from routing and from promotion |
| Narrow by group | `HANA_TOOL_GROUPS=read` — narrows the **capability layer** only (the six entrances stay; indexes are filtered by kind), see "Tool Groups" |
| Promotion budget | `MCP_CAPABILITY_SURFACE_MAX` (default 50, same value as hana-cli's `MAX_DYNAMIC_TOOLS`): counted in **tools**; when exceeded the **oldest whole category** is evicted (FIFO). With 30 concrete capabilities this never fires |

**A facade's kind is a summary, not a permission**: `hana_modeling` and `hana_diagnostics` are both `admin` (the strictest
member), but whether they *appear* does not depend on groups at all — **the facade layer is unrestricted** and the six
entrances are always resident. Permissions are judged solely by the **target** capability: out-of-scope members never show
up in an index, and routing/promotion cannot reach them either.

**Security semantics (not relaxed by the dynamic layer)**: ① facades, routing and promotion **never override** `HANA_TOOL_DENY` or a caller profile ("dynamic surface ⊆ static policy") — promotion only moves **entitled** members into the surface; ② routing and the flat call of a promoted tool go through the **same** `authorizeCall` — same verdict, same wording; ③ unknown capability, unauthorized capability, **cross-category routing**, and routing to another facade all reply **verbatim identically** (error wording is not an existence oracle); ④ routed `args` are validated server-side against the target's schema (the schema the client sees is only a convenience); ⑤ every call — including rejected route probes — emits a `capability-audit`; promotion emits an additional `capability-promotion` record.

> **Promotion is in-process state** (invariant F: the surface is a *presentation* facility, not a correctness one): keyed by caller (HTTP = authenticated `clientId`; stdio = `(stdio)`); a restart falls back to "facades only" without errors and never changes an authorization result.
> **Without `MCP_HTTP_TOKENS` configured**: every HTTP caller is `anonymous` and promotions would leak across callers, so **promotion is disabled entirely** (index and routing still work) — a single-tenant assumption.
> Over stdio a promotion registers on the live instance immediately and emits `notifications/tools/list_changed`; over HTTP there is no session and push is structurally unreachable, so the client simply re-lists.

Live verification: `npm run verify:authz` (covers all of the above).

## Tool Groups & Visibility Control

30 business capabilities (28 plus the async task query/cancel pair) are divided into three functional groups. **Note (facade model): only the six category facades are on the registered surface** — concrete capabilities never enter `tools/list` and arrive via facade index + facade routing (see "Dynamic surface"). The visibility settings in this section define the **reachable ceiling** (which tools "exist and may be used"), not the registered surface. You can control visibility via `mcp.json` / `.env` environment variables — invisible capabilities never appear in `tools/list`, cannot be called directly, and do not show up in a facade index. All-empty group switches = no group restriction (the ceiling is the full manifest).

### Three groups

| Group | Description | Capabilities |
| --- | --- | --- |
| **read** (data read) | Access to HANA data/metadata/system info — no repository changes | `hana_system_get_info`, `hana_check_privileges`, `hana_package_list`, `hana_package_list_objects`, `hana_metadata_get_view`, `hana_metadata_search_objects`, `hana_metadata_list_fields`, `hana_metadata_get_field_logic`, `hana_metadata_where_used`, `hana_table_list`, `hana_table_columns`, `hana_data_preview`, `hana_data_preview_diagnose`, `hana_task_get` |
| **write** (write ops) | Modifies design-time repository objects/packages (create/activate/update/delete/design-time validate) plus arbitrary-SQL analysis and cancelling async tasks | `hana_package_create`, `hana_view_create`, `hana_view_activate`, `hana_view_update`, `hana_view_delete`, `hana_view_validate`, `hana_view_check_actions`, `hana_sql_analyze`, `hana_task_cancel` |
| **admin** (admin ops) | Transfer / Change-Tracking APIs and the system-monitoring surface (the tightened exposure tier) | `hana_repo_export`, `hana_repo_import`, `hana_repo_changelist`, `hana_system_health`, `hana_system_activity`, `hana_table_storage`, `hana_system_trend` |

> **The facade layer is unrestricted.** There is exactly **one permission layer — the capability layer**: the six facades are *entrances* and stay resident in `tools/list` under any group configuration (they disappear only via an explicit `HANA_TOOL_DENY` on the facade id, or on all of its members). The group switch only decides the **capability layer** — index / routing / promotion / calls are all judged by the **target** capability's kind. A read-only deployment therefore still sees `hana_modeling` / `hana_diagnostics`, but their indexes list only what you are entitled to — `hana_modeling` keeps its read-tier `hana_task_get` (async-task polling), `hana_diagnostics` is empty (the entrance is there, only what you may use appears inside).

> The `design` mode of `hana_view_validate` briefly writes a temporary validation object `_CHKTMP`, so the whole tool is classified as `write`; there is no mixed split by design/runtime mode — a read-only deployment (`HANA_TOOL_GROUPS=read`) does not expose this tool.
>
> `hana_sql_analyze` is `write`: it **writes no business data and never touches the repository**, but it accepts arbitrary SELECT/WITH query text (`analyze=true` really executes it — execution is restricted to SELECT) and its `planId` mode needs the `OPTIMIZER ADMIN` privilege — it shares the write tier with modeling. **Deployments enabling only read cannot see it** (`HANA_TOOL_GROUPS=read` excludes write/admin).
>
> Groups (kind) are a **permission tier**, not a behavioural profile: the matrix holds "behaviourally read-only but admin-tier" capabilities (the four stability diagnostics, `hana_repo_changelist`, and `hana_repo_export` — which only writes a **local** `saveTo` file) as well as the "arbitrary SQL but write-tier" `hana_sql_analyze`. Client annotations (`readOnlyHint`) describe **behaviour**; the two axes are not derived from each other. Every non-read capability declares an explicit `effects.plan` so that a read-only package parameter (`packageId`) is never misread as a write target.

> **Naming**: these three belong with `HANA_WRITE_PACKAGES` / `HANA_READ_SCHEMA` — all four declare how much of
> the HANA surface this deployment exposes/permits, so they share the `HANA_` prefix (2026-10-14 review reverted
> the 2026-10-08 rename to `MCP_TOOL_*`).
> **There is no alias layer**: `MCP_TOOL_*` is no longer recognised — keeping the old name now shows up in the
> "unrecognised environment variable" startup warning instead of working silently. Unrecognised `HANA_*` / `MCP_*` /
> `LOG_*` variables are reported in the startup log — a typo used to be silently ignored (e.g. `HANA_WRITE_PACKAGE`
> without the trailing `S` left the write boundary wide open with no diagnostic).

### Caller profiles (`MCP_PROFILES`)

When multiple clients share one process, each caller can have its own **surface** (what it may call), not just an identity:

```bash
# name=kinds[:capability-glob|glob], kinds joined by +; ; separates profiles
MCP_PROFILES="analyst=read;dev=read+write:hana_view_*|hana_metadata_*;default=read"
MCP_PROFILE=default                                            # profile used by the stdio process
MCP_HTTP_TOKENS="alice:<token>:dev,bob:<token>:analyst"        # third segment = that identity's profile
```

- **Tighten only, never widen**: a profile can never bring back a capability removed by deployment-level `HANA_TOOL_DENY`, nor extend writable packages / readable schemas. An out-of-scope combination (e.g. `dev=read+write` inside a `HANA_TOOL_GROUPS=read` deployment) **fails startup** — that is not a loophole but a divergence between "the permissions you think you have" and the real ones.
- **Defining `MCP_PROFILES` requires a `default` entry**: HTTP tokens without a third segment and the stdio process both fall back to it; omitting it would misread "no profile specified" as "no restriction".
- Enforcement happens at **call time** (`authorizeCall`); a blocked reply has the same shape as any other policy block ("blocked by the MCP security policy" + machine-readable codes, **no remediation hints**).
- Every call emits a `capability-audit` record (`profileId` / `clientId` / `agentLabel` / `resources` / `codes`; allows at info, blocks at warn).
- A profile name that cannot be resolved (configured but no entry found) → **empty profile = deny everything** (fail-closed).

Live verification: `npm run smoke:http` (two profiles demonstrate isolation: a read-only profile calling a write capability is answered **verbatim identically to an unknown capability** — index and routing cannot even reach it — while the default profile falls back to the deployment boundary `boundary_off`).

### Three config variables (priority: `HANA_TOOL_DENY` > `HANA_TOOL_ALLOW` > `HANA_TOOL_GROUPS`)

| Variable | Semantics | Example |
| --- | --- | --- |
| `HANA_TOOL_GROUPS` | Enabled groups (comma-separated); empty = no restriction | `read` exposes only data-read tools, disables all write tools |
| `HANA_TOOL_ALLOW` | Force-enabled tools — supports both **group names** and tool-name globs (`*`); registered even if their group is disabled | `hana_some_tool` / `write` (whole group) |
| `HANA_TOOL_DENY` | Force-disabled tools (highest priority) — also supports **group names** and globs | `hana_data_preview*` disables all preview tools; `write` disables the whole write group |

> **Group names can be used directly in allow/deny** (`read` / `write` / `admin`): they expand to every tool name in that
> group — the same shape as tableau-mcp's `INCLUDE_TOOLS`/`EXCLUDE_TOOLS` and dataworks-mcp's `TOOL_CATEGORIES`.
> Example: `HANA_TOOL_GROUPS=read,write` + `HANA_TOOL_DENY=write` ⇒ equivalent to a read-only deployment, without listing every `hana_view_*`.

**Typical deployment shapes:**

- **Read-only analyst**: `HANA_TOOL_GROUPS=read` — narrows the reachable ceiling to 14 read-tier capabilities; every write/admin-tier capability is invisible even to a facade index. All six facades stay on the registered surface (the facade layer is unrestricted), but `hana_diagnostics`' index is **empty** and `hana_modeling`'s keeps only the read-tier `hana_task_get` (async-task polling) — the entrance is there, only what you may use appears inside.
- **Modeling developer**: `HANA_TOOL_GROUPS=read,write` — ceiling of read+write tiers; all six facades are on the registered surface (admin-tier capabilities such as `hana_repo_export` or the four stability diagnostics stay unreachable and never appear in an index).
- **Disable specific capabilities**: `HANA_TOOL_DENY=hana_view_delete` — disables delete entirely (it disappears from the index and routing rejects it); the rest are unaffected.

On startup, if filter variables are configured, the log prints the enabled groups and the list of disabled tools for confirmation. An unknown group name (e.g. `HANA_TOOL_GROUPS=read,bogus`) fails fast on startup (fail-closed).

## Environment profile & rules catalog

Beyond the basic facts, `hana_system_get_info` returns two **on-demand** items (no new tools):

- **`profile` (environment profile)**: this environment's HANA version/SPS, privilege tier and activator behavior
  (whether an `xs_rest` write activates immediately). Probed once on first call and cached in-process on success;
  **on probe failure it fails open and is marked "not detected"** (with the cause) and never blocks any call — the
  profile is extra information, not a precondition of anything.
- **`rules` (rules catalog)**: the lookup entry point for the rule objects — **omit `rules`** and you get the
  **catalog** (id + title, token-saving); pass `'all'` or a comma-separated list of rule ids for the **full text**
  (an unknown id is an immediate hard error listing the valid values, never a silent empty result). Dialect / boundary
  / gotcha details moved out of the tool descriptions and session instructions into the rule objects — look them up
  by id when needed. The 16 rule ids (the first 9 are frozen; the rest are later additions):
  - `sql_mode`, `activation_measure`, `write_boundary`, `write_transport`, `write_receipt`, `preview`, `sql_analyze`, `metadata_graph`, `bw_dialect`
  - `model_basics`, `health_check`, `activity_locks`, `storage_profile`, `trend_timeline`
  - `view_ops`, `async_task`

> **Instruction slimming (deliberate)**: prose knowledge has moved item by item from the tool descriptions and
> session instructions into the rule objects — instructions plus the six resident facade descriptions total
> **≤3800** characters (upper bound locked by a unit test; currently measured 3614). **No knowledge was removed**; it changed from
> "injected every session" to "queried on demand" (the saving is ×N with N sub-agents — none of them carries a
> private copy of the details). Do not read the slimming as a capability reduction.

## Tool Reference

30 business capabilities + 8 `hana_view_update#<op>` operation aliases (route-only; never registered as tools) + 6 facades derived from them, all carrying annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`) so hosts can auto-approve and confirm dangerous operations.

> **These capabilities are not on the registered surface**: `tools/list` holds only the six category facades, and every row below is reached via "call a facade with no arguments → take the category index → call the facade with `capability` + `args`". The id in this table is both the capability id and the value for the router's `capability` field.

| Capability id | Facade | Type | Description |
| --- | --- | --- |
| `hana_system_get_info` | `hana_system` | read-only | Version/SID/host/instance/current user & schema; plus environment `profile` and the rules catalog (`rules`: omitted = catalog, `all`/rule ids = full text) |
| `hana_check_privileges` | `hana_system` | read-only | Current user's privilege matrix & modeling capability summary (troubleshooting entry point) |
| `hana_metadata_get_view` | `hana_discovery` | read-only | Full view definition: json=structured definition (nodes/data sources/output fields/variables), xml=raw design-time XML; `version` defaults to `active`; `inactive` reads the unactivated/pending version |
| `hana_package_list` | `hana_discovery` | read-only | Repository package list (with hierarchy depth, owner; supports fragment filter/truncation) |
| `hana_package_list_objects` | `hana_discovery` | read-only | Objects in a package (name/type/version/activation status; supports filter/truncation) |
| `hana_metadata_search_objects` | `hana_discovery` | read-only | Search views by name fragment (default `by=name`); `by=field` reverses the lookup on **output fields** ("who outputs a matching field" — per-candidate parsing, `maxCandidates` cutoff, per-row `matchedFields`); `version` switches activated/unactivated objects |
| `hana_metadata_list_fields` | `hana_discovery` | read-only | View output field list (ID/description/type/aggregation/source/has-formula); `version` switches the version scope |
| `hana_metadata_get_field_logic` | `hana_insights` | read-only | Single-field calculation logic: formula text, referenced source fields & lineage, SQLScript source; with `includeUsage`, adds **field-level downstream lineage** (who consumes this field, scan budget `usageMaxViews`; name-aligned consumers listed separately); `version` applies to both field logic and lineage |
| `hana_metadata_where_used` | `hana_insights` | read-only | Lineage/dependency: upstream (who it depends on) / downstream (who depends on it, incl. runtime refs); `depth` multi-hop closure (default 1; `all` is capped by maxNodes, carrying `depthReached`/`truncated`/`asOf`); `version=inactive` reads the unactivated lineage (`INACTIVE_OBJECTCROSSREF`) |
| `hana_table_list` | `hana_discovery` | read-only | Accessible tables under a given schema |
| `hana_table_columns` | `hana_discovery` | read-only | Table column structure (name/type/length/precision/nullable/comment) |
| `hana_data_preview` | `hana_data` | read-only | Activated-view data preview: overall direct / node intermediate-view / XML-derived — three channels, supports filtering & input parameters; permission-class failures auto-attach a diagnostic report |
| `hana_data_preview_diagnose` | `hana_data` | read-only | Data-preview privilege diagnosis: focuses on analytic-privilege protection and upstream data-source reachability, gives blocking points & grant suggestions |
| `hana_view_create` | `hana_modeling` | write | Create a calculation view within a writable package — two forms: the graphical minimal form (single Projection + single source table full-column passthrough) and **SQL mode** (`mode=sql` + `script`/`scriptColumns`; see `npm run verify:sql-mode`); XS REST write path |
| `hana_view_activate` | `hana_modeling` | write | Activate a design-time calculation view into a runtime column view (XS REST: PUT (with If-Match baseline) + SapBackPack Activate; error details transparent) |
| `hana_view_update` | `hana_modeling` | write | Update a calculation view, one of three: declarative `operations` patch (8 ops — add_join / set_script / set_description / rename_field / drop_field / add_calculated_column / set_attribute_filter / set_variable; server-side deterministic transforms, zero model XML; each also reachable as a route-only alias `hana_view_update#<op>`) / full-XML overwrite / **changeset multi-object batch** (single-call closure: whole-batch preflight incl. object-level read/write-set intersection → per-item execution (each incl. activation) → reverse-order compensation on failure → honest report with `notExecuted` explicitly enumerated; up to 10 actions; each destructive action needs its own migration declaration; **`async=true` runs it as a background task** → immediate taskId, poll with `hana_task_get`, cancel with `hana_task_cancel`). PUT + If-Match optimistic lock; a conflict returns a **business-failure envelope** with `raw.conflict` instead of isError prose |
| `hana_task_get` | `hana_modeling` | read-only | Poll an async task submitted by `hana_view_update(async=true)`: status ∈ working/completed/failed/cancelled, progress, and the terminal `result` (a receipt envelope identical in shape to the sync call). Tasks are visible only to **their own caller** and live in-process (a server restart drops them) |
| `hana_task_cancel` | `hana_modeling` | write | Request cancellation of a running task: takes effect at an **action boundary** (the current action is never interrupted), stops subsequent actions and runs the same **reverse-order compensation** as a failure (executed items return to their pre-batch state; report carries `raw.code=changeset_cancelled`). Terminal tasks cannot be cancelled (honest receipt, no error) |
| `hana_view_delete` | `hana_modeling` | write | Delete a design-time calculation view (DELETE + If-Match optimistic lock; an already-missing object returns machine-readable `OBJECT_NOT_FOUND`; recommend querying where_used first) |
| `hana_view_validate` | `hana_modeling` | write | Dual-mode: design=pre-activation validation (simulates activating a temp copy, original object unaffected); runtime=consistency check on an activated view (SYS.CHECK_CALCULATION_VIEW) |
| `hana_view_check_actions` | `hana_modeling` | write | Query the list of actions supported by the CHECK procedure |
| `hana_package_create` | `hana_modeling` | write | Create a package/directory (XS REST: POST /base/file/<pkg>/; target must be within writable package scope) |
| `hana_repo_export` | `hana_modeling` | admin | Export a package as zip (XS REST Transfer API; saveTo to disk or return base64) |
| `hana_repo_import` | `hana_modeling` | admin | Import design-time files (Transfer API directory target + chunked upload, **activated on landing** (measured; no inactive staging), target must be within writable package scope, re-read status after import; modify existing objects via `hana_view_update`) |
| `hana_repo_changelist` | `hana_diagnostics` | admin | Repository change-list audit (GET /base/change; requires Change Tracking enabled) |
| `hana_sql_analyze` | `hana_diagnostics` | write | SQL analysis: **returns a readable conclusion by default** (one-line summary + per-item findings [risk/warn/info, each with evidence and advice] + statistics); **no raw plan unless `raw=true`**; `sql` = compile only; `planId` = explain a plan-cache entry with runtime stats (needs OPTIMIZER ADMIN); `sql` + `analyze=true` = really executes, then by default goes through the **PlanViz channel** for the same **per-operator measurements** as the official Executed Plan (F8) — the `panels` six panels (Plan Graph / Physical Plan / Execution Time / Timeline / Table Access / Logical Plan) plus measured findings; if the channel is unavailable it falls back to an estimated plan + statement-level statistics and explains why in `notes` (`source=sqlExecuted` marks the fallback). Guards either way: **only SELECT can be executed** (WITH is compile-only; DML/DDL and locking reads are rejected by the rule layer), a single execution is capped at 5 minutes, at most 100 rows, **no data rows returned**) |
| `hana_system_health` | `hana_diagnostics` | admin | Stability health check, returning **readings + conclusions** two layers. `metrics` gives concrete usage (instance memory used/quota/peak and %, host physical memory, database and host resident memory, host and database CPU, per-mount usage, per-purpose volume size, **volume IO failed reads/writes, blocked writes, soft errors**, **memory-object layer: non-swappable memory, allocation failure rate, hit rate, failed shrinks, reclaimability gradient**, backup age, blocked/long-transaction/alert counts, config violations and restart-pending counts, deprecated features in use, encryption status …) — **given whether or not the verdict is ok**, so "what is memory at right now" is answered here. `findings` gives the overall verdict plus per-item level/conclusion/evidence/advice. **Twelve checks**: disk (capacity and IO as two orthogonal readings) / services / backup / memory (host + instance + memory-object layer) / CPU / alerts / blocked / long transactions / replication / **config** (violated restrictions, changed-but-not-restarted, non-default layer overrides — **no "what the value should be" comparison**) / **deprecated features** (upgrade risk, not a current fault) / **encryption** (info-level when data is available — whether encryption is required is a compliance decision, so it stays a reading and never triggers warn/critical; if the view is invisible or unreadable it becomes an unknown and the overall verdict can no longer be ok). **Three states**: ok / abnormal / `unknown` (invisible) — monitoring views are row-filtered by privilege and silently return empty sets, which this tool never reads as "fine"; every item either yields a reading or an `unknown` carrying its cause, and **none may silently disappear**. Capacity units are **GiB**, matching HANA Cockpit |
| `hana_system_activity` | `hana_diagnostics` | admin | Session and blocking deep dive: blocked transactions (including the **who-blocks-whom** connection picture), long-running uncommitted transactions (with undo/version/lock evidence, to tell an idle transaction from a lock-holding one), long-running statements. `sections` picks sections, `minDurationSec` sets the duration floor |
| `hana_table_storage` | `hana_diagnostics` | admin | Table storage profile; each row carries **memory / disk / partitions / fragmentation / read-write counts / last merge / BW classification**. **Seven modes**: `memory`, `disk` (`M_TABLE_PERSISTENCE_STATISTICS.DISK_SIZE`), `fragmentation`, `hotness`, `partition`, plus two **drill-down** modes whose unit is not a table — `column` (column-level memory top with compression type, row count, distinct count, index type, last access; **deliberately not returning `COMPRESSION_RATIO_IN_PERCENTAGE`**, which on this revision produces impossible values such as 361890%) and `index` (index memory top with **the index's share of its table's memory**, measured at 73–83% — table memory alone understates the real cost by nearly half). `schema`/`table` are **filters**; `partition` + `schema` + `table` additionally returns per-partition detail. `partition` **defaults to filtering BW active data tables by ACTIVE** (unclassified / non-BW tables are still listed; `subtype` can be given explicitly to switch) because one BW object is a group of physical tables distinguished only by name suffix. Results are aggregated by (schema, table) before sorting — one view row is one partition. Volume units are **MiB** |
| `hana_system_trend` | `hana_diagnostics` | admin | Historical trend, answering "**is this week worse than last week**" — the other three are snapshots of *now* and cannot answer change. Source `_SYS_STATISTICS.HOST_LOAD_HISTORY_HOST` (one view carrying CPU/memory/disk/network/swap, so no cross-view time-axis alignment). `hours` window, `bucketMinutes` bucket width, `metrics` selects groups (cpu/memory/disk/network/swap); each bucket gives **min/max/avg** plus sample count. **Measured structure**: roughly **one sample every 10 seconds**, 362k rows spanning ~42 days; **`SERVER_TIMESTAMP` is when the snapshot was written, `TIME` is when the sample was taken** (358 distinct TIMEs share one SERVER_TIMESTAMP — using the former collapses an hour into a single point), and this tool uses `TIME`; `INDEX` is a row key, not a service dimension. **Retention is finite**: when the window exceeds it, `retention.coversWindow=false` and caveats state how far back the data actually goes — **the uncovered part is not "fine", it is simply missing**. It deliberately avoids "rising means bad", reporting only first-to-last bucket change |

### The six category facades (these are what `tools/list` actually shows)

| Facade | Category | Direction | Members |
| --- | --- | --- | --- |
| `hana_system` | system | Connection & environment: who you are and what you are connected to (version, privilege tier, rules catalog) | 2 |
| `hana_discovery` | discovery | Browse & find: packages/objects/tables, their definitions and field structure | 7 |
| `hana_data` | data | Data preview: read rows from activated views and base tables (plus preview diagnosis) | 2 |
| `hana_insights` | insights | Structure & lineage analysis: what depends on it, field-level calculation logic | 2 |
| `hana_modeling` | modeling | Modeling & repository changes: create/update/validate/activate/delete design-time objects, import & export | 11 |
| `hana_diagnostics` | diagnostics | Operations & performance: health/sessions/storage/trend, SQL analysis and repository change audit | 6 |

Each facade's **description carries the member list** (`- <capability id>: <title>`), so the model can see what a category holds without making any call — that is what makes "zero discovery calls" hold (with an abstract summary only, the model must call the index once just to learn what is inside, handing back the round-trip that was saved). **Param names and one-line summaries stay out of the description**: they belong to the moment *after* a capability is chosen, and come from the index receipt.

Every facade takes `{ capability?, args? }`: **with no arguments** → the category index (id / title / kind / one-line summary / param names); **with `capability` + `args`** → call that capability directly (no promotion needed). Either form **promotes the whole category into the tool surface** — afterwards its capabilities carry full schemas and can be called flat (see "Dynamic surface"). The index is filtered by the current caller's entitlement — nothing you cannot see is something you may not call, and it is indistinguishable from "does not exist".


> **Field-logic receipts come from the view definition** — attribute-column formulas/types included: `hasFormula` in `hana_metadata_list_fields` and `formula` / `sourceColumns` in `hana_metadata_get_field_logic` are populated from the definition.

> **Write-operation safety boundary**: the writable-package scope for write tools (create/activate/update/delete/package_create/import) is controlled by `HANA_WRITE_PACKAGES` — **empty = write boundary not enabled**: requests that declare write packages are **hard-blocked** by the runtime gate with `boundary_off` ("to write you must configure one"); when set, only configured packages and their sub-packages are writable (e.g. `ZDEMO1,ZDEMO2.ZDEMO_SD` allows ZDEMO1, ZDEMO1.X, ZDEMO2.ZDEMO_SD, ZDEMO2.ZDEMO_SD.SUB, rejects others).
> Only the **service** layer is fail-open (`assertWritePackageAllowed` passes when the allowlist is empty) — scripts/internal calls do not go through the tool-layer gate and are not stopped by `boundary_off`.
> Same-name objects are rejected from overwrite; update/delete/activate carry If-Match optimistic locking (the known exceptions for create/import — no server-side guard across processes — are in "Transports → Concurrency & locking").
>
> **Local file boundary (export/import)**: `hana_repo_export`'s `saveTo` and `hana_repo_import`'s `filePath` go straight to the server's local filesystem, outside any HANA boundary. Only **relative paths inside the server working directory** are allowed (absolute paths and `..` escapes are always rejected) — as of 2026-10-14 there is no configurable local root (`MCP_LOCAL_ROOT` has been removed): for stronger isolation (e.g. allowing only a dedicated export directory) start the server process with that directory as its working directory.
> **The XS write channel is plaintext HTTP**: XS REST (the channel the write/activate/import/export paths actually use) defaults to `http://` — the HANA account password, session Cookie and CSRF token all travel in cleartext; `HANA_TLS`/`HANA_SSL_VALIDATE` only apply to the SQL channel and **do not cover** this one — it must be isolated at the network side (reachable only from trusted segments / the local machine). When the XS endpoint supports TLS, set `HANA_XS_TLS=true` and point `HANA_XS_PORT` at the HTTPS port.
>
> **Multi-object changeset (`changeset` mode of `hana_view_update`)**: the third mode alongside operations / xml; it closes changes to multiple objects **within a single call** — (1) **whole-batch preflight**: per-action planning + **object-level** read/write-set intersection detection (same-package multi-object batches are not falsely flagged) + destructive-change assessment; if anything is blocked or intersects ⇒ **the whole batch is rejected with zero writes** (the decision happens before any write); (2) **per-item execution** in (packageId, objectName) lexicographic order (ABBA-deadlock safe), each item completing **including activation**; (3) on any item failure ⇒ **reverse-order compensation** (update writes the original text back / create deletes the new object / delete writes the original text back); (4) **honest report**: with partial=true every item's status is enumerated (ok / failed / compensated / compensation_failed / conflict_external) and `notExecuted` explicitly lists the unfinished items — a partial completion is never packaged as success. Up to **10** actions; **each** destructive action (update/delete) declares its own `migration` on the action — without it the whole-batch preflight decides **before any write** ⇒ whole batch rejected, zero writes (no compensation). The batch provides **no cross-item snapshot isolation**: items commit one by one, each taking its own lock, so concurrent reads/writes outside the batch are visible to it (the receipt's `concurrencyNote` says the same). In `changeset` mode the top-level `packageId`/`objectName` are ignored (single-object channel only; batch targets come with each action).
>
> **Long batches run as async tasks (`async=true`)**: each item's write includes a 2–10s server-side activation, so a 10-item batch can take minutes — and a synchronous call may be cut off by the MCP **client's own** timeout (the server cannot know the client's timeout setting). `changeset` + `async=true` hands the batch to an **in-process task** and returns `{ taskId, status: 'working', label, hint }` immediately:
> - poll with `hana_task_get({ taskId })` → `status ∈ working/completed/failed/cancelled`, `progress`, and the terminal `result` (**a receipt envelope identical in shape to the synchronous call** — `data` = the report on success; `raw.errorDetail` carries the per-item detail on failure);
> - cancel with `hana_task_cancel({ taskId })` → **cooperative**: the current action is never interrupted; after it finishes, subsequent actions are skipped and the same **reverse-order compensation** as a failure runs (executed items return to their pre-batch state); the report carries `raw.code=changeset_cancelled` with the full scene;
> - the task body *is* `applyChangeset` (same implementation, locks, semaphore, compensation): the whole-batch preflight still happens before any write (a failing preflight ⇒ whole batch rejected, zero writes ⇒ the task lands in `failed`);
> - stated boundaries: at most 4 concurrent tasks (a submission beyond that is refused with no write at all), terminal tasks retained for 30 minutes (lazily swept — cleaned up on the next submission), registry capped at 100; **in-process state, dropped on server restart** (old taskIds answer "unknown task"); tasks are visible only to **their own caller** (someone else's task and a non-existent task return the same "unknown task"); an HTTP deployment without tokens follows the single-tenant assumption (callers see each other's tasks).
> Why not protocol-native MCP Tasks (SEP-2663): the local SDK (2.3.1) ships the wire vocabulary but **no runtime**, and on the 2026-era protocol `tasks/result|list` are hard -32601 — the native route is crippled for modern clients and would require replacing the SDK's `tools/call` handler. The tool-based route trades "model polls actively" for "identical behaviour on both protocol eras, zero SDK surgery".
>
> **Write-boundary preflight (validated at startup)**: on boot the server prints the effective writable-package scope — `info` with the allowlist when configured, and a `warn` when it is empty (boundary not enabled) while write tools are exposed to clients. So "is the boundary on at all" surfaces at startup rather than at the first write. Malformed entries in `HANA_WRITE_PACKAGES` (`ZDEMO.`, `ZDE MO`, `*`, …) now fail at config load with a fix hint instead of being silently kept as a prefix that never matches (which either rejected every write or made the boundary a no-op).
> Note the effective value depends on the launch source: a stdio server launched via mcp.json takes that file's env, and when the credential trio is present the repository `.env` is skipped entirely — three config locations on one machine can give three different answers.
>
> **Preflight layering**: each rule leaf owns one thing — `src/config/write-boundary.ts` (writable package prefixes), `src/capabilities/defs/*.ts` (the capability manifest: kind / effects / schema per capability), `src/tools/groups.ts` (visibility filtering derived from the manifest), `src/core/sql.ts` (schema allowlist), `src/config/deployment.ts` (deployment posture and invariants); the preflight layer `src/config/preflight.ts` is the single decision entry point — `resolvePolicy(source)` produces one effective policy from env / mcp.json / the loaded config, `checkCapability` / `checkResource` / `checkDeployment` judge it one dimension at a time (capability exposure / resource scope / deployment posture) and combine into a `Verdict`, with `runPreflight` as the task gate and `describePolicy` as the config self-check; callers are the server startup self-check, the `npm run preflight` CLI and the live verification scripts.
>
> **Runtime gate (tool layer — plan first, then judge)**: **every** capability (the business capabilities declared in `src/capabilities/defs/*.ts`, the 8 operation aliases and the six facades — read-only capabilities included) is wrapped by `capabilityRegistrar` and goes through the same `authorizeCall` gate (`src/config/authorize.ts`) before the handler: (1) **planning** (`src/write-plan.ts` + `src/capabilities/planners.ts`) computes what the call will actually read and write into a `WritePlan` (packages written / schemas read / cross-package read references / points that cannot be determined statically) — a capability's `effects.plan` in the manifest decides whether the gate has a resource dimension at all; (2) **judging** against the effective permission config by the preflight layer — on failure it returns a hard error (`isError`) and **never reaches the handler or the service**.
>
> Why arguments alone are not enough: with `hana_view_update`'s `add_join` the **join source lives in another package**, hidden inside `operations`; `hana_view_validate` looks like "validation" but its design mode actually **writes** a `_CHKTMP` temp object; `hana_repo_import` content may reference other packages; deleting a view invalidates downstream dependents. Only by parsing the request do these become visible — the plan's `steps` and `uncertain` fields go into the interception report so the caller sees what *would* have happened before deciding how to fix it.
>
> Judging uses the config the server already loaded (no env re-parsing), so there is no "value used for judging ≠ value used at runtime". Cross-package read references are currently **reported but not blocked** (there is no "readable packages" config item, and adding an allowlist would break existing cross-package join usage). The service-layer `assertWritePackageAllowed` remains as defence in depth (scripts and internal calls bypass the tool layer) and reuses the same rule — note that with an **empty** package allowlist this layer is **fail-open** (the `boundary_off` hard block lives in the tool-layer gate, see the write-boundary note above). Self-check before a task: `npm run preflight -- <package...> [--tool <name>] [--schema <name>]`, exit code `0` = may execute / `1` = blocked / `2` = usage error; for local mode add `--from <mcp.json>` to judge against the config the client actually injects (a different source from the repository `.env`).
>
> **Deployment invariants (refused at startup)**: configs that are individually valid but unsafe in combination are rejected by the startup self-check rather than merely warned about (mirroring tableau-mcp, which throws in its Config constructor). Current rules: (1) HTTP bound to a non-loopback address with no Bearer token → **startup refused** (unless `MCP_HTTP_ALLOW_ANONYMOUS=true` is set explicitly); (2) `HANA_TLS=false` plaintext, (3) encrypted but `HANA_SSL_VALIDATE=false` (no MITM protection), (4) the XS write channel is plaintext HTTP (`HANA_XS_TLS=true` not set, see the `xs_plaintext` warning) → warned and allowed, but visible in the startup log every time.

## Data Preview

`hana_data_preview` offers three preview channels (the `via` field in the return identifies which was used):

| Channel | Trigger | Mechanism | Privileges required |
| --- | --- | --- | --- |
| `direct` (overall preview) | no `node` passed | `SELECT * FROM "_SYS_BIC"."package/view-name"` | `_SYS_BIC` data access |
| `intermediate` (node preview · default) | `node` passed | HANA native intermediate view `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV` (same as Studio node preview): the view is always named `<pkg/object>/dp/<node>`, an existing one is reused instead of recreated, and after the query it is dropped only when no call in this process is using it and this server created it | `EXECUTE` on the above procedure |
| `derived` (node preview · read-only) | `node` + `forceDerive=true` (explicit) | Derives SQL from the view XML, purely read-only | `_SYS_REPO` read + base-table SELECT |

Row-count rules: 10 rows by default without filter, 100 with filter, explicit `limit` capped at 1000; `LIMIT n+1` probe for truncation → `truncated`.
Node preview defaults to the `intermediate` channel only: on missing EXECUTE privilege it directly returns "not supported" (with a grant hint), and does NOT auto-fall-back to derived.

**Auto-diagnosis on permission failure**: when preview fails due to a permission-class reason (missing EXECUTE/SELECT, `_SYS_BIC` object invisible — error codes 258/259, etc.), a privilege diagnosis runs automatically and the report is attached at `envelope.raw.diagnosis` — no extra call needed to locate the blocking point.
You can also use `hana_data_preview_diagnose` to pre-check manually, focusing on the two root causes of preview failure:
- Whether the current CV is protected by a classic analytic privilege and the current user's grant status
- Whether upstream data sources (actually traced via the derived channel) are inaccessible

## Common Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Run directly via tsx (dev/debug) |
| `npm run build` | Compile with tsc into dist |
| `npm start` | Run dist/index.js (stdio) |
| `npm test` | Unit tests (node --test + tsx; test files kept locally, not in repo) |
| `npm run smoke` | Build + stdio smoke test |
| `npm run smoke:http` | Build + Streamable HTTP smoke test (handshake/tool registration/Host guard; no real HANA needed) |
| `npm run typecheck` | Type-check only (also acts as the dead-code gate: `noUnusedLocals` rejects unused imports and variables) |
| `npm run format` | Prettier formatting (`format:check` verifies without writing) |
| `npm run check` | `typecheck` + `test` — run this before committing |
| `npm run verify:system` | Build + real-HANA system-tool verification |
| `npm run verify:p1-5` | Build + read-path/preview/field-logic black-box verification |
| `npm run verify:lifecycle` | Build + write-path full-lifecycle verification (create→validate→activate→preview→update-conflict→delete→import; scripts in local `test-verification/`, not in repo) |
| `npm run verify:add-join` | Build + declarative add-join (`op=add_join`) verification (incl. a BW-dialect view; scripts in local `test-verification/`, not in repo) |
| `npm run verify:sql-mode` | Build + SQL-mode view (`mode=sql` with `script`/`scriptColumns`) verification (scripts in local `test-verification/`, not in repo) |
| `npm run verify:health` | Build + stability-diagnostics verification (**192 assertions**), including regression guards against using the `M_DISK_USAGE` `FILE_SIZE` account for capacity (whole-machine false alarms), against treating volume-file usage (pre-allocated and often full) as a disk alarm, against exposing `COMPRESSION_RATIO_IN_PERCENTAGE` and `HASH_COLLISION_COUNT` (both unusable on this revision), against using `SERVER_TIMESTAMP` as the trend time axis, and for the rule that every item yields either a reading or an `unknown` with its cause |
| `npm run verify:catalog` | Build + relationship-graph / lineage verification. Read-only part: `where_used(depth)` closure ⊇ single hop with `asOf`/`truncated`; `search_objects(by=field)` accounting fields; a "no parallel tools" negative assertion; `depth=1` shape compatible with the old version and `objectSuffix` never reverting to `?`. Plus an **A/B section** (the same object queried through a baseline dist built from `cac5d60` and through this dist, field-by-field diff, both sides must report the same VERSION_ID) and a **write section** (create B → create A → add a join from A to B → the catalog lists it immediately → modify A (VERSION_ID advances) → delete A → the catalog no longer lists it; guarded by `runPreflight` and with cleanup; skip via `VERIFY_CATALOG_SKIP_WRITE=1`). Overridables: `VERIFY_CATALOG_PACKAGE/OBJECT`, `VERIFY_CATALOG_WRITE_PACKAGE` |
| `npm run verify:authz` | Build + call-time gate verification (one unified gate for the read and write paths). Guards: an out-of-scope read (`schema` not in `HANA_READ_SCHEMA`) is blocked **before the handler**, with a machine-readable code and this call's pre-plan in the receipt and **no remediation hints**; a read capability's `packageId` is not constrained by the write boundary (reading a view in a package ≠ writing that package); the write gate's existing behavior is unchanged; an unregistered tool yields a **protocol-level error** (distinguishable from the `isError` of a registered-but-blocked call); every call emits a `capability-audit` event (allows and blocks both logged, with `resources` / `codes`) |
| `npm run verify:concurrency` | Build + live concurrency verification (**two processes** contending on the same object). Guards: an update that reports success is the final state (no silent revert); every 412 carries the machine-readable `raw.conflict.currentETag` (built deterministically with a stale `ifMatch`); a double-delete leaves one winner and one machine-readable `412`/`OBJECT_NOT_FOUND`; after activate/update interleaving, the ETag read from metadata equals the one returned by the last successful write. Script lives in local `test-verification/`, not in repo |
| `npm run verify:dry-run` | Build + dry-run & destructive-assessment verification (zero-write dryRun + assessment table + migration gate). Guards: after a dry run (or a rejected call) **both the ACTIVE side and the inactive side (`_SYS_REPO.INACTIVE_OBJECT`)** keep identical version readings (checking ACTIVE alone misses "555: file written, activation failed"); a dry run that re-submits an unchanged object yields an empty structural diff (normalization works — one case per channel, xml and operations); a breaking change without a declared `migration` is rejected (`migration_required` code, `raw.errorDetail.breaking.items`, not a single write; the table's most insidious **data-source change** row is pinned separately: retargeting via the full-XML channel with downstream present is likewise rejected, with zero writes); a declared strategy is admitted and recorded (**recorded only — no automatic migration**); delete gate (with downstream references an undeclared delete is rejected; with none it succeeds as before). Script lives in local `test-verification/`, not in repo |
| `npm run verify:changeset` | Build + changeset (multi-object transaction) verification (four deterministic scenarios — no random failures). Guards: ① three updates in one changeset call all succeed (each item `ok`, each carrying the write-receipt baseline with `etagSource='response-header'` — asserted per the **code** spelling — `partial=false`); ② a third action `create` on an existing object fails deterministically ⇒ the first two items are `compensated` with their content **byte-for-byte back to the original** (verified by reading back via get_view — not a tautology; a `compensation_failed` outcome is an implementation defect and the script prints the structured `currentETag/currentVersion` evidence); ③ dropping a column on an object with downstream, no declared `migration` ⇒ **whole batch rejected, zero writes** (VERSION_ID and the inactive-side fingerprint of both the target and the harmless same-batch action unchanged); ④ same batch "write A" + "read A as join source" ⇒ whole batch rejected with the conflicting **object name and both action indices** readable from the rejection payload, plus a counter-guard (two different objects in the same package must NOT be reported as conflicting — a package-level false rejection turns this red). Script lives in local `test-verification/`, not in repo |
| `npm run verify:tasks` | Build + async-task verification (`changeset` + `async=true`). Guards: submission returns a `taskId` immediately (without waiting for the batch); polling reaches `completed` with a `result` identical in shape to the sync call (`applied` carries etag/activated); an immediate cancel is asserted consistent under both timings (`requested` ⇒ terminal `cancelled` with `reason=cancelled` items; `terminal` ⇒ the hint states the cancel arrived too late); an unknown taskId returns the same "unknown task" line. Script lives in local `test-verification/`, not in repo |
| `npm run verify:ops` | Build + operation-set verification (**8 ops**). Main case (`set_description`): zero-model-XML description edit, byte-identical elsewhere, dryRun wiring with zero writes. The remaining ops: `add_calculated_column` / `set_attribute_filter` (incl. replace path) / `set_variable` (a variable is injected through the xml channel first) / `rename_field` (dup and missing-name negatives) / `drop_field` (last-measure negative) each perform a real write and assert **activation succeeds** (the live proof that the XML shapes match the SAP dialect) plus full input-guard refusals with zero writes. Script lives in local `test-verification/`, not in repo |
| `npm run probe:health` | Read-only probe enumerating monitoring-view availability / column names / value domains (run it first on a new environment — do not guess from documentation) |
| `npm run probe:repo` | Read-only probe: repository read paths (`_SYS_REPO` object/attribute queries) availability |
| `npm run probe:xfer` | Read-only probe: CHECK and xfer (Transfer API) capability detection |

## Architecture

```
src/
  index.ts            Entry: load config → connection pool → stdio / Streamable HTTP transport branch
  http.ts             Streamable HTTP transport: createMcpHandler per-request factory + node:http adapter + Host/Origin guards
  server.ts           McpServer (server-instructions domain context) + all tool registration
  config/             zod env-var validation (connection/TLS/timezone/allowlists/writable packages)
  core/               HANA connection pool (max/queue/wait timeout configurable), SQL escaping & allowlist, error envelope,
                      log redaction, per-request identity context (multi-client HTTP attribution), write critical-section
                      keyed lock (wait timeout) + activation semaphore, XML utils, XS REST client (uniform timeouts)
  model/              View TS types, XML bidirectional parsing, minimal-CV XML construction
  capabilities/       Capability manifest (kind / effects / schema per capability) + category facades + the authorizeCall gate
  rules/              Rule bodies handed to the model (dialect / boundary / gotcha details, looked up by id)
  write-plan.ts       WritePlan: what a call actually reads and writes (consumed by the runtime gate and changeset)
  services/
    metadata.service        Read-only: package/object search/fields/lineage/table catalog
    preview.service         Data preview (direct/node intermediate-view/XML-derived) + auto-diagnosis on permission failure
    preview-diagnose.service Preview-privilege diagnosis (analytic-privilege detection + upstream reachability probe)
    repository.service      Write: XS REST official write path (workspace/file/Transfer API/design-time validate)
                             + REPOSITORY_REST repoV2 envelope (read-side/compat) + INACTIVE_OBJECT fallback
                             + writable-package allowlist (HANA_WRITE_PACKAGES)
    validation.service      Runtime view consistency check
    system.service          System info & privilege check
    sql-analyze.service     SQL analysis (execution plan) main flow: EXPLAIN → read back by unique name → clean up, all on one connection
    sql-analyze.rules       Pure rule layer for the above: statement classification/allowlist/readable conclusion (default output) + operator rendering
    read-scope.service      Unqualified-table read-scope check (shared by SQL-mode views and SQL analysis)
  tools/               MCP tool thin shells (capability/health/task/… : per-domain handlers + the capabilityRegistrar)
  types/               Unified return envelope Envelope etc.
scripts/               General smoke script (smoke-stdio); real-machine verification/probe scripts are in local test-verification/ (not in repo)
```

> `tests/` and `docs/` are not committed (they contain environment identifiers/probe records, kept locally for development); after cloning, prepare tests & docs as needed.

Each tool returns a unified envelope `{ success, data?, messages[], raw? }` (in HTTP mode it also carries `clientId`, the caller identity resolved from `MCP_HTTP_TOKENS`): protocol-level hard errors (illegal params, etc.) come back via MCP `isError` with a recovery hint; HANA business failures (e.g. activation error details) go through `success:false`. **The write path's 412 conflicts and the delete 404 (object already gone) are business envelopes** (`success=false` + machine-readable code, see "Transports → Concurrency & locking") and do **not** go through `isError`.

## HANA Authorization Requirements

The connecting user needs corresponding privileges on the following objects (check as needed by use scope):

**Read path (metadata / preview)**

- `_SYS_REPO`: SELECT (ACTIVE_OBJECT / INACTIVE_OBJECT / PACKAGE_CATALOG)
- `_SYS_BI.BIMC_*`: SELECT (optional; the field-list main channel has switched to `_SYS_REPO` XML parsing)
- `_SYS_BIC`: SELECT (runtime-view data preview)
- `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV` / `SYS.DROP_INTERMEDIATE_CALCULATION_VIEW_DEV`: EXECUTE (node-level preview)
- `SYS.CHECK_CALCULATION_VIEW`: EXECUTE (runtime validation)
- BW views protected by analytic privileges additionally require the corresponding `ANALYTICAL_PRIVILEGE` grant (schema SELECT is not a substitute)

**Write path (XS Classic design-time REST, full writable-package modeling lifecycle)**

- `SYS.REPOSITORY_REST`: EXECUTE
- Repository write/activate privileges: `REPO.EDIT_NATIVE_OBJECTS` / `REPO.ACTIVATE_NATIVE_OBJECTS`
  (or equivalent: package privilege on the target package root + MODELING role)
- `REPO.MODIFY_CHANGE` / `REPO.MODIFY_OWN_CONTRIBUTION`: change-session (workspace) operations
- XS session (`http://<host>:<HANA_XS_PORT>/sap/hana/xs/formLogin`): the user must be able to log in to XS Classic
  (`PUBLIC` + the session capability contained in application privilege `sap.hana.xs.admin.roles::RuntimeConfOperator`; verify with `hana_check_privileges`)
- Write-target package: `REPO.EDIT_NATIVE_OBJECTS` + owner of the package or package-level write privilege

**Stability diagnostics (`hana_system_health` / `hana_system_activity` / `hana_table_storage` / `hana_system_trend`)**

- **No extra privileges needed**: instance-scope views (`SYS.M_SERVICES`, `M_CS_TABLES`, `M_TABLES`, `M_SQL_PLAN_CACHE`, …) are readable by any user, so the table profile and part of the health check always work.
- **`CATALOG READ`** (or a `MONITORING` role containing it) unlocks the **infrastructure-class** monitoring views — `M_DISKS`/`M_DISK_USAGE`, `M_HOST_RESOURCE_UTILIZATION`, `M_BACKUP_CATALOG`, `M_SERVICE_REPLICATION`, `M_MEMORY_OBJECTS`, `M_VOLUME_IO_TOTAL_STATISTICS`, `M_ENCRYPTION_OVERVIEW`, … — and the full visibility of other sessions. These views **do not error when privileges are missing — they return empty sets**, so the health check marks the corresponding item `unknown` rather than "fine".
- **`SELECT` on `_SYS_STATISTICS`**: needed by the alerts check (`STATISTICS_CURRENT_ALERTS`) and by the **whole trend tool**; without it the call reports 258 and is likewise marked `unknown`. **Measured retention is about 42 days** (configurable) — when the window exceeds it the report states how far back the data goes.
- **Config readings** (the `config` item of `hana_system_health`) need `INIFILE ADMIN` or equivalent to read all of `M_CONFIGURATION_PARAMETER_VALUES`; a partial read does not necessarily error, so the non-default-layer override count may be understated.
- **Memory-object and volume-IO readings** (`M_MEMORY_OBJECTS`, `M_MEMORY_OBJECT_DISPOSITIONS`, `M_VOLUME_IO_TOTAL_STATISTICS`, `M_VOLUME_FILES`) are likewise infrastructure-class: missing privileges affect **only that layer's readings**, leaving a "cannot be determined" entry in `metrics` without skewing the host/instance memory and capacity conclusions.

When privileges are insufficient, troubleshoot with `hana_check_privileges` first; whether the monitoring views are returning unfiltered data can be confirmed directly from the `visibility` object returned by `hana_system_health` (`unfiltered` boolean + the held-privilege list). For preview failures use `hana_data_preview_diagnose` to determine whether it's an analytic-privilege issue or upstream inaccessibility.

## MCP Client Setup

Copy `mcp.json.example` to `mcp.json`, fill in real connection details, then configure per your client:

**Claude Desktop / Cursor / VS Code (MCP extension)**

Point to the local build artifact, stdio transport:

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "command": "node",
      "args": ["<absolute-repo-path>/dist/index.js"],
      "env": {
        "HANA_HOST": "hana-host.example",
        "HANA_PORT": "31015",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD",
        "HANA_DB_NAME": "SYSTEMDB",
        "HANA_TLS": "false",
        "HANA_WRITE_PACKAGES": "ZDEMO1",
        "HANA_XS_PORT": "8010"
      }
    }
  }
}
```

**Or one-shot via npx (no clone required)**:

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "command": "npx",
      "args": ["github:mininia/saphana-modeler-mcp"],
      "env": {
        "HANA_HOST": "hana-host.example",
        "HANA_PORT": "31015",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD",
        "HANA_DB_NAME": "SYSTEMDB",
        "HANA_TLS": "false",
        "HANA_WRITE_PACKAGES": "ZDEMO1",
        "HANA_XS_PORT": "8010"
      }
    }
  }
}
```

**Streamable HTTP setup** (remote/shared deployment; start the server with `MCP_HTTP_PORT` set first — see "Transports"):

```jsonc
{
  "mcpServers": {
    "saphana-modeler-mcp": {
      "url": "http://127.0.0.1:3000/mcp",
      "headers": { "Authorization": "Bearer <the client's token in MCP_HTTP_TOKENS>" }
    }
  }
}
```

> In HTTP mode, connection info and other env-var configuration lives on the **server side** (the shell / .env the server starts from); the client only fills in `url`.
> When the server sets `MCP_HTTP_TOKENS` (or the backward-compatible `MCP_HTTP_TOKEN`), the client carries the bearer token via `headers` (header support varies per client — check its own docs).

> **Raise the client's tool-call timeout (`hana_sql_analyze` with `analyze=true`)**: this mode **really executes** the statement, and the server allows it up to **5 minutes** (plus roughly 2.5 minutes of queueing and control calls in the worst case). Most clients cut a tool call off far earlier — Claude Code defaults to **60 seconds** — so a big calculation view gets killed client-side while the server-side statement keeps running, and you never see the result. Set the client's per-call timeout to **600000 ms (10 minutes)**:
> - **Per server**: add `"timeout": 600000` to that server's entry in `mcp.json` (milliseconds; overrides `MCP_TOOL_TIMEOUT`; values below 1000 are ignored)
> - **Globally**: set `MCP_TOOL_TIMEOUT=600000` in the environment that **starts the client**

## License

This project's own code is licensed under [MIT](LICENSE). Third-party dependencies are referenced only via npm
dependency declarations and installed by the user — not redistributed with this project. For the license list
and the usage boundary of `@sap/hana-client` (SAP Developer License 3.2), see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
