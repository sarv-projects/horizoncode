# Codex CLI — source architecture and schema map

> INTERNAL RESEARCH — source snapshot: OpenAI Codex main at **67a709665ac7b50311b93e32612c9a8281684787**, dated 2026-09-27. This is a moving development branch snapshot, not a claim about every released binary. Source was inspected by subsystem and schema families; this is not a line-by-line reproduction of vendored/generated assets.

## Scope and HLD

Codex CLI is a Rust workspace with a user-facing CLI/TUI, an app-server protocol for editor/desktop clients, a reusable agent core, tools/policies/sandboxing, and durable local thread rollouts. The source has many separately maintained crates. The app-server protocol has generated Rust/TypeScript/JSON schemas, with stable and experimental surfaces.

    CLI / TUI / exec / app-server / daemon
                         │
        app-server protocol and client transport
                         │
        thread and turn control in codex-core
          │             │              │
       model API      tools         approvals
          │             │              │
          └──── sandbox / MCP / skills ┘
                         │
         rollout JSONL + SQLite state/indexes
                         │
      worktrees, attachments, memories, config

Core subsystem ownership is distributed across crates; there is no single “Codex class” containing the whole product.

## Source layout and ownership

| Subsystem | Important source paths | Role |
|---|---|---|
| CLI and launch | codex-rs/cli, codex-rs/exec, codex-rs/tui | Command parsing, interactive TUI, non-interactive execution, review workflows. |
| Agent runtime | codex-rs/core | Turn lifecycle, context assembly, model requests, tool execution, approvals, interruption, compaction and agent control. |
| Protocol contracts | codex-rs/protocol, codex-rs/app-server-protocol | Core messages/events plus app-server v1/v2 requests, responses, notifications and generated schemas. |
| Client/server transport | codex-rs/app-server, app-server-client, app-server-transport, app-server-daemon | Request processing, subscriptions, streaming events and daemon operation. |
| Session persistence | codex-rs/rollout, codex-rs/state, codex-rs/thread-store | Append-oriented rollout JSONL, metadata/indexes, SQLite state and thread projection. |
| Multi-agent | codex-rs/core/src/agent, codex-rs/agent-graph-store, codex-rs/agent-roles | Spawn/resume/message/interrupt/completion control, persisted parent-child topology, roles and limits. |
| Tool and extension surface | codex-rs/core/src/tools, codex-rs/codex-mcp, codex-rs/ext | Built-ins, MCP, plugins/extensions, skills, hooks, web search, memories, queues and other features. |
| Execution security | codex-rs/execpolicy, codex-rs/sandboxing, linux-sandbox, windows-sandbox-rs, codex-rs/bwrap | Approval and policy types, OS sandbox profiles, command execution and platform-specific enforcement. |
| Providers and context | codex-rs/codex-api, ollama, lmstudio, model/provider config, codex-rs/context-fragments | Model API and local provider integration, context fragments and request configuration. |
| Cloud tasks and backend | codex-rs/cloud-tasks, cloud-tasks-client, backend-client | Remote task/backend integration distinct from local interactive sessions. |

Pinned source entry points: [workspace](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs), [core](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core), [app-server protocol](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol), [rollout persistence](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout).

## Public schema families

| Schema | Fields and semantics | Definition/source |
|---|---|---|
| Thread | UUIDv7 ID; shared session tree ID; fork/parent thread IDs; preview; ephemeral/history mode; project/cwd/source; model/provider/reasoning; timestamps/status; Git info; optional agent nickname/role; optional turns. Some fields are experimental or absent when unloaded. | [v2 thread data](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs) |
| Turn | ID, current item list and item completeness view, status (in progress/completed/interrupted/failed), error, start/end/duration. | [v2 turn](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs), [turn requests](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2/turn.rs) |
| ThreadItem | User/assistant text, reasoning summaries, tool calls/results, file changes, plans, approvals, agent activity, and other typed item families. Not every rollout item is exposed in every app-server response. | [v2 thread items](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2) |
| App-server RPC | Initialize/capability negotiation; thread start/resume/fork/read/list; turn start/steer/interrupt; notifications for turn/item/tool/approval updates; generated stable and experimental schema sets. | [v2 protocol source](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2), [generated schemas](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/schema) |
| RolloutLine | Timestamp, optional ordinal, typed rollout item; line decoder supports versioned item families and persists/resumes history. | [rollout decoder](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout/src/lib.rs) |
| SessionMeta | Thread/session ID, source/originator/version/provider/model context, cwd, Git metadata, history/fork information and execution-policy snapshot among other fields. | [rollout metadata](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout/src/metadata.rs), [protocol types](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/protocol/src/protocol.rs) |
| Agent lifecycle | AgentMetadata includes optional thread ID, role, nickname, agent path. Status includes PendingInit, Running, Interrupted, Completed, Errored, Shutdown, NotFound. Spawn options include parent thread/turn, fork full history or last N turns, root turn, selected execution environments and usage hints. | [agent types](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent/types.rs), [status](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/protocol/src/protocol.rs) |
| Spawn graph edge | Directional parent-thread/child-thread edge with Open or Closed status; a child has one persisted parent; store supports ordered direct children and breadth-first descendants. | [graph store contract](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/agent-graph-store/src) |
| Thread goal | Thread ID, objective, status (active, paused, blocked, usage-limited, budget-limited, complete), optional token budget, token/time used, timestamps. It is a thread-level goal, not a general task DAG or full acceptance-spec schema. | [goal types](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/protocol/src/protocol.rs), [v2 thread methods](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2/thread.rs) |
| Budget | Rollout/session usage accounting and budget reminders; multi-agent control can share/reserve execution capacity. | [agent budget controller](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent/control/budget.rs), [rollout budget](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/rollout_budget.rs) |

The app-server protocol generates JSON schemas and TypeScript definitions from Rust types. Experimental methods/fields are explicitly gated; consumers need version negotiation and tolerant handling of optional fields, not an assumption that every method is stable.

## Session persistence and recovery

1. A thread starts with source, model/provider, working directory, policy/sandbox, history mode and optional parent/fork metadata.
2. The agent core creates the rollout and appends typed records as turn/model/tool events occur.
3. App-server clients receive request responses and streamed notifications; they may subscribe/read complete or summarized thread data.
4. On resume, rollout readers reconstruct prior messages and context; state DB indexes provide listing/metadata rather than replacing the history artifact.
5. Revert, compaction, rollout compression and history-mode behavior have explicit subsystem code; a session ID alone does not guarantee every response includes every historical item.

The local rollout file is JSONL and supports scanning, seekable reads, reverse lookup, compaction and rebuildable indexing. Related metadata/state is stored in SQLite. Codex therefore has both an append-oriented history stream and a state/index database; they serve different purposes.

## Agent and tool flow

1. The user starts a turn through CLI/TUI, exec mode, or app-server.
2. Core assembles instructions, user input, previous history, tools, model settings, sandbox and approval policy.
3. The model returns text and/or tool calls. Core validates tool identity/arguments, checks policy and sandbox, executes tools, and appends tool result items.
4. Core streams item and turn events. The user may steer or interrupt where supported.
5. The model continues until a terminal turn state; usage and rollout records are updated.

Tool contracts include typed names/arguments/results and metadata. MCP and extension-provided tools are adapted into the shared tool execution path. Approval policy is not the same as sandbox enforcement; those concerns live in separate subsystems.

## Multi-agent flow and tracking

Codex has native child-thread control, beyond starting multiple shell processes:

1. Parent turn calls the multi-agent spawn tool with bounded role/task/context and optional history fork mode.
2. AgentControl reserves execution capacity, creates/loads a child thread, records parent/turn/root linkage and returns an agent identity.
3. Parent can inspect status, send input, resume, interrupt, close, or collect results through control APIs/tools.
4. Child activity and completion are delivered to the parent; child thread has its own rollout/history.
5. SQLite-backed AgentGraphStore persists directional thread-spawn edges and exposes descendants. This graph is topology, not a general dependency task graph with acceptance criteria.

For an HorizonCode adapter, capture the child thread ID, parent ID, role/nickname, status, event stream, workspace/base commit, permissions, start/end, token/cost provenance, and final result. Codex app-server schemas may flag multi-agent methods as experimental; record negotiated API version/capabilities and retain HorizonCode-owned state outside Codex. A peer tracks direct children only as far as its event/API surface allows.

## Code understanding, tests, review, and PRs

- Code understanding uses file/search/shell tools, context and instructions, optional repository map/index features, and provider tool calls.
- Testing/debugging is a feedback loop: run commands, inspect failures, edit, rerun. A completed turn is not equivalent to passing acceptance.
- Review-oriented workflow is exposed through a dedicated review command/mode and review result types. The reviewer can inspect a branch/diff, but this remains model-produced evidence unless corroborated.
- Git status/diff and worktree support help isolate and review changes. App-server includes Git metadata and file-change item families.
- PR creation, review comments, and merge are external effects handled through integrations/tools and their own permissions; they are not the same as thread completion.

## Long-horizon work: durable plan plus incremental evidence

OpenAI's Feb. 23, 2026 long-horizon report describes an approximately 25-hour experiment
with GPT-5.3-Codex. The reported setup used a detailed spec, a plan and status files,
reviewable milestones, and tests/lint/typecheck after each milestone. The report also
highlights skills for repeatable procedures, automations for recurring work, and Git
worktrees to isolate parallel runs. This is a reported experiment, not a guarantee that
Codex or a Markdown plan will remain coherent for 25 hours on arbitrary tasks.

The [Codex ExecPlan convention](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md)
is particularly useful as an execution handoff. Each plan is meant to stand alone for a
new agent with only the current checkout and the plan. It records purpose, exact files,
commands and expected outputs, observable milestones, progress, surprises, decisions,
and retrospective outcomes; it is revised as work changes. The cookbook explicitly
describes it as a living design/execution document. That reduces the cost of context
loss and makes the plan reviewable before implementation.

Codex also has a persisted **thread goal** record and goal UI. The current Rust contract
stores an objective, status, optional token budget, tokens used, time used, and
timestamps; its statuses include active, paused, blocked, usage-limited, budget-limited,
and complete. This is valuable user-visible goal/accounting state, but it is not a
task DAG, approved requirements bundle, per-task budget ledger, or evidence-bound
acceptance schema. Keep those concepts separate in HorizonCode. Source: [goal state
store](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/goals.rs),
[goal tool schema](https://github.com/openai/codex/blob/main/codex-rs/ext/goal/src/spec.rs),
[goal status UI](https://github.com/openai/codex/blob/main/codex-rs/tui/src/chatwidget/goal_status.rs).

The official [Codex Goals guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex),
checked 2026-09-27, documents `/goal`, `/goal pause`, `/goal resume`, and `/goal clear`
for Codex builds from 0.128.0. It describes persisted thread-scoped objectives,
continuation only at an idle boundary with no queued input or pending work, no
continuation for plan-only work, suppression after a no-tool-call continuation, and
budget-limited stopping. Treat this as the published workflow contract; it is not a
promise that every backend reports exact usage or that the Goal replaces a task DAG
and independent acceptance evidence.

### Failure reports to convert into tests

The following are public user reports, not proof of a general defect in all current
Codex versions. They are still useful adversarial scenarios for a long-running
controller:

| Report | Reported failure | HorizonCode control |
|---|---|---|
| [#40929](https://github.com/openai/codex/issues/40929) | A resumed goal reportedly kept obeying an older chat-level pause and immediately auto-continued through seven no-progress turns, consuming reported tokens before manual pause. | Resume is a durable, explicit control event; it invalidates older pause intent only for the named run/action. Before each continuation, a deterministic controller checks a persisted progress signature and pauses on repeated no-progress. |
| [#28923](https://github.com/openai/codex/issues/28923) | A goal reportedly spun over 100 automatic turns while waiting for a future time rather than yielding to a timer/automation. | Persist a wait condition, release execution capacity, make no model call while idle, and issue one idempotent wake event when due. Polling is separate permissioned work. |
| [#37800](https://github.com/openai/codex/issues/37800) | A long-running goal reportedly emitted repeated “continuing” text without edits or progress while consuming time/tokens. | Model prose, heartbeat, repeated reads, compaction, and tool-call volume do not count as progress. Persist no-progress and retry counters across model/session restarts. |
| [#37869](https://github.com/openai/codex/issues/37869) | A report describes automatic continuations despite a displayed paused goal state. | Pause writes a dispatch fence before acknowledging; status and scheduler share one transactionally maintained source of truth. No continuation after pause until explicit user resume. |

These cases expose two implementation boundaries: (1) the goal UI/prompt must not be
the authority that controls the scheduler, and (2) a “wait” needs a timer/event
handoff rather than another inference turn. HorizonCode's proposed contracts are in
[`ARCH/25-LONG-HORIZON-CONTROL.md`](../ARCH/25-LONG-HORIZON-CONTROL.md), especially
`ProgressSignature`, `WaitCondition`, pause fences, resume events, tool-batch admission,
and persisted no-progress ceilings.

### HorizonCode disposition

Adopt Codex's self-contained milestone plan as a readable projection for the human and
for a fresh worker, alongside the existing structured event/task/evidence store. The
plan cannot grant permission, change accepted requirements, or declare task completion;
it must be reproducible from canonical state and carries source event/spec digests.
Use exact commands and expected results, but re-check the current checkout before
running them. Keep a small next-safe-action field, not a copy of the entire transcript.

Borrow worktree isolation and per-milestone verification. Keep task graph dependencies,
actual/external usage provenance, cancellation reconciliation, explicit user pause,
wait scheduling, and stop decisions in the HorizonCode controller. A new session or a
new model is not a fresh retry allowance. A strong evaluator can propose an assessment,
but it cannot override a hard budget, a user stop, missing evidence, or an external
effect's unknown outcome.

## Strengths, limitations, and HorizonCode lessons

**Patterns worth comparing:** schema-generated app-server contract; separate rollout history and SQLite index; capability-negotiated stable/experimental API; typed parent-child agent graph; lifecycle APIs for child status/input/resume/close; budget admission/reminders; OS-specific sandbox crates and approval taxonomy.

**Limits to preserve:** a persisted child edge says a child exists/is closed, not that its work passed. A thread-level goal does not replace validated requirements and acceptance criteria. Some APIs are experimental. Local telemetry and remote-backend usage may differ in fidelity. The model/tool loop still needs an independent verifier.

**HorizonCode lessons:** keep ExternalAttempt and task graph in HorizonCode even when delegating to Codex; pin app-server version/capabilities; map child thread IDs to an external attempt; record actual commit and test evidence; do not inherit broader permissions; verify changes on the integrated worktree.

**Long-run lesson:** steal the user-facing clarity and resumability of ExecPlans, not the
assumption that repeated model turns are inherently useful. Codex's Goal record is a
useful precedent for visible objective/status/budget fields; the scheduler still needs
deterministic pause/wait/stop/no-progress control that survives restart.

## Source index

- [Core agent controller](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent)
- [Agent graph store](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/agent-graph-store/src)
- [Thread, turn, and item contracts](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2)
- [Generated app-server schemas](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/schema)
- [Rollout storage and readers](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout/src)
- [Execution and sandbox crates](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs)
- [Codex long-horizon experiment](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)
- [Codex ExecPlans cookbook](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md)
- [Codex goal source](https://github.com/openai/codex/blob/main/codex-rs/state/src/runtime/goals.rs)
