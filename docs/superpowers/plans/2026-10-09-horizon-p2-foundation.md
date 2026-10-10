# HorizonCode P2 Foundation Implementation Plan

> **For agentic workers:** Use the Native execution method in this session. Work task by task, with focused tests before implementation and fresh verification after each task.

**Goal:** Implement the approved P2 persistence/protocol foundation while keeping canonical Thread ownership and P2 acceptance explicitly open until their remaining delivery gates pass.

**Architecture:** Rust `kernel/` is the private transport and future canonical owner boundary. Add the versioned OwnerLog V2 as the sole canonical persistence engine, an immutable ArtifactService storage seam, and explicit hello/readiness messages. OpenCode SQLite remains projection/import input only. Linux implementation evidence does not imply Windows `run_durable` acceptance.

**Tech Stack:** Rust 2024, Cargo, existing bounded MessagePack codec, BLAKE3, canonical JSON, standard filesystem APIs, a private bundled-SQLite derived index, and targeted Rust unit/integration tests.

**Spec:** `docs/superpowers/specs/2026-10-09-horizon-p2-kernel-foundation-design.md`

## Global Constraints

- Keep one canonical event store and one digest chain per owner; do not use host SQLite as canonical state.
- Use per-owner monotonic sequences; do not create a global sequence.
- Persist immutable artifact bytes before committing owner references; digest alone grants no read authority.
- Reject unknown log format versions without rewriting or truncating source data.
- Never acknowledge a mutation before the configured durability profile is satisfied.
- Fail closed when the selected platform cannot satisfy the named durability profile; DEC-V1-17 remains unresolved for Windows.
- Keep OS peer authentication, protocol negotiation, canonical-state validation, owner-epoch acquisition, recovery, and readiness as separate facts.
- Do not claim P2 completion until the `arch_V1/10-DELIVERY.md` gate, including Thread import/replay/projection evidence, passes.

## Review Focus

- Torn append or failed head replacement: recovery exposes only the old or new committed prefix, never an acknowledged partial batch.
- Corrupt committed data or unknown format: owner is fenced and source bytes remain untouched; no projection fallback.
- Repeated delivery ID with identical/different command digest: return original receipt / `REPLAY_CONFLICT` respectively.
- Artifact digest/length mismatch or unauthorized read: reject before publication/return; never treat content address as authority.
- Early RPC before `READY` or a hello mismatch: reject without admitting application work.

---

## File Map

- Modify `arch_V1/04-STATE-EVENTS.md`, `09-SOURCE-MAP.md`, `10-DELIVERY.md`, `13-COMPOSITION-IPC.md`, `17-GOVERNANCE-DECISIONS.md`, and `18-OPERATIONS-RELEASE.md` to record the approved physical-format migration and handshake contract.
- Modify `kernel/Cargo.toml` and `kernel/Cargo.lock` for pinned digest/JSON dependencies.
- Create `kernel/src/owner_log.rs` for versioned owner identity, canonical records/head encoding, append/recovery, per-owner cursor, and delivery deduplication.
- Create `kernel/src/artifact_store.rs` for immutable content-addressed byte storage; expose reads only through an authorization seam, not a raw path API.
- Modify `kernel/src/protocol.rs` and `kernel/src/startup.rs` for typed hello result/startup status framing and the not-ready admission check.
- Modify `kernel/src/lib.rs` to export only the intended kernel interfaces and accurately state implementation limits.
- Keep OpenCode adapter integration out of this foundation task until its ignored source base is intentionally tracked under the P0 provenance/build rules; record this as remaining P2 work rather than inventing a competing package owner.

## Tasks

### Task 1: Record the approved persistence and handshake contracts

**Files:**
- Modify: `arch_V1/04-STATE-EVENTS.md`
- Modify: `arch_V1/09-SOURCE-MAP.md`
- Modify: `arch_V1/10-DELIVERY.md`
- Modify: `arch_V1/13-COMPOSITION-IPC.md`
- Modify: `arch_V1/17-GOVERNANCE-DECISIONS.md`
- Modify: `arch_V1/18-OPERATIONS-RELEASE.md`
- Test: documentation consistency checks (`git diff --check`, phase/error/source references)

**Interfaces:** No code interface. The normative docs must identify OwnerLog V2 as the one canonical physical format and specify the hello-result/readiness sequence. Historical format compatibility stays unclaimed.

- [x] Replace the absent-historical-crate implementation instruction with the approved versioned-migration decision; preserve the logical event envelope and existing projection-only rule.
- [x] Specify V2 physical record/head/segment version fields, canonical bytes and hash preimage, append-before-head commit ordering, recovery behavior, and unknown-version refusal.
- [x] Specify `KernelHelloResultV1`, startup `STARTING`/`READY`/`FAILED` statuses, early-RPC rejection, and the ordering relative to OS authentication, epoch, and recovery.
- [x] Keep DEC-V1-17 unresolved and explicitly deny Windows `run_durable` acceptance absent native evidence.
- [x] Run `git diff --check` and verify the P2 delivery gate and error names remain consistent across the six documents.
- [x] Stage only the six amended architecture files plus this plan/spec/AGENTS handoff and commit as `docs(architecture): approve owner log v2 migration`.

### Task 2: Add fixed typed negotiation-result and startup-status messages

**Files:**
- Modify: `kernel/src/protocol.rs`
- Modify: `kernel/src/startup.rs`
- Test: focused protocol/startup unit tests in those modules

**Interfaces:**
- Produce `KernelHelloResultV1 { protocol: u16, enabled_features: Vec<String>, unavailable_optional_features: Vec<String>, supervisor_nonce: String, process_incarnation: String }` and `KernelHelloRejectedV1 { error: TypedErrorV1 }` with wire discriminators `hello_result` / `hello_rejected`.
- Produce `KernelStartupStatusV1` with `Starting`, `Ready`, or `Failed(TypedErrorV1)` and wire discriminator `startup_status`; no status value authenticates a peer or asserts a human principal.

- [x] Add fixed wire-vector tests for hello result and each startup status, including omission/presence rules.
- [x] Run `cargo test --offline --manifest-path kernel/Cargo.toml protocol::tests::hello_result` and confirm the new tests fail for missing variants/decoders.
- [x] Implement strict encode/decode validation, bounded strings/features, nonce/process-incarnation echo validation, and no unknown-field acceptance beyond current protocol rules.
- [x] Add tests for required-feature rejection, incompatible protocol, wrong nonce/incarnation, malformed status/error, and feature-list bounds; the existing negotiation test covers required-feature/protocol rejection.
- [x] Run `cargo test --offline --manifest-path kernel/Cargo.toml`, `cargo fmt --manifest-path kernel/Cargo.toml -- --check`, and warning-free Clippy.
- [x] Commit the verified protocol change as `feat(kernel): add startup handshake result`.

### Task 3: Implement canonical OwnerLog V2 record encoding

**Files:**
- Modify: `kernel/Cargo.toml`, `kernel/Cargo.lock`
- Create: `kernel/src/owner_log.rs`
- Modify: `kernel/src/lib.rs`
- Test: `kernel/tests/owner_log_golden.rs` plus shared fixtures under `kernel/tests/fixtures/owner-log-v2/`

**Interfaces:**
- `OwnerIdentity::new(kind: String, id: String) -> Result<OwnerIdentity, OwnerLogError>` validates non-empty UTF-8 identity fields of at most `MAX_IDENTIFIER_BYTES` (256 bytes each). The path-key preimage is `u32be(kind_byte_length) || kind_UTF8 || u32be(id_byte_length) || id_UTF8`.
- `OwnerEventInput { schema_version: u16, time_ms: u64, kind: String, data: serde_json::Value, delivery_id: Option<String>, command_digest: Option<String> }` is a validated append input; delivery metadata is committed in the same owner record.
- `OwnerLogV2::encode_record(record: &PhysicalRecordV2) -> Result<Vec<u8>, OwnerLogError>` emits exactly one bounded canonical JSON line plus LF.
- `OwnerLogV2::event_digest(record: &PhysicalRecordV2) -> Result<Digest, OwnerLogError>` hashes the fixed-field-order record with its output digest omitted using BLAKE3.
- `OwnerHeadV2::new(...)`, `OwnerLogV2::head_digest`, and `OwnerLogV2::encode_head` encode the fixed-order committed head and verify its self-excluding digest; `SegmentSealV2::new(...)` binds exact committed-prefix bytes and `encode_seal` emits fixed-order metadata.

- [x] Add fixtures/tests for recursively sorted JSON keys, fixed envelope field order, UTF-8 preservation without normalization, array-order preservation, and exact BLAKE3 vectors.
- [x] Run focused tests and verify they fail before implementation.
- [x] Pin `blake3` to `=1.8.7` and `serde_json` to `=1.0.150`; do not enable map-order-preservation features that would defeat sorted keys.
- [x] Implement record/head/seal schemas, canonical encoding, digest formatting, and bounds; reject non-finite numbers and out-of-range numeric values before serialization.
- [x] Test malformed digest, invalid owner/event fields, oversized/deep data, unknown format version, and exact fixture bytes. Raw duplicate-key rejection is assigned to Task 4's replay decoder because `serde_json::Value` cannot retain duplicate keys.
- [x] Run all Kernel tests, fmt, and warning-free Clippy offline.
- [x] Commit the verified codec change as `feat(kernel): add owner log v2 codec`.

### Task 4: Implement append, committed-head recovery, and delivery idempotency

**Files:**
- Modify: `arch_V1/04-STATE-EVENTS.md`, `arch_V1/18-OPERATIONS-RELEASE.md`, `docs/superpowers/specs/2026-10-09-horizon-p2-kernel-foundation-design.md`
- Modify: `kernel/Cargo.toml`, `kernel/Cargo.lock`
- Create: `kernel/src/owner_log_index.rs`
- Modify: `kernel/src/owner_log.rs`
- Test: fault-injection and filesystem integration tests in `owner_log.rs` / `kernel/tests/owner_log_recovery.rs`

**Interfaces:**
- `OwnerLogV2::open(root: &Path, owner: OwnerIdentity, profile: DurabilityProfile) -> Result<OwnerLogV2, OwnerLogError>` validates the current format/head and opens the committed stream.
- `OwnerLogV2::append_batch(&mut self, delivery_id: &str, command_digest: &str, events: &[OwnerEventInput], expected: Option<&CursorV1>) -> Result<CommitReceiptV1, OwnerLogError>` commits one bounded owner batch.
- `OwnerLogV2::read_after(&self, cursor: Option<&CursorV1>, limit: NonZeroUsize) -> Result<ReadBatchV1, OwnerLogError>` returns only committed records.
- `CommitReceiptV1` returns the delivery ID, command digest, latest owner cursor, event count, and receipt digest; exact retries return this original receipt.
- `OwnerLogV2::command_digest(delivery_id, events)` computes the Task 4 canonical command digest; `append_batch` rejects any supplied digest that does not match. Its v1 preimage is documented in `arch_V1/04-STATE-EVENTS.md`.
- `ReadBatchV1` returns committed events after an optional owner-scoped cursor, a final cursor, and `has_more`; cursor mismatch never becomes global ordering.
- A private rebuildable disk index accelerates delivery-receipt lookup and segment paging. OwnerLog V2 remains authoritative; index rows are reconstructed from the committed stream and are discarded/rebuilt when invalid.
- `DurabilityProfile::RunDurable` is rejected on any platform/backend unable to synchronize file and parent-directory metadata as required.

- [x] Add failure-injection tests for segment append/sync, head temp write/sync, head replacement, and parent-directory sync; assert recovery returns precisely the old or new committed prefix.
- [x] Add exact-retry and conflicting-delivery tests, expected-cursor conflict tests, and a test proving same delivery IDs in different owners are independent.
- [x] Add recovery tests for torn uncommitted tail, corrupt committed record, owner/head mismatch, unknown format, and preservation of original bytes on refusal.
- [x] Implement staged segment append, sync-before-head publication, atomic same-directory head replacement, committed-prefix replay, and typed fencing errors.
- [x] Keep any orphaned tail bytes for diagnosis and continue in a fresh segment; never promote them into the head or truncate silently.
- [x] Bound paginated reads to replay-validated segment summaries and cover clean in-place append failures; reject unsupported owner schema versions and keep Unix storage owner-private.
- [x] Fail closed on Windows OwnerLog opens until trusted state-root DACL validation is integrated; this is not Windows runtime or security acceptance.
- [x] Attempt Windows-target test compilation with bundled SQLite; blocked in `libsqlite3-sys` because this Linux environment lacks `lib.exe`. Do not claim native Windows runtime or DEC-V1-17 acceptance.
- [x] Add regressions for corrupt-index reopen/rebuild, exact retry/conflict on a missing receipt row, pagination on missing/corrupt segment rows, canonical-head preservation, and pre-open sidecar symlink rejection.
- [x] Implement a private `rusqlite` index with a bounded 2 MiB SQLite page cache; stream validated OwnerLog history into delivery and segment tables during open. Remove history-sized receipt/segment `BTreeMap`/`Vec` state. Update the index only after canonical head publication; index failure cannot reverse or misreport the canonical result.
- [x] Validate the derived index and journal paths before opening SQLite; create the index owner-only and use bundled SQLite features. The host build passes; cross-target compilation remains unverified due to missing MSVC tools.
- [x] Make indexed receipt and page lookups verify canonical records and fall back to committed-log scans on missing/stale/corrupt index data. Keep the negative filter fixed-size; never cap history or evict delivery IDs.
- [x] Add regressions for orphan segment-ID gaps after failed rotation, missing first segment index row, same-length head/record edits while open, and derived-index transaction failure after canonical head commit.
- [x] Revalidate the disk head and complete committed history before each append/retry; document O(retained history) I/O and the same-OS-identity trust-boundary limitation. This detects prior edits; it is not a mandatory-lock/anti-race guarantee.
- [x] Commit the verified Task 4 index implementation as `feat(kernel): persist owner log commits` (`1aa8207d0`); follow-up review fixes are pending a separate verified commit.
- [x] Run the complete Kernel suite, formatting, strict Clippy, and diff review after review fixes; preserve the Windows toolchain blocker, replay-memory amplification, O(retained history) pre-append I/O, and same-identity writer limitation as explicit constraints.

### Task 5: Add immutable artifact-byte storage behind an authorization seam

**Files:**
- Create: `kernel/src/artifact_store.rs`
- Modify: `kernel/src/lib.rs`
- Test: module unit tests and filesystem integration tests

**Interfaces:**
- `ArtifactAuthorizer` is an injected owner interface with `authorize_read(principal, artifact_ref) -> Result<ReadPermit, ArtifactError>`; no default allow implementation exists.
- `ArtifactStore::put(bytes: &[u8], metadata: ArtifactMetadataV1) -> Result<ArtifactRefV1, ArtifactError>` verifies exact length/digest and publishes create-new immutable bytes before returning.
- `ArtifactStore::read(permit: &ReadPermit, offset: u64, max_bytes: NonZeroUsize) -> Result<ArtifactChunkV1, ArtifactError>` never accepts an unvalidated caller artifact ID as a filesystem path.

- [ ] Test exact-byte BLAKE3 and length validation, duplicate identical put, digest-path collision refusal, chunk offset/size bounds, and read denial without a permit.
- [ ] Implement digest-derived internal paths, staged writes, sync-before-publish, immutable collision handling, and bounded chunk reads.
- [ ] Ensure filesystem paths and raw `File` handles do not cross the public kernel interface; ensure sensitive classification never silently downgrades encryption requirements.
- [ ] Run ArtifactStore tests and full Kernel tests/fmt/Clippy. Until Guard/Artifact owner wiring exists, report this as an internal storage seam, not an enabled production read capability.
- [ ] Commit the verified storage primitive as `feat(kernel): add immutable artifact storage`.

### Task 6: Integration and verification report

**Files:**
- Modify: `kernel/src/lib.rs`
- Modify: `CURRENT_RUN.md`
- Test: Kernel package verification

- [x] Run `HORIZON_OWNER_LOG_TEST_TMPDIR=/tmp/opencode cargo test --offline --manifest-path kernel/Cargo.toml --quiet` (47 unit, 11 golden, 21 recovery tests passed).
- [x] Run `cargo fmt --manifest-path kernel/Cargo.toml -- --check`.
- [x] Run `cargo clippy --offline --manifest-path kernel/Cargo.toml --all-targets -- -D warnings`.
- [x] Attempt `cargo check --offline --manifest-path kernel/Cargo.toml --all-targets --target x86_64-pc-windows-msvc --features blake3/pure`; blocked because `libsqlite3-sys` cannot find `lib.exe` on this Linux host. This is not a native Windows result.
- [ ] Review the complete diff, verify no secrets entered the commit, update `CURRENT_RUN.md` with exact test outcomes, and leave P2 Thread ownership/import and P1/P4 integrations explicitly open until implemented and verified.

## Follow-up work required for the P2 gate

This plan establishes storage/protocol primitives only. A subsequent P2 implementation plan must still cover the canonical ThreadService state transitions and authorization, supervisor/owner-epoch integration, durable delivery receipts and query path, Core V2 ThreadStoreService host adapter, one-to-one legacy Session import and rollback snapshot, rebuildable projection plus replay/resnapshot, and crash/restart integration across the supervised process. None of those requirements is satisfied merely by completing these tasks.
