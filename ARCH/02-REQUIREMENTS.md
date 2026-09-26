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
- `REQ-GUARD-004` — Sandboxed execution MUST default to workspace-scoped writes and no outbound network unless explicitly granted. Every supported tier MUST declare the **network guarantee level** it provides — `enforced` (kernel/syscall or OS-capability denial of egress), `best_effort` (denial limited to the wrapped process; an escaped descendant is not separately confined), or `none` — together with its mechanism and residual; the level MUST be surfaced wherever a network-restricted profile is presented and recorded in that tier's acceptance record. A caller that requires a level the tier does not provide MUST be refused (fail closed), never silently degraded, and a tier MUST NOT claim a level stronger than it can prove.
- `REQ-AUDIT-001` — For a declared set of security-relevant **effect classes** (decisions, tool calls, approvals, file writes, sandbox denials, model/provider calls, cost, ticket lifecycle), every effect MUST append exactly one immutable entry to an append-only execution log; a **coverage census** MUST map every declared class to at least one recorded entry so the property is checkable rather than merely asserted.
- `REQ-AUDIT-002` — The audit log MUST be tamper-evident via a hash chain plus periodic Merkle roots, with a verification command that reports any added, removed, reordered, truncated, or modified entry; the command MUST state precisely what it does and does not prove.
- `REQ-AUDIT-003` — Secrets MUST be redacted from audit entries.
- `REQ-AUDIT-004` — Audit segment roots MUST be signed with a device key held by `CMP-secrets`; signing MUST NOT be configurable off. Roots MUST be anchored at a declared level: **`local-sink`** (default) — signed roots appended to a distinct, ownership- and mode-validated append-only sink outside the audit store root; or **`off-box`** — signed roots recorded off-host or counter-signed, required for any deployment that declares an off-box trust requirement. A configured-but-unreachable sink MUST fail closed: the evidence gate fails, and the run MUST NOT degrade to a weaker level presented as the configured one. **`local-trust`** (no sink) is permitted only as an explicit, acknowledged posture. The trust assumptions and strength of each level MUST be documented per deployment.
- `REQ-AUDIT-005` — The audit MUST provide a first-class **coverage census** deliverable that enumerates every declared security-relevant effect class and the entry(ies) evidencing it, and MUST fail loudly on any uncovered class.
- `REQ-AUDIT-006` — Where an effect is represented in more than one append-only store (session log, audit chain, analytics ledger), the stores MUST satisfy a documented cross-store consistency invariant: a security-relevant effect is complete only once durably chained in audit, cross-store references carry the authoritative store sequence, and cross-store ordering MUST NOT be inferred from wall-clock time.
- `REQ-AUDIT-007` — Every anchoring level MUST state, and `audit verify` MUST render, precisely what it detects and does not detect: tamper-evidence covers modification of **already-anchored** history by a principal that does not hold the anchoring credential; it does NOT prove content authenticity, does NOT detect fabrication by a principal holding local write access (and, for `local-sink`, sink-write access), and does NOT cover entries written after the last anchored root. Only the level names `local-trust`, `local-sink`, and `off-box` may describe the evidence, and `local-sink` MUST NOT be presented as `off-box`.

## PROTO

- `REQ-PROTO-001` — agentX MUST implement an ACP server over stdio supporting session create/load/resume/list/close/prompt/cancel and streamed updates.
- `REQ-PROTO-002` — agentX MUST implement the ACP client permission request method **`session/request_permission`** (the canonical, frozen wire token; no alias is accepted) and MUST honor allow/deny decisions.
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
- `REQ-SEC-003` — Filesystem and network targets MUST be validated against policy before use, with one authoritative owner per layer: `CMP-guard` authorizes the target (allow/ask/deny) and `CMP-sandbox` enforces reach before the effect. For a spawned command the hard target control is spawn-time confinement — scoped roots plus kernel-enforced deny globs over the whole process tree; a lexical scan of command arguments is a **resource-extraction and escalation signal only** — it MAY raise an ask or deny, MUST NOT lower one, and MUST NOT be the sole control.
- `REQ-PERF-001` — The binary MUST reach an interactive prompt within a bounded startup time on a warm cache.
- `REQ-PERF-002` — The live render region MUST be virtualized; only visible rows and the mutable tail are re-rendered.
- `REQ-PERF-003` — Worktree indexing MUST be incremental and MUST NOT block the agent loop.

## SEC (threat model — consolidated in `ARCH/22-SECURITY.md`)

Hard requirements derived from the threat model. Each is observable and falsifiable;
`ARCH/22` names the threat rows each discharges.

- `REQ-SEC-004` — Every filesystem target MUST be canonicalized (symlinks/junctions, platform case rules, long paths) before policy evaluation, and re-canonicalized at use; a canonical mismatch between check and use MUST deny the operation, and no policy decision may be made on a non-canonical path.
- `REQ-SEC-005` — Every filesystem effect MUST be contained at the enforcement layer: relative traversal, absolute paths outside granted roots, and mount/bind escapes MUST be denied by the kernel-facing boundary, not by a pre-scan alone.
- `REQ-SEC-006` — Command execution MUST NOT construct a shell string from model-, file-, or peer-supplied content; invocation MUST use argv-based spawn with an explicit environment allowlist, and MUST NOT forward agentX-resolved credential material to a child.
- `REQ-SEC-007` — All outbound network MUST traverse one mediated egress; each request MUST be authorized on `host`/`port`/protocol **after** name resolution, MUST connect to the validated address, and MUST re-authorize every redirect hop; loopback, private, link-local, and reserved ranges MUST be refused; non-allowlisted URL schemes MUST be refused typed.
- `REQ-SEC-008` — External content (repository text, fetched pages, tool output, skill/plugin bodies, instruction files, sub-agent receipts, peer frames) MUST be labeled and framed as untrusted data and MUST NOT be able to create a rule, ticket, grant, or decision; it MUST NOT be able to create, widen, or satisfy a **network** grant either, so a network permission is granted only by a user act and is then enforced at the confinement tier's declared `network_guarantee_level`, with a required level the tier cannot provide refused rather than approximated (`DEC-026`, `DEC-027`); any action it motivates MUST re-enter the guard-authorized path.
- `REQ-SEC-009` — Credential values MUST NOT appear in prompts, context items, tool input/output, environment snapshots, error text, panic output, TUI frames, analytics rows, audit entries, or exports; a redaction pass MUST run before any persistence, and its absence MUST be testable by a canary-corpus scan.
- `REQ-SEC-010` — Guard authorization MUST NOT imply reach: the confinement layer MUST be able to deny an already-authorized effect, and a backend that cannot apply the requested profile MUST refuse the effect rather than run it unconfined.
- `REQ-SEC-011` — The agent process MUST run with no new privileges and an empty effective/permitted capability set, MUST NOT run elevated by default, and any elevation MUST require an explicit, audited user act.
- `REQ-SEC-012` — An audit append failure MUST fail the governed action closed; `audit verify` MUST detect added, removed, reordered, truncated, and modified entries; the coverage census MUST fail loudly on any uncovered declared effect class; cross-store reconciliation gaps MUST be surfaced, never merged.
- `REQ-SEC-013` — Every session and run MUST carry enforceable ceilings for steps, tool calls, wall-clock, tokens, cost, output bytes, and concurrency; exhaustion MUST fail closed and be audited; no ceiling may be raised by a model-, peer-, or content-supplied value.
- `REQ-SEC-014` — A sub-agent's or peer agent's effective authority MUST be the intersection of the parent's ceiling and its declared scope; a receipt or peer response MUST NOT widen authority; any path, resource, or service a peer proposes MUST be re-authorized locally, and an approval MUST be bound to the specific requester and action.
- `REQ-SEC-015` — A skill, plugin, hook, or MCP server MUST be disabled until explicitly enabled, MUST be pinned by version and a content hash over a normalized file-set manifest, and its content MUST be treated as untrusted data; a pin mismatch or unresolvable provenance MUST refuse to load.
- `REQ-SEC-016` — Extension-provided processes MUST run under a confinement profile that denies ambient network to the level the tier **declares** under `DEC-026` — `enforced`, `capability`, or `best_effort`, each with its mechanism and its residual — and scopes writes to the workspace; the declared level, mechanism, and residual MUST be recorded in that extension's acceptance record (`network_guarantee_level` / `network_mechanism` / `network_residual`) and surfaced wherever the extension's confinement profile is presented, and a caller requiring a level the tier does not provide MUST be refused rather than downgraded (`DEC-027`). Package extraction MUST be confined to the package root with declared file-count and byte budgets; a hook MUST NOT be able to loosen policy, and a hook failure MUST leave the action at its original authority.
- `REQ-SEC-017` — Externally fetched provider/model metadata MUST be schema-validated, treated as data only, and MUST NOT be able to introduce an endpoint, auth scheme, or credential reference that the user did not configure; every catalog row and every cache/snapshot MUST carry recorded provenance (source, retrieval date, method, pinned revision where derived) and a content hash; runtime catalog enrichment MUST be opt-in and offline-by-default, MUST NOT silently overwrite pinned evaluation fixtures, and MUST NOT redistribute third-party marks (`DEC-021`).
- `REQ-SEC-018` — Every state, config, policy, and cache directory MUST be validated for ownership and mode before use, and a failed validation MUST fail closed rather than proceed.
- `REQ-SEC-019` — A policy, config, state, or lock path that resolves through a symlink or junction outside its expected root MUST be refused; lock, head, and temporary files MUST be created with no-follow and exclusive-create semantics.
- `REQ-SEC-020` — A referenced security-relevant effect with no audit entry, and an audit entry with no referenced session fact, MUST each be reported as an incident with an owner and MUST NOT be silently reconciled.
- `REQ-SEC-021` — Unconfined execution MUST be unreachable unless enabled by an explicit, audited user act, MUST NOT be reachable from project-scoped configuration, and the active confinement posture MUST be displayed in every surface that can present an effect.
- `REQ-SEC-022` — Malformed or hostile tool input, protocol frames, configuration, patch text, and package members MUST be rejected with typed errors: no panic, no partial application, and no allocation or loop driven by an untrusted size or count field.
- `REQ-SEC-023` — Structural boundary properties MUST be enforced by automated checks that fail the build: no effect path without a guard assertion and an audit append, no permission evaluation outside the guard, and no direct network-client construction above the mediated egress layer.
- `REQ-SEC-024` — The anchoring status of a run MUST be surfaced wherever audit history is presented; a run without an off-box anchor MUST be labeled local-trust and MUST NOT be presented as independently verified, and a configured-but-unreachable anchor MUST fail the release gate rather than degrade silently.
- `REQ-SEC-025` — Exactly one component evaluates path policy (`CMP-guard`) and exactly one enforces path reach (`CMP-sandbox`); no other component may return a path allow/ask/deny or be the sole path control. `exec.run` rules MUST match the command token prefix only and MUST NOT carry path-shaped resources; a path named by a shell argument is expressed as an `fs.*` resource so it is evaluated by the same path matcher. A command argument naming a path outside the granted roots, not deny-globbed and not explicitly allowed, MUST resolve to `ask` at minimum; a deny-glob or protected-subpath match MUST resolve to `deny`; and a tier that cannot confine the reach MUST refuse the effect.

## VER (verification — strategy in `ARCH/23-VERIFICATION.md`)

Requirements about how claims become evidence. `ARCH/23` owns the layers, the P1
acceptance matrix, the determinism/flake policy, the budgets, and the release gates.

- `REQ-VER-001` — Every capability MUST declare its evidence layers and its acceptance-record path; a capability without an acceptance record MUST report readiness as unverified, and the state "implemented but unverified" MUST be labeled wherever the capability appears.
- `REQ-VER-002` — No test may depend on wall-clock time, real network, a live model, or machine-dependent input; the clock, identifier source, randomness, home/state directory, environment, and transport MUST be injectable.
- `REQ-VER-003` — Provider and HTTP behavior MUST be exercised against mock or in-process transports and loopback servers bound to an ephemeral local port; a test that attempts any non-loopback connection MUST fail.
- `REQ-VER-004` — The full suite MUST pass at least five consecutive clean runs on the merge gate, and process- or platform-sensitive suites at least twenty repetitions; a quarantined test MUST record an owner, reason, issue, and expiry, and a quarantined security-relevant test MUST block release.
- `REQ-VER-005` — Sandbox containment MUST be proven by executable tests per supported tier: denied-path read denial, write denial outside writable roots, rename-out-of-deny-set denial, the tier's **declared** network guarantee level, allowlist precision, empty capability set, and fail-closed behavior with the backend unavailable; a skipped sub-check MUST fail the run. The network sub-check asserts the level the tier declares under `DEC-026`/`DEC-027` and NOT one universal no-network claim: for `enforced` (Linux) the `connect`-class syscalls are denied and only `AF_UNIX` sockets succeed; for `capability` (Windows) an outbound attempt fails because the capability is absent; for `best_effort` (macOS) the wrapped process is denied **and** the residual is proven to be disclosed in the surface and the record. The acceptance record stores `network_guarantee_level`, `network_mechanism`, and `network_residual`, and `ACC-P1-01(d)` is the assertion (`ACC-P1-01(j)` is its refusal half). Linux `enforced` remains the required level for any profile advertised as network-restricted, and a tier that cannot meet a required level MUST refuse the request rather than degrade it.
- `REQ-VER-006` — Guard precedence MUST be proven by a committed decision table covering deny/ask/allow ordering, the outer deny ceiling, the plan-mode ceiling, the fail-closed unmatched effect, rule-layer fallback, and exactness of the persisted "always allow" pattern; a mismatch between the evaluator and the table MUST fail.
- `REQ-VER-007` — The approval path MUST be proven end-to-end through the protocol permission request: exactly one request per decision, the recorded reply equal to the client's reply, reject (never allow) when the client lacks the capability, deny on disconnect per the configured policy, per-session serialization, and a rejection ending the turn declined without becoming model-facing output.
- `REQ-VER-008` — Audit verification MUST be proven with a negative control: a tampered copy in which an entry is added, removed, reordered, truncated, and modified MUST each be detected with the failing sequence named; the coverage census MUST fail on an injected uncovered class; a redaction canary MUST be absent from every entry, root, verify output, replay output, and export.
- `REQ-VER-009` — Session replay and crash-tail repair MUST be byte-deterministic for a given event log, verified by golden transcripts and by a real kill/restart matrix with zero divergence; a stored format newer than the build MUST be refused typed with no partial decode.
- `REQ-VER-010` — Compaction MUST be gated by a pre-registered retrieval probe evaluated after each compaction; a probe regression MUST block the strategy change, a compaction boundary MUST never split a tool call from its result, and an overflow MUST trigger exactly one compact-and-retry.
- `REQ-VER-011` — Every turn terminal state MUST map to exactly one documented headless exit code, the numeric mapping MUST be documented in `--help`, and a test MUST fail if the implementation and `--help` disagree.
- `REQ-VER-012` — Each performance budget MUST be measured by a repeatable procedure with a recorded machine baseline; a budget without a recorded baseline MUST be reported as unmeasured and MUST NOT be reported as passing, and no budget may be met by weakening a security control.
- `REQ-VER-013` — A release MUST be blocked unless the license allowlist gate, provenance records, the generated third-party notices bundle, a zero-quarantine multi-run suite streak, containment acceptance for every supported tier, audit verification plus coverage census with a reachable anchor, the exit-code contract, the session migration chain, brand-name scanning, a clean fuzz cycle, and per-requirement traceability all pass.
- `REQ-VER-014` — Every acceptance record MUST be bound to a build identifier, the exact commit, the platform, the tier, and the backend; a record MUST NOT be presented as evidence for a different build, platform, or tier.
- `REQ-VER-015` — No surface, document, or status view may present a capability as ready, verified, contained, or audited without a linked acceptance record; mocks, previews, catalog entries, and unit-test results are explicitly not acceptance evidence.
- `REQ-VER-016` — Parsers for untrusted formats (protocol frames, configuration, tool input/output, patch text, package archives, catalog records) MUST have fuzz targets; a crash, panic, or unbounded allocation found by fuzzing MUST block release, and the minimized input MUST be committed to the corpus.
- `REQ-VER-017` — A fixed defect MUST land with a regression test that fails without the fix; a fix without a regression test is not complete.
- `REQ-VER-018` — An eval-gated capability MUST NOT ship before the harness that judges it can be run at the moment it ships; a gate that can only be satisfied retroactively does not satisfy this requirement.

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
