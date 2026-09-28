# 07 — Durable Thread Store (`CMP-session`)

`CMP-session` is the persistence owner for HorizonCode Threads; the historic component
and crate name may remain `CMP-session`/`horizoncode-session` during migration. A Thread
is the canonical durable conversation identity. A protocol `Session` is an external
binding only. `CMP-artifact` owns immutable bytes and their safe lifetime (`ARCH/28`).
This document is the LLD for event-sourced Threads: append-only segmented history,
derived SQLite indexes, parent/child linkage, input admission, context epochs,
checkpoints, portability, replay, and the versioned migration from current
session-named storage.

## Purpose

- Make every Thread a durable, movable, replayable artifact — the product's portable conversation claim (`ARCH/01-VISION.md`; `REQ-SESS-001`, `REQ-SESS-002`).
- Guarantee that a crash mid-turn loses no committed step: the log is appended and flushed before the next phase proceeds (`REQ-LOOP-006`).
- Provide the substrate for long-horizon work — resumable task state, enforceable budgets, checkpoints and rewind (`REQ-HORIZON-001..003`, `REQ-SESS-003`).
- Serialize turns per Thread key while letting unrelated Threads run concurrently (`REQ-LOOP-002`).
- Keep one durable write path and one format discipline so replay stays deterministic across builds (`DEC-004`, `DEC-011`).

## Conversation identity and live execution

`ThreadId` is HorizonCode's canonical conversation identity. A Thread owns ordered
turns/items, context epochs, admitted input, replay, and parent/child conversation
lineage. It survives one or more process/peer incarnations recorded as
`WorkerExecution`. `Session` is adapter vocabulary for a protocol/peer handle, such
as an ACP session or OpenCode Session, and is kept in an external binding. Codex
Thread IDs and external session IDs are not HorizonCode IDs. Do not persist a second
HorizonCode `ThreadId`, `ConversationId`, or `AgentSessionId` for the same Thread.

This paragraph defines the proposed schema and ownership contract; it does not
claim all of these fields or behaviors exist in the current session crate. Existing
session-named files and IDs are migration input only. Follow
`ARCH/29` and `TODO.md` for code-level presence and verification status.

The first durable format keeps its existing `$HORIZONCODE_HOME/sessions/<id>/`
location and serialized `session/*` event names for compatibility; those names describe
the storage format, not a second HorizonCode identity. Its UUID is reused unchanged as
the normalized `ThreadId`. A future Thread-format migration MUST read and verify the
entire v1 committed head, build a separate v2 generation, and record a migration
receipt binding source format/head/digest to target format/head/digest. Never rewrite a
hash-chained v1 event in place, mix v1/v2 payload schemas inside one generation, or
delete v1 before verifying the v2 projection and replay. Readers must preserve unknown
event fields and refuse unsupported versions without modifying the source.

A durable Thread does not prove that a worker process is alive. Runtime ownership,
heartbeat, process identity, and launch/recovery outcome belong to the
`WorkerExecution` record proposed in `ARCH/25`; the process itself may disappear
while the Thread and Attempt remain durable. `Thread.status` is conversation/store
lifecycle only and must not be used as the authoritative liveness check for a
detached or external worker. Until `WorkerExecution` is implemented, liveness and
post-restart continuation are not established by this design's Thread record.

This split is the same useful distinction visible in OpenCode's 2026-09-28 V2
Session design: durable session/input/event history is separate from its
process-local `SessionRunCoordinator`. OpenCode explicitly leaves process-restart
ownership and continuation recovery outside that slice (`research docs/opencode.md`,
pinned commit `083ed266e058dc3d2d1b377ff5540859d79de110`). HorizonCode adds durable
attempt/run ownership and reconciliation around the worker runtime.

## Responsibilities

**Owns**

- The `Thread` record and its lifecycle: `create` · `resume` · `list` · `fork` · `close`.
- The append-only `ThreadEvent` log (JSONL) and its monotonic per-thread `seq` discipline.
- Bounded immutable log segments, per-event integrity links, the committed-head record, byte reservations, and bounded streaming replay (`REQ-SESS-006`, `REQ-HORIZON-027`).
- Thread artifact namespaces and `BlobRef`s in canonical events; request `CMP-artifact` for payload staging, integrity checks, bounded reads, import/export and GC. The thread log contains bounded references only.
- The SQLite index derived from the log — thread rows, model-visible message projection, input admission, context epoch, checkpoints, revert state, sub-agent catalog. Every table is rebuildable from logs.
- A bounded, versioned FTS5 search projection over committed display text, its per-thread indexed-head state, title aliases, coverage reporting, and exact-message navigation (`REQ-SESS-007`). The global index is derived and replaceable; canonical events remain authoritative.
- The per-thread turn coordinator: at most one active turn drain per thread key within the store's ownership scope; wakeups coalesce; interrupts settle. It is not the lease authority for a detached multi-process run; `CMP-orch` owns the run lease and fencing epoch (`ARCH/25`).
- The input-admission table and promotion order (steer drain, then the next queued turn).
- Context-epoch storage (baseline text + snapshot + baseline sequence), as produced by `CMP-context`.
- Checkpoint storage and rewind planning; snapshot file-tree references.
- Explicit, idempotent interrupted-turn recovery after byte preservation and effect reconciliation; listing and read-only replay never repair canonical storage.
- Thread portability (a thread directory is the artifact) and replay.
- Thread-format versioning: an adjacent migration chain plus a build-static catalog.

**Never owns**

- Loop decisions, model calls, tool scheduling or execution (`CMP-runner`).
- Context assembly, selection and compaction (owned by `CMP-context`; this store persists the resulting events and epoch).
- Provider transports and retries (`CMP-provider`).
- Sub-agent scheduling, isolation or receipts (`CMP-orch`); this store only holds child Threads and their lineage.
- Permission evaluation (`CMP-guard`), secret custody (`CMP-secrets`), and the tamper-evident audit chain (`CMP-audit`).

## Interfaces

| Direction | Counterpart | Surface | Notes |
|---|---|---|---|
| in | `CMP-runner` | `admit(input)` · `loadForRunner(thread, baselineSeq)` · `append(event)` · `contextEpoch.prepare/advance` · `failInterruptedTools(thread)` | The runner is the only writer of turn/step/tool/model events. |
| in | `CMP-runner` (coordinator) | `resume(key)` · `wake(key)` · `interrupt(key)` · `active()` | One owner per thread key (see "Per-key run coordinator"). |
| in | `CMP-context` | `compaction/stated` · `compacted` · `context/epoch` snapshot advance | Context decides; this store records and persists. |
| in | `CMP-orch` | `createChild(parent, meta)` · `subagent/catalog` facts | Child Threads are ordinary Threads with `parent_thread_id`. |
| in | `CMP-guard` | approval/question outcome events | Decisions are recorded once and never inferred (`REQ-GUARD-001`). |
| in | `CMP-tools` | `tool/call` and `tool/result` recording before/after effects | A call is recorded durably before its side effects begin. |
| in/out | `CMP-artifact` | stage/verify/read thread-scoped payloads; append owner reference through the thread log | Artifact bytes are durably published before their `BlobRef` event; a cross-store write lease is held until the event outcome is reconciled (`ARCH/28`). |
| out | `CMP-acp`, `CMP-headless`, `CMP-tui`, `CMP-control-api` | `create/resume/list/fork/close`; projections `history`, `prompt-history`, `inbox`, `runs`; `search`, `open_hit`, explicit `rebuild_index` | Surfaces are projections only (`REQ-PROTO-005`); search remains local to the authorized thread store. |
| out | `CMP-audit` | Security-relevant thread events mirrored to the audit chain | Separate store, never pruned with the event log (`REQ-AUDIT-001`). |

All surfaces and services read/write through the store; no module opens the JSONL files or the SQLite database directly (`ARCH/03` §4.4).

## Data / state model

### Thread artifact (portable unit)

```
$HORIZONCODE_HOME/sessions/<thread-id>/
  header.json          # thread_id, format_version, workspace_id, run/task/attempt IDs?, parent_thread_id?, created_at, lineage
  events/
    head.json          # last durably acknowledged seq + event digest; canonical commit watermark
    segment-<first-seq>.open   # bounded active segment; never exceeds configured ceiling
    segment-<first-seq>.sealed # immutable, digest-linked, sequence-contiguous segment
    seals/<first-seq>.json     # bounded seal records for sealed segments
  checkpoints/         # checkpoint content refs (see below)
  artifacts/           # file-tree snapshot refs and tool output refs
  blobs/blake3/        # immutable per-thread payload objects, named by digest
  manifest.json        # rebuildable format/index + sorted segment and artifact refs
```

Copying the directory moves the Thread conversation and referenced blobs only; it does not copy, transfer, or resume an associated managed Run, Task, Attempt, workspace lease, permission grant, budget, effect, or verification state. Replay produces the same conversation projections on any host that supports its `format_version`, event/segment schema, and every referenced blob schema. A global `state.db` (SQLite) indexes all Threads for `list`/search and is always rebuildable by streaming headers and segments. `head.json` is the committed high-water mark and must match the last complete event digest; the ordered segment bytes plus the head are canonical. Seals detect segment truncation/reorder and bind each segment to its predecessor. `manifest.json`, SQLite, and cached offsets are rebuildable accelerators and cannot authorize skipping data or lowering the committed head. Directory enumeration/read errors fail closed. A separate explicit Run bundle may export approved specification/task/evidence metadata and artifact references under `ARCH/25`/`ARCH/28` policy; importing it creates a new Run identity, excludes credentials and live authority, and never claims that the workspace or external effects were transferred.

### `Thread` record

| Field | Type | Notes |
|---|---|---|
| `id` | ThreadId (uuidv7) | opaque; minted by the store; preserved from a legacy SessionId during migration |
| `run_id` | RunId? | present only when managed by a durable Run |
| `task_id` | TaskId? | optional task association for navigation; not task ownership |
| `attempt_id` | AttemptId? | attempt currently owning this conversation; a changed strategy creates a new Attempt and Thread |
| `workspace_id` | text | resolved workspace identity; re-resolved before any resumed write |
| `parent_thread_id` | ThreadId? | set for delegated child Threads; parent linkage is not a task dependency |
| `external_bindings` | bounded refs | peer-native Thread/Session IDs and negotiated capabilities; never authority or local identity |
| `title` | text | derived or model-written; non-authoritative |
| `agent_binding` | text | native binding or external agent id |
| `model` | json | `{ id, provider, variant? }` actually used (`REQ-SESS-004`) |
| `mode` | text | interaction mode the thread ran under (`REQ-SESS-004`) |
| `permission_snapshot` | json | the guard ruleset in force (`REQ-SESS-004`) |
| `status` | enum | `active` · `hibernated` · `archived` · `closed` · `recovery_pending` · `integrity_blocked` |
| `retention_class` | enum | `interactive` · `job` · `ephemeral` |
| `format_version` | int | thread-format version of the log |
| `created_at` / `last_active_at` | int (epoch ms) | UTC |

`ThreadListResult = {items: ThreadListEntry[], enumeration_complete,
issues[]}`, with these exact shapes:

| Type | Field | Type | Notes |
|---|---|---|---|
| `ThreadListResult` | `items` | `ThreadListEntry[]` | deterministic order: `last_active_at` desc, then thread id asc; entries without a projection sort after all projected entries, by id asc |
| `ThreadListResult` | `enumeration_complete` | bool | `false` only when the **store-level** scan itself was incomplete (directory unreadable, iterator error) |
| `ThreadListResult` | `issues` | `ThreadListIssue[]` | store-level issues only; per-thread issues stay on their entry |
| `ThreadListEntry` | `id` | `ThreadId` | stable identity, present even when unreadable |
| `ThreadListEntry` | `summary` | `ThreadSummary?` | last known projection; `None` when the header cannot be read |
| `ThreadListEntry` | `integrity` | enum | `AVAILABLE \| CORRUPT \| UNSUPPORTED \| UNREADABLE \| RECOVERY_PENDING \| UNKNOWN` |
| `ThreadListEntry` | `issue` | `ThreadListIssue?` | the per-thread problem, when the row is not plain `AVAILABLE` |
| `ThreadListIssue` | `kind` | enum | `DIRECTORY_UNREADABLE \| ITERATOR_ERROR \| ENTRY_UNREADABLE \| HEADER_MISSING \| HEADER_CORRUPT \| HEADER_UNSUPPORTED \| LOG_CORRUPT \| LOG_UNSUPPORTED \| TAIL_TORN` |
| `ThreadListIssue` | `thread_id` | `ThreadId?` | absent for store-level issues |
| `ThreadListIssue` | `path` | text | the exact path examined |
| `ThreadListIssue` | `message` | text | cause, never a bare "unknown" |
| `ThreadListIssue` | `line` | int? | 1-based, when a specific line is at fault |
| `ThreadListIssue` | `bytes_affected` | int? | torn-tail or unreadable size, when known |

`external_bindings` use this separate adapter-owned shape:

```text
ExternalThreadBinding {
  thread_id: ThreadId,
  adapter_kind: NATIVE | CODEX | CLAUDE_CODE | OPENCODE | ACP | OPAQUE_CLI,
  external_thread_id?: string,
  external_session_id?: string,
  protocol_name?: string,
  capability_snapshot_id?: CapabilitySnapshotId,
  event_cursor?: opaque versioned cursor,
  history_visibility: FULL | PARTIAL | NONE | UNKNOWN,
  resume_mode: NATIVE | LOAD | REPLAY | RESTART_ONLY | UNSUPPORTED | UNKNOWN
}
```

Provider/client changes never rewrite the HorizonCode `ThreadId`. An opaque adapter may
have neither peer ID nor resumable history; it still receives a local Thread and the
unknown capability values remain `UNKNOWN`.

Integrity derivation is fixed: an unreadable IO error is `UNREADABLE`; a missing
`thread/created` row is `HEADER_MISSING`/`CORRUPT`; a stored `format_version` newer
than this build is `UNSUPPORTED`; an unparseable non-final row or a sequence gap is
`CORRUPT`; an unterminated, unparseable final row is `RECOVERY_PENDING` and still
carries a usable `summary`; anything else is `AVAILABLE`. A directory/iterator error
sets `enumeration_complete=false` with a typed store-level issue and is never
represented as an empty successful list. A per-thread problem does **not** clear
`enumeration_complete`: the scan itself finished, and the bad row is visible. An
indexed thread whose log cannot be read remains visible as an unavailable entry. A
missing/stale index returns an explicit stale/rebuild-needed state and does not cause
the listing call to recover or rewrite canonical logs (`REQ-SESS-006`, `DEC-056`).

Enumeration reads the log bytes for a projection but performs no repair, no tail
truncation, and no synthetic append. The pure scanner behind it is the same one the
read-only surface uses; only the explicit recovery path may reconcile an incomplete
tail, and that path is owned by `AX-311`.

### Full-text thread search (`REQ-SESS-007`)

`CMP-session` owns the search API and a derived projection in the existing global
`state.db`; there is no second search service, database, model call, or remote search
provider. The canonical source remains each verified thread event stream. The
projection is disposable and may be deleted/rebuilt without changing a thread. The
current workspace already pins `rusqlite 0.31.0` with `bundled`, and its locked
`libsqlite3-sys 0.28.0` build script defines `SQLITE_ENABLE_FTS5`; use SQLite FTS5
with `unicode61` and diacritic removal for the initial implementation. This is a
build-specific observation, not a guarantee for future dependency changes. Schema
migration/startup MUST probe that FTS5 is available and refuse search with a typed
capability error if it is not; never return an empty hit list as a fallback. Any
SQLite dependency/build-feature update must preserve this check and rerun the exact
search conformance suite. Upstream references: [rusqlite v0.31.0 bundled build]
(https://github.com/rusqlite/rusqlite/blob/v0.31.0/libsqlite3-sys/build.rs) and
[SQLite FTS5](https://www.sqlite.org/fts5.html).

The FTS tokenizer defines word boundaries. Search is case-insensitive and removes
diacritics for matching; punctuation is a token separator. Bare terms are an AND
query over tokens in one message. A double-quoted expression matches an ordered,
contiguous token phrase, so punctuation between tokens is ignored by tokenization.
This is not byte-for-byte substring search, typo matching, stemming, semantic/vector
search, or raw FTS query syntax. The parser accepts only bounded bare terms and quoted
phrases, rejects unmatched quotes and empty/oversized input with typed errors, and
constructs a restricted FTS expression; bound SQL parameters alone are not treated
as protection from FTS query operators.

#### Derived index schema

```text
search_document {
  doc_id: i64 primary key,
  thread_id: ThreadId,
  message_id: MessageId,
  event_seq: u64,
  event_digest: Digest,
  role: USER | ASSISTANT_DISPLAY | TOOL_DISPLAY,
  committed_at_utc_ms: i64,
  visible_text: bounded text,
  UNIQUE(thread_id, message_id)
}

search_document_fts {
  FTS5(visible_text,
       content='search_document', content_rowid='doc_id',
       tokenize='unicode61 remove_diacritics 2')
}

thread_search_state {
  thread_id: ThreadId primary key,
  indexed_seq: u64,
  indexed_head_digest: Digest,
  index_schema_version: u32,
  extractor_version: u32,
  state: CURRENT | CATCHING_UP | PARTIAL | FAILED,
  issue_code: optional enum
}

thread_title_alias {
  alias_id: i64 primary key,
  thread_id: ThreadId,
  title: UTF-8 text, max 512 bytes,
  normalized_title: normalized UTF-8 text, max 512 bytes,
  title_event_seq: u64,
  title_event_digest: Digest,
  title_at_utc_ms: i64,
  UNIQUE(thread_id, normalized_title)
}

thread_title_alias_fts {
  FTS5(title,
       content='thread_title_alias', content_rowid='alias_id',
       tokenize='unicode61 remove_diacritics 2')
}
```

`search_document`, both FTS tables, and title aliases are projections only. In one
SQLite transaction, the indexer extracts committed displayable text from verified
canonical events, upserts message metadata/content, maintains the FTS indexes, and
advances that thread's indexed sequence/head digest. It never advances beyond the
verified committed head. FTS external-content insert/update/delete maintenance is
transactional; migrations run the FTS5 integrity check before publishing a new index
generation. A thread commit for displayable text or a title change and its index
checkpoint use a replayable outbox/source sequence so a process crash cannot mark
unindexed events current.
User messages and assistant display text are indexed by default. Tool output is
indexed only when `search.index_tool_output` is enabled and the thread projection
marks that output as displayable. The index projection records an
`extractor_version`; each version defines which committed displayable message and
part types map to searchable UTF-8 text, their ordering/spacing, normalization, and
truncation behavior. V1 extracts only explicitly persisted text parts and displayable
tool text. It does not infer text from images, audio, files, code attachments, or
binary artifacts. A future extractor may add a user-visible text/caption field only
under a new version with deterministic fixtures and a rebuild migration. Hidden
reasoning, credentials classified by existing secret-handling rules, non-displayable
parts, uncommitted events, and streamed token deltas are excluded. This does not claim
perfect detection of arbitrary secrets embedded in ordinary text; index files inherit
the state directory's owner/mode protections and Thread read/export authorization.

When `search.index_tool_output` is disabled, query/snippet authorization filters out
tool-origin rows immediately, even if background index deletion is still pending.
Purge is a separate durable rebuild/delete job; turning indexing back on does not
restore rows until re-indexed from canonical events under the new preference.

The indexer consumes committed thread events in sequence order and stores each
source digest. `thread/title-changed` carries the prior and new title values; the
thread projection records the current title, while the alias projection retains each
non-empty title value seen in committed history. The transaction inserts aliases and
updates the title FTS table; it does not rewrite message rows. Repeated normalized
titles upsert their most recent title-event sequence, digest, and time without
discarding other historical title values.
Every message hit joins the current thread row by immutable `ThreadId`, so it is
still discoverable after any rename and is displayed under the current title. A title
match is queried from `thread_title_alias_fts`; it returns a distinct title-only hit
only when the alias matches and the same Thread has no matching message hit for this
query. If message hits exist, each may carry the matching title alias as context and
the redundant title-only row is suppressed. Opening a title-only hit opens the thread
without inventing a matching message. Aliases survive rename but are purged with an
actual thread content deletion/retention expiry.
Project/workspace, current title, archive status, and per-thread integrity are
joined from current verified projections at query time, never copied into the FTS row
as authority.

#### Query and result contract

```text
SearchQuery {
  text: bounded UTF-8,
  thread_id?: ThreadId,
  project_id?: ProjectId,
  created_from_utc_ms?: i64,   // inclusive
  created_before_utc_ms?: i64, // exclusive
  role?: USER | ASSISTANT_DISPLAY | TOOL_DISPLAY,
  include_archived: bool,
  sort: RECENT | RELEVANCE,
  page_size: 1..=configured_max,
  cursor?: SearchCursor
}

SearchHit {
  kind: MESSAGE | THREAD_TITLE,
  thread_id: ThreadId,
  current_title: text,
  project_id?: ProjectId,
  message_id?: MessageId,
  event_seq?: u64,
  event_digest?: Digest,
  title_event_seq?: u64,
  title_event_digest?: Digest,
  role?: SearchableRole,
  matched_at_utc_ms?: i64, // message commit time or matched title-event time
  snippet: escaped bounded display text,
  matched_title_alias?: text
}

SearchPage {
  hits: SearchHit[],
  cursor?: SearchCursor,
  coverage: COMPLETE | INDEXING | PARTIAL | FAILED,
  coverage_snapshot_id?: OpaqueId,
  scope_digest: Digest,
  authorized_thread_count: u64,
  indexed_through_head_count: u64,
  issue_count: u64,
  catalog_generation: u64,
  captured_heads: bounded [{thread_id, head_seq, head_digest}],
  issues: bounded typed per-thread/index issues[],
  generation: u64
}
```

An omitted project/thread/date filter means no filter. Date filters use the matched
message commit time for message hits and the matched title-event time for title-only
hits; this date basis is displayed in the filter/result details. A role filter excludes
title-only hits because titles have no speaker role. A message whose body and title
both match produces message hits with title context and no redundant title-only hit;
title-only is reserved for a matching Thread with no matching message hit. UI
date pickers resolve calendar days in the configured display timezone into UTC
half-open intervals; the control API and CLI accept explicit UTC/RFC3339 boundaries.
`RECENT` sorts by matched timestamp descending, then Thread ID ascending, hit-kind
rank (`MESSAGE` before `THREAD_TITLE`), source event sequence descending, and stable
message ID/title-alias ID ascending. `RELEVANCE` sorts by FTS5 rank ascending, then
the complete `RECENT` key. This is a total order even when timestamps/ranks tie across
message and title hits. Keyset cursors carry the full last-hit sort tuple and unique
hit identity; offset pagination is forbidden. A cursor is bound to normalized query,
filter and extractor-version digests plus index generation; if the index changes,
return
`CURSOR_STALE` and let the client restart the page rather than silently skip or
duplicate results. Initial compiled ceilings are: 1,024 UTF-8 query bytes, 32 parsed
tokens/clauses, 100 hits per page, 512 UTF-8 snippet bytes, 256 indexed messages or
4 MiB of extracted display text per index transaction (whichever comes first), four
concurrent query slots per process, and a two-second query deadline. Defaults are 20
hits per page and one background indexer; user settings may lower those ceilings but
cannot raise them. If the query deadline or index-work limit is reached, return typed
`PARTIAL` coverage with an issue/cursor and never present a partial zero-hit page as a
complete miss. Cancellation frees the query slot and does not advance an incomplete
index checkpoint.

`COMPLETE` requires one stable authorized-Thread catalog snapshot for the requested
scope, `indexed_through_head_count == authorized_thread_count`, and zero unresolved
issues. The snapshot binds catalog generation, scope digest, authorization principal
and policy revision, and each Thread's verified committed head; the index must cover
all these heads. `captured_heads` is only a bounded diagnostic sample and is not by
itself proof of complete scope. If authorization/catalog enumeration is still paging,
changed during query, incomplete, or has unreadable Threads, return `INDEXING`/`PARTIAL`
with counts and typed issues. Bind result cursors to both index and catalog generation
so initial global Thread loading or a newly created/renamed/deleted Thread invalidates
the cursor rather than presenting a false complete miss.

For edited/replaced messages, index only the committed revision currently displayed
by the conversation projection. Older revisions remain in canonical audit/history but
are not searchable unless the product explicitly renders them as user-visible history
under a separately specified search mode.

Before a message hit is displayed or opened, `CMP-session` resolves its stable message
ID and sequence from canonical history and verifies the recorded event digest. A title
hit similarly verifies its `thread/title-changed` event and current thread projection.
A stale or deleted event returns `HIT_STALE`/`UNAVAILABLE` and schedules projection
repair; it never displays an unverified snippet as canonical. Jumping from a message
hit opens the owning thread, loads the history window around the message even if it
was not previously in memory, scrolls to that exact immutable message ID, and
highlights the match. A title-only hit opens the thread without a message highlight.
If a target is no longer readable, preserve the search result with a typed reason and
do not jump to a nearby item.

The query endpoint first captures the thread registry generation and verified
committed heads, then queries only indexed rows within those bounds. An indexer may
catch up asynchronously; `coverage=INDEXING` or `PARTIAL` must show which Threads
are behind, corrupt, or unreadable. `COMPLETE` is permitted only when every readable
thread in the captured authorized scope is indexed through its captured head and
thread enumeration itself completed. A zero-hit `PARTIAL` result is not reported as
“no matches.” `FAILED` means no trustworthy result can be returned. A rebuild scans
verified headers and committed segments into a replacement projection and atomically
switches the index generation; a failed rebuild leaves the old index marked stale and
preserves canonical logs. Search/listing never repairs source history.

#### API and lifecycle

```text
search(query, principal, snapshot?) -> SearchPage
open_hit(SearchHitKey, principal)
  -> VerifiedMessageLocation | VerifiedThreadLocation | HIT_STALE | UNAVAILABLE
rebuild_index(scope, expected_generation, maintenance_budget)
  -> RebuildReceipt
```

Search is read-only and obeys the same thread/project scope as history inspection.
No project document, thread text, title, or FTS expression can grant access. A
rebuild is an explicit bounded local maintenance operation; it uses the run/thread
maintenance admission contract and cannot hold foreground completion hostage.
Disabling `search.enabled` stops indexing and queries; disabling
`search.index_tool_output` deletes only tool-display projection rows on the next
maintenance pass. Turning search off can purge all derived content while preserving
canonical thread history. Deleting/expiring a thread removes its message docs,
aliases, and FTS entries transactionally with the authorized retention operation.

The current workspace dependency is pinned at `Cargo.toml`/`Cargo.lock`; exact
upstream implementation evidence and the local FTS5 build flag are recorded in
[`ARCH/29`](29-SOURCE-TRACEABILITY.md#arch07) and the test plan. OpenChamber's pinned
search UI is behavior evidence only: its timeline currently searches loaded user
records and its sidebar/ArchiveView searches thread metadata, not full global
message content ([research note](../research%20docs/openchamber-search.md)).

### `ThreadEvent` (normalized event row)

Version 1 on-disk events keep their existing `session/*` spellings and payload fields;
the v2 Thread API normalizes them without mutating the source. The versioned
copy-on-write migration maps `session/created|updated|closed|end-seed` to
`thread/created|updated|closed|end-seed` and maps the identity field to `thread_id` in
the new generation. `thread/title-changed` is additive in v2. Event digests cover the
original serialized bytes, so readers must not relabel an event in place or validate a
reconstructed object in place of its source bytes.

| Field | Type | Notes |
|---|---|---|
| `seq` | int | monotonic per thread, dense from 0; replay order |
| `time` | int (epoch ms) | UTC |
| `type` | dotted string | see vocabulary below |
| `data` | bounded json | lossless envelope; large/binary payloads are `BlobRef`s, never inline base64 or unbounded text |
| `previous_digest` / `event_digest` | digest | storage envelope binds canonical event bytes and preceding committed event; not an authenticity signature (the audit chain has that separate responsibility) |
| `surfaceOp` | enum? | how a replaying surface folds the event (`append`/replacement) |
| `sourceEventSeqs` | int[]? | provenance for synthetic/projected events |

`LogSegmentSeal = {owner_kind, owner_id, segment_id, first_seq, last_seq,
event_count, encoded_bytes, first_event_digest, last_event_digest,
previous_segment_digest, segment_digest, schema_version}`. Each event digest is
`blake3(domain_separator || previous_digest || canonical_event_bytes)` under a
versioned canonical encoding; the digest field itself is excluded from the hashed
bytes (`DEC-059`). Hashes detect corruption/reordering but do not authenticate a writer (that is
the audit/authority boundary). `CommittedLogHead =
{owner_kind, owner_id, generation, committed_seq, committed_event_digest,
committed_segment, committed_segment_digest, durability_profile, updated_at}` —
`committed_segment` and `committed_segment_digest` locate and verify the active
segment's committed prefix on restart (implementation note with `AX-358`). These shared shapes also
cover run logs (`ARCH/25`). IDs and ranges are immutable after seal. There is at most
one active segment per thread writer lease; all record, segment, and total-thread
limits are finite values from the effective config. A segment is sealed before a
successor is created. A seal/manifest is not allowed to claim a later head than the
durable commit record.

### Append, rotation, and replay contract

1. Before accepting an input or dispatching a model/tool/effect whose outcome needs a
   canonical event, reserve enough bytes in the thread/run storage ledger for the
   bounded event envelope, terminal/reconciliation record, and the applicable
   control reserve. Large payload bytes use `CMP-artifact` separately. Refuse or
   safely wait before dispatch if either reservation cannot be made.
2. Under a cross-process per-thread writer lease/fencing epoch, encode one bounded record with the next dense
   sequence, previous digest, and canonical event digest. Append only to the active
   segment. Flush/sync according to the selected durability profile; update the
   committed head atomically and sync the containing directory before acknowledging
   the step as committed. Path opens use no-follow/exclusive semantics; segment and
   head replacement are confined to the thread root and the parent directory is
   synced as required by the backend. Every append checks the current fencing epoch;
   a stale process cannot write after recovery. The run-durable profile cannot disable
   required syncs.
3. When the next record would cross a segment ceiling, sync and seal the current
   segment, persist its seal, create the next segment atomically, and then append.
   Rotation changes physical layout only; it does not renumber or delete history.
4. Replay first validates the committed head and all segment ranges/digests in order,
   then decodes one bounded record at a time and updates projections in bounded
   batches. A projection checkpoint can accelerate replay only when its source head
   digest is verified. Do not `read_to_string` a whole thread or build an unbounded
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

**Source status (2026-09-28, `AX-358`).** The shared framing is implemented in
`horizoncode-eventlog` and consumed by nothing yet. It provides the canonical
event envelope with a `blake3` digest over a versioned domain and sorted object
keys, bounded segments that rotate on the `DEC-058` byte/event ceilings, seals
written and synchronized before a successor segment receives a record, an
atomically replaced committed head with typed absent/malformed/unreadable states,
an OS-backed writer lock, streaming replay with a per-line ceiling, refusal of a
newer schema version before any segment is decoded, preservation (never
truncation) of bytes beyond the head, and lower-only limits resolved from the
`horizoncode-config` storage schema. The commit order is pinned by tests: a line
is durable before the head acknowledges it, and a seal precedes the successor.

**Not covered here.** The thread store still uses its single-file layout until
the `AX-350` migration; the run/task/attempt/spec/evidence payloads and the
rebuildable projections are `AX-309`; explicit recovery of an uncommitted tail is
`AX-311`; the physically allocated control reserve and storage reservations are
`AX-350`/`AX-312`.

The current implementation's single-file/full-read behavior is recorded in
`ARCH/24` `F-61`; it does not meet this proposed contract.

### Commit durability backend

A durability profile names what a commit acknowledgement has actually flushed on the
host that produced it, not what the host is assumed to do:

| Profile | Contract | Refusal |
|---|---|---|
| `interactive` | append is flushed, and `fsync`ed when configured; the containing directory is **not** synchronized. Visible only as interactive work. | never presented as crash-durable |
| `run_durable` | the event file's bytes are synchronized **and** the containing directory entry is synchronized after any create/rename/seal/head replace, before the caller is told the step committed | refused where the backend cannot prove the directory step; refusal is a typed error, not a warning |

A durability backend is exactly two capabilities — `sync_file` and `sync_dir` — plus a
declaration of whether it can provide the `run_durable` contract on this platform. A
failed sync never returns a durable success, and the `run_durable` profile cannot be
combined with a disabled per-append sync. Recording the backend, the filesystem, and
the assumptions it makes is the acceptance obligation (`ACC-P1-13`), not a source-level
`sync` call.

**Source status (2026-09-28).** The backend abstraction, the two profiles, the
`sync_file`→`sync_dir`→acknowledge ordering, and the refusal rules are implemented in
the thread store (`durability.rs`); tests assert the ordering and the failure paths
with an injected backend. The physical control/recovery **reserve** and the segmented
rotation that a multi-hour run needs are not implemented (`AX-350`), so `run_durable`
currently promises namespace durability of the event log only.

### Read-only and recovery API boundary

`read_only`, status, list, export inspection, and index verification are pure with
respect to canonical storage: they do not truncate bytes, append synthetic events,
advance the committed head, or run repair. A listing whose projection is missing or
stale may report that state and offer recovery; it does not silently call `load` if
that path can write. The explicit `recover(thread_id, expected_head, recovery_id)`
operation runs under a recovery lease, hashes and preserves the source generation,
reconciles its committed head and pending effect IDs, then either writes a new
generation with deterministic closers or returns typed `UNKNOWN`/
`INSUFFICIENT_EVIDENCE`. Replaying the same recovery ID/payload is idempotent; a
changed payload conflicts. `read_only` remains byte-identical even when the last
record is incomplete. This contract is `DEC-056`; the current mutation on read path
is `F-62`.

**Source status (2026-09-28).** One pure scanner now backs `read_only`, `scan`,
`inspect`, and enumeration: it never truncates a torn tail, never appends, and never
advances any pointer, and it reports an incomplete final row as `RECOVERY_PENDING`
with its byte count. The repairing load path is separate and is reachable only from an
explicit write-capable call. The `recover(thread_id, expected_head, recovery_id)`
operation itself is **not** implemented: effect reconciliation and the quarantined
new-generation append are `AX-311`, so a torn tail is currently retained and reported
rather than repaired by a read.

### Blob reference and commit protocol

`BlobRef = { blob_id, digest, media_type, encoded_bytes, schema_version }` is the only payload representation in a committed thread event. Inline event data has a hard serialized-byte limit; per-blob, aggregate-thread, decoded-pixel/decompression, and request-context limits are separately enforced from effective user/policy settings. Defaults and supported media types belong to the shipped config schema, not hidden constants; policy may lower but never raise the compiled safety ceiling. A `thread_blob` projection indexes `blob_id`, digest, size, media type, event/checkpoint references, verification state and retention state. Blobs are thread-scoped (no cross-thread dedup) to keep ownership and deletion unambiguous. `blob_id` is immutable within a generation; references bind both ID and digest so a same-ID/different-content replay is a hard integrity error.

Ingest holds the per-thread writer/quota lease and streams to an exclusively created, no-follow temporary file beneath that thread's artifact root. It enforces the encoded-byte quota while streaming (before buffering/allocation), records the actual length, sniffs rather than trusts the declared media type, hashes the exact stored bytes, flushes the file, atomically publishes within the same filesystem to `blobs/blake3/<digest>`, and flushes the directory using the host's declared durability backend. If a digest-named object already exists, verify its bytes and metadata; never replace it blindly or follow a symlink. Only after the object is durably published may the writer append and flush the bounded event carrying its `BlobRef`. SQLite rows and the manifest follow as rebuildable projections. A crash before event commit can leave only an orphan object; GC may remove it only after a grace interval and a complete mark of canonical logs, retained generations, checkpoints, task evidence, retained export jobs and active leases. Refcounts alone are insufficient. If the filesystem cannot provide the configured atomic-publication and durability contract, refuse a requested durable run/thread; a weaker profile is allowed only for explicitly labeled non-run interactive use and can never be presented as crash-durable.

Replay validates digest, byte length, schema and effective limits before any blob is supplied to the model, UI decoder, verifier, or exporter. Decoding is isolated and bounded by format-specific expansion, dimensions/pixels, recursion and time limits; a MIME label or file extension is never proof that bytes are safe. For image input, provider rendering requires a vision-capable selected route, a successful bounded decode/validation, egress authorization, and context/token budget admission; request-body encoding is ephemeral and does not rewrite the canonical artifact. Missing, corrupt, over-limit, unsupported-schema, or unsafe-media objects produce typed `ArtifactUnavailable`/`ArtifactRejected` records and visible placeholders; they must not become empty text, be silently dropped, or satisfy acceptance evidence. Renderers must not execute active content such as SVG/HTML. Export includes each referenced object and a digest manifest; import verifies all files before publishing the copied thread. Any old format with inline payloads is migrated copy-on-write into a new immutable thread generation with a parent-log digest, streaming to blobs and validating the complete replay/ref graph before an atomic generation-manifest switch. Never rewrite the original append-only log in place; retain the original generation until migration and retention checks complete (`REQ-SESS-005`).

An incomplete provider response uses `assistant/attempt` with
`{ attempt_id, logical_step_id, state: truncated | failed, finish_record,
partial_ref?, usage_ref?, created_at }`; no `assistant/message` event is emitted until
the full response is complete and validated. Replay preserves attempts for history and
cost but excludes their partial content from the model-visible conversation. A retry
is a new `attempt_id` under the same `logical_step_id`, and the durable recovery-depth
record prevents a second truncation retry after restart.

Representative vocabulary (additive evolution only):

| Family | Normalized Thread type | Version 1 persisted spelling |
|---|---|---|
| Thread | `thread/created` | `session/created` |
| Thread | `thread/updated` | `session/updated` |
| Thread | `thread/title-changed` | New in Thread format v2 |
| Thread | `thread/closed` | `session/closed` |
| Thread | `thread/end-seed` | `session/end-seed` |
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
| `thread` | `id` | list/search; mirrors the header |
| `thread_event` | `(thread_id, seq)` unique | rebuildable bounded-page index; `type`, `time`, `segment_id`, offset, event digest |
| `thread_log_head` | `thread_id` | committed sequence/digest, segment digest, durability profile; verified against bytes before use |
| `thread_log_segment` | `(thread_id, first_seq)` unique | range, event count/bytes, seal digest and predecessor; rebuilt/verified from files |
| `thread_message` | `id`; idx `(thread_id, seq)` | decoded model-visible projection built from the log |
| `thread_input` | `id`; unique delivery ID plus payload digest, lane, origin/source reference, sequence, result and promotion state; partial unique for pending entries | durable admission receipt, dedupe, and promotion ordering; an agent message stores a checked Run/message reference rather than a copied canonical body (`ARCH/32`) |
| `thread_context_epoch` | `thread_id` | `baseline`, `snapshot`, `baseline_seq` |
| `thread_checkpoint` | `id` | `scope`, `kind`, `content_ref`, `reconstructable`, `version` |
| `thread_blob` | `(thread_id, blob_id)`; unique digest within thread | Rebuildable ref manifest, byte length/media type, verification and retention state; never stores blob bytes |
| `artifact_migration` | `(thread_id, migration_id)` | Rebuildable UI/status projection: source generation/log digest, target generation, verified-object count, phase and terminal result; correctness does not depend on it, and a crash may discard/rebuild the target from the authoritative source |
| `thread_revert` | `thread_id` | active staged rewind (`message_id`, `snapshot`, `files`, `diff`) |
| `subagent_catalog` | `(thread_id, child_id)` | durable child facts inherited by forks |

Constraints mirror the reference discipline: `seq` is unique and dense per thread, the committed log is append-only, and message/input/context rows are projections — never authoritative. The projection must stream/rebuild without holding the full log or full message history in memory.

### Context epoch

A single row per thread: `baseline` (system-context generation text), `snapshot` (structured generator state), and `baseline_seq` (the log sequence the baseline was built at). `CMP-context` prepares or advances the epoch; this store validates that a compaction event at a seq greater than `baseline_seq` forces a rebuild rather than a silent reconcile.

### Checkpoint and snapshot integration

- `Checkpoint.scope` = `work` · `context` · `thread`; `kind` records the producer.
- `reconstructable` distinguishes deterministically produced checkpoints from model-written ones.
- File trees are captured as start/end snapshots around each step; `step/end` carries the end snapshot and the changed-file list.
- Rewind is staged, not immediate: `revert/staged` plans the file-tree restoration back to a message boundary; `revert/committed` or `revert/cleared` finalizes. A newer write invalidates a staged snapshot.

## Lifecycle & flows

### 1. `create`

Resolve the workspace identity; mint a uuidv7; write `header.json`; append `thread/created` with the model, mode and permission snapshot; initialize the context epoch; register the thread in the index. No event is written without a durable flush before the call returns.

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

Query the index (`workspace_id`, `status`, `parent_thread_id`, recency). Listing never
touches a live thread's writer lock and does not load/recover logs. The store returns
typed per-thread integrity states and `enumeration_complete`; a failed directory
scan, iterator item, index read, or corrupt thread is surfaced, never dropped or
rendered as an empty store. A separate operator action may request read-only
verification or explicit recovery.

### 4. `fork`

A fork is a durable child, not a prompt splice. Copy only the verified committed event
prefix through a chosen boundary; never recover or alter the parent's log as a side
effect. Append a `thread/end-seed` marker (`inherited: true`) recording the inherited
cut, then append deterministic closer events in the child for any open turn at the
fork boundary. The child records its `parent_thread_id`, inherited event count and lineage
in the header. `subagent/catalog` child facts before the final inherited cut belong to
the parent; facts after it are appended to the child.

### 5. `close`

Append `thread/closed`; refuse further admission; release any concurrency slot; allow replay and `resume` later. Closing a parent cascades to descendants' cascade policy but never rewrites their logs.

### 6. Input admission and promotion

- Admitted input is durably recorded with a `delivery` of `steer` (interrupt-level redirection, the next step boundary) or `queue` (the next turn).
- Each input records an authenticated `actor` and origin (`USER`, `CONTROLLER`, or `AGENT_MESSAGE`). An `AGENT_MESSAGE` is peer data, never treated as user steering or operator approval; its Run/message ID and digest are resolved through `CMP-orch` membership checks before promotion. Peer messages cannot overtake cancel, pause, approval, permission-control, or explicit user-steering lanes; their bounded fair service order is defined in `ARCH/32`.
- Admission is idempotent by input id and payload digest: matching replays return the original receipt; a reused ID with changed content returns a typed conflict. Bound pending count, payload bytes, age, and per-lane service; never drop on compaction or client reconnect (`REQ-LOOP-007`).
- Promotion at a boundary: service eligible steers before the next step but cap the batch; then promote queued turns using a persisted fair cursor and age/deadline policy. An infinite steer stream must not starve queued prompts, and background work must not starve control/cancel/approval actions (`REQ-HORIZON-014`). A promoted steer resets the step counter; queued promotion starts a fresh turn.
- Promotion is itself an event (`input/promoted`), so replay reconstructs exactly which inputs were consumed and when. Injected context (not user-facing) waits behind the same `next-step` boundary; it never interleaves mid-step (`REQ-LOOP-002`).

### 7. Per-key run coordinator

The coordinator serializes execution for each thread key while allowing different keys to run concurrently (`REQ-LOOP-002`).

- `resume(key)` — start a drain if idle, or join the active drain.
- `wake(key)` — request a coalesced follow-up; repeated wakeups collapse to one.
- `interrupt(key)` — mark stopping, clear the pending wake, and cancel the active drain; idle interrupt is a no-op.
- A follow-up drain starts only after the current drain settles, and `pendingWake` is cleared at start so a late wake cannot double-run.
- This coordinator is local to one thread-store process. A detached run across client disconnects requires the separate durable owner lease/fencing protocol in `CMP-orch`; process-local mutual exclusion alone does not authorize safe recovery or multi-process writes (`ARCH/25`).

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
the recovery record; lack of sufficient effect evidence leaves the thread in
`RECONCILING` instead of repairing by guess (`DEC-056`, `REQ-SESS-006`).

### 11. Portability and replay

Replay folds the log with the same `surfaceOp` semantics used when it was written, producing identical message, prompt, inbox and run projections. Because deltas are not persisted, a replay reconstructs settled messages, not keystrokes; this is intentional. A thread copied to another host replays if its `format_version` is supported.

Checkpoints and portable-thread export include a closed-world blob manifest. Creating a checkpoint pins every payload reachable from its event boundary; fork copies or links through explicit immutable refs and preserves parent ownership; rewind never deletes blobs referenced by another checkpoint or evidence object. The UI shows a thumbnail/typed attachment row only after validation, with media type, original size, and unavailable/corrupt reason; it never tries to render arbitrary active content or hide a failed attachment behind a blank tile.

### 12. Migration chain discipline

- The physical format advances one version at a time. Each adjacent migration declares `fromVersion`/`toVersion` (`to == from + 1`), a header transform, a streaming event stage, and a target-header validator.
- A **build-static catalog** compiles the chain at startup and refuses to build if a version is missing, duplicated, or newer than the current build. A log whose stored version is newer than the build is refused with a typed "unsupported" result, never partially decoded.
- Migrations are **streaming and pure**: they transform events in `seq` order, preserve the inherited cut, and validate target invariants (for example, a turn boundary may not cross an open step).
- A delivery-accepted marker records the format version a thread was last admitted under, so downgrade and cross-build reads stay explicit.
- Replay validation runs against the current invariant set; a migration that cannot satisfy it refuses rather than emitting a lossy result.
- Blob migrations verify every output digest and the complete new generation's event/blob graph before manifest switch; a crash resumes from an idempotent migration journal or keeps the old generation authoritative. Unsupported future blob schemas fail typed before partial replay.

## Failure modes

| Failure | Behavior |
|---|---|
| Crash mid-turn | Explicit recovery closes the committed open turn deterministically only after effect reconciliation; committed steps remain untouched (`REQ-LOOP-006`). |
| Torn/uncommitted log tail | Read-only access changes no bytes. Recovery preserves/hash-pins the tail, reconciles effects, and either resumes in a new generation or returns `UNKNOWN`; never silently truncates in place. |
| Index drift / missing rows | Rebuild affected rows from the log; the log is truth. |
| Two writers, one thread | Coordinator admits one active drain; a second `resume` joins rather than forks state. |
| Un-promoted input after crash | Admission rows survive; promotion re-derives from the log at the next boundary. |
| Corrupt or unknown event type | Typed decode failure; the thread loads as unsupported rather than silently skipping. |
| Thread listing scan/index/read failure | Return `enumeration_complete=false` and typed issue or visible unavailable entry; never omit the problem or return empty success. |
| Stored format newer than build | Refused with an "unsupported version" result; no partial migration. |
| Blob missing/corrupt/schema too new | Emit a typed unavailable artifact and preserve the event/ref; block any task evidence depending on its contents. |
| Blob write crash/disk full | No referencing event commits; temporary/orphan bytes are collected only after mark-and-grace reconciliation. |
| Inline or decoded media exceeds limit | Reject with exact effective limit before unbounded allocation/use; do not truncate and masquerade as the original payload. |
| Filesystem lacks requested durable atomic publication | Refuse durable artifact commit or expose an explicitly configured weaker persistence guarantee; never claim a durable write. |
| Digest path exists with mismatching bytes, metadata, or symlink | Typed integrity/path error; do not overwrite, follow, or append an event reference. |
| Concurrent writes race the thread byte ceiling | Serialize/reserve quota under the thread lease; exactly one admissible write may consume the remaining quota. |
| Export/import interrupted | Preserve source; publish no partial exported/imported thread; resume or discard only through a journaled idempotent operation. |
| Workspace moved/renamed | Resume re-resolves identity; typed `NotFound` + re-point guidance, never a guessed path. |
| Rewind against a stale snapshot | Staged snapshot invalidated by a newer write; re-stage required. |
| Duplicate child catalog fact | Refused (conflicting `child_id`) rather than merged. |

## Configuration

| Setting | Owner | Default | Effect |
|---|---|---|---|
| `session.retention_class` | `CMP-session` | `interactive` | Hibernation/archive thresholds; `session` is a retained config namespace, not a second domain identity |
| `session.log.fsync` | `CMP-session` | flush per committed step | Durability vs throughput (`REQ-LOOP-006`) |
| `session.log.durability_profile` | `CMP-session` | `run_durable` for any multi-hour run; `interactive` only where policy permits | Effective backend/profile is recorded; a multi-hour run refuses unsupported durability or disabled sync |
| `session.log.max_event_bytes` / `max_segment_bytes` / `max_segment_events` / `max_session_event_bytes` | `CMP-session` | `DEC-058`: 256 KiB / 8 MiB / 4,096 / 256 MiB | Bound each record, file, and Thread stream; event bytes have a separate ledger from blob bytes |
| `session.log.control_reserve_bytes` / `replay_batch_events` | `CMP-session` | `DEC-058`: 4 MiB / 256 events | Preserve terminal/reconciliation capacity and bound replay allocations |
| `session.migrate.strict` | `CMP-session` | `true` | Refuse unknown/newer versions rather than best-effort |
| `session.artifacts.max_object_bytes` / `max_session_bytes` | `CMP-session` | `DEC-058`: 64 MiB / 1 GiB | Encoded payload ceilings; managed policy may lower them, never raise compiled safety ceilings |
| `session.artifacts.max_decoded_pixels` / `max_expansion_ratio` | `CMP-session` | `DEC-058`: 16,777,216 pixels / 128:1, 5 s timeout | Decoder resource ceiling before image/media render or model use |
| `session.artifacts.retention_days` / `orphan_grace_hours` | `CMP-session` | `DEC-058`: 30 days / 24 h grace | GC eligibility; referenced/checkpointed/exported evidence remains pinned |
| `context.compaction.keepTokens` / `buffer` | context | ~8k / ~20k | Projection boundary sizing (`REQ-CTX-002`) |
| `thread.checkpoint.cadence` | thread | step boundary | Checkpoint production points |
| `orch.max_depth` / `max_parallel` | orch | bounded | Child thread admission (`REQ-ORCH-005`) |

The existing `session.*` storage-settings namespace is retained as the canonical compatibility key set from `DEC-058`; it configures the `CMP-session` implementation that stores HorizonCode Threads, not a second Session entity. Do not also register `thread.*` aliases. A future key rename requires a versioned configuration migration. Thread-level runtime configuration is layered (`defaults → user → workspace → agent profile → thread`) and the effective model/mode/permission snapshot is persisted with the Thread (`REQ-SESS-004`).

## Requirements mapping

| Requirement | How this document satisfies it |
|---|---|
| `REQ-SESS-001` | Bounded, digest-linked segmented event stream with a verified committed head and rebuildable index; resume only from committed state. |
| `REQ-SESS-002` | Streaming replay of committed segments yields identical projections; inspection is read-only, while interrupted-tail recovery is explicit, byte-preserving, and effect-reconciled. |
| `REQ-SESS-003` | Checkpoint storage and staged rewind to a turn boundary. |
| `REQ-SESS-004` | Model, mode and permission snapshot persisted on the thread record. |
| `REQ-SESS-005` | Immutable per-thread blobs, digest references, replay validation, copy-on-write migration, safe GC and visible unavailable states. |
| `REQ-SESS-006` | Segmented append, committed-head integrity, streaming replay, finite event quota, protected control reserve, retention-safe cleanup, read-only non-mutation, visible enumeration failures, and platform durability. |
| `REQ-SESS-007` | Rebuildable FTS5 projection, literal word/phrase query grammar, thread/project/date filters, rename-stable IDs/current labels, exact-message revalidation/navigation, and typed partial-coverage results. |
| `REQ-HORIZON-027` | Run event segments, per-action storage reservations, physical emergency reserve, crash-durable run profile, quota fence, and truthful resource stop. |
| `REQ-LOOP-002` | Input admission table + steer/queue promotion ordering. |
| `REQ-LOOP-006` | Every committed step is appended and flushed before the next phase. |
| `REQ-HORIZON-001` | Thread resumable after an arbitrary gap with task state intact. |
| `REQ-HORIZON-002` | Log-projected task/todo state survives compaction and restart. |
| `REQ-HORIZON-003` | Per-thread usage aggregates persisted for budget enforcement. |
| `REQ-ORCH-001` | Sub-agents are isolated child Threads, addressable by id. |
| `REQ-ORCH-002` | Child sessions may carry a worktree workspace reference. |
| `REQ-PROTO-001` | ACP session create/load/resume/list/close map to a HorizonCode Thread and its external ACP-session binding; the ACP session ID is never used as `ThreadId`. |
| `REQ-PROTO-005` | All surfaces consume the same store projections. |
| `REQ-CTX-004` | Epoch + compaction events let the runner retry the same step after overflow. |
| `REQ-AUDIT-001` | Security-relevant events are mirrored to the audit chain. |
| `REQ-SEC-002` | Persisted tool output and external content are stored as data, never instructions. |

## Open questions

1. **Index split — resolved.** One global rebuildable `state.db` indexes Threads; canonical logs/blobs remain per Thread. Index loss degrades search to a truthful rebuild/partial state, not lost history.
2. **Multi-node ownership — deferred.** The per-key coordinator is process-local in v1. A clustered owner using leases/epochs is outside v1; same-Thread single-writer behavior must still be fenced across local processes.
3. **Storage values — selected, validation pending.** `DEC-058` owns the event, segment, Thread artifact, and replay ceilings. They require workload/platform benchmarks before status can become verified. Segment rotation is not pruning; archives do not replace a verified committed head.
4. **Fork boundary — v1 decision.** Fork only at a committed turn boundary. Mid-turn fork requires a separate migration/recovery design; a partial turn is preserved for inspection but cannot be forked as though it had completed.
5. **Injected-context admission.** The exact classification rules for `next-step` injected context versus steered user input, and whether injected context is ever persisted as a user-visible message.
6. **Format-version policy for external agents.** Whether externally produced thread logs may be imported and migrated, or only replayed read-only.
7. **Artifact/storage validation.** Encoded per-object/Thread defaults, decoded media ceiling, event ceilings, and orphan-GC grace are selected in `DEC-058`. The separately protected physical disk reserve and the minimum capacity/profile across supported filesystems still need implementation evidence and laptop/server workload validation. There is no unbounded fallback.
