# DeepCode (HKUDS): durable coding sessions and automation

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `807ff34a077f3218a1eb8cc95481da40cc8f781e`. Focused source audit of app-server, domain/persistence boundaries, goal continuation and automation execution.

## HLD

DeepCode evolved from a research/code-generation system into a general coding-agent application. A Python application core exposes CLI/TUI and desktop clients through an app-server JSON-RPC boundary. Domain/application layers isolate goal, session, workflow and automation behavior from presentation, persistence and provider implementations. The app server is the long-lived owner for desktop-driven automation; short-lived CLI composition does not implicitly start a scheduler.

## LLD and persistence model

| Record/system | Role |
|---|---|
| Canonical SessionStore JSONL | Source transcript/session identity, designed to survive and rebuild projections. |
| SQLite state DB | Indexed/runtime projection at `~/.deepcode/state/deepcode.sqlite3`; documented entities include projects, threads, turns, items, approvals, workflow runs, artifacts, event log, legacy imports and schema migrations. Uses WAL, foreign keys, busy timeout and short transactions. |
| Thread / Session | Shared identity: the thread ID maps to canonical session ID. |
| Goal / ThreadGoal | Durable outcome pursued across multiple turns, with status and outcome/evidence. |
| Automation definition/revision/occurrence/run | Separates mutable schedule configuration, immutable instruction revision, idempotent tick/request, and execution record. |
| Turn | Accepted unit of typed agent/workflow execution. |

SQLite is a rebuildable projection over canonical session records where described; the durable event log supports replay for desktop projections. Live queues are bounded, and clients can page older events. Goal state survives turn changes, process restarts and model switches. Automation revision pinning means an open run continues with the exact immutable instructions it started with.

## Execution and recovery flows

Interactive flow: client → application service → accepted typed turn → shared execution coordinator → agent or workflow handler → canonical turn/items/session → event projection. Automation flow: definition → immutable revision → idempotent occurrence → run → canonical goal in automation thread → ordinary turn → shared coordinator → goal outcome/evidence.

An execution coordinator enforces a global slot and fencing for thread/workspace ownership; OS leases indicate worker liveness and epochs prevent a stale worker from settling a successor. Durable approvals can be observed cross-process. On recovery, proven-dead claimed work is interrupted/reconciled rather than blindly replayed. Scheduler leadership is leased across processes; schedule policy defines anchored intervals, coalesced missed ticks, and skip behavior while a prior run remains open.

## Reliability and limits

- The documented repeat-call guard is advisory: it detects patterns and reminds the model; it is not a deterministic global circuit breaker.
- “Goal outcome and evidence” must be traced to the actual evaluator and evidence schema before treating completion as independent verification. The architecture material alone does not establish a separate intent evaluator.
- JSONL/SQLite dual persistence needs consistency checks, schema migration tests, replay idempotence and corruption recovery.
- Lease expiry and fencing are correctness-critical: stale workers must not commit after a new epoch takes ownership.
- Event replay and bounded queues need explicit cursor-gap behavior under slow clients.

## Relevance to HorizonCode

Strong reference for distinguishing goal from turn, schedule definition from immutable run revision, and canonical history from UI projection. Reuse the concepts, not assumptions: HorizonCode should bind PASSED to an independently produced verification record containing spec version and exact tested commit. Persist external side effects and reconcile before retry.

## Primary references

[App-server architecture](https://github.com/HKUDS/DeepCode/blob/main/docs/P1_APP_SERVER_ARCHITECTURE.md) · [Automation architecture](https://github.com/HKUDS/DeepCode/blob/main/docs/AUTOMATION_ARCHITECTURE.md) · [Thread goal domain](https://github.com/HKUDS/DeepCode/blob/main/core/domain/thread_goal.py) · [Goals and headless mode](https://github.com/HKUDS/DeepCode/blob/main/docs/guide/goals-and-headless.md) · [Persistence migrations](https://github.com/HKUDS/DeepCode/blob/main/core/persistence/migrations.py) · [Runner](https://github.com/HKUDS/DeepCode/blob/main/core/agent_runtime/runner.py)
