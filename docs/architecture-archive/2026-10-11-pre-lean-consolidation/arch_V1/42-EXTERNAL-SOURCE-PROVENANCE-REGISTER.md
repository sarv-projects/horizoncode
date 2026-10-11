# 42 — Pinned external repository register, source extraction and attribution

**Status: reference and targeted implementation design.** No upstream code has been copied, integrated or accepted by this source register. Full source paths, exact URLs and status are also in [machine JSON](external-source-register.json). Evidence: [OMP Rust/tools §38](38-OMP-SOURCE-COMPETITIVE-AUDIT.md), [OMP TUI §39](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md), [OMP UX §40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md), [OMP visual streaming §41](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md).

## 42.1 All first-party/upstream/external reference repositories (12 total)

Use a full commit SHA for every source read, never blindly fetch latest main/dev into the Horizon working tree. *Local Horizon HEAD* can differ from public Github main, and there are many uncommitted files.

| Role/key | Exact repository URL | Immutable reference | Usage status | Legal/provenance |
|---|---|---|---|---|
| horizoncode | [sarv-projects/horizoncode](https://github.com/sarv-projects/horizoncode) | [bf0399469470](https://github.com/sarv-projects/horizoncode/tree/bf0399469470c6ffdcbe5421dc5c506db2d61fae) | existing_source: first-party local working tree | Proprietary/see repo; local user-owned |
| opencode | [anomalyco/opencode](https://github.com/anomalyco/opencode) | [b1fe25ab5ecc](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322) | existing_source: canonical pinned OpenCode source base | Inspect repository and dependency licenses before copying |
| omp | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | [eec114a9226d](https://github.com/can1357/oh-my-pi/tree/eec114a9226da698ebc015fd8996a8ca3bc4625c) | source_inspected: competitive source and extraction candidates | MIT top-level; pi-builtins has additional file license; verify per-path+dependencies |
| deepseek-harness | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | [5badb15009ae](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) | research_reference: modular plugin/capability orchestration reference | CHECK per-file license/dependency |
| codex | [openai/codex](https://github.com/openai/codex) | [8c0f70116741](https://github.com/openai/codex/tree/8c0f7011674145da7e10627769fb221c74fbf7a0) | research_reference: Goal/agent loop/permissions/TUI reference | Apache-2.0 metadata; verify exact file/deps |
| cline | [cline/cline](https://github.com/cline/cline) | [c3a40572765b](https://github.com/cline/cline/tree/c3a40572765b76873c597247941118c1778d02c8) | research_reference: VS Code UX, computer/automation competitive reference | Apache-2.0 metadata; verify dependencies |
| grok-build | [xai-org/grok-build](https://github.com/xai-org/grok-build) | [2bdd1d6a6369](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | research_reference: coding agent/workflow competitive reference | Apache-2.0 metadata; verify dependencies |
| claude-code | [anthropics/claude-code](https://github.com/anthropics/claude-code) | [2301018b1f61](https://github.com/anthropics/claude-code/tree/2301018b1f61073c501a8e7a4813ef48c239163b) | reference_only: official public docs/behavior comparison | No source reuse assumed; inspect repo LICENSE before any copied code |
| mini-swe-agent | [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | [04d809ceab9d](https://github.com/SWE-agent/mini-swe-agent/tree/04d809ceab9df28f9adaed044884180159172930) | research_reference: minimal agent loop baseline | MIT metadata; verify file/deps |
| openhands | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | [2d174175cede](https://github.com/OpenHands/OpenHands/tree/2d174175cedeac45a0bd7c776728464d7c1140a7) | research_reference: developer/cloud isolation and workflow reference | MIT metadata; verify file/deps |
| openhands-sdk | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | [4cc058275c5a](https://github.com/OpenHands/software-agent-sdk/tree/4cc058275c5a08d845bd846576aafc80e5dd7d0d) | research_reference: software-agent SDK/conversation API reference | MIT metadata; verify file/deps |
| openinterpreter | [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter) | [ac1fcc8fe57a](https://github.com/openinterpreter/openinterpreter/tree/ac1fcc8fe57aba51fcc3c79afd57a0883237fe87) | research_reference: computer-use/safety and host-side execution comparison | Verify license/file/deps |

The first-party Horizon row uses local Git HEAD, not the possibly different remote head. OMP and OpenCode have source-pinned inspections. Other competitor pins are reproducible research snapshots, not proof of every file's semantic audit.

### How a coding agent fetches a pinned external source

For the OMP reference, use the GitHub source connector with the source file path and ref specified below, or a NEW owned temporary clone:

~~~bash
git clone --filter=blob:none --no-checkout https://github.com/can1357/oh-my-pi.git /tmp/horizon-omp-source
git -C /tmp/horizon-omp-source fetch --depth=1 origin eec114a9226da698ebc015fd8996a8ca3bc4625c
git -C /tmp/horizon-omp-source checkout --detach eec114a9226da698ebc015fd8996a8ca3bc4625c
git -C /tmp/horizon-omp-source rev-parse HEAD
~~~

If filtered fetch by SHA is unsupported, fetch the same SHA using an unfiltered repository or fetch_file; NEVER switch silently to a moving branch. A cloned temporary source directory is reference-only and must not be used as a Horizon worktree. Do not delete/recreate a checkout until verified as agent-owned and clean. Preserve user-owned source and sessions.

## 42.2 Exact upstream extraction matrix (23 bounded source routes)

**Meaning of statuses:** PRESERVE_EXISTING = retain current OpenCode path; ADOPT_DESIGN = a new Horizon capability to implement after gates, NOT already shipped; EXPERIMENT_ONLY = benchmark and assess before importing; REFERENCE_ONLY = do not port code; DEFER = post-V1.

### SRC-001 — Canonical session/provider runner, whole-response ToolBatch planning and tool mapping

- Source: opencode; status **PRESERVE_EXISTING**; priority P0.
- Pinned file: [packages/core/src/session.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session.ts).
- Pinned file: [packages/core/src/session/runner/llm.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/session/runner/llm.ts).
- Pinned file: [packages/core/src/tool/registry.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/tool/registry.ts).
- Extract **algorithm/logic**: Canonical session/provider runner, whole-response ToolBatch planning and tool mapping.
- Target **existing service / proposed LLD**: packages/core/src/session, packages/core/src/tool; §20.
- Reject/bound: No Rust conversation duplicate or second provider loop.
- Proof required: Core existing parity and Session projection; ToolBatch direct bypass denial.

### SRC-002 — Retain existing TUI provider/rendering dependencies before introducing changes

- Source: opencode; status **PRESERVE_EXISTING**; priority P0.
- Pinned file: [packages/tui/package.json](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/tui/package.json).
- Pinned file: [packages/llm/package.json](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/llm/package.json).
- Extract **algorithm/logic**: Retain existing TUI provider/rendering dependencies before introducing changes.
- Target **existing service / proposed LLD**: packages/tui, packages/llm, packages/app; §§16,20,31.
- Reject/bound: No parallel Tauri/TUI/provider SDK.
- Proof required: TUI parity, provider capability tests, P95 performance.

### SRC-003 — Hashline anchors+seen-line snapshots; stale recovery, no-op validation; choose edit mode for model

- Source: omp; status **ADOPT_DESIGN**; priority P1.
- Pinned file: [crates/pi-edit/src/modes/hashline/patcher.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-edit/src/modes/hashline/patcher.rs).
- Pinned file: [crates/pi-edit/src/store.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-edit/src/store.rs).
- Pinned file: [packages/coding-agent/src/edit/index.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/edit/index.ts).
- Extract **algorithm/logic**: Hashline anchors+seen-line snapshots; stale recovery, no-op validation; choose edit mode for model.
- Target **existing service / proposed LLD**: §14 effect broker then existing OpenCode edit executor; §33 tool edit.
- Reject/bound: 16-bit visible hash cannot establish integrity; use full digest and revision+Guard.
- Proof required: stale line, malicious alias, conflict, atomic rollback, model-specific compatibility.

### SRC-004 — Native walker/grep/AST speed and source graph semantics

- Source: omp; status **EXPERIMENT_ONLY**; priority P1.
- Pinned file: [crates/pi-walker/src/lib.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-walker/src/lib.rs).
- Pinned file: [crates/pi-natives/src/grep.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/grep.rs).
- Pinned file: [crates/pi-natives/src/ast.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/ast.rs).
- Extract **algorithm/logic**: Native walker/grep/AST speed and source graph semantics.
- Target **existing service / proposed LLD**: indexd/src, packages/core/src/horizon proposed RepoIntel (§30).
- Reject/bound: Pure scanning first; ignore/workspace/path/symlink rules; trust source revision.
- Proof required: benchmark vs existing glob/grep/index; stale invalidation; symlink sandbox.

### SRC-005 — Named tab worker identity, observation epochs, recycle/recover, CDP/DOM/network visibility

- Source: omp; status **ADOPT_DESIGN**; priority P1.
- Pinned file: [packages/coding-agent/src/tools/browser/tab-supervisor.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/browser/tab-supervisor.ts).
- Pinned file: [packages/coding-agent/src/tools/browser/tab-worker.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/browser/tab-worker.ts).
- Pinned file: [packages/coding-agent/src/tools/browser/network.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/browser/network.ts).
- Extract **algorithm/logic**: Named tab worker identity, observation epochs, recycle/recover, CDP/DOM/network visibility.
- Target **existing service / proposed LLD**: §37 BrowserBackendV1, existing OpenCode/browser adapter surfaces.
- Reject/bound: Network interception not sandbox; attached tabs/auth/effects require Guard.
- Proof required: tab recovery/stale-handle/attached consent/browser effect retry.

### SRC-006 — Native screenshot/AX/action lifecycle and platform adapters

- Source: omp; status **ADOPT_DESIGN**; priority P1.
- Pinned file: [packages/coding-agent/src/tools/computer/worker.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/computer/worker.ts).
- Pinned file: [packages/coding-agent/src/tools/computer/supervisor.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/computer/supervisor.ts).
- Pinned file: [crates/pi-natives/src/desktop/mod.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/desktop/mod.rs).
- Extract **algorithm/logic**: Native screenshot/AX/action lifecycle and platform adapters.
- Target **existing service / proposed LLD**: §37 DesktopActionV1 proposed, Rust ExecutionHost, packages/app.
- Reject/bound: Unrestricted Eval not permitted; stale capture/focus and OS-specific rights.
- Proof required: screenshot freshness/focus/permission/window handle/esc kill.

### SRC-007 — Typed web search routing, 20 direct+6 grounded registry and provenance/fallback

- Source: omp; status **ADOPT_DESIGN**; priority P1.
- Pinned file: [packages/coding-agent/src/web/search/index.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/web/search/index.ts).
- Pinned file: [packages/coding-agent/src/web/search/provider.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/web/search/provider.ts).
- Pinned file: [packages/coding-agent/src/web/search/providers/public.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/web/search/providers/public.ts).
- Extract **algorithm/logic**: Typed web search routing, 20 direct+6 grounded registry and provenance/fallback.
- Target **existing service / proposed LLD**: §37 WebSearchProviderProfileV1 proposed; SecretBroker, tool catalog.
- Reject/bound: Free/payed mismatch, provider auth/network policy, no invisible API charges.
- Proof required: offline, source provenance, cost opt-in, rate-limit, no silent fallback.

### SRC-008 — Multiplex language servers; DAP attach/session debugging API

- Source: omp; status **ADOPT_DESIGN**; priority P1.
- Pinned file: [packages/coding-agent/src/lsp/mux/daemon.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/lsp/mux/daemon.ts).
- Pinned file: [packages/coding-agent/src/lsp/tool.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/lsp/tool.ts).
- Pinned file: [packages/coding-agent/src/tools/debug.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/debug.ts).
- Extract **algorithm/logic**: Multiplex language servers; DAP attach/session debugging API.
- Target **existing service / proposed LLD**: §37 LanguageServiceBrokerV1 and proposed DebugAdapterBrokerV1.
- Reject/bound: LSP rename/workspace edit and debugger Eval are guarded EFFECTS.
- Proof required: server crash, restart, multiple workspace, protocol/scope, evaluate denial.

### SRC-009 — Schema-driven settings, icon slash registry, role/provider hub UX, dynamic statuses

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [packages/coding-agent/src/slash-commands/builtin-registry.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/slash-commands/builtin-registry.ts).
- Pinned file: [packages/tui/src/theme/symbols.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/theme/symbols.ts).
- Pinned file: [packages/tui/src/overlays/model-hub.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/overlays/model-hub.ts).
- Pinned file: [packages/tui/src/overlays/settings-selector.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/overlays/settings-selector.ts).
- Pinned file: [packages/coding-agent/src/config/all-settings.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/config/all-settings.ts).
- Extract **algorithm/logic**: Schema-driven settings, icon slash registry, role/provider hub UX, dynamic statuses.
- Target **existing service / proposed LLD**: Existing ActionDescriptor/SettingsDescriptor under packages/core, packages/tui, packages/app; §§16,40.
- Reject/bound: Do not duplicate command/auth handlers; all aliases hit Guard; no hidden costs.
- Proof required: 85 command reference parity, 409 metadata audit, actual Horizon descriptor tests, keyboard UAT.

### SRC-010 — Incremental SVG source segmentation/partial tag repair, 200ms single-flight latest-good raster, fixed width/th

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [packages/tui/src/chat/figure-markdown.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/figure-markdown.ts).
- Pinned file: [packages/tui/src/chat/svg-figure.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/svg-figure.ts).
- Pinned file: [packages/tui/src/chat/svg-source.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/svg-source.ts).
- Pinned file: [crates/pi-natives/src/svg.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/svg.rs).
- Extract **algorithm/logic**: Incremental SVG source segmentation/partial tag repair, 200ms single-flight latest-good raster, fixed width/theme/epoch.
- Target **existing service / proposed LLD**: §31/37 ArtifactRenderServiceV2; TUI FigureBlock adapter.
- Reject/bound: Untrusted SVG in crash-isolated bounded worker, no network/FS/scripts.
- Proof required: partial SVG, malicious XML, stale async frame, theme resize and fallback.

### SRC-011 — Numeric table complete detection then local typed chart spec; optional judge plan for smart

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [packages/tui/src/chat/table-chart.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/table-chart.ts).
- Pinned file: [packages/tui/src/charts/chart-plan.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/charts/chart-plan.ts).
- Pinned file: [packages/tui/src/charts/chart-svg.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/charts/chart-svg.ts).
- Extract **algorithm/logic**: Numeric table complete detection then local typed chart spec; optional judge plan for smart.
- Target **existing service / proposed LLD**: §31 TUI ArtifactRenderer + optional Job route.
- Reject/bound: Smart model cost explicit; table remains source; no chart until closed.
- Proof required: negative values/units/huge tables, no graphics fallback, cost consent.

### SRC-012 — Rust Mermaid layout to Unicode; fit alternatives/capped LRU, finished fence only

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [crates/pi-natives/src/mermaid/mod.rs](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/mermaid/mod.rs).
- Pinned file: [packages/tui/src/theme/mermaid-cache.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/theme/mermaid-cache.ts).
- Pinned file: [packages/tui/src/chat/fence-figure.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/fence-figure.ts).
- Extract **algorithm/logic**: Rust Mermaid layout to Unicode; fit alternatives/capped LRU, finished fence only.
- Target **existing service / proposed LLD**: §31/37 MermaidTextRendererV1 proposed.
- Reject/bound: Do not render unsafe Mermaid HTML/JS; isolate parser; source fallback.
- Proof required: unclosed fence, unsupported grammar, worker fault, narrow-width layout.

### SRC-013 — Kitty/SIXEL/Tern capability, ImageBudget leases/transmit once, viewport vs ACKed immutable history

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [packages/tui/src/components/image.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/components/image.ts).
- Pinned file: [packages/tui/src/kitty-graphics.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/kitty-graphics.ts).
- Pinned file: [docs/tui-core-renderer.md](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/tui-core-renderer.md).
- Pinned file: [packages/tui/src/chrome/transcript-container.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chrome/transcript-container.ts).
- Extract **algorithm/logic**: Kitty/SIXEL/Tern capability, ImageBudget leases/transmit once, viewport vs ACKed immutable history.
- Target **existing service / proposed LLD**: Existing packages/tui; §31/37 TerminalGraphicLease/ViewportHistory.
- Reject/bound: Never assume image protocol; no graphic memory leak/scroll theft.
- Proof required: ANSI-only/WinTerm/tmux/Kitty, resize, eviction, batch ACK, draft focus.

### SRC-014 — Content-addressed blobs, session artifacts with FULL/SAMPLE head/tail fidelity, atomic saved logs

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [packages/tui/src/tools/streaming-output.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/tools/streaming-output.ts).
- Pinned file: [packages/coding-agent/src/session/artifacts.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/session/artifacts.ts).
- Pinned file: [packages/coding-agent/src/session/blob-store.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/session/blob-store.ts).
- Pinned file: [docs/blob-artifact-architecture.md](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/blob-artifact-architecture.md).
- Extract **algorithm/logic**: Content-addressed blobs, session artifacts with FULL/SAMPLE head/tail fidelity, atomic saved logs.
- Target **existing service / proposed LLD**: §31/37 ArtifactStoreV2 proposed; existing kernel/src/artifact_store.rs.
- Reject/bound: Visibility + lifetime + auth, no false fully-saved claim; no direct source delete.
- Proof required: disk-full, 16MiB cap, 8MiB read, dedupe, retry and resume.

### SRC-015 — Provider delta normalization, stable-prefix incremental Markdown, UI lanes

- Source: omp; status **ADOPT_DESIGN**; priority P2.
- Pinned file: [docs/provider-streaming-internals.md](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/provider-streaming-internals.md).
- Pinned file: [packages/ai/src/utils/event-stream.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/ai/src/utils/event-stream.ts).
- Pinned file: [packages/tui/src/chat/assistant-message.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/tui/src/chat/assistant-message.ts).
- Extract **algorithm/logic**: Provider delta normalization, stable-prefix incremental Markdown, UI lanes.
- Target **existing service / proposed LLD**: Existing OpenCode Core/LLM, §31 UiEventMuxV2 and packages/tui.
- Reject/bound: OMP event queues are UNBOUNDED; adopt bounded presentation only.
- Proof required: multi-turn reconnect, no double receipt, burst backpressure and 100K tokens.

### SRC-016 — Separate explicit redacted screen stream/record (paint frames vs model events)

- Source: omp; status **DEFER**; priority POST_V1.
- Pinned file: [docs/stream.md](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/stream.md).
- Pinned file: [packages/coding-agent/src/stream/paint-encoder.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/stream/paint-encoder.ts).
- Pinned file: [packages/coding-agent/src/stream/redactor.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/stream/redactor.ts).
- Extract **algorithm/logic**: Separate explicit redacted screen stream/record (paint frames vs model events).
- Target **existing service / proposed LLD**: §31 optional remote UI streaming only after privacy/security release gate.
- Reject/bound: Best-effort redaction not secrecy; do not upload screen/files without consent.
- Proof required: redaction adversarial, image placeholder, auth/tls, reconnect, opt-in.

### SRC-017 — Modular plugin lifecycle and capability-source arbitration

- Source: deepseek-harness; status **REFERENCE_ONLY**; priority P2.
- Pinned file: [docs/architecture.md](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/docs/architecture.md).
- Pinned file: [packages/boot/plugin-manager/README.md](https://github.com/deepseek-ai/deepseek-harness/blob/5badb15009ae1756c3afe0ae0cef1faafc290ccc/packages/boot/plugin-manager/README.md).
- Extract **algorithm/logic**: Modular plugin lifecycle and capability-source arbitration.
- Target **existing service / proposed LLD**: §29 plugin/mcp registry, §37 typed adapter layer.
- Reject/bound: No trust shortcut via host plugin initialization.
- Proof required: plugin dependency graph, permission provenance, unload/reload.

### SRC-018 — Goal input grammar and TUI command ideas

- Source: codex; status **REFERENCE_ONLY**; priority P2.
- Pinned file: [codex-rs/ext/goal/src/tool.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/ext/goal/src/tool.rs).
- Pinned file: [codex-rs/ext/goal/src/spec.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/ext/goal/src/spec.rs).
- Pinned file: [codex-rs/tui/src/slash_command.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/tui/src/slash_command.rs).
- Extract **algorithm/logic**: Goal input grammar and TUI command ideas.
- Target **existing service / proposed LLD**: §16/40 GoalDraft and ActionDescriptor.
- Reject/bound: No Rust canonical conversation, no second goal authority.
- Proof required: SpecVersion approval, keyboard and plan/execute gate.

### SRC-019 — Minimal agent loop baseline and task fixtures

- Source: mini-swe-agent; status **REFERENCE_ONLY**; priority P3.
- Pinned file: [src/minisweagent/agents/default.py](https://github.com/SWE-agent/mini-swe-agent/blob/04d809ceab9df28f9adaed044884180159172930/src/minisweagent/agents/default.py).
- Extract **algorithm/logic**: Minimal agent loop baseline and task fixtures.
- Target **existing service / proposed LLD**: §32 evaluation.
- Reject/bound: Not alternative provider/runtime.
- Proof required: easy repository fix, error recover, token budgets.

### SRC-020 — SDK abstractions for external worker and structured collaboration

- Source: openhands-sdk; status **REFERENCE_ONLY**; priority P3.
- Pinned file: [openhands-sdk/openhands/sdk/agent/agent.py](https://github.com/OpenHands/software-agent-sdk/blob/4cc058275c5a08d845bd846576aafc80e5dd7d0d/openhands-sdk/openhands/sdk/agent/agent.py).
- Pinned file: [openhands-sdk/openhands/sdk/conversation/conversation.py](https://github.com/OpenHands/software-agent-sdk/blob/4cc058275c5a08d845bd846576aafc80e5dd7d0d/openhands-sdk/openhands/sdk/conversation/conversation.py).
- Extract **algorithm/logic**: SDK abstractions for external worker and structured collaboration.
- Target **existing service / proposed LLD**: §29 agent harness adapter, §37 delegation mailbox.
- Reject/bound: External agent cannot own canonical Session or bypass effects.
- Proof required: third-party action tool/budget/security compatibility.

### SRC-021 — Host computer control risk/reference

- Source: openinterpreter; status **REFERENCE_ONLY**; priority P1.
- Pinned file: [README.md](https://github.com/openinterpreter/openinterpreter/blob/ac1fcc8fe57aba51fcc3c79afd57a0883237fe87/README.md).
- Pinned file: [docs/open-interpreter-delta.md](https://github.com/openinterpreter/openinterpreter/blob/ac1fcc8fe57aba51fcc3c79afd57a0883237fe87/docs/open-interpreter-delta.md).
- Extract **algorithm/logic**: Host computer control risk/reference.
- Target **existing service / proposed LLD**: §14/37 DesktopAction.
- Reject/bound: Reject unrestricted interpreter and side-effect shells.
- Proof required: OS permission deny, ambient resource access denied.

### SRC-022 — Product comparison and benchmark inspiration

- Source: grok-build; status **REFERENCE_ONLY**; priority P3.
- Pinned file: [README.md](https://github.com/xai-org/grok-build/blob/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8/README.md).
- Extract **algorithm/logic**: Product comparison and benchmark inspiration.
- Target **existing service / proposed LLD**: §28/32 task catalog.
- Reject/bound: Product claims are not implementation evidence.
- Proof required: adversarial benchmark reproduction.

### SRC-023 — Product/TUI and VS Code UX inspiration

- Source: cline; status **REFERENCE_ONLY**; priority P3.
- Pinned file: [README.md](https://github.com/cline/cline/blob/c3a40572765b76873c597247941118c1778d02c8/README.md).
- Extract **algorithm/logic**: Product/TUI and VS Code UX inspiration.
- Target **existing service / proposed LLD**: §16/26 UI and §32 acceptance.
- Reject/bound: Do not copy framework/extension licensing without review.
- Proof required: end-to-end UI+permissions parity.


## 42.3 Mandatory upstream-to-Horizon implementation procedure

1. **Authority first:** read adopted §17, §§01–05, 12–14, §20, §24 and §33 before a path is mutated. OpenCode Core V2 owns Session/Input/Message/Part and provider continuation; Rust OwnerLog/Guard owns managed Goal/Run/Task/effects/evidence. Direct Sessions do NOT require a Goal.
2. **Current code first:** inspect live modified files with git status, exact source and tests; locate the current handler using rg/grep. An architecture spec is NOT evidence the function exists. Build a file- and function-level map Existing → Adapt → Proposed, source revision, and owner before changing anything.
3. **Pinned source only:** open the exact external URLs above and follow imported callees, test fixtures, schemas, error handlers and platform branches at the same immutable commit; do not assume a standalone file has all required behavior.
4. **Decide formally:** REUSE EXISTING, PORT ALGORITHM, IMPLEMENT ADAPTER, EXPERIMENT, or REJECT. For any code copy/translation, inspect the exact file's license, exceptions, transitive dependency closure, attribution and platform compatibility.
5. **Design shape and threat boundaries:** typed contracts with IDs, SourceDigest, Settings requested/effective layer, provider/model/harness identity, ACL/effect class, cancellation, idempotency, revisions, replay, stale outcomes, budget/usage provenance and accessibility. Pure rendering still needs untrusted parser isolation; tool effects ALWAYS through the same Rust Guard and ExecutionHost boundary.
6. **Test-first implementation:** shared JSON Schema/TS/Rust fixture validation, then unit+integration+platform and denied/abort/recovery tests, then task-based end-to-end UAT. Do not claim safety from schema parsing or coverage of unimplemented services.
7. **Reconcile real behavior:** one ActionDescriptor registry for toolbar/slash/API, one OpenCode conversation owner, one Rust effect owner; no alternate OAuth store, provider runner, TUI runtime or second Session database. UI events are derived, scoped and bounded.
8. **Update evidence:** record pinned SHA/paths, local modified files, exact tests, observed platform, benchmark and open gaps in §§09,10,20,23,24,27,32,35, HANDOFF. No commit/push or destructive cleanup by default. Respect P1.2-B → P1.3 before unrelated effects.

## 42.4 What can and cannot be borrowed

- **Strong candidates:** algorithms for Hashline stale-edit anchoring, Rust file discovery, guarded/browser/desktop/LSP/DAP lifecycle, model/provider/role UI presentation, typed slash icons, a nonprivileged Mermaid text renderer, bounded SVG preview, deterministic table charting and image placement budgets.
- **Never copy without redesign:** OMP unrestricted Eval/host execution, browser network interception as a supposed sandbox, provider paid fallback, source edit hash as full security authority, source-specific session ownership, unbounded event queues, TSP-only terminal behavior or arbitrary third-party plugin privileges.
- Source project MIT/Apache metadata is NOT a blanket authorization to redistribute code and dependencies. Preserve licenses and notices; OMP pi-builtins has its own license caveat (see §38).
- Claude Code public repository and public help/docs may not contain the full runtime; it remains a research reference, not a source to reconstruct proprietary internals.
- Do not promote experimental self-improvement, identity migration or automatic hidden paid model routing to V1.

## 42.5 Verified local module roots (not greenfield source paths)

Current repo contains packages/core, packages/llm, packages/opencode, packages/schema, packages/tui, packages/app, packages/server, kernel, indexd. §20 and §24 identify the local source-specific seams; §37 defines service contracts which remain PROPOSED unless verified. Do not invent new crates or assume OMP's directories exist under Horizon. Adapt at existing package boundaries.

## 42.6 Audit scope

This register covers the current primary first-party base and external research/reuse repos surfaced in Horizon's operative architecture. The many websites, release links, dependencies and repositories mentioned inside upstream/vendored docs are not automatically Horizon dependencies. [Mechanical repo file/line audit](repo-file-line-audit-manifest.json) records all Git-visible local files; byte-hash coverage is not a 1.5-million-line manual semantic implementation review.

**Offline source provenance test:** python3 scripts/architecture/validate_external_sources.py (also included in scripts/architecture/run_contract_tests.py). It verifies source pins/URLs/owner fields and handoff links; it does not fetch or compile competitor code.

## 42.7 Local ignored copies of three external reference trees

The user repository also contains these **untracked/ignored source reference trees**, separate from the production OpenCode packages: repos/cline, repos/codex and repos/deepseek-harness. They are NOT separate Horizon runtime packages and they do NOT establish their own upstream Git pin: the local copies have no Git commit identity confirmed by the source audit. Refer to the verified immutable GitHub links in §42.1 for stable code attribution; compare local file contents against the selected pinned commit before relying on them.

A second mechanical inventory [ignored-reference-source-manifest.json](ignored-reference-source-manifest.json) reads and hashes 27,271 files in these three local trees and counts 5,919,094 source/text lines (177 + 158 + 4,083 Markdown documents respectively). Reproduce using python3 scripts/architecture/audit_local_reference_copies.py --write. Generated caches, node_modules, target, dist, vendor and symlinks were excluded. This is source-data coverage, NOT semantic understanding or evidence that local code matches the pinned remote. Do not delete or rewrite these user-owned reference copies without explicit permission.

