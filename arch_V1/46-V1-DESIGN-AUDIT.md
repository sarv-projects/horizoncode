# V1 design corpus audit — 2026-10-22

Status: **DESIGN AUDIT PASS (structural)** — ready for implementation-only work. **NOT** product VERIFIED or RELEASED.

This document is the parent audit record. Detailed backlogs live in sibling `arch_V1/46-V1-*` files.

## Automated structural audit (re-run before release)

| Check | Command | Result (2026-10-22) |
|---|---|---|
| Contract convergence | `python3 scripts/architecture/validate_convergence.py` | **1299 checks, 0 failures**; 72 schema files; registry 230 IDs |
| Markdown corpus | `python3 scripts/architecture/audit_markdown_repo.py` | **285 tracked Markdown files**; **ACTIVE_BLOCKERS 0**; 62 archive-only reference warnings |
| JSON audit evidence | `docs/audit-markdown-latest.json` (optional) | Per-file SHA256; re-generate with `--json-report` |

Structural pass does **not** prove runtime behavior, Guard safety, or provider journeys.

## Authority chain (implement only from these)

1. `arch_V1/17-GOVERNANCE-DECISIONS.md` — frozen decisions (`DEC-V1-*`).
2. `arch_V1/README.md` — topic owner index.
3. Topic HLD/LLD: `01`–`18`, `20`, `21`, `29`–`33`, `37`, `42` (not numbered stubs).
4. `arch_V1/45-V1-EVENT-FLOWS-ATLAS.md` — **derived navigation only**; never overrides owners.
5. `arch_V1/contracts-v2/*.schema.json` + `packages/schema` mirrors.
6. Code status: `HANDOFF.md` + `implementationtov1release.md` + this audit.

**Do not implement from:** `arch_V1/07`, `22`, `23`, `27` (compatibility stubs), or `docs/architecture-archive/**`.

## Normative arch_V1 corpus map

| Class | Files | Role |
|---|---|---|
| **Normative owners** | `01`–`06`, `10`–`18`, `20`–`21`, `29`–`33`, `37`, `42`, `GLOSSARY` | HLD/LLD/product law |
| **Acceptance** | `32-TASK-BASED-AGENT-TEST-CATALOG.md` | All `CX-*`, `CTX-*`, `ACT-*`, phase families |
| **Delivery order** | `10-DELIVERY.md` §10.2–10.18 | P0–P9 gates + competitive prio table |
| **Derived atlas** | `45-V1-EVENT-FLOWS-ATLAS.md` | E2E diagrams + coverage matrix |
| **Stubs (redirect)** | `07`, `08`, `09`, `19`, `22`–`28`, `34`–`36`, `38`–`41`, `43`–`44` | Link to owners; archive holds old body |
| **Playbook** | `43` (stub → `46-V1-*`) | Implementation queue; seam map in `46-V1-SOURCE-ALIGNMENT-AUDIT.md` |

Line-by-line review of **82k+ lines** is not repeated here; the audit script enumerates every tracked `.md` with hash. **Semantic completeness** is asserted via owner cross-links in `46-V1-IMPLEMENTATION-BACKLOG.md` and §32 catalog coverage.

## Design completeness verdict by layer

| Layer | Ready to implement? | Evidence | Gaps (design vs code) |
|---|---|---|---|
| **Governance / scope** | Yes | `17`, `10` §10.18, A-V2-31 in `16`/`10` | Post-V1 surfaces explicitly deferred |
| **Guard / effects** | Yes (spec) | `14`, `37` P1 seams, `32` §32.14/20 | P1 effect paths incomplete in kernel/Core |
| **Managed lifecycle** | Yes (spec) | `11`, `29.18`, `DEC-V1-31`, `37` P2 | Multi-Task DAG + verifier not WIRED |
| **Context / compile** | Yes (spec) | `30` §30.2–30.6, **§30.26**, `37.30` | Resolver, anchor, adapter not coded |
| **RepoIntel** | Yes (spec) | `30.22–25`, `37.22`, `indexd` | Tools gated; cursor/parser partial |
| **LSP/DAP/REPL** | Yes (spec) | `37.6–8`, `32` §32.28 | Broker processes gated |
| **Web search** | Yes (spec) | `37.5`, `33.9`, `DEC-V1-26` | Cascade needs P1 + live routes |
| **Providers** | Yes (spec) | `16`, `37.16–19`, `DEC-V1-32` | Credentialed routes gated |
| **TUI / UX** | Yes (spec) | `16` §16.21, `31` §31.22, `32` §32.48 | Activity cards partial |
| **Capabilities** | Yes (catalog) | `33`, `capability-registry-v1.json` | **226/230 `designed`**, **4 `code_present`** |
| **Schemas** | Yes | 72 JSON schemas + TS in `packages/schema` | Wiring ≠ schema presence |

## Known design risks (not blockers to start coding)

1. **HANDOFF vs resolved decisions** — Some `HANDOFF.md` paragraphs still say “command-profile shape pending”; **`implementationtov1release.md` and `17`/`37.27` resolve `terminal.run` profile mode**. Implement **`terminal.run` profile variant**; ignore stale HANDOFF lines.
2. **Cache hit guarantees** — §30.26.10: tests must not require `cache_read > 0` on every CI run.
3. **Parser provenance** — §42.11 rejects OMP `pi_ast` port; semantic RepoIntel remains **lexical/partial** until approved parser ADR.
4. **models.dev** — Catalog is advisory; mirror `https://models.opencode.ai/api.json` or `https://models.dev/api.json` (same family); route adapter wins over `cost.cache_read` hint.

## Reference trees and external docs (gap check only)

| Pin / path | Use when implementing | As-is vs adapt |
|---|---|---|
| **`opencode/packages/*`** (root snapshot) | LSP, codemode, hydrated TUI/widgets — bootstrap into `packages/*` | Mostly **REUSE/ADAPT** per `repo_take/NOTES.md` |
| **`repo_take/opencode`** | **Dev HEAD** survey only (e.g. `packages/core/src/session/subagent-job.ts`) — **not** LSP | **ADAPT**; never replace local `packages/` |
| **`repo_take/oh-my-pi`** | DAP, settings/TUI UX | **ADAPT** + Guard |
| **`repos/codex`** | Delegation/thread patterns — compare to §42.1 pin before copy | **ADAPT** lifecycle only |
| **§42** §42.19+ | Codex/OpenCode cgroup/cleanup comparison | Horizon **stronger** durable semantics |
| **Claude Code docs** (online) | §29.23 instruction loading | Policy only — no code copy |
| **[`46-V1-SOURCE-ALIGNMENT-AUDIT.md`](46-V1-SOURCE-ALIGNMENT-AUDIT.md)** | Full P0–P9 path/disposition/disparity matrix | **This pass** |

No `grok build` pin found in `42`; do not invent authority.

## Child documents

| Document | Purpose |
|---|---|
| [`46-V1-WIRE-TRACKER.md`](46-V1-WIRE-TRACKER.md) | V1 wire map: critical path, P0–P9, edges, product bundle, **Status** (done/partial/not done) |
| [`46-V1-IMPLEMENTATION-BACKLOG.md`](46-V1-IMPLEMENTATION-BACKLOG.md) | P0–P9 tasks, arch § refs, schemas, code seams, tests |
| [`46-V1-FEATURE-INVENTORY.md`](46-V1-FEATURE-INVENTORY.md) | Agents, skills, tools, slash commands, harnesses |
| [`46-V1-VERIFICATION-RUNBOOK.md`](46-V1-VERIFICATION-RUNBOOK.md) | Post-implementation test order and edge-case matrix |
| [`46-V1-SOURCE-ALIGNMENT-AUDIT.md`](46-V1-SOURCE-ALIGNMENT-AUDIT.md) | Docs ↔ main repo ↔ repo_take ↔ online refs; REUSE/ADAPT/disparities |
| [`46-V1-MIGRATION-PARITY.md`](46-V1-MIGRATION-PARITY.md) | OpenCode/Cursor/Claude/Codex parity; `DEC-V1-36`; §32.49 |
| [`generated-capability-ids.txt`](generated-capability-ids.txt) | Full 230 canonical capability IDs |

## Sign-off criteria for “design done”

- [x] Structural audits green
- [x] P0–P9 backlog rows with owner doc + § refs
- [x] §32 acceptance IDs mapped per phase
- [x] Feature/surface inventory
- [ ] **Implementation** fills all backlog rows with tests cited
- [ ] **VERIFIED** only after `V1-VERIFICATION-RUNBOOK.md` complete on exact revision
