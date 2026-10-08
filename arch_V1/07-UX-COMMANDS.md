# 7. UI, CLI, and command surface

## 7.1 Surface ownership

The OpenTUI + Solid TUI and OpenCode web/desktop surfaces remain the product shell.
The Rust kernel owns canonical state; UI maintains only drafts, focus, layout and
rebuildable projections. Direct mode is lightweight and prompt-first. Managed mode is
an explicit reviewed workflow, not a mandatory wrapper for every request.

The terminal workspace has three primary regions and a persistent Prompt Bar:

```text
┌──────────────────────────────────────────────────────────────┐
│ workspace / project / run state / global actions             │
├────────────────┬────────────────────────┬───────────────────┤
│ left explorer  │ center route           │ right inspector   │
│ plugin slot    │ chat / review / tasks  │ details / needs-you│
├────────────────┴────────────────────────┴───────────────────┤
│ persistent prompt / composer                                 │
└──────────────────────────────────────────────────────────────┘
```

When terminal width is constrained, collapse to one focused region without losing
draft, selected Task, open file, scroll, or pane intent. A background event may update
badges but may not steal focus, switch route, scroll transcript, open a modal, or
replace draft text. `Needs You` is durable and answers: why, affected work, consequence
of no response, and exact available action.

## 7.2 Primary views

| View | Default content |
|---|---|
| Pair | Left: explorer/open files; center: Thread transcript; right: Task list/Needs You |
| Mission Control | Left: workers/workspaces; center: Run outcome and Task list (DAG optional); right: selected Task/Attempt/Worker and Needs You |
| Review | Left: changed files; center: syntax-aware diff and evidence; right: findings and acceptance status |
| Explore | Left: files/symbols; center: dependency/caller view; right: definition/reference/diagnostic detail |
| Operational Inspector | Thread/Turn, Run/Task/Attempt/Worker, profile/model/reasoning, workspace/revision, provider attempt, tool/effect, budget, approval and last durable cursor |

Other first-class routes: Thread browser/search, Goal draft/preparation/review, Run
timeline/summary, Task/Attempt/Worker/Workspace details, Permissions/Needs You, Diff,
Proof Pack/Evidence, Check Result, Checkpoints/Recovery/Conflict Resolver, Context,
Memory and Artifact inspectors, Agent/Provider browsers, Extensions, Settings, Usage,
Diagnostics, Updates, Help, Command Palette and Which-Key.

## 7.3 Prompt Bar and references

Composer supports multiline editing, persistent local draft, history/stash, attachments,
typed references, slash suggestions, skill invocation, agent/model/variant selection,
external editor, direct shell entry where authorized, and explicit `steer`/`queue`
submission. A late provider response cannot erase text typed after submission.

Typed references include `@file`, `@symbol`, `@agent`, `@task`, `@run`, `@skill`,
`@artifact`, and `@proof`. A reference adds routing/context only; it does not grant
permission, dispatch work, read a secret or confirm a Run.

## 7.4 One ActionDescriptor registry

Buttons, keybindings, slash commands, command palette, SDK and public API actions
resolve through one typed `ActionDescriptor`:

```ts
type ActionDescriptor = {
  id: ActionId
  title: string
  category: string
  ownerService: ServiceId
  argumentSchema?: JsonSchemaRef
  availability: AvailabilityRule
  effectClass: "navigation" | "query" | "local_preference" | "guarded_mutation" | "control"
  applyBoundary: SettingApplyBoundaryV1
  resultView?: RouteId
}
type AvailabilityRule = {
  requiredServices?: ServiceId[]
  requiredCapabilities?: string[]
  supportedSurfaces?: Array<"tui" | "web" | "desktop" | "cli" | "sdk">
  requiresForegroundToken?: boolean
}
type ActionAvailabilityV1 = {
  state: "AVAILABLE" | "UNAVAILABLE" | "REQUIRES_CONFIRMATION"
  reasonCode?: string
  explanation?: string
  checkedAt: Timestamp
  compositionGeneration?: CompositionGenerationId
}
```

`AvailabilityRule` is static registration metadata; `ActionAvailabilityV1` is the
current owner/composition evaluation attached to the rendered action. Neither is an
authorization grant: the operation owner rechecks authority when the action executes.

Actions check availability and submit owner commands; they do not embed duplicate
business logic. Unknown slash commands are errors and never fall through as LLM text.
Built-in command names are reserved; extension commands are namespaced (for example
`/acme:deploy`) and collisions fail composition.

## 7.5 Command registry

Commands are a target surface and each maps to an action. This table is a compact
capability index; the expanded v1 built-in command list and parser/lifecycle rules are
in [`16-UX-SETTINGS-ECOSYSTEM.md`](16-UX-SETTINGS-ECOSYSTEM.md#163-shared-actiondescriptor-and-command-execution).
Exact flags/argument schemas belong to the generated command registry.

| Area | Representative commands |
|---|---|
| Thread/navigation | `/new`, `/sessions`, `/sessions search`, `/sessions resume`, `/rename`, `/branch`, `/fork`, `/clear`, `/workspace`, `/focus`, `/panels`, `/queue`, `/quit` |
| Direct coding | `/mode`, `/model`, `/agent`, `/context`, `/compact`, `/diff`, `/review`, `/explore`, `/shell`, `/editor` |
| Agents | `/agents`, `/agents show\|create\|edit\|probe\|discover\|add\|trust`, `/subagents`, `/subagents assign\|create\|limits` |
| Goal/Run | `/goal set\|prepare\|clarify\|start\|revise\|clear`, `/run`, `/attach`, `/tasks`, `/plan`, `/spec`, `/pause`, `/resume`, `/cancel run\|task\|attempt`, `/stop-now`, `/verify`, `/proof` |
| Recovery | `/checkpoint create\|list\|restore`, `/rewind turn`, `/rewind files <paths>`, `/recovery` |
| Providers | `/providers`, `/providers show`, `/providers quota`, `/connect` |
| Extensions | `/extensions`, `/connectors`, `/mcp`, `/skills`, `/create-skill`, `/plugins`, `/plugins graph`, `/hooks`, `/workflows`, `/marketplace` |
| Memory/artifacts | `/memory`, `/memory remember\|search\|edit\|forget\|purge`, `/artifacts`, `/export` |
| System | `/permissions`, `/approve`, `/deny`, `/settings`, `/theme`, `/usage`, `/tokens`, `/insights`, `/doctor`, `/commands`, `/help`, `/upgrade`, `/init` |

`/quit` closes/detaches the client; it does not cancel a Run. `/cancel` names a specific
scope. `/stop-now` installs a fence and terminates supported processes but cannot undo
external effects.

## 7.6 Settings and precedence

Settings are typed and show requested/effective value, source, shadowed sources,
validation/capability status, apply boundary and digest. Ordinary preferences resolve
from defaults → user → project → Thread → explicit invocation. Managed policy may lock
a preference. Security authority is a separate narrowing-only Guard hierarchy.

The existing configuration module owns typed descriptors, resolution and apply records
defined in §12; actions use `SettingApplyBoundaryV1`, and settings source scopes use
`SettingScopeV1`. UI consumes requested/effective snapshot references rather than
resolving or applying settings itself; pending changes never rewrite a pinned Run.

Top-level groups: General; Appearance/Accessibility/Keybindings/Composer; Providers/
Models; Agents (main/default subagent/specialists/runtimes/delegation); Tools & Shell;
Context/Repository Intelligence/Memory; Permissions & Safety/Approval Posture; Run
Budgets/Agent Limits; Extensions (Connectors/MCP/Skills/Plugins/Hooks/Workflows);
Notifications; Storage; Performance; Runtime/Supervisor; Privacy & Retention;
Analytics; Updates & Installation; Advanced.

Plugin settings are namespaced and cannot overwrite `security.*`, `guard.*`, `kernel.*`
or `audit.*` unless a signed sealed system provider is the declared owner.

## 7.7 Keymaps, focus, and diagnostics

Retain OpenCode's layered keymap and command architecture. Conflict resolution is
deterministic and reports both action IDs; activation order never decides. Editor,
PTY and IME composition take precedence over global bindings. `Esc` closes the local
overlay before interrupting a Turn; interrupt behavior is explicit and scope-aware.

`doctor` is read-only by default and reports plugin graph, kernel connectivity, event
heads/projection cursor, storage reserve, provider configuration, platform sandbox
capabilities, agent runtimes, MCP health, repository index generation, leaked
workspaces/orphan children, plugin generations and update state. Repair is a separate
registered action, never arbitrary model-generated shell.

## Pinned implementation references

- [OpenCode TUI and command/keymap source](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/tui)
- [TUI package manifest](https://github.com/anomalyco/opencode/blob/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322/packages/tui/package.json)
