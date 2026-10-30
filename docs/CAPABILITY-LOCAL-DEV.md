# HorizonCode capability map (local dev vs production Guard)

This doc cross-checks the 2026-10-30 architecture review (`/tmp/architecture-review-20261030-125455.html`) against what **`scripts/horizoncode`** enables when:

- `HORIZONCODE_LOCAL_CLI=1`
- `HORIZONCODE_ALLOW_DIRECT_PROVIDER_CREDENTIALS=1`
- `hz-kernel` built

Central seam: **`packages/horizoncode/src/util/guarded-origin.ts`** (`guardedOriginAvailable(process|http|stdio)`). Principal mint: **`util/principal-mint.ts`** (HTTP `server_auth`, loopback `host_os`, CLI fallback).

## Unlocked on the local audited path

| Area | Change |
|------|--------|
| Provider keys | `horizoncode providers login/list`; TUI `/models` selects any **connected** catalog model when direct creds are allowed |
| Git read | `gitProcessRouteAvailable()` → GuardedOrigin process |
| WebFetch | Real HTTP fetch (permission-gated), not a no-op stub |
| Formatter | `formatterProcessRouteAvailable()` → GuardedOrigin process (same gate as git/bash) |
| Bash / write | `host_os` principal under local CLI + kernel lease |
| Write safety | Read-before-write via `FileReadTracker` on existing files |
| Slash HTTP | Unknown command → **404**, not 500 |
| MCP CLI | `mcp add` / config flows enabled |
| MCP runtime | **`mcp/connected-layer.ts`** (upstream connect + trust) when GuardedOrigin stdio is available; production uses stub layer |
| Turn checkpoints | Auto-`CheckpointStore.capture` at each agent step end when local CLI is armed |
| CLI limits | `horizoncode run --max-turns N`, `--max-cost USD` (env `HORIZONCODE_CLI_MAX_*`) |

## Still production-Gated (root cause #1 — full Guard lease, not local flags)

LSP/DAP/REPL/CodeMode (HostKernel journal), plugin `$` shell, project `tool/*.ts`, subagent `DIRECT_CHILD_TURN_RPC`, SecretBroker credential UI, web search production cascade (P1/P5), managed provider transport, warm kernel pool, hooks config key, model fallback chain, non-Linux containment.

## Deliberate product choices (not bugs)

- **Verify**: **`bash` + optional `label`** (`tool/verify/parameters.ts`), not a separate tool.
- **Web search**: BYO/consented routes only until P1/P5 release.

## Docs drift

Prefer paths under `packages/horizoncode/` (not `packages/opencode/`). Legacy `HANDOFF.md` / wire tracker remain historical; use this file + `bun run horizoncode:e2e` for resume evidence.
