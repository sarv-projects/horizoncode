# 26 — Universal UX, flows, commands and acceptance matrix
## 26.1 A single adaptable canvas (reference image)
```text
┌ Project / Workspace ───────────────────────────────────────────────────┐
│ Explorer (left)      │ Active Work (center)    │ Inspect (right)        │
│ Project tree         │ Goal + stage progress   │ Changes / Diff         │
│ Files, branches      │ Chat + agent timeline   │ Terminal / Processes   │
│ Tasks, agent roster  │ Editor or live preview  │ Tests / Evidence       │
│ Worktree/ports       │ Approval + decisions    │ Browser / Resources    │
├─────────────────────────────────────────────────────────────────────────┤
│ Agent ▼  Model ▼ (depends on agent)  Harness ▼  Mode ▼  Permissions ▼   │
│ [ Describe change ... @ references / commands + attachments ]  Send  │
└─────────────────────────────────────────────────────────────────────────┘
```
Panels are resizable/collapsible. Mode is task working style (Ask, Plan, Edit, Delegate, Review); permission policy is distinct (Ask, Safe Auto, YOLO in Sandbox). User can change Create/Develop/Delegate/Operate perspective without rebuilding state or losing editor context.

## 26.2 Control semantics
- **Agent picker** selects configured agent profile. The model picker is filtered by selected agent + connected providers, but remains editable where profile policy allows.
- **Model** explicitly pinned by provider ID/model ID/harness/credential reference. Default display: Local / Free / Subscription / Paid API. Never assume $0 if usage metadata is unavailable.
- **Permission chip** records actual sandbox backend and granted scope. Badges show if YOLO is restricted or unavailable on the OS; no fake sandbox claims.
- **Progress pane** shows each criterion (unstarted/running/verified/failed/inconclusive), current file/effect/worker, user decision required, and why the agent stopped.
- **Inspector** shows structured logs, redacted arguments, annotated diffs, screenshots, targeted tests, evidence hashes and worker resource allocations.
- **Empty state** lets user start blank from template, open Git repo, import folder, resume Session, or inspect existing app.

## 26.3 Typed slash commands
| Command | Arguments | Owner | Gate / behavior |
|---|---|---|---|
| `/goal` | get|set|pause|resume|clear | `GoalService` | user-revision; no agent-only success |
| `/model` | list|select|info | `PinnedModelService` | user-only paid route switch |
| `/harness` | list|select | `HarnessRegistry` | same provider/model; warn capability |
| `/agent` | select|info | `AgentProfileService` | capability checked |
| `/agents` | list|create|edit|clone|delete | `AgentProfileService` | settings versioned |
| `/permissions` | ask|safe-auto|yolo|status | `PolicyService` | sandbox guarantee before yolo |
| `/parallel` | on|off|limit|status | `SchedulerService` | DAG plus resource checks |
| `/worktrees` | list|pool|gc|quarantine | `WorktreePool` | dry-run cleanup default |
| `/heal` | status|case|replay|disable | `RecoveryEngine` | never change policy automatically |
| `/skills` | list|load|inspect | `SkillRegistry` | approved permission loadout |
| `/mcp` | servers|tools|connect|disable | `McpBridge` | mediated through tool broker |
| `/hooks` | list|enable|disable | `HookRegistry` | hook effects always brokered |
| `/budget` | show|limit | `BudgetService` | no hidden spending |
| `/usage` | current|session|run | `UsageLedger` | measured vs unknown |
| `/context` | inspect|sources | `ContextService` | show provenance and limits |
| `/compact` | now|status | `ContextService` | goal immutable; snapshot first |
| `/sessions` | list|search | `OpenCodeSessionGateway` | provider Session canon |
| `/resume` | run-id|session-id | `RunCoordinator` | effect reconcile first |
| `/pause` | run-id | `RunCoordinator` | safe stop and fence |
| `/cancel` | run-id | `RunCoordinator` | revoke then settle |
| `/diff` | target | `WorkspaceService` | read or selected diff |
| `/review` | target | `ReviewService` | no auto-edit by default |
| `/test` | suite|target | `VerificationService` | isolate test resources |
| `/preview` | start|stop|open | `PreviewService` | reserve ports and isolated DB |
| `/publish` | plan|prepare|approve|execute|verify | `ReleaseService` | prod explicit approval |
| `/export` | source|app|evidence | `ExportService` | manifest of nonportable services |
| `/undo` | effect-id | `PatchService` | CAS rollback; preserve newer edits |
| `/branch` | status|create|switch | `GitService` | protect user dirty work |
| `/commit` | selected-files | `GitService` | never implicit git add all |
| `/explain` | entity-id | `UxStatusProjection` | plain/technical toggle |
| `/help` | query | `ActionRegistry` | discoverable typed actions |

The app, TUI and CLI share one `ActionDescriptor {id,argsSchema,availability,permission,executor,telemetry,shortcut,undoCapability}`; a slash command must never be interpreted as privilege-bearing free text. Alias conflicts with upstream OpenCode commands require versioned registry adaptation and tests.

## 26.4 End-to-end user journeys
### Journey A — nondeveloper creates and publishes application
1. User describes product; intake lists missing decisions without requiring coding vocabulary.
2. Identify trusted framework/template, create full source repo, explain known ongoing external costs clearly.
3. Preview in isolated environment; show live screenshot and accessibility tree.
4. User clicks UI element; DOM/source anchor fingerprint maps to source. Ambiguous target -> show candidates, never blind patch.
5. Patch staged with snapshots; run checks; user sees before/after. Can undo exact effect.
6. Publish plan details target, possible costs, data/backups/migrations, permission and rollback limitations.
7. High-impact approval; perform deployment; probe deployed URL/version and relevant user journeys.
8. Export ownership bundle including source, deployment manifests, migration notes and dependency caveats.

### Journey B — developer fixes mature repo bug
Import without overwriting uncommitted changes -> scan manifests & symbols -> select agent/model -> ask/plan/edit workflow -> bounded source patch -> tests + regression + diff -> evidence-backed final summary. No agent-invented requirement expansion.

### Journey C — managed long-horizon goal and compaction
/goal set -> approved objective/criteria -> Run DAG -> OpenCode Session per execution -> checkpoint -> context compaction preserving immutable criterion refs -> resume active task, not already verified earlier task -> integrated verification -> finish or disclose blocker.

### Journey D — 3 parallel agents share project
Scheduler calculates independent write sets and test/service conflicts; allocates clean worktrees + unique ports and ephemeral DBs; children run isolated; merge each branch into integration staging; run combined tests; quarantine failed/dirty resources; release clean resources to warm pool. Active pool limit is enforced.

### Journey E — free/local model with poor tool calling
Explicit local endpoint selection -> capability probe -> compatible harness selected manually -> structured tool-call validation/retry capped -> UI shows limitations and local/privacy guarantees conditional on integrations. Rate limit or incomplete output never silently switches to paid endpoint.

### Journey F — crash during tool call
OwnerLog has ToolEffectStarted -> old process fence revoked -> query observed filesystem/remote effect receipt -> classify applied, not-applied or uncertain -> safe retry or NeedsYou; no duplicate deployment/test data corruption.

### Journey G — model provider outage
Endpoint breaker opens after qualifying failures -> same-model bounded backoff if safe -> UI shows paused state and explicit controls to retry/change model. Config cost counters cannot treat missing token counts as zero.

### Journey H — user cancels during file edits
No new tool admission; sandbox cancel delivered and fenced; applied edits remain reviewable/undoable; stale workers cannot overwrite newer user changes. Worktree pool returns clean only after settling child processes/ports/test DB.

### Journey I — visual plus code mixed
Beginner user edits visual layout; later developer edits source in IDE; both share one git history, source reference, evidence and project. No proprietary duplicate visual representation; unsupported source anchors fall back to code review.

### Journey J — operate existing deployed software
Incident intake -> safe read-only diagnosis -> reproduce on staging/test data -> propose fix -> acceptance tests -> release approval -> deployment verification -> incident closure with evidence.

## 26.5 Adversarial test gates
| Gate | Injected fault | Pass condition |
|---|---|---|
| Session parity | OpenCode V1/V2 state persisted then kernel restart | exact message/part/usage replay; no duplicate promotion |
| Model pin | 429 and 5xx | no different model or paid route invoked automatically |
| Small model | broken tool-call JSON | bounded repair or clear model limitation, never fabricated result |
| Tool broker | plugin attempts direct shell outside root | action denied by actual OS boundary |
| YOLO | compromised tool asks production secret | deny/prompt even if sandbox-safe local actions allowed |
| Worktree reuse | dirty old workspace | quarantine, preserve user changes; never reassign |
| Resource isolation | 2 workers use same dev server/test DB | unique resources and no cross-worker test pollution |
| Stale worker | old fence returns after resume | stale effect rejected, no overwrite |
| Stop rules | agent says 'done' but tests fail | run not terminal success |
| Context compaction | goal constraint older than 4 compactions | goal and acceptance criteria retained |
| Learned healer | spurious error pattern suggests dangerous patch | sandbox validation or reject, no policy mutation |
| Diff review | user edits file while patch stages | stale revision warning, preserve user edit |
| Builder handoff | visual app exported to engineer | all source readable and runtime dependencies declared |
| Storage pressure | large logs/preview/worktree caches | bounded retention, preserve required undo/evidence |
| UI novice | permission denied or deployment blocked | explanatory status plus technical details, no false success |

## 26.6 Practical release definition
A release requires verified single-agent coding, local/free model mode, stable selected model, no unsafe permission bypass, deterministic cancellation/resume, exact proof-backed completion, worktree cleanup, and a functional nondeveloper Create workflow. Advanced parallel deployment/remote scheduling is gated separately and cannot be advertised until tested.
