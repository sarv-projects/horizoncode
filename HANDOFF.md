# HorizonCode — Current implementation handoff

**Verified remote source baseline:** `sarv-projects/horizoncode` `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54` (14 October 2026).  
**Active source/contract update:** 15 October 2026, branch `docs/jcode-resource-runtime-adoption-20261015` / PR #7; later commits include Core ToolRegistry/Rust managed-control code and regression tests, not only Markdown. Branch changes are unmerged; verify exact final-HEAD CI.  
**Implementation completion:** **NOT V1 RELEASED**. Documentation changes are not proof of implemented features. Recheck latest Git SHA, workflow and local status before editing; the connected GitHub repository cannot verify the user's local dirty tree.

This is the **current observed implementation-status entry point**, not a new design authority. The architecture is `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → exact topic owner. The implementation dependency queue is `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` (Gate 0–10, RC0–RC5). Root `CURRENT_RUN.md` is a dated work/evidence diary. Full superseded status chronology was preserved unchanged in `docs/architecture-archive/2026-10-15-handoff-pre-jcode-adoption.md`; older audit snapshot remains preserved in the existing archive.

External source pins, license and copying review: `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` (non-runtime evidence; current implementation status stays in HANDOFF).

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
| Whole-product memory/process budget | §18.17, §37.15, RC0 | **DESIGNED**, no first-party comparable benchmark | Exact-machine total process-tree PSS/RSS/CPU/FD/cache/disk/local-model VRAM at 1/5/10/20 Sessions; raw reproducible baseline, native OS metrics |
| Shared Rust virtual Session service | §01/§13/§20/§05/§14, RC1 | **PROPOSED**; current Linux observer is per Session | Read-only multiplex prototype then authenticated cross-session isolation, crash/recovery, fairness and Guard parity; measured improvement before effect-host cutover |
| Bounded headless workers and Task DAG | §15/§21/§29, RC2 | **DESIGNED**, internal P2 state only | Authenticated scheduler/leases, typed artifact edges, realistic concurrent tasks, independent revision-bound PASS |
| Provider Doctor / prewarm | §15/§33/§37, RC3 | **DESIGNED**, use existing provider transport | Offline no-network tier, bounded catalog test, explicit-consent full tool/chat/stream test, no paid fallback |
| File-touch and stale-write conflict handling | §21/§33, RC2 | **DESIGNED** | Advisory file-touch index and hard revision digest/lease denial under user edits and competing agents |
| RAM caches/local memory retrieval | §18/§30/§31, RC3 | **DESIGNED** | bounded bytes/TTL/entries; opt-in scoped recall and secret/privacy negatives |
| TUI redraw, live tool-tail, resource dashboard | §16/§31, RC4 | **DESIGNED**, underlying UI exists | idle/full-frame reason, stable prompt focus, bounded 10k-message streams, source-truth telemetry |
| SDK, import/resume, terminal steering, builds, optional mobile/self-dev | §13/§16/§33, RC3/RC5 | mix of existing underlying direct-session steering and new **DESIGNED** adapters | §42.10 mapped acceptance: no dual owner, authenticated clients, source provenance, rollback |

The accepted 20 base regression cases are `JC-RES-001..020` in §32.32, with additional required reservation/authentication subfixtures `JC-RES-012.C–L` in §32.37. The measurement protocol at `docs/performance/README.md` is a **runbook and unexecuted empty template**: it does not create runnable `scripts/perf/` or imply test results.

## Exact next implementation slice

**Highest-priority source gate: P1.3.** Audit live `packages/opencode/src/session/{tool-batch,prompt,tools}.ts`, `packages/core/src/session/{runner/llm,supervisor}.ts`, Rust `kernel/src/{guard,effect_host,request_cancellation,protocol}.rs` and their existing tests. Work from the first real unguarded direct shell/process/Task origin, implement pre-dispatch interception, scope/lease/prepared receipt, cancellation, restart/UNKNOWN, and negative process/subagent bypass tests; keep unsafe origins visibly unavailable pending proof. Do not introduce a second effect host or Session store.

**Parallel safe instrumentation (RC0):** measure the existing per-Session observer and entire host/child process tree, add platform-specific ResourceSampler and reproduce 1/5/10/20 task/model baselines on known hardware; separate native Windows vs WSL and local inference. Only after measurement and security parity should an isolated shared read-only SessionLink prototype be evaluated; don't blindly switch allocator, daemon or runtime.

**Then P2:** authenticated reviewed full SpecVersion → durable Task-DAG scheduler → worker/workspace/resource leases and typed headless delivery → effect receipt/UNKNOWN reconciliation → independent verifier/final integrated revision → UI/SDK. Remaining RC3–RC5 adopter improvements can be implemented in parallel where security/resource owners do not conflict, never by omitting capabilities on artificial scope grounds.

## Verification and continuation procedure

1. Inspect local tree status, pending worktrees, active build/child processes, disk/cache size, configured OS and newest main/PR HEAD. Never treat this remote source read as evidence the user's laptop worktree is clean.
2. Run focused source-owner tests and `bash scripts/architecture/run_push_gate.sh`; for CI/release also run `bash scripts/architecture/run_full_gate.sh` and actual scenario/platform tests. A docs-only CI pass is *not* a performance or runtime certification.
3. Implement one end-to-end vertical slice with a failing acceptance case first; then positive, bypass/negative, cancel/restart/UNKNOWN and workload/perf evidence where applicable.
4. Update this document's status only after exact merged commit, tests, platform/model and observed results are known. Add chronological details to `CURRENT_RUN.md` without creating another architecture authority. Use §42 pins/licensing before importing algorithms or code.
5. Record unverified/unsupported paths, user-approved provider cost, CI status, resource baseline and owned worktree/process cleanup. Do not publish quantitative speed/RAM claims without raw reproducible evidence.

## Documentation-update validation status

**Historical initial pass:** this PR originally edited Markdown only. Later commits on this same branch added real Core ToolRegistry admission/registration checks, Rust PAUSED→UNKNOWN reconciliation handling, and Bun/Rust negative tests (see the newest entries below). The initial source/heading/Markdown-format pass did not exercise OS/backend tests. Final GitHub Actions validation must be checked on the **latest PR head**; no native Windows/macOS, provider inference or JCode-vs-Horizon benchmark is established by these source edits.

## Detailed HLD/LLD readiness reconciliation — 2026-10-15 (documentation-only)

All 46 `arch_V1/*.md` active and compatibility Markdown files were rechecked structurally for duplicate/out-of-order numbered sections, balanced code fences and escaped code literal artifacts. Authoritative product HLD is §01.13; function-level wiring and source paths §10.15/§20.12; machine schemas §12.16; shared-kernel IPC §13.12; runtime flow §15.20; resource budget/sampling/cache §18.18–19/§30.21/§37.16; worker/DAG §21.11/§29.18; TUI/UI §16.17/§31.17; SDK/import/steering/canary §37.18; fault cases §32.33–34. The operative plan RC0–RC5 now has a function-to-code-to-test ledger. Historical `opencode/` Markdown and `docs/architecture-archive/` are inherited/reference, not parallel implementation authority.

**Source truth:** current code remains narrow Linux Session supervisor + guarded file write, partial non-executing P2 admission state and initial feature-exposure UI. No new schemas, shared daemon, RAM benchmarks, provider doctor, headless worker or native Windows qualification were run or implemented by these Markdown-only commits. Earlier PR #7 CI failed on numbered architecture headings and mandatory provenance pointers; both documentation faults were corrected in branch commits. **Recheck latest final-HEAD Actions status before merging**, and do not mark the real runtime implementation tests as passed based on docs-only typecheck.

## Cross-document omissions confirmed on 2026-10-15

- Root `SECURITY.md` and `CONTRIBUTING.md` had inherited OpenCode disclosure/project instructions. They now describe HorizonCode and link to the upstream copies only for provenance. The separate upstream vulnerability reporting URL/email **must not** be represented as HorizonCode's reporting channel.
- The operative §§3.16–3.18 accepted external agent/native OpenCode, visual edit and deploy/verify/rollback user journeys, but lacked complete service/permission/candidate/test bindings. Their **DESIGNED / NOT WIRED** contracts now live in §§14.18, 20.13, 29.19, 33.30, 37.19–20 and test cases ACP-001..008, VIS-001..004, DEP-001..008 in §32.35. The pinned OpenCode ACP server is code present; the Horizon outbound ACP client was not independently verified.
- Source input at `docs/architecture-input/universal-software-agent-v2-source.md` now explicitly declares itself historical non-normative; its older internal “Normative precedence” text does not override current `arch_V1/` decisions.
- The root redistribution LICENSE file was not present in the reviewed tree. Release licensing/attribution remains an **OPEN** gate; no license was chosen or copied in this docs-only pass.
- These are documentation and implementation-contract corrections only: no deploy/ACP/visual backend, RAM measurement, shared kernel, or universal Guard execution was implemented by this branch. Recheck GitHub CI on the **final head** before merge.

## Final cross-owner contract pass — 2026-10-15 (documentation only)

Re-read all **23 normative numbered architecture owners**, the root agent/implementation/status guidance and operative checklist from the PR #7 branch. Cross-reference scanning identified a broken `§31.18` pointer in PF-004, corrected to the actual §31.3/§32.21 performance owners; no other missing references were found among this scanned set of numbered active owners. This does **not** establish a human semantic line-by-line audit of inherited/archived/source Markdown; earlier 779-file upstream inventory was incorrect (actual count 152 tracked upstream Markdown in the complete Git tree at `dc61b665`).

- **Real specification conflict fixed:** §18.18's four-state `WorkerResourceReservationV1` (`ACTIVE` etc.) disagreed with §11.20's Rust reservation lifecycle, and §11.20's `SOFT/HARD` pressure labels disagreed with §18.18. §11.20 now owns seven exact reservation states and the canonical `SOFT_PRESSURE/HARD_PRESSURE` labels, with no `UNKNOWN` reservation state. §18.18 and §12.16 use those exact names. Expiry may release capacity only when no worker/effect was launched; after launch, unresolved process/effect remains `QUARANTINED` until receipt/process reconciliation and confirmed release.
- **Service authentication hardened in the design:** §37.17 now requires trusted authenticated scope on FileTouch ingestion/query/invalidation, headless broker operations and paid/network Provider Doctor operations; input session IDs, epochs, queue tickets, spend grants and effect leases are not self-authorizing. §13.12's READY response is distinct from the actual attachment ACTIVE state; §21.11 uses the same reservation lifecycle.
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
