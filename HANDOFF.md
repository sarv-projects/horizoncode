# HorizonCode — Current implementation handoff

**Verified remote source baseline:** `sarv-projects/horizoncode` `main@4e2086633d006f7d8b7709cb0df622f77a9b8d54` (14 October 2026).  
**Merged source/contract update:** PR #7 landed in upstream `main` at `db36dfdc40dad221078839a0aa4a98539e45b0d2` on 15 October 2026. It includes Core ToolRegistry/Rust managed-control source and regression tests, not only Markdown. Local merge and validation status is recorded in `CURRENT_RUN.md`; verify CI and tests on the exact integrated HEAD before release claims.
**Implementation completion:** **NOT V1 RELEASED**. Documentation changes are not proof of implemented features. Recheck latest Git SHA, workflow and local status before editing; the connected GitHub repository cannot verify the user's local dirty tree.

This is the **current observed implementation-status entry point**, not a new design authority. The architecture is `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` → exact topic owner. The implementation dependency queue is `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` (Gate 0–10, RC0–RC5). Root `CURRENT_RUN.md` is a dated work/evidence diary. Full superseded status chronology was preserved unchanged in `docs/architecture-archive/2026-10-15-handoff-pre-jcode-adoption.md`; older audit snapshot remains preserved in the existing archive.

External source pins, license and copying review: `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` (non-runtime evidence; current implementation status stays in HANDOFF).

## Latest reconciliation — 2026-10-19 18:01 UTC

This supersedes the older roster snapshots below: the user asked to stop all subagents, and the live agent list now contains only the parent. No phase owner is running. The OpenCode/Codex source crosswalk is recorded in `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` §42.12. It inventories the two local source trees and documents phase-specific reuse/adaptation/rejection decisions; it does not prove Horizon implementation or acceptance. No source code was copied in this source audit.

Current work remains PARTIAL / NOT RELEASED. The implementation-first hold remains: no tests, builds, typechecks, audits, provider probes or other validation workloads until source implementation closes. C: `/mnt/c` has 60 GB free (87% used); `node_modules` is 2.5 GB. `kernel/target` and `indexd/target` are absent in this checkout. One main worktree remains on `main`, 12 commits ahead of `origin/main`, with extensive mixed staged/unstaged/untracked changes. Preserve all state; ownership is not clear enough for staging, commit, push or cleanup.

## 2026-10-19 — live quota-reset continuation (supersedes the dated snapshots below)

**V1 remains PARTIAL, not verified or released.** Current workspace is the shared `main@6c8c5ab9a` checkout, 12 commits ahead of `origin/main`, with mixed staged/unstaged/untracked changes and no conflicts. Preserve all existing changes; no staging, commit, push or cleanup has occurred in this continuation. The current three child slots are occupied by whole-phase owners: P1 Guard/ExecutionHost, P3 RepoIntel/indexd, and P6 providers/settings/Doctor/S1. P6 has released the serialized Bun slot to P3; P1 owns the next Bun run. P1 remains the Rust build owner. P2, P4, P5, P7, P8 and P9 remain queued/partial and must be dispatched as slots open.

**Fresh evidence:** P1 reports `packages/opencode/test/tool/task.test.ts` 15/15 (117 assertions) after moving abort handling to the pre-created Attempt bridge; its enabled-origin no-effect matrix passed 34/34 (127 assertions) across MCP, plugin/hook, formatter, upgrade/install and LSP install/probe origins. Earlier this wave's Rust ToolBatch suites passed 8/8 and 9/9. A P1 interpolation acceptance selector still has 4 pass / 1 fail: the guarded positive shell interpolation is denied because assessed consent guarantees are absent; the negative no-spawn cases pass. Do not weaken that predicate. P3's ArtifactSearch suite passed 19/19 (108 assertions), its RepoTools forged-authority/stale-reference checks passed 2/2, and the full RepoIntel/RepoTools suites passed 54/54 (366 assertions); its unavailable-layer selector passed 1/1. P3 is continuing inert store/lifecycle work; the production RepoIntel query route stays unavailable until P1 provides an authenticated principal/Session-or-Attempt/Location/PermissionV2-bound read grant. P6 repaired its reported Core typecheck diagnostics; `packages/schema` typecheck passed, and Schema Skill/SecretBroker tests passed 8/8 (30 assertions). The final product-level `bun run horizoncode:typecheck` has not passed on the integrated revision. Remaining observed diagnostics are P1-owned Core supervisor/Git fixtures plus the unchanged `packages/opencode/src/storage/storage.ts` migration calling removed arbitrary `Git.Interface.run`; P1 has approved ownership of this narrow diagnostic and will replace it with typed read-only GitV2 operations. P6 still owns all remaining P6 acceptance.

The overlay audit just passed: `compared=6627 changed=283 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` was clean. ActivityStream is already mounted in the TUI session route; its rendered route/replay/large-history acceptance remains open. P5 has non-effectful cascade/config/Settings scaffolding for built-in, Brave and Exa, but the Guard readiness flag remains false and BYO routes are not connected to SecretBroker; provider dispatch, ordered failure/429/exhaustion acceptance and the final enabled cascade remain open. P6's offline Doctor intentionally reports UNKNOWN where effective configuration/catalog cannot be established safely; a real HTTP-handler test traps fetch and proves zero network/credential echo. Its question.ask live route and mixed-effect/spoof tests exist but still need final integrated rerun. C: has 22 GB free (96% used), `kernel/target` 12 GB, `indexd/target` 235 MB, `node_modules` 2.5 GB. No HorizonCode Cargo/Bun/typecheck process was running at the last check; preserve shared build outputs and avoid duplicate heavy work.

**Immediate sequence:** P3 has released Bun; P1 now fixes the remaining Guard/supervisor/Git diagnostics and resolves the positive interpolation guarantee without weakening authorization; P6 continues source-only phase work; P3 continues source-only indexd persistence/lifecycle work. Dispatch P2 as the first whole-phase owner when a slot opens. Keep unsupported/unevidenced effects unavailable. Rerun the integrated A1 typecheck, full required audits/gates and real journeys only after source settles; native Windows remains unavailable, and no push/release claim is supported yet.

**Latest continuation update — 2026-10-19 15:24 UTC:** User directed implementation first; no validation commands are to be started until implementation scope closes. Current active whole-phase owners are P6 providers/settings/Doctor/S1, P7 streaming/artifacts/analytics/automation/rewind, and P8 resources/workers/RC0. P1 and P2 owner sessions hit usage limits; P5 is unowned and P6 will take its web-search cascade after P6/S1 core work. P1 is first in the dispatch queue because dependent effects remain blocked. P3/P4/P9 and final release work remain PARTIAL or queued. Recent source-only movement: P6 added authenticated QuestionV2 routes and an opaque SecretBroker lease seam; P7 is replacing text-length replay cursors with source ordinals, separate offsets and fresh stream generations; P8 is adding an OwnerLog-bound worktree intent/receipt journal and RC0 owner-snapshot ingestion. These changes are not verified, and no effectful path is enabled from them. Production managed verification remains unavailable (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE = false`) until the independent typed verifier path is completed and its Guard/artifact prerequisites pass. Git remains mixed staged/unstaged/untracked on main, 12 commits ahead; preserve it, do not stage/commit/push/clean up. `/mnt/c` has 21 GB free; `kernel/target` is 2.3 GB and `indexd/target` is 292 MB. A long-lived Bun PTY selector with a HostKernel child has no currently listed agent owner; it was left untouched and does not count as release evidence.

**Owner refresh — 2026-10-19 15:34 UTC:** The P6/P7/P8 source-only owner sessions returned PARTIAL, so the three available child slots are now assigned to whole-phase P1 Guard/ExecutionHost, P2 managed vertical/independent verifier, and P4 LSP/DAP/REPL. P6/S1 and P5 remain PARTIAL; P5 web search remains hidden pending P1 Guarded outbound transport. P7 event sequence/generation work is source-present but its Rust artifact/checkpoint/automation integrations remain blocked on P8. P8 durable worktree/RC0/sample attribution code is source-present but needs P1 HostKernel integration and P2 final-verifier evidence. The new P1/P2/P4 owners were instructed not to run tests/builds/typechecks until all implementation is complete. V1 remains PARTIAL / NOT RELEASED; no code was staged, committed, pushed, cleaned or pruned.

**Latest owner update:** P3's new bounded generation store and debounced watcher invalidation passed `indexd` tests: generation_store 5/5, watcher integration 6/6, library watcher 8/8; rustfmt check is clean. `indexd/target` grew 235→267 MB and C: had 24 GB free. P3 released Cargo to P1. P3 keeps symbol/reference tools typed UNAVAILABLE until P1's authenticated HostKernel read grant and P4's supervised LSP boundary pass. P1 reports Core typecheck now passes after consent and fixture repairs; it still needs the full HorizonCode CLI-host package/TUI/Core A1 command. Its terminal approval fix must show an important host-derived safe argument summary; if that cannot be produced without exposing secrets, keep Allow unavailable. P6 has added an unverified RED test and source change to prevent plaintext `auth.json`/`OPENCODE_AUTH_CONTENT` reads; it must run after P1 releases Bun and continue durable SecretBroker/credential migration work. These updates do not change any phase to VERIFIED.

Read in this order:

1. AGENTS.md
2. arch_V1/README.md
3. arch_V1/17-GOVERNANCE-DECISIONS.md
4. arch_V1/10-DELIVERY.md
5. arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md when external source reuse is involved
6. this file
7. docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md

## 2026-10-18 — current implementation continuation

The user resumed implementation and requested full work on A1–A4 plus P1, P2, P4, P5, P6/S1 and P7. Whole-phase owners currently active in this shared checkout: P1 Guard/ExecutionHost, P2 managed-control vertical and P7 stream/artifacts/automation/rewind. P4, P5 and P6/S1 are queued for the next available child slots. P1 remains the first shared Cargo build owner; do not start another heavyweight Rust build until P1 releases that slot. No phase is VERIFIED or V1 RELEASED from this continuation.

**Current source reconciliation:** `packages/tui/src/routes/session/index.tsx` mounts `ActivityStream` at line 1663. The stream is now on the rendered session route, but P7 still owes route-level acceptance, large-history loading, replay/resnapshot, final-revision evidence and the rest of the P7 scope. The P5 implementation remains stale: `packages/opencode/src/tool/registry.ts` still says built-in search is deferred and gates only Exa/Parallel flags; `websearch.ts` selects one provider rather than the approved ordered built-in plus user-enabled BYO cascade. P5 remains implementation work; no search route may become effectful before P1 Guard acceptance.

**A4 overlay evidence:** after adding an exact `.gitignore` exception for the first-party `packages/opencode/test/tool/skill.test.ts`, `python3 scripts/architecture/audit_overlay_visibility.py` returned `compared=6627 changed=242 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0` (exit 0). This is a checkpoint result; rerun after all phase integrations because new files may change the result. Git remains heavily dirty on `main@6c8c5ab9a` (12 ahead / 0 behind), with no conflicts; preserve all existing staged, unstaged and untracked changes. No commit, push, cleanup or remote mutation occurred.

**Phase evidence received:** P7 owner reports its focused renderer/stream suite at 80 passed / 0 failed / 1,022 expectations; parent has not rerun it. The owner confirmed those tests do not yet mount the full Session route and is adding the strongest route integration harness. P1/P2 work and all remaining P4/P5/P6 acceptance are still in progress or queued. Keep cancellation/restart/UNKNOWN, Guard-denial, distinct reviewer, actual workspace revision and independent verifier gates fail-closed until verified on the integrated revision.

## 2026-10-18 — stop-for-today V1 checkpoint

The user asked to stop implementation for today and leave a restartable record. **HorizonCode V1 is not complete or released.** The detailed phase ledger and resume plan are in the final `2026-10-18 — stop-for-today V1 continuation checkpoint` section of `CURRENT_RUN.md` and the matching checkpoint in `implementationtov1release.md`.

**Both `horizoncode` and `hzcode` must start the CLI** — decision finalized 2026-10-18: `horizoncode` canonical, `hzcode` short command, same entrypoint/runtime, no second implementation. Implemented same day and reconciled across A-V2-27, root `AGENTS.md`, the operative plan and `arch_V1/10-DELIVERY.md`; `packages/opencode/package.json` bin map and `install` provision both names. Verified: sandboxed installer installs and runs both; both npm-bin shims spawn the same wrapper; real CLI starts (`bun run ./src/index.ts --version`, exit 0). Deeper package-scope/import renames remain the staged post-V1 migration.

**Design-hole closure assignments recorded 2026-10-18** (full audit `CURRENT_RUN.md` §8; gates `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.4): OS-confinement backend (`horizoncode-sandbox`) → **P1** — crate PHASE_VERIFIED (24/24 tests, 2026-10-18); parent source audit on 2026-10-19 confirms HostKernel terminal-consent and stdio preflight/launch call paths reach `spawn_prepared`. This corrects the historical “wiring remains open” note: source status is **WIRED**, while product containment, denial, mismatch, cancellation and recovery acceptance remain open. §42 SRC-026 recorded. Checkpoint/rewind LLD closed (`§14.19/§16.18/§31.18`), wiring **P7** + **P8** acceptance; HorizonCode-as-MCP-server → post-V1 `DEC-V1-23`; editor/IDE extensions beyond CLI/TUI → post-V1 `DEC-V1-24`; **built-in web search → promoted into V1 on 2026-10-18 (`DEC-V1-26`)**: built-in default route + BYO-key provider cascade with Settings control, per §37.5/§16.7/§32 (implementation remains incomplete). Derived navigation for final V1: `arch_V1/45-V1-EVENT-FLOWS-ATLAS.md` (non-normative synthesis; owners win on conflict). No feature status was promoted.

### Phase status at pause

| Phase | Last reported evidence | Remaining gate |
|---|---|---|
| P1.3 Guard | Owner reports Core runner **93/0** (308 assertions), write/registry **27/0** (71 assertions); stand-down ack: `terminal-run-live` user-origin/over-limit subset **2 passed / 31 assertions**. | Shell/interpolation, Task/subagent, enabled-origin closure, multi-call ToolBatch, leases/receipts/UNKNOWN, cancel/restart, native Windows; wire the verified `horizoncode-sandbox` backend into ExecutionHost (§14.5). |
| P2 managed control | Owner reports managed-control client **15 passed / 63 expectations**; typecheck exits 2 on 3 diagnostics in `test/session/llm.test.ts` (L822/834/839). | Authenticated reviewer, Attempt-issued intent/lease, live workspace revision, independent verifier, Core→TUI delivery. Keep execution/finalization disabled. |
| P3 RepoIntel | No edits/tests in final continuation; prior owner report **44 passed / 342 expectations**, not rerun. | Authenticated bounded HostKernel indexd bridge; ~72 MB frame exceeds 6 MiB RPC cap. Keep symbol/reference production route unavailable. |
| P4 LSP/DAP/REPL | Owner reports full focused suite `test/lsp test/dap test/repl` **198 tests / 654 expectations passed**; typecheck exits 2 with diagnostics in `test/session/llm.test.ts` and TUI files. | P1 Guard, trusted executable resolution and OS confinement; effectful production paths remain unavailable. |
| P5 | Web search promoted to V1 (`DEC-V1-26`, 2026-10-18); browser/desktop deferred by A-V2-31. | Web search: built-in default + BYO-key provider cascade + settings/provenance; browser/desktop unavailable. |
| P6 + S1 | Earlier parent-run settings/questions **43 passed / 132 expectations**; live question route/TUI suites **4/4** and **15/15**. Free provider is accepted but quota-bound (429). Doctor schema/projector **4 tests / 18 assertions**, MCP/index/HTTP **6 tests / 46 assertions** reported by owner; latest S1 checks verified: `tool-filter` 1/1, tools 2/2, ToolBatch 51/51; typecheck blocked by 3 diagnostics in `test/session/llm.test.ts` (L822/834/839). | Free-model 200/coding task only after quota reset; no paid fallback. Doctor offline route/TUI invocation, complete S1 ToolBatch/projection/denial and settings/catalog/provenance acceptance remain. `.gitignore` parent-owned (A4 clean). |
| P7 stream/artifacts | Owner reports `collapse-tool-output` **10 passed / 46 assertions**; activity stream still not wired to the route; raw tool args and raw ReasoningPart body can still render. No rendered TUI/cassette journey. | Real route integration, redaction/total bounds/order/expand/focus/scroll tests, replay/resnapshot, artifact/automation integration. New activity-stream component/test and transcript-window test are now Git-visible (A4 done). |
| P8 resources | Owner reported at handover: sampler attribution race + durable capacity-revision drift + task-verification gap fixed; `cargo test --test resource_sampler --test worker_durable --test task_dag --test worktree_pool` → **152 passed / 0 failed**; rustfmt clean; RC0 Python **48 passed**. | Worker control needs authenticated P2 ingress (boundary proposal recorded in `CURRENT_RUN.md` handoff ledger); no eligible product 1/5/10/20 baseline or fan-out. |
| P9 release | Prior readiness **46/46**; release gate **BLOCKED with 20 blockers**, install matrix `NOT_RUN`. | A4 visibility (**done 2026-10-18**: overlay audit 0 hidden / 0 stale), candidate/license/install/platform and final CI gates; no product install, signature, legal decision or publication. |

### Dirty-tree ownership and subagent roster (2026-10-18 ledger)

All work lives in the **single worktree** `/home/sarvesh/business_Dev/agentx` (`main@6c8c5ab9a`, 12 ahead of origin, nothing pushed; counts at ledger snapshot: 150 staged + 71 unstaged + 19 untracked (final), no conflicts). The complete file-group→phase ownership map, phase-owner session IDs, resume mechanics, verified-evidence stamp and next-agent gotchas are in the **"2026-10-18 — HANDOFF LEDGER"** section of `CURRENT_RUN.md` — read it before restarting any phase.

Phase-owner sessions (resume by passing the same sessionID to `subagent`): P1 `ses_eb4ead3d5ffeRPhH6sBFf5yh4m` · P2 `ses_eb4ea6f76ffeWOqS08OuA9sNF5` · P3 `ses_eb5c8750effemMX5TknS2W9BKz` (idle; needs the P2/P3 indexd-bridge contract ruling) · P4 `ses_eb4ea55beffelFV6p02FxIUts3` · P6 `ses_eb4ea9ac3ffeWjhEt6icLS9lu8` · P7 `ses_eb4ea477cfferUPmzt4e6bZocg` · P8 `ses_eb4ea3906ffeV3axR6J4Jg29G3` · P9 `ses_eb4ea22feffeUap4qJxFOPUukA` (idle; release qualification is authorization-gated). P5 stays deferred.

**Post-handoff additions (2026-10-18, same day):** paste-ready next-agent prompt in `HANDOFF_PROMPT.md`; explicit remaining-work ledger (implementation / verification / tests / real-case acceptance / user decisions) in `implementationtov1release.md` §"Explicit remaining work"; `AGENTS.md` now carries the unit-size/concurrency mandate (whole phase per subagent, max safe fan-out, no micro-slicing) and the remaining-ledger duty at every stop; competitive desk-analysis (Codex-verified) in `CURRENT_RUN.md`.

### Tree/process preservation and next start

- Local `main@6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind. One registered worktree. Latest Git status at the 2026-10-18 ledger snapshot: 150 staged paths (69 added, 81 modified), 71 unstaged modifications, 18 untracked paths, no conflicts. Preserve all contents and staged state; no commit/push/cleanup occurred.
- No HorizonCode build/test process remains (final stop check: only harness MCP servers run). The former unrelated user-owned LiteCowork Cargo build has ended; the shared Cargo slot is free — still keep one heavyweight Cargo/TypeScript build at a time on this WSL machine. `df` showed ~824 GB available; `kernel/target` ~3.0 GB and `indexd/target` ~207 MB.
- On restart, repeat the mandatory root bootstrap and Engram reload, confirm phase-owner stop acknowledgments and P6 `.gitignore` ownership, then inspect tree/processes again. Reconcile the both-command decision; continue P1 before enabling dependent effects, prove one P2 managed Attempt before worker fan-out, then resume P7 route wiring and P3/P4 safe work. Run P8's four Rust regressions only after the unrelated Cargo process exits and P1 releases the shared slot.
- Full V1 still requires the accepted Linux/WSL CLI/TUI scope, integrated Guard and managed-work acceptance, all applicable providers/settings/LSP/DAP/REPL/stream/artifact/automation/resource/worker goals, eligible RC0 workloads, both command startup checks, clean install/migration, license/notices closure, final architecture/visibility/typecheck/push/full gates, and independent final-revision evidence. Native Windows remains unavailable; post-V1 surfaces stay deferred; no hidden paid fallback. See the tracker for the detailed release-critical checklist.

## 2026-10-17 implementation wave — verified state and active workstreams

- **S1 follow-up:** reran the Core V2 question route and tool tests → **4 pass / 23 assertions**; TUI question, V2 notifications, and settings tests → **15 pass / 70 assertions**. The live route covers multi-question reply/reject, exact V2 events, and foreign-session denial; notification tests cover V2 asked/replied/rejected dedupe/cleanup. No provider call was made. Focused question/notification behavior has no known open test gap on this dirty tree; S1 remains `PARTIAL` until final integrated-tree verification.

- **Phase packages returned and parent-verified** on the current dirty tree (base `6c8c5ab9a`): P1.3 Guard origin matrix spot-checks (`tool_batch_guard_matrix` 6/6, `effects_host_process` 9/9, `host_terminal_process` 2/2, `effect_host_principal` 11/11, `hz_kernel_process` 2/2); P3 RepoIntel (`repo-intel` 29/29, `artifact-search` 16/16, `indexd cargo test --offline` 58 pass) plus the parent-completed shared grant — new `packages/opencode/src/tool/repo-tools.ts` (`repo_tree`, `symbols_search`, `references_find`) behind `OPENCODE_EXPERIMENTAL_REPO_TOOLS`, `RepoIntel.node` (fail-closed unavailable backend) in the registry graph, and V1 web-search fail-close (`webSearchEnabled` now requires explicit exa/parallel flags) — full `bun test test/tool` 311 pass / 0 fail and `bunx tsgo --noEmit` clean; P4 LSP/DAP/REPL `bun test test/lsp test/dap test/repl` 159/159; P6+S1 settings/question 43/43; P9 release harness 32/32 with the release gate still `BLOCKED` (18 blockers).
- **Free-model access (user decision 2026-10-17):** free models are included under the `opencode` provider in direct mode. Live evidence: the official v2.0.31 client works keyless from this machine; the keyless request identity and gateway acceptance predicates were captured and characterized; the daily free quota (~200 requests) is exhausted (`Retry-After` to ~00:00 UTC). Full findings: `/tmp/opencode/free-model-findings.md`; decision + evidence in `implementationtov1release.md` (Provider and OpenCode SDK decision gate). Not yet done: live HorizonCode acceptance (an accepted-but-quota-bound request reads `429 FreeUsageLimitError`; a predicate miss reads `403 FreeTierError`) and the free-model coding-task runs (pending quota reset).
- **Completed this wave (2026-10-17):** (a) P6-OP + parent last-mile fix — the keyless `opencode` provider now exposes free-only models (`apiKey "public"`, paid hidden, AN-002) with honest 429/403 surfacing and a version-like source-run `User-Agent` (`packages/opencode/src/session/llm/user-agent.ts` + regression test); **the fork's own requests are accepted by the free-tier gateway live** (accepted-but-quota-bound `429 FreeUsageLimitError`); real 200 + free-model coding-task runs are pending the daily quota reset (~00:00 UTC). (b) P2-RPC — `managed.v1` kernel RPC (admit/settle/cancel/snapshot, one-use delivery keys, fail-closed negatives, real-socket tests) + Goal-review dialog mount (`/goal`); scoped `cargo test` **209 pass / 0 fail**, TUI goal-review/app-lifecycle 9/0, tsgo clean. Remaining before C15/C20 release: plan-ingress RPC, TS managed client + TUI delivery route, and the Core tool-batch consumer.
- **Parent repairs this wave:** exact `.gitignore` exceptions now cover the prior P1/P3/P6/P9 paths and current C15/Guard/P4/P7/P8 additions (including LSP launch/server, `question.ts`, managed-control client, SVG worker, worker/DAG tests and fixture). Latest `python3 scripts/architecture/audit_overlay_visibility.py` → **6,627 compared / 230 changed / 0 missing / 0 symlink delta / 0 hidden changed/new / 0 stale unignore**. `apply_patch.test.ts` denial-message expectation remains aligned with P1 Guard wording (`guarded operation set or lease changed`).
- **P3 indexd transport (crate-side only):** `indexd/src/transport.rs` and `handler.rs` now provide the bounded `indexd.v1` codec/handler and documented bridge contract. Parent reran `cd indexd && cargo test --offline --locked` → **97 passed / 0 failed**; the owner reports fmt, clippy and rustdoc clean. The kernel `indexd.v1` bridge, supervised `hz-indexd` lifecycle and TypeScript backend replacement remain open, so RepoIntel symbol/reference queries still fail closed with typed errors. Bridge work is queued behind the C15 owner's `host_kernel.rs`/`hz-kernel.rs` changes.
- **Tooling note:** subagent *continuations* of previously-completed sessions were persistently rate-limited this day; fresh owner sessions worked.

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
| P4 V1 capabilities / P5 web search + deferred surfaces | Existing source/tooling and design/service seams | V1: Guarded LSP/DAP/REPL, web search broker, Linux/WSL task acceptance. Post-V1: browser/desktop runtime. |
| P6 V1 CLI/TUI | Existing OpenCode-derived models/tools/extensions plus initial Features UI and feature-exposure code | OMP-adapted providers/settings/TUI, full effective/locked/source/pending settings state, extension security and evidence; web/desktop parity is post-V1 |
| P7/P8 V1 CLI/TUI and resource control | UI architecture and durable control foundations; bounded Rust process-local resource-reservation and worktree-lifecycle models with focused tests | Stable streaming/render/artifact/analytics/automation paths, durable/runtime resource and worktree controls, worker controls, long-horizon recovery/verification and measured performance; no web/desktop surface requirement |
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

The accepted 20 base regression cases are `JC-RES-001..020` in §32.32, with additional required reservation/authentication subfixtures `JC-RES-012.C–L` in §32.37. The measurement protocol at `docs/performance/README.md` is a **runbook and unexecuted empty template**. Executable pieces include `scripts/perf/rc0.py` (29 unit tests pass), `kernel/tests/resource_sampler.rs` (9 tests previously passed), `kernel/src/resource_budget.rs` (20 focused budget/reservation tests pass), and `kernel/src/worktree_pool.rs` with `kernel/tests/worktree_pool.rs` (30 pass). The budget and worktree owners remain process-local models, not OwnerLog/runtime services; the worktree pool does not manipulate filesystem worktrees. **No 1/5/10/20 raw baseline capture is eligible or produced**: live Session owner identities and matching task outcomes are unavailable, so RC0 remains `NOT_BASELINE` and no optimization result is implied.

## Exact next implementation slice

*(2026-10-17 note: the wave section above supersedes this ordering for current status; the P1.3 host-kernel detail below is kept as historical record.)*

**P1.3 host-kernel prerequisite, then first direct origin.** The normative §§14/37 architecture selects a host-scoped `hz-kernel`; do not revert the Session supervisor into a second effects owner. *(Status 2026-10-15 evening: `hz-kernel` builds; `kernel-projection-live.test.ts` is 10/10 (104 assertions) against the real host, and `terminal-run-live.test.ts` is 7/7 (68 assertions) for the guarded session-batch run path. The latter proves deny → zero spawn, approved real execution with receipt and both truncation flags, one-use lease replay rejection, timeout without orphan process, and durable UNKNOWN when dispatch is withdrawn. This does not yet prove the Core `Pty.runUser` UserAction route.)* Remaining P1.3 work, in order:
1. ~~Fix user-origin effects~~ **Rust HostKernel/EffectHost path implemented 2026-10-15**: `guard.rs` splits `EffectOriginKindV1` (`SessionBatch` requires Session + sha256 turn context for every action including `terminal.run`; `UserAction` is `terminal.run`-only, needs principal + explicit approval, and cannot claim files.write), and the origin kind is fixed by the Canonical operation rather than a caller-supplied field. Core `Pty.runUser` calls `prepareUserEffect` and then the same host execution path; existing Rust principal tests pass, but a real Core-through-host user-origin test is still required.
2. ~~Make reconcile echo the prepared operation~~ **done 2026-10-15** (`kernel/src/effect_host.rs` reports `run` for terminal challenges, `write` otherwise, patch targets unchanged) with an exact-value Rust assertion; live `test/terminal-run-live.test.ts` is 7/7 against the rebuilt binary.
3. Retarget all stale `effects.v2` process-integration coverage in `kernel/tests/session_supervisor_process.rs` to the actual `hz-kernel` owner, preserving positive, denial, restart/recovery, and concurrency cases; implementation is underway.
4. Implement the interactive PTY surface (`terminal.start/input/resize/cancel/status`, tickets) in `hz-kernel` through Guard/EffectHost, with bounded replay and restart/UNKNOWN behavior. **Rust side landed 2026-10-15 late** (`kernel/src/host_kernel.rs`, `kernel/src/terminal.rs`, `kernel/src/terminal_process.rs`, `kernel/src/bin/hz-kernel.rs`): subscriptions with bounded replay, explicit `resnapshot_required` on eviction, cursor/digest-bound events, restart status `unknown`/`sessionLost` with empty replay, and a Linux preflight refusal when process-tree cleanup after owner loss cannot be guaranteed. `cargo test --manifest-path kernel/Cargo.toml` is **fully green** (107 lib + 11 `effect_host_principal` + 9 `effects_host_process` + 1 `host_terminal_events_process` + 2 `host_terminal_process` + 10 `hz_kernel_process` + remaining suites), and `cargo fmt --check` is clean. **Consequence:** interactive `terminal.start` fails closed on Linux with `UNAVAILABLE` before lease consumption; only native Windows ConPTY acceptance can demonstrate a live interactive terminal.
   Core side: `subscribeHostKernelEvents` no longer closes the shared host channel on a resnapshot control (subscription-scoped, ACK routed through the delivering subscription, bounded retry budget so a host refusal cannot spin), and `Pty.attach`/`Pty.recoverResnapshot` page `terminal.v1/status` in 64-KiB pages, slice replay by the attachment's own byte cursor, and surface `SessionSupervisorError`/`Pty.UnavailableError` as typed 503s instead of hanging.
5. Latest targeted evidence (2026-10-16): `cd packages/core && bun run typecheck` returned without diagnostics; this was not a full workspace typecheck (the last full-workspace checkpoint remains 26 diagnostics in other owners). `cd packages/opencode && bun test test/server/httpapi-listen.test.ts` is **9 pass / 3 skip / 0 fail** (37 assertions). The former positive external-plugin reuse case was removed after tracing `Plugin.state`: it loads internal plugins and reports configured external server plugins unavailable until Guard/ExecutionHost are wired. Do not treat its removal as plugin runtime acceptance or restore an unguarded path.
6. Canonical `/api/pty` harness correction (2026-10-16): the test helper now uses `HttpApiApp.createRoutes()` with the configured `OPENCODE_SERVER_PASSWORD`, rather than global `HttpApiApp.webHandler()`. Wrong Basic password returns 401; authenticated Linux PTY creation returns typed 503 `ServiceUnavailableError(service=host-kernel)`; the list remains empty. `cd packages/opencode && bun test test/server/httpapi-v2-pty.test.ts` is **1 pass / 4 skip / 0 fail** on Linux. The earlier 403 was test-harness configuration, not missing production authorization middleware. Windows-only live cases are updated to use `cmd` but remain unexecuted; native Windows ConPTY/pipe-auth/Job Object acceptance is open. The prior location-scoped `Pty.Service` fix and `/status` smoke result remain as recorded.

**Parallel safe instrumentation (RC0):** continue qualifying and wiring the §37.17 ResourceSampler only behind existing Rust-owned process/lease identities; measure the whole owned process tree with PID-start fencing, Linux PSS/RSS/CPU/FD and native Windows private bytes as separate methods, local inference separately, UNKNOWN on unsupported/denied counters, and redacted bounded samples. Reproduce the JC-RES-001..004 1/5/10/20-session workloads only when valid owner identities and matching task outcomes exist; no runtime/PSS acceptance is inferred from schema, self-check harness data, or WSL.

**Then P2:** after P1.3 admission and receipt reconciliation pass, implement one accepted SpecVersion → one durable Task/Attempt → one bounded Guard-mediated action → durable evidence/receipt → independent final-revision verifier. Prove pause/cancel/restart/UNKNOWN and human-edit conflict before worker fan-out; then progress to resource/workspace leases and UI/SDK.

**Snapcompact:** source review finds transient request-context imaging and persistent archive compaction are separate. Neither is available in V1; no runtime, setting, command or capability. A later ContextService projection is plausible only after P1.3/context fidelity, exact-model capability and image-aware budget/privacy/cost/recovery proof. See §§16.15.2/30.4 and §42 SRC-024.


**Current code checkpoint (2026-10-16, updated):** the P1.3 host/session implementation remains in progress. `hz-kernel` effects.v2 and terminal.v1 surfaces, bounded PTY replay/resnapshot recovery, and prior Linux real-binary tests are recorded above. This continuation proves the configured `/api/pty` auth harness and Linux fail-closed refusal, and the listener suite is green with 3 platform skips. Open gates: complete P1.3 origin closure; the real `shellImpl → spawner.spawn` Guard path; Core `Pty.runUser` UserAction-through-host proof; native Windows ConPTY/pipe authentication/Job Object acceptance; and the rest of P2–P9. External configured server plugins remain unavailable until Guard/ExecutionHost mediation exists.

## 2026-10-16 — V1 scope boundary (revised user decision; no status changed)

V1 is Linux/WSL-first **CLI/TUI**; native Windows remains truthfully UNAVAILABLE until native acceptance. Web, desktop, browser automation/attached-browser and desktop/computer control are post-V1; built-in web search is V1 (`DEC-V1-26`, 2026-10-18). LSP, DAP, bounded REPL, web search, OMP-preferred providers/settings/TUI, streaming/rendering, artifacts/analytics/automation, worker/resource systems, caches/local memory, Doctor/import and measured resource/performance work are V1 goals—not verified features. The maintained finish/status/source map is `implementationtov1release.md`; dependency order remains in the operative plan under "2026-10-16 — V1 scope decision". P1.3 Guard remains open; the P2 managed vertical must precede worker fan-out. OMP is the preferred source for compatible non-OpenCode provider and CLI/TUI patterns; official OpenCode SDK/API use requires explicit backend/session ownership and real entitlement tests. New adapted first-party modules use HorizonCode naming; preserve licenses/notices and genuine dependency IDs. This scope update promotes no implementation status and does not change observed P1.3/P2/release evidence.

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

**Current verification and limits:** workspace package audit passes at 36 workspaces / 0 undeclared / 0 errors; the PTY route is 1 pass / 4 skip and listener suite 9 pass / 3 skip. Markdown audit has 0 active blockers; convergence has 1,224 checks / 0 failures. The later mandatory `scripts/architecture/run_push_gate.sh` passed audits, kernel build, managed-control tests (10/10), and resource-budget tests (9/9), then failed at the Core TypeScript check with errors across Core and imported HorizonCode CLI-host package/session/server owners. This supersedes the earlier standalone no-diagnostic Core typecheck result. No native Windows acceptance, full P1.3 origin proof, or P2 managed vertical was run; no push occurred.

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
1. Fix the owning Core/HorizonCode CLI-host package TypeScript contracts; rerun focused Core typecheck and the full push gate.
2. Push `main` only after the required gate passes.
3. After a successful push, delete only local `p1.3-interactive-pty-integration`; retain `p2-foundation` and remote branches. Verify status and worktree inventory.

**Resource check after gate:** 846 GB available; `kernel/target` 1.8 GB, `indexd/target` 69 MB, root `node_modules` 2.5 GB. No task-created worktree or service remains.

## 2026-10-18 — current resumed phase evidence

- **Tree:** preserved the existing staged/unstaged/untracked files on `main`; one worktree, no conflicts. Parent reran A4 after fixing hidden `api.ts`, `websearch.ts`, SDK generator, and new Goal-review handler paths. Audit passed at this point: `compared=6627 changed=246 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. Rerun after remaining source changes.
- **P1/P2 shared boundary:** `cargo check --locked --offline --manifest-path kernel/Cargo.toml --lib` passed after both owners wired the managed Attempt scope digest across HostKernel→Guard. P1 removed the Core Bash leaf's direct process implementation; `test/tool-bash.test.ts` passed 3/3 and the OpenCode origin/batch suite passed 71/0. A first 119/2 Core run used stale `hz-kernel`; rebuilding from current source made the exact deadline regression pass. Fresh interrupt returns `completed=false`, but the old pre-cancel PID assertion reads a PID from bubblewrap's namespace; a unique host-visible process marker fixture is pending. P1/P2 have landed the `EffectAttemptScopeV1::{Managed,Direct}` contract; direct child effects remain denied until HostKernel validates durable principal/workspace/permission/budget/revision facts and P1 binds the exact digest into the Guard lease.
- **P2:** still active and incomplete. Distinct reviewer, actual current workspace revision, independent verifier evidence, effect-intent recovery, Core→TUI E2E and fault cases remain unverified.
- **P4:** whole-phase owner `p4_lsp_dap_repl` is active. Updated focused suite passed `bun test --timeout 30000 test/lsp test/dap test/repl`: 204/0 (671 expectations). Broker/session records are being bound to authenticated owner/workspace/policy/sandbox state. Process/callback exposure remains fail-closed pending a stable typed P1 Guarded ExecutionHost API; no real-project OS journey is yet verified.
- **P5:** owner returned PARTIAL. Cascade/config and builtin/Brave/Exa Settings dialog are implemented. Verification: HorizonCode CLI-host package tests 23/23 (66 assertions), HorizonCode TypeScript package typecheck (`packages/opencode`) clean; dialog 1/1 (9 assertions), TUI typecheck clean; parent app command test 1/1 (7 assertions). `web.search.settings` now opens the dialog. `WEB_SEARCH_GUARD_READY=false`, and tests prove zero outbound requests. Remaining: P1's Guarded outbound HTTP/receipt/cancel contract, then real adapters and provider failure/429/exhaustion acceptance.
- **P6/S1 and P7:** queued behind the three live child slots (P1, P2, P4); assign whole-phase owners as slots free. P3/P8/P9 and final release checks also remain in the V1 ledger.
- No phase is VERIFIED/RELEASED; no staging, commit, push, cleanup, paid API call, or native Windows acceptance occurred in this checkpoint.

## 2026-10-18 — post-compaction continuation

- Current child roster is P1 (`p1_guard_resume`), P2 (`p2_managed_resume`) and P4 (`p4_lsp_dap_repl`); the three child slots are occupied. This supersedes older roster statements in the file. The shared tree remains preserved on `main` with 150 staged, 112 unstaged and 33 untracked paths; one worktree, no conflicts. No build/test process was found at the latest scan; P1 owns the next Cargo acceptance wave and P2/P4 coordinate the TS check.
- P1's rebuilt-kernel terminal deadline/cancel fixtures pass 2/2 (19 expectations). The former host PID assertion observed a bubblewrap namespace PID and was invalid. P1 is repairing an owner-loss cleanup fixture whose first assertion checked only `/proc/<pid>` and timed out; it is verifying exact argv identity/process state. No production change from that fixture is accepted yet.
- P2 reviewer boundary: a distinct authenticated ServerAuth principal delegated by Core is an acceptable reviewer identity channel only when it comes from trusted connection state and matches a durable assignment. Independent verification still requires a trusted run/result bound to the live workspace revision plus concrete artifact/test evidence. Keep finalization and executor unavailable until this proof passes.
- P4 focused LSP/DAP/REPL suite: 204 passed, 0 failed, 671 expectations. Effectful routes remain fail-closed until P1's Guarded ExecutionHost interface and Linux/WSL journeys pass.
- Next whole-phase owners on slot release: P6/S1 and P7, followed by P5 resumption once Guarded outbound HTTP is established. P3/P8/P9 and release/CI checks remain in the V1 ledger. No phase is VERIFIED or V1 RELEASED.
- P4's exact P1 blocker: the current Guard/EffectHost prepare/lease API is terminal-only; there is no generic non-PTY ExecutionHost dispatcher. P1 owns a shared supervisor contract for capability + host-resolved executable/profile + bounded args/env + cwd/workspace/Location + Attempt scope, with exact lease/snapshot checks before confined dispatch and receipt/UNKNOWN settle/recovery. P4 confirms it will not call `horizoncode-sandbox` directly or add a parallel launcher; all routes remain disabled.
- P1 latest current-source Cargo wave: library **196/196**, `effects_host_process` **10/10**, and authenticated `host_terminal_events_process` owner-loss case **1/1**. `host_terminal_process::interactive_lifecycle_requires_approved_guard_lease` initially failed because the fixture prepared one argument map and dispatched another command; EffectHost correctly denied the changed digest. P1 is correcting the fixture to dispatch the exact approved arguments and will rerun it. `tool_batch_guard_matrix` was not reached. This is not a production Guard defect based on current evidence.
- Follow-up: P1's focused `host_terminal_process` rerun is now **2/2 passed**. Both initial failures were fixture issues: changed approved launch payload and a literal `\\n` that combined commands (only 369 output bytes); exact prepared args and a real newline now verify approval and >2 MiB replay eviction. P1 found direct child Attempt still does not bind EffectIntent or propagate scope through child prompt→ToolBatch; it remains fail-closed and P1 owns completing/testing the path.
- P2 managed validation: current Cargo wave compiled, lib **198/198**, `direct_attempt_rpc` **8/8**. `hz_kernel_process` self-review denial fixture omitted `expectedRevision` and failed during parsing; P2 is fixing and rerunning the focused socket target. Do not claim its HostKernel revision/evidence regressions verified until the rerun reports exact results.
- P4 added trusted REPL output/status reference checks bound to owner, workspace, sandbox generation and capability ceiling; focused suite **205 passed / 0 failed / 686 expectations**, Prettier clean. Next shared package typecheck follows P2's focused Rust target.
- P2 repaired the `hz_kernel_process` fixture with `expectedRevision`; focused real-socket rerun passed **4/4**. Remaining managed_control/RPC/settlement counts need a clean follow-up after P4's current TypeScript check.
- P4 returned **PARTIAL** and released its slot. Evidence: LSP/DAP/REPL suite **205/0 (686 expectations, 10 files)**, Prettier clean, HorizonCode TypeScript package typecheck (`packages/opencode`) exit 0. REPL output/status refs now check authenticated owner, workspace, sandbox generation and capability ceiling. Remaining: P1 generic Guard/ExecutionHost dispatcher, supervised process/recovery journeys, LS-006/008 resource admission/eviction, OS negatives and real Linux projects; all effect routes stay unavailable. Resume same P4 owner after P1's contract.
- Current child roster: P1, P2, P6/S1. P6 has the whole provider/settings/Doctor/question/switching phase. P5/P7/P3/P8/P9 and final release gates remain in scope/queue.
- P2 corrected `hz_kernel_process` passes **4/4**; its prior library tests **198/198** and `direct_attempt_rpc` **8/8** passed. Managed control/RPC/settlement exact totals still need rerun. P2 now owns HostKernel atomic batch binding for direct-Attempt effect sets; P1 owns child prompt/ToolBatch scope propagation. Task is still denied pending this full contract.

## 2026-10-18 — current fast phase wave

- Child slots: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P2 currently owns the shared Cargo slot for the plural direct-Attempt effect binding suites. P4 and P5 have returned PARTIAL and resume after their P1 contracts; next queued full-phase owner is P7, then P3/P8/P9 and release gates remain in scope.
- P6 Provider Doctor offline group/handler are wired by the parent into the central API and handler registry. Focused offline inspection: `bun test --timeout 30000 test/provider/doctor.test.ts` → **4 passed / 0 failed, 14 expectations**. The route only accepts the offline bounded schema and invokes `inspectOffline`; catalog/full probes are absent.
- P6 source audit found FEAT-001..014 still blocked on config origin/requested/effective/source/lock/pending semantics. P6 now owns `packages/core/src/v1/config/feature-exposure.ts`, `packages/opencode/src/config/config.ts`, and associated tests. Full TUI/Doctor/provider acceptance and integrated typecheck remain open.
- Central API registration changed only `packages/opencode/src/server/routes/instance/httpapi/api.ts` and `server.ts`; route-level generated SDK/client and live route acceptance remain outstanding. Preserve the entire shared dirty tree; no staging, commit, push, cleanup, paid call, or release claim.

- P1 direct child propagation update: Task carries private DirectAttemptAuthority into child prompt; ToolBatch batches returned effect IDs into one P2 `bind_direct_attempt_effects` call before exposing outcomes; bind failure cancels and denies. The direct scope is threaded through Core supervisor/PTY prepare and write/patch/terminal RPC bodies. Focused new Core regressions: **2/2 passed**. Remaining: integrated Core/HorizonCode CLI-host package tests and typecheck; P2 current HostKernel/socket tests; enabled-origin no-bypass and cancel/restart/UNKNOWN recovery. Task remains unavailable. The separate generic non-PTY dispatcher remains a P1-owned P4 prerequisite and is not yet stable.
- A4 audit after central Doctor API registration and exact ignore exceptions: **`compared=6627 changed=246 hidden_changed=0 hidden_new_source=0 stale_unignore=0`**. Point-in-time only; rerun after all remaining phase source changes.
- P6 Doctor provenance correction: initial offline DTO echoed request-supplied `ownerRef`/`ownerEpoch`, contrary to §37.18's `inspectOffline(ref, auth)` contract. P6 agreed to remove these fields from the offline read-only projection and add a spoofed-identity negative test. The route remains authenticated and effect-free; do not treat its response as independent verification evidence.
- **P2 plural direct-effect contract evidence:** current-source Rust results: `managed_control_rpc` **11/11**, `direct_attempt_rpc` **10/10**, `managed_settlement_provenance` **4/4**, plus same wave `--lib` **198/198** and `managed_control` **9/9**. Initial red results were stale test fixtures, corrected to assert pre-dispatch no-write/no-retroactive-binding behavior. Live-socket wire matches P1: request `{attemptID, locationID, sessionID, effectIDs, directAttempt}`; response includes bound IDs, revision and refreshed scope; expectedRevision advances by one, actual workspace edits reject stale authority. This releases the Rust build slot but not P2 phase ownership. P2 still lacks an actual authenticated independent verifier and finalization stays disabled.
- P1 direct-child focused suite: `bun test test/session/tool-batch.test.ts test/tool/task.test.ts test/session/prompt.test.ts` → **115 pass, 1 expected V2-projector skip, 0 fail, 516 expectations**. P1 is adding Core supervisor RPC wire assertions and multi-batch/stale/forged scope negatives. P2 plural ManagedControl TS client suite: **23/23, 137 expectations**. Serialize one integrated package typecheck after the P1/P2/P6 edits and SDK generation stabilize.
- Parent P9 synthetic CLI launcher/installer tests pass **2/2**: both manifest names point to one launcher and forward arguments/exit status; local installer creates `horizoncode` and `hzcode` aliases in a temporary HOME. These use a fake candidate binary and do not count as real built-product startup or clean-install evidence.
- P1 integration review caught a real direct-scope wire mismatch: Core's typed `ownerEpoch`/`expectedRevision` were decimal strings, while Rust `DirectAttemptScopeV1::from_value` strictly accepts unsigned u64 fields. P1 owns checked numeric serialization at the Core HostKernel boundary and prepare/consume live regressions. The child-effect path is not WIRED/available until corrected and retested against real HostKernel.
- **Ruling — workspace rebase after direct child effects:** reject the suggested simple “settle receipts, hash current tree, issue new scope” refresh. It could bless concurrent human edits. Keep the admitted workspace revision immutable and deny later child effects after a revision change unless a future receipt contract proves the exact full tree delta came only from that Attempt, including terminal-process side effects. P2 minimum V1 proof is one guarded action; finalization stays blocked on independent verification. Cost if wrong: a legitimate child multi-action flow may require re-review/re-admission until precise receipt-derived workspace rebasing exists.
- P2 independent-verifier evidence depends on P7: `kernel/src/artifact_store.rs` is currently a private unwired seam, and P7 owns exact-ref bounded ArtifactStore integration. P2 should implement typed verifier assignment/evidence contracts and hard-false finalization now, then integrate with P7's immutable artifact fetch/verification API when available; do not create a duplicate store.

### Current continuation delta (2026-10-18)

- A1's sole product-facing gate is `bun run horizoncode:typecheck`; `scripts/architecture/run_push_gate.sh` invokes it once. The root command now runs the internal HorizonCode CLI-host package-derived CLI host, the separate TUI package, and Core. `packages/opencode` remains an internal source location under the staged migration decision in A-V2-27/§10.12, not the name of the product gate. Script syntax passed (`bash -n scripts/architecture/run_push_gate.sh`).
- Latest component diagnostics are not a combined HorizonCode gate run: the host leg has **eight diagnostics** in internal source under `packages/opencode`; P7 reports zero diagnostics in its changed files and removed the legacy debug-snapshot CLI path. P2 owns one test error at `test/server/httpapi-control-plane.test.ts:101` (`schemaVersion` literal widened); P6 owns seven SecretBroker/Secret Service/auth/schema diagnostics. The separately checked Core leg exits 2 with nine SDK/plugin-boundary diagnostics, none in P1's changed shell/terminal files. Rerun `bun run horizoncode:typecheck` after P2/P6 repairs; A1 remains IN PROGRESS until both legs pass together.
- P2 identified a Goal proposal atomicity gap: separate `create_goal` and `propose_spec` calls can leave a Goal without a SpecVersion. P2 owns the managed transaction and tests; P1 owns the narrow HostKernel `create_goal_proposal` dispatch. They are coordinating one schema, with caller identity derived from the authenticated IPC envelope, never from request JSON.
- P1's new IPC principal draft is out-of-body `authenticatedPrincipal: { kind: "server_auth", subject }`, optional so legacy/host-OS requests retain SO_PEERCRED-derived identity. Subject is bounded to 256 UTF-8 bytes and rejects control characters. HostKernel reviewer actions reject HTTP body identity and require the delegated principal to match a durable reviewer assignment; `effects.v2` remains fail-closed pending real-socket forgery, stale-principal, self-review and valid-review tests. The parent has authorized this direction from §§14.3/37 and requested exact schema/producer evidence before integration acceptance.
- P7's source-backed checkpoint-retention proposal restricts eviction to exact checkpoint refs with sole same-session ownership, journals oldest-first eviction intent before idempotent deletion, preserves shared blobs, and replays pending deletions after restart. P7 awaits the Rust slot after P1; meanwhile it continues independent P7 UI/replay work.
- Current active whole-phase owners are P1, P2 and P7 (all three child slots). P1 owns the next Rust validation slot; P7's latest typecheck has exited, and no Cargo/TypeScript process was present at the last check. Disk: C: `/mnt/c` has 26 GB free (95% used); WSL `/` has 815 GB free; existing `kernel/target` 12 GB, `horizoncode-sandbox/target` 140 MB, `indexd/target` 207 MB and root `node_modules` 2.5 GB. One registered worktree; no cleanup or pruning needed.
- Documentation checks after the current status update: Markdown audit **280 tracked / 0 active blockers / 62 reference-only warnings**; convergence **1,226 checks / 0 failures**; `bash -n scripts/architecture/run_push_gate.sh` and `git diff --check` passed. Overlay audit and the full push gate remain pending final integration. No commit or push was made.

## 2026-10-19 — resumed whole-phase integration

- Git MCP confirms local `main@6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind `origin/main`, with staged, unstaged and untracked files preserved; no conflicts. There are 160 unstaged and 70 untracked paths plus the existing staged set. One registered worktree only. No stage/commit/push or cleanup occurred.
- Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P7 remains queued until a child slot opens; P3/P4/P5/P8/P9 and final release acceptance also remain in the V1 ledger.
- Disk/process check: host C: (`/mnt/c`) has 25 GB free of 454 GB (95% used); WSL `/` has 815 GB free; `kernel/target` is 12 GB and root `node_modules` is 2.5 GB. No unknown worktree was removed or pruned.
- A1 interim evidence: `bun run horizoncode:typecheck` passed both the host and Core legs with no diagnostics after P6’s SecretBroker/Secret Service/auth/schema fixes. P1/P2 TypeScript integration has resumed, so A1 remains IN PROGRESS until the combined command passes again on the final integrated revision. The internal `packages/opencode` source directory remains under the approved staged migration; the product gate is HorizonCode-named.
- P1 focused test `cargo test --locked --offline --manifest-path kernel/Cargo.toml --lib builtin_verifier_challenge_revalidates_the_host_executable_profile_at_approval -- --test-threads=1` passed 1/1 after correcting three typed error conversions. Broker-process Guard/approval/lease/receipt wiring, origin closure and adversarial matrix remain open.
- P2’s new RED/GREEN state regression proved digest-only criterion evidence could previously finalize a Run; after the fix, finalization requires current typed `VerificationEvidenceV1` matching final revision/verifier with recomputed evidence digest. Focused test passes 1/1. This does not prove a real verifier process or full managed vertical.
- P6 focused tests passed: OpenCode auth/SecretBroker 7/7 (30 assertions), schema SecretBroker 5/5 (21), TUI provider options 5/5 (9). Whole-phase P6 acceptance remains open, including Provider Doctor, settings/provider journeys, S1 acceptance, entrypoint-level URL-login zero-effect proof and permitted free-model acceptance.
- Parent A4 audit returned exit 1: `compared=6627 changed=266 missing=1 symlink_delta=0 hidden_changed=2 hidden_new_source=3 stale_unignore=0`. Exact exceptions were added for the five existing hidden P7 files. The absent hydrated debug-snapshot source must be restored as a disabled/fail-closed path by P7; rerun A4 after P7 integration.
- Verifier ruling from §14.3: RunController-owned final verification uses `managed_run` and must not fabricate an Attempt; Task-attributable action stays bound to its live authenticated Attempt. Proposed verifier flow uses exact-set atomic approval resolution and yields all per-criterion one-use leases or none; output/token/artifact remain host-private until typed evidence and immutable ArtifactStore refs are validated against the current workspace revision. Finalization/fan-out remain disabled.
- C: has not decreased during these test/audit waves. No phase is VERIFIED/RELEASED; push gate, final cross-phase security/recovery checks, clean install and exact-scope publication remain outstanding.
- Parent mounted P6's offline Provider Doctor in the shared TUI app as `provider.doctor.offline` (`/provider-doctor`). RED/GREEN app integration: `bun test test/app-provider-doctor.test.tsx` → 1/1, 3 assertions; it confirms the command is discoverable, calls only the offline route, and makes no auth/provider request. A1 remains the combined `bun run horizoncode:typecheck` product gate and still needs final integrated verification.
- A1 command scope correction: `package.json` now makes `bun run horizoncode:typecheck` cover the internal CLI host, `packages/tui`, and `packages/core`; the prior command omitted TUI despite the documented gate scope. `run_push_gate.sh` already invokes this product command. The expanded command has not yet been run; await the serialized TypeScript slot and record its complete result.
- Verifier identity contract: authenticated begin must match the durable assigned reviewer; HostKernel selects an immutable verifier profile principal distinct from that reviewer and every Attempt executor, stores the profile principal in `Run.verifier_id`, and binds approval challenges to the reviewer. Caller-supplied verifier IDs are forbidden. P1 is implementing this boundary; launch/finalization remain unavailable until exact-group, process, receipt/UNKNOWN and recovery acceptance passes.
- P2/P1 approval bridge issue: transport loss or abort in a later ≤16-entry UI window currently drops genuine decisions from earlier windows. P1 owns a typed partial decision set plus terminal reason; P2 owns preserving it through the client and explicit HostKernel abort. Synthetic reviewer decisions remain forbidden; behavior is not verified.
- P2's new `packages/tui/src/component/dialog-goal-verification.tsx` was hidden by the root overlay rule; parent added an exact exception and Git MCP confirms it is visible as untracked source. `app.tsx` mount is deferred until HostKernel begin/resolve/execute and P2's current-workspace route are integrated and fail-closed.
- Quota-reset phase resume: P1/P2/P6 are active full-phase owners again. P1's `cargo test --lib verifier_ -- --nocapture` failed to compile before running tests with E0308 at `kernel/src/host_kernel.rs:2260` (`managed_phases` requires a borrowed snapshot); P1 is correcting it and will notify before rerunning Cargo. Separate earlier EffectHost/Guard focused checks passed 11/11 and 1/1. P2 awaits P1's exact managed verifier route/approval contract before exposing verification; P6 continues independent provider/settings work. Latest resource check: no build process active, C: 25 GB free, `kernel/target` 12 GB, root `node_modules` 2.5 GB.
- After P1's failed Cargo compile exited, P2 used the shared test slot: `cd packages/opencode && bun test test/session/managed-control.test.ts` → 30 passed / 0 failed (182 expectations). This is Core orchestration/fake coverage, not HostKernel execution evidence. P2's current adversarial approval-window cases remain to be run. P1 fixed the borrowed-snapshot mismatch and has started one notified focused Cargo retry; parent measured C: 25 GB free and confirmed no competing build before it started.
- A1 command scope correction: `package.json` now makes `bun run horizoncode:typecheck` cover the internal CLI host, `packages/tui`, and `packages/core`; the prior command omitted TUI despite the documented gate scope. `run_push_gate.sh` already invokes this product command. The expanded command has not yet been run; await the serialized TypeScript slot and record its complete result.
- P2/P1 approval bridge issue: transport loss or abort in a later ≤16-entry UI window currently drops genuine decisions from earlier windows. P1 owns returning a typed partial decision set plus terminal reason; P2 owns preserving it through the client and explicit HostKernel abort. Synthetic reviewer decisions remain forbidden; exact behavior is not yet verified.
- Verifier identity contract: authenticated begin must match the durable assigned reviewer; HostKernel selects an immutable verifier profile principal distinct from that reviewer and every Attempt executor, stores the profile principal in `Run.verifier_id`, and binds approval challenges to the reviewer. Caller-supplied verifier IDs are forbidden. P1 is implementing this boundary; launch/finalization remain unavailable until the exact-set, process, receipt/UNKNOWN and recovery acceptance passes.
- **Latest execution delta:** P1's current verifier filter passed 10/10 (239 filtered) after fixing an expiry-path borrow error. P1 owns next Rust wave and HostKernel exact-group/expiry tests; its process-launch and typed-evidence producers remain gated. P2 now adapts the managed caller to P1's typed partial-approval result and is assigned a separate read-only review of `/mnt/c/users/sonali/downloads/extra_some_Stuff.md` while waiting; after the caller edit, run the focused Bun suite, then return a source-backed accept/adapt/reject report tied to relevant arch_V1 sections. P6's latest focused suites: provider/Doctor/login/free 30+1 expected skip/114 assertions; settings 2/16; SecretBroker/Auth 9/35; TUI provider/model/Doctor 23/104; S1 7/38; FeatureExposure 12/56. No live provider request was made.
- Parent added an exact-pin Codex CLI/OpenCode subagent allocation and lifecycle comparison to `implementationtov1release.md`. Keep the Rust DAG/Task/Attempt manager canonical; current DAG/WorkerPool code is not production ingress or process launch. P1 owns pre-dispatch child authorization/Guard, P2 proves one managed Attempt and independent verifier, P8 remains queued as the whole-phase owner for durable worker/DAG/resource integration after a child slot frees and P1/P2 gates pass. Direct-session Task UI/ActivityStream evidence does not prove managed-worker progress/recovery.
- Child capacity is three and currently full (P1/P2/P6). No extra child/worktree was created. Host C: remains 25 GB free of 454 GB (95% used); `kernel/target` 12 GB. Keep one heavyweight Cargo/TS check at a time; P1's filter has exited, and P1/P2 must coordinate before the next Rust build. A1's expanded `bun run horizoncode:typecheck` covers CLI host + TUI + Core and still needs a post-integration run. Existing staged, unstaged and untracked changes remain mixed; no stage, commit, push or cleanup occurred.

### Resume manifest — 2026-10-19 latest

- **Owners and slots:** P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifact/automation/rewind are the three active whole-phase owners; P6 remains incomplete and queued. Parent owns integration, A1/A2/A4, release tracker, app-level wiring, exact ownership and final acceptance. Do not spawn above actual capacity. Next whole phase slot goes to queued P6 (or P8 if P1/P2 prerequisite evidence passes and critical-path review prefers it); P3/P4/P5/P8/P9 remain unfinished.
- **P1:** latest focused tests reported green: verifier filter 10/10; exact managed-run approval/preflight 1/1; aggregate output-cap test 1/1; HostKernel unit selector 24/24 after explicit `capability_unavailable` guards for approval resolution and identity-free aggregate execute. Execute accepts only `{goalID,runID,verificationRunID,challengeSetDigest}`; output token gained a capture timestamp accessor. `HostCapturedVerifierOutputV1` is private/non-cloneable but has no production mint path; `TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`. Continue real Guarded `managed_run` process/approval/lease/receipt/output mint, origin matrix, and cancellation/crash/UNKNOWN recovery; keep effects fail-closed.
- **P2:** latest focused route+approval suite: `bun test test/session/managed-control.test.ts test/server/httpapi-control-plane.test.ts test/server/httpapi-instance.test.ts` → 49 passed (243 assertions, 5.98s), including live-instance schemaVersion=2 rejection and approval/deny/partial/interruption. Repaired prompt/apply_patch/task/write fixtures: 72 passed, 1 pre-existing skip (332 assertions). Current-workspace verifier POST accepts only `{schemaVersion:1,goalID,runID}`; identity and workspace/location derive from trusted middleware/`InstanceState`; it returns no lease/evidence claims and maps unavailable P1 execution to `capability_unavailable`. Continue authenticated reviewer/Goal proposal path, real managed Attempt/revision/receipt/evidence, and pause/cancel/restart/UNKNOWN/stale/conflict recovery; do not expose finalization/fan-out.
- **P7:** implementing full P7; exact ArtifactStore handoff is by-value `HostCapturedVerifierOutputV1`, consuming into immutable refs only after P1 producer acceptance. P7 restored hydrated `packages/opencode/src/cli/cmd/debug/snapshot.ts` as an unregistered fail-closed marker, verified by parent source read and A4. Continue replay/resnapshot/large-history, artifacts, analytics, durable automation/recovery and checkpoint/rewind acceptance without effects before P1.
- **A4:** after exact parent-owned `.gitignore` exceptions and P7's restored unregistered fail-closed debug-snapshot marker, fresh audit exits 0: `compared=6627 changed=270 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. Rerun at final integration; do not add broad unignore rules.
- **A1/A2:** fresh integrated `bun run horizoncode:typecheck` exited 0 across CLI host + TUI + Core on a source-frozen snapshot; this is current-snapshot evidence, not final-head verification because P2/P7 resumed TS edits afterward. Rerun after their next stable boundary and in the final `bash scripts/architecture/run_push_gate.sh`. The prior reported push-gate pass is historical; A2 still requires the full final integrated run.
- **Guard approval UX gap:** `SyncContext.guardApproval.pending/reply` and `guard.approval.requested` are wired, but no rendered consumer exists. P2 owns a new standalone `DialogGuardApproval` and focused tests in exclusive component/test files; P2 also adds `app-guard-approval.test.tsx` as the red-first mount test; parent owns only `packages/tui/src/app.tsx`; P7 avoids these paths. Architecture §14.2 requires exact action/resources, argument summary, guarantees, policy/source, affected Run/Session, expiry and no-response behavior. The current event has host-minted target/policy/expiry/session fields but lacks some consent metadata. P1 audits/extends host projection; UI must mark absent context unavailable and never invent values.
- **Ruling — Guard allow needs assessed guarantees:** disable `allow_once` until host projection includes typed requested guarantees plus a typed residual assessment. A host-derived empty residual list is valid only after actual assessment; missing/`not_assessed` is deny-only. This preserves informed approval; cost if wrong: legitimate approval interactions stay blocked until the assessment path lands.
- **P1 Guard projection detail:** P1 confirms Guard receives requested guarantee strings and EffectHost persists origin kind, but current generic challenge lacks typed policy ID/source, safe argument summary and residual assessment. P1 owns bounded host-derived projection fields; verifier launch remains gated because there is no private managed_run launch/mint path. No client-supplied context may become authority.
- **P2 Guard approval UI progress:** red-first tests were added. First focused run: 0 pass/2 fail/1 import error; missing component is expected RED, while the app test assertion was masked by the empty-provider prompt. P2 is correcting the app fixture to seed a provider, then implement/test the component. Parent owns only app.tsx. Exact ignore exceptions keep test files visible; current overlay audit exits 0.
- **P7 ArtifactStore validation:** first integration-filter run failed the success fixture because it supplied an unbound `ReadPermit`; adapter rejection cases passed. P7 is fixing the fixture to obtain a store-bound permit through `authorize_read`, and will rerun with `--lib` after P1's Guard projection source stabilizes. This is test-fixture failure, not accepted ArtifactStore evidence.
- **External proposal note:** P2 completed the full `/mnt/c/users/sonali/downloads/extra_some_Stuff.md` review (1,851 prose lines plus embedded diagram); parent cross-checked `arch_V1` and recorded adopt/adapt/reject outcomes in `implementationtov1release.md`. Keep one Rust coordinator and current Guard/lease/evidence authority; no second daemon, untrusted policy source, universal performance claim, or production AST-splicer path was adopted.
- **Resources/Git:** C: `/mnt/c` 25 GB free of 454 GB (95%); `kernel/target` 12 GB, `horizoncode-sandbox/target` 140 MB, `node_modules` 2.5 GB. One primary worktree, no stale worktree entries. Preserve staged/unstaged/untracked work. User authorized exact-scope add/commit/push, but current ownership is mixed and gates are open; no stage/commit/push yet.
- **Release state:** PARTIAL. No phase verified, no final typecheck/push gate, cross-phase security/recovery matrix, clean install, legal/signing decision, native Windows acceptance or release publication. Continue phase owners; checkpoint exact source/test evidence and update this manifest before any stop.

### 2026-10-19 active continuation checkpoint

- Active whole-phase owners (all three child slots): P1 Guard/ExecutionHost, P2 managed vertical, P7 streaming/artifacts/automation/rewind. Parent owns `packages/tui/src/app.tsx`, integration, A1/A2/A4 and release gates. P6 and P3/P4/P5/P8/P9 remain queued. One primary dirty worktree; do not reset/prune/clean or stage broad paths. Latest host C: check: 25 GB free; `kernel/target` 12 GB.
- P1 Guard approval projection tests pass in Core 13/13 (73 expectations) and Rust 2/2. The request is bounded and host-derived; `allow_once` is disabled until a launch-specific sandbox preflight is retained and consumed against exact command/args/cwd/env/profile/executable/workspace/revision/owner epoch/backend facts. P1 owns `terminal_process.rs`, `effect_host.rs`, `host_kernel.rs`. Restart/stale, mismatch/replay, cancellation and zero-spawn-on-denial cases remain acceptance work.
- P2 approval component + Sync projection + parent app mount are source-present and the focused component/app suite reports 4/4 green. Deny is default, unassessed context cannot allow, and a complete assessed fixture uses a one-use decision. P2 continues all other managed vertical criteria: trusted distinct reviewer, live Attempt/effect binding, current final revision, independent immutable evidence, real socket, and pause/cancel/restart/UNKNOWN/stale/conflict. Finalization remains unavailable.
- P7's focused Cargo results: ArtifactStore 3/3, automation 16/16, checkpoint 7/7. These tests do not enable production effectful automation/restore. P7 is implementing monotonic source sequence/generation through schema→emitter→TUI, with gap-triggered resnapshot, and ArtifactStore must refuse unknown-redaction verifier output. P1/P7 are coordinating host-safe manifest evidence; raw output is never published.
- Overlay audit after exact ignore exceptions: `compared=6627 changed=272 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`. It must be rerun on final integrated source. The latest integrated `horizoncode:typecheck`, push gate, final architecture/release checks and real Linux/WSL end-to-end journeys remain open. No stage/commit/push occurred; user authorization remains limited to exact verified task-owned changes after ownership and gates are resolved. Native Windows is still unaccepted.
- Structural tracker checks on this checkpoint: Markdown audit passed (280 tracked files, 54,906 lines, 0 active blockers; 62 historical/reference warnings); convergence validator passed (26 schemas, 205 catalog IDs, 225 registry IDs, 1,226 checks, 0 failures); `git diff --check` passed. Rerun on final integrated revision.


### 2026-10-19 continued execution

The live roster supersedes older owner summaries: P1 Guard/ExecutionHost, P2 managed vertical, and P8 resources/workers are active. P7 is partial and queued to resume; P6, P3, P4, P5, P9 and final release acceptance are still open. P8's authorized Rust wave exited 0 (`--lib` 263/263; all six selected integration targets exited 0, exact combined count unavailable due truncated output) and RC0 Python tests passed 48/48. P8 found stale/mixed-generation `TouchedFileV1.source_revision` can pass TaskGraph delivery validation; P8 is next for one focused Cargo RED/GREEN correction. P1 then passed `verifier_challenge_retention_tests` 2/2 with active challenge-set reuse bound to immutable profile ID/principal/profile/executable/sandbox digests; its production verifier launch/output token mint remains unwired and restart/UNKNOWN recovery is open. P2's forged body principal was rejected before dispatch: `bun test test/server/httpapi-instance.test.ts -t 'rejects host_os Goal verification before managed snapshot dispatch'` → 1/1 (2 assertions), typed 403.

Parent integration checks: overlay audit `compared=6627 changed=272 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` passed. Git MCP: `main`, 150 staged / 165 unstaged / 83 untracked, no conflicts. C: 25 GB free; `kernel/target` 12 GB; root `node_modules` 2.5 GB. Preserve mixed ownership; no broad stage, commit, push, cleanup, or prune. Re-run `bun run horizoncode:typecheck`, overlay/architecture audits and full `scripts/architecture/run_push_gate.sh` only after final integrated source stabilizes. V1 remains PARTIAL; no native Windows result is claimed.


### Phase handoff — 2026-10-19

P8 returned PARTIAL and released its slot after finishing independent work. Its TaskGraph file-touch source-revision check passed RED/GREEN 0/1→1/1; the full P8 Cargo command exited 0 (`--lib` 263/263; selected target counts truncated) and RC0 Python 48/48. Remaining P8 work depends on P1/P2: authenticated worker ingress/launcher, real guarded effect receipts, authoritative generation-bound conflict observations, real 1/5/10/20 session measurements; keep fan-out closed. P2 has the next one Rust writer/build window for the narrowly fenced same-verifier/same-final-revision retry after owner restart when Run is `Verifying` but no evidence exists. P1 is source-only in `host_kernel.rs` while P2 edits `managed_control.rs`; do not compile during concurrent Rust writes. P6 is now the third active whole-phase owner for provider/auth, Settings/FEAT, Provider Doctor, model switching, diagnostics and S1 question.ask. P7/P3/P4/P5/P9 and release remain open/queued.

P1's latest origin audit found direct child-process Git mutation/network entry points in `packages/core/src/git.ts` (`clone`, `fetch`/`fetchBranch`, `checkout`, `reset`, and branch/commit/push candidates). P1 owns exact caller/test review and must either mediate with the canonical authenticated Guard/ExecutionHost or fail closed before any process/network effect with zero-effect regression coverage. Read-only Git remains available where source proves it is read-only.

P2's restart retry regression is now green: RED 0/1 then `verification_can_rebind_after_restart_only_without_current_revision_evidence` 1/1. The narrow rule permits a fresh verifier challenge only for a `Verifying` Run with the same actual current revision and assigned verifier, no typed or criterion evidence, all Tasks settled, no UNKNOWN and no active Attempt. Durable reopen preserves Run/revision/verifier/evidence history and creates no lease or Attempt; evidence-bearing same-revision retries remain rejected. P2 released the Cargo slot; P1 owns the next single retention selector after process/disk check.

P1's initial Bun invocation for a new origin regression failed in test setup (`await` inside synchronous `Effect.gen`); no test executed. P1 owns the fixture correction (`Effect.promise`) and waits for P6's active Bun suite before rerunning. This is not a product failure/pass.

P6's current provider suite has four Cloudflare OpenAI passthrough failures: host `OPENAI_BASE_URL` redirects the gateway wrapper's native OpenAI URL, so `openai.responses` is rejected before transport. Native Anthropic/Workers routes pass; P6 is fixing the endpoint binding and adding a Provider-service regression. No external network was used. P1's verifier-retention selector is in progress for zero capacity and UNKNOWN preservation; do not start another Cargo wave.

### Quota-reset continuation — 2026-10-19

Previous P1/P6/note-review workers hit usage limits; their shared-tree edits/findings remain preserved, and no phase is accepted complete due to that interruption. Fresh whole-phase owners now occupy the three child slots: P1 Guard/ExecutionHost, P3 RepoIntel, and P6 providers/settings/Doctor/S1. P1 is diagnosing the 20s real Guarded VCS apply timeout without weakening the assertion; arbitrary Git subprocess origin closure remains P1. P3 continues independent index/adapter work; its proposed bounded chunked HostKernel interface is not approved or wired, and HostKernel remains parent/P1-owned. P6 continues FEAT-001..014 including Core V2 next-turn config bridge, provider/model support, sealed skill IDs, Doctor and S1; effectful Doctor remains unavailable pending P1 Guard. P2 remains PARTIAL and must resume when P1/P7 evidence permits the single managed vertical. P7/P4/P5/P8/P9 and final release gates remain open.

Parent removed disconnected Goal-review stubs/tests while retaining live Core-to-TUI inbox/proposal and component behavior. The focused TUI selectors passed 7/7 (46 assertions) after cleanup; baseline was 9/9 (55 assertions), including the two tests for the disconnected stub. C: had 25 GB free; kernel target 12 GB; node_modules 2.5 GB. Preserve mixed Git state. Re-run overlay/Markdown/convergence checks after owners settle, then `bun run horizoncode:typecheck` and `scripts/architecture/run_push_gate.sh` on the integrated revision. No staging/commit/push; V1 remains PARTIAL.

P1's verifier-retention selector completed RED/GREEN: RED had 2 failures (empty-set capacity zero and UNKNOWN treated as evictable); GREEN `verifier_challenge_retention_tests` passed 3/3. Only Aborted/Settled sets may be pruned; profile ID/principal/profile/executable/sandbox digests and live reviewer/epoch/spec/revision/state are bound. P1 released Cargo. P2 owns the next single Rust slot for a typed `verification_evidence` negative case on the clean same-revision restart retry.

P1 confirmed `@opencode-ai/core/git` (GitV2) has only test callers; production routes use a separate VCS service. It is adding a fail-closed zero-process/no-filesystem-change regression for GitV2 mutations, with the harness syntax now corrected. Run after P6's active Bun suite; no test result yet. Do not conflate that closure with direct Guarded VCS apply, which still needs P1 real-socket proof.

P2 added the typed-evidence same-revision retry denial test; after correcting a test-only identifier compile error, exact lib selector passed 1/1 (266 filtered). It confirms evidence-bearing retry conflicts without mutating Run state.

P6 bound the Cloudflare provider to an explicit native OpenAI baseURL. Focused gateway tests now pass 14/14 (42 assertions), no external network. The broader provider/auth/config/S1 suite is 891 passed, 1 existing skip, 6 failures before accounting for the four newly fixed Cloudflare cases; two DigitalOcean legacy provider-router expectations remain to be resolved without bypassing P1 effect-origin controls. P6 has a narrow Settings pending-state test in progress; P1's Git-origin Bun test waits for the JS slot.

### Quota-reset continuation — 2026-10-19

Prior P1/P6/note-review child turns hit usage limits; their source edits and findings remain preserved, and none is treated as a completed phase. Fresh whole-phase owners occupy the three child slots: P1 Guard/ExecutionHost, P3 RepoIntel, P6 providers/settings/Doctor/S1. P1 is debugging the 20s real Guarded VCS apply timeout without weakening the test. The follow-up source audit found no exposed arbitrary Git subprocess API: production Git has only typed methods/private fixed-command helpers, and test setup uses a test-local subprocess helper. P1 is preserving those paths and fixing the fixture's approval-fiber error propagation to expose the actual apply result.

P3 has approval for an inert indexd library upload-staging primitive only: bounded chunk/offset/digest/TTL/abort/commit checks, no filesystem or runtime wiring, no caller authority, and no production route. The proposed HostKernel upload/query contract remains pending and parent/P1-owned. P6 owns provider/settings/Doctor/S1, including the disjoint Core V2 config and runner boundary and immutable skill identity. Effectful Doctor and all dependent paths remain disabled pending Guard evidence. Parent removed disconnected Goal-review stubs and their misleading mount tests; live TUI selectors passed 7/7, 46 assertions.

Latest audits: overlay `compared=6627 changed=275 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; Markdown 280 files / 55,041 lines, zero active blockers (62 reference-only warnings); convergence 26 schemas / 205 catalog IDs / 225 registry IDs / 1,226 checks / zero failures; `git diff --check` clean. C: 25 GB free; `kernel/target` 12 GB; root `node_modules` 2.5 GB. Mixed staged/unstaged/untracked tree remains preserved. Final HorizonCode typecheck, full push gate, remaining phase acceptance and safe ownership-bound publication are still open; V1 is PARTIAL.

### Quota-reset continuation update — 2026-10-19

P1 fixed the missing single-call Core consent projection for `session_batch/core.tool_batch`: focused RED/GREEN passed 1/1 and `cd packages/opencode && bun test test/project/vcs.test.ts` passed 14/14 (26 assertions), including real Guarded apply/stale-preimage behavior. This does not complete P1. P3 has a RED regression for duplicate `resolveProfile` invocation and is queued behind P6's shared Bun slot; its HostKernel bridge remains unapproved/unwired and symbol/reference/write-fence work remains. P6 SkillV2 files are now explicitly visible via narrow parent-owned `.gitignore` exceptions. Overlay audit is green (`compared=6627 changed=278 hidden_changed=0 hidden_new_source=0 stale_unignore=0`); Markdown 280/55,063 with 0 active blockers, convergence 26/205/225/1,226 with 0 failures, workspace audit 36/0, bootstrap 6,629 existing/0 missing. C: remains 25 GB free; WSL `/` 815 GB free; kernel target 12 GB, sandbox target 140 MB, node_modules 2.5 GB. One worktree; mixed Git state preserved; no stage/commit/push/cleanup. V1 remains PARTIAL pending whole-phase completion, final HorizonCode typecheck, full push gate and release acceptance.

### Phase-owner findings correction — 2026-10-19

Correction to the prior update: `resolveProfile` is already called once; the regression test is present but not yet rerun, so no RED is established. P3's borrowed upload-token boundary test passed 1/1 after validating 16..=64 bytes before copy. The proposed HostKernel bridge remains unapproved: TypeScript must not construct Rust `GenerationPack` bytes; parent will reconcile an embedded Rust scoped builder with §30.7/§30.10/§30.22 before any wire work. P3 also found catastrophic-backtracking risk in synchronous native regex under the 64 KiB line cap; deadlines/cancel must remain enforced through bounded isolation or a linear-time engine. ArtifactSearch has no product caller/registration yet; P7 owns that integration when scheduled.

P1's corrected kernel test `cd kernel && cargo test --lib terminal_run_command_rejects_nul_before_effect_admission -- --nocapture` passed 1/1 (267 filtered); the prior unqualified selector matched zero tests and only built targets. P1 found config-load detached `npmSvc.install(@opencode-ai/plugin)` despite disabled external plugin execution. P6 confirmed it does not own `packages/opencode/src/config/config.ts`; P1 now has exclusive ownership to remove/disable this origin with zero-process evidence. P1 also found post-admission Task cancellation gaps on metadata/promptOps/background-start failures and continues its full source audit. Keep all other effectful unsupported origins unavailable.

### Quota-reset continuation — current active owner evidence (2026-10-19)

**Roster:** P1 Guard/ExecutionHost, P3 RepoIntel, and P6 providers/settings/Doctor/S1 are the three active whole-phase owners. The Bun slot is currently with P6 after P1's focused provider regression. P2/P7/P4/P5/P8/P9 remain queued or partial; start a whole-phase owner as a slot frees. Parent owns cross-phase interfaces, status, A1/A2/A4 and final integration.

**New evidence:** P1's external provider test passed RED/GREEN; current GREEN command `cd packages/opencode && bun test test/provider/provider.test.ts -t 'unbundled npm provider is unavailable without install or import'` → 1/1, 3 assertions, 103 filtered. It proves config-supplied non-bundled npm provider code does not install or import. P3 ArtifactSearch suite → 18/18, 106 assertions; regex isolation → 2/2, 11 assertions; RepoIntel profile → 1/1, 2 assertions. P3 added a safe 60,000ms duration ceiling and a `Number.MAX_SAFE_INTEGER` regression; rerun it after P6 releases Bun. No claim of P3 phase completion.

**RepoIntel blocker:** no production HostKernel service/operation/caller is present. HostKernel's authenticated principal and Location→canonical-root/workspace mapping exist, but there is no per-principal read ACL/policy owner. The target §12.7/§30.22 binding must be implemented from trusted host state; TS-supplied principal/root/workspace/revision/policy cannot authorize a query. P3 continues adapter-side negatives and inert staging only; P1/parent must define and verify the HostKernel read-scope seam before production query enablement.

**A1:** authoritative product command is `bun run horizoncode:typecheck` (CLI host + TUI + Core); the operative plan wording was corrected on 2026-10-19. The command has not been rerun on final integrated source. A2 full push gate, final A4 overlay audit, integration/security/recovery acceptance, Linux/WSL journeys and clean-install/release gates remain open. `CURRENT_RUN.md` has the detailed current resource/Git snapshot. V1 remains PARTIAL; do not declare VERIFIED/RELEASED or publish mixed ownership.

### Active-phase follow-up — 2026-10-19

P6 SkillV2 loader/guidance tests passed 8/8 (49 assertions). P6 found and fixed FEAT-014 runtime behavior: the Core V2 compaction settings helper returned base settings without overlaying the new per-turn `auto/prune` snapshot. Its new N/N+1 runner regression pins settings through same-turn tool continuation, applies them next turn, and verifies model/provider selection remains unchanged. P6 is running the Config snapshot and focused runner suite; do not claim the fix verified until it exits green. Parent exposed `packages/core/test/config/turn-snapshot.test.ts` and its directory in `.gitignore`; `packages/schema/test/skill.test.ts` is also visible.

P1 now has cancellation cleanup for Task setup failures after durable Attempt admission, including bridge setup, `ctx.metadata`, missing `promptOps`, and background extend/start/promotion metadata. RED/GREEN is still pending its serialized Bun slot after P6. P1's separate external-provider zero-install/zero-import test passed 1/1 (3 assertions). P3 has added forged RepoIntel scope and stale-search-write boundary tests, pending the same Bun slot. P3 must leave the backend unavailable until P1/parent's authenticated Session/Attempt + Location/workspace + Core `PermissionV2` policy-snapshot grant is implemented and verified in HostKernel. Full A1/A2/A4 and phase gates remain open.

P6's first FEAT-014/SkillV2 verification wave passed Core skill/guidance 8/8 (49 assertions), schema Skill identity 3/3 (9 assertions), and Config + SessionRunner 98/98 (338 assertions). Its focused `tsgo --noEmit` is red on P6 source/test typing (Config snapshot FS error, Skill identity/type export, compaction `prune` narrowing), plus P1 HostKernel/Git fixtures and an OpenCode storage diagnostic under ownership review. P6 is fixing its own paths source-only. The shared Bun slot goes to P1 for Task post-admission cancel and GitV2 zero-effect regressions, then P3 boundary/timer tests. C: now has 22 GB free; `kernel/target` 12 GB, `node_modules` 2.5 GB; no test process was visible. Keep one heavyweight build at a time.

P1's Task post-admission setup cancellation suite is green: `cd packages/opencode && bun test test/tool/task.test.ts` → 14/14 (110 assertions). The owner is adding one extra `onPromote` metadata-failure regression and must rerun that file before accepting the delta. The existing GitV2 zero-process test lives at `packages/core/test/git.test.ts`, selector `refuses unguarded Git mutation and network origins before dispatch`; P1 will verify it after P3 releases Bun.

P3's RepoIntel forged-authority/stale-reference boundary selector plus ArtifactSearch timer-clamp selector passed 2/2 (8 assertions); full ArtifactSearch suite passed 19/19 (108 assertions), covering bounded worker regex deadline/cancel. These are focused evidence only; RepoIntel has no production HostKernel backend/caller. P3 retains phase ownership and continues source-only independent work while P1 uses the next Bun slot.

P1's latest Task cancel test caught duplicate cancel RPCs in the `onPromote` metadata-failure path; a cancellation-request fence fixed it. RED/GREEN selector passed 1/1 (7 assertions), then full Task test file passed 15/15 (117 assertions). Core GitV2 zero-process regression passed 1/1 (3 assertions), including no mutation process calls and no clone/create/worktree target. No whole P1 acceptance claim. P6's remaining checklist also includes real offline Doctor TUI, auth/cost/capability provider matrix and free-model 200/coding journey (with 429 truth), FEAT-001..014 source/lock/apply/cancel parity (Core V2 prune still absent), S1 mixed-effect/spoof checks, model switching TUI and V1/Core skill identity parity. P6 is using the newly released Bun slot for Core typecheck repair; P3's focused suites are green and waits for its next slot.

### 2026-10-19 — latest quota-reset handoff

**Roster / allocation:** P1 Guard/ExecutionHost, P2 managed vertical and P6 provider/settings/Doctor/S1 now occupy the three available child slots. P3 finished its independently executable phase work and released its slot **PARTIAL**; next queued phase is P7, subject to P1 Guard prerequisites for effectful artifact/rewind integration. P4/P5/P8/P9 and release remain open. Parent owns cross-phase integration and final gates.

**New exact evidence:** P1 rebuilt `hz-kernel`; the actual shell-interpolation selector passed 5/5 (30 assertions), including approved execution and redaction/no-secret assertions. HostKernel safe-summary tests 2/2; host terminal process tests 2/2; Core typecheck passed; Core launch+Git 21/21; Git tests 7/7. P1 is still working on all remaining Guard/origin/confinement/ToolBatch/adversarial requirements, including a fail-closed redactor case for credential-like quoted literals. P3 focused cache/watcher tests passed 13/13, watcher lib 8/8, and full offline indexd suite passed (lib 73, generation store 7, persistence 8, RepoIntel 5, transport 9, upload 9, watch 6; no failures). P3 evidence is in `indexd/src/README.md`; Gate 4 remains PARTIAL pending authenticated HostKernel/read-scope, supervised walker/watch, LSP, profile/resource admission and real large-project acceptance.

**P6/P2 boundaries:** P6 is implementing Linux Secret Service persistence, protected in-process TTY one-use input, broker lease consumption and native request transport in its non-overlapping P6-owned files. Credentialed routes stay unavailable until durable storage, request binding/revocation, zeroization and no-leak evidence pass. P2 owns the entire one-Attempt managed flow; its effectful path remains gated by P1 and it may proceed now on non-overlapping API/TUI/schema adapters. No worker fan-out/finalization.

**Workspace/release:** C: `/mnt/c` free 24 GB; kernel target 12 GB, indexd target 269 MB, node_modules 2.5 GB. One worktree, main at `6c8c5ab9a`, 12 ahead/0 behind; mixed staged/unstaged/untracked ownership and no conflicts. `git diff --check` clean. No stage/commit/push/cleanup. V1 is PARTIAL. Required next gates: finish P1/P2/P6 and remaining requested phases, then final `bun run horizoncode:typecheck`, overlay audit, `scripts/architecture/run_push_gate.sh`, integrated Linux/WSL security/recovery journeys and release/clean-install evidence. Native Windows remains unavailable absent native acceptance.

**P1 redactor and P2 re-entry update — 2026-10-19:** P1's new quoted-credential shell-summary negative completed RED/GREEN; `cargo test --manifest-path kernel/Cargo.toml --lib terminal_command_consent_summary -- --nocapture` passed 3/3. Quoted credential/Bearer-like literals fail closed, unquoted sensitive values redact, env values are omitted. P1 released Cargo and continues source-only. P2 reloaded whole-phase sources: verifier execution/evidence remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE: false`); typed Core→TUI Goal/review flow exists and has principal/revision assertions. P2 is auditing/implementing remaining one-Attempt work and now owns the sole focused Cargo window. No final managed acceptance is claimed.

**A4/P2 follow-up — 2026-10-19:** parent exposed exactly `packages/opencode/src/storage/`, `packages/opencode/src/storage/storage.ts`, P6 secure-input source/test and P3 generation-store test. Fresh overlay audit passes `compared=6627 changed=284 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` clean. P2 current Rust selectors passed typed-evidence retry 1/1, managed-control RPC 12/12, settlement provenance 5/5. Distinct reviewer/pause/cancel/stale/UNKNOWN/current-workspace/receipt negatives are covered in those selectors, but real verifier execution/evidence remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`). P2 is drafting an exact HostKernel seam and must not edit P1 shared files before ownership is resolved. P6 added echo-disabled bounded TTY bytes and a process-local one-use vault plus a RED lease-consumption regression; the credential route remains unavailable pending durable Secret Service + request-bound lease/revocation/zeroization tests.

**P2 verifier boundary ownership (2026-10-19):** P1 released exclusive `kernel/src/host_kernel.rs` to P2 and will not edit it during the lease. P2 owns that file and its verifier orchestration/tests; P1 retains `effect_host.rs`, `guard.rs`, `terminal_process.rs`, and sandbox backend, and must provide a typed Guarded launch/result seam. P2 must not use direct process dispatch, caller-provided evidence, or test-only artifact tokens in production. P1 can resume the RepoIntel read-grant seam after P2 returns HostKernel ownership to the parent. P2 current TS evidence: managed-control 34/34 (196 expectations), httpapi-instance 10/10 (30); Rust evidence: retry 1/1, managed RPC 12/12, settlement provenance 5/5. These validate state/client/security boundaries only; verifier execution/evidence remains unavailable. P2's required immutable invocation binding, actual final-revision checks, ArtifactStore provenance/revalidation and UNKNOWN/no-replay contract are recorded in CURRENT_RUN.md.

**P6 secure input / P1-P2 dispatcher update — 2026-10-19:** P6 fixed a byte-buffer alias bug in one-use secure input: cleanup zeroized a `Buffer.slice()` view, so ownership now transfers through a standalone `Uint8Array`. Exact secure-input + SecretBroker + DigitalOcean suite passed 16/16 (57 assertions); auth selectors 2/2, DigitalOcean 5/5. Credentialed routes remain disabled pending durable store and Guarded transport. P1 found the verifier lower-layer mismatch: stdio admission accepts `builtin.verifier`, but settlement reconciliation only accepts `TERMINAL_RUN_ID`. P1 owns the typed `effect_host.rs` reconciliation seam; P2 owns `managed_verifier.rs`/tests and exclusive `host_kernel.rs`. No verifier dispatch until immutable invocation bindings and receipt/UNKNOWN recovery pass. P1 now owns the serialized Bun slot for focused current-tree selectors.

**Exact P1/P2/P6 interface allocation — 2026-10-19:** P2 uses a private nested `host_kernel::managed_verifier` module (P1 confirms no `lib.rs` edits) and owns verifier invocation/orchestration plus its exclusive `host_kernel.rs` lease. P1 owns the confined `EffectHost::execute_managed_verifier` wrapper and recovery in `effect_host.rs`, using `StdioExecutionSupervisor` and the opaque P2 invocation; generic terminal reconciliation stays terminal-only. No dispatch until both layers and crash/cancel/UNKNOWN tests pass. P6 may exclusively edit `packages/llm/src/route/auth.ts`, `route/transport/http.ts` and route tests for one-request SecretBroker auth. DEC-V1-06 constraints remain: no general RPC/config/env/child/plugin/log/artifact transfer; transient auth only within one dispatch callback, no return/store/log, wipe source bytes, and retain UNAVAILABLE if runtime behavior cannot be verified. P1's current Bun suite is the single active JS test wave.

**Provider test correction — 2026-10-19:** P1's shared Task/VCS/provider suite reported 132 pass / 1 fail. P6 traced the failure to an obsolete test at `provider.test.ts:2186` that writes plaintext `auth.json` and expects paid OpenCode models. DEC-V1-06 requires legacy plaintext reads to fail closed, so P6 will update the assertion to verify denial/no-echo; do not re-enable plaintext Auth. P1's terminal-run-live Bun suite remains active and owns the slot until it exits.

**P1/P7 snapshot origin ruling — 2026-10-19:** P1 found `packages/opencode/src/snapshot/index.ts` still starts direct `git` processes (`init/config/add/write-tree`, `gc`, snapshot tree/diff) through `AppProcess.run`, reached by SessionRunner/Revert. Parent ruling: P1 temporarily owns that exact file and direct tests to fail closed before any process, expose typed UNAVAILABLE and prove zero spawn; no repo mutation. P7 gets the file lease back for guarded checkpoint/rewind integration. Cost if wrong: the feature stays unavailable until P7 implements Guarded mediation. This closes the direct process bypass without claiming checkpoint/rewind complete.

**P6 transport checkpoint — 2026-10-19:** request-scoped auth transport tests pass `packages/llm test/auth.test.ts` 8/8 (23 expectations): Authorization is absent from prepared headers, materialized only at HTTP dispatch, and dispatch runs once. Updated legacy plaintext auth fixture passes 1/1 (5 assertions), proving plaintext `auth.json` cannot unlock paid models; Auth was not weakened. Bun released. Durable Secret Service, lease/revocation, zeroization/no-leak and real selected-provider response/coding journey remain open.

**P2/P6 latest evidence and A4 — 2026-10-19:** P2's immutable `host_kernel::managed_verifier` contract compiled and focused unit tests passed 2/2; it binds canonical approval/invocation digests and validates observed-vs-UNKNOWN results, but dispatch remains disabled. P1 is implementing the EffectHost-only guarded wrapper. P6 `packages/llm` auth + route tests passed 9/9 (28 expectations), proving no prepared Authorization and one-request dispatch scoping; durable Secret Service/lease integration and real provider auth are still pending. Parent added exact `.gitignore` exceptions for the three package files and P2 module. Overlay passes 6,627 compared / 287 changed / 0 hidden changed/new / 0 stale rules; diff-check clean. C: 24 GB free; kernel target 12 GB.

### 2026-10-19 resumed continuation checkpoint

Live owners: P1 Guard/ExecutionHost, P2 managed vertical, P6 providers/settings/Doctor/S1. P1 has completed its temporary fail-closed Snapshot service closure with a live zero-process regression (1/1); it is using the Bun slot for corrected terminal-runner and origin tests. P2 owns the single Cargo slot for verifier/restart acceptance. P6 is continuing source-only SecretRef→request-scoped auth and Linux Secret Service work; credentialed routes remain unavailable while native runtime retains raw key strings.

P2 supplied the exact private P7 dependency: `HostVerifierArtifactStore` owned by HostKernel, wrapping the generic ArtifactStore with a private authorizer; bounded capture of supervised verifier output must be followed by `verify_ref` for every returned reference before evidence can be accepted. P7 is queued for the next child slot as the whole-phase owner of streaming, artifacts, analytics, automation and checkpoint/rewind. No effectful verifier/finalization, automation/rewind, or worker fan-out is enabled before parent-verified P1/P2 prerequisites.

Intermediate parent checks: overlay visibility `compared=6627 changed=287 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` clean. Tree is mixed staged/unstaged/untracked on main, one worktree; preserve existing ownership. V1 remains PARTIAL; final typecheck, remaining phases, integrated acceptance, push gate and release/install proof remain open.

P2 current Rust evidence update: `cargo test --manifest-path kernel/Cargo.toml --lib host_kernel:: -- --nocapture` passed **37/37** (managed invocation digests, verifier unavailable/fail-closed and retention included); Cargo slot released. This does not enable verifier execution. P1 still owns the required EffectHost wrapper and P7 the production-owned artifact store seam.

P1 current Bun evidence: Core `terminal-run-live.test.ts` passed **15/15, 133 expectations**; OpenCode Snapshot zero-AppProcess regression passed **1/1, 2 expectations**. The old missing-shell race fixture is corrected: missing executable is asserted as preflight no-spawn, while observed `exit 7` covers settlement/replay. Bun is free. P1 now takes Cargo for the managed-verifier EffectHost wrapper/reconciliation and focused Rust tests.

A1 diagnostic checkpoint: integrated `bun run horizoncode:typecheck` exited 2 in `packages/opencode` `tsgo --noEmit`, so TUI/Core checks did not run. P1, P2 and P6 have received their path-owned diagnostics; P6 also owns the typed fatal auth gate in `session/llm.ts` to prevent credential-authorized native unsupported from silently falling back to SDK auth. HorizonCode CLI-host package `github.handler.ts`/`cli/cmd/pr.ts` have unresolved `Interface.run`/unknown Effect diagnostics; `test/project/worktree.test.ts` ownership is P1-vs-P8 triage; `test/tool/repo-tools.test.ts` is P3. Snapshot's new error type also surfaced in the summary caller and heterogeneous test-exit typing. Rerun the complete `horizoncode:typecheck` only after source fixes settle; this failing run is not final evidence.

**Ruling — P1 GitHub CLI effect-origin lease (2026-10-19):** P1 has exclusive ownership of `packages/opencode/src/cli/cmd/github.handler.ts`, `packages/opencode/src/cli/cmd/pr.ts`, and their focused zero-effect tests. The source audit found GitHub API/token, Git/config/remotes, forced PR checkout, nested import and spawned CLI effects. They must fail closed before effects until Guard mediation and no-bypass evidence exist. Cost if wrong: those CLI workflows stay unavailable longer. Parent retains `.gitignore` visibility edits.

A4 follow-up: a concurrent source audit caught three hidden changed P1/P6 paths (Snapshot summary handling and native credential request/test). Parent added only those exact `.gitignore` exceptions; overlay rerun passes `compared=6627 changed=290 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` clean. Rerun after subsequent edits.

P2 repaired the managed verifier consent projection to require and forward complete authenticated HostKernel metadata; focused `test/session/managed-control.test.ts` passed **34/34**. P2 is validating the two distinct durable digests (Guard argument digest vs host canonical bundle content digest) in the current Cargo slot. P6 has the next Bun slot for its native auth/no-fallback work; P1 will take Cargo after P2 releases to build the EffectHost wrapper against that tested API.

P2's revised two-digest HostKernel selector now passes **39/39** (`host_kernel::`, 236 filtered). Guard `argument_digest` and host canonical bundle `content_digest` are distinct fields and must be checked against their matching durable columns. Cargo is released to P1; no verifier launch is enabled until P1 wires/tests the wrapper and recovery.

P2 refined P7's ArtifactStore requirement: `capture_host_verifier_output` alone is not evidence. The private HostKernel owner adapter must bind the authorizer to Goal/Run/Spec/verificationRun/reviewer/Location/owner epoch; reject incomplete capture; verify every returned ref via `verify_ref`; re-read bounded content using the verified permit/scope; and compare refs/metadata/manifest to host output before P2 builds `VerificationEvidenceV1`. The store opens beneath the registered Location state dir and accepts no RPC-supplied refs/bytes/authorizer.

P6 removed raw API keys from native RuntimeStatus/request inputs and added a typed fatal auth gate before native/SDK fallback; unsupported credentialed native paths no longer fall through. Focused native/auth/SecretBroker/secure-input tests pass **29/29, 100 assertions**. The broader provider selector's one stale OAuth fixture was repaired but the full 4-suite wave must be rerun. Preserve both positive request-scoped broker-lease coverage and fail-closed negatives; production SecretRef/store wiring remains incomplete.

**Ruling — durable P2 verifier restart fence (2026-10-19):** same-revision retry requires durable proof the old dispatch never began or target reconciliation proves absence. Persist the approved challenge/invocation and EffectId/one-use lease/execution ID+generation before dispatch, preferably through existing authoritative managed OwnerLog; a bounded private HostKernel journal linked to OwnerLog + EffectIntent is acceptable only if that log cannot atomically store the private data. Restart may reconcile only the exact execution and never redispatch uncertainty. Missing/corrupt/possibly dispatched state is UNKNOWN and blocks retry/finalization; retry after proven absence uses a new EffectId and approval. Keep private lease/executable details out of public event projections. Based on arch_V1 §§14.3 and 11.19; cost if wrong, same-revision verification is delayed until reconciliation.

P2 is coding the restart fence after the 39/39 HostKernel selector. P6's four provider/native/auth suites passed 134/134 (357 assertions) and its focused HorizonCode TypeScript package typecheck (`packages/opencode`) is running. P1 is source-only pending the shared TS slot.

P6 has the four-suite native/provider/auth wave green (**134/134, 357 assertions**). Its focused HorizonCode TypeScript package typecheck (`packages/opencode`) is down to two P6 fixture errors (`provider.test.ts:76` tuple inference; `llm-native.test.ts:679` stale `llmClient` reference); those are being repaired. Earlier P6 SecretBroker/DO/Config diagnostics are resolved. P2's restart journal will be `kernel/src/verifier_journal.rs`, nested privately from `host_kernel.rs`, with no `lib.rs` edit; parent will expose it through exact A4 visibility after creation.

P6 focused HorizonCode TypeScript package typecheck (`packages/opencode`) is now free of P6 diagnostics. Remaining known type paths are P1 Task/Snapshot, P3 RepoTools and P8 worktree fixtures. P1's managed-verifier EffectHost wrapper/recovery and preflight digest mismatch test are source-written; P2 owns two HostKernel compile errors caused by its new verifier journal/member fields and takes Cargo next. P1 takes Bun next for the top-level GitHub/PR zero-effect test and P1 type/test repairs. No verifier dispatch is enabled.

P1's GitHub install/run and PR wrappers now fail typed unavailable with `instance:false` before dynamic imports or effects. Parent reviewed the source; the zero-process, secret-redaction and no-side-effect CLI test awaits the Bun slot. P2 created its private verifier journal; parent added exact visibility exceptions for the new P1 test and P2 source. Latest overlay is clean: 6,627 compared / 293 changed / zero hidden changed/new / zero stale rules; whitespace check clean.

P1's top-level GitHub/PR CLI deny regression passes **1/1, 12 assertions**. It proves all three wrappers return typed unavailable before dynamic imports or fake `git`/`gh`/`opencode` calls, with no secret echo or expected side effects. Those CLI routes are disabled, not Guard-enabled. P1 has Bun next for Task/type fixes.

P2 fixed the HostKernel journal initializer and verifier parser fields; the focused `host_kernel::` selector passed **39/39, 237 filtered**, then Cargo was released to P1. P2 is hardening journal monotonicity, uncertain fsync and non-Unix compile behavior before integrating persistence; rerun after that delta.

Latest HorizonCode TypeScript package typecheck (`packages/opencode`) still exits 2 (39s) with no P6 diagnostics. P1 owns `tool/task.ts`, Task fixture types and Snapshot test union typing; P3 owns RepoTools fixture; P8 owns worktree fixture/API typing. P1's EffectHost Guard-vs-content-digest mismatch test passes **1/1**, preflight/spawn not reached. P2 asks to hold Cargo until journal transition wiring is ready; P1 is using Bun for its type/test repairs.

Parent interim docs/convergence gates pass after tracker updates: Markdown audit **280 files / 0 active blockers / 62 reference-only warnings**; convergence **26 schemas / 205 catalog IDs / 225 registry IDs / 1,226 checks / 0 failures**; `git diff --check` clean. Rerun on final integrated revision.

### Live continuation checkpoint — 2026-10-19

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed control, P6 providers/settings/Doctor/S1 (three child slots). P7 is queued for the next free slot. P2's latest HostKernel/journal selector passed 43/43; it discovered restart currently blocks safely but does not rehydrate/reconcile exact verifier execution as UNKNOWN. P2 continues source-only on that recovery, with finalization disabled. P1 owns the current serialized Cargo slot for the post-dispatch UNKNOWN regression and wrapper recovery. P1 has zero own diagnostics on the latest package typecheck; current other owners are P3 RepoTools and P8 worktree fixtures. P6's initial Linux Secret Service store selector passed 3/3 (16 assertions), but static review returned directory/index symlink/ownership/mode hardening, persistence-failure reconciliation, and real Secret Service CRUD as open requirements. Credentialed routes remain unavailable until those pass.

P1's new subprocess audit assigned Azure CLI OAuth, CLI DB/pager/uninstall, package installation/upgrade, formatter, managed `plutil`, and project Git paths to P1 for Guard mediation or fail-closed zero-effect tests; LSP remains P4-owned. Overlay audit is currently clean at 6,627 compared / 293 changed / 0 hidden changes/new source / 0 stale exceptions. C: free space is 24 GB; `kernel/target` 12 GB. Mixed tree: 150 staged / 178 unstaged / 118 untracked, no conflicts. No staging, commit, push, cleanup, or pruning at this checkpoint. V1 remains PARTIAL; full A1, A2, remaining phases, integrated acceptance and release/install proof remain open.

**Latest integrated typecheck and focused tests (2026-10-19):** Parent `bun run horizoncode:typecheck` exited 2 at HorizonCode CLI-host package `tsgo --noEmit`; downstream TUI/Core gates did not execute. Diagnostics route to P6 Secret Service store decode/callback/test-brand types, P1 Azure origin test fixtures, P8 worktree test API/effect env, and P3 RepoTools fixture. Parent's current P6 store+Secret Service protocol selector passed **16/16, 53 assertions**; live OS keyring and production credential transport remain unverified and Auth stays unavailable. P1's expanded `guarded-legacy-origins.test.ts` timed out at five seconds after adding DB/uninstall invocations; the old 1/1 result does not cover the expanded source, and P1 owns a split/timeout repair. P7 child reports **111/0, 1,174 assertions** on activity/render tests including mounted replay/resnapshot/large history, not yet parent-rerun. P2's journal-based startup recovery source fences restart to exact UNKNOWN without redispatch; its `verifier_` unit selector passed 32/32, but authenticated real-socket UNKNOWN proof is pending. P1 focused Rust reports passed 2/2 managed-verifier selectors and 1/1 challenge UNKNOWN transition. These are phase evidence, not final integrated acceptance. Active implementation owners are P1/P2/P7; P6 is queued on a free slot. Cargo order: P2 socket UNKNOWN selector → P1 Guard/origin/sandbox selector → P7 checkpoint/artifact/automation selectors. Keep effectful verifier, finalization, provider credentials and worker fan-out disabled pending parent-verified prerequisites. Tree remains mixed (150 staged/178 unstaged/118 untracked); no staging, commit, push or cleanup.

### Quota-reset continuation — 2026-10-19 latest observed state

Active phase owners are P1 Guard/ExecutionHost, P6 provider/settings/Doctor/S1, and P7 streaming/artifacts/analytics/automation/rewind. P2's child completed its new authenticated socket restart-UNKNOWN test (1/1, seven filtered), but P2 remains PARTIAL and is queued for a whole-phase resumption. P1 released Cargo after four focused selectors passed: legacy verifier resolution/profile revalidation (1/1), terminal argument mismatch before preflight (1/1), verifier restart UNKNOWN without executable/relaunch (1/1), and profile readiness (1/1). P7 has the next Cargo slot for a source-audited checkpoint capture issue: rejected duplicate/over-limit/invalid-time captures must be refused before immutable blob publication to avoid orphan storage; effectful restore stays disabled. P6 completed its post-fix Bun regressions below.

P7 reran the current TUI suite after the earlier 5-second lifecycle timeouts overlapped P6's TypeScript check: 116 passed / 0 failed / 1,188 assertions / 11 files / 15.83 seconds. Coverage includes mounted activity replay, sequence/generation recovery and 10K histories; bounded redacted rendering and interaction; FULL/SAMPLE/FAILED artifact rendering; SVG worker fallback; analytics provenance. This does not wire P2's private HostKernel ArtifactStore verifier adapter or P1-guarded automation/restore. P7 reports checkpoint journal/capture, ArtifactStore and automation module code exists with prior tests, but needs integrated Rust rerun and cross-owner wiring.

P6 focused post-fix regressions passed from packages/opencode: SecretBroker, Secret Service store/protocol, secure input, offline Doctor/API and provider tests, 137/0 with 369 assertions across seven files. Core feature exposure passed 13/0 with 58 assertions. Live OS keyring and production request-transport integration remain unproven; credentialed auth stays fail-closed/unavailable. Full P6 acceptance remains open.

Parent's latest audits: overlay visibility clean (6,627 compared, 299 changed, zero hidden/stale), convergence 1,226 checks / zero failures, Markdown 280 tracked / zero active blockers / 62 reference-only warnings, and git diff --check clean. One exact test/git/ directory exception was required for the already-listed P1 test. Current Git state is main, 12 ahead/0 behind, 150 staged / 178 unstaged / 125 untracked, zero conflicts, one worktree. C: has 24 GB free (95% used); kernel target 12 GB, indexd target 269 MB, node_modules 2.5 GB. No staging, commit, push, cleanup or prune. Product typecheck and push gate remain open; V1 PARTIAL, native Windows unavailable.

P6 post-fix suite update: OpenCode SecretBroker/Secret Service/secure-input/Doctor/API/provider selector passed 137/0 (369 assertions, seven files); Core feature-exposure selector passed 13/0 (58 assertions); TUI Doctor/question/settings selectors passed 34/0 (129 assertions, seven files); OpenCode S1 selector passed 4/0 (23 assertions). Bun is released to P1 for Guard-owned origin tests and diagnostics. No live OS keyring or production SecretRef transport is proven; credentialed routes remain unavailable.

P1 current owned Bun wave returned 71 pass / 6 fail (180 assertions of 77 selected tests). The owner traced the failures to a missing Effect import in the read-only DB path, install fixtures still expecting now-disabled brew/upgrade probes, and a Git patch test requiring --no-textconv under configured textconv. The CLI zero-effect selector first encountered the DB import failure. P1 is repairing these and owes focused reruns; do not count this wave green. P7 owns the next Cargo run for the pre-publication checkpoint capture defect and its regression tests.

P7's checkpoint pre-publication admission fix passed RED/GREEN on the current revision: `checkpoint::` 8/8, `artifact_store::` 53/53, `automation::` 16/16. The new tests prove duplicate ID, count cap, aggregate byte cap and invalid time refuse before artifact publication. No HostKernel automation or checkpoint restore became runnable; P1 Guard/P8 recovery and P2 verifier adapter dependencies remain.

P6 identified that `SecretPutRequestV1.expectedVersion` could not name the record to rotate. Per arch_V1 §17.6 the parent amended §12.17 and DEC-V1-06: create omits both target and expected version; rotation requires both, preserves SecretRef and atomically increments version; incomplete/stale updates fail without replacement. P6 owns implementation/tests. P1 confirmed no edits to `packages/opencode/src/session/llm.ts`; P6 has an exclusive credential-dispatch/test lease on that file while preserving all managed-session logic. Credential routes remain unavailable until full store→broker→one-request transport integration passes.

P1 fixed and reran its prior 71/6 red origin wave: expanded CLI/install/Git selectors 21/0 (70 assertions); full 8-file HorizonCode CLI-host package origin bundle 74/0 (203 assertions). Core GitV2 zero-effect test is 8/8 (31 assertions) after blocking configured textconv and adding --no-textconv to change capture. The Azure fixture source literal inference issue is fixed. Current package typecheck still has P8 worktree and P3 RepoTools fixture diagnostics; P1 is rerunning for exact output, and the full product command `bun run horizoncode:typecheck` remains required after all owners settle.

Resource/process correction: process inspection found a Cargo build at /home/sarvesh/business_Dev/litecowork (PID 274904), outside this task and user-owned. Preserve it; do not terminate. It temporarily blocks additional heavyweight Cargo/TypeScript work under the shared single-build limit. Continue source-only and rerun after it exits; C: free space remains 24 GB and HorizonCode target sizes have not grown in the latest check.

P1 continuation (historical note; superseded by 2026-10-19 source audit below): Core Git 8/8 (31 assertions), expanded OpenCode origin bundle 74/0 (203 assertions), and Task/ToolBatch 70/0 (353 assertions) were current focused passes. The sandbox is now source-wired to the HostKernel terminal and stdio launch paths, but actual containment and the full Guard acceptance matrix remain unverified; P1 continues whole-phase work.

P7 added a RED source regression for a capture-valid 2,048-path checkpoint manifest whose prospective OwnerLog record exceeds the 1 MiB limit; this must be rejected before artifact publication. The exact prospective event admission implementation and green Cargo rerun remain pending, with no Rust run until the unrelated LiteCowork build exits.

P1 additional origin discovery: `packages/opencode/src/cli/cmd/debug/agent.handler.ts` directly called `tool.execute()` from `debug agent --tool`, bypassing ToolBatch/Rust Guard; the existing test allowed webfetch. P1 owns disabling this path before tool resolution/context/parameter parsing and replacing the positive expectation with zero-network fail-closed acceptance. Rerun its test and overlay audit after the edit.

### Quota-reset continuation — 2026-10-19

- **Live child roster (three slots):** P1 Guard/ExecutionHost, P6 providers/settings/Doctor/S1, P7 streaming/artifacts/analytics/automation/rewind. P2 remains PARTIAL and queued to resume as a whole-phase owner when a slot opens. P3/P4/P5/P8/P9 and final release acceptance also remain unfinished. P1/P6/P7 have disjoint existing source ownership; parent owns status/integration and will not overlap those files.
- P1's latest expanded CLI/Azure/install/format/project/Git origin bundle passed **79/0, 217 assertions**; Core Git zero-effect suite passed **8/0, 31 assertions**. P1 remains whole-phase incomplete; source-wired sandbox does not yet have integrated containment/no-bypass acceptance.
- P6's broader auth/provider/Doctor/LLM rerun exposed an integration regression: mocked local streams with dummy keys are blocked by the new credential gate, and hosted-workflow denial loses its specific typed-unavailable error. P6 is repairing both without weakening production zero-dispatch policy. No P6 broad-run green claim; keep live credential routes unavailable until the broker transport is proven.
- P7 has the next HorizonCode Rust work, but an unrelated Cargo build in `/home/sarvesh/business_Dev/litecowork` is currently active and not task-owned. P7 is continuing source-only OwnerLog pre-publication admission work until that build exits; do not terminate it or overlap another heavy Cargo build.
- **Resources/integration:** C: `/mnt/c` has 24 GB free (95% used); `kernel/target` 12 GB, `indexd/target` 269 MB, root `node_modules` 2.5 GB. One worktree, mixed staged/unstaged/untracked tree, no conflicts; preserve all state. A1 (`bun run horizoncode:typecheck`) and A2 final push gate remain open on integrated source. No staging, commit, push, cleanup or prune. V1 remains **PARTIAL**.

P1's latest Core acceptance bundle now passes the two formerly failing synthetic runner fixtures: six Core runner/supervisor/terminal/shell files passed **143/0, 636 assertions** in 121.56 seconds. Coverage includes live HostKernel terminal allow/deny, one-use lease, known timeout/nonzero settlement, cancellation receipt, over-limit no-spawn and missing-executable preflight. P1 continues whole-phase Guard/origin/recovery work. P7 has test-first OwnerLog prospective-size regressions in place with rustfmt clean, but Cargo remains held while the unrelated LiteCowork build runs.

P1 source review found the debug-agent zero-effect change removes both direct `tool.execute()` and the obsolete `new Function` params fallback, refusing `--tool` before tool lookup/context parsing. A malicious-parameter marker regression is added but awaits its Bun run; do not count it as verified yet.

### Continuation update — 2026-10-19

The VEO note review now has a proposal at `docs/superpowers/specs/2026-10-19-veo-inspired-capability-roadmap.md`, linked in the operative plan. It gives candidate HLD/LLD contracts, state flows, event projections, post-V1 phases VEO-F1..F8 and acceptance families. This is design only; V1 P1–P9 are unchanged. P1's debug-agent suite passed 4/4 (12 assertions); the shell-interpolation run timed out before supervisor socket startup, without reaching approval or process dispatch. P1 is running Core typecheck, with `storage.ts` already using GitV2. P6's broad `session/llm.test.ts` passed 36/36 (106 assertions); its corrected RED proves the credential-rotation deletion ordering bug, and journaled recovery work is underway. P7's pure checkpoint eviction preview is present with rustfmt-clean tests but has no Cargo result. C: free is 23 GB; do not overlap the unrelated LiteCowork Windows Cargo qualification. Preserve the mixed Git tree; A1/A2 and all integrated release evidence remain open. V1 is PARTIAL.

Correction/update: P1's Core `bun run typecheck` exited 0 without diagnostics, including the GitV2 storage migration, and Bun is released to P6. C: latest free space is 22 GB. The active LiteCowork Windows Cargo test remains external and must not be interrupted or overlapped by another Cargo build.

P6's standalone Secret Service store tests passed 14/14 (53 assertions); the prior combined store+broker run's unnamed hook timeout is tracked separately. P6's root-turn `next_turn` regression reproduced pending config not being applied; P6 has the exclusive `promptWork` ingress lease and P1 is avoiding that function. P1 found CLI `session delete` and `agent create` origins and added fail-closed early gates, pending zero-effect tests. P1 also source-confirmed HTTP `Project.update` persists DB state/emits events without Guard. It owns a narrow disable at the sole production handler and an HTTP no-DB/no-event regression; P3 may mediate later. Overlay is clean (6,627 compared, 303 changed, no hidden or stale paths); C: 22 GB free. V1 remains PARTIAL.

P6's test-first root-turn settings fix passed its focused selector: 2/2, 5 assertions, with `applyPendingFeatures` limited to new root prompt ingress and child Attempts staying pinned. P1 has the released Bun lane for its CLI and HTTP project-origin no-effect tests; no Cargo overlaps the external LiteCowork Windows qualification.

P1's latest CLI legacy-origin bundle passed 1/1 (29 assertions); the Project.update HTTP suite passed 3/3 (15 assertions), including typed 503 before mutation with unchanged DB and no event. P1 owns newly discovered legacy MCP-config, auth/logout OAuth credential, and plugin/package-install paths for fail-closed mediate-or-disable and zero-side-effect proof. P6 takes the current Bun slot for its post-activation credential-store recovery regression. P7 is adding prospective OwnerLog admission while Cargo remains held by external LiteCowork builds.

P6's post-activation key-retirement recovery regression passed 1/1 (8 assertions). A combined Secret Service store+broker run has one unnamed teardown-hook timeout despite all named tests passing, so only focused store/recovery selectors count green. P1 has expanded the legacy CLI closure to account login/logout/switch/open/orgs and provider auth/config/plugin installation, disabled pending focused no-network/no-write evidence and P6's replacement auth path.

P6's credential-denial path now checks config/auth/model before provider construction. The RED-first plugin-hook counter passed after repair (1/1, 3 assertions): zero plugin callback and zero HTTP on a credential-denied route. Full LLM and standalone broker/prompt checks remain due; this does not establish production SecretBroker transport.

Current P6 reruns are green: full LLM 36/36 (107 assertions), standalone Secret Service store 15/15 (61), standalone SecretBroker 10/10 (42), root-turn settings 2/2 (5), and post-activation credential retirement recovery 1/1 (8). P7's two checkpoint prepublication selectors passed 1/1 each; full checkpoint module 14/14 plus rustfmt. P7 returned PARTIAL with effectful restore/eviction gated on P1/P2/P8. Its child slot is now assigned to P2 whole-phase managed vertical; P1/P2/P6 are current active owners. External LiteCowork Cargo restarted, so hold HorizonCode Rust builds; C: is at 20 GB free. P1 CLI MCP/auth/account/plugin gates remain under test/debug, with managed-control files reserved to P2.

### 2026-10-19 contract and phase correction

The delegation design is now explicit in §12.18: P2 owns the canonical private IPC `contracts-v2/delegation-binding-v1.schema.json`, shared golden fixture and Rust decoder tests. u64 owner epoch/managed revision values are canonical decimal strings in the MessagePack body; digest is domain-separated BLAKE3 over the fully validated canonical map. Managed admission fails before effect preparation if accepted Attempt/profile/context/workspace/capability/budget/resource state or live leases are absent/stale. P1 reviews and enforces the HostKernel/Guard path; P2 verifier/finalization remain disabled until P1 and P7 artifact acceptance. §4.13's named UI lifecycle labels are projections over existing owner records/cursors and do not add durable OwnerLog kinds or a second event bus.

P6 owns newly discovered usage provenance across session usage fields, producer and projector: missing cache counts or model prices must remain unknown rather than numeric zero. It has exclusive path-level scope on those usage producer/schema/projector files; P7 owns UI renderer and analytics consumption. P6 Provider Doctor tests passed 7/7 (22 assertions), ModelsDev refresh passed 2/2 (5 assertions); catalog network remains unavailable. P1 provider-list denial passed 1/1 (4 assertions); shell interpolation test is active. P2 focused TUI review/proposal/verification passed 3/3. Three child slots are active (P1/P2/P6); P3/P7/P8 remain queued. C: has 20 GB free; external LiteCowork Cargo is active; do not start a HorizonCode Cargo build.

### Current phase and design checkpoint — 2026-10-19

**Accepted phase design:** A-V2-33 records the critical review of the complete supplied note. P1/P2/P3/P6/P7/P8 have explicit required V1 refinements; P4/P5/P9 retain scope. Logical contracts, HLD flows, event projections, LLD and acceptance IDs are in arch_V1 §§3.21/4.13/10.17/12.18/29.20/30.23/31.19/32.38/37.22. These remain design requirements until source, machine schemas, cross-language fixtures and runtime acceptance pass. VEO-F1..F8 are post-V1 proposals only.

**Current evidence:** P1's corrected effectful CLI-origin selector passed 1/1 (31 assertions), covering 14 subprocess routes; the earlier run executed a fake `bun` shim. `providers list` and eager ModelsDev refresh were then identified as network/cache origins. P1 owns early-disabling the CLI route; P6 owns ModelsDev/AppRuntime refresh behavior. P1's workspace digest race regression is not run because external LiteCowork Cargo is active. P2's `goal.verify` path and test are present; `packages/tui` typecheck and the focused app suite passed 3/3 (review, proposal and verification). P2 managed verification remains fail-closed until P1 confinement and P7 ArtifactStore evidence pass. P6's ModelsDev source avoids implicit startup refresh; no-startup-request test passed, but explicit refresh failed because the test bootstrap sets the fetch-disable flag; P6's isolated mock override rerun is pending. P6 prompt/config checks passed 2/2 and 2/2.

**Resources and integration:** C: has 20 GB free; `kernel/target` is 12 GB. Do not run HorizonCode Cargo while LiteCowork qualification is active. Git remains `main`, 12 commits ahead of `origin/main`, with mixed staged/unstaged/untracked paths and no conflicts; no exact task-owned publication boundary is safe. Markdown audit after phase docs: 0 active blockers / 62 archival reference-only warnings; convergence: 26 schemas, 205 catalog IDs, 225 registry IDs, 1,226 checks / 0 failures. V1 remains PARTIAL; final typecheck/push gate, P1/P2/P3/P4/P5/P6/P7/P8/P9 end-to-end evidence and release gates remain open.

Correction: P1 proved `providers list` denial before AppRuntime effects RED→GREEN: the regression first failed because the command exited 0 after startup; moving it to a raw pre-runtime command made the focused case pass 1/1 (4 assertions), with zero loopback HTTP and zero cache writes while fetch was enabled. P1 does not claim global network closure; P6's ModelsDev startup/read lifecycle is separate. P2 source audit found managed Attempts do not yet persist immutable profile/capability/context digests; P2 sent the gap to P1 and did not edit shared Guard/protocol files. P6 diagnosed its explicit-refresh test issue as the test bootstrap's fetch-disable flag; its injected-mock fixture correction/rerun is pending. Cargo remains blocked by external LiteCowork.

Correction: P1's shell-interpolation selector completed 0/1 after Guard approval, successful process exit and marker creation; 13 assertions passed, then the final fake-LLM input assertion saw no inputs. P1 is diagnosing the slash-command turn fixture/flow. This run did not fail at Guard denial or confinement; Bun lane is released.

Latest correction: P2's focused binding protocol test command ran no tests because compilation stopped on two current P1 `host_kernel.rs` errors (PathBuf versus `&Path` near line 9016 and tuple versus borrowed tuple near line 9070). P2 released the Rust lane; P1 owns repair. Binding schema/decoder exists in the shared tree, but the golden digest and complete malformed-vector coverage remain open. P6 usage provenance selector was 2 pass/1 fail because of a legacy fixture encoding mismatch; P6 owns the fix and released Bun. Architecture checks after additions: Markdown active blockers 0 (62 archive-only warnings), convergence 27 schemas / 1,227 checks / 0 failures, relevant diff check clean.

Correction: P1 fixed both compile errors and ran `cargo test --manifest-path kernel/Cargo.toml --lib host_kernel::tests::workspace_revision_rejects -- --nocapture --test-threads=1` → 2 passed / 0 failed, covering symlink swap and atomic same-path replacement. Rust lane is released to P2 for one binding selector. `rustfmt --check` still reports pre-existing/shared P2 hunks; P1 did not reformat shared files wholesale.

P2's binding selector next reached crate build but stopped on a new P1-owned compile error: `host_kernel.rs` `settled_attempt()` initializer near line 13273 is missing `delegation_binding`. P2 released Cargo; P1 owns the fix. No binding golden test ran yet.

Correction: P1 added `delegation_binding: None` to the settled-attempt test helper; Rust lane is back with P2 for its binding selector. P1 holds Bun until Cargo completes; P6 continues source-only.

P2 replaced the golden fixture placeholder with canonical digest `blake3:1fd75f1bc0f3999bfc38131ce367cd71ff22e9d0e442de1264ebced0b2c1e81b`. Focused result: `cargo test --manifest-path kernel/Cargo.toml --lib protocol::tests::delegation_binding -- --nocapture` → 2 passed / 0 failed (golden + hostile decoder). Rust lane released to P1. This is protocol proof, not persisted Attempt/admission proof.

Latest P1 interpolation result after fixing the test's missing model selection: the empty-LLM assertion now passes, but command Fiber exits unsuccessfully after `allow_once` and the marker remains absent. Selector 0/1, 11 assertions, 11.26s; P1 is tracing the actual terminal outcome/error. Treat as an unresolved guarded product-path regression. P6 has Bun for usage selectors, which passed 3/3 (25 assertions); it is running the Core runner usage regression. P2 added binding digest/canonical-string validation to managed-control TS plus zero-RPC negative test; validation waits for the Bun lane.

Overlay audit initially found 8 hidden changes and 4 hidden first-party files. Added exact ignore exceptions plus required test/lib parent; rerun is clean: `OVERLAY_VISIBILITY compared=6627 changed=311 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`.

Correction: P1's remaining interpolation failure came from its fixture passing a model-ref object where slash-command `CommandInput.model` requires a string; the reported error was `model.split is not a function`. The fixture now uses `model: "test/test-model"`; one final rerun waits for P6's Bun lane. This is not a product Guard defect.

P2 reports persisted Attempt binding/replay in managed OwnerLog, admission-revision/spec/task/owner/workspace validation, and fail-closed effect-intent admission when binding is absent. A focused Rust test for no-effect-before-binding, stale revision, reopen and exact replay is added but not yet run; P2 has the Rust lane. TS scope digest/counter validation and zero-RPC malformed input test are added but pending.

P6 usage schema now binds Provider.ID/Model.ID; measured cost requires recognized `provider-billing-receipt-v1` and an evidence ref (no V1 producer emits it); estimates require SHA-256 pricing revision, exact price components, algorithm and token input snapshot. Unknown metrics cannot carry values. Schema regression rerun 3/3 (27 assertions); producer/projector regression remains in progress.

P6 focused producer/projector tests are green: OpenCode usage selectors 3/3 (14 assertions); Core projection selector 1/1 (3 assertions), including unknown cache/cost and absence of misleading legacy scalar values. Bun released to P1 interpolation, then P2 managed-control TS selector.


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

## 2026-10-19 continuation checkpoint

See `CURRENT_RUN.md` for the current source-backed evidence. P1/P2/P6 are the only active whole-phase owners. The platform rejected a fourth child with `agent thread limit reached`; launch P8 next for typed durable reservation proofs and full P8 acceptance when a slot frees, then P3 or other runnable whole phases according to the dependency graph. P1's HostKernel managed admission must remain deny-before-OwnerLog-mutation until typed live owner proofs are consumable. P2's atomic admission selector is 2/2 and exact effect-edge lineage API is in progress; this is not a managed vertical acceptance. P6 credential/auth selector is 47/0 (192 assertions), but real Secret Service is unavailable and provider/credential effects remain gated. Overlay visibility and convergence audits are clean on the current tree. C: free space is 21 GB; retain caches and preserve the mixed tree. V1 remains PARTIAL; no final gate, commit, push or cleanup has occurred.

Latest follow-up evidence: P1's `managed_admission_without_typed_owner_proofs_has_zero_owner_or_effect_mutation` RPC regression passes 1/1 and confirms deny-before-Goal/OwnerLog/effect/workspace mutation. P1 consumes P2's persisted exact effect-edge revision and requires `expectedManagedRevision + 1`. P2's edge-lineage reopen/pause selector passes 1/1, preserving revision R while fencing the reopened Attempt UNKNOWN (exact command requested). P6 offline Doctor malformed/mismatched-ref selector is 8/8 (28 assertions), still zero-dispatch; live route/TUI selector is next. All are partial phase evidence; V1 remains PARTIAL.

P6 Doctor follow-up is green: OpenCode API tests 12/0 (54 assertions) and TUI Doctor journey 4/0 (14 assertions); offline reads are Config/ModelsDev only with no Provider/Auth/plugin/secret/network dispatch. P6 is fixing SecureInputVault expiry capacity and shutdown zeroization next. All phase owners were directed to reuse/adapt exact pinned OpenCode/OMP/Codex source per `repo_take/NOTES.md` and §42; Guard and managed ownership stay Horizon canonical.

Contract source closure: existing `SpecVersion.scope` is path scope and cannot authorize effects. Normative docs now require explicit canonical `capabilityScope` on immutable SpecVersion and Task `requiredCapabilities` subset, empty-as-deny, and a ceiling intersection with profile/current Guard. Core Config owns profile revisions; Core ContextService owns bounded context compilation; Rust retains per-Attempt snapshots only. P2 is implementing real typed schema/wire/source. Post-edit Markdown audit has 0 active blockers, convergence has 0 failures, and overlay visibility has zero hidden changes/new source/stale unignore.

P1 has wired HostKernel projections for accepted Spec capability scope and persisted Task-required capabilities. First integrated RPC binary: 11/12; sole failure is a stale error-code assertion (`invalid_effect_request` vs early `capability_unavailable`), owned by P1. P2 owns the current Cargo lane for the new Rust accepted-scope and subset invariants; then P1 reruns the exact ingress/zero-mutation tests.

Additional P2 contract ruling: `AgentProfileV2` now requires an explicit bounded canonical `capabilityCeiling` list; digest-only permission summary is insufficient to derive effective capability IDs. Empty is no managed effects; no inference from tool/path/MCP patterns. P2 implements the single Core profile owner; P1 intersects with current Guard policy; registry JSON remains ID/alias design seed only.

2026-10-19 continuation: the live whole-phase roster is P1 Guard/ExecutionHost, P2 managed vertical and P8 resource/workers/RC0. P6 finished its current assignment as PARTIAL and its child slot was reused for P8. P8 RC0 Python tests passed 48/48; P8's single Cargo suite is currently running. P1 reports focused Linux confinement 5/5, settlement provenance 5/5 and workspace race 2/2; no complete enabled-origin matrix or live typed proof path yet. C: 21 GB free; preserve the 12 GB `kernel/target` cache. Other requested phases remain P3/P4/P5/P6/P7/P9 and final integration/release gates; none VERIFIED/RELEASED.

Managed profile transport is now fixed in §17.13: existing authenticated Core→HostKernel private IPC, OS peer/handshake/fence for process identity and out-of-body validated ServerAuth for delegated user identity; no extra service principal/registration endpoint/global Rust profile registry. P2's complete `AgentProfileDefinitionV2` input has no trusted digest fields; HostKernel validates it, computes domain-separated canonical MessagePack BLAKE3 digests, and persists only per-Attempt immutable refs atomically with admission. The existing machine schema is updated in place to match §29.2. The effective P1 capability digest is separate and includes the live Guard policy intersection. Effects remain unavailable until P1/P2/P8 live owner proofs, leases and adversarial acceptance pass.

Latest phase test delta: P8 Rust worker/resource/worktree/reservation suite passed 226/226 and RC0 Python selector passed 48/48; its WSL2 selfcheck measured only its own process + sleep child and does not count as product baseline evidence. P8 is adding durable bounds/replay compatibility and needs separate actual-product RC0 baselines. P1 Task/subagent suite passed 15/15 (117 assertions), shell interpolation allow/deny passed 2/2 (18 assertions, deny zero-spawn), and focused Linux confinement 5/5, workspace-race 2/2, settlement provenance 5/5, ToolBatch 17/17, Direct Attempt RPC 10/10. Overlay audit after exact source exceptions: hidden source/stale ignore counts zero. Markdown audit exit 0 (280 tracked, 0 active blockers, 62 archive-only warnings); convergence exit 0 (28 schemas, 1,228 checks, no failures). C: remains 21 GB free. P1/P2/P8 and V1 remain PARTIAL; no push gate, commit or publication.

Further current-source results: P8's durable bounds/replay follow-up passed 139/139 Rust tests; rustfmt passed. P2's canonical profile-definition and permission-ceiling hash tests passed 2/2 with shared TS/Rust golden digests. P1's broad nine-file OpenCode origin bundle passed 60/60 (217 assertions). P1 is adding deep HostKernel profile validation and authenticated zero-mutation evidence; a digest helper or TS/schema test alone is not managed authority. P8 owns repair of the remaining `test/project/worktree.test.ts` TypeScript diagnostics and current product resource baselines; its Bun/tsgo lane is active.

P8's focused `test/project/worktree.test.ts` passed 14/14 (34 expectations), and the subsequent package typecheck reported no P8-owned diagnostics. Remaining diagnostics are P2/Core managed settings/capability fields and P3 `repo-tools` typing. P8 still owes product-level RC0 baseline and whole-phase acceptance.

P8 then returned PARTIAL with no active Cargo/Bun/tsgo process: durable worker bounds/replay and its P8 selectors passed, the worktree suite passed 14/14, and P8 typecheck diagnostics are cleared. Its release-critical RC0 baseline is still blocked until a real Core/Rust-owned live Session/Run attestation source exists. P3 RepoIntel is now active in the freed child slot, alongside P1 and P2. P1's strict HostKernel profile decoder passed 1/1; its malformed-auth RPC test awaits P2's private `profileDefinition` schema/wire field and remains fail-closed.
# 2026-10-19 continuation handoff (latest)

User requested faster completion by adapting existing pinned OpenCode/Codex/OMP implementations. Use existing code and product seams wherever compatible; do not create duplicate runtimes or bypass Guard/managed ownership. Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P3 RepoIntel (the platform permits three child slots). P8 previously returned PARTIAL and is not active. P4–P9 remain in the V1 scope and queued for freed slots. Parent owns integration and final acceptance.

Cross-phase contract review required admission to bind `ContextSelectionV1.sessionID` to the authenticated managed admission `sessionID`; P1 has now implemented and tested this denial boundary. P2 still owns a stable digest golden vector and Core/schema/Rust decoder parity. P3 is reusing existing indexd/OpenCode RepoIntel components; keep its production query unavailable until P1 authenticated read-scope grants and bounded transport are verified.

P1 has since completed the profile/context focused bundle: Rust context decoder/session binding 2/2, strict profile decoder 1/1, managed RPC integration 15/15. The foreign-session negative verifies zero mutation. P2 is using the next shared Cargo lane; P3's schema/fixture bundle is 7/7 (47 assertions) and its HorizonCode TypeScript package typecheck (`packages/opencode`) is being rerun. These are phase-internal checkpoints; P1/P2/P3 remain PARTIAL, and no managed effect or RepoIntel production read is enabled.

Latest: P2's `managed_control` integration suite passed 39/39; P3's RepoIntel/RepoTools suites passed 54/54 (380 assertions), schema/fixture 7/7 (49 assertions), and full indexd suite 73 library + 44 integration passed. Final HorizonCode TypeScript package typecheck (`packages/opencode`) after P3 changes has only one P6-owned TS2352 Layer-cast diagnostic at `test/server/httpapi-config-features-isolation.test.ts:29`; no P2/P3 diagnostics. Indexd tests do not prove HostKernel authenticated read-grant integration. P3 released Cargo to P1; P3 continues HostKernel-independent phase work. Do not promote P1/P2/P3 to VERIFIED from these checkpoints.

More recent phase-owned checks: P1 recovery receipt recomputation passed 2/2 after exact RED regressions; P2 managed-control passed 39/39, managed client 36/36, and Core AgentProfile/ContextSelection schema tests 9/9 + Core profile/context 2/2; P3 RepoIntel/RepoTools 55/55 (384 assertions), schema/page 7/7 (49 assertions), and indexd 73 library + 44 integration passed. P2 is now taking Cargo for the RepoRead envelope/feature codec + golden digest tests. A final HorizonCode TypeScript package typecheck (`packages/opencode`) is still required after shared edits settle; P3's latest check had only the unrelated P6 isolation Layer-cast diagnostic, before the bounded-render changes.

Latest correction: P2's full kernel library suite passed 319/319 with the authenticated RepoRead codec, negotiated feature, and ContextSelection/profile goldens. P2 released Cargo to P1 for HostKernel context propagation + RepoIntel feature gate. Status remains PARTIAL; typed managed admission/effective ceiling proof, P1 full adversarial acceptance, and P3 authenticated dispatcher/backend wiring remain open.

P1 then passed `authenticated_repo_read_context` 2/2: strict envelope context roundtrip plus zero-mutation denial before RepoIntel dispatch when authorization/feature context is not enabled. This does not prove a successful HostKernel read. P2's Core optional-feature selector passed 15/15 and Goal-review/TUI selectors 8/8; these do not replace the one real managed Attempt/effect/evidence/verifier journey. All three phase owners remain active and PARTIAL.

RepoIntel contract is now reconciled: an optional out-of-body typed `RepoRead { sessionID, locationID }` is carried by the existing authenticated envelope. Principal, canonical root/workspace, and current read scope/policy are HostKernel-derived. The body keeps canonical `queryId`, relative `rootRef`, expected `sourceGeneration`, selector, bounded limits/deadline, and optional opaque cursor; HostKernel resolves the relative root within the registered Location and rejects stale generation pins. Cursors bind to authenticated principal + Session + Location + read scope/policy + generation + expiry.

Exact seam agreed: P2 extends existing private authenticated IPC with optional out-of-body `AuthenticatedRequestContextV1::RepoRead { sessionID, locationID }` and strict codec/fixtures; P1 validates it for RepoIntel, resolves canonical Location/root and Guard read policy, and fences opaque cursors; P3 consumes it without adding caller-controlled identity/scope authority. If HostKernel cannot validate the binding, the read route remains unavailable.

Resources: `/mnt/c` free 20 GB; `/` free 813 GB; `kernel/target` 12 GB; `indexd/target` 269 MB. At the latest observation, P3 released Cargo to P1; P2 is source-only on protocol codec/fixtures. Run only one shared Rust build at a time and preserve caches. Git is `main` with a mixed working tree (150 staged, 191 unstaged, 150 untracked; zero conflicts). Ownership is ambiguous; preserve state and do not stage/commit/push/clean up. Status is PARTIAL / NOT RELEASED. Resume by checking live owners/processes, then continue active full phases and assign a queued phase as soon as a slot frees.

Continuation delta: P3 reports `indexd::repo_structure::{RepoStructureQueryV1, RepoStructurePageV1}` and `RepoIntelGeneration::query_structure(query, provenance)` added; indexd suite is 73 unit + 47 integration green. Structure remains truthfully UNAVAILABLE until a parser is integrated. P2 reports the Goal-review projection now carries/renders accepted capability scope (empty means effects denied), with focused component 5/5 (34 assertions) and TUI typecheck green. P1 is implementing Guard `files.read` scope and HostKernel dispatcher; current source still denies all RepoRead requests, so keep feature/read path unavailable. Parent source review flagged the current binary conversion of authenticated principal into a string; preserve the typed `AuthenticatedPrincipalV1` through dispatch rather than reconstructing identity from a caller string. Active whole-phase owners remain P1/P2/P3; next phase must start when a slot frees. These are owner-reported checkpoints pending parent integration review, not phase completion.

P1/P3 then reconciled the RepoIntel integration types: query `sourceGeneration` is the derived index digest, not the measured workspace source revision. HostKernel must capture bounded files under the authenticated registered Location/current Guard `files.read` scope, build the generation with trusted pins, compare the requested index digest after build, remeasure source revision before returning, and bind the cursor/grant to principal/session/location/scope/policy/generation/query/expiry. Preserve typed `AuthenticatedPrincipalV1` through the reader/dispatcher boundary. The frozen internal dispatcher is being implemented; no successful authenticated query has passed yet.

P3's node-reference selector was RED then GREEN after exact file digest/length and workspace/generation/revision/root/range binding checks; focused suite 4/4, format and diff checks clean. After resuming phase owners, P1 has the Cargo lane (`authenticated_repo_read_context`) while P2 has a Core typecheck lane. `kernel/target` was removed by the user's exact request with `cargo clean`; P1's current build recreated 448 MB. C: free 20 GB, WSL `/` free 824 GB. Git now reports 241 tracked changed paths and 154 untracked paths; preserve the mixed tree and do not stage/publish until exact ownership is established. Whole-phase owners P1/P2/P3 are active again; remaining V1 phases are still queued pending slots.

P1 reports authenticated RepoRead negative/codec selector 2/2 and now preserves typed `AuthenticatedPrincipalV1` through ReaderMessage/HostKernel rather than rebuilding a principal string. No positive RepoRead dispatch exists yet. P2 is implementing the Core SessionSupervisor producer; P3 owns the OpenCode consumer and has been told to continue independent adaptation and coordinate request/response mapping. Current process scan is clear; `kernel/target` 776 MB and `indexd/target` 290 MB. This does not complete any of the three phases.

Contract correction for first RepoIntel query: caller cannot know HostKernel's derived index digest before the first query. Added `repo-intel.v1/ensure_generation` over the same authenticated service: Core sends bounded `RepoGenerationRequestV1`; HostKernel applies Guard `files.read`, securely snapshots, builds/reuses the index, and returns `RepoGenerationPinV1` with `sourceGeneration` (index digest) separate from measured `sourceRevision`, bounded coverage, source kind and expiry. Core then submits `query_structure` with this returned pin. No source bytes or identity/scope authority cross in the request body. Canonical JSON schema and §12.18/30.23/37.22 docs are updated and syntax/diff checks are clean; implementation is still pending, feature remains unavailable.

## 2026-10-19 resumed integration state

Active whole-phase owners are P1 Guard/ExecutionHost, P2 managed vertical, and P3 RepoIntel (all available child slots). P1 reports HostKernel generation leases now bind authenticated principal/session/location/root/policy/revision/query ID, with deadline enforcement, strict UTC parsing, omitted optional fields, and positive/negative ensure→query RPC coverage added; Cargo verification and parent review are still pending, and RepoIntel remains unavailable. P1 is implementing durable principal-bound Location registration and the effective-ceiling proof. P1 also owns the approved P5 guarded outbound HTTP/receipt/cancel boundary. P2 reports prior Core typecheck and focused launch/schema/managed-control/review tests green, but managed admission is still fail-closed pending P1's proof; P2 is carrying the Task-pinned profile revision. P3's latest RepoIntel/RepoTools selectors pass 57/57 and schema passes 8/8; its test found the HorizonCode CLI-host package consumer was not connected to Core's `queryRepoStructure`, and that path now passes a focused 1/1 consumer journey through trusted SessionSupervisor context. P3 still owes real authenticated HostKernel/Core socket and recovery acceptance. P1/P2/P3 remain PARTIAL.

**Security blocker:** P1 source review found `authorize_repo_read_scope` only validates path/revision; `FILES_READ_ID` is not yet used to authorize the authenticated principal. P1 is adding a durable authenticated-principal binding to Location registration (or equivalent Guard grant) and a cross-principal zero-read denial. Until that check and the final positive RPC journey pass, the RepoIntel feature is not negotiated. P2 also identified that Tasks did not persist an accepted profile selection; parent updated the canonical Task contract to pin immutable `agentProfileRevision: ProfileRevisionRef` and added VEO-014. P2 owns Task/OwnerLog/Core/TUI propagation; P1 validates the exact durable pin before minting its opaque effective-ceiling proof.

Parent reran overlay visibility after adding only exact root `.gitignore` exceptions: `compared=6627 changed=313 missing=0 symlink_delta=0 hidden_changed=0 hidden_new_source=0 stale_unignore=0`; `git diff --check` passes. Last resource check: C: free 20 GB, WSL `/` free 824 GB, `kernel/target` 889 MB, `indexd/target` 290 MB. P4–P9, final integrated Security/recovery and product journeys, RC0, final A1/A2, and release qualification remain open. Preserve the mixed tree; no staging, commit, push, or cleanup is safe until ownership boundaries are established.

Latest P3 follow-up: its bounded `repo.tree` suite passes 10/10 (29 assertions), including symlink skip and external-directory denial before enumeration; RepoIntel/RepoTools remain 57/57 and schema 8/8. Its latest HorizonCode TypeScript package typecheck (`packages/opencode`) has only the known P6 Layer-cast diagnostic. P3 released TypeScript to P2 and continues its phase; P2 owns the next Core/profile-pin checks, and P1 owns the single Cargo lane after coordination.

## 2026-10-19 continuation delta — principal propagation

P1/P2/P3 remain the active whole-phase owners. P1 will preserve legacy location registration only as unbound and without RepoIntel authority; managed/profile and RepoIntel require typed ServerAuth and durable HostKernel-derived principal binding. P2 is authorized to make narrow trusted-principal context plumbing across Core callers (including context-only LLM runner plumbing if required) while making no P6 behavior changes. Cross-subject/forged profile-owner attempts must deny before OwnerLog mutation. Current code, tests, and final gates remain incomplete; see `CURRENT_RUN.md` for disk/build/Git snapshot and ownership caveats. P4–P9 remain queued; final integrated acceptance and release are NOT VERIFIED.

P1 added the persisted profile-owner-binding digest to `EffectiveCapabilityCeilingProof`; derivation requires matching accepted Task/profile owner and recomputes User owner from authenticated Attempt subject before capability intersection. Keep cross-subject mismatches fail-closed and prove zero preparation/effect. Rust acceptance is pending stable P2 managed-control API. See `CURRENT_RUN.md` for the active roster and resources.

RepoIntel overlays remain an explicit V1 blocker per §30.22: P3 is adding opaque `overlayRef`/`overlayDigest` contract handling; P1 owns a HostKernel-issued bounded ref lifecycle bound to authenticated principal, Session, Location, base generation, source revision and read-policy digest. There is no current Core snapshot producer. P2/P4 must provide a genuine buffer owner; do not accept query/tool/model bytes or P7 artifact refs as snapshots. Until integrated tests prove two owners get distinct overlays and stale writes deny, this acceptance remains NOT VERIFIED.

P1 has wired authenticated Task owner binding into HostKernel ingress and Guard ceiling derivation, with a regression for same-owner User positive, cross-subject/OS-only denial, and Builtin positive. `rustfmt` passed; Cargo acceptance is pending a coordinated exclusive build lane after P2 confirms managed-control API stability.

Overlay ID contract detail: use host-generated opaque `ovl_[A-Za-z0-9_-]{16,128}` refs; the optional query ref is only a lookup handle, while HostKernel authenticates ownership and validates `overlayDigest` provenance. No genuine Core snapshot producer exists yet, so mint and live distinct-overlay acceptance remain unavailable/not verified.

P1 also keyed RepoIntel generation leases by request/query ID to prevent same-owner concurrent pin overwrite, with a two-pin matching-query regression. Rustfmt passed; Cargo verification is pending P2's managed-control source stability.

P3/P1 source now carries optional RepoIntel query `overlayRef` and node/page `overlayDigest`; HostKernel strictly decodes/preserves it and fail-closed rejects unsupported overlay refs before generation lease lookup/filesystem collection. Base-only passes no overlay into indexd. No mint producer exists; live distinct-overlay tests remain open. Cargo is still held for the P1/P2 managed-control integration once P2 stabilizes Rust source.

P2 reports stable `managed_control.rs` owner-binding persistence and an Alice-profile/Bob-executor zero-mutation denial. The single Cargo lane has been handed to P1 for focused compilation/acceptance; P2/P3 remain source-only until release.

Resource correction: a fresh scan found an active HorizonCode CLI-host package `tsgo` typecheck (PID 84283 family, started 14:15 UTC); P1 holds Cargo until it exits. Do not start another heavyweight check or kill it; owner/results are being identified. Disk remains C: 20 GB free and WSL `/` 824 GB free.

HorizonCode TypeScript package typecheck (`packages/opencode`) exited 2; P3 has no owned diagnostic. P2 owns the principal-context propagation failures, including detached SessionRunCoordinator→SessionRunner; P6 owns one Layer-cast fixture diagnostic at `packages/opencode/test/server/httpapi-config-features-isolation.test.ts:29`. P1 now uses Cargo for owner mismatch composition, then releases to P3 repo_structure. P2 must not start a concurrent TypeScript check.

P1 owner-mismatch Cargo selector did not reach tests: compile stopped on duplicate P3 `BufferOverlay::digest` / `base_generation_digest` definitions in `indexd/src/lib.rs` (near lines 535/540 and 855/847). P3 owns the fix and Cargo lane; P1 reruns after P3 releases. This is NOT test evidence.

P3 removed the duplicate BufferOverlay methods; `indexd` repo_structure Rust tests pass 6/6, schema 9/9 (67 assertions), RepoIntel/RepoTools 60/60 (410 assertions), JSON schema valid. P3 remains in progress pending HostKernel auth integration, overlay mint producer/isolation, stale/cancel/restart and full phase evidence. Cargo has been handed to P1 for the managed profile-owner proof rerun.

P1 Cargo retry reached kernel compile but still exited 101 before tests: P2 E0365 at `managed_control.rs:22` (public re-export of crate-private ProfileOwnerBindingV1) and P1 E0308 at `host_kernel.rs:10282` (`Vec` passed to array-only `map_value`). Cargo is idle/released. Owners are fixing their respective files source-only; rerun once both report stable.

P2 fixed the profile type visibility re-export; P1 fixed HostKernel `map_value` construction (rustfmt check passes). P3 reports repo_structure 6/6 and released Cargo. P1 is rerunning the owner-binding selector; await its exact test result.

P3's focused overlay evidence: OpenCode RepoIntel test 51/51 and schema test 9/9 (67 assertions). Without request overlayRef, response page/node overlayDigest must be absent; with a ref, page digest is required and every node digest must match (reject base-only downgrade). Host unsupported overlay is typed `capability_unavailable`; stale generation maps to `generation_mismatch`. P3's foreign-base Rust test awaits P1 Cargo release; live mint/producer still absent.

P1 owner-binding focused Rust selector passed 2/2 (323 filtered): Guard mismatch before ceiling mint and managed Alice/Bob mismatch before mutation. P1 owns two compile warnings (`unused BTreeSet`; public method returning crate-private receipt) and must rerun on the warning-fixed revision. Cargo is with P3 for updated overlay/repo_structure tests.

Latest post-build disk check: C: 20 GB free, WSL `/` 823 GB free, `kernel/target` 1.5 GB, `indexd/target` 292 MB. No build process active in the instant scan; preserve caches.

Overlay audit correction after P2 Core additions: parent added exact ignore exceptions for `packages/core/src/session/run-coordinator.ts` and `packages/core/src/session/runner/index.ts`; audit now reports 6,627 compared, 315 changed, zero hidden changes/new source/stale exceptions; diff check is clean.

RepoIntel overlay ordering blocker: Core currently may run `ensure_generation` before HostKernel rejects unsupported `overlayRef`, so file collection can precede denial. P2 owns an early Core capability-unavailable gate + zero-dispatch test; P1 HostKernel denial remains defense-in-depth. Do not claim denial-before-read until that passes.

P1 fixed both reported warnings (unused import removed; `ensure_repo_generation` narrowed to `pub(crate)`) and added a HostKernel overlay denial regression that renames the source after pinning; capability-unavailable must occur without remeasurement/collection. Rustfmt is clean; rerun awaits P3 Cargo release.

P3 post-overlay Rust selector passed 6/6, including foreign-base denial, and Cargo is explicitly released. P1 takes Rust for warning-fixed owner binding and pre-collection overlay denial; next P2 gets TypeScript for Core principal propagation after release.

P1 warning-fixed Rust selectors pass: profile owner mismatch 2/2; authenticated generation pin/identity/scope/expiry + overlay denial before source remeasurement 1/1. Targeted warnings are gone; remaining warnings are unrelated. Cargo released. Parent updated §30.22 to reconcile overlay semantics: an explicit overlay request must fail typed unavailable/stale with no nodes and cannot downgrade to base-only; partial base-only results are only allowed for queries that never requested an overlay.

P1 released Cargo; P2 takes the TypeScript lane for Core trusted-principal plumbing and early overlayRef denial. P3 stays source-only, then gets Cargo for RepoIntel overlay integration after TS release. Do not overlap.

Managed admission is still fail-closed: P1 confirms `managed_admit` returns `capability_unavailable` before OwnerLog open and the effective ceiling proof has no production consumer. P2 effect dispatch needs real typed workspace/resource lease producers (P8) plus P1 live Guard resolution. P8 remains queued as a whole-phase owner for the next available slot; do not treat the proof type or tests as wired runtime authority.

Real-socket RepoIntel still cannot negotiate authenticated context because `hz-kernel` supported_features omits `repo-intel.read-context-v1`. P1 is adding a readiness-gated feature offer and Linux socket positive/negative matrix; per-connection enablement and peer negotiation remain mandatory. Keep unavailable until all tests pass.

P3's overlay schema validation passes for five shared records; three malformed cases are rejected (bad ref, node digest without page digest, digest on a base page). The durable fixture covers overlay provenance. This does not prove a live mint/transport path.

P3 source audit found no production Core/OpenCode unsaved-document snapshot owner; only RepoIntel DTO/input code exists. P1 overlay mint stays unavailable. VEO-005 two-live-overlay acceptance requires a genuine P2/P4 buffer producer; P3 is checking reusable P4 LSP document synchronization. Keep the blocker explicit.

P3's exact producer audit: Core supervisor only forwards overlayRef; OpenCode LSP `notify.open({path})` reads disk and owns no unsaved text input; LSP query APIs expose no buffer snapshots; broker pins service identity only. Legacy RepoIntel tool inputs accept caller bytes and cannot mint owner authority. No existing V1 unsaved-buffer owner exists; a new authenticated producer is required for live overlay acceptance.

P2 Core typecheck after principal propagation reports exactly three errors, all same cause: `SessionSupervisorError` used as value at session.ts:390/415/467 but imported type-only. P2 is fixing import and rerunning; no other diagnostics in that run.

P2 Core typecheck is green (`cd packages/core && bun run typecheck`, exit 0). TS lane released. P1 takes Cargo for readiness-gated real socket RepoIntel acceptance; P2 continues full managed acceptance, not complete at typecheck.

Core now early-denies unsupported `overlayRef` through `withRepoIntelOverlayGate` before principal resolution, Location registration, or ensure-generation. P2 must prove zero registration/ensure calls. P4 LSP document map is loaded from disk and has no authenticated snapshot producer; two-live-overlay acceptance remains blocked.

P1 real-socket selector compiles but fails base ensure→query with `invalid_repo_query` at `hz_kernel_process.rs:712`; this is NOT acceptance. P1 is diagnosing the strict DTO mapping. P3 reran overlay-aware repo_structure 6/6 and released Cargo. Do not weaken schema/validation to mask the mismatch.

Socket failure root cause was a malformed empty positive selector fixture, which strict indexd validation correctly rejects. P1 changes fixture to `includeCallers: true` and reruns; no production validator relaxation.

A brief Cargo/TypeScript overlap was detected. P1 canceled its own retry (exit 130); no Cargo remains, the OpenCode `tsgo` PID 90418 continues and owner is being identified. Nothing unrelated was killed. Wait for the TypeScript lane to release before P1 retries.

HorizonCode TypeScript package typecheck (`packages/opencode`) PID 90418 is P3-owned. It remains active; P3 will report/release TS, then P1 retries Cargo. Do not overlap.

Latest P3-owned HorizonCode TypeScript package typecheck (`packages/opencode`) exited 2 and TS is released. P3 owns two repo-intel test typing errors (lines 537/545); P2 owns trusted-principal propagation diagnostics in workspace/VCS/managed-control/apply_patch/shell/task/write/session handlers; one P6 config isolation fixture cast remains. P1 takes Cargo for the corrected socket selector; no overlap.

P1 Linux socket selector passes 1/1 (8 filtered): negotiated ensure→query, foreign owner, overlay denial before source collection, stale pin, and non-negotiated peer. Profile-owner mismatch selector passes 2/2 (323 filtered). Cargo released. Phase acceptance/release remains open; unrelated existing Rust warnings remain.

Release typecheck target is root `bun run horizoncode:typecheck` (HorizonCode CLI-host package + TUI + Core sequentially), not just the upstream HorizonCode CLI-host package package check. P3's RepoIntel test now passes 51/51 (385 assertions); await P2 source fixes, then run the integrated HorizonCode script.

Core→HostKernel live socket test currently fails canonical page decoding: HostKernel emits uppercase freshness, schema requires lowercase. P1 owns serializer mapping/regression; P3 reruns `bun test test/repo-intel-live.test.ts` after correction. This is not accepted until green.

P2's new Core overlay gate/coordinator sources were exposed through exact root ignore exceptions. Latest overlay audit: 6,627 compared, 316 changed, zero hidden changed/new source/stale unignore; `git diff --check` clean.

P1's corrected socket selector passes 1/1 with canonical page assertions (`UNAVAILABLE`, `unknown`, `unavailable`, `none`, no nodes). Serializer casing fixed; Cargo released to P3 to rerun Core live socket test. Do not count the prior failure as acceptance.

P3 Core live RepoIntel test now passes 1/1 (9 assertions) for authenticated ensure→query, Session/Location context, lineage validation, and truthful parser-unavailable page. P1 separately covers socket negatives. P3 remains incomplete pending integrated HorizonCode TypeScript package typecheck (`packages/opencode`) and the missing real snapshot producer/two-overlay journey.

Core live RepoIntel consumer is green (1/1, 9 assertions). P3 takes Cargo for full indexd regression while P2 remains source-only; after release P2 takes `horizoncode:typecheck`. No overlap.
## 2026-10-19 continuation (14:32 UTC)

V1 remains PARTIAL / NOT RELEASED. Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, and P4 LSP/DAP/REPL (P3 released its slot as PARTIAL). P2's single integrated `bun run horizoncode:typecheck` is running after fixing three diagnostics; do not overlap another TypeScript build. P1's corrected shell-interpolation fixtures await that lane. P4 has started with exclusive LSP/DAP/REPL module/test ownership and is auditing the authenticated buffer-source seam; it must keep effects unavailable until P1's Guard/confinement dispatcher passes.

Latest P1 Linux terminal containment selector passed 2/2 (workspace write allowed; outside-metadata and host-network denied). P3 current evidence: indexd 123/123, schema 9/9, RepoIntel/RepoTools 61/61, adapter 51/51, Core authenticated socket consumer 1/1, HostKernel socket 1/1, owner mismatch 2/2. P3 remains PARTIAL: approved parser dependencies cannot provide production TS/Rust structural results; no authenticated immutable-buffer producer exists, so overlay references fail closed. Query→stale `files.patch` acceptance remains unverified and P1-owned.

Parent overlay audit: 6,627 compared, 316 changed, zero missing/hidden/stale; `git diff --check` clean. `/mnt/c` has 20 GB free; WSL `/` 823 GB; Rust targets are 2.3 GB (kernel) and 292 MB (indexd). Main worktree only; mixed staged/unstaged/untracked ownership remains ambiguous, so no stage/commit/push or cleanup performed. Preserve state and use one heavy build lane.

## 2026-10-19 update (14:48 UTC)

P2's integrated `bun run horizoncode:typecheck` now passes HorizonCode CLI-host package, TUI and Core after threading the authenticated ServerAuth principal into both HostKernel approval calls. P2's focused Core coordinator/overlay selectors pass 2/2 (8 assertions); the trusted provider-tool runner selector passes 1/1 (5 assertions). P2 remains PARTIAL on managed reviewer/verifier/current-workspace evidence, TUI review delivery and lifecycle recovery.

P1 root-caused the shell-interpolation lease failure to the missing trusted principal in those two HostKernel calls. P1 is rebuilding `kernel/target/debug/hz-kernel` before rerunning the allow/deny approval journey; no production lease change is justified unless that rebuilt-binary test still fails. P4 returned PARTIAL with 208/0 LSP/DAP/REPL tests (724 expectations), Prettier and diff checks clean; the effects, authenticated editor ingress and real-project journeys remain blocked/unverified. P8 is the next active whole-phase owner and is tracing durable owner/lease lineage without treating process-local pool state as authority. All effects remain fail-closed until P1/P2/P8 proofs pass.

Active owners are P1/P2/P8. Parent overlay audit: 6,627 compared, 316 changed, zero hidden/stale; C: `/mnt/c` has 21 GB free; WSL `/` 823 GB; kernel/indexd targets 2.2 GB/292 MB. Main worktree only; preserve mixed staged/unstaged/untracked state. No exact-scope commit, push or cleanup has occurred. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 post-restart continuation — log forensics + owner quorum

The hosting server restarted 15:02:49 UTC after ~25 h down. Log forensics (`~/.local/share/opencode/log/opencode.log`): 32 `serve --service` starts since Oct 17 with zero crash/panic/OOM entries; the lifecycle is CLI/app-driven (`background service starting reason=missing`, one explicit `opencode service restart`, one client `Timed out waiting for the background service`, `watcher stopped`→new-start cycles ~1 s apart) with 11 client `Event stream stalled` disconnects. Aggravators: 2.13 GB `opencode.db`, 20–40 s boot with all MCPs, WSL memory pressure (7.9 GB VM, swap 1.6/2.0 GB busy). No code lost.

Owner sessions after restart: P1 terminal/shell (`ses_eb1026206ffenPuA1w8lTObTOu`) and P2 client/TUI (`ses_eb1026152ffe7T8ECjWnKpDSSN`) auto-resumed at 15:03:06 and stayed mid-turn; P1.3 Guard (`ses_eb4ead3d5ffeRPhH6sBFf5yh4m`) and P2 managed (`ses_eb4ea6f76ffeWOqS08OuA9sNF5`) hit a provider usage limit during startup drain, were re-prompted at 15:09:29 UTC with the implementation-first direction, and are actively working. Tool-suite upgrade research closed idle at 15:03:46 (WS-TOOLRES complete); P1-ORIG assigned set recorded COMPLETE (zero child effects). No staging/commit/push.

### 2026-10-19 15:41 UTC — concurrent Codex writer fleet (deconfliction)

A second, user-run Codex orchestration (codex-tui; fork of `01a14f8d…`) is editing this same checkout in parallel and maintains its own CURRENT_RUN entries. Codex owners: P8 `14:47-53` (kernel worker_*/worktree_lifecycle/perf), P7 `15:13-56` (TUI/session-event/artifacts), P6/S1 `15:13-52` (provider/doctor/dialogs), P5 `10:53-04`+`14:59-27` (websearch; dialog fix 15:25–15:28), P4 `15:34-50` (LSP/DAP/REPL), Codex P1/P2 started 15:34:40/46 (kernel). OpenCode lanes: P1.3 = `tool-batch.ts` + `core/session/supervisor.ts` + `kernel/effect_host.rs`; P2 = `managed_control.rs` + `host_kernel.rs`; P1-TERM = `terminal.rs` + core `pty.ts` + pty/shell tests. HostKernel/hz-kernel currently have two concurrent writers (OpenCode P2 + Codex P1) — arbitration raised to the user at 15:41 (recommended: OpenCode keeps kernel P1/P2; Codex keeps P4–P8). Before dispatching OpenCode owners into P4–P8 paths, check `~/.codex/sessions/2026/10/19/` rollout mtimes for active Codex writers. Keep one heavyweight Cargo lane.


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

## 2026-10-19 15:52 UTC — active managed-process contract handoff

The implementation-first V1 wave continues under P1/P2/P4 whole-phase owners; no phase or release gate is complete. No validation workloads are authorized until implementation scope closes.

The shared managed process boundary is now aligned on the exact private `ManagedAttemptScopeV1` wire envelope: Goal/Run/Task/Attempt IDs, canonical-decimal owner epoch and managed revision, authenticated Location/Session, current workspace revision digest, and Rust-owned delegation-binding digest. Each effect separately binds its effect ID, durable OwnerLog revision, capability and one-use lease digest. P1/P2 agreed that observed verifier output must bind the same live Attempt and exact criterion effect IDs; the HostKernel's fresh workspace revision is authoritative. The verifier remains disabled (`TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`) pending real guarded dispatch and receipts.

P4 has added `locationID` ownership to DAP/REPL effect and session records. Their workspace revision pins remain independent from process generation, owner epoch and (for REPL) source generation. All process/effect paths still requiring P1 Guard/confinement stay unavailable.

At this checkpoint P1/P2/P4 are active; P8 is first queued, then P7 and remaining P3/P5/P6/P9 work. C: `/mnt/c` had 20 GB free, `kernel/target` 2.7 GB, `indexd/target` 292 MB; only the main worktree exists. The tree is mixed staged/unstaged/untracked and `main` is 12 ahead. Preserve it; no publication or cleanup was performed.


## 2026-10-19 15:53 UTC — managed receipt source delta

P1 has source-wired HostKernel terminal settlement to record each managed effect's exact Attempt receipt edge, principal, epoch, Location/Session, bound OwnerLog revision, lease digest, target receipt and before/after workspace revisions. Unknown launch/exit/receipt states persist UNKNOWN and cannot be retried. P1 also added host-derived Attempt and per-criterion effect IDs to verifier observations/journal. P2 tightened principal matching and requires all coding receipts SUCCEEDED at the exact source revision before verifier intent; verifier output must preserve that revision. The HostKernel verifier call-site still uses an incompatible legacy begin sequence, so verifier dispatch and finalization remain disabled. These are source-only changes, not built/tested or phase acceptance.

A broad `git diff HEAD --stat` invocation exited with SIGBUS while reading the large shared dirty tree; no file mutation or validation workload followed. C: remained at 20 GB free; no Cargo/Bun/TypeScript test process was active. Avoid broad diff output and preserve the mixed tree.

### 2026-10-19 15:56 UTC — managed Attempt revision-chain ruling and open reducer fix

- Source review confirms HostKernel derives the current workspace head from the immutable Attempt admission revision and prior ordered SUCCEEDED effect receipts, while also recomputing the registered workspace root before dispatch. The aggregate OwnerLog expected revision is separate from each effect edge's immutable bound revision.
- A reducer gap remains: `ManagedControl::RecordAttemptEffectReceipt` was still comparing each coding effect's before revision directly to the Attempt base. P2 acknowledged and is implementing reducer-side ordered receipt-chain validation; P1 owns HostKernel chain enforcement. Until both sides agree and the chain is integrated, verifier dispatch and finalization stay disabled.
- Contract was reconciled across arch_V1 §§3.22, 12.19, 14.3 and 37.22: immutable admission provenance; exact predecessor-linked receipt chain; serialized V1 mutations; read-only verifier before=after=current head; failure/UNKNOWN/cancel/epoch change/out-of-chain edit fences; no caller rebase. No tests/builds/typechecks were run.
- P1/P2/P4 remain the active whole-phase owners; all V1 phases remain PARTIAL / NOT RELEASED. C: `/mnt/c` has 20 GB free; targets are 2.7 GB/292 MB; one main worktree; mixed staged/unstaged/untracked state and 12 commits ahead. Preserve all ownership; no staging, commit, push, cleanup or prune.

### 2026-10-19 15:57 UTC — verifier intent/lease ordering contract

The verifier edge and immutable intent must be durable before Guard lease issuance. The intent contains the trusted profile/executable, criterion/arguments and current workspace chain head, but not the one-use lease digest. Refresh managed scope after that append; Guard/approval then issues a lease bound to the exact Attempt edge, immutable intent digest and live revision/workspace fence. Do not mutate the managed OwnerLog with the lease digest before dispatch; EffectHost owns durable one-use consumption and the HostKernel-authenticated settled receipt records the digest. Authenticated distinct reviewer approves; trusted verifier profile principal owns the child and receipt. Any pending OwnerLog/workspace change fences authorization. This follows the existing §14.3 ordering and resolves the revision cycle; verifier stays disabled until source wiring matches it. P1 was instructed to keep direct Core bypass closure in scope; P2 is fixing reducer predecessor-chain checks; P4 keeps DAP unavailable until a correctly typed non-terminal process contract exists. No tests/builds/typechecks were run.
### 2026-10-19 18:26 UTC — source-led subagent architecture audit

The live child roster is empty except for the parent; the user's stop-all-subagents
instruction remains active. Do not restart agents. The implementation-first hold also
remains active: no tests, builds, typechecks, audits or provider probes until implementation
closes.

The source review covered OpenCode `tool/task.ts` and the Codex agent-tree lifecycle across
spawn, runtime, mailbox, completion, resume, residency, registry, child configuration and
multi-agent tool handlers. Horizon's relevant distinction is now explicit: direct-session
children use the existing Core Session owner and need no Goal; managed children use Rust
Task/Attempt/DelegationBinding and independent verification. The doc correction is in
`arch_V1/03-FLOWS.md` §3.5, `29-AGENTS-SKILLS-HOOKS-MCP.md` §29.5,
`37-RUNTIME-SERVICE-LLD.md` §37.9, derived atlas §45.8, and source decision §42.12.

**Question pending:** the canonical `SubagentDeliveryV1` machine schema is lane-ambiguous and
does not define `authorityDigest`. User was asked to choose one lane-tagged envelope or
separate direct/managed delivery schemas. No schema change is made pending that decision.

All P1–P9 implementation, integration and final release gates remain open as last recorded;
this turn changes architecture docs only and supplies no implementation/acceptance evidence.
Current `/mnt/c` free space is 60 GB (87% used); only the main worktree exists. Git remains
`main` 12 commits ahead with extensive mixed staged/unstaged/untracked work. Preserve all
state; no staging, commit, push, cleanup or prune was performed.
### 2026-10-19 18:27 UTC — P1 confinement source/doc reconciliation

Source inspection found §14.5 still claimed `horizoncode-sandbox` was absent and described
macOS Seatbelt support. The live tree has `kernel/Cargo.toml` depending on the crate and
HostKernel terminal/non-PTY launch preflights in `kernel/src/terminal_process.rs` that
require the Linux backend's filesystem, egress-denial and process-tree guarantees. Updated
§14.5 and the §20.12 source map. This confirms code-present wiring for these process routes
only; it does not prove universal Guard coverage or final containment acceptance.

The sandbox API supports deny-default or host-shared network, not destination allowlists.
§14.5 now keeps networked workspaces dependent on a separate Guarded, destination-scoped
proxy/service and unavailable without that enforcement. Non-Linux confined profiles remain
unavailable. No tests/builds/typechecks were run. Full V1 remains PARTIAL / NOT RELEASED.
### 2026-10-19 18:28 UTC — resource-limit guarantee needs a V1 ruling

`horizoncode-sandbox` reports `ResourceLimits` unsupported; current Linux confinement
does not impose CPU/memory/FD quotas. Terminal and stdio preflight do not require that
dimension. Existing process slots, time/output bounds and Rust resource observations are
not OS-enforced quotas. §14.5 now records this exact source state and requires fail-closed
behavior whenever a profile requests the dimension.

Asked the user whether V1 effectful workers must require OS-enforced CPU/memory/process
count caps, or keep this dimension unavailable and rely on admission/monitoring only. This
default-policy decision is pending; no implementation change is made. P1/P8 resource work
and V1 acceptance remain open.

### 2026-10-19 — current source and resolved decisions

The user resolved the single-envelope delivery choice and resource policy. The lane-tagged
`SubagentDeliveryV1` schema and architecture now distinguish direct Core parent/profile scope
from managed Rust `DelegationBindingV1`/Attempt scope; `authorityDigest` has a canonical,
domain-separated BLAKE3 definition. Runtime Rust/TypeScript decoders and cross-language
fixtures are still required. Resource profiles that require OS CPU/memory/process-count/FD
limits remain unavailable until enforced by the OS; admission/monitoring does not count as
hard quota enforcement. §04 also records lane-bound child progress and redacted search-route
attempt projections with no replay-triggered network dispatch. A browser-safe TypeScript
`SubagentDeliveryV1` decoder is now source-present; Rust parity, fixtures and typechecking
remain open.

P5 cascade now records auth 401/403/407 per route and continues only to another explicitly
enabled/configured route; other non-rate-limit 4xx errors stop. Source and its regression
expectation changed, but tests were not run. `WEB_SEARCH_GUARD_READY=false` and production
dispatch remains unavailable. The user-directed implementation-first hold remains: no tests,
builds, typechecks, audits or provider probes before implementation closes. All P1–P9 and
release work remain PARTIAL / NOT RELEASED. The user stopped all subagents; live roster empty.

### 2026-10-19 — Rust delivery-decoder source delta

Added `kernel/src/subagent_delivery.rs` and exported the module. It strictly decodes the
lane-tagged bounded MessagePack delivery envelope, enforces lane-specific direct/managed
authority fields, and recomputes the domain-separated authority digest. This source is not
yet connected to a delivery RPC/lifecycle and proves no live authority. The decoder exposes
explicit comparisons against authenticated Core Session/profile claims or a live Goal plus
immutable `DelegationBindingV1`; these helpers do not replace Guard. Golden cross-language
fixtures, runtime integration, typecheck/build/tests and final acceptance remain open. The
workspace remains mixed staged/unstaged/untracked; do not stage, commit, push, or clean while
ownership is ambiguous. No validation workload was run.

### 2026-10-19 — P2 reviewer-path source reconciliation

Re-read the current Goal-review route, managed-control client, authenticated private
Core→HostKernel RPC dispatch and Rust durable reviewer reducer. The distinct reviewer path is
source-wired: middleware-derived ServerAuth is carried outside the operation body; Rust
assigns the reviewer durably and enforces proposer/reviewer separation and stable assignment.
This corrects the older status wording that said the production reviewer channel was absent.
Real-socket positive and spoofed-identity negative evidence remains open; P2 is not promoted
to TESTED or VERIFIED.

### 2026-10-19 — direct child profile authority ruling

Core Config's immutable `AgentProfileV2` is canonical for direct-session and managed child
profiles. Current `TaskTool` still selects through legacy `Agent.Service`, so the agreed direct
delivery claims cannot yet truthfully bind what executes. Keep direct delivery unavailable
until V2 selection and runtime projection are wired: the selected profile must drive model,
harness, instructions, tools and the effective parent-intersected permission scope before
its revision/digests are pinned to the child Session and Direct Attempt. Preserve
`subagent_type` only as a stable compatibility selector/alias to that revision; legacy Agent
configuration may be migration input, but must never independently authorize the child.
Resume the exact immutable revision or fail closed; do not inherit an unpinned parent model or
silently select latest. The release tracker marks this shared P1/P2 implementation gap and
VEO-017 acceptance. Continue to call the integrated product check `bun run
horizoncode:typecheck`; package-local results are HorizonCode TypeScript checks with an
explicit package path. No tests/builds/typechecks were run. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 19:01 UTC — full V1 implementation resumed

The user resumed V1 after the earlier stop-all-agents checkpoint. Current whole-phase owners
are P1 Guard/ExecutionHost (`p1_guard_resume_1019`), P2 managed vertical plus direct-child
AgentProfileV2 Task migration (`p2_managed_resume_1019`), and P4 LSP/DAP/REPL
(`p4_lsp_dap_repl_resume_1019`). P1 owns kernel Guard/HostKernel/process files; P2 owns
TaskTool/profile projection and managed-control/Goal/review files, with `host_kernel.rs`
reserved to P1; P4 owns LSP/DAP/REPL package paths only. P3/P5/P6/P7/P8/P9 are queued as
slots open. Parent owns integration and release-status reconciliation.

The implementation-first hold remains: no tests, builds, typechecks, audits, provider probes,
or performance runs before implementation scope closes. No phase is verified. Git MCP reports
`main` at `6c8c5ab9ad127853e45abadd8a88aed79b7a710f`, 12 ahead / 0 behind, 150 staged, 228
unstaged, 171 untracked, no conflicts, one worktree. Preserve all existing ownership; no
stage/commit/push/cleanup/prune. C: `/mnt/c` has 60 GB free (87%); `node_modules` is 2.5 GB.
No build/test process or source verification was running at dispatch.

### 2026-10-19 19:09 UTC — profile authority and P4 launch boundary resolved

The first three child turns hit an account usage limit and stopped. Replacement whole-phase
owners are active in the three available child slots: P1 Guard/ExecutionHost
(`p1_guard_full_resume`), P2 managed vertical plus direct Task profile migration
(`p2_managed_wave2_1019`), and P4 LSP/DAP/REPL (`p4_lsp_dap_repl_wave2_1019`). P1 exclusively
owns Rust protocol/HostKernel/process work; P2 owns Core/TaskTool, `managed_control.rs`, Goal,
review and TUI; P4 owns only LSP/DAP/REPL package modules/tests. P3/P5/P6/P7/P8/P9 wait for a
slot. User's implementation-first hold remains: tests/builds/typechecks/audits/provider probes
and performance commands are deferred until V1 implementation closes.

Reconciled the direct child profile authority question against §§12.11, 17, 29.2/29.20 and
37.9. Core Config's immutable `AgentProfileV2` revision is authoritative for direct and managed
children. `subagent_type` is a selector only when it maps to one stable profile ID/revision;
legacy Agent data cannot drive runtime execution under a decorative V2 digest. Core sends
authenticated exact `profileSelection` plus digest-free definition; HostKernel reuses its
existing strict decoder and BLAKE3 canonical digest helper, validates the exact tuple, and
constructs/returns the direct Attempt scope. There is no caller-supplied scope tuple. P1 owns
Rust `protocol.rs`/HostKernel; P2 owns TS/Core Task projection and durable direct Attempt record,
receipt, event and recovery. The scope adds `profileID`, positive canonical `profileRevision`,
and BLAKE3 `profileDigest`; existing `permissionsDigest` remains the effective permission-rule
digest, and `scopeDigest` continues to bind all dispatch facts.

For P4, the user approved projecting existing trusted Core Config into an immutable HostKernel
launch profile through the **single existing ExecutionHost supervisor**. There is no second
supervisor or independent mutable launch registry. HostKernel validates/resolves the profile;
P4 callers cannot authorize with raw executable, argv, cwd, env, PID or process handle. Project,
plugin and external launch definitions remain unavailable pending explicit trust resolution.
Updated architecture owners §§14/17/20/32/37 and derived flow atlas §45. P4 source review also
found a REPL scope-type mismatch, DAP `variables` cannot be assumed passive, and LSP
`notify.open` reads workspace files in the app process; their source fixes are underway. These
are code changes only, with no validation run.

No phase is VERIFIED; all P1–P9 source implementation and final release gates remain open.
Git status is mixed and ownership remains ambiguous: `main`, 12 ahead, 150 staged, 228
unstaged, 171 untracked, zero conflicts. Preserve it; do not stage/commit/push/clean. Last C:
disk check was `/mnt/c` with 60 GB free; check again after the next build-heavy wave.

## Latest source reconciliation — 2026-10-19 19:18 UTC

This supersedes the older no-owner checkpoint above. P1 Guard/ExecutionHost, P2 managed
vertical/direct AgentProfileV2 child migration, and P4 LSP/DAP/REPL are active whole-phase
owners in the three actual child slots. No tests, builds, typechecks, audits, provider probes
or performance runs are authorized until source implementation for V1 closes. Git is
`main`, 12 commits ahead with broad mixed staged/unstaged/untracked changes; preserve all
ownership. C: is monitored at `/mnt/c` (60 GB free at the latest reading).

P1 has source-added `repo-intel.v1/read_document` on the existing HostKernel RepoIntel
service. Source inspection shows out-of-body ServerAuth/RepoRead/Location binding, current
Guard `files.read`, no-follow regular-file access, UTF-8 and 6 MiB bounds, cancellation,
and exact pre/post workspace revision checks. P4's LSP client is being wired only to this
HostKernel reader; no app-process filesystem fallback is allowed. Parent documented the
additive operation in §12.18, §17, §30, §32 and §37 and added RD-017/LS-011 acceptance.
P1 is adding source coverage; this source path remains untested/unverified.

The trusted Core Config→HostKernel launch-profile decision is now defined by §12.20 and
`contracts-v2/execution-launch-profile-v1.schema.json`: immutable profile ID/revision/kind,
configured executable selector, literal argv, fixed registered-Location cwd policy and
sanitized host environment. No interpolation or P4-supplied executable/argv/cwd/env is
allowed. P1 is defining prepare/launch/read/write/cancel/status RPCs on existing
`execution.v1`; launch must revalidate exact profile, Guard intent/lease and scope before
spawn, bind the resolved executable digest to HostProcessRef/receipt, and treat ambiguity
as UNKNOWN/no relaunch. P4 has removed direct LSP filesystem read and PID/stop authority;
its process launches and DAP debuggee effects remain fail-closed pending the typed contract
and P1 Guard/confinement acceptance. REPL stays unavailable until required OS resource
limits are enforced. These changes are source/design only, not phase acceptance.

P2 owns Core/TUI and `managed_control.rs` managed state. P1 owns HostKernel/process ingress;
P2 will provide the durable verifier intent/evidence contract and P1 will integrate its
HostKernel dispatch once the generic process boundary is ready. Keep verifier finalization
and worker fan-out disabled. P3/P5/P6/P7/P8/P9 and final integrated verification/release
remain queued/partial. HorizonCode V1 remains PARTIAL / NOT RELEASED.

## Latest integration note — 2026-10-19 19:22 UTC

The user confirmed existing trusted Core Config as the launch-profile source projected to
HostKernel and routed through the existing single ExecutionHost supervisor. P1 has been
directed to require immutable verifier-profile revision with no migration/default; P4 uses
only the exact profile reference and remains fail-closed pending P1 Guarded dispatch.

Parent source inspection found a launch contract mismatch: the normative launch profile and
strict JSON schema use `executableSelector`, while the current Rust profile decoder requires
an absolute `executable` path. P1 owns changing the IPC decoder/resolution so HostKernel
resolves the trusted selector without accepting caller-supplied executable paths. The strict
machine schema also needs the actual `HostProcessRefV1` shape already present in Rust,
TypeScript and §12.9, including profile/executable pins and only the applicable process-kind
variants. No validation ran. P1/P2/P4 are the three active whole-phase owners; P3/P5/P6/P7/P8/P9
remain queued. Git remains broadly mixed on `main` 12 commits ahead; do not stage, commit,
push, clean or prune. C: `/mnt/c` has 60 GB free. V1 remains PARTIAL / NOT RELEASED.

### Integration continuation — 2026-10-19 19:26 UTC

P1 source now decodes `executableSelector` and resolves only a small per-kind HostKernel
allowlist through fixed system binary directories, canonicalizing and digesting the result.
This remains untested and does not establish Guard/confinement acceptance. The parent added
the strict eight-field `HostProcessRefV1` contract to
`arch_V1/contracts-v2/execution-launch-profile-v1.schema.json`, aligned with Rust/TypeScript
and excluding PID/path authority. P1 still owns live binding/lease/scope/receipt proof; P4
still owns the typed HostKernel operation/event adapter and full lifecycle. P1/P2/P4 are active;
P3/P5/P6/P7/P8/P9 await slots. The implementation-first hold remains in force: no verification
commands have run. Git state remains mixed and untouched; no staging, commit, push, cleanup or
prune. `/mnt/c` has 60 GB free and no HorizonCode build/test process is active.

### Integration continuation — 2026-10-19 19:30 UTC

P2 confirmed there was no explicit Core selector map: `TaskTool` chose by `profileId` or display
name and selected the highest enabled revision. Architecture now specifies Core-owned
`agent_profile_selectors: [{selector, profileId, revision}]` in global user-owned
`opencode.json`/`.jsonc` only (project config cannot override), with exact immutable targets,
no implicit display/legacy-name aliases, duplicate/conflict/stale/owner rejection, deliberate
remapping, and exact Session-pin resume. P2 owns implementation; VEO-017 was tightened. P1 source
has HostProcessRef and receipt pins, mandatory verifier profile revision, honest unsupported
resource guarantees, canonical language capability IDs, and direct Attempt admission through
P2's reservation API. P1 has drafted `execution.v1/protocol_op`/`protocol_read` with bounded
typed operations/events, replay cursor, scope/revision fencing, and UNKNOWN-on-ambiguous-receipt
semantics; Guard dispatch and complete launch selector resolution are still open. P4 removed raw
LSP stream/process handles and is narrowing the adapter; `didClose` and runtime wiring remain
open. P2 found HostKernel direct profile reservations had no terminal-release call. Source now
releases after durable SUCCEEDED/FAILED and CANCELLED; UNKNOWN remains reserved. Admission-
abandon and restart-replay paths still need reconciliation. The HostProcessRef schema's process
identity length is aligned to the 160-character Rust/TypeScript validators. No validation
commands ran.
The managed verifier source also disagrees with §3.22: the OwnerLog reducer expects a settled
Succeeded Attempt before verification, but the accepted V1 flow keeps the coding Attempt live
through independent verification and settles only after evidence. P2 owns the reducer repair;
P1's HostKernel path already resolves the live verification Attempt.
V1 remains PARTIAL / NOT RELEASED.

### Current continuation — 2026-10-19 19:34 UTC

The user confirmed that trusted existing Core Config is the launch-profile source projected
into HostKernel and dispatched by the existing single ExecutionHost supervisor. P1/P2/P4
remain the active whole-phase owners; P7 is next on a real slot release. Parent source review
sees finite-number validation in `LanguageProtocolOperationV1`, typed `textDocument/didClose`
in the LSP adapter, P2's explicit Core Config selector resolution and AgentProfileV2 projection
into HostKernel direct-Attempt admission, and a managed reducer branch that records the exact
live EXECUTING Attempt for verification. These are source observations only. HostKernel now
has typed `protocol_op`, `protocol_read`, and `protocol_reply` routes with process/scope/
workspace/challenge/lease validation, but returns `capability_unavailable` before IO until the
durable receipt journal and replay event buffer exist; no lease is consumed and LSP/DAP stay
unavailable pending the full lifecycle.

P1 has since source-wired startup reconciliation for durable direct-child capacity:
pre-admission empty reservations can be abandoned only before Core receives child authority;
otherwise the reservation tuple must exactly match the durable Attempt's parent/child
Session, principal, profile ID/revision/digest or HostKernel startup fails closed. EXECUTING and
UNKNOWN remain reserved; terminal slot-release recovery is idempotent. The protocol read-page
decoder also now rejects sequence gaps. P1 closed the code-mode MCP bypass in source: nested
`callTool` dispatch is removed/denied, the `execute` tool is not registered even under the
experimental flag, and a fake-client zero-dispatch regression was added (not run). P2 source
now preserves and resumes only the same active Attempt for a durable VERIFYING Run when the
verifier, receipt chain, current head, and absence of verifier intents/evidence match; it does
not renew the Attempt owner epoch. P1 still needs to revalidate the live lease epoch and
recover the exact challenge journal before verifier dispatch. No phase is accepted.

No tests/builds/typechecks/audits/provider probes/performance runs have been run under the
implementation-first hold. Git MCP: one worktree, `main` 12 ahead, broad mixed staged,
unstaged and untracked state, no conflicts. C: via `/mnt/c`: 60 GB free (87% used). Keep the
state unchanged; no staging, commit, push, cleanup or prune. V1 remains PARTIAL / NOT RELEASED.

### Managed verifier crash-window correction — 2026-10-19 19:43 UTC

Cross-phase source review found the middle verifier recovery branch is not implementable from
the current durable fields: P1's `reconcile_managed_verifier()` returns UNKNOWN for terminal
process rows because output bytes are not retained. Host-captured output and ArtifactStore
publication happen after execution, so current target receipts cannot reconstruct evidence
after a crash. P2 removed preservation of an EXECUTING Attempt with existing verifier intents.
Current reducer source now allows only (a) the exact live coding Attempt before any verifier
intent, with complete successful coding receipts at the frozen revision, or (b) SETTLING with
typed evidence and all matching criterion/profile/executable/epoch, revision, receipt and
artifact refs already durable. A possible-dispatch crash before typed evidence remains UNKNOWN
and is never replayed. P1 owns adding authenticated reconstructible output/artifact journaling
if that recovery case is to be supported. VEO-018/§37.22 record the requirement. This source
correction is untested; V1 remains PARTIAL / NOT RELEASED.

**HostKernel verifier integration remains open:** P1 source review found the current
`managed_begin_verification`/`managed_execute_verification` route does not call P2's durable
Attempt effect/intent/receipt reducer APIs. Its broker authorization currently uses an empty
Session and requires no Attempt scope. P1 owns the HostKernel path; P2 owns the reducer. The
route must bind authenticated Session/Location, the exact live Attempt and effect IDs, owner
epoch, current workspace revision, distinct reviewer approval, and one-use Guard lease, then
record exact terminal receipts/evidence through P2's APIs. Until this is wired, the reducer's
live-Attempt source path is not a production verifier, and dispatch/finalization stay disabled.

P2 confirmed the restart owner-epoch check belongs to HostKernel: the durable managed reducer
has no authenticated current-epoch input. On startup and before verifier begin/execute,
HostKernel must compare the persisted epoch to current authenticated owner state and live
durable lease/challenge state; stale Attempt state is durably UNKNOWN/RECONCILING (preserving
CANCELLING) and cannot renew or dispatch. §37.22/VEO-018 capture this. Parent added the strict
`ExecutionProtocolDispatchReceiptV1` schema; P4's request/event decoders and replay handling
are being aligned with it. These edits remain untested.

P4 source review found `test/lsp/client.test.ts` still starts a child process and expects the
removed raw MessageConnection; P4 owns replacing it with typed adapter contract fixtures and
adding DAP adapter fixtures (source only). The current DAP client maps `threads` to canonical
read-only `debug.stack`; parent confirmed Rust Guard must match this mapping. `variables`
stays denied because adapter passive-inspection semantics are not proven. Core validates the
authenticated HostKernel receipt against the pending process ref, sequence and operation; it
does not add a BLAKE3 dependency to recompute Rust's canonical digests. No tests were run.

### Current source continuation — 2026-10-19 19:51 UTC

The user confirmed the trusted launch-profile decision: existing Core Config is projected
into HostKernel and executed only by the existing ExecutionHost supervisor. This resolves the
launch-profile source question; it does not enable process effects.

P1's current HostKernel source calls the P2 managed reducer APIs for Attempt-bound verifier
effects, verifier intents, receipts and typed observations, and rejects stale owner epochs.
`TRUSTED_VERIFIER_ADAPTER_AVAILABLE` remains false. Terminal verifier output and ArtifactRefs
still cannot be reconstructed after a possible-dispatch crash; that state stays UNKNOWN and
cannot be replayed. The `execution.v1` protocol handlers still reject before IO until the
durable operation journal and replay buffer land. P1 still owns universal Guard origin
closure, ToolBatch/lease/receipt recovery, safe process launch, confinement and adversarial
coverage.

P1 also added canonical operation/dispatch-receipt digest helpers and strict ACK parsing to
`kernel/src/protocol.rs`; this is contract code only, without durable sequence journaling,
supervisor writes, receipt-before-ACK or replay. P4 replaced the raw-child LSP fixture with a
typed no-effect fixture and added Core-side LSP/DAP protocol journals for monotonic outbound
sequences, receipt/process-IO sequence comparison, response correlation, exact replay
suppression and conflict quarantine. Real HostKernel protocol IO, process launches, DAP
debuggee effects and REPL remain unavailable pending P1 Guard/journal/confinement/resource
prerequisites. These source changes have not been run.

P2 added a revision-fenced Goal Run pause/resume/cancel HTTP route, SDK operation and TUI
`goal.control` confirmation path. The TUI reads the current Goal/Run snapshot, displays its
exact revision and sends it back; the handler rejects a stale view before CAS. These source
changes are untested. No tests, builds, typechecks, audits, probes or performance runs have
started under the implementation-first hold. P1/P2/P4 remain active whole-phase owners; P7
is next only when a real slot opens. Git state remains broadly mixed and ownership must be
preserved; no Git mutation or cleanup. C: `/mnt/c` most recently showed 60 GB free.

V1 remains PARTIAL / NOT RELEASED. P1–P9 implementation, integrated verification, real-work
acceptance and release gates remain open.

P1 integration review found a result-truth defect in `managed_execute_verification`: the
managed reducer sets `RunPhase::Failed` when any accepted criterion verdict is FAIL, but the
HostKernel handler currently returns `status: VERIFIED` after every settlement. P1 owns
deriving the response from the durable post-settlement Run state and adding a source
regression. The adapter remains disabled; this is not acceptance evidence.

P4 added DAP event-page Attempt/process/workspace scope validation, `maxEvents`/`maxBytes`
checks, IO-sequence pin advancement and skipped-cursor rejection in the Core-side protocol
journals. The REPL registry now retains its validated `directAttemptScope`; source-only DAP
fixtures cover these fences. HostKernel `protocol_op`/`protocol_read`/`protocol_reply` still
reject before IO pending P1's durable journal/replay implementation. No tests were run.

Open recovery finding: `settle_durable_verifier_evidence` currently accepts Run phases
VERIFYING/SUCCEEDED/FAILED but not CANCELLING, while the reducer intentionally preserves
CANCELLING through Attempt settlement. A crash after durable evidence/settlement during
cancellation could leave the challenge journal unreconciled. P1 owns evidence-only
CANCELLING reconciliation with no dispatch; P2 owns truthful CANCELLING response schema/TUI
projection. Source fix and validation remain pending.

### P1 verifier-settlement source update — 2026-10-19 19:53 UTC

HostKernel now source-wires the live Attempt happy path through durable typed evidence and
settlement: after `record_observed_verification`, it derives the sorted receipt digest from
the exact OwnerLog effect receipts, issues `BeginAttemptSettlement` and `SettleAttempt`, and
marks the verifier challenge set SETTLED only after the managed reducer commits. Workspace
drift records terminal verifier receipts before fencing the Attempt UNKNOWN. This remains
source-only behind the false verifier-adapter gate. P1 must reconcile a crash after OwnerLog
settlement but before the verifier journal's SETTLED update from durable OwnerLog state only;
no recovery may redispatch. A crash after process completion but before durable typed evidence
or artifact references remains UNKNOWN/no-replay.

P2's Goal Run TUI control now obtains the authenticated Goal snapshot, resolves the selected
Run, displays its phase/revision in a confirmation dialog, submits `expectedRevision`, and
receives a bounded Run status projection. The HTTP handler rejects stale views before OwnerLog
CAS; source regression fixtures were added but not run. P1/P2/P4 remain active whole-phase
owners, all phase/release acceptance remains open, and implementation-first hold continues.

Latest P1 source correction: evidence-only recovery now includes RunPhase::CANCELLING and
CANCELLED, validates the exact settled receipt digest, and returns truthful status for failed,
cancelling, cancelled, verifying and succeeded outcomes. Old owner epochs are tolerated only
for evidence-backed SETTLING/SUCCEEDED reconciliation without dispatch; stale unresolved
EXECUTING/ADMITTED work is marked UNKNOWN. P1 also added strict ACK/digest helper validation
and DAP requestID safe-integer bounds. P2 still owns aligning the TypeScript verifier status
schema/SDK/TUI for CANCELLING and CANCELLED. These are source changes, not verified behavior.

Latest P4 source correction: LSP/DAP journals now return stored receipts for exact duplicate
ACKs, quarantine same-sequence payload/receipt conflicts, bound local receipt history, and
validate inbound cursors and integer event/byte bounds even when the caller bypasses the event
cursor. No HostKernel dispatcher/read journal exists yet; actual protocol IO remains disabled.

P2 has since aligned the GoalVerification response schema and SDK types for CANCELLING,
CANCELLED and FAILED, and added matching TUI status messages. The source contract now aligns
with P1's HostKernel mapping; fixtures remain unrun.

### 2026-10-19 20:01 UTC — managed prompt boundary and current phase queue

P2 identified the missing production entry from managed admission into Core prompting: managed
control can plan/admit, while prompt execution accepts only direct Attempt authority. To prevent
a shared-file race, P2 owns `packages/opencode/src/session/prompt.ts`,
`packages/opencode/src/session/managed-control.ts`, and its managed route/UI caller for typed
ManagedAttemptScope propagation. P1 exclusively owns `packages/opencode/src/session/tool-batch.ts`,
the Guard client and HostKernel validation/receipt binding; P2 supplies the exact scope contract
for P1's ToolBatch seam. The envelope carries Goal/Run/Task/Attempt, owner epoch, expected
managed revision, Location/Session, workspace revision and delegation-binding digest. HostKernel
must validate all pins against durable authenticated state; they do not grant authority. No
effectful dispatch is enabled by the caller plumbing alone.

P1/P2/P4 occupy the three available child slots; P7 is next on actual slot release; P3/P5/P6/P8/P9
are queued. The no-validation hold remains active until all requested V1 source implementation
closes. At 20:01 UTC C: via `/mnt/c` had 60 GB free and `node_modules` used 2.5 GB. Git remains a
mixed tree on `main`, 12 ahead of `origin/main`, with no conflicts. Preserve all state; no
staging, commit, push, cleanup or prune was performed. V1 remains PARTIAL / NOT RELEASED.

### 2026-10-19 20:03 UTC — Attempt scope revision and batch lease ordering

P1/P2 identified that an Attempt scope digest includes `expectedManagedRevision`, while atomic
batch-to-Attempt binding advances that revision. Normative resolution: pre-bind scope remains
challenge-evaluation provenance only. After full Guard evaluation and any required explicit
approval, HostKernel binds the exact batch edge set atomically, returns a refreshed scope,
rechecks the live authenticated Attempt, edges, revision, workspace, policy and approval, then
issues a lease bound to the post-bind scope plus its exact edge/intent. ALLOW also defers its
lease; challenge binding may transition once before a lease exists. No issued lease is mutated
and no caller-supplied revision/rebase is authority. This applies to managed and direct child
effects; P1 owns EffectHost/HostKernel sequencing, P2 the managed scope contract. VEO-019 records
the required race/replay/recovery acceptance.

P2 has source-added typed managed authority/scope propagation through managed-control, prompt
and LLM, plus a bounded atomic managed batch-edge reducer command. P1 owns ToolBatch and effect
forwarding. Source-only; caller plumbing remains fail-closed until HostKernel consumes this
contract. No tests/builds/typechecks/audits/probes ran. V1 remains PARTIAL / NOT RELEASED.

P2 confirmed HostKernel `managed_admit` remains unavailable: trusted DelegationBinding and
owner proofs are not yet assembled despite profile/context shape validation. P1 has accepted
whole HostKernel admission ownership and will bind the exact Task profile and return the trusted
managed Attempt scope; P2 owns the authenticated Core/TUI trigger and strict response adapter.
The managed path remains disabled pending P1 admission, Guard/lease sequencing and recovery. P2
must refresh the scope after every managed OwnerLog change before another effect. This is a
source ownership update only; no validation ran.

P1's deeper source audit found managed admission also requires authenticated Attempt/profile/
context proofs, active parent WorkerExecution proof, a durable P8 worker lease, and a Guard-minted
effective capability ceiling. The current HostKernel has no producer for parent execution/worker
lease facts; `open_worker_owner` keeps fan-out closed and no WorkerPool RPC supplies them. P1
will not invent proof from caller fields. P8 is therefore a critical dependency for P1 admission
and P2's managed vertical; P7 artifact storage remains another P2 verifier dependency. Queue
both full-phase owners for actual slot releases.

P4 reports a method-bounded DAP adapter and hardened LSP transport source (Guard command
classification, sequence/ACK/replay/generation fences, serialized writes and frozen Attempt
scope). All effectful launches remain unavailable pending P1 protocol IO/launch/confinement;
REPL also needs OS-enforced quotas. Source-only, no validation. V1 remains PARTIAL / NOT RELEASED.

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


## 2026-10-19 20:40 UTC — active execution handoff

User decision: add explicit authenticated goal.start after an accepted SpecVersion. goal.plan stays PLAN_ONLY; acceptance alone does not start work. Rust atomically/idempotently transitions the exact current accepted SpecVersion's complete persisted PLANNED Run/task set to RUNNING/ready. It grants no effect authority. P2 owns the complete Core/API/SDK/TUI/Rust path. Architecture and acceptance updated in §§3.4, 17.18, 32.38/VEO-023, 37.22.

Active owners: P1 p1_guard_v1_resume_1020; P2 p2_managed_v1_resume_1020; P7 p7_stream_artifacts_v1_1020. All three child slots are occupied. P1/P2 coordinate observation_digest receipt contract; do not edit P2-owned managed_control.rs from P1. P2 durably persists crash recovery UNKNOWN with stable idempotency. P7 implements a digest-bound targeted per-path checkpoint recovery preview after later commits; restore remains disabled and destructive full reset remains refused.

Queued whole phases: P8 (prior owner exited; direct P1/P2 dependency), P4 (returned partial; dependent on P1 launch/IO/confinement), P3/P5/P6/P9. Reassign immediately when capacity opens, following critical path.

Hold and resources: user requires implementation source closure before tests/builds/typechecks/audits/probes/performance runs. No such validation ran. Git remains mixed (150 staged plus many unstaged/untracked files; no conflicts), branch main 12 ahead; do not stage/commit/push ambiguous work. One worktree; no pruning. C: via /mnt/c: 60 GB free, 87% used. No Cargo/Bun/test process active. V1 PARTIAL / NOT RELEASED.



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


### Active source review — Goal start and automation adapter

The accepted V1 decision is a separate authenticated `goal.start` after a persisted, complete,
profile-pinned PLANNED Run. P2 reports the TUI caller is in source; it does not grant Attempt or
effect authority. Parent review corrected P2 automation projection/status mismatches, and Core
`runNow` now returns typed CAPABILITY_UNAVAILABLE before any HostKernel RPC. P1 must preserve an
independent Rust-side refusal before scheduling or Guard dispatch. P1 continues serial ToolBatch
lease, Guard, managed admission and checkpoint routes while coordinating P7's bounded Rust
registry API. P1, P2 and P8 remain active whole-phase owners. No validation was run; current
source and all V1 acceptance remain unverified.


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


### Latest source-only status — 2026-10-19 21:17 UTC

The candidate-renewal chain is now explicit in normative owners: P8 returns an opaque durable
EXPIRED tombstone receipt with its own OwnerLog cursor/event digest, exact worker/ticket/Attempt,
pins digest, pool revision and proof/receipt digests; P2 persists the READY Task's generation
advance idempotently; P1 derives the next candidate only from persisted Task ID/generation.
P8 is adding Attempt uniqueness. The old candidate is never reused and this transition grants no
dispatch authority. Parent review found P1 has since made `UnixPeerIdentity` listener-only with
private fields and live PID/start/executable revalidation; explicit handshake/fence incarnation
documentation is being added. P1 also fixed a source-level partial-prefix cancellation check;
remaining phase work continues. **No tests, builds, typechecks, audits, provider probes or
benchmarks have run.** Three actual child slots are occupied by P1, P2 and P8. V1 remains PARTIAL /
NOT RELEASED. Current local Git counts are mixed and ownership-ambiguous; preserve them. C: via
`/mnt/c` last showed 59 GB free; there is one main worktree.
Candidate identity binds Task ID plus both durable Task counters: admission increments
`attempt_count`, and a verified pre-admission tombstone increments `candidate_generation`. P2's
proof/event/receipt CASes both values; P1 includes both in immutable admission pins and derives
the candidate from all three values. This prevents collision after a terminal admitted Attempt
is retried.
P2 now represents candidate tombstone disposition and terminal state with typed enums and
strict persisted-event decoding. P8 removed an invalid comparison between a worktree base
revision locator and measured workspace content revision; both remain distinct pinned facts and
are covered by §§21.11/37.22. No validation ran.
Candidate IDs bind both durable Task counters: admission increments `attempt_count`, while a
verified pre-admission tombstone increments `candidate_generation`. P2 now includes the expected
attempt count in its proof/event/receipt CAS; P1 includes both counters in immutable admission
pins and derives the ID from Task ID plus both counters. This closes collision after an admitted
Attempt is retried. P8 receipt identity/digests remain as above.


### 2026-10-19 — current whole-phase continuation

The latest user continuation note reiterates source-first comparison with local OpenCode/Codex, full subagent lifecycle review, full V1 delivery, implementation before validation, and updating all relevant Markdown. No new architecture decision is needed; existing §17 decisions remain authoritative.

P1/P2/P8 are active whole-phase owners. Candidate renewal is source-present: P8 recovers a durable `NotAdmittedNoDispatch` + `EXPIRED` tombstone receipt by candidate Attempt ID; P1's authenticated HostKernel route derives the ID from the live READY Task's `attempt_count` and `candidate_generation`, validates accepted SpecVersion/profile/SessionLink, registered Location/workspace, authenticated Core peer and ServerAuth, and no process binding, then passes the opaque receipt directly to P2. P2 independently recomputes identity and revision-fences the two-counter generation transition with exact delivery replay. Worktree base revision remains a locator distinct from measured workspace content revision.

This is source-reviewed only; no validation command ran. P1 managed admission/claim/consume and P2's production TaskTool dispatch remain dependent on P8 reservation/binding proof and P2 consume integration. P3/P4/P5/P6/P7/P9 and final integration/release remain open. V1 is PARTIAL / NOT RELEASED. Git remains mixed (150 staged / 238 unstaged / 173 untracked; no conflicts), one main worktree; C: via `/mnt/c` has 59 GB free. Preserve all work; no safe publication boundary is established.


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


### Resume checkpoint — root Session attachment on explicit goal.start

The root Run Session cannot be selected after start or attached in a post-start gap. `goal.start`
will take the active top-level Core Session ID; Core verifies the durable Session's authenticated
principal, project, workspace and Goal relationship. Rust atomically pins the Run SessionLink
with the explicit start event and fences changed retries. HostKernel registers the authenticated
P8 root coordinator before admission/scheduling; failure keeps execution unavailable. Start
still creates no Attempt/effect lease. P1 owns HostKernel/authenticated peer handling, P2 owns
managed reducer/API/Core/TUI, P8 owns durable root registration. Design is settled; source
integration is ongoing. No tests/builds/typechecks/audits/provider probes/benchmarks. V1 remains
PARTIAL / NOT RELEASED.

Resource sampling correction: P8's sampler is Attempt-scoped telemetry/backpressure, not admission
authority. ActiveWorkers uses durable Rust accounting bounded by pool/Spec. Do not sample before
admission or turn unknown optional telemetry into a denial. No public resource wire op before the
§12.16 schema; diagnostics stays unavailable.

P8 source checkpoint: intent-only worktree operations may recover for dispatch; a durable
`worktree_dispatch_started` marker recovers as UNKNOWN with no redispatch. Safe release requires
same-root clean pre-delete evidence plus post-delete MISSING and no dirty/user-owned changes.
Legacy receipts without pre-release evidence are history only. Remaining P8 work is still active;
no validation has run.

P1 confirmed the sampler cannot see sibling Run workers before an Attempt exists. Metrics remain
informational/backpressure only; unsupported required OS-enforced limits remain unavailable. No
sampling route is wired until an existing typed consumer/schema is present.

Worktree admission provenance gap: P8 found that raw public registration facts could create
eligible records without a Guarded Create receipt. P8 is replacing this with an opaque value
derived from the exact settled Guarded Create intent/receipt and HostKernel-resolved canonical
path/base locator; P1 wires its guarded route. New admission requires fresh no-follow clean,
owned, current evidence. Legacy registrations do not qualify. Implementation only.

Update: P8's opaque `VerifiedWorktreeRegistrationV1` now binds exact durable completed Create and
fresh Inspect receipts, owner, root generation, worktree/base/content revisions and canonical
path. Both receipts are rechecked; registration requires owned no-follow CLEAN state, zero dirty
entries and no user changes. Legacy registration events cannot qualify. P1 still must wire the
HostKernel lifecycle route; no validation run.

SessionLink source dependency: HostKernel authenticates Core process identity but has no Core
SessionStore/projector. It must not synthesize cursor or source metadata from the selected
`sessionID`. P2 supplies a private projection from the durable Core Session owner with principal,
Goal, project and workspace binding; HostKernel stamps its live owner epoch. Until that exists,
start stays unavailable and post-start SessionLink attachment is not an escape hatch.

Cursor digest: Core `EventV2.latestCursor` produces SHA-256, but Rust SessionLink requires the
actual BLAKE3 cursor from the existing `hc_session_receipts` projection. Never rehash the SHA-256
value to mimic BLAKE3. P2 must obtain the exact existing Rust SessionSupervisor cursor; otherwise
start remains unavailable.

P8 found that a safely deleted worktree could remain marked Free and be selected again. It is
adding a durable registration tombstone gated by clean pre-delete and MISSING post-delete proof;
the ID remains historical/non-reusable. P1 admission must select only current verified
registrations and fail closed on ambiguous removal/replay.

P1 found no HostKernel Guarded worktree Create/Inspect/Release route/journal/driver yet. Core
direct create/remove remains disabled. P1 owns the guarded HostKernel route and no-follow receipt
path; P8 owns durable registration/provenance/tombstone. Managed worktree admission remains
unavailable until both owner paths are wired.

P2 source update: Session creation now stores authenticated ServerAuth ownership in protected
internal metadata, and goal.start rejects a root Session whose owner differs from current auth.
HTTP metadata updates cannot alter owner/root markers. The goal.start response/SDK echoes
sessionID. Core store/instance/epoch guesses are not accepted as SessionLink facts; the actual
Rust SessionSupervisor BLAKE3 cursor/source projection remains required. No checks run.

Pre-Task worktree lifecycle/registration uses P8 `WorktreeRootOwnerV1` derived from authenticated
root coordinator proof for an already-started Run. It conveys root Session/workspace/Location/
principal/epoch lineage only. P1 still evaluates Guard; P8 attaches one verified registration to
one exact Attempt at admission to prevent writable sharing. Never fabricate Task/Attempt IDs or
treat the root proof as child/effect authority.


### Source correction — SessionLink and goal.start

`SessionSupervisor.sessionProjectionCursor(sessionID)` already returns the durable Rust projection
ACK checkpoint and exact BLAKE3 cursor; cursor acquisition is implemented. Remaining identity
fields are being wired from durable Core ownership: immutable database sourceStoreID, immutable
project-directory sourceInstanceID, and per-Session sourceEpoch (starts at 1 and changes only on
explicit lineage reset/replacement, not process restart). No path/time/process-epoch synthesis is
allowed. User confirmed explicit authenticated `goal.start` after accepted SpecVersion; it
atomically pins SessionLink and grants no Attempt/effect authority. P2 owns Core identities/start
projection, P1 owns HostKernel validation/pinning. P1's managed worktree lifecycle API is a private
authenticated control request routed through existing Guard/EffectIntent/lease/receipt/confined
ExecutionHost using catalog `git.worktree.acquire/list/release`; model ToolBatch and caller paths/
argv cannot select pool operations. Source only; no checks run.

P8 has specified the opaque `WorktreeLifecycleOperationPinV1` for P1: only P8 getters expose the
persisted operation ID/kind, root owner/ref, selected worktree ID, optional base locator, relative
path, expected workspace revision, intent cursor and epoch. Create targets a fixed path beneath
`.horizon/worktrees/<id>`; inspect/release targets are resolved from P8 registration/lease state.
The pin is not authority to execute. P1 must Guard and issue EffectIntent/one-use lease/receipt via
the confined ExecutionHost; P8 persists possible-dispatch before execution. Release requires clean
pre-delete + MISSING post-delete + no active lease and permanently tombstones the registration.
Possible-dispatch restart recovers UNKNOWN without redispatch. No checks run.

Core SessionLink `sourceDigest` is domain-separated SHA-256
(`horizoncode.session-link.source.v1\0`) over the ordered bounded projection fields specified in
§12.3, with each UTF-8 field prefixed by u64 big-endian length; null latest message/part refs encode
as empty fields, and transcript content is excluded. No checks run.

### Latest resume checkpoint — 2026-10-19 22:06 UTC

User confirmed explicit authenticated `goal.start` after accepted SpecVersion and complete persisted PLANNED Run. P1 has source for typed HostKernel SessionLink validation, authenticated Core-peer checks, epoch stamping and atomic start. P2 is adding authenticated P8 root registration after start; admission/scheduling must remain blocked until registration succeeds. Start grants no Attempt/effect authority.

Active whole-phase owners: P1 Guard/ExecutionHost, P2 managed vertical, P8 resources/workers/worktrees/RC0. P1 is implementing one global user-owned Core Config `git_executable` absolute path and private authenticated projection to the existing supervisor; HostKernel canonicalizes and hashes it, pins revision/digest, and rechecks before launch. Project/plugin config, ambient PATH and caller/model executable/path/argv are excluded. P8 has read-only pending-intent lookup, a possible-dispatch marker ordered after Guard/approval/one-use lease, replayable removal receipts and new regression fixture source. P2's production Rust-selected scheduler→TaskTool prompt path remains absent. P3/P4/P5/P6/P7/P9 and integrated acceptance/release are open. Implementation-first hold remains: no tests/builds/typechecks/audits/provider probes yet. Preserve mixed Git state; no stage/commit/push. One primary worktree; C: has 59 GB via `/mnt/c`. V1 remains PARTIAL / NOT RELEASED.

### Design correction — 2026-10-19 22:09 UTC

`goal.start` must not depend on optional Git configuration. Parent directed P2 to complete the explicit start and authenticated root-coordinator registration first, then register Git profile only on the managed worktree acquire path before dispatch. Missing Git profile continues to deny worktree effects and admission; it does not invalidate the effect-free start.

P1 must preserve `.git` read-only and, only if the OS backend can enforce it, permit a broker-only write exception for `.git/worktrees`; use fixed trusted argv and `--no-checkout`, and fail closed if nested enforcement is unsupported. P8 is adding a Create-receipt-derived Inspect target so first-time Create→Inspect→Register is possible without caller paths/IDs. No validation commands run.

P2 has corrected start ordering: Git-profile registration no longer runs during `goal.start`. Start pins SessionLink and registers the P8 root coordinator; a separate adapter registers the global user-configured Git executable before managed worktree acquire. P8 added a Create-pin/receipt-derived Inspect target with current root proof and clean/owned/no-follow evidence, while Release targets remain restricted to verified registrations. Parent also flagged Git worktree roots represented by `.git` gitfiles: the common Git directory must be resolved by trusted no-follow HostKernel inspection and independently confined, or worktree operations for that Location stay unavailable. Source only; no verification.

Pending worktree operation recovery ruling (22:12 UTC): intent-only Pending plus absence of the pre-invocation dispatch marker proves NotAdmittedNoDispatch. P8 will durably retire an exact old operation with an EXPIRED receipt only under fresh same-Goal/Run/root-Session/Location/workspace lineage proof. This receipt grants no execution and cannot mutate the tree. Replaying the old key returns the receipt; any later operation uses a new key and reruns Guard/approval. Epoch/root mismatch or ambiguity remains denied.

P2 has tightened root registration and retry checks: it compares the exact root execution identity, OwnerLog cursor/digest and pool revision, and its protected local root binding includes the accepted SpecVersion and SessionLink digest. Source only; unverified.

P2 follow-up: `goal.start` retry currently recomputes a moving Core cursor. Rust already projects the pinned Run SessionLink, but TypeScript `decodeGoalReviewSnapshot` drops it. Decode/use the exact pinned link for already-started Run recovery; compute fresh only before first PLANNED→RUNNING transition. This is required for a crash after Rust append but before Core root-binding metadata and for changed transcript cursor retries.

First-create sandbox path: P1 will, only after Guard/approval/lease and the durable P8 possible-dispatch marker, create exact missing `.git/worktrees` and `.horizon/worktrees` roots with descriptor-relative no-follow/no-clobber checks, then prepare the existing sandbox and launch fixed Git argv. Definite spawn absence needs an exact supervisor receipt; ambiguous mkdir/preflight/spawn is UNKNOWN and never auto-retried. Failure to enforce nested roots keeps the route unavailable.

P8 completed source for the pending no-dispatch tombstone and replayable EXPIRED receipt with same-lineage proof and same-key idempotency. It cannot mutate worktree state or revive the old operation. A source fixture was added but not run; P8 continues the whole phase across reservation/process receipts, owner-epoch fences and sampler recovery.

### 2026-10-19 22:15 UTC — resume source checkpoint

After context recovery, the parent re-read the controlling AGENTS/current-run/handoff/architecture/governance/operative-plan sources and Engram context. User-confirmed managed start contract remains: accepted SpecVersion → persisted PLANNED Run → authenticated `goal.start`; Rust pins the exact root SessionLink and grants no Attempt/effect authority. P2 now decodes the Rust-pinned link and reuses it on RUNNING replay; its snapshot-before-read temporal-dead-zone was corrected in source. P1 preserves that pinned owner epoch during replay and requires fresh authenticated root registration before scheduling resumes.

P8 added owner-epoch validation when replaying no-dispatch worktree retirement. Remaining whole-phase source work includes P8 reservation/process receipt and resource attribution/recovery; P1 HostKernel guarded worktree lifecycle routing and final pre-dispatch/OS-confinement paths; P2 production selected-Task→TaskTool prompt execution and independent reviewer/verifier/current-workspace evidence/control recovery. P3/P4/P5/P6/P7/P9 remain to be assigned as child slots free. No validation commands run. Preserve mixed Git state; never stage/commit/push ambiguous work. Disk check used `/mnt/c` (59 GB free); one primary worktree, no task-created worktrees to prune.

P8 additionally changed worker-resource sampling to consume fresh authenticated Core peer facts at sample time and derive the process identity there; a stale same-epoch identity token can no longer be reused. This is telemetry/backpressure, not admission authority or proof of OS resource quotas. No production route exists yet; P1 must supply fresh peer facts for each eventual call if an approved route is wired.

### Settlement/reconciliation seam (2026-10-19 22:19 UTC)

I ruled that P8 must not expose durable `SettleWorker` / `ReconcileRelease` producers accepting bare `WorkerSettlement` or `ReconciliationProof` booleans. The selected internal contract is in arch_V1 §17.24: opaque P1 HostKernel-minted proof binds exact P8 state/cursor/revision, managed Attempt/DelegationBinding, claim nonce, process generation/epoch and P2 terminal/effect evidence; P8 rechecks and appends; exact replay resolves a stable receipt. UNKNOWN, stale or ambiguous proofs retain quarantine/capacity. P8 is implementing the durable side and P1 the authenticated minting side; no tests/builds run.

Logical-worker settlement correction (2026-10-19 22:19 UTC): the V1 managed child is a Core child Session/Attempt in the existing Core process (§17.20), so it has no worker-specific PID to observe exiting. P1/P8 agreed not to assert `ownedProcessExited=true`. The revised §17.24 proof requires authenticated current Core/root owner identity, exact P8 cursor/revision/claim/Attempt binding, P2 terminal state and complete bound effect receipts, and P1 proof of quiescent prompt/callback scope, no active Attempt Guard leases and no owned command processes. Guarded workspace state governs reuse; UNKNOWN remains quarantined. Future process-backed workers have a separate exit contract. The plan records the superseding ruling and cost if wrong.

P1 source update (2026-10-19 22:19 UTC): exact HostKernel `goal.start` replay preserves the pinned SessionLink owner epoch; fresh start stamps current. Managed admission bounds expiry by profile, accepted Spec, persisted Run remainder and 24 hours. `register_git_profile` checks both ServerAuth and the authenticated Core peer; supervisor rehashes the configured Git binary immediately before spawn; EffectHost's broker path allows only the three Git worktree IDs as UserAction and verifier remains ManagedRun-only. P1 §14.20 records constrained first-create metadata-directory rules. Still no guarded worktree HostKernel route/driver or P1↔P8 settlement producer, and P2 still lacks the production Rust-selected TaskTool caller.

Settlement evidence is being aligned: P2 is adding a crate-private canonical Rust terminal-Attempt/effect-chain projection for P1; P1 independently checks authenticated Core identity, prompt/callback quiescence, no Attempt leases or owned command process, then mints P8 proof. V1 WorkerExecution is a logical child Session in shared Core, with no child PID/exit. No tests/builds run.

2026-10-19 22:20 UTC — Added the durable quiescence event contract to §17.24. A logical managed child has no own PID, so after `promptManaged` returns Core records the terminal outcome and calls private authenticated HostKernel completion. HostKernel checks the live Core peer, exact consumed handoff/child Session/Attempt, no Attempt callback/Guard lease/owned command, mints a one-use proof, and ManagedControl appends `managed_dispatch_quiesced` with exact cursor/digest. Retry can recover only the same marker; it cannot invoke the prompt again. Crash/ambiguous provider dispatch without the marker remains UNKNOWN and holds P8 capacity. P1/P2 are implementing; no tests/builds run.


### 2026-10-19 22:24 UTC — active proof interfaces and remaining phases

P1 added host-owned quiescence source bound to the P2 terminal projection: it checks the exact child identity/effect chain, rejects active Guard challenges or terminals, requires same-child process receipts to be Exited and valid, and fences authenticated Core identity before/after observation. P2's typed terminal snapshot now exposes durable prompt-quiescence receipt cursor plus distinct admission and observed workspace revisions; its durable coordinator/prompt path remains in progress. P8 still needs the opaque logical-child settlement consumer and receipt replay; it is replacing boolean `ownedProcessExited` settlement. Parent caught a Task-revision/workspace-digest cross-domain equality check and asked P8 to validate those pins separately. No validation has run.

Parent implemented the P5 source correction in `packages/opencode/src/tool/websearch-broker.ts`: 408/425 now enter the single bounded transient retry pass; 401/403/407 fall through to remaining explicitly enabled routes; 429 records cooldown/falls through without retry; other non-auth client errors stop. P5 production tool dispatch remains unavailable until P1 Guarded outbound transport and P6 SecretBroker/auth composition are connected. P3/P4/P5/P6/P7/P9 and cross-phase/release acceptance remain open. Preserve mixed Git state; no stage/commit/push. C: 59 GB free via `/mnt/c`; one primary worktree.


### 2026-10-19 22:30 UTC — P5 no-key provider chain expansion and source correction

Parent continued independent P5 work while whole-phase P1/P2/P8 owners remain active. Research against current provider primary pages found anonymous/no-key search support for Exa MCP, You.com `profile=free` (100 queries/day), Tavily MCP's explicit keyless search mode, Firecrawl Keyless (per-IP daily cap), and Parallel Search MCP (anonymous lower-rate mode). TinyFish Search is free but its documented API path requires account/API-key or OAuth, so it is not classified as part of the anonymous no-key default. Updated §37.5 and §16.7 accordingly and added source links/recheck caveat to §42.

Source-only P5 changes: Core config now recognizes `tavily_keyless` and `parallel_keyless`; the cascade's enabled default/order and route cap now include the five anonymous no-key routes; adapters expose those fixed endpoints/tools (including Tavily's fixed keyless headers); the TUI settings list represents both routes and keeps network dispatch unavailable pending Guard. The route parser now accepts common provider snippet fields, and tool-display labels cover both additions. Parent also fixed transient 408/425 classification earlier. P5 remains partial: no production Guarded transport/SecretBroker composition, native grounded-model route, broader BYO adapters/credential controls, route-event/provenance integration, or acceptance evidence is complete. Search remains fail-closed. No tests/builds/typechecks/audits/provider probes/performance runs were executed; Crawl4AI's browser binary was unavailable and Context7 quota was exhausted, so official primary-page web search/open was used as a fallback.

### 2026-10-20 04:40 UTC — owner restart and implementation queue

P1, P2 and P8 whole-phase owners have restarted in the three available child slots, each with exclusive source ownership. Early source findings: P2's main missing vertical is the managed scheduler → TaskTool → distinct Core child Session/prompt caller; P1 still lacks HostKernel wiring for the existing typed launch profile into its single confined supervisor; P8 is checking existing durable settlement/worktree code against the updated §17.24 proof contract. Explicit authenticated `goal.start` remains after accepted SpecVersion and grants no Attempt/effect authority. Child profile authority is Core Config's versioned `AgentProfileV2`, with lane-tagged delivery and effective-scope digest.

Next queued whole phases: P4/P5/P6/P7/P3/P9 as slots free, with dependent effects held behind P1 Guard and P2/P8 acceptance. P5 must address the legacy Core direct HttpClient search origin as well as finish the approved cascade, but remain unavailable until Guarded transport/SecretBroker composition is real. Source-first user hold remains in force. No validation commands run. Preserve mixed Git state; no stage/commit/push; no worktree pruning. C: 59 GB free via `/mnt/c`. V1 PARTIAL / NOT RELEASED.

### 2026-10-20 04:41 UTC — Task purpose and child lifecycle references

P2 identified a missing immutable Task title/purpose in Rust's scheduler projection. The parent decided to carry bounded title/purpose from the accepted Task/plan revision through HostKernel to Core; descriptive text grants no authority. P2 owns ManagedControl/Core Task projection and architecture updates; P1 owns HostKernel projection fields. P2 also found the Core child completion projection is not implemented; completion stays fail-closed until exact cursor plus BLAKE3 state digest are derived from durable Session receipts and agree with HostKernel.

Reference review used the actual Codex clone `repos/codex/codex-rs/core/src/agent/control` and multi-agent handlers, pinned OpenCode child `session`/`subagent-job`/restart flow, and OMP bounded executor/workpool. Adapt lifecycle and backpressure patterns only; direct Codex/OpenCode restart semantics cannot override Horizon's possible-dispatch/UNKNOWN no-replay contract. P8 reports durable settlement/worktree internals exist but still requires a full contract-to-source audit; P1 HostKernel ingress and P2 verified Task journey remain integration dependencies. No tests run.

### 2026-10-20 04:42 UTC — P8 source audit result; P5 dispatched

P8 source-complete audit (not phase acceptance): durable worker reservation, opaque logical-child settlement/reconciliation, worktree lifecycle/recovery, sampler attribution, UNKNOWN quarantine, and provisional-only RC0 reporting are present with no P8-owned source patch identified. Remaining P8 gates depend on P1 HostKernel worktree/sampler ingress and final Inspect receipt, P2 production Task child Session and verified terminal evidence, then authenticated RC0 measurements. P8 returns to the queue for those interfaces; source is NOT VERIFIED. Its slot is assigned to a whole-phase P5 implementation owner, including the legacy Core direct-search bypass. P1/P2/P5 are now active. No tests/builds/typechecks/audits/probes run.
