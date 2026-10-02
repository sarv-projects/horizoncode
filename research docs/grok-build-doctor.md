# Grok Build Doctor source review

Review date: 2026-09-29  
Repository: [`xai-org/grok-build`](https://github.com/xai-org/grok-build)  
Pinned revision: [`2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8)  
License: Apache-2.0 (`LICENSE` at the pinned repository root). No source code, tests, or schema were copied.

This is a focused source review of Doctor and its direct command/probe/fix paths, not a
claim that every line or subsystem in Grok Build was audited. Source paths below link
to immutable commit URLs, which are the reproducible references for this review.

## Source paths inspected

- [`doctor_cmd/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/doctor_cmd/mod.rs) — CLI args, report/fix/list dispatch, TTY confirmation, post-fix report.
- [`doctor_cmd/json.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/doctor_cmd/json.rs) — versioned JSON projection.
- [`doctor_cmd/human.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/doctor_cmd/human.rs) and [`diagnostics/doctor_format.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/doctor_format.rs) — standalone and in-TUI human projections.
- [`diagnostics/model.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/model.rs) — typed facts, runtime availability states, stable finding IDs and report.
- [`diagnostics/probes/mod.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/probes/mod.rs) — standalone vs TUI evidence and selective runtime probes.
- [`diagnostics/fix.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/fix.rs) — finite fix registry, environment revalidation, plan/preview, apply, backup and result checks.
- [`slash/commands/doctor.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/slash/commands/doctor.rs) and [`app/dispatch/prompt.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/app/dispatch/prompt.rs) — strict slash parsing and typed Doctor action routing.
- [`doctor_cmd/tests.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/doctor_cmd/tests.rs), [`diagnostics/fix_tests.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/fix_tests.rs), and [`diagnostics/doctor_format_tests.rs`](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/crates/codegen/xai-grok-pager/src/diagnostics/doctor_format_tests.rs) — parser, report formatting and fix-planning tests. They were inspected as source, not run.

## HLD and LLD observations

The command surface is a projection over one diagnostics model, rather than a model
prompt: CLI `/doctor`-equivalent dispatch and the in-session slash command both collect
diagnostics and render findings. The typed report includes facts, findings and probe
notes. Runtime facts distinguish available, no reply and unavailable; individual
probes also preserve unsupported and error states. Finding IDs use stable domain/item
names, and issue counts are distinct from recommendations.

The CLI supports human and schema-versioned JSON output. TUI reporting adds facts only
available after the interactive terminal started. Standalone reporting deliberately
does not run live tmux subprocesses that could hang; relevant live queries are used only
when planning a requested fix. The fix path resolves an ID through a static registry,
re-collects required facts, constructs a target-specific plan, previews it, requires
confirmation by default, applies a constrained change, and checks the resulting state.
The implementation also exposes `--yes` for CLI fixes; that flag is not part of the
HorizonCode design because repair authority must stay with authenticated Guard control.

This Doctor is specialized for terminal, color/theme, clipboard, keyboard, and voice
readiness. Its IDs and fixes should not be copied as a HorizonCode inventory.

## Decision for HorizonCode

**Adopt the pattern, not the product-specific checks or implementation.** Add one
`CMP-diagnostics` report service shared by `hzcode doctor [--json]` and `/doctor`.
HorizonCode's report should include relevant local runtime, config, provider metadata,
extension, and declared enforcement observations; provider reachability stays on the
separate explicitly confirmed `hzcode providers test` path. It must not imply that a
configured sandbox or connector is operational without evidence.

The useful details to carry over are:

1. Stable finding IDs and typed partial/unknown states, so a failed or unsupported probe
   is not rendered as success.
2. One canonical report with human and versioned JSON renderers, shared by CLI and TUI.
3. Separate read-only report collection from a named repair path. Repairs revalidate
   the current facts/target, show exact changes, use the owning service, and verify a
   postcondition.
4. Skip unsafe or potentially hanging probes in a noninteractive report; probe only
   what the selected diagnostic/fix needs and keep every probe bounded.

HorizonCode strengthens the fix boundary: finite first-party fix IDs only, exact
preview, authenticated Guard confirmation, safe backup/atomic application, durable
audit receipt, and postcondition evidence. No free-form shell repair, fix-all,
unattended `--yes`, provider request during normal diagnostics, or implication that
configuration is runtime enforcement.

## Other patterns considered

The broader Grok Build HLD/LLD was also checked against the HorizonCode component and
requirement map. The recurring architectural patterns below are already represented in
our target design, so they do not warrant duplicate components or another state owner:

| Grok Build boundary | HorizonCode mapping | Decision |
|---|---|---|
| `MvpAgent` host with per-session actors and handles | `CMP-orch`, `CMP-runner`, `CMP-session`, `CMP-control-api` | Keep one durable controller and explicit Thread/WorkerExecution ownership. Actor tasks are a sound implementation technique where one owner serializes mutation, not a new architecture layer. |
| `ChatStateActor` plus session persistence actor/FIFO writes | `CMP-session`, event log, and runner-only event writes in `ARCH/core/SESSION-AND-THREADS.md`/`ARCH/core/AGENT-LOOP.md`; separate audit and analytics stores in `DEC-020` | The target already has one canonical event writer and separates audit/analytics. Keep canonical event history separate from model-context projections; an actor is an implementation choice, not another state owner. |
| Immutable `Agent`/builder, semantic ToolKind and `ToolBridge` | `CMP-context`, `CMP-tools`, `REQ-CTX-010`, provider/extension capability contracts | Already specified as typed context assembly, permission-filtered materialization, and dynamic tool discovery. Do not add a parallel Grok-style bridge/namespace layer. |
| `WorkspaceOps` effect boundary and hook → permission → sandbox chain | `CMP-tools` → `CMP-guard` → `CMP-sandbox` → `CMP-audit`, `DEC-077` | Already explicit and stricter; hooks remain subordinate to Guard and cannot grant effects. |
| Child SessionActors, subagent coordinator, goals and workflow state machines | `CMP-orch`, durable Task/Attempt/WorkerExecution graph, independent verifier, `DEC-039`/`DEC-069` | HorizonCode already models durable work and host-owned continuation. Do not add another task/goal store or copy Grok's one-level topology. |
| Provider sampler retries and doom-loop detector | `CMP-provider`, `REQ-PROV-015`, runner/controller no-progress rules | Bounded retry and no-progress behavior are already required. Defer token-pattern doom-loop heuristics unless a task-matched evaluation shows benefit; they must not replace durable progress/evidence checks. |
| Shared TUI/headless/ACP runtime | `CMP-control-api`, `CMP-tui`, `CMP-headless`, `CMP-acp` | Already the target. Surfaces stay adapters over shared services. |

| Grok Build pattern | Decision | Reason |
|---|---|---|
| Typed slash command returns a Doctor action instead of sending `/doctor` to the model | Keep | `REQ-UI-012` already requires one typed registry and no fallthrough to model prompts. |
| Command registry tracks aliases, source, feature/tool availability and collisions | Keep existing target | `REQ-UI-012` and `ARCH/product/COMMANDS-AND-SETTINGS.md` already define one source-aware registry; no second catalog is needed. |
| Extensions slash aliases deep-link into a category overlay | Already adopted | `DEC-078` / `AX-378` already record this pattern. |
| Same finding system powers startup warnings and Doctor | Adopt within diagnostics | One canonical finding model should feed startup summary and full report, preventing duplicate predicates/messages. |
| Fetch every Extensions tab when opening one category | Do not adopt literally | HorizonCode requires bounded cancellable work and explicit loading/error/empty states; selected category plus bounded summaries is enough. |
| `/tasks` aggregates terminal jobs, subagents and schedules | No new design change | HorizonCode already owns the canonical task/run graph and task panel; do not create a second task source. |
| `/btw` starts a parallel side-answer while the main turn runs | Defer | Adds another concurrent model path, budget/privacy surface, and arbitration behavior; the existing durable question broker is the better current boundary. |
| Grok flat one-level subagent topology, terminal fixes, experimental memory/Dream | Do not adopt | They do not improve the current target contract and would conflict with HorizonCode's durable task graph, memory consent, and platform-neutral diagnostics scope. |

The source pattern is recorded by `SRC-030`, `U-GROK-DOCTOR`, `DEC-079`, and task
`AX-392`. HorizonCode implementation is absent at the reviewed baseline.
