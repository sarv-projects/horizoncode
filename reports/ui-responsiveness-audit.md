# P7 UI responsiveness audit — 2026-10-25

## Scope and evidence boundary

This audit covers the V1 Linux/WSL CLI/TUI presentation surfaces in `packages/tui/**`,
plus adjacent P4/P6 owner surfaces where their status affects the visible workflow.
Web, desktop GUI, browser automation/preview, and desktop-control surfaces are
post-V1 and remain unavailable (DEC-V1-31; §31.13). It does not claim rendered
terminal latency, frame-time, RSS, idle CPU, or long-run leak measurements.

Normative sources: `arch_V1/31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md`
§§31.1–3, 31.15–17, 31.21–24; `arch_V1/16-UX-SETTINGS-ECOSYSTEM.md` §16.21;
`arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` UI-001..030 and ACT-001..024.
Acceptance targets (e.g. <50 ms input p95 and ≤8 ms code first-paint p95) are
targets, not measurements.

## Surface inventory and owner boundary

| Surface | Current path / owner | Audit status |
|---|---|---|
| CLI/TUI session, prompt input, streaming transcript and scroll/focus | `packages/tui/src/routes/session/**`, `context/data.tsx`, `context/ui-event-mux.ts`; P7 | Source has stable canonical Session projections, cursor/generation validation, bounded/coalesced stream delivery and resnapshot. Unit tests pass below. Real terminal focus/scroll/reconnect journey: **MEASUREMENT_NOT_RUN / NOT VERIFIED**. |
| Settings, provider/model selection, capability exposure | `packages/tui/src/routes/session/dialog-settings.tsx`, `component/dialog-model.tsx`; P6 owns configuration/provider data and P7 owns TUI projections | Settings/provider/model projections exist; P6 has offline tests. No UI latency or real provider call measured. P7 does not change config, schema or profile owners. |
| Permission and approval UI | `component/dialog-permissions.tsx` and Guard dialog; P1 owns Guard authority, P7 owns display | Rendered unit coverage and typed projection exist. Approval/cancel priority is separate from replaceable paint queues. No interactive flood-under-approval terminal measurement. |
| Editor/explorer and editor settings | `/editor`, `dialog-editor-explorer.tsx`, `dialog-editor-settings.tsx`; P4 owns editor protocol/config integration, P7 owns presentation boundary | P4 reports focused editor TUI suite 15/0 (47 expectations) plus prior editor test 7/0 (17 expectations); launch/suspend/resume/write-fence remain dependency-gated. No real editor-process or frame responsiveness claim. |
| LSP/DAP/REPL | OpenCode-derived UI/protocol surfaces; P4 | P4 reports protocol/component suites, but P1/P2 prerequisites block effectful launch. No CLI/TUI debugger/REPL live journey or latency measurement. |
| Session list/navigation and session output | TUI session route and paged canonical Session data; P7/P3 | Stream queue and resnapshot paths have bounded unit coverage. Long-history rendered virtualization and scroll-anchor acceptance remain open. |
| Activity digest/tool output | `component/activity-stream.tsx`, `activity-cards.ts`; P7 | Digest limits projection to 64 visible nodes, 256 KiB aggregate activity, 64 KiB final text/details; source output is separately bounded/redacted. ACT coalescing, read grouping, full review-overlay and focus journeys remain partly unverified. |
| Artifacts, code blocks, Markdown/SVG/Mermaid/chart render | `util/artifact-render.ts`, `util/code-display.ts`, `component/artifact-markdown.tsx`; P7 | Parser/render source and tests enforce source/output/block/frame caps; code display has bounded conceal/viewport/highlight scheduler and cache. Actual terminal highlight/frame/RSS tests UI-024..030 remain **MEASUREMENT_NOT_RUN**. |
| Usage/debug/analytics | `component/dialog-debug.tsx`, `util/tui-analytics.ts`; P7 | Read-only projections retain provenance and UNKNOWN rather than invented zero. Retention/export/coalescing/comparison integration remains open; no resource timeline benchmark. |
| Activity timers, stream flush and recovery cleanup | `context/ui-event-mux.ts`, `context/data.tsx`; P7 | Queue flush timers are cleared on flush/close; resnapshot retry timers remove abort listeners and abort on provider cleanup; mounted subscriptions/mux are cleaned by `onCleanup`. No leak-slope measurement under repeated mount/unmount or 30-minute idle. |

## Hot-path findings

- Stream deltas are schema/cursor/generation checked before enqueue. The TUI mux
  caps each Session at 1,024 events / 64 KiB, coalesces contiguous same-key deltas,
  has a session cap, and flushes with a 16 ms delay. Durable/control events flush
  before application and do not share the replaceable-delta queue. Queue close
  flushes and clears per-session timers.
- **Fixed this continuation:** stream admission previously computed each delta's
  byte size with `TextEncoder.encode(text)`, allocating a full second byte array
  even when a hostile/oversized delta would immediately exceed the 64 KiB queue
  cap. `packages/tui/src/util/utf8.ts` now counts exact UTF-8 bytes under the cap
  and stops at the first over-cap code point, returning only `cap + 1` for
  admission. The 1,000,000-character test confirms deterministic bounded scan
  work (no timing threshold); UTF-8 and surrogate-pair accounting are covered.
  An oversized canonical stream event still requests canonical resnapshot; it
  does not bypass the byte limit through direct delivery.
- Activity digest takes a bounded recent tail before computing display entries;
  text and tool output are redacted/bounded before specialized display. Unknown
  receipt remains UNKNOWN and sample/failed artifact fidelity is not presented as
  full or success.
- Code display inspects line/byte bounds before expensive syntax work, constrains
  viewport windows/overscan, caps concurrent jobs and keeps a latest-per-key
  pending map. Source/theme generations fence stale results. Cache has entry and
  byte caps. These are source/test properties, not observed performance.
- No recurring full-frame animation loop was found in the audited stream/activity
  path. Spinner rendering is delegated to the terminal renderer; no claims about
  its frame cadence or idle CPU are made. No observed user-controlled animation
  timer lacked a cleanup path in the inspected P7 stream/recovery lifecycle.

## Verification on this continuation

Linux, Bun 1.4.2; local unit fixtures only; no provider, network, Cargo, browser,
desktop app, or live terminal rendering was exercised.

| Command | Result |
|---|---|
| `bun test test/util/utf8.test.ts test/context/data-stream.test.tsx test/context/ui-event-mux.test.ts test/component/activity-stream.test.tsx test/util/code-display.test.ts test/util/artifact-render.test.ts` (`packages/tui`) | **91 pass / 0 fail / 1,071 expectations** |
| `bun test test/agent/agent-node-deps.test.ts test/session/checkpoint-control.test.ts` (`packages/opencode`) | **12 pass / 0 fail / 58 expectations** |
| `bun run --cwd packages/opencode typecheck` before P7 agent correction | **exit 2**, including P7 `agent.ts:503` and `:582` profile revision number/string mismatches plus unrelated owner diagnostics |
| Same package typecheck after correction | **exit 2**, no `agent.ts` diagnostics and no diagnostics in either repaired fixture. Remaining diagnostics are outside those P7 rows: CLI runtime narrowing, server control-plane test graphs, server question live fixture, and P2-owned task fixture. Package is not clean. |

No full build was run. A1 retains the integrated typecheck gate. No physical
latency/RAM/frame/idle/leak workload was run; all such evidence is explicitly
**MEASUREMENT_NOT_RUN**.

New-file visibility: `packages/tui/src/util/utf8.ts` and
`packages/tui/test/util/utf8.test.ts` required exact ignore exceptions; the parent
added those exceptions. This audit report is an additional new file and should
be included in the parent's exact-path overlay visibility review. No other new
source/test file was created in this continuation.

## Remaining acceptance

- UI-001..007 and UI-017..023: real terminal reconnect, slow consumer, input and
  approval responsiveness under stream flood, stable scroll/focus, terminal-size
  behavior and long transcript journeys remain open.
- UI-024..030: reference-machine code first-paint, 5k-line review, 10k-message /
  200-block memory, cache leak slope, repeated previews and idle measurements
  remain **MEASUREMENT_NOT_RUN**.
- ACT-001..024: card mapping/review overlay, exact read-group behavior, long
  output, truncation, UNKNOWN/SAMPLE/FAILED honesty, activity/transcript scroll
  independence and rendered 1,000-event repaint diagnostics need integrated
  terminal evidence. Existing unit suites do not close the full matrix.
- P4 external editor/LSP/DAP/REPL effectful journeys remain gated by P1/P2; P6
  provider/auth journeys remain offline/consent-gated. No UI surface changes
  those gates.
- No dependent phase was newly unblocked. P7 remains **PARTIAL / NOT VERIFIED /
  NOT RELEASED**.
