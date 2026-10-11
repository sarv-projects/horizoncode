# 31 — Fast UI/runtime, artifacts, Mission Control, analytics and automations

**Status:** normative V1 target. Performance is a product requirement and release gate, not post-launch polish.

## 31.1 Experience principles

HorizonCode should feel immediate even when the underlying model is slow.

- keyboard and pointer input remain responsive while multiple agents stream;
- text streaming is smooth, not one React/Solid state update per token;
- scrolling up freezes the user's viewport rather than fighting to return to bottom;
- switching threads preserves draft, selection, scroll and in-flight visual state;
- large histories page and virtualize instead of mounting everything;
- terminals, diffs, editors, previews and artifacts load lazily;
- durable state and high-frequency render state are separate;
- all latency/cost/token/cache claims are measurable;
- novice and expert views share one underlying project/session state.

The existing OpenCode Solid/OpenTUI/Electron surfaces remain the V1 shell. Adopt behavior and performance invariants; do not blindly port React-specific implementation patterns.

## 31.2 Streaming event architecture

The UI consumes one multiplexed event source per host connection. Events have thread/run/resource IDs so one stream can drive many open views.

```ts
type UiStreamEventV2 = {
  eventId: string
  cursor: string
  lane: "durable" | "ephemeral"
  threadId?: string
  runId?: string
  executionId?: string
  kind: string
  timestamp: number
  payload: unknown
}
```

### Durable vs ephemeral

Durable:
- message boundaries;
- tool lifecycle;
- approvals;
- task/run transitions;
- artifact creation;
- usage observations;
- checkpoints/evidence.

Ephemeral:
- token/text deltas already recoverable from final message state;
- spinner/progress animation;
- transient throughput samples;
- terminal repaint fragments where a persistent log artifact exists.

Do not persist every token delta just because the UI can receive it.

### Stream coalescing

Model text deltas are buffered and flushed to the view at a bounded cadence, initially targeting roughly 50–100 ms and adaptively shorter when idle. The exact value is benchmarked by surface/device.

Tool/state boundaries flush immediately.

A slow tab cannot exert unbounded memory pressure; the client has bounded queues and resnapshot behavior.

## 31.3 Stable scroll contract

Each transcript viewport tracks:

```ts
type ScrollAnchorV2 = {
  mode: "follow_bottom" | "anchored"
  anchorEntryId?: string
  anchorOffsetPx?: number
  lastUserScrollAt?: number
}
```

Rules:
- when already near bottom, new streaming content follows bottom;
- after the user scrolls upward, content appended below never changes visible position;
- height changes above the anchor compensate the scroll offset;
- expanding/collapsing code, tool output, image or Mermaid above the viewport preserves the anchored item;
- font/container width changes invalidate height predictions and re-anchor after measurement;
- switching thread stores/restores its anchor independently.

No background event may steal focus or scroll a foreground thread.

## 31.4 Transcript virtualization

The virtualizer maintains:
- immutable entry IDs;
- predicted height by entry kind/content hash/font/width;
- measured height cache;
- visible overscan window;
- correction deltas from ResizeObserver/equivalent;
- paginated older history.

Predictions may use a cheap text measurement path, but correctness comes from measured layout. Cache invalidates on content digest, font metrics, width, expanded state or renderer version.

Default history retrieval is paged; 50 entries/page is an initial UX value, not a storage invariant.

Large tool output is rendered from a bounded preview with an artifact-backed full view.

## 31.5 Thread parking

Inactive threads should retain logical UI state without keeping every expensive renderer alive.

Park:
- draft;
- scroll anchor;
- selected file/tab;
- expanded tool/artifact IDs;
- pending permission form;
- last durable cursor;
- lightweight streaming buffer.

Expensive preview/editor/browser resources may suspend and restore.

If the framework supports preserving DOM/component state efficiently, use it; otherwise serialize view state. Do not couple this contract to React `<Activity>`.

## 31.6 Startup and responsiveness budgets

Record hardware, build and project size with every performance result.

Initial V1 engineering targets on a documented mid-range development machine:

| Metric | Target |
|---|---|
| keypress/composer interaction | P95 < 50 ms |
| command palette/open basic dialog | P95 < 100 ms |
| text delta to visible update once stream established | P95 < 150 ms |
| foreground thread switch with cached state | P95 < 150 ms |
| scroll frame work | aim 60 FPS / no repeated >32 ms stalls |
| basic warm app ready | target < 1 s |
| cold desktop shell usable | target < 2.5 s |
| initial large-repo chat usable | does not wait for full symbol index |
| background indexing | bounded CPU/memory; yields to foreground work |

These are target budgets, not claims. Release records include actual percentiles and regressions.

## 31.7 Editor choice

### V1 preferred embedded code editor: CodeMirror 6

Use CodeMirror 6 for the web/desktop embedded code/diff surface unless a benchmarked required feature cannot be delivered.

Reasons:
- substantially lighter than Monaco;
- language packs and extensions can lazy-load;
- Compartments support reconfiguration without editor recreation;
- suitable for read/write/diff panes and diagnostics.

Required:
- syntax highlighting;
- diagnostics;
- hover;
- go-to-definition/reference navigation through RepoIntel/LSP;
- document highlights;
- read-only mode;
- split and inline diff/merge views;
- large-file safeguards;
- accessible keyboard navigation.

Do not bundle every language pack at startup.

Monaco remains an evaluated fallback for a feature that cannot be provided acceptably with CM6; switching requires a measured ADR, not preference.

### Structured Markdown editor

A richer Markdown editor (Lexical or equivalent) may be lazy-loaded for:
- plans/specs;
- annotations/review comments;
- tables;
- math;
- block slash menu.

It is not required for the normal lightweight chat composer. Avoid loading a second large editor framework on startup solely for simple prompt input.

## 31.8 Artifact model

First-class artifacts:

```text
text/markdown
text/plain
source file / patch / diff
JSON/YAML/table
Mermaid diagram
image
PDF/document reference
terminal/log transcript
test report
benchmark report
proof pack
generated downloadable file
preview URL/snapshot
```

```ts
type UiArtifactV2 = {
  artifactId: ArtifactId
  mediaType: string
  title: string
  digest: Digest
  byteLength: number
  source: string
  renderPolicy: "inline" | "preview" | "download" | "external_open"
  trust: "generated" | "workspace" | "external"
  rendererVersion?: string
}
```

Chat can show an artifact card, inline preview or generated download. It never embeds unbounded raw bytes in the transcript.

## 31.9 Safe Mermaid rendering

Mermaid is first-class because architecture/flow diagrams are highly useful.

Behavior:
- while a Mermaid fence is still streaming, show source or lightweight placeholder;
- render only after a complete fence;
- execute renderer in an isolated worker/sandbox;
- disable active script/unsafe HTML features;
- bound source bytes, render time, node/edge count and output dimensions;
- cache by source digest + renderer version + theme;
- on error, show source + diagnostic, never blank content;
- allow copy/open/export PNG/SVG where safe.

Terminal may provide a text/ASCII fallback or open rendered artifact rather than attempting an unreadable raster.

## 31.10 Dockable workspace

Desktop/web:
- Explorer/file list;
- Conversation/Task;
- editor/diff;
- Git overview;
- terminal/processes;
- tests/evidence;
- browser/preview;
- artifacts;
- agents/resources;
- context;
- analytics.

Panels can split, drag, pin, collapse and persist per project. Persistence stores layout IDs/sizes, not arbitrary executable state.

TUI maps the same conceptual routes to adaptive panes/tabs rather than reproducing desktop drag/drop.

## 31.11 Mission Control

Mission Control is the operational view for running work.

Thread/worker states:
- Running
- Needs Input
- Idle
- Paused
- Recovering
- Errored
- Completed
- Unknown

Per row:
- objective/task;
- selected agent/model;
- elapsed duration;
- current phase/tool;
- last meaningful progress;
- context utilization;
- tokens/cost status;
- workspace/port/database lease;
- effect/approval blockers.

Actions:
- inspect;
- pause if supported;
- resume;
- cancel;
- steer;
- open workspace/diff/evidence.

### Live call feed

Advanced opt-in inspector can show model call/tool timelines. Default view is metadata/redacted summaries. Raw prompts/responses require explicit user access and respect secret/privacy filtering.

Do not stream private model reasoning unless the provider explicitly exposes user-visible reasoning content permitted for display.

## 31.12 Analytics event model

Deep analytics is V1.

```ts
type MetricValueV2 =
  | { status: "measured"; value: number; unit: string; source: string }
  | { status: "estimated"; value: number; unit: string; method: string }
  | { status: "unknown"; unit: string; reason: string }

type InferenceObservationV2 = {
  requestId: string
  threadId: string
  runId?: string
  agentProfileId: string
  providerId: string
  modelId: string
  startAt: number
  firstTokenAt?: number
  endAt?: number

  inputTokens: MetricValueV2
  outputTokens: MetricValueV2
  cacheReadTokens: MetricValueV2
  cacheWriteTokens: MetricValueV2
  cost: MetricValueV2
  requestBytes: MetricValueV2
  latencyMs: MetricValueV2
  timeToFirstTokenMs: MetricValueV2
  tokensPerSecond: MetricValueV2

  contextEntries: number
  toolSchemaTokens?: MetricValueV2
  outcome: string
}
```

Analytics also record:
- tool duration/success/failure/UNKNOWN;
- permission prompts;
- retries/recovery strategies;
- subagent spawn/integration overhead;
- verifier cost/time;
- context trim/prune/compact operations;
- cache efficiency;
- index query/build latency;
- disk/memory/process resource use;
- UI dropped/coalesced event counts;
- startup stages.

## 31.13 Analytics dashboard

Filters:
- All / workspace / project / thread / run;
- agent;
- provider/model;
- hosted/local;
- date/time range;
- task category.

Views:
- cost trend;
- cost per accepted task/run;
- token volume;
- latency/TTFT/TPS distributions;
- context pressure;
- cache efficiency;
- tool success/latency;
- permission prompt rate;
- recovery/retry rate;
- subagent value (time/cost vs accepted contribution);
- model/agent comparison;
- UI/runtime resource chart.

Charts state whether data is measured, estimated or incomplete.

Export produces bounded CSV/JSON/Markdown without secrets.

## 31.14 Privacy and telemetry

Local analytics is on-device by default unless product policy decides otherwise.

- source code/prompt content is not required for aggregate timing metrics;
- sensitive values are redacted before persistence;
- per-content diagnostics require explicit opt-in;
- retention and deletion are user-visible;
- project policy may forbid content-level telemetry entirely;
- remote analytics/export is separate consent.

## 31.15 Automations

Automation is a durable scheduled trigger, not a background chat trick.

```ts
type AutomationV2 = {
  automationId: string
  scope: "project" | "workspace"
  name: string
  enabled: boolean
  schedule:
    | { kind: "cron"; expression: string; timezone: string }
    | { kind: "event"; event: string; matcher?: Record<string,string> }
  actionId: string
  arguments: unknown
  agentProfileId?: string
  permissionPolicyRef: string
  concurrency: "skip" | "queue_one" | "queue_all"
  missedRunPolicy: "skip" | "run_once"
  budgetRef: string
}
```

Each invocation creates an AutomationRun with timestamps, result, logs, effects/evidence and exact action/profile revisions.

Visual cron builder compiles to an inspectable expression. Users can always see the next scheduled run.

Automations never bypass release/deployment approval simply because they are scheduled.

## 31.16 Browser and DOM experience

Built-in browser/DOM capability must work without an external MCP when the bundled browser backend is available, while optional MCP/browser adapters may extend it.

Tools include:
- open/navigate;
- accessibility/DOM snapshot;
- element query;
- click/type/select;
- screenshot;
- console/network errors;
- wait/assert;
- source-anchor inspect for visual editing.

DOM element handles are snapshot/version scoped; stale handles fail and re-query. Browser actions pass through effect policy/network permissions.

Visual edit flow:
render -> select element -> resolve candidate source anchors -> show confidence/candidates -> stage patch -> rerender -> browser assertions -> user/reviewer evidence.

Never promise DOM-to-source mapping where framework/source maps cannot support it.

## 31.17 Self-improvement boundary

### V1

Collect high-quality, provenance-labeled analytics and recovery outcomes.

Allowed:
- show trends;
- retrieve prior approved repair pattern as advisory context;
- suggest configuration changes to the user;
- benchmark alternatives in a sandbox when explicitly started.

Not allowed:
- autonomously change security policy;
- automatically change provider/model;
- silently rewrite agent profiles;
- self-install plugins;
- automatically promote a learned repair into global authority.

### Post-V1 experimental

A separately gated experimental learner may cluster failure signatures, propose prompt/harness/config candidates and run canary evaluations. Promotion always requires a validated policy and user/admin approval. This is separate from the mandatory post-V1 P10 identity migration.

## 31.18 Runtime critical-path budgets

Fast UI is insufficient if the harness adds hundreds of milliseconds around every model/tool
step. Every benchmark records machine, surface, warm/cold state and workload.

Initial engineering targets for **warm local control-plane overhead**, excluding model inference
and the external tool's own work:

| Stage | V1 target / rule |
|---|---|
| ActionDescriptor lookup + availability | P95 < 10 ms |
| capability/tool discovery query (warm) | P95 < 25 ms |
| ContextLedger compile for ordinary turn | P95 < 50 ms at <= 256 entries |
| private host↔kernel IPC request/response overhead | P95 < 10 ms local |
| Guard decision without user prompt | P95 < 10 ms |
| ToolIntent → ExecutionHost dispatch after ALLOW | P95 < 25 ms before child/tool startup |
| warm lexical/symbol query | P95 < 50 ms for target supported project class |
| UI durable event fanout after owner commit | P95 < 50 ms |
| event cursor reconnect/resume bookkeeping | P95 < 100 ms before payload replay |
| clean worktree/resource release bookkeeping | bounded and off foreground UI path |

These are architecture **targets**, not current claims. Platform-specific release records replace
them with measured percentiles. Any stage exceeding its budget emits a stage span so profiling
can distinguish IPC, locking, database, indexing, serialization, rendering and provider delay.

Startup telemetry is stage-separated: config/policy, storage recovery, kernel handshake,
provider catalog, project discovery, UI bootstrap and optional background index warm-up. The
app must become usable before optional indexing/analytics maintenance finishes.

## 31.19 Incremental rendering and renderer fault isolation

Adopt these implementation invariants independently of framework:

- stable Markdown prefix is parsed/rendered once and frozen; streaming re-renders only the
  mutable tail where syntax can still change;
- layout/height caches are keyed by content digest, width/font/theme/expanded state and renderer
  version;
- windowed rendering processes only entries intersecting viewport+overscan;
- reusable scratch buffers avoid large per-frame allocation churn;
- benchmarks measure hot-frame/windowed-scroll paths separately from one-time parsing;
- expensive syntax/highlighting/media work has byte/line caps and yields to input;
- finished tool/log blocks can precompute cheap height summaries instead of re-running expensive
  renderers every frame.

### Renderer isolation

Untrusted generated diagrams/documents can crash or hang a parser/layout engine. A renderer that
cannot provide strong in-process panic/time/memory containment runs in a supervised worker or
short-lived subprocess with:
- bounded input bytes/nodes/dimensions;
- wall-clock timeout;
- explicit kill + reap on timeout;
- atomic output write;
- cache by source/theme/renderer digest;
- no inherited secrets or arbitrary network;
- source/diagnostic fallback after crash.

Mermaid is the first mandatory example. This preserves the main UI even if a diagram renderer
panics or consumes excessive CPU.

## 31.20 UI/runtime performance acceptance

- stream 100K+ token historical thread without mounting all messages;
- streaming Markdown cost grows with mutable tail rather than reparsing the entire response on
  every delta;
- user scrolls up during streaming and viewport does not jump;
- expand code/diagram above viewport without visible displacement;
- switch among several actively streaming threads without lost deltas;
- reconnect from cursor without duplicate final messages;
- terminal output burst does not freeze composer;
- index build does not block initial prompt submission;
- editor language extension loads only when opened;
- Mermaid malicious/oversized fixture is rejected safely;
- forced Mermaid worker panic/timeout leaves the main UI alive and reaps the child;
- analytics totals reconcile to request observations without double-counting cache tokens;
- long-running team/agent telemetry storage remains bounded;
- scheduler missed-run/concurrency policies are deterministic;
- each critical-path budget in §31.18 has a reproducible benchmark and stage trace;
- optional index/analytics warm-up cannot gate basic prompt submission;
- 1/4/16 concurrent streams remain bounded in memory and foreground input latency;
- performance regression output identifies the responsible stage rather than one aggregate
  "slow turn" duration.

## 31.21 Terminal/cursor/automation LLD binding

§37.6/37.7/37.8/37.9 define exact scheduling API, UI subscription-scoped acknowledgements, renderer capability negotiation and provider-cache observations. The TUI probes supported image protocols before attempting graphical Mermaid; otherwise ASCII or the source fence is safe. React Activity is not a Solid/OpenTUI requirement; preserve behavior, not an incompatible framework implementation. Browser actions require stable snapshot/origin generations and Guard. UI stream and Automation schemas reside in contracts-v2. No text/terminal graphics/performance claims are verified until measured on real reference platforms.

## 31.22 Pinned OMP TUI UX performance candidates (not shipped)

Source: [§39](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md), [§40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md). Candidates: first-paint-from-cached model index, lazy provider refresh, model-kind filtering, large catalog virtualization, bounded autocomplete status recomputation, conditional settings with coalesced sections, role preset changes without editor draft loss, Unicode/Nerd/ASCII icon fallback and terminal/desktop semantic parity. Preserve §31 P95 targets, rendering lifecycle and cancellation; OMP screenshot/catalog counts are not performance evidence.

## 31.23 OMP streaming SVG/chart/terminal-artifact research follow-up (non-normative)

[§41 source audit](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md) traces the OMP provider stream, incremental Markdown/partial SVG, native Rust resvg raster, closed-fence Mermaid ASCII, numeric-table chart generator, Kitty/SIXEL/Tern display, artifact:// session logs and blob:sha256 image bytes. High-value additive candidates are bounded streaming SVG rasterization (last-good-image, generation fencing, theme/width epochs), deterministic numeric-table-to-chart rendering with optional paid smart mode, terminal graphics residency/purge, explicit mutable/settled/ACKed history lifecycle, and precise FULL versus head/tail SAMPLE artifact fidelity. Existing §31.2 / §31.8 / §31.9 / §31.19 remain authority; this research does not adopt source code, a new TUI runtime, or UI rendering changes. Streaming visual figures and persisted artifacts are distinct; OMP public omp stream replaces graphics with [image] placeholders.

## 31.24 Implementation acceptance: OMP visual source/revision and artifact fidelity

A-V2-23 approves behavior targets for source-grounded SVG streaming preview, deterministic numeric table charts, Mermaid ASCII and durable artifact truth but not a new renderer runtime. Source routes: [source provenance §42](42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) SRC-010..016; logical contracts in [source-to-LLD §43](43-IMPLEMENTATION-SOURCE-LLD-PLAYBOOK.md) Gate C4 and [§41](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md). Implement via supervised bounded worker, revision/theme/geometry fencing, latest-good frame, source fallback, exact terminal protocol negotiation and image budget. Artifact receipt distinguishes FULL, HEAD_TAIL_SAMPLE and FAILED, and ephemeral raster isn't automatically a file. Measure frame latency/memory under streaming/cancel/replay; no unbounded event queue, hidden smart judge bill or public terminal broadcast.
