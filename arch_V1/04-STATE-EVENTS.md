# 4. Events, persistence, and recovery

## 4.1 Canonical owners and streams

Each fact has one write owner and one append-only canonical stream. The owner emits
monotonic sequence numbers only within its stream; there is no invented global total
order. Cross-owner causality uses stable IDs and linked cursors/digests.

| Stream/store | Owner | Canonical contents |
|---|---|---|
| Thread event streams | Rust ThreadService | Thread identity, legacy Session aliases/import facts, inputs, promotions, Turns, messages/parts, context epochs, questions, ToolBatch lifecycle, direct-tool result links and DirectDelegation lifecycle |
| Goal/Run event streams | RunController | Goals, SpecVersions, Runs, Task DAG, Attempts, WorkerExecutions, dispatch decisions and terminal predicates |
| Workspace streams | WorkspaceService | Workspace identity/revisions, leases/fences, integration and conflict receipts |
| Usage streams | UsageService | Append-only provider/worker usage observations with reported, derived, estimated, external-peer and unknown provenance |
| Budget streams | BudgetService | Budget policy revisions, hierarchical reservations, accounting settlement decisions referencing UsageObservationIds, and residual uncertainty; not raw usage observations |
| Verification streams | VerificationService; RunController accepts Task/Run consequences | Verification permits, verifier observations and Evidence; no worker-authored PASS |
| Repository intelligence streams | RepoIntelService | Derived RepoGeneration lifecycle and query provenance; no canonical workspace or Guard facts |
| Memory streams | MemoryService | Advisory provenance-bearing records, tombstones and scope generations |
| Composition streams | Sealed CompositionService | Plugin manifests/approvals, immutable composition locks, generation lifecycle and host activation observations |
| Supervisor stream | Kernel supervisor | Owner epochs, dispatch outbox claims, process reconciliation and recovery checkpoints |
| Effect-owner stream | EffectService, linked to the initiating domain | Prepared/dispatched/settled/unknown effects and reconciliation facts; Guard owns approval challenge/resolution records linked by IDs/cursors |
| Guard/policy stream | Guard | Effective policy snapshots, authorization decisions, approval challenge lifecycle and one-use grant resolution |
| Audit chain | Audit service | Security-relevant actor/action/decision/receipt facts and integrity linkage; not a duplicate Run transcript |
| Artifact CAS | Artifact service | Immutable content-addressed payloads bounded to 256 MiB each, with owner references, retention and redaction metadata |
| Host DB/projections | Host/UI and kernel projector | Rebuildable query models, search tables, generated SDK caches and UI state only |

If event streams and SQLite projections disagree, the canonical committed stream wins.
Projection ahead of canonical head is corruption: fence writes and recover/diagnose; do
not promote the projection to truth.

## 4.2 Logical event contract

```rust
struct EventEnvelope<P> {
    schema_version: u16,
    owner_kind: OwnerKind,
    owner_id: OwnerId,
    seq: u64,
    event_id: EventId,
    event_type: EventType,
    actor_ref: ActorRef,
    causation_id: Option<EventId>,
    correlation_id: Option<CorrelationId>,
    payload_digest: Digest,
    previous_event_digest: Digest,
    event_digest: Digest,
    payload: P,
}
```

This is the **logical domain contract**, distinct from the versioned physical record.
The historical `horizoncode-eventlog` source was not recovered after the fresh-Git
reset. On 2026-10-09 the user approved an explicit OwnerLog V2 physical format
migration rather than claiming compatibility or introducing SQLite as a second
authority. OwnerLog V2 is the single canonical Rust persistence engine. This is not a
port or compatibility claim for the missing crate; unknown/legacy formats are preserved
read-only and refused for writes until a separately verified importer exists.

OwnerLog V2 stores per-owner canonical JSONL segments and one committed head. A physical
record has fixed field order: `format_version`, `seq`, `time_ms`, `kind`, `data`,
`previous_digest`, `event_digest`. Format version is `2`; `data` is a bounded JSON object
carrying the versioned logical payload. The command writer stores `schemaVersion` and
`payload`, plus `deliveryId` and its `commandDigest` together when the event belongs to a
delivered command; those two command fields must either both be present or both absent.
Object keys inside `data` are recursively sorted; arrays retain semantic order; strings
are hashed as stored UTF-8 with no normalization.
The physical event digest is BLAKE3 over the exact canonical JSON record bytes with the
`event_digest` field omitted; the JSONL line terminator is excluded. Logical `payloadDigest` retains
the §12.1/§4 family-payload preimage and is not a second physical chain.

The V2 committed head uses fixed field order: `format_version`, `owner_kind`, `owner_id`,
`schema_version`, `generation`, `durability_profile`, `committed_seq`,
`committed_event_digest`, `active_segment_id`, `committed_offset`, `head_digest`. The
durability profile is `interactive_only` or `run_durable`; the profile label does not
establish backend capability or acceptance. `head_digest` is BLAKE3 over the
canonical head JSON with `head_digest` omitted; its line terminator is excluded. Segment
IDs are monotonically increasing within an owner. A seal uses fixed field order:
`format_version`, `segment_id`, `committed_offset`, `first_seq`, `last_seq`,
`record_count`, `last_event_digest`, `segment_digest`. `segment_digest` is BLAKE3 of
exactly the committed segment-prefix bytes, including each record's LF. The owner
directory is derived from BLAKE3 of `u32be(kind_byte_length) || kind_UTF8 ||
u32be(id_byte_length) || id_UTF8`; each identity field is nonempty and at most 256 UTF-8
bytes. The directory name is lowercase digest hex and never contains caller-provided path
text. Physical records are at most 1 MiB and segments at most 16 MiB; both bounds are fixed
kernel constants, not caller-controlled. An owner command contains 1–16,384 events; the
canonical command preimage and encoded segment are each bounded to 16 MiB.

Within the configured OwnerLog root, the V2 layout is `owners/<owner-key>/owner.lock`,
`head.json`, `segment-<20-digit-id>.jsonl`, and for sealed segments
`segment-<20-digit-id>.seal.json`. The owner lock is an exclusive OS file lock held for
the lifetime of the open owner, not a stale PID marker; a competing open fails without
mutating the stream. The head is the sole committed-prefix authority. During replay, each
record in every committed prefix must decode and re-encode to the exact original canonical
line; this also rejects duplicate JSON object keys that a value parser would otherwise
collapse. Unknown versions and corrupt committed bytes are read-only refusals that leave
all original bytes untouched.

The owner lock serializes cooperating opens; it is not mandatory write protection against a
process bypassing the lock while running as the same OS identity. The configured private
state root and its OS identity are the current trust boundary. Before acknowledging an append
or exact retry, an open owner compares the on-disk head and streams the complete committed
history again, fencing itself if a changed head or committed prefix is observed. This detects
prior same-length edits but does not claim protection against a concurrent same-identity
writer racing that verification; stronger same-identity isolation requires a separately
approved OS boundary.

The logical-to-physical mapping must preserve that single persistence engine:

- Owner identity and stream-local sequence come from the configured OwnerLog V2 stream
  and its committed head; do not add a global sequence or duplicate stream store.
- The typed logical event ID, per-event schema version, actor, causation/correlation
  IDs, payload digest and typed payload are represented in the bounded `data` object
  under one versioned owner payload schema. The physical row's `event_digest` is the
  event-chain digest; do not add a second competing event hash chain.
- Lifecycle tables use logical `event_type` names such as `thread/created`; the
  physical dotted `kind` is the exact reversible mapping obtained by replacing the
  single separator `/` with `.`, e.g. `thread.created`. Event names may not contain
  `.`, and the schema decoder rejects any non-canonical mapping. Thus the logical
  event type is recoverable without duplicating it in `data`.
- The physical row's `kind` remains that stable dotted event discriminator and `seq`,
  `time_ms`, `previous_digest` and `event_digest` are verified by OwnerLog V2.
- In the logical view, `owner_kind`, `owner_id`, `seq`, `previous_event_digest`, and
  `event_digest` are sourced from the configured stream and physical V2 record;
  they are not duplicated inside `data`. The physical `event_digest` is the logical
  `event_digest`, and the physical `previous_digest` is the logical
  `previous_event_digest`. `payload_digest` is exactly `"blake3:" +
  lowercase_hex(BLAKE3(canonical family-payload bytes))`. It covers the typed
  event-family payload (including `AggregateTransitionV1` when required) and excludes
  all `EventPayloadMetadataV1` fields, including `payloadDigest`; therefore it is not
  self-referential. The physical `event_digest` remains the existing event-chain
  commitment over the canonical physical event body, including bounded `data` and
  `payload_digest`; its own digest output field is excluded from that body.
- The V2 physical log stores BLAKE3 digests as 64-character lowercase hex; the
  logical `Digest` wire representation uses the `blake3:` prefix. Conversion is
  strict and lossless. Do not hash the physical row a second time to manufacture a
  new chain.
- OwnerLog V2 supports one stream per configured owner kind/ID. Migrating existing
  Session/Run streams and adding Thread/Supervisor/Effect streams require explicit
  compatibility and replay fixtures; the physical format alone does not implement
  those domain owners.
- If a required logical field cannot be preserved in the V2 payload schema or its
  digest/canonicalization contract, version/migrate OwnerLog before writing it; do not
  create a parallel SQLite/JSONL writer to bridge the gap.

Appending validates schema, owner sequence, previous digest, payload limit, lifecycle
transition, authorization and idempotency before commit. Unknown major schemas refuse
replay. The current Kernel foundation registers only `schemaVersion: 1`; unsupported or
unregistered versions are rejected before append and during open, without rewriting the
head or committed records. Event payloads do not contain raw credentials. Canonical log durability and
projection updates are separate operations; projection cursors make replay explicit.
Append ordering is: validate the complete owner command; durably publish referenced
immutable artifacts; append the whole bounded event batch; synchronize the segment; write
and synchronize a same-directory head temporary; atomically replace the committed head;
synchronize the parent directory when required by the profile; then acknowledge. If the
commit result is uncertain, retry/query with the same delivery ID. Recovery validates the
head and every committed segment prefix. Bytes after a committed offset are uncommitted,
are never promoted, are preserved for diagnosis, and cause subsequent appends to use a new
segment. Corrupt committed bytes fence the owner; there is no SQLite fallback. Unknown
format versions are rejected without rewriting data. Platform synchronization and
acceptance requirements are specified in §18.

Appending keeps a complete command batch contiguous in the active segment while that
segment has no uncommitted tail or seal and the full bounded batch fits. Otherwise it seals
the active committed prefix and starts a fresh monotonically increasing segment. Any
uncommitted suffix is preserved and forces rotation; it is never truncated or reused.
If a rotation wrote an unsealed segment before its head commit failed, a later committed
segment may leave a segment-ID gap. Replay may skip an unsealed gap only when its segment
file is a regular private file and every later committed segment validates as a direct
continuation of the preceding committed sequence and digest. A missing gap file, a seal on
an uncommitted segment, or any discontinuity remains corruption; segment IDs are never
reused.

For delivery idempotency, the kernel recomputes `commandDigest` as
`"blake3:" + lowercase_hex(BLAKE3(canonical_command_bytes))`. The canonical command is
the recursively key-sorted compact UTF-8 JSON object
`{"deliveryId":<delivery ID>,"events":[{"data":{"payload":<event data>,"schemaVersion":<u16>},"kind":<kind>,"timeMs":<safe integer>},...],"format":"horizon.owner-command.v1"}`.
Object keys are sorted recursively by UTF-8 bytes; array order is preserved. The supplied
digest must match this preimage before any write; optional per-event delivery metadata,
when supplied, must match the verified delivery ID and digest.

`CommitReceiptV1.receiptDigest` is `"blake3:" + lowercase_hex(BLAKE3(canonical_receipt_bytes))`.
The canonical receipt is compact UTF-8 JSON with recursively byte-sorted object keys for
`{"commandDigest":<digest>,"deliveryId":<id>,"eventCount":<u64>,"format":"horizon.owner-receipt.v1","ownerCursor":{"eventDigest":<digest>,"ownerId":<id>,"ownerKind":<kind>,"seq":<UInt64Decimal>}}`.
It binds the exact delivery identity and final owner cursor; the receipt itself is
reconstructed from committed event data during replay, not a separate authority.

Receipt and segment lookup indexes may be persisted in a rebuildable derived database so
replay and pagination do not retain lifetime-sized in-memory maps/vectors. Rebuild them by
streaming and validating canonical OwnerLog V2; never treat index rows as committed facts.
An unavailable, stale, or corrupt index is discarded/rebuilt, and exact reads may scan the
canonical stream. If index creation or its canonical replay rebuild cannot complete during
open, fail the owner open closed rather than trust partial/stale rows. Publish index updates
only after the committed head advances; failure of a derived-index update does not reverse
or change the result of a canonical commit. No history cap or delivery-ID eviction is
permitted. Index format/technology is private implementation detail and must not become a
second canonical store. A bounded in-memory negative filter may skip a lookup only when it
proves the delivery ID absent; positives require exact index/log verification. Saturation may
reduce performance but cannot change retry semantics.

Revalidating the complete committed history before each append uses bounded replay memory
but makes append verification I/O proportional to retained history. This cost is intentional
until an alternative preserves same-length mutation detection and the stated trust boundary;
performance and same-identity race limitations must remain explicit in acceptance evidence.

## 4.3 Event-name registry

The transition tables in [`11-LIFECYCLE.md`](11-LIFECYCLE.md) define the canonical
individual event names, state changes and guards. The following owner-grouped lists
are non-exhaustive navigation summaries, not a second spelling registry. Any event
used by an implementation must appear in the owner's versioned payload registry and
have a replay/compatibility policy.

`HookEventV1` names bounded extension callbacks, not durable owner-event discriminators;
its versioned input/result contract is `HookContributionV1` in §13 and callback
invocation is deliberately absent from canonical event streams.

### Durable Thread events

`thread/created|renamed|archived|unarchived|forked|legacy_import_started|legacy_session_imported`, `input/admitted|promoted|cancelled`,
`turn/started|legacy_imported|preparation_started|provider_started|tool_batch_rejected|tools_settled|tools_resumed|waiting_user|question_answered|provider_failed_pre_content|provider_failed_post_content|provider_truncated|provider_unknown|provider_reconciled|operations_reconciled|cancel_requested|interrupted|completed|failed|unknown`,
`provider_attempt/prepared|started|content_started|completed|failed_pre_content|failed_post_content|cancelled|truncated|unknown_acceptance|reconciliation_recorded|legacy_unknown_imported`,
`context/epoch_started|source_update_admitted|toolset_changed`,
`compaction/admitted|previewed|committed|failed|aborted`, `tool_batch/collecting|admitted|rejected|settling|suspended_for_input|resumed|settled`,
`direct_delegation/prepared|launching|started|settling|execution_limits_updated|replacement_prepared|finished|failed|unknown|cancel_requested|cancelled|reconciled`,
`tool/call_linked|result_committed|post_hook_barrier_updated`, `question/opened|answered|cancelled`, and
`artifact/attached|detached`.

Every `tool_batch/*` lifecycle event and ordered result link is committed by ThreadService
to the Thread stream. ToolExecutionCoordinator executes only an admitted batch and
returns bounded per-call observations/results; it has no ToolBatch transition authority
or second event store. It cannot mark a batch `SETTLED`; ThreadService validates the
complete ordered report and commits the terminal transition.
Bounded incremental per-call acknowledgements are owner-committed before post-tool
hooks and dependent calls; the final report references those result cursors and cannot
overwrite them. Compaction admissions consume recovery allowance before work, retain
the exact recovery-policy artifact and separate semantic source identity from the
optimistic-concurrency cursor. ThreadService owns direct delegation through the same
adapter/ExecutionHost seam; it never fabricates managed Run/Task/Attempt identities.
`tool/post_hook_barrier_updated` persists ThreadService's resultCursor-linked
WAITING_HOOKS/PERMITTED/BLOCKED bookkeeping under the ToolBatch version and pinned hook
set. Required hook uncertainty retains WAITING_HOOKS until owner reconciliation; only
committed PERMITTED allows dependent dispatch. Callback event names remain noncanonical.

Question events are emitted by the owning Thread/domain stream and feed the NeedsYou
projection; they do not create a second NeedsYou event stream.

### Durable Goal/Run events

`goal/drafted|preparation_started|preparation_completed|clarification_required|spec_approved|activated|cancelled|superseded`,
`spec/drafted|review_opened|approved|rejected|superseded`,
`run/discovering|specification_started|specification_approved|activated|waiting|resumed|paused|recovery_started|recovery_settled|integration_started|integration_settled|next_wave_started|acceptance_ready|accepted|acceptance_rejected|cancel_requested|cancelled|stopped`,
Task lifecycle events and Attempt lifecycle events,
`worker/dispatch_planned|launching|started|settling|finished|failed|unknown|cancel_requested|cancelled|reconciled`.

`task/execution_failed` records known terminal exhausted execution failure, not an
uncertain result. `run/next_wave_started` reopens guarded dispatch after current
prerequisite Evidence passes. Process replacement allocates a new WorkerExecutionId
with replacement lineage while retaining Attempt-scoped limit state and hook pins.
`task/verification_failed_retryable` returns VERIFYING to READY only from current
independent failed Evidence, a permitted distinct bounded strategy, remaining
attempts/budget and settled operations. That eligible retry uses the same
`run/next_wave_started` route; no-retry failure remains `task/failed`, never stranded
VERIFYING or disguised as insufficient Evidence.

`workspace_lease/requested|acquired|cancelled|renewal_started|renewed|released|fenced|expired|reconciled`;
workspace lifecycle events remain in the WorkspaceService stream. Usage, workspace,
budget, verification and repository-generation events are appended by their respective
owner streams as defined in §11. UsageService owns append-only `usage/observed|reconciled`
facts; BudgetService owns reservations and accounting settlement that reference those
facts. Analytics remains a derived projection. Checkpoints/rewinds and memory tombstones
are also owner events. NeedsYou is a projection over those owner events; it has no
separate `needs_you/*` event stream.

### Effects, approvals, composition

Effect events: `effect/prepared|dispatched|settled_success|settled_failure|unknown|reconciled_present|reconciled_absent|legacy_unknown_imported`,
`capability/lease_issued|lease_consumed|lease_expired|lease_revoked`,
`secret_use/lease_issued|lease_consumed|lease_expired|lease_revoked`,
`secret/created|rotated|expired|revoked|missing|restored`, and
`approval/challenge_created|presented|accepted|denied|expired|invalidated`. Verification
events include
`verification/permit_issued|permit_consumed|permit_expired|permit_revoked|evidence_produced|evidence_stale`.
Composition events record
`composition/candidate_committed|activation_started|ready|published|failed|retired|quarantined`
and
`plugin/staged|validated|enabled|activation_started|ready|failed|draining|disabled|quarantined|removed`,
service registration, capability grants/revocations, config revisions and plugin
generation changes. These records do not alter Run truth unless the owning Run event
references their digest. Hook callbacks are bounded runtime invocations, not durable
event-stream records; their contribution and event contract digests are pinned through
CompositionService, while any effect they request follows the ordinary owner streams.

### Memory owner events

MemoryService records `memory/created|superseded|tombstoned`, extraction
`memory/extraction_queued|started|completed|failed|cancelled`, candidate
`memory/candidate_proposed|accepted|rejected|expired`, and consolidation
`memory/consolidation_queued|orienting|gathering|consolidating|pruning|completed|failed|cancelled`.
Queries and search-index maintenance are reads/rebuildable projections, not additional
canonical memory streams. Job transitions pin source cursors/range digests, scope and
policy/generation digests; candidate acceptance remains a MemoryService decision.
Consolidation records proposed supersession only. Exact reviewed replacement acceptance
and all accepted supersession links share one MemoryService append with fresh source
generation/content-digest checks; model output never auto-accepts a candidate.

## 4.4 Ephemeral plane

Do not persist every provider token, terminal byte, heartbeat or render frame as a
canonical business event. The ephemeral plane carries provider text/reasoning deltas,
PTY bytes, transient progress, heartbeats, index progress samples, hover/focus and
animation frames. It may be coalesced or lost under pressure.

On a lost ephemeral sequence, surface `Live output gap`; do not imply replay. Durable
event gaps require `RESNAPSHOT_REQUIRED`. Input drafts may be locally persisted by the
client, but submitted input becomes canonical only after the kernel returns its durable
admission receipt.

## 4.5 Projection and reconnect protocol

1. Client requests an authorized state snapshot with owner cursors.
2. Server returns snapshot plus cursor `N` for each subscribed owner stream.
3. Client subscribes to durable events after those cursors and applies `N+1` onward.
4. If retention has removed a required event, server returns `RESNAPSHOT_REQUIRED`;
   client discards the affected projection and fetches a new snapshot.
5. Ephemeral streams reconnect independently and state their sequence gap.

No API claims exact-once delivery. Mutating requests use caller-generated `delivery_id`
and payload digest; an exact retry returns the original receipt, a conflicting payload
under that ID returns `REPLAY_CONFLICT`. The host can retry a query; an effectful
operation must reconcile before retry.

## 4.6 Outbox, budgets, and multi-store consistency

There is no atomic transaction spanning Thread log, Run log, artifact CAS, audit chain,
host database and process launch. Model cross-owner work as explicit sagas with stable
IDs, event causation, durable intents, receipts and reconciliation. For launch:

```text
Run event AttemptDispatchPlanned
  → rebuildable/claimable dispatch outbox
  → budget reservation + workspace fence
  → ExecutionHost prepare/launch using stable ID
  → observed launch receipt
  → WorkerExecutionStarted event
```

Budget reservation is recorded before provider/worker admission. Settlement stores
observed usage and cost when available; estimates are visibly estimates. A controller
reserves emergency storage/control capacity for cancellation, reconciliation, minimal
audit terminal records and recovery export. Under disk pressure it blocks new Turns,
Runs and effectful tools before optional indexing/embeddings.

## 4.7 Recovery and `UNKNOWN`

Kernel recovery order:

1. validate canonical log heads and hash links;
2. rebuild/check read projections from their last cursor;
3. acquire a new supervisor owner epoch and fence stale writers;
4. reconcile pending WorkAdmissionPermits/dispatch outbox claims;
5. observe exact WorkerExecution/process identities;
6. reconcile EffectIntent targets and external receipts;
7. renew/revoke workspace leases and fencing epochs;
8. reconcile budget reservations and provider acceptance where observable;
9. stale evidence whose revision/spec/environment subject changed;
10. rebuild dispatch eligibility and resume only work proven safe.

Provider stream acceptance without terminal observation is `UNKNOWN_PROVIDER_ACCEPTANCE`;
process launch without durable receipt is `UNKNOWN_WORKER_LAUNCH`; effect dispatch without
settlement is `UNKNOWN`. Recovery never clears these statuses by guessing. Retry only
when authoritative observation proves the previous operation did not take effect, or
the target's idempotency contract makes replay safe. Otherwise keep the Run blocked and
surface a precise recovery decision.

## 4.8 Cancellation and stop semantics

Cancellation is a priority control lane and always names exactly one of Thread Turn,
Run, Task, Attempt or WorkerExecution. Persist request, install a fence, stop new
claims, signal in-scope processes, reconcile effects, release safe reservations and
leases, then record terminal cancellation only when outcome is known. `/stop-now` fences
and terminates supported processes promptly; it cannot undo settled external effects.
Any unresolved work remains `CANCELLING`/`RECONCILING` or `UNKNOWN`, never a false
`CANCELLED`.

- Cancel Run blocks new claims for the Run.
- Cancel Task affects that Task; dependents become blocked, but independent tasks are
  not implicitly cancelled.
- Cancel Attempt affects that strategy only. A new strategy requires retry policy,
  remaining attempt/budget caps and reconciled effects.
- Cancel Thread Turn does not cancel an attached Run unless explicitly requested.
