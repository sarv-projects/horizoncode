# 40 — HorizonCode OMP-inspired discoverable UI: proposed HLD/LLD and acceptance plan

> **PROPOSAL / NOT ADOPTED / NOT IMPLEMENTED.** This is a source-backed design candidate, NOT an authorization to migrate runtimes, alter existing Goal authority, replace OpenCode TUI, install provider connectors, or consume paid API calls.
> Evidence: [§39 exact OMP UI/85 commands/409 settings registry](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md), [machine-readable metadata inventory](omp-tui-command-settings-inventory.json), [§38 Rust/tools audit](38-OMP-SOURCE-COMPETITIVE-AUDIT.md).
> Existing Horizon authority: §§01–05, 12–17, 20, 22, 25, 29, 31–37; P1.2-B -> P1.3 remains the gating runtime sequence.

## 40.1 User intent, constraints and acceptance

Goal: make HorizonCode immediately understandable and configurable from the TUI, similar to the supplied OMP screenshots: discoverable emoji/icon slash command dropdown, polished full-screen model/provider catalog with powerful roles, low-friction per-provider login/API-key/keyless setup, clear goal objective dialog, settings panels with every available capability and controls, and keyboard-native flow. Preserve Horizon's three-pane workspace, prompt bar, OpenCode/agent fabric, direct-turn contract and managed-work Rust authority.

Success means:
1. Every built-in ActionDescriptor generates usable command, palette, keybinding, menu, CLI and API representations with ONE action ID and arguments; no second registry with divergent execution semantics.
2. Prompt bar always exposes the chosen **agent/harness**, then **a model selector constrained by that agent's model catalog**; a provider hub can show broader models without silently switching an agent or billing path. Existing experience parity (provider-native login, session and model options) must not disappear.
3. User can discover, configure, test and inspect models/providers across OAuth, API key, local and authorized proxy paths, including search/data/media providers, with honest cost/quota/status provenance and refresh controls.
4. A full-screen settings hierarchy can present all source-registered Horizon settings, plugin contributions and validation, including requested/effective/pending/locked snapshots; not merely the 409 OMP controls verbatim.
5. Goal dialog makes objective clear, supports multiline draft and external editor, retains exact criteria/budget/scope, and binds every applied action to managed Goal/Run owner approval.
6. Terminal and desktop share semantics, failures, policy and model status; they may render differently. Overlays do not steal user focus or discard composer text under background events.

## 40.2 UX surface matrix and dependency on existing source

| Feature | TUI presentation proposal | Desktop/web projection | Existing Horizon owner / proposed adapter |
|---|---|---|---|
| Slash prompt dropdown | icon + command + dynamic status + contextual argument preview | slash hints inside composer, command palette | §16 single ActionDescriptor, existing packages/tui/src + packages/app/src |
| Searchable command palette | tabs All, Recent, Commands, Tools, Agents, Settings; can query disabled reasons | palette/modal | §16 ActionDescriptor + capability registry §§29/33/36 |
| Agent selector | main agent/harness, provider-native auth state, capabilities | agent card/picker | §29 AgentProfile/HarnessProfile, actual packages/opencode/Core adapters |
| Compact model picker | bottom-anchored session model popup, @ role short path, Task model toggle | compact popover | OpenCode model selection, no second provider request path |
| Full model/provider hub | Roles, All models, Providers, Models-by-kind, Presets + search/details | model/providers settings route | OpenCode provider/model catalog + Horizon capability/read-only projection |
| Provider connection wizard | select auth type, login/test, refresh discovery, show source/permission | integrated page | SecretBroker + provider adapter + signed-in connection status; no raw secrets in JSON |
| Goal objective editor | framed multiline dialog, outside editor, explicit review action | full goal sheet/draft route | Rust Goal owner, SpecVersion, budgets/criteria and approvals |
| Settings hub | icon tab strip, grouped rows, search, help, source/default/current, apply status | full settings route | existing horizoncode-config crate; §12 typed SettingDescriptor and apply boundaries |
| Extension hub | plugin marketplace and installed panels; skills/hooks/MCP separately filterable | extension store, manager | §29 and governance, namespace/permission restrictions |
| Footer/Inspector | contextual shortcut hints, model/harness + quota + context + status | status bars and inspector | bounded UiEventMux/RuntimeObservation; no invented real-time quota |
| Help/keybindings | hover/secondary help and shortcuts view; ASCII preset | keyboard cheat sheet, shortcuts screen | existing keymap + ActionDescriptor UI metadata |

**Implementation placement rule:** existing package roots verified in repository: packages/tui, packages/app, packages/core, packages/opencode, packages/llm, packages/schema, packages/server, kernel. Prefer new focused components UNDER these existing roots, not the old greenfield Tauri tree, and route owned mutations through current Core/API/Rust private IPC as appropriate. Paths below with *.proposed denote design names, NOT present code.

## 40.3 Slash command presentation contract

Extend (not replace) the existing ActionDescriptor with a separate PRESENTATION projection:

~~~ts
type CommandPresentationV1 = {
  actionId: string;                       // authoritative existing ActionDescriptor action id
  canonicalSlash: string;                 // /goal, /model, /settings ...
  aliases: string[];                      // resolve to actionId, never separate handlers
  title: string;
  description: string;
  iconKey: string;                        // semantic identity e.g. command.goal; glyph from theme
  namespace: "builtin" | "plugin" | "project";
  section: string;                        // Help / Navigation / Work / Models / Integrations ...
  argumentSchemaRef: string;              // actual typed command args
  completionProviderId?: string;          // bounded async completion, no side effects
  dynamicStatus?: { text: string; freshness: "live" | "cached" | "unknown"; checkedAt?: string };
  availability: { state: "enabled" | "disabled" | "unavailable" | "pending"; reason?: string };
  requiredCapabilityIds: string[];
  effectClass: "read_only" | "guarded_effect" | "control";
  shortcutActionIds: string[];            // existing keymap records, no duplicate shortcuts
  helpDocRef?: string;
}
type CommandSuggestionV1 = {
  actionId: string; highlightedSpanIds: string[]; iconKey: string;
  label: string; secondary: string; argumentsHint?: string;
  available: boolean; disabledReason?: string;
}
~~~

Owner flow: explicit user typing triggers prefix index -> rank active/project/recent command -> render dynamic status from bounded projection -> user presses Enter -> parse full command AST + validate typed parameters -> route canonical action -> obtain Guard grant/effect receipt as needed -> UI reports pending/success/failure. Autocomplete NEVER itself performs a privileged operation. Nested subcommand completion resolves actual selectable symbols/capabilities and stable context. Unknown slash command shows an error and an explicit 'Send as message' alternative rather than silently executing tool-ish prompt instructions.

Emoji/icon: resolve command iconKey via Unicode/Nerd/ASCII theme fallbacks, with grapheme-safe width and screen-reader label. Use OMP visual references, not opaque copied byte-to-action mapping. Need a stable built-in icon dictionary plus namespaced plugin icons, with theme portability tests. Long dynamically generated descriptions are clamped/elided without changing accessible full copy. Idle suggestions may show status (e.g. Goal: paused; Model: provider/id; Skills: N enabled); offline statuses show last-check age and 'unknown'.

## 40.4 Model/provider hub contracts and visual design

**Agent/harness and model remain different axes** (critical user requirement). Prompt Bar line: [Agent/Harness] → [Model constrained by selected agent] → [Mode] → [Context] → [Submit]. Agent selection may change which credential path/model-picker options are available, but never deletes or edits other provider auth config. Preserve provider-native model settings, reasoning and tool abilities.

~~~ts
type ProviderCatalogProjectionV1 = {
  providerId: string;
  providerKind: "model_api" | "subscription_harness" | "local" | "gateway" | "web_search" | "other";
  authMethods: Array<"oauth" | "device_code" | "api_key" | "env" | "none" | "broker">;
  credentialRef?: string; // opaque reference, never key
  configured: boolean;
  authState: "unconfigured" | "checking" | "authenticated" | "invalid" | "expired" | "unknown";
  authProvenance?: "stored_login" | "key_ref" | "environment" | "project" | "external";
  lastValidatedAt?: string;
  catalogState: "not_loaded" | "cached" | "refreshing" | "fresh" | "failed";
  modelCount: number | null;
  permissionState: "allowed" | "denied" | "needs_consent" | "unknown";
}
type ModelCatalogRowV1 = {
  providerId: string; modelId: string; label: string;
  kinds: Array<"chat" | "tiny" | "image" | "tts" | "stt" | "search" | "judge" | "embedding" | "rerank" | "video">;
  compatibleAgentIds: string[];
  contextWindow?: { tokens: number; provenance: "declared" | "observed" | "estimated" };
  pricing?: { classification: "free" | "metered" | "subscription" | "trial" | "unknown"; quotedCurrency?: string; source?: string; updatedAt?: string };
  measuredStats?: { ttftMs?: number; tokensPerSec?: number; sampleCount: number; measuredAt: string };
  availability: "selectable" | "locked" | "unsupported" | "unknown";
}
type RoleBindingV1 = {
  roleId: string; ownerScope: "user" | "project" | "thread";
  primary?: { agentId: string; providerId: string; modelId: string; thinkingLevel?: string };
  fallbacks: Array<{ providerId: string; modelId: string; consentRef?: string }>;
  revision: string; configuredVsAuto: "configured" | "auto" | "unassigned";
}
~~~

Create a searchable full-screen hub with left categories Recently Used, Roles (with assigned count), All Models, then Providers, and right kind tabs All, Chat, Tiny, Image, TTS, STT, Search, Judge, Embedding, Rerank, Video when supported. Show badges for unavailable/auth-invalid/locked with reason and login path; do not display stale quota/pricing as live. Selecting provider/model shows its exact source/protocol, tool support, context, input/output modalities, thinking, rate context, pricing class and provider account bound to the action.

Interactive actions required: search; select model for session; pin role to selected model; clear role to default; add/remove/reorder fallback; switch global/project scope; set thinking; save/load/delete named role preset; refresh selected/all discovery (permission-bounded); login/logout/add key; test connection; change model kind; toggle details; escape/restore draft; help. All are command-action-backed; no extra hidden RPC pathway.

**Fallback rule:** candidate role can use only authorized compatible providers within explicit caps and user-approved payment class. No API-billed endpoint simply because another endpoint failed. Runtime reports exact chosen provider and quota/cost provenance. Quota is measured / provider-reported / estimated / unknown, never deduced from the advertised price alone.

## 40.5 Provider/Auth/Integration manager (HLD + interaction)

Top-level 'Connections' explorer organizes into MODEL providers, AGENT harnesses, SEARCH providers, LOCAL runtimes, MCP/connectors, EXTENSIONS. The **same underlying account** may participate in multiple categories, but each adapter has independent capabilities and may require distinct sign-in.

Provider card/action states: Not configured, Login in progress, Configured not verified, Authenticated, Expired, Disabled by policy, Rate-limited, Unavailable, Error. Show configured source and last check, not raw key. Supported auth modes vary per provider; only present flows the adapter declares. Screen-level operations: connect OAuth/device where supported, enter API key to SecretBroker, env reference, add OpenAI-compatible endpoint with explicit TLS/auth policy, discover local engine, refresh/list supported models, verify auth with non-expensive provider-auth checks if available, choose role or current session, inspect limits, disconnect/revoke stored credentials, disable provider, export redacted diagnostics.

Cost/privacy discipline: setting up an API route NEVER sends inference automatically; explicitly name any metered validation/search call. Auto fallback stays within allowed payment/consent policy and can refuse with actionable message. Treat scraped unauthenticated web routes as fragile/unofficial, and do not promise they are always free, compliant or reachable. Search evidence has URL/date/citation provenance and policy. Cache metadata per provider/authScope with TTL, refresh generation and cancellation; never let late refresh overwrite a newly selected account.

Status UI example (illustrative only, NOT live values):

~~~text
╭─ Models & providers ─────────────────────────────────────────────────────╮
│ Roles (6/15)   All Models    Local   Hosted   Search   Media   Judge      │
├─────────────────────┬───────────────────────────────────────────────────┤
│ ◎ Roles             │ Kind: All  Chat  Tiny  Image  TTS  STT  Search...  │
│ ● Connected (2)     │ > provider/model-1 [chat]   ctx: declared        │
│ ○ Login required(1) │   local/model-2    [chat]   price: local         │
│ ● Local (1)         │   provider/model-3 [web]    payment: unknown     │
│                     │ Detail: auth source | account | cap | cost class   │
├─────────────────────┴───────────────────────────────────────────────────┤
│ Enter use once · R roles · F refresh · C connect · / search · Esc close    │
╰─────────────────────────────────────────────────────────────────────────╯
~~~

## 40.6 Goal objective modal and managed state

Horizon goal command must NOT simply toggle OMP-style in-session continuation. It must map to durable GoalDraft and SpecVersion, with explicit acceptance criteria, scope, budget, user confirmation, and Run activation through Rust owner. The entire textarea and external editor are presentation; no effect until typed owner action accepted.

~~~ts
type GoalDraftDialogV1 = {
  draftRef: string; revision: string; currentWorkCaption?: string;
  objective: string; completionCriteria: string[];
  workspaceRefs: string[]; constraints: string[];
  budget: { tokenLimit?: number; monetaryLimit?: number; timeLimitMinutes?: number };
  currentGoalRef?: string; currentGoalRevision?: string;
  dirty: boolean; validationErrors: string[];
  availability: { canPrepare: boolean; canStart: boolean; reasons: string[] };
}
~~~

UI behaviors: full-width bordered multiline field; status heading shows active Goal/Run, scope and revision; Enter/Ctrl+Q or configured submit shortcut; Ctrl+G external editor after safe temp/draft handoff; Esc cancels WITHOUT deleting draft; clear confirmation on overwrite. Submit first prepares or proposes a revision, never starts effects solely because a text field submitted. Separate Review/Approve/Start action; active Goal edits require accepted new SpecVersion and explicit revision binding. Display pause/resume/cancel after accepted owner's receipt; 'Stop' fences future work but does not imply rollback. Show progress, success criteria, budgets, recoverability, verifier evidence, and NeedsYou without lying about completion.

## 40.7 Schema-derived Settings UI (409 OMP rows are inspiration, not target parity)

Source OMP: tab keys Appearance/Model/Interaction/Context/Memory/Files/Shell/Tools/Tasks/Providers plus Plugins. Horizon already has broader sections in §16.6 and an adopted typed configuration owner (horizoncode-config). Render Horizon's owned SettingsDescriptors in a composable TUI tab/sidebar, not a separately maintained static list. Group remaining sections into searchable subpages:
- Appearance (theme, status line, composer, accessibility/keyboard)
- Models (role presets, provider model selection, reasoning, fallback, sampling)
- Providers (account connection/auth, local models, provider protocols, search/media, quota/pricing)
- Agents & Work (harness selector, subagents, plan, goals, budgets, worktrees)
- Files & Editor (CodeMirror/diff, formatting, LSP, file read/write)
- Shell & Tools (execution, permissions, MCP, skills, browser, desktop)
- Context & Memory (indexing, compaction, rules, memory lifecycle)
- Extensions (plugins, MCP, hooks, workflows, marketplaces)
- Privacy & Safety (Guard policies, secret refs, retention, approvals, audit)
- Operations (runtime, UI performance, updates, storage/analytics).

Allow per-mode tabs to break down differently while preserving stable setting paths and ActionIDs. Each row shows Label, effective value, source, modified/pending/locked/invalid reason, default and hover/focus help. Control widgets support boolean, enum, numeric, string, arrays/reorder, record/json, authorized secretref picker, source-browser, conditional fields, and custom trusted plugin controls with namespace.

Use existing owner read records as source of truth: requested, effective, shadowed, Run-locked snapshots, applyBoundary, source provenance, validation. Previewable appearance settings revert upon Escape; editing a security-sensitive setting cannot apply until owner validates it, irrespective of how polished the UI is. Fast search across all tabs, changed-only filter, keyboard up/down/section jumps, status footer and default-reset. Unsupported caps show disabled/reason instead of disappearing if helpful for discovery. No raw API key in value column; no accidental writes to project file when UI says 'Global'.

## 40.8 Menu/buttons/keyboard action inventory — all classes to test

Command popup: toggle open/close, type-query, arrow selection, context hint, enter dispatch, Tab completion, argument suggestion, alias lookup, show disabled reason, help/detail, sorting recent/favorites.
Model picker/hub: open compact/full, scope toggle, provider row, kind tab, search, select session model, role apply/clear/scope, fallbacks add/remove/reorder, thinking, presets, per-provider refresh, login, filter, escape.
Provider setup: choose provider/category, OAuth/device/secret ref/keyless path, copy browser link, input one-time code, cancel, refresh, test, disable, disconnect, open auth provenance/error, retry under explicit cost consent.
Goal: open dialog, edit objective, paste multiline, external editor, submit draft, validate, review criteria, approve/start, revise, pause, resume, cancel, budget, discard draft, restore work.
Settings: open, tab switch, group jump, search, row select, toggle, cycle choices, edit number/text, reorder array, edit record, preview, cancel revert, reset-to-default, show provenance, save, resolve apply-pending and capability restrictions.
Plugins/extensions: browse sources, install (permission gated), uninstall, enable/disable, update, inspect permissions/dependencies, reload, see source identity and failures.
Status/terminal: overlay resize, width fallbacks, mouse/keyboard, icon fallback, foreground focus, navigation return, context menu, usage/context, inspector activation, clipboard policy, no background modal injection.

These are interaction ACTION classes, not evidence that every command/setting already exists or that all OMP 409 rows become mandatory HorizonCode V1 controls.

## 40.9 UAT / contract tests (must exist before claim of parity)

1. Snapshot registry uniqueness: all builtin slash aliases resolve canonical action, no shadowing; typed parameters remain identical across button, slash, keymap, SDK, CLI.
2. Exact command icon Unicode/Nerd/ASCII width stable and accessible full label; emojis don't change action IDs.
3. Slash dropdown shows live state, preserves focus/draft; stale arrival cannot overwrite newer search/selection; unknown and unauthorized commands never execute.
4. Compact model picker session-only; role preset/global/project persists only when explicitly chosen; Task model selection does not change main agent.
5. Agent/harness change re-filters allowed models without deleting provider auth/config or starting unrelated provider work.
6. Provider discovery: cached offline, refresh failure, invalid auth, disabled provider, unknown price, local models and subscription-vs-API misclassification.
7. Paid fallback absent authorization MUST STOP, with accurate provider-used and quota/price provenance; web search never silently charges.
8. Auth key never rendered/logged; env key shows source/override only; imported provider config cannot bypass policy.
9. Settings field-type exhaustive tests: boolean/enum/numeric/string/array/record/secret, conditional toggle, dynamic plugin injection; requested/effective/locked state and applyBoundary correctly reflected after restart.
10. Theme live preview reverts on cancel; per-tab horizontal scroll; 80/110/150 column layouts; terminal resize; screen reader and high-contrast tests; no focus theft from background events.
11. Goal draft submit does not start Run; active-goal revision requires new SpecVersion and owner acceptance; external editor preserves draft across failure; Stop/Cancel/NeedsYou align durable receipts.
12. Plugin marketplace commands require explicit source trust and permission; collision names and hidden conflicting controls rejected.
13. Offline CPU/memory budgets and measured latency targets from §31; no model-picker refresh or full fuzzy index blocks first paint.
14. Performance UAT at 10, 200, 5,000 and 50,000 models in catalog; 200/400/1,000 settings; 100/500/2,000 commands; P95 start/scroll/selection/cancel and stable viewport state.

## 40.10 Integration sequencing and decision gate

- Research only (completed here): §39 source inventory (85, 409, 15, 10), screenshots, UI design §40, no copied code.
- Preserve current implementation P1.2-B -> P1.3 first. Do not introduce UI-only authority, new native Node add-ons or alternate Session APIs.
- After explicit design approval, break implementation into independently testable slices: 1 typed presentational command/icon registry and autocomplete; 2 schema-derived settings shell; 3 provider/model UI projection (read-only); 4 provider auth manager/wizard with secret references; 5 role/fallback/presets with cost policy; 6 durable Goal modal; 7 extension marketplace and terminal accessibility/performance; 8 desktop/web semantic parity. Each slice requires tests and honest UI status before marking shipped.
- Before adopting upstream code: per-file license/dependency/attribution review, exact source pin, API compatibility, benchmark and threat model. Prefer OpenCode native UI primitives and backend rather than copy OMP renderer/credential engine.
- Implementation plan and any product code changes are future work. §§16/22/29/31/33/37 already define normative Horizon owners; this proposal must not overwrite them until user explicitly accepts the differences and §17 records adoption.

## 40.11 Open questions requiring design choice

- How many OMP-inspired short UI tabs should be first-class in a three-pane Horizon TUI versus modal settings subpages? Recommended: tabs as overview, groups within; retain all §16 categories via search.
- Should custom provider/model roles be persisted at project, Thread or user scope by default? Recommended: user by default, explicit scope switch with source label.
- Whether to offer 'Advanced' vs 'Basic' settings views while keeping Search results exhaustive. Recommended: Basic for daily controls, Advanced for all registered owner settings.
- Which provider health checks are free/low-impact vs paid? Contract must declare this per adapter; unknown means no automatic call.
- Model role/fallback coupling to selected AgentHarness: recommended enforce compatibility and explicit payment policy, with no silent harness switching.

## 40.12 Provider source roster and UI compatibility note

A pinned OMP inventory identifies 20 pure web-search provider adapters, six model-grounded search backends, ten catalog model kinds, and 92 provider-rule KDL files; see [the exact source roster](omp-provider-source-roster.json) and [§39.10](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md#3910-exact-static-provider-source-roster--not-proof-of-enabled-providers). These counts refer to different levels. A catalog file, an installed account connector, and a working paid/credentialed endpoint are NOT interchangeable.

The Horizon UI needs one browser for every provider type with capability filters, but the execution path must remain provider-specific: direct model API, supported authenticated coding harness, local runner, web search, image/speech/embedding/reranking service and extension. Show supported vs unsupported and selected/active vs configured/unverified rather than simply a green circle for every source file.

## 40.13 Streaming visuals and artifact status integration proposal

The [§41 source audit](41-OMP-STREAMING-VISUAL-ARTIFACTS-AUDIT.md) adds a visual-output proposal to the model/provider/settings/goal UX: render safe streamed SVG revisions in mutable transcript rows, render Mermaid only after fence close, append deterministic chart graphics underneath complete numeric Markdown tables, and preserve original accessible source, source/raster version and artifact FULL/SAMPLE receipt. A visual preview is not automatically exported or stored. Pending raster, native capability absent, stale epoch, parser fault, renderer timeout and artifact persistence failure each require clear user state. Optional judge-planned charts and hosted image generation require explicit provider/cost consent. Target runtime must preserve §31 and §37 ownership, not copy OMP renderer wholesale.
