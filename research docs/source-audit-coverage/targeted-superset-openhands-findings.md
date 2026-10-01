# Targeted Superset and OpenHands source findings

**Scope and limits.** This is a targeted source review, not an exhaustive repository
read, full architecture audit, test run, or benchmark. Pins are Superset
`f37599e2774a99dce67f21b887c88bac331da6fc` and OpenHands/OpenHands
`f174ba8465233e46e66ab2c5667b358f1d6676d6`. The ledgers enumerate all tracked
files matching their stated extension filter, including test and UI source; `FULL`,
`PARTIAL`, and `UNREAD` describe only this pass. Superset has 10,286 tracked files and
8,569 selected source candidates (8 full, 3 partial, 8,558 unread). OpenHands has
2,379 tracked files and 2,094 selected source candidates (4 full, 6 partial, 2,084
unread). See the per-file CSVs in this directory.

## Findings already covered by HorizonCode

- **Do not equate a terminal/process, external conversation, and task.** Superset stores
  terminal lifecycle separately from a terminal-agent binding and opaque agent session
  ID ([schema, lines 15–80](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/db/schema.ts#L15-L80)).
  Its child roster is held in an in-memory map and bounded/pruned at runtime
  ([store, lines 115–124 and 285–326](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/store.ts#L115-L124)). HorizonCode's durable
  `WorkerExecution`/`ExternalAttempt` model and UNKNOWN peer visibility already cover
  this distinction (`ARCH/execution/LONG-HORIZON.md`, `AX-318`, `AX-359`).
- **A resume claim needs an outbox/receipt across process crashes.** Superset atomically
  marks the old binding `resumed` before launching; it unclaims only when a caught
  launch error returns control
  ([claim and rollback](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/persistence.ts#L285-L317),
  [resume flow](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/terminal-agents/terminal-agents.ts#L118-L165)).
  Death after the claim and before the successor launch is an inferred crash window,
  not a reproduced defect in Superset. HorizonCode already records it as F-75 and
  requires an expiring fenced claim, durable launch intent/outbox, and restart
  reconciliation under AX-359; no duplicate task is needed.
- **Do not copy an unauthenticated lifecycle hook as trusted task state.** Superset's
  hook route explicitly uses `publicProcedure` and documents that it is unauthenticated
  ([route, lines 105–115](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/notifications/notifications.ts#L105-L115));
  it then records lifecycle events and broadcasts them
  ([lines 172–223](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/notifications/notifications.ts#L172-L223)).
  HorizonCode's AX-359 already requires authenticated source identity, launch ID,
  workspace/fence binding, bounded payload/rate, and UNKNOWN for unverifiable events.
- **Use real path containment before opening peer-reported transcripts.** Superset checks
  normalized absolute `.jsonl` paths against the home prefix
  ([predicate, lines 4–18](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/transcript-path.ts#L4-L18));
  that lexical test does not establish symlink-resolved containment. HorizonCode's
  AX-359 already calls for symlinked transcript-path tests and safe resolution.
- **Preserve role routing when an agent is unavailable.** OpenHands Agent Canvas sends
  to the selected planning conversation when in plan mode and returns an error if that
  target is absent; it does not fall back to the coding parent
  ([send path, lines 1121–1167](https://github.com/OpenHands/OpenHands/blob/f174ba8465233e46e66ab2c5667b358f1d6676d6/src/contexts/conversation-websocket-context.tsx#L1121-L1167)).
  This is consistent with HorizonCode's scoped agent authority and explicit dispatch
  model, not a missing feature.
- **Use durable sequence cursors rather than timestamps for reconnect.** Agent Canvas
  seeds a REST history page and anchors WebSocket replay with `after_timestamp`
  ([history and cursor setup, lines 281–395](https://github.com/OpenHands/OpenHands/blob/f174ba8465233e46e66ab2c5667b358f1d6676d6/src/contexts/conversation-websocket-context.tsx#L281-L395)).
  This is a useful UI recovery pattern, but timestamps are weaker than HorizonCode's
  aggregate sequence/snapshot/replay contract in ARCH/integrations/CONTROL-API.md.
- **Keep backend and runtime trust/auth origins explicit.** The OpenHands frontend
  documents separate Cloud App API history calls and per-conversation runtime calls,
  with different hosts and auth headers
  ([event service, lines 17–36](https://github.com/OpenHands/OpenHands/blob/f174ba8465233e46e66ab2c5667b358f1d6676d6/src/api/event-service/event-service.api.ts#L17-L36)).
  HorizonCode's peer-origin and auth provenance rules already require this distinction.

OpenHands' own repository guidance defines this clone as the Agent Canvas frontend and
assigns the Python SDK, Agent Server, agent loop/tools, conversation events, and
canonical REST/WebSocket API to `OpenHands/software-agent-sdk`
([ownership table, lines 12–23](https://github.com/OpenHands/OpenHands/blob/f174ba8465233e46e66ab2c5667b358f1d6676d6/AGENTS.md#L12-L23)).
Therefore this frontend checkout is not evidence for the backend runtime or the
OpenHands benchmark suite; those require separate pinned source audits.

## One candidate acceptance detail not explicit in the current test wording

OpenHands' frontend projection copies the entire retained `events` array on every
append, including streamed deltas ([event store, lines 92–128](https://github.com/OpenHands/OpenHands/blob/f174ba8465233e46e66ab2c5667b358f1d6676d6/src/stores/use-event-store.ts#L92-L128)).
This is a code-path observation, not a demonstrated performance bug, and it does not
show how their production event volume behaves. HorizonCode already specifies a bounded
virtualized transcript and allocation/RSS measurements (`ARCH/product/UI.md` § resource bounds;
AX-374; `research docs/tests.md` UI resource benchmark), so it does not justify a new
architecture component. It does suggest making the AX-374 fixture explicit: preload a
large history, stream sustained token deltas while scrolling/searching, and record
allocation/render latency and retained UI-window size. Do not copy the peer's array
update strategy.

## Provenance and reuse boundary

Superset's pinned repository declares Elastic License 2.0 in `LICENSE.md`; this review
uses patterns and source references only and does not copy code or propose it as a
dependency. OpenHands/OpenHands declares MIT in `LICENSE`; no source was copied. Any
future code, schema, fixture, or asset reuse must go through `docs/research/SOURCE-LEDGER.md`
and its notice/compatibility review.
