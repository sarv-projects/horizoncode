# Cline — source architecture and schema map

> INTERNAL RESEARCH — source snapshot: Cline v4.1.21 at **787ad1b077d8b697892dc3bfcd42e7c65b88789e**, released 2026-09-24. The pinned tree has 4,116 tracked paths; this is a subsystem-focused architecture audit, not a line-by-line read of every path.

The project ships independently versioned channels. The 2026-09-27 release page lists core v4.1.21, SDK 0.0.86, CLI 3.0.65, and Desktop 0.0.37; the source map below pins core v4.1.21, while desktop-only changes must be checked at their own tag. The v4.1.21/SDK 0.0.86 notes report a one-time compact-and-retry for local-model responses truncated at the remaining-context ceiling, preservation of the partial reply, and no replay of turns that produced tool calls; they also persist terminal errors across navigation/resume. Treat these as versioned release behavior, not as proof for every host or model.

## High-level architecture

Cline has evolved from an editor extension into multiple clients over a layered agent SDK. The same reusable agent loop is separated from Node session/orchestration services and model integrations. The pinned repository includes VS Code, CLI, Cline Hub, and an example desktop app; it does not contain an `apps/desktop` product tree or an open-sourced JetBrains app. The README describes the JetBrains plugin as not open source.

    VS Code / CLI / Cline Hub / example desktop / custom app
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

The SDK architecture docs state that dependencies flow downward: core depends on agents, llms and shared; agents depend on llms and shared. The public hub-spoke document describes a hub/spoke topology, but that document is not proof that the pinned runtime implements remote spokes. At pin `787ad1b077d8b697892dc3bfcd42e7c65b88789e`, `HubServerTransport` defaults to a `LocalRuntimeHost` when no host is injected (`sdk/packages/core/src/hub/server/hub-server-transport.ts:262-282`), so the default loop executes in the hub process. `SpokeRecord` is defined in `sdk/packages/shared/src/hub.ts`, but a search across the pinned hub app, core hub, and shared source found only its declaration and a containing schema field; no runtime producer or consumer was identified. Treat Cline Hub as supervisor-hosted local execution at this pin, not as evidence of detached spoke workers or reconnect-safe worker ownership. The public doc remains useful as a desired topology description only.

## Source layout

| Area | Source paths | Responsibility |
|---|---|---|
| Product surfaces | apps/vscode, apps/cli, apps/cline-hub, apps/examples/desktop-app | VS Code extension, CLI, Hub client, and example desktop app. JetBrains is not an inspected source surface at this pin. |
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
7. Hub clients can detach and reconnect to an owned spoke session. Although Agenda storage and backend commands exist, the pinned Hub transport explicitly disables the agent-facing TODO tool, automation pump, Agenda UI, and spec watchers while their UX is reworked; do not infer unattended task scheduling from the storage schema.

The September 2026 v4.1.21 release notes describe concurrent subagent tool calls within a step and recovery when long replies from local models reach output limits; those are release facts for that version, not universal guarantees for every provider/model.

The separately versioned Desktop v0.0.37 notes add SSH remotes, worktrees, PR status, and parallel subagents to its onboarding summary. These are product-surface changes and do not change the scope or trust boundary of HorizonCode's own SSH/Git profile.

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

This is a durable task queue/automation model, but it is disabled at the pinned Hub product surface described above. `agenda_tasks` has no dependency edge field. The Hub maps runtime `finishReason === completed` to Agenda task completion; that is a worker/session lifecycle result, not independent verification of software behavior. Attempt allocation calculates `MAX(attempt)+1` and inserts in separate store calls, so concurrent callers sharing a store need serialization or transactional allocation.

### Team persistence

The team store defines a schema version and tables for team event history, runtime snapshots, task rows, runs, outcomes and outcome fragments. Unlike Agenda, TeamTask has `dependsOn` / `depends_on_json` edges. This is a dependency-aware coordination graph, but it does not establish a general spec-to-acceptance DAG whose downstream tasks unlock only through an independent verifier. Source: [TeamTask type](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/shared/src/team/types.ts), [SQLite team store](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/services/storage/sqlite-team-store.ts).

## Hub/spoke and recovery flow

1. The hub daemon is discovered or started as a singleton; the design uses lock records for owner discovery.
2. Clients register over WebSocket and advertise operations they can perform, such as file editing, shell access or diff display.
3. The hub creates/attaches the session and assigns a spoke worker.
4. The spoke runs the agent loop and sends events to the hub; the hub routes them to interested clients and stores session/task state.
5. A client disconnect does not own the worker lifetime. It can reconnect and observe/steer if its capabilities allow.
6. In principle, the Hub/Agenda design separates worker lifetime from foreground clients; at this pin the Agenda automation pump and UI are disabled, so this path is not active through the inspected Hub transport. Client disconnect behavior does not establish recovery after Hub/process failure.

The boundary “clients participate, spokes execute, hub coordinates” is a useful multi-surface reference. It also introduces daemon discovery, leases, event replay, transport authentication, duplicate-worker prevention and migrations that must be tested as system behavior.

## Tool, permission, and extension flow

- Built-in and contributed tools share typed contracts from shared.
- Core controls tool availability and user approvals; host capabilities and runtime mode affect which actions can be offered.
- Provider handlers are isolated behind a gateway so agent-loop code is not tied to each vendor protocol.
- Plugins and agent extensions register tools/skills through declared extension contracts.
- Team/subagent runtime carries delegated tasks and tool/activity events; configured agents can use distinct system prompts, models and tools.

Current source organization intentionally separates loop, Node-specific effects and tool definitions. The class named `SubprocessSandbox` starts a Node child with IPC and inherited `process.env`; this is process separation/lifecycle handling, not demonstrated OS filesystem, network, or syscall confinement. Do not interpret a UI approval prompt or subprocess boundary as enforcement by the OS sandbox; inspect the active tool/runtime backend.

The inspected web-fetch executor accepts HTTP(S), uses native `fetch` with redirects followed by default, and notes that its configured `maxRedirects` is not enforced in that mode. The reviewed path shows no per-hop DNS/IP authorization or private-address rejection. Treat this as an SSRF review gap requiring host-level-control verification, not a proven exploit. Limiting response size does not authorize the destination.

The SDK's “browser-compatible” description means the loop package avoids owning Node session storage and built-in filesystem/shell tools; it does not mean the loop itself implements browser automation. Browser services belong to the product/runtime surface.

## Code understanding, testing, review, and delivery

- Code understanding is supported by workspace browsing, search, editor context and tools. Serena-like semantic LSP intelligence is not inherent in every Cline surface; verify which client/runtime supplies it.
- Testing/debugging is the same tool-feedback loop as implementation: command output is fed back to the agent; independent acceptance is still an external evaluator's responsibility.
- Session/diff review is visible in editor and hub experiences; the team store records task/run outcomes.
- PR workflow integrates with Git/GitHub-oriented tools and development clients, but agenda task completion and PR merge are different state machines. PR creation, review response and merge are external effects that need durable idempotency/authorization in an autonomous controller.

## Strengths, limitations, and HorizonCode lessons

**Useful patterns:** reusable loop package; separate host/core layer; rich hub/spoke deployment; manifest-based session recovery; SQLite agenda schema with claim leases/revision approval and concurrency limits; Team dependency edges plus event/snapshot/task/run/outcome tables; SDK surfaces shared by multiple clients.

**Limits:** scheduled status does not prove successful software behavior; Agenda is currently disabled in the inspected Hub transport; Team has dependency edges but neither task surface establishes verifier-gated acceptance; session persistence and task persistence are separate stores that require a reconciliation contract; hub/spoke adds distributed-state and identity boundaries. Configured child agents may run tools autonomously without inheriting the parent's interactive approval behavior, so a controller must explicitly cap effective child authority.

**HorizonCode lessons:** separate the client UI from worker lifecycle; use task revisions and approvals to invalidate stale plans; persist every attempt and lease; do not represent unavailable peer internals as progress; tie successful dependencies to verifier evidence; keep external-agent tasks in HorizonCode even if a Cline-like SDK or hub is used.

## Coverage and source audit (2026-09-29)

The pinned tree has 4,116 tracked paths: 2,678 under `apps/`, 1,067 under `sdk/`,
160 under `docs/`, and 45 under `evals/`; it has no tracked build/vendor/node_modules/
dist paths. `evals/cline-bench` is an unmaterialized submodule, 164 binary asset
candidates were inventoried, and 10 generated-named files were found (six are active
provider/model catalog data). The audit inspected subsystem entry points and relevant
schemas/tests but did not read every file or run Cline tests.

The release notes also describe concurrent subagent calls and local-model truncated
output recovery, but those are release-specific behaviors. The inspected recovery path
is one compact-and-retry for a context/truncation case, preserves partial output, and
does not replay a turn that already produced tools. Team subagent outcomes and reviews
are collaboration state, not an independent code verifier. Spawned agents have their
own timeout/cancellation behavior, and configured child tools can run autonomously;
HorizonCode should enforce a derived child authority ceiling at every effect.

Additional pinned paths: [Hub transport](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/hub/server/hub-server-transport.ts),
[team task contract](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/shared/src/team/types.ts),
[configured-agent tool](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/extensions/tools/configured-agent-tool.ts),
[spawn-agent tool](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/extensions/tools/spawn-agent-tool.ts),
[web fetch](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/extensions/tools/executors/web-fetch.ts).

## Primary references

- [Cline v4.1.21 release and changes](https://github.com/cline/cline/releases)
- [SDK packages](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/overview.mdx)
- [Hub-spoke architecture](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/architecture/hub-spoke.mdx)
- [Session manifest](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/session/models/session-manifest.ts)
- [Agenda task schema](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/tasks/store/task-schema.ts)
- [Team store schema](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/services/storage/sqlite-team-store.ts)
- [Hub transport / Agenda disablement and completion mapping](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/hub/server/hub-server-transport.ts)
- [Subprocess boundary](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/runtime/tools/subprocess-sandbox.ts)
- [Web fetch executor](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/core/src/extensions/tools/executors/web-fetch.ts)

## 2026-09-29 exact-pin deep-dive and coverage

The source was fetched into a separate temporary checkout at the documented exact pin
`787ad1b077d8b697892dc3bfcd42e7c65b88789e` (v4.1.21); the existing local clone was
v4.1.20 at `254f40c4b592d1e662b84f2ba06fe45dca77cab3`. The v4.1.21 pin had 4,116 Git
paths, 4,105 materialized files, and 3,521 source/config candidates totaling 1,040,878
lines under the reviewer's extension filter. Sixteen code files were fully read, eight
partially read, and 3,497 candidates remained unread in full. The per-file ledger was
`/tmp/cline-v421-read-ledger.tsv` during this audit session; this is a scoped deep-dive,
not an exhaustive source read. Full reads covered `ClineCore.ts`, the session manifest,
Agenda and team stores/types, team and runtime spawn tools, MCP timeout/policy, the
session FTS search service, provider Go test, subagent UI row, and usage projection;
partial reads and exact ranges are in that ledger.

Additional source-verified observations:

- Team task `completed` is a collaboration status written by the worker, not
  independent acceptance. Team restart can reconstruct/requeue a teammate or mark it
  interrupted; the inspected runtime loader reads snapshots rather than replaying the
  event history. HorizonCode keeps Task PASS exclusively with current verifier evidence.
- The Team child tool surface and research-only `use_subagents` feature differ; do not
  assume every Cline subagent is read-only. The UI can show child status, tool activity,
  context usage, cost, and expandable result/error. HorizonCode should show these per
  Thread while preserving `actual | estimated | unknown` usage provenance.
- The FTS search index is derived and reconciled against session/message file
  revisions; it has bounded scan/candidate/text limits and suppresses deleted-session
  hits. Its reviewed query behavior does not provide exact phrase, selected-Thread, or
  date filters. HorizonCode's stronger complete-coverage/message-jump design remains
  appropriate; add source-version, tombstone-race, IME, and literal wildcard fixtures.
- v4.1.21 retries a token/context truncation once only when there was no tool activity,
  preserves partial output if retry fails, retries transient provider failures using
  the prepared request, and propagates local provider-catalog failures instead of
  silently returning an empty list. HorizonCode's `ARCH/08` already limits compaction
  retry to safe pre-effect cases; provider attempts must retain partial bytes/usage and
  must not replay side effects.
- MCP readiness has separate install/configure, credential, connection, timeout,
  disable, and restart states. HorizonCode's market/connect flow should keep these
  states distinct rather than equating installation with readiness.

No Cline tests or UI were run. Exact source path references and release-specific scope
remain pinned above; v4.1.20 observations must not be substituted for v4.1.21 behavior.

## Provider integration source map for HorizonCode

At the same pin, Cline's SDK identifies `sdk/packages/llms` as its provider/model
layer, with a typed provider registry, model catalog, gateway contracts, and
AI-SDK-backed handler creation. The focused source anchors are the pinned
[`@cline/llms README`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/llms/README.md),
[`providers/README.md`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/llms/src/providers/README.md),
[`ai-sdk.ts`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/llms/src/providers/ai-sdk.ts),
[`config.ts`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/llms/src/providers/config.ts),
[`builtins-runtime.ts`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/sdk/packages/llms/src/providers/builtins-runtime.ts),
and the pinned [`docs/sdk/model-providers.mdx`](https://github.com/cline/cline/blob/787ad1b077d8b697892dc3bfcd42e7c65b88789e/docs/sdk/model-providers.mdx).
The docs describe a broad provider gateway (including Anthropic, OpenAI, Google,
Bedrock, Mistral, OpenRouter, DeepSeek, and others), but this focused audit did not
read every provider-specific handler or establish exhaustive auth/setup coverage.

This is the starting pin for the new parity matrix, not evidence that HorizonCode
already supports those providers. AX-362 must enumerate every provider-specific file,
model mapping, auth path, and limitation from the pinned Cline and OpenCode trees.
AX-363 then monitors upstream revisions and prepares native HorizonCode code/fixture
updates. The Cline repository advertises Apache-2.0 at root, but an adapter file is
not cleared for copying until its exact path, package dependencies, notices, and any
subdirectory license have been checked at the pinned revision. Do not vendor the
AI-SDK runtime, generated catalog, or Cline client identity wholesale.
