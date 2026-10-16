# HorizonCode — Current implementation handoff

**Verified remote source baseline:** `sarv-projects/horizoncode` `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54` (14 October 2026).  
**Merged source/contract update:** PR #7 landed in upstream `main` at `db36dfdc40dad221078839a0aa4a98539e45b0d2` on 15 October 2026. It includes Core ToolRegistry/Rust managed-control source and regression tests, not only Markdown. Local merge and validation status is recorded in `CURRENT_RUN.md`; verify CI and tests on the exact integrated HEAD before release claims.
**Implementation completion:** **NOT V1 RELEASED**. Documentation changes are not proof of implemented features. Recheck latest Git SHA, workflow and local status before editing; the connected GitHub repository cannot verify the user's local dirty tree.

This is the **current observed implementation-status entry point**, not a new design authority. The architecture is `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → exact topic owner. The implementation dependency queue is `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` (Gate 0–10, RC0–RC5). Root `CURRENT_RUN.md` is a dated work/evidence diary. Full superseded status chronology was preserved unchanged in `docs/architecture-archive/2026-10-15-handoff-pre-jcode-adoption.md`; older audit snapshot remains preserved in the existing archive.

External source pins, license and copying review: `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` (non-runtime evidence; current implementation status stays in HANDOFF).

Read in this order:

1. AGENTS.md
2. arch_V1/README.md
3. arch_V1/17-GOVERNANCE-DECISIONS.md
4. arch_V1/10-DELIVERY.md
5. arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md when external source reuse is involved
6. this file
7. docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md

## Canonical ownership and non-negotiable rules

- HorizonCode direct Core (OpenCode-derived) alone owns direct Session/Input/Message/Part and provider-turn continuation; provider transport is replaceable only through approved A-V2-27.
- Rust owns Horizon managed Goal/SpecVersion/Run/Task/Attempt, Guard/ToolBatch/EffectIntent/lease/receipt, independent Evidence/Verification and resource/worktree ownership. It **does not** own another conversation transcript.
- Native OpenCode adapter, if selected, owns its **separate native sessions** only, with explicit bounded Horizon links.
- Every enabled mutation origin requires pre-dispatch Rust Guard → durable effect admission → one-use lease → authorized host/worker → receipt/UNKNOWN. An inability to pre-authorize hosted/provider-executed effects means they are unavailable, not silently allowed.
- User-selected provider/model/harness and cost class do not change without configured explicit permission; no hidden paid fallback. No automatic worker/cache/process cleanup without confirmed ownership; do not destroy user-owned files/dirty worktrees or unowned builds.
- Defined/Proposed/Code present/Wired/Tested/Verified/Released are different statuses. Neither docs, schema, UI placeholder, single green CI build nor JCode benchmark claim can upgrade runtime status.

## Source-grounded baseline and outstanding gates

| Gate | Existing evidence on the observed main branch | Missing before calling it complete |
|---|---|---|
| P0 source reuse | Pinned `opencode/` snapshot; overlay/bootstrap/audit scripts and source maps; earlier validation checkpoints | Release license/notice/package and clean-machine proof at P9 |
| P1.2-B observer | `packages/core/src/session/supervisor.ts` + `kernel/src/bin/session_supervisor.rs` + projection/handshake; a **separate Linux Rust process per watched direct Session** | Complete supported-OS lifecycle, failure/restart, and resource benchmark evidence; shared daemon is only a candidate |
| P1.3 Guard | `kernel/src/guard.rs`, `effect_host.rs`, V1/V2 ToolBatch gate, guarded write, bounded stream/cancel; PR #7 now additionally gates Core registry effects on Rust admission, filters unsupported effects and rejects application/plugin `files.write` identity spoofing with focused Bun tests | Source-specific shell/process, Task/subagent, plugin/MCP/hook, hosted-provider, LSP/DAP/REPL, browser/desktop/network/automation no-bypass proofs; complete lease/receipt/UNKNOWN settlement |
| P2 managed control | `kernel/src/owner_log.rs`, `managed_control.rs` and tests for accepted spec, Task/Attempt restart/UNKNOWN; PR #7 now also transitions PAUSED+UNKNOWN admitted Attempt to RECONCILING with durable replay and unsafe-resume regression | **Non-executing internal admission state only**: authenticated full reviewed SpecVersion RPC, real Task DAG scheduler, worker/resource leases, effect reconciler, independent verifier/verified final revision and end-to-end real work |
| P3/RepoIntel | Existing OpenCode-derived coding path and `indexd/src/lib.rs` bounded lexical generation/overlay/cursor foundations | Revision-safe edit/search, symbol/reference/LSP service integration, latency/task verification |
| P4/P5 capabilities | Existing source/tooling and design/service seams | Guarded LSP/DAP/REPL and browser/desktop/web-search runtime, exact OS/provider safety and real task tests |
| P6 | Existing OpenCode-derived models/tools/extensions plus initial Features UI and feature-exposure code | Full effective/locked/source/pending optional-settings parity, extension/adapters and capability security/evidence |
| P7/P8 | UI architecture and durable control foundations | Stable high-volume UI/render/analytics/automation runtime, concurrent real-work long-horizon recovery/verification and measured perf |
| P9 shipping | README/product direction, scripts and prior GitHub CI history | Root redistributable license, native Windows durability/sandbox/process support, other platform qualification, installer/migration/signing/privacy/performance gates |

**Merge chronology correction:** PR #4 was merged on 14 October 2026 (main commit `03691d7852f2`); its internal managed-state implementation is **not** the production managed executor. Historical “PR #4 still open/CI pending” passages exist only in archived logs. The README-only commits after it do not establish runtime progress. No open PRs were observed when baseline was queried; PR #7 is this documentation effort.

**Experimental settings:** `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/dialog-features.tsx` and `packages/app/src/components/settings-v2/features.tsx` are present on the reviewed main branch. This is **CODE_PRESENT/PARTIAL** initial config/UI, not proof of every `FeatureExposureV1` source-precedence/lock/pending/API parity or enabled experimental backend. Experimental remains OFF unless eligible, explicitly opted in and authorised; an unavailable backend cannot be turned on by UI alone.

## New JCode adoption decision — A-V2-30 (DESIGNED only)

**Source research:** `1jehuang/jcode@1f612a7` and user-supplied `jcode-godmap.zip`, pinned in §42.9. Upstream vendor RAM/PSS figures and experimental documents are **not independently reproduced Horizon measurements**. The architecture and task inventory now include 24 candidates with a complete §42.10 crosswalk and RC0–RC5 delivery gates.

| Workstream | Source owner | Actual status at this handoff | Exit evidence |
|---|---|---|---|
| Whole-product memory/process budget | §18.17, §37.16, RC0 | **DESIGNED**, no first-party comparable benchmark | Exact-machine total process-tree PSS/RSS/CPU/FD/cache/disk/local-model VRAM at 1/5/10/20 Sessions; raw reproducible baseline, native OS metrics |
| Shared Rust virtual Session service | §01/§13/§20/§05/§14, RC1 | **PROPOSED**; current Linux observer is per Session | Read-only multiplex prototype then authenticated cross-session isolation, crash/recovery, fairness and Guard parity; measured improvement before effect-host cutover |
| Bounded headless workers and Task DAG | §15/§21/§29, RC2 | **DESIGNED**, internal P2 state only | Authenticated scheduler/leases, typed artifact edges, realistic concurrent tasks, independent revision-bound PASS |
| Provider Doctor / prewarm | §15/§33/§37, RC3 | **DESIGNED**, use existing provider transport | Offline no-network tier, bounded catalog test, explicit-consent full tool/chat/stream test, no paid fallback |
| File-touch and stale-write conflict handling | §21/§33, RC2 | **DESIGNED** | Advisory file-touch index and hard revision digest/lease denial under user edits and competing agents |
| RAM caches/local memory retrieval | §18/§30/§31, RC3 | **DESIGNED** | bounded bytes/TTL/entries; opt-in scoped recall and secret/privacy negatives |
| TUI redraw, live tool-tail, resource dashboard | §16/§31, RC4 | **DESIGNED**, underlying UI exists | idle/full-frame reason, stable prompt focus, bounded 10k-message streams, source-truth telemetry |
| SDK, import/resume, terminal steering, builds, optional mobile/self-dev | §13/§16/§33, RC3/RC5 | mix of existing underlying direct-session steering and new **DESIGNED** adapters | §42.10 mapped acceptance: no dual owner, authenticated clients, source provenance, rollback |

The accepted 20 base regression cases are `JC-RES-001..020` in §32.32, with additional required reservation/authentication subfixtures `JC-RES-012.C–L` in §32.37. The measurement protocol at `docs/performance/README.md` is a **runbook and unexecuted empty template**; the executable pieces now exist as `scripts/perf/rc0.py` (owner-identified capture, 13 unit tests green) and `kernel/tests/resource_sampler.rs` (9 tests green), but **no 1/5/10/20 raw baseline capture has been produced**, so no result is implied.

## Exact next implementation slice

**P1.3 host-kernel prerequisite, then first direct origin.** The normative §§14/37 architecture selects a host-scoped `hz-kernel`; do not revert the Session supervisor into a second effects owner. *(Status 2026-10-15 evening: `hz-kernel` builds; `kernel-projection-live.test.ts` is 10/10 (104 assertions) against the real host, and `terminal-run-live.test.ts` is 7/7 (68 assertions) for the guarded session-batch run path. The latter proves deny → zero spawn, approved real execution with receipt and both truncation flags, one-use lease replay rejection, timeout without orphan process, and durable UNKNOWN when dispatch is withdrawn. This does not yet prove the Core `Pty.runUser` UserAction route.)* Remaining P1.3 work, in order:
1. ~~Fix user-origin effects~~ **Rust HostKernel/EffectHost path implemented 2026-10-15**: `guard.rs` splits `EffectOriginKindV1` (`SessionBatch` requires Session + sha256 turn context for every action including `terminal.run`; `UserAction` is `terminal.run`-only, needs principal + explicit approval, and cannot claim files.write), and the origin kind is fixed by the Canonical operation rather than a caller-supplied field. Core `Pty.runUser` calls `prepareUserEffect` and then the same host execution path; existing Rust principal tests pass, but a real Core-through-host user-origin test is still required.
2. ~~Make reconcile echo the prepared operation~~ **done 2026-10-15** (`kernel/src/effect_host.rs` reports `run` for terminal challenges, `write` otherwise, patch targets unchanged) with an exact-value Rust assertion; live `test/terminal-run-live.test.ts` is 7/7 against the rebuilt binary.
3. Retarget all stale `effects.v2` process-integration coverage in `kernel/tests/session_supervisor_process.rs` to the actual `hz-kernel` owner, preserving positive, denial, restart/recovery, and concurrency cases; implementation is underway.
4. Implement the interactive PTY surface (`terminal.start/input/resize/cancel/status`, tickets) in `hz-kernel` through Guard/EffectHost, with bounded replay and restart/UNKNOWN behavior. **Rust side landed 2026-10-15 late** (`kernel/src/host_kernel.rs`, `kernel/src/terminal.rs`, `kernel/src/terminal_process.rs`, `kernel/src/bin/hz-kernel.rs`): subscriptions with bounded replay, explicit `resnapshot_required` on eviction, cursor/digest-bound events, restart status `unknown`/`sessionLost` with empty replay, and a Linux preflight refusal when process-tree cleanup after owner loss cannot be guaranteed. `cargo test --manifest-path kernel/Cargo.toml` is **fully green** (107 lib + 11 `effect_host_principal` + 9 `effects_host_process` + 1 `host_terminal_events_process` + 2 `host_terminal_process` + 10 `hz_kernel_process` + remaining suites), and `cargo fmt --check` is clean. **Consequence:** interactive `terminal.start` fails closed on Linux with `UNAVAILABLE` before lease consumption; only native Windows ConPTY acceptance can demonstrate a live interactive terminal.
   Core side: `subscribeHostKernelEvents` no longer closes the shared host channel on a resnapshot control (subscription-scoped, ACK routed through the delivering subscription, bounded retry budget so a host refusal cannot spin), and `Pty.attach`/`Pty.recoverResnapshot` page `terminal.v1/status` in 64-KiB pages, slice replay by the attachment's own byte cursor, and surface `SessionSupervisorError`/`Pty.UnavailableError` as typed 503s instead of hanging.
5. Latest targeted evidence (2026-10-16): `cd packages/core && bun run typecheck` returned without diagnostics; this was not a full workspace typecheck (the last full-workspace checkpoint remains 26 diagnostics in other owners). `cd packages/opencode && bun test test/server/httpapi-listen.test.ts` is **9 pass / 3 skip / 0 fail** (37 assertions). The former positive external-plugin reuse case was removed after tracing `Plugin.state`: it loads internal plugins and reports configured external server plugins unavailable until Guard/ExecutionHost are wired. Do not treat its removal as plugin runtime acceptance or restore an unguarded path.
6. Canonical `/api/pty` harness correction (2026-10-16): the test helper now uses `HttpApiApp.createRoutes()` with the configured `OPENCODE_SERVER_PASSWORD`, rather than global `HttpApiApp.webHandler()`. Wrong Basic password returns 401; authenticated Linux PTY creation returns typed 503 `ServiceUnavailableError(service=host-kernel)`; the list remains empty. `cd packages/opencode && bun test test/server/httpapi-v2-pty.test.ts` is **1 pass / 4 skip / 0 fail** on Linux. The earlier 403 was test-harness configuration, not missing production authorization middleware. Windows-only live cases are updated to use `cmd` but remain unexecuted; native Windows ConPTY/pipe-auth/Job Object acceptance is open. The prior location-scoped `Pty.Service` fix and `/status` smoke result remain as recorded.

**Parallel safe instrumentation (RC0):** implement the §37.17 ResourceSampler only behind the existing Rust-owned process/lease identities; measure the whole owned process tree with PID-start fencing, Linux PSS/RSS/CPU/FD and native Windows private bytes as separate methods, local inference separately, UNKNOWN on unsupported/denied counters, and redacted bounded samples. Reproduce the JC-RES-001..004 1/5/10/20 task/model baselines on recorded hardware; no runtime/PSS acceptance is inferred from schema or WSL.

**Then P2:** after P1.3 admission and receipt reconciliation pass, implement one accepted SpecVersion → one durable Task/Attempt → one bounded Guard-mediated action → durable evidence/receipt → independent final-revision verifier. Prove pause/cancel/restart/UNKNOWN and human-edit conflict before worker fan-out; then progress to resource/workspace leases and UI/SDK.

**Snapcompact:** source review finds transient request-context imaging and persistent archive compaction are separate. Neither is available in V1; no runtime, setting, command or capability. A later ContextService projection is plausible only after P1.3/context fidelity, exact-model capability and image-aware budget/privacy/cost/recovery proof. See §§16.15.2/30.4 and §42 SRC-024.


**Current code checkpoint (2026-10-16, updated):** the P1.3 host/session implementation remains in progress. `hz-kernel` effects.v2 and terminal.v1 surfaces, bounded PTY replay/resnapshot recovery, and prior Linux real-binary tests are recorded above. This continuation proves the configured `/api/pty` auth harness and Linux fail-closed refusal, and the listener suite is green with 3 platform skips. Open gates: complete P1.3 origin closure; the real `shellImpl → spawner.spawn` Guard path; Core `Pty.runUser` UserAction-through-host proof; native Windows ConPTY/pipe authentication/Job Object acceptance; and the rest of P2–P9. External configured server plugins remain unavailable until Guard/ExecutionHost mediation exists.

## Verification and continuation procedure

1. Inspect local tree status, pending worktrees, active build/child processes, disk/cache size, configured OS and newest main/PR HEAD. Never treat this remote source read as evidence the user's laptop worktree is clean.
2. Run focused source-owner tests and `bash scripts/architecture/run_push_gate.sh`; for CI/release also run `bash scripts/architecture/run_full_gate.sh` and actual scenario/platform tests. A docs-only CI pass is *not* a performance or runtime certification.
3. Implement one end-to-end vertical slice with a failing acceptance case first; then positive, bypass/negative, cancel/restart/UNKNOWN and workload/perf evidence where applicable.
4. Update this document's status only after exact merged commit, tests, platform/model and observed results are known. Add chronological details to `CURRENT_RUN.md` without creating another architecture authority. Use §42 pins/licensing before importing algorithms or code.
5. Record unverified/unsupported paths, user-approved provider cost, CI status, resource baseline and owned worktree/process cleanup. Do not publish quantitative speed/RAM claims without raw reproducible evidence.

## Documentation-update validation status

**Historical initial pass:** this PR originally edited Markdown only. Later commits on this same branch added real Core ToolRegistry admission/registration checks, Rust PAUSED→UNKNOWN reconciliation handling, and Bun/Rust negative tests (see the newest entries below). The initial source/heading/Markdown-format pass did not exercise OS/backend tests. Final GitHub Actions validation must be checked on the **latest PR head**; no native Windows/macOS, provider inference or JCode-vs-Horizon benchmark is established by these source edits.

## Detailed HLD/LLD readiness reconciliation — 2026-10-15 (documentation-only)

All 46 `arch_V1/*.md` active and compatibility Markdown files were rechecked structurally for duplicate/out-of-order numbered sections, balanced code fences and escaped code literal artifacts. Authoritative product HLD is §01.13; function-level wiring and source paths §10.15/§20.12; machine schemas §12.16; shared-kernel IPC §13.12; runtime flow §15.20; resource budget/sampling/cache §18.18–19/§30.21/§37.17; worker/DAG §21.11/§29.18; TUI/UI §16.17/§31.17; SDK/import/steering/canary §37.19; fault cases §32.33–34. The operative plan RC0–RC5 now has a function-to-code-to-test ledger. Historical `opencode/` Markdown and `docs/architecture-archive/` are inherited/reference, not parallel implementation authority.

**Source truth:** current code remains narrow Linux Session supervisor + guarded file write, partial non-executing P2 admission state and initial feature-exposure UI. No new schemas, shared daemon, RAM benchmarks, provider doctor, headless worker or native Windows qualification were run or implemented by these Markdown-only commits. Earlier PR #7 CI failed on numbered architecture headings and mandatory provenance pointers; both documentation faults were corrected in branch commits. **Recheck latest final-HEAD Actions status before merging**, and do not mark the real runtime implementation tests as passed based on docs-only typecheck.

## Cross-document omissions confirmed on 2026-10-15

- Root `SECURITY.md` and `CONTRIBUTING.md` had inherited OpenCode disclosure/project instructions. They now describe HorizonCode and link to the upstream copies only for provenance. The separate upstream vulnerability reporting URL/email **must not** be represented as HorizonCode's reporting channel.
- The operative §§3.16–3.18 accepted external agent/native OpenCode, visual edit and deploy/verify/rollback user journeys, but lacked complete service/permission/candidate/test bindings. Their **DESIGNED / NOT WIRED** contracts now live in §§14.18, 20.13, 29.19, 33.30, 37.20–21 and test cases ACP-001..008, VIS-001..004, DEP-001..008 in §32.35. The pinned OpenCode ACP server is code present; the Horizon outbound ACP client was not independently verified.
- Source input at `docs/architecture-input/universal-software-agent-v2-source.md` now explicitly declares itself historical non-normative; its older internal “Normative precedence” text does not override current `arch_V1/` decisions.
- The root redistribution LICENSE file was not present in the reviewed tree. Release licensing/attribution remains an **OPEN** gate; no license was chosen or copied in this docs-only pass.
- These are documentation and implementation-contract corrections only: no deploy/ACP/visual backend, RAM measurement, shared kernel, or universal Guard execution was implemented by this branch. Recheck GitHub CI on the **final head** before merge.

## Final cross-owner contract pass — 2026-10-15 (documentation only)

Re-read all **23 normative numbered architecture owners**, the root agent/implementation/status guidance and operative checklist from the PR #7 branch. Cross-reference scanning identified a broken `§31.18` pointer in PF-004, corrected to the actual §31.3/§32.21 performance owners; no other missing references were found among this scanned set of numbered active owners. This does **not** establish a human semantic line-by-line audit of inherited/archived/source Markdown; earlier 779-file upstream inventory was incorrect (actual count 152 tracked upstream Markdown in the complete Git tree at `dc61b665`).

- **Real specification conflict fixed:** §18.18's four-state `WorkerResourceReservationV1` (`ACTIVE` etc.) disagreed with §11.20's Rust reservation lifecycle, and §11.20's `SOFT/HARD` pressure labels disagreed with §18.18. §11.20 now owns seven exact reservation states and the canonical `SOFT_PRESSURE/HARD_PRESSURE` labels, with no `UNKNOWN` reservation state. §18.18 and §12.16 use those exact names. Expiry may release capacity only when no worker/effect was launched; after launch, unresolved process/effect remains `QUARANTINED` until receipt/process reconciliation and confirmed release.
- **Service authentication hardened in the design:** §37.18 now requires trusted authenticated scope on FileTouch ingestion/query/invalidation, headless broker operations and paid/network Provider Doctor operations; input session IDs, epochs, queue tickets, spend grants and effect leases are not self-authorizing. §13.12's READY response is distinct from the actual attachment ACTIVE state; §21.11 uses the same reservation lifecycle.
- **Tests and coding instructions aligned:** §32.37 adds `JC-RES-012.H–L` for enum parity, ID/PID races, expired-before-launch versus quarantine, forged owner/file-touch/worker tickets and Doctor grant mismatch; the operative RC0/RC2/RC3 ledger and AGENTS/IMPLEMENTER_PROMPT point to them. Tests are **specified, not executed**.
- **Outstanding actual release work unchanged:** universal P1 no-bypass, P2 executing scheduler and independent final verifier, generated contracts, OS sandbox/process qualification, benchmark harness and real measurements, distribution license/notices, and final CI on the **new branch head**. Documentation review must not mark these verified or claim every source sentence semantically audited.

## Complete tracked-Markdown structural audit — 2026-10-15

The complete GitHub recursive tree at PR #7 baseline `dc61b665` (not truncated) contains **278 tracked `.md` files**, 3,473,581 bytes and 52,523 parsed lines: 46 `arch_V1`, 59 archived, 2 architecture input, 152 pinned upstream OpenCode and 19 other project/support files. The previous report of 904/779 is **incorrect**. All 278 Git blobs were retrieved and read for structural link/fence/merge-marker validation: the initial parser reported **no active-project broken relative links** and 62 non-normative/historical/upstream relative-link warnings, many to removed generated inventories or test fixtures. The old records are preserved for provenance; broken archive links are not promoted into active authority.

The frozen per-file Git blob/size/scope/flag ledger is `docs/audits/2026-10-15-tracked-markdown-structural-manifest.json`. The durable check is now `python3 scripts/architecture/audit_markdown_repo.py`, invoked by `scripts/architecture/run_push_gate.sh`, with optional `--json-report` to emit per-file SHA256 hashes, line counts and warnings. The manifest belongs to the immutable baseline, not any later head. This is a **structural audit**, not proof that 52,523 lines received human semantic adjudication or that absent backend methods are implemented. Source checks reconfirm `managed_control.rs` remains explicitly non-executing and Rust Guard currently does not cover every enabled mutation origin. Compiled machine contracts, effects/worker adapters, independent verification, RAM/OS tests and redistribution decisions stay open. **CI for the final new head must be checked**, and all verified status changes require runnable evidence.


## 2026-10-15 documentation-regression hardening (audit tooling, not V1 runtime)

The existing convergence validator now executes static DOC-001..010 regression guardrails for project security/contributor identity, archived-source precedence, ACP/visual/deploy traceability, reserved capability status, release/OS caveats and the operative plan. The tracked-Markdown validator DOC-011 additionally examines inline/reference-style/HTML relative paths, fences, numbered headings, UTF-8 and conflict markers at the current checkout. These checks must pass on the final head in CI. They do not prove all runtime fault scenarios, per-sentence semantic correctness of 278 files, native-platform release qualification, licensing, universal Guard, executing P2, or independent verifier acceptance. No status is promoted on the strength of this validation code alone.


## 2026-10-15 pinned source AGENTS instruction conflict

A fresh bootstrap can restore `opencode/**/AGENTS.md` into root package subdirectories. Those inherited source notes contain OpenCode-specific policies (upstream `dev` branch, blanket app restart ban, developer-private source path). Root `AGENTS.md` and `CONTRIBUTING.md` now explicitly distinguish package-local implementation advice from HorizonCode policy, and DOC-012 static validation checks those warnings. Preserve upstream SHA and verify inherited instructions against the current Horizon task/OS/capability before running a coding agent. This remediation is instruction/docs only, not Guard enforcement.


## 2026-10-15 — owner-log machine-schema divergence discovered

Source comparison found the design-only `arch_V1/contracts-v2/managed-event.schema.json` used PascalCase event names and `schemaVersion: 2`, not the active Rust OwnerLogV2 physical record (`format_version=2` with seq/time_ms/kind/data/previous_digest/event_digest) and current snake_case `ManagedCommand` subset (`schemaVersion=1` in record data). Marked it explicitly non-runtime and clarified §04/§12; DOC-013 static guard prevents accidental typegen from the incompatible prototype. Public managed API stays design-only until explicit migration/projection and TS/Rust fixtures. Contract test PATH was also made platform/user-portable (DOC-014). No persistent event encoding was changed, no data was migrated, no scheduler was implemented, and no runtime release claim was advanced.


## 2026-10-15 — root package licensing metadata corrected

The root private `package.json` declared MIT while root LICENSE/NOTICE were absent and docs marked distribution permission unresolved. Set the **private workspace** SPDX metadata to `UNLICENSED` pending explicit Horizon-authored code license choice and audited notices; **did not modify `opencode/LICENSE` or any copied upstream license**. DOC-015 static test now blocks contradictory metadata. This is a conservative source-build disclosure, not a release-license decision or a claim that redistribution dependencies are cleared.


## 2026-10-15 — Features/Experimental source-status correction

§16.15.1 previously stated the TUI and app had no Features/Experimental surfaces; that was true of the pinned upstream-only snapshot, **false for current HorizonCode first-party overlays**. Verified `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/dialog-features.tsx` registered as `horizon.settings.features` in TUI app, `packages/app/src/components/settings-v2/features.tsx` mounted by settings dialog, and limited config helper tests. Updated §16 and §20 to **CODE_PRESENT/PARTIAL** and added DOC-016 static source-status guard. Not FEAT-001..014 full behavioral PASS: backend source/lock/pending/API and cross-surface integration remain open.


## 2026-10-15 — acceptance IDs structurally reconciled

§32 currently defines 334 unique acceptance case rows before DOC-017 was added. Existing convergence validation now checks duplicate case IDs, a nontruncated catalog and FEAT-001..014 / JC-RES-001..020 / DOC-001..017 presence (DOC-017). These are source/inventory checks rather than executable tests or a completed P1/P2 negative coverage claim. Real test-to-function/source trace, platform matrix, integration and CI acceptance are still separate release gates.


## 2026-10-15 — first-party Core ToolRegistry effect containment slice

Code was changed (not merely docs): `packages/core/src/tool/registry.ts` now filters unsupported effect classes before advertising tools, refuses missing Rust admission at settlement, permits the narrow guarded `files.write` only via the Location-owned `write` registration and denies an `ApplicationTools`/plugin declaration claiming the built-in ID. Added real Bun regression fixtures in `packages/core/test/session-runner-tool-registry.test.ts` for unadmitted, unsupported and spoofed effects. `kernel/src/managed_control.rs` now moves a PAUSED Run to RECONCILING when its admitted Attempt turns UNKNOWN; an integration test asserts durable replay and unsafe resume denial. The **actual guarded write** has been promoted to `code_present` in the canonical registry only (CODE-001). Neither same-process malicious plugins nor shell/MCP/desktop/REPL effects are universally mediated; **P1.3 and P2 still incomplete** until whole negative/action/provider test set passes. Final SHA CI must be verified.


## 2026-10-15 — first Rust resource headroom calculator (pure CODE_PRESENT, not WIRED)

Added `kernel/src/resource_budget.rs` with one conservative typed ReservationState enum and exact-integer headroom math implementing §18.18 for JC-RES-012.C–G. Rust unit fixtures cover measured+reserved double-debit, unknown/stale owner sample retains full reservation, terminal vs pre-launch reserve, >2^53 and overflow-safe subtraction and UnknownCapacity. The push gate invokes `cargo test --lib resource_budget`; this is a **pure calculation** with no OS process sampler, no authenticated worker/resource lease, no Run scheduler connection, no platform support or RAM benchmark. Resource control stays CODE_PRESENT/PARTIAL until integrated OS/authorization/negative tests.


## 2026-10-15 — reservation transition negative tests (pure code only)

Added fail-closed `ReservationState::validate_transition` to `kernel/src/resource_budget.rs` plus pure Rust tests for JC-RES-012.H/J: EXPIRY requires proven never-dispatched, launched uncertainty cannot expire, QUARANTINED requires reconciled return, RELEASE requires process exit and settled receipts, and RELEASED/EXPIRED cannot revive. No runtime Rust lease owner calls the helper yet. Proof flags must be derived from authenticated process identity, receipts and expected owner epoch and committed atomically; tests of supplied flags do not establish those facts. Do not promote resource management to WIRED on this basis. CI on final SHA is required.


## 2026-10-15 — trusted first-party write provenance gate

Real P1 spoof gap found in Core registry: any local `Tools.Service.register` was previously able to claim `files.write`/`write`, be advertised and receive a caller-supplied `EffectAdmission`. Added `isTrustedWrite` first-party instance provenance in `packages/core/src/tool/write.ts` and require it at both Core tool materialization and settlement in `packages/core/src/tool/registry.ts`. This rejects forged Location tools even if they invent an effect challenge; added a negative integration fixture to `packages/core/test/session-runner-tool-registry.test.ts`. Trusted built-in write still independently resolves/approves/executes via Rust. The provenance WeakSet only protects the honest module registration API; a malicious same-process plugin/code with arbitrary JS execution can still circumvent the host boundary. Universal Guard remains incomplete; release requires untrusted origin process isolation, authenticated process/lease validation and negative coverage. Confirm final-head typecheck/Guard CI before merging.


## 2026-10-15 — remove provenance module cycle

Adjusted the previous write spoof mitigation to avoid `registry.ts -> write.ts -> registry.ts` module initialization loops: first-party provenance is now stored in `packages/core/src/tool/write-provenance.ts` with a WeakSet and separate marker/check methods. The built-in write leaf marks only its constructed decorated tool; registry's advertised/settlement routes consult the same set. This is **trusted-process provenance**, not a hostile same-process JavaScript sandbox; the exported marker remains accessible to arbitrary code loaded into the trusted process, so real untrusted plugin isolation and Rust effect mediation remain P1 release blockers. No claim of universal mutation safety or external effect handling.

## 2026-10-16 — next coding-agent execution handoff

**User-directed execution method:** use separate subagents for P0, P1.2, P1.3→P2, P3, P4 and P5. P1.3 and P2 belong to the same agent, sequentially; do not start P2 until P1.2/P1.3 prerequisites actually pass. The main agent owns source/reference research and integration. Do not serialize independent modules or use the main agent to rediscover architecture already recorded in `arch_V1/`.

**Source-reuse direction:** before implementing, inspect the active owner docs, the local pinned OpenCode source and the exact immutable OMP/OpenCode references in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md`. Prefer reuse or bounded algorithm adaptation over a new parallel implementation. Inspect callees, tests, licenses, exceptions and dependency closure; record any copied/translated source in §42. Upstream patterns never override HorizonCode's canonical Core/Guard/ExecutionHost ownership. Unsupported effect origins stay unavailable.

**Native Windows testing authorization:** the user authorized task-scoped Windows testing under `/mnt/c/users/sonali/desktop/`, using a newly created temporary directory with a child `hzcode` folder. PowerShell 5.1.26100.9711 is available at `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`, and the Desktop path exists. No Windows test directory was created in this continuation. Create a unique task-owned directory; do not overwrite or remove existing Desktop content.

**Shared-tree safety:** at the `b9c9f46` status checkpoint: branch `p1.3-interactive-pty-integration`, 0 staged / 38 unstaged / 24 untracked paths; one registered worktree; 844 GB free; `kernel/target` 1.8 GB, `indexd/target` 69 MB, root `node_modules` 2.5 GB, and `packages/opencode/node_modules` 492 KB. The preceding six-path commit was `dd51d9e3050a853f46d273b55ce5fe3c22d245c1`; `b9c9f4656d182a97f47ac4e35d92c6b9e47a1d5f` recorded the gate/cleanup status. `git worktree prune --dry-run --verbose` found no stale registrations; no worktree was removed. Preserve the remaining shared dirty/untracked paths; no reset, clean, broad staging, or branch deletion.

**Current verification and limits:** workspace package audit passes at 36 workspaces / 0 undeclared / 0 errors; the PTY route is 1 pass / 4 skip and listener suite 9 pass / 3 skip. Markdown audit has 0 active blockers; convergence has 1,224 checks / 0 failures. The later mandatory `scripts/architecture/run_push_gate.sh` passed audits, kernel build, managed-control tests (10/10), and resource-budget tests (9/9), then failed at the Core TypeScript check with errors across Core and imported OpenCode/session/server owners. This supersedes the earlier standalone no-diagnostic Core typecheck result. No native Windows acceptance, full P1.3 origin proof, or P2 managed vertical was run; no push occurred.

**Immediate handoff:** read this file, `CURRENT_RUN.md`, root `AGENTS.md`, `arch_V1/README.md`, `arch_V1/17-GOVERNANCE-DECISIONS.md`, and the operative plan. Inspect exact tree ownership. Then do the requested P0/P1.2/P1.3→P2/P3/P4/P5 subagent split with non-overlapping write scopes; keep the P1.3/P2 dependency sequential. Main agent must finish pinned-source reuse review before authorizing ports, and run shared integration gates only after module handoffs.

## 2026-10-16 — Git publication and worktree cleanup

The user requested merging subagent worktrees, committing and pushing, then pruning worktrees. The repository has only the current checkout registered as a worktree; there are no separate subagent worktrees or stale registrations to merge/prune. Other pre-existing shared changes remain untouched.

The six verified handoff/test/audit paths were committed as `dd51d9e3050a853f46d273b55ce5fe3c22d245c1` (`fix(test): correct PTY harness and workspace audit`); the status/cleanup record was committed separately as `b9c9f4656d182a97f47ac4e35d92c6b9e47a1d5f`. Both are unsigned because the configured GPG identity has no available secret key. `origin` had no `p1.3-interactive-pty-integration` branch; at the `b9c9f46` checkpoint, the local topic branch was 8 commits ahead of `origin/main`. No push occurred.

Push is blocked: the required pre-push hook runs `scripts/architecture/run_push_gate.sh`, which fails in the Core TypeScript check. Do not bypass the hook. Repair the recorded Core/OpenCode type errors and rerun the gate before pushing. The uncommitted remainder is 38 modified and 24 untracked paths; inspect ownership before staging. The root `.horizoncode-e2e-20261013` sandbox is not a Git worktree and was not removed.

## 2026-10-16 — local main integration status

**Current branch:** local `main` was fast-forwarded from `c47657ef5` to `243bd986d9ae9e06296a60463a92adb47615aa9c` (`commit`) from `p1.3-interactive-pty-integration`, with no conflicts. The tree was clean after integration. `main` is 10 commits ahead of `origin/main`; **nothing has been pushed**. The prior 38-modified/24-untracked status above is historical and superseded.

**Publication gate:** `bash scripts/architecture/run_push_gate.sh` on merged `main` passed source, package, convergence, Markdown and provenance audits; kernel build; `managed_control` (10/10); and `resource_budget` (9/9). It exited 2 at `tsgo --noEmit` due to unresolved Core/OpenCode/server/session TypeScript errors. Examples include `SessionSupervisorError` not fitting route error channels, incompatible PTY/shell-profile errors, and a stale `source` property in `packages/opencode/src/session/revert.ts`. **Do not bypass the pre-push hook.**

**Branch/worktree cleanup:** there is one registered worktree (the main checkout) and no stale worktrees. No worktree was removed. The user selected pruning only local `p1.3-interactive-pty-integration`, and only after a successful push. Keep it until then. Preserve local `p2-foundation` and all remote refs; three remote refs are not merged into main: `origin/docs/readme-product-first-20261014`, `origin/docs/readme-visual-first-20261014`, and `origin/fix/p1-3-streamed-tool-input-lifecycle`.

**Immediate next steps:**
1. Fix the owning Core/OpenCode TypeScript contracts; rerun focused Core typecheck and the full push gate.
2. Push `main` only after the required gate passes.
3. After a successful push, delete only local `p1.3-interactive-pty-integration`; retain `p2-foundation` and remote branches. Verify status and worktree inventory.

**Resource check after gate:** 846 GB available; `kernel/target` 1.8 GB, `indexd/target` 69 MB, root `node_modules` 2.5 GB. No task-created worktree or service remains.
