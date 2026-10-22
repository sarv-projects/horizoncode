# 31. Streaming UI, artifacts, analytics and automations

Status: normative V1 presentation/performance contract.

Under A-V2-31, V1 presentation targets the Linux/WSL CLI/TUI only. Web/desktop surfaces and browser/desktop preview are post-V1; this owner still specifies their future-safe boundary and does not make them available.

## 31.1 Streaming lanes

Separate:
- owning Session message stream plus provider/adapter events;
- durable Rust control/effect events;
- ephemeral UI paint/progress events;
- analytics observations.

For direct TUI/CLI turns, the owning Core stream is produced by `SessionRunner`. Managed
Goal/Task turns use the separate managed `SessionPrompt` lane and project into the same
bounded presentation contracts; presentation parity does not merge their transcript or
Attempt authorities. A SessionPrompt source change is not evidence that ordinary direct TUI
prompts have moved off SessionRunner.

UiEventMux may coalesce ephemeral events but cannot drop or reorder durable owner references.
The normalized provider request emits an ephemeral `session.context_ledger` event before
transport dispatch. Its payload is the strict `ContextLedgerV2` and digest, correlated to the
exact Session request ID and source generation; it carries no raw prompt or provider params.
The TUI context bar renders this latest request projection, showing measured/estimated/unknown
tokens honestly, percentage of the selected model window where computable, and inclusion,
protection and cache provenance. The event is not persisted as conversation content or in a
second ledger database. A reconnect may restore it from the active request's in-memory bounded
projection; otherwise the bar reports that no current ledger snapshot is available until the
next request. Missing UI delivery cannot gate or authorize the provider send.

When the tokenizer or selected-model window is unavailable, the bar may still show the exact
`requestBytes` as **request payload bytes**. This is an aggregate payload fact, not a token
estimate, and must not be added to source-entry byte totals. Token totals and percentages remain
unknown until their own evidence is available.

**V1 reconnect boundary:** the instance SSE endpoint is a live notification stream, not a
global replay log. It does not emit an SSE `id` or accept `Last-Event-ID`; the payload's
event ID is identity only. Per-part Session delta `sequence` + `sourceGeneration` fence
live duplicate/gap/stale-generation delivery, but are not a global event cursor. On
reconnect, rebuild Session transcript projections from canonical Session messages and
re-read any durable managed state from its owning API. Missing notification events never
settle or invalidate an owner transition. V1 does not add a second event database or infer
state from a best-effort event backlog.

## 31.2 Stable transcript rendering

Use stable rendered prefix plus mutable streaming suffix.

Requirements:
- no input focus theft;
- no automatic scroll jump when user is reading history;
- virtualization for long transcripts;
- final message/part identity comes from OpenCode;
- reconnect rebuilds from canonical sources, not an in-memory paint queue.

Tool detail views and transcript export apply the same recursive secret/payload redaction before rendering input, output, or error text. Child-agent and execute summaries redact their labels and cap displayed calls. Transcript export applies byte limits during formatting, sorts at most the latest 10,000 loaded messages, caps each message at 256 KiB and each part at the remaining message budget, and reserves space for an explicit 1 MiB truncation marker. Reasoning included by the explicit thinking export option is redacted and capped at 64 KiB. Regression fixtures cover oversized content and omitted history; they remain unrun, and final integrated renderer/export behavior remains unverified.

## 31.3 Performance budgets

Targets are measured on declared reference hardware:
- keystroke/input response p95 target under 50 ms;
- local UI/status round trip p95 target under 150 ms;
- warm shell usable target under a few seconds excluding model loading;
- prompt/context preparation measured separately;
- **effect path:** warm-kernel read fast path and batched read RPC (§14.3.1, §31.24);
- streaming frame/update bounded under burst;
- memory bounded for long transcript/images.

Do not market a target as a measured guarantee until benchmarked.

## 31.4 Embedded editor

Preferred future web/desktop editor: CodeMirror 6 for code/diff/structured text unless a measured ADR justifies replacement. The V1 CLI/TUI uses its existing terminal-native diff/editor patterns.

Lazy language support. Editor actions map to canonical file/LSP capabilities and Guard.

## 31.5 Artifact model

Distinguish:
1. original/canonical source;
2. durable artifact bytes/metadata;
3. derived render;
4. ephemeral terminal image placement.

Durable artifact records:
- content digest;
- MIME/kind;
- owner/scope/source revision;
- byte count;
- wire fidelity `full`/`head_tail_sample`/`failed`, displayed as FULL/SAMPLE/FAILED;
- retention/security metadata.

Never label a sampled/truncated artifact full.

ArtifactStore is the single canonical byte owner for both direct-session and managed artifacts.
Direct artifacts are addressable only by an opaque ArtifactRef bound to the authenticated Core
Session, producer request ID, producer tool-call ID, effect ID and its settled receipt; paths and
caller-supplied ownership fields never resolve an artifact. The existing `artifacts.search_text`
capability searches direct refs and `terminal.output_range` opens bounded ranges only when the
authenticated Session and every producer pin match; each search/range request reauthorizes through
ArtifactStore. A direct Session can inspect,
search or read bounded ranges only from refs owned by that exact Session. It cannot read managed
Run/Attempt artifacts, and a direct artifact never counts as managed verification/evidence. FAILED
fidelity can be inspected only as bounded failure metadata; a producer with no settled
receipt or UNKNOWN outcome yields no readable artifact. The wire `fidelity` values are `full`,
`head_tail_sample` and `failed`, displayed as FULL, SAMPLE and FAILED. UNKNOWN is a producer/receipt
outcome, never a fidelity value. The ref pins content digest, fidelity, redaction state,
producer provenance and an immutable generation. Every search/range request reauthorizes the exact
Session/ref and checks generation; stale, expired, missing, sensitive, or unknown-redaction content
returns a typed unavailable result, never a filesystem fallback or an empty-success result.
Restart retains ArtifactStore bytes and ref metadata under normal retention; recovery re-resolves
the same immutable ref and receipt and does not repeat the producer effect. Search excerpts and
range pages reuse §37's bounds/redaction rules; full artifact bytes are never inserted implicitly
into model context. A direct artifact cannot be promoted, attached or captured as managed evidence;
an Attempt must produce its own managed-lane artifact/evidence ref. The strict lane-discriminated wire shape is
`contracts-v2/source-artifact-v1.schema.json`: `lane: direct` requires `sessionId`,
`producerRequestId`, `producerToolCallId`, `effectId` and `effectReceiptRef`; `lane: managed`
requires `attemptId` and `evidenceRefs` and forbids direct-lane fields. Direct artifact acceptance is TM-004..TM-008 in §32.23, covering same-Session
access, cross-Session/managed denial, redaction/fidelity, generation drift, restart, capture failure
and bounded search/range behavior.

## 31.6 Safe SVG

Model/source SVG is untrusted.

Pipeline:
- identify bounded source block;
- allow partial preview only via repair that cannot invent active behavior;
- parse/raster in isolated bounded worker;
- no script/network/filesystem/external entity;
- throttle intermediate renders;
- keep last successful frame;
- discard late render if source/theme/geometry generation changed;
- always retain/show source fallback.

## 31.7 Mermaid

Render only complete fenced Mermaid source.

Prefer pure/bounded local renderer. Cache by source grammar/version/theme/width. Unsupported grammar displays source plus diagnostic, not blank output.

Terminal can use Unicode/ASCII representation when graphics unavailable.

## 31.8 Numeric table charts

After a numeric Markdown table is complete:
- parse typed columns/units;
- choose deterministic local chart spec when unambiguous;
- render safe SVG/terminal representation below the original table;
- preserve table as accessible/source truth.

Optional model/judge chart planning requires explicit configured provider/cost consent and cannot alter source values/units.

## 31.9 Terminal graphics

Detect actual capabilities (for example Kitty/SIXEL or supported native renderer).

Use per-surface image budget/lease:
- transmit once/place many where protocol supports;
- reserve layout height;
- evict/purge stale images;
- resize/theme generation;
- text fallback.

Never assume a graphics protocol from terminal name alone.

**Current source boundary (2026-10-20):** `terminal-graphics.ts` implements explicit-protocol negotiation, bounded per-surface placement accounting, generation purge, eviction and text-fallback decisions, but the pinned OpenTUI 0.4.5 package is not present as source in this checkout and its current renderer integration exposes no image transmit/place/evict API. HorizonCode's renderer is created through `createCliRenderer`; writing Kitty/SIXEL sequences directly to stdout would bypass its frame/layout ownership and cannot safely reserve/restore scroll geometry. Therefore production graphics transmission remains unavailable and text/source fallback is used. The helper's unit fixtures are source only and were not run; this is not evidence of a real terminal journey.

## 31.10 Mission Control

Derived view over managed work:
- Runs/Tasks/Attempts;
- worker/subagent graph;
- leases/worktrees;
- effect/approval/NeedsYou;
- budget/usage;
- evidence/verifier;
- automation occurrences.

Actions dispatch canonical capabilities; dashboard cannot edit owner stores directly.

## 31.11 Analytics

Record observations such as:
- provider/model/harness;
- token/cache/cost provenance;
- first-token/total latency;
- context/tool counts;
- effect latency/failure/retry;
- index/search performance;
- UI render/frame/queue metrics;
- agent/worktree utilization.

Every numeric metric is measured, estimated or unknown with source/freshness. Analytics cannot authorize behavior.

## 31.12 Automation UX

Show:
- action/version/scope;
- schedule/timezone;
- enabled state;
- overlap/missed/retry policy;
- next/last occurrence;
- executor availability;
- result/NeedsYou.

Scheduled action still uses the same Guard.

**TUI source status (2026-10-20):** the authenticated automation manager now
projects the current request scope, action version/digest, schedule/timezone,
enabled state, overlap/missed-run policy, retry bounds, next/current occurrence,
latest recorded result and `needs_you` outcome. Create/edit use a bounded,
exact-field editor; enable/disable use compare-and-swap. The shared Guard dialog
allows one-time consent for this exact CRUD capability only when the
host-projected origin is `user_action`, source is `authenticated.user_action`,
and Location is valid; it does not fabricate a Session or Run. Mutation,
one-use lease, durable receipt and ambiguity-recovery journeys remain **NOT
VERIFIED** on the integrated revision. Invocation remains unavailable. Fields
absent from the occurrence projection are reported as unreported rather than
inferred. An absent selected workspace is displayed as `unresolved`; the
projection never substitutes a synthetic `default` workspace.

## 31.13 Browser/desktop preview (post-V1)

Browser and desktop screenshots/DOM/AX state are unavailable in V1. If promoted post-V1, they may appear in panes/artifacts; UI labels whether target is managed or attached and the observation generation. Action feedback must not pretend stale screenshots are current.

## 31.14 Self-improvement boundary

V1:
- analytics;
- failure classification;
- user-visible recommendations;
- deterministic/advisory healing.

Post-V1:
- generated prompt/profile/policy candidate changes;
- canary/automatic adoption.

No V1 automatic self-modification.

## 31.15 Acceptance

- 100k-token transcript/large tool output remains responsive with virtualization/artifactization;
- 1000 tiny stream deltas do not grow unbounded queue;
- reconnect has no duplicate durable message;
- user scroll/focus stable during stream;
- malicious/partial SVG safe;
- Mermaid failure falls back to source;
- table charts wait for completion and preserve values/units;
- terminal no-graphics fallback usable;
- image budget has no leak;
- sampled artifact labeled correctly;
- analytics never fabricate cost/cache;
- automation cannot execute if Guard/executor unavailable.
- activity digest renders §31.22 card kinds with bounded previews; file edits show `▎+` gutter lines and `Ctrl+R` review overlay (`ACT-004`, `ACT-005`);
- read coalescing, shell in-place status, UNKNOWN/SAMPLE/FAILED badges, and `limit_marker` rows match §31.22.9–31.22.10 (`§32.48`).

External OMP rendering/UI research is preserved in the archive and source register 42; accepted behavior is fully stated here.

## 31.16 Adaptive TUI redraw, compact tool tail and attributed resource UX

Rendering is an ephemeral projection over canonical Session parts + Rust events. Use stable committed prefix and a bounded mutable streaming suffix; track dirty regions/layout generation and coalesce replaceable paint updates without delaying keypresses, acknowledgements, approvals, receipts or cancellation. Prefer event-driven redraw; an idle visual effect never forces continuous full-frame repaint. Use active/idle/deep-idle budgets measured on actual terminals, and expose the **reason for each full-frame redraw** in diagnostics. Support tmux/SSH and no-graphics terminals.

A bounded `ToolTailView` maintains recent committed lines plus the current live line/operation marker, in-place duration/status updates and a strict max lines/chars/bytes. The full source remains in the canonical tool result or a bounded artifact, not duplicated across every view. Long-running output passes through line/byte/time caps, backpressure and artifactization, with canonical wire fidelity `full`/`head_tail_sample`/`failed`; the UI maps these to FULL/SAMPLE/FAILED. A missing or uncertain producer receipt is UNKNOWN lifecycle state, not a fidelity value. Final view must survive reconnect without duplicating live pieces.

Resource columns on Mission Control: actual host/kernel and child process RSS/PSS/private bytes where supported; per-Session/Run/worker attribution, open process/FD/thread count, active build targets/worktrees, index/render/token/image cache bytes, local inference VRAM, cold/warm startup, p50/p95 keystroke and stream latency, rendering queue depth and dropped/coalesced ephemeral paints. Respect metric method/platform/source and mark UNKNOWN rather than zero. Provide deterministic disk/cache cleanup proposals, not silent deletion. Diagnostic export is local/redacted unless explicitly approved.

Cache budgets: each Markdown highlight, Mermaid source/render, image placement, AST/index and decoded artifact cache has an upper bound on **count and bytes**, TTL/eviction and stale generation. JCode's particular caps are examples, not copied Horizon guarantees. Enforce cache leak tests under 10k messages, 1000 tiny deltas, 10/20 parallel sessions, terminal resize, idle 30m and repeated previews. §18.17 defines overall resource truth; §32.32 is acceptance.

## 31.17 TUI resource-safe rendering and session orchestration algorithm

The user interface observes canonical backend events and independently controls **paint**, never effect settlement. Match existing source owners: `packages/tui/src/app.tsx` is a tracked overlay; most underlying widgets/events reside in hydrated `opencode/packages/tui/src/`. The proposed scheduler must integrate with the existing terminal renderer, not create another TUI event loop.

~~~ts
type PaintReason = "USER_INPUT"|"STREAM_DELTA"|"TOOL_STATE"|"APPROVAL"|
  "RESIZE"|"THEME"|"SCROLL"|"FOCUS"|"TIMER"|"RECOVERY"|"FULL_INVALIDATION";
type LiveTailV1 = {
  sessionId: string; messagePartId: string; sourceGeneration: string;
  committedLineRefs: string[]; liveLine?: string; status: "RUNNING"|"SETTLED"|"UNKNOWN";
  visibleBytes: number; fullArtifactRef?: string;
  fidelity?: "full"|"head_tail_sample"|"failed";
};
type UiRedrawBudgetV1 = {
  activeFrameMs: number; idleFrameMs: number; deepIdleFrameMs: number;
  deepIdleAfterMs: number; maxQueuedDeltas: number; maxToolTailBytes: number;
  maxToolTailLines: number; maxImageBytes: number; maxRenderCacheBytes: number;
};
~~~

**Initial safety defaults** (tuning candidates, not perf guarantees): active stream redraw no faster than one frame per ~16 ms; idle 250 ms; deep idle 5000 ms after 30 s *without input or meaningful new data*. Input focus/cancel and approvals trigger immediate scheduling instead of waiting for slow idle animation; cap queue at 1024 **replaceable paint deltas per Session**, preserve durable event cursor/backpressure separately. A tool tail stores at most 200 lines/64 KiB of presentation text per active part; large stdout remains bounded immutable SourceArtifact with wire fidelity `full`/`head_tail_sample`/`failed`, displayed as FULL/SAMPLE/FAILED. UNKNOWN is producer/receipt state, never artifact fidelity. Rendering caches have both entry and byte caps chosen through §18.18 measured profile; never hold full decoded 100 MB log solely to draw a few tail lines.

**Pipeline:** canonical event/part generation -> `normalizePaintEvent` (check Session and source rev) -> `stablePrefixDiff` -> `coalesceReplaceableDelta` -> `enqueueDirtyRegion` -> `chooseFrameDeadline(reason,active/idle)` -> `paintChangedCells` -> `recordFrameMetrics`. A terminal resize/theme epoch invalidates geometry and paints a full frame *once*, recording reason; repeated stream deltas should only invalidate bounded rows. Scrollback virtualization renders viewport + fixed overscan and lazily decodes artifacts. A chat turn finishing commits last tail into canonical transcript projection; ephemeral animation/progress never manufactures a new MessagePart.

Source-owned message, reasoning, and tool-input deltas require a valid sequence, source generation, and UTF-16 offset before entering the coalescing queue. A missing/malformed cursor is dropped and requests a canonical Session resnapshot; it cannot fall through to the legacy paint-only queue. Gaps, overlaps, duplicates, generation changes, and queue overflow retain their existing duplicate-suppression/resnapshot behavior.

**Cross-session fairness:** each tab has its own stream cursor, queued delta byte limit, focus/scroll anchor and render generation; only foreground tab receives full-rate paints. Background tabs aggregate scoped unread/progress counters without repainting hidden transcript. Switching tab recreates viewport from canonical parts and applies latest committed cursor; it cannot duplicate a tool result or change Run status. A flood on Session A must not delay cancel/approval in Session B; render scheduling has separate priority from durable control and model transport.

**Perceptual responsiveness:** measure (a) input event to queued UI update, (b) update to frame commit, (c) provider byte arrival to visible token, (d) renderer time and full-frame reasons, with p50/p95 and dropped/coalesced replaceable count. Network/provider duration is distinct. Resource panel labels Linux process PSS/RSS, native Windows private bytes, inference VRAM and byte units; per-Session logical share is ESTIMATED where one kernel serves many Sessions. Accessibility fallback has readable text and no rich terminal protocols.

**Security:** escape terminal control sequences from model/tool stdout, sanitize ANSI/OSC links, cap image dimensions/bytes and terminal graphics leases, avoid leaking off-scope Session events. Token/cost figures reflect actual provider source or UNKNOWN. Export diagnostics is redacted opt-in. Any source revision/permission change invalidates unsafe preview and prohibits stale edit controls.

Managed `ContextSelectionV1` binds the provider-normalized message payload, after
`ProviderTransform.message`, because that transform can strip unsupported parts, normalize
provider options, or add provider cache metadata. Core freezes this normalized payload during
no-dispatch preflight, rechecks the same transformation before dispatch, and reuses the exact
payload after authorization. Managed dispatch must not run the transform a second time after
the ContextSelection receipt; later provider steps clone and transform their complete message
history before `managed_context.advance`. This preserves the request digest boundary without
changing direct Session transformation behavior or enabling provider sends around Guard.

**End-state verification:** (1) 1000 tiny stream deltas have bounded queue and accurate final text, (2) keyboard+approval responsive under active 20-Session background load, (3) SSH/tmux/no graphics has meaningful fallback, (4) idle CPU near measured baseline rather than busy loop, (5) reconnect/focus/scroll no duplicate parts, (6) 10k-part transcript and sampled 100 MB output bounded, (7) ephemeral queue eviction never drops durable cancellation/effect receipt, (8) user sees precise resource method/unknown status and provider warnings. See §32.33.

**Managed final-turn boundary (2026-10-21; source only):** Core requests the separate
`managed_provider.complete_turn` proof only at the terminal SessionPrompt loop exit, after it
reloads the persisted assistant entry and confirms that its finish reason is final, it belongs to
the current user message, and no non-orphan tool work remains. It passes only the final assistant
entry ID and the live managed authority; ManagedControl uses the exact latest retained HostKernel
settlement pins for provider request, response and usage. A provider step that ends in tool calls,
errors, cancellation, UNKNOWN, or a missing/mismatched settlement cannot complete the managed
turn. The Rust operation and Core settlement retention are source-integrated but not verified;
managed provider dispatch and follow-up wake remain unavailable pending P1/P2/P6 integration and
acceptance.

**Managed follow-up safe-boundary seam (2026-10-21; source only):** `SessionPrompt` defines an
injected `ManagedFollowUpRunnerV1` callback that can run only after the persisted final assistant
boundary and P2's authenticated `completeManagedProviderTurn` proof. It receives the live managed
Attempt authority and exact completion receipt. Its returned prompt is accepted only when the
Session, Attempt, request ID/sequence, ContextSelection digest, model, agent, and fresh-mode
selection match the authority's current scope. The adapter must reconcile one exact committed
`follow_up` inbox row, claim its one-use HostKernel wake, persist that receipt, compile and advance
the exact next ContextSelection, prepare the fixed-route request, and return the exact normalized
request/context for the existing serialized runner. The subsequent safe boundary must persist the
split delivery/consuming-scope proof, consume the Core row, and ACK through HostKernel. Queued rows
never wake; restart at `delivering` remains inspect-only/UNKNOWN; no direct-session turn authority
is reused. P2's `advanceManagedContext` requires the typed wake-claim receipt when a new request
follows a completed turn; the HostKernel-issued scope after advance binds the request ID/sequence
and ContextSelection digest. The inbox delivery claim records the post-advance delivery scope,
while the consumption ACK separately binds the current consuming scope and exact wake-claim
receipt. No adapter is currently supplied by the managed Task runner, so invocation remains
fail-closed pending P2/P6 request persistence, route preparation and P1 Guarded dispatch wiring.
This interface is source-present, not acceptance evidence.

**Source status (2026-10-20; clarified 2026-10-21):** the activity stream is mounted in the TUI session route. Both direct-Core and SDK event subscriptions require source sequence/generation cursors, reject malformed or stale deltas, and request canonical resnapshot on gaps, overlaps, generation changes, or missing cursors; bounded queues coalesce replaceable deltas. On SSE reconnect, loaded Session transcript projections are re-read from canonical Session messages; the SSE event payload ID is not a replay cursor and there is no global `Last-Event-ID` replay. Durable managed state must be re-read from its owning API. Activity output and tool details pass through byte/node-limited redaction before rendering. These source paths have focused fixtures, but real terminal reconnect/resnapshot, focus/scroll stability, load bounds, and the complete §32 UI journey remain **NOT VERIFIED**. SVG/Mermaid/table renderer outcomes use separate renderer states: SAMPLE means incomplete source and FAILED means complete source could not render; these are not SourceArtifact wire fidelity values. The aggregate cache-byte metric is a live gauge. These claims are CODE_PRESENT, not measured performance guarantees.

**P7 source continuation (2026-10-20):** the isolated SVG raster port now fences asynchronous results by the active block generation. If a resize/theme generation supersedes an in-flight render for the same source block, the older completion/failure cannot overwrite the newer cache entry. A source regression fixture covers reversed completion order; it has not been executed. This change does not alter the existing byte/entry caps or make any effectful capability available.

The TUI analytics projection now retains both SVG cache gauges (entry count and bytes) per mounted renderer, replaces them on newer observations, drops them when a renderer is disposed, and formats each using the fixed source/unit allowlist. Previously the renderer emitted the entry-count gauge but the analytics allowlist discarded it. This source repair is unverified; no metric is a performance guarantee.

**Replay consumer-failure recovery (2026-10-21):** `UiEventMuxV2` now treats a thrown delta consumer as an ambiguous partial projection: it does not commit the queued source ordinal, drops replay authority for that Session, and requests a canonical resnapshot. This prevents later source events from being accepted against an ordinal range whose UI delivery may have only partly applied. A regression fixture was added and remains unrun; this does not replace reconnect/resnapshot acceptance on the integrated TUI revision.

**Reconnect pagination race recovery (2026-10-21):** the TUI transcript owner fences canonical paginated reads against all live Session events observed while the read is in flight. It retries once when that source generation advances, and installs the fetched pages only when the generation is unchanged. If the source is still advancing on the retry, it preserves the live projection and stream cursor rather than replacing them with a potentially older page set. Concurrent refresh requests coalesce into the same bounded retry, and the recovery generation map is capped at 4,096 Sessions. This source change is unverified; live reconnect/replay acceptance remains open.

**Provider-controlled tool-label rendering (2026-10-21):** the activity renderer now emits a tool label only when it matches the bounded ASCII capability-identifier form. Invalid, overlong, control-bearing, or bidi-bearing names display as `tool`; arguments, detail panels, output and errors continue through their existing recursive redaction and aggregate byte/node caps. A pure regression fixture is authored but unrun. This closes the activity header path where a provider-controlled tool name previously bypassed the safe detail projection.

**Timeline preview labels (2026-10-21):** Session timeline and fork-from-timeline choices now use a one-line, terminal-safe preview with credential/control redaction and a 512-byte cap. The selected message and fork prompt remain bound to the original canonical text; only the displayed choice label is transformed. A pure regression fixture is authored but unrun.

The activity projection's per-tool byte estimate now reserves a conservative 512 bytes for fixed labels and controls in addition to output and argument-preview bytes. This prevents a dense tool history from undercounting its visible framing against the aggregate activity limit; the existing UI fixture source remains unrun.

**P7 detail-renderer fail-closed correction (2026-10-21; source only):** the activity renderer now treats a rejected/over-budget recursive tool-detail sanitization as unavailable and does not pass `undefined` through a `ToolPart` assertion to specialized renderers. The bounded redacted summary and output remain available; expanded details render only after successful sanitization. This source change is unverified.

Tool text redaction also strips C1 controls and the remaining Unicode bidi controls (including ALM, LRM/RLM and deprecated directional controls). Event-triggered canonical message resnapshots now accept only bounded printable Session identifiers and cap concurrent recovery loops at 64; reaching the cap drops replay authority and later deltas can retry after slots free. Focused source fixtures are authored but unrun; no live reconnect or terminal behavior is verified.

The assistant-level error panel now uses the same credential/control redaction and an 8 KiB/32-line presentation bound. It remains a display-only summary; the canonical error record is unchanged. This path has no final TUI rendering evidence.

**Instance SSE backpressure source (2026-10-21):** the authenticated per-instance event fanout now admits at most 256 events, rejects any single serialized event over 64 KiB, caps aggregate queued payload at 2 MiB, and filters other locations/workspaces before queue admission. The aggregate byte counter decreases as events leave the bounded queue. Overflow fails the stream so the SDK reconnect path can rebuild canonical Session projections; it never silently continues after a missing stream event. This source change has not been executed; reconnect recovery for non-Session ephemeral projections and live slow-consumer behavior remain unverified.

**SSE pre-serialization bound (2026-10-21):** event admission now traverses own JSON properties incrementally (without an `Object.keys` array), clones and freezes the exact outbound `{id,type,properties}` DTO under 64 KiB, 8,192 nodes, and depth 32, then serializes it synchronously before queue admission. Both wide objects and sparse arrays stop at the node cap; the queue also caps aggregate retained snapshot nodes at 65,536 alongside its 2 MiB serialized-byte budget. It retains only the detached snapshot and bounded serialized string, so later source-event mutation cannot change the authenticated question-owner projection or exceed the measured payload. Oversized, cyclic, accessor-backed, or non-JSON values overflow-close the same bounded stream; inherited and symbol properties preserve JSON serialization omission semantics. Regression fixtures are authored but unrun. This does not add replay ownership for transient non-Session projections or prove live reconnect behavior.

The fixed TUI metric formatter now suppresses the numeric field whenever provenance is `unknown`; a transport placeholder such as `0` cannot be presented as an observed zero. The formatter fixture was updated but not run. Checkpoint preview/capture/restore still depend on P1's single HostKernel no-follow filesystem and fixed Git observation bound to the same workspace revision and VCS generation; P7 does not infer preview safety from the checkpoint file snapshot or add a parallel filesystem reader.

**P7 source continuation (2026-10-21; implementation present, verification pending):** Core now defines built-in versioned HarnessProfileV1 projections independently of provider/model routing. Each profile's `systemPromptRef` resolves through `builtinHarnessSystemPromptV1` to a retained immutable Core string payload; the ArtifactRef digest and byte length are calculated from that exact payload, and the prompt is included in the real system request. The minimal projection exposes bounded `tools.search` descriptors only from the already-resolved, non-internal registry tools after feature and permission filtering; expansion takes effect at the next provider request boundary. Candidate count, aggregate schema bytes/nodes, aggregate descriptions, and serialized top-K output have explicit fail-closed bounds. Managed ContextSelection carries the toolset manifest and canonical capability rows, with domain-separated BLAKE3 schema and generation digests; resumed direct sessions rehydrate expansion only from completed `tools_search` results whose schema digests still match the current registry. This is source status only: no compile, test, overlay audit or integrated managed-recovery verification has been run, and Guard remains the final effect-admission boundary.

**CodeMode display privacy source correction (2026-10-20):** nested-call live/final metadata now retains tool identity and lifecycle state without copying argument values. The source fixture expectation was updated but not run. CodeMode is still absent from the model-facing registry, and nested MCP dispatch remains unavailable pending P1's Guard/ExecutionHost integration; this metadata change does not enable it.

**CodeMode disabled-path test reconciliation (2026-10-20):** the legacy OpenCode-derived unit suite asserted successful direct MCP dispatch, permission prompts, plugin callbacks, and media forwarding from nested calls. Those expectations contradicted the current fail-closed CodeMode executor and unconditional production registry gate. The suite now covers schema decoding, zero-dispatch before the MCP client, argument-free metadata, cancellation before setup, and registry non-exposure even when the experimental flag is set. These are authored regressions only; they have not been run and do not establish Guarded CodeMode acceptance.

**Analytics multi-step usage correction (2026-10-21; source only):** the TUI Debug projection now reads each persisted assistant `step-finish` provenance record, so a multi-step assistant turn does not collapse to only its last provider usage observation. Each row identifies its step index when available; assistant-level provenance fills only the final missing step for older projections. The recent-message projection scans at most 8,192 parts and reports an additional UNKNOWN record when the bound truncates usage history. The source change is unverified, and cost observations remain separated by provenance because V1 does not declare a common currency.

## 31.18 Checkpoint snapshot store (LLD closure 2026-10-18)

Checkpoint snapshots are a bounded, app-owned artifact family: per-Session count and byte caps with a declared eviction owner, oldest-first eviction under §18 pressure before any user work or evidence is touched, digest-bound previews, and truthful checkpoint state names FULL/SAMPLE/FAILED. These checkpoint states do not redefine SourceArtifact wire fidelity. Snapshot bytes/count appear in the resource panel like other artifact families. First-snapshot retention for diffs follows the session's declared retention; deleting a checkpoint is never a destructive git action. Cross-session fairness and cleanup rules of §31.16–§31.17 apply unchanged.

The Rust `CheckpointJournalV1` persists checkpoint records and restore attempts in the per-Session OwnerLog; artifact bytes remain in ArtifactStore and restore previews bind the checkpoint artifact digest, selected paths, current workspace revision/status, before-file digests, actions, and conflicts. Full restore across a changed workspace revision is refused. Selected-path recovery requires complete trusted VCS status and no-follow regular single-link file facts. Restart changes any `InProgress` restore to durable `Unknown`, retaining exact per-path receipts; completion requires every planned path to have an `Applied` receipt and a final trusted observation. A read-only HostKernel preview operation and Core/TUI projection are source-present, but the current HostKernel observation lacks complete fixed-Git status and therefore emits only conflicts/no actions. Capture/restore production entrypoints remain unavailable until complete same-revision filesystem/VCS evidence plus P1 Guard/lease/supervisor/receipt routes are integrated; no TUI command may imply that checkpoint capture or rewind is live.

**Core/TUI projection status (2026-10-20):** authenticated ServerAuth can list checkpoint IDs and request a read-only `checkpoint.restore_preview` through the Rust-owned checkpoint journal, bound to registered Location and Session scope. Core strictly decodes the digest-bound artifact, workspace revision, actions and conflicts; HTTP exposes the preview; `/checkpoints` can display it. Current HostKernel source supplies only no-follow filesystem observation and rechecks the same workspace revision; it cannot yet supply complete fixed-Git dirty/untracked facts from that observation. Accordingly current preview returns `WORKSPACE_STATUS_UNAVAILABLE` conflicts with zero actions, and Core rejects any action/conflict mixture. The TUI reports preview digest/revision/conflicts and explicitly keeps restore/rewind unavailable. This preview is useful evidence of the blocker, not authorization to restore. Capture and effectful restore remain disabled pending complete same-revision filesystem/VCS evidence, P1 Guard/ExecutionHost effect contracts, and integrated acceptance.

**TUI command source continuation (2026-10-21):** `/checkpoints` is now registered on the Session route. It lists authenticated checkpoint IDs, requests a strict full-restore preview for a selected ID, and displays the digest, workspace revision, planned-action count and bounded conflicts. It exposes no capture or restore control; those paths remain unavailable. The new dialog and route have not been rendered or exercised.

**Checkpoint display hardening (2026-10-21):** checkpoint IDs, paths, digest labels and conflict labels pass through the existing terminal-safe redaction and a byte cap before display. The raw checkpoint ID remains unchanged for authenticated API calls and response matching. Fixtures cover bidi/control removal, credential redaction and label bounds; they have not been run.

**Automation schedule source boundary (2026-10-20):** Rust's durable registry implements overlap, missed-run, retry and UNKNOWN state transitions but intentionally accepts only externally resolved, UTC-ordered `DueOccurrenceV1` values. No in-repository cron/timezone resolver or scheduler producer currently feeds this API. Do not infer host timezone or add an ad hoc parser; durable invocation remains unavailable until the approved canonical timezone-aware Rust scheduler is implemented and routes each occurrence through Guard, lease, receipt and cancellation/restart reconciliation.

**Artifact read continuation (2026-10-20; managed-lane source checkpoint):** HostKernel's private `artifact.v1` projection accepts exact opaque `ArtifactRefV1` values under out-of-body authenticated ArtifactRead context, with the managed Attempt scope checked against that Attempt's durable verifier evidence. `artifacts.inspect` returns bounded fidelity/retention/redaction metadata; `artifacts.read_range` accepts a canonical offset and at most 768 KiB and returns MessagePack Binary bytes. The managed experimental route and goal-verification TUI expose only bounded sanitized previews when fidelity and redaction are known. Principal-wide listing, arbitrary export, and direct reads of managed Attempt artifacts remain unavailable. This is the dated managed source checkpoint, not a change to the direct-session V1 target above. ArtifactStore remains the sole byte owner and reauthorizes/verifies the exact immutable object for every bounded offset. The direct Session-scope projection and direct acceptance remain unverified in the integrated source; no target contract here is implementation evidence.

**Core range-progress guard (2026-10-20):** `ArtifactControl.readRange` now rejects offsets beyond the immutable reference length before HostKernel dispatch and rejects a nonterminal response that returns no bytes/progress. This prevents a range consumer from stalling indefinitely on a validly shaped but nonadvancing response. Source fixtures cover both denials and a bounded progressing range; they have not been run.

**Checkpoint preview projection guard (2026-10-20):** Core rejects duplicate selected paths before dispatch and requires the returned checkpoint ID, mode, and selected-path set to match the request. It requires a revision-change conflict when a FULL restore spans revisions, while preserving the contract's selected-path recovery across revisions when trusted VCS and filesystem checks permit it. This tightens the read-only preview contract only; it does not enable restore. Source fixtures are unrun.

**Checkpoint action projection guard (2026-10-21):** Core validates requested and returned selected paths with the Rust safe-relative-path rules before dispatch/projection. It validates every restore action as a bounded safe relative path, rejects duplicate paths and selected-path actions outside the requested set, and accepts only the Rust planner's regular-file, single-link target shape with a valid digest. Selected, action, and conflict path bytes are bounded before the preview reaches the TUI. Regression fixtures cover traversal, duplicate/out-of-selection paths, hard-linked and absent targets, malformed returned selection, and aggregate conflict-path overflow; they have not been executed. Capture and restore remain unavailable.

**Checkpoint preview contract alignment (2026-10-21):** the HTTP response schema and TUI decoder now enforce the same action subset as Core: regular file, valid digest, safe byte length, and exactly one link. `expectedBeforeDigest` is projected explicitly as digest-or-null. The API cannot describe an absent target as an actionable restore, and the TUI rejects duplicate/out-of-selection action paths. This remains source-only pending final integrated acceptance.

## 31.19 Compact evidence projection and provenance (A-V2-33)

Render child progress as a bounded, redacted summary correlated to Task/Attempt and source cursor. Render durable reviewer decisions, receipts, artifacts and verification from their canonical owners with exact status and revision; reconnect replays/resnapshots from those owners. Compact summaries link to immutable evidence and never replace full test artifacts or imply PASS. Paint/progress may coalesce under backpressure; approvals, cancellation, durable owner references and reconciliation cannot be dropped.

The shared instance `/event` projection applies the same bounded Core-owned Session parent-chain check as the V2 question list/reply routes to `question.v2.asked`, `question.v2.replied`, and `question.v2.rejected`. The authenticated principal comes only from ServerAuth/host middleware; request fields never provide identity. Missing, malformed, stale, cyclic, or over-depth Session ownership denies the event. Compatibility is limited to an ownerless legacy root in the exact current instance directory for the host OS principal. Other location-scoped events retain their existing projection policy. The route implementation is source-present; integrated route acceptance remains unverified.

Analytics records provider cache usage and cost with provider/model/request identity, source, freshness and quality (`provider_reported | measured | estimated | unknown`). The V2 Assistant and `Step.Ended` usage provenance contracts are in §12.18. Token metrics are nonnegative safe integers; cost is finite/nonnegative. Provider token counts are reported usage; a local cost calculation is estimated and must bind all exact price components/source, a SHA-256 pricing tuple digest, algorithm and token inputs. Cost `measured` is unavailable until a real billing/receipt measurement source exists. Missing usage/pricing stays unknown, never zero or an inferred cache hit; legacy scalar aggregates remain compatibility-only and cannot contradict an explicit unknown. Resource attribution includes worker, RepoIntel and verifier reservations using §18.18; analytics and UI projections cannot alter authority or finalization.

The TUI's artifact/stream metrics formatter uses a fixed metric/source/unit allowlist and rejects non-safe, negative or malformed observations as `unknown`; dynamic metric labels and arbitrary source strings are never rendered. This is source-present with a regression fixture, not a claim that provider analytics or full diagnostic telemetry is complete.

**Canonical session usage projection (2026-10-21):** the Debug view scans at most the latest 256 current-Session messages and renders eight assistant usage rows by default (caller cap 16), retaining provider/model and request/operation identity plus each token metric's quality and cost quality. Counts explicitly describe that recent-message window. It never sums legacy scalar columns, treats absent/malformed provenance as unavailable, or labels an estimate as measured; measured cost requires the billing-receipt source and evidence reference. This is a bounded read-only projection, not a second usage store or durable analytics export. The generated V2 SDK now declares `AssistantMessage.usageProvenance` and its schema projection. Fixtures are present but remain unrun.

## 31.20 Durable automation registry and replay fencing

`AutomationRegistryV1` is the production Rust authority for automation in one trusted owner scope. HostKernel supplies only its authenticated private `blake3:<64 lowercase hex>` scope digest and trusted OwnerLog root; callers cannot choose a storage path or principal scope. One `automation_registry` OwnerLog contains the complete sorted automation state map (versioned definition plus pending/active/retry/history occurrence state) and the bounded last 256 mutation receipts. This gives definition changes, schedule admission, settlement, and reconciliation one commit boundary. Independent per-automation logs are compatibility/test-only and are not production authority.

The exported API is `AutomationRegistryV1::open(root, scope_digest)`, `list()`, `get(id)`, guarded create/update/enable/disable CAS methods, `record_due_occurrences(id, now_ms, due, idempotency_key, request_digest)`, `settle_active(id, occurrence_id, outcome, now_ms, idempotency_key, request_digest)`, `reconcile_unknown(id, occurrence_id, outcome, now_ms, idempotency_key, request_digest)`, `guard_request(id, occurrence_id, now_ms, context, raw_argument_digest, bound_intent_digest)`, `guard_request_digest(id, occurrence_id, now_ms, raw_argument_digest)`, `authorize_invocation(id, occurrence_id, now_ms, context, raw_argument_digest)`, `record_guarded_invocation(id, occurrence_id, now_ms, guard_receipt_ref, decision, idempotency_key, request_digest)`, and read-only `reconcile_mutation(idempotency_key, input_digest, automation_id, operation, guard_binding)`. At the HostKernel RPC boundary, reconciliation additionally requires the canonical `hostOperation` (`automations.create|update|enable|disable`) and exact `automationID`; Rust maps that capability ID to the registry operation and checks both against the durable Guard binding and receipt. The HostKernel-only `GuardedAutomationMutationBindingV1` contains the exact BLAKE3 digests of Guard challenge, persisted EffectIntent, and consumed one-use lease. The registry computes the execution-receipt digest from the canonical receipt core (idempotency key, approved input digest, automation ID, resulting definition version, operation), then commits that digest and the three Guard bindings in the same OwnerLog snapshot as the CAS. Exact replay requires equality of the key, approved input digest, operation, automation ID, and all proof bindings; any mismatch conflicts. `reconcile_mutation` is read-only and returns only an exact retained receipt or absence; HostKernel may report NOT_FOUND only after its durable EffectHost state proves no dispatch. Registry snapshots now use v2 to persist proof bindings and continue to read v1 snapshots as legacy, unguarded evidence. Guard intent digest still binds the versioned automation/action identity and occurrence to the canonical raw argument digest; the pending/retry occurrence must be the current candidate. Every mutation returns a durable `AutomationMutationReceiptV1`; consumers resolve resulting state through `get/list`, and receipt is the no-redispatch signal. Create remains compare-and-create; updates and enable-state changes remain exact version CAS; stale versions conflict. Reuse of a retained key with a different digest/proof conflicts; keys outside the bounded 256-receipt window require fresh authorization and current version.

Open replays at most 65,536 OwnerLog records and rejects larger histories pending compaction. Registry snapshots are capped at 1 MiB and 128 definitions; malformed/noncanonical snapshots or scope mismatch fail closed. On restart, Running and CancelRequested occurrences become durable UNKNOWN before the registry is returned; UNKNOWN remains blocking until explicit owner-side reconciliation and never becomes a blind retry. Guarded CRUD is now source-integrated across Core preparation, exact owner-lane consent, HostKernel one-use lease validation, Rust CAS, durable EffectHost receipt settlement, and read-only reconciliation. This source path and its crash/replay cases remain **NOT VERIFIED** on the integrated revision. Invocation remains unavailable (`AUTOMATION_INVOCATION_ENABLED=false`): HostKernel explicitly denies `run_now`, and no trusted scheduler-to-Guarded dispatch path with receipt and cancellation/restart reconciliation is accepted. HostKernel must not wire the legacy per-definition journal.

**CLI/TUI projection status (2026-10-20, corrected 2026-10-21):** authenticated Core routes provide bounded list/inspect/history and guarded enable/disable CAS with exact one-use lease binding and read-only reconciliation after a lost reply. They pass the supervisor's HostKernel-approved `inputDigest` unchanged and never retry a mutation. HostKernel maps guarded CAS to EffectHost prepare/settle and reconciles exact durable receipts; reconciliation binds `automationID` and canonical `hostOperation`. Creation/editing is gated in Core before Guard preparation because no authenticated canonical action-schema projection/validator is available; the TUI explains this and offers no editor submission path. The shared Guard dialog recognizes only the exact authenticated workspace-owner CRUD lane (`user_action` / `authenticated.user_action`, automation capability, valid HostKernel Location) for one-time consent; no Session or Run is fabricated. Existing definitions may still be inspected or disabled. `runNow` remains unavailable and no TUI path invokes an automation. `/checkpoints` exposes authenticated checkpoint IDs and a digest-bound read-only preview; current preview conflicts/no-actions are displayed and restore/rewind remain unavailable pending complete same-revision filesystem/VCS evidence and Guarded operations. This is source integration only: mutation, scheduler and checkpoint journeys remain **NOT VERIFIED**.

**Fixed automation action input contract (2026-10-21; source partial):** each definition pins the action capability/version/implementation digest, the canonical registry's `actionSchemaDigest`, and one immutable user-authored `actionInputJSON` object. The payload is canonical JSON, at most 16 KiB, 2,048 nodes, depth 16, and safe integers only; its digest is domain-separated BLAKE3 over the exact UTF-8 bytes. The digest and schema pin enter the automation effect-intent digest and remain fixed for that definition CAS version; an edit creates a new version and requires new approval. The TUI never renders payload contents. Legacy definitions load as unbound and cannot invoke. Core/TUI perform canonical-shape bounds, but this does not prove schema conformance or exclude secrets. P1 must expose the authenticated canonical machine-registry schema/policy and P2 must verify exact action ID/version/implementation/schema pins and payload against it both before saving and before dispatch; secret-bearing fields must use only schema-approved opaque refs. Those HostKernel routes are pending, so creation and editing now fail in Core before Guard preparation, while all invocation remains closed. Existing definitions may still be inspected or disabled. A caller-provided schema or digest is never authority.

**Managed pre-dispatch recovery source correction (2026-10-21):** every managed SessionPrompt provider dispatch now requires both the live managed ContextSelection and the injected durable pre-dispatch inbox-recovery callback. Core checks session/Attempt/task/request/sequence/context digest against the current HostKernel scope, then invokes recovery before persisting the assistant placeholder or calling the provider. A missing callback/context or mismatched scope fails closed. Direct-session turns and no-dispatch managed preflight are outside this callback path. This source repair is unverified; MPT-001 and the integrated lost-ACK/restart journey remain open.


## 31.21 Usage and agent activity presentation decision (2026-10-21)

Pi's compact footer plus session usage detail and Codex's bounded child activity views are
useful presentation patterns. HorizonCode should keep a compact status projection for the
selected provider/model, elapsed time, token/cache usage and cost quality, with bounded
inspectable detail and attributed child/task activity. All values retain the existing source,
freshness and quality contract; absent usage/pricing stays unknown, not zero. Nested CodeMode
or child-model usage is attributed to its originating tool/task and is included once only.

The activity/task tree is a projection over Core Session events and Rust managed state. It
never becomes a transcript, scheduler, or evidence store. Child reasoning stays redacted;
previews remain bounded and terminal-safe. Hosted session sharing is not implied. See
[`docs/research/2026-10-21-pi-codex-harness-decisions.md`](../docs/research/2026-10-21-pi-codex-harness-decisions.md).
Normative card layout, tool mapping, wireframes, keyboard bindings, and review overlay are **§31.22**; session pane geometry is **§16.21**. Acceptance is **§32.48** (`ACT-001`..`ACT-024`).

**Large-turn activity bound (2026-10-21; source only):** the live activity renderer examines
only the newest 255 parts when the current assistant turn exceeds its 256-node display
budget, reserves one node for an omitted-prefix marker, and still retains the newest final
text part. The existing aggregate byte and tool-detail budgets apply to that bounded tail.
This is a presentation projection; canonical Session history remains available through the
transcript's paged/windowed view. Focus, expand/collapse, scroll, and large-history journeys
remain unverified.

**Progressive tool discovery bound (2026-10-21; source only):** tool ranking rejects more
than 256 candidate descriptors, query input above 1 KiB, malformed descriptor IDs,
capability IDs, schema digests or tags, and aggregate descriptions/tags above 128 KiB before
matching. Search uses a bounded single pass over at most 256 candidates and returns only the
requested result window. This does not change capability admission or make a discovered
tool callable; generation and Rust Guard checks remain authoritative.

**Bounded usage totals projection (2026-10-21; source only):** the TUI Debug detail
shows per-field input/output/reasoning/cache token subtotals separated by
`provider-reported`, `measured`, and `estimated` provenance, plus an explicit
unknown count for each field. It scans only the latest 256 Session messages and
keeps per-request provider/model and cost evidence in a bounded detail list.
Cost is summarized by provenance quality/count only: V1 usage cost has no
currency field, so the UI does not add values across providers/routes or present
a fabricated dollar total. Missing or invalid request/billing/pricing evidence
remains unknown. These source changes and their focused fixtures have not been
executed; no final-revision acceptance is claimed.

The prompt status row now uses the latest assistant message's `usageProvenance` for compact
input/output/cache counts and short provenance labels (`R`/`M`/`E`); malformed or missing
values display as unknown. Cost is shown by provenance quality only because the V1 DTO has no
currency field. The legacy Session scalar token/cost fields do not feed this status row.

**Managed provider-visible message binding (2026-10-21; source only):** managed LLM
preflight and later step preparation now hash the same `ProviderTransform.message` output
that is handed to the AI SDK, clone provider input before mutating normalizers, and skip the
post-authorization middleware transform for managed requests. Direct Sessions retain the
existing middleware path. This closes the source-side digest/dispatch mismatch; no tests or
provider calls have run, and guarded dispatch remains unavailable pending P1/P6 integration.

### Permission friction and subagent activity in the V1 TUI

The TUI presents scoped Guard choices at the exact operation boundary and shows durable
session/workspace grants with expiry, stale reason and revoke action. A matching grant
must prevent repeated prompts for routine permitted file and selected build/test work,
while every operation still receives Guard/lease/receipt processing. Child Sessions and
managed Task DAG nodes appear as separate, attributable activity rows with parent/child
identity, status, model/profile, token/cost provenance and bounded output/artifact links.
The parent can inspect, message, wait, interrupt or cancel through the owning lifecycle;
rendered status never becomes authority. See §§16.19, 29.5/29.13, 31.21–31.22 and 37.25–26.

## 31.22 Activity card presentation — Cursor-informed TUI digest (V1)

Status: normative V1 **presentation contract**. Canonical truth remains Core Session `Part` records, Rust managed projections, and `SourceArtifact` bytes. Activity cards are a **derived, bounded digest** only; they never authorize effects, never replace the transcript, and never hide Guard/UNKNOWN state. Layout geometry is owned jointly with §16.21. Acceptance: §32.48 `ACT-001`..`ACT-024` and existing §32.16 `UI-001`..`UI-019`.

### 31.22.1 Design goals (measurable)

| Goal | Requirement | Verification |
|---|---|---|
| Neat | One primary line per logical action at default collapse | `ACT-001`, `ACT-003` |
| Fast | Activity pane repaints only dirty card rows (§31.16 pipeline) | `ACT-020`, §31.16 metrics |
| Honest | SAMPLE/FAILED/UNKNOWN never styled as success | `ACT-006`, `ACT-007` |
| OpenCode-compatible flow | Transcript + composer unchanged; digest is additive | `ACT-002` |
| Cursor-like review | Unified diff preview + full review overlay | `ACT-004`, `ACT-005` |
| Safe | Redaction before preview; no credential in title/preview | `ACT-008` |

### 31.22.2 Screen layout (V1 single-pane terminal)

Default session view is **one vertical column** (no persistent sidebar). Minimum terminal size: **80×24**; optimized layout **120×40+**.

```text
┌─ Status (1 row) ─────────────────────────────────────────────────────────────┐
│ horizoncode · session abc · gpt-4.1 · harness native-rich · idle            │
├─ Context bar (1–2 rows, from session.context_ledger) ──────────────────────┤
│ tokens 18.4k/128k (est) · files 12 · tools 8 · trim available · grant ask    │
├─ Transcript viewport (flex, ≥40% height, virtualized) ───────────────────────┤
│ User: fix the arch doc section numbering                                     │
│ Assistant: (stable prefix …)                                                 │
│   streaming suffix line updates in place at bottom of assistant message      │
├─ Activity digest (flex, 6–14 rows visible, independent scroll) ─────────────┤
│ ▸ Edited arch_V1/10-DELIVERY.md +48 −0                          1.2s ✓      │
│ ▸ Read 3 paths · repo.tree                                      0.4s ✓      │
│ ▸ Running shell · bun test …                                    12s …       │
├─ Composer (≥3 rows) ─────────────────────────────────────────────────────────┤
│ > │                                                                          │
└─ Footer hints (1 row, context-sensitive) ────────────────────────────────────┘
│ ↑↓ transcript · Tab activity · Enter expand · Ctrl+R review · Ctrl+C stop   │
```

Rules:

1. **Transcript** shows user/assistant **conversation text** and stable markdown/code blocks. It does **not** duplicate full tool stdout by default.
2. **Activity digest** shows **tool/effect summaries** as cards (this section). It is always visible during an active turn unless the user collapses the pane with `/view activity off` (ActionDescriptor; effective state must match §16.3).
3. **Composer** keeps focus after send unless the UI is waiting on a **permission** or **NeedsYou** modal; modals restore focus on dismiss (§16.12).
4. Narrow terminals (**&lt;100 cols**): context bar wraps to two rows; card titles truncate with `…` at **path segments** first, never the status glyph.

### 31.22.3 Card projection model (`ActivityCardV1`)

Cards are computed from Session parts + optional Rust managed rows. Implementation may cache per `(sessionId, assistantMessageId, sourceGeneration)`.

```ts
type ActivityCardKindV1 =
  | "file_edit"      // files.write, files.patch, apply_patch, edit
  | "file_read"      // single-path read
  | "read_group"     // coalesced reads/search/list
  | "shell"          // terminal.run, bash
  | "repo_intel"     // repo.tree, repo.detect, symbols, references
  | "web_search"     // web.search
  | "subagent"       // task / child session
  | "permission"     // Guard ask / grant challenge
  | "codemode"       // codemode.execute wave summary
  | "generic_tool"   // fallback when mapping unknown
  | "progress"       // reasoning placeholder (redacted)
  | "limit_marker"   // omitted prefix / byte cap

type ActivityCardStateV1 =
  | "pending" | "running" | "succeeded" | "failed" | "cancelled" | "unknown"

type ActivityCardV1 = {
  cardId: string              // stable: part.id or group id
  kind: ActivityCardKindV1
  state: ActivityCardStateV1
  titleLine: string           // ≤1 physical row at current width; UTF-8 ≤240 bytes
  pathRef?: string            // repo-relative POSIX path when file-backed
  lineStats?: { added: number; removed: number } // file_edit only; omit if unknown
  durationMs?: number         // wall time; omit until started
  receiptState?: "settled" | "unknown" // effect receipt, not UI opinion
  artifactRef?: string
  fidelity?: "FULL" | "SAMPLE" | "FAILED" // maps wire fidelity; not for UNKNOWN
  collapsedPreviewLines: string[] // 0–6 lines, each ≤ (width−4) cols
  truncatedLineCount: number  // lines omitted from preview; 0 if complete
  expandable: boolean
  reviewable: boolean         // enables Ctrl+R overlay when true
  groupCount?: number         // read_group: N paths
  sourcePartIds: string[]     // traceability to canonical parts
}
```

**Hard limits (presentation only):** max **64** cards per assistant turn in the digest; max **256** cards retained in sliding window (matches activity-stream node budget); max **64 KiB** aggregate preview bytes per turn; max **6** preview lines per collapsed card. Exceeding limits emits a `limit_marker` card: `Activity limited: N earlier actions omitted (ctrl+r transcript)`.

### 31.22.4 Tool → card mapping

| Canonical tool / capability | Card kind | Default title pattern |
|---|---|---|
| `write`, `files.write` | `file_edit` | `Edited {path} +{add} −{del}` |
| `edit`, `apply_patch`, `files.patch` | `file_edit` | `Patched {path} +{add} −{del}` |
| `read`, single path | `file_read` | `Read {path}` |
| 2–8 reads/globs in same turn within 30s | `read_group` | `Read {N} paths` |
| `bash`, `terminal.run` | `shell` | `{Running\|Succeeded\|Failed} shell · {argv0} …` |
| `repo.tree`, `repo.detect`, symbols/refs | `repo_intel` | `Repo {operation} · {shortQuery}` |
| `websearch`, `web.search` | `web_search` | `Web search · {N} results` |
| `task`, child session | `subagent` | `Subagent {profile} · {state}` |
| Guard ask UI | `permission` | `Approval required · {capabilityId}` |
| `codemode.execute` | `codemode` | `CodeMode · {calls}/{max} calls · {state}` |
| other registered tools | `generic_tool` | `{state} {safeToolName}` |

`safeToolName` follows §31.21: invalid provider tool names render as `tool`.

### 31.22.5 Visual language (terminal)

Use theme tokens from the active TUI theme; **never rely on color alone** (§16.12).

| Element | Glyph / style | Meaning |
|---|---|---|
| Collapsed row affordance | `▸` / `▾` | collapsed / expanded |
| Gutter add | `▎+` | added line in diff preview |
| Gutter context | `▎ ` | context line in diff preview |
| Gutter remove | `▎−` | removed line in diff preview |
| State pending | `…` suffix | queued, no duration |
| State running | animated `…` or spinner char + elapsed | updates **in place** on same row |
| State succeeded | `✓` (or `OK` text if ASCII-only terminal) | settled success |
| State failed | `✗` + short error class | no stack dump in title |
| State unknown | `?` + `UNKNOWN` label | receipt missing; `ACT-007` |
| SAMPLE | `SAMPLE` badge on second line | head/tail artifact |
| FAILED artifact | `FAILED` badge | no content pretense |

### 31.22.6 Collapsed card examples (80-column terminal)

**File edit (architecture markdown)** — matches Cursor-style digest:

```text
▸ Edited arch_V1/10-DELIVERY.md +48 −0                    1.2s ✓
    ▎+ ## 10.18 V1 competitive adaptation priorities (2026-10-22)
    ▎+
    ▎+ Status: normative **release ordering** distilled from external competitive …
    ▎+
    ▎+ **Adapt** means complete integration, negative/recovery tests, and honest …
    ▎ … truncated (38 more lines) · Ctrl+R to review
```

**File edit (governance table row)**:

```text
▸ Edited arch_V1/17-GOVERNANCE-DECISIONS.md +1 −0         0.3s ✓
    ▎+ | DEC-V1-35 | V1 competitive adaptation inside existing owners | External …
```

**Read group**:

```text
▸ Read 5 paths · repo.tree, 17-GOVERNANCE…, 32-TASK…       0.5s ✓
    packages/opencode/src/tool/registry.ts
    arch_V1/30-CONTEXT-INDEXING-LOCAL-MODELS.md
    … +2 more · Enter to list
```

**Shell (running → succeeded)** — same `cardId`, title updates without new row:

```text
▸ Running shell · bun test packages/tui                       4s …
▸ Succeeded shell · bun test packages/tui · exit 0          6.1s ✓
    ▎  (3 lines)
    ▎  pass 12 fail 0
    ▎ … truncated (180 more lines) · Ctrl+R to review
```

**Web search**:

```text
▸ Web search · 5 results · exa-route                          2.1s ✓
    ▎  cursor indexing blog — cursor.com
    ▎  aider repomap — aider.chat
```

**Subagent**:

```text
▸ Subagent implementer · running                            32s …
    child session ses_child_01 · profile implementer · tools 12
```

**Permission** (does not collapse away until resolved):

```text
▾ Approval required · files.patch · path kernel/src/guard.rs
    Workspace-write grant covers read; patch needs allow_once
    [a] Allow once  [g] Grant session  [d] Deny
```

### 31.22.7 Expanded inline preview

Trigger: **Enter** or **Space** on focused card (when `expandable=true`).

- Show up to **40** preview lines (not 6) inside the activity pane.
- Still bound by **64 KiB** per-card preview byte cap; further content shows `… truncated (N more lines) · Ctrl+R to review`.
- Collapse: **Enter**/**Space** again or **Esc** (if no overlay open).
- Expanding a card **does not** scroll the transcript viewport (§31.2 / `UI-002`).

### 31.22.8 Review overlay (`ActivityReviewOverlayV1`)

Trigger: **Ctrl+R** when focused card has `reviewable=true`.

Full-screen or **80% height** overlay above composer (transcript dimmed, not destroyed):

```text
┌ Review: arch_V1/10-DELIVERY.md · edit +48 −0 · receipt settled ─── Ctrl+R/Esc close ┐
│ unified diff or exact artifact bytes (redacted)                                      │
│ …                                                                                  │
│ (scrollable, virtualized, max 1 MiB displayed; export uses §31.2 export caps)         │
└────────────────────────────────────────────────────────────────────────────────────┘
```

Rules:

1. Content source priority: (a) structured patch hunks from tool result metadata, (b) `SourceArtifact` with matching digest, (c) bounded stdout if only text exists — label `generic_tool` not `file_edit` if no path binding.
2. If receipt is **unknown**, overlay shows banner `UNKNOWN — content may not reflect workspace` and **disables** “apply” actions (there are none in review-only overlay).
3. **Esc** closes overlay and returns focus to the same card.
4. Overlay is **read-only** in V1; external edit remains `/editor` (§16.20).

### 31.22.9 Coalescing and ordering

1. **Order:** chronological by part `id` / sequence within the active assistant turn (oldest at top of digest, newest just above composer). `limit_marker` rows appear where prefix omitted.
2. **Read group:** merge consecutive `file_read` / `repo_intel` / `grep` tools within the **same assistant message** if (a) ≤30s apart by part timestamp, (b) ≤8 paths, (c) no intervening `file_edit` or `shell`. Emit one `read_group` card listing paths in order.
3. **File edits:** never merge; one card per successful write/patch tool part.
4. **Shell:** merge only **rerun** of same argv digest within 5s into one card with updated state (optional); if ambiguous, keep separate cards.
5. **Final assistant text** is **not** a card; it remains in the transcript with label `Final answer` when complete (existing `ActivityStream` behavior).

### 31.22.10 Focus and keyboard contract (activity pane)

Bindings apply when activity digest or a card has focus (§16.12 superset):

| Key | Action |
|---|---|
| `Tab` / `Shift+Tab` | Next / previous focusable card |
| `Enter` / `Space` | Toggle inline expand |
| `Ctrl+R` | Open review overlay when `reviewable` |
| `Esc` | Close overlay, or collapse expanded card |
| `↑` / `↓` | Scroll activity digest without moving transcript anchor when user scrolled transcript up (`UI-002`) |
| `g` `a` | Optional chord: focus activity digest (register in ActionDescriptor table) |

Footer hint line must list **Ctrl+R** when any visible card is `reviewable`.

### 31.22.11 Relationship to §31.16 `ToolTailView`

- **ToolTailView** = streaming **line tail** for the **currently running** shell/long tool (≤200 lines / 64 KiB).
- **Activity cards** = **per-tool summary rows** with lifecycle.
- For `shell` cards in `running` state, the card title row updates every ≤250ms; tail lines may render **inside** the expanded area only, not spam the transcript.
- When tool completes, tail collapses into the card preview or artifact reference.

### 31.22.12 Implementation alignment (non-normative pointer)

Current source (`packages/tui/src/component/activity-stream.tsx`) renders generic `ToolActivity` rows with Enter/Space expand. V1 acceptance (`ACT-001`..`024`) requires **card kind mapping**, **diff gutter previews** for `file_edit`, **Ctrl+R overlay**, and **read_group** coalescing. Until then, status remains **CODE_PRESENT/PARTIAL**, not VERIFIED.

### 31.22.13 Diagnostics

Debug overlay (`/debug ui` when enabled) records per frame: `activityCardsRendered`, `activityPreviewBytes`, `activityRepaintReason`, `reviewOverlayOpen`. Must not log preview content.

## 31.23 Fast code display, diff/review rendering and highlight RAM bounds (V1)

Code blocks, inline file previews, file viewers and review diffs are **presentation projections**.
They must not duplicate canonical message bytes, full tool stdout, or entire repository files in
memory merely to paint syntax. Canonical sources remain Session parts, bounded
`SourceArtifactV1` refs and Guarded range reads (§§31.5, 37.12). This section tightens §31.2,
§31.16–§31.17 and §31.22.8 for measurable latency and RAM on large content.

### 31.23.1 Design goals (measurable)

| Goal | Target (reference hardware; tuning not a shipped guarantee) |
|---|---|
| First paint of a code block already in viewport | Plain or concealed text ≤ 8 ms p95 before optional highlight |
| Scroll-up during stream | Transcript anchor stable (`UI-002`); activity digest scroll independent (`ACT-009`) |
| Expand code block above viewport | No scroll jump (`UI-003`) |
| Open review overlay on 5k-line diff | Overlay interactive ≤ 200 ms; no full-file highlight tree in RAM |
| 10k-message session with many fenced blocks | Process RSS growth from render caches bounded by §31.23.5 leak tests |

### 31.23.2 `CodeDisplayModeV1` and fast paths

~~~ts
type CodeDisplayModeV1 =
  | "plain"           // no lexer; escape-safe text only
  | "conceal"         // collapse interior lines; show head/tail + line count (TUI default for long blocks)
  | "lazy_highlight"  // highlight only viewport lines + fixed overscan
  | "full_highlight"; // entire visible surface only; never whole artifact if over byte cap

type CodeDisplayPolicyV1 = {
  defaultMode: CodeDisplayModeV1;
  concealAfterLines: number;        // initial safety default: 24
  lazyHighlightMaxLines: number;    // above this, never full_highlight entire buffer
  lazyHighlightMaxBytes: number;    // initial safety default: 262_144 (256 KiB)
  viewportOverscanLines: number;    // initial safety default: 8
  maxConcurrentHighlightJobs: number; // initial safety default: 2 per foreground tab
};
~~~

**Selection rules:**

1. Streaming suffix and unknown language → `plain` until settled.
2. Settled block ≤ `concealAfterLines` → user toggle may choose `lazy_highlight` (session `conceal` default from source applies).
3. Settled block above line/byte caps → `conceal` in transcript; expanded card or review overlay uses `lazy_highlight` on the **visible window** only.
4. `full_highlight` is allowed only when the **render surface** (not canonical source) is under both caps.
5. Language grammars/themes load **on demand** per language id; unload idle grammars under cache pressure (§31.16).

Web/desktop future surfaces use the same policy through CodeMirror 6 lazy highlighting (§31.4);
the V1 CLI/TUI uses the existing OpenTUI `markdown` + `syntaxStyle` seam with these modes.

### 31.23.3 Viewport-only highlighting and scroll behavior

- Maintain a **line index** (offsets or rope) for code/diff surfaces; do not retain a second
  copy of the full UTF-8 string if the canonical part or artifact ref already holds bytes.
- Highlight jobs receive `(sourceGeneration, lineStart, lineEnd, themeGeneration)`; results
  apply only to visible cells. Scrolling discards highlight spans outside viewport + overscan
  unless cached entry still valid.
- **Diff/review** (`ActivityReviewOverlayV1`, §31.22.8) uses a unified **line model**
  (old/new/skip/context). Gutter `▎+` / `▎-` previews in cards are at most **12 lines**
  collapsed; overlay loads additional lines through virtualized window + optional artifact
  `head_tail_sample` when wire fidelity is not `full`.
- Repaint reason `SCROLL` must not reset transcript scroll anchor when the user has scrolled
  up (`PaintReason` §31.17). Code block expand/collapse invalidates only the block's row
  range, not the full transcript (`stablePrefixDiff`).

### 31.23.4 File views and large diffs

- Opening a file from an activity card or review action resolves a **bounded range** (Guarded
  read or direct artifact range). The UI never mmap-loads an entire multi-megabyte file for
  display when fidelity is `head_tail_sample` or `failed`; show SAMPLE/FAILED badges (§31.5).
- Side-by-side diff is post-V1; V1 unified diff with lazy highlight is required.
- Export and copy operations read from canonical bytes with the same redaction/byte caps as
  §31.2 transcript export, not from highlight caches.

### 31.23.5 RAM budgets and caches

Extend §31.16 cache registry with explicit **syntax highlight** entries:

| Cache | Initial safety default (tuning) | Eviction |
|---|---|---|
| `syntax_span` per session | 512 entries / 8 MiB total | LRU; drop on `sourceGeneration` or theme change |
| `diff_line_index` per overlay | 1 active overlay / 2 MiB index | Close overlay frees immediately |
| `grammar_module` global | 16 languages loaded | Idle 10 min or memory pressure §18.18 |

Counts **both** entry count and bytes; stale generation is discarded, never painted.
Diagnostics (`/debug ui`) expose `syntaxCacheEntries`, `syntaxCacheBytes`,
`highlightJobsDropped`, `highlightJobsCoalesced` without content.

**Leak acceptance (with §32.16 `UI-024`..`UI-030`):** 10k messages with 200 fenced blocks,
repeat open/scroll review on 5k-line diff, 30 min idle — syntax cache bytes must return under
configured cap without unbounded slope.

### 31.23.6 Security

Same as §31.17: escape control sequences in model/tool code text; do not execute highlight
themes as code. Untrusted SVG/Mermaid remain in bounded workers (§37.12). Highlight caches
must not retain redacted spans after redaction generation changes.

### 31.23.7 Implementation alignment (non-normative)

Current TUI: `packages/tui/src/routes/session/index.tsx` exposes `session.toggle.conceal`;
`artifact-markdown.tsx` passes `syntaxStyle` to `<markdown>`. There is no viewport-only
highlight scheduler or §31.22 diff gutter preview yet. Owner: `ArtifactRenderServiceV2` code
display slice (§37.12). Status **DESIGNED** until `UI-024`..`UI-030` pass.

## 31.24 Direct-mode migration latency (competitor parity — `DEC-V1-36`)

HorizonCode must remain **competitive on perceived speed** with OpenCode, Cursor CLI, Claude
Code, and Codex for ordinary pair programming. Security adds kernel mediation; **latency
budgets** prevent that mediation from becoming a migration tax.

**Non-goals:** beating competitors on marketing TTFT claims; weakening mutation Guard.

**In scope:**

1. **Provider-only turn** — no kernel wait beyond warm pool (§13.2).
2. **Read-heavy tool turn** — read fast path + batched `prepare_tool_batch_read` (§14.3.1).
3. **Write/shell turn** — grant-covered workspace ops without duplicate approvals (§16.19).
4. **Context compile** — async where possible; hard cap synchronous work on send (reuse §30
   pressure ops, ledger cache).

**Reference targets (WSL2, warm kernel, local IPC)** — verified only via §32.49:

| Scenario | p95 budget (Horizon vs baseline arm) |
|---|---|
| Send → first provider byte (no tools) | Within **+5%** of OpenCode baseline on same model/route |
| 5× `files.read` in one tool response | Horizon ≤ **+10%** vs OpenCode in-process reads |
| 1× in-grant `files.write` after session grant | Guard overhead ≤ **40 ms** before spawn |
| Challenge UI paint | ≤ **150 ms** (§31.3) |

**Diagnostics:** `/debug ui` and optional `/debug effects` (when enabled) show
`kernelRpcMs`, `readFastPathCount`, `batchReadCoalesced`, `guardDecisionMs` without logging
paths or secrets.

**Managed Runs** are excluded from parity claims until user explicitly starts a Goal.

