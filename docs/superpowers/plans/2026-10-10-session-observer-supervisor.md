# Session Observer Supervisor Implementation Plan

> **For agentic workers:** Use inline execution in this session. Follow RED → GREEN for each behavior and preserve the existing dirty worktree.

**Goal:** Run the verified Linux authentication, lease, projection and bounded-page pieces in one read-only Session observer process.

**Architecture:** Rust owns the observer process, local authenticated listener, supervisor lease and metadata projection. OpenCode remains the sole canonical Session database and provider runtime. The observer reports readiness only after validating the source SQLite database and opening/replaying the projection; Core lifecycle ownership is a later task.

**Tech Stack:** Existing Rust kernel, rusqlite, MessagePack RPC, Linux Unix sockets, the existing OpenCode EventV2 table contract.

**Spec:** `arch_V1/13-COMPOSITION-IPC.md` startup, local authentication and subscription sections; `arch_V1/17-GOVERNANCE-DECISIONS.md`; `arch_V1/20-OPENCODE-INTEGRATION-LLD.md`; `arch_V1/24-LOCAL-CODE-AUDIT-AND-MIGRATION.md`; `arch_V1/27-IMPLEMENTATION-READINESS-AUDIT.md`.

## Global Constraints

- OpenCode retains canonical Session/provider state; Rust source access stays read-only and projection metadata excludes prompt bodies.
- Authenticate the exact local peer before hello; bind version negotiation to nonce and process incarnation; do not admit application RPC before READY.
- Hold a private monotonic supervisor lease while serving; never claim startup recovery before it is completed.
- Bound frames, polling, page size and event in-flight state; fail closed on source drift, unsafe paths and incompatible peers.
- Keep this Linux-only increment separate from native Windows acceptance and from the universal ToolIntent broker.

## Review Focus

- A stale or malformed EventV2 database must prevent READY and remain unchanged.
- A private projection path must not alias the canonical OpenCode file by path or hard link.
- A wrong UID/executable, nonce, or protocol feature must not receive application RPC.
- A client must not bypass Subscribe validation or move its ACK cursor across subscriptions.
- Shutdown or process loss must release the lease and ensure a restart advances the epoch.

## Files and Interfaces

- Modify `kernel/src/session_projection.rs` only if source preflight needs a narrow reusable validator; preserve projection schema and cursor semantics.
- Create `kernel/src/bin/session_supervisor.rs`: parse explicit source/state/socket/host-identity/nonce arguments, validate the source read-only, acquire `SupervisorLease`, initialize projection and serve one authenticated host connection.
- Reuse `UnixPeerListener`, `AuthenticatedKernelSession`, `SessionProjection` and `BoundedSubscription`; do not add provider or conversation persistence code.
- Test in `kernel/tests/session_supervisor_process.rs` using the actual compiled binary and disposable SQLite files.
- Update `arch_V1/13`, `24`, `27`, `HANDOFF.md` and `CURRENT_RUN.md` with runtime evidence and gaps.

### Task 1: Source preflight and command boundary

- [x] Write failing tests for malformed/missing EventV2 schema, read-only source validation, same-file/hardlink rejection, invalid arguments and no source mutation.
- [x] Run those tests and observe failures against the absent executable.
- [x] Implement bounded argument parsing and source preflight in the binary, reusing the actual `event` column contract and safe SQLite open flags.
- [x] Run focused process tests and prove source bytes are unchanged.

### Task 2: Authenticated listener and bounded Subscribe/ACK dispatch

- [x] Extend process tests for OS peer auth, hello/version/nonce binding, startup status ordering, exact Subscribe ownership, redacted event delivery, backpressure/ACK and negative ACKs.
- [x] Observe the missing process behavior, then implement lease-bound startup and one-page dispatch with existing kernel types.
- [x] Test restart epoch advancement, corrupt source fail-before-READY, disconnect cleanup and stale socket refusal.

### Task 3: Verify, document, and checkpoint

- [x] Run Rust fmt, all kernel tests, strict Clippy and binary build; rerun the actual OpenCode Core integration and typecheck.
- [x] Review the source diff for authority leaks, unbounded loops, raw prompt serialization and lifecycle gaps.
- [x] Update architecture, handoff, and run evidence; identify persistent subscription/Core child ownership as the next task.

