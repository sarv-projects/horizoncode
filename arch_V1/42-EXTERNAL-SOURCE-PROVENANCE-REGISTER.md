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

This is provider-documentation research, not code extraction or runtime acceptance. The V1
route plan has a built-in anonymous/no-key cascade (Exa, You.com free, Firecrawl Keyless,
Parallel in §37.5 order); authenticated providers are optional routes and participate only
when explicitly enabled/configured. All
routes use bounded operations and remain subject to HostKernel Guard/network policy,
cancellation and per-vendor limits.

| Provider route | Primary source | Contract fact used |
|---|---|---|
| Exa MCP | [Exa MCP](https://exa.ai/mcp) | Current setup says no API key is required and describes the MCP as free to use. |
| You.com free MCP | [You.com MCP server](https://you.com/docs/agents/mcp-server) | `profile=free` exposes `you-search` / `you-discover`, no key and 100 queries per day. |
| Tavily hosted MCP | [Tavily MCP source](https://github.com/tavily-ai/tavily-mcp) | Hosted MCP documents API-key or OAuth authentication backed by a Tavily account; this is an authenticated optional route, never part of the anonymous default. |
| Firecrawl Keyless | [Firecrawl Keyless launch](https://www.firecrawl.dev/blog/firecrawl-keyless-launch) | Search MCP is available without an API key and free usage is capped per IP per day. |
| Parallel Search MCP | [Parallel Search MCP](https://parallel.ai/mcp) | Anonymous `web_search` MCP is free without an account/key and has a lower rate limit. |
| TinyFish | [TinyFish Search](https://www.tinyfish.ai/search) | Search is free, but the documented API path requires account/API-key or OAuth setup; it is not classified as anonymous no-key default. |
| Brave Search API | [Brave Search API](https://brave.com/search/api/) | Fixed web-search API route; account credential and current price/limits must be verified at release. |
| Exa Search API | [Exa Search API](https://docs.exa.ai/reference/search) | Fixed search endpoint and request/response contract; account credential and current price/limits must be verified at release. |
| You.com Search API | [You.com Search API](https://you.com/docs/api-reference/search/v1-search) | `POST https://ydc-index.io/v1/search`, `X-API-Key`, bounded `count`, results are in `results.web`. |
| Tavily Search API | [Tavily Search API](https://docs.tavily.com/documentation/api-reference/endpoint/search) | `POST https://api.tavily.com/search`, bearer credential, `query` and `max_results`; basic mode is fixed by the adapter. |
| Firecrawl Search API | [Firecrawl Search API](https://docs.firecrawl.dev/api-reference/endpoint/search) | `POST https://api.firecrawl.dev/v2/search`, bearer credential, web source and bounded `limit`; results are in `data.web`. |
| Parallel Search API | [Parallel Search API](https://docs.parallel.ai/api-reference/search/search) | `POST https://api.parallel.ai/v1/search`, `x-api-key`, objective plus search queries and bounded aggregate excerpt characters. |
| OpenCode V2 Websearch | [OpenCode V2 Websearch docs](https://opencode.ai/v2/docs/websearch/) | Reference behavior documents user provider selection, sticky session choice, random choice with 429-only failover/cooldown, and a websearch permission. Horizon rejects its single/random selection as authority; only its user-visible consent, explicit route selection, and cooldown presentation are adapted to §37.5's ordered route cascade. |

Pricing, rate limits, authentication, terms and endpoints are volatile. Release-time implementation must recheck current primary provider sources. No provider credential, paid route, live probe or third-party code is implied by this register.

#### P5 fixed route profile for HostKernel (source contract, not runtime enablement)

Core supplies only a bounded `query` (≤2,000 characters) and `limit` (1–10) to a
statically selected route. It never supplies a URL, method, headers, provider-native
body, or credential material. The authenticated Guard/HostKernel route profile owns
the endpoint and provider-specific wire translation; BYO credentials remain opaque
SecretBroker refs. HTTP responses are capped at 2 MiB and each attempt at 12 seconds
by default / 30 seconds maximum. `Retry-After` is reduced to bounded milliseconds;
provider bodies and raw error text are not included in attempt provenance.

| Route key / `provider_id` | Fixed host + path | Wire / provider payload | Result shape |
|---|---|---|---|
| `exa_keyless` | `mcp.exa.ai/mcp` | MCP Streamable HTTP POST; initialize then `tools/call` `web_search_exa` with query, `numResults`, bounded text | MCP structured content / JSON text containing Exa result rows |
| `youcom_free` | `api.you.com/mcp?profile=free` | MCP Streamable HTTP POST; `tools/call` `you-search` with query, count, moderate safe search | MCP wrapper around `{results:{web:[...]}}` |
| `firecrawl_keyless` | `mcp.firecrawl.dev/v2/mcp` | MCP Streamable HTTP POST; `tools/call` `firecrawl_search` with query, limit, web source | MCP wrapper around `data.web[]` |
| `parallel_keyless` | `search.parallel.ai/mcp` | MCP Streamable HTTP POST; `tools/call` `web_search` with query and `max_results` | MCP wrapper around `results[]` |
| `brave` | `api.search.brave.com/res/v1/web/search` | HTTPS GET; `q`, `count`, moderate safe search; SecretBroker API credential | `web.results[]` |
| `exa` | `api.exa.ai/search` | HTTPS POST JSON `{query,numResults,contents:{text:{maxCharacters:1200}}}`; SecretBroker API credential | `results[]` |
| `youcom` | `ydc-index.io/v1/search` | HTTPS POST JSON `{query,count}`; SecretBroker API credential | `results.web[]` |
| `tavily` | `api.tavily.com/search` | HTTPS POST JSON `{query,search_depth:"basic",max_results,include_answer:false,include_raw_content:false}`; SecretBroker bearer credential | `results[]` |
| `firecrawl` | `api.firecrawl.dev/v2/search` | HTTPS POST JSON `{query,limit,sources:["web"],safe:true,highlights:true}`; SecretBroker bearer credential | `data.web[]` |
| `parallel` | `api.parallel.ai/v1/search` | HTTPS POST JSON `{objective,search_queries:[query],mode:"fast",max_chars_total:12000}`; SecretBroker API credential | `results[]` |

Static `route_id` is `web.search.<route-key>` for each row, so keyless and BYO
variants remain distinct. Current Horizon source has a bounded fixed-route keyless MCP
dispatcher, aggregate Guard intent/receipt and UNKNOWN recovery, exposed only after the
optional `execution.v1.web-search-cascade` plus `effects.v2` handshake. Anonymous and BYO
runtime readiness have separate gates (`WEB_SEARCH_ANONYMOUS_RUNTIME_READY` and
`WEB_SEARCH_BYO_RUNTIME_READY`); both remain false until their respective integrated P1
acceptance, with BYO additionally requiring P6's authenticated fixed transport. Source
presence does not mean a supported route is runnable. BYO routes have metadata-only
SecretBroker references in Core, but remain unavailable pending P1 one-use consumption and
authenticated fixed HTTP transport; Brave GET is not implemented. This table records official
source-derived candidates and payload bounds, not proof of current provider availability or
authorization.

P5's `WebSearchRuntime` production boundary accepts only the trusted HostKernel capability:
fixed supported route keys, canonical query/limit dispatch, cancellation signal, opaque
SecretBroker references, protected session/message/call identity plus the Guard-issued
EffectChallenge, and a trusted workspace identity. HostKernel binds these facts to the
authenticated Core peer and resolves Attempt/principal, approval, effect lease, fixed route
policy, durable receipt and UNKNOWN recovery; callers provide no Attempt ID or principal.
It provides no caller endpoint, method, headers or provider-native request payload. The
default application layer denies dispatch; the release gate remains false until the P1/P6
integration and acceptance evidence land. Failed/exhausted cascades include bounded sanitized
per-route status/retry details. It never selects a hidden paid or grounded-model fallback.

The Core ToolBatch prepare hook projects the exact enabled route order and fixed retry count
from trusted settings and fixed route adapters, plus opaque BYO SecretBroker references, into
the Guard-hashed effect arguments before admission. The executor uses that prepared projection
verbatim. SecretBroker lookup failure omits BYO routes without blocking eligible keyless routes.
The route list is not execution authority: the production gate remains false until integrated
P1 acceptance, and BYO remains unavailable until one-use SecretBroker transport is complete.

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

### SRC-027 — OpenCode provider layer consumed as a standalone SDK (provider list, auth and connection recipes)

- Source: opencode; status **PRESERVE_EXISTING + ADAPT (hardened boundaries)**; priority P6/P0.
- User directive 2026-10-23: the provider list, credential storage, login/OAuth/device and API-key
  flows, environment-source recipes, endpoint/header handling and bundled adapters come from this
  layer. OMP pi-ai/pi-catalog is the registered alternative (SRC-016), not a second live source.
- Pinned file: [packages/opencode/src/provider/provider.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/provider/provider.ts).
- Pinned file: [packages/opencode/src/provider/transform.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/provider/transform.ts).
- Pinned file: [packages/opencode/src/auth/index.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/opencode/src/auth/index.ts).
- Pinned file: [packages/core/src/models-dev.ts](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/core/src/models-dev.ts).
- Extract **source and wiring**: provider registry/bundled adapters, display identities (`opencode`,
  `opencode-go`), defaults, auth flows, connection recipes and metadata merge. Preserve Horizon
  hardening: Guard/SecretBroker leases, exact route projection, bounded transport, fail-closed
  credential rejection and UNKNOWN/no-replay semantics.
- Local map: §20.16; `packages/opencode/src/provider/UPSTREAM.md`.
- Update candidate (observed 2026-10-23; awaiting §20.16.3 adoption): dev head `43868389223f3553c6786c2f1cfa70a657f8a8bf` fetched
  2026-10-23. The pinned revision above stays authoritative until the §20.16.3 procedure is executed
  and the focused provider/auth/models-dev suites plus P6-PROVIDER-001..004 pass on the exact diff.

### SRC-028 — Models.dev advisory metadata source

- Source: models.dev metadata published for the OpenCode provider ecosystem; status
  **REFERENCE_ONLY (runtime metadata, not source code)**; priority P6.
- Runtime endpoint: `https://models.opencode.ai` → `/api.json` (already the `DEFAULT_SOURCE` in
  `packages/core/src/models-dev.ts`). Project: [models.dev](https://models.dev), MIT.
- Use: advisory model metadata only — ids, names, modalities, limits, status, costs, consumption and
  provider request hints. Never route authority, never proof of endpoint health or free entitlement.
- Provenance: each snapshot records source URL, retrieval time, SHA-256 digest and MIT attribution in
  the existing sidecar. Startup attempts one bounded refresh; stale/offline falls back to the last
  known-good cache and shows freshness rather than silently treating it as current.
- Reject/bound: no second metadata source, no hidden paid catalog, no metadata-driven model switch,
  no credential material in the snapshot. Acceptance: P6-PROVIDER-003/004.

### SRC-029 — Session export/import (P3-11) transfer seam

- Source: opencode; status **REUSE + ADAPTER**; priority P7 (transfer seam) with P6 command surface.
- License: MIT top-level, `Copyright (c) 2025 opencode`.
- **Revision caveat (recorded honestly):** these paths are **absent** at the primary pin
  `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`. They exist at the fetched update candidate
  `43868389223f3553c6786c2f1cfa70a657f8a8bf` (2026-10-23), which was inspected read-only. Do not
  attribute them to the primary pin; before copying any code, follow §42.3 with the exact candidate
  file hashes and re-verify each callee at that same revision.
- Candidate files at `4386838`:
  `packages/core/src/session/transfer.ts` (export/import `Interface`, `ImportConflictError` 409,
  `sanitize` family, `isSettled`, `makeGlobalNode(deps:[App,Bus,Database,Project,Session])`) and
  `packages/schema/src/session-transfer.ts` (`SessionTransfer.Data = Session.Info + messages`).
- Extract: transfer/sanitize algorithm, digest-bound two-phase preview→commit, 409-on-existing
  conflict, own-JSON-only import. Local callees (Core Session store, project, bus, database) exist as
  Horizon owners.
- Reject/bound: **no URL/HTTP import** in V1 start; extend sanitizer to `horizonPrincipalOwner`,
  provider/auth material and token-bearing tool output; no credential copy; no second Session writer
  or merge — import creates a new Session through the existing create path; one owner per Session.
- Local mapping and take-map: `repo_take/NOTES.md` §5; `reports/phases/P7.md` continuation 5.
  Acceptance: §30.30 REL-N / §46 P3-11 rows. Command/ActionDescriptor surface stays P6-owned.

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

**P3 integration and cache-owner boundary (2026-10-20):** The OpenCode symbols/reference/definitions adapters call Core `SessionSupervisor.queryRepoStructure`, whose producer performs authenticated `ensure_generation` followed by `query_structure`; no caller supplies `sourceGeneration`, and HostKernel retains the immutable generation `Arc` behind its expiring authenticated RepoGenerationLease. The Core RPC carries bounded query/page data only, not workspace snapshots. HostKernel bounds retention to 64 lease generations / 64 MiB observed source bytes and drops retained generations on expiry, stale source/policy, or epoch teardown; these bounds do not measure index heap allocation. HostKernel now mints an authenticated P8 cache observation from the exact live RepoRead lease and retained generation, using the parser-set pin as `build_version`, source-byte accounting only, and unknown allocation/entry counts. Exact generation removal invalidates the matching registry row and linked cursor lease; P8 eviction composition revalidates the exact candidate and zero live `Arc` pins before dropping the retained generation and acknowledging retirement. `reclaimedBytes` remains unknown without physical measurement. The composition source is not runtime-enabled because no authenticated policy/pressure trigger currently calls it; P3 must not synthesize pressure or invoke eviction. The legacy in-process RepoIntel LRU is unavailable as a product default and is not the HostKernel generation owner; no second registry is introduced. Parser-backed nodes remain typed UNAVAILABLE because the OMP parser/walker dependency intake is explicitly rejected above and the pinned OpenCode tree-sitter integration is shell parsing/syntax highlighting, not RepoIntel semantic indexing. Overlay reads remain unavailable because no Core-owned immutable unsaved-buffer snapshot producer exists. These are source boundaries, not phase acceptance evidence.

## 42.12 OpenCode/Codex V1 source crosswalk — 2026-10-19

This is a source-reuse decision record, not implementation or acceptance evidence. The local OpenCode snapshot has 6,569 files / 769 directories (138 MiB); the ignored repository-local Codex snapshot has 9,029 files / 976 directories (112 MiB). OpenCode attribution uses the pin in §42.1. The Codex copy has no local `.git` identity, so the stated §42.1 pin `8c0f7011674145da7e10627769fb221c74fbf7a0` has not been verified against these files; compare selected blobs to that pin before any copying. Both source roots have MIT top-level licenses (`opencode/LICENSE`, `repos/codex/LICENSE`); check subcrate notices, generated files, and transitive dependency terms for any actual extraction. This bounded audit inventoried each tree and inspected the phase-relevant modules listed below; it does not claim a line-by-line semantic review of every unrelated file in either repository.

| Horizon V1 area | Inspected source and observed mechanism | Decision for HorizonCode | Boundary / work still owned here |
|---|---|---|---|
| P0 direct session and tool loop | OpenCode `packages/core/src/session.ts`, `session/runner/llm.ts`, `tool/registry.ts` (preserved in the tracked source lineage); provider response/tool-call processing remains its session owner. | **PRESERVE EXISTING** | Keep Core as the sole direct Session/continuation owner. Do not import Codex rollout/session ownership or make Rust a transcript store. |
| P1 effects and confinement | Codex `core/src/tools/runtimes/unified_exec.rs`, `core/src/tools/runtimes/unified_exec/launch.rs`, `linux-sandbox/src/{linux_run_main,bwrap,landlock}.rs`; OpenCode `tool/shell.ts`, `tool/write.ts`, `tool/apply_patch.ts`, `session/tool-batch.ts`; Codex `core/src/exec.rs`; OpenCode `packages/core/src/session/supervisor.ts`. Codex's exec cancellation calls `start_kill()` on its owned child; OpenCode's supervisor calls `child.kill()` from its lifecycle/finalizer. These are useful in-process cancellation patterns, but neither establishes durable process-tree quiescence after an abrupt supervisor loss. | **ADAPT ALGORITHM / PRESERVE Horizon runtime** | Keep the existing Horizon `horizoncode-sandbox` and Rust HostKernel/ExecutionHost authoritative; do not copy either upstream shell executor or permission authority. Horizon's Linux Guarded stdio path requires the enforced ProcessTree guarantee, selecting bubblewrap with a fresh PID namespace, `--die-with-parent`, and now a direct-child `PR_SET_PDEATHSIG` plus parent-PID race check. The parent-death signal and PID-namespace lifetime are the OS-owned crash fence; explicit cancellation, observed exit, durable receipt and UNKNOWN reconciliation remain HostKernel responsibilities. Landlock-only and unsupported platforms do not satisfy ProcessTree and remain unavailable. Keep verifier/editor routes gated until the integrated lifecycle and acceptance evidence proves the contract. |
| P2 direct and managed delegation | Re-read OpenCode subagent lifecycle under `repo_take/opencode/packages/core/src/` (`tool/plugin/subagent.ts`, `session/subagent-job.ts`, `session/subagent-completion.ts`, `session/execution/restart.ts`) — **dev HEAD clone**; for LSP/legacy `packages/opencode` use root `opencode/packages/opencode` (§46-V1-SOURCE-ALIGNMENT-AUDIT §1). Horizon's adapted Task seam is `packages/opencode/src/tool/task.ts` plus `session/managed-run-coordinator.ts`. Re-read Codex's `repos/codex/codex-rs/core/src/codex_delegate.rs` and `thread_manager.rs`. OpenCode provides the child-session parent check, depth/agent validation, permission admission, stable child ownership on resume, prompt-before-wait/background behavior, interruption and restart recovery. Codex provides shared runtime-capacity admission, cancellation-fenced startup/cleanup, inherited instruction/environment selection, parent-child thread/source lineage, and explicit IO/event forwarding. | **ADAPT lifecycle and session/config/event patterns; REUSE OpenCode Task seam** | Preserve AgentProfileV2 as the executable profile authority and Rust Goal/Task/Attempt, Guard, leases, receipts and evidence as managed authority. Codex's delegate approval=`Never` rule and either upstream's local permission/session state cannot bypass HorizonCode Guard or authenticated Attempt scope. Child text/status is candidate output, never completion evidence. Keep V1 single-Task until independent final-revision verification passes. No upstream snapshot code was copied by this review. |
| P3 RepoIntel and editing | OpenCode tool modules for search, patch, Git and filesystem; Codex `core/src/tools/handlers/tool_search.rs`, `unified_exec.rs`, `apply_patch.rs`; the P3 decision is already recorded in §42.11. | **ADAPT bounded algorithms; REJECT a second index** | Keep indexd/RepoIntel as the one generation owner. Existing results remain read evidence; source freshness and every mutation continue through the authenticated Horizon read grant and Guarded patch path. |
| P4 LSP, DAP, REPL | Pinned OpenCode `packages/opencode/src/lsp/{server,client,launch}.ts` and `tool/lsp.ts` are the reusable language-server catalog, JSON-RPC lifecycle and diagnostics seam. The inspected Codex core tools did not expose a DAP or persistent REPL implementation suitable for this boundary. | **ADAPT OpenCode LSP; no Codex port identified** | Preserve Horizon LSP/DAP/REPL broker IDs and authenticated lifecycle. Any install, process start, code action/rename, attach/evaluate or callback remains unavailable until P1 Guard, executable resolution and OS confinement are verified. No equivalent Codex DAP/REPL feature is inferred from generic exec. |
| P5 built-in web search | Re-read the pinned OpenCode `packages/opencode/src/tool/websearch.ts` and `tool/mcp-websearch.ts`: the tool selects exactly one Exa/Parallel MCP route by flags/override/session checksum, asks `websearch` permission, emits provider metadata, sends a fixed JSON-RPC `tools/call` schema through HttpClient, parses JSON/SSE text, and bounds the request. Codex `ext/web-search/src/{tool,schema,history,output}.rs` sends one selected hosted-API request, bounds prior context, emits begin/end events, and omits raw output from logs. | **REJECT single/random provider selection; ADAPT fixed protocol schemas, bounded parsing, provenance and cooldown UX** | Neither implementation is the approved built-in plus user-enabled ordered cascade. Keep consent, explicit auth/cost/provenance, per-route failure/cooldown, one bounded retry, and no silent paid upgrade under §§16/37.5/32. Horizon's `websearch-adapters.ts` keeps provider result normalization separate from authority; Core dispatches one immutable aggregate route plan through the existing Rust Guard/ExecutionHost transport and SecretBroker. No upstream network executor or permission authority is copied. |
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

**Follow-up source inspection (2026-10-20):** the local `message_tool.rs` is shared by
`send_message.rs` and `followup_task.rs`; the only delivery-mode difference is
`QueueOnly` versus `TriggerTurn`, with parent/root-turn correlation carried on the triggered
path. `mailbox.rs` stores pending entries in a process-local mutex map and exposes a
coalescing boolean watch, retaining unread messages across runtime eviction but not as a
durable cross-process inbox. `completion.rs` emits terminal activity and queues a bounded
textual parent notice best-effort. `interrupt.rs` rejects root/self targets and does not
reload an unloaded child. `wait.rs` waits on the caller turn's mailbox/steering activity
with configured min/max/default timeout; it is not by itself a named-child completion wait.
`spawn_guard.rs` tears down a newly created child on cancellation before initial input is
accepted, waits for an in-flight spawn-edge write, then closes the edge. Horizon may adapt
that partial-start cleanup ordering while preserving Core-owned Session history, durable
message append/ACK and UNKNOWN reconciliation. It must not port Codex's process-local
mailbox/watch as Horizon's direct-message authority.

**Spawn-order recheck (2026-10-20):** OpenCode `tool/task.ts` asks parent permission, resolves
the selected Agent, derives child permissions, creates/reuses the linked Core Session, then
submits the prompt; its background supervisor cancels the child when the owning scope is
interrupted and can inject completion into the parent. Codex `spawn_agent_internal` admits
runtime membership and capacity, reserves a spawn slot, snapshots inherited runtime policy,
creates the thread, installs `PendingSpawn` cleanup, persists and waits for the parent-child
edge, then submits initial input. Only after input admission does it commit the spawn slot,
disarm cleanup and notify clients that the child exists. On Horizon, preserve the useful
reserve → create → durable-lineage → accepted-input ordering, but the Rust OwnerLog and Core
Session remain separate authorities: an UNKNOWN input/receipt is reconciled under the same
admission identity, not treated as a new child or hidden by cleanup. This confirms the
existing §29.5 ordering; it does not authorize Codex's process-local state or best-effort
completion delivery as durable Horizon evidence.

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

### 42.16 Pi coding-agent / Pi Durable and current Codex parallel patterns — 2026-10-21

The detailed decisions and source links are in
[`docs/research/2026-10-21-pi-codex-harness-decisions.md`](../docs/research/2026-10-21-pi-codex-harness-decisions.md).
This review compared the ignored local OMP Pi-like coding-agent clone, the ignored
repository-local Codex source snapshot, the user-supplied Pi Durable design description, and local HorizonCode source
against §§29–31/45. No Pi or models.dev remote pages were fetched for this bounded source
review; this records what was examined then and does not restrict permitted read-only web
research. The user-supplied Pi Durable framework is described as experimental and is not a
Horizon runtime or implementation base.

| Pattern | Decision | HorizonCode boundary |
|---|---|---|
| Pi context resources, progressive disclosure, compaction, transcript-aware prompt/tool changes | **ADAPT** | Use existing Core ContextService/ContextSelection and request revision pins. Preserve source trust, digests, and history; a dynamic update applies at a request boundary. No ambient loader or second transcript owner. |
| Pi timeline/tree navigation and Pi Durable task ownership/replay | **REUSE invariants; preserve owners** | Continue through Core Session history/tree and Rust managed owner logs. Persist intent before effects, use exact idempotency IDs and replay classification, attach from canonical snapshots, and reconcile uncertainty as `UNKNOWN`. Hosted sharing is deferred; external disclosure is not implied by local export. |
| Pi CodeMode and deferred tool discovery | **ADAPT, gated** | Bounded composition/discovery may reduce prompt size, but every nested effect must re-enter Rust Guard/ExecutionHost under the authenticated Attempt/lease/receipt. Current fail-closed CodeMode gate remains. Tool discovery changes exposure only; never authority. |
| Pi virtual/non-chat models and pi.dev catalog | **ADAPT metadata; do not add another catalog/router** | models.dev is already HorizonCode's provider-agnostic metadata integration. Route/capability truth remains selected-provider runtime state; model tasks are explicit profile-bound calls. Unknown price/capability remains unknown. |
| Pi cache warming | **DEFER automatic warming** | No unrequested provider traffic. Any later warming needs explicit opt-in, selected-route lifetime, cost/savings disclosure and usage accounting. |
| Pi usage UI and Codex task visibility/delegation lifecycle | **ADAPT presentation and orchestration patterns** | Show attributed usage and child lifecycle in bounded views. Use clear task/deliverable, capacity reservation, lineage, queue-vs-wake, wait/cancel/resume/close and conflict control. UI is a projection; Rust remains authority and child completion remains candidate evidence. |

No Pi or Codex source was copied by this comparison. Public `main` URLs are moving
references; any future code extraction must first identify the exact local source pin,
inspect file-level notices/dependency terms, and record attribution. This research does not
change any phase from PARTIAL/NOT VERIFIED and provides no acceptance evidence.


### 42.17 Codex multi-agent lifecycle, state, events and UI detail — 2026-10-21

The exact in-repo snapshot review is recorded in the comparative decision note. Relevant local
references are `repos/codex/codex-rs/core/src/tools/handlers/multi_agents_spec.rs`,
`core/src/agent/control/{spawn,spawn_guard,runtime,mailbox,execution,residency,completion}.rs`,
`agent-graph-store/src/{store,local}.rs`, `protocol/src/{items,protocol}.rs`,
`app-server-protocol/src/protocol/thread_history.rs`, and `tui/src/{multi_agents.rs,app/agent_status_feed.rs,app/loaded_threads.rs,app/agents_overview_view.rs,app/agent_center/render.rs}`. The local snapshot has no independent Git identity; it is not proof of current upstream HEAD.

Codex separates collaboration operation events (spawn/message/follow-up/wait/interrupt) from
child activity/status events; the TUI reconstructs projections from history, deduplicates IDs,
bounds previews, and offers status grouping/filtering. Its spawn order reserves capacity, creates
the child, persists the parent-child edge, then accepts initial input; cancellation cleanup owns
the partial child until that acceptance point. It separately accounts for total child admission,
active execution, and resident memory. Its graph store persists topology/thread history, while
runtime registry and mailbox are process-local; completion parent notices are best-effort text.
These distinctions are important: persistent topology is not durable message/Attempt/effect
receipts or completion evidence, and those local budgets are not OS CPU/memory/FD limits.

HorizonCode already improves on the contract surface: explicit lane-tagged delivery, pinned
AgentProfileV2, authenticated parent ownership, durable inbox message IDs/ACKs, named-child
wait, explicit queue-vs-follow-up wake semantics, Rust resource/effect authority, and `UNKNOWN`
reconciliation. Therefore **no new schema or runtime is needed**. Adapt the spawn reservation order,
separate budget dimensions, non-reflexive wait/parallel guidance, and bounded status UI only
where current source has a concrete gap. Do not copy Codex's process-local mailbox or mark a child
complete from best-effort parent notification. No source was copied; no checks were run.

## 42.13 JCode CodeMode and swarm-DAG implementation comparison — 2026-10-20

This is a source comparison, not a code-copy approval or proof of HorizonCode runtime behavior. The local reference clone is pinned in §42.9 to `1jehuang/jcode@1f612a7` and has a root MIT license; any future copied code still requires an exact per-file/dependency/license review and attribution. The source map and project docs are not treated as executable proof.

| Reference surface | Direct source observed | HorizonCode decision |
|---|---|---|
| JCode CodeMode interpreter (source checkpoint observed 2026-10-20; current HorizonCode contract is §37.24 and §32.41) | `repo_take/jcode/crates/jcode-codemode/src/{lib.rs,engine.rs,tests.rs}`; QuickJS in a short-lived thread, no ambient filesystem/network/process APIs, host-tool callback boundary, bounded heap/time/call/log limits and cancellation-on-drop. Its default examples are 64 MiB, 300 s, 2,000 calls and 64 KiB logs. | **Do not add a second interpreter.** At the recorded source checkpoint, HorizonCode's existing CodeMode package was gated from the model-visible registry and nested MCP dispatch failed before transport. Adapt only bounded orchestration and cancellation test ideas. JCode's ordinary host tool callback is not equivalent to HorizonCode Rust Guard/lease/receipt mediation. Current HorizonCode CodeMode acceptance is CM-001..012; the earlier CM-001..007, CM-001..009, CM-001..010 and CM-001..011 lists are historical. |
| JCode DAG model/ops | `repo_take/jcode/crates/jcode-plan/src/dag/{mod.rs,ops.rs,schedule.rs,sim.rs}` and `docs/SWARM_TASK_GRAPH.md`; the docs label the DAG-first transition “Being implemented.” The code has typed seed/expand/dispatch/complete/gate-inject/simulation seams. | **Adapt invariants only into existing Rust-managed Goal/SpecVersion/Run/Task/Attempt.** Useful patterns: append-only child expansion under an owned node, dependency-derived ready sets, typed by-reference handoffs, explicit critique/verify gates, gap injection, confidence/what-was-not-checked, and deterministic restart/requeue rules. Preserve the accepted V1 single-task/attempt and current canonical OwnerLog; do not introduce a second plan graph, worker pool, receipt owner, or claim JCode's full deep mode is proven in production. |
| JCode live swarm coordination | `repo_take/jcode/crates/jcode-app-core/src/server/{swarm.rs,comm_control.rs,swarm_persistence.rs,swarm_watchdog.rs}` plus `crates/jcode-swarm-core/src/lib.rs`; the latter is shared member/status/channel/report formatting/index helpers, not the DAG runtime. | **Do not transplant JCode's session swarm authority or shared channels.** HorizonCode uses the two accepted delivery lanes in §37.9: Core-owned direct Sessions and Rust-owned managed Attempts, with authenticated `AgentProfileV2`, `SubagentDeliveryV1`, owner epochs, Guarded effects, and durable receipts. A model report remains candidate output, never final evidence. |

Testing implications are already split across §32.12 SA-018..020, §32.33 JC-RES-018/021/022, §32.38 VEO-001..024, and §32.40 HUP-001..006. The post-implementation suite should specifically prove node ownership/acyclicity, dependency readiness and fan-in artifact binding, failed verify → bounded fix/re-verify, critique gap injection, low-confidence unresolved work blocking the parent, restart without duplicate effects, and UNKNOWN reconciliation when dispatch may have happened. Run these against HorizonCode's canonical managed owner, not as a stand-alone JCode-like swarm engine. These are later acceptance targets; no such test or uplift result is claimed passed.

## 42.14 Oh My Pi MetaHarness reference for HorizonCode evaluation — 2026-10-21

Local reference inspected: `repo_take/oh-my-pi/packages/metaharness` at local tree commit `a536558dc21634462c1b2647676953204569779c`; the tree reports clean and its root `LICENSE` is MIT. This records the in-repository source identity only; the remote mapping was not contacted during this source review. Relevant source includes `README.md`, `src/{experiments,runner,store}.ts`, and `test/{experiments,runner}.test.ts`.

The reusable ideas are one experiment/run/task/trace model across benchmark adapters, explicit baseline/treatment roles, a per-task arm matrix, immutable launch configuration, normalized trace/cost/progress projection, and restart that preserves completed trials rather than repeating already-spent work. HorizonCode should adapt these as contracts/data-flow inside the P8 HUP runner and existing RC0/evidence owners, not copy a second benchmark manager or the reference's Harbor/Docker/KVM/remote auth-gateway infrastructure. The local runner includes paid-provider and remote/container paths; none is authorized for the current offline self-check. Follow §32.40: fake-provider self-check first, then separately authorized exact-route smoke and only later pinned paired evaluations. This is pattern reuse, not evidence of a HorizonCode score, runner acceptance, or source-port approval; any copied implementation requires exact file/dependency/license review and attribution.

## 42.15 Permission and helper-process design references (2026-10-21)

| Source | Fact considered | HorizonCode decision |
|---|---|---|
| Official OpenCode V2 permissions documentation (`https://dev.opencode.ai/v2/docs/permissions/`; reviewed 2026-10-22) | V2 models ordered action/resource allow/ask/deny rules, scoped saved approvals and a hard-deny policy separately. Its documented defaults are permissive, and a custom subagent's permission policy does not automatically inherit as a subset of its parent's. | ADAPT explicit low-friction scoped-grant UX and immutable deny behavior; do not copy permissive defaults, permission storage, or subagent inheritance semantics. HorizonCode derives child scope from authenticated profile/delegation pins, intersects it with the parent and Rust Guard, and retains Rust Guard/DirectSessionGrant as sole effect authority (§§14, 17, 29, 37). |
| Official Anthropic Claude Code CLI documentation (`https://docs.anthropic.com/en/docs/claude-code/cli-usage`) | Allowed/disallowed tool selectors provide explicit action-level user controls. | ADAPT visible, reviewable action scopes; do not copy broad bypass modes as a default. Exact grants remain bounded by Guard and OS guarantees. |
| Official Bun child-process documentation (`https://bun.sh/docs/runtime/child-process`) | On supported Linux systems, a child can join cgroup before executing, and OS memory/CPU/PID limits then apply to that process tree; unsupported cgroup setup fails rather than silently applying. | ADAPT the existing Rust ExecutionHost + cgroup-v2 process containment for CodeMode. Do not add a Node Worker or second process supervisor. If OS containment cannot be verified, CodeMode remains unavailable. Bun documentation alone is not HorizonCode implementation evidence. |
| Official Cloudflare Code Mode documentation (`https://developers.cloudflare.com/agents/tools/codemode/`) and MCP patterns (`https://developers.cloudflare.com/agents/model-context-protocol/codemode/`); Anthropic research (`https://www.anthropic.com/research/code-execution-with-mcp`) | Code execution as a single orchestration tool can compose dependent calls, filter/transform intermediate results, and support progressive tool discovery, reducing schema/context and model round trips. The examples use an isolated runtime and host callbacks for effects. | ADAPT the orchestration pattern over HorizonCode's existing interpreter and current authorized tool tree. Preserve direct tools for simple work and progressive discovery for larger catalogs. Do not expose ambient APIs, MCP executors, or Cloudflare's Worker model as authority; every call re-enters HorizonCode ToolBatch/Guard/ExecutionHost and receipt recovery. Vendor token-savings claims are not HorizonCode benchmark evidence. |
| Cloudflare Code Mode AI SDK integration (`https://developers.cloudflare.com/agents/tools/codemode/ai/`; reviewed 2026-10-22) | The stateless constructor excludes tools requiring approval; the durable connector maps approval-required tools into its runtime approval flow. Code Mode keeps dependent composition and result shaping inside execution. | ADAPT composition and progressive disclosure only. HorizonCode nested calls use the authenticated Core dispatcher and Rust per-effect Guard/lease/receipt contract; a vendor approval mechanism cannot substitute for it. Keep direct calls for simple work, and expose `codemode.execute` only after its helper, dispatcher, cancellation and recovery gates pass. |
| OpenAI official multi-agent documentation (`https://developers.openai.com/api/docs/guides/agents-api/multi-agent`) | Subagents receive separate context, can run concurrently, and the parent coordinates and combines results; task decomposition should be independent and writers must coordinate. | ADAPT parent-owned orchestration, clear ownership, separate child contexts, explicit concurrency and conflict-aware result integration. HorizonCode retains durable child/Task identity, exact profile/scope pins and Rust Guard authority; this is not permission to parallel-edit overlapping files or accept model-reported completion. |
| Official OpenAI Codex harness and sandbox guidance (`https://developers.openai.com/blog/codex-as-a-platform`, `https://developers.openai.com/api/docs/guides/agents-api/environments/security`) | The Codex harness combines conversation state, streaming, tools, configured sandbox and approval policy, and durable turn continuation; sandbox guidance separates environment credentials from application credentials and recommends scoped network destinations. | ADAPT a productive integrated turn/tool/context/recovery loop and explicit sandbox/network/cost policy. Keep the existing Core conversation owner and Rust Guard/ExecutionHost; do not duplicate the Codex runtime or treat its product behavior as HorizonCode evidence. Direct turns use the explicit user turn and pinned route policy in §17.26; managed sends retain live Attempt authorization. |
| Codex `/permissions` product documentation (`https://learn.chatgpt.com/docs/permission-modes`; reviewed 2026-10-22) | The CLI surfaces a permission picker; its UX separates sandbox scope from approval frequency and offers Ask for approval, Full access, and custom policy. Ask for approval uses workspace-write/on-request; Full access is explicitly unrestricted local files/network. | ADAPT the two independent controls, a visible current mode and explicit Full access choice. HorizonCode's default is workspace-write/on-request; Full access is an explicit per-Session selection, not a default. All effects still pass HorizonCode's single Guard/ExecutionHost and receipt lifecycle; do not copy Codex implementation or claim its behavior as our acceptance evidence. |

These sources inform decisions only; the normative contract is §§14, 17, 20, 29, 32, 33 and 37. The exact code, runtime packaging, cgroup lifecycle, helper protocol, Guard mediation and recovery must be accepted on HorizonCode's integrated revision.

### 42.19 Local lifecycle implementation recheck — 2026-10-22

A source-level recheck used the repository-local OpenCode and Codex snapshots, not repository summaries. The OpenCode paths actually reviewed include `repo_take/opencode/packages/core/src/session/subagent-job.ts`, `session/subagent-completion.ts`, `session/execution/restart.ts`, and the Task path under `packages/core/src/tool/task.ts`. They implement a linked Core child Session, a separately tracked background Job, completion notification and restart recovery that verifies the persisted parent/child relation, checks whether child execution is already active, enforces resume exhaustion, resumes the same child and delivers the final completed assistant text. The job/notification layer is process-local orchestration around persisted session/job recovery; its notification text is not effect or managed completion evidence.

The Codex paths actually reviewed include `repos/codex/codex-rs/core/src/codex_delegate.rs`, `core/src/thread_manager.rs`, `core/src/context/inter_agent_message.rs`, `core/src/context/subagent_notification.rs`, and the current multi-agent control modules named in §42.17. Its delegate path constrains delegates to a no-approval child policy, inherits the parent environment/instructions and selected runtime services, creates a child Session tied to the parent thread, forwards child events and parent operations over bounded channels, cascades cancellation with child tokens, and emits a start event only after the child spawn is accepted. The thread manager owns root-scoped thread identity, spawn edges, routing and resume. This is useful for low-latency interaction, explicit cancellation and owner-checked resumption; it is not durable inbox/receipt state.

**Adaptation decision:** preserve both source strengths in the existing HorizonCode contracts: OpenCode's child-session lifecycle and restart/resume semantics; Codex's root-owned child graph, explicit operation/event separation, bounded event forwarding and cancellation ownership. Direct sessions remain Core-owned linked Sessions with Rust-owned grants/resource/effect facts; managed children remain Task/Attempt-bound. HorizonCode messages require durable IDs, append/ACK and UNKNOWN reconciliation; completion is projected only after source-owned terminal facts. Never copy either source's process-local job/mailbox as the authority, inherit a blanket no-approval policy, or use completion text as verification evidence. No new runtime/schema is required from this comparison; current P2/P7 implementation must be checked against these seams before source closure.

**Execution-cgroup cleanup comparison (2026-10-22):** A focused read-only inspection of local OpenCode `repo_take/opencode/packages/core/src/mcp/stdio.ts` (notably its `killProcessGroup` helper and SIGTERM→SIGKILL escalation) and Codex `repos/codex/codex-rs/core/src/exec.rs` (process-group termination/cleanup around the child lifecycle) found process-scope cleanup, not a persisted cgroup device/inode identity, quiescence journal, restart janitor, or owner-locked cgroup namespace cleanup. These patterns are useful for prompt in-process termination and cleanup, but cannot bound HorizonCode's retained cgroup directories across restarts. No code was copied. **Decision:** keep HorizonCode's stronger durable identity and UNKNOWN/quiescence semantics; only remove a cgroup after the existing ExecutionHost janitor revalidates the exact durable pins, persisted quiescence, empty state and inode under the shared namespace lock, and proves the launched process could not mutate or access that namespace. Source now derives `cgroupHierarchyHidden` only from the validated bubblewrap mount plan; other backends and Full Access are retain-only. Exact hidden-hierarchy identities are retried at durable settlement and owner restart. UNKNOWN, legacy, Full Access, failed-proof or failed-removal entries remain in the explicit 256-entry retained quarantine, and exhausted capacity fails closed; the cap is not a 256-lifetime-execution limit for successfully reaped confined groups. This source path remains pending crash/race and OS acceptance. Codex/OpenCode process-group patterns do not justify weakening this constraint.

## 42.18 Accepted V1 search-plan and runtime-lane reconciliation — 2026-10-22

This records the resolved contract; it does not change the older provider research or imply
that the runtime has passed acceptance. The trusted search plan begins with the anonymous,
no-key built-in default. The user's request supplies query intent and a bounded result limit
only. Trusted code resolves fixed endpoints, route order, credentials by opaque reference,
and cost/auth classes. Optional providers enter only after explicit per-route enablement and
configuration. A route-local 401/403/407 is recorded and may fall through only to another
explicitly enabled route; a 429 is recorded and applies bounded cooldown; other 4xx stops the
cascade. Model-grounded search is not the default and requires an actually supported adapter,
explicit route selection and consent. The route plan, not model/request text, controls dispatch.
See normative §17/DEC-V1-26, §33.9 and §37.5; source presence in the earlier entries is not
runtime proof.

The related runtime authority remains split: direct CLI/TUI prompts are owned by Core
`SessionRunner`; managed provider prompts use the separate `SessionPrompt` lane for live
Attempt binding. This is a source-backed current architecture clarification, not a claim that
direct/managed parity acceptance has passed. Direct-session fan-out returns candidate results
under Core child Sessions and has no managed DAG aggregate settlement. Under DEC-V1-31,
bounded Rust-managed Task DAG execution and aggregate settlement are also in V1 after the
one-Task managed vertical is accepted. Current multi-Task admission remains disabled until
per-Task exact-revision verification, conflict-safe leases, recovery and aggregate settlement
are implemented and accepted. Only Rust-managed Task DAGs can settle dependency state and
aggregate Run success from independent verification.

For CodeMode, adapt the existing interpreter and exact authenticated tool tree; do not add a
second interpreter. Official Code Mode guidance describes model-written code as a compact
plan that composes dependent calls, loops/branches, filters intermediate results and returns
the useful output; progressive search/describe reduces the up-front tool catalog. HorizonCode
uses its existing `$codemode.search` and authorized tool definitions for that pattern. The
agreed contract is at most 64 nested calls per script, in admitted
waves of at most 32, with a 30-second deadline, 65,536-byte source/output bounds and 1 MiB
aggregate arguments. Each nested effect still crosses ToolBatch/Guard/lease/ExecutionHost/
receipt reconciliation. Source defines a fixed cgroup-v2 memory/CPU/PID/FD profile, but the
model-facing tool is still disabled and the Core-to-helper protocol is not wired. See §29.22,
§33 and CM-001..012 in §32.41.

The direct-session low-friction policy is a product contract, not a permissive default:
user-issued exact grants provide the prompt-free path for selected workspace actions while
Guard, lease and receipt checks remain per effect. Build/test grants require immutable
user-owned `WorkspaceCommandProfileV1` refs and verified selected-backend guarantees. The
profile/schema/UI/Guard path is not currently integrated as a complete flow; no grant should
be claimed to authorize build/test until GRANT-011..016 pass.


## 42.20 Pi Durable and Codex parallel execution recheck — 2026-10-22

Read-only review of moving upstream primary sources for Pi Durable (`packages/durable`), Pi coding-agent subagent extensions, and Codex parallel dispatch / multi-agent tooling / protocol v1 (`codex-rs/core/src/tools/parallel.rs`, `handlers/multi_agents_spec.rs`, `docs/protocol_v1.md`). These are reference research on unpinned upstream heads, not the repository-local snapshots in `repo_take/` or `repos/codex/` and not acceptance evidence. See [`docs/research/2026-10-21-pi-codex-harness-decisions.md`](../docs/research/2026-10-21-pi-codex-harness-decisions.md) for the bounded comparison note.

Pi Durable's useful primitives are one checkpointed Task per model/tool/compaction step, explicit replay safety per tool, task-owned child conversations with stable submission IDs, foreground/background ownership, and committed state watches that can resnapshot late/reconnecting clients. Its coding-agent subagent example separately demonstrates specialized prompt/tool/model profiles, concurrent work with streaming status, bounded returned outputs and abort propagation. Codex keeps one active Task per Session, exposes user input/interrupt/approval through an explicit submission/event protocol, and gates concurrent tool execution with a read/write lock: only tools marked parallel-capable share the concurrent path; other tools serialize. Its delegation guidance emphasizes non-overlapping ownership, no duplicate work and a clear parent integration point.

**Adaptation:** use these semantics inside HorizonCode's existing owners: Rust remains authoritative for managed Run/Task/Attempt checkpoints, permissions, budget and settlement; Core remains the direct conversation owner; child work keeps authenticated profile/scope binding, durable IDs, event streaming, explicit cancellation, UNKNOWN reconciliation and independent verification. Concurrent workers are admitted only on distinct authorized Locations and through P8 durable resource/worktree accounting; effectful tool concurrency must pass the existing complete ToolBatch and Guard path, while read-only concurrency can be bounded by the declared capability class. Preserve direct tools for straightforward operations and use CodeMode for composed calls/progressive discovery as already specified. Do not copy Pi's process-per-child execution authority, Codex's in-memory Task/lock authority or either product's permission defaults. No HorizonCode code was copied.

CodeMode pattern evidence is consistent with the existing HorizonCode decision: [Cloudflare Code Mode guide](https://developers.cloudflare.com/agents/tools/codemode/) describes typed tool calls inside generated code for composition, branching, filtering and progressive discovery; direct calls remain simpler for small, fixed tool sets. This is an orchestration/model-interface choice, not a new authority boundary. HorizonCode's helper remains sandboxed, and nested calls must use its normal HostKernel ToolBatch dispatcher and typed receipt/UNKNOWN flow. Cloudflare's efficiency claims are not HorizonCode benchmark evidence.

## 42.21 Competitive repo-intelligence and IDE research — V1 disposition (2026-10-22)

Non-normative research summary for mgrep, code-review-graph (CRG), Cursor indexing, Aider repo-map, Windsurf/Devin Desktop Cascade, and related MCP marketing. **Normative V1 law:** `DEC-V1-35`, §10.18, §30.25, §32.47. This section records adopt/adapt/reject only; it does not change feature status.

| External surface | Useful mechanism | Horizon disposition | Owner |
|---|---|---|---|
| Windsurf / Devin Desktop IDE | Workspace index, timeline, worktree Spaces, agent command center | **Adapt semantics** (revision pins, ledger, worktree pool) in P7/P8; **reject** shipping their IDE shell in V1 (A-V2-31) | §31, §21, §10.18 |
| OpenCode + mgrep | Semantic search tool + MCP background sync | **Reject** as canonical RepoIntel; optional user-routed MCP only | §30.25, §29 |
| code-review-graph | Tree-sitter SQLite graph, MCP blast-radius | **Adapt algorithms** into `indexd`; **reject** Python CRG install as authority | §30.8–9, §42.11 |
| Cursor @codebase | Embeddings + Merkle + grep hybrid | **Adapt** hybrid locally; **reject** default cloud index | §30.7, §30.25 |
| Aider repo-map | PageRank over symbol tags | **Adapt** ranking into ContextSelection | §30.25 |
| LanceDB / episodic preferences | Vector preference replay | **Defer** post-V1; §30 recall is opt-in bounded memory | §30.21, §10.12 |
| Claude Code docs (memory, CLAUDE.md, large monorepos) | Ancestor load at launch; subdir on demand; AGENTS.md interchange; scoped imports | **Adapt policy** §29.23; no copy of Claude product code | [memory](https://code.claude.com/docs/en/memory), [claude-md](https://code.claude.com/docs/en/claude-md), [large-codebases](https://code.claude.com/docs/en/large-codebases) |
| OpenCode skills (`skill/instructions.ts`, `Skill` service) | Skill metadata in system prompt; `skill` tool loads `SKILL.md` body | **REUSE pattern** `DEC-V1-38`; Horizon adds `builtin.horizoncode` integration map | pinned `opencode/packages/opencode/src/skill/` |
| Codex delegate / thread instructions | Parent→child inherited environment | **ADAPT** §42.17 delegation only; direct Session §29.23 | `repos/codex/codex-rs/core/` |
| Playwright / headless browser | Visual QA | **Defer** post-V1 (A-V2-31) | §37 browser backends |
| Wasmtime snippets | WASM sandbox | **Unavailable** V1 (`DEC-V1-05`) | §17 |

Pinned local sources and Pi/Codex harness notes: [`docs/research/2026-10-21-pi-codex-harness-decisions.md`](../docs/research/2026-10-21-pi-codex-harness-decisions.md).
