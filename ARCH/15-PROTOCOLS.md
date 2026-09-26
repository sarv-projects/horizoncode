# 15 — Protocols

Module LLD for the three edge components `CMP-acp`, `CMP-mcp`, and `CMP-headless`, plus the language edge-SDK seam. Protocols are seams onto the one control plane; they never contain loop logic (`REQ-PROTO-005`, `DEC-003`).

## Purpose

Let external editors and peer agents drive agentX, let agentX drive peer agents and consume external tools, and let CI run agentX non-interactively — all against the same control interface used by the TUI. Every surface is a thin projection; the durable session, guard, and audit remain single-owner.

## Responsibilities

**`CMP-acp` — own.**
- ACP **server** over stdio using newline-delimited JSON-RPC: `initialize`/capabilities, session `new`/`load`/`resume`/`list`/`close`/`fork`, `prompt`, `cancel`, `set-mode`, `set-model`, `set-config-option`, streamed session updates, permission requests to the client via the canonical `session/request_permission` method (`DEC-023`, `REQ-PROTO-002`), and client-side fs/terminal calls.
- ACP **client** mode: agentX dials a peer ACP agent as a subordinate and maps its updates onto the control plane. This is the transport behind `CMP-orch`'s ACP isolation mode.
- Capability negotiation: advertise only implemented methods; a client that does not support permission prompts is treated as reject-by-default, never auto-allow.

**`CMP-mcp` — own.**
- MCP host (client): connect stdio and streamable-HTTP servers, discover tools/resources/prompts with bounded pagination, mirror them into the tool registry, and dedupe per session.
- Transport lifecycle: spawn/supervise stdio processes, HTTP sessions, per-server timeout resolution, reconnect with backoff, and change-notification handling with debounce.
- OAuth where a server requires it: authorize/callback/refresh, with credentials routed to `CMP-secrets` and never inlined.

**`CMP-headless` — own.**
- Argument surface and one-shot execution: `-p/--prompt`, workspace selection, model/mode selection, output format, resume/fork by session id, and a stable exit-code contract.

**Edge SDK seam — own.**
- A TypeScript client that talks to the binary over stdio and wraps ACP/headless. It is an *edge*; it must never host loop, provider, tool, or policy logic (`DEC-002`).

**Not owned.** Loop, scheduling, and turn state (`CMP-runner`); durable session store (`CMP-session`); tool execution and permission filtering (`CMP-tools`); allow/ask/deny decisions (`CMP-guard`); subagent lifecycle (`CMP-orch`); provider transports (`CMP-provider`).

## Interfaces

| Component | Depends on | Exposes to |
|---|---|---|
| `CMP-acp` | `CMP-runner` (one control interface), `CMP-session`, `CMP-guard` (permission ask), `CMP-orch` (ACP client spawn) | editors/peer agents over stdio; `CMP-orch` |
| `CMP-mcp` | `CMP-tools` (registry mirroring), `CMP-guard` (egress), `CMP-secrets` (OAuth tokens), `CMP-session` (dedupe scope) | `CMP-tools`, `CMP-context` (resource/prompt sources) |
| `CMP-headless` | `CMP-runner`, `CMP-session` | shells, CI |
| Edge SDK | `CMP-acp`, `CMP-headless` over stdio | external TS embedders |

**Control-interface rule.** All three surfaces translate to the same operations: create/resume session, submit prompt, steer, cancel, observe streamed events, resolve permission. No surface may reach a transport, provider, or persistence handle directly.

## Data / state model

**ACP session binding.** A client session id maps to a durable `CMP-session` id; the binding is recorded so `load`/`resume`/`list`/`fork` are deterministic. `fork` creates a new durable session from a checkpoint boundary; `resume` reattaches an existing log; `load` replays history into the client.

**ACP update classes** (one typed vocabulary, no opaque chunk channel): message chunks, thought summaries (never raw chain-of-thought), plan, tool call, tool-call update, usage update, available-commands, config-option update, and the prompt/step boundary markers.

**ACP method matrix.** Each method maps to one control-interface operation and has a defined session effect.

| ACP method | Control operation | Session effect |
|---|---|---|
| `initialize` | negotiate capabilities | none |
| `session/new` | create | mint durable session |
| `session/load` | replay + attach | read-only history projection |
| `session/resume` | reattach | continue a durable session |
| `session/list` | enumerate | none |
| `session/close` | detach | history retained, not deleted |
| `session/fork` | branch at checkpoint | new durable session |
| `prompt` | submit turn | append events; stream updates |
| `cancel` | cancel turn (cooperative) | in-flight work settled `interrupted` |
| `set-mode` / `set-model` / `set-config-option` | adjust turn context | recorded on the session |
| `session/request_permission` | guard ask → client | resumes or declines the turn |
| client fs read/write | governed write path | snapshot/conflict rules apply |
| client terminal create/output | terminal surface | none durable |

**Permission exchange.** The method token is exactly `session/request_permission`; it is frozen by `DEC-023` and no alias is accepted (the unnamespaced `request/permission` form is not a transition form in either direction). The server emits a permission request with a tool-call descriptor and a fixed option set (allow-once, allow-always, reject-once). An allow-always reply is recorded as the exact remembered pattern by `CMP-guard`, shown to the user before confirmation (`REQ-GUARD-003`). Requests are serialized per session; overlapping requests queue.

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

1. **ACP server boot.** Open the stdio NDJSON stream, answer `initialize` with the negotiated capability set, then serve requests. `prompt` starts a turn through the control interface and streams updates until the turn reaches exactly one terminal state. `cancel` is cooperative and stops streaming promptly (`REQ-LOOP-005`).
2. **Session lifecycle.** `new` mints a durable session; `list` returns client-visible summaries; `load`/`resume` reattach/replay; `close` ends the session without deleting history; `fork` branches at a checkpoint.
3. **Permission flow.** A guard `ask` becomes a client permission request; the decision returns to `CMP-guard`; the loop resumes or declines. A client that lacks the capability resolves to reject.
4. **ACP client flow.** `CMP-orch` requests an ACP child; `CMP-acp` dials the peer, opens a session, submits the task, and maps the peer's streamed updates into child events. Core tickets never cross the boundary; the child returns a receipt.
5. **MCP connect.** On session start, connect configured servers, discover capabilities (paginated), and mirror tools. On tool-list change, debounce and refresh. On disconnect, reconnect with backoff; a failed server is isolated and does not block the session.
6. **MCP OAuth.** An unauthorized connect triggers the authorize flow; tokens are stored via `CMP-secrets`; the transport is retained to finish auth; failures surface as `needs-auth`.
7. **Headless run.** Parse flags → resolve/create session → submit one prompt (or resume/fork) → stream events (or NDJSON) → exit with the contract code. Interruption via signal terminates in the `interrupted` state and still emits the terminal event.

## Failure modes

| Failure | Behavior |
|---|---|
| Malformed JSON-RPC / unknown method | Typed protocol error to the peer; session state unchanged |
| Client lacks permission capability | Resolve to reject; never auto-allow |
| Client fs/terminal unavailable | Degrade gracefully; the tool reports the missing client capability |
| cancel race with turn completion | Cancel is idempotent; the turn still emits exactly one terminal state |
| Duplicate/looping MCP cursor | Typed error; discovery aborts rather than looping |
| MCP transport dies | Reconnect with bounded backoff; server marked failed; session unaffected |
| MCP tool schema drift | Mirror diff updates the registry; calls to removed tools fail typed |
| MCP OAuth token expiry | Refresh once where supported; else `needs-auth` |
| stdio peer exits mid-turn | ACP child settled as failed with a receipt; parent re-plans |
| Headless stdout backpressure | Buffer bounded; on overflow surface a typed error rather than drop events |
| Second surface claims a session | Rejected by ownership; one control interface per session |

## Configuration

- `acp.enabled`, `acp.profile`, `acp.permission_default` (reject unless negotiated).
- `mcp.servers[]`: `{id, transport, command/args/env | url/headers, auth, timeout_seconds, enabled}`; `mcp.default_timeout_seconds`; `mcp.force_legacy`.
- `headless.default_format`, `headless.exit_codes`, `headless.max_output_bytes`.
- `sdk.endpoint` (stdio) for the edge client.

## Requirements mapping

| REQ | How this module satisfies it |
|---|---|
| `REQ-PROTO-001` | ACP stdio server with session create/load/resume/list/close/prompt/cancel and streamed updates |
| `REQ-PROTO-002` | The canonical, frozen `session/request_permission` method carries the permission request to the ACP client; allow/deny is honored by `CMP-guard` and no alias is accepted (`DEC-023`). |
| `REQ-PROTO-003` | MCP host over stdio and streamable HTTP with per-session dedupe |
| `REQ-PROTO-004` | ACP client mode drives peer agents as subordinates (behind `CMP-orch`) |
| `REQ-PROTO-005` | All surfaces talk through one control interface; no loop logic in a surface |
| `REQ-GUARD-003` | Allow-always persists the exact pattern, shown before confirmation |
| `REQ-LOOP-004` | Each prompt maps to exactly one terminal turn state, surfaced to the peer |
| `REQ-LOOP-005` | Cooperative cancel stops streaming promptly; partial work stays inspectable |
| `REQ-SEC-002` | MCP/peer responses are untrusted data, never instructions |
| `REQ-PROV-004` | OAuth tokens and secrets stay in `CMP-secrets`; never logged |
| `REQ-PERF-001` | ACP server reaches a ready handshake within the warm-cache startup bound |

## Open questions

1. **Multiple concurrent ACP clients.** Whether one process serves several editors simultaneously or enforces a single controlling connection per session.
2. **MCP spec-revision strategy.** How far the modern stateless revision is preferred over the legacy handshake, and the exact force-legacy escape hatch semantics.
3. **Headless exit-code table.** The precise numeric mapping and whether declined and guarded-deny share a code.
4. **ACP client authentication.** How agentX authenticates to a peer ACP agent (none, bearer, or negotiated) is not yet specified.
5. **Edge SDK generation.** Whether the TS client is generated from the protocol schemas or hand-maintained, and how drift is verified.
6. **MCP resource/prompt injection budget.** How mirrored resources and prompts are bounded before entering `CMP-context`.
