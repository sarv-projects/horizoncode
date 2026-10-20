# 42. External source provenance and extraction register

Status: normative provenance/source-extraction reference, not runtime authority.

## 42.1 Repository pins and provenance

Use immutable commits for external source inspection. Never convert an unpublished local commit into a fabricated GitHub tree URL.

| Key | Repository | Exact reference | Horizon use/status | License/provenance gate |
|---|---|---|---|---|
| horizoncode | [sarv-projects/horizoncode](https://github.com/sarv-projects/horizoncode) | LOCAL base bf0399469470; remote main a22f810daa76; no public URL for local base | existing_source | Proprietary/see repo; local user-owned |
| opencode | [anomalyco/opencode](https://github.com/anomalyco/opencode) | [b1fe25ab5ecc](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322) | existing_source | Inspect repository and dependency licenses before copying |
| omp | [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi) | [eec114a9226d](https://github.com/can1357/oh-my-pi/tree/eec114a9226da698ebc015fd8996a8ca3bc4625c) | source_inspected | MIT top-level; pi-builtins has additional file license; verify per-path+dependencies |
| deepseek-harness | [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) | [5badb15009ae](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc) | research_reference | CHECK per-file license/dependency |
| codex | [openai/codex](https://github.com/openai/codex) | [8c0f70116741](https://github.com/openai/codex/tree/8c0f7011674145da7e10627769fb221c74fbf7a0) | research_reference | Apache-2.0 metadata; verify exact file/deps |
| cline | [cline/cline](https://github.com/cline/cline) | [c3a40572765b](https://github.com/cline/cline/tree/c3a40572765b76873c597247941118c1778d02c8) | research_reference | Apache-2.0 metadata; verify dependencies |
| grok-build | [xai-org/grok-build](https://github.com/xai-org/grok-build) | [2bdd1d6a6369](https://github.com/xai-org/grok-build/tree/2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8) | research_reference | Apache-2.0 metadata; verify dependencies |
| claude-code | [anthropics/claude-code](https://github.com/anthropics/claude-code) | [2301018b1f61](https://github.com/anthropics/claude-code/tree/2301018b1f61073c501a8e7a4813ef48c239163b) | reference_only | No source reuse assumed; inspect repo LICENSE before any copied code |
| mini-swe-agent | [SWE-agent/mini-swe-agent](https://github.com/SWE-agent/mini-swe-agent) | [04d809ceab9d](https://github.com/SWE-agent/mini-swe-agent/tree/04d809ceab9df28f9adaed044884180159172930) | research_reference | MIT metadata; verify file/deps |
| openhands | [OpenHands/OpenHands](https://github.com/OpenHands/OpenHands) | [2d174175cede](https://github.com/OpenHands/OpenHands/tree/2d174175cedeac45a0bd7c776728464d7c1140a7) | research_reference | MIT metadata; verify file/deps |
| openhands-sdk | [OpenHands/software-agent-sdk](https://github.com/OpenHands/software-agent-sdk) | [4cc058275c5a](https://github.com/OpenHands/software-agent-sdk/tree/4cc058275c5a08d845bd846576aafc80e5dd7d0d) | research_reference | MIT metadata; verify file/deps |
| openinterpreter | [openinterpreter/openinterpreter](https://github.com/openinterpreter/openinterpreter) | [ac1fcc8fe57a](https://github.com/openinterpreter/openinterpreter/tree/ac1fcc8fe57aba51fcc3c79afd57a0883237fe87) | research_reference | Verify license/file/deps |

First-party Horizon source is the live local working tree. At the 2026-10-11 audit its local base commit was bf0399469470c6ffdcbe5421dc5c506db2d61fae, which was not present on the GitHub remote; remote main was a22f810daa76f42e99a8e455af9e949bf9a4788e. Therefore the local base has no valid public GitHub tree link. Re-check both Git status and remote state before publishing provenance.

External source inspection does not authorize code copy. Review exact file license, transitive dependencies, notices, ABI/platform constraints and tests before reuse.

### V1 web-search provider contract research (2026-10-19)

This is provider-documentation research, not code extraction or runtime acceptance. The built-in no-key route candidates use only bounded search operations and remain subject to HostKernel Guard/network policy, user-visible route settings, cancellation and per-vendor limits.

| Provider route | Primary source | Contract fact used |
|---|---|---|
| Exa MCP | [Exa MCP](https://exa.ai/mcp) | Current setup says no API key is required and describes the MCP as free to use. |
| You.com free MCP | [You.com MCP server](https://you.com/docs/agents/mcp-server) | `profile=free` exposes `you-search` / `you-discover`, no key and 100 queries per day. |
| Tavily keyless search | [Tavily MCP source](https://github.com/tavily-ai/tavily-mcp) | Current MCP has keyless mode for search/extract and advertises fixed keyless access headers; paid/account features remain separate. |
| Firecrawl Keyless | [Firecrawl Keyless launch](https://www.firecrawl.dev/blog/firecrawl-keyless-launch) | Search MCP is available without an API key and free usage is capped per IP per day. |
| Parallel Search MCP | [Parallel Search MCP](https://parallel.ai/mcp) | Anonymous `web_search` MCP is free without an account/key and has a lower rate limit. |
| TinyFish | [TinyFish Search](https://www.tinyfish.ai/search) | Search is free, but the documented API path requires account/API-key or OAuth setup; it is not classified as anonymous no-key default. |

Pricing, rate limits, authentication, terms and endpoints are volatile. Release-time implementation must recheck current primary provider sources. No provider credential, paid route, live probe or third-party code is implied by this register.

## 42.2 Exact upstream extraction matrix (24 bounded source routes)

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
- Target **existing service / proposed LLD**: §37 WebSearchProviderProfileV1 proposed; SecretBroker, tool catalog. **V1 implementation source target as of the 2026-10-18 promotion (`DEC-V1-26`); §42 adaptation/license review still required before porting.**
- Reject/bound: Free/payed mismatch, provider auth/network policy, no invisible API charges.
- Proof required: offline, source provenance, cost opt-in, rate-limit, no silent fallback.

### SRC-008 — Multiplex language servers; DAP client/session debugging API

- Source: omp; status **ADOPT_DESIGN**; priority P1.
- Pinned file: [packages/coding-agent/src/lsp/mux/daemon.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/lsp/mux/daemon.ts).
- Pinned file: [packages/coding-agent/src/lsp/tool.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/lsp/tool.ts).
- Pinned file: [packages/coding-agent/src/dap/session.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/dap/session.ts).
- Pinned file: [packages/coding-agent/src/tools/debug.ts](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/tools/debug.ts).
- Extract **algorithm/logic**: multiplex language servers; DAP client/session lifecycle, adapter catalog and debug-tool flow. Pinned OMP has DAP; inspected OpenCode trees do not.
- Target **existing service / proposed LLD**: §37 LanguageServiceBrokerV1 and proposed DebugAdapterBrokerV1.
- Reject/bound: LSP rename/workspace edit and debugger Eval are guarded EFFECTS.
- Proof required: server/adapter crash and restart, multiple sessions, protocol/scope, launch/install/attach/evaluate/runInTerminal mediation and evaluate denial. OMP's top-level MIT license does not replace exact file/dependency review before copying.

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

### SRC-024 — Snapcompact transient imaging versus persistent archive compaction

- Source: omp; status **EXPERIMENT_ONLY**; priority P3. Exact repository pin and package license: §42.1.
- Pinned files: [transient imaging](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/session/snapcompact-inline.ts), [persistent compaction selection](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/coding-agent/src/session/compaction-methods.ts), [archive algorithm](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/snapcompact/src/snapcompact.ts), [native PNG renderer](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/crates/pi-natives/src/snapcompact.rs), [tests](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/snapcompact/test/snapcompact.test.ts) and [compaction contract](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/docs/compaction.md).
- Extract **algorithm/logic**: compare transient, non-mutating provider-context imaging separately from `/compact snapcompact`, which persists archive data and restores image blocks on later context builds.
- Target **existing service / proposed LLD**: future §30 `ContextService`/`ContextLedger` projection in the existing Core direct Session; no new Session owner.
- Reject/bound: **DEFERRED/UNAVAILABLE in V1**; no setting, command, capability or runtime code. Do not import OMP `AgentSession`, `@oh-my-pi/snapcompact` or the broad N-API `pi-natives` crate. No hidden provider/model fallback or archive/blob publication. No copied code; package metadata is MIT, but exact native/font license and dependency closure still require review before any port.
- Proof required before reconsideration: same selected-model task baseline; explicit image capability; image-token/count/request-byte budgeting; protected-fact and code-line fidelity; unsupported-model/render/payload-rejection recovery; persistence/rebuild/disable semantics; privacy, cost, cache impact and rollback. OMP's benchmark/test results are not Horizon evidence.

### SRC-025 — Google Vertex Gemini route with caller-owned authentication

- Source: omp; exact pin and package license in §42.1; decision **ADAPTER**; priority P2.
- Pinned files: [Vertex route](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/ai/src/providers/google-vertex.ts), [Vertex endpoint host resolver](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/catalog/src/hosts.ts), [Vertex request/host fixtures](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/ai/test/issue-1270-repro.test.ts) and [host fixtures](https://github.com/can1357/oh-my-pi/blob/eec114a9226da698ebc015fd8996a8ca3bc4625c/packages/catalog/test/hosts.test.ts).
- Target existing owner/seam: `packages/llm/src/providers` plus `packages/llm/src/protocols/gemini.ts`; §§15/20 direct provider transport.
- Adapt: Vertex project/location endpoint and host shape while reusing Horizon's Gemini protocol, Route/Endpoint, and caller-provided `Auth`; no source code copied.
- Reject/bound: Do not port `google-auth.ts` ADC file discovery, OAuth/token exchange, metadata-server access or token cache, nor `google-shared.ts` broad stream/dependency closure. No env credential/project lookup, implicit regional-to-global fallback, model catalog/discovery, or non-Gemini publisher routes. Project, location and auth are explicit caller inputs; provider/catalog/Core-session wiring is a separate gate.
- Provenance: OMP `packages/ai` and `packages/catalog` are MIT; their manifests depend on OMP utility/catalog packages, and `google-vertex.ts` also reaches `google-auth.ts` and the broad `google-shared.ts` module. This adapter reuses only the route/endpoint pattern and compatible local Gemini protocol; it adds no dependency and does not copy OMP code.
- Proof required: deterministic local fixtures for exact regional/global URL construction, bearer header from caller-owned Auth, Vertex request body and no implicit fallback; no credential-file reads or live provider calls. OMP fixtures are source evidence, not Horizon acceptance.



### SRC-026 — OS confinement backend (bubblewrap + Landlock) and process lifecycle

- Source: codex; status **REFERENCE_ONLY**; priority P1.
- Pinned file: [codex-rs/linux-sandbox/src/bwrap.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/linux-sandbox/src/bwrap.rs).
- Pinned file: [codex-rs/linux-sandbox/src/landlock.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/linux-sandbox/src/landlock.rs).
- Pinned file: [codex-rs/linux-sandbox/src/proxy_lifecycle.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/linux-sandbox/src/proxy_lifecycle.rs).
- Pinned file: [codex-rs/bwrap/src/main.rs](https://github.com/openai/codex/blob/8c0f7011674145da7e10627769fb221c74fbf7a0/codex-rs/bwrap/src/main.rs).
- Extract **algorithm/logic**: mount ordering, protected/deny path masking, namespace capability probing, WSL interop masking and proxy-lifecycle concepts.
- Target **existing service / proposed LLD**: §14.5 sandbox profile vector; implemented as `horizoncode-sandbox/` (P1-SB, 2026-10-18) for Guard/ExecutionHost consumption.
- Reject/bound: no verbatim copying; HorizonCode-owned API, capability vector and fail-closed guarantees; placement of the crate is not authority.
- Proof required: real confinement matrix + denial tests (crate suite 24/24 incl. 10 real confinement tests + capability record), ExecutionHost wiring evidence once P1-K integrates.

## 42.3 Mandatory upstream-to-Horizon implementation procedure

1. **Authority first:** read adopted §17, §§01–05, 12–14, §20, §24 and §33 before a path is mutated. HorizonCode direct Core (OpenCode-derived) owns Session/Input/Message/Part/continuation; provider transport follows A-V2-27; Rust OwnerLog/Guard owns managed Goal/Run/Task/effects/evidence. Direct Sessions do NOT require a Goal.
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

## 42.8 OMP provider and visual candidates (future A-V2-27)

Selected OMP code examined: packages/catalog/src/model-manager.ts, model-cache.ts, models.ts, pricing.ts; packages/ai/src/stream.ts, auth/select.ts, auth/cascade.ts, providers/inference-headers.ts; packages/coding-agent/src/config/model-registry.ts, model-resolver.ts; packages/tui/src/chat/figure-markdown.ts, svg-figure.ts, table-chart.ts, charts/chart-plan.ts, overlays/model-hub.ts; packages/coding-agent/src/tools/browser/tab-supervisor.ts and tools/computer/supervisor.ts.
Adopt selectively: provider/model/auth/pricing and bounded visual UX. Reject duplication of OMP AgentSession, tool policy, host permissions or worktree authority. The registered immutable OMP commit remains the implementation pin until formally updated. This list is a bounded source review, not proof that every upstream file was read; code ports require full dependency/license/compatibility review. Native OpenCode backend uses official documented SDK/server APIs and cannot promise third-party promotional free model entitlement.

## 42.9 JCode resource/runtime adoption source ledger — 2026-10-15

**Pinned research:** `1jehuang/jcode@1f612a7` (user-supplied `jcode-godmap.zip`: derived source map of 157 readable Markdown files, not complete function bodies). HorizonCode observation: `sarv-projects/horizoncode@4e2086633d006f7d8b7709cb0df622f77a9b8d54` plus live `main` must be rechecked before implementation. External source code is **not** vendored by this documentation update. Licensing/attribution must be inspected before copying implementation.

| Evidence | Source pinned at JCode snapshot | What is verified / caveat |
|---|---|---|
| Process topology and RAM benchmark | [README](https://github.com/1jehuang/jcode/blob/1f612a7/README.md), [bench_headless_memory.py](https://github.com/1jehuang/jcode/blob/1f612a7/scripts/bench_headless_memory.py) | Published Linux PSS, shared daemon and process-tree methodology; **not independently reproduced for Horizon**; configuration/embeddings alter totals |
| Per-process resource accounting | [process_memory.rs](https://github.com/1jehuang/jcode/blob/1f612a7/crates/jcode-base/src/process_memory.rs) | Linux smaps/proc RSS/threads/allocator diagnostics; portability unverified |
| Allocator experiments | [src/main.rs](https://github.com/1jehuang/jcode/blob/1f612a7/src/main.rs) | glibc `mallopt`/jemalloc configuration exists; benchmark-and-gate before reuse |
| Cache regression budget | [MEMORY_BUDGET.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/MEMORY_BUDGET.md) | Specific Markdown/Mermaid cache entry/disk caps; JCode limits **not automatically Horizon caps** |
| Cancellation race | [jcode-agent-runtime](https://github.com/1jehuang/jcode/blob/1f612a7/crates/jcode-agent-runtime/src/lib.rs) | Atomic epoch + async notify signalling; compare to Rust cancellation registry before adopting |
| Cross-session file touches | [file_touch_service.rs](https://github.com/1jehuang/jcode/blob/1f612a7/crates/jcode-app-core/src/server/file_touch_service.rs) | Advisory forward/reverse read/write indexes; not a universal Guard |
| Adaptive redraw | [redraw_schedule.rs](https://github.com/1jehuang/jcode/blob/1f612a7/crates/jcode-tui/src/tui/redraw_schedule.rs) | Idle/deep-idle pacing and full repaint reason attribution |
| Bounded inline tail | [inline_tail.rs](https://github.com/1jehuang/jcode/blob/1f612a7/crates/jcode-app-core/src/agent/inline_tail.rs) | Live/committed text and in-place tool marker update with fixed budgets |
| Provider Doctor | [PROVIDER_DOCTOR.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/PROVIDER_DOCTOR.md) | Offline/catalog/full tiers, cost transparency and live tool-call tests |
| Memory/recall | [MEMORY_ARCHITECTURE.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/MEMORY_ARCHITECTURE.md) | Bounded relevance selection/Jev path; Godmap also contains embedding references from other paths; no mandatory remote memory dependency |
| DAG swarms | [SWARM_TASK_GRAPH.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/SWARM_TASK_GRAPH.md) | Explicitly **Being implemented**; not proof all algorithms run in production |
| Multisurface TUI | [MULTI_SESSION_CLIENT_ARCHITECTURE.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/MULTI_SESSION_CLIENT_ARCHITECTURE.md) | **Proposed** document, not shipped behaviour proof |
| Modular extraction | [MODULAR_ARCHITECTURE_RFC.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/MODULAR_ARCHITECTURE_RFC.md) | **Draft**, avoid replicating large-crate refactor debt |
| Safety/ambient ideas | [SAFETY_SYSTEM.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/SAFETY_SYSTEM.md) | **Design**; shell heuristics are not universal pre-dispatch mediation |
| External resume | [RESUME_BEHAVIOR.md](https://github.com/1jehuang/jcode/blob/1f612a7/docs/RESUME_BEHAVIOR.md) | Documented UX with current/new terminal and import modes; test current code before assuming full compatibility |

**Adoption method:** `REUSE EXISTING` / `ADAPT ALGORITHM` / `SERVICE ADAPTER` / `REJECT`; verify upstream license and exact commit/function/tests, preserve canonical Horizon owners and contract IDs, then execute §32 negative/restart/security/real-work acceptance. The acceptance decision A-V2-30 is in §17.10. Never publish the above external RAM figures as Horizon measurements.

## 42.10 JCode adoption coverage crosswalk — 24 candidates, no omissions

Research/provenance register only. “Accepted” means a Horizon feature/optimization is captured with an owner and actionable tests, **not** implemented. JCode's `Proposed/Being implemented/Draft/Design` labels remain source-status labels; confirm direct source and license before transplanting. Concrete runtime status is `HANDOFF.md`.

| # | Candidate | Horizon topic owner / execution | Evidence anchor |
|---|---|---|---|
| 01 | Shared Rust daemon / multi-Session virtual ownership | §01/§13; RC1 | JC-RES-001/008/009 |
| 02 | Reproducible RAM/PSS benchmark | §18; RC0 | JC-RES-001/002/004 |
| 03 | Deep process/allocator attribution | §18/§37; RC0 | JC-RES-003/006 |
| 04 | Cache size/TTL and large-output budgets | §30/§31; RC3 | JC-RES-005 |
| 05 | Provider Doctor (offline/catalog/full) | §15/§33/§37; RC3 | JC-RES-013/014/015 |
| 06 | Session-path file-touch tracking | §21; RC2 | JC-RES-011 |
| 07 | Adaptive TUI redraw/paint reasons | §31; RC4 | JC-RES-016 |
| 08 | Bounded live inline tool-tail | §31; RC4 | JC-RES-017 |
| 09 | Cancellation epoch/async notification | §11/§14; RC1/2 | JC-RES-009/010 |
| 10 | Low-RAM headless worker pool | §21/§29; RC2 | JC-RES-007/012 |
| 11 | Provider prewarm/cache diagnostics | §15/§30; RC3 | JC-RES-015 |
| 12 | Managed task DAG, typed artifacts, critique | §15/§29; RC2 | JC-RES-018 |
| 13 | Active input steering, Shift+Enter/tmux | §16/§31; RC5 | JC-RES-016 + existing UI/runner tests |
| 14 | External Session import/resume | §15/§33; RC3 | JC-RES-019 |
| 15 | Multi-client protocol and SDK | §13/§16; RC5 | session reconnect/auth matrix |
| 16 | Additional provider catalog/auth compatibility | §20/§33; RC5 | provider doctor/identity fixtures |
| 17 | Tool intent and controlled large output | §14/§33; RC5 | ToolBatch/size/auth and JC-RES-005 |
| 18 | Optional local project memory/recall | §30; RC3 | JC-RES-020 |
| 19 | Compile-time dependency isolation | §18/§20; RC5 | incremental build size/time samples |
| 20 | Multi-session activity map | §16/§31; RC5 | multi-client UI/scroll/focus tests |
| 21 | User-visible interactive/perf demo | §16/§31/§32; RC5 | real captured UX/pass evidence |
| 22 | Offline-first local telemetry | §18/§31; RC0/4 | JC-RES-001/006 + privacy cases |
| 23 | Developer self-dev/hot-swap canary | §17 A-V2-29/§18; RC5 | opt-in rollback/epoch/secret tests |
| 24 | Thin authenticated mobile/remote client | §13/§16; RC5 | remote auth/reconnect/feature-parity tests |

Never interpret coverage as a blanket all-features release claim, and never solve a missing implementation by adding a new Session/Task/Guard owner.

## 42.11 P3 RepoIntel source-intake decision — 2026-10-19

| Source / exact local target | Decision | P3 application |
|---|---|---|
| Pinned OpenCode-derived `packages/opencode/src/tool/repo-intel.ts`, `repo-tools.ts`, plus existing `indexd/src/{lib.rs,repo_intel.rs,transport.rs,handler.rs}` | **REUSE EXISTING / ADAPT** | Keep the one bounded lexical generation, exact overlay, cursor and typed-unavailable path. Extend its canonical schema and provenance; no second index or scanner. Production query remains unavailable until HostKernel supplies authenticated principal/Session/Location/workspace/read-scope context. |
| OMP `crates/pi-walker/src/lib.rs`, `crates/pi-natives/src/grep.rs`, `ast.rs` at §42.1 `eec114a9226d` (SRC-004) | **ADAPT ALGORITHM; REJECT CODE/DEPENDENCIES for this phase** | Retain only behavior-level ideas: bounded deterministic traversal, cancellation, path/ignore policy and explicit scan coverage. `grep.rs` is N-API-bound and reaches the broad `pi-natives`/`pi-builtins`/`pi-vfs` graph; `ast.rs` reaches ast-grep/`pi_ast`; the walker reaches `pi-vfs`, `globset` and cache policy. These dependencies and their platform/Guard integration are outside the existing `indexd` surface. No OMP code or new dependency is added. |
| Pinned Codex `codex-rs/core/src/tools` search/tool routing and `codex-rs/core/src/tools/runtimes` process boundaries at §42.1 `8c0f70116741` | **REFERENCE ONLY** | The inspected surface informs explicit tool dispatch and keeping process-backed search behind the execution boundary; it supplies no compatible in-process generation/page index to transplant. No Codex source or process-based search adapter is added. |

The P3 transport query/page contract is `contracts-v2/repo-intelligence-query-v1.schema.json`, mirrored by `packages/schema/src/repo-intelligence-v1.ts` and the shared `contracts-v2/fixtures/repo-structure-page-v1.json`. Principal, Session, Location, workspace root, PermissionV2 read scope and policy remain authenticated HostKernel metadata, never request-body authority. Any opaque continuation cursor must be minted/validated by HostKernel against that authenticated scope, source generation, query digest and expiry. Node refs are read evidence only; writes must re-resolve the source digest and pass the canonical `files.patch` + Guard path.

## 42.12 OpenCode/Codex V1 source crosswalk — 2026-10-19

This is a source-reuse decision record, not implementation or acceptance evidence. The local OpenCode snapshot has 6,569 files / 769 directories (138 MiB); the local Codex copy has 9,029 files / 976 directories (112 MiB). OpenCode attribution uses the pin in §42.1. The Codex copy has no local `.git` identity; use the §42.1 immutable pin `8c0f7011674145da7e10627769fb221c74fbf7a0` and compare selected blobs to that pin before copying. Both source roots have MIT top-level licenses (`opencode/LICENSE`, `repos/codex/LICENSE`); check subcrate notices, generated files, and transitive dependency terms for any actual extraction. This bounded audit inventoried each tree and inspected the phase-relevant modules listed below; it does not claim a line-by-line semantic review of every unrelated file in either repository.

| Horizon V1 area | Inspected source and observed mechanism | Decision for HorizonCode | Boundary / work still owned here |
|---|---|---|---|
| P0 direct session and tool loop | OpenCode `packages/core/src/session.ts`, `session/runner/llm.ts`, `tool/registry.ts` (preserved in the tracked source lineage); provider response/tool-call processing remains its session owner. | **PRESERVE EXISTING** | Keep Core as the sole direct Session/continuation owner. Do not import Codex rollout/session ownership or make Rust a transcript store. |
| P1 effects and confinement | Codex `core/src/tools/runtimes/unified_exec.rs`, `core/src/tools/runtimes/unified_exec/launch.rs`, `linux-sandbox/src/{linux_run_main,bwrap,landlock}.rs`; OpenCode `tool/shell.ts`, `tool/write.ts`, `tool/apply_patch.ts`, `session/tool-batch.ts`. Codex prepares a sandbox command from a permission profile and launches through its own exec runtime; OpenCode supplies the useful model-facing tool and complete-response boundaries. | **ADAPT ALGORITHM / PRESERVE Horizon runtime** | The existing Horizon `horizoncode-sandbox` and Rust HostKernel/ExecutionHost remain authoritative. Reuse Codex containment mechanics only where the Horizon backend lacks equivalent behavior; do not copy its shell executor or permission authority. Prove every dispatched product effect is confined and Guarded before enabling it. |
| P2 direct and managed delegation | OpenCode `packages/opencode/src/tool/task.ts`, `agent/agent.ts`, `agent/subagent-permissions.ts`; Codex `core/src/agent/control/{spawn,runtime,registry,execution,mailbox,completion,resume,interrupt}.rs`, `core/src/agent/child_config.rs`, and `core/src/tools/handlers/multi_agents_v2/{spawn,message_tool,send_message,followup_task,wait,interrupt_agent,list_agents}.rs`. Codex uses one root-owned agent-tree runtime, lineage paths, spawn-slot reservations, depth/capacity controls, child config snapshots, mailbox communication, resume ownership checks, and explicit lifecycle tools/events. OpenCode supplies Task-profile resolution, parent deny/external-directory propagation, foreground/background completion and cancellation. | **ADAPT lifecycle patterns; REUSE OpenCode Task seam** | Do not adopt Codex/OpenCode as managed authority. Rust still admits and settles Task/Attempt/effect receipts; bind child identity, profile revision, scope, budget and workspace to that authority. OpenCode and Codex child text/status never proves completion. Preserve single-Task V1 until independent final-revision verification passes. |
| P3 RepoIntel and editing | OpenCode tool modules for search, patch, Git and filesystem; Codex `core/src/tools/handlers/tool_search.rs`, `unified_exec.rs`, `apply_patch.rs`; the P3 decision is already recorded in §42.11. | **ADAPT bounded algorithms; REJECT a second index** | Keep indexd/RepoIntel as the one generation owner. Existing results remain read evidence; source freshness and every mutation continue through the authenticated Horizon read grant and Guarded patch path. |
| P4 LSP, DAP, REPL | Pinned OpenCode `packages/opencode/src/lsp/{server,client,launch}.ts` and `tool/lsp.ts` are the reusable language-server catalog, JSON-RPC lifecycle and diagnostics seam. The inspected Codex core tools did not expose a DAP or persistent REPL implementation suitable for this boundary. | **ADAPT OpenCode LSP; no Codex port identified** | Preserve Horizon LSP/DAP/REPL broker IDs and authenticated lifecycle. Any install, process start, code action/rename, attach/evaluate or callback remains unavailable until P1 Guard, executable resolution and OS confinement are verified. No equivalent Codex DAP/REPL feature is inferred from generic exec. |
| P5 built-in web search | OpenCode `packages/opencode/src/tool/websearch.ts` chooses one of Exa/Parallel by flags, override, or session checksum and asks for the ordinary websearch permission. Codex `ext/web-search/src/{tool,schema,history,output}.rs` sends a single request to Codex's selected hosted API, bounds prior conversation context, emits begin/end events, and omits raw output from logs. | **REJECT both provider-selection strategies; ADAPT bounded output/event ideas** | Neither source is the approved built-in plus user-enabled ordered cascade. Keep route consent, explicit auth/cost/provenance, per-route failure/cooldown, one bounded retry, and no silent paid upgrade under §§16/37.5/32. Use existing Guarded outbound transport and SecretBroker. |
| P6 providers, settings, Doctor and S1 | OpenCode `provider/provider.ts`, `provider/auth.ts`, `core/src/models-dev.ts`, config/provider and TUI provider/model dialogs; Codex `model-provider`, `model-provider-info`, `models-manager`, `keyring-store`, and Doctor modules. | **ADAPT metadata, status and UX patterns; REUSE existing canonical integrations** | No second provider registry, credential store, account rotation, or fallback loop. Keep provider/model pinning and SecretBroker; unknown cost/auth/capability remains unknown. The inspected Codex Doctor is a host diagnostic reference, not Horizon Provider Doctor evidence. |
| P7 streaming, rendering and artifacts | OpenCode `packages/session-ui/src/components/{markdown-stream,markdown-worker-queue,markdown-projection,session-turn}.ts*`, its v2 stream/session UI, and the existing TUI renderers; Codex `tui/src/multi_agents.rs` and `core/src/agent/control/{completion,delivery}.rs` for lifecycle event projection. | **REUSE/adapt UI algorithms and event projection** | Retain Horizon event generation/ordinal, source-generation replay fences, redaction and artifact fidelity owners. Do not copy a separate transcript, event authority, or analytics truth. Codex subagent activity is a useful presentation pattern, not durable managed evidence. |
| P8 bounded workers, resources and worktrees | Codex `core/src/agent/registry.rs`, `agent/control/{execution,runtime,spawn_guard}.rs`, `agent-graph-store`, `worktree`; OpenCode `packages/opencode/src/worktree/index.ts` and worktree tests. | **ADAPT reservations, lineage and recovery patterns** | Keep one Rust reservation/worker/worktree owner with Horizon lease, budget, dirty-state, user-edit and UNKNOWN semantics. Never adopt unbounded fan-out or Codex process-local state as durable authorization. Worker fan-out remains gated on P1 and P2 evidence. |
| P9 CLI/TUI packaging and release | OpenCode `packages/opencode/src/installation`, `cli/upgrade.ts`, `cli/cmd/{run,upgrade}.ts`; Codex `cli/src/{main,daemon_install,doctor,sandbox_setup}.rs` and `app-server-daemon/src/managed_install.rs`. | **ADAPT install/diagnostic patterns; preserve Horizon identity** | Ship only the Linux/WSL-first Horizon CLI/TUI surface. No updater/signing/publication claim without Horizon's own license, clean-install, rollback and final-gate evidence. Keep `horizoncode` and `hzcode` as the same entrypoint. |

The source scan found useful mechanisms but no upstream implementation that can replace the Horizon managed Attempt, Guard, effect leases/receipts, final-revision verifier, canonical capability registry, or direct Core Session. No source was copied or ported by this audit. The current local Horizon edits remain subject to the implementation and verification statuses in `HANDOFF.md`; the crosswalk itself does not move any status forward.

### Subagent lifecycle source review — 2026-10-19

The local source review of OpenCode `packages/opencode/src/tool/task.ts` confirms its direct
Task path resolves the selected profile, asks parent permission, derives child permissions,
creates a linked Core Session, inherits the current-turn model unless the profile overrides
it, supports foreground/background work, returns bounded final text and cancels owned child
work on abort. This is useful for Horizon's **direct-session** Task seam; it does not provide
the managed Attempt, durable effect receipts or final-revision verification Horizon requires.

The Codex source review of `core/src/agent/control/{spawn,runtime,mailbox,completion,
resume,residency}.rs`, `core/src/agent/registry.rs`, `core/src/agent/child_config.rs`, and
`core/src/tools/handlers/multi_agents_v2/{spawn,message_tool,followup_task,wait,
interrupt_agent,list_agents}.rs` confirms a root-scoped runtime with spawn reservations,
depth/capacity checks, lineage paths, inherited parent runtime policy, role/model layering,
owner-checked resume, queue-only mail, explicit send-vs-follow-up wake behavior, bounded
wait, interrupt, terminal-result delivery and residency eviction/reload. This is a lifecycle
reference, not a replacement for Horizon's owners; Codex's process-local mailbox/residency
and execution-policy model are not Horizon durable authority.

**Architecture reconciliation:** the previous generic §3.5 description implied every
subagent required a managed Task. That contradicted §3.2 (direct work needs no Goal) and
§29.18 (direct-session delegation without a managed Run). §§3.5, 29.5, 37.9 and 45.8 now
separate direct Core Session delegation from managed Task/Attempt delegation, while keeping
shared profile/resource bounds and Guarded effects. Core owns direct Session linkage and
message/turn delivery; Rust owns its resource/effect facts. Rust owns managed Task/Attempt
lineage and settlement. The user resolved the machine-contract question on 2026-10-19:
use one lane-tagged `SubagentDeliveryV1`. The direct lane binds Core parent/child Session
identity and trusted profile/permission scope; the managed lane binds `DelegationBindingV1`
and exact Goal/Run/Task/Attempt identity. The schema and owner contracts now define
`authorityDigest` as domain-separated BLAKE3 over canonical MessagePack of the lane,
parent/child execution IDs, owner epoch and validated lane claims. Schema
presence is design/code only; strict Rust/TypeScript validation and golden cross-language
fixtures remain required before wire enablement.
