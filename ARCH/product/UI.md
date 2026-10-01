---
contract: canonical
owner: CMP-tui
---
# User interface

Terminal-native, `ratatui`-based. One workspace renderer serves both the default view and the focus workspace. This document owns the presentation architecture and LLD for `CMP-tui`. Typed input and draft behavior are defined in [Interactions](INTERACTIONS.md); commands use [Commands and settings](COMMANDS-AND-SETTINGS.md).

## 1. Surface model

- **Interactive workspace — alt-screen.** The full client opens into the selected workspace mode, defaulting to Explorer | Chat | Tasks in an owned terminal screen. The **Prompt Bar** (composer · status · todo) stays fixed and never loses a draft. Completed messages are appended as durable transcript items; rendering is virtualized and does not move the active composer.
- **Minimal/scrollback mode.** `--no-alt-screen` or unsupported terminals use a chat-first scrollback surface; pane commands remain discoverable and open one pane at a time. `F2` / `/focus` enters the owned workspace only when the terminal supports it and the user has not explicitly forced `--no-alt-screen`; otherwise it changes the focused pane within the scrollback surface and never silently re-enables the alternate screen. Preserve the prior scrollback position when returning from an available workspace. `Ctrl-B` is not a default binding because multiplexers commonly reserve it.
- **Invariants.** The center slot stays anchored and displays the selected workspace-mode view; Pair defaults to chat, which remains available as a one-action center tab in every mode. Explorer/file editing stays in the left dock group; Tasks stays a projection of controller truth; zero layout shift on commit; truthful status; composer drafts survive every overlay, resize, and pane move.

## 2. Dockable workspace (`REQ-UI-006`)

Here, “dockable” means the three fixed primary slots of the workspace contract: Explorer/editor and Tasks may exchange the two side slots; the selected
workspace-mode view occupies the anchored center slot, with chat available as a tab. It does not mean that arbitrary panels can be docked or that temporary
surfaces can create more persistent panes. `/panels` selects/restores an eligible
primary pane; temporary views open in the existing center, left document group, or
focused-pane presentation.

### 2.1 Anchors and panels

| Element | Kind | Position / resize behavior | Closable |
|---|---|---|---|
| Chat | Center-slot view (default Pair view; available as a tab in every mode) | Slot stays centered and resizable; its selected view follows the active workspace mode | Always registered; may be deselected, never removed |
| Explorer / editor group | Primary pane (left by default) | Resizable; can swap with Tasks between side slots | Yes (restorable) |
| Tasks | Primary pane (right by default) | Resizable; can swap with Explorer between side slots | Yes (restorable) |
| Prompt Bar | Fixed composer region | No | No |
| Temporary details (diff, changes, timeline, checkpoints, context, agents, LSP) | Central overlay/tab or pane content | No extra persistent zone | Yes |

All three primary regions respond to drag-resize handles. Explorer and Tasks can be
swapped between the two side slots with mouse drag, keyboard move mode, or `/dock`; the
center slot stays anchored. Pair shows chat by default; Mission Control, Review, and
Explore may show their selected projection there while chat remains a one-action tab.
A file, agent, or settings view cannot create another permanent pane. No extra pane is
created merely by moving a side pane. The
Prompt Bar remains fixed. Bottom/overlay surfaces are temporary and never become a
fourth permanent pane.

### 2.2 Workspace modes and default layout

Workspace modes change content within the same three primary slots. Chat remains a one-action center tab; the Prompt Bar remains fixed. `/workspace [pair|mission|review|explore]` and the Workspace selector invoke the same navigation action. Activity history, crash recovery and Proof Pack open within an existing slot or overlay. Mode selection never changes Run state, permission, or approval.

| Mode | Left slot | Center slot | Right slot |
|---|---|---|---|
| Pair | Explorer and document tabs | Chat | Tasks; diff available in detail |
| Mission Control | Workers and workspaces | Outcome/task list, optional DAG | Needs You and task inspector |
| Review | Changed files | Syntax-aware diff and evidence | Findings and verification checklist |
| Explore | Repository tree | Revision-bound symbol relationships | AST/symbol inspector |

Mission Control opens the task/outcome list first. A DAG is an optional view with a text/list alternative. The active mode, draft, chat position and focus survive narrow/short layouts. Background events badge without switching mode or focus.


The default Pair workspace has exactly three regions: **Left = Explorer**, **Center = chat**,
and **Right = Tasks**. Other modes may show their selected projection in the center; chat
remains a one-action tab, and switching views preserves its draft and conversation state. Opening a file never replaces or hides the conversation. Explorer and Tasks can be resized, closed, reopened, and
swapped between side slots. The center slot can be resized, but not repositioned; its
chat tab remains registered and available in every mode. There is no second permanent
editor sidebar and no permanent bottom panel.

Opening a file activates a document tab inside the **left dock group** and expands that
group from its compact Explorer width to a useful editor width. Explorer remains
available as another tab in that group. File tabs retain cursor, scroll, dirty state,
and conflict marker. The editor can be maximized temporarily, then restored without
changing the chat. On narrow terminals, focus/maximize replaces simultaneous columns;
the UI never squeezes content below its readable minimum.

The right Tasks pane is a read-only projection of controller-owned task truth and is
task-first. Each default row shows the requested task title, one concise human-readable
state, and an immediate user-needed action or blocker when present. It does not show
Attempt, Thread, WorkerExecution, adapter, or event IDs as equal-weight task rows.
Selecting a task opens its detail/inspector, where dependencies, attempts, Threads,
worker executions, adapter/model provenance, last event, evidence, and diffs can be
inspected without losing the task as the user's primary unit of work. A check mark
appears only after required verification produced current PASS evidence for that task
and integrated revision. Worker-reported completion, a green process indicator, or a
passing isolated test cannot tick a task. Owner states remain distinct even when the row uses a shorter display label; [State machines](../contracts/STATE-MACHINES.md) defines their vocabulary and permitted transitions. Selecting a task opens its evidence/diff in a
central task detail or left document tab; it never creates another sidebar.

### 2.3 Dock mechanics

- **Mouse drag:** drag either pane divider to resize; drag Explorer or Tasks title bars to swap side slots. The center slot is visibly anchored and cannot be displaced; its selected view follows the active mode. Temporary overlays cannot be dragged into a persistent fourth pane.
- **Keyboard move (required):** in panel focus only, `Ctrl-W` is a prefix and `D` enters side-pane move mode → arrows select the other side slot → `Enter` drops, `Esc` cancels. `Ctrl-W` plus arrows resizes the focused region; `/dock` offers the same controls. No prefix is intercepted while a text field, editor, terminal, or composer owns focus. When the prefix is active, show a visible “Pane: move/resize…” hint; `Esc` cancels and a bounded prefix timeout cancels without performing an action. A timed-out or unsupported chord is never inserted into another control after focus changes.
- **Swap sides:** `Ctrl-W` `S`.
- **Collapse/expand:** `Ctrl-W` `C`; collapsed side panes shrink to an icon strip and remain informative via badges.
- **Side swap:** drag Explorer/Tasks across side slots or use `Ctrl-W` `D`; `Ctrl-W` `Tab` cycles pane focus without changing the center-slot invariant.
- **Close/restore:** `Ctrl-W` `X` closes Explorer or Tasks (the empty side slot collapses); the pane remains in the registry, reachable via `/panels`, and can be restored. The chat tab cannot be removed; selecting another center view only deselects it. Closing never deletes work.
- **Maximize/restore:** `Ctrl-W` `M` or `▣` toggles maximize; covers the workspace, Prompt Bar stays fixed. (A terminal has no floating windows; "float" maps to maximize.)

### 2.4 Panel title bar (top-right controls)

```
┌ Explorer ──────────────────────  −  ▣  ⤢  ⋯  ×  ┐
```

| Button | Action |
|---|---|
| `−` | Collapse / expand |
| `▣` | Maximize / restore |
| `⤢` | Swap Explorer and Tasks between the two side slots; the center slot stays anchored |
| `⋯` | Overflow menu |
| `×` | Close (restorable) |

Narrow title rows collapse to `− × ⋯` (never wrap/truncate ambiguously). Buttons are keyboard reachable and expose the names **Collapse/expand**, **Maximize/restore**, **Swap sides**, **More panel actions**, and **Close panel** to palette, help, and linear screen-reader output. Glyphs fall back to stable ASCII labels on legacy consoles (Windows-first); glyph appearance alone never carries the action name.

### 2.5 Global toggle bar

One compact row: product/workspace identity, primary activity state, and the next required user action, plus pane toggles and an **Actions** entry point. Branch, changed-file count, worker/model, verified-criteria count, elapsed time, and observed cost may use remaining width; fields that do not fit move into the operational inspector and are never silently discarded. This is the same summary row described in §9, not a second persistent header. `Alt-1..3` focus the three default panes; `Ctrl-W` `0` resets layout. `F1` opens the operational inspector with exact lifecycle state, usage/budget/cache facts, approval reason/scope, and audit references. `F2` enters/leaves the owned workspace when available; `F3` opens the command palette; `/commands` and `/help` remain available when function keys are unavailable. These bindings are configurable and focus-aware. At startup, validate collisions and offer a safe fallback plus a palette/help route for every action.

### 2.6 Focus discipline

`Alt-1..3` focus Left/Center/Right. **Nothing auto-navigates**: a tool completing never opens a panel, steals focus, switches an open file, or moves the page; a background pane badges instead of popping. One accent per panel; selection uses semantic theme tokens.

Escape is focus-scoped: it first dismisses an open suggestion list or cancels pane
move/resize mode; it closes a nonblocking overlay and restores its opener focus; it
does not resolve a permission, question, or goal-review card. While an ordinary
direct turn is active and no editor, terminal child, suggestion, or decision card
owns input, `Esc` or `Ctrl-C` requests turn interruption (`REQ-LOOP-011`), shows a
cancellation-pending state, and leaves partial work inspectable. The user can also
invoke **Interrupt turn** from the status row or Actions palette. Do not imply
instantaneous cancellation or rollback.

### 2.7 Direct-turn interaction mode

The Prompt Bar includes a visible mode selector: **Chat/Explore**, **Plan**, or
**Code**, defaulting to Code for a new composer unless the user saved another
preference. A natural-language prompt can be submitted immediately in any selected
mode; mode selection does not create a goal or open Run review. Chat/Explore can read,
search, and explain without workspace mutation. Plan can inspect and propose steps but
does not write workspace files or execute project commands. Code can edit and execute
checks through the normal guard. Switching mode is a user action and is recorded with
the turn. A changed mode may rebuild the permission-filtered tool set and start a new
context epoch; provider cache reuse is route-specific and is not promised across the
switch (`REQ-TOOL-003`).

### 2.8 Action discoverability and composer suggestions

Buttons, the command palette, slash commands, and keyboard shortcuts are entry points
to the same stable typed action and owning controller; they do not implement separate
behavior. The palette/help catalog exposes the action's label, command spelling when
applicable, shortcut when configured, and why it is unavailable. Clicking a status or
header control invokes the same picker/settings action as its command or shortcut.
Bindings remain focus-aware and configurable, with a palette/help route for important
actions even when a key is hidden or unbound.

Composer suggestions for `/` and the documented typed `@` namespaces are inline and do
not take focus away from the draft. Model suggestions are available through `/model`
and the command palette. `#` and `$` have no composer meaning until a typed grammar,
owner, and requirement define one; they remain literal text for now. Command arguments may open a second suggestion stage; command help is
available from that same catalog. While a suggestion list is open, arrows move its
selection, `Tab` or `Enter` inserts the selected item into the draft without
submitting it, and `Esc` dismisses the list and leaves the draft intact. Do not
intercept those keys when the list is closed or an editor/terminal child owns input;
suspend suggestion matching during IME composition. Choosing a suggestion changes
only the draft until the user commits it. Opening another surface, receiving a background completion, or
resizing/moving panes preserves draft, selection context, scroll position, open
document, and focus-return path unless the user explicitly navigates. `@file:` inserts
a reference into the draft; selecting a project file in Explorer separately opens or
activates its document tab in the left dock.

If a prompt-history picker is provided, selecting an entry fills the composer draft;
it never submits that prompt automatically.

## 3. Responsive rules

| Width | Capability |
|---|---|
| ≥ 150 | Three-pane layout; editor expands left dock; full docking |
| 110–149 | Three-pane layout with compact task rows; unified diff only |
| 80–109 | Focus one pane at a time; preserve pane state and navigation |
| < 80 | Chat-first single-column layout; Explorer/Tasks keyboard-opened overlays |

The chat has a protected minimum width and height. Pane moves that violate a minimum are rejected with a clear reason; resizing never silently hides content. Left/right widths are saved as small layout preferences. Resize by divider drag or keyboard resize mode. On small terminals the UI serializes panes rather than rendering unreadable columns. The three-pane layout is a wide-terminal mode, not a requirement to show three narrow, unusable columns: below the measured breakpoint the focused pane takes the work area while the other panes remain one-keystroke reachable and retain their layout state.

Responsive behavior uses both width and usable height after terminal chrome. When
height is constrained, collapse optional metadata and secondary pane chrome first,
then use the focused single-pane layout and scroll within the active view. Keep the
composer input, current run/turn state, and any blocking approval, question, conflict,
or cancellation result reachable; never place the only action below a clipped region.
If even the focused view cannot fit, use a compact presentation with the required
action and a route to its details. Resizing back restores prior pane and scroll state.
Acceptance must cover short-height as well as narrow-width terminals.

## 4. Persistence and extensibility

- **Light layout record only:** pane order, sizes, active tab, maximized pane — ids and geometry, re-derived on load, never durable task truth.
- **Panel registry** is the extensibility point:
  ```
  PanelContract { id, title, icon, min_size, default_zone, linked,
                  render(ctx), on_key(ev) -> Handled|Bubble, badge() }
  ```
  Core panes: `explorer`, `chat`, and `tasks`. The editor is a tab in the Explorer dock group, not a second persistent sidebar. Other surfaces (`changes`, `timeline`, `checkpoints`, `context`, `agents`, `mcp`, `lsp`, settings, and extension management) open in a central modal/tab or task/file detail; they do not silently add another always-visible pane.
- One centered, keyboard-accessible **Extensions** overlay owns Connectors/services,
  MCP servers, skills,
  plugins, hooks, workflows, and marketplace discovery. It has category tabs and the
  applicable Search, Installed, and Create views within the selected category.
  `/extensions` opens the shared surface; `/mcp` (`/mcps`), `/skill` (`/skills`),
  `/plugin` (`/plugins`), `/connectors` (`/apps`), `/hooks`, `/workflows`, and `/marketplace` all open that same
  overlay focused on the corresponding category. `/workflow create` opens its workflow
  authoring view there; `/workflow run|pause|resume|stop` remains a typed Run-controller
  command and does not become a second workflow runtime. Opening or switching categories
  preserves the composer draft, chat position, and pane layout, and has no trust,
  enablement, execution, or permission effect. Category data loads with bounded,
  cancellable work and visible loading, empty, stale, and error states; opening one tab
  does not wait for unrelated remote/catalog requests. Noninteractive command surfaces
  return their typed data/result instead of claiming to open a TUI overlay.
- The default **Installed** view is deliberately simple: each item shows its name,
  type, concise lifecycle state, and the primary applicable Add/Remove/Enable action.
  Provenance, requested scopes/capabilities, probe output, and detailed configuration
  appear in a selected-item detail or the relevant staged review step, not as required
  knowledge on the initial screen. Search, install review, authentication, probing,
  permission review, and enablement remain distinct governed steps in [component contract](DISCOVERY-AND-EXTENSIONS.md).
- **Extension-manager interaction contract ([component contract](DISCOVERY-AND-EXTENSIONS.md) owns install semantics):** Search is a metadata-only view of the selected manager's normalized catalog, which may include official MCP Registry metadata, documented Git marketplace/package formats, Agent Skills packages, and reviewed Connector/service records. For `litepsm` scopes, LitePSM ingests and releases these sources; HorizonCode does not run a parallel crawler or publisher. A Connector result leads with “Connect [service]”; provider/source, version, digest, license, transport, required runtime, auth method, scopes/capabilities, compatibility, freshness, and review limits appear before staging or account authorization. Search results have `Details` and `Install`/`Connect` actions, but discovery never enables execution. Install opens a resumable stepper: pin/version review → selected manager stages in its isolated root → configuration → secret-broker auth (if needed) → protocol initialize and capability probe → per-tool permission review → explicit enable. Every step shows progress and `Cancel`; cancellation cleans only staged data owned by the selected lifecycle manager and preserves pre-existing user configuration. With litePSM, [LitePSM integration](../integrations/LITEPSM.md) owns the staged-operation and cancellation boundary; a lost transport reply is not rollback evidence. `Needs config`, `Needs auth`, `Probe failed`, `Needs review`, `Connected`, `Enabled`, `Disabled`, `Stale`, and `Quarantined` are distinct states. A failure panel names the failed phase, retains safe diagnostics, offers retry/reconfigure/remove-staged-copy, and never silently falls back to another package/version. Installed lists actual configured and enabled state, last health, pinned provenance, and granted tool policy; account Connections remain individually visible with user-friendly account labels. Create validates a local MCP config/skill/plugin/workflow draft and shows the exact files and permissions before writing. Credentials are entered in a protected form and passed by secret reference; they are never pasted into chat or stored in the manifest. Public plugin publishing is outside the extension-manager contract. The official MCP Registry is a metadata source only; catalog records cannot run install scripts, select endpoints/credentials, or grant trust.
- **Doctor (`/doctor`, `REQ-UI-029`):** Show the shared typed report as a bounded list of stable finding IDs, severity, observation, evidence/source status, and any known next action. Keep `unknown`, `unsupported`, `not checked`, unavailable, denied, timeout, and error distinct from healthy. `Details` opens safe diagnostics and the probe-coverage scope. A registered repair offers **Preview fix**, then an authenticated **Apply fix** only after showing the exact current target/change and revalidating it; show the durable outcome and postcondition. No arbitrary command, fix-all, or unattended apply. CLI and TUI are views over the same `CMP-diagnostics` facts.
- **Memory inspector (`/memory`):** [Memory](MEMORY.md) owns admission and retention. Show user/project/profile scopes, ambient/explicit/off mode, search, origin, age and source filters. Explicit saves require no redundant approval; automatic notes are labelled Observed and carry passive Undo. Actions are Inspect, Edit, Forget, Dismiss inferred pattern, Review candidate, Export and Purge scope. Single-record Forget is immediate with a receipt; bulk Purge previews scope/count and asks for destructive confirmation. Show saved/recalled sources without toast spam; no automatic profile sharing. Disabling retrieval is distinct from deletion or disabling capture. Edits use revision CAS and preserve panel selection; unavailable/stale/indexing/audit-pending states remain distinct. Forget does not imply erasing Thread history, exports or backups.

- The `agents` panel is a controller-backed view of registered profiles and the durable root/child Thread tree ([component contract](COMMANDS-AND-SETTINGS.md)). Each worker row separates Task, Attempt, HorizonCode Thread (conversation), and `WorkerExecution` (live process/peer incarnation); show their own IDs and states, adapter/model source, workspace fence, last event/heartbeat, cost/quota provenance, and visible `UNKNOWN` fields. Provide distinct actions to open conversation, inspect attempt/evidence, reconcile/resume execution, and request cancellation. Closing a conversation view or detaching a client MUST NOT stop an execution. Profile discovery, install staging, trust, enablement, model control, child launch, quota facts, and task verification remain separate actions/services; a panel row cannot edit canonical run/task state itself.
- Worker detail has a read-only **Context** view for the pinned `ContextPacket`: packet/epoch digest, selected source classes and memory record refs, freshness, per-source included/excluded reason, byte/token budget, observed provider input usage, and unsupported/unknown adapter fields. It never silently exposes excluded parent/sibling transcript or raw secrets. Profile changes affect future attempts; the displayed packet is immutable evidence of what this worker actually received. The view links to memory inspection only when the viewer has the required scope.
- Explorer → Document are linked within the left dock group: selecting a file opens/activates its editor tab and expands the left pane. The center slot stays anchored; chat remains a tab in that slot. Background file changes never steal focus from a running turn. All three regions resize through draggable splitters; Explorer and Tasks can swap side slots, but the center slot remains anchored. Task truth does not depend on pane position.
- Screen, controller, and view/widget responsibilities remain separate: widgets emit
  typed user intents; controllers resolve the shared action and own asynchronous work;
  widgets do not reach into the agent loop or become owners of durable task/extension
  truth. Async suggestions and scans are cancellable, bounded, coalesced where useful,
  bound to their workspace/query revision, and fenced from publishing stale results.
- Third-party/plugin panels must register through the registry and pass the guard — never a raw hook.

## 5. Explorer and document dock group

- Data source: bounded revision-bound WorkspaceProvider manifest plus access/ignore rules, including authorized untracked files; Git is one adapter. Lazy load and virtualize visible rows; expose stale/unreadable/partial state.
- Live updates: filesystem watcher + incremental tree-sitter parse; workspace indexing never blocks the loop (`REQ-PERF-003`).
- Git status per row: glyph + letter (staged / modified / untracked / conflict); changed-file count badge when collapsed.
- Filter/search with fuzzy matching.

## 6. Document view (viewer · diff · editor)

The editor is hosted in the left dock group alongside the Explorer tree. Per-file tabs
remember mode, cursor, scroll, dirty state, and source revision. Opening or moving
between tabs never changes pane geometry or removes the chat tab. Arrow/button navigation moves among tabs;
selective configurable keys jump to Explorer, next/previous file, and Chat. Bindings
are collision-checked and discoverable through help, settings, and the command palette.

- **View** — syntax highlight (tree-sitter), line-number gutter, soft-wrap allowed.
- **Diff** — unified by default; side-by-side only when the available diff viewport is ≥ 160 columns and both sides remain readable; otherwise unified, with optional maximize; gutter line numbers, add/del background bands, dual line numbers; truecolor → 256 → 16 palettes with ANSI-16 falling back to foreground-only; word-level diff is optional and available only with a bounded supported renderer; unified line diff remains the fallback.
- **Edit** — see §7.

## 7. Native editor bridge and code inspection (`REQ-UI-005`)

Explorer, read-only code view, and diff remain first-class HorizonCode surfaces. Normal
source editing opens the user's preferred editor. Resolve an explicit `editor.command`
profile first, then `$HORIZONCODE_EDITOR`, `$VISUAL`, `$EDITOR`, and finally an
optional configured/detected fallback. Profiles cover VS Code/VSCodium, Cursor, Zed,
JetBrains IDEs, Neovim, Helix, Vim, Emacs, nano, and micro. Other editors work through
a typed argv template with `{path}`, `{line}`, and `{column}` placeholders. Arguments
are passed directly to the executable; never interpolate through `sh -c` or another
shell. Detection is a fallback, not a hard-coded preference ordering.

Each profile declares one lifecycle: `terminal_wait`, `gui_wait` (including supported
editor wait flags such as `--wait`), or `gui_detach`. Do not infer lifecycle from
binary-name substrings. A terminal editor receives the foreground terminal only after
the TUI stops input handling, restores cooked terminal mode, and leaves the alternate
screen. A GUI wait profile leaves the TUI suspended until the editor reports done. A
detached profile returns immediately and installs an **operator-edit lock** for the
target path. The lock fences HorizonCode writes while present; dismissing it is an
explicit user acknowledgment, not evidence that the editor closed. Label it **Editor
may still be open** and offer **Keep locked** or **I have finished editing — recheck
file**. Recheck the current digest and show changed bytes before allowing a HorizonCode
write. HorizonCode cannot observe unsaved buffers or prevent a detached editor from
saving after unlock; show this residual plainly and require a fresh diff/CAS review if
the file changes. Never describe acknowledgment as an OS lock or proof of editor exit.

If an active model/tool turn may touch the target path, opening the editor first
interrupts or pauses that turn and reconciles any in-flight effects. Never release a
write lease while a worker continues. A saved-file watcher refreshes Explorer status,
view, and diff after disk writes; it cannot inspect unsaved editor buffers. Hash/CAS
checks at the actual write boundary remain authoritative.

After a waiting child exits, terminal restoration runs even if spawn/wait failed:
restore raw/alternate-screen modes, query fresh dimensions, invalidate all cached
layout measurements, recalculate virtualized list/gutter offsets, then redraw from
current state. Suspend HorizonCode's input/signal handling while the child owns the
terminal; use platform-specific foreground-process-group/job handling rather than
masking unrelated panic hooks. Windows console lifecycle and POSIX signal semantics
are separate tested profiles.

## 8. Diff views and concurrent edits (user vs agent)

The left dock opens **Turn Diff** by default: current bytes compared with the bounded
pre-turn file snapshot, so prior user edits do not appear as new agent work. **Total
Worktree Diff** separately compares current working-tree and staged state to an
explicit Git baseline; staged and unstaged changes stay distinguishable. Neither view
changes the index. Direct turns and editor saves never auto-stage or commit.

Every agent write uses one governed path: re-read current bytes, compare raw digest to
the authorized base, validate patch, then compare-and-swap atomically where supported.
If the base changed, attempt deterministic three-way hunk reconciliation only against
the exact captured base, current user bytes, and agent patch. Unique non-overlapping
hunks may be relocated and merged; CRLF/LF normalization may assist alignment but raw
digests remain the authorization boundary. Preserve the user's current formatting;
never strip trailing whitespace globally. Overlap or ambiguous context produces a
conflict card with the exact base/current/proposed diff and named non-destructive
actions: **Keep current bytes**, **Review/apply proposed patch**, or **Discard proposed
patch**. Do not preselect a write action. A merge creates a new digest
and patch receipt and requires fresh approval when the prior approval was bound to the
old content. No silent overwrite.

- A saved-file watcher refreshes the view but is not the authority for a write.
- Terminal wait return and detached-editor unlock both trigger a full reread/hash.
- Rewind/checkpoint uses HorizonCode-owned snapshots and never mutates `.git`, the
  user's index, reflog, or commit history.
- A staged quick-patch inspector supports small edits through the same immutable proposal, preview and guarded CAS Apply path in [Interactions](INTERACTIONS.md). A general embedded editor is optional; native editing remains the default. No renderer or editor widget bypasses workspace write authority.

## 9. Long-horizon surfaces (`REQ-HORIZON-*`)

The right Tasks pane is visible by default and shows durable tasks as a compact,
virtualized checklist with an optional DAG view. Optional surfaces such as `timeline` (progress + background jobs),
`checkpoints` (create/rewind), `changes` (changed files and "what changed since you last
looked"), `context` (tokens/%/cost), and agent details open on demand. The Top Bar shows
a compact world summary. Every indicator maps to a real event; waiting states are
visually distinct from working states (`REQ-HORIZON-004`).

Selecting a task exposes **Inspect details/evidence**, **Verify**, and **Create
checkpoint** when supported by its owner. Rewind/restore opens a preview of affected
files, task state, and superseded evidence, then requires explicit confirmation; it
never rewinds external effects or Git state. A task row has no manual “mark passed”
action. Verification shows the exact revision and suite and remains pending until the
controller reports a result.

The shared status row prioritizes the current **run/Thread**, primary state, and next
required user action. It progressively exposes task and assigned worker/model, branch,
verified-criteria count, pending approval, elapsed time, and spend against the selected
budget as width permits; remaining facts are in the inspector. It reports
provider-reported versus estimated/unknown usage and never implies that an external
agent's hidden children or quota are observable. Do not render a second header row
with the same facts.
The target command registry in [Commands and settings](COMMANDS-AND-SETTINGS.md) owns every `/`
command, syntax, argument schema, availability, and safe failure behavior. `/run`,
`/tasks`, `/agents`, `/settings`, `/usage`, and `/context` open controller-backed
views; commands such as `/resume`, `/cancel`, `/verify`, `/checkpoint`, `/mcp`,
`/skills`, `/plugins`, and `/pr` call only their owning services. Completion, help,
and palette search use that same registry. Unknown or malformed commands never fall
through to a model prompt. 

### Run and turn controls

The status row and the selected Run/Task inspector expose the applicable actions
**Pause**, **Resume**, **Cancel run**, **Cancel task**, **Cancel attempt**, and
**Stop now**. During an ordinary direct turn, **Interrupt turn** is also available
and maps to the Thread turn-interrupt path in [component contract](../core/AGENT-LOOP.md); it is distinct from
cancelling a managed Run. Each managed Run action has the same typed behavior as its
corresponding command in [component contract](COMMANDS-AND-SETTINGS.md); all actions use the shared control API rather
than a second control path. Show an
action only when its owner says it is available, and explain disabled/unavailable
reasons. Pause, resume, cancel, stop-now, and interrupt remain reachable from the Actions
palette while generation, tool execution, event replay, or child requests are busy;
their acknowledgement is prompt and their final outcome remains `requested`,
`reconciling`, or terminal as reported by the controller. Cancellation must name the
Run, Task, or Attempt and show blocked dependents; never imply cascade. **Stop now**
is visually separate, names the Run, and explains that committed external effects
cannot be undone. No control is hidden behind a notification or a color-only state.

### Permission decisions

A Guard permission request appears as a durable Needs You entry with a focused decision card (also available in the Pair central chat)
with a route in the status row/inspector. It names the requester, action, exact
resource or command, reason, enforcement tier and residual, proposed scope, expiry,
and why the request is pending. Show only choices currently allowed by Guard:
**Allow once**, **Allow for this bounded session**, **Save project rule** when safe,
or **Reject**. Any saved-rule
choice displays the exact rule and its effect before confirmation. No permission is
preselected. Reject, cancellation, expiry/timeout, and delivery failure remain
distinct outcomes; stale policy, resource, command, principal, or workspace bindings
require a fresh decision. `Esc` dismisses the response overlay without answering and restores the opener focus; Needs You retains the pending permission and its explicit response actions.
Answering this card cannot approve a goal, change policy
outside the shown scope, or imply sandbox enforcement. A question card (§9) and a
goal-start review are visually distinct and cannot be submitted through this card.

### Command output

Tool and command results show a concise bounded summary, exit status, and elapsed
time. **Show full output** opens the complete captured result by its durable artifact
reference in a paged view; it does not replace or enlarge canonical history in memory.
Display truncation, capture failure, unavailable artifacts, and event gaps as typed
states with a recovery/detail action. Coalescing or paging affects only the view; it
never drops durable events or presents a partial result as complete (`REQ-UI-027`).

### Agents and message panel

The Agents view opens in the existing center overlay or selected task detail; it is
not an additional persistent dock. It contains profile and run-tree views plus a
Messages view for the selected Run. Messages show sender, explicit recipients, attempt/task provenance,
timestamp, reply chain, and per-recipient delivery state. Filters include agent,
task, date, unread projection, and pending/failed delivery. The composer requires a
recipient picker and returns a durable post receipt; typing `@agent` is contextual
text only and never sends or wakes a worker. At narrow terminal widths the message
detail replaces the list and preserves a visible back/focus path. Escape, resize,
reconnect, color-disabled output, and screen-reader linear mode retain the same
delivery labels. Terminal control bytes are rendered as escaped text.

Operator posts and agent replies enter through the typed control API. Messages are
untrusted peer content and remain separate from user steering, goal approval,
permission prompts, and task evidence. Active workers receive new content at a safe
turn boundary; paused, terminal, or unsupported peers are not woken. Notification
preferences may mute sound or badges but cannot hide an undeliverable state or
blocking approval. The message contract and crash cases are owned by
[Agent messaging](AGENT-MESSAGING.md).

The read-only Context view is tied to the worker's pinned packet/epoch, not the
current profile settings or a reconstructed prompt. It distinguishes deliberately
omitted, stale, unavailable, and unsupported context from an empty source set. An
operator may edit a future profile's memory policy from Settings, but cannot mutate a
running worker's packet in place; steering creates a new durable input and only a
new context epoch can change the context baseline.

### Agent questions and selectable answers

Questions appear as durable Needs You entries and accessible response cards (also in the Pair central chat), distinct from permission
prompts or pane-replacement overlays. The card identifies the asking agent and its
Task/Attempt/Thread, shows each prompt and selectable option, and clearly marks
single-choice, multi-choice, and free-text/“other” behavior. Selection is keyboard
first with visible focus; mouse and accessible linear rendering are supported where
the terminal backend permits them. Validate required fields and selection counts
before enabling Submit. Preserve the chat composer draft, current focus return path,
pane sizes, and side-pane contents while the request is pending.

The card displays `waiting`, `answer saved`, `delivering`, `answered`, `cancelled`,
`expired`, or `delivery unknown` from durable owner events, not animation. After
submit, show the answer receipt and whether it was delivered to the original call;
reconnect reads the same receipt instead of prompting twice. A question can wait
while the client disconnects, but its worker pauses only at the requesting tool
boundary. Headless mode renders the same structured prompt/IDs and returns
`NEEDS_INPUT`; it must not select the first option or infer an answer.

### Session and message search

`Ctrl+F` while the transcript owns focus searches the current conversation; `Ctrl+Shift+F`
and `/search [query]` open global Thread/message search. Search is local and never
sends transcript text to a provider. The overlay provides a query field, current
Thread/project scope, active/archive toggle, role filter, and date interval. Date
picker boundaries use the configured display timezone and are converted to UTC. Plain
terms require whole-token matches; double quotes request an ordered phrase. The UI
must explain that phrase matching follows Unicode tokenization and ignores punctuation
between tokens; it does not imply byte-exact substring matching, fuzzy matching, or
semantic search.

Each result shows the current Thread title, project/workspace, timestamp in the
display timezone, speaker, escaped text excerpt, and—when applicable—the old title
alias that matched. Keyboard arrows move results; Enter opens the exact message; the
transcript loads its history window, scrolls to the immutable message ID and highlights
the match. If the message is stale, no longer readable, or its session is corrupt, the
UI shows a typed status instead of jumping to a nearby row. The current session title
is always displayed after a rename; message hits are keyed by immutable Thread/message
IDs, so renaming does not orphan them.

The rendered transcript is a bounded view and is not the search corpus. Search covers
the full authorized, retained, committed history through the [component contract](../core/SESSION-AND-THREADS.md) index, including
messages outside the currently loaded transcript page. Navigating to an older hit
loads the exact history window by durable sequence/message identity before highlighting
it; if the target cannot be revalidated, show the typed unavailable state. A loaded viewport is never presented as the full-history search corpus.

Coverage is part of the result, not an invisible implementation detail. Show
`complete`, `indexing`, `partial`, or `failed`, with a count/list of Threads behind or
unreadable. A partial zero-hit page must never say “no matches”; offer retry or
`/search rebuild` as appropriate. Rapid edits cancel the previous bounded query and
tag responses with a query generation so stale results cannot replace newer ones.
Search focus, resizing, navigation, empty results, offline use, and escape preserve
the current composer draft. Highlighting uses semantic theme tokens and a non-color
marker; under `NO_COLOR`, high-contrast, reduced-motion, and screen-reader modes, the
same match and coverage information remains navigable and distinguishable.

The search preference view at `/settings search` shows whether content indexing is
enabled, whether tool output is included, whether a worker may retrieve older visible
history after compaction (off by default), archived-session coverage, the current
index generation, and any stale/rebuild state. Disabling indexing also disables
model-facing retrieval and can purge the
derived projection while retaining canonical history. Project configuration cannot
turn indexing back on after a user disables it. Search results apply the same
Thread-read authorization and safe text rendering as history; snippets are never
trusted as instructions or rendered as terminal control sequences.

### Goal draft, preparation, and start review

`/goal set` renders a draft receipt containing the exact user request, selected
workspace, and observed base commit; it does not fabricate acceptance criteria or
silently invoke a planner. `/goal prepare <run-id>` first presents the selected
planner route, read-only repository scope, finite planning cost/time/token budget, and
the fact that it cannot edit files or launch coding peers. After that bounded planning
attempt, the `Goal Review` view shows original request, confirmed requirements,
assumptions/exclusions and open questions, spec/task-graph/plan digests, workspace
base, effective policy snapshot/digest, selected provider/model/agent and capability snapshot, proposed permissions,
total/task/verification/recovery budgets, and expected checks. It provides accessible
`Start`, `Revise`, and `Cancel` actions. Opening the review creates a durable,
expiring challenge bound to this authenticated control session and connection; show
its short challenge ID and expiry with the review digest. Start is disabled while
blocking questions remain or any displayed digest is stale; the user must reopen
review after a route, policy, workspace, spec, graph, plan, or budget change. A newer
review replaces and invalidates an older pending challenge, so two open tabs cannot
confirm different plans for the same goal.

The approval prompt is a durable blocking item, not a notification preference. The
review bundle includes maximum Task attempts and worker executions per Attempt so
process recovery cannot silently expand the relaunch allowance. Start requires an
explicit confirmation bound to every digest in the displayed review
bundle through the same authenticated operator control session that opened the
challenge. Model, tool, peer, plugin,
and recovery principals cannot submit or synthesize this confirmation; command text
and CLI flags alone never grant operator authority. The controller records a
confirmation first, then reserves execution plus mandatory verification/recovery
resources with idempotency keys and commits activation only when reservations are
durable. A durable outbox dispatches from that activation event. A crash or uncertain
launch is reconciled by the same event/attempt IDs; it never opens a duplicate attempt.
Denial, timeout or client disconnect before the response is durably accepted,
a stale response, or a failed reservation leaves work undispatched,
expires/invalidates the challenge as appropriate, and
retains the exact reason in the timeline. Escape dismisses review without dispatch and leaves its unresolved review item visible until its challenge expires or is explicitly changed. Keyboard, mouse, and screen-reader actions reach the same
typed control service; the rendered confirmation names the affected run and cannot
use color alone to convey consequences. Existing settings can change presentation
colors and alert sound, but cannot hide, approve, or alter this gate. `/goal clear`
clears only a safe session selection pointer as defined in [component contract](../execution/LONG-HORIZON.md).

For ACP approval, the review surface also identifies the configured connector and
its authentication/trust status, and makes clear that the connector—not ACP
wire-format proof—must present the exact bundle and capture the choice. If the
connector has no authenticated operator scope or is not allowlisted as trusted, the
ACP confirmation action is disabled and the user is directed to the trusted local
TUI/CLI control surface. The actor, control session, approval method, and verified
identity (when available) remain visible in the durable timeline. Notification,
sound, and palette settings cannot promote an untrusted connector or disguise the
approval source.

Composer references use `@agent:<id>`, `@file:<path>`, `@task:<id>`, `@run:<id>`,
`@symbol:<name>`, and `@skill:<id>` as documented in [component contract](COMMANDS-AND-SETTINGS.md). A mention supplies a
typed reference or routing intent but never launches a peer, executes a tool, reads a
secret file, or grants authority by itself. An explicit dispatch action creates a
canonical `Attempt` with a pinned worker/profile binding under the controller after
budget, policy, and workspace checks.

The queue view shows input receipts, lane,
sequence, age, current owner, retry/cancel state, and whether an input was promoted,
rejected, or remains pending. A worker heartbeat is labeled liveness only.
Changing model or compaction settings records a new context epoch; it does not alter a
prior cost or verification record (`REQ-UI-010..011`, [component contract](../execution/LONG-HORIZON.md)).

Provider output is shown as a distinct attempt stream. A complete validated response
becomes the assistant message; truncated/failed bytes stay under an expandable
“incomplete attempt” row with the finish cause, provider/model, token/cost provenance,
retry count, and whether tools were dispatched. If the controller recovers, label the
first fragment superseded and present one final answer, never concatenate partial and
retried text as though the model produced one continuous valid answer. Unknown or
explicit output caps offer bounded next actions and leave the run/task incomplete;
they do not appear as a green completion or trigger a muted background retry. Cancel
remains available while compaction/retry is being admitted.

## 10. Provider registry and application update surfaces

### Provider and sign-in experience

`/providers` and the model picker draw from `CMP-provider`'s one registry and show
the three states separately: catalog entry, configured auth, and conformance-tested
route. The complete provider inventory is searchable and filterable by provider,
auth method, protocol, availability, locality, and verified capabilities. Rows show
plain-text provider name, metadata source/freshness, auth state, model capability
evidence, cost/quota basis, and the exact blocker when not usable. A catalog entry
cannot look selectable merely because its name appears.

`/connect <provider>` opens only auth methods the adapter implements and the provider
currently documents. The flow names the provider, account, requested scopes,
callback/device destination, expiry, and credential-storage outcome before approval.
Browser/device flows use high-entropy state and PKCE where supported, validate
redirect/state/issuer, use HorizonCode's own client registration, and return secrets
directly to `CMP-secrets`; credentials do not enter transcript, clipboard history,
logs, or audit payload. Methods requiring a missing OAuth registration appear as
`Needs registration`; unsupported or policy-unavailable options remain visible.
Never offer another application's stored login.

Catalog refresh is background work with a visible `Updated`, `Stale`, or `Unavailable`
marker and timestamp. Active runs show their pinned model, route, adapter version, and
metadata digest; new metadata never silently changes them. “Free” or subscription
labels carry source/freshness and do not imply unlimited quota. Unknown quota is
shown as `Unknown`, not zero. `/settings providers` exposes the approved OpenCode
metadata refresh toggle/interval and cache state; generic catalog sources remain
separately opt-in. A refresh control cannot create or approve a credential.

### Application update notice

When a signed update is available, startup shows a non-modal notice with current and
target version, channel, release-note summary, target size, signature status, and
`Install`, `Later`, and `Details` actions. `Details` opens a review panel before the
operator chooses. One explicit `Install` action authorizes download, verification,
staging, and application at the next safe boundary; there is no second surprise
confirmation after the download. If work is active, the UI explains that the verified
target will wait until all runs are terminal and the application reaches a normal safe
restart; no run will be stopped, and the prior Install choice remains the consent to
apply. The operator may cancel a staged update before activation. A separate approval
is required only for a maintenance action that pauses still-active work.
The notice never claims “up to date” when a network check failed or cached metadata
expired.

`/upgrade` and `hzcode upgrade` invoke the same `CMP-update` state machine. The
CLI reports the source/check result, shows release notes and target identity, requests
interactive operator confirmation, and allows deferral. Headless mode returns
structured `available`, `current`, `unavailable`, `staged`, or
`operator_action_required` status without installing. Package-manager-owned installs
show the manager action and cannot be overwritten by the self-updater.
`/settings updates` exposes check-on-start, notifications, channel, last check/cache
expiry, install method, and pending/deferred state. Users may disable checks,
notifications, or sound; they cannot override signature failures or make
installation automatic.

Update notices obey the semantic palette, `NO_COLOR`, reduced-motion, bell,
quiet-hours, and screen-reader settings. They use text/glyph labels, not color or
sound alone. Muting does not suppress explicit `/upgrade`, CLI results, or a security
refusal. Checks run off the render/control path and cannot delay user input,
permission replies, cancellation, or session startup.

## 11. Theming and accessibility

- Semantic token set; user-selectable accent with a **cool-blue default**. Selection uses the chosen accent only if it remains distinguishable from reserved warning/error/status hues; state meanings use separate semantic tokens and text/glyphs (`REQ-UI-007..008`).
- Colour level detection (truecolor → 256 → 16); `NO_COLOR`, `TERM=dumb`, reduced-motion honored.
- No meaning is colour-only: every colour carries a glyph/letter (`REQ-UI-008`).
- Every action is keyboard reachable; focus is always visible; resize has an explicit mode. Linear screen-reader rendering is a supported presentation, not a best-effort afterthought.
- Keymaps are scoped by focus/context and user-editable. Invalid or colliding changes are rejected with both conflicting actions named. Defaults can be restored through `/settings` or the palette. No essential action depends on colour, mouse, or one shortcut.
- Telemetry uses tabular numerals.

In linear screen-reader mode, expose the same controls with stable spoken names and
their current state (`selected`, `expanded`, `disabled`, pending, or unavailable);
never announce a glyph as the only label. Reading and focus order follows the visual
hierarchy: global status/actions, active primary pane, other pane navigation, then the
composer, with a clear return point after a temporary surface closes. Blocking
approval and question cards keep their response controls reachable without trapping
the operator away from priority Run controls. Announce state changes without moving
focus; coalesce routine progress and announce blocking requests, control results,
errors, and connection gaps. Keyboard and screen-reader paths must reach every mouse
action, including resize, swap, editor open, output expansion, and repair preview.

Themes are semantic token palettes with user-editable foreground, background,
selection, border, accent, and decorative tokens; the settings preview shows working,
waiting, denied, failed, approval-pending, budget-stopped, and verified states before
saving. Palette validation checks contrast and keeps selection distinct from reserved
status meanings across truecolor/256/16-colour modes. `NO_COLOR`, `TERM=dumb`, and
reduced-motion settings override decorative choices. `/settings theme` exposes these
values; it shows the effective palette after environment and policy overrides. Every
setting view shows the
effective value, source scope, apply boundary, validation error, and policy lock.
Colour never replaces a text label or glyph for an outcome.

Notification preferences live at `/settings notifications`: per-event in-client
badges, optional terminal bell, optional desktop notification where supported,
quiet-hours batching for non-critical events, and rate limits. Sound can be disabled.
Muted events stay in the durable timeline; a blocking approval or stop state remains
visible on attach even if all external channels are muted. Notification failure never
holds or authorizes a run.

Per-profile primary/worker selection and resource controls live at `/settings agents`
and the Agents panel. The panel shows model identity only when observed/configured by
an adapter, and displays unknown peer usage and hidden nested workers explicitly.
Model, workspace, permission scope, cost source, and quota source are independent
fields. Exact lifecycle and caps are specified in [component contract](COMMANDS-AND-SETTINGS.md).

Session artifacts that are unavailable, corrupt, unsupported, over limit, or refused
by the active model route render as an accessible metadata placeholder: type, bounded
size, digest prefix, verification state and typed reason. The UI never shows raw
base64, an empty image tile, or an executable active-content preview. A placeholder
does not claim the original media was understood, and dependent verification stays
blocked. `/settings session storage` shows encoded/decoded ceilings, current and
reserved bytes, retention, cleanup candidates and the effective filesystem durability
mode; cleanup preview lists owners and refuses deletion if a reference scan is
incomplete. Notifications may be muted, but truncation, unavailable artifacts,
budget stops, and required approvals remain in the durable timeline.

The expanded operational inspector shows current/reserved **event-log bytes separately from
artifact bytes**, segment count, last committed sequence/revision, and whether the
physical emergency reserve is allocated, consumed, or needs replenishment. Approaching
a limit warns before dispatch; a hard storage fence stops new work while preserving the
cancel/reconcile/handoff reserve. Render `storage-pressure`, `reconciling-tail`, and
`event-log-corrupt` with a plain-language reason and last verified event; never use a
spinner or green completion mark for these states. Session/history reads and listing
are visibly read-only; if recovery is needed, offer a distinct recovery action and
show that the original bytes are retained. The UI never silently “repairs” by
truncating the log.

The session picker also preserves uncertainty: unreadable, corrupt, unsupported, or
recovery-pending sessions stay visible with a typed status. If directory/index
enumeration is incomplete, show that the list may be incomplete instead of showing
“no sessions.” Opening a status row does not mutate the session; recovery is an
explicit action with an inspectable outcome.

## 12. Progressive status and operational inspector

The persistent badge uses four primary human-readable states: **Thinking** (context
assembly/model stream), **Working** (tool/process/check execution), **Waiting for
you** (permission, question, conflict, or explicit review), and **Idle**, with an explicit outcome label when work ends. The
badge is a summary only. It never merges canonical outcomes or erases blockers.
Selecting it or pressing `F1` opens the inspector, where the exact lifecycle state,
owner/target, elapsed time, tool, retry reason, spend/usage certainty, approval scope,
and recovery action remain available. For example, failed, interrupted, blocked,
unknown, passed, and not verified are distinct labels in detail. No green success
indicator appears without the owner’s required evidence.

### Status projection vocabulary

The display projects **separate** run, task, turn, attempt and external-peer states ([component contract](../execution/LONG-HORIZON.md)) into: idle · draft · preparing(plan-only) · awaiting-clarification · ready-for-review · awaiting-start-confirmation · starting/reconciling · cancelling-start(reservation release) · cancelling(target) · reconciling(target/effect) · queued · thinking · working(tool) · awaiting-approval · retrying(reason + attempt) · truncated-incomplete · artifact-unavailable · interrupted · verified-complete · stopped(reason) · error(expandable) · background. A turn's `completed` cannot render as run completion, accepted approval cannot render as active work until `GoalActivated` is committed, and cancellation is not terminal while an external process/effect is unknown. Show the exact target kind/ID and any blocked dependents; do not imply descendant cancellation. Spinners mean a real operation is in flight and stop on completion; retries show reason and attempt; heartbeat indicates liveness only, never progress.

For attached clients, show control-channel state separately from worker/run state:
`Connected`, `Reconnecting`, `Recovering`, `Last seen`, `Attach unavailable`, and
`Resnapshot required`. A disconnected or stale client must not animate a worker as
currently active or enable controls against an unreconciled snapshot. Resume actions
must first apply canonical snapshot/replay from [component contract](../integrations/CONTROL-API.md); missing ephemeral deltas
may be summarized as a gap, but missing durable events require resnapshot. These labels
remain visible with muted notifications and monochrome output.


## 13. Needs You, evidence and recovery

Needs You is a persistent projection of open permission, question, clarification, integration, quota and goal-review requests. Each row leads with why the user is needed, affected work and the next action. Owner/source, urgency, expiry and stale state remain inspectable. Sorting, mute, dismiss and mode switching never resolve the owner record. Priority order uses owner-derived urgency and blast radius, with a visible explanation; color alone never defines priority. Duplicate unresolved requests may be grouped only when their owner identity and scope match; grouping never broadens approval.

Task detail offers Open Proof Pack when evidence exists and Evidence status otherwise. The read-only inspector shows verdict, exact integrated revision, command/environment, bounded logs/reports, limitations and artifact digests. A Task has no manual PASS checkbox. Rich artifact viewing uses [Artifacts](ARTIFACTS.md); preview success is independent from verification.

Crash recovery shows workspace identities, recovered draft revisions, execution reconciliation and unknown effects. It offers only owner-supported recovery actions; opening history stays read-only. Close/detach never means cancel.

## 14. Artifact presentation

The searchable artifact picker provides Preview, Attach, Open, Copy reference and Export. Enter previews; Attach is explicit. Filter by Thread, Run, Task, type and date. Loading, incomplete index, empty, offline, missing, corrupt, denied, unsupported and over-limit results remain distinguishable. Escape returns focus and scroll. Version history and feedback refer to the exact immutable object. Export and browser opening are independently guarded actions; generation never publishes or opens a browser automatically.

Text, reports, syntax, diagrams and images render only through registered bounded capabilities. Otherwise show type, size, digest prefix, availability and a meaningful reason. Never show base64, blank image tiles or pretend missing media was understood. Active HTML/SVG/scripts do not execute inside the terminal renderer. Interactive browser artifacts require proved isolation and separate authority as specified by the artifact owner.

## 15. Settings, motion and streaming

The native settings surface provides Appearance, Composer, Models, Context, Agents, Extensions, Permissions, Notifications, Storage, Performance and Installation categories. Search uses labels and effective keys. Every control shows requested/effective value, source/scope, policy lock, validation and apply boundary. Preview is ephemeral; Apply uses config CAS and atomic persistence; Cancel restores the actual persisted state. External changes produce Compare/Rebase rather than overwrite. Restore defaults and Show source are available. Secrets use protected broker forms. See [Config](../core/CONFIG.md) and [Commands and settings](COMMANDS-AND-SETTINGS.md).

Semantic palettes cover background, surface, text, muted, border, focus, selection, accent, success, warning, error, diff-added, diff-removed and syntax. Ship dark, light and high-contrast palettes with system inheritance and bounded inert custom-theme data. Preview all work/wait/error/approval/verification states, diff and code. Reject cycles and terminal escapes. Unknown terminal background means contrast is unverified; offer controlled high contrast. ANSI indices alone do not establish measured contrast.

Motion defaults to subtle; reduced/off presents final states immediately. Selection and overlay feedback are short, interruptible transitions governed by [Performance](../contracts/PERFORMANCE.md). Input remains live; reversed actions cancel earlier transitions. Never delay cancel, approval or expiry, and never infer completion from motion. Hidden, idle, detached and replay surfaces have no animation timers. Resume/history replay does not replay arrivals. Unsupported terminal effects fall back to immediate redraw.

Streaming is an attempt-specific projection with monotonic sequence/channel/terminal markers. Coalesce repaint deltas only; retain canonical events and receipts. Paint dirty visible ranges, using bounded caches; parse/highlight/decode off the input dispatcher. Incomplete fences render selectable plain text. Preserve user selection and scroll. Follow tail only when enabled and already at the bottom; show Jump to latest and New output count otherwise. Late/cancelled-attempt fragments never join a replacement response. Gaps require snapshot recovery and visible stale state.

Stop/Interrupt and Undo/Restore have distinct action identities and stable positions. Completion cannot turn an in-flight pointer click on Stop into Undo. Review navigation cannot acquire a destructive meaning between clicks. No background operation moves controls, grabs focus or displaces selected content.

## 16. Resource bounds and acceptance

Transcript, tree, task, search, output, catalog and artifact views are paged and virtualized. The TUI does not copy full durable history into memory. Every cache has an owner, cap, invalidation generation and eviction rule. Required policy validation precedes dispatch; optional discovery and indexing do not block unrelated interaction. Scheduling is owned by [Scheduling](../execution/SCHEDULING.md); context selection by [Context](../core/CONTEXT.md); all numerical latency/render/memory targets and fixtures by [Performance](../contracts/PERFORMANCE.md).

Acceptance covers every mouse action through keyboard and accessible linear output; width and short-height breakpoints; preserved draft/focus/selection through resize and mode changes; matching action identities across palette/command/button; exact approval scope; unanswered Escape; no Stop-to-Undo swap; full retained output versus capture limits; complete/partial search; external editor return on failure; CAS conflict; conditional media fallback; blocked child attention; proof freshness; disconnected snapshots; reduced motion; idle/replay wakeups; and input/cancel responsiveness under background output. [Acceptance matrix](../acceptance/ACCEPTANCE-MATRIX.md) owns cases and evidence gates.
