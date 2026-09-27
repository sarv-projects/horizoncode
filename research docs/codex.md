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

## Strengths, limitations, and HorizonCode lessons

**Patterns worth comparing:** schema-generated app-server contract; separate rollout history and SQLite index; capability-negotiated stable/experimental API; typed parent-child agent graph; lifecycle APIs for child status/input/resume/close; budget admission/reminders; OS-specific sandbox crates and approval taxonomy.

**Limits to preserve:** a persisted child edge says a child exists/is closed, not that its work passed. A thread-level goal does not replace validated requirements and acceptance criteria. Some APIs are experimental. Local telemetry and remote-backend usage may differ in fidelity. The model/tool loop still needs an independent verifier.

**HorizonCode lessons:** keep ExternalAttempt and task graph in HorizonCode even when delegating to Codex; pin app-server version/capabilities; map child thread IDs to an external attempt; record actual commit and test evidence; do not inherit broader permissions; verify changes on the integrated worktree.

## Source index

- [Core agent controller](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/core/src/agent)
- [Agent graph store](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/agent-graph-store/src)
- [Thread, turn, and item contracts](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/src/protocol/v2)
- [Generated app-server schemas](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/app-server-protocol/schema)
- [Rollout storage and readers](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs/rollout/src)
- [Execution and sandbox crates](https://github.com/openai/codex/tree/67a709665ac7b50311b93e32612c9a8281684787/codex-rs)
