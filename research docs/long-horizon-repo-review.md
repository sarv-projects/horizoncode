# Long-horizon harness source review

Review date: 2026-09-28. Read-only source inspection; no upstream tests or benchmark
results were run. No source code was copied. Findings below are pinned observations,
not claims that these systems are more reliable than HorizonCode.

| Repository | Revision reviewed | License observed |
|---|---|---|
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow/tree/8a3a309d1ce8bac8418251be29d4e4297a20c5eb) | `8a3a309d1ce8bac8418251be29d4e4297a20c5eb` | MIT |
| [AMAP-ML/LongHorizon-Harness](https://github.com/AMAP-ML/LongHorizon-Harness/tree/a1dd930614972b92361c1b9cd6aac441a6db5a65) | `a1dd930614972b92361c1b9cd6aac441a6db5a65` | MIT |
| [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness/tree/4878cdabd87d4041bdaff61d04c966883b9fd07a) | `4878cdabd87d4041bdaff61d04c966883b9fd07a` | MIT |
| [HKUDS/DeepCode](https://github.com/HKUDS/DeepCode/tree/84c37f79c726bd12e74e39541adceb8b5e47b0d5) | `84c37f79c726bd12e74e39541adceb8b5e47b0d5` | MIT |
| [plandex-ai/plandex](https://github.com/plandex-ai/plandex/tree/e2d772072efadbe41d2946d97d79be55532dbab5) | `e2d772072efadbe41d2946d97d79be55532dbab5` | MIT |

MIT licenses still require retaining their notices. Dependencies, fixtures, benchmark
assets, and other subtrees require separate license checks. “MIT repository” does not
prove every included artifact is redistributable.

## DeerFlow

The inspected architecture is a Python runtime/gateway with a TypeScript frontend and
checkpoint-backed runs. Goals are thread-scoped; their evaluator judges bounded visible
conversation content and continuation is capped (eight continuations, two consecutive
no-progress rounds). The evaluator is an LLM, not an independent test runner. Before
recording an evaluation or scheduling continuation, the worker re-reads goal/checkpoint
state and yields if user input or conversation state changed while evaluation ran.

Useful pinned paths: [`goal.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/runtime/goal.py),
[`worker.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/runtime/runs/worker.py),
[`manager.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/runtime/runs/manager.py),
[`checkpoint_lineage.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/app/gateway/checkpoint_lineage.py),
and [`checkpoint_retention.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/app/gateway/checkpoint_retention.py).
Recovery uses leases/heartbeats and marks abandoned runs erroneous instead of blindly
replaying interrupted tool sequences. The parent-lineage replay path validates lineage
and rejects missing/unsafe links. A separate legacy chronological fallback is weaker:
when pending-task state cannot be read, it may still select a replay base. The focused
test `backend/tests/test_checkpoint_lineage.py::test_unknown_pending_tasks_do_not_block_selection`
documents that compatibility behavior. Do not generalize the strict lineage guarantee
to that fallback, and do not copy the permissive fallback into HorizonCode recovery.

### 2026-09-29 clarification and compacted-history follow-up

Pinned DeerFlow `8a3a309d1ce8bac8418251be29d4e4297a20c5eb`. This was not an exhaustive
source read: the inventory contains 3,375 tracked files and 2,700 selected code files
(776,316 lines); 10 were read fully, 14 partially, and 2,676 not fully read. The
per-file coverage ledger is
[`source-audit-coverage/deer-flow-8a3a309d.csv`](source-audit-coverage/deer-flow-8a3a309d.csv).
No tests were run.

DeerFlow's clarification middleware filters a response containing a valid or malformed
`ask_clarification` from its sibling tool calls:
[`clarification_middleware.py:75-94,396-447`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/agents/middlewares/clarification_middleware.py).
That behavior highlighted a missing sentence in HorizonCode's batch LLD, now owned by
`REQ-TOOL-006`/`AX-380`: validate before dispatch, suspend all siblings for one valid
question, and reject malformed/multiple question calls without side effects. This is a
proposed HorizonCode contract, not a copy of DeerFlow's middleware.

DeerFlow also exposes bounded `history_search`/`history_read` tools for pre-compaction,
visible history with stable source references and explicit unavailability:
[`task_continuity/tools.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/agents/task_continuity/tools.py),
[`archive.py`](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/agents/task_continuity/archive.py),
and [durable-context framing](https://github.com/bytedance/deer-flow/blob/8a3a309d1ce8bac8418251be29d4e4297a20c5eb/backend/packages/harness/deerflow/agents/middlewares/durable_context_middleware.py).
HorizonCode has canonical Thread history and a proposed `CMP-session` FTS/history API,
but no model-facing retrieval tool. `ContextItem.source=session` is selection metadata,
not a retrieval interface; UI search (`AX-369`) likewise does not automatically expose
history to an agent. Proposed `AX-385` adds only bounded, current-Thread wrappers over
the same verified history/index owner; it adds no archive store, excludes hidden
reasoning and disabled tool output, reports partial/expired coverage, and treats
retrieved text as untrusted context rather than evidence. `AX-385` depends on `AX-369`
and Thread identity migration `AX-379`.

**HorizonCode disposition:** incorporate a post-evaluation revision/input recheck,
bounded continuation/no-progress policy, and lineage-aware checkpoint retention into
`ARCH/25` acceptance cases. Keep independent code/task verification; DeerFlow's goal
evaluation is not acceptance evidence. These are patterns, not copied code.

## LongHorizon-Harness

This repository includes a process supervisor, manager/executor/auditor workbench,
HTTP/WebSocket snapshots and event replay, role configuration, pause/resume/stop/abort,
approvals, queued instructions, artifacts, and trajectory inspection. The manager
reconstructs planning context from persisted rounds, and outer run handling records
terminal failures on exceptions/cancellation. The supervisor has cross-process locks,
request fingerprints, durable launch reservations, idempotent create/resume, and
distinct `continue` (same run/round history) versus `retry` (new run from saved input)
semantics with a new lifecycle generation. Missing completion evidence fails closed.
Human question/answer and continue/stop gates exist in the manager.

Pinned source: [`manager.py`](https://github.com/AMAP-ML/LongHorizon-Harness/blob/a1dd930614972b92361c1b9cd6aac441a6db5a65/src/lh_harness/manager.py),
[`supervisor/service.py`](https://github.com/AMAP-ML/LongHorizon-Harness/blob/a1dd930614972b92361c1b9cd6aac441a6db5a65/src/lh_harness/supervisor/service.py),
[`types.py`](https://github.com/AMAP-ML/LongHorizon-Harness/blob/a1dd930614972b92361c1b9cd6aac441a6db5a65/src/lh_harness/types.py),
and [evaluation guidance](https://github.com/AMAP-ML/LongHorizon-Harness/blob/a1dd930614972b92361c1b9cd6aac441a6db5a65/README.md).
Its role budgets are primarily max wall time plus max rounds, not hierarchical token/USD
reservations; its auditor is another agent, not a deterministic independent suite.
Its listed benchmarks are WeaveBench (114 tasks), OSWorld-V2 (108 tasks), and
Terminal-Bench 2.1. Reproductions use substantial external assets/VM resources and may
take hours; README score claims are not reverified here.

**HorizonCode disposition:** compare launch reservation, crash recovery, and question
flows with `ARCH/25` and `AX-380`; add crash-at-launch and duplicate resume cases to the
test plan. Retain Horizon's bounded, atomic token/cost reservation and verifier-evidence
requirements. Benchmark lanes should be optional heavyweight acceptance jobs, pinned
to dataset/model/environment/evaluator revisions and license-checked.

## DeepSeek-Harness

The TypeScript monorepo uses session event streams/projections. Goal mutations are
versioned and reducer-validated, with per-goal revision and maximum-round fields;
activation is process-local rather than durable. Goal continuation checks live agent,
idle state, flushed history, revision, and conversation freshness. Its input inbox
persists `steer`/`followup` through session events. Experimental agent teams validate
missing/duplicate/self/cyclic task dependencies and serialize journal mutation per lead
session.

Pinned paths: [`goal/types.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/goal/goal/src/types.ts),
[`goal/fold.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/goal/goal/src/fold.ts),
[`goal-round-driver`](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/goal/goal-round-driver/src/index.ts),
[`inbox.ts`](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/core/agent-loop/src/inbox.ts),
and [experimental task graph](https://github.com/deepseek-ai/deepseek-harness/blob/4878cdabd87d4041bdaff61d04c966883b9fd07a/packages/experimental/agent-team/src/task-graph.ts).

Its `cacheRetention` option forwards to provider SDKs when supported, while the real
cache-hit end-to-end test is gated on `DEEPSEEK_API_KEY` and exercises the DeepSeek
route only. This does not demonstrate universal prompt-cache behavior. **HorizonCode
disposition:** represent cache capability/request/usage per provider and model; preserve
unknown when unreported; test each provider route. Keep strict projection validation,
goal revisions, and durable input inbox patterns as candidates for `ARCH/07`/`ARCH/25`.

### DeepSeek Harness cache follow-up (2026-09-29)

Pinned at `4878cdabd87d4041bdaff61d04c966883b9fd07a`. This remained a targeted review:
14,004 tracked paths; 5,484 selected code files / 1,144,523 source lines; 2 full,
9 partial, and 5,473 not fully read. See the [coverage ledger](source-audit-coverage/deepseek-harness-4878cdab.tsv).

The follow-up traced prefix and system-prompt semantics. Cache reuse depends on a
byte-identical prefix for the same route; usage separates input, cache-read, and
cache-creation counts. DeepSeek Harness supports appending a changed system prompt
inside history only for models whose endpoint defines a later system message as the
complete effective prompt. It validates that route-specific option, and its integration
tests are DeepSeek-only and opt-in. Relevant pinned paths: `packages/core/agent-loop/README.md`
“KV Cache effect”; `packages/llm/llm-deepseek/src/translate.ts:34-43,143-160`;
`packages/llm/llm/src/types.ts:167-188`; `packages/llm/llm-pi-ai/src/config.ts:153-160,326-349`;
`packages/core/agent-loop/src/agent.ts:410-417`; and
`packages/llm/llm-deepseek/tests/runtime.e2e.ts:357-443`.

HorizonCode already requires deterministic provider rendering, stable prefix ordering,
route-pinned cache capabilities, separate provider-reported usage, and unknown on
missing evidence (`ARCH/09`, `ARCH/11`, `ARCH/19`, `ACC-P1-18`, `AX-384`). This review
adds only a route-specific `in_history_system_prompt_update` capability. Complete
effective-prompt replacement remains the safe default; the optimization is enabled
only when exact request-construction tests prove the effective prompt after update,
removal, compaction, resume, and tool-schema changes. It is independent from cache-hit
support. Deterministic fixtures prove request bytes/usage parsing, not remote cache hits
or lower billing; those require separately authorized route-specific live conformance.
Do not copy DeepSeek auth/model assumptions, cache block sizing, or prompt-update
semantics to other providers.

## DeepCode

The planner uses `planning_checkpoint.json`, append-only `planning_attempts.jsonl`,
and `planning_result_meta.json`. Snapshot writes use temp-and-replace, while JSONL
append has no transaction/fsync guarantee. The inspected plan validator is loose:
required section-name substrings can make `valid` true after YAML parsing fails, even
though `yaml_valid` is false (`planning_runtime.py:130-171`). Treat it as a shape hint,
not a plan-integrity or acceptance gate. The implementation runner has planned-file
tracking, wall-time/iteration limits, loop detection, and a sensitive-path denylist,
but “all planned files implemented” is not test-based acceptance. Its inspected loop
path calls `loop_detector.record_success()` after the tool result even though the
legacy `isError` field was not populated; verify the actual result semantics before
relying on that reset behavior (`code_implementation_workflow.py:268-276`). Its
backup/restore journal covers app state, not project worktrees or executables.

Pinned paths: [`planning_runtime.py`](https://github.com/HKUDS/DeepCode/blob/84c37f79c726bd12e74e39541adceb8b5e47b0d5/workflows/planning_runtime.py),
[`agent_orchestration_engine.py`](https://github.com/HKUDS/DeepCode/blob/84c37f79c726bd12e74e39541adceb8b5e47b0d5/workflows/agent_orchestration_engine.py),
[`code_implementation_workflow.py`](https://github.com/HKUDS/DeepCode/blob/84c37f79c726bd12e74e39541adceb8b5e47b0d5/workflows/code_implementation_workflow.py),
and [`state_backup.py`](https://github.com/HKUDS/DeepCode/blob/84c37f79c726bd12e74e39541adceb8b5e47b0d5/app_server/state_backup.py).

**HorizonCode disposition:** attempt ledgers and phase checkpoints need run/spec/revision
IDs and transactional/corruption behavior; do not use planned-file completion as task
PASS. Test truncated journals and interrupted checkpoint replacement.

## Plandex

Plandex separates a plan/branch conversation from staged generated file results and
explicit Apply records. Active workers are in a process-local registry/goroutines, so
those statuses are not durable worker recovery. Its README says the cloud service wound
down and stopped accepting users; self-hosted/local source remains. This research does
not recommend a dependency on the cloud service.

Pinned paths: [`data_models.go`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/shared/data_models.go),
[`plan_status.go`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/shared/plan_status.go),
[`plan state`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/state.go),
and [`build_exec.go`](https://github.com/plandex-ai/plandex/blob/e2d772072efadbe41d2946d97d79be55532dbab5/app/server/model/plan/build_exec.go).

**HorizonCode disposition:** staged proposal versus explicit apply is a useful UI
concept; keep changes reviewable before integration. Do not borrow in-memory run state
for long-horizon execution.

## Review limits

These were targeted source reviews of the architecture/runtime, state schemas, selected
flows, and relevant tests, not a claim that every file in each large repository was read.
No tests, builds, live services, or benchmarks were executed. Repository and revision
links above let future implementation agents recheck the exact evidence before use.
