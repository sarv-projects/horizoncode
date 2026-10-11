# 38 — Oh My Pi source-level competitive audit (research, NOT an adopted V1 contract)

**Audited upstream:** https://github.com/can1357/oh-my-pi at commit eec114a9226da698ebc015fd8996a8ca3bc4625c (2026-10-11), cloned as a sparse read-only comparison checkout. **Target:** local HorizonCode /home/sarvesh/business_Dev/agentx as found on 2026-10-11.  
**Status:** RESEARCH/PROPOSAL. §§17,20,25,29–37 remain normative. Do not interpret the competitor's features or this report as implemented HorizonCode code. No competitor code was copied, dependencies installed, product runtime modified, or production source migrated.

## 38.1 Scope and accuracy

The upstream Git tree at the pinned SHA contains 8,962 blobs, including 134 Markdown documents under docs/ (38,238 source lines), approximately 711 Rust and 5,931 TypeScript source files. The local HorizonCode arch_V1/ corpus contained 39 Markdown files (15,112 lines) during this inspection. Every upstream docs/*.md and HorizonCode arch_V1/*.md was enumerated and machine-read line-by-line for topic mapping and checksum inventory; the source documents with code/operational authority below received direct manual semantic inspection. The 8,962 files have **NOT** each been read or independently tested line-by-line, and neither all 38k upstream documentation lines nor all 15k HorizonCode lines have been manually adjudicated semantically. Do not call this a complete semantic every-file competitor audit.

Machine-reproducible document inventory and source path map: omp-source-evidence-inventory.json. Distinguish OBSERVED SOURCE (exact module/function) from REPORTED BY OMP DOCS (implementation assertion) and DESIGN PROPOSAL (not implemented or accepted). OMP README claims 31 built-in tools; inspected packages/coding-agent/src/tools/builtin-names.ts currently enumerates **30 public tool names** and 3 hidden names, while browser/computer are Eval preludes, not public tool IDs. Those are different counts/definitions, not evidence of 31 working independently.

## 38.2 Architecture, HLD, process and schemas

OMP is fork-derived from Pi. CLI dispatch in packages/coding-agent/src/cli.ts, then commands and main.ts, then createAgentSession in sdk.ts; AgentSession owns its JSONL session tree. Interactive TUI, print and RPC modes sit above the agent. Model/provider connectors live under packages/ai, while core Rust algorithms are exposed via crates/pi-natives with napi-rs through packages/natives/native. Root native loading uses lazy entrypoints for desktop, clipboard, path and vcs; npm optional platform binaries, CPU variant fallback, build/version stamping, and embedded binary extraction. Relevant official maps: packages/coding-agent/DEVELOPMENT.md, docs/natives-architecture.md and docs/native-crates.md.

This is architecturally distinct from HorizonCode: OpenCode remains canonical Session/Input/Message/Part/provider-continuation owner and Rust must be the durable managed Goal/Run/ToolBatchControl/Effect/Guard/ExecutionHost owner. **DO NOT** move the native N-API call path directly into the managed authority store. If adopting a pure Rust primitive, expose it through a read-only/query adapter or through scoped ExecutionHost after authorization.

OMP schema/protocol audit anchors: packages/coding-agent/src/config/mcp-schema.json (configuration), packages/coding-agent/src/modes/rpc/wire/rpc-wire.schema.json (RPC), packages/coding-agent/src/tools/builtin-names.ts (runtime tool names), packages/coding-agent/src/tools/index.ts (ToolFactory/ToolSession/resolveBuiltinToolPlan), packages/coding-agent/src/web/search/types.ts (search result contract), packages/coding-agent/src/tools/browser/tab-protocol.ts, packages/coding-agent/src/tools/computer/protocol.ts, packages/coding-agent/src/lsp/types.ts, packages/coding-agent/src/edit/schemas.ts, packages/coding-agent/src/task/types.ts and the Rust N-API generated declaration surface. These schemas are not drop-in equivalents of Horizon contracts-v2; map action identity, scope, per-turn schema generation, effect class, error and cancellation explicitly.

## 38.3 Browser control — source-to-source LLD

**Observed source:** packages/coding-agent/src/tools/browser.ts (createBrowserPrelude, invokeBrowser, openBrowser, runBrowser), tools/browser/tab-supervisor.ts (~2,180 lines), tab-worker.ts, registry.ts, launch.ts, attach.ts, relay/, network.ts, snapshot-plus.ts, queries.ts, interactions.ts, screenshot.ts, tab-protocol.ts and settings.ts; docs/tools/browser.md.

- Browser is an Eval first-use prelude in JS and Python, enabled only when Eval/browser are enabled; its host operation is treated as exec-tier approval (docs/tools/browser.md). This is not the same type of tool as public web_search.
- Backend modes: managed Chromium, attached CDP/Electron/browser, Chrome relay, and Tern/cmux paths. Named tabs have managed ownership and per-tab run serialization, bounded timeouts, crash detection, worker recycle, idle freeze/close for owned tabs, and explicit persistent opt-out.
- Observation surfaces: tab.observe / ARIA snapshots / selector or element ID / screenshots, console/network telemetry, traced calls and artifact-backed capped output. Worker recycle invalidates handles; page injection is untrusted data.
- BrowserNetworkManager applies request interception and allowed-domain patterns with bounded network records. The upstream docs **explicitly warn allowed_domains is NOT a sandbox**, with mode-dependent coverage; attached and relay sessions can affect real signed-in user tabs.
- Horizon §37 BrowserBackendV1 is close conceptually but lacks a complete explicit named-tab lifecycle, owned vs attached shutdown semantics, worker-recycle generation and no-focus-theft policy. These are candidates to import, **not** approval to run page JS in an unconstrained host.

**Proposed Horizon improvement:** BrowserContextOwner {backendKind, ownerSession, contextRef, tabName, attachedOrOwned, policyDigest, generation, lease}; BrowserObservationV1 {snapshotRef, revision, staleAfterNavigation, DOM/ARIA/console/network provenance}; BrowserWorkerController {open/reuse/observe/interact/recycle/close/health}. Every action normalized through ToolIntent and Guard; attached user sessions need a stronger confirmation scope than owned ephemeral previews. Never confuse a request interceptor with OS-enforced network confinement. See §37.3, §32 BR and PS.

## 38.4 Desktop/computer control — high-value lesson, high-risk boundary

**Observed source:** docs/computer-use.md, docs/tools/computer.md, packages/coding-agent/src/tools/computer.ts, computer/supervisor.ts, computer/worker.ts, computer/protocol.ts, crates/pi-natives/src/desktop/mod.rs and desktop platform directories linux, macos, win32.

- Computer is disabled by default; Eval prelude lazily creates a persistent desktop worker. Native DesktopSession supplies listWindows/listDisplays, capture, AX snapshots/queries/actions, app/menu discovery, pointer/keyboard/clipboard. Worker tracks screenshot frame and AX refs and has timeout/restart/busy semantics.
- Screenshot-first coordinate contract: input coordinates refer to the last complete screenshot of the SAME target; a changed window size/layout invalidates the frame. Zoom region never silently changes the base click coordinates. Accessibility-first exact target matching minimizes fragile coordinate clicks.
- Background window actions and focus restoration are best-effort and platform-dependent. Wayland limitations are explicit; X11/macOS/Windows behavior differs. A native event enqueued is not proven app-effect success.
- **Security finding:** upstream docs/computer-use.md lines ~65–69 explicitly state computer.run(read_only=true) only blocks mutations through the facade, NOT arbitrary host APIs because its JS execution has full Bun/Node access. Horizon must not label a comparable feature 'read only' or 'sandboxed' without OS-level enforcement. Hosted script eval is itself an exec-tier effect.
- Worker/liveness: single active operation, queued work fenced, hard timeout, 750ms worker termination grace; restarted sessions invalidate screenshots/AX handles. Follow response/error receipt, not action enqueue, for final verification.

**Proposed Horizon improvement:** DesktopCaptureV1 {targetId,targetEpoch,windowGeometry,displayGeometry,imageArtifactRef,captureDigest,coordSpace}, AXSnapshotV1 {targetEpoch,refs,sourceRevision}, DesktopActionV1 {target,expectedCaptureEpoch,action,scope,effectIntent}. Separate read-only prelude exposure from sandbox-level guarantee. Guard any script execution itself before worker spawn; worker has no ambient filesystem/process/network privileges in governed mode. Require explicit confirmation for real user-app action, destructive sequences, clipboard writes or takeover. Add platform-specific Wayland/Windows/focus and stale-frame acceptance.

## 38.5 Built-in web search — source and economic truth

**Observed source:** docs/tools/web_search.md, packages/coding-agent/src/web/search/index.ts (runSearchQuery, executeSearch, WebSearchTool), provider.ts, providers/base.ts, query.ts, providers/public.ts, providers/duckduckgo.ts, providers/searxng.ts and 20+ adapters; packages/coding-agent/src/priority.json.

- The core resolves a per-request explicit model/engine when supplied; otherwise it walks a role chain and availability probes, collecting provider-specific errors. SearchResponse includes citations/source metadata and provenance fields where supported. Query parser handles site/date/quoted/exclusion/locale syntax and maps to adapter features.
- Adapter categories include public search engines/scrapers (DuckDuckGo, Startpage, Ecosia, Google, Mojeek), self-hosted SearXNG, credential-free MCP paths for certain providers (subject to service availability), direct paid APIs, and model-grounded search using Anthropic/Gemini/Codex/OpenAI/xAI/etc. README's 'built in' does NOT mean cost-free, always available, or without API/network terms.
- Docs/tools/web_search.md states the default chain includes Parallel, hosted, Exa, Firecrawl, SearXNG, Startpage, DuckDuckGo, Ecosia, Google, Mojeek; the chain **does not guarantee zero billing**. Public Web is explicit-only, and some free scrapers break on CAPTCHA/challenge/upstream changes. Even when declared 'read' at tool level, web search is an outbound network operation that must obey endpoint and privacy policy.
- Horizon's user-pinned model/provider and no-surprise-billing requirement is stronger than adopting this fallback chain blindly.

**Proposed Horizon improvement:** WebSearchProviderProfileV1 {id, authKind, pricingProvenance, capabilities, providerType, localVsRemote, explicitOptIn, privacyPolicyRef, perHostNetworkAllowlist}; SearchAttemptV1 {candidateId, attemptOrdinal, latency, exact provider, metered/unknown, failureKind}; SearchEvidenceV1 {sourceUrl, title, retrievedAt, publishedAt?, snippetDigest, citation, trust}. Default use only approved free/self-hosted routes; paid/hosted search requires explicit consent and separate budget. Do not disguise a provider change, borrow unauthorized OAuth or use scraper access as a guarantee. Integrate as first-party tool under Guard policy, not a second model routing engine.

## 38.6 Hashline editing, AST, native diff and inbuilt editor

**Observed source:** docs/tools/edit.md, docs/tools/read.md, docs/tools/ast-edit.md, packages/coding-agent/src/edit/{index,schemas}.ts, crates/pi-edit/src/{store,session}.rs, crates/pi-edit/src/modes/hashline/{parser,patcher,block,recovery,apply}.rs and crates/pi-ast/src/ops.rs.

- Model sees [PATH#TAG] on read/grep output. Hashline operations PUT/CUT/MV/REM use original snapshot lines, optional tree-sitter block anchors and named registers; edits stage parse + anchor verification before file writes. Other variants: apply_patch, patch, replace, sloppy; model-specific mode selection exists.
- The tag in crates/pi-edit/src/store.rs lines ~74–95 is a **four-hex-character hash**, derived from normalized text using a truncated xxh32 digest. The implementation has session snapshot retention (default 256 paths × four versions, 64MiB estimated cap, max 4MiB snapshotted file), seen-line enforcement and unique safe recovery on drift. Do NOT treat the 16-bit visible tag as a cryptographically unique revision token.
- Code has no-op loop feedback, block/syntax resolution, generated-file refusal, non-regular filesystem protections, multiple edit modes, read-only streaming preview and diagnostics-on-write support. Multi-section preflight occurs before writes, but docs explicitly say OS write failures can occur after earlier files have written: **multi-file patch is not necessarily atomic**.
- OMP's UI editor means a terminal composer/editor and source-edit tool engine; it does not displace Horizon's planned embedded CodeMirror 6 source editor and structured diff review. Keep this distinction.
- A Horizon implementation should make a full immutable source digest and expected filesystem/workspace revision authoritative in Rust Guard/ExecutionHost; short display tags are UI/model shorthand only. The edit engine may run as a pure/staged Rust function, then the authorized writer independently checks fence/target type/path policy and records per-file receipts, rollback/UNKNOWN where needed.

**Priority experiment:** compare native pi-edit concepts to upstream OpenCode apply_patch on 50+ pinned fixture tasks across hosted, medium-local and small-local models. Measure first-pass apply, wrong-file and stale-anchor rejection, conflict rate, token spend, P95 latency, cross-platform path behavior, syntax block resolution and final test pass. Synthetic same-short-tag collisions and concurrent user edits are mandatory. Do not copy wholesale or promise the upstream's reported edit success rate.

## 38.7 Rust native tools: reuse-by-subsystem, not blind import

Source authority: docs/native-crates.md, docs/natives-architecture.md, crates/pi-natives/src/lib.rs, Cargo.toml and individual crate manifests. Observed crate families:
- pi-walker: parallel ignore/gitignore-aware walker; shared stale-tolerant scan cache, globsets, iteration/cancel, explicit invalidation. Strong candidate for Horizon RepoIntel fast scan; generation/invalidation must precede any decision using stale results.
- pi-ast: tree-sitter/ast-grep matching, syntax block analysis and source summary. Good for parser-first indexing, AST patch operations; language grammar WASM downloads must be pinned or bundled for offline guarantees.
- pi-diff: Myers/string/line/word/patch primitives. Good pure Rust candidate, keep reviewable exact bytes and existing snapshot semantics.
- pi-edit: parsing, staging, snapshot store, structured patch, recovery. Strong candidate for pure patch planning and editing engine independent of authority.
- pi-vfs: injectable filesystem and URL path policy. Valuable for testability; avoid allowing virtual paths to bypass canonical file/Guard boundaries.
- pi-iso: APFS/btrfs/ZFS/reflink/overlayfs/ProjFS snapshot/clone/diff with Git-worktree/copy fallback. Useful **workspace copy/snapshot technique, NOT security sandbox** and NOT a substitute for lease fencing.
- pi-vcs: in-process Git gitoxide / Jujutsu jj-lib operations. Potential performance work; ensure parity with Git CLI, dirty worktrees, symlinks, refs and credentials, plus Guard for all mutations.
- pi-shell/pi-builtins: persistent embedded Brush shell plus utilities (uutils-derived). Potential speed but broad privilege and license dependency surface; do NOT embed directly in the canonical conversation host. Treat as late Rust ExecutionHost experiment behind hardened isolation.
- pi-predict, pi-voice: optional UI/voice assistants; not core coding-agent reliability.
- pi-natives: napi-rs JS-visible bindings for search/glob/AST, edit, shell/PTY, desktop, PDF/HTML/SVG/Mermaid, SIXEL, text/token utilities, clipboard, Git/VCS, media and performance. It is a large packaging/ABI/runtime subsystem, not an automatic lightweight dependency.

Other native modules enumerated in crates/pi-natives/src/lib.rs: appearance, applefm, ast, audio, block, clipboard, crash_handler, desktop, devicecheck, diff, edit, fd, file_lock, glob, glob_util, grammars, grep, highlight, hpatch, html, iofs, js, keys, live, mermaid, oauth_callback, pdf, predict, sixel, snapcompact, spelling, svg, utok, vcs, power, iso, prof, ps, pty, shell, summary, task, text, tokens, tty_writer, vectors, workspace (and conditional test/util modules). This is the **module registry**, not a claim that each item is a distinct user-facing built-in tool.

Rust migration principle: prefer stand-alone pure crates/algorithms when license and dependency graph allow; preserve OpenCode Bun client compatibility and Rust managed-effect owner. Profile actual hot paths first; N-API may add startup, packaging and ABI complexity. Native copy-paste without benchmarks is not automatically a faster product.

## 38.8 LSP, DAP and debugging

Sources: docs/tools/lsp.md, docs/tools/debug.md, packages/coding-agent/src/lsp/{tool,client,servers,edits,diagnostics}.ts, lsp/mux/daemon.ts, tools/debug.ts, dap/ subdirectory.
- OMP LSP tool has 14 named actions: diagnostics, definition, references, hover, symbols, rename, rename_file, code_actions, type_definition, implementation, status, reload, capabilities, request. Workspace diagnostics, server-initiated workspace/applyEdit, rename and code actions may mutate files or spawn external checkers, not uniformly 'read-only'.
- Shared LSP mux attempts per-project server reuse, but code in lsp/mux/daemon.ts lines ~290–318 **falls back to a local spawned server** on shared transport failure. Horizon's language broker must disclose/prohibit duplicate servers based on policy rather than blindly copying fallback.
- DebugTool exposes DAP session launch/attach, breakpoints, stack/scopes/variables, stepping, evaluate, memory operations and read-only status. docs/tools/debug.md lists 28 actions and adapter availability negotiation. Native program evaluation, remote attach, reverse DAP runInTerminal and debugger adapter launches are effectful and require hardened approval.
- **Gap against Horizon:** §37 has a language broker but lacks an equally detailed DebugAdapterBroker / DapSessionV1 lifecycle, authority, process/port leases and response/evidence schema. This is a clear candidate to add after P1.3/ExecutionHost.

## 38.9 Subagents, advisor/watchdog, eval, memory and collaboration

Sources: packages/coding-agent/src/task/index.ts, task/types.ts, docs/tools/task.md, docs/agent-hub.md, docs/advisor-watchdog.md, docs/tools/eval.md, docs/python-repl.md, docs/session.md, docs/collab.md, docs/hooks.md, docs/skills.md, docs/mcp-runtime-lifecycle.md.
- Subagent TaskTool supports selection, batch/parallel requests, task discovery, worktree contexts, progress/events and typed response aggregation. Horizon already has the more stringent task DAG, lease/fencing, evidence, stop and independent completion requirements; borrow UI affordances and typed mailbox receipts, not the host supervision model wholesale.
- Advisor/watchdog can run review with its own model/context and cost. Horizon must make any extra model, endpoint, budget and information access opt-in; cannot quietly invoke a second paid model or grant an advisor production writes.
- Eval retains Python/JS state across tool calls and can bridge tools; this is an ergonomic benefit. It is NOT a generic safe replacement for sandboxed ExecutionHost, especially when browser/computer preludes can reach real user applications.
- Sessions, forks, compaction, artifacts and shared live collaboration are mature subsystem references. Horizon's own Session Core remains canonical; do not port OMP's JSONL conversation system and create two owners.
- Plugins, skills, hooks, MCP and slash command discovery have implementation references; adapter capability is not authority. Unknown plugin code must not replace sealed Horizon ToolBroker/Guard/ExecutionHost.

## 38.10 Native terminal graphics and 'inbuilt editor'

Source: docs/tui-core-renderer.md, docs/tui-runtime-internals.md, docs/tui.md, crates/pi-natives/src/{mermaid,sixel,snapcompact,tty_writer}.rs, packages/tui. OMP owns terminal viewport paint/history, ANSI width and graphics feature detection; native Mermaid/SIXEL rendering can be attached to supported terminals. Horizon §31/§37 already specify isolation and fallback; add measured terminal capability/worker lifecycle tests, no full rewrite of OpenCode TUI without a performance justification. OMP's terminal input editor/composer is **not** proof that Horizon should replace the desktop CodeMirror 6 editor.

## 38.11 Licenses and code reuse rule

Top-level OMP LICENSE is MIT and attributes Mario Zechner, Can Bölük, Stencil Labs. Individual crate manifests inherit workspace licensing. But crates/pi-builtins/LICENSE contains notices for Brush and uutils; crates/pi-shell/Cargo.toml references a separate NOTICE for adapted minimizer code, and workspace/vendor contains additional upstream copies/patches. Retain license texts, attributions, component dependency records and modification notices when reusing; also verify license compatibility of downloaded grammars, embedded resources, native packages and upstream providers. 'Steal' here means legally reuse/adapt licensed code or reproduce architectural ideas, **never copy proprietary components, terms-bypassing OAuth logic, credentials or uninventoried vendored artifacts**.

Reuse approval requires: exact upstream SHA/path; license+dependency closure+notices; threat/authority review; target module+interface+test; reproducible benchmark; Linux/Windows parity; rollback. Preserve upstream OpenCode pin, its API contracts and current P1.2/P1.3 work.

## 38.12 HorizonCode comparison and proposed priorities (NOT automatically adopted)

| Topic | Current Horizon owner/docs | Source-backed value | Decision |
|---|---|---|---|
| Editing | §§14,20,22,32,33,37 | hashline+stale recovery, AST anchoring, small-model formats | P1 pure-engine spike after effect broker; stronger full digest/fence required |
| Code index/walker | §§30,33 | pi-walker/pi-ast scan/cache, invalidation, slow-path fallback | P1 benchmark for persistent RepoIntel; avoid stale decision authority |
| LSP | §§30,32,37.4 | shared mux, diagnostics, workspace edits | P1 add no-duplicate + mutation mediation tests |
| DAP | §33 tool catalog, §37 lacks full DAP broker | 28 operation categories + adapter selection | P1 write separate DebugAdapterBrokerV1 LLD before coding |
| Browser | §§31–33,37.3 | worker/tab lifecycle, observe IDs, attached safety, native trace | P1 extend BrowserBackend interface and tests |
| Desktop | §§14,18,37 partial | native AX/screenshot epochs, worker and focus model | P1 create DesktopAction/Observation contracts; strict OS sandbox policy |
| Web search | §§14,22,33,37 partial | provider adapter registry, query normalization, sources | P1 design explicit FREE/self-hosted/paid opt-in provider selection |
| Python/JS eval | §§14,22,33 | persistent kernels and artifact-backed output | P2 sandbox experiment only after P1.3 mediation |
| Shell/PTY | §§14,21,33 | native pi-shell/Brush embedded semantics | DEFER risky implementation, profile/measure first |
| TUI/Mermaid | §§31–33,37.8 | native raster/terminal capability negotiation | P1 add capability/failure/perf fixtures |
| Advisors | §§29–33 | separate reviewer, trigger/cost logic | OPTIONAL, user-approved pinned model/budget, no hidden second-model calls |
| Sessions | §§01–04,25 | JSONL fork/compaction architecture | DO NOT PORT; conflicts with OpenCode canonical Session |
| Extensions | §§16,29,33,37 | per-source registries and tool lifecycle | select collision/availability tests, preserve sealed owners |

## 38.13 Concrete regression/evaluation suite to add before adoption

EDIT: stale short-tag collision, unique safe recovery, 4MiB boundary, 256-path cache eviction, unsupported tree-sitter grammar, symlink/device and path escapes, concurrent user write, multi-file partial OS failure, newline normalization, no-op loop, small-model syntax slips.
INDEX: 50K-file warm/cold traversal, ignore/symlink loop, create/delete/rename invalidation, parser fallback, 1/4/16 simultaneous agents, trust of cached false negatives.
BROWSER: owned vs CDP attached/relay, network intercept bypass, navigation and frame invalidation, source-map confidence, renderer crash/worker recycle, persistent tab expiry, authenticated user confirmation, replay without duplicate click.
DESKTOP: read_only Eval arbitrary FS attempt denied at OS; screenshot-first coordinates, resized window invalidation, AX stale ref, focus user takeover, Wayland unsupported, clipboard scope, worker cancellation and partial effect reconciliation.
WEB: no auth and no payment, explicit provider, unsupported query directive, scraper bot failure, citations absent, paid provider hidden in chain MUST BLOCK, origin/secret redaction, 1/4/16 parallel source searches.
LSP/DAP: editor-owned server share, fallback duplication denied, root/interpreter mismatch, server workspace/applyEdit routes guarded, breakpoint/attach/eval mutations guarded, pause/restart/reconnect, tools launched by debugger fenced, unknown remote state.
NATIVE/TUI: N-API version/binary fallback, CPU baseline, Windows native add-on staging, startup import timings, terminal graphics unsupported, malformed Mermaid worker crash, cancellation to Rust worker, wasm grammar download refusal when offline.
AGENTS: duplicate child spawn, budget overshoot, parent cancel race, advisor consent, opt-in non-free model use and no surprise token charges.

## 38.14 Required next decisions before product changes

1. Approve the specific candidates to prototype; prioritize pure Rust edit/walker and typed browser/search/desktop/DAP contracts. Do not adopt every OMP subsystem as a new mandatory Horizon feature.
2. Create a separate source/target dependency+license+security matrix per reused crate, including exact Cargo graph and notices.
3. Make test-first small prototypes in isolated branches/worktrees, not broad upstream copies; each must beat or match existing OpenCode functionality under identical tests.
4. If approved, update §§20,29–33,37, §32 tests, §35 coverage matrix and machine-readable schemas together. Retain OpenCode canonical Session, Rust Guard, explicit model choice and P1.2/P1.3 dependency order.
5. Only then consider direct Rust/TypeScript code reuse. No edit of product runtime has been performed in this research pass.

## 38.15 Evidence caveats

This report is a source-grounded comparative analysis with pinned refs and selected implementation trace. It is **not** a line-by-line semantic read of every upstream code file, a running OMP acceptance suite, an independent performance benchmark, a verified security audit of its browser/desktop agent, nor a declaration that Horizon feature parity exists. See all-file doc/hash inventory for what was mechanically inspected; operator claims about successful sandboxing/performance remain unverified without local tests.

## 38.16 Complete first-party native binding inventory and scale

Machine-scanned all 47 pub-mod families in crates/pi-natives/src/lib.rs: 167 directly belonging Rust source files, 82,137 Rust lines and 536 candidate #[napi]-annotated declarations. A compiler could resolve a different effective public API (cfg guards, impl-scoped annotations, generated exports), so this is structural coverage, not 536 independently callable stable methods. Full exact per-file line/hash/symbol inventory is omp-native-rust-surface-inventory.json, with source paths, owning module and line numbers.

Large feature families: desktop (54 files / 30,011 lines), mermaid (33 / 12,821), utok (24 / 5,515), oauth_callback (9 / 4,891), grep (one 4,104-line module), VCS (one 1,559-line module plus 129 annotated declarations). This scale matters: native desktop or Mermaid are not tiny wrappers to paste into HorizonCode. Their platform deps, resource management, cancellation, packaging and failure tests are a project, not a simple toggle.

Compare Horizon §37.8 terminal renderer fallback with OMP mermaid/sixel/tty_writer but do not import the whole terminal/graphics runtime without an isolated subprocess worker performance and security spike. Native catalog includes 47 modules, of which some are internal-only; do not inflate user-facing tool counts.

## 38.17 Terminal UI, slash and provider follow-up

The follow-up source pass is [§39 OMP TUI, slash commands, models, providers and 409 settings](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md), with a [61-file source-pinned UI inventory](omp-tui-command-settings-inventory.json) and [separate model/search provider source roster](omp-provider-source-roster.json). [§40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md) proposes Horizon-specific UI contracts, preserving the existing OpenCode UI/runtime, agent/harness-vs-provider separation and Rust effect authority. All additions are research/proposed, not implemented.

## 38.18 Streaming, terminal visual figures and artifact storage follow-up

The detailed source trace is [§41](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md). OMP SVG fences show throttled incremental native raster previews; numeric tables can yield local chart SVG (default always) or optional judge-assisted smart charts; Mermaid is text-layout, and public omp stream is redacted screen row broadcast with [image] placeholders. A transient terminal figure is NOT by itself a durable artifact:// file. Source-pinned comparison only, not adoption.
