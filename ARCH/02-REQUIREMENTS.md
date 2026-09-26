# 02 — Requirements

Observable, falsifiable requirements. Grouped by area. `MUST` = hard requirement; `SHOULD` = strong default with a documented escape.

## VISION / packaging

- `REQ-VISION-001` — agentX MUST ship as a single self-contained executable per target platform, runnable with no external runtime preinstalled.
- `REQ-VISION-002` — The installer/updater MUST detect and report the host toolchain prerequisites it needs (e.g. absent build tools) with actionable instructions, and MUST NOT silently fail.
- `REQ-VISION-003` — The product MUST contain no vendor/competitor/assistant brand names in source, commits, help text, or shipped docs.

## LOOP

- `REQ-LOOP-001` — The agent MUST run a bounded step loop driven by model decisions, with a configurable maximum step count per turn.
- `REQ-LOOP-002` — The loop MUST accept **steer** (interrupt-level redirection) and **queue** (next-turn) inputs while a turn is running, without losing either.
- `REQ-LOOP-003` — Tool calls within a turn MUST execute concurrently when independent and MUST honor explicit ordering barriers when declared.
- `REQ-LOOP-004` — Every turn MUST terminate in exactly one terminal state: completed, failed, interrupted, or declined.
- `REQ-LOOP-005` — Interruption MUST stop in-flight model streaming promptly and MUST leave partial work inspectable, not silently discarded.
- `REQ-LOOP-006` — The loop MUST persist events incrementally so a crash mid-turn loses no committed step.

## TOOLS

- `REQ-TOOL-001` — The agent MUST provide first-party native tools for read, write, edit, apply-patch, glob, grep, shell, todo, question, webfetch, and websearch.
- `REQ-TOOL-002` — Every tool MUST declare a typed input schema, a typed output schema, and an optional structured result.
- `REQ-TOOL-003` — Tool registration MUST be permission-filtered: a tool denied by policy MUST be absent from the model's tool set, not merely blocked at call time.
- `REQ-TOOL-004` — Tool results MUST separate model-visible content from UI-only detail.
- `REQ-TOOL-005` — Tool names MUST match `^[A-Za-z][A-Za-z0-9_-]{0,63}$`.

## CTX (context)

- `REQ-CTX-001` — The context engine MUST maintain a ranked repository map derived from tracked files and language parsing.
- `REQ-CTX-002` — Compaction MUST trigger on a token-budget condition and MUST preserve a serialized tail plus a structured summary.
- `REQ-CTX-003` — Compaction quality MUST be gated by a retrieval evaluation, not only by fitting the window.
- `REQ-CTX-004` — The engine MUST estimate token usage before each model request and MUST handle provider context-overflow by compacting and retrying once.
- `REQ-CTX-005` — Project instructions (`AGENTS.md`) MUST be discovered hierarchically (user → repository walk) and injected as a typed context source.

## PROV (providers)

- `REQ-PROV-001` — The agent MUST support at least: hosted OpenAI-compatible endpoints, local runtimes, and a broad third-party catalog, plus arbitrary custom OpenAI-compatible endpoints.
- `REQ-PROV-002` — The provider/model catalog MUST be data-driven from an external source of truth and MUST be consumable without vendoring its code.
- `REQ-PROV-003` — Provisional model quirk handling (thinking passthrough, reasoning fields, streaming framing) MUST be isolated per provider.
- `REQ-PROV-004` — Credentials MUST never be written to logs, model prompts, telemetry, or the audit log.
- `REQ-PROV-005` — Routing MUST be configurable by policy and MAY be eval-gated; routing decisions MUST be observable.

## GUARD / AUDIT

- `REQ-GUARD-001` — Permissions MUST be expressed as ordered rules producing allow / ask / deny, evaluated deterministically.
- `REQ-GUARD-002` — The default posture MUST fail closed: an unmatched action evaluates to ask or deny per configuration, never implicit allow.
- `REQ-GUARD-003` — "Always allow" decisions MUST persist the exact pattern they remember, shown to the user before confirmation.
- `REQ-GUARD-004` — Sandboxed execution MUST default to workspace-scoped writes and no outbound network unless explicitly granted.
- `REQ-AUDIT-001` — Every security-relevant effect MUST append to an append-only execution log.
- `REQ-AUDIT-002` — The audit log MUST be tamper-evident via a hash chain or Merkle structure, with a verification command.
- `REQ-AUDIT-003` — Secrets MUST be redacted from audit entries.

## PROTO

- `REQ-PROTO-001` — agentX MUST implement an ACP server over stdio supporting session create/load/resume/list/close/prompt/cancel and streamed updates.
- `REQ-PROTO-002` — agentX MUST implement permission requests to the ACP client and honor allow/deny decisions.
- `REQ-PROTO-003` — agentX MUST act as an MCP host (client), supporting stdio and streamable-HTTP servers with per-session deduplication.
- `REQ-PROTO-004` — agentX SHOULD expose an ACP **client** mode to drive other ACP agents as subordinates.
- `REQ-PROTO-005` — The agent core MUST NOT depend on a specific UI; all surfaces talk through one control interface.

## SESS

- `REQ-SESS-001` — Sessions MUST be durable across process restart.
- `REQ-SESS-002` — Sessions MUST be replayable from the persisted event stream.
- `REQ-SESS-003` — The agent MUST support checkpoint and rewind to a prior turn boundary.
- `REQ-SESS-004` — A session MUST record the model, mode, and permission configuration it ran under.

## ORCH

- `REQ-ORCH-001` — Sub-agents MUST run in isolated sessions and return receipts (summary + metadata), not raw transcripts.
- `REQ-ORCH-002` — Sub-agent filesystem isolation SHOULD use git worktrees.
- `REQ-ORCH-003` — Parallel sub-agents MUST have non-overlapping write scopes or an explicit merge step.
- `REQ-ORCH-004` — Merge arbitration MUST be deterministic given identical inputs.
- `REQ-ORCH-005` — Sub-agent depth and count MUST be bounded by configuration.

## UI

- `REQ-UI-001` — The interface MUST be terminal-native and MUST NOT require a GUI runtime.
- `REQ-UI-002` — The dashboard MUST be terminal-native and the primary interface MUST keep the composer fixed and drafts preserved across overlays.
- `REQ-UI-003` — Completed transcript blocks MUST commit with zero layout shift.
- `REQ-UI-004` — Status indicators MUST reflect real events; no decorative progress.
- `REQ-UI-005` — The worktree cockpit MUST present the indexed worktree, file viewing, colored diffs, and in-terminal editing via an embedded mini-editor.
- `REQ-UI-006` — The cockpit MUST be a dockable, extensible pane: it can be docked to a side, collapsed/expanded, removed, restored, and toggled by top-right controls.
- `REQ-UI-007` — The theme MUST expose a user-selectable semantic accent; the default accent MUST be a cool blue.
- `REQ-UI-008` — The UI MUST honor `NO_COLOR`, `TERM=dumb`, and reduced-motion, and MUST provide a non-colour glyph for every colour-carried meaning.
- `REQ-UI-009` — All core interactions MUST be keyboard reachable.

## HORIZON (long-horizon)

- `REQ-HORIZON-001` — A session MUST be resumable after an arbitrary gap without loss of task state.
- `REQ-HORIZON-002` — The agent MUST maintain a durable task graph that survives compaction and restart.
- `REQ-HORIZON-003` — Cost and token budgets MUST be enforceable per session and MUST fail closed when exhausted.
- `REQ-HORIZON-004` — Idle/backoff behavior MUST be truthful: waiting states MUST be distinguishable from working states.

## SEC / PERF (non-functional)

- `REQ-SEC-001` — No dependency outside the approved license allowlist may enter the build; CI MUST fail otherwise.
- `REQ-SEC-002` — All external content (web, files, tool output, MCP responses) is untrusted data and MUST NOT be treated as instructions.
- `REQ-SEC-003` — Filesystem and network targets MUST be validated against policy before use.
- `REQ-PERF-001` — The binary MUST reach an interactive prompt within a bounded startup time on a warm cache.
- `REQ-PERF-002` — The live render region MUST be virtualized; only visible rows and the mutable tail are re-rendered.
- `REQ-PERF-003` — Worktree indexing MUST be incremental and MUST NOT block the agent loop.
