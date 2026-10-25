# Claude Code v2.1.310 — Exhaustive Architecture Reconstruction

**Purpose:** behaviour reference for HorizonCode. This document reconstructs Claude Code's
externally observable architecture — process boundaries, contracts, state ownership, execution
flows — from public documentation, the published Agent SDK type surface, and black-box CLI
observation. It is **not** a source reconstruction and contains **no** Claude Code source,
minified bundle content, or prompt text.

**Observed target:** `claude 2.1.310 (Claude Code)`, npm package `@anthropic-ai/claude-code@2.1.310`,
SDK `@anthropic-ai/claude-agent-sdk@0.3.310` (`claudeCodeVersion: 2.1.310`), platform `linux-x64`,
commit `0d2056ecf42d`.

**Evidence tags used throughout**

| Tag | Meaning |
|---|---|
| `[DOC]` | Stated in the official documentation corpus `repo_take/re-sandbox/claude-code/docs/llms-full.txt` (9,735,009 bytes, 231 documents, split into `docs/split/*.md`) |
| `[SDK]` | Declared in the published TypeScript types `@anthropic-ai/claude-agent-sdk/sdk.d.ts` (10,302 lines) or `sdk-tools.d.ts` (4,222 lines) |
| `[OBS]` | Observed by running the sandboxed CLI with no credentials (`repo_take/re-sandbox/claude-code/obs/*`) |
| `[UNV]` | Not established; see §8 |

A claim may carry two tags when documentation and observation agree; where they disagree the
disagreement is called out explicitly (see §3.1.4).

---

## 1. Provenance

| # | Source | What it yielded | Tag | Notes |
|---|---|---|---|---|
| P1 | `docs/llms-full.txt` → 231 per-document files | CLI/flags, settings (247 keys), hooks (33 events), permissions, sandbox, MCP, sessions, checkpoints, compaction, memory, plugins, skills, subagents, SDK guides, telemetry, enterprise policy | `DOC` | Primary source. Every normative statement below cites a doc slug where useful. |
| P2 | `docs/llms.txt` (63,682 B) | Document index and product surface map (desktop, web, mobile, Slack, CI, gateway, self-hosted runner) | `DOC` | Used to bound scope: many surfaces are cloud/paid and out of HorizonCode V1 scope. |
| P3 | `@anthropic-ai/claude-agent-sdk@0.3.310` `sdk.d.ts` | 261 exported declarations: `Options` (~140 fields), `Query`, `Transport`, 39-variant `SDKMessage` union, 33 `HOOK_EVENTS`, 54 `BUILTIN_TOOL_NAMES`, hook I/O types, permission types, MCP config types, `SandboxSettings` Zod schema, control-request union (44 request subtypes), session-store API | `SDK` | Types only. No implementation read. |
| P4 | `sdk-tools.d.ts` | Per-tool input/output Zod schemas for the built-in tool set | `SDK` | Used for tool-contract shape, not reproduced. |
| P5 | `@anthropic-ai/claude-code@2.1.310` `package.json`, `bin/claude.exe`, `sdk-tools.d.ts` | Distribution model: native per-platform binary via optional deps; no JS entry point; Node ≥22 | `OBS` (metadata) | Confirms the product is a compiled native binary, which bounds what black-box observation can reveal. |
| P6 | `claude --version`, `claude --help`, `claude <sub> --help` ×14 | Full flag list, 22 subcommands, per-subcommand flags | `OBS` | Saved in `obs/help.txt`, `obs/subcommands.txt`. |
| P7 | `claude doctor` | Install health, update channel, managed-settings fetch state, Remote Control eligibility, "No installation issues found" | `OBS` | Read-only; requires no auth. |
| P8 | `claude -p ... --output-format json` / `stream-json` (unauthenticated) | Real `result` envelope, real `system/init` envelope, `assistant` error frame, `terminal_reason: api_error`, exit code 0 with `is_error: true` | `OBS` | No paid call: fails closed at auth. |
| P9 | Created state under sandboxed `$HOME` | `~/.claude/projects/<project>/<session>.jsonl`, `~/.claude.json`, `~/.claude/backups/`, `~/.claude/sessions/`, `~/.claude/skills/` | `OBS` | Transcript record taxonomy in §4.5. |
| P10 | Public GitHub (`anthropics/claude-code`) | Changelog is mirrored in the doc corpus (`docs/split/changelog.md`, 12,149 lines) and was used only for version-gating facts | `DOC` | No repo source read. |

### 1.1 Corpus statistics (for coverage claims)

| Metric | Value |
|---|---|
| Documents in `llms-full.txt` | 231 |
| Lines in `llms-full.txt` | 123,638 |
| Settings keys indexed | 247 |
| Hook events | 33 — the documentation lifecycle table and the SDK `HOOK_EVENTS` tuple enumerate the identical set (incl. `Setup`) |
| Built-in tool names (SDK 0.3.310) | 54 |
| SDK message variants | 39 |
| CLI subcommands in `--help` | 18 (+3 documented only: `daemon`, `remote-control`, `self-hosted-runner`) |
| CLI option entries in `--help` | 66 |

### 1.2 Deliberately not done

- No reading, unminifying, decompiling, or diffing of `sdk.mjs` / `bridge.mjs` / `core-*.mjs` / `bin/claude.exe`.
- No reproduction of system-prompt text, tool descriptions, or any prompt asset, even where it is
  visible in an observed `api-request-shape` transcript record. Structure only is reported (§3.12.5).
- No authentication, no API key, no paid request, no upload of any artefact.
- No Git operations.

---

## 2. High-level design

### 2.1 Deployment shapes and process boundaries

Claude Code is a **single native binary** (`bin/claude.exe`, per-platform optional deps) that runs
an agent loop in-process and spawns child processes for effects. `[OBS]` `[DOC]`

| Boundary | What runs there | Evidence |
|---|---|---|
| **CLI process (in-process)** | Agent loop, context assembly, permission evaluation, hook dispatch, tool registry, MCP client, transcript writer, TUI renderer | `[DOC]` + `[SDK]` `Transport` doc-comment distinguishes "ProcessTransport" from "in-process engine surface" |
| **Child processes** | Bash/PowerShell commands, `Monitor` watches, stdio MCP servers, LSP servers, hook commands, plugin monitors, plugin-provided MCP servers, background shell jobs | `[DOC]` sandboxing §"What runs outside the sandbox" |
| **Sandboxed child processes** | Bash/PowerShell/Monitor commands under Seatbelt (macOS) or bubblewrap (Linux/WSL2), with an out-of-process HTTP/SOCKS proxy | `[DOC]` sandboxing §"OS-level enforcement" |
| **Supervisor daemon** | `claude daemon` — one background service hosting each *background session* as its own Claude Code process; socket dir, `roster.json`, per-job `state.json` | `[DOC]` agent-view §"The supervisor process" |
| **IDE / SDK host** | VS Code/JetBrains extension, Desktop app, Agent SDK applications — drive the same binary over a control protocol (`control_request`/`control_response`) instead of a TTY | `[DOC]` hooks "sessions where it sends permission requests to the Agent SDK's `canUseTool`"; `[SDK]` `Transport`, `Query` control methods |
| **Anthropic API / provider** | Model inference only. No tool execution server-side. | `[DOC]` |
| **Anthropic-hosted services (optional, paid/cloud)** | Cloud sessions (VM), Remote Control relay, artifacts publishing, cloud scheduled tasks, Code Review, usage-credit billing | `[DOC]` |
| **LLM/Claude apps gateway (self-hosted)** | `claude gateway --config gateway.yaml` — enterprise SSO/policy/spend in front of Bedrock/Vertex/Foundry | `[OBS]` `claude gateway --help`; `[DOC]` gateway docs |

**Key structural fact:** the *same* hook events, permission modes, tool names, and skill/subagent
formats apply across terminal, IDE, Desktop, and cloud sessions. `[DOC]` (hooks reference, opening
paragraph). The harness is one implementation with many front-ends, not per-surface reimplementations.

### 2.2 In-process component map (reconstructed)

```
┌──────────────────────────── CLI process ─────────────────────────────┐
│                                                                       │
│  Front-ends: TUI │ headless(-p) │ stream-json │ SDK bridge │ IDE      │
│        │              │               │            │         │        │
│        └──────────────┴───────┬───────┴────────────┴─────────┘        │
│                               ▼                                       │
│   SessionRuntime ── transcript writer ──► ~/.claude/projects/*.jsonl  │
│        │  │  │                                                        │
│        │  │  └── CheckpointStore ──► ~/.claude/file-history/<sess>/   │
│        │  └───── ContextAssembler (system prompt + memory + skills +  │
│        │         tool schemas + history; compactor; prompt cache)     │
│        ▼                                                              │
│   AgentLoop (turn = 1..n model round-trips)                           │
│        │                                                              │
│        ├── ToolScheduler (batch, parallel read-only / serial writers) │
│        │        │                                                     │
│        │        ├── PermissionEngine (mode + allow/ask/deny + hooks)  │
│        │        │        └── auto-mode classifier (extra model call)  │
│        │        ├── HookDispatcher (33 events, 5 handler kinds)       │
│        │        └── Tool implementations ──► child processes          │
│        │                                                              │
│        ├── SubagentRuntime (Agent tool, depth/concurrency limits)     │
│        ├── SkillRegistry / CommandRegistry / PluginLoader             │
│        ├── McpClientPool (v1/v2 runtime, tool search, OAuth)          │
│        └── TelemetrySink (OTel metrics/events/traces)                 │
└───────────────────────────────────────────────────────────────────────┘
```

This map is inferred from the documented behaviours and the SDK's `Query` control surface; component
*names* are descriptive, not Claude Code internal identifiers. `[DOC]` `[SDK]`

### 2.3 State ownership

| State | Owner | Location | Format | Mutability |
|---|---|---|---|---|
| Conversation transcript | Session runtime (single writer per session) | `~/.claude/projects/<project>/<session-id>.jsonl` | JSONL, append-only-ish | Internal & unstable `[DOC]` |
| Session list / names / PR links | Session index | same tree + `~/.claude.json` project entry | derived | `[DOC]` |
| App state, account, trust, MCP local/user scope, global config | Global config | `~/.claude.json` (+ rotating `backups/`) | JSON | Written by CLI |
| User settings | User | `~/.claude/settings.json` | JSON (strict) | User + `/config` |
| Shared project settings | Repo | `.claude/settings.json` | JSON | Committed |
| Local project settings | Repo (gitignored) | `.claude/settings.local.json` at **git root** | JSON | User + "don't ask again" |
| Managed policy | Org | `managed-settings.json`, MDM/plist/HKLM, server-managed, `policyHelper` | JSON | Admin |
| File checkpoints | Checkpoint store | `~/.claude/file-history/<session>/` | snapshots, 100 checkpoints | Auto |
| Plan files | Plan mode | `~/.claude/plans/` or `plansDirectory` | Markdown | Model |
| Tasks | Task tools | `~/.claude/tasks/` | one dir per list | Model |
| Shell aliases/functions snapshot | Bash tool | `~/.claude/shell-snapshots/` | shell script | Auto |
| Auto memory | Memory | `~/.claude/projects/<project>/memory/MEMORY.md` | Markdown | Model |
| Subagent memory | Subagent | `~/.claude/agent-memory/<agent>/`, `.claude/agent-memory/<agent>/`, `.claude/agent-memory-local/<agent>/` | Markdown | Subagent |
| Plugin installs | Plugin manager | `~/.claude/plugins/` + `installed_plugins.json` | JSON + copies | CLI |
| Background sessions | Supervisor | `~/.claude/daemon/roster.json`, `~/.claude/jobs/<id>/state.json` | JSON | Supervisor |
| Credentials | Auth | `.credentials.json` or OS keychain/helper | secret | Auth flows |
| Debug logs | Debug | `~/.claude/debug/<session-id>.txt` | text | `--debug` |
| Scratchpad | Session | temp dir `.../<session>/scratchpad/` | files | Model, no prompt |

`[DOC]` claude-directory reference + agent-view §"Where state is stored" + `[OBS]` (subset created
during an unauthenticated run).

**Notable ownership property:** every session is a *file-per-session* JSONL with no cross-process
lock beyond "two terminals on the same session interleave messages into one transcript" `[DOC]`.
There is no durable Run/Task/Attempt authority, no lease, and no receipt — completion is whatever
the last transcript record says.

### 2.4 Security layering

Four independent layers, each enforced at a different point `[DOC]`:

1. **Permission rules + mode** — decided *before* a tool runs, by tool name + arguments.
2. **Hooks** — also before/after a tool; can deny, allow, rewrite input, rewrite output. **Cannot
   override a deny or ask rule** (deny-first precedence).
3. **Sandbox** — enforced *by the OS* on the running shell process tree (filesystem + network).
4. **Outer isolation** — container/VM/sandbox-runtime wrapping the whole Claude Code process,
   the only layer that also contains MCP servers, hooks, and file tools.

Documented explicitly: permissions are not a security boundary for shell text ("a deny or ask rule
covers the invocation Claude usually produces and isn't a security boundary around the program"),
and the sandbox is "not a complete isolation boundary" (no TLS inspection by default; domain
fronting possible). `[DOC]`

### 2.5 Extension points (7)

| # | Extension | Loaded from | Authority |
|---|---|---|---|
| 1 | Settings | 4 scopes + managed | config |
| 2 | Hooks | settings, plugins, skills, subagents, managed | can block/rewrite |
| 3 | Skills/commands | `.claude/skills`, `.claude/commands`, plugins, managed, claude.ai sync | prompt + tool pre-approval |
| 4 | Subagents | `.claude/agents`, `~/.claude/agents`, `--agents`, plugins, managed | delegated reasoning, narrowed tools |
| 5 | MCP servers | `.mcp.json`, `~/.claude.json`, `--mcp-config`, plugins, managed, claude.ai connectors | external tools |
| 6 | Plugins | marketplaces, `--plugin-dir`, `--plugin-url`, skills-dir | bundles 1–5 + LSP + monitors + themes |
| 7 | Mods (research preview) | plugins, in-process JS with UI | runs **in** the Claude Code process |

`[DOC]` features-overview / plugins / mods.

---

## 3. Low-level design per subsystem

### 3.1 CLI and headless protocol

#### 3.1.1 Command surface `[OBS]`

18 subcommands appear in `--help`; the documentation adds `daemon` (`logs|run|status|stop`),
`remote-control`, and `self-hosted-runner`, for 21 total. `[OBS]` `[DOC]` Observed in `--help`:
`agents`, `attach`, `auth`, `auto-mode`, `doctor`, `gateway`, `import`, `install`, `logs`, `mcp`,
`plugin|plugins`, `purge`, `respawn`, `rm`, `setup-token`, `stop|kill`, `ultrareview`,
`update|upgrade`.

Exit-code contract `[DOC]`: `0` success; non-zero on run failure; `auth status` exits `0`/`1` for
logged-in/out; `ultrareview` exits `0`/`1`; SIGTERM → **143** with the in-flight turn left unfinished
and no result recorded.

#### 3.1.2 Print-mode I/O matrix `[DOC]` `[OBS]`

| `--input-format` | `--output-format` | Behaviour |
|---|---|---|
| `text` (default) | `text` (default) | prompt from argv + stdin (≤10 MB), plain text out |
| `text` | `json` | one JSON object: `result`, `session_id`, `usage`, `modelUsage`, `total_cost_usd`, `permission_denials`, `structured_output?` |
| `text` | `stream-json` | NDJSON: `system/init`, `assistant`, `user`, `stream_event` (with `--include-partial-messages`), `result` |
| `stream-json` | `stream-json` | realtime bidirectional; `--replay-user-messages` echoes user frames; queued messages fold into turns |

Hard requirements: `--include-partial-messages`, `--include-hook-events`, `--forward-subagent-text`,
`--prompt-suggestions`, `--replay-user-messages` all require `--print` + `stream-json` (and
`--verbose` for two of them). `[DOC]` `[OBS]`

#### 3.1.3 Flag surface: `--help` is not authoritative

- 12 flags documented in the corpus are **absent** from `--help` (verified by grep + help diff):
  `--advisor`, `--append-subagent-system-prompt`, `--append-subagent-system-prompt-file`,
  `--append-system-prompt-file`, `--system-prompt-file`, `--init`, `--init-only`, `--maintenance`,
  `--permission-prompt-tool`, `--dangerously-load-development-channels`, `--teammate-mode`,
  `--channels`. `[DOC]` `[OBS]`
- 2 flags in `--help` appear **nowhere** in the 9.7 MB corpus: `--brief` ("Enable SendUserMessage
  tool for agent-to-user communication") and `--file <specs...>`
  (`file_id:relative_path` download-at-startup). `[OBS]`
- The docs state this explicitly: "`claude --help` does not list every flag, so a flag's absence
  from `--help` does not mean it is unavailable." `[DOC]`

Design consequence: a compatibility layer must be driven by the *doc corpus + SDK types*, not by
`--help` scraping.

#### 3.1.4 Documentation/observation disagreements found

| Claim | Doc | Observed |
|---|---|---|
| `--permission-mode` choices | `default`, `acceptEdits`, `plan`, `auto`, `dontAsk`, `bypassPermissions`, `manual` (alias of `default`) | help + validator list `acceptEdits, auto, bypassPermissions, manual, dontAsk, plan` — **`default` omitted from the choice list but documented as accepted** |
| Default model | alias-based examples (`claude-sonnet-5`, `claude-opus-5-5`) | unauthenticated `system/init` reported `"model":"claude-opus-5-5"` |
| `--brief`, `--file` | absent | present |

`[DOC]` `[OBS]`

#### 3.1.5 Headless-only limits `[DOC]`

- `--bare`: skips hooks, LSP, plugin sync, attribution, auto-memory, keychain reads, CLAUDE.md
  discovery; auth only via `ANTHROPIC_API_KEY` or `apiKeyHelper`; skills still resolve; no system
  reminders; no background tasks. Documented as the **recommended** mode for scripts and the
  **future default** for `-p`.
- `--max-turns`: counts tool-use round-trips; a message queued at the limit starts a *new* turn with
  its own budget.
- `--max-budget-usd`: checked **after** each model response arrives, so spend can overshoot by one
  response plus running subagent spend; `error_max_budget_usd` result.
- `--permission-prompts none`: denies everything that would prompt, removes person-only tools
  (`AskUserQuestion`), cancels unanswered MCP elicitations.
- Post-result waiting: a `-p` run stays open for background commands/subagents/workflows/monitors/
  loop wakeups; 10-minute idle ceiling (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`), except a
  main-conversation background command keeps it open until exit.
- SIGTERM: exit 143, kill the command process tree, run `SessionEnd` hooks, start nothing new.

### 3.2 Settings and configuration resolution

#### 3.2.1 Files and precedence `[DOC]`

```
managed settings            (highest; MDM / plist / HKLM / managed-settings.json /
                             server-managed / policyHelper / parent via SDK managedSettings)
  └── command line          (--settings <file|json>, ≤2 MiB, regular file only)
        └── project local   (.claude/settings.local.json — at git root, not cwd)
              └── shared project (.claude/settings.json — at primary working directory)
                    └── user  (~/.claude/settings.json)
```

- **Lists merge, scalars override.** `permissions.allow`/`deny`/`ask` and `additionalDirectories`
  union across scopes. Four exceptions take the whole value from the highest source:
  `fallbackModel`, `modelPicker`, `availableModels` (under managed), `modelSettings`.
- **Security exceptions**: 10 keys honour a *stricter* value from a lower scope even against managed
  (`disableClaudeAiConnectors`, `enableArtifact`, `isolatePeerMachines`,
  `permissions.blockReadsOutsideWorkingDirectories`, `autoMode.classifyAllShell`,
  `remoteControlAtStartup`, `crossSessionInbound`, `useAutoModeDuringPlan`, `syncClaudeAiSkills`,
  `syncClaudeAiPlugins`, `maxEffortLevel`).
- **Environment variables are not a level.** Each key/variable pair decides independently
  (`ANTHROPIC_MODEL` beats any file's `model`; `ANTHROPIC_DEFAULT_MODEL` only fills a gap).
- **Live reload**: settings files are watched; edits to `permissions`, `hooks`, `apiKeyHelper` apply
  mid-session and fire `ConfigChange`. `model`, `effortLevel`, `modelSettings` are read once.
- **Strict JSON**: comments and trailing commas are errors; broken file → `Settings Error` dialog
  (interactive) or silent skip (`-p`); per-entry problems → `Settings Warning` + rest of file applies.
- `$schema` = `https://json.schemastore.org/claude-code-settings.json` (may lag releases).

#### 3.2.2 Settings inventory

247 indexed keys, grouped by topic in `docs/split/settings-reference.md` §"Settings index":
model/responses (22), permissions (9), sandbox (44), memory/context (12), interface/terminal (44),
git/attribution (7), hooks/automation (9), plugins/skills (20), MCP (9), agents/sessions/worktrees
(13), remote/desktop/notifications (14), auth/providers (11), updates (4), tools (3),
privacy/telemetry (5), enterprise/managed (10), global config (`~/.claude.json`) (10). `[DOC]`

Every key declares a **Scope** (`Any file` / `User` / `Managed` / `Global config` / …). This scope
column is the interesting part: it is an explicit capability-placement policy, e.g.
`sandbox.filesystem.disabled` is `User or managed`; `permissions.defaultMode` is `Any file` but the
values `auto` and `bypassPermissions` are ignored from project/local files. `[DOC]`

#### 3.2.3 Where each file is read from (subtle) `[DOC]`

- `.claude/settings.json`: primary working directory (moves with `/cd`).
- `.claude/settings.local.json`: **git repository root**, not cwd (v2.1.211+), with exceptions when
  outside git, when root is `$HOME`, on Windows, or when `.git`/`.claude` isn't owned by the user.
- `.claude/agents`, `.claude/skills`, `.claude/commands`: discovered by walking **up** from cwd to
  repo root; subdirectory skill dirs load lazily on first file touch there.
- Permission-rule path anchors (`/path`) resolve against the *settings source*, not the filesystem:
  project/local/CLI → primary working directory; user → `~/.claude/path`; `--settings file` → the
  file's directory.

### 3.3 Permission engine

#### 3.3.1 Modes `[DOC]`

| Mode | Auto-runs | Notes |
|---|---|---|
| `default` (UI: Manual) | reads only | read-only command set + in-workspace reads |
| `acceptEdits` | reads, file edits, common FS commands (`mkdir`,`touch`,`mv`,`cp`) | |
| `plan` | reads; classifier-reviewed commands when auto available | edits blocked until plan approval |
| `auto` | everything, with a model classifier reviewing | built-in default in interactive terminal since 2.1.283 |
| `dontAsk` | in-workspace reads + pre-approved tools; everything else **denied** | CI mode |
| `bypassPermissions` | everything except the never-auto list | requires container/VM per docs |

**Never auto-approved in any mode**: explicit `ask` rules; org-`ask` connector tools; tools requiring
user interaction (`AskUserQuestion`, MCP `requiresUserInteraction`); recognised `rm`/`rmdir`
critical-path removals; cross-session messaging safeguards; reads outside working directories when
`permissions.blockReadsOutsideWorkingDirectories` is on. `[DOC]`

**Protected paths** (writes never auto-approved except `bypassPermissions` / plan-with-bypass):
`.git`, `.config/git`, `.vscode`, `.idea`, `.husky`, `.cargo`, `.devcontainer`, `.yarn`, `.mvn`,
`.claude` (with exceptions for its own worktrees/plans/scratch/memory), plus a file list
(`.gitconfig`, shell rc files, `.npmrc`, `.mcp.json`, `.claude.json`, wrapper properties, …).
`permissions.allow` rules **do not** pre-approve protected-path writes — the check runs before allow
rules. `[DOC]`

**Critical paths**: `rm`/`rmdir` against filesystem root, top-level dirs, `$HOME`, drive roots,
working directory and its parents, `/*` under additional dirs, variable-expansion hazards
(`"$DIR"/*`, `$(pwd)`, `-c` inline scripts), mounted drives (`/mnt/c`, `/Volumes/*`, `/media/*`,
`/run/media/*`). No allow rule and no `PreToolUse allow` can approve one. In `auto`/`bypass` the
terminal prompt has a 2-minute countdown, and after three timeouts the session stops prompting.
`[DOC]`

#### 3.3.2 Rule grammar `[DOC]`

```
Rule        := ToolName | ToolName "(" specifier ")"
ToolName    := literal | glob            (deny/ask only; allow globs need mcp__<server>__ prefix)
specifier   := Bash/PowerShell command pattern
             | gitignore-style path pattern        (Read/Edit/Grep/Glob/LSP)
             | "domain:" host-pattern              (WebFetch)
             | "param:value"                       (deny/ask only, any built-in scalar input)
             | skill name                          (Skill)
             | agent type                          (Agent)
```

Matching semantics that matter for reimplementation:

- **Bash**: whole command text; `*` matches any text; `:*` ≡ ` *`; trailing-` *` also matches the
  bare command; the space is significant (`Bash(ls *)` ≠ `lsof`, `Bash(ls*)` = `lsof`).
  Compound commands split on `&& \|\| ; \| \|& & \n` and **each subcommand must match**; a trailing
  operator with nothing after it makes the command unparseable → no allow match. Wrappers stripped
  before matching: `timeout time nice nohup stdbuf command builtin noglob` and bare `xargs`.
  Known-safe leading env assignments stripped for allow; any assignment stripped for deny/ask.
  Exec wrappers (`watch setsid ionice flock`) and `find` with `-exec/-delete/-fprint/-files0-from`
  never auto-approve from a prefix rule. Read-only command set is built-in and not configurable.
- **Paths**: gitignore syntax; four anchors `//abs`, `~/home`, `/settings-source`, `rel|cwd`;
  `*` within one segment, `**` across; single-segment dir patterns are depth-sensitive by rule type
  (allow = anchored, deny/ask = any depth); `!` negation carves out **only within the same source**.
  Symlinks: allow needs both requested and resolved path to match; deny matches either.
  `Write()`, `NotebookEdit()`, `Glob()`, `MultiEdit()` path rules **never match** — only `Edit()` and
  `Read()` path rules are consulted.
- **Redirections**: `>`, `>>`, `2>`, `<`, and `tee` targets are checked as if the model wrote/read
  that file, against Edit/Read rules + protected paths + working dirs.
- **Precedence**: `deny` (any scope) > `ask` (any scope) > `allow` (merged); hooks cannot flip a
  deny or an ask; a *blocking* hook (exit 2) beats an allow rule.

#### 3.3.3 Decision pipeline (reconstructed order)

```
tool call
  → PreToolUse hooks (parallel)            ─ can deny (exit 2 / permissionDecision), rewrite input, or "allow" (still subject to deny/ask)
  → deny rules                             ─ DENY (terminal)
  → ask rules                              ─ prompt (even if hook said allow)
  → protected-path check                   ─ prompt/classifier/deny by mode
  → critical-path rm check                 ─ prompt/deny by mode (never approvable by allow)
  → permission mode                         ─ auto-admit / auto-deny
  → allow rules                             ─ auto-admit
  → auto-mode classifier (if mode=auto)     ─ allow/deny; may fall back to prompt with limits
  → PermissionRequest hook                  ─ allow/deny + updatedInput + updatedPermissions
  → interactive prompt / canUseTool / --permission-prompt-tool / deny if nobody can answer
  → tool executes
  → PostToolUse / PostToolUseFailure hooks  ─ may rewrite output or inject context
  → PostToolBatch (after whole parallel batch)
```

`[DOC]` (permissions §"Extend permissions with hooks", hooks §"Decision control", permission-modes).
The exact total order of the classifier vs. mode vs. allow rules is documented only in prose; the
sequence above is the documented precedence, not an observed trace. `[DOC]` `[UNV]` for internals.

#### 3.3.4 Permission updates as data `[SDK]` `[DOC]`

```ts
type PermissionUpdate =
  | { type:'addRules'|'replaceRules'|'removeRules'; rules: {toolName, ruleContent?}[];
      behavior: 'allow'|'deny'|'ask'; destination: Destination }
  | { type:'setMode'; mode: PermissionMode; destination: Destination }
  | { type:'addDirectories'|'removeDirectories'; directories: string[]; destination: Destination };

type Destination = 'userSettings'|'projectSettings'|'localSettings'|'session'|'cliArg';
```

This is the mechanism behind "Yes, and don't ask again": the prompt returns a *rule diff*, not a
boolean. Hooks (`PermissionRequest.updatedPermissions`) and SDK `canUseTool(_,_,{suggestions})` share
the same type.

### 3.4 Sandbox

#### 3.4.1 Mechanism `[DOC]`

| Platform | Primitive |
|---|---|
| macOS | Seatbelt (`sandbox-exec`-class policy) |
| Linux / WSL2 | bubblewrap (+ `socat` for the proxy) |
| Windows | unsupported → WSL2 or container |

- **Filesystem**: default read = whole machine (minus deny list); default write = cwd + additional
  dirs + per-user temp dir; worktree sessions additionally get the main repo's shared `.git` (but
  not `hooks/` or `config`).
- **Protected-path denies inside the sandbox** are a *second*, separate list from the permission
  system's: `.claude/settings*`, `.claude/{skills,agents,commands,hooks}`, `.mcp.json`,
  `.claude/workflows`, `.claude/scheduled_tasks.json`, shell rc files, `.gitconfig`, `.vscode`,
  `.idea`, `.git/{hooks,config}`, bare-repo bait (`HEAD`, `objects`, `refs`), `~/.claude/**`,
  `~/.claude.json`, `.credentials.json`.
- **Network**: no direct route. Linux → separate netns; macOS → Seatbelt blocks all but the proxy.
  Commands get `HTTP_PROXY/HTTPS_PROXY/ALL_PROXY` pointed at an out-of-process proxy that matches the
  **client-supplied hostname** against allow/deny lists. No TLS termination by default (opt-in
  `network.tlsTerminate` with CA/key). Loopback/link-local resolutions are refused unless the name is
  `localhost`/`*.localhost` or the IP is explicitly allowed. UDP/QUIC/ICMP cannot leave.
- **Credential masking** (`sandbox.credentials`): `files[]`/`envVars[]` with `mode: deny|mask`,
  `extract`, `decode: jwt`, `maskClaims`, `injectHosts`, plus AWS pair linking and SigV4 re-signing.
  `mask` requires `tlsTerminate`.
- **Escape hatch**: `dangerouslyDisableSandbox: true` on a Bash call retries outside the sandbox,
  gated by mode (bypass=allow, manual/acceptEdits=prompt, auto=classifier, dontAsk=deny).
  `allowUnsandboxedCommands:false` = strict mode; `failIfUnavailable:true` refuses to start.
- **Modes**: `auto-allow` (sandboxed Bash runs without prompt, substituting for a bare `Bash` ask
  rule) vs `regular` (normal permission flow). Independent of permission mode, except plan-mode and
  classifier exceptions.
- **Documented limits**: no TLS inspection → domain fronting possible; `allowUnixSockets` can hand
  over the host (e.g. docker.sock); `allowAppleEvents` removes code-exec isolation;
  `allowNestedUserNamespaces` "turns off a security boundary"; `enableWeakerNestedSandbox`
  "considerably weakens security".

#### 3.4.2 What the sandbox does **not** cover `[DOC]`

File tools (Read/Edit/Write), WebFetch, MCP servers, command hooks, plugin monitors and mods all run
**outside** the Bash sandbox. Only the outer `@anthropic-ai/sandbox-runtime` / devcontainer / VM puts
them all inside one boundary. This is the single most important architectural asymmetry to compare
against HorizonCode's single Guard/ExecutionHost boundary.

### 3.5 Hooks

#### 3.5.1 Model

Three levels — **event → matcher group → handler** — and five handler kinds
(`command`, `http`, `mcp_tool`, `prompt`, `agent`). Handlers for one event run **in parallel**; at
most 12 prompt/agent handlers run concurrently. Identical handlers declared in multiple settings
files run once; a plugin's or skill's copy stays separate. `[DOC]`

#### 3.5.2 Matcher grammar `[DOC]`

| Matcher | Evaluated as |
|---|---|
| `*`, `""`, omitted | match all |
| only `[A-Za-z0-9_\- ,\|]` | exact string or `\|`/`,`-separated exact list |
| anything else | unanchored JS `RegExp.test` |
| `FileChanged`, `StopFailure` | narrower exact set: letters, digits, `_`, `\|` only |

Per-event match targets are enumerated in §4.3.3. The `if` field on a handler is a *single*
permission rule (no `&&`/`||`), evaluated only on tool events, and is **best-effort** — when the
command can't be parsed, the hook runs anyway. `[DOC]`

#### 3.5.3 Exit-code and JSON contract `[DOC]`

| stdout | exit 0 | exit 2 | other |
|---|---|---|---|
| valid JSON object | success, fields apply | blocking error; fields read but cannot override the block | success — **exit code ignored**, fields decide |
| unparseable / invalid JSON | non-blocking error | blocking error, stderr is the reason | non-blocking error |
| plain text / empty | success | blocking error, stderr is the reason | non-blocking error (first stderr line) |

Plus: `onFailure: "continue"|"block"` promotes any failure (can't start, non-0/2 exit, HTTP non-2xx,
timeout, invalid output) to a block-equivalent of exit 2. `async: true` (command only) never blocks;
`asyncRewake: true` wakes the model on exit 2. Per-event exit-2 semantics differ (16 of the 33 events
can block, 17 cannot) and are tabulated in §4.3.4.

Output caps: `additionalContext`, `systemMessage`, `initialUserMessage`, and plain stdout are each
capped at **10,000 characters**; beyond that the text is spilled to a session file with a 2,000-char
preview. `terminalSequence` is restricted to OSC 0/1/2/9/99/777 and BEL. `suppressOutput` is accepted
and ignored. `[DOC]`

#### 3.5.4 Timeouts `[DOC]`

`command|http|mcp_tool` 600 s; `prompt` 30 s; `agent` 60 s; lowered to 30 s on `UserPromptSubmit`,
`PreModelSwitch`, `PostModelSwitch`; 10 s on `MessageDisplay`; `SessionEnd` hooks share a 1.5 s budget
(raisable to 60 s by an explicit per-hook timeout). A timeout normally yields *no decision* — a
stalled hook is not a gate unless `onFailure:"block"` (or it is an SDK callback hook, which blocks).

#### 3.5.5 Hook scoping `[DOC]`

| Source | Lifetime |
|---|---|
| `~/.claude/settings.json` | all projects |
| `.claude/settings.json` / `.local.json` | project |
| managed | org; immune to `disableAllHooks` from below |
| plugin `hooks/hooks.json` | while plugin enabled |
| skill frontmatter | registered on invoke, **kept for the rest of the session**; `once:true` removes after first success |
| subagent frontmatter | only while that subagent runs; a `Stop` hook there is converted to `SubagentStop` |
| mod (`tool.check` etc.) | in-process; runs **after** `PreToolUse` hooks |

Skill-hook limits: 1,024 hooks and 16,384 matcher characters per skill *source* per session. `[DOC]`

### 3.6 Tools

#### 3.6.1 Catalog

54 built-in tool names in the SDK union: `Agent, Artifact, AskUserQuestion, Bash, ClaudeDesign,
CronCreate, CronDelete, CronList, Edit, EndConversation, EnterPlanMode, EnterWorktree, ExitPlanMode,
ExitWorktree, Glob, Grep, ListAgents, ListMcpResourcesTool, LSP, Monitor, NotebookEdit,
OfferChromeSetup, PowerShell, Projects, propose_skills, ProposeGoal, PushNotification, Read,
ReadMcpResourceDirTool, ReadMcpResourceTool, ReadNotifications, RemoteTrigger, ReportFindings,
ScheduleWakeup, SendFeedback, SendMessage, SendUserFile, SendUserMessage, ShareOnboardingGuide,
ShowOnboardingRolePicker, Skill, SubagentHandback, TaskCreate, TaskGet, TaskList, TaskStop,
TaskUpdate, TodoWrite, ToolSearch, WaitForMcpServers, WebFetch, WebSearch, Workflow, Write`. `[SDK]`

Documented but *not* in the union (surface-gated): `Task` (legacy alias of `Agent`), `DesignSync`,
`CronList` variants, `MultiEdit` (removed). `[OBS]` `stream/init` reported 23 tools for an
unauthenticated default session — the tool list is **filtered per session** by model capability,
plan, provider and policy, not a constant. `[OBS]`

#### 3.6.2 Behavioural contracts worth mirroring `[DOC]`

| Tool | Contract |
|---|---|
| `Bash` | one process per call; cwd carries over only inside allowed dirs (else `Shell cwd was reset to <dir>`); env does not carry over; shell aliases/functions captured at startup and applied; stdout streamed to a working file, killed at 5 GB; inline ≈30,000 chars for valid results (file+preview beyond), ≈10,000 chars for failures; exit-1 is "valid" only for a fixed benign set (`grep/rg/fgrep/egrep/find/diff/test/[`, `git diff`, `git grep`); foreground timeout → **moved to background** (except `sleep`); background time limit 30 min (2 h max), 10 min in `-p`-with-text-prompt; optional cgroup memory cap (`CLAUDE_CODE_TOOL_MEMORY_LIMIT`) with per-kind exclusions |
| `Edit` | exact string replace, no regex/fuzzy; refuses if `Read` deny matches; refuses writing through a symlink |
| `Read` | deny rules also apply to pasted image paths, `@`-mentions, IDE context |
| `Glob`/`Grep` | absent by default on macOS/Linux/WSL (dedicated tools suppressed); can be re-enabled |
| `Agent` | no permission prompt to *launch*; each child tool call goes through the same permission engine |
| `Monitor` | long-running command or WebSocket whose lines are fed back as events; same sandbox + timeout rules as Bash |
| `ToolSearch` | loads deferred tools on demand; on by default for MCP |
| `Skill` | executes a skill in the main conversation |
| `AskUserQuestion` | multi-choice; optional idle auto-continue (`60s|5m|10m`), never auto-resolves in background/remote/screen-reader |
| `EnterWorktree`/`ExitWorktree` | session-scoped worktree switching; path outside `.claude/worktrees/` prompts |

#### 3.6.3 Parallel execution `[DOC]`

Multiple tool calls in one assistant turn run **concurrently for read-only tools** (`Read`, `Glob`,
`Grep`, MCP tools with `readOnlyHint`) and **sequentially for state-changing tools** (`Edit`, `Write`,
`Bash`). Custom SDK tools default to sequential unless annotated `readOnlyHint`. A `PostToolBatch`
hook fires after the whole batch resolves and can stop the loop before the next model call.

### 3.7 Subagents

#### 3.7.1 Definition and scopes `[DOC]`

Markdown + YAML frontmatter; only `name` and `description` required. Priority order:
managed (1) > `--agents` (2) > `.claude/agents` (3) > `~/.claude/agents` (4) > plugin (5).
Project agents discovered by walking up to repo root; recursive scan; **identity is `name`, never the
path**. Plugin agents get `plugin:subdir:name` scoping. Plugin agents **ignore** `hooks`,
`mcpServers`, `permissionMode` (security).

19 frontmatter fields: `name, description, tools, disallowedTools, model, permissionMode, maxTurns,
autoCompactWindow, skills, mcpServers, hooks, memory, background, omitClaudeMd, effort, isolation,
color, initialPrompt, experimental{cacheTtl}`. Unknown fields are silently ignored (debug log names
them).

#### 3.7.2 Tool pool construction `[DOC]`

```
inherited pool
  − always-excluded: Agent(at depth limit), AskUserQuestion, EndConversation,
                     EnterPlanMode, ExitPlanMode(unless permissionMode=plan),
                     ScheduleWakeup, WaitForMcpServers, Workflow
  − background-only filter: keep Read, Grep, Glob, LSP, Bash, PowerShell, Edit, Write,
                     NotebookEdit, WebFetch, WebSearch, TodoWrite, Skill, ToolSearch,
                     EnterWorktree, ExitWorktree, Monitor, TaskStop, SendMessage, Artifact,
                     SubagentHandback (+ all MCP tools)
  → disallowedTools applied FIRST, then tools allowlist resolved against the remainder
  → forks skip both filters and inherit the parent's exact pool
```

Empty resolution ⇒ refusal with `Agent would be spawned with zero tools`. `[DOC]`

#### 3.7.3 Limits and state `[DOC]`

| Limit | Default | Override |
|---|---|---|
| Nesting depth | 3 layers below main | `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` |
| Concurrent subagents | 20 | `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` |
| Turns per subagent | none | `maxTurns` → partial result, resumable |
| Auto-compact window | inherits | `autoCompactWindow` (100k–1M) |

Model resolution order: per-invocation parameter → frontmatter → `CLAUDE_CODE_SUBAGENT_MODEL` → main
model; `inherit` = main model. Permission mode: `bypassPermissions`/`acceptEdits`/`auto` in the parent
**overrides** the child's `permissionMode`; `plan` pins the child to plan; `dontAsk` in plan denies
instead of prompting.

#### 3.7.4 Context and handback `[DOC]`

A non-fork subagent starts fresh with: its own system prompt, the delegation message, the full
CLAUDE.md hierarchy (skippable via `omitClaudeMd`), a git-status snapshot (absent for Explore/Plan),
preloaded skills, and a sibling roster (when `SendMessage` is in its pool). It does **not** get the
parent's output style, auto memory, or context-window size.

Return path hardening: each final report is scanned for instruction-shaped text — `\` inserted into
imitation tags/`Human:`/`Assistant:` lines, and a `[harness: subagent output matched instruction-shaped
pattern(s): …]` marker prepended for tag imitation or mentions of `bypassPermissions` /
`--dangerously-skip-permissions`. Reports arrive under a header stating the subagent's words carry no
authority. Background reports arrive as an automated completion notification. `[DOC]`

> Design note for HorizonCode: this is advisory *presentation* sanitisation, not enforcement — the
> docs say so explicitly ("doesn't change what an instruction in a report can do").

#### 3.7.5 Fork vs fresh `[DOC]`

| | Fork | Fresh subagent |
|---|---|---|
| Context | full parent conversation | delegation prompt only |
| System prompt/tools/model | identical to parent | from definition, filtered |
| Prompt cache | shared with parent | separate |
| Can spawn forks | no | n/a |
| Cost | lower for context-heavy side tasks | lower for small tasks |

Fork mode (`CLAUDE_CODE_FORK_SUBAGENT`) is on by default in interactive terminals from 2.1.232 and
everywhere from 2.1.302; while on, the parent **cannot wait** for a subagent.

### 3.8 Skills and slash commands

#### 3.8.1 Skill format `[DOC]`

`SKILL.md` = YAML frontmatter + Markdown body. 20 frontmatter fields: `name, description,
when_to_use, argument-hint, arguments, disable-model-invocation, user-invocable, allowed-tools,
disallowed-tools, model, effort, context, agent, background, hooks, paths, shell, metadata, license,
compatibility`. Booleans accept `yes/no/on/off/1/0`.

String substitutions: `$ARGUMENTS`, `$ARGUMENTS[N]`, `$N`, `$name` (from `arguments:`),
`${CLAUDE_SESSION_ID}`, `${CLAUDE_EFFORT}`, `${CLAUDE_SKILL_DIR}`, `${CLAUDE_PROJECT_DIR}`,
`${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`. Substitution happens in **both** the body and Bash
rules inside `allowed-tools`, which is what lets a bundled script run unprompted.
Dynamic context injection: `` !`command` `` lines execute and are replaced by output before the model
sees the content; `shell: powershell` switches the interpreter.

#### 3.8.2 Progressive disclosure `[DOC]`

1. catalog entry (name + ≤1,536-char description+`when_to_use`) in the prompt;
2. manifest on selection;
3. `SKILL.md` body;
4. referenced `reference.md`/`examples.md`/`scripts/` on demand.

`skillListingBudgetFraction` / `skillListingMaxDescChars` control tier-1 cost. Skill body content
persists in context for the rest of the session after invocation.

#### 3.8.3 Naming and precedence `[DOC]`

Name comes from frontmatter `name` **or** directory name (non-plugin); nested `.claude/skills` get
`/apps/web:deploy` qualification on collision; plugin skills are `/plugin-name:skill-name`;
`.claude/commands/*.md` → `/name`, subdirs → `/dir:name`; MCP prompts → `/server:prompt` and
`/mcp__server__prompt`. Reserved: `synced`, `anthropic-skills` prefix. Name characters rejected:
zero-width/control/private-use/bidi/`<`/`>`/irregular whitespace.

#### 3.8.4 Built-in command inventory `[DOC]`

~70 built-in slash commands, of which 24 are marked **Skill** (prompt-backed, same mechanism as user
skills: `/code-review`, `/batch`, `/simplify`, `/verify`, `/run`, `/loop`, `/doctor`, `/debug`,
`/update-config`, `/design`, `/slides`, `/dataviz`, `/deep-research` (workflow), `/claude-api`, …) and
1 is a **Workflow**. This is architecturally significant: most "commands" are not code — they are
versioned prompts, which is why they can be disabled/replaced by `skillOverrides` and
`disableBundledSkills`. `[DOC]`

### 3.9 Plugins

`plugin.json` at `.claude-plugin/plugin.json`; **optional** (standard layout is discovered without
it); only `name` required. Fields: `$schema, name, displayName, version, description, author{name,
email,url}, homepage, repository, license, keywords, metadata, icon, documentationUrl, supportUrl,
privacyPolicyUrl, termsOfServiceUrl, defaultEnabled, dependencies, settings, userConfig, types,
channels, skills, commands, agents, hooks, mcpServers, lspServers, outputStyles, workflows,
experimental{themes,monitors,evals}`. `[DOC]`

- Component paths must be `./`-relative and contained in the plugin root (path escape = load failure).
- `userConfig` options are prompted at enable time and substituted as `${user_config.KEY}` in **exec
  form only**; values are stored per plugin (`pluginConfigs`) and shell-form hooks must read
  `$CLAUDE_PLUGIN_OPTION_<KEY>` instead.
- Env vars available to plugin code: `${CLAUDE_PLUGIN_ROOT}`, `${CLAUDE_PLUGIN_DATA}`,
  `${CLAUDE_PROJECT_DIR}`.
- Name validation rejects `claude-*`, `anthropic-*`, `cc-plugin-*`, `official`+`claude` combinations.
- Marketplaces: git, GitHub, local path, `command` source (runs a command at install — an explicit
  supply-chain decision), with `strictKnownMarketplaces` / `blockedMarketplaces` / `pluginSuggestion
  Marketplaces` enterprise controls.
- Three trust gates: marketplace trust warning, per-plugin trust message (`pluginTrustMessage`), and
  `strictPluginOnlyCustomization` (locks skills/agents/hooks/mcp to plugin+managed sources).

### 3.10 MCP

#### 3.10.1 Transports `[DOC]`

| Transport | Config | Notes |
|---|---|---|
| `stdio` | `command`, `args`, `env`, `timeout`, `alwaysLoad` | `type` optional (absent ⇒ stdio). `CLAUDE_PROJECT_DIR` injected; answers `roots/list` with session dirs; shutdown `SIGINT`→`SIGTERM`(100 ms)→`SIGKILL`(400 ms) |
| `http` (alias `streamable-http`) | `url`, `headers`, `headersHelper`, `tools[]`, `timeout`, `alwaysLoad` | recommended; OAuth supported; auto-falls back to SSE (2.1.265+) |
| `sse` | `url`, `headers`, … | deprecated |
| `ws` | `url`, `headers`, `headersHelper` | no OAuth; no `--transport ws` CLI flag |
| `sdk` | in-process, host-registered only | rejected from disk configs with an explicit message |

A `url` without `type` is a hard config error. `--mcp-config` entries are validated at startup and
skipped entries surface as `mcp_server_errors[]` in `system/init`. `[DOC]` `[OBS]` (init carries
`mcp_servers[{name,status,source}]`).

#### 3.10.2 Tool naming and scoping `[DOC]`

`mcp__<server>__<tool>`; plugin-bundled servers become `mcp__plugin_<plugin>_<server>__<tool>`;
server-name characters outside `[A-Za-z0-9_-]` become `_`. Scopes: **local** (`~/.claude.json`
`projects[<path>].mcpServers`) > **project** (`.mcp.json`) > **user** (`~/.claude.json`) >
**plugin** > **claude.ai connectors**; `managedMcpServers` outranks all. Duplicates matched by name
across the three scopes, by endpoint across plugins/connectors (case-insensitive scheme/host, default
port, trailing slash normalised).

#### 3.10.3 Runtime behaviours `[DOC]`

- Two client runtimes: MCP TS SDK 1.x (v1) and 2.0 (v2, protocol revision 2026-07-28); selected by
  feature flag or `MCP_SDK_GENERATION`; v2 adds capability negotiation, `list_changed` streams with
  capped reopen policy (3 retries / 6-hour backoff), issuer validation on OAuth, HTTPS-or-loopback
  token endpoints only.
- Reconnect: remote drops → 5 attempts exponential from 1 s; transient first-connect → 3 attempts;
  stdio mid-session exit → restarted lazily on next tool call (`-p`/SDK), manual reconnect in
  interactive. Discovery requests (`tools/list`, `prompts/list`, `resources/list`) retried 3×.
- Timeouts: startup `MCP_TIMEOUT` (30 s default); per-server `timeout` (hard wall-clock, ≥1000 ms) or
  `MCP_TOOL_TIMEOUT` (default ≈28 h); per-request first-byte timer = max(60 s, tool timeout,
  MCP_TIMEOUT) for HTTP/SSE/connectors; idle timeout 5 min (HTTP/SSE/ws) / 30 min (stdio),
  `CLAUDE_CODE_MCP_TOOL_IDLE_TIMEOUT`.
- Auto-backgrounding: a main-conversation call running > 2 min becomes a background task
  (`CLAUDE_CODE_MCP_AUTO_BACKGROUND_MS`); subagent and IDE-server calls never do.
- Output: warning above 10,000 tokens, hard cap 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`); successful
  text > 50,000 chars spilled to a file.
- Tool search (default on): only tool **names** + server instructions at session start; per-tool
  `_meta["anthropic/alwaysLoad"]`; `alwaysLoad` per server; per-server `tools[]` policy; description
  limits 4,096 chars (upfront) / 16,384 (deferred).
- `_meta["anthropic/requiresUserInteraction"]: true` forces a human prompt in **every** mode;
  `--permission-prompt-tool` allow is converted to deny for such tools.
- `annotations.idempotentHint` / `readOnlyHint` control retry-after-connection-close and parallel
  execution.
- Elicitation: form and URL modes; `Elicitation` hook can auto-answer; `ElicitationResult` hook can
  rewrite/withhold.
- Resources: `@server:protocol://path`, `ListMcpResourcesTool`/`ReadMcpResourceTool`/`ReadMcpResourceDirTool`.
- Prompts: `/server:prompt` or `/mcp__server__prompt`.
- MCP **tasks** (server-side long-running jobs) survive session exit and are re-attached on resume.

### 3.11 Sessions, transcripts, checkpoints

#### 3.11.1 Session identity `[DOC]`

`session_id` = UUID. `--session-id <uuid>` forces it; `--fork-session` mints a new one;
`/branch` copies the transcript and switches the writer. Names are UX aliases resolved across the
current repo and its worktrees. Sessions are **per project directory**, `<project>` = cwd with
non-alphanumerics → `-`, truncated to 200 chars + hash if long.

#### 3.11.2 What resume restores `[DOC]`

conversation (from last compaction summary forward), interrupted tool calls marked as cut off (not
re-run; Claude is told to verify), model, `--agent`, permission mode (per-surface rules), active goal,
unexpired session cron tasks. **Not** restored: `--mcp-config`, `--settings`, `--plugin-dir`,
`--fallback-model`, `--add-dir` dirs, background bash/subagent/workflow processes (they appear as
"didn't finish" notes).

#### 3.11.3 Checkpoints `[DOC]`

One checkpoint per *prompt that starts a turn*; snapshot before edits; 100 most recent per session;
stored in `~/.claude/file-history/<session>/`; 30-day retention aligned with transcripts.
`/rewind` offers: restore code+conversation, restore conversation, restore code, summarise from here,
summarise up to here. Not tracked: files changed only by Bash, subagent (non-foreground-fork) edits,
external changes, symlinked/hard-linked paths (explicit "skipped N files" warning).

**Recovery semantics gap to note:** a resumed session whose last turn was interrupted does *not*
resume the interrupted turn by default (`CLAUDE_CODE_RESUME_INTERRUPTED_TURN=1` opts in). There is no
UNKNOWN state, no receipt, no reconciliation — the transcript is the only record.

### 3.12 Context, compaction, prompt caching

#### 3.12.1 Budget control `[DOC]`

- `autoCompactEnabled`, `autoCompactWindow` (100k–1M or `auto`), `idleCompaction` (compact a long
  conversation while the terminal is idle).
- Compaction emits `system/compact_boundary` with `{trigger, pre_tokens, post_tokens?, duration_ms?,
  preserved_segment?, preserved_messages?}` — i.e. partial compaction can preserve a message segment
  anchored to a UUID. `[SDK]`
- `PreCompact` (blockable), `PostCompact` (with `compact_summary`). `[DOC]`
- Compactor reads CLAUDE.md, so a "what to preserve" section in memory steers it. `[DOC]`
- `/compact [instructions]`, and `Summarize from here` / `up to here` from `/rewind`.

#### 3.12.2 Prompt caching `[DOC]`

Automatic. `promptCacheTtl` per main conversation (`5m` default, `1h` opt-in), `subagentPromptCacheTtl`
for subagents, per-subagent `experimental.cacheTtl`. Switching model forfeits the cache (a
`PreModelSwitch` hook receives `prompt_cache_warm`, `cache_ttl`, `context_tokens`,
`estimated_cache_write_usd`, `pricing` and can deny/ask/allow the switch). CLAUDE.md edits don't
apply mid-session because the prompt is cached; `/compact` costs a cache write. `--system-prompt-snapshot
off` rebuilds the prompt each request (otherwise the first request's prompt is recorded and reused
verbatim until compaction).

#### 3.12.3 Context accounting `[SDK]` `[DOC]`

`SDKContextUsage` with per-category breakdown is attached to the synthetic assistant message that
`/context` produces, plus `/usage` (`SDKUsageReport`). The status line receives
`context_window.{total_input_tokens,total_output_tokens,context_window_size,used_percentage,
remaining_percentage,current_usage}` and a fixed `exceeds_200k_tokens` flag.

#### 3.12.4 System prompt composition (structure only)

Observed `api-request-shape` shows the system prompt as an **ordered array of text blocks**: identity,
harness rules (markdown rendering, permission semantics, parallel-tool hint, `file:line` reference
convention), tone/style, environment block, and per-turn reminders injected as separate `attachment`
records rather than system text. `--exclude-dynamic-system-prompt-sections` moves per-machine sections
into the first user message specifically to improve cross-user cache reuse; a
`__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__` marker lets a custom prompt split static from dynamic. `[DOC]`
`[OBS]` — prompt **text intentionally not reproduced**.

#### 3.12.5 Context that the harness injects on its own `[OBS]` `[DOC]`

`attachment` transcript records with a `type` and a `rendered` array: `environment` (cwd, isWorktree,
isGitRepo, additionalWorkingDirs, platform, shell, osVersion) is the one observed for a first turn.
Others documented: file-change notices, skill listing, sibling roster, hook `additionalContext`,
subagent reports, plan files, task notifications, `@`-mention attachments.

### 3.13 Memory / instruction files

Hierarchy, loaded broad → specific `[DOC]`: managed policy (`/etc/claude-code/CLAUDE.md`,
`/Library/Application Support/ClaudeCode/CLAUDE.md`, `C:\Program Files\ClaudeCode\CLAUDE.md`) →
`~/.claude/CLAUDE.md` → `./CLAUDE.md` or `./.claude/CLAUDE.md` (or `AGENTS.md` in place of/alongside)
→ `./CLAUDE.local.md`. Parent-directory files load at launch; subdirectory files load on demand when a
file there is touched. `.claude/rules/*.md` with `paths:` frontmatter = path-scoped rules.
`@path/to/import` expands inline, max **4 hops**, relative to the importing file, code spans/fences
skipped. `claudeMd` (managed) injects org instructions; `claudeMdExcludes` skips files;
`InstructionsLoaded` hook fires per file with `{file_path, memory_type, load_reason, globs?,
trigger_file_path?, parent_file_path?}`. Auto memory `MEMORY.md` loads first 200 lines / 25 KB.

### 3.14 Telemetry, cost, usage

- **Metrics** (`claude_code.*`): `session.count`, `lines_of_code.count`, `pull_request.count`,
  `commit.count`, `cost.usage`, `token.usage`, `code_edit_tool.decision`, `active_time.total`. `[DOC]`
- **Events** (28 named): `user_prompt`, `assistant_response`, `tool_result`, `api_request`, `api_error`,
  `api_refusal`, `api_request_body`, `api_response_body`, `tool_decision`, `safety_event`,
  `permission_mode_changed`, `auth`, `mcp_server_connection`, `internal_error`, `plugin_installed`,
  `plugin_loaded`, `skill_activated`, `at_mention`, `api_retries_exhausted`, `hook_registered`,
  `hook_execution_start`, `hook_execution_complete`, `hook_plugin_metrics`, `compaction`,
  `subagent_completed`, `feedback_survey`, `retention_sweep`, `managed_settings_resolved`. `[DOC]`
- **Traces (beta)**: `claude_code.interaction` → `{llm_request, hook, tool}` with
  `tool.blocked_on_user` and `tool.execution` children; subagent spans nest under the parent tool span;
  W3C `traceparent` propagated to the Anthropic API and to HTTP MCP requests (not to third-party
  providers). `TRACEPARENT` in the environment makes the interaction span a child of the caller's. `[DOC]`
- **Correlation**: `prompt.id` appears on OTel events and in hook input `prompt_id`, so one prompt can
  be joined across telemetry and hooks. `[DOC]` `[SDK]`
- **Cost**: client-side estimate (`total_cost_usd`, `modelUsage`), explicitly not billing; `usage`
  covers only the main loop, `modelUsage` covers subagents/sidechains/compaction/workflow agents;
  `modelPricing` overrides list price; `--max-budget-usd` checks after each response.

### 3.15 Background sessions and supervisor

A long-lived **supervisor** (`claude daemon`) hosts each background session as its own Claude Code
process, with `roster.json` for reconnect and `jobs/<id>/state.json` for display. Lifecycle: working /
paused-on-prompt / attached → keep running; finished-unattached ≈1 h → stop process (transcript stays,
resume on attach); unexpected exit → restart; auto-update → supervisor restarts itself and migrates
idle sessions; supervisor dies → sessions stop after ≈1 min unless a new supervisor attaches.
Background shell commands, workflows, and background subagents **carry over** to the next process;
monitors and subagent-started shell commands do not (`CLAUDE_CODE_DISABLE_BG_EXIT_HANDOFF` disables
carry-over). `[DOC]`

### 3.16 Agent SDK control protocol

The SDK talks to the binary over a `Transport` (`[SDK]` `interface Transport`): `write`, `close`,
`isReady`, `readMessages(): AsyncGenerator<StdoutMessage>`, `endInput`, optional
`waitForExit`/`expectControlResponse`/`markDelivered`. Implementations: process (stdio), WebSocket,
SSE, in-process.

- Client → binary: `{type:'control_request', request_id, request:<Inner>}`.
- Binary → client: `{type:'control_response', response}` / `control_cancel_request`.
- 44 request subtypes in the union, including: `initialize`, `interrupt`, `set_permission_mode`,
  `set_model`, `set_max_thinking_tokens`, `rewind_files`, `reload_plugins`, `reload_skills`,
  `reload_output_styles`, `mcp_status`, `mcp_call`, `mcp_message`, `mcp_read_resource`,
  `mcp_set_servers`, `mcp_reconnect`, `mcp_toggle`, `stop_task`, `background_tasks`,
  `get_task_output`, `get_context_usage`, `get_usage`, `get_session_cost`, `list_models`,
  `get_settings`, `update_settings`, `apply_flag_settings`, `list_permission_rules`,
  `get_hooks_listing`, `register_repo_root`, `read_file`, `seed_read_state`, `file_suggestions`,
  `cancel_async_message`, `elicitation`, `request_user_dialog`, `rename_session`, `set_color`,
  `get_binary_version`.
- `Query` methods: `interrupt, setPermissionMode, setModel, setMaxThinkingTokens, applyFlagSettings,
  updateSettings, initializationResult, reinitialize, supportedCommands, supportedModels,
  supportedAgents, mcpServerStatus, getContextUsage, readFile, reloadPlugins, reloadSkills,
  reloadOutputStyles, accountInfo, rewindFiles, seedReadState, reconnectMcpServer, toggleMcpServer,
  readMcpResource, setMcpServers, streamInput, stopTask, backgroundTasks, close`.
- `system/init` advertises `capabilities[]` for feature detection: `interrupt_receipt_v1`,
  `interrupt_cancel_queued_v1`, `interrupt_send_now_v1`, `interrupt_requeue_taken_v1`,
  `msg_lifecycle_v1`, `request_marker_lists_v1`, `lifecycle_wakeup_source_v1`,
  `sdk_mcp_tools_list_changed`, `sdk_mcp_manifests`, `mcp_read_resource_v1`, `mcp_tool_ui_meta_v1`,
  `ui_surface_v1`, `mcp_call_result_not_for_model_v1`. `[OBS]`

**This is the single richest architectural asset in the whole product** for HorizonCode purposes: a
published, typed, versioned control protocol between a host application and the agent runtime, with
capability negotiation and explicit interrupt-receipt semantics.

---

## 4. Contract appendix

### 4.1 `settings.json` (shape, not full inventory)

```jsonc
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "model": "claude-opus-5-5",
  "fallbackModel": "sonnet,haiku",          // ordered chain, whole value from highest scope
  "env": { "KEY": "value" },                // applied to session + subprocesses
  "permissions": {
    "allow": ["Bash(npm run *)"], "ask": [], "deny": ["Read(./.env)"],
    "additionalDirectories": ["../lib"],
    "defaultMode": "default",               // auto|bypassPermissions ignored from project/local
    "disableBypassPermissionsMode": "disable",
    "blockReadsOutsideWorkingDirectories": true
  },
  "sandbox": { "enabled": true, "failIfUnavailable": true,
    "autoAllowBashIfSandboxed": true, "allowUnsandboxedCommands": false,
    "excludedCommands": ["docker"], "network": { "allowedDomains": [], "deniedDomains": [] },
    "filesystem": { "allowWrite": [], "denyWrite": [], "denyRead": [], "allowRead": [] } },
  "hooks": { "PreToolUse": [ { "matcher": "Bash", "hooks": [
      { "type": "command", "command": "...", "args": [], "timeout": 30,
        "if": "Bash(rm *)", "async": false, "once": false, "onFailure": "block" } ] } ] },
  "enabledPlugins": {}, "extraKnownMarketplaces": {}, "enableAllProjectMcpServers": false,
  "statusLine": { "type": "command", "command": "..." },
  "autoCompactEnabled": true, "autoCompactWindow": "auto", "cleanupPeriodDays": 30,
  "includeCoAuthoredBy": false, "attribution": { "commit": "", "pr": "" },
  "apiKeyHelper": "...", "forceLoginMethod": "claudeai", "forceLoginOrgUUID": "..."
}
```

`[DOC]` `[OBS]` (a session's settings file is strict JSON; `$schema` is advisory only).

### 4.2 Permission rules and updates

```
Bash(npm run *)            exact + prefix wildcard, space-sensitive
Bash(ls:*)                 equivalent trailing wildcard
Bash(git push *)           deny/ask covers `git -C . push`? NO — text match only
Read(./.env)               cwd-relative, gitignore depth rules
Read(//etc/**)             absolute
Read(~/secrets/**)         home
Edit(/src/**)              anchored at settings source
Agent(Explore)             subagent type
Agent(model:opus)          deny/ask parameter match only
WebFetch(domain:*.example.com)
mcp__github__get_*         allow needs mcp__<server>__ prefix; deny accepts bare mcp__*
Skill(deploy *)            skill name matching
Cd(~/code/**)              /cd allowlist mode when any allow rule exists
```

### 4.3 Hooks

#### 4.3.1 Handler union

```ts
type HookHandler =
 | { type:'command'; command:string; args?:string[]; async?:boolean; asyncRewake?:boolean;
     shell?:'bash'|'powershell'; onFailure?:'continue'|'block';
     timeout?:number; statusMessage?:string; once?:boolean; if?:string }
 | { type:'http'; url:string; headers?:Record<string,string>; allowedEnvVars?:string[];
     onFailure?:'continue'|'block'; timeout?:number }
 | { type:'mcp_tool'; server:string; tool:string; input?:Record<string,unknown>; timeout?:number }
 | { type:'prompt'; prompt:string; model?:string; timeout?:number; continueOnBlock?:boolean }
 | { type:'agent'; prompt:string; model?:string; timeout?:number };
```

#### 4.3.2 Common input

```json
{ "session_id":"abc123", "prompt_id":"<uuid>", "transcript_path":"…/session.jsonl",
  "cwd":"/repo", "scratchpad_dir":"/tmp/claude-1000/…/scratchpad",
  "permission_mode":"default", "hook_event_name":"PreToolUse",
  "agent_id":"…?", "agent_type":"Explore?", "effort":{"level":"high"}? }
```

`permission_mode` is `default|plan|acceptEdits|auto|dontAsk|bypassPermissions` (the UI's "Manual"
always arrives as `default`). There is **no `$CLAUDE_MODEL`** env var; `$CLAUDE_EFFORT` exists.

#### 4.3.3 Per-event schema summary (33 events) `[DOC]` `[SDK]`

| Event | Matcher on | Extra input | Decision surface |
|---|---|---|---|
| `SessionStart` | `startup\|resume\|clear\|compact\|fork` | `source, model?, agent_type?, session_title?, seconds_since_last_response, context_tokens, prompt_cache_likely_expired, estimated_cache_write_usd` | ctx only: `additionalContext, initialUserMessage, sessionTitle, watchPaths, reloadSkills` |
| `Setup` | `init\|maintenance` | `trigger` | none |
| `InstructionsLoaded` | `session_start\|nested_traversal\|path_glob_match\|include\|compact` | `file_path, memory_type, load_reason, globs?, trigger_file_path?, parent_file_path?` | none |
| `UserPromptSubmit` | — | `prompt` | `decision:block, reason, additionalContext, sessionTitle, suppressOriginalPrompt` |
| `UserPromptExpansion` | command name | `expansion_type, command_name, command_args, command_source, prompt` | `decision:block, reason, additionalContext` |
| `MessageDisplay` | — | `turn_id, message_id, index, final, delta` | `displayContent` (display only) |
| `PreToolUse` | tool name | `tool_name, tool_input, tool_use_id, mcp_server?` | `permissionDecision: allow\|deny\|ask\|defer`, `reason`, `updatedInput`, `additionalContext` |
| `PermissionRequest` | tool name | `tool_name, tool_input, permission_suggestions[]` | `decision.behavior allow\|deny`, `updatedInput`, `updatedPermissions[]`, `message`, `interrupt` |
| `PermissionDenied` | tool name | `tool_name, tool_input, tool_use_id, reason` | `hookSpecificOutput.retry:true` only |
| `PostToolUse` | tool name | `tool_name, tool_input, tool_response, tool_use_id, duration_ms?` | `decision:block, reason, additionalContext, classifierContext, updatedToolOutput, updatedMCPToolOutput` |
| `PostToolUseFailure` | tool name | `…, error, is_interrupt?, duration_ms?` | `additionalContext` |
| `PostToolBatch` | — | `tool_calls[]` | `decision:block`, `additionalContext` (stops next model call) |
| `Notification` | 13 notification types | `message, title?, notification_type` | none (side effects only) |
| `SubagentStart` | agent type | `agent_id, agent_type` | `additionalContext` |
| `SubagentStop` | agent type | `agent_id, agent_type, agent_transcript_path, last_assistant_message, stop_hook_active, background_tasks[], session_crons[]` | `decision:block`, `additionalContext` |
| `TaskCreated` | — | `task_id, task_subject, task_description?, teammate_name?, team_name?` | `decision:block` (rolls back creation) |
| `TaskCompleted` | — | same | exit 2 / `continue:false` |
| `Stop` | — | `stop_hook_active, last_assistant_message, background_tasks[], session_crons[]` | `decision:block` + `reason` (continue), or `additionalContext` |
| `StopFailure` | 12 error types | `error, error_details?, last_assistant_message` | none |
| `TeammateIdle` | — | `teammate_name, team_name?` | exit 2 / `continue:false` |
| `ConfigChange` | `user_settings\|project_settings\|local_settings\|policy_settings\|skills` | `source, file_path` | `decision:block` |
| `CwdChanged` | — | `old_cwd, new_cwd` | `watchPaths` |
| `DirectoryAdded` | `slash_command\|register_repo_root` | `directory, source` | none |
| `FileChanged` | literal filenames | `file_path, event: change\|add\|unlink` | `watchPaths` |
| `WorktreeCreate` | — | `name` | stdout = path (command) / `hookSpecificOutput.worktreePath` (http) |
| `WorktreeRemove` | — | `worktree_path` | non-zero exit fails removal |
| `PreCompact` | `manual\|auto` | `trigger, custom_instructions` | `decision:block` |
| `PostCompact` | `manual\|auto` | `trigger, compact_summary` | none |
| `PreModelSwitch` | canonical `to_model` | `from_model, to_model, requested_model, source, context_tokens, prompt_cache_warm, cache_ttl, estimated_cache_write_usd, pricing` | `permissionDecision allow\|deny\|ask` |
| `PostModelSwitch` | canonical model | `from_model, to_model, source` | `additionalContext` |
| `SessionEnd` | `clear\|resume\|logout\|prompt_input_exit\|other` | `reason` | none |
| `Elicitation` | MCP server name | `mcp_server_name, message, mode, requested_schema\|url` | `action: accept\|decline\|cancel`, `content` |
| `ElicitationResult` | MCP server name | `mcp_server_name, action, content, mode` | rewrite/decline |

#### 4.3.4 Exit-2 blockability matrix `[DOC]`

Blocking: `PreToolUse, UserPromptSubmit, UserPromptExpansion, Stop, SubagentStop, TeammateIdle,
TaskCreated, TaskCompleted, ConfigChange (not policy_settings), PostToolBatch, PreCompact,
PreModelSwitch, Elicitation, ElicitationResult, WorktreeCreate, WorktreeRemove`.
Non-blocking (exit code ignored or stderr-only): `PermissionRequest (use JSON), StopFailure,
PostToolUse, PostToolUseFailure, PermissionDenied, Notification, SubagentStart, SessionStart, Setup,
SessionEnd, CwdChanged, DirectoryAdded, FileChanged, PostCompact, PostModelSwitch,
InstructionsLoaded, MessageDisplay`.

### 4.4 `stream-json` envelopes `[SDK]` `[OBS]`

```jsonc
// system/init (first frame unless hook/plugin_install frames precede it)
{"type":"system","subtype":"init","session_id":"…","cwd":"/repo","model":"claude-opus-5-5",
 "permissionMode":"default","apiKeySource":"none","claude_code_version":"2.1.310",
 "tools":["Agent","Bash",…],"mcp_servers":[{"name":"x","status":"pending","source":"user"}],
 "slash_commands":[…],"terminal_slash_commands":[…],"agents":["claude","Explore","general-purpose","Plan"],
 "skills":[…],"plugins":[{"name":"…","path":"builtin","source":"…@builtin"}],
 "output_style":"default","capabilities":["interrupt_receipt_v1",…],
 "memory_paths":{"auto":"…"},"original_cwd":"…","additional_directories":[],
 "messaging_socket_path":"/run/user/1000/cc-socks/123.sock","fast_mode_state":"off",
 "view_mode":"default","uuid":"…"}

// assistant (one content block per frame; wrapper carries routing metadata)
{"type":"assistant","message":{…Anthropic Message…},"parent_tool_use_id":null,
 "session_id":"…","uuid":"…","user_message_uuid":"…?","error":"authentication_failed"?}

// stream_event (only with --include-partial-messages)
{"type":"stream_event","event":{…BetaRawMessageStreamEvent…},"parent_tool_use_id":null,"ttft_ms":123}

// result (terminal; trailing system frames may still follow, e.g. prompt_suggestion)
{"type":"result","subtype":"success|error_during_execution|error_max_turns|error_max_budget_usd|error_max_structured_output_retries",
 "is_error":false,"duration_ms":123,"duration_api_ms":100,"num_turns":3,"result":"text",
 "stop_reason":"end_turn","total_cost_usd":0.03,"usage":{…},"modelUsage":{"claude-opus-5-5":{…}},
 "permission_denials":[],"structured_output":{…}?,"terminal_reason":"…","result_index":0,
 "queued_turn_count":0,"fast_mode_state":"off","session_id":"…","uuid":"…"}
```

Observed unauthenticated `result` had `subtype:"success"` with `is_error:true`,
`terminal_reason:"api_error"`, `result:"Not logged in · Please run /login"`, `modelUsage:{}`,
`subagent_stats:{…}`, `safety_stops:0`, and **process exit code 0**. `[OBS]` — notable: a failed run is
still a well-formed success-subtype envelope; scripts must check `is_error`, not the exit code.

### 4.5 Transcript JSONL records `[OBS]`

Path `~/.claude/projects/<project>/<session-id>.jsonl`. Documented as "internal to Claude Code and
changes between versions". Record types observed in one unauthenticated turn:

| `type` | Purpose | Representative fields |
|---|---|---|
| `queue-operation` | prompt queue event | `operation, timestamp, content` |
| `user` | user turn | `parentUuid, isSidechain, promptId, message, uuid, timestamp, permissionMode, promptSource, turnOrigin, turnPosition{promptIndex,turnIndex}, userType, entrypoint, cwd, sessionId, version, gitBranch` |
| `attachment` | harness-injected context | `parentUuid, attachment{type,snapshot}, rendered[{content}], renderedRole, userType, entrypoint, cwd, sessionId, version, gitBranch` |
| `atis-latch` | internal latch | `atis, sessionId` |
| `last-prompt` | resume pointer | `lastPrompt, leafUuid, sessionId` |
| `api-request-shape` | request shape hash + header blocks | `shapeHash, timestamp, version, shape` |
| `api-request-blob` | deduplicated message blob | `hash, message` |
| `api-request` | full request audit | `id, timestamp, version, querySource, shapeHash, params, keep, tail, cacheControl, requestDigest` |
| `assistant` | assistant turn | `parentUuid, message, error?, isApiErrorMessage?, perTurnEffort, userType, entrypoint, cwd, sessionId, version, gitBranch` |
| `cost-state` | running cost checkpoint | `totalCostUSD, totalAPIDuration, totalToolDuration, totalLinesAdded/Removed, totalDuration, startTime, modelUsage, hasUnknownModelCost` |

Linkage is via `parentUuid`/`leafUuid` — a **linked list per session**, not a monotonic log with
sequence numbers, and no branch pointers (fork = new file). Subagent transcripts live in
`<session>/subagents/agent-<id>.jsonl`; large tool outputs in `<session>/tool-results/`.

### 4.6 `plugin.json`

See §3.9. Only `name` is required; standard layout supplies components without a manifest; component
paths are `./`-relative and must resolve inside the plugin root; `userConfig` and `channels`,
`lspServers`, `monitors` entries are **strict** (unknown key = load failure) while unknown top-level
keys are stripped with a warning.

### 4.7 Frontmatter

```yaml
# SKILL.md
name: deploy            # or directory name
description: …
when_to_use: …
argument-hint: "[env]"
arguments: [env, tag]
disable-model-invocation: true
user-invocable: false
allowed-tools: Read Grep Bash(${CLAUDE_SKILL_DIR}/scripts/*)
disallowed-tools: AskUserQuestion
model: sonnet
effort: high
context: fork            # + agent:, background:
hooks: { PreToolUse: [ … ] }
paths: ["src/**"]
shell: bash
metadata: {…}
license: MIT
compatibility: "…"
```

```yaml
# .claude/agents/*.md
name: code-reviewer
description: Reviews code for quality
tools: Read, Glob, Grep
disallowedTools: Write
model: sonnet|opus|haiku|fable|inherit|full-id
permissionMode: default|acceptEdits|auto|dontAsk|bypassPermissions|plan|manual
maxTurns: 20
autoCompactWindow: 200000
skills: [api-conventions]
mcpServers: [slack, {inline-name: {…}}]
hooks: { … }
memory: user|project|local
background: true
omitClaudeMd: true
effort: high
isolation: worktree
color: blue
initialPrompt: "…"
experimental: { cacheTtl: 1h }
```

### 4.8 `.mcp.json`

```json
{ "mcpServers": {
  "shared": { "type": "http", "url": "https://example.com/mcp",
              "headers": {"Authorization":"Bearer ${TOKEN}"},
              "headersHelper": "./hdr.sh", "timeout": 600000, "alwaysLoad": false,
              "tools": [{"name":"x","policy":"allow"}] },
  "local":  { "command": "npx", "args": ["-y","server"],
              "env": {"KEY":"${KEY:-default}"} } } }
```

Expansion: `${VAR}` and `${VAR:-default}` in `.mcp.json`. Types: `stdio|http|streamable-http|sse|ws|sdk`.

### 4.9 Status-line input (subset)

`model{id,display_name}`, `cwd`, `workspace{current_dir,project_dir,added_dirs[],git_worktree,repo{host,
owner,name}}`, `cost{total_cost_usd,total_duration_ms,total_api_duration_ms,total_lines_added/removed}`,
`context_window{…}`, `exceeds_200k_tokens`, `fast_mode`, `effort.level`, `thinking.enabled`,
`rate_limits{five_hour,seven_day,spend_limit}`, `prompt_cache{…}`, `session_id`, `session_name`,
`prompt_id`, `transcript_path`, `version`, `output_style.name`, `vim.mode`, `agent.name`,
`pr{number,url,review_state,kind}`, `worktree{name,path,branch,original_cwd,original_branch}`. `[DOC]`

---

## 5. Execution flows

### 5.1 Turn lifecycle

```
submit(prompt)
 → user record written; promptId minted
 → context assembly: system blocks + memory + skill catalog + tool schemas + history
 → attachments injected as separate records (environment, file changes, reminders)
 → UserPromptSubmit hooks (parallel; may block or add context)
 → model request (streaming) ──► assistant frames (one content block per frame)
 → if tool_use present:
      ToolScheduler builds batch
      for each call (parallel if read-only): PreToolUse hooks → permission pipeline → execute
      → PostToolUse / PostToolUseFailure → results as user frames
      → PostToolBatch
      → loop back to model request  (turn count += 1)
 → else: Stop hooks (may force continuation)
 → result frame + cost-state record
```

`[DOC]` + `[OBS]` (`turnPosition`, `queue-operation`, `last-prompt` records corroborate the shape).

### 5.2 Tool-call lifecycle

See §3.3.3 for the decision order. Post-decision: input is re-validated against deny/ask **after**
any `updatedInput` rewrite; the tool runs; `duration_ms` excludes permission-prompt and PreToolUse
time; `PostToolUse.updatedToolOutput` replaces the result *before* the model sees it; MCP
`requiresUserInteraction` defeats hook/`permission-prompt-tool` allow.

### 5.3 Parallel tool calls

Read-only tools concurrently; writers serially. `PostToolBatch` sees the whole resolved batch
(`tool_calls[]` with `tool_response`) and can stop the loop. A subagent's concurrent Bash call in the
same repo sets `shared:true` on the other call's diff summary (cross-call interference is *detected
and reported*, not prevented). `[DOC]`

### 5.4 Subagent spawn/return

```
Agent tool call
 → depth check (default 3)  → refuse "depth limit"
 → concurrency check (default 20) → refuse "Concurrent subagent limit reached"
 → budget check → refuse "Budget limit reached"
 → resolve definition (managed > --agents > project > user > plugin)
 → build tool pool (filters, §3.7.2); empty ⇒ error
 → fork?  yes → inherit conversation/system/tools/model, shared cache, cannot re-fork
          no  → fresh context (own prompt + CLAUDE.md + git status + skills + roster)
 → SubagentStart hook
 → run loop in isolated context, transcript at <session>/subagents/agent-<id>.jsonl
 → report scanned (§3.7.4), delivered under non-authority header
 → SubagentStop hook (may block the stop)
 → parent receives result + agentId (resumable) — Explore/Plan are one-shot, no id
```

### 5.5 MCP handshake

```
config resolve (scope precedence, dedupe by name/endpoint)
 → spawn stdio (with CLAUDE_PROJECT_DIR, roots/list responder) or connect http/sse/ws
 → capability discovery: tools/list, prompts/list, resources/list (3 retries)
 → tool search: register names + instructions; defer schemas unless alwaysLoad
 → OAuth if 401: claude mcp login / /mcp, callback port, pre-registered client or DCR
 → status: connected | pending | failed | needs-auth | cached
 → list_changed → new toolset generation; in-flight provider turns keep their pinned generation
```

`[DOC]`

### 5.6 Resume / fork / rewind

- **resume**: load JSONL → replay to last compaction summary → mark interrupted tool calls as cut off
  → restore model/agent/mode/goal → do **not** re-run interrupted work.
- **fork** (`--fork-session`, `/branch`): copy transcript to a new session id; in-process `/branch`
  keeps session permission grants and background work; a separate process starts with none.
- **rewind**: pick a prompt checkpoint → restore code (file-history snapshots) and/or conversation
  (truncate the linked list) or summarise a range.

### 5.7 Compaction

`PreCompact` (blockable) → summarise older history (optionally preserving a message segment) → write
`compact_boundary` with `pre_tokens`/`post_tokens` → `PostCompact` → continue with summary +
unsummarised tail. Auto-triggered at `autoCompactWindow`; also `idleCompaction`, `/compact`,
`/rewind` summarise.

### 5.8 Sandbox enforcement

```
Bash tool call
 → permission pipeline decides run/deny/prompt
 → if sandboxed: spawn under Seatbelt/bwrap with
      fs allow-write {cwd, additionalDirs, tmp}, fs deny {protected paths, denyWrite/denyRead}
      network namespace (Linux) / Seatbelt deny-all-but-proxy (macOS)
      env HTTP(S)_PROXY → out-of-process proxy
 → proxy: hostname allowlist/denylist, loopback-resolution refusal, optional TLS termination
 → on block: error names the host; model may retry with dangerouslyDisableSandbox:true
      → that retry is re-gated by mode/classifier/rules
```

### 5.9 Headless run lifecycle

`-p` → optional `--bare` fast path → load settings/hooks/MCP → `system/init` → turns →
`result` → wait for background work (ceiling) → exit 0/non-zero. SIGTERM at any point: kill command
tree, run `SessionEnd`, exit 143, no result. `--no-session-persistence` suppresses transcript writes.

---

## 6. HorizonCode comparison

**How to read the HorizonCode column.** Status reflects (a) what the cited `arch_V1` owner states and
(b) source files I confirmed exist at the cited path. I did **not** run the Rust/TS test suites for
this report, so nothing here should be promoted to `TESTED`/`VERIFIED` on my authority. Per
`arch_V1/33` §33.1, a catalog entry is not runtime proof; treat every HC row as *design + source
presence*, not acceptance.

Gap classes: `MISSING` (no design/source), `WEAKER` (present but narrower/less proven),
`DIFFERENT-DESIGN` (HC intentionally solves it another way), `ALREADY-EQUAL` (parity or better),
`NOT-APPLICABLE` (out of V1 scope).

| # | Capability | Evidence | HorizonCode current state | Gap | Owner | Effort |
|---|---|---|---|---|---|---|
| 1 | Non-interactive machine protocol (`-p`, `text/json/stream-json`, `--input-format stream-json`) | `DOC` `OBS` `SDK` | CLI `run`/`serve` + SDK exist (`packages/cli`, `packages/sdk`, `sdks/`); no NDJSON turn protocol with `system/init`/`result`/`control_request` parity documented in `arch_V1/37` §37.19 | `WEAKER` | P9 + §37.19 | M |
| 2 | Typed host↔runtime control protocol with capability negotiation | `SDK` `OBS` | HostKernel RPC exists (`kernel/src/rpc_handshake.rs`, `protocol.rs`, `protocol_framing.rs`, `protocol_io_journal.rs`) and is **stronger** on durability; no published capability-negotiation list or interrupt-receipt semantics | `DIFFERENT-DESIGN` (HC deeper, narrower) | P1 §13 | M |
| 3 | Settings scopes + 5-level precedence + list-merge + security exceptions | `DOC` | `packages/core/src/config.ts` + `packages/core/src/v1/config/*` (skills/mcp/permission); no documented 247-key inventory or per-key scope column | `WEAKER` | P6 §16 | M |
| 4 | Permission rule grammar (`Tool(specifier)`, gitignore paths, Bash wildcard/compound rules, param rules) | `DOC` | `packages/core/src/permission*`, `packages/core/src/v1/permission.ts`; §37.25–37.27 define mode/grant/profile but **not** a public rule grammar | `MISSING` (grammar) | P6 §37.25–27 | L |
| 5 | Six permission modes incl. `plan`, `dontAsk`, classifier `auto` | `DOC` | `DirectSessionPermissionModeV1` in §37.25: `workspace-write/…` + `approvalPolicy on-request/always/never`, `danger-full-access` | `DIFFERENT-DESIGN` | P6 §37.25 | S |
| 6 | `auto` mode = model classifier judge | `DOC` | Explicitly **rejected** in V1: "`approve_for_me` / automatic review is not exposed in V1 without an authenticated independent reviewer" (§37.25) | `NOT-APPLICABLE` (by design) | — | — |
| 7 | Hook taxonomy (33 events) + 5 handler kinds + exit-code/JSON contract | `DOC` `SDK` | `HookBindingV2` §29.7 defines 23 canonical events, 3 modes, 3 handler kinds; kernel hook references in `kernel/src/host_kernel.rs`, `agent_profile.rs`, `worker_durable.rs` | `WEAKER` | P1 §29.7 | L |
| 8 | Hook output that cannot widen Guard | `DOC` | §29.7 states exactly this ("cannot turn a Guard DENY into ALLOW") — **ALREADY-EQUAL as a rule**, needs enforcement proof | `ALREADY-EQUAL` (design) | P1 §14.2 | S |
| 9 | Subagent definitions, 5 scopes, 19 frontmatter fields | `DOC` | `AgentProfileV2` §29.2 is **richer** (adapter kind, variants, capabilityCeiling, permissionCeilingDigest) | `ALREADY-EQUAL`+ | P6 §29.2 | M |
| 10 | Subagent depth/concurrency limits + tool pooling + structured handback | `DOC` | §29.13 (depth/comm limits), §29.5 (dispatch/messaging), `kernel/src/subagent_delivery.rs`, `task_dag.rs` | `ALREADY-EQUAL` | P6 §29.5/29.13 | S |
| 11 | Subagent output prompt-injection scanning | `DOC` | §29.10 security/injection boundaries; no scanning/marking layer documented | `MISSING` | P6 §29.10 | S |
| 12 | Fork subagents sharing parent cache | `DOC` | `AgentContextIsolationV2` has `fork` (§29.2) — design present, cache-sharing not addressed | `WEAKER` | P6 §29.2 | M |
| 13 | Skills: SKILL.md, progressive disclosure, `${CLAUDE_SKILL_DIR}`, `allowed-tools` ceiling, `context: fork` | `DOC` | `SkillManifestV2` §29.6 + `packages/core/src/skill.ts`, `skill/`, `horizon/skills/{horizon-docs,horizoncode}/SKILL.md` | `ALREADY-EQUAL` | P6 §29.6 | S |
| 14 | Skill identity/anti-shadowing | `DOC` (name-keyed) | §29.6 explicitly **stronger**: stable IDs, sealed built-ins, revision pinning | `ALREADY-EQUAL`+ | P6 §29.6 | — |
| 15 | Slash commands (~70 built-in; most are prompts not code) | `DOC` | `ActionDescriptor` registry §29.9 backs slash/palette/SDK; built-in inventory in §33 | `WEAKER` (inventory breadth) | P6 §29.9 / §33 | M |
| 16 | Custom commands from `.claude/commands/*.md` + `$ARGUMENTS`/`$N` | `DOC` | §29.9 `CustomActionV2`; docs command-files map to skills path in HC | `DIFFERENT-DESIGN` | P6 §29.9 | S |
| 17 | Plugin manifest + marketplaces + component bundle | `DOC` | `CompositionManifestV1` (`packages/core/src/composition-manifest.ts`) + `packages/plugin`; no marketplace/registry (no remote install) | `WEAKER` | P6 §29 | L |
| 18 | Plugin in-process **mods** with UI | `DOC` | Absent; would violate one-ExecutionHost boundary | `NOT-APPLICABLE` / REJECT | — | — |
| 19 | MCP transports (stdio/http/sse/ws/sdk), scopes, OAuth, headers helper | `DOC` | `McpServerProfileV2` §29.8 (stdio/streamable_http/json_rpc_http; SecretBroker-backed auth; trustClass; networkPolicyRef) + `packages/core/src/config/mcp.ts`, `v1/config/mcp.ts` | `WEAKER` (no ws/sse, no OAuth flow doc) | P6 §29.8 | M |
| 20 | MCP tool search deferral + `_meta` annotations (`requiresUserInteraction`, `alwaysLoad`, `idempotentHint`) | `DOC` | Not in §29.8. HorizonCode instead has exposure tiers and deferred discovery (`tools.search`, `skills.search`, Core tier) in `arch_V1/33` §33.32 (`DEC-V1-38`) | `MISSING` (annotations) | P6 §33.14 | M |
| 21 | MCP elicitation (form/URL) + hooks to answer | `DOC` | Not covered in §29.8 | `MISSING` | P6 §29.8 | M |
| 22 | MCP server-side tasks surviving session exit | `DOC` | Not covered; HC models long work as managed Run/Task/Attempt in Rust | `DIFFERENT-DESIGN` | P2 §29.18 | M |
| 23 | OS sandbox (Seatbelt/bubblewrap) + proxy + credential masking | `DOC` | §14.5 sandbox profile vector + §37.13 `TerminalExecutionServiceV1`; kernel `effect_host.rs`, `cgroup_v2.rs`, `terminal_process.rs`, `terminal_profile.rs`; PTY confinement fixtures exist (`kernel/hz-pty-confinement-*`, `hz-pty-network-*`) | `ALREADY-EQUAL` (design), `WEAKER` (no credential-masking equivalent documented) | P1 §14.5 | M |
| 24 | Single boundary covering shell + file tools + MCP + hooks | `DOC` (Claude Code **fails** this) | §14.1 authority law + one Guard/ExecutionHost is HC's core invariant; §14.6 covers MCP/provider tools | `ALREADY-EQUAL`+ | P1 §14 | — |
| 25 | Session transcripts as JSONL + resume/fork by id/name | `DOC` `OBS` | `kernel/src/session_projection.rs`, `direct_turn_journal.rs`, `direct_message_journal.rs`; resumable managed attempts §37.19 | `DIFFERENT-DESIGN` (durable journal vs file) | P8 §37.19 | M |
| 26 | Conversation checkpoint / `/rewind` incl. code restore | `DOC` | `kernel/src/checkpoint.rs` + §14.19 checkpoint/restore **effect semantics** (stronger: it is a Guarded effect) | `ALREADY-EQUAL` | P8 §14.19 | S |
| 27 | Compaction + `compact_boundary` token accounting + pre/post hooks | `DOC` `SDK` | `job.context.summarize` / `job.context.trim` §33.4; `before_compaction`/`after_compaction` in §29.7 | `WEAKER` (no boundary message schema) | P7 §33.4 | S |
| 28 | Instruction hierarchy + `@import` (4 hops) + path-scoped rules | `DOC` | §29.23 `ProjectInstructionModeV1` incl. trusted sources/precedence, on-demand nested load, external-import trust, and an explicit "what not to auto-load" | `ALREADY-EQUAL` | P6 §29.23 | S |
| 29 | Parallel tool batches with read-only/writer split | `DOC` | P1.3 "universal ToolBatch Guard/ExecutionHost" (plan Gate 2); fixtures `kernel/hz-tool-batch-multi-*` | `ALREADY-EQUAL` | P1 §14.3 | S |
| 30 | Tool catalog breadth (54 names) | `SDK` | §33 catalog is broader in capability IDs (230 generated IDs) but dotted-ID style; model-facing names differ | `DIFFERENT-DESIGN` | P3/P6 §33 | M |
| 31 | OTel metrics/events/traces with `prompt.id` correlation | `DOC` | §31 analytics/telemetry; no 28-event taxonomy or span tree documented | `WEAKER` | P7 §31 | M |
| 32 | Status-line command contract | `DOC` | TUI status/footer exists; no documented external JSON contract | `MISSING` | P7 §31 | S |
| 33 | Background session supervisor/daemon | `DOC` `OBS` | `kernel/src/supervisor_lease.rs`, `supervisor_session.rs`, `host_kernel.rs`; §37.16–19 headless worker/broker design | `WEAKER` (different: lease-based) | P8 §37.18 | M |
| 34 | Agent teams / cross-session messaging | `DOC` | §29.13 delegation depth/communication limits; `kernel/src/task_dag.rs`; no teammate UI | `WEAKER` | P6 §29.13 | L |
| 35 | Worktree isolation for sessions/subagents | `DOC` | §14.20 guarded worktree lifecycle executable; `kernel` PTY confinement fixtures | `ALREADY-EQUAL`+ | P1 §14.20 | S |
| 36 | Enterprise managed settings, `policyHelper`, MDM, server-managed | `DOC` | §16 UX/settings ecosystem + §17 governance; `packages/enterprise` | `WEAKER` (delivery breadth) | P6 §16 | L |
| 37 | Provider matrix (Bedrock/Vertex/Foundry/gateway/AWS) | `DOC` | §37.23 managed provider inference Guard action; `packages/llm`; `implementationtov1release.md` scope is Linux/WSL CLI | `WEAKER` | P6 §37.23 | L |
| 38 | Cloud sessions / Remote Control / artifacts publish / mobile / Slack | `DOC` | Explicitly post-V1 (`arch_V1/17`, plan "V1 scope decision") | `NOT-APPLICABLE` | — | — |
| 39 | Auto-update, telemetry upload, feedback upload | `DOC` | No hidden network fallback allowed by `AGENTS.md`; release packaging is P9 | `NOT-APPLICABLE` / REJECT | P9 §18 | — |
| 40 | Prompt-cache-aware model switching (`PreModelSwitch` w/ cost estimate) | `DOC` | `PrefixCacheAdapterV1` / `ContextCompileBridgeV1` §37.30; no pre-switch cost gate | `WEAKER` | P7 §37.30 | M |

### 6.1 Comparison summary

- **Where HorizonCode is already stronger:** single Guard/ExecutionHost covering *all* effect
  origins (Claude Code explicitly does not), durable lease/receipt/UNKNOWN semantics, sealed built-in
  identities, capability ceilings, checkpoint-as-effect, guarded worktree lifecycle.
- **Where Claude Code is stronger:** breadth of *externally documented contracts* (247 settings keys,
  33 hook events with per-event schemas, 54 tools, 5 handler kinds, 44 control requests), marketplace
  and plugin ecosystem, and a machine protocol that third parties can implement against.
- **The dominant HC gap class is `WEAKER`, not `MISSING`** — the architecture usually has a deeper
  analogue, but the *published contract surface* is thin. That is a documentation/contract problem
  before it is an implementation problem, and it directly limits interoperability, testability, and
  third-party SDK work.

---

## 7. Ranked upgrades and explicit REJECT list

### 7.1 Top-10 upgrades (ranked by leverage ÷ effort)

| # | Upgrade | Why (evidence) | V1 / post-V1 | Owner | Effort |
|---|---|---|---|---|---|
| 1 | **Publish a stable headless turn protocol** — NDJSON `system/init` → assistant/tool frames → `result`, plus `control_request`/`control_response` with capability negotiation (`interrupt_receipt_v1`, `interrupt_cancel_queued_v1`) | `SDK` `OBS`: this is the whole third-party integration surface; it makes CI, SDK, IDE, and tests one contract instead of four | **V1** | P9 §37.19 + P1 §13 | M |
| 2 | **Freeze a hook contract** — per-event input schema, exit-code matrix, `onFailure:block`, `updatedInput`/`updatedToolOutput`, `additionalContext` caps, timeouts | `DOC` `SDK`: 33 events × 5 handlers is the largest documented behaviour surface in the product; §29.7 has 23 events and 3 handler kinds | **V1** | P1 §29.7 + §14.2 | L |
| 3 | **Publish the permission rule grammar** (`Tool(specifier)`, anchors `//`/`~/`/`/`, Bash compound/wrapper rules, `Agent(type)`, `WebFetch(domain:)`, param rules) mapped onto Guard policy | `DOC`: rule grammar is the most-copied, most-misunderstood part of the product; HC has modes/grants but no grammar | **V1** | P6 §37.25–27 + §14.2 | L |
| 4 | **MCP conformance package** — `_meta` annotations (`requiresUserInteraction`, `alwaysLoad`), tool-search deferral, elicitation (form/URL) + hook interception, per-server timeout/idle semantics | `DOC`: MCP is where third-party tools enter; annotation handling is the difference between "works" and "safe" | **V1** | P6 §29.8 + §33.14 | M |
| 5 | **Compaction boundary + pre/post hooks with token accounting** | `DOC` `SDK`: `compact_boundary{pre_tokens,post_tokens,preserved_messages}` is a small, high-value contract that makes context behaviour observable and testable | **V1** | P7 §33.4 + §29.7 | S |
| 6 | **Subagent output injection scanning + non-authority report header** | `DOC`: cheap, purely additive defence; HC currently has no equivalent in §29.10 | **V1** | P6 §29.10 | S |
| 7 | **Settings inventory + per-key scope policy** (which keys may come from project/plugin/user; which are user/managed only) | `DOC`: HC has the files but not the per-key placement law; this is what prevents a repo from silently widening sandbox/permissions | **V1** | P6 §16 | M |
| 8 | **Credential masking inside the sandbox** (`deny|mask` for files/env, JWT claim masking, injectHosts) | `DOC`: HC's sandbox design covers paths/network but not secret *substitution* | **V1** | P1 §14.5/§14.7 | M |
| 9 | **Status/telemetry contract** — documented status JSON (session, cost, context, rate limits, worktree) + event taxonomy with `prompt.id` join | `DOC`: observability is a product feature here, not an afterthought; HC telemetry is thinner | **V1** (status JSON), post-V1 (full OTel parity) | P7 §31 | M |
| 10 | **Skill/command inventory parity pass** — classify each built-in command as prompt-skill vs code, and ship the prompt-backed ones as `SkillV2` assets | `DOC`: ~24 of ~70 commands are prompts; treating them as prompts makes them versionable, disableable, and testable without code | **V1** | P6 §29.6/§29.9 | M |

Post-V1 (deliberately deferred): agent teams/teammates UI, cross-session messaging, plugin
marketplaces with remote install, Remote Control, cloud sessions, artifacts publishing, mods,
desktop/browser surfaces, auto-update.

### 7.2 REJECT list (conflicts with HorizonCode invariants)

| Rejected | Reason |
|---|---|
| Copying Claude Code source, minified bundles, or **any** prompt/system-prompt text | `AGENTS.md`: "Claude Code is behavior reference only; no source reuse"; also licence/provenance rules in `arch_V1/42` |
| Reproducing the `api-request-shape` system prompt blocks verbatim | Proprietary prompt asset; only structural lessons are usable |
| `--dangerously-skip-permissions` as a real bypass | Violates one-Guard invariant; HC may only offer a *mode* that still crosses Guard/ExecutionHost (§37.25 keeps identity/lease/receipt even at `danger-full-access` + `never`) |
| Model-classifier "auto mode" as a default gate | Hidden paid judge + non-deterministic authority; §37.25 requires an authenticated independent reviewer before `approve_for_me` |
| In-process plugin **mods** (JS with UI access) | Would create a second execution path around ExecutionHost and the renderer boundary |
| Marketplace `command` install sources | Executes arbitrary code at install time; supply-chain risk with no Guard analogue |
| `~/.claude.json` single-file global state as HC's session authority | Loses durability, leases, receipts; HC already has a Rust authority |
| Auto-update / telemetry upload / feedback upload from a release build | Network mutation without user authorization; `AGENTS.md` forbids hidden remote fallback |
| Anthropic-hosted artifacts/cloud/Remote Control as a dependency of a V1 path | Paid/remote/third-party dependency; post-V1 only, explicit authorization required |
| Name-keyed skill/agent identity | HC §29.6 deliberately uses stable IDs; adopting Claude Code's name-keyed precedence would regress sealed built-ins |
| Transcript-file polling as a completion signal | "Model self-report is not completion evidence"; HC requires receipts/verification |

---

## 8. Unknowable within the stated limits

1. **Internal module structure, class/function names, and control flow** of the native binary. Only
   external behaviour and the typed SDK surface are observable.
2. **Exact system-prompt text and per-model prompt variants.** Structure is observable; text is not
   reproduced by policy.
3. **The auto-mode classifier's rules and model.** `claude auto-mode defaults` prints a rule set, but
   the classifier prompt, model selection policy, and server-side review behaviour are opaque.
   `[DOC]` documents outcomes only.
4. **Why specific permission decisions are made** in ambiguous cases (e.g. exact interaction between
   a `defer` decision, plan mode, and the classifier). Documented in prose, not as an algorithm.
5. **Transcript schema guarantees.** Documented as "internal … changes between versions"; the record
   taxonomy in §4.5 is a point-in-time observation of one build, not a contract.
6. **Concurrency internals**: whether hooks for one event truly run on a thread pool vs. async tasks;
   the exact parallel-tool scheduler limits; queue ordering under streaming input. Only outcomes
   (max 12 prompt/agent hooks, parallel read-only tools) are documented.
7. **Token/cost accounting formulas** beyond "client-side estimate": per-model price table, cache
   write/read weighting, subagent attribution rounding.
8. **Cloud/Remote Control/self-hosted runner internals**: relay protocol, sandbox VM image, queueing,
   spend enforcement. Documented as product behaviour only.
9. **Retry/backoff constants** beyond the documented ones (5 remote reconnects from 1 s doubling;
   discovery 3 retries; API retry event fields).
10. **Whether `--brief` and `--file` are stable or experimental**, since they appear in `--help` but in
    no documentation.
11. **Runtime status of any HorizonCode component.** This report verifies design text and file
    existence only; `TESTED`/`VERIFIED` require the project's own suites (`arch_V1/32`, `46-V1-*`).

---

## Appendix A — Observed CLI surface

**Subcommands (18 in `--help`, 21 total)** `[OBS]`: `agents`, `attach`, `auth {login,logout,status}`,
`auto-mode {config,critique,defaults,reset}`, `doctor`, `gateway --config`, `import
[codex|gemini|cursor]`, `install [stable|latest|x.y.z] --force`, `logs`, `mcp
{add,add-from-claude-desktop,add-json,get,list,login,logout,remove,reset-project-choices,serve}`,
`plugin|plugins {configure,details,disable,enable,eval,init|new,install,list,marketplace,prune,tag,
test,uninstall,update,validate}`, `purge [--all|--dry-run|-i|-y]`, `respawn <id>|--all`, `rm <id>`,
`setup-token`, `stop|kill <id>`, `ultrareview [--json|--post|--no-post|--timeout|--trust-workspace]`,
`update|upgrade`; documented-only: `daemon logs|run|status|stop`, `remote-control`,
`self-hosted-runner`.

**Flags present in `--help` but absent from the 9.7 MB doc corpus** `[OBS]`: `--brief`, `--file`.

**Flags documented but absent from `--help`** `[DOC]` `[OBS]`: `--advisor`,
`--append-subagent-system-prompt`, `--append-subagent-system-prompt-file`,
`--append-system-prompt-file`, `--system-prompt-file`, `--init`, `--init-only`, `--maintenance`,
`--permission-prompt-tool`, `--dangerously-load-development-channels`, `--teammate-mode`, `--channels`.

**`claude doctor` output (unauthenticated)** `[OBS]`: install method/commit/platform/path, search
backend, auto-update channel, `Managed settings (remote): not fetched — no usable credentials`,
`Organization policy: not fetched`, Remote Control eligibility block, `No installation issues found.`

---

## Appendix B — Recorded artefacts

| Artefact | Path |
|---|---|
| Doc corpus (full) | `repo_take/re-sandbox/claude-code/docs/llms-full.txt` |
| Doc corpus split by source | `repo_take/re-sandbox/claude-code/docs/split/*.md` (+ `doc-index.tsv`) |
| Hook per-event schema extract | `repo_take/re-sandbox/claude-code/docs/hook-schemas.txt` |
| CLI help | `repo_take/re-sandbox/claude-code/obs/help.txt` |
| Subcommand help | `repo_take/re-sandbox/claude-code/obs/subcommands.txt` |
| Version | `repo_take/re-sandbox/claude-code/obs/version.txt` |
| SDK types | `repo_take/re-sandbox/claude-code/work/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts`, `sdk-tools.d.ts` |
| Observed transcript | `repo_take/re-sandbox/home/.claude/projects/-home-sarvesh-business-Dev-agentx/*.jsonl` |

**Environment caveat:** the sandbox `$HOME` contains a previously installed `reverse-engineer-anything`
skill and a user-scope `rea` MCP server, both of which appear in the observed `system/init`
`skills`/`slash_commands`/`mcp_servers` arrays. Those arrays are therefore environment-specific and
must not be read as a default configuration.
