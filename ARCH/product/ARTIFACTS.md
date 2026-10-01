# Artifact Store

## Purpose and ownership

`CMP-artifact` is the shared service for immutable, size-bounded payloads referenced
by durable Thread and Run records: image/media inputs, large tool output, model
partial attempts, original requests, test logs/reports, and other retained evidence.
It owns byte admission, scoped content-addressed storage, digest verification,
reference leases, import/export staging, physical emergency-space allocation for
controller records, retention pins, and garbage collection. It
does **not** own Thread/Run/Task truth, model interpretation, permissions for external
effects, or the audit chain.

Canonical event stores remain authoritative for *why* an artifact exists and which
owner references it. `CMP-artifact`'s SQLite indexes, manifest cache, owner graph and
cleanup candidates are rebuildable. It never turns a missing or corrupt object into an
empty string, a passing evidence result, or a completed run.

One implementation/interface is shared; bytes are partitioned by owner namespace.
There is no cross-Thread or cross-run deduplication in v1, which avoids accidentally
sharing deletion, retention, privacy, and accounting domains. Thread artifacts live
inside the portable Thread package; run/evidence artifacts live below their run
namespace. Export copies referenced objects into a standalone manifest bundle.

## HLD boundaries

| Caller | May request | Remains authoritative for |
|---|---|---|
| `CMP-session` | Stage/verify Thread payloads; append a `BlobRef` to its event log; export/import a Thread package | Thread event sequence, replay, checkpoints, portable bundle identity (`ARCH/core/SESSION-AND-THREADS.md`) |
| `CMP-orch` | Stage original request, plan, attempt, test, verifier and handoff artifacts; add/remove run evidence pins | Run/task/spec/attempt/evidence lifecycle (`ARCH/execution/LONG-HORIZON.md`) |
| `CMP-provider` | Read a validated image or bounded context artifact through a lease while preparing an admitted request | Provider route, egress guard, usage/cost and finish evidence (`ARCH/core/PROVIDERS.md`) |
| `CMP-tui` / headless / ACP | Ask for safe metadata, availability, bounded read/preview or export receipt through control APIs | Display and output schema; owning services authorize reads/effects |
| `CMP-analytics` | Record object count/bytes and usage class; never payload bytes | Billing provenance and aggregate usage (`ARCH/product/ANALYTICS.md`) |
| `CMP-audit` | Receive governed prepare/terminal records for deletion and security-relevant access | Tamper-evident audit sequence and verification (`ARCH/security/AUDIT.md`) |

No worker, model tool, plugin, MCP server, or external peer gets direct store paths or
the ability to pin/unpin/delete objects. All reads are service-mediated, scope-checked,
bounded and recorded where policy requires. Local filesystem storage is the initial
backend. An object-store backend is a separate adapter with its own durability and
concurrency acceptance; it is not implied by a content-addressed interface.

## LLD schemas

### References and identities

```text
ArtifactRef = {
  namespace_kind: THREAD | RUN,
  namespace_id,
  artifact_id,
  digest,   // blake3 (DEC-059)
  media_type,
  encoded_bytes,
  schema_version
}

ArtifactOwner = {
  owner_kind: THREAD_EVENT | CHECKPOINT | RUN_EVENT | EVIDENCE |
               ORIGINAL_REQUEST | EXPORT_JOB | MAINTENANCE | RECOVERY_QUARANTINE |
               DRAFT | ARTIFACT_FEEDBACK,
  owner_id,
  owner_revision_or_event_seq,
  artifact_ref
}

PhysicalStorageReserve = {
  reserve_id, run_id, filesystem_identity, backend_profile_digest,
  allocated_bytes, allocation_method, allocation_receipt_ref,
  state: VERIFIED | CONSUMED | REPLENISH_REQUIRED | UNKNOWN | RELEASED,
  fence_epoch
}
```

The reserve is a physically allocated controller-only file/journal on the same
filesystem as the run log (or an equivalent tested hard reservation). A sparse file,
free-space query, or in-memory quota entry is not physical reservation evidence.

Thread events use the compact `BlobRef = {blob_id, digest, media_type,
encoded_bytes, schema_version}`; the Thread ID is supplied by the containing log
and resolves to `ArtifactRef(namespace_kind=THREAD, namespace_id=thread_id, ...)`.
Legacy v1 references with `namespace_kind=SESSION` remain readable and byte-preserved;
the `AX-379` migration maps them to the same preserved Thread ID in a separately
verified generation. Never reinterpret an external ACP/provider Session ID as an
artifact namespace.
Run records use the full scoped reference. Every owner reference binds ID, digest,
length, media type, schema version, owner revision and canonical source. ID reuse with
different bytes is an integrity error.

### Ephemeral leases and projections

| Record | Required fields and invariant |
|---|---|
| `ArtifactWriteLease` | `lease_id`, scoped artifact identity, `operation_id`, `owner_kind/id`, `owner_fence`, `reserved_bytes`, `state: WRITING | STAGED | REFERENCE_COMMITTED | ABORTED | UNKNOWN`, `expires_at`. A lease spans byte publication and the canonical owner-event append; recovery reconciles expired leases against the owner log before releasing quota or collecting bytes. |
| `ArtifactReadLease` | `lease_id`, `artifact_ref`, `reader_kind/id`, `purpose`, `max_bytes`, `expires_at`. Revocable; decoding/provider upload reads stream under this limit and cancellation stops further reads. |
| `artifact` projection | `(namespace_kind, namespace_id, artifact_id)`; digest/size/media/schema, durability and integrity states, retention status, created time. Contains metadata only, never bytes. |
| `artifact_owner` projection | canonical owner kind/ID/revision/event cursor → `ArtifactRef`; rebuilt from all owner logs and evidence stores before a GC mark is trusted. |
| `artifact_gc_run` | `gc_id`, `mark_epoch`, all owner-source watermarks, `enumeration_complete`, candidate-set digest, deleted IDs, state, started/finished time. Any missing/unreadable/incomplete source sets `enumeration_complete=false` and deletes nothing in that sweep. |

Owner references are appended to the same authoritative event/record that records the
owning event. For cross-store run pins, `CMP-orch` appends an explicit artifact-pin
event before acknowledging the pin. The service holds the reference lease across that
append and projection update. `artifact_owner` is never the only record that a pin
exists.

## Write, read, and recovery flows

### Write and bind

1. Caller supplies an authenticated internal owner context, namespace, operation ID,
   declared size when known, purpose, and effective byte limits. The controller
   atomically reserves namespace storage budget; user values cannot exceed compiled
   limits or managed policy. Before activating a multi-hour run, the backend also
   physically allocates and verifies its protected control/recovery reserve; the
   quota ledger by itself cannot guarantee writes when another process fills the
   filesystem.
2. Service creates a random temporary file with exclusive/no-follow semantics inside
   the same namespace filesystem. It streams bytes and stops as soon as the encoded
   cap is crossed; it does not first buffer the payload. Declared MIME is advisory;
   sniff and actual byte length are recorded.
3. Hash the exact stored bytes, flush them, and publish atomically under the
   namespace's digest path. Existing digest paths are re-read and verified; never
   overwrite/follow a mismatching object. The backend reports the durability level
   it can provide. If required atomic/durable publication is unsupported, reject the
   durable write (or use only a separately configured weaker mode labelled in UI).
4. Caller appends and durably commits the canonical event/record containing
   `ArtifactRef`/`BlobRef`. Only after confirmation does the lease become
   `REFERENCE_COMMITTED` and usage settle. The SQLite owner projection is then
   rebuilt/advanced. If append outcome is uncertain, mark `UNKNOWN`; reconcile the
   canonical log before retrying or releasing the pin.
5. Crash before owner-event commit leaves an orphan protected by its lease until
   recovery reconciles the log. Crash after event append but before projection update
   rebuilds the owner index from the canonical event; it must not collect the object.

Writes are idempotent by `(namespace, operation_id, payload_digest)`. Reuse of the
same operation ID with different bytes conflicts. Concurrent quota reservations are
serialized per namespace; disk-full, file flush, rename, directory-flush, event-log
append, and projection failures are separately typed. Logs and projections are
streamed/line-bounded so a corrupt huge record cannot force whole-log allocation.

### Read, decode, provider use, and export

1. Resolve an exact owner reference; verify schema, digest and stored length before
   returning bytes. Missing, corrupt, unsupported, tombstoned, or over-policy data is
   a typed result, never empty content.
2. Raw bytes remain immutable. A decoder runs in a constrained process/budget with
   format-specific pixel/dimension, expansion-ratio, nesting and wall-clock limits.
   MIME and extension do not authorize active content; SVG/HTML execution is disabled.
3. Provider image use additionally requires a vision-capable model route, a safe
   bounded decode, egress permission, request/context budget and a read lease. API
   body encoding is ephemeral; analytics retain only byte/count/usage metadata, not
   media bytes. Provider-reported media token usage is distinct from estimates.
4. UI displays metadata/typed availability when a bounded renderer is unavailable; the ARCH/product/INTERACTIONS.md rich preview target uses the
   same integrity-checked bounded decoder. Export writes all referenced bytes to a
   temporary bundle with a digest manifest and publishes the bundle only after full
   validation. Import validates every path/ref/byte before atomically publishing a
new namespace; it cannot overwrite an existing Thread/run.

### Reference-safe garbage collection

GC is a CMP-artifact-owned maintenance effect coordinated through controller admission, never a worker tool. It requires the
retention policy to expire and a complete enumeration of Thread logs, run/control
logs, retained checkpoints, evidence, export jobs, maintenance jobs, quarantined
recovery tails, migration generations, and active read/write/reference leases.
Directory/read/iterator errors, unknown owner stores,
unreconciled logs, expired-but-not-reconciled leases, or an unsupported schema abort
the sweep with zero deletions.

GC first records a durable mark and source watermarks; it does not delete during the
mark scan. Before unlinking each candidate it obtains an exclusive per-artifact fence,
reconciles expired leases and canonical references at the current owner heads, and
atomically tombstones the object. A concurrent pin/reference must acquire the matching
lease; if tombstoned, it must restage and verify bytes before appending a new reference.
The tombstone and deletion receipt are audited and idempotent. If unlink outcome is
unknown, retain tombstone and reconcile filesystem state before retrying. Never infer
unreferenced status from a refcount alone. Exported external copies have independent
retention; HorizonCode-managed export jobs remain explicit owners until complete,
expired, or cancelled.

## Settings and UI contract

`/settings session storage` exposes requested/effective inline-event, per-object,
per-namespace encoded-byte, decoder, per-record/segment/Thread/Run event-log,
replay-batch, and control-reserve ceilings; current/reserved bytes by storage class;
physical-reserve allocation/state; retention and orphan grace; filesystem backend
and actual durability level; and locked policy limits. Numeric defaults are published as finite
ceilings and shipped defaults in `DEC-058` and carried by the `horizoncode-config`
schema; a configuration may lower them, never raise them. A cleanup preview reports candidate
count/bytes and owner-source completeness; any incomplete scan disables deletion.
Users may change retention or lower limits; they cannot force deletion of referenced
artifacts/log history or raise a compiled safety ceiling. Quota exhaustion names the
storage class and limit, keeps prior event/history intact, and for an active run
offers only safe options such as waiting, stopping, or requesting a policy-permitted
capacity increase after a disk-space check; it never offers to prune active canonical
history. Post-terminal export/archive or explicit cleanup is a separate authorized
retention action, not an implicit quota fallback.

The transcript renders missing/corrupt/unsupported media as an accessible metadata
placeholder (type, size, digest prefix, status and cause), never a blank image tile or
raw base64. Partial model output is a distinct incomplete attempt and is not merged
with a retried answer (`ARCH/product/UI.md`, `ARCH/core/AGENT-LOOP.md`). Storage, collection and export progress
are durable events; notification/sound preferences cannot hide a blocking quota or
integrity failure.

## Failure and acceptance

| Failure | Contract |
|---|---|
| Byte/namespace quota reached | Reject before unbounded allocation; persist typed refusal and do not append a dangling ref. |
| Temp/digest path is symlinked or digest content differs | Refuse, preserve source, audit; never follow or replace. |
| Power loss/disk full during write/publication | No owner event references unverified bytes; reconcile temp/orphan state on restart. |
| Owner append is uncertain | `UNKNOWN`; query canonical log by operation/event ID; never duplicate/refund blindly. |
| Partial owner-store enumeration | Abort the GC sweep with no deletion. |
| Missing/corrupt/unsupported artifact on replay | Typed placeholder; dependent evidence becomes `INSUFFICIENT_EVIDENCE` until repaired from verified source. |
| Decoder/parser resource exhaustion | Terminate decoder, retain immutable source, return typed unavailable/rejected. |
| Required durability mode unsupported | Refuse durable Run/Thread operation; no silent fallback. |
| Physical control reserve cannot be proved or disappears after restart | Refuse activation or keep run `RECONCILING`/`STOPPED`; a ledger-only reservation cannot satisfy the guarantee. |
| Migration interrupted | Source namespace remains authoritative; discard/rebuild target from source and verify full ref graph before atomic manifest switch. |
| GC delete response lost | Tombstone stays; reconcile actual object existence before repeat. |

Acceptance is `ACC-P1-09` in `ARCH/acceptance/ACCEPTANCE-MATRIX.md`; migration tasks and exact default ceilings
are tracked in `TODO.md` `AX-348`.


## Developer artifact views 

The immutable artifact store may hold typed developer outputs including Diff,
TestReport, CoverageReport, BenchmarkReport, Screenshot, BrowserTrace,
ArchitectureDiagram, Flamegraph, BuildLog, StaticAnalysisReport, and ProofPackManifest.
Each artifact retains bytes, digest, provenance, tested revision/environment where
applicable, and an explicit viewer/MIME hint. A viewer hint selects a bounded renderer;
it never decodes untrusted content without limits or changes evidence verdict. Proof
Pack manifests reference existing immutable evidence and do not become a second
verification authority.

### Proof and preview boundaries

Viewer/MIME hints are advisory metadata; active HTML/SVG/script execution is disabled.
V1 metadata-only behavior remains explicit when no bounded decoder exists. Full output
means exact retained captured bytes, with a capture-limit marker if the process stream
exceeded its cap. Storage and proof metadata expand in the inspector; missing/corrupt
media still shows a plain reason and recovery action. Artifact digest proves byte
identity, not factual correctness, test coverage, or Task PASS. Physical reserve and reference-safe GC must meet their named acceptance obligations.

## Catalog, renderer and feedback contracts

```text
ArtifactDescriptorV1 {
  schema_version: 1, artifact_ref: ArtifactRef, title, kind,
  source_owner_kind, source_owner_id, source_event_cursor,
  version_parent_ref?, workspace_revision?, evidence_refs[],
  availability: available|missing|corrupt|unsupported|over_limit|denied,
  renderer_id?, renderer_version?, text_alternative_ref?
}
ArtifactFeedbackV1 {
  schema_version: 1, feedback_id, principal, artifact_ref,
  anchor?: {kind: line|cell|region, coordinates, source_digest},
  body_ref, created_at, state: open|resolved|withdrawn, event_cursor
}
RendererCapabilityV1 {
  renderer_id, version, accepted_mime[], max_encoded_bytes,
  max_decoded_bytes, max_pixels?, max_nodes?, max_duration_ms,
  presentation: text|syntax|image|diagram|external_browser,
  availability, unavailable_reason?, policy_digest
}
```

All variable text/arrays are bounded by the config schema, with finite compiled
ceilings; oversized records refuse before append. Catalogs are owner-scoped rebuildable
indexes, not a new artifact namespace. A version is a new immutable object plus an
owner event; never overwrite the previous bytes. Feedback is committed to its Thread
or Run owner, always attached to an exact version; it is untrusted input and cannot
approve a patch, settle an effect or create verification evidence.

`/artifacts [list|show <ref>|search <query>]` opens one pageable picker filtered by
Thread/Run/Task/type/date. Actions: Preview, Attach, Open, Copy reference, Export.
Empty, loading, offline index, incomplete coverage, denied, stale and corrupt states
have explicit text and retry/rebuild where safe. Enter previews; Attach is an explicit
action preserving the composer. Escape returns focus and scroll. Browser Open and
Export use separate guarded effects. Copy confirms success or offers local file output
on unavailable clipboard. No auto-publish/upload or browser opening on generation.

Rich text/diff/report/diagram/image previews require an available bounded renderer. Metadata remains the fallback. Active
HTML/SVG/script is never executed in the TUI. Diagram rasterization is constrained;
interactive HTML uses an explicitly opened isolated local browser artifact with no
network, connector, filesystem or download authority unless separately granted.
Unimplemented isolation makes that renderer unavailable. Proof views share the picker,
but verifier verdicts stay independent of preview, comments and byte digests.

`/artifact-capabilities` loads a bundled skill with a current renderer/model/integration
capability snapshot, its scope and limitations. It cannot install or grant capabilities.
`/artifact-diagramming` loads a bundled authoring skill: choose the smallest useful
diagram, label relationships, support light/dark palettes, include a text alternative,
and export source plus bounded preview. Portable Markdown/Mermaid is the initial
authoring format; SVG is optional renderer input. Skills use the existing registration,
collision handling and digest checks, not special dispatchers.

