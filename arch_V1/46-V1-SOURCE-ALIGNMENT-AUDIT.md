# V1 source alignment audit — docs, main repo, repo_take, and external references

Status: **living alignment doc** — last reconciliation **2026-10-26** (code-inspected). Complements [`46-V1-DESIGN-AUDIT.md`](46-V1-DESIGN-AUDIT.md) (structural) with **semantic traceability**: normative arch → **where to read code**, **what to take as-is vs adapt**, and **known doc/code disparities**.

**Not** product VERIFIED. Structural gates (re-run on current tree): `validate_convergence.py` **0 failures** (~1298 checks); `audit_markdown_repo.py` **ACTIVE_BLOCKERS 0** on active arch paths. **Registry truth:** 230 IDs, **226 `designed`**, **4 `code_present`**, **0 `wired`** — unchanged until §32 acceptance updates registry rows.

**Reconciliation rule:** If a row below disagrees with [`46-V1-WIRE-TRACKER.md`](46-V1-WIRE-TRACKER.md) or [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md), prefer **this file’s code-inspected §3/§5/§13** for path/disposition and the **backlog** for phase status (`CP`/`PART`/`OPEN`); wire tracker **Partial** means CODE_PRESENT or integration incomplete, not VERIFIED.

---

## 1. How to read paths in this repository

HorizonCode uses **three different “OpenCode” trees**. Mixing them causes wrong file pointers and false “missing feature” conclusions.

| Tree | Path | Git role | Use when |
|---|---|---|---|
| **Hydrated snapshot (authoritative for porting)** | `opencode/packages/*` | Pinned upstream body + legal notices; bootstrap source | LSP (`opencode/packages/opencode/src/lsp/*`), legacy opencode routes, codemode, hydrated TUI/widgets **not** overlaid at root |
| **First-party overlay (authoritative for shipping)** | `packages/*` | Horizon edits; may be partial vs snapshot | **Implement here** after `scripts/architecture/bootstrap_source.py --apply`; Guard, kernel bridge, Horizon config |
| **Reference clone (read-only survey)** | `repo_take/opencode` | Shallow **dev HEAD** (`09ef07e…` as of 2026-10-16 survey); **not** the §42.1 pin | Compare **moving** upstream layout (e.g. `packages/core/src/session/subagent-job.ts`); **no** `packages/opencode` LSP runtime on this HEAD |
| **Codex reference (unpinned local)** | `repos/codex` | No verified local git pin vs §42.1 | Compare blobs to pin `8c0f701…` before copy; delegation patterns only |
| **OMP reference** | `repo_take/oh-my-pi` | Pin `eec114a…` per §42 | DAP, settings/TUI UX, task pool **algorithms** — always ADAPT + Guard |

**Rule (normative):** [`20-OPENCODE-INTEGRATION-LLD.md`](20-OPENCODE-INTEGRATION-LLD.md) §20.12 — repository is a **hydrated overlay**. Markdown under `arch_V1/` is law; it is not proof code exists at root until bootstrap + inspect.

**Online / docs-only (no code copy):**

| Source | URL / doc | Horizon use |
|---|---|---|
| Claude Code memory / CLAUDE.md | https://code.claude.com/docs/en/memory , /claude-md , /large-codebases | §29.23 instruction loading policy |
| models.dev / OpenCode catalog | https://models.dev/api.json (family) | §30.26 advisory `cache_read` hints; route adapter wins |
| Pi/Codex harness decisions | [`docs/research/2026-10-21-pi-codex-harness-decisions.md`](../docs/research/2026-10-21-pi-codex-harness-decisions.md) | Progressive context, Code Mode pattern, durable vs direct |
| Cloudflare Code Mode | https://developers.cloudflare.com/agents/tools/codemode/ | §29.22 orchestration pattern only |

---

## 2. Disposition legend (from §42 and `repo_take/NOTES.md`)

| Label | Meaning |
|---|---|
| **REUSE** | Drop into Horizon owner with thin wiring (types, Guard hooks, tests) |
| **ADAPT** | Port algorithm or module; change types, authority, receipts, capability IDs |
| **ADAPTER** | New Horizon façade around upstream approach (no second runtime) |
| **REJECT** | Do not ship upstream module as authority |
| **DESIGNED** | Normative spec + schemas; **no** matching runtime seam yet |
| **PART** | Code present; Guard/wiring/acceptance incomplete |

Every row below states **disparity** when docs claim more than the main repo delivers.

---

## 3. P0–P9 alignment matrix (normative § → code → reference → disparity)

| Phase | Normative owners | Main repo seams (verify after bootstrap) | External / repo_take | Disposition | Doc vs main repo disparity |
|---|---|---|---|---|---|
| **P0** | `10` §10.2, `20`, `42` | `packages/opencode`, `packages/core`, `kernel/`, `install` | `repo_take/NOTES.md` take-map | REUSE overlay model | Docs complete; tree dirty/mixed — status in `implementationtov1release.md` |
| **P1** Guard | `14`, `37`, `21` §21.11 | `kernel/src/{guard,effect_host,host_kernel,terminal_process}.rs`, `packages/core/src/session/tool-batch.ts`, `packages/opencode/src/session/*` | Codex `repos/codex/codex-rs/core/src/exec.rs` (process group only) | **ADAPT**; reject Codex as receipt authority | §42.19: upstream has **no** durable cgroup janitor — Horizon **stronger** UNKNOWN/quiescence required |
| **P1** terminal profiles | `37.27`, `DEC-V1-28` | `kernel/src/terminal_process.rs`, `packages/core/src/tool/bash.ts` | OpenCode shell in `packages/opencode/src/tool/shell.ts` | **ADAPT** — workspace profile mode, not legacy bash-only | `HANDOFF` stale “command-profile pending” — **ignore**; use `37.27` |
| **P1** CodeMode | `29.22`, `37.24` | `packages/opencode/src/tool/code-mode.ts`, `opencode/packages/codemode` | Cloudflare docs (pattern) | **REUSE** interpreter + **ADAPT** waves/Guard | cgroup profile **designed**; CodeMode **hard-disabled** (`CODE_MODE_HELPER_RUNTIME_READY=false`, `code-mode.ts:21`), not enforcement PART |
| **P2** managed | `11`, `29.18`, `DEC-V1-31` | `kernel/src/managed_control.rs`, `packages/opencode/src/session/managed-run-coordinator.ts`, `tool/task.ts` | `repo_take/opencode/packages/core/src/session/subagent-{job,completion}.ts`, `execution/restart.ts`; Codex `codex_delegate.rs` | **REUSE** Task seam; **ADAPT** Rust DAG | Subagent files **not** in root `packages/core` — read `repo_take` or hydrate; multi-Task DAG **OPEN** |
| **P3** RepoIntel | `30.22–25`, `37.22` | `indexd/`, `kernel/src/repo_structure.rs`, `packages/opencode/src/tool/repo-*.ts` | OMP graph ideas **REJECT** as authority (§42.11) | **ADAPT** lexical/indexd | `repo.tree`/`repo.detect` **gated** in registry |
| **P3** context ledger | `30.2`, `30.24` | `packages/core/src/session/context-{selection,ledger}.ts`, `runner/llm.ts` | Pi progressive disclosure (research doc) | **ADAPT** | Ledger **PART**; pin before dispatch **source-present** |
| **P3** §30.26 compile policy | `30.26`, `37.30` | `packages/core/src/session/context-compile-policy.ts`, schemas `context-compile-policy-v1`, `repo-context-anchor-v1`; tests `packages/core/test/context-compile-policy.test.ts` | models.dev API (online) | **PART** | **Code present** (P3-05 **CP**); provider/runner legs of CX-014–021 still **NOT_RUN** |
| **P3** §29.23 instructions | `29.23` | `packages/core/src/session/project-instruction.ts`, tests `instruction-project.test.ts`; legacy: `config.ts` `instructions[]`, `system.ts`, `skill/index.ts` | Claude docs (policy) | **PART** | **Code present** (P3-09 **CP**); child delivery-root and full INST-* journeys still open |
| **P4** LSP | `37.6`, `30.7` | `packages/opencode/src/lsp/*` (after bootstrap from `opencode/packages/opencode`) | **NOT** on `repo_take/opencode` HEAD | **ADAPT** nearly verbatim server defs | **Wrong pointer:** do not cite `repo_take/opencode/.../lsp` — use **`opencode/packages/opencode/src/lsp/server.ts`** |
| **P4** DAP | `37.7` | Horizon broker **partial** | `repo_take/oh-my-pi/packages/coding-agent/src/dap/session.ts` | **ADAPT** + Guard | OpenCode trees **lack** DAP — OMP-only candidate |
| **P5** web search | `37.5`, `DEC-V1-26` | `packages/opencode/src/tool/websearch*.ts` | Provider docs in §42.1 table | **ADAPT** cascade | Broker code-present and consent-gated, but runtime-disabled by `WEB_SEARCH_*_RUNTIME_READY=false` (`websearch-broker.ts:11-12`); paid routes gated |
| **P6** providers | `16`, `37.16–19` | `packages/core/src/models-dev.ts`, `packages/opencode/src/provider/*`, `packages/llm` | OMP catalog **ADAPT** only | **PART** | Direct transport journal PART; no hidden fallback |
| **P7** TUI streams | `31.1–2`, `37.11` | `packages/tui/src/**` + hydrated `opencode/packages/tui/src/` | OMP pi-tui algorithms (§31.17) | **ADAPT** scheduler | Overlay thin — most widgets in snapshot |
| **P7** §31.22 activity cards | `31.22`, `16.21` | `packages/tui/src/component/activity-stream.tsx` | Cursor-like **semantics only** | **ADAPT** | Generic rows — **no** Ctrl+R/diff gutter yet |
| **P7** §31.23 code display | `31.23`, `37.12` | `packages/tui/src/util/code-display.ts` (+ tests); still uses `artifact-markdown.tsx`, `session/index.tsx` (`conceal`) | OMP markdown cache patterns | **PART** | **`CodeDisplayPipelineV1` name in §37** ≠ shipped module name **`code-display.ts`**; UI-024–030 budgets **not measured** |
| **P8** worktrees | `21`, `37` | `kernel/worktree_pool.rs`, OpenCode worktree in snapshot core | `repo_take` + `opencode` worktree modules | **REUSE/ADAPT** + leases | Pool/lease **PART** |
| **P9** release | `18`, `10` §10.11 | `install`, CI workflows | — | **PART** | Not RELEASED |

---

## 4. §10.18 competitive priorities — accounted?

| Prio | §10.18.1 row | Backlog | Source alignment | Gap |
|---:|---|---|---|---|
| 1–2 | Guard, managed DAG | P1, P2 | §42.16–19, `repos/codex` | Effect paths PART |
| 3 | Context §30.26 | P3-05, P6 | models.dev online + schemas | Resolver **not coded** |
| 4 | RepoIntel | P3-01–02 | `indexd`, §30.25 | Tools gated |
| 5–6 | LSP, search | P4, P5 | LSP → **`opencode/`** snapshot; DAP → **OMP** | DAP not from OpenCode |
| 7 | Providers/settings | P6 | `packages/core` + opencode provider | Doctor PART |
| 8 | TUI digest + perf | P7-03, **P7-08**, P3-09 | §31.22–23, §29.23 | Cards + fast code **DESIGNED** |
| 9–11 | P8, grants/CodeMode, P9 | P8, P1, P9 | §21, §29.22 | Fan-out gated |

Unmapped competitor ideas remain in **§42.21** only (mgrep, CRG install, Windsurf shell, etc.) — **accounted as REJECT/defer**.

---

## 5. Spec vs main repo — backlog truth (2026-10-26)

| Spec | Schema / seam | Main repo today | Backlog | Disposition |
|---|---|---|---|---|
| §30.26 policy resolver | `context-compile-policy-v1`, `repo-context-anchor-v1` | `context-compile-policy.ts` + focused tests | P3-05 **CP** | **PART** — not WIRED |
| §29.23 instruction resolver | ledger reasons in §30.2 | `project-instruction.ts` + tests | P3-09 **CP** | **PART** — integrated INST-* open |
| §14.3.1 read fast path | `prepare_tool_batch_read` | `kernel/src/host_kernel.rs`, `packages/core/src/session/direct-read-batch.ts`, supervisor allowlist | P1-10 **CP** | **PART** — PERF-DIRECT-* not run; registry still **designed** |
| §31.23 code display | §37 `CodeDisplayPipelineV1` (doc name) | `packages/tui/src/util/code-display.ts` | P7-08 **CP** | **PART** — rename doc seam or alias in §37.12 |
| §31.22 activity cards | `ActivityCardV1` (in §31 doc) | `activity-cards.ts` / stream (focused tests green) | P7-03 **PART** | **PART** — Ctrl+R / full ACT-* journeys open |
| HostRun dispatch DTOs | `host-run-dispatch-v1.schema.json` | `managed-control.ts` decoders + §12 narrative; routes **fail-closed** | P2 **PART** | **PART** — chain not VERIFIED |
| AgentProfileV2 full wire | `agent-profile-v2.schema.json` | `kernel/src/agent_profile.rs` PART | P6-05 **PART** | **PART** |
| §30.28 SPD-A compile overlap | §30.28 | no `compileOverlapMs` consumer in tests | P3-10 **OPEN** | **DESIGNED** |

Schemas present **≠** WIRED. Registry: **4/230** `code_present` until acceptance promotes rows.

---

## 6. repo_take/NOTES.md vs live trees (corrections)

| NOTES.md claim | Current fact (2026-10-22) | Action |
|---|---|---|
| LSP at `repo_take/opencode/packages/opencode/src/lsp/*` `[pinned b1fe25a]` | `repo_take/opencode` HEAD has **no** `packages/opencode`; LSP lives in **`opencode/packages/opencode`** at root snapshot | Read LSP via **`opencode/`** or `git show b1fe25a:packages/opencode/src/lsp/...` |
| `repo_take/opencode` pin `b1fe25a` | Clone HEAD is **09ef07e** (dev); pin must be fetched explicitly | Do not assume clone equals pin |
| `repos/codex` | Local tree **unverified** vs §42.1 pin | Compare before any copy (§42.1) |
| DAP from OMP | `repo_take/oh-my-pi/.../dap/session.ts` **exists** | Still **ADAPT** — not VERIFIED in Horizon |
| Session-ui “wholesale REUSE” | Horizon uses `packages/tui` + overlay, not separate `session-ui` package name | **ADAPT** into §31 owners |

---

## 7. Instruction loading — doc vs code vs Claude

| Behavior | Claude Code (docs) | OpenCode today (`packages/opencode`) | Horizon §29.23 | Disparity |
|---|---|---|---|---|
| Ancestor CLAUDE/AGENTS at launch | Yes | Partial: `instructions[]`, references in `system.ts` | Required | **Not fully implemented** |
| Subdir on demand | Yes | No equivalent | Required on Guarded touch | **DESIGNED** |
| Skill bodies | On tool | `Skill` tool + metadata in system prompt | Same | **Largely aligned** |
| Root AGENTS authority | N/A | Nested `AGENTS.md` in packages | Horizon root wins | Policy in root `AGENTS.md` — enforce in resolver |

---

## 8. UI / RAM — doc vs code

| Requirement | Owner | Main repo today | Gap |
|---|---|---|---|
| Scroll anchor `UI-002` | §31.2 | TUI session route | Needs acceptance measurement |
| Conceal long code | §31.23 | `session.toggle.conceal` + `code-display.ts` helpers | Viewport highlight scheduler + UI-024–030 **open** |
| Tool tail caps | §31.16–17 | Partial streaming | Full diagnostics **DESIGNED** |
| Activity digest | §31.22 | `activity-cards.ts` (kinds, tests) | Rendered-surface ACT-* **open** |
| Syntax cache 8 MiB | §31.23.5 | `code-display.ts` bounded paths in tests | Production RAM cap **not attested** — **P7-08** |

---

## 9. Markdown corpus hygiene

| Check | Result |
|---|---|
| Active arch links broken | **0** blockers |
| Archive under `docs/architecture-archive/**` | 62 reference-only warnings — **expected** |
| Stubs `arch_V1/07,22–28,34–44` | Redirect to owners; **do not implement** from stubs |
| `arch_V1/43` | **Stub** — queue is `46-V1-IMPLEMENTATION-BACKLOG.md` |
| Operative plan | `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` — ordering/checkboxes |
| Status truth | `HANDOFF.md`, `implementationtov1release.md` — may lag specs |

---

## 10. Code seams without a normative owner line (add when touching)

These exist in `packages/` or `kernel/` but are easy to lose when reading only topic HLDs — **point normative docs here on the next edit** of the owning §.

| Seam | Path | Suggested owner doc |
|---|---|---|
| Session owner metadata match / legacy host root | `packages/core/src/session/owner.ts` | `37` §37.11 / instance SSE; used by `packages/server/src/handlers/event.ts` question filter |
| Instance SSE question-owner filter (first-party server) | `packages/server/src/handlers/event.ts` | `37` §37.11 (today: prose only in `31`/`37`, not this path) |
| DEC-V1-36 direct read batch caller | `packages/core/src/session/direct-read-batch.ts` | `14` §14.3.1, `46-V1-WIRE-TRACKER` W-P1-07 |
| Sealed builtin integration skill | `packages/core/src/horizon/skills/horizoncode/SKILL.md`, `builtin.horizoncode` in `packages/core/src/skill.ts` | `29` §29.6, `33` §33.32, `DEC-V1-38` |
| Horizon Coding Profile preset | `packages/core/src/config/coding-profile.ts` | `16` §16.19.1, W-P6-06 |

---

## 11. Residual gaps (not forgotten)

1. **§32 OMP-prefixed rows** (`UI-OMP-*`, etc.) — acceptance for **adapted** OMP behaviors; tracked in §32 long matrix; implementation varies PART/OPEN.
2. **`generated-capability-ids.txt`** — 230 IDs; must match `capability-registry-v1.json` (convergence checks this).
3. **Post-V1** surfaces in §10.18.4 — explicitly **not** in V1 backlog rows.
4. **Parser port** — §42.11 **REJECT** OMP `pi_ast`; RepoIntel stays lexical until ADR.
5. **Fidelity wire mismatch** — §37.12 notes uppercase fidelity in some DTOs vs lowercase schema — **documented**, not fixed.

---

## 12. Migration parity (2026-10-22 spec; 2026-10-26 code)

Reviewer friction items are addressed in **`DEC-V1-36`**, **§14.3.1** (read fast path),
**§16.19.1** (default preset), **§16.4.1** (slash truth), **§31.24**, **§32.49**, and
[`46-V1-MIGRATION-PARITY.md`](46-V1-MIGRATION-PARITY.md). Implementation rows **P1-10/11**,
**P6-06**, **P7-09**.

---

## 13. Sign-off: is “everything accounted for”?

| Question | Answer |
|---|---|
| Every P0–P9 deliverable has arch § + schema + seam + §32 IDs? | **Yes** — [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md) |
| Competitive/V1 scope encoded without silent scope creep? | **Yes** — §10.18 + §42.21 + `DEC-V1-35` |
| External sources pinned or labeled unpinned? | **Yes** — §42.1; `repos/codex` flagged |
| repo_take vs opencode snapshot disparity documented? | **Yes** — §6 above + `repo_take/NOTES.md` warning |
| As-is vs adapt stated per major port? | **Yes** — `repo_take/NOTES.md` table + §3 matrix |
| Product matches normative docs? | **No** — majority **DESIGNED/PART**; this audit separates **spec complete** from **runtime complete** |

**Implementers:** start from [`46-V1-RELEASE-EXECUTION-QUEUE.md`](46-V1-RELEASE-EXECUTION-QUEUE.md) (waves + subagents), then [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md); use **§3** of this file for path/disposition; run [`46-V1-VERIFICATION-RUNBOOK.md`](46-V1-VERIFICATION-RUNBOOK.md) only after code lands.
