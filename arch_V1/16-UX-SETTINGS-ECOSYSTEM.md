# 16. UI, actions, settings and provider/model experience

Status: normative V1 UX contract. It describes presentation over existing owners; UI never becomes an authority store.

## 16.1 Surfaces

For V1, retain and adapt the existing OpenCode-derived **CLI/TUI**. Web and desktop application surfaces are post-V1; existing code in those packages is not a V1 product or acceptance requirement.

All surfaces expose the same conceptual state/actions:
- Session/chat;
- project/workspace;
- agent/harness/model selection;
- context/files;
- terminal/build/test;
- Goal/managed work;
- permissions/effects;
- artifacts/evidence;
- extensions/settings.

V1 layouts adapt to terminal capabilities while action semantics remain consistent across CLI/TUI entry points. Future surfaces must project the same state rather than introduce another owner.

## 16.2 Prompt bar

The prompt composer must expose:
1. selected AgentProfile/harness identity;
2. model selector constrained by that agent/harness compatibility;
3. optional Goal/managed-mode state;
4. attachments/context refs;
5. send/stop/interrupt state.

Changing the model does not silently change the harness. Changing agent/harness recomputes eligible models but does not silently bill/connect a new provider.

Draft text survives picker/modal/settings transitions.

## 16.3 One ActionDescriptor

Every user/model-invocable action projects from one canonical descriptor:
- action/capability ID;
- slash command and aliases;
- semantic icon key;
- description/help;
- arguments schema;
- availability/disabled reason;
- effect class;
- required scope/capabilities;
- owner;
- dynamic status summary;
- supported surfaces.

Slash completion, command palette, menu/button, keybinding, CLI/SDK representation and model tool presentation cannot diverge in execution semantics.

Alias resolves before Guard. Sealed built-ins cannot be shadowed.

## 16.4 Slash and command discovery

Autocomplete is searchable and keyboard-first.

Show:
- semantic icon;
- canonical command;
- concise description;
- current state where useful;
- disabled reason.

Use semantic icon keys with Unicode/Nerd/ASCII fallback and grapheme-aware width. Emoji/icon presentation never becomes the command ID.

## 16.5 Agent/harness/model provider hub

Compact picker:
- current Session model only;
- filtered by selected agent/harness.

Full hub:
- recent;
- role assignments;
- all models;
- providers/accounts;
- local runtimes;
- search/media/embedding/rerank providers where supported.

Model kinds can include chat, tiny, image, TTS, STT, search, judge, embedding, rerank and video. Presence in a catalog is not proof the endpoint is enabled.

For each model/provider show only source-backed metadata:
- provider/account/model;
- auth state;
- context/output limits;
- modality/tool/reasoning support;
- measured/declared speed with provenance;
- pricing class/value/freshness or unknown;
- availability/error;
- compatible harnesses.

No green/available state from static source files alone.

## 16.6 Role bindings

Optional workload roles can bind explicit model/provider/harness policy, such as default, fast, thinking, vision, architect, commit, tiny, memory, subtask, advisor, image, web, speech, dictation and judge.

Role binding is configuration, not automatic hidden routing. Fallbacks are explicit, scoped (global/project/Session where supported) and show cost/auth implications before use.

## 16.7 Provider connections

Reuse existing OpenCode/Horizon provider/auth ownership.

Supported connection forms according to adapter:
- OAuth/device/browser login;
- API key stored as SecretBroker/OS-credential reference;
- environment credential source;
- keyless local runtime;
- custom compatible endpoint with TLS/auth policy.

UI never stores or displays raw secret material after entry.

Test/refresh/discovery network requests show whether they can consume paid quota. Unknown cost is not free.

Search provider, model provider and agent harness are separate categories even if backed by the same company/account.

### Web search connections (V1, `DEC-V1-26`)

Built-in web search is configured in Settings as an ordered route list (§37.5):

- the built-in no-key route chain (Exa, You.com free profile, Tavily keyless search, Firecrawl Keyless, Parallel Search) is available by default, in the default order specified in §37.5; each provider may enforce its own anonymous rate limit;
- BYO-key providers (initial set: Brave and Exa; supported matrix expands only with sourced adapters; full matrix `DEC-V1-20`) each expose: enable toggle, credential source (SecretBroker/OS-credential reference; raw secret never displayed again after entry), cost class, freshness and health status, and a test/inspect action mapped to `web.search.inspect_provider`;
- enabling a provider adds it to the cascade; disabled or unconfigured providers are absent — no separate "off" step is required;
- cascade order is user-visible and reorderable; every enabled route joins one ordered chain;
- enabling a paid or authenticated provider records the user's consent for that route's cost/auth class; a failed free route can never silently hop to a paid provider that was not enabled;
- when every enabled route fails, the resolution shows per-route reasons and applies one bounded normal retry — a fabricated or silently substituted result is never returned;
- switching search routes never changes the selected model/provider/harness and never triggers hidden spend.

## 16.8 Settings

Settings are schema-driven and searchable.

Each field exposes:
- key and description;
- type/constraints;
- requested value;
- effective value;
- source layer;
- default;
- shadowed/locked state and reason;
- apply boundary: live, next turn, next Session, restart;
- validation error;
- reset/revert.

Scopes: system/default, user, project/workspace, Session where supported. The owning config service defines precedence.

Conditional settings hide/disable irrelevant controls without destroying stored values.

Theme/layout settings may live-preview and must be revertible.

## 16.9 Goal objective UI

Goal editor holds a draft only.

It supports:
- objective;
- scope/constraints;
- acceptance criteria;
- time/token/cost/resource budgets;
- external editor;
- review/diff when revising an accepted spec.

Submitting the draft creates/revises reviewable Goal/SpecVersion. It does not start effects. Start Run occurs only after accepted SpecVersion and normal permissions.

## 16.10 Permissions and operational state

Show:
- Ask/Safe Auto/YOLO-in-sandbox mode;
- pending approval with exact action/target;
- effect status including UNKNOWN/reconciling;
- selected model/provider/harness;
- budget/usage provenance;
- backend unavailable reason;
- managed Run/Task state without confusing it with Session state.

Do not show unsupported containment as safe.

## 16.11 Extensions

Agents, skills, hooks, MCP and plugins use 29.

The UI projects their:
- source/provenance;
- version;
- requested/allowed capabilities;
- trust class;
- enabled scope;
- conflicts/shadowing;
- health.

Installing/enabling executable extensions is an effect and may be unavailable pending release/security gates.

## 16.12 Accessibility and keyboard contract

- all functions keyboard reachable;
- focus restored predictably after modal/picker;
- no streaming update steals input focus or scroll;
- screen-reader labels/ARIA equivalent in GUI;
- terminal text fallback for every graphic;
- color is never the only status signal;
- narrow terminals collapse rather than truncate critical authority/cost/error state.

## 16.13 UX acceptance

Required end-to-end cases:
- agent selection filters model picker correctly;
- model change does not change harness;
- provider login failure preserves draft/state and no secret leaks;
- explicit project/global role binding and paid-fallback denial;
- alias/slash/button/keybinding dispatch same action ID;
- settings requested/effective/source/locked behavior;
- Goal draft survives external editor and cannot start work before acceptance;
- unsupported backend shows reason;
- permission/effect UNKNOWN is understandable;
- V1 TUI and CLI entry points expose equivalent underlying action/state.

Source inspiration may come from OMP or other products through 42, but this document is the only normative UI contract.

## 16.14 Built for the Future: verifiable beginner and expert flows

Brand: HorizonCode - Built for the Future. The public npm name is planned as horizoncode, with hzcode as the shipped short CLI command for the same entrypoint (amended 2026-10-18).
A user should understand: what the agent is doing, what changed, what was tested, what it costs and how to undo it. Beginner and expert UIs share one session/runtime, not separate engines.
V1 beginner journey: describe a coding change -> review/accept a clear plan when using managed work -> implement through guarded tools -> inspect the diff -> run tests -> independently verify the final revision -> explain evidence, cost and undo. Browser visual editing, hosted preview and deployment are post-V1.
Provider UI distinguishes authorized API keys/subscriptions, legitimate free offers, local models and the separate native OpenCode backend. Show restricted-model eligibility; unknown pricing is never free.
Selectively evaluate OMP SVG/Markdown/chart/model-picker UI patterns, with bounded rendering, accessibility and without importing an alternate session/control layer.

## 16.15 Optional Features and Experimental lifecycle (A-V2-29)

**Every user-optional product feature has a discoverable Settings entry before it is exposed for use.** Settings is the canonical user control, not necessarily a separate implementation switch: the existing owning config service stores the requested value and resolves precedence; other surfaces show the same effective state. Optional feature metadata is projected from its owning setting/capability and the shared `FeatureExposureV1` contract (§33), not stored in a second registry. Internal implementation strategies (such as automatic cache invalidation) need no user switch unless offered as a user choice; optional selectable algorithms, backends, agent modes, previews, optimizations and integrations do.

Use two **independent** axes:
- **Release class:** `stable | beta | experimental`. `experimental` is the exact class/tag for enabled developer testing and opt-in early-access features. It describes stability, not authorization or implementation completion.
- **Implementation/effective state:** §33 `DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED`, plus runtime `UNAVAILABLE` with reason; and `off | on | blocked | pending_apply | unavailable` resolved from requested setting, policy, build/channel, platform, dependencies and chosen model/harness. Never map `experimental` to “working.”

Feature exposure descriptor (shape in `contracts-v2/feature-exposure-v1.schema.json`) includes stable feature ID, owning settings key, class, description, optional/default state, exposure audience (`public | developer`), supported scopes, apply boundary, related canonical capability IDs, required runtime prerequisites and risk/cost notes. This contract is a **projection/validation type**, not a new runtime feature registry. A feature with no canonical tool/action (e.g. optional UI layout or search-backend choice) may have zero related capabilities. The setting key is unique and stable; renamed keys require a migration/alias without changing authority.

**Settings UX** (V1 CLI/TUI; web/desktop parity is post-V1):
- Settings → **Features**: searchable list of *all user-optional* features offered for that build/account; categories and current requested/effective/source/locked values, with `Experimental` and `Beta` tags. Experimental choices are also discoverable under Settings → **Experimental**, not hidden only in an undocumented config file.
- Every optional setting shows what it does, supported OS/model/harness, potential disk/CPU/token/network/cost impact, expected instability, dependencies, owner, apply boundary (`live | next_turn | next_session | restart`), reset/disable and precise unavailable/blocked reason. `UNKNOWN` cost is never displayed as free.
- User-optional stable/beta features may have a documented default; **experimental defaults OFF**, must be deliberately enabled, and never auto-enable after updates or route/provider changes. Developer-only experiments appear only in eligible developer builds/channels; do not expose a nonfunctional toggle or bypass release gates in public builds. A planned but unimplemented option can appear as disabled “Not available yet,” never an enabled fake feature.
- Switching changes only its declared config and does **not** itself invoke a paid provider call, spawn workers, mutate repositories, silently switch selected model/harness, relax Guard, or perform irreversible work. Effects still need normal action/approval/lease. A restart/next-session change shows pending state; a failed enable reverts or remains safely blocked with a reason.
- A mandatory security invariant, foundational subsystem or signed policy floor cannot be turned off by a feature setting. Experimental modules remain subject to the same Guard, sandbox, source-visibility, private-data rules, budgets and verification as stable modules.
- V1 TUI command palette/slash help/feature-specific pickers and status panels display the **same release class and effective enablement** as Settings, with a plain-text `[Experimental]` suffix and explicit unavailable reason (not color alone). Future GUI surfaces use accessible “Experimental” text/tooltip. API/SDK exposes metadata + requested/effective state and reason, not new bypass actions. Lifecycle status, release class and user preference must not be conflated.
- Promotion `experimental -> beta -> stable` requires reviewed reliability/security/compatibility evidence and versioned migration; existing explicit user preferences are preserved or an explicit migration is offered, never silently transformed into privilege or paid spend. Rollbacks disable the feature safely without losing user data or rewriting canonical sessions/effects.

**Examples (design only, not claimed implemented):** `native repository search (experimental, OFF)`, `Hashline edit dialect (experimental, OFF)`, `warm provider transport (experimental, OFF)`, `CoW worktree backend (experimental, OFF)`. **Snapcompact is DEFERRED/UNAVAILABLE in V1**, not an experimental toggle; its source feasibility is recorded in §16.15.2. Do not assign a setting or claim runtime support while a feature remains only a proposal.

### 16.15.1 Actual codebase integration status (2026-10-14)

**Snapshot versus live-overlay source truth (rechecked 2026-10-15):** the pinned upstream `opencode/` tree retains separate legacy `ConfigV1.Info.experimental`, Core V2 `Config.Info.experimental`, broad `OPENCODE_EXPERIMENTAL` flags and GUI-local `settings.v3` preferences; upstream alone did not implement Horizon `FeatureExposureV1`. **The HorizonCode first-party overlay now does** include `packages/core/src/v1/config/feature-exposure.ts`, `packages/tui/src/component/dialog-features.tsx` wired as `horizon.settings.features` (`/features`) in `packages/tui/src/app.tsx`, and `packages/app/src/components/settings-v2/features.tsx` wired into Features/Experimental tabs in `dialog-settings-v2.tsx`. `packages/core/test/config/feature-exposure.test.ts` covers a limited derived-projection slice. Status is **CODE_PRESENT/PARTIAL**, not absence of panels, and not evidence of FEAT-001..014, full config source/lock/precedence/pending propagation, API parity or any experimental backend being executable. The app GUI is outside V1 release scope; its code presence is not V1 acceptance. Bootstrap still preserves root overlays rather than replacing them from upstream.

Inventory optional user-facing features separately from internal legacy flags. Runtime-capable options must resolve from their existing **backend config owner**, including source precedence, channel, platform, dependent capability, Guard policy and effective state. GUI-local `settings.v3` cannot grant a backend capability. Broad inherited `OPENCODE_EXPERIMENTAL` must not count as individual opt-in for a newly governed HorizonCode experiment; preserve classified legacy compatibility deliberately rather than accidentally enabling all new experiments.

A settings write must preserve unrelated values, detect conflicting/stale updates, honor apply boundaries and return the authoritative effective state. If the current config source cannot report precedence/lock, display UNKNOWN rather than inventing provenance. A TUI checkbox is never authorization. Implementation targets and FEAT source-parity cases are §20.10.1 and §32.31.1.

The RepoIntel analysis profile (`lightweight | adaptive | full`) is a value in the existing config owner, projected through existing feature/config state; it is not another registry or authorization grant. Missing/invalid effective state is conservative `lightweight`. Changing it records requested/effective/source/pending state only; it does not start LSP processes, schedule indexing, call an embedding/provider endpoint, or warm a cache. Such work requires a later explicit query/action and normal Guard/resource admission. Under pressure, effective analysis may be narrower than requested, with a visible reason and no provider/model switch.

### 16.15.2 Snapcompact source feasibility (2026-10-15)

The pinned OMP source has two distinct mechanisms: `snapcompact-inline` transiently transforms only the outgoing provider-context view, while `/compact snapcompact` persists image frames and archive metadata in a compaction entry and restores image blocks on later context builds. Neither exists in HorizonCode. The current Core V2 runner has no implemented `ContextService`/`ContextLedger`; its resolved `@opencode-ai/llm` model lacks the source `ModelV2.Info.capabilities.input` metadata needed for exact-model image gating; compaction estimates JSON-serialized request data without provider image-token accounting; and no local text-to-PNG renderer is available. Existing media transport for user attachments does not prove that an arbitrary selected model accepts generated frames.

Decision: retain **DEFERRED/UNAVAILABLE in V1**, with no runtime code, setting, command or capability ID. If reconsidered, evaluate only a non-persisted projection owned by the future §30 ContextService; do not add a second Session/compaction owner, alter canonical history, publish frames through a blob sink, or change the selected model/provider. Re-entry requires same-model capability, token/count/request-byte budgets, source-text rebuild/disable, protected-fact fidelity, privacy/cache/cost measurements, payload/render recovery and rollback. Exact source and license/dependency provenance: §42 SRC-024. OMP tests and benchmarks are not Horizon evidence.

## 16.16 Resource, provider-health and multi-session product experience (A-V2-30)

V1 CLI/TUI project the same authoritative diagnostics and `FeatureExposureV1` state; a UI screenshot or tab never becomes a task/session owner. Show per-Session and aggregate memory **with explicit units and metric types** (Linux PSS/RSS, native Windows private bytes, local model RAM/VRAM separately), CPU/processes/FDs, worktree/disk use, running/queued/blocked headless workers, and measured/estimated/unknown provenance. Avoid false exact costs or cross-platform comparability. Web/desktop projections are post-V1.

- Session list: owner/provider/model/harness, current/last turn status, running child count, change conflicts, pending approvals, cost and quick resume; stable input focus when another Session streams.
- Provider Doctor: one discoverable action and settings entry, with `offline / catalog / full` tiers and a visible spend/privacy confirmation before real inference. Show endpoint, catalog freshness, ability to stream/tool-call, selected-model support and precise failure reason; never display API keys.
- Resource panel: component breakdown (host, kernel, workers, LSP/MCP, build, index/render cache, local inference) plus 1/5/10/20-session experiment results only if measured. Show pending cap, pressure action and cleanup policy; never imply a system-owned process is safe to kill unless lease owner is known.
- Conflict warnings: distinguish advisory peer file-touch from enforceable stale file digest/lease conflicts; offer inspect diff/retry/rebase/cancel rather than silently overwriting.
- Output: stable-prefix transcript plus bounded in-place tool-progress tail, source-linked diagnostic artifacts, idle/deep-idle redraw throttling and no scrolling/focus theft. Reveal full output by bounded read/artifact rather than permanently keeping raw stdout in RAM.
- Settings: optional long-lived shared-kernel candidate, memory recall and experimental self-dev appear only in correct eligible builds; `experimental` is a lifecycle label, not permission to bypass Guard or a claim that an unavailable backend works.
- Imported sessions: preview provenance, source platform, whether import is historical snapshot or native live connection, loss of unsupported features and explicit confirmation; never impersonate an external client.

UI acceptance lives in §32.32. Current source coverage is not inferred from these UX requirements.

## 16.17 Exact resource and concurrent-session UI behaviour

**One state projection** is consumed by V1 TUI/CLI and the existing SDK from the existing source owner; web/desktop consumers are post-V1. Every displayed availability badge resolves separately (a) DESIGNED/CODE_PRESENT/WIRED/TESTED, (b) stable/beta/experimental, (c) OS/provider/backend supported, (d) user requested/effective/locked Settings and (e) live health. No toggle can turn a design-only capability into an executable service.

| User action / surface | Inputs | Visible output / callback | Failure/approval |
|---|---|---|---|
| Session switch | canonical Session ID and client event cursor | stable focus/scroll, selected provider/model/harness, unread progress, bounded current tail | stale cursor resnapshot, no input replay without confirmation |
| Resource panel | owner scope, sampling interval, all-inclusive flag | process-tree PSS/RSS or private bytes by platform, shared kernel cost, local model RAM/VRAM, CPU/FD/disk, source/quality/age | unknown marked UNKNOWN; absent sampler does not show zero |
| Add headless specialist | accepted Task/Attempt or direct scoped read request, profile, max cost/concurrency | queue/reservation status, wait reason, child receipt/artifact refs, cancel | resource blocked, scope denial, provider unavailable; no automatic worktree |
| Provider Doctor | provider/model, offline/catalog/full tier, maximum time/request/spend | step-by-step redacted probe status, last test time, auth/model/stream/tool/cache provenance | catalog shows network permission, full shows estimated cap+explicit paid consent, aborted cost UNKNOWN |
| File conflict | file revision and peer advisory touch summary | diff and source revision, rebase/revalidate/retry/cancel | never write over user edit by auto-repair |
| Recall settings | project/user scope, local/remote selection, max tokens/results | last source list/freshness, enabled state and local resource impact | default off if non-local/unsupported, remote asks privacy/cost consent |
| External import | source store/platform, digest preview, historical vs native | provenance, field/feature loss and destination single owner | approval required; stale preview/reparse rejection |
| Experimental shared kernel | eligible build/OS, requested feature flag | safe restart/apply boundary, current fallback route, memory comparison only from measured data | unsupported platform disabled; rollback/error visible |
| Worktree/worker cleanup | confirmed owned resource identifier | preview safe vs dirty vs unknown, bytes measured and last lease | never “clean all”; dirty/quarantined requires review |

**Interaction law:** a user choosing a provider/model or changing an optional setting must see pending/effective state and whether a restart/new turn is required. UI only transmits typed user intent; the OS/process/Guard owner still checks actual execution eligibility. Resource pressure is not a reason for a silent provider change, automatic deleting caches owned by others or UI freeze. Render a reasoned unblock path (free owned safe cache, wait for Task, reduce selected concurrency, ask for approval) without claiming an unsafe shortcut.

**Acceptance:** all above controls keyboard accessible in TUI, labels readable for beginner and expert, no duplicate Session owners in UI, 20-session stream stays navigable, failures show exact source/metric/OS, unknown measurements truthfully unknown, changing or revoking a permission invalidates visible action controls, spend confirmation auditable and no hidden remote telemetry.

## 16.18 Checkpoint/rewind surface (LLD closure 2026-10-18)

One ActionDescriptor-backed surface (slash/menu/API) lists checkpoints with turn provenance and offers: restore code + conversation, conversation only, or code only — always preview-first. A changed workspace revision refuses Full restore; the UI offers an explicit SelectedPaths preview bound to an exact preview digest. Only conflict-free captured regular single-link files may be selected; dirty, untracked, conflicting and unselected paths remain untouched, and unsupported file-kind facts fail closed (§14.19). The surface states honest limits (external changes not captured, symlink/hard-link skips) and never claims code restore when only conversation state moved. Acceptance: CP-001/CP-002 plus the beginner journey's "explain evidence, cost and undo" step; keyboard accessible, no duplicate Session owner.
