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

The default session is a single pane: no workspace Explorer, editor pane, or persistent
right sidebar is shown or mounted as the initial view. The user opens workspace browsing
only with `/editor`, which opens the Explorer as an overlay. Selecting a file and choosing
Open launches the saved external editor profile. `/editor --side` explicitly opts into a
right-side Explorer/editor pane for that session; closing it returns to the single-pane
view. Settings → Editors, reachable through `/settings`, lists immutable user-owned
profiles, shows resolved executable identity and launch mode, and offers Add, Edit, Remove,
and Test launch. Terminal profiles such as `nano`, `vi`, `vim`, and `nvim` use a foreground
TTY handoff; GUI command profiles such as `subl`, `code`, and `zed` must include their
wait-for-close option. Profiles are argv arrays, never shell strings. Prompt scratch editing
is also an explicit `/editor` action, not a permanently visible composer control. Workspace
editing starts only from an explicitly selected file and settles a revision-checked
`editor.launch` effect. Unsupported containment is shown with a reason; explicit Full
access remains available with its warning. This does not claim a VS Code/JetBrains
extension or ACP integration.

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

The user-only `/editor` command and `/editor --side` layout option are registered in this
same descriptor surface. `/settings` → Editors owns profile selection. Neither editor nor
Explorer is a startup panel, persistent sidebar, or model-visible tool.

## 16.4 Slash and command discovery

Autocomplete is searchable and keyboard-first.

Show:
- semantic icon;
- canonical command;
- concise description;
- current state where useful;
- disabled reason.

Use semantic icon keys with Unicode/Nerd/ASCII fallback and grapheme-aware width. Emoji/icon presentation never becomes the command ID.

### 16.4.1 Canonical slash map (V1 direct session — migration parity)

One ActionDescriptor ID per row. **Heritage** slashes from OpenCode remain valid aliases;
normative context names from §30.3 are preferred in help text.

| User-facing slash | ActionDescriptor / intent | Notes |
|---|---|---|
| `/settings` | Settings hub | Same as OpenCode |
| `/permissions` | Direct-session sandbox + approval (`16.19`) | **Primary** migration control vs repeated prompts |
| `/editor`, `/editor --side`, `/editor --close` | Explorer overlay / layout | Opt-in; not startup UI |
| `/compact` | Context compact (§30.3) | Alias: `/summarize` (heritage) |
| `/trim` | Context trim (§30.3) | Implement per §30.3; not interchangeable with compact |
| `/prune` | Context prune preview | |
| `/clear` | New context epoch (§30.3) | Does not delete Session |
| `/view activity on\|off` | Activity digest (§31.22) | |
| `/debug ui` | UI diagnostics (§31.22.13) | |
| `/undo`, `/redo` | Session revert | Heritage |
| `/fork`, `/timeline` | Branch / history UI | Heritage |
| `/export`, `/copy` | Transcript export | Heritage |
| `/checkpoints` | Rewind UI (§16.18) | Heritage |
| `/agents` | Agent picker | Heritage |
| `/goal-propose`, `/goal-review`, `/goal-start` | **Managed lane only** | Label **Advanced → Managed goal** in help; never required for pair coding |
| `/share`, `/unshare`, `/rename` | Session metadata | Heritage |

TUI must not register a second ID for the same semantics. Missing normative slashes are
implementation gaps (backlog P3-06, P7-03), not permission to invent divergent behavior.

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

The provider-list projection identifies the local model-catalog source
(`cache`, `bundled`, `override`, or `unavailable`) and its known freshness.
For a bundled snapshot without a signed source revision or retrieval timestamp,
freshness is `unknown`; bundle presence does not imply current pricing or a
reachable endpoint. Endpoint health remains `not_probed` until a separately
authorized probe produces evidence.

The compatible provider/model catalog may ingest Models.dev metadata as advisory catalog data.
Each imported snapshot records source URL/project, retrieval time, upstream revision or content
digest, freshness, license and attribution/notice provenance. Bundled or stale metadata may help
populate a picker but cannot establish current pricing, free status, endpoint health, capabilities
or route availability. Refresh is bounded and its result is inspectable; a missing or stale source
is shown as such rather than silently treated as current.

For compatible models, V1 selects `harness.native-rich` by default and begins with a curated common
coding tool surface. Every projected tool is filtered by current authorization, runtime availability
and model compatibility; the full tool catalog is never sent by default. Long-tail tool schemas are
loaded through bounded progressive discovery at the next provider-request boundary.
`harness.native-minimal` is an explicit user choice for low-context or lower-capability models with
native tool calling. Changing the model never silently changes the harness; an incompatible pairing
is shown as unavailable until the user chooses a compatible harness.

## 16.6 Role bindings

Optional workload roles can bind explicit model/provider/harness policy, such as default, fast, thinking, vision, architect, commit, tiny, memory, subtask, advisor, image, web, speech, dictation and judge.

Role binding is configuration, not automatic hidden routing. Fallbacks are explicit, scoped (global/project/Session where supported) and show cost/auth implications before use.

## 16.7 Provider connections

Reuse existing OpenCode/Horizon provider/auth ownership.

Supported connection forms according to adapter:
- OAuth/device/browser login;
- API key stored as SecretBroker/OS-credential reference;
- legacy environment credential source detected by variable name only; never used for HorizonCode provider dispatch;
- keyless local runtime;
- custom compatible endpoint with TLS/auth policy.

UI never stores or displays raw secret material after entry.

Test/refresh/discovery network requests show whether they can consume paid quota. Unknown cost is not free.

Search provider, model provider and agent harness are separate categories even if backed by the same company/account.

**Credentialed model execution status (2026-10-20):** provider catalogs and model
metadata remain selectable, but `Provider.getLanguage` rejects env-, Auth-, and
config-backed credentials with a typed unavailable error before SDK/model
construction. The exception is the explicit anonymous OpenCode offer, limited
to active models with complete known zero pricing and its literal `public`
token. SecretBroker currently supplies only bounded metadata references;
provider/model request-scoped lease consumption, revocation checks, zeroization,
and leak acceptance are not wired. Provider plugin `models` callbacks are
disabled because their current hook receives an Auth projection before request
admission, and automatic credentialed model discovery is disabled. Models.dev's
local catalog remains visible. P1 still owns cross-cutting zero-effect proof
for plugin origins. This is CODE_PRESENT/FAIL_CLOSED, not an available
credentialed route. UI source/configuration labels must not imply
provider health, successful auth, or dispatch availability.

**Managed model route projection (P6 source, 2026-10-21):**
`packages/opencode/src/provider/provider.ts` exports
`Provider.managedRouteProjection`, a projection over the existing active Core
provider/model registry and Auth SecretBroker metadata owner. It resolves the
exact selected provider/model, accepts only an adapter in Core's bundled
first-party SDK table, requires HTTPS or loopback HTTP, and derives an opaque
route ID plus BLAKE3 endpoint revision from the registered adapter/model and
endpoint. It never returns the endpoint URL, request headers, or credential
bytes. A non-null `credentialLeaseRef` is the unique opaque Auth `SecretRef`
and is **not** a bearer lease or proof of consumption. `null` is emitted only
when Core's exact `anonymousFreeModelRefs()` projection proves that selected
OpenCode model is active, explicitly zero-priced, and credential-free.
Consent, Guard-challenge, and capability-lease refs are accepted only from a
trusted internal Guard caller, not a Task/request body; HostKernel must
independently revalidate them. Rust currently accepts the nullable field shape
but returns no-mutation `UNAVAILABLE` for both anonymous and credentialed
routes. This resolver performs no dispatch and does not enable managed LLM
requests. Credentialed use still needs a scoped one-use SecretBroker
authorization consumed by the existing guarded ExecutionHost transport.

### Web search connections (V1, `DEC-V1-26`)

Built-in web search is configured in Settings as an ordered route list (§37.5):

- after first-use search consent, the built-in anonymous/free cascade is default-enabled in the route order specified in §37.5; each provider may enforce its own anonymous rate limit, and every route remains unavailable until its Guarded transport exists;
- BYO-key providers (Brave, Exa, You.com, Tavily, Firecrawl and Parallel; TinyFish remains optional and is not in the first route set) each expose: enable toggle, credential source (SecretBroker/OS-credential reference; raw secret never displayed again after entry), cost class including honest UNKNOWN, freshness and health status, and an inspect action mapped to `web.search.inspect_provider`. Enablement records consent for that provider's auth and potential charges; it never authorizes another route or a paid fallback;
- grounded-model search is a separate route and remains off until explicitly selected and consented; it never joins the ordinary web-provider cascade implicitly;
- enabling a provider adds it to the cascade; disabled or unconfigured providers are absent — no separate "off" step is required;
- cascade order is user-visible and reorderable; the built-in free routes start enabled after first-use consent, while BYO authenticated routes join only when explicitly enabled;
- enabling a paid or authenticated provider records the user's consent for that route's cost/auth class; a failed free route can never silently hop to a paid provider that was not enabled;
- each eligible route receives only its §37.5 bounded route-local retry; a recognized `EMPTY` result (complete HTTP 2xx and zero provider rows) is terminal for that route and advances to the next enabled route without retrying it. After one ordered cascade pass, the resolution shows per-route reasons without restarting the cascade or fabricating a result;
- switching search routes never changes the selected model/provider/harness and never triggers hidden spend.

**Implementation status (2026-10-20):** the CLI/TUI Settings editor models the four
anonymous defaults and six explicit BYO routes and persists enable/order consent without
persisting credentials. BYO cost currently renders UNKNOWN; enabling it acknowledges possible
provider charges. The read-only `web.search.inspect_provider` source reports local route
configuration and last sanitized failure/cooldown separately from provider health, which is
always `not_probed`; local history resets on restart. The production `WebSearchRuntime.node`
is composed and its Core adapter checks negotiated HostKernel cascade and `effects.v2`
features before sending the admitted aggregate request. HostKernel source now includes fixed
MCP and BYO HTTP route policies, aggregate durable intent/receipt, per-route durable
SecretBroker attempts, one-use dispatch/settlement, continuation, cancellation and UNKNOWN
reconciliation. Core composes the Auth-owned fixed SecretBroker sender and resumes only from
the exact settled response receipt. `supportedProviders` names fixed adapters; it does not
imply provider health or enabled effects. All provider routes remain unavailable because
`WEB_SEARCH_ANONYMOUS_RUNTIME_READY` and `WEB_SEARCH_BYO_RUNTIME_READY` independently gate their route classes. Both also require negotiated cascade and effects features; BYO additionally requires its exact SecretBroker reference and separate user consent. Each gate remains false until its own integrated Guard/transport/recovery acceptance passes.
the TUI reports that state. Grounded-model search has no production adapter. This is
source-present, fail-closed, and unverified; no checks or live provider calls have run.
The production broker has no direct route-callback executor; provider effects enter only
through the HostKernel-backed runtime. The former callback cascade simulator is test-only.

**P5 Settings status projection (2026-10-21; source only):** the web-search Settings
command reads authenticated `GET /websearch/providers`, which returns workspace-local
configuration and process-local attempt/cooldown metadata without probing providers or
returning secret values. Disabled routes can still show an existing opaque SecretBroker
reference as configured; enabled routes without one show unconfigured. The UI states that
BYO routes may incur charges and that UNKNOWN cost means pricing is unverified before the
user enables a route. Provider health remains explicitly `not_probed`; this projection is
not acceptance evidence.

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

For direct coding, routine in-workspace file reads and edits within an explicitly selected,
bounded workspace grant run without a prompt for every effect. Selected build/test commands join
that grant when command, filesystem, network and OS resource controls are part of the accepted
backend profile; the grant dialog shows the exact command class and its limits.
Guard still admits each complete batch, issues one-use leases and records receipts. Prompt when a
request crosses the selected workspace/capability boundary, needs a broader grant, or cannot be
safely classified. A child, plugin, MCP, CodeMode script or other origin never inherits broader
authority from this low-friction direct-session policy.

When the selected permission mode requires a challenge, it offers **Allow once**, **Allow this Session**,
**Remember for this workspace**, and **Deny**. Approval frequency is selected separately in
`/permissions`; it is not represented as a grant preference. **Allow once** approves
only the exact challenged action or complete batch after fresh validation and creates no reusable
grant. Choosing either standing grant explicitly pre-authorizes only its displayed bounded scope;
the triggering action is not dispatched by the grant decision and must be freshly prepared under
current workspace state. Matching accepted effects do not prompt again. The dialog states the exact workspace root, allowed actions,
isolation guarantees,
expiry, and excluded secret/destructive/out-of-workspace actions. Network stays off unless
the user separately adds exact destinations/protocols and finite request/byte budgets; the UI
shows that scope separately and never offers wildcard egress. Session grants end
when the Session is replaced/closed, principal or owner epoch changes, or the user revokes.
Workspace grants are user-owned, expire within 30 days, and are revoked immediately from
Settings. Changing root, execution backend, policy or confinement guarantees invalidates the
grant before the next effect and returns the user to the same three-choice prompt. Settings
show the selected sandbox/approval mode and each grant's principal-bound scope,
creation/expiry, backend guarantees, and revoke action;
they never present legacy OpenCode "always" as Guard approval. CodeMode does not reuse this grant
for its helper launch. Direct helper launch requires explicit `CodeModeEnablementV1` for
`codemode.execute`, bound to the
authenticated principal, Session/owner epoch, fixed packaged selector and resolved helper digest,
resource-profile ID/digest, backend/guarantee digest, policy digest, expiry and revocation
generation. This is separate from DirectSessionGrant; it is not arbitrary process authority and
cannot select a path, argv, environment or runtime. Revoke/fence it on Session replacement/close,
user revocation or any bound-pin change. Managed execution has no direct grant: the accepted
SpecVersion must include `codemode.execute`, the Task-pinned AgentProfileV2 must permit it, and
HostKernel revalidates the live Attempt and exact profile before launch. Both helper launches
remain Guarded and receipt-tracked. Nested direct effects still require a matching
DirectSessionGrant or exact `allow_once`; managed effects use live Attempt authority and Guard.
Every nested effect receives its own lease and receipt. Nested boundary-crossing waves use the
normal exact-challenge flow; one-time approval is offered only for the current challenged wave.
CodeMode is unavailable without the fixed
packaged Bun selector or verified OS-enforced cgroup-v2 containment. CM-012 in §32.41 proves
explicit direct enablement, repeated execution without a repeated helper prompt, exact pinning and
revocation.

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
- activity digest cards (§31.22): **Enter**/**Space** expand inline preview; **Ctrl+R** opens read-only review overlay when `reviewable`; **Esc** closes overlay or collapses card; focus order §16.21.2.

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
- default session layout matches §16.21 (transcript + activity digest + composer); file-edit tools surface as §31.22 cards with review overlay (`ACT-004`).
- Provider selection/default, ContextService compilation and bounded progressive tool discovery
  work in both direct and managed prompt paths; CodeMode read composition is prompt-free while
  effect calls visibly follow normal Guard admission and receipts.
- `harness.native-rich` is the default for compatible models with a curated coding surface;
  long-tail schemas are discovered on demand, and `harness.native-minimal` requires explicit
  selection. Incompatible model/harness pairs are reported without silently switching either.
- Direct CodeMode launch requires explicit `CodeModeEnablementV1`, separate from the ordinary
  workspace grant and pinned to the authenticated Session, helper digest, fixed selector,
  resource profile, backend guarantees and policy. Managed launch requires accepted SpecVersion
  plus Task-pinned AgentProfileV2 authority. Matching launches do not repeat the helper prompt;
  revocation or pin drift blocks the next launch, and each nested effect still follows its lane's
  ordinary Guard/receipt path (CM-012 in §32.41).
- First-use consent enables the free anonymous web-search cascade; BYO routes require explicit
  enablement; grounded-model search requires separate explicit choice; auth 4xx advances only to
  another explicitly enabled route with per-route provenance.

Source inspiration may come from OMP or other products through 42, but this document is the only normative UI contract.

## 16.14 Built for the Future: verifiable beginner and expert flows

Brand: HorizonCode - Built for the Future. The public npm name is planned as horizoncode, with hzcode as the shipped short CLI command for the same entrypoint (amended 2026-10-18).
A user should understand: what the agent is doing, what changed, what was tested, what it costs and how to undo it. Beginner and expert UIs share one session/runtime, not separate engines.
V1 beginner journey: describe a coding change -> review/accept a clear plan when using managed work -> implement through guarded tools -> inspect the diff -> run tests -> independently verify the final revision -> explain evidence, cost and undo. Browser visual editing, hosted preview and deployment are post-V1.
Provider UI distinguishes authorized API keys/subscriptions, legitimate free offers, local models and the separate native OpenCode backend. Show restricted-model eligibility; unknown pricing is never free.
Selectively evaluate OMP SVG/Markdown/chart/model-picker UI patterns, with bounded rendering, accessibility and without importing an alternate session/control layer.
Provider selection/default and the V1 ContextService compiler are release acceptance, not optional
future enhancements. To measure the open-weight versus premium intelligence gap, run paired,
same-task baseline and HorizonCode-harness evaluations using the identical pinned open-weight
model revision, budget and environment; report independent outcomes and measured token/cost/runtime
provenance. Premium-provider comparisons are separate explicitly authorized runs. Published or
estimated benchmark scores are hypotheses, never HorizonCode guarantees or measured uplift.

## 16.15 Optional Features and Experimental lifecycle (A-V2-29)

**Every user-optional product feature has a discoverable Settings entry before it is exposed for use.** Settings is the canonical user control, not necessarily a separate implementation switch: the existing owning config service stores the requested value and resolves precedence; other surfaces show the same effective state. Optional feature metadata is projected from its owning setting/capability and the shared `FeatureExposureV1` contract (§33), not stored in a second registry. Internal implementation strategies (such as automatic cache invalidation) need no user switch unless offered as a user choice; optional selectable algorithms, backends, agent modes, previews, optimizations and integrations do.

Use two **independent** axes:
- **Release class:** `stable | beta | experimental`. `experimental` is the exact class/tag for enabled developer testing and opt-in early-access features. It describes stability, not authorization or implementation completion.
- **Implementation/effective state:** §33 `DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED`, plus runtime `UNAVAILABLE` with reason; and `off | on | blocked | pending_apply | unavailable` resolved from requested setting, policy, build/channel, platform, dependencies and chosen model/harness. Never map `experimental` to “working.”

Feature exposure descriptor (shape in `contracts-v2/feature-exposure-v1.schema.json`) includes stable feature ID, owning settings key, existing Config/runtime owners, class, description, optional/default state, exposure audience (`public | developer`), supported scopes and platforms, model/harness restrictions, apply boundary, related canonical capability IDs, required runtime prerequisites and risk/cost notes. Empty model or harness restriction lists mean no feature-specific restriction. A prerequisite is descriptive and never grants authority. This contract is a **projection/validation type**, not a new runtime feature registry. A feature with no canonical tool/action (e.g. optional UI layout or search-backend choice) may have zero related capabilities. The setting key is unique and stable; renamed keys require a migration/alias without changing authority.

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

**Feature descriptor projection update (2026-10-21, source only):** Core's derived descriptor, the V1 machine schema, generated SDK type, and V1 TUI detail view now carry/display the existing Config/runtime owners, prerequisites, platform support, model/harness restrictions, and risk/cost notes. Empty model/harness lists mean no feature-specific restriction; Linux includes WSL for this product's current V1 platform target. Prerequisites remain descriptive, never grants. Experimental native-search, hashline-edit, and CoW descriptors stay OFF and unavailable; the additional metadata does not change runtime or Guard authority. Source alignment is not FEAT acceptance or verification evidence.

A settings write must preserve unrelated values, detect conflicting/stale updates, honor apply boundaries and return the authoritative effective state. If the current config source cannot report precedence/lock, display UNKNOWN rather than inventing provenance. A TUI checkbox is never authorization. Implementation targets and FEAT source-parity cases are §20.10.1 and §32.31.1.

The RepoIntel analysis profile (`lightweight | adaptive | full`) is a value in the existing config owner, projected through existing feature/config state; it is not another registry or authorization grant. Missing/invalid effective state is conservative `lightweight`. Changing it records requested/effective/source/pending state only; it does not start LSP processes, schedule indexing, call an embedding/provider endpoint, or warm a cache. Such work requires a later explicit query/action and normal Guard/resource admission. Under pressure, effective analysis may be narrower than requested, with a visible reason and no provider/model switch.

**Config/API projection:** `repo_intelligence.profile` is the single persisted requested value. The Config owner projects normalized `requested`, bounded exact `requestedValue` (including invalid legacy input), `effective`, `configurationSource`, `effectiveSource`, `policyLock`, and an optional stable `reason`; invalid or missing input resolves to lightweight, while a policy/platform/resource owner may narrow `effective` without rewriting the user's request. The TUI/API update carries `expectedProfile` and the replacement profile, performs a locked read/compare/write of only this setting, and returns conflict or policy-lock errors without overwriting unrelated configuration. The update itself has no execution side effects. No V1 path may interpret the selected profile as permission to start an indexer, language server, provider, or other process.

**Core integration status (2026-10-20, source only):** `Config.getRepoIntelProfile()` is a cache-only read from the existing Config owner. The PATCH path uses the same per-config-file lock as other settings, compares the exact persisted request (including invalid legacy text), preserves unrelated JSONC content, and returns typed stale-write/policy-lock errors. The TUI selector consumes that projection and does not schedule analysis. This remains unverified until FEAT-001..014 and RepoIntel end-to-end acceptance run on the integrated revision.

**Feature apply-boundary correction (2026-10-20, source only):** updating a supported compaction setting writes only the config and leaves the current effective value pinned until the existing next-turn apply hook. The HTTP handler no longer disposes/reloads the instance immediately after the write, which would have bypassed the returned `pending_apply` state. Provider catalog models with omitted tool-call metadata are now projected as unsupported rather than optimistically supported; this is a conservative capability projection, not a runtime probe. FEAT-001..014 remain unverified pending integrated acceptance.

**P6 unknown-lock correction (2026-10-21, source only):** untouched built-in compaction defaults report `valueSource=default` and `policyLock=unlocked`, so users can make an explicit project override. An explicit setting whose winning source or policy state is unknown remains `policyLock=unknown`; the TUI does not offer it as mutable and the Config write owner rejects it. System-policy locks remain authoritative. This closes a source-level mismatch where UNKNOWN had been treated as permission to write. FEAT-001..014 and config-source integration remain unverified.

**P6 pending-state correction (2026-10-21; fixtures authored, not run):** a requested/effective mismatch is reported as `pending_apply` only when the captured policy lock is explicitly `unlocked`; an unknown lock cannot be presented as an accepted deferred write. Mismatches in either direction project as blocked unless they are an accepted pending apply, and the next-turn apply hook also requires the explicit unlocked state. Unknown provenance gets an uncertainty-specific reason unless the owner supplies a more precise reason. FEAT-001..014 remain open.

**P6 offline Doctor selection correction (2026-10-21, source only):** a request with no selected model is a local configuration failure (`selected_model_missing`) and remains incomplete; a selected model absent from a stale/unknown catalog remains UNKNOWN unless effective config pins it. Neither case reads credentials or sends a request. Doctor fixtures were updated but not run.

**P6 provider metadata projection (2026-10-21, source only):** the model picker now prints explicit yes/no/unknown catalog hints for tool, reasoning, and input/output modalities, and labels price freshness `unknown` because the provider-list projection does not yet pin catalog freshness. Selection labels continue to say dispatch is unverified and endpoint health is not probed. The integration review also found a P2-owned title-generation path that can choose an implicit small model; P2 owns changing its fallback to the Session-pinned model unless the title agent has an explicit model. No verification was run.

**P6 settings/model source status (2026-10-20):** HorizonCode's CLI/TUI feature dialog reads the Config-owned descriptor list and exposes requested/effective/source/lock/reason/apply-boundary metadata. Only the existing `compaction.auto` and `compaction.prune` settings accept writes; updates compare the current request under the config-file lock, preserve unrelated JSONC fields, return typed conflict/lock errors, and remain pending until the next-turn apply hook. The three registered experiments remain OFF, visible as unavailable and non-actionable. The provider/model hub shows catalog pricing and access-source provenance, but permits selection only for an active anonymous OpenCode model whose input, output, cache, tier and long-context rates are all explicitly zero. Environment, Auth, config-backed credentials, incomplete/paid pricing and non-OpenCode providers stay visible only as unavailable; choosing one cannot trigger auth or silently replace the selected model. These source changes and the added regression cases have not been executed; FEAT-001..014, SecretBroker-backed dispatch and real provider/model switching remain unverified or blocked on P1 acceptance.

**P6 continuation review (2026-10-20, source only):** the existing source covers the independent V1 surfaces: provider catalog/capability and price hints, explicit-zero-price anonymous OpenCode selection/default, switch picker, Config-owned requested/effective feature settings, offline Doctor API/TUI, and owner-scoped `question.ask` list/reply/reject with standalone-only batch admission. The P5 Core continuation now passes HostKernel's exact cascade reference/digest and one direct/managed Attempt scope to the P6 Auth-owned fixed sender. The sender validates the exact one-use DISPATCHING permit, dispatches one fixed route through the existing SecretBroker/transport, and returns a bounded response with the durable HostKernel settlement receipt; P5 resumes the Rust-owned cursor only with that exact receipt and response. This source composition remains disabled pending P1 Guarded aggregate acceptance and does not authorize credentials by itself. Provider transport validates fixed routes, including Brave GET with `x-subscription-token`. This review removed the exported `Auth.issueSecureInputHandle(bytes)` helper because arbitrary host-JS bytes are not the protected native input channel required by §12.17. No replacement credential entry route is exposed: P1 has no Guarded put/revoke capability, authenticated write context, or protected input bridge yet. Catalog/full Doctor requests remain zero-network `SKIPPED` projections until P1 supplies trusted grants and dispatch. FEAT-001..014, the real provider switch journey, and the free-model response/coding journey remain unaccepted; no tests, builds, typechecks, probes, or provider calls were run.

**P6 model-picker truth correction (2026-10-21; source only):** the V1 TUI picker now shows catalog context/input/output limits when supplied, prints `unknown` when a limit is absent, and calls an explicitly zero-priced anonymous OpenCode model *selectable by V1 policy* rather than claiming provider dispatch is available. Endpoint health remains `not probed`; this does not establish that the Guarded network path works. Credentialed providers remain unavailable until SecretBroker dispatch is accepted. No tests or provider calls were run.

**P6 credential-entry and offline-catalog correction (2026-10-21; source only):** the inherited provider OAuth HTTP authorize/callback routes now fail with typed `ServiceUnavailableError` before invoking `ProviderAuth`; the legacy CLI login/logout paths remain unavailable. This prevents those routes from persisting credentials through legacy Auth while protected native input and Guarded SecretBroker writes are absent. Offline Doctor treats missing catalog freshness as `UNKNOWN` when a selected model is not present in effective config; it no longer infers invalidity from a cache miss. No verification was run.

**P6 source continuation (2026-10-21; not acceptance evidence):** anonymous OpenCode eligibility is now projected per exact model reference and requires the same active, complete zero-price and credential-free predicates used by `Provider.getLanguage`; custom model-loader paths do not qualify. Provider defaults and the TUI picker consume this exact model set, while provider access labels distinguish a configured provider from legacy Auth/environment sources and keep endpoint health unprobed. The unguarded experimental plugin small-model selector is disabled because it can change provider/model routing without an explicit role binding. The session TUI now hydrates, projects, replies to and rejects both the legacy owner-authenticated `question.*` lane and the Core Location-owned `question.v2.*` lane through their own callbacks. It does not bridge one lane's request identity or callback authority into the other. Credentialed dispatch, Guarded live Doctor probes, FEAT-001..014 and QA acceptance remain unverified or blocked by P1; no checks or provider calls were run.

**P6 managed-provider Auth continuation (2026-10-21; source only):** the Auth-owned
one-use provider permit now requires the fresh HostKernel `effectID` and
`authorizationBindingDigest` in addition to the exact Attempt/epoch, route, request,
Guard-challenge, lease and operation pins. Immediately before dispatch, Auth sends
`managed_provider.consume_send_authorization` the complete secret-free route and request
projections, all authority pins, the opaque one-use token, and the SecretBroker context
retained from the fresh begin response. Post-begin ambiguity sends the same durable pins
plus a bounded reason to `managed_provider.unknown`; it never retries the provider request.
Credentialed bytes remain inside the existing SecretBroker transport, while the explicit
anonymous OpenCode zero-price route uses no credential bytes but still consumes the same
HostKernel permit. HostKernel consume/UNKNOWN integration and P1 Guard acceptance are still
required; provider dispatch remains gated, and no tests or provider calls were run.

**P6 Doctor/S1 source continuation (2026-10-21; no validation):** the offline Doctor panel now names the three tier states and their actual boundaries: offline reads no credentials and sends zero provider requests; catalog is unavailable pending an authenticated network grant and Guarded dispatch; full additionally requires separate explicit spend consent and states that it will not fall back to another provider. Consent by itself cannot activate a request, and neither unavailable tier has a dispatch action. Question event deltas are now owned by each TUI Data provider and are discarded after the matching session resnapshot, preventing cross-provider question projection and stale replay-delta retention. This remains source-only; no checks, live probes, or provider calls were run.

**Direct child delivery status (2026-10-20, source only):** the owner-authenticated `/agents` TUI view and `GET /session/{parent}/subagents` route expose at most 64 linked child Sessions, exact profile/permission/Attempt pins, current activity, and HostKernel Attempt terminal/evidence digests. The bounded named-child wait route rechecks authenticated parent lineage and the exact DirectAttempt, returning terminal/UNKNOWN state, observed activity, or timeout without cancelling. Core now has a Session-owned SQLite inbox with transactional sequence/capacity/idempotency reservation, bounded payload retention, exact profile/permission/Attempt pins, authenticated `agents.message` route, HostKernel prepare/commit/inspect reconciliation, and a queue-only TUI entry. A lost `prepare` reply keeps the row `preparing`; Core may replay only the exact same message ID, pins and payload while the original child Attempt remains live in the same owner epoch. HostKernel returns its retained challenge/lease for that journal row; it cannot mint a replacement. After epoch change, unresolved prepare is UNKNOWN and cannot append or retry. TaskTool claims committed rows in FIFO order only before a later child prompt starts and places them into that prompt's input. After prompt return, it durably records an immutable consumption proof and separately stores HostKernel's `acknowledge_consumed` receipt; capacity remains occupied until that receipt is saved. Lost ACK responses retry with the exact proof under a fresh live same-authority consumer Attempt, without replaying consumed model input. A crash before the consumption transaction leaves a stale delivery UNKNOWN and is never replayed. A queued request never starts or modifies a running turn. `follow_up` remains unavailable until Core can mint and HostKernel can verify a fresh-turn authorization. The message route remains fail-closed until P1's OwnerLog/Guard lease and ACK backend is integrated and verified. This source and the surrounding projection routes have not been tested or verified on the integrated revision.

Direct child admission has a fixed aggregate ceiling of 64 linked direct child Sessions per parent; the selected profile's `maxTotalChildren` and active-child limits apply independently as stricter per-profile caps. Core's Session count is an early-denial UX check; HostKernel now serializes the same bound against durable DirectAttempt parent lineage, counts terminal child Sessions toward the lifetime aggregate, excludes abandoned pre-admission reservations, and does not double-count exact Attempt retries. The Rust enforcement is source-present, not yet tested. V1 direct Task dispatch remains subject to P1's overall Guard/ExecutionHost gate.

The existing session abort endpoint checks authenticated owner lineage before interrupting a Session and follows TaskTool's direct-Attempt cancellation fence. The bounded named-child wait endpoint returns on terminal/UNKNOWN state, observed activity, or a maximum 30-second timeout; timeout never cancels the child. A queued direct message is persisted and acknowledged independently of child execution; it is promoted only at a later TaskTool prompt boundary, and failures after dispatch become UNKNOWN. Queue admission does not wake a child or modify a running stream; follow-up-turn issuance remains unavailable. Safe automatic detachment of an unaccepted child lineage is also unavailable: Core has no compare-and-close lineage operation, while `Session.remove` recursively removes child history and is therefore not a valid substitute. Reused child Sessions are never cleanup targets.

### 16.15.2 Snapcompact source feasibility (2026-10-15)

The pinned OMP source has two distinct mechanisms: `snapcompact-inline` transiently transforms only the outgoing provider-context view, while `/compact snapcompact` persists image frames and archive metadata in a compaction entry and restores image blocks on later context builds. Neither exists in HorizonCode. The current Core V2 runner has no implemented `ContextService`/`ContextLedger`; its resolved `@opencode-ai/llm` model lacks the source `ModelV2.Info.capabilities.input` metadata needed for exact-model image gating; compaction estimates JSON-serialized request data without provider image-token accounting; and no local text-to-PNG renderer is available. Existing media transport for user attachments does not prove that an arbitrary selected model accepts generated frames.

Decision: **Snapcompact remains DEFERRED/UNAVAILABLE in V1**, with no runtime code, setting,
command or capability ID. This deferral does not apply to ContextService: the V1 ContextService
compiler is required for direct and managed provider-visible context, and owns selection and
bounded compilation without replacing canonical history. If snapcompact is reconsidered, evaluate
only a non-persisted projection owned by that compiler; do not add a second Session/compaction
owner, alter canonical history, publish frames through a blob sink, or change the selected
model/provider. Re-entry requires same-model capability, token/count/request-byte budgets,
source-text rebuild/disable, protected-fact fidelity, privacy/cache/cost measurements,
payload/render recovery and rollback. Exact source and license/dependency provenance: §42
SRC-024. OMP tests and benchmarks are not Horizon evidence.

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

**Provider Doctor source status (2026-10-20):** the V1 TUI exposes a discoverable
offline action from both the model picker and the system Settings command palette; its authenticated offline endpoint reads
the local catalog snapshot and a sanitized projection from already-loaded
local config layers (excluding well-known remote overlays), reports catalog freshness, and performs zero
credential reads, network requests or charges. Doctor does not call the general
config loader, which may resolve remote well-known config. When the config
snapshot is absent, configuration remains UNKNOWN; when present, disabled and
excluded provider/model selections are reported as invalid. Catalog and
full request/response contracts and routes are now present
as bounded diagnostics, but grant/consent request fields are labels only:
without P1's trusted Guard grant and dispatcher they return skipped probe steps,
zero network requests and NOT_INCURRED. This is CODE_PRESENT/PARTIAL, not a
live probe. Provider route → SecretRef projection is metadata-only, restricted
to provider IDs resolved by the canonical catalog, and omits missing, revoked
or ambiguous BYO references; it reports configured credential provenance only
and never authorizes a request. The Guarded HostKernel route is still required
before any credential use. The TUI's anonymous OpenCode default remains limited
to active catalog models with explicit zero input, output, cache and declared
tier pricing; omitted pricing fields remain unknown and do not qualify as free.
Provider API defaults and TUI eligibility use the same no-paid-fallback rule; paid or unknown-price
models and credentialed routes remain unavailable until P1 SecretBroker
dispatch acceptance. Question reply/list endpoints validate
middleware principal against the Core-owned Session owner chain; legacy local
access is limited to ownerless roots in the same instance directory. Filtering
question payloads on the shared location event stream remains a P7 integration
dependency.

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

**Config-owned resource projection (source, 2026-10-20):** Core Config accepts optional exact-decimal requested limits by canonical budget dimension from local user/project or managed config; remote well-known overlays cannot set resource policy. `ResourcePolicyV1` retains the §18.18 `{ limits: ResourceLimitV1[] }` shape; `ResourcePolicyProjectionV1` adds requested values, `configurationSource`, policy lock, reason and an optional canonical effective `ResourceLimitV1`. Unknown values are not converted to zero or guessed defaults. Because quota discovery and OS enforcement have not passed platform acceptance, current effective limits remain absent and enforcement is `UNSUPPORTED`; this projection grants no worker or process-start authority. `GET /config/resources` exposes the same Config-owned read projection for consumers such as P8. It does not provide a write route or silently activate requested limits.

## 16.18 Checkpoint/rewind surface (LLD closure 2026-10-18)

One ActionDescriptor-backed surface (slash/menu/API) lists checkpoints with turn provenance and offers: restore code + conversation, conversation only, or code only — always preview-first. A changed workspace revision refuses Full restore; the UI offers an explicit SelectedPaths preview bound to an exact preview digest. Only conflict-free captured regular single-link files may be selected; dirty, untracked, conflicting and unselected paths remain untouched, and unsupported file-kind facts fail closed (§14.19). The surface states honest limits (external changes not captured, symlink/hard-link skips) and never claims code restore when only conversation state moved. Acceptance: CP-001/CP-002 plus the beginner journey's "explain evidence, cost and undo" step; keyboard accessible, no duplicate Session owner.

**P6 managed provider transport preparation (2026-10-21; source only):** the existing Auth ProviderTransport now has a preparation helper that compares the freshly resolved endpoint revision with the selected route, bounds and canonicalizes the exact SDK URL/method/body/headers, removes any SDK-supplied credential header, and computes a separate transport-operation digest. It performs no network request and does not create a SecretBroker lease. HostKernel still does not bind that digest together with the managed ContextSelection request digest in the one-use begin authorization, so managed provider dispatch remains unavailable; P7's SDK path remains hard-failing. SecretBroker inference uses the existing `PROVIDER_REQUEST` purpose. No tests/builds/typechecks/provider requests were run.

**P6 managed begin authorization source continuation (2026-10-21; source only):**
`packages/opencode/src/auth/provider-transport.ts` now defines a strict fresh-begin response
projection and retains it only behind an opaque WeakMap handle. Admission checks the exact
normalized request digest, SDK transport digest, SecretBroker operation digest, provider/model/
harness/route/endpoint, credential/consent/Guard lease refs, Attempt, owner epoch, request
sequence, and ContextSelection digest. Handle consumption deletes the entry before callback
execution, so retry, foreign object, mismatch, cancellation, and callback failure cannot reuse
the in-process authority. This is only the Auth consumer seam; current P1/P2 DTOs still omit
the dual request digests and return no fresh send authorization, so provider sends stay
unavailable. The anonymous route transport and live Doctor tiers also remain gated. No checks
or provider requests ran.

**P6 direct provider journal/transport source (2026-10-22; not acceptance evidence):** Core `SessionStore` now has a principal-bound direct provider-request journal with immutable profile/scope/ContextSelection/provider/model/harness/route/endpoint/policy/input/SDK-transport pins and `PINNED → DISPATCHING → SETTLED|UNKNOWN` transitions. The canonical message/usage settlement API must run in the existing `EventV2.publish` commit callback, so the assistant projection, usage projection and journal settlement share the Session transaction. `Provider.getDirectLanguage` and Auth's request-scoped fetch adapter currently expose only the exact bundled anonymous-free OpenCode route; the adapter freezes the SDK request before pinning, checks it again at dispatch, marks `DISPATCHING` before bytes, refuses redirects/retries, bounds the response, and fences ambiguous outcomes as `UNKNOWN`. Credentialed/paid routes and live Doctor probes remain unavailable until P7's direct `session/llm.ts` caller supplies the same frozen `ProviderInputV1`/ContextSelection/route pins and integrated acceptance passes. Source presence does not prove an inference ran; provider dispatch, selected-model journey, FEAT-001..014 and V1 remain unaccepted.

## 16.19 Direct-session grant and command-profile UX (DEC-V1-28)

The primary direct-session control is **`/permissions`**, also available from
Settings → Permissions. Sandbox scope and approval frequency are separate:

| Sandbox | Effect boundary |
|---|---|
| Read-only | Workspace reads; no workspace writes or process mutation |
| Workspace write | Workspace reads/writes and configured scratch roots; network stays outside this boundary |
| Full access | No HorizonCode filesystem or network sandbox; commands may use files and network available to the user account |

| Approval policy | Prompt behavior |
|---|---|
| Ask for approval (`on-request`) | Default is Workspace write + Ask for approval. Routine operations inside the selected sandbox proceed without repeated prompts; crossing its boundary asks with the exact action and destination |
| Always ask (`always`) | Ask before each effect, including one otherwise inside the selected sandbox |
| Never ask (`never`) | Do not show approval prompts; allow effects within the selected sandbox, subject to technical validity and ordinary platform/resource limits |

The **Full access** preset selects Full access + Never ask and requires an
explicit current-Session selection with a clear warning that workspace files,
external files, destructive commands and network are accessible. It is not the
default. Custom mode lets the user select both dimensions independently. An
automatic reviewer is not a V1 mode until an authenticated independent reviewer
exists; model self-approval is never used. A mode change applies at the next
effect boundary, advances its authenticated revision, and fences stale prepared
work. The selected mode is visible in `/permissions` and the TUI status bar.
The wire contract is `direct-session-permission-mode-v1.schema.json`.

### 16.19.1 Default preset: **Coding (recommended)** (`DEC-V1-36`, bundle `DEC-V1-37`)

First-run and reset default for direct Sessions (not managed Runs). Full bundle: §33.33,
§30.28–30.30, `packages/core/src/horizon/skills/horizoncode/SKILL.md`.

| Dimension | Default |
|---|---|
| Sandbox | **Workspace write** |
| Approval | **Ask on boundary** (`on-request`) — in-grant reads/edits and pinned workspace test/build profiles proceed **without per-call prompts** |
| Grant | Offer **Allow this Session** on first boundary cross; remember workspace grant optional |
| Goal | **Off** — no Goal wizard, no `/goal-start` in onboarding |

**Full access + Never ask** remains a deliberate opt-in with warning (power users, OpenCode
`yolo`-class workflows). **Always ask** remains available for high-assurance users.

Settings copy must state explicitly: *“You do not need a Goal to code. Managed goals are for
multi-step verified automation.”* Competitor parity (OpenCode, Cursor, Claude Code, Codex CLI)
is measured with this preset in §32.49 and [`46-V1-MIGRATION-PARITY.md`](46-V1-MIGRATION-PARITY.md).

### 16.19.2 Effective capability and skill chips (`DEC-V1-38`)

Context bar or status row shows:

- `tools: N effective` (Core + Extended enabled for profile);
- `skills: M listed` (built-in catalog metadata count);
- optional `index: warming | ready`;
- one-line disabled hint when `N` is below catalog size (e.g. `browser: post-V1`).

Tapping opens Settings → Tools/Skills with filters matching §33.32 tiers.

`never` means no user approval prompt; it does not present an unsupported
operation as available. Report platform/backend limitations, stale authority,
budget exhaustion or protocol errors directly without repeating an approval
prompt. Full access makes no sandbox or OS-confinement claim. Provider/search
cost consent is separate, and managed runs use accepted SpecVersion and
AgentProfileV2 authority without inheriting this direct-Session setting.

When the selected mode requires a Guard challenge, it names the exact operation and offers **Allow once**,
**Allow this Session**, **Remember for this workspace**, and **Deny**. Allow once approves only
that exact challenge after fresh validation and does not create a grant. Settings → Permissions
shows the selected approval policy separately from active, expired, revoked, or stale grants,
their selected action/path scope, exact trusted command profile revision where relevant,
expiry and revoke action. It never offers a blanket “allow shell” grant.

For build/test, the user selects an existing enabled `WorkspaceCommandProfileV1` from
Core Config. The UI shows executable identity, allowed literal argument choices, workspace
root, network posture, enforced guarantees, and bounds before grant. Model-generated
arbitrary shell text cannot be saved as a profile. A profile revision or binary digest
change makes its old grant stale and requires a fresh user decision. If the current
ExecutionHost cannot enforce a profile's required limits, the choice is visibly
unavailable; one-time approval cannot override missing OS guarantees, and the command is not
dispatched until the selected backend can enforce the profile.

Allow choices do not immediately execute a pending action. HorizonCode re-prepares it
against current workspace and policy state, then evaluates Guard again. Ordinary covered
reads/edits and selected build/test commands should not repeatedly interrupt the user;
out-of-scope network, secrets, publishing, destructive and out-of-root actions still
reach their own policy/approval boundary. Exact grant and command-profile contracts are
owned by §§12.21, 17 DEC-V1-28, and 37.25–37.27; acceptance is GRANT-001..016 and
GRANT-011..016 in §32.43.

## 16.20 External editor profiles in CLI/TUI (DEC-V1-33)

Settings → Editors, reached through `/settings`, contains user-owned profiles with a
friendly name, resolved executable identity, target kind, terminal/GUI wait mode and
immutable revision. Users create a profile there or accept a safe executable suggestion
from `EDITOR`/`VISUAL`; the raw environment string is never executed. `/editor` is the sole
entry point to workspace browsing and opens the Explorer as a temporary overlay. It is
closed by default. Selecting a file and choosing Open launches the configured profile.
`/editor --side` is the explicit opt-in to a right-side Explorer/editor pane for that
session; closing it returns to the default single-pane view. Prompt scratch editing is an
action inside `/editor`, never a permanently visible composer button. The CLI/TUI never
adds a persistent Explorer/editor region on startup. Terminal editors such as nano, vi,
vim and nvim take over the foreground terminal. GUI launchers such as Sublime, VS Code and
Zed must use their wait-for-close invocation.

The selected sandbox and approval policy apply to launch. If the backend cannot contain
external editor workspace writes, Settings explains that workspace editing is unavailable
in `workspace-write`; the user may explicitly choose the existing Full access mode and
see its warning. On close, the TUI displays changed-file and conflict state. V1 supports
CLI/TUI launch only; it does not claim a VS Code/JetBrains extension or ACP integration.

**Current source status (2026-10-22):** the default single-pane and `/editor` overlay
commands are present; Core Config stores an append-only global profile history, and
Settings currently supports selecting, adding a built-in immutable profile revision, or
disabling external-editor selection. The saved profile does not launch a process. Custom
profile editing/removal, host-resolved executable identity display, Test launch, PTY
suspend/resume, HostKernel launch/reconcile, and post-exit `files.patch` remain unavailable.
The Explorer's authenticated preview supplies exact `sourceRevision` and `contentDigest`
for a future explicit Open action. Keep that action disabled until the P2 bridge and P1
containment/receipt acceptance are integrated; no direct Core process start is allowed.

## 16.21 Direct-session screen layout and activity digest (V1 TUI)

Status: normative layout contract for Linux/WSL **CLI/TUI** (`DEC-V1-33`). Post-V1 GUI/web surfaces may adapt geometry but must preserve the same **information hierarchy** (transcript truth, digest projection, composer authority). Card visuals and tool mapping: **§31.22**. Tests: **§32.48**.

### 16.21.1 Pane stack (default)

| Pane | Rows (typical) | Scroll | Focus | Canonical owner |
|---|---:|---|---|---|
| Status | 1 | no | no | instance + session summary |
| Context bar | 1–2 | no | no | `session.context_ledger` projection |
| Transcript | flex (≥40% height) | yes, virtualized | optional | Session messages/parts |
| Activity digest | 6–14 visible | yes, independent | yes | §31.22 `ActivityCardV1` projection |
| Composer | ≥3 | yes (draft) | default | prompt input |
| Footer hints | 1 | no | no | context keybindings |

The activity digest is **always allocated** in the default layout (minimum **6** rows). `/view activity off` hides the digest but must leave a one-line affordance `Activity hidden · /view activity on` so users can restore it without resetting the session.

### 16.21.2 Focus order

1. **Composer** after send and after modal dismiss (§16.12).
2. **Tab** from composer moves focus to the **newest activity card** (bottom of digest), not the oldest.
3. **Shift+Tab** from activity returns to composer.
4. **Transcript** receives focus only via explicit chord `g` `t` (ActionDescriptor) or mouse equivalent post-V1; arrow keys in transcript mode do not steal activity focus.
5. **Permission** cards (`kind=permission`) trap focus until resolved; Esc does not dismiss without choosing deny when Guard requires an explicit decision.

### 16.21.3 What belongs where

| Content | Transcript | Activity digest |
|---|---|---|
| User prompt text | yes | no |
| Assistant markdown answer | yes | no |
| Final answer label when complete | yes (footer of message) | no duplicate card |
| Tool start/run/complete summary | no (by default) | yes (`§31.22`) |
| Full shell stdout | artifact / review overlay | preview only |
| Guard approval UI | modal + optional `permission` card | yes |
| Token/cost detail | context bar + `/usage` | compact on `subagent` rows only |

### 16.21.4 Narrow and ASCII-only terminals

- **&lt;100 columns:** path segments truncate before status glyphs; context bar may wrap to two lines.
- **ASCII-only theme:** replace `✓`/`✗` with `OK`/`FAIL`; keep gutter `▎+` / `▎−` or substitute `|+` / `|-` when Unicode disabled — both themes must pass `ACT-021`.
- **&lt;24 rows:** transcript minimum **8** rows; activity minimum **4**; composer minimum **2**; status+footer remain **2** rows total.

### 16.21.5 Acceptance linkage

Layout and focus behavior is verified together with §32.16 `UI-002`, `UI-012`, `UI-013`, `UI-014` and §32.48 `ACT-002`, `ACT-009`, `ACT-010`, `ACT-022`.

