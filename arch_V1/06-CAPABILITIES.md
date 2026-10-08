# 6. OpenCode capability parity and reuse plan

“Parity” here means the user-facing capability relevant to local coding workflows,
not byte-for-byte compatibility with every hosted OpenCode service, release channel or
third-party extension. This matrix is a target plan, not a report that the capability
already works in HorizonCode.

| OpenCode capability | v1 decision | Horizon adaptation / owner | Known proof or gap |
|---|---|---|---|
| OpenCode repository and package graph | Physical source/base | Preserve package layout and upstream sync metadata; add Horizon packages/subtrees with dependency checks | Pin is `b1fe25ab…`; no source changes or integration validation performed |
| OpenTUI + Solid terminal shell | Retain | Extend TUI composition with Horizon views and fixed slots; kernel data only via typed app API | `packages/tui/package.json` pins OpenTUI/Solid and depends on Core/Plugin/SDK/UI; no runtime UX check |
| Solid web UI and shared components | Retain/adapt | Existing UI/session components consume Horizon projections and routes | Semantic coverage is partial; no parity test or browser run |
| Electron desktop shell | Retain as initial desktop path | Reuse current app shell; add Horizon service state and updater controls only through registered actions | Packaging/signing/release pipelines need a separate supply-chain audit |
| CLI and headless application | Retain/adapt | `hzcode` is the composition root; headless mode uses same service/action contracts | CLI/server paths reviewed selectively, not all commands |
| Public HTTP/API, SSE and WebSocket | Retain/extend | Keep Schema → Protocol → Server → Client generation; add Horizon routes and durable snapshots/replay | Generated clients are source artifacts; no generation run in this task |
| SDKs | Retain/adapt | Preserve generated client/SDK surfaces; add typed Thread/Run/effect APIs through owning protocol schema | SDK generation and compatibility checks not run |
| OpenCode `packages/llm` | Retain heavily as provider implementation | Provider protocols, route schema, stream normalization and usage flow through Horizon route/policy/secret snapshots | `@opencode-ai/llm` exists at pinned head; Core V2 uses it, but legacy application runner defaults to AI SDK |
| Provider/model catalog and picker | Retain/adapt | Catalog is advisory metadata; profile/explicit selection owns model choice; route snapshot pinned by kernel | No catalog refresh or live provider check; no model hidden cost optimizer |
| OpenCode Session V2 input inbox | Adopt concepts, replace authority | Kernel Thread input supports durable admit-before-wake, steer/queue promotion and exact retry; host adapter maps OpenCode APIs | Current V2 prompt admission is durable, but drain/coordinator is process-local |
| OpenCode Core V2 runner | Selected production turn runtime; adapt before app cutover | Route application features through Core V2 bound to kernel-owned ThreadStoreService; whole-response tool batch gate required | Current runner dispatches local tool calls as stream events arrive; product-route convergence and post-crash provider continuation are not established |
| Legacy `packages/opencode` Session loop | Migration/compatibility source only | Migrate remaining app features to Core V2; never run it as a competing production loop or transcript owner | Current legacy loop defaults to AI SDK; native `packages/llm` is opt-in with fallback |
| OpenCode Session SQL/database | Replace as production Thread authority | Kernel Thread log is canonical; host tables remain rebuildable UI/search projection, test adapter or migration source | Cross-version session migration, attachments, compaction and fork semantics are a major acceptance gate |
| Provider stream events and tool schemas | Retain/adapt | Keep shared typed event model; hold tool calls until complete response and validate the whole batch | Current V2 has streaming dispatch; this is an explicit divergence/required adaptation |
| Provider-hosted tools (`providerExecuted`) | Disable in governed v1 | Offer local mediated equivalents; only re-enable if a future protocol can authorize before provider execution | Current `packages/llm` marks these and callers skip local dispatch; Guard cannot govern prior provider execution |
| Built-in read/write/edit/shell/search tools | Retain schemas/UX, replace executor ownership | Kernel canonical Action/Effect + ExecutionHost; bounded args/results and workspace revision fencing | Existing OpenCode shell/permission path is not itself OS confinement |
| Permission prompts and allow/ask/deny UX | Retain presentation, replace authority | Durable Guard challenge bound to exact action/resource/policy/content digest | Process-local permission path is not a canonical authority or sandbox |
| TUI feature plugins, slots and keymaps | Retain model, harden lifecycle | Fixed UI slots, typed actions, generation pinning, collision checks and foreground-action token for navigation | Pinned repo contains TUI plugin specs/runtime; all feature behavior not reviewed |
| OpenCode server plugins/hooks | Compatibility worker only | Map supported hooks to declared Horizon capabilities; unsupported behavior returns `COMPATIBILITY_UNSUPPORTED` | In-process server hooks can affect headers/tools/env/prompt/permissions; not safe as unrestricted third-party code |
| MCP | Retain/adapt protocol | Tool listing normalizes into ToolDefinition; every call uses Guard/Effect; secrets explicit per server | Local stdio may inherit environment in current code; audit credential and transport paths before enablement |
| ACP and external agents | Retain/adapt | One AgentProfile registry and WorkerAdapter; report configured/observed/enforced separately | External peers may use hidden tools or refuse cancellation; honest mediation coverage required |
| Skills | Retain declarative format | Progressive disclosure; content cannot grant capabilities; tool selection still needs profile/policy admission | Skills and assets are inventoried; full runtime/trust path is not semantically reviewed |
| LSP and formatter registries | Retain definitions, replace process owner | ExecutionHost supervises binaries, package installation, env, workspace, output and cancellation | Install and launch paths require package-by-package review before claiming containment |
| Worktrees and workspace helpers | Reuse mechanics behind WorkspaceProvider | Kernel owns lease/fence/revision; each Attempt has isolated or serialized write scope | Must validate stale writer and cross-platform worktree behavior |
| Todo/checklist | Retain as advisory UI state | Never maps to canonical Task state or PASS | User-visible distinction required |
| Context Epoch and system context | Adopt/adapt | Kernel pins source generations and context digest; host renders deterministic prompt context | Must not treat context text or memory as authority |
| Repository intelligence | Horizon-owned service/worker | `hz-indexd` provides incremental generations, bounded queries and overlays; OpenCode file/LSP tools may be reused | This is a product delta; index freshness and graph accuracy need independent tests |
| Memory | Horizon-owned advisory service | Scoped records with provenance/generation, no mutation of specs/policy/evidence | Privacy, retention and prompt-injection controls required |
| Goals, managed Runs, Task DAG, budgets, workspaces, effects, recovery, evidence | Horizon kernel | New canonical services exposed to host/UI through typed APIs | None of these are supplied by an OpenCode Session alone |
| Hosted console/cloud features | Optional, never a local architecture requirement | Feature-detect and clearly show unavailable/remote-only capabilities | Hosted availability is not local parity |
| Workflows/plugins marketplace/LiteSPM | Defer beyond core parity | Declarative workflows compile to normal Run; one package lifecycle owner | No marketplace source, trust, signing or update acceptance in this task |

## Capability readiness language

Every feature reports distinct states such as `installed`, `discovered`, `launchable`,
`healthy`, `available`, `enabled`, `authorized for profile`, `authorized for Run`, and
`materialized in this Turn`. A catalog row is not proof of executable availability;
an enabled plugin is not permission for the model to use it. Readiness becomes
`verified` only after repeatable tests on the exact build/platform; `accepted` needs
the applicable release record. `unverified` means the required proof is absent;
`available` reports current capability availability, not verification or acceptance.

## Upstream synchronization

P0 creates the new main from the pinned upstream tree and verifies the untouched
OpenCode baseline. Production route convergence is a later integration gate after
canonical Thread migration and the whole-response batch/Guard gates pass; baseline or
isolated-fixture success does not authorize the unadapted runner to handle production
Threads or effects.

The repository records the upstream remote, exact base revision, license/notice obligations,
and each Horizon patch as a reviewable commit. Prefer narrow adapter seams over
copying code into a second implementation. Upstream updates must re-run compatibility,
security, migration, generated-client and provider fixture suites. The pinned commit
and package-local `AGENTS.md` files—not this architecture's source-review pin—govern future
source modifications.

## Pinned implementation references

- [OpenCode source at the selected base revision](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322)
- [OpenTUI-based TUI manifest and package dependencies](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/tui/package.json)
- [Provider protocol package manifest](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/llm/package.json)
- [DeepSeek Harness source pin used only as composition reference](https://github.com/deepseek-ai/deepseek-harness/tree/5badb15009ae1756c3afe0ae0cef1faafc290ccc)
