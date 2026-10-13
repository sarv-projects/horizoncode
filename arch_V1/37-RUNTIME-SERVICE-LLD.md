# 37. Runtime service LLD

Status: normative service interfaces. A service marked proposed is not implemented until source and tests prove it.

## 37.1 Common contract

Every service operation defines:
- canonical capability/action ID;
- caller identity and scope;
- input schema/version;
- owner/resource generation;
- effect class;
- cancellation/deadline;
- size/count bounds;
- stable error codes;
- provenance/source;
- result generation/revision;
- support/unavailable reason.

Unknown versions/capabilities/effect classes deny.

## 37.2 Capability registry

33 is the canonical human-readable capability catalog.
contracts-v2/capability-registry-v1.json is the machine design/alias seed.

Sealed builtin IDs cannot be shadowed. Alias resolution happens before policy. UI, CLI, model tool schemas and SDK project from the same IDs.

## 37.3 BrowserBackendV1

Target capabilities:
browser.open/navigate/back/reload/snapshot/screenshot/console/network_errors/wait/assert
and dom.query/get/click/type/select/source_candidates.

Core interface:
- listContexts/listTabs
- observe(tab, requested views) -> observationGeneration
- act(tab, generation, BrowserActionV1) -> effect receipt/post-observation
- close/recover owned context.

Rules:
- distinguish managed versus attached user profile;
- stale generation denies mutation;
- CDP/network visibility is not a sandbox;
- upload/download/authenticated mutation uses Guard;
- worker crash invalidates references.

## 37.4 DesktopActionServiceV1

Canonical family: desktop.*

Capabilities:
desktop.displays
desktop.windows
desktop.snapshot
desktop.ax.query
desktop.pointer.move
desktop.click
desktop.scroll
desktop.key
desktop.type
desktop.focus
desktop.clipboard.read
desktop.clipboard.write

Read-only/mutation classification is explicit; screenshots/AX reads are scoped observations, focus/input/clipboard mutation is effectful.

Interface:
- capabilities(osBackend)
- listDisplays/listWindows
- capture(target) -> DesktopObservationV1 with generation/geometry
- queryAx(observationGeneration, query)
- act(DesktopActionV1) -> receipt + next observation ref.

Required guards:
- exact OS/backend support;
- target window/display/process scope;
- stale capture denial;
- DPI/coordinate transform;
- emergency cancellation;
- no unrestricted Eval.

## 37.5 WebSearchBrokerV1

Canonical family: web.search.*

Minimal capabilities:
web.search
web.search.providers
web.search.inspect_provider

Provider route classes:
DIRECT_SEARCH and GROUNDED_MODEL_SEARCH.

Interface:
- listProviders() -> capabilities/auth/cost/status/freshness
- search(WebSearchRequestV1) -> bounded results with URL/title/snippet/source/provider/retrievedAt
- cancel(requestId)

Rules:
- provider/model search are different adapters;
- auth comes from existing provider/SecretBroker owner;
- cost class FREE/PAID/TRIAL/UNKNOWN is explicit;
- fallback cannot silently change cost/auth class;
- source adapter existence does not imply enabled/working service;
- privacy/domain/network policy enforced.

## 37.6 LanguageServiceBrokerV1

Canonical query capabilities include language.status/sources/diagnostics plus existing definitions.find/references.find/symbols.*.

Identity key:
workspace + language + root + config digest + executable/version + owner type.

Interface:
- discover/attach/start/restart/stop supervised service;
- diagnostics/definitions/references/outline;
- prepareCodeAction/rename returns versioned edits;
- apply mutation only through files.patch/Guard.

Editor-owned service is never restarted by a model query. Result reports source/generation/document version.

## 37.7 DebugAdapterBrokerV1

Canonical family: debug.*

Capabilities:
debug.start
debug.attach
debug.stop
debug.breakpoints
debug.breakpoint.set
debug.breakpoint.remove
debug.continue
debug.pause
debug.step.over
debug.step.into
debug.step.out
debug.stack
debug.scopes
debug.variables
debug.evaluate

Interface:
- create(adapter/workspace/launch config) -> session generation
- command(DebugSessionActionV1)
- snapshot(thread/frame/scopes)
- terminate.

Security:
- launch/attach/process control and breakpoint mutation are effects;
- evaluate is an effect and may be disabled by profile;
- variable/stack reads are scoped;
- no adapter command may execute outside declared workspace/process capability;
- session loss invalidates frame/variable refs.

## 37.8 ReplBrokerV1

Canonical family: repl.*

Capabilities:
repl.start
repl.execute
repl.reset
repl.status
repl.output_range
repl.stop

Initial languages: python and javascript when installed/supported.

Interface:
- start(language/runtime, scope, resource limits, callback capability set)
- execute(sessionGeneration, code/input, deadline) -> structured value/stdout/stderr/artifact refs
- reset/stop.

Rules:
- process supervised by ExecutionHost;
- bounded memory/CPU/wall-time/output;
- filesystem/network explicit;
- callback to agent tools goes through canonical ActionDescriptor and Guard;
- no raw kernel/secret access;
- idle TTL and crash quarantine.

## 37.9 DelegationMailboxV1

Parent creates one child dispatch with:
- objective/criteria;
- context refs;
- capability/path/network subset;
- workspace lease;
- budget;
- profile/harness/model route.

Messages/results are bounded and typed. Child cannot mutate canonical Run/Task state directly. Parent/kernel owns cancellation and acceptance.

## 37.10 AutomationServiceV2

Durable Rust-owned definition/occurrence state.

Interface:
- list/inspect/create/update/enable/disable/runNow/history;
- deterministic overlap, missed-run, retry and timezone policy;
- each occurrence invokes the target canonical action through normal authorization.

Scheduler availability is shown accurately when no executor is running.

## 37.11 UiEventMuxV2

Derived presentation only.

Properties:
- bounded queues per surface/session;
- coalesce replaceable paint/status events;
- never drop durable canonical event/receipt references;
- source sequence/revision;
- reconnect from durable source, not UI queue;
- subscriber backpressure policy.

No UI event mutates canonical state.

## 37.12 ArtifactRenderServiceV2

Inputs: immutable source/ref plus render kind/theme/geometry generation.

Renderers:
- Markdown/code/diff;
- bounded Mermaid to text/graphics;
- safe SVG raster;
- deterministic numeric table chart;
- image/PDF metadata/preview where supported.

Security:
- untrusted parser in bounded/crash-isolated worker;
- no SVG script/network/filesystem;
- stale async result discarded by source/theme/geometry generation;
- accessible source/text fallback.

Terminal graphics:
- detect protocol support;
- per-surface image budget/leases;
- transmit/place/evict lifecycle;
- no assumption Kitty/SIXEL/Tern is available.

Durable export is a separate Guarded artifact action.
## 37.13 TerminalExecutionServiceV1

One host-scoped Rust kernel is the sole process/effect owner, multiplexed across
Locations and Sessions. Core `Pty.Service` is only the V1 `/pty`, V2 `/api/pty`,
WebSocket and replay adapter; tickets/origins authenticate transport only and never
authorize Guard effects. No per-Location/per-PTY kernel or parallel process manager.
The host derives principal from validated `ServerAuth`, or requires loopback listener
and peer and derives OS UID/SID itself; missing proof denies. Both V1 and V2 create
adapters preserve public `Pty.CreateInput` `command`, `args`, `cwd`, `env` semantics
(omitted command/args/cwd mean configured shell, empty args and Location directory,
including login-shell behavior) and unchanged public `Pty.Info`; Core projects the
kernel result, retains `title` metadata and never directly spawns, writes, resizes or
kills.
For terminal WebSocket attach, ticket requests and reconnect, Origin must be present
and match exactly `oc://renderer`, `tauri://localhost`, `http://tauri.localhost`,
`https://tauri.localhost`, an exact configured origin, or exact configured listener
origin. Prefer one-use tickets bound to principal, terminal, Location and exact
Origin. V2 obtains a ticket. Preserve ticketless V1 only with validated required
`ServerAuth` Basic/`auth_token` credentials; with auth not required, ticketless attach
is allowed only under the loopback-only listener/peer plus host-derived OS-principal
rule. No ticketless path bypasses principal proof. Check terminal existence before
query/ticket/origin validation (authorized unknown ID stays the established empty
404); validate the requested subprotocol before WebSocket upgrade. Redact tickets
and `auth_token` from logs.


All operations use the common §37.1 envelope: protocol/schema version, authenticated
caller and scope, owner/resource generation, effect class, deadline/cancellation,
input/output byte and item bounds, stable errors, provenance, result generation and
support/unavailable reason. Unknown capability/version, malformed frame, missing
principal proof, stale generation/fence, or exceeded bound fails closed. The service
does not echo/log raw environment values or terminal input. Provenance records
authenticated principal source, ingress/origin and surface, Location/workspace,
terminal/artifact ID and generation, effect/grant/receipt IDs, backend/guarantees,
owner epoch/fence and operation outcome; never records tickets, auth tokens, raw
environment or raw input.
The process owner is a separate host singleton in the existing kernel crate, launched
as `hz-kernel --state-dir=<state-dir> --socket=<socket> --host-exe=<host-exe> --nonce=<nonce> --incarnation=<incarnation>`.
Its authenticated HelloResult returns a durable, monotonically increasing positive
`ownerEpoch`; `session_supervisor` receives that epoch and remains projection/ACK-only.
There is no host-wide single `workspace-root`.

Before effect admission, register a trusted Location internally with
`effects.v2/register_location {canonicalRoot,workspaceID?}`. The root must originate
from a trusted `Location.Ref`, never a request or model; Rust canonicalizes it. It
returns `locationID = "loc_" + lowercase BLAKE3 hex(UTF-8("horizon.location.v1\0" +
canonicalRoot + "\0" + (workspaceID ?? "")))` and rejects rebind. TypeScript does
not duplicate path canonicalization.
Model `bash` and other model effect batches use `effects.v2.prepare_tool_batch`: ALLOW returns
`{status:"prepared",effectID,capabilityLeaseDigest}`, ASK returns a Guard challenge
and no digest. Only explicit matching `allow_once` allows
`effects.v2.resolve_approval` to return
`{status:"approved",effectID,capabilityLeaseDigest}`; denial, expiry, mismatch or
missing approval yields no digest. The kernel-issued opaque digest binds challenge,
input, Location, principal and owner epoch, and is consumed once by `terminal.run`
or `terminal.start`.

User-originated `terminal.start` and `terminal.run` use only
`effects.v2/prepare_user_effect {locationID,sessionID?,userActionID,capabilityID,arguments}`.
The server generates `userActionID`; Core injects the typed principal only from
validated ServerAuth middleware (username only) or a host-OS marker; Rust
independently derives UID/SID and binds any ServerAuth subject. Do not fabricate a
Session when none exists. This remains distinct from a model batch.

Approval is projected as `GuardApproval` EventV2. The protected
`POST /api/guard/approval/:approvalID/reply` accepts only
`{decision:"allow_once"|"deny"}`; the server generates `approvalID`. There is no
`always`, auto-accept or `ctx.ask` approval route. The UI shows exact normalized
action, resolved resources, policy and expiry, never raw environment secrets.
The protected reply adapter calls
`replyGuardApproval({approvalID,decision})`; Core resolves the challenge/Location
from the server-generated ID and the trusted principal context. Missing or
wrong-principal IDs share 404; expired/replayed/stale requests return 409 and invalid
decisions return 400. ServerAuth context contains only the validated username;
without ServerAuth the host OS identity is kernel-derived.


| Operation | Input → result | Class and bound |
|---|---|---|
| `terminal.run` | `{effectID, capabilityLeaseDigest, locationID, sessionID?, shellProfileID, command, cwd, timeoutMs, resolvedEnvironment}` → `{status: exited\|timed_out\|cancelled\|unknown, exitCode?, preview, artifactRef, receiptRef}` | `guarded_effect` → runtime `effect`; one-shot PREPARED/lease/ExecutionHost/settlement; command ≤64 KiB UTF-8, cwd ≤4 KiB, timeout 120 s default / ≤600 s (over-limit is `TIMEOUT_LIMIT`, never clamped); max 100 MiB stored per log, then drain and report truncation; 50 KiB/2,000-line preview; 1 GiB host artifact quota; 7-day retention. Environment resolved by host, not model. |
| `terminal.start` | `{effectID, capabilityLeaseDigest, locationID, sessionID?, terminalID, shellProfileID?, command?, args?, cwd?, cols?, rows?, env?}` → `{terminalID, generation, grantID, leaseRef, expiresAt, backend, cols, rows, byteCursor, pid}` | `guarded_effect` → runtime `effect`; durable PREPARED + one-use launch lease becomes InteractiveTerminalGrantV1, explicit approval, at most 60 min. command ≤64 KiB UTF-8, args ≤256 entries/≤256 KiB total UTF-8, cwd ≤4 KiB, env ≤128 entries/≤64 KiB total key/value UTF-8, cols 1–500, rows 1–300. Bind exact normalized launch/config and approved environment; never inherit ambient `process.env`. |
| `terminal.input` | `{terminalID, generation, grantID, attachmentID, sequence, bytes}` → ack `{terminalID, generation, attachmentID, acknowledgedSequence, state}` | `guarded_effect` → runtime `effect`; continuation under current grant/Guard; bytes ≤16 KiB. |
| `terminal.resize` | `{terminalID, generation, grantID, attachmentID, sequence, cols, rows}` → ack `{terminalID, generation, attachmentID, acknowledgedSequence, state}` | `guarded_effect` → runtime `effect`; same checked continuation lane; cols 1–500, rows 1–300. |
| `terminal.cancel` | `{effectID, terminalID, generation, reason}` → `{terminalID, generation, state, receiptRef}` | registry `guarded_effect` → owner-only runtime `control`; fences before scoped signal/terminate; no new launch or authority. |
| `terminal.status` | `{terminalID, generation, afterSequence?, afterByteCursor?, maxBytes?}` → bounded state plus optional replay | `read_only` → runtime `read_only`; read status/replay only, not a new replay capability; replay/output ≤64 KiB. |
| `terminal.search` | `{artifactID, generation, query\|regex, maxResults, maxBytesPerExcerpt}` → matches `{lineStart, lineEndExclusive, byteStart, byteEnd, excerpt}` | `read_only` → runtime `read_only`; opaque managed artifact only; UTF-8 pattern ≤4 KiB, `maxResults` 1–100, each excerpt ≤4 KiB; stable zero-based line refs. |
| `terminal.output_range` | `{artifactID, generation, lineStart, lineEndExclusive, maxBytes}` → bounded lines/bytes and digest | `read_only` → runtime `read_only`; opaque managed artifact only; zero-based half-open ranges; `maxBytes` and response ≤64 KiB. |
On any listed wire-bound overflow or invalid dimension, return a typed rejection;
never clamp or silently truncate the request. These request-validation rules do not
change the separate managed-log storage cap and drain/truncation behavior above.


Every search/range request checks artifact ownership and exact generation; rotated,
truncated or replaced output returns `STALE_GENERATION`. No caller path or full-log
result. Search refs and output-range refs are the same artifactID/generation and
zero-based line/range model as §30.17 and §33.23. `query|regex` is explicit literal
versus regex mode. Input/resize sequence is monotonic per attachment and generation:
only next sequence dispatches, duplicates re-ack without redispatch, gaps/stale
sequence reject; attachment ID is server-generated after one-use ticket consumption
or validated V1 credential auth. Uncertain input is never replayed after owner loss.
Terminal EventV2 cursors use `ownerKind:"terminal"` and `ownerId:terminalID`.
Sequence `"0"` is the base sentinel
`blake3:0000000000000000000000000000000000000000000000000000000000000000`; each
event increments decimal sequence. `eventDigest` is `blake3:` plus lowercase BLAKE3
hex of canonical MessagePack map
`{terminalID,generation,sequence,byteCursor,kind,payload}` with sorted map keys.
Exclude `subscriptionId` so replay to another subscriber retains the same digest;
cursor sequence equals event payload sequence.


PTY replay is separate from managed logs: 2 MiB ring per terminal; output frame ≤64
KiB, input frame ≤16 KiB, WebSocket outbox ≤2 MiB; close slow clients and report a
gap/reconnect state rather than silently dropping output. Byte cursors are canonical;
legacy UTF-16 cursors translate only at adapter boundaries. Preserve existing V1
`/pty/{ptyID}/connect` and V2 `/api/pty/{ptyID}/connect` ticket/origin rules and
no-subprotocol legacy framing. New binary protocol requires exactly one
`horizon.terminal.v1`; validate before upgrade, reject unknown/multiple values with
HTTP 400. Binary envelope is `HPTY`, version 1, kind, sequence u64 BE, byte cursor
u64 BE, payload length u32 BE, exact payload; output `0x01`, state `0x02`, gap
`0x03`, exit `0x04`, error `0x05`; client input `0x10`, resize `0x11`.

Stable errors: `DENIED`, `APPROVAL_REQUIRED`, `GRANT_EXPIRED`, `STALE_GENERATION`,
`STALE_SEQUENCE`, `BAD_FRAME`, `TOO_LARGE`, `TIMEOUT_LIMIT`, `UNAVAILABLE`,
`OUTPUT_LIMIT`, `OWNER_LOST`, `UNKNOWN`. `DENIED` is current Guard/policy denial;
`APPROVAL_REQUIRED` means a matching challenge/approval is absent; `GRANT_EXPIRED`
means interactive grant expired or was revoked; `STALE_GENERATION` means terminal or
artifact generation mismatch; `STALE_SEQUENCE` means stream sequence is out-of-window
or has a gap (the last acknowledged duplicate is re-acked); `BAD_FRAME` means invalid
protocol/type/length/checksum; `TOO_LARGE` means a declared byte/count bound was
exceeded; `TIMEOUT_LIMIT` means requested run timeout exceeds policy; `UNAVAILABLE`
means backend/operation unsupported or unavailable; `OUTPUT_LIMIT` means artifact
storage limit/truncation; `OWNER_LOST` means host owner epoch changed; `UNKNOWN` means
dispatch/termination outcome cannot be established. Kernel loss fences the host epoch
and requests process-tree termination; report terminated only when observed, otherwise
`UNKNOWN`/`session-lost`, and require explicit recreation. Never retry a run with
unknown dispatch. Windows V1 requires native ConPTY, named-pipe process-bound
authentication and Job Object process-tree cleanup; WSL or cross-compilation is not
acceptance.


## 37.14 CacheObservationAdapterV1

Reports cache/local-model observations with measured/estimated/unknown provenance. Never fabricate provider cache hit or token savings.

## 37.15 Contract adoption gate

Before any service becomes WIRED:
1. find existing source seam;
2. finalize one machine schema;
3. generate/validate TypeScript + Rust where cross-process;
4. positive/malformed/version fixtures;
5. Guard/effect classification;
6. restart/cancel/UNKNOWN tests;
7. real OS/provider/backend integration where applicable;
8. performance/resource measurements;
9. 32 task/UAT case;
10. update HANDOFF status.

Research/source extraction in 42 does not skip these gates.
