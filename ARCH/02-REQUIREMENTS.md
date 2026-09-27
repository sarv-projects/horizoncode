# 02 — Requirements

Observable, falsifiable requirements. Grouped by area. `MUST` = hard requirement; `SHOULD` = strong default with a documented escape.

## VISION / packaging

- `REQ-VISION-001` — HorizonCode MUST ship one primary executable per supported target where feasible. Required and optional host capabilities (for example sandbox helpers, Git, language servers, local inference servers, or a supervised detached controller) MUST be probed, disclosed, version-checked where needed, and refused with actionable guidance when an effect cannot meet its declared contract. “Single executable” MUST NOT imply that every capability has no host dependency (`DEC-030`).
- `REQ-VISION-002` — The installer/updater MUST detect and report the host toolchain prerequisites it needs (e.g. absent build tools) with actionable instructions, and MUST NOT silently fail.
- `REQ-VISION-003` — Product positioning and help MUST remain neutral and evidence-bound. Factual provider/model names required for configuration, route selection, usage, attribution, and source provenance MAY appear; no peer name may imply an unmeasured quality claim (`DEC-030`).

## LOOP

- `REQ-LOOP-001` — The agent MUST run a bounded step loop driven by model decisions, with a configurable maximum step count per turn.
- `REQ-LOOP-002` — The loop MUST accept **steer** (interrupt-level redirection) and **queue** (next-turn) inputs while a turn is running, without losing either.
- `REQ-LOOP-003` — Tool calls within a turn MUST execute concurrently when independent and MUST honor explicit ordering barriers when declared.
- `REQ-LOOP-004` — Every turn MUST terminate in exactly one terminal state: completed, failed, interrupted, or declined.
- `REQ-LOOP-005` — Interruption MUST stop in-flight model streaming promptly and MUST leave partial work inspectable, not silently discarded.
- `REQ-LOOP-006` — The loop MUST persist events incrementally so a crash mid-turn loses no committed step.
- `REQ-LOOP-007` — Steer, queued prompt, and clarification inputs MUST have stable caller-supplied or generated delivery IDs, durable admission receipts, bounded payload/count/age limits, and idempotent retry semantics. A duplicate ID with the same digest returns the original receipt; the same ID with different content is a typed conflict. Compaction MUST NOT erase admitted-but-unconsumed input.

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
- `REQ-CTX-007` — The engine MUST produce a deterministic, versioned context projection and let each provider adapter render it in that API's required order and cache-control format. Where supported, static-prefix/cache breakpoints MUST be explicit and immutable within a context epoch; cache-read/creation/input usage MUST be recorded as separate provider-reported fields and MUST NOT be assumed when unsupported.
- `REQ-CTX-008` — Code and tool observations MUST be compressed by verbatim selection/grouping only; abstractive summarization is permitted for prose only and MUST follow a structured schema (decisions / open bugs with exact errors / file refs / next step / discarded-and-where-to-recover).
- `REQ-CTX-009` — Every compression change MUST be gated by a paired per-task evaluation with a pre-registered sample size and endpoints; three pairs are smoke evidence only. Report task success, raw per-task outcomes, cost/turn, latency, recall, and uncertainty. Output-byte reduction or compressor-internal counters MUST NOT be presented as cost savings or task evidence.
- `REQ-CTX-010` — Extension tool catalogs MUST be discoverable without injecting every tool schema into each model request. The selected schema set MUST be permission-filtered, token-budgeted, version-pinned for a model step, and refreshable at a new context epoch; unavailable or changed tools MUST fail typed before execution.

## PROV (providers)

- `REQ-PROV-001` — The agent MUST support hosted and user-configured compatible HTTP endpoints, including local inference servers. Any built-in model catalog MUST remain a curated, provenance-bearing subset; broader discovery MAY be opt-in enrichment. A provider being listed or API-compatible MUST NOT imply concrete model/template capability (`DEC-021`, `REQ-PROV-006`).
- `REQ-PROV-002` — The built-in catalog MUST have a small curated primary set with per-record provenance and a usable offline path. Broader catalog enrichment MAY be fetched only when explicitly enabled, schema-validated, content-hashed, and unable to choose or change an endpoint, authentication method, or credential. Catalog records are data; their upstream implementation is not vendored (`DEC-021`).
- `REQ-PROV-003` — Provisional model quirk handling (thinking passthrough, reasoning fields, streaming framing) MUST be isolated per provider.
- `REQ-PROV-004` — Credentials MUST never be written to logs, model prompts, telemetry, or the audit log.
- `REQ-PROV-005` — Routing MUST be configurable by policy and MAY be eval-gated; routing decisions MUST be observable.

## GUARD / AUDIT

- `REQ-GUARD-001` — Permissions MUST be expressed as ordered rules producing allow / ask / deny, evaluated deterministically.
- `REQ-GUARD-002` — The default posture MUST fail closed: an unmatched action evaluates to ask or deny per configuration, never implicit allow.
- `REQ-GUARD-003` — "Always allow" decisions MUST persist the exact pattern they remember, shown to the user before confirmation.
- `REQ-GUARD-004` — Sandboxed execution MUST default to workspace-scoped writes and a request for no outbound network unless explicitly granted. Every supported tier MUST declare one of `enforced | capability | best_effort | none` with its mechanism, proof, and residual. These labels describe tested network reachability boundaries; they do not assert that a particular syscall is blocked. `capability` means denial by absence of an OS network capability, with a separate acceptance test. The level MUST be surfaced wherever a network-restricted profile is presented and recorded in that tier's acceptance record. A caller requiring a stronger level MUST be refused, never silently degraded. A tier MUST NOT claim a level stronger than it proves (`DEC-026`, `DEC-027`).
- `REQ-AUDIT-001` — Every security-relevant effect MUST receive a stable `effect_id`, a durable prepare record before execution, and exactly one terminal outcome receipt (`completed | denied | failed | unknown`) linked to that ID; lifecycle entries may additionally exist. A runtime reconciliation MUST detect a prepared effect without a terminal receipt, a terminal receipt without an intent/session fact, and a duplicated terminal receipt. A class census is a separate static coverage check and does not prove per-effect completeness (`DEC-031`).
- `REQ-AUDIT-002` — The audit log MUST be tamper-evident via a hash chain plus periodic Merkle roots, with a verification command that reports any added, removed, reordered, truncated, or modified entry; the command MUST state precisely what it does and does not prove.
- `REQ-AUDIT-003` — Secrets MUST be redacted from audit entries.
- `REQ-AUDIT-004` — Audit segment roots MUST be signed with a device key held by `CMP-secrets`; signing MUST NOT be configurable off. Roots MUST be anchored at a declared level: **`local-sink`** (default) — signed roots appended to a distinct, ownership- and mode-validated append-only sink outside the audit store root; or **`off-box`** — signed roots recorded off-host or counter-signed, required for any deployment that declares an off-box trust requirement. A configured-but-unreachable sink MUST fail closed: the evidence gate fails, and the run MUST NOT degrade to a weaker level presented as the configured one. **`local-trust`** (no sink) is permitted only as an explicit, acknowledged posture. The trust assumptions and strength of each level MUST be documented per deployment.
- `REQ-AUDIT-005` — The audit MUST provide a first-class class-coverage census and a per-effect reconciliation report over stable effect IDs. Both MUST fail loudly on gaps; the census alone MUST NOT be presented as runtime completeness evidence.
- `REQ-AUDIT-006` — Where an effect is represented in more than one append-only store (session log, audit chain, analytics ledger), the stores MUST satisfy a documented cross-store consistency invariant: a security-relevant effect is complete only once durably chained in audit, cross-store references carry the authoritative store sequence, and cross-store ordering MUST NOT be inferred from wall-clock time.
- `REQ-AUDIT-007` — Every anchoring level MUST state, and `audit verify` MUST render, precisely what it detects and does not detect: tamper-evidence covers modification of **already-anchored** history by a principal that does not hold the anchoring credential; it does NOT prove content authenticity, does NOT detect fabrication by a principal holding local write access (and, for `local-sink`, sink-write access), and does NOT cover entries written after the last anchored root. Only the level names `local-trust`, `local-sink`, and `off-box` may describe the evidence, and `local-sink` MUST NOT be presented as `off-box`.

## PROTO

- `REQ-PROTO-001` — HorizonCode MUST implement an ACP server over stdio for the negotiated wire version. It MUST advertise only implemented and tested methods/capabilities. The v1 target includes baseline `initialize`, `session/new`, `session/prompt`, `session/cancel`, and streamed `session/update`; optional session methods include `session/load`, `session/resume`, `session/list`, `session/delete`, `session/close`, `session/set_mode`, and `session/set_config_option`, each gated by the exact v1 capability/schema contract. `session/fork` is unstable in v1 and MUST remain behind an explicit unstable-protocol feature gate. UI detach, task graph operations, and any internal checkpoint/rewind remain HorizonCode control-plane APIs, not ACP methods. The current server supports only methods listed in `ARCH/15`'s status block.
- `REQ-PROTO-002` — When acting as an ACP agent, HorizonCode MUST send permission requests to the client using the canonical ACP method **`session/request_permission`** and MUST honor the returned allow/deny decision. When acting as a client, it MUST implement the corresponding client handler. No non-standard alias is accepted.
- `REQ-PROTO-003` — HorizonCode MUST act as an MCP host (client), supporting stdio and streamable-HTTP servers with per-session deduplication.
- `REQ-PROTO-004` — HorizonCode MUST expose an ACP **client** mode to drive other ACP agents as subordinates, with equal standing to its server mode.
- `REQ-PROTO-005` — The agent core MUST NOT depend on a specific UI; all surfaces talk through one control interface.
- `REQ-PROTO-006` — HorizonCode MUST negotiate capabilities before use (ACP capability gating; MCP discovery) and MUST NOT call an ungated method.
- `REQ-PROTO-007` — HorizonCode MUST enumerate detected MCP servers, skills, and plugins with their status in a user-inspectable surface.

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
- `REQ-ORCH-006` — Delegation MUST be optional and justified by bounded task decomposition, isolated write scopes, expected evidence gain, and budget. The controller MUST be able to keep work sequential when delegation's orchestration, context-replay, or integration cost is not justified; worker count MUST NOT be used as a proxy for progress.

## UI

- `REQ-UI-001` — The interface MUST be terminal-native and MUST NOT require a GUI runtime.
- `REQ-UI-002` — The dashboard MUST be terminal-native and the primary interface MUST keep the composer fixed and drafts preserved across overlays.
- `REQ-UI-003` — Completed transcript blocks MUST commit with zero layout shift.
- `REQ-UI-004` — Status indicators MUST reflect real events; no decorative progress.
- `REQ-UI-005` — The worktree cockpit MUST present the indexed worktree and file viewing/diff. Editing MUST support a governed in-terminal path and a governed external-editor handoff; an embedded mini-editor MAY be provided, but MUST NOT be the only editing path. Large/binary files need an explicit supported/read-only outcome.
- `REQ-UI-006` — The cockpit MUST be a dockable, extensible pane: it can be docked to a side, collapsed/expanded, removed, restored, and toggled by top-right controls.
- `REQ-UI-007` — The theme MUST expose a user-selectable semantic accent; the default accent MUST be a cool blue.
- `REQ-UI-008` — The UI MUST honor `NO_COLOR`, `TERM=dumb`, and reduced-motion, and MUST provide a non-colour glyph for every colour-carried meaning.
- `REQ-UI-009` — All core interactions MUST be keyboard reachable.

## HORIZON (long-horizon)

- `REQ-HORIZON-001` — A session MUST be resumable after an arbitrary gap without loss of task state.
- `REQ-HORIZON-002` — The agent MUST maintain a durable task graph that survives compaction and restart.
- `REQ-HORIZON-003` — Cost and token budgets MUST be enforceable per session and MUST fail closed when exhausted.
- `REQ-HORIZON-004` — Idle/backoff behavior MUST be truthful: waiting states MUST be distinguishable from working states.
- `REQ-HORIZON-012` — A permission request raised by a child or external worker MUST be correlated to the owning run and requester, forwarded to an authorized interactive surface, and returned to the original request. Missing mapping, unavailable client, or timeout MUST produce a typed denial/cancellation and settle the child; it MUST NOT disappear or wait indefinitely.
- `REQ-HORIZON-013` — Event delivery to clients MUST use bounded queues and durable sequence/cursor replay. Slow-client handling MUST emit an explicit gap/resnapshot condition or disconnect with a recoverable cursor; events MUST NOT be silently dropped, nor may an unbounded queue exhaust process memory. Request lanes MUST isolate unrelated control operations so one hung request cannot wedge all work.
- `REQ-HORIZON-014` — Dispatch MUST define fairness and starvation bounds across interactive steering, queued user work, verification, and background tasks. Priority MUST NOT allow repeated background or verification work to starve user control; cancellation and approval responses receive bounded service time.

## SEC / PERF (non-functional)

- `REQ-SEC-001` — No dependency outside the approved license allowlist may enter the build; CI MUST fail otherwise.
- `REQ-SEC-002` — All external content (web, files, tool output, MCP responses) is untrusted data and MUST NOT be treated as instructions.
- `REQ-SEC-003` — Filesystem and network targets MUST be validated against policy before use, with one authoritative owner per layer: `CMP-guard` authorizes the target (allow/ask/deny) and `CMP-sandbox` applies the reach boundary before the effect. For a spawned command, the hard target control is spawn-time confinement using the selected OS backend; its scope and residual MUST be recorded and accepted for that tier. A lexical scan of command arguments is a **resource-extraction and escalation signal only** — it MAY raise an ask or deny, MUST NOT lower one, and MUST NOT be the sole confinement control.
- `REQ-PERF-001` — The binary MUST reach an interactive prompt within a bounded startup time on a warm cache.
- `REQ-PERF-002` — The live render region MUST be virtualized; only visible rows and the mutable tail are re-rendered.
- `REQ-PERF-003` — Worktree indexing MUST be incremental and MUST NOT block the agent loop.

## SEC (threat model — consolidated in `ARCH/22-SECURITY.md`)

Hard requirements derived from the threat model. Each is observable and falsifiable;
`ARCH/22` names the threat rows each discharges.

- `REQ-SEC-004` — Every filesystem target MUST be canonicalized (symlinks/junctions, platform case rules, long paths) before policy evaluation, and re-canonicalized at use; a canonical mismatch between check and use MUST deny the operation, and no policy decision may be made on a non-canonical path.
- `REQ-SEC-005` — Every filesystem effect MUST be contained at the enforcement layer: relative traversal, absolute paths outside granted roots, and mount/bind escapes MUST be denied by the kernel-facing boundary, not by a pre-scan alone.
- `REQ-SEC-006` — Process invocation MUST use argv-based spawn with an explicit environment allowlist and MUST NOT concatenate untrusted values into a shell script. An explicitly requested shell-script tool MAY pass its complete, model-supplied script as one `sh -c` argument only after showing and authorizing that exact script and applying an enforceable confinement profile. It MUST be classified and audited as shell execution, not described as inert argv execution. No HorizonCode-resolved credential may be forwarded to a child (`DEC-031`).
- `REQ-SEC-007` — All HorizonCode-owned HTTP requests MUST use one mediated egress that authorizes the resolved address and each redirect hop; private, link-local, loopback, and reserved ranges are refused unless an explicit higher-trust policy grants that target. Child processes MUST have network denied by an independently proven confinement mechanism or use a forced egress broker that the child cannot bypass. A profile whose backend cannot prove either condition MUST refuse network-restricted execution rather than claim mediation (`DEC-031`).
- `REQ-SEC-008` — External content (repository text, fetched pages, tool output, skill/plugin bodies, instruction files, sub-agent receipts, peer frames) MUST be labeled and framed as untrusted data and MUST NOT be able to create a rule, ticket, grant, or decision; it MUST NOT be able to create, widen, or satisfy a **network** grant either, so a network permission is granted only by a user act and is then enforced at the confinement tier's declared `network_guarantee_level`, with a required level the tier cannot provide refused rather than approximated (`DEC-026`, `DEC-027`); any action it motivates MUST re-enter the guard-authorized path. Network guarantee describes reachable network paths, not denial of the `socket()` API itself; local IPC such as `AF_UNIX` is a separate resource boundary and MUST be separately scoped.
- `REQ-SEC-009` — Credential values MUST NOT appear in prompts, context items, tool input/output, environment snapshots, error text, panic output, TUI frames, analytics rows, audit entries, or exports; a redaction pass MUST run before any persistence, and its absence MUST be testable by a canary-corpus scan.
- `REQ-SEC-010` — Guard authorization MUST NOT imply reach: the confinement layer MUST be able to deny an already-authorized effect, and a backend that cannot apply the requested profile MUST refuse the effect rather than run it unconfined.
- `REQ-SEC-011` — The agent process MUST run with no new privileges and an empty effective/permitted capability set, MUST NOT run elevated by default, and any elevation MUST require an explicit, audited user act.
- `REQ-SEC-012` — An audit append failure MUST fail the governed action closed; `audit verify` MUST detect added, removed, reordered, truncated, and modified entries; the coverage census MUST fail loudly on any uncovered declared effect class; cross-store reconciliation gaps MUST be surfaced, never merged.
- `REQ-SEC-013` — Every session and run MUST carry enforceable ceilings for steps, tool calls, wall-clock, tokens, cost, output bytes, and concurrency; exhaustion MUST fail closed and be audited; no ceiling may be raised by a model-, peer-, or content-supplied value.
- `REQ-SEC-014` — A sub-agent's or peer agent's effective authority MUST be the intersection of the parent's ceiling and its declared scope; a receipt or peer response MUST NOT widen authority; any path, resource, or service a peer proposes MUST be re-authorized locally, and an approval MUST be bound to the specific requester and action.
- `REQ-SEC-015` — A skill, plugin, hook, or MCP server MUST be disabled until explicitly enabled, MUST be pinned by version and a content hash over a normalized file-set manifest, and its content MUST be treated as untrusted data; a pin mismatch or unresolvable provenance MUST refuse to load.
- `REQ-SEC-016` — Extension-provided processes MUST run under a confinement profile that denies ambient network to the level the tier **declares** under `DEC-026` — `enforced`, `capability`, `best_effort`, or `none`, each with its mechanism and its residual — and scopes writes to the workspace; the declared level, mechanism, and residual MUST be recorded in that extension's acceptance record (`network_guarantee_level` / `network_mechanism` / `network_residual`) and surfaced wherever the extension's confinement profile is presented, and a caller requiring a level the tier does not provide MUST be refused rather than downgraded (`DEC-027`). Package extraction MUST be confined to the package root with declared file-count and byte budgets; a hook MUST NOT be able to loosen policy, and a hook failure MUST leave the action at its original authority.
- `REQ-SEC-017` — Externally fetched provider/model metadata MUST be schema-validated, treated as data only, and MUST NOT be able to introduce an endpoint, auth scheme, or credential reference that the user did not configure; every catalog row and every cache/snapshot MUST carry recorded provenance (source, retrieval date, method, pinned revision where derived) and a content hash; runtime catalog enrichment MUST be opt-in and offline-by-default, MUST NOT silently overwrite pinned evaluation fixtures, and MUST NOT redistribute third-party marks (`DEC-021`).
- `REQ-SEC-018` — Every state, config, policy, and cache directory MUST be validated for ownership and mode before use, and a failed validation MUST fail closed rather than proceed.
- `REQ-SEC-019` — A policy, config, state, or lock path that resolves through a symlink or junction outside its expected root MUST be refused; lock, head, and temporary files MUST be created with no-follow and exclusive-create semantics.
- `REQ-SEC-020` — A referenced security-relevant effect with no audit entry, and an audit entry with no referenced session fact, MUST each be reported as an incident with an owner and MUST NOT be silently reconciled.
- `REQ-SEC-021` — Unconfined execution MUST be unreachable unless enabled by an explicit, audited user act, MUST NOT be reachable from project-scoped configuration, and the active confinement posture MUST be displayed in every surface that can present an effect.
- `REQ-SEC-022` — Malformed or hostile tool input, protocol frames, configuration, patch text, and package members MUST be rejected with typed errors: no panic, no unreported partial application, and no allocation or loop driven by an untrusted size or count field. Multi-file patch operations MUST preflight all hunks and base hashes before any mutation; commit is all-or-nothing where the filesystem permits it. If a crash interrupts commit, recovery MUST enumerate every already-applied file and reconcile or roll back before the task can proceed (`DEC-031`).
- `REQ-SEC-023` — Structural boundary properties MUST be enforced by automated checks that fail the build: no effect path without a guard assertion and an audit append, no permission evaluation outside the guard, and no direct network-client construction above the mediated egress layer.
- `REQ-SEC-024` — The actual anchoring level (`local-trust | local-sink | off-box`) MUST be surfaced wherever audit history is presented. Neither local level may be presented as independent off-box verification; the claim boundary for fabrication and the unanchored tail MUST be shown. A configured-but-unreachable required anchor MUST fail closed rather than silently degrade.
- `REQ-SEC-025` — Exactly one component evaluates path policy (`CMP-guard`) and exactly one applies path reach (`CMP-sandbox`); no other component may return a path allow/ask/deny or be the sole path control. `exec.run` rules MUST match the command token prefix only and MUST NOT carry path-shaped resources; a path named by a shell argument is expressed as an `fs.*` resource so it is evaluated by the same path matcher. A command argument naming a path outside the granted roots, not deny-globbed and not explicitly allowed, MUST resolve to `ask` at minimum; a deny-glob or protected-subpath match MUST resolve to `deny`; and a tier that cannot enforce the required reach MUST refuse the effect. Acceptance records MUST distinguish caller-side checks from child-process OS confinement.

## VER (verification — strategy in `ARCH/23-VERIFICATION.md`)

Requirements about how claims become evidence. `ARCH/23` owns the layers, the P1
acceptance matrix, the determinism/flake policy, the budgets, and the release gates.

- `REQ-VER-001` — Every capability MUST declare its evidence layers and its acceptance-record path; a capability without an acceptance record MUST report readiness as unverified, and the state "implemented but unverified" MUST be labeled wherever the capability appears.
- `REQ-VER-002` — No test may depend on wall-clock time, real network, a live model, or machine-dependent input; the clock, identifier source, randomness, home/state directory, environment, and transport MUST be injectable.
- `REQ-VER-003` — Provider and HTTP behavior MUST be exercised against mock or in-process transports and loopback servers bound to an ephemeral local port; a test that attempts any non-loopback connection MUST fail.
- `REQ-VER-004` — The full suite MUST pass at least five consecutive clean runs on the merge gate, and process- or platform-sensitive suites at least twenty repetitions; a quarantined test MUST record an owner, reason, issue, and expiry, and a quarantined security-relevant test MUST block release.
- `REQ-VER-005` — Sandbox containment MUST be proven by executable tests per supported tier: denied-path read denial, write denial outside writable roots, rename-out-of-deny-set denial, the tier's **declared** network guarantee level, applicable capability restrictions, and fail-closed behavior when the backend is unavailable; a skipped sub-check MUST fail the run. Network tests assert actual reachable paths and the documented residual for the selected mechanism; they MUST NOT substitute a syscall assertion for a reachability claim. Allowlist precision is accepted only for a backend with an unbypassable broker. The record stores `network_guarantee_level`, `network_mechanism`, and `network_residual`; `ACC-P1-01(d)` is the evidence check and its refusal sub-check is `ACC-P1-01(j)`. A caller's required network level is a separate policy input; a tier that cannot meet it MUST refuse rather than degrade.
- `REQ-VER-006` — Guard precedence MUST be proven by a committed decision table covering deny/ask/allow ordering, the outer deny ceiling, the plan-mode ceiling, the fail-closed unmatched effect, rule-layer fallback, and exactness of the persisted "always allow" pattern; a mismatch between the evaluator and the table MUST fail.
- `REQ-VER-007` — The approval path MUST be proven end-to-end through ACP's baseline `session/request_permission` method: exactly one request per decision; schema-valid option kinds with opaque option IDs round-trip unchanged; an unsupported method, malformed response, disconnect, or timeout fails closed; replies are recorded and correlated to the originating effect; cancellation is distinct from user rejection; requests are serialized per session without blocking cancel/control; and rejection ends the turn declined without becoming model-facing output.
- `REQ-VER-008` — Audit verification MUST be proven with a negative control: a tampered copy in which an entry is added, removed, reordered, truncated, and modified MUST each be detected with the failing sequence named; the coverage census MUST fail on an injected uncovered class; a redaction canary MUST be absent from every entry, root, verify output, replay output, and export.
- `REQ-VER-009` — Session replay and crash-tail repair MUST be byte-deterministic for a given event log, verified by golden transcripts and by a real kill/restart matrix with zero divergence; a stored format newer than the build MUST be refused typed with no partial decode.
- `REQ-VER-010` — Compaction MUST be gated by a pre-registered retrieval probe evaluated after each compaction; a probe regression MUST block the strategy change, a compaction boundary MUST never split a tool call from its result, and an overflow MUST trigger exactly one compact-and-retry.
- `REQ-VER-011` — Every turn terminal state MUST map to exactly one documented headless exit code, the numeric mapping MUST be documented in `--help`, and a test MUST fail if the implementation and `--help` disagree.
- `REQ-VER-012` — Each performance budget MUST be measured by a repeatable procedure with a recorded machine baseline; a budget without a recorded baseline MUST be reported as unmeasured and MUST NOT be reported as passing, and no budget may be met by weakening a security control.
- `REQ-VER-013` — A release MUST be blocked unless the license allowlist gate, provenance records, the generated third-party notices bundle, a zero-quarantine multi-run suite streak, containment acceptance for every supported tier, audit verification plus class census and per-effect reconciliation with the required reachable anchor, the exit-code contract, the session migration chain, evidence-bound product-claim review, a clean fuzz cycle, and per-requirement traceability all pass. A multi-hour-autonomy claim additionally requires `ACC-H1-01..06`.
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
- `REQ-ANALYTICS-007` — Monetary observations MUST preserve original amount, ISO currency, amount basis (`actual | estimated | included | unknown`), source/pricing version, and time. Mixed currencies MUST NOT be summed as one amount. Any converted display MUST identify the rate, source, timestamp, and rounding; historical source amounts remain immutable. Token/quota consumption MUST remain visible when billed amount is included or zero.

## LONG HORIZON CONTROL (integrated design in `ARCH/25-LONG-HORIZON-CONTROL.md`)

- `REQ-HORIZON-005` — The original user request, confirmed requirements, assumptions, exclusions, examples, technical decisions, and specification revisions MUST be stored separately with provenance. A change to user-visible behavior MUST create a new approved specification version and invalidate affected tasks and evidence.
- `REQ-HORIZON-006` — A run, session, turn, task, attempt, external-agent attempt, workspace, and verification record MUST have distinct identities and lifecycles. Only a task with independent `PASS` evidence bound to the current specification digest and exact tested repository revision may satisfy a downstream dependency.
- `REQ-HORIZON-007` — One deterministic controller MUST own dispatch, atomic budget reservations, retry accounting, lease fencing, recovery classification, and stop decisions. Completion MUST be derived from mandatory acceptance evidence; budget exhaustion, no ready task, disconnection, and waiting for a user MUST remain distinct outcomes.
- `REQ-HORIZON-008` — Before replaying an interrupted effect, the controller MUST reconcile its intent, authorization, workspace state, audit receipt, and external provider/PR outcome. Unknown or non-idempotent effects MUST wait for investigation; starting a new model or protocol session MUST NOT reset attempts or spend.
- `REQ-HORIZON-009` — A delegated agent MUST have an HorizonCode-owned attempt record with peer identity, protocol/version and capability snapshot, external session ID if supplied, event cursor, workspace/base revision, authority scope, usage provenance, and opaque-state limitations. Unreported nested work or usage MUST be displayed as unknown.
- `REQ-HORIZON-010` — Final integration MUST reverify the combined revision against current specification and original confirmed intent. A worker's completion text, tool success, and isolated-worktree tests MUST NOT by themselves mark the run complete.
- `REQ-HORIZON-011` — A multi-hour run MUST survive UI client disconnect without being cancelled. A detached run MUST have a supervised controller process and authenticated attach path that returns a sequence-stamped snapshot followed by ordered event replay; a cursor gap MUST resnapshot. A stopped host MUST be shown as last-known state, never as active progress.

## REPOSITORY AND DELIVERY

- `REQ-REPO-001` — Repository maps and task context packages MUST retain source revision, file digests, parser/index version, source locations, confidence, and stale-state marker. Source reads and lexical search remain a fallback when semantic indexes are absent or stale.
- `REQ-REPO-002` — Symbol edits and rename operations MUST use versioned source ranges or editor/LSP workspace edits, verify all affected base hashes, and preserve a reviewable diff. A stale semantic result MUST refuse or refresh before writing.
- `REQ-DELIVERY-001` — PR preparation MUST record branch/base/head, intended files, diff review, test and independent review evidence, CI state, and external PR identity. Creating, commenting, merging, releasing, and deploying are separate governed effects with idempotency and approval policy.
- `REQ-RESEARCH-001` — External research used for a design or coding decision MUST record source URL/revision, retrieval time, authoritativeness, relevant excerpt or claim, and whether the claim was independently confirmed. Fetched content remains untrusted data; a stale or unavailable source MUST be labeled, and a model-generated citation MUST NOT be treated as evidence without retrieval.

## PERSONALIZATION AND LOCAL MODELS

- `REQ-UI-010` — Every surface MUST offer typed, discoverable settings for theme/colour and accessibility, model/provider/agent selection, reasoning and context settings, compaction policy, routing, budgets, and cost display. A setting shows effective value, source scope, restart/rebuild effect, and whether it is locked by policy; project content cannot widen authority.
- `REQ-UI-011` — Run status MUST distinguish verified progress, model activity, pending approval, background peer, unknown usage, estimated cost, and final outcome. Display per-run and per-task spend versus ceiling, cache classes, and selected model/agent without inventing missing cost data. Users can inspect the underlying evidence and change permitted preferences through settings.
- `REQ-PROV-006` — Local inference endpoints MUST be capability-probed per concrete server/model/template combination for tool calls, streaming, cancellation, context limits, structured output, usage, and errors. API compatibility alone MUST NOT enable a feature; unsupported behavior MUST be surfaced and routing must refuse required capabilities it cannot prove.
- `REQ-PROV-007` — Where a model route uses a text edit format instead of structured tool calls, the parser MUST be versioned and conformance-checked for that concrete model/template. Invalid edits may receive bounded diagnostic feedback, but no partial write may be presented as a complete edit; lint/test results are evidence only when their command, exit status, environment, and exact tested revision are recorded.
