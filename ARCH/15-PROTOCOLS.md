# 15 — Protocols

Module LLD for the three edge components `CMP-acp`, `CMP-mcp`, and `CMP-headless`, plus the language edge-SDK seam. Protocols are seams onto the one control plane; they never contain loop logic (`REQ-PROTO-005`, `DEC-003`).

**Implementation status at 2026-09-28 source snapshot (`23d4ce8`):** the Rust ACP
crate remains server-only. Its source handles `initialize`, `session/new`,
`session/close`, `session/prompt`, and
`session/cancel`; it does not currently implement session `load/list/resume/fork`,
`set-mode`, `set-model`, `set-config-option`, client-side ACP transport, MCP, or an edge
SDK, durable-goal preparation/approval, or ACP elicitation handling. The method tables
below specify target behavior, not shipped support. Only methods actually implemented
and tested may be advertised or invoked. The Rust SDK crate's semver and upstream
changelog version are not the ACP wire protocol version. The upstream changelog is at
1.9.1 as of this document date; it marks v2 changes unstable. Negotiate the actual
wire version and capabilities at runtime, pin a released v1 schema in fixtures, and
feature-gate drafts ([official changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md)).

## Purpose

Let external editors and peer agents drive HorizonCode, let HorizonCode drive peer agents and consume external tools, and let CI run HorizonCode non-interactively — all against the same control interface used by the TUI. Every surface is a thin projection; the durable session, guard, and audit remain single-owner.

## Responsibilities

**`CMP-acp` — own.**
- ACP **server** over stdio using the negotiated wire version: implemented lifecycle methods only, streamed session updates, permission requests to the client via canonical `session/request_permission` (`DEC-023`, `REQ-PROTO-002`), and optional client-side fs/terminal calls only when advertised and available.
- ACP **client** mode: HorizonCode dials a peer ACP agent as a subordinate and maps its updates onto the control plane. This is the transport behind `CMP-orch`'s ACP isolation mode (`DEC-019`).
- Capability negotiation: advertise only implemented methods. ACP v1 permission requests are baseline; a method error, disconnect, malformed reply, or timeout is reject-by-default, never auto-allow.

**`CMP-mcp` — own.**
- MCP host (client): connect stdio and streamable-HTTP servers, discover tools/resources/prompts with bounded pagination, mirror them into the tool registry, and dedupe per session.
- Transport lifecycle: spawn/supervise stdio processes, HTTP sessions, per-server timeout resolution, reconnect with backoff, and change-notification handling with debounce.
- OAuth where a server requires it: authorize/callback/refresh, with credentials routed to `CMP-secrets` and never inlined.

**`CMP-headless` — own.**
- Argument surface and one-shot execution: `-p/--prompt`, workspace selection, model/mode selection, output format, resume/fork by session id, and a stable exit-code contract.

**Edge SDK seam — own.**
- A TypeScript client that talks to the binary over stdio and wraps ACP/headless. It is an *edge*; it must never host loop, provider, tool, or policy logic (`DEC-002`).

**Not owned.** Loop, scheduling, and turn state (`CMP-runner`); durable Thread store (`CMP-session`, historic component name); tool execution and permission filtering (`CMP-tools`); allow/ask/deny decisions (`CMP-guard`); subagent lifecycle (`CMP-orch`); provider transports (`CMP-provider`).

## Interfaces

| Component | Depends on | Exposes to |
|---|---|---|
| `CMP-acp` | `CMP-runner` (one control interface), `CMP-session`, `CMP-guard` (permission ask), `CMP-orch` (ACP client spawn) | editors/peer agents over stdio; `CMP-orch` |
| `CMP-mcp` | `CMP-tools` (registry mirroring), `CMP-guard` (egress), `CMP-secrets` (OAuth tokens), `CMP-session` (dedupe scope) | `CMP-tools`, `CMP-context` (resource/prompt sources) |
| `CMP-headless` | `CMP-runner`, `CMP-session` | shells, CI |
| Edge SDK | `CMP-acp`, `CMP-headless` over stdio | external TS embedders |

**Control-interface rule.** All surfaces translate to the same versioned operations in
`CMP-control-api` (`ARCH/31`): create/resume session, submit prompt, steer, cancel,
observe streamed events, resolve permission, and invoke run-control operations. The
typed dispatcher routes to canonical domain owners. A local app-server is only one
transport for this interface; ACP and MCP remain protocol adapters and cannot create
alternate state/permission semantics. No surface may reach a provider or persistence
handle directly.

## Data / state model

**ACP session binding.** ACP `sessionId` is an external protocol identifier bound to exactly one HorizonCode `ThreadId`; it is not a `CMP-session`/Thread ID and never mints a second local conversation identity. `session/new` creates one HorizonCode Thread and stores the ACP ID as an external binding. Optional lifecycle methods are advertised only with the exact capability required by the pinned protocol schema. In v1, `session/load` replays the bound Thread history; `session/resume` reattaches without replay only when the pinned protocol semantics permit it; `session/list` projects bounded Thread summaries with external ACP IDs; `session/delete` is destructive and gated by `sessionCapabilities.delete` and explicit Thread-deletion policy; and `session/close` closes the ACP binding and applies the protocol's cancellation/resource-release behavior without deleting Thread history. `session/fork` remains unstable in v1. UI detach and long-lived Run attachment are HorizonCode control-plane operations and MUST NOT be mapped to ACP `session/close`, because close can cancel active work.

**ACP update classes** (one typed vocabulary, no opaque chunk channel): message chunks, thought summaries (never raw chain-of-thought), plan, tool call, tool-call update, usage update, available-commands, config-option update, and the prompt/step boundary markers.

**ACP target method matrix.** Each method maps to one control-interface operation and has a defined session effect. This is not a capability declaration; implementations must maintain an explicit supported-method table and reject unsupported calls without changing session state. The current v1 method set and capability rules are defined by the official [ACP v1 overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx) and [session setup](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/session-setup.mdx); pin a released schema in build/evaluation fixtures rather than relying on mutable `main` at runtime.

| ACP method | Control operation | Session effect |
|---|---|---|
| `initialize` | negotiate capabilities | none |
| `session/new` | create Thread + bind ACP ID | mint one local `ThreadId`; ACP ID is an external binding |
| `session/load` (optional) | replay + bind | history projection from the bound Thread; only when `loadSession` was advertised |
| `session/resume` (optional) | reattach binding | continue the bound Thread without replay only when advertised |
| `session/list` (optional) | list bindings/Threads | bounded, paginated Thread summaries with external ACP IDs |
| `session/delete` (optional) | delete via explicit policy | destructive and audited; never infer ACP ID is local Thread ID |
| `session/close` (optional) | close protocol binding | apply negotiated cancellation/release behavior; preserve Thread history |
| `session/prompt` | submit Thread turn | append events to bound Thread; stream updates |
| `session/cancel` notification | cancel turn (cooperative) | in-flight work settles as `interrupted` |
| `session/set_mode` / `session/set_config_option` (optional) | adjust advertised mode/config | validate offered values and record accepted change; no v1 `session/set_model` method |
| `session/request_permission` (agent → client baseline request) | guard ask → client | wait for exact reply; otherwise typed denial on error/deadline |
| `fs/read_text_file`, `fs/write_text_file` (client → agent, optional) | governed client file access | require advertised client capabilities and guard checks |
| `terminal/create`, `terminal/output`, `terminal/wait_for_exit`, `terminal/kill`, `terminal/release` (client → agent, optional) | governed client terminal access | require advertised client capability and resource limits |
| `session/fork` (unstable in v1), task graph, UI detach, checkpoints/rewind | HorizonCode control API | do not advertise as stable ACP; unstable fork is opt-in and negotiated separately |

**Session listing result and error mapping.** The versioned internal control API
owns the rich `SessionListResult` (`ARCH/07`), including per-entry integrity
states and store-level issues. ACP `session/list` may expose only fields allowed
by the exact pinned ACP schema. It must not add `enumeration_complete` or
`SessionListIssue` as unnegotiated root fields. Map incomplete enumeration using
the pinned standard error/result contract or a negotiated extension; otherwise
return the standards-compliant subset and preserve the detailed issue in the local
control API. `session/list` is advertised only when the exact mapping is tested.

The local listing contract (separate from the ACP wire shape):

- every entry is returned, including `UNREADABLE`/`CORRUPT`/`UNSUPPORTED`/`RECOVERY_PENDING`
  rows, each with its typed integrity state; a session is never dropped to make a
  response tidy;
- `enumeration_complete = false` is reported as a response-level incomplete result
  carrying the store-level `SessionListIssue` list, and never as an empty `sessions`
  array; a client that receives `incomplete` MUST NOT present the list as "no sessions";
- a listing never loads, repairs, or truncates a log. Recovery is a separate control-API
  action, so a read-only client can inspect a broken session without changing it;
- paging is applied over the ordered entry list; issues are not paged away, because an
  issue that only appears on a later page is indistinguishable from a hidden failure.

A local inspection surface (headless CLI, TUI session picker) uses the same
`SessionListResult`: a store-level failure is a non-zero exit or an explicit
"list may be incomplete" row, and an unreadable session stays visible with its typed
state. Neither surface may substitute "no sessions" for a failed scan.

`session/request_permission` is an **agent-to-client request** when HorizonCode is serving ACP; it is a baseline client method in ACP v1, not an optional capability. In client mode, HorizonCode receives the peer's request. A method-not-found response, disconnect, malformed outcome, or timeout is a typed reject/deny; it is not evidence of a missing negotiated permission capability. Keep directions distinct in type names and logs.

**Child permission bridge.** A child may have an internal HorizonCode `ThreadId` unknown to the ACP client. Persist a mapping `{run_id, root_acp_session_id, child_attempt_id, child_thread_id, request_id, requester_identity, tool_call_id, action_digest, resource_digest, deadline, state}` before forwarding. Send the permission request with the root external ACP session ID as required by the client-facing binding, while retaining the child Thread/requester correlation internally. Accept a reply only once, reauthorize against the parent ceiling and current guard policy, and deliver it to the original child request. Missing mapping, disconnect, invalid reply, or deadline becomes typed denial/cancellation and a terminal child receipt; no unresolved waiter is permitted (`REQ-HORIZON-012`, `DEC-035`).

**Permission exchange.** The method token is exactly `session/request_permission`; it is frozen by `DEC-023` and no alias is accepted. The server emits a request with a tool-call descriptor and the options allowed by the pinned ACP schema and local policy; the protocol option IDs/semantics MUST be schema-derived, not invented as fixed `allow-once/allow-always/reject-once` strings. An allow-always response can be offered only if the pinned schema and guard policy can represent the exact remembered pattern; `CMP-guard` shows it before confirmation (`REQ-GUARD-003`). Requests are serialized per session with a bounded queue and deadline; overlapping requests cannot block cancellation or control messages (`DEC-035`).

**Client fs/terminal calls.** The server may request file read/write and terminal create/output on the client. Writes go through the governed write path (lease → re-read+hash → compare → atomic rename → else conflict). Each call carries the session cwd and is bounded.

**MCP server record.** Transport (stdio command+args+env, or HTTP url+headers+auth), per-server timeout (single resolver — one bound shared by `tools/*`, `resources/*`, `prompts/*`; malformed config yields the shared default, never a thrown error), status (`connected · disabled · failed · needs-auth · needs-client-registration`), and discovered capability lists.

**MCP dedupe & pagination.** Discovery paginates with a visited-cursor set and a hard page cap (duplicate cursor or cap overrun is a typed error, not an infinite loop). Tools are deduped per session by `(server, tool-name)` with a stable content hash; a changed hash triggers a mirror refresh. A burst of list-changed notifications is coalesced into one debounced refresh with a bounded deferral cap and bounded backoff on refresh failure.

**MCP transport matrix.**

| Transport | Lifecycle | Notes |
|---|---|---|
| stdio | spawn/supervise child; env filtered | command + arg allowlist; no ambient secrets in env |
| streamable HTTP | session-scoped; reconnect handler | headers carry auth refs, never values |
| OAuth | authorize → callback → refresh | tokens stored via `CMP-secrets`; `needs-auth` on failure |

A modern stateless revision is preferred where the server supports it (context carried per request); a legacy handshake is the fallback. Detection is cached per server/origin, with a force-legacy escape hatch. A server that supports neither is marked incompatible with a reason.

**Headless output.** Default human-readable stream plus a machine `json`/`ndjson` mode emitting one typed event object per line. Exit codes are a small fixed contract (success, agent-failed, declined/denied, interrupted, configuration error, internal error); the exact numeric mapping is fixed in implementation and documented in `--help`.

**Headless flags (v1).**

| Flag | Effect |
|---|---|
| `-p, --prompt <text>` | one-shot prompt; non-interactive |
| `--stdin` | read the prompt from stdin (composable with `-p`) |
| `--format default\|json\|ndjson` | human stream vs machine events |
| `--session <id>` | resume an existing session |
| `--continue` | resume the most recent session |
| `--fork` | fork before continuing at the last checkpoint |
| `--model <provider/model>` | explicit route selection |
| `--mode <name>` | turn mode |
| `--dir <path>` | workspace root |
| `--acp` | start the ACP server instead of a one-shot run |

Signals (`SIGINT`/`SIGTERM`) map to cooperative cancel; the run always emits its terminal event before exiting.

**Edge SDK.** A generated/hand-written TS client over stdio; its only job is framing, typed method wrappers, and streaming event iteration. No dependency on provider SDKs or the catalog dataset.

## Lifecycle & flows

1. **ACP server boot.** Open the stdio NDJSON stream, answer `initialize` with only implemented capabilities, then serve supported requests. `prompt` starts a turn through the control interface and streams updates until exactly one terminal state. `cancel` is cooperative and stops streaming promptly (`REQ-LOOP-005`). A disconnect does not imply detached-run persistence unless the supervised controller and attach API are active (`REQ-HORIZON-011`).
2. **ACP Session lifecycle.** External ACP `session/new` binds one identifier to a local durable Thread; optional `load`/`resume` have distinct replay semantics; `list` is paginated; `delete` follows explicit local Thread-deletion policy; `close` closes the protocol binding and may cancel active work while preserving Thread history. UI detach, task graph, checkpoint, rewind and (unless explicitly enabled as unstable) fork use HorizonCode's control API.
3. **Permission flow.** A guard `ask` becomes one baseline `session/request_permission` request; the schema-valid response returns to `CMP-guard`; the loop resumes or declines. A peer method error, malformed response, disconnect, or timeout fails closed.
4. **ACP client flow.** `CMP-orch` requests an ACP child; `CMP-acp` negotiates version/capabilities, opens only a supported session lifecycle, submits the bounded task, and maps peer updates into durable child events. Core tickets never cross the boundary; the child returns a receipt. Permission requests map to the root session and return to the originating child through the bridge above. If a peer lacks permission or cancel capability required by the task, refuse delegation or apply an explicit narrower policy; do not infer support.
5. **MCP connect.** On session start, connect configured servers, discover capabilities (paginated), and mirror tools. On tool-list change, debounce and refresh. On disconnect, reconnect with backoff; a failed server is isolated and does not block the session.
6. **MCP OAuth.** An unauthorized connect triggers the authorize flow; tokens are stored via `CMP-secrets`; the transport is retained to finish auth; failures surface as `needs-auth`.
7. **Headless run.** Parse flags → resolve/create session → submit one prompt (or resume/fork) → stream events (or NDJSON) → exit with the contract code. Interruption via signal terminates in the `interrupted` state and still emits the terminal event.

### Goal approval and ACP elicitation

ACP has no standard goal/task-graph lifecycle method. HorizonCode exposes its existing
typed goal controls through its session/controller, not by inventing ACP task methods.
`session/prompt` input is submitted to a deterministic ingress router first. On a new
goal, `/goal set` semantics only persist the original request; a separate user action
invokes bounded `GoalPreparation` (read-only repository discovery plus planner
inference), and a separate exact approval is required before coding dispatch. The
current server must not imply these target paths exist.

Before activation, the ACP **agent server** persists a `GoalApprovalChallenge` before
sending the full canonical review bundle to its connected client. The challenge is
bound to the authenticated control session/connection, exact bundle digest, and
expiry; a disconnect before a durable response invalidates the challenge, and a
changed review always requires a new challenge. If
`initialize.clientCapabilities.elicitation.form` was explicitly
advertised, HorizonCode may send the agent-to-client `elicitation/create` request with
`mode: form`, the current `sessionId`, the challenge ID, expiry, and review-bundle
digest in the message,
and a restricted-schema `activate` enum (`yes`, `no`). Validate both the ACP response
action and submitted value. Only `accept` plus exact `yes` can mint a
`GoalApprovalReceipt`, and only when that receiving client is configured as a trusted
interactive connector with authenticated operator scope. Bind the receipt to the
receiving client connection, session, authentication context, request ID, and all
review digests. If identity/authentication is absent, elicitation may collect ordinary
clarification but cannot approve goal activation. ACP elicitation is optional:
`session/request_permission` answers remain scoped to a specific governed effect and
cannot approve a goal. The capability and response semantics are protocol-versioned;
as of this review, ACP v1.9.1 is the latest changelog release and elicitation's schema
was stabilized in v1.7.0 (2026-08-20). Pin the exact protocol schema in fixtures and
use the [official ACP v1 overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx),
[elicitation RFD](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/rfds/elicitation.mdx),
and [official changelog](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/CHANGELOG.md),
not guessed methods. ACP connection/session binding prevents replay but is not user
authentication or proof of a human interaction. When HorizonCode is an ACP client
delegating work, peer-originated elicitation is untrusted input, never operator
approval.

If form elicitation is absent, the trusted connector renders a one-use canonical
`HC-GOAL-START <response-delivery-id> <challenge-id> <review-bundle-digest> {ACCEPT|DECLINE|CANCEL}`
string to its authenticated operator. The next `session/prompt` can produce a
`GoalConfirmation` only if it consists of exactly one text block matching that grammar
and the current pending challenge; intercept it, map it to `GoalConfirmation`, and
persist it in the control lane before model dispatch. Only the exact `ACCEPT` response
can activate. Any other input while the start review is pending
invalidates that challenge and becomes a draft clarification requiring a new explicit
prepare/review cycle. A denial, cancel, disconnect, timeout, malformed response,
identity/connection change before the response is durably accepted, reused delivery
ID, or stale digest leaves the goal inactive. After acceptance, the same durable start
intent may finish across client disconnect only while its receipt is unexpired and
policy/digests remain current; a new connection cannot confirm or replay it. Otherwise
recovery rejects the intent and requires a new challenge. Typed control receipts are
the generic-client fallback and do not add a custom ACP method. See `ARCH/25` for
challenge idempotency/expiry and `ARCH/27` for the common TUI/CLI/ACP approval UX and
grammar.

## Failure modes

| Failure | Behavior |
|---|---|
| Malformed JSON-RPC / unknown method | Typed protocol error to the peer; session state unchanged |
| Peer returns method-not-found or cannot service permission request | Resolve to typed reject/deny; never auto-allow |
| Client fs/terminal unavailable | Degrade gracefully; the tool reports the missing client capability |
| cancel race with turn completion | Cancel is idempotent; the turn still emits exactly one terminal state |
| Duplicate/looping MCP cursor | Typed error; discovery aborts rather than looping |
| MCP transport dies | Reconnect with bounded backoff; server marked failed; session unaffected |
| MCP tool schema drift | Mirror diff updates the registry; calls to removed tools fail typed |
| MCP OAuth token expiry | Refresh once where supported; else `needs-auth` |
| stdio peer exits mid-turn | ACP child settled as failed with a receipt; parent re-plans |
| Headless stdout backpressure | Buffer bounded; on overflow surface a typed error rather than drop events |
| Second surface claims a session | Rejected by ownership; one control interface per session |
| Child permission request cannot map to an interactive parent | Typed denial/cancel by deadline; preserve child receipt; never leave an unresolved waiter |
| ACP peer emits more updates than the client drains | Bounded buffer; explicit cursor gap/resnapshot or recoverable disconnect; never silent drop or unbounded queue (`REQ-HORIZON-013`) |
| One RPC lane has a hung read/config request | Deadline releases that lane; cancellation/control and unrelated lanes remain responsive (`DEC-035`) |

## Configuration

- `acp.enabled`, `acp.profile`, `acp.permission_default` (reject unless negotiated).
- `mcp.servers[]`: `{id, transport, command/args/env | url/headers, auth, timeout_seconds, enabled}`; `mcp.default_timeout_seconds`; `mcp.force_legacy`.
- `headless.default_format`, `headless.exit_codes`, `headless.max_output_bytes`.
- `sdk.endpoint` (stdio) for the edge client.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-PROTO-001` | Target ACP stdio server with standard v1 baseline and capability-gated optional methods, exact advertised support, streamed updates, and an unstable gate for fork; UI detach and long-horizon task operations remain in HorizonCode's control API |
| `REQ-PROTO-002` | The canonical agent-to-client `session/request_permission` method carries the permission request to the ACP client; allow/deny is honored by `CMP-guard` and no alias is accepted (`DEC-023`). |
| `REQ-PROTO-003` | MCP host over stdio and streamable HTTP with per-server-connection tool dedupe; MCP protocol sessions are not HorizonCode Thread IDs |
| `REQ-PROTO-004` | ACP client mode drives peer agents as subordinates (behind `CMP-orch`) |
| `REQ-PROTO-005` | All surfaces talk through one control interface; no loop logic in a surface |
| `REQ-GUARD-003` | Allow-always persists the exact pattern, shown before confirmation |
| `REQ-LOOP-004` | Each prompt maps to exactly one terminal turn state, surfaced to the peer |
| `REQ-LOOP-005` | Cooperative cancel stops streaming promptly; partial work stays inspectable |
| `REQ-SEC-002` | MCP/peer responses are untrusted data, never instructions |
| `REQ-PROV-004` | OAuth tokens and secrets stay in `CMP-secrets`; never logged |
| `REQ-PERF-001` | ACP server reaches a ready handshake within the warm-cache startup bound |

## Open questions

1. **ACP client concurrency — open, release-gated.** Owner: `CMP-acp` / `CMP-control-api`. `ACC-P1-05` already forbids silent dual ownership; before multi-client service is enabled, decide whether there is one controller lease with read-only observers or multiple explicitly serialized controllers. Acceptance must prove ownership, answer-origin binding, disconnect behavior, and control-lane responsiveness. Until decided, permit only one controlling connection per Thread and reject competing mutation/control claims.
2. **MCP protocol revision — resolved in this LLD.** Owner: `CMP-mcp`. Prefer the modern stateless revision when supported; use legacy only as a compatibility fallback or explicit `force_legacy`. Test both handshakes, detection caching, reconnect, and incompatible-server reporting before advertising support.
3. **Headless exit-code table — open, release-gated.** Owner: `CMP-headless`. Numeric values and whether guarded-deny shares a code must match the actual implementation and `--help`; do not invent values in this target document. `ACC-P1-08` is the acceptance gate and must capture the implemented table.
4. **ACP client authentication — open, release-gated.** Owner: `CMP-acp` with `CMP-secrets` and `CMP-guard`. Before remote peer connections ship, decide and document peer identity/authentication, credential origin, rotation, and authorization scope. Until then, remote connections without an authenticated, authorized peer identity are unavailable; local stdio trust does not imply remote trust. Acceptance must cover wrong identity, missing/expired credentials, and refusal before session creation.
5. **Edge SDK generation and drift — open, release-gated.** Owner: Edge SDK with `CMP-acp`. Decide generated versus hand-maintained bindings against a pinned released schema. Whichever path is chosen must have a reproducible build/schema-diff check and prove the SDK cannot introduce protocol or control-plane behavior absent from the Rust service.
6. **MCP resource/prompt injection budget — open, release-gated.** Owner: `CMP-mcp` for acquisition bounds and `CMP-context` for admission/rendering. Specify per-resource bytes, page/count limits, aggregate token budget, provenance/framing, and behavior on overflow. Until those bounds are configured and tested, do not automatically inject discovered resources/prompts; explicit selection still remains subject to size limits. Acceptance must prove over-limit inputs are omitted atomically with a visible non-authorizing marker and cannot truncate into trusted-looking instructions.
