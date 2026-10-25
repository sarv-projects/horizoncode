# V1 tracker reconciliation — designed/claimed status vs. actual evidence

**Date:** 2026-10-25 · **Author:** read-only cross-check subagent · **No source edits, no Git, no test execution.**

**Method.** Read `arch_V1/46-V1-WIRE-TRACKER.md`, `46-V1-IMPLEMENTATION-BACKLOG.md` (incl. the
2026-10-24 status delta), `46-V1-FEATURE-INVENTORY.md`, `46-V1-SOURCE-ALIGNMENT-AUDIT.md`,
`46-V1-MIGRATION-PARITY.md`, `HANDOFF.md` (top), `reports/phases/LEDGER.md` (checkpoint + B wave),
`reports/typecheck-integration-a1.txt`, `reports/a1-ownership-triage.md`, and the newest dated
continuations in `reports/phases/P1..P9.md`. "Reality" was established only with read-only
commands: `test -e` on every named seam/test path, `find`, and `rg --no-ignore --hidden`
(the overlay `.gitignore` is `*`, so plain `grep`/`rg` return false zeros — LEDGER
"Tooling hazard" note applies). **No test suite was executed.**

**Labels used:** `RUN` = a phase report records the exact command **and** the counts ·
`SELF-REPORT` = status/claim with no command in any `reports/phases/*.md` ·
`MISSING` = file absent from the tree.

**Coverage:** 62 backlog rows (P0–P9) + 96 wire-tracker rows (CP/P0–P9/X/PB/tier/FIN/N-A).

---

## 1. Stale statuses

### 1a. Backlog rows whose status says OPEN/DES while code exists (stale the other way)

| Row | Tracker says | Reality (observation) |
|---|---|---|
| **P7-09** | `OPEN` ("TUI help + diagnostics", tests `PERF-DIRECT-*`, `ACT-023`) | **Code exists**: `rg` finds `name: "horizon.debug.effects"` (`packages/tui/src/app.tsx:1794`), dispatch (`packages/tui/src/component/prompt/index.tsx:514-520`), help text (`dialog-help.tsx:38`), renderer (`component/dialog-debug.tsx:111`). **No test**: `rg -l "debug.effects\|dialog-debug" packages/tui/test` → **0 hits**; `ACT-023`/`/view activity` has no test either (`rg -l "view activity" packages/tui/test` → 0). → stale-OPEN on code, gap on tests. |
| **P3-10** | `OPEN` — delta asserts "no `compileOverlapMs`/`index_warming` consumer found in tests" | **Half stale.** `indexWarming`/`symbolFirst` *are* coded and tested: `packages/core/src/session/context-compile-policy.ts:519-556`, consumed at `session/runner/llm.ts:360`; assertions at `packages/core/test/context-compile-policy.test.ts:289-295` and `test/session-runner-compile-boundary.test.ts:21-23`. **`compileOverlapMs` (SPD-A) genuinely absent** — `rg "compileOverlapMs"` → only `arch_V1/32` (spec). Row is OPEN for SPD-A, not for SPD-B/D. |
| **P5-03** | `DES/unavailable` | Accurate — post-V1 per A-V2-31; no code, no test, correctly out of scope. |
| **P1-11** | `OPEN` | **Accurate** — `rg -i "warm.{0,20}(ipc\|kernel\|pool)\|ipc_pool\|warmPool\|kernel_hello"` over `kernel/src packages` → **0 hits**. Real gap (see §4). |

**Delta-table path drift (status itself fine, the named seam file does not exist where the doc says):**
7 rows name a path that is `MISSING`, while the same seam exists elsewhere — `test -e` results:

| Row | Doc seam | `test -e` | Actual location |
|---|---|---|---|
| P1-01 | `packages/core/src/session/tool-batch.ts` | MISSING | `packages/opencode/src/session/tool-batch.ts` (+ `…/test/session/tool-batch.test.ts`) |
| P3-01 | "`kernel` repo_structure" | MISSING | `indexd/src/repo_structure.rs` + `indexd/tests/repo_structure.rs` (no `kernel/src/repo_structure.rs`) |
| P4-02 | `repo-document-reader.ts` (unqualified) | MISSING as written | `packages/opencode/src/lsp/repo-document-reader.ts` + test |
| P6-02 | `provider-transport.ts` (unqualified) | MISSING as written | `packages/opencode/src/auth/provider-transport.ts`, `packages/llm/src/route/direct-provider-transport.ts` |
| P6-04 | `feature-exposure.ts` (unqualified) | MISSING as written | `packages/core/src/v1/config/feature-exposure.ts` + test |
| P6-07 | `horizon/skills/horizoncode/` | MISSING at root | `packages/core/src/horizon/skills/horizoncode/` |
| P8-01 | `kernel/worktree_pool.rs` | MISSING | `kernel/src/worktree_pool.rs` (+ `kernel/tests/support/worktree_pool_tests.rs`) |

Every **CP/PART** row's *test* seam also resolves to a real file (spot-checked 40 paths:
`kernel/tests/{tool_batch_guard_matrix,host_terminal_process,managed_control,direct_attempt_rpc,task_dag}.rs`,
`packages/core/test/{context-compile-policy,instruction-project,session-compaction,reservation-wire}.test.ts`,
`packages/opencode/test/{session/tool-batch,tool/code-mode,tool/websearch,lsp/repo-document-reader}.test.ts`,
`packages/tui/test/util/code-display.test.ts`, `scripts/{perf/test_rc0,eval/test_eval_harness,release/test_release_readiness}.py`
— all EXIST).

### 1b. Wire-tracker `Not done` while code exists (stale / cross-tracker divergence)

Wire tracker snapshot is 2026-10-22; the backlog delta is 2026-10-24. Of **20 `Not done` rows**:

| Row | Wire tracker | Backlog / reality | Verdict |
|---|---|---|---|
| **W-P1-07** (read fast path + batched read RPC) | Not done | Backlog **P1-10 = CP**; code in `kernel/src/host_kernel.rs` (`prepare_tool_batch_read`), `packages/core/src/session/direct-read-batch.ts`, P7 runner wiring GREEN | **Divergence** — tracker stale vs. delta |
| **W-P3-05** (§30.26 compile policy) | Not done | Backlog **CP**; `context-compile-policy.ts` + test exist and have run | **Divergence** |
| **W-P3-09** (§29.23 project instructions) | Not done | Backlog **CP**; `project-instruction.ts` + `instruction-project.test.ts`, suite **21/0/69** `RUN` | **Divergence** |
| **W-P4-05** (post-patch LSP diagnostics, ACC-002) | Not done | **Code + test present**: `packages/opencode/src/lsp/lsp.ts:128` ("Bounded post-patch diagnostics for tool results (ACC-002)"), `src/lsp/diagnostic.ts`, wired into `tool/apply_patch.ts:434-469` (also `write.ts`, `edit.ts`); tests `test/lsp/diagnostic.test.ts`, `test/tool/lsp.test.ts` | **Stale** — integrated ACC-002 accuracy acceptance still unverified, but "no wire" is wrong |
| **W-P6-06** (Horizon Coding Profile) | Not done | Backlog **CP**; `packages/core/src/config/coding-profile.ts` + test exist, **12/0/53** `RUN` | **Divergence** |
| **W-P7-08** (§31.23 code display) | Not done | Backlog **CP**; `packages/tui/src/util/code-display.ts` + `test/util/code-display.test.ts` exist | **Divergence** (test count itself is `SELF-REPORT`, §2) |
| **W-P7-09** (slash parity `/debug effects`) | Not done | Code exists (§1a) | **Stale** on code, correct on acceptance |
| **W-P9-03** (upgrade/migration/signing) | Not done | Backlog **CP**; installer/dry-run/alias tests `RUN` but candidate build `NOT RUN` | **Divergence** (backlog CP is the honest one) |
| W-P3-10 | Not done | Partial (§1a) | Accurate |
| W-P1-08 (warm IPC), W-P6-07b (tier enforcement), X-05, PB-01, FIN-01/02/03/05/06/07, Experimental tier | Not done | Confirmed: **no** warm-IPC code; **no** tier enforcement in `packages/core/src/tool/registry.ts` (`rg -i "exposureTier\|extended"` → 0 hits) | **Accurate** |

### 1c. Phase-report statuses stale against landed code

| Where | Says | Reality |
|---|---|---|
| `reports/phases/P3.md` line 6, §84, §321 | "**P3-11 session import/export = NOT STARTED**" | **Implemented by P7**: `packages/core/src/session/transfer.ts` (header cites §42 SRC-029 provenance) + `packages/core/test/session-transfer.test.ts`; P7 report: `bun test test/session-transfer.test.ts` → **10/0** `RUN`, and the runner+transfer set **125/0/447** `RUN`. Backlog `P3-11 = PART` and tracker `W-P3-11 = Partial` are correct; **the P3 report line is stale.** |
| `arch_V1/46-V1-SOURCE-ALIGNMENT-AUDIT.md` §5 (2026-10-22) | "…missing implementation: `context-compile-policy.ts`, `project-instruction.ts`, `CodeDisplayPipelineV1`" | All three now exist: `packages/core/src/session/context-compile-policy.ts`, `…/project-instruction.ts`, `packages/tui/src/util/code-display.ts`. Audit §5 is **historical**, not current — superseded by the backlog delta. |
| `46-V1-SOURCE-ALIGNMENT-AUDIT.md` §3 P3 row | "`context-compile-policy.ts` **missing** — backlog P3-05" | File exists → stale. |
| `46-V1-FEATURE-INVENTORY.md` "Registry 226 designed / 4 code_present" and wire-tracker "4/230" | 4 `code_present` | **Verified consistent** by parsing `arch_V1/contracts-v2/capability-registry-v1.json`: 230 canonical, `Counter({'designed': 226, 'code_present': 4})` → `builtin.horizon-docs`, `files.write`, `providers.infer`, `question.ask`. Not stale. |
| Overlay-visibility claim | LEDGER checkpoint: `hidden_changed 0 / hidden_new_source 0 / stale_unignore 0` | **Conflicting recorded observations**: P1's wave reports `hidden_new_source 2`; P9 §24.7 reports **exit 1** with **4** `HIDDEN_NEW_SOURCE` (`tsconfig.p7typefix.json`, `tsconfig.p7-rows6.json`, `tsconfig.p7typefix.json`, `agent-node-deps.test.ts`). Unreconciled in the docs; not re-run here. |

### 1d. Count drift inside the 2026-10-24 backlog delta itself

| Delta cell | Latest phase report | Verdict |
|---|---|---|
| P9-03 / P0-03 "release readiness **81/81**" | `P9.md §24.7`: `python3 -m unittest scripts.release.test_release_readiness` → **82 tests OK** `RUN` | **Stale count** (81 not found in any report; earlier waves cite 79/79, 78/78, 77/77) |
| P0-03 "`audit_distribution` BLOCKED **(14)**, `release_gate` BLOCKED **(19)**" | `P9.md §24.7`: `release_status=BLOCKED`, **15 blockers**; `release_gate.py` exit 1, **20 blockers** | **Stale counts** (+1 each) |
| P7-08 "rerun **7/0, 31 expectations**" | no occurrence of `code-display` or "7/0, 31" in any `reports/phases/*.md` | **SELF-REPORT** (see §2) |
| P1-10 "focused **2/2** … Core allowlist test **3/0, 10 expectations**" | `P2.md:493` `cargo test --lib direct_read_batch_` → **2 passed / 0 failed**; `P1.md:2154` read-batch-context → **3 pass / 0 fail / 10 expectations** | **RUN** — accurate |
| P3-09 "instruction suite **21/0, 69 expectations**" | LEDGER P3 row (continuation 20) | **RUN** — accurate |
| P9-03 "installer/upgrade/dry-run/alias-refusal green" | `P9.md` §23.x: `prepare_build.py --dry-run` exit 0 `DRY_RUN_ONLY`, `install --dry-run` exit 0, `bash -n install`, 3 focused install/upgrade/dry-run/alias-refusal tests | **RUN** |

---

## 2. Claimed-but-unverified (status implies test evidence; no test file **or** no command)

| Row / claim | Status text | Evidence gap |
|---|---|---|
| **PERF-DIRECT-002 / -004** (tests column of **P1-10**) | `CP`, tests "PERF-DIRECT-002,004" | **No measurement exists.** `rg "PERF-DIRECT" reports/` → only forward references (`P1.md:144,2030,234` "measurement NOT DONE", `P7.md:2252` "§32.49 PERF-DIRECT-* … NOT_RUN"). No p95/baseline number anywhere (`rg "p95" reports/phases` → 2 spec restatements, no result). **`SELF-REPORT`-free: UNRUN.** Focused proxy evidence exists and is `RUN` (§3). |
| **PERF-DIRECT-001** (tests of **P1-11**) | row is `OPEN` (honest) | UNRUN, and no code (§4). |
| **PERF-DIRECT-005** (tests of **P6-06**) | `CP` | Preset code + unit tests `RUN`; the *fresh-install default* row itself UNRUN. |
| **PERF-DIRECT-003** (in-grant write ≤40 ms warm) | §32.49 | Not referenced in any phase report → UNRUN. |
| **P7-08** delta "rerun **7/0, 31 expectations**" | `CP` | Test file exists (`packages/tui/test/util/code-display.test.ts`) but **no command/count in any phase report** → **`SELF-REPORT`**. |
| **P0-01 / P0-02** = `CP` | Tests column "**—**" | No test claimed; `CP` here rests on tree inspection only → structural, not test-backed. |
| **P2-05** = "CP registry only" | honest label | No `kernel/tests/http_execution*` file exists (`grep -rln http_execution kernel/tests/*` → 0); `providers.infer` registry entry is `code_present` but LANE-003 acceptance has no owned test file. |
| **P1-09** = `PART`, tests "§32.44 EDITOR-*" | seam "kernel editor journal seam" | Seam is **unnamed/unresolvable by path** (`rg "editor.*journal" kernel/src/*.rs` → 0). §32.44 **non-HostKernel** rows are `RUN` (P4: 22/0/131 + 2/0/16); EDITOR-001/002/004-009 (PTY/containment/receipt) remain unrun. |
| **P1-05** = "OPEN/PART", tests "GRANT-*" | mixed status | `kernel/tests/host_terminal_process.rs` exists but runs **2 passed / 1 failed** and `host_terminal_events_process` **0/1** — all *intentional* readiness-false `capability_unavailable`. Evidence is real (`RUN`) but it proves denial, not the feature. |
| **B-wave LEDGER row B1** ("typecheck → 0") | queued | **Not green**: `reports/typecheck-integration-a1.txt` Run C = **25 diagnostics / 2 of 8 packages failing** (`core` 4, `opencode` 21); `a1-ownership-triage.md` §4 "Typecheck is **not** green: 2/8 packages still fail. Do not claim the B1 gate." |
| **B5 free-model E2E (LM-018)** | authorized | **NOT_RUN at dispatch, zero provider requests** (LEDGER P6 row; `P6.md §5.1`) — only offline preconditions `RUN`. |
| **B6 RC0 1/5/10/20 measurements** | queued | `RC0 **NOT_ATTESTED** — `TRUSTED_ATTESTATION_SOURCES` allowlist empty; no workload run (`P8.md §7`). RC0/evaluator counts are input-validation tests only. |

---

## 3. Verified-so-far inventory — evidence that was actually run and passing

Only items whose phase report records **command + counts** are listed `RUN`. Grouped by phase;
older superseded waves are collapsed. Nothing here makes a phase VERIFIED — every owner still
reports `PHASE_PARTIAL`.

### P1 — Guard / ExecutionHost (`reports/phases/P1.md`, LEDGER §36)
| Evidence | Count | Label |
|---|---|---|
| `cargo test --lib codemode_wave_reader_fence_tests` (4 new precondition tests; first 0/4 SQLite FK → fixed test-only → green) | **4 passed / 0 failed / 500 filtered** | RUN |
| `cargo test --lib effect_host::` | **36 / 0 / 468 filtered** | RUN |
| `cargo test --lib managed_attempt_scope_tests` | **15 / 0 / 489 filtered** | RUN |
| `effects_host_process` (after fixture socket-path budget fix) | **10/10** | RUN |
| `effect_host_principal` | **11/11** | RUN |
| lib `guard`/`effect_host`/`cgroup_v2`/`terminal_process` | **79/79** | RUN |
| `direct_attempt_rpc` | **10/10** | RUN |
| `session-supervisor-read-batch-client.test.ts` (P1-10 client seam, RED→GREEN) | **10 pass / 0 fail / 47 exp** | RUN |
| read-batch-context (Core `repo_read` allowlist) | **3 / 0 / 10 exp** | RUN |
| seam+context+P7 caller+launch combined | **53 / 0 / 541 exp** | RUN |
| `session-revert-principal.test.ts` (RED 4/1 → GREEN 5/0) | **5 / 0 / 18 exp** | RUN |
| combined core guard batch (`revert-principal`+`process-guard`+`ripgrep`+`tool-bash`) | **15 / 0 / 60 exp** | RUN |
| core boundary regression `process-guard`/`tool-bash`/`ripgrep` | **10 / 0 / 42 exp** | RUN |
| `packages/server/test/session-revert-authorization.test.ts` (401→403 family-wide, RED 6/1 → GREEN) | **7 / 0 / 45 exp** | RUN |
| `packages/codemode/test/openapi.test.ts` / `httpapi-codegen/test/generate.test.ts` | **26/0/138** · **60/0/113** | RUN |
| typecheck: `packages/core`, `packages/server`, `packages/sdk-next`, `packages/client` `tsgo --noEmit` | **exit 0** ×4 | RUN |
| **Intentionally RED by mandate** (readiness-false denials, gate not relaxed): `tool_batch_guard_matrix` **3/6**, `host_terminal_process` **2/1**, `host_terminal_events_process` **0/1** | — | RUN (negative) |
| B4 delegated-cgroup matrix | **NOT RUN** (host has no user-owned delegated cgroup root) | — |

### P2 — Managed control plane (`reports/phases/P2.md` cont. 29–30)
| Evidence | Count | Label |
|---|---|---|
| `bun test test/tool/task.test.ts` (baseline 6/12 → after fix B 12/7 → after fix A 18/1 → final) | **19 pass / 0 fail** | RUN |
| `-t "canonical forms"` new `expectedRevision` variant lock | **1 / 0 / 42 exp** | RUN |
| `bun test test/session/managed-control.test.ts` | **41 / 0 / 225 exp** | RUN |
| `bun packages/core/script/migration.ts --check` | **exit 0** | RUN |
| `cargo test --lib host_run` (HostRun binding/reconcile + negatives) | **12 passed / 0 failed** | RUN |
| `cargo test --test direct_attempt_rpc --test managed_control --test task_dag --test tool_batch_guard_matrix` | **10/0** · **39/0** · **17/0** · **3/6** (6 = intentional readiness-false) | RUN |
| `cargo test --lib codemode_protocol` / `--lib jc_res_012` | **6/0** · **4/0** | RUN |
| `cargo test --test host_terminal_process` / `host_terminal_events_process` | **2/1** · **0/1** (intentional) | RUN |
| `cargo test --lib direct_read_batch_` (P1-10 RPC: 1/8 leases, >8/foreign/mutation denials) | **2/0** | RUN |
| Cargo explicitly released at end of cont. 30 (`pgrep` clean) | — | RUN |

### P3 — RepoIntel + context (`P3.md` §21–§22)
| Evidence | Count | Label |
|---|---|---|
| C1 core 11-file batch | **89 tests / 88 pass / 1 load-timeout** (307 exp) | RUN |
| C2 timeout file isolated | **7/7** | RUN |
| C3 `session-runner.test.ts` | **102/102** (370 exp) | RUN |
| C4 focused "published ledger" | **1/1** (8 exp) | RUN |
| C5 opencode 7-file batch | **95 / 94 / 1 todo / 0 fail** (674 exp) | RUN |
| C6 `repo-tools` (32 KiB cap + RD-020, new) | **14/14** (66 exp) | RUN |
| C7 `artifact-search` | **19/19** (108 exp) | RUN |
| C8 schema 5-file batch | **35/35** (267 exp) | RUN |
| **Wave grand total** | **362 executions / 360 pass / 1 todo / 1 load-timeout / 0 assertion failures** | RUN |
| **Runbook Phase-3/4 execution table** | **43/62 items run — PASS 32, PASS\* 11, NOT_RUN 18, BLOCKED_P2 1 (RD-017), FAIL 0** | RUN |
| Instruction project suite (continuation 20) | **21 / 0 / 69 exp** + focused **2/0/4** | RUN |
| RepoIntel adapter bundle | **82 / 0 / 1 todo** (503 exp) | RUN |
| Earlier retained: Core 61/61, schema 29/29, `indexd cargo test` | 61/61 · 29/29 · **130/130** | RUN |

### P4 — LSP/DAP/REPL/editor (`P4.md` §4)
| Evidence | Count | Label |
|---|---|---|
| `bun test test/component/dialog-editor-settings.test.tsx test/editor.test.ts` (chips consumer + EDITOR-003) | **22 pass / 0 fail / 131 exp** | RUN |
| `bun test test/editor-route.test.tsx` (EDITOR-013 mounted journey) | **2 pass / 0 fail / 16 exp**, exit 0 | RUN |
| OpenCode `test/lsp test/dap test/repl` (prior wave, not rerun this continuation) | **298 pass / 0 fail / 1,160 exp / 19 files** (was 286/1102 → 294/1117 → 298) | RUN (retained) |
| Typecheck share | P4 files **12 → 0** | RUN |

### P5 — web search + CodeMode (`P5.md` §26)
| Evidence | Count | Label |
|---|---|---|
| P5 10-file group (`websearch*`, `code-mode*`, `registry`) | **141 / 0 / 521 exp** (was 128/0/430) | RUN |
| `code-mode-adapter-contract.test.ts` (RED 5/2 → GREEN) | **8 / 0 / 57 exp** | RUN |
| `websearch-provenance.test.ts` (RED 4/1 → GREEN) | **5 / 0 / 34 exp** | RUN |
| those two combined | **13 / 0 / 91 exp** | RUN |
| P7 `session/tool-batch` consumer (read-only) | **71 / 0 / 322 exp** | RUN |
| earlier codemode suite | **263/0** | RUN (retained) |
| CM-001..012 integrated acceptance, live search, helper build | **NOT RUN** | — |

### P6 — providers / settings / Doctor (`P6.md` §3, §5, earlier waves)
| Evidence | Count | Label |
|---|---|---|
| `test/e2e/free-model-smoke.test.ts` (offline) | **37 / 0 / 101 exp** | RUN |
| mutation red-proof (gate check broken → suite fails) | **5 fail / 31 pass** (non-vacuity) | RUN (negative) |
| `coding-profile.test.ts` + `agent-profiles.test.ts` (EXP-001, stale-revision) | **12 / 0 / 53 exp** | RUN |
| `config.test.ts -t "FEAT-013"` | **1 / 0 / 4 exp** | RUN |
| `--check` clean env | **exit 0 `PRECONDITIONS_OK`** (route `opencode/big-pickle`, catalog digest captured) | RUN |
| `--check` with `NVIDIA_API_KEY` / `OPENCODE_API_KEY` / no server password | **exit 2** ×4: `PAID_ROUTE_CONNECTED`, full **5-refusal matrix**, `SERVER_AUTH_UNCONFIGURED` pre-session | RUN (negative) |
| core 6-file batch (models-dev, exposure, coding-profile, compile-policy…) | **50 / 0 / 231 exp** | RUN |
| opencode control-plane / question-live / auth-routes | **13 / 0** (baseline 8/5/1) | RUN |
| earlier retained: core **29/0/126**, provider/auth **34/0**, question/skill/config **167**, llm **15/0/57**, tui question **12/0/31**, S1 five-module **9/0/41** | — | RUN |
| Live LM-018 turn | **NOT RUN** (zero provider requests) | — |

### P7 — TUI / streams / runner (`P7.md` cont. 23–25)
| Evidence | Count | Label |
|---|---|---|
| `harness-profile-tool-projection.test.ts` (CX-008, new, previously no test at all) | **5 / 0 / 29 exp** | RUN |
| `session-runner-direct-read-routing.test.ts` (P1-10 wiring, new) | **6 / 0 / 33 exp** | RUN |
| `session-direct-read-batch` + `read-batch-client` | **34 / 0 / 484 exp** | RUN |
| `session-runner` + `session-runner-compile-boundary` | **105 / 0 / 380 exp** | RUN |
| focused `tsgo -p tsconfig.p7-wiring.json` | **EXIT 2 → 0**, 0 diagnostics | RUN |
| assigned 8 TS rows: core focus 4 → 0 diagnostics; opencode focus 10 → 1 (foreign `image.ts` only) | **7 core rows cleared** | RUN |
| core suites (baseline) | **27 pass / 0 fail / 447 exp** | RUN |
| `instance-state` 3/0/3, P6 `config.test` **112/0/199**, `repo-tools` **14/0/66**, `agent-node-deps` RED→GREEN **2/0/4** | — | RUN |
| runner + transfer + projector set | **125 / 0 / 447 exp**; `session-transfer` **10/0** | RUN |
| TUI stream/analytics/artifact set | **64 / 0 / 275 exp** (also 24/0/138, and one 22/2 with 2 **approval-pagination** defects left for arbitration) | RUN |
| `task.test.ts` after P2's fixes | **19/0** (P7's own rerun 6 pass/12 fail → root-caused) | RUN |
| `session-runner-recorded` / provider-backed read turn | **NOT RUN** (`ENOENT kernel/target/debug/session_supervisor`) | — |
| Cold AppRuntime | **RED** — `InstanceRef not provided`, root cause unidentified, no production fix | — |

### P8 — worktrees / resources (`P8.md` §6)
| Evidence | Count | Label |
|---|---|---|
| `python3 -m unittest test_rc0.py` | **109 passed / 0** (was 93) | RUN |
| `python3 -m unittest test_eval_harness.py` | **43 passed / 0** (was 40) | RUN |
| `py_compile` on rc0/eval sources | OK | RUN |
| `packages/core test/reservation-wire.test.ts` (JC-RES-012.I TS consumer) | **9 / 0 / 89 exp** | RUN |
| `packages/core` `tsgo --noEmit` | **exit 0, 0 `error TS`** | RUN |
| earlier: RC0 **93/93**, evaluator **40/40**, library filters **118/118**, `resource_sampler` **16/16** | — | RUN (retained) |
| Rust JC-RES-012.C–J + fixture assertion | **written but UNCOMPILED** (Cargo held) | — |
| 1/5/10/20 real workloads, trusted attestation | **NOT RUN / NOT_ATTESTED** (allowlist empty) | — |

### P9 — release / identity (`P9.md` §24.5, §24.7)
| Evidence | Count | Label |
|---|---|---|
| `python3 -m unittest scripts.release.test_release_readiness` | **82 tests OK** | RUN |
| identity focused typecheck → **0 diagnostics, exit 0**; boot focused typecheck → **0/exit 0** (168 s) | — | RUN |
| `test/identity/runtime-service-identity.test.ts` | **2 / 0 / 57 exp** | RUN |
| `test/cli/run/runtime.boot.test.ts` | **6 / 0 / 27 exp** | RUN |
| `install --dry-run`, `prepare_build.py --dry-run`, `bash -n install`, alias-refusal | **exit 0 / DRY_RUN_ONLY / 3 focused tests** | RUN |
| `audit_distribution.py` → `release_status=BLOCKED`, **15 blockers**; `release_gate.py` exit 1, **20 blockers**, install matrix `NOT_RUN` | — | RUN (blocked) |
| sdk-next `import-boundaries.test.ts` | **1 / 1 / 2 exp**; SDK boundary suite **4 pass / 1 fail** (stale `node_modules` link) | RUN |
| Candidate build / clean install / upgrade / rollback / Nix / signing | **NOT RUN / NO-GO** | — |

### Cross-phase / A1 (parent-owned)
| Evidence | Count | Label |
|---|---|---|
| `reports/typecheck-integration-a1.txt` **Run C** (authoritative, 8 packages) | **25 diagnostics, 2/8 packages failing** (`core` 4, `opencode` 21); clean: schema, tui, llm, server, protocol, sdk-next. Run A baseline **60** → **40 cleared** (A1 15, others 25) | RUN |
| A1 runtime findings routed | `agent-profile-v2.test.ts:92,23` **11 pass / 1 fail**; `tool.task authenticated dispatch` **4 pass / 14 fail** | RUN |
| `audit_markdown_repo.py` | **ACTIVE_BLOCKERS 0** (293 tracked files, 62 archive-only warnings) | RUN (cited by P2/P6/P8/P9) |
| `validate_convergence.py` | **1,300 checks / 0 failures** | RUN (cited by P2/P6/P8/P9) |
| `audit_overlay_visibility.py` | **conflicting records**: 0/0/0 (LEDGER) vs `hidden_new_source 2` (P1) vs **exit 1, 4 files** (P9 §24.7) | unresolved |

---

## 4. Gaps — no code **and** no test

| Row | State | Evidence of absence |
|---|---|---|
| **P1-11 / W-P1-08 — warm kernel IPC pool** (`PERF-DIRECT-001`) | **No code, no test** | `rg -i "warm.{0,20}(ipc\|kernel\|pool)\|ipc_pool\|warmPool\|kernel_hello" kernel/src packages` → 0 hits. Backlog `OPEN` is correct. |
| **P3-10 SPD-A — `compileOverlapMs` compile/provider overlap telemetry** | **No code, no test** | `rg "compileOverlapMs" packages arch_V1` → only the spec row `arch_V1/32:1334`. (SPD-B/D `index_warming`/symbol-first **do** have code + tests — §1a.) |
| **P5-03 — browser/desktop** | **No code, no test — out of V1 scope** | Backlog `DES/unavailable`, A-V2-31 post-V1. Correctly excluded. |
| **P7-09 — `/debug effects` + `ACT-023`** | **Code yes, test no** (gap = coverage, not implementation) | `rg -l "debug.effects\|dialog-debug\|view activity" packages/tui/test` → 0 hits. |
| **P2-05 — `providers.infer` runtime path** | Registry `code_present` only; **no dedicated test file** | `kernel/tests/http_execution*` absent; `grep -rln http_execution kernel/tests/*.rs` → 0. |
| **P1-09 — kernel editor journal seam** | Seam **unnamed/unlocatable**; effectful EDITOR rows unrun | `rg "editor.*journal" kernel/src/*.rs` → 0. Non-HostKernel §32.44 rows are covered (P4 `RUN`). |
| **Integration gates FIN-01/02/03/05/06/07, X-05, PB-01, Experimental tier** | Not-done is **accurate** — no run evidence found in any phase report (FIN-04 is the exception: Markdown + convergence `RUN`). | `rg "FIN-0[123567]" reports/phases` → no execution records. |

**Rows with neither stale status nor gap:** 55 of 62 backlog rows name a seam that resolves directly
and, where the Tests column names one, a test path that also resolves; the remaining 7 are the
path-drift rows in §1a (file exists, path in the doc does not). Every CP/PART row's named test family
was spot-checked for existence (40 paths, all EXIST) — existence only, no execution.

---

## 5. `46-V1-MIGRATION-PARITY.md` — DEC-V1-36 parity items

The parity doc itself declares itself **design-complete only**: §6 "sign-off = §32.49 passes on a
pinned revision alongside `PERF-DIRECT-*` evidence; until then treat competitor comparisons as
targets". §32.49 defines **PERF-DIRECT-001…006**; `rg "PERF-DIRECT" reports/` finds **zero
executions** — every mention is a forward reference or a "NOT RUN/NOT DONE" statement.

### §5 backlog-hook rows → evidence

| Hook row | Parity item | Code? | Test evidence | PERF / acceptance |
|---|---|---|---|---|
| **P1-10** | Read fast path + `prepare_tool_batch_read` (§14.3.1) | **Yes** (`kernel/src/host_kernel.rs`, `packages/core/src/session/direct-read-batch.ts`, P7 runner wiring) | **RUN**: P2 `direct_read_batch_` **2/0**; P1 client **10/0/47**, context **3/0/10**, combined **53/0/541**; P7 routing **6/0/33**, batch **34/0/484**, runner **105/0/380** | **PERF-DIRECT-002 UNRUN** (no baseline p95), **PERF-DIRECT-004 UNRUN** (no telemetry-timing evidence); production still unreachable — `effects_enabled` never set (LEDGER P2 row) |
| **P1-11** | Warm pooled IPC (§13.2) | **No** | **No** | **PERF-DIRECT-001 UNRUN** — owner is the parent (P1 report lines 144/1072/1231) |
| **P6-06** | Coding (recommended) default preset (§16.19.1) | **Yes** (`packages/core/src/config/coding-profile.ts`) | **RUN**: core batch **12/0/53**, **50/0/231** | **PERF-DIRECT-005 UNRUN** (fresh-install default not exercised) |
| **P3-06** | Context slashes + `/summarize` alias (§16.4.1, §30.3) | **Partial** — Core `session/compaction.ts` + OpenCode `SessionCompaction` yes; **TUI `/trim` and `/prune` NOT implemented** (`rg '"/trim"\|"/prune"' packages/tui/src` → 0; feature inventory lists them as migration gaps) | Core compaction **RUN** (C1 batch includes `session-compaction`; earlier **3/3**) | Slash-parity acceptance not run |
| **P7-09** | `/debug effects` diagnostics (§31.24) | **Yes** (4 files, §1a) | **None** (`0` test hits) | `PERF-DIRECT-*` + **ACT-023 UNRUN** (delta says so) |
| **P6-07** | `builtin.horizoncode` + exposure tiers (§33.32, DEC-V1-38) | **Yes** (`packages/core/src/horizon/skills/horizoncode/`) | **RUN**: EXP-001 Core-tier skill exposure green in the 12/0 core batch; **FEAT-013** **1/0/4** | Tier **enforcement** (EXP-003/004, W-P6-07b) has **no code** in `packages/core/src/tool/registry.ts` → tracker `Not done` correct; chips consumer landed in P4 (**22/0/131**) but runtime counts stay "unknown" (no trusted `CapabilityDescriptorV1` route) |
| **P3-10** | Speed compiler SP-A..D (§30.28) | **Partial** (§1a) | SPD-B/D `RUN` via `context-compile-policy.test.ts:289-295`; SPD-A none | SPD-A not run, not implemented |

### §3 turn-latency table / §1 "no latency law" fix
- "Reads fast path ≤+10%", "writes/shell Guard+lease ≤40 ms (warm)" = **PERF-DIRECT-002/003** → **UNRUN** (no `p95` number exists anywhere in `reports/`).
- "Provider path independent of kernel READY (§13.2)" = PERF-DIRECT-001 → **UNRUN**; also unimplemented.
- "Approval fatigue → Coding preset" → code + unit tests `RUN`, install-time default **UNRUN**.
- "Goal confusion → `/goal-*` labeled Advanced" → `rg -i "advanced" packages/tui/src/ui/dialog-help.tsx` → **0 hits**: not implemented, not tested.

### §2 feature-comparison rows (12 expectations)
All are **normative design claims**, not measured parity. The only rows with any local evidence are
"Read files while agent works" (code + focused tests `RUN`, perf UNRUN), "Permissions/sandbox modes"
(`/permissions` + settings/chip journeys `RUN`, no integrated journey), and "Effect receipts /
UNKNOWN" (negative matrices `RUN`: P1 revert 7/0/45, P2 reconcile 12/0, P8 evaluator 43/43 — but the
end-to-end UNKNOWN journey is **not** run). **Nothing in §2 has release-grade evidence.**

**Bottom line for §DEC-V1-36:** 0 of 6 `PERF-DIRECT-*` rows executed; 3 of 7 §5 hook rows fully
coded (P1-10, P6-06, P6-07 core half), 2 partial (P3-06, P3-10), 1 coded-but-untested (P7-09),
1 not started (P1-11). Parity sign-off (§6) is **not reachable yet**.

---

## 6. Executive counts

| Metric | Count |
|---|---|
| Backlog rows reconciled | **62** (CP 11 — incl. P2-05 "CP registry only" · PART 47 — incl. P1-05 "OPEN/PART" · OPEN 3 · DES 1) |
| Rows with a **stale status** (status says OPEN/DES or lower, code exists) | **4** — P7-09, P3-10 (partial), W-P4-05, + P3-report P3-11 "NOT STARTED" vs landed code |
| Rows whose **named path is wrong** but file exists elsewhere | **7** — P1-01, P3-01, P4-02, P6-02, P6-04, P6-07, P8-01 |
| **Cross-tracker divergences** (wire `Not done` vs backlog `CP`) | **6** — W-P1-07, W-P3-05, W-P3-09, W-P6-06, W-P7-08, W-P9-03 |
| `Not done` rows **confirmed accurate** | **12 of 20** (incl. W-P1-08, W-P6-07b, X-05, PB-01, FIN-\*, Experimental tier; W-P3-10 accurate only for SPD-A) |
| **Stale counts** in the 2026-10-24 delta | **4** — release readiness 81→**82**, audit blockers 14→**15**, gate blockers 19→**20**, P7-08 7/0/31 uncited |
| `SELF-REPORT` claims (no command anywhere) | **2** — P7-08 rerun, P0-01/P0-02 CP with empty test column |
| `RUN` evidence bundles consolidated (§3) | **~95 distinct command/count records** across P1–P9 + A1 |
| Gaps with **no code and no test** | **3** — P1-11, P3-10 SPD-A, P5-03 (out of scope) |
| Gaps with **code but no test** | **2** — P7-09, P2-05 runtime path |
| `PERF-DIRECT-*` rows executed | **0 / 6** |
| Whole-repo typecheck (B1) | **NOT GREEN** — 25 diagnostics / 2 packages |
| Phases VERIFIED / V1 RELEASED | **0 / 9 — V1 remains PARTIAL, NOT VERIFIED, NOT RELEASED** |
