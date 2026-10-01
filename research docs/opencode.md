# OpenCode — source architecture and schema map

> INTERNAL RESEARCH — baseline source snapshot: OpenCode main at **b471c2b4495747353af768fbf2e0790c9d820ce2**, checked 2026-09-26. Targeted follow-up review: `dev` commit **083ed266e058dc3d2d1b377ff5540859d79de110**, checked 2026-09-28 for Session identity, task delegation, process-local background jobs, and the V2 Session contract. A branch snapshot can differ from a released binary. This is a subsystem-level source map, not a transcription of every source and generated file.

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
| Terminal UI | packages/tui/src/routes/home.tsx, routes/session/index.tsx, routes/session/permission.tsx, routes/session/question.tsx, routes/session/dialog-timeline.tsx, context/sdk.tsx, context/sync.tsx, context/theme.tsx | Home/session rendering, active-turn/tool states, approval/question surfaces, session navigation, SSE event handling, state hydration, and theme selection. Targeted UI follow-up uses commit `083ed266e058dc3d2d1b377ff5540859d79de110`; it is source inspection, not an executed UI/usability test. |

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

OpenCode's pinned `packages/core/src/models-dev.ts` currently fetches
`https://models.opencode.ai/api.json` by default, while the provider documentation
describes its use of Models.dev and the wider 75+ provider/model catalog. HorizonCode's
provider decision consumes a bounded, inert projection of the OpenCode-owned feed and
separately reads the OpenCode Go model directory. It does not treat the provider docs,
catalog feed, provider plugins, and Go models as one source or one support claim. The
2026-09-28 credential-free feed snapshot contained 225 provider IDs and 8,253 model
records; the Go `/models` endpoint returned 43 IDs, while the global-feed `opencode-go`
record contained 33 and the Go docs mapped 30 IDs to request paths. These differences
are upstream drift, so unknown model routes remain unavailable until a released,
conformance-tested local mapping exists. The full provider-ID snapshot, 51 documented
auth-method entries, all 32 provider-module filenames, and dated Go route-map evidence
are in [the provider inventory](opencode-provider-inventory.md).

## Code understanding, tests, review and delivery

- Repository navigation combines explicit file/search tools, LSP actions/diagnostics, project instructions, Git state and user-supplied context. This is evidence retrieval, not a guaranteed whole-repository architectural map.
- Tests/debugging use shell/test tools and subsequent model turns. Tool success is not independent verification.
- Git snapshots, diffs, worktrees and session summaries help inspect or isolate changes. The task/session model alone does not enforce that acceptance tests ran against the final integrated commit.
- Review, sharing, PR and external Git-host actions cross separate authorization and side-effect boundaries. A long-horizon orchestrator should journal the intent, request/result and idempotency/reconciliation evidence for such effects.

## Strengths, gaps, and HorizonCode lessons

**Useful patterns:** clear domain modules; typed runtime and API contracts; permission-aware dynamic tool materialization; SQLite history with ordering; queued/steered input sequencing; context compaction; child sessions; provider/catalog separation; inbound ACP server; LSP plus explicit repository tools.

**Limits for the stated long-horizon goal:** the principal loop remains prompt/session-centred; project todo state is not a general dependency graph; retry/doom-loop logic is local to a run; no universal independent intent evaluator; third-party/provider sessions can have different recovery and usage observability; session persistence does not alone reconcile code, external side effects and verified task status.

**HorizonCode lessons:** persist task/run/attempt independently from transcript; connect every evidence record to spec version and code commit; normalize children without inventing peer telemetry; use capability negotiation for inbound/outbound ACP; keep provider catalog, agent protocol, worker runtime and controller as separate abstractions.

## Targeted V2 and delegation review (2026-09-28)

The following claims were checked against the exact `dev` revision
`083ed266e058dc3d2d1b377ff5540859d79de110`, not inferred from the older baseline:

- `packages/schema/src/session.ts` defines one durable `Session.Info` with `id`,
  optional `parentID`, project/location, agent/model, usage, timestamps, title and
  revert metadata. `packages/opencode/src/session/session.ts` exposes child lookup
  and session creation with `parentID`; this revision has no separate durable
  `Thread` aggregate.
- `packages/opencode/src/tool/task.ts` calls the child session ID `task_id`: its
  schema says that reusing it resumes the same subagent session. On a fresh
  delegation it creates a child Session with `parentID = ctx.sessionID`; child
  permissions are derived from the parent session and selected subagent profile.
  This is task-tool continuity, not a general project task/DAG identity with
  independent acceptance evidence.
- At this call site, a missing/unresolvable `task_id` is caught and treated as no
  reusable Session, so the tool creates a new child. The resume lookup also does not
  visibly compare the returned Session's `parentID` with the current parent before
  reuse. This is a narrow source observation, not a claim that the full application
  permits cross-parent access: surrounding permission/session checks require a
  separate trace. A HorizonCode adapter must bind a peer session to its recorded
  parent Attempt/profile/workspace and reject or reconcile stale, foreign, or
  mismatched handles rather than silently starting a duplicate.
- `packages/core/src/background-job.ts` explicitly documents a process-local,
  non-durable registry. Process restart or owner-scope closure loses registry
  status and interrupts live work. The code's start/list/get/wait/cancel operations
  are useful local execution primitives, not restart-safe run ownership.
- `specs/v2/session.md` distinguishes durable prompt admission (`PromptAdmitted`)
  from model-visible history (`Prompted`), persists pending input in a session
  inbox, and specifies sequence-based durable event replay. Text/reasoning/tool
  deltas are live-only and do not advance the durable cursor. It also describes a
  process-global `SessionRunCoordinator`: active execution is process-local, and
  recovery/ownership after process restart is explicitly outside that slice.
  Context Epochs preserve the privileged baseline and source snapshot used for
  provider requests; compaction start/end have durable boundaries.

**Disposition for HorizonCode:** OpenCode supports keeping one durable conversation
identity with parent/child lineage, a durable input inbox, and replayable aggregate
events. It does not establish that a durable task should equal that conversation.
HorizonCode already has the equivalent conversation aggregate in `CMP-session`;
Codex calls its comparable concept a Thread. Adding a second persisted
`Thread` beside HorizonCode `Session` would duplicate identity and migration paths.
The unresolved runtime gap is a durable record of each live worker/process
incarnation, distinct from both a session and an attempt, so restart reconciliation
can determine whether to resume, relaunch, wait, or keep the outcome `UNKNOWN`.

Pinned follow-up links: [Session schema](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/schema/src/session.ts), [Task tool](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/opencode/src/tool/task.ts), [background job](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/core/src/background-job.ts), [V2 Session spec](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/specs/v2/session.md).

## TUI source walk-through: idle, active work, and recovery boundary (2026-09-28)

This is a source trace of the normal OpenCode terminal UI at the exact `dev` commit
`083ed266e058dc3d2d1b377ff5540859d79de110`. The UI was not launched in a terminal,
and these observations do not establish usability, rendering correctness, or runtime
recovery behavior. The project also has separate `opencode run` and server/client
surfaces; this section describes `packages/tui`, not every CLI mode.

### Idle and session entry

- The home route is intentionally sparse: a centered logo, one prompt, normal/shell
  placeholders, extension slots, toast area, and footer. It waits for initial sync and
  model readiness before auto-submitting an explicit CLI `--prompt`; it does not insert
  an automatic planning/review ceremony into ordinary interactive requests.
- Submitting from home creates a Session with the selected agent, provider/model,
  workspace and directory, then sends the prompt and navigates to that Session. The
  composer also routes shell-mode commands and registered slash commands through
  separate APIs. A guard prevents a double-submit race that could otherwise send a
  phantom empty prompt.
- On opening an existing Session, the route fetches its metadata, workspace, recent
  messages, todos and diff, then scrolls to the latest content. The current TUI sync
  projection asks for at most 100 messages and retains the latest 100 in memory; this
  is a rendering/history window, not proof of whole-history search or unlimited
  scrollback. The timeline dialog is built from currently loaded user messages only.

### Active generation and tool execution

- The transcript renders user and assistant messages as typed parts: text, reasoning,
  and tool activity. Tool cards expose pending/running/completed/error states and may
  expand details or output. The final assistant footer names mode and model,
  shows elapsed time when available, and marks interruption. Retry states surface the
  failure and attempt/backoff information in the session view/toast path.
- The prompt remains a first-class control during work. The keymap exposes
  interruption; the root prompt submission calls the Session prompt API without an
  explicit delivery mode. The pinned V2 Session contract defaults omitted delivery to
  `steer`, while the API also supports FIFO `queue`; the main TUI source inspected here
  does not expose a user-facing per-message steer-versus-queue selector. Pending user
  messages can be labeled `QUEUED`. HorizonCode should expose its stronger durable
  input receipt/lane semantics directly rather than rely on an implicit default.
- The UI reacts to completed `plan_enter`/`plan_exit` tools by changing the local agent
  selection to plan/build, and provides navigation to child Sessions created by the
  Task tool. The subagent footer reports the agent label, sibling position, observed
  token/context usage and session cost, with parent/previous/next navigation. Those
  values belong to the peer Session; they do not establish parent-task completion.

### Permissions, questions, and background children

- A root Session aggregates pending permission and question requests from its child
  Sessions. When one is pending, the ordinary composer is replaced by a blocking
  prompt. The UI gives permission-specific context (for example, the file and diff,
  shell command, URL, directory pattern, or child-agent request) and offers allow once,
  allow always, or reject. In this source, “always” is explicitly temporary until the
  OpenCode process restarts. A rejection may collect guidance for the child. Questions
  support selectable/custom and multiple answers. This is an interaction pattern, not
  an authorization guarantee: HorizonCode's owner-bound review, guard, sandbox and
  receipts remain authoritative.
- Foreground/background subagent status is surfaced from task tool parts when the
  capability is available. A completed child response is still a conversation result,
  not independently verified acceptance evidence.

### Navigation, preferences, and visual feedback

- Session actions include timeline/jump-to-message, fork-from-timeline, rename,
  compaction, copy/export, and parent/child navigation. Timeline entries are user
  prompts with timestamps and are drawn from the loaded window. This is narrower than
  HorizonCode's proposed full-text search index across retained sessions.
- The session view adapts its sidebar to terminal width (automatically shown above
  120 columns unless hidden); on narrower terminals it can be opened as an overlay.
  A footer exposes project/workspace information and integration status. User
  preferences include timestamps, reasoning visibility, tool details, scrollbar,
  generic tool-output visibility and diff behavior. Themes can follow terminal/system
  dark/light mode, can be locked, and may be loaded from JSON files in configuration or
  ancestor `.opencode/themes/` directories.
- Tool progress and errors appear inline rather than opening panels or stealing focus.
  The session view deliberately distinguishes an in-flight tool, a retry, a permission
  wait, an interactive question, a completed assistant response, and an interrupted
  response. HorizonCode's target adds run/task/attempt and verification state because
  a peer Session's visual completion is not the product-level completion condition.

### Event and recovery boundary

The TUI's global SSE client batches events for up to 16 ms to reduce render churn,
flushes buffered events when a stream closes, and reconnects with exponential backoff
from 1 to 30 seconds. In the inspected `packages/tui` call path, the global stream is
opened without an explicit durable aggregate cursor. Separately, the pinned V2 Session
API defines sequenced per-Session events/history and sync support. Therefore reconnect
correctness depends on the synchronization/replay path, not merely on reconnecting the
SSE transport; a HorizonCode implementation should test event loss during disconnect,
replay to an exact cursor, and snapshot fallback. The source does not justify claiming
that every UI state is automatically reconciled after every reconnect.

Pinned UI files: [home route](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/routes/home.tsx), [Session route](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/routes/session/index.tsx), [permission prompt](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/routes/session/permission.tsx), [question prompt](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/routes/session/question.tsx), [timeline dialog](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/routes/session/dialog-timeline.tsx), [SSE client](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/context/sdk.tsx), [session hydration](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/context/sync.tsx), [theme context](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/tui/src/context/theme.tsx), [V2 Session API](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/specs/v2/session.md).

**HorizonCode disposition:** retain an explicit, inspectable idle composer and recent transcript, but do not assume a sparse home screen is enough for task discovery or long-running progress. Keep the run/task/attempt/Session hierarchy, independent verification, typed blocking prompts, visible status/cost, and the durable queue receipts already designed in `ARCH/product/UI.md`, `ARCH/execution/LONG-HORIZON.md`, and `ARCH/integrations/CONTROL-API.md`. Full-history search must query the derived index and page canonical history by immutable message ID; it must not be limited to the TUI's in-memory transcript window. An attach/reconnect must expose `Reconnecting`/`Recovering`/last-seen state and finish replay or snapshot reconciliation before presenting current controls as authoritative.

## Coverage limits

This map follows core source paths and the database schema at the pinned commit. It does not enumerate each provider connector, generated event/API schema, UI component, migration, test or platform integration. “Entire internal architecture” is not a defensible claim for a repository this large; source links make the examined path auditable.

For the separate provider follow-up at `083ed266e058dc3d2d1b377ff5540859d79de110`,
the exact model-feed schema/fetch and provider/auth integration modules were also
checked. The OpenCode review enumerates all 225 IDs in a dated live provider-feed response.
The raw feed also contains environment hints, but those hints do not establish authentication
and are not copied into the repository inventory.
The 51 named documentation entries have their documented methods recorded separately;
undocumented methods, restrictions, and incomplete source evidence remain `unknown` or
unavailable. The Go discovery list and the documentation route table also disagree, so
the Go adapter must not infer a wire protocol for new model IDs. Current Go price and
free-offer claims are volatile and not live inference-test evidence.

## 2026-09-29 source-inventory and flow follow-up

The pinned tree at `083ed266e058dc3d2d1b377ff5540859d79de110` has 6,642 tracked paths,
including 2,735 TS, 609 TSX, 1,262 SVG, 254 PNG, 779 Markdown/MDX files, 905 test-file
candidates, 95 migration paths, and 14 specs. This pass inspected the main provider,
auth, session/V2 input and compaction, subagent, search, update, and UI owners plus
selected tests/specs; it did not read every path, provider, test, migration, or asset.
The full file inventory and limitations are recorded in the reviewer handoff; no
OpenCode tests, UI, or live provider request were run.

Important source-confirmed distinctions at this pin:

- **Catalog versus callable route:** the Go model directory/global catalog is broader
  than the V2 runner's three adapter families (`@ai-sdk/openai`, `@ai-sdk/anthropic`,
  and URL-backed OpenAI-compatible). Go docs map individual IDs across `/responses`,
  `/chat/completions`, and `/messages`. Metadata presence is not protocol support.
  OpenCode also loads/invokes provider JavaScript identified by metadata; Horizon's
  inert projection and locally implemented Rust routes avoid granting refreshed data
  code execution authority. For Go affinity, use HorizonCode's own honest User-Agent
  and stable opaque per-conversation ID; do not copy OpenCode project/client identity
  headers or expose local project identifiers.
- **Search:** server search is title-only SQL `LIKE`, while the home UI searches loaded
  title/project-name records in memory and caps its session window at 64; API defaults
  are 100. The inspected app/core paths contain no FTS message index. SQL wildcard
  characters `%` and `_` are not escaped. This does not meet full-history/exact-phrase/
  jump-to-message requirements; Horizon's indexed message-content design remains a
  deliberate addition.
- **Updates:** configured autoupdate can install patch releases without an explicit
  confirmation; non-patch/notify cases prompt, and the TUI offers skip/version
  suppression/restart. The inspected curl path executes a fetched shell installer;
  no signature/checksum validation was visible in that path. Horizon's confirmation-
  first signed update and maintenance fence remain the selected safer design.
- **Compaction and V2 lifecycle:** durable history and compaction boundaries survive,
  but the compaction summary may replace non-text tool attachments with MIME/name
  markers and truncate tool text to 2,000 characters. The V2 spec explicitly defers
  crash continuation, inbox backlog limits, local tool-fanout bounds, and provider
  timeout/watchdog policy. Horizon should retain raw artifact/history references and
  keep its separate bounded `Attempt`/`WorkerExecution` recovery contract.

Pinned source references: [Go route mapping and client requirements](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/web/src/content/docs/go.mdx),
[V2 model adapters](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/core/src/session/runner/model.ts),
[session title search](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/opencode/src/session/session.ts),
[home search](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/app/src/pages/home/home-session-search-controller.ts),
[upgrade flow](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/opencode/src/cli/upgrade.ts),
[installer path](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/opencode/src/installation/index.ts),
[compaction](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/core/src/session/compaction.ts),
and [V2 session lifecycle/deferred work](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/specs/v2/session.md).

## 2026-09-29 provider and exhaustive-coverage follow-up

At the same pinned OpenCode commit, the source inventory matched 3,630 code-like
files, 730,816 lines, and 28,280,753 bytes for the declared extension set. The
reviewer ledger recorded 14 full-file reads, 10 partial-file reads, and 3,606 files
unread. This is not a literal all-code-file review. The complete per-file ledger was
kept at `/tmp/opencode-audit-083-coverage.csv` for this audit session; the full-read
paths were `packages/app/src/pages/home/home-session-search-controller.ts`,
`packages/app/src/pages/home/home-sessions-controller.tsx`,
`packages/core/src/models-dev.ts`, `packages/core/src/plugin/models-dev.ts`,
`packages/core/src/plugin/provider/dynamic.ts`,
`packages/core/src/plugin/provider/openai-compatible.ts`,
`packages/core/src/plugin/provider/opencode.ts`,
`packages/core/src/session/context-epoch.ts`,
`packages/core/src/session/event.ts`, `packages/core/src/session/input.ts`,
`packages/core/src/session/run-coordinator.ts`, `packages/core/src/session/schema.ts`,
`packages/opencode/src/session/llm/request.ts`, and
`packages/tui/src/component/dialog-session-list.tsx`. Other findings are cited to
partial file ranges and are not represented as whole-file inspections.

Provider registration is not one self-contained, portable connector. The feed supplies
catalog data; provider execution merges config/auth/plugin state and loads bundled or
dynamically installed JavaScript SDK adapters. Copying the execution system “as-is”
would also import that runtime and its package-execution boundary. HorizonCode's native
Rust adapters are a compatibility implementation, not a source-code transplant. The
feed's inspected cache/fetch path parses JSON and casts it to TypeScript types without
runtime schema decoding. The provider projection also defaults absent `tool_call`
metadata to enabled. HorizonCode therefore needs strict local schema validation and
tri-state capabilities; absence must remain `unknown`, not become permission to send
tools or claim cache support. Evidence: [`models-dev.ts`](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/core/src/models-dev.ts#L184-L195),
[`provider projection`](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/opencode/src/provider/provider.ts#L1340-L1359),
and [`dynamic SDK loading`](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/core/src/plugin/provider/dynamic.ts#L6-L29).

OpenCode's local-model documentation uses configured OpenAI-compatible endpoints for
LM Studio/Ollama; it does not establish a universal local runtime or uniform tool/cache
capabilities. See the pinned [provider documentation](https://github.com/anomalyco/opencode/blob/083ed266e058dc3d2d1b377ff5540859d79de110/packages/web/src/content/docs/providers.mdx#L1497-L1527)
and the Ollama example at lines 1692–1729. Its title search uses SQL `LIKE`; the
reviewed query did not visibly escape `%` or `_`. Horizon's literal phrase search
should not inherit wildcard behavior accidentally.

No OpenCode tests, live UI, or provider request were run. The pinned source review
remains a focused architecture audit; 3,606 code-like files were not read.
