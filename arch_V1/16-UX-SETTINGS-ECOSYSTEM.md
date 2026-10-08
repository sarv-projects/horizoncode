# 16. UI, actions, settings and extension ecosystem

OpenCode TUI/web/desktop surfaces remain the product shell; this document specifies
Horizon routes and interaction contracts without adding a parallel UI framework. All
visible execution facts are owner projections. A UI interaction may request an owner
command but cannot create a canonical transition locally.

## 16.1 Surface and navigation model

The default terminal work area has exactly three primary regions and a persistent
Prompt Bar:

```text
┌───────────────────────────────────────────────────────────────┐
│ workspace / project / mode / Run status / global actions      │
├─────────────────┬─────────────────────────┬─────────────────┤
│ LEFT            │ CENTER                  │ RIGHT           │
│ Explorer/tabs   │ active route            │ inspector       │
│ fixed slots     │ fixed slots             │ fixed slots     │
├─────────────────┴─────────────────────────┴─────────────────┤
│ Prompt Bar: draft / references / mode / submit lane           │
└───────────────────────────────────────────────────────────────┘
```

Plugins contribute to named slots; they cannot create a permanent fourth pane or
mutate the root layout. Core shell routes include Pair, Mission Control, Review and
Explore. Temporary presentation is a center route, tab, modal, overlay or maximized
pane, not a new permanent region.

| Route | Left | Center | Right |
|---|---|---|---|
| Pair (default) | explorer, open files, diff tabs | Thread conversation | Task list, approvals/Needs You |
| Mission Control | workers, workspaces, executions | Run summary, Task list; DAG optional | selected Task/Attempt/Worker and Needs You |
| Review | changed files | syntax-aware diff and evidence | findings, acceptance checklist, verification state |
| Explore | files and symbols | dependency/caller/callee graph | selected definition, references and diagnostics |

First-class routes include Thread browser/search, Goal draft/preparation/review,
Run timeline/summary, Task/Attempt/Worker/Workspace inspectors, Permissions/Needs
You, Diff, Proof Pack/Evidence/Check Result, Checkpoint/Recovery/Conflict Resolver,
Context/Memory/Artifact inspectors, Agents/Profile Editor/Subagent Builder,
Provider/Model/Auth, Extensions, Settings, Usage/Analytics, Doctor, Updates, Help,
Command Palette and Which-Key.

Terminal adaptation preserves conceptual focus and state: at 150+ columns show the
normal three-pane layout; 110–149 compact three panes; 80–109 one focused primary
pane at a time; below 80 use a chat-first single column. Breakpoint changes preserve
draft, selected Task, current file, scroll, pane intent and selection. A background
event may update a badge but cannot steal composer focus, switch the route/file,
scroll transcript, open a modal or overwrite a draft. NeedsYou is surfaced first as a
badge unless the user explicitly navigates to its response flow.

Web and desktop surfaces reuse OpenCode Solid UI/app and Electron structures where
available and consume the same public Horizon API projections. They do not have a
second lifecycle implementation. Desktop/web routes may use spatial layouts rather
than terminal breakpoints, but preserve the same action IDs, meanings, state
vocabulary and approval digest.

## 16.2 Prompt Bar and typed references

Composer contract: multiline editing, local draft persistence, history/stash,
attachments, typed references, slash suggestions, skill invocation, profile/model/
reasoning selection, external editor, direct-command entry where authorized, and
explicit `steer`/`queue` submission. Draft identity is independent from submitted
InputId; clearing or late completion of one cannot erase a newer draft. Draft
recovery is local UI state, not a durable Thread input until the kernel acknowledges
admission.

Typed references are:

```text
@file:<path>      @symbol:<name>    @agent:<profile>
@task:<id>        @run:<id>         @skill:<id>
@artifact:<id>    @proof:<task>
```

Resolution yields a typed reference ID, current generation/revision and display
label. It may add context or route selection; it never grants read/write permission,
reads a secret, dispatches a worker or approves a Run. Expired/missing references
remain visibly unresolved until reselected; do not silently bind them to a different
object with the same name.

## 16.3 Shared ActionDescriptor and command execution

Buttons, keybindings, slash commands, palette, SDK and API resolve to the same
ActionDescriptor and owner action. The descriptor schema is defined in `07-UX-COMMANDS.md`;
runtime instances additionally include the effective configuration/availability
reason, source registration generation, idempotency requirements, foreground token
requirement and presentation route. A command callback is a thin parser/adapter and
does not carry business logic or shell authority.

Command grammar:

- Commands are registered by stable action ID and typed argument schema.
- Unknown `/name` is an error, never ordinary prompt text.
- Built-in names are reserved. Extensions use a qualified form such as
  `/acme:deploy`; collisions reject composition before activation.
- Parsing rejects extra/ambiguous arguments and never coerces an identifier into a
  different domain kind. Completion only suggests; it does not execute.
- Destructive/control commands show the target scope and resolved identity before
  submission. `/quit` means detach/exit; `/cancel` requires exact Run/Task/Attempt;
  `/stop-now` installs a fence and terminates supported work but is not rollback.
- Repair actions are explicit and owner-backed. `/doctor` is read-only by default.

### Built-in command registry

| Group | Commands and meaning |
|---|---|
| Thread/navigation | `/new`, `/sessions`, `/sessions search <query>`, `/sessions resume <id>`, `/rename <title>`, `/branch`, `/fork`, `/clear` (projection only), `/workspace [pair\|mission\|review\|explore]`, `/focus`, `/panels`, `/dock`, `/recap`, `/queue`, `/quit` |
| Direct turn | `/mode [chat\|explore\|plan\|code]`, `/model`, `/agent <profile>`, `/context [show\|sources]`, `/compact [preview]`, `/diff`, `/review [base..head]`, `/explore <request>`, `/shell`, `/editor` |
| Agents | `/agents`, `/agents show\|create\|edit\|enable\|disable\|probe\|discover\|add\|trust`, `/agents message send\|list`, `/subagents`, `/subagents assign\|create\|limits` |
| Managed work | `/goal`, `/goal set\|prepare\|clarify\|start\|revise\|clear\|yolo`, `/run [id]`, `/attach <run>`, `/tasks`, `/plan`, `/spec`, `/specdriven`, `/pause <run>`, `/resume <run>`, `/cancel run\|task\|attempt <id>`, `/stop-now <run>`, `/verify [task\|run]`, `/proof <task>` |
| Checkpoint/recovery | `/checkpoint create\|list\|restore <id>`, `/rewind turn`, `/rewind files <paths>` (each previews before owner action), `/recovery` |
| Provider | `/providers`, `/providers show <id>`, `/providers quota [refresh <id>\|clear]`, `/connect <provider>` |
| Extensions | `/extensions`, `/connectors` or `/apps`, `/mcp` or `/mcps`, `/skill` or `/skills`, `/create-skill`, `/plugin` or `/plugins`, `/plugins graph`, `/hooks`, `/workflows`, `/workflow`, `/marketplace`, `/litepsm` |
| Memory/artifacts | `/memory`, `/memory status\|search\|candidates\|candidate accept\|reject <id>\|remember\|edit\|forget\|purge`, `/artifacts`, `/export` |
| Permissions/system | `/permissions`, `/approve <challenge>`, `/deny <challenge>`, `/settings`, `/theme`, `/usage`, `/tokens`, `/insights`, `/doctor`, `/doctor plugin-graph`, `/commands`, `/help`, `/upgrade`, `/init` |

Aliases are explicit entries pointing to one action ID, not alternate implementations.
The generated registry owns exact flags, enum values and argument schemas. Registry
changes have compatibility tests for TUI autocomplete, CLI parser, SDK route and
unknown-command failure.

`/goal yolo <run>` requests an explicitly bounded reduced-approval posture and is
itself a Guarded, review-digest-changing action. It cannot approve a SpecVersion,
override policy DENY, bypass PREPARED/effect settlement, widen Task/profile authority,
or make an unsupported sandbox guarantee available. Its exact action-class limits
must be fixed by the approved policy snapshot; if policy does not define them, the
command is unavailable rather than guessed.

## 16.4 Keymaps and accessibility

Retain OpenCode's layered keymap and command architecture. Initial defaults:

```text
Alt-1/2/3        focus left / center / right
F1               operational inspector
F2               focus/maximize workspace
F3               command palette
Ctrl-W Tab       cycle pane
Ctrl-W S/C/M/X/0 side-pane operations / reset layout
Esc              close local suggestion/overlay; otherwise request safe Turn interrupt
Ctrl-C           context-sensitive interrupt, with resolved scope shown
```

Text editors, PTYs and IME composition own their keystrokes before global keymaps.
User/plugin collision is rejected with both action IDs and a rebind affordance;
activation order never selects a winner. A visible focus indicator is present on
every interactive control, including controls inside dialogs; focus is stable. All
actions have accessible names/state and work without color alone. At minimum, focus
is not fully obscured by fixed headers, footers or persistent overlays. Web views meet
WCAG 2.2 AA focus-visibility and keyboard-navigation requirements; do not claim the
enhanced AAA fully-unobscured criterion unless separately tested. Screen readers receive
concise state transitions and explicit live-output-gap notifications, not per-token
status spam. Approval dialogs trap/restore focus and expose exact action, scope,
deadline and response options. Motion is optional/reduced-motion aware and
never substitutes an animation for a truthful state. No fake typing, tool or worker
activity is displayed.

## 16.5 Status and operational inspector

The top-level friendly states are `Thinking`, `Working`, `Waiting for you`, and
`Idle`; each is backed by a precise detail state: `preparing`, `queued`,
`provider-streaming`, `executing-tool`, `waiting-approval`, `waiting-question`,
`integrating`, `verifying`, `recovering`, `reconciling-effect`, `cancelling`,
`cancelled`, `stopped`, `failed`, `unknown`, or `verified-complete`.

These are presentation projections, not persisted lifecycle enums. In particular,
`verified-complete` is rendered only when the RunController completion predicate
evaluates true against current owner state and all acceptance steps are current; it is never inferred from
provider, process, or worker status.

Display source/cursor and timestamp where freshness matters. A heartbeat never means
success. Unknown is shown as unknown, not a spinner or red failure. A green check is
allowed only for current accepted Evidence/Task PASS. Operational Inspector includes
Thread/Turn, Run/Task/Attempt/WorkerExecution, profile/model/reasoning and whether
each was configured/observed/enforced, workspace/revision/fence, provider attempt,
tool/effect and approval, observed usage/budget, last durable event cursor, current
recovery state and guarantee residuals. Context recovery shows stage, bounded
attempts, circuit state and typed last failure; retry suppression shows owner cursor
and count without hiding the failed operation. Memory inspection shows permitted
scope, generation/freshness, queued extraction/consolidation state and candidate
review status, never unrestricted content. MCP inspection shows the typed connection
snapshot, config/toolset digest, observation age and redacted error. Raw prompts,
secrets and unbounded output are not shown by default.

## 16.6 Settings and configuration

Settings are typed records with requested/effective value, source, shadowed sources,
lock owner, validation and capability status, apply boundary and digest. Preference
precedence is `defaults < user < project < Thread < explicit invocation`; Run may
snapshot/lock values. Managed policy does not participate as another precedence
layer, but may constrain/lock the effective value. Security authority uses the
independent Guard hierarchy and narrows only.

The existing `horizoncode-config` module (`crates/horizoncode-config/src/settings.rs`)
owns setting registration, validation, resolution and apply records; extend it, not a
new settings engine. The exact versioned typed descriptors, resolution/apply records
and requested/effective snapshot references are defined in §12. UI renders those owner
records and submits typed owner actions; it neither reconstructs precedence nor
changes the effective snapshot locally. `SettingApplyBoundaryV1` has exactly
`immediate | next_provider_turn | next_attempt | restart`; `SettingScopeV1` has exactly
`defaults | user | project | thread | invocation`. ActionDescriptor uses the same
apply-boundary type, not an independently maintained enum.

Migration maps legacy `immediate` → `immediate`, `next_turn` → `next_provider_turn`,
`default` → `defaults`, `global` → `user`, and `project` → `project`. Preserve original
source bytes, source references, contributors, shadowed values, validation diagnostics
and digests with their schema versions; retain a read-only rollback source. New scopes
and apply boundaries are explicit additions, never inferred from a legacy value.
Migration is idempotent/versioned; unsupported or ambiguous data is diagnosed rather
than silently assigned a scope or made effective.

A saved request is not proof of application. Resolution records distinguish the
requested snapshot/source from the currently effective snapshot/source; a valid
deferred request remains pending until its declared safe boundary and an owner apply
receipt. Invalid or capability-unavailable requests remain visible with their reason,
not falsely effective. Run locks identify their owner and pinned digest; later requests
may remain pending for eligible future work but cannot replace locked Run values or
the in-flight Turn/Attempt snapshots. UI shows pending/rejected/locked state and both
references, including after restart and migration.

Proposed configuration split:

```text
<user-config>/hzcode/hzcode.jsonc     execution preferences
<user-config>/hzcode/tui.jsonc        appearance/keymaps/layout
<user-config>/hzcode/plugins.lock     resolved package digests/graph
<project>/.hzcode/hzcode.jsonc        project preferences, schema-validated
<project>/.hzcode/plugins.jsonc       requested project contributions only
<project>/AGENTS.md                   untrusted project instructions
```

No configuration file contains raw provider/MCP secrets. Project config cannot
change the security floor, Guard policy, kernel paths, audit settings, capability
leases or install trust roots. Provider refs use secret identifiers. Unsafe/malformed
config is rejected with a location and reason; partial silent fallback is forbidden
for security-sensitive fields. Each setting declares an apply boundary: immediate,
next provider turn, next Attempt, or restart. In-flight turns/attempts retain their
pinned revisions.

Top-level groups: General; Appearance; Accessibility; Keybindings; Composer;
Providers; Models; Agents (Main, Default Subagent, Specialists, Runtimes, Delegation);
Tools & Shell; Context; Repository Intelligence; Memory; Permissions & Safety;
Approval Posture; Run Budgets; Agent Limits; Extensions (Connectors, MCP, Skills,
Plugins, Hooks, Workflows); Notifications; Storage; Performance; Runtime/Supervisor;
Privacy & Retention; Analytics; Updates & Installation; Advanced.

Plugins may define only `plugin.<plugin-id>.*` settings. They cannot shadow
`security.*`, `guard.*`, `kernel.*`, or `audit.*` unless the sealed product
composition declares that exact trusted system owner.

Memory settings expose retrieval scopes, retention, candidate review and an explicit
scoped extraction enablement. If no valid enablement/policy exists, extraction does
not run. Users can inspect, accept or reject candidates and tombstone records through
MemoryService; every model-derived candidate requires a review receipt bound to its
exact digest/scope. Deleting an index projection is not represented as deleting
canonical memory. Consolidation is shown as interruptible low-priority work with its
pinned scope/generation and proposed changes before acceptance.

## 16.7 Agent profile and provider surfaces

Agent browser distinguishes built-in/user/project/plugin/external provenance,
enabled/invocation mode, runtime health, selected model/reasoning, supported vs
unknown capabilities, tools/skills/MCP loadout, authority ceiling, isolation,
limits, profile revision and in-flight consumers. The editor previews effective
authority and reports invalid capabilities before save. Saving a profile is not
dispatch. The `subagent-builder` skill emits the same draft schema and validation
errors as the Settings UI; it cannot enable, trust or widen automatically.

The Agents settings surface keeps common choices compact and exposes the full schema
progressively:

```text
Agents
│
├── Main Agent
│
├── Default Subagent
│   ├── Enabled
│   ├── Model
│   └── Reasoning
│
├── Built-in Specialists
│   ├── Architect
│   ├── Explorer
│   ├── Implementer
│   ├── Reviewer
│   └── Test / Debugger
│
└── Custom Subagents
    └── Profile Editor
        ├── Identity
        │   ├── Name
        │   ├── Description
        │   ├── Purpose
        │   ├── When to use
        │   └── When not to use
        │
        ├── Invocation
        │   ├── Manual only
        │   ├── Suggest
        │   ├── Automatic
        │   └── Matching rules
        │
        ├── Intelligence
        │   ├── Model
        │   └── Reasoning
        │
        ├── Runtime
        │   ├── Horizon native
        │   ├── ACP
        │   └── CLI / external
        │
        ├── Capabilities
        │   ├── Native tools
        │   ├── Skills
        │   └── MCP
        │
        ├── Context
        │   └── Context policy
        │
        ├── Memory
        │   └── Memory policy
        │
        ├── Hooks & Lifecycle
        │   ├── Before start
        │   ├── After start
        │   ├── Before tool
        │   ├── After tool
        │   ├── Tool failure
        │   ├── Before finish
        │   ├── After finish
        │   ├── Failure
        │   └── Idle
        │
        ├── Isolation & Permissions
        │   ├── Isolation
        │   ├── Authority ceiling
        │   └── Effective permissions preview
        │
        └── Limits
            ├── Max turns
            ├── Wall time
            ├── Tool calls
            ├── Input tokens
            ├── Output tokens
            ├── Attempts
            └── Concurrency
```

Default Subagent remains the small `enabled` / `model` / `reasoning` surface; specialist
and custom profiles use the expanded editor. Hook rows select registered Hook
contributions by lifecycle event and show required/optional status, provenance, and
compatibility/enforcement for the selected runtime—never inline scripts. `Max turns` is
optional; an empty value means no profile-specific turn ceiling, not removal of
enclosing Task/Run or other resource limits. The editor previews the effective limits
and explains when a required hook or hard limit cannot be enforced by the selected
adapter. Saving creates a new immutable profile revision; existing workers keep their
pinned profile, hook set and limits.

The inspector shows the Attempt-scoped completed-provider-response count and whether
the adapter observes/enforces it. Replacing a WorkerExecutionId during recovery does
not reset this counter or hook set; a new Attempt resets only the profile counter,
not aggregate Task/Run budgets. Opaque adapters cannot claim hard-limit enforcement.
`AGENT_LIMIT_EXCEEDED` and BudgetService `BUDGET_EXCEEDED` are presented distinctly.

Provider browser uses OpenCode registry/catalog data as advisory metadata. It shows
source/digest/freshness, provider/model/protocol, observed capability and route
readiness distinctly. Model selection is explicit; pricing may be visible and used
for budget/accounting but never silently ranks or downgrades. A quota observation is
timestamped and is not a guarantee of provider availability. Auth uses SecretBroker
flows and never prints credential values.

## 16.8 Extension ecosystem and lifecycle

One Extensions surface groups Connectors, MCP, Skills, Plugins, Hooks, Workflows and
Marketplace. Discovery is not installation, trust, enablement or permission. First
view shows name, kind, source, status and primary action; details show publisher,
version/digest, provenance/license metadata, runtime, requested capabilities, config,
auth, probe/compatibility, effective permissions and recent health.

Plugin install: discover → inspect provenance → stage exact bytes → validate
manifest/digest/schema/signature policy → review capability requests → configure →
probe without production authority → enable → activate. Failure leaves a staged,
disabled generation. Upgrade stages G+1 and routes new work only after health/compat
checks; G drains pinned consumers before disposal. If generations cannot coexist,
upgrade waits for drain. Quarantine denies new leases immediately and exposes affected
operations to recovery.

MCP server tool definitions are normalized and pinned by server identity + schema
generation. `tools/list_changed` or reconnect applies at the next safe provider-turn
boundary. Each call passes through Guard/EffectService; no direct server side effect
is considered protected merely because the tool appeared in a picker. Skills are
declarative content and supporting assets/scripts; progressive disclosure loads name
and description, then selected body, then referenced resources. Text and
`allowed-tools` are hints, never authorization. Workflows are declarative
TaskGraphTemplates with versioned parameter schemas, required capabilities,
verification plan and default budgets; RunController compiles them into ordinary
Goal/Spec/Run/Task records.

MCP rows use `McpServerSnapshotV1` states and freshness, not a synthetic boolean:
`CONNECTED` reports only an observed protocol connection and is not tool authorization
or call success. A stale/unknown snapshot cannot silently rebind an in-flight tool;
configuration and toolset generation changes apply at the next safe provider-turn
boundary. Display the exact observed state, timestamp, typed redacted error and
availability separately.

LiteSPM may own package catalog acquisition, conversion, package install/version
pinning and journaling. Kernel CompositionService owns the durable composition lock,
approved capabilities and generation lifecycle; host CompositionResolver/PluginRuntime
executes the pinned graph and reports activation/health. Guard, tool execution and Run
truth remain with their sealed owners. One package-install owner must be selected per
scope; LiteSPM and native manager cannot concurrently mutate the same package
installation. Its exact package integration and transfer semantics remain a product
decision in [`17-GOVERNANCE-DECISIONS.md`](17-GOVERNANCE-DECISIONS.md).

## 16.9 OpenCode adoption and compatibility

| OpenCode area | v1 treatment |
|---|---|
| Core V2 + `packages/llm` | Production Thread runner and provider protocols after kernel ThreadStore adapter and whole-response tool-admission change |
| Core Schema/Protocol/Server/Client/SDK | Retain; add generated public Horizon route groups |
| OpenTUI/Solid TUI, keymap, composer, dialogs, themes, palette | Retain and compose through fixed slots/actions |
| Solid web/app and Electron shell | Retain/adapt to Horizon projections and exact API |
| Session DB | Replace as production authority with Rust Thread; keep migration/test/projection only |
| Process-local Session drain | Keep as host coordination only; never claim durable recovery |
| Provider catalog/pricing/auth UX | Retain/adapt behind route snapshots and SecretBroker; pricing is accounting only |
| Permission presentation | Retain/adapt; Guard replaces local permission decision authority |
| Local tool definitions | Retain model-facing shape; route all effect execution through Horizon owners |
| MCP/ACP | Retain protocol/SDK implementation, adapt transport/capabilities and truthful limits |
| LSP/formatter registry | Retain discovery/config data; ExecutionHost owns supervision and Guarded effects |
| TUI plugin model | Retain slots/contributions; third-party server-side executable hooks isolated |
| Legacy server plugins | Compatibility worker only; unsupported hooks fail closed |
| Hosted OpenCode services | Optional and feature-detected, never a local v1 dependency |

This maps OpenCode concepts into Horizon without creating a second engine. Where the
source has a behavior that violates durable ownership or effect guarantees, the
Horizon integration must adapt that seam and mark the capability unsupported until the adaptation
is implemented and accepted.

## 16.10 UI contract tests

At minimum: command and keymap collision diagnostics are deterministic; unknown slash
commands do not submit prompts; every entrypoint resolves to the same ActionId;
approval displays the same digest that Guard resolves; a late response preserves a
new draft; steer/queue boundaries match kernel receipts; `/quit` does not cancel;
unknown state is not rendered as success/failure; a background plugin cannot navigate
or steal focus; narrow-width layout preserves selection/draft/scroll; keyboard and
screen-reader paths can resolve NeedsYou and approval; reduced-motion settings remove
decorative movement without hiding status; and no generated mock/catalog data appears
as live acceptance.

Settings fixtures exercise the §12 typed descriptors and requested/effective references,
all legacy scope/apply mappings, source-preserving idempotent migration, deferred apply
after restart, rejected requests, and Run-locked values remaining effective after edits.
Command fixtures accept `/rewind turn` without paths and `/rewind files <paths>` with
explicit paths; paths on the turn form are rejected before dispatch. Update UI permits
download/staging/read-only inspection but never active-binary activation or live schema
mutation while unresolved effects or workers own mutable state, even if fenced UNKNOWN.
