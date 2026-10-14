# HorizonCode — Current implementation handoff

**Verified remote source baseline:** `sarv-projects/horizoncode` `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54` (14 October 2026).  
**Documentation update:** 15 October 2026, branch `docs/jcode-resource-runtime-adoption-20261015` / PR #7.  
**Implementation completion:** **NOT V1 RELEASED**. Documentation changes are not proof of implemented features. Recheck latest Git SHA, workflow and local status before editing; the connected GitHub repository cannot verify the user's local dirty tree.

This is the **current observed implementation-status entry point**, not a new design authority. The architecture is `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → exact topic owner. The implementation dependency queue is `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` (Gate 0–10, RC0–RC5). Root `CURRENT_RUN.md` is a dated work/evidence diary. Full superseded status chronology was preserved unchanged in `docs/architecture-archive/2026-10-15-handoff-pre-jcode-adoption.md`; older audit snapshot remains preserved in the existing archive.

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
| P1.3 Guard | `kernel/src/guard.rs`, `effect_host.rs`, V1/V2 ToolBatch gate, guarded write and bounded stream/cancel logic; actual focused tests from prior implementation work | Source-specific shell/process, Task/subagent, plugin/MCP/hook, hosted-provider, LSP/DAP/REPL, browser/desktop/network/automation no-bypass proofs; complete lease/receipt/UNKNOWN settlement |
| P2 managed control | `kernel/src/owner_log.rs`, `managed_control.rs` and tests for durable internal accepted spec, Task/Attempt states and restart/UNKNOWN | **Non-executing internal admission state only**: authenticated full reviewed SpecVersion RPC, real Task DAG scheduler, worker/resource leases, effect reconciler, independent verifier/verified final revision and end-to-end real work |
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

The accepted 20 explicit new regression cases are `JC-RES-001..020` in §32.32. The measurement protocol at `docs/performance/README.md` is a **runbook and unexecuted empty template**: it does not create runnable `scripts/perf/` or imply test results.

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

This PR edits Markdown only. The source/heading/Markdown-format checks were performed through GitHub reads; the full GitHub Actions validation was still running at the time this handoff entry was authored and must be checked on the **final PR head**. No native Windows/macOS tests, provider inference, JCode-vs-Horizon benchmark or new runtime features were run by this documentation-only task.
