# P2 Kernel Foundation: Versioned Owner Log, Artifacts, Thread, and Startup

**Status:** Approved for implementation by the user's explicit instruction on 2026-10-09.
The corresponding `arch_V1/` contracts must be updated before behavior is implemented.
This approval and document do not claim P2 acceptance.

**Date:** 2026-10-09

## Intent and success

Establish the smallest coherent kernel foundation needed for P2 canonical Thread and for
later P1 CompositionService and P4 RepoIntelService/MemoryService owners. Keep OpenCode
Core V2 as the host runner and preserve its Session/API surface through an adapter. All
canonical writes go to one Rust-owned per-owner event store; host SQLite remains a
rebuildable projection and migration input only.

P2 success requires the `arch_V1/10-DELIVERY.md` gate: crash/restart and exact retry/conflict
preserve conversation semantics; replay, projection rebuild, snapshot+replay, retention
resnapshot, and migration preserve history; imports are explicit and idempotent; uncertain
provider calls or legacy effects are never replayed as success; and two writable transcript
authorities are impossible by construction. Windows `run_durable` remains unavailable until
DEC-V1-17 has an accepted backend.

## Existing facts and constraints

- `arch_V1/04-STATE-EVENTS.md:51-83` defines the logical event envelope and BLAKE3 payload
  digest, and describes the historical segmented committed-head physical seam. The
  historical `horizoncode-eventlog` source is absent from this checkout and was not found in
  public searches; the historical format's compatibility therefore cannot be claimed.
- `arch_V1/10-DELIVERY.md:73-91` requires one canonical Thread owner, idempotent delivery,
  bounded private IPC, and preservation of the old physical format unless a versioned
  migration is explicitly approved.
- `arch_V1/13-COMPOSITION-IPC.md:368-481` defines the private MessagePack transport,
  request/receipt semantics, owner cursors, and the distinction between OS peer
  authentication and hello nonce validation.
- OpenCode Core V2 currently persists `EventV2` and Session projections through SQLite
  (`packages/core/src/event.ts`, `packages/core/src/session.ts`,
  `packages/core/src/database/database.ts`). The DB uses WAL and `synchronous=NORMAL`; it is
  not the accepted canonical `run_durable` store.
- `packages/schema/src/thread-v1.ts` and `event-payload-v1.ts` define browser-safe record
  shapes only. Per `packages/schema/AGENTS.md`, Schema must not gain service/runtime
  behavior. `packages/opencode/AGENTS.md` requires existing Effect `Context.Service`,
  `Layer`, `Scope`, and `InstanceState` patterns rather than a second framework.
- `kernel/` is currently a bounded protocol/startup/transport crate. No ArtifactService,
  ThreadService, supervisor lifecycle, or historical event-log implementation is present.
- The pinned OpenCode source tree exists locally but is ignored by the root allowlist. This
  spec does not add that source base or close P0 provenance/build gates.

## Decision: one versioned owner-log migration

Three directions were considered:

1. **Recover and reuse the historical crate.** This would preserve physical compatibility,
   but no verified source is available locally or from the targeted public search. Do not
   claim recovery or block all design work on an unbounded search.
2. **Add an explicit OwnerLog V2 migration — selected.** Implement one canonical Rust store
   under `kernel/`, with an explicit on-disk format version and the owner/commit/replay
   invariants below. This is a new versioned format, not a compatible reimplementation of
   the missing crate. An encountered unknown/legacy format is preserved and refused for
   writes; migration requires a separately verified reader and tested importer.
3. **Promote OpenCode EventV2 SQLite — rejected.** It conflicts with the frozen one-owner
   Rust authority, `run_durable`, and projection-only rule; it would also leave two
   transcript authorities during cutover.

The selected migration is approved for implementation. Update the corresponding
`arch_V1/04-STATE-EVENTS.md`, `09-SOURCE-MAP.md`, `10-DELIVERY.md`,
`13-COMPOSITION-IPC.md`, `17-GOVERNANCE-DECISIONS.md`, and `18-OPERATIONS-RELEASE.md`
contracts together before changing runtime behavior.

## OwnerLog V2

### Ownership and storage shape

- The owner is a Rust module in `hz-kernel`; it is the only canonical event writer. Each
  owner has its own sequence and committed head; no global ordering is invented.
- Store each owner beneath a lowercase-hex BLAKE3 directory key over
  `u32be(kind_byte_length) || kind_UTF8 || u32be(id_byte_length) || id_UTF8`; require each
  nonempty owner field to be at most 256 UTF-8 bytes. The committed head records the original
  owner identity; input IDs are never concatenated into filesystem paths.
- Use bounded, append-only canonical JSONL segments and one atomically replaced committed
  head per owner. Both segment and head carry format version 2. A head binds owner kind/ID,
  schema version, generation, committed sequence, committed event digest, active segment,
  committed byte offset, and the named durability profile.
- A physical record carries sequence, timestamp, dotted event kind, bounded `data`, the
  previous event digest, and its event digest. Serialize the physical envelope in fixed
  field order; recursively sort object keys in `data`. Preserve semantic order in ordered
  arrays and enforce each set-like array's declared order/uniqueness. Encode strings as
  stored UTF-8 without normalization, per `arch_V1/12-DOMAIN-SCHEMAS.md:183-197`.
- `event_digest` is BLAKE3 over the canonical physical record with its output digest omitted.
  `payloadDigest` remains the logical family-payload BLAKE3 defined by §4; it is not a second
  physical chain. Physical digests are lowercase hex internally and use the shared `Digest`
  representation at JSON/RPC boundaries.
- Physical records are capped at 1 MiB and segments at 16 MiB. Those limits are fixed kernel
  constants, never caller-controlled. Rotation seals a segment; sealed prefixes are immutable.

### Append, retry, and recovery

1. Validate the authenticated owner request, schema, expected cursor, owner epoch, and
   authorization before any canonical write.
2. Stage and durably publish every referenced immutable artifact before appending events.
   Artifact publication is not a cross-store transaction; an unreferenced artifact is a
   recoverable orphan, never a committed owner fact.
3. Append the full command's bounded event batch to one owner stream and synchronize the
   segment under its named durability profile.
4. Write a new head to a same-directory temporary file, synchronize it, atomically replace
   the old head, and synchronize the parent directory when the platform backend supports
   the selected durability profile. Only then return the committed cursor and receipt.
5. Persist the stable delivery ID and canonical command digest in the committed owner data.
   A rebuildable lookup may accelerate replay, but it is not authoritative. Exact retry
   returns the original receipt; a different digest for the same delivery ID returns
   `REPLAY_CONFLICT`.

On open, validate the head and replay exactly its committed prefix, verifying sequence,
owner binding, schema, canonical encoding, and the one digest chain. Bytes after the committed
offset are uncommitted: never promote them during recovery. Preserve them for diagnosis and
start subsequent writes in a fresh segment. Corruption of committed history fences the
owner and returns a typed failure; it does not fall back to SQLite or another store. Unknown
format versions return `FORMAT_MIGRATION_REQUIRED` without rewriting files.

### Artifacts and canonical bytes

- ArtifactService is a sealed Rust kernel owner shared by Thread and later Composition,
  RepoIntel, and Memory owners. Its interface is bounded `put`, metadata lookup, authorized
  read, and sequential chunk transfer; it does not expose a filesystem path.
- Content identity is BLAKE3 over the exact immutable artifact bytes. Verify declared byte
  length and digest before publishing. Store by digest under the kernel state root; use
  create-new temporary files, synchronize before publication, and never overwrite a
  different object at an existing digest path.
- Chunk bodies remain at or below the §13 maximum of 768 KiB, with exact declared total
  length/digest and sequential offsets. The owner authorizes each reference; a valid digest
  alone grants no access. Metadata remains owner-controlled and follows `ArtifactMetadataV1`.
- Canonical typed event payload bytes follow §12.1/§4 and receive shared Rust/TypeScript
  golden vectors. Schema defines shapes only. Sensitive-artifact support must not silently
  downgrade encryption; if the configured state-key facility is unavailable, reject the
  protected operation with an explicit typed error.
- Garbage collection is not part of initial append correctness. It may delete only objects
  proven unreferenced by a complete owner-reference scan and the retention policy; missing
  or inaccessible objects remain explicit errors.

### Durability profiles and Windows

The backend exposes named durability capabilities and refuses `run_durable` if any required
file-data, committed-head, or directory-entry synchronization step is unsupported. The
Windows adapter may use `FlushFileBuffers` and write-through replacement primitives, but
those API calls alone are not acceptance evidence. Microsoft documentation establishes
file-buffer flushing and a limited write-through move guarantee; it does not by itself prove
the required directory-entry power-loss behavior. DEC-V1-17 stays unresolved until native
Windows crash/recovery and filesystem acceptance evidence is recorded. Unsupported
filesystems remain fail-closed.

## Startup handshake and readiness

Keep OS peer authentication separate from protocol negotiation. After authenticating the
exact pipe/socket peer, the host sends the existing `KernelHelloV1`. The kernel returns a
typed `KernelHelloResultV1` containing the selected protocol, enabled features, unavailable
optional features, and the echoed supervisor nonce/process incarnation. A required-feature
or protocol mismatch returns a typed rejection and closes the connection.

The private V1 wire shapes are:

```ts
type KernelHelloResultV1 = {
  kind: "hello_result"
  protocol: 1
  enabledFeatures: string[]
  unavailableOptionalFeatures: string[]
  supervisorNonce: string
  processIncarnation: string
}
type KernelHelloRejectedV1 = { kind: "hello_rejected"; error: TypedErrorV1 }
type KernelStartupStatusV1 =
  | { kind: "startup_status"; protocol: 1; state: "STARTING" }
  | { kind: "startup_status"; protocol: 1; state: "READY" }
  | { kind: "startup_status"; protocol: 1; state: "FAILED"; error: TypedErrorV1 }
```

After a successful hello result, the kernel emits typed startup status (`STARTING`, then
`READY` or `FAILED`). The host sends no application RPC before `READY`; the kernel rejects
early requests. `READY` is emitted only after canonical log validation, owner-epoch
acquisition, recovery/reconciliation, and required service readiness. It carries no human
principal or permission claim. On failure the kernel sends a bounded typed error, fences
the startup instance, and admits no managed work. A finite supervisor-owned startup timeout
is enforced; a client cannot extend it.

This adds private protocol messages only; it does not add a public HTTP endpoint or permit
the host to assert peer authentication, owner epoch, authorization, or readiness.

## ThreadService and OpenCode adapter

- ThreadService in `hz-kernel` owns Thread/input/Turn/message/ToolBatch transitions in
  OwnerLog V2, including expected-cursor checks, stable delivery IDs, typed receipts, owner
  cursors, and replay. It is the only canonical transcript writer.
- A host `ThreadStoreService` adapter implements the existing Core V2 Session seam over the
  private RPC channel. Provider execution, streaming, and the Core V2 turn loop stay in the
  host; durable admission and committed conversation facts go to ThreadService. No provider
  token delta is sent to the kernel.
- OpenCode SQLite tables and `EventV2` subscriptions become rebuildable projections and
  presentation notifications. Projection failure never rolls back or deletes committed
  Thread history. Production APIs cannot write SQLite as an alternate canonical transcript.
- Import is read-only against the legacy Session DB. It creates the one-to-one Session alias
  and import receipt with source digest and owner cursor; retries are idempotent. Preserve
  fork links, ordered messages/tool history, available attachments, and compaction metadata.
  Missing data is explicit. Uncertain provider calls and legacy effects import as uncertain
  history and are never replayed or promoted to Guarded success.

The host adapter's error mapping preserves existing OpenCode API compatibility while
mapping kernel `NOT_FOUND`, `REPLAY_CONFLICT`, `UNKNOWN_OUTCOME`, `RESNAPSHOT_REQUIRED`,
`KERNEL_NOT_READY`, `FORMAT_MIGRATION_REQUIRED`, and `DURABILITY_UNAVAILABLE` into typed
domain/protocol errors. Application ingress supplies the authenticated principal context;
the kernel never trusts a principal or authorization boolean supplied in a plugin/model
RPC body.

## Dependencies and explicit non-goals

- P1 CompositionService will consume ArtifactService and OwnerLog V2; its lifecycle/lease
  implementation and hook/capability digest preimages receive a separate P1 spec.
- P4 RepoIntelService and MemoryService will consume ArtifactService, ThreadService,
  authorized WorkspaceService/Guard reads, and supervised Indexd. Their implementations
  receive a separate P4 spec; Indexd remains a derived worker without filesystem or
  canonical-store access.
- This spec does not implement P1 generation activation/drain/quarantine, P4 repository
  acquisition/indexing/memory, the full Guard or WorkspaceService, UI changes, or P0 source
  provenance/OpenCode-base inclusion.
- This design does not claim native Windows acceptance, DEC-V1-17 resolution, or clean-clone
  builds while the OpenCode base remains ignored/untracked.

## Verification design

- Rust unit/property tests for canonical encoding, hash vectors, owner/path binding, strict
  version parsing, limits, event chain, head replacement, exact retry/conflict, and all
  append/recovery boundaries.
- Crash-injection integration tests at artifact write/sync, segment append/sync, head temp
  sync, atomic replace, and parent-directory sync. Reopen must expose exactly the old or new
  committed prefix, never an acknowledged partial batch.
- Thread tests for admission/import idempotency, cursor conflicts, projection deletion and
  rebuild, snapshot+replay, retention resnapshot, fork/history preservation, and uncertain
  legacy effects not being replayed.
- Protocol golden tests for hello result, feature negotiation, startup status, early-request
  rejection, typed failure, nonce/process binding, and peer-authentication ordering.
- TypeScript/Rust golden fixtures prove identical canonical bytes and digests. TypeScript
  tests remain in direct V1 Schema/Core entrypoints; Rust tests exercise the authoritative
  owner implementation.
- Run targeted Rust tests/fmt/Clippy and relevant Schema/Core tests/typechecks first. Run
  Linux tests locally; cross-compile Windows tests; execute them on a supported native
  Windows/MSVC host. Do not report `run_durable` acceptance until native crash/power-loss
  evidence and DEC-V1-17 approval exist.

## Review checklist for this design

- One canonical event store; no SQLite authority and no parallel hash chain.
- Version 2 is not misrepresented as recovered V1 compatibility; old/unknown data is
  preserved and refused for writes until a tested importer exists.
- Artifact bytes are durable before references commit; authorization is owner-based, not
  digest-based; protected storage never silently downgrades.
- Hello negotiation, OS peer authentication, and startup readiness are distinct facts.
- Host Core V2 remains the sole model/Turn runner; ThreadService owns durable conversation
  truth; projections are rebuildable.
- Windows/platform and P0 provenance limits remain visible; schema tests or cross-compilation
  are not acceptance evidence.
