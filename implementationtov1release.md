# HorizonCode V1 implementation and release tracker

## 2026-10-24 — post-compaction owner wave continuation

All whole-phase owners returned PARTIAL and were resumed. Newest phase-report continuations are the
evidence authority; no phase is VERIFIED and no effect gate opened.

- **P1:** existing effects-host 10/10, cross-capability unit 1/1, Core denials 13/0 retained. P2
  released Cargo; P1 now holds the sole slot for the queued `effects_host_process` PreparedBatch
  rerun and scoped P1-vs-P2 failure triage. Both terminal readiness flags remain false.
- **P2:** P1-10 `prepare_tool_batch_read` focused 2/2; managed-control **41/0 (225 expectations)**.
  Report continuation 28 now specifies the HostRun binding/projection split and the exact Core read
  DTO, but it is prose only: no compiled HostRun DTO, binding persistence, reconcile route, or real
  authenticated positive fixture exists.
- **P3/P4:** no further independently safe production gap was proven; authenticated HostKernel
  query/cursor/recovery, trusted document buffer, Guarded patch, P8 quotas and DAP namespace/ptrace
  still gate real acceptance. Navigation and language-tool effects stay closed.
- **P5:** search/CodeMode group **116/0 (362 expectations)**; focused catalog/lane cases **2/0**.
  P7's Core CodeMode callback remains fail-closed; helper build/install and CM-001..012 unrun.
- **P6:** current-wave offline Core **27/0** and OpenCode **28/0**; settings capability-chip consumer
  absent (P5/P7); credentialed SecretBroker/Doctor and provider E2E remain gated.
- **P7:** cold AppRuntime `InstanceRef not provided` remains unexplained RED; no production
  workaround. Parent review confirmed the P1-10 caller requires threading a typed read-admission
  through the shared `ExecuteInput`/`Materialization.settle` boundary into the read leaf, not merely
  decorating results; P7 must get parent sign-off before that shared-contract edit.
- **P8:** RC0 attestation now requires exact per-Session PID/start-time generation and a configured
  trusted source; **93/93 RC0**, **40/40 evaluator**, Python compile green. Production trusted-source
  allowlist is empty; signature verification, JC-RES-012.K/L and real workloads remain open.
- **P9:** SDK-next export fixed test-first (**1/2 expectations**); client typecheck/build green. Full
  SDK boundary is **4/1** because the installed workspace link is stale; offline install remains
  blocked by uncached `@noble/hashes@2.2.0`. Release readiness **79/79**, runtime identity **2/57**.

Git remains untouched (mixed tree, 17 commits ahead of `origin/main`, no staged paths). V1 remains
**PARTIAL / NOT VERIFIED / NOT RELEASED**.

## 2026-10-24 — parent continuation (activity progress, selector projection, read-batch context)

Implemented and focused-tested three bounded gaps: §31.22 activity-card fidelity plus redacted
`Reasoning · 1.2s` rendering (TUI **9/0, 73 expectations**; TUI typecheck **0**), Task selector
projection that advertises only immutable `AgentProfileV2` selectors and explains when none are
configured (new test **2/0**; registry **13/0**), and the `effects.v2/prepare_tool_batch_read`
private `repo_read` allowlist in Core `supervisor.ts` (new test **3/0**; Core typecheck **0**).
A P3 RepoIntel decimal-coverage conversion closed the remaining Core type diagnostics (focused
**2/0**). Effect gates are unchanged: direct child turns/effects, follow-up/resume, managed Task
dispatch, and background-by-default remain unavailable. P7 AppRuntime, P2 HostRun reconciliation,
P8 trusted measurements, the P7 TypeScript read caller, provider E2E, candidate/legal/signing,
and final integrated acceptance remain open. V1 is **PARTIAL / NOT VERIFIED / NOT RELEASED**.

## 2026-10-23 — current continuation (provider source + product artifact naming)

Provider-source decision and startup refresh are recorded in `arch_V1/17`, `20`, `42`, and P6's
acceptance row in `32`; code is present in `packages/core/src/plugin/models-dev.ts` with plugin tests
3/3 and Models.dev tests 3/3. The parent P9 continuation aligned public package bins, the build
artifact, release candidate discovery/audit, Nix and Linux container entrypoint to `horizoncode` while
preserving the private OpenCode-derived workspace identity and one compatibility `opencode` command.
The compiled product user-agent now names HorizonCode. The release readiness suite passes 78/78;
Markdown audit 0 blockers and convergence 1300/0. Exact-candidate build/install,
Nix evaluation, integrated full typecheck/Cargo, all P1–P8 acceptance and free-model E2E remain open.
P1/P2/P7 are the current whole-phase agents; P6 returned PHASE_PARTIAL and is queued for resume;
P9 source work is parent-owned in this continuation. The startup refresh now passes `force:true`;
the strengthened plugin+catalog test run passes 6/6 with 33 expectations, including failed-refresh
last-good cache preservation.
This is only the product executable/artifact-name stage of the user-directed HorizonCode rename;
the broader Horizon-owned package metadata, imports, generated/build/typecheck identity and first-party
non-legal product prose migration remains unfinished and must be tracked as a separate staged pass
after P7 releases its package/typecheck input and P6's remaining provider files are resumed/closed. The private `opencode` package
ID and `@opencode-ai/*` imports are not yet renamed in this stage. Source-only release audit remains
BLOCKED and observes a stale old ignored dist artifact; release gate has 19 blockers, and prepare-build
dry-run is DRY_RUN_ONLY. Overlay has 75 hidden new test/scratch files (0 hidden_changed, 0 stale
unignore), preserved pending P6/P7 ownership.
Read-only identity dependency map: `packages/opencode/package.json` remains a private `opencode`
workspace package and `packages/web/package.json` has `opencode: workspace:*` in `bun.lock`; the
workspace also contains many `@opencode-ai/*` package scopes. Classify genuine upstream API/tarball
IDs (notably the vendored `@opencode-ai/client`) and vendor auth packages before staged scope/import
renames. No manifest or lockfile edit is safe until P6/P7 release their active typecheck inputs;
then assign one exclusive identity-migration owner for the coupled package/web/lockfile/import change.
V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## Design audit — 2026-10-22 (implementation hold; docs-only pass)

| Item | Status |
|---|---|
| Structural convergence | `validate_convergence.py` — **0 failures** (72 schemas, 230 capability IDs) |
| Markdown corpus | `audit_markdown_repo.py` — **ACTIVE_BLOCKERS 0** (285 tracked files) |
| Design ready for code-only work? | **Yes** — normative owners `arch_V1/01–18,20–21,29–33,37,42` + contracts-v2 |
| Product VERIFIED / RELEASED? | **No** — see ledger below; most capabilities `designed` not WIRED |

**Implement from (in order):**

1. [`arch_V1/46-V1-DESIGN-AUDIT.md`](arch_V1/46-V1-DESIGN-AUDIT.md) — structural audit sign-off  
2. [`arch_V1/46-V1-SOURCE-ALIGNMENT-AUDIT.md`](arch_V1/46-V1-SOURCE-ALIGNMENT-AUDIT.md) — docs ↔ code ↔ repo_take ↔ external refs; REUSE/ADAPT/disparities  
3. [`arch_V1/46-V1-MIGRATION-PARITY.md`](arch_V1/46-V1-MIGRATION-PARITY.md) — competitor parity (`DEC-V1-36`); direct chat must not regress vs OpenCode/Cursor/Claude/Codex  
4. [`arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md`](arch_V1/46-V1-IMPLEMENTATION-BACKLOG.md) — P0–P9 rows with **arch_V1 § refs**, schemas, code seams, §32 test IDs  
5. [`arch_V1/46-V1-FEATURE-INVENTORY.md`](arch_V1/46-V1-FEATURE-INVENTORY.md) — agents, skills, tools, slash commands  
6. [`arch_V1/46-V1-VERIFICATION-RUNBOOK.md`](arch_V1/46-V1-VERIFICATION-RUNBOOK.md) — run after implementation; edge cases (`CX-014`–`021`, `PERF-DIRECT-*`, Guard negatives)  
7. [`arch_V1/README.md`](arch_V1/README.md) — topic owner per task  
8. [`HANDOFF.md`](HANDOFF.md) — live code status (may lag; prefer source + tests)

**Codebase snapshot (2026-10-22):** mixed unstaged tree; **4/230** capabilities `code_present`; normative **`DEC-V1-36`–`38`**, §10.19, §30.27–30.30, §33.32–33, `builtin.horizoncode` skill asset — **design complete, implementation open** (P1-10/11, P3-10/11, P6-06/07, P7-09); acceptance §32.49–52.

**Stale tracker text:** ignore HANDOFF lines that still say “command-profile shape pending” — resolved to **`terminal.run` workspace profile mode** (`37.27`, `implementationtov1release` § command-profile).

---

## Latest implementation-only ledger — 2026-10-22

| Phase | Active source state | Remaining implementation |
|---|---|---|
| P1 Guard/ExecutionHost | Active. Trusted profile projection and shell-mode digest are source-wired; durable cgroup cleanup reaps only proven isolated/quiescent identities. | Finish fixed-argv workspace-profile execution through EffectHost/Guard/one-use lease/receipt/recovery and exact grant path; close enabled origins. Keep gates closed until acceptance. |
| P2 managed lifecycle/HostKernel | Active whole-phase owner, refilled after P8's source handoff. | Authenticated independent per-Task verifier, bounded distinct-Location DAG and aggregate settlement, CodeMode lifecycle/wave/cancel receipts, root artifact inspect/range and recovery/conflicts. |
| P3 RepoIntel | Open/partial. | Complete bounded authenticated discovery/manifest and producer/cache lifecycle; integrate after P1/P2 authority. |
| P4 LSP/DAP/REPL/editor | Partial. | Finish supervised lifecycle and `/editor` UX/launch/settings integration; keep unavailable paths gated pending Guard/RepoIntel/OS acceptance. |
| P5 web search/CodeMode | Partial. | Finish approved provider cascade, per-route outcomes/retry, CodeMode helper packaging and authorized-wave integration with P1/P2/P7. |
| P6 providers/settings/Doctor/S1 | Partial source handoff. | Refill to close selected provider/Auth/SecretBroker transport, catalog and settings journeys; no hidden paid fallback. |
| P7 streams/context/artifacts/analytics/automation/rewind | Active. | Finish P2 root artifact inspect/range and correlated cancel adapters plus remaining redaction/replay/context/automation/checkpoint journeys. |
| P8 worktrees/resources/evaluation | Source-complete for currently unblocked work; NOT phase-accepted. | P1/P2 authenticated HostRun, independent verifier, actual revision/receipt and RC0 evidence integration; P6 trusted policy projection and authenticated ingress. Keep unsupported OS quotas and pressure consumers unavailable until enforcement/pins exist. |
| P9 distribution/release | Open/partial. | Complete helper provenance/packaging, install/upgrade/signing/rollback and release assembly after P1–P8 source closure. |
| Final integrated V1 | Not started. | After implementation: run full checks, adversarial/recovery matrix, real free-model coding journey, benchmark/evidence and release gates; then stage/commit/push only exact verified task-owned changes. |

No tests, builds, typechecks, audits, provider calls, benchmarks, or release checks have run under the implementation-first hold. Git is mixed, unstaged and contains user work. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Latest phase/evidence ledger — 2026-10-22

| Phase | Owner/status | Remaining implementation before verification |
|---|---|---|
| P1 Guard/ExecutionHost | Active; source incomplete | Complete trusted grants, command-profile execution, process/cgroup recovery and safe cgroup cleanup; finish enabled-origin mediation/disablement and ToolBatch receipts/recovery. |
| P2 Managed lifecycle | Partial source handoff; needs refill | Finish authenticated lifecycle, multi-Task scheduler on distinct Locations, task-scoped verifier evidence, aggregate Run settlement, CodeMode/editor/artifact routes, pause/cancel/restart/conflict recovery. |
| P3 RepoIntel | Open/partial | Finish integrated bounded discovery and expose readiness only after P1/P2 dependencies. |
| P4 LSP/DAP/REPL + command-only Explorer/editor | Partial | Finish Guarded supervised flows and editor launch interaction; preserve `/editor` opt-in UI. |
| P5 Search/CodeMode | Partial | Reconcile existing cascade and CodeMode source with live P1/P2/P7 adapters; keep gated until acceptance. |
| P6 Providers/settings/Doctor/S1 | Partial source handoff | P7 must project the trusted selected route, commit provider settlement with EventV2, and recover UNKNOWN. P1 must supply protected credential write/send authority. |
| P7 Streams/context/artifacts/analytics/automation/rewind | Active | Own provider caller handoff/recovery, CodeMode nested waves through ordinary ToolBatch, complete remaining P7 journeys/source. |
| P8 Worktrees/resources | Open/partial | Complete durable per-Task worktree/resource lifecycle and enable safe distinct-Location scheduling. |
| P9 Packaging/release | Open | Finish owner-only helper/package provenance and release assembly after P1–P8 source completion. |
| Final integration | Not started | User requested no tests yet. After implementation: full checks, real-provider free-model coding run, adversarial/recovery matrix, docs/status reconciliation, exact-owned-file Git add/commit/push only if cleanly separable. |

P2 ruling: retain Run-level final-revision verification for aggregate settlement, and add authenticated per-Task verifier intents/evidence because §11/DEC-V1-31 already requires each Task to finish with independent exact-revision evidence. P1 comparison: local Codex/OpenCode use process-group/request-scope cleanup, not a durable cgroup janitor; implement exact identity + persisted quiescence + exclusive-lock cleanup, retaining/quarantining when proof is missing. These are source decisions, not acceptance evidence.

Current active slots: P1, P7, P8. P2 and P6 handed off partial source and must be refilled when slots open. No tests/builds/typechecks/audits/provider calls/benchmarks/release gates have run. Disk check: 842 GB free, `kernel/target` 627 MB. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED; same-day completion is not yet supportable as a promise.

**P1 cgroup cleanup refinement:** same-UID children may be able to reach the delegated cgroup hierarchy, so an exclusive flock by itself is insufficient proof for deletion. P1 is checking every launch profile; janitor cleanup is permitted only when child access/write is prevented and persisted quiescence, exact device/inode/path, owner and namespace lock checks pass. Otherwise retain/quarantine and fail closed. Local Codex/OpenCode patterns provide process-group/request-scope cleanup only, not crash-safe identity.

P2/P7 CodeMode admission is being tightened: exact helper wave binding happens inside the ordinary HostKernel ToolBatch admission path before any prepared leases are exposed. A post-prepare bind is disallowed. HostKernel derives exact receipt rows from durable terminal state; supplied IDs only correlate. P1 added source rejecting sandbox roots overlapping `/sys/fs/cgroup` and is adding persisted host-derived cgroup-owner/isolation facts; any unclear legacy identity remains retain-only.

Command-profile shape is resolved from the owning catalog/LLD: use the existing `terminal.run` capability with a strict profile-mode variant plus a separate shell-mode variant; trusted Core Config/HostKernel resolve exact profile/action pins and construct fixed argv. Do not add `workspace.command`, duplicate capability IDs, or represent profile execution as shell text. Older pending-choice notes are superseded.

The shell variant preserves existing command/cwd/timeout fields plus trusted shell-profile/environment resolution; the workspace-profile variant contains action, exact profile revision/digest and bounded configured arguments only. CodeMode nested calls pass through Core `SessionTools.resolve`; P2's HostKernel admission accepts the exact normalized calls alongside the retained helper frame, verifies their match, and persists wave binding before any lease projection.

CodeMode receipt kinds are settled: Rust derives `effect_receipt` only from the exact settled EffectHost receipt, `host_decision` for durable pre-dispatch denial/cancellation, and `tool_result` for Core-reported terminal read/control callback output, bound to the admitted call and bounded redacted output digest/byte count. `tool_result` is not effect authorization or independent verification evidence. Mixed waves are valid; UNKNOWN has no receipt and blocks continuation. P1 owns retained call identity projection; P2 owns Rust persistence/API/strict contract; P7 owns the TS result protocol and Core adapter. Keep runtime gated until integrated.

For `terminal.run` workspace profiles, Core privately projects the selected immutable Config definition and exact grant reference/action to HostKernel. HostKernel recomputes the profile digest, matches grant scope, and revalidates executable/workspace/policy/backend guarantees immediately before fixed-argv spawn. §37.27 requires exact immutable profile revisions, not a global Config revision counter. P1 owns this seam; definitions never come from model arguments.

Direct V2 shell is still missing: `packages/core/src/tool/bash.ts` is fail-closed and `session/runner/llm.ts` currently admits only the `files.write` lease shape. P7 owns that runner caller; P1 owns the terminal.run Guard/HostKernel/EffectHost/ExecutionHost API. Legacy ShellTool→Pty does not count as V2 integration. Keep shell unavailable until dispatch, receipts and restart/cancel recovery are wired.

CodeMode aggregate digest conflict is resolved with separate v2 wave and run domains over ordered canonical tuples `[waveIndex,callIndex,callId,status,receiptKind,receiptRef,receiptDigest]`; UNKNOWN has no aggregate digest. The private EffectHost settlement digest remains distinct. P2 must update §§12.21/37.24 and strict schema/fixtures; P1 aligns the private helper without exposing it.

Deterministic pre-dispatch denial/cancellation uses HostKernel→EffectHost durable `host_decision` receipts; Core invokes no callbacks and does not submit callback settlement. Possible-dispatch ambiguity remains UNKNOWN.

## Live owner and integration checkpoint — 2026-10-22

Latest source checkpoint: P1 found validated/pinned `commandProfiles` have no
EffectHost consumer and owns wiring bounded workspace preauthorization into the
single Guard path. P1 has added the original effect-bound workspace revision
to terminal artifact receipts, using only consumed preflight provenance joined
to challenge/effect and owner epoch; P2 is consuming it in the root artifact
projection. P2 owns authenticated HostKernel session/profile
selection, journal replay/epoch fixes, and the read-only root artifact projection.
The command-profile request shape needs a user ruling: extend canonical
`terminal.run` with trusted action/profile refs (recommended), or introduce
`workspace.command`; dependent wiring is paused. P6 reuses Auth's existing
pinned direct fetch/journal boundary; Auth alone resolves/injects credentials.
P7 remains queued until a child slot frees. No tests/builds/typechecks/audits/provider probes/benchmarks/release checks
have run. Same-day completion cannot be promised with six phases plus final
integration and verification still open. V1 remains PARTIAL / NOT VERIFIED /
NOT RELEASED.

P6 direct-provider source now routes the frozen Catalog selection and
SessionStore journal callback through an internal LLM service to Auth's
existing protected one-shot fetch; Core has no credentials or secret refs.
New LLM route files were initially ignored by the blanket `*` rule; exact
first-party exceptions are still required before release integration. No
credentialed provider route is enabled.

Managed DAG status correction: root readiness at Run start and dependency
readiness from independent PASS are source-present. The Rust scheduler still
allows only one active Attempt per Run because it assumes a shared mutable
workspace. DEC-V1-31 requires bounded multi-Task execution and aggregate
settlement after the single-Task vertical; P2 is reconciling this with P8's
registered distinct-worktree leases. P8 has per-candidate durable reservation/
resolution and HostKernel child-Location projection; no sibling batch scheduler
exists. P2 must compose distinct leases for ready sibling Tasks and add
multi-active reducer admission, per-Task verification and aggregate settlement.
This is unfinished V1 work, not a post-V1 deferral.

P2 has source-wired root DirectSession artifact listing through the existing
HostKernel batch index, EffectHost terminal receipt journal, and ArtifactStore;
the Core `listDirectSessionArtifacts` projection rejects malformed/duplicate
effect and owner metadata. This remains unverified and is not full artifact
search/UI integration.

Active whole-phase implementation owners (confirmed after the previous three agents exhausted their platform usage): P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, and P6 providers/settings/Doctor/S1. P7 streaming/context/artifacts/analytics/automation/rewind is next to resume as a child slot becomes available. P3/P4/P5/P8/P9 remain open or partial; P0 integrated verification/release has not started. Root rechecked local OpenCode/Codex lifecycle implementation and added the source-specific findings to `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` §42.19. Direct route authority is the selected Core catalog projection and must exactly match the protected transport; P7 must not use `model.route.id`. Root direct artifact retrieval depends on P2's immutable authenticated batch admission index joining only to P1's terminal receipt journal and existing ArtifactStore. The related design is recorded in §§15.2, 17.26 and 37.12. No tests/builds/typechecks/audits/provider probes/benchmarks/release checks are running under the user's implementation-first instruction. Git state is mixed and preserved; nothing is staged or published. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — direct CodeMode recovery update

P1 has source for direct-root CodeMode terminal receipt recovery in EffectHost,
bound to trusted authority, exact committed wave frame/digest, direct scope,
and ordered durable `session_batch` calls. It projects immutable per-call
receipt refs/kinds/digests. P1 also added a DB-derived wave-pin resolver; the
old “query missing” status is superseded, and P2 need not accept request-
supplied pins. The path remains unavailable until P2 wires the authenticated
HostKernel lifecycle and typed Core Supervisor
projection, and P7 consumes that API through ordinary ToolBatch. P1's
ExternalEditor durable binding now includes typed cgroup identity; P2 must
pass it through and confirm quiescence before reconciliation. No tests/builds/
typechecks/provider probes ran. V1 remains PARTIAL / NOT VERIFIED / NOT
RELEASED.

CodeMode contract clarification: §37.24 start does not accept a Core-supplied
lease. HostKernel derives authenticated Session/Attempt and Location, checks
enablement, and prepares the outer `codemode.execute` effect/lease itself;
Core provides trusted lane binding, request ID, enablement ref and bounded
start frame. Missing Session→Location authority fails closed.
P7's caller seam uses the ordinary `codemode.execute` Tool.Def's trusted
Tool.Context `{sessionID,callID,lane,abort}`; callID is private typed
Supervisor correlation only. HostKernel matches the active Guarded call and
derives its own challenge/lease with a fresh bound host requestID. No new
public RPC fields or caller-supplied lease.

P1 has added persisted terminal cgroup binding and startup UNKNOWN/quiescence
reconciliation APIs for interactive `terminal.run`/`terminal.start`; P2 has
source-wired HostKernel with exact Guard lease, principal, Attempt/profile/
owner-epoch pins and kill-and-empty proof before settlement. The path remains
gated by `GUARDED_PTY_RUNTIME_READY=false` pending acceptance. P1 also added
strict CodeMode execution inspect, but P2 still owes start/resume/wave/cancel
and typed Core lifecycle. P1 removed the stale anonymous Tavily route; four
fixed keyless routes remain, with BYO Tavily separately enabled. Source only.
P1's effect-origin source audit closes current plugin/MCP/hook/legacy process
bypasses: only pinned HostKernel/session-supervisor processes can launch;
plugin hooks are inert; MCP is unavailable; project tools are absent from the
first-party registry. P2/P4 typed routes and integrated acceptance remain.

P7 source audit: ActivityStream projection, sequence/generation fencing,
resnapshot, ContextLedger projection and usage/cost provenance analytics are
present but unverified. P1 provides
`list_direct_attempt_terminal_artifact_receipts`; P2 has source-wired direct
artifact list and authenticated Core inspect/range with EffectHost /
ArtifactStore receipt checks. P7 integrated this for direct child Attempts
through authenticated `SessionTools` scope, artifact search and opaque shell
ref hints for non-sensitive FULL/SAMPLE captures. Root sessions lack
DirectAttempt scope; root artifact search remains unavailable. Source only.

Artifact lookup decision: use P1's terminal-receipt enumerator and reuse
ArtifactStore's deterministic
`terminal_<blake3(effectID)>` key only after authenticated derivation through
direct Session → committed ToolBatch → settled receipt and validation of owner
refs, workspace revision, DirectAttempt/effect IDs and terminal receipt
digest. Do not add a second artifact index or accept caller-supplied IDs/paths.

P7 now projects the canonical Core `providerRequestID` into
`SessionEvent.Step.Ended.usageProvenance.requestID`, aligned with
ContextSelection and the future durable provider journal. P6 must preserve the
same ID as non-wire RequestExecutor metadata; dispatch remains disabled.

P7 now reports exact byte counts for Session-message/profile ContextLedger
sources where encoding is known. The aggregate provider input leaves bytes
unknown because `ledger.requestBytes` already reports the total; token counts
remain unknown without tokenizer estimates. Core currently exposes
direct CodeMode wave receipt lookup only; P2 still owes the typed lifecycle
methods for P7's nested ToolBatch consumer.

P7 fixed ContextLedger provenance by pinning `sourceRevision` at frozen
request construction, preventing later Session events from appearing in the
request's ledger. Cursor lookup failure suppresses the UI projection only.
The TUI labels exact request payload bytes separately from unknown token
counts and includes refs/protection/cache classes.
P7 source review fixed a ContextLedger unbound `sourceRevision` identifier;
the code remains unchecked pending the implementation-first hold release.

## 2026-10-22 cross-phase integration checkpoint

P2 has source for authenticated managed effect-wave receipt lookup through
HostKernel/Core over P1's EffectHost journal. Known terminal outcomes project
the exact durable `challengeID` as `receiptRef` with its digest; pending rows
fail and UNKNOWN exposes neither public receipt field. Direct-root CodeMode
still needs the P1 DirectSession receipt query and P2 authenticated HostKernel
caller, bound to Session/owner epoch/policy/workspace and the committed batch.
P7 owns the Core ToolBatch consumer; CodeMode remains disabled.

P7 will mint one stable direct provider request ID at Core request construction
for ContextLedger and the durable journal. P6 must consume that ID at the
protected RequestExecutor edge. Sending stays closed until trusted route and
profile/context/scope pins and atomic assistant/usage/journal settlement are
integrated. No tests/builds/typechecks/provider probes have run. V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — current implementation checkpoint

P1, P2 and P7 are the live whole-phase owners. P4 returned PARTIAL after
updating the Explorer-to-editor callback with exact preview content digest.
P6/P8/P9 remain open and queued because the actual child-thread limit is full.
Editor workspace launch is gated on P1's durable scratch binding plus P2's
authenticated lifecycle; edits must settle through a separate Guarded
`files.patch`. P7 owns the direct Core SessionRunner provider caller and needs
P6's Core RequestExecutor route adapter. User deferred checks until source
implementation closes. P1 is adding the durable editor binding and
editor binding remains open; P1's Attempt-scoped process/effect recovery query
is now source-present with exact per-effect pins. P7 wired best-effort direct
ContextSelection/ContextLedger but provider journal/dispatch remains open. P7
also owns the Core nested-wave callback; P5 still needs the Core CodeMode
registry adapter. Overall V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — direct-provider caller correction

P7 found the canonical direct coding caller is Core `SessionRunner` → `LLMClient.stream`; the existing OpenCode-derived direct-authority branch is not used by that journey. The Core SessionStore journal and P6 ProviderTransport lack a production caller. P7 owns the real caller/LLMClient integration with P2 profile/context pins and P6 transport; sends remain gated until exact bindings are used and settled atomically.

## 2026-10-22 — active whole-phase owner checkpoint

P2 managed lifecycle/HostKernel, P4 LSP/DAP/REPL/external editor, and P7 streaming/context/artifacts/analytics/automation/rewind are active. P1 returned PARTIAL after its unblocked source pass and remains responsible for integration/acceptance. P3 and P5 handed off their unblocked Explorer and search/CodeMode source; search and CodeMode stay gated pending P1/P2/P7. P6, P8, P9 and final V1 acceptance remain open. No tests/builds/typechecks/audits/provider probes before implementation closes, per user direction. Mixed Git state preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — current live roster correction

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, and P4 LSP/DAP/REPL/external editor. P3 handed off unblocked authenticated Explorer/discovery and exact-revision preview source. P5 handed off unblocked search cascade receipt/retry and authorized CodeMode catalog/strict adapter source; both remain unavailable pending P1/P2/P7. P7 is next to resume when a slot opens. P6/P8/P9 closure and final V1 acceptance remain outstanding. The user requested source implementation before tests; no checks/provider probes are running. Mixed unstaged/untracked work is preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — current active implementation owners

P1 Guard/ExecutionHost has resumed source implementation. P4 owns the configurable command-only editor, external-editor profile settings/launch adapter, and supervised LSP/DAP/REPL source. P5 owns the approved built-in search cascade and CodeMode source. P3 handed off currently unblocked authenticated Explorer/discovery and exact-revision preview source. P2 and P7 remain the next whole-phase owners when slots open; P6/P8/P9 source closure and final acceptance are still outstanding. The user requested implementation before tests, so no tests, builds, typechecks, audits, provider calls, benchmarks or release gates are being run yet. Git remains mixed and unstaged; preserve unrelated work. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — live source-only owner correction

Active whole-phase owners: P3 RepoIntel/Explorer, P4 LSP/DAP/REPL/external editor, P5 web search/CodeMode. P3 has implemented authenticated bounded HostKernel discovery/read routes, SDK projections and revision-bound `/editor` previews; exact ignore exceptions expose new files to Git. P4 removed ambient LSP filesystem marker probing and added strict editor-profile schema/config; profile CAS/settings and the gated launch adapter are underway. P5 fixed explicit-null zero-send receipt parsing and added authorized CodeMode catalog projection; nested dispatch remains unavailable pending P1/P2/P7. Further P1/P2/P7 owners could not start because the platform reports its thread limit reached; their source is partial and unaccepted. Verification stays deferred until implementation closes per user instruction. Preserve mixed Git state. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — phase owner refill after quota exhaustion

P1/P2/P7 agents terminated at the platform usage limit; their latest source reports are partial. Current whole-phase owners: P3 RepoIntel/Explorer, P4 LSP/DAP/REPL/editor, P5 search/CodeMode. Parent added an optional EventV2 transaction commit callback to `Session.updateMessage` so the assistant projector and provider request journal can settle atomically. Direct provider dispatch remains unavailable until P2's exact root AgentProfileV2 authority is propagated and the stream caller uses this commit seam. P1 persisted/replayable exact HTTP/Git-read output; production P2 callers remain incomplete. P5 corrected explicit-null zero-send receipt parsing. No tests, builds, typechecks, audits, provider calls or release checks have run by user direction. Git remains broadly mixed/unstaged; no publication. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — latest implementation-only owner/status correction

Active phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel and P7 streaming/context/artifacts/analytics/automation/rewind. P6 handed off PARTIAL after completing currently unblocked provider/settings/Doctor/S1 source work; direct request dispatch still depends on P7's frozen ContextSelection/provider payload callsite, managed sending on P2 settlement, and protected credentials on P1. P7 now owns `session/llm.ts` and the canonical `session/tool-batch.ts` CodeMode wave adapter. P1 owns Guarded Git-read durable result/receipt/replay; P2 owns its authenticated HostKernel RPC/Core caller. The Explorer remains blank behind opt-in `/editor`; P3 is open for a future whole-phase slot, and P4 owns external editor/protocol lifecycle integration. No tests/builds/typechecks/audits/provider probes/benchmarks/release operations have run. Preserve all mixed Git changes. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## Live V1 continuation — 2026-10-22

V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Active whole-phase implementation owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, P6 providers/settings/Doctor/S1. The platform limit is four agents total including the parent; dispatch the other whole-phase owners as actual slots free. User's implementation-first hold is active: no tests/builds/typechecks/audits/provider probes/benchmarks/release checks have run. The tree is mixed and unstaged; preserve all existing work.

Parent added the CodeMode stdio helper entrypoint and Linux GNU build packaging source with a digest manifest. Runtime remains unavailable until trusted HostKernel install metadata, Core enablement, nested ordinary ToolBatch dispatch, per-call receipts/UNKNOWN recovery, and cancellation/reap are integrated. P1 added `ProjectRead { workspace_id }` process scope; P1 owns the Session-scope managed-verifier binding, P2 owns HostKernel constructor integration, and project Git reads require the existing explicit `workspace-code/read` grant. P6's exact pinned anonymous-free direct provider transport awaits P7's frozen request/ContextSelection caller. See `HANDOFF.md` for the current integration checkpoint.

## 2026-10-22 — live owner and source ledger

| Phase | Owner | Source state | Next dependency / acceptance |
|---|---|---|---|
| P1 Guard / ExecutionHost | `/root/p1_guard_executionhost` | Active. Current source work rejects unknown process capability IDs at preflight and binds HTTP aggregate terminal settlement to the exact canonical approved route-plan digest. P1 is wiring route receipt transition validation and supplying fixed-operation read-only Git Guard/execution contract to P2. | Continue entire P1 closure: actual ExecutionHost confinement, command/process guard, Attempt/effect scope, enabled-origin closure, ToolBatch/lease/recovery, cgroup restart proof; keep unsupported origins unavailable. No checks run. |
| P2 managed lifecycle / DAG | `/root/p2_managed_lifecycle` | Active whole-phase owner. Goal proposal/review/start and Run controls are source-present. MCP search sends use P1's pre-send proof API; keyless/resume terminal settlement and exact route-plan pins are in progress. P2 agreed to add HostKernel-authenticated principal + registered Location/workspace scope for project VCS reads; it will not fabricate Session identity, and it will keep startup migration reads unavailable without authenticated pins. | Complete search recovery, authenticated reviewer/Attempt/effect/workspace/verifier/evidence binding, lifecycle and UNKNOWN recovery, direct child/follow-up, bounded DAG and managed vertical; implement fixed allowlisted Git reads through the shared supervisor, with a Session pin additionally required where one exists. |
| P3 RepoIntel / history | Refill after P1/P2 integration | PARTIAL; source pass added SQL size-before-decode bounded history reads with recheck. | Parser/overlay producer, HostKernel query/cache lifecycle, safe exposure and integrated acceptance remain dependent on P1/P2/P4/P8. |
| P4 LSP / DAP / REPL / external editor | Queued | PARTIAL; single-pane startup and explicit `/editor`, `/editor --side`, and `/editor --close` routes are source-present, but `/editor` currently opens an empty unavailable Explorer. Saved editor-profile selection, Guarded external launch, language/debugger/repl ingress and acceptance are incomplete. | P3 must supply authenticated bounded tree/file projection; P1/P2 must supply approved editor launch lifecycle; finish profile selection and protocol routes, then keep each unsupported path unavailable. |
| P5 search / CodeMode | Queued for slot refill | PARTIAL. Search retry and aggregate FAILED/CANCELLED/EXHAUSTED projections are source-present; provider and Rust receipt integration remain. CodeMode callback injection is removed, helper entrypoint/package source now exists, but runtime remains unavailable. | Resume whole phase when an agent slot opens; integrate P1/P2 proof-backed route receipts and P6 transport; CodeMode needs P1 fixed helper/confinement, P2 authenticated waves, P7 shared ToolBatch dispatch and P9 packaging before enablement. |
| P6 providers / settings / Doctor / S1 | `/root/p6_providers` | Active whole-phase owner. Core SessionStore journal, exact selected anonymous-free OpenCode route projection, bounded request preparation, one-use PINNED→DISPATCHING fetch, and UsageProvenance-bound settlement/UNKNOWN fencing are source-present; final frozen-payload/ContextSelection caller is P7-owned. P6 also owns the Core CodeMode bundle install/startup argv adapter. | Finish auth/settings/Doctor/S1 and TUI switching, then coordinate the exact frozen ContextSelection/provider payload caller with P7. Keep provider sends gated until selected-route authorization, usage settlement and UNKNOWN recovery are integrated. |
| P7 stream / context / artifacts / analytics / automation / rewind | Refill for dependency integration | PARTIAL; independent bounded/redacted stream, replay/resnapshot, artifact/analytics and ephemeral ContextLedger TUI source is present. Managed selection now includes `lane: managed`. | Direct ContextSelection/profile pins, Guarded automation, artifact receipt provenance and checkpoint restore/recovery depend on P1/P2/P8. CodeMode's nested dispatcher still needs a whole-phase P7 owner; current implementation-agent thread limit prevents another assignment. |
| P8 resources / workers / evaluation | Queued | PARTIAL; evaluation/resource source present but unverified. | P1/P2 authenticated settlement, measured pressure policy, supported OS hard limits and final reproducible coding-task evaluation. |
| P9 distribution / release | Parent + refill queued | PARTIAL; source-only Linux/WSL release work exists. Parent added the stdio CodeMode helper entrypoint, native Linux GNU helper bundle, and build-time SHA-256 manifest/embedded asset. P2 owns HostKernel manifest parsing; P6 owns secure Core install/startup argv. | Notices/licensing, signing/update/rollback, clean install/migration/upgrade and exact-candidate release gates; verify only after all V1 source work closes. |
| P0 integrated V1 acceptance | Parent | NOT VERIFIED. | After source closure, run requested final verification and real coding journeys; only then consider exact task-owned Git publication. |

User's implementation-first instruction remains active: no tests/builds/typechecks/audits/provider probes/release checks until source implementation across V1 closes. Current child owners are P1, P2 and P6; P5's unblocked source handoff returned PARTIAL, with integration work to resume when its dependencies land. Git remains mixed, unstaged and preserved; no staging, commit, push or cleanup. Overall status: PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — continuation state

The current agent service would not admit another child because its thread limit is reached; live whole-phase owners remain P1, P2 and P6. Parent is coordinating the shared integration boundary and will take only narrow unblockers until a phase slot opens. P2 agreed to implement both authenticated project-instance principal/Location Git reads and an explicitly session-bound Core adapter where a Session exists; startup migration reads remain unavailable without authenticated pins. P1 was asked to match the fixed-operation Guard contract to this scope, with routine bounded workspace reads governed by the user's selected permission mode and no repeated per-read prompts. P6's direct request journal source exists; ProviderTransport/Auth integration and atomic canonical assistant settlement remain open, and P7's exact frozen provider-input caller remains a dependency. Implementation-first hold remains active; no checks or Git publication were run. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — source alignment update

P3 aligned the ContextLedger TypeScript, JSON Schema and §30.2 shape and added ContextSelection.lane; P2 still owns the managed producer/recovery literal update. Parent specified the ephemeral request/source-generation-fenced session.context_ledger stream event and CTX-001..005; P7 owns TUI projection. P1 checked the Rust CodeMode start source and found empty tool lists already pass the pure-compute path, so no duplicate edit was made. P5 returned PARTIAL; P1/P3/P7 are active and P2 is next critical path. No tests or builds ran.

## 2026-10-22 — profile-bound ContextSelection update

P3 now requires exactly one direct Core Config AgentProfileV2 ref (ID/revision/digest/trust) plus an explicit lane in ContextSelection. P2 must wire the trusted direct-session profile into all Core callers and add lane=managed plus the exact Task-pinned profile to managed prompt and recovery constructors. No fallback to display-name/model is allowed; ContextLedger remains unavailable until these pins are live.

## 2026-10-22 — active implementation roster

| Phase | Owner | State | Immediate work |
|---|---|---|---|
| P1 Guard / ExecutionHost | `/root/p1_guard_executionhost` | IN PROGRESS | Full phase resumed: confinement, command guard, Attempt/effect binding, origin closure, ToolBatch recovery and receipt semantics. |
| P2 managed vertical / DAG / HostKernel | queued for child slot | PARTIAL | Refill second critical path; finish HostKernel and managed/direct child lifecycle, including CodeMode durable wave authority/settlement. |
| P3 RepoIntel / coding path | `/root/p3_repo_intel` | IN PROGRESS | Bounded history storage reads and RepoIntel/context integration. `compileContextLedgerV2` is source-present; reconcile its TS shape with §30.2 and JSON Schema mirror before handoff. |
| P4 LSP / DAP / REPL | queued | PARTIAL | Remains gated on P1/P2/P3 and OS acceptance. |
| P5 search / CodeMode | returned PARTIAL | PARTIAL / BLOCKED | Unblocked source is present. Remaining trusted `NOT_DISPATCHED` transport/receipt and direct-root BYO profile scope depend on P1/P2/P6; CodeMode bridge depends on P1/P2/P7. Direct-root anonymous search already exists. Refill after P2/P6 APIs land. |
| P6 providers / settings / Doctor / S1 | queued | PARTIAL | Resume after critical P1/P2 slots; keep paid routes disabled absent explicit consent. |
| P7 stream / context / artifacts / analytics / automation / rewind | `/root/p7_streams_artifacts` | IN PROGRESS | Exact-payload ContextLedger integration, nested wave seam, bounded SVG/Mermaid in-flight work, and remaining phase source. Nested settlement depends on P2. |
| P8 resources / workers / evaluation | queued | PARTIAL | Complete bounded resource/evaluation source; OS hard limits remain unavailable unless proven. |
| P9 distribution / release | queued | PARTIAL | Complete Linux/WSL packaging and release source. |
| P0 integration / verification / release | parent | NOT STARTED | After implementation closes, run final integrated verification and release acceptance. |

User instruction remains implementation first: no tests/builds/typechecks/providers/release checks until source implementation closes. Overall V1 is PARTIAL / NOT VERIFIED / NOT RELEASED. Git changes remain unstaged and mixed.

## 2026-10-22 08:18 UTC — source integration checkpoint

The direct root-session editor grant path now correlates candidate-only preflight to the exact singleton challenge digest at `resolve_approval`. Core sends `grantPreflightDigest` only after validating the strict HostKernel response and restores ordinary approval on typed `effect_conflict`, retrying without the marker. P1 owns EffectHost grant authority; P2 owns HostKernel preflight/revalidation/atomic approval; P4 Core owns the caller and user-dialog fallback. P2 must confirm exact typed conflict/challenge behavior. This remains source-only and gated: no tests/builds/typechecks have run; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 08:13 UTC — active phase ledger refresh

| Phase | Owner/state | Source progress / dependency | Evidence state |
|---|---|---|---|
| P1 Guard/ExecutionHost | `/root/p1_guardv1`, ACTIVE | Reports typed root DirectSession LSP/DAP read-only grant helper and durable `EMPTY` search outcome; needs remaining HostKernel live scope/process/workspace binding, lease/receipt/recovery and whole-phase source closure. | Source-only; tests authored but unrun. |
| P2 managed vertical/DAG | `/root/p2_managedv1`, ACTIVE | Reports HostKernel `EMPTY` result and explicit-empty-domain `NOT_DISPATCHED`; continues full managed lifecycle and CodeMode HostKernel authority/caller seam. Root editor integration still needs trusted current-workspace projection and grant candidate API. | Source-only; no tests/builds/typechecks. |
| P3 RepoIntel/context | PARTIAL | Prior source pass remains; tools gated pending parser/navigation, overlays/cache/resource integration and acceptance. | NOT VERIFIED. |
| P4 LSP/DAP/REPL | Parent source continuation; whole-phase owner queued | Core validators now admit no-Attempt root Session shape and enforce current HostKernel epoch for protocol operations. Production prompt ingress remains Attempt-only; root workspace/grant projection is missing. REPL also remains blocked on hard OS quota and HostKernel routing. | All routes unavailable; no acceptance. |
| P5 web search/CodeMode | `/root/p5_search_codemode`, ACTIVE | Empty-domain query intent and `EMPTY` semantics reflected; CodeMode returns unavailable before reading catalogs/interpreter while false gate remains. Needs P1/P2 authenticated wave bridge and P6 transport before exposure. | Source-only; no tests/providers. |
| P6 providers/settings/Doctor/S1 | QUEUED | Provider/SecretBroker and setting source work resumes after slot; managed send depends on P1/P2/P7. | No provider probes. |
| P7 stream/context/artifacts/analytics/automation/rewind | QUEUED | Exact provider-payload ContextSelection callsite and remaining phase work; effectful invocation depends on P1/P2/P8. | No checks. |
| P8 resources/workers/RC0 | QUEUED | Whole-phase implementation follows available slot/dependencies; unsupported hard OS quota claims remain unavailable. | RC0 NOT_ATTESTED. |
| P9 packaging/release | QUEUED | Source work remains; distribution grant/notices, signing/update policy, candidate and Linux/WSL acceptance are release blockers. | NOT VERIFIED / NOT RELEASED. |

Testing/build/typecheck/provider hold remains active until source implementation closes. Git state is preserved without staging, commit, push or cleanup. Repo disk reading: 814 GB free; `kernel/target` 627 MB. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 07:50 UTC — active implementation ledger

| Phase | Owner/state | Source progress / dependency | Evidence state |
|---|---|---|---|
| P1 Guard/ExecutionHost | `/root/p1_guardv1`, ACTIVE | Owns Guard/EffectHost/ExecutionHost and CodeMode private wave authority; HostKernel integration is P2-owned. | Source-only; no checks under user hold. |
| P2 managed vertical/DAG | `/root/p2_managedv1`, ACTIVE | HostKernel owns authenticated RepoDocumentRead revision domain/no-follow path and CodeMode direct/managed authority mint/revalidation; continue complete managed lifecycle and integrations. | Source-only; no checks under user hold. |
| P3 RepoIntel/context | Source pass complete, PARTIAL | RepoDocumentRead TS DTO/callers and bounded lexical definition candidate path are source-present; tools stay gated. P7 owns direct ContextSelection-to-provider-payload callsite; parser-backed graph, overlays and cache lifecycle remain open. | No tests/builds/typechecks run. NOT VERIFIED. |
| P4 LSP/DAP/REPL | QUEUED; parent performed read-only source mapping | Existing adapters are not fully integrated; LSP gates false, no DAP production route, REPL lacks guarded HostKernel route and hard OS quotas. | Unavailable; no runtime acceptance. |
| P5 web search/CodeMode | `/root/p5_search_codemode`, ACTIVE | Owns the whole built-in search cascade and existing CodeMode interpreter/registry integration; depends on P1/P2 wave APIs and P6 SecretBroker transport, while P7 owns LLM/tool-batch callsites. | Hidden/unavailable pending integration. |
| P6 providers/settings/Doctor/S1 | QUEUED | Follow P5; existing transport/config owners and managed provider sender remain gated by P1/P2/P7. | No provider probes. |
| P7 streaming/context/artifacts/analytics/automation/rewind | QUEUED | Owns exact direct context payload callsite plus remaining P7 work; effectful invocation depends on P1/P2/P8. | Source-only, no checks. |
| P8 resources/workers/RC0 | QUEUED | Bounded DAG/resource/recovery integration after P1/P2 managed acceptance source; no unsupported quota claims. | RC0 NOT_ATTESTED. |
| P9 packaging/release | QUEUED | Release implementation after phase source closure; exact-scope gate/publish only at release boundary. | NOT VERIFIED / NOT RELEASED. |

Testing/build/typecheck/provider-probe hold remains active until all requested source implementation is complete. Preserve the mixed Git tree; no cleanup or Git mutation. Current repo disk check: 813 GB free and `kernel/target` 627 MB.

## 2026-10-22 07:44 UTC — architecture freeze / implementation roster

Architecture docs were read line by line across §§01–45, README and GLOSSARY; current edits and cross-references were reread. Contract fixes and source gaps are recorded in the normative owners and §42.15. Active phase owners: P1 `/root/p1_guardv1`, P2 `/root/p2_managedv1`, P3 `/root/p3_codingrepo`. P4–P9 remain in V1 and are queued for immediate admission as slots free. No phase is VERIFIED/RELEASED. User deferred tests/build/typechecks/provider probes until all implementation source is complete; none were run. No Git mutations or cleanup. Preserve existing mixed state.

## Current V1 phase ledger — 2026-10-22 continuation

| Phase | Owner | State | Current contract-bound work |
|---|---|---|---|
| P1 Guard/ExecutionHost | Slot open after source continuation | PARTIAL | P1 added candidate-only direct-grant preflight in EffectHost/Core, exact ordered-ID digest correlation and `allowEnabled` checks. It remains limited to direct edit challenges. Build/test profile admission is unavailable until P2 binds immutable profiles to terminal effects. Remaining Guard/ExecutionHost full-phase closure and integrated acceptance must be resumed when a slot opens. |
| P2 managed vertical + DAG | `/root/arch_audit_20_33` | IN PROGRESS | Entire managed lifecycle/DAG and HostKernel. Implementing the direct-grant preflight RPC, profile-bound build/test effects, and per-Task verifier plus aggregate Run settlement; current single-Task reducer/HostKernel fences cannot simply be removed. |
| P3 RepoIntel / discovery | Unassigned | PARTIAL / QUEUED | Earlier source work exists; parser provenance, authenticated HostKernel read/index/cache integration and acceptance remain. Refill as soon as a slot opens. |
| P4 LSP / DAP / REPL | Unassigned | PARTIAL / QUEUED | Earlier lifecycle/protocol source exists; guarded launch, callback policy, confinement/resource limits and real-project journeys remain. |
| P5 built-in search + CodeMode | `/root/arch_audit_34_45` | IN PROGRESS | Whole phase resumed. Search cascade is source-present but runtime remains gated pending P1/P6; CodeMode protocol mirror exists but nested authenticated dispatcher/helper supervision are not integrated. Keep registry and search runtime disabled until prerequisites pass. |
| P6 providers/settings/Doctor/S1 | `/root/arch_audit_34_45` (source pass returned) | SOURCE-PRESENT / PARTIAL | Currently unblocked source work is complete; remaining SecretBroker, Guarded transport/Doctor, managed provider lifecycle and FEAT/S1/free-model acceptance depend on P1/P2. |
| P7 streaming/render/artifacts/analytics/automation/rewind | `/root/p7_stream_artifacts_automation` | IN PROGRESS | Whole phase resumed. ContextSelection compiler now emits the strict provider-input/message refs; P2 caller exists but has no prompt-path callsite. P7 is wiring exact frozen provider payload at LLM/tool-batch seam and continuing remaining phase work. |
| P8 resources/workers/evaluation | Unassigned | PARTIAL / QUEUED | Staged admission and offline fake evaluation source exist; authenticated pressure/settlement, hard OS quotas, RC0/HUP real acceptance and bounded fan-out remain. |
| P9 distribution/release | Unassigned | PARTIAL / QUEUED | Local Linux/WSL release source exists; license/notices, candidate acceptance, signing/update/rollback and release gates remain. |
| Final integration and release | Parent | NOT STARTED | After all phase source implementation: final tests/builds/typechecks, real selected-provider journey, adversarial/recovery, OS/platform and release gates, then scoped publication only if exact diff is safe. |

Architecture is reconciled from full line-by-line `arch_V1` audit and primary-source research. The source audit added one last precise contract clarification: non-consuming grant preflight and its schema/digest must precede dialogs, with atomic Guard revalidation still authoritative. CodeMode/search/provider and several other source gates remain unavailable; design presence is not runtime proof. User's instruction remains implementation first and testing later: no tests, builds, typechecks, audits, provider calls, benchmarks or release checks have run in this phase. Preserve the mixed Git state; no stage/commit/push/cleanup.

## Live source checkpoint — 2026-10-21 16:05 UTC

This supersedes the earlier owner/contract status below. P1's source response now distinguishes stable Stage-A `proofDigest`, stable Stage-B `receiptDigest`, and current lease `leaseProofDigest`; Stage-A bound replay returns its saved ContextSelection. P2's strict decoder preserves these identities, checks the Stage-A proof across bind, uses only the stable Stage-B receipt for admission, and retains the exact selection revision across preflight replay. P8 staged admission source is present; its owner continues independent HUP/RC0/resource tasks. P1 returned partial; managed provider send remains unavailable pending authenticated provider routing, SecretBroker use-lease, and guarded ExecutionHost receipts. P7 is active on remaining streaming/rendering/artifact/analytics/automation/rewind source. No tests/builds/typechecks/audits/provider/benchmark/release checks or Git publication ran. Preserve mixed Git state and repo-only boundary. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Live source checkpoint — 2026-10-21 15:59 UTC

This checkpoint supersedes the older owner rosters below. Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, and P8 workers/resources/recovery; all three child slots are occupied. Current source integration covers HostKernel Stage-A reservation, P8 staged durable pins and `PreAdmissionContextBound`, and Core's exact no-dispatch preflight followed by Stage-B bind and same-reservation Attempt admission. The exact prepared request is retained through the coordinator path. P1 now resolves original Stage-A pins before expiry/worktree derivation. Remaining source seam: use a stable Stage-B context-bind receipt digest for retries and a separate fresh cursor/pool-bound lease proof for current admission, since Attempt attachment advances the OwnerLog cursor; Stage-A replay must indicate whether context binding already occurred. P1/P8/P2 own this integration; P7 takes the next slot. P3/P4/P5/P6/P7/P9 and final integration/release work remain PARTIAL, dependency-gated, queued or acceptance-pending as recorded in the phase matrix below. The user-directed implementation-first hold remains: no tests/builds/typechecks/audits/benchmarks/provider/release checks. Repository-only boundary and mixed Git preservation remain. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## P1 source checkpoint; P3 owner refill — 2026-10-21 12:56 UTC

P1's unblocked source review is complete across Guard/ExecutionHost: cgroup-v2 identity/restart UNKNOWN, ToolBatch bounds/receipts/cancel, enabled-origin gating, and verifier settlement pin integration are source-present. The two session-runner fixture setups are repaired but unrun. P1 still needs full final-revision acceptance and platform/adversarial evidence. Its slot now implements whole-phase P3 RepoIntel/Discovery source. Active owners P2/P3/P7; P5/P6/P8 unblocked source is complete but dependencies/acceptance remain open.

## P6/P7 phase checkpoint — 2026-10-21 12:54 UTC

P6 source review is complete for unblocked work: offline Doctor, exact anonymous free-model eligibility, provider/settings projections and owner-scoped legacy/V2 questions exist. Credential mutations, credentialed provider routes and live Doctor remain disabled pending P1 Guarded secret/network authority; FEAT-001..014 and S1 still need integrated acceptance. P7 now owns stream replay/generation fencing, activity rendering/redaction, artifact truth, analytics, automation and rewind source work. Active whole-phase owners P1/P2/P7. No tests/provider/build/typecheck/audit/release operations; implementation continues.

## P1 source status clarification — 2026-10-21 12:52 UTC

Direct child-turn journal, HostKernel begin/complete/fresh authorization, effect-scope binding, strict Rust DTOs and Core caller are source-present; runtime remains unavailable. Historical 143/0 focused runner evidence supersedes the obsolete 91/2 note, but does not qualify as final integrated-revision evidence. No checks were rerun under the implementation-first hold. P1 still owns cgroup recovery, Guard/origin, ToolBatch, lease/receipt/cancel/restart and adversarial closure.

## Verifier source integration checkpoint — 2026-10-21 12:51 UTC

P1 now creates a private verifier-pin token only from the exact persisted Verified ChallengeSet/evidence and compares P8's echoed identity pins on durable receipt replay. P8 OwnerLog v4 persists the trio only for Verified settlement; failed/cancelled quarantine has no verifier pins. P2 strict decoder/settlement request remains in progress and follows canonical §33 `builtin.verifier`. Active owners are P1/P2/P6; P5 projection source is complete but runtime remains gated, P8 unblocked source is complete but acceptance is open. No tests/builds/typechecks/audits/provider/release/Git commands; implementation-first hold remains. V1 is NOT VERIFIED / NOT RELEASED.

## Current implementation checkpoint — 2026-10-21 12:49 UTC

P8's unblocked source is complete for worker settlement verifier pins: Verified settlements require the HostKernel-minted opaque token, and OwnerLog v4 receipts bind the verifier run/set digests. P1 still must mint/validate and replay-compare; P2/Core decoding remains active. P8 stays PARTIAL: trusted hysteresis inputs and safe cache retirement are not wired, OS hard quotas are unsupported, RC0 lacks P1/P2 attestation, HUP is fake-only. Active owners: P1, P2, P6. P6 is implementing providers/settings/Doctor/S1 and SecretBroker transport; P5 route runtime stays gated pending P1/P6. P7 durable stream replay/source-generation gap is open. Implementation-first hold remains; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## Current ownership checkpoint — 2026-10-21 12:38 UTC

The user selected optional Linux cgroup-v2 containment for restart proof; source exists and P1 owns closing its exact lifecycle/reconciliation requirements. Current whole-phase implementation owners: P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, P8 resources/workers/evaluation. P1 is adding typed trusted pins to ChallengeSet recovery and settlement receipts; receipts must echo and validate `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`. P2 rejects missing/mismatched pins and propagates verifier identity. P5's unblocked source projection work now matches the bounded typed provenance contract, requires measured latency/truncation truth, and uses sanitized provenance; runtime remains disabled pending P1 Guard/receipt and P6 SecretBroker acceptance. P7 source audit found the SSE route lacks durable Last-Event-ID replay and sequence/generation fencing; implementation remains open for the next P7 owner. Remaining phases P3/P4/P6/P7/P9 and final integrated verification remain open. No testing/build/typecheck/audit/provider/release or Git publication yet; user requested implementation first. All current changes remain unstaged; repo-only restriction forbids external access/remotes. Release state: NOT VERIFIED / NOT RELEASED.

## Current owner restart — 2026-10-21 11:02 UTC








## 2026-10-21 11:15 UTC — P1 contract bounds; P2 checkpoint; P7 started

P1 added strict ToolBatch schema count/identifier bounds (32 calls/effectRefs, 256-byte protocol IDs) and HostProcessRef identifier parity. Its source audit found production effect origins either Guarded or denied before dispatch; no missing first-party production process origin was identified in packages/core/opencode source. It did not add a crash janitor: existing bwrap PID namespace/PDEATHSIG lacks durable exact containment identity, so PID/starttime/boot ID alone cannot safely authorize tree kill or prove quiescence; UNKNOWN remains. P1 is continuing the whole phase source audit and contract work. P2's direct follow-up runner source is in place, with its gate still false; P2 returned partial/unverified. Reassigned its freed slot to P7 streaming/rendering/artifacts/analytics/automation/rewind source implementation; P6 continues. P3/P4/P8/P9 remain partial source checkpoints; P5 remains dependency-gated. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. No files were staged. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:13 UTC — P2/P6 direct-source updates; release decisions pending

P2's server-callable serialized follow_up runner and authenticated HTTP delivery path are now source-present. It uses exact request/profile/live Attempt/completed-turn pins, prepare/commit receipts, HostKernel fresh-turn proof, exact message claim, persisted completion and idempotent consume ACK; ambiguity remains UNKNOWN and no duplicate prompt is injected. Runtime remains false-gated pending integrated P1/P8 acceptance. P6 source now narrows anonymous OpenCode eligibility to exact active, zero-priced, supported model refs shared by backend/default/picker; custom model loaders stay unavailable. TUI hydration and lane-specific reply/reject now cover both authenticated legacy and QuestionV2 streams. P6 is doing final source-only boundary review and local upstream comparison. No checks ran.

P9 release implementation remains partial. Two user decisions were requested asynchronously: distribution grant/notice review status, and whether V1 keeps remote install/update disabled until signing policy exists. Continue source work that does not depend on those answers. Active implementation owners remain P1/P2/P6; P1's restart containment source blocker remains unresolved. P5/P7 wait for agent capacity. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:13 UTC — P2 direct follow-up runner source added

P2 added the public follow_up HTTP delivery path using a live child Attempt/profile/completed-turn pin, bounded durable inbox reservation, HostKernel fresh-turn authorization, Guard prepare/commit, and a serialized internal SessionPrompt runner. It claims only the committed message, persists turn/completion receipts, and ACKs consumption; ambiguous delivering/UNKNOWN rows remain inspection-only and exact ACK replay is idempotent. `DIRECT_CHILD_TURN_RPC_ENABLED` remains false pending P1/P8 acceptance. No checks ran; P2 remains active for whole-phase managed lifecycle and integration. P1 resumed source implementation on the restart janitor and remaining protocol/origin closure; P6 continues providers/settings/Doctor/S1 and local-source comparison. No tests/builds/typechecks/audits/provider/release/Git operations ran.

## 2026-10-21 11:11 UTC — HostKernel restart boundary and child wake implementation

P1 source review found that unfinished stdio attempts recover to UNKNOWN, while live supervisor handles are process-local and cannot prove tree quiescence after HostKernel restart. Sandbox paths currently use bwrap PID namespaces, `--die-with-parent`, and PDEATHSIG; P1 is evaluating durable containment identity and restart reconciliation. Parent required identity-safe signaling and proof of the actual whole process tree; PID/starttime alone is insufficient, and any unclosed crash window stays UNKNOWN. No validation ran. P2 confirmed Goal proposal→accepted SpecVersion→review→`goal.start`, distinct HostKernel-assigned reviewer, final live workspace revision, and TUI decisions are source-wired; its remaining direct child `follow_up` HTTP edge lacks a reusable server-callable Core runner. P2 is implementing the runner and keeping the gate false. P6 confirmed distinct legacy and Core Question owners; QA-006 requires both event lanes to project only to their authenticated owner. P6 is handling the narrow source projection while provider/settings work continues. Active owners: P1/P2/P6. P3/P4/P8/P9 returned partial; P5/P7 await a free agent slot. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:09 UTC — P9 source checkpoint; P1/P2/P6 active

P9 returned PARTIAL after source-only release changes: clean-install scenarios now verify candidate/previous executable digests around each run and after the matrix; installer activation keeps recovery copies for both command names; release evidence fingerprints include `prepare_build.py`. Only installer/release-owned files changed. No release or validation commands ran. P9 is still blocked on distribution grant/notices, signing/update and rollback policy, final candidate and Linux/WSL acceptance. P1 has resumed full Guard/ExecutionHost source work; P2 continues managed/direct child and follow_up runner; P6 continues provider/settings/Doctor/S1. P3/P4 source checkpoints returned PARTIAL, P8 source checkpoint returned PARTIAL. P5/P7 remain queued, P0 integration parent-owned. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. Mixed unstaged/untracked Git state is preserved. Overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:08 UTC — P3/P4 source handoffs; P6/P9 owners refilled

P3 returned PARTIAL after source-only fixes for bounded directory enumeration, combined RepoIntel selector-count parity (100), profile provenance and fail-closed discovery adapters; parser provenance, trusted buffer snapshots, HostKernel read/cache contracts and P4 readiness remain dependencies. P4 returned PARTIAL after REPL's constant-false authorization gate, LSP/DAP cleanup/quarantine and authenticated P3 document reader wiring; production ingress, P1 Guard/confinement, DAP policy, OS-enforced REPL limits and real-project acceptance remain blocked. Both ran no checks. Reassigned the newly freed slots to whole-phase P6 Providers/Settings/Doctor/S1 and P9 Linux/WSL release source work; P2 remains active, P1/P8 returned source-only partial, P0 integration parent-owned. No tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 11:05 UTC — phase-owner refill and implementation-only checkpoint

P1 returned source-only/partial: HostKernel direct-turn completion and fresh authorization now call the full live Attempt-scope validator against the current revision. P1 acceptance remains open for durable process-tree quiescence, Guard/receipt recovery, origin closure, protocol integration, and adversarial recovery. P8 returned source-only/partial: fixed the evaluation artifact journal digest defect and added descriptor pinning, nonblocking exclusive lock, path/inode checks, and pre-dispatch size/identity fences; RC0/fan-out remain gated on P1/P2 and trusted OS resource limits. Neither phase ran checks.

P2 remains active and found/fixed same-Attempt/same-epoch inbox recovery: an idle child Session's persisted `delivering` row is now UNKNOWN, never reinjected; pending direct-turn completion replay is keyed by exact cycle/result digest and persists only the HostKernel receipt. P3 RepoIntel and P4 LSP/DAP/REPL whole-phase owners have now been dispatched in the newly available slots; P5/P6/P7/P9 remain queued for slots. P0 cross-phase integration remains parent-owned. All agents have the repo-only boundary and implementation-first hold; no tests/builds/typechecks/audits/benchmarks/provider/release/Git operations ran. Git remains mixed and unstaged; preserve all changes. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

Full target remains Linux/WSL-first HorizonCode CLI/TUI V1, P1–P9, integration, final verification and release. New whole-phase implementation owners: P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, P8 resources/workers/worktrees/RC0/evaluation. P3 RepoIntel, P4 LSP/DAP/REPL, P5 web search, P6 providers/settings/Doctor/S1, P7 streaming/artifacts/automation/rewind and P9 release remain to be refilled as slots open; P0 integration is parent-owned. Exact P2 HostKernel direct-turn wire names were shared from current Rust source, but no integrated acceptance is established. Previous P2/P6/P7 workers ended at usage limits.

Attachment review confirms the requested source-first OpenCode/Codex audit and whole subagent lifecycle analysis. The local OMP MetaHarness reference is a benchmark experiment/run/trace/resume manager; the supplied orchestration transcript is a parent/child delegation and recovery pattern. HorizonCode already has HUP/CM acceptance and §42 provenance; do not duplicate CodeMode or JCode swarm authority. No new architecture contract was added.

Implementation-first hold is active. No tests/builds/typechecks/audits/benchmarks/provider calls/release operations have run. Git remains mixed, unstaged and untracked; no publication or cleanup. One primary worktree; `kernel/target` 627 MB; repo filesystem 817 GB available. Repo-only boundary forbids C: inspection and all other external access except the single attachment above. Overall status: PARTIAL / NOT VERIFIED / NOT RELEASED.

## P8 source update — 2026-10-21

The offline HUP-005 fake-only paired-evaluation foundation is now source-present in
`scripts/eval/`: strict frozen manifests, seeded task and balanced arm order, grouped paired
bootstrap summaries, distinct unsupported/infrastructure outcomes, and repository-local
no-follow append-only/fsynced JSONL artifacts with exact-trial resume. Its fixtures are
unrun; this does not provide a benchmark adapter, official score, HostRun/verifier evidence,
or HUP-001 completion. RC0 remains `NOT_ATTESTED`. No additional safe resource-pressure,
worker admission, or cache-retirement source change is available: P1 authenticated HostKernel
ingress/Inspect authority, P2 terminal child/evidence binding, and an approved lower-watermark
plus calm-window policy remain prerequisites. OS-enforced CPU/memory/process/FD limits remain
unsupported and are not claimed. P8 remains `PARTIAL`; no checks ran.

## Owner refresh — 2026-10-21 06:30 UTC

Active whole-phase owners: P2/P8/P9. P1 returned PARTIAL with manifest-pinned executable identity source and an unrun spoof/replacement fixture; §37.9 specifies HostKernel-owned turn-cycle/FreshTurnAuthorization, but the Rust journal/issuer, DirectTurnScope integration and strict wire schema remain absent. Abrupt janitor completion proof remains unresolved. P2 is implementing Core-side consumption only after P1 publishes exact types and keeps follow_up unavailable. P8 is adapting the local Oh My Pi MetaHarness persistence/paired-run/resume semantics into an offline fake-provider evaluation runner; see §42.14. P9 is implementing safe Linux/WSL release-source work. P4/P6/P7 returned PARTIAL. SA-021 specifies multi-phase delegation recovery. No checks ran. The implementation-only hold and repository-only boundary remain active; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Owner refresh — 2026-10-21 06:29 UTC

Active whole-phase owners: P2/P8/P9. P1 returned PARTIAL: executable identity is hardened in source with unrun spoof/replacement coverage; §37.9 now defines the required HostKernel turn-cycle/FreshTurnAuthorization contract, but the Rust journal/issuer, DirectTurnScope effect integration and strict wire schema are still absent. Abrupt janitor completion proof remains unresolved. P2 is implementing Core-side consumption only after P1 publishes exact types and keeps follow_up unavailable. P8 is implementing an offline fake-provider paired-evaluation runner; P9 is implementing safe Linux/WSL release-source work. P4/P6/P7 returned PARTIAL. SA-021 now specifies multi-phase delegation recovery acceptance. No checks ran. The test hold and repository-only boundary remain active; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Current V1 status — 2026-10-21 06:27 UTC

This block supersedes every older phase roster, status, and validation report below; the rest of this file is retained as historical evidence and design context. The target remains complete Linux/WSL-first HorizonCode CLI/TUI V1, P1–P9, integration, final verification, and release. The user-directed implementation-first hold remains: do not execute tests, builds, typechecks, audits, benchmarks, release commands, or provider probes until source implementation across V1 is complete. The latest repository-only rule forbids any access or mutation outside `agentx`, including the earlier pasted-text attachment path and `/mnt/c`; the attachment was not read in this continuation.

Latest source refresh: active whole-phase owners are P1/P4/P8. P1's trusted executable identity closure is source-present with an unrun spoof/replacement fixture; durable janitor proof remains unresolved, and P1 is implementing a HostKernel-minted one-use fresh-turn authorization plus runner-cycle boundary. P2 keeps `follow_up` unavailable until that issuer and serialized-turn progression are safe; managed usage-before-effect and bounded pending-message status are source-present and unverified. P6 added SDK `AssistantMessage.usageProvenance` types/schema and fixtures, then returned PARTIAL. P7 returned PARTIAL with remaining automation, rewind, artifact settlement and terminal-graphics gates. P5 is source-complete for unblocked work, dispatch gated on P1/P6. P8 is active on resources/workers/RC0 and fake-provider evaluation runner source. P3/P9 remain PARTIAL or queued. §32.40 includes HUP-007/008; §32.41 includes CM-008/009; SA-021 records coordinator recovery acceptance. No HorizonCode benchmark runner or uplift score exists. No checks ran.

| Phase | Current implementation state | Remaining work / gate |
|---|---|---|
| P1 Guard / ExecutionHost | PARTIAL; active whole-phase owner. Linux terminal `FRAME_EXIT` is delayed until a bounded janitor sweep proves the process tree empty; incomplete `/proc` scans fail closed. Core process/PTY launches now reject unsupported commands before dispatch. | Durable janitor completion proof readable by a fresh HostKernel remains unresolved, along with remaining enabled-origin closure and integrated Guarded verifier/origin/recovery acceptance. Keep dependent effects gated. |
| P2 managed vertical | PARTIAL; active whole-phase owner. Fixing usage-before-effect ordering in HorizonCode processor/LLM/ToolBatch middleware; source-only managed verification, follow-up and recovery review continues. | Safe child follow-up queue-consumer seam remains unresolved; P1 quiescence/verifier receipts and P8 Inspect settlement acceptance still block effectful verification/finalization. |
| P3 RepoIntel | PARTIAL; latest source pass added the 4 MiB repeated-selector scan-work bound with typed partial results, unrun paging/forgery/work-limit fixtures, and exact-text HostKernel document digest verification in Core. Stale adapter/docs distinctions were corrected. | Parser provenance, trusted unsaved-buffer producer, Guarded query/process route, cursor runtime acceptance, and P1/P8 cache integration remain. |
| P4 LSP / DAP / REPL | PARTIAL; source pass added an explicit false DAP effect-route gate and corrected DAP/REPL fixtures so route registration cannot unlock effects or self-asserted REPL quotas. | Production ingress and effectful lifecycle remain gated pending P1 Guard/confinement/receipt acceptance, trusted RepoIntel document/overlay paths, DAP attach/inspection policy, and actual OS-enforced REPL limits. No checks run. |
| P5 built-in web search | SOURCE-COMPLETE for currently unblocked work; read-only route inspection now distinguishes disabled configured BYO from unconfigured routes, without network dispatch. Fixtures remain unrun. | P1/P6 Guarded transport/receipt/recovery and SecretBroker acceptance, followed by enabled cascade and rendered UI/API acceptance. |
| P6 providers / settings / Doctor / S1 | SOURCE-PRESENT/PARTIAL; provider/model settings, offline Doctor, protected-route adapter and authenticated QuestionV2 projection are in source. | Protected credential input, Guarded Doctor probes, FEAT-001..014/S1/provider-switch journeys and explicitly requested free-model response/coding smoke are not accepted; user hold prevents tests/provider calls. |
| P7 streaming / artifacts / automation / rewind | PARTIAL; activity stream is mounted with a route-level 10,050-message fixture. Throwing delta consumers now drop replay state and request canonical resnapshot. Debug analytics scans at most 256 recent messages and projects at most 16 usage rows (8 default) with window-scoped provenance/unknown counts; fixtures remain unrun. | P6 owns generated SDK `AssistantMessage.usageProvenance`. Automation invocation lacks an approved canonical timezone scheduler; checkpoint capture/restore and managed artifact settlement remain gated on P1/P2/P8. Terminal graphics stay text-only. TUI acceptance remains unrun. |
| P8 resources / workers / worktrees / evaluation | PARTIAL; RC0 rejects duplicate worker/Task/Attempt identities and overlapping process identities. The offline HUP-005 fake-only paired runner is source-present with seeded paired order, grouped uncertainty summary, and a no-follow append-only artifact journal; fixtures are unrun. | P1/P2 authenticated proof seams, trusted pressure policy and supported OS hard quotas remain; worker fan-out and cache eviction stay unavailable. RC0 remains `NOT_ATTESTED`; no benchmark score or final-revision acceptance evidence exists. |
| P9 distribution / release | PARTIAL; Linux/WSL local-candidate install is source-present; native Windows and remote unsigned installation fail closed; upgrade CLI no longer advertises unsupported targets; release artifacts use ignored repo-local `kernel/target/horizoncode-release`. | Distribution license/notices, package identity, signing/update/rollback policy, exact-candidate clean-install/migration/upgrade acceptance, final gates and release remain. No release commands ran. |
| P0 integration / release acceptance | NOT VERIFIED. | Reconcile all phase owners, source overlays and Git-visible first-party files; only after implementation closes run the final HorizonCode typecheck, test/adversarial/recovery matrix, audits, real journeys, platform/release gates, then consider exact task-owned stage/commit/push. Repo-only boundary currently forbids remote operations. |

Active whole-phase owners are P1, P2 and P6 (all three child slots are occupied). P3/P4 returned PARTIAL after source-safe work; parser/overlay/query/cursor and editor ingress/protocol acceptance remain dependency-gated. P5 is source-complete for unblocked work; P7 returned PARTIAL; P8 returned PARTIAL; P9 remains open. HUP-001..008, CM-001..009 and SA-018..020 are requirements, not passed evidence; there is no benchmark runner or measured HorizonCode uplift. Git is mixed, unstaged and untracked; preserve it. The repo filesystem has 820 GB available and `kernel/target` is 627 MB. No tests/builds/typechecks/audits/benchmarks/provider calls/release operations/staging/commit/push/cleanup ran.

**Boundary and integration update — 2026-10-20 09:11 UTC:** the repo-only rule has no exceptions; no outside path, `/mnt/c`, home-directory memory, external service, or remote is needed. All reference source is in-repository. P1 source-integrated guarded automation CRUD/reconcile and exact Summary DTOs; invocation remains disabled. P7 mutation affordances are explicitly unavailable and send no mutation request; P1 owns bounded authenticated HostKernel ArtifactStore read handlers, P7 owns Core/HTTP/SDK/TUI projection. P8 source adds truthful worker resource-limit states and bounded pressure-controller logic, with durable/live ingress still closed pending authenticated policy authority. Current `kernel/target` is 627 MB; one worktree. No tests or other verification run. Git is mixed and must remain untouched by staging/publication/cleanup.

**Boundary and source checkpoint — 2026-10-20 17:55 UTC:** filesystem/process/build inspection stayed inside `agentx`; the current checkout has one worktree, `kernel/target` is 627 MB, and no project build/test process was running. Git remains `main`, 13 commits ahead of `origin/main`, no staged paths, with broad mixed user/task-owned changes; no stage/commit/push was performed. P1's new direct-message journal is now Git-visible via a narrow `.gitignore` exception. P1/P4/P6 are active whole-phase source owners. Direct child message delivery has a Rust PREPARED→ADMITTED→COMMITTED journal plus authenticated Core inbox preparation/approval/commit/inspection and a queue-only UI; P6 is finishing safe-boundary consumption. Follow-up requires fresh Attempt authority and stays unavailable. P8's HUP evaluation contract is documentation only. No tests/builds/typechecks/audits/benchmarks/provider calls ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

### 2026-10-20 09:03 UTC — source-only continuation

P3 has resumed as a whole-phase implementation owner alongside active P1 and P7. P6 returned PHASE_PARTIAL after the free-model eligibility correction; its remaining live/provider-secret work is still unverified and must not use a paid fallback. P5 remains parent-owned; source already has ordered cascade planning, per-route auth-failure fallback, settings controls, durable HostKernel route receipts, and exact read-only UNKNOWN reconciliation, but runtime readiness stays false until integrated Guard/ExecutionHost acceptance. No tests, builds, typechecks, audits, benchmarks, or provider calls were run. Keep the final integrated HorizonCode checks deferred until implementation closes. Work stays inside `agentx`; no Git publication or cleanup.

P3/P8 CacheRegistry ownership is resolved for implementation: P1/HostKernel alone owns retained RepoIntel generations, authenticated query pins and the safe retirement callback; P8 owns only the existing Rust metadata/planner and cannot delete cache entries. P3 may produce typed host-fact observations behind a disabled sink. A planned eviction can only be revalidated and executed by HostKernel for the exact host-minted generation after query pins drain, followed by a fresh P8 observation; reclaimed bytes stay unknown without measurement. Actual eviction remains unavailable until the authenticated P1/P8 seam exists.

The user explicitly renewed one single-file access exception for `/home/sarvesh/.codex/attachments/54d18db8-65b6-4096-bf59-15e64b9f5a35/pasted-text-1.txt`; it has now been read. All other reads, writes, process operations, services, and Git remotes remain restricted to this repository.

## 2026-10-19 19:26 UTC — P1/P4 launch interface progress

P1 has aligned the Rust launch definition decoder/encoder to `executableSelector`. Current
source uses a narrow selector allowlist per LSP/DAP/REPL kind, fixed system executable
directories, canonical path resolution and an executable digest. This is not yet evidence of
safe launch: live HostKernel profile/lease/scope binding, pre-spawn denial, receipt/recovery,
and OS confinement remain open. Parent added a strict `HostProcessRefV1` schema matching the
Rust/TypeScript eight-field wire projection and excluding PID/path. P4 is implementing the
typed HostKernel operation/event adapter; no child stdio path may be reintroduced. P1/P2/P4
remain active whole-phase owners; P3/P5/P6/P7/P8/P9 wait for slots. No tests/builds/typechecks/
audits/probes have run under the implementation-first hold. V1 remains PARTIAL / NOT RELEASED.

## 2026-10-19 19:30 UTC — child-profile selection integration finding

`TaskTool` source was selecting by profile ID or display name and silently taking the highest
enabled revision. Core `AgentProfileService` had no explicit selector mapping, contrary to
§12/§29. The resolved Core Config contract is `agent_profile_selectors: [{selector, profileId,
revision}]` in global user-owned `opencode.json`/`.jsonc` only; project config cannot override
it. Each selector names one exact immutable enabled profile revision. Names are not implicit
aliases; duplicate/conflicting/stale/wrong-owner mappings deny; revisions require deliberate
retargeting; existing Sessions resume their exact pins. P2 owns the Core mapping and direct/managed
integration; VEO-017 covers the failure/recovery matrix. P1 has drafted typed `execution.v1`
`protocol_op`/`protocol_read` operations with method allowlists, bounded payload/event replay,
scope fencing and UNKNOWN recovery; Guard dispatch and full selector resolution remain open.
P4 has removed raw LSP stream/process handles and is narrowing the adapter; `didClose` and runtime
wiring remain open. P2 found the direct reservation release gap; source now releases after
durable SUCCEEDED/FAILED/CANCELLED and retains UNKNOWN. Admission-abandon/restart-replay paths
still need reconciliation. Launch effects stay off. No tests/builds/typechecks/audits or
probes ran.
P2 also owns a managed lifecycle mismatch: `managed_control.rs` requires a Succeeded/pending
verification Attempt, but normative §3.22 keeps the same coding Attempt EXECUTING through the
independent verifier and settles it only after evidence. P1's HostKernel lookup already expects
the live Attempt; align reducer/client transitions before enabling verification.
P1/P2/P4 remain the three active whole-phase owners; remaining phases await slots. P7 is next
in the dispatch queue because its ArtifactStore/verifier evidence work unblocks P2's real
managed vertical; start that whole-phase owner immediately when any slot opens.

## 2026-10-19 19:22 UTC — launch-profile integration blocker

The user confirmed existing trusted Core Config as the immutable launch-profile source
projected to HostKernel and executed through the existing single ExecutionHost supervisor.
P1/P2/P4 remain active whole-phase owners in all three available child slots; P3/P5/P6/P7/P8/P9
remain queued. No validation commands run before source implementation closes.

Parent source review found that the approved launch profile contract uses `executableSelector`
in §12.20 and the strict schema, while the current Rust decoder still expects an absolute
`executable` path. HostKernel must resolve the trusted selector; caller paths cannot authorize
process execution. The strict schema also lacks the `HostProcessRefV1` definition already
carried in Rust/TypeScript and §12.9. P1 owns the decoder/resolver/schema/process-ref/receipt
alignment. Verifier profiles require an immutable positive revision with no legacy default;
the exact revision is included in host-verified digest and receipt pins. Keep process launch,
verifier dispatch, DAP debuggee effects and REPL gated until the required Guard, confinement,
process-ref and resource evidence passes. Overall V1 remains PARTIAL / NOT RELEASED.

## 2026-10-19 19:09 UTC — active whole-phase implementation roster

The user resumed the full V1 objective after the prior stop-all-agents checkpoint. Three
implementation slots are active: P1 Guard/ExecutionHost (`p1_guard_full_resume`), P2 managed
vertical and direct Task AgentProfileV2 migration (`p2_managed_wave2_1019`), and P4
LSP/DAP/REPL (`p4_lsp_dap_repl_wave2_1019`). P1 owns Rust Guard/protocol/HostKernel/process
source; P2 owns TaskTool/Core profile projection, `managed_control.rs`, Goal/review/TUI but not
P1-owned protocol/HostKernel; P4 owns only LSP/DAP/REPL package paths. P3/P5/P6/P7/P8/P9 are queued and
will take slots as they open. Parent retains cross-phase integration, final evidence and
tracker ownership.

The user's implementation-first hold overrides validation cadence: no tests, builds,
typechecks, audits, provider probes or performance runs until all requested V1 source
implementation is complete. No phase is promoted by this roster. Preserve the shared mixed
tree. Current Git MCP snapshot: `main` at `6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12
ahead / 0 behind, 150 staged, 228 unstaged, 171 untracked, no conflicts; one worktree. C:
`/mnt/c` has 60 GB free (87% used); `node_modules` is 2.5 GB. No verification or Git mutation
was performed at dispatch.

**Maintainer:** the main implementation agent owns every status change and the integrated evidence record. Subagents may implement bounded modules and report evidence; they do not independently mark this tracker complete.

**Snapshot:** 2026-10-18, local `main` at `6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 commits ahead / 0 behind `origin/main`. At the stop-for-today checkpoint, the shared tree had 150 staged paths (69 added, 81 modified), 63 unstaged modified paths, 10 untracked paths, one worktree and no conflicts. Preserve all existing changes. The 2026-10-16 snapshot at `9b667a32fa5dab80f297178e3a9da66ef8c3aeea` is superseded. This document records the requested V1 scope and implementation queue. `arch_V1/` remains architecture authority; `HANDOFF.md` remains the concise record of observed implementation status and exact verification. This tracker never promotes a feature based on a plan, schema, source survey, UI control, mock, or subagent's unverified claim.

## Current reconciliation — 2026-10-19 19:09 UTC (supersedes historical roster snapshots)

The user resumed full V1 implementation; the three available child slots are occupied by the
whole-phase owners listed above. Continue as parent integrator; fill slots immediately when a
phase owner completes. Git is on `main`, 12 commits ahead of
`origin/main`, with broad staged/unstaged/untracked changes; preserve mixed ownership.
`/mnt/c` had 60 GB free at the latest check. No tests, builds, typechecks, audits or provider
probes are to run until the user releases the implementation-first hold.

Direct child authority is resolved to Core Config's immutable `AgentProfileV2` revision for
both direct and managed children. `TaskTool.subagent_type` is a stable selector only; legacy
Agent settings cannot drive execution under a V2 digest. P1 adds HostKernel profile validation
and canonical BLAKE3 pinning; P2 updates Core/Task and durable direct Attempt consumers. User
also approved existing trusted Core Config→HostKernel launch-profile projection for P4 through
the single ExecutionHost supervisor; no duplicate runtime/registry is permitted. Project,
plugin and external launch definitions remain unavailable until trust resolution exists.
Relevant normative owners §§14/17/20/32/37 and derived atlas §45 were updated. P4's LSP/DAP/REPL
independent corrections are in progress. Implementation-first hold is unchanged; source/tests
may be edited but not executed until implementation closes.

The user resolved two pending policies: one lane-tagged `SubagentDeliveryV1` binds either
trusted direct Core parent/profile scope or managed `DelegationBindingV1`/Attempt scope;
`authorityDigest` is domain-separated BLAKE3 over canonical MessagePack
`["SubagentDeliveryV1.authority", lane, parentExecutionId, childExecutionId, ownerEpoch,
authority]` and never itself grants authority. OS CPU/memory/process-count/FD guarantees remain unavailable
until enforced by the OS; only honestly bounded admission/monitoring may be used meanwhile.
Architecture §§03/04/10/11/12/14/15/17/29/32/37/42/45 and the machine schema now reflect
these choices. A strict TypeScript envelope decoder is added at
`packages/schema/src/subagent-delivery-v1.ts`; Rust performs strict lane validation and
authority-digest recomputation. Core TaskTool now persists direct envelopes bound to the
admitted DirectAttempt/profile/permission scope and managed envelopes bound to the Rust
handoff/consume receipt. Both lanes persist acknowledgment only after prompt return; direct
resume refuses an unacknowledged delivery, and managed recovery requires an acknowledged
envelope plus the returned-child marker. Shared golden fixtures and runtime lifecycle source
are present, but tests/typechecks/real acceptance have not run under the implementation-first
hold; neither lane is VERIFIED. The event model tags child progress by lane and keeps
web-search route attempts redacted, bounded projections that never replay by re-dispatching.

For P5, auth status 401/403/407 now records a route failure and falls through only to the
next explicitly enabled/configured route; other non-rate-limit 4xx still stop. The broker
source and its existing focused regression were updated, but nothing was run. The production
search tool still has `WEB_SEARCH_GUARD_READY=false`; guarded transport/composition,
SecretBroker wiring, provider coverage and acceptance remain open. P1–P9, final integration,
verification and release remain PARTIAL / NOT RELEASED.

Current-source clarification for P2: distinct reviewer assignment/decision is source-wired
through Core `ServerAuth` middleware, the authenticated private Core→HostKernel request
envelope, and Rust's durable `assign_spec_reviewer`/decision checks. This supersedes the older
table text that says the production reviewer channel is absent. Real-socket positive,
forged-body denial and distinct reviewer acceptance evidence still must be run on the final
integrated revision after the implementation hold ends; do not mark the reviewer journey
TESTED or VERIFIED yet.

### 2026-10-19 source delta — SubagentDeliveryV1 Rust parity

The parent added a Rust envelope decoder with exact-key/lane validation, bounded field and
counter checks, strict UTC timestamp validation, and owner-recomputed BLAKE3 authority
digest. It is not connected to an RPC or Task lifecycle and cannot authorize dispatch. No
tests/builds/typechecks/audits were run. Remaining: shared golden fixtures and cross-language
tests, Core/Rust lifecycle integration, authenticated owner/live Attempt resolution, then
integrated verification after the implementation-first hold is released.

## Active implementation wave — 2026-10-17

The parent owns cross-phase integration, evidence review, tracker/HANDOFF updates, final gates, and any publication decision. Eight whole-phase owners are active in the shared checkout with disjoint source/test paths (all resumed as fresh owner sessions on 2026-10-17 after the provider usage limit interrupted the prior owner sessions; all prior in-flight edits were preserved). No agent may stage, commit, push, edit status/architecture documents, or enable an effect whose Guard prerequisite is unverified. P5 browser/desktop remains deferred under A-V2-31; built-in web search was promoted into V1 on 2026-10-18 (`DEC-V1-26`). P2 effectful execution depends on P1.3 verification; P8 worker fan-out depends on the integrated P2 single Attempt and independent verifier. Second wave (2026-10-17): the returned P1.3/P3/P4/P6+S1/P9 packages were parent-verified on the current tree (exact suites in the table); `.gitignore` overlay exceptions were added for `kernel/tests/tool_batch_guard_matrix.rs`, `indexd/tests/persistence.rs`, `indexd/tests/watch.rs`, and `packages/tui/src/util/provider-origin.ts` (visibility audit exit 0, `hidden_new_source=0`). A dedicated provider workstream (P6-OP) implemented the user-directed free-model access under the `opencode` provider; the parent then closed the last-mile `User-Agent` version fix after live gateway bisection — **HorizonCode direct-mode requests are now accepted by the free-tier gateway (accepted-but-quota-bound until the daily reset)**. The P2-RPC owner delivered the `managed.v1` kernel RPC and the Goal-review dialog mount (209/0 kernel suites, 9/0 TUI). Third wave (same day): five fresh owners launched for the remaining V1 scope — C15 plan-ingress + Task/Attempt binding (`ses_eb68211b4ffe3yi2BdtHw49pHt`), Guard effects C20 multi-call + LSP/DAP/REPL enablement (`ses_eb68211afffepYJNIbMfPgre8W`), P7 stream/artifacts/automation completion (`ses_eb68211a9ffeXW0QChLfro779s`), P8 worker/DAG/resources/JC-RES (`ses_eb68211a6ffekmvWcnPNrWKAbD`), and P3 indexd transport primitives (`ses_eb6821143ffeYxA8zGDBw1UVWL`). Queued: the P3 kernel bridge (behind the C15 owner's `host_kernel.rs`), P9 candidate-build/clean-install evidence, and the user-decision release items (license/notice, signing/update policy, push authorization). Free-model coding-task evidence runs after the daily quota resets (~00:00 UTC). Pending integration check: the static `CODE-001` convergence markers must be re-verified against the Guard owner's refactored `effect_host.rs` at its handoff — if the write-admission invariant (exact `files.write` capability id + `Ask` decision gate) survives, the parent updates the validator's expected expressions; if not, the owner repairs it.

| Phase | Owner/agent | Write scope / revision | Independent work running | Blocked work and prerequisite | Tests/evidence | State | Next action |
|---|---|---|---|---|---|---|---|
| P1.3 | `ses_eb74e563effeiqyGHPZXHT2hSp` | Guard/EffectHost/HostKernel; Core registry, SessionSupervisor and PTY; OpenCode shell/prompt/task plus plugin/MCP/legacy effect seams as needed; base `6c8c5ab9a` | C13–C21 origin closure and enabled-origin adversarial matrix | Any origin lacking tested pre-dispatch Guard must remain unavailable | Parent spot-verified on current tree: `tool_batch_guard_matrix` 6/6, `effects_host_process` 9/9, `host_terminal_process` 2/2, `effect_host_principal` 11/11, `hz_kernel_process` 2/2; parent also aligned the committed `apply_patch.test.ts` denial-message expectation with P1's Guard source wording (`guarded operation set or lease changed`). Reproduced `cd packages/core && bun test test/session-runner.test.ts` → 91 pass / 2 fail / 298 assertions: failures at lines 716 and 809 expect synthetic `registry.register({ write: Tool.make({ capability: files.write }) })` fixtures to reach Rust Guard. The registry omits these non-provenance `write` tools from materialization, so the synthetic provider calls fail validation as unknown and `SessionRunnerLLM` skips `prepareToolBatch`; `effectBatches` remains empty. Keep the production gate unchanged; P1 owner should repair/retarget these fixtures. C15 (Task/subagent) and C20 (multi-call ToolBatch) remain fail-closed pending the authenticated managed-control RPC and the Core tool-batch consumer | PARTIALLY_BLOCKED | Preserve fail-closed C15/C20 until prerequisites land; P2/P4/P7/P8 gated items release on the managed-control RPC |
| P2 | C15/P2 owner `ses_eb68211b4ffe3yi2BdtHw49pHt` + P2-RPC `ses_eb6f21838ffemMGjlhvXQvweqM` | Managed control state/tests and `managed.v1` HostKernel ingress; base `6c8c5ab9a` | Plan-ingress and settlement/verifier source work continues; effectful executor/scheduler remains disabled | Production approval identity, Attempt-bound EffectIntent/lease, actual workspace-revision evidence, authenticated independent verifier adapter/evidence, and Core→TUI delivery remain unproven | Prior P2-RPC evidence: 209 pass / 0 fail plus TUI 9/0 (not rerun against the latest C15 delta). Parent source review: production `hz-kernel` derives only `host_os_uid:{peer.uid}`; real-socket self-approval is denied and no positive distinct user-reviewer/verifier channel is wired. Current `managed_settle` can bind a same-principal/session settled effect without an Attempt-issued intent; `final_revision_digest` hashes managed receipt references, not the live workspace; `verify_task` accepts no actual verifier verdict/artifact/test evidence. Parent separately fixed the TUI mount's false `{available:true}` claim; focused Goal-review tests now pass 8/8 (44 assertions) and TUI typecheck is clean, but Core→TUI proposal delivery remains absent. These are blockers, not VERIFIED paths | PARTIALLY_BLOCKED | Keep success/finalization fail-closed until the real authenticated reviewer, Attempt-to-effect authorization, workspace revision and independent evidence contracts pass real-boundary tests; continue independent client/plan work |
| P3 | Fresh continuation `ses_eb5c8750effemMX5TknS2W9BKz` (+ completed indexd crate owner `ses_eb6821143ffeYxA8zGDBw1UVWL`) | RepoIntel/indexd and corresponding OpenCode adapter/tests; base `6c8c5ab9a` | Independent TypeScript adapter/fake-transport tests resume; production RepoIntel remains typed unavailable | HostKernel integration must remain embedded/rebuildable under §30.10, not a new `hz-indexd` daemon. The crate's max build frame is 72,351,786 bytes; README single-RPC Base64 would be ~96.5 MB, exceeding the kernel's 6 MiB RPC body cap. A bounded authenticated in-process/chunk contract and real integration tests are not wired | Historical parent-verified evidence (not rerun after latest dirty-tree changes): indexd `cargo test --offline --locked` 97/0; RepoIntel 29/29, artifact-search 16/16; `bun test test/tool` 311/0 and tsgo clean. Latest continuation made no edits/tests and reported the bridge mismatch; it is now implementing only independently runnable TS adapter/tests | PARTIALLY_BLOCKED | Keep production adapter unavailable; finish the fake-transport contract, coordinate an embedded bounded HostKernel/indexd API, and prove actual generation/read-scope/cancel/recovery behavior before wiring |
| P4 | `ses_eb74e562dffej5CUdneAUx8k6I` (current continuation `ses_eb4ea55beffelFV6p02FxIUts3`) | HorizonCode CLI-host package LSP/DAP/REPL protocol/runtime modules and tests; base `6c8c5ab9a` | Added LSP generation query pins and abort settlement, DAP malformed-header/cross-session restart negatives, and REPL start validation before generation allocation plus cross-owner output-ref coverage | Spawn/install/attach/evaluate/callback effects remain disabled until parent verifies P1 | Parent rerun on Linux/WSL: `cd packages/opencode && bun test --timeout 30000 test/lsp test/dap test/repl` → 185 pass / 0 fail / 623 expectations. Owner reports `cd packages/opencode && bun run typecheck` emitted no diagnostics and scoped diff checks were clean; parent has not rerun typecheck on this delta | PARTIALLY_BLOCKED | Keep production LSP clients unregistered and all process/evaluate/callback paths unavailable until P1 Guard, trusted executable resolution, and OS confinement are verified; resume P4 for remaining independently runnable module work |
| P6 + S1 | `ses_eb74dc450ffeOizyVhTPlv9rnp` (+ P6-OP `ses_eb701e22fffeSEDbrBbHU3Pl6f`) | Provider/model/config and TUI settings/question implementation files; base `6c8c5ab9a` | Complete (settings/questions + provider free-model enablement) | Real 200 acceptance + free-model coding-task runs pending the daily quota reset (~00:00 UTC); no provider call or retry until then | Parent rerun `bun test --timeout 30000` on the 8-file acceptance set → 43 pass / 0 fail / 132 expect; `tsgo --noEmit` clean; `app.tsx` provider settings verified; P6-OP: keyless free-only `opencode` provider (`isFreeModel`, explicit-zero-cost only, AN-002), `apiKey "public"`, honest 429/403 surfacing (no retry, Retry-After), focused 13/13, full `test/provider` 752 pass / 6 fail A/B-verified pre-existing; parent added the source-run UA version fix (`session/llm/user-agent.ts`, regression test) — **fork requests accepted by the free-tier gateway live (quota-bound 429)**. Parent added S1 canonical wiring: `question.ask` registry (`control`, `code_present`), §33 catalog/status, §32 `QA-001..004`, §12.13 schema owner, and the tool capability declaration; `test/tool/question.test.ts` 2/2. Fresh question/notification rerun on this dirty tree: OpenCode live question route + tool 4/4 (23 assertions); TUI question/notification/settings 15/15 (70 assertions); no remaining focused V2 notification or live-route failure | PARTIALLY_BLOCKED | Remaining provider 200/coding-task evidence is quota-gated; retain PARTIAL until final integrated-tree verification. Broader P6 Doctor and SDK/steering gaps remain listed below |
| P7 | `ses_eb74dc44fffey0kti7XfaqtXrk` (current continuation `ses_eb4ea477cfferUPmzt4e6bZocg`) | TUI stream/artifact renderer and isolated Rust artifact/automation modules/tests; base `6c8c5ab9a` | Non-power-of-two capture-budget defect reproduced (16 B allocated for a 9 B budget) and repaired to a single exact-capacity buffer; mux `directDeliveries` observed metric added; sealed-snapshot digest binding verified; current owner resumed. User approved the real central-pane activity stream with compact safe/redacted argument previews by default and expandable full output; P7 is implementing it after serializing its current P7 work | Production replay/resnapshot needs sequence+sourceGeneration in the core stream envelope; automation invocation/effectful artifacts gated on parent-verified P1; artifact store has no production owner | Prior owner + parent rerun: `--lib artifact_store` 33/33 (pre-fix 32/1 at line 1516); `--lib automation` 9/9; whole `--lib` 150/150; TUI mux/data-stream/artifact-render 39 pass / 115 expects; packages/tui `tsgo --noEmit` clean; fmt + whitespace clean. Path-swap-after-first-chunk serves the sealed snapshot; symlinked shard rejected. No new resumed-P7 evidence parent-verified yet. | PARTIALLY_BLOCKED | Continue independent stream/artifact/analytics/automation scope and implement approved activity presentation using the canonical stream; replay still needs core sequence+sourceGeneration, and effects remain gated on P1/P2 |
| P8 | `ses_eb74dc44effex95R7Yj4ZR8zL7` (latest continuation `ses_eb4ea3906ffeV3axR6J4Jg29G3`) | Resource budget/sampler, RC0 harness, isolated worktree-pool modules/tests; base `6c8c5ab9a` | RC0 parent-edge attribution race fixed with expected parent PID/start identity checks before and after counters; four contract regressions await the serialized Rust test slot | Worker/DAG fan-out requires P2 verified Attempt; `WorkerPoolControl::apply/update_capacity` public owner/telemetry boundary needs P2 authenticated-ingress coordination; live 1/5/10/20 capture needs valid Session identities/outcomes and trusted attestation; no provider call authorized | Parent reran `python3 -m unittest test_rc0 -v` → 47/47; `python3 -m py_compile rc0.py test_rc0.py` passed on Linux/WSL2. Red/green reparenting and parent-generation-reuse tests are included. Existing resource/worktree evidence remains: `--lib resource_budget` 24/24; `--test worktree_pool` 39/39; `--test resource_sampler` 12/12. Four added Rust tests cover sampler parent-edge reparenting, durable capacity/replay revision consistency, full task-criterion coverage, and sibling-Attempt lease recovery; `rustfmt --edition 2024 --check` is reported clean, but all four Rust tests remain UNRUN behind P1's Cargo slot. `rc0.py --selfcheck` measures only its own bounded tree, not a product baseline. No raw product baseline artifact. | PARTIALLY_BLOCKED | After P1 releases the Cargo slot, run the four Rust regressions RED and repair production/test code; coordinate `WorkerPoolControl` authority with P2; no fan-out or product baseline until P2 Attempt/verifier and trusted Session attestation pass |
| P9 | `ses_eb74dc440ffeH1pcWSbZzhoFI2` (latest continuation `ses_eb4ea22feffeUap4qJxFOPUukA`) | `scripts/release/**` audit and clean-install harness/tests; base `6c8c5ab9a` | Candidate path/signaling checks complete; clean-source candidate qualification cannot proceed while first-party package/launcher paths remain hidden | License/notice decision, signing, candidate product binary, final P1/P2/CI/platform evidence and publication remain blocked; exact hidden-path visibility changes are parent-owned under A4 and will wait for the P6 `.gitignore` write to settle | Prior owner evidence: release-readiness 46/46; TUI shutdown 4/4 after fixture alignment. Latest owner run: release gate `BLOCKED (20 blockers)`, install matrix `NOT_RUN`, no signature/publication. Owner overlay audit at its checkpoint reported 3 hidden P9 changes plus 4 Provider Doctor paths owned by P6. A later parent audit after the P6 additions reported `compared=6627 changed=238 missing=0 symlink_delta=0 hidden_changed=3 hidden_new_source=1 stale_unignore=0`; P6's four Doctor paths no longer appeared. Remaining hidden changed paths are `install`, `packages/opencode/package.json`, and `packages/opencode/bin/opencode`; the new hidden P7 test is `packages/tui/test/util/transcript-window.test.ts`. Do not overlap the active P6 `.gitignore` edit; after it settles, add only reviewed exact first-party exceptions and rerun the audit. | PARTIALLY_BLOCKED | Keep release/install/signing gates blocked; after P6 completes `.gitignore` work, expose exact reviewed P9 paths under A4 and the P7 test path if its owner confirms it is intentional; rerun release gate on final integrated revision |
| Integrated coding journey | Parent | Isolated task fixture plus existing real Core→Rust boundary; exact integrated revision required | Discover → inspect → scoped multi-file edit → authorized build/test → diagnose/fix → retest → final-revision independent verification | Live provider/model and paid-call consent are unspecified; no credential use, fallback, or paid inference. P2 effects also wait for P1.3. | Must cover §32 RD-001/005/009/010, CC-004/005/006/007/008, BT-001/003/006/007, GS-001/006/008/009, LH-005/008/010, zero-effect denial, and final overlay verification | ACTIVE | Prepare a no-network deterministic harness if useful; run the selected-provider journey only after authorization and phase integration |
| P0/A1–A4 | Parent | Integration/status docs and final gates only | Reconcile this tracker, review phase diffs, verify final head, run integrated gate | Push/publication not authorized by this implementation request; no bypass of gates | Latest reported push-gate attempt passed selected checks; final full gate/CI and remote publication remain unconfirmed | ACTIVE | Reconcile exact phase evidence, rerun final gates after integration, ask before publication if needed |

### Current execution ledger — resumed after user request (2026-10-18)

The user directed implementation/acceptance to continue across the remaining V1 phases after the tool-usage limit reset. The recorded whole-phase owner sessions were resumed: P1.3 `ses_eb4ead3d5ffeRPhH6sBFf5yh4m`; P2 `ses_eb4ea6f76ffeWOqS08OuA9sNF5`; P3 `ses_eb5c8750effemMX5TknS2W9BKz`; P4 `ses_eb4ea55beffelFV6p02FxIUts3`; P6/S1 `ses_eb4ea9ac3ffeWjhEt6icLS9lu8`; P7 `ses_eb4ea477cfferUPmzt4e6bZocg`; P8 `ses_eb4ea3906ffeV3axR6J4Jg29G3`; P9 `ses_eb4ea22feffeUap4qJxFOPUukA`. Parent has since verified P4's focused LSP/DAP/REPL suite (185/0) and P8's RC0 Python suite (47/0) plus py_compile; no whole phase is VERIFIED. P5 remains excluded/deferred under A-V2-31. Parent took exclusive ownership of `packages/tui/src/app.tsx`, `packages/tui/src/component/dialog-goal-review.tsx`, and its focused test to correct the Goal-review availability projection; P2 continues in non-overlapping managed-control/RPC/client paths. The user approved short safe/redacted tool-argument previews with expandable output for the live P7 central-pane stream. Only P1 has the initial shared Cargo/kernel build slot; other Rust-heavy owners must wait for its release.

Write ownership is phase-local in the dispatched briefs. Parent owns cross-phase integration, `kernel/src/lib.rs` module exports, `packages/tui/src/app.tsx` shared mounting, this tracker/HANDOFF/CURRENT_RUN, and final verification. HostKernel changes are P2-owned until a serialized handoff; P3 must not edit those files without parent approval. Only one shared Cargo build/test wave may run at a time. P2 effectful dispatch, P4 process/runtime effects, P7 artifact/automation effects, and P8 worker fan-out remain disabled pending verified prerequisites. P6 free-model 200/coding-task evidence waits for the already-exhausted zero-priced quota; no paid fallback or retry. P9 may not invent a distribution license or signing trust root.

P2's prior slot returned `PHASE_PARTIAL`. Parent has now changed the app mount to use the authoritative reviewer-channel projection instead of claiming `{ available: true }`; `cd packages/tui && bun test test/component/dialog-goal-review.test.tsx` passed 8/8 (44 assertions), and `cd packages/tui && bun run typecheck` exited 0. This does not connect Core→TUI proposal delivery: `pendingGoalReview()` still returns `undefined`. The missing authenticated reviewer identity, Attempt-issued effect intent/lease, live workspace revision proof, and independent verifier evidence remain blockers. No phase has been promoted to VERIFIED/RELEASED by this resumption.

This is an orchestration ledger, not a feature-status upgrade. Phase completion requires parent review of exact source and evidence on the integrated revision.

### Resumed wave — 2026-10-18 (user-directed P1+P2 completion push)

The user directed finishing P1 (Guard/ExecutionHost critical path) and P2 (managed control vertical) with maximum safe fan-out. Six workstreams launched with exclusive write scopes; the parent owns integration, `.gitignore`/A4, status docs and final verification.

| Workstream | Session | Exclusive scope | Goal |
|---|---|---|---|
| P1-K Guard/relay | `ses_eb4ead3d5ffeRPhH6sBFf5yh4m` | `kernel/src/{guard,effect_host}.rs` + Guard tests + `packages/core/src/session/{runner/**,supervisor.ts}` + `session-runner*` tests + `packages/opencode/src/session/tool-batch.ts` | C20 multi-call consumer, C21 bounds, C25 matrix, fixture confirm. **ACTIVE 2026-10-19 (re-prompted 15:09:29 UTC after the aborted turn):** mid-flight on the C15 Attempt-binding interface; also patching `packages/core/src/session/supervisor.ts` and `kernel/src/effect_host.rs` (writes through 15:36 UTC); no code loss. Scope includes the C15 Attempt-binding interface routed from P1-ORIG: plumb `attemptID` + child scope digest into `prepareToolBatch` (`tool-batch.ts` ~476–484; provider denial ~402) plus Rust `effects.v2` prepare validation / Attempt-scoped leases. |
| P1-TERM shell/PTY | `ses_eb1026206ffenPuA1w8lTObTOu` | `packages/{opencode/src/tool/shell*,core/src/tool/bash.ts,core/src/pty.ts}`, `kernel/src/terminal*.rs`, `kernel/tests/host_terminal*.rs`, terminal-run-live | C13 guarded bash end-to-end, C14 interpolation, PTY-001..006, TM-001/002, C22. **ACTIVE 2026-10-19:** patching `kernel/src/terminal.rs`, `kernel/tests/host_terminal_process.rs`, `packages/core/src/pty.ts` + pty ticket/shell tests; focused bun pty test running |
| P1-ORIG closure | `ses_eb1026204ffeXD8GATMz0SL2hl` | plugin/mcp/hook/hosted/skill/task/webfetch/websearch files + tests | C16–C18/C10 mediate-or-disable + zero-spawn negatives, C15 fail-closed/Attempt-binding. **Assigned set COMPLETE 2026-10-18:** zero child effects proven (test-only changes to 5 test files); evidence: core 15 pass/0 fail/43 expectations, opencode registry 10/0/35, skill 3/0/20, 6-file batch 9/0/54, tool-batch child 2 pass/49 filtered; findings in Engram (`discovery/p1-orig-*`). Routed: (a) C15 interface → P1-K (see row); (b) unmediated `POST /project/:id/git/init` spawn (`test/server/project-init-git.test.ts`) → P1-K to mediate via Guard or fail-closed disable; (c) `installation.upgrade`/`global upgrade` installer spawn → P9 release-scope inventory. |
| P1-SB sandbox | `ses_eb1026161ffeZoN07PIpvwZ6fC` | new `horizoncode-sandbox/` crate only | bwrap+Landlock backend, capability probe, real confinement tests, DEC-V1-03 evidence seed. **Crate PHASE_VERIFIED 2026-10-18:** 24/24 tests (11 unit + 2 capability + 10 real confinement + 1 doctest), release build clean; capability record and §42 SRC-026 recorded. Parent source audit on 2026-10-19 confirms the sandbox is wired through `HostKernel::prepare_terminal_consent_launch` → `TerminalProcess::prepare_confined` and `prepare_execution` → `StdioExecutionSupervisor::preflight` → `launch`/`StdioProcess::spawn_prepared`. **Source status: WIRED; product containment, denied-origin, invocation-mismatch, cancellation and recovery acceptance remain NOT VERIFIED.** |
| P2-K managed kernel | `ses_eb4ea6f76ffeWOqS08OuA9sNF5` | `kernel/src/{managed_control,host_kernel,protocol,rpc_handshake,unix_peer}.rs` + managed tests | Reviewer identity, Attempt-issued intent/lease, live revision digest, verifier evidence, CAS/replay, faults. **ACTIVE 2026-10-19 (re-prompted 15:09:29 UTC):** implementing receipt-backed `BeginVerification` + typed task-evidence projection in `managed_control.rs`/`host_kernel.rs` (patches through 15:36 UTC); focused `cargo test --lib` managed verification-evidence suite running under the `hz-cargo.lock` lane; no code loss. Real-socket stale-review CAS/replay and fault negatives still pending. |
| P2-TS client/TUI | `ses_eb1026152ffe7T8ECjWnKpDSSN` | managed client `packages/opencode/src/session/managed-control.ts`, TUI goal-review + app.tsx mount, managed tests | Core→TUI proposal delivery, D1–D11 vertical, typecheck diagnostics fix. **COMPLETED 15:21:50 UTC:** managed-control focused suite 36 pass / 0 fail (203 expectations); TUI goal-review inbox test green (8/0); found the websearch dialog crash (repaired in-tree 15:25–15:28); findings routed to P2-K. Slot freed; held vacant for collision avoidance. |

Serialization: `host_kernel.rs`/`managed_control.rs`/`protocol.rs` are P2-K single-writer; `guard.rs`/`effect_host.rs` are P1-K single-writer; one heavyweight Cargo at a time via `flock /tmp/opencode/hz-cargo.lock`. No workstream may stage/commit/push or edit `.gitignore`/status docs. New files (sandbox crate, new tests) get reviewed `.gitignore` exceptions from the parent at integration with the overlay audit.

**Concurrent external writer fleet 2026-10-19 (deconfliction, 15:41 UTC):** a Codex-based orchestration (codex-tui; session fork `01a14f8d…`) edits this same checkout in parallel and maintains its own entries above (15:24/15:34). Active Codex owners: P8 rollout `14:47-53` (kernel `worker_*`/`worktree_lifecycle`/perf scripts), P7 `15:13-56` (TUI/session-event/artifact surfaces), P6/S1 `15:13-52` (provider/doctor/question/dialogs), P4 `15:34-50` (LSP/DAP/REPL paths — disjoint from OpenCode owners), P5 `10:53-04`/`14:59-27` (websearch; dialog fix landed 15:25–15:28), and two Codex P1/P2 owners started 15:34:40/46 — Codex P1 already patching `kernel/src/host_kernel.rs` + `kernel/src/bin/hz-kernel.rs` concurrently with P2-K. Kernel P1/P2 ownership arbitration is being raised to the user (15:41); recommendation: OpenCode keeps P1/P2 (mid-flight context + running tests), Codex keeps P4–P8. Until resolved, do not add further writers to kernel paths; adapt rather than revert unfamiliar changes. Check `~/.codex/sessions/2026/10/19/` rollout mtimes before dispatching OpenCode owners into P4–P8 paths; keep one heavyweight Cargo lane.

Same wave, user-directed addition: **built-in web search promoted into V1 (`DEC-V1-26`)**. The parent completed the design/flip pass (§§17/01/10/14/15/16/32/33/37 + plan + tracker + HANDOFF). Competitor/provider research **completed** (`ses_eb0f9b2ffffezHOzBuXOa24mCr`): recommended built-in keyless chain Exa → You.com → Tavily → Firecrawl → Parallel → TinyFish; BYO-key set Exa/Tavily/Brave/Parallel/You.com/Firecrawl (tier 2 Kagi/Jina/Linkup/Serper); Google CSE/Bing/DuckDuckGo excluded; SearXNG deferred post-V1; 429-only failover with Retry-After cooldown; no auto keyless→paid upgrade. Matrix seed recorded in §37.5. Tool-suite upgrade study **COMPLETED 2026-10-19** (`ses_eb0f9b2feffenUlOx0xj08Ni79`): 19-row candidate→§33 catalog mapping, 7 design-reserved candidate IDs not registered (`browser.find/dialog/upload/tabs`, `repo.wiki.structure/read/ask`), licenses recorded (Desktop Commander MIT, Playwright MCP Apache-2.0, Context7 MIT; DeepWiki hosted/no-source; none yet pinned in `arch_V1/42`); open item: `packages/opencode/src/tool/edit.ts` declares no `capability` while `packages/opencode/src/session/tools.ts:99-108` withholds unknown-effect tools — confirm the intended canonical binding at resume. The implementation workstream (P5-WS) is now ungated (design pass done 2026-10-18; P1-ORIG freed `packages/opencode/src/tool/websearch.ts`); dispatch pends an implementer slot (free-tier quota). The pinned OMP `web/search` source (`repo_take/oh-my-pi`, §42 SRC-007) is the adaptation target. No web-search runtime status is claimed. Parent added the derived V1 event/flow atlas `arch_V1/45-V1-EVENT-FLOWS-ATLAS.md` (non-normative synthesis; full document coverage matrix; README derived-navigation pointer; audits green).

**Environment incident 2026-10-19 (hosting OpenCode server):** 32 `serve --service` starts across Oct 17–19 in the server log with zero crash/panic/OOM entries (server or kernel); P1 and P2 owner continuations aborted during server-start session drain with `AI.Error.QuotaExceeded: The usage limit has been reached` (provider usage limit); both were re-prompted at 15:09:29 UTC with the implementation-first direction restated, and the P1 terminal/shell and P2 client/TUI sessions auto-resumed at 15:03:06 — all four owner sessions were actively mid-turn by 15:15 UTC. No code or evidence lost; P1-ORIG, P1-SB, atlas and WS-TOOLRES deliverables unaffected; parent-side ledger/verification continues. Server lifecycle is CLI/app-driven (repeated `background service starting reason=missing`, one explicit `opencode service restart`, one client `Timed out waiting for the background service`, `watcher stopped`→restart cycles ~1 s apart) with 11 client `Event stream stalled` disconnects; no crash/panic/OOM signatures.

## Stop-for-today checkpoint — 2026-10-18

The user requested a pause for today. This checkpoint supersedes stale `ACTIVE`/`PARTIALLY_BLOCKED` labels above only for orchestration state; no feature status changes. Stop requests were sent to P1/P2/P3/P4/P6/P7/P8. All seven returned final checkpoints; P9 had already returned PARTIAL. Recheck actual sessions at restart; the registered OpenCode tool inventory has no child-session status endpoint.

| Phase | Pause state / last evidence | Remaining and first resume action |
|---|---|---|
| P1.3 | `PARTIAL_INTERRUPTED`; owner reports Core runner **93 passed / 0 failed / 308 assertions** and write/registry **27/0 / 71 assertions**. Synthetic untrusted-write fixtures now use provenance-backed WriteTool; production gate unchanged. | C13/C14 real shell/interpolation; C15 Attempt-bound child effects; C16–C18/C10 origin closure; C20/C21 multi-call HostKernel relay and complete lease/receipt/UNKNOWN/cancel/restart negatives; native Windows. Re-run integrated tests. |
| P2 | `PARTIAL_INTERRUPTED`; managed-control client **14 passed / 61 expectations**; typecheck exited 2 on three `test/session/tools.test.ts` diagnostics (81/155/166). | Authenticated reviewer, Attempt-issued effect intent/lease, live workspace revision, independent verifier, Core→TUI delivery. Keep effects/finalization disabled. Coordinate authenticated worker-control ingress; after Rust slot release run real-socket stale-review CAS/replay tests. |
| P3 | `PARTIAL_INTERRUPTED`; no edits/tests in final continuation. Prior RepoIntel report **44 passed / 342 expectations**, not rerun. | Authenticated bounded HostKernel `indexd.v1` bridge; ~72 MB frame exceeds 6 MiB RPC cap. No second daemon or unapproved HostKernel edit. Agree chunk/staging, digest/offset/scope, cancel/restart/expiry cleanup with P2. Keep production symbol/reference unavailable. |
| P4 | `PARTIAL_INTERRUPTED`; LSP client **13 passed** and full `test/lsp test/dap test/repl` **197 passed / 0 failed / 653 expectations**. Typecheck timed out at 240s. | Inspect two-file diff and rerun typecheck. Production LSP/editor ingress, guarded start/install/code actions, DAP attach/evaluate and isolated REPL/callback stay unavailable until P1, trusted executable resolution and OS confinement pass. |
| P5 | Web search promoted to V1 (`DEC-V1-26`, 2026-10-18); browser/desktop remain deferred by A-V2-31. | Web search: built-in default route + BYO-key provider cascade, settings (§16.7), provenance (§37.5), tests (§32); browser/desktop stay unavailable. |
| P6 + S1 | `PARTIAL_INTERRUPTED`; earlier parent verification: settings/questions **43 passed / 132 expectations**, live question route/tool **4/4 / 23 assertions**, TUI question/notifications/settings **15/15 / 70 assertions**. Free provider request is accepted but quota-bound by 429. Owner reports Doctor schema/projector **4/18 assertions**, MCP/index/HTTP **6/46 assertions**; latest S1 test edit unverified. | Wait for reset before authorized free-model 200/coding-task proof; no paid fallback/retry. Doctor offline route/TUI absent; complete S1 projection/filter/callback/ToolBatch plus spoof/mixed-effect denials. P2 Guard/broker gates process/network readiness. `.gitignore` not released; parent owns A4. |
| P7 | `PARTIAL_INTERRUPTED`; helper test **7 passed / 35 assertions**. `activity-stream.tsx`/test are not route-wired or rerun; raw args and `ReasoningPart` body can still render. No real TUI journey. | Wire canonical ordered Session parts; suppress private reasoning; redact all tool renderers; enforce aggregate node/key/collection/output budgets; test ordering/status/expand/focus/scroll. `.gitignore:6:*` hides activity-stream component/test and `test/util/transcript-window.test.ts`. Replay/sourceGeneration, 10K history, artifact truth, analytics, automation and terminal graphics remain open; effects stay fail-closed. |
| P8 | `PARTIAL_INTERRUPTED`; RC0 full-ancestry regression red-green; Python suite **48 passed**, `py_compile` passed on Linux/WSL2. | Four Rust regressions unrun: sampler reparent after enumeration; durable capacity/replay revision; all-task criterion coverage; sibling Attempt lease recovery. Run only after unrelated Cargo exits and P1 releases slot. WorkerPoolControl owner scope/raw telemetry needs authenticated P2 ingress and trusted sampler proof. No eligible 1/5/10/20 baseline; no fan-out before P2. |
| P9 | `PARTIAL / BLOCKED`; readiness **46/46**; release gate **BLOCKED, 20 blockers**, install matrix `NOT_RUN`. | A4/candidate inputs, license/notices, real clean install/migration, final integrated CI/platform evidence. Last completed overlay audit before timeout showed 3 hidden changed paths + 1 hidden new source; known P9 hidden paths: `install`, `packages/opencode/package.json`, `packages/opencode/bin/opencode`. No product install, legal/signing decision, publication or cleanup. |

**User decision implemented 2026-10-18 (same-day follow-up):** both `horizoncode` (canonical) and `hzcode` (short command) start the same CLI entrypoint and runtime. A-V2-27 amended; root `AGENTS.md`, the operative plan and `arch_V1/10-DELIVERY.md` reconciled; `packages/opencode/package.json` bin map and `install` provision both names. Verified: sandboxed installer installs and runs both commands; both npm-bin shims spawn the same wrapper; real CLI starts (`bun run ./src/index.ts --version`, exit 0); overlay audit `hidden_changed=0 hidden_new_source=0 stale_unignore=0`. Broad package/build renaming remains the staged post-V1 migration; release-artifact renaming not done.

**Stop-time environment:** local `main@6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind, one worktree; 150 staged paths, 63 unstaged modified, 10 untracked, no conflicts. Unrelated user-owned LiteCowork Cargo test (`storage-sqlite`, PID 143392) was active; do not interrupt or start an equivalent Rust build. No HorizonCode test/build process remained at the final check. `df` showed 825 GB free; `kernel/target` 3.0 GB, `indexd/target` 207 MB; root `node_modules` sizing timed out, last successful size 2.5 GB. No worktree, commit, push or cleanup occurred.

### Exact next-session order

1. Repeat root bootstrap and Engram reload; inspect Git/worktrees/processes/disk and confirm all owner stop acknowledgments, especially P6 `.gitignore` ownership. Preserve all staged, unstaged and untracked work.
2. Both-command decision — **DONE 2026-10-18**: A-V2-27 (amended), root instructions, plan and `arch_V1/10-DELIVERY.md` reconciled; `packages/opencode/package.json` bin map and `install` provision both `horizoncode` and `hzcode` for the same entrypoint; sandbox installer, npm-bin shim chain and real CLI startup verified; A4 overlay audit now 0 hidden / 0 stale.
3. Continue P1 Guard/ExecutionHost and zero-effect negatives. Do not enable dependent effects before complete-batch/origin/receipt/recovery acceptance.
4. Finish one authenticated P2 managed vertical through independent final-revision verification, including pause/cancel/restart/UNKNOWN and human-edit conflict. No fan-out before it passes.
5. Resume P7 route wiring and rendered ordering/redaction/expand/focus/scroll proof; coordinate P3 bridge with P2; continue P4 client/read-only work until Guard and confinement pass.
6. Finish P6 Doctor offline route/TUI, settings/provider and S1; wait for quota reset before any authorized free-model request. Keep P5 deferred.
7. When unrelated Cargo ends, use one Rust slot: P1 first, then P8's four regressions, then dependent P2/P3 work. RC0 1/5/10/20 needs authentic Session identities and Run-attested outcomes.
8. Complete remaining V1 goals: providers/settings, LSP/DAP/REPL, streaming/artifacts/analytics/automation, resource/worktree pools, worker/DAG after P2, file conflicts, caches/local recall, SDK/import, measured workloads and cross-model suites.
9. Close A1–A4, C13–C21/C25, D1–D11 + D9-min/H7, K1/K2-honest/K5/K6, S1/S3; run integrated coding journey, Guard bypass, cancel/crash/restart/UNKNOWN, typechecks, push/full gates, overlay audit and clean Linux/WSL install/migration. Native Windows stays UNAVAILABLE. Publication needs a passing gate and explicit authorization; only then can V1 be RELEASED. P5 surfaces and broad naming/build migration stay post-V1.

## Explicit remaining work — implementation / verification / tests / real-case acceptance (2026-10-18 ledger)

This is the explicit "what exactly is left" list requested before handover. It complements the status tables below; the tracker statuses stay authoritative for promotion. `[U]` marks user-decision/authorization items. Recommended execution order: P1 → real free-model E2E → P7 → P2 → P8 → P3 → P4 → P6 → P9.

| Phase | Implementation remaining | Verification / tests remaining | Real-case acceptance remaining |
|---|---|---|---|
| **P1 Guard/ExecutionHost/Core** | C14 shell/interpolation pre-dispatch closure; C15 Task/subagent Attempt-bound child effects; C16–C18/C10 plugin/MCP/hook, provider-executed and legacy origin closure; C20/C21 atomic multi-call ToolBatch relay, lease/receipt/UNKNOWN, cancellation/restart; interactive PTY process-tree paths on Linux. | Zero-spawn denial matrix for every enabled origin (C25); over-limit rejection; lease/receipt/UNKNOWN reconciliation; cancel/restart; repair + rerun the two synthetic `session-runner` fixtures (91/2) and `terminal-run-live`. | Approval flow over a real multi-command session in the TUI; kill/crash mid-command → restart reconciliation; native Windows acceptance stays UNAVAILABLE (WSL evidence is not Windows evidence). |
| **P2 managed control** | Authenticated reviewer identity; Attempt-issued EffectIntent/lease; live workspace-revision digest; independent final-revision verifier (verdict/artifact/test evidence); Core→TUI proposal delivery; scheduler/executor enablement after P1.3 passes; fix 3 typecheck diagnostics (`packages/opencode/test/session/llm.test.ts` L822/834/839). | One real managed vertical D1–D11 (SpecVersion → Task/Attempt → Guarded action → receipt/evidence → verifier) + pause/cancel/restart/UNKNOWN + human-edit conflict; real-socket stale-review CAS/replay negatives. | A managed goal on a real repo producing a receipt + independent verification; no fan-out before this passes. |
| **P3 RepoIntel/indexd** | Authenticated bounded `indexd.v1` HostKernel bridge (embedded per §30.10; peer/epoch binding; chunked staging under the 6 MiB RPC cap; offset+digest; cleanup on cancel/disconnect/restart/expiry); model-visible wiring; symbol/reference; persistent invalidation. | Bridge positive/negative tests; restart/expiry cleanup; stale-generation denial; rerun indexd 97/0 + RepoIntel 44/342 after wiring. | Index a real repository; drift-safe structural queries; prove no stale result authorizes a write. |
| **P4 LSP/DAP/REPL** | Supervised server/adapter/interpreter lifecycles behind Guard + trusted executable resolution + OS confinement; LSP code actions/rename through Guard; DAP attach/evaluate policy; REPL callback mediation + idle/crash recovery; fix typecheck diagnostics (`test/session/llm.test.ts` + TUI files). | §32.28 OS acceptance; no-spawn/no-mutation negatives on the real boundary; parent rerun of `test/lsp test/dap test/repl` after wiring. | Real project diagnostics/navigation session; debug attach flow; bounded REPL session with recovery. |
| **P6 providers/settings/Doctor/S1** | Doctor offline route + TUI invocation + tiered live probe (separate consent for spend); settings/provider/model hub precedence FEAT-001..014; OMP-preferred CLI/TUI patterns; remaining S1 projection/denial coverage. | Live free-model streamed request + coding task after quota reset (record latency/cost; no paid fallback); requested/effective/source/locked/unavailable precedence tests; Doctor offline tests. | Keyless free-model run on a real coding task (single attempt, honest 429 handling); provider/model switching journeys in the TUI. |
| **P7 TUI stream/artifacts** | Route-wire the canonical central-pane activity stream; redact raw tool args + `ReasoningPart` body; aggregate bounds/order/expand/focus/scroll; replay needs core sequence+sourceGeneration; artifact/analytics truth; automation invocation gated on P1. | Component tests + rendered TUI journey (cassette); 10K-history focus/scroll; reconnect/replay under load; p50/p95 input/frame latency budget. | Watch a real streaming session under load; expand/redact behavior; resize/narrow-terminal layout. |
| **P8 resources/workers** | Filesystem worktree ops + OwnerLog persistence beyond the in-memory model; durable resource-budget integration + user-visible budget/receipt; worker ingress under authenticated P2 scope; worker runtime + bounded fan-out only after P2 passes. | RC0 eligible baseline (needs authentic Session identities + Run-attested outcomes) at 1/5/10/20 Sessions; leak-slope checks; rerun the four repaired Rust regressions after any future edits. | 10-session measured workload on WSL2 (PSS/RSS/CPU/FD, cold/warm startup, first output); raw artifacts before any "fast/RAM-optimized" claim. |
| **P9 release** | Candidate product build (`prepare_build.py`), secret scan, signing per P9 design. `[U]` root distribution license + notices (K1); signing/update-channel choice; publication authorization. | `release_gate.py` 20 blockers → 0; clean-checkout build; install matrix K5 RUN on native Linux + WSL2; commit-bound CI (needs an authorized commit). | Clean-machine install → configure → run → upgrade; configuration migration. |
| **Cross-cutting** | Keep the direct loop lean (no Guard round-trip for reads); compaction quality; stable prefix/cache (CX-013); edit-apply reliability. | Final integrated markdown audit + convergence + overlay + `git diff --check`; A1/A2 typecheck + push gate; S3 final CI; J4 cross-model task suites. | Integrated coding journey (discover → multi-file edit → authorized test → fix → retest → independent verification) with a real selected provider; Guard-bypass negatives across every enabled origin; cancel/crash/restart/UNKNOWN recovery; measured startup/first-output/tool/TUI-frame budgets. |

**V1 release-critical adaptation order (normative):** `arch_V1/10-DELIVERY.md §10.18`, `DEC-V1-35`, traceability `§32.47` (`V1-ADAPT-001`..`011`). Finish P1–P9 wiring inside existing owners; do not bolt on mgrep/CRG/Windsurf IDE as core RepoIntel.

**Explicitly out of V1 scope (do not build):** web app, desktop app, browser automation/attached-browser control, desktop/computer control (A-V2-31 + product boundary below); native Windows claims; broad package/naming/build migration (`arch_V1/10-DELIVERY.md §10.12`, post-V1); Snapcompact. Built-in web search is no longer in this list — it is V1 per `DEC-V1-26` (2026-10-18). The J4 competitive evaluation remains a separate measured exercise — desk comparison on 2026-10-18 is recorded in `CURRENT_RUN.md` and is not measured evidence.

**Design-package reconciliation items (found by the 2026-10-18 design-level audit, see `CURRENT_RUN.md` §8; research closure + phase ownership same day):**
1. `horizoncode-sandbox` — **[P1].** §14.5 describes the OS-confinement backend (Linux bubblewrap `linux.rs`, macOS Seatbelt, Windows fail-closed `windows.rs`) as a reviewed reference seam, but **no such crate/path exists anywhere in the current tree** (verified: no `.rs` under any sandbox path, no first-party `bubblewrap`/`bwrap` references, no recent deletions). Restore/rebuild it as the P1 confinement backend; evidence = per-kernel containment matrix (`DEC-V1-03`) + denial tests LS-009/DAP-002/REPL-001/PS-003; fail-closed until then. Reference research: pinned local `repos/codex` clone (`codex-rs/linux-sandbox`: bwrap + landlock + proxy lifecycle) — §42 provenance/license review before any adaptation. Consumed by P4 effectful origins, worker pool and MCP server processes.
2. §14's "Windows is the target platform" sentence contradicted A-V2-31 → reconciled in place with an amendment tag (2026-10-18). **Closed.**
3. **HorizonCode as an MCP server — [post-V1, `DEC-V1-23`].** Parity verified 2026-10-18 against the pinned Codex source (`codex-mcp` is client-side; spawned MCP servers run sandboxed) and the current Claude Code CLI reference (no `mcp serve`; its IDE plugin hosts a local MCP server *for* the CLI, not the reverse): neither rival exposes the agent itself as an MCP server; both ship structured headless surfaces instead (Codex `app-server`/`exec-server`; ours `run`/`serve`/future SDK). Server-mode exposure stays an explicit post-V1 candidate; the real parity item is spawned stdio MCP server processes running through P1.3 Guard/ExecutionHost confinement (§14.6).
4. §37.17–21, §33.30 and §29.16–19 remain **proposed/target LLD** by design — ratifying them through the status ladder is part of "till V1", not a defect.
5. §17.4's open capability/platform gates each carry a safe interim behavior; the V1-release-relevant ones map to existing blockers (license `DEC-V1-11`, signing/update `DEC-V1-12`, DAP/REPL matrices `DEC-V1-21/22`, MCP matrix `DEC-V1-15`, SessionLink/ToolBatchControl interop `DEC-V1-18`, Windows `DEC-V1-01`, macOS `DEC-V1-02`).
6. **Checkpoint/rewind — [LLD closed 2026-10-18: §14.19, §16.18, §31.18; wiring P7 with P8 recovery acceptance].** V1 reliability criterion (§32.24); acceptance tests CP-001/CP-002; core seam `packages/opencode/src/session/revert.ts`; restore is a Guarded workspace effect with preview-first + refusal of destructive reset (`DEC-V1-25`).
7. **Editor/IDE breadth — [post-V1, `DEC-V1-24`].** V1 is CLI/TUI only; external ACP client stays post-V1 (design §37.20 retained; tests ACP-001..008); VS Code/JetBrains-class extensions undesigned and not claimed (rival suites: Claude VS Code + JetBrains panels; Codex IDE extension). Revisit with the ACP adapter decision after V1.
8. **Built-in web search — promoted into V1 (user directive 2026-10-18, `DEC-V1-26`).** Design: §33.9 `web.search.*`; §37.5 `WebSearchBrokerV1`; §16.7 settings; `DEC-V1-20` cost/auth/reliability matrix. Model: built-in default route + optional BYO-key providers (Brave, Exa, …); enabled routes form one ordered cascade with fail-through; exhausted chain → one bounded normal retry + per-route reasons; no route used unless enabled; no hidden paid fallback. Research (competitor behavior + provider matrix) **completed 2026-10-18**; provider-matrix seed recorded in §37.5 (keyless chain Exa → You.com → Tavily → Firecrawl → Parallel → TinyFish; BYO-key set incl. Brave/Exa; Google CSE/Bing/DuckDuckGo excluded; SearXNG deferred; 429-only failover). Implementation (P5-WS) follows design sign-off.

## V1 product boundary

- **Product:** a capable, fast, resource-conscious coding agent with an attractive, keyboard-first **CLI/TUI**. The direct session stays light; managed Goals/Tasks are additive, not required ceremony for ordinary coding.
- **Canonical CLI command:** `horizoncode` is the canonical user-facing executable name; `hzcode` is the shipped short command for the same entrypoint and runtime (amended 2026-10-18). Keep the private `opencode` workspace package ID and genuine upstream dependency names for compatibility until a separately tested package migration.
- **Real-world lifecycle acceptance (user direction 2026-10-17):** UI-016/017 cover queue/steer ordering and terminal-close restart; EX-016 covers MCP readiness/reconnect; RC-011 covers provider/network interruption without hidden fallback or unsafe replay; CX-013 covers stable prefix/cache and token truth; SA-017 covers subagent/workspace lease contention. These are acceptance requirements, not implementation claims, and remain open until parent-verified on the integrated revision.
- **V1 platform:** Linux/WSL-first. Record whether evidence ran on native Linux or WSL2. Native Windows is truthfully **UNAVAILABLE** until native process, sandbox, persistence, and release tests pass; WSL evidence is not Windows evidence.
- **Surfaces/capabilities deferred:** web app, desktop app, browser automation/attached-browser control, and desktop/computer control are post-V1. Do not spend V1 implementation time on those surfaces/capabilities. Their service contracts may remain documented, but no V1 availability claim follows from them. (Built-in web search is no longer deferred — it is V1 per `DEC-V1-26`.)
- **V1 capabilities promoted by the latest user direction:** LSP, DAP, bounded REPL; OMP-preferred CLI/TUI settings and visual patterns; streaming/rendering, artifacts, analytics and Rust-owned automations; bounded worktree/resource pools, quotas, subagents/workers/DAG, file conflict detection, Provider Doctor, session import, bounded caches/local memory, TUI performance, hooks/agents/SDK; broad provider support; and measured RAM/startup/input/stream performance. These are goals, not current implementation claims.
- **Authority:** OpenCode-derived Core owns the direct conversation; Rust owns managed Goal/SpecVersion/Run/Task/Attempt, Guard, effect leases/receipts, resources, evidence and durable automation. Every enabled mutation origin must use the canonical Guard/ExecutionHost boundary or remain disabled. Provider/model/account choice never changes silently; no hidden paid fallback.

## Status rules and evidence format

Use one status per row:

| Status | Meaning |
|---|---|
| `NOT STARTED` | No source implementation in the owning boundary is known. |
| `IN PROGRESS` | Work exists, but its stated exit evidence is incomplete. |
| `PARTIAL` | A narrower source/test slice exists; the full capability is not wired or accepted. |
| `BLOCKED` | A named prerequisite, authority, license, platform or user decision prevents safe progress. |
| `DONE` | The main agent inspected the exact integrated source and reran/reused still-applicable tests, including required denial/recovery and platform evidence. |

Every `DONE` update records: exact integrated commit/revision; source files/functions; architecture/capability owner; exact command and result; negative/recovery result; actual platform/provider/backend; raw performance artifact where relevant; unsupported paths; and any remaining limitation. A passed unit test is not a system acceptance result. The main agent resolves conflicts, verifies handoffs, keeps the test matrix and this tracker current, and only then updates `HANDOFF.md`.

## Release-critical finish list

These are release gates. The original 9b667a status rows below are reconciled with the 6c8c5ab checkpoint report, but none is promoted to `DONE` without parent verification on the final integrated revision. A push-gate attempt was reported green for its selected checks; final full gate/CI and remote publication remain unconfirmed.

| ID | Goal and exit condition | Status | Current evidence / next proof |
|---|---|---|---|
| A1 | Pass the HorizonCode typecheck (`bun run horizoncode:typecheck`) for the CLI host, TUI, and Core. | `IN PROGRESS` | Fresh integrated `bun run horizoncode:typecheck` exited 0 across the CLI host, TUI, and Core on the frozen current snapshot. This resolves the previous four P2 fixture diagnostics for that snapshot. P2/P7 have resumed TypeScript edits, so rerun after their next source-stable integration point and once again on final release source. `packages/opencode` remains an internal source directory; the product gate is HorizonCode-named. |
| A2 | Run `bash scripts/architecture/run_push_gate.sh` on the final integrated source; all required audits, Rust steps, TypeScript and test selectors pass. | `IN PROGRESS` | Latest checkpoint reports the attempted push gate passed its reported audits, TypeScript, selected tests, managed-control and resource-budget checks. This is not the final post-integration run; rerun after phase owners finish. |
| A3 | Publish the verified local `main` commits to the intended `origin/main`; then recheck remote/local status. | `IN PROGRESS` | User explicitly authorized exact-scope `git add`, commit and push. Local `main` remains 12 commits ahead; an earlier push exited 141 after SSH closed. Authorization does not make the existing commits safe to publish: inspect their exact scope and wait for integrated gates before staging/publishing only verified task-owned changes. Recheck remote/local status after any push. |
| A4 | Ensure every first-party overlay/source file is Git-visible and run `scripts/architecture/audit_overlay_visibility.py` with zero hidden changed/new source and no stale unignore rules. | `IN PROGRESS` | After exact exceptions and P7's restored unregistered fail-closed marker, fresh `python3 scripts/architecture/audit_overlay_visibility.py` exits 0: `compared=6627 changed=270 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. This is current-tree evidence; rerun after subsequent integration edits and at the final push gate. |
| C13 | Guarded shell/process origin: complete bounded batch admitted before spawn; denial/malformed/ASK cases spawn zero; allowed run has one-use lease, receipt/UNKNOWN, cancellation and restart handling. | `PARTIAL` | Current focused evidence includes Core supervisor/batch/bash and runner suites 119/0 (474 assertions), Task dispatch 10/0 (86), direct origin-denial tests 7/7 (17), and the Rust `effects_host_process` repair to 10/10. Rebuilt `hz-kernel` resolved the stale-binary digest errors; direct-Attempt dispatch and stale-revision denial pass 2/2. The corrected wrapper-exit test passes 1/1 with observed exit code 1, settled receipt and replay denial. Scoped 30s bounds on only the two real-host fixtures resolve the 5s cold-start harness timeout; the rebuilt-binary `terminal-run-live` suite passes 14/14, 130 assertions, in 80.19s. P1's post-edit Core typecheck and remaining adversarial, cancellation/restart/recovery and enabled-origin acceptance remain open. |
| C14 | Command interpolation and `ConfigMarkdown.shell`/`Process.text` cannot execute before Guard; denied or mixed interpolation spawns zero processes. | `PARTIAL` | P1 disabled the Core WSL profile-discovery subprocess path and made unsupported WSL profiles unresolvable; its test passes 13/13 (34 assertions). Guarded interpolation and every remaining process origin still require integrated negative/positive evidence. |
| C15 | Task/subagent creation and child mutation use Rust-owned Task/Attempt scope, intersected permissions/budget/workspace, cancellation and verified typed results. | `PARTIAL` | P1 propagates private DirectAttemptAuthority through child prompt/ToolBatch and supervisor bodies; P2's atomic effect-binding API has prior focused Rust evidence (managed RPC 11/11; direct Attempt RPC 10/10) and Core child-scope tests pass 4/4 (21 assertions). The earlier two pre-socket host-digest errors were stale-binary fixture state, corrected by rebuilding `hz-kernel`; the current-source direct child real-host suite passes 14/14 (130 assertions). This still does not prove universal child-origin no-bypass, exact lease/revision behavior, crash/cancel/UNKNOWN recovery, or typed independent verification; child effects and fan-out remain gated. |
| C16–C18, C10 | Close plugin/MCP/hook, hosted/provider-executed and legacy-route origins by Guard mediation or explicit disable. Every disabled route has an end-to-end zero-effect negative test. | `PARTIAL` | Some unadmitted/unsupported Core effects are filtered and external configured server plugins remain unavailable; universal origin closure and the complete zero-spawn matrix are not proven. |
| C20–C21 | Generalize Guard to complete atomic ToolBatch admission, bounded payload/time/count, durable PREPARE, one-use lease, exact receipt/UNKNOWN reconciliation and safe cancellation. | `PARTIAL` | Narrow guarded write/patch and Rust batch/resource primitives exist. Full capability/origin coverage and integrated settlement are still open. |
| C25 | Run adversarial tests for every **enabled** V1 mutation origin; disabled origins cannot dispatch. | `NOT STARTED` | Scope the matrix only after the enabled-origin inventory is reconciled; preserve existing §32 tests and add only missing source-bound cases. |
| D1, D2, D4–D8, D11; D9-min; H7 | One real managed vertical: accepted immutable SpecVersion → one durable Task/Attempt → one Guarded action → receipt/evidence → independent final-revision verifier, plus pause/cancel/restart/UNKNOWN and API/TUI Goal review/accept. | `PARTIAL` | P2 focused rerun: `bun test test/session/managed-control.test.ts test/server/httpapi-control-plane.test.ts test/server/httpapi-instance.test.ts` → 49 pass (243 assertions, 5.98s), including live-instance rejection of schemaVersion 2 before managed dispatch and approval/deny/partial/interruption cases. Repaired prompt/apply_patch/task/write selector: 72 passed, 1 pre-existing skip (332 assertions). The current-workspace verifier route and generated SDK are source-present; the route accepts only schemaVersion/goalID/runID and derives project/workspace/Location/principal from trusted state. It remains fail-closed with `capability_unavailable` while P1 has no production verifier mint/callsite. P7 immutable artifact consumer, live guarded action, final-revision verification and pause/cancel/restart/UNKNOWN/conflict journey remain incomplete; finalization/fan-out stay disabled. |
| K1 | Close root distribution license, notices, third-party attribution and package redistributability. | `NOT STARTED` | P9 audit still reports root metadata `UNLICENSED`, root LICENSE byte-identical to upstream OpenCode, no tracked first-party license/NOTICE, and 4 runtime packages without license metadata plus 58 without direct legal files. No legal decision is authorized. |
| K2-honest | Declare Linux/WSL support truthfully; mark native Windows unavailable and list exact unsupported paths. | `PARTIAL` | P9's prepared matrix keeps native Linux and WSL/WSL2 `NOT_VERIFIED`, native Windows `UNAVAILABLE`, and macOS `OUT_OF_SCOPE`; no product install matrix ran, so support acceptance remains open. |
| K5 | Demonstrate clean Linux/WSL install, launch, configuration migration and supported CLI/TUI flows from a clean checkout. | `NOT STARTED` | No candidate product binary was supplied. Synthetic install fixtures are harness-only; parent rerun found one TUI-start smoke failure in that synthetic suite, now under investigation. |
| K6 | Finish the applicable release/security/performance gates and produce commit-bound evidence. | `NOT STARTED` | P9 release gate output is `BLOCKED` with 18 blockers. Depends on P1/P2, full V1 scope, A2/S3, an authorized distribution license, actual clean-install/platform evidence and signing/update decisions. |
| S1 | Catalog/schema/wire/CLI-TUI parity and live acceptance for `question` / `question.ask`, including multi-question, answer and dismiss. | `PARTIAL` | P6 verified: 43/43 focused (multi-question, per-question answers, custom text, review, dismiss, retryable failure; exact V2 bodies; `app.tsx` untouched). Parent completed the canonical wiring: `question.ask` in the machine capability registry (`effectClass: control`, status `code_present`), §33 catalog fence + §33.25 status anchor, §32 acceptance cases `QA-001..004`, §12.13 schema-owner row (`packages/schema/src/question.ts`, events `question.v2.*`), and the tool declaration `capability: { id: "question.ask", effectClass: "control" }` with `test/tool/question.test.ts` green. Fresh parent rerun on the dirty tree: `cd packages/opencode && bun test --timeout 30000 test/server/httpapi-v2-question-live.test.ts test/tool/question.test.ts` → 4 pass / 23 assertions; `cd packages/tui && bun test --timeout 30000 test/component/question.test.tsx test/plugin/notifications.test.ts test/component/dialog-features.test.tsx` → 15 pass / 70 assertions. This covers live V2 ask/reply/reject route, foreign-session denial, TUI retry/review/dismiss, and V2 notification dedupe/clear. No focused S1 behavior gap remains in these suites; keep PARTIAL until final integrated-tree verification. |
| S3 | Final-head CI, full repository gate, architecture convergence and Markdown/DOC guards pass. | `PARTIAL` | Earlier checkpoints report Markdown audit/convergence passing; final head remains unverified and A2 is open. Rerun all required gates after integration. |

**Optional V1 stretch items:** RC0.3 cache/renderer baseline capture (bounded cache/memory behavior remains a V1 goal) and C22 Linux PTY process-tree cleanup guarantee. These are not release blockers unless promoted by a later explicit scope decision.

## V1 feature and performance workstreams

All rows below are **V1 work**, not a post-V1 wish list, except the explicit surface deferrals above. Their current statuses stay conservative until the main agent verifies source and acceptance.

| Workstream | V1 result required | Status | Owner / acceptance evidence |
|---|---|---|---|
| Provider breadth and auth | Adapt compatible provider implementations primarily from OMP under the existing Core/`packages/llm` and canonical auth/config owners; accurate model list, auth, capabilities, cost and streaming. | `PARTIAL` | The 6c8c5ab checkpoint adds a Google Vertex route and focused tests; this is not broad provider/auth/catalog/streaming or real entitlement acceptance. No OMP session loop, auth store, or auto-routing becomes a second authority. |
| OpenCode model access | Use the official, version-appropriate OpenCode API/client/SDK path for user-authorized OpenCode provider/model sessions; test provider/model discovery, streaming, auth and eligible free/subscription entitlements without hidden fallback. | `IN PROGRESS` | Live verification 2026-10-17 (see decision gate below): the official v2.0.31 client works keyless from this machine (`opencode run -m opencode/big-pickle` → `OK`); the keyless request identity and acceptance predicates were captured and bisected, including the required version-like `User-Agent` token. HorizonCode implementation (P6-OP + parent UA fix): keyless `opencode` provider exposes free-only models (`apiKey "public"`, paid hidden, AN-002), honest 429/403 surfacing with Retry-After, and the source-run UA now resolves to the package version. **Live result: the fork's own requests are now accepted by the gateway** (accepted-but-quota-bound `429 FreeUsageLimitError` with the quota message; a rejection would surface `FreeTierError`). The provider is labeled **"OpenCode Default"** (distinct from the separate "OpenCode Go" subscription provider) and keyless exposes only `status=active` free models with `Listed $0` labels. Real 200 + free-model coding-task runs are pending the daily quota reset ~00:00 UTC. Findings: `/tmp/opencode/free-model-findings.md`. Paid Zen/Go BYOK paths unchanged. |
| LSP (F1–F3) | Supervised language servers, useful navigation/diagnostics, generation fencing, and all write-producing code actions/rename routed through Guard. | `PARTIAL` | The 6c8c5ab checkpoint reports a fail-closed LSP broker with identity/generation ledger and combined protocol/lifecycle tests. No supervised server runtime or Guard-mediated spawn/install/code actions is accepted; keep those paths unavailable pending P1. |
| RepoIntel (P3) | Generation-bound repository text/symbol/reference search, drift-safe results, and persistent invalidation under existing workspace/read-scope owners. | `PARTIAL` | The 6c8c5ab checkpoint reports a generation-bound RepoIntel text adapter and bounded artifact/log search (73 tests / 294 assertions). Production indexd transport/model-visible wiring, symbol/reference support and persistent invalidation remain unverified; stale results never authorize writes. |
| DAP (F4–F5) | Supervised debug adapter lifecycle, breakpoints/step/variables, generation-bound references and policy-controlled evaluate/attach. | `PARTIAL` | The 6c8c5ab checkpoint reports DAP protocol/lifecycle preparation only. No supervised adapter or Guard-mediated attach/evaluate/runInTerminal is accepted; keep unavailable pending P1 and §32.28 OS acceptance. |
| REPL (F6–F9) | Bounded Python/JavaScript lifecycle, idle reset, crash/UNKNOWN behavior and every callback re-enters ActionDescriptor/Guard. | `PARTIAL` | The 6c8c5ab checkpoint reports protocol/lifecycle preparation with no-spawn/no-mutation tests only. No supervised interpreter, callback mediation, or runtime recovery is accepted; keep unavailable pending P1. |
| Settings and provider/model UX | High-quality keyboard-first TUI settings, provider/model hub, keybinding/theme and effective/requested/source/unavailable state. OMP is the preferred source. | `PARTIAL` | The 6c8c5ab checkpoint reports provider/model dialogs and a focused Vertex route; full requested/effective/source/locked/unavailable precedence, broad provider/auth acceptance and FEAT-001..014 integration remain open. No V1 web parity requirement. |
| TUI visual system | Distinctive, polished CLI/TUI: clear hierarchy, readable status/errors, useful session/tool/agent cards, accessible keyboard/mouse behavior where supported, stable narrow-terminal layout. | `PARTIAL` | The 6c8c5ab checkpoint adds agent/model/provider dialogs and question-flow adjustments. No complete visual/accessibility/performance acceptance exists; retain the current TUI framework and measure interaction rather than relying on screenshots. |
| Streaming and rendering (I1–I2) | Smooth incremental markdown/tool/status rendering, stable stream prefix, replay correctness, focus/scroll stability and bounded queues/cache. | `PARTIAL` | The 6c8c5ab checkpoint reports a bounded UI event mux, data-stream tests and bounded collapse-tool-output. Reconnect/replay under load, large-history focus/scroll and final TUI performance remain unverified. |
| Artifacts, analytics, automations (I3–I9) | Bounded artifact refs and truthful FULL/SAMPLE/FAILED output, usage/resource provenance, and durable Rust-owned scheduled automation with Guarded invocation. CLI/TUI surfaces only. | `PARTIAL` | P7's aggregate ActivityStream component and mounted Session tests pass, and focused UI integration coverage is 95/95 (1,107 assertions). ArtifactStore bounds/tests pass (48/48); CP-001/002 focused tests pass 7/7. Both mounted SessionRevert and `debug snapshot` CLI are now unavailable with zero-effect evidence (HTTP 1/1; CLI 1/1), and production Snapshot service/node imports are removed. Checkpoint retention/eviction, exact-ref producer/consumer wiring, FULL/SAMPLE/FAILED end-to-end truth, analytics provenance and restart-safe Guarded automation remain open; automation/restore invocation stays disabled. |
| Worktree pool (J1) | Bounded leased worktrees with owner/revision markers, dirty quarantine and safe release; no unbounded create/delete. | `PARTIAL` | `kernel/src/worktree_pool.rs` provides a bounded **in-memory lifecycle model** with owner/revision fencing, dirty quarantine, process-generation evidence, and quarantine reconciliation; `kernel/tests/worktree_pool.rs` passes 30/30. It does not create/inspect filesystem worktrees or persist to OwnerLog; production lease wiring remains blocked on Rust owner/P1/P2 acceptance. |
| Quotas and stop criteria (J3) | User-visible soft budget, hard stop, output limits, accurate receipts and no provider auto-redeem or hidden reroute. | `PARTIAL` | `kernel/src/resource_budget.rs` has exact-integer headroom/pressure logic and a process-local reservation owner; resource-budget tests pass 20/20. No durable OwnerLog integration, user-facing budget/receipt path, or runtime worker admission is wired; retain fail-closed unknown capacity and no provider reroute. |
| Cross-model tests (J4) | Repeatable task suites across strong/small/local/provider classes; separate harness correctness from model capability; record success, regressions, latency, token/cost. | `NOT STARTED` | §32; adapt OpenCode cassettes/http-recorder and OMP benchmark generator/verifier. No live paid test without explicit consent. |
| Shared broker and resource efficiency (RC0/RC1.2) | Measure first; then consider shared read-only facilities only after isolation, fairness, cancellation, replay and measured-benefit proof. | `PARTIAL` | §01/§13/§14/§18/§37/JC-RES-001..010. Existing per-Session observer is not a shared daemon. No effect-host cutover from a design proposal. |
| Worker pools and DAG (RC2.2–2.3) | Rust-owned, bounded, useful subagents with typed outputs, cancellation/recovery, resource/worktree leases and independent final verification. | `PARTIAL` | §15/§21/§29/§37; first prove the single managed Attempt in D1–D11, then bounded fan-out. OMP executor/workpool logic is a candidate, not authority. |
| File-touch/conflict (RC2.4) | Advisory cross-session activity plus authoritative revision/hash/lease conflict denial that preserves user edits. | `NOT STARTED` | §21/§32/JC-RES-011/012; watcher/advisory signals never grant write authorization. |
| Provider Doctor (RC3.1) | Offline no-network diagnosis, catalog tier, and separately consented bounded live probe; report actual provider/model/cost/failure truth. | `NOT STARTED` | §15/§33/§37/JC-RES-013..015/012.L. No Doctor code exists upstream; adapt provider/catalog substrate only. |
| Session import/resume (RC3.3) | Preview, sanitize, explicitly choose owner, import supported formats, resume without credential transfer or dual transcript writers. | `NOT STARTED` | §13/§33/§37/JC-RES-019. OpenCode session-transfer is a candidate; foreign converters are new adapters. |
| Caches and local memory (RC3.2; optional RC0.3 capture) | Declared byte/entry/TTL bounds and eviction owner; stale-generation fencing; opt-in scoped local recall with privacy/poisoning tests. | `PARTIAL` | §18/§30/§31/JC-RES-003/005/020. Some bounded primitives exist; no complete cache ledger/recall acceptance. RC0.3's extra cache/renderer baseline capture is optional. Snapcompact remains excluded unless separately authorized. |
| TUI performance and bounded tool-tail (RC4.1) | Low input/frame latency, idle redraw restraint, stable scroll/focus, bounded output tail/artifact refs, reconnect correctness. | `PARTIAL` | §16/§31/JC-RES-005.B/006/016/017. Record p50/p95 and resource growth on fixed workloads. |
| Hooks, agents, CLI/TUI SDK and import clients (RC5) | Useful local hooks/skills/MCP/agent profiles and authenticated CLI/TUI SDK over one Core Session and Rust managed owner; no effect bypass or second writer. Remote/mobile/web/desktop client surfaces remain post-V1. | `PARTIAL` | §13/§29/§33/§37. Reuse OpenCode plugin/SDK interfaces and OMP typed task/RPC patterns selectively; Guard closure precedes enabling effectful integrations. |
| RAM, startup and total resource budget | Reproducible process-tree PSS/RSS/CPU/FD/cache/disk baseline at 1/5/10/20 Sessions; local inference measured separately; then measured optimizations with correctness/security non-regression. | `PARTIAL` | The RC0 harness suite passes 29/29, but current tests are not live Horizon workload evidence. Without valid Session owner identities plus matching task outcomes there is no eligible raw 1/5/10/20 capture: status remains `NOT_BASELINE`, with no optimization claim. |
| Competitive engineering evaluation | Compare complete CLI coding workflows against available OpenCode, Codex, Claude Code and Grok Build experiences; measure task correctness/verification, time-to-useful-output, retries, cost, resource use and TUI usability. Claude Code is behavior-only; no source copying. | `NOT STARTED` | Define comparable repositories/tasks, same model where available, same hardware and permission mode; record access limits and avoid unapproved paid calls. Competitor reputation is not evidence. |

### Subagent allocation and lifecycle comparison — 2026-10-19

This is a source-grounded behavior review, not a claim of feature parity. Reference pins are OpenCode [`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322) and Codex CLI [`8c0f7011674145da7e10627769fb221c74fbf7a0`](https://github.com/openai/codex/tree/8c0f7011674145da7e10627769fb221c74fbf7a0); the inspected local OpenCode snapshot is tracked source, while Codex details were fetched at the exact immutable SHA because the ignored local clone has no verified commit identity (§42.7).

| Concern | Pinned reference behavior | HorizonCode decision and current implementation status |
|---|---|---|
| Allocation owner | Codex `AgentRegistry` reserves a per-session thread slot and tracks the agent tree; its `LocalAgentControl` owns spawn/message/status operations. OpenCode `tool/task.ts` admits a child from the current Session. | Keep the architecture decision in §29.17/18: the Rust managed coordinator owns graph, Task/Attempt identity, dependencies, admission and settlement. Direct-session Task remains a compatibility path. Current `task_dag.rs` validates proposals and `worker_pool.rs` models admission; neither is the production scheduler/ingress, and P2 single-Attempt acceptance still gates fan-out. |
| Concurrency and recursion | Codex derives a configured max-thread bound and enforces spawn-depth limits; registry reservations are released with child lifecycle. OpenCode checks configured subagent depth and gates background mode behind an experimental flag. | Keep distinct graph-wide, live-worker, per-parent breadth, depth, repair, time, token and resource ceilings (§29.17/18; §32.12 SA-006/007). Code has caps (64 graph members, 20 direct children/live workers, depth 8) and tests, but production ingress, durable reservation and runtime admission remain unverified. |
| Dispatch authority | OpenCode asks `task` permission, resolves a declared agent, derives the child Session permission from parent plus profile, and disables child task recursion unless permitted. Codex uses role resolution, spawn reservation and explicit child lifecycle registration. | Every Horizon child must be authorized before dispatch and every effect must flow through P1 Guard under authenticated parent/Attempt scope; capability grants are intersected and cannot come from child text. P1 C15 and the real host no-bypass/recovery journey remain `PARTIAL`; worker launch stays closed. |
| Context/model selection | OpenCode creates/resumes a child Session, inherits the caller's selected provider/model/variant unless the child profile pins a model, and supports `task_id` resume. Codex spawns/resumes child threads with explicit source/depth, role configuration and bounded inherited context. | Preserve user's provider/model pin and minimize context through typed artifact references (§29.5/18). Do not copy a full parent transcript or silently switch models. Current end-to-end provider pin, restart-safe child lookup and managed artifact handoff are not established by the worker-pool model tests. |
| Progress, completion and cancellation | Codex emits child-start/activity and status updates and exposes coalescing status subscriptions; task cancellation is token-based with lifecycle cleanup. OpenCode renders foreground Task progress and optional background-job notification/result injection in the parent Session. | TUI route now mounts ActivityStream and Task progress renderers; this proves visible direct-session activity, not durable managed-worker status. Need correlate Run/Task/Attempt/WorkerExecution, stream sequence/source generation, cancellation and final receipt/evidence after reconnect/restart. |
| Results and failure | OpenCode returns child text or an explicit task error; background completion is injected as a synthetic parent message. Codex returns structured thread/turn completion and tracks terminal child status. | Horizon must ingest typed artifacts, touched revisions, receipts, missing criteria and explicit `FAILED`/`UNKNOWN`; child prose or process exit cannot pass criteria (§29.18). Existing DAG validation/durable worker tests are isolated models; final-revision independent verifier and crash/cancel/UNKNOWN acceptance remain open. |
| Cost/resources/workspace | Codex records turn token usage/telemetry and gates agent execution/thread count; OpenCode's inspected Task path does not provide the managed resource/workspace lease contract Horizon requires. | Keep stronger explicit resource reservation, process/worktree ownership, stale-epoch fencing, conflict control and receipt reconciliation. Current resource/worktree/worker components have focused model evidence, but OwnerLog/Guard/real launcher integration and 1/5/10/20 measured Session baselines are incomplete. |

Sources inspected: OpenCode [`tool/task.ts`](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/tool/task.ts), [`test/tool/task.test.ts`](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/test/tool/task.test.ts), and TUI Task/SubagentFooter rendering in the tracked snapshot; Codex [`agent/control.rs`](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/agent/control.rs), [`agent/control/spawn.rs`](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/agent/control/spawn.rs), [`agent/registry.rs`](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/agent/registry.rs), [`agent/status.rs`](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/core/src/agent/status.rs), and related task/agent tests.

**Implementation owner and gate:** P1 owns Task/subagent pre-dispatch mediation and child-effect denial; P2 owns the single managed Attempt and authenticated verifier gate; P8 remains the whole-phase owner for production DAG/worker/resource/worktree wiring, metrics, lifecycle/recovery and §32.12/§32.32 acceptance. P8 may expose fan-out only after P1 and P2 evidence is independently accepted. Do not assign P8 to a new owner while all child slots are occupied; launch the whole phase when a slot frees. No acceptance test is promoted by this comparison.

### Critical review of `extra_some_Stuff.md` — 2026-10-19

P2 read the entire document at `/mnt/c/users/sonali/downloads/extra_some_Stuff.md` (1,851 lines of prose plus an embedded architecture diagram on the final physical line) and cross-checked its proposals against the owning HorizonCode docs. Parent independently inspected the AST-splicer sample and the relevant §14/§17/§29/§30 rules. This is an implementation intake decision only; the note is untrusted proposal material, does not amend architecture, and its pseudocode/marketing numbers are not evidence.

| Note proposal | Decision | HorizonCode disposition |
|---|---|---|
| Single typed control plane and explicit worker contracts (note lines 1–59, 365–430, 600–907) | **ADOPT principles; reject a second `veod`/actor runtime.** | Continue one Rust Goal/SpecVersion/Run/Task/Attempt and Guard authority (§§01, 14, 17, 29). Typed actor messages do not grant effects. P2 proves one managed Attempt; P8 owns bounded DAG/worker integration after the P1/P2 gates. |
| `.agent/` metadata, skills, generated specialists (44–59, 365–430, 466–485) | **ADAPT metadata and reviewed drafts; reject policy authority and autonomous registration.** | Treat project data as untrusted. Reuse versioned SkillRegistry/AgentProfile/Guard and explicit provenance (§29.6/29.10, §14.1); generated skills or specialists stay reviewable proposals, never authority. |
| Provider cache gateway, prompt compiler, memory/AST skeleton (60–259, 908–1227, 1400–1617, 1742–1749) | **ADAPT measured provider cache metadata and source-linked structure; reject universal cache claims and a second causal database/transcript.** | Use ContextLedger, RepoIntel, existing indexd and opt-in scoped history (§30.2/7–12/20–22). Cache hits are provider-reported; preserve the user's selected model and avoid unsolicited paid prewarming. |
| Node-ID splicer advertised as conflict-free 3-way AST merge (note §Node-ID Patch Splicer, approx. 905–1399) | **REJECT as production patch path.** | The sample's overlap predicate misses zero-length same-offset insertions, uses skeleton ranges without proving the skeleton digest matches the current source, and never reparses output despite declaring `ParseCorrupted`. No stable-ID or merge proof is supplied. Horizon mutations continue through canonical `files.patch` + current-revision precondition + Guard (§§10, 14, 33, 37); symbol navigation may be benchmarked separately. |
| Four-tool CodeMode, arbitrary autoheal scripts, mutation/fitness contracts (260–364, 365–430) | **ADAPT progressive discovery, deterministic formatting/checks, and bounded optional property/mutation testing; reject arbitrary script execution and universal guarantees.** | Canonical capability IDs and full pre-dispatch batch/Guard/lease/receipt mediation remain mandatory (§§14, 29, 33). Any fitness rule is trusted, versioned and reviewable policy, not repository text. |
| Firecracker/OverlayFS “zero-prompt root” and blind credential proxy (431–485, 1793–1805) | **REJECT the authority/credential model; adapt per-dimension sandbox profiles and copy-on-write only as measured isolation research.** | All effects stay behind Guard and the supported confinement profile; no generic child credential delivery, root autonomy or hidden proxy injection (§14.1–7, §17.4 DEC-V1-03/06). Unsupported profiles stay unavailable until OS acceptance. |
| Production shadow traffic/migrations, auto-flags, telemetry-triggered self-healing (1618–1636, 1661–1715, 1783–1805) | **DEFER; permit only local synthetic or separately authorized staging experiments. Reject automatic production mutation.** | V1 excludes web/desktop production surfaces and autonomous deployment/self-modification; external destinations, secrets, data retention, spend and rollback require separately approved Guarded contracts (§14.6/9, §17.11, §18, §31.13–14). |
| Visual canvas, browser preview, C4 drag; “Verification Brief” (486–599, 1807–1841, diagram) | **Adapt the brief into a TUI projection of durable artifact/evidence references; defer visual editing/canvas.** | Render only real current-revision artifacts/verdicts; do not replace independent verification. Browser/desktop preview and visual editing remain post-V1 under the Linux/WSL CLI/TUI scope (§16.14, §31.13, §17.11). |
| Performance, cache-hit, sandbox-latency, “zero-token” and competitor claims (141, 349–358, 401, 437, 1642, 1682–1715, 1735–1740) | **Reject as product promises; retain as benchmark hypotheses only.** | P8 must measure fixed tasks, actual process-tree/RAM/FD/disk and token/cost on eligible workloads (§17.5, §18.8/17, §30.20); claims require raw reproducible artifacts and no unauthorized paid calls. |

Implementation follow-up is already covered by existing phase owners (P1 Guard/confinement; P2 managed verification; P3 RepoIntel; P6 provider/skills registry; P7 TUI/evidence; P8 worker/resource/benchmarks). No new daemon, capability IDs, authority model, architecture amendment, production connector or V1 visual surface is added from this note. See `CURRENT_RUN.md` for the full source-line decision matrix and exact active owners.

## Provider and OpenCode SDK decision gate

“Any model” means broad, explicit compatibility through supported provider/auth/model adapters—not a promise that every newly released model or every subscription tier is universally available. The model/account selected by the user stays pinned for the turn and managed Attempt. Show provenance, actual pricing/usage and unavailable reasons. There is no hidden fallback.

The OpenCode documentation currently distinguishes the V2 embedded `@opencode/sdk` from the network `@opencode/client`; the legacy pinned source has `packages/sdk/js` and its generated API client. These package generations are not interchangeable. The official docs describe SDK/client lifecycle and API access; they do **not** promise that a package grants every provider model, subscription, or free-tier entitlement.

Before implementation, pin the exact OpenCode SDK/server generation and choose one session ownership mode:

1. **Horizon direct Core:** Horizon owns its normal conversation; provider adapters run through its existing session/provider owner. OMP provider code may be selectively adapted beneath that owner.
2. **Explicit native OpenCode backend:** the official OpenCode host/server owns its own conversation/session; Horizon keeps bounded links/events/outcomes only. This must be a user-visible backend selection, not silent migration or double-writing.

Acceptance: query the selected server's actual provider/model list; authenticate using the documented path; run a minimal streamed request with an explicitly selected, authorized model; verify tool/effect and cancellation semantics; cover an eligible free model and subscription model only where the account/provider actually exposes them and the user authorizes the test. Record unavailable entitlements instead of asserting universal support. No credentials are exported and no paid probe is implicit.

**Current status:** `BLOCKED` pending exact SDK generation/session-owner choice and real authorized model acceptance. Evidence sources: `https://opencode.ai/v2/docs/build/sdk`, `https://opencode.ai/v2/docs/build/client`, and the versioned OpenCode SDK API docs. Local V1 package generation: `packages/sdk/js`; current direct provider/session owners: `packages/opencode/src/provider/provider.ts`, `packages/opencode/src/session/llm.ts`, and `packages/llm/src/`.

**Free-model access findings (2026-10-17):** research (read-only) plus live verification following the explicit user decision to include free models.

- Keyless free models are promotional/stealth models usable without an account; the official docs describe a limited-time feedback window and a **free quota of 200 requests/day**. Several carry data-use-for-improvement terms; others are zero-retention. The official client defaults to free models (`PREFERRED_FREE`). Sources: `repo_take/opencode` @ `09ef07e1` `packages/console/app/src/i18n/en.ts:125,317`, `packages/core/src/model.ts:291`; pinned `opencode/` `packages/web/src/content/docs/zen.mdx:335-349`.
- Enforcement is server-side in the hosted Console/Zen gateway (closed source). Live-captured 2026-10-17 via local TLS capture of our own test client (artifacts in `/tmp/opencode/`): the official keyless request sends `Authorization: Bearer public` — the provider's own anonymous key, set by the official plugin as `apiKey: "public"` (`repo_take/opencode/packages/core/src/plugin/provider/opencode.ts:343`) — plus `x-opencode-client`, `x-opencode-project`, `x-opencode-session`, `x-opencode-session-id`, `x-session-affinity`/`X-Session-Id`, and `User-Agent: opencode/latest/2.0.31/cli`. The official runtime is Bun v1.4.2 (744846f84) — identical to the local `bun` build.
- Empirical acceptance predicates (replay bisection; `403 FreeTierError` = rejected, `429/200` = accepted, `426` = upgrade-required): the `x-opencode-*` header set is required (absent → 400); `Authorization` is not required once headers + body pass. The **`User-Agent` must carry a version-like `opencode/<version>` token** (`opencode/local` and any `local`-version form → 403; low versions → 426; `opencode/1.18.35`-class → accepted; the ai-sdk suffix is harmless). Tool-less flows additionally need a ≥ ~970-character verbatim chunk of an allowlisted official prompt in the system message (title prompt verified; the fork's inherited V1 title prompt passes); agent flows need ≥ 1 tool matching the official registry (name + description OR name + parameters) — the fork's full primary request passes unchanged once the UA is fixed. Request size, header order, tracing headers, path variant and TLS are not discriminating. These predicates are server-side, closed-source behavior and may change without notice.
- Rate limit: `429` `{"type":"error","error":{"type":"FreeUsageLimitError",...}}` with `Retry-After ≈ 57000 s` at 08:10 UTC → daily quota exhausted (resets ~00:00 UTC); applies to all free models for the egress IP. Required product behavior: surface it honestly, single attempt, no retry storm.
- **User decision (2026-10-17, supersedes the prior free-tier prohibition for HorizonCode direct mode):** free models are included under the `opencode` provider. HorizonCode uses the OpenCode provider SDK and its documented keyless mechanism (`apiKey: "public"`); the adapter's service headers/version behavior are captured in the findings above. Provider eligibility and quota outcomes are surfaced verbatim, with no bulk accounts or quota evasion. Recorded risks: the gate is composite/closed and may change; the free quota is small (documented 200/day); the ToS "own internal use" language remains noted. Native OpenCode mode remains available unchanged.
- Verification: research citations re-verified by the parent at the exact revisions; live gateway behavior captured from our own test client (`/tmp/opencode/free-model-findings.md`, `raw/req-*.http`, `mitm-requests.log`). The enforcing service is closed source; server-side claims are behavioral evidence, not locally provable invariants.

## DAP research checkpoint

Prior repo survey text incorrectly said neither reference repo has DAP. Read-only review of the exact OMP pin found a DAP implementation at `packages/coding-agent/src/dap/session.ts`, `packages/coding-agent/src/tools/debug.ts`, adapter definitions and focused configuration/session/launch-failure tests. It is MIT at repository top level, but exact file/dependency notices and process-launch paths still require the §42 review before reuse. The pinned OpenCode trees inspected have no DAP runtime. Horizon has no verified DAP runtime.

Candidate order for source review—not a final implementation selection:

1. **OMP pinned DAP** — strongest local reuse candidate; adapt the DAP client/session lifecycle but replace direct `spawn`, `runInTerminal`, attach/evaluate and install paths with authenticated Guard/ExecutionHost mediation.
2. **`roblourens/dap-cli`** — MIT CLI-shape/adapter reference; review exact pin, installer and subprocess boundary.
3. **`debugmcp/mcp-debugger`** — MIT DAP/MCP reference; not a native TUI interface and still subject to the same Guard.
4. **`akiselev/debugger-cli`** — GPL-3.0 reported; requires explicit legal compatibility review before considering.
5. `agent-debugger`, `dapi`, and `aidb` remain secondary research candidates; attach/injection and MCP/Python integration may not fit the Linux-first CLI boundary.

No winner is selected until source, maintenance, language support, license/dependency closure, Linux process model, adapter installation, Guard fit and §32.28 acceptance are compared. Research does not make DAP `CODE_PRESENT` in Horizon.

## JCode resource/RAM adoption

Treat JCode as an engineering-method reference, not an authority or source of Horizon performance claims. Horizon's provenance register pins `1jehuang/jcode@1f612a7d376e06e4eb8641736197f61a21106131`. The local `repo_take/jcode` checkout was found clean but at `0c5968d138b1d94e7182aebe08d0860ba4ae2638`; the requested pin is not present, so exact code/license/dependency review remains **BLOCKED**. No JCode code or allocator settings were copied.

Source pointers in §42.9 to inspect at the exact pin:

| JCode candidate | Horizon adaptation boundary | Current decision / proof |
|---|---|---|
| `scripts/bench_headless_memory.py`, `README.md` | `scripts/perf/`, `docs/performance/evidence/` | Adapt controlled measurement methodology only; reproduce on Horizon hardware/build/workloads before any claim. |
| `crates/jcode-base/src/process_memory.rs` | `kernel/src/resource_sampler.rs`, `scripts/perf/rc0.py` | Compare Linux PSS/RSS/CPU/FD/thread sampling and PID-start identity; unknown/denied metrics stay unknown. |
| `src/main.rs` allocator experiments | Existing Rust/Bun build configuration | Do not copy flags or tune allocators absent same-machine before/after evidence and license/source review. |
| `docs/MEMORY_BUDGET.md` | `arch_V1/18-OPERATIONS-RELEASE.md` and resource ledger | Adapt bounded-budget methodology, not JCode numeric thresholds. |
| `crates/jcode-agent-runtime/src/lib.rs` cancellation; `crates/jcode-app-core/src/server/file_touch_service.rs` | Existing `kernel` cancellation/Guard and §21 file-touch owner | Compare against current contracts; never create a second task or Guard authority. |
| `crates/jcode-tui/src/tui/redraw_schedule.rs`, `crates/jcode-app-core/src/agent/inline_tail.rs` | `packages/tui` / §31 bounded redraw and output tail | Algorithm references only; prove stream/cancel responsiveness and artifact bounds. |
| `docs/SWARM_TASK_GRAPH.md`, `docs/MULTI_SESSION_CLIENT_ARCHITECTURE.md`, `docs/MODULAR_ARCHITECTURE_RFC.md`, `docs/SAFETY_SYSTEM.md` | §29/§13/§14/§32 | Design references only; respect each source document's proposed/draft/implemented label. |

Mandatory evidence before saying “RAM-optimized” or “faster”: capture same-machine 1/5/10/20 Session runs; bind commit, Linux/WSL version, CPU/RAM, build, model/provider/harness, cache/warm state and equivalent task outcome; record whole owned process-tree PSS and RSS separately, CPU/FDs/cache/disk and local-model RAM/VRAM separately; repeat runs and preserve raw artifacts. Measure cold/warm startup, first useful output, TUI input/frame p50/p95 and long-run growth. Optimize only after baseline; rerun correctness, Guard, task-success, cancellation and leak tests. Never kill foreign processes, evict canonical history/evidence, change the selected provider/model, or present JCode numbers as Horizon results.

## Source-to-Horizon implementation map

Reference revisions: OpenCode `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322` (MIT top-level), Oh My Pi `eec114a9226da698ebc015fd8996a8ca3bc4625c` (MIT top-level; per-file/dependency/license review still applies). `repo_take/NOTES.md` contains the longer survey. Paths below are candidates to inspect at the pinned revision, not permission to copy wholesale.

| V1 area | Candidate reference files | Horizon destination/owner | Initial decision and guardrail |
|---|---|---|---|
| Non-OpenCode provider/auth/catalog/model integration | OMP `packages/ai/src/auth/{oauth.ts,select.ts}`, `packages/ai/src/stream.ts`, `packages/catalog/src/{model-manager.ts,model-cache.ts,models.ts,pricing.ts}` | `packages/llm/src/`, `packages/opencode/src/provider/provider.ts`, existing auth/config/session owner | ADAPT provider modules selectively. Keep Horizon credentials/config/Session ownership; no OMP credential database, unbounded event queue, account rotation or hidden paid failover. |
| OpenCode provider/model sessions | Official version-specific OpenCode API/SDK; legacy local `packages/sdk/js`; current V2 `@opencode/client` / `@opencode/sdk` docs | `packages/opencode/src/session/llm.ts`, `packages/sdk/js`, and explicit native backend seam if selected | ADAPTER only after SDK generation and separate-vs-direct Session ownership are settled and actual entitlement behavior is tested. |
| LSP F1–F3 | OpenCode pinned `packages/opencode/src/lsp/*`, `packages/opencode/src/tool/lsp.ts`, `packages/opencode/test/lsp/*`; OMP `packages/coding-agent/src/lsp/*` | Existing `packages/opencode` language/tool seam; §30/§37 | ADAPT the pinned OpenCode lifecycle/diagnostic tool as first choice; OMP client/mux as maintained alternative. Guard server spawn/install and all edits. |
| DAP F4–F5 | OMP `packages/coding-agent/src/dap/session.ts`, `packages/coding-agent/src/tools/debug.ts`, adapter catalog and DAP tests | New first-party module behind `kernel` Guard/ExecutionHost; §37.7 | ADAPT after exact path/license/dependency review; do not inherit ambient spawn, evaluate, runInTerminal or adapter downloads. |
| REPL F6–F9 | OMP `packages/coding-agent/src/eval/py/kernel.ts`, `kernel-session-registry.ts`, `idle-timeout.ts`, `eval/js/*`; OpenCode `packages/codemode/*`, `packages/core/src/persistent-pty/daemon.ts` | Existing process supervisor + §30/§37 REPL boundary | ADAPT lifecycle; selectively REUSE confined codemode; ADAPTER daemon only behind Guard/leases. No parallel runtime. |
| Settings and provider/model TUI | OMP `packages/coding-agent/src/config/{registry.ts,settings.ts,settings-ui.ts}`, `packages/coding-agent/src/tui/overlays/{settings-selector.ts,settings-defs.ts,model-hub.ts}` | `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/*`, existing provider/auth owner | ADAPT host/visual patterns. Config owner remains canonical; env values are not falsely shown as editable; one effective/locked/unavailable state. |
| TUI rendering/streaming | OMP `packages/tui/src/{tui.ts,terminal.ts}`, `packages/tui/src/chat/assistant-message.ts`, `components/markdown.ts`, `tools/streaming-output.ts`, `render/output-pane.ts`; OpenCode `packages/session-ui/*`, `packages/tui/src/mini/stream-v2*`, `specs/v2/event-stream-architecture.md` | Existing `packages/tui`, `packages/core`, §31 event projection | ADAPT renderer/reconciler/queue algorithms; reuse leaf UI only after dependency review. Keep bounded queues, replay correctness, input priority and Horizon transcript ownership. |
| Artifacts/analytics/automation (I3–I9) | OpenCode `packages/session-ui/src/components/{file-media.tsx,markdown-mermaid.ts}`, in-session usage; OMP `packages/coding-agent/src/session/artifacts.ts`, `packages/coding-agent/src/session/blob-store.ts`, stats/output-pane patterns | Existing artifact store, Rust automation owner, `packages/tui` | ADAPTER file/artifact/usage presentation. Automation UI is Horizon-first; no matching upstream automation owner was found. |
| Worktree pool J1 | OpenCode `packages/core/src/worktree.ts`, strategies/tests; OMP `packages/coding-agent/src/task/{worktree.ts,isolation-ownership.ts}` and `crates/pi-iso` | Existing `kernel` resource/worktree lease owner and Core workspace | REUSE/ADAPT inventory/baseline-delta algorithms; add Horizon leases, quarantine and ownership proof. Do not copy weak owner-marker cleanup as authority. |
| Quotas/stop criteria J3 | OMP `packages/coding-agent/src/task/executor.ts`, `packages/agent/src/output-budget.ts`; OpenCode step caps/compaction | Rust managed budget owner and existing Session limit interfaces | ADAPT arithmetic; Horizon owns explicit cost/spend and receipts. No automatic quota redemption/provider switch. |
| Cross-model tests J4 | OpenCode `packages/ai/test/fixtures/recordings/*`, `packages/http-recorder`, `packages/simulation`; OMP `packages/typescript-edit-benchmark/{generate,verify,mutations,hunks}.ts`, `packages/metaharness` | `packages/opencode/test`, `packages/core/test`, `arch_V1/32` | ADAPT cassette fixtures and REUSE pure benchmark generation/verifiers; do not copy Harbor orchestration or secrets into test containers. |
| Shared read-only broker RC1.2 | OpenCode `specs/v2/event-stream-architecture.md` bounded per-connection queue design | Existing `SessionSupervisor.Service` + Rust IPC (§13) | Design input/ADAPTER only; no effect-sharing cutover until peer isolation, recovery and benefit tests pass. |
| Worker pools/DAG RC2.2–2.3 | OMP `packages/coding-agent/src/task/{executor.ts,workpool.ts,spawn-policy.ts,parallel.ts}` and typed output schemas | Rust `kernel/src/managed_control.rs`, future Rust scheduler/ExecutionHost, §21/§29 | ADAPT schema/policy logic, not OMP agent loop. Every spawn/fs effect behind Guard; independent verifier owns PASS. |
| File-touch/conflict RC2.4 | OMP `crates/pi-edit/src/{store.rs,mismatch.rs,recovery.rs,prefixes.rs}`; OpenCode `packages/core/src/filesystem/watcher.ts`, `snapshot.ts` | Rust Guard revision preconditions + existing watcher/workspace source | ADAPT stale-anchor algorithms and REUSE watcher patterns. Advisory touch is not write authority; full revision/lease remains authoritative. |
| Provider Doctor RC3.1 | OpenCode `packages/opencode/src/provider/provider.ts`, `packages/opencode/src/provider/models-dev.ts`, `packages/opencode/src/session/usage.ts`, `stats.ts`; OMP KDL compatibility rules as design input | Existing provider/auth/catalog owner + new §37 Doctor adapter | ADAPT catalog/cost substrate; build probes new, offline first, full probe requires explicit bounded spend approval. |
| Session import RC3.3 | OpenCode `packages/core/src/session/transfer.ts`, sanitizer, CLI/server route and tests | Existing canonical Core Session and explicit native adapter | REUSE safe transfer/redaction shape; ADAPTER foreign formats. No credential copy or dual live transcript writer. |
| Caches/local memory RC3.2/RC0.3 | OMP `packages/mnemopi` schema/decay/consolidation; OMP TUI Markdown caches; OpenCode Markdown cache patterns | Existing `ContextLedger`, `indexd`, TUI cache owners | ADAPT bounded algorithms only; every cache has byte/entry budget, owner, epoch invalidation and eviction safety. Snapcompact stays out of this V1 plan. |
| TUI perf/tool-tail RC4.1 | OMP `packages/tui/src/tui.ts`, `packages/tui/src/tools/streaming-output.ts`, `packages/tui/src/render/output-pane.ts`; OpenCode `packages/tui/src/mini/stream-v2*` | Existing TUI and artifact ref path | ADAPT dirty-row, backpressure and bounded head/tail; large output becomes artifact refs, not duplicate transcript memory. |
| Hooks/agents/SDK RC5 | OpenCode plugin/ACP/SDK source; OMP `packages/coding-agent/src/task/*`, RPC wire schema and Python SDK generator | Existing `packages/core`, `packages/opencode`, `packages/sdk/js`, Rust Task/Guard | ADAPTER interfaces only. Every effectful hook/MCP/plugin/child action re-enters Guard; one direct Session writer. |
| Browser, desktop, web surfaces | OMP browser/computer source was surveyed; OpenCode browser/app source exists | None in V1 | DEFER. Keep unavailable and do not build or expose V1 actions for these surfaces. |

Before any port: record the exact immutable revision, per-file license/notice, dependency closure, source decision (`REUSE EXISTING` / `ADAPT ALGORITHM` / `ADAPTER` / `REJECT`) and local tests in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md`; inspect callees/tests first. Do not replace or re-hydrate the tracked `opencode/` snapshot with a clean upstream checkout.

## First-party naming rule for adapted work

**V1 identity migration (user decision 2026-10-23):** migrate HorizonCode-owned package metadata/scopes where validated, internal import aliases, generated names, executable/build/typecheck/workflow identity and first-party non-legal product prose in staged, tested dependency layers (`arch_V1/17` §17.7, `arch_V1/20` §20.17, `arch_V1/32` NAME-001..004). Preserve the pinned OpenCode source snapshot, genuine `@opencode-ai/*`/vendor APIs, source pins, legal attribution and compatibility paths unless a separately tested migration replaces them. `horizoncode` and `hzcode` remain one CLI entrypoint/runtime; this identity change is not a publication/license grant. The separate incremental build-graph/cache performance rewrite remains post-V1 under `arch_V1/10` §10.12.

**Status:** `NOT STARTED` for new adapted modules; no code was copied by creation of this tracker.

## Subagent work allocation and dependency order

The main agent owns architecture/scope reconciliation, shared integration, provider/model policy, verification, the test matrix, and all status updates in this file and `HANDOFF.md`. Assign each module one owner and disjoint writable paths; use read-only research for unresolved external-source facts. Every handoff reports exact files/functions, deviations, commands/results, negative/recovery cases, tested OS/provider/backend, limitations and integration instructions.

| Wave | Work package | May proceed in parallel with | Prerequisite / integration rule |
|---|---|---|---|
| 0 | Main agent: A1–A4, scope/owner reconciliation, pin/licensing, test matrix and integration | Read-only DAP/provider/JCode/UI research; RC0 capture design | No status promotion from documents; preserve existing dirty work. |
| 1 | P1.3 Guard: C13 shell/process; C14 interpolation; C15 Task/subagent; C16–C18/C10 origin closure; C20/C21 batch bounds | RC0 measurement harness; independent TUI design research; provider module research | Effectful capability exposure remains disabled until pre-dispatch Guard and zero-effect negative test pass. Serialize shared Rust effect-owner changes; one Rust build at a time. |
| 2 | P2 single managed vertical D1–D11 + D9-min/H7 | Read-only LSP/DAP/REPL adapters and provider metadata work | Start only after P1.2/P1.3 entry tests pass. One Attempt and final verifier precede any worker fan-out. |
| 3 | Providers/OpenCode model path; LSP; DAP; REPL | Separate TUI/settings, resource sampling, artifact/cache modules | Agree typed interfaces first; adapters may be coded in isolation but effectful actions stay unavailable until Guard gate. No shared Core Session/session.ts concurrent writers. |
| 4 | OMP-preferred settings/TUI polish; streaming/render; artifacts/analytics/automations | Independent provider modules, isolated tests, measurement collection | Single config/Session/Guard authority. Keep source maps and package identities Horizon-owned. |
| 5 | Worktree/resource pools, quotas, file conflicts, Doctor, import, caches/memory, bounded worker/DAG fan-out | Non-overlapping TUI and provider integrations | Rust resource owner/Guard contracts first; test auth, stale epoch, cancellation, quarantine, UNKNOWN and conflicts. One Rust build at a time. |
| 6 | Competitive workflow trials, full model/provider matrix, clean install, final release proof | Documentation/source reviews that do not alter tested code | Re-run affected suites on final integrated revision; complete A2/K/S gates before release. |

Build discipline: never run concurrent equivalent heavyweight Rust builds. While one Rust build is active, other agents may implement independent work, inspect source, or run lightweight tests; they must not launch a duplicate build. Main agent checks process/worktree/disk ownership before and after build-heavy waves and records results.

## Scope conflicts and decisions to reconcile

1. **Previous scope is reconciled.** The prior 2026-10-16 post-V1 list was superseded by A-V2-31; the operative plan, HANDOFF, AGENTS, reference notes and affected normative owners now record Linux/WSL CLI/TUI V1. Scope reconciliation does not upgrade runtime status.
2. **Browser and desktop:** browser/desktop/web application surfaces are post-V1 under A-V2-18/A-V2-25/A-V2-31. Keep unavailable. Built-in `web.search` was promoted into V1 on 2026-10-18 (`DEC-V1-26`) — implemented per §37.5/§16.7 with the enabled-route cascade and no hidden paid search.
3. **OpenCode SDK generation and ownership:** current V2 docs distinguish an embedded `@opencode/sdk` from network `@opencode/client`; local pinned code has legacy `packages/sdk/js`. Select/pin one compatible generation and an explicit session owner before implementation. SDK/API presence does not establish subscription/free entitlement.
4. **“Any model”:** define a support matrix (provider/model IDs, auth routes, tool/stream capabilities, cost, platform and test status). No finite product can promise all future models; never silently route to a different provider/model.
5. **Subagent breadth vs the single managed vertical:** prove one durable Attempt and independent verifier first; then add bounded worker/DAG capability as V1 work. Do not claim broad parallelism from a single-attempt test or accept child self-report as PASS.
6. **Naming:** targeted HorizonCode naming applies to new adapted modules now; global package/scope/build renaming and migration remain a separate tested gate. Never falsify upstream provenance or strip notices.
7. **JCode exact source:** local clone does not contain the §42 pinned commit. Fetch/read the exact revision and inspect its license/dependencies before copying or tuning. Existing §42 notes are candidate pointers, not source verification.
8. **DAP source map:** corrected in `repo_take/NOTES.md` and §42: pinned OMP has DAP source, while no Horizon runtime is verified. Exact file/dependency/license and Guard review remains required before porting.
9. **Native Windows and legal release:** Windows stays unavailable, and root redistribution/license clearance remains a release blocker regardless of feature progress.

## Current next steps

1. Finish parent verification of A1's changed API/TUI path; Core and HorizonCode TypeScript package typechecks (`packages/opencode`) pass, while the app-wide typecheck reports diagnostics on unchanged code and is not the A1 release gate. Rerun the focused TUI and HTTP tests using the repository's standard timeout after the unrelated Cargo test finishes.
2. Complete the final cross-document scope consistency pass and rerun Markdown, convergence, provenance, overlay-visibility and whitespace audits; refresh this tracker and HANDOFF only from parent-verified evidence.
3. Rerun the mandatory push gate on the integrated tree once no equivalent build is active. Do not bypass a failure or publish the 11 pre-existing commits unless the gate passes and exact publication scope is safe.
4. Continue from P1.3: first complete the host prerequisite, then C13 shell/process; keep RC0 measurement independent only where stable Rust-owned process identities exist; prove the P2 single managed vertical before worker fan-out.
5. Resolve exact DAP source/dependency/license review and the unavailable local JCode pin before copying/tuning external code. Report source research separately from implementation status.

## 2026-10-18 — resumed implementation checkpoint (parent integrated)

This addendum supersedes stale queued/owner claims above only for the following observed checkpoint; it does not mark any phase VERIFIED or V1 RELEASED.

| Workstream | Owner/status | Evidence at this checkpoint | Remaining acceptance |
|---|---|---|---|
| A1–A4 | Parent active; dirty tree preserved on `main`, one worktree, no conflicts | Overlay audit passed after exact ignore exceptions: `compared=6627 changed=246 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. | Rerun after all phase edits, review ownership, final full gates; never publish unrelated staged or pre-existing commits. |
| P1 Guard/ExecutionHost | `p1_guard_resume` active | `horizoncode-sandbox` own tests remain previously reported 24/24 + doctest. Current-source `cargo check --locked --offline --manifest-path kernel/Cargo.toml --lib` passed after the managed scope digest landed. A first 119/2 Core run used stale `hz-kernel`; rebuilding the binary made the exact deadline regression pass with a timed_out receipt. Fresh interrupt returns in 1.28s with `completed=false`, but its pre-cancel PID check was invalid because `$$` is inside bubblewrap's PID namespace; a unique host-visible process marker regression is pending. P1 separately fail-closed Core Bash leaf; `test/tool-bash.test.ts` reported 3/3, and OpenCode origin/batch suite 71/0. | P1 owns Core Bash leaf now; OpenCode's active shell route remains guarded Pty. P1/P2 are adding distinct tagged managed/direct Attempt scopes; child effects remain denied until digest/lease and durable facts pass. Finish current-source P1 test matrix, C13–C21, origin zero-effect, cancellation/restart/UNKNOWN and receipt recovery. |
| P2 managed vertical | `p2_managed_resume` active | API/TUI predecessor work remains source-present; HostKernel now threads managed Attempt scope and the library compiled jointly with P1. | Finish authenticated distinct review, direct+managed Attempt effect intents/leases, actual live workspace revision, independent verifier evidence, Core→TUI delivery, real-socket E2E and pause/cancel/restart/UNKNOWN/stale/conflict acceptance. No finalization/fan-out before pass. |
| P4 LSP/DAP/REPL | `p4_lsp_dap_repl` active | Updated focused suite `cd packages/opencode && bun test --timeout 30000 test/lsp test/dap test/repl` passed 204/0 (671 expectations, 10 files). A narrower latest subset passed 106/0 (456 expectations). Broker/session records are being tightened with authenticated owner/workspace/policy/sandbox bindings; current routes remain fail-closed. | Obtain a stable typed Guarded process-effect/ExecutionHost API (P1), then guarded adapters, executable and sandbox checks, final integrated tests and Linux/WSL real-project journeys. No process/evaluate/callback exposure until P1 verifies. |
| P5 built-in web search | Current owner returned PARTIAL | Cascade/config and Settings dialog implemented for builtin/Brave/Exa. HorizonCode CLI-host package 23/23 (66 assertions), HorizonCode TypeScript package typecheck (`packages/opencode`) clean, Settings dialog 1/1 (9 assertions), TUI typecheck clean. Parent mounted `web.search.settings`; app regression 1/1 (7 assertions). Explicit consent, local auth storage, config preservation, no key in config, and zero search requests were tested. A4 overlay audit is green at this checkpoint. | Search remains disabled (`WEB_SEARCH_GUARD_READY=false`). P1 must deliver a tested outbound HTTP Guard/ExecutionHost contract bound to `web.search`, ToolBatch/lease, credential resolution, host/request/response bounds, cancellation, status/Retry-After, receipts/recovery. Then add provider adapters and route failure/429/exhaustion/consent acceptance; no raw fetch or paid fallback. |
| P6 + S1 | Queued; no phase owner slot yet | Existing tracker evidence is historical and not revalidated on the integrated tree. | Assign whole-phase owner when a slot opens; complete provider/model matrix, settings/Doctor, question.ask and switching; free-model 200/coding journey remains quota-gated with no paid fallback. |
| P7 | Queued; no phase owner slot yet | ActivityStream is source-rendered in TUI; `kernel/src/checkpoint.rs` is present but hidden/source module wiring and final route/recovery acceptance remain unresolved. | Assign whole-phase owner when a slot opens; replay/resnapshot/large histories, redaction/bounds, artifact truth, analytics, durable Guarded automation and checkpoint/rewind with CP-001/002, partial recovery. |
| P3/P8/P9 and release | Not assigned in this execution wave | Existing work is partially implemented with historical evidence; no final integrated release proof. | Reconcile the full V1 scope, resource/worker gates, clean install, license/notices, final Linux/WSL acceptance, full CI/release gate, CLI names, and authorized publication. Native Windows remains unavailable. |

At this checkpoint child capacity is three: P1, P2 and P4 are active. No tests/builds may overlap when equivalent heavyweight checks are running. No phase status is upgraded from an owner report without parent review on the final integrated revision.

## Current continuation — 2026-10-18

The user resumed implementation across A1–A4 and P1/P2/P4/P5/P6/S1/P7. Current whole-phase owners in the shared checkout are P1 Guard/ExecutionHost, P2 managed control, and P7 streaming/artifacts/automation/rewind. The three available child slots are occupied; P4, P5 and P6/S1 are queued and will take slots as owners finish. P1 has the first shared Cargo build slot; no equivalent heavyweight Rust build may start until it is released. P2, P4 and P7 effectful paths remain disabled until the relevant P1 contracts have parent-verified denial, lease, receipt and recovery evidence. This ledger records orchestration only; no phase is VERIFIED or V1 RELEASED.

| Workstream | Current source/evidence | Next acceptance |
|---|---|---|
| A1–A4 integration | Existing staged, unstaged and untracked files are preserved on `main@6c8c5ab9a`, 12 ahead / 0 behind, one worktree, no conflicts. The parent added an exact `.gitignore` exception for `packages/opencode/test/tool/skill.test.ts`. Overlay audit exit 0: `compared=6627 changed=242 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. | Re-review phase-owned diffs, reconcile source/status, rerun overlay and all relevant gates after the final integrated revision; no staging/commit/push or publication in this continuation. |
| P1 Guard/ExecutionHost | Whole-phase owner `p1_guard`. `horizoncode-sandbox` is source-wired through HostKernel terminal consent and stdio preflight/launch into `spawn_prepared`; parent reviewed these call paths on 2026-10-19. This is source wiring, not product containment acceptance. P1 also owns effect origins and ToolBatch enforcement; P2 owns HostKernel managed verifier/Attempt integration during its explicit file lease. | Complete all listed P1 origin, shell/interpolation, Task/child, ToolBatch, lease/receipt/UNKNOWN, cancellation/restart, synthetic runner fixture and enabled-origin adversarial tests, including actual confinement and zero-spawn denial proof. Native Windows remains unavailable. |
| P2 managed vertical | Whole-phase owner `p2_managed`; non-effectful review, verifier, current-revision, plan/client and Core→TUI work proceeds. The owner confirmed §14.3's existing authenticated delegated-subject transport is the approved reviewer identity seam; no caller-supplied identity is accepted. | Complete one real managed Attempt with distinct authenticated reviewer, Attempt-issued effect intent/lease, actual current workspace revision, real bounded artifact/test evidence from an independent verifier, Core→TUI proposal delivery and pause/cancel/restart/UNKNOWN/stale/conflict recovery. Keep executor/finalization unavailable until positive and adversarial real-socket proof passes. |
| P4 LSP/DAP/REPL | Queued for a whole-phase owner; prior focused tests exist but do not establish final integrated OS or Guard acceptance. | Complete supervised lifecycles and mediated code actions/rename, attach/evaluate, callbacks/recovery; keep effects unavailable until executable resolution, Guard and OS confinement pass; run Linux/WSL OS and real-project journeys. |
| P5 web search | Queued for a whole-phase owner. Source still contradicts the approved V1 design: registry says web search is deferred and enables only Exa/Parallel flags; `websearch.ts` selects a single route (including a session-ID hash fallback). | Implement the built-in default plus Settings-enabled ordered provider cascade, per-route auth/cost/status provenance, bounded retry/failure report, and disabled/failure/429/exhaustion/consent tests. Do not enable network effects before P1 Guard acceptance; no silent paid route. |
| P6 providers/settings/Doctor/S1 | Queued for a whole-phase owner. Prior settings/question evidence and free-tier request acceptance remain historical until rerun on the integrated tree; Provider Doctor offline route/TUI and final provider-switch acceptance remain. | Fix all typecheck diagnostics, complete FEAT-001..014 and S1 spoof/mixed-effect denials, Doctor offline and separately consented live probes, TUI switching, plus explicitly authorized free-model stream/coding-task checks after reset. Never use paid fallback. |
| P7 streaming/artifacts/automation/rewind | Whole-phase owner `p7_stream`. `ActivityStream` is rendered in `packages/tui/src/routes/session/index.tsx`; owner reports focused suite 80/0 (1,022 expectations), but it confirmed this is not a full Session-route journey. It found initial TUI history is capped at 100 and now owns `context/sync.tsx` for bounded load-older/pagination. It is building a route integration harness and a bounded ArtifactStore exact-ref validation API for P2. | Complete route-level replay/reconnect/resnapshot/large-history acceptance, final redaction/bounds/focus/scroll/order, FULL/SAMPLE/FAILED artifacts, analytics provenance, durable automation under Guard, checkpoint preview/restore/refusal/partial-UNKNOWN and CP-001/CP-002. No automation/restore effects until Guard and HostKernel integration pass. |

**Remaining release scope:** implementation of these requested phases is not sufficient to mark V1 released. Reconcile and verify the rest of the operative V1 scope (including P3/P8/P9 gates), real Linux/WSL journeys, both CLI commands, clean install/migration, legal/notices and final CI/release evidence. Native Windows remains unavailable. Any remote publication or release action requires explicit authorization of exact scope/target after a concrete final gate result.

### Post-compaction continuation update (2026-10-18)

The active whole-phase roster is P1 (`p1_guard_resume`), P2 (`p2_managed_resume`) and P4 (`p4_lsp_dap_repl`), the three available child slots. The shared tree remains dirty and preserved (150 staged, 112 unstaged, 33 untracked; one worktree; no conflicts). P1 owns the next shared Cargo acceptance wave. P2/P4 coordinate a single TS-heavy validation run.

| Workstream | New evidence / ruling | Remaining gate |
|---|---|---|
| P1 Guard/ExecutionHost | Rebuilt-kernel deadline and cancellation fixtures now pass 2/2 (19 expectations). The former host PID assertion observed a bubblewrap namespace PID and was invalid. P1 has converted an obsolete Linux terminal-start-unavailable test into positive owner-loss cleanup coverage; first PID-only assertion timed out and exact host-visible argv/process-state validation is in progress. | No production leak has been established by the fixture. Complete cleanup fixture, then current-source C13–C21 origin matrix, batch/lease/receipt/UNKNOWN/cancel/restart recovery, and Guard acceptance before any dependent effect is enabled. |
| P2 managed vertical | Parent ruled that a distinct ServerAuth principal projected through Core can authenticate a reviewer when identity derives from trusted connection state and matches a durable review assignment. That identity alone is not independent-verifier evidence. | Trusted independent run/result bound to live workspace revision and concrete artifact/test evidence; Attempt effect intent/lease; Core→TUI delivery; real-socket pause/cancel/restart/UNKNOWN/stale/conflict proof. Keep execution/finalization disabled. |
| P4 LSP/DAP/REPL | Latest focused suite 204/0, 671 expectations. | Continue safe owner/scope/process-lifecycle work; effects remain unavailable until P1 Guard/ExecutionHost and OS confinement acceptance, then run real Linux/WSL projects. |

At this checkpoint, P6/S1 and P7 are the next whole-phase owners for free child slots; P5 resumes when the Guarded outbound HTTP contract is available. P3/P8/P9 and all release gates remain in scope. No phase is VERIFIED or V1 RELEASED.

P4/P1 boundary clarification: the present Guarded prepare/lease path is terminal-only; a generic non-PTY broker dispatcher is absent. P1 owns that shared ExecutionHost interface and its denial-before-spawn, exact scope/profile/workspace, cancellation and UNKNOWN receipt tests. P4 will not invoke the sandbox crate directly or create a parallel launcher; all LSP/DAP/REPL routes remain unavailable pending parent-verified contract evidence.

P1 test correction update: the latest shared Cargo wave passed lib **196/196**, `effects_host_process` **10/10**, and authenticated owner-loss `host_terminal_events_process` **1/1**. `host_terminal_process::interactive_lifecycle_requires_approved_guard_lease` was a fixture mismatch: it prepared one command/argument digest, then dispatched another, which EffectHost correctly denied. P1 is correcting the fixture and rerunning; the ToolBatch guard matrix was not reached. No production defect or phase completion is claimed.

Latest phase evidence delta: P1 `host_terminal_process` is now **2/2 passed** after exact approved-argument replay and a real-newline (>2 MiB) fixture correction; no production fix was needed. P1 found C15 direct child Attempt still lacks EffectIntent binding and child prompt→ToolBatch scope propagation, so keep it unavailable while P1 closes the path. P2 Cargo compile passed (lib **198/198**, `direct_attempt_rpc` **8/8**); one `hz_kernel_process` self-review fixture omitted `expectedRevision` and is being corrected before a focused rerun. P4's REPL cross-session authority fix is covered in a focused suite of **205/0, 686 expectations**; typecheck remains pending.
P2's corrected real-socket suite now passes **4/4** with the required expected revision. The managed-control/RPC/settlement target totals remain to be captured after P4's typecheck and require a focused Rust rerun.

### Slot handoff and current phase roster (2026-10-18)

P4 returned PARTIAL after finishing all currently independent work and released the slot. Evidence: LSP/DAP/REPL suite **205/0, 686 expectations, 10 files**, Prettier clean, HorizonCode TypeScript package typecheck (`packages/opencode`) clean; REPL read APIs now enforce owner/workspace/sandbox-generation/capability-ceiling binding. P4 remains phase owner and must resume after P1's generic Guard/ExecutionHost dispatcher. Remaining P4 gates are process supervision and receipts/recovery, LSP resource admission/eviction, OS denial cases, and real Linux projects.

Current child roster: P1 Guard/ExecutionHost, P2 managed control, P6/S1 providers/settings/Doctor/question. P2's corrected `hz_kernel_process` passes 4/4; library 198/198 and direct Attempt 8/8 passed; managed-control/RPC/settlement exact totals still need rerun. P1 found direct child Attempt is not yet bound atomically to its ToolBatch effects. P2 owns HostKernel atomic bounded `bind_direct_attempt_effects` contract/tests; P1 owns Core/OpenCode child prompt→ToolBatch propagation. Task remains unavailable until both halves and no-bypass tests pass. P5, P7, P3, P8, P9 and final release gates remain queued; no phase is VERIFIED/RELEASED.

### 2026-10-18 current continuation addendum

- **Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P6 provider/settings/Doctor/S1. Child concurrency is saturated (three children); P2 currently owns the only shared Cargo test slot. P4 and P5 are partial and queued to resume on exact P1 dispatcher/HTTP contracts. P7 is next whole-phase owner to launch on a free slot; P3, P8, P9, and final release remain in V1 scope.
- **P6 Doctor delta:** parent registered the offline-only `provider.doctor.offline` route/handler in central API/server. Local offline inspection test passes 4/4 (14 expectations); no credential read, provider request, catalog/full probe, or live-probe consent path. The UI action/dialog is being wired to the endpoint. A4 audit found the new Doctor route/test/TUI files hidden; exact path exceptions were added, final integrated audit still required.
- **P6 feature settings gap:** `FeatureExposure` currently lacks complete scope/source/lock/pending/update semantics; P6 now owns that entire config contract and associated acceptance tests for FEAT-001..014. No settings completion claim until complete behavioral and cross-surface tests pass.
- **P2 direct Attempt batch binding:** plural `bind_direct_attempt_effects` API and durability tests are in place under P2. Current Rust verification: lib 198/198, `managed_control` 9/9, `managed_settlement_provenance` 35/35; `managed_control_rpc` currently 9/11 with two regressions being isolated. Remaining targets and fixed exact suite reruns are still required. Direct child effect exposure remains unavailable pending P1 caller scope propagation and no-bypass/recovery evidence.
- **P1 C15 update:** P1 now propagates private DirectAttemptAuthority from Task through child prompt, ToolBatch, Core supervisor/PTY prepare, and write/patch/terminal bodies; returned batch effect IDs bind atomically via P2's plural API before outcomes are visible, with cancel/deny on binding failure. New Core regressions pass 2/2. No child effect route is enabled: integrated Core/OpenCode/socket/no-bypass/recovery evidence is still due, and P1's generic non-PTY ExecutionHost dispatcher remains open.
- **P6 provenance correction:** initial Doctor offline schema echoed caller-supplied owner/epoch fields. Per §37.18, P6 is removing them from the read-only projection and adding spoofed-identity rejection coverage; no offline report counts as authenticated independent verification evidence.
- **P2 atomic batch binding update:** current-source `managed_control_rpc` 11/11, `direct_attempt_rpc` 10/10, `managed_settlement_provenance` 4/4, `managed_control` 9/9 and lib 198/198 passed; live-socket contract matches P1's plural binding call and rejects stale workspace revision. Earlier red expectations were stale fixtures, repaired to assert strict pre-dispatch no-write/no-retroactive-bind behavior. P2 remains incomplete because a real independent verifier/evidence adapter and complete end-to-end final-revision vertical are absent; finalization remains disabled.
- P1 focused HorizonCode CLI-host package direct-scope tests pass **115/0 with one expected V2-projector skip (516 expectations)**; P2 plural ManagedControl client tests pass **23/23, 137 expectations**. Core RPC wire assertions and further stale/forged/multi-batch negatives are in progress. Defer the one shared package typecheck until P1/P2/P6 edits and SDK generation stabilize.
- Parent reran P9 synthetic alias/installer tests: **2/2 pass**, proving package bin alias and standalone installer forwarding/alias creation against a fake candidate. Real product binary startup, clean install/migration, Linux/WSL matrix, and release gate remain unverified.
- P1 cross-contract review found Core serialized direct-scope `ownerEpoch` and `expectedRevision` as strings while Rust requires unsigned u64. P1 owns checked numeric conversion and real prepare/consume socket regression coverage; C15 remains unavailable until this passes.
- **Ruling — direct Attempt workspace rebase:** no “rehash current tree and refresh scope” after effects because concurrent human edits could be silently blessed. Keep the original admitted revision and reject later effects unless receipts prove the full resulting tree contains only that Attempt's effects, including terminal-process side effects. One guarded action is enough for the P2 V1 vertical. Cost if wrong: legitimate child multi-action work may need a new reviewed Attempt until receipt-derived exact rebasing exists.
- P2 verifier evidence depends on P7's exact-ref ArtifactStore wiring; the current Rust artifact store is a private unwired seam. P2 should complete its typed evidence/assignment contracts and fail-closed finalization, then consume P7's store API rather than duplicate storage.

### Active owner/evidence delta — 2026-10-19

| Workstream | Current integrated evidence | Remaining acceptance |
|---|---|---|
| A1/A4 parent integration | Parent added the TUI Guard approval mount and exact overlay exceptions. P2's focused approval component + app mount suite reports **4/4** green (deny-only absent assessment; assessed one-use allow). Overlay audit after P1/P7 sources appeared: `compared=6627 changed=272 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. | Rerun `bun run horizoncode:typecheck`, overlay and `git diff --check` after the current P1/P2/P7 edits settle; A2 full push gate remains open. No stage/commit/push while source/gates/ownership remain unsettled. |
| P1 Guard/ExecutionHost | Core batch projection **13/13, 73 expectations**; Rust projection **2/2**. Host projection strictly validates typed consent metadata; missing/unassessed guarantee state is deny-only. P1 is implementing exact launch-specific confined preflight binding and safe host-only verifier manifest capture. | Prove actual `PreparedTerminalLaunch` guarantee assessment bound to exact invocation/workspace/revision/profile/executable/owner epoch, one-use consume, no-spawn mismatch/stale/replay/cancel; finish enabled-origin and receipt/UNKNOWN/restart matrix. Native Windows remains unavailable. |
| P2 managed vertical | Approval Sync projection and parent app mount integrated; focused TUI suites **4/4**. Real current-workspace Goal-verification route remains fail-closed while P1 producer is absent. | Continue distinct authenticated assigned reviewer, Attempt/effect-intent/lease, live current revision, real independent verifier+safe artifact/evidence, end-to-end socket flow, pause/cancel/restart/UNKNOWN/stale/conflict. Keep finalization/fan-out disabled. |
| P7 stream/artifacts/automation/rewind | Focused Cargo evidence: ArtifactStore **3/3**, automation **16/16**, checkpoint **7/7**. These are model/consumer tests only; invocation and restore stay disabled. P7 owns the newly found transient-event sequence/gap-detection contract across schema/emitter/TUI and is hardening unknown-redaction ArtifactStore admission. | Run sequence/missing/duplicate/out-of-order resnapshot and mounted Session journey tests; close FULL/SAMPLE/FAILED artifact truth with safe host-generated manifest refs; durable automation/rewind still require accepted P1 HostKernel Guard leases and P8 recovery integration. |

Capacity remains three child owners (P1/P2/P7); P6 then other queued whole V1 phases start only as slots free. C: last checked at 25 GB free; `kernel/target` 12 GB. The P2 note review and immutable Codex CLI/OpenCode subagent comparison remain recorded above; no new coordinator/runtime was adopted. V1 is still PARTIAL, not VERIFIED or RELEASED.


### 2026-10-19 resumed owners and evidence

This supersedes older active-roster statements above. Live whole-phase owners are **P1 Guard/ExecutionHost**, **P2 managed vertical**, and **P8 resources/workers**. P7 is partial and queued; P6, P3, P4, P5, P9 and final release gates remain open.

| Workstream | Latest source/evidence | Remaining acceptance |
|---|---|---|
| P1 | Active verifier challenge-set resumption is bound to immutable verifier profile ID/principal/profile/executable/sandbox digests. RED-first focused suite then passed `verifier_challenge_retention_tests` 2/2. Unused adapter/token warnings remain because the production verifier launch/mint path is absent. | Complete Guarded `managed_run` launch through durable intent, one-use lease, confined process, bounded output and receipt before minting; finish generic process/shell origins, C15, origin closure, ToolBatch/UNKNOWN/cancel/restart and adversarial matrix. |
| P2 | Forged body principal test rejects unauthenticated `host_os` review before managed snapshot dispatch: 1/1 (2 assertions), typed 403. | Complete real Attempt-bound guarded action, independent verifier evidence bound to actual final workspace revision, Core→TUI delivery and real-socket pause/cancel/restart/UNKNOWN/stale/conflict acceptance. Keep finalization/fan-out disabled. |
| P8 | RC0 Python tests 48/48; authorized Cargo `--lib` 263/263 and all selected `jc_res_012_wire`, `resource_sampler`, `task_dag`, `worker_durable`, `worker_pool`, `worktree_pool` targets exited 0 (combined integration total unavailable due truncated output). P8 found TaskGraph delivery accepts a touched-file source revision different from its envelope revision. | Add fail-closed mismatch regression and fix, then prove current-generation conflict signals, resource/quota recovery and owned process/worktree lifecycle; capture authentic Linux 1/5/10/20-session baselines and prove worker ingress/launch obeys P1 Guard and P2 Attempt authority. |
| A1/A2/A4 | Overlay audit: `compared=6627 changed=272 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` passed. Git MCP: main, 150 staged / 165 unstaged / 83 untracked, zero conflicts. | Rerun HorizonCode CLI/TUI/Core typecheck and final overlay/architecture audits, then full push gate on the final integrated revision. Resolve exact ownership before staging/publishing. |

C: has 25 GB free; `kernel/target` is 12 GB and root `node_modules` 2.5 GB. P8 gets the next single focused Cargo slot; do not overlap heavyweight builds. The note review and Codex CLI/OpenCode worker-allocation comparison remain recorded above and introduce no second runtime or autonomous effect authority. V1 is **PARTIAL**, not VERIFIED or RELEASED.

### Owner handoff update — 2026-10-19

P8 completed independent implementation and returned **PARTIAL**. The TaskGraph now rejects a touched-file candidate whose source revision differs from its delivery envelope (RED 0/1, GREEN 1/1); candidate metadata is still not a trusted conflict signal. RC0 Python tests passed 48/48; the authorized Rust wave passed (`--lib` 263/263 and each selected target succeeded; combined count unavailable from truncated output). P8's remaining real worker ingress/launcher, file-observation, filesystem worktree, and 1/5/10/20 baseline requirements are blocked on P1 Guard and P2 managed scope/evidence. Resume P8 when those contracts are parent-verified.

The active whole-phase roster is now P1 Guard/ExecutionHost, P2 managed vertical, and P6 providers/settings/Doctor/S1. P2 owns the next serialized Rust edit/test for fresh challenge-set retry after restart in a no-evidence `Verifying` Run, fenced to the existing assigned verifier and actual final revision with all Tasks settled; P1's HostKernel retention regressions remain source-only until that Rust slot is released. P6 owns the newly freed phase slot and all independent provider/settings/Doctor/S1 work. P7, P3, P4, P5, P8, P9 and release proof remain open; dependencies do not permit unsafe effect enablement.

P1 origin audit added `packages/core/src/git.ts` to its owned closure: clone/fetch/checkout/reset and any branch/commit/push child-process route must use Guard/ExecutionHost or fail closed before dispatch with zero-effect tests. Preserve read-only Git routes; do not silently leave a legacy process/network origin enabled.

P2's durable verifier restart case passed RED/GREEN 0/1→1/1. A clean retry is allowed only while Run is `Verifying`, same assigned verifier and actual frozen revision, and no criterion/typed evidence, with settled Tasks and no UNKNOWN/active Attempt. Reopen increments durable log revision but preserves Run, verifier, final revision and evidence history; it creates no lease or Attempt. Evidence-bearing same-revision retries remain rejected. P2 released Cargo; P1 takes the next single Rust retention selector.

P1 has one new origin regression queued: its first Bun invocation stopped before tests due to a fixture syntax error (`await` in synchronous `Effect.gen`). P1 is changing the fixture to `Effect.promise` and will rerun after P6's active JS suite; no acceptance credit until then.

P6 found four Cloudflare OpenAI passthrough test failures caused by inherited host `OPENAI_BASE_URL` overriding the canonical gateway endpoint before transport; native Anthropic/Workers routes passed. P6 is correcting the explicit OpenAI endpoint binding and adding a Provider-service regression; this was test-transport only, no external request. Provider Doctor live tiers stay unavailable until guarded consent/network support is parent-verified.

P1 has test-first retention corrections in the current Rust slot: capacity zero must retain no verifier challenge set, and UNKNOWN challenge sets cannot be pruned until reconciled. Only Aborted/Settled history is evictable; selector result is pending.

P1 completed the verifier-retention correction RED 2 failures → GREEN 3/3: capacity 0 admits no challenge set; UNKNOWN is retained; only Aborted/Settled states are evictable; active reuse is bound to immutable profile ID/principal/profile/executable/sandbox digests and live reviewer/epoch/spec/revision/state. P2 owns the next Cargo selector for the missing typed-evidence retry negative test.

P1 source audit confirms GitV2 (`@opencode-ai/core/git`) has test-only callers; production routes use a separate VCS service. GitV2 mutations can be disabled with zero-process/no-filesystem-change proof without breaking live VCS reads. RED/GREEN is pending P6's active Bun suite. Direct guarded VCS apply remains separate and unverified.

P2's in-module typed-evidence rejection for a clean same-revision verifier retry passed 1/1 after correcting a test-fixture identifier; no evidence-bearing retry can mutate Run state.

P6 fixed inherited `OPENAI_BASE_URL` interference by binding the Cloudflare gateway to its explicit native OpenAI baseURL; focused provider tests pass 14/14 (42 assertions), with no external network. Broader provider/auth/config/S1 evidence currently reports 891 passed, 1 existing skip, and 6 failures before the four Cloudflare fixes; two DigitalOcean legacy router expectations remain. P1 and P6 are resolving whether these are non-effectful registry routes versus effectful plugin dispatch. A narrow Settings requested-pending test is in progress.

### Independent full-note and competitor re-review — 2026-10-19

A second reviewer read all 1,851 physical lines of `/mnt/c/Users/Sonali/Downloads/extra_some_Stuff.md`, rechecked the active architecture/plan/scope decision, and audited the earlier intake table above. Its main rulings remain valid: no second `veod` daemon, `.agent/` authority plane, autonomous specialist factory, unsafe credential proxy, production auto-healing/deployment, or speculative performance promise; no architecture amendment is justified. Useful ideas remain owned by P2/P3/P6/P7/P8 and their existing Guard/Attempt contracts.

Additional correction for the existing note analysis: the proposed AST node ID includes offset and body hash, so edits can invalidate IDs; the splicer does not bind the supplied skeleton to current source, misses same-offset zero-length insertion conflicts, and does not reparse merged output. Treat it as source-navigation research only. Acceptance for any future navigation adapter must bind results to current RepoIntel generation/revision, reject or re-resolve stale IDs, validate parse output, and continue all writes through current-revision `files.patch` + Guard.

Competitor claims now carry an explicit moving-version caveat. Current official [Codex subagent guidance](https://developers.openai.com/codex/subagents) supports bounded parallel specialists, summaries, visible/steerable child work and configured concurrency; it also warns about token cost and write conflicts, and documents inherited sandbox/approval policy. Current [OpenCode agent docs](https://opencode.ai/docs/agents/) support specialized profiles and progress UX, but `permission.task` is not an effect-security boundary because direct `@` invocation remains possible. HorizonCode may adopt the allocation/UX patterns only; Rust Task/Attempt/Guard remains the authority. This independent report supplements the earlier pinned source comparison; it changes no phase status or acceptance evidence.

### RepoIntel bridge proposal — pending architecture/interface review

P3's reviewer proposed an embedded HostKernel upload/query interface to avoid sending a ~72 MB GenerationPack through the existing 6 MiB RPC: host-authenticated begin/chunk/commit/abort, binary chunks capped at 512 KiB, contiguous offsets, exact total length and BLAKE3, total upload capped at current indexd generation bounds, short TTL and aggregate concurrency caps. Host would derive principal, Session/Attempt, workspace, revision, read scope and source pins from trusted ingress/owners; caller-provided root/principal/scope digests would confer no authority. Commit would validate and atomically publish an immutable generation; abort/disconnect/timeout/restart/epoch change would clean or reconcile uploads. Queries would pin exact generation/owner-issued overlay and return source revision/generation, completeness/freshness and typed errors; they grant no later patch authority. This is a proposal only: no new operation is accepted, schema is not registered and production symbols remain disabled. Parent/P1 must reconcile it with §§13/14/30/37 and actual HostKernel IPC before P3 wires any path. Tests must cover malformed chunks, spoofed identities, cross-workspace access, epoch/restart UNKNOWN, cancellation, atomic publication, provenance, bounds and stale-patch rejection.

### Quota-reset continuation — 2026-10-19 (current)

The three active phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, and P7 streaming/artifacts/analytics/automation/rewind. P2 remains PARTIAL and is queued to resume its whole phase when a slot opens. P3/P4/P5/P8/P9 and final release work remain open. P1's latest expanded CLI/Azure/install/format/project/Git origin bundle passed 79/0 (217 assertions), and Core Git zero-effect passed 8/0 (31 assertions). `horizoncode-sandbox` is wired through HostKernel terminal consent and stdio preflight/launch into `spawn_prepared`; actual containment/no-bypass acceptance remains unverified. P6's broad suite exposed blocked local dummy-key mock streams and loss of the hosted-workflow typed unavailable error; P6 owns repair without loosening production zero-dispatch. P7 is implementing OwnerLog prospective-event admission source-only while an unrelated LiteCowork Cargo build runs. Current parent audits: overlay 6,627 compared / 303 changed / zero hidden or stale entries; `git diff --check` clean; convergence 1,226 checks / zero failures; Markdown 280 files / zero active blockers / 62 reference-only warnings. C: has 24 GB free; `kernel/target` 12 GB; `node_modules` 2.5 GB. A1/A2 and integrated final-revision acceptance remain open. Preserve all mixed staged/unstaged/untracked work; no staging, commit, push, cleanup or prune. V1 is **PARTIAL**.

P1 follow-up after the quota-reset checkpoint: the six-file Core runner/supervisor/terminal/shell bundle passed **143/0, 636 assertions** (121.56 seconds), covering the previously failing runner fixtures plus live HostKernel Guarded terminal allow/deny, one-use lease, timeout/nonzero settlement, cancellation, bounds/no-spawn and missing-executable preflight. This is focused P1 evidence, not phase acceptance. P7's OwnerLog prospective-event-size RED cases are source-present and rustfmt-checked; behavioral RED/GREEN waits for the serialized Cargo slot.

### VEO design and current execution delta — 2026-10-19

The note review and post-V1 phase map are in `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md`. P1/P2/P3/P6/P7/P8 now include the accepted design refinements under A-V2-33; VEO-F1..F8 remain post-V1 proposals. The note does not authorize another runtime, event bus, contract registry or effect authority.

Correction: bounded subagents, evidence-linked delivery, RepoIntel navigation, independent verification, provider truth/provenance, worker/resource bounds and skill trust are mapped back to their existing V1 phase owners in the design. The post-V1 table covers only extensions beyond those already-required V1 obligations.

Latest owner messages: P1 debug-agent CLI tests passed 4/4 (12 assertions), including malicious-JS zero-effect. Its shell-interpolation selector timed out waiting for supervisor socket startup and never reached approval/spawn, so it remains unresolved. P1 is running the `packages/core` typecheck; `packages/opencode/src/storage/storage.ts` already uses GitV2 APIs in the shared tree. P6 corrected Secret Service rotation failure injection after its first RED hit the wrong journal write; the corrected RED reproduces deletion of the previous item before metadata replacement, and P6 is implementing journaled activation/recovery. P6's broad `test/session/llm.test.ts` rerun passed 36/36 (106 assertions). P7's checkpoint eviction preview and blocker/bounds tests are source-present and rustfmt-clean; no Cargo behavioral run yet. LiteCowork's Windows Cargo qualification is still active, so do not overlap Rust builds. C: remains at 23 GB free; `kernel/target` 12 GB; `node_modules` 2.5 GB. No phase is accepted; V1 remains **PARTIAL**.

Correction/update: P1 reports `cd packages/core && bun run typecheck` exited 0 with no diagnostics, including the `storage.ts` GitV2 migration. Bun is released to P6 for its corrected Secret Service rotation/store suite. Latest measured C: free space is 22 GB; the LiteCowork Windows Cargo qualification is still active and remains untouched.

P6's standalone store suite passed 14/14 (53 assertions); the earlier combined store+broker attempt had a separate unnamed lifecycle-hook timeout and is not counted as green. P6's pending next-turn setting test first failed as expected because a new root prompt left `compaction.auto` unapplied; P6 owns the `promptWork` ingress correction, with P1 confirming no overlapping edits in that function. P1 found additional unsafe `session delete` and `agent create` CLI origins and added pre-dispatch unavailable gates plus zero-effect tests; those tests await Bun. The HTTP `Project.update` mutation is under source/ownership review and is not yet claimed mediated or disabled. Overlay rerun is clean: 6,627 compared / 303 changed / zero missing, hidden or stale paths. C: has 22 GB free.

P6 completed the root-turn config fix test-first: `bun test test/session/prompt.test.ts -t 'applies pending next-turn feature settings before persisting the next root prompt|pending feature settings apply only at root turn boundaries'` passed 2/2 (5 assertions). The call is limited to root ingress (`directAttempt === undefined`); child Attempt turns stay pinned. P1 next takes the released Bun slot for its CLI-origin and Project.update zero-effect bundle.

P1's rerun is green: `test/cli/guarded-legacy-origins.test.ts` passed 1/1 (29 assertions), and `test/server/project-init-git.test.ts` passed 3/3 (15 assertions), including HTTP `Project.update` 503 with unchanged DB state and no `project.updated` event. P1 identified further unguarded CLI MCP-config, OAuth credential, and plugin-install/package-manager origins; it now owns the mediate-or-disable closure and zero-effect tests. P6 is taking the released Bun slot for the post-activation credential-rotation crash/recovery test. The external LiteCowork Cargo builds continue to block HorizonCode Cargo.

P6's post-activation crash recovery selector passed 1/1 (8 assertions): reopen reconciles failed retirement of the old keyring item after activation. P6's Secret Service store evidence is now 14/14 + 1/1 focused green; combined store+broker still has one unnamed teardown-hook timeout and must be isolated before broader acceptance. P1 now includes MCP config, auth/logout/provider commands, account login/logout/switch/open/orgs, and plugin-install CLI origins in its mediate-or-disable audit; effects remain disabled pending focused zero-side-effect tests and P6's safe replacement route.

P6 added a RED-first credential-denial plugin-loader counter; it failed before the fix because `provider.getProvider()` invoked plugin hooks before the broker gate. P6 moved the config/auth/model credential check ahead of provider construction and retained a post-resolution credential check. Focused selector now passes 1/1 (3 assertions) with zero plugin model/auth hooks and zero HTTP requests. Full LLM, broker, and prompt reruns remain queued. Do not treat this as completion of SecretBroker production transport.

Correction: the post-fix full `test/session/llm.test.ts` rerun passed **36/36, 107 assertions**. The new in-run counter proves the denied LLM call does not resolve Provider.Service/list plugins; P1 separately owns the plugin loader's fail-closed/zero-import contract. SecretBroker production transport, provider auth and live Doctor probes remain unavailable.

P6's latest isolated durability evidence is green: `secret-service-store.test.ts` 15/15 (61 assertions), including both rotation failure windows, and `secret-broker.test.ts` 10/10 (42 assertions). The prior combined command's unnamed teardown timeout is isolated to the combined lifecycle, not reproduced in either standalone suite; it remains documented until the combined run is understood. Bun is released to P1.

P7's checkpoint selectors now pass on current source: oversized OwnerLog state record rejected before publication 1/1; escaped OwnerLog command digest rejected before publication 1/1; full `checkpoint::` module 14/14 (includes eviction-preview bounds/blockers and CP-001/CP-002/partial UNKNOWN); rustfmt clean. No RED run was captured before implementation, so these are green tests, not a proven RED→GREEN sequence. P7 released Cargo. The checkpoint module is source/test-complete for these cases, but effectful eviction/rewind still depends on P1 Guard and P8 recovery integration.

Roster correction: P7 returned PARTIAL after completing its checkpoint work; the freed whole-phase slot is now assigned to P2. Current active owners are P1 Guard/origin closure, P2 managed vertical, and P6 providers/settings/Doctor/S1. P7's remaining independent stream/artifact/automation work is queued for the next child slot; effectful rewind/eviction remains dependency-gated. C: is 20 GB free and external LiteCowork Cargo is active, so HorizonCode Cargo is held.

### Required phase refinements from the complete VEO note review — A-V2-33 (2026-10-19)

The full note review selected mechanisms to strengthen existing V1 owner acceptance. This section updates required phase scope; it does not create VEO runtime phases or promote code status. Normative HLD/contracts/flows/events/tests are in architecture §§1.14, 3.21, 4.13, 12.18, 29.20, 30.23, 31.19, 32.38 and 37.22.

| Required V1 owner | Added acceptance from note review | Dependency / owner boundary | Current state |
|---|---|---|---|
| P1 Guard/ExecutionHost | Bind every managed child/helper effect to authenticated Attempt scope, accepted criteria, capability ceiling, workspace/source revision, one-use lease and budget. Keep RepoIntel refs read-only. Prove deny-before-dispatch, confinement, cancellation and UNKNOWN/restart. | P1 owns Guard/preflight and all origin closure; P2 supplies managed Attempt state. No dependent effect becomes enabled before tests pass. | IN PROGRESS; product confinement and origin closure not fully verified |
| P2 managed vertical | Deliver one bounded child from accepted SpecVersion → Task/Attempt → Guarded action → receipt/artifact/evidence → independent verifier bound to actual current workspace revision. Persist immutable profile revision/digest, criteria subset, workspace/source lease, capability ceiling, bounded context selection, budget/resource lease refs and owner epoch in canonical `DelegationBindingV1`; child delivery preserves evidence lineage. Distinct authenticated reviewer; accepted deterministic checks may block but never grant authority/change criteria; no self-PASS. | Requires P1 verified action dispatch and P7 immutable ArtifactStore refs. Fan-out remains disabled until full P2 acceptance and P8. Missing trusted binding or live lease denies before preparation. | IN PROGRESS; schema/fixture/protocol tests assigned to P2; verifier intentionally fail-closed pending P1/P7 |
| P3 RepoIntel | Bounded structural query/pages, generation/revision/file-digest-bound refs, parser/coverage/fallback provenance, stale rejection; edits only through `files.patch` + Guard. | One embedded/rebuildable RepoIntel owner; authenticated query scope, existing generation pins and HostKernel frame limits. | REQUIRED; production bridge and integrated evidence remain open |
| P6 providers/settings/Doctor/S1 | Preserve selected provider/model; expose cache/cost as reported/measured/estimated/unknown; absent usage or price remains unknown, never inferred zero or hidden route. Skill/profile proposals stay inert until registry/policy review and explicit activation. | P6 provider/auth/config and usage producer/schema/projector owners; P1 guards external effects; P7 owns UI renderer/analytics projection. | IN PROGRESS; new cache/price zero-coercion defect assigned; no live paid fallback, credential route remains gated |
| P7 stream/artifacts/analytics/automation/rewind | Link compact bounded/redacted progress to canonical full artifacts; durable events replay by owner cursor; ephemeral progress can coalesce; exact FULL/SAMPLE/FAILED and analytics provenance. | P7 owns artifact/UI/analytics; P1/P2 gates all effectful automation/restore and verifier artifact consumption. | REQUIRED; remaining phase work queued after bounded checkpoint result |
| P8 resources/workers | Include child, test, index and verifier work in owner-attributed reservations; preserve UNKNOWN and do not terminate foreign work or change provider/model under pressure. | Worker fan-out depends on verified P2 Attempt/verifier; use existing resource/lease owners. | REQUIRED; final Rust regressions and product baselines remain open |

P4, P5 and P9 remain in their existing V1 scope. VEO-F1..F8 are post-V1 proposals only and cannot be used as release blockers. A-V2-33 does not claim any phase passed; statuses and exact evidence remain in the table above and the active continuation ledger.

**P2 contract gap found during implementation:** current `ManagedAttemptScopeV1` does not persist the immutable profile/capability/context digests in the §12.18 `DelegationBindingV1` design. P2 is implementing the canonical `contracts-v2/delegation-binding-v1.schema.json`, shared golden fixture and Rust decoder tests; P1 owns HostKernel live-state resolution and Guard/ExecutionHost enforcement. `ManagedAttemptScopeV1` is a new uncommitted private envelope, not a released contract; its new u64 fields must use canonical decimal-string wire values and it must carry the binding digest. Missing trusted binding fields or live leases must deny admission before effect preparation. Managed effect/verifier enablement remains fail-closed until the binding is populated from accepted durable state and P1/P7 dependencies are verified.


### 2026-10-19 continuation checkpoint

- P2's persisted delegation-binding integration selector is green: `cargo test --manifest-path kernel/Cargo.toml --test managed_control immutable_delegation_binding_is_atomic_replayable_and_required_for_effect_intents -- --nocapture` → 1 passed. It proves denial before binding, stale admission revision rejection, replay/idempotence, authorized intent while live, exact binding retention on reopen, and `UNKNOWN` fencing that denies redispatch. P2 still owns the whole managed phase; production binding inputs, actual-workspace verifier evidence, Core→TUI review delivery, and final real-socket recovery remain open.
- P1's corrected shell interpolation journey reached successful Guard approval and terminal dispatch; receipt/process succeeded and the marker exists, but the interpolated text did not reach the follow-up model input. This is a real continuation-path defect P1 owns, not a fixture issue. The Bun lane is released. Continue P1's full origin, lease, receipt, cancellation/restart and confinement matrix; effectful dependent routes remain gated.
- P6 retains top-level V2 `usageProvenance`; no shared P7 projection reshuffle. Its latest schema/provider gaps remain under source work; its focused schema/OpenCode/Core rerun is queued behind P2's managed TS selector. Offline Doctor remains truthful UNKNOWN without a supplied offline source; provider catalog/network probes remain Guard-gated.
- Current child roster remains P1, P2, P6 (all whole-phase owners); P3/P7/P8 and other unfinished V1 phases/release work are queued until slots free. C: `/mnt/c` has 22 GB free; `kernel/target` is about 12 GB and `indexd/target` 269 MB. One worktree; no conflicting processes reported. Preserve the mixed staged/unstaged/untracked tree; no staging/publication or cleanup. V1 remains PARTIAL.


Correction to the 2026-10-19 continuation checkpoint: P6 reran the focused V2 usage provenance checks after schema tightening and cache-write fallback changes. Results: schema + event stream 3/3 (27 assertions), OpenCode producer 3/3 (14 assertions), Core projector 1/1 (3 assertions). V2 remains top-level `usageProvenance`, preserving `unknown` rather than coercing missing cache/cost data. These selectors do not close P6's provider/settings/Doctor/S1 phase. Bun is now assigned to P1's test-first interpolation continuation repair; Cargo is assigned to P2's managed-control integration binary.


P2's full `managed_control` integration binary is currently blocked before test execution by a P1-owned borrow-check error in `kernel/src/host_kernel.rs` (E0502 around lines 8713–8734: immutable `host.locations` borrow overlaps mutable managed snapshot access). P2 released Cargo; P1 owns the repair and must notify P2 when the Rust lane is ready for the full binary retry. This does not invalidate the separately green 1-test persisted-binding selector.


Correction: P1 repaired the managed-control compile blocker by cloning the validated canonical workspace root before borrowing managed control mutably, then released Cargo to P2 for the full integration binary retry. This source fix is not yet independently verified; the retry is pending. P1's interpolation journey remains unresolved after successful terminal execution because the generated model input omits the command output.


P2 full managed-control integration retry after the P1 compile fix built successfully and ran 38 tests: 33 passed, 5 failed. Four P2-owned scheduler/fan-out fixtures need valid criterion IDs in their test binding helper; one final-revision test now correctly rejects a stale verifier path because typed independent evidence is missing. P2 owns fixture/evidence repair without weakening the new contract and will rerun the complete binary. The managed-control TypeScript malformed-scope selector also passed 2/2 (34 filtered), including typed error before RPC. Cargo and Bun are released; P6 is taking Bun for its independent next selectors/source work.


Correction: P1 traced the interpolation selector's empty model-input assertion to the positive test inheriting `apiKey: "test-key"` from shared `providerCfg()`. P6's credential gate correctly denies provider dispatch when the fixture carries that credential; terminal execution and receipt had succeeded. P1 is removing the key only from the local-server positive fixture and retaining separate credential-denial coverage. Treat the prior “continuation-path defect” wording as superseded; this was fixture setup, not production interpolation behavior.


Correction: P1's shell interpolation acceptance selector is green after a fixture-only change to use an uncredentialed local `test` provider while keeping the mock server URL. `cd packages/opencode && bun test --timeout 180000 test/session/prompt.test.ts --test-name-pattern 'single slash-command shell interpolation executes after Rust approval and returns its outcome'` → 1 pass / 0 fail, 13 assertions, 10.45s. It verifies Guard `allow_once`, process/receipt marker, and `INTERPOLATION_APPROVED` in the next model input while preserving separate credential-denial coverage. This selector does not close P1's remaining origin/confinement/batch/recovery matrix. Bun is released to P6's Guard-gated provider-transport adapter work.


P1's focused HostKernel selector compiled but did not reach its intended stale-binding assertions: the fixture returned `feature_not_negotiated` before it could assert `managed_not_found` (0/1 selector). P1 will update the test fixture to negotiate the managed feature through the real path; production feature gating remains unchanged. Cargo has returned to P2 for the full managed-control retry; avoid concurrent edits/builds against `host_kernel.rs`.

Current read-only audits after tracker updates: `audit_markdown_repo.py` reports 280 tracked Markdown files, 0 active blockers and 62 archive-only warnings; `validate_convergence.py` reports 27 schemas, 205 catalog IDs, 225 registry IDs, 1,227 checks and 0 failures; overlay visibility reports 6,627 compared, 311 changed, 0 hidden changes/new source/stale unignore. C: remains 22 GB free; Rust target trees 12 GB and 269 MB.


P2 repaired the four invalid managed test bindings; the next full managed-control binary reached 37/38 passing. The final failure is an obsolete scheduler regression assuming digest-only `RecordCriterionEvidence` can finalize a Run. P2 is replacing it with a negative finalization assertion plus typed independent evidence acceptance for revision B and stale revision A rejection. Cargo is free during this edit. P1's focused HostKernel test also needs `set_effects_enabled(true)` in the fixture to reach the managed stale-binding check; P1 is editing that separate test fixture and will hand Cargo back to P2 for the next integrated binary.


P1 HostKernel selector after adding the effects-v2 fixture negotiation passed that earlier gate and reached the intended denial path; it then exposed a P1 test assertion that incorrectly expected the ephemeral approval challenge to remain after denial. Production correctly removes denied challenges. P1 will update the assertion to require challenge removal and no lease; no Rust build until P2's managed-control retry finishes.

P6's private provider transport adapter has now been strengthened before production wiring: its digest binds provider, POST method, exact HTTPS destination, auth-header mapping, canonical sorted ordinary headers and body; mismatch is denied before broker consumption/send. It carries cancellation/deadline to one send and bounds streamed responses to at most 10 MiB. The focused SecretBroker transport suite passed 13/13 (57 assertions); P6 then replaced locale-sensitive header sorting with deterministic code-point order, so one short rerun remains. The production provider dispatcher remains unwired/fail-closed pending P1 Guard acceptance.


P2's corrected full Rust managed-control integration binary is green on integrated P1 source: `cargo test --manifest-path kernel/Cargo.toml --test managed_control -- --nocapture` → 38 passed, 0 failed, 0 ignored (12.63s). Coverage includes persisted binding admission/replay/restart-UNKNOWN, no digest-only finalization, and cancellation of incomplete verification. P2 still owes a focused Rust library unit run for stale revision-A rejection/current typed revision-B acceptance, real-socket lifecycle/review integration, and the full actual-workspace verifier/artifact vertical; Cargo is with P1 for the corrected HostKernel selector. P6 owns the Bun lane for provenance/header-order/Doctor/S1 selectors.


P2's added typed-evidence unit test is green: `cargo test --manifest-path kernel/Cargo.toml --lib managed_control::managed_verification_evidence_tests::new_final_revision_rejects_stale_evidence_then_accepts_typed_current_evidence -- --nocapture` → 1/1, 299 filtered. It rejects revision-A evidence after moving to B, accepts typed independent evidence bound to B, and permits the manager transition. P1's focused test correction (assert denied challenge is removed and no lease exists) is pending a rerun; the prior failure reached the intended managed denial path.

P6 hardened provider transport with deterministic canonical headers, lease-bound digest, abort/deadline and bounded streamed response tests. Latest `secret-broker.test.ts` passed 14/14 (61 assertions), proving deadline abort, one lease/send and auth-header cleanup. P6 now owns the serialized HorizonCode CLI-host package/LLM typecheck slot; production provider dispatch remains disabled until P1 network Guard acceptance.


P1's corrected focused HostKernel managed denial selector is now green: `cargo test --manifest-path kernel/Cargo.toml --lib host_kernel::tests::stale_or_changed_managed_attempt_scope_is_denied_before_approval_lease -- --exact --nocapture --test-threads=1` → 1/1 passed (299 filtered); it verifies deny-before-EffectHost DB creation and challenge removal. P1's source audit then found a recovery revalidation gap: recovered scope verifies immutable binding lineage/current workspace/effect intent but not the envelope's expected OwnerLog revision or current active Run/Task/Attempt phase/identity. P1 owns tightening recovery and deny/no-relaunch tests. Do not claim P1 complete.


P6's integrated HorizonCode TypeScript package typecheck (`packages/opencode`) currently fails after the new transport work. P2 reports no diagnostics in P2-owned `src/session/managed-control.ts`; diagnostics are in P6-owned `src/session/llm.ts`, `src/session/session.ts`, `test/auth/secret-broker.test.ts`, and `test/session/llm.test.ts`, plus two existing test files (`test/project/worktree.test.ts`, `test/tool/repo-tools.test.ts`) that require confirmation whether newly introduced. P6 owns exact output triage and repairs, then must rerun the package check and `packages/llm` typecheck. No P6 typecheck acceptance is claimed yet.


Correction: P6 captured the exact typecheck diagnostics after the failed HorizonCode CLI-host package check: `session/llm.ts` uses invalid `configured.key`/`configured.headers`; `session/session.ts` has possibly-undefined token and price inputs for estimated cost; `test/auth/secret-broker.test.ts` fixtures omit the newly required `signal`/`maxResponseBytes` and widen credential-header names; `test/session/llm.test.ts` has duplicate `env`. P6 owns those repairs, then will rerun HorizonCode CLI-host package and `packages/llm` typechecks serially. Remaining diagnostics in `test/project/worktree.test.ts` and `test/tool/repo-tools.test.ts` belong outside P6 and must be triaged to their phase owners after current fixes.


P6 typecheck progress: after fixing its four production/test paths, `packages/llm bun run typecheck` passed with no diagnostics. HorizonCode CLI-host package now has no reported P6 errors; only queued P8 `test/project/worktree.test.ts` errors (Interface `.run` missing at lines 68/75 and Effect environment `unknown` at 124/154/246/269) and P3 `test/tool/repo-tools.test.ts:220` overload mismatch remain. These are exact phase-owner tasks, not P6. P6's strengthened provider transport suite passed 15/15 (62 assertions), including canonical header order, changed-field denial before lease consume, one-use replay denial, cancellation/deadline, and bounded response. Production dispatcher remains unwired.

P1 owns a narrow compile repair in `kernel/tests/managed_settlement_provenance.rs` (fixture helper must return `RpcResponseV1`; `expectedManagedRevision` is a decimal-string wire value); P2 confirmed no concurrent edits to that file. P1 will run its selector and return Cargo to P2.


P1's `managed_settlement_provenance` compile/behavior selector is now green: 5/5. The corrected denial assertion checks zero durable effect challenges, zero workspace mutation, Attempt remains EXECUTING with no effect edge/receipt; it no longer falsely assumes `register_location` leaves no database file. Cargo is released to P2 for the atomic binding seam RED/GREEN. P1 is source-only on recovery predicate/test design until that Cargo wave ends.

P6's latest usage regression caught that the cost estimate consumes adjusted token counts, while `tokenInputs` recorded raw counts. P6 corrected provenance to record adjusted non-cache input and non-reasoning output; focused HorizonCode CLI-host package usage tests pass 2/2 and the SecretBroker/transport suite 15/15 (62 assertions). HorizonCode TypeScript package typecheck (`packages/opencode`) rerun is queued for this exact source revision.


P6 reran HorizonCode TypeScript package typecheck (`packages/opencode`) after its final usage-cost adjustment: it exits 2 with the same four P8 `test/project/worktree.test.ts` diagnostics and one P3 `test/tool/repo-tools.test.ts` diagnostic; no P6-owned diagnostics remain. `packages/llm bun run typecheck` passed earlier with exit 0; the last cost adjustment was HorizonCode CLI-host package-only. Final integrated product typecheck remains blocked until the queued P3/P8 owners repair their paths.


P2's new managed delegation admission seam test is green: `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib managed_control::managed_delegation_admission_tests::delegation_admission_derives_accepted_scope_and_rejects_stale_owner_facts -- --nocapture` → 1/1 passed, 300 filtered (compile 1m04s). It derives accepted scope from durable managed state and rejects stale owner facts. P2 is now implementing one composite OwnerLog admission event so `Attempt`, workspace revision and immutable `DelegationBindingV1` share the exact post-append managed revision; no separate partially-bound interval. The integration selector remains pending. Cargo lane is free for P1 recovery work.


P1 recovery implementation is now source-present but awaits cross-phase compile: it binds recovery validation to the expected managed revision's persisted effect-edge lineage, requires the exact managed effect edge, requires restarted in-flight Attempt UNKNOWN with matching active Task/unknown-effect and Run RECONCILING/CANCELLING, validates terminal target + OwnerLog receipts and matching exit outcome, and keeps `status_execution` read-only/no-relaunch. Direct recovery also validates workspace/effect-edge revision floor and phase/receipt rules. Its focused compile currently stops because P2 is implementing the referenced `admit_attempt_with_delegation` method; P1 is working independent origins source-only until P2 reaches a compilable checkpoint.

P6's integrated selector wave is green: HorizonCode CLI-host package 193/0 (493 assertions, 9 files); TUI 30/0 (120, 4); Core FeatureExposure 13/0 (58); Schema Doctor/SecretBroker/usage/event 13/0 (70). It includes full LLM/config and next-turn behavior, offline Doctor/no-network, S1 route/tool, local provider/model switch/price, and Secret Service rotation. `packages/llm` typecheck passes; HorizonCode TypeScript package typecheck (`packages/opencode`) is clear for P6 but remains blocked only by queued P3/P8 test diagnostics. P6 remains PARTIAL: production SecretBroker auth/transport is still unwired, OS login keyring integration/accepted live free-model journey are absent, and guarded network/catalog probes remain unavailable pending P1.


P6's production credential boundary ruling: raw `Auth.Info`/`Auth.set` are not safe for V1 SecretBroker because they expose raw key/access/refresh values; §14.7/§12.17 requires puts to receive only an opaque `secureInputHandle`. P6 is implementing a lazy metadata/store surface (`put` accepts only SecretBroker PutRequest + opaque handle; `describe/revoke` return metadata), backed by SecretBroker + Linux Secret Service store. Legacy raw `Auth.get/all` remain empty, raw `set/remove` unavailable, ProviderAuth denied until guarded secure-entry exists; no D-Bus startup probe. Injected lifecycle/restart/denial tests can pass here, but actual OS integration is NOT VERIFIED because no Secret Service is installed in the session.


P1's six-file CLI/origin bundle ran 7 passed / 1 failed with 77 assertions; its sole failure was a stale expected unavailable-message string in `provider-url-auth-disabled.test.ts`. P1 updated only the expectation to the current typed unavailable message and reran that file 1/1 (7 assertions). Combined final evidence for the touched set is 8/0 (the other seven tests passed in the bundle), covering providers list zero HTTP/cache, MCP/auth/console/plugin zero effects, legacy process/mutation denials, MCP add config denial, installer upgrade zero effects, Snapshot zero process and URL-provider login zero fetch/spawn/auth mutation. Wider P1 ToolBatch, authenticated Task/subagent, receipt/UNKNOWN/cancel/restart, actual confinement and final integrated matrix remain open.


P1 recovery predicate suite is green: `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib recovery_ -- --nocapture --test-threads=1` → 3/3 passed, 301 filtered. Coverage includes persisted-owner UNKNOWN, UNKNOWN + Run RECONCILING/CANCELLING + matching active Task fence, denial for live/executing or mismatched owner phases, managed terminal target/OwnerLog receipt and exit-outcome mismatch, and direct receipt/outcome mismatch. This is predicate-level evidence only; production recovery still needs trusted binding/live-lease construction and real process/no-relaunch journey.

Parent integration review found P2's generic `ManagedDelegationAdmissionFactsV1::from_owner_proofs(raw strings/u64)` constructor too forgeable to serve as an owner proof seam even though crate-private. P2 is replacing it with composed opaque typed proofs created by P1 HostKernel execution/workspace, P8 durable lease, and P2 registered profile/context owner services. No IPC layer may construct these. Until every proof constructor resolves live canonical state, managed effect binding remains unavailable.


Integrated rerun after P2's atomic admission implementation: P1 `recovery_` module still passes 3/3 (301 filtered) against current shared source. P1 released Cargo to P2 and continues source-only on managed effect cardinality and remaining Guard/ExecutionHost boundaries. This validates the predicate suite compiles with the P2 API; it does not create the missing live P1/P8/profile/context owner proofs or real recovery journey.

## 2026-10-19 live continuation addendum — owners and current evidence

This addendum supersedes older phase statements above only where explicitly stated; it does not promote any phase to VERIFIED.

- **Active whole-phase owners (actual live roster):** P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. The runtime rejected the fourth child (`agent thread limit reached`); P8 is next because its durable lease proof blocks P2/P1, followed by P3 and remaining runnable phases. P3/P8 are not currently active.
- **P1:** legacy managed `admit` now returns unavailable before Goal/OwnerLog/effect access until typed proofs exist; exact selector `cargo test --locked --offline --manifest-path kernel/Cargo.toml --test managed_control_rpc managed_admission_without_typed_owner_proofs_has_zero_owner_or_effect_mutation -- --exact --nocapture --test-threads=1` passed 1/1 (12 filtered). Recovery consumes the immutable exact effect-edge revision and checks `expectedManagedRevision + 1`. P1's subsequent full `managed_control_rpc` compile is currently blocked by P2's in-progress `capability_scope`/`required_capabilities` Rust API edits; P1 is adapting HostKernel ingress and continuing source-only. P1 remains PARTIAL: no typed P1/P8/profile/context proof producer, complete effect-origin adversarial matrix, full ToolBatch/recovery/cancellation acceptance, or product containment acceptance.
- **P2:** atomic binding selector passed 1/1; exact-lineage persistence/reopen/pause selector passed 1/1 (exact command requested). Capability scope is being added as explicit canonical IDs on immutable SpecVersion and a Task subset, empty-as-deny; it must be shown in distinct reviewer acceptance and never inferred from prose/path globs. Core Config is the profile definition owner, Core ContextService compiles bounded selection, and Rust stores per-Attempt snapshots only. Remaining P2 is full schemas/wire/TUI/Core producer and typed owner proofs, authenticated distinct review, actual-workspace artifact verifier, real-socket lifecycle/fault journeys; effect dispatch stays disabled.
- **P6:** Auth/SecretBroker/store/runtime/secure-input suite passed 47/0 (192 assertions); lazy-runtime concurrency/retry/close passed 6/6 (22 assertions); secure-input expiry cap/finalizer passed 7/0 (35 assertions). Doctor live/API 12/0 (57 assertions), TUI Doctor 4/0 (14), Core ModelsDev snapshot 2/0 (12). Offline Doctor uses only Config/ModelsDev, returns UNKNOWN for stale/unknown catalog provenance, performs no provider/auth/plugin/secret/network effects. P6 remains PARTIAL: no installed OS Secret Service on host; credential writes/provider transport and guarded live probes remain unavailable pending P1; full settings/provider matrix, S1 integrated acceptance, typecheck and authorized real free-model/coding-task proof remain open.
- **Parent checks:** Markdown audit exit 0 (280 files, 0 active blockers; 62 archive-only warnings); convergence exit 0 (27 schemas / 205 catalog IDs / 225 registry IDs / 1,227 checks / 0 failures); overlay audit exit 0 (`hidden_changed=0`, `hidden_new_source=0`, `stale_unignore=0`). C: (`/mnt/c`) has 21 GB free; `kernel/target` is 12 GB and `indexd/target` 269 MB. Preserve the mixed staged/unstaged/untracked tree; no safe phase-scoped commit/push or cleanup has occurred.

**Release status remains PARTIAL / NOT RELEASED.** Outstanding whole phases P1–P9, final integrated typecheck/test/push gate, real CLI/TUI journeys, Linux platform/security acceptance, distribution/install/license gates and exact publication remain release blockers. No earlier phase report substitutes for final-revision evidence.

P1/P2 capability-scope integration update: HostKernel now reads SpecVersion `capability_scope` and persisted Task `required_capabilities` fields; production remains unavailable until opaque current-policy/profile/lease proofs compose. First `managed_control_rpc` integration run compiled and passed 11/12; one P1-owned stale assertion expects the old validation code instead of `capability_unavailable`. P1 owns the correction and ingress/canonical-ID negative tests after P2's current Cargo suite. Do not promote this to Guard/effect acceptance.

Profile ceiling clarification: P2 identified that existing `AgentProfileV2` has only `permissionCeilingDigest`, which cannot supply actual capability IDs. The normative contract now adds explicit sorted/unique `capabilityCeiling: CapabilityId[]`, empty-as-deny. Effective ceiling is Task subset ∩ accepted SpecVersion capabilityScope ∩ profile capabilityCeiling ∩ current P1 Guard policy; per-operation Guard/lease still required. P2 owns Core profile schema/config source; no profile/path/tool pattern is treated as runtime authority.

## 2026-10-19 live continuation — phase owner and evidence delta

- **Active whole-phase owners:** P1 Guard/ExecutionHost; P2 managed vertical; P8 durable resources/workers/RC0. P6 completed its current owner assignment PARTIAL and the available slot was reassigned to P8. Other required phases P3/P4/P5/P6/P7/P9 remain in the runnable queue; final integration is not started.
- **P1 focused evidence on the current shared tree:** confined Linux terminal/stdio 5/5; workspace symlink/replacement race 2/2; managed settlement provenance 5/5; ToolBatch Guard matrix + multicall 17/17; Direct Attempt RPC 10/10; earlier six-file CLI/origin suite 8/0. Still open: all enabled-origin adversarial closure, authenticated Task/child live proofs, process crash/cancel/UNKNOWN real recovery, full no-bypass matrix and final product-level verification. P1 remains PARTIAL.
- **P2:** Core Config now has digest-free `AgentProfileDefinitionV2`; the stale existing `agent-profile-v2.schema.json` is to be corrected in place against §29.2. Parent ruling in §17.13 fixes profile transport to existing authenticated Core→HostKernel IPC, Rust-minted canonical BLAKE3 digests, and immutable per-Attempt persistence only. P2 still owes full authenticated review/TUI, owner proof producers, actual-current-workspace independent verifier/artifact path and restart/fault real-socket journey. No managed effect dispatch until P1/P2/P8 proofs pass.
- **P8:** RC0 Python harness passed 48/48; its Rust worker/resource selectors are in progress. Existing Rust pools do not yet establish an effectful managed worker journey. P8 owns durable reservation recovery, attribution, worktree/disk bounds, typecheck diagnostics and RC0 baselines; P2/P1 prerequisites fence any fan-out.
- **P6:** offline Doctor/settings/S1 focused tests are green per its phase report; package typecheck has no P6 diagnostics but is not green because P3/P8 diagnostics remain. OS Secret Service and authorized real free-model/coding acceptance remain unverified; guarded provider/auth dispatch stays unavailable.
- **Resource/integration:** `/mnt/c` 21 GB free, WSL `/` 813 GB free, `kernel/target` 12 GB, `indexd/target` 269 MB. One shared Cargo build at a time. Overlay rerun after exact source exceptions: `compared=6627 changed=311 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. Convergence: 28 schema files, 205 catalog IDs, 225 registry IDs, 1,228 checks, 0 failures. Mixed staged/unstaged/untracked state remains preserved; no commit/push or cleanup.

**Status: PARTIAL / NOT RELEASED.** Required scope P1–P9, product `horizoncode` typecheck, final push gate, integrated real CLI/TUI/recovery journey, Linux security acceptance and distribution/release verification remain open.

**Latest current-source evidence:** P8 Rust worker/resource/worktree/reservation/sample suite passed 226/226 and RC0 Python selector passed 48/48; its WSL2 selfcheck is not product baseline evidence. P1 Task/subagent Bun suite passed 15/15 (117 assertions) and shell interpolation allow/deny passed 2/2 (18 assertions, denial zero-spawn). P1 additional Linux containment 5/5, workspace-race 2/2, settlement provenance 5/5, ToolBatch 17/17 and Direct Attempt RPC 10/10. All are focused evidence; complete phase acceptance and integrated push gate remain open. Profile proof boundary is in §17.13. Structural audits pass: zero hidden source/stale ignore; 280 Markdown files, 0 active blockers; 28 schemas/1,228 convergence checks, 0 failures. C: has 21 GB free.

Latest follow-up: P8 durable bounds/replay selectors passed 139/139 (worker_durable 91, worker_pool 48), and its Rust formatting check passed. P2 profile digest fixture parity passed 2/2 with fixed BLAKE3 bytes; strict nested HostKernel validation/admission integration is not yet wired and remains P1/P2 work before managed effects. P1's broad CLI/plugin/formatter/project/Git origin bundle passed 60/60 (217 assertions). P8 is repairing its remaining TypeScript worktree test diagnostics; one Bun/tsgo lane is active.

P8 then passed the focused worktree suite 14/14 (34 expectations); HorizonCode TypeScript package typecheck (`packages/opencode`) now has zero P8-owned diagnostics. P1's authenticated/deep profile denial selector is compiling. V1 remains PARTIAL; no release gate or phase acceptance is implied by these focused passes.

P8's phase report is now PARTIAL with 226/226 initial Rust selectors, 139/139 durable replay follow-up, RC0 harness 48/48, worktree fixture 14/14, P8 typecheck diagnostics cleared and formatting checks green. Product RC0 remains blocked on authentic Core/Rust Session/Run attestations. P3 RepoIntel is newly active in the freed slot; P1 and P2 remain active. P1 strict profile decoder passed 1/1, while malformed RPC denial awaits P2 adding `profileDefinition` to authenticated private admit schema. No effect or release gate has been opened.

### 2026-10-19 continuation: authenticated profile owner and RepoIntel overlay

- **Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P3 RepoIntel; all three available implementation slots remain occupied. P4–P9 and final release work stay queued/unverified. No phase is complete from these focused checks.
- **P1 focused integrated evidence:** warning-fixed `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib profile_owner_mismatch -- --nocapture` → 2/2; `authenticated_repo_generation_pin_is_bound_to_query_identity_scope_and_expiry` → 1/1. The latter pins a generation, removes its source file, submits unsupported `overlayRef`, and still gets typed `capability_unavailable`, proving the HostKernel overlay gate precedes source remeasurement. P1 also binds Task profile-owner digest to authenticated ServerAuth/Attempt executor before ceiling mint. Remaining P1 work includes whole-origin closure, actual confinement/process mediation, ToolBatch faults/recovery, guarded HTTP, cancellation/UNKNOWN and full adversarial acceptance.
- **P2 source state:** Task persists HostKernel-derived `ProfileOwnerBindingV1`; Alice profile vs Bob authenticated Attempt is denied before binding/revision mutation and is covered by P1's 2/2 selector. Core carries typed principal from authenticated middleware through wake/resume into detached coordinator/runner; no request/body/model identity. Cross-principal Session wake/queue is denied. P2 owns remaining Core callsite diagnostics/typecheck, real managed reviewer/verifier against current workspace revision, TUI delivery and restart/UNKNOWN acceptance; effectful execution stays disabled.
- **P3 focused evidence:** indexd repo_structure selector 6/6, including foreign-base overlay denial; schema selector 9/9 (67 assertions); OpenCode RepoIntel/RepoTools 60/60 (410 assertions); overlay-specific tool adapter 51/51. Query with `overlayRef` requires `page.overlayDigest` and matching node digests; absent ref forbids overlay digests. HostKernel returns typed unavailable before lease/filesystem access when no producer exists. Authenticated Core→HostKernel live socket, minting source, distinct live overlays, stale/cancel/restart and stale-write through files.patch remain NOT VERIFIED.
- **Overlay contract correction:** §30.22 now says an explicit overlay request with missing/expired/foreign/base/policy mismatch must return typed unavailable/stale with no nodes, never downgrade to base-only. Partial named-revision base-only results are allowed only when the query did not request an overlay. No genuine Core editor/session-buffer snapshot producer exists yet; P2/P4 must identify a real producer. Query/tool/model data and P7 evidence artifacts cannot mint mutable snapshots.
- **Build/visibility/resources:** P1 released Cargo; P2 owns the TypeScript lane for principal propagation and overlay preflight before `ensure_generation`; P3 takes the next Cargo lane after TS release. Never overlap heavyweight checks. Overlay visibility rerun: `compared=6627 changed=315 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; diff check clean. Latest disk: C: 20 GB free, WSL `/` 823 GB free, `kernel/target` 1.4 GB, `indexd/target` 292 MB.

**Overall status remains PARTIAL / NOT RELEASED.** Final integrated V1 phase acceptance, `horizoncode` package typecheck, push gate, Linux/WSL product journeys, release qualification and safe exact-scope commit/push remain open. Preserve mixed staged/unstaged/untracked work; do not stage or publish unrelated state.

**Managed admission dependency correction (2026-10-19):** P1 source audit confirms `managed_admit` still returns `capability_unavailable` before OwnerLog open; the effective capability ceiling proof is not consumed in production. This is correct fail-closed behavior. P2 effect dispatch cannot be enabled until actual P8 workspace/resource lease proofs exist and P1 consumes them in live Guard/ExecutionHost admission. P8 is queued for the next real child slot; keep P2's independent review/verifier/Core/TUI work moving in the meantime.
### 2026-10-19 14:32 UTC — live owner/evidence delta

This supersedes earlier active-roster and P3/P4 progress statements above where they conflict; it does not mark any phase VERIFIED.

- **Live whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P4 LSP/DAP/REPL. P3 completed its current assignment PARTIAL and released the slot; P5/P6/P7/P8/P9 remain queued or need phase-owner continuation. All three child slots are occupied again.
- **P1:** Linux `tool_batch_guard_matrix guarded_terminal_run` passed 2/2 on the actual guarded terminal path (workspace write allowed; outside-metadata write and host-network listener denied). The shell interpolation approval fixtures were corrected to use authenticated ServerAuth after discovery that the inherited host_os test principal is rejected before approval-event publication. Rerun awaits the integrated TypeScript lane. P1 still owes the enabled-origin matrix, Task/child authenticated live proof, receipt/UNKNOWN/restart/cancel/crash recovery and complete containment acceptance.
- **P2:** integrated `bun run horizoncode:typecheck` initially exited 2 with three diagnostics: a RepoIntel callback environment leak, a declared session authorization error mapping, and a stale P6 fixture Layer cast. P2 corrected all three and is rerunning the full HorizonCode CLI-host package→TUI→Core typecheck now. Managed effects remain unavailable until live P1/P8/profile/context owner proofs, distinct authenticated reviewer, actual workspace revision evidence, independent verifier and recovery journeys pass.
- **P3:** current assignment PARTIAL. Evidence: indexd 123/123; schema 9/9 (68 assertions); OpenCode RepoIntel/RepoTools 61/61 (414 assertions); adapter 51/51; authenticated Core socket consumer 1/1 (9 assertions); P1 HostKernel socket 1/1 plus owner mismatch 2/2. There is no permitted production parser with TS/Rust grammar in the current pinned dependencies (and §42.11 rejects the available OMP parser path); structural results remain honestly UNAVAILABLE. No authenticated immutable editor-buffer producer exists; overlay requests fail closed before source reads. No RepoNodeRef consumer reaches `files.patch`; stale query→patch acceptance is unverified and P1-owned. P3 needs follow-up when P4 supplies a trusted buffer source.
- **P4:** whole-phase owner `p4_lsp_dap_repl_full_resume` is active in the newly released slot, with exclusive OpenCode LSP/DAP/REPL module/test paths. It owns supervised lifecycles, mediated operations, Guard/confinement negatives, bounded REPL recovery, Linux real-project journeys, and evaluation of the authenticated immutable-buffer producer seam. P1/P2/Kernel shared-path edits require coordination; all unproven effects stay unavailable.
- **Integrated/resource state:** parent reran `audit_overlay_visibility.py` → 6,627 compared, 316 changed, zero missing/hidden/stale; `git diff --check` clean. The sole heavyweight job is P2's integrated typecheck. `/mnt/c` has 20 GB free; WSL `/` 823 GB; `kernel/target` 2.3 GB; `indexd/target` 292 MB. One main worktree; no cleanup. Main is ahead 12 and the tree remains heavily mixed staged/unstaged/untracked, so no safe exact-scope commit/push boundary exists. Release remains PARTIAL / NOT RELEASED.

### 2026-10-19 14:47 UTC — P4 partial / P8 resumed / integrated typecheck pass

- **Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P8 resources/workers/RC0. P3 and P4 have returned PARTIAL; P5/P6/P7/P9 and final integration remain queued. Three child slots are occupied.
- **Integrated typecheck:** P2's sixth `bun run horizoncode:typecheck` passed exit 0 across HorizonCode CLI-host package, TUI and Core. A subsequent P2 fix is required in Core `SessionSupervisor`: trusted ServerAuth principal is read for approval but omitted from both HostKernel `prepare_user_effect` and `resolve_approval`; Guard binds host_os while PTY dispatch consumes under ServerAuth. P2 is adding the trusted principal from existing `TrustedPrincipalContext` at both calls and must rerun integrated typecheck.
- **P1 interpolation regression:** current allow test reaches Guard but fails lease principal binding. Test harness resolves `kernel/target/debug/hz-kernel`, currently stale relative to HostKernel source. P1 removed temporary diagnostic instrumentation and will rebuild the exact test-owned binary only after P2's TypeScript rerun; rerun the one allow/deny journey before any production change. P1 remains PARTIAL on enabled-origin closure, Task/child scope, ToolBatch fault/receipt/UNKNOWN/restart/cancel and containment acceptance.
- **P4 PARTIAL:** post-format LSP/DAP/REPL suite 208/0, 724 assertions across 10 files; Prettier and diff checks clean. Owner/scoped broker/REPL/DAP references and generation pin hardening are implemented, but there is no production LSP client/editor ingress or authenticated immutable buffer source. Process/callback effects remain unavailable pending P1. Real-project diagnostics/debug/bounded-REPL and native Windows acceptance remain open.
- **P8 resumed:** whole-phase owner `p8_resources_workers_rc0_full_resume` is active to continue durable workspace/resource proof constructors, reservation/recovery, worker/worktree bounds and authentic RC0. It is holding Cargo for P1's rebuilt-kernel acceptance; P8 source-only work proceeds meanwhile.
- **P3 PARTIAL:** current assignment produced indexd 123/123, schema 9/9, RepoIntel/RepoTools 61/61, adapter 51/51 and Core live socket 1/1. Structural queries remain truthfully unavailable because §42.11 rejects current parser dependencies and no TS/Rust grammar source is approved; no authenticated editor-buffer producer exists, overlay refs fail closed, and no RepoNodeRef→`files.patch` consumer exists. Follow up after an approved producer/parser contract.
- **Parent/resource/publication:** overlay audit 6,627 compared / 316 changed / 0 missing / 0 hidden / 0 stale; `git diff --check` clean. C: `/mnt/c` 20 GB free; WSL `/` 823 GB; target sizes 2.3 GB kernel, 292 MB indexd; one main worktree. Main is 12 commits ahead, tree remains mixed staged/unstaged/untracked with ambiguous ownership; preserve all state, no cleanup or publication. Release remains PARTIAL / NOT RELEASED.

**P2 typecheck and P1 regression update:** the next full `bun run horizoncode:typecheck` passed exit 0 across HorizonCode CLI-host package, TUI and Core after Core passed the already-authenticated `TrustedPrincipalContext` principal to both HostKernel `prepare_user_effect` and `resolve_approval`. P1 confirmed this omission caused the prior shell-interpolation lease mismatch (Guard prepared under host_os; PTY dispatched under ServerAuth). P1 has the exclusive Cargo lane to rebuild `kernel/target/debug/hz-kernel`, then rerun allow/deny against the rebuilt binary. P8 remains source-only until P1 releases Cargo. Managed P2 acceptance remains open; this compile pass is not phase completion.

### 2026-10-19 15:28 UTC — implementation-first owner ledger refresh

User instruction: complete implementation before starting tests/builds/typechecks/provider probes. **No V1 phase is complete from this wave and V1 is PARTIAL / NOT RELEASED.** Parent reloaded the full bootstrap sources and Engram. Three real child slots are occupied by P6, P7 and P8. P1/P2 sessions hit usage limits; P1 is first in the dispatch queue because Guarded effects remain the critical prerequisite. P5 is being picked up by P6 after its P6/S1 source work. P3/P4/P9 and final integration remain PARTIAL or unassigned. No test/build was started by the parent; a prior ownerless Bun PTY process observed earlier exited, was not killed and was not counted as evidence.

| Phase | Current implementation owner | Source-only progress in this wave | Remaining implementation / release blocker |
|---|---|---|---|
| P1 Guard/ExecutionHost | No live slot; next dispatch | Earlier fail-closed import/upgrade, Core Git subprocess and origin closures remain in shared tree. P8 has now published exact worktree and sample-attribution interfaces. | Whole Guard/origin closure: HostKernel WorkerPool open/replay/current-parent resolution; guarded worktree port; shell/process/interpolation; Task child authenticated Attempt; ToolBatch bounds/atomic leases/receipts/UNKNOWN/cancel/restart; enabled-origin matrix and confinement. Keep effects unavailable. |
| P2 managed vertical | No live slot; resume after P1 assignment | Goal review/proposal API and TUI exist. Managed admission consumes typed P8 lease/parent proof; typed verifier model rejects digest-only live ingress and uses actual-workspace revision code. | Wire real authenticated distinct reviewer and current HostKernel ownership; Attempt-bound effect/lease; actual independent verifier dispatch/output/artifact receipt; Core→TUI proposal/review; pause/cancel/restart/UNKNOWN/stale/conflict real-socket journey. `TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false and finalization disabled. |
| P3 RepoIntel | No live slot | Existing source remains PARTIAL; no re-run. | Authenticated parser/read path, real mutable-buffer source, stale write rejection and recovery; retain UNAVAILABLE where no approved parser/producer exists. |
| P4 LSP/DAP/REPL | No live slot | Existing fail-closed broker/protocol work remains PARTIAL. | Guarded supervised lifecycle and mediated actions/attach/evaluate/callback; production editor ingress; real-project diagnostics/debug/REPL and Linux acceptance. |
| P5 Web search | Parent continuation; no subagent active by user instruction | Existing cascade/config/route parser/cooldown scaffold; source policy updated so 401/403/407 is recorded and falls through only to explicitly enabled/configured routes; other non-rate-limit 4xx stop. Regression expectation changed, not run. | Built-in + enabled ordered provider dispatch, workspace cooldown/retry/provenance/consent, SecretBroker auth and real P1 Guarded outbound transport. Tool/registry stay disabled while `WEB_SEARCH_GUARD_READY=false`. |
| P6 providers/settings/Doctor/S1 | Active whole-phase owner | Added authenticated session-scoped QuestionV2 routes, opaque SecretBroker lease seam, truthful provider auth unavailability, Doctor/settings/feature/cost/model-picker source work. | Guarded SecretBroker put/revoke + provider reference; Doctor catalog/full tiers; FEAT-001..014 source/route behavior and switching; authorized free-model 200/coding evidence after implementation and quota reset. No provider call or tests yet. |
| P7 streaming/rendering/artifacts/analytics/automation/rewind | Active whole-phase owner | V1/V2 emitters carry random per-stream generation, monotonic event ordinal and separate UTF-16 offset; TUI no longer infers cursor from canonical snapshot text; SDK types and fixtures updated; stream remains bounded/redacted; artifact UNKNOWN rules added. | Finish SDK/emitter/fixture parity and safe-render interactions; correct FULL/SAMPLE/FAILED producer metadata; integrate P8 artifact/checkpoint/automation contracts; replay/resnapshot and real TUI journeys. No tests yet. |
| P8 resources/workers/RC0 | Active whole-phase owner | OwnerLog-bound durable worktree intents/receipts/replay/UNKNOWN/quarantine and RC0 attributed owner-snapshot serializer/ingest source; typed usage attribution will require matching P1 OS sample sequence. Added exact `.gitignore` allowlist for `kernel/src/worktree_lifecycle.rs`. | Complete reservation/process attribution, recovery and worktree integration; P1 HostKernel port; P2 verified Attempt before fan-out; trusted Session identity and P2 verifier before baseline eligibility. No tests/builds; baseline remains NOT_ATTESTED. |
| P9/release | No live slot | Release harness source exists. | Restore all first-party Git visibility; final typecheck, architecture/overlay/license/clean-install/platform/release gate; exact-scope commit/push after evidence. |

Resource snapshot: `/mnt/c` 21 GB free (96% used); `kernel/target` 2.3 GB, `indexd/target` 292 MB; one main worktree; branch `main` is 12 commits ahead with mixed staged/unstaged/untracked user/project changes. Preserve all changes and caches. Do not stage, commit, push, clean, prune or run tests until implementation is complete and ownership/revision gates permit it.

### 2026-10-19 15:34 UTC — implementation owners resumed at maximum concurrency

The prior P6, P7 and P8 owners returned PARTIAL source packages and released slots. The three available child slots are now assigned to whole-phase P1 Guard/ExecutionHost, P2 managed vertical/independent verifier, and P4 LSP/DAP/REPL. Write scopes: P1 owns HostKernel/Guard/ExecutionHost and effect-origin adapters; P2 owns managed-control/evidence state and Core/HTTP/TUI Goal/verifier projection; P4 owns HorizonCode CLI-host package LSP/DAP/REPL modules. P1 must provide exact typed generic process API and HostKernel verifier call-site contracts early; P2/P4 must not write P1's shared HostKernel/Guard files. All three owners are under the user's implementation-first hold: do not run tests/builds/typechecks/audits/provider probes.

| Phase | Current owner/state | Latest implementation status | Remaining blocker/next action |
|---|---|---|---|
| P1 | Active | Prior fail-closed import/upgrade/Git and effect-origin closures remain in the shared tree. P8 has supplied durable worktree and sample-sequence interfaces. | Implement entire Guard path, authenticated worker/parent resolution, guarded worktree and non-PTY dispatch, shell/Task/origin matrix, ToolBatch/lease/receipt/UNKNOWN/cancel/restart and artifact producer metadata. P1 owns exact HostKernel integration; keep unverified paths disabled. |
| P2 | Active | Existing reviewer CAS, verifier profile/challenge pipeline, Goal review/proposal route/TUI and typed evidence structures are source-present. | Replace reconciliation-only verifier with real distinct-auth verifier dispatch/captured typed evidence and actual current workspace revision; complete Task Attempt/effect lineage, API/TUI and pause/cancel/restart/UNKNOWN/stale/conflict journey. Coordinate HostKernel call site with P1; never flip readiness constant without real adapter. |
| P4 | Active | Existing lifecycle/policy files remain partially fail-closed; no parallel launcher introduced. | Implement LSP/DAP/REPL mediation and typed adapter contracts under P1 generic Guard API; production process/evaluation paths unavailable until P1 passes. P1 supplies API signature. |
| P5 | **Active, AppRuntime unblock VERIFIED (2026-10-23)** | `websearch.ts` eager `InstanceState.context` moved into deferred `execute`; `config.test` 0/112→**111/112**, registry 0/12→**12/12**, AppRuntime VERIFIED in-repo, codemode **263/0**+typecheck exit 0, P5 10-file suite **179/0**, 4 new coverage tests (no keyless→paid upgrade, Retry-After cooldown, 429-only failover, bounded-transient-retry rejection). | P5's own scope is closed (0 P5 diagnostics). Remaining: guarded outbound transport + per-route/aggregate receipts + restart/UNKNOWN → **P1/P2**; BYO SecretBroker → **P6**; Settings consent → **P7/parent UI**; CodeMode lifecycle/registry exposure → **P2/P7/P1**; residual permission-key-order config test → **P6**. Gates stay false. |
| P6/S1 | Partial / queued | Authenticated session-scoped QuestionV2 routes, offline Doctor, truthful provider/model/feature state and SecretBroker lease seam are source-present. | Guarded credential writes/provider binding, full Doctor catalog tiers, integrated FEAT-001..014/provider switching; later authorized free-model 200/coding acceptance. |
| P7 | Partial / queued | V1/V2 source event ordinals + generations + separate offsets, bounded replay, TUI stream/redaction/analytics and FULL/SAMPLE/FAILED projection code are source-present; combined legacy truncation stays UNKNOWN. | Reconcile generated SDK/source parity and integrate P8 ArtifactStore/checkpoint/automation interfaces plus P1 producer metadata; final TUI journeys later. |
| P8 | Partial / queued | OwnerLog-bound worktree journal, UNKNOWN/quarantine, bounded RC0 snapshot ingest and sample-sequence-bound measured PSS attribution are source-present. | P1 HostKernel trusted sampler/worker lifecycle/guarded filesystem adapter and P2 verified Attempt are prerequisites; no baseline is trusted yet. |
| P3 | Partial / queued | Existing RepoIntel structural path remains truthfully unavailable where no approved parser or authenticated buffer producer exists. | Resume owner for bounded source gaps/stale write integration; no synthesized structural nodes or mutable-buffer authority. |
| P9 + release | Partial / queued | Release scripts and install audit source are present. | Candidate qualification, exact overlay audit, final full typecheck/gates, Linux security/real CLI/TUI acceptance, license/platform/clean-install and exact-scope publication remain open. |

Status remains **PARTIAL / NOT RELEASED**. No phase acceptance is inferred from source presence. Preserve all mixed Git state and the 12-ahead main history. `/mnt/c` last measured 21 GB free; targets: kernel 2.3 GB, indexd 292 MB. No staging, commit, push, cleanup or prune.

P2 source audit during the 15:34 owner wave found `ManagedControl.startRun/addTask/markTaskReady/admitAttempt/settleAttempt` have no production call sites, while the UI currently only proposes/reviews and starts verifier flow. P2 is implementing an authenticated, non-effectful Core→HTTP/TUI plan/run/task projection via existing managed-control routes and architecture contracts; readiness/admission stay unavailable without typed P1/P8 proofs. P2 must send proposed public API/contract to parent/P1 before changing shared protocol/SDK schema. P1 owns actual HostKernel Guarded dispatch.


### 2026-10-19 15:46 UTC — verifier contract and P4 visibility integration

- Active whole-phase owners remain P1 Guard/ExecutionHost, P2 managed vertical, and P4 LSP/DAP/REPL (three child slots occupied). No phase is complete.
- Parent reviewed the live managed-verifier source and found its process binding lacked a Task Attempt. P1 confirmed §14.3/§12.6 have no verifier exception; the unscoped path is now explicitly unavailable. Parent ruled that V1 uses one coding Task/Attempt kept EXECUTING through a separately approved read-only verifier EffectIntent under the same Attempt, then settles only after typed evidence and fresh workspace revision are durable. Crash/cancel/lost receipt/stale revision/partial capture after possible dispatch remains UNKNOWN and cannot relaunch. Design recorded in arch_V1 §§3.22, 4.13, 12.19, 14.3 and 37.22.
- P1 accepted P2's private `record_attempt_effect_receipt` proof contract and is implementing bounded exact per-effect Attempt lineage. A private `bind_attempt_verifier_intent` persists the trusted verifier profile/executable/criteria/arguments/workspace pins before Guard dispatch. Multi-effect restart settlement remains fail-closed pending P2's durable receipt model.
- P1 source-only progress: HostKernel opens/replays the worker OwnerLog at startup under SupervisorLease epoch and forces fan-out Closed; shell output now distinguishes artifact fidelity, preview truncation and artifact truncation. The P1 generic supervised-process broker is being defined for P4. No tests/builds/typechecks/audits were authorized or run by these owners.
- P2 added `POST /experimental/control-plane/goal-run-plan` schema and started durable plan projection via existing managed Core RPCs; Tasks stay unready and no Attempt/effect is admitted. Parent flagged the draft revision as JS number instead of canonical DecimalU64 string, and the HTTP principal fallback to `host_os`; P2 is correcting those and must enforce accepted durable SpecVersion plus canonical bounded IDs before handler/TUI wiring.
- P4 source-only progress: LSP edit batches bind workspace revision and effect-intent digest; DAP uses host-issued process refs rather than PIDs and quarantines UNKNOWN; REPL cancellation/UNKNOWN quarantines state and forbids silent generation replacement. Execution remains unavailable pending P1's typed supervised-process broker and OS confinement. P4 reported `packages/opencode/src/lsp/edits.ts` and its test were hidden by the overlay; parent added only exact `.gitignore` exceptions, and Git MCP now lists both paths.
- A brief unowned Cargo selector process (`host_terminal_process`/`host_terminal_events_process`) appeared in a 15:42 scan and exited before ownership could be established. P1/P2/P4 each confirmed they did not start it. It is not counted as evidence; all owners remain on the implementation-first hold.
- Resource snapshot: C: `/mnt/c` 21 GB free; `kernel/target` 2.7 GB; `indexd/target` 292 MB; one main worktree, branch `main` 12 commits ahead with mixed staged/unstaged/untracked changes. Preserve all state. Do not stage, commit, push, clean or prune.
- Next queued whole-phase owner when a slot opens: P8 (worktree/resource/worker/RC0 integration needed by P1/P2), followed by P7 artifact/rewind integration, then P6/P5 and remaining P3/P9 work according to dependencies. Release/typecheck/security/platform verification stays deferred until source implementation closes.

## Active whole-phase execution checkpoint — 2026-10-19 15:52 UTC

**Overall: PARTIAL / NOT RELEASED.** The user requested full V1 implementation before tests/builds. This hold remains active; do not run tests, builds, typechecks, audits or provider probes until source implementation scope closes. No phase is promoted from source presence alone.

| Phase | Owner/state | Current source contract/progress | Remaining work |
|---|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | HostKernel worker OwnerLog boot/replay and fail-closed fan-out; terminal artifact fidelity metadata; exact private Attempt scope being aligned with P2. | Complete universal pre-dispatch Guard/confinement for shell/process/interpolation, authenticated parent/child and Task effects, ToolBatch atomic bounds/lease/receipt/UNKNOWN/cancel/restart, durable recovery, and enabled-origin closure. Keep verifier and unsupported effects unavailable. |
| P2 managed vertical | Active whole-phase owner | Non-effectful accepted plan/run/task projection; canonical `ManagedAttemptScopeV1` contract includes Goal/Run/Task/Attempt, decimal-string epoch/revision, Location/Session, workspace digest and delegation-binding digest. Verifier observation must bind the same live Attempt and exact per-criterion effect IDs. | Wire distinct authenticated reviewer, Attempt-bound effect intent/lease/receipt, actual guarded verifier dispatch/artifact capture, fresh workspace evidence, Core→TUI delivery and real pause/cancel/restart/UNKNOWN/stale/conflict lifecycle. Verifier and finalization remain disabled. |
| P4 LSP/DAP/REPL | Active whole-phase owner | Exact LSP edit revision/effect-intent binding; DAP/REPL effects and sessions now bind authenticated Location; process refs reject caller PIDs; UNKNOWN quarantines state. | Finish supervised LSP/DAP/REPL lifecycles, editor ingress, action/attach/evaluate/callback mediation and Linux real-project journeys; dependent process effects wait for P1 Guard/confinement. |
| P8 resources/workers/RC0 | Queued, first on slot release | Prior source has OwnerLog-bound worker/worktree proofs and bounded RC0 ingestion; no accepted runtime attribution yet. | Whole phase: HostKernel lifecycle and guarded worktree port, process-sample/resource attribution, restart/recovery, measured 1/5/10/20 baselines and P2-verified fan-out prerequisites. |
| P7 streaming/artifacts/automation/rewind | Partial / queued | V1/V2 cursor generation/ordinal/offset and fail-closed artifact projection work remains in shared tree. | Finish emitter/SDK parity, redaction/render interactions, artifact fidelity, P8-backed automation/checkpoint/rewind and replay/resnapshot journeys. |
| P3 RepoIntel | Partial / queued | Core live-socket consumer and Rust denial seams are source-present; structure/overlay still honestly unavailable where producer/parser absent. | Authenticated useful producer/parser, bounded pagination, stale-write rejection and recovery. |
| P5 web search | Partial / queued | Ordered cascade/config scaffold exists; follows approved built-in-default + user-enabled providers and no silent paid upgrade. | Guarded network transport/SecretBroker auth, ordered dispatch/cooldown/provenance/consent and route failure/exhaustion behavior. |
| P6 provider/settings/Doctor/S1 | Partial / queued | Offline Doctor, truthful availability/cost, session-scoped QuestionV2 and settings scaffolding exist. | Guarded SecretBroker writes/provider binding, Doctor tiers, FEAT-001..014/provider switching and later authorized free-model 200/coding acceptance. |
| P9 and final integration/release | Partial / queued | Release tooling exists, but mixed ownership and all final gates remain unresolved. | Complete implementation, final-revision verification, overlay/typecheck/security/real CLI-TUI/Linux release gates, then exact-owned-path publication. |

Cross-phase boundary: managed effects require the exact private `ManagedAttemptScopeV1` plus separate per-effect OwnerLog/effect/lease binding. P1/P2 agree that verifier observations bind the same live Attempt and criterion effect IDs; actual fresh HostKernel workspace revision must match before typed evidence and settlement. `TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false. P4's Location/workspace pins do not substitute for process generation, owner epoch or managed Attempt scope.

Resource snapshot: C: `/mnt/c` 20 GB free (96% used); `kernel/target` 2.7 GB; `indexd/target` 292 MB; one main worktree; branch `main` ahead 12 with mixed staged/unstaged/untracked changes. Preserve all existing state. No stage/commit/push/cleanup/prune.


### P1/P2 receipt integration update — 2026-10-19 15:53 UTC

P1 source-wired HostKernel terminal settlement to persist each managed effect's exact Attempt receipt edge, principal, epoch, Location/Session, bound OwnerLog revision, lease digest, target receipt, and before/after workspace revisions. Unknown launch/exit/receipt paths remain durable UNKNOWN/no-relaunch. P1 added the host-derived Attempt ID and per-criterion effect IDs to verifier journal/observation records. P2 tightened executor/verifier principal matching and requires successful coding receipts pinned to one exact source revision before verifier intent; verifier output must preserve it. The legacy HostKernel verifier begin/call sequence remains incompatible, so verifier dispatch and finalization stay disabled. This is source-only; no build/test was run and neither P1 nor P2 is accepted. See `HANDOFF.md` for current blocker; the full implementation and later verification queue remains the phase table above.

### 2026-10-19 15:56 UTC — managed revision-chain implementation delta (not accepted)

HostKernel source review confirms `expected_managed_attempt_workspace_revision` derives the live head from the Attempt's immutable admission revision and exact preceding SUCCEEDED receipts; the registered root and current aggregate OwnerLog revision are checked separately from the effect edge's `bound_revision`. P2 identified that the managed receipt reducer still used the Attempt base for every coding effect and is implementing independent predecessor-chain validation. P1/P2 must reconcile and complete this before verifier/finalization can be enabled. The normative rule is recorded in §§3.22, 12.19, 14.3 and 37.22: serialize mutating effects; pin verifier read-only receipt before=after=current chain head; fence on failed/UNKNOWN/missing/out-of-order receipts, cancellation, epoch changes or workspace edits outside the chain; reject caller rebasing. Source/design only; no verification evidence. P1/P2/P4 remain active and all other V1 implementation plus final tests/release gates remain open. Overall PARTIAL / NOT RELEASED.

### 2026-10-19 15:57 UTC — verifier authorization staging clarified (not accepted)

Persist the exact Attempt edge and immutable verifier intent before requesting Guard approval/lease. The intent excludes the one-use lease digest; refresh the scope to the post-intent aggregate revision, then bind the lease to that exact edge + immutable intent digest + live revision/workspace fence. EffectHost owns durable one-use consumption, and the authenticated settled receipt retains the lease digest. Reviewer is the authenticated approval principal; trusted verifier profile principal owns the child and receipt. Pending revision/workspace change invalidates authorization. This contract resolves the source-discovered revision cycle without weakening Guard and is now in arch_V1 §§3.22, 12.19, 14.3 and 37.22. P1/P2 implementation remains in progress; verifier stays disabled. P4 must not classify debugger processes as terminal runs. No phase is accepted or verified.

### 2026-10-19 18:01 UTC — whole-scope source audit / stopped-owner checkpoint

This latest owner/status checkpoint supersedes every earlier row or paragraph that calls a phase owner active. The user explicitly stopped all subagents; the live agent list contains only the parent. V1 remains PARTIAL / NOT RELEASED. User's implementation-first hold remains: no tests, builds, typechecks, audits, provider probes or performance runs until implementation closes. No source code was copied in this audit.

The local OpenCode/Codex source tree inventory and P0–P9 source reuse crosswalk are in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` §42.12. Key implementation guidance from that review: preserve OpenCode Core's direct Session/Task seam; adapt Codex's root-owned agent tree, reservations, lineage, mailbox, resume and activity projection for lifecycle only; retain Rust managed Attempt/Guard/effect receipt authority; reject OpenCode's single-provider web-search choice and Codex's single hosted search route for the V1 cascade; adapt OpenCode's LSP/session UI plus Codex's subagent activity and bounded worker lifecycle patterns under Horizon owners.

| Phase | Owner | Latest state | Full implementation still open |
|---|---|---|---|
| P1 Guard / ExecutionHost | None (stopped by user) | Source present; confinement path exists; universal effect mediation and acceptance are unverified. | Guard shell/process/interpolation and Task children; mediate-or-disable every enabled origin; complete ToolBatch bounds, one-use leases, receipts, UNKNOWN/cancel/restart and OS containment. |
| P2 managed vertical | None (stopped by user) | Managed schemas, ingress and receipt/revision-chain source exist; trusted verifier adapter is explicitly disabled. | Distinct authenticated reviewer, Attempt-issued effect leases, current workspace revision, actual independent verifier artifacts/evidence, Core→TUI delivery and restart/pause/cancel/stale/conflict handling. |
| P3 RepoIntel | None | Bounded index/query source exists; authenticated source/parser producer and full live path remain unverified. | Real authenticated producer, bounded useful structural pages, generation/overlay freshness, stale-write rejection and recovery. |
| P4 LSP / DAP / REPL | None | Protocol/policy source exists; process-backed lifecycle stays unavailable pending P1. | Guarded supervisor, trusted executable resolution, LSP mutation, DAP attach/evaluate, REPL callbacks/recovery and real-project Linux journey. |
| P5 web search | None | Cascade/config source is present but product route remains incomplete. | Built-in default + user-enabled ordered cascade, explicit route consent/auth/cost/provenance, bounded retry/cooldown, failure/exhaustion and Guarded transport. |
| P6 providers / settings / Doctor / S1 | None | Provider/status/Doctor/question/settings source exists; full auth and integrated journeys are unverified. | Guarded SecretBroker write/revoke and provider binding, Doctor tiers, FEAT-001..014, model/provider switching; free-model 200 and coding task only after implementation and approved quota availability. |
| P7 streaming / artifacts / analytics / automation / rewind | None | ActivityStream is mounted; event generation/ordinal and rendering source exists, but replay and integrated artifact/recovery behavior are not accepted. | Safe bounded redaction/render interactions, reconnect/replay/resnapshot, artifact FULL/SAMPLE/FAILED truth, provenance, Rust-owned guarded automation, checkpoint/rewind recovery and real TUI journey. |
| P8 resources / workers / RC0 | None | Durable pool/worktree/attribution source exists; HostKernel integration and trusted baseline are not accepted. | Complete reservation and process attribution/recovery; integrate guarded worktrees; keep fan-out off until P1/P2; later measured product baselines at 1/5/10/20. |
| P9 Linux/WSL packaging and release | None | Installer/release scripts exist; clean-install, legal, visibility and final release gates remain open. | Complete license/notices, exact first-party visibility, clean install/upgrade, Linux support matrix, integrated final gates and exact-owned-path publication. Native Windows remains unavailable without native acceptance. |

Tree/resource status: `main` is 12 commits ahead of `origin/main`, one worktree, extensive mixed staged/unstaged/untracked changes and no conflicts. C: `/mnt/c` has 60 GB free (87% used); `node_modules` is 2.5 GB; no `kernel/target` or `indexd/target` exists. Keep all existing state. No verification, staging, commit, push, cleanup or prune was performed in this checkpoint.
## 2026-10-19 18:26 UTC — source-led design audit checkpoint

The full V1 release target remains open. No phase or release gate is promoted by this
documentation pass. Subagents remain stopped per the user's instruction; implementation-first
hold remains active (no tests/builds/typechecks/audits/provider probes).

The OpenCode/Codex subagent lifecycle review found and corrected a design-flow mismatch:
direct Core Session children are distinct from managed Task/Attempt workers and do not need a
Goal. Updated §§03.5, 29.5, 37.9 and derived §45.8; §42.12 records the exact source patterns
and Horizon ownership boundary. Remaining P1–P9 implementation work stays as listed in the
preceding phase ledger.

Pending user decision: define `SubagentDeliveryV1` as one lane-tagged envelope with lane-specific
authority bindings, or use separate direct/managed delivery schemas. Current schema has neither
a lane discriminator nor defined `authorityDigest`; no schema/runtime change is claimed.

Resource/Git checkpoint: C: `/mnt/c` 60 GB free (87%); one main worktree; `main` is 12 commits
ahead with mixed staged/unstaged/untracked changes. Preserve all existing state; no stage,
commit, push, cleanup or prune was performed.
### P1 source-map correction — 2026-10-19 18:27 UTC

Source re-audit of §14.5 found its 2026-10-18 “crate absent” statement stale. Current source
has `horizoncode-sandbox` in `kernel/Cargo.toml`; `terminal_process.rs` preflights sandbox
guarantees for Linux non-PTY stdio and terminal launches before dispatch, and HostKernel
records/binds the guarantee record in terminal preflight state. Updated §14.5 and the §20.12
source map. This is CODE_PRESENT/WIRED source evidence for those routes only, not VERIFIED
containment or universal origin closure.

The backend has no destination allowlist: deny-default is enforced, host-network sharing is
reported unsupported for enforced egress. Keep destination-scoped network paths unavailable
unless the separate Guarded proxy/service is implemented and proven. Native Windows/macOS
confined profiles stay unavailable. No tests/builds/typechecks were run. All P1–P9 remaining
work and final acceptance remain open.

## 2026-10-19 19:18 UTC — current whole-phase implementation reconciliation

The three actual implementation slots remain occupied by full-phase owners P1
(`p1_guard_full_resume`), P2 (`p2_managed_wave2_1019`) and P4
(`p4_lsp_dap_repl_wave2_1019`). P1 owns `kernel/src/protocol.rs`, `host_kernel.rs`, and the
existing ExecutionHost process boundary; P2 owns Task/Core profile runtime, durable
`managed_control.rs`, review, evidence and TUI; P4 owns the LSP/DAP/REPL package paths.
P2 does not edit P1-owned HostKernel files; P1 will integrate the managed verifier ingress
once P2 supplies the typed durable intent/evidence contract and the generic process RPC is
ready. P3/P5/P6/P7/P8/P9 remain queued for slots. No phase is VERIFIED.

Parent source review found `repo-intel.v1/read_document` already present in HostKernel and
P4 now uses an injected HostKernel read callback. This is an additive operation on the
existing authenticated RepoIntel service, guarded by ServerAuth/RepoRead/registered
Location, Guard `files.read`, no-follow regular-file traversal, UTF-8/6 MiB bounds,
cancellation and exact pre/post workspace revision. Parent added the §12.18 wire shape,
§17 decision detail, §30/§37 flows and RD-017/LS-011 acceptance. P1 is adding source
coverage; tests have not run and the path remains unverified.

The trusted Core Config→HostKernel LSP/DAP launch profile is now specified in §12.20 and
`contracts-v2/execution-launch-profile-v1.schema.json`: stable profile ID/revision/kind,
configured executable selector, immutable literal argv, fixed registered-Location cwd and
sanitized host environment. No interpolation or caller-supplied executable/argv/env/cwd.
P1 is implementing `execution.v1` prepare/launch/read/write/cancel/status with live Guard
lease and HostProcessRef/receipt fencing; P4 process launch and DAP debuggee effects stay
unavailable until the typed interface, Guard and confinement acceptance pass. REPL remains
unavailable without enforced OS resource limits.

Implementation-first hold remains active: no tests/builds/typechecks/audits/provider or
performance runs until implementation closes. Git remains `main`, 12 commits ahead, with
broad mixed staged/unstaged/untracked state; preserve ownership, no staging/commit/push or
cleanup. `/mnt/c` last showed 60 GB free and `node_modules` 2.5 GB. All P1–P9 and final
release remain PARTIAL / NOT RELEASED.
### P1/P8 guarantee gap — 2026-10-19 18:28 UTC

Current `horizoncode-sandbox` reports OS `ResourceLimits` unsupported, and terminal/stdio
preflights do not require that dimension. Rust reservations, process slots, deadlines and
output caps do not prove CPU/memory/process-count enforcement. §14.5 records the source
state; tasks requiring that guarantee must deny. User decision resolved: profiles requiring
OS CPU/memory/process-count/FD enforcement fail closed until it exists; bounded admission/
monitoring is allowed only for dimensions it actually bounds or observes and never counts as
hard OS quotas. P1/P8 implementation remains open; no tests/builds were run.

### 2026-10-19 — direct child profile authority resolution

Decision: Core Config's immutable `AgentProfileV2` revision is the canonical profile authority
for both direct-session and managed children. The direct `TaskTool.subagent_type` name may
remain a compatibility selector only when it maps to one stable profile ID/revision; legacy
`Agent` data is migration input, never an authority source. The resolved V2 profile must drive
the actual child model, harness, instructions, tool exposure and effective parent-intersected
permissions before the profile reference/digests are pinned to the child Session and Direct
Attempt. Resume uses the exact pinned revision. No legacy-value execution with a V2 digest,
unversioned parent-model fallback, latest-profile substitution or body-supplied identity.

That earlier source snapshot has been superseded: current `TaskTool` resolves the explicit
Core Config selector through `AgentProfileService`, rejects absent/stale profile pins on
resume, checks the selected V2 model, derives effective child permissions, and sends the exact
profile definition/selection into HostKernel direct-Attempt admission. `Agent.Service` remains
the native-session projection layer (`getProfile`), not the profile authority. Source review
still needs to close whether every V2 field is faithfully enforced and pinned across child
session creation, continuation, cancellation and receipt recovery; direct delegation remains
NOT VERIFIED until that integrated lifecycle is complete. This decision follows §§03.5,
12.11, 17.13, 29.2, 29.20 and 37.9; executable regression `VEO-017` is added. The product-wide
check remains named `bun run horizoncode:typecheck`; package-scoped diagnostics must be
described as HorizonCode TypeScript checks with the package path, not as an OpenCode product
typecheck. No validation command was run.

### 2026-10-19 19:34 UTC — active implementation checkpoint

User confirmed the existing trusted Core Config as launch-profile source, projected to
HostKernel and executed through the existing single ExecutionHost supervisor. Active
whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical/direct AgentProfileV2, P4
LSP/DAP/REPL; P7 is next when a slot opens. Parent source review sees bounded finite-number
validation in P1's LSP operation decoder, typed `textDocument/didClose` in P4, P2's explicit
Core Config selector resolution and V2 profile projection into HostKernel direct-Attempt
admission, and P2's source-level live-EXECUTING-Attempt verification transition. HostKernel
now has typed `protocol_op`, `protocol_read`, and `protocol_reply` routes with strict
process/scope/workspace/challenge/lease checks, but intentionally returns
`capability_unavailable` before IO until the durable operation receipt journal and replay
event buffer exist; leases are not consumed. No source observations count as acceptance.

P1 has since source-wired crash recovery for durable direct-child slot reservations: only a
missing/empty pre-admission record can be abandoned, the persisted parent/child Session,
principal and AgentProfileV2 ID/revision/digest must match the exact reservation, mismatches
fail HostKernel startup closed, EXECUTING/UNKNOWN retain capacity, and terminal slot-release
recovery is idempotent. The typed read-page decoder now rejects sequence gaps. P1 closed the
code-mode MCP bypass in source: nested `callTool` dispatch is removed/denied, the `execute`
tool is not registered even under the experimental flag, and a fake-client zero-dispatch
regression was added but not run. P2 source now preserves/resumes only the same active Attempt
for a durable VERIFYING Run when exact verifier, receipt-chain/current-head and no-prior-
verifier-intent/evidence conditions hold; it does not renew the Attempt epoch. P1 must still
revalidate the live lease and recover the exact challenge journal before verifier dispatch.
These source changes are untested.

Implementation remains open across P1–P9, followed by integrated tests, security/recovery,
platform, and release acceptance. The implementation-first hold remains active; no validation
commands are to run before implementation closes. Git state is mixed on `main` (12 ahead,
one worktree, no conflicts); preserve exact staged/unstaged/untracked ownership. C: via
`/mnt/c` has 60 GB free. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 19:43 UTC — verifier recovery integration blocker

P1 confirmed the terminal execution receipt does not retain verifier output bytes or ArtifactRefs;
`reconcile_managed_verifier()` returns UNKNOWN for these rows, and HostCapturedVerifierOutput /
ArtifactStore publication currently occur after execution. P2 removed the unsafe reducer branch
that preserved an EXECUTING Attempt with existing verifier intents. Safe source recovery is now
limited to the same coding Attempt before any verifier intent at the exact final revision, or
SETTLING after typed evidence plus exact artifact/receipt/profile/criterion/epoch pins are
durable. The possible-dispatch → pre-evidence crash window remains UNKNOWN/no redispatch until
P1 adds authenticated, reconstructible output/artifact journaling. This is a source correction,
not verification; P1/P2 remain open and V1 remains PARTIAL / NOT RELEASED.

P1 also found the production HostKernel `managed_begin_verification` /
`managed_execute_verification` route is not connected to P2's Attempt-bound intent/receipt
reducer: current broker authorization has an empty Session and no Attempt scope. P1 owns this
HostKernel integration; P2 owns the reducer/API. Bind the authenticated Session/Location, exact
Attempt/effect IDs, owner epoch, fresh workspace revision, distinct reviewer and Guard lease,
then persist receipts/evidence through the managed APIs. Until then, reducer source is not
production verifier wiring and finalization remains disabled.

Parent added `ExecutionProtocolDispatchReceiptV1` as a strict machine contract and fixed the
canonical digest preimages in §37.6. DAP `threads` maps to the existing scoped read-only
`debug.stack` capability; no `debug.threads` alias is added, and `variables` remains denied
without adapter-specific passive-read proof. HostKernel must enforce this map before process
write. P4 is replacing stale LSP child-process fixtures and adding DAP protocol contract
fixtures as source only. The restart owner-epoch freshness check belongs to HostKernel, which
must persist UNKNOWN/RECONCILING for stale epochs before any resume (preserving CANCELLING).
No tests/builds/typechecks/audits have run; these are not acceptance results.

## Current whole-phase continuation — 2026-10-19 19:51 UTC

P1/P2/P4 remain the active whole-phase owners in all three real child slots. P7 is next when
a slot actually opens; P3/P5/P6/P8/P9 remain queued. Parent owns this tracker and cross-phase
integration. No phase is accepted or verified.

P1 has source-connected HostKernel managed verifier operations to P2's Attempt-scoped reducer
calls, including intent, receipt and typed observation paths plus stale owner-epoch fencing.
The adapter kill switch is still false. Possible-dispatch crashes still cannot reconstruct
terminal verifier output/ArtifactRefs and remain UNKNOWN/no-replay. Typed LSP/DAP protocol IO
still fails closed before process IO until the durable operation journal and replay buffer
are complete. P1's universal Guard origin closure, ToolBatch atomic admission/lease/receipt
recovery, launch profile execution, OS confinement and adversarial matrix remain open.

P2 added revision-fenced Goal Run pause/resume/cancel route, SDK method and TUI `goal.control`
confirmation path. The UI submits the exact Goal revision it displayed; the handler rejects
a stale view before CAS. Direct AgentProfileV2 selector projection and managed Attempt/evidence
recovery remain under phase ownership.

P1 added canonical protocol operation/dispatch-receipt digests and ACK parsing, but durable
sequence journal, supervisor IO, receipt-before-ACK and replay are still absent. P4 replaced
the raw child LSP fixture with typed no-effect source and added Core-side LSP/DAP journals for
outbound sequencing, receipt correlation, replay suppression and conflict quarantine. The
HostKernel-connected adapter and all process effects remain unavailable pending P1. P4 still
owns adapter IO/lifecycles, guarded DAP debuggee effects, REPL mediation/recovery and
real-project acceptance.

Implementation-first hold remains active: do not run tests, builds, typechecks, architecture
audits, provider probes or performance runs until full requested V1 source implementation
closes. Git is still a mixed shared tree; preserve all ownership and do not stage, commit,
push, clean or prune. C: via `/mnt/c` most recently showed 60 GB free. Overall V1 is PARTIAL /
NOT RELEASED; integrated verification, end-to-end journeys and release gates remain open.

### Source-only integration update — 2026-10-19 19:53 UTC

P1 connected HostKernel's managed verifier happy path from typed evidence to exact Attempt
settlement: the host derives the sorted receipt digest from OwnerLog effects, calls
`BeginAttemptSettlement`/`SettleAttempt`, and updates the verifier challenge journal after the
reducer commit. Workspace drift retains terminal receipts before the Attempt becomes UNKNOWN.
The verifier adapter remains disabled. The cross-store crash between OwnerLog settlement and
journal SETTLED must reconcile from durable OwnerLog evidence without redispatch; pre-evidence
crash still stays UNKNOWN/no replay.

P2's `goal.control` TUI path now uses the authenticated Goal snapshot and exact displayed
revision, submits it to the HTTP route, and receives a bounded Run phase projection. Stale
views reject before CAS. Source regressions are present but unrun. No implementation phase is
verified; the implementation-first validation hold and PARTIAL / NOT RELEASED status remain.

Parent found a managed-verifier result-truth mismatch: `SettleAttempt` stores RunPhase::Failed
when any criterion verdict fails, but HostKernel currently replies `VERIFIED` unconditionally.
P1 owns mapping its response from the durable post-settlement Run state and adding a source
regression. This remains an open implementation item; no validation has run.

P4 additionally source-added DAP event-page Attempt/process/workspace fences, event and byte
bounds, processIOSequence advancement and gap rejection; the REPL registry retains validated
direct Attempt scope. The HostKernel typed protocol methods remain unavailable before IO
pending P1's durable journal/replay. No fixtures were run.

Open recovery finding: P1's evidence-only verifier settlement recovery omits RunPhase::Cancelling,
although the managed reducer preserves CANCELLING through settlement. This could strand durable
evidence/journal state after a cancellation race. P1 owns settlement-only reconciliation that
preserves cancellation; P2 owns a truthful CANCELLING response/schema/TUI projection. No recovery
dispatch is allowed.

Superseding source update: P1 added evidence-only cancellation recovery for CANCELLING and
CANCELLED, validates settled receipt digests, and returns truthful verifier statuses. Prior
owner epochs are accepted only to reconcile exact evidence-backed SETTLING/SUCCEEDED state;
unresolved stale Attempts become UNKNOWN. P2 must still extend the TypeScript schema/SDK/TUI
for cancellation statuses. P1 added DAP requestID safe-integer bounds. P4 added exact duplicate
ACK receipt replay, conflicting retry quarantine, bounded receipt history, inbound cursor
fencing and integer event/byte bounds. Actual HostKernel protocol IO remains unavailable;
source-only, unverified.

P2 has since aligned GoalVerification response schema, SDK and TUI status handling for
CANCELLING/CANCELLED/FAILED with HostKernel. These changes are not tested or accepted.

## 2026-10-19 20:10 UTC — active whole-phase implementation ledger

| Phase | Owner | Current source state | Remaining implementation before verification |
|---|---|---|---|
| P1 Guard / ExecutionHost | `p1_guard_v1_resume_1020` | Whole-phase owner active. P1 is implementing the HostKernel descriptor-relative no-follow per-path observation needed by P7; P2 is renaming its direct receipt uncertainty field to `observation_digest` before HostKernel write/patch integration. Post-approval Attempt binding is required for both batch and managed effects. | Finish universal Guard routing, exact post-bind ToolBatch leases, durable receipts/UNKNOWN recovery, authenticated profile launch and supervisor IO, OS confinement, atomic multi-effect approval/binding and adversarial implementation; coordinate P8's typed proof boundary. |
| P2 managed vertical | `p2_managed_v1_resume_1020` | Whole-phase owner active. Rust reducer now has source for atomic `PlanRun`, `RunPhase::Planned`, and `StartPlannedRun` (RUNNING plus dependency roots ready); Core plan path and authenticated HTTP start handler are being wired. Durable EXECUTING→UNKNOWN recovery inference is also appended with deterministic idempotency. None verified. | Finish P1 HostKernel `plan_run/start_planned_run` ingress, generated SDK/TUI start journey, complete authenticated plan→Task/Attempt→prompt entry, exact AgentProfileV2 pin, distinct reviewer, receipt/current-head, independent verifier artifacts and restart/cancel/conflict recovery. P2 owns reducer/Core/API/SDK/TUI; P1 owns HostKernel/Guard ingress and ToolBatch. |
| P4 LSP/DAP/REPL | `p4_lsp_dap_repl_wave2_1019` (returned) | Source-only bounded LSP/DAP transport, ACK/replay/correlation and Attempt-scope lifecycle work returned. | P4 remains PARTIAL: P1 must supply supervised Guarded launch/IO/replay/confinement; OS-enforced REPL limits remain unavailable. Reassign P4 owner when a slot opens for dependent integration and whole-phase repair. |
| P8 resources / workers / RC0 | queued (prior worker exited; no active owner) | Root logical coordinator WorkerExecution, child RESERVED lease pinning and post-DelegationBinding digest attachment are designed; P1 still needs authenticated P8 proof producers. | Reassign entire phase when a slot opens; implement durable reservation/worker/worktree lifecycle, authenticated root/nested owner proofs, attributed resource reconciliation and restart recovery. No fan-out before P1 gates; resource accounting must not invent unsupported OS quotas. |
| P7 streaming / artifacts / analytics / automation / rewind | `p7_stream_artifacts_v1_1020` | Whole-phase owner active. Source confirms ActivityStream is mounted, ArtifactStore/automation/checkpoint journals exist, but invocation/restore gates remain false. Checkpoint preview lacked digest-bound targeted per-path recovery; P7 is wiring it against P1's typed no-follow file-kind/link-count observations. | Finish redaction/render bounds, reconnect/replay/resnapshot, artifact truth/provenance, Rust-owned guarded automation, and preview-bound targeted rewind/recovery while preserving destructive-reset refusal and rejecting ambiguous file kinds. |
| P3, P5, P6, P9 | queued | Existing partial source remains unaccepted. | Assign whole-phase owners as slots free, following the operative dependency graph; effectful paths remain gated by P1. |

P2's envelope is `{goalID, runID, taskID, attemptID, ownerEpoch, expectedManagedRevision,
locationID, sessionID, workspaceRevision, delegationBindingDigest}`; HostKernel must validate
each pin against authenticated durable state. No tests/builds/typechecks/audits/provider probes/
performance runs are permitted until requested V1 source implementation closes. Git remains
mixed (`main`, 12 ahead, no conflicts); C: via `/mnt/c` has 60 GB free (87% used). No phase is
VERIFIED; release remains PARTIAL / NOT RELEASED.

### Attempt-bound lease contract update — 2026-10-19 20:03 UTC

The scope digest includes the aggregate OwnerLog revision, which changes when ToolBatch effects
are bound. Final design now requires Guard evaluation/explicit approval, atomic binding of the
complete exact Attempt effect set, refreshed HostKernel scope validation, and only then one-use
lease issuance bound to the refreshed scope plus each exact edge/intent. This applies to direct
and managed children. No lease is issued from the pre-bind scope; no issued lease is rewritten;
intervening revision/workspace/policy changes fail closed. Normative updates are in §§14.3,
17.15, 32.38/VEO-019 and 37.22. P1 owns EffectHost/HostKernel and `tool-batch.ts`/`tools.ts`;
P2 owns managed reducer plus managed-control/prompt/LLM caller propagation.

P2 source now contains typed ManagedAttemptScope authority/codec propagation and atomic bounded
`BindAttemptEffects` reducer support. HostKernel and ToolBatch integration remains owned by P1;
managed effect dispatch remains unavailable. This does not change phase status: P1/P2/P4 active,
P7 queued, remaining phases queued; no validation has run; V1 remains PARTIAL / NOT RELEASED.

### Managed admission dependency update — 2026-10-19 20:05 UTC

Current HostKernel `managed_admit` still denies with `capability_unavailable` after strict
profile/context shape checks because trusted DelegationBinding/owner proofs are not assembled.
P1 owns implementing authenticated admission, exact Task profile pin, and the HostKernel-issued
`managedAttempt` scope. P2 owns the Core/TUI request and strict response mapping, plus its typed
scope through prompt/LLM and managed reducer. P1 also owns ToolBatch/EffectHost and the post-bind
lease contract. No effectful managed dispatch is available. Scope must be refreshed after every
OwnerLog mutation before another effect; caller-side revision arithmetic is not authority.

P1's source audit further found the managed admission proof depends on P8's parent-execution
lineage and durable worker lease plus a Guard-derived effective capability ceiling. No current
HostKernel WorkerPool RPC produces these facts; the worker owner path explicitly keeps fan-out
closed. P1 will not accept caller claims as a substitute. Assign the whole P8 phase at the next
slot release; P7 is also needed for P2 immutable verifier artifacts. Schedule these two phase
owners based on the owner APIs they expose, with P8 now on the managed-admission critical path.

P4 source progress: a method-bounded DAP adapter now maps commands to Guarded HostKernel calls;
LSP transport adds serialized writes, exact retained Attempt scope and listener-before-request
ordering. These are CODE_PRESENT only. Launch remains gated pending P1 typed protocol IO,
supervised launch and containment; REPL remains gated on OS-enforced resource limits.

### 2026-10-19 20:10 UTC — P8 active and managed root-execution contract resolved

The whole-phase P8 worker/resource/worktree owner `p8_worker_resources_full_1019` is active in
one of the three actual child slots alongside P1 (`p1_guard_full_resume`) and P2
(`p2_managed_wave2_1019`). P4 has returned its source-only adapter package and is PARTIAL pending
P1's Guarded supervised process/IO/replay/confinement path and unsupported OS quota boundaries.
P7 is queued for the next real slot because P2's independent verifier requires immutable
ArtifactStore output/evidence APIs.

Parent resolved the missing parent of the first managed Task: `DelegationBindingV1.parentExecutionID`
uses a durable Rust logical root-coordinator `WorkerExecutionId` bound to the authenticated
existing Core Session/Run, OwnerLog and fenced Core transport/process incarnation. It is lineage
for the existing Core coordinator, not a second runtime, transcript or spawned process. The
current Attempt owns its own P8 RESERVED lease; shared Core process measurements are counted
once and no separate root-worker quota is claimed. Nested children continue to require an active
claimed parent WorkerExecution. P8 pins pre-admission Attempt/profile/context/Spec/workspace facts
in the RESERVED lease; P1 atomically persists the binding and lease refs, then P8 attaches the
exact binding digest before claim/dispatch. If identity/incarnation is unavailable, admission
fails closed. This ruling is recorded in arch_V1 §§12.18, 17.16, 29.5, 37.22 and VEO-021.

P2 confirmed its `ManagedAttemptAuthority` helper had no production caller and no actual
prompt/LLM scope propagation. It is now adding the missing generated SDK operation for the
existing `goal.plan` TUI caller and a trusted `promptManaged(input, authority)` entry; it reports
P1 has supplied typed profile/context admission fields and owner-derived scope. This path is
still being wired, not acceptance evidence. P1 and P8 have the root proof/lease sequence and
exclusive file boundary. No tests/builds/typechecks/audits/provider probes/benchmarks ran.
Git remains mixed and untouched; C: via `/mnt/c` last showed 60 GB free. No cleanup/prune.
V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:13 UTC — launch-profile decision and direct receipt dependency

The user confirmed the V1 LSP/DAP launch-profile source: project the existing trusted Core
configuration into HostKernel, resolve the immutable profile there, and execute only through
the existing ExecutionHost supervisor. Do not accept caller-selected executable/argv/process
fields or introduce a second supervisor. P1 owns the authenticated projection and Guarded
launch path; P4's LSP/DAP adapters remain unavailable until the supervisor, confinement and
protocol receipt/replay prerequisites are implemented.

P1's active source review found that Rust `DirectAttemptControl` currently persists admission,
exact effect-intent binding and terminal status, but lacks durable per-effect receipts and
per-receipt workspace-head revisions. This prevents safe direct-child multi-effect dispatch
and scope refresh after workspace mutation. P2 now owns adding the direct Attempt receipt/head
owner-log command with exact effect/intent linkage, replay/conflict handling and UNKNOWN
recovery; P1 owns HostKernel/EffectHost integration, receipt validation, lease sequencing and
fail-closed dispatch. This boundary is source work only; no tests/builds/typechecks/audits ran.

P1, P2 and P8 remain the three active whole-phase owners. P7 is next after an actual slot
release; P3/P5/P6/P9 remain queued. The implementation-first hold remains active. Git state is
mixed and preserved; no stage/commit/push/cleanup was performed. C: via `/mnt/c` has 60 GB free.
V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:13 UTC — pre-approval bind ordering gap

P1 source review found ToolBatch PREPARE currently binds Attempt effect edges before the Core
approval decision, violating the approved lease order. P1 is moving the atomic bind to the
post-approval resolution path (or immediately after an unchallenged Guard ALLOW), retaining the
pre-bind scope only as challenge provenance. The HostKernel must then return the refreshed scope,
revalidate the exact effect set/current workspace and issue a lease against that refreshed scope.
No Attempt mutation occurs before a required approval; retries remain idempotent and stale/cancelled
requests fail closed. Source fix is in progress; no tests or checks have run.


### 2026-10-19 20:14 UTC — approval ordering also covers managed effects

Parent source review found `managed_bind_attempt_effect` accepts `awaiting_approval` and writes
`BindAttemptEffect`, so the same PREPARE-before-approval mutation may exist on the managed
per-effect path. P1 is tracing and correcting both direct batch and managed per-effect callers
under the common §14.3/VEO-019 order: challenge/provenance first, approval if required, complete
exact binding, refreshed scope/revalidation, then one-use lease. Verifier immutable intent
handling must follow its specific contract without mutating the Attempt before approval. This
is an open source finding assigned to P1; no checks ran.


### 2026-10-19 20:40 UTC — parent orchestration checkpoint

User resolved the managed-start ambiguity: implement separate authenticated goal.start after acceptance of a SpecVersion. goal.plan persists the pinned Run/task plan as non-dispatchable PLANNED; start atomically transitions that exact plan to RUNNING and readies dependency roots for the current accepted SpecVersion/Goal revision, with stable idempotent retry and conflict on mismatched key reuse. Start grants no Attempt/effect authority. P2 owns implementation across Rust reducer, authenticated route/SDK/TUI. Normative architecture: arch_V1 §§3.4, 17.18, 32.38/VEO-023, 37.22.

Active phase owners in the three actual child slots: P1 p1_guard_v1_resume_1020, P2 p2_managed_v1_resume_1020, P7 p7_stream_artifacts_v1_1020. P1/P2 coordinate observation_digest direct receipt linkage and preserve exclusive managed_control.rs ownership with P2. P2 has source-persisted recovery UNKNOWN using deterministic idempotency. P7 found targeted checkpoint recovery preview missing for later commits and is adding digest-bound path selection; normal restore remains unavailable. P8 is queued (previous owner exited), along with P3/P5/P6/P9; P4 is partial pending P1.

No tests/builds/typechecks/audits/probes/benchmarks until V1 implementation source closes. Git mixed and untouched; one worktree. C: via /mnt/c has 60 GB free. V1 PARTIAL / NOT RELEASED.



P1 and P7 aligned on checkpoint filesystem facts: P1 owns a typed descriptor-relative no-follow HostKernel per-path observation (path, kind, link count, digest, size, executable) with race checks; P7 consumes it through the existing workspace boundary, never a parallel reader. Restore remains unavailable until the host facts and Guarded dispatch exist. Selected-path recovery accepts only conflict-free captured regular files with one link; full reset after later commits stays refused. Normative preview contract and CP-001/CP-002 were updated in §§14.19, 16.18 and 32.


### 2026-10-19 20:44 UTC — source-only managed and checkpoint deltas

20:44 UTC source delta: P2 has added reducer source for atomic PlanRun, new RunPhase::Planned, and StartPlannedRun (RUNNING plus dependency roots READY); its Core plan path and authenticated HTTP goalRunStart handler are being wired. P1 owns the HostKernel plan_run/start_planned_run routes and must reject Planned from all dispatch/admission/control paths. P2 also changed direct receipt persistence to use observation_digest and persist recovery UNKNOWN. P1's typed descriptor-relative no-follow HostKernel workspace observation now carries path, kind, link count, digest, size and executable, with single-link rejection and race checks. P7's checkpoint manifest/preview now requires those trusted file facts; selected-path preview remains blocked until authenticated dirty/untracked status is complete and restore stays disabled.


Checkpoint preview provenance correction: the current trusted source compares workspace revision digests, not Git commit ancestry. The preview field is therefore workspaceRevisionChanged, not laterCommit. Full restore is refused on any revision change; no Git commit provenance is claimed. P7 renamed the source field and uses the same name in the projection. P1 received the private no-follow preview/recompute route contract from P7; VCS dirty/untracked status remains required before selected-path preview can expose actions.


### 2026-10-19 20:45 UTC — planned-run authority pins

P2 confirmed the planned-run reducer recomputes the canonical Task-set digest at goal.start and persists it in the start event; the operation body has no task/profile input. PLANNED rejects scheduler/admission/pause/resume and can be safely cancelled without creating effects. The user-facing API/TUI/SDK journey remains in progress; P1 owns HostKernel routing.


Additional P7 capture gap: current capture_guarded can accept snapshot bytes unrelated to the observed file manifest. P1 now owns a bounded opaque snapshot bundle minted by the same descriptor-relative no-follow traversal/race check, binding exact file bytes and manifest to the observed revision. P7 may persist only that bundle; capture/preview/apply remain unavailable until it exists. This is now normative in §14.19.


Cross-phase parent review found legacy HostKernel managed start_run/add_task ingress remains beside the new planned-run path. P1/P2 are coordinating fail-closed disablement/replay-only compatibility so no legacy call can create a dispatchable Run outside exact PLANNED + authenticated goal.start. VEO-023 now covers both ingress paths.


Attempt-bound ToolBatch design is now explicit in §14.3: approve and bind the full exact set before first dispatch, then issue/consume one lease at a time. A successful settled receipt and correlated refreshed scope are required before leasing the next member; failure/UNKNOWN/missing/mismatch fences the remainder. P1 is implementing the HostKernel/Core API expansion under the already authorized P1 scope; VEO-019 now covers this sequence.


### 2026-10-19 20:52 UTC — trusted checkpoint capture bundle consumed

P1 has added the bounded `TrustedWorkspaceSnapshotBundleV1`, minted from the same descriptor-relative no-follow traversal that derives the workspace revision and file manifest. P7 now makes checkpoint capture consume only that opaque bundle, derives file records and manifest digest from it, and persists its serialized bytes instead of request-supplied bytes. `CHECKPOINT_CAPTURE_ENABLED` remains false until P1 completes and the parent reviews authenticated Guarded HostKernel wiring; preview actions still require authenticated VCS dirty/untracked facts, and restore apply remains unavailable. This is source progress, not acceptance evidence. No tests/builds/typechecks/audits/probes/benchmarks ran. P1, P2 and P7 remain active whole-phase owners; V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 20:53 UTC — runtime route gaps and serial lease implementation

P7's source review found the remaining runtime boundaries explicitly: HostKernel still lacks AutomationServiceV2 and checkpoint snapshot-preview routes; Core/TUI lacks automation list/edit/history; guarded checkpoint restore and artifact eviction adapters plus receipt recovery are absent. P1 now owns the HostKernel/Guard routes and is implementing `effects.v2/lease_next_batch_effect`: HostKernel chooses the next exact Attempt-bound intent from durable ordered state, requiring a successful prior receipt and current observed workspace head before issuing one lease. Approval binds the full set before the first dispatch; Core must execute sequentially and request each later lease only after the prior receipt settles. P2 owns canonical managed Core/API/TUI control; P7 continues replay/render/artifact source work. These dependent effects remain unavailable until their authority, receipts and recovery are wired. No checks have run.


### 2026-10-19 20:56 UTC — explicit managed start reaches the TUI

P2 reports the TUI now obtains a trusted Goal snapshot, derives current Goal revision and accepted SpecVersion ID/digest, requires a `PLAN_ONLY` Run, then calls `goalRunStart` with only Goal/Run/idempotency and surfaces returned phase/revision or conflict. Core's legacy `startRun`, `addTask` and `markTaskReady` exports/service methods have been removed. SDK snapshot fields and fixtures remain in progress. No checks have run; this is source status only.


### 2026-10-19 20:57 UTC — Goal snapshot pins and automation control source

P2 has added accepted SpecVersion and per-Run `specID` fields to the Goal review snapshot projection and updated generated SDK response shapes, completing the source data needed by `goal.start`. A TUI regression fixture now covers deriving the accepted SpecVersion/revision from the trusted snapshot and sending the start request; it has not been run. P2 is moving to Core/API/TUI automation list/edit/history while P1 defines the HostKernel route and response bounds. C: last checked at 59 GB free (88%); Git remains mixed (150 staged, 235 unstaged, 173 untracked; no conflicts) and untouched.


### 2026-10-19 20:58 UTC — incomplete direct receipt cancellation fence

P2's source audit found direct `Cancel` can currently mark an Attempt CANCELLED while bound effects have no terminal receipts, and P1's HostKernel path can release its terminal slot. A batch cancelled after a successful prefix also needs a typed durable proof that all remaining intents were unleased/revoked. Cancellation without that proof must become UNKNOWN and retain/fence the slot until reconciliation; cancellation proven before dispatch can be terminal. P2 is tightening reducer receipt-chain semantics and P1 owns HostKernel cancellation/slot handling. This is source-only; no tests or validation run.


### 2026-10-19 21:00 UTC — renderer bounds and lease replay gap

P7 has source changes to clip raw renderer input before sanitization, cap aggregate rendered output with inert-source fallback and truthful FAILED fidelity, validate stream envelope seed advances correctly, and bound artifact-reference metadata before text encoding. No tests/builds/typechecks ran. Parent source review of P1's new `lease_next_batch_effect` found a lost response could strand an issued next lease because retry rejects an existing lease digest; P1 has been asked to return the same authority safely or reconcile an unconsumed lease after restart, and to define exhaustion behavior. P7 confirms checkpoint preview/VCS facts, guarded restore/eviction and HostKernel automation routes remain open source work. C: last checked at 59 GB free.


### 2026-10-19 21:02 UTC — parser and replay bounds tightened

P7 now caps completed artifact source at 16,384 lines before split/parser allocation and returns inert source with FAILED fidelity above 512 KiB rendered output. Oversized replay deltas request a canonical resnapshot rather than direct delivery; invalid cursors are not forwarded as trusted resnapshot IDs. ArtifactRef metadata is checked against a 4 KiB limit before trimming/allocation. All are source edits only; no tests/builds/typechecks ran. P1 still owns authenticated checkpoint preview/capture, same-boundary VCS status, Guarded restore/receipt reconciliation and AutomationServiceV2; P2 owns automation control API/TUI. P7 keeps these effect paths closed pending those contracts.


### 2026-10-19 21:04 UTC — P8 resumes as whole-phase owner

P7 returned PARTIAL after completing its independent renderer/replay source work; its remaining runtime routes and evidence are blocked on P1/P2. The freed child slot is now assigned to `p8_resources_workers_full_resume_1019` for the entire P8 resources/workers/worktree/RC0 phase. P8 owns its durable worker, worktree, resource and RC0 modules; P1 owns HostKernel/Guard integration and P2 owns managed-control/Core integration. P8 must continue independent work, coordinate exact proof/lease boundaries, and keep fan-out unavailable pending verified P1/P2 prerequisites. Active child roster: P1, P2, P8. No validation commands have run.


### 2026-10-19 21:08 UTC — managed TaskTool caller dependency

P2 source review found no production caller for managed Task execution: `TaskTool` admits only DirectAttempt and calls `ops.prompt` with direct authority; `promptManaged`/`ManagedAttemptAuthority` are not yet wired. P2 cannot safely add the managed dispatch adapter until P8 supplies the authenticated scheduler-to-Core proof/handoff and P1 provides the HostKernel admission/Guard boundary. P8 has been asked for the exact proof, reservation, delegation binding, digest attachment, dispatch, cancellation and recovery sequence; P2 continues independent automation/reviewer/verifier/UI work. Managed effectful execution and worker fan-out remain disabled.


### 2026-10-19 21:12 UTC — managed admission ordering settled

The §12.18/§37.22 ordering is now explicit in §37.22 and §17.18: HostKernel mints opaque `TrustedPreAdmissionPinsV1` from authenticated current Ready Task/Spec/profile/context/Guard/workspace/budget/parent facts; P8 durably reserves and returns `ReservedWorkerLeaseProofV1`; P1 atomically appends Attempt + DelegationBinding + exact refs; P8 attaches the binding digest; then authenticated one-use `managed.claim_dispatch` returns `ManagedDispatchHandoffV1` to Core TaskTool. Crash/lost response remains RESERVED/UNKNOWN until OwnerLog reconciliation; no timeout release or automatic relaunch. P1/P8 are implementing this boundary; P2 consumes the opaque handoff when available and continues independent P2 source work. Managed dispatch stays unavailable until the full chain is present.


### 2026-10-19 21:15 UTC — automation owner and storage boundary

P1 has supplied the strict `automation.v1` operation set and P2 has added the Core RPC adapter plus typed HTTP handler using trusted principal and registered Location. Parent settled the HostKernel owner boundary in §37.10: Rust persists only under private `state_dir/automations/`, scoped by authenticated owner binding plus registered Location/workspace; no request path or Session-only persistence. List/create/update CAS require a bounded Rust-owned registry in addition to per-definition occurrence journals. `run_now` stays unavailable until Guarded invocation and receipt recovery exist. P1 owns the HostKernel route; P7 owns the Rust registry/journal; P2 owns the SDK/TUI path. No checks have run.


### Active implementation checkpoint — managed start and automation

Managed Run start is explicitly `goal.start` after accepted SpecVersion and a complete PLANNED
task set. P2's source includes the user-facing start journey, pending final integration and
acceptance. Automation Core adapter response-shape mismatches were found and corrected during
parent review; `runNow` now returns typed CAPABILITY_UNAVAILABLE without calling HostKernel.
P1 retains an independent Rust pre-dispatch refusal and continues Guard/ExecutionHost work. P7
owns the durable bounded automation registry and occurrence journals; P1 is coordinating its
interface while progressing other P1 items. P1/P2/P8 are active. Tests/builds/typechecks/audits/
probes/benchmarks remain intentionally deferred until implementation source closes. V1 status:
PARTIAL / NOT RELEASED.

09:24 UTC P5 source correction: classify a HostKernel settled success whose result payload is
absent or cannot be safely parsed as `RESULT_UNAVAILABLE`, preserving the receipt reference so
the tool settles the known effect without fallback/retry. Added source regression cases for
absent, empty and malformed bodies; not run. No validation performed.


### Active source checkpoint — managed dispatch fence and DAG planning

P8's source now exposes the durable `ClaimedWorkerDispatchProofV1` facts (Attempt/worker IDs,
binding and pins digests, OwnerLog ID/sequence/event digest, pool revision and stable claim
nonce); P8 confirms this is a separate log from managed control. Parent arbitration therefore
assigns the no-replay `ConsumeManagedDispatch` marker to the canonical managed-control OwnerLog:
P1 authenticates and invokes it, P2 owns the reducer event, and P8 owns the durable one-use claim
proof. No cross-log atomicity is assumed. Core persists the exact consume receipt and pending
prompt state before provider dispatch; ambiguous restart is UNKNOWN/no automatic retry. §§17.18
and 37.22 now record this contract.

P2 also removed the single-Task/one-criterion plan ceiling and now builds bounded 1–64 Task DAGs,
validates exact criterion coverage, dependency membership/cycles, and pins each AgentProfile
revision. This is source-only. P1/P2/P8 remain active; no tests/builds/typechecks/audits/probes/
benchmarks have run. V1 remains PARTIAL / NOT RELEASED.


### Active source checkpoint — durable handoff/restart work

P1 has changed post-dispatch missing or malformed write/patch response and receipt handling to
best-effort persist UNKNOWN and return uncertainty, rather than surfacing a validation error that
could invite retry. P1 is reviewing cancellation/reconciliation branches and wiring the managed
consume route. P2 owns the typed `ConsumeManagedDispatch` reducer event in ManagedControl; P1
validates the live P8 claim and calls it. P8 now records exact pre-admission RESERVED worker IDs
in restart/owner-epoch recovery events so they do not timeout-expire across the P1 admission
window; CLAIMED/RELEASE_PENDING remains quarantined. These are source changes only. P2's bounded
1–64 Task DAG plan source is present and profile-pinned. P1/P2/P8 remain active, with all
validation still deferred.


### Active source checkpoint — authenticated Core peer identity

P1 source review found HostKernel request context currently retains owner epoch and negotiated
process-incarnation string but not the OS-authenticated Core PID/start identity. `unix_peer.rs`
validates SO_PEERCRED and executable identity, but the identity is dropped before request
routing. Parent assigned P1 to propagate a private typed listener-to-HostKernel context carrying
PID/UID/GID, executable identity and process-start identity, bound to the negotiated incarnation;
these facts must never come from RPC bodies. Missing identity keeps managed root admission
unavailable. §§17.18/37.22 now record the rule. This is source work only; no tests/builds/
typechecks/audits/probes/benchmarks have run.


### Latest source-only checkpoint — 2026-10-19 21:17 UTC

P8 is implementing a durable opaque EXPIRED tombstone receipt for `NotAdmittedNoDispatch`,
including its OwnerLog cursor, exact candidate identities/pins, pool revision and proof/receipt
digests. P2 owns the authenticated ManagedControl Task-generation increment and exact delivery
replay; P1 consumes the receipt and mints only the candidate implied by persisted Task ID and
generation. P8 enforces unique Attempt identity. P1 says listener-only private `UnixPeerIdentity`
plus live PID/start/executable revalidation is now in source, and has fixed one partial-prefix
cancellation source issue. These changes are unverified; no tests, builds, typechecks, audits,
provider probes or benchmarks ran. P1/P2/P8 remain active; all other phases, final verification,
and V1 release remain open.
Candidate identity binds Task ID plus durable `attempt_count` and `candidate_generation`;
admission and verified pre-admission tombstones advance their respective counters. P2's
proof/event/receipt CASes both values; P1 includes both in immutable reservation pins and derives
the candidate from this tuple to prevent collisions after admitted retries.
Candidate IDs bind Task ID plus durable `attempt_count` and `candidate_generation`; admission
and verified pre-admission tombstones advance their respective counters. P2's proof/event/receipt
CASes both counters, and P1 includes both in immutable reservation pins. This prevents ID reuse
after admitted retries.
Candidate tombstone disposition and terminal state use typed P8 enums and strict event decoding.
Worktree base-revision locator and measured workspace content revision remain separately pinned,
not interchangeable or required to match (§§21.11/37.22). No validation ran.


### Latest source-only delta — pre-admission candidate recovery (2026-10-19)

**Active whole-phase owners:** P1 Guard/ExecutionHost, P2 managed vertical, P8 resources/workers.

P8's durable OwnerLog can now resolve an existing `NotAdmittedNoDispatch` + `EXPIRED` receipt by candidate Attempt ID after lost response/restart, while rejecting duplicate candidate pins and changed receipt identity. P1's authenticated HostKernel route derives the candidate from the exact READY Task counters, validates SpecVersion/profile/SessionLink/Location/workspace and authenticated Core peer/ServerAuth, confirms there is no HostKernel process binding, then passes the opaque P8 receipt to P2. P2 recomputes the candidate identity and advances only the matching Task generation with revision-fenced exact-delivery replay. Candidate ID domain-separated BLAKE3 includes Task ID, admitted `attempt_count`, and tombstone `candidate_generation`. Worktree base revision and measured workspace revision remain distinct.

**State:** source-present/source-reviewed; not tested or verified. No Attempt, worker claim, provider prompt, or effect authority is created by candidate renewal. P1's actual managed admission/claim/consume and P2's TaskTool delivery remain incomplete pending durable P8 proof construction and managed-control consume wiring. P3/P4/P5/P6/P7/P9 and final gates remain open. No validation command ran. Tree is mixed (150 staged, 238 unstaged, 173 untracked, zero conflicts); do not stage or publish ambiguous changes. C: via `/mnt/c` has 59 GB free.


### Active source delta — candidate replay and dispatch fence

P1 now consults P2's exact `candidate_abandonment_receipt(delivery_id)` before deriving the current candidate generation. Replay still revalidates authenticated ServerAuth, Goal/registered Location/workspace, then matches P8's opaque `NotAdmittedNoDispatch` + `EXPIRED` receipt and the exact Task counters, pins, worker/ticket, and receipt digest before returning the durable result. P2 also added an exact `managed_dispatch_consumed_receipt(attempt_id, delivery_id)` lookup; P1 has been asked to use it before any P8 lookup or candidate dispatch proof reconstruction. Source only; no tests/builds/typechecks/audits have run.

P2 confirms `TaskTool` remains fail-closed for managed attempts because HostKernel `managed.claim_dispatch` / `managed.consume_dispatch` are not yet wired. `goal.start` is mounted through the goal-review handler; SDK/TUI source includes automation controls, while `run_now` remains unavailable. P1/P2/P8 continue as whole-phase owners; the managed child dispatch dependency remains open.


### Source decision — managed lease inputs (2026-10-19)

Resolved P1's request for implicit admission defaults from the existing owners: trusted inputs come from the authenticated accepted SpecVersion, the Task-pinned AgentProfileV2, and P8's durable pools. Each Attempt reserves one `ActiveWorkers` unit bounded by both WorkerPool `max_live_workers` and Spec `max_workers`; this is admission accounting, not an OS quota. CPU/memory/disk/FD are measurement/backpressure only unless OS enforcement is proven; unsupported explicit memory/disk guarantees remain unavailable, and no synthetic quotas are created. P2 must persist trusted `goal.start` time so Attempt expiry can use remaining Spec `max_run_duration_ms`; profile `limits.wallTimeMs` further bounds it when present; the existing 24-hour lease ceiling applies, and expiry never releases a lease. P8 supplies worktree ID/base locator only from eligible clean durable registrations; HostKernel's content digest stays a separate pin. Missing eligible worktree or unknown required capacity keeps admission unavailable. Architecture decision recorded in §17.19 and implementation contracts in §§21.11 and 37.22. Source-only; no validation run.


### Source delta — persisted start time and lease resolver (2026-10-19)

P2 now derives `Run.started_at_ms` from the canonical OwnerLog envelope `time_ms` for `planned_run_started`; replay reconstructs the same value. HostKernel's `goal.start` response projects that trusted time, and the managed owner exposes remaining accepted Spec duration; this timestamp is not request supplied. P1 corrected its caller to keep `start_planned_run` timestamp-free and will require a positive trusted remaining duration when deriving child lease expiry. P8 is implementing `resolve_managed_worktree` from its durable registration owner and correcting the distinct Task revision / workspace content digest / worktree base-locator pins. P8 must also project trusted ActiveWorkers capacity from pool limits; CPU/memory/disk/FD stay monitoring unless OS enforced. Source only, no checks run. Managed admission/claim/consume remains absent; TaskTool stays fail-closed.


Architecture synchronization: §03.4 now describes lease limits and worktree source; §04.2/4.3 bind Run duration to the durable OwnerLog envelope timestamp; §12.1 exposes Run.startedAtMs as a derived projection. These reflect the current P2 source direction and settled §17.19 policy; still unverified.


### Managed child runtime boundary decision (2026-10-19)

Resolved P1's question from §17.18/§37.22 and the existing Core TaskTool seam: managed children run as logical Core Session/Task/Attempt inside the existing Core process; V1 does not launch a second model-host executable. The immutable Core Config AgentProfileV2 selects model/harness and child policy. P8 WorkerExecution is lineage + resource/worktree lease identity, not spawn authority. Shell/process effects still pass through the single P1 Guard/ExecutionHost. LSP/DAP executable-profile projection is a separate P4 contract. This is recorded in §17.20, §03.4/§03.5 and §37.22. No checks run.


### Active managed-admission source delta (2026-10-19)

P8 now exposes an admission-only `DurableManagedLeaseProofV1` purpose tagged `PreAdmissionReserved`, built from exact immutable pins and current RESERVED OwnerLog proof with no attached binding/process authority. The separate post-append resolver requires purpose `AttachedAttempt`. P8 also added the durable registered-clean-worktree resolver and one-ActiveWorkers capacity projection bounded by pool `max_live_workers` and Spec `max_workers`; base locator remains distinct from measured workspace digest.

P1's HostKernel `managed_admit` source now follows authenticated profile/context/current Task checks → root peer proof → P8 worktree/reserve → P2 atomic Attempt+DelegationBinding → P8 binding attachment → post-append attached proof. This is CODE_PRESENT only. Parent identified a required exact admission-response replay before P1's current revision/READY checks; P2 is adding a delivery-keyed receipt lookup and P1 must revalidate current auth/workspace/P8 attachment before returning it. Managed `claim_dispatch` / `consume_dispatch` and Core TaskTool handoff remain open. No tests/builds/typechecks/audits/provider probes have run.


### 2026-10-19 — managed claim profile digest boundary (source only)

Core resolves the Task-pinned AgentProfileV2 definition from trusted Config and sends that exact
content with authenticated managed claim and consume requests. HostKernel recomputes the canonical
Rust definition and permission-ceiling BLAKE3 digests and compares them to the durable Task,
DelegationBinding and P8 pins before prompt dispatch; Core does not duplicate Rust's MessagePack
digest implementation. The contract is recorded in arch_V1 §§17.21 and 37.22. P1 owns HostKernel
validation and sampling route; P2 owns Core request parsing/calls and the reachable TaskTool prompt
path; P8 owns durable resource/worktree/worker state and authenticated Core resource measurement.
P1 has source for admission-receipt replay before stale revision checks and revalidates current
root/process/workspace/P8 attachment. Parent review asked P1 to compare permission-ceiling digest
to the durable P8 pin and remove a duplicate workspace-binding predicate. P1/P2/P8 remain active;
P3/P4/P5/P6/P7/P9 plus integrated acceptance/release remain open. No tests/builds/typechecks/
audits/probes/benchmarks have run by user direction. Preserve mixed Git state; no stage/commit/push.
C: last checked using /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.


### 2026-10-19 — managed dispatch adapter and recovery boundary (source only)

P1 now has HostKernel source for authenticated `managed.claim_dispatch` / `managed.consume_dispatch`, exact
admission-receipt replay before stale revision checks, profile definition/permission digest
revalidation against durable Task/DelegationBinding/P8 pins, and consume-receipt replay that
revalidates current authenticated owner, root/process identity, workspace and P8 binding. Handoff
numeric fields use canonical decimal strings across Core IPC. Parent review confirms admission
replay checks exact profile permission-scope digest and a single workspace-binding predicate.
P8 added authenticated Core-process sampling separately from worker-tree measurements and is
implementing an exact replay resolver for a claimed P8 lease after a lost claim response; claimed
work remains fenced if proof/process/cancellation/epoch facts are ambiguous. P1 owns the HostKernel
sampling route only where an existing architecture owner supports it; no new public endpoint is
assumed.

P2 added typed Core claim/consume adapters that resolve the exact trusted AgentProfileV2 and send
its definition for Rust digest validation. P2 has resumed whole-phase work: the production
scheduler-to-TaskTool caller and durable prompt-pending/restart state remain absent. Rust
ManagedControl/OwnerLog remains the canonical scheduler; Core may only execute Rust-selected
bounded ready Tasks inside the existing root Session/TaskTool path. Task selectors cannot come
from model/tool arguments. Exact consume must be persisted before provider dispatch; crash after
possible provider invocation becomes UNKNOWN with no automatic repeat. P2 continues the complete
reviewer, effect intent, live workspace revision, verifier evidence and Goal/TUI/recovery work.

P1/P2/P8 are active whole-phase owners. P3/P4/P5/P6/P7/P9, cross-phase acceptance and release
remain open. The implementation-before-validation hold continues: no tests, builds, typechecks,
audits, provider probes or benchmarks have run. Git remains mixed and untouched; no stage/commit/
push. C: last checked through /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.



### 2026-10-19 — Rust-selected managed Task and child Session boundary (source only)

P1 added a bounded authenticated `managed.next_schedulable_task` projection using canonical Rust
ManagedControl selection. It returns the exact candidate Attempt counters/profile pin and bounded Goal/
Spec/criterion context; Core does not select Task authority. P1 is separating `parentSessionID`
(Run SessionLink/root coordinator) from `sessionID` (durable Task child Session) through admission,
P8 pins and handoff. P2 has typed claim/consume Core adapters and resumed whole-phase work to
connect the Rust-selected candidate to existing TaskTool/promptManaged with a durable child Session
and prompt-pending record. Each Task gets a distinct child Session parented to the Run root; model
or tool arguments cannot choose Task/Attempt/session IDs. P8 is adding an exact durable WorkerClaim
receipt/resolver for lost claim responses; no process dispatch follows merely from replaying it.
These decisions are recorded in arch_V1 §§17.20–17.21 and 37.22. P1/P2/P8 remain active; P3/P4/P5/
P6/P7/P9, cross-phase acceptance and release remain open. User-directed implementation-only hold
continues: no tests/builds/typechecks/audits/provider probes/benchmarks. Git mixed and untouched; no
stage/commit/push. C: last checked via /mnt/c has 59 GB free. V1 remains PARTIAL / NOT RELEASED.


### Current release blocker — atomic root Session binding at explicit Run start

The active top-level Core Session ID is an approved `goal.start` selector. Core must verify the
durable Session against authenticated principal, project, workspace and Goal before forwarding;
Rust atomically pins the Run SessionLink in the start event and exact retry contract. HostKernel
must register the authenticated P8 root coordinator before admission/scheduling; without it,
execution remains unavailable. Start grants no Attempt/effect lease. P1/P2/P8 are implementing
their owned boundaries; remaining phases and integrated release work remain open. No validation
has run by user direction. V1 remains PARTIAL / NOT RELEASED.

Resource sampler correction: P8's sampler is Attempt-scoped telemetry/backpressure, not an
admission gate. ActiveWorkers capacity uses durable Rust accounting bounded by pool and accepted
Spec. Do not sample before admission or make unknown optional telemetry deny admission. No public
resource wire op before §12.16 ResourceSnapshot schema; diagnostics remains unavailable.

P8 source checkpoint: the worktree journal treats intent-only Pending operations as safely
resumable and durable `worktree_dispatch_started` operations as UNKNOWN/no-redispatch. Release
requires same-root clean pre-delete evidence, post-delete MISSING, and no dirty/user-owned changes;
legacy receipts without pre-release evidence cannot prove safe release. Whole-phase implementation
continues; no validation has run.

P8 identified raw worktree registration facts as an admission authority gap. It is replacing them
with an opaque registration derived from exact Guarded Create intent + settled receipt and
HostKernel-resolved canonical path/base locator; P1 must provide the typed result from its guarded
route. Admission requires fresh no-follow clean/owned/current evidence; historical unproven
registrations cannot authorize new admission. Source implementation ongoing.

P8's `VerifiedWorktreeRegistrationV1` now requires the exact durable completed Create and fresh
Inspect receipts, binds task owner/root generation/worktree/base/content revisions and canonical
path, and rechecks owned no-follow CLEAN status with zero dirty entries/no user changes. Legacy
registration events do not count as verified admission inputs. P1 HostKernel lifecycle wiring
remains open. Source only; no validation run.

Start remains blocked on the Core-owned SessionLink projection: HostKernel has authenticated peer
process facts but no SessionStore/projector, so it cannot invent a durable cursor, source instance
or digest from `sessionID`. P2 must resolve those facts and prove authenticated principal and
Goal/project/workspace binding; P1 validates the projection and stamps the current owner epoch.
No post-start AttachSessionLink fallback. This is implementation work, not verified acceptance.

SessionLink cursor remains a source integration blocker: Core EventV2's `latestCursor` is SHA-256,
but Rust requires the exact BLAKE3 digest from `hc_session_receipts`. P2 must use the existing Rust
SessionSupervisor projection; synthetic rehashing is forbidden and unresolved cursor keeps start
unavailable.

P1 confirmed pre-admission sampling cannot see sibling Run workers; telemetry remains monitoring/
backpressure only. Unsupported required OS-enforced profile limits stay unavailable.

P8 is adding a durable tombstone for safely deleted worktrees so they cannot remain marked Free
and be reused. Tombstoning requires clean pre-delete and MISSING post-delete proof; IDs remain
historical/non-reusable. P1 admission must accept only current verified registrations and fail
closed on ambiguous replay/removal.

P1 confirmed HostKernel still lacks the Guarded worktree Create/Inspect/Release route, journal and
driver; Core direct create/remove remains disabled. P1 owns Guarded no-follow operation/receipts,
P8 owns durable registration provenance/tombstones. Managed admission remains unavailable until
both are wired.

P2 now persists protected authenticated ServerAuth ownership metadata on Session creation, rejects
cross-principal goal.start, protects owner/root markers from HTTP metadata mutation, and adds
sessionID to the response/SDK contract. Provisional Core store/instance/epoch guesses are not
valid SessionLink facts; exact Rust SessionSupervisor BLAKE3 cursor/source projection remains
required. Source only; no checks.


### Source correction — SessionLink and goal.start

`SessionSupervisor.sessionProjectionCursor(sessionID)` already returns the durable Rust projection
ACK checkpoint and exact BLAKE3 cursor; cursor acquisition is implemented. Remaining identity
fields are being wired from durable Core ownership: immutable database sourceStoreID, immutable
project-directory sourceInstanceID, and per-Session sourceEpoch (starts at 1 and changes only on
explicit lineage reset/replacement, not process restart). No path/time/process-epoch synthesis is
allowed. User confirmed explicit authenticated `goal.start` after accepted SpecVersion; it
atomically pins SessionLink and grants no Attempt/effect authority. P2 owns Core identities/start
projection, P1 owns HostKernel validation/pinning. Managed worktree acquire/inspect/release uses a
private authenticated control request and existing Guard/EffectIntent/lease/receipt/confined
ExecutionHost. Source only; no checks run.

P8/P1 lifecycle integration contract: opaque P8 `WorktreeLifecycleOperationPinV1` owns the stable
operation key, root lineage, fixed worktree identity/path and current intent cursor/epoch. It does
not authorize execution. P1 validates fresh root proof, runs canonical Guard action and confined
ExecutionHost with a one-use lease/receipt; P8 marks possible dispatch before invocation. Release
requires clean pre-delete, post-delete MISSING and no active lease, then a permanent tombstone.
Possible-dispatch recovery is UNKNOWN/no-redispatch. No checks run.

SessionLink sourceDigest algorithm is now specified in §12.3/§17.22: domain-separated SHA-256 over
ordered bounded identity/cursor/generation/redaction/protocol/Goal/project/workspace fields, each
UTF-8 field length-prefixed by u64 big-endian; null observed message/part refs encode empty and no
transcript content is included. Source only.

### Live implementation ledger — 2026-10-19 22:06 UTC

| Phase | Live owner/state | Remaining implementation and evidence |
|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | Complete confinement, enabled-origin mediation/disablement, direct and managed Attempt/ToolBatch lease and receipt recovery, shell interpolation denial-before-spawn, and guarded worktree route. SessionLink validation/atomic start are source-present. Add the global trusted Core Config `git_executable` selector and private supervisor projection; no PATH or caller-selected executable. |
| P2 managed vertical | Active whole-phase owner | Finish accepted-SpecVersion→PLANNED Run→authenticated `goal.start`, authenticated P8 root registration, production Rust-selected scheduler→TaskTool child prompt path, distinct authenticated reviewer, current workspace revision, independent verifier/evidence and pause/cancel/restart/UNKNOWN/stale/conflict recovery. |
| P3 RepoIntel | Queued | Finish authenticated source/parser and bounded navigation, stale-write refusal and recovery; preserve truthful unavailable state where no approved parser/buffer source exists. |
| P4 LSP/DAP/REPL | Queued | Finish supervised lifecycles, mediated LSP/DAP/REPL operations, Guard/confinement and real-project Linux journeys; keep effects unavailable until dependencies pass. |
| P5 web search | Queued | Finish built-in default plus explicitly enabled ordered provider cascade, per-route auth/cost/status provenance, bounded retries/failures, Settings consent and Guarded outbound transport. |
| P6 providers/settings/Doctor/S1 | Queued | Finish provider/auth/cost/capability truth, requested/effective settings and FEAT-001..014, offline and separately consented live Doctor, free-model journey after implementation, S1 projection and provider/model switching. |
| P7 stream/artifacts/analytics/automation/rewind | Active whole-phase owner | Source now includes bounded activity replay/resnapshot, byte/node redaction, artifact FULL/SAMPLE/FAILED reporting, analytics provenance, Rust automation/checkpoint journals, and a new async SVG generation fence. Remaining implementation depends on P1 HostKernel guarded automation mutation/invocation and checkpoint same-revision filesystem+VCS observation/effect receipts; keep invocation/capture/restore unavailable. Real TUI reconnect, focus/scroll, load, recovery and integrated acceptance remain unverified. |
| P8 resources/workers/worktrees/RC0 | Active whole-phase owner | Finish reservation/process attribution and lifecycle restart/idempotency review. Source has durable registration/removal receipts, replay, read-only pending intent and post-Guard/approval/lease possible-dispatch fence; fixture source added. Unsupported OS resource guarantees remain unavailable. |
| P9 and release | Queued | Finish Linux/WSL packaging/install and release readiness. After implementation closes, run final HorizonCode typecheck, overlay/source visibility audit, integrated security/recovery journeys and full release gate; publish only exact verified task-owned paths if ownership is clear. |

User confirmed explicit authenticated `goal.start` after accepted SpecVersion and complete persisted PLANNED Run; SessionLink is pinned atomically and start creates no Attempt/effect authority. Actual active child owners are P1/P2/P8 (all three available slots occupied). P2's production managed scheduler→TaskTool call path remains unimplemented. No tests/builds/typechecks/audits/provider probes/benchmarks ran in this continuation, per instruction. Git remains mixed and untouched (12 ahead, staged/unstaged/untracked); one primary worktree; C: has 59 GB via `/mnt/c`. **V1: PARTIAL / NOT RELEASED.**

### Managed-start / worktree security correction — 2026-10-19 22:09 UTC

Keep optional Git configuration out of `goal.start`: P2 must complete authenticated root registration after the SessionLink-pinned start and register the trusted Git profile only before managed worktree acquisition. No Git profile means no worktree effect/admission, while explicit effect-free Run start remains valid.

P1 keeps `.git` read-only; only a typed broker worktree operation may receive an OS-enforced `.git/worktrees` write exception with canonical no-follow roots and fixed `--no-checkout` argv. Unsupported nested enforcement keeps operations unavailable. P8 is resolving the first Create→Inspect target from the exact settled Create receipt under the current root owner/epoch; no request path or ID may select it. No validation run.

P2 source correction: `goal.start` no longer registers the optional Git profile. It pins SessionLink and registers the authenticated root coordinator; a separate trusted Core Config adapter registers Git before worktree acquisition. P8 added exact Create receipt→Inspect target resolution, rejecting stale roots, incomplete/unclean evidence and any prior/tombstoned registration. Gitfile Locations require trusted canonical common-gitdir resolution and a separately confined metadata root; unsupported cases stay unavailable. No checks run.

P8 recovery addition: stale-epoch intent-only Pending worktree operations receive a durable `NotAdmittedNoDispatch/EXPIRED` tombstone only after fresh same-lineage root proof and confirmation that the possible-dispatch marker and receipt are absent. Exact retry returns that immutable receipt; a later call uses a new operation key and fresh Guard/approval. No worktree mutation or dispatch authority is granted by retirement. P8 owns the event/receipt; P1 owns the pre-execution marker contract. No tests run.

P2 source tightened exact root-registration receipt and local root-binding retry validation with OwnerLog cursor/digest, pool revision, accepted SpecVersion and SessionLink digest. No validation yet.

P2 parent review blocker: retrying `goal.start` must replay Rust's exact pinned SessionLink. Current Core recomputes the moving cursor; Rust snapshot emits `Run.sessionLink`, but TypeScript discards it. P2 is to expose/use the Rust value for already-started Run recovery, and compute fresh only for PLANNED starts. No checks run.

P1 first-create resolution: only after Guard/approval/lease and P8's durable possible-dispatch marker may HostKernel create absent fixed `.git/worktrees` and `.horizon/worktrees` roots using canonical descriptor-relative no-follow/no-clobber operations. It then prepares the exact confined profile and invokes fixed Git argv via the existing supervisor. Definite no-spawn requires supervisor proof; any ambiguity is UNKNOWN/no retry. Unsupported nested-write enforcement remains unavailable.

P8 implemented exact stale-root Pending retirement with same-lineage authenticated proof, durable EXPIRED no-dispatch receipt, same-key replay and no operation revival. The event changes no worktree state. Source fixture and §21.12 update are present, unrun; P8 continues owner-epoch/sampler/reservation-process source work.

### 2026-10-19 22:15 UTC — pinned start replay and P8 retirement recovery (source only)

P2 now strictly decodes Rust's immutable Run SessionLink in GoalReviewSnapshot. Authenticated `goal.start` replay uses that exact pinned cursor/identity/owner epoch; a new Core Session projection is acquired only for a PLANNED Run. Parent source review caught an early snapshot dereference in `goalRunStart`; P2 moved snapshot loading before Run/accepted-Spec lookups. P1's HostKernel replay preserves the pinned owner epoch and does not re-enable root scheduling after epoch drift; root registration must be freshly authenticated.

P8 now also checks the retired-no-dispatch event's owner epoch against the replayed WorkerPool epoch. P8 still owns remaining reservation/process receipt, sampler attribution and recovery review. P1 still owns actual Guarded HostKernel worktree Create/Inspect/Release integration and confined ExecutionHost route; P8's durable Create→Inspect provenance, verified registration, clean/MISSING removal tombstone and no-dispatch retirement remain CODE_PRESENT only. P2 still lacks the reachable Rust-selected Task→TaskTool child Session/prompt caller and has remaining distinct authenticated reviewer, live workspace revision, verifier evidence and pause/cancel/restart/UNKNOWN/conflict paths.

Active whole-phase slots remain P1, P2 and P8; P3/P4/P5/P6/P7/P9 and integrated final acceptance/release remain open. User-directed implementation-first hold remains: no tests/builds/typechecks/audits/provider probes/benchmarks. Mixed Git state preserved without stage/commit/push. C: last checked through `/mnt/c`: 59 GB free. V1 PARTIAL / NOT RELEASED.

P8 source follow-up (22:16 UTC): worker resource sampling now accepts fresh authenticated Core peer facts and derives PID/start/incarnation within the sampling call, preventing stale same-epoch identity-token reuse. This is telemetry/backpressure only and cannot authorize admission or establish OS-enforced limits. No production route is wired; any future P1 sampling route must fetch fresh peer facts for each call.

### 2026-10-19 22:19 UTC — durable settlement proof contract

Parent source review found P8's journal had replayable SettleWorker/ReconcileRelease commands but lacked durable producer methods; current inputs are plain flag-shaped structs. Parent ruled production producers require opaque crate-private P1 HostKernel proof values bound to exact P8 cursor/revision/state, managed Attempt/DelegationBinding, P8 claim nonce, P1 process generation/owner epoch and exact P2 terminal/effect evidence. P8 rechecks its records and derives the existing transition fields before OwnerLog append. Lost-response replay is receipt-first and exact; stale/mismatched/UNKNOWN evidence remains quarantined with capacity retained. This contract is documented in §17.24; P1/P8 implementation pending. No tests/builds/typechecks/audits/probes/benchmarks run.

### 2026-10-19 22:19 UTC — logical managed worker settlement correction

P1/P8 confirmed the §17.20 V1 boundary: WorkerExecution is a logical child Core Session/Attempt in shared Core, not a separately spawned worker process. The earlier proposed exact worker-PID exit proof is therefore removed for V1. §17.24 now requires opaque P1/P8 proof of authenticated root/Core peer identity, exact P8 cursor/revision/claim/Attempt/DelegationBinding, P2 terminal Attempt and complete effect receipts, and quiescent prompt/callback scope with no active Attempt leases or owned command processes. Guarded final workspace facts decide worktree reuse; UNKNOWN or ambiguity retains/quarantines capacity. A future process-backed execution kind requires its own exact exit proof. No tests/builds run.

### 2026-10-19 22:19 UTC — P1 guarded profile and settlement source updates

P1 now requires ServerAuth plus authenticated live Core peer identity to register the global Git profile, pins the canonical executable digest, and rechecks canonical path/content immediately before Stdio spawn. EffectHost allows only the three exact `git.worktree.*` broker capabilities for UserAction, not verifier mode. Managed lease expiry uses the minimum trusted profile/Spec/remaining-Run/24-hour bounds. Start replay preserves the exact pinned SessionLink owner epoch. P1-owned §14.20 records no-follow first-use roots. Actual HostKernel worktree lifecycle route/driver and P1↔P8 settlement producer remain absent.

P2 is adding a canonical crate-private Rust terminal Attempt/effect-chain projection for settlement. HostKernel must combine it with current authenticated Core peer, prompt/callback quiescence, no active Attempt Guard leases or owned command processes, plus guarded workspace facts before P8 capacity release. V1 managed WorkerExecution is a logical Core child Session with no child process exit. The production Rust-selected scheduler→TaskTool caller is still absent. No validation run.

2026-10-19 22:20 UTC — §17.24 now defines the managed prompt quiescence event. P2 calls private authenticated HostKernel completion only after managed `promptManaged` returns and its outcome is durably recorded. P1 validates exact consumed handoff/child Session/Attempt and current Core peer, verifies no Attempt callback/Guard lease/owned command remains, then mints one-use proof; P2 appends `managed_dispatch_quiesced` to the ManagedControl OwnerLog and exposes its exact cursor/digest in the terminal snapshot. Retries never repeat prompt dispatch; missing event after possible provider invocation stays UNKNOWN and holds P8 capacity. P1/P2 implementation pending; no checks run.


### 2026-10-19 22:24 UTC — current source status

- **P1/P2/P8:** active whole-phase owners. P1's source quiescence digest is bound to P2 terminal/effect evidence and current Core peer; P2's terminal snapshot exposes durable `managed_dispatch_quiesced` cursor and distinct workspace revision domains; P8 still needs opaque logical-child settlement, receipt replay and worktree/reservation lifecycle integration. These are source changes only; managed effects remain unavailable until integrated acceptance.
- **P5:** parent fixed the cascade classifier so 408/425 receive the single bounded transient retry; auth 401/403/407 fall through only across explicit enabled routes, 429 cools down/falls through without retry, and other client errors stop. Guarded transport/SecretBroker production composition is still absent; keep the model-visible tool unavailable.
- **Still open:** P3/P4/P5/P6/P7/P9 completion, P1/P2/P8 acceptance, integrated journeys/security/recovery, final HorizonCode typecheck and release gate. User implementation-first hold remains; no validation commands have been run. Git remains mixed and untouched; C: last checked via `/mnt/c` has 59 GB available. **V1 PARTIAL / NOT RELEASED.**


### 2026-10-19 22:30 UTC — P5 no-key provider chain expansion and source correction

Parent continued independent P5 work while whole-phase P1/P2/P8 owners remain active. Research against current provider primary pages found anonymous/no-key search support for Exa MCP, You.com `profile=free` (100 queries/day), Tavily MCP's explicit keyless search mode, Firecrawl Keyless (per-IP daily cap), and Parallel Search MCP (anonymous lower-rate mode). TinyFish Search is free but its documented API path requires account/API-key or OAuth, so it is not classified as part of the anonymous no-key default. Updated §37.5 and §16.7 accordingly and added source links/recheck caveat to §42.

Source-only P5 changes: Core config now recognizes `tavily_keyless` and `parallel_keyless`; the cascade's enabled default/order and route cap now include the five anonymous no-key routes; adapters expose those fixed endpoints/tools (including Tavily's fixed keyless headers); the TUI settings list represents both routes and keeps network dispatch unavailable pending Guard. The route parser now accepts common provider snippet fields, and tool-display labels cover both additions. Parent also fixed transient 408/425 classification earlier. P5 remains partial: no production Guarded transport/SecretBroker composition, native grounded-model route, broader BYO adapters/credential controls, route-event/provenance integration, or acceptance evidence is complete. Search remains fail-closed. No tests/builds/typechecks/audits/provider probes/performance runs were executed; Crawl4AI's browser binary was unavailable and Context7 quota was exhausted, so official primary-page web search/open was used as a fallback.

### 2026-10-20 04:40 UTC — current phase-owner ledger (source only)

| Phase | Owner | Current implementation focus | Gate/state |
|---|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | Wire typed launch profiles and guarded worktree/process effects through the existing HostKernel and single confined supervisor; close enabled-origin bypasses. | IN PROGRESS; no validation run |
| P2 managed vertical | Active whole-phase owner | Production Rust-selected scheduler → TaskTool → distinct Core child Session/prompt path; retain AgentProfileV2 revision/digest/scope authority, verifier and current workspace evidence. | IN PROGRESS; no validation run |
| P8 resources/workers/worktrees/RC0 | Active whole-phase owner | Finish durable logical-child settlement, reservation/resource lifecycle and guarded worktree integration/recovery; compare OpenCode, OMP and `repos/codex`. | IN PROGRESS; no validation run |
| P3/P4/P5/P6/P7/P9 | Queued whole-phase owners | Start each as a child slot frees; P5 includes the legacy Core direct-search origin, cascade provenance/settings and Guard/SecretBroker composition. | NOT STARTED this continuation |

User reaffirmed authenticated explicit `goal.start` only after accepted SpecVersion; it pins the root SessionLink and grants no Attempt/effect authority. V1 child profile authority is versioned Core Config `AgentProfileV2`; direct and managed children use the lane-tagged `SubagentDeliveryV1`. Unsupported CPU/memory/disk/FD hard limits remain unavailable absent OS enforcement. P5 web search remains disabled until its complete Guarded transport and credential boundary is wired. Implementation-first hold remains: do not run tests/builds/typechecks/audits/provider probes/performance until source implementation closes. Mixed Git state remains preserved (12 commits ahead; staged/unstaged/untracked changes); no staging, commit, push or cleanup. C: 59 GB free via `/mnt/c`; one primary worktree. Overall V1 PARTIAL / NOT RELEASED.

### 2026-10-20 04:41 UTC — managed Task input and lifecycle audit

P2's planned Task projection currently lacks immutable `title`/`purpose`. Parent decision: add both bounded fields to the accepted/persisted Task projection per §29.18; bind them to Task/plan revision and treat them strictly as descriptive prompt input, never authority. P2 owns reducer/Core projection and architecture; P1 owns HostKernel projection. Core child completion must produce exact durable Session cursor/state digest aligned with HostKernel before terminal/quiescence can be trusted. P8's current source audit reports durable lifecycle pieces exist; remaining integration is HostKernel ingress and the P2 child journey. Reference adaptations: Codex child-config snapshot, capacity, messaging/wait/resume/lineage; OpenCode persisted subagent Job recovery; OMP bounded workpool. No upstream restart/retry behavior supersedes Horizon UNKNOWN no-replay.

### 2026-10-20 04:42 UTC — P8 source status; P5 owner allocation

P8 completed a source audit and found no P8-owned implementation mismatch: durable reservations, opaque logical-child settlement and reconciliation, guarded worktree receipts/recovery, bounded sampling, UNKNOWN denial and provisional-only RC0 reporting are present. P8 remains PARTIAL/NOT VERIFIED pending P1 HostKernel lifecycle/sampler/final-inspect ingress, P2 real managed child/verification, and integrated authenticated RC0 plus 1/5/10/20 captures. It is queued for dependency integration rather than marked complete. A whole-phase P5 owner now occupies the released slot; current active owners are P1/P2/P5. The user's source-first hold remains in force.

### 2026-10-20 04:44 UTC — P1/P2 integration invariants

- **Prompt return is nonterminal:** while Task=PENDING_VERIFICATION and coding Attempt=EXECUTING, append a durable `managed_dispatch_quiesced` marker only after exact child prompt/callback return and durable Core outcome. Do not use the terminal SETTLING snapshot here. Later terminal proof requires independent verifier evidence for the actual current workspace revision and all effects settled before P8 release.
- **Worktree lifecycle is root-scoped:** no synthetic UserAction and no fake Attempt. P1 must bind private lifecycle authorization to authenticated root Goal/Run/Session/principal/Location/workspace plus the exact P8 operation pin, and use canonical Guard, managed approval, one-use lease, confined supervisor and receipt. Only exact acquire/list/release actions are admitted. Unsupported approval representation remains unavailable.

No source checks run. Implementation-first hold remains active.

### 2026-10-20 04:45 UTC — publication state

Git MCP observed `main` at `14830654c8e6f68b6450707b17b17b29d59fc649`, 13 ahead of `origin/main`; this commit reports 469 changed paths. Parent did not create or push it. The worktree still contains shared task/user changes; no exact-scope publication or release has occurred. Keep V1 PARTIAL / NOT RELEASED until implementation and final-revision verification complete.

### 2026-10-20 04:50 UTC — P1/P2/P5 source coordination

The fixed search identity is now explicit: configured route key is `provider_id`; `route_id=web.search.<provider-key>` (keyless and BYO variants remain separate). Core passes only selected configured route plus bounded query/limit. P5 owns its bounded registry import/registration change only; P2 excludes that file. The local inspect projection is read-only and cannot claim live route health. Search dispatch stays unavailable pending P1 Guard/lease/receipt and P6 SecretBroker integration. P1/P2/P5 are the only active whole-phase owners; P8 awaits integration slot. Source implementation is in progress; no verification has been run in this continuation.

### 2026-10-20 04:54 UTC — direct versus managed permission authority

§§12.11, 29.2/29.20 were rechecked against live P1/P2 source. The direct child lane binds Core's effective permission-scope digest after profile/parent intersection; managed child authority binds the Rust DelegationBindingV1 digest and exact lineage. The existing managed HostKernel `permissionScopeDigest` denotes the AgentProfile permission ceiling and must not be reused as the actual Core runtime permission digest. P1/P2 have the correction; dispatch remains fail-closed pending interface reconciliation. No validation run.

2026-10-20 05:00 UTC — P5 source review found the HostKernel fixed-route allowlist incomplete for approved routes: no keyless MCP routes or Brave GET. P1/P5 are coordinating safe fixed transport support and honest availability. All search effects remain gated; no route coverage is accepted from adapter source alone.

2026-10-20 05:04 UTC — P5 found a dormant exported direct HTTP search helper in `mcp-websearch.ts`; source dispatch is being removed and P1 adds it to bypass review. Parent exposed the new inspect source in Git with narrow root ignore exceptions; it is visible as untracked and unstaged. Final overlay audit remains outstanding.

2026-10-20 05:10 UTC — P1/P2 agreed one stable managed Session ID mapping: `ses_managed_${candidateAttemptID}`, derived only inside Core from Rust READY_TASK (`attempt_...` today) and recomputed/validated by HostKernel. No caller-selected IDs. P1/P2 are implementing and documenting; no tests.

2026-10-20 05:12 UTC — The approved default web-search chain cannot be declared complete with the current POST-only Rust supervisor: five keyless routes use remote MCP lifecycle and Brave uses GET. P1 must extend the existing Guarded ExecutionHost transport with fixed bounded support and normal lease/receipt/recovery. No provider route is runnable until integrated; no probes/tests.

2026-10-20 05:16 UTC — P2 is repairing two cross-phase recovery issues found in source review: random quiescence delivery IDs prevent exact replay; returned provider/tool failures currently skip durable quiescence. Use stable receipt-derived identity and persist definite returned failures as nonterminal, non-PASS outcomes; keep uncertain in-flight dispatch UNKNOWN.

2026-10-20 05:20 UTC — P1 added fixed MCP transport source for the five approved keyless routes within the shared HTTP supervisor. Guard admission/lease/durable aggregate receipt/recovery integration remains absent; no search route is enabled or verified.

2026-10-20 05:23 UTC — P2's coordinator source now represents the managed Task delivery path but appears unreferenced outside its internal prompt helper; it needs a real accepted-Run/control caller. Parent exposed the new first-party file under the overlay ignore rules; source-only.

2026-10-20 05:26 UTC — Remaining source work is concrete: P2 must continue from prompt-return/quiescence through real revision evidence, independent authenticated verification and terminal settlement; P5 must finish `websearch-adapters.ts` and keep its call path disabled until P1/P6 gates exist.

2026-10-20 05:30 UTC — Fixed MCP, direct POST, and Brave GET request source now exists in the shared HTTP supervisor; Guarded HostKernel dispatch/receipt and SecretBroker integrations remain open and all web-search effects stay unavailable.

2026-10-20 05:32 UTC — P5 adapter/runtime source is in place behind a default-deny gate. P1/P5 are aligning per-route/retry effect lease semantics; all effects remain unavailable pending Guarded receipts and SecretBroker wiring.

Current continuation: P1's final search contract is one `execute_search_cascade` RPC after canonical ToolBatch admits/approves the exact full trusted route plan. This is one aggregate Guard effect/lease/intent/receipt consumed once; HostKernel records bounded per-route attempt/subreceipt provenance beneath it. Definite outcomes may fail over only within the approved route order; UNKNOWN stops. P5 is adapting the caller to the exact admitted plan. P2 wired accepted `goal.start` to the Rust-selected coordinator under the default-off flag and is completing final-revision evidence, distinct TUI reviewer flow, terminal Attempt verification, and P8 settlement. P1 registered the authenticated read-only active-attempt recovery projection, and P2 is wiring no-replay restart reconciliation. P8 source owner is active. No validation has been run, per source-first instruction.

P5's independent source work was handed off PARTIAL (route settings/defaults, bounded provenance/adapters, exact admitted-plan caller, direct HTTP bypass removal, docs/fixtures); resume the same phase owner after P1 aggregate Guard dispatch and P6 SecretBroker refs arrive. P8 whole-phase source owner is active on worker/resource/worktree/recovery integration; fan-out remains disabled pending accepted P1/P2. Active phase owners: P1, P2, P8. P3/P4/P6/P7/P9 remain queued due the three-child concurrency limit. C: free space via `/mnt/c` was 57 GB; no heavy processes. No tests/builds/typechecks/audits/benchmarks/provider probes have run; implementation only.

P8 audit corrected the prior status: authenticated Linux-only `resource.sample` is present in HostKernel and binds ServerAuth/live Core peer/managed Goal+Run+Attempt+Location and OwnerLog watermark. Product attestation remains `NOT_ATTESTED`; there is still no eligible raw 1/5/10/20 product baseline. P8 owner continues local source integration, without touching P1's shared HostKernel files.

2026-10-20 05:19 UTC — P2 source checkpoint: exact Rust-scoped unconsumed Attempt recovery uses stable claim/consume replay IDs; consumed or ambiguous prompt delivery is `PROMPT_UNKNOWN` and never replayed. P2 remains incomplete pending current final revision evidence, full independent verifier/settlement journey, and P1/P8 acceptance. P6 is now active whole-phase owner; active owners are P1/P6/P8. P5 resumes after guarded aggregate search dispatch and SecretBroker mapping land. RC0 remains NOT_ATTESTED until the typed authenticated P1/P2/P8 projection proves current revision, HostRun receipt, independent verifier evidence and exact Goal/Run/Session/Attempt/OwnerLog cursor. No tests, builds, typechecks, audits, benchmarks or live calls run. V1 PARTIAL / NOT RELEASED.

2026-10-20 05:20 UTC — P1/P8 aligned the final Inspect proof boundary with exclusive writes: P8 implements typed final-inspect/HostRun/evidence/current-revision settlement projection in worker durable files; P1 implements only authenticated HostKernel ingress/call sites. Missing or ambiguous Inspect proof remains quarantined; RC0 remains NOT_ATTESTED. Active owners P1/P6/P8. P2 remains incomplete and queued; P5 still depends on P1's cascade dispatcher and P6's SecretBroker mapping. C: 55 GB free via `/mnt/c`; no validation was run; HorizonCode V1 is PARTIAL / NOT RELEASED.

2026-10-20 05:21 UTC — P1 source gap: root-scoped worktree authorization is validated but not minted; no HostKernel operation creates the private root scope/challenge. P1 owns authenticated RootCoordinatorExecutionProof + P8 pin integration and full Guarded create/inspect/release lifecycle; it stays unavailable until all receipts/recovery are wired. No validation run.

2026-10-20 05:22 UTC — Launch-profile ownership: P1 owns HostKernel trusted selector, exact immutable profile DTO, Guard lease and single-supervisor dispatch; P4 owns Core Config resolution and LSP/DAP/REPL lifecycle adapter. This is the approved existing-Core-config→HostKernel projection. No caller executable path or duplicate supervisor; launches stay unavailable until both sides and confinement are complete.

2026-10-20 05:23 UTC — P2 remaining source gap: implement lane-tagged `SubagentDeliveryV1` at runtime. Direct binds Core lineage + AgentProfileV2 revision/digest + effective permission-scope digest; managed binds Rust DelegationBinding and exact lineage; authorityDigest is canonical, domain-separated and recomputed by the owner. This is required by §§12.11/29.2; P2 owns it when its slot resumes.

2026-10-20 — P6 source continuation: added a bounded SecretBroker metadata lookup and
Auth-owned fixed search Route → SecretRef projection. It returns opaque refs only for one
AVAILABLE credential per canonical BYO route; revoked/missing/ambiguous refs are omitted,
and broker errors produce an empty BYO map so keyless routes remain eligible. P1 must still
compose the projection into the guarded HostKernel search capability and own the pre-dispatch
lease/receipt boundary. Added catalog/full Provider Doctor route contracts with explicit
network/spend request fields; their source response remains zero-network, credentials unread,
and probe steps SKIPPED until P1's trusted grant/dispatcher exists. Corrected provider/model
picker language to distinguish configured access source and catalog hints from live endpoint
health. S1 source already has owner-scoped ask/reply/dismiss, TUI event projection, and
standalone-only ToolBatch admission with spoof/mixed-effect denial.

P6 remains PARTIAL / NOT VERIFIED: Guarded secure credential-entry/write UI and provider
dispatch, live Doctor probes, complete FEAT-001..014 integrated-revision acceptance, provider
switch journeys, and authorized free-model response/coding-task evidence remain open. No tests,
builds, typechecks, audits, probes, benchmarks or provider calls were run in this source wave.

2026-10-20 05:25 UTC — P1 added `execution.resolve_launch_profile` (authenticated ServerAuth, immutable profile definition, installation-owned selector map, returns profileRef/digest/status only). HostKernel dispatch remains unavailable until exact Guard challenge/lease, supervisor preflight/spawn and durable receipt/recovery are wired. P4's integration binds exact Session/Location/Attempt, profile definition/ref, capability, challenge and one-use lease; host re-resolves selector/digest and derives cwd/env.

2026-10-20 05:26 UTC — §§12.20/37 launch contract resolved: definition only on authenticated resolve RPC; HostKernel pins exact immutable result to PreparedEffect/Guard challenge; actual launch sends only profileRef and live owner scope/challenge/one-use lease. No paths/argv from caller; no independent mutable profile registry; durable receipt retains exact profile and executable digest.

2026-10-20 05:27 UTC — P8 added exact final-inspect settlement proof and typed durable receipt projection, including current revision, Inspect/Host receipt refs, verifier evidence/artifact refs and OwnerLog watermark; old settlement events retain v1 digest replay. Verified Task cannot settle without exact final Inspect; dirty/ambiguous worktree stays quarantined. P1 authenticated HostKernel ingress and P2 evidence are still missing; RC0 remains NOT_ATTESTED. No checks run.

2026-10-20 05:28 UTC — Disk check via `/mnt/c`: C: 49 GB free, 90% used; primary `kernel/target` 520 MB. Separate Windows PowerShell/Cargo validation belongs to another project; left untouched, no cleanup. No HorizonCode builds/tests running.

### 2026-10-20 05:30 UTC implementation checkpoint
- P6: V2 S1 question handlers now have a bounded ownership plan: authenticated principal from middleware must match Core-owned Session ownership/ancestor chain. P6 owns list/reply/reject handlers; P7 owns principal-filtering the shared event stream for `question.v2.*`.
- P8: logical managed children do not have worker-specific PIDs. Do not synthesize per-worker process metrics in RC0. P8 resource/worktree ownership excludes provider token/cost billing; P2/provider provenance must enforce Spec budget accounting.
- P1/P6/P8 remain active; P2 and P5 are next queued phase owners. Source implementation only; all final verification and tests remain pending by user direction.

2026-10-20 05:32 UTC — P1 LSP/DAP launch profile source is now Guard-challenge/immutable-ref/single-supervisor wired. Parent source review identified and returned the `consume_lease` capability mismatch (hardcoded `terminal.run` instead of the pinned capability); must be fixed before any verification. Still implementation-only.

2026-10-20 05:34 UTC — P1 repaired the LSP/DAP Guard lease capability mismatch and reports no unsupported hard resource quotas. P1/P4 interface is now explicit: trusted definition only at authenticated resolve, then immutable `profileRef` through existing prepare/launch with exact lease and owner pins; no executable details in launch requests. Keep REPL disabled. Pending phase implementation and integrated verification.

2026-10-20 05:36 UTC — Git visibility repaired for P6's new principal-owner helper/fixture. P8 added reconciliation validation for the exact completed Inspect receipt and trusted registration lineage; P1 has the typed settlement API and must wire authenticated Guarded Inspect/projection. P2 must provide terminal verifier evidence and durable token/cost budget charging before fan-out. RC0 remains NOT_ATTESTED; final verification deferred.

2026-10-20 05:38 UTC — P5's phase-owner dispatch hit the platform thread limit, so parent is filling only the independent TypeScript/docs gap while preserving P1/P6 exclusive file ownership. P5 now retains per-route UNKNOWN status and bounded configured cost/auth provenance; the production search path remains disabled pending P1's durable aggregate dispatcher and P6's SecretBroker composition. No checks run.

2026-10-20 05:42 UTC — Cross-phase ordering ruling: keep the coding Attempt live through independent verification. Persist child quiescence, run verifier under a distinct Guarded intent within that Attempt, capture and verify current-head evidence, commit P2 typed verifier evidence, then perform final Guarded Inspect and P8 settlement from exact terminal/evidence and Inspect receipts. No P8 worker settlement before verifier, and no verifier requiring an already-settled Attempt. This matches §§12/17/37. No checks run.

2026-10-20 05:44 UTC — P5 now retains UNKNOWN distinctly, projects cost/auth provenance per fixed route, and records retry attempts sequentially; §37.5 and the operative plan are synchronized. P1 approval must visibly retain BYO UNKNOWN cost/auth consent without exposing refs. Still no verification.

2026-10-20 05:47 UTC — P6 will disable credentialed provider SDK paths that still inject raw Config/Auth/environment keys, until guarded one-request SecretBroker use and lifecycle proof exists. Public anonymous routes/catalog remain available; no silent fallback. Source only.

2026-10-20 05:49 UTC — P1 Guard approval now carries route cost/auth provenance with no secret refs; P5 displays HostKernel UNKNOWN as an unknown dispatch outcome rather than exhaustion. No tests run.

2026-10-20 05:52 UTC — P2 delivery schema visibility fixed. Canonical usage identity is assistant source message ID plus LLM step-finish index; provider/model and actual per-step usage provenance are bound in Rust. P2 owns durable usage/cost dedupe and budget stop. No validation run.

2026-10-20 05:54 UTC — Final Inspect now has a documented prepare → explicit approval → execute/receipt → settle sequence; no auto-approval. Verify/evidence first while Attempt remains live; inspect and settle only after evidence. Root P8 proof must be refreshed after each append. No checks run.
Continuation source checkpoint: P1/P2/P6 remain the active whole-phase owners; all actual child slots are occupied. P1 has a final-Inspect restart recovery dependency on a P8-owned accessor for the exact durable Guarded receipt. P2 is wiring lane-tagged child delivery and durable usage/budget enforcement with parent rulings recorded in `CURRENT_RUN.md` and `HANDOFF.md`. P6 has provided P5's fixed SecretBroker reference projection. Parent repaired the missing `WebSearchRuntime` namespace export. Search remains unavailable until P1 aggregate dispatch/recovery and P6 credential reference composition are production wired. No tests/builds/typechecks/audits/probes have run; Git remains mixed/unstaged; C: last measured 49 GB free via `/mnt/c`. Overall V1 PARTIAL / NOT RELEASED.

Settlement ordering correction: §§12.19, 17.24 and 37.22 now separate a verified SETTLING candidate used to pin final Guarded Inspect from the terminal Attempt snapshot emitted after the exact Inspect receipt. P8 worker settlement consumes the terminal snapshot plus Inspect receipt. This removes the Attempt-terminal/Inspect prerequisite cycle; P1/P2 were notified. P8 still needs a durable completed-Inspect receipt accessor for restart recovery. No checks run.

2026-10-20 06:02 UTC — The user reconfirmed HLD/LLDs are finalized; implementation must adapt existing OpenCode/Codex patterns, not create a new design. Read the supplied attachment and directly inspected both local source trees. §29 already covers the applicable lifecycle concepts and stronger HorizonCode authorities. P1/P2/P6 agents terminated at usage limits. Active phase owners are P4/P7/P8; P8 source now uses P2's typed SETTLING candidate to pin final Inspect and provides exact durable receipt recovery, so remove the stale statement above that this accessor remains absent. P1 HostKernel final Inspect and web-search dispatcher, P2 Core orchestration/accounting, P6 remaining integration, P3/P5/P9, and final verification/release remain open. Implementation-only hold; no checks. Git remains mixed/unstaged; C: 48 GB via `/mnt/c`; V1 PARTIAL / NOT RELEASED.

2026-10-20 06:08 UTC — P4 released its implementation slot PARTIAL after adding the strict Core→HostKernel launch-profile adapter and explicit-global-LSP projection (`packages/opencode/src/lsp/launch-profile.ts`; §37.6/plan updated). P4 runtime work remains blocked on P1 dispatch/confinement, trusted DAP profile projection, and enforced REPL quotas. Active owners: P1 Guard/HostKernel, P7 stream/artifacts/automation/rewind, P8 worker/resource/recovery. P1 owns HostKernel; P7 owns `kernel/src/automation.rs` and `kernel/src/checkpoint.rs`; P8 owns `kernel/src/worker_durable.rs`. P8 requires canonical final-Inspect key `managed-final-inspect-{attemptID}` across prepare/recovery/settlement; P1 confirmed adoption. Exact overlay exceptions added for P4's adapter and P7's event handler. No tests/builds/typechecks/audits/probes. Git mixed/unstaged; C: 47 GB free via `/mnt/c`, `kernel/target` 520 MB. V1 PARTIAL / NOT RELEASED.
Current implementation ledger: P4 and P7 have released their available slots after independent source passes, both PARTIAL pending HostKernel/config integration. P4 added launch-profile decoding/projection; P7 added `AutomationRegistryV1`, authenticated event filtering, and cursor-gap resnapshot enforcement. Active owners are P1 Guard/HostKernel, P2 managed vertical, and P8 worker/resource/recovery. Newly confirmed P2/P1 dependency: P8 pins a worker worktree, but current Core Task Session/effects still use Goal Location/root; the lease path is not projected into child Session or EffectAttemptScope. P2 owns Core binding; P1 owns HostKernel enforcement/dispatch. P8's terminal receipt resolver now covers post-settlement recovery, and its Inspect intent is being strengthened to preserve candidate/evidence identity. Canonical final Inspect idempotency key: `managed-final-inspect-{attemptID}`. Overlay exceptions added for P4/P7 source. Implementation-first hold: no tests/builds/typechecks/audits/probes. Git mixed/unstaged; C: 45–47 GB free via `/mnt/c`; `kernel/target` 520 MB. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 — implementation continuation checkpoint

- **Design:** HorizonCode HLD/LLDs and contracts are finalized. Work is implementation/adaptation of existing OpenCode-derived runtime paths under the approved Rust Guard/HostKernel authority; no new architecture design is being introduced.
- **P1/P2/P8 active:** Managed Task child workspace mismatch is the current integration seam. P8 leases a worktree, while Core currently resolves the Goal root for child Session/effects. P2 requires a read-only HostKernel projection derived only from live P8 reservation/registration/current observation: worktree ID, base and pool revisions, registered Location/workspace ref, and current measured workspace revision. Core uses that exact ref; caller paths do not enter the contract. P1 owns HostKernel projection/enforcement, P2 owns Core child Session/effect binding, P8 owns durable worktree/Inspect journal.
- **P8:** Final Inspect candidate association is now durably pinned to operation ID, canonical full SETTLING candidate digest and exact Attempt/binding/SpecVersion/evidence/final revision fields. Restart requires the pin; legacy unpinned records fail closed. P1 uses the P8 `managed_final_inspect_root` and terminal receipt resolver.
- **Verification:** none run under the implementation-first hold. Git state remains mixed/unstaged. C: 45 GB free via `/mnt/c`; `kernel/target` 520 MB. V1 PARTIAL / NOT RELEASED.

Current P1/P2/P8 integration detail: the `ManagedWorktreeTargetV1` DTO is settled. It must be resolvable before child prompt dispatch from authenticated root proof + live RESERVED/attached P8 reservation + verified registered worktree, then refreshed from HostKernel observation for handoff/consume/recovery. P8 is implementing this timing-correct read-only resolver; a claimed-worker/SETTLING-only resolver cannot populate admission. No caller path enters the DTO. No checks run.

P2 source delta: TaskTool now constructs the managed lane `SubagentDeliveryV1` and Core decodes/compares the exact `ManagedWorktreeTargetV1` across handoff and consume receipts. P2 is carrying the same workspace reference through `session/llm.ts`/`session/prompt.ts` to effect scopes. P1 HostKernel/Rust and P8 durable resolver integrations are still in progress; no verification has run and effects remain gated.

P8 implementation delta: `resolve_managed_worktree_target_for_attempt` now resolves attached RESERVED/CLAIMED worktree targets from authenticated root proof, P8 pins, attached DelegationBinding and verified registration/Create provenance. P1 derives/registers the child Location and current observation; P2 consumes it. Final Inspect remains bound to the distinct SETTLING candidate. Source only, unverified.

Managed worktree sequencing: P1 caught and is correcting a cycle where admission needs child workspace facts before the P8 attached-binding resolver can run. The normative order is already explicit in §37.22: HostKernel pins → P8 reserves and returns opaque `ReservedWorkerLeaseProofV1` → P1 resolves the verified registered worktree/current child Location/revision from that proof plus authenticated root pins → P1 appends Attempt/DelegationBinding → P8 attaches. Parent Root SessionLink/Location remains distinct. P1/P8 implementing; unverified.

P8 has implemented the pre-admission resolver `resolve_reserved_managed_worktree_target(root_proof, now_ms, pins, reservation)`, validating exact ReadyTask pins and opaque reserved proof plus RESERVED/no-dispatch state and verified worktree Create provenance before returning child target facts. P1 uses this before Attempt append; attached resolver remains for lifecycle refresh/recovery. Source only, unverified.

Cross-phase correction: target projection alone is insufficient. P1/P2 are binding the child worktree Location and independently measured child workspace revision into the managed Attempt/DelegationBinding/effect scope; the root SessionLink/Location and parent workspace provenance stay separate. P8 must keep these revision domains distinct during reservation/attach/settlement and must not assume equality. No checks run.

P8 phase checkpoint: owner returned PARTIAL after independent source implementation. Completed this wave: RC0 schema-v2 Attempt-bound sample projection (still NOT_ATTESTED), exact reserved-worktree target resolution, and durable candidate-bound final Inspect recovery. Remaining source integration depends on P1's authenticated child Location/revision projection; P8 must persist/replay child revision separately from parent root and worktree base. Resume the same owner at that seam. No checks.

2026-10-20 — P6 implementation delta: Provider Doctor now receives a secret-free provider-config projection only when instance config is already cached; the route never initializes config loading or fetches remote well-known config. The projection includes provider/model identifiers and allow/deny lists only. Missing cached config remains UNKNOWN. Source only; tests/builds/typechecks are deferred until implementation finishes. P6 remains NOT VERIFIED.

2026-10-20 — Active integration handoff: P1 is implementing the already-approved §37.22 final Inspect execute hop with P8's existing possible-dispatch/receipt APIs; P8 resumed to persist/replay the typed child-workspace projection; P2 owns the session finish reducer and usage projection for durable pre-dispatch budget accounting. Root, child and worktree-base revision domains remain distinct. No tests/builds/typechecks run; V1 remains PARTIAL / NOT RELEASED.

2026-10-20 update: P1 now passes `ManagedWorktreeAdmissionProjectionV1` into P8 attach, enabling P8 to persist and replay the child Location and measured revision. The HostKernel `managed.execute_final_inspect` execution route is still absent in source and remains open under P1.

2026-10-20 implementation progress: HostKernel final Inspect execute route, P8 durable child-workspace admission pins/replay, and P2 per-step usage accounting are now source-present. Parent source review returned confinement, receipt-error handling and pre-persist revision validation to P1. Final Inspect remains unavailable/unverified until those are corrected and integrated. Managed usage is also unverified; no tests/builds/typechecks were run.

### Managed budget authority (2026-10-20)
Decision: use existing schema. The effective token ceiling is `min(SpecVersion.maxTokens, AgentProfileV2.limits.tokenBudget)`; the monetary cost ceiling is `SpecVersion.maxCostMicros` only. No profile cost field is added. P2 implementation and final integrated verification remain required.

### 2026-10-20 phase handoff
P8's independent source pass is PARTIAL, not accepted: child worktree revision pins/replay, final-Inspect recovery, and authenticated Core aggregate resource attribution are present; RC0 is still NOT_ATTESTED and integrated P1/P2 acceptance remains. Whole-phase owners active: P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifacts/automation/rewind. P3/P4/P5/P6/P8 integration/P9 and final release remain. User-directed implementation-first hold: no verification commands until implementation is complete.

### P7 implementation dependencies (2026-10-20)
P7 has source for TUI event cursor/reconnect, bounded artifact fidelity/storage/rendering, OwnerLog automation registry/journal, and checkpoint preview/receipt structures. It remains PARTIAL. P1 HostKernel still needs automation registry routes and guarded checkpoint capture/preview/restore with same-boundary trusted workspace/VCS facts, durable dispatch receipts and recovery. Restore preview and SessionRevert remain unavailable; `run_now` remains unavailable until Guarded invocation is accepted. No verification has run.

### 2026-10-20 P2 source continuation — delivery acknowledgment and verifier Location

Direct and managed Core Task delivery now persists `ackState=acknowledged` after prompt return. Direct resume rejects a prior unacknowledged envelope; managed recovery requires both the acknowledged envelope and durable returned-child marker, preserving no-replay behavior after consume. §12.11 records the transition. Source only; no tests/builds/typechecks/audits. P2 also found the Goal verification handler still constructs the approval `Location.Ref` from root `InstanceState.directory` rather than the exact P8 managed child worktree. Parent/P1 are defining a trusted projection; verifier approval/dispatch remains unavailable until Core can resolve that Location from HostKernel/P8 authority.

### Managed verifier and aggregate search integration (2026-10-20)
P2 found the verifier approval UI currently receives the root Location while its managed Attempt is bound to the P8 child worktree; this blocks verifier dispatch until P1 supplies an authenticated exact child LocationRef or proves HostKernel routing ignores the supplied ref. P1 is implementing one aggregate Guarded search execution with durable ordered subreceipts and UNKNOWN recovery; keyless routes are the initial source path and BYO routes remain unavailable until Rust SecretBroker one-use consumption is wired. These are implementation updates, not acceptance evidence.

P7 source continuation (2026-10-20): source-generation changes now clear the old stream seal on canonical seed. Checkpoint restore reconciliation no longer trusts a boolean completion claim; it accepts an opaque HostKernel observation and only records Succeeded when every planned path has an Applied receipt and exact observed captured content/mode/single-link regular-file facts. P1 must provide the observation after guarded dispatch. No validation run. Remaining P7 integration: P1 HostKernel AutomationService/checkpoint Guard routes and same-boundary VCS dirty/untracked facts; P2 automation control/TUI parity; Core SessionRevert route; full CP/AU/UI/analytics acceptance after implementation.


### 2026-10-20 06:34 UTC — implementation ownership and remaining integration

P1 Guard/ExecutionHost/HostKernel, P2 managed vertical, and P3 RepoIntel are the active whole-phase owners. P7 returned PARTIAL after implementing source-generation replay fencing and requiring exact guarded per-path receipts plus a fresh opaque HostKernel observation before checkpoint restore can report Succeeded. P4/P5/P6/P7 integration/P8 integrated acceptance/P9 remain open or queued. No tests/builds/typechecks/audits/provider probes have run under the user-directed implementation-first hold.

Parent source review: the search cascade records ordered route results, continues after 401/403/407 and after bounded 408/425/5xx retry exhaustion, and leaves uncertain transport outcomes UNKNOWN. The managed verifier Location projection is present in Rust and consumed by Core against the frozen final revision. HostKernel automation registry operations and checkpoint service routes remain absent; invocation and restore stay disabled until guarded execution, trusted workspace/VCS facts, durable receipts and recovery are integrated. This is implementation status, not phase acceptance.

Preserve the mixed unstaged Git tree; no staging, commit, push, worktree cleanup or tests in this checkpoint. C: has 46 GB free via `/mnt/c`; V1 remains PARTIAL / NOT RELEASED.

2026-10-20 06:35 UTC — Managed revision domains: the immutable `ManagedWorktreeTargetV1.workspaceRevision` pins HostKernel's admission observation; the top-level Attempt scope revision tracks the live child head and advances only through Rust-validated receipts. P2 removed the accidental equality and added exact immutable-target identity comparison. P1 must enforce receipt-only current-head advancement. Source only; unverified.

2026-10-20 06:36 UTC — P2 found a modal deadlock in managed verification: the approval dialog remains active while awaiting Host Guard, but the UI mounts Guard dialogs only with an empty stack and the Guard decision clears all dialogs. P2 has exclusive temporary ownership of `packages/tui/src/app.tsx` and `packages/tui/src/ui/dialog.tsx` for a scoped `host.managed_verifier` push/pop flow that preserves the verifier dialog. Source-only; UI acceptance remains pending.

P3 source work now registers bounded `repo_detect`, routes reference/definition queries through authenticated RepoIntel, and exposes exact workspace/generation/revision/node/file/parser provenance. Profile state now carries requested/effective Lightweight/Adaptive/Full and typed restriction metadata; P6 resolves settings and P8 supplies bounded resource pressure. Parser availability, immutable editor buffers, and query-to-patch freshness remain unresolved phase dependencies. No tests/builds/typechecks run.

### 2026-10-20 06:44 UTC — source status superseding prior phase rows (not verified)

- **P1 — IN PROGRESS:** automation read-only routes and checkpoint list/preview are now present. Persisted automation mutators were found to bypass Guard and are now denied before mutation; keep invocation/capture/restore disabled. Same-boundary VCS facts are still required for useful restore preview. HostKernel aggregate web search now supports ordinary direct sessions and rejects direct Task Attempts pending a workspace-safe external-effect receipt. P1 still owns Guard/ExecutionHost, process/origin matrix, protocol journal/event buffer, automation/checkpoint safe integration, and adversarial/recovery acceptance.
- **P2 — IN PROGRESS:** whole-phase owner resumed. Wiring managed final-Inspect approval and settlement to current-workspace evidence, Guard lease/receipt, restart recovery, reviewer/verifier evidence, usage budget enforcement, Task delivery, Core→TUI and pause/cancel/conflict paths. Managed-root approval event bridge is P2-owned; HostKernel contract is P1-owned.
- **P3 — PARTIAL:** bounded `repo.detect`; authenticated RepoIntel-backed references/definitions with truthful parser UNAVAILABLE; provenance and requested/effective profile output. Profile resolution, P8 pressure source, P1 stale-write fence, parser and authenticated editor-buffer source remain open.
- **P4 — IN PROGRESS:** owner resumed. Trusted global DAP profile projection and missing launch adapter import are being added; HostKernel protocol journal/event buffer is a P1 dependency. Keep all effectful process/protocol paths unavailable until Guard, OS confinement, bounded IO and acceptance pass.
- **P5 — PARTIAL:** parent change permits Goal-less ordinary direct Core search to reach Guarded HostKernel; direct Task search stays denied by HostKernel. Rust aggregate receipt/cascade exists in source, but Core transport composition, crash-recovery pins, explicit route controls/provenance, and disabled/failure/429/exhaustion/consent acceptance remain. `WEB_SEARCH_RUNTIME_READY` remains false; no network effect is exposed.
- **P6/P7/P8/P9 and A1–A4 — NOT VERIFIED:** continue whole-phase implementation and reconcile source before final checks. A1 must be described as the HorizonCode typecheck, not OpenCode typecheck; no current-revision typecheck has been run in this implementation wave.

No checks, builds, provider calls, staging, commits or pushes in this wave. Git is mixed and preserved. C: last measured at 46 GB free through `/mnt/c`; kernel/target 520 MB. Overall V1 PARTIAL / NOT RELEASED.

### 2026-10-20 06:51 UTC — current implementation state (not acceptance)

P1 source now supports replay-safe managed verification recovery: exact SETTLING evidence returns its existing candidate/evidence/artifact refs, and approved-but-undispatched sets return RESUME_EXECUTION only against matching authority and frozen pins; no challenge or one-use lease is reissued. P2 is consuming this contract in the final Inspect/settlement flow. The user's budget decision is locked to existing schema: token authority is the minimum of SpecVersion maxTokens and pinned profile tokenBudget; cost authority is SpecVersion maxCostMicros alone. P2 owns the Core supervisor cancel-on-interrupt allowlist for P5's aggregate search RPC. P4's typed/config work continues; all effectful launch and REPL routes remain unavailable pending P1 Guard/confinement/protocol support and required OS limits. No tests, builds, typechecks, audits or probes run per the implementation-first instruction. V1 remains PARTIAL / NOT RELEASED.

2026-10-20 06:52 UTC follow-up: P1's verifier recovery projection now includes the exact child-worktree `approvalLocation` at the frozen final revision for approval, resume and settlement-recovery states. This preserves the managed Attempt's real Location boundary; P2 must consume it, and P1 must document it in the normative runtime contract. Source only; not accepted or tested.

2026-10-20 06:53 UTC: P1 updated the normative domain and runtime LLDs for state-aware verifier restart recovery, exact registered child approvalLocation, no stale challenge/lease replay, and SETTLING versus SUCCEEDED. P2 integration and final acceptance remain open; no tests/builds/typechecks run.

2026-10-20 06:54 UTC resource check: C: 45 GB free via `/mnt/c`, kernel/target 520 MB, one primary worktree only. Active build/test processes are owned by LiteCowork and were left alone. HorizonCode remains in implementation-only mode; no validation is claimed.

2026-10-20 06:55 UTC — P5 now fences HostKernel cascade output against the exact Core-approved route sequence, including selected-provider and retry-state consistency; acceptance cases were added and remain unrun. P2 source wires Guard final Inspect → CLEAN receipt → managed settle → P8 release and consumes exact approvalLocation recovery. Remaining P2 crash windows are with P1: resolve a completed final-Inspect receipt before a consumed challenge and safely recover idempotent settle_dispatch after SUCCEEDED. No tests/builds/typechecks/audits run; overall V1 remains PARTIAL / NOT RELEASED.

2026-10-20 06:55 UTC P4 follow-up: Core source now validates bounded LSP code-action/rename edits, canonical DAP Guard operations, and REPL callback identity/generation/dedup/UNKNOWN states. No effectful adapter is enabled; the normative contract requires unavailable OS limits and a HostKernel boundary before REPL execution. Test sources are added but unrun.

2026-10-20 07:00 UTC — P2 recovery review refined the final-Inspect crash cases. A full Core retry reuses P8's deterministic Inspect pin, obtains fresh Guard approval, then resolves the exact completed receipt without redispatch. P1 still owns receipt-first resolution for same-request transport replay after challenge consumption, plus idempotent `settle_dispatch` recovery after durable Attempt SUCCEEDED and a crash/lost response. P2 consumes the typed recovery behavior. No tests/builds/typechecks run; managed finalization stays fail-closed.

2026-10-20 07:01 UTC — P4 independent source work handed off PARTIAL: immutable bounded LSP/DAP DTO snapshots, proposal-only codeAction/rename edits, command-specific DAP argument/capability checks, and bounded generation-scoped REPL callback/UNKNOWN bookkeeping. No process launch or REPL execution is enabled. P1 owns the Guarded HostKernel protocol/reply/journal and codeAction/rename capability mapping; P3 owns authenticated document ingress; P8/OS enforcement owns resource-backed REPL readiness. Focused tests were added, not executed. The freed whole-phase slot is assigned to P8 worker/resource/worktree integration and RC0. Active children P1/P2/P8.

2026-10-20 07:02 UTC — subagent lifecycle parity audit found a first-party V1 gap. Pinned Codex separates child lifetime, queue-only messages, triggered follow-up, wait/activity, explicit interrupt, result projection, status and shutdown cleanup. Horizon's existing one-shot profile-pinned TaskTool does not implement the direct-session §29.5/§29.13/§37.9 mailbox/lifecycle control plane. P6 owns this Core Session/TaskTool lifecycle and TUI activity/result projection; P2 retains the Rust managed Attempt lane; P8 supplies bounded capacity facts; P1 Guard and durable launch/UNKNOWN reconciliation remain mandatory before spawn/effects. The operative Gate 7 checklist now enumerates these requirements. This uses existing contracts/capability IDs and does not introduce a second runtime/event bus. P6 is queued for the next child slot.

2026-10-20 07:03 UTC — P1/P2/P8 closed two managed verifier recovery source seams: P8 returns typed `None` only for genuine absence and preserves distinct errors; P1 uses it before exact completed Inspect receipt resolution. Same-epoch retry is exact cached receipt only; full HostKernel restart requires fresh Guard approval for the same deterministic P8 operation before durable receipt recovery. P1's read-only terminal settlement snapshot now includes exact verificationRunID/challengeSetDigest/finalRevision/evidence refs from the unique durable verifier set; P2 strictly consumes it and invokes existing `settle_dispatch`. Source only; no tests/builds/typechecks.

User decision for direct child lifecycle: use canonical `agents.message` with `deliveryMode: "queued" | "follow_up"`, no separate capability. Normative §29/§37 and Gate 7 are updated. P6 owns the strict machine contract plus Core mailbox/turn lifecycle and TUI projection and is queued for the next child slot. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 07:08 UTC — full V1 implementation status (not release evidence)

Active phase owners: P4, P6, P8. P1 continuation is next queued due to the platform's three-child limit; P3 and P7 remain queued. P2's source-side terminal settlement recovery integration is present, but real-socket managed flow, crash/lost-response, cancel/pause, stale-review, human-edit conflict, reviewer identity and budget-stop acceptance remains deferred until implementation is complete. P5 remains parent-owned for Core transport/SecretBroker wiring. P9 and final release gates remain open.

Latest integration: P1 exposes a unique durable terminal verifier snapshot and P8 typed absent-vs-error pending-intent resolution; P2 consumes strict verifier/evidence/revision pins and only returns success after P8 RELEASED. LSP codeAction and rename map to existing query capabilities and remain proposal-only pending `files.patch`. Remaining P1 protocol journal/event buffering and broad effect-origin/ToolBatch/automation/checkpoint work block dependent P4/P6/P7 effects. No tests, builds, typechecks, audits, provider calls, or push gate have run. Source implementation is still in progress; V1 PARTIAL / NOT RELEASED. Git state is mixed and unstaged; preserve it. C: 45 GB free via `/mnt/c`; only the primary worktree; no pruning/cleanup.

2026-10-20 07:10 UTC — P6 direct child lifecycle will reuse Core's existing durable `SessionInput` inbox and next-boundary promotion. Public `agents.message` stays canonical with `deliveryMode`; it is a Guarded mutation. Private prepare/commit/inspect must bind authenticated parent/child Sessions, profile revision/digest, effective scope, epoch, message/payload, mailbox sequence and capacity; one-use authorization and durable receipt/UNKNOWN reconciliation are required. `follow_up` additionally requires fresh-turn proof; queued never starts a turn. §29/§37 updated; P6 owns schema/Core/TUI, P1 owns HostKernel, and the feature remains unavailable until the seam is wired. P4 proposal methods now use injected authenticated document reads and freshness checks; P3/P1 ingress remains required. P8 fixed RC0 shared-Core double counting and same-sequence ambiguity in source, with regression tests added but held. No validation run.

2026-10-20 07:12 UTC — P8 source handoff is PHASE_PARTIAL; RC0 aggregation and typed Inspect resolver are present, but resource quotas, attested baselines and P1/P2 integrated recovery acceptance remain. P1 resumed as whole-phase owner in the freed slot. Active owners: P1/P4/P6; P8 queued for integrated acceptance. No tests/builds/typechecks/audits run.

2026-10-20 07:13 UTC — P5 product runtime is composed through `WebSearchRuntime.node` and its aggregate HostKernel cascade dispatcher/recovery is source-present for fixed keyless routes, but the production ready gate remains false and no route is verified. BYO still needs P6 credential-ref composition and P1 Rust one-use SecretBroker consumption. §37.2 corrected. P4 callback reply wire is temporarily waiting on P1 to reconcile callback lease issuance with the buffered eventSequence; no effect is enabled.

2026-10-20 07:14 UTC — P1 confirmed the existing P4 callback reply DTO is normative: HostKernel eventSequence remains internal; each callback gets a new Guard challenge/lease, and reply uses a fresh outbound requestSequence plus serverRequestID/method. Exact retries return the same receipt; uncertainty fences UNKNOWN. No wire change. P4 continues; dispatcher remains unavailable pending acceptance.


2026-10-20 07:15 UTC — P6 direct-message API decision and runtime blocker: user selected public `agents.message` `deliveryMode: "queued" | "follow_up"`. Core may translate public `queued` to private HostKernel `queue`; queued only persists, while follow_up requests one serialized fresh child turn at a safe boundary and cannot alter an active request/token stream. P6 confirmed TaskTool's direct child still uses the V1 SessionPrompt transcript while Core's durable SessionInput inbox belongs to the V2 runner; writing to SessionInput directly would split history. P6 will continue independent whole-phase work; message dispatch remains unavailable until the correct durable inbox-to-child-runtime adapter and P1 Guard prepare/commit/inspect boundary are wired. Active child owners remain P1/P4/P6. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Preserve the mixed unstaged tree; C: has 45 GB free via `/mnt/c`; one primary worktree; no cleanup/pruning.


2026-10-20 07:17 UTC — owner handoff correction: P4 returned PHASE_PARTIAL after independent source work (LSP exact Guard method mapping and bounded callback validation, DAP unsupported-command denial, source-only regression coverage, §37.6 status); runtime acceptance still depends on P1 process/protocol/confinement, P3 authenticated document ingress, and P8 enforced REPL quotas. P4 is queued for resumption after those dependencies. The freed platform slot is assigned to whole-phase P3 RepoIntel; active owners are P1/P3/P6. P1's direct-message private DTO now fixes service `direct.message.v1`, prepare/commit/inspect, private `queue|follow_up`, nested authority pins, payload 1–16 KiB, capacity 1–32, and SHA-256 payload digest; P6 is aligning its adapter while preserving public `queued|follow_up`. No tests/builds/typechecks/audits/provider probes run under the implementation-first hold. Overall V1 remains PARTIAL / NOT RELEASED.


2026-10-20 07:18 UTC — P3 bridge ownership: P3 resumed as whole-phase owner and may add only the authenticated `repo-intel.v1/read_document` service/adapter seam in `packages/core/src/session/supervisor.ts` plus new P3 bridge modules. Existing managed-control P2/parent edits in the shared supervisor file are protected; P1 has been asked to avoid that Core file during this lease and retains HostKernel/Rust ownership. P4 LSP files remain P4-owned; P3 must expose an adapter module or coordinate before touching them. No validation run.


2026-10-20 07:19 UTC — P5 Core credential-reference composition: parent wired `Auth.Service.searchCredentialRefs()` into the production `WebSearchRuntime.node` and exposed only the fixed BYO route IDs in its trusted supported-route projection. The existing Auth method returns only a unique AVAILABLE opaque SecretRef per fixed provider ID; broker errors/ambiguity omit routes, and no key bytes enter Core. `WEB_SEARCH_RUNTIME_READY` remains false; HostKernel presently admits keyless routes only, and P1's fixed BYO transport/one-use consumption plus integrated acceptance are still required. §37.2 updated. Source-only; no tests/builds/typechecks/audits/provider calls. Active phase owners P1/P3/P6; P4 PARTIAL/queued; V1 PARTIAL / NOT RELEASED.


2026-10-20 07:20 UTC — P1 security seam continuation: P1 added strict private `direct.message.v1` prepare/commit/inspect DTOs and the canonical `agents.message` Guard policy, but RPC routing/OwnerLog durability remain fail-closed. Automation dispatch was tightened so only list/inspect/history reach `automation_rpc`; create/update/enable/disable and run_now remain unavailable before effects without Guard/receipt paths. LSP protocol dispatcher/reply and direct message operations remain unavailable pending HostKernel journaling/recovery. Source only; no checks run.


2026-10-20 07:21 UTC — P3/P6 integration: P6 is adding the trusted Config repo-intelligence requested/effective profile projection as a P6-owned seam; P3 will consume it without editing Config ownership. P3 requested HostKernel stale RepoIntel node proof validation before `files.patch`; P1 asked for exact schema-derived ref/digest fields before changing the shared HostKernel DTO. P1 also found the search cascade recorded 429 `Retry-After` but advanced immediately despite §37.5 requiring bounded cancellation-aware cooldown; P1 is correcting the Rust route behavior. All remain source-only and fail-closed.


2026-10-20 07:22 UTC — RepoIntel stale-write evidence shape: P3 requested a stale node proof before `files.patch`. The canonical `RepoNodeRefV1` contains workspaceBinding, sourceGeneration, sourceRevision, optional overlayDigest, pathRef, fileDigest, nodeId/nodeKind/symbol, byteRange, and parserId/parserVersion; there is no separate opaque node digest. P1 will keep HostKernel DTO work owner-scoped and derive any binding digest from the fully validated schema plus authenticated live generation/revision. No patch request field can authorize a stale write.


2026-10-20 07:23 UTC — P6 RepoIntel settings seam: `FeatureExposure` is a boolean compaction toggle and cannot represent RepoIntel's requested/effective `lightweight|adaptive|full` modes. P6 is adding a dedicated Config/API setting with optimistic concurrency and a typed requested/effective/source/locked/unavailable projection for P3; changing the setting alone must not launch work or network activity. P6 owns §16; P3 consumes the projection and P8 supplies pressure narrowing. Source only; no validation.


2026-10-20 07:25 UTC — P1/P3/P6 source integration advances: P1 added `prepare_tool_batch.repoIntelFence` validation over query ID, generation/revision/workspace binding and exact path/file-digest refs, including authenticated live scope, bounded resnapshot and unique target matching; only root selector `.` is supported pending safe path rebasing. P3 added the authenticated Core `readRepoDocument` bridge and an LSP callback bridge for P4, and consumes P6's new Config profile projection. P6 source now has the Config-owned optimistic-concurrency three-mode setting, TUI selector and question owner-chain workspace ancestry denial. P1 also changed web-search 429 handling to cancellation-aware bounded cooldown and records effective retryAfter; cancellation during cooldown leaves aggregate UNKNOWN. Source-only, no tests run. Identified a transport-bound issue: document read max was set to 6 MiB, equal to RPC frame maximum; JSON string escaping/envelope could overflow, so P1/P3 are coordinating a smaller shared bound.


2026-10-20 07:27 UTC — parent integration rulings and source checkpoint (implementation only)

- **P6 `agents.message` ruling:** the user reconfirmed public `deliveryMode: queued | follow_up`; Core maps `queued` to private HostKernel `queue`. Parent source review requires private `directAttemptID` in authority pins for both modes because HostKernel has no child→Attempt index. HostKernel must re-resolve the exact durable admitted DirectAttempt and match parent/child/profile/effective scope/epoch/workspace. `queued` has no fresh-turn proof; `follow_up` additionally requires a fresh-turn DirectAttempt proof. P6 owns schema/Core/TUI and P1 owns the private DTO/HostKernel side. Both modes stay unavailable until the V1 child transcript has a durable safe-boundary append/ack API and the Guard journal/lease/receipt/UNKNOWN path is wired.
- **P3/P1 patch-fence integration:** P3 found that existing `apply_patch` prepares absolute operation paths, while P1's `repoIntelFence` compares normalized RepoIntel-relative paths. P1 is changing only the fence comparison to derive a canonical path relative to the authenticated registered root, rejecting escapes and ambiguity while preserving Guard operation paths.
- **RepoDocumentRead bound:** P3 schema/Core and P1 HostKernel now agree on a 1,000,000-byte body cap, leaving RPC frame headroom.
- **Active whole-phase owners:** P1 Guard/ExecutionHost/HostKernel, P3 RepoIntel and P6 settings/providers/Doctor/S1/direct child lifecycle. P4 remains PARTIAL and queued; P2/P5/P7/P8/P9 and final integrated release gates remain open. The three actual child slots are occupied; no extra concurrency is claimed.
- **Implementation-first hold:** no tests, builds, typechecks, audits, provider calls or probes were run. These source changes have not been accepted or verified. Git remains mixed and unstaged; C: has 45 GB free via `/mnt/c`, `kernel/target` is 520 MB, and only the primary worktree exists. V1 remains PARTIAL / NOT RELEASED.


2026-10-20 07:29 UTC — P1/P3 patch-fence interface resolved in source: HostKernel now derives a normalized RepoIntel-relative comparison path from each existing absolute `files.patch` operation under the authenticated canonical registered root. The Guard operation path remains unchanged; root escapes, non-normal components and ambiguous targets are rejected before admission. This closes the source-level adapter mismatch, not acceptance evidence. P1 confirmed it will add P6's required exact `directAttemptID` pin and durable owner re-resolution. No tests/builds/typechecks/audits run.


2026-10-20 07:32 UTC — P3/P1/P6 interface updates (source only): RepoDocumentRead is now capped at **131,072 bytes** in the P3 schema/Core; P1 is aligning HostKernel. Worst-case JSON escaping is about 786 KiB, leaving frame headroom under the 1 MiB LSP bound. The P3 LSP document-reader adapter was hidden by the root `*` overlay rule; parent added its exact `.gitignore` exception, and Git now reports the source as untracked/visible (not staged). P1 now requires and resolves exact `directAttemptID` for both message modes, includes it in authority digest, validates the persisted OwnerLog's principal/session/epoch/profile/scope/workspace/head, and denies non-EXECUTING child Attempts. Message RPCs still return unavailable until Guarded mailbox durability, Core V1 transcript append/ack, and follow_up safe-idle proof are implemented. No tests/builds/typechecks/audits run.


2026-10-20 07:35 UTC — follow-up integration requirements: the P3 schema now models RepoIntel patch targets as exactly one existing-file digest or `expectedAbsent: true` destination proof. P1 must accept only those strict shapes and revalidate absent destinations under authenticated root/revision (the current HostKernel parser still requires `{pathRef,fileDigest}`). Parent approved this source contract for adds/moves. The P4 LSP client currently requests 6 MiB while RepoDocumentRead allows 131,072 bytes; P3 is clamping within its new Core→LSP bridge so the authenticated request remains within the shared cap. `apply_patch` UI/schema description must name both forms. No tests/builds/typechecks run.


2026-10-20 07:37 UTC — P1/P3 RepoIntel fence now agrees on source: HostKernel accepts only the strict XOR source-ref forms `{pathRef,fileDigest}` or `{pathRef,expectedAbsent:true}`. It validates existing digests against the authenticated live generation; expected-absent targets are checked under the registered root with component-wise no-symlink/real-directory validation and a final workspace-revision recheck. Absolute Guard patch paths are retained and only mapped for RepoIntel comparison. P3 updated schema/UI description and clamps LSP document reads to 131,072 bytes. No validation run.


2026-10-20 07:39 UTC — source checkpoint and phase-slot update: P1 has now set HostKernel RepoDocumentRead to 131,072 bytes, matching P3 schema/Core. P1 also added operation coherence: expected-absent refs must match `write` operations with null expected-before; digest refs must match writes/deletes with a prior digest. This supersedes the 07:35 note that Rust still required only file digests. P3 returned **PHASE_PARTIAL** after exhausting independent source work; remaining P3 dependencies are P4 LSP composition, P8 resource-pressure narrowing, a trusted unsaved-buffer producer and approved structural parser/index. One child slot opened and is assigned to the whole P8 phase; active owners are P1/P6/P8. P6 found a missing Config-owned RepoIntel profile compare/write implementation used by its own routes/UI and is restoring it before resuming child status projection. No tests/builds/typechecks/audits run; C: remains 45 GB free via `/mnt/c`, kernel/target 520 MB.

Source integration update (2026-10-20): P5 now consumes the HostKernel `execution.v1.web-search-cascade` negotiation and fails closed unless it and `effects.v2` were negotiated. P1 offers the feature only when Guard execution readiness is true. `WEB_SEARCH_RUNTIME_READY` stays false pending integrated acceptance; BYO credentials remain unavailable pending P1 transport/one-use consumption. Budget authority is settled and source-present: token ceiling is the minimum of SpecVersion and pinned AgentProfile tokenBudget when both exist; cost ceiling is SpecVersion only. No tests/builds were run.

Implementation follow-through (2026-10-20): P5 serializes the exact admitted opaque credential-reference route list into the aggregate HostKernel request and requires negotiated cascade/effects features; production readiness remains false. P8 added a typed pressure-narrowed RepoIntel profile projection, but source integration still needs a trusted live pressure producer, durable hysteresis recovery and P3 consumption. P2 phase owner is active. No checks were run.

Phase allocation update (2026-10-20): child owners P2/P6/P8 are active. P1 is PHASE_PARTIAL and queued for resumption; P3/P4/P7/P9 remain open/queued; P5 remains parent-owned. Whole-scope implementation, then final verification and release gates remain outstanding. No checks have run during the implementation-first hold.

Reference-source follow-up (2026-10-20): a read-only inspection of local Codex multi-agent modules and OpenCode TaskTool was recorded in §42.12. The concrete Horizon take is Core Session linkage/permission propagation/cancellation plus queue-versus-trigger lifecycle and spawn cleanup ordering; Codex's process-local mailbox, watch state and policy remain unsuitable as durable Horizon authority. P6 is implementing/checking direct lifecycle gaps; P1/P6/P8 remain active. Verification is still deferred.

Source audit update (2026-10-20): P2 plan-only status wording now reflects explicit `goal.start`; P2 is partial pending the P1 independent verifier and P8 settlement integration. P8 blocks capacity release for every terminal other than SUCCEEDED+VERIFIED; failure states stay available for typed reconciliation. P1 resumed; active child owners P1/P6/P8. No validation run.

2026-10-20 07:42 UTC — continuation checkpoint: active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1/direct lifecycle, and P8 resources; all three actual child slots are occupied. P2 remains PHASE_PARTIAL pending P1/P8 integration. P3/P4/P7/P9 and final integrated implementation/release work remain open or queued; P5 is parent-owned and fail-closed. P6 changed direct delivery outcomes to start QUEUED, become EXPIRED only before prompt invocation, and become UNKNOWN after prompt invocation or acknowledgement-persistence ambiguity; child history is retained and no unsafe lineage detach/delete is attempted. P1 hardened terminal.start so post-admission persistence failures are UNKNOWN and never reported as RUNNING. P8 is implementing a bounded pinned-cache eviction planner; success settlement remains SUCCEEDED+VERIFIED-only, while a separate failure release must follow §11.20/§18.18 owned-process termination and settled-effect reconciliation; V1 logical children share Core and cannot claim per-child PID termination. Public child messaging is `agents.message` with `deliveryMode: queued|follow_up`; bounded named-child wait is read-only and timeout never cancels. No tests/builds/typechecks/audits run. Git remains mixed, unstaged and ownership-sensitive; only the primary worktree exists; C: 45 GB free via `/mnt/c`, `kernel/target` 520 MB; the unrelated LiteCowork Cargo test remains untouched. HorizonCode V1 remains PARTIAL / NOT RELEASED.

2026-10-20 07:49 UTC — implementation checkpoint: User confirmed `agents.message` with `deliveryMode: queued|follow_up`. P6's wait path now reauthorizes parent/workspace scope per poll and validates the exact DirectAttempt scope pin; message dispatch remains fail-closed pending durable transcript append/ack, Guard journaling/lease and safe-turn proof. P1 added preflight denial for unsupported effect-origin capability IDs and blocks non-success managed settlement pending P8 quarantine reconciliation. P5 removed a fabricated zero-latency field; observed latency remains unreported until measured. Owners: P1/P6/P8 active; P2 partial; P3/P4/P7/P9 and release gates open; P5 parent-owned. No tests/builds/typechecks/audits/probes run. Git mixed and unstaged; C: 45 GB free via `/mnt/c`; only primary worktree; V1 PARTIAL / NOT RELEASED.

2026-10-20 07:51 UTC — Source delta: P1 enforces a durable aggregate maximum of 64 direct child Sessions per authenticated parent Session across profiles, with exact replay/deduplication behavior; child-profile limits remain stricter where lower. P6 is aligning the Core early-denial path and §29.13. P1 wired the P8 quarantine-only managed terminal path for exact failure/cancellation after scope/handoff/effect/workspace checks; quarantine retains capacity/worktree and no process-tree exit is claimed. P8 is adding the distinct fresh proof required for release. P5 corrected stale search readiness statements in §16.7/§42 and removed fabricated zero latency. No checks were run; all changes require final integrated verification. V1 PARTIAL / NOT RELEASED.

2026-10-20 07:53 UTC — P6 source handoff: PHASE_PARTIAL after implementing direct child status/wait ownership rechecks and exact Attempt scope, 64-child UX count, offline Provider Doctor projection, provider capability projection, RepoIntel settings and S1 owner checks. Remaining P6 delivery, live Doctor/BYO and question filtering are blocked on P1/P7. P1's durable aggregate direct child ceiling now counts distinct parent/child Session pairs across profiles; same-child resume is deduped and concurrent/mismatched authority denies. P1 integrated P8's separate non-success quarantine while P8 owns fresh release reconciliation. P7 is active for the full streaming/artifact/automation/rewind phase. Active owners P1/P7/P8; no checks run; V1 PARTIAL / NOT RELEASED.

2026-10-20 07:55 UTC — P8 fresh reconciliation API now binds old terminal proof + durable quarantine receipt + current owner/root and terminal snapshot + HostKernel quiescence digest + mandatory current Guarded Inspect of the active registered worktree/root; missing/UNKNOWN stays quarantined. P1 resumed to integrate it and continue the whole Guard phase. P7 is now active with exclusive P7 Rust modules `artifact_store.rs`, `automation.rs`, `checkpoint.rs` plus its Core/TUI/schema scope; P8 owns resource/worker/worktree modules; P1 owns Guard/HostKernel/effect_host/protocol. No tests/builds/typechecks run. Owners P1/P7/P8; V1 PARTIAL / NOT RELEASED.

2026-10-20 07:58 UTC — P5 now treats post-invocation HostKernel transport loss/interrupt as UNKNOWN, never exhausted; it halts later serial effects and does not retry a route. HostKernel typed refusal reports unavailable. Successful latency is measured aggregate RPC round-trip. Exact durable receipt inspect/replay is still a P1 requirement, keeping search unavailable. Cache scope is pending user ruling because §37.5 requires per-URL content caching, but current V1 search returns links and has no page-content fetch/bypass wire contract.


2026-10-20 08:04 UTC — P5 V1 scope ruling and continuation: `web.search`/`WebSearchRequestV1` return bounded links/snippets and define no page fetch or cache-bypass input, so the §37.5 per-URL page-content cache is deferred post-V1; V1 must not fetch/cache content implicitly. The normative text now records that boundary and the explicit contract needed before future page retrieval. P1 is adding a read-only exact-authority `inspect_search_cascade` for lost RPC replies; it may reconcile status/receipts but never re-execute. A settled success with an unrecoverable response body must be surfaced as “completed, results unavailable,” distinct from unsettled UNKNOWN and exhaustion. P7 asked P1 to assess authenticated owner/CAS automation definition CRUD while leaving `runNow` disabled; parent passed the request to P1. P7 source fixes include accurate artifact pending failure and live raster-cache gauge aggregation; effectful artifact/automation/checkpoint paths remain Guard-gated. Active whole-phase owners P1/P7/P8. No tests/builds/typechecks/audits/provider probes run; user deferred them until implementation is finished. Git remains mixed/unstaged (13 commits ahead); C: has 45 GB free via `/mnt/c`, `kernel/target` 520 MB, one primary worktree. Overall HorizonCode V1 remains PARTIAL / NOT RELEASED.
## 2026-10-20 08:16 UTC — repo-only operating boundary and active work

All remaining work is confined to `/home/sarvesh/business_Dev/agentx` by the updated root `AGENTS.md`; no external files/services/remotes may be accessed while that user boundary is active. The prior C: `/mnt/c` check is superseded. Active full-phase owners are P1 Guard/ExecutionHost, P7 streaming/artifacts, P8 resources/worktrees. P5 now carries the HostKernel-minted `routePlanDigest` across Core Guard approval and attempts read-only HostKernel search receipt reconciliation after lost RPC replies using the exact original authority pins; no route retry occurs. P1's matching RPC is not yet verified, and `WEB_SEARCH_RUNTIME_READY` remains false. No verification was run. Git is mixed and unstaged (13 commits ahead); do not publish or clean it under this boundary. HorizonCode V1 remains PARTIAL / NOT RELEASED.
## 2026-10-20 08:20 UTC — latest implementation ledger

P7 checkpoint Core/HTTP list source is now Git-visible through exactly three phase-owned ignore exceptions; preview stays closed until same-boundary dirty/untracked evidence is trustworthy. P8 has source for root reauthorization and fresh Guarded Inspect intent/receipt reconciliation; unknown input sizes/overflow no longer produce false freed-byte estimates. P1's `inspect_search_cascade` source matches the P5 bridge. A prior P1 `cargo check --lib` attempt produced 139 diagnostics across the dirty shared Rust crate; no phase acceptance is inferred. Further validation is deferred until all source implementation is complete. Repo-only user boundary remains active. Active phase owners P1/P7/P8; Git state remains mixed/unstaged, no remote actions; V1 is PARTIAL / NOT RELEASED.
## 2026-10-20 08:21 UTC — P5 no-dispatch classification tightened

Core now treats only HostKernel `feature_not_negotiated` as definitely pre-dispatch. All other typed errors may follow a durable intent or provider request and therefore use exact-pin read-only receipt inspection; absent proof stays UNKNOWN. No route retry. Source-only, unverified.

### 2026-10-20 08:24 UTC — attachment and identity-domain follow-up

Read the user-requested pasted-text attachment. It reaffirms whole V1 scope, source-backed OpenCode/Codex adaptation, full architecture re-audit, and delaying tests until implementation closes. Updated §17.24 to clarify that the managed Attempt owner is pinned to the child Session, root coordinator proof to the root Run SessionLink, and the child prompt-quiescence receipt ties those domains together via its parent Session ID. P1/P8 are aligning implementation to this rule. P7's checkpoint-control test now has an exact overlay visibility exception; unsupported automation mutation controls/command were removed and §31.20 updated. Source only, no tests/builds/typechecks/audits/probes. Active owners P1/P7/P8. Git remains mixed and unstaged; repo-only boundary active. HorizonCode V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 08:24 UTC — P7 handoff and P2 resumption

P7 returned PHASE_PARTIAL: authenticated bounded checkpoint list and source tests are present but unrun; checkpoint preview remains absent until trusted atomic same-boundary VCS/workspace evidence exists; automation mutation controls/command were removed while HostKernel rejects mutations. Its remaining effects depend on P1 Guard/receipts. The freed full-phase owner slot is assigned to P2 managed vertical. Live owners: P1/P2/P8. P3/P4/P6/P7/P9 and P5 parent work remain incomplete; final verification/release work remains queued. Repo-only boundary remains active, Git mixed/unstaged, and no tests/builds/typechecks/audits/probes were run. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 08:24 UTC — P5 local upstream source recheck

Inspected pinned local OpenCode `websearch.ts`/`mcp-websearch.ts` implementation: one Exa/Parallel route selected by flags/override/session checksum, websearch permission prompt, fixed bounded JSON-RPC MCP call, JSON/SSE result parsing and provider metadata. Horizon rejects its single-route selection and direct Core HTTP executor; fixed protocol shapes, bounded parsing and route/cooldown provenance are the reusable patterns, still subordinate to Horizon's HostKernel Guard/ExecutionHost and SecretBroker. Updated §42.12. No copied executor, tests, or provider probes. P5 remains PARTIAL pending P1/P6 transport and integrated acceptance.

### 2026-10-20 08:26 UTC — managed reconciliation source progress

P1 source adds guarded quarantine reconciliation Inspect prepare/execute, child-root fixed Git inspection, exact P8 receipt replay and post-execution workspace revision equality. P8 aligns current authenticated Attempt owner to the child Session while preserving root coordinator SessionLink separately; §17.24 states the rule. P1 still has to implement a durable fresh-process no-live callback/owned-command proof; unresolved state stays quarantined. P2 reports source-present distinct authenticated review, explicit goal.start, profile-pinned Attempt/worktree revision, budget accounting, TUI flow and strict verifier/final Inspect adapters, and is checking all remaining crash/restart/stale-review/human-edit/artifact gaps. No tests/builds/typechecks/audits run. Active owners P1/P2/P8; V1 PARTIAL / NOT RELEASED.


### 2026-10-20 08:31 UTC — implementation queue

P2 is PHASE_PARTIAL after source corrections for managed BLAKE3 output receipt digest and strict UNKNOWN verifier reason/final-revision validation; implementation handoff awaits P1/P8 integrations and subsequent integrated acceptance. Active whole-phase owners: P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, P8 resources/worktrees. P1 resumed to implement remaining fresh-process no-live-callback/process proof and all unblocked universal effect/receipt/recovery work; P6 owns P5's SecretBroker reference projection dependency; P8 owns durable resource/worktree settlement. P3/P4/P7/P9 and P2 integration remain open/queued; final HorizonCode typecheck/test/audit/provider acceptance/release gates are deferred until source implementation closes. No validation was run. Repo-only boundary active, mixed Git state preserved, V1 PARTIAL / NOT RELEASED.

**2026-10-20 08:37 UTC source checkpoint:** P1 now persists RUNNING after both reconciliation and final Inspect launches; persistence failure returns UNKNOWN. The durable direct Attempt admission log already enforces the 64 unique child-session aggregate cap. Current stdio supervisor cannot authenticate whole process-tree exit across HostKernel restart, so quarantine/capacity release remains blocked on a same-supervisor exit receipt. Direct messages/protocol operations remain disabled without durable transcript ACK and protocol journal/replay. P8 completed its independent source work and awaits P6's canonical ResourcePolicy projection, P3's authenticated pressure/cache integration and a safe OwnerLog retention contract. Newly assigned full-phase owners: P3 RepoIntel and P4 LSP/DAP/REPL; P2/P6 and P1 continuation remain active. No checks/builds/tests/audits/provider probes run; HorizonCode V1 remains PARTIAL / NOT RELEASED.

**2026-10-20 08:38 UTC P5 source note:** Core now rejects HostKernel search receipts with route attempts after an `UNKNOWN` outcome, with a focused unexecuted regression case. This is not search acceptance and `WEB_SEARCH_RUNTIME_READY` remains false. Active owners: P2/P6, P3, P4. P1's remaining Guard/ExecutionHost work is next when a slot opens; P7/P9 and final cross-phase acceptance remain. No validation run; V1 PARTIAL / NOT RELEASED.

P5 further tightened aggregate receipt validation: aggregate UNKNOWN cannot coexist with successful route evidence, and `RECONCILED_RESULT_UNAVAILABLE` requires a final successful route receipt. Regression cases are present but unrun; web search remains disabled until integrated acceptance.

P6 has aligned its resource API naming with §18.18: canonical ResourcePolicyV1 is unchanged; the richer settings/API value is ResourcePolicyProjectionV1, and no effective limit is emitted absent verified platform facts.

**2026-10-20 08:41 UTC:** P4 returned PARTIAL after source fixes for LSP's 128 KiB read cap, DAP bounds/validation, and TS/Rust protocol/process DTO alignment. No effects are enabled; journal/replay, Guard, confinement and P3 reader integration remain blockers. P1 has resumed full-phase work and owns the Rust patch-fence 64-item alignment alongside the remaining universal Guard/receipt/recovery scope. Active owners P1/P6/P3. No checks run.

P3 added RepoIntel cache TTL/pin/evict lifecycle source with null reclaimed-byte reporting; P8/P1 registry bridge remains open. P6 now requires fully explicit zero pricing and active availability before selecting an OpenCode default model; no free candidate means no default/paid fallback. No provider probes or validation run.

P1 source now counts UNKNOWN stdio/HTTP execution rows against capacity until authenticated reconciliation and aligns HostKernel RepoIntel source-reference limit to 64. No validation evidence exists yet; P1 remains PARTIAL.

**2026-10-20 08:44 UTC P6/P8 checkpoint:** P6 returned PARTIAL after a full source audit. Resource/RepoIntel projections, metadata-only credential reference projection, offline Doctor, guarded compaction writes, S1 owner checks and strict zero-priced OpenCode default selection are source-present; credential mutation/live auth remains unavailable. P6 FEAT/Doctor/S1/model-switching and free-model acceptance remain unverified. P8 resumed to integrate its resource/cache owner paths with P6/P3. Active owners P1/P3/P8; no checks run.

## 2026-10-20 08:49 UTC — current implementation allocation

**Status: PARTIAL / NOT RELEASED.** The user’s latest architecture/source note was read once from the exact path they named; `AGENTS.md` records that this is the sole one-time outside-repository read and no further external access is authorized. It restates full V1 delivery, actual OpenCode/Codex source review and adaptation, a complete arch_V1/flow/event re-audit, and implementation before validation. Current phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifacts/automation/rewind; P5 is parent-owned. P1 added bounded HostKernel-owned RepoIntel generation retention (64 entries and 64 MiB observed source bytes; not heap allocation or physical reclaim); P3 remains pending P8 authenticated CacheRegistry lifecycle integration. No tests/builds/typechecks/audits/provider probes have run in this implementation wave. Final integrated acceptance, all remaining phases, and release gates remain outstanding.

### 2026-10-20 08:53 UTC — integration ownership correction

Actual local OpenCode/Codex child lifecycle sources were rechecked; §42.12 records the exact patterns and Horizon adaptation boundary. Automation CRUD uses existing `automations.*` IDs plus §14.2 approval and §14.3 `prepare_user_effect`, not a new Guard authority. P1 owns Rust Guard/lease/CAS/receipt; P7 owns Core/TUI automation orchestration; P2 owns managed run/review. CRUD remains gated until integration; `runNow`, checkpoint capture/restore and other P7 effects remain gated pending their canonical supervised evidence. P2 has added exact recovered-child cancellation after durable fencing and is repairing the managed VERIFYING recovery transition. No tests/builds/typechecks/audits/probes run. All phase/release states remain PARTIAL / NOT RELEASED.


### 2026-10-20 09:00 UTC — source-only continuation ledger

**Status: PARTIAL / NOT RELEASED.** Active phase owners: P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, P7 stream/artifacts/automation/rewind. P2 returned PHASE_PARTIAL after source corrections to exact-child cancellation and managed VERIFYING recovery/finalization ordering; it must resume integration once P1/P8 provide their prerequisites. P7 read-only checkpoint list route is exposed through SDK/TUI; capture/preview/restore and automation effects remain gated. Parent owns the narrow Core user-action adapter metadata extension for automation (userActionID, capabilityID, optional challengeID/inputDigest), requiring authenticated ServerAuth and no Session. P1 owns Rust Guard binding, mutation receipt/CAS and read-only reconciliation; P7 owns Core/TUI. P5 remains disabled because Core's full route list is wider than the five currently fixed HostKernel keyless routes; P1/P6 own closing the authenticated BYO route gap. No tests/builds/typechecks/audits/provider probes were run. Repository-only boundary applies; mixed Git state is preserved; no remote publication or cleanup.


### 2026-10-20 09:01 UTC — automation CRUD source ownership correction

P7 source adds guarded Rust AutomationRegistry create/update/enable/disable CAS operations and an atomically persisted proof tuple (challenge, EffectIntent, consumed lease, and post-CAS receipt-core digest without circular hashing). P1 owns HostKernel verification of exact binding and lease plus EffectHost durable PREPARED/SETTLED control receipt. Parent owns Core's narrow prepareUserEffect metadata projection (server-generated userActionID, capabilityID, optional challengeID/inputDigest, authenticated ServerAuth/no Session); P7 owns registry/Core/TUI orchestration. Guard inputDigest is the canonical semantic request digest. Exact idempotency reconciliation must remain read-only and never re-dispatch. P1/P6/P7 active; no validation run; V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 09:21 UTC — implementation status continuation

The repository-only boundary is absolute. No outside path, C: metadata, external service, or
remote action is required or allowed. Active whole-phase owners are P1 Guard/ExecutionHost, P3
RepoIntel/cache, and P8 resources/worktrees; P7 returned PHASE_PARTIAL with remaining
integration/acceptance work assigned to resume after a slot opens. P7 source added a managed
artifact Core decoder and hardened independent ArtifactStore range reads. Parent added strict
authenticated supervisor transport for matching managed Attempt refs. Artifact HTTP/SDK/TUI
routes stay unavailable until an authenticated server-side Attempt-scope resolver exists. The
new Core artifact module is explicitly allowlisted in `.gitignore`. P8 additionally made its
unwired pressure-controller entrypoints crate-private, avoiding accidental production exposure
before authenticated ingress exists. No tests/builds/typechecks/audits were run. V1 is PARTIAL /
NOT RELEASED.


### 2026-10-20 09:19 UTC — implementation status update

Repo-only boundary: absolute. No external path, C: metadata, external service or remote Git
operation is authorized or required. Active owners: P1 Guard/ExecutionHost, P7
stream/artifacts/automation/rewind, P8 resources/worktrees/RC0. Parent added source-only Core
supervisor support for authenticated managed verifier ArtifactStore reads: exact ArtifactRef
binding, Session/Location/Attempt scope validation, feature negotiation, inspect and bounded
range operations (maximum 768 KiB). HostKernel remains the final artifact authorization owner;
direct Attempt refs stay unavailable. P7 added an internal `session/artifact-control.ts` adapter
and hardened ArtifactStore range reads, but public route projection stays unavailable until an
authenticated server-side resolver supplies the current managed Attempt scope. No tests/builds
were run. V1 is PARTIAL / NOT RELEASED.

### 2026-10-20 09:23 UTC — implementation owner ledger

P3 reports no safe independent source gap beyond the HostKernel-owned generation identity,
pin-count, and candidate revalidation/retirement contract; retain it as PARTIAL and resume it
when P1/P8 deliver that interface. P8's unconnected pressure-controller entrypoints are now
crate-private until authenticated policy ingress is wired. The open phase slot is assigned to
whole-phase P2 managed vertical. Active owners: P1/P2/P8. P7 remains PARTIAL with artifact
control source present but public route, checkpoint-effect and automation-invocation work
outstanding behind their owner/scope/Guard prerequisites. No validation was run; V1 remains
PARTIAL / NOT RELEASED.

09:24 UTC P5 update: a HostKernel-settled success with absent or undecodable result data now
surfaces as `RESULT_UNAVAILABLE` with the durable receipt reference. The caller can settle the
known terminal effect and does not retry or fall through. An unrun source regression covers
absent, empty and malformed bodies; no validation was performed.

### 2026-10-20 09:32 UTC — P2 accounting projection implementation

Rust now derives terminal/candidate usage summaries from durable Attempt receipts and binds them
into the corresponding state digests. Core decoders require and preserve the strict summary for
settlement candidates and successful terminal recovery. The summary labels known subtotals and
UNKNOWN/ESTIMATED remainder separately, retains per-metric/cost provenance, cursor, ceiling and
receipt-chain digest, and does not fabricate usage when the ledger is absent. P1 owns HostKernel
wire serialization and P8 consumes only the exact terminal proof. No tests/builds/typechecks ran;
P1/P8 integration and all P2 acceptance gates remain open. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-20 09:27 UTC — managed accounting/resource source gaps

P2 identified missing terminal/candidate projections for the already durable Attempt usage
ledger: token/cost totals, provenance/UNKNOWN remainder, accounting cursor and ceiling digest.
P2 owns the managed-control summary, P1 its settlement binding, P8 its exact proof consumer.
P1 specified pre-admission policy pinning to Rust's deterministic candidate Attempt, with only
the effective per-Run ActiveWorkers cap passed to P8; global worker capacity remains separately
owned. Both paths remain unaccepted and gated. No tests/builds were run; V1 remains PARTIAL /
NOT RELEASED.

### 2026-10-20 09:31 UTC — current source-only continuation

The requested attachment was read once. It directs implementation to compare the actual local
OpenCode/Codex modules with HorizonCode's intended contracts, reuse compatible lifecycle
patterns, and complete the full V1 scope. Source review confirmed the §42.12 adaptation notes:
reserve before child creation, persist lineage before input acceptance, clean up partial starts,
separate queue-only messaging from explicit follow-up turns, and keep bounded wait/status,
cancel, result, and shutdown behavior. HorizonCode's authenticated Core/Rust ownership remains
authoritative.

Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P8 resource/
worktree/recovery. P2's usage/accounting projection and P8's HostKernel-pinned per-Run worker
cap are source-present but not verified; P1 is integrating them and continues its phase. P5's
ordered cascade remains gated on Guard/ExecutionHost and SecretBroker transport. The existing
first-party `provider-transport.ts` plus `Auth.makeService` authorizer interface is the documented
reuse point; the production authorizer remains absent. No validation, provider call, Git
publication, or cleanup occurred. Work remains inside `agentx`; HorizonCode V1 is PARTIAL / NOT
RELEASED.

2026-10-20 09:32 UTC P8 cache retirement: source now requires a typed acknowledgement for the
exact HostKernel source generation and eviction plan before completing a P8 cache eviction; the
raw boolean finisher is private. There is no production cache sink/registry caller and no claim
of bytes reclaimed. P1 owns HostKernel generation retirement; P3's authenticated cache ingress
remains open. No checks were run.

2026-10-20 09:33 UTC P5 source hardening: bounded provider response normalization to four nested
MCP wrapper levels and added an unrun regression fixture. Aggregate dispatch/readiness remains
fail-closed pending P1 Guard/HostKernel and SecretBroker integration.

2026-10-20 09:34 UTC P1/P8 integration: HostKernel managed artifact reads now bind to durable
verifier evidence rather than the cleared active Attempt pointer. Exact RepoIntel generation
retirement returns P8's typed acknowledgement after principal/workspace/lease/Arc checks, with
no reclaimed-byte claim. P3 authenticated cache ingress remains open; no validation ran.

2026-10-20 09:35 UTC managed accounting integration: HostKernel emits the P2 typed
`usageAccounting` projection in candidate and terminal snapshots. Core decoder field names and
P1 serialization now align; absent terminal accounting remains null. The summary is already
bound by the Attempt state digest, which P8 consumes without recomputation. No tests/builds were
run; managed acceptance remains open.

### 2026-10-20 15:12 UTC — resumed P1/P2/P8 and P5 bounds (source only)

The previous P1/P2/P8 phase owners hit the platform usage limit and are terminal. New owners
have resumed the complete P1 Guard/ExecutionHost, P2 managed vertical, and P8 resource/recovery
phases with exclusive source ownership boundaries: P1 owns HostKernel/Guard/ExecutionHost,
P2 owns managed-control and managed Task/session integration, P8 owns resource/worker/worktree/
RC0 modules. P3/P4/P6/P7 remain open, queued for child capacity. Parent-owned P5 parser now limits
MCP content blocks to 32 and ignores text wrappers above 128 Ki characters before JSON parsing;
no search route is enabled. User instruction still defers tests/builds/typechecks/audits/provider
probes/benchmarks until implementation closes, so none ran. All work is inside `agentx`; mixed
Git state remains untouched (no staging/commit/push/cleanup). V1 remains PARTIAL / NOT RELEASED.

15:13 UTC P5 outcome correction (source only): a HostKernel `NEEDS_APPROVAL` response now
produces `SearchRuntimeError(outcome: NOT_DISPATCHED)` instead of falling through to the generic
cascade-exhausted outcome. No tests or provider calls ran; runtime remains disabled.

15:14 UTC P2 managed budget enforcement (source only): `attempt_usage_stopped()` now gates both
single-effect and atomic ToolBatch binding reducers while the Run is RUNNING; VERIFYING effects
remain separately permitted. Core processor records each step's usage provenance and durable
usage receipt, truncates the current stream after STOPPED, and exits rather than starting another
model step. The change closes a source gap where STOPPED previously prevented duplicate usage
receipts but did not prevent new coding effects. No tests/builds/typechecks ran; P2 remains gated
on P1 trusted verifier/fresh-process recovery and P8 final-Inspect receipt acceptance.

### 2026-10-20 15:17 UTC — P4 owner / P8 pressure seam / BYO boundary

P2 returned PARTIAL after source-integrating managed usage STOPPED enforcement in Rust effect
binding and stopping the Core provider loop after a STOPPED receipt. P2's remaining integrated
acceptance requires P1's trusted verifier/fresh-process recovery and P8's final-Inspect receipt
recovery. The freed child slot is assigned to whole-phase P4 LSP/DAP/REPL; it owns TypeScript
service/protocol clients while P1 retains the shared Rust HostKernel/Guard transport. P8 added a
fail-closed advisory PSS pressure consumer requiring explicit lower-watermark/calm-count, exact
policy revision/digest, matching owner epoch and fresh OwnerLog sample/cursor. It is not wired to
admission; config lacks these values, persistence/OS quotas remain unsupported. P1 continues
trusted verifier recovery and will expose only metadata-only BYO SecretBroker authorization after
exact Guard admission, using DEC-V1-06's existing in-process one-request ProviderTransport in
P6; no raw bytes or leases cross RPC. No validation ran. Repo-only boundary, mixed Git state and
PARTIAL / NOT RELEASED remain.

15:18 UTC DEC-V1-06 implementation binding: normative SecretBroker schema docs now pin requester
identity to a stable opaque digest of the authenticated HostKernel principal (never Session or
request), managed use to the exact Run ID, and profile scope to the pinned AgentProfileV2 ID /
revision / digest. Missing profile authority is fail-closed for BYO. P1 implements only the
metadata authorization projection; P6 uses it with the existing first-party in-process transport.
Raw credential bytes and SecretBroker leases remain outside RPC. No validation ran.

15:19 UTC source update: P8 now bounds process-local resource hysteresis by owner and resets the
tracker on restart; owner/policy/threshold mismatch invalidates it. No pressure history is durable
or wired to admission. P4's source adds global Core Config → HostKernel launch-profile resolution
for fixed trusted selectors and strict direct/managed Attempt pin validation, returning only a
Guard approval projection. Effectful LSP/DAP/REPL launches remain disabled pending P1/P4
integration and OS-enforcement acceptance.
### 2026-10-20 — implementation wave: P4 partial handoff and P6 started

P4 returned `PHASE_PARTIAL` after adding the Core Config → HostKernel trusted launch-profile
projection, strict Attempt envelope and protocol-input validation. LSP/DAP/REPL process effects
remain unavailable pending P1 Guarded protocol journaling/transport and OS resource enforcement;
the authenticated RepoIntel document-read ingress also depends on P3. P6 is now assigned as a
whole-phase owner for providers, settings, offline/live-consent Doctor surfaces and S1. P1 and P8
continue whole-phase implementation; P2/P3/P7 await available child slots. Parent-owned P5 remains
disabled pending P1/P6 Guard and SecretBroker evidence. No validation or live provider request
was run under the implementation-first instruction. All work is inside `agentx`; V1 remains
PARTIAL / NOT RELEASED.

15:25 UTC source update: P8 added an inert cache observation receiver with HostKernel-only
private provenance and monotonic owner epoch/sequence/freshness fencing; it keeps accounted source
size distinct from measured allocation. HostKernel ingress and P3 cache caller/eviction callback
remain absent. P6 added typed `NoModelsError` when OpenCode or an eligible free model is missing,
then returned PARTIAL; credentialed search awaits P1's confirmed metadata-only projection. The
released slot is assigned to whole-phase P7 (stream/replay/rendering/artifact/analytics/automation/
checkpoint). Active owners are P1/P7/P8; P2/P3/P6 continuation remain queued. No validation ran.

15:28 UTC P8 additionally corrected RC0 unsupported-platform reporting: macOS and other
unsupported systems are no longer mislabeled as native Windows. Source fixture added, unrun.
Authenticated cache ingress remains blocked on P1 HostKernel mint/transport and P3/Core event and
generation-release integration; P8 remains active on independent resource/recovery source work.

15:30 UTC P8 settlement correction: VERIFIED worker proof now requires a bounded, nonempty
durable usage-accounting chain; optional failure/quarantine usage summaries are validated; and the
proof digest binds the full summary under a v2 domain. P2 must consume the source contract for
managed finalization. No tests/builds were run.

15:32 UTC P8 returned `PHASE_PARTIAL`; cache and settlement recovery depend on authenticated P1
mint/RPC, P3 event/callback composition, and P1/P2 verifier/quiescence/final-Inspect integration.
OS quotas and RC0 release attestation remain unavailable. Whole-phase P3 now owns RepoIntel source
implementation. Active owners are P1/P3/P7; P2/P6/P8 follow-up remains queued. No validation ran.

15:36 UTC P7 returned PARTIAL after implementing the TUI automation manager's missing read-only
contract fields. Checkpoint operations remain unavailable pending P1 workspace/VCS observations
and Guarded HostKernel operations; artifact reads await P1 handlers and trusted Attempt resolution.
The slot is assigned to resumed P2 managed vertical source implementation, including P8 durable
usage-accounting settlement composition. Active owners: P1/P2/P3. No validation ran.

15:39 UTC P2 closed the usage-proof projection seam in managed completion/candidate/recovery
decoders. It checks bounded metrics, nonzero cursor/receipt counts, receipt_count ≤ cursor ≤
managed revision and complete lowercase BLAKE3 ceiling/chain digests before accepting the P8
summary. Managed finalization remains gated pending P1 verifier/quiescence and P8 settlement
recovery. P2 continues whole-phase source work; no checks ran.

15:41 UTC P1 source-hardens RepoIntel continuation: any cursor is rejected before Location
lookup or source snapshot collection, and P3 omits cursor output until authenticated cursor leases
exist. P1 also sent P6 the fixed Brave transport tuple (GET, `x-subscription-token`); P6 must
support only that exact provider profile and preserve rejection of arbitrary methods/headers.
Unfinished verifier journal entries remain UNKNOWN after fresh process restart because quiescence
cannot yet be proven; verifier and other effects remain disabled.

15:44 UTC P2/P1 found a cancel race where provider completion after transition to CANCELLING
can lose its usage receipt under a RUNNING-only guard. P2 is adding a receipt-only reducer
allowance in CANCELLING; P1 owns the matching narrow HostKernel `record_usage` allowance, without
authorizing coding effects. P1 protocol journal, verifier quiescence, durable BYO receipts and
authenticated cache mint remain unimplemented/gated. No checks ran.

P3's current source pass adds bounded lexical candidates over immutable HostKernel generations,
with byte-accurate ranges, file digests and deterministic node IDs; parser-unsupported/partial
status remains explicit. Overlays and semantic definitions stay unavailable without trusted source
owners. Both Core and HostKernel reject unauthenticated cursors; continuation pages await P1's
owner-bound cursor lease. No validation ran.

15:47 UTC P1/P2 integrated the usage/cancel fix: during CANCELLING, `record_usage` tolerates
only the one expected revision increment from RequestCancel; HostKernel derives its current
revision for the durable usage proof/CAS. General effects still require exact RUNNING authority.
Source only; unverified.

15:49 UTC source refinement: P1 accepts equal revisions only in RUNNING; CANCELLING receipt
append requires the captured scope to precede current Rust state by exactly one RequestCancel
revision. P2 caps receipt-chain decoding at 4,096 entries. This remains unverified.

15:51 UTC P2/P3/P7 returned PARTIAL after their source-only progress. P1 resumed the full Guard/
ExecutionHost phase including protocol IO journaling, verifier/quiescence, BYO receipts and cache
minting; P6 resumed on the confirmed metadata-only SecretBroker/provider path; P8 resumed cache and
settlement recovery integration. Active owners are P1/P6/P8. P2/P3/P7 resume on dependency arrival
and final acceptance. No validation ran.

15:55 UTC P5's production capability now has a gated HostKernel metadata-authorization callback,
but no aggregate-route integration or network dispatch. P6 added a strict local SecretBroker
ProviderTransport adapter for the exact approved route profile (including Brave GET plus
`x-subscription-token`); P1's durable per-route intent/dispatch/receipt and Guarded sender still
block execution. P8 excludes pinned cache entries and reports physical bytes UNKNOWN without an
authenticated process sample. No validation ran.

15:58 UTC P6 returned PARTIAL after strict projection decoding and in-process SecretBroker lease
consumption source were added. The adapter supports fixed provider profiles, has no caller-provided
network sender and is not wired; P1's durable per-route receipt path is required. P4 resumed to
integrate Core LSP/DAP lifecycles against P1's HostKernel journal. P8 binds worker samples to the
durable child source revision and keeps pinned-cache/unknown-allocation states honest. Active
owners: P1/P4/P8. No validation ran.


## 2026-10-20 15:50 UTC — P1–P8 implementation continuation

The user resumed the full P1–P8 source implementation and asked to defer tests/builds/typechecks/audits until implementation is complete. Active whole-phase owners are P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, and P7 streaming/artifacts/automation/checkpoint. P1–P8 remain the full requested delivery target. P2 and P4 returned source-only partial; P3 is queued for a slot; P5 remains parent-owned. P8 returned source-only partial after P1/P8 integrated more source seams.

Current source deltas: P1 added a durable typed protocol IO/event journal and typed LSP reply subject/receipt, all still release-gated; BYO search route attempts now persist PREPARED/DISPATCHING/settled or UNKNOWN, with restart recovery, and P1 is defining the resumable Rust-owned aggregate step needed to retain one cascade state machine. P1 also mints authenticated RepoIntel cache observations and exposes exact HostKernel retirement composition. P2 fixed `goal.start` so it captures the intended root Session before confirmation, and source review confirms immutable AgentProfileV2 child pins plus authenticated Goal/review/start/control TUI paths. P4 binds protocol requests to direct/managed Attempt scope and composes the authenticated RepoIntel reader without filesystem fallback; process effects remain disabled. P8 binds the full five-key usage summary into final-Inspect candidate v2, adds exact Pending/Completed Inspect receipt recovery, keeps source bytes separate from physical allocation, and binds worker source revision into RC0 schema v3. P6 is composing its fixed SecretBroker sender with P1's durable per-route transitions; P7 is continuing full source work.

Remaining source/dependency items: P1 Guard/ExecutionHost and Linux confinement integration, managed verifier quiescence, final protocol replay/recovery and aggregate BYO pause/resume; P2/P8 managed Inspect/settlement wiring; P3 authenticated pagination/cursor and cache lifecycle, plus parser-backed semantics; P4 P1 protocol/launch gates and OS-enforced REPL quotas; P5/P6 one Rust-owned search cascade with SecretBroker route callback, provider/settings/Doctor/S1 source completion; P7 guarded automation/checkpoint/artifact operations; P8 trusted cache pressure trigger/consumer, RC0 HostRun and independent attestation. Effectful paths remain unavailable wherever Guard, receipt, or OS enforcement is not yet accepted.

No tests, builds, typechecks, audits, provider calls or benchmarks were run. This is source status only; no phase is VERIFIED or RELEASED. The shared mixed Git state is preserved; no staging, commit, push or cleanup was performed.


## 2026-10-20 16:00 UTC — P5 bounded response projection and P1/P6 search handoff

Parent added a Core-side structural/UTF-8 size bound for HostKernel web-search response bodies before parsing or retaining provider data (20,000 nodes, depth 24, individual strings 2 MiB, aggregate accounted body 4 MiB); malformed cycles, non-finite values and unsupported values are rejected. This is source-only and web search remains gated. P1 is wiring the durable aggregate cursor to BYO attempt authorization/settlement. P6 is composing the fixed SecretBroker sender through HostKernel begin/settle/UNKNOWN transitions, using a strict DISPATCHING permit and a durable SETTLED receipt. P6 confirmed `resultCount:null` is accepted for HTTP success, leaving semantic parsing in Core. P1 has not yet published the aggregate pause/resume DTO. No checks/builds/typechecks/audits/provider probes ran. P1/P6/P7 remain active whole-phase owners; P2/P3/P4/P8 work is queued for available slots. V1 remains PARTIAL / NOT RELEASED; mixed Git state preserved.


## 2026-10-20 16:05 UTC — P6 source handoff; P2 slot refill

P6 returned PARTIAL after its currently independent source work: provider/model availability and truthful free-route selection, requested/effective settings, offline Provider Doctor/API/TUI, S1 owner-chain projection/filter/callback/mixed-effect denial, provider/model switching, and Auth-owned HostKernel begin → fixed SecretBroker request → settle/UNKNOWN with strict permit/receipt matching. It remains integration-blocked on P1's Rust aggregate pause/resume plus parent P5 wiring; network execution stays unavailable. P2 has resumed as whole-phase owner for managed Task/Attempt, authenticated review/verifier, workspace revision, TUI delivery and lifecycle recovery; P1 and P7 continue. P3/P4/P8 remain queued for slots. Parent P5 added bounded HostKernel response projection and awaits P1's exact cascade DTO before Core resume wiring. No verification ran; source only, V1 PARTIAL / NOT RELEASED.


## 2026-10-20 16:10 UTC — P1/P5 cascade continuation boundary; P2 inbox pagination

P1 has now source-wired the initial Rust aggregate pause: after any earlier keyless routes, it durably links the exact one-use BYO authorization attempt to a HostKernel-owned ordered cursor and returns `WAITING_SECRET` with cascadeRef/Digest, route-plan digest/index, next-route authorization, and prior route receipts. P1 is implementing `resume_search_cascade`; Core must validate/forward P6's exact bounded provider response and durable settled receipt, while Rust retains route/retry/fallback authority. Parent P5 now strictly decodes the bounded continuation envelope and rejects orphaned fields, invalid index/digests, terminal prior attempts, and scope transitions; it currently remains gated and does not yet dispatch/resume the secret route. P2 added bounded on-demand Goal-review inbox pagination via the authenticated cursor, keeping each request capped at 64. No checks/builds/typechecks/audits/provider calls ran. P1/P2/P7 active; P6 source handoff partial; P3/P4/P8 queued. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 16:15 UTC — P2/P7 partial handoffs; P4 resumed; P3 queued

P2 returned PARTIAL after on-demand authenticated Goal-review pagination and the prior root-Session-capture fix; its remaining acceptance is blocked on P1 verifier/effect receipts and P8 final Inspect/settlement. P7 returned PARTIAL after artifact HTTP/SDK/TUI reads, renderer/transcript redaction and bounds, stream fences, artifact fidelity and analytics provenance; automation invocation and checkpoint mutation remain unavailable pending P1-owned Guarded operations/observation DTOs. The freed slot resumed whole P4 to integrate LSP/DAP/REPL clients against P1's protocol journal and finish all independently executable source; process/evaluate/REPL effects remain gated by P1 and OS proof. P1 is implementing `resume_search_cascade` using the agreed Core binary body + P6 durable receipt; it is resolving honest EffectHost transport provenance for non-socket SecretBroker sends. P8 resumed cache/worker source; P3 remains queued because the agent thread limit prevented starting another owner. P5 Core now sends only validated WAITING_SECRET routes to Auth, then exact receipt/body to Rust resume; final integration depends on P1 handler and transport-provenance representation. No tests/builds/typechecks/audits/provider probes ran. V1 PARTIAL / NOT RELEASED; shared Git state preserved.


## 2026-10-20 16:20 UTC — P8 cache seam handoff; P3 resumed

P8 returned PARTIAL after adding exact final-Inspect/usage binding and RC0 child-revision source; P8 reports its HostKernel-retained generation observation/retirement composer is present but unconnected at four HostKernel generation-removal callsites. It also added P8 registry invalidation, but no trusted pressure-policy ingress exists, so no cache eviction trigger is enabled. RC0 remains NOT_ATTESTED until P1 live-peer/workspace evidence and P2 independent verifier evidence; OS resource quotas and fan-out remain unavailable. P3 is now resumed as whole-phase RepoIntel owner to connect authenticated generation pagination/cursor and the P1/P8 cache sink using exact current signatures. P4 is active against P1's protocol journal; P1 continues Guard/ExecutionHost and BYO aggregate resume. P5 Core handles the strict WAITING_SECRET→Auth fixed send→Rust resume loop; it is fail-closed and not yet verified. P2/P6/P7 remain PARTIAL/queued for slots. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 16:25 UTC — P5 authenticated BYO continuation wired in Core source

Parent P5 now validates every Rust `WAITING_SECRET` continuation against the exact next approved route before any secret send, calls P6 Auth with the response authorization plus Rust-minted cascadeRef/Digest and authenticated Attempt scope, checks the returned one-use SETTLED receipt against the bounded response, then calls `execution.v1/resume_search_cascade` with the exact receipt metadata and MsgPack binary body. Continuations are bounded by approved route count; Core never retries provider dispatch and reports UNKNOWN when a continuation cannot be reconciled. Strict response parsing rejects malformed/orphaned cursor fields and terminal prior attempts; source regressions were added but not run. P1 has confirmed `secret-broker-fixed-route` is the existing honest EffectHost receipt provenance for this non-socket transport and is implementing the resume RPC plus cancellation support. P3, P4, P1 active; P8 returned PARTIAL; P2/P6/P7 source handoffs remain PARTIAL/queued pending dependencies and slots. No tests/builds/typechecks/audits/probes ran. Search remains gated and V1 PARTIAL / NOT RELEASED.


## 2026-10-20 16:30 UTC — P3 source seam triage; P1 continuation recovery

P3 reports generation pin/query source exists, but Core currently rejects continuation cursors before Location/source read and HostKernel passes no cursor to indexd. No authenticated opaque cursor lease or Core cache notice/retirement RPC projection is published yet; P3 is continuing all independent Core pagination/cancellation/recovery and cache-consumer interface work without inventing production authority, while P1 owns supervisor/HostKernel seams. P1's BYO resume path cannot yet guarantee same-request replay after a lost nonterminal response; parent requested an authenticated read-only continuation resolver that returns the exact next prepared cursor only after a known settled failure, terminal result-unavailable after successful body loss, and UNKNOWN on ambiguity. Secret bodies will not be persisted/replayed. The existing feature remains gated. No checks/builds/typechecks/audits/probes ran.


## 2026-10-20 implementation checkpoint — P1–P8 (source only)

Whole-phase owner ledger: P1, P2 and P4 active; P3 returned PHASE_PARTIAL; P5 parent-owned; P6/P7/P8 next in queue. P3's independent source is present for bounded cursor inputs/no-progress rejection, descriptor-rooted no-follow repository tree reads with partial coverage, and strict dependency-manifest decoding. P3 remains blocked from release acceptance on P1's authenticated cursor lease and P8's four generation-removal cache invalidations.

P1 added a gated, read-only continuation resolver for lost web-search resume responses. P5 Core now invokes it with the exact Rust cascade digest, route-plan digest, settled receipt digest and authenticated Attempt after a transport loss; the provider is never retried by Core. Parent review found a remaining route-history append bug and BYO-to-keyless mixed-order continuation gap, assigned to P1. Search remains disabled.

Implementation-first constraint remains: no validation ran. The repository is dirty with broad mixed ownership, unstaged changes and new files; no stage/commit/push/cleanup is safe. Product status is HorizonCode V1 PARTIAL / NOT RELEASED.


16:35 UTC P5 continuation recovery update: Core now calls `inspect_search_cascade_continuation` after a lost `resume_search_cascade` response, carrying the exact settled receipt and authenticated HostKernel Attempt scope. It accepts only the resolver's Rust-owned next prepared route or receipt-only terminal/UNKNOWN result; it never repeats the provider request. This is source-only and remains behind the release gate. Parent assigned P1 three source-review fixes: append the current settled route (not the first history item), safely handle/reject mixed BYO→keyless order before any post-dispatch uncertainty, and support the documented direct Core Attempt receipt owner.

16:36 UTC P4 reports source for shared execution.v1 LSP/DAP clients with authenticated Attempt pins, bounded replay/correlation, serialized dispatch, Guard lease per outbound operation, quarantine on uncertainty, and strict callback validation. DAP attach/evaluate and all process effects remain unavailable pending Guard/confinement proof; REPL remains unavailable pending P8 OS quotas. P4 continues its whole phase. No checks ran.


## 2026-10-20 — P1/P6/P8 continuation; P7 refill; P5 response-loss correction

The requested P1–P8 implementation remains source-only and incomplete. Active owners are P1 Guard/ExecutionHost, P8 resource/worker/cache, and P7 streaming/artifacts/analytics/automation/checkpoint (the completed P6 source pass released its slot to P7); P5 remains parent-owned. P2/P3/P4 have source-only partials and remain in the refill queue for integration after their prerequisites land.

Parent review found and corrected a P5 initial-response recovery defect in `packages/opencode/src/tool/websearch-runtime.ts`: successful exact-pin `inspect_search_cascade` recovery now feeds the existing continuation loop; failed/missing reconciliation still returns UNKNOWN without redispatch. P8 is implementing an independently durable post-settlement worktree disposition transition; Core/P2 settlement projection remains a follow-up. P6 removed the unsafe byte-to-secure-handle export and documented credential put/revoke/live Doctor as unavailable pending protected native input and a Guarded authenticated write contract.

No tests, builds, typechecks, audits, provider calls, benchmarks, or Git publication ran. Feature gates remain closed where Guard, receipts, independent verification, or OS enforcement are incomplete. The shared Git state remains dirty with no staged changes; only the repository tree was inspected. V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P1 terminal admission correction; P7 resumed

P1 fixed a source-level shell interpolation denial: user-action and ToolBatch consent projection had assessed residual `no_symlink/no_hardlink`, which are outside Guard's broker-process guarantee set. Those checks now use the exact configured executable/profile, bounded argv/environment, workspace-root confinement, sandbox and one-use dispatch preflight before projecting an empty residual. Denied/no-spawn behavior is unchanged; no test was run.

The released P6 slot is active on whole-phase P7. P7 is closing independent Core/TUI source gaps and recording the remaining Guarded automation and checkpoint operations that depend on absent authenticated HostKernel contracts. P1 and P8 continue their entire phase source work. No tests, builds, typechecks, audits, provider calls, benchmarks, staging, commit, or push were performed.


## 2026-10-20 — P7 analytics correction; P2 phase resumed

P7's independent source review found that the SVG raster port emitted `ui.artifact.raster_cache_entries`, but TUI analytics discarded the entry-count gauge while retaining cache bytes. The aggregation now includes per-renderer entry counts with stale-sample rejection and disposal cleanup; the source fixture and §31.17 status were updated. P7 reports stream replay/fencing, bounded redacted rendering, artifact truth/reads, question event filtering, and analytics allowlisting source-present. Automation invocation and checkpoint/rewind mutations remain unavailable pending P1 Guarded effects and trusted same-revision filesystem/VCS observations. No checks ran.

The freed P7 slot is assigned to resumed whole-phase P2 managed lifecycle/verifier integration; it is continuing Core/TUI source work while P1/P8 dependencies land. P1/P8 remain active. P3/P4 are still queued. All phases are source-only; V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P2 exact dirty-revision settlement projection

P2 now accepts verifier-pinned final Inspect at the exact frozen revision when the observed worktree is `CLEAN` or `DIRTY_OWNED`, while still requiring an owned, no-follow snapshot with no user-owned changes. It rejects contradictory dirty-count/status facts. `DIRTY_OWNED` completion requires P8's durable `WORKTREE_QUARANTINED` disposition; Core's normal settlement and terminal recovery projections preserve that disposition for the TUI. P2 updated §37.22. P8 is implementing the Rust durable disposition receipt and transition; P2 remains PARTIAL pending P1 Guarded verifier/recovery and P8 integration. No validation ran.


## 2026-10-20 — P2 managed source integration audit

P2's resumed source audit confirms the current Core/TUI path derives distinct reviewers from ServerAuth, rejects proposer self-review, fences decisions by exact Spec digest/revision, exposes authenticated Goal proposal/review/plan/start/control actions, and binds the root Session to principal/workspace. Managed Task dispatch carries Rust-projected AgentProfileV2 pins and ManagedAttemptScope into ToolBatch; only one direct or managed Attempt authority is accepted per effect, with refresh limited to HostKernel revision transitions. Restart recovery does not retry ambiguously consumed prompts; cancellation persists the Rust fence before interrupting the exact child. P2 added the DIRTY_OWNED exact-revision settlement/quarantine rule to §12.19/JC-RES-021. These are source facts, not acceptance. Remaining P2 source integration depends on P1 Guarded coding/verifier/final Inspect and durable verifier receipts/replay plus P8 Inspect/settlement and terminal recovery. No validation ran.


## 2026-10-20 — P1 generation invalidation; P2 recovery source reconciled

P1 added cache invalidation before known HostKernel RepoIntel lease/generation drops, using the exact retained cache key/parser-set identity; expiration cleanup uses the same helper. A registry pin/invalidation failure now aborts before dropping the generation. Trusted pressure-trigger wiring remains unresolved and stays unavailable unless the P8 consumer can accept an authenticated sample without claiming unsupported OS limits.

P2 found that §37.22 still listed same-challenge replay and terminal settlement projection as gaps although current source has exact `managed_final_inspect_replays`, fresh-challenge/full-Core-restart receipt resolution, and authenticated `managed.settlement_recovery` from terminal OwnerLog. It documented those source paths as present and superseded the stale gap statement. These remain unverified. P2 continues source integration against P1/P8; no validation ran.


## 2026-10-20 — P8 authenticated pressure and settlement contracts

P8 supplied P1 the exact pressure consumer contract: a HostKernel-minted owner-matched `AuthenticatedResourcePolicyPinV1`, a `sample_owned_resources` snapshot bound to authenticated owner/Core identity, sample sequence/time, OwnerLog cursor and WorkerPool revision, and authenticated owner context. Only measured PSS can produce the bounded hysteresis signal. The signal is advisory only; it does not enforce OS limits, authorize eviction, terminate processes, or release leases. P1 is evaluating/wiring this at authenticated ingress. Cache eviction remains disabled until a trusted trigger and generation-safe callback exist.

P8 says its new durable settlement receipt is exposed through Core/P2 with exact Goal/Run/Task/Attempt/worker IDs, disposition, proof digest, OwnerLog ID/sequence/event digest, worker-pool revision and receipt digest; P2's strict decoder binds those fields. Exact DIRTY_OWNED final Inspect requires `WORKTREE_QUARANTINED`; CLEAN reusability follows P8's full predicate. This is source integration only, not tested.


## 2026-10-20 — P2 phase handoff; P3 RepoIntel resumed

P2's independent source pass is exhausted and returned PHASE_PARTIAL. It also changed the TUI to reject Run plans containing anything other than one coding Task before the API call; Rust remains authoritative. P2 source notes now reconcile the exact `DIRTY_OWNED` final-revision evidence/quarantine rule, P8 receipt fields, and existing replay/terminal settlement recovery paths. No checks ran.

The released slot is assigned to whole-phase P3 RepoIntel (Core/indexd/Tool/TUI), to connect authenticated generation pagination and P8 cache lifecycle where exact contracts exist, and finish all independent tree/detect/document-read/fencing work. P1/P8 remain active; no validation or Git publication was performed.


## 2026-10-20 — P1 raw grep/glob process origin fenced

P1 found that `packages/core/src/ripgrep.ts` executed configured `rg` via raw `AppProcess.spawn`; HorizonCode and OpenCode-derived grep/glob tools reached it without HostKernel Guard/ExecutionHost leases. A false-by-default gate now fails before binary resolution/command construction/spawn until a HostKernel-backed read service is wired. This closes the raw process effect path with honest unavailability; P3 can provide a guarded indexed/read implementation later. No tests ran.


## 2026-10-20 — P8 separate disposition durability and truthful metadata

P8 added source for a disposition OwnerLog round-trip/required-epoch regression (not run) and corrected worktree `has_untracked` projection: nonreusable due to dirty tracked or user-owned content no longer implies untracked files. Quarantined disposition now leaves untracked status unknown; only verified clean reuse records `false`. §21.13 documents independently replayable reservation settlement and worktree disposition, with crash-pending lease ownership retained. P1 owns HostKernel settle/recovery call-site wiring; P8 continues the phase. No validation ran.


## 2026-10-20 — P8 source handoff; P4 resumed

P8 returned PHASE_PARTIAL after implementing its separate durable reservation-settlement/worktree-disposition transitions, exact disposition and pending-state projections, crash-pending quarantine/lease retention, dirty-worktree truthfulness, bounded advisory pressure tracking, and an unrun OwnerLog replay regression. OS-enforced worker limits remain unsupported; RC0 remains release-ineligible without trusted attestations. P1 owns the HostKernel settle/recovery projection wiring; changed-epoch recovery needs fresh authenticated root/Inspect plus P2 terminal proof.

The freed slot is assigned to whole-phase P4 LSP/DAP/REPL continuation, finishing independent Core lifecycle/protocol/profile work while P1 Guard and P8 OS enforcement remain prerequisites for effectful paths. Current active whole-phase owners: P1/P3/P4; P2/P6/P7/P8 are partial and will resume when dependencies/slots permit. No tests, builds, typechecks, audits or Git publication ran.


## 2026-10-20 — RepoIntel cursor and deferred disposition recovery boundaries

P3 identified that authenticated continuation cursors still lack a HostKernel lease DTO/service. P3 is implementing Core client/schema plumbing while keeping page continuation fail-closed; it must not infer or accept a model-supplied generation. P1 now owns the HostKernel lease: mint from authenticated first-page scope and bind principal/Session/Location/epoch/workspace root/generation/revision/canonical query digest/expiry/cancellation; resolve and remeasure read policy before continuation source reads.

P8's separate disposition receipt currently lacks an immutable original owner-epoch accessor. P8 is adding that P8-owned pin/API. P1 will attempt same-epoch `settle_dispatch` recovery only from HostKernel's exact pre-admission epoch; after disposition completion it returns the full settlement receipt. Any epoch/proof mismatch stays pending/conflict; Core never supplies epoch authority or treats it as terminal success. Cross-epoch release requires fresh authenticated Inspect and quiescence proofs. No validation ran.


## 2026-10-20 — P1/P3 recovery and cursor integration source seams

P1 wired same-epoch `settle_dispatch` recovery to query P8's pending disposition, compare P8's immutable settlement owner epoch to the current HostKernel FrameFence epoch, complete only the exact pending disposition, require a durable receipt, then pass through the ordinary strict resolver for `SETTLED`. Missing epoch, mismatch, or unresolved receipt remains UNCERTAIN. It depends on P8 landing the `managed_settlement_owner_epoch_for_attempt` wrapper; no cross-epoch recovery is enabled.

P3 added capability-gated Core cursor lease plumbing: strict token bound, first-page generation pin vs continuation token, no `sourceGeneration` on continuation, and authenticated RepoRead plus interrupt cancellation. Runtime remains unavailable until P1 HostKernel mints/resolves the authenticated lease. P3 is checking existing parser/index integrations for remaining semantic source work. No validation ran.


## 2026-10-20 — P8 immutable settlement epoch pin landed

P8 added `managed_settlement_owner_epoch_for_attempt(attempt_id)` derived from immutable `TrustedPreAdmissionPinsV1.owner_epoch()`. The disposition receipt now carries and digest-binds `owner_epoch`; OwnerLog requires a positive value and replay validates it against exact admission pins. Same-epoch completion also checks `self.resumed_epoch == pinned admission epoch` internally. P1's `settle_dispatch` uses this exact getter before it can complete pending disposition and project SETTLED. No validation ran.


## 2026-10-20 — P4 typed read errors; P2 settlement-receipt consumer resumed

P4 fixed LSP document-open/change to preserve typed RepoIntel stale-revision, oversized and out-of-scope errors instead of collapsing them into generic reader failure; no document text is sent after a read failure. LSP/DAP/REPL process and protocol routes remain hard-disabled until P1 Guarded process IO/confinement and OS acceptance; editor ingress and P3 read-document acceptance remain open. P4 returned PHASE_PARTIAL.

P1 approved adding an exact nested P8 `worktreeDisposition` receipt to ordinary `SETTLED`, with immutable owner epoch, final worktree operation/host receipt, observed revision, Inspect receipt, OwnerLog cursor, pool revision, settlement receipt digest and final receipt digest. The P2 whole-phase owner is resumed to update the strict decoder/TUI projection when P1 lands the Rust shape and continue any remaining source integration. P3 is implementing indexd page advancement (`RepoStructurePositionV1` as a non-authority anchor); P1 is reviewing its exact DTO before HostKernel lease integration. No validation ran.


## 2026-10-20 — P1 approved P3 indexd paging anchor

P1 approved P3's internal RepoIntel paging adapter with an exclusive last-emitted position `{path_ref, symbol_index, byte_offset}`, ordered by BTreeMap path and selector order; `byte_offset` is a UTF-8 byte offset. `next_position` exists only while more matches remain and carries no authority token. HostKernel must resolve the opaque cursor before source reads, remeasure workspace and current Guard read grant, and mint the next opaque lease bound to exact generation/revision/query. P3 is implementing the indexd/Core side; P1 owns HostKernel lease wiring. Feature stays unavailable until both are integrated. No validation ran.


## 2026-10-20 — P1 final P8 disposition receipt wire shape landed

P1's Rust source now includes an exact nested `worktreeDisposition` object in the ordinary top-level `status=SETTLED` response. Fields are `ownerEpoch`, `disposition` (`REUSABLE`/`QUARANTINED`), settlement receipt digest, final worktree operation/host receipt, observed revision, Inspect receipt digest, OwnerLog ID/sequence/event digest, worker-pool revision and final receipt digest; all are string projections from the durable P8 receipt. P2's resumed owner is wiring the strict Core decoder/TUI projection. No tests ran.


## 2026-10-20 — P1 authenticated RepoIntel cursor; P2 disposition consumer; P4 resumed (source only)

P1 added a HostKernel-owned opaque `repo_cur_<64hex>` one-use continuation lease. Its stored
pins bind authenticated principal/Session/Location, FrameFence owner epoch, the original
RepoGeneration lease key, workspace root/revision, source generation, canonical selectors and
limits, P3's internal page position, and expiry. HostKernel resolves the lease before obtaining
a Location snapshot, then rechecks current Guard `files.read`, workspace/revision and query
policy. Consume, cancellation, stale policy/revision, generation retirement and process restart
fence the token. The protocol feature remains false and `hz-kernel` does not advertise it; this
is not enabled or verified. P3 owns Core/indexd pagination, P1 owns the Rust lease.

P2 completed its source-only consumer for P8's nested `worktreeDisposition` receipt: strict
Core decoding, control-plane/SDK shape, TUI preservation/display, and recovery fixture now bind
all exact receipt fields and the outer settlement. P2's remaining managed lifecycle depends on
P1's Guarded verifier/output/quiescence and fresh-process UNKNOWN interface; phase acceptance
was not claimed. Its slot is assigned to whole-phase P4 LSP/DAP/REPL source integration.

Current active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P4 LSP/DAP/REPL. P5
remains parent-owned; P2/P6/P7/P8 are in the refill queue. Implementation-first hold remains:
no tests, builds, typechecks, audits, live provider calls, or benchmarks ran. Existing mixed Git
state is preserved. HorizonCode V1 remains PARTIAL / NOT RELEASED.


## 2026-10-20 — P2 P8 receipt digest binding corrected; P4 implementation continues

Parent's source-only integration review found that the Core P2 decoder equated the P8
worktree-disposition receipt's own domain-separated `receiptDigest` with the logical settlement's
`settlementReceiptDigest`. Rust intentionally computes these as distinct digests. P2 fixed the
decoder and recovery fixture: both digests retain independent BLAKE3 validation, while only
`worktreeDisposition.settlementReceiptDigest` is bound to the outer logical `receiptDigest`.
This correction and its fixture have not been run. The same owner has shifted to whole-phase P4
source work after finishing independent P2 integration. P1/P3/P4 are active; P2 acceptance
remains gated on P1 Guarded verifier/quiescence and final integration. No validation ran.


## 2026-10-20 — P3 bounded-page progress; P4 dependency queue; P6 resumed

P3 found and corrected a pagination liveness defect within the approved exclusive-last-emitted
position contract. When a file suffix exceeds the remaining page byte budget, indexd now records
partial/truncated coverage and continues to later files instead of stopping the page; it mints
`next_position` only after a real extra matching occurrence proves continuation progress. This can
omit occurrences in an over-budget suffix and therefore remains explicitly PARTIAL; it does not
loop or claim complete coverage. RepoIntel remains feature-disabled pending integration acceptance.

P4 reports its independent source pass exhausted: typed LSP/DAP protocol clients and authenticated
RepoIntel document reads are present, but production process lifecycle lacks the P1 Guarded
ExecutionHost prepare/launch/IO/cancel/status API and Core one-use approval adapter. Process, DAP
attach/evaluate and REPL remain unavailable; REPL also lacks supported OS CPU/memory/process/FD
limits. P4 is queued for immediate resume when P1 lands its interface. The released slot is now
assigned to whole-phase P6 Provider/Settings/Doctor/S1 source implementation.

Active whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel, P6 Provider/Settings/Doctor/S1.
P4 is PARTIALLY_BLOCKED on P1; P2 is PARTIALLY_BLOCKED on P1 Guarded verifier/quiescence and
P8 final Inspect/settlement integration; P5 remains parent-owned; P7/P8 await slots/dependencies.
No tests/builds/typechecks/audits/provider calls/benchmarks ran. HorizonCode V1 remains PARTIAL /
NOT RELEASED.


## 2026-10-20 — P3 cursor/tree source wired; semantic/cache gaps retained

P3's source now wires Core cursor schema/call DTO to P1's opaque HostKernel lease, generation
retirement/cancellation removes cursors, and indexd consumes the approved internal position.
The per-page byte-budget overflow path skips over-budget suffixes with truthful partial status
and keeps scanning later files; focused regression source was added but not run. `repo_tree`
has bounded no-follow listing/cancellation and truthful coverage metadata; `repo.detect` and
authenticated `read_document` are source-present. Cursor capability remains disabled pending
acceptance. P3 still lacks parser-backed definition/reference semantics and a trusted immutable
editor-overlay producer; these must remain unavailable unless compatible existing pinned source
and canonical ownership can be established. Cache lifecycle depends on P1/P8 generation hooks.
No checks ran.


## 2026-10-20 — P6 source audit complete; P7 resumed

P6's fresh source audit found no additional safe standalone source change: OpenCode is filtered to
active/free models at default selection, runtime rejects credential-bearing/custom-loader models
before SDK construction, and offline Doctor is authenticated, sanitized and zero-network. P6 remains
PARTIAL / NOT VERIFIED because no acceptance was run; credential put/revoke needs protected native
input plus a Guarded capability, live/full Doctor and catalog action await P1, and search cascade
acceptance depends on P1/P5. No provider calls or validation ran. The freed slot is assigned to
whole-phase P7 streaming/rendering/artifact/analytics/automation/checkpoint source work.


## 2026-10-20 — P1 process lifecycle gate and post-launch cleanup source

P1's source audit confirmed the existing LSP/DAP process path uses HostKernel profile resolution,
Guard challenge/one-use lease, EffectHost durable dispatch/receipt, exact executable/workspace
pins, one StdioExecutionSupervisor, and `horizoncode-sandbox` prepared confinement. P1 added a
false-by-default LSP/DAP lifecycle gate at profile approval, prepare and launch, and attempts
HostProcessRef cancellation if process start succeeds but protocol-journal registration fails.
The Core approval adapter is not yet composed; protocol effect gate remains false and no runtime
acceptance has been run. P4 received the exact launch/protocol DTOs and will resume integration
when its current P7 continuation releases the slot. No checks ran.


## 2026-10-20 — P7 artifact-reference bound; P4 resumed against P1 DTOs

P7 fixed a source-level artifact decoder gap: `ArtifactRef.byteLength` now rejects decimal values
above `u64::MAX`, and §31.18 records the bound. P7 otherwise reports source present for stream
sequence/source-generation fencing, activity route, bounded redacted rendering, analytics,
artifact reads/verified-scope plumbing, Rust automation journal and read-only checkpoint view.
P7 remains PARTIAL because Guarded automation invocation, checkpoint capture/restore and managed
verifier artifact settlement need P1/P2 trusted effects/evidence; integrated UI/reconnect/render/
artifact recovery journeys are deferred to the later verification stage. No checks ran.

P1 has now published the exact HostKernel LSP/DAP launch/protocol DTOs and an off-by-default
editor process lifecycle gate, with post-spawn cancellation on failed journal registration. The
freed P7 slot is assigned to resume P4's Core supervisor/approval adapter and typed lifecycle
integration in P4-owned files. P4's effects remain disabled until acceptance.


## 2026-10-20 — P3 source handoff; P8 resumed on freed slot

P3 returned PARTIAL after source wiring Core/indexd cursor pagination to P1's opaque HostKernel
lease, authenticated tree/detect/document paths, generation invalidation, and partial-over-budget
page progress. Its in-repo pinned-source gap check found no compatible semantic index: OpenCode's
Tree-sitter use is shell parsing/highlighting, and OMP parser dependencies are excluded by §42.11.
Semantic definitions/references and authenticated immutable editor overlays remain unavailable;
cursor feature remains disabled pending acceptance; authenticated pressure-triggered cache
eviction remains unavailable. A focused indexd regression was added but not run.

The released slot is assigned to a fresh whole-phase P8 resource/worker/cache owner to finish the
remaining independent Rust source integration. It must preserve unsupported CPU/memory/process/FD
OS limits as unavailable and keep pressure advisory-only. Active owners: P1, P4 and P8. P6/P7/P3
source passes are PARTIAL; P2/P4/P7 acceptance remains dependent on P1/P8. No checks ran.


## 2026-10-20 — P8 identified shared RepoIntel generation invalidation defect

P8's source review found that P1's HostKernel cache invalidation helper currently retires a
`(principal, workspace, source_generation, build_version)` key on each per-request lease removal,
even when sibling leases still retain that generation. `ensure_repo_generation` can also replace
an identical lease key without explicit old-generation retirement. P1 owns the HostKernel fix: retire
only when the final authenticated lease and Arc owner are gone, and prevent overwrite leaks; P8
provides the retention invariant/API and does not edit P1 files. Cache eviction stays disabled
without trusted pressure policy/callback. This is source review only; no checks ran.


## 2026-10-20 — P1 shared-generation cache retirement race fixed in source

P1 changed HostKernel RepoGeneration lease handling to pin parser-set/build version and file
count; exact-key retry reuses its Arc and refreshes expiry, conflicting replacement fails, and
new leases for the same owner/workspace/source-generation/build-version reuse the shared Arc only
when source revision, Guard policy digest and owner epoch agree. Removing a lease preserves the
shared cache observation while sibling leases exist; final removal requires no active external
Arc owner and successful P8 invalidation, otherwise the lease/Arc remains. Cache observation also
checks current owner epoch and exact parser set. Source-only, not tested.


## 2026-10-20 — P1 extension-origin subworker; P4 lifecycle adapter progress

A bounded P1 subworker is now implementing the plugin/MCP/hook effect-origin closure in its
exclusive Core extension files, while the P1 phase owner remains accountable for Guard and
HostKernel. Existing contracts are used where exact; otherwise effectful dispatch must be gated
false before action. No overlapping Rust/Auth/search/supervisor/TUI edits or validation are allowed.

P4 now exact-decodes Rust launch-profile identity plus consent fields (`inputDigest`, expiry,
targets, normalized targets, policy summary and full approval/residual guarantee assessment),
checks bounded shapes and target equality, and has added a shared-supervisor adapter using the
existing ServerAuth approval Deferred and one-use `resolve_approval` for `language.start` /
`debug.start`. P4 is wiring typed lifecycle RPC calls behind existing false gates. No checks ran.


## 2026-10-20 — Whole-phase source continuation (P1/P2/P4/P7; implementation only)

P1's current source pass confirmed HostKernel terminal/stdio launch is mediated by the retained confined process, Guard one-use lease and durable intent. It is now closing further subprocess origins discovered in Core Git, configured formatters, legacy snapshots, and CLI utility probes; those paths stay unavailable unless exact HostKernel mediation exists. Guarded verifier dispatch remains false because verdict/output recovery is not safely durable after a possible crash.

P2's source pass confirms the authenticated managed review/start, AgentProfileV2-pinned Task scope, per-step usage accounting, cancel fencing, evidence/final Inspect, TUI command mounting and P8 disposition decoder. Its independent source work is exhausted; integrated P2 remains gated on P1 verifier/quiescence/UNKNOWN recovery, P8 final Inspect settlement, and later acceptance. P2 recorded the exact adapted OpenCode/Codex child-lifecycle patterns in the provenance register.

P4 added a Core approval → prepare → launch adapter, typed bounded protocol read/cancel/status decoders, and reconciled the exact P1 consent DTO. It continues with LSP/DAP service installation and policy integration; all effectful process/protocol paths remain disabled pending Guard/confinement and platform proof.

A whole-phase P7 owner is now active on streaming, rendering, artifacts, analytics, automation and checkpoint/rewind source work. Existing P7 effectful automation/checkpoint/artifact settlement paths remain unavailable where authenticated P1/P2 contracts are absent.

P5 source already contains the approved ordered built-in/free and user-enabled route cascade, route controls, auth-failure fallthrough, bounded retry/cooldown provenance, SecretBroker handoff, and HostKernel aggregate/recovery continuation. P5 remains runtime-disabled pending P1/P6 Guarded transport and reconciliation integration. P3/P6/P8 source work is partial; remaining items are the documented semantic-index/editor producer, protected credential workflows/live probes, and trusted pressure/OS enforcement/attestation dependencies.

No tests, builds, typechecks, audits, benchmarks, provider calls, staging, commits, or pushes ran. The implementation-first hold remains. Existing mixed Git state is preserved. HorizonCode V1 P1–P8 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Next: continue P1/P4/P7 source work, refill newly free whole-phase slots for remaining P3/P6/P8 integration, then complete all implementation before the requested verification phase.


## 2026-10-20 — P1 subprocess closure and P4 lost-launch recovery seam

P1's source sweep hard-disabled unmediated Core Git, configured formatter and legacy Snapshot effects; removed pre-kernel spawnSync probes (sysctl, PowerShell, ldd) from the CLI launcher, leaving only the bootstrap process spawn with fixed argv/stdio. No checks ran. Guarded verifier and unsupported process routes remain unavailable.

P4 identified that an accepted editor-process launch whose reply is lost cannot currently recover the HostProcessRef from execution.v1/status; a RUNNING status alone is insufficient to bind protocol IO. P1 owns the Rust status/recovery projection. It must either return the exact original reference with same-epoch and full execution/effect/challenge/location/profile binding, or return typed unavailable and cancel/quarantine. P4 keeps the protocol route disabled and will not fabricate or retry a reference.

P1/P4/P7 are the active whole-phase owners. P2 source pass is PARTIAL and waiting on P1/P8 gates; P3/P6/P8 have source-partial work waiting for phase-owner slots and/or exact dependencies. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication occurred.


P7 found that HostKernel and authenticated Core HTTP already provide Guarded automation create/update/enable/disable, but the TUI automation manager block still labels those controls unavailable and emits no request. P7 now has exclusive writer ownership of only that `packages/tui/src/app.tsx` block and is wiring CRUD through existing Guard approval. Run invocation remains disabled. Checkpoint preview/capture/restore remain blocked because the exact same-boundary filesystem/VCS observation and Guarded effect contract are absent. Source-only; no tests.


## 2026-10-20 — P1/P4 lost-launch recovery source integrated; P3 resumed

P1 implemented P4's lost-launch-ACK recovery seam in HostKernel. Same-epoch authenticated status now returns only the exact HostProcessRef retained for the running process after matching Attempt scope, principal, frame epoch, Location and effect; it includes pinned profile/executable/generation/kind/epoch and resource guarantees. If protocol/ref recovery fails, HostKernel cancels, marks UNKNOWN, durably quarantines and returns typed recovery-unavailable. Restarted/lost bindings are never reconstructed. Source-only, not tested.

P4's source owner returned PARTIAL after adding approval→prepare→launch, bounded status/read/cancel decoders and protocol binding to existing LSP/DAP clients behind caller Guard authorization. Runtime effects remain disabled pending production installation, P1 Guard/confinement, P3 document-read acceptance, DAP policy and REPL OS limits. P3 is resumed as whole-phase owner for RepoIntel Core/indexd/tool/TUI source integration; semantic parser/editor overlay features remain unavailable absent compatible pinned parser and authenticated immutable producer. Active owners: P1, P3, P7. P2/P4/P6/P8 remain PARTIAL awaiting dependencies and later acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git operations ran.


P1 also removed the unused `CrossSpawnSpawner`/`ChildProcessSpawner` imports and dependency from ToolRegistry after confirming no first-party Core/OpenCode consumer remained. This removes an ambient raw Node child-process implementation from the production tool layer; source-only, not tested.


P1 returned a source-only handoff after HostKernel status recovery, launch-kind alignment, and raw-spawner removal. P1 remains PARTIAL because final integrated source coverage/adversarial acceptance has not run and some effect pathways remain disabled pending acceptance; P1 must be resumed for any new safe source gaps after current phase slots free. Its code is present, not verified. P4 has resumed against the new status DTO; P4 status calls must carry the original direct/managed Attempt scope to recover a retained process reference.


## 2026-10-20 — P3 bounded response fixes; P2 resumed

P3 tightened Core continuation validation: a `nextCursor` is accepted only on a current partial page with exactly the requested maximum count and nonempty nodes, matching Rust's extra-occurrence contract. `repo_tree` now enforces a 32 KiB aggregate UTF-8 output limit while reserving room for truncation/partial notices; source regressions were added but not run. §30 is updated. Semantic definitions/references and editor overlays remain unavailable under §42.11 provenance and missing authenticated buffer producer; cursor runtime remains disabled pending integrated acceptance. P3 returned PARTIAL / NOT VERIFIED.

P2 is resumed as whole-phase owner for managed Goal/SpecVersion/Run/Task/Attempt/review/verifier/TUI lifecycle, using the landed P1 same-epoch process status recovery and exact P8 disposition receipt. It must continue independent source work while Guarded verifier/quiescence and P8 final Inspect recovery remain gated. Active owners: P2/P4/P7; P1 requires source follow-up, and P3/P6/P8 remain partial. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran.


P4 now integrates lost-launch status recovery in Core: after a lost launch reply it requests only exact scoped status and accepts a retained same-epoch HostProcessRef; it never retries spawn. New blocker: per-operation LSP/DAP protocol clients require their own Guard authorize callback, but Core `prepareUserEffect` currently admits terminal capabilities only and Rust rejects editor protocol capabilities. P4 will define the Core-side typed adapter and request the exact capability/lease/receipt contract from P1 while leaving protocol activation disabled. No authorization bypass or invented endpoint is permitted; acceptance must cover approve/deny, stale/replay, cancellation and receipts.


## 2026-10-20 — P7 unblocked source complete; P1 resumed

P7 wired the TUI automation manager to the existing authenticated Guarded create/edit/enable/disable and receipt path, plus a bounded exact-field definition editor. The shared approval dialog now offers `allow_once` for only the exact sessionless ServerAuth workspace-owner lane (`user_action` / `authenticated.user_action`, exact CRUD capability, valid HostKernel Location and full assessed consent); it fabricates no Session/Run identity and preserves all existing binding rules. §37.10/§45.15 and §31.20 status were updated. Invocation remains disabled. P7 also fixed stream seal/cursor eviction and source-generation scope, activity byte accounting, raster-generation fencing/fidelity, and analytics allowlists/live cache gauges; unrun regression fixtures were added. Checkpoint capture/restore and managed artifact settlement remain gated by P1/P2 contracts. P7 returned PARTIAL / NOT VERIFIED; no checks ran.

P1 has resumed on the freed slot for the exact P4 per-operation Guard/lease contract, verifier durable output/quiescence, P8 settlement/Inspect wiring, and remaining effect-origin closure. P2 and P4 continue whole-phase source work. No tests/builds/typechecks/audits/provider calls/benchmarks/staging/commit/push occurred.


P4 supplied the exact per-operation protocol Guard contract to P1: HostProcessRef + Session/Location/workspace revision + exact direct/managed Attempt, protocol sequence/method/payload digest and LSP callback correlation; Guard resolves canonical capabilities and returns a one-use lease, with durable pre-write intent and receipt. Exact replay returns the original receipt without another write; conflicts/stale authority reject; cancellation/crash/receipt loss reconcile to receipt or UNKNOWN/quarantine. DAP attach/evaluate remain denied. P4 owns Core consumers and keeps them false-gated; P1 owns Rust Guard/HostKernel admission. This is the source interface request, not yet implemented or verified.


## 2026-10-20 — P4 operation authorization contract; P8 resumed

P4 added the Core-side `EditorProtocolAuthorizationRequestV1` / lease DTO and ServerAuth-only `authorizeEditorProtocolOperation` adapter. It pins exact HostProcessRef, Session/Location/workspace revision, direct/managed Attempt, protocol sequence, method/command and operation/request digest plus LSP callback correlation; it remains fail-closed until Rust publishes matching per-operation Guard admission and durable receipts. P1 is extending the existing prepare_user_effect/Guard path with canonical method-capability binding, lease consumption and receipt journaling. Production LSP/DAP clients remain uninstalled; no operation is enabled. P4's source owner returned PARTIAL / NOT VERIFIED; further source activation depends on P1/P3/OS gates.

The freed slot is assigned to whole-phase P8 resource/worker/cache source continuation, with exact P1 ownership coordination. P8 may not invent pressure thresholds, enable eviction/fan-out, or claim unsupported OS hard limits. P1/P2/P8 source work continues; P2/P6/P7/P4/P3 remain PARTIAL awaiting dependency and acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git operations ran.


P8 source review found no safe pressure-triggered eviction change: `ResourcePolicyProjection` has no approved lower watermark/calm-window policy, and no authenticated ingress/consumer exists. No values are inferred from soft/hard thresholds. RC0 remains unattested without live P1 HostRun and P2 verifier evidence; OS CPU/memory/process/FD enforcement remains unsupported. P8 hardened its sample timeline so pressure timestamps strictly increase with sequence, added an unrun fixture, and corrected §18.18/cache status. P1 retains exclusive `kernel/src/host_kernel.rs` ownership during its Guard/protocol integration; P8 will not race that shared file. P8 returns PARTIAL pending P1 HostKernel integration, approved pressure policy, OS limits and independent attestation. No checks ran.


## 2026-10-20 — P6 source handoff; active implementation owners P1/P4

P6 returned PARTIAL after confirming current provider/model provenance, free-only model availability, Config controls, offline Provider Doctor, S1 owner-scoped flows and the fixed SecretBroker sender→P1 durable attempt→P5 cascade-resume composition are source-present. No standalone P6 code gap was safe to open without Guard/native consent; live Doctor and credential mutation remain gated, and no checks ran. §16, plan, HANDOFF and CURRENT_RUN are updated.

P8 also returned PARTIAL after strict pressure timestamp ordering; no trusted lower-watermark/calm-window policy exists, so no pressure eviction/fan-out is enabled. P3 and P6 source passes are exhausted. P7 source is complete but awaits P1/P2 gates. P1 is active on protocol-operation Guard/receipts and remaining P1 integration; P4 is active on matching Core lifecycle/protocol consumers; P2 remains queued pending P1 verifier, quiescence and UNKNOWN recovery. P5 remains parent-owned and disabled pending P1/P6 acceptance. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran. Implementable source dependencies remain; HorizonCode V1 P1–P8 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-20 — P1/P2/P4 integration wave active

P1 is implementing the P4 per-operation protocol Guard/lease/durable-receipt path in the existing effects.v2/ExecutionHost boundary, including canonical method→capability checks and same-digest dispatch; no new approval runtime is being introduced. P4 owns the typed Core authorizer/consumer and keeps all protocol routes false-gated. P2 has resumed to consume P1's forthcoming verifier output/quiescence/UNKNOWN DTO and continue managed final-revision verification. Active whole-phase owners: P1/P2/P4. P3/P6/P7/P8 source passes are partial and source-exhausted pending integrated acceptance/dependencies; P5 remains parent-owned and gated. The current runnable dependency chain is P1 Guarded protocol/verifier → P4 LSP/DAP safe wiring and P2 managed verifier; P3 RepoIntel acceptance → P4 document sync; P1/P2 → P7 automation/checkpoint/artifact recovery and P8 RC0. No tests/builds/typechecks/audits/provider probes or Git publication ran.


P1 interface checkpoint (source in progress, 2026-10-20): protocol-operation authorization is being added inside the existing `effects.v2/prepare_user_effect` flow, with strict `ExecutionProtocolAuthorizationV1` arguments, not a new approval endpoint. Guard binds one authenticated direct/managed Attempt, process ref, Session/Location/workspace revision, protocol sequence, typed method/command and operation digest, plus exact retained callback sequence for LSP replies. The ordinary HostKernel challenge → TUI allow/deny → one-use lease is consumed by the existing durable `protocol_op`/`protocol_reply` dispatch journal; replay returns its receipt, ambiguity is UNKNOWN/quarantine. P4 Core is adapting to the proposed DTO. P1 has also begun hardening managed verifier output/evidence recovery; existing managed verifier RPCs remain disabled. These are implementation checkpoints only, not settled wire contracts or acceptance evidence.


Implementation update: P1 will make Rust the sole canonical MessagePack+BLAKE3 producer for `ExecutionProtocolAuthorizationV1.operationDigest`; Core may omit it, and any supplied value must match. HostKernel retains the digest in the Guard challenge and recomputes it at dispatch. P4 is aligning its request/lease DTO and will not hash JSON independently. P2 also added shared strict BLAKE3 validation for managed `challengeSetDigest` across settlement recovery, start/SETTLING, approval resolution and execute result decoding; source-only, not tested.


P1 source clarification: P8's managed final-Inspect path is already present in HostKernel, including exact current revision, candidate-bound approval, guarded git.worktree.list, durable lease/receipt, reconciliation and nested worktree-disposition projection; P2's decoder/settlement consumer is source-present. P2 must not invoke changed-epoch pending-disposition reconciliation as a successful terminal shortcut. Remaining managed verifier gap is process-tree quiescence after abrupt HostKernel death: RunningChild Drop does not kill, stdio handles and process identity are only in memory, so UNKNOWN does not prove descendants are stopped. P1 is investigating the existing sandbox OS process-tree contract; verifier stays disabled unless an OS-owned lifetime/quiescence proof is implemented and later accepted.


## 2026-10-20 — Guarded editor protocol admission source landed

P1 source-landed per-operation LSP/DAP authorization inside existing `effects.v2/prepare_user_effect`. HostKernel strictly decodes `ExecutionProtocolAuthorizationV1`, requires exactly one authenticated direct/managed Attempt, exact same-epoch HostProcessRef/current workspace revision/next journal sequence, derives canonical MessagePack+BLAKE3 operation digest, validates the LSP callback against the exact retained event/request/method, and stores the full canonical DTO in the approved CapabilityBinding. `protocol_op`/`protocol_reply` dispatch now match that retained DTO before durable PREPARED → one-use lease consumption → DISPATCHED receipt; conflicting or stale replay rejects and ambiguous writes fence UNKNOWN. Runtime protocol gate remains false. P4's Core authorizer now sends this exact typed subject and verifies the complete challenge/lease pins before granting the frame lease; P4 is integrating consumers behind false gates. Source-only; no checks ran.

P1's managed verifier remains disabled pending a process-tree quiescence proof and durable typed output/evidence recovery across crash/restart. Plain child kill or UNKNOWN is not sufficient. P1 is evaluating the existing bubblewrap `--die-with-parent` process-tree confinement plus the sandbox guarantee; P2 is preparing the managed verifier consumer against the existing route names while awaiting P1's settled evidence DTO. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication.


P1 source hardening: `horizoncode-sandbox::PreparedExecution::spawn` now arms Linux direct children with `PR_SET_PDEATHSIG(SIGKILL)` and checks the captured HostKernel parent PID immediately after spawn to close the pre-exec race. The confined stdio path already requires ProcessTree=ENFORCED; only bubblewrap currently satisfies that contract, with `--unshare-all`, `--new-session`, and `--die-with-parent` in a fresh PID namespace. P1 updated the guarantee notes, sandbox README and §42 local-source comparison. This is source, not acceptance: verifier/runtime gates remain false until crash/restart quiescence is proven; durable verifier output/evidence is still not recoverable after restart and must remain honest UNKNOWN.


P2 source update: managed verifier artifact-reference decoding now enforces the existing Rust ArtifactStore bounds (≤64 KiB per ref, ≤4 MiB aggregate manifest refs, ≤32 criteria ×64 refs) and preserves BLAKE3 digest validation. Core route callsites already match `begin_verification` → `resolve_verification_approvals` → `execute_verification`, with terminal `settlement_recovery`; no safe adapter can consume the verifier output until P1's durable typed evidence/quiescence DTO lands. P2 remains PARTIAL and is releasing its implementation slot until that DTO is available. No tests ran.


## 2026-10-20 — Managed verifier durable evidence source confirmed; P2 resumed

P1's current source review confirms the verifier already commits exact typed `ObservedVerifierRunV1` plus bounded ArtifactStore refs to managed OwnerLog before returning `SETTLING`. `settle_durable_verifier_evidence` revalidates evidence, current workspace revision, Attempt/profile and receipts; restart recovers the same SETTLING result and refs without rerunning children. Raw output bytes are not durable; a crash before OwnerLog evidence commit remains UNKNOWN/recovery-required, and orphan artifact manifests do not constitute evidence. Exact response binds Goal/Run/Task/Attempt/verificationRun/challengeSetDigest/final+source revision/settlement candidate/evidence digest/artifact refs. P2 is resumed to wire strict Core/TUI decoding and recovery. Verifier stays disabled pending Linux process-tree acceptance and later integration tests.

This supersedes the earlier tracker note that durable verifier output/evidence references were absent: typed verdict/evidence refs are source-present and restart-recoverable after OwnerLog commit; only pre-commit uncertainty remains UNKNOWN. The outstanding security gap is proven OS process-tree quiescence across abrupt kernel death. No tests/builds/typechecks/audits/provider calls/benchmarks/Git publication ran.


P4 source update: Core's editor-protocol authorization lease now retains the exact direct/managed Attempt projection; the LSP/DAP composition comparator normalizes wire BigInt epoch/revision values to canonical decimal strings before exact comparison. §37.6–37.7 now describe composed `prepare_user_effect` → authenticated approval/one-use lease → typed per-operation dispatch and current false gates. Production paths remain unavailable pending P1 Guard/receipt/OS acceptance, P3 authenticated document-read acceptance and production editor ingress; DAP attach/evaluate/variables and REPL remain gated. No checks ran.

## 2026-10-20 — P2 handoff; P4/P7 active; CodeMode redaction source update

Active whole-phase owners: P1 Guard/ExecutionHost, P4 LSP/DAP/REPL, P7 streaming/artifacts/automation/rewind. P2 returned PARTIAL / NOT VERIFIED after its independent Core/TUI verifier/recovery source pass and found no further unblocked source gap. P3/P6 current source passes are PARTIAL; P5 is parent-integrated but disabled; P8 remains PARTIAL.

P7 review found the hidden CodeMode adapter exposed raw nested tool arguments in metadata that may be persisted/rendered. Parent removed raw arguments from CodeMode metadata and updated regression expectations; `.gitignore` now exposes only the exact CodeMode implementation/test paths. CodeMode stays out of the model-visible registry pending P1 Guard mediation. P4 is integrating P3's authenticated document reader into supervised editor lifecycle while dependent protocol gates remain false. No tests/builds/typechecks/audits/benchmarks/provider calls/staging/commit/push/cleanup ran. Repo-only check: 819 GB free; `kernel/target` 627 MB; one worktree; no project build/test process. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — Current owner/dependency refresh (implementation only)

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, and P6 providers/settings/Doctor/S1. P2 resumed after P3 released its slot and avoids P1 HostKernel/P6 inbox-session ownership. P3 is PARTIAL / NOT VERIFIED: `PersistentGenerationStore` is bounded and corruption-aware but has no production caller; authenticated private-root ownership and rebuild integration belongs to P1 HostKernel. P4 remains PARTIAL pending P1 Guard + P3 document-read acceptance; P5 source is present but runtime-disabled; P7/P8 remain PARTIAL/gated.

P6 source now durably records safe-boundary consumption and immutable ACK proof/preimage. P1's HostKernel ACK must allow a fresh authenticated LIVE same-child/profile/permission/epoch/workspace consumer to retry after lost first reply, while retaining the original consumer Attempt and exact message/prompt/receipt/payload proof. Pending capacity is freed only after durable Host ACK receipt storage. P1 owns Rust/§37.9; P6 owns Core/§29.2. Implementation-first hold still applies: no validation, benchmark, provider call, staging, commit, push or cleanup. Latest resource check inside the repo: 819 GB free; `kernel/target` 627 MB; one worktree; no project build/test process. Mixed Git state is preserved. Release remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — Evaluation and CodeMode acceptance additions

`arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` §32.40 now includes HUP-005..006 for deterministic evaluation-runner self-check and paired-arm parity/contamination; §32.41 adds CM-001..007 for future Guarded CodeMode exposure, nested batch admission, privacy, cancellation and recovery. These cases are not executable evidence. The tracked interpreter has extensive language-level tests, but HorizonCode's production registry keeps `execute` hidden and its adapter rejects nested MCP dispatch pending Rust Guard/ExecutionHost. Existing adapter test expectations need reconciliation before the later test wave. `repo_take/jcode`'s QuickJS engine and swarm-core helpers are references only; no second JS runtime is planned. Current active owners: P1, P4, P7. No tests/builds/typechecks/audits/benchmarks/provider calls ran. C: via `/mnt/c` is 95% used with 24 GB free; `kernel/target` 627 MB; one worktree. Mixed Git state remains unstaged and unpublished.

## 2026-10-20 — Evaluation and CodeMode acceptance additions

`arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` §32.40 now includes HUP-005..006 for deterministic evaluation-runner self-check and paired-arm parity/contamination; §32.41 adds CM-001..007 for future Guarded CodeMode exposure, nested batch admission, privacy, cancellation and recovery. These cases are not executable evidence. The tracked interpreter has language-level tests, but HorizonCode's production registry keeps `execute` hidden and its adapter rejects nested MCP dispatch pending Rust Guard/ExecutionHost. Existing adapter test expectations need reconciliation before the later test wave. `repo_take/jcode`'s QuickJS engine and swarm-core helpers are references only; no second JS runtime is planned. Current active owners: P2, P4, P6. P1 completed its current source pass PARTIAL; P7 completed unblocked source work PARTIAL. No tests/builds/typechecks/audits/benchmarks/provider calls ran. C: via `/mnt/c` is 95% used with 24 GB free; `kernel/target` 627 MB; one worktree. Mixed Git state remains unstaged and unpublished.

Latest owner refresh: active whole-phase source owners are P4, P6 and P8. P2 completed its source review PARTIAL; P1 completed its source checkpoint PARTIAL with effects gated; P7 completed unblocked source work PARTIAL. P4 has supervised LSP/DAP compositions plus lifecycle cleanup hardening behind false gates. P6 is implementing exact same-epoch HostKernel prepare-response recovery and has removed the stale original-scope/current-consumer-scope equality check. P8 is active on resource/worker/RC0 work. No validation or provider activity has run.
Added acceptance LM-018 for a later consented OpenCode free-model response and bounded coding task, with exact route provenance, honest 429 handling and no paid fallback. No provider call has run.

Latest phase ownership: P3 RepoIntel, P6 providers/settings/Doctor/S1 and P8 resources/RC0 are active source owners. P4 completed unblocked source work PARTIAL; LSP/DAP/REPL remain gated. P1/P2/P7 are PARTIAL; P5 remains disabled. No checks or provider calls ran.

## 2026-10-20 18:25 UTC — source owners and evaluation inventory

| Phase | Current owner/status | Implementation remaining / evidence |
|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | Continue Guard/origin, HostKernel, confinement, durable effect/recovery source closure. Keep unsupported paths unavailable. No checks run. |
| P2 managed vertical | Active whole-phase owner | Audit Core/Rust/TUI consumer gaps against current P1 receipts/quiescence and finish safe source work. Finalization/fan-out remain disabled. No checks run. |
| P3 RepoIntel | Active whole-phase owner | Tighten cross-field page/source revision, freshness/status, coverage count and bounded document-text schemas; keep unsupported query/process routes unavailable. No checks run. |
| P4 LSP/DAP/REPL | PARTIAL, dependency-limited | Resume when a slot opens; P1 Guard/receipt and P3 document-reader integration, executable/OS support, ingress and real-project acceptance remain. |
| P5 web search | Source present, runtime gated | P1/P6 Guarded route/SecretBroker integration acceptance and failure/recovery acceptance remain. |
| P6 providers/settings/Doctor/S1 | PARTIAL handoff | Source path and same-epoch prepare recovery present; credential mutation, live Doctor, FEAT-001..014/S1/provider-switch acceptance remain. |
| P7 streaming/artifacts/automation/rewind | PARTIAL, dependency-limited | P1/P2-backed settlement/restore/invocation, replay/render journeys remain. |
| P8 resources/workers/RC0 | PARTIAL handoff | RC0 bounds source-present with unrun fixtures; P1/P2/P3 evidence, approved pressure policy and OS hard limits/attestation remain. |

Evaluation inventory: `scripts/perf/rc0.py` is operational resource calibration, not a coding benchmark harness. §32.40 HUP-001..006 and §32.41 CM-001..007 are acceptance specifications; no paired-runner, benchmark adapter, or measured uplift is claimed. The CodeMode interpreter remains hidden pending Guarded nested effects. `repo_take/jcode`'s separate QuickJS runtime is not adopted. Implementation-first hold remains: no tests, builds, typechecks, audits, benchmarks, provider calls, or Git publication. C: via `/mnt/c` is 24 GB free; one worktree; `kernel/target` 627 MB; tree mixed/unstaged. Release remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 18:30 UTC — phase-owner refresh

P2 returned PARTIAL with no independent source-only gap; managed verifier decoding and Goal/review/start TUI handlers match current DTOs but remain dependent on P1 guarded verifier/quiescence and P8 settlement acceptance. P3 remains active and added RepoIntel response cross-field and text bounds; raw ripgrep remains false before process start, with P3 owning callers and P1 any Guard boundary. P4 is resumed for whole-phase LSP/DAP/REPL integration against P1/P3, all gated. Active phase owners: P1, P3, P4. P6/P8 have partial handoffs. No validation/provider work ran. No staging/commit/push/cleanup. C: 24 GB free via `/mnt/c`; one worktree; `kernel/target` 627 MB. Release is PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 18:37 UTC — P4/P7/P9 and agent recovery update

P4 completed a source audit PARTIAL: supervised adapters exist, but safe production ingress is absent because no trusted Session/Location/Attempt context is provided; effect gates remain false. P7 owns a source fix for artifact-range out-of-bounds offsets and non-advancing zero-byte cursors; fixtures are unrun. Checkpoint restore and automation invocation remain gated by P1/P2 contracts. P9 is active on Linux CLI/TUI packaging and licensing/notice source closure (no builds/release).

§32.12 adds SA-018..020 for interrupted partial-write recovery, process restart across queued/running/completed subagents, and 429 handling with no implicit model/provider switch. Current active whole-phase owners: P3/P7/P9. P1/P2/P4/P6/P8 remain partial or dependency-gated; P5 runtime remains disabled. No verification or provider call ran. C: `/mnt/c` 24 GB free; one worktree; `kernel/target` 627 MB. Mixed Git state preserved; no staging/publication. Release remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-20 — P3/P9 handoff; P1/P7 active

P3 returned PARTIAL after closing its unblocked Core/indexd source work; P1/P8 Guarded cache/read acceptance, parser provenance, trusted editor overlays and cursor acceptance remain. P9 returned PARTIAL after source-only inspection of the Linux CLI aliases and one installer docs-link change. It did not change `packages/opencode/package.json`; current package identity/private state and root project license are unresolved release blockers. P1 resumed against P3's newest source; P7 continues the artifact-range validation fix. Active owners: P1/P7. No tests/builds/typechecks/audits/benchmarks/provider calls/package commands. Git remains mixed/unstaged, C: `/mnt/c` 24 GB free, one worktree, `kernel/target` 627 MB. No publication; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

Latest owner refresh: P6 resumed to verify Core direct-child inbox delivery against the exact P1 HostKernel prepare/commit/ACK/inspect source and finish independent provider/settings/Doctor/S1 source work. P7 source now rejects artifact offsets beyond length and non-advancing ranges, and binds checkpoint preview response to the request; fixtures are unrun. Active owners: P1/P6/P7. No tests/builds/typechecks/audits/benchmarks/provider calls. No publication. C: `/mnt/c` 24 GB free; one worktree; `kernel/target` 627 MB.


## 2026-10-21 06:33 UTC — evaluation runner source review and owner refresh

P2 returned PARTIAL: direct child follow-up remains fail-closed until P1 supplies typed HostKernel turn-scope DTOs and one-use authorization. P1 resumed as a whole-phase owner; P8 and P9 are active. `scripts/eval/eval_harness.py` is a fake-only HUP-005 self-check, not a live evaluator or score. Source review found a missing manifest argument in its paired-summary test, journal recovery rejecting `UNSUPPORTED_CAPABILITY`, and artifact path TOCTOU risks; P8 owns those fixes. P9 owns remaining no-follow/exclusive release output creation. Benchmark acceptance remains HUP-001..008; CodeMode remains gated by CM-001..009. No tests/builds/typechecks/audits/benchmarks/provider calls/release commands/staging/commits/pushes/cleanup ran. Repository-local disk: 820 GB free, `kernel/target` 627 MB; mixed tree preserved. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 06:38 UTC — owner refresh after reference audit

Read the user-authorized single attachment `pasted-text-1.txt`; it reiterates whole-V1 delivery, source-first OpenCode/Codex comparison, future-design explanation, complete architecture/flow/event audit, documentation updates, implementation before tests, and an explicit ask to raise any unresolved design decisions promptly. No additional external path/service/remote access occurred. Actual in-repo Codex handlers confirm distinct spawn, queue-only send, trigger-turn follow-up, list, bounded wait, interrupt, parent/root-turn correlation and activity projection; OpenCode TaskTool confirms role resolution, depth bounds, parent-intersected permissions, child Session creation, and explicit background completion injection. HorizonCode adapts these under §29/§37 profile pins, Rust Guard/HostKernel and durable delivery; it does not inherit their ambient authority.

P1/P2/P9 are active whole-phase owners; P8 returned PARTIAL after source-only fake HUP-005 runner work. P1 confirmed §37.9's exact `direct-turn-v1` schema/Rust DTOs exist and is implementing the HostKernel dispatcher/journal; P2 resumed for Core/TUI integration against that exact contract. P8 evaluation artifacts are append-only/fsynced JSONL with no-follow descriptor traversal and paired uncertainty summary; fixtures remain unrun, and worker/resource/RC0 work remains blocked on P1/P2 contracts and an approved pressure policy. P9 added exclusive no-follow artifact writing; remaining P9 decisions/gates are still open. No tests/builds/typechecks/audits/benchmarks/provider calls/release commands ran. Git remains mixed/unstaged; no publication or cleanup. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:41 UTC — current release implementation ledger

The V1 implementation target remains the complete operative P1–P9 scope; this checkpoint does not redefine it. Active whole-phase source owners are P1 Guard/ExecutionHost, P2 managed/direct child lifecycle, and P5 V1 web search. P9 returned PARTIAL after source-side Linux/WSL candidate hardening. P3/P4/P6/P7/P8 remain PARTIAL or dependency-limited and are queued for full-phase continuation as owner slots free. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

P1/P2 identified a direct-turn contract/lifecycle dependency: follow-up must use the same live EXECUTING DirectAttempt through the safe child turn; Core must persist and pass the one-use fresh-turn proof and trigger the turn through its existing Session owner. Also, a DirectTurnScope digest over mutable Attempt revisions may stale after an effect; a user decision on stable cycle pins plus refreshed Attempt scope versus full-scope refresh is pending. Until settled and integrated, keep `follow_up` and dependent effectful turns unavailable. P5 is completing route cascade, consent/order/provenance, Settings status and acceptance-fixture source under DEC-V1-26. P9 release decisions (distribution rights, package scope, signing/update policy) and exact-candidate acceptance remain open in `scripts/release/README.md`.

No tests, builds, typechecks, audits, benchmarks, provider calls, release commands, staging, commits, pushes, or cleanup were performed. The mixed working tree is preserved; repo-only boundary is active.

## 2026-10-21 06:43 UTC — P1/P2 direct-turn source continuation

P1 source now records and checks HostKernel process incarnation on direct-turn cycles and fresh authorization issue/reservation; replay maps prior-process active cycles, unresolved proofs, and consumed proofs without their successor to UNKNOWN. Completion replay returns the canonical OwnerLog cursor digest. P2 added strict Core turn RPC adapters with authority-pin and sequence validation, but the TaskTool/sessionRunner caller, persistent same-Attempt lifecycle and safe-boundary wake trigger are still not wired. These are source changes only. The user decision about stable cycle pins versus full-snapshot turn-scope refresh remains pending, so effectful follow-up stays unavailable. No tests, builds, typechecks, or audits ran.

## 2026-10-21 06:45 UTC — V1 owner/dependency refresh

Active whole-phase owners: P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1 and P7 streaming/artifacts/automation/rewind. P5 returned SOURCE COMPLETE / PARTIAL / NOT VERIFIED; its runtime stays unavailable until P1 Guard and P6 SecretBroker acceptance. P2 returned PARTIAL with strict false-gated HostKernel turn RPC adapters; it still needs the Core child runner lifecycle, same live Attempt, safe-boundary wake trigger, turn-scoped Guard effects, plus managed verifier/recovery. P3/P4/P8 are queued/dependency-limited; P9 is partial with package/distribution/license/signing decisions and candidate acceptance outstanding. User's direct-turn cycle-digest semantics choice is pending; dependent code stays closed. All checks and live calls remain deferred until implementation completion. Mixed repository work is preserved, unstaged, with no commit/push/cleanup.

## 2026-10-21 06:47 UTC — evaluation runner and CodeMode status

`HUP-001..008` and `CM-001..009` in arch_V1 §32.40–32.41 are the authoritative future acceptance plans. `scripts/eval/` currently implements fake-only HUP-005 and has no live provider/benchmark runner. `repo_take/oh-my-pi/packages/metaharness` is a local manager-pattern reference for experiment/run/task/trace, per-task arm matrices and exact-trial resume; its Harbor/VM/provider-gateway/paid execution paths are not an authorized adapter. The suggested model/benchmark scores are not comparable without exact release, split, evaluator, model revision/quantization, harness, image, permissions and budgets. Run no real benchmark until implementation gates and the explicit route authorization are satisfied.

HorizonCode CodeMode stays hidden; nested MCP effects currently fail before transport. The wrapper does not pass explicit finite timeout/call/output budgets, and no hard interpreter memory ceiling is established. CM-008/009 capture the required coverage; interpreter tests alone do not prove Guarded effects, receipts or UNKNOWN recovery. P6 source marks OpenCode dispatch unverified and keeps credential mutation/live Doctor closed; P7 source keeps scheduled invocation and checkpoint create/restore closed. All are source status, not acceptance evidence. No tests/provider calls were run; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 06:48 UTC — RepoIntel build coalescing remains implementation work

P3 identified that HostKernel currently builds duplicate identical RepoIntel generations for concurrent requests and deduplicates retained Arcs after construction. P1 owns and accepted the HostKernel coalescing source fix; P3 continues separate RepoIntel source tasks. P7's transcript source/test visibility requires only two exact ignore exceptions. No checks have run and none of these source updates count as acceptance.

## 2026-10-21 06:49 UTC — P7 handoff; P8 active

P7 returned source-partial after adding bounded transcript presentation and exact Git visibility for its source/test. Schedule invocation remains disabled pending timezone/DST/clock policy and Guarded dispatch; checkpoint capture/restore awaits P1 receipts and exact same-revision VCS facts; terminal graphics are unavailable (text fallback); integrated acceptance is outstanding. P8 has resumed whole-phase resources/workers/RC0/evaluation implementation. No tests or builds have run.

## 2026-10-21 06:50 UTC — RepoIntel reuse and artifact-search source status

HostKernel now attempts exact retained RepoIntel generation reuse before index build. The per-HostKernel synchronous request loop serializes these operations, but each call still collects its source snapshot first and cache reuse currently requires the same Session. §30.22 base-generation sharing vs query-owner lease semantics remain to be reconciled before counting build coalescing complete. P3 owns managed artifact search via authenticated ArtifactControl scope and HostKernel range reads; local path fallback is prohibited. No acceptance checks run.

## 2026-10-21 current source checkpoint — implementation only

| Phase | Owner/status | Remaining implementation / evidence |
|---|---|---|
| P1 Guard/ExecutionHost | Active whole-phase owner | Integrate full-snapshot DirectTurnScope refresh after exact terminal receipts; close remaining guarded origins, ToolBatch/recovery and confinement source gaps. Keep unsupported/effectful paths disabled until acceptance. |
| P2 managed vertical and direct children | Queued for slot; PARTIAL | TaskTool resolves versioned AgentProfileV2, but same-live-Attempt child turns, `turn_begin`/completion/fresh-proof caller, safe-boundary wake, durable refresh/recovery and remaining managed verifier/review/TUI integration remain. |
| P3 RepoIntel | Active whole-phase owner | Complete generation/source semantics and authenticated ArtifactControl-backed digest-pinned range search/registry integration; no filesystem fallback. |
| P4 LSP/DAP/REPL | PARTIAL/dependency-limited | Production authenticated ingress, P1 Guarded lifecycle, protocol mediation and real-project journeys remain. |
| P5 web search | Source-partial, disabled | Cascade source is present; P1/P6 Guard/SecretBroker integration and final acceptance remain. No paid route is silently enabled. |
| P6 providers/settings/Doctor/S1 | PARTIAL | Finish source closure and protected credential/live Doctor paths under Guard; FEAT/S1/provider switching and explicit free-model journey remain. |
| P7 streaming/artifacts/automation/rewind | PARTIAL | Replay/render journeys, artifact truth, Guarded automation and checkpoint/rewind remain. |
| P8 resources/workers/RC0 | Active whole-phase owner | Finish settlement/recovery and evaluation/resource integration. RC0 remains NOT_ATTESTED; OS guarantees cannot be inferred from monitoring. |
| P9 release | PARTIAL | Package/license/signing/update decisions and exact-candidate release acceptance remain. |

Direct-turn scope decision: preserve the §37.9 full-snapshot digest. Each settled effect (or fully reconciled batch) must return a refreshed same-cycle/same-sequence scope after exact receipt reconciliation and live Attempt re-resolution; Core durably persists it before the next effect/completion. Lost reply resolves the exact receipt without redispatch. UNKNOWN/unresolved refresh fences the cycle. P1 owns HostKernel integration; P2 owns Core integration.

Current active owners: P1/P3/P8; P2 is queued for the next free child slot. No tests, builds, typechecks, audits, benchmarks, provider calls, release commands, Git publication or cleanup have run. Mixed Git work remains preserved and unstaged. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED.

P3 latest source update: ArtifactControl-backed managed artifact search is wired into the registry with no local filesystem fallback. `repo_tree` and `repo_detect` are no longer model-visible because their current direct `nodeSource` reader is not HostKernel-mediated; canonical capability IDs remain, but both report UNAVAILABLE pending a bounded authenticated HostKernel discovery/manifest DTO (P1) and Core adapter (P3). No tests/builds have run; P3 remains PARTIAL / NOT VERIFIED.

P3 source handoff (2026-10-21): PARTIAL. Managed artifact/text/terminal search is registry-wired through authenticated ArtifactControl and HostKernel digest-pinned range reads. `repo_tree`/`repo_detect` are unavailable until a bounded authenticated HostKernel discovery/manifest DTO and P3 adapter are implemented. Remaining P3 work depends on P1/P8 authenticated cache pressure/retirement, approved parser provenance, authenticated unsaved buffers, P1/P4 LSP supervision, and direct-session artifact ownership. Exact retained-Arc reuse remains same-Session and after full source snapshot, so §30.22 performance acceptance is still open.

Current active whole-phase owners are P1 Guard/ExecutionHost, P2 managed/direct-child lifecycle, and P8 resources/workers/RC0. P1 has added direct-turn batch journal/schema source, but effect admission, leases, receipts, refreshed-scope response and P2 caller wiring remain incomplete. P2 resumed against the settled full-snapshot DirectTurnScope decision; keep effects gated until integrated. RC0 remains NOT_ATTESTED pending trusted P1 process ownership and P2 final verifier receipt. No tests/builds/typechecks/provider/benchmark/release operations ran; one P3 `git diff --check` invocation reported no diagnostics. No stage/commit/push/cleanup. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

P8 interim source: HUP paired summary includes all invoked calls, incomplete pairs and per-arm failure-stage/accounting totals; fixture cost is labeled `FIXTURE_REPORTED`. Worker OwnerLog replay/settlement is already conservative; final settlement awaits P1 Guard/quiescence and P2 terminal Attempt/effect-chain/final-revision proof. RC0 remains NOT_ATTESTED. Fixtures and checks are unrun.

P8 phase handoff: HUP paired reporting includes every invocation/incomplete pair, status/failure stage/accounting; fixture costs remain `FIXTURE_REPORTED`. RC0 file capture is bounded/locked/no-follow under the repository, but no trusted attestation source exists; RC0 remains NOT_ATTESTED. Worker settlement depends on P1 quiescence/effect receipts and P2 final Attempt/revision proof. OS CPU/memory/FD enforcement and trusted pressure ingress are unavailable. P7 resumed whole-phase ownership. Active owners P1/P2/P7. No validation/evaluation run.

P2 interim source update: Core `managed-control.ts` and `session/tool-batch.ts` require a DirectTurnScope for direct effect batches, enforce same-cycle/sequence transition checks and persist the post-bind scope before dispatch. Remaining Core caller work includes supervisor request/approval/terminal receipt decoding, LLM/prompt/TaskTool lifecycle, completion/fresh-proof wake and managed recovery. P1's exact final refreshed-scope response is required; no tests run.

P7 interim source: authenticated SSE fanout is bounded (256 events, 64 KiB serialized event), filters unrelated workspace/Location before admission and closes on overflow to force reconnect/resnapshot; §31.17 records remaining limits. No validation ran.

P7 source handoff (2026-10-21): bounded per-instance authenticated SSE queues and overflow reconnect are present. Session messages resnapshot, but transient non-Session projections lack replay/list ownership. Checkpoint/rewind effects await P1 Guard receipts and exact same-revision HostKernel filesystem/fixed-Git facts; scheduled automation invocation awaits canonical timezone/DST/clock-jump semantics and Guarded recovery. Terminal graphics remain unavailable with text fallback. Other stream/render/artifact/analytics/automation journal and preview source remains unverified. P4 resumed as whole-phase owner. Active P1/P2/P4; no tests/builds run.

P2 interim: Core strict DirectTurnScope decoders and Prompt→LLM→ToolBatch authority propagation are source underway; `prepareToolBatch` sends/validates the post-bind scope. Write/patch settlement refresh and Task child durable lifecycle remain. Follow-up remains disabled pending P1 turn-RPC recovery and P8 final settlement evidence.

P4 design implementation decision: ordinary direct Sessions need an explicit mutually exclusive DirectTurnScope authority lane for editor integration, because direct coding does not require a Goal. Do not treat Session ID as authority. Keep it unavailable until P1's matching HostKernel Guard/process/protocol projection and acceptance are present.

P4 authority correction: DirectTurnScopeV1 is bound to child DirectAttempt and its child-keyed turn journal; it cannot authorize arbitrary root direct Sessions. Support managed and Goal-less child lanes only; keep root direct-session LSP/DAP unavailable until P1 defines a canonical authenticated root-session process/effect authority. AgentProfile and ExecutionLaunchProfile pins remain separate and must be validated independently.

P3 potential unblocker: P1 found existing authenticated bounded `repo_intel.v1/query_structure` HostKernel projection backed by Guard-authorized snapshots/cursor leases. Reassess whether Core can adapt this exact DTO for repo_tree/repo_detect without new HostKernel API. Keep model exposure unavailable until semantics and evidence are complete.

P4 interim: removed incorrect cross-comparison of AgentProfileV2 pins and ExecutionLaunchProfile/HostProcessRef pins. P4 source review confirms LSP edit/rename remain proposals, DAP attach/evaluate/variables are denied, and REPL callbacks are generation-scoped while launches stay disabled. Current supported authority shapes are child DirectTurnScope or managed Attempt; root direct-session editor scope remains unavailable pending P1 contract. P1 editor Guard/process/receipt integration, P3 document-read acceptance and OS confinement remain prerequisites. No checks ran.

P4 handoff (2026-10-21): LSP/DAP/REPL source now keeps AgentProfileV2 separate from ExecutionLaunchProfile and requires exact HostProcessRef plus matching durable receipt for settled editor output. Remaining: P1 Guarded process/protocol wire/recovery and OS confinement, P3 authenticated document-read acceptance, P4 production ingress/DAP/REPL recovery and real Linux journeys. Root direct-session editor authority remains unavailable. P6 resumed; active owners P1/P2/P6. No checks/provider calls.

P2 interim update: direct child turn authority is persisted across begin, batch bind, file write/patch and terminal receipt. PTY/shell carries DirectTurnScope through terminal.run and parses final-turn receipt; replay requires the identical scope. TaskTool same-Attempt lifecycle/follow-up wake and managed recovery remain. P1 HostKernel batch path is source-wired and its journal is being corrected to retain completed batch receipts across later batches. No tests run.

P1/P2 interim source integration: HostKernel direct ToolBatch validates full cycle authority before Guard, durably binds exact member IDs before leases, refreshes scope at bind and final receipt, fences UNKNOWN, and retains completed batch receipts for exact replay across later batches. Core carries scope through Prompt→LLM→ToolBatch, write/patch and terminal.run; runtime turn begin remains disabled because TaskTool same-live-Attempt multi-turn/fresh-proof recovery is not wired. No tests run.

P6 interim: legacy provider OAuth mutation endpoints are being disabled before service invocation until protected input/Guard exists; offline Doctor missing freshness is corrected to UNKNOWN. No provider calls/tests.

P2 recovery dependency: HostKernel `direct_attempt_snapshot` does not return an authenticated live DirectAttemptScope/workspace pin, so after restart Core cannot trust locally persisted TaskTool scope. P1 must expose strict live same-owner scope recovery; follow-up stays gated until then.

P6 interim source: offline Doctor preserves UNKNOWN for missing/stale/undefined freshness on absent model; HTTP OAuth authorize/callback are typed 503 before ProviderAuth, OpenAPI documents protected-input/Guard prerequisite, and CLI login/logout remain unavailable. Remaining P6 blockers include P1 protected credential/probe grants and trusted owner stamping for server_auth Session roots; FEAT/QA/LM-018 and free-model journey are later acceptance, not run.

P3 cache source clarification: HostKernel may reuse an immutable generation across same-principal Sessions when Location/root/workspace/revision/read-policy/limits/owner-epoch pins match; Session/request IDs are lease identity only. Every request still snapshots the bounded source, so only index rebuild is skipped. Prior §30.22 notes claiming same-Session-only reuse need correction; full performance acceptance remains open.

2026-10-21 07:17 UTC owner update: P1, replacement P2, and P3 are actively implementing their full phases. P1's current contracts include authenticated owner-bound live Attempt scope recovery and trusted server-auth principal stamping; P2 is integrating TaskTool child creation/resume to these contracts. Finite CodeMode timeout/tool-call/output limits are requested from P1 with exposure still disabled. P3 confirms tree enumeration and complete manifest detection cannot be implemented with current HostKernel DTOs; those tools remain unavailable. No tests/builds/checks/evaluations/provider/release/Git operations have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

2026-10-21 07:21 UTC: P3 handoff is PARTIAL (no authenticated directory enumeration or typed path-not-found DTO, so tree/detect stay unavailable); P1/P2/P6 are active whole-phase owners. P2 identified undeclared raw Session route handlers and is reconciling exact current tree/index before scoped source repair. No tests/builds/typechecks/benchmarks/provider/release/Git operations ran; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P1 source checkpoint: CodeMode's existing adapter now has finite trusted time/call/output bounds and final-output cap; it stays hidden and has no hard memory claim. Native credential mutation/live probes remain unavailable due missing protected-input/Guard grant contracts. HostKernel's direct Attempt snapshot now provides P2 with an authenticated live full scope only for matching owner, epoch, phase and workspace. Source-only; no verification evidence.

2026-10-21 07:24 UTC: P1 source-partial handoff (scope recovery, trusted owner stamping, bounded hidden CodeMode); P3 source-partial handoff (tree/detect unavailable with current DTOs). Active whole-phase owners now P2/P6/P7. P7 resumed for remaining stream/render/artifact/analytics/automation/rewind source. All acceptance and release evidence remain open; no tests/builds/evaluations/provider/release/Git operations ran.

P2 source review uncovered missing Session route declarations plus multiple direct-turn source/wire mismatches (revision types, profile/scope decoding, BigInt serialization, Task profile input, duplicate child binding, parent variant). The whole-phase owner is repairing these; route restoration is scoped against repository index while preserving current changes. No tests/checks run.

P7 current source note: SSE stream/replay and rendering protections exist; checkpoint capture/restore and scheduled invocation remain unavailable pending P1 contracts/canonical schedule policy. P7 continues independent source work; no validation evidence.

User attachment read (2026-10-21): reaffirms whole V1 completion, local OpenCode/Codex implementation comparison, implementation before tests, architecture/flow/event re-audit, Markdown updates, and immediate listed escalation for material doubts. It adds no release-policy decision; existing P9 release gates remain open.

P6 source note: FeatureExposure currently omits owner/runtime prerequisites and platform/model/harness metadata required for Settings truthfulness; P6 is aligning schema, descriptor and TUI detail projection. Probes remain disabled.

P7 source continuation: bounded printable activity labels, bidi/control redaction, and capped/session-validated resnapshot recovery are source-present; fixture unrun. Checkpoint restore and scheduled invocation remain unavailable pending HostKernel facts and canonical scheduling. No evidence upgrade.

P2 source continuation: route declarations and direct-turn serialization/profile/scope defects corrected; same-live-Attempt follow-up caller wiring is in progress. Runtime remains gated until P1 Guard and recovery acceptance. Follow-up wake and restart idempotency remain open. No verification evidence.

Resource check (2026-10-21): C: via `/mnt/c` has 18 GB free (97% used); repo-local `kernel/target` is 627 MB; only the primary worktree remains. No heavy build is running.


2026-10-21 implementation checkpoint: P1 continues Guard/ExecutionHost, including request-deadline fencing in ToolBatch admission and schema/Rust identifier parity. P2 is implementing child lifecycle against that authority. P6 continues provider/settings/Doctor/S1. P7 continues render/replay/artifact work with Rust artifact/automation/checkpoint files retained by P1. CodeMode remains unavailable for model dispatch until nested effects traverse Guard and support durable lease/receipt reconciliation; no heap ceiling is claimed. HUP acceptance retains controlled paired evaluation and provenance rather than accepting unqualified benchmark headline scores. All reported progress is source-only; no tests, builds, typechecks, provider calls, benchmark runs, or release gates have run.


2026-10-21 continuation: active implementation slots are P2 managed/child lifecycle, P3 RepoIntel (then immediate P1 Guard continuation), and P7 streaming/render/artifact presentation. P6 finished its currently unblocked source pass; protected credential/live Doctor remain gated on P1. P5 source audit confirms cascade/settings fixtures exist but remain unrun and runtime false. P7 is adding the missing checkpoint TUI entry while preserving disabled restore. No tests/builds/typechecks/provider calls/evaluations/release actions. Keep all runtime gates false until cross-phase acceptance.


2026-10-21 implementation progress: P3 added UTF-8/query/path validation and authored unrun schema-rejection fixtures; tree/detect remain unavailable pending the user's decision on a new authenticated bounded HostKernel discovery DTO. Direct artifact ownership also lacks a resolver. P7 added aggregate SSE queue byte limits, a read-only checkpoint list/preview dialog and bounded printable transcript labels; restore remains unavailable. P2 owner is auditing the Core managed/child lifecycle. P1 will resume Guard source review after P3. These are source changes only; no validation or external calls.


P7 follow-up: checkpoint preview now renders IDs, paths, digests and conflict labels through bounded terminal-safe redaction while preserving exact raw IDs for SDK requests. Authored fixture coverage includes bidi/control characters, Bearer redaction, limits and raw-ID preservation. No tests run; restore remains unavailable.


P1 current blocker: no durable boot-scoped containment identity is retained to prove a stdio process tree is quiescent after abrupt HostKernel owner loss. The live-process PTY janitor and bubblewrap `--die-with-parent`/PDEATHSIG do not give a fresh HostKernel restart proof. Keep unresolved effects UNKNOWN and protocol/verifier gates false; do not use PID-only kill. P1 is checking the local Codex/OpenCode supervisor implementations before settling whether an existing safe primitive can be adapted.


Owner handoff update (2026-10-21): P2 source audit found TaskTool, authenticated follow-up runner, committed inbox claim, turn begin/complete, scope refresh and restart fencing present; runtime remains disabled pending P1/P8. Its owner is now on P4 source completion. P7 returned PARTIAL; its slot is on P8 resources/workers/RC0/HUP. P1 remains the critical Guard owner. Correction to the prior P1 note: `repos/codex/codex-rs` exists in this workspace; an earlier claim that it was absent was wrong and is being rechecked against the actual local source. No tests, builds, typechecks, provider calls or benchmarks.


User decision (2026-10-21): add the authenticated bounded HostKernel discovery/manifest DTO for P3; keep `repo_tree`/`repo_detect` gated until integrated acceptance. P1 owns the HostKernel contract/schema and will hand the precise revision to P3. Codex restart review is corrected: local Rust source exists; its process groups/PDEATHSIG, process-local Windows Job handles, and persisted single-daemon identity do not prove descendant quiescence after restart. P4 found production LSP supervised launch is not wired; a narrow `session/prompt.ts` authority-scope seam is now P4-owned, while launch remains gated on P1. No checks executed.


P8 update: resource/worker Rust files remain proof-gated and preserve OS quotas as unsupported, advisory pressure as unwired, worker settlement as proof-gated, and fan-out closed. RC0 test fixtures now use repository-local scratch instead of default OS temp paths; an unrun locality fixture was added. Remaining P8 blockers: P1/P2 owner-backed HostRun and verifier attestation, quiescence/effect/final-revision evidence, trusted resource ingress/retention, and real OS CPU/memory/process/FD limits. HUP live evaluation remains disabled.


Active phase ownership refresh: P1 HostKernel Guard + approved P3 discovery DTO; P4 LSP/DAP/REPL source integration; P9 local release tooling. P8 source pass is partial and its slot moved to P9. P2 source pass is partial, fail-closed pending P1/P8; P3 adapter waits on P1 DTO. P5/P6 source is present for unblocked work; P7 source is partial. No tests/builds/typechecks/provider/benchmark/release commands have run.


Current owner slots: P1 Guard + approved discovery DTO; P4 supervised LSP/DAP/REPL source work; P9 bounded local release audit/tooling. P1 additionally rechecked actual Codex process sources and found no restart-proof descendant quiescence primitive. P8 partial handoff is complete; RC0/worker proofs remain gated. No test/build/typecheck/provider/eval/release command has run.

2026-10-21 P9 source checkpoint: `scripts/release/audit_distribution.py` now bounds package-manifest size (2 MiB), per-manifest dependency count (4,096), and graph traversal (10,000 packages); symlinked/out-of-root manifests and incomplete inventory become blockers. Matching unrun fixtures were added to `scripts/release/test_release_readiness.py`, and `scripts/release/README.md` records the limits and their scope. No tests/builds/audits/release commands were run. P9 remains PARTIAL: legal distribution grant plus exact-artifact third-party notices, approved package/publication identity, signing trust root/key custody/rotation/revocation and update/rollback policy, separately accepted native Linux and WSL lanes (native Windows unavailable), and clean exact-candidate V1/install/migration/upgrade/rollback evidence remain unresolved. Remote download, automatic updates, publication, and release claims stay disabled.


P1/P3 integration progress: the approved bounded discovery contract now exists in RepoIntel schema, HostKernel and Core SessionSupervisor source. The response binds authenticated principal, Session, Location, owner epoch, workspace binding, source revision, read-policy digest, root, mode, limits and coverage; HostKernel rechecks Guard/read scope and request deadline. P1 is handing the exact DTO to P3 for model-tool adapter wiring; `repo_tree`/`repo_detect` remain hidden pending acceptance. Source only, no validation.

2026-10-21 decision/update: optional Linux cgroup-v2 containment is approved as the P1 crash-quiescence design, hosted by the existing ExecutionHost. P1 must persist and validate the exact boot-scoped cgroup identity, assign before executable dispatch, and reconcile only the same cgroup; quiescence requires kill/wait and confirmed `populated=0`. Missing delegation, identity mismatch, unavailable controller, or uncertain emptiness yields UNKNOWN and disabled effects. This is not an OS quota claim and does not enable Windows/other unsupported paths. P3's approved discovery DTO is now handed off: bounded `repo-intel.v1/discover` tree/manifests; retain disabled model exposure pending integrated acceptance. No tests/builds run.

2026-10-21 implementation handoff: P3 has source-wired bounded tree/detect adapters through HostKernel discovery and exact-source-revision document reads; symlinks are never followed and model exposure stays disabled. P4 has scoped lazy LSP client creation through authenticated ExecutionScope and Guarded HostKernel launch/protocol boundaries; DAP/REPL closure is still in progress. P1 must prove cgroup assignment before target code can execute or leave affected dispatch unavailable. P2 is the active managed/child owner. P9 bounded distribution inventory is source-present, but distribution/signing policy and exact-candidate acceptance are not. No tests/builds/typechecks have run.

Managed budget contract: Core resolves canonical AgentProfileV2 during authenticated Task creation; Rust validates the exact profile ID/revision/digest and pins `limits.tokenBudget` with the Task. HostKernel derives effective token allowance as the minimum of SpecVersion.maxTokens and that immutable profile ceiling, and returns authoritative durable `remainingTokens` on every managed usage/scope refresh. Core clamps each managed provider step to remaining; direct sessions are unaffected. P1/P2 own the implementation and fixtures; no tests run.

Process-origin status: cgroup-backed durable identity/recovery is source-wired only for the non-PTY `execution.v1` supervisor. Interactive `terminal.v1/run` lacks the durable cgroup identity seam and is now hard-disabled at HostKernel before effect/spawn; this is a documented V1 limitation pending migration. P2 source work is PARTIAL and waiting on P1/P7/P8 evidence; P7 is active on whole-phase source closure. No validation run.
## 2026-10-21 V1 source status update

| Phase | Current status | Remaining implementation / acceptance |
|---|---|---|
| P1 Guard/ExecutionHost | Active; cgroup-v2 containment and typed editor/REPL HostKernel routes are source-wired | Complete Guard/origin closure, exact dispatch/recovery integration, then adversarial/OS acceptance. PTY stays disabled; no unsupported quota claim. |
| P2 Managed vertical | Active whole-phase owner resumed | Complete profile-pinned child lifecycle, same-Attempt direct follow-up, managed verifier/evidence/final revision and TUI path; keep finalization/fan-out disabled until P1/P8 proof and end-to-end acceptance. |
| P3 RepoIntel | Source-wired, gated | Discovery/tree/manifests and artifact adapters need integrated HostKernel/source-revision acceptance; keep model exposure hidden until then. |
| P4 LSP/DAP/REPL | Active whole-phase source owner | Complete authenticated ingress, typed protocol/attach/evaluate policy and recovery. REPL stays unavailable until actual OS quotas and callback/result evidence exist. |
| P5 Web search | Source present, gated | Approved ordered cascade/settings/provenance source exists; acceptance waits on P1/P6 Guard and secret authority. No paid fallback. |
| P6 Providers/settings/Doctor/S1 | Source partial, gated | Finish protected credential path, truthful settings/Doctor/S1 acceptance, and later explicitly selected free-route journey. No provider call yet. |
| P7 Stream/artifact/analytics/automation/rewind | Source partial; bounded SSE preflight landed | Durable transient-event replay ownership, same-revision Guarded checkpoint facts, canonical schedule semantics and guarded invocation/recovery; complete renderer/activity/artifact/analytics acceptance. Restore/run_now stay disabled. |
| P8 Resources/workers/RC0/evaluation | Source partial, proof-gated | Integrate P1/P2 settlement/attestation and trusted resource evidence. OS quotas remain unsupported; RC0 NOT_ATTESTED and fan-out disabled. |
| P9 Distribution/release | Source partial | Distribution/legal notice, package/signing/update/rollback decisions and exact-candidate Linux/WSL install acceptance remain; no release/publish. |

Current active phase owners are P1, P2 and P4. P7 handed off PARTIAL after the SSE bound and owning-doc updates. Source changes remain unverified; no tests, builds, typechecks, audits, provider calls, benchmarks, or release commands have run. Git changes remain mixed and unstaged. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 owner/dependency refresh

P2 is PARTIAL and queued after completing its currently unblocked Core/TUI source review and updating §29/§37. Its resume triggers are P1 Guarded verifier/effect receipts and cgroup quiescence/fresh-process recovery, plus P8 final-Inspect and terminal settlement proof. P8 is active again for whole-phase resource/worker/worktree/RC0/fake-evaluation source work. Current active owners: P1, P4, P8. P4 source now binds REPL to the exact HostKernel journal sequence, classifies pre-dispatch conflicts separately from UNKNOWN, binds DAP attach to HostKernel-minted terminal process refs, and keys LSP cache by authenticated Session/Attempt/workspace/profile; runtime remains gated. P7 remains PARTIAL, including the recent SSE preflight source, pending correction of bounded key enumeration and serialization snapshot ownership. No checks have run; overall status remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 source review update

P1 source bounds retained execution cgroups to 256 and performs bounded directory counting plus serialized count/create; unsupported lock behavior fails closed. P4 DAP attach remains unavailable because current sandbox PID namespaces are isolated per process; same-scope HostProcessRef binding does not prove ptrace visibility. P8 has source-hardened repo-local RC0 inputs and fake HUP seed parity. P7's SSE bound still needs bounded key traversal and synchronous immutable serialization before queue admission; do not mark this item complete until repaired. Active owners: P1, P4, P8. P2 is queued on P1/P8 proof. These source changes are unverified; no validation/provider/evaluation/release work has run.
## 2026-10-21 P4/P8 handoff; P6/P7 owner update

P4 and P8 are PARTIAL/queued. P4's DAP attach/evaluate, LSP ingress/document sources, and REPL OS-quota/callback acceptance remain closed; bwrap PID namespace isolation blocks DAP attach absent a shared debug namespace/ptrace policy. P8's RC0 local no-follow and fake-runner resume/accounting source is present, but trusted P1/P2 HostRun/verifier attestation, OS quotas, pressure ingress and settlement proofs are missing. Active whole-phase owners are P1, P6 and P7. P7 must close own-key enumeration and immutable queue-time SSE serialization, then continue whole-phase work. P6 continues provider/settings/Doctor/S1 source work with probes/providers inactive. P2 is queued on P1/P8 proofs. No validation or external activity occurred.

## 2026-10-21 source-only continuation

P1/P6/P7 are active whole-phase implementation owners. P1 is completing the enabled-origin audit around cgroup-backed non-PTY ExecutionHost. The two public SDK launcher APIs (`createOpencodeServer`/`createOpencodeTui` in both SDK versions) start `opencode` outside HostKernel, so P1 is disabling their V1 launch behavior before spawn. P6 corrected offline Doctor missing-model status and settings lock/source truth; P2 must fix root title generation to stay on the Session-pinned provider/model unless an explicit title model is configured. P7 fixed SSE bounded property traversal and synchronously queued immutable serialized snapshots; §31/§37/§32.33 were refreshed. All are source-only; no tests/builds/typechecks/audits/provider calls/evaluation/release actions ran. P2 awaits P1/P8 proof, P4 and P8 remain partial, and P9's exact-candidate gates remain open. Preserve mixed Git state. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 whole-phase source handoffs

P1's source-origin audit now classifies TUI editor/clipboard and both public SDK launch APIs as closed before spawn; plugin/MCP/hosted paths are unavailable or gated, shell passes Guard/HostKernel, formatter/Git and other process starts remain guarded, and LSP/DAP/REPL are gated. The CLI package bootstrap is direct user invocation, not reachable from model/tool dispatch. P1 remains unverified pending cgroup dispatch/restart, Guard/receipt/recovery integration and OS acceptance. P6 is PARTIAL after offline settings/Doctor/model-truth and S1 callback fixture source; protected credentials/probes and provider acceptance remain. P7 is PARTIAL after bounded immutable SSE admission and redacted timeline labels; checkpoint capture/restore, scheduled invocation, transient event replay, and end-user acceptance remain. Active source owners: P2/P4/P8. P2 owns the explicit-versus-implicit title model correction. No checks/provider/evaluation/release or Git publication ran; overall HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 critical-path implementation update

Active owners are P1/P2/P9. P1 resumed for approved-contract Guard/ExecutionHost gaps, especially the protected native-input and authenticated Guarded SecretBroker/provider-probe grants that block P6/P5, plus cgroup/ToolBatch recovery edges. P2 continues profile-pinned managed/direct child lifecycle, including no implicit title-model drift. P9 continues local distribution readiness source without remote or publish operations. P4 handed off PARTIAL with effect gates false pending P1/P3/OS proof. P8 handed off PARTIAL with no further independent source gap; actual OS quotas, trusted pressure ingress and P1/P2 evidence remain, so fan-out/cache eviction/RC0 remain disabled or NOT_ATTESTED. P3/P5/P6/P7 are PARTIAL/gated. No tests/builds/typechecks/audits/providers/evaluations/releases ran; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P2 corrected title generation to preserve Session-pinned provider/model absent an explicit title model. P9 is changing release qualification workflow artifacts from `/tmp`/`$RUNNER_TEMP` to repository-contained paths and auditing workflow source without execution. Unverified source only.

P2 handed off PARTIAL after the Session-pinned title-model correction; its remaining managed verifier/evidence/finalization depends on P1/P8 and is not accepted. P5 is active for whole-phase source audit/closure of the approved ordered web-search cascade, explicitly enabled routes only, auth-failure fall-through, route provenance and no paid fallback; no provider calls. Active owners P1/P5/P9. P4/P8/P2 remain queued/partial; P6/P7/P3 remain gated or unverified. No checks or external activity; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

P9 changed workflow qualification artifacts to `$GITHUB_WORKSPACE/kernel/target/horizoncode-release/ci-<run>-<attempt>/` and added unrun checks against `/tmp`/`$RUNNER_TEMP`; its README records manual read-only qualification with no sign/publish/upload/update activation. No workflow/release script ran.

P1 confirms exact contract gaps block credential writes/live Doctor: authenticated write context, protected-input binding, Guard grant/receipt and NetworkReadGrant/SpendApproval policy schema are undefined. Auth put/revoke now fail before broker mutation; live probes stay unavailable. P1 will not invent authority. ToolBatch source admission/cancel is bounded; integrated receipts/recovery remain unverified. Retained cgroups cap at 256 to avoid unsafe name-based deletion, after which Linux dispatch fails closed. P5 verified cascade RPC compatibility and is removing/disabling a legacy exported callback executor. P6 resumed source audit. P9 handed off PARTIAL after repo-local qualification workflow artifacts, bounded legal-file scan, and installer version/binary conflict validation. No acceptance runs occurred.

P6 resumed audit now allows `pending_apply` only when lock state is exactly `unlocked`; unknown lock reports blocked, with an unrun fixture. P1 handed off PARTIAL after bounded atomic ToolBatch/one-use lease source review and documented missing protected-input/SecretBroker write and Doctor grant schemas; corresponding routes remain unavailable. Active phase owners P3/P5/P6. No tests/provider/evaluation/release operations.

P5 source handoff is PARTIAL after removal of the production callback-based cascade executor; the simulator is test-only. Auth 401/403/407 fall-through and other 4xx stop align with the decision; runtime remains false until P1/P6 acceptance. P6 is PARTIAL after strict settings lock-state corrections; credentialed provider/Doctor remains gated. P3 is active; it identified missing discovery response depth/order/duplicate/mode validation in P1-owned supervisor code, and P1 resumed to close that boundary. No tests/providers ran.

P2 handed off PARTIAL after preserving Session-pinned title models and default-denying the Goal verification UI; no mounted verify action is enabled. Remaining managed acceptance requires P1 verifier launch/restart recovery and P8 settlement. P1 is fixing exact `Verifying` challenge reconstruction; P4 resumed whole-phase source against P1/P3 DTOs. Active owners P1/P3/P4; no checks.

Parent resolved the §12.19 recovery blocker by authorizing a HostKernel-owned idempotent verifier-set prepare/read keyed to the complete authenticated Run/Attempt/epoch/Spec/profile/final-revision/evidence-plan tuple. Persist the complete set before returning IDs; exact retry returns the same awaiting set; mismatch conflicts; partial/UNKNOWN never recreates or replays. P1 owns the durable schema/adapter; P2 resumes once the exact DTO lands. P1 also adds digest-bound optional DAP evaluate permission, missing/false deny. Runtime gates remain false until final acceptance.

P3 handed off PARTIAL after bounded manifest-derived detection and exact-revision aggregate document reads; discovery tools remain hidden pending integrated acceptance, with parser semantics, overlays and cache retirement still gated. P2 resumed alongside P1 for the HostKernel idempotent verifier-set recovery contract. Active owners P1/P2/P4.

P1/P2/P4 source integration: DAP `allowEvaluate` is DAP-kind-only, digest-bound, missing/false deny, and HostKernel checks it before challenge and dispatch for the bound process generation. Verifier challenge sets use a HostKernel-derived idempotency key over complete authenticated Run/Attempt/epoch/Spec/profile/final-revision/evidence-plan pins; exact awaiting rows recover, while mismatch/expired/approved/partial/UNKNOWN never recreate. P2 is aligning Core; all source remains unverified.

P4 added Core DAP `allowEvaluate` configuration/projection defaulting false and a pre-Guard denial unless true; HostKernel schema/retention is P1-owned. Cached LSP status now reads exact-scope HostKernel process state without starting a server. Remaining editor ingress/document and REPL recovery source stays active; DAP attach/REPL execution remain gated. No checks.

P4 now fail-closes REPL callback event projection because no HostKernel callback-read/reply receipt DTO exists; candidate event data cannot be promoted and the local ledger is bookkeeping only. No interpreter execution is enabled.

P4 handed off PARTIAL after default-deny DAP evaluation, exact-scope LSP status, and false-gated REPL callback ingestion. Editor buffers/production ingress, shared debug namespace/ptrace, OS quotas and callback receipts remain. P8 resumed for whole-phase worker/final-Inspect recovery integration against P1/P2's verifier-set contract. Current active owners P1/P2/P8; no tests/evaluations run.

Verifier-set DTO integration: require typed authenticated Goal/Run/Task/Attempt, ownerEpoch, SpecVersion/profile pins, final revision and evidence-plan digest plus verificationRunID, stable setIdentityDigest and challengeSetDigest. P2 cross-checks Core authority; P8 binds final Inspect/terminal settlement to the same set. No opaque-digest-only acceptance; exact retries only, partial/UNKNOWN never recreates. DTO still in progress; no checks.

P2 source continuation (2026-10-21): Core's strict ChallengeSetV1 decoder now consumes the confirmed flat HostKernel pin names and scalar encodings, including UNKNOWN as a terminal non-replay response, checks current accepted Spec/Run and recovered terminal child/spec/final-revision, privately brands decoded authority before settlement, sends the tuple to P8 and requires the receipt echo of verificationRunID/setIdentityDigest/challengeSetDigest. The Goal verification response schema and generated JS DTO carry set identity. Remaining P2/P1/P8 integration: P1 must project full pins from settlement recovery and validate/echo identity on settle_dispatch; P8 must validate and durably bind that tuple to worker/final-Inspect settlement. Runtime remains disabled; no checks were run.


## 2026-10-21 12:57 UTC — implementation continuation / owner refresh

User reaffirmed implementation-first and approved optional Linux cgroup-v2 containment for restart proof. Bootstrap was refreshed from root instructions, trackers, V1 architecture/governance and operative plan. Repo-only boundary remains in force: no host paths, external services, Git remotes, checks/builds/typechecks/audits/provider calls/evaluations/releases, or Git staging/publication. Git state remains mixed and unstaged (198 modified paths, 76 untracked at refresh); one repository worktree; repo-local kernel/target is 627 MB and filesystem reports 817 GB free. No cleanup performed.

Active whole-phase owners (3 child slots): P1 Guard/ExecutionHost (agent_lifecycle_opencode_codex), P3 RepoIntel/Discovery (v1_phase_source_inventory), and P7 stream/render/artifacts/analytics/automation/rewind (arch_audit_contract_flows). P2 source handoff is PARTIAL and not accepted; its exact verifier settlement integration still depends on P1/P8 proof. P4/P5/P6/P8/P9 remain PARTIAL, gated, or queued. P1 cgroup-v2 is optional and Linux-only; assignment requires authenticated delegation, identity is persisted before dispatch, restart recovery reconciles only the same verified cgroup, and uncertain/non-empty state remains UNKNOWN/disabled. No quota guarantees or unsupported native Windows acceptance are implied.

Parent approved two bounded cross-owner source tasks: P3 may add the missing discovery request/page union arms to the canonical RepoIntel JSON Schema matching TS/HostKernel DTOs; P7 may repair only refreshSessionMessages reconnect bookkeeping in packages/tui/src/context/data.tsx to preserve/detect live deltas during canonical pagination, leaving P6 question handling untouched. Parent updated arch_V1/37-RUNTIME-SERVICE-LLD.md §37.11 to make V1 SSE explicitly live-only (no SSE id/global Last-Event-ID), specify per-part sequence/sourceGeneration fencing and canonical owner resnapshot, and record the overlapping-fetch race requirement. These are source changes only. No checks have run. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 12:59 UTC — overlay visibility correction

P1 discovered `kernel/src/cgroup_v2.rs` was hidden by the root overlay ignore policy, despite being included by `kernel/src/lib.rs`. Parent added the narrow `!/kernel/src/cgroup_v2.rs` exception in `.gitignore` and informed P1; the source remains unverified, and the full overlay audit is still deferred with the rest of implementation-first checks.

## 2026-10-21 13:00 UTC — P7 reconnect source handoff; P4 slot refill

P7 completed the source repair of the canonical Session refresh race: overlapping message fetches coalesce; live Session deltas advance generation; pagination retries once; a repeatedly moving source preserves the live projection/cursor rather than overwriting newer events. The change is bounded to refresh/reconnect bookkeeping; P6 question handling was not edited. §31/§45 now reflect this. No checks were run; P7 remains PARTIAL pending full TUI/stream/artifact/analytics/recovery acceptance and P1/P2 dependencies for effectful automation/checkpoint paths.

Available slot is assigned to P4 as a whole-phase source owner for supervised LSP/DAP/REPL integration. Current active owners: P1, P3, P4. P1 cgroup module Git visibility is restored by a narrow root ignore exception; P3 is aligning the missing discovery JSON Schema arms. All three phases remain unverified; implementation-first hold continues.

## 2026-10-21 13:02 UTC — P3 source/docs pass complete; P8 slot assignment

P3 completed its unblocked source/docs pass. The RepoDiscovery request/page union arms now mirror the strict TS/HostKernel DTO in the canonical JSON Schema; §30, §32, and §33 no longer claim discovery is absent and now describe the feature as source-present but gated. Remaining P3 blockers are intentionally fail-closed: registry/cursor use await integrated acceptance, parser-backed semantics lack approved provenance, overlays lack trusted immutable editor-buffer ingress, and cache eviction lacks an authenticated pressure trigger. No schema validation or tests were run.

The freed P3 slot is assigned to P8 whole-phase source integration, prioritizing the P1/P2 verifier-set pins through durable worker/final-Inspect/settlement receipts, then remaining unblocked resource/RC0 source. Current active owners: P1, P4, P8. P1/P4/P8 remain source-only; no validation commands have run.

## 2026-10-21 13:04 UTC — P1/P8 final-Inspect verifier-pin integration

P1 source review closed an identity-binding gap: cgroup `process_kind` is now checked against the persisted capability at preflight, terminal settlement, and startup/restart reconciliation using the canonical stdio process-kind mapping. No validation was run.

P8 confirmed worker terminal settlement already persists and replays opaque verifier-set pins with P2/P8 receipt identity checks, and FAILED/CANCELLED quarantine remains pinless. A newly found source gap is that the P8 managed final-Inspect candidate pin/digest does not yet bind `verificationRunID`, `setIdentityDigest`, and `challengeSetDigest`. P8 owns the worker_durable candidate contract; P1 owns HostKernel prepare/execute/recovery resolution and must pass the exact HostKernel-issued settled token. P2 candidate code is not to be edited. This integration is in progress; no tests.

## 2026-10-21 — comparative harness decision / current phase status

Pi/Codex comparative decisions and event/context mappings: `docs/research/2026-10-21-pi-codex-harness-decisions.md`;
architecture references §§29.21, 30.24, 31.21, 42.16 and 45.26. This changes no phase acceptance
status. P1/P3 source passes are complete but unverified; P4/P8 are partial and gated; P6 is the
next source owner; Codex lifecycle research is in progress. V1 remains PARTIAL / NOT VERIFIED /
NOT RELEASED. No tests/builds/typechecks/audits/provider calls/evaluation/release checks ran.


## 2026-10-21 — Codex comparison completed; whole-phase source owners refreshed

The deeper local Codex lifecycle/event/UI review is recorded in §42.17 and the comparison note.
Codex's separate operation/activity events, reserve→create→persist-lineage→accept-input order,
separate admission/execution/residency budgets, bounded activity overview, and parallel-work
guidance are useful patterns. Its topology/thread history persists, but mailbox/runtime state and
completion notification are process-local/best-effort; HorizonCode's explicit durable delivery,
named wait, Attempt authority, and receipt reconciliation remain the stronger contract. No new
schema/runtime was justified and no upstream code was copied.

Active whole-phase source owners: P2 delegation (Codex research agent reassigned after completing
research) and P6 providers/settings/Doctor/S1 (source inventory agent reassigned after P8 pass).
P1's current source integration and P3/P4/P8 unblocked source passes are complete for now, but
remain PARTIAL/NOT VERIFIED because acceptance and dependencies are open. P8 verifier pins now
flow through all five HostKernel→worker final-Inspect/replay/recovery paths and bind the verifier
IDs/digests in its candidate/receipt; worker fan-out, cache retirement, hard OS quotas and RC0
remain gated. No tests, builds, typechecks, audits, provider calls, benchmarks, or release checks
were run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:10 UTC — P6 handoff and P7/P9 slot refill

P6 completed its unblocked source pass: provider/model routing and explicit free-route eligibility,
settings provenance/lock semantics, offline Doctor, and S1 ownership/callback paths are present.
Provider Doctor TUI now renders the server's VALID/INVALID/UNKNOWN configuration status rather
than conflating a probe PASS/FAIL with configuration validity. Credentials and live probes remain
closed pending P1 authorization; real provider journeys and FEAT/QA acceptance are not run.

The available whole-phase slots now belong to P2 delegation, P7 streaming/rendering/artifacts/
analytics/automation/rewind, and P9 packaging/release-readiness source. All three work source-only;
no validation/release commands run during the implementation-first hold. P1/P3/P4/P5/P6/P8 have
no currently assigned source worker and remain partial/unverified or gated as listed in the phase
ledger. Research/docs are in `docs/research/2026-10-21-pi-codex-harness-decisions.md` and §42.
No changes are staged or published; existing mixed Git work is preserved. V1 remains PARTIAL /
NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:12 UTC — P7 source pass and P1/P2/P9 owner allocation

P7 reviewed all remaining unblocked source and found no safe change beyond the current bounded
stream/redaction, replay fencing/resnapshot, activity, artifact/analytics, automation-management
and checkpoint-preview implementations. Effectful automation remains disabled; checkpoint
capture/restore and transient-event replay remain blocked on HostKernel facts/owners and Guarded
receipts. No tests/builds/audits were run.

Current whole-phase source owners are P1 Guard/ExecutionHost, P2 direct/managed delegation and
Goal review, and P9 local packaging/release-readiness source. The P2 review-inbox component exposed
source issues that its owner is correcting before route integration; the shared session route is
being coordinated to avoid P7/P2 writer overlap. P7/P6 source passes are complete but unverified;
V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED. Mixed Git state remains unstaged and preserved.


## 2026-10-21 13:13 UTC — P1 source pass handoff; P5 slot refill

P1's final source-origin pass found all reachable first-party process origins already rejected
before spawn or fail-closed behind HostKernel readiness. ToolBatch admission, durable receipt and
UNKNOWN reconciliation source are present. No safe P1 source expansion remains. P1 stays
PARTIAL/NOT VERIFIED pending Linux confinement/cgroup restart and crash/cancel/UNKNOWN acceptance;
SecretBroker mutation/live Doctor remain gated on trusted authenticated input/grant contracts.

The freed slot is assigned to whole-phase P5 cascade source closure against approved route order,
explicit opt-in, auth fall-through, provenance/retry/failure bounds, consent, and no paid fallback.
Current owners are P2/P5/P9. No provider calls, tests, builds, typechecks, audits, or release
operations have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:15 UTC — P5 source closure; P3 source owner reassignment

P5 compared the ordered cascade against the approved contract and found the source aligned:
explicit enabled-route order, auth 401/403/407 fall-through without retrying that route, stop on
other 4xx, bounded 429 cooldown/retry, ordered per-route provenance, consent and no paid fallback.
The production callback executor is absent and `WEB_SEARCH_RUNTIME_READY` remains false. P5 has no
unblocked source changes; runtime awaits P1/P6 acceptance.

The freed slot is assigned to whole-phase P3 RepoIntel/Discovery source continuation, reviewing
existing local OpenCode/Codex parser/query patterns and implementing only safe source gaps within
HostKernel's single authority. Parser semantics, unsaved overlays and cache eviction remain gated
unless their exact provenance/ingress/pressure authority exists. Current source owners: P2/P3/P9.
No tests/builds/audits/provider calls were run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:18 UTC — P3/P9 source handoff and active owners

P3 implemented bounded display sanitation and exact tree truncation accounting; canonical paths
remain unchanged. Parser semantics, overlays, public tree/detect, cursors, and cache retirement stay
gated by missing provenance, trusted ingress, or acceptance evidence. P9 completed the currently
unblocked publication hardening source: disabled workflow overlays, guarded direct package publish,
container push rejection before Docker, and distribution-audit checks. Neither phase is verified.

Active implementation owners are P2, P4 and P6. P2 is wiring authenticated Goal review and explicit
PLAN_ONLY/goal.start TUI journeys; it is checking whether trusted accepted-Spec/Profile projections
can replace the user-authored JSON plan editor without adding an unsupported API. P4 owns supervised
LSP/DAP/REPL source. P6 owns provider/model, settings, Doctor, S1 and switching journeys. Continue
implementation only until all unblocked source is complete; verification remains deferred. The
repository-only boundary prohibits external paths/services/remotes. No tests/builds/audits/provider
calls or publication have run. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:21 UTC — P1/P2/P7 source continuation

P4's safe DAP/LSP source fixes are complete; DAP attach and REPL remain gated by missing OS,
namespace/ptrace, quota and callback-recovery support. P6/P8 re-audits found no further safe source
gap; their acceptance remains open.

Active phase owners are P1 Guard/ExecutionHost, P2 managed delegation/Goal flow, and P7
stream/render/artifact/analytics/automation/rewind. P2 is wiring an authenticated accepted-Spec and
immutable-profile projection to replace manual plan JSON where existing server authority permits;
HostKernel must provide canonical profile/scope digests. P7 avoids the P2 route. No tests/builds/
audits/provider operations ran. Preserve mixed Git state; no staging or remote operations. V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:22 UTC — P1/P7 handoff; P5 active

P1's final source audit found no safe change. Process effects stay Linux HostKernel/cgroup-v2
guarded; cancel/crash/restart/UNKNOWN acceptance remains. SecretBroker writes and live Doctor
probes fail closed because protected-input/grant/receipt contracts are absent. P7 found no
additional safe source gap; automation invocation and checkpoint capture/restore remain disabled.

Active owners are P2 managed delegation/Goal flow and P5 web search. P5 is inspecting the existing
Guarded network grant/receipt seam for production route integration. No tests/builds/audits/provider
calls or Git publication. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:23 UTC — P5 complete; P1/P2 interface gap

P5's full source review found no safe gap; the ordered cascade, HostKernel adapter, Guard leases and
receipts are present but runtime remains disabled until acceptance. P2 discovered HostKernel's
PLAN_ONLY response omits canonical per-Task profile and effective permission-scope digests. P1
resumed to add Rust-minted digest pins in the Rust response/schema. P2 owns Core/HTTP/SDK/TUI
projection and selector; no TypeScript-side hashing or user-authoritative pins. `goal.start` stays
gated until exact values flow through. Active owners P1/P2. No checks/provider calls/publication.
V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:24 UTC — P1/P2 digest semantics

Correction: an effective `permissionScopeDigest` cannot be returned by PLAN_ONLY because its Rust
proof binds Attempt ID and owner epoch, which do not exist until Attempt admission. The plan response
will carry distinct Rust-minted `acceptedScopeDigest` and `profilePermissionCeilingDigest` alongside
the exact profile and accepted Spec pins. TUI must label them as planned scope/ceiling. The actual
effective digest appears only after authenticated Attempt admission. This supersedes the 13:23
checkpoint's effective-digest wording.


## 2026-10-21 13:29 UTC — Source continuation and owner ledger

P1's Rust-authored PLAN_ONLY pins and strict schema are source-complete. P2's Core/HTTP/SDK/TUI consumer requires schema v1 and checks sorted one-to-one Task pins against Goal/Run/Spec and profile revisions/digests. The explicit `goal.start` path receives the exact planned Run/Spec pins; planned scope and profile ceiling are labeled separately from Attempt-bound effective permissions. No authenticated accepted-only Goal listing exists, so P2 retains bounded Goal-ID input rather than treating local Session/DB projections as managed authority. Authenticated reviewer identity, self-review denial, same-workspace checks and stale Spec conflicts remain server-owned.

Active whole-phase source owners are P2, P4 and P8. P4 owns all unblocked LSP/DAP/REPL source; P8 owns worker/final-Inspect/verifier-recovery/resource source. P1 has no further source assignment; Linux confinement/restart/cancel/UNKNOWN and protected SecretBroker/Doctor authorization remain acceptance prerequisites. P3/P5/P6/P7/P9 have completed currently unblocked source passes but remain unverified or gated. Local Pi/Codex comparison is in `docs/research/2026-10-21-pi-codex-harness-decisions.md` and mapped architecture sections; no remote fetch/check under repo-only policy. No tests/builds/typechecks/audits/provider calls/release operations. Mixed Git work remains unstaged and preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 13:31 UTC — P2 source handoff and active phases

P2's full source pass is complete: authenticated Goal/accepted-Spec/profile selection; HostKernel PLAN_ONLY Task pin validation by Core; exact Run/Spec revision on separate `goal.start`; reviewer identity from ServerAuth; self-review and stale/unavailable checks; and Session workspace ownership/retry recovery. An accepted-only Goal list is not implemented in the current HostKernel API, so UI retains a bounded Goal-ID field rather than trusting local session/database state.

P4/P8 source audits found no additional safe implementation; their effectful/runtime features remain gated pending Guard, OS, callback, quota, pressure and verifier acceptance. P7 found a gap in user-facing aggregate token/cost analytics and is implementing a bounded, provenance-aware surface. P6 and P9 continue whole-phase source work. Parent added exact ignore exceptions for the three new P2 TUI dialogs so first-party source is Git-visible.

Current active owners are P6, P7, and P9. No tests/builds/typechecks/audits/provider calls/remotes or publication. Mixed Git work remains unstaged and preserved. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:35 UTC — Phase source handoffs and ContextSelection gap

P6 source handoff: bundled model catalog freshness is now UNKNOWN absent signed revision/retrieval time; model-picker API carries local catalog provenance. Existing provider/settings/Doctor/S1 sources are present; real provider probes and selected-free-model journey remain acceptance. P9 source handoff: local container build refs now use HorizonCode namespace/tag; release audit checks hidden policy files. Publication/signing/update and exact-candidate platform gates remain.

P7 source handoff added bounded per-metric token totals by provenance, explicit unknown counts, cost quality counts and per-request details in Debug; no cross-route cost sum is shown because no currency contract exists. It found ContextSelectionV1 currently lacks the approved trust/inclusion/source revision refs and is not consumed by the prompt compiler. P1 owns schema/Rust validation/digest; P7 owns Core compilation and managed request integration. HostKernel computes the digest; Core carries the exact returned digest to model-request provenance. Do not invent profile authority for legacy direct Sessions; managed Attempts must use the exact trusted Task profile pin.

Parent source review fixed P2 plan selection to preserve every accepted Spec capability and filter incompatible profiles rather than weakening the requirement. Exact ignore exceptions expose P2 dialogs. Current active owners: P1 and P7 on ContextSelection. Tests/builds/typechecks/audits/provider calls/remotes/publication remain deferred. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:41 UTC — managed context contract and local competitor review

Current local comparison details: `docs/research/2026-10-21-pi-codex-harness-decisions.md`. The Pi-like tree is OMP fork commit `a536558` (not Earendil Pi and no Pi Durable package); the supplied Durable RFC is treated as design input. Codex tree commit `14830654c` has 206 tracked local modifications. No remote/latest-upstream claims or external access.

Source gap now under P1/P2/P7 coordination: managed Attempt admission currently pins an empty ContextSelection before the real Task prompt is compiled, and one digest cannot represent subsequent model requests after tool results change context. Require a fresh authenticated HostKernel selection digest per provider request, monotonic request sequence under live Attempt/owner epoch, exact Task/Spec/profile/tool/system/context source revisions, and dispatch of the same immutable compiled request. P1 owns Rust/schema/HostKernel, P2 the managed transition API, P7 the Core compiler and prompt path. Keep dispatch disabled until end-to-end source wiring is complete.

P3 completed its unblocked source audit and found a P1-owned symlink blocker: shared workspace revision calculation rejects symlinks before bounded RepoIntel discovery can list without following. P1 must add a typed no-follow observation/revision contract without weakening mutation snapshots. P3 remains unverified; parser/editor/cache/pressure dependencies remain open. Evaluation source is fake-provider-only; the existing benchmark plan already corrects unsupported target figures and stages fake self-check → selected free-route smoke → pinned benchmark smoke → paired held-out baseline/ablation. Tests, provider calls and benchmark runs remain deferred. V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 13:44 UTC — per-request context and HUP status

P1/P2/P7 agreed the managed context boundary: admission pins request sequence 1; every later model request must obtain an exact next `managed_context.advance` receipt, sequence 2..1024, bound to request ID/digest and the live Attempt/session/profile/owner epoch/revision. HostKernel persists bounded reference-only selection state. P1 owns Rust/schema/HostKernel, P2 Core managed-control adapter, P7 the real processor/LLM pre-dispatch boundary and immutable compiled prompt. Source work remains in progress and no managed dispatch gate is enabled.

The HUP runner is fake-only; it validates the experiment manifest/journal/report path but cannot call a provider, execute a benchmark, or produce an official score. Existing docs specify paired frozen baseline/full-harness arms, ablations, uncertainty, provenance and a future staged run order. The numbers in the user-provided target table are not adopted as guaranteed targets; benchmark configurations/splits/score fields must be pinned and compared. No testing/provider/benchmark execution yet.

## 2026-10-21 13:46 UTC — TypeScript/Rust child Session identity mismatch

Found a production source contradiction: TypeScript ManagedControl.admitAttempt rejects selection sessionID equal to the child Session, but HostKernel requires the ContextSelection to identify that exact live Attempt child and separately forbids equality with the parent. P2 owns strict TS parity and requestSequence/requestID/contextSelectionDigest propagation; P7 owns actual provider dispatch; P1 owns Rust truth. This must be corrected before managed request source can be called wired. No tests/checks.

## 2026-10-21 15:53 UTC — Pi/Codex contract mapping; managed pre-admission and P6 provider update

The local Pi/Codex comparison and supplied Pi Durable contract map are in
`docs/research/2026-10-21-pi-codex-harness-decisions.md`; no upstream fetch was performed. P1/P8
identified a circular requirement: P8's full reservation pins included ContextSelection, but Core
must compile that selection on the exact reserved child worktree. The updated §37.22 flow is
`managed.pre_admission_target.reserve` against all authenticated pre-context candidate/profile/
scope/resource facts → Core no-dispatch compile against returned target →
`managed.pre_admission_target.bind_context` with immutable `PreAdmissionContextBound` event →
Attempt admission consumes the same reservation. Stage A has no synthetic ContextSelection and
grants no dispatch authority. P1 owns HostKernel and P8 owns durable stage/recovery; P2 adapts the
coordinator/strict DTOs and P7 preserves the exact prepared request. P2 has been restarted as the
whole-phase owner.

P6 source pass returned: `Provider.managedRouteProjection` resolves the exact active selected model
through the existing Provider owner and projects only opaque endpoint/route revision, stable Auth
SecretRef (or null under exact anonymous-free model eligibility), profile harness and internal
consent/Guard refs. No URL, credential bytes or dispatch is included. Rust must independently
canonicalize the route and derive one-use SecretBroker authority; all managed provider transitions
remain no-mutation UNAVAILABLE until Guarded ExecutionHost transport exists. P6 provider/settings/
offline Doctor/S1 acceptance and P1-dependent effects remain open. Active whole-phase owners: P1,
P2, P8. No tests/builds/typechecks/audits/provider calls/release checks were performed; V1 remains
PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:13 UTC — active V1 implementation checkpoint

| Area | Current owner/state | Remaining evidence or dependency |
|---|---|---|
| P1 Guard/ExecutionHost | Active; terminal output capture is being integrated with immutable ArtifactStore ownership and typed receipt refs | Complete all unblocked source; preserve denied-before-dispatch and UNKNOWN/restart contracts; OS/recovery acceptance later |
| P2 managed/direct child lifecycle | Active; authenticated managed message journal/inbox and receipt flow are being wired | Finish unblocked lifecycle/review/start/recovery source; coordinate typed terminal ArtifactRef projection with P1 |
| Pi/Codex adaptation | Local source comparison active in a documentation-only slot | Exact local files and arch_V1 crosswalk still due; no external/latest-upstream claims |
| P3 RepoIntel | Source pass complete; gated | Workspace no-follow observation and integrated acceptance from P1; remaining provenance/overlay/cache authority remains unavailable |
| Other V1 phases and release | Partial/source-present with cross-phase dependencies | Keep prior phase ledger open; all integrated acceptance, release gates and final verification remain outstanding |

The named attachment was read in full. Parent re-audit of §31.17, §37.22–.24 and VEO-012/VEO-018 resolves terminal artifact scope: persist immutable, Attempt/revision-owned captures and typed refs; keep public/Core range reads unavailable until a succeeded verified managed evidence record links the exact ref; internal verifier use remains HostKernel-authenticated. C: reported 20 GiB free of 454 GiB and the repository occupies 5.4 GiB; one primary worktree. No tests, builds, typechecks, provider calls, benchmark runs, release checks, Git publication or cleanup have run. Mixed Git state is preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:16 UTC — source progress

| Area | Current state | Next implementation work |
|---|---|---|
| P1 | EffectHost no longer persists terminal raw output or fabricates artifact IDs; typed capture metadata/ref and provenance are included in settled receipt | Finish P1 source integration and coordinate HostKernel capture; later run Guard, confinement, cancellation/restart/UNKNOWN acceptance |
| P2 | `packages/core/src/pty.ts` strict typed artifact-reference/provenance projection is present; managed message OwnerLog primitive exists | Wire bounded ArtifactCapture and exact-scope immutable publish in HostKernel; integrate managed inbox prepare/approval/commit/ACK and exact turn receipts |
| P7 | Reassigned active whole-phase source owner | Continue unblocked stream/render/analytics/artifact UI/automation/checkpoint work without touching P1/P2 files; keep effectful paths unavailable |
| Pi/Codex comparison | Focused local-source comparison completed in research note | Design decisions recorded; no latest-upstream or exhaustive checkout claim |

No tests/builds/typechecks were run. Full V1 implementation, cross-phase integration, acceptance and release remain open; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:18 UTC — integration delta

| Area | Progress | Remaining |
|---|---|---|
| P1/P2 terminal artifacts | HostKernel now streams bounded ArtifactCapture with exact effect/Attempt/workspace owner refs and typed ArtifactRef/fidelity/provenance into P1 EffectHost settlement; raw output BLOB/synthetic IDs removed | Continue source integration/recovery; acceptance and public read gating remain open |
| P2 managed lifecycle | Core typed terminal decoder present; managed message OwnerLog and RPC/approval/commit/ACK integration continues | Finish full lifecycle/recovery; fix bounded TUI verifier callback if still malformed |
| P2/P1/P6 provider seam | Ownership resolved: P2 durable request transitions, P1 Guarded one-use authorization, P6 fixed-route Core/SecretBroker transport | Integrate each under §14.24/§37.22–24; provider remains unavailable |
| P7 | Checkpoint target/action decoder tightened; §31.18 updated, §37.11 stale reconnect status corrected | Continue full P7 unblocked source; no checks yet |

No tests/builds/typechecks/provider calls/benchmarks/release gates. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
## 2026-10-21 16:19 UTC — P7/P6 owner update

| Area | Source progress | Remaining |
|---|---|---|
| P7 | Checkpoint preview targets/actions bounded and validated across HTTP/Core/TUI; usage footer uses per-message provenance and truthful cost quality; architecture status updated | Acceptance on integrated revision; automation invocation and checkpoint capture/restore remain P1/HostKernel gated; artifact range read remains verified-evidence scoped |
| P2 artifact UI | `app.tsx` verifier preview checks exact immutable ref/range/completion and base64 bounds before decoding | Later rendered TUI acceptance |
| P6 | Whole-phase source owner active on provider/SecretBroker route adapter plus settings/Doctor/S1 | Keep network sends and live probes disabled until P1/P2 authorization integration and user-authorized test phase |

Active owners: P1/P2/P6. No tests/builds/typechecks/provider calls; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
### 2026-10-21 16:23 UTC — continuation ledger

| Area | State | Remaining implementation / evidence |
|---|---|---|
| Pi/Codex comparison | Focused local source review and decisions recorded; attachment re-read | Not an exhaustive read of every upstream repository or latest remote audit; local Pi-like source is OMP and Codex snapshot is dirty |
| P7 progressive tool discovery | Architecture requires bounded descriptors and next-provider-turn toolset generation; current registry has no generation API | Implement selected HarnessProfileV1 projection, permission-filtered candidate catalog, generation-bound provider input and managed ContextSelection refs; no denied/internal disclosure or Guard bypass |
| P1/P2 managed-message scope | `permissionScopeDigest` requirement confirmed distinct from ceiling digests | P1 owns protocol/schema + helper; P2 owns HostKernel mint/recompute/persist + Core projection; keep dispatch disabled until integrated |
| Verification | Not started by instruction | Begin tests/builds/typechecks only after source implementation across V1 is complete |

No tests/builds/typechecks/provider calls have run. Overall V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.
P2 added HostKernel validation for the managed toolset-generation ContextSelection rows and shared the canonical BLAKE3 domain-separation/bounds contract with P7. P7 is implementing the Core compiler and next-turn expansion. This advances source wiring only; it is not verified and the HorizonCode V1 implementation and acceptance scope remain open.
P1 has added the strict Rust protocol field and domain-separated canonical effective-permission-scope digest helper. P2 is implementing HostKernel minting and durable binding; pre-admission profile-ceiling metadata remains a separate field. This is source-only and not accepted until integrated; managed messaging remains disabled.
Managed provider integration boundary confirmed: P1/P2 authorize and durably fence; P6 uses the existing SecretBroker-backed Core ProviderTransport. No alternate HTTP model transport. P6 is next queued after P7 as the managed vertical critical path; P4 follows. Until end-to-end acceptance, provider sends remain disabled.
P1's protocol DTO change is not phase completion; P1 has resumed whole-phase Guard/ExecutionHost source implementation. P2 is aligning all pre-Attempt reservation comparisons to `profile_permission_ceiling_digest`, separate from Attempt `permission_scope_digest`. P6 provider integration remains queued for next slot.
P2's managed dispatch handoff now carries the immutable Attempt scope digest and rederives it from current Guard proof. Pre-admission reservations use a distinct profile-ceiling digest; old serialized spelling is decode-only. P1 reported and stopped one out-of-boundary host-wide process-table check without modifying processes; remaining work follows repo-only constraints.
## 2026-10-21 16:36 UTC — implementation status refresh

P7's progressive tool discovery/HarnessProfile source is now returned but remains unverified. A parent source review identified that Rust currently shape-checks, but does not recompute, the `horizon.toolset.v1` generation digest referenced in managed ContextSelection; P2 owns reconciliation. P1, P2, and P6/P5 are active whole-phase owners. P1 has non-overlapping ExecutionHost/sandbox/Core process/PTY write scope while P2 holds `host_kernel.rs`; P2 owns managed lifecycle; P6 uses the existing Core Provider/SecretBroker path. Managed `agents.message.follow_up`, managed provider sends, effectful CodeMode, search and other dependent paths remain disabled until their exact durable authority/receipt integrations and final acceptance pass. No tests/builds/typechecks/audits/provider probes/release operations ran. Full V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:40 UTC — implementation ledger refresh

| Phase | Current owner/state | Open implementation / evidence |
|---|---|---|
| P1 Guard/ExecutionHost | Source continuation returned; cgroup identity Attempt-scope pinned | Any remaining Guard/origin/receipt gaps; later integrated adversarial, cgroup restart and OS acceptance |
| P2 managed vertical | Active; Rust recomputes managed toolset generation | Finish distinct managed follow_up proof, inbox/UNKNOWN recovery, reviewer/verifier/current-revision settlement, Core-to-TUI and whole-phase source |
| P3 RepoIntel | Partial/gated | Finish authenticated parser/overlay/query/artifact generation source and acceptance |
| P4 LSP/DAP/REPL | Partial/gated | Finish ingress/policy/recovery; keep effectful routes unavailable pending P1/P3/OS proof |
| P5 web search | Source partial; dispatch gated | Finish Guard/SecretBroker transport integration and failure/consent/recovery acceptance |
| P6 providers/settings/Doctor/S1 | Partial; no-send request preparation exists; queued | Resolve dual-digest contract; finish settings/Doctor/S1 source; later provider/model and explicit free-route journeys |
| P7 stream/artifact/analytics/automation/rewind | Active whole-phase owner | Finish source and docs; keep restore/invocation gated where P1/P2 proof is absent; later full rendered/replay/artifact acceptance |
| P8 workers/resources/RC0/evaluation | Partial/queued | Complete worker settlement/recovery, trusted pressure and evaluation source; preserve unavailable OS quotas and disabled fan-out until proof |
| P9 distribution/release | Partial/queued | Resolve package/license/signing/update/rollback policy and exact-candidate install/release gates |

Active owners: P1 source continuation, P2, and P7; P6/P5 awaits owner capacity/user contract resolution. Parent owns integration. No tests/builds/typechecks/audits/provider calls/benchmarks/release operations ran. Mixed Git state remains unstaged/unpublished. HorizonCode V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:41 UTC — managed follow-up proof decision

Resolved the P2 design gap from §29.5: provider request settlement does not prove a complete assistant turn because it may end in a tool call. P2 will add an authenticated Rust `managed_provider.complete_turn` owner-log transition tied to the exact latest settled request/assistant/response/usage pins, live Attempt and epoch, and absence of in-flight provider work or unresolved effects. That durable completion will mint the separate one-use follow-up wake proof; queued messages remain non-waking. P7 owns the Core final-assistant boundary in `session/processor.ts`/`session/llm/request.ts` and is coordinating the callback with P2; P2 owns Rust/managed-control. Active whole-phase owners: P2, P6 (source continuation), P7. P1 returned a source checkpoint PARTIAL and must be resumed for remaining gaps/acceptance; P3/P4/P5/P8/P9 and final integration remain open. No tests/builds/typechecks/audits/provider calls/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 16:42 UTC — P1/P2/P6/P7 orchestration update

P6/P5 returned SOURCE COMPLETE for currently unblocked code, not verified: catalog/settings/offline Doctor/S1 ownership projections and ordered search auth-failure behavior are present; provider and search dispatch remain false-gated. The managed transport scaffold prepares an exact request and transport digest without lease or send. The user decision on whether HostKernel must bind both normalized input and exact SDK transport digests is still pending; this is a concrete blocker for managed sends, while independent P6 source is closed. P1 has resumed whole-phase source audit. P2 and P7 coordinated a distinct `managed_provider.complete_turn` proof because a settled provider step may be an intermediate tool-call response; P7 will invoke the P2-owned strict HostKernel transition only after `handle.process()` returns at the exact final assistant boundary, not on `finish-step`. Active whole-phase owners: P1, P2, P7. No tests/builds/typechecks/audits/provider calls/benchmark/release operations ran.

## 2026-10-21 16:44 UTC — P7 final managed turn callback source

P7 now calls P2's `ManagedControl.completeManagedProviderTurn` only at the terminal SessionPrompt loop exit: persisted latest assistant entry, final finish reason, matching current-user parent, and no non-orphan tool calls/work. The callback passes the assistant entry ID and live authority only. P2's authority retains exact latest HostKernel settlement pins; missing/mismatched settlement fails closed. The callback is not evidence that a managed provider send ran: P1/P2/P6 guarded transport and settlement remain unavailable/unaccepted. Updated §31 and §45 flow/status. No tests/builds/typechecks/audits/provider calls ran; P7 remains PARTIAL / NOT VERIFIED.


## 2026-10-21 16:45 UTC — P1 checkpoint and P2/P3/P7 active

P1 returned source-complete for currently unblocked work, not verified. `EffectHost::begin_execution_dispatch` now returns UNAVAILABLE before validation/persistence on non-Linux, and §14.21 records the platform gate. P1's audit found bounded ToolBatch admission, serial receipt/lease handling, fixed Guard-pinned shell execution, and fail-closed unsupported effect origins; HostKernel/P2 authority integration and later adversarial/OS acceptance remain. The freed slot is assigned to full-phase P3 RepoIntel/Discovery source work. P2 is implementing a durable `managed_provider.complete_turn` proof from the latest exact HostKernel SETTLED request; P7 wired the caller only at the persisted terminal runLoop boundary (final assistant, current user parent, no non-orphan tool work). Parent review identified a required restart path for recovering exact settlement pins after `.settle` before `.complete_turn`; P2 is addressing it, otherwise UNKNOWN/unavailable. P6/P5 source is complete for unblocked work, with provider/search still closed pending the user dual-digest answer and Guard/SecretBroker integration. Active owners: P2, P3, P7. No tests/builds/typechecks/audits/provider/benchmark/release operations ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 16:51 UTC — source continuation ledger

| Phase | Owner/state | Remaining source implementation |
|---|---|---|
| P1 Guard/ExecutionHost | Active; non-Linux execution fails closed | Finish actual Guard/ExecutionHost confinement, complete origin mediation, managed verifier/provider authorization and recovery interfaces; P2 exclusively owns HostKernel files |
| P2 managed vertical | Active; managed complete-turn and exact settlement source | Finish inbox ACK/follow-up one-use wake, reviewer/verifier/current-revision evidence, restart/conflict recovery and Core-to-TUI |
| P3 RepoIntel | PARTIAL; authenticated lexical query/discovery/read | P1 symlink revision, P4 LSP, parser provenance/bridge, immutable overlay producer, P8 pressure/retirement authority are dependencies |
| P4 LSP/DAP/REPL | Queued | Implement supervised lifecycle and guarded policy; unavailable pending real P1/P3 acceptance |
| P5 Web search | Partial/gated | Finish ordered cascade, route provenance, failure/consent/recovery through P1 Guard and SecretBroker |
| P6 providers/settings/Doctor/S1 | Active; repairing `session/llm.ts` and provider settlement seam | Bind normalized and exact non-secret SDK transport digests to one-use selected-route authorization/settlement; finish settings, Doctor, S1 and TUI switching |
| P7 streaming/artifact/analytics/automation/rewind | PARTIAL; final-turn callback source present | Remaining stream/replay/artifact UX; effectful automation and rewind stay gated on P1/P2 |
| P8 workers/resources/evaluation | PARTIAL/queued | Worker settlement/recovery and authenticated pressure/evaluation; no unsupported OS limits or fan-out |
| P9 distribution/release | PARTIAL/queued | Package/install/rollback and final release gates |

Verifier execution follows §§12.19/37.22: keep the coding Attempt live; bind the `managed_run` verifier effect to that same Attempt/current revision, trusted verifier principal and distinct authenticated reviewer. Research provenance was corrected: Codex/OMP are ignored local references; Codex has no local Git identity so the asserted pin is unverified; OMP is not official Earendil Pi; Pi Durable is user-supplied design input. Adopt progressive context, branch/compaction provenance, usage/activity UI and explicit bounded child lifecycle. Keep Core/Rust authorities and existing CodeMode; defer cache warming, hosted sharing, additional runtimes/catalogs and unguarded nested effects.

A focused P1 test selector was mistakenly invoked against the implementation-first hold; Bun failed parsing concurrent `packages/opencode/src/session/llm.ts:1016` before any test body. It was not retried; P6 owns the repair. No acceptance tests/builds/typechecks/provider calls/release or Git publication were performed. Current status: PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-21 17:12 UTC — V1 implementation status refresh

Implementation is still underway; tests/builds/typechecks are intentionally held until source scope is complete. Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle, P4 LSP/DAP/REPL. P6 is open and queued for the next slot; P3/P7/P8/P9 and final integration remain open.

P1 source now distinguishes the trusted verifier process principal from the authenticated reviewer principal across cgroup containment and receipt identity. P2 is integrating the distinction into HostKernel invocation construction. P2 added a dedicated managed inbox persistence seam and is wiring exact prepare/ACK/restart recovery and safe-boundary wake. P5's cascade source implements ordered explicitly enabled routes, auth 4xx fallthrough, bounded 429 handling, transient retry and provenance, but is disabled. P6's Core triple-digest authorization handle exists; the Rust/HostKernel durable begin/settle and existing Auth/SecretBroker/Provider sender are not connected, so provider dispatch remains unavailable.

Remaining implementation by phase: P1 complete Guard/origin/recovery source; P2 managed lifecycle and verifier/review/current-revision vertical; P3 parser/overlay/pressure source; P4 supervised LSP/DAP/REPL source; P5 Guarded search integration; P6 managed provider sender plus provider/settings/Doctor/S1 completion; P7 stream/artifact/analytics/automation/rewind; P8 worker recovery/pressure/evaluation; P9 distribution/install/update/rollback. Then begin requested verification, cross-phase acceptance and release gates on the integrated revision. No tests/builds/typechecks/audits/provider calls/release/publication/cleanup were performed in this continuation. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**17:22 UTC implementation delta:** P4 source pass returned with bounded typed REPL callback read/reply contracts and exact Rust-compatible MessagePack digest source; no acceptance ran and all P4 process/callback paths remain gated. P7 is active on the managed follow-up runner seam and remaining stream/artifact/analytics/automation/rewind source, with exclusive `session/prompt.ts` and `processor.ts` ownership. P2 owns its HostKernel route/persistence only. P6 managed provider transport remains queued. V1 is still PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-21 implementation continuation:** P1's current source review is complete but acceptance is outstanding: Linux guarded shell/ToolBatch paths are present; unsupported platforms and REPL stay unavailable without OS proof. P2 added HostKernel validation of an exact one-use wake claim for managed context advance and the typed `TaskPromptOps` bridge; P7 owns SessionPrompt injection. P6 resumed provider DTO/record/transport integration with strict normalized-request, SDK-transport, and SecretBroker operation digests plus one-use authorization; no provider dispatch is allowed yet. Active owners are P2/P6/P7; P3/P4/P8/P9 remain open/queued. Source implementation is still underway. No tests/builds/typechecks/audits/provider calls/releases/Git publication ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**Continuation delta:** P7 source pass is complete for currently unblocked work but not verified. Remaining P7 effectful automation/rewind paths stay gated on scheduler, same-revision observation and Guard routes. P7 found `claimManagedMessageWake` reads a permission-scope digest missing from the displayed Attempt scope; P2 owns the contract fix. P3 has resumed whole-phase source implementation. Active owners P2/P3/P6. No verification/provider/release/Git operations ran.

**P2 contract delta:** exact managed scope now includes required `permissionScopeDigest` and digest-shaped `workspaceRevision`; follow-up claim/context ordering is defined and HostKernel call-site wiring awaits P6's exact provider DTO contract. No checks run.

**Writer ownership correction:** provider DTO/OwnerLog edits crossed P6 into P2-owned managed-control files. P6 will hand off exact hunks and stop editing them; P2 pauses those files and continues non-overlapping coordinator/HTTP/Task source, then owns HostKernel integration. P6 continues exclusive LLM/ProviderTransport and other non-overlapping P6 source. No checks ran.

**P3 source delta:** shared registry installs tree/detect but keeps them hidden behind experimental + HostKernel feature + source-acceptance gates (closed by default); removed the unused local RepoIntel node. Discovery's bounded no-follow revision observer is documented separately from strict mutation revision. Overlay and pressure remain P1/P8 dependencies. No checks run.

**P3 handoff:** PARTIAL/source-only. Tree/detect fail-closed registration and HostKernel-only query ownership are implemented. Overlays need P4 buffer producer and P1 mint; parser semantics remain unavailable under §42.11; pressure and persistent protected-cache lifecycle require P8/P1; symlink journey unaccepted. P4 has resumed for full source phase. Active owners P2/P4/P6. No checks ran.

**Managed follow-up compiler:** P2 will own a narrow no-dispatch exact-body preparation helper in the idle P7 `prompt.ts` scope, reusing Core runLoop/context compilation and making no transcript mutation. P7 will reconcile it later. If exact next body cannot be produced from real child history, follow_up stays disabled; no seq-1 replay or fabricated body.

**P6 source checkpoint:** current unblocked provider/settings/Doctor/S1 source pass is complete, not accepted. Managed sends await P1 Guarded ExecutionHost and P2 HostKernel wiring. The freed slot is assigned to P8 whole-phase worker settlement/recovery, pressure/resources and evaluation source. Active owners P2/P4/P8. No checks/provider calls.

**Managed follow-up ACK boundary:** an exact post-message-commit/pre-provider-dispatch callback is authorized to consume/ACK the managed inbox item using refreshed scope; ACK failure/UNKNOWN blocks dispatch. P7 will reconcile the P2-owned bridge. Direct/queue behavior remains separate.

**P8 source delta:** success settlement rejects unattributed/user-owned final Inspect across live and replay paths; failure/cancel remains quarantined. No checks run.

**P4/P1 delta:** P4 source is PARTIAL with typed callback DTOs, but callback ingress, denial receipt, DAP product route, unsaved-buffer authority and acceptance remain unavailable. P1 resumed for Guard/ExecutionHost reconciliation and the P6 managed provider adapter; P2 owns HostKernel dispatcher. Active owners P1/P2/P8. No checks ran.

**Provider Guard decision:** P1 will add dedicated internal `providers.infer` as the canonical Guarded action for §14.24 managed model sends. It binds the selected provider/model/harness/route, normalized/SDK/SecretBroker digests, Attempt/epoch, consent/budgets and one-use permit. It is not model-callable; `web.search` and generic outbound HTTP are not substitutes. No send until P2/P6 wiring and acceptance.

**P2 follow-up source delta:** exact runner wiring now exists at both managed Task entry points, including no-dispatch compilation from real history and post-message-commit/pre-send consume+ACK. Crash-after-consume recovery and Rust provider digest echoes remain in progress; actual provider send stays gated.

**P8 restart-disposition source delta:** P8 added source for current-epoch fresh Inspect recovery before releasing a quarantined worktree after success; it binds original settlement/Attempt/worker, root/owner, P2 terminal/quiescence and current Guard receipt. Cross-epoch historical Inspect cannot release. Pressure/cache/RC0 integration remains under source review; no checks run.

**P8 handoff:** source-complete for unblocked P8 work only; current-epoch recovery API is present. P1/P2 integrations and acceptance are outstanding, so quarantine remains. Pressure/cache/RC0 and unsupported OS quotas stay unavailable. P9 has resumed for whole-phase release/distribution source. Active owners P1/P2/P9. No checks or release actions.

**P1 provider Guard source delta:** internal sealed `providers.infer` and EffectHost prepare/authorize/consume source are present; challenge/lease originate in HostKernel/Guard and unresolved permits become UNKNOWN. P2 is correcting route DTO authority accordingly. P1 also added the REPL durable page-reader seam. No acceptance ran.

**P2 follow-up recovery delta:** pre-dispatch scope/prompt/inbox check, exact consume, and durable HostKernel ACK are now wired; ambiguity blocks the model send. REPL callback route remains unavailable pending an authenticated frame codec/IO sequence contract.

**P9 source delta:** clean-release pipeline had a source mutation after candidate digest; P9 is correcting the first-party build guard/preparer so build input remains immutable. No build/release action.


## 2026-10-21 18:03 UTC — V1 source implementation continuation

Parent re-read the required bootstrap in order. Repository-only boundary remains absolute; mixed unstaged Git state is preserved. Source-first hold remains: no tests, builds, typechecks, audits, provider calls, release operations, remotes, staging, commits, cleanup, or external paths. Repo-local free space remains ample from the last repository-contained inspection (814 GB available; `kernel/target` 627 MB); no build has run since.

Current whole-phase owners (actual live slots): P1 Guard/ExecutionHost, P2 managed lifecycle, P9 distribution/install readiness. P1 reports the sealed internal `providers.infer` EffectHost prepare/approve/consume/settle/UNKNOWN/recovery source with exact request/route/SecretBroker/Attempt bindings; remaining end-to-end HostKernel/Provider/SecretBroker wiring is P2/P6-owned and gated. P2 owns the HostKernel + `session/managed-control.ts` API/response contract; the next P6 owner must own `session/llm.ts`, ProviderTransport, and provider/SecretBroker send callbacks to avoid shared-file races. P2 continues follow-up, reviewer/verifier/current-revision, P8 settlement integration and REPL fail-closed review. P9 is closing unblocked local source; no candidate build or release action.

Queued whole-phase owners for newly freed slots: P6 first (managed provider sender and remaining provider/settings/Doctor/S1 integration), then P3/P4/P5/P7/P8 as their dependencies and owner slots permit. All phase source remains unverified; V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.


## 2026-10-21 18:06 UTC — active owner correction and P6/P7 dispatch

P1's unblocked source phase has now returned source-complete (not accepted). P1 reports Guard checks canonical capability membership through P2's `canonical_capability_id_is_registered`; P2 confirmed the implementation helper is `managed_control::canonical_capability_id_is_registered(&str) -> bool`. P1's provider Guard/EffectHost contract is ready for P2/P6 integration; REPL remains unavailable without the authenticated HostKernel route and sourced interpreter frame codec. P9 returned source-complete for unblocked local packaging/audit source, not release accepted.

Freed phase slots were immediately assigned to P6 (existing Provider/SecretBroker sender plus settings/Doctor/S1) and P7 (stream/render/artifact/analytics/automation/rewind). Actual live owners: P2, P6, P7; P2 exclusively owns HostKernel + managed-control files and is correcting stale §17.15/§17.17 ownership notes. P7 is reclaiming its prompt/processor files after reconciling P2's temporary no-dispatch helper. P1/P9 must be resumed by the parent for integrated acceptance after source freeze. Queued P3, P4, P5 and P8 remain open; start whole-phase owners as slots free, based on dependency readiness.

No verification/provider/release/remote/Git mutation has occurred. Mixed working tree preserved. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**18:08 UTC integration finding:** Parent source inspection found the managed provider prepare input still contains caller-projected `guardChallengeID` and `capabilityLeaseDigest` (`ManagedProviderRouteProjectionV1` and the Rust `managed_provider_prepare` serializer/strict response shape). This conflicts with P1's HostKernel/EffectHost contract: HostKernel must create the challenge/effect only after prepare is durably recorded; callers cannot supply challenge or lease authority. P2 owns removing these input fields and exposing the host-minted prepare/approval response, then the post-approval one-use dispatch authorization. P6 will consume the exact new response in the existing Provider/SecretBroker sender. Provider sends remain disabled until P1/P2/P6 integration and final acceptance.


**18:10 UTC P7 continuation:** P2 has handed prompt.ts back to P7; the temporary managed follow-up seam is now P7-owned for reconciliation. P7's full source audit identified missing timezone-aware durable automation scheduling/invocation source and checkpoint capture/restore implementation beyond the existing preview UI/endpoint. P7 is implementing the schedulable/control source while keeping invocation gated until P1/P2 receipts are accepted, and will implement checkpoint lifecycle only where complete same-revision no-follow filesystem/Git observations and Guard routes exist; otherwise restore remains unavailable. P2 retains HostKernel. No tests or builds run.


**P7 source correction, 18:11 UTC:** A parent source search found that the canonical Rust automation already contains timezone-aware schedule fields, due-occurrence logic, missed-run handling, and deduplication in `kernel/src/automation.rs`. Therefore P7's earlier statement that a scheduler model was absent is superseded: P7 will reuse and wire that existing authority, not build a parallel scheduler. The production Guarded invocation boundary may still be missing and remains gated. P7 will also inspect the existing `kernel/src/checkpoint.rs` before changing checkpoint lifecycle source.


**18:13 UTC automation integration finding:** P7's source audit found `AutomationGuardContextV1` currently impersonates `SessionBatch`, which violates §§14.1/14.2; the action invocation also lacks stored/resolvable arguments. The canonical Rust scheduler exists, but effectful invocation still needs a dedicated host-selected `AutomationRun` Guard origin/policy (P1), plus exact HostKernel prepare/begin/settle/reconcile and canonical action resolution (P2). P7 will add only its durable schedule candidate/preview/payload projection and TUI source, leaving invocation unavailable until those contracts arrive. This supersedes no prior scheduler implementation; no duplicate scheduler is authorized.


**18:16 UTC provider authority update:** P2 has removed caller-projected Guard challenge/lease from the managed route projection and split the HostKernel-minted challenge (`prepare`) from approved lease/opaque send authorization (`begin`); OwnerLog no longer records a lease at PREPARED. P6 reports the sender contract is aligned, but HostKernel prepare/begin/settle still return `UNAVAILABLE`, and route consent still needs a trusted source. P2 now owns activating the actual Guard/EffectHost-backed durable lifecycle using P1 interfaces; P6 owns resolving authenticated user consent and the existing Provider/SecretBroker sender. No send is enabled.


**18:19 UTC managed inference consent decision:** Architecture review of §§14.24/.25, 16.17, 37.22/.23 found no accepted separate persistent provider-enable setting for inference routes. Use the exact HostKernel-created Guard approval challenge as per-effect route consent, bound to the selected provider/model/harness/endpoint revision, billing/budget class, live Attempt and request. Do not accept caller `consentRef`, infer consent from credentials, or add another config authority. Existing user-selected provider/model remains authoritative; persistent web-search route enablement stays a distinct setting. P2 is recording the contract in §14.25/§37.23 and implementing OwnerLog approval pins; P6 carries the host-issued challenge proof through the existing Provider/SecretBroker sender.


**Automation scheduler correction (18:22 UTC):** Parent's 18:11 source note was wrong and is superseded. `kernel/src/automation.rs` stores `schedule_expression`/`timezone` and processes externally resolved UTC `DueOccurrenceV1` records; it has no cron/timezone resolver or producer. §31 explicitly says not to add an ad hoc parser. P7 removed its TUI parser/preview. Scheduled execution remains blocked until an accepted canonical timezone-aware Rust scheduler source is available; no external fetch/dependency install is allowed under the repository-only boundary. P7 is documenting this exact limitation and can complete the fixed-input payload/Guarded invocation source, but must keep scheduling unavailable without the resolver. Proposed action inputs are immutable bounded user-authored payloads, versioned with the AutomationDefinition, validated against the canonical action schema at save and dispatch, and digest-bound to Guard approval/receipt; dynamic model args and raw secrets are forbidden.

## 2026-10-21 — active source ledger correction

Managed provider consent pinning had a circularity: prepare required caller-projected `consent_ref` even though accepted §14.25/§37.23 authority makes the fresh HostKernel Guard challenge the per-request consent. Parent removed `consent_ref` from Rust `ManagedProviderPrepareBindingV1` and `ManagedProviderAuthorizationPinsV1` validation and digest material in `kernel/src/http_execution.rs`; the exact selected route/request pins remain and Guard challenge/lease are retained only after prepare. P2 and P6 were asked to align their integration; this does not constitute P1 completion. Active phase owners are P2/P6/P7; P1 is next queued. P3/P4/P5/P8/P9 and final integration/release remain open. No verification commands ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

### P7 automation source checkpoint — 2026-10-21

P7 added immutable fixed action payload/schema pins with v2 OwnerLog migration, bounded canonical JSON validation and Core/TUI projection. Remaining integration is P2 HostKernel parser/Guard projection plus P1 authenticated canonical schema validation and secret/opaque-ref policy. Legacy unbound definitions and all automation dispatch remain unavailable. Scheduler resolver is still absent; the Rust occurrence state machine expects externally resolved due times and §31 disallows a new ad hoc parser. No checks ran.

**Managed provider approval flow — 2026-10-21:** P2 resolved the integration to the existing authenticated Guard UI path: HostKernel registers the challenge; TUI resolves it through `effects.resolve_approval_set`; only then may begin mint the send authority. P2 also aligned HostKernel automation parser/summary fields with P7. These source seams remain unverified and managed sends/automation invocation remain disabled pending P1/P2/P6 integration.

**Critical P1 approval gap — 2026-10-21:** existing managed challenge resolution and TUI are verifier-only. Provider inference cannot be approved through them until P1 implements the canonical `providers.infer` HostKernel challenge path and exact trusted projection/UI eligibility. P2/P6 remain fail-closed until this arrives. P1 is first in the queued phase list when a slot opens.

**P7 trust-boundary correction — 2026-10-21:** caller-entered action schema digests must not reach Guarded automation prepare. P7 is gating create/update before prepare until P1's authenticated canonical registry resolver exists. HostKernel parser support alone is not validation; invocation stays unavailable.

**P6 transport source update — 2026-10-21:** managed Provider SDK selection rejects resolved ambient/provider/model credentials and preserves existing SDK `languageModel` behavior; the bounded request adapter rejects credential-shaped URL query parameters. No check ran; dispatch stays disabled pending P1/P2 integration.

P6's managed LLM unavailable reason now lists the remaining Guard/authorization/transport/settlement prerequisites truthfully. No dispatch gate opened; no verification ran.

**Provider integration remainder — 2026-10-21:** managed provider settlement/UNKNOWN methods and fresh send-handle dispatcher still lack production call sites. P2/P6 must wire the existing SDK fetch/Auth path, persist final assistant-entry/usage settlement and reconcile UNKNOWN; no managed provider send may be enabled before that path and P1 approval acceptance are complete.

**Provider ownership split — 2026-10-21:** P2 is responsible for HostKernel durable transitions, P6 for the existing SDK/Auth transport callback, and P7 for final persisted-assistant/usage settlement and UNKNOWN orchestration in prompt/processor. Exact DTO alignment remains in progress. Automation create/update are now disabled before effect prepare pending P1 authenticated schema validation.

**Response digest contract open — 2026-10-21:** there is no normative responseDigest formula/source verifier. Proposed reuse is canonical MessagePack of the exact schema-decoded persisted Assistant entry with a versioned BLAKE3 domain, separately deriving usageDigest per §12. P2 must establish this contract or an existing authoritative alternative before P7 settles provider effects.

**Response digest resolved — 2026-10-21:** §37 now defines BLAKE3 over the versioned domain plus canonical MessagePack of the exact schema-decoded persisted Assistant row; `usageDigest` remains separately derived under §12. P7 owns settlement callback wiring; this is source-only and unverified.

**Route authority gap — 2026-10-21:** managed Attempt currently pins provider/model but HostKernel accepts harness/route/endpoint revision/credential reference from the per-request Core projection. P2 is requiring admission-time resolution from existing Core Config and immutable secret-free Attempt route pins; P6 is identifying the canonical resolver. No second registry; route dispatch remains gated until exact pins are authoritative.

**Route authority source found — 2026-10-21:** reuse existing `Provider.managedRouteProjection` plus Auth's metadata-only SecretBroker refs. At managed Attempt admission, pin its six-field secret-free DTO from the Task's AgentProfileV2 selection; each provider request re-resolves and must equal the pin. The existing adapter rechecks endpoint revision before SDK construction. No second route registry or separate config revision was found.

## Current V1 phase roster — 2026-10-21

Quota recovery relaunched whole-phase owners P1 (Guard/ExecutionHost), P2 (managed/direct lifecycle), and P7 (stream/render/artifact/automation/rewind). P6 (providers/settings/Doctor/S1) remains open and queued first when a slot frees; P3/P4/P5/P8/P9 and P0 integration/release gates remain open. The attachment's comparison requirement is tracked by `docs/research/2026-10-21-pi-codex-harness-decisions.md`. Source-only hold remains; no final evidence is claimed. Preserve mixed Git and repository-only boundary. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED.

**P1 approval resolver source update — 2026-10-21:** P1 reports dedicated managed `providers.infer` EffectHost resolution and the nonsecret approval projection in source. P2 still must wire HostKernel challenge registration/serialization and capability-specific UI source mapping; provider dispatch remains gated and no checks have run.

## 2026-10-21 19:08 UTC — source-only release status

No V1 release criteria are accepted yet. The active phase owners are P1/P2/P7. P1 reports a dedicated exact-binding provider inference approval resolver and strict nonsecret UI projection; P2 still owns the HostKernel challenge-to-approval mapping and durable managed provider lifecycle; P7 is implementing the persisted-row response digest adapter. P6 is queued first, with P3/P4/P5/P8/P9 and P0 integration remaining open. User-directed implementation-first hold remains: do not run tests/builds/typechecks/audits/provider probes/release commands until source implementation closes. Repo-only boundary, mixed Git preservation and no remote/Git mutation remain active. Release state: PARTIAL / NOT VERIFIED / NOT RELEASED.

**Managed multi-step provider contract (2026-10-21):** tool calls remain supported. Each actual provider dispatch must use a distinct monotonic Attempt sequence/request ID, persist and settle its exact indexed step-finish plus point-in-time Assistant snapshot before any effect/next send, and bind settlement to canonical persisted data. Completion requires the final response and ordered known settlements. §37.22 and §45.8 capture the decision; implementation and verification are still incomplete.

The managed response step receipt also needs a first-party strict schema overlay for persisted `stepFinishIndex` and `usageProvenance` because the inherited upstream `StepFinishPart` schema does not define those fields. Do not rewrite the pinned upstream schema.

**19:15 UTC:** P1 remains source-partial and owns integration repair; P6 has resumed as a whole-phase source owner alongside P2/P7. P3/P4/P5/P8/P9 and P0 acceptance remain open. Provider sends/probes and other effects remain disabled until their authenticated contracts and integration acceptance exist. No verification or provider call occurred.

**ToolBatch provider ordering gate:** managed effects remain unavailable until validated pending tool calls and their indexed persisted provider response snapshot are durably settled before Guard admission; buffered stream events must not duplicate persisted transcript parts. P7 owns the narrow callback seam; P1 retains Guard admission ownership.

**Provider vertical source checkpoint 19:28 UTC:** P7 has a strict v2 per-step persisted snapshot receipt and is wiring persisted-before-Guard ordering through a narrow ToolBatch callback. P2 is implementing HostKernel prepare/approval/consume/settle with per-dispatch step identity; P6 is fixing anonymous OpenCode free-route credential handling against P2's exact authorization DTO. No validation or network call has occurred.

Overlay audit source correction: narrow `.gitignore` exceptions now expose P7's `managed-provider-entry.ts` and `managed-provider-step-finish-v1.ts`; both are Git-visible untracked and unstaged.

P6 source now carries exact route/request, challenge/effect/lease/binding pins through Auth consume/UNKNOWN; P2 still owns matching HostKernel begin authorization. No provider send has been run.

## 2026-10-21 — Architecture-first contract freeze

All 47 architecture Markdown files have received full-line review across assigned coverage; relevant design, UI/Settings, HLD/LLD, flows/events, schemas, acceptance catalog, provenance and release text is reconciled. Static schema evidence: 52 JSON files parse, 50 schemas/OpenAPI pass Draft 2020-12 checks, 793 refs resolve, safe JSON integer bounds and DecimalU64 boundary cases pass, `git diff --check` passes. These checks do not establish runtime integration.

Settled implementation target: one explicit, revocable/expiring DirectSessionGrant for low-friction in-scope coding; existing CodeMode interpreter exposed only via canonical `codemode.execute` after its bounded normal-Guard waves pass; trusted HostKernel search route plan from intent-only request, default keyless cascade plus separately enabled auth routes, bounded per-route attempts; V1 ContextService/ContextLedger; snapcompact deferred. Primary-source research and exact docs are captured in arch_V1 decisions/provenance.

Source-only blockers/gaps: Rust Guard/ExecutionHost and direct grant runtime integration; CodeMode model-visible registry adapter and nested MCP Guard dispatch; search TS/runtime route-plan digest and attempt identity projection/20-attempt bounds/index limits; remaining P1–P9 full-phase source work and cross-phase integration. Owners are P1, P2 and P5; P6 queued next. User requested no product testing until implementation completes. Overall release: PARTIAL / NOT VERIFIED / NOT RELEASED.

**Direct-grant contract refinement (2026-10-21):** HostKernel authenticates the explicit UI grant/revoke request and derives all authority pins; Rust EffectHost recomputes the domain-separated canonical grant digest, persists/revokes monotonically, and checks active pins at each Guard admission. A grant decision never dispatches the pending effect; re-prepare and Guard are required. `DirectSessionGrantChangedV1` is a sequence/source-generation-fenced projection with no caller-supplied identity. P1/P2 own Rust authority and HostKernel/Core issuance respectively. This does not change current source status or acceptance gates.

**2026-10-22 continuation:** P1 added private EffectHost CodeMode run/wave source; P2 is integrating HostKernel lifecycle and P5 is implementing strict TS lifecycle codecs and search. Cross-owner lifecycle DTOs are being aligned: start, next frame, wave bind/result, cancel. Canonical search bounds are 10 routes × 2 attempts = 20; §12.9's stale 22-attempt wording was corrected. No tests/builds/typechecks/provider calls/audits ran. P6 is queued next, then P4/P7/P8/P9 and remaining P3 work. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**2026-10-22 07:58 UTC:** Corrected the CodeMode direct-root authority mismatch in §37.24/schema: direct root Session is session/workspace/grant scoped with no Attempt; managed execution is live-Attempt scoped; direct child-turn pins exist only for actual direct children. Corrected the two digest roles: HostKernel public digest over ordered durable receipt refs/digests for the helper frame versus Rust's separate private batch/call/effect receipt digest for settlement. P1 is updating authority, P2 wiring RPC and reports the independent verifier ingress still disabled, P5 implementing strict codecs. All remain source-only, gated, and unverified.
## 2026-10-22 implementation checkpoint — permissions, Explorer/editor

Source work continues under the implementation-first hold. Active phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel, P5 web search/CodeMode. Permission UX decision changed per user direction: `/permissions` uses independent sandbox and approval controls; default Ask for approval is `workspace-write` + `on-request`; Full access is explicit `danger-full-access` + `never`; normal workspace coding does not prompt per effect. All effects remain on common Guard/ExecutionHost with current identity/scope, budgets, receipts and UNKNOWN reconciliation. This is a contract/UI design update only; runtime/API integration and UI are unfinished. See `arch_V1/contracts-v2/direct-session-permission-mode-v1.schema.json`, DEC-V1-28 and §16.19.

Explorer: no general workspace pane; only Git diff tree UI. `repo_tree`/`repo_detect` bounded authenticated adapters exist but remain hidden behind false readiness. Editor: prompt editor exists; external `$EDITOR` launch is disabled; LSP client/supervisor source exists with direct-root workspace snapshot connected; unsaved-buffer overlay, parser-backed symbol navigation, effectful LSP code actions/rename, DAP and REPL remain gated. No tests/builds/typechecks/audits/provider probes run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## External editor support (DEC-V1-33)

V1 design now supports the user's existing terminal editor or GUI editor CLI from the
HorizonCode CLI/TUI. Profiles are user-owned immutable Core Config; terminal launchers
use foreground PTY handoff, GUI launchers require wait-for-close, and no raw `$EDITOR`
string or model launch request is executed. P1 owns Guard/containment/process receipts, P2
owns HostKernel launch/reconciliation, parent owns Core/TUI integration. See
`arch_V1/contracts-v2/external-editor-profile-v1.schema.json` and §§4.17/12.22/14.27/
16.20/32.44/37.28. Current state is DESIGNED, not WIRED or verified; `openEditor` is still
unavailable. No tests/builds/typechecks ran. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## Explorer/editor visibility and command entry (2026-10-22)

Product decision: the default coding session is a single pane. Explorer/editor UI is not
shown as a persistent panel by default. `/editor` opens the Explorer overlay;
`/editor --side` explicitly opts into a right-side Explorer/editor pane for the current
session. Selecting a file and choosing Open launches the user-configured profile, managed
in `/settings` → Editors. Prompt scratch editing is accessed in `/editor`; no always-visible
editor action is added to the composer. This is a UX contract update, not runtime evidence;
the command route stays unavailable until Guarded launch and its acceptance gates pass.

## Phase owner update — 2026-10-22

P2 handed off source-only PARTIAL after adding direct-session permission-mode snapshot/CAS
and binding the mode digest/revision into terminal consent preflight. Managed verifier,
aggregate DAG settlement, CodeMode helper authority, and external-editor lifecycle remain
open. Active owners are P1, P4 and P6. P4 owns TUI command/layout implementation for the
frozen single-pane `/editor` UX; P6 owns providers/settings/Doctor/S1. No tests/builds or
provider probes have run. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 — live V1 continuation roster

Whole-phase owners currently active: P1 Guard/ExecutionHost, P4 LSP/DAP/REPL
and command-only Explorer/editor UX, and P6 providers/settings/Doctor/S1. All
three available child slots are occupied. P1 reports private EffectHost CodeMode
wave APIs but HostKernel lifecycle and trusted consent projection remain open;
P1 has also started a non-runnable editor Guard/process identity foundation. P4
is wiring `/editor` overlay plus opt-in `/editor --side`; P6 continues provider/
auth and settings source work. P2's handoff is PARTIAL and must be restarted as
the next whole phase when a slot opens. P5 remains PARTIAL; P3, P7, P8 and P9
remain required.

Source implementation continues only. Tests/builds/typechecks/audits/benchmarks,
provider calls, and release checks are on hold until the user says testing can
start. Mixed Git changes remain unstaged and unpublished. Repo-only local
filesystem boundary holds. V1 is PARTIAL / NOT VERIFIED / NOT RELEASED.

**P4/P6 implementation update (2026-10-22):** P4 has source-wired the command-only
Explorer/editor UX (hidden startup sidebar; `/editor` overlay; explicit
`/editor --side`; prompt scratch under `/editor`; no export/editor shortcut) and
keeps file selection/editor launch unavailable without the authenticated
HostKernel projection. LSP remains false-gated; DAP/REPL remain unavailable
pending P1/P3. P6 is exposing permission mode through authenticated ServerAuth,
SDK methods and a `/permissions` dialog. Editors settings are informational until
P2 profile resolution and Guarded launch are integrated. Source-only; no checks.

**P1 editor Guard source update (2026-10-22):** Added a distinct
`EDITOR_LAUNCH_ID` broker action/policy and `ExternalEditor` process-ref through
the existing ExecutionHost classifier with profile/argv/mode/process-tree/fence/
one-use pins. Editor launch stays unavailable pending profile parsing, PTY/GUI
handoff, Full Access supervisor and P2 HostKernel lifecycle/recovery. Fixture is
unrun; no verification is claimed.

## 2026-10-22 — P6 source handoff; P2 resumed

P6 reports SOURCE COMPLETE for currently unblocked P6 code, not verified:
provider/auth truth, local-only Doctor, owner-scoped S1 QuestionV2/SSE,
authenticated permission-mode Config/SDK/dialog, informational editor settings,
and RepoIntel settings projection are present. Credential mutation and
credentialed sends remain disabled until P1 protected-write/receipt and P1/P2
transport acceptance. Parent added exact Git-visibility exceptions for first-
party P6/P4 files. P4 owns settings navigation/mount.

P2 has resumed as the whole-phase HostKernel/managed owner after the P6 slot
freed. Active owners: P1/P2/P4. P2 must finish verifier, DAG, CodeMode, editor
lifecycle, conflict and recovery source and coordinate DTOs with P1. P5 remains
partial; P3/P7/P8/P9 remain required. No checks/provider/release operations ran.

**P2/P4 implementation continuation (2026-10-22):** P2 confirms planned Goal
start/plan/TUI and substantial verifier source are present, but verifier adapter
readiness remains false. P2 is wiring the missing HostKernel CodeMode lifecycle,
ExternalEditor profile/launch/recovery, and managed verifier artifact/caller
seams. P4 may add a gated `tool/dap.ts` and make DAP-only registry edits; it must
preserve P5's websearch/CodeMode registry ownership. DAP effects remain disabled
until Guard/HostKernel acceptance. No validation ran.

**P1/P4 adapter boundary (2026-10-22):** P1 supplied P2 exact HostKernel caller
seams for CodeMode and external editor. P4 added a DAP model-tool entry behind
canonical `debug.start`, profile-only arguments and false readiness/Guard gates;
no DAP effects are enabled. P2 must provide authenticated profile/scope/lease
lifecycle. P5 must preserve the DAP-specific registry hunks. No checks ran.

**P2/P4 provenance checkpoint (2026-10-22):** DAP caller IDs are now required
from authenticated runtime context; no fabricated userAction/call authority is
allowed. P2 supplies these pins through HostKernel. P1/P2 are aligning the
ExternalEditor launch binding across identity, scope, immutable profile, target
preimage, permission mode, Guard lease/effect, and supervisor generation. Routes
remain unavailable until integration and acceptance.

## 2026-10-22 — P4 handoff and P5 active

P4 source is partial: command-only Explorer/editor UX and Settings mounts are
wired; DAP `debug.start` registration is gated and cannot dispatch without
trusted action/call/scope/lease; LSP/DAP/REPL acceptance remains open. P5 has
resumed as full-phase owner for built-in search and CodeMode. Active owners are
P1/P2/P5; P6 unblocked source is handed off. P3/P7/P8/P9 still remain. No
verification/provider/release activity occurred.

**P1/P2/P5 authority ownership (2026-10-22):** P1 owns the single
EffectHost/ExecutionHost process and receipt journal, including editor lifecycle
and CodeMode fixed-helper identity/digest. P2 owns HostKernel-authenticated
Session/Attempt authority and RPC integration over that journal; no duplicate
receipt authority. P5 owns TS codecs/callers against those exact APIs and
coordinates package entrypoint identity. No effectful gate opens before
integrated acceptance.

**P5 settings ownership (2026-10-22):** P5 owns the web-search route settings
dialog and authenticated config API/group; P4 owns only the Settings chooser
mount. Implement route enable/order and separate query-sharing/cost-consent
controls. Preserve no hidden paid/auth fallback and keep dispatch gated until
P1/P2 integration.

**P5 settings source correction:** Existing search settings already provide
route toggle/order, query-sharing consent, separate BYO auth/cost consent and
revocation, local-only provider state, and generic Config updates. Provider
inspection is read-only. Reconcile and preserve this source; no new API route is
needed without a concrete contract gap.

**P1/P5 lifecycle note (2026-10-22):** P1 is repairing incomplete ExternalEditor
EffectHost output digests and a `DecisionKindV1` typo before finalizing the P2
HostKernel caller contract, then continues fixed CodeMode helper resolution. P5
and P1 agree known rejected/cancelled waves terminate the run; UNKNOWN does not
emit completion. No verification ran.


**2026-10-22 — CodeMode nested dispatch dependency:** P5 found that the current `tool/code-mode.ts` projection is MCP-only, while §37.24 requires exact authorized current tool definitions and nested invocation via ordinary ToolBatch. P5 owns the registry projection and independent search source; P7 owns the reusable typed `dispatchNestedToolBatch` adapter in `session/tool-batch.ts`. No direct Tool.Def call or alternate dispatcher. CodeMode stays unavailable until P7 wiring and integrated P1/P2/P5 authority, lease, receipt and recovery paths are complete and accepted. Active owners P1/P2/P5; P3 is first queued at a freed slot, with P7 next as capacity opens. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks under the user's implementation-first hold. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**2026-10-22 — P2 managed DAG source gap:** P2 found run-plan admission was still functionally single-Task: roots were not made ready by `StartPlannedRun`, dependency readiness relied on disabled `mark_task_ready`, and concurrent workers could mutate one shared workspace. P2 is implementing Rust-derived root/dependency readiness and single-writer admission until distinct authenticated workspace leases exist, plus verifier support for prior verified Tasks alongside one current pending/live Task. Parent asked P2 to reconcile exact §11/DEC-V1-31 fan-out scope and use existing worktree leases for any required independent workers; serialized behavior must not be reported as parallel fan-out acceptance. P2 also found the fixed CodeMode helper still needs a normative owner-only package manifest path; P9 owns packaging and P1 is adding helper-digest authority. All gates remain closed. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**2026-10-22 — P5 CodeMode source delta:** `tool/code-mode.ts` now removes the old Core-side MCP interpreter/dispatcher and defines an immutable `CodeModeToolContextV1`, strict effective-tool projection, recursive CodeMode exclusion, and a required typed `dispatchWave` callback carrying the exact P2 HostKernel batch projection. Runtime stays unavailable when helper readiness or this context is missing. Parent source review confirmed the catalog must come from the post-filter/post-transform `SessionTools.resolve` active definitions, not raw ToolRegistry/MCP data. P7 owns supplying that exact projection and wiring the callback through ordinary ToolBatch. P5 continues search implementation and TS caller/package integration. No validation or provider/network action ran; all CodeMode/search effect paths remain gated until integrated acceptance.


**2026-10-22 — P1 CodeMode confinement source:** P1 reports CodeMode launch construction now binds only the fixed verified packaged helper (`horizoncode:codemode:bun`), fixed Bun `run <entrypoint>`, a read-only package mount, and no workspace/environment mount. EffectHost now returns the editor binding digest and terminal receipt, while CodeMode terminal reject/cancel/UNKNOWN semantics fence later waves/completion correctly. P1 is adding helper SHA-256 to persisted authority. No checks ran. P2/P9 must supply the trusted owner-only package manifest; no path or entrypoint may come from RPC/Core/model input. Exposure stays unavailable unless cgroup-v2 memory/CPU/PID and RLIMIT_NOFILE controls are each enforced and verified before first instruction, per DEC-V1-29/§37.24.

## 2026-10-22 source-only continuation checkpoint

Active whole-phase owners: P3 RepoIntel, P5 web search/CodeMode, P7 streams/artifacts/analytics/automation/rewind. P3 has permission to update only the exact RepoDocumentRead passages in §§12.18 and 37.4 to match the canonical `revisionKind` and 131,072-byte contract. P7 owns the shared request-scoped CodeMode→ToolBatch integration seam. P1/P2 cannot currently be resumed because the collaboration service reports its agent thread limit; their phases remain unfinished and critical-path. P4/P6 are partial, P8/P9 are open. No verification or effectful provider activity ran. Overall V1: PARTIAL / NOT VERIFIED / NOT RELEASED.

**CodeMode zero-call schema alignment (2026-10-22):** Pure computation without nested calls is an approved V1 case. The worker-message schema and P5 TypeScript decoder now allow an empty effective tool list. P1 owns the remaining Rust validator adjustment; CodeMode is still gated and unverified.

**Search retry decision (2026-10-22):** Bounded network retry is authorized only on durable proof of no request bytes sent (`NOT_DISPATCHED` receipt with null response metadata); one same-route retry maximum. HTTP 408/425/5xx retry once only after a durable response receipt. Possible-send ambiguity remains UNKNOWN/no retry. DEC-V1-26 and §§12/37 plus search receipt/result/failure schemas now encode this. P1/P2/P5/P6 still need Rust, HostKernel, TS and transport implementation; search remains gated and unverified.

**2026-10-22 — P5 source handoff:** `SessionTools.resolve` now carries a bounded, canonical CodeMode tool catalog from authorized post-filter/post-transform definitions, including eligible deferred candidates for helper search, through `LLM.StreamInput`; those descriptors add no capability to the normal provider tool map. `tool/code-mode.ts` now provides strict enablement/frame/state validation and an adapter over the existing authenticated `SessionSupervisor.requestHostKernel` callback for the five §37.24 operations. The §37.24 operation table now records the exact request/response field shapes used by this adapter. It creates no protocol, runtime, executor or nested dispatcher. P2 must feature-negotiate/route the authenticated Rust handlers and satisfy helper/containment authority; P7 must bind the catalog to ordinary ToolBatch wave admission/settlement. Search and CodeMode remain unavailable pending those dependencies and acceptance. No tests/builds/typechecks/provider probes were run under the source-first instruction; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


## Live source implementation checkpoint — 2026-10-22

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, and P7 streaming/context/artifacts/analytics/automation/rewind. Next queued owner: P6 direct provider request journal and ProviderTransport/Auth integration. P1 now has managed CodeMode authority recovery scoped to a live Attempt and has added HostKernel integration APIs for exact ordered DirectSession terminal artifact receipts and the active outer CodeMode effect by private call ID. P2 must derive the authenticated session epoch and committed batch order before root artifact lookup, then complete the typed CodeMode lifecycle and root artifact projection. P7 owns frozen ContextSelection/provider-input production and nested dispatch through ordinary ToolBatch. Direct child Attempt artifact list/inspect/range is source-present; root DirectSession artifact search remains gated. Provider sends, CodeMode, guarded automation invocation and checkpoint restore remain gated.

The user requested implementation before tests. No tests/builds/typechecks/audits/provider calls/benchmarks/release checks have run. Git status is mixed and unstaged; preserve all user-owned/ambiguous changes. V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**Owner refill correction (2026-10-22):** P1 handed off a PARTIAL source pass and retains integration/acceptance accountability. The freed child slot is now assigned to full-phase P6. Active owners are P2 managed lifecycle/HostKernel, P6 providers/settings/Doctor/S1, and P7 streams/context/artifacts/analytics/automation/rewind. P3/P4/P5/P8/P9 remain unfinished. No checks have run; V1 remains PARTIAL / NOT VERIFIED / NOT RELEASED.


**P2/P7 interface delta (2026-10-22):** P2 has added the strict private `CodeModeCall` envelope in Rust protocol/Core supervisor and `SessionSupervisor.codeModeHostRequest(...)`, binding session/location/callID/lane/optional managed scope outside the frozen public request body. HostKernel now routes authenticated inspect and rehydrates exact current-epoch direct/managed authority through P1's recovery APIs; start/resume/cancel/enablement remain unavailable pending durable enablement, frame/tool-set validation and supervisor dispatch. P2 is wiring launch next. P7 will send P6 only the frozen directContext (request ID, source revision, profile ref/digest, ContextSelection); P6 captures and hashes the exact prepared selected-route payload once at RequestExecutor, with no credential/header bytes in the handoff or digest. No tests run.

**2026-10-22 live source update:** P2 owns the root DirectSession ToolBatch admission index in the existing HostKernel location-authority store and exact ArtifactStore/terminal-receipt join. P6 owns the trusted Core-catalog route projection; P7 consumes it and removes model-route fallback. Architecture §§15.2, 17.26 and 37.12 now bind these interfaces. Verification remains deferred by user instruction; no checks run. Overall V1 PARTIAL / NOT VERIFIED / NOT RELEASED.

## 2026-10-22 implementation continuation

Whole-phase owners currently active: P1 Guard/ExecutionHost, P2 managed lifecycle/HostKernel/DAG, P7 streams/context/artifacts/automation/rewind. P2 owns `kernel/src/managed_control.rs` after P8's source handoff; remove the capacity-one reducer gate only where the scheduler can maintain independent authenticated workspace leases. P1 owns command-profile execution and direct-session preflight. P7 owns safe renderer redaction and remaining unblocked source. The user resolved the cgroup lifecycle question by asking for Codex/OpenCode comparison: preserve the durable janitor contract; reclaim only exact isolated groups after quiescence and exclusive-lock identity verification; keep 256 as bounded quarantine for ambiguous/unproven groups, not a lifetime launch ceiling. No verification commands or real provider calls have run under the implementation-first hold. Preserve the mixed unstaged tree. Release status remains PARTIAL / NOT VERIFIED / NOT RELEASED.

**P2/P7 source update (2026-10-22):** P2 removed the managed reducer's capacity-one ceiling and now enforces the SpecVersion `maxWorkers` bound plus exact active Attempt ownership, distinct mutable Locations and verified dependencies. P7 is changing nested CodeMode result digesting/forwarding to operate on the same bounded redacted projection. Neither change is acceptance evidence; no checks ran.

P2 HostKernel follow-up: only `codemode_inspect` is implemented; `codemode_settle_tool_results`/`codemode_wave_receipts` have no matching handlers, and start/resume/cancel/enablement remain unavailable. Root DirectSession artifact list exists but inspect/range is not dispatched. P2 is implementing these. Use the existing P8 settlement flow and disposition recovery APIs, without a second settlement authority. No validation ran.

P1 cgroup edge under review: failed CodeMode controller setup after cgroup mkdir currently retains the empty group before its identity is persisted, potentially consuming bounded quarantine capacity after repeated failures. Any recovery must prove never-dispatched identity and hold the namespace lock; post-dispatch cleanup remains receipt/quiescence gated.

P2 settlement recovery now advances one deterministic eligible terminal Task per call, preserving its exact verifier ChallengeSet identity and allowing subsequent calls through `NO_SETTLEMENT_PENDING`, so each Task's P8 disposition can settle independently. This is source-only.

**P2 CodeMode mixed-wave blocker:** HostKernel dispatch names `codemode_settle_tool_results` and `codemode_wave_receipts` without handler implementations. P1 needs to expose the explicit ordered EffectHost call kind (`effect`/`host_callback`) and exact effect receipt resolver so P2 can complete these without capability-string inference or synthetic leases. §37.24 fixes the behavior: callbacks have no lease; effect calls use regular Guard/receipt flow; Core retains raw output while helper receives only bounded redacted output projection. Continue independent P2 tasks; keep CodeMode disabled.

P2 fixed repeated DAG recovery returning the same already settled Attempt: it consults durable P8 settlement/disposition, skips completed Tasks, advances one deterministic candidate and returns `NO_SETTLEMENT_PENDING` when complete. P7 now supplies strict root DirectSession artifact inspect/range and request/wave/call-correlated cancellation adapters; P2 HostKernel cancel remains missing. Source only.

P2 found CodeMode batch projection lacks exact `toolName`; P7 must source it from the resolved canonical executor, then HostKernel exact-compares frame/catalog/executor names. Model input cannot choose the name. No checks.

P7 added trusted resolved `toolName` to the CodeMode-only batch projection. P2 is aligning strict Rust parsing and exact name comparison; ordinary ToolBatch remains unchanged. No checks.

P1 Full Access capacity review: the current retain-only policy for successful Full Access cgroups would exhaust the 256 cap after enough successful commands. P1 is evaluating a supervised no-cgroup path or safe exact-quiescence cleanup; retain the user's full-access semantics and make no false containment claim. Only UNKNOWN/unproven cgroups should use the bounded quarantine.

P1 resolved the Full Access cgroup conflict: do not remove a visible cgroup based on empty membership, since a hostile child can move descendants out. Avoid the successful-launch 256 cap by not allocating retained cgroups for Full Access while using the existing supervisor/effect journal; restart ambiguity remains UNKNOWN/no-replay and no cgroup confinement claim is made. P1 is updating source and relevant DEC/LLD/provenance.

**2026-10-22 active phase boundary update:** P1 accepted no-persistent-cgroup launch for authenticated Full Access, using the existing live process-group supervisor plus durable effect journal; restart ambiguity remains UNKNOWN/no-replay. Confined workspace profiles retain cgroup-v2 identity and verified cleanup. Public Codex/OpenCode process-group practices are weaker lifecycle references, not crash-proof durable containment. P1 owns the corresponding architecture/provenance reconciliation.

P1's typed EffectHost CodeMode prepare/settle API is source-present; P2 owns HostKernel prepare/settle/receipt/cancel wiring and exact frame/catalog/executor identity checks. Parent inspected the suspected result-row tuple decode and did not reproduce the defect. P2 is rechecking while addressing a concrete mismatch between its private CodeMode prepare shape and ordinary EffectHost effect-only ToolBatch admission. Callbacks must compose as `host_callback` without synthetic leases; effects use ordinary Guard leases/receipts. No tests/builds/typechecks/audits ran.
