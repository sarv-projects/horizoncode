# 26 — Core coding-agent source crosswalk

Reviewed 2026-09-28. This is the explicit read-through of the five core agent notes
the user named: [Claude Code](../research%20docs/claude.md),
[Codex](../research%20docs/codex.md), [OpenCode](../research%20docs/opencode.md),
[Cline](../research%20docs/cline.md), and [Aider](../research%20docs/aider.md).
Each note was read end to end for this crosswalk. Their pinned commits, upstream
links and coverage limits live in the notes. This document records a design
disposition, not a claim that every upstream file or every ARCH line was audited.
The task-facing [source trail](29-SOURCE-TRACEABILITY.md) now names the concrete
local entry points/tests and the pinned upstream files for the main patterns.
Read those files before adapting a pattern; a crosswalk row alone is insufficient.
Claude Code's internal implementation is not public, so its row rests on
documented behavior. No upstream code has been copied.

| Source and observed pattern | HorizonCode disposition | Exact design owner or gap |
|---|---|---|
| Claude Code: project instructions, skills and MCP tools load progressively | Adopt selective context and tool schema loading with provenance | `ARCH/09`, `ARCH/21`, `REQ-CTX-010`; implement `AX-332`. |
| Claude Code: auto-compaction, resumable sessions and file checkpoints | Preserve transcript and durable run records separately; distinguish file rewind from external-effect recovery | `ARCH/07`, `ARCH/19`, `ARCH/25`; effect journal `AX-311`. |
| Claude Code: focused subagents, background agents and teams | Keep focused worker contexts and user steering; only recorded peer events are visible | `ARCH/16`, `ARCH/25`, `REQ-HORIZON-009`; adapter `AX-318`. |
| Claude Code: settings, permissions and hooks | Keep typed effective settings and pre-effect policy; hooks cannot widen authority | `ARCH/18`, `ARCH/22`, `REQ-UI-010`. |
| Codex: Rust core plus app-server stable/experimental schemas | Keep one core and versioned client contracts; negotiate optional methods | `ARCH/03`, `ARCH/15`, `ARCH/21`; schema gate `ACC-P1-05`. |
| Codex: shared app-server client centralizes startup/lifecycle and keeps an in-process typed transport | Reuse the typed shared boundary for attached and supervised clients; retain bounded queues, durable owner events, and explicit gap/resnapshot instead of Codex's documented unbounded local consumer queue | `ARCH/31`, `REQ-HORIZON-013`, `DEC-063`, `AX-367`; exact `app-server-client/README.md` pin in `ARCH/29` `U-CX-APP-SERVER`. |
| Codex: JSONL rollout and SQLite index; thread/turn/item separation | Separate canonical events from rebuildable projections and run/task/attempt identity | `ARCH/07`, `ARCH/25`, `AX-309`. |
| Codex: persisted parent/child thread graph, lifecycle and budget controls | Track external IDs and usage, but require task DAG and independent evidence for completion | `ARCH/16`, `ARCH/25`, `AX-310`, `AX-318`. |
| Codex: local agent message board and separate remote board client, with scoped membership, channels/posts, paging/search, idempotent post IDs, body/output caps, and best-effort live notices | Adopt a bounded Run-scoped mailbox through the existing Run event stream and recipient Thread inbox; keep task truth separate, expose explicit per-recipient receipts, and do not assume delivery/read/understanding or a remote service implementation from the public client crate | `ARCH/16`, `ARCH/25`, `ARCH/32`, `REQ-HORIZON-031`, `DEC-064`, `research docs/codex.md`, `ARCH/29` `U-CX-MESSAGE-BOARD`; Horizon addition is a proposed synthesis, not copied code. |
| Codex Goals: persistent thread-scoped objective, `/goal` lifecycle commands, event-driven idle-boundary continuation, queued-input checks, budget stop, and suppression after no-tool-call continuation | Reuse explicit goal/status/budget visibility and safe-boundary scheduling; bind HorizonCode activation to exact approved digests, preserve a task graph/evidence gate, and let the deterministic controller—not prompt text—own stop state | [Current Goals guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex), `research docs/codex.md`, `ARCH/25`, `ARCH/27`, `DEC-039`, `DEC-042`, `DEC-047`, `DEC-048`, `AX-337`. |
| Codex: review command, diff and Git/worktree workflow | Add exact-revision review and governed PR lifecycle | `ARCH/25`, `REQ-DELIVERY-001`, `AX-326`. |
| OpenCode: models.dev provider metadata separated from connectors | Use a pinned, curated catalog as data; probe real route capabilities and cost provenance | `ARCH/11`, `REQ-PROV-006`, `AX-324`, `AX-327`. |
| OpenCode: typed message parts, input admission sequence and context epoch | Preserve queued/steered input order and epoch-bound prompt/tool snapshots; task truth remains separate | `ARCH/07`, `ARCH/09`, `ARCH/25`. |
| OpenCode TUI at `083ed266e058dc3d2d1b377ff5540859d79de110`: sparse home composer; typed active transcript and tool states; child-session navigation; blocking permission/question prompts; recent-message hydration window; theme/preferences; SSE reconnect loop | Use explicit idle/active/waiting/error states and actionable tool/approval context; keep canonical search beyond the visible transcript window; replay/resnapshot before a reattached client trusts state. Do not copy OpenCode's process-lifetime “always allow” semantics or mistake Session/UI completion for task acceptance. This is a source trace only, not a launched TUI usability result. | `ARCH/06`, `ARCH/25`, `ARCH/31`, `research docs/opencode.md`, `ARCH/29` `U-OC-TUI`; no source code copied. |
| OpenCode at `083ed266e058dc3d2d1b377ff5540859d79de110`: parent-linked durable Sessions; Task tool resumes a child by Session ID; process-local background registry; V2 separates admitted input from visible history and replays durable aggregate events | Reuse durable conversation/inbox/replay patterns, but do not identify HorizonCode Task with peer Session or mistake local job state for restart recovery. HorizonCode's target `ThreadId` defines the canonical conversation identity; external Session IDs are adapter bindings and `WorkerExecution` records live incarnations | `ARCH/07`, `ARCH/16`, `ARCH/25`, `REQ-HORIZON-028`, `AX-359`, `AX-379`, `research docs/opencode.md`. |
| OpenCode: dynamic permission-filtered tool registry and child sessions | Permission-filter before materialization; child completion does not pass parent task | `ARCH/10`, `ARCH/16`, `REQ-TOOL-003`. |
| OpenCode: local retry/doom-loop guard | Use its signal as one attempt fingerprint; persistent controller changes strategy across sessions | `ARCH/25`, `AX-310`. |
| MiMo-Code: OpenCode-derived memory, goal, task/actor workflows and response-flood recovery | Study the fork-specific deltas without counting it as an independent OpenCode peer; use bounded whole-response admission and durable recovery evidence | `ARCH/08`, `ARCH/25`, `research docs/mimo-code.md`, `research docs/tests.md`, `AX-338`, `AX-345`. |
| Cline: hub owns workers while clients detach/reconnect | Require supervised detached controller, authenticated attach, cursor replay and truthful last-seen status | `REQ-HORIZON-011`, `ARCH/25`, `AX-331`. |
| Cline: agenda task/revision/run/claim/lease schema and automation caps | Adopt task revisions, claim fencing and bounded admission; unlock dependencies only after verification | `ARCH/16`, `ARCH/25`, `AX-309..313`. |
| Cline: distinct team events, snapshots, outcomes and manifests | Keep event, projection and artifact ownership explicit; reconcile cross-stream mismatch | `ARCH/25` schema and cross-stream rule. |
| Cline: local-model output-limit recovery and concurrent subagents | Probe actual model/template limits; parallelism remains bounded by leases and parent budget | `REQ-PROV-006`, `ARCH/16`, `AX-327`. |
| DeepSeek-Reasonix: explicit plan-first workflow, restricted research tools, structured plan evidence/assumptions/risks/acceptance, and user approval | Offer plan-first as a selectable workflow for ambiguous/high-impact requests; enforce read-only research at tool/policy boundaries; block execution if plan validation/approval fails; do not insert a planner on every task | `ARCH/02` intent/spec requirements, `ARCH/16`, `ARCH/22`, `ARCH/25`, `REQ-ORCH-006`, `AX-317`, `AX-336`. |
| DeepSeek-Reasonix: immutable prompt prefix, bounded provider context, transcript JSONL with BM25 retrieval, MCP session recreation after 404 | Keep canonical local history and compacted prompt projection separate; carry source refs and retrieval probes; retry MCP discovery only when effect completion is known, otherwise reconcile before replay | `ARCH/07`, `ARCH/09`, `ARCH/19`, `ARCH/21`, `ARCH/25`, `AX-311`, `AX-320`, `AX-332`. |
| DeepSeek-Reasonix: VS Code ACP extension supplies editor context, approval and session/model UI | Implement editor integration through negotiated ACP capabilities and explicit context provenance; editor contribution cannot grant policy authority or turn activity into completion evidence | `ARCH/06`, `ARCH/15`, `ARCH/18`, `ARCH/23`, `AX-112`, `AX-323`. |
| Aider: small, graph-ranked Tree-sitter repository map | Keep a task-relevant map with source revision, symbol provenance and direct-read fallback | `ARCH/09`, `ARCH/25`, `REQ-REPO-001`, `AX-320`. |
| Aider: model-specific edit formats and bounded repair feedback | Offer conformance-gated parser paths where useful; preflight all edits and keep a durable retry budget | `REQ-PROV-007`, `ARCH/25`, `AX-333`. |
| Aider: optional automatic lint/tests and Git commits/undo | Use fast diagnostics for repair, then independent revision-bound evidence; Git is a code checkpoint | `ARCH/25`, `ARCH/23`, `AX-333`. |

## Cross-source conclusions

The useful common core is a bounded model/tool loop, repository retrieval,
permission-aware tools, inspectable session history and Git-aware changes.
HorizonCode's proposed addition is a controller that persists intent, tasks,
attempts, effects, budget and independent evidence outside the worker session.
That addition is a design hypothesis until `ACC-H1-01..10` and the same-model,
same-budget comparison in `AX-330` are executed.

The five core notes do **not** establish an exhaustive map of every upstream schema,
UI screen, provider adapter or platform branch. They also do not prove that
HorizonCode already implements the proposed controller. The source/license
ledger in `ARCH/05` remains the gate before any adapted code or dependency.

## Session, task, and process identity finding

These are distinct upstream choices, not a universal naming convention:

| System | Durable conversation | Delegation relation | What survives process loss (evidence reviewed) |
|---|---|---|---|
| OpenCode at the pinned 2026-09-28 revision | `Session`, with optional `parentID` | Task tool's `task_id` resumes the child Session; new delegation creates a parent-linked Session | Session event/input data is durable in V2 design; active execution/background-job registry is process-local. V2 explicitly leaves restart ownership/continuation recovery open. |
| Codex current public source/docs | `Thread`, turns/items and parent-child thread graph | Child thread/agent lifecycle is managed through ThreadManager/app-server surfaces | Thread history and Goal metadata persist, and Goals resume/continue subject to controller/runtime policy. This is still not a general verified task DAG. |
| Cline public SDK/source map | Session plus separate team/task records in some flows | Team tasks and session children are related but have different persistence/usage semantics | Depends on selected session/team feature; do not collapse its agenda task, task run, team task, and session into one ID. |
| HorizonCode target | `ThreadId` is the durable conversation identity; `CMP-session` remains the persistence component/crate name | Run → Task DAG → Attempt → one or more Threads; the Thread parent/child tree is separate from the Task DAG | Durable run/attempt and Thread behavior are target contracts with partial foundations; a durable process incarnation is currently absent and proposed by `REQ-HORIZON-028`/`AX-359`. The schema/API migration is `AX-379`. |

**Disposition.** Keep one HorizonCode persisted conversation ID. The target
`Session` contract already defines the required Thread-like concept (durable
history, turns/items, context epochs, input inbox and parent-child lineage); the
current implementation has only the foundations called out in `ARCH/29`. Renaming
it or adding a second `Thread` table would create two IDs for one fact without
providing additional recovery. Keep Task DAG edges separate from the conversation tree. Add
`WorkerExecution` for a specific process/adapter incarnation under an Attempt, with
durable launch intent, fence, observation and terminal/unknown outcome. A process
exit, Session close, ACP `session/close`, or child receipt remains an execution or
conversation event, never independent Task PASS evidence.

This recommendation is falsifiable: acceptance must kill/restart the controller
around launch, heartbeat, client disconnect, peer completion and effect settlement;
prove that one durable Session/Attempt can be reconciled without duplicate writes;
prove unknown peer outcomes remain blocked; and prove the integrated Task still
requires revision-bound independent evidence. This review does not establish those
behaviors as implemented.

**Claims not carried forward without evidence.** OpenCode's `task_id` behaving as a
child Session ID and its process-local background-job status are confirmed at the
pinned source revision. At the Task-tool lookup site, a missing ID leads to a fresh
child; the visible lookup does not prove parent ownership, while the surrounding
authorization path has not been fully traced. HorizonCode must verify the full peer
binding before resume. The detailed paths are in `research docs/opencode.md`.
Codex's app-server/ThreadManager and persistent ThreadGoal schema are source-backed.
Current `ThreadManager` also imports a local agent-message-board implementation, so
the feature exists as a source subsystem. This review did not trace its full API or
validate the earlier claim of remote subscriptions/SSE; that transport detail remains
unconfirmed here. AgentProfile, input receipts, context epochs, event-envelope
fields, and a task DAG are already represented in HorizonCode's target docs; they
must not be mislabeled as absent merely because implementation remains incomplete.

## Findings from this read-through

- `F-26`: `ARCH/25` said every mutating method checks an epoch and sequence,
  while its interface sketch omitted those arguments. `MutationGuard` and
  `RecoveryGuard` now make that precondition visible.
- `F-27`: client detachment was implied in `DEC-030` without an attach/replay
  contract. `REQ-HORIZON-011` and `ARCH/25` define it.
- `F-28`: `ARCH/21` discovered full MCP tool lists but did not bound model
  schema injection. `REQ-CTX-010` pins a selected schema set per model step.
- `F-29`: local models were capability-probed for transport/tool calls but
  had no explicit edit-parser and diagnostics contract. `REQ-PROV-007`
  defines a measured optional route.
