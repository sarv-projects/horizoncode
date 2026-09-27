# OpenCode — source architecture and schema map

> INTERNAL RESEARCH — source snapshot: OpenCode main at **b471c2b4495747353af768fbf2e0790c9d820ce2**, checked 2026-09-26. The release page showed v1.18.30 in September; this note describes the pinned main commit, which can differ from a released binary. This is a subsystem-level source map, not a transcription of every source and generated file.

## System boundary and HLD

OpenCode is an open-source coding-agent application and runtime with terminal, desktop/web, SDK/server, IDE, plugin and ACP surfaces. Its main TypeScript application owns session orchestration, tools, permissions, provider selection, workspace/project state and persistence.

    CLI / TUI / desktop / IDE / SDK / HTTP server / ACP server
                             │
             application services and effect runtime
     config · project · session · permissions · provider · tools
             │                    │                   │
      model connectors      built-in/plugins/MCP    filesystem/Git/LSP
                             │
          local SQLite · session/workspace artifacts

The source divides application code under packages/opencode/src by domain and shared persistence/contracts under packages/core. The public API and SDK are separate boundaries. OpenCode also has model catalogs/connectors and plugin integrations; those do not make all providers behaviorally interchangeable.

## Source map

| Domain | Pinned source paths | Role |
|---|---|---|
| CLI and runtime composition | packages/opencode/src/cli, packages/opencode/src/effect | Commands, process setup, runtime/services and TUI entry points. |
| Session loop | packages/opencode/src/session/processor.ts, session/session.ts, session/prompt.ts, session/llm.ts | Turn admission, prompt construction, streaming, tool calls, retries, compaction, finish/failure. |
| Message and state contracts | packages/opencode/src/session/message-v2.ts, session/schema.ts, session/status.ts, session/run-state.ts | Typed session/message/part/status/runtime state. |
| Tools and subagents | packages/opencode/src/tool, packages/opencode/src/agent, packages/opencode/src/agent/subagent-permissions.ts | Tool definitions/registry, built-ins, permission-filtered tool lists and task delegation. |
| Provider/model | packages/opencode/src/provider, packages/core/src/config/provider.ts, packages/opencode/src/plugin | Provider discovery/config, model metadata, auth and request transformation. |
| Persistence | packages/core/src/session/sql.ts, packages/core/src/database, packages/opencode/src/storage | SQLite/Drizzle session tables, generated schema and migrations; file-backed configuration and artifacts. |
| Server/API | packages/opencode/src/server, packages/opencode/src/server/routes/instance/httpapi | HTTP/SSE API and SDK-facing route contracts. |
| ACP | packages/opencode/src/acp | Inbound ACP agent implementation and session/event/permission translation. It is distinct from an outbound ACP client adapter. |
| Project/workspace | packages/opencode/src/project, packages/opencode/src/worktree, packages/opencode/src/snapshot, packages/opencode/src/git | Project identity, workspaces/worktrees, snapshots and Git operations. |
| Context intelligence | packages/opencode/src/lsp, tool/lsp.ts, tool/grep.ts, tool/glob.ts, tool/read.ts | Language-server diagnostics/symbol actions and text/file search/read tools. |

Pinned navigation: [session processor](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/session/processor.ts), [session service](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/session/session.ts), [task tool](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/tool/task.ts), [tool registry](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/tool/registry.ts), [SQLite schema](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/core/src/session/sql.ts), [ACP agent](https://github.com/anomalyco/opencode/blob/b471c2b4495747353af768fbf2e0790c9d820ce2/packages/opencode/src/acp/agent.ts), [release history](https://github.com/anomalyco/opencode/releases).

## Core execution flow

1. Bootstrap resolves working directory, project/workspace, merged configuration, provider/model and selected agent profile.
2. A prompt is validated and admitted to a session. Session service creates or resumes session state and persists user input/message records.
3. Prompt assembly combines system instructions, project instructions, conversation history, tool schemas, context and model-specific options.
4. The processor streams model output and normalizes text, reasoning, tool calls and usage into typed parts/events.
5. Tool calls pass through the registry and current agent's permission set. A tool result becomes session data and is fed back into another model request.
6. The processor handles retry/overflow/compaction and completion. Repeated identical tool-call signatures are detected by a small doom-loop guard (threshold is three recent repeated parts in this source snapshot); it is not a long-horizon retry controller.
7. Events are made available to TUI, server clients and subscribers while session state, message parts, todos, input sequencing and context epoch are stored.

The model/tool loop is reusable for interactive coding, but its unit of durable work is primarily the session. Todo lists and task subagents do not automatically make a verified, resumable project-level task DAG.

## Persistence and schema families

The SQLite declarations in packages/core/src/session/sql.ts are the concrete relational core. Migration-generated schema is a separate artifact and should be checked against declarations at the pinned revision.

| Table | Main fields and invariants |
|---|---|
| session | ID; project/workspace/parent IDs; slug, directory/path, title/version; share URL; summary diff stats; JSON metadata/revert/permissions/model; agent; cost/token totals; created/updated/compacting/archived timestamps. Parent index supports child-session lookup. |
| message | Message ID, session ID, timestamps and JSON message data. Session/time index supports ordered history retrieval. |
| part | Part ID, message ID, session ID, timestamps and JSON part data. Message and session indexes support part reconstruction. |
| todo | Session ID, content, status, priority, position and timestamps; composite primary key on session and position. |
| session_message | Sequenced typed session message/event with ID, session ID, type, seq, timestamps and JSON data; unique (session_id, seq). |
| session_input | Input ID/session, JSON prompt, delivery mode, admitted sequence, optional promoted sequence and creation time; uniqueness by session/admitted sequence and session/promoted sequence; pending-delivery index. Supports queued/steered admission rather than making a prompt merely transient. |
| session_context_epoch | One row per session with baseline string, serialized system-context snapshot and baseline sequence; session foreign key cascades on delete. |

The schemas are not a complete business-level contract: JSON payloads are versioned/typed in TypeScript source, and public HTTP, ACP, plugin and model-provider contracts are separate. The persistence design has evolved through migrations; consumers should not infer append-only event sourcing solely from the presence of session_message or input sequencing.

Important non-SQL data includes user/project config, agent profiles, plugin definitions, provider credentials, snapshots/diffs, and other file-backed artifacts. Account for secret handling and directory boundaries before copying any layout.

## Subagents, tools, and permissions

The task tool delegates a bounded prompt to a selected agent and may attach task context. It creates a child session with parent linkage and uses the same broad session/model/tool machinery. Agent definitions describe allowed tools, mode/model and instructions; tool registry materialization is filtered through the active agent's permissions.

This is a useful source for the worker/session/child-session boundary. The child relationship lets the UI/runtime associate subagent sessions, but it is not equivalent to durable parent-owned dependency edges, attempt leases, evidence-backed acceptance, aggregate budget reservation or recovery after parent process loss. Those guarantees need a controller above the child session.

Tool execution combines schema/validation, permission checks, tool-specific behavior and event output. Permission is an application policy gate; the real execution boundary also depends on the host, filesystem access, shell process and OS/container isolation. Do not describe an approval dialog as a sandbox.

## Provider and extension flow

OpenCode separates model/provider metadata and request transformation from the session loop, with provider connectors and plugins extending the model catalog or behavior. It can use many cloud and local endpoints, but an OpenAI-compatible API label does not promise equivalent streaming, tool-call parsing, cancellation, context accounting or structured output.

HorizonCode selected models.dev as a provider/model catalog in its current architecture decision. That selection can reuse catalog data without adopting OpenCode's session engine or granting the catalog authority over execution.

## Code understanding, tests, review and delivery

- Repository navigation combines explicit file/search tools, LSP actions/diagnostics, project instructions, Git state and user-supplied context. This is evidence retrieval, not a guaranteed whole-repository architectural map.
- Tests/debugging use shell/test tools and subsequent model turns. Tool success is not independent verification.
- Git snapshots, diffs, worktrees and session summaries help inspect or isolate changes. The task/session model alone does not enforce that acceptance tests ran against the final integrated commit.
- Review, sharing, PR and external Git-host actions cross separate authorization and side-effect boundaries. A long-horizon orchestrator should journal the intent, request/result and idempotency/reconciliation evidence for such effects.

## Strengths, gaps, and HorizonCode lessons

**Useful patterns:** clear domain modules; typed runtime and API contracts; permission-aware dynamic tool materialization; SQLite history with ordering; queued/steered input sequencing; context compaction; child sessions; provider/catalog separation; inbound ACP server; LSP plus explicit repository tools.

**Limits for the stated long-horizon goal:** the principal loop remains prompt/session-centred; project todo state is not a general dependency graph; retry/doom-loop logic is local to a run; no universal independent intent evaluator; third-party/provider sessions can have different recovery and usage observability; session persistence does not alone reconcile code, external side effects and verified task status.

**HorizonCode lessons:** persist task/run/attempt independently from transcript; connect every evidence record to spec version and code commit; normalize children without inventing peer telemetry; use capability negotiation for inbound/outbound ACP; keep provider catalog, agent protocol, worker runtime and controller as separate abstractions.

## Coverage limits

This map follows core source paths and the database schema at the pinned commit. It does not enumerate each provider connector, generated event/API schema, UI component, migration, test or platform integration. “Entire internal architecture” is not a defensible claim for a repository this large; source links make the examined path auditable.
