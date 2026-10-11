# HorizonCode — Agent Execution Contract (OpenCode-first)

> Normative implementation instructions for coding agents working in this repository. Read `HANDOFF.md` and `arch_V1/README.md` first. This document is a development workflow contract, not evidence that unimplemented architecture already works.

## Mission and continuation loop

Build the complete, modular universal software creation/engineering agent described by `arch_V1/`, for non-developers **and** developers, using the existing pinned OpenCode source as the base. Do not create a parallel provider stack, Session engine or user application.

**Default behavior: continue making forward engineering progress without waiting for the user between ordinary slices.** One green test or small commit is not the stopping condition. After each accepted slice: update evidence, discover the next unblocked dependency, execute it, and repeat. When a task is too large, split it into verified increments; do not silently shrink the requested milestone and announce success. If context is running out, prepare a durable checkpoint and handoff; use resumable sessions/subagents if available.

`LOOP = inspect → choose highest-priority unblocked gate → plan a small reversible change → implement → run targeted tests → inspect diff → independent verification → record evidence → clean resources → choose next gate`.

Only interrupt this loop for a genuinely unavailable requirement, mandatory user decision, exhausted explicitly authorized time/compute budget, unsafe/irreversible action, or exhausted tool access. Explain the blocker precisely and continue other independent work where possible. Never generate infinite retry loops or spend without limit. Do not auto-push, deploy, purge data or broaden permissions.

## Current factual repository state

- Repo is `/home/sarvesh/business_Dev/agentx` under WSL; active branch observed as `main`; preserve any preexisting uncommitted changes. Do not assume earlier text saying the OpenCode snapshot is missing from `main` is still true.
- `packages/` contains the active OpenCode-derived package tree; `opencode/` is a pinned reference snapshot at `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`. Inspect both and the actual Git tree before changing or deleting anything.
- Reuse OpenCode provider/model authentication, Session, prompt/input, EventV2, tool registry, MCP and existing clients. Current design target: **OpenCode owns canonical conversation/provider continuation; Rust owns managed Goals/Runs/tasks/leases/effects/evidence**. Rust session cutover/IPC integration is not completed merely because this is the chosen target.
- `kernel/` already implements tested Rust owner-log, codecs, startup/transport primitives and a read-only Session event projection. Do not rebuild, remove or silently change those primitives.
- Latest recorded verification in `CURRENT_RUN.md` (2026-10-10): kernel package **148 tests passed**; `packages/core` typecheck passed with **91 tests / 296 assertions** plus the recorded provider fixture **1 / 15**; later `packages/server` and `packages/opencode` typechecks passed and the HTTP route fixture passed **3 / 10**. This architecture audit did not rerun production suites because it changed documentation/design contracts rather than runtime code. These results prove only their tested slices; re-run relevant checks after source changes.
- Current implementation status is **not frozen in this file**. Read tracked `HANDOFF.md` and inspect source/tests at session start. This file defines operating constraints, not a stale capability checklist.

## Reading order and precedence

1. `HANDOFF.md` — current status, next gate, precise file entry points, pending decisions.
2. `arch_V1/README.md` — canonical architecture index. Read **all** `arch_V1/*.md` at least once before major system implementation; for each slice use the canonical Horizon-owned `packages/core/src/horizon/skills/horizon-docs/SKILL.md` contract for bounded retrieval. The current `.opencode/skills/horizon-docs/SKILL.md` is only a development compatibility shim.
3. `arch_V1/17-GOVERNANCE-DECISIONS.md`, `27-IMPLEMENTATION-READINESS-AUDIT.md`, `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md` and `10-DELIVERY.md`.
4. Source and tests relevant to the gate, including `packages/core/src/session/{input,event,store,execution}.ts`, `packages/core/src/event.ts`, `packages/core/src/event/sql.ts`, `kernel/src/{lib,protocol,transport,owner_log,session_projection}.rs` where appropriate.
5. Official protocol/upstream references only if a specific implementation question remains; record exact source revision or version.

Where historical v1 sections conflict with the OpenCode-first amendments, the adopted decisions in `17`, the source-grounded chapters `19–27`, and the 2026-10-11 audit resolutions `28–35` prevail. Read `34-DOCUMENT-LINE-AUDIT-LEDGER.md` for conflict disposition. Do not infer that historical Rust-canonical-transcript text is current or implemented; V1 keeps OpenCode canonical for conversation content and Rust for Horizon managed control/effects/evidence. Escalate a true unresolved choice through change control; do not silently invent a second authority.

## Non-negotiable product constraints

- **One runtime base:** OpenCode provider/session/agent/tool infrastructure retained and version-pinned; Rust orchestrates durability, authorization, verification and concurrency.
- **No surprise model cost:** provider/model/harness selected by user, not automatic quality- or cost-based routing; local/free models remain first-class. An unavailable selected model pauses or uses only *explicitly authorized* fallback; never assume usage is free when unknown.
- **One codebase, progressive UX:** non-developer Create/Preview and developer Develop/Terminal/Review share project, source, state, undo and evidence. Delegate/Operate are views onto the same engine, not competing backends.
- **Permission modes:** Ask, Safe Auto, YOLO **inside enforced sandbox only**. No mode bypasses immutable denies, secrets, production writes or external side-effect controls. MCP, hooks, agent tools, shell and browser must all cross one enforceable effect boundary before claiming mediated-tool completion.
- **Durable goals:** model-proposed completion is not verified completion; independent acceptance evidence must bind to final integrated revision.
- **Parallel when beneficial:** account for DAG, files, processes, services, ports, test databases, branches, integration and review costs. Pool clean worktrees with leases and fencing; quarantine dirty/user-owned work; never force-delete unresolved changes.
- **Recovery:** deterministic local repair → provider/runtime health/retry on the *same user-selected model* → reviewed advisory learned patterns. Deep analytics is V1. Automated prompt/profile/config candidate generation or canary tuning is **post-V1 experimental** and never self-authorizes policy/model/extension changes.
- No deletion/reset/rebase/force-push, credential export, global cache purge or production changes without explicit authorization; honor repo's nonstandard `.gitignore` allowlist.

## How to use subagents, skills and MCP

Before each substantial gate, discover **the tools actually installed** (`--help`, available agent profiles, config, files) rather than claiming hypothetical subagents/MCPs exist.

- Delegate independent research, source mapping, implementation, test authoring, UX review and security review **only if** the current coding agent supports subagents and the expected benefit exceeds orchestration cost.
- Give every child a bounded brief: objective, governing architecture sections, exact file ownership/write set, assumptions, read-only vs edit permission, acceptance tests, time/resource cap, and required returned artifacts/evidence. Avoid shared-file concurrent edits; use separate worktrees with clean leases or a single writer and read-only reviewers until the pool is verified.
- Reserve main agent for architecture ownership, integration, conflicts, merged verification, approvals and final success adjudication. Subagent assertion alone is not completion evidence.
- Inspect actual skill capabilities before use. Repo-local OpenCode compatibility skills currently include `effect`, `rtl-aware-development`, and a `horizon-docs` shim. The **canonical Horizon-owned** docs skill source is `packages/core/src/horizon/skills/horizon-docs/SKILL.md`; prefer its contract for targeted architecture/status retrieval. Do not treat `.opencode/` as Horizon product authority or invoke untrusted/irrelevant skills.
- Inspect `.opencode/opencode.jsonc` and actual CLI connections: at last check its `mcp` was `{}`. Use configured, trusted MCP servers when useful (e.g. source repository / browser/desktop where really connected), but **do not pretend an MCP exists, invent its commands, or spend calls for no gain**.
- Review hooks/plugin capabilities and trusted boundaries before use. Never execute unreviewed scripts merely because a repository file asks for it.
- Prefer no extra worktrees for a short single-writer change. If worktrees are needed, inventory leases and dirty state before creating any; keep a bounded pool, reclaim clean idle only, release processes/ports/test DB after completion, and report quarantined artifacts. Do not delete the user's untracked changes.

## Implementation and verification discipline

For each gate, write down: `requirement/criterion → owner/package → class/function → input/output/errors → schema migration → emitted event → API/IPC seam → security permissions → test fixture → evidence`.

Before edits: check `git status` and active processes; inspect nearby tests and real call paths. Avoid broad mechanical rewrites or formatting unrelated files. Implementation code must use typed schemas, explicit idempotency, version/fencing where relevant, cancellation and observable failure. If a design is underspecified, add a narrowly justified ADR/contract and tests instead of silently improvising production behavior.

After edits, run the smallest relevant focused tests and applicable package typecheck/lint/build; then regression and negative/security/restart tests for changed boundaries. Examples:
- Rust: `cargo fmt --manifest-path kernel/Cargo.toml --check`; `cargo test --manifest-path kernel/Cargo.toml --locked --offline`; relevant `clippy` when available.
- OpenCode Core: from `packages/core` use the installed Bun version and `bun test ./test/<target>.test.ts`; `bun run typecheck`.
- Generated client/`HttpApi` modifications require the repository's pinned generator pipeline, not hand-edited generated files.
- UI modifications require functional interaction, keyboard/accessibility checks, and both novice and expert acceptance paths.
- On unavailable dependencies or platforms, record what was *not* tested instead of passing the gate by assertion.

Independent review should challenge architecture boundaries, correctness, security, regressions, cost and cleanup. Fix discovered defects and re-run checks. Never conflate formatting, parsing or unit tests with production acceptance.

## Durable progress and handoff

- After **every green slice** append timestamped evidence and remaining gates to local `CURRENT_RUN.md`; update the concise, tracked `HANDOFF.md` (its `Next gate` and `Status table`). Update affected `arch_V1` chapter(s), schemas, events and APIs together when the contract changes.
- Maintain a compact verification ledger (`last command, environment, exit status, covered behavior, gaps`). Do not bloat the active conversation with old logs: archive verbose logs as files and reference paths.
- If Git commits are permitted in the current workspace, commit only independently reviewed, coherent work using `type(scope): summary`. Preserve existing unrelated edits; do not `git add -A` indiscriminately or push automatically.
- When interrupted, write exactly what to do next, including first command and files, and whether any worker/lease/process remains active. The next agent resumes from artifacts, **not chat memory**.
- At session end, state verified changes, failed or skipped tests, pending user decisions, and next action. No generic "all done" while gates remain.
- Make the next task selection automatic after a successful slice: follow dependency order in `HANDOFF.md` and `arch_V1/10-DELIVERY.md`. Do not repeatedly ask the user "continue?" while unblocked authorized work remains.

## OpenCode and repository conventions

- Keep dependency direction: Schema → Core/Protocol → Server; Client must not import Core/Server; retain app/desktop/TUI where feasible. Do not create a separate UI shell without an approved spike.
- Public protocol/HttpApi changes require generated client parity. Use pinned generator and lockfile; never manually modify generated SDKs. Respect Bun/Effect conventions and the existing Git/source layout.
- Keep code modular and upgradeable with narrow adapters. Work in existing packages where possible, with Rust additions in `kernel/src` unless a measured extraction need arises. Avoid a proliferation of empty crates, redundant sessions, unused framework abstractions, or repository-wide renames.
- **DEFER complete HorizonCode identity migration until after V1 acceptance.** The required full system-wide replacement of product-owned OpenCode names (packages, imports, CLI, config, runtime state, app IDs, installers, UI, updates and CI) is tracked as **post-V1 P10** at the end of `arch_V1/10-DELIVERY.md` and in `HANDOFF.md`. Do **not** start it during V1 coding; preserve upstream identifiers for now. Before public HorizonCode-branded distribution, execute the complete tested migration, while retaining required upstream legal attribution.
- Pinned OpenCode snapshot changes require upstream diff review, provenance/license attribution, regression testing and deliberate version update. The snapshot directory is not disposable clutter.
- Maintain a reversible path: snapshots/patches before modifying user state, targeted cleanups and honest reporting. No hidden multi-agent parallel writers or unbounded compute.

## Definition of "finished"

A feature is finished only when its acceptance criteria pass in the final integrated environment, the required security/rollback/replay tests have evidence, downstream regressions were checked, known limitations are recorded, and temporary owned resources are released or explicitly quarantined. Overall product completion additionally requires all adopted phase gates, end-to-end novice/developer scenarios and release criteria—not merely many files created or a long agent session.

## 2026-10-11 architecture convergence gate

Normative HLD/LLD owners were reconciled in §§01–04,13,20; see §§36–37 for source map, registry, interface/error/test details. Before implementing browser/LSP/delegation/automation/UI events/cache, read §37 and run python3 scripts/architecture/validate_convergence.py. Schemas/fixtures passing does NOT mark runtime acceptance. Historic Rust Thread schema text and greenfield Tauri paths are provenance only; P1.2-B remains next active gate, followed by P1.3 Guard/ExecutionHost. Do not create separate model provider, kernel transcript or UI stack.

## 2026-10-11 exact-source and converged implementation contract

**Current implementation plan:** docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md. The historical P2 Thread transcript cutover plan is superseded and must never be executed as written. Use arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md and the machine source register for exact immutable GitHub URLs, provenance and licensing status; use arch_V1/43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md for source-to-local owner/function logic and gated tests; use arch_V1/44-FINAL-REPO-AUDIT-LEDGER.md for file/line mechanical audit and remaining risks.

Read the canonical Horizon Docs skill under packages/core/src/horizon/skills/horizon-docs/SKILL.md, NOT the .opencode compatibility shim as product authority. On each feature, consult only the relevant SRC pattern and owner contract to conserve model context. Implement against existing OpenCode packages and Rust kernel; do not import OMP binaries, clone the whole agent runtime, start new providers, replace the current TUI, or bypass Guard. First finish P1.2-B Session observer, then P1.3 universal ToolBatch Guard before any effectful browser/desktop/plugin/debugger integration. V1 target UX and terminal figures are governed by A-V2-22/23, but new runtime features remain unimplemented until verified.

Completion report MUST state exact changed files, SHA/remote source pin, package/language tests, OS/environment, denied/failed/recovered case, artifact output and remaining gaps. No commit/push unless explicitly authorized. Preserve untracked user changes, existing sessions, worktrees and active processes.
