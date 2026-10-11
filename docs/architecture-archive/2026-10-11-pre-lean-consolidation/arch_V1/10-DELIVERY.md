# 10. Implementation sequence and acceptance gates


> **Authoritative integration amendment, 2026-10-10:** This chapter is read with the v2 decisions in `17-GOVERNANCE-DECISIONS.md` and source-backed integration chapters 19–26. Older designs of a competing Rust canonical Session, automatic model selection or unconstrained agents are superseded **only where explicitly contradicted**. Existing code does not become implemented by this edit.

## 2026-10-10 OpenCode-first reconciliation
### Revised delivery sequencing (must be satisfied in dependency order)
- P0: audit and safeguard current Git baseline; preserve pinned snapshot and kernel tests; stop root/nested duplicate development from drifting. No destructive cleanup.
- P1: bridge OpenCode Session / provider registry to Rust with typed messages and stable IDs; one tool broker, event outbox and failure reconciliation. Test provider parity and prompt retry/cancellation.
- P2: preserve existing Rust owner-log/transport code; land Goal/Task/Effect/Evidence domain migration as additions, not replacement of whole kernel. Verify no duplicate Session authority.
- P3: minimal single-agent flow from request -> tool effect -> diff -> independent verification -> finished report. Include P0 cheap/local models.
- P4: bounded parallel scheduler and worktree pool, independent data/port allocations, lease fencing, merge staging and crash cleanup.
- P5: L1 deterministic healing, L2 provider breaker/retry on same model, L3 advisory repair knowledge, L4 quarantined self-tuning validation.
- P6: three-column UI, Create/Develop/Delegate/Operate, visual source mapping and nondeveloper workflow.
- P7: external skills/tools/ACP/A2A/MCP, prepublish staging/deploy/export and advanced operations.
**No fake acceptance:** a package compiling, source being copied, or documentation generated does not mean a user workflow is verified. Each stage needs contract tests + failure injection + a demo recorded against real code.

---

This is the dependency-ordered implementation plan for the adopted v1 architecture,
not a TODO status ledger. Phase labels guide safe dependencies; they may be resequenced
as evidence warrants, but do not weaken the final owner contracts or acceptance gates.
Adoption does not mark any item implemented or verified and does not automatically
revise `TODO.md`; reconcile delivery rows and acceptance evidence as bounded work is
assigned. Unresolved DEC-V1 items gate only the capabilities listed in
[`17-GOVERNANCE-DECISIONS.md`](17-GOVERNANCE-DECISIONS.md).

## Phase P0 — Preserve Horizon and establish the OpenCode base

This is the **repository cutover**, not production route/Thread/effect convergence.
Complete it only after the architecture is frozen and all intended pre-cutover work is
captured in a verified clean archival revision:

1. Preserve the current HorizonCode repository at one exact commit with both branch
   `legacy-horizoncode` and tag `pre-opencode-rebase`; verify they resolve to that commit
   and the archived working tree has no uncommitted or untracked user work. Do not reset,
   overwrite or delete the old tree to create the new line.
2. Create new `main` directly from OpenCode commit
   `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`; configure the official OpenCode repository
   as an upstream remote and fetch by pinned revision. A GitHub fork is not required.
3. Carry the finalized `arch_V1/` plus a root `AGENTS.md` and README rewritten for the
   new topology. Do not copy old Horizon implementation, old `ARCH/`, `info.txt`,
   `info2.txt`, research dumps or a `legacy/` source subtree into active `main`.
    Historical material may be stored separately with no normative authority; do not
    assume it remains locally recoverable after Git metadata changes.
4. Keep the OpenCode tree substantially intact. Establish an inventory for OpenCode
   paths classified `RETAIN`, `ADAPT`, `WRAP`, `REPLACE`, `DISABLE` or `REMOVE-LATER`;
   do not preemptively delete code based on apparent product scope.
5. Before porting any old Horizon component, record a temporary migration-matrix row:
   current component/revision, final `arch_V1` owner/interface, `REUSE`/`ADAPT`/`EXTRACT`/
   `DROP`, rationale, data/behavior impact, required tests and disposition. No component
    is imported solely because it already exists.
6. Verify license/notice inventory, exact source provenance and generator ownership.
   DEC-V1-11 remains a distribution gate; it need not block unrelated local coding.

**Current status (2026-10-10):** After the initial archive refs were created, the user
directed removal of all prior Git metadata and initialized a fresh, empty `main`. The local
archive refs/object database are gone and cannot be claimed as recoverable. The pinned
OpenCode source under `opencode/` has now been verified against the exact upstream commit
and its path inventory (see [`09-SOURCE-MAP.md`](09-SOURCE-MAP.md)); this checkout still
does not have OpenCode as its Git base, and the snapshot is being added under a subdirectory
rather than replacing repository history. P0 item 1, item 2's root-base requirement, the
full path-disposition inventory, and the gate below remain **unsatisfied**. Do not claim a
verified Horizon archive or an OpenCode-derived root Git base.

The adopted synchronization policy is in §17.3: release-triggered candidate review,
expedited security review, named patch owners, pinned generators and zero unowned or
unclassified divergence. No automatic upstream merge is permitted.

**Gate:** archive branch/tag and source commit are verified and recoverable; the clean
OpenCode-derived `main` builds, tests and runs its fixture-backed direct prompt without
Horizon patches or external provider credentials; generated outputs compare clean; the
repository contains no old Horizon implementation/competing architecture tree. This
proves only the upstream baseline, not Horizon integration or production cutover.

## Phase P1 — Composition and typed service seam

- Introduce ServiceDefinition, `HzPluginRuntime`, manifest schema, deterministic
  composition resolver, capability descriptor, composition lock and graph diagnostic.
- Implement sealed system providers, explicit test replacement, generation pinning,
  disposable registrations, drain/quarantine lifecycle and trust classes.
- Register `HookContributionV1` through the existing contribution refs and pin its
  exact digest/event contracts in the composition lock; do not add a parallel hook
  registry.
- Add architecture dependency checks: no UI/plugin direct kernel-store imports; no
  provider adapter direct Effect executor; no worker PASS setter.

**Gate:** contract tests reject duplicate singleton providers, dependency cycles,
unknown required service/API version and unauthorized sealed-provider replacement;
drain waits for in-flight leases; plugin crash cannot mutate canonical state; malformed,
unsupported or failed required hooks fail closed and cannot alter Guard/Task PASS.

## Phase P2 — Rust transport and managed-control OwnerLog

- Retain and extend tested kernel codecs, MessagePack framing, peer auth, supervisor epoch, OwnerLog V2 and bounded projections.
- P1.2-B reads canonical OpenCode Session events through authenticated supervised read-only projection. NEVER migrate Session/Input/Message/Part text into a competing Rust Thread.
- Add Rust-managed Goal/Run/Task/Attempt and ToolBatchControl metadata only behind approved typed SessionLink correlation and owner/event contracts.
- P1.3 admits complete ToolBatch after Core provider finish, then Guard, durable PREPARED EffectIntent, one-use capability lease, Rust ExecutionHost, receipt/UNKNOWN and reconciliation. Every effect-capable route must mediate or be unavailable.
- Crash/restart/compaction/cancellation, native Windows and uncertain external effects remain explicit acceptance gates. No blind tool replay.
- Original Rust-owned Thread migration steps are historical, preserved in the provenance archive (§36).

**Gate:** exactly one canonical OpenCode conversation owner; replay and source cursor parity; Rust records only bounded references; no effects before Guard/PREPARED/lease; final receipt or UNKNOWN; security/side-effect restart tests and native-platform evidence required. P1.2-B observation does not pass P1.3 effect mediation.

## Phase P3 — Direct coding fast path and effects

- Deliver the minimum existing profile-registry/native-Adapter slice needed for direct
  delegation here: revision-pinned `builtin.general`, runtime eligibility, native
  `DirectWorkerBindingV1` preparation, child Thread/launch receipts, limits and
  cancellation/recovery. P5 expands profile authoring/selection and P6 adds managed
  worker orchestration; those later phases are not prerequisites for this bounded
  direct branch. Use the same registry/Adapter owners, never a temporary second engine.

- Wire the selected Core V2 host runner to Rust ToolBatchControl effect correlation while retaining OpenCode canonical Session history; preserve provider
  protocol and streaming UX without retaining a competing legacy loop.
- Converge production routes only after P2 migration/ownership and this phase's
  whole-batch/Guard gates pass; remaining legacy call sites are migration or
  compatibility-only, never a second production runner.
- Add durable steer/queue admission, ContextEpoch and deterministic context snapshots.
- Add bounded context-pressure escalation, source-set circuit breaking and structured
  pre-content `PROMPT_TOO_LONG` recovery without replaying uncertain provider attempts.
- Add exact-digest reviewed-fork provider-prefix reuse hints only; no local response cache.
- Adapt the runner to whole-response tool-batch collection/validation before execution;
  reject provider-executed tools in governed mode.
- Route filesystem, shell, process, MCP and other effect-capable tools through Guard,
  PREPARED intents, ExecutionHost, receipts and reconciliation.
- Add direct-mode pre-write checkpoints and scoped `/rewind turn|files` owner previews;
  suppress repeated automatic retries only for the exact unchanged failure/state/strategy.
- Preserve partial provider output visibly; unknown provider acceptance is not retried
  blindly.

**Gate:** ordinary prompt does not create Run overhead; no provider token requires a
kernel round-trip; malformed batch dispatches zero unstarted effects; effect cannot
start before PREPARED; provider-executed tool bypass is denied; stale fence rejects
write; crash at every effect boundary reconciles or remains UNKNOWN. Prompt-too-long
recovery uses a new request ID only after known pre-content rejection, opens its circuit
at the finite policy bound, and never resends UNKNOWN acceptance; fork-prefix digest
mismatch disables reuse; direct rewind preserves concurrent edits and external effects.
Fixtures commit `compaction/admitted` before extraction/summary work, count failed or
crashed pre-preview attempts after restart, and exhaust a finite immutable policy.
Recovery cursor/bookkeeping changes do not reset the semantic source-set circuit key;
only an eligible semantic source/policy change permits reset. Direct Thread/Turn budget
reservations and direct delegation work without fabricated Run/Task/Attempt IDs.
`turn/operations_reconciled` exits UNKNOWN only with authoritative linked settlement
receipts; an unresolved operation cannot be presented as settled or replayed.
Windows confined
operations remain unavailable until DEC-V1-01 acceptance; direct and managed mode must
not represent a bare `full-access` execution as confined.

## Phase P4 — Repository intelligence and memory

- Add `hz-indexd`, immutable base generations, workspace and unsaved-buffer overlays,
  Tree-sitter, bounded lexical search and optional LSP/SCIP/vector enrichment.
- Keep kernel control/cancellation responsive ahead of indexing; pin RepoGeneration in
  ContextEpoch and invalidate only impacted relationships.
- Add bounded, scope-filtered memory retrieval, explicit extraction-to-candidate review,
  low-priority consolidation and truth reconciliation under MemoryService ownership.

**Gate:** unchanged repository performs no unnecessary re-index; edit updates bounded
overlay; stale generation never claims current; memory cannot override user/spec/policy;
indexer crash cannot corrupt canonical state. Memory queries enforce scope/byte/token
bounds; transcript fallback stays inside authorized ranges; stale memories remain
advisory; accepted memory supersession fixtures reject non-ascending or duplicate
`supersedesMemoryIds` and accept UTF-8-bytewise sorted records without reordering decoded
values; cancellation and generation changes cannot accept partial/stale candidates.

## Phase P5 — Agent profiles and subagents

- One registry for main/default-general/specialist/custom/native/ACP/CLI profiles.
- Revision-pinned invocation bindings, deterministic selection, runtime probes,
  profile builder/editor, finite budgets and authority intersection.
- Resolve profile hook bindings against the pinned CompositionGeneration and adapter
  guarantees; retain the compact Default Subagent settings surface.
- Deliver built-in profiles and user selection before automatic matching.

**Gate:** manual-only profile never auto-launches; ambiguous automatic match asks/falls
back deterministically; profile edit cannot alter in-flight worker; child authority
cannot widen parent/Task policy; price cannot change selected model; unsupported fixed
reasoning fails visibly; required unsupported hooks prevent dispatch and a blocking hook
cannot set Task PASS.
`maxTurns` fixtures count each completed provider-response boundary exactly once:
text-only, empty completed and multiple tool calls in one response each count one;
hooks/tool calls/results are not extra turns. Partial, failed or cancelled requests
without a completed response boundary do not count; later tool failure does not erase
an already completed response, and replay cannot count it twice. A hard limit blocks
the next provider request; an opaque adapter without observable/enforceable boundaries
is ineligible, not best-effort. Restart/resume and replacement WorkerExecutionIds carry
the durable Attempt-scoped count and pinned hook set; a new Attempt resets only that
profile counter, not aggregate Task/Run limits. Typed `AGENT_LIMIT_EXCEEDED` details
identify the profile limit and remain distinct from BudgetService `BUDGET_EXCEEDED`.

## Phase P6 — Durable managed execution

- Wire the existing VerificationService admission/Evidence validation Seam required
  by dependency waves using a distinct read-only fixture verifier for lifecycle tests.
  P6 may prove RunController guards with fixture Evidence; production Task PASS and
  dependent-wave release still require the P7 verifier/acceptance gate. Do not expose
  fixture Evidence as production acceptance or temporarily trust worker self-report.

- Add Goal/SpecVersion preparation/review/activation, Task DAG, budgets, workspace
  providers, Attempt, WorkerExecution, dispatch outbox and deterministic integration.
- Start with native worker using the already-working direct Thread runtime; add external
  worker adapters only with capability/containment truth.
- Add scoped cancellation, pause/resume, checkpoint, recovery inspector and Needs You.

**Gate:** no worker starts pre-activation; crash-after-launch does not duplicate; stale
fence rejected; conflicting workspace writes serialize or isolate; cancel Task does not
cancel independent work; unresolved external effect blocks terminal completion.
Fixtures exercise guarded `run/next_wave_started` after prerequisite verification,
reject it with stale dependencies/evidence or unresolved work, and exercise
`task/execution_failed` for a known exhausted failed Attempt without a retry. Unknown
effects keep cancellation/failure pending; they cannot produce a false terminal state.
Verification-failure fixtures return a Task VERIFYING to READY only through
`task/verification_failed_retryable` with current failed Evidence, a distinct strategy,
remaining attempts/budget and settled operations. Exhausted retry fails the Task;
stale Evidence or UNKNOWN operations cannot start a retry or a new execution wave.

## Phase P7 — Independent verification and acceptance

- Implement verifier profiles unable to mutate the subject, revision-bound scenarios,
  evidence freshness, proof packs and single Task PASS/Run completion gate.
- Include negative/failure scenarios and exact environment/toolchain evidence.

**Gate:** worker completion cannot set PASS; rebase/spec/toolchain change stales affected
evidence; verifier output binds exact integrated revision set; Run completion rejects
missing current evidence, unsettled effects, blockers or mismatched spec.
Verification-permit fixtures pin the exact policy digest through admission,
consumption and evidence production; changed/mismatched policy rejects the permit
and cannot certify Task PASS.

## Phase P8 — Ecosystem and compatibility

- Add MCP/ACP/skills, connectors, LSP/formatters, isolated legacy plugin host, WASM
  extensions, workflows and package manager after core authority gates.
- Include typed timestamped MCP connection snapshots; `CONNECTED` is not tool authority
  or call success, and stale status never rebinds an in-flight tool.
- Validate plugin provenance, signing, compatibility, capability review, lifecycle,
  diagnostics and rollback.

**Gate:** all extension calls obey declared trust class; hidden external-agent tools
are not falsely reported as mediated; credentials are never ambient; plugin disable or
upgrade drains safely; unsupported hooks fail visibly.

## Phase P9 — Web/Desktop polish and updates (remote continuation separately gated)

- Finish responsive UI, notification, signed updates and optional scheduling using
  the same Thread/Run/Attempt/Workspace contracts.
- Remote attachment/continuation/workers are a separate post-local gate; DEC-V1-14
  keeps v1 local-only unless explicitly resolved and accepted.
- Do not add cloud-only identity that conflicts with local canonical IDs.

**Gate:** if automatic updates are included, signed verification and rollback pass, and
no active-binary activation or live schema mutation occurs while any unresolved effect
or worker owns mutable state. Download, staging and read-only inspection may proceed;
fenced UNKNOWN is not an activation exception. Local reconnect is snapshot+replay. Remote
reconnect/cancellation/fencing/evidence receive separate acceptance only if a later
decision adopts remote continuation; they are not a local v1 release gate.

## Cross-cutting acceptance matrix

Release gates include:

- migration and replay preserve Thread identity/history and avoid duplicate ownership;
- legacy in-flight provider/tool operations remain `UNKNOWN` and are never blindly replayed;
- direct latency and streaming stay within recorded baseline; no per-token kernel RPC;
- steer/queue semantics and fairness under load;
- provider failure before/after visible text and uncertain acceptance;
- plugin/service generation pinning, crash, drain, cycle, duplicate and revoke paths;
- whole-response batch validation and zero dispatch for malformed/incomplete batches;
- effect PREPARED/settlement, approval binding, TOCTOU, stale fence and UNKNOWN recovery;
- sandbox enforcement by OS/backend, with capability-unavailable negative tests;
- agent authority intersection, explicit model routing and no cost-based downgrade;
- dispatch outbox crash window, cancellation priority and no duplicate launch;
- integration order, conflicts and multi-repository partial state;
- independent verification, evidence staleness and PASS/Run-completion negative cases;
- UI durable replay/resnapshot, truthful ephemeral gap, no background focus steal;
- settings migration maps `immediate` → `immediate`, `next_turn` →
  `next_provider_turn`, `default` → `defaults`, `global` → `user`, and `project` →
  `project` without losing source bytes/provenance; typed descriptors and requested/
  effective references preserve pending apply state, rejected requests and Run locks;
- MCP/external-agent/legacy-plugin credential, egress and mediation-coverage disclosures;
- disk pressure emergency reserve, audit integrity, privacy/retention and secret-output scans.
- Windows `run_durable` and sandbox enforcement each have independent implementation
  and acceptance gates; one cannot stand in for the other.

Every reported `verified` or `accepted` status must name exact source revision/build,
specification version, platform/backend, test command, fixtures and result. A design
document, source presence or unit-only mock cannot satisfy an acceptance gate.

## Pinned base reference

- [OpenCode at the selected base revision](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322)

## 2026-10-10 — P1.1 implemented: read-only OpenCode Session event projection

**Status:** IMPLEMENTED AND FOCUSED-TESTED, but NOT connected to the running OpenCode host. No production permission/tool boundary is claimed.

- Rust: `kernel/src/session_projection.rs` (`SessionProjection`, `cursor`, `sync`, `link_attempt`, `correlation`). Reads the actual OpenCode V2 `event` table (`id,aggregate_id,seq,type,data`) and stores **only** immutable correlation metadata (session/message/tool IDs, source-event type and hash, contiguous cursor) in its own database; it never edits upstream Session/Message/Part or calls a model.
- The existing OpenCode `packages/core/src/event.ts` uses `latest = -1` before the first committed event, then `seq = latest + 1`. This underpins the projection's strict 0-based sequence and gap checks.
- `kernel/src/bin/session_sync_probe.rs` exposes a manual read-only source DB diagnostic. Actual host connection, lifecycle watcher, safe transport and scheduler integration **remain unimplemented**.
- `kernel/tests/session_projection.rs`: 9 cases include admitted/promoted correlation, deterministic replay, source drift, gaps, malformed content, multi-session separation, link conflicts, process-reopen recovery, and bounds.
- After adding the module, `cargo test --manifest-path kernel/Cargo.toml --locked --offline --quiet` passed 115 tests (70 + 11 + 25 + 9). Formatting checked with `cargo fmt --manifest-path kernel/Cargo.toml --check`.
- Manual executable fixture: built a synthetic SQLite `event` table matching `packages/core/src/event/sql.ts`; CLI first pass imported three events through cursor 2; second pass imported zero; source SHA-256 unchanged; sensitive prompt text absent from projection receipt fields.

### Next implementation gate P1.2
1. Integrate a mediated OpenCode host Session stream/reader with authenticated Rust supervisor RPC. Reconcile source events after process restart without writing OpenCode conversational state.
2. Test actual OpenCode Session admission (not only a synthetic SQLite table), `PromptAdmitted` → `Prompted`, event payload versions, exact ID preservation, and compaction replay.
3. Integrate Rust ToolBroker authorization and effects; this read-only projection does not enforce permissions or route tool effects.
4. Add source DB WAL/concurrent-write integration tests, projection file permission checks, and careful storage retention/compaction for high-volume sessions.
5. Provide a launch-time bridge health status; do not mark P1 complete until end-to-end tool/sandbox/security and restart checks pass.

## 2026-10-10 — P1.2-A: live read-only OpenCode Session follower (implemented)

**Status:** Live-read follower and integration tests implemented; authenticated supervisor and mediated tool effects still pending. Do not mark the entire P1.2 milestone complete.

### Source code
- `kernel/src/session_projection.rs` now pins an SQLite read transaction across the last-committed boundary verification and the next event batch, preventing cross-snapshot race during OpenCode WAL updates.
- `kernel/src/bin/session_sync_probe.rs` supports live `--follow`, polling `--poll-ms=50..60000`, bounded `--max-polls=N`. Source is opened `SQLITE_OPEN_READ_ONLY` with `query_only=ON`; source/destination path aliases and Unix hardlinks are rejected. Each imported batch has a durable cursor and idempotent metadata receipts.
- `packages/core/test/kernel-projection-live.test.ts` publishes actual `SessionEvent.ContextUpdated` via OpenCode's `EventV2.Service` and `Database.layerFromPath` to an isolated disposable SQLite database. Rust follows committed WAL events, preserves message IDs, and observes subsequent events while the publisher is live. A restart imports 0 duplicates; prompt content remains in OpenCode and is absent from Rust metadata.
- `.gitignore` explicitly allows tracking the integration test; no old OpenCode provider, session-runner or renderer logic was rewritten.

### Local reproducible checks
Run in the WSL repository:
```bash
cargo fmt --manifest-path kernel/Cargo.toml --check
cargo test --manifest-path kernel/Cargo.toml --locked --offline
cargo build --manifest-path kernel/Cargo.toml --locked --offline --bin session_sync_probe
cd packages/core
/home/sarvesh/.bun/bin/bun test ./test/kernel-projection-live.test.ts
/home/sarvesh/.bun/bin/bun run typecheck
```
The `bun` absolute path reflects the current WSL machine; production instructions should use the configured package manager path.

For an explicitly selected **non-production or authorized** OpenCode SQLite database and Session ID:
```bash
cargo run --manifest-path kernel/Cargo.toml --bin session_sync_probe --   /path/to/disposable/opencode.db /path/to/disposable/kernel-projection.db ses_test   --follow --poll-ms=250
```
Use Ctrl+C to stop the diagnostic. An idle live watcher is **not** yet launched/managed automatically by the application supervisor. The follower does not replace the OpenCode Session DB, run models or execute any tools.

### Evidence and limits
- Rust kernel: 70 unit + 11 owner-log golden + 25 owner-log recovery + 9 projection tests = **115 passed**.
- OpenCode/Bun: 2 integration tests passed, 18 assertions. Tests include actual OpenCode EventV2 publisher, WAL visibility, session replay and hardlink/same-file rejection.
- Core package: `bun run typecheck` passed. No model/provider API calls or user-owned database migrations executed.
- Still required: production supervisor startup/shutdown, authenticated Rust IPC stream, event cursor delivery to UI, actual OpenCode prompt admission with `PromptAdmitted` and `Prompted` integration, compaction recovery, persistence root hardening, complete mediated ToolIntent flow and Guard enforcement. The read-only follower does not prove any of these yet.

### Next gate P1.2-B
1. Define a strongly authenticated local supervisor identity and event subscription contract (incremental cursor, backpressure, version negotiation), keeping OpenCode the only conversation owner.
2. Connect the Rust follower to automatic per-session lifecycle with an explicit stop/cancel path; secure state path, process ownership and logs without exposing raw prompt content.
3. Confirm actual prompt-admission/turn-result semantics across both existing OpenCode session generations with a disposable fixture and versioned event-manifest assertions.
4. Before any effectful ToolIntent proxy is released, implement and verify OS-enforced permission coverage for shell, edit, MCP and hosted provider tools. **No partial broker that leaves bypasses as enabled production functionality.**

## Current coding-agent implementation handoff — 2026-10-10

**Implementation increment status:** P1.1 Rust read-only projection verified; P1.2-A live WAL follower + real OpenCode EventV2 publisher verified in disposable test. **P1.2-B remains open:** actual OpenCode `PromptAdmitted`/`Prompted` parity under the running Session service, authenticated local supervisor and event subscription/ack/replay/cancellation. Then P1.3 complete mediated ToolIntent enforcement. This increment nomenclature does **not** supersede the historical P0–P9 phase acceptance table above. Detailed next commands and owner files are in repository-root `HANDOFF.md`, and the coverage/contradictions ledger is in [27](27-IMPLEMENTATION-READINESS-AUDIT.md).

Use the `AGENTS.md` autonomous verified-slice loop: do not stop after one passing test; do not cross safety/budget/user-decision boundaries; continue to the next unblocked dependency and update the tracked handoff. Historical Rust-canonical Thread wording is superseded by adopted v2 ownership, but the existing Rust OwnerLog is retained.

## 2026-10-11 cross-cutting V1 capability gates

These gates are mandatory additions to the dependency plan above. They do not renumber the
historical phases; implement them when their dependencies become available.

### V1-CONTEXT — Context engineering + repository intelligence + local/small models

Implement §30 after the OpenCode Session/provider seam is stable enough to measure:

- ContextLedger/token pressure with distinct trim/prune/compact/clear;
- protected Goal/decision/current-turn facts;
- progressive tool/skill/context disclosure;
- parser/BM25 symbol index + LSP on demand; optional embeddings only;
- explicit Ollama, LM Studio, LiteLLM and OpenAI-compatible endpoints;
- explicit `HarnessProfileV1` registry independent from provider/model selection;
- `native-rich`, `native-minimal`, `bash-only` and versioned compatibility harness paths;
- measure prompt/tool/context overhead per harness independently from model/task quality;
- offline/no-cloud-fallback tests;
- 4K/8K small-context and 50K-file repository fixtures.

**Gate:** the model-visible prompt/tool surface is measured for at least one small-context
local model and one normal hosted/compatible model; symbol/index and context operations pass
§32 cases without leaking denied paths or silently changing models. Harness-switch fixtures must
prove the endpoint/provider/model remain exactly pinned and incompatible harnesses fail visibly.

### V1-AGENTS — Specialist/custom agents + skills/hooks/MCP

Implement §29 over the one AgentProfile registry:

- rich profile revisions, variants, path/tool/skill/MCP/subagent policies;
- small built-in specialist set;
- maintenance jobs that avoid unnecessary child sessions/worktrees;
- typed subagent requests/replies and parent→child authority intersection;
- progressive SkillManifestV2 resources with stable namespaced IDs and anti-shadowing rules;
- Horizon-owned built-ins registered from bundled/embedded product assets rather than requiring `.opencode/`;
- hook runtime events and trusted-project rules;
- MCP server profile/auth/tool-generation contract;
- Horizon Docs built-in skill from canonical `packages/core/src/horizon/skills/horizon-docs/SKILL.md`; remove the development `.opencode` shim dependency once embedded registration passes.

**Gate:** §32 SA/EX/PS tests pass and no profile/skill/hook/MCP route widens Guard authority.

### V1-EXPERIENCE — Fast UI, artifacts, Mission Control, analytics and automation

Implement §31 incrementally using the retained OpenCode app/TUI/desktop surfaces:

- smooth coalesced streaming, stable scroll anchors, history virtualization/pagination;
- parked thread view state and bounded queues/resnapshot;
- CodeMirror 6 embedded editor/diff unless a measured ADR chooses otherwise;
- first-class artifact cards/downloads and isolated Mermaid rendering;
- dockable Explorer/Work/Inspect plus terminal/Git/tests/browser/context/analytics;
- Mission Control for thread/run/worker/resource state;
- measured/estimated/unknown usage analytics;
- automation scheduler/run log;
- built-in browser/DOM normalization plus optional adapters.

**Gate:** correctness tests plus §31 performance targets are measured on named hardware/builds.
No target becomes a release claim merely because the UI looks smooth in development.

### V1-EVAL — Real-work harness acceptance

§32 is the single model-independent end-to-end catalog. Release evaluation records both:
1. harness/system correctness; and
2. task success for the selected model.

Mandatory release subsets include code change, scope/architecture, Git safety, long horizon,
context, local model, agents/extensions, sandbox, browser, UI streaming, analytics,
automation, recovery and system-execution cases. Performance suites run separately.

### V1-COMPAT — Language tooling, weak/local protocol safety and recovery lineage

This is a cross-cutting hardening gate, not a new competing phase order. Implement after the
relevant control-plane seams exist and before V1 release acceptance:

1. `LanguageServiceBroker` and truthful RepoIntel source/generation metadata; reuse compatible
   editor-owned Pyright/rust-analyzer/tsserver/etc. without taking process ownership.
2. Plan/read-only effect enforcement through shell/scripts/LSP/MCP aliases.
3. strict malformed/truncated structured-call handling and tested compatibility-stream
   assembly for supported OpenAI-compatible/LiteLLM-style adapters.
4. separate local endpoint connect/health, model cold-load/response-start and TTFT timing.
5. checkpoint restore lineage checks after later commits/branch/dirty/untracked human work.
6. `PlanHandoffV1` with structured dependencies/scope/criteria across Plan→Build.
7. terminal/artifact search so large output is retrieved by bounded ranges rather than prompt
   flooding.
8. managed Goal/Task block/fail behavior after fatal or exhausted retry policy.
9. §31.18 critical-path latency benchmarks and §31.19 renderer isolation/performance tests.

**Gate:** corresponding §32 LS/LM/CX/TM/PL/CP/AG/LH/PF/RO cases pass on the exact release
build/platforms. This work does not preempt the current P1.2/P1.3 effect/supervisor safety
dependency; implement in dependency order.

### Post-V1 experimental learning lane

Deep analytics and reviewed/advisory repair memory are V1. Autonomous failure clustering,
prompt/profile/config candidate generation and canary selection are **post-V1 experimental**
and remain non-authoritative. They may never self-modify Guard policy, silently change the
provider/model, self-install extensions or promote a candidate without the separately
approved experiment policy. This lane is independent from the mandatory P10 identity migration.

## Post-V1 final milestone — HorizonCode complete identity migration (DEFERRED, MANDATORY)

**Scheduling trigger:** Start **only after V1's functional, security, platform, verification and acceptance gates are signed off**. This milestone is not an excuse to defer important V1 runtime work and is not to run concurrently with the core V1 implementation. It is a required, separately planned **post-V1 migration before public HorizonCode-branded distribution**.

**Scope:** Inventory and migrate every **product-owned** OpenCode identity across npm workspace package names/scopes/imports and dependency graph, CLI binaries/help, configuration keys, env names and local state, telemetry and protocol names, app/UI copy, titles, assets, menus, About, desktop IDs and URL schemes, installer/manifest/update identifiers, website/docs, CI/release scripts and hosted endpoints. Regenerate generated SDKs/lockfiles via their generators. Preserve required upstream copyright, license and attribution records, including legitimately embedded OpenCode references in provenance.

**Migration strategy:** One bounded coordinated project with dependency-ordered and testable stages, not blind global search/replace. Define upgrade of existing installations and data/config compatibility or an explicit clean-break policy before changing paths. Audit build artifacts and launched applications, not just text. Validate CLI, desktop, web, TUI, all packages, persistence, deep links, installation coexistence, signed updates, clean/reused environments, security and end-user branding.

**V1 guard:** Until the V1 acceptance trigger, **do not** rename existing `@opencode-ai/*` workspaces, `opencode` executable, provider/session imports, schemas, state directories or integration namespaces for branding alone. **Do not begin P10 early** because OpenCode names appear in build logs or source. Historical upstream names in citations/required notices remain lawful attribution. Product identity must be HorizonCode at public release.

**Ownership:** Track here as deferred P10; copy the deferment into tracked `HANDOFF.md` and agent instructions. This is a gate AFTER, not a replacement for, P0–P9.

## Contract convergence gates C0–C7 (2026-10-11)

C0: operative HLD/LLD authority diagrams fixed (§§01–04,13,20), old excerpts archived.
C1: service paths mapped to verified existing vs proposed/not-wired (§20.10.2 and §37).
C2: alias/catalog seed created, canonical guard-equivalent resolution specified (§37.2 and contracts-v2/capability-registry-v1.json); UNKNOWN effect classes cannot execute.
C3: browser/LSP/delegation/automation/UI replay/Mermaid/cache interfaces + error behavior specified (§37).
C4: machine-readable JSON Schemas and offline fixtures added; actual generated TS/Rust integration and cross-language runtime tests remain OPEN.
C5: latency/renderer/cache acceptance enumerated in §§31–32; actual platform measurements OPEN.
C6: scripts/architecture/validate_convergence.py must pass; independent runtime security, P1.2/P1.3 and real-work tests remain OPEN.
C7: docs/status are synchronized; no P10 rename, no automatic deployment, and no interruption of independent P1.2 work.

Do not mark C3/C4 as runtime implemented merely because a document or schema parses. Final V1 gates require source-linked TS/Rust validation and P1.3 full Guard/ExecutionHost enforcement.

## 2026-10-11 converged executable implementation plan and source gates

**OPERATIVE CODING PLAN:** [converged implementation plan](../docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md). User-directed UI/visual targets are adopted at the product-behavior level by A-V2-22/23, but proposed interfaces remain design candidates until tested; no OMP code is implemented by documentation. The agent must follow this strict dependency order: P1.2-B supervisor → P1.3 universal effect Guard/ExecutionHost → additive P2 managed Goal/Run (NEVER Rust canonical conversation) → shared TS/Rust contract generation and tests → native edit/index/LSP/DAP → browser/desktop/web search → unified provider/model/role/settings/slash UI → sandboxed SVG/Mermaid/chart/terminal graphics/artifacts → real long-horizon UAT. Exact pinned source files/algorithms are in [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md)/[source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md). No automatic paid provider, silent reroute or code-copy without license. The older docs/superpowers/plans/2026-10-10-horizon-p2-thread-cutover.md is historical and superseded by the above successor.
