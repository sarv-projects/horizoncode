# 07 — Session Store

`CMP-session` owns logical session lifecycle, canonical event references and replay. `CMP-artifact` owns immutable bytes and their safe lifetime (`ARCH/28`). This document is the LLD for durable, event-sourced sessions: the append-only, segmented event stream that is the source of truth, the SQLite index derived from it, parent/child linkage, input admission, context epochs, checkpoints, portability and replay, and the session-format migration chain.

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
- Bounded immutable log segments, per-event integrity links, the committed-head record, byte reservations, and bounded streaming replay (`REQ-SESS-006`, `REQ-HORIZON-027`).
- Session artifact namespaces and `BlobRef`s in canonical events; request `CMP-artifact` for payload staging, integrity checks, bounded reads, import/export and GC. The session log contains bounded references only.
- The SQLite index derived from the log — session rows, model-visible message projection, input admission, context epoch, checkpoints, revert state, sub-agent catalog. Every table is rebuildable from logs.
- The per-session turn coordinator: at most one active turn drain per session key within the store's ownership scope; wakeups coalesce; interrupts settle. It is not the lease authority for a detached multi-process run; `CMP-orch` owns the run lease and fencing epoch (`ARCH/25`).
- The input-admission table and promotion order (steer drain, then the next queued turn).
- Context-epoch storage (baseline text + snapshot + baseline sequence), as produced by `CMP-context`.
- Checkpoint storage and rewind planning; snapshot file-tree references.
- Explicit, idempotent interrupted-turn recovery after byte preservation and effect reconciliation; listing and read-only replay never repair canonical storage.
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
| in/out | `CMP-artifact` | stage/verify/read session-scoped payloads; append owner reference through the session log | Artifact bytes are durably published before their `BlobRef` event; a cross-store write lease is held until the event outcome is reconciled (`ARCH/28`). |
| out | `CMP-acp`, `CMP-headless`, `CMP-tui` | `create/resume/list/fork/close`; projections `history`, `prompt-history`, `inbox`, `runs` | Surfaces are projections only (`REQ-PROTO-005`). |
| out | `CMP-audit` | Security-relevant session events mirrored to the audit chain | Separate store, never pruned with the event log (`REQ-AUDIT-001`). |

All surfaces and services read/write through the store; no module opens the JSONL files or the SQLite database directly (`ARCH/03` §4.4).

## Data / state model

### Session artifact (portable unit)

```
$HORIZONCODE_HOME/sessions/<session-id>/
  header.json          # id, format_version, workspace_id, parent_id, created_at, lineage
  events/
    head.json          # last durably acknowledged seq + event digest; canonical commit watermark
    segment-<first-seq>.open   # bounded active segment; never exceeds configured ceiling
    segment-<first-seq>.sealed # immutable, digest-linked, sequence-contiguous segment
    seals/<first-seq>.json     # bounded seal records for sealed segments
  checkpoints/         # checkpoint content refs (see below)
  artifacts/           # file-tree snapshot refs and tool output refs
  blobs/sha256/        # immutable per-session payload objects, named by digest
  manifest.json        # rebuildable format/index + sorted segment and artifact refs
```

Copying the directory moves the session; replaying it produces the same projections on any host that supports its `format_version`, event/segment schema, and every referenced blob schema. A global `state.db` (SQLite) indexes all sessions for `list`/search and is always rebuildable by streaming headers and segments. `head.json` is the committed high-water mark and must match the last complete event digest; the ordered segment bytes plus the head are canonical. Seals detect segment truncation/reorder and bind each segment to its predecessor. `manifest.json`, SQLite, and cached offsets are rebuildable accelerators and cannot authorize skipping data or lowering the committed head. Directory enumeration/read errors fail closed.

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
| `status` | enum | `active` · `hibernated` · `archived` · `closed` · `recovery_pending` · `integrity_blocked` |
| `retention_class` | enum | `interactive` · `job` · `ephemeral` |
| `format_version` | int | session-format version of the log |
| `created_at` / `last_active_at` | int (epoch ms) | UTC |

`SessionListResult = {items: SessionListEntry[], enumeration_complete,
issues[]}`. Each entry has a stable session ID, last known projection, and integrity
state `AVAILABLE | CORRUPT | UNSUPPORTED | UNREADABLE | RECOVERY_PENDING | UNKNOWN`.
A directory/iterator error sets `enumeration_complete=false` with a typed issue; it is
never represented as an empty successful list. An indexed session whose log cannot
be read remains visible as an unavailable entry. A missing/stale index returns an
explicit stale/rebuild-needed state and does not cause the listing call to recover or
rewrite canonical logs (`REQ-SESS-006`, `DEC-056`).

### `SessionEvent` (log row)

| Field | Type | Notes |
|---|---|---|
| `seq` | int | monotonic per session, dense from 0; replay order |
| `time` | int (epoch ms) | UTC |
| `type` | dotted string | see vocabulary below |
| `data` | bounded json | lossless envelope; large/binary payloads are `BlobRef`s, never inline base64 or unbounded text |
| `previous_digest` / `event_digest` | digest | storage envelope binds canonical event bytes and preceding committed event; not an authenticity signature (the audit chain has that separate responsibility) |
| `surfaceOp` | enum? | how a replaying surface folds the event (`append`/replacement) |
| `sourceEventSeqs` | int[]? | provenance for synthetic/projected events |

`LogSegmentSeal = {owner_kind, owner_id, segment_id, first_seq, last_seq,
event_count, encoded_bytes, first_event_digest, last_event_digest,
previous_segment_digest, segment_digest, schema_version}`. Each event digest is
`SHA-256(domain_separator || previous_digest || canonical_event_bytes)` under a
versioned canonical encoding; the digest field itself is excluded from the hashed
bytes. Hashes detect corruption/reordering but do not authenticate a writer (that is
the audit/authority boundary). `CommittedLogHead =
{owner_kind, owner_id, generation, committed_seq, committed_event_digest,
committed_segment_digest, durability_profile, updated_at}`. These shared shapes also
cover run logs (`ARCH/25`). IDs and ranges are immutable after seal. There is at most
one active segment per session writer lease; all record, segment, and total-session
limits are finite values from the effective config. A segment is sealed before a
successor is created. A seal/manifest is not allowed to claim a later head than the
durable commit record.

### Append, rotation, and replay contract

1. Before accepting an input or dispatching a model/tool/effect whose outcome needs a
   canonical event, reserve enough bytes in the session/run storage ledger for the
   bounded event envelope, terminal/reconciliation record, and the applicable
   control reserve. Large payload bytes use `CMP-artifact` separately. Refuse or
   safely wait before dispatch if either reservation cannot be made.
2. Under a cross-process per-session writer lease/fencing epoch, encode one bounded record with the next dense
   sequence, previous digest, and canonical event digest. Append only to the active
   segment. Flush/sync according to the selected durability profile; update the
   committed head atomically and sync the containing directory before acknowledging
   the step as committed. Path opens use no-follow/exclusive semantics; segment and
   head replacement are confined to the session root and the parent directory is
   synced as required by the backend. Every append checks the current fencing epoch;
   a stale process cannot write after recovery. The run-durable profile cannot disable
   required syncs.
3. When the next record would cross a segment ceiling, sync and seal the current
   segment, persist its seal, create the next segment atomically, and then append.
   Rotation changes physical layout only; it does not renumber or delete history.
4. Replay first validates the committed head and all segment ranges/digests in order,
   then decodes one bounded record at a time and updates projections in bounded
   batches. A projection checkpoint can accelerate replay only when its source head
   digest is verified. Do not `read_to_string` a whole session or build an unbounded
   `Vec<Event>` as the general load path; UI history paging is separate from prompt
   context assembly.
5. Bytes after the committed head are an uncommitted tail. Preserve their exact bytes
   and digest in quarantine/staging and reconcile event/operation IDs and effect
   receipts before continuing; do not fold them into normal replay or truncate them
   in place. A safe resume appends into a new generation/segment only after the old
   tail is retained and the next sequence is reconciled.
   Missing/corrupt bytes at or before the committed head produce typed corruption,
   `INSUFFICIENT_EVIDENCE`, and no run completion. A new segment can be created only
   after tail reconciliation establishes a safe next sequence.
6. Event-byte quota pressure fences new generation/effect dispatch before the
   reserved control/recovery capacity is consumed. Settle/cancel in-flight work,
   persist the reason within the reserve, and expose `WAITING` or `STOPPED`, current
   and reserved bytes, and last committed sequence. Never compact or delete canonical
   events to make room. Retention/export is a separate, authorized post-terminal
   lifecycle with exact digest and evidence-owner checks (`ARCH/28`).

The current implementation's single-file/full-read behavior is recorded in
`ARCH/24` `F-61`; it does not meet this proposed contract.

### Read-only and recovery API boundary

`read_only`, status, list, export inspection, and index verification are pure with
respect to canonical storage: they do not truncate bytes, append synthetic events,
advance the committed head, or run repair. A listing whose projection is missing or
stale may report that state and offer recovery; it does not silently call `load` if
that path can write. The explicit `recover(session_id, expected_head, recovery_id)`
operation runs under a recovery lease, hashes and preserves the source generation,
reconciles its committed head and pending effect IDs, then either writes a new
generation with deterministic closers or returns typed `UNKNOWN`/
`INSUFFICIENT_EVIDENCE`. Replaying the same recovery ID/payload is idempotent; a
changed payload conflicts. `read_only` remains byte-identical even when the last
record is incomplete. This contract is `DEC-056`; the current mutation on read path
is `F-62`.

### Blob reference and commit protocol

`BlobRef = { blob_id, sha256, media_type, encoded_bytes, schema_version }` is the only payload representation in a committed session event. Inline event data has a hard serialized-byte limit; per-blob, aggregate-session, decoded-pixel/decompression, and request-context limits are separately enforced from effective user/policy settings. Defaults and supported media types belong to the shipped config schema, not hidden constants; policy may lower but never raise the compiled safety ceiling. A `session_blob` projection indexes `blob_id`, digest, size, media type, event/checkpoint references, verification state and retention state. Blobs are session-scoped (no cross-session dedup) to keep ownership and deletion unambiguous. `blob_id` is immutable within a generation; references bind both ID and digest so a same-ID/different-content replay is a hard integrity error.

Ingest holds the per-session writer/quota lease and streams to an exclusively created, no-follow temporary file beneath that session's artifact root. It enforces the encoded-byte quota while streaming (before buffering/allocation), records the actual length, sniffs rather than trusts the declared media type, hashes the exact stored bytes, flushes the file, atomically publishes within the same filesystem to `blobs/sha256/<digest>`, and flushes the directory using the host's declared durability backend. If a digest-named object already exists, verify its bytes and metadata; never replace it blindly or follow a symlink. Only after the object is durably published may the writer append and flush the bounded event carrying its `BlobRef`. SQLite rows and the manifest follow as rebuildable projections. A crash before event commit can leave only an orphan object; GC may remove it only after a grace interval and a complete mark of canonical logs, retained generations, checkpoints, task evidence, retained export jobs and active leases. Refcounts alone are insufficient. If the filesystem cannot provide the configured atomic-publication and durability contract, refuse a requested durable run/session; a weaker profile is allowed only for explicitly labeled non-run interactive use and can never be presented as crash-durable.

Replay validates digest, byte length, schema and effective limits before any blob is supplied to the model, UI decoder, verifier, or exporter. Decoding is isolated and bounded by format-specific expansion, dimensions/pixels, recursion and time limits; a MIME label or file extension is never proof that bytes are safe. For image input, provider rendering requires a vision-capable selected route, a successful bounded decode/validation, egress authorization, and context/token budget admission; request-body encoding is ephemeral and does not rewrite the canonical artifact. Missing, corrupt, over-limit, unsupported-schema, or unsafe-media objects produce typed `ArtifactUnavailable`/`ArtifactRejected` records and visible placeholders; they must not become empty text, be silently dropped, or satisfy acceptance evidence. Renderers must not execute active content such as SVG/HTML. Export includes each referenced object and a digest manifest; import verifies all files before publishing the copied session. Any old format with inline payloads is migrated copy-on-write into a new immutable session generation with a parent-log digest, streaming to blobs and validating the complete replay/ref graph before an atomic generation-manifest switch. Never rewrite the original append-only log in place; retain the original generation until migration and retention checks complete (`REQ-SESS-005`).

An incomplete provider response uses `assistant/attempt` with
`{ attempt_id, logical_step_id, state: truncated | failed, finish_record,
partial_ref?, usage_ref?, created_at }`; no `assistant/message` event is emitted until
the full response is complete and validated. Replay preserves attempts for history and
cost but excludes their partial content from the model-visible conversation. A retry
is a new `attempt_id` under the same `logical_step_id`, and the durable recovery-depth
record prevents a second truncation retry after restart.

Representative vocabulary (additive evolution only):

| Family | Types |
|---|---|
| Session | `session/created` · `session/updated` · `session/closed` · `session/end-seed` |
| Turn / step | `turn/start` · `turn/end` · `step/start` · `step/end` |
| Model | `model/started` · `model/done` · `assistant/message` · `assistant/attempt` (`model.delta` is ephemeral and not persisted per delta; an attempt is not a completed conversational message) |
| Tools | `tool/call` · `tool/result` |
| Input | `input/admitted` · `input/promoted` · `input/spliced` |
| Context | `compaction/started` · `compaction/ended` · `context/epoch` |
| Checkpoints | `checkpoint/created` · `revert/staged` · `revert/committed` · `revert/cleared` |
| Delegation | `subagent/catalog` · `subagent/finished` |

### SQLite index tables

| Table | Key | Purpose |
|---|---|---|
| `session` | `id` | list/search; mirrors the header |
| `session_event` | `(session_id, seq)` unique | rebuildable bounded-page index; `type`, `time`, `segment_id`, offset, event digest |
| `session_log_head` | `session_id` | committed sequence/digest, segment digest, durability profile; verified against bytes before use |
| `session_log_segment` | `(session_id, first_seq)` unique | range, event count/bytes, seal digest and predecessor; rebuilt/verified from files |
| `session_message` | `id`; idx `(session_id, seq)` | decoded model-visible projection built from the log |
| `session_input` | `id`; unique delivery ID plus payload digest, lane, sequence, result and promotion state; partial unique for pending entries | durable admission receipt, dedupe, and promotion ordering |
| `session_context_epoch` | `session_id` | `baseline`, `snapshot`, `baseline_seq` |
| `session_checkpoint` | `id` | `scope`, `kind`, `content_ref`, `reconstructable`, `version` |
| `session_blob` | `(session_id, blob_id)`; unique digest within session | Rebuildable ref manifest, byte length/media type, verification and retention state; never stores blob bytes |
| `artifact_migration` | `(session_id, migration_id)` | Rebuildable UI/status projection: source generation/log digest, target generation, verified-object count, phase and terminal result; correctness does not depend on it, and a crash may discard/rebuild the target from the authoritative source |
| `session_revert` | `session_id` | active staged rewind (`message_id`, `snapshot`, `files`, `diff`) |
| `subagent_catalog` | `(session_id, child_id)` | durable child facts inherited by forks |

Constraints mirror the reference discipline: `seq` is unique and dense per session, the committed log is append-only, and message/input/context rows are projections — never authoritative. The projection must stream/rebuild without holding the full log or full message history in memory.

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

Validate the header, committed head, and segment chain; stream the committed prefix
into a projection. If the committed prefix ends mid-turn or an uncommitted tail is
present, return `recovery_pending` and admit no new work. Only the recovery controller
may preserve/hash the tail and reconcile pending effects; ordinary load does not
append repair. Rebuild missing projection rows only from verified committed bytes.
`contextEpoch.prepare` reconciles or replaces the snapshot; re-resolve workspace
identity before any resumed write. An unresolvable root is a typed error plus
re-point guidance — queued work is never replayed against a guessed path.

### 3. `list`

Query the index (`workspace_id`, `status`, `parent_id`, recency). Listing never
touches a live session's writer lock and does not load/recover logs. The store returns
typed per-session integrity states and `enumeration_complete`; a failed directory
scan, iterator item, index read, or corrupt session is surfaced, never dropped or
rendered as an empty store. A separate operator action may request read-only
verification or explicit recovery.

### 4. `fork`

A fork is a durable child, not a prompt splice. Copy only the verified committed event
prefix through a chosen boundary; never recover or alter the parent's log as a side
effect. Append a `session/end-seed` marker (`inherited: true`) recording the inherited
cut, then append deterministic closer events in the child for any open turn at the
fork boundary. The child records its `parent_id`, inherited event count and lineage
in the header. `subagent/catalog` child facts before the final inherited cut belong to
the parent; facts after it are appended to the child.

### 5. `close`

Append `session/closed`; refuse further admission; release any concurrency slot; allow replay and `resume` later. Closing a parent cascades to descendants' cascade policy but never rewrites their logs.

### 6. Input admission and promotion

- Admitted input is durably recorded with a `delivery` of `steer` (interrupt-level redirection, the next step boundary) or `queue` (the next turn).
- Admission is idempotent by input id and payload digest: matching replays return the original receipt; a reused ID with changed content returns a typed conflict. Bound pending count, payload bytes, age, and per-lane service; never drop on compaction or client reconnect (`REQ-LOOP-007`).
- Promotion at a boundary: service eligible steers before the next step but cap the batch; then promote queued turns using a persisted fair cursor and age/deadline policy. An infinite steer stream must not starve queued prompts, and background work must not starve control/cancel/approval actions (`REQ-HORIZON-014`). A promoted steer resets the step counter; queued promotion starts a fresh turn.
- Promotion is itself an event (`input/promoted`), so replay reconstructs exactly which inputs were consumed and when. Injected context (not user-facing) waits behind the same `next-step` boundary; it never interleaves mid-step (`REQ-LOOP-002`).

### 7. Per-key run coordinator

The coordinator serializes execution for each session key while allowing different keys to run concurrently (`REQ-LOOP-002`).

- `resume(key)` — start a drain if idle, or join the active drain.
- `wake(key)` — request a coalesced follow-up; repeated wakeups collapse to one.
- `interrupt(key)` — mark stopping, clear the pending wake, and cancel the active drain; idle interrupt is a no-op.
- A follow-up drain starts only after the current drain settles, and `pendingWake` is cleared at start so a late wake cannot double-run.
- This coordinator is local to one session-store process. A detached run across client disconnects requires the separate durable owner lease/fencing protocol in `CMP-orch`; process-local mutual exclusion alone does not authorize safe recovery or multi-process writes (`ARCH/25`).

### 8. Context epoch snapshots

The store persists, never computes. `prepare` distinguishes unchanged, replacement-ready and blocked outcomes; a replacement is written with a fresh `baseline_seq` equal to the latest log sequence, so the runner can load only entries at or after the baseline. Compaction insert events are the projection boundary; the log is never rewritten.

### 9. Checkpoint and rewind

Checkpoints are produced at step boundaries, before waits/approvals, and before compaction. Rewind to a prior turn boundary is `stage` → review → `commit`/`clear`; the staged plan restores file trees and records the diff, and it is surfaced before it is applied (`REQ-SESS-003`).

### 10. Deterministic interrupted-turn recovery

Read-only load, list, status, and export inspection never repair. An explicit
recovery-controller operation first verifies the committed head, saves and hashes any
uncommitted/torn tail without modifying the source, and reconciles each pending tool
call against durable effect receipts. If the last committed event leaves a turn open,
recovery may append deterministic closers to a new generation/segment:

1. For each recorded tool call with no durable result, append an error `tool/result`
   with code `TOOL_NOT_STARTED` only when evidence proves it never started, or
   `TOOL_OUTCOME_UNKNOWN` when it started and the outcome is not known. Model-facing
   guidance permits retry only if read-only/idempotent; otherwise verify or ask.
2. Close the open step with `step/end`.
3. Close the turn with `turn/end` whose reason is `interrupted` (crash recovery) or
   `forked` (fork cut).

Synthetic events use the last committed event's timestamp and next sequence, so the
same recovery ID against the same committed head and reconciled effect receipts is
idempotent and byte-deterministic. The original tail remains retained and linked to
the recovery record; lack of sufficient effect evidence leaves the session in
`RECONCILING` instead of repairing by guess (`DEC-056`, `REQ-SESS-006`).

### 11. Portability and replay

Replay folds the log with the same `surfaceOp` semantics used when it was written, producing identical message, prompt, inbox and run projections. Because deltas are not persisted, a replay reconstructs settled messages, not keystrokes; this is intentional. A session copied to another host replays if its `format_version` is supported.

Checkpoints and portable-session export include a closed-world blob manifest. Creating a checkpoint pins every payload reachable from its event boundary; fork copies or links through explicit immutable refs and preserves parent ownership; rewind never deletes blobs referenced by another checkpoint or evidence object. The UI shows a thumbnail/typed attachment row only after validation, with media type, original size, and unavailable/corrupt reason; it never tries to render arbitrary active content or hide a failed attachment behind a blank tile.

### 12. Migration chain discipline

- The physical format advances one version at a time. Each adjacent migration declares `fromVersion`/`toVersion` (`to == from + 1`), a header transform, a streaming event stage, and a target-header validator.
- A **build-static catalog** compiles the chain at startup and refuses to build if a version is missing, duplicated, or newer than the current build. A log whose stored version is newer than the build is refused with a typed "unsupported" result, never partially decoded.
- Migrations are **streaming and pure**: they transform events in `seq` order, preserve the inherited cut, and validate target invariants (for example, a turn boundary may not cross an open step).
- A delivery-accepted marker records the format version a session was last admitted under, so downgrade and cross-build reads stay explicit.
- Replay validation runs against the current invariant set; a migration that cannot satisfy it refuses rather than emitting a lossy result.
- Blob migrations verify every output digest and the complete new generation's event/blob graph before manifest switch; a crash resumes from an idempotent migration journal or keeps the old generation authoritative. Unsupported future blob schemas fail typed before partial replay.

## Failure modes

| Failure | Behavior |
|---|---|
| Crash mid-turn | Explicit recovery closes the committed open turn deterministically only after effect reconciliation; committed steps remain untouched (`REQ-LOOP-006`). |
| Torn/uncommitted log tail | Read-only access changes no bytes. Recovery preserves/hash-pins the tail, reconciles effects, and either resumes in a new generation or returns `UNKNOWN`; never silently truncates in place. |
| Index drift / missing rows | Rebuild affected rows from the log; the log is truth. |
| Two writers, one session | Coordinator admits one active drain; a second `resume` joins rather than forks state. |
| Un-promoted input after crash | Admission rows survive; promotion re-derives from the log at the next boundary. |
| Corrupt or unknown event type | Typed decode failure; the session loads as unsupported rather than silently skipping. |
| Session listing scan/index/read failure | Return `enumeration_complete=false` and typed issue or visible unavailable entry; never omit the problem or return empty success. |
| Stored format newer than build | Refused with an "unsupported version" result; no partial migration. |
| Blob missing/corrupt/schema too new | Emit a typed unavailable artifact and preserve the event/ref; block any task evidence depending on its contents. |
| Blob write crash/disk full | No referencing event commits; temporary/orphan bytes are collected only after mark-and-grace reconciliation. |
| Inline or decoded media exceeds limit | Reject with exact effective limit before unbounded allocation/use; do not truncate and masquerade as the original payload. |
| Filesystem lacks requested durable atomic publication | Refuse durable artifact commit or expose an explicitly configured weaker persistence guarantee; never claim a durable write. |
| Digest path exists with mismatching bytes, metadata, or symlink | Typed integrity/path error; do not overwrite, follow, or append an event reference. |
| Concurrent writes race the session byte ceiling | Serialize/reserve quota under the session lease; exactly one admissible write may consume the remaining quota. |
| Export/import interrupted | Preserve source; publish no partial exported/imported session; resume or discard only through a journaled idempotent operation. |
| Workspace moved/renamed | Resume re-resolves identity; typed `NotFound` + re-point guidance, never a guessed path. |
| Rewind against a stale snapshot | Staged snapshot invalidated by a newer write; re-stage required. |
| Duplicate child catalog fact | Refused (conflicting `child_id`) rather than merged. |

## Configuration

| Setting | Owner | Default | Effect |
|---|---|---|---|
| `session.retention_class` | session | `interactive` | Hibernation/archive thresholds |
| `session.log.fsync` | session | flush per committed step | Durability vs throughput (`REQ-LOOP-006`) |
| `session.log.durability_profile` | session | `run_durable` for any multi-hour run; `interactive` only where policy permits | Effective backend/profile is recorded; a multi-hour run refuses unsupported durability or disabled sync |
| `session.log.max_event_bytes` / `max_segment_bytes` / `max_segment_events` / `max_session_event_bytes` | session | finite generated-schema defaults; exact values required before implementation | Bound each record, file, and session stream; event bytes have a separate ledger from blob bytes |
| `session.log.control_reserve_bytes` / `replay_batch_events` | session | finite generated-schema defaults; exact values required before implementation | Preserve terminal/reconciliation capacity and bound replay allocations |
| `session.migrate.strict` | session | `true` | Refuse unknown/newer versions rather than best-effort |
| `session.artifacts.max_object_bytes` / `max_session_bytes` | session | bounded product defaults (exact values published in generated schema) | Encoded payload ceilings; managed policy may lower them, never raise compiled safety ceilings |
| `session.artifacts.max_decoded_pixels` / `max_expansion_ratio` | session | bounded product defaults (exact values published in generated schema) | Decoder resource ceiling before image/media render or model use |
| `session.artifacts.retention` | session | follows parent session retention | GC eligibility; referenced/checkpointed/exported evidence remains pinned |
| `context.compaction.keepTokens` / `buffer` | context | ~8k / ~20k | Projection boundary sizing (`REQ-CTX-002`) |
| `session.checkpoint.cadence` | session | step boundary | Checkpoint production points |
| `orch.max_depth` / `max_parallel` | orch | bounded | Child session admission (`REQ-ORCH-005`) |

Session-level configuration is layered (`defaults → user → workspace → agent profile → session`) and the effective model/mode/permission snapshot is persisted with the session (`REQ-SESS-004`).

## Requirements mapping

| Requirement | How this document satisfies it |
|---|---|
| `REQ-SESS-001` | Bounded, digest-linked segmented event stream with a verified committed head and rebuildable index; resume only from committed state. |
| `REQ-SESS-002` | Streaming replay of committed segments yields identical projections; inspection is read-only, while interrupted-tail recovery is explicit, byte-preserving, and effect-reconciled. |
| `REQ-SESS-003` | Checkpoint storage and staged rewind to a turn boundary. |
| `REQ-SESS-004` | Model, mode and permission snapshot persisted on the session record. |
| `REQ-SESS-005` | Immutable per-session blobs, digest references, replay validation, copy-on-write migration, safe GC and visible unavailable states. |
| `REQ-SESS-006` | Segmented append, committed-head integrity, streaming replay, finite event quota, protected control reserve, retention-safe cleanup, read-only non-mutation, visible enumeration failures, and platform durability. |
| `REQ-HORIZON-027` | Run event segments, per-action storage reservations, physical emergency reserve, crash-durable run profile, quota fence, and truthful resource stop. |
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
3. **Segment/archive format.** The segment byte/event ceilings, hash canonicalization version, checkpoint interval, archive container/compression, and exact post-terminal retention policy must be selected and benchmarked before implementation. Segment rotation is not pruning; an archive is not a substitute for a verified local committed head.
4. **Fork boundary model.** Whether forks are limited to turn boundaries or may cut mid-turn (with closer repair) by default; the model-visible wording differs and needs a product decision.
5. **Injected-context admission.** The exact classification rules for `next-step` injected context versus steered user input, and whether injected context is ever persisted as a user-visible message.
6. **Format-version policy for external agents.** Whether externally produced session logs may be imported and migrated, or only replayed read-only.
7. **Artifact ceilings.** The encoded per-object/session defaults, decoded media ceiling, disk reserve, and orphan-GC grace need explicit product values selected against supported workloads and laptop/server resource budgets before the blob store is implemented. There is no unbounded fallback.
