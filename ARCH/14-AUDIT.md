# 14 — Audit (`CMP-audit`)

## Purpose

`CMP-audit` is the **tamper-evident, append-only execution record**. Every
security-relevant effect and every decisive moment — policy decisions, tool calls,
approvals, file writes, sandbox denials, model/provider calls, and cost — is recorded
in a hash-chained log with periodic Merkle roots. The current source uses a local
BLAKE3 keyed MAC for root records; it is not a public-key signature. The stronger
portable/off-box authenticity contract below is proposed and is not implemented by
that MAC. A class-coverage census checks declared wiring;
per-effect ID reconciliation checks runtime completeness (`DEC-005`, `DEC-031`,
`DEC-022`, `REQ-AUDIT-001`, `REQ-AUDIT-002`, `REQ-AUDIT-004`, `REQ-AUDIT-005`,
`REQ-AUDIT-007`..`REQ-AUDIT-011`).

The audit store is **not** the Thread event log. `CMP-session` owns replayable
Thread events while retaining its historic component name; `CMP-audit` owns independently verifiable evidence and is not pruned
with operational events. Audit reads and exports are themselves access-controlled
(`REQ-AUDIT-008`).

## Responsibilities

- Append immutable, chained lifecycle entries: one prepared intent and exactly one
  terminal receipt per `effect_id`, plus any intermediate decision or violation
  entries. A missing terminal receipt remains `unknown` pending reconciliation.
- Compute and persist periodic **Merkle roots** over entry batches.
- Provide a **verify** command that recomputes the chain and roots and reports any
  tampering, deletion, reorder, or truncation.
- Provide a **replay** command that reconstructs the decision/effect timeline of a
  Thread from its entries.
- Authorize audit reads by actor, run/Thread scope, and destination; write a
  non-recursive access receipt to a separately verifiable access-evidence stream
  before disclosing audit content. If that receipt cannot be made durable, refuse the
  disclosure (`REQ-AUDIT-008`, `DEC-044`).
- Guarantee **brokered-credential non-disclosure**: broker-resolved credential values
  and typed secret fields never enter an audit entry. Apply known-value and bounded
  pattern redaction to allowlisted metadata; arbitrary unstructured text is excluded,
  rejected, or kept behind an explicit artifact/access policy and is not claimed to be
  perfectly secret-scanned (`REQ-PROV-004`, `REQ-AUDIT-003`, `ARCH/22`).
- Reference durable receipts for effects rather than duplicating payloads.
- **Authenticate and anchor** finalized segment roots at a declared anchoring level —
  the current device-key MAC is local verification only; any future portable or
  off-box authenticity claim requires independently verifiable public-key proof or
  counter-signing, with an explicitly designed key custody/rotation contract. The
  default target level is `local-sink`; a declared off-box trust requirement makes
  `off-box` mandatory (`REQ-AUDIT-004`,
  `REQ-AUDIT-007`, `DEC-022`).
- **Render the claim boundary**: `verify` states, per level, what is and is not
  detected, and never presents a weaker level as a stronger one
  (`REQ-AUDIT-007`).
- Publish a first-class class-coverage census **and** per-effect ID reconciliation.
  One entry per class does not prove that every runtime effect has a receipt (`DEC-031`).
- Maintain the **cross-store consistency invariant** with the Thread log and the
  analytics ledger (`REQ-AUDIT-006`, `DEC-020`).
- Keep the record portable with the Thread bundle.

**Never owns:** Thread event replay (`CMP-session`), receipts/artifacts
(`CMP-tools`/persistence), policy evaluation (`CMP-guard`), or credential custody
(`CMP-secrets`). The current audit device key is owned/stored by `CMP-audit`; the
future key-custody boundary is unresolved and must not be attributed to
`CMP-secrets` until implemented.

## Interfaces

| Peer (`CMP-*`) | Direction | Contract |
|---|---|---|
| `CMP-guard` | inbound | decision records: allow/ask/deny, ticket issue/validate/revoke, mode changes |
| `CMP-sandbox` | inbound | profile-applied, apply-failed, fs/net violations |
| `CMP-tools` | inbound | tool proposed/started/completed, file write, patch apply; receipt refs |
| `CMP-provider` | inbound | model call (provider/model id, token counts, cost), no prompt/completion content |
| `CMP-runner` | inbound | run/step boundaries, terminal state, step receipts |
| `CMP-secrets` | outbound | redaction pass applied before an entry is chained |
| `CMP-session` | both | Thread ID/ref association; audit accompanies a portable Thread bundle |
| `CMP-tui` / `CMP-headless` | outbound | verify/replay invocations and status |

## Data / state model

```
AuditEntry = {
  audit_seq:    u64,              // globally monotonic; authoritative cross-store order
  segment_id:   u32,
  segment_seq:  u32,              // monotonic within the segment
  event_id:     EventId,          // stable idempotency key for one lifecycle record
  effect_id?:   EffectId,         // stable across prepared/decision/terminal rows for one effect
  effect_phase?: PREPARED | DECISION | TERMINAL | RECONCILIATION,
  thread_id?:   ThreadId,
  run_id?:      RunId,
  task_id?:     TaskId,
  attempt_id?:  AttemptId,
  ts:           epoch_ms,         // UTC
  actor:        user | agent | system | workflow,
  kind:         run | step | decision | tool | approval | fs_write | sandbox |
                model | cost | ticket | record_access,
  action?:      string,
  resource?:    string,           // ref/glob form, never raw payload
  effect?:      allow | ask | deny,
  outcome?:     completed | denied | failed | unknown,
  ticket_ref?,  approval_ref?, receipt_ref?, work_id?,
  inputs_digest?: blake3,         // effect/argument digest
  meta:         bounded,          // small typed fields only
  prev_hash:    blake3,           // previous entry_hash in the chain
  entry_hash:   blake3            // blake3(canonical(entry \ entry_hash) || prev_hash)
}
SegmentRoots = { segment_id: u32, first_audit_seq, last_audit_seq, count, merkle_root, prev_root? }
DurableFactRef = {
  store_id: StoreId, aggregate_type: string, aggregate_id: string,
  seq: u64, event_id: EventId, payload_digest: blake3, schema_version: u32
}
AuditAccessReceipt = {
  access_id: AccessId, actor, action: verify | replay | census | export,
  run_scope?, thread_scope?, destination?, decision: allow | deny,
  target_store_id, observed_head_digest?, created_at, access_chain_seq,
  access_prev_hash, access_hash
}
```

`DurableFactRef` is the shared cross-store reference envelope, not a shared event
bus or a fourth source-of-truth store. A reference is valid only if the named owner
can retrieve the exact committed record and its digest/schema match. Causation and
correlation IDs may be added to the owning record when needed; they never replace
aggregate sequence, event identity, or payload digest. This gives Thread, audit,
analytics, and artifact records a common way to point to one another while preserving
their independent sequence and transaction boundaries.

Every effect lifecycle row carries the same `effect_id`; the prepare row is committed
before execution and exactly one terminal row is accepted. `event_id` deduplicates one
specific lifecycle row and is not a substitute for `effect_id`. Storage enforces the
terminal uniqueness invariant transactionally (or through a recoverable append
reservation); a second terminal row for the same effect is an integrity failure. A
terminal `unknown` remains immutable; later authoritative reconciliation appends a
`RECONCILIATION` fact linked to that receipt and updates only the derived status view,
never rewriting or duplicating the terminal receipt.
Non-effect audit entries omit `effect_id`/`effect_phase`. `run_id` occurs once in the
envelope; receipts are references, not repeated ownership fields.

- `blake3` is the hashing dependency (`ARCH/03` §5). Entries are canonicalized
  (stable field order, no floats) before hashing so verification is deterministic.
- The chain crosses segment boundaries: the first entry of a segment references the
  last entry hash of the previous segment, and the segment Merkle root is recorded.
- Entries carry **refs, digests, and bounded metadata**, never documents, file
  bodies, prompt text, or completion text.

**Genesis derivation is format identity.** The `prev_hash` of sequence 0 and the
`prev_root` of the first segment root are `blake3` digests of fixed labels —
`horizoncode/audit/genesis/v1` and `horizoncode/audit/roots/genesis/v1`. The label
text and the pinned constant are asserted equal by test
(`entry::tests::genesis_matches_its_label`,
`anchor::tests::genesis_root_matches_its_label`), so neither can drift silently.
The pre-rename `agentx/…` derivation (`4b4889db…` / `ead29c1a…`) was never shipped;
a store whose first entry carries it is a pre-release artifact, and verification
refuses it at sequence 0 rather than accepting it under a compatibility rule
(`AX-354`, spike pinned by `the_pre_rename_genesis_is_not_accepted_as_genesis` in
both modules).

## What is recorded

| Class | Examples |
|---|---|
| Decisions | Every `allow`/`ask`/`deny`, plus timeouts and mode changes |
| Tool calls | Tool name, argument digest, start/end, outcome, receipt ref |
| Approvals | Request, the exact remembered pattern, reply (`once`/`always`/`reject`), timestamp |
| File writes | Path (workspace-relative), pre/post content digest, lease/conflict outcome |
| Sandbox denials | Profile applied/failed, fs/net violations, refused unconfined requests |
| Model / provider calls | Provider + model id, token counts, latency, routing decision — counts and refs only |
| Cost | Estimated cost per call and per run, feeding budget enforcement |
| Ticket lifecycle | Issue, validate, use decrement, expiry, revocation, epoch bump |

**Step receipts:** each settled step records a receipt ref (ticket, capability/
provider, inputs digest, outputs refs, verification performed). The audit entry
stores the ref; the receipt store holds the detail. Denials and destructive actions
are first-class entries, never omitted.

## Secret redaction guarantees

- `CMP-audit` accepts a typed, allowlisted event schema; arbitrary free-form prompt,
  tool, workspace, or provider text is not an audit field. `CMP-secrets` supplies
  known credential values for defense-in-depth redaction before hashing and append;
  a rejected value is replaced with a typed placeholder and only the redaction event
  is recorded.
- Credentials handled by the secret broker MUST never be written to the chain,
  roots, verify/replay output, or derived export. Pattern and known-value redaction
  covers recognized URL userinfo, authorization fields, and configured/brokered
  secret values; it cannot prove detection of every arbitrary secret embedded in
  repository or tool text. Such free text is excluded by schema, and that residual
  is disclosed rather than claiming perfect scanning.
- Acceptance uses planted secrets of varied lengths and encodings across every
  allowed field and output path, and verifies that unknown unstructured text is
  rejected or stored only as a bounded artifact with separate policy and access.

## Lifecycle & flows

### Append
1. Producer submits an event with refs and bounded metadata.
2. Canonicalize and run the redaction pass.
3. Acquire the validated OS-backed writer lock **before** reading or reconciling any
   head, segment, root, or sequence. A lock timeout/loss fences this writer.
4. If `event_id` already exists with the same canonical digest, return its original
   receipt; if the same ID has different content, return `idempotency_conflict`.
   Reconcile stored head against required segment/root state. A torn tail, malformed
   head, inaccessible entry, or ambiguous mismatch returns `recovery_required`;
   ordinary startup never repairs or guesses.
5. Allocate the next global `audit_seq` and segment-local `segment_seq`, append and
   durably flush the entry, then atomically replace `AuditHead`. Persist segment roots
   at rollover before accepting a later sequence.
6. Release the lock only after durable writes succeed. Partial failure returns a typed
   unknown outcome and requires reconciliation before another append.

### Read authorization and evidence

1. Resolve the authenticated actor, action, requested run/session scope, and output
   destination. Policy denial creates a bounded deny receipt without returning data.
2. Persist an `AuditAccessReceipt` to `<state-dir>/audit-access/` using that stream's
   own sequence, hash chain, and OS lock. It references the target store and the
   observed target-head digest when available; it contains no prompt, credential, or
   audit payload. This stream is not appended to the chain it describes.
3. If the access receipt cannot be persisted, fail before exposing entries, replay,
   census details, or export bytes. Then open the target store read-only and pin the
   exact head/segment snapshot being checked.
4. `verify`, `replay`, and `census` return typed errors for missing, malformed,
   unreadable, or incompletely enumerated state. A genuinely initialized empty store
   has an explicit empty-store marker and is not inferred from an I/O failure.

**Source status (2026-09-28).** Steps 1–4 are now implemented: the CLI records access
in an independent `audit-access/` stream (own sequence, own `blake3` chain, own
advisory lock) and returns a dedicated exit code without printing record content when
that record cannot be persisted; `verify`, `replay`, and `census` open no writer path;
a directory or per-entry enumeration failure is a typed error instead of an empty
store; the head pointer is read as `Absent | Present | Malformed | Unreadable` and
ordinary startup refuses anything but a genuinely empty store; a torn tail is a typed
`RecoveryRequired` refusal repaired only by the explicit `audit repair` command, which
preserves the original bytes and emits a linked recovery artifact; and a writable
store holds an OS-backed advisory lock for its lifetime, taken before the head or
segments are read. Not implemented here: the global `audit_seq`/`segment_seq`
migration, per-effect prepare/terminal reconciliation, and the `census` coverage
evidence itself (`AX-346` remainder, `AX-311`).

### Verify
```
horizoncode audit verify [--thread <ThreadId>] [--all]
```
Recomputes each `entry_hash` from stored bytes and `prev_hash`, checks contiguity of
`audit_seq` and `segment_seq`, recomputes every segment Merkle root, and confirms root linkage across
segments.

`verify` is read-only and never truncates, repairs, or rewrites an input segment.
Corruption produces a non-zero verdict and a stable finding ID. A separate operation
may create a recovery artifact only after explicit authorization:

```text
horizoncode audit repair --segment <segment-id> --output <new-artifact>
```

Repair first preserves the original bytes and their digest, records the failure range,
and writes a new derived chain/artifact with a `repair_of` reference. It cannot
retroactively authenticate the repaired content; the verifier reports the original
chain as corrupt and the derived artifact as reconstructed. Repair is not an automatic
startup action and never overwrites the original segment.

**What verify proves:** given a trusted anchor, no entry has been added, removed,
reordered, truncated, or modified without detection, every entry is included in its
segment root, and every root authenticator verifies against the trust material
available at the declared level. With the current local MAC this is local
verification, not independent public verification.
**What verify does not prove:** that the recorded content is truthful, that no
unrecorded effect occurred elsewhere, or who authored an entry. Per
`REQ-AUDIT-007` (`DEC-022`), it does NOT prove content authenticity, does NOT detect
**fabrication** by a principal holding local write access (and, at the `local-sink`
level, sink-write access), and does NOT cover entries written **after the last anchored
root**. Tamper-evidence covers modification of **already-anchored** history by a
principal that does not hold the anchoring credential, and nothing beyond that.
Coverage is a separate **census** (`REQ-AUDIT-005`), and root-anchoring is only as strong
as the trusted key/sink it anchors to (`REQ-AUDIT-004`). Verify names the **level** it
evaluated — `local-trust`, `local-sink`, or `off-box` — alongside that boundary, and
never renders `local-sink` as `off-box`. A run with a configured, validated local
append-only sink is `local-sink`; only a run without a sink is `local-trust`. Neither
local level is independently off-box anchored.

### Replay
```
horizoncode audit replay --thread <ThreadId> [--from <seq>] [--to <seq>]
```
Prints the reconstructable decision/effect timeline (decisions, tickets, tool
outcomes, approvals, cost) in order. Replay reads evidence; it does not re-execute
effects.

### Thread portability
A proposed portable Thread bundle includes its audit entries, segment roots, and a
proof header. Import verifies the hash chain and any supported proof before treating
the bundle as structurally intact; a keyed MAC alone cannot give an external
recipient independently verifiable authenticity. A bundle whose chain fails
verification is rejected or quarantined with the failure surfaced. The audit record
carries the model, mode, and policy snapshot the Thread ran under, so a restarted or
moved Thread remains reconstructable and its decisions reproducible
(`REQ-SESS-002`, `REQ-SESS-004`).

## Storage layout and rotation

```
<state-dir>/audit/
  segments/0000.jsonl      # append-only, one canonical entry per line
  segments/0001.jsonl
  roots.jsonl              # one SegmentRoots record per finalized segment
  head                     # AuditHead (atomic replace under an OS writer lock)
  lock                     # validated cross-process append lock
```

- Segments roll over at a fixed entry count or byte budget (configurable).
- Finalized segments are immutable; rotation never rewrites or compacts a segment.
- Exactly one process may allocate an `audit_seq` at a time. An OS-backed lock is
  acquired before reading the head, scanning/reconciling segments, sealing a root, or
  allocating a sequence. The entry is appended and durably flushed before `AuditHead`
  advances. Lock loss fences the writer; a process-local mutex alone is insufficient.
- A missing head on a genuinely new empty store is distinct from an unreadable or
  malformed head. The latter is a recovery-required error; it is never replaced by an
  inferred pointer during ordinary startup. Recovery preserves the original head and
  segment bytes and records the derived state separately.
- Directory enumeration and per-entry reads distinguish an empty store from an
  inaccessible or malformed store. `verify`, `replay`, and `census` fail visibly on
  incomplete enumeration; they never return a clean empty result after an I/O error.
- The audit store is **excluded from operational-event retention**; it is pruned only
  by an explicit archival/retention policy that preserves verifiability.
- The `head` pointer is updated by atomic replace. A torn tail is detected by
  read-only `verify` and remains untouched. The append-capable open path refuses to
  append while a torn tail or corrupt/missing head requires recovery; only the explicit
  repair flow may produce a separately preserved recovery artifact. No ordinary
  surface repairs evidence as a side effect.

**Source status at Rust baseline `23d4ce8` (source-map commit `cbba87b`, 2026-09-28).** The
read-only inspection defects recorded on 2026-09-27 were addressed by the AX-346
integrity slice: `AuditLog::open_read_only` does not repair; writable open refuses a
torn tail; malformed/unreadable heads and segment-enumeration errors are typed; and
the writer holds an OS-backed lock. See `crates/horizoncode-audit/src/store.rs` and
`TODO.md` AX-346. This does not close AX-346's global sequence migration, effect
prepare/terminal reconciliation, or key rotation. Analytics is a derived ledger, not
a second authority for whether an effect happened.

## Root anchoring (current MAC versus proposed portable proof)

Local roots detect local tampering only. The current source stores `device.key` under
the audit root and authenticates finalized roots using a BLAKE3 keyed MAC
(`crates/horizoncode-audit/src/key.rs`, `SIGNATURE_ALGORITHM =
blake3-keyed-mac`). Because this is a shared-secret MAC, it does not support public
verification of an exported bundle. To make tamper-evidence meaningful against a
local actor, the **target** authenticates and anchors every finalized `SegmentRoots`
(`REQ-AUDIT-004`):

- **Local root chain.** Each root is appended to `roots.jsonl` and chain-linked by
  `prev_root`, so deleting or editing a root breaks the root chain.
- **Root authenticator (claim boundary decided; portable key design pending).** The
  current local authenticator is a BLAKE3 keyed MAC, as recorded in `DEC-022`; retain
  the honest local-verification boundary. Any portable/off-box proof requires an
  asymmetric signature or trusted counter-signature plus an independently obtained
  trust root. Key custody/rotation and portable proof formats remain implementation
  design work under `AX-372`; never call the present MAC a public-key signature.
- **Anchor sink (target).** On a configured cadence or at a Thread-close boundary,
  the authenticated root is exported to the declared sink (append-only file for
  `local-sink`, or a remote object / counter-signing service for `off-box`). The sink
  is transport behind an adapter and receives roots/proofs only — never entries.
- **What anchoring buys.** Given a trusted anchor, a local actor who rewrites entries
  and recomputes local roots is still detected: the anchor's root no longer matches.
  It does not prove the content is truthful, and it is only as strong as the trust in
  the anchor key and sink, which is documented per deployment.

**Anchoring levels (target).** `DEC-022` fixes three declared levels. The target
requires root authentication
— `anchor.sign: false` is a configuration error, not a supported posture, because
signing is a security control rather than a convenience.

| Level | `anchor.offbox` | Sink | Claim it may make |
|---|---|---|---|
| `local-trust` | `none` | none | Locally authenticated roots inside the audit store. **No independent-verification claim.** Permitted only as an explicit, acknowledged posture; labeled everywhere. |
| `local-sink` (**default**) | `file` | a distinct, ownership- and mode-validated append-only sink **outside** `<state-dir>/audit` | Tamper-evidence against audit-store-local rewriting and against a *different* unprivileged principal (`AV-6`). **Not** a claim that survives the invoking user. |
| `off-box` | `remote` | off-host object store or counter-signing service | The only level that survives an actor who also controls local storage. **Required** for any deployment that declares an off-box trust requirement. |

- **Default is `local-sink` (`offbox: "file"`).** A fresh install cannot invent a
  remote sink, so the honest zero-config default is the strongest level that needs no
  external party: locally authenticated roots written to a sink outside the audit store root.
  `"offbox": "none"` keeps working, but it is now an explicit, acknowledged
  `local-trust` posture and is labeled wherever audit history is shown; nothing is
  deleted by this change.
- **A configured-but-unreachable sink fails closed.** The evidence gate fails and the
  run does not degrade to a weaker level presented as the configured one
  (`REQ-AUDIT-004`, `REQ-SEC-024`).
- **The sink is validated like any other security-relevant path** — ownership and mode
  checked before use, and refused on mismatch (`REQ-SEC-018`).

**The precise detection boundary.** Each level states, and `audit verify` renders,
what it detects and what it does not (`REQ-AUDIT-007`):

| Question | Answer at any level |
|---|---|
| Was **already-anchored** history modified by a principal that does not hold the anchoring credential? | **Detected.** |
| Is the recorded content truthful / authentic? | **Not proven.** A chain never establishes content authenticity. |
| Were entries **fabricated** by a principal holding local write access (and, for `local-sink`, sink-write access)? | **Not detected.** No local anchor can catch a writer who can also rewrite the anchor. |
| Were entries written **after the last anchored root** altered? | **Not covered.** The unanchored tail is outside the evidence. |

Only the level names `local-trust`, `local-sink`, and `off-box` may describe the
evidence, and **`local-sink` MUST NOT be presented as `off-box`**. Absent an anchor,
roots are **local-only** and `verify` labels the evidence `local-trust`; it never
presents local roots as independently anchored.

## Coverage census

`REQ-AUDIT-001` is only meaningful if coverage is checkable, so `CMP-audit` ships a
first-class **coverage census** (`REQ-AUDIT-005`):

- A declared registry of **security-relevant effect classes**; the "What is recorded"
  table is its seed, and additions are data, not prose.
- A census command that, over a bounded window or segment set, maps every declared
  class to at least one recorded entry and reports per-class counts.
- Any uncovered declared class fails loudly (non-zero, audited); an uncovered class is
  a defect, not an accepted gap.
- The census output is a generated artifact that can accompany a release or a session
  bundle as evidence.

The census proves *that* every declared class is represented; it does not by itself
prove that no undeclared class exists — the declared registry is reviewed as part of
the security boundary.

**Runtime completeness.** Every governed attempt prepares a durable `effect_id`
before execution, then settles that same ID to exactly one terminal receipt. Lifecycle
entries may be multiple; the terminal receipt is unique. The verifier joins prepared
IDs, terminal IDs, session references and external/workspace observations; duplicates,
missing outcomes and unrecognized external effects are incidents. A crash leaves
`unknown`, which blocks automatic replay until reconciliation. The class census remains
a static wiring check and cannot discharge this invariant by itself (`ARCH/25`).

## Cross-store consistency (single store vs. multiple)

`DEC-020` fixes the answer: **multiple append-only stores, one invariant.** The stores
are:

| Store | Owner | Role | Ordering |
|---|---|---|---|
| `events/segment-*.jsonl` + `events/head.json` (Thread event stream) | `CMP-session` | committed replay source of truth | per-Thread dense `seq`; bounded digest-linked segments and committed head (`ARCH/07`) |
| `segments/*.jsonl` + `roots.jsonl` | `CMP-audit` | independently verifiable evidence | global audit `seq`; chain-linked roots |
| `events.jsonl` (analytics projection ledger) | `CMP-analytics` | rebuildable analytics rows and rollups | derived from canonical owner facts; each row carries `DurableFactRef` source refs |

Invariant (`REQ-AUDIT-006`):

1. A security-relevant effect is **complete** only once its audit entry is durably
   chained; a Thread or analytics fact that references it carries `thread_id`, the
   Thread `seq`, and the audit `audit_seq` (or stable receipt reference), each as an
   owner-qualified `DurableFactRef` where stored cross-store. Legacy v1 `session_id` fields
   are preserved as source bytes and normalized only in a separately versioned view.
2. Each store's own monotonic sequence defines its internal order. **Cross-store
   ordering is never inferred from wall-clock time**; the audit `seq` is the
   authoritative tie-break for security-relevant ordering, and the Thread/analytics
   stores carry their own sequence for their internal use.
3. A reconciliation check verifies `store_id`, aggregate identity/sequence, event id,
   schema version, and digest for every `DurableFactRef`; it flags referenced effects
   with no audit entry and audit entries whose referenced Thread fact is missing.
   Disagreement is surfaced, never silently merged.

**Target crash protocol (not implemented at source baseline).** The audit
`EffectPrepared(effect_id, request_digest, thread_id, run_id, task_id, attempt_id,
tool_call_id, workspace_fence, idempotency_key?)` is the canonical write-ahead
intent and must be durable before execution. The effect runner returns a bounded
receipt/artifact reference; the controller then appends exactly one audit terminal
receipt before exposing the result as settled to the model. Thread events store
references/digests and are rebuilt or reconciled against that canonical audit
receipt; analytics is an asynchronous, rebuildable projection and never blocks or
defines effect truth. The caller must not replay an external/non-idempotent action
while its outcome is unknown.

| Crash boundary | Recovery rule |
|---|---|
| Before `EffectPrepared` commit | No effect may have started; safe to retry same operation ID after confirming no dispatch receipt exists. |
| After prepare, before executor admission | Reconcile executor/outbox; retry only if non-admission is proven and the same idempotency key is reused. Otherwise remain `UNKNOWN`. |
| During/after execution, before terminal receipt | Inspect filesystem/process/peer/provider state; settle observed result, apply approved compensation, or remain `UNKNOWN` and block replay. |
| After audit terminal receipt, before Thread result event | Rebuild the Thread reference/result projection from receipt/artifact refs; never rerun the effect. |
| After Thread result, before analytics append | Rebuild analytics from canonical receipts; no effect retry. |
| Analytics row without a matching canonical receipt | Quarantine/remove derived row and surface an integrity incident; analytics cannot promote it to truth. |

`DurableFactRef`'s store/aggregate identity, event ID, sequence, schema version, and
payload digest connect these streams. No cross-store total order is inferred from
timestamps. Exact storage transaction and recovery implementation belongs to
`AX-311`; this table is required behavior, not evidence it exists.

## Bounded retention and disk pressure

Audit history is never destructively pruned. A deployment selects `preserve` or
`archive_with_proof`. In archive mode, only a sealed range can leave the hot store,
and only after a content-preserving archive is written, read back, fully verified,
linked to its authenticated root/range, and recorded with a durable archive reference.
The archive remains part of the audit store's required read/verify/export path; moving
bytes does not erase retention or availability obligations. Numeric hot-store,
archive, and reserve ceilings are workload/platform limits to validate before release,
not unbounded defaults.

Before starting each effect, the controller reserves enough bounded audit capacity
for prepare, one terminal receipt, and reconciliation/stop evidence. At a high-water
mark it pauses new effectful work and attempts configured archival. If archival is
unavailable or the reserved capacity is exhausted, new effects fail closed before
dispatch and the run reports a typed `WAITING` or `STOPPED` reason. Cancellation,
permission replies, and recovery status use a separately protected control reserve;
when even that reserve cannot be committed, the controller fences further effects
and reports the durability failure through the client channel. It must never execute
an unrecorded effect or claim a complete audit range. Retention limits and reserve
sizes remain open until benchmarked against long-run workload and disk-failure tests.

## Privacy / PII handling

- Entries store digests and refs, not user content; prompt/completion text is never
  recorded (counts and ids only).
- PII minimization is structural: paths are workspace-relative where possible, and
  external targets are stored as normalized host/`host:port` rather than full URLs.
- Reads/exports are access-controlled; an export carries the available chain proof.
  Independent recipient verification is possible only with an off-box-verifiable
  signature or trusted counter-signature and a trust root obtained independently. A
  local keyed MAC or `local-sink` chain is not portable public proof.

## Failure modes

| Failure | Behavior |
|---|---|
| Append I/O error | Fail the guarded action closed; surface the error; do not proceed unrecorded |
| Redaction error | Refuse the entry; never chain a possibly-secret payload |
| Torn tail after crash | Verify reports the first invalid byte/entry and does not mutate; explicit repair preserves original bytes and creates a separate derived artifact |
| Tamper detected | Verify reports the failing `audit_seq` and stops; replay refuses to assert trusted history |
| Root store missing | Segment treated as unanchored; verify reports the gap; never fabricates a root |
| Disk full / rotation failure | Bounded error; the effect is denied rather than committed unrecorded |
| Portable bundle fails verify | Reject or quarantine; surface the reason; never silently import |

## Configuration

```jsonc
{
  "audit": {
    "enabled": true,
    "segment_max_entries": 4096,
    "segment_max_bytes": 8388608,
    "hash": "blake3",
    "anchor": {
      "sign": true,                              // required; "false" is a config error
      "offbox": "file",                          // file (local-sink, DEFAULT) | remote (off-box) | none (local-trust)
      "sink_path": "<state-dir>/audit-anchor",   // default: a directory outside <state-dir>/audit,
                                                 // ownership+mode validated (REQ-SEC-018)
      "trust_requirement": "none",               // none | off_box — "off_box" requires offbox: "remote"
      "cadence": "session_close"                 // session_close | every_n_segments
    },
    "retention": { "mode": "preserve" },      // preserve | archive_with_proof; never destructive prune
    "export": { "require_chain_proof": true }
  }
}
```

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-AUDIT-001` | Every individual effect has a prepared intent and one terminal receipt under a stable ID; reconciliation checks the mapping. |
| `REQ-AUDIT-002` | Hash chain + Merkle roots with an `audit verify` command that states what it does and does not prove. |
| `REQ-AUDIT-003` | `CMP-secrets` blocks broker-resolved credential values and typed secret fields, then redacts configured/broker-known values and bounded recognized patterns before chaining allowlisted metadata. Arbitrary free text is not claimed to be perfectly scanned; see the residual in `ARCH/22`. |
| `REQ-AUDIT-004` | Root authentication is non-disableable and its algorithm/key owner are explicit. The current BLAKE3 keyed MAC is local-only. `local-sink` is the target default; off-box verification requires independently verifiable public-key proof or trusted counter-signature. A configured-but-unreachable sink fails closed; do not describe the local MAC as a public signature. |
| `REQ-AUDIT-005` | Class census and per-effect reconciliation both fail on gaps. |
| `REQ-AUDIT-006` | Cross-store consistency invariant with the Thread log and analytics ledger (`DEC-020`). |
| `REQ-AUDIT-007` | Every level states and `verify` renders its detection boundary — modification of already-anchored history only; no content authenticity, no fabrication detection, no coverage of the unanchored tail; only the three level names are used and `local-sink` is never rendered as `off-box` (`DEC-022`). |
| `REQ-AUDIT-008` | Read/replay/verify/export requests pass actor, run/Thread, and destination-scoped read authorization; the access event avoids recursive export. |
| `REQ-AUDIT-009` | `audit_seq` is globally monotonic; `segment_seq` is local to a segment; verify is read-only and authorized repair creates a separate, provenance-linked artifact. |
| `REQ-AUDIT-010` | The OS-backed lock serializes writers across processes before head/segment/sequence reads; lock loss fences the writer. |
| `REQ-AUDIT-011` | Missing/corrupt/inaccessible/incompletely enumerated state is distinct from a new empty store; readers fail typed and normal writer startup refuses implicit repair. |
| `REQ-PROV-004` | Broker-resolved credentials are not logged; provider calls use typed counts/refs and bounded redaction. Arbitrary echoed content remains subject to the `ARCH/22` residual. |
| `REQ-SESS-002` | Replay reconstructs a Thread timeline from persisted evidence. |
| `REQ-SESS-004` | Model, mode, and permission configuration recorded with the Thread. |
| `REQ-HORIZON-003` | Cost entries feed enforceable, fail-closed budgets. |
| `REQ-LOOP-004` | Each turn's terminal state is recorded as an audited boundary. |

## Open questions

1. **Device-key rotation and escrow.** The anchoring *defaults* are resolved by
   `DEC-022`: signing is unconditional, the default level is `local-sink`
   (`offbox: "file"`, a validated sink outside the audit store root), `off-box` is
   required for a deployment that declares an off-box trust requirement, a
   configured-but-unreachable sink fails closed, and `local-trust` survives only as an
   explicit, acknowledged, labeled posture. What remains open is rotation and escrow for
   the device signing key (and the default anchor cadence per deployment).
2. **Retention capacity values** — choose hot-store/archive ceilings and protected
   control/effect reserves from long-run workload and disk-failure benchmarks. The
   behavior is fixed: no destructive prune; archive only sealed, verified ranges with
   retained references; stop new effects before an unrecorded append. Exact values
   remain open until measured.
3. **PII redaction policy** — the exact field allowlist for `meta` and whether
   workspace-relative path normalization is always safe across multi-root workspaces.
4. **Verify performance at scale** — incremental verification from a trusted
   checkpoint versus full-chain recomputation for very long sessions.
5. **Audit of audit** — whether `verify`/`replay`/export operations themselves append
   entries (proposed: yes for export, to record access).
