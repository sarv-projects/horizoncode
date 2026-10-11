# 31. Streaming UI, artifacts, analytics and automations

Status: normative V1 presentation/performance contract.

## 31.1 Streaming lanes

Separate:
- canonical OpenCode message/provider stream;
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
