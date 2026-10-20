# HorizonCode — paste-ready handoff prompt for the next coding agent

Copy everything inside the block below into the new agent session. File paths are relative to the repo root `/home/sarvesh/business_Dev/agentx`.

---

**You are taking over HorizonCode V1 implementation — parent orchestrator + implementation owner.**

HorizonCode is a Linux/WSL-first, provider-agnostic coding agent (CLI/TUI) built on an OpenCode-derived Core, with a Rust kernel owning Guard/ExecutionHost mediation, managed Goal/SpecVersion/Run/Task/Attempt execution, effect leases/receipts, resources and durable automation. V1 is **not** complete and **not** released: phases are PARTIAL with recorded evidence and blockers; all previous agent sessions are stopped; nothing was committed or pushed.

**1. Read these completely, in order, before any action** (do not skim; the ledgers are dense and load-bearing):
1. `AGENTS.md` (repo root) — controlling execution policy: one subagent per **whole phase** (large, never small slices), maximum safe parallel fan-out, Guard/security non-negotiables, dirty-tree/cleanup rules. Upstream `packages/**/AGENTS.md` files are package coding hints only — the root file governs.
2. `CURRENT_RUN.md` — especially the **"2026-10-18 — HANDOFF LEDGER"** section and later sections: the single dirty tree, file-group→workstream ownership map, subagent roster with session IDs, verified-evidence stamp, gotchas, stop outcome, and the competitive desk-analysis.
3. `HANDOFF.md` — concise observed status + phase table.
4. `implementationtov1release.md` — V1 scope, tracker, and the **"Explicit remaining work"** ledger (implementation / verification / tests / real-case acceptance / user-decision items). This is your work queue.
5. `arch_V1/README.md` → `arch_V1/17-GOVERNANCE-DECISIONS.md` — architecture authority order + binding decisions (includes amended A-V2-27: `horizoncode` canonical + `hzcode` short command, same entrypoint/runtime).
6. `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` — the operative plan (gates, RC0–RC5; see its "2026-10-16 — V1 scope decision").
7. `docs/agent-tool-routing.md` — which MCP/skill/tool to use when.
8. Only the phase-specific architecture owners you actually need (`arch_V1/20` local source placement; `arch_V1/37` runtime services; `arch_V1/33` capability IDs; `arch_V1/32` acceptance cases; `arch_V1/42` only for external-source work).

Then reload durable memory: Engram `mem_context` (`project=horizoncode`) + a targeted `mem_search` for the active phase or blocker.

**2. Think before every change (required habit)**
- Read the owning architecture section, the exact source file(s), their callers and their tests before editing anything. Never edit from memory of a summary.
- Decide the source decision explicitly (`REUSE / ADAPT ALGORITHM / ADAPTER / REJECT`) for any external code, with the exact pin + license/notice check per `arch_V1/42`.
- Check Guard/lease/permission implications before writing: if the path mutates or executes, it crosses Guard/ExecutionHost or stays disabled. Reads should not take Guard round-trips — keep the direct loop lean.
- Add/extend tests with the change (positive + negative + recovery), then keep going — do not stop after one green test.

**3. Execution shape**
- Resume the recorded phase-owner sessions where the platform allows continuations (session IDs are in the handoff ledger); otherwise dispatch fresh owners — **one accountable subagent per entire phase (P1…P9)**, never tiny slices.
- Start every safely runnable phase immediately, in parallel, at the maximum real concurrency; phases with blocked effectful wiring still progress their independent parts (adapters, tests, fixtures).
- One heavyweight Rust/TS build at a time on this WSL machine.
- Machine hygiene: check `git status --porcelain=v1`, `git worktree list`, `ps` (no competing builds), `df` before starting; preserve everything.

**4. Hard rules (violating any of these fails the task)**
- Dirty tree is preserved: one worktree, ~150 staged / ~71 unstaged / ~20 untracked paths, nothing committed/pushed. No `git add .`; no stage/commit/push/clean without explicit user authorization of exact paths.
- Guard/ExecutionHost: every enabled mutation origin crosses it or stays disabled; denied/UNKNOWN paths spawn zero effects; no bypass from plugins/MCP/LSP/DAP/REPL/automation/subagents. Keep fail-closed paths disabled rather than "temporarily enabling" them.
- Provider/model choice is explicit and pinned per turn; **no hidden paid fallback**; free models (documented ~200/day, reset ~00:00 UTC) are the only free path; any paid probe needs explicit user consent.
- `.gitignore:6:*` ignores everything: every new first-party file needs an explicit un-ignore and `python3 scripts/architecture/audit_overlay_visibility.py` must end `hidden_changed=0 hidden_new_source=0 stale_unignore=0`.
- Evidence discipline: exact command + result on the exact revision; model self-report is not evidence; mocks are not system runs. Run the markdown audit + convergence validator + overlay audit + `git diff --check` before any "done" claim; update `CURRENT_RUN.md` and `implementationtov1release.md` at every checkpoint.
- V1 scope: Linux/WSL-first; native Windows stays UNAVAILABLE; web/desktop/browser/desktop-control/built-in web search stay deferred (A-V2-31).

**5. First actions, in order**
1. `git status --porcelain=v1; git worktree list; ps -eo pid,args | grep -E '[c]argo|[t]sgo|[b]un test'; df -h .` — inspect, preserve, no cleanup.
2. Read the handoff ledger (`CURRENT_RUN.md`) + the remaining-work ledger (`implementationtov1release.md`).
3. Fix the three known typecheck diagnostics (`packages/opencode/test/session/llm.test.ts` L822/834/839) while phase owners spin up.
4. Dispatch/re-dispatch phase owners. Critical path: **P1 Guard closure → real free-model end-to-end run → P7 route wiring + measured TUI budgets → P2 single managed vertical → P8 RC0 baselines → P3 bridge / P4 wiring → P6 Doctor/S1 remainder → P9 release (user decisions: license, signing, candidate commit, publication).**
5. Report per phase: `PHASE_VERIFIED` only with the full evidence package; otherwise `PHASE_PARTIAL` with the remaining ledger updated. Continue through the whole requested scope — do not stop at the first slice, commit, or child handoff.
