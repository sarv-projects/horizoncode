# 25 — Data, event, API, and state-machine crosswalk (OpenCode-first)
This is an additive **design schema**, not a migration already executed against production data. Import from the v2 ZIP is reconciled with the existing kernel and OpenCode substrate rather than blindly replacing either schema.

## 25.1 Authoritative storage
- OpenCode owns conversational Session, Message, Part, provider continuation, assistant stream, compaction history. Preserve existing DB/schema and IDs.
- Kernel owns GoalRevision, Run, DAG, Task, Attempt, WorkerExecution, Effect, Approval, resource/worktree lease, verification Evidence, checkpoint and operational events.
- The two stores communicate via `hc_session_links`, correlation IDs and idempotent outbox; **no cross-database foreign-key assumption**. Missing counterpart is `PENDING_RECONCILIATION`, never guessed success.
- Existing Rust owner log remains independent durable managed-domain journal. SQL projections may be rebuilt; unacknowledged tool effects are reconciled before a new worker can execute them.
- **DEC-V1-18 runtime gate OPEN:** The V1 owner mapping is settled: no Rust canonical Thread, OpenCode stores tool call/result Message/Part, and Rust ToolBatchControl stores bounded authorization/effect correlation for direct or managed Sessions. Exact payload and authenticated effect dispatch still require acceptance under P1.3; Session projection remains read-only until then.

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


## 25.6 2026-10-11 control/read-model expansion

The OpenCode-first ownership rule is final for V1:

| Data family | Canonical owner | Horizon persistence |
|---|---|---|
| conversation Session/Input/Message/Part/provider continuation | OpenCode | OpenCode store; Rust may keep IDs/cursors/digests/redacted correlation only |
| Goal/Spec/Run/Task/Attempt/delegation | Rust control plane | OwnerLog + rebuildable projections |
| ToolBatch **admission/control** | Rust control plane | references OpenCode tool-call/message IDs; no copied transcript authority |
| Effect/approval/capability lease/reconciliation | Rust | durable |
| Evidence/verification/acceptance | Rust | durable |
| ContextLedger | derived ContextService projection | rebuildable from canonical refs + selected view state |
| RepoIntel symbol/reference index | RepoIntel derived projection | rebuildable; source files/Git are canonical |
| UI stream/scroll/layout | UI projection/preferences | durable only where explicitly configured; high-frequency deltas ephemeral |
| inference/tool/resource metrics | Analytics observations | append/batched retention with measured/estimated/unknown provenance |
| Automation definition/run | AutomationService / control plane | durable schedule + invocation receipts |
| artifacts | ArtifactService | immutable bytes + metadata/digest |

### Additional API families

Public/internal API additions are versioned around existing owners rather than adding another
application engine:

```text
/context/status
/context/entries
/context/trim/preview
/context/trim
/context/prune/preview
/context/prune
/context/compact/preview
/context/compact
/context/clear

/repo/symbols/search
/repo/symbols/:id
/repo/references
/repo/impact
/repo/diagnostics

/agents
/agents/:id
/agents/:id/capabilities
/agents/spawn
/agents/executions

/artifacts
/artifacts/:id
/analytics/summary
/analytics/query
/automations
/automations/:id
/automations/:id/runs
```

These are route families, not permission shortcuts. Mutating operations still bind expected
revision/idempotency/auth scopes and Guard decisions. Generated public clients must be
regenerated from the actual API schema.

### Event ownership additions

Durable semantic events include:
- profile revision created/enabled/disabled;
- child delegation admitted/started/stopped;
- context cleanup committed (with source range/digest, not duplicated body);
- index generation started/current/stale/failed;
- artifact created/retained/deleted;
- automation scheduled/triggered/completed;
- analytics retention/config changes.

Per-token streaming deltas, FPS samples and transient spinner/progress ticks are **not**
durable domain events merely because the UI displays them.

## 25.7 Second-pass data contracts

| Data family | Canonical / derived owner | Persistence rule |
|---|---|---|
| PlanHandoffV1 | Plan/Goal control owner + ArtifactService | immutable/versioned structured artifact; Markdown/HTML is derived rendering |
| ContextEpochMarker | ContextService view-state projection referencing OpenCode history | durable enough to reproduce model-visible epoch boundaries; never deletes conversation |
| named reviewed memory block | MemoryService | provenance-bearing MemoryRecords grouped by stable section name |
| LanguageServiceSnapshotV1 | LanguageServiceBroker/RepoIntel observation | derived/rebuildable health/config/source generation, never editor-process authority |
| terminal/log artifact index | Artifact/terminal subsystem | rebuildable text index over bounded immutable/append-only generation |
| RuntimeObservationV1 | AnalyticsService | retention-governed measured/estimated/unknown observation; not domain authority |

### Additional route/action families

```text
/plan-handoffs
/plan-handoffs/:id
/plan-handoffs/:id/revise
/plan-handoffs/:id/render

/language-services
/language-services/status
/language-services/:id/start
/language-services/:id/stop
/language-services/:id/restart

/terminals/:id/search
/artifacts/:id/search

/context/epochs
/context/memory-blocks
```

Starting/stopping a **Horizon-supervised** language server is effectful and policy-gated.
Editor-owned services expose status/use/attach semantics only where the adapter can do so safely;
the model never receives a generic "restart editor server" power.

### Machine-readable design schemas

The following draft JSON Schemas live under `contracts-v2/` and must remain synchronized with
their normative Markdown owners:

- `agent-profile-v2.schema.json` ↔ §29;
- `harness-profile-v1.schema.json` ↔ §§29/20;
- `plan-handoff-v1.schema.json` ↔ §§29/03;
- `context-ledger-v2.schema.json` ↔ §30;
- `runtime-observation-v1.schema.json` ↔ §31.

They are design schemas, not proof of runtime validators or database migrations. Generated/runtime
types should be derived or compatibility-tested against them rather than allowed to drift.

### Event additions

Durable/semantic events or equivalent owner facts include:
- `PlanHandoffCreated` / `PlanHandoffRevised` / `PlanDeviationRecorded`;
- `ContextEpochStarted`;
- `ReviewedMemoryBlockRevised`;
- `LanguageServiceObserved` / `LanguageServiceGenerationChanged` for Horizon-owned observations;
- `TerminalArtifactRotated` when a prior range generation becomes stale;
- `ManagedRetryExhausted` before Task/Goal block/fail transition where policy requires.

High-frequency LSP diagnostics, token deltas and render timing samples remain projection/analytics
observations unless a separate domain fact depends on them.

## 25.8 OMP addition to canonical event/contract crosswalk (research-to-implementation)

No new source changes to authority: Core Message/Part remains canonical for provider deltas and conversational tool results; UI artifacts and role provider state are projections; Rust Effect/Run receipt remains canonical for effects. Candidate DTOs in [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md): visual FigureBlock revision/renderer epoch, full/sample artifact receipt, model/provider account role projection, slash ActionPresentation alias and staged GoalDraft. They must be generated and validated before runtime; machine prototypes in §37 and §40 are proposals only. No new paid provider path can bypass cost policy. Repo sources in [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md).
