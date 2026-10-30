# V1 wire tracker — implementation to completion

**Use with:** [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md) (row IDs), [`HANDOFF.md`](../HANDOFF.md) (evidence), [`46-V1-VERIFICATION-RUNBOOK.md`](46-V1-VERIFICATION-RUNBOOK.md).

**Snapshot:** 2026-10-26 (historical registry; reconciled with code + [`46-V1-SOURCE-ALIGNMENT-AUDIT.md`](46-V1-SOURCE-ALIGNMENT-AUDIT.md) §5). Update **Status** to **Done** only when **WIRED** with §32 acceptance on a cited revision (`HANDOFF.md`). **Partial** = CODE_PRESENT and/or focused tests — not VERIFIED. **Counts derivable from the tables below (counted 2026-10-29): 0 Done · 73 Partial · 12 Not done · 1 N/A across 86 ID rows** (CP-01–06, W-P0…W-P9, X-01–06, PB-01–05, FIN-01–07). Including the 5 exposure-tier rows and the 5 "explicitly not V1 wiring" rows the file has 96 rows: **0 Done · 76 Partial · 13 Not done · 7 N/A**. `code_present` is not a status value in this file.

**2026-10-29:** sub-suite evidence (V1-RUST-VERIFY 32/32, V1-FINAL-VERIFY 31/31, tool_batch_guard_matrix 9/9) is sub-suite acceptance, NOT wire acceptance; wire status unchanged (0 wired). Do not mark rows Done without §32 acceptance on a cited revision.

**2026-10-29 — correction to the registry line.** Until today the header read "226 designed / 4 `code_present` / `0 wired` of 230". Those numbers were **never derivable from this file's rows**: the tables hold 86 ID rows (96 with the tier and out-of-scope tables), carry no `code_present` column or value, and contain no `Done` row at all — `code_present` appeared only in that header sentence, and 226/230 are backlog-ID totals, not row counts here. Counted on 2026-10-29 by tallying the Status column: **0 Done · 73 Partial · 12 Not done · 1 N/A**. Separately, the §30.29 ACC bundle is not tracked here: ACC-G/H/J have no wire row at all, and ACC-F is the only one that does (W-P4-05, Partial, `packages/opencode/src/tool/apply_patch.ts:433-469`).

## Status legend

| Status | Meaning |
|---|---|
| **Not done** | No accepted end-to-end wire; may have partial source |
| **Partial** | Source or unit tests exist; integration/acceptance not VERIFIED |
| **Done** | Independent acceptance evidence on recorded revision |
| **N/A** | Explicitly out of V1 scope |

**Policy:** Until **P1** + **direct transport (P6/P7)** are **Done**, keep effectful tools **fail-closed**, not “mostly working.”

---

## Critical path (blocks effectful + honest direct coding)

| ID | Wire | Phases | Backlog | Normative / tests | Status |
|---|---|---|---|---|---|
| CP-01 | ToolBatch → Guard → PREPARE → one-use lease → ExecutionHost → receipt/UNKNOWN on every mutation origin | P1 | P1-01–03 | §10.3, §32.14 TB-*, PS-* | Partial |
| CP-02 | `terminal.run`: shell mode + fixed-argv workspace profiles (no shell text on profile path) | P1, P7 | P1-05, P7 (runner) | §37.27, DEC-V1-28, GRANT-* | Partial |
| CP-03 | Sandbox/cgroup containment + quiescent cleanup (no PTY/legacy bypass) | P1, P8 | P1-04, P8-02 | `horizoncode-sandbox`, JC-RES-* | Partial |
| CP-04 | Direct provider send: selected route → Auth → fetch → EventV2 settlement + UNKNOWN recovery | P6, P7 | P6-02, P7-07 | DEC-V1-32, LANE-004 | Partial |
| CP-05 | Context ledger compile → dispatch with pinned ContextSelection | P3, P6, P7 | P3-03–04, P6-02, P7-02 | §30.2, CTX-* | Partial |
| CP-06 | CodeMode: HostKernel waves, nested ToolBatch, durable receipts (no caller lease) | P1, P2, P5, P7 | P1-08, P2-07, P5-02, P7 | §37.24, CM-* | Partial |

---

## P0 — Base

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P0-01 | Preserve single OpenCode-derived runtime tree | P0-01 | §20, §01 | Partial |
| W-P0-02 | Provenance pins (`42`, `repo_take`) | P0-02 | §42 | Partial |
| W-P0-03 | Install/build/release scripts ↔ qualification gates | P0-03 | §18, §10.11, §32 release | Partial |

---

## P1 — Guard / ExecutionHost

**Phase exit:** §10.3; §32.49 read-path parity on warm kernel.

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P1-01 | End-to-end ToolBatch, leases, receipts, UNKNOWN on all enabled origins | P1-01–03 | §14, §32.14, §32.19–20 | Partial |
| W-P1-02 | Product containment matrix (not crate-only) | P1-04 | §14.18+, PS-* | Partial |
| W-P1-03 | V2 bash/shell through HostKernel (Core bash fail-closed today) | P1-05 | §32.7, GRANT-* | Partial |
| W-P1-04 | SessionLink observer: ACK, replay, crash recovery | P1-06 | §13, §32.12 LANE-* | Partial |
| W-P1-05 | SecretBroker → credentialed effects only via Guard | P1-07 | §05, §32.21 | Partial |
| W-P1-06 | CodeMode + external editor EffectHost binding + recovery | P1-08–09 | §37.24, §37.28, EDITOR-* | Partial |
| W-P1-07 | **DEC-V1-36** read fast path + batched read RPC (Core classifier) | P1-10 | §14.3.1, PERF-DIRECT-002,004 | Partial (`direct-read-batch.ts`, kernel RPC; PERF-DIRECT not run) |
| W-P1-08 | Warm kernel IPC pool (provider not blocked on cold start) | P1-11 | §13.2, PERF-DIRECT-001 | Not done |

---

## P2 — Managed control plane

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P2-01 | Goal/Run/Task/Attempt lifecycle | P2-01 | §11, §32.9 | Partial |
| W-P2-02 | Per-Task verifier + aggregate Run settlement | P2-03 | DEC-V1-31, MPT-001 | Partial |
| W-P2-03 | Bounded multi-Task DAG on distinct Locations | P2-02 | §29.18, §21, SA-* | Partial |
| W-P2-04 | `managed_context.advance` + OwnerLog digest | P2-04 | §30.24, CTX-* | Partial — `managed_context.advance`/OwnerLog work exists, but automation dispatch in this phase is inert: `AUTOMATION_INVOCATION_ENABLED=false` (`kernel/src/automation.rs:27`), `runNow` refuses (`packages/opencode/src/session/automation-control.ts:472-493`), and no cron/timezone resolver or due-occurrence producer exists (`kernel/src/automation.rs:104-105,270-276`). |
| W-P2-05 | `providers.infer` through Guard | P2-05 | §37.23, LANE-003 | Partial |
| W-P2-06 | Direct artifact API + root inspect/range/cancel for P7 | P2-06–07 | §37.12, artifact §32.16 | Partial |
| W-P2-07 | CodeMode managed start (no caller lease) | P2-07 | CM-* | Partial |

---

## P3 — RepoIntel + context

**Phase exit:** §10.5; `repo.tree` / `repo.detect` only when P1+P3 acceptance green.

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P3-01 | `ensure_generation` / `query_structure` | P3-01 | §30.22–23, RD-* | Partial — indexd is lexical-only (`indexd/src/repo_intel.rs:6-8`); symbol/reference/impact return typed unsupported (`indexd/src/repo_intel.rs:93-100`), single `blake3` dependency (`indexd/Cargo.toml`). |
| W-P3-02 | Expose `repo.tree` / `repo.detect` when gated | P3-02 | §33.5, V1-ADAPT-004 | Partial |
| W-P3-03 | ContextSelection pin (direct) | P3-03 | DEC-V1-32, CTX-001 | Partial |
| W-P3-04 | ContextLedger compile + stream aligned to §30.2 | P3-04 | CTX-001–005 | Partial |
| W-P3-05 | §30.26 compile policy + `repo-context-anchor` | P3-05 | CX-014–021 | Partial (`context-compile-policy.ts`; provider legs NOT_RUN) |
| W-P3-06 | `/trim`, `/prune`, `/compact`, pressure step-0 auto-trim | P3-06 | CX-001–010, §30.4 | Partial |
| W-P3-07 | Progressive `tools.search` / harness minimal default | P3-07 | §31.21, CX-008 | Partial |
| W-P3-08 | Bounded history SQL | P3-08 | CX-004, UI-019 | Partial |
| W-P3-09 | §29.23 project instruction resolver (AGENTS.md on-demand) | P3-09 | CX-022–025, INST-* | Partial (`project-instruction.ts`; INST-* integration open) |
| W-P3-10 | §30.28: compile/provider overlap, symbol-first, async index | P3-10 | SPD-A,B,D | Not done |
| W-P3-11 | Session import/export | P3-11 | REL-N, §42 | Partial |

---

## P4 — LSP / DAP / REPL / editor

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P4-01 | LanguageServiceBroker + repo reads via HostKernel | P4-01–02 | §37.6, LS-* | Partial |
| W-P4-02 | DAP broker | P4-03 | §37.7, §32.28 | Partial |
| W-P4-03 | REPL broker | P4-04 | §37.8 | Partial — no importers outside `packages/opencode/src/repl/`; 2,993 src lines are unreachable from product entry points, and `GUARDED_REPL_RUNTIME_READY=false` (`packages/opencode/src/repl/lifecycle.ts:952`). |
| W-P4-04 | `/editor`: saved profile, Guarded launch, Explorer preview | P4 UX | §16.20, §37.28 | Partial |
| W-P4-05 | Post-patch LSP diagnostics in tool results (accuracy) | ACC bundle | §30.29 ACC-002 | Partial (`apply_patch.ts` schedule + `lsp/diagnostic.test.ts`; E2E open) |

---

## P5 — Web search + CodeMode

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P5-01 | `web.search` cascade + route receipts; no hidden paid fallback | P5-01 | DEC-V1-26, WS-* | Partial |
| W-P5-02 | CodeMode helper package, confinement, P2 lifecycle, P7 nested dispatch | P5-02 | CM-* | Partial — hard-disabled: `CODE_MODE_HELPER_RUNTIME_READY=false` (`packages/opencode/src/tool/code-mode.ts:21`); `codeModeEnabled` has no production caller (only `packages/opencode/test/tool/code-mode-adapter-contract.test.ts:355-359`). |
| W-P5-03 | Browser/desktop surfaces | P5-03 | A-V2-31 | N/A |

---

## P6 — Providers / settings / Doctor / exposure

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P6-01 | Models.dev catalog | P6-01 | PD-*, FEAT-* | Partial |
| W-P6-02 | Direct transport + SessionStore journal; P7 frozen payload caller | P6-02 | LANE-004, §32.21 | Partial |
| W-P6-03 | Provider Doctor tiers (spend = consent) | P6-03 | §32.31 PD-* | Partial |
| W-P6-04 | FeatureExposureV1 ↔ real capability status | P6-04 | FEAT-001–014 | Partial |
| W-P6-05 | AgentProfileV2 kernel ↔ Core config | P6-05 | §32.12 | Partial |
| W-P6-06 | **Horizon Coding Profile** (DEC-V1-37): preset, permissions, harness auto-pick | P6-06 | §16.19.1, PERF-DIRECT-005 | Partial (`coding-profile.ts` + tests; Settings chip consumer P4/P6) |
| W-P6-07 | **DEC-V1-38** tiers + TUI effective tool/skill chips | P6-07 | EXP-001–005, §16.19.2 | Partial |
| W-P6-07a | Sealed `builtin.horizoncode` in skill registry | P6-07 | EXP-002 | Partial |
| W-P6-07b | Core/Extended/Experimental enforcement in `tools.search` / exposure | P6-07 | EXP-003–004 | Not done |

---

## P7 — TUI / streams / artifacts

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P7-01 | UiEventMux / stream lanes | P7-01 | UI-001–007 | Partial |
| W-P7-02 | Context bar ↔ ledger projection | P7-02 | CTX-002, UI-* | Partial |
| W-P7-03 | Activity digest §31.22 (not in model context) | P7-03 | ACT-001–024 | Partial |
| W-P7-04 | Artifact render service | P7-04 | UI-008–010 | Partial |
| W-P7-05 | Checkpoints / rewind UI | P7-05 | CP-001–002, DEC-V1-25 | Partial |
| W-P7-06 | Automations UI ↔ control API | P7-06 | AU-* | Partial |
| W-P7-07 | Provider settlement + UNKNOWN user copy | P7-07 | UI-017, REL-001 | Partial |
| W-P7-08 | §31.23 code display / highlight RAM budget | P7-08 | UI-024–030 | Partial (`code-display.ts` + tests; UI-024–030 not measured) |
| W-P7-09 | Slash parity: `/debug effects`, `/view activity`, context-op help | P7-09 | §16.4.1, §31.24 | Partial (slash wired in TUI; **0** dedicated acceptance tests) |

---

## P8 — Worktrees / resources

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P8-01 | Worktree pool + leases → P2 multi-Task | P8-01 | §21, GS-* | Partial |
| W-P8-02 | Resource sampler / pressure ladder (trim, stop subagents) | P8-02 | §18.18, JC-RES-* | Partial |
| W-P8-03 | Distinct-Location multi-Task admission | P8-03 | DEC-V1-31, VEO-021 | Partial |
| W-P8-04 | Cache registry retirement under pressure | P8-04 | JC-RES-012 | Partial |

---

## P9 — Release

| ID | Wire | Backlog | Normative / tests | Status |
|---|---|---|---|---|
| W-P9-01 | `horizoncode` / `hzcode` clean install smoke (Linux/WSL) | P9-01 | §18, install smoke | Partial |
| W-P9-02 | CI qualification workflow end-to-end | P9-02 | `.github/workflows/` | Partial |
| W-P9-03 | Upgrade / migration / signing / rollback + evidence | P9-03 | §32 release rows | Not done |

---

## Cross-phase edges

| ID | Edge | Wire | Backlog deps | Owner | Status |
|---|---|---|---|---|---|
| X-01 | P1 receipt → P7 tool tail | Stream tool results from Guard receipts | P1-01, P7-01 | §31.16 | Partial |
| X-02 | P2 `managed_context.advance` → P6 transport | Managed prompt digest on send | P2-04, P6-02 | §30.24 | Partial |
| X-03 | P1 `files.read` → P3 generation | Read path feeds RepoIntel | P1-10, P3-01 | §30.22 | Partial |
| X-04 | P1 EffectHost → P2 CodeMode persistence | Durable wave/receipt rows | P1-08, P2-07 | §37.24 | Partial |
| X-05 | P6 models.dev → P3 §30.26 compile tiers | Route-aware compile policy | P3-05, P6-01 | §37.30 | Not done |
| X-06 | P8 lease → P2 DAG | Distinct Location per ready Task | P8-03, P2-02 | DEC-V1-31 | Partial |

---

## Product excellence bundle (DEC-V1-36–38, §30.27–30.30)

| ID | Theme | Designed (arch) | Wire rows | Still open (summary) | Status |
|---|---|---|---|---|---|
| PB-01 | Speed (`DEC-V1-36–37`, §30.28) | Yes | W-P1-07, W-P1-08, W-P3-10, W-P6-06 | Read fast path, warm IPC, overlap compile, symbol-first | Not done |
| PB-02 | Accuracy (§30.29, verifier, edit loop) | Yes | W-P4-05, W-P2-02, FIN-06 | LSP on patch, managed verifier, HUP holdout | Partial |
| PB-03 | Reliability (UNKNOWN, checkpoints, import) | Yes | W-P1-01, W-P7-05, W-P7-07, W-P3-11, W-P3-06 | UX copy, restore, import, pressure trim | Partial |
| PB-04 | Capabilities (`DEC-V1-38`) | Yes | W-P6-07, W-P6-07b | Tier enforcement + honest “N effective” chips | Partial |
| PB-05 | Long horizon (§30.27, context-recovery) | Yes | W-P3-06, W-P7-09, W-P3-05 | Epoch slashes, recovery skill body, compile policy | Partial |

---

## V1 coding kit exposure (tiers — not all 230 IDs)

| Tier | Wire scope | Primary rows | Status |
|---|---|---|---|
| Core | files read/patch (`read`/`write`/`apply_patch`/`edit` → §33.5), git read, terminal (profile), search, `task`, `skill`/`skills.search`, context ops, `web.search` if enabled | CP-01–02, W-P3-07, W-P6-07, W-P5-01 | Partial |
| Extended | `repo.tree`, symbols, LSP actions, history search, CodeMode when accepted | W-P3-02, W-P4-01, W-P3-08, W-P5-02 | Partial |
| Experimental | Opt-in RepoIntel full, embeddings, etc. | W-P3-05, W-P6-04 | Not done |
| Managed | goal/run/task + `builtin.verifier` (optional Goals) | W-P2-01–02 | Partial |
| Post-V1 | `browser.*`, `desktop.*`, full GUI | W-P5-03 | N/A |

**Per capability promotion:** registry status → HostKernel route (if effectful) → §32 row → exposure tier.

---

## Final integration (after source closure)

| ID | Wire | Normative / tests | Status |
|---|---|---|---|
| FIN-01 | Real CLI/TUI coding journeys (direct default, optional managed) | §32, `implementationtov1release.md` | Not done |
| FIN-02 | Guard bypass negatives; cancel/crash/restart/UNKNOWN recovery | §32.14, RC-* | Not done |
| FIN-03 | `bun run horizoncode:typecheck` + §32 family matrices | A1 | Not done |
| FIN-04 | Architecture MD validators (structure) | `audit_markdown_repo.py`, `validate_convergence.py` | Partial |
| FIN-05 | Linux/WSL clean install, migration, release qualification | P9-02, P9-03 | Not done |
| FIN-06 | HUP-001/002 holdout (harness vs capability) | DEC-V1-34 | Not done |
| FIN-07 | Authorized commit/push/release with exact evidence | §18, K6 | Not done |

---

## Explicitly not V1 wiring

| Item | Decision | Status |
|---|---|---|
| Web/desktop app shell | A-V2-31 | N/A |
| Browser automation / desktop control | post-V1 | N/A |
| Native Windows shipped primary | V1 Linux/WSL-first | N/A |
| Broad `@opencode-ai/*` package rename | §10.12 post-V1 | N/A |
| Horizon as MCP **server** | DEC-V1-23 | N/A |

---

## Suggested wire order (parallel where safe)

1. **P1** — CP-01–03, W-P1-07–08 (effect + terminal + read fast path)  
2. **P6 + P7** — CP-04–05 (direct coding loop)  
3. **P3** — W-P3-05, W-P3-10, W-P3-06 (context + §30.26 + speed)  
4. **P2 + P8** — W-P2-03, X-06 (managed vertical then DAG)  
5. **P4 + P5** — brokers, search, CodeMode enablement  
6. **P7** — W-P7-08–09 (remaining UX)  
7. **P9 + FIN-*** — release gates  

When any row becomes **Done**, update this file, the matching backlog row in [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md), and [`HANDOFF.md`](../HANDOFF.md) with command + revision.
