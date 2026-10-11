# UNIVERSAL UI COMMANDS MEMORY — canonical v2 integration

> **Current repository binding (2026-10-10):** Use the three-pane Explorer/Task/Inspect reference image as baseline with context-sensitive Create/Develop/Delegate/Operate surfaces. Agent and model selectors are separate, model choices pinned by explicit user selection.

## Imported v2 architectural basis

# 12 — UI, tools, slash commands, rules, hooks, memory, local models

## 12.1 Preserve the uploaded image's compact three-column workspace

The uploaded screenshot displays a bordered `Project / Workspace` region, left Explorer, central Active Task card with progress/checkbox rows, right Inspect list and a full-width bottom composer. **Keep this as the base**, with proportional flexible/resizable panes, not three independent screens or a dashboard full of status cards.

```
┌──────────────────────────────────────────────────────────────────────────────────────────┐
│ Project ▾   [Create] [Develop] [Delegate] [Operate]   Current branch    Model   Mode  ⚙ │
├───────────────────┬────────────────────────────────────────────┬─────────────────────────┤
│ Explorer          │ Task / Editor / Live Preview               │ Inspect                 │
│ Files             │ Active goal and compact progress           │ Changes  Tests          │
│ Branches          │ Task tabs, diff, preview or visual canvas  │ Terminal  Evidence      │
│ Tasks             │ Contextual on-demand advanced panels      │ Browser  Agents  Logs   │
│ Agents            │                                            │ Cost  Resources         │
├───────────────────┴────────────────────────────────────────────┴─────────────────────────┤
│ [@attach] [/]  Ask, steer, or delegate...      [Pinned model] [Permission mode] [Run →]     │
└──────────────────────────────────────────────────────────────────────────────────────────┘
```

**Presentation contracts:** (a) no duplicate navigator for beginners, (b) left pane collapses to icon rail, (c) central content defaults to goal for Delegate, visual preview for Create, editor for Develop, dashboard for Operate, (d) right inspect is a tabbed detail surface, not a fixed list of inert links, (e) compose stays persistent and lets user attach `@file`, `@symbol`, `@diff`, `@screenshot`, `@test`, `@element`, `@run`, `@url`, (f) right inspect shows exact verification evidence and cost/unknown usage, (g) task list only shows status actually represented by Run/Task FSM, (h) Tauri/React layout memory is local UI state, not a hidden mutation of Run state.

Responsive: desktop three panes min center ~500px, side panes individually resizable and dismissible; narrow window collapses left and right drawers; keyboard focus/ARIA live-region updates are essential. Store pane layout per project/user and restore without delaying launch. Starter users can choose plain-language cards while experts inspect raw trace; both render the same event IDs and safety/risk flags.

### UI component modules and proposed signatures

| Module / class | Props or events | Behavior |
|---|---|---|
| `WorkspaceShell` | `projectId, experience, panels, navigate()` | draggable layout/pane persistence; no run mutations |
| `ExplorerTree` | `workspaceRef, branch, onSelect(path)` | tracked/untracked files, symbol tree and safe refresh |
| `ActiveGoalCard` | `goalId, revision, status, criteriaProgress` | truthful status, pause/resume/edit and evidence drilldown |
| `TaskTimeline` | `runId, cursor` | stream/replay canonical events, collapsible detail |
| `DiffReviewPane` | `baseRevision, candidatePatch` | syntax diff, per-hunk accept/reject, copy and undo guards |
| `AgentFleetPane` | `runId, active, queued` | subagent steps, selected models, isolation resources, cost |
| `PreviewCanvas` | `previewId, viewport` | choose DOM element, source-anchored edit, screenshot comparison |
| `CodeEditorPane` | `workspaceId,fileId` | Monaco/CodeMirror with LSP, autocomplete, breakpoints, navigation |
| `CommandTerminal` | `executionId, terminalLease` | xterm.js output throttle, CTRL-C/terminate with authorization |
| `InspectorTabHost` | `selectedArtifact, tab` | Changes / Tests / Terminal / Preview / Evidence / Browser / Costs |
| `ModelSelector` | `provider,model,harness,locality` | explicit pinned selection; capabilities and unavailable markers |
| `PermissionSwitch` | `ask|safe-auto|yolo-in-sandbox` | scope explanation, hard-boundary warning and active grants |
| `ApprovalQueue` | `actionIntent,scope,risk,history` | grouped one-time/task grants without repetitive prompts |
| `ResourcePoolPanel` | `worktrees,ports,testDbs,leases,disk` | active/warm/quarantined and interactive dry-run GC |
| `HealTimeline` | `failures,attempts,strategy,evidence` | explain retry reasons, no-progress, healing candidates and paused cases |
| `CommandComposer` | `contextChips,mode,model,input` | autocomplete slash commands and named context with token count |
| `BuildReport` | `criteria,evidence,unknowns` | no false success language, plain and technical toggles |

### Beginner interaction examples

"Build me a booking app" -> new project wizard, editable user-facing outcome, preview with demo data, clear “not yet published”, explicit app permissions and data behavior. Clicking a button in preview -> source map + visual edit proposal -> verified preview update; no proprietary alternate source state. "My users cannot sign in" -> incident captures app environment, deploy revision, logs, staging reproduction; explain whether *observed*, *suspected* or *fixed*. Production changes always separate from creating the local patch.

## 12.2 Tool definitions and boundaries (inbuilt and reused)

Retain OpenCode's tested read, edit, grep, glob, shell, task/subagent, skill, MCP, question/approval, LSP and compaction helpers behind `ToolRegistryAdapter`, where present and working in pinned version. Promote every privileged **effect** through Rust's `ToolBroker`; don't allow Node to call raw FS/command APIs with wider privileges than its scoped worker. Some OpenCode tools are context-only and can remain internal; classify them by side-effect severity.

| Tool namespace | Exact proposed operations | Isolation / evidence |
|---|---|---|
| `fs.*` | `read`, `list`, `glob`, `grep`, `stage_patch`, `apply_patch`, `diff`, `undo` | canonical root, digest/fence for writes, file evidence |
| `repo.*` | `symbol`, `references`, `callers`, `impact`, `manifest`, `docs`, `semantic_search` | indexed revision + confidence and source ranges |
| `git.*` | `status`, `diff`, `branch`, `commit`, `worktree_acquire`, `worktree_release`, `merge_prepare`, `merge_apply` | Git ref and dirty snapshot, no blind `reset --hard` |
| `exec.*` | `shell`, `pty`, `test`, `lint`, `format`, `build`, `debug`, `process_list`, `process_stop` | process group, resource quota, output/truncation receipts |
| `browser.*` | `navigate`, `inspect`, `select`, `click`, `type`, `screenshot`, `journey`, `trace` | sandboxed browser/profile, origin/target, trace artifact |
| `preview.*` | `start`, `stop`, `port`, `health`, `map_element`, `propose_visual_edit`, `compare` | port/test database lease, screenshot and source anchor |
| `context.*` | `attach`, `compact`, `retrieve`, `history`, `decision`, `goal_snapshot` | only trusted user/system facts privileged, clear provenance |
| `agent.*` | `delegate`, `list`, `status`, `join`, `steer`, `cancel`, `capabilities` | task graph ownership + child evidence receipt |
| `goal.*` | `get`, `create`, `edit`, `propose_complete`, `report_blocked` | GoalController gate, model cannot self-finalize |
| `skills.*` | `catalog`, `inspect`, `run`, `validate` | manifests + declared tool scopes, user override |
| `mcp.*` | `list`, `connect`, `disconnect`, `invoke` | deny untrusted tools until scopes approved; URI allowlist |
| `publish.*` | `plan`, `prepare`, `approve`, `deploy`, `verify`, `rollback` | production/environment-specific explicit approval |
| `resources.*` | `status`, `gc_preview`, `gc_execute`, `reconcile` | never reclaim leased or dirty changes |
| `healing.*` | `diagnose`, `history`, `candidate`, `canary`, `promote` | no automatic privilege/policy escalation |

Results carry canonical `ToolResult { callId, effectId?, status, output, outputArtifactRefs, contentDigest?, environmentRef?, revision?, warningCodes[], cost?, startedAt,finishedAt }`; outputs are capped for model context with full artifacts retrievable via references. Tools expose JSON schemas with deterministic errors and tagged output variants; external protocols go through the same broker.

## 12.3 Slash command system (exactly one registry)

A slash command is a typed UI/API invocation, NOT prompt text interpreted for side effects. Registry schema: `{id, aliases, description, namespace, argumentSchema, allowedSurfaces, requiredCapabilities, permissionEffects, handlerId, shortcut?, completions, hiddenWhenUnsupported}`. Namespace collisions resolved explicitly; community skills use `/skill:name` or `/name` with disambiguation, and bundled commands cannot be silently shadowed. Status and help show disabled/unavailable commands with reasons.

| Group | Commands | Semantics |
|---|---|---|
| workspace | `/open`, `/new`, `/import`, `/project`, `/workspace`, `/cd`, `/tree`, `/files`, `/branch`, `/worktree`, `/clean`, `/export` | project/workspace navigation and safe resources cleanup |
| sessions | `/session`, `/sessions`, `/resume`, `/fork`, `/rename`, `/archive`, `/clear`, `/history`, `/recap`, `/compact` | only `/clear` chat does not erase durable run |
| goal/work | `/goal`, `/goal edit`, `/goal pause`, `/goal resume`, `/goal clear`, `/plan`, `/run`, `/pause`, `/continue`, `/stop`, `/status`, `/tasks`, `/checkpoint`, `/retry`, `/verify`, `/review` | goal actions invoke durable controller; `goal clear` requires no unsafe orphaned work |
| agent | `/agent`, `/agents`, `/delegate`, `/parallel`, `/join`, `/model`, `/harness`, `/effort`, `/provider`, `/models`, `/local`, `/limits` | explicit profile selection and task dispatch; no silent routing |
| permission | `/permissions`, `/mode ask`, `/mode safe-auto`, `/mode yolo`, `/approvals`, `/grants`, `/revoke`, `/sandbox` | scoped grants and mode policy UI; command doesn't itself bypass security |
| dev | `/diff`, `/test`, `/lint`, `/build`, `/fix`, `/debug`, `/terminal`, `/logs`, `/symbols`, `/references`, `/impact`, `/docs`, `/git`, `/pr` | invoke typed tools with clear target and evidence |
| visual/operate | `/preview`, `/browser`, `/select`, `/screenshot`, `/design`, `/deploy`, `/releases`, `/rollback`, `/backups`, `/incident` | visual editing and safe operations |
| extensions | `/skills`, `/skill:name`, `/mcp`, `/hooks`, `/rules`, `/memory`, `/init`, `/doctor`, `/plugin`, `/settings`, `/help`, `/shortcuts` | discoverable composable extension infrastructure |
| observability | `/cost`, `/usage`, `/budget`, `/healing`, `/resources`, `/events`, `/evidence`, `/trace` | auditable action/status details |

`/goal <objective>` means create or propose a changed goal; use `/goal edit` to revise active goals rather than arbitrarily replace approved criteria. `/goal clear` archives/retracts the active goal after ensuring active workers have stopped or been explicitly reattached. `/model` preserves user choice across sessions unless a per-project preference overrides it visibly. `/harness` changes tool protocol formatting, not the model provider; warn when active provider-native state cannot be reused. `/clean` does a **dry run first** by default; exact policy grants still apply on execution. `/parallel N` controls maximum active agents and can be reduced even during a running task after current tool safe points.

## 12.4 Rules, memory and instruction trust

Public Claude documentation describes two memory classes: `CLAUDE.md`/`AGENTS.md` authored guidance and auto memory generated from corrections. The official docs explicitly state memory is **context** and not enforcement; tool hooks implement hard boundaries. Implement analogous separation:

1. **Durable goal memory** (Rust, authoritative): criteria, approved goal revisions, current task states, decisions, effects and evidence; cannot be overwritten by summarization.
2. **Project rules** (files from user/organization/repo): versioned and scoped by path; `AGENTS.md` compatible; imported rules marked lower-trust repo content and never allowed to override hard permission policy.
3. **Session working context** (OpenCode): conversations, compaction, context epochs; compact references, not authenticated goal DB facts.
4. **Learned patterns** (L3): local opted-in success/failure memory with provenance and utility score; advisory, sanitized, auditable, deletable.
5. **Agent/subagent scratch**: ephemeral attempt memory and delegated artifacts; no unreviewed promotion to global rules.

`RuleLoader` methods: `discover(scope,files)`, `parseFrontmatter()`, `matchPathGlobs()`, `detectConflicts()`, `dedupe()`, `contextualize()`, `audit()`, `proposeUpdate()`; context budget bounds and source/trust labels. `MemoryService`: `storePattern`, `retrieveRelevant`, `rateOutcome`, `pruneUnpinned`, `export`, `delete`, `auditProvenance`. `ContextAssembler` includes goal snapshot FIRST, then authorized project context, selected skills, relevant source, optional trusted learned hints. Keep model-visible memory compact and target-specific; don't force complete repository summaries into every prompt.

## 12.5 Hooks and skills

Hook phases: `BeforeGoal`, `BeforePlan`, `BeforeModelCall`, `AfterModelOutput`, `BeforeToolUse`, `AfterToolUse`, `AfterPatch`, `BeforeVerification`, `AfterVerification`, `BeforeRelease`, `AfterRelease`, `OnFailure`, `OnCheckpoint`, `OnStop`. Deterministic hooks can be blocking (deny/rewrite-to-safe), advisory, or async telemetry; registry validates extension scope, maximum runtime and exit semantics. `BeforeToolUse` hooks cannot grant authority beyond `PolicyEngine`; hook returning 'allow' does not override a deny.

Skills: lazy discovery by task relevance; versioned `SKILL.md` + typed manifest `{id, version, summary, entrypoints, activation, requiredTools, requestedPermissions, inputsSchema, outputsSchema, verificationHints}`. Execute instructions as guidance; actual tools are still authorized; avoid loading the bodies of dozens of skills on every turn. Distinguish tools (capabilities), skills (reusable procedures), commands (UI entry points), agent profiles (composition of model+harness+tools+skills+instructions+limits), and hooks (deterministic lifecycle checks).

## 12.6 Agent configuration UI

Settings → Agents → [Default / custom] allows name, use-case, optional instructions, pinned provider + model, harness, reasoning/effort if provider supports it, tool allow/deny, skill list, MCP connections, permission ceiling, max turn/time/token allowances, whether main/child allowed, worktree policy and isolation requirements. No compulsory AI-designed cost routing. Delegation defaults to child profile selected by user; user may define `when_to_delegate` hints, but explicit grant and resource caps still apply. Show accurate feature availability: a local model lacking tool calling can choose minimal harness with degraded capabilities instead of being falsely advertised as equivalent to a large hosted model.

## 12.7 Performance and offline usability

Do not automatically load expensive semantic embedding models at start. Stage retrieval: Git/ripgrep → tree-sitter → LSP on demand → opt-in embeddings. Use lightweight terminal/log stream virtualization; bounded memory history, disk retention, cache quotas and lazy IDE editor initialization. Bundled tools and minimal local model should work offline if all necessary toolchains and model weights are installed. No forced vendor subscription and no arbitrary core local run cap; real physical/token constraints displayed honestly. Respect provider terms/auth methods and don't promise one subscription necessarily works in another host.

## 12.8 Claude source caution

Third-party GitHub collections claiming to contain exposed/minified Claude Code internals cannot establish official implementation guarantees. This architecture does not reproduce such code. Officially documented memory, hooks, agent/profile customization and slash UX are adequate to design lawful equivalents. Do not call the user-supplied four-tier healer “Claude Code self healing” unless independently verified from authorized public documentation.


---


## 12.9 2026-10-11 context, local-model and capability expansion

The detailed contracts now live in §§29–33. This chapter adopts them into the universal
user experience.

### Additional typed commands

| Area | Commands | Semantics |
|---|---|---|
| context | `/context`, `/trim [preview]`, `/prune [preview]`, `/compact [preview]`, `/clear`, `/history search` | distinct ContextLedger operations; canonical history survives cleanup |
| repository intelligence | `/symbols`, `/references`, `/outline`, `/impact`, `/diagnostics` | symbol/LSP/index views; bounded text-search fallback |
| artifacts | `/artifacts`, `/artifact <id>`, `/mermaid [on|off|auto]` | inspect/export safe generated artifacts |
| agents | `/agents`, `/agent`, `/subagents`, `/mission` | profile/library and running-worker views |
| analytics | `/stats`, `/usage`, `/cost`, `/latency`, `/cache`, `/trace` | measured/estimated/unknown metrics |
| automation | `/automations`, `/schedule`, `/run-now` | durable schedule/action descriptors |
| quick actions | `/quick` | project/user pinned typed ActionDescriptors |

Aliases and exact command spelling remain centrally registered; the table above is the
required action family, not permission-bearing free text.

### Local inference settings

Settings → Providers exposes dedicated setup flows for:
- Ollama;
- LM Studio;
- LiteLLM;
- generic OpenAI-compatible endpoint.

Each flow preserves exact base URL/model/auth reference and reports observed capabilities
separately from configured assumptions. The UI never labels an endpoint “fully compatible”
merely because one health request succeeded.

### Context UI

The composer context chip opens the typed Context Panel from §30. The user can inspect
system/goal/conversation/file/symbol/artifact/skill/memory/media contributions and see
exact or estimated tokens against the selected model's real configured window. Cleanup
previews show protected entries and what will change.

### Horizon Docs skill

`builtin.horizon-docs` is installed with the product. It performs targeted local retrieval
over the installed HorizonCode docs and is invoked when the agent needs product-specific
architecture/config/API truth. It must not inflate the base prompt with the complete manual.

### Learning boundary

V1 “memory” and analytics do not autonomously rewrite profile/security/routing configuration.
Reviewed advisory repair records may be retrieved with provenance. Experimental self-tuning
is post-V1 only (§31.17).

## 12.10 OMP source-backed UX provenance and proposed translation (research only)

The exact source review in [§39](39-OMP-TUI-SLASH-MODEL-SETTINGS-AUDIT.md) inventories 85 OMP builtin slash specs, icon metadata, 409 UI setting entries, 15 role slots, provider connection UI, full-screen /models and /settings, and user screenshot evidence; see the machine-readable command/settings inventory. [§40](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md) proposes mapping these to Horizon's already-defined typed ActionDescriptor and prompt bar instead of copying OMP's runtime/router. Same visible action => same canonical owner, argument schema, Guard/effect policy, scope and status across TUI/app/API. Horizon Goal/Run owner and AgentHarness-vs-ModelProvider separation are mandatory.
