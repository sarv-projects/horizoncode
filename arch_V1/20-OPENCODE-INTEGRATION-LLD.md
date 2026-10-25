# 20. OpenCode integration LLD

Status: normative source-placement map. Always inspect the live source before editing.

## 20.1 Existing local roots

| Root | Preserve/use |
|---|---|
| packages/core/src/session | canonical Session/input/event/store/provider-turn behavior |
| packages/core/src/tool | canonical host tool definitions/registry |
| packages/core/src/horizon | Horizon host integration/services |
| packages/llm/src | current provider/model/protocol transport; replaceable only through A-V2-27 |
| packages/opencode/src/provider, packages/opencode/src/auth | source-of-record provider list, connection recipes and credential brokerage; standalone-SDK boundary mapped in §20.16 |
| packages/core/src/models-dev.ts, packages/core/src/plugin/models-dev.ts | Models.dev advisory metadata catalog, startup refresh and provenance |
| packages/opencode/src | compatibility/legacy OpenCode features that must be audited for bypass |
| packages/schema/src | shared OpenCode/Horizon host types where already established |
| packages/server/src | public API composition |
| packages/tui/src | terminal UI |
| packages/app/src | Solid app |
| packages/desktop/src | Electron desktop shell |
| kernel/src | Rust managed control, private protocol and future effect host |
| indexd/src | derived repository intelligence |

Do not invent a parallel direct-session/provider runtime, second Session store or general process supervisor. Provider transport may migrate only through A-V2-27, and the separately sanctioned native OpenCode adapter keeps its own explicit backend ownership.

## 20.2 Canonical integration seams

### Session/provider

Keep the existing SessionV2/direct continuation owner. `packages/llm` is the current provider transport, not a permanent authority: A-V2-27 may replace transport/catalog beneath the same Session owner. Horizon adds observation/correlation and guarded tool execution, never another direct transcript.

Core `SessionRunner` remains the ordinary direct TUI turn path. Managed work may enter through
the distinct `SessionPrompt` path to bind an Attempt; that entry must share the behavior and
acceptance contract in §15.21 rather than becoming a second provider/session runtime.
ContextService compilation is V1 for both paths.

The provider runner must:
- pin tool registry per request;
- collect the complete local tool batch;
- validate all local inputs before dispatch;
- route effects to kernel;
- record returned conversational results in OpenCode.

### Session observer

Existing supervisor/projection code is adapted to SessionLinkV1:
- authenticated private startup;
- source cursor/epoch;
- bounded redacted pages;
- exact ACK;
- restart/resnapshot;
- no message writes.

### Tool/Action registry

Use one canonical capability ID namespace from 33.

Existing ToolRegistry remains the host tool source; ActionDescriptor adds human/API presentation metadata. Aliases resolve to one canonical target before permission/effect classification.

CodeMode is V1 and belongs at the existing `packages/opencode/src/tool/code-mode.ts` / Core tool
composition seam over the pinned `opencode/packages/codemode` interpreter. It exposes the existing
`$codemode.search` progressive discovery surface over the exact currently authorized tool tree;
discovery never grants permission. Existing MCP tools may participate only as Core-owned adapters
routed through the same dispatcher, never through a helper-owned MCP client. Exact in-grant
workspace reads/edits do not prompt per call. Run the existing interpreter in a short-lived helper
process launched by the existing Rust ExecutionHost supervisor; do not add a Worker-thread runtime
or second supervisor. The fixed trusted packaged-runtime selector is
`horizoncode:codemode:bun`; V1 has no Node fallback. A bounded versioned stdio protocol carries
code, bounded tool definitions, call requests/results, cancellation and terminal status. Core
handles each complete wave through SessionSupervisor and the existing atomic ToolBatch/Guard/lease/
receipt path. HostKernel applies the fixed `CodeModeResourceProfileV1` before first instruction:
cgroup-v2 memory 536870912 bytes, CPU `100000 100000`, PIDs 64, and nofile 256; all are mandatory;
the schema-versioned profile digest binds these values. Retain one interpreter, with §15.5 limits:
64 calls across at most 64 sequential waves of up to 32 concurrent calls, 30 seconds, 64 KiB
source/output and the §37.24 payload bound. Without verified limits or packaged runtime, CodeMode
is unavailable on that backend.

### Guard bridge

Logical host interface:
- preflightBatch(proposedBatch, turnSnapshot)
- requestApproval(decision)
- executeAdmittedBatch(batchId, leases)
- reconcile(batchId/effectId)
- cancel(scope)

The actual function names should follow existing package conventions rather than creating a parallel framework.

## 20.3 Service placement

| Logical service | Placement |
|---|---|
| AgentProfile/Harness registry | packages/core/src/horizon or existing config composition |
| ContextService compiler (V1) | Core context assembly integrated with direct `SessionRunner` and managed `SessionPrompt`; canonical Session history stays with Core |
| RepoIntelService | host adapter over indexd/LSP/parser |
| ToolCatalog/ActionDescriptor projection | host over ToolRegistry + capability registry |
| Skill/Hook/MCP registry | host config/extension layer |
| Delegation adapter | host + Rust managed child lifecycle |
| BrowserBackend | packages/app/desktop/browser integration or supervised worker |
| DesktopAction backend | supervised OS worker invoked through Rust effect path |
| WebSearchBroker | host provider/service adapter with auth/cost policy |
| LanguageServiceBroker | reuse packages/opencode LSP where appropriate plus supervised service |
| DebugAdapterBroker | supervised worker; no new host authority |
| ReplBroker | supervised bounded Python/JS worker |
| Artifact service/renderers | existing host/TUI/app + durable store |
| UiEventMux | derived host/TUI/app stream |
| Automation | Rust durable schedule/control + host action dispatch |

All proposed services must first locate/reuse an existing compatible implementation before a new module is created.

For V1 LSP/DAP launch, reuse Core Config's existing configuration owner and project only a
trusted immutable launch profile to HostKernel. HostKernel remains the executable resolver and
the existing ExecutionHost remains the sole process supervisor. Do not forward OpenCode-derived
raw `command`/`env` values from the broker as authority, create a second process registry, or
let project/plugin/external config select an executable before its trust rules are implemented.
The projection's strict machine schema and fixtures belong to the owning process/profile
contract; until they are present and Guard/confinement admission is wired, launch stays disabled.

## 20.4 Existing versus proposed truth

Architecture labels:
- EXISTING: source path and tests observed;
- ADAPT: existing path remains owner but needs Horizon behavior;
- PROPOSED: no production implementation claim;
- DISABLED: intentionally unavailable pending a gate.

Do not convert PROPOSED to EXISTING because a schema/research source exists.

## 20.5 Upstream compatibility

Horizon patches should be narrow and source-owned.

For a pinned OpenCode upgrade:
1. diff exact upstream range;
2. classify touched Horizon seams;
3. run parity/contract/security tests;
4. regenerate generated files with pinned generators;
5. update 42 pin only after acceptance.

No blind merge/main tracking.

## 20.6 External source extraction

Use 42 only for a specific missing/optimized algorithm.

Preferred adaptation:
- Hashline logic inside existing files.patch;
- native walker/grep/AST behind existing RepoIntel/search;
- OMP browser/desktop lifecycle ideas behind Horizon Guard;
- OMP UI/render ideas inside existing TUI/app owners.

Never copy OMP AgentSession/history/tool authority, unrestricted Eval, unbounded queues or hidden paid routing. Direct inference transport/catalog may be selectively adapted only through A-V2-27.

## 20.7 Required implementation evidence

Each integration slice records:
- exact existing file/functions/callers;
- modified files and source revision;
- owner and capability IDs;
- schema/wire changes;
- positive + negative/restart tests;
- performance/platform result;
- known unsupported paths.

Current progress belongs in HANDOFF.md.

## 20.8 OMP transport vs native OpenCode adapter

Keep one canonical owner per conversation. The direct Core session may call a selective OMP pi-ai/pi-catalog transport, but must never import OMP AgentSession or a second tool executor. The native OpenCode adapter is an independent process/client for the official upstream binary, with version probe, health, session linking, event stream, cancellation, approval, restart and error handling. Test both modes without dual ownership. No free-Zen client impersonation. See decision A-V2-27 and session/Guard acceptance gates before enabling effects.

## 20.9 Reserved section number

This numbered heading is intentionally unallocated after the 2026-10-11 lean consolidation.
Do not cite `§20.9` as a product requirement. Use `§20.12` for the source wiring map and
`§20.13` for post-V1 adapter seams.

## 20.10 Optional Settings / Experimental metadata implementation seam (A-V2-29)

Feature exposure is a **projection of existing OpenCode/Horizon settings and §33 canonical capability metadata**, not an extra registry or authorization owner. Extend the existing config/settings descriptor materialization (locate live source/callers first) with `FeatureExposureV1` release class, optional setting ID, eligibility, scope, apply boundary, capability links and current resolved state. Reuse existing V1 TUI/CLI settings and command discovery; app/web/desktop settings presentation is post-V1. No new store or independent toggle dispatch. One config change projects into each available surface; Guard/capability availability remains authoritative at action time. Do not create toggles for proposal-only services that appear executable. Required tests: §32 FEAT-001..010.

### 20.10.1 Source-bound Settings and Experimental integration audit (2026-10-14)

Current PR branch has first-party changed overlays in `packages/core/`, `packages/opencode/` and the Rust kernel, plus pinned source `opencode/packages/`. `scripts/architecture/bootstrap_source.py --apply` hydrates missing root `packages/*` files from that source, preserving root overrides. Inspect the **hydrated root implementation and overlay visibility** before editing; do not assume each snapshot file is already present as a tracked root file.

| Source inspected | Existing owner/role | Missing feature-exposure work |
|---|---|---|
| `opencode/packages/core/src/config.ts` and `config/experimental.ts` | Core V2 config and narrow experimental policy schema | Derived descriptor/effective-state resolver; eligibility/precedence |
| `opencode/packages/core/src/v1/config/config.ts` and `v1/config/migrate.ts` | Legacy config and migration | Preserve/translate intended legacy experimental settings; current migration forwards policies only |
| `opencode/packages/opencode/src/config/config.ts` and `effect/runtime-flags.ts` | Instance config writes and environment controls | Per-feature explicit opt-in, blocked/locked sources; inherited broad `OPENCODE_EXPERIMENTAL` must not grant new Horizon experiment |
| `opencode/packages/opencode/src/server/routes/instance/httpapi/groups/config.ts` and `handlers/config.ts` | Existing read/update API | Expose derived effective state and safe updates without new policy authority |
| `opencode/packages/app/src/context/settings.tsx` | GUI-local persisted `settings.v3` | Keep presentation-only prefs separate from backend execution configuration |
| `opencode/packages/app/src/components/settings-v2/dialog-settings-v2.tsx` | GUI settings tabs | Add Features/Experimental UI from server-derived snapshot |
| `opencode/packages/tui/src/app.tsx`, `component/command-palette.tsx`, `component/dialog-status.tsx` | Existing TUI commands and status | Keyboard-reachable optional Settings; class/effective-state labels and disabled reasons from one projection |
| `opencode/packages/tui/src/config/index.tsx`, `opencode/packages/core/src/flag/flag.ts` | TUI preferences and inherited env flags | Not independent runtime authorization or substitute for Settings |

**Live overlay status correction (2026-10-15):** unlike the upstream rows above, Horizon overlays already contain a first-pass derived projection in `packages/core/src/v1/config/feature-exposure.ts`, a TUI `horizon.settings.features` action linked from `packages/tui/src/app.tsx`, and Features/Experimental tabs wired in `packages/app/src/components/settings-v2/dialog-settings-v2.tsx`. `packages/core/test/config/feature-exposure.test.ts` verifies limited pure helper behavior. This is **CODE_PRESENT/PARTIAL**, not a missing-panel design; SourceConfig supports a narrow compaction subset and the unfinished precedence/lock/pending/auth/API parity must not be inferred implemented.

Complete the remaining config/flag inventory and safe persistence with revision/conflict semantics; then enforce the same authoritative effective state, source and capability/Guard gating across TUI/GUI/CLI/API. Do not build a second feature registry or accept a GUI-local switch as approval of backend effects. Runtime acceptance is §32 FEAT-001..014, not mere schema validation.

## 20.11 Source-level seams for JCode-informed optimization (A-V2-30)

Source observation on `main` at `4e2086633d006f7d8b7709cb0df622f77a9b8d54` (recheck before implementation):

| Requirement | Existing source owner / insertion point | Truth |
|---|---|---|
| Session resource multiplex | `packages/core/src/session/supervisor.ts`: `openForSession`, `watchSessionLoop`, `activeClients`; `kernel/src/bin/session_supervisor.rs` | Per-session Linux process **exists**; shared daemon **not implemented** |
| Rust durable control/recovery | `kernel/src/managed_control.rs`, `owner_log.rs`, `effect_host.rs`, `request_cancellation.rs` | Real primitives; managed executor and universal Guard **not complete** |
| Provider Doctor | current `packages/llm/src` transport, host provider/config/secret owner and command/API projection | **Proposed** diagnostic adapter; no second credential store/model catalog |
| Headless worker | existing Session runner + Rust Attempt/worker lease/ExecutionHost, client-independent request/result API | **Proposed**; do not spawn one full TUI/host per specialist |
| File-touch/conflict projection | workspace/file events + `files.patch` revision checks and Rust workspace lease/fence | **Proposed** advisory read/write index; never replace authoritative hash/fence |
| Memory accounting | existing host process/supervisor, Rust state/resources, indexd, TUI/app rendering | **Proposed** attributed metrics; no estimated vendor PSS as runtime truth |
| Adaptive rendering/tool tail | `packages/tui/src` and existing Session event/UiEventMux owners | **Proposed** bounded stable-prefix + dirty-region scheduling |
| Context/cache | current Core Session runner and context, `indexd/src/lib.rs` generation/overlay | partial foundations; cache audit/controlled eviction **proposed** |
| External session import/resume | SessionLink/external native adapter via existing API, read-only metadata import | **Proposed**; never claim imported transcript is live dual-owned |

Do not migrate JCode's entire agent/session tool runtime. Preserve exact Horizon capability IDs and approval/receipt path; add a measured adapter inside the owning package only. For every proposed seam, inspect all call sites, update typed protocol/contracts as needed, test callback/cancel/UNKNOWN cases and record the implementation status in HANDOFF before enabling the UI. Pin JCode source paths/licensing and confidence in §42.

## 20.12 Source-exact implementation wiring map and cutover constraints (2026-10-15)

**Repository is a hydrated overlay.** Many `packages/*/src` code files are not individually committed at root; `opencode/packages/*/src` contains the pinned originals and `scripts/architecture/bootstrap_source.py --apply` materializes missing root source without overwriting Horizon overlays. Absence from the root Git tree does **not** mean a service is missing after bootstrap; conversely a design Markdown under `arch_V1` is not source code. Verify `--check`/`--apply` in a disposable checkout, then inspect the *effective hydrated root* before editing. Never modify both source snapshot and overlay independently for the same feature without a clear future source-sync plan.

| Work unit | Confirmed tracked override / pinned inherited source | Required patch/callers |
|---|---|---|
| Multi-session observer | `packages/core/src/session/supervisor.ts`, `kernel/src/bin/session_supervisor.rs`, `kernel/src/{supervisor_session,subscription,session_projection,protocol,transport}.rs` | Keep exported `SessionSupervisor.Service` types; add feature-negotiated attachment adapter and Rust broker, reuse per-Session binary until security and PSS benchmarks |
| Guard execution | `packages/opencode/src/session/tool-batch.ts`, `packages/core/src/session/runner/llm.ts`, `packages/core/src/tool/{tool,registry,write}.ts`, `kernel/src/{guard,effect_host,request_cancellation,terminal_process}.rs`, `horizoncode-sandbox/`; inherited `opencode/packages/opencode/src/session/{prompt,tools,llm}.ts` | Terminal and non-PTY process paths prepare and require Linux sandbox guarantees before dispatch; map every other effect origin before dispatch; bounded complete batch, authenticated Rust Guard, prepare/lease/receipt and UNKNOWN per capability |
| P2 scheduler | `kernel/src/{managed_control,owner_log,owner_log_index}.rs`, managed tests; existing host Session correlation | Add authenticated managed RPC, accepted spec version body and source digests, Task DAG admission, resource leases, worker execution, independent verifier; never write a Rust copy of conversation history |
| Process resource metrics | Rust kernel owns worker/execution lease identities; host supervisor owns known process spawn; inherited OS process abstractions | Attach process-start fingerprint and OS quota sampler, deduplicated tree accounting, redacted UI projection; no process-manager bypass |
| Headless workers | inherited Core/legacy direct Session runner plus Horizon Rust Attempt identity; §14 single ExecutionHost | Client attachment to existing model/provider Session if read-only, OS-supervised worker for effects; no full TUI or automatically new worktree per helper |
| Provider Doctor | pinned `opencode/packages/llm/src/` (transports/catalog/client), `opencode/packages/core/src/` (provider/config) and tracked `packages/opencode/src/session/{llm,hosted-tools}.ts` | Prefer existing selected-provider client/catalog/auth; three tiers share existing SecretBroker and accounting, no second credential/cost registry |
| Context/index/cache | `indexd/src/lib.rs` immutable `BaseGeneration`, `BufferOverlay` and cursor; Core prompt/context and inherited LSP | Generation- and owner-scoped cache, context token compiler, optional locally scoped recall; do not claim symbol/reference persistence from lexical index |
| File-touch and edit conflicts | existing file tool handlers and guard workspace write handler, canonical source rev; inherited repository watchers | add **derived** file-touch reverse index and event emission; authoritative checked digest/lease remains Rust Guard and file tool |
| TUI redraw / live tool-tail | tracked `packages/tui/src/app.tsx` and inherited `opencode/packages/tui/src/` rendering/stream widgets; UI event projection | Patch actual hydrated TUI event scheduling, stable prefix + bounded tail; do not fork terminal renderer |
| Settings/experimental | `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/dialog-features.tsx`, `packages/app/src/components/settings-v2/features.tsx` | Project same effective FeatureExposure across CLI/TUI/desktop, disabled backend + release class independent of runtime availability |

**Required call-site procedure for a new capability:** locate the single ToolRegistry registration and ActionDescriptor/§33 ID; bind effect class and scopes; locate the provider stream/callback, direct invoke path, script/CLI and plugin/MCP route; route **all** effectful variants through §14 Guard; propagate Session/Run/Attempt/worker IDs and cancel generation; expose only supported negotiated backend capability; add negative tests for each alternative entry point. Never accept “works in one route” as universal effect coverage.

**Full test path:** regenerate/synchronize any `contracts-v2` machine boundary only in its owner, run schema validation, compile Rust/TS generated signatures, test actual Unix IPC/private authentication, duplicate request, wrong Session and file race, then run focused push gate and full monorepo gate. Before native Windows claims, implement named pipe ACL, Job Object containment, durable storage semantics and platform-specific process metrics rather than treating WSL as native Windows.

**Measured branch migration:** zero changes to canonical Session storage or provider catalog, no second Rust Task database, no extra independent shared daemon besides one selected host-kernel effect owner. Shared observer prototype is intentionally read-only; effect cutover is a **separate** guarded, fully tested commit. Keep feature flag OFF on unsupported OS and preserve old supervisor for rollback. Record exact current source paths, hydrated-file diffs, tasks/test IDs, CI runs and benchmark before marking WIRED.

**Snapcompact source boundary:** OMP provides both a transient outgoing-context imaging transform and a separate persisted archive-compaction method; neither is inherited from the pinned OpenCode substrate. The only future Horizon target is a derived projection owned by the existing V1 §30 ContextService in the existing Core direct Session. Do not import OMP `AgentSession`, add a second compaction/history owner, or enable a transform before exact selected-model capability and image-aware budget checks. Current feasibility and source provenance are §16.15.2, §30.4 and §42 SRC-024.

## 20.13 Previously under-specified ACP client, visual-source and deployment wiring

The active §03.16–18 user journeys and §29 AgentProfileV2 adapter kinds already accept these product behaviours. §§37.20–21 are the function/service boundary and §32.35 the test contract. These are **not currently wired Horizon features**.

| Functionality | Confirmed existing source | Required Horizon integration, one owner |
|---|---|---|
| ACP agent **server** for connecting external ACP clients to OpenCode | pinned `opencode/packages/opencode/src/acp/{service,agent,session,event,permission}.ts` and `opencode/packages/opencode/src/cli/cmd/acp.ts`; accompanying upstream tests | inspect exact hydrated versions/overrides; preserve its own OpenCode Session ownership and existing authenticated server semantics |
| ACP **client** that delegates Horizon tasks to an external coding agent | `AgentProfileV2.adapter.kind="acp"` is a schema field; **no independently verified Horizon ACP client at this audit** | implement an outbound client adapter through current AgentProfile/DelegationMailbox and Rust WorkerExecution/Guard; never mistake server-side SDK import for outbound client |
| Native external OpenCode runtime | §17 A-V2-27 and §20.8 adapter strategy; source-side agent runtime exists | one explicit native backend owner and SessionLink, owner authentication and version/support negotiation; don't merge native messages into direct Horizon store |
| Visual source selection | existing pinned browser preview, React/Solid app and DOM/source tools under `opencode/packages/app/src/`, `opencode/packages/opencode/src/`; exact hydrated paths must be located before editing | UI/browser observation adapter + RepoIntel/source-map resolver, versioned candidate hashes, user review, ordinary guarded `files.patch` |
| Deployment/rollback | normative §03.18 flow; no verified dedicated Horizon deployment adapter/CLI API | new narrow adapter under existing host service composition with Rust Guard for remote mutation, SecretBroker refs, target-side idempotency/reconciliation and independent health criteria |

**Do not retrofit authority into upstream ACP code.** ACP session-creation, resume and outbound tool-capability support must be feature-negotiated; an agent reporting tools does not establish their mediation or permission safety. Treat external agent messages and DOM/hosted deployment responses as untrusted inputs. All effectful launches/upload/rollback must first pass existing §14 Guard; unsupported hosted/native effects are unavailable in governed mode. Reuse current §33/`contracts-v2` registries rather than adding an unofficial capability namespace.

**Source verification procedure:** bootstrap pinned source in disposable, unmodified checkout; enumerate effective root files; locate exact server/host/worker entry points and tests; bind candidate §33.30 IDs only after implementing adapters; generate machine schemas; add §32.35 negative platform/security/protocol/remote-failure cases; record code-path, CI, release support and stage (DESIGNED versus WIRED) in HANDOFF.
### CodeMode integration seam status (2026-10-22)

The existing CodeMode package and interpreter are retained. The model-visible registry
currently assigns CodeMode as unavailable; the wrapper executes in-process and nested MCP
calls fail before dispatch. Therefore this package is not an integrated agent feature.
P5 owns the Core adapter, exact authorized catalog/discovery and model-visible registry;
P1 owns the helper-process protocol, ExecutionHost/cgroup admission, nested ToolBatch
mediation and recovery. The adapter must reuse the existing interpreter and Core tool
tree, with no raw MCP client or parallel permission path. Do not expose the tool until
the full CM-001..012 contract in §32.41 passes. See §37.24.

### 20.14 External editor integration (DEC-V1-33)

Keep prompt composition in the existing TUI editor. The normal TUI starts in a single-pane
session and does not mount an Explorer/editor pane or persistent sidebar. `/editor` is the
explicit command that opens the workspace Explorer as an overlay; `/editor --side` opts
into a right-side Explorer/editor pane for that session. File selection plus Open invokes
the user-only `editor.launch` action with the configured profile. Prompt scratch editing is
available only inside this command flow. Settings → Editors is reached through `/settings`.
`packages/tui/src/editor.ts` adapts `editor.launch`: suspend/resume the renderer for
terminal profiles, and wait for the supervised process for GUI profiles. It does not call
Node/Bun `spawn`, parse `$EDITOR`, construct shell text, or decide Guard policy. Core
Config projects `ExternalEditorProfileRefV1`; HostKernel resolves it and routes launch
through the existing ExecutionHost. The registered file chooser supplies the target and
expected revision. The operation is available only in an interactive TTY and only when
the selected permission mode/backend supports the required containment. Prompt scratch
and workspace file paths are separate target kinds. See §§12.22/14.29/16.20/37.28 and
`contracts-v2/external-editor-profile-v1.schema.json`.

**Current source status (2026-10-22):** `/editor` command registration opens the P3
authenticated Explorer overlay and default rendering stays single-pane. Global immutable
profile selection is exposed through Core Config and `/settings` → Editors. The P1
EffectHost journal seam exists, but P2 has not yet landed public HostKernel
`editor.prepare/begin/settle/reconcile` plus existing `terminal.v1` attachment routing;
the TUI does not yet suspend/resume into an editor process, and no post-exit content
digest/revision check feeds `files.patch`. Keep file Open launch disabled until those
bridges and OS containment acceptance land. Never use the legacy OpenCode `openEditor`
or any Core spawn path as a substitute.

## 20.15 Git workspace read integration seam (V1, §17.31)

**Owner:** Core tool handlers for `git.status`, `git.diff`, `git.log`, `git.show`, and
`git.branch.list` project bounded arguments only; HostKernel `GitWorkspaceReadServiceV1`
(`§37.29`) is the sole execution authority.

**Call path:** `packages/core` / `packages/opencode` tool registry → authenticated
HostKernel private IPC (`execution.v1/git_workspace_read` or equivalent negotiated feature) →
Guard read admission → fixed argv `git` launch via existing `TerminalExecutionServiceV1` /
ExecutionHost → bounded stdout/stderr capture → EffectHost receipt or artifact ref.

**Non-goals:** no Core `AppProcess.spawn` of `git`, no shell string assembly, no RepoIntel
`repo.tree` substitution, no network `fetch`/`push`/`pull`, no write operations on this seam.

**Contracts:** operation IDs and argument bounds align with `§14.28`; acceptance `§32.46`.
Mutating `git.*` capabilities remain on the ordinary guarded tool path with separate handlers.

## 20.16 Provider layer as a standalone SDK boundary (2026-10-23)

**Status:** normative source map. The provider layer is **not** a parallel provider runtime; it is the
existing first-party OpenCode-derived provider implementation, isolated and mapped so pinned
upstream updates can be applied predictably. Authority remains A-V2-27 as amended in §17.7.

### 20.16.1 Mapped source roots

| Concern | Local owner | Upstream pinned path |
|---|---|---|
| provider registry, bundled adapters, defaults, display identity, managed-route projection | `packages/opencode/src/provider/provider.ts` | `packages/opencode/src/provider/provider.ts` @ pin |
| provider transform/options | `packages/opencode/src/provider/transform.ts` | same path @ pin |
| provider errors/classification | `packages/opencode/src/provider/error.ts` | same path @ pin |
| provider auth facade | `packages/opencode/src/provider/auth.ts` | same path @ pin |
| model status projection | `packages/opencode/src/provider/model-status.ts` | same path @ pin |
| DigitalOcean catalog adapter | `packages/opencode/src/provider/digitalocean-catalog.ts` | no matching path at pin; retained adapter lineage is local `provider.ts` |
| provider doctor diagnostics | `packages/opencode/src/provider/doctor.ts` | Horizon-owned offline/full-tier projection; no matching path at pin |
| login/OAuth/device/API-key flows | `packages/opencode/src/auth/index.ts` | `packages/opencode/src/auth/index.ts` @ pin |
| one-shot direct route transport | `packages/opencode/src/auth/provider-transport.ts` | Horizon-specific hardening; upstream call shape only |
| credential lease/version/revoke | `packages/opencode/src/auth/secret-broker.ts` | Horizon-specific hardening |
| advisory metadata catalog + startup refresh | `packages/core/src/models-dev.ts`, `packages/core/src/plugin/models-dev.ts` | `packages/core/src/models-dev.ts` @ pin |
| exact route projection match | `packages/core/src/session/provider-request.ts` | Horizon-specific hardening |

The local file `packages/opencode/src/provider/UPSTREAM.md` carries the same map plus the
update checklist. It is documentation, not authority; this section and §42 win on conflict.

### 20.16.2 Invariants

- Provider list and credentials have exactly one source: this layer. No second catalog, registry or
  credential store.
- Models.dev metadata is advisory only (models, costs, consumption, capabilities). It cannot enable a
  route, prove freshness, or override a user-selected provider/model/harness.
- `opencode` (OpenCode Default) and `opencode-go` (OpenCode Go) are explicit provider identities and
  keep their upstream names in the picker and route projection.
- Direct dispatch stays fail-closed: exact route match, SecretBroker lease, no forbidden credential
  headers, bounded request/response, possible-send ambiguity is UNKNOWN and never replayed.
- Startup metadata refresh is one bounded attempt per process start with last-known-good cache
  fallback; failure is observable and never blocks session start or silently substitutes a route.

### 20.16.3 Pinned-update procedure

1. Fetch the upstream revision and record it in §42 before touching local source.
2. Diff each mapped file and its callees/tests; classify REUSE / ADAPT / ADAPTER / REJECT per change.
3. Re-apply Horizon hardening (Guard/SecretBroker/transport bounds/route projection) where the
   upstream file is replaced; never take upstream wholesale over a hardened local boundary.
4. Update `packages/opencode/src/provider/UPSTREAM.md` and the §42 pin.
5. Run the provider/auth/models-dev focused suites and P6-PROVIDER-001..004; only then update status.

## 20.17 First-party HorizonCode identity migration (V1, §17.7)

**Owner:** parent coordinates this cross-cutting migration; each phase owner keeps authority over
its package/source/test paths. It is staged by dependency boundary, not performed as a blind global
replacement.

| Boundary | Required V1 result | Preserve / guardrail |
|---|---|---|
| CLI/artifact/package metadata | HorizonCode-owned public commands, package/artifact names, container/Nix entrypoints and build identity use `horizoncode`; `hzcode` is the same runtime | Keep one executable/runtime; retain tested `opencode` compatibility aliases only where required |
| First-party workspace packages/imports/generated bindings | Rename only Horizon-owned package IDs/scopes and internal imports after mapping every workspace dependency, generated client, lockfile/importer and package script | Keep genuine upstream package/API IDs and vendor packages; never edit the pinned `opencode/` source snapshot to make the migration appear complete |
| Typecheck/build/workflow identity | Product-facing commands, output paths, candidate selectors, workflows and help use HorizonCode; full typecheck still covers the product CLI host, TUI and Core | Source directories may remain `packages/opencode` when they are hydration/compatibility locations; prove exact `bun.lock`/workspace resolution and rollback per stage |
| First-party non-legal prose | Replace competitor product naming in Horizon-owned product/architecture prose where it describes HorizonCode itself | Preserve legal attribution, immutable provenance pins, actual upstream behavior citations and explicit compatibility facts; do not falsify authorship |

### 20.17.1 Migration procedure

1. Inventory package manifests, workspace edges, import aliases, generated clients, build targets,
   config/environment names, CLI docs, user-visible strings and release scripts. Classify every hit
   as Horizon-owned identity, true upstream/vendor identifier, legal/provenance fact or compatibility
   contract before editing.
2. Choose one bounded dependency layer; update its manifests/importers/lockfile/generated references
   atomically. Do not overlap active phase typecheck inputs or mutate upstream snapshot roots.
3. Test first: package resolution + focused typecheck/build + callers/tests + old compatibility alias
   behavior. Keep a reversible alias for any existing workspace consumer until the migrated graph
   passes.
4. Run full `horizoncode:typecheck`, overlay visibility, distribution audit and `NAME-001..004`
   after the final identity stage. Update §42 only if source pins/provenance change; product renaming
   does not change upstream provenance.
5. Report remaining external/legal/compatibility identifiers explicitly. A zero-string grep is not
   the success criterion; correct ownership and functioning compatibility are.
