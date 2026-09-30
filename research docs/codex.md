# Codex CLI — source architecture and schema map

> INTERNAL RESEARCH — source snapshot: OpenAI Codex main at **67a709665ac7b50311b93e32612c9a8281684787**, dated 2026-09-27. This is a moving development branch snapshot, not a claim about every released binary. Source was inspected by subsystem and schema families; this is not a line-by-line reproduction of vendored/generated assets.

Targeted Goal/ThreadManager follow-up (2026-09-28) was inspected at Codex commit
`368e5eae2f006a70a91dddfdc96e6b2d11498f81`; the immutable file links are
[ThreadManager](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/core/src/thread_manager.rs),
[Goal store](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/state/src/runtime/goals.rs),
and [ThreadGoal schema](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/app-server-protocol/src/protocol/v2/thread.rs).
This confirms the local message-board subsystem exists, but this targeted pass did
not trace all of its transport implementations; claims about remote subscriptions or
SSE need a direct source review before being treated as established. The broad
architecture map below remains pinned to `67a709665ac7b50311b93e32612c9a8281684787`;
the app-server-client README follow-up is separately pinned to
`41ed72c32b4980cd7919e1c2a45ecb1f96c5911a`. Do not combine claims across these
source snapshots without retaining the associated pin.

### App-server client follow-up (2026-09-28)

At current Codex `main` commit
[`41ed72c32b4980cd7919e1c2a45ecb1f96c5911a`](https://github.com/openai/codex/commit/41ed72c32b4980cd7919e1c2a45ecb1f96c5911a),
[`codex-rs/app-server-client/README.md`](https://github.com/openai/codex/blob/41ed72c32b4980cd7919e1c2a45ecb1f96c5911a/codex-rs/app-server-client/README.md)
documents a shared in-process app-server client for `codex-exec` and `codex-tui`.
It centralizes bootstrap/initialize and lifecycle behavior, uses typed request and
event channels in process, and preserves JSON-RPC result semantics. The same README
reports bounded command/runtime queues but an unbounded local consumer event queue to
avoid blocking responses. That is a deliberate Codex tradeoff, not a safe HorizonCode
default: HorizonCode's `REQ-HORIZON-013` requires bounded event memory and explicit
gap/resnapshot behavior.

This supports a transport-neutral typed control service plus an optional local
app-server boundary. It does **not** justify making the server own run/session truth,
or adopting Codex's queue policy. The main architecture map remains a pinned,
subsystem-level survey, not a literal line-by-line copy or an assertion that every
Codex source file was read.

### Pinned app-server and agent-message-board follow-up (2026-09-28)

This follow-up was checked against Codex commit
[`368e5eae2f006a70a91dddfdc96e6b2d11498f81`](https://github.com/openai/codex/commit/368e5eae2f006a70a91dddfdc96e6b2d11498f81).
It supersedes earlier mutable-branch links for these two topics only; the subsystem
survey below remains pinned to its separately stated `67a709...` snapshot. These are
source observations, not claims about every released Codex build.

#### Verified Codex source facts

- The [app-server-client README at this pin](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/app-server-client/README.md)
  documents a shared in-process client used by `codex-exec` and `codex-tui`. It
  centralizes bootstrap/initialization and lifecycle wiring; uses typed request and
  event channels in-process; and retains JSON-RPC response semantics. The README
  explicitly documents bounded command/runtime queues **and an unbounded local
  consumer event queue** so the runtime keeps draining while a caller awaits a
  response. It also documents bounded graceful shutdown followed by abort on timeout.
  The unbounded queue is a Codex-specific backpressure trade-off, not a HorizonCode
  requirement or recommendation.
- Codex defines an [agent-message-board API](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/agent-message-board/src/api.rs)
  and shared [message and paging types](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/agent-message-board/src/types.rs).
  The API contract scopes a board to an agent tree (`SessionId`), takes a caller
  runtime `ThreadId` and requires caller-membership validation, and uses `AgentPath`
  for authors and subscription targets. Runtime thread IDs and message-discussion
  root IDs are distinct. The API includes channels, post/reply, search, paged reads,
  and channel or discussion subscriptions. Its contract says a successful mutation acknowledges
  acceptance, not that a recipient read the post; the board validates membership,
  owns recipient selection, and must not wake a finalized agent or leave a notice for
  a later turn.
- The [local SQLite implementation](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/agent-message-board/src/local.rs)
  stores boards, channels, posts, subscriptions, and opt-outs in a separate SQLite
  database. It uses board-scoped uniqueness for message IDs and request IDs and
  indexes channel, thread-root, and timestamp reads. It caps post text at 64 KiB,
  channel names at 128 bytes, explicit recipients at 256, page size at 50 ([paging
  implementation](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/agent-message-board/src/local/paging.rs)),
  and a single post read at 20,000 Unicode characters. A post retry with the same
  caller-scoped request ID and identical request returns the stored post metadata;
  reuse with different request data errors. These are observed Codex limits, not
  HorizonCode defaults.
- In the local implementation, post content commits before best-effort notification
  fan-out. Delivery errors are logged without invalidating the durable post; fan-out
  is concurrency-limited. The [remote-client README](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/agent-message-board-client/README.md)
  describes live SSE previews bound to the receiving turn. Reconnect creates a new
  live receiver; durable posts are recovered through search and an `after_message_id`
  cursor. The host must validate the receiving turn before admission and must never
  wake a finalized agent. The [tool schemas](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/agent-message-board/src/tools/spec.rs)
  expose channel/list/search/read/post/subscription operations; direct notifications
  are distinct from subscriptions and do not start idle agents.
- The [remote adapter protocol](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/agent-message-board-client/src/protocol.rs)
  and [HTTP client](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/agent-message-board-client/src/client.rs)
  implement the client side only. Its README explicitly says the crate contains no
  server. The [remote adapter tests](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/agent-message-board-client/tests/remote_board.rs)
  use a mocked HTTP service (`wiremock`); they test client behavior, not a deployed
  service's correctness or interoperability.
- The [ThreadManager source at this pin](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/core/src/thread_manager.rs)
  wires local thread-data cleanup to `LocalAgentMessageBoard::delete_boards`. The
  [board lifecycle implementation](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/agent-message-board/src/local/lifecycle.rs)
  specifies permanent root-board deletion, with a tombstone to prevent delayed writes
  from recreating it; unload/archive must not call that operation. This is lifecycle
  cleanup, not evidence that an active board is automatically recoverable after every
  crash or that the remote service implements the same deletion semantics.

#### HorizonCode synthesis — proposed, not implemented or verified

Codex's board is useful evidence that agent collaboration needs durable messages,
membership-scoped reads, bounded pages, idempotent writes, and an explicit distinction
between persisted content and best-effort notification. HorizonCode can adapt those
properties to its existing Run/Task/Attempt/session hierarchy without equating a
message discussion with either the Task DAG or the parent/child worker tree.

If adopted, make one Run-scoped mailbox a projection over HorizonCode's canonical
Run event stream, with a recoverable delivery outbox into the existing session input
inbox. Do not introduce an independent message database or second owner of task state.
Persist an accepted message before attempting delivery; use stable delivery IDs so
restart and retry do not duplicate admitted input; report accepted, admitted,
promoted, acknowledged, and undeliverable as different states. An explicit ack can
prove only that a worker invoked the ack operation, not that it understood or obeyed
the message. Keep message content untrusted: it cannot change approved requirements,
permissions, budget, task state, or verification evidence. Only deliver at a safe
provider-turn boundary, never wake an idle, paused, terminal, or finalized worker by
default, and account for recipient context/usage before promotion. External ACP or
opaque-CLI agents get messaging only when an adapter explicitly negotiates and
implements it; do not infer this capability from session support.

Keep HorizonCode's bounded request/event lanes and gap/resnapshot contract. Codex's
unbounded local event-consumer queue is a concrete counterexample to copying a
reference design wholesale. The exact Codex server-side HTTP authorization, durable
notification fan-out, and production recovery behavior remain unknown from this
public snapshot because the server is outside the inspected repository. Treat the
remote-client protocol as a reference contract only until an actual service is
independently inspected or exercised.

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
store](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/state/src/runtime/goals.rs),
[goal tool schema](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/ext/goal/src/spec.rs),
[goal status UI](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/tui/src/chatwidget/goal_status.rs).

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

## 2026-09-29 source-inventory and subsystem follow-up

The pinned commit `67a709665ac7b50311b93e32612c9a8281684787` contains 8,683 tracked
paths, 153 Rust workspace members, 4,924 Rust files, 758 TypeScript files, 1,433
snapshots, and 2,065 Rust files matching common test-attribute patterns (a file count,
not a test count). The follow-up inspected representative execution, schema,
persistence, and failure paths across ThreadManager, Goals, agent admission and graph,
app-server, providers, tool discovery, MCP, context/compaction, plugins/skills, and
platform sandbox/network code. It inventoried but did not line-read 51 vendored files,
1,050 generated protocol-schema files, or 1,433 snapshots; it did not read all 8,683
paths or run Codex tests.

Additional implementation details that affect HorizonCode design:

- Codex atomically reserves child-spawn slots, but `check_turn_admission` and
  `admit_turn` are separate, advisory checks; concurrent turn admission is not an
  atomic budget reservation. Keep HorizonCode's single atomic nested reservation
  authority rather than treating Codex's two controls as equivalent.
- Tool discovery uses cached English BM25 over deferred tool specs and materializes
  matched schemas for a subsequent model call. It is model-tool discovery, not semantic
  repository symbol search. MCP tools enter the shared typed executor and run in
  parallel only when read-only/parallel-safe annotations allow it. MCP startup
  distinguishes timeout and reauthentication failures and returns operator guidance.
- Compaction has distinct pre-turn/manual and mid-turn context-injection modes; it
  retries transient errors with bounded backoff, trims on context overflow, stops on
  interruption/budget exhaustion, replaces history with a checkpoint, and recomputes
  usage. Repeated compaction may reduce accuracy. Local compaction inference traces are
  disabled pending a first-class lifecycle, a useful observability gap to retain in
  HorizonCode's test plan.
- Sandbox selection can return `None` when a platform backend is absent. Managed
  networking also has backend-specific requirements, including elevated Windows paths
  and Linux/WSL1 restrictions. HorizonCode must report the actual tier/backend and
  refuse required confinement that cannot be established; it must not claim uniform
  managed-egress coverage from the policy setting alone.

Pinned evidence: [agent admission API](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent/api.rs),
[tool search handler](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/tools/handlers/tool_search.rs),
[MCP executor](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/tools/handlers/mcp.rs),
[compaction](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/compact.rs),
and [sandbox selection](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/sandboxing/src/manager.rs).

## Source index

- [Core agent controller](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent)
- [Agent graph store](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/agent-graph-store/src)
- [Thread, turn, and item contracts](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2)
- [Generated app-server schemas](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/schema)
- [Rollout storage and readers](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout/src)
- [Execution and sandbox crates](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs)
- [Codex long-horizon experiment](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex)
- [Codex ExecPlans cookbook](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md)
- [Codex goal source at `368e5eae`](https://github.com/openai/codex/blob/368e5eae2f006a70a91dddfdc96e6b2d11498f81/codex-rs/state/src/runtime/goals.rs)

## 2026-09-29 additional source verification and coverage limit

A separate read-only pass inspected the local Codex checkout at
[`13a966fc652d1037c7ee93a15b2bdfa0610748ae`](https://github.com/openai/codex/commit/13a966fc652d1037c7ee93a15b2bdfa0610748ae),
which is a shallow September 22 snapshot and is **not** the same source revision as
the September 27 broad pin above. Nine complete files were read (786 lines): the
ThreadGoal model and both migrations, the Goal continuation template, app-server-client
and daemon READMEs, agent-graph types, and agent-message-board API/types. Several large
runtime/protocol/store files received bounded partial reads; provider/tool/MCP code,
most UI/settings, sandbox internals, memory internals, compaction, and most of the
agent/thread runtime remain unread. Inventory at the local checkout: 8,437 tracked
paths, of which the declared source-like extension filter matched 6,291 files and
approximately 346,250 lines. This is not an exhaustive Codex codebase read.

The focused Goal processor review found that the SQLite GoalService update commits
before the rollout event append is attempted; rollout append failure is warned, but
the response and notification still proceed. This is a split-store consistency risk
in this Codex path, not a pattern for HorizonCode to copy. HorizonCode's cross-stream
contract remains stricter: disagreement is an incident requiring reconciliation, and
neither projection write nor event append alone implies activation or task completion.
Evidence: local checkout `codex-rs/app-server/src/request_processors/thread_goal_processor.rs:174-244`
(partial file read); Goal state model `codex-rs/state/src/model/thread_goal.rs:60-71`
(full file read).

The full-file coverage and partial-path list are recorded in the 2026-09-29 source
audit handoff. Do not treat the local checkout as evidence for behavior at the separate
`67a709...`, `368e5eae`, or `41ed72c` source pins.

## 2026-09-29 targeted corrections from the HorizonCode audit

The following claims were checked directly against the local source snapshot
`67a709665ac7b50311b93e32612c9a8281684787`; this is targeted path evidence, not a
new whole-repository review.

- **Initialize/capabilities:** [`v1.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v1.rs)
  has client-declared initialize capabilities, including experimental API opt-in.
  The server's [`InitializeResponse`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server/src/request_processors/initialize_processor.rs)
  carries user-agent, Codex home, platform family, and OS; it does not return a
  negotiated wire major/minor or a server capability set. Therefore “Codex has no
  capability negotiation” is too broad; the precise gap is no returned server-method
  capability/version negotiation in this initialize response.
- **Dispatch:** [`common.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/common.rs)
  uses a macro to declare the typed request enum, and the server dispatches that typed
  request surface. This is an exhaustive typed-dispatch pattern worth reviewing for
  HorizonCode. The earlier audit's 298/651 response-schema reachability count is not a
  dead-method count and is not carried as a defect claim. HorizonCode should still
  generate/check that every declared method has an owner handler at build time.
- **Approval callbacks:** [`outgoing_message.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server/src/outgoing_message.rs)
  stores pending callbacks in a process-wide map keyed by request ID (line 134).
  `connection_closed` clears connection-scoped request contexts (275–280), while
  callback ownership checks apply only to entries marked as verification-owned
  (561–579). This demonstrates a protocol-level connection-binding risk for ordinary
  callbacks; exploitability depends on request routing and the broader host. It is
  sufficient evidence for HorizonCode to require authenticated principal and exact
  connection binding, disconnect invalidation, TTL, and a displayed-resource digest.
- **Guardian revalidation:** [`review_request.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/guardian/review_request.rs)
  captures root `(thread_id, history_reset_version)`, root authorization version, and
  the user-message revision, then re-reads these after an `Allow` and returns
  `Cancelled` or `StaleAuthorization` on change. [`decision.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/guardian/decision.rs)
  checks cancellation after extension callbacks. A separate process-global field named
  `guardian_review_context_revision` was not found in this snapshot; HorizonCode's
  reference is the verified re-read pattern, not that unverified field claim.
- **Budget and retries:** [`rollout_budget.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/rollout_budget.rs)
  uses an in-memory mutex-backed weighted counter and increments it when usage is
  recorded. The [`responses_retry.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/responses_retry.rs)
  branch for `UnboundedConnectionRetries` uses capped exponential delay but no attempt
  ceiling. HorizonCode forbids any unbounded retry escape hatch and reserves before
  dispatch (`ARCH/08`, `ARCH/25`, `REQ-SEC-013`, `REQ-HORIZON-003`).
- **Recovery:** [`daemon_recovery.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/session/daemon_recovery.rs)
  captures an eligible interrupted local turn and explicitly excludes non-local
  environment identities from restart recovery. This is a resume-input snapshot, not
  general dispatch/effect reconciliation. `thread_manager.rs` rejects a new thread if
  the initial `SessionConfigured` event is not first and uses `Entry::Vacant` to avoid
  duplicate thread insertion. These are scoped lifecycle patterns, not evidence of
  durable external-worker recovery.
- **History and compaction:** `context_manager/history.rs` advances an in-memory
  history generation on replacement; `thread_manager.rs` warns that a fork snapshot
  during a live turn may contain only items persisted so far. This supports a
  HorizonCode model-facing reader over committed visible Thread history, but does not
  prove canonical rollout deletion. Avoid saying Codex irreversibly loses all
  pre-compaction history unless a canonical-store path is separately shown.
- **Local versus remote transport:** Codex's local app-server JSON-RPC surface and
  cloud remote-control relay are distinct. The [remote-control WebSocket transport](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-transport/src/transport/remote_control/websocket.rs)
  has sequence/cursor and acknowledgement/unacked-buffer behavior. This is a useful
  reconnect pattern for its relay, not proof that local app-server JSON-RPC has the
  same cursor or that relay retention is durable across server restart. HorizonCode's
  local server-side cursor/replay and explicit resnapshot contract remains its own
  design choice (`ARCH/31`).
- **Partial stream usage:** the sampling client path handles token usage on
  `ResponseEvent::Completed`; the error path calls `record_failed` with emitted items
  but no usage argument (`core/src/client.rs:2424–2487`). This verifies a path-level
  observability gap. It does not by itself prove the provider charged zero or that
  every Codex accounting layer lost the usage; HorizonCode's acceptance fixture tests
  its own accounting rule independently (`ARCH/11`, `ARCH/23` `ACC-P1-10`).

## 2026-09-29 managed-egress, retry, migration, and accounting corrections

The following additional claims were checked against the broad Codex source pin
`67a709665ac7b50311b93e32612c9a8281684787`. They correct the scope of earlier
comparisons; they do not certify every Codex networking call site or deployed build.

- **Managed egress exists and is substantial.** Each [`NetworkPolicyController`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/http-client/src/network_policy.rs)
  instance owns publication; transport-facing `NetworkPolicy` exposes narrowing and
  invalidation operations, not policy publication. The app has distinct local and
  effective policy controllers for bootstrap and live application policy
  ([`application_network.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server/src/application_network.rs),
  [`in_process_bootstrap.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server/src/in_process_bootstrap.rs)).
  `RouteAwareClientPool` selects a
  route and, on managed traffic, follows redirects manually. Its [`execution.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/http-client/src/route_aware_client_pool/execution.rs)
  acquires a permit for each hop, strips sensitive headers when the proxy route changes,
  and returns a response retaining the permit. [`response.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/http-client/src/response.rs)
  keeps that permit active while response bodies/streams are consumed, allowing policy
  revocation to cancel an in-flight operation. Unsupported SDK transports fail under
  endpoint restrictions. The app's requirements-to-policy mapping turns an absent or
  disabled network section into `Unrestricted`; that is an explicit policy semantics,
  not evidence the mechanism always restricts egress. This corrects the earlier claim that Codex had no central
  managed-egress mechanism. The limit is equally important: `NetworkPolicy::unmanaged`,
  direct client construction, legacy compatibility factories, and platform/route-specific
  code exist. The inspected `DestinationPolicy` authorizes normalized URL hosts; this
  path alone does not prove DNS resolution is pinned to a validated IP through connect.
  Cite Codex as a strong managed-egress mechanism, not proof that every outbound path is
  mediated or that it meets HorizonCode's declared level/mechanism/residual contract.
  Some listed escape hatches need more context before being called independent product
  fail-opens: `build_direct` is documented for exceptional use such as tests, localhost
  callbacks, or sandbox traffic with separate egress handling; the two custom-CA fallback
  builders are deprecated and explicitly legacy; and `BwrapOptions::default()` sets
  `FullAccess`, but the normal Linux launch path explicitly computes `network_mode` from
  sandbox policy and managed proxy requirements before invoking bubblewrap. The `ProxyOnly`
  mode is documented as an intended mode whose bridge is established by the helper;
  its stated semantics require integration acceptance. `landlock` being public despite
  a legacy/backup module comment is an API-surface concern, not by itself a bypass.
- **Retry details must not be merged across retry owners.** The generic
  [`codex-client` retry helper](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/codex-client/src/retry.rs)
  has independent 429/5xx/transport switches, uses `0..=max_attempts`, and computes
  exponential jittered backoff without a maximum delay. It does not accept an
  idempotency-key/effect argument or inspect the HTTP method before retrying; callers
  can recreate requests through `make_req`. However, this helper returns the last
  concrete transport error when the bounded attempt limit is reached. The audit claim
  that it always discards that error and replaces it with a synthetic 500 is false for
  this helper; `TransportError::RetryLimit` maps to a synthetic status only when that
  variant is independently produced. Separately, core's feature-gated
  [`responses_retry.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/responses_retry.rs)
  has a `ConnectionFailed` sampling path with capped delay (5–60 seconds) but no
  attempt ceiling. Keep these peer cases distinct. HorizonCode retains a finite attempt
  count, bounded multiplier and absolute delay, preservation of the last real error,
  and no replay of an effectful request without its stable idempotency key.
- **Missing usage fields are normalized to zero in some projections.** The
  [`Responses` usage conversion](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/codex-api/src/sse/responses.rs)
  defaults absent cache-detail structures and absent reasoning-token detail to zero.
  The sampling client's failed/cancelled trace calls receive emitted items but no
  `token_usage` argument (`core/src/client.rs:2416–2487`). These are verified
  accounting/observability behaviors at those paths. They do not prove the provider
  charged zero, or that all Codex billing views lose partial usage. HorizonCode's
  `UNKNOWN`/estimated state and exactly-once accounting requirement remain appropriate.
- **External-agent migration is user-selected, but not a content-level trust review.**
  The [`/import` TUI flow](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/tui/src/external_agent_config_migration/flow.rs)
  detects candidate sources, asks the user to select an app when multiple sources are
  found, presents a summary/customization picker, and calls import only after the user
  chooses “Import selected.” Therefore “zero trust prompt” / wholly unprompted transfer
  is false for this CLI flow. The picker selects migration categories/items and shows
  summaries; it is not evidence of line-by-line review or sandboxing of imported hooks,
  skills, agents, configuration, or plugin definitions. The app-server import endpoint
  itself accepts selected items from a client; any API path that bypasses the TUI
  selection flow needs separate review. `migration_source.rs` maps every value other
  than Cursor's recognized identifier to Claude; that is a source-selection robustness
  issue, not proof that the TUI silently imports without a user action.
- **Bundled skills are build-time assets, not installed from GitHub by this code path.**
  [`skills/src/lib.rs`](https://github.com/openai/codex/blob/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/skills/src/lib.rs)
  uses `include_dir!` to materialize embedded `.system` assets. The skill config
  defaults bundled skills to enabled and treats parse failure as enabled. Skill metadata
  defaults `allow_implicit_invocation` to true, and the product-gating function is
  defined with a source TODO comment. However, broader source search found actual
  product-restriction enforcement in environment-skill loading, host-skill merging,
  plugin skill display/selection, and external-agent marketplace import
  (`ext/skills/src/loader/environment.rs`, `host_merge.rs`,
  `app-server/src/request_processors/plugins.rs`, and
  `external-agent-migration/src/service.rs`). Therefore the audit's claim that product
  gating is simply unenforced is too broad; the TODO indicates a remaining/possibly
  separate injection concern that requires tracing the precise bundled-skill path.
  HorizonCode should test the full discover→select→inject path. This supports testing
  HorizonCode's default-deny and pinned activation, but not the audit's claim of a
  default GitHub download.
- **Credential and provider-classification details:** the auth manager reads
  `CODEX_REFRESH_TOKEN_URL_OVERRIDE` and `CODEX_APP_SERVER_LOGIN_CLIENT_ID`; the
  `CODEX_REVOKE_TOKEN_URL_OVERRIDE` is read by `login/src/auth/revoke.rs` (not by the
  manager module itself). These environment variables can redirect token operations or
  replace the OAuth client ID when deliberately set in the process environment; that is
  a real endpoint/configuration trust surface, although the source alone does not prove
  an untrusted party can set the environment in a deployed process. The resulting
  request remains subject to whichever network route/policy owns that call site; the
  environment read alone does not prove an egress bypass. Separately, `AutoAuthStorage`
  falls back to file storage when keyring load/save returns an error; this is the
  semantics of the named `Auto` mode, not evidence that every credential-storage mode
  silently downgrades. Separately,
  `codex-api/src/provider.rs::matches_azure_responses_base_url` uses substring matching
  to classify a provider as Azure. It is a provider-capability classification helper,
  not the authorization function for outbound origins. HorizonCode must still parse and
  compare URL hosts at security boundaries and must not reuse provider-name heuristics
  as origin authorization.
- **Backpressure evidence is local and mixed.** The session mailbox is an
  unbounded `Mutex<VecDeque<_>>`; `schedule_mcp_prewarm` ignores `try_send` failure;
  the Responses SSE event channel is bounded at 1,600 while the WebSocket inbound event
  channel is unbounded and its outbound command channel is bounded at 32. The provider
  builder sets no whole-request timeout by default, while the stream path has a separate
  idle timeout. These observations justify explicit capacity, overflow observability,
  total deadlines, and cancellation tests in HorizonCode; they do not mean every Codex
  queue or transport is unbounded.
