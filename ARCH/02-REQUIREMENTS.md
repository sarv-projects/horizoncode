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
- `REQ-CTX-006` — The engine MUST reduce tool observations with native, deterministic per-command formatters (filter/group/truncate/dedupe) plus a full-output recall store; formatters MUST be eval-gated per command family and MUST NOT depend on an external filter binary.
- `REQ-CTX-007` — The engine MUST order context (tools → system → messages) for provider prompt caching, MUST place an explicit cache breakpoint at the end of static content, and MUST NOT mutate the cached prefix mid-run; cache-read/creation tokens MUST be tracked as the primary compression metric.
- `REQ-CTX-008` — Code and tool observations MUST be compressed by verbatim selection/grouping only; abstractive summarization is permitted for prose only and MUST follow a structured schema (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).
- `REQ-CTX-009` — Every compression change MUST be gated by a paired per-task evaluation (k ≥ 3) requiring task success ≥ baseline and cost/turn improvement; results MUST be reported as per-task median and pass-rate deltas. Compressor-internal counters MUST NOT be used as evidence.

## PROV (providers)

- `REQ-PROV-001` — The agent MUST support at least: hosted HTTP chat-completion endpoints (the widely implemented compatible wire format), local runtimes, and a broad third-party catalog, plus arbitrary custom HTTP chat-completion endpoints.
- `REQ-PROV-002` — The provider/model catalog MUST be data-driven from an external source of truth and MUST be consumable without vendoring its code.
- `REQ-PROV-003` — Provisional model quirk handling (thinking passthrough, reasoning fields, streaming framing) MUST be isolated per provider.
- `REQ-PROV-004` — Credentials MUST never be written to logs, model prompts, telemetry, or the audit log.
- `REQ-PROV-005` — Routing MUST be configurable by policy and MAY be eval-gated; routing decisions MUST be observable.

## GUARD / AUDIT

- `REQ-GUARD-001` — Permissions MUST be expressed as ordered rules producing allow / ask / deny, evaluated deterministically.
- `REQ-GUARD-002` — The default posture MUST fail closed: an unmatched action evaluates to ask or deny per configuration, never implicit allow.
- `REQ-GUARD-003` — "Always allow" decisions MUST persist the exact pattern they remember, shown to the user before confirmation.
- `REQ-GUARD-004` — Sandboxed execution MUST default to workspace-scoped writes and no outbound network unless explicitly granted.
- `REQ-AUDIT-001` — For a declared set of security-relevant **effect classes** (decisions, tool calls, approvals, file writes, sandbox denials, model/provider calls, cost, ticket lifecycle), every effect MUST append exactly one immutable entry to an append-only execution log; a **coverage census** MUST map every declared class to at least one recorded entry so the property is checkable rather than merely asserted.
- `REQ-AUDIT-002` — The audit log MUST be tamper-evident via a hash chain plus periodic Merkle roots, with a verification command that reports any added, removed, reordered, truncated, or modified entry; the command MUST state precisely what it does and does not prove.
- `REQ-AUDIT-003` — Secrets MUST be redacted from audit entries.
- `REQ-AUDIT-004` — Audit segment roots MUST be **anchored** beyond the local store — signed, and recorded off-box (or counter-signed) — so that a root rewritten by a local actor is detectable; the anchor's trust assumptions and strength MUST be documented per deployment.
- `REQ-AUDIT-005` — The audit MUST provide a first-class **coverage census** deliverable that enumerates every declared security-relevant effect class and the entry(ies) evidencing it, and MUST fail loudly on any uncovered class.
- `REQ-AUDIT-006` — Where an effect is represented in more than one append-only store (session log, audit chain, analytics ledger), the stores MUST satisfy a documented cross-store consistency invariant: a security-relevant effect is complete only once durably chained in audit, cross-store references carry the authoritative store sequence, and cross-store ordering MUST NOT be inferred from wall-clock time.

## PROTO

- `REQ-PROTO-001` — agentX MUST implement an ACP server over stdio supporting session create/load/resume/list/close/prompt/cancel and streamed updates.
- `REQ-PROTO-002` — agentX MUST implement permission requests to the ACP client and honor allow/deny decisions.
- `REQ-PROTO-003` — agentX MUST act as an MCP host (client), supporting stdio and streamable-HTTP servers with per-session deduplication.
- `REQ-PROTO-004` — agentX MUST expose an ACP **client** mode to drive other ACP agents as subordinates, with equal standing to its server mode.
- `REQ-PROTO-005` — The agent core MUST NOT depend on a specific UI; all surfaces talk through one control interface.
- `REQ-PROTO-006` — agentX MUST negotiate capabilities before use (ACP capability gating; MCP discovery) and MUST NOT call an ungated method.
- `REQ-PROTO-007` — agentX MUST enumerate detected MCP servers, skills, and plugins with their status in a user-inspectable surface.

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

## MEM (persistent memory)

- `REQ-MEM-001` — The agent MUST maintain a persistent project/user memory store distinct from sessions, with bounded size and an explicit compaction policy.
- `REQ-MEM-002` — Memory writes MUST be attributable and inspectable; the agent MUST NOT silently persist model guesses as facts.
- `REQ-MEM-003` — Memory MUST be injectable as a typed context source.

## SKILL

- `REQ-SKILL-001` — Skills MUST be discovered from `SKILL.md` files with `name` + `description` frontmatter; discovery roots MUST include the user scope and the project scope.
- `REQ-SKILL-002` — Skill routing MUST be description-based with progressive disclosure: only metadata is resident in context until invocation; the body loads on demand; resources and scripts load lazily.
- `REQ-SKILL-003` — Externally sourced skills MUST be pinned by version/hash before use; a pin mismatch MUST refuse to load until re-pinned.
- `REQ-SKILL-004` — A skill's declared `allowed-tools` MUST be treated as an approval hint, never as a sandbox or a grant.

## PLUGIN

- `REQ-PLUGIN-001` — Plugins MUST declare a manifest, and every component they contribute (skills, agents, hooks, MCP servers, LSP servers) MUST be enumerable.
- `REQ-PLUGIN-002` — Third-party and project plugins MUST be disabled by default and require an explicit enable.
- `REQ-PLUGIN-003` — Plugin installs MUST resolve and verify symlinks and pin a version/hash; untrusted plugin processes MUST run under the sandbox.
- `REQ-PLUGIN-004` — Every hook invocation and its outcome MUST be logged.

## ANALYTICS

- `REQ-ANALYTICS-001` — The agent MUST record per-turn usage (input/output/cache-read/cache-creation tokens) and cost, attributable per session, model, and project.
- `REQ-ANALYTICS-002` — Cost MUST distinguish observed from estimated and MUST carry a pricing version; unknown pricing MUST be reported as unknown, never fabricated.
- `REQ-ANALYTICS-003` — The agent MUST expose per-tool metrics (calls, accepted/rejected, error rate, latency percentile).
- `REQ-ANALYTICS-004` — Analytics MUST be local-only with no network egress by default; any remote export MUST be explicit opt-in and sanitizable.
- `REQ-ANALYTICS-005` — The agent MUST provide commands to view usage/insights and to export a session or the ledger machine-readably.
- `REQ-ANALYTICS-006` — Engineering analytics (tokens/cost/latency/retries) MUST be kept distinct from product/usage analytics.
