# AGENTS.md — HorizonCode implementation rules

## Start here

1. Inspect git status, worktrees, active processes, and disk/build-output pressure. Preserve every user-owned change.
2. Read arch_V1/README.md and arch_V1/17-GOVERNANCE-DECISIONS.md once.
3. Read HANDOFF.md and docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md for the current gate.
4. For the specific slice, read only its topic owner from arch_V1/README.md, plus:
   - arch_V1/20-OPENCODE-INTEGRATION-LLD.md for local source placement;
   - arch_V1/37-RUNTIME-SERVICE-LLD.md for a runtime service boundary;
   - arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md for public IDs;
   - arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md for acceptance;
   - arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md only when external source extraction is necessary.
5. Inspect exact local source, callers and tests before editing.

Do NOT read the archived architecture or compatibility stubs as implementation authority.

## Skills, MCPs, tools and external capabilities

Use the strongest relevant capability already available instead of reimplementing it manually.

- Before a substantial slice, briefly inventory relevant built-in tools, installed skills, MCP servers/connectors and existing repository helpers.
- Use a skill when it provides a maintained workflow or domain-specific procedure that materially improves the task.
- Use MCP/tools when they provide authoritative access to the required external system, browser, repository, filesystem, test runner, documentation source or service.
- Prefer deterministic/local tools for deterministic work; do not spend model calls on work a local tool can do exactly.
- Do not call tools/MCPs merely because they exist. Use the smallest set that improves correctness, speed or evidence.
- Reuse existing Horizon/OpenCode abstractions and integrations before introducing a new dependency, helper, server or wrapper.
- Respect each tool/MCP's permission, trust and cost boundary. No paid API, credential export, remote mutation or new external connection without authorization.
- When an architecture/source document names a relevant skill, MCP, tool or exact external source, use it where appropriate and verify its result against the owning source/tests before relying on it.

## Immutable architecture constraints

- HorizonCode direct-session Core currently derives from OpenCode and owns direct conversation/continuation; a separate official native OpenCode backend owns only its own native sessions.
- Rust owns managed Goal/SpecVersion/Run/Task/Attempt, ToolBatch control, effects/leases/receipts, Evidence/Verification and durable automation control.
- Direct coding does not require a Goal.
- Every mutation crosses the same Guard/ExecutionHost; plugin/MCP/LSP/DAP/browser/desktop/REPL/automation origins do not bypass it.
- User-selected provider/model/harness does not silently change.
- No hidden paid-provider/search/judge fallback.
- One canonical capability registry; aliases cannot alter authority.
- One process supervisor/execution boundary; do not create parallel runtimes.
- Model self-report is not completion evidence.

## Execution loop

inspect -> choose first unblocked dependency -> write failing/acceptance test -> implement smallest integrated slice -> run targeted tests -> inspect diff -> negative/recovery test -> record evidence -> continue.

Do not stop after a superficial green unit test if the vertical gate remains unverified. Do stop when a product/security/payment/platform decision is genuinely required.

After each completed slice, immediately select the next unblocked dependency from the operative plan rather than waiting for another prompt, unless a genuine decision/permission blocker is reached.

## Worktree, build-output and disk hygiene

Disk space is a constrained resource. Worktrees and generated build outputs are leases, not permanent artifacts.

At the start of every substantial work unit, before spawning build-heavy subagents, and after every build-heavy/subagent phase:
- inspect existing Git worktrees and their owners/status;
- inspect active Cargo/Bun/Node/test processes before starting duplicates;
- inspect free disk space and the size of repo/worktree build-output directories, especially Rust `target` trees and other generated caches;
- reuse an existing safe workspace/build output when practical instead of creating another equivalent one;
- stop spawning new worktrees/builds if disk growth is unexpected until it is understood.

Worktree rules:
- prefer the current tree for a bounded single-writer change;
- inspect existing worktrees/leases before creating another;
- use a bounded pool; never create one worktree per tiny subagent by default;
- a subagent may create a worktree only when isolation materially helps;
- every agent-created temporary worktree must have an owner/task recorded;
- when that subagent/task is integrated, rejected or otherwise finished, and no process is using it, inspect it for dirty/untracked/user-owned state, then remove the agent-created worktree and run `git worktree prune` to drop stale administrative entries;
- never delete or prune a dirty, unknown, externally created or user-owned worktree; quarantine ambiguity instead.

Build-output rules:
- avoid compiling the same large Rust/Tauri tree independently in many temporary worktrees unless isolation requires it;
- do not launch a duplicate build while an equivalent build is already running;
- temporary worktree `target`/generated build directories are disposable only after confirming no active process uses them and no required evidence depends on them;
- after removing an agent-created temporary worktree, remove its regenerable build outputs as part of cleanup when safe;
- keep the primary useful build cache rather than repeatedly cleaning/rebuilding it;
- do not run broad `cargo clean`, cache purge, or delete shared caches unless explicitly authorized.

Always release agent-owned processes, ports, test databases and temporary resources at task completion.

Do not kill unrelated active builds/processes.

## Subagents

Use only for genuinely independent read/test/review work with bounded scope. Main agent owns integration and final verification.

A child receives exact objective, files/read-only vs write set, architecture owner, capabilities, budget and return evidence. Child assertion is not proof.

Before spawning a child, decide whether it truly needs a separate worktree/build. Prefer read-only/shared-source subagents when possible. The parent is responsible for cleaning up every worktree/process/build artifact it caused the child to create.

## Source reuse

External repositories are research/source references only. Use exact immutable pins from arch_V1/42. Before copying/translating code:
- inspect exact file and callees/tests;
- review license/dependencies/notices;
- decide REUSE EXISTING / ADAPT ALGORITHM / ADAPTER / REJECT;
- preserve Horizon owner/Guard;
- prove with local tests.

Never replace local OpenCode packages with a clean upstream checkout.

## Verification truth

Statuses are distinct:
DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED.

Schema/catalog/docs are not runtime proof.

Before reporting a slice complete, state:
- changed files/functions;
- owner/capability IDs;
- exact tests and result;
- negative/recovery case;
- platform/provider/backend actually exercised;
- remaining unsupported paths;
- temporary worktrees/processes/build outputs created, and whether they were cleaned up;
- current disk/build-output sanity check if the slice was build-heavy.

## Safety/repository operations

No reset, clean, destructive rebase, force-push, user-content deletion, broad cache purge, credential export, paid API use, or commit/push unless explicitly authorized.

Current repository has substantial uncommitted work: preserve it.
