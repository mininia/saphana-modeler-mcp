# saphana-modeler-mcp

> 🌐 [中文](README.md) | English

An MCP server for SAP HANA classic Modeler capabilities (TypeScript, Node >= 20.12). Targeting on-premise HANA 2.0
(classic `_SYS_REPO` repository modeling), it provides **metadata browsing, data preview, lineage query, and
modeling write operations** for information views (calculation views / attribute views / analytic views) and
repository objects.

Connect via the MCP stdio protocol to clients such as Claude / IDE: invoke tools to browse, validate, and
(within configured writable packages) create calculation views — no HANA Studio required.

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

> Full definition read (json/xml) of view objects is provided by `hana_metadata_get_view`; field-level inspection uses `hana_metadata_list_fields` / `hana_metadata_get_field_logic`.
> Prefer the declarative `operations` mode of `hana_view_update` for modifying calculation views (zero XML); for complex rework use the full-XML channel (read with `hana_metadata_get_view(format=xml)` first, make minimal edits, then post back).

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
npm install          # after first install run: npm approve-scripts @sap/hana-client (prebuilt binary)
cp .env.example .env # fill in real HANA connection
npm run build
node scripts/smoke-stdio.mjs   # smoke test: handshake + tool registration (no real HANA needed)
```

MCP setup: copy `mcp.json.example` to `mcp.json` and fill in real connection details (both `mcp.json` and `.env` are gitignored — **do not commit**). See "MCP Client Setup" below.

## Configuration

Connection info is only allowed from environment variables / `mcp.json` `env` / project-root `.env`. No defaults are provided — the server fails fast on startup if any required value is missing.

| Option | Required | Description | Example |
| --- | --- | --- | --- |
| `HANA_HOST` | ✅ | HANA hostname/IP | `hana-host.example` |
| `HANA_INSTANCE` | ✅ | Instance number (00–99) | `10` |
| `HANA_PORT` | optional | SQL port; auto-derived from instance number if empty | `31015` |
| `HANA_USER` | ✅ | Database username | — |
| `HANA_PASSWORD` | ✅ | Password | — |
| `HANA_LOCALE` | optional | Connection locale, default `zh_CN` | `zh_CN` |
| `HANA_DB_NAME` | optional | Tenant database name (required for MDC) | `SYSTEMDB` / tenant name |
| `HANA_TLS` | optional | TLS encryption, default `true` (fail-closed; set `false` only on trusted links) | `true` |
| `HANA_SSL_VALIDATE` | optional | Validate certificate under TLS, default `true`; set `false` for self-signed certs | `true` |
| `HANA_TIMEZONE` | optional | Session timezone, default `Asia/Shanghai` | `Asia/Shanghai` |
| `HANA_SCHEMA_ALLOW` | optional | Extra queryable schemas (comma-separated, appended to built-in allowlist) | `SAPABAP1,OTHER_SCHEMA` |
| `HANA_WRITE_PACKAGES` | optional | Writable repository package prefixes (comma-separated, incl. sub-packages). **Empty = no restriction (all writable)**; when set, only configured packages and their sub-packages are writable | `ZDEMO1,ZDEMO2.ZDEMO_SD` |
| `HANA_XS_PORT` | optional | XS Classic design-time REST port (write path); auto-derived as `80<instance>` if omitted | `8010` |
| `HANA_XS_BASE_PATH` | optional | XS design-time REST base path, default `/sap/hana/xs/dt/base` | — |
| `HANA_TOOL_GROUPS` | optional | Enabled tool groups (comma-separated `read`/`write`/`admin`); **empty = no restriction (all enabled)** | `read` |
| `HANA_TOOL_ALLOW` | optional | Force-enabled tool name globs (registered even if their group is disabled; comma-separated, supports `*`) | `hana_view_validate` |
| `HANA_TOOL_DENY` | optional | Force-disabled tool name globs (highest priority, overrides allow & groups; comma-separated, supports `*`) | `hana_data_preview*` |
| `LOG_LEVEL` | optional | Log level, default `info` | `debug` |
| `MCP_HTTP_PORT` | reserved | Streamable HTTP port (current mainline is stdio) | — |

Port auto-derivation rules:

- SYSTEMDB / single container: `3<instance>13` (e.g. instance=10 → 31013)
- Tenant database (MDC): `3<instance>15` (e.g. instance=10 → 31015)

## Tool Groups & Visibility Control

23 tools are divided into three functional groups. You can control which tools are visible to the MCP client
(via `mcp.json` / `.env` environment variables) — unregistered tools never appear in `tools/list` and cannot be
invoked. All-empty config = all enabled (backwards-compatible default).

### Three groups

| Group | Description | Tools |
| --- | --- | --- |
| **read** (data read) | Read-only access to HANA data/metadata/system info/audit/export — no repository changes | `hana_system_get_info`, `hana_check_privileges`, `hana_package_list`, `hana_package_list_objects`, `hana_metadata_get_view`, `hana_metadata_search_objects`, `hana_metadata_list_fields`, `hana_metadata_get_field_logic`, `hana_metadata_where_used`, `hana_table_list`, `hana_table_columns`, `hana_data_preview`, `hana_data_preview_diagnose`, `hana_view_check_actions`, `hana_repo_export`, `hana_repo_changelist` |
| **write** (write ops) | Modifies design-time repository objects/packages (create/activate/update/delete/import/design-time validate) | `hana_package_create`, `hana_repo_import`, `hana_view_create`, `hana_view_activate`, `hana_view_update`, `hana_view_delete`, `hana_view_validate` |
| **admin** (admin ops) | Lifecycle/audit/privilege management (currently an empty placeholder, reserved for `hana_privilege_create` etc.) | (none yet) |

> The `design` mode of `hana_view_validate` briefly writes a temporary validation object `_CHKTMP`, so the whole tool is classified as `write`; there is no mixed split by design/runtime mode — a read-only deployment (`HANA_TOOL_GROUPS=read`) does not expose this tool.

### Three config variables (priority: `HANA_TOOL_DENY` > `HANA_TOOL_ALLOW` > `HANA_TOOL_GROUPS`)

| Variable | Semantics | Example |
| --- | --- | --- |
| `HANA_TOOL_GROUPS` | Enabled groups (comma-separated); empty = no restriction | `read` exposes only data-read tools, disables all write tools |
| `HANA_TOOL_ALLOW` | Force-enabled tool name globs (registered even if their group is disabled; supports `*`) — used to allow individual tools outside the group switch | `hana_some_tool` |
| `HANA_TOOL_DENY` | Force-disabled tool name globs (highest priority; supports `*`) | `hana_data_preview*` disables all preview tools |

**Typical deployment shapes:**

- **Read-only analyst**: `HANA_TOOL_GROUPS=read` — exposes only 16 read-only tools; all write/validate tools hidden.
- **Modeling developer**: `HANA_TOOL_GROUPS=read,write` — exposes read & write (the default shape, equivalent to all-empty).
- **Disable specific tools**: `HANA_TOOL_DENY=hana_view_delete` — disables only delete; the rest are unaffected.

On startup, if filter variables are configured, the log prints the enabled groups and the list of disabled tools for confirmation. An unknown group name (e.g. `HANA_TOOL_GROUPS=read,bogus`) fails fast on startup (fail-closed).

## Tool Reference

23 tools in total, all carrying annotations (`readOnlyHint` / `destructiveHint` / `idempotentHint`) so hosts can auto-approve and confirm dangerous operations.

| Tool | Type | Description |
| --- | --- | --- |
| `hana_system_get_info` | read-only | Version/SID/host/instance/current user & schema |
| `hana_check_privileges` | read-only | Current user's privilege matrix & modeling capability summary (troubleshooting entry point) |
| `hana_metadata_get_view` | read-only | Full view definition: json=structured definition (nodes/data sources/output fields/variables), xml=raw design-time XML |
| `hana_package_list` | read-only | Repository package list (with hierarchy depth, owner; supports fragment filter/truncation) |
| `hana_package_list_objects` | read-only | Objects in a package (name/type/version/activation status; supports filter/truncation) |
| `hana_metadata_search_objects` | read-only | Search views by name fragment (returns package/object name/type/version/activation info) |
| `hana_metadata_list_fields` | read-only | View output field list (ID/description/type/aggregation/source/has-formula) |
| `hana_metadata_get_field_logic` | read-only | Single-field calculation logic: formula text, referenced source fields & lineage, SQLScript source |
| `hana_metadata_where_used` | read-only | Lineage/dependency: upstream (who it depends on) / downstream (who depends on it, incl. runtime refs) |
| `hana_table_list` | read-only | Accessible tables under a given schema |
| `hana_table_columns` | read-only | Table column structure (name/type/length/precision/nullable/comment) |
| `hana_data_preview` | read-only | Activated-view data preview: overall direct / node intermediate-view / XML-derived — three channels, supports filtering & input parameters; permission-class failures auto-attach a diagnostic report |
| `hana_data_preview_diagnose` | read-only | Data-preview privilege diagnosis: focuses on analytic-privilege protection and upstream data-source reachability, gives blocking points & grant suggestions |
| `hana_view_create` | write | Create a calculation view within a writable package (minimal form: single Projection + single source table full-column passthrough; XS REST write path) |
| `hana_view_activate` | write | Activate a design-time calculation view into a runtime column view (XS REST: PUT + SapBackPack Activate; error details transparent) |
| `hana_view_update` | write | Update a calculation view, one of two: declarative `operations` patch (op=add_join server-side deterministic transform, zero model XML) / full-XML overwrite (PUT + If-Match optimistic lock; conflict returns isError + re-read hint) |
| `hana_view_delete` | write | Delete a design-time calculation view (DELETE; recommend querying where_used first) |
| `hana_view_validate` | validate | Dual-mode: design=pre-activation validation (simulates activating a temp copy, original object unaffected); runtime=consistency check on an activated view (SYS.CHECK_CALCULATION_VIEW) |
| `hana_view_check_actions` | read-only | Query the list of actions supported by the CHECK procedure |
| `hana_package_create` | write | Create a package/directory (XS REST: POST /base/file/<pkg>/; target must be within writable package scope) |
| `hana_repo_export` | backup | Export a package as zip (XS REST Transfer API; saveTo to disk or return base64) |
| `hana_repo_import` | write | Import design-time files (Transfer API directory target + chunked upload, stored inactive, target must be within writable package scope, re-read status after import) |
| `hana_repo_changelist` | read-only | Repository change-list audit (GET /base/change; requires Change Tracking enabled) |

> **Write-operation safety boundary**: the writable-package scope for write tools (create/activate/update/delete/package_create/import) is controlled by `HANA_WRITE_PACKAGES` — **empty = no restriction (all writable)**; when set, only configured packages and their sub-packages are writable (e.g. `ZDEMO1,ZDEMO2.ZDEMO_SD` allows ZDEMO1, ZDEMO1.X, ZDEMO2.ZDEMO_SD, ZDEMO2.ZDEMO_SD.SUB, rejects others).
> Same-name objects are rejected from overwrite; update/delete carry ETag optimistic locking.

## Data Preview

`hana_data_preview` offers three preview channels (the `via` field in the return identifies which was used):

| Channel | Trigger | Mechanism | Privileges required |
| --- | --- | --- | --- |
| `direct` (overall preview) | no `node` passed | `SELECT * FROM "_SYS_BIC"."package/view-name"` | `_SYS_BIC` data access |
| `intermediate` (node preview · default) | `node` passed | HANA native intermediate view `SYS.CREATE_INTERMEDIATE_CALCULATION_VIEW_DEV` (same as Studio node preview): CREATE temp view → SELECT → auto DROP | `EXECUTE` on the above procedure |
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
| `npm run typecheck` | Type-check only |
| `npm run verify:system` | Build + real-HANA system-tool verification |
| `npm run verify:p1-5` | Build + read-path/preview/field-logic black-box verification |
| `npm run verify:lifecycle` | Build + write-path full-lifecycle verification (create→validate→activate→preview→update-conflict→delete→import; scripts in local `test-verification/`, not in repo) |

## Architecture

```
src/
  index.ts            Entry: load config → connection pool → create MCP server → stdio
  server.ts           McpServer (server-instructions domain context) + all tool registration
  config/             zod env-var validation (connection/TLS/timezone/allowlists/writable packages)
  core/               HANA connection pool, SQL escaping & allowlist, error envelope, log redaction, XML utils, XS REST client
  model/              View TS types, XML bidirectional parsing, minimal-CV XML construction
  services/
    metadata.service        Read-only: package/object search/fields/lineage/table catalog
    preview.service         Data preview (direct/node intermediate-view/XML-derived) + auto-diagnosis on permission failure
    preview-diagnose.service Preview-privilege diagnosis (analytic-privilege detection + upstream reachability probe)
    repository.service      Write: XS REST official write path (workspace/file/Transfer API/design-time validate)
                             + REPOSITORY_REST repoV2 envelope (read-side/compat) + INACTIVE_OBJECT fallback
                             + writable-package allowlist (HANA_WRITE_PACKAGES)
    validation.service      Runtime view consistency check
    system.service          System info & privilege check
  tools/               MCP tool thin shells (system/package/metadata/preview/modeling)
  types/               Unified return envelope Envelope etc.
scripts/               General smoke script (smoke-stdio); real-machine verification/probe scripts are in local test-verification/ (not in repo)
```

> `tests/` and `docs/` are not committed (they contain environment identifiers/probe records, kept locally for development); after cloning, prepare tests & docs as needed.

Each tool returns a unified envelope `{ success, data?, messages[], raw? }`: hard errors (illegal params / object not found) come back via MCP `isError` with a recovery hint; HANA business failures (e.g. activation error details) go through `success:false`.

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
- XS session (`http://<host>:80<instance>/sap/hana/xs/formLogin`): the user must be able to log in to XS Classic
  (`PUBLIC` + the session capability contained in application privilege `sap.hana.xs.admin.roles::RuntimeConfOperator`; verify with `hana_check_privileges`)
- Write-target package: `REPO.EDIT_NATIVE_OBJECTS` + owner of the package or package-level write privilege

When privileges are insufficient, troubleshoot with `hana_check_privileges` first; for preview failures use `hana_data_preview_diagnose` to determine whether it's an analytic-privilege issue or upstream inaccessibility.

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
        "HANA_INSTANCE": "10",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD",
        "HANA_DB_NAME": "SYSTEMDB",
        "HANA_TLS": "false",
        "HANA_WRITE_PACKAGES": "ZDEMO1"
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
        "HANA_INSTANCE": "10",
        "HANA_USER": "YOUR_USERNAME",
        "HANA_PASSWORD": "YOUR_PASSWORD",
        "HANA_DB_NAME": "SYSTEMDB",
        "HANA_TLS": "false",
        "HANA_WRITE_PACKAGES": "ZDEMO1"
      }
    }
  }
}
```

## License

This project's own code is licensed under [MIT](LICENSE). Third-party dependencies are referenced only via npm
dependency declarations and installed by the user — not redistributed with this project. For the license list
and the usage boundary of `@sap/hana-client` (SAP Developer License 3.2), see [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).
