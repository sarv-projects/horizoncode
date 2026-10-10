# 25 — Data, event, API, and state-machine crosswalk (OpenCode-first)
This is an additive **design schema**, not a migration already executed against production data. Import from the v2 ZIP is reconciled with the existing kernel and OpenCode substrate rather than blindly replacing either schema.

## 25.1 Authoritative storage
- OpenCode owns conversational Session, Message, Part, provider continuation, assistant stream, compaction history. Preserve existing DB/schema and IDs.
- Kernel owns GoalRevision, Run, DAG, Task, Attempt, WorkerExecution, Effect, Approval, resource/worktree lease, verification Evidence, checkpoint and operational events.
- The two stores communicate via `hc_session_links`, correlation IDs and idempotent outbox; **no cross-database foreign-key assumption**. Missing counterpart is `PENDING_RECONCILIATION`, never guessed success.
- Existing Rust owner log remains independent durable managed-domain journal. SQL projections may be rebuilt; unacknowledged tool effects are reconciled before a new worker can execute them.
- **DEC-V1-18 open:** `hc_session_links` maps managed Run/Attempt IDs to OpenCode Session IDs, but does not define a Rust Thread mapping for direct Sessions or establish which stream owns ToolBatch facts under the OpenCode-first cutover. Keep Session projection read-only and do not create Thread ToolBatch events or wire effect dispatch until the owner mapping and allowed metadata payload are adopted; see `17.4`.

## 25.2 Typed protocol methods and handler logic
| Method / class | Inputs | Algorithm and failure behavior |
|---|---|---|
| `OpenCodeSessionGateway.admitPrompt` | Session ID, stable message ID, digest, pinned model version | OpenCode idempotent admission; if same key and different digest return CONFLICT; never dispatch duplicate |
| `OpenCodeSessionGateway.nextEvents` | session cursor, execution fence | Iterate versioned streamed parts, preserve tool-call IDs/reasoning metadata, replay cursor after disconnect |
| `ManagedRunService.createRun` | approved GoalRevision, model config | Validate accepted criteria, store snapshot + work plan, persist managed log event |
| `GoalService.markProposedDone` | run, attempt, expected revision | Set DONE_PROPOSED only; verify separately before RunSucceeded |
| `Broker.admitToolIntent` | authenticated actor, exact effect digest, expected path hash, fence | Validate scope/idempotency/lease, request permission or dispatch sandbox, persist durable effect receipt |
| `WorkspacePool.acquire` | project, base revision, resources | Find clean idle compatible slot under cap; else provision and verify; lease generation CAS |
| `WorkspacePool.release` | pool ID, lease, subprocess receipts | Terminate/wait children, snapshot changes, verify clean, release ports and test DB, quarantine if dirty |
| `Verifier.evaluateGoal` | goal revision, final integrated commit + environment | Evaluate every mandatory criterion on exact revision with independent provenance; inconclusive blocks success |
| `ProviderHealth.onFailure` | selected endpoint/model, error/latency | EWMA and breaker; safe same-model retry with cap; else visible paused state; never switch provider silently |
| `RecoveryEngine.recover` | last durable cursor, ongoing leases | Fence orphaned workers; reconcile uncertain effects and OpenCode Session; requeue only safe attempts |

## 25.3 Concrete contracts in this repository
- `contracts-v2/managed-work-additive.sql`: 15 additive `hc_` tables, FK/unique constraints, indexes, checked using an **in-memory** SQLite database.
- `contracts-v2/managed-event.schema.json`: versioned, strict event envelope; this initial enum is a *slice*, not a complete version of the 01–18 event registry.
- `contracts-v2/control-api.openapi.json`: 15 control-plane routes, distinct from existing OpenCode Session HTTP routes. Operation skeletons require request schemas/auth middleware when implemented.
- The OpenCode source and full v2 input remain reference-backed; the above files are freshly generated and must undergo production integration tests.

## 25.4 Terminal success predicate
```text
canFinalize(run):
  require all mandatory criterion verdicts == PASS
  require criterion evidence binds final integrated revision + environment
  require no running execution, unresolved branch, uncertain tool effect
  require no high-severity open risk and no pending required user approval
  require snapshot of immutable acceptance report committed in kernel journal
  return True, else explain exact BLOCKED/FAILED/RETRYABLE cause
```
## 25.5 Concurrency and replay invariants
- Every write includes expected state version and execution fencing token; late streams are rejected after new epoch.
- External side effects are at-least-once delivery with **idempotent reconciliation where available**; never advertise exactly-once external execution.
- Schema migrations are additive first, and require a backup and verified rollback path before applying to real state.
- Model settings change is a user action, a new selection revision, and affects new attempts only.
- Resource cleanup cannot reclaim a leased/dirty/quarantined worktree without explicit rescue strategy.

## 2026-10-10 — P1.1 implemented: read-only OpenCode Session event projection

**Status:** IMPLEMENTED AND FOCUSED-TESTED, but NOT connected to the running OpenCode host. No production permission/tool boundary is claimed.

- Rust: `kernel/src/session_projection.rs` (`SessionProjection`, `cursor`, `sync`, `link_attempt`, `correlation`). Reads the actual OpenCode V2 `event` table (`id,aggregate_id,seq,type,data`) and stores **only** immutable correlation metadata (session/message/tool IDs, source-event type and hash, contiguous cursor) in its own database; it never edits upstream Session/Message/Part or calls a model.
- The existing OpenCode `packages/core/src/event.ts` uses `latest = -1` before the first committed event, then `seq = latest + 1`. This underpins the projection's strict 0-based sequence and gap checks.
- `kernel/src/bin/session_sync_probe.rs` exposes a manual read-only source DB diagnostic. Actual host connection, lifecycle watcher, safe transport and scheduler integration **remain unimplemented**.
- `kernel/tests/session_projection.rs`: 9 cases include admitted/promoted correlation, deterministic replay, source drift, gaps, malformed content, multi-session separation, link conflicts, process-reopen recovery, and bounds.
- After adding the module, `cargo test --manifest-path kernel/Cargo.toml --locked --offline --quiet` passed 115 tests (70 + 11 + 25 + 9). Formatting checked with `cargo fmt --manifest-path kernel/Cargo.toml --check`.
- Manual executable fixture: built a synthetic SQLite `event` table matching `packages/core/src/event/sql.ts`; CLI first pass imported three events through cursor 2; second pass imported zero; source SHA-256 unchanged; sensitive prompt text absent from projection receipt fields.

### Next implementation gate P1.2
1. Integrate a mediated OpenCode host Session stream/reader with authenticated Rust supervisor RPC. Reconcile source events after process restart without writing OpenCode conversational state.
2. Test actual OpenCode Session admission (not only a synthetic SQLite table), `PromptAdmitted` → `Prompted`, event payload versions, exact ID preservation, and compaction replay.
3. Integrate Rust ToolBroker authorization and effects; this read-only projection does not enforce permissions or route tool effects.
4. Add source DB WAL/concurrent-write integration tests, projection file permission checks, and careful storage retention/compaction for high-volume sessions.
5. Provide a launch-time bridge health status; do not mark P1 complete until end-to-end tool/sandbox/security and restart checks pass.

## 2026-10-10 — P1.2-A: live read-only OpenCode Session follower (implemented)

**Status:** Live-read follower and integration tests implemented; authenticated supervisor and mediated tool effects still pending. Do not mark the entire P1.2 milestone complete.

### Source code
- `kernel/src/session_projection.rs` now pins an SQLite read transaction across the last-committed boundary verification and the next event batch, preventing cross-snapshot race during OpenCode WAL updates.
- `kernel/src/bin/session_sync_probe.rs` supports live `--follow`, polling `--poll-ms=50..60000`, bounded `--max-polls=N`. Source is opened `SQLITE_OPEN_READ_ONLY` with `query_only=ON`; source/destination path aliases and Unix hardlinks are rejected. Each imported batch has a durable cursor and idempotent metadata receipts.
- `packages/core/test/kernel-projection-live.test.ts` publishes actual `SessionEvent.ContextUpdated` via OpenCode's `EventV2.Service` and `Database.layerFromPath` to an isolated disposable SQLite database. Rust follows committed WAL events, preserves message IDs, and observes subsequent events while the publisher is live. A restart imports 0 duplicates; prompt content remains in OpenCode and is absent from Rust metadata.
- `.gitignore` explicitly allows tracking the integration test; no old OpenCode provider, session-runner or renderer logic was rewritten.

### Local reproducible checks
Run in the WSL repository:
```bash
cargo fmt --manifest-path kernel/Cargo.toml --check
cargo test --manifest-path kernel/Cargo.toml --locked --offline
cargo build --manifest-path kernel/Cargo.toml --locked --offline --bin session_sync_probe
cd packages/core
/home/sarvesh/.bun/bin/bun test ./test/kernel-projection-live.test.ts
/home/sarvesh/.bun/bin/bun run typecheck
```
The `bun` absolute path reflects the current WSL machine; production instructions should use the configured package manager path.

For an explicitly selected **non-production or authorized** OpenCode SQLite database and Session ID:
```bash
cargo run --manifest-path kernel/Cargo.toml --bin session_sync_probe --   /path/to/disposable/opencode.db /path/to/disposable/kernel-projection.db ses_test   --follow --poll-ms=250
```
Use Ctrl+C to stop the diagnostic. An idle live watcher is **not** yet launched/managed automatically by the application supervisor. The follower does not replace the OpenCode Session DB, run models or execute any tools.

### Evidence and limits
- Rust kernel: 70 unit + 11 owner-log golden + 25 owner-log recovery + 9 projection tests = **115 passed**.
- OpenCode/Bun: 2 integration tests passed, 18 assertions. Tests include actual OpenCode EventV2 publisher, WAL visibility, session replay and hardlink/same-file rejection.
- Core package: `bun run typecheck` passed. No model/provider API calls or user-owned database migrations executed.
- Still required: production supervisor startup/shutdown, authenticated Rust IPC stream, event cursor delivery to UI, actual OpenCode prompt admission with `PromptAdmitted` and `Prompted` integration, compaction recovery, persistence root hardening, complete mediated ToolIntent flow and Guard enforcement. The read-only follower does not prove any of these yet.

### Next gate P1.2-B
1. Define a strongly authenticated local supervisor identity and event subscription contract (incremental cursor, backpressure, version negotiation), keeping OpenCode the only conversation owner.
2. Connect the Rust follower to automatic per-session lifecycle with an explicit stop/cancel path; secure state path, process ownership and logs without exposing raw prompt content.
3. Confirm actual prompt-admission/turn-result semantics across both existing OpenCode session generations with a disposable fixture and versioned event-manifest assertions.
4. Before any effectful ToolIntent proxy is released, implement and verify OS-enforced permission coverage for shell, edit, MCP and hosted provider tools. **No partial broker that leaves bypasses as enabled production functionality.**

### P1.2-B incremental evidence — Core provider-turn event parity

The recorded Core runtime integration in `packages/core/test/session-runner-recorded.test.ts`
now projects a full `SessionV2.prompt` → `SessionExecution.resume` event sequence through the
Rust follower. It verifies the ordered admission/promotion and assistant step/text settlement
receipts, message IDs, content redaction and a second projection run with no duplicate receipts.
The fixture uses the repository's recorded HTTP cassette, not a live provider. This proves one
successful provider turn only; compaction and mid-turn interruption recovery remain separate
gates. No Session/Message/Part data is written by Rust.

### P1.2-B incremental evidence — compaction and interruption histories

Focused Core runner tests now project exact persisted EventV2 rows from an automatic
completed-summary compaction and a blocked-provider interruption into the Rust projection.
The compaction projection preserves the two Started/Ended pairs and message correlation
while excluding summary/recent-turn content. The interrupted projection matches the
committed source event sequence and does not synthesize a StepStarted event that was never
committed. These are parity checks for the observed histories; process-restart recovery,
automatic lifecycle ownership and a managed consumer remain unimplemented.
