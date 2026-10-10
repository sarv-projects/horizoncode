# 24 — Actual repository code audit and migration map
**Audit scope:** all 20 original architecture Markdown files were opened and parsed by line. Repository inventory was walked programmatically; critical runtime files were compared byte-for-byte with the pinned local snapshot. A line-by-line *human semantic review of every one of the thousands of OpenCode source files* is not claimed.

## 24.1 Baseline evidence
- Repository: `/home/sarvesh/business_Dev/agentx`, branch `main` at `a22f810daa76f42e99a8e455af9e949bf9a4788e` when audit began, with clean working tree.
- Upstream pinned source commit: `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`.
- Root package tree contains a physical OpenCode-derived source layout; `opencode/` is a separate preserved pinned source snapshot. These are not automatically two active runners.
- `kernel/` contains tested Rust primitives; library documentation explicitly reports missing supervisor/permission integration.
- Root `package.json` is still named `opencode`, uses Bun workspaces and includes `dev:desktop`, `dev:web`; never break package-generation workflow without explicit migration.
- Git `origin` points to user's project. No remote upstream was listed during initial audit. Do not change remotes during architecture work.

## 24.2 Exact source seams
| Current path | Bytes | Parity status | Disposition |
|---|---:|---|---|
| `packages/opencode/src/provider/provider.ts` | 82051 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/session/session.ts` | 35643 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/session/prompt.ts` | 64944 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/session/compaction.ts` | 21236 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/session/processor.ts` | 27266 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/tool/registry.ts` | 17374 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/tool/task.ts` | 14200 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/permission/index.ts` | 7861 bytes | identical to pinned snapshot | see disposition below |
| `packages/opencode/src/worktree/index.ts` | 23180 bytes | identical to pinned snapshot | see disposition below |
| `packages/core/src/session/runner/llm.ts` | 21089 bytes | identical to pinned snapshot | see disposition below |
| `packages/core/src/session/store.ts` | 2559 bytes | identical to pinned snapshot | see disposition below |
| `packages/llm/src/index.ts` | 963 bytes | identical to pinned snapshot | see disposition below |
| `packages/app/src/index.ts` | 1313 bytes | identical to pinned snapshot | see disposition below |
| `packages/desktop/src/main/index.ts` | 13504 bytes | identical to pinned snapshot | see disposition below |
| `kernel/src/lib.rs` | 1122 bytes | changed or not mirrored | see disposition below |
| `kernel/src/owner_log.rs` | 120676 bytes | changed or not mirrored | see disposition below |
| `kernel/src/protocol.rs` | 80970 bytes | changed or not mirrored | see disposition below |
| `kernel/src/messagepack.rs` | 30137 bytes | changed or not mirrored | see disposition below |
| `kernel/src/transport.rs` | 9851 bytes | changed or not mirrored | see disposition below |
| `kernel/src/artifact_store.rs` | 48782 bytes | changed or not mirrored | see disposition below |
| `kernel/src/request_cancellation.rs` | 12305 bytes | changed or not mirrored | see disposition below |
| `kernel/src/windows_peer.rs` | 30029 bytes | changed or not mirrored | see disposition below |

## 24.3 Existing Rust code
| Path | Physical lines | Status |
|---|---:|---|
| `kernel/src/artifact_store.rs` | 1433 | Existing source, not proof of integrated runtime |
| `kernel/src/lib.rs` | 24 | Existing source, not proof of integrated runtime |
| `kernel/src/messagepack.rs` | 932 | Existing source, not proof of integrated runtime |
| `kernel/src/owner_log.rs` | 3416 | Existing source, not proof of integrated runtime |
| `kernel/src/owner_log_index.rs` | 535 | Existing source, not proof of integrated runtime |
| `kernel/src/protocol.rs` | 2113 | Existing source, not proof of integrated runtime |
| `kernel/src/request_cancellation.rs` | 346 | Existing source, not proof of integrated runtime |
| `kernel/src/startup.rs` | 320 | Existing source, not proof of integrated runtime |
| `kernel/src/transport.rs` | 298 | Existing source, not proof of integrated runtime |
| `kernel/src/windows_peer.rs` | 864 | Existing source, not proof of integrated runtime |
These modules include significant owner-log, codec, artifact and Windows code. No new `studio-*` crates are required before extending and measuring the existing kernel.

## 24.4 Surgical integration path map
| Change to implement | Read first | Modify or add | Never duplicate |
|---|---|---|---|
| Provider/model configuration | `packages/opencode/src/provider/provider.ts`, `packages/llm/src` | OpenCode gateway facade and UI settings | Rust HTTP provider stack |
| Session / prompts / tool turns | `packages/opencode/src/session/{session,prompt,processor,compaction}.ts`, `packages/core/src/session/runner/llm.ts` | Adapter preserving history and turn semantics | Rust canonical conversational message store |
| Tools and effect boundary | `packages/opencode/src/tool/{registry,task,shell,edit}.ts` | Rust Guard adapter and typed tool result mapping | Unguarded direct file/shell execution |
| Durable goals | `kernel/src/owner_log.rs`, Codex /goal upstream | `kernel/src/goal.rs`, `run.rs`, `checkpoint.rs` | Copy of Codex full thread store |
| Scheduling / parallel | `packages/opencode/src/worktree/index.ts`, `kernel/src/protocol.rs` | `kernel/src/scheduler.rs`, `workspace_pool.rs` | Second concurrent root Git workspace manager |
| Execution and runtime isolation | `kernel/src/{transport,windows_peer,request_cancellation}.rs` | `kernel/src/execution.rs`, sandbox adapters | Trusting YOLO as unrestricted host permissions |
| Evidence / healing | `kernel/src/owner_log.rs` and existing tool outputs | `kernel/src/evidence.rs`, `recovery.rs`, `provider_health.rs` | Treating agent text as verified facts |
| UI shell | `packages/app/src`, `packages/desktop/src`, TUI | New UI packages at existing frontend locations | New independent Tauri rewrite at this stage |
| Local models | OpenCode models/provider bridge | Selectable harness adapter, bounded minimal loop | Automatically routing to any paid provider |
| MCP/hooks/skills | `packages/opencode/src/{mcp,plugin,skill}` | mediated tool broker and capability registry | Parallel unmanaged integrations registry |
| Browser/preview | existing app and tool hooks | isolated browser/preview worker with source anchors | Raw unrestricted host browser automation |
| Release/operations | current server/service packages | reviewable release adapters + backup planning | Automatic production deployment |
## 24.5 Phase-0 cutover probes (no production mutation)
1. Enumerate OpenCode session table schema and V1/V2 shadow behavior; document exactly how messages and tool parts persist.
2. Establish one read-only bridge from OpenCode Session cursor to Rust correlation projection; replay and compare after restart.
3. Proxy one permission-gated file tool call through Rust using expected content hash and fencing token.
4. Test user cancel, process crash, idempotent replay, stale tool reply, plugin tool attempt to bypass broker.
5. Only after parity approval, update canonical Thread status in chapters 02/11/12/15/17 and versioned contracts, preserving original Rust fixture provenance.
## 24.6 Cleanup register
- `opencode/` and root `packages/` are retained; do not remove duplicate-looking trees until dependency graph and build reproducibility are established.
- `kernel/target` and caches are generated, not architecture source. No cleanup was executed during this documentation audit.
- Original `arch_V1/01`–`18` remain authoritative within their bounded topics, amended by v2. V2 input copy under docs is provenance, not a second normative architecture.
- No reset, rebase, branch switch, Git clean, package reinstall or code deletion is authorized by the documentation update.

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

### P1.2-B implementation increment — 2026-10-10

- `packages/core/test/kernel-projection-live.test.ts` now calls the actual OpenCode
  `SessionV2.prompt({ resume: false })`, then `SessionInput.promoteSteers`, using file-backed
  `Database.layerFromPath` and `SessionProjector`. It observes actual versioned
  `session.next.prompt.admitted.1` then `session.next.prompted.1` in order, preserves the
  OpenCode message ID, confirms prompt content is absent from Rust receipts, and restarts
  the Rust projection without duplicate imports. This exercises the durable input/event
  path without invoking a provider or creating another Session store. It does not yet
  exercise HTTP `SessionV2.prompt`, a complete model turn, compaction, or turn interruption.
- `kernel/src/unix_peer.rs` adds Linux owner-only Unix-socket path/mode validation and
  `SO_PEERCRED` UID/PID plus exact executable-path checks before returning a stream.
  `kernel/tests/unix_peer.rs` covers successful same-process authentication, wrong image,
  public directory, broadened socket mode, and symlinked parent rejection. This is not yet
  connected to process supervision. `kernel/src/rpc_handshake.rs` performs first-message
  protocol/feature/nonce/incarnation negotiation on the authenticated stream; integration
  tests reject the wrong nonce, an unsupported required feature, and a non-hello first
  message. `kernel/src/subscription.rs` adds a 1–256 event in-flight window with strict
  owner/sequence validation, backpressure, exact ACK release and drift detection. These
  `kernel/src/supervisor_session.rs` binds authenticated negotiation to `StartupGate`,
  emits startup statuses and rejects application reads/writes until READY. It deliberately
  trusts the supervisor to report canonical-state validation, recovery and service
  readiness; those operations are not implemented here. `kernel/src/supervisor_lease.rs`
  now provides a Linux private-directory process lock and durable monotonic epoch; the
  session borrows the acquired lease for its lifetime. The Linux
  `session_supervisor` executable now validates the read-only source and fully synchronizes
  one configured Session before READY, then serves one bounded page and exits after its
  ACK. It refuses corrupt or incompatible sources before exposing a socket, rejects a
  projection hardlink to OpenCode, and checks the Subscribe owner against its configured
  Session. It does not continuously follow events or remain alive across page requests.
  `SessionProjection.subscription_cursor/page`
  reads bounded redacted receipt metadata and validates exact cursors before feeding the
  window. `AuthenticatedKernelSession.send_subscription_page` now writes one such page over
  the authenticated READY connection and waits for subscription-matching ACKs, with an
  integration test against the actual protocol codec and a disposable OpenCode-shaped
  EventV2 source. The negative test proves cross-subscription ACK rejection. This is not a
  live poller: source resync, typed `RESNAPSHOT_REQUIRED` wire response, reconnect cursor
  persistence and supervisor lifecycle remain open. OpenCode's zero-based sequence maps
  to a before-first cursor zero and one-based wire event cursors. Native Windows IPC remains
  a separate, unverified runtime gate.
- Exact verification is recorded in `CURRENT_RUN.md`; do not call P1.2-B complete until
  authenticated host-to-kernel hello, readiness, repeated live event subscription/ACK,
  shutdown/restart and cancellation have end-to-end evidence.

### P1.2-B incremental update — negotiated repeated subscription pages

`kernel/src/protocol.rs` now defines `page_end` and `resnapshot_required` controls behind
the negotiated `session.events.page-control.v1` feature. `AuthenticatedKernelSession`
retains the negotiated feature set, emits a page boundary only after contiguous ACKs, and
rejects page controls when the feature was not negotiated. The Linux `session_supervisor`
now accepts repeated cursor-bearing Subscribe controls for one stable subscription, refreshes
the read-only EventV2 projection before each page, and holds the process lease until matching
Unsubscribe/channel loss. Missing retained cursors return requested/latest same-owner cursors
in `resnapshot_required` and close without sending a partial page. Process tests prove two
polls on one process, ACK/page-boundary cursors, refresh of a newly committed source event,
restart from the acknowledged cursor, and the typed resnapshot path after controlled
projection retention loss. This remains client-driven polling; Core does not yet own child
lifecycle, cancellation/interruption parity or reconnect cursor persistence.

### P1.2-B incremental update — Core host client and scoped child

`packages/core/src/session/supervisor.ts` now exposes `SessionSupervisor.Service.open` and
an Effect-scoped client registered in OpenCode's `AppLayer`. It starts the Rust executable
through the existing Core `AppProcess`/`ChildProcessSpawner` using an argument array, checks
the private socket owner/mode, sends a bounded MessagePack Hello with a fresh nonce and host
incarnation, verifies both required feature bits and exact binding, and does not return until
READY. The client supports one stable subscription ID, exact-cursor subscribe, typed event / page
end / resnapshot receive, contiguous ACK validation, and Unsubscribe. Scope release closes
the connection and waits for child exit with bounded termination escalation. Each launch
uses a nonce-derived socket name under the private state root, avoiding stale-path collisions
after a crash. It logs no payload and discards child stdio.

`packages/core/test/kernel-projection-live.test.ts` now launches the actual Rust binary from
Bun against actual `SessionV2.prompt` + `SessionInput.promoteSteers` EventV2 rows. It verifies
real `PromptAdmitted` / `Prompted` event delivery, content redaction, rejection of a forged
out-of-order ACK, and graceful unsubscribe. A separate Effect interruption case proves the
socket/lease are released and the same state directory starts a new epoch and replays safely.
This is real host-to-kernel transport, but caller-owned only: SessionV2 request paths do not
yet automatically attach it, and native Windows transport remains unimplemented. Core
atomically checkpoints the last `page_end` cursor as owner/sequence/digest metadata under the
private per-session state root. The checkpoint is written only after the server confirms the
contiguous ACK page; interruption during a page replays that bounded page. Tests prove restart
resume, cursor rollback rejection, symlink refusal and malformed-checkpoint rejection. Full P1.2-B still needs provider-turn,
compaction/interruption parity, automatic lifecycle ownership and native Windows acceptance.

The `SessionSupervisor.node` is now also registered in the active HTTP API root graph at
`packages/opencode/src/server/routes/instance/httpapi/server.ts`; the focused HTTP CORS route
suite boots with that composition. This only makes the caller-scoped client available to the
server graph. It does not attach a child to the actual Session prompt lifecycle or invent an
event consumer. Explicit binary/state configuration, managed-control-plane consumption and
per-Session shutdown/recovery are the next runtime integration seam.

### P1.3 source-path inventory — effects still bypass the managed owner

Source trace on 2026-10-10 identifies the adopted V2 path and the compatibility path:

| Entry path | Dispatch and persistence | Current authority boundary | Broker status |
|---|---|---|---|
| Core V2 provider turn | `packages/core/src/session/runner/llm.ts` (`runTurnAttempt`) collects non-hosted `tool-call` events; `ToolRegistry.Materialization.validate/settle` resolves the request-pinned registration; `Tool.make` (`packages/core/src/tool/tool.ts`) invokes the registered `execute` callback; `packages/core/src/tool/tool-output-store.ts` bounds captured output. | Some V2 leaves use Core `PermissionV2`, `LocationMutation`, `FileMutation` and `AppProcess`. These are host-local checks and implementations; no Rust Guard receipt, EffectIntent, one-use capability lease, Rust ExecutionHost or Rust ThreadService ToolBatch acknowledgement is connected. | Whole-response/schema staging is tested, but not an authorization boundary. The V2 built-in composition is a limited subset; its own `builtins.ts` marks task/LSP/repo/code-mode and dynamic MCP/plugin composition as follow-up work. |
| OpenCode V2 public Session API | `packages/server/src/handlers/session.ts` (`session.prompt`) calls `SessionV2.Service`; `packages/server/src/routes.ts` composes `SessionV2.node` with `SessionExecutionLocal.node`. The OpenCode HTTP root composes this server API group and `SessionSupervisor.node`. | This is the adopted canonical Session API, but its Core local permissions are not Rust Guard, and the supervisor remains a caller-scoped client with no production Session/control-plane event consumer. | Whole-response local staging is present. Automatic supervisor ownership, Rust ThreadService ToolBatch, Guard, EffectService and ExecutionHost are not. |
| OpenCode compatibility Instance Session API | `packages/opencode/src/server/routes/instance/httpapi/handlers/session.ts` (`sessionHandlers`) calls `SessionPrompt.Service`; `packages/opencode/src/session/prompt.ts` (`runLoop`) calls `SessionTools.resolve`; `packages/opencode/src/session/tools.ts` adapts `ToolRegistry.tools` callbacks and MCP callbacks to AI SDK tools; `packages/opencode/src/session/llm.ts` prepares/runs the selected AI SDK/native runtime; `packages/opencode/src/session/processor.ts` projects tool-call/result events into Session parts. | Legacy `Permission.ask` and tool-specific checks are local to the host. Built-in shell/write/edit/patch/task, dynamically loaded custom/plugin tools, and MCP tools execute before any Rust Guard path. AI SDK callbacks dispatch during the provider turn; the Core V2 whole-response barrier does not wrap this compatibility path. | Not mediated by the Rust broker. This compatibility API is composed alongside the V2 server API and remains a separate production bypass. |
| Explicit user shell command | The compatibility Instance API handler calls `SessionPrompt.shell`; `packages/opencode/src/session/prompt.ts` (`shellImpl`) records a Session tool part and spawns through `ChildProcessSpawner`; it does not traverse model-tool callbacks. | User initiation and existing session context; no Rust `user_action` admission, Guard decision, PREPARED record, or Rust ExecutionHost receipt is observed. | Separate compatibility bypass that must be mapped into the same effect pipeline before governed route convergence. |
| Provider-executed tool | Core runner explicitly skips local settlement when `event.providerExecuted`; compatibility Session preserves provider-native tool results in the provider conversation. | Execution inside the provider cannot be intercepted after the tool-call event. | Governed v1 must omit it unless the provider offers a verifiable pre-execution authorization handshake; a later local receipt cannot make it mediated. |

This inventory is a source map, not a completeness/security claim. In particular, it does not
assert that all extension or third-party code has been enumerated. Both the V2 server API and
the compatibility Instance API are composed in the OpenCode HTTP root. Attaching a Rust event
observer or securing only the Core V2 runner therefore does not close the compatibility route
or direct shell route. Route convergence remains closed until each effect-capable path is
mediated or explicitly unavailable, and P1.2 observer startup remains caller-owned until a
real Session/control-plane consumer is attached.

The next implementation unit must be the Rust managed owner seam for an authenticated,
Session-linked whole ToolBatch: derive principal/scope from the validated host context, admit
all calls against pinned definitions and aggregate bounds, and keep ThreadService as the sole
transition/result owner. Then connect its per-call observations to the existing OpenCode
Session correlation without copying messages. A logger-only RPC or a Core-only dispatch shim
does not satisfy this gate.

### P1.2-B incremental update — recorded provider-turn projection

`packages/core/test/session-runner-recorded.test.ts` now exercises an actual recorded
`SessionV2.prompt` + `SessionExecution.resume` turn through the OpenCode Core runner, then
copies the exact six persisted EventV2 rows into a disposable EventV2-shaped SQLite source
and runs the Rust projector twice. It verifies ordered `PromptAdmitted`, `Prompted`, step
start, text start/end and step settlement event versions, exact message correlation, no
prompt/answer content in Rust receipts and idempotent replay. The recorded HTTP cassette
prevents a live provider call. This extends parity evidence to one complete provider turn;
compaction, interrupt/restart during a turn, automatic lifecycle ownership, a managed consumer
and native Windows remain open.

### P1.2-B incremental update — compaction and interruption event parity

`packages/core/test/session-runner.test.ts` now takes the exact EventV2 rows produced by
Core's automatic completed-summary compaction and by cancellation of a blocked provider
stream, places each unchanged row set in a disposable EventV2-shaped SQLite source, and
runs the Rust projection. The compaction case verifies both durable Started/Ended pairs,
their message IDs, and that summary/recent-turn text is absent from projection receipts.
The interruption case compares the complete projected kind sequence to the committed
source event sequence and verifies prompt text redaction. In this fixture, cancellation
lands before `step.started`; the projection correctly does not invent that event. These
tests prove event projection parity for those observed histories, not recovery of an
interrupted provider request or a process restart during compaction.

Focused evidence on 2026-10-10: the completed-summary compaction test passed (1 test / 22
assertions), the blocked-provider interruption test passed (1 test / 8 assertions), and
the Core package typecheck passed. Automatic Session lifecycle ownership, a managed event
consumer, native Windows transport and interruption/restart recovery remain open.

### P1.3 prerequisite increment — Core whole-response local-tool barrier

`packages/core/src/session/runner/llm.ts` no longer dispatches a local tool at the
streaming `tool-call` event. It collects local calls until both the provider `finish` and
`step-finish`, preflights every call against the same materialized registry, and dispatches
none if the stream failed/interrupted/incompletely terminated or any input is invalid.
`ToolRegistry.Materialization.validate` is bound to the registration identities and
definitions captured at request materialization; `Tool.validate` uses the registered input
schema. Provider-failure/incomplete paths explicitly fail persisted calls rather than
leaving them running. A valid batch still dispatches its local calls concurrently and
awaits settlement before the next request.

On 2026-10-10, Core runner tests passed **91/91 (296 assertions)**, the Core typecheck
passed, and the recorded provider fixture passed **1/1 (15 assertions)**. This is a
pre-route staging boundary, not the universal broker: local effects still execute in Bun,
the runner does not create a Rust ThreadService-owned ToolBatch or enforce Guard/resource/
budget rules, results are not yet acknowledged through the Rust coordinator in original
call order, and legacy/MCP/plugin/hosted effect paths are not mediated end-to-end.
