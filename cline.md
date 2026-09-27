# Cline — source architecture and schema map

> INTERNAL RESEARCH — source snapshot: Cline v4.1.21 at **787ad1b077d8b697892dc3bfcd42e7c65b88789e**, released 2026-09-24. Includes VS Code product, CLI, SDK and shared packages. This map follows primary runtime/schema paths; it does not enumerate every UI component or test fixture.

## High-level architecture

Cline has evolved from an editor extension into a set of clients over a layered agent SDK. The same reusable agent loop is separated from Node session/orchestration services and model integrations.

    VS Code / CLI / JetBrains / desktop / custom app
                         │
              local / hub / remote host
                 client ↔ hub ↔ spoke
                         │
                      @cline/core
       sessions / tools / approvals / automation / teams
          │                │                 │
     @cline/agents     @cline/llms       @cline/shared
      agent loop       providers          schemas/tools
                         │
              local filesystem / SQLite

The SDK architecture docs state that dependencies flow downward: core depends on agents, llms and shared; agents depend on llms and shared. In hub-spoke mode, a singleton daemon coordinates sessions and events, spoke workers execute the loop, and clients connect over WebSocket. The client is not the worker owner.

## Source layout

| Area | Source paths | Responsibility |
|---|---|---|
| Product surfaces | apps/vscode, apps/cli, apps/desktop, apps/jetbrains | Editor UI, CLI process, desktop and JetBrains clients. |
| Core runtime | sdk/packages/core/src/ClineCore.ts, sdk/packages/core/src/cline-core | Host composition, session lifecycle, built-in tools, approvals, automation, hub, teams, plugins and telemetry. |
| Agent loop | sdk/packages/agents/src | Browser-compatible agent runtime with run/continue/abort/subscribe/restore/snapshot entry points. |
| Provider/model layer | sdk/packages/llms/src | Provider handlers, gateway, model/provider metadata, request and streaming integration. |
| Shared contracts | sdk/packages/shared/src | Agent/tool/message/event/config types, extension interfaces and hook contracts. |
| Session store | sdk/packages/core/src/session, services/session-data.ts, services/storage/sqlite-session-store.ts | Session manifest, messages/artifacts, local and hub-backed history. |
| Agenda tasks | sdk/packages/core/src/tasks | Task CRUD, task specs, scheduler/automation policies, run claims and task tool. |
| Multi-agent/team | sdk/packages/core/src/extensions/tools/team, services/storage/sqlite-team-store.ts | Delegated agents, team task state/events/outcomes and runtime snapshot. |
| Hub | sdk/packages/core/src/hub | Daemon lifecycle, client registration, runtime ownership, command/event routing, WebSocket and replay. |
| Build/run harnesses | apps/cli/src/acp, apps/cli/src/runtime, apps/cli/src/connectors | ACP, native CLI execution and scheduled/remote connectors. |

Pinned source: [SDK package architecture](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/overview.mdx), [hub/spoke](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/hub-spoke.mdx), [runtime](https://github.com/cline/cline/tree/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/agents/src), [core](https://github.com/cline/cline/tree/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src).

## Main task/agent flow

1. A client discovers/starts a local hub or creates a local runtime directly.
2. It registers capabilities, attaches to or creates a session, and submits a task.
3. Core resolves model/provider, instructions, tool loadout, permission/mode, extensions and runtime host.
4. The agent loop builds a request, streams text/tool calls, validates tool results, invokes tools, and observes outputs.
5. Core records messages, tool events and task/session state; permissions or client capabilities may pause execution for user input.
6. The loop continues, compacts context when required, terminates, or reports failure/interruption.
7. Hub clients can detach and reconnect to an owned spoke session; a scheduler can launch eligible tasks without an attached client.

The September 2026 v4.1.21 release notes describe concurrent subagent tool calls within a step and recovery when long replies from local models reach output limits; those are release facts for that version, not universal guarantees for every provider/model.

## Session and task schemas

### Session manifest

The Zod v1 manifest includes:

- Identity/lifecycle: version, session ID, source, process ID, start/end, exit code, status.
- Interaction/provider: interactive flag, provider, model, prompt.
- Workspace: cwd and workspace root.
- Capabilities: tools, spawn, team flags; optional team name.
- Optional metadata/artifacts: metadata record, messages path and compaction path.

Reference: [session manifest schema](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/session/models/session-manifest.ts). Session message content/artifacts and local versus hub indexes are separate storage concerns; the manifest is not the entire conversation schema.

### Agenda task store

The SQLite agenda schema is unusually relevant to long-horizon work:

| Table | Main data |
|---|---|
| agenda_tasks | Task ID/type/status; title/description/instructions; workspace/global scope; workspace root/cwd/resource paths; priority; assignee/model/mode/system prompt; max iterations/timeout; availability/expiry; automation eligibility; revision and approved revision; creator/updater provenance; origin session/task; current/last run and last session; optional spec path/error and timestamps. |
| agenda_task_runs | Run ID/task/revision/attempt; starting/running/completed/failed/cancelled/interrupted state; claim token and lease expiry; requesting client; session ID; result summary/error and lifecycle timestamps. |
| agenda_task_automation | Scope key, manual/auto-start/unattended mode, whether agent-created tasks may run, concurrent-run limit, chain-depth limit, hourly start limit, enabling actor and timestamps. |

Constraints include task type/status/scope checks, unique task-attempt, one active run per task, and ready/scope/origin indexes. SQLite uses WAL, a busy timeout and foreign keys. Source: [task schema](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/tasks/store/task-schema.ts), [store](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/tasks/store/sqlite-task-store.ts).

This is a durable task queue/automation model. It does not, by itself, establish a general dependency DAG whose downstream tasks are unlocked only by independently verified acceptance evidence.

### Team persistence

The team store defines a schema version and tables for team event history, runtime snapshots, task rows, runs, outcomes and outcome fragments. This gives team coordination a structured store distinct from the user's transcript. Compare it with a durable DAG and task/run distinction. Source: [SQLite team store](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/services/storage/sqlite-team-store.ts).

## Hub/spoke and recovery flow

1. The hub daemon is discovered or started as a singleton; the design uses lock records for owner discovery.
2. Clients register over WebSocket and advertise operations they can perform, such as file editing, shell access or diff display.
3. The hub creates/attaches the session and assigns a spoke worker.
4. The spoke runs the agent loop and sends events to the hub; the hub routes them to interested clients and stores session/task state.
5. A client disconnect does not own the worker lifetime. It can reconnect and observe/steer if its capabilities allow.
6. Schedules/tasks can run without a foreground client; policy mode and automation caps gate unattended execution.

The boundary “clients participate, spokes execute, hub coordinates” is a useful multi-surface reference. It also introduces daemon discovery, leases, event replay, transport authentication, duplicate-worker prevention and migrations that must be tested as system behavior.

## Tool, permission, and extension flow

- Built-in and contributed tools share typed contracts from shared.
- Core controls tool availability and user approvals; host capabilities and runtime mode affect which actions can be offered.
- Provider handlers are isolated behind a gateway so agent-loop code is not tied to each vendor protocol.
- Plugins and agent extensions register tools/skills through declared extension contracts.
- Team/subagent runtime carries delegated tasks and tool/activity events; configured agents can use distinct system prompts, models and tools.

Current source organization intentionally separates loop, Node-specific effects and tool definitions. Do not interpret a UI approval prompt as enforcement by the OS sandbox; inspect the active tool/runtime backend.

## Code understanding, testing, review, and delivery

- Code understanding is supported by workspace browsing, search, editor context and tools. Serena-like semantic LSP intelligence is not inherent in every Cline surface; verify which client/runtime supplies it.
- Testing/debugging is the same tool-feedback loop as implementation: command output is fed back to the agent; independent acceptance is still an external evaluator's responsibility.
- Session/diff review is visible in editor and hub experiences; the team store records task/run outcomes.
- PR workflow integrates with Git/GitHub-oriented tools and development clients, but agenda task completion and PR merge are different state machines. PR creation, review response and merge are external effects that need durable idempotency/authorization in an autonomous controller.

## Strengths, limitations, and HorizonCode lessons

**Useful patterns:** reusable loop package; separate host/core layer; rich hub/spoke deployment; manifest-based session recovery; SQLite agenda with claim leases/revision approval and concurrency limits; team event/snapshot/task/run/outcome tables; SDK surfaces shared by multiple clients.

**Limits:** scheduled status does not prove successful software behavior; there is no reason to assume agenda tasks form a complete spec-to-acceptance DAG; session persistence and task persistence are separate stores that require a reconciliation contract; hub/spoke adds distributed-state and identity boundaries.

**HorizonCode lessons:** separate the client UI from worker lifecycle; use task revisions and approvals to invalidate stale plans; persist every attempt and lease; do not represent unavailable peer internals as progress; tie successful dependencies to verifier evidence; keep external-agent tasks in HorizonCode even if a Cline-like SDK or hub is used.

## Primary references

- [Cline v4.1.21 release and changes](https://github.com/cline/cline/releases)
- [SDK packages](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/overview.mdx)
- [Hub-spoke architecture](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/hub-spoke.mdx)
- [Session manifest](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/session/models/session-manifest.ts)
- [Agenda task schema](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/tasks/store/task-schema.ts)
- [Team store schema](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/services/storage/sqlite-team-store.ts)
