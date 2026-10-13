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

## Execution loop — parallel modules, staged verification

inspect -> identify critical path + independent substantial modules -> delegate bounded full modules -> implement in parallel -> child-owned targeted tests -> integrate once -> shared negative/recovery/acceptance checks -> record evidence -> continue.

Do not reduce implementation work to tiny sequential slices when the HLD/LLD contracts already allow independent module ownership. Prefer completing an entire coherent subsystem per subagent, with one independently reviewable outcome. Keep slices small **only** where correctness, unresolved interfaces, security risk, or scarce resources make a larger handoff unsafe.

**Verification pyramid for faster iteration:**
1. **During editing / in each subagent:** typecheck or compile only affected package(s), run directly affected unit/contract/negative tests, and use lint/format/diff checks for changed files. A test failure should trigger a focused repair and rerun, not a restart of every package's suite.
2. **At a module handoff:** execute the relevant integration path and denied/failure case for that module, inspect its diff, and prove the contract it claims. Reuse fixtures and caches; don't repeatedly regenerate unchanged Rust targets, install dependencies, or re-read the entire codebase.
3. **At an integration wave or meaningful gate:** the main agent runs the relevant cross-module tests once, checks races/state transitions and real Rust Guard behavior, and addresses regressions. Run the full workspace typecheck/build at defined milestone/merge/release boundaries, **not after every helper edit or every subagent**.
4. **Before publishing, committing/pushing when required, or declaring V1 complete:** run the applicable required repository/CI/release gates in full. Never delete, bypass or falsely report a mandatory check. Timeouts, cached success, isolated unit mocks and child claims have different evidentiary strength; report them accurately.

Avoid redundant validation: when a prior result applies to an unchanged revision, record/reuse it; rerun affected checks when code or dependent types change. Run only one equivalent heavyweight Cargo/TypeScript job at a time per constrained WSL machine; parallelize independent **coding work**, not simultaneous resource-heavy compiles. Keep progress visible with completed modules, not hundreds of repetitive test invocations.

Do not stop after a superficial green unit test if the vertical gate remains unverified. Do stop when a product/security/payment/platform decision is genuinely required.

After each integrated module, immediately select the next unblocked dependency from the operative plan rather than waiting for another prompt, unless a genuine decision/permission blocker is reached.

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

## Subagents — large-module parallel implementation by default

**Optimize for completed, verified modules per unit of wall-clock time, not tiny agent slices or maximum token consumption.** When 2 or more substantial tasks are independent, proactively delegate their full implementation to subagents instead of sequentially doing everything in the main agent. Do not restrict subagents to read/test/review work: capable coding subagents are expected to **design within the approved contract, implement, test and deliver entire bounded modules**.

- At each implementation gate, map the dependency graph and identify the critical path. Split work by durable module/interface ownership (for example: a Rust Guard origin adapter, its independent TypeScript integration, another independent capability module, test fixtures, or a distinct UI surface), not one helper function or one Markdown section per agent.
- Delegate the **largest safe independently integrable work packages**: a child owns its designated subsystem from source inspection through functioning code, normal/negative tests, local validation, and integration notes. Supply objective, acceptance criteria, exact files and allowed write set, owning HLD/LLD sections, public types/APIs, dependencies, permissions, expected tests, budget, and finish/stop conditions.
- Parallelize implementation immediately when contracts are stable. Start with 2–4 independent modules where agent availability, quota, CPU/RAM and disk permit; run fewer when a task is dependency-bound or build-heavy. One main agent coordinates the contract, resolves conflicts, owns the final integrated revision and judges whether the original objective works.
- Give subagents meaningful implementation authority inside **non-overlapping file/write scopes**. Prefer shared read-only context and independent writable modules. When same-file edits or Git conflicts are unavoidable, serialize that boundary or use an explicitly owned isolated worktree/branch; never allow uncoordinated concurrent writers to shared files.
- Do not make every child repeatedly load all architecture docs. Give the exact owner slices and concrete existing entry points. Do not ask a subagent to rediscover settled decisions or reinvent provider/session/Guard authorities.
- Schedule work in waves: first interfaces/fixtures/unblocking dependencies, then parallel modules, then one integration-and-verification pass. While children implement, the parent should address separate integration dependencies, unblock children and prepare acceptance, not merely await status updates.
- Children return **changed files/functions, contract deviations, commands and results, negative cases, known limitations, and integration instructions**. A child saying “done” is not verification. The parent inspects the code/diff and runs the minimal joint integration checks before declaring the module complete.
- Prefer a small number of meaningful subagents over dozens of microtasks. Stop/reassign children that repeatedly duplicate work, cannot progress, exhaust budgets, or create merge conflicts. Do not spawn speculative agents when there is no independent work.
- A subagent may own local tests but must not run another full 36-package typecheck, whole-workspace build, or overlapping Rust compilation by default. The parent schedules shared heavy verification once per integration wave; child runs targeted checks for its own module.
- Retain all Rust Guard, approval, permission, model/cost, evidence and fail-closed constraints. **Faster means less duplication and smarter parallelism—not skipping real tests, unauthorized effects, or claiming mocks prove the product works.**

Before spawning a child, decide whether it truly needs a separate worktree/build. Prefer read-only/shared-source subagents when possible. The parent is responsible for cleaning up every worktree/process/build artifact it caused the child to create, consistent with the worktree/disk rules above.

## Source reuse

External repositories are research/source references only. Use exact immutable pins from arch_V1/42. Before copying/translating code:
- inspect exact file and callees/tests;
- review license/dependencies/notices;
- decide REUSE EXISTING / ADAPT ALGORITHM / ADAPTER / REJECT;
- preserve Horizon owner/Guard;
- prove with local tests.

Before designing an unknown, absent, or underspecified feature, perform a reference-gap check against existing local/pinned implementations rather than inventing a parallel capability or UI. Prioritize the user-highlighted OpenCode and Oh My Pi references:
- OpenCode: https://github.com/anomalyco/opencode
- Oh My Pi: https://github.com/can1357/oh-my-pi
For settings and other UI work, inspect Oh My Pi's Settings panel behavior, source, state, and tests; screenshots alone are insufficient. References inform implementation but never override HorizonCode's normative architecture, canonical owner, Guard, or capability registry. Prefer local/pinned source; before adapting or copying code, record its immutable revision, license, dependencies, and provenance in `arch_V1/42`. Do not create a new external connection or add dependencies without authorization.

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

## Deferred TODO — ONLY after V1 is built and verified

Do not spend V1 implementation time on a broad branding/build rewrite. Once V1 end-to-end acceptance, regressions, Guard and release baseline all pass, execute the **Post-V1 HorizonCode-only TypeScript/build/naming refactor** specified in `arch_V1/10-DELIVERY.md §10.12` and the final deferred gate in the operative implementation plan. Its output must have coherent first-party `horizoncode` names (optional `hzcode` executable alias), faster incremental TypeScript build/typecheck/test workflows, complete CI/release validation, clean installs and migration tests. Preserve legitimate upstream `@opencode-ai/*` dependencies and required legal attributions until tested migration; never mass-rename them mid-V1. This is a **backlog item**, not current implementation scope.

## Safety/repository operations

No reset, clean, destructive rebase, force-push, user-content deletion, broad cache purge, credential export, paid API use, or commit/push unless explicitly authorized.

Preserve the working tree as found; it may contain changes from another agent/session.
