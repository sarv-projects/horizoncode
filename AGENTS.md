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
- Latest measured verification (2026-10-10): **115 Rust tests passed**, **2 Bun live-projection integration tests passed**, `packages/core` TypeScript typecheck passed. This proves only the tested slice; re-run relevant checks after changes.
- Current implementation: `kernel/src/session_projection.rs`, `kernel/src/bin/session_sync_probe.rs`, `packages/core/test/kernel-projection-live.test.ts`. Read `HANDOFF.md` for the next actual gate. No authenticated production supervisor, complete mediated ToolIntent broker, Goal/Run scheduler or full UI is claimed.

## Reading order and precedence

1. `HANDOFF.md` — current status, next gate, precise file entry points, pending decisions.
2. `arch_V1/README.md` — canonical architecture index. Read **all** `arch_V1/*.md` at least once before major system implementation; for each slice re-read the governing chapters and linked contracts.
3. `arch_V1/17-GOVERNANCE-DECISIONS.md`, `27-IMPLEMENTATION-READINESS-AUDIT.md`, `24-LOCAL-CODE-AUDIT-AND-MIGRATION.md` and `10-DELIVERY.md`.
4. Source and tests relevant to the gate, including `packages/core/src/session/{input,event,store,execution}.ts`, `packages/core/src/event.ts`, `packages/core/src/event/sql.ts`, `kernel/src/{lib,protocol,transport,owner_log,session_projection}.rs` where appropriate.
5. Official protocol/upstream references only if a specific implementation question remains; record exact source revision or version.

Where historical v1 sections conflict with the OpenCode-first amendments, the explicit adopted v2 decisions in `17` and the latest source-grounded chapters `19–27` prevail. Do not infer that conflicting historical Rust-canonical-Thread text is implemented. Escalate a true unresolved choice through the change-control procedure; do not silently invent a second authority.

## Non-negotiable product constraints

- **One runtime base:** OpenCode provider/session/agent/tool infrastructure retained and version-pinned; Rust orchestrates durability, authorization, verification and concurrency.
- **No surprise model cost:** provider/model/harness selected by user, not automatic quality- or cost-based routing; local/free models remain first-class. An unavailable selected model pauses or uses only *explicitly authorized* fallback; never assume usage is free when unknown.
- **One codebase, progressive UX:** non-developer Create/Preview and developer Develop/Terminal/Review share project, source, state, undo and evidence. Delegate/Operate are views onto the same engine, not competing backends.
- **Permission modes:** Ask, Safe Auto, YOLO **inside enforced sandbox only**. No mode bypasses immutable denies, secrets, production writes or external side-effect controls. MCP, hooks, agent tools, shell and browser must all cross one enforceable effect boundary before claiming mediated-tool completion.
- **Durable goals:** model-proposed completion is not verified completion; independent acceptance evidence must bind to final integrated revision.
- **Parallel when beneficial:** account for DAG, files, processes, services, ports, test databases, branches, integration and review costs. Pool clean worktrees with leases and fencing; quarantine dirty/user-owned work; never force-delete unresolved changes.
- **Four-tier recovery:** deterministic local repair → provider health/retry *same user-selected model* → advisory learned patterns → sandbox-tested configuration proposals. Learned remediation never secretly elevates policy.
- No deletion/reset/rebase/force-push, credential export, global cache purge or production changes without explicit authorization; honor repo's nonstandard `.gitignore` allowlist.

## How to use subagents, skills and MCP

Before each substantial gate, discover **the tools actually installed** (`--help`, available agent profiles, config, files) rather than claiming hypothetical subagents/MCPs exist.

- Delegate independent research, source mapping, implementation, test authoring, UX review and security review **only if** the current coding agent supports subagents and the expected benefit exceeds orchestration cost.
- Give every child a bounded brief: objective, governing architecture sections, exact file ownership/write set, assumptions, read-only vs edit permission, acceptance tests, time/resource cap, and required returned artifacts/evidence. Avoid shared-file concurrent edits; use separate worktrees with clean leases or a single writer and read-only reviewers until the pool is verified.
- Reserve main agent for architecture ownership, integration, conflicts, merged verification, approvals and final success adjudication. Subagent assertion alone is not completion evidence.
- Inspect `.opencode/skills/`; currently available repo-local skills include `effect` and `rtl-aware-development`. Read their `SKILL.md` and use when relevant. Do not invoke untrusted or irrelevant skills.
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
- Pinned OpenCode snapshot changes require upstream diff review, provenance/license attribution, regression testing and deliberate version update. The snapshot directory is not disposable clutter.
- Maintain a reversible path: snapshots/patches before modifying user state, targeted cleanups and honest reporting. No hidden multi-agent parallel writers or unbounded compute.

## Definition of "finished"

A feature is finished only when its acceptance criteria pass in the final integrated environment, the required security/rollback/replay tests have evidence, downstream regressions were checked, known limitations are recorded, and temporary owned resources are released or explicitly quarantined. Overall product completion additionally requires all adopted phase gates, end-to-end novice/developer scenarios and release criteria—not merely many files created or a long agent session.
