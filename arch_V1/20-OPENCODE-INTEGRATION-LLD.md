# 20. OpenCode integration LLD

Status: normative source-placement map. Always inspect the live source before editing.

## 20.1 Existing local roots

| Root | Preserve/use |
|---|---|
| packages/core/src/session | canonical Session/input/event/store/provider-turn behavior |
| packages/core/src/tool | canonical host tool definitions/registry |
| packages/core/src/horizon | Horizon host integration/services |
| packages/llm/src | current provider/model/protocol transport; replaceable only through A-V2-27 |
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
| ContextService | packages/core/src/horizon integrated with Session/context code |
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

## 20.10 Optional Settings / Experimental metadata implementation seam (A-V2-29)

Feature exposure is a **projection of existing OpenCode/Horizon settings and §33 canonical capability metadata**, not an extra registry or authorization owner. Extend the existing config/settings descriptor materialization (locate live source/callers first) with `FeatureExposureV1` release class, optional setting ID, eligibility, scope, apply boundary, capability links and current resolved state. Reuse existing TUI settings/command discovery and the app/desktop settings presentation; no new store or independent toggle dispatch. One config change propagates to all surfaces; Guard/capability availability remains authoritative at action time. Do not create toggles for proposal-only services that appear executable. Required tests: §32 FEAT-001..010.

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

Implement first the actual config/flag inventory and read-only derived exposure; then safe persistence with revision/conflict semantics; finally actionable TUI/GUI controls and capability gating. Do not build a second feature registry or accept a GUI-local switch as approval of backend effects. Runtime acceptance is §32 FEAT-001..014, not mere schema validation.

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
