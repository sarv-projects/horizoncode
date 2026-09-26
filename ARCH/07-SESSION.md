# 07 — Session Store

`CMP-session` is the persistence owner of the agentX binary. This document is the LLD for durable, event-sourced sessions: the append-only JSONL log that is the source of truth, the SQLite index derived from it, session lifecycle, parent/child linkage, input admission, context epochs, checkpoints, portability and replay, and the session-format migration chain.

## Purpose

- Make every session a durable, movable, replayable artifact — the product's "portable sessions" claim (`ARCH/01-VISION.md`; `REQ-SESS-001`, `REQ-SESS-002`).
- Guarantee that a crash mid-turn loses no committed step: the log is appended and flushed before the next phase proceeds (`REQ-LOOP-006`).
- Provide the substrate for long-horizon work — resumable task state, enforceable budgets, checkpoints and rewind (`REQ-HORIZON-001..003`, `REQ-SESS-003`).
- Serialize runs per session key while letting unrelated sessions run concurrently (`REQ-LOOP-002`).
- Keep one durable write path and one format discipline so replay stays deterministic across builds (`DEC-004`, `DEC-011`).

## Responsibilities

**Owns**

- The `Session` record and its lifecycle: `create` · `resume` · `list` · `fork` · `close`.
- The append-only `SessionEvent` log (JSONL) and its monotonic per-session `seq` discipline.
- The SQLite index derived from the log — session rows, model-visible message projection, input admission, context epoch, checkpoints, revert state, sub-agent catalog. Every table is rebuildable from logs.
- The per-key run coordinator: at most one active run per session key; wakeups coalesce; interrupts settle.
- The input-admission table and promotion order (steer drain, then the next queued turn).
- Context-epoch storage (baseline text + snapshot + baseline sequence), as produced by `CMP-context`.
- Checkpoint storage and rewind planning; snapshot file-tree references.
- Deterministic interrupted-turn repair on load and on fork.
- Session portability (a session directory is the artifact) and replay.
- Session-format versioning: an adjacent migration chain plus a build-static catalog.

**Never owns**

- Loop decisions, model calls, tool scheduling or execution (`CMP-runner`).
- Context assembly, selection and compaction (owned by `CMP-context`; this store persists the resulting events and epoch).
- Provider transports and retries (`CMP-provider`).
- Sub-agent scheduling, isolation or receipts (`CMP-orch`); this store only holds child sessions and their lineage.
- Permission evaluation (`CMP-guard`), secret custody (`CMP-secrets`), and the tamper-evident audit chain (`CMP-audit`).

## Interfaces

| Direction | Counterpart | Surface | Notes |
|---|---|---|---|
| in | `CMP-runner` | `admit(input)` · `loadForRunner(session, baselineSeq)` · `append(event)` · `contextEpoch.prepare/advance` · `failInterruptedTools(session)` | The runner is the only writer of turn/step/tool/model events. |
| in | `CMP-runner` (coordinator) | `resume(key)` · `wake(key)` · `interrupt(key)` · `active()` | One owner per session key (see "Per-key run coordinator"). |
| in | `CMP-context` | `compaction/stated` · `compacted` · `context/epoch` snapshot advance | Context decides; this store records and persists. |
| in | `CMP-orch` | `createChild(parent, meta)` · `subagent/catalog` facts | Child sessions are ordinary sessions with `parent_id`. |
| in | `CMP-guard` | approval/question outcome events | Decisions are recorded once and never inferred (`REQ-GUARD-001`). |
| in | `CMP-tools` | `tool/call` and `tool/result` recording before/after effects | A call is recorded durably before its side effects begin. |
| out | `CMP-acp`, `CMP-headless`, `CMP-tui` | `create/resume/list/fork/close`; projections `history`, `prompt-history`, `inbox`, `runs` | Surfaces are projections only (`REQ-PROTO-005`). |
| out | `CMP-audit` | Security-relevant session events mirrored to the audit chain | Separate store, never pruned with the event log (`REQ-AUDIT-001`). |

All surfaces and services read/write through the store; no module opens the JSONL files or the SQLite database directly (`ARCH/03` §4.4).

## Data / state model

### Session artifact (portable unit)

```
$AGENTX_HOME/sessions/<session-id>/
  header.json          # id, format_version, workspace_id, parent_id, created_at, lineage
  log.jsonl            # one SessionEvent per line; seq dense from 0
  checkpoints/         # checkpoint content refs (see below)
  artifacts/           # file-tree snapshot refs and tool output refs
```

Copying the directory moves the session; replaying it produces the same projections on any host that supports its `format_version`. A global `state.db` (SQLite) indexes all sessions for `list`/search and is always rebuildable by scanning headers and logs.

### `Session` record

| Field | Type | Notes |
|---|---|---|
| `id` | uuidv7 | opaque; minted by the store |
| `workspace_id` | text | resolved workspace identity; re-resolved before any resumed write |
| `parent_id` | text? | set for sub-agent/child sessions |
| `title` | text | derived or model-written; non-authoritative |
| `agent_binding` | text | native binding or external agent id |
| `model` | json | `{ id, provider, variant? }` actually used (`REQ-SESS-004`) |
| `mode` | text | interaction mode the session ran under (`REQ-SESS-004`) |
| `permission_snapshot` | json | the guard ruleset in force (`REQ-SESS-004`) |
| `status` | enum | `active` · `hibernated` · `archived` · `closed` |
| `retention_class` | enum | `interactive` · `job` · `ephemeral` |
| `format_version` | int | session-format version of the log |
| `created_at` / `last_active_at` | int (epoch ms) | UTC |

### `SessionEvent` (log row)

| Field | Type | Notes |
|---|---|---|
| `seq` | int | monotonic per session, dense from 0; replay order |
| `time` | int (epoch ms) | UTC |
| `type` | dotted string | see vocabulary below |
| `data` | json | lossless JSON; refs over payloads |
| `surfaceOp` | enum? | how a replaying surface folds the event (`append`/replacement) |
| `sourceEventSeqs` | int[]? | provenance for synthetic/projected events |

Representative vocabulary (additive evolution only):

| Family | Types |
|---|---|
| Session | `session/created` · `session/updated` · `session/closed` · `session/end-seed` |
| Turn / step | `turn/start` · `turn/end` · `step/start` · `step/end` |
| Model | `model/started` · `model/done` · `assistant/message` · `assistant/attempt` (`model.delta` is ephemeral and not persisted per delta) |
| Tools | `tool/call` · `tool/result` |
| Input | `input/admitted` · `input/promoted` · `input/spliced` |
| Context | `compaction/started` · `compaction/ended` · `context/epoch` |
| Checkpoints | `checkpoint/created` · `revert/staged` · `revert/committed` · `revert/cleared` |
| Delegation | `subagent/catalog` · `subagent/finished` |

### SQLite index tables

| Table | Key | Purpose |
|---|---|---|
| `session` | `id` | list/search; mirrors the header |
| `session_event` | `(session_id, seq)` unique | fast range reads; `type`, `time`, byte offset into the log |
| `session_message` | `id`; idx `(session_id, seq)` | decoded model-visible projection built from the log |
| `session_input` | `id`; partial unique on un-promoted `(session_id, delivery, admitted_seq)` | admission + promotion ordering |
| `session_context_epoch` | `session_id` | `baseline`, `snapshot`, `baseline_seq` |
| `session_checkpoint` | `id` | `scope`, `kind`, `content_ref`, `reconstructable`, `version` |
| `session_revert` | `session_id` | active staged rewind (`message_id`, `snapshot`, `files`, `diff`) |
| `subagent_catalog` | `(session_id, child_id)` | durable child facts inherited by forks |

Constraints mirror the reference discipline: `seq` is unique per session, the log is append-only, and message/input/context rows are projections — never authoritative.

### Context epoch

A single row per session: `baseline` (system-context generation text), `snapshot` (structured generator state), and `baseline_seq` (the log sequence the baseline was built at). `CMP-context` prepares or advances the epoch; this store validates that a compaction event at a seq greater than `baseline_seq` forces a rebuild rather than a silent reconcile.

### Checkpoint and snapshot integration

- `Checkpoint.scope` = `work` · `context` · `session`; `kind` records the producer.
- `reconstructable` distinguishes deterministically produced checkpoints from model-written ones.
- File trees are captured as start/end snapshots around each step; `step/end` carries the end snapshot and the changed-file list.
- Rewind is staged, not immediate: `revert/staged` plans the file-tree restoration back to a message boundary; `revert/committed` or `revert/cleared` finalizes. A newer write invalidates a staged snapshot.

## Lifecycle & flows

### 1. `create`

Resolve the workspace identity; mint a uuidv7; write `header.json`; append `session/created` with the model, mode and permission snapshot; initialize the context epoch; register the session in the index. No event is written without a durable flush before the call returns.

### 2. `resume`

Load the header; run interrupted-turn repair (below); rebuild any missing index rows by replaying the log from the last indexed seq; `contextEpoch.prepare` reconciles or replaces the snapshot; re-resolve the workspace identity before any write. An unresolvable root is a typed error plus re-point guidance — queued work is never replayed against a guessed path.

### 3. `list`

Query the index (`workspace_id`, `status`, `parent_id`, recency). Listing never touches a live session's lock; a hibernated or archived session lists from the index without loading its log.

### 4. `fork`

A fork is a durable child, not a prompt splice. Copy the inclusive event prefix through a chosen boundary, append a `session/end-seed` marker (`inherited: true`) recording the inherited cut, then append deterministic closer events for any open tail turn. The child records its `parent_id`, inherited event count and lineage in the header. `subagent/catalog` child facts before the final inherited cut belong to the parent; facts after it are appended to the child.

### 5. `close`

Append `session/closed`; refuse further admission; release any concurrency slot; allow replay and `resume` later. Closing a parent cascades to descendants' cascade policy but never rewrites their logs.

### 6. Input admission and promotion

- Admitted input is durably recorded with a `delivery` of `steer` (interrupt-level redirection, the next step boundary) or `queue` (the next turn).
- Admission is idempotent by input id: re-admitting the same id returns the stored record.
- Promotion at a boundary: **steer first** (all un-promoted steers with `admitted_seq ≤ cutoff`, in admitted order), then **one** queued turn. A promoted steer resets the step counter; queued promotion starts a fresh turn.
- Promotion is itself an event (`input/promoted`), so replay reconstructs exactly which inputs were consumed and when. Injected context (not user-facing) waits behind the same `next-step` boundary; it never interleaves mid-step (`REQ-LOOP-002`).

### 7. Per-key run coordinator

The coordinator serializes execution for each session key while allowing different keys to run concurrently (`REQ-LOOP-002`).

- `resume(key)` — start a drain if idle, or join the active drain.
- `wake(key)` — request a coalesced follow-up; repeated wakeups collapse to one.
- `interrupt(key)` — mark stopping, clear the pending wake, and cancel the active drain; idle interrupt is a no-op.
- A follow-up drain starts only after the current drain settles, and `pendingWake` is cleared at start so a late wake cannot double-run.
- Ownership is process-local in v1; a durable multi-node owner is future work (see Open questions).

### 8. Context epoch snapshots

The store persists, never computes. `prepare` distinguishes unchanged, replacement-ready and blocked outcomes; a replacement is written with a fresh `baseline_seq` equal to the latest log sequence, so the runner can load only entries at or after the baseline. Compaction insert events are the projection boundary; the log is never rewritten.

### 9. Checkpoint and rewind

Checkpoints are produced at step boundaries, before waits/approvals, and before compaction. Rewind to a prior turn boundary is `stage` → review → `commit`/`clear`; the staged plan restores file trees and records the diff, and it is surfaced before it is applied (`REQ-SESS-003`).

### 10. Deterministic interrupted-turn repair

On load or fork, if the log ends inside an open turn, repair appends synthetic closers that preserve every fully written event:

1. For each recorded tool call with no durable result, append an error `tool/result` with code `TOOL_NOT_STARTED` (never seen to start) or `TOOL_OUTCOME_UNKNOWN` (started, outcome not recorded). The model-visible text tells the agent to retry only if read-only/idempotent, else verify or ask.
2. Close the open step with `step/end`.
3. Close the turn with `turn/end` whose reason is `interrupted` (crash recovery) or `forked` (fork cut).

Synthetic events use the last real event's timestamp and continue `seq`, so repair is byte-deterministic for a given log (`REQ-SESS-002`).

### 11. Portability and replay

Replay folds the log with the same `surfaceOp` semantics used when it was written, producing identical message, prompt, inbox and run projections. Because deltas are not persisted, a replay reconstructs settled messages, not keystrokes; this is intentional. A session copied to another host replays if its `format_version` is supported.

### 12. Migration chain discipline

- The physical format advances one version at a time. Each adjacent migration declares `fromVersion`/`toVersion` (`to == from + 1`), a header transform, a streaming event stage, and a target-header validator.
- A **build-static catalog** compiles the chain at startup and refuses to build if a version is missing, duplicated, or newer than the current build. A log whose stored version is newer than the build is refused with a typed "unsupported" result, never partially decoded.
- Migrations are **streaming and pure**: they transform events in `seq` order, preserve the inherited cut, and validate target invariants (for example, a turn boundary may not cross an open step).
- A delivery-accepted marker records the format version a session was last admitted under, so downgrade and cross-build reads stay explicit.
- Replay validation runs against the current invariant set; a migration that cannot satisfy it refuses rather than emitting a lossy result.

## Failure modes

| Failure | Behavior |
|---|---|
| Crash mid-turn | Repair closes the tail deterministically; committed steps are untouched (`REQ-LOOP-006`). |
| Torn log write | The partial final line is discarded; `seq` density is re-verified before repair. |
| Index drift / missing rows | Rebuild affected rows from the log; the log is truth. |
| Two writers, one session | Coordinator admits one active drain; a second `resume` joins rather than forks state. |
| Un-promoted input after crash | Admission rows survive; promotion re-derives from the log at the next boundary. |
| Corrupt or unknown event type | Typed decode failure; the session loads as unsupported rather than silently skipping. |
| Stored format newer than build | Refused with an "unsupported version" result; no partial migration. |
| Workspace moved/renamed | Resume re-resolves identity; typed `NotFound` + re-point guidance, never a guessed path. |
| Rewind against a stale snapshot | Staged snapshot invalidated by a newer write; re-stage required. |
| Duplicate child catalog fact | Refused (conflicting `child_id`) rather than merged. |

## Configuration

| Setting | Owner | Default | Effect |
|---|---|---|---|
| `session.retention_class` | session | `interactive` | Hibernation/archive thresholds |
| `session.log.fsync` | session | flush per committed step | Durability vs throughput (`REQ-LOOP-006`) |
| `session.migrate.strict` | session | `true` | Refuse unknown/newer versions rather than best-effort |
| `context.compaction.keepTokens` / `buffer` | context | ~8k / ~20k | Projection boundary sizing (`REQ-CTX-002`) |
| `session.checkpoint.cadence` | session | step boundary | Checkpoint production points |
| `orch.max_depth` / `max_parallel` | orch | bounded | Child session admission (`REQ-ORCH-005`) |

Session-level configuration is layered (`defaults → user → workspace → agent profile → session`) and the effective model/mode/permission snapshot is persisted with the session (`REQ-SESS-004`).

## Requirements mapping

| Requirement | How this document satisfies it |
|---|---|
| `REQ-SESS-001` | Durable JSONL log + index; resume after restart. |
| `REQ-SESS-002` | Replay folds the log into identical projections; repair is deterministic. |
| `REQ-SESS-003` | Checkpoint storage and staged rewind to a turn boundary. |
| `REQ-SESS-004` | Model, mode and permission snapshot persisted on the session record. |
| `REQ-LOOP-002` | Input admission table + steer/queue promotion ordering. |
| `REQ-LOOP-006` | Every committed step is appended and flushed before the next phase. |
| `REQ-HORIZON-001` | Session resumable after an arbitrary gap with task state intact. |
| `REQ-HORIZON-002` | Log-projected task/todo state survives compaction and restart. |
| `REQ-HORIZON-003` | Per-session usage aggregates persisted for budget enforcement. |
| `REQ-ORCH-001` | Sub-agents are isolated child sessions, addressable by id. |
| `REQ-ORCH-002` | Child sessions may carry a worktree workspace reference. |
| `REQ-PROTO-001` | ACP session create/load/resume/list/close map to this lifecycle. |
| `REQ-PROTO-005` | All surfaces consume the same store projections. |
| `REQ-CTX-004` | Epoch + compaction events let the runner retry the same step after overflow. |
| `REQ-AUDIT-001` | Security-relevant events are mirrored to the audit chain. |
| `REQ-SEC-002` | Persisted tool output and external content are stored as data, never instructions. |

## Open questions

1. **Index split.** One global `state.db` versus a per-session SQLite beside the log. A per-session index improves portability of the artifact; a global index improves cross-session `list`/search. Proposal: global index, per-session log, with a defined rebuild path.
2. **Multi-node ownership.** The per-key coordinator is process-local in v1. A durable/clustered owner (lease + epoch) is deferred; the tie-break for two live owners is unresolved.
3. **Log compaction of checkpoints.** Whether long-lived sessions may prune superseded checkpoint content refs while keeping the log append-only, and which references are pinned by audit/receipts.
4. **Fork boundary model.** Whether forks are limited to turn boundaries or may cut mid-turn (with closer repair) by default; the model-visible wording differs and needs a product decision.
5. **Injected-context admission.** The exact classification rules for `next-step` injected context versus steered user input, and whether injected context is ever persisted as a user-visible message.
6. **Format-version policy for external agents.** Whether externally produced session logs may be imported and migrated, or only replayed read-only.
