# 41 — Oh My Pi streaming, terminal visuals, charts, graphic artifact storage: source audit

Status: PINNED RESEARCH / NON-NORMATIVE / NOT IMPLEMENTED in HorizonCode. Pinned upstream commit: can1357/oh-my-pi eec114a9226da698ebc015fd8996a8ca3bc4625c, dated October 11, 2026.
Prior: [Rust/tools audit](38-OMP-SOURCE-COMPETITIVE-AUDIT.md); [TUI UI audit](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md); [proposed UI HLD](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md).
Target: HorizonCode [§31](31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md), [§37](37-RUNTIME-SERVICE-LLD.md), existing canonical OpenCode Session and Rust Guard.

## 41.1 Pinned source map

| Subsystem | Exact pinned source |
|---|---|
| Provider stream details | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/provider-streaming-internals.md) |
| Normalized provider dispatch | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/ai/src/stream.ts) |
| Event queue | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/ai/src/utils/event-stream.ts) |
| Agent loop | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/agent/src/agent-loop.ts) |
| Assistant TUI blocks | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/assistant-message.ts) |
| Streaming figure segmentation | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/figure-markdown.ts) |
| SVG source and partial repair | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/svg-source.ts) |
| Streaming SVG raster control | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/svg-figure.ts) |
| Native bounded SVG rasterizer | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/svg.rs) |
| SVG and Mermaid tool figure | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/fence-figure.ts) |
| Table chart analysis | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/table-chart.ts) |
| Chart planning | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/charts/chart-plan.ts) |
| SVG chart renderer | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/charts/chart-svg.ts) |
| Native Mermaid parser/layout | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/mermaid/mod.rs) |
| Mermaid LRU and width layout | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/theme/mermaid-cache.ts) |
| Terminal image + budget | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/components/image.ts) |
| Kitty graphics protocol | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/kitty-graphics.ts) |
| Terminal history contract | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/tui-core-renderer.md) |
| Transcript history lifecycle | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chrome/transcript-container.ts) |
| Native TSP graphic blobs | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/native/blobs.ts) |
| Registered visual defaults | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/modes/settings.ts) |
| Prompt capability hints | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/system-prompt.ts) |
| Output stream spill | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/tools/streaming-output.ts) |
| Artifact manager | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/session/artifacts.ts) |
| Content-addressed image blob store | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/session/blob-store.ts) |
| Artifact protocol | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/internal-urls/artifact-protocol.ts) |
| Blob and artifacts documentation | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/blob-artifact-architecture.md) |
| Image generation tool | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/image-gen.ts) |
| Remote screen stream documentation | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/stream.md) |
| Remote screen patch encoder | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/stream/paint-encoder.ts) |
| Remote screen redaction | [source](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/stream/redactor.ts) |

## 41.2 Four distinct streaming/artifact meanings

Do not conflate: (1) provider text/thinking/tool-call token streaming to agent/TUI, (2) visual previews from streamed Markdown/SVG/tool file writes, (3) durable storage as session-local text artifacts or content-addressed image blobs, and (4) optional redacted public terminal-screen livestream under the separate omp stream command.

Provider stream: streamSimple resolves model credentials and provider adapter; the provider emits AssistantMessageEvent (start, text_start/delta/end, thinking_start/delta/end, toolcall_start/delta/end, image_end, done/error). EventStream yields every pushed event without throttling, tracks a final message promise. Agent loop builds message snapshots and emits message_start/update/end; AgentSession handles persistence/retry/compaction. Partial toolcall JSON reparsing is geometrically gated to avoid reparsing huge arguments on every token. Important weakness explicitly documented upstream: in-memory event queues are unbounded, and there is NO provider-to-UI hard backpressure.

Horizon: canonical OpenCode Core Session owns messages/parts/continuation; UiEventMux can coalesce ephemeral paint updates but may not drop canonical messages, Guard/effect receipts or tool completion. Distinguish display frame acknowledgment from durable event acknowledgment and effect settlement.

## 41.3 Streaming SVG: actual pipeline

A TUI capability flag invites the model to emit fenced SVG in ordinary Markdown. The default setting tui.renderSvg is true, but graphic protocol and surface support are separate.

FigureMarkdown detects top-level svg fences and splits them from prose. SvgFigure receives the ever-growing source. closePartialSvg drops incomplete suffix constructs (tags, comments, entities) and synthetically closes still-open SVG elements after the root opening tag is complete, so partial content can render. prepareSvg substitutes theme tokens such as var(--accent) and var(--fg), adds default SVG namespace and text color/font.

While streaming, SvgFigure schedules single-flight raster work with a 200-millisecond minimum interval. An incomplete parser failure keeps the previous successful raster; newer source revision invalidates earlier graphics. When source is final, it schedules immediate final render; invalid final SVG falls back to the fenced source in assistant text. Native Rust resvg/usvg/tiny-skia renders to bounded PNG off the JS thread, with local file-backed resources disabled, pixel/dimension limits, and view/cell sizing (max edge 4096px, height budget 80% of viewport). Terminal Image component places result via Kitty or SIXEL where supported; a native Tern Surface Protocol TSP may receive native graphic blobs.

ImageBudget defaults to eight live inline graphics per surface, tracks screen and alternate buffers separately, transmits once then places repeatedly, purges superseded images, and substitutes height-preserving text when evicted. Graphic image IDs/leases are NOT durable artifact IDs.

## 41.4 Mermaid is different and can work without graphics

Fenced mermaid is rendered as ASCII/Unicode text by OMP's native Rust Mermaid layout code. Supported families include flowchart/state, sequence, class, entity relationship and XYChart, with bounded support—not all Mermaid features. A Mermaid fence must be CLOSED before tool/assistant diagram replaces source; partially streamed Mermaid remains code or placeholder. Mermaid cache has 256 entries / 4 MiB budget including failed renders, tries fitting width/direction variants. When unsupported, use copyable source and diagnostics. This behavior aligns with existing Horizon §31.9 Mermaid plan; do not replace it with unrestricted HTML/JS renderer.

## 41.5 Automatic charts from streamed numeric Markdown tables

FigureMarkdown recognizes chartable top-level GFM numeric tables. Table-chart parser defers charting a table at the current streaming tail until the last row is complete. analyzeTable parses quantities, chart-plan selects a ChartSpec, and chart-svg renders theme-token SVG beneath the original Markdown table. Conventional terminals rasterize SVG; Tern native surfaces can carry image/svg+xml with accessible alt text.

Actual setting defaults in packages/coding-agent/src/modes/settings.ts: tui.renderMermaid=true; tui.renderSvg=true; tui.autoGraph=always. Local deterministic always mode creates eligible charts with no second model call. Smart mode delegates ambiguous/multiseries chart selection to a judge model, which may consume extra tokens/cost. Off disables auto-charting. The autoGraph module initializes off internally until host applies settings, not the configured default. OMP docs/changelog scope chart generation and associated prompt guidance to the main interactive TUI, not general ACP/RPC/subagent/print parity.

**Recommendation:** add deterministic table-to-chart rendering only for completed, validated numeric tables. Separate optional billed Smart from free local rendering. Preserve original data, explicit measurement/uncertainty, legible labels and accessible alternate table/text; never hallucinate chart values.

## 41.6 TUI streaming stability and history

Application owns active (mutable) / settled (final but still in viewport) / committed (history acknowledged) blocks. A final SVG block whose async raster is pending CANNOT be committed to immutable scrollback. TerminalFramePlan is a pair: monotonic-ID append/replay history batches with acknowledgments, and mutable viewport rows diffed and repainted. Stable streaming Markdown prefix can retire only after semantic row boundaries; unfinished tail stays mutable. Markdown uses incremental parsing and bounded caches, avoiding full history reparsing every delta. Resizes/replays require explicit policy and must preserve user's scroll, focus, cursor and drafts.

Terminal surfaces differ: regular ANSI + Kitty/SIXEL capability probes, versus native Tern Surface Protocol described UI document ops ACKed by the terminal. TSP can accept vector SVG instead of requiring PNG. Native mode is optional and NOT a universal terminal feature.

## 41.7 Durable artifact and blob storage: NOT equal to visual previews

Session local ArtifactManager stores textual tool stdout/REPL and subagent output under a session artifact directory as numeric-ID named log files. OutputSink has a default 50 KiB inline display budget and streams sanitized/normalized output live; when threshold is passed, it mirrors to a file and displays a bounded head/tail and an artifact://ID reference. Default artifact file cap 16 MiB can truncate the middle to retain head and rolling tail, recording dropped bytes. Atomic temporary-file stage and byte-count check prevent advertising incomplete files as successful captures. On I/O error the tool result can still succeed while artifact persistence is explicitly marked failed; a sampled artifact must never be called full. Artifact protocol resolves session-scoped numeric IDs, and direct full materialization above 8 MiB is refused.

Global image blob store uses content-addressed blob:sha256:HEX references for conversation/provider image payloads and image-generation results, with loader rehydration and missing-blob warnings. Subagent outputs use separate agent:// URLs. A streamed PNG raster for a partial SVG or a chart can remain ephemeral in TUI: rendering a figure is NOT automatically creating a durable user-exportable file.

OMP's separate image_gen tool can call an image generation provider and write image outputs; this is distinct from deterministic SVG/chart raster and can consume metered model requests. Do not combine paid image generation with free local rendering as one capability.

## 41.8 Public omp stream and recording are a fourth subsystem

omp stream broadcasts previously PAINTED terminal rows, not provider tokens or canonical session messages. It retains text styles SGR and OSC8 URLs, strips other escapes, replaces inline images with the literal placeholder [image], redacts best-effort known secrets, diffs viewport, and sends screen patches via local socket/pipe to an optional WSS broadcaster. Paint flush constant STREAM_FLUSH_INTERVAL_MS=50 (not SVG 200). This means a viewer may NOT see in-terminal image previews as images.

Local /record writes similar sanitized terminal screen frames to an ompcast JSONL file for replay. Screen redaction cannot know all sensitive data and is NOT complete; no public stream, recording, artifact upload or image publication should occur without opt-in. Make security boundary and retention explicit.

## 41.9 HorizonCode gaps and proposed additions (NOT ADOPTED)

Existing §31/§37 already include first-class artifacts, stable Markdown prefix, render cache, safe Mermaid after complete fence, optional terminal graphics and isolated worker. The new source-backed refinements:

1. FigureBlockV1 — kind svg/mermaid/chart, source digest/revision, open/final, local derived view vs persisted artifact, theme/viewport geometry epoch, accessible text and exact source fallback.
2. IncrementalSvgRendererV1 — partial-close parser, source/raster generation fencing, bounded single-flight 200ms baseline, last-good raster hold, immediate final, supervised OS-isolated renderer, no file/network/script loads, explicit error and source fallback.
3. TableChartPlannerV1 — complete-table detection, numeric/unit analysis, deterministic mode, optional user-consented model Smart, chart schema validation, table and alt text preserved, explicit model-cost provenance.
4. MermaidAsciiRendererV1 — native Rust text layout and width-selective bounded LRU cache; rendered closed fence only.
5. TerminalGraphicLeaseV1 — Kitty/SIXEL/TSP negotiation, per-surface residency, transmit once/place repeatedly, purge on replacement/eviction, height-preserving text fallback, resize/theme epoch.
6. ArtifactStoreV2 — opaque owner-qualified IDs, SHA256 dedupe, MIME, producer and session/Run, full-vs-sampled fidelity, byte counts, digest, retention, read-boundary, atomic temp publish, corruption/error receipt. Keep display raster separate from canonical content.
7. TerminalHistoryV1 — mutable tail and settled/committed history states, monotonic batch IDs/ACK, separate presentation status from persisted/canonical truth, no scroll theft.
8. Optional ScreenStreamV1 — read-only redacted screen broadcast with explicit user consent and no guarantee redaction is complete; text-only remote image placeholders unless a separate expressly approved image transport exists.

Proposed data shapes: FigureBlock {id, threadId, partId, kind, sourceDigest, sourceRevision, status, altText, renderedRevision?, rendererVersion, themeEpoch, geometryEpoch, artifactRef?}; RenderedVisual {sourceDigest, rasterDigest, mime, sizePx, terminalProtocol, ephemeral, placementLease?}; ArtifactReceipt {artifactId, ownerSession, contentSha256, mediaType, sourceBytes, storedBytes, fidelity(full|sample), droppedBytes, retention, error?}. THESE TYPES ARE NOT YET RUNTIME SCHEMAS.

Authority design: OpenCode provider/message stream -> UiEventMux coalesced ephemeral presentation lane -> TUI figure recognizer -> sandboxed ArtifactRenderService (offthread worker) -> protocol-negotiated terminal presentation; optional durable ArtifactStore for explicitly saved content; Guard authorization for write/export/upload or external processing. No new conversation owner or effect bypass.

## 41.10 Acceptance and test cases before adoption

- SVG: 1000-token tiny-chunk SVG, incomplete nested tags/comments/entities, malicious external resource/entity/script, oversized surface, source changes during raster, 200ms throttle, final immediate, stale image discard, worker crash/timeout, theme/resize, no source loss, no image memory leak.
- Charts: GFM table row still streaming, nested/code tables, invalid numbers/units, negative/interval values, missing cells, deterministic result, Smart opt-in and model usage, no judge failure blocks original table, accessible alt.
- Mermaid: incomplete fence stays code; flowchart/sequence/class/ER/xychart; width-dependent reroute, unsupported source fallback, cache limits, worker panic isolation.
- Terminal: plain dumb terminal, tmux, Kitty, SIXEL, Tern, Windows Terminal, split capability probe, placement cleanup, legacy scrollback vs native ack, no duplicate history/replay.
- Artifacts: 50KiB threshold, 16MiB head/tail cap, explicit dropped byte marker, crash-safe atomic stage, disk full, concurrent resume, session numeric ID collision, 8MiB full URL cap, blob missing/sha mismatch, source provenance and retention.
- Stream: stalled provider, unbounded upstream queue mitigation in Horizon (bounded consumption/presentation), 10 parallel messages, cancellation and checkpoint, visual render coalescing vs final message fidelity, 50ms screen-paint stream not conflated with content, screen redaction leakage, opt-in broadcast.

## 41.11 Implementation recommendation and limits

P1.2-B/P1.3 effect/ownership work stays ahead of graphics parity. Prototype safe SVG source/presentation first, then deterministic table charts and Mermaid ASCII, then durable visual artifact export and advanced terminal protocol support. Benchmark expected renderer caps and terminal capability on the user's actual emulator; do not assume OMP Tern protocol or Kitty/SIXEL universally works. Reusing OMP code requires license/dependency review. Source review is not a run of upstream acceptance tests or Horizon implementation proof.
