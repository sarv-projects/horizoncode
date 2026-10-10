# Horizon P2 Thread Cutover Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement
> this plan task-by-task. Use the native execution method already selected by the user.
> Product implementation must wait for review of this plan and resolution of the preflight
> blockers below.

> **Status: Proposed for review.** The P2 Kernel design is approved; this plan does not
> silently resolve architecture ownership or phase-scope questions. Execute in the existing
> `p2-foundation` branch; do not create another worktree.

**Goal:** Complete P2's canonical Thread, supervised Kernel, OpenCode Core V2 adapter,
legacy Session import, projection recovery, and P2 acceptance evidence without claiming
Windows or P0 gates that have not passed.

**Architecture:** Rust `ThreadService` appends canonical owner records to OwnerLog V2;
OpenCode Core V2 keeps its existing runner behind a typed host adapter, and its SQL/event
tables become projections and import input. A bounded, OS-authenticated private RPC connects
the host's single Kernel supervisor to Rust; it is not a public API or second process manager.

**Tech Stack:** Rust 2024, existing bounded MessagePack/OwnerLog V2, BLAKE3 and bundled SQLite
derived indexes; pinned OpenCode Effect v4/Bun Core V2, Drizzle projection tables and the
existing `ChildProcessSpawner`/`ChildProcess` services; canonical Horizon V1 Schema values.

**Spec:** `docs/superpowers/specs/2026-10-09-horizon-p2-kernel-foundation-design.md`, read with
`arch_V1/10-DELIVERY.md`, `02-DOMAIN.md`, `03-FLOWS.md`, `04-STATE-EVENTS.md`,
`11-LIFECYCLE.md`, `12-DOMAIN-SCHEMAS.md`, `13-COMPOSITION-IPC.md`, and `18-OPERATIONS-RELEASE.md`.

## Global Constraints

- OwnerLog V2 is the only canonical Thread stream; its derived SQLite index is non-authoritative and exact delivery identities are never evicted.
- Core V2 remains the only host Turn runner; prompt admission commits before advisory wake, `resume: false` is admit-only, and restart never retries uncertain provider work.
- Keep all prompt/provider/model/tool execution and permissions Location-scoped; `SessionExecution` remains process-global and Session-ID based.
- Keep `SessionRunCoordinator` process-local: same-Session resumes join, prompt wakes coalesce, and different Sessions can run concurrently. Keep local drains until clustering has a separate design.
- Preserve the existing Session API and one `llm.stream(request)` call per provider turn; reload projected history before durable continuation; do not bridge through `SessionPrompt.loop` or an in-memory replacement loop.
- Preserve prompt delivery semantics: default steer promotes at the next safe turn boundary; explicit queue remains FIFO until otherwise idle and promotes one at a time; exact historical projected-prompt retries lazily synthesize promoted inbox records.
- Thread IDs, OwnerLog cursors and per-owner sequence values are not global order; preserve `UInt64Decimal` without lossy JavaScript `number` conversion.
- Schema owns serializable contracts only; use one canonical schema value/direct V1 entrypoint and do not expose the private Thread RPC through public Protocol/SDK manifests.
- The host authenticates the OS peer and binds request principal; owner epoch and authorization are trusted channel context, never plugin/model request fields.
- Missing Project/Profile/ContextEpoch/Artifact/Guard owners remain unavailable; do not fabricate IDs, grants, reservations, route pins, attachments or success.
- Keep the P0 provenance/root-base/license/build gates and native Windows DACL/pipe/`run_durable` acceptance open until exact evidence exists.

## Review Focus

- Same-named Schema packages or re-export paths create two runtime schema identities — prove exact schema-value identity and package resolution in the preflight test.
- A host-supplied project/profile/context or principal is mistaken for canonical authority — reject missing or mismatched owner evidence in Thread creation/append tests.
- A committed Kernel mutation loses its response or projection write fails — exact retry returns the original receipt and projection replay repairs without duplicate messages.
- Legacy source changes or import crashes mid-saga — refuse digest conflict, preserve the snapshot, and never replay unknown provider/effect outcomes.
- A notification subscriber loses a bounded event range — return `RESNAPSHOT_REQUIRED` and rebuild from an authorized snapshot without pruning OwnerLog history.

---

## Current seams and test owners

- Rust persistence/protocol: `kernel/src/{owner_log.rs,owner_log_index.rs,protocol.rs,
  transport.rs,startup.rs,artifact_store.rs}`; tests under `kernel/src` and `kernel/tests`.
- OpenCode V2 Session: `opencode/packages/core/src/session.ts`, `session/{store,input,
  projector,runner/llm,execution}.ts`, and `core/src/event.ts`. Current `SessionStore` is a
  SQLite reader; `SessionV2.prompt` publishes through SQLite-backed `EventV2`.
- Existing browser-safe contracts: `packages/schema/src/{thread-v1,event-payload-v1}.ts`
  and their tests. Schema owns shapes only, not runtime behavior.
- The repository has two physically separate `@opencode-ai/schema` packages: the Horizon
  `packages/schema` and the pinned OpenCode `opencode/packages/schema`. The OpenCode workspace
  lists only paths beneath `opencode/`, so Core cannot be assumed to resolve the Horizon
  package. Do not duplicate Thread schemas to bypass this seam.
- Focused host tests include `opencode/packages/core/test/session-prompt.test.ts`,
  `session-runner.test.ts`, `session-history.test.ts`, `session-projector.test.ts`, and
  `session-create.test.ts`. Do not run OpenCode tests from the repository root.
- There is currently no Rust Kernel executable, supervisor implementation, Unix peer
  adapter, ThreadService, Core `ThreadStoreService`, or TypeScript Kernel RPC client.
- The approved contracts have P2 prerequisites that are not currently owned by P2 code:
  `ThreadV1` requires an existing Project ID, active ContextEpoch and selected ProfileRevision;
  P3 schedules ContextEpoch implementation and P5 schedules profile authoring/selection,
  while OpenCode config is explicitly not a competing profile authority. `InputAdmissionRequestV1`
  requires an authorized ArtifactRef, but the current ArtifactStore is only a private storage
  primitive and there is no production Artifact/Guard owner. The project-owner row is also
  absent from the canonical owner table. The trusted bridge for binding application-ingress
  principal to a Kernel request (without trusting model/plugin fields) and the restart-stable
  source of `host_instance_id` also need to be established. These are implementation blockers,
  not permission to synthesize placeholder identities or allow-all authorization.

## Preflight gate — shared Schema, owner prerequisites, and Thread event map

### Preflight — Establish the shared Horizon schema bridge and event ownership map

**Files:** inspect `packages/schema/package.json`, `packages/schema/tsconfig.json`,
`opencode/package.json`, `opencode/tsconfig.json`, `opencode/packages/schema/{package.json,tsconfig.json}`
and `opencode/packages/core/{package.json,tsconfig.json}`; modify only the smallest package
bridge required. Add an identity/contract test at the existing schema owner.

1. Prove how the pinned OpenCode Core can consume the exact Horizon `ThreadV1`, cursor,
   event-payload and ArtifactRef schema values without copying/redefining them or adding
   them to the public Protocol/SDK event manifest.
2. Preserve dependency direction Schema → Core/Protocol → Server. Core may consume the
   browser-safe Horizon contract; the private Kernel RPC stays in the host package and is not
   exported through public Schema/Client/Server APIs.
3. Add the smallest deterministic module/workspace bridge and test schema identity plus V1
   direct-entrypoint use. Any facade must re-export the exact canonical Schema value; do not
   create aliases or a second package identity. Do not make the two same-named schema packages
   workspace aliases of one another without proving package-manager and build behavior.
4. Resolve the Project identity, initial ProfileRevision, initial ContextEpoch and authorized
   prompt-ArtifactRef owners from normative contracts. If any are unavailable, record the
   exact minimum owner/interface prerequisite and stop for user review; do not silently pull
   full P3/P5 scope into P2 or report P2 acceptance as attainable without it. Also identify
   the trusted source and restart-stable lifecycle for `host_instance_id`; do not hard-code
   `"local"` or derive it from per-process incarnation.
5. Map every P2 Thread-owned logical event in `arch_V1/04-STATE-EVENTS.md` and
   `11-LIFECYCLE.md` to its typed payload/transition and mark any external-owner receipt
   dependency. P2 ThreadService must own input, Turn, ProviderAttempt, ToolBatch and ordered
   result-link transitions; it must not implement Guard/EffectService as a shortcut.
6. Define private typed V1 contracts `ThreadCreateRequestV1`, `ThreadAppendRequestV1`,
   `ThreadSnapshotRequestV1`, `ThreadReadAfterRequestV1`, `ThreadSnapshotV1`,
   `ThreadEventPageV1`, `ThreadAppendReceiptV1` and `ThreadStoreError`. Core `create` maps to
   an idempotent `thread.append` containing `thread/created`; `thread.append` carries delivery
   ID and expected owner cursor in the existing `RpcRequestV1` envelope; `thread.snapshot`
   returns aggregate state plus captured head; `thread.read_after` returns a bounded ordered
   event page. A successful mutation returns `deliveryId`, `commandDigest`, `ownerCursor`,
   decimal `eventCount` and `receiptDigest`. Kernel recomputes command digest. These names are
   private RPC identifiers, not public API routes.
7. If the exact schema identity cannot be bridged without duplicate package identity, public
   API leakage or an unapproved workspace/base change, stop before implementation and record
   the architecture blocker instead of copying contracts.

**Tests:** package-resolution/typecheck probe; exact exported schema-value identity; Rust/TS
golden vectors for append/snapshot/read-after inputs and receipts; V1 contract remains a direct
entrypoint; optional properties omit `undefined`; stable identifiers are unique; no new public
Protocol/SDK event is emitted.

**Preflight decision:** If Project/Profile/ContextEpoch/Artifact/authorization ownership cannot
be resolved from existing normative owners, do not start Task 1. Ask whether to authorize a
strictly scoped P2 prerequisite slice (and update the governing `arch_V1/` contracts first)
or to keep dependent Session operations unavailable and leave the P2 gate open. A typed
unavailable response is safe interim behavior, but it is not evidence that P2 passed.

### Task 1 — Implement the canonical Thread owner and replay-derived state

**Files:** add `kernel/src/thread.rs`; update `kernel/src/lib.rs`; add focused Thread
fixtures/tests under `kernel/tests/fixtures/thread-v1/` and `kernel/tests/`.

**Interfaces:**

- Consumes: Preflight's single canonical V1 schemas, `OwnerLogV2`, the
  `AuthenticatedRequestContext` contract established by Preflight and populated by Task 2,
  and the existing authorization/Artifact owner contracts
  only if the preflight gate proves they exist or receives approval for the minimum slice.
- Produces: `ThreadService::append(&mut self, context: &AuthenticatedRequestContext,
  delivery_id: &str, expected_cursor: Option<&CursorV1>, command: ThreadCommandV1)
  -> Result<CommitReceiptV1, ThreadError>`; `snapshot(context, thread_id) ->
  Result<ThreadSnapshotV1, ThreadError>`; and `read_after(context, thread_id, after,
  limit) -> Result<ThreadEventPageV1, ThreadError>`. `ThreadCommandV1` binds one Thread and
  an ordered event batch; delivery ID/cursor stay in the existing `RpcRequestV1` envelope.
  Snapshot includes its captured owner head; event pages are sequential, bounded and
  owner-scoped. These are private typed RPC contracts, not public HttpApi methods.

- [ ] Add test vectors first for logical slash ↔ physical dotted event-kind mapping, canonical
  event-family payload digest bytes, strict schema-version dispatch, and exact OwnerLog
  cursor/receipt behavior; run the focused test and observe the expected failure.
- [ ] Define a crate-private `ThreadService` that opens one `OwnerLogV2` per
  `OwnerIdentity("thread", thread_id)`. Keep all public operations typed; never expose a
  path, raw file, or raw `OwnerLogV2` handle.
- [ ] Build state solely by replaying committed records. Implement the approved P2 Thread,
  input, Turn, ProviderAttempt, Message, ToolBatch, question and ordered result-link lifecycle
  transitions from `arch_V1/11-LIFECYCLE.md`; reject stale cursors, duplicate IDs, illegal
  transitions, unsupported schema versions and cross-Thread references before append.
  Treat messages/imported history as untrusted data. Do not implement Guard, EffectService,
  ExecutionHost, context assembly, compaction or DirectDelegation as a shortcut; families
  outside the active P2 slice return typed unavailable without committing a partial event.
- [ ] Implement stable delivery retry/conflict through `OwnerLogV2::append_batch`; store all
  linked facts in the same Thread stream where the contract requires it. Never use an
  in-memory state map as canonical or silently truncate lifetime history.
- [ ] Keep ArtifactStore access behind the authorized ArtifactService seam. If a required
  authorization/Artifact capability is absent, return typed unavailable/denied rather than
  adding a default allow or treating a digest/ID as authorization.
- [ ] Run the focused Rust Thread tests to green, then run all Kernel tests, fmt and strict
  Clippy; inspect the complete Task 1 diff and commit this independently testable slice.

**Tests:** create/read/rename/archive where in P2 scope; admit/steer/queue/promote/cancel;
Turn/provider-attempt/message ordering; ToolBatch rejection and lifecycle receipt validation;
incremental result acknowledgements are immutable and final ordered reports cannot overwrite
them; authorization and owner-epoch rejection; stale cursor and invalid transition; exact
retry versus conflicting delivery; close/reopen replay equivalence; corrupt committed record
fences the owner; no state or receipt inferred from a projection. Tool execution/whole-stream
dispatch behavior is not claimed here; until P3 gates pass, the adapter must not dispatch
provider tool proposals through the legacy stream executor.

**Verify:** focused `cargo test --offline --manifest-path kernel/Cargo.toml thread::tests`;
full Kernel tests, fmt check, and strict Clippy after the task.

### Task 2 — Persist supervisor epochs and enforce startup/write fencing

**Files:** add `kernel/src/supervisor.rs`; update `kernel/src/startup.rs` and `lib.rs`; add
`kernel/tests/supervisor_recovery.rs` (or module tests if the crate-private seam suffices).

- [ ] Persist monotonically increasing supervisor ownership epochs in the canonical
  `OwnerIdentity("supervisor", host_instance_id)` OwnerLog stream under the already
  owner-private state root. `host_instance_id` is stable across restarts; `process_incarnation`
  changes per launch. Use a stable acquisition delivery ID per incarnation and exact retry.
- [ ] Make startup acquire the epoch only after OS peer authentication, hello negotiation and
  canonical-state validation. Readiness remains gated on recovery and required services.
- [ ] Construct an internal authenticated request context from the authenticated channel and
  active epoch and the trusted application-ingress principal binding established at Preflight.
  Thread mutations reject missing/stale epochs; callers cannot set or override it in RPC
  bodies. Loss of the supervisor/channel fences the current startup instance. If the current
  host has no trusted principal bridge, affected operations remain unavailable.
- [ ] Preserve the single-owner rule: a competing Kernel fails closed while the owner lock is
  held. Host supervision must terminate/reconcile an old child before a replacement can
  obtain a new epoch; do not claim epochs alone kill a live stale process.
- [ ] Run supervisor/startup tests to green, then the full Kernel suite, fmt and strict Clippy;
  inspect and commit this independently testable slice.

**Tests:** first epoch and monotonic restart; exact acquisition retry; concurrent/competing
owner refusal; stale epoch rejected after restart; RPC remains unavailable until `READY`;
fencing removes admission and cannot be reversed by a later method call; the same stable
`host_instance_id` is used across process incarnations while process incarnation changes.

**Verify:** focused supervisor/startup tests, then full Kernel suite, fmt and strict Clippy.

### Task 3 — Add a real private RPC dispatch path and supervised Kernel process

**Files:** add a Kernel dispatcher/server module and `kernel/src/bin/hz-kernel.rs`; update
`kernel/Cargo.toml` only if required; add process/transport integration tests. Add
`opencode/packages/opencode/src/kernel/supervisor.ts` and the private RPC transport/client
there; update `opencode/packages/opencode/src/server/routes/instance/httpapi/server.ts` only
at the stable `SessionV2.node` layer-assembly boundary. Do not add route handlers or public
HttpApi endpoints.

- [ ] Dispatch typed `RpcRequestV1` only after authenticated hello and `StartupGate::READY`.
   Validate service, operation, body size/schema, deadline, cancellation and request identity
   before invoking the owner. Map OwnerLog/Thread errors to the contract's typed errors,
   including `NOT_FOUND`, `REPLAY_CONFLICT`, `UNKNOWN_OUTCOME`, `RESNAPSHOT_REQUIRED`,
   `KERNEL_NOT_READY`, `FORMAT_MIGRATION_REQUIRED` and `DURABILITY_UNAVAILABLE`.
- [ ] Use the existing bounded MessagePack/frame codecs. Prefer an inherited private duplex
   channel for a supervised child. Keep Unix and Windows peer checks separate from nonce
   matching. No loopback listener and no unauthenticated fallback.
- [ ] Make the host the single process supervisor: use the existing Effect
   `ChildProcessSpawner`/`ChildProcess` and scoped acquisition/finalization patterns; provide
   its stable layer once at the actual application-layer assembly point(s) that provide
   `SessionV2.node` (never inside a route handler); resolve the Kernel executable only from
   trusted installation/configuration; own child lifecycle
   and inherited handles; enforce a finite startup timeout; observe exit, fence pending work
   and reconcile before restart. Missing binary/transport fails closed; do not fall back to
   SQLite or an in-memory owner.
- [ ] Keep the process client and Kernel process lifecycle outside Schema and outside the Core
   provider runner. Do not change public HttpApi or generated client surfaces for this
   private seam.
- [ ] Implement the bounded cancellation/control lane and bounded subscriber queue. A lost
   notification range produces `RESNAPSHOT_REQUIRED`; it does not trim canonical owner data.
- [ ] Run codec/process integration tests to green, then Rust checks and the relevant OpenCode
   package tests/typecheck; inspect and commit this independently testable slice.

**Tests:** malformed/oversized frame; unauthenticated or incompatible hello; early request;
OS peer authentication distinct from nonce validation; deadline, cancellation and typed
error mapping; subscribe/ack/unsubscribe and lost-range resnapshot; exact delivery retry over
a new connection; child death during append followed by reopen; parent shutdown; startup
timeout; no second child after an existing owner. Run host package tests from its package
directory.

**Platform note:** Linux inherited-pipe tests are development evidence only. Windows named
pipe/DACL and process containment remain separately blocked until a supported MSVC/native
Windows host is available.

### Task 4 — Add the Core V2 ThreadStoreService adapter without changing the runner

**Files:** add a Core-owned `ThreadStoreService` module in
`opencode/packages/core/src/session/`; update `session.ts`, `session/store.ts`, `session/input.ts`
and only the runner call sites required by the adapter. Implement the concrete adapter in
`opencode/packages/opencode/src/kernel/thread-store.ts`; inject it into Core through the
Effect service.

- [ ] Define `ThreadStoreService.Interface` in
  `opencode/packages/core/src/session/thread-store.ts` with typed `create(input)`,
  `append(input)`, `snapshot(input)` and `readAfter(input)` methods using the Preflight V1
  request/result/error types. Keep Core service methods typed; host transport serializes the
  private V1 schemas and
  Rust `ThreadService` remains authoritative. Map `NOT_FOUND` and `REPLAY_CONFLICT` to the
  existing Core Session errors; preserve typed, actionable failures for other RPC codes
  without adding a public HttpApi shape. Preserve the Session API and map each Session ID
  one-to-one to a Thread ID.

  ```ts
  interface Interface {
    readonly create: (input: ThreadCreateRequestV1) => Effect.Effect<ThreadSnapshotV1, ThreadStoreError>
    readonly append: (input: ThreadAppendRequestV1) => Effect.Effect<ThreadAppendReceiptV1, ThreadStoreError>
    readonly snapshot: (input: ThreadSnapshotRequestV1) => Effect.Effect<ThreadSnapshotV1, ThreadStoreError>
    readonly readAfter: (input: ThreadReadAfterRequestV1) => Effect.Effect<ThreadEventPageV1, ThreadStoreError>
  }
  ```
- [ ] Route `SessionV2.create` and `SessionV2.prompt` through ThreadStoreService. For `prompt`,
  return the canonical admission receipt before `SessionExecution.wake`; `resume: false`
  remains admit-only. Same Session ID adopts the existing Session. Same prompt ID only
  reconciles an exact Session/prompt/delivery retry; conflicting reuse returns the existing
  typed conflict.
- [ ] Keep `SessionExecution` process-global and Session-ID based. It discovers Location only
  when a drain starts. A wake is advisory; no automatic post-crash provider continuation.
  Keep provider/model/tool execution in Core V2; never send provider token deltas to Kernel.
- [ ] Route every durable Thread write used by create, prompt, promotion and message/Turn
  history through the adapter. Do not leave hidden write fallbacks in `EventV2.publish` or
  session modules. Nondurable compatibility notifications may remain host-owned.
- [ ] Bind trusted principal/owner context at host ingress and Kernel channel setup, not from
  user/model/plugin JSON. Keep missing authorization or Kernel service explicitly unavailable.
- [ ] Search all Core Session and adjacent control-plane `EventV2.publish` call sites. Classify
  each durable event as Thread-owned, another owner, or non-durable compatibility; route
  Thread facts through ThreadStoreService and fail closed for unsupported canonical writes.
  Do not make this a broad unrelated rewrite of non-Thread domains.
- [ ] Replace canonical reads in `SessionStore.get/context/runnerContext/message` with
  ThreadStoreService reads or a projection verified against a captured canonical head; keep
  SessionStore SQL reads explicitly projection-only.
- [ ] Run the V2 prompt/runner tests to green, then focused Core tests and `bun typecheck` from
  `opencode/packages/core`; inspect and commit this independently testable slice.

**Tests:** prompt admit-before-wake ordering; `resume:false`; exact retry match dimensions;
conflicting prompt reuse; Session-ID adoption; lazy synthesis of promoted inbox records for
exact retries of historical projected prompts; same-Session resume joining/coalesced wakes;
different-Session concurrency; runner and one-provider-call-per-turn counts unchanged; Core
test layer with the actual RPC implementation, plus focused typed error mapping. Verify
Core's native tool registry and schemas remain intact, but tool proposals do not fall back to
the current streaming executor before P3's whole-response/Guard gates are available; return
the explicit unavailable state instead.

**Verify:** run focused Core tests and `bun typecheck` from `opencode/packages/core`.

### Task 5 — Make Session SQL and EventV2 strictly rebuildable projections

**Files:** update `opencode/packages/core/src/event.ts`,
`session/projector.ts`, `session/store.ts`, and only necessary projection schemas/migrations;
add projection replay tests.

- [ ] Separate canonical Kernel append from projection commit/notification. Apply the exact
   Kernel event/cursor to local EventV2 and Session tables as a projection; use replay for
   restart catch-up. A failed projection must not change the Kernel receipt or advance the
   projection cursor.
- [ ] Make projection writes idempotent by canonical Thread cursor and event identity. Detect a
   projection ahead of canonical state as corruption; fence/repair instead of promoting it.
- [ ] Keep SQL list/search/presentation reads only when their projection cursor is current or
   after bounded replay to the captured Kernel head. Canonical history and mutation outcomes
   come from ThreadStoreService. A derived row never creates authority.
- [ ] Retain OpenCode compatibility notifications through existing EventV2 subscriber APIs,
   but prohibit production Thread mutations from calling the SQLite-backed durable `publish`
   path. Persist the Thread projection cursor as an exact decimal string; maintain a distinct
   compatibility sequence for existing numeric Session APIs rather than coercing a UInt64
   owner cursor to JavaScript `number`. Do not edit generated public clients unless a separate
   public API change is approved.
- [ ] Run delete-and-rebuild, duplicate replay and crash-after-canonical-commit tests to green;
   run focused Core tests/typecheck, inspect and commit this projection slice.

**Tests:** delete projection and rebuild from Thread stream; duplicate/replayed event is
idempotent; crash between Kernel commit and projection update catches up without double
messages; projection-ahead and wrong-owner/cursor cases fail closed; internal replay uses
Thread owner cursors while existing Session API cursor shape and semantics remain compatible.
Exercise existing prompt/history/projector tests through the new owner.

### Task 6 — Implement idempotent read-only legacy Session import and rollback snapshot

**Files:** add a Core migration/import module under
`opencode/packages/core/src/session/`; update only source snapshot/alias projection code and
related tests; use ArtifactStore references without exposing filesystem paths.

- [ ] Take a stable read-only snapshot of the actual legacy/current Session database input;
   bind source-store identity and digest, and preserve the original bytes. Confirm source
   schema/version using a consistent SQLite snapshot; unknown formats remain untouched and
   refused.
- [ ] Import one unique `(sourceStoreId, legacySessionId) → threadId` alias, ordered messages,
   forks, available attachments and compaction metadata. Do not invent missing parents,
   route/profile pins or attachments. Use immutable ArtifactRefs and exact source record
   digests.
- [ ] Use a resumable idempotent import saga: `thread/legacy_import_started` establishes alias
   and source identity; linked history/owner receipts are validated; only then append
   `thread/legacy_session_imported`. Exact retry returns the same receipts; conflicting
   source digest refuses; no multi-owner atomicity claim.
- [ ] Import in-flight provider calls as `UNKNOWN_ACCEPTANCE` and pending effects as `UNKNOWN`,
   unmediated historical content. Never call `SessionExecution.wake` for imported work or
   replay an effect/provider request as settled. If required historical owner support is not
   available, preserve the source and expose a typed unavailable import result rather than
   discarding/guessing.
- [ ] Keep the source database read-only after cutover and preserve a verified rollback
   snapshot. Never make old and new stores writable simultaneously.
- [ ] Run crash-at-each-saga-step and source-integrity tests to green; run focused Core tests
   and typecheck, inspect and commit this migration slice.

**Tests:** repeated import; source digest conflict; crash/restart after each saga step; alias
uniqueness; per-Thread count/digest verification; missing attachment/parent representation;
fork ordering; UNKNOWN provider/effect behavior; snapshot remains unchanged and available
for rollback.

### Task 7 — Add snapshot/replay/resnapshot and supervised crash/restart acceptance

**Files:** extend Kernel read APIs and Core projector/reconnect tests; add Rust and Core
integration fixtures. Do not add canonical history retention or delivery eviction.

- [ ] Expose authorized Thread snapshot at a captured owner cursor plus sequential replay after
   that cursor. Distinguish a projection cursor from an owner cursor. Keep pagination bounded.
- [ ] Bound subscriber notification buffering; when an unacknowledged range is no longer
   retained, return `RESNAPSHOT_REQUIRED` and require an authorized canonical snapshot. Do
   not evict OwnerLog history or delivery identities.
- [ ] Inject process death around Thread append/head publication, receipt response, projection
   application, and import checkpoints. Reopen and prove exactly the old or new committed
   prefix; reconcile uncertain operations without replay.
- [ ] Run a real child-process host↔Kernel integration using the bounded private protocol on the
   available Linux host. Keep Windows IPC, DACL, `run_durable`, and power-loss acceptance
   separate and unclaimed.
- [ ] Run snapshot/replay/resnapshot and crash/restart acceptance tests, the full Rust/Core
   checks, then inspect and commit the recovery slice.

**Tests:** snapshot+replay equality; bounded pages and stale/cross-owner cursor rejection;
resnapshot after projection notification retention; crash before/after committed head; lost
response exact retry returns original receipt; host exits/restarts and acquires a higher
epoch; no duplicate Thread or provider execution.

### Task 8 — P2 gate, independent review, and integration decision

- [ ] Run all focused Rust/Core/Schema tests and package typechecks; run full Kernel tests, fmt,
   strict Clippy and `git diff --check`. Run no OpenCode package tests from repo root.
- [ ] Review complete branch diff, ownership/permission/error mapping, no SQLite writer,
   generated-output ownership, secrets, source dispositions, and test evidence. Obtain an
   independent whole-branch review before merge.
- [ ] Evaluate each P2 gate in `arch_V1/10-DELIVERY.md` and `arch_V1/18-OPERATIONS-RELEASE.md`
   against exact revision/platform/toolchain/fixtures. A Linux suite does not establish
   Windows-first IPC or `run_durable` acceptance.
- [ ] Merge `p2-foundation` into local `main`, verify the merged tree, and push only if the
   requested P2 gate and all applicable merge evidence pass. Otherwise leave the branch
   unmerged/unpushed and update `CURRENT_RUN.md` with the exact blocker and next steps.

## Verification command set

- Kernel: `HORIZON_OWNER_LOG_TEST_TMPDIR=/tmp/opencode cargo test --offline --manifest-path kernel/Cargo.toml`;
  `cargo fmt --manifest-path kernel/Cargo.toml -- --check`;
  `cargo clippy --offline --manifest-path kernel/Cargo.toml --all-targets -- -D warnings`.
- Core: run focused `bun test` files and `bun typecheck` from `opencode/packages/core`.
- Schema: run focused tests/typecheck from `opencode/packages/schema` only if the browser-safe
  contract changes. Do not move runtime logic into Schema.
- If a public Server `HttpApi` or Protocol changes, regenerate via `bun run generate` in
  `opencode/packages/client`; this plan currently adds only private Kernel RPC and Core
  services, so public generation is not expected.
- Windows MSVC compile is currently blocked by missing `lib.exe` on this Linux host. Native
  Windows acceptance requires an actual supported Windows run and remains a release gate.

## Review checkpoints

- After each task: targeted test first, implementation, focused verification, diff review,
  then a coherent Conventional Commit. Never include unrelated pre-existing modifications.
- Before any production cutover: prove the host has one canonical writer and no fallback if
  Kernel is absent.
- Before calling P2 complete or merging: all P2 acceptance scenarios above and the normative
  delivery/release gates must have fresh evidence. P0 archive/root-base/license gates remain
  separate; do not use P2 tests to imply P0/V1 acceptance.
