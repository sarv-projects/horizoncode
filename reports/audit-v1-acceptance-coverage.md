# V1 acceptance-coverage audit — how much of the required acceptance suite has actually run

**Auditor:** read-only acceptance-coverage subagent. **Date:** 2026-10-25.
**Sources:** `arch_V1/46-V1-VERIFICATION-RUNBOOK.md` (phases 0–11), `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` (row IDs), `reports/phases/P1–P9.md` (dated sections), `reports/phases/LEDGER.md`, `HANDOFF.md` current sections, `reports/FINAL-ACCEPTANCE.md`.
**Rules applied:** a row counts as *executed* only if I can point at a command and its output in a report. Model/agent assertions without a command are labelled `SELF-REPORT`. No tests were run by this audit; nothing outside this file was edited.

**Counting definitions**

- **run evidence** — a cited command whose output covers the row's acceptance (PASS, or PASS with a named foreign leg).
- **blocked** — a report names a concrete prerequisite/owner for why the row has not run.
- **never run** — no evidence *and* no recorded prerequisite statement: nobody has executed or scheduled it.
- A family may appear in two columns when the row has *partial* (fixture/fail-closed) evidence but its live half is blocked (CM, WS).

---

## Executive summary

| Metric | Number |
|---|---|
| Runbook phases fully executed as written | **2 of 12** (Phase 0 structural, Phase 11 release gates — the latter returning NO-GO) |
| Runbook phases executed at row level | **1** (Phase 3, and only it — P3's 43/62 wave) |
| Runbook phases PARTIAL | **6** (1, 2, 4, 6, 8 + 7 partially) |
| Runbook phases NOT RUN | **4** (5, 9, 10, and Phase 7's row families) |
| Requested families audited | 28 (TB- and PD- **do not exist** as catalog rows) |
| Rows in those families | **359** |
| Rows with command-pointable run evidence | **89 (24.8 %)** |
| Rows blocked with a named prerequisite | 268 (241 of them with *no* evidence; 27 have partial fixture evidence only) |
| Rows never run, no recorded prerequisite | **29** |
| Families with **zero** execution | **15**: PS, RC, MPT, LS, UI, ACT, GS, SA, LANE, GRANT, REL, PERF-DIRECT, SPD, LM-018, (+ TB/PD absent) |
| Assertion failures in the executed rows | **0** (P3 §22: 362 executions → 360 pass, 1 todo, 1 load timeout; P5 §26.4: 141/0) |
| Whole catalog | 550 numbered row IDs (616 incl. lettered sub-fixtures); **~191 rows outside this audit's assigned families were not assessed here** |

The pattern is consistent: **offline/unit/library-level acceptance is broadly green; integrated, effectful, provider-backed and OS-backed acceptance is almost entirely unstarted.** Every executed row that has an open leg names its owner, which is why "blocked" (268) dwarfs "never run" (29) — the gap is dependencies, not neglect, except in the 5 never-run families listed in §3.

---

## 1. Runbook phase-by-phase status

| Phase | Scope (runbook) | Status | Exact commands + counts found | Owner of the remainder |
|---|---|---|---|---|
| **0 — Structural gates** | `validate_convergence.py`, `audit_markdown_repo.py` (+ overlay audit) | **EXECUTED (2 of 3 green)** | `python3 scripts/architecture/validate_convergence.py` → **CHECKS 1300 / FAILURES 0** (P5 §26.7, P6 §3, P8 §6, P9 §24.7, P1 §38). `python3 scripts/architecture/audit_markdown_repo.py` → **ACTIVE_BLOCKERS 0, REFERENCE_WARNINGS 62** (same five citations). `python3 scripts/architecture/audit_overlay_visibility.py` → **exit 1**, `hidden_changed=0 hidden_new_source=4 stale_unignore=0` (P9 §24.7: `tsconfig.p7typefix.json`, `tsconfig.p7-rows6.json`, `tsconfig.p7typefix.json`, `agent-node-deps.test.ts`; P1 §38: `packages/opencode/tmp/probe-{v2,v3,v4}.ts` + 1) | Overlay audit → file owners (P7/P2/P6) + parent. `bootstrap_source.py --check`, `audit_workspace_packages.py`, `validate_external_sources.py` (FINAL-ACCEPTANCE §0) → **no run evidence found** — parent |
| **1 — Unit / package tests** | schema / core / opencode / tui / kernel | **PARTIAL** | schema: P3 C8 `bun test …` **35/35**; core: P3 C1 **89 (88 pass, 1 load timeout)** + C2 **7/7** + C3 **102/102**, P7 A2 `session-runner` + compile-boundary **105/0, 380 exp**; opencode: P3 C5 **95 (94 pass, 1 todo)** + C6 **14/14** + C7 **19/19**, P5 `websearch*/code-mode*/registry` **141/0, 521 exp / 10 files**, P6 18-file set **923/0, 2261 exp**; tui: P4 **22/0, 131 exp** + **2/0, 16 exp**, P7 "TUI focused **56/56**" (`SELF-REPORT` of the combined run — no per-file command printed); kernel: **filtered only** — P1 §33 `--lib guard::` **21/21**, `--lib effect_host::` **32/32**, `cgroup_v2` **4/4**, `terminal_process` **22/22**, `effects_host_process` **10/10**, `effect_host_principal` **11/11**, `direct_attempt_rpc` **10/10**; P2 2026-10-25 `--lib host_run` **12/0**, `--test managed_control` **39/0**, `--test task_dag` **17/0**, `--lib codemode_protocol` **6/0**, `--lib jc_res_012` **4/0**, `--test tool_batch_guard_matrix` **3 pass/6 fail (intentional readiness-false)** | Full `cd kernel && cargo test` (**B2**, queued behind P1's Cargo hold — P2 cont. 30, HANDOFF 2026-10-25); package-wide `bun run horizoncode:typecheck` (**A1**: Run C = **25 diagnostics / 8 packages, 2 non-zero exits**, `reports/a1-ownership-triage.md` — 3 routed rows cleared to 0 by P9 but not re-run) |
| **2 — Security / Guard negatives** | §32.14 PS, §32.20 SE, §32.43 GRANT/PERM, §32.49 PERF-DIRECT, §32.50–52 SPD/EXP/ACC/REL/LH | **PARTIAL — 0 rows of the named families executed** | Positives that ran: P1 `guard::` 21/21, `effect_host::` 32/32, `effect_host_principal` **11/11** (prepared-lease settlement, restart receipt reconciliation, UNKNOWN recovery, cross-epoch fencing, principal/approval denial); **real integrated HTTP negatives**: `packages/server` `session-revert-authorization.test.ts` **7/0, 45 exp** on live `createRoutes("secret")` stacks — unauthenticated → **403**, anonymous/wrong Basic → **401**, authenticated → 200/204 with exact events (HANDOFF 2026-10-25 P1 §37/§38). Negative coverage that did **not** run: cross-capability lease substitution (`tool_batch_guard_matrix` 6 denials are `capability_unavailable`, asserted *before* `effect_denied`), delegated-cgroup **B4 NOT RUN — this host has no user-owned delegated cgroup root** (HANDOFF, P1 §34), GRANT-001..017 / PERM-001..006 / §32.14/§32.20 "exact integrated acceptance targets … remain open" (P1 §15) | P1 (GRANT/PERM/PS rows, B4), P2 (Guard route + PTY readiness decision), parent (P1-11 = PERF-DIRECT-001 measurement "NOT DONE") |
| **3 — Context and cache** | §32.10 CX, §32.13 INST, §32.45 CTX | **EXECUTED (partial rows)** | P3 §22, rev `44f8b5f2a` + tree: **8 commands, 362 executions → 360 pass / 1 todo / 1 load-induced timeout / 0 assertion failures**. Row score: CX **17/25** (16 by P3 + CX-008 by P7 `harness-profile-tool-projection.test.ts` **5/0, 29 exp**), INST **7/8**, CTX **6/7** (runbook scope CTX-001..005 = 4/5) → **28/38 runbook Phase-3 rows** | P6/provider (CX-006, CX-007, CX-021), P7 (CX-005, 009–012, CTX-005), P2 (INST-004 delivery-root builder) |
| **4 — RepoIntel** | §32.4 RD + cross-cuts | **PARTIAL** | Same P3 §22 table: **RD 12/20** executed (RD-006, 007, 010, 011, 012-neg, 013, 014, 015, 016, 018, 019, 020); **4/4 cross-cuts** have evidence but two carry blocked sub-legs (`repo.tree` 32 KiB cap `repo-tools` **14/14**; stale⇒no-write `PASS*`; read-scope mismatch PASS; paging/cursor `PASS*`). **RD-017 is BLOCKED_P2** (`kernel/target/debug/hz-kernel` absent) | parent Phase-10 real-repo journey (RD-001..005), P4 (RD-008), P1/parent (RD-009), P2 (RD-017 + all `BLOCKED_P2` sub-legs), P4 (RD-012 positive producer) |
| **5 — Managed lane** | §32.9, §32.12 SA/LANE, MPT-001 | **NOT RUN** | No SA-/LANE-/MPT-/LH- row has a cited command anywhere (`grep SA-0..` in phase reports = 0 row executions; HANDOFF §32.12 note: "acceptance requirements, not evidence"). Nearest unmapped evidence: P2 `managed_control` **39/0**, `task_dag` **17/0**, `host_run --lib` **12/0**; TS `managed-control.test.ts` **41/0, 225 exp** — none is a catalog row | P2 (managed admission positives 1/3, DAG/aggregate settlement), parent Phase-10 managed journey |
| **6 — Providers / Doctor** | §32.21, §32.31 PD/FEAT, LM-018 | **PARTIAL** | FEAT **1/14**: `config.test.ts -t "FEAT-013"` **1 pass/0 fail, 4 exp** (P6 2026-10-25). EXP **2/5**: `coding-profile.test.ts` + `agent-profiles.test.ts` **12/0, 53 exp** (EXP-001, pins EXP-003), `test/skill/identity.test.ts` **30/0, 113 exp** (EXP-002). LM-018 **NOT RUN**: the authorized E2E reached pre-flight `PRE-FLIGHT: PASS` then failed `Session not found` before dispatch — *"no provider request left this machine … §32 LM-018 stays NOT RUN"* (P6 §5.1). Offline gate proof: `test/e2e/free-model-smoke.test.ts` **37/0, 101 exp** + mutation red-proof 5 fail when the gate was disabled | parent (integrated FEAT/QA/PD rows), P1/P2 (Guarded transport, SecretBroker), source-run bootstrap owner (`serve` supervisor socket / `Session not found`), user authorization for the live turn |
| **7 — TUI / UX** | §32.16 UI-*, §32.48 ACT-* | **PARTIAL (evidence only, 0 rows)** | **0 UI rows and 0 ACT rows executed by ID.** P7 states the focused suites are *"focused presentation/unit tests, **not §32.48 ACT-001..024 acceptance** or rendered UI"*; *"UI-001..007, UI-017..030 reconnect/focus/scroll/runtime journeys remain open; UI-024..030 reference-hardware RAM/performance measurements are not [done]"*. Unmapped green: TUI focused **56/56**, activity-card tests **9/0, 73 exp**, chips consumer **11/0, 106 exp** (P4) | P7 (integrated TUI runtime; reference hardware for UI-024..030); parent for the 80×24 manual layout §16.21.4 |
| **8 — Resources / worktrees** | §32.32–33 JC-RES, §32.8 GS | **PARTIAL** | JC-RES **10/69**: `cargo test --lib resource_budget` **31**, `worker_pool` **22**, `resource_sampler` **18**, `jc_res_012` **4** — earlier wave **118 lib / 0 fail + 16 integration**, explicitly mapped to **JC-RES-012.C–L**; re-run on 2026-10-25 `--lib jc_res_012` **4/0** (P2). TS side of **012.I** landed: `packages/core/test/reservation-wire.test.ts` **9/0, 89 exp**. Python: `test_rc0.py` **109/0** (was 93), `test_eval_harness.py` **43/0** (was 40). **JC-RES-001..024 base = 0 executed** — *"measurement protocol … a runbook and unexecuted empty template … RC0 remains NOT_BASELINE"* (HANDOFF); **GS 0/10** | P1 (Cargo release → P8's prepared matrix), P2 (HostRun binding/producer), P6 (trusted resource-policy ingress), parent (attestation source + 1/5/10/20 workloads). **Coverage dispute to resolve:** P8's row→test map claims K/L Rust coverage, P8's later §7 audit says *"no dedicated JC-RES-012.K impersonation / .L cross-owner test found — remains OPEN"* |
| **9 — Recovery / healing** | §32.19 RC-001..011 | **NOT RUN** | No `RC-0xx` row is cited in any phase report; no row-named test exists in `packages/*/test`, `kernel/tests` or `scripts`. Nearest unmapped evidence: restart/UNKNOWN paths inside `effect_host_principal` 11/11 (`SELF-REPORT` as RC coverage) | P1/P2 (crash-after-effect, loop detection, syntax patch fixtures), P8 (disk-pressure cleanup scope) |
| **10 — End-to-end journeys** | direct coding, managed, context pressure, reconnect, HUP-001..006 | **NOT RUN** | No journey has a captured run. The one attempt (LM-018 free-model coding task) stopped pre-dispatch with `Session not found` (P6 §5.1). HUP-005 is fake-only self-check; *"fake-only output can never complete HUP-001"* (catalog §32.40). RD-001..005 real-repo rows explicitly routed to "parent Phase-10 journey" (P3 §22) | **parent**, after §4 items 1–4 |
| **11 — Release gates** | `implementationtov1release.md`, `18-OPERATIONS-RELEASE.md`, CI, fresh WSL install | **EXECUTED → NO-GO** | `python3 -m unittest scripts.release.test_release_readiness` → **82 tests OK**; `scripts/release/audit_distribution.py --root .` → `release_status=BLOCKED`, **15 blockers** (4 packages with no license metadata, 58 with no LICENSE/NOTICE, root `UNLICENSED` vs 12× `MIT` vs Nix `MIT`); `scripts/release/release_gate.py --root .` → **exit 1, BLOCKED, 20 blockers** (`install_matrix NOT_RUN`, `signing_update UNAVAILABLE`, `publication_performed=false`, `signature_created=false`) — P9 §24.7 | P9 + user decision DEC-V1-11 (licensing/grant), then P1–P8 integration for a candidate build; `check:generated` CI claim (`SELF-REPORT`, P1 §38) pending regeneration |

---

## 2. Acceptance-family coverage table

Rows in family / rows with run evidence / rows blocked / rows never run. Dangling families (TB-, PD-) are referenced by the runbook but have **no rows** in §32.

| Family | § | Rows | Run evidence | Blocked | Never run | Citation |
|---|---|---:|---:|---:|---:|---|
| **TB-** | — | **0** | 0 | — | — | Runbook Phase 1 lists `TB-*`; no such IDs exist in §32. Nearest = tool-registry suites in P3 C5 / P5 `registry.test.ts` |
| **PS-** (permissions/sandbox) | 32.14 | 17 | **0** | 17 | 0 | P1 §15: §32.14/§32.20 "required current-runtime assertions remain open". Static-only: `validate_convergence.py` carries PS-011/012 fixtures — not runtime |
| **RC-** (recovery) | 32.19 | 11 | **0** | 0 | **11** | No RC row cited in any report; no RC row test in the tree |
| **MPT-001** | 32.19 | 1 | **0** | 1 | 0 | Runbook Phase 5 (unrun); needs live-Attempt managed dispatch |
| **RD-** (RepoIntel) | 32.4 | 20 | **12** | 8 | 0 | P3 §22 Phase-4 table (`repo-intel.test.ts`, `repo-tools.test.ts` via C5/C6) |
| **CX-** (context) | 32.10 | 25 | **17** | 8 | 0 | P3 §22 (16) + HANDOFF 2026-10-25 P7 §24 (CX-008 **5/0, 29 exp**) |
| **CTX-** (context ledger) | 32.45 | 7 | **6** | 1 | 0 | P3 §22: CTX-001..004 + CTX-006/007 (extra rows) in C1/C8; CTX-005 → P7 |
| **INST-** (instructions) | 32.13 | 8 | **7** | 1 | 0 | P3 §22 (`instruction-project.test.ts`, C1); INST-004 → P7 ("no delivery-root instruction-set builder") |
| **LS-** (language services) | 32.23 | 14 | **0** | 14 | 0 | P4 last section: "LS-001..014, DAP-001..002, REPL-001..002, EDITOR-001..013 integrated journeys" still open; underlying LSP/DAP/REPL bundle **298/0, 1160 exp / 19 files** is unrowed |
| **WS** (web-search bullets) | 32.28 | 15 bullets | **15** fixture/fail-closed | 15 live halves | 0 | P5 §26.3 matrix + §26.4 commands (`websearch-provenance.test.ts` **5/0, 34 exp**; combined **141/0, 521 exp**) — §26.5: integrated acceptance **NOT RUN** |
| **CM-** (CodeMode) | 32.41 | 12 | **12** fixture/fail-closed | 12 integrated | 0 | P5 §26.2 readiness matrix + §26.4 (`code-mode-adapter-contract.test.ts` **8/0, 57 exp**; P7 `tool-batch` **71/0, 322 exp**); §26.5: "CM-001..CM-012 integrated acceptance **NOT RUN / NOT VERIFIED**" |
| **PD-** (provider/Doctor) | — | **0** | 0 | — | — | Runbook Phase 6 and §32 V1-ADAPT-007 cite `PD-*`; §32.31 contains FEAT-/QA-/P6-PROVIDER rows only |
| **FEAT-** | 32.31 | 14 | **1** | 13 | 0 | P6 2026-10-25: `bun test test/config/config.test.ts -t "FEAT-013"` **1/0, 4 exp**; rest → "TUI/GUI/HTTP surface tests … parent integrated final verification" |
| **UI-** | 32.16 | 26 | **0** | 17 | 9 | P7: UI-001..007 / UI-017..030 named open (17 rows); UI-008..016 never named and no row test exists (9) |
| **ACT-** (activity/review) | 32.48 | 24 | **0** | 24 | 0 | P7: focused tests are *"not §32.48 ACT-001..024 acceptance"*; family prerequisite = integrated TUI runtime |
| **JC-RES-** | 32.32/33/37 | 69 | **10** (012.C–L) | 59 | 0 | P8 earlier wave `118 lib + 16 integration` mapped to 012.C–L; 2026-10-25 `jc_res_012 4/0` + `reservation-wire.test.ts 9/0`; HANDOFF: base 001..020 *"unexecuted empty template"*; P6: 013..015 NOT VERIFIED; K/L coverage **disputed** (P8 §7) |
| **GS-** (git/workspace safety) | 32.8 | 10 | **0** | 10 | 0 | Runbook Phase 8; no GS row test exists; P8 "Full Rust/P8 acceptance **NOT RUN** — parent must schedule one Cargo test" |
| **SA-** (agents/subagents) | 32.12 | 21 | **0** | 21 | 0 | HANDOFF §32.12: "acceptance requirements, not evidence" |
| **LANE-** (lane parity) | 32.42 | 6 | **0** | 6 | 0 | Runbook Phase 5 (unrun) + Phase 10 managed journey |
| **GRANT-** | 32.43 | 17 | **0** | 17 | 0 | P1 §15: "exact integrated acceptance targets are §32.43 GRANT-001..017, PERM-001..006 … No source inspection can substitute for these journeys" |
| **EDITOR-** | 32.44 | 13 | **5** (003, 010, 011, 012, 013) | 8 | 0 | P4 2026-10-24: `editor.test.ts` **11/0, 25 exp** (EDITOR-003), `editor-route.test.tsx` **2/0, 16 exp** (013 + the overlay/side-pane test covering 010–012); 001/002/004–009 → P1/P2 (PTY, containment, fence, receipts, scratch) |
| **REL-** | 32.52 | 2 | **0** | 0 | **2** | No REL row cited; no row test |
| **PERF-DIRECT-** | 32.49 | 6 | **0** | 3 (001, 002, 004) | 3 (003, 005, 006) | P1: "P1-11 PERF-DIRECT-001 measurement **NOT DONE**"; "Then P1/P2/P7 run the §32.49 PERF-DIRECT-002/004 parity evidence". Needs reference WSL2 hardware + warm kernel (§32.49) |
| **HUP-** | 32.40 | 8 | **1** (005, fake-only) | 7 | 0 | `scripts/eval/test_eval_harness.py` **43/0** (was 40) = HUP-005 self-check; P8: "RC0 and HUP-001/002 **NOT_ATTESTED / NOT RUN**" |
| **SPD-** | 32.50 | 4 (A–D) | **0** | 0 | **4** | No SPD row cited anywhere; no speed-compiler telemetry fixture |
| **EXP-** | 32.51 | 5 | **2** (001, 002) | 3 (003 partial, 004, 005) | 0 | P6 2026-10-25 `coding-profile`/`agent-profiles` **12/0, 53 exp**; `skill/identity.test.ts` **30/0, 113 exp**; "EXP-004's `tools.search` consumer and EXP-005's baseline comparison remain with the P5/P7 consumers / integrated acceptance" |
| **ACC-** | 32.52 | 3 | **1** (002, indirect) | 2 (001, 003) | 0 | ACC-002's assertions live in `packages/opencode/test/lsp/diagnostic.test.ts`, inside P4's cited `bun test test/lsp test/dap test/repl` **298/0, 1160 exp** — but P4 never row-attributed it (`SELF-REPORT`-adjacent: command ✓, row mapping ✗). ACC-001 (stale fence) → P1/P2; ACC-003 (verifier evidence) → P2/P8 |
| **LM-018** | 32.11 | 1 | **0** | 1 | 0 | P6 §5.1: authorized run → pre-flight PASS → `Session not found`, **zero provider requests**; harness `free-model-smoke.test.ts` **37/0, 101 exp** is gate proof, not the journey |
| **TOTAL** | | **359** | **89 (24.8 %)** | 268 (241 with no evidence) | **29** | CM 12 + WS 15 appear in both evidence and blocked (partial fixture evidence, live halves blocked) |

**Release-blocking markers found in §32** (for orientation, not a coverage number): the catalog has no per-row "release-blocking" flag — release blocking comes from §32.24 *Release minimum* (security/recovery mandatory tests, clean-install + `horizoncode`/`hzcode` same entrypoint, queue/restart/reconnect/cache/subagent contention, false-completion rate, core change + long-horizon + context + local-model + worktree suites, LSP coexistence, checkpoint restore, novice/expert UX, no advertised effect bypass, measured perf budgets, reproducibility) and §32 intro (V1 release evidence = Linux/WSL CLI/TUI; browser/desktop/visual-edit/deployment/outbound-ACP explicitly **not** V1 gates). Explicit row-level gate language exists only on **DOC-006** ("block release gate"), **DOC-008**, **DOC-010**, **DOC-017**.

---

## 3. Never-run families (zero execution anywhere)

| Family | Rows | Blocking prerequisite |
|---|---:|---|
| **RC-001..011** (recovery/healing) | 11 | No fixture or row test exists. Needs: crash-after-effect / loop-detection / syntax-patch / disk-pressure fixtures written against a running HostKernel — i.e. **P2's `hz-kernel` + `session_supervisor` build artifact** and a scheduled Phase 9 wave. Today `test/session-runner-recorded.test.ts` fails at `ENOENT: kernel/target/debug/session_supervisor` (P7 A2) |
| **UI-008..016** | 9 | No row test; family-level prerequisite is the **integrated TUI runtime** P7 does not yet have (AppRuntime `InstanceRef not provided` history; `SELF-REPORT` of resolution in continuation 24/25 — no rendered-surface run captured) |
| **REL-001..002** | 2 | UNKNOWN-receipt reconcile copy + soft-pressure auto-trim rendering: needs **P7 TUI** (reconcile copy) and **P8 pressure state** (auto-trim) wired; neither report acknowledges the rows |
| **SPD-A..D** | 4 | Speed-compiler telemetry (`compileOverlapMs`, `index_warming`, `native-minimal` resolution, symbol-first traced plan): needs **§30.28 implementation + P6 route + traced-plan fixture**; nobody has scheduled it (runbook Phase 2 tail) |
| **PERF-DIRECT-003/005/006** | 3 | In-grant edit latency (warm kernel + PTY readiness), fresh-install default preset, competitor checklist matrix — needs a **built candidate** (Phase 11) and reference WSL2 hardware |
| **LM-018** (attempted, never executed) | 1 | Two concrete blockers: (a) source-run bootstrap — `serve` dies with `Session supervisor startup failed … hz-kernel/host-*.sock` and `run` returns `Session not found` (P6 §5.1); (b) explicit authorization for the live free-model turn |
| **Families whose rows do not exist** | 0 | **TB-** (runbook Phase 1) and **PD-** (runbook Phase 6, §32 V1-ADAPT-007) are referenced by the runbook but absent from §32 — either add rows or delete the references before a coverage claim can be made |

Families that are zero-execution **but explicitly tracked as blocked** (not "forgotten"): PS (17), MPT (1), LS (14), UI (17 named), ACT (24), GS (10), SA (21), LANE (6), GRANT (17), PERF-DIRECT (3), HUP (7), JC-RES base (48) — prerequisites in the §1/§2 citations above.

---

## 4. Shortest ordered path from here to a complete acceptance suite

Each item lists what it unlocks. Order = dependency order; items 1–4 are on the critical path for everything else.

1. **Clear Phase 0's red sub-gate and the two cross-phase product blockers.** (a) overlay audit to `exit 0` (4 `HIDDEN_NEW_SOURCE` files → owners); (b) fix `Service not found: @horizoncode/WebSearchRuntime` which breaks `opencode serve` / `Server.Default()` (P6 §4, owner P5/P7 route tree); (c) fix source-run session bring-up (`hz-kernel` socket bind + `Session not found`, P6 §5.1, owner of the bootstrap path). → Unblocks Phase 10 journeys, LM-018, every HTTP route suite, and `release_gate`'s install matrix.
2. **Package-wide typecheck + full `cargo test` (A1 Run C → 0; B2).** Run C = 25 diagnostics; B2 = full `kernel` suite (today only filtered targets are green), including `tool_batch_guard_matrix` once the `GUARDED_PTY_RUNTIME_READY` decision is made. → Establishes the exact-revision baseline every later row needs; also re-runs JC-RES-012.C–L to settle the K/L coverage dispute.
3. **P1/P2 integrated Guard negative wave — runbook Phase 2 rows.** GRANT-001..017 + PERM-001..006 + §32.14 PS rows + §32.20 SE rows: denied-before-lease, lease reuse/widen, cancel→UNKNOWN→no-replay, plugin/MCP no-bypass, wrong-digest/out-of-grant argv, cross-capability lease substitution (currently short-circuited by the readiness gate), delegated-cgroup B4 (document UNSUPPORTED on this host rather than skipping). → Unblocks PS/GRANT (34 rows), the `BLOCKED_P2` sub-legs in 8 P3 rows, RD-017, and the CM/WS live halves.
4. **Fix the two readiness flags with evidence, or record UNSUPPORTED.** `GUARDED_PTY_RUNTIME_READY` / `GUARDED_TERMINAL_RUN_READY` currently turn 8 security assertions into `capability_unavailable`. Either produce the process-tree containment evidence and open them, or mark those rows UNSUPPORTED. → Unblocks EDITOR-001/002/004–009 (8), LS/DAP/REPL integrated journeys (14 + 4), and the 6 `tool_batch_guard_matrix` cases.
5. **Runbook Phase 3 remainder (P6/P7 legs):** CX-005/006/007/009/010/011/012, CTX-005, INST-004 (needs a delivery-root instruction-set builder — assign to P7 or P2). → Closes 11 rows; CX-005/006/007 additionally need the provider route from item 6.
6. **Runbook Phase 6 (P6):** FEAT-001..014 surface tests across TUI/GUI/HTTP (13 left), QA-001..007, P6-PROVIDER-001..004, define-or-drop the dangling `PD-*` reference, then the authorized **LM-018** live turn (harness already one command). → Closes 25+ rows and the last provider-dependent CX rows.
7. **Runbook Phase 7 (P7):** integrated TUI runtime rows — UI-001..007 (reconnect/focus/scroll), UI-017..019 (session/export), ACT-001..024 (cards + Ctrl+R review), UI-024..030 RAM caps on reference hardware, plus the 80×24 manual layout. → Closes 50 rows; also feeds Phase 10 reconnect journey.
8. **Runbook Phase 5 + 9 (P2, then parent):** SA/LANE/MPT/LH managed-lane rows and RC recovery rows — write the row tests (none exist), drive them on the authenticated HostRun binding P2 just landed, including `SA-009` child-result-after-compact and `LANE-004` multi-hop. → Closes 41 rows.
9. **Runbook Phase 8 remainder (P8):** schedule the prepared Cargo acceptance matrix; JC-RES-001..024 base workloads need live Session owner identities + matching outcomes + a trusted RC0 attestation source (currently an empty allowlist); GS-001..010 row tests; then 1/5/10/20 repeated measurements. → Closes 69 rows + makes PERF-DIRECT-001..006 measurable.
10. **Runbook Phase 10 end-to-end:** direct coding journey, managed journey (single Task → verifier PASS → multi-Task), context pressure (trim→compact→continue same model), reconnect (`UI-017`), HUP-001/002/006 paired arms — all on one exact revision. → Depends on items 1, 3, 6, 7, 8.
11. **Runbook Phase 11 to GO:** DEC-V1-11 licensing decision (root `UNLICENSED` vs 12× `MIT` vs Nix `MIT`), root LICENSE/NOTICE authoring, `bun run generate` for the two lagged generated clients (P1 §38: `check:generated` CI claim), candidate build, `install_matrix`, signing/update, fresh-WSL clean install, `horizoncode-release-qualification.yml`. → Closes the 20 `release_gate` blockers.

**Realistic accounting:** completing items 1–11 takes the audited 89/359 to 359/359 only if every family's row tests are actually written — 15 families currently have **no row test at all** (RC, UI, ACT, GS, SA, LANE, GRANT, PS, REL, SPD, MPT, LS, PERF-DIRECT, plus HUP-003/004/006/007/008). Writing those rows is the largest single unpriced chunk of remaining acceptance work.

---

### Evidence-integrity notes

- All numbers above come from commands printed in phase reports or HANDOFF. Where a report gives only a total (P7's "TUI focused 56/56", P4's "298/0 bundle", P8's "118 lib"), the command is printed but the **row→test mapping is the report's claim** (`SELF-REPORT` for the mapping, verified command for the count).
- P3 §22 is the only place where a phase executed its runbook rows *as rows*: 62 items, 43 executed, 0 assertion failures — the model this audit uses for "executed".
- Two internal contradictions to resolve before any VERIFIED claim: (1) **JC-RES-012.K/L** — P8's row→test map claims coverage, P8's later §7 audit says no dedicated test exists; (2) **overlay audit** — HANDOFF records rounds where `hidden_changed` was fixed to 0 while P9/P1 later rounds show `hidden_new_source=4`; re-run on the exact target revision rather than citing either.
- No phase report claims PHASE_VERIFIED; every phase is `PHASE_PARTIAL / NOT VERIFIED / NOT RELEASED`, and V1 is **PARTIAL / NOT VERIFIED / NOT RELEASED**.
- **Evidence-durability finding (this audit's own file included):** `git check-ignore -v reports/audit-v1-acceptance-coverage.md` → `.gitignore:6:*` — the entire `reports/` tree (all nine phase reports, the LEDGER, the typecheck/audit logs, and this file) is invisible to Git. The parent already fixed this class of problem for source files with exact `!` entries; **no equivalent exception exists for `reports/`**, so every command/count cited here would be lost from any commit. Parent action: add an exact `!/reports/` (or per-file) exception before staging acceptance evidence. Not done by this audit — `.gitignore` is outside the assigned write scope.

---

## 5. Acceptance-gap triage — 2026-10-25

This continuation maps the zero-run families and all 29 rows previously classified
never-run. It does not run tests, edit product code, invoke Git/Cargo/provider/package-wide
typecheck, or edit the phase ledger. Evidence locations below are source/test mappings, not
new run evidence; the execution status in §§1–3 remains unchanged.

### 5.1 Every zero-execution family

| Family / rows | Existing precise test/source mapping (not row acceptance) | Disposition / exact missing gate |
|---|---|---|
| PS-001..017 | Rust `kernel/tests/tool_batch_guard_matrix.rs`; `kernel/tests/effects_host_process.rs`; `kernel/src/guard.rs` tests; Core `packages/core/test/process-guard.test.ts`, `tool-bash.test.ts`; P1 report §§14–15 | No cited command covers these catalog rows. Matrix cases currently stop at false PTY readiness (`capability_unavailable`), and the cross-capability integrated negative is still short-circuited. Remaining exact runtime/OS grants and denials are P1/P2-owned; unavailable effects stay closed. |
| RC-001..011 | Adjacent but not row-mapped: `packages/opencode/test/session/retry.test.ts`, `session/processor-effect.test.ts`, `packages/opencode/test/session/llm.test.ts`; Rust `effect_host_principal` / `effect_host` recovery tests; P8 `scripts/perf/test_rc0.py` | No RC row executed. Retry/parser tests do not exercise deterministic repair/loop suppression, rollback, disk-pressure cleanup, or crash-after-effect as cataloged. A full RC journey requires the P1/P2 HostKernel/effect lifecycle; RC-010 additionally requires a trustworthy pressure/retirement owner. Do not treat adjacent tests as RC PASS. |
| MPT-001 | Adjacent tests: `packages/opencode/test/session/managed-control.test.ts`; Rust `kernel/tests/managed_control.rs`, `task_dag.rs`; P2 report continuations 26/30 | No row execution. Needs an authenticated managed provider turn with persisted intermediate/final settlement and exact HostKernel pins; the nearby reducer/DAG tests are not this journey. |
| LS-001..014 | P4 local protocol tests under `packages/opencode/test/lsp/`, plus DAP/REPL suites; P4 report's 298/0 bundle | Bundle is not row-mapped. Row acceptance needs the owning supervised/editor process and Guard/HostKernel boundary. P4 report identifies integrated journeys and P1/P2 readiness as blockers; no tests added from this audit. |
| UI-001..007, UI-017..030 (the 17 blocked rows) | `packages/tui/test/context/data-stream.test.tsx`, `component/activity-stream.test.tsx`, `util/artifact-render.test.ts`, `util/tui-analytics.test.ts`; Core `session-runner.test.ts`; P7 report §Scope | Existing component/runner tests are focused evidence only. Reconnect, focus/scroll, 10K history and reference-hardware/RAM rows need integrated TUI runtime; UI-024..030 require actual controlled measurements. |
| ACT-001..024 | `packages/tui/test/component/activity-stream.test.tsx`, `activity-cards.test.ts` (9 tests/73 expectations reported in CURRENT_RUN); P7 report §Scope | No row-executing command. Projection/render tests do not cover actual session lifecycle, activity/review affordances, or Ctrl+R journeys. Requires integrated TUI runtime; no synthetic UI runtime was created. |
| GS-001..010 | No row-specific suite found in `packages/*/test` or `kernel/tests`; adjacent Rust worker/worktree lifecycle tests in `kernel/src/{worker_pool,worktree_pool,worker_durable}.rs` | No GS row execution. Existing tests cover specific lease/recovery invariants, not user-dirty workspace preservation, two-branch merge, disk-cap reclamation, or requested-file-only commit. Exact owner/system journeys are absent; Git operations were expressly out of scope here. |
| SA-001..021 | `packages/opencode/test/tool/task.test.ts`, `test/tool/registry.test.ts`, P2 managed control tests; root-agent orchestration is described in policy/docs | No SA row execution. These tests cover selected tool/profile behavior, not the full delegation, concurrency, interruption, parent compact, restart, or phase-DAG acceptance. SA-015/016 are browser surfaces explicitly post-V1 per §17.11 and are architecture N/A for V1; remaining rows require real agent lifecycle/delegation evidence and may not be inferred from this audit session. |
| LANE-001..006 | Adjacent Core direct-session runner tests and Rust managed-control/DAG tests (`packages/core/test/session-runner.test.ts`; `kernel/tests/{managed_control,task_dag}.rs`) | No row attribution or lane-parity journey. Direct and managed acceptance need integrated authenticated producer/evidence paths; P2 and parent Phase 10 are exact owners. |
| GRANT-001..017 | P1 Rust `guard`/`effect_host` and integration targets; Core `session-supervisor-launch.test.ts`, `session-revert-principal.test.ts`, `process-guard.test.ts` | No GRANT row command. Fixture-level principal/lease tests are not the grant lifecycle, revocation, drift and no-bypass journeys. P1/P2 integrated Guard acceptance remains prerequisite; preserve false readiness gates. |
| REL-001..002 | No exact test found in `packages/*/test`, `kernel/tests`, or `scripts`; adjacent P7 TUI stream/activity suites and P8 resource-state unit tests | No row execution and reports do not assign an existing consumer test. REL-001 needs UNKNOWN-receipt reconciliation copy in an integrated TUI; REL-002 needs authenticated soft-pressure consumer and one-time auto-trim preserving Goal line. P7/P8 wiring absent; not N/A to V1. |
| PERF-DIRECT-001..006 | No run evidence. Existing provider/context suites and P1-11 client source inspection are not benchmark fixtures. | All performance assertions require controlled matched measurements. In particular PERF-DIRECT-001 and every other measurement row remain `MEASUREMENT_NOT_RUN` absent actual controlled runs; never infer from test timings or source inspection. PERF-DIRECT-003/005 need an exact built candidate; PERF-DIRECT-006 needs completed parity matrix. |
| SPD-A..D | No speed-compiler telemetry or traced-plan test identified in `packages/*/test`; adjacent context compile, RepoIntel and harness-profile tests do not emit the specified telemetry/trace | No row execution. No exact implemented telemetry/fixture exists to test offline. Needs §30.28 implementation and its P6 route/context compiler integration. |
| LM-018 | `packages/opencode/test/e2e/free-model-smoke.test.ts` (**37/0, 101 expectations**) verifies the offline gate only; P6 §5.1 records the authorized attempt stopping pre-dispatch at `Session not found` | **NOT_RUN**, not blocked by a provider result: zero provider requests left the machine. Do not call the provider in this triage; source-run Session/bootstrap must work and a new live turn requires explicit authorization. |
| TB-* and PD-* | No catalog rows (confirmed against §32; only references in runbook/summary catalog) | Architecture/catalog N/A as acceptance IDs: zero rows exist to execute or count. Parent/catalog owner must reconcile dangling references; this audit does not add acceptance requirements or rows. |

### 5.2 The 29 never-run rows, individually enumerated

| Rows | Closest existing test(s) and what they actually cover | Why not executed / classification |
|---|---|---|
| RC-001 | `packages/opencode/test/session/processor-effect.test.ts` structured-JSON retry cases; no syntax-patch diagnosis fixture | Needs deterministic repair/diagnosis implementation plus a real patch/test loop; no exact offline fixture found. |
| RC-002 | `packages/opencode/test/session/retry.test.ts` delay/retry policy | Does not test same normalized error + unchanged state suppression; RC row not run. |
| RC-003 | Same retry suite; no source/test progress loop detector mapping | Does not distinguish progress under repeated normalized errors; RC row not run. |
| RC-004 | `packages/opencode/test/session/llm.test.ts` stream failure classification | No circuit-health observation row/route journey identified; provider health behavior remains unaccepted. |
| RC-005 | `packages/opencode/test/session/processor-effect.test.ts` retryable midstream server error; P5 web-search retry suites | Adjacent same-route retry behavior only; no RC row command or post-5xx recovery journey. |
| RC-006 | No test for advisory repair-pattern source/framework mismatch found | No repair-pattern recommender fixture/source surfaced; exact gap remains unimplemented/unmapped. |
| RC-007 | No candidate-repair rollback/rejected-suite regression test found | Requires an actual candidate patch + before/after suite and safe rollback boundary; no offline row fixture identified. |
| RC-008 | `kernel/src/guard.rs` deny tests are lower-level and not repair-candidate acceptance | No row test proving a repair proposal cannot widen permissions; needs integrated policy/repair flow. |
| RC-009 | `effect_host_principal` and Rust `effect_host` restart/UNKNOWN tests; `packages/opencode/test/session-runner.test.ts` lost-response UNKNOWN tests | These are adjacent effect/provider-journal cases, not the catalog's process crash after external effect request with reconcile-before-retry. P1/P2 integrated runtime and exact RC test attribution required. |
| RC-010 | P8 `scripts/perf/test_rc0.py` validates bounded disk-root measurement; resource sampler/budget unit tests | No safe-cache cleanup under actual disk pressure and preservation of evidence/user work. Requires authenticated retirement owner; hard quota remains unsupported. |
| RC-011 | `packages/opencode/test/session/processor-effect.test.ts`, `session/llm.test.ts`, `session/retry.test.ts`; P5 web-search receipt/retry tests | Existing tests cover selected retry mechanics only, not the complete pinned-route/stream-drop/incomplete-tool-batch/UNKNOWN/no-duplicate-effect matrix. No provider invocation authorized here; integrated route remains blocked. |
| UI-008 | `packages/tui/test/component/artifact-markdown.test.tsx` | Rendering unit tests do not establish safe Mermaid rendering in the integrated TUI or this catalog row. |
| UI-009 | Same artifact-markdown test | No row-attributed malformed/oversized Mermaid source-fallback journey; renderer test is not enough to claim it. |
| UI-010 | TUI `util/artifact-render.test.ts`; Core artifact-control tests | Artifact preview mechanics exist, but no generated-artifact exact-byte open/download UI journey or row command. |
| UI-011 | P4 LSP/editor helper tests | No integrated editor language-change lazy-extension/diagnostics UX row run; editor launch prerequisites remain gated. |
| UI-012 | P7 activity stream/card component tests | Component projection does not establish background event focus/scroll behavior in live TUI; no row run. |
| UI-013 | No exact responsive/narrow-window state-preservation test found | Requires rendered TUI layout and draft/selection preservation; integrated TUI runtime absent. |
| UI-014 | P1 `session-supervisor-launch.test.ts` / P4 settings/editor tests are not keyboard journeys | Keyboard-only approval flow needs rendered interaction; no exact test or manual evidence. |
| UI-015 | No reduced-motion status-preservation test found | Requires UI behavior under reduced-motion preference; no row-level test. |
| UI-016 | Core runner/event tests cover portions of input lifecycle; no exact queued/steered-input reconnect case mapped | Needs active provider/tool lifecycle and reconnect integration; no current test proves ordered, no-loss/no-duplicate semantics. |
| REL-001 | No dedicated test found. P7 artifact/activity suites test projections, not reconcile copy | Requires integrated UNKNOWN receipt and user-facing reconciliation text; currently absent. |
| REL-002 | No dedicated test found. P8 pressure math tests have no UI consumer | Requires authenticated pressure ingress plus P7 one-time auto-trim UI behavior; both prerequisites absent. |
| SPD-A | No `compileOverlapMs` telemetry assertion/test found | §30.28 speed compiler telemetry is not wired; no offline row test to run. |
| SPD-B | RepoIntel/index warming tests do not inspect first-open send responsiveness + `index_warming` UX | No exact telemetry/UI row; needs P3/P6 integrated route. |
| SPD-C | Harness-profile tests cover explicit profile selection, not automatic `native-minimal` resolution at 8K | No row-level context-budget selection fixture found; implementation/route gate unresolved. |
| SPD-D | RepoIntel tests cover selectors, not a traced-plan first-action assertion | No traced-plan fixture or tool-use trace row found; §30.28 dependency remains. |
| PERF-DIRECT-003 | No controlled in-grant write benchmark | `MEASUREMENT_NOT_RUN`; warm kernel, actual grant/write and reference WSL2 hardware required. |
| PERF-DIRECT-005 | P9 static release-readiness/installer tests are not a fresh candidate | `MEASUREMENT_NOT_RUN`/candidate evidence absent; needs fresh built install and default-preset/help verification. |
| PERF-DIRECT-006 | `arch_V1/46-V1-MIGRATION-PARITY.md` is the matrix definition, not completed evidence | `MEASUREMENT_NOT_RUN`; requires completed comparator checklist on the exact candidate, not architecture text. |

No safe offline test was added: every never-run row either lacks the behavior/fixture, requires a live authenticated runtime or rendered journey, or (for the PERF rows) is explicitly a measurement. Adding a local mock would be non-acceptance evidence and risk inflating coverage. **LM-018 remains NOT_RUN**: no provider was called in this triage; its prior attempt stopped before dispatch with `Session not found`. **PERF-DIRECT measurements remain MEASUREMENT_NOT_RUN.**

### 5.3 JC-RES-012.K/L discrepancy resolution

Read-only source inspection confirms both Rust test functions are actually present in
`kernel/tests/support/jc_res_012_wire_tests.rs`, included by `kernel/src/worker_pool.rs:3351–3352`:

- K: `jc_res_012_k_impersonation_never_allocates_capacity_or_attempt_slots`
  (lines 260–426): guessed ticket, forged Session/workspace/principal, stale owner
  epoch, forged Attempt/spec binding, unchanged capacity/no worker on denials, then
  exactly one genuine admission and second-worker reuse denial.
- L Rust half: `jc_res_012_l_provider_cost_and_token_grants_are_owner_epoch_scoped`
  (lines 428–537+): foreign owner and stale epoch denied, unknown provider-cost
  quota blocks admission, no debits/workers on denial, exact token grant admitted
  once. This does **not** cover the Doctor RPC half; that remains P6-owned/open.
- Latest cited execution is P2 `cargo test --lib jc_res_012` → **4 passed / 0 failed**
  (P2 report continuation 30, 2026-10-25). P8's broader earlier mapping said the
  same target covered K/L, while its later §7 audit said no dedicated K/L tests
  were found. The source settles the presence dispute: both are dedicated functions
  in the included module and the named target was executed. It does not settle
  authenticated ingress/Doctor or cross-phase integration. Thus K and Rust-L are
  present and unit-tested; JC-RES-012.L Doctor ingress remains absent/open; TS
  consumer remains absent (`reservation-wire-v1.json` declares
  `consumers.typescript: null`).

Triage totals: **29/29 never-run rows mapped**; 0 newly run; 0 new tests written;
the executive summary's “15 zero-execution families” appears arithmetically inconsistent
with its explicit list, which contains **14** (PS, RC, MPT, LS, UI, ACT, GS, SA,
LANE, GRANT, REL, PERF-DIRECT, SPD, LM-018). All 14 are individually mapped
above; two dangling non-families TB/PD are marked catalog N/A. No runtime,
release, or phase status was promoted. V1 remains **PARTIAL / NOT VERIFIED / NOT
RELEASED**. Exact discrepancy/evidence is reported here for parent serialization;
`reports/phases/LEDGER.md` was not edited.
