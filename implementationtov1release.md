# HorizonCode V1 implementation and release tracker

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
`packages/schema/src/subagent-delivery-v1.ts`; a strict Rust MessagePack decoder,
authority-digest recomputation and comparisons against authenticated direct Core claims or a
live managed Goal/`DelegationBindingV1` are source-present in
`kernel/src/subagent_delivery.rs`. Neither lane is wired into a delivery lifecycle; shared
golden fixtures, tests/typechecks and runtime acceptance remain open. The event model tags child progress by lane and keeps
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
- **User decision (2026-10-17, supersedes the prior free-tier prohibition for HorizonCode direct mode):** free models are included under the `opencode` provider. The inherited OpenCode-derived request identity (`x-opencode-*`, `User-Agent: opencode/<version>` — the fork's own native source behavior, unchanged by this workstream) and the provider's own keyless mechanism (`apiKey: "public"`) are retained; the user's explicit determination is that this is not spoofing. No additional fabricated identity, no bulk accounts, and no gate-defeating mechanics beyond the provider's own keyless path; gateway rejections and quota exhaustion are surfaced verbatim. Recorded risks: the gate is composite/closed and may change; the free quota is small (documented 200/day); the ToS "own internal use" language remains noted. Native OpenCode mode remains available unchanged.
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

Newly adapted/copied first-party Horizon modules, folders, package/JSON identifiers, generated names and user-facing labels must use **HorizonCode** identity (including `horizoncode` product naming). The canonical user-facing executable is `horizoncode`, with `hzcode` shipped as its short command for the same entrypoint and runtime (amended 2026-10-18). Do not leave an imported OMP/OpenCode product namespace as the identity of a new Horizon-owned feature. Preserve legally required copyright/license/notices and keep genuine `@opencode-ai/*` or `@opencode/*` upstream dependencies/API names and the private `opencode` workspace package ID while they remain compatibility requirements. This rule applies as each V1 module is adapted; it does not authorize a broad global rename, upstream snapshot rewrite, or breaking package migration. Full build/package identity migration remains separately gated by `arch_V1/10-DELIVERY.md §10.12`.

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
| P5 | Partial / queued | Cascade adapters, route settings, ordering, 429 cooldown, provenance and bounded retries are source-present; websearch docs concepts adapted only where compatible with Horizon cost/consent rules. | Assign whole-phase follow-on when slot opens. Built-in+BYO transport composition still depends on P1 Guard+SecretBroker and remains hidden. |
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
| P7 stream/artifacts/analytics/automation/rewind | Queued | Finish renderer/redaction bounds, activity replay/resnapshot/sequence fencing, artifact truth, P8-backed durable automation and checkpoint/rewind recovery. |
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
