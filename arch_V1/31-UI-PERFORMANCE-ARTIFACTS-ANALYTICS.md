# 31. Streaming UI, artifacts, analytics and automations

Status: normative V1 presentation/performance contract.

## 31.1 Streaming lanes

Separate:
- owning Session message stream plus provider/adapter events;
- durable Rust control/effect events;
- ephemeral UI paint/progress events;
- analytics observations.

UiEventMux may coalesce ephemeral events but cannot drop or reorder durable owner references.

## 31.2 Stable transcript rendering

Use stable rendered prefix plus mutable streaming suffix.

Requirements:
- no input focus theft;
- no automatic scroll jump when user is reading history;
- virtualization for long transcripts;
- final message/part identity comes from OpenCode;
- reconnect rebuilds from canonical sources, not an in-memory paint queue.

## 31.3 Performance budgets

Targets are measured on declared reference hardware:
- keystroke/input response p95 target under 50 ms;
- local UI/status round trip p95 target under 150 ms;
- warm shell usable target under a few seconds excluding model loading;
- prompt/context preparation measured separately;
- streaming frame/update bounded under burst;
- memory bounded for long transcript/images.

Do not market a target as a measured guarantee until benchmarked.

## 31.4 Embedded editor

Preferred V1 editor: CodeMirror 6 for web/desktop code/diff/structured text unless a measured ADR justifies replacement.

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
- fidelity FULL/HEAD_TAIL_SAMPLE/FAILED;
- retention/security metadata.

Never label a sampled/truncated artifact full.

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

## 31.13 Browser/desktop preview

Browser and desktop screenshots/DOM/AX state can appear in panes/artifacts. UI labels whether target is managed or attached and the observation generation. Action feedback must not pretend stale screenshots are current.

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

External OMP rendering/UI research is preserved in the archive and source register 42; accepted behavior is fully stated here.

## 31.16 Adaptive TUI redraw, compact tool tail and attributed resource UX

Rendering is an ephemeral projection over canonical Session parts + Rust events. Use stable committed prefix and a bounded mutable streaming suffix; track dirty regions/layout generation and coalesce replaceable paint updates without delaying keypresses, acknowledgements, approvals, receipts or cancellation. Prefer event-driven redraw; an idle visual effect never forces continuous full-frame repaint. Use active/idle/deep-idle budgets measured on actual terminals, and expose the **reason for each full-frame redraw** in diagnostics. Support tmux/SSH and no-graphics terminals.

A bounded `ToolTailView` maintains recent committed lines plus the current live line/operation marker, in-place duration/status updates and a strict max lines/chars/bytes. The full source remains in the canonical tool result or a bounded artifact, not duplicated across every view. Long-running output passes through line/byte/time caps, backpressure and artifactization, with honest FULL/SAMPLE status. Final view must survive reconnect without duplicating live pieces.

Resource columns on Mission Control: actual host/kernel and child process RSS/PSS/private bytes where supported; per-Session/Run/worker attribution, open process/FD/thread count, active build targets/worktrees, index/render/token/image cache bytes, local inference VRAM, cold/warm startup, p50/p95 keystroke and stream latency, rendering queue depth and dropped/coalesced ephemeral paints. Respect metric method/platform/source and mark UNKNOWN rather than zero. Provide deterministic disk/cache cleanup proposals, not silent deletion. Diagnostic export is local/redacted unless explicitly approved.

Cache budgets: each Markdown highlight, Mermaid source/render, image placement, AST/index and decoded artifact cache has an upper bound on **count and bytes**, TTL/eviction and stale generation. JCode's particular caps are examples, not copied Horizon guarantees. Enforce cache leak tests under 10k messages, 1000 tiny deltas, 10/20 parallel sessions, terminal resize, idle 30m and repeated previews. §18.17 defines overall resource truth; §32.32 is acceptance.
