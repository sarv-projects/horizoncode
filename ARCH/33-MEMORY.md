# 33 — Memory (`CMP-memory`)

Status: **proposed target design; not implemented at source baseline
`23d4ce8` / repository HEAD `cbba87b` (2026-09-28).** `CMP-config` owns
settings only. `CMP-session` owns conversation history. `CMP-context` selects and
renders memory for a request. `CMP-memory` owns records, provenance, lifecycle,
conflict handling, and retrieval. Memory is neither policy nor proof of task
completion.

## Purpose and requirements

Meet `REQ-MEM-001..003`: retain bounded user/project knowledge independently of
chat transcripts; make every write attributable and inspectable; and inject
selected records as a typed, explicitly untrusted context source. Memory should
reduce repeated repository discovery without turning guesses, stale code facts,
or malicious workspace text into instructions with authority.

## Ownership and invariants

`CMP-memory` owns durable memory records and candidate-to-accepted lifecycle.
`CMP-config` validates scope/consent/retention settings. `CMP-context` requests a
bounded retrieval page and renders records with provenance and trust framing.
`CMP-session` may retain the user interaction/event that approved a write, but is
not the memory store. `CMP-orch` may link memory to a Run, but a memory record
cannot change a requirement, task status, budget, permission, or verifier result.

Invariants:

1. Every accepted record has a stable ID, scope, writer/approval provenance,
   source reference or an explicit `user_asserted` origin, content digest,
   creation/update sequence, and lifecycle state.
2. Model-generated candidates are never silently treated as user-confirmed facts.
   Automatic candidate extraction and automatic acceptance are separate settings.
3. Project-origin memory is untrusted repository data. It cannot add instructions
   that override user/managed instructions or grant tool/permission authority.
4. Retrieval is scoped to the active user/project and bounded by record count,
   bytes, and context-token reservation. A stale record may be shown with its age
   and source but must not be described as current source truth.
5. A record update creates a new revision or supersession link; it never erases
   provenance. Deletion removes content/indexes and leaves only the minimum
   tombstone needed to prevent stale projection resurrection.
6. Memory evidence never satisfies a verification or acceptance criterion.

## Data model

```text
MemoryRecord {
  memory_id: UUIDv7,
  scope: user | project,
  scope_id: opaque user/project identity,
  kind: preference | workflow | repo_fact | decision | pointer,
  state: candidate | accepted | rejected | superseded | expired | deleted,
  content: bounded UTF-8 text,
  content_digest: blake3,
  source_kind: explicit_user | approved_run | imported,
  source_ref?: {store, aggregate_type, aggregate_id, aggregate_seq, event_id,
                source_revision?, repository_identity?, workspace_id?,
                source_view?: committed | working_tree | editor_buffer,
                path?, file_digest?, dirty_generation?, buffer_digest?, span_digest?},
  freshness: CURRENT | SOURCE_CHANGED | SOURCE_UNAVAILABLE | SOURCE_UNVERIFIED,
  approved_by?: principal, approved_at?: sequence,
  confidence?: advisory numeric value (never authorization evidence),
  created_seq, updated_seq, expires_at?, supersedes_memory_id?,
  last_retrieved_at?, schema_version
}

MemoryCandidate {
  candidate_id, proposed_record, source_refs[], extraction_model?,
  extraction_config_digest, created_seq, review_state
}
```

The v1 defaults are settled by `DEC-067`: user-global memory is limited to
preferences/work habits; project memory holds repository facts/decisions under a
stable repository identity; retrieval is local and scope-filtered; cross-project
retrieval is off; explicit `/memory remember` creates a reviewable candidate;
automatic extraction is off; automatic acceptance is always off. A user can disable
retrieval without deleting records, and can inspect/export/purge each scope. No remote
index or embedding provider is required by v1.

The canonical store is a versioned local SQLite database under the shared
HorizonCode state root. It owns an append-only `memory_event` sequence; each
candidate, approval/rejection, accepted revision, supersession, and deletion
tombstone is committed with its materialized `memory_record`/FTS projection and
outbox row in one SQLite transaction. Thus SQLite's event table is the canonical
memory history; the independent Run/Thread and audit stores are not falsely
described as atomically committed with it. Their references are delivered through
an idempotent durable outbox, and reconciliation can rebuild those references from
the memory event ID/digest. The UI reports `committed_audit_pending` while a required
redacted audit receipt is still in the outbox; it never claims the audit receipt is
durable until the audit owner confirms it. A committed deletion remains deleted
even if its audit outbox is pending, and the tombstone prevents stale backup restore
from resurrecting content. FTS tables and any future embedding index are derived
projections with schema/version digests and deterministic rebuild. No embedding
provider is required for v1. Store content separately from query telemetry; never
send memory to a remote index by default. Multi-process writes use a transaction,
OS-backed writer coordination, and unique `(scope, scope_id, memory_id)` identity;
the Run/Thread stream contains references, not a second copy of canonical memory
content.

Bounds are configuration values owned by `CMP-config`: maximum record bytes,
records per scope, total bytes per scope, candidate queue size, retrieval count,
retrieval bytes, and TTL. Finite default bounds and retention values remain
implementation decisions and must be documented in settings before release;
exceeding a bound returns a visible typed result and never silently discards
accepted records.

**Compaction policy (v1).** There is no background summarization, automatic
consolidation, or silent eviction. At a configured high-water mark, new candidates
and writes receive a visible `MEMORY_CAPACITY_REACHED` result; accepted records
remain readable. The user can inspect, create a replacement candidate, explicitly
approve supersession, and purge records/scopes. Superseded content is retained under
the configured retention policy until the user purges it or its disclosed expiry
applies. A future summarizing/consolidating compactor requires a separate decision,
must preserve source lineage, produce a reviewable candidate, and cannot delete
inputs until explicit approval and retention handling are complete. This satisfies
the requirement for a defined compaction policy without running an unbounded model
summarizer in the background.

## Write, review, retrieval, and deletion flows

### Write

1. A user explicitly asks to remember a fact/preference, or enables candidate
   extraction. Extraction writes `candidate`, never `accepted`.
2. The candidate records source references and a digest. Secret scanning is a
   best-effort filter, not a guarantee that workspace secrets are detected.
3. The user reviews scope, wording, source, and retention. One SQLite transaction
   appends the approval event, promotes the exact candidate revision, and creates
   stable Run/Thread/audit outbox references. A stale source digest, changed
   candidate, or stale review revision requires review again. A lost response is
   resolved by the same request ID, not a second approval.
4. A model tool cannot write directly to the accepted store. If a future
   `memory.remember` capability is added, it submits a candidate through the
   same review/consent path and cannot set provenance or approval fields itself.

### Retrieve / inject

1. `CMP-context` sends a typed query containing user/project scope, task text,
   repository identity, selected workspace, source view (committed tree, working
   tree, or editor buffer), and a byte/token budget.
2. `CMP-memory` returns ranked record IDs, exact record revisions, provenance,
   age/state, and bounded excerpts. Filtering by scope and accepted-state occurs
   before ranking.
3. The caller binds the selected records and digests to the `ContextEpoch`.
   Project memory is wrapped as untrusted data, separate from instructions. If a
   record is unavailable or stale, context reports that status rather than
   silently using a prior copy.
4. Retrieval usage may inform later ranking/decay, but frequent retrieval does
   not increase factual confidence.

### Inspect, supersede, and delete

Users can list/search records by scope, kind, age, source, and state; inspect the
source; edit by creating a new revision; reject candidates; supersede stale
records; and delete a record or an entire scope. Deletion transactionally removes
the content and derived search rows, emits a redacted audit reference, and
rebuilds projections without the record. Backup/restore and export behavior must
make deletion semantics explicit; a restored older database must not reintroduce
deleted content after tombstone compaction.

## Conflict, staleness, and prompt-injection handling

- Conflicting accepted records remain visible as a conflict set until a user
  resolves them; retrieval does not pick a winner solely by recency or model
  confidence.
- A repository fact records repository identity, source revision, workspace identity,
  source view, path, file digest, dirty generation or buffer digest, and span digest
  where applicable. `CURRENT` means the exact recorded source view/digests match the
  current query workspace; Git `HEAD` alone is insufficient. If the file/dirty buffer
  differs, the workspace is unavailable, or the current source view cannot be
  compared, set `SOURCE_CHANGED`, `SOURCE_UNAVAILABLE`, or `SOURCE_UNVERIFIED` and
  exclude the fact from default factual retrieval. Present it for evidence-backed
  revalidation as a new candidate.
  Never rewrite the accepted record's provenance in place. User preferences do not
  become stale merely because the repository changes.
- Retrieved content is data. The context renderer labels scope, origin, and
  trust; instruction delimiters cannot elevate it into a system/developer role.
- Memory is excluded from policy evaluation, command parsing, permission tickets,
  approval evidence, and verifier inputs unless a test explicitly treats it as
  untrusted adversarial input.

## Failure and recovery

| Failure | Required behavior |
|---|---|
| Corrupt database/schema too new | Preserve original bytes, report typed recovery-required status, do not replace with empty memory |
| Crash before SQLite transaction commit | Candidate/approval/deletion event, projection, tombstone, and outbox are all absent; retry uses stable request ID |
| Crash after SQLite commit before audit/Thread delivery | Canonical memory event and projection remain committed; durable outbox retries idempotently and UI reports pending audit delivery |
| Outbox target is permanently unavailable | Do not claim cross-store audit completion; retain outbox, surface typed pending/failure, and never duplicate the memory event |
| FTS/index lag or corruption | Report indexed sequence/coverage; rebuild from canonical records; never turn incomplete search into a complete miss |
| Source/dirty-buffer digest changed | Keep candidate/history, mark `SOURCE_CHANGED`, do not silently rewrite provenance |
| Workspace or editor buffer cannot be compared | Mark `SOURCE_UNVERIFIED`; exclude repository fact from default retrieval |
| Disk full / scope limit | Refuse new write with visible reason; existing accepted data remains readable |
| Concurrent edit/delete | Compare expected revision; return conflict or idempotent deletion receipt |
| User disables memory | Stop new writes/injection as configured and provide inspect/purge; do not infer deletion from disabled retrieval |
| Backup restore after delete | Apply retained deletion tombstones or require explicit user confirmation before resurrecting data |

## Privacy, security, and operations

Memory is local-first. An export is an explicit user action and includes the
source/trust metadata needed to inspect each record. Known credentials are
rejected/redacted before persistence, but arbitrary workspace secrets remain a
documented residual. Project scope is repository-specific and is never shared
across unrelated projects by basename. File permissions/ACL and symlink rules
match `ARCH/18` state handling. TTL/size limits bound storage; retention cleanup
does not delete accepted durable records without a configured and visible policy.

## Verification plan

Acceptance must cover the chosen explicit-candidate and scope defaults, finite
per-scope bounds and retention, export/purge semantics, and
explicit consent, model-generated candidate review, forged provenance, cross-
project isolation, conflicting records, source staleness, prompt injection,
secret canaries, deletion/rebuild/restore, crash boundaries, two-process writes,
quota exhaustion, disabled-memory behavior, exact `ContextEpoch` provenance,
crashes immediately before/after SQLite commit and before/after outbox delivery,
idempotent audit/Thread reconciliation, clean-vs-dirty repository trees, file rename,
dirty generation changes, and unsaved-buffer digest mismatch.
Memory retrieval must also be compared with a no-memory baseline on repeated
repository tasks; fewer tokens alone is not a success metric.

## Source status and provenance

The current Rust config code discovers instructions and skills, but no persistent
memory service, record schema, indexing, or retrieval path is present in the
source map. Codex's two-phase memory extraction/consolidation pipeline is a
research reference, not a copied implementation; see `research docs/codex-memory.md`,
`ARCH/26`, and the license/provenance gate in `ARCH/05`. No memory code is copied.

## Requirements mapping

`REQ-MEM-001..004`; `REQ-CTX-007`; `REQ-SEC-002`.
