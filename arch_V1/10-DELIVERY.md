# 10. Implementation sequence and acceptance gates

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

**Current status (2026-10-08):** After the initial archive refs were created, the user
directed removal of all prior Git metadata and initialized a fresh, empty `main`. The
local archive refs/object database are gone; the OpenCode files remain on disk but are
ignored and uncommitted. P0 items 1–3 and the gate below are **not satisfied**. Do not
claim a verified archive or an OpenCode-derived Git base unless those are independently
re-established with evidence or the architecture decision is explicitly revised.

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

## Phase P2 — Rust kernel transport and canonical Thread

- Implement private versioned bounded IPC, build handshake, idempotent delivery IDs,
  typed errors, owner cursors, cancellation lane and process supervision.
- Reuse/extend `horizoncode-eventlog` for the richer logical owner payloads; preserve
  its segmented committed-head physical format unless a versioned migration is
  explicitly approved. Do not build a parallel persistence engine.
- Move production Thread/input/message/Turn ownership to kernel event streams through
  `ThreadStoreService`; leave host SQL only as projection/test/import input.
- Implement the one-to-one Session alias/import contract, preserving fork links, ordered
  tool history, available attachments, compaction metadata and a read-only rollback
  snapshot.

**Gate:** crash/restart, exact retry/conflict, replay/projection rebuild, snapshot+replay,
retention resnapshot and migration round-trip tests preserve conversation semantics;
missing import data is explicit, aliases are unique/idempotent, and two writable
transcript authorities are impossible by construction. Import tests prove that
uncertain provider calls and legacy effects are never replayed or promoted to Guarded
success. Windows `run_durable` is unavailable until DEC-V1-17 has an accepted backend.

## Phase P3 — Direct coding fast path and effects

- Deliver the minimum existing profile-registry/native-Adapter slice needed for direct
  delegation here: revision-pinned `builtin.general`, runtime eligibility, native
  `DirectWorkerBindingV1` preparation, child Thread/launch receipts, limits and
  cancellation/recovery. P5 expands profile authoring/selection and P6 adds managed
  worker orchestration; those later phases are not prerequisites for this bounded
  direct branch. Use the same registry/Adapter owners, never a temporary second engine.

- Wire the selected Core V2 host runner to kernel-owned Thread state; preserve provider
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
advisory; cancellation and generation changes cannot accept partial/stale candidates.

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
