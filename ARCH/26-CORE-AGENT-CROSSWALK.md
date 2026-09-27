# 26 — Core coding-agent source crosswalk

Reviewed 2026-09-27. This is the explicit read-through of the five core agent notes
the user named: [Claude Code](../research%20docs/claude.md),
[Codex](../research%20docs/codex.md), [OpenCode](../research%20docs/opencode.md),
[Cline](../research%20docs/cline.md), and [Aider](../research%20docs/aider.md).
Each note was read end to end for this crosswalk. Their pinned commits, upstream
links and coverage limits live in the notes. This document records a design
disposition, not a claim that every upstream file or every ARCH line was audited.
Claude Code's internal implementation is not public, so its row rests on
documented behavior. No upstream code has been copied.

| Source and observed pattern | HorizonCode disposition | Exact design owner or gap |
|---|---|---|
| Claude Code: project instructions, skills and MCP tools load progressively | Adopt selective context and tool schema loading with provenance | `ARCH/09`, `ARCH/21`, `REQ-CTX-010`; implement `AX-332`. |
| Claude Code: auto-compaction, resumable sessions and file checkpoints | Preserve transcript and durable run records separately; distinguish file rewind from external-effect recovery | `ARCH/07`, `ARCH/19`, `ARCH/25`; effect journal `AX-311`. |
| Claude Code: focused subagents, background agents and teams | Keep focused worker contexts and user steering; only recorded peer events are visible | `ARCH/16`, `ARCH/25`, `REQ-HORIZON-009`; adapter `AX-318`. |
| Claude Code: settings, permissions and hooks | Keep typed effective settings and pre-effect policy; hooks cannot widen authority | `ARCH/18`, `ARCH/22`, `REQ-UI-010`. |
| Codex: Rust core plus app-server stable/experimental schemas | Keep one core and versioned client contracts; negotiate optional methods | `ARCH/03`, `ARCH/15`, `ARCH/21`; schema gate `ACC-P1-05`. |
| Codex: JSONL rollout and SQLite index; thread/turn/item separation | Separate canonical events from rebuildable projections and run/task/attempt identity | `ARCH/07`, `ARCH/25`, `AX-309`. |
| Codex: persisted parent/child thread graph, lifecycle and budget controls | Track external IDs and usage, but require task DAG and independent evidence for completion | `ARCH/16`, `ARCH/25`, `AX-310`, `AX-318`. |
| Codex Goals: persistent thread-scoped objective, `/goal` lifecycle commands, event-driven idle-boundary continuation, queued-input checks, budget stop, and suppression after no-tool-call continuation | Reuse explicit goal/status/budget visibility and safe-boundary scheduling; bind HorizonCode activation to exact approved digests, preserve a task graph/evidence gate, and let the deterministic controller—not prompt text—own stop state | [Current Goals guide](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex), `research docs/codex.md`, `ARCH/25`, `ARCH/27`, `DEC-039`, `DEC-042`, `DEC-047`, `DEC-048`, `AX-337`. |
| Codex: review command, diff and Git/worktree workflow | Add exact-revision review and governed PR lifecycle | `ARCH/25`, `REQ-DELIVERY-001`, `AX-326`. |
| OpenCode: models.dev provider metadata separated from connectors | Use a pinned, curated catalog as data; probe real route capabilities and cost provenance | `ARCH/11`, `REQ-PROV-006`, `AX-324`, `AX-327`. |
| OpenCode: typed message parts, input admission sequence and context epoch | Preserve queued/steered input order and epoch-bound prompt/tool snapshots; task truth remains separate | `ARCH/07`, `ARCH/09`, `ARCH/25`. |
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
