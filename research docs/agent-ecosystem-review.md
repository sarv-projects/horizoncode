# Swarms, budgets, agents, and workspace source review

Review date: 2026-09-28. Read-only targeted inspection of implementation paths,
schemas, and selected tests in the pinned repositories below. No tests/benchmarks were
run and no upstream code was copied. A listed repository head/license is not evidence
that every dependency or subtree shares that license; see the upstream license and
`docs/research/SOURCE-LEDGER.md` before any implementation reuse.

| Repository | Commit | License observed |
|---|---|---|
| [ruvnet/ruflo](https://github.com/ruvnet/ruflo/tree/b636802d8c7dbe2deabf1b8417ae99c0dbc327e4) | `b636802d8c7dbe2deabf1b8417ae99c0dbc327e4` | MIT |
| [Kilo-Org/kilocode](https://github.com/Kilo-Org/kilocode/tree/2dfe6fc876fd7c99132c0dc7565d4edd1ce2b8c0) | `2dfe6fc876fd7c99132c0dc7565d4edd1ce2b8c0` | MIT; OpenCode-derived attribution in license |
| [affaan-m/ECC](https://github.com/affaan-m/ECC/tree/d3b8a3e908904e242ed2dbe66af62cca71131419) | `d3b8a3e908904e242ed2dbe66af62cca71131419` | MIT |
| [wshobson/agents](https://github.com/wshobson/agents/tree/9b15b34b0bfc13a815cbfc2366e14ea549e09422) | `9b15b34b0bfc13a815cbfc2366e14ea549e09422` | MIT |
| [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent/tree/73f7fc2ca54c21251b8486894677053ee60405d5) | `73f7fc2ca54c21251b8486894677053ee60405d5` | MIT |
| [superset-sh/superset](https://github.com/superset-sh/superset/tree/f37599e2774a99dce67f21b887c88bac331da6fc) | `f37599e2774a99dce67f21b887c88bac331da6fc` | Elastic License 2.0; pattern-only, do not copy |
| [getagentseal/codeburn](https://github.com/getagentseal/codeburn/tree/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9) | `b8a9f3cc5290adfd17add6c92444dc56f2aea3e9` | MIT; check bundled notices separately |
| [HKUDS/nanobot](https://github.com/HKUDS/nanobot/tree/4f7479ca64eae6e5ebe8985a22a3caf5fc362664) | `4f7479ca64eae6e5ebe8985a22a3caf5fc362664` | MIT |

## Findings

### Ruflo: do not infer durable swarms from swarm branding

At the inspected V3 implementation, `SwarmCoordinator` keeps agents/tasks/assignments
in process-local maps; local event-emitter messages have no durable delivery or
acknowledgements; distribution uses current in-memory load/capability data and runs
assignments via `Promise.all`. The inspected consensus path describes itself as a
simulation and uses randomized votes; the simple `Agent.executeTask` path is a callback
and timer. These findings apply to the cited files, not every Ruflo version or every
other runtime path.

Pinned evidence: [`SwarmCoordinator.ts`](https://github.com/ruvnet/ruflo/blob/b636802d8c7dbe2deabf1b8417ae99c0dbc327e4/v3/src/coordination/application/SwarmCoordinator.ts),
[`Task.ts`](https://github.com/ruvnet/ruflo/blob/b636802d8c7dbe2deabf1b8417ae99c0dbc327e4/v3/src/task-execution/domain/Task.ts),
[`task-orchestrator.ts`](https://github.com/ruvnet/ruflo/blob/b636802d8c7dbe2deabf1b8417ae99c0dbc327e4/v3/%40claude-flow/swarm/src/coordination/task-orchestrator.ts),
[`topology-manager.ts`](https://github.com/ruvnet/ruflo/blob/b636802d8c7dbe2deabf1b8417ae99c0dbc327e4/v3/%40claude-flow/swarm/src/topology-manager.ts).

**HorizonCode:** preserve bounded worker scheduling, durable mailbox receipts, task DAG
truth, and independently verified evidence. Do not adopt simulated consensus or
process-local assignment state as proof of swarm capability.

### Kilo: quota observations, local warning, remote billing limits, and Agent Manager

Reviewed Kilo at [`2dfe6fc876fd7c99132c0dc7565d4edd1ce2b8c0`](https://github.com/Kilo-Org/kilocode/tree/2dfe6fc876fd7c99132c0dc7565d4edd1ce2b8c0), MIT with an OpenCode attribution notice. This focused review covers quota/cost UI, usage aggregation, task/subagent flow, Agent Manager coordination, and selected tests; it is not a complete repository audit. Tests were inspected but not run.

Kilo exposes three distinct mechanisms that must not be conflated:

1. **Provider quota panel: observation/cache.** `provider-usage.ts` returns source kind, readiness/staleness, reset windows, errors, and identity-scoped data. The instance-local cache uses 60-second success and 10-second failure TTLs, singleflight refresh, and stale-value retention on retryable errors. It is not durable across process restart and does not reserve local spend. Current adapters cover a narrow Kilo-managed-plan/MiniMax/Codex set, not arbitrary-provider quota discovery. `/usage` (aliases `/plans`, `/quota`) displays provider-reported windows and permits manual refresh; stale/error is visible, not a hard stop.
2. **Gateway billing controls: remotely described caps.** Product docs describe balance/per-user caps and alerts. These are remote service claims, not locally enforced orchestration reservations; free request rate limits are not per-run budgets.
3. **`/cost-alert`: local soft UI nudge.** It is nonblocking, session-scoped, stored in memory, rounds positive dollar thresholds upward, and is lost on TUI restart. “Stop” requests session abort; it is not a durable hard ceiling. Its inputs are reported/calculated session costs, and the source comments warn that update events are not reliable cost signals.

Usage aggregation reads step-finish parts from SQLite and groups provider/model/token/cost values for a root session family or session descendants; usage is incurred telemetry, not an invoice guarantee or pre-dispatch budget. Child task execution propagates cost deltas with an in-process keyed promise chain to avoid parent-message read/modify/write races, but this does not create an atomic reservation across parallel workers.

Kilo `TaskTool` is still child-session delegation: `task_id` resolves to a direct child Session ID for resumption. Its VS Code Agent Manager is a separate multi-session/worktree surface with overview, prompt, stop, move, and MCQ answer operations. Question schema supports bounded batches/options and multi-select/custom answers, but pending request correlations live in memory with timeout/cancel/disposal handling; the bridge's active/admission/reply maps reset on backend reconnect. This is useful orchestration UX and request routing, not durable Run/Task/Attempt state. Parent/workspace checks and permission/question blocker checks are useful; a response is task input, never authorization.

Pinned source evidence: [quota adapter/cache](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/core/src/kilocode/provider-usage.ts), [MiniMax usage transport](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/core/src/kilocode/provider-usage/minimax/usage.ts), [soft cost nudge](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/core/src/kilocode/cost/max-cost-nudge.ts), [TUI nudge state](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/opencode/src/kilocode/cli/cmd/tui/context/nudge.tsx), [usage aggregation](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/opencode/src/kilocode/session/model-usage.ts), [Task tool](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/opencode/src/tool/task.ts), [Agent Manager protocol](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/opencode/src/kilocode/agent-manager/protocol.ts), [orchestration bridge](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/kilo-vscode/src/agent-manager/orchestration-bridge.ts), and [worktree/session domain checks](https://github.com/Kilo-Org/kilocode/blob/2dfe6fc876fd7c99132c0/packages/kilo-vscode/src/agent-manager/orchestration-domain.ts).

Inspected test paths cover cache staleness, key rotation, concurrent refresh and provider isolation (`packages/core/test/kilocode-provider-usage.test.ts`); quota endpoint and UI are in `packages/core/test/kilocode-provider-usage-location.test.ts`; soft nudge parsing/state in `packages/opencode/test/kilocode/cli/cmd/tui/cost-alert.test.ts` and `packages/core/test/kilocode/cost/max-cost-nudge.test.ts`; session-family usage and child totals in `packages/opencode/test/kilocode/session-model-usage.test.ts` and `stats-subagent-cost.test.ts`; and Agent Manager request correlation, workspace isolation, bad replies, timeout/cancel/disposal in `packages/opencode/test/kilocode/agent-manager-service.test.ts` plus `packages/kilo-vscode/tests/unit/agent-manager-orchestration-bridge.test.ts`.

**HorizonCode:** keep `ExternalQuotaSnapshot` separate from the durable budget ledger; retain provider/account identity fingerprint, fetched time, freshness/reset semantics, source error and units, and mark stale/missing usage as unknown. Hard local control remains atomic reserve-before-dispatch at run/task/attempt/worker/verifier/recovery levels. Use quota telemetry only for display/route advice. Persist selectable question receipts and AgentProfile/model routing in Horizon's own controller model; only task/evidence truth survives agent/session replacement. Map warnings and soft alerts to configurable UX, while policy-backed budgets remain deterministic stops.

### Hermes: explicit subagent lifecycle but process-local registry

Hermes models `Pending`, `Starting`, `Running`, `Succeeded`, `Failed`, `Interrupted`,
`CancelRequested`, `Cancelled`, and `Unknown` and records role/model/tools/workdir,
parent session/correlation, timeout, and usage. The inspected executor/registry is
in-process; child resume after process restart is unavailable. Per-launch working
directory/timeouts are restricted and toolsets are allowlisted.

Evidence: [`agent/subagent_lifecycle.py`](https://github.com/NousResearch/hermes-agent/blob/73f7fc2ca54c21251b8486894677053ee60405d5/agent/subagent_lifecycle.py).

**HorizonCode:** lifecycle vocabulary is a useful crosswalk for `WorkerExecution`; keep
durable Attempt/task identity and restart reconciliation outside the worker adapter.

### Superset: bind terminal events to the workspace and launch that produced them

Superset binds terminal/workspace/agent/session/launch identifiers, distinguishes
detach, terminal exit, resume, and disposal, and retains ended bindings for resume.
Status is inferred from observed hooks and is not proof of progress/correctness. Child
transcript scans are bounded and may report incomplete coverage. The inspected built-in
agent launch configurations include permission-bypass flags; those are not HorizonCode
defaults. The source is Elastic License 2.0 and is used as pattern-only research.

Evidence: [`terminal-agent types`](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/types.ts),
[`store`](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/store.ts),
[`binding matcher`](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/matches-agent-binding.ts),
[`subagent transcript`](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/subagent-transcript.ts),
[`builtin launch profiles`](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/builtin-terminal-agents.ts).

**HorizonCode:** ensure every observed terminal event matches the current
workspace/launch/fence before updating UI state; label incomplete logs and hidden
subagents as unknown; explicitly reject unsafe bypass launch profiles.

### CodeBurn: useful transcript accounting; not a hard-budget authority

CodeBurn parses multiple CLI transcript formats into provider/model, token classes,
cost basis, subagent, skills, project, and session fields. Its guard incrementally
parses transcript changes and enforces a configured session USD ceiling through
Claude-specific hooks. Outer error handling can fail open, and inferred transcript
costs are not atomic reservations for concurrent runs.

Evidence: [`provider types`](https://github.com/getagentseal/codeburn/blob/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9/src/providers/types.ts),
[`provider parsers`](https://github.com/getagentseal/codeburn/blob/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9/src/providers/index.ts),
[`guard usage`](https://github.com/getagentseal/codeburn/blob/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9/src/guard/usage.ts),
[`guard hooks`](https://github.com/getagentseal/codeburn/blob/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9/src/guard/hooks.ts),
[`budget`](https://github.com/getagentseal/codeburn/blob/b8a9f3cc5290adfd17add6c92444dc56f2aea3e9/src/budget.ts).

**HorizonCode:** use usage parsers only as source-specific observation adapters after
license review. Keep `CMP-orch`'s atomic deterministic reservations as enforcement;
analytics/transcript parsing is reconciliation/visibility, not the spend gate.

### Nanobot and ECC: lightweight telemetry patterns, limited attribution

Nanobot records content-free per-provider-call usage, latency/TTFT, and errors in
SQLite WAL; its inspected context lacks per-subagent/task attribution and billed-cost
normalization. Its process manager uses PID/command/status records, rotating logs,
locks, and health/readiness checks. ECC estimates context budgets heuristically and
parses Claude transcripts into local JSONL cost snapshots; neither inspected feature is
cross-provider quota enforcement.

Evidence: [Nanobot usage models](https://github.com/HKUDS/nanobot/blob/4f7479ca64eae6e5ebe8985a22a3caf5fc362664/nanobot/llm_usage/models.py),
[usage store](https://github.com/HKUDS/nanobot/blob/4f7479ca64eae6e5ebe8985a22a3caf5fc362664/nanobot/llm_usage/store.py),
[usage context](https://github.com/HKUDS/nanobot/blob/4f7479ca64eae6e5ebe8985a22a3caf5fc362664/nanobot/llm_usage/context.py),
[process runtime](https://github.com/HKUDS/nanobot/blob/4f7479ca64eae6e5ebe8985a22a3caf5fc362664/nanobot/process_runtime.py),
[ECC context-budget skill](https://github.com/affaan-m/ECC/blob/d3b8a3e908904e242ed2dbe66af62cca71131419/skills/context-budget/SKILL.md),
[ECC cost tracker](https://github.com/affaan-m/ECC/blob/d3b8a3e908904e242ed2dbe66af62cca71131419/scripts/hooks/cost-tracker.js).

**HorizonCode:** content-free telemetry and inspectable local state may reduce privacy
risk, but retain exact `run/task/attempt/Thread/agent/provider` attribution when
observable and keep estimated/actual/included/unknown distinct.

### wshobson/agents: catalogs and adapters, not an execution runtime

This is a plugin/agent catalog and config-generation tool. It keeps a canonical plugin
source and adapts output for different harnesses; adapters can translate tools/models/
schemas. Validation must surface unsupported capabilities instead of silently
pretending that generated configurations are equivalent.

Evidence: [`ARCHITECTURE.md`](https://github.com/wshobson/agents/blob/9b15b34b0bfc13a815cbfc2366e14ea549e09422/ARCHITECTURE.md),
[adapter base](https://github.com/wshobson/agents/blob/9b15b34b0bfc13a815cbfc2366e14ea549e09422/tools/adapters/base.py),
[generated-config validator](https://github.com/wshobson/agents/blob/9b15b34b0bfc13a815cbfc2366e14ea549e09422/tools/validate_generated.py).

**HorizonCode:** reinforces the planned separation between profiles/catalog, adapter
capabilities, trust/installation, and execution. A catalog entry is not a running
agent.

## Architecture and test-plan effect

The current HorizonCode design already has the key ownership separations: task DAG vs
Thread tree (`ARCH/product/AGENT-MESSAGING.md`), durable inbox receipts, per-run/task/attempt accounting, and
atomic local budget reservation distinct from provider-reported quota (`ARCH/product/ANALYTICS.md`,
`ARCH/execution/LONG-HORIZON.md`, `REQ-ORCH-009`). No second scheduler, agent registry, or budget owner should
be introduced for these findings. The useful incremental acceptance cases are:

- stale provider quota observation with expired/reset period; display as stale/unknown
  and never use it as proof of available local reservation;
- duplicate/stale terminal hooks, terminal-to-workspace rebinding, and incomplete
  transcript/log scans;
- peer question pending across restart, stale/wrong Thread response, and custom answer;
- telemetry gaps/double counting for parent+child agents and safe unknown provider
  billing;
- adapter capability degradation after config generation or peer version change;
- bypass permission flags rejected unless the user explicitly selected an allowed
  policy profile, then enforced through HorizonCode's own guard/sandbox.

These are proposals for validation, not claims about current HorizonCode behavior.
