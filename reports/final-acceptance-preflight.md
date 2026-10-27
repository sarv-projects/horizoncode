# Final-acceptance preflight — executable state of `reports/FINAL-ACCEPTANCE.md` §0–§9

**Role:** read-only preflight auditor. Only this file is written.
**Revision:** `44f8b5f2a9978791a884b5507f2aada766c0ac88` (`main`, `origin/main` 0 left / 17 right → **17 ahead, 0 behind**).
**Window:** 2026-10-25 ~06:00–06:15 local (WSL2, Linux 6.18.54.1-microsoft-standard-WSL2, glibc 2.39, Python 3.12.3).
**Checklist source:** `reports/FINAL-ACCEPTANCE.md` §0–§9 (the parent-owned checklist; `arch_V1/46-V1-VERIFICATION-RUNBOOK.md` holds the per-phase **Phase 0–11** order and maps catalog IDs to commands, but no `§0–§9` block — see D11).
**Forbidden this pass (per task):** Cargo, package-wide typecheck, full package test suites, any provider call, any source write. Everything runnable inside that fence was run.
**Raw outputs:** `.tmp-preflight/*.out` (regenerable scratch; delete at cleanup).

**Labels used:** `RUN` (command + verbatim output below) · `SELF-REPORT` (a phase report claims it; no command run here) · `BLOCKED` (dependency) · `USER_DECISION` · `NOT_RUN` · `NOT_APPLICABLE`.

---

## 1. §0–§9 item map

**Totals: 46 checklist items → 7 `RUN` (1 of them FAIL) · 38 `BLOCKED` · 1 `USER_DECISION` · 0 `NOT_APPLICABLE`.**
Plus 8 supplementary offline commands run outside the 46 (§1.11).

### §0 Structural — 6/6 RUNNABLE, **5 PASS / 1 FAIL**

| # | Item | Label | Command | Verbatim result |
|---|---|---|---|---|
| 0.1 | Convergence → FAILURES 0 | **RUN — PASS** | `python3 scripts/architecture/validate_convergence.py` | `EXIT=0`<br>`SCHEMA_FILES 72`<br>`CATALOG_IDS 205 REGISTRY_IDS 230`<br>`CHECKS 1300 FAILURES 0` |
| 0.2 | Markdown → ACTIVE_BLOCKERS 0 | **RUN — PASS** | `python3 scripts/architecture/audit_markdown_repo.py` | `EXIT=0`<br>`TRACKED_MARKDOWN 293 LINES 85677 BYTES 8031454`<br>`ACTIVE_BLOCKERS 0 REFERENCE_WARNINGS 62` (all 62 `REFERENCE_ONLY`, all under `docs/architecture-archive/2026-10-11-pre-lean-consolidation/…`) |
| 0.3 | Bootstrap pinned source complete | **RUN — PASS** | `python3 scripts/architecture/bootstrap_source.py --check --require-complete` | `EXIT=0`<br>`PINNED_SOURCE_BOOTSTRAP existing=6629 missing=0 copied=0 mode=check` |
| 0.4 | Overlay Git visibility 0/0/0 | **RUN — FAIL** | `python3 scripts/architecture/audit_overlay_visibility.py` | `EXIT=1`<br>`Every changed root overlay file must be unignored explicitly.`<br>`OVERLAY_VISIBILITY compared=6627 changed=474 missing=0 symlink_delta=0 hidden_changed=13 hidden_new_source=2 stale_unignore=0`<br>13 × `HIDDEN_CHANGED`: `packages/sdk/js/src/v2/gen/client.gen.ts`, `…/gen/client/client.gen.ts`, `…/gen/client/index.ts`, `…/gen/client/types.gen.ts`, `…/gen/client/utils.gen.ts`, `…/gen/core/auth.gen.ts`, `…/gen/core/bodySerializer.gen.ts`, `…/gen/core/params.gen.ts`, `…/gen/core/pathSerializer.gen.ts`, `…/gen/core/queryKeySerializer.gen.ts`, `…/gen/core/serverSentEvents.gen.ts`, `…/gen/core/types.gen.ts`, `…/gen/core/utils.gen.ts`<br>2 × `HIDDEN_NEW_SOURCE`: `packages/sdk/js/openapi.json`, `scripts/eval/blake3.py` |
| 0.5 | Workspace packages | **RUN — PASS** | `python3 scripts/architecture/audit_workspace_packages.py` | `EXIT=0`<br>`WORKSPACE_PACKAGE_AUDIT workspaces=36 unique_names=36 undeclared=0 with_typecheck=30 with_test_script=15 errors=0` |
| 0.6 | External source provenance | **RUN — PASS** | `python3 scripts/architecture/validate_external_sources.py` | `EXIT=0`<br>`SOURCE_PROVENANCE_CHECKS 439 FAILURES 0` |

**0.4 diagnosis (facts, not a decision):** the 15 flagged paths are live-agent output, all mtime 05:36–06:03 today — `packages/sdk/js/src/v2/gen/**` (13, untracked + ignored; `sdk.gen.ts` itself is tracked-and-modified so it is *not* in the hidden list), `packages/sdk/js/openapi.json`, `scripts/eval/blake3.py` (`scripts/eval/` is a tracked first-party dir: `README.md`, `eval_harness.py`, `test_eval_harness.py`). The 4 contested `tsconfig.p7*`/`agent-node-deps` files recorded in `P9.md` §24.7 are **no longer flagged**. A4 therefore needs a fresh ownership pass (expose exact paths or have owners delete scratch) — see D1.

**Provenance warning for 0.4:** this reading was taken at **05:54:54**, i.e. **before** `scripts/architecture/audit_overlay_visibility.py`, its test, and `.gitignore` were edited at **06:05:22** (see D13), and the gate was still changing during the preflight window. Two post-restart re-run attempts were interrupted by server restarts; a third attempt at 07:00 hit a **60 s timeout (`EXIT=124`)** — the scan cost has grown with the tree. A background re-run was launched (`nohup … > .tmp-preflight/overlay-2.out`); treat the A4 verdict as **must-re-measure**, not as a settled number.

### §1 Build / typecheck — 0/4 runnable (Cargo + TS slot forbidden)

| # | Item | Label | Dependency |
|---|---|---|---|
| 1.1 | `cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor --bin hz-kernel` | **BLOCKED** | sole Cargo slot (currently owned by a phase agent); task forbids Cargo |
| 1.2 | `cargo test --locked --manifest-path kernel/Cargo.toml` | **BLOCKED** | same + B2 in `LEDGER.md` (last recorded full wave **failed, EXIT 101**: lib 477 pass/7 fail — `reports/audit-v1-release-requirements.md` §1(b) row B2) |
| 1.3 | `bun run horizoncode:typecheck` (A1) | **BLOCKED** | single TS slot; owners still editing. Last recorded **Run C = 25 diagnostics / 2 packages** (`LEDGER.md` A1 row: `core` 4, `opencode` 21) |
| 1.4 | `bun turbo typecheck --concurrency=1` | **BLOCKED** | depends on 1.3 reaching 0; not run at any revision |

### §2 Guard / effect security — 0/6 runnable; prior evidence `SELF-REPORT`

| # | Item | Label | Existing evidence (not re-run here) |
|---|---|---|---|
| 2.1 | ToolBatch denied before lease; lease reuse/widen denied | **BLOCKED** → **SELF-REPORT** | `P1.md` §5 (line 119) + line 2797: `cargo test --test tool_batch_guard_matrix` = **3 passed; 6 failed**, every failure `capability_unavailable` (readiness-false denials, gates intentionally `false`) |
| 2.2 | Cancel mid-effect → UNKNOWN → no blind retry | **BLOCKED** → **SELF-REPORT** | `P1.md` `effects_host_process` **10/10** (HANDOFF "P1 Rust acceptance continuation — 2026-10-24", lines 102–115); `P2.md` continuation 30 |
| 2.3 | Plugin/MCP/hosted/legacy origins cannot bypass Guard | **BLOCKED** → **SELF-REPORT** | finish-list C16–C18 = `PARTIAL` (`implementationtov1release.md` line ~866): "universal origin closure and the complete zero-spawn matrix are not proven" |
| 2.4 | Workspace profile wrong digest / out-of-grant argv denied | **BLOCKED** → **SELF-REPORT** | `workspace_command_profile.rs` tests cited in `P1.md` §2; **not run this pass** |
| 2.5 | Read fast path validates per-call, never admits mutation | **BLOCKED** → **SELF-REPORT** | `prepare_tool_batch_read` review noted in `LEDGER.md` line 13 ("strict fields, 1..8, `files.read` only… still runtime-unreachable in production because the entrypoint never sets `effects_enabled`") |
| 2.6 | Kernel push-gate tests: managed_control, resource_budget, tool-batch, hosted-tools, prompt Guard | **BLOCKED** | these are *inside* `scripts/architecture/run_push_gate.sh` (lines 21–38) → requires Cargo + Bun; A2 open |

### §3 Managed lane — 0/5 runnable; prior evidence `SELF-REPORT`

| # | Item | Label | Existing evidence |
|---|---|---|---|
| 3.1 | No managed dispatch without live Attempt | **BLOCKED** → **SELF-REPORT** | `P2.md` continuation 30: `bun test test/session/managed-control.test.ts` **41 pass / 0 fail / 225 expect()**; live-instance rejection of `schemaVersion 2` (D-row, `implementationtov1release.md` line ~871: 49 pass/243 assertions) |
| 3.2 | Direct lane gains no managed receipts | **BLOCKED** → **SELF-REPORT** | `P5.md` receiptKind wire parity (LEDGER line 358) — **SELF-REPORT** |
| 3.3 | Single Task → verifier PASS → aggregate settlement | **BLOCKED** → **SELF-REPORT (negative only)** | verifier route is **fail-closed `capability_unavailable`**, `TRUSTED_VERIFIER_ADAPTER_AVAILABLE=false`; multi-Task unavailable under `DEC-V1-31` |
| 3.4 | Restart/pause/cancel/UNKNOWN recovery, no replay | **BLOCKED** → **SELF-REPORT** | `P2.md` continuations 26/30 (`host_run` lib **12/0**, `task_dag` **17/0**, `direct_attempt_rpc` **10/0**); integrated restart/UNKNOWN journey **NOT_RUN** |
| 3.5 | CodeMode prepare/settle/wave receipts/cancel; no caller lease | **BLOCKED** → **SELF-REPORT** | `P1.md` §36 test-only `codemode_wave_reader_fence_tests` ×4 added; `LEDGER.md` line 12 ("visibility only… no production line edited") |

### §4 Context / RepoIntel — 0/5 runnable; prior evidence `SELF-REPORT`

| # | Item | Label | Existing evidence |
|---|---|---|---|
| 4.1 | ContextSelection/ledger digest binds selection; no raw prompt leak | **BLOCKED** → **SELF-REPORT** | `LEDGER.md` line 64: P3 **61/61 Core**, adapters **80/0/1 todo**, schema **29/29** |
| 4.2 | Stale generation → typed STALE; bounded pages; read-scope mismatch denied | **BLOCKED** → **SELF-REPORT** | `P3.md` forged-scope / stale-search-write boundary tests (cited in HANDOFF line 1488) — pending serialized Bun slot |
| 4.3 | §30.26 cache-anchor vs minimize-tokens; CX-014–021 | **BLOCKED** | provider-backed (`CX-021` canary matrix needs 4 providers) → also **provider-forbidden** this pass |
| 4.4 | Instruction resolver CX-022–025 / INST-001–008 | **BLOCKED** → **SELF-REPORT** | `P3.md` §9 `instruction-context` included in the green 8-file set (58/58) |
| 4.5 | Repo tools gated until P1+P3 acceptance | **BLOCKED now / RUNNABLE at final pass** | gate is `OPENCODE_EXPERIMENTAL_REPO_TOOLS` + fail-closed backend (HANDOFF line 1106); asserted by `repo-tools` **14/0/66** (`LEDGER.md` line 22) — **SELF-REPORT**. Re-verify at final pass: `cd packages/opencode && bun test test/tool/repo-tools.test.ts` |

### §5 Providers / Doctor / settings — 0/4 runnable; prior evidence `SELF-REPORT`

| # | Item | Label | Existing evidence |
|---|---|---|---|
| 5.1 | No hidden provider/model switch on 429; no paid fallback | **BLOCKED** | needs live route → **provider-forbidden** |
| 5.2 | Doctor full tier requires consent; offline catalog freshness UNKNOWN | **BLOCKED** → **SELF-REPORT** | `LEDGER.md` "P6 ModelsDev/Doctor handoff": OpenCode Doctor/API/direct-route/credential-cost **28/28**; `P6.md` consent-refusal matrix in §5.1 (`REFUSED PAID_ROUTE_CONNECTED: nvidia`, 5-refusal matrix) |
| 5.3 | Credential lease exact match; zeroization; no secret in logs | **BLOCKED** | SecretBroker/OS keyring unavailable (`DEC-V1-06` engineering-open) |
| 5.4 | Feature exposure counts match real capability status | **BLOCKED** (structural proxy **RUN**: convergence 1300/0 incl. 230 registry IDs) | `feature-exposure.test.ts` is a `run_full_gate.sh` step (line 14) — not run here |

### §6 TUI / artifacts / recovery — 0/4 runnable; prior evidence `SELF-REPORT`

| # | Item | Label | Existing evidence |
|---|---|---|---|
| 6.1 | Streaming lanes stable; scroll anchor; 10k load; keyboard-only approval | **BLOCKED** | `HANDOFF.md`: TUI stream/context/artifact/analytics **56/56**, activity-card **9/0**; `P7.md` Continuation 3 (`prompt.test.ts` 1 → 24 pass) — **SELF-REPORT** |
| 6.2 | Artifact FULL/SAMPLE/FAILED fidelity; safe SVG/Mermaid; RAM budgets | **BLOCKED** → **SELF-REPORT** | ArtifactStore **48/48**, `CP-001/002` **7/7** (implementationtov1release I3–I9 row) — end-to-end truth **open** |
| 6.3 | Checkpoint/rewind restore or explicit UNKNOWN | **BLOCKED** | `DEC-V1-25` open: `CP-001/CP-002` must pass **on the exact revision** |
| 6.4 | Kill CLI mid-stream → restart → no duplicate messages | **BLOCKED** on a built CLI + runtime — the two cited bring-up defects are **RESOLVED** | the `Service not found` defects that blocked B4 are fixed in the current tree: `@opencode/v2/Plugin` at `packages/opencode/src/agent/agent.ts:233-235` (`Effect.serviceOption(PluginV2.Service)`/`(Reference.Service)` → `Option.isNone → []` fail-closed, in the `Agent.state` initializer `agent.ts:214-238` under `InstanceState.make(...)` `requireServicesAt:"lookup"`) and `@horizoncode/WebSearchRuntime` at `packages/opencode/src/server/routes/instance/httpapi/server.ts:280` (app LayerNode group; rationale :273-279); green: `task.test.ts` **19 pass/0 fail** (was 6 pass/12 fail with 14 Plugin hits), `agent-node-deps.test.ts` **2/0**, `app-layer-serve` + `instance-state` **6/0**, `test/server/httpapi-listen.test.ts` **11/0** (incl. `Server.Default()` + real-route-tree websearch), `bun run script/httpapi-exercise.ts --mode effect --include global.` **pass=6 fail=0 skip=0**, §9 `RESULT: PASS -- all 10 planned steps executed green` (`.tmp/final-verify/20261027-104213/summary.txt`), `.tmp/e2e/logs/**` grep = **ZERO `Service not found`**; remaining: the kill→restart run itself on a built CLI |

### §7 Resources / worktrees — 0/4 runnable; prior evidence `SELF-REPORT`

| # | Item | Label | Existing evidence |
|---|---|---|---|
| 7.1 | Reservation states exact; impersonation/stale-owner negatives | **BLOCKED** → **SELF-REPORT** | `LEDGER.md` line 23: `JC-RES-012.I` TS consumer **9/0, 89 exp**, `packages/core` tsgo 0; **C–J Rust NOT RUN**; **K/L authenticated ingress negatives still missing** |
| 7.2 | Worktree lease conflict and recovery | **BLOCKED** → **SELF-REPORT** | `worktree_pool.rs` **30/30** (model only, no filesystem worktrees) |
| 7.3 | Pressure ladder with measured evidence; no unclaimed OS hard quotas | **BLOCKED** | OS hard quotas `UNSUPPORTED` (fail-closed, correct); ladder not measured |
| 7.4 | RC0 1/5/10/20 sessions raw evidence | **NOT_RUN** | `LEDGER.md` line 23: RC0 suite **109/109**, evaluator **43/43**, but `TRUSTED_ATTESTATION_SOURCES`/verifier registry **empty → NOT_ATTESTED / NOT_BASELINE**; no exporter exists |

### §8 Real journeys — 0/5 runnable

| # | Item | Label | State |
|---|---|---|---|
| 8.1 | Direct coding journey (provider pinned, edit, test, no bypass) | **BLOCKED** | `LEDGER.md` remaining-work: "**Real journeys/Guard negatives/recovery: not started**" — still true, the journey itself has not been run; the former B4 bring-up blocker is **RESOLVED**: AppRuntime `@opencode/v2/Plugin` fixed at `packages/opencode/src/agent/agent.ts:233-235` (`Effect.serviceOption` → `Option.isNone → []` fail-closed, in the `Agent.state` initializer `agent.ts:214-238`); §9 TS batch PASS at `.tmp/final-verify/20261027-104213/summary.txt` and `.tmp/e2e/logs/**` grep = zero `Service not found`; remaining to close this row: a built CLI + the journey run itself |
| 8.2 | Managed journey (goal propose → accept → task → verifier PASS) | **BLOCKED** | verifier fail-closed (`DEC-V1-31`, D-row) |
| 8.3 | Context pressure (large log → trim/compact → continue) | **BLOCKED** | needs a running session |
| 8.4 | Reconnect/restart | **BLOCKED** | needs a running CLI |
| 8.5 | Linux/WSL clean install of `horizoncode`/`hzcode` + upgrade/rollback | **BLOCKED** | `release_gate.py` install matrix = `NOT_RUN` — "no candidate product binary was supplied"; additionally gated on the §9 license decision |

### §9 Release — 1 RUN / 1 USER_DECISION / 1 BLOCKED

| # | Item | Label | Command / state | Verbatim result |
|---|---|---|---|---|
| 9.1 | `implementationtov1release.md` checklist reconciled | **RUN — DONE (13 defects recorded)** | documentation consistency pass over `HANDOFF.md`, `reports/phases/*.md`, `implementationtov1release.md`, `arch_V1/*` | see §4 (D1–D13) — headline **consistent**, evidence rows **drifting** |
| 9.2 | License/notices/provenance; signing/update truth; platform support truth | **USER_DECISION** | `DEC-V1-11` (license grant + root LICENSE/NOTICE), `DEC-V1-12` (signing/update), `DEC-V1-09` (retention/legal-hold), `DEC-V1-13` (installer owner) | facts ready: `P9.md` §24.6 (line 1572); this pass reconfirmed root `UNLICENSED`, root LICENSE byte-identical to upstream, NOTICE absent via 15 distribution blockers |
| 9.3 | Exact task-owned staged paths only; commit/push after verified diff | **BLOCKED** | A1/A2/A4 + phase ownership resolution first | `staged=0` (both samples), `conflicts=0`, 17 unpushed commits predate this wave; dirty-tree counts live in the Git snapshot row of §1.11 |

### 1.11 Supplementary offline commands actually run (outside the 46)

| Command | Label | Verbatim result |
|---|---|---|
| `python3 -m unittest scripts/release.test_release_readiness -v` | **RUN — PASS** | `EXIT=0` … `Ran 82 tests in 94.860s` / `OK` (incl. `SyntheticTuiShutdownWindowTests` 3/3 ok). Direct invocation `python3 scripts/release/test_release_readiness.py` **fails** `ModuleNotFoundError: No module named 'scripts'` — module form is canonical (`.github/workflows/horizoncode-*.yml` use `python3 -m unittest scripts.release.test_release_readiness`) |
| `bash -n install` | **RUN — PASS** | `EXIT=0` |
| `python3 -m py_compile scripts/release/*.py` | **RUN — PASS** | `EXIT=0` |
| `python3 scripts/release/audit_distribution.py` | **RUN — PASS(0) / content BLOCKED** | `EXIT=0`; `artifact.status: BLOCKED`, `distribution_license.status: BLOCKED`, `source.status: DIRTY` (`clean: false`), **blockers list length 15** (root `UNLICENSED`; root LICENSE byte-identical to upstream; no first-party distribution license; `packages/opencode` private; missing legal files; missing candidate inventory/provenance/source-state SHA-256/candidate-binary SHA-256; Nix `MIT` contradiction; no LICENSE/COPYING; no NOTICE/PATENTS) |
| `python3 scripts/release/release_gate.py` | **RUN — FAIL by design** | `EXIT=1`; `status: BLOCKED`; **20 blockers**; `install_matrix.status=NOT_RUN` ("no candidate product binary was supplied"); `signing_update.status=UNAVAILABLE`; `publication_performed=false`; `signature_created=false`; `source.status=DIRTY`; platform: native Linux/WSL2 `NOT_VERIFIED`, native Windows `UNAVAILABLE`, macOS `OUT_OF_SCOPE` |
| `bash -n scripts/architecture/run_push_gate.sh scripts/architecture/run_full_gate.sh` | **RUN — PASS** | `syntax OK` / `syntax OK` |
| `python3 -m py_compile scripts/architecture/*.py` | **RUN — PASS** | `EXIT=0` |
| `git diff --check` (unstaged) | **RUN — FAIL** | `EXIT=2`, **235 × `trailing whitespace`**, all in `packages/sdk/js/src/v2/gen/sdk.gen.ts` (regenerated 05:36 today). `git diff --cached --check` → `EXIT=0` (nothing staged). **This is step 1 of `run_push_gate.sh` → A2 would fail right now on this file.** |
| Git snapshot (**live, drifting — measured twice**) | **RUN** | `HEAD 44f8b5f2a9978791a884b5507f2aada766c0ac88`, branch `main`, ahead 17 / behind 0 vs `origin/main`; `conflicts=0`; `staged=0` at both samples. **06:0x:** modified/deleted 318, untracked 167. **06:14:** modified/deleted **320** (316 `M` + 4 `D`), untracked **211** (133 `??` porcelain entries, dirs collapsed). Active phase agents are writing continuously — these counts must be re-measured at the final run (see D7) |
| Side effects of this preflight (disclosed) | **NOT_RUN (none destructive)** | Only `reports/final-acceptance-preflight.md` was written plus regenerable scratch `.tmp-preflight/*.out`. `python3 -m py_compile` refreshed `scripts/release/__pycache__` and `scripts/architecture/__pycache__/*.pyc` (generated bytecode caches). No source, config, `.gitignore`, Git index, worktree, process, or provider was touched. Two attempted gate re-runs were lost to server restarts (06:19, ~06:5x) and one timed out at 60 s (07:00) — recorded, not hidden |

---

## 2. Items already satisfied by existing evidence (no command re-run this pass)

All are `SELF-REPORT` until the parent re-runs them on the exact final revision; each row names the *claiming* section so the parent can audit it.

| § item | Claimed-satisfied by | Exact citation |
|---|---|---|
| 0.1, 0.2 (also 0.3, 0.5, 0.6) | **RUN green this pass** | §1 table above |
| 2.1–2.6 (partial) | `reports/phases/P1.md` §5, lines 2235/2247/2797; `HANDOFF.md` lines 102–115 | `effects_host_process 10/10`, `effect_host_principal 11/11`, lib `guard/effect_host/cgroup_v2/terminal_process 79/79`, `direct_attempt_rpc 10/10`; `tool_batch_guard_matrix` 3/9 = intentional denials |
| 3.1, 3.4 | `reports/phases/P2.md` continuation 30 "Exact commands and results" (line 117) | `managed-control 41/0 (225 exp)`, `host_run` lib **12/0**, `task_dag 17/0`, `direct_attempt_rpc 10/0`, `task.test.ts 19/0`, `migration.ts --check` exit 0 |
| 3.x (HostRun route) | `reports/phases/LEDGER.md` lines 106–115 (**parent-observed**, not child claim) | `kernel/tmp-p2/host-run-compile.log` → `10 passed; 0 failed` incl. 3 reconcile negatives — explicitly **not** B2 completion |
| 4.1, 4.4 | `reports/phases/LEDGER.md` line 64 + `P3.md` §12/§13 | P3 **61/61 Core**, adapters **80/0/1**, schema **29/29**; CTX-006/007 rows made executable |
| 5.2 | `LEDGER.md` "P6 ModelsDev/Doctor handoff" + `P6.md` §5.1 | offline Doctor **28/28**, consent-refusal matrix, `--check` `PRECONDITIONS_OK` |
| 6.1, 6.2 | `HANDOFF.md` P7 rows + `P7.md` Continuation 3 (line 364) | TUI **56/56**, activity **9/0**, ArtifactStore **48/48**, `CP-001/002 7/7` |
| 7.1 (TS half) | `LEDGER.md` line 23 | `JC-RES-012.I` **9/0, 89 exp**; RC0 **109/109**; evaluator **43/43** |
| 9.1 | this preflight | reconciliation performed; defects D1–D13 in §4 |
| 9.2 (facts only) | `reports/phases/P9.md` §24.6 (line 1572) + this pass's `audit_distribution.py`/`release_gate.py` | license inventory + 15/20 blocker lists identical in substance |
| Runbook Phase 0 | `arch_V1/46-V1-DESIGN-AUDIT.md` §"Automated structural audit" | **recorded values are stale**: doc says 1299 checks / 285 files; live is 1300 / 293 (doc itself says "re-run before release") |

**Nothing in §2–§8 may be promoted above `SELF-REPORT`**: no phase is `VERIFIED` (`LEDGER.md` line 79: "No phase is VERIFIED and V1 is NOT RELEASED"; all nine `P1`–`P9` reports end `PHASE_PARTIAL / NOT VERIFIED / NOT RELEASED`; the single `PHASE_VERIFIED` string in `P1.md:580` is a negation — "No `PHASE_VERIFIED` claim").

---

## 3. Residual gap list (after everything currently runnable has run), dependency-ordered

1. **A4 overlay visibility → 0/0/0** — currently **exit 1** (13 hidden changed + 2 hidden new source, live-agent SDK/eval output). Owner resolution needed: expose exact first-party paths or remove scratch. *Blocks A2 (push gate step 4).*
2. **`git diff --check` → 0** — 235 trailing-whitespace errors in tracked `packages/sdk/js/src/v2/gen/sdk.gen.ts`. *Blocks A2 (push gate step 1).* Owner of the SDK generator must fix or de-track/regenerate.
3. **A1 typecheck → 0** (`bun run horizoncode:typecheck`, then `bun turbo typecheck --concurrency=1`) — last known 25 diagnostics / 2 packages + 2 non-diagnostic findings (`agent-profile-v2.test.ts:92` strict contract; `tool.task` dispatch rows). *Blocks 1.2, 1.4, B2/B3/B4, A2, candidate build.*
4. **RESOLVED — both production bring-up defects are fixed in the current tree (row kept for ID continuity; no longer a residual gap)** (was open as: (a) `Service not found: @opencode/v2/Plugin` on the cold `AppRuntime` path — `LEDGER.md` line 22, fix narrowed to `agent.ts` references branch, with a claimed "**2 remaining root causes P2-owned: missing `direct_subagent_inbox`/`managed_subagent_inbox` tables + `expectedRevision`**"; that root-cause claim is superseded — the actual root gap was the `Agent.state` initializer (`agent.ts:214-238`) running under `InstanceState.make(...)` `requireServicesAt:"lookup"`; (b) `opencode serve` → `Service not found: @horizoncode/WebSearchRuntime`). Fixes: (a) `packages/opencode/src/agent/agent.ts:233-235` — `Effect.serviceOption(PluginV2.Service)`/`Effect.serviceOption(Reference.Service)` with `Option.isNone → []` (fail-closed) in the `Agent.state` initializer (`agent.ts:214-238`); (b) `packages/opencode/src/server/routes/instance/httpapi/server.ts:280` — `WebSearchRuntime.node` in the app LayerNode group (rationale :273-279). Evidence: `task.test.ts` **19 pass/0 fail** (was 6 pass/12 fail with 14 Plugin hits), `test/agent/agent-node-deps.test.ts` **2/0**, `test/effect/app-layer-serve.test.ts` + `instance-state.test.ts` **6/0**, `test/server/httpapi-listen.test.ts` **11/0** (incl. `Server.Default()` + real-route-tree websearch), `bun run script/httpapi-exercise.ts --mode effect --include global.` **pass=6 fail=0 skip=0**, §9 TS batch `RESULT: PASS -- all 10 planned steps executed green` (`.tmp/final-verify/20261027-104213/summary.txt`), `.tmp/e2e/logs/**` grep = **ZERO `Service not found`**. *No longer blocks §8.1/8.3/8.4, B4, B5, or most integrated suites; those rows' remaining blockers are tracked in items 5-8, 9, 11.*
5. **Cargo acceptance (B2)** — full `cargo test` lib + all targets from a green compile; last combined wave EXIT 101 (477 pass / 7 fail). *Blocks B3.*
6. **B3 Guard no-bypass + crash/cancel/`UNKNOWN` matrix** across every enabled origin on a built kernel (§32.14/19/20) + `DEC-V1-03` containment/denial evidence + **C25 adversarial matrix (NOT STARTED)**. *Blocks §2, §8.2.*
7. **P2 HostRun binding → route → terminal event**, then P1 typed projection, then P8 append/resolve consumption ("no phase has yet implemented or verified this chain", `LEDGER.md` lines 28–36). *Blocks single-managed-vertical D1–D11, `DEC-V1-31` DAG, B6/RC0, worker fan-out.*
8. **§3–§7 suite runs on the settled tree** — every family in `46-V1-VERIFICATION-RUNBOOK.md` Phases 1–9 (schema/core/opencode/tui/kernel + §32.10/13/14/16/19/20/31/32/43/45/48 rows), one heavy job at a time.
9. **B5 one real free-model E2E turn** (`free-model-smoke.ts --check` → live) — currently **NOT_RUN, 0 provider requests**; item 4 (the two bring-up defects) is **RESOLVED** and no longer blocks it — remaining blockers: parent authorization + the separate session-supervisor bring-up failure recorded in the B5 row of `reports/audit-v1-release-requirements.md`. *§5, §8.*
10. **B6/RC0** — populate `TRUSTED_ATTESTATION_SOURCES` + verifier registry, then repeated real 1/5/10/20-session baselines into `docs/performance/evidence/`, then budgets/ratchet (RC0.5 → RC0.6). *§7.4.*
11. **§8 journeys** (direct coding, managed, context pressure, reconnect) + `UI-017` no-duplicate-messages proof. *Depends on 5, 6, 7 (item 4 RESOLVED — its bring-up defects are fixed, no longer a dependency).*
12. **Candidate build → K5 clean install/upgrade/rollback on native Linux + WSL2** with a genuine previous binary, then `audit_distribution.py` / `release_gate.py` against **the exact candidate** until blockers → 0 (K6). *Depends on 13 (legal) and 3–11.*
13. **USER DECISIONS (parallel, no engineering dependency):** `DEC-V1-11` license grant + root LICENSE/NOTICE, `DEC-V1-12` signing/update (or explicit "stay disabled"), `DEC-V1-09` retention/legal-hold, `DEC-V1-13` installer owner. *Blocks 12 permanently until settled.*
14. **Identity stage-2** (`NAME-001..004` on the exact candidate; stale `sdk-next` workspace link needs an install with `@noble/hashes@2.2.0` resolvable). *§10.12 V1 exit.*
15. **§32.24 release-minimum rest** — false-completion rate measured + threshold approved; checkpoint-protects-user-commits; performance budgets incl. control-plane stage budgets; reproducibility from fixture revision + config + model metadata.
16. **A2 push gate → S3 full gate → A3 exact-scope stage/commit/push**, then structural gates re-run on the published revision.

---

## 4. Inconsistencies found between status documents (recorded, not resolved)

| ID | Defect | Sources | Notes |
|---|---|---|---|
| **D1** | **A4 overlay state: four different claims.** (a) `HANDOFF.md` lines 141/476/1035/1402 and `implementationtov1release.md` A4 row (line 864) present `hidden_changed=0 / hidden_new_source=0 / stale_unignore=0` as current; (b) `P9.md` line 1669 (latest) reports **exit 1 with 4 `HIDDEN_NEW_SOURCE`** (`tsconfig.p7typefix.json`, `tsconfig.p7-rows6.json`, `tsconfig.p7typefix.json`, `agent-node-deps.test.ts`); (c) `LEDGER.md` line 26 reports `hidden_changed 0 / hidden_new_source 0`; (d) **this preflight RUN: exit 1, `hidden_changed=13`, `hidden_new_source=2`** with an entirely different file set (SDK gen + `openapi.json` + `scripts/eval/blake3.py`) — the 4 P9 files are no longer flagged (see D13 for why) | `HANDOFF.md` / `implementationtov1release.md` A4 / `P9.md` §24.7 / `LEDGER.md` / live | Do not pick a side: A4 must be re-run by the parent after the SDK/eval writers settle |
| **D2** | **Release-gate blocker count: 20 vs 18.** Live `release_gate.py` = **20 blockers** (matches `HANDOFF.md` line 5506 and `P9.md` §24.7 line 1666), but `implementationtov1release.md` finish-list **K6** (line 875) still says "`BLOCKED` with **18 blockers**", `HANDOFF.md` line 1106 says 18, `LEDGER.md` lines 343/346 say 18 | `implementationtov1release.md` K6 / `HANDOFF.md` / `LEDGER.md` | K6 row is stale as *current evidence* |
| **D3** | **Distribution-audit blocker count: 15 vs 18 vs 14.** Live = **15** (`P9.md` §24.7 line 1665 agrees); `P9.md` line 111 says 18; `LEDGER.md` line 343 says 14; `HANDOFF.md` line 352 says 14 | `P9.md` §5 vs §24.7; `LEDGER.md`; `HANDOFF.md` | dated rows presented without dates in table form |
| **D4** | **Release-readiness count drift: 82 vs 81 vs 79 vs 46.** Live = **82/82** (`HANDOFF.md` line 5506 and `P9.md` line 1675 agree); `HANDOFF.md` line 27 says 79/79, line 352 says 81/81, line 1085 says "Prior readiness 46/46"; `implementationtov1release.md` P9 row (line 783) presents **46/46** as current evidence; most `P9.md` rows say 79/79 | `HANDOFF.md` ×4 / `implementationtov1release.md` P9 / `P9.md` | latest row matches live; older rows are unlabeled history |
| **D5** | **Stale K5 row:** `implementationtov1release.md` K5 evidence says "parent rerun found one **TUI-start smoke failure** in that synthetic suite, now under investigation" — the live suite passes **82/82 including all 3 `SyntheticTuiShutdownWindowTests`** | `implementationtov1release.md` K5 vs live RUN | either repaired or mis-stated; owner must confirm before citing K5 |
| **D6** | **Commit-ahead count: 12 vs 17.** `implementationtov1release.md` A3 row says "Local `main` remains **12** commits ahead"; measured = **17 ahead, 0 behind** (also stated in `HANDOFF.md` line 70 and `LEDGER.md` line 38) | `implementationtov1release.md` A3 vs live | stale row |
| **D7** | **Dirty-tree counts drift (three values inside 15 minutes):** `HANDOFF.md` lines 70–71 and `LEDGER.md` lines 40/54 say **302 modified/deleted + 115 untracked**; live preflight measured **318 + 167** at 06:0x and **320 + 211** at 06:14 (`LEDGER.md` itself warns "This count has grown since older tracker snapshots") | `HANDOFF.md` / `LEDGER.md` vs live RUN ×2 | refresh at final run; ownership must not be inferred from filenames |
| **D8** | **Provider Doctor workstream:** `implementationtov1release.md` workstream row = **`NOT STARTED`**, "No Doctor code exists upstream; adapt provider/catalog substrate only" — but `packages/opencode/src/provider/doctor.ts` (11,874 B), `packages/schema/src/provider-doctor-v1.ts`, `packages/tui/src/component/dialog-provider-doctor.tsx` exist and P6 runs offline Doctor suites **28/28** | `implementationtov1release.md` workstream vs source + `P6`/`LEDGER` | conflict first recorded in `reports/audit-v1-release-requirements.md` §2 RC3.1 — still unresolved |
| **D9** | **A1 typecheck wording:** `implementationtov1release.md` A1 row = "`bun run horizoncode:typecheck` **exited 0** … on the frozen current snapshot"; `HANDOFF.md` line 1482 = "The command **has not been rerun** on final integrated source"; `HANDOFF.md` line 1931 (2026-10-19) = "now passes"; live truth = **last full Run C 25 diagnostics / 2 packages, never re-run to 0** | `implementationtov1release.md` A1 / `HANDOFF.md` ×2 / `LEDGER.md` A1 | already recorded as conflict (iii) in `reports/audit-v1-release-requirements.md` §5 — still present |
| **D10** | **Design-audit recorded results stale:** `arch_V1/46-V1-DESIGN-AUDIT.md` §1 table = "1299 checks, 0 failures", "**285** tracked Markdown files"; live = **1300 checks**, **293** files (registry 230 IDs matches) | `46-V1-DESIGN-AUDIT.md` vs live RUN | expected growth; doc must be refreshed at release re-run |
| **D11** | **Checklist location ambiguity:** the task/plan refer to "final acceptance checklist §0–§9 in `arch_V1/46-V1-VERIFICATION-RUNBOOK.md`" — that file contains **Phase 0–11** (structural → unit → security → context → RepoIntel → managed → providers → TUI → resources → recovery → e2e → release gates). The actual `§0–§9` list is **`reports/FINAL-ACCEPTANCE.md`** (parent-owned), referenced by `reports/audit-v1-release-requirements.md` line 52/242 | runbook vs plan vs `reports/FINAL-ACCEPTANCE.md` | this preflight executed **`reports/FINAL-ACCEPTANCE.md` §0–§9**; §5 cross-references the runbook Phases for command mapping |
| **D12** | **Phantom test-ID families** still present in `46-V1-VERIFICATION-RUNBOOK.md` / `46-V1-IMPLEMENTATION-BACKLOG.md` / `46-V1-WIRE-TRACKER.md`: `TB-*`, `WS-*`, `PD-*` families do not exist in `arch_V1/32` (real: `PS-013/014`, prose §32.28, `JC-RES-013..015`+`FEAT-*`); `LANE-*` is §32.42 not §32.12; `MPT-001` §32.19; `GS-*` §32.8; `LS-*` §32.23; `REL-*`/`ACC-*`/`SPD-*`/`EXP-*`/`LH-*` used by runbook Phases 2/5/9 | `46-V1-*` vs `arch_V1/32` | first recorded in `LEDGER.md` remaining-work ("~45 real defects… phantom/incorrect test-ID citations") — **still unfixed**; the runbook cannot be executed literally until IDs are corrected |
| **D13** | **The A4 gate script itself is modified in the working tree** (uncommitted): `git diff --stat scripts/architecture/audit_overlay_visibility.py` = **+54 / −1**; `skip_hidden_file` was widened to `re.fullmatch(r"tsconfig\.p\d+.*\.json", name)` and `tmp-[a-z]\d+` dirs are now skipped, and `.gitignore` gained exact `!` entries for `agent-node-deps.test.ts` and `tsconfig.p7-rows6.json`. Result: 2 of P9's 4 contested files are now unignored (legitimately fixed) and 2 (`tsconfig.p7typefix.json` ×2 — both still present and still ignored) are **silently skipped rather than resolved**. **Timing:** all three files (`audit_overlay_visibility.py`, its test, `.gitignore`) carry mtime **06:05:22**, i.e. they were edited *during* this preflight, after the 05:54 gate reading | working-tree diff of `scripts/architecture/audit_overlay_visibility.py` + `.gitignore` vs `P9.md` §24.7 | Parent must review that the widened skip covers only regenerable scratch and still enforces "real source stays strictly required-visible" (`AGENTS.md`, `LEDGER.md` 2026-10-23 speed pass). Core assertions (`hidden_changed`/`hidden_new_source`/`stale_unignore`) are unchanged; only the skip set grew. Owners still owe deletion of the scratch files at phase end. Gate was moving mid-preflight ⇒ **A4 must be re-measured on the settled tree** |

**Consistent across all four status docs (no conflict):** headline `V1 = PARTIAL / NOT VERIFIED / NOT RELEASED` (`HANDOFF.md` line 74; `LEDGER.md` line 383; `implementationtov1release.md` lines 33/47/77; all nine phase reports).

---

## 5. What the parent must run at the end — execution order and pass criteria

Run on **one exact revision**; record `git rev-parse HEAD`, platform, and verbatim output per `FINAL-ACCEPTANCE.md` "Evidence". One heavy job at a time (Cargo ⊕ TypeScript).

| Order | Command / action | Pass criteria | Gate |
|---|---|---|---|
| **0** | Resolve **D1–D13** (at minimum D1, D2, D5, D6, D9, D11, D13) so status docs and reality agree; fix the phantom §32 IDs in `46-V1-*` (D12) or the runbook is not executable | no contradictory "current" rows | pre-condition for honest evidence |
| **1** | `git diff --check` && `git diff --cached --check` | exit 0 both (today: 235 whitespace errors in `sdk.gen.ts`) | push-gate step 1 |
| **2** | `python3 scripts/architecture/bootstrap_source.py --check --require-complete` | `missing=0` | ✔ today |
| **3** | `python3 scripts/architecture/audit_overlay_visibility.py` | **exit 0**, `hidden_changed=0 hidden_new_source=0 stale_unignore=0` (today: 13/2/0) | **A4** |
| **4** | `audit_workspace_packages.py` / `validate_convergence.py` / `audit_markdown_repo.py` / `validate_external_sources.py` | `errors=0` / `FAILURES 0` / `ACTIVE_BLOCKERS 0` / `FAILURES 0` (all ✔ today; re-run on final rev) | §0 |
| **5** | `bun run horizoncode:typecheck` | **exit 0**, 0 diagnostics (last: 25/2 packages) | **A1** |
| **6** | `bun turbo typecheck --concurrency=1` | exit 0 across workspace | §1.4 |
| **7** | `cargo build --locked --manifest-path kernel/Cargo.toml --bin session_supervisor --bin hz-kernel` | exit 0 | §1.1 |
| **8** | `cargo test --locked --manifest-path kernel/Cargo.toml` (lib + all test targets) | 0 failed — includes `managed_control`, `resource_budget`, `tool_batch_guard_matrix`, `hosted-tools`, `jc_res_012` | **B2** (last: EXIT 101) |
| **9** | §2 security negatives on that binary: denied-before-lease, lease reuse/widen, cancel→UNKNOWN→no-retry, plugin/MCP/hosted/legacy no-bypass, profile digest/argv deny, read fast path | every case green **or** explicitly `capability_unavailable` readiness-false with the flag documented as `false`; **C25 matrix run** | **B3 / DEC-V1-03** |
| **10** | §3–§7 suites per `46-V1-VERIFICATION-RUNBOOK.md` Phases 1,3,5,6,7,8,9 (one heavy job at a time) | all rows green on this revision; `CX-013/014–021` must not require `cache_read>0` | §3–§7 |
| **11** | Fix bring-up defects, then **B4 real coding journey** on a built CLI (direct coding, managed, context pressure, reconnect/`UI-017`) | 4 journeys pass; **no Guard bypass observed**; no duplicate messages after kill/restart | §8.1–8.4 |
| **12** | `cd packages/opencode && OPENCODE_EXPERIMENTAL_REPO_TOOLS=… bun test test/e2e/free-model-smoke.ts --check` then (only with explicit parent authorization, paid-key env unset) the live turn | `PRECONDITIONS_OK`, exactly one free route, **zero paid fallback**, one real streamed turn | **B5 / §5** |
| **13** | **RC0**: populate `TRUSTED_ATTESTATION_SOURCES` + verifier registry; capture repeated real 1/5/10/20-session baselines into `docs/performance/evidence/` | `ATTESTED` (not `NOT_ATTESTED`), raw artifacts with commit/machine/warm-cold | **B6 / §7.4** |
| **14** | **USER:** settle `DEC-V1-11`, `DEC-V1-12`, `DEC-V1-09`, `DEC-V1-13` | written decision + root LICENSE/NOTICE authored or explicit "internal-only / stay disabled" | **K1 / §9.2** |
| **15** | `python3 scripts/release/prepare_build.py` → candidate; then `audit_distribution.py --strict` and `release_gate.py --artifact … --checkout … --candidate-binary …` against **the exact candidate** | **blockers → 0** (today 15 / 20), `install_matrix` RUN | **K5/K6** |
| **16** | Clean install/upgrade/rollback of `horizoncode` + `hzcode` on native Linux **and** WSL2 with a genuine previous binary; §18.16 fresh-clone acceptance; §18.20 security-channel check | install matrix green both platforms; both names reach the same entrypoint; support matrix truthful | **K5 / K2-honest** |
| **17** | `bash scripts/architecture/run_push_gate.sh` | exit 0 (all 6 structural steps + typecheck + cargo build + `managed_control` + `resource_budget` + the 9 Bun selectors) | **A2** |
| **18** | `bash scripts/architecture/run_full_gate.sh` | exit 0 (`bootstrap`, overlay, workspace audit, `cargo build`, `bun turbo typecheck`, `feature-exposure`) | **S3** |
| **19** | Exact-scope `git add <paths>` → commit → push → recheck `origin/main`; re-run §0 structural gates on the published revision | diff contains only reviewed task-owned paths; gates green post-push | **A3** |

**Nothing may be called VERIFIED/RELEASED before steps 1–19 are green on one revision.** Native Windows stays `UNAVAILABLE`; publication additionally requires explicit user authorization.
