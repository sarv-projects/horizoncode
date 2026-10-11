# 39 — Oh My Pi TUI, slash, models, providers and every declared settings control

> **RESEARCH / PROPOSAL. NOT ADOPTED, NOT IMPLEMENTED.** All evidence pinned to can1357/oh-my-pi commit eec114a9226da698ebc015fd8996a8ca3bc4625c (2026-10-11).
> Companion inventory: [OMP UI command/settings source inventory](omp-tui-command-settings-inventory.json).
> Existing upstream Rust/tools audit: [§38](38-OMP-SOURCE-COMPETITIVE-AUDIT.md).
> Additional first-hand visual evidence: four screenshots supplied by the user (command autocomplete, model hub, goal input and settings).

## 39.1 What was examined

Fetched and hashed 61 pinned upstream source/documentation files: all source-declared settings domains from config/all-settings.ts, all seven built-in command registries, semantic glyphs, settings overlay, model hub, compact picker, provider OAuth selector, model role definitions, developer/docs reference. Parsed 85 registered top-level slash command definitions, 409 typed UI-setting declarations, 10 settings tabs and 15 built-in roles.

**Boundaries:** 409 represents static setting registrations that carry UI metadata, not 409 simultaneously visible clickable buttons. Capability/OS/setting conditions hide some. 85 are built-in TOP-LEVEL slash command specs, not plugin/file-discovered commands, command aliases or public LLM AgentTools. Descriptions may be runtime-computed; aliases/subcommands with dynamic construction may not appear in regex-derived metadata. No running OMP login/UI automation was performed.

## 39.2 Screenshot-by-screenshot interface anatomy

**Slash autocomplete:** one dropdown row per command, semantic emoji/icon on left, canonical command text, dynamic description/current state on right, highlighted selection, filter on type. Observed examples: skill count, current model, Goal off, marketplace/setup/settings/plan. The live skill count and model are user-session-specific. Source: slash-commands/builtin-registry.ts, seven builtin-* source files, theme/symbols.ts, prompt autocomplete.

**Fullscreen /models:** left role/all/provider rail (each provider with status/count); right fuzzy-searchable catalog with model kind chips, id/name, context, token-rate and cost/reasoning/perf hints when available; selected-row details below and navigation hints footer. Roles view separates configuring 15 workload roles from selecting one-off session model; includes fallback chain rows, role scope (global vs project), saved role presets and locked provider login path. The 289 catalog size in screenshot is not guaranteed across environments. Source: model-hub.ts (4,216 lines), model-browser.ts, model-picker.ts.

**Goal objective:** large bordered multi-line input, top-right work-caption, visible caret, Enter/Ctrl+Q submit, cancel, Ctrl+G external editor. Source command /goal and /guided-goal, goals state and screenshot. Screenshot alone does not prove how OMP persists the draft or validates target criteria. Horizon must separately specify its own durable/guarded revision process.

**Fullscreen /settings:** horizontal icon-labeled tab strip, sectional sidebar, editable setting rows, descriptions beneath selected item, bottom live preview/status and key hints. Screenshot shows Appearance > Theme, Composer, Status Line, Display, Images. Source: settings-defs.ts, settings-selector.ts (~2K lines), schema settings-ui.ts and registered domains. Includes theme/status-line preview-with-revert, typed validation, reset/default indicators, type-to-search, conditional visibility and an injected Plugins page.

## 39.3 OMP provider, model and role design — source-backed

OMP separates provider namespace from concrete model (provider/model-id). Registry candidates include bundled catalog, optional custom models.yml, local engine discovery (Ollama/LM Studio/llama.cpp/Apple Foundation Models when supported), hosted providers, proxy discovery and extension providers. Model KIND differs from model ROLE, and role differs from session choice. Source: docs/models.md, docs/providers.md, model-hub.ts and model-roles.ts.

Authentication paths include per-provider OAuth, API key, env/.env, custom provider keyless/credential and optional broker. Provider selection UI can show credential source, validation spinner, login validity, locked/disconnected status, cached availability and refresh. Availability means configured to route, not necessarily a working live entitlement. No OMP source claim establishes that every available catalog model is free, that displayed token prices are the user's subscription spend, or that OAuth is permitted for arbitrary third-party reuse.

The model hub supports selecting provider/models for current session, configurable workload-role assignments (global/project), model presets, per-role fallback chains, filtering by kind, fuzzy search, model metadata, and provider refresh. A compact Alt+P switcher is deliberately session-only; leading @ searches quick roles, and Task subagent model may be selected separately.

**Horizon distinction:** Agent Harness choice (OpenCode, Codex CLI, Claude Code, ACP worker) is NOT interchangeable with model provider (OpenAI API, local Ollama, Groq, etc.). Horizon provider/model UI must preserve the selected harness and provider-specific sign-in, quota, capabilities and model list; do not let a fallback quietly change harness or incur API billing.

## 39.4 The 15 role definitions

1. `default`: Default
2. `smol`: Fast
3. `slow`: Thinking
4. `vision`: Vision
5. `plan`: Architect
6. `commit`: Commit
7. `tiny`: Tiny
8. `memory`: Memory
9. `task`: Subtask
10. `advisor`: Advisor
11. `image`: Image
12. `web`: Web search
13. `speech`: Speech / TTS
14. `dictation`: Dictation / STT
15. `judge`: Judge

A role is a candidate binding, not an instruction to activate another model. Missing, unsupported or unauthenticated assignments remain visible with honest status. Horizon must require explicit opt-in for paid judge/advisor/search providers.

## 39.5 Slash command system internals

OMP specs compose seven builtin command arrays. Each contains canonical command, optional aliases, semantic icon key, a static or computed description, subcommands, argument hints and per-surface handlers. The autocomplete surface is materialized from the command definitions. Many commands show live state such as selected model, goal status or extension count. Theme glyphs resolve from semantic symbol key through Unicode, Nerd-font or ASCII presets; the raw emoji is not the command identifier.

Horizon should extend ONE existing ActionDescriptor registry, not copy a new command router. Buttons, palette, slash input, keybindings, SDK and desktop menus must dispatch the same typed action; unknown slash commands fail explicitly and plugin aliases never override sealed builtins.

## 39.6 Exhaustive pinned top-level built-in slash-command inventory

The 85 records below are sourced from the upstream top-level builtin arrays at the pinned commit. Subcommand lists contain statically detected inline literal names; empty does not prove the command lacks dynamic subcommands. Sources and line offsets live in the JSON.

### modes: 21 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| 🛡 | `/security` | — | Plan, run, inspect, import, and compare OMP-native security scans | plan, scan, status, cancel, scans, show, import, export, validate, compare, disposition |
| 🎛 | `/settings` | — | Open settings menu | — |
| ⚙ | `/setup` | /providers | Open provider setup | — |
| 🗺 | `/plan` | — | Toggle plan mode (agent plans before executing) | — |
| 🗺 | `/plan-review` | — | Re-open the plan review for the latest plan (plan mode only) | — |
| ∿ | `/vibe` | — | Toggle vibe mode (direct persistent fast/good worker sessions; read-only toolset) | — |
| 🎯 | `/goal` | — | Toggle goal mode (persistent autonomous objective for this session) | set, show, pause, resume, drop, budget |
| 🧭 | `/guided-goal` | — | Have the agent interview you in chat, then set up goal mode | — |
| ↻ | `/loop` | — | (dynamic getter/handler; see upstream source) | — |
| 📥 | `/queue` | — | Queue a message for after the agent yields | — |
| ⬢ | `/model` | /models | Switch model for this session | — |
| ⇄ | `/switch` | — | (dynamic getter/handler; see upstream source) | — |
| ⚡ | `/fast` | — | Toggle fast service (OpenAI service_tier=priority or ultrafast, Anthropic speed=fast, Google priority) | on, ultra, off, status |
| ⚡ | `/slow` | — | Toggle slow mode: flex tier on OpenAI/Google; on Anthropic, continue at low priority after the Claude session limit | on, off, status |
| 🧭 | `/skillful` | — | Toggle listing available skills in the system prompt (session only) | on, off, status |
| ⤢ | `/extended-context` | — | Toggle extended context windows | on, off, status |
| 🖥 | `/computer` | — | Toggle the native computer-use eval prelude for this session | on, off, status |
| ↻ | `/ratchet` | — | Build (or reuse) an eval for an LLM flow, then hillclimb it unattended | — |
| 🏃 | `/prewalk` | — | Arm, restart, or cancel a one-shot model handoff | restart, off |
| ⬢ | `/modelpreset` | — | Save and switch model presets (role models + thinking level) | list, save, switch, delete |
| gauge | `/effort` | — | (dynamic getter/handler; see upstream source) | — |

### control: 5 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| 🔨 | `/force` | /force: | Force next turn to use a specific tool | — |
| voice | `/live` | — | Start Codex-backed realtime voice mode | — |
| 📤 | `/record` | — | Start or stop recording this screen to a replayable file (omp play) | — |
| ⏸ | `/pause` | — | Freeze all agents (main, subagents, advisor) until resumed | — |
| ⏻ | `/quit` | /q | Quit the application | — |

### session: 19 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| ☑ | `/todo` | — | View or modify the agent's todo list | edit, copy, expand, collapse, export, import, append, start, done, drop, rm |
| 🆔 | `/session` | — | Session management commands | info, delete, pin |
| jobs | `/jobs` | — | Show async background jobs status | full, kill |
| gauge | `/usage` | — | Show provider usage and limits | show, reset |
| 📊 | `/stats` | — | Launch the local stats dashboard | — |
| 📰 | `/changelog` | — | Show changelog entries | full, last |
| ⌨ | `/hotkeys` | — | Show all keyboard shortcuts | — |
| tools | `/tools` | — | Show tools currently visible to the agent | — |
| ◫ | `/context` | — | Show estimated context usage breakdown | — |
| 🧩 | `/extensions` | /status | Open Extension Control Center dashboard | — |
| 👥 | `/agents` | — | Open the agents hub (per-agent model, prewalk, and advisor) | — |
| ⑂ | `/git` | — | Open the git UI (split diff viewer, staging, commit composer) | — |
| 👥 | `/hub` | — | Open the live Agent Hub | — |
| ⑂ | `/branch` | /rewind | Rewind to a previous message, keeping the old path as a branch | — |
| ⑂ | `/fork` | — | Fork this session, or open it in a multiplexer pane or window | pane, window, tab |
| tree | `/tree` | — | Navigate session tree (switch branches) | — |
| signIn | `/login` | — | Login with OAuth provider | — |
| signOut | `/logout` | — | Logout from OAuth provider | — |
| mcp | `/mcp` | — | Manage MCP servers (add, list, remove, test) | add, list, remove, test, reauth, unauth, enable, disable, smithery-search, smithery-login, smithery-logout, reconnect, reload, resources, prompts, notifications, help |

### lifecycle: 25 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| 🖥 | `/ssh` | — | Manage SSH hosts (add, list, remove) | add, list, remove, help |
| ✚ | `/new` | — | Start a new session | — |
| ↻ | `/fresh` | — | Reset provider stream state without changing the local transcript | — |
| 🧹 | `/clear` | — | Clear the conversation context in place, keeping the session | — |
| 🗑 | `/delete` | — | Delete the current session and start a new one | — |
| 🗜 | `/compact` | — | Manually compact the session context | — |
| 📳 | `/shake` | — | Drop heavy content from context (tool results, large blocks) | elide, images, thinking |
| ➦ | `/handoff` | — | Summarize the session into a handoff document and compact in place | — |
| 🕘 | `/resume` | — | Resume a different session | — |
| 📌 | `/pin` | — | Pin or unpin a session at the top of the resume list | — |
| ❓ | `/btw` | — | Ask a side question, or browse this session's BTW history | — |
| 🚀 | `/tan` | — | Run a full background agent on tangential work | — |
| rule | `/omfg` | — | Forge a TTSR rule from a complaint to stop a recurring behavior | — |
| 🩺 | `/cleanse` | — | Detect and fix project diagnostics with weighted parallel subagents | — |
| 🔁 | `/retry` | — | Retry the last failed agent turn | — |
| 🐛 | `/debug` | — | Open debug tools selector | — |
| 🧠 | `/memory` | — | Inspect and operate memory maintenance | view, stats, diagnose, queue, sync, clear, reset, enqueue, rebuild, mm list, mm show, mm refresh, mm history, mm seed, mm delete, mm reload |
| ✏ | `/rename` | — | Rename the current session (omit title to generate) | — |
| 📂 | `/move` | — | Move the current session to a different directory | — |
| 📂 | `/wt` | /worktree | Move this session into a new worktree, changes included | — |
| 📁 | `/add-dir` | — | Add a workspace directory to this session (multi-root) | — |
| 📁 | `/remove-dir` | — | Remove a workspace directory from this session | — |
| — | `/dirs` | — | List this session's workspace directories | — |
| — | `/exit` | — | Exit the application | — |
| ↻ | `/restart` | — | Restart omp with the same launch flags, resuming this session | — |

### skills: 1 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| skill | `/skills` | — | Search, install, and update skills from the skills.omp.sh registry | search, install, installed, update |

### marketplace: 3 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| 🛒 | `/marketplace` | — | Manage marketplace plugin sources and installed plugins | add, remove, update, list, discover, install, uninstall, installed, upgrade, help |
| 📦 | `/plugins` | /plugin | View and manage installed plugins | list, enable, disable |
| ↻ | `/reload-plugins` | — | Reload all plugins (skills, commands, hooks, tools, agents, MCP) | — |

### collaboration: 11 commands

| Icon or key | Command | Aliases | Description/status | Static subcommands |
|---|---|---|---|---|
| 👁 | `/advisor` | — | Toggle the advisor (a second model that reviews each turn and injects notes) | on, off, status, dump, configure |
| 📤 | `/export` | — | Export session to HTML file | — |
| 📊 | `/trace` | — | Open this session's trace in the stats dashboard | — |
| 📋 | `/dump` | — | Copy session transcript to clipboard (and write LLM request JSON to tmp) | all, anon |
| ↗ | `/share` | — | Share session via an encrypted link (share server or secret gist) | — |
| 📡 | `/collab` | — | Share this session live via a relay | view, list, status, stop |
| signIn | `/join` | — | Join a shared collab session | — |
| signOut | `/leave` | — | Leave the collab session | — |
| 🌐 | `/browser` | — | Toggle browser eval-prelude headless vs visible mode | headless, visible |
| ⧉ | `/copy` | — | Pick text or code from the conversation to copy | — |
| 🌐 | `/open` | — | Open the last link from the conversation in your browser (or pick one with /copy) | — |


## 39.7 Exhaustive pinned settings tabs and UI rows

All 409 schema-declared settings are included below, grouped by the 10 source-defined tabs. The true UI also has a separate Plugins page. Settings metadata exists per setting ID, so the TUI derives display rows, descriptions, conditional visibility, defaults and validation rather than using a parallel preference schema.

Declared tab counts:
- 🎨 Appearance: 43 source-declared rows; section groups: Theme, Composer, Status Line, Display, Images
- 🤖 Model: 59 source-declared rows; section groups: Thinking, Sampling, Prompt, Retry & Fallback, Advisor, Prewalk, Vision
- ⌨ Interaction: 51 source-declared rows; section groups: Input, Approvals, Notifications, Speech, Collab, Stream, Magic Keywords, Startup & Updates, Power, Agent, Git, Skills
- 📋 Context: 31 source-declared rows; section groups: General, Compaction, Rules (TTSR), Experimental
- 🧠 Memory: 30 source-declared rows; section groups: General, Auto-Learn, Mnemopi, Hindsight, Sharpshooter
- 📁 Files: 27 source-declared rows; section groups: Editing, Reading, Read Summaries, LSP
- 💻 Shell: 18 source-declared rows; section groups: Bash, Eval & Runtimes
- 🔧 Tools: 71 source-declared rows; section groups: Available Tools, Todos, Grep & Browser, Computer, IDA Pro, GitHub, Output Limits, Execution, Discovery & MCP, Extensions, Developer
- 📦 Tasks: 38 source-declared rows; section groups: Modes, Subagents, Isolation, Commands & Skills
- 🌐 Providers: 41 source-declared rows; section groups: Services, Fireworks, Tiny Model, Protocol, Timeouts, Privacy

Special page: Plugins (runtime plugin-settings, no static entry count in these ten tabs).

### Appearance — 43 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Theme | Dark Theme | `theme.dark` | string | — |
| Theme | Light Theme | `theme.light` | string | — |
| Theme | Symbol Preset | `symbolPreset` | enum | — |
| Theme | Color-Blind Mode | `colorBlindMode` | boolean | — |
| Composer | Composer Shape | `composer.shape` | string | — |
| Composer | Generation Rate | `composer.tokenRate` | boolean | — |
| Status Line | Status Line Preset | `statusLine.preset` | enum | — |
| Status Line | Status Line Separator | `statusLine.separator` | enum | — |
| Status Line | Context-Reactive Line | `statusLine.contextLine` | enum | — |
| Status Line | Session Accent | `statusLine.sessionAccent` | boolean | — |
| Status Line | Transparent Status Line | `statusLine.transparent` | boolean | — |
| Status Line | Compact Thinking Level | `statusLine.compactThinkingLevel` | boolean | — |
| Status Line | Show Hook Status | `statusLine.showHookStatus` | boolean | — |
| Images | Show Inline Images | `terminal.showImages` | boolean | hasImageProtocol |
| Images | Auto-Resize Images | `images.autoResize` | boolean | — |
| Images | Block Images | `images.blockImages` | boolean | — |
| Display | Resize Scrollback | `tui.resizeScrollback` | enum | — |
| Display | Native Terminal Progress | `terminal.showProgress` | boolean | — |
| Display | Program Status (OSC 7501) | `terminal.programStatus` | boolean | — |
| Display | Large Headings (Kitty) | `tui.textSizing` | boolean | — |
| Display | Render Mermaid Diagrams | `tui.renderMermaid` | boolean | — |
| Display | Render SVG Figures | `tui.renderSvg` | boolean | — |
| Display | Auto-Graph Tables | `tui.autoGraph` | enum | — |
| Display | Agent Reactions | `tui.reactions` | boolean | — |
| Display | Codex Reset Fireworks | `tui.codexResetFireworks` | boolean | — |
| Display | Terminal Title Run State | `tui.titleState` | boolean | — |
| Display | Terminal Title Spinner | `tui.titleSpinner` | enum | — |
| Display | Terminal Hyperlinks | `tui.hyperlinks` | enum | — |
| Display | Mouse Click-to-Focus | `tui.mouse` | boolean | — |
| Display | Tight Layout | `tui.tight` | boolean | — |
| Display | Shimmer | `display.shimmer` | enum | — |
| Display | Pinned Agents | `display.pinnedAgents` | enum | — |
| Display | Subagent Live Preview | `display.subagentLivePreview` | boolean | — |
| Display | Smooth Streaming | `display.smoothStreaming` | boolean | — |
| Display | Hide Tool Activity | `display.hideToolActivity` | boolean | — |
| Display | Show Token Usage | `display.showTokenUsage` | boolean | — |
| Display | Show Turn Time | `display.showTurnTime` | boolean | — |
| Display | Cache Miss Marker | `display.cacheMissMarker` | boolean | — |
| Display | Collapse Compacted History | `display.collapseCompacted` | boolean | — |
| Display | Show Hardware Cursor | `showHardwareCursor` | boolean | — |
| Display | IME-Safe Prompt Layout | `tui.imeSafeCursor` | boolean | — |
| Display | Show Resolved Model Badge | `task.showResolvedModelBadge` | boolean | — |
| Display | Title Icons | `title.icons` | enum | — |

### Model — 59 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Prewalk | Enable Prewalk | `prewalk.enabled` | boolean | — |
| Vision | Describe Images for Text Models | `images.describeForTextModels` | boolean | — |
| Thinking | Thinking Level | `defaultThinkingLevel` | enum | — |
| Thinking | Hide Thinking Blocks | `hideThinkingBlock` | boolean | — |
| Thinking | Expand Thinking Blocks | `expandThinkingBlocks` | boolean | nativeRendering |
| Thinking | Prose Only Thinking | `proseOnlyThinking` | boolean | — |
| Thinking | Omit Thinking summaries | `omitThinking` | boolean | — |
| Thinking | External Thinking | `externalThinking` | boolean | — |
| Thinking | Loop Guard | `model.loopGuard.enabled` | boolean | — |
| Thinking | Loop Guard Scan Prose | `model.loopGuard.checkAssistantContent` | boolean | — |
| Thinking | Loop Guard Tool-Call Reminder | `model.loopGuard.toolCallReminder` | boolean | — |
| Thinking | Tool-Call Loop Guard | `model.toolCallLoopGuard.enabled` | boolean | — |
| Thinking | Tool-Call Loop Threshold | `model.toolCallLoopGuard.threshold` | number | — |
| Thinking | Tool-Call Loop Exempt Tools | `model.toolCallLoopGuard.exemptTools` | array | — |
| Prompt | Inline Tool Descriptors | `inlineToolDescriptors` | enum | — |
| Prompt | Include Model in Prompt | `includeModelInPrompt` | boolean | — |
| Prompt | Include Workspace Tree | `includeWorkspaceTree` | boolean | — |
| Prompt | List Skills in Prompt | `skillful` | boolean | — |
| Prompt | Personality | `personality` | enum | — |
| Sampling | Temperature | `temperature` | number | — |
| Sampling | Top P | `topP` | number | — |
| Sampling | Top K | `topK` | number | — |
| Sampling | Min P | `minP` | number | — |
| Sampling | Presence Penalty | `presencePenalty` | number | — |
| Sampling | Repetition Penalty | `repetitionPenalty` | number | — |
| Sampling | Text Verbosity | `textVerbosity` | enum | — |
| Sampling | Service Tier — OpenAI | `tier.openai` | enum | — |
| Sampling | Service Tier — Anthropic | `tier.anthropic` | enum | — |
| Sampling | Service Tier — Google | `tier.google` | enum | — |
| Sampling | Service Tier — Subagent | `tier.subagent` | enum | — |
| Sampling | Service Tier — Advisor | `tier.advisor` | enum | advisorEnabled |
| Retry & Fallback | Retry Attempts | `retry.maxRetries` | number | — |
| Retry & Fallback | Max Retry Delay | `retry.maxDelayMs` | number | — |
| Retry & Fallback | Wait For Usage Reset | `retry.waitForUsageReset` | boolean | — |
| Retry & Fallback | Retry Model Fallback | `retry.modelFallback` | boolean | — |
| Retry & Fallback | Fallback Trigger | `retry.fallbackOn` | enum | — |
| Retry & Fallback | Usage-Aware Fallback | `retry.usageAwareFallback` | boolean | — |
| Retry & Fallback | Reserve Margin | `retry.usageReservePct` | number | usageAwareFallbackEnabled |
| Retry & Fallback | Reserve Policy | `retry.usageReservePolicy` | enum | usageAwareFallbackEnabled |
| Retry & Fallback | Retry Fallback Chains | `retry.fallbackChains` | record | — |
| Retry & Fallback | Fallback Revert Policy | `retry.fallbackRevertPolicy` | enum | — |
| Retry & Fallback | Anthropic Server-Side Fallback (Fable 5) | `providers.anthropic.serverSideFallback` | boolean | — |
| Thinking | Auto Thinking Ceiling | `providers.autoThinkingMaxEffort` | enum | autoThinkingActive |
| Advisor | Enable Advisor | `advisor.enabled` | boolean | — |
| Advisor | Advisor Sync Backlog | `advisor.syncBacklog` | enum | advisorEnabled |
| Advisor | Advisor Immune Turns | `advisor.immuneTurns` | number | advisorEnabled |
| Advisor | Advisor Review Mode | `advisor.reviewMode` | enum | advisorEnabled |
| Advisor | Advisor Review Interval | `advisor.reviewInterval` | number | advisorEnabled |
| Advisor | Advisor Max Notes Per Update | `advisor.maxNotesPerUpdate` | number | advisorEnabled |
| Advisor | Advisor Evict Stale Results | `advisor.evictStaleResults` | boolean | advisorEnabled |
| Prompt | Model Role Storage | `modelRoleStorage` | enum | — |
| Vision | Serve Images as URLs | `images.urls.enabled` | boolean | — |
| Vision | Image URL Backends | `images.urls.backends` | array | — |
| Vision | Image Upload Command | `images.urls.command` | string | — |
| Vision | Image URL Public Base | `images.urls.publicBaseUrl` | string | — |
| Vision | Image URL Lifetime (hours) | `images.urls.ttlHours` | number | — |
| Vision | Image URL Bind Host | `images.urls.bindHost` | string | — |
| Vision | Image URL SSH Target | `images.urls.sshTarget` | string | — |
| Vision | Image URL SSH Remote Port | `images.urls.sshRemotePort` | number | — |

### Interaction — 51 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Startup & Updates | Auto Resume | `autoResume` | boolean | — |
| Git | Enable Git Integration | `git.enabled` | boolean | — |
| Input | Steering Mode | `steeringMode` | enum | — |
| Input | Follow-Up Mode | `followUpMode` | enum | — |
| Input | Interrupt Mode | `interruptMode` | enum | — |
| Input | Vim Editing Mode | `tui.vimMode` | boolean | — |
| Input | Vim Mode Indicator | `tui.vimModeDisplay` | enum | vimModeEnabled |
| Input | Loop Mode | `loop.mode` | enum | — |
| Input | Loop Condition Timeout (ms) | `loop.conditionTimeoutMs` | number | — |
| Input | Recall Cleared Drafts | `composer.recallClearedDrafts` | boolean | — |
| Input | Double-Escape Action | `doubleEscapeAction` | enum | — |
| Input | Bare Exit on Empty Session | `input.bareExitOnEmptySession` | boolean | — |
| Input | Bare Slash Commands | `input.bareSlashCommands` | boolean | — |
| Input | Session Tree Filter | `treeFilterMode` | enum | — |
| Input | Autocomplete Items | `autocompleteMaxVisible` | number | — |
| Input | Typo Detection (macOS) | `spelling.typoDetection` | boolean | macOS |
| Input | Word Autocomplete | `spelling.autocomplete` | enum | — |
| Input | Composer Predictions | `composer.predictions` | boolean | — |
| Input | Autocorrect (macOS) | `spelling.autocorrect` | boolean | macOS |
| Input | Emoji Autocomplete | `emojiAutocomplete` | boolean | — |
| Input | Large Paste Menu | `paste.largeMenuThreshold` | number | — |
| Startup & Updates | Quiet Startup | `startup.quiet` | boolean | — |
| Startup & Updates | Show Startup Splash | `startup.showSplash` | boolean | — |
| Startup & Updates | Setup Wizard | `startup.setupWizard` | boolean | — |
| Startup & Updates | Check for Updates | `startup.checkUpdate` | boolean | — |
| Startup & Updates | Update Channel | `update.channel` | enum | — |
| Startup & Updates | Marketplace Auto-Update | `marketplace.autoUpdate` | enum | — |
| Startup & Updates | Startup Changelog | `startup.changelogMode` | enum | — |
| Magic Keywords | Magic Keywords | `magicKeywords.enabled` | boolean | — |
| Notifications | Completion Notification | `completion.notify` | enum | — |
| Notifications | Error Notification | `error.notify` | enum | — |
| Notifications | Ask Timeout | `ask.timeout` | number | — |
| Notifications | Ask Notification | `ask.notify` | enum | — |
| Notifications | Idle Recap | `recap.enabled` | boolean | — |
| Notifications | Idle Recap Delay | `recap.idleSeconds` | number | — |
| Power | Sleep Prevention | `power.sleepPrevention` | enum | — |
| Agent | Unexpected Stops | `features.unexpectedStopDetection` | enum | — |
| Approvals | Tool Approval Policies | `tools.approval` | record | — |
| Approvals | Tool Approval | `tools.approvalMode` | enum | — |
| Skills | Skill Registry | `skills.registryUrl` | string | — |
| Speech | Speech-to-Text | `stt.enabled` | boolean | — |
| Speech | Speech-to-Text Submit Trigger | `stt.submitTrigger` | enum | — |
| Collab | Relay URL | `collab.relayUrl` | string | — |
| Collab | Web UI URL | `collab.webUrl` | string | — |
| Collab | Display Name | `collab.displayName` | string | — |
| Collab | Auto Start | `collab.autoStart` | enum | — |
| Collab | Share Server | `share.serverUrl` | string | — |
| Collab | Share Store | `share.store` | enum | — |
| Collab | Share Secret Redaction | `share.redactSecrets` | boolean | — |
| Stream | Stream Server | `stream.serverUrl` | string | — |
| Stream | Extra Redaction Patterns | `stream.redactPatterns` | array | — |

### Context — 31 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| General | Additional Workspace Dirs | `workspace.additionalDirectories` | array | — |
| General | Extra Context Files | `contextFiles.extra` | array | contextFilesExtraNotProject |
| General | Auto-Promote Context | `contextPromotion.enabled` | boolean | — |
| General | Extended Context | `extendedContext` | boolean | — |
| Compaction | Auto-Compact | `compaction.enabled` | boolean | — |
| Compaction | Notes-backed context windows (experimental) | `compaction.experimentalContextManagement` | boolean | — |
| Compaction | Mid-Turn Compaction | `compaction.midTurnEnabled` | boolean | — |
| Compaction | Compaction Method Order | `compaction.methodOrder` | array | — |
| Compaction | Compaction Threshold | `compaction.thresholdPercent` | number | — |
| Compaction | Compaction Token Limit | `compaction.thresholdTokens` | number | — |
| Compaction | Save Handoff Docs | `compaction.handoffSaveToDisk` | boolean | — |
| Compaction | Remote Compaction V2 | `compaction.remoteStreamingV2Enabled` | boolean | — |
| Compaction | Async Compaction | `compaction.asyncEnabled` | boolean | — |
| Compaction | Idle Compaction | `compaction.idleEnabled` | boolean | — |
| Compaction | Idle Compaction Threshold | `compaction.idleThresholdTokens` | number | — |
| Compaction | Idle Compaction Delay | `compaction.idleTimeoutSeconds` | number | — |
| Compaction | Supersede Stale Reads | `compaction.supersedeReads` | boolean | — |
| Compaction | Elide Uneventful Results | `compaction.dropUseless` | boolean | — |
| Experimental | Snapcompact System Prompt | `snapcompact.systemPrompt` | enum | — |
| Experimental | Snapcompact Tool Results | `snapcompact.toolResults` | boolean | — |
| Experimental | Tool Calling Mode | `tools.format` | enum | — |
| Experimental | Snapcompact Shape | `snapcompact.shape` | enum | — |
| General | Branch Summaries | `branchSummary.enabled` | boolean | — |
| Rules (TTSR) | TTSR | `ttsr.enabled` | boolean | — |
| Rules (TTSR) | Judged Rules | `ttsr.judge` | enum | — |
| Rules (TTSR) | TTSR Context Mode | `ttsr.contextMode` | enum | — |
| Rules (TTSR) | TTSR Interrupt Mode | `ttsr.interruptMode` | enum | — |
| Rules (TTSR) | TTSR Repeat Mode | `ttsr.repeatMode` | enum | — |
| Rules (TTSR) | TTSR Repeat Gap | `ttsr.repeatGap` | number | — |
| Rules (TTSR) | Built-in Rules | `ttsr.builtinRules` | boolean | — |
| Rules (TTSR) | Disabled Rules | `ttsr.disabledRules` | array | — |

### Memory — 30 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| General | Memory Backend | `memory.backend` | enum | — |
| Sharpshooter | Sharpshooter Model | `sharpshooter.model` | string | — |
| Auto-Learn | Auto-Learn (experimental) | `autolearn.enabled` | boolean | — |
| Auto-Learn | Auto-run capture at stop | `autolearn.autoContinue` | boolean | autolearnActive |
| Mnemopi | Mnemopi DB Path | `mnemopi.dbPath` | string | mnemopiActive |
| Mnemopi | Mnemopi Bank | `mnemopi.bank` | string | mnemopiActive |
| Mnemopi | Mnemopi Scoping | `mnemopi.scoping` | enum | mnemopiActive |
| Mnemopi | Embedding variant | `mnemopi.embeddingVariant` | enum | mnemopiActive |
| Mnemopi | Mnemopi Auto Recall | `mnemopi.autoRecall` | boolean | mnemopiActive |
| Mnemopi | Mnemopi Auto Retain | `mnemopi.autoRetain` | boolean | mnemopiActive |
| Mnemopi | Mnemopi Polyphonic Recall | `mnemopi.polyphonicRecall` | boolean | mnemopiActive |
| Mnemopi | Mnemopi Enhanced Recall | `mnemopi.enhancedRecall` | boolean | mnemopiActive |
| Mnemopi | Mnemopi Proactive Linking | `mnemopi.proactiveLinking` | boolean | mnemopiActive |
| Mnemopi | Mnemopi Disable Embeddings | `mnemopi.noEmbeddings` | boolean | mnemopiActive |
| Mnemopi | Mnemopi Embedding Model | `mnemopi.embeddingModel` | string | mnemopiActive |
| Mnemopi | Mnemopi Embedding API URL | `mnemopi.embeddingApiUrl` | string | mnemopiActive |
| Mnemopi | Mnemopi Embedding API Key | `mnemopi.embeddingApiKey` | string | mnemopiActive |
| Mnemopi | Mnemopi LLM Mode | `mnemopi.llmMode` | enum | mnemopiActive |
| Mnemopi | Mnemopi LLM Base URL | `mnemopi.llmBaseUrl` | string | mnemopiActive |
| Mnemopi | Mnemopi LLM API Key | `mnemopi.llmApiKey` | string | mnemopiActive |
| Mnemopi | Mnemopi LLM Model | `mnemopi.llmModel` | string | mnemopiActive |
| Hindsight | Hindsight API URL | `hindsight.apiUrl` | string | hindsightActive |
| Hindsight | Hindsight API Token | `hindsight.apiToken` | string | hindsightActive |
| Hindsight | Hindsight Bank ID | `hindsight.bankId` | string | hindsightActive |
| Hindsight | Hindsight Scoping | `hindsight.scoping` | enum | hindsightActive |
| Hindsight | Hindsight Auto Recall | `hindsight.autoRecall` | boolean | hindsightActive |
| Hindsight | Hindsight Auto Retain | `hindsight.autoRetain` | boolean | hindsightActive |
| Hindsight | Hindsight Retain Mode | `hindsight.retainMode` | enum | hindsightActive |
| Hindsight | Hindsight Mental Models | `hindsight.mentalModelsEnabled` | boolean | hindsightActive |
| Hindsight | Hindsight Mental Model Auto-Seed | `hindsight.mentalModelAutoSeed` | boolean | hindsightActive |

### Files — 27 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Editing | Edit Mode | `edit.mode` | enum | — |
| Editing | Fuzzy Match | `edit.fuzzyMatch` | boolean | — |
| Editing | Fuzzy Match Threshold | `edit.fuzzyThreshold` | number | — |
| Editing | Abort on Failed Preview | `edit.streamingAbort` | boolean | — |
| Editing | Recover Inline Edit Payloads | `edit.recoverInlineEdits` | boolean | — |
| Editing | Block Auto-Generated Files | `edit.blockAutoGenerated` | boolean | — |
| Editing | Enforce Seen-Line Guard | `edit.enforceSeenLines` | boolean | — |
| Editing | Record Parse Regressions | `edit.blackbox.enabled` | boolean | — |
| Editing | Auto-Repair Parse Regressions | `edit.autoRepair.enabled` | boolean | — |
| Reading | Line Numbers | `readLineNumbers` | boolean | — |
| Reading | Default Read Limit | `read.defaultLimit` | number | — |
| Reading | Markdown Previews | `read.renderMarkdown` | boolean | — |
| Read Summaries | Read Summaries | `read.summarize.enabled` | boolean | — |
| Read Summaries | Prose Summaries | `read.summarize.prose` | boolean | — |
| Read Summaries | Read Summary Body Lines | `read.summarize.minBodyLines` | number | — |
| Read Summaries | Read Summary Comment Lines | `read.summarize.minCommentLines` | number | — |
| Read Summaries | Read Summary Minimum File Length | `read.summarize.minTotalLines` | number | — |
| Read Summaries | Read Summary Unfold Target | `read.summarize.unfoldUntil` | number | — |
| Read Summaries | Read Summary Unfold Ceiling | `read.summarize.unfoldLimit` | number | — |
| Reading | Inline Read Previews | `read.toolResultPreview` | boolean | — |
| LSP | LSP | `lsp.enabled` | boolean | — |
| LSP | Lazy LSP Startup | `lsp.lazy` | boolean | — |
| LSP | Shared Language Servers | `lsp.shared` | boolean | — |
| LSP | Format on Write | `lsp.formatOnWrite` | boolean | — |
| LSP | Diagnostics on Write | `lsp.diagnosticsOnWrite` | boolean | — |
| LSP | Diagnostics on Edit | `lsp.diagnosticsOnEdit` | boolean | — |
| LSP | Deduplicate Diagnostics | `lsp.diagnosticsDeduplicate` | boolean | — |

### Shell — 18 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Bash | Bash | `bash.enabled` | boolean | — |
| Bash | Allow Compound Commands | `bash.allowCompoundCommands` | boolean | — |
| Bash | Bash Auto-Background | `bash.autoBackground.enabled` | boolean | — |
| Bash | Git Guard | `bash.gitGuard` | boolean | — |
| Bash | Bash Approval Patterns | `bash.patterns` | array | — |
| Bash | Bash Interceptor | `bashInterceptor.enabled` | boolean | — |
| Bash | direnv Auto-Load | `bash.direnv` | enum | — |
| Bash | direnv Load Timeout (ms) | `bash.direnvLoadTimeoutMs` | number | — |
| Bash | Shell Minimizer | `shellMinimizer.enabled` | boolean | — |
| Bash | Shell Minimizer Source Outline | `shellMinimizer.sourceOutlineLevel` | enum | — |
| Eval & Runtimes | Python Eval Backend | `eval.py` | boolean | — |
| Eval & Runtimes | JavaScript Eval Backend | `eval.js` | boolean | — |
| Eval & Runtimes | Eval Environment Provisioning | `eval.autoProvision` | boolean | — |
| Eval & Runtimes | Eval-Defined Tools | `eval.tools.enabled` | boolean | — |
| Eval & Runtimes | Fresh Workpool Agents | `eval.workpool.freshAgents` | boolean | — |
| Eval & Runtimes | Eval Auto-Background | `eval.autoBackground.enabled` | boolean | — |
| Eval & Runtimes | Python Kernel Mode | `python.kernelMode` | enum | — |
| Eval & Runtimes | Python Interpreter | `python.interpreter` | string | — |

### Tools — 71 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Output Limits | Artifact Spill Threshold (KB) | `tools.artifactSpillThreshold` | number | — |
| Output Limits | Artifact Tail Size (KB) | `tools.artifactTailBytes` | number | — |
| Output Limits | Artifact Head Size (KB) | `tools.artifactHeadBytes` | number | — |
| Output Limits | Output Column Cap | `tools.outputMaxColumns` | number | — |
| Output Limits | Artifact Tail Lines | `tools.artifactTailLines` | number | — |
| Output Limits | Artifact File Cap (MB) | `tools.artifactMaxBytes` | number | — |
| Available Tools | Todos | `todo.enabled` | boolean | — |
| Todos | Todo Reminders | `todo.reminders` | boolean | — |
| Todos | Todo Reminder Limit | `todo.remindersMax` | number | — |
| Todos | Create Todos Automatically | `todo.eager` | enum | — |
| Todos | Todo Auto-Clear Delay | `tasks.todoClearDelay` | number | — |
| Available Tools | Glob | `glob.enabled` | boolean | — |
| Available Tools | Grep | `grep.enabled` | boolean | — |
| Grep & Browser | Grep Context Before | `grep.contextBefore` | number | — |
| Grep & Browser | Grep Context After | `grep.contextAfter` | number | — |
| Available Tools | AST Grep | `astGrep.enabled` | boolean | — |
| Available Tools | AST Edit | `astEdit.enabled` | boolean | — |
| Available Tools | Find (semantic grep) | `find.enabled` | enum | — |
| Available Tools | Debug | `debug.enabled` | boolean | — |
| Available Tools | Services | `launch.enabled` | boolean | — |
| Available Tools | Speech Generation | `speechgen.enabled` | boolean | — |
| Available Tools | Generate Image | `generate_image.enabled` | boolean | — |
| Available Tools | Computer | `computer.enabled` | boolean | — |
| Available Tools | Ratchet | `ratchet.enabled` | boolean | — |
| Available Tools | Archive | `archive.enabled` | boolean | — |
| Computer | Computer Display | `computer.display` | string | — |
| Computer | Computer Screenshot Width | `computer.maxWidth` | number | — |
| Computer | Computer Screenshot Height | `computer.maxHeight` | number | — |
| Execution | Image Question Timeout | `images.questionTimeoutMs` | number | — |
| Available Tools | Checkpoint/Rewind | `checkpoint.enabled` | boolean | — |
| Available Tools | Read URLs | `fetch.enabled` | boolean | — |
| Available Tools | Obsidian Vault | `vault.enabled` | boolean | — |
| Available Tools | GitHub CLI | `github.enabled` | boolean | — |
| GitHub | GitHub View Cache | `github.cache.enabled` | boolean | — |
| GitHub | GitHub Cache Soft TTL | `github.cache.softTtlSec` | number | — |
| GitHub | GitHub Cache Hard TTL | `github.cache.hardTtlSec` | number | — |
| Available Tools | Web Search | `web_search.enabled` | boolean | — |
| Available Tools | Security | `security.enabled` | boolean | — |
| Available Tools | Ask | `ask.enabled` | boolean | — |
| Execution | Intent Tracing | `tools.intentTracing` | boolean | — |
| Execution | Abort On Fabricated Tool Result | `tools.abortOnFabricatedResult` | boolean | — |
| Execution | Experimental Speculative Execution | `tools.speculativeExecution.enabled` | boolean | — |
| Execution | Speculative Execution Concurrency | `tools.speculativeExecution.maxInFlight` | number | — |
| Execution | Max Tool Timeout | `tools.maxTimeout` | number | — |
| Execution | Async Execution | `async.enabled` | boolean | — |
| Discovery & MCP | xd:// Tools | `tools.xdev` | boolean | — |
| Discovery & MCP | xd:// Prompt Docs | `tools.xdevDocs` | enum | — |
| Discovery & MCP | xd:// Inline Devices | `tools.xdevInlineDevices` | array | — |
| Developer | Auto QA | `dev.autoqa` | boolean | — |
| Developer | Auto QA Push Endpoint | `dev.autoqaPush.endpoint` | string | — |
| Extensions | Tool Call Handler Timeout (ms) | `extensionHandlers.toolCallTimeoutMs` | number | — |
| Available Tools | Browser | `browser.enabled` | boolean | — |
| Grep & Browser | Browser CDP URL | `browser.cdpUrl` | string | — |
| Grep & Browser | Browser Relay | `browser.relay` | boolean | — |
| Grep & Browser | Browser Relay URL | `browser.relayUrl` | string | — |
| Grep & Browser | Headless Browser | `browser.headless` | boolean | — |
| Grep & Browser | cmux Browser | `browser.cmux` | boolean | — |
| Grep & Browser | Tern Browser | `browser.tern` | boolean | — |
| Grep & Browser | Freeze Browser Tabs On Turn End | `browser.freezeOnTurnEnd` | boolean | — |
| Grep & Browser | Browser Idle Close Timeout | `browser.idleCloseSec` | number | — |
| Grep & Browser | Screenshot Directory | `browser.screenshotDir` | string | — |
| Available Tools | IDA Pro | `ida.enabled` | boolean | — |
| IDA Pro | IDA Python | `ida.python` | string | — |
| IDA Pro | IDA Install Dir | `ida.installDir` | string | — |
| IDA Pro | IDA Max Open Databases | `ida.maxOpen` | number | — |
| IDA Pro | IDA Idle Close Timeout | `ida.idleCloseSec` | number | — |
| Discovery & MCP | MCP Project Config | `mcp.enableProjectConfig` | boolean | — |
| Discovery & MCP | MCP Startup Window | `mcp.startupTimeoutMs` | number | — |
| Discovery & MCP | MCP Markdown Results | `mcp.renderMarkdownResults` | boolean | — |
| Discovery & MCP | MCP Update Injection | `mcp.notifications` | boolean | — |
| Discovery & MCP | MCP Notification Debounce | `mcp.notificationDebounceMs` | number | — |

### Tasks — 38 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Isolation | Isolate Subagents | `task.isolation.enabled` | boolean | — |
| Isolation | Isolation Backend | `isolation.backend` | enum | — |
| Isolation | Clone Checkout into Worktrees | `worktree.clone` | boolean | — |
| Isolation | Clean Source Checkout on /wt | `worktree.cleanSource` | boolean | — |
| Isolation | Worktree on Start | `worktree.onStart` | enum | — |
| Isolation | Worktree on Exit | `worktree.onExit` | enum | — |
| Isolation | Apply Isolated Changes | `task.isolation.apply` | boolean | — |
| Isolation | Isolation Merge Strategy | `task.isolation.merge` | enum | — |
| Isolation | Isolation Commit Style | `task.isolation.commits` | enum | — |
| Isolation | Worktree Base Directory | `worktree.base` | string | — |
| Subagents | Prefer Task Delegation | `task.eager` | enum | — |
| Subagents | Batch Task Calls | `task.batch` | boolean | — |
| Subagents | Speculative Task Launch | `task.speculativeLaunch` | boolean | — |
| Subagents | Per-Task Effort | `task.enableEffort` | boolean | — |
| Subagents | Max Concurrent Tasks | `task.maxConcurrency` | number | — |
| Subagents | LSP in Subagents | `task.enableLsp` | boolean | — |
| Subagents | Max Task Recursion | `task.maxRecursionDepth` | number | — |
| Subagents | Max Subagent Runtime | `task.maxRuntimeMs` | number | — |
| Subagents | Subagent Completion Probe | `task.completionProbe` | boolean | — |
| Subagents | Agent Idle TTL | `task.agentIdleTtlMs` | number | — |
| Subagents | Soft Subagent Request Budget | `task.softRequestBudget` | number | — |
| Subagents | Soft Request Budget Notice | `task.softRequestBudgetNotice` | boolean | — |
| Subagents | Maximum Per-Spawn Effort | `task.maxEffort` | enum | — |
| Subagents | Generic Task Prewalk | `task.prewalk` | boolean | — |
| Modes | Plan Mode | `plan.enabled` | boolean | — |
| Modes | Start in Plan Mode | `plan.defaultOnStartup` | boolean | planModeEnabled |
| Modes | Autosave Plans | `plan.autosave` | boolean | planModeEnabled |
| Modes | Autosave Directory | `plan.autosaveDir` | string | planAutosaveEnabled |
| Modes | Goal Mode | `goal.enabled` | boolean | — |
| Modes | Goal Status in Footer | `goal.statusInFooter` | boolean | — |
| Modes | Goal Continuation Modes | `goal.continuationModes` | array | — |
| Modes | Title Generator | `title.generator` | enum | — |
| Modes | Refresh Title on Replan | `title.refreshOnReplan` | boolean | — |
| Commands & Skills | Skill Commands | `skills.enableSkillCommands` | boolean | — |
| Commands & Skills | Claude User Commands | `commands.enableClaudeUser` | boolean | — |
| Commands & Skills | Claude Project Commands | `commands.enableClaudeProject` | boolean | — |
| Commands & Skills | OpenCode User Commands | `commands.enableOpencodeUser` | boolean | — |
| Commands & Skills | OpenCode Project Commands | `commands.enableOpencodeProject` | boolean | — |

### Providers — 41 settings

| Group | Label | Key | Type | Show condition |
|---|---|---|---|---|
| Services | Max In-Flight Requests | `providers.maxInFlightRequests` | record | — |
| Services | Codex Code Mode | `providers.openai-codex.codeMode` | enum | — |
| Services | Codex Code Mode Direct Tools | `providers.openai-codex.codeModeDirectTools` | array | — |
| Services | Ollama Cloud Max Concurrency | `providers.ollama-cloud.maxConcurrency` | number | — |
| Services | Web Search Timeout | `providers.webSearchTimeoutSeconds` | number | — |
| Services | Antigravity Endpoint Mode | `providers.antigravityEndpoint` | enum | — |
| Fireworks | Fireworks Tier | `providers.fireworksTier` | enum | — |
| Tiny Model | Tiny Model Device | `providers.tinyModelDevice` | enum | — |
| Tiny Model | Tiny Model Precision | `providers.tinyModelDtype` | enum | — |
| Protocol | Kimi API Format | `providers.kimiApiFormat` | enum | — |
| Protocol | OpenAI WebSockets | `providers.openaiWebsockets` | enum | — |
| Protocol | OpenAI Live Steering | `providers.openaiLiveSteering` | boolean | — |
| Protocol | Muse Code Stored Responses | `providers.muse-code.storeResponses` | boolean | — |
| Protocol | Prompt Cache Retention | `providers.cacheRetention` | enum | — |
| Protocol | Cache Warming | `providers.cacheWarming` | enum | — |
| Timeouts | Stream First Event Timeout | `providers.streamFirstEventTimeoutSeconds` | number | — |
| Timeouts | Stream Idle Timeout | `providers.streamIdleTimeoutSeconds` | number | — |
| Protocol | OpenRouter Routing | `providers.openrouterVariant` | enum | — |
| Services | Fetch Provider | `providers.fetch` | enum | — |
| Services | Codex Auto-Redeem Saved Resets | `codexResets.autoRedeem` | enum | — |
| Services | Codex Auto-Redeem Min Block | `codexResets.minBlockedMinutes` | number | — |
| Services | Codex Auto-Redeem Reserve | `codexResets.keepCredits` | number | — |
| Services | Codex Reset Salvage Horizon | `codexResets.salvageHorizonHours` | number | — |
| Services | Claude Auto-Redeem Resets | `claudeResets.autoRedeem` | enum | — |
| Services | Claude Auto-Redeem Min Block | `claudeResets.minBlockedMinutes` | number | — |
| Services | Claude Auto-Redeem Reserve | `claudeResets.keepCredits` | number | — |
| Services | Claude Reset Salvage Horizon | `claudeResets.salvageHorizonHours` | number | — |
| Protocol | Append-Only Context | `provider.appendOnlyContext` | enum | — |
| Services | Exa | `exa.enabled` | boolean | — |
| Services | Exa Search Delay | `exa.searchDelayMs` | number | — |
| Services | SearXNG Endpoint | `searxng.endpoint` | string | — |
| Privacy | Hide Secrets | `secrets.enabled` | boolean | — |
| Services | Local TTS Voice | `tts.localVoice` | enum | — |
| Services | Local TTS Speed | `tts.localSpeed` | number | — |
| Services | Speech Vocalization | `speech.enabled` | boolean | — |
| Services | Speech Vocalization Mode | `speech.mode` | enum | — |
| Services | Enhanced Speech Rewriting | `speech.enhanced` | boolean | — |
| Services | Speech Vocalization Voice | `speech.voice` | enum | — |
| Services | Speech Vocalization Speed | `speech.speed` | number | — |
| Services | Live Voice | `live.voice` | enum | — |
| Privacy | OTLP Telemetry Export | `telemetry.otlpExportEnabled` | boolean | — |


## 39.8 UI mechanics we should extract

- Persistent workspace and session editor draft even when modals open, keyboard mode changes, provider discovery returns late, or a task finishes.
- Fullscreen model browser with kind/provider/roles sidebar and fuzzy list; compact session-only Alt+P-style overlay for quick switching. Search and selection must not start a network request until explicit refresh/choose or known bounded discovery policy.
- Role-binding UI with explicit global/project storage and role-specific fallback chain. Surface whether a fallback is free, API-billed, subscription-proxy, trial or unknown; separate advertised pricing from observed billing/quota.
- Provider account flow: login/OAuth where supported; API key secret reference; local/keyless endpoint; model discovery refresh; auth/health state and last check; permission to switch actual endpoint. Never render raw token.
- All settings in one schema-derived list, search across tabs, tab icons, live help, revertible preview, reset-to-default, current/source/shadowed value, pending apply boundary, immutable Run lock and reason.
- Goal objective modal preserving the draft; preview explicit acceptance criteria, workspace scope and budgets; prepare/clarify/approve before activation, then pause/resume/revise/cancel with Rust-owned durable receipts.
- Icon theme fallback Unicode/Nerd/ASCII; respect grapheme width, keyboard controls, screen-reader descriptions, high-contrast and narrow terminals.
- Plugin marketplace/skills/MCP/provider tabs as searchable, status-driven panels; third-party contributions namespaced and policy-filtered.
- No deep copy of OMP's UI renderer, JSONL session store or credential logic; Horizon remains OpenCode/OpenTUI/Solid + canonical Core Session + Rust Guard.

## 39.9 Limits, confidence and links

Upstream absolute source base: https://github.com/can1357/oh-my-pi/tree/eec114a9226da698ebc015fd8996a8ca3bc4625c. Code blocks/metadata scanned, but no test run establishes that all 85 commands are active in one session or all 409 declarations can be surfaced in a running terminal. Any additional installed plugin commands or provider models are dynamic and not counted. Model quality/speed/prices in supplied screenshot are not independently verified.

Proposed adaptation and actual Horizon target owners: [§40 — OMP-inspired Horizon UX design proposal](40-HORIZONCODE-OMP-INSPIRED-UI-PROPOSAL.md). **§40 is non-normative until reviewed and adopted through Horizon §17 governance.**

## 39.10 Exact static provider source roster — not proof of enabled providers

The pinned source registry at packages/coding-agent/src/web/search/provider.ts declares **20 pure search-engine adapters**:

perplexity, zai, exa, tinyfish, jina, kagi, tavily, firecrawl, brave, kimi, parallel, synthetic, ollama, searxng, duckduckgo, google, ecosia, startpage, mojeek, public.

Separately, it declares **six model-grounded web search backends**: gemini, anthropic, codex, xai, openrouter, openai. These are different paths and credential semantics; none implies every endpoint is free, that network scraping always works, or that fallback is authorized.

The catalog source has **92 provider-rule .kdl files** under packages/catalog/src/compat/rules/providers, including some behavior/pseudoprovider rule entries. This is NOT '92 live usable providers'. Provider availability is conditional on config, credentials, account, allowed endpoints and runtime health. Source-derived model kinds number ten: chat, tiny, image, tts, stt, search, judge, embedding, rerank, video.

The exact 92 source rule names/paths, provider IDs, and type entries are in [omp-provider-source-roster.json](omp-provider-source-roster.json). Horizon provider hub should distinguish model API provider, model role, harness agent, local engine, search-provider backend and third-party extension, with a clear auth/cost/trust path for each.
