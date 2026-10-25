# Cursor CLI + Devin — competitive architecture reconstruction

**Purpose.** Behaviour reference for HorizonCode V1. This document reconstructs the externally
observable architecture of two commercial coding-agent products — **Cursor CLI** (`cursor-agent`) and
**Devin** (cloud sessions + Devin CLI + Outposts) — to the depth needed to rebuild an equivalent
system: components, process/network boundaries, state ownership, contracts, state machines, failure
paths, and cost/permission/sandbox models.

It contains **no** proprietary source, no decompiled or deobfuscated bundle content, **no prompt text**,
and no credentials. Nothing here is a HorizonCode implementation authority; per `AGENTS.md` and
`arch_V1/29` §29.16, competitor behaviour may only reach HorizonCode through an approved `arch_V1/17`
decision plus topic-owner update and §32 acceptance row.

**Targets observed**

| Product | Version / surface | Where |
|---|---|---|
| Cursor CLI | `cursor-agent 2026.10.22-27dcf5f` (installer channel `lab/2026.10.22-27dcf5f`) | installed repo-locally, black-box only |
| Cursor Cloud Agents | public REST `api.cursor.com` `v1` (beta) + `v0/private-workers` | documentation only |
| Devin Cloud | public docs `docs.devin.ai`, OpenAPI `v1` / `v2` / `v3` (v3 = 3.0.0) | documentation + published schemas |
| Devin CLI | docs `cli/*` (config v3000.3+ MCP split) | documentation only (no installer obtained) |
| Devin Outposts | `opbeta/outposts` fleet API + `devin-remote` spawn contract | documentation only |

**Evidence tags used throughout**

| Tag | Meaning |
|---|---|
| `DOCUMENTED` | Stated in the vendor's own docs, changelog, or published OpenAPI schema. |
| `OBSERVED` | Produced by running the sandboxed no-auth CLI and reading only its help text, exit codes, config files it created, and its own debug logs. No bundle was read. |
| `UNVERIFIED` | Inference or reconstruction that the allowed evidence does not establish; listed again in §14. |

A row may carry two tags when docs and observation agree; disagreements are called out explicitly
(§3.1.4, §8.1.4).

**Deliberately not done**

- No authentication, no account creation, no paid call, no trial, no credit expenditure (both products
  are gated; every authenticated path is documented here as *gated*).
- No reading, unminifying, decompiling, or diffing of `index.js` chunks, `cursorsandbox`, `rg`,
  `devin-remote`, or any binary. Only `--help`, exit codes, created config files, and the CLI's own
  debug-log lines were read.
- No prompt, system-message, classifier-instruction, or playbook body reproduced. Playbook/knowledge
  *schemas* are reported; their *content* is not.
- No source reuse. No HorizonCode product code touched.

---

# Part A — Cursor CLI (`cursor-agent`)

## 1. Provenance

| # | Source | What it yielded | Tag |
|---|---|---|---|
| P1 | `https://cursor.com/llms.txt` | Full documentation index (≈300 pages) and the `.md` publishing convention used below | `DOCUMENTED` |
| P2 | `repo_take/re-sandbox/work/cursor-devin/docs/cursor/*.md` (33 pages fetched) | CLI flags/permissions/config/output/ACP/headless/hooks/rules/skills/subagents/MCP/plugins/worktrees/run-modes/sandbox.json + Cloud Agent API reference | `DOCUMENTED` |
| P3 | `repo_take/re-sandbox/downloads/cursor-install.sh` | Installer mechanics: URL pattern, version pin, install dir, symlinks, `CURSOR_CONFIG_DIR`/`XDG_CONFIG_HOME` switch record | `OBSERVED` (script is the vendor's, unmodified) |
| P4 | `cursor-agent --version`; `--help`; `--help` for all 19 documented subcommands, the 2 hidden commands (`sandbox`, `acp`), and their sub-subcommands | Complete public CLI surface and defaults | `OBSERVED` (`obs/help-main.txt`, `obs/help-subcommands.txt`, `obs/help-deep.txt`, `obs/help-hidden.txt`) |
| P5 | Unauthenticated runs (`status`, `about`, `models`, `-p`, `create-chat`, `ls`, `mcp list`) | Auth error taxonomy, `status/about --format json` schemas, Ink/raw-mode failure, local chat-id creation | `OBSERVED` (§3.1.4) |
| P6 | Files created under sandbox `$HOME`/XDG | `~/.cursor/cli-config.json`, `~/.cursor/mcp.json`, `~/.cursor/projects/<slug>/`, `.config/cursor/{cli-config.json,statsig-cache.json}`, `.cache/cursor-compile-cache/`, `.tmp/cursor-agent-logs-<uid>/session-*.log` | `OBSERVED` |
| P7 | `cursor-agent sandbox run …` probes | Sandbox policy object, fail-closed write denial, DNS-level network denial, `--network` allow, `--sb-debug` artefacts | `OBSERVED` (`obs/sandbox-probe.txt`, `obs/sandbox-net.txt`) |
| P8 | CLI debug logs (`session-*.log`) | Service names (`LocalCursorRulesService`, `CursorPluginsAgentSkillsService`), colocated `rg` + `cursorsandbox` helpers, statsig endpoint, per-launch rule counts | `OBSERVED` |
| P9 | Rule-discovery probe workspace (`probe-ws/`) | `ruleCount: 4` for `AGENTS.md` + 2 × `.cursor/rules/*.mdc` + `.cursorrules` discovered from a nested cwd | `OBSERVED` (§3.7) |
| P10 | Package metadata / install tree | 558 MB installed tree; `agent` and `cursor-agent` symlinks to one versioned binary; hundreds of `NNNN.index.js` chunks (count not enumerated — not read) | `OBSERVED` (file listing only) |

Not obtained: any authenticated transcript, any chat/DB store location, any Cloud Agent live call.
Those are `UNVERIFIED` and listed in §14.

## 2. High-level design (Cursor)

### 2.1 Deployment shapes

Cursor is **three products behind one name**, and the split is the single most important fact for
HorizonCode comparison:

| Shape | Runs where | Who owns the loop | Billing surface |
|---|---|---|---|
| **Local CLI / IDE agent** | User machine | CLI process (single bundled Node SEA-style app) | Cursor plan quota |
| **Cloud Agent** | Cursor-managed VM per agent | Cursor backend + VM | Plan quota / usage |
| **Self-hosted Cloud Agent worker** | User infrastructure, driven by Cursor | Cursor backend schedules; worker executes `agent` on the machine | Same Cloud Agent quota (Enterprise for pools) |

The local CLI is **not** a thin client for the local case: with `--print` and a valid key it runs the
tool loop locally (file read/write, shell, web fetch, MCP) and talks to `api2.cursor.sh` for model
inference and feature flags. Two network services are observable even on unauthenticated launch:

- `statsig.setupLazyInit {"endpoint":"https://api2.cursor.sh"}` → remote **feature gates** are fetched
  and cached in `.config/cursor/statsig-cache.json` (OBSERVED). This means local tool/UX availability
  can be changed server-side without a CLI release.
- model traffic uses the same `api2.cursor.sh` base by default; `--endpoint`/`CURSOR_API_ENDPOINT`
  overrides it (OBSERVED help), and `network.useHttp1ForAgent` switches to HTTP/1.1 + SSE for proxies
  that break HTTP/2 bidirectional streaming (DOCUMENTED).

### 2.2 Component map (reconstructed)

```
┌────────────────────────────── user machine ──────────────────────────────┐
│  cursor-agent (bundled app, ~558 MB tree)                                │
│   ├─ CLI/arg surface (commander-style; hidden `sandbox`, `acp`)          │
│   ├─ interactive TUI (Ink-based; needs a TTY for `ls`/`resume`)          │
│   ├─ agent loop + tool executors (read/write/shell/fetch/MCP/subagent)    │
│   ├─ permission plane A: deterministic tokens (cli-config.json)          │
│   ├─ permission plane B: Auto-review classifier client (permissions.json)│
│   ├─ sandbox client → colocated `cursorsandbox` native helper            │
│   ├─ search → colocated `rg`                                             │
│   ├─ rules/skills/plugins services (local FS discovery)                  │
│   ├─ session store + debug logs (`$TMPDIR/cursor-agent-logs-<uid>/`)     │
│   └─ MCP client (stdio child / remote HTTP+OAuth)                        │
│         │ HTTPS (HTTP/2 or 1.1+SSE)                                      │
│         ▼                                                                │
│  api2.cursor.sh  ── inference, statsig feature gates, Auto-review        │
│  api.cursor.com  ── REST v1 Cloud Agents, v0 private workers             │
│  downloads.cursor.com / cursor.blob.core.windows.net ── updates, server  │
└──────────────────────────────────────────────────────────────────────────┘
```

A second, separate topology exists for Cloud Agents: Cursor provisions a VM, clones repos, runs a
build, then the same agent loop runs inside the VM; artifacts and branch/PR state are returned through
the REST API and an SSE stream (§4.3).

### 2.3 Where state lives

| State | Location | Tag |
|---|---|---|
| CLI settings | `~/.cursor/cli-config.json` (or `$CURSOR_CONFIG_DIR`, or `$XDG_CONFIG_HOME/cursor/cli-config.json`) | OBSERVED + DOCUMENTED |
| Project permission overrides | `<project>/.cursor/cli.json` — *only* permissions may be project-scoped | DOCUMENTED |
| Auto-review natural-language policy | `~/.cursor/permissions.json`, `<project>/.cursor/permissions.json` | DOCUMENTED |
| Sandbox policy | `~/.cursor/sandbox.json`, `<project>/.cursor/sandbox.json` | DOCUMENTED |
| MCP servers | `~/.cursor/mcp.json`, `<project>/.cursor/mcp.json` | OBSERVED (+DOCUMENTED) |
| Hooks | `~/.cursor/hooks.json`, `<project>/.cursor/hooks.json`, team/enterprise | DOCUMENTED |
| Rules | `<project>/.cursor/rules/*.mdc`, `.cursorrules`, `AGENTS.md` (root + nested), `CLAUDE.md` | OBSERVED + DOCUMENTED |
| Skills | `.cursor/skills`, `.agents/skills`, `~/.cursor/skills`, `~/.agents/skills` (nested discovery) | DOCUMENTED |
| Plugins | `~/.cursor/plugins/`, `~/.cursor/plugins/local`, marketplaces from git URLs | DOCUMENTED |
| Worktrees | `~/.cursor/worktrees/<reponame>/<name>` + `.cursor/worktrees.json` setup | DOCUMENTED |
| Local chat/session | `session_id` UUID surfaced in `json`/`stream-json`; `create-chat` prints an ID; `~/.cursor/projects/<slug>/` created | OBSERVED (creation) / `UNVERIFIED` (record format — auth-gated) |
| Debug logs | `$TMPDIR/cursor-agent-logs-<uid>/session-<ts>-<pid>-<n>.log` | OBSERVED |
| Compile cache | `$XDG_CACHE_HOME/cursor-compile-cache/v<node>-<arch>-<hash>/` | OBSERVED |
| Feature gates | `$XDG_CONFIG_HOME/cursor/statsig-cache.json` | OBSERVED |
| Cloud agent state | Cursor backend (agent, run, environment, build, artifact, secret, worker, pool) | DOCUMENTED |

**Architectural reading:** Cursor keeps *policy* in per-user/per-repo JSON, *behaviour* partly in
server-side feature gates, and *durable cloud state* entirely in its backend. There is no local durable
authority for cloud runs; the API resource is the record.

### 2.4 Security layering (as designed)

Three independent mechanisms, only one of which is an OS boundary:

1. **Deterministic permission tokens** (`Shell()`, `Read()`, `Write()`, `WebFetch()`, `Mcp()`) — a
   declarative allow/deny list. Deny beats allow (DOCUMENTED).
2. **Auto-review classifier** — a *cloud LLM* decides whether non-allowlisted calls may run; the docs
   state plainly that it "is not a security boundary" and can be wrong in both directions
   (DOCUMENTED, §5.2).
3. **OS sandbox** (`cursorsandbox`) — filesystem/network confinement for shell commands only; file
   tools and MCP calls are not necessarily inside it (DOCUMENTED + OBSERVED).

The three are deliberately *layered for UX*, not composed into one authority: e.g. a sandboxed command
that fails on a restriction may be re-run outside the sandbox after classifier review (DOCUMENTED).

## 3. Low-level design and contracts (Cursor)

### 3.1 CLI surface and defaults

Global options as observed (`cursor-agent --help`), with defaults:

| Option | Default | Notes |
|---|---|---|
| `prompt...` | — | initial prompt |
| `-v, --version` | — | prints `2026.10.22-27dcf5f` |
| `--api-key <key>` | env `CURSOR_API_KEY` | also `CURSOR_AUTH_TOKEN` accepted by error text |
| `-H, --header <header>` | — | repeatable custom request header |
| `-e, --endpoint <url>` | `https://api2.cursor.sh` (env `CURSOR_API_ENDPOINT`) | model/inference base |
| `-p, --print` | false | non-interactive; "has access to all tools, including write and shell" |
| `--output-format` | `text` | `text \| json \| stream-json`, print-only |
| `--stream-partial-output` | false | print + stream-json only |
| `--mode <mode>` | agent | `plan` (read-only planning), `ask` (Q&A read-only) |
| `--plan` | false | shorthand for `--mode=plan` |
| `--resume [chatId]` | false | session resume |
| `--continue` | — | previous session (docs: alias for `--resume=-1`) |
| `--model <model>` | account default (`Auto` in `about`) | supports bracket overrides, e.g. `'claude-opus-4-8[context=1m,effort=high,fast=false]'` |
| `--list-models` | false | auth-gated (OBSERVED failure) |
| `-f, --force` | false | "force allow commands unless explicitly denied" |
| `--yolo` | false | alias for `--force` ("Run Everything") |
| `--auto-review` | false | server classifier auto-runs safe calls |
| `--sandbox <mode>` | config | `enabled \| disabled` |
| `--approve-mcps` | false | auto-approve all MCP servers |
| `--trust` | false | trust workspace without prompting |
| `--workspace <path-or-name>` | cwd | workspace dir or saved workspace |
| `--add-dir <path>` | — | repeatable extra workspace root |
| `--plugin-dir <path>` | — | repeatable local plugin |
| `-w, --worktree [name]` | — | `~/.cursor/worktrees/<reponame>/<name>` |
| `--worktree-base <branch>` | current HEAD | |
| `--skip-worktree-setup` | false | skips `.cursor/worktrees.json` |

Subcommands: `persist` (`list`/`attach`/`stop`), `install-shell-integration`,
`uninstall-shell-integration`, `login`, `logout`, `mcp` (`login`/`list`/`list-tools`/`enable`/`disable`),
`plugin` (`marketplace add|list|remove|update`), `worker` (`start`/`controller`/`debug`), `status|whoami`,
`models`, `team` (`list`/`switch`), `bedrock` (`configure`/`enable`/`status`/`test`/`clear`/`disable`),
`about`, `update`, `create-chat`, `generate-rule|rule`, `agent`, `ls`, `resume`.

**Hidden/undocumented surface** (present in the binary, absent or thinner in docs):
`sandbox enable|disable|reset|run`, `acp`, and hidden options referenced only inside worker text
(`--worker-id`, `-k`/`--auth-token` in ACP examples).

### 3.1.4 Documented-vs-observed drift (evidence of a fast-moving contract)

| Claim | Documentation | Observation |
|---|---|---|
| `worker --idle-release-timeout` default | "Default `0` disables idle-based release" (`cli/reference/parameters.md`) | Help says **default 3600**, and "exits with code 0 so a supervisor can restart a clean process" |
| Config keys | `cli-config.json` schema table lists ~20 keys | Observed file also contains `modelSlashCommands`, `steering`, `exploreSubagentModel`, `autoAcceptWebSearch`, `runEverythingSettingsPromptStreak` — undocumented |
| `sandbox`/`acp` commands | `parameters.md` calls them "hidden" in the table | `--help` main list omits them entirely; they work when invoked |
| Worker claim flow | Docs describe pool/claim endpoints | Binary help documents the *controller* loop (`pending-requests/stream`, 60 s reconcile, wake semantics) in far more detail than the docs page |

This drift is itself a finding: a competitor's CLI contract is only stable at the **semantic** level
(flags exist, JSON shape, exit codes); field-level surface moves within weeks.

### 3.2 Settings schemas

**`~/.cursor/cli-config.json`** (OBSERVED default written on first run, plus DOCUMENTED fields):

```json
{
  "version": 1,
  "editor": { "vimMode": false },
  "display": {
    "showLineNumbers": false,
    "showThinkingBlocks": false,
    "showStatusIndicators": false,
    "showStatusLineRunningTime": false,
    "mode": "zen"
  },
  "notifications": true,
  "hints": true,
  "modelSlashCommands": true,
  "steering": true,
  "rewind": true,
  "hasChangedDefaultModel": false,
  "exploreSubagentModel": "default",
  "permissions": { "allow": ["Shell(ls)"], "deny": [] },
  "approvalMode": "allowlist",
  "autoAcceptWebSearch": false,
  "sandbox": { "mode": "disabled", "networkAccess": "user_config_with_defaults" },
  "runEverythingSettingsPromptStreak": 0,
  "network": { "useHttp1ForAgent": false },
  "attribution": { "attributeCommitsToAgent": true, "attributePRsToAgent": true }
}
```

Documented additional fields: `channel`, `model`, `maxMode`, `suggestNextPrompt`,
`sandbox.readBoundary` (`system` default | `workspace`). Documented semantics:

- `approvalMode`: `allowlist` | `auto-review` | `unrestricted`.
- Config is self-repairing; corrupt files are moved to `.bad` and recreated.
- Only `permissions` may be set at project level (`<project>/.cursor/cli.json`).

**Permission token grammar** (DOCUMENTED):

```
Shell(commandBase)      Shell(git)  Shell(curl:*)        # first token; glob; optional command:args
Read(pathOrGlob)        Read(src/**/*.ts)  Read(.env*)
Write(pathOrGlob)       Write(package.json)  Write(**/*.key)
WebFetch(domainOrGlob)  WebFetch(*.example.com)  WebFetch(*)
Mcp(server:tool)        Mcp(datadog:*)  Mcp(*:search)
```

Matching rules: globs `**`/`*`/`?`; relative paths scoped to workspace; absolute paths may target
outside; **deny > allow**; `command:args` globs.

**`permissions.json`** — a *different* plane (DOCUMENTED):

```json
{
  "autoRun": {
    "allow_instructions": [],
    "block_instructions": [
      "Every AWS CLI command should go through approval first."
    ]
  }
}
```

These are **plain-English instructions to an LLM classifier**, merged user + project, with a team-level
configuration overriding both. This is policy-as-prompt, not policy-as-code — see §13 REJECT.

**`sandbox.json`** (DOCUMENTED, and confirmed by the observed runtime policy object):

| Field | Type | Default | Meaning |
|---|---|---|---|
| `type` | string | `workspace_readwrite` | `workspace_readwrite` \| `workspace_readonly` \| `insecure_none` |
| `additionalReadwritePaths` | string[] | `[]` | extra RW roots |
| `additionalReadonlyPaths` | string[] | `[]` | extra RO roots |
| `readBoundary` | `system` \| `workspace` | `system` | `workspace` prompts before reads outside workspace |
| `additionalReadPaths` | string[] | `[]` | read allowlist used only with `readBoundary: workspace` |
| `disableTmpWrite` | bool | false | remove default `/tmp` write |
| `enableSharedBuildCache` | bool | false | share npm/cargo/pip caches with unsandboxed runs |
| `networkPolicy.default` | `allow`\|`deny` | `deny` | default egress verdict |
| `networkPolicy.allow[]` | string[] | `[]` | domain / `*.domain` / CIDR |
| `networkPolicy.deny[]` | string[] | `[]` | highest priority |

Merge order (DOCUMENTED): `per-user < per-repo < team-admin < hardcoded`. Paths union; `readBoundary`
per-repo replaces per-user; network allow unions **unless** a team allowlist exists (then it replaces);
deny always unions; `deny` wins over `allow` for `default`; restrictive booleans OR to `true`.

Hard-coded protections that no local file can weaken (DOCUMENTED): `.cursor/**/*.json`,
`.cursor/.workspace-trusted`, `.claude/**/*.json`, `.vscode/**`, `.code-workspace`, `.git/hooks/**`,
`.git/config`, `.git/info/attributes`, `.cursorignore` are write-protected; `.cursor/{rules,commands,worktrees,skills,agents}`
remain writable. Private/RFC1918 ranges, `127.0.0.0/8`, `169.254.169.254` (metadata), and IPv6
private ranges are blocked by default to prevent SSRF.

**Observed runtime policy envelope** (`cursor-agent sandbox run echo hello`):

```json
{
  "type": "workspace_readwrite",
  "readBoundary": "system",
  "networkPolicy": { "version": 1, "default": "deny" },
  "additionalReadwritePaths": [],
  "additionalReadonlyPaths": [],
  "ignoreMapping": {
    "/home/<user>/<repo>": [],
    "/home/<user>": [],
    "/home": []
  }
}
```

`ignoreMapping` (undocumented in this shape) maps each ancestor of the workspace to gitignore-style
patterns — the mechanism by which `.gitignore`/`.cursorignore` are enforced inside the sandbox.

### 3.3 Tool surface

Documented tool families: file read/write/edit, shell, search (ripgrep-backed), web fetch, MCP tools,
subagents, and Cloud-Agent-only computer/browser control. `stream-json` reveals three concrete wire
shapes (DOCUMENTED):

- `tool_call.readToolCall.args {path}` → `result.success {content,isEmpty,exceededLimit,totalLines,totalChars}`
- `tool_call.writeToolCall.args {path,fileText,toolCallId}` → `result.success {path,linesCreated,fileSize}`
- generic `tool_call.function {name,arguments}` for everything else.

That is a *very* thin published tool contract compared with HorizonCode's `§33` catalog: there is no
published per-tool JSON Schema, no effect class, no idempotency hint, and no capability ID. Clients
that need to reason about Cursor tool calls must parse `call_id` + `name` strings.

### 3.4 Headless / machine protocol

**`--print`** is the machine mode (DOCUMENTED):

- Without `--force`, "changes are only proposed, not applied".
- `--output-format text` = final assistant message only (no tool summaries).
- `--output-format json` = one object on success; **no** well-formed JSON and non-zero exit on failure.
- `--output-format stream-json` = NDJSON, one event per line.

**`json` terminal object**

```json
{
  "type": "result", "subtype": "success", "is_error": false,
  "duration_ms": 1234, "duration_api_ms": 1234,
  "result": "<full assistant text>", "session_id": "<uuid>", "request_id": "<optional>"
}
```

**`stream-json` event set**

| `type` | Subtype | Payload |
|---|---|---|
| `system` | `init` | `apiKeySource` (`env\|flag\|login`), `cwd`, `session_id`, `model`, `permissionMode` |
| `user` | — | `message.role=user`, `message.content[{type:"text",text}]` |
| `assistant` | — | `message.role=assistant`, `content[{type:"text",text}]`; with `--stream-partial-output` also `timestamp_ms` / `model_call_id` |
| `tool_call` | `started` / `completed` | `call_id`, `tool_call.{readToolCall\|writeToolCall\|function}` |
| `result` | `success` | same object as `json` mode |

**Duplicate-emission rule (important and awkward):** with `--stream-partial-output`, three kinds of
`assistant` events are emitted and *consumers must dedupe*: (a) streaming delta with `timestamp_ms`
and no `model_call_id` — use it; (b) buffered flush before a tool call with both fields — skip;
(c) final flush at turn end with neither — skip. The docs instruct consumers to drop (b) and (c)
explicitly. This is a compatibility contract that pushes correctness onto every client.

**Error semantics** (DOCUMENTED + OBSERVED): failures exit non-zero and write to stderr; the stream may
end early **without** a terminal event, so a consumer cannot distinguish "cancelled", "crashed", and
"truncated transport" from the stream alone and must re-read state out-of-band (for Cloud Agents, via
`GET /v1/agents/{id}/runs/{runId}`).

**ACP mode** (`cursor-agent acp`, DOCUMENTED): stdio, JSON-RPC 2.0, newline-delimited JSON, logs on
stderr. Flow: `initialize` → `authenticate{methodId:"cursor_login"}` → `session/new` (or `session/load`)
→ `session/prompt` → `session/update` notifications → `session/request_permission` → optional
`session/cancel`. Permission decisions are exactly `allow-once`, `allow-always`, `reject-once`.
Cursor extension methods: blocking `cursor/ask_question`, `cursor/create_plan`; notification
`cursor/update_todos`, `cursor/task`, `cursor/generate_image`. Team-level MCP servers are *not* honoured
in ACP mode (DOCUMENTED) — an explicit scope reduction worth noting because it means the same product
has different capability sets per transport.

### 3.5 Auth model

| Method | Where | Tag |
|---|---|---|
| Browser login (`agent login`, `NO_OPEN_BROWSER` to suppress) | interactive | DOCUMENTED |
| `--api-key` / `CURSOR_API_KEY` | scripts/CI | DOCUMENTED + OBSERVED error text |
| `CURSOR_AUTH_TOKEN` / `--auth-token` | worker/session tokens | DOCUMENTED (error text + ACP page) |
| Service-account API key (Enterprise, `--pool` workers) | pool registration/claim | DOCUMENTED |
| User-scoped worker token (`POST /v0/private-workers/token` family) | My Machines worker | DOCUMENTED |
| AWS Bedrock credentials (`bedrock configure --from-env`) | alternate inference | DOCUMENTED |
| `status --format json` → `{status,isAuthenticated,hasAccessToken,hasRefreshToken,message}` | health probe | OBSERVED |

Observed unauthenticated error strings (useful as a taxonomy baseline):

```
Error: Authentication required. Run 'agent login', pass --api-key/--auth-token, or set CURSOR_API_KEY/CURSOR_AUTH_TOKEN.
Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY environment variable.
{"status":"unauthenticated","isAuthenticated":false,"hasAccessToken":false,"hasRefreshToken":false,"message":"Not logged in"}
```

Note the inconsistency: two different "authentication required" messages for `models`/`--list-models`
versus `-p`, and `status` exits **0** while reporting unauthenticated. `about --format json` also exits 0
and returns `subscriptionTier: null`, `userEmail: null`, `latestStatus: "up_to_date"` — i.e. the CLI
performs an update check even when logged out (network egress on a bare `about`).

### 3.6 Sessions, resume and persistence

- `session_id` is a UUID, stable for one agent execution (DOCUMENTED).
- `--resume [chatId]`, `--continue` (alias `--resume=-1`), `ls` (interactive picker), `resume`.
- `create-chat` creates an empty chat and prints its ID (OBSERVED: a UUID was printed before the
  process blocked on network; it timed out at 12 s with exit 124).
- `persist` — "Start or manage Cursor sessions that survive terminal and SSH disconnects" with
  `persist list|attach <session>|stop <session>` (OBSERVED help only; the docs index I fetched has no
  `persist` page). Semantics, daemonization, and storage are `UNVERIFIED`.
- `ls` requires a TTY: with piped stdin it crashes inside Ink (`Raw mode is not supported …`) and
  hangs. This is an observed robustness gap in a scripted environment.

### 3.7 Rules, skills, subagents, plugins

**Rules** (DOCUMENTED + OBSERVED):

| Source | Scope | Semantics |
|---|---|---|
| `.cursor/rules/*.mdc` | project | frontmatter `description`, `globs`, `alwaysApply`; `.md` ignored (no frontmatter) |
| `.cursorrules` | project (legacy) | loaded (OBSERVED) |
| `AGENTS.md` | project root **and nested subdirectories** | plain markdown; nested instructions combine, more specific wins |
| `CLAUDE.md` | project root | read "as rules alongside `.cursor/rules`" (DOCUMENTED) |
| User Rules | per-user | global preferences |
| Team Rules | team/enterprise | dashboard-managed; precedence **Team → Project → User**; enforced rules cannot be disabled |

Application matrix for `.mdc`: `alwaysApply:true` → always; `false` + `globs` → auto-attach on matching
context; `false` + `description` → agent pulls it when relevant; `false` + neither → only by `@`-mention.
Referenced files (`@template.ts`) are **not** inlined — the agent reads them on demand (DOCUMENTED).

Observed discovery: a probe workspace with `AGENTS.md`, two `.mdc` rules, and `.cursorrules`, launched
from a nested `sub/` directory, logged `LocalCursorRulesService load completed {ruleCount: 4}` — i.e.
all four were discovered by walking up to the project root. A separate launch in a directory with no
rules logged `ruleCount: 1` (the enclosing repository's `AGENTS.md`), confirming ancestor discovery is
not limited to the immediate workspace.

A second service, `CursorPluginsAgentSkillsService`, logs `{ruleCount, skillCount}` — plugin/skill
discovery is a distinct loader from project rules.

**Skills** (DOCUMENTED): `SKILL.md` with YAML frontmatter — required `name`, `description`; optional
`license`, `allowed-tools`, `metadata`, `disable-model-invocation`, `paths`. Roots: `.cursor/skills/`,
`.agents/skills/` (project), `~/.cursor/skills/`, `~/.agents/skills/` (user). Recursive discovery;
a `.cursor/skills/` anywhere in a monorepo is scoped to that subtree automatically. This aligns with the
cross-vendor **Agent Skills** convention also used by Devin (§8.6) and by HorizonCode's `§29.6`.

**Subagents** (DOCUMENTED): built-in names include `explore`, `debug`, `shell`, `computerUse` (the Cloud
API rejects custom subagent names that collide with these). Custom subagents are per-agent definitions
with a model choice; `exploreSubagentModel` in the CLI config selects the model used for exploration.

**Plugins** (DOCUMENTED): two formats.
- **Agent Plugins** (open standard): root `plugin.json` with
  `$schema: https://agent-plugins.org/schemas/1.0.0/plugin.schema.json`, bundling `skills/` and `mcp.json`.
- **Cursor Plugins**: `.cursor-plugin/plugin.json` (only `name` required) + `rules/`, `skills/`,
  `agents/`, `commands/`, `hooks`, `mcp.json`, plus Cursor-specific variables.
Marketplaces are **git repositories** indexed per ref (`plugin marketplace add <gitUrl> --git-ref`),
with team marketplaces and a publish flow for team skills. Local testing via `~/.cursor/plugins/local`
or `--plugin-dir`. The existence of a vendor-neutral plugin manifest is architecturally significant:
it makes plugin content portable across agents and reduces lock-in.

**Worktrees** (DOCUMENTED): `-w` creates `~/.cursor/worktrees/<reponame>/<name>`; setup steps come from
`.cursor/worktrees.json` with keys `setup-worktree-unix`, `setup-worktree-windows`, `setup-worktree`
(array of commands or a script path), with `$ROOT_WORKTREE_PATH` available. Cleanup uses "the same
retention rules as editor worktrees" — i.e. **time/count-based garbage collection**, not lease-based.

### 3.8 MCP

`mcp.json` (OBSERVED shape + DOCUMENTED):

```json
{
  "mcpServers": {
    "stdio-server": {
      "command": "npx", "args": ["-y", "mcp-server"],
      "env": { "KEY": "${env:KEY}" }, "envFile": ".env", "type": "stdio"
    },
    "remote": {
      "url": "https://api.example.com/mcp",
      "headers": { "Authorization": "Bearer ${env:TOKEN}" },
      "auth": { "CLIENT_ID": "…", "CLIENT_SECRET": "…", "scopes": ["…"] }
    }
  }
}
```

- Transports: `stdio`, `SSE`, `Streamable HTTP` (DOCUMENTED table); MCP Apps extension supported.
- OAuth: authorization-code + PKCE; reads RFC 9728 protected-resource metadata and RFC 8707 resource
  indicator; dynamic client registration by default, static `CLIENT_ID`/`CLIENT_SECRET` override.
  Fixed redirect URIs: `https://www.cursor.com/agents/mcp/oauth/callback` (web/agents) and
  `http://localhost:8787/callback` (desktop).
- Interpolation in `command`, `args`, `env`, `url`, `headers`: `${workspaceFolder}`, `${env:VAR}`.
- Approval: per-server local approved list, managed by `mcp enable|disable`, bypassed globally by
  `--approve-mcps`. `mcp list` prints `<server>: <status>` (OBSERVED `rea: ready`).
- Scope: project + user only; team-distributed MCP comes through team marketplaces, and is **not**
  available in ACP mode.

### 3.9 Hooks

`hooks.json` (DOCUMENTED): `{ "version": 1, "hooks": { "<event>": [ entry… ] } }`.

| Field | Type | Default | Meaning |
|---|---|---|---|
| `command` | string | — | shell command; JSON on stdin, JSON on stdout |
| `type` | `"command"` \| `"prompt"` | command | prompt hooks call an LLM ("fast model", optional `model`) |
| `prompt` | string | — | for prompt hooks; `$ARGUMENTS` replaced with hook input JSON |
| `timeout` | number (s) | platform default | per-invocation timeout |
| `matcher` | string (regex-ish) | — | e.g. `"curl\|wget\|nc"` for shell hooks |
| `loop_limit` | number \| null | `5` | stop/subagentStop auto-follow-up cap |
| `failClosed` | bool | `false` | block on crash/timeout/non-zero instead of allowing |

Events: `sessionStart`, `sessionEnd`, `preToolUse`, `postToolUse`, `postToolUseFailure`,
`beforeShellExecution`, `afterShellExecution`, `beforeReadFile`, `afterFileEdit`, `beforeSubmitPrompt`,
`stop`, `beforeMCPExecution`, `beforeTabFileRead`, plus `subagentStart`/`subagentStop` and Tab hooks.

**Exit-code matrix** (DOCUMENTED, and the most important design detail):

| Exit | Effect |
|---|---|
| `0` | Use stdout JSON. For *permission* hooks (`beforeShellExecution`, `beforeMCPExecution`, `beforeReadFile`, `beforeTabFileRead`, `subagentStart`, `preToolUse`), invalid JSON **blocks** the action |
| `2` | Block (equivalent to `permission:"deny"`) |
| other | Hook "failed", action proceeds — **fail-open by default** |

`failClosed:true` converts crashes/timeouts/other-exit into a block. Output may include
`permission: allow|deny|ask`, `user_message`, `agent_message`, `updated_input` (rewrite),
`additional_context`, and `continue`. `updated_input` is ignored by cloud agents for `preToolUse`; for
HTTP MCP tools cloud `postToolUse` only receives `{"redacted": true}` (DOCUMENTED) — another per-surface
capability divergence.

**Hook reach differs by surface** (DOCUMENTED): cloud agents do not run `sessionStart`/`sessionEnd`
("deferred while cloud agents can still start in a read-only environment"); user-level hooks from
`~/.cursor/hooks.json` are unavailable in cloud VMs because the local home is not mounted.

### 3.10 Cloud Agent API (resource contracts)

Base `https://api.cursor.com`; auth `Basic` (key as username) **or** `Bearer`; user API key or
service-account key (DOCUMENTED). Every list endpoint uses opaque `nextCursor`, and the cursor is
**omitted** (not `null`) at the end — a client that tests for `null` will loop.

| Resource | Key surface |
|---|---|
| Agent | `POST /v1/agents`, `GET /v1/agents`, `GET /v1/agents/{id}`, archive/unarchive/delete, `GET /v1/agents/{id}/usage` |
| Run | `POST /v1/agents/{id}/runs`, `GET …/runs`, `GET …/runs/{runId}`, `GET …/stream`, `POST …/cancel` |
| Artifacts | `GET /v1/agents/{id}/artifacts`, `GET …/artifacts/{artifactId}/download` |
| Environment | CRUD, `history`, `builds`, `active build`, start build |
| Secrets | team, environment, personal: list/set/delete |
| Workers/pools | worker tokens, workers, summary, by id, pools list/register/deregister, pending requests list/watch, claim, session token, release, fail |
| Metadata | `/v1/me` (API key info), `/v1/models`, `/v1/repositories` (very strict rate limit) |

**`POST /v1/agents` request** (DOCUMENTED):

```
prompt.text (required) | prompt.images[≤5, ≤15 MB, png|jpeg|gif|webp, data+mimeType or url]
repos[].url + startingRef          # provider-agnostic URL incl. self-hosted hosts
model.id + model.params[{id,value}] # must come from GET /v1/models
autoCreatePR, skipReviewerRequest
envVars{≤50, name ≤255B, value ≤4096B, name may not start with CURSOR_}
mcpServers[≤50] {name, type: http|sse|stdio, url|command+args+env, headers|auth}
customSubagents[≤20] {name, description, prompt, model|"inherit"}  # names may not collide with built-ins
mode: agent|plan
agentId: "bc-<uuid>"               # client-supplied for idempotency; re-POST → 409 agent_id_conflict
```

Two contract details matter for HorizonCode:
1. `agentId` is the only idempotency mechanism, and it **conflicts** with `envVars` (server must mint the
   id when secrets are supplied) — a real coupling between identity and secret scoping.
2. `envVars` is documented as silently ignored when the beta is not enabled ("If it isn't enabled for
   your account yet, the field is silently ignored on create rather than failing"). Silent field
   ignoring is an anti-contract; a client cannot tell success from no-op.

**Run state machine** (DOCUMENTED): `CREATING → RUNNING → WAITING_FOR_BACKGROUND_WORK → FINISHED |
ERROR | CANCELLED | EXPIRED`. Only one run may be active per agent; a second non-steer run returns
`409 agent_busy`. `durationMs`, `result`, and `git.branches[{repoUrl,branch,prUrl}]` are populated only
for terminal runs, and `git` is **per-agent, not per-run** — every run of the same agent returns the
same branch snapshot, which the docs explicitly warn about.

**Steering** (DOCUMENTED): `POST /runs` with `delivery:"steer"` returns `202` with
`{delivery:"steered"|"queued"}` and **no run id**; "runs don't carry the prompt or any request ID, so you
can't match a steer to a run"; and "a steer that fails with a server or network error may still have
reached the agent. Cursor treats a retry as a new prompt, so retrying can deliver the prompt twice."
That is a documented at-least-once, non-idempotent delivery hazard with no reconciliation handle.

**SSE stream** `GET /v1/agents/{id}/runs/{runId}/stream` (DOCUMENTED):

| Event | Payload |
|---|---|
| `status` | `{runId,status}` — sticky, resent at top of every reconnect, **no `id`** |
| `assistant` | `{text}` delta |
| `thinking` | `{text}` delta |
| `tool_call` | `{callId,name,status:"running"\|"completed",args?,result?,truncated?}` |
| `interaction_update` | optional richer SDK-shaped event (`text-delta`, `tool-call-started`, `step-started`, `turn-ended`, …) |
| `heartbeat` | `{}` |
| `result` | `{runId,status,text?,durationMs?,git?}` |
| `error` | `{code,message}` |
| `done` | `{}` |

Resume: `Last-Event-ID` with an id "that must belong to the requested run", else
`400 invalid_last_event_id`. Retention: `X-Cursor-Stream-Retention-Seconds`; after it expires the
endpoint may return `410 stream_expired`, and the client must fall back to `GET run`. That is a
**good** contract: explicit cursor, explicit expiry, explicit fallback. HorizonCode's event cursor/ACK
model is the analogue, but Cursor's is per-stream and per-run, not a durable session log.

**Error taxonomy seen in the API reference**: `400 validation_error`, `400 invalid_last_event_id`,
`404 run_not_found`, `409 agent_busy`, `409 agent_id_conflict`, `410 stream_expired`,
`403 feature_unavailable`, `429` (rate limits, per-endpoint). Not a single unified error envelope is
published for v1 — codes are string literals embedded per endpoint.

### 3.11 Usage / cost contract

- `GET /v1/agents/{id}/usage` returns `totalUsage` and per-run `usage`
  `{inputTokens, outputTokens, cacheWriteTokens, cacheReadTokens, totalTokens}` (DOCUMENTED).
- The docs admit attribution holes: without `runId`, totals include "Task subagents and side chats, and
  usage not tied to a run"; given a `runId`, the window attributes subagent usage to the run that was
  active. This is *accounting by time window*, not by causal attribution.
- No per-agent or per-run **budget cap** exists in the create request; spend control is at team/user
  level (`set-user-spend-limit`, `spend-limits` help pages) and plan quota.

## 4. Execution flows (Cursor)

### 4.1 Local interactive turn

```
argv/UI → config load (cli-config.json + project cli.json) → rules/skills/plugins discovery
        → MCP servers staged & approved (mcp.json + approved list)
        → workspace trust check (--trust bypasses prompt)
        → model call (api2.cursor.sh) with tool defs filtered by mode (agent|plan|ask)
        → tool proposal → permission plane A (allow/deny tokens) → plane B if Auto-review
        → sandbox decision (--sandbox/config) → execute (or prompt)
        → tool result → next model turn … → final message → session store + debug log
```

Observable evidence: debug log lines `LocalCursorRulesService load completed`, `sandbox.configureSuccess`,
`ripgrep.configureSuccess`, `analytics.track {eventName:"cli.launch"}`, `statsig.initialize.success`.

### 4.2 Local headless / CI run

```
agent -p --output-format stream-json --force "<prompt>"
  → system/init {apiKeySource,cwd,session_id,model,permissionMode}
  → assistant / tool_call(started|completed) … → result
```

Failure path: non-zero exit, stderr message, stream may end without `result`. Cancellation is process
cancellation (SIGINT); there is no published "cancel receipt" — the caller must infer state from exit
code and absence of `result`.

### 4.3 Cloud Agent run (end to end)

```
POST /v1/agents {prompt, repos, model, autoCreatePR, mcpServers, …}
  → agent bc-<uuid> + initial run run-<uuid> (status CREATING)
  → environment/build selection → VM provision → repo clone + setup
  → agent loop inside VM (shell/file/MCP/computer)
  → GET /runs/{runId}/stream (SSE) for progress; heartbeats; interaction_update
  → terminal: FINISHED (+result, git.branches[{branch,prUrl}]) | ERROR | CANCELLED | EXPIRED
  → optional follow-up: POST /runs {prompt} | {delivery:"steer"} | POST /cancel
  → artifacts listed/downloaded; agent archived or deleted
```

Failure/cancel/resume specifics that are documented:
- **Cancel**: `POST /v1/agents/{id}/runs/{runId}/cancel`; terminal status `CANCELLED`.
- **Resume**: there is no run-resume. Continuity is "new run on same agent" (conversation + workspace
  state carry over). A *disconnected stream* is resumed by `Last-Event-ID`, not by re-running.
- **Expiry**: `EXPIRED` is a terminal run status (e.g. environment/session lifetime), distinct from
  `ERROR`.
- **Steer** while `RUNNING`: `202`, possibly `queued`, no run id, retry may duplicate.
- **Artifacts**: cloud artifacts are separate resources, not files in the repo; the durable code output
  is a pushed branch/PR (`git.branches`).

### 4.4 Self-hosted worker claim (Cloud Agent on your machine)

Documented controller loop (binary help is the richest source):

```
GET  /v0/private-workers/pending-requests/stream   (SSE, primary dispatch; best-effort)
GET  /v0/private-workers/pending-requests?pool=…   (60 s reconcile list)
POST /v0/private-workers/claim {id, workerId, sessionToken?, identityToken{audience,nonce}}
   → {token(+7 d), identityToken.token(+5 min), …}
exec --spawn hook with CURSOR_API_KEY|CURSOR_AUTH_TOKEN, CURSOR_AGENT_WORKER_ID,
     CURSOR_API_URL, request fields; on wake: CURSOR_WAKE=1 + CURSOR_WAKE_TIMEOUT_MS
worker runs; on end: POST release (or fail)
```

Claim semantics (DOCUMENTED): a second claim while a live claim exists is rejected; `sessionToken`
mints a token that "serves only this claim" and dies on release or key deletion; `identityToken` is an
OIDC JWT naming agent+owner+`workerId`, valid 5 minutes, with caller-supplied `audience` and `nonce`.
Warm-pool mode pre-spawns unclaimed workers and never calls claim (server assigns); the docs warn that
concurrent warm controllers can transiently over-spawn because "without claim there is no server-side
lease".

Operational surface: `--management-addr` exposes `/healthz`, `/readyz`, `/metrics` (Prometheus text);
`--data-dir` defaults to `/opt/cursor` if writable else `~/.local/share/cursor-agent`; worker exits 0 on
idle release so a supervisor restarts clean. Credential-delivery flags (`--mint-github-token`,
`--clone-git-repos`, `--sync-dashboard-secrets`) are explicitly "one credential-enabled worker per OS
user/container" because shared git/gh/env state can leak one run's credentials into another.

### 4.5 Worktree flow

```
agent -w [name] [--worktree-base ref] "<task>"
  → git worktree add ~/.cursor/worktrees/<repo>/<name> (base = HEAD or ref)
  → run .cursor/worktrees.json setup-worktree-unix|-windows|-worktree steps
  → agent edits inside the worktree
  → user reviews; commit/PR from that checkout; retention-based cleanup later
```

No lease record, no quarantine state, no process/port ownership — cleanup is retention-based
(DOCUMENTED). This is the clearest architectural gap versus HorizonCode `§21.4`.

## 5. Cost, permission and sandbox model (Cursor)

### 5.1 Cost

- Plan quota + on-demand usage; team/user spend limits; per-agent token usage reporting.
- No hidden model fallback is *claimed*: `GET /v1/models` is authoritative for ids/params, and a create
  request with an unsupported `model.params` is a validation error (DOCUMENTED).
- However, `about` performs an update check while unauthenticated, and statsig gates are fetched on
  every launch (OBSERVED) — i.e. there is network egress and server-side behaviour control even with no
  account, which a strict "no hidden remote control" policy would have to whitelist explicitly.

### 5.2 Permission model

| Plane | Mechanism | Determinism | Scope |
|---|---|---|---|
| A | `permissions.allow/deny` tokens in `cli-config.json` / project `cli.json` | deterministic | shell, read, write, web fetch, MCP |
| A' | `--force` / `--yolo` | deterministic bypass of prompts, still honours explicit `deny` (help text) | shell/file |
| B | Auto-review classifier + `permissions.json` natural-language instructions | **non-deterministic**, cloud LLM | shell, MCP, fetch |
| C | Sandbox (`sandbox.json`) | OS-enforced for shell only | filesystem + network |
| D | MCP approval list (`mcp enable/disable`, `--approve-mcps`) | deterministic | MCP servers |
| E | Workspace trust (`--trust`) | one-shot | project hooks/rules activation |

Documented classifier order: allowlisted calls run immediately; other shell commands run in the sandbox
"when possible"; commands that cannot be sandboxed (need network, writes outside workspace, privileged
ops) and sandbox failures go to the classifier; the classifier may make read-only `ReadFile`, `Grep`,
`Glob`, `ListDir` calls on the user's machine to judge. It runs on "small Cursor-managed models"
(currently Gemini 3.5 Flash Lite, Haiku fallback). Enterprise model-access controls can disable it.

Two consequences HorizonCode must not copy:
1. A **blocked** classifier verdict is not final — "if the agent decides that the action makes sense
   despite what the classifier said, Cursor will show you an approval prompt." The model can argue its
   way past the judge.
2. The judge is a **hidden paid dependency** whose availability changes with team model policy.

### 5.3 Sandbox model (observed behaviour + documented policy)

| Probe | Command | Result |
|---|---|---|
| Basic exec | `sandbox run echo hello` | success; prints full policy object |
| Read outside workspace | `sandbox run cat /etc/hostname` | success — `readBoundary:"system"` allows system reads |
| Write outside workspace | `sandbox run touch ../../../escape-probe.txt` | **exit 1**, file not created |
| Network default | `sandbox run -- curl https://example.com` | curl exit 6 "Could not resolve host" (DNS denied) |
| Network allowed | `sandbox run --network -- curl https://example.com` | HTTP 200 |
| Debug artefacts | `sandbox run --sb-debug -- echo debugok` | writes `stdout-*.log`/`stderr-*.log` under `$TMPDIR/cursor-sandbox-*` |

Mechanism evidence (OBSERVED logs, no binary inspection): a colocated `cursorsandbox` helper is resolved
at startup (`sandbox.configureSuccess {"sandboxBinary":"…/cursorsandbox","sandboxSource":"colocated"}`),
and a preflight runs before launching (`[isSandboxHelperSupported] Preflight succeeded in 12ms`). The
helper, not the JS process, performs confinement. The implementation technology is not documented and
was not inspected → `UNVERIFIED`.

Notable design choices:
- The sandbox is **opt-in** at the CLI level (`sandbox.mode` default `disabled`; `--sandbox enabled`).
  `--force` does **not** imply sandboxing.
- `ignoreMapping` means `.gitignore`/`.cursorignore` patterns are handed to the sandbox as path masks.
- `enableSharedBuildCache` deliberately punches a hole so sandboxed and unsandboxed builds share caches —
  a performance/security trade the user must choose.

### 5.4 What is cloud-mediated vs local (Cursor)

| Capability | Local CLI | Cloud Agent | Evidence |
|---|---|---|---|
| Model inference | cloud (`api2.cursor.sh`) | cloud | OBSERVED endpoint default / DOCUMENTED |
| Tool execution | local process | VM | DOCUMENTED |
| Sandbox | local `cursorsandbox` | VM isolation (opaque) | OBSERVED / DOCUMENTED |
| Auto-review classifier | cloud | cloud | DOCUMENTED |
| Feature gates | cloud (statsig) | cloud | OBSERVED |
| Background agents / Bugbot / security agents | — | cloud | DOCUMENTED (index) |
| Tab models / completions | editor-only, not CLI | — | DOCUMENTED (index; rules "do not impact Cursor Tab") |
| Session durability | local (format `UNVERIFIED`) | backend resources | OBSERVED creation / DOCUMENTED |
| Worktrees | local git | n/a (VM per agent) | DOCUMENTED |

---

# Part B — Devin

## 6. Provenance (Devin)

| # | Source | What it yielded | Tag |
|---|---|---|---|
| P11 | `https://docs.devin.ai/llms.txt` | Documentation index + the `_llms` structure; exposes OpenAPI downloads | `DOCUMENTED` |
| P12 | `docs/devin/v3-openapi.yaml` (829,761 B, 27,617 lines, OpenAPI 3.1, `Devin API v3`, 161 paths, 269 schemas) | Authoritative resource/payload/enum contracts for sessions, playbooks, knowledge, blueprints, automations, secrets, consumption, enterprise RBAC | `DOCUMENTED` |
| P13 | `docs/devin/v1-openapi.yaml` (40,480 B) | Legacy v1 surface: `/v1/sessions`, `/v1/knowledge`, `/v1/playbooks`, `/v1/secrets`, `/v1/attachments`, `/v1/enterprise/consumption`; keys `apk_user_*` / `apk_*` | `DOCUMENTED` |
| P14 | `docs/devin/cli__reference__commands.md` | Global flags, subcommands, exit-shape, modes, profiles, `--export` (ATIF) | `DOCUMENTED` |
| P15 | `docs/devin/cli__reference__configuration__config-file.md` | Full config schema, file locations, JSON-with-comments, migration path for MCP | `DOCUMENTED` |
| P16 | `docs/devin/cli__reference__permissions.md` | Mode matrix, rule grammar, precedence, specificity carve-outs | `DOCUMENTED` |
| P17 | `docs/devin/cli__sandbox.md` | bwrap+seccomp / macOS seatbelt, fail-closed resolution, excluded commands, enterprise enforcement | `DOCUMENTED` |
| P18 | `docs/devin/cli__extensibility__hooks__{overview,lifecycle-hooks}.md` | Hook events, matcher semantics, stdin fields, `hookSpecificOutput`, exit-2 block | `DOCUMENTED` |
| P19 | `docs/devin/cli__subagents.md` | Profiles, model resolution, background auto-deny, resume semantics, nesting | `DOCUMENTED` |
| P20 | `docs/devin/cloud__outposts__{reference,orchestration,overview}.md` | Worker CLI, fleet API (`opbeta/outposts`), list-then-watch cursors, claim CAS, spawn contract, binary distribution | `DOCUMENTED` |
| P21 | `docs/devin/onboard-devin__environment__blueprint-reference.md` (28,593 B) | Blueprint schema: `initialize` / `maintenance` / `knowledge` / `runs-on` / `shell` / `post-build` / `clone`, step types, `$ENVRC` | `DOCUMENTED` |
| P22 | `docs/devin/product-guides__security-profiles.md` | Network/MCP/git/gh-token restrictions, 5-level binding hierarchy, recommended vs mandatory intersection | `DOCUMENTED` |
| P23 | `docs/devin/product-guides__memory.md`, `admin__billing__usage.md`, `work-with-devin__{local-hands,dynamic-workflows,testing-and-recordings,advanced-capabilities}.md` | Memory drive + "Dreaming", ACU metering, Local Hands, Python workflow orchestration, post-PR testing/recording, managed Devins | `DOCUMENTED` |
| P24 | `docs/devin/product-guides__automations.md` (29,235 B) | Trigger sources, conditions, actions, Preflight, concurrency | `DOCUMENTED` |

**Not obtained for Devin:** the `devin` binary itself (no installer fetched within scope), any
authenticated session, any VM, any Outpost. Every Devin claim is therefore `DOCUMENTED` from vendor
material or `UNVERIFIED` inference — there is **no** `OBSERVED` Devin evidence in this report, and the
comparison tables mark that explicitly so no one mistakes schema presence for behaviour.

## 7. High-level design (Devin)

### 7.1 Deployment shapes

Devin is sold as a **cloud-first autonomous engineer**, with three execution placements and three
human-facing transports:

| Placement | Description | Control plane |
|---|---|---|
| **Devin Cloud VM (default)** | One VM per session; cloned repos, built environment, desktop/browser, shell | Cognition backend |
| **Devin Outposts (BYO infrastructure)** | Session runs on the customer's machine via `devin-remote serve`, claimed from an outpost queue | Cognition control plane + customer compute |
| **macOS / Windows / Android emulator VMs** | Platform variants of the same VM model (`runs-on`) | Cognition backend |
| **Local Hands** | A *cloud* session additionally gets tool access to the user's own machine through `devin connect`/Desktop | user machine, per-call approval |

Human/agent transports: web app, Slack, Microsoft Teams, Linear/Jira, GitHub/GitLab/Bitbucket/Azure
DevOps comments, API v1/v2/v3, CLI, Desktop, and the Devin MCP server for other agents.

**Architectural reading:** Devin's centre of gravity is a **durable cloud session bound to a
snapshot-based VM**, with a wide fan-in of event sources and a wide fan-out of deliverables (PRs,
recordings, structured output). The CLI is a *client* that can also run a local agent, and the
Outposts worker is the escape hatch for private compute. This is the inverse of HorizonCode's
local-first, Rust-authority design — and the inverse of Cursor's local-first CLI.

### 7.2 Component map (reconstructed from documented behaviour)

```
                    ┌──────────── triggers ────────────┐
   Slack  Teams  Linear  Jira  GitHub  GitLab  Bitbucket  Azure DevOps
   schedules (cron/one-off)  inbound webhooks  API v1/v2/v3  CLI  Desktop
                    └───────────────┬──────────────┘
                                    ▼
                     ┌──────── Cognition control plane ────────┐
                     │  org/RBAC · sessions · playbooks ·      │
                     │  knowledge · memory · automations ·     │
                     │  security profiles · ACU metering ·     │
                     │  secrets · DeepWiki indexing · review   │
                     └───────┬──────────────────────┬──────────┘
             provision/claim │                      │ SSE/WebSocket/messages
                             ▼                      ▼
        ┌──────────── session VM (or outpost) ────────────┐
        │  snapshot image (blueprint build)               │
        │  repos/ checkout · shell · IDE · browser ·      │
        │  desktop (VNC) · MCP servers · skills · hooks   │
        │  child sessions ("managed Devins")              │
        └─────────────────────────────────────────────────┘
                             │
                             ▼
                 PRs · branch pushes · video recordings · structured output
```

### 7.3 Where state lives

| State | Owner | Tag |
|---|---|---|
| Session record, status, status_detail, ACU, PRs, structured output | Cognition backend (v3 `SessionResponse`) | DOCUMENTED |
| Session messages | backend (`/sessions/{id}/messages`) | DOCUMENTED |
| VM disk + workspace | session VM, preserved when `resumable: true` | DOCUMENTED |
| Environment definition | `.devin/blueprint.yaml` (repo) or DB (org/enterprise); builds → snapshot images | DOCUMENTED |
| Knowledge | backend notes (`note_id`, `folder_path`, `trigger`, `pinned_repo`) | DOCUMENTED |
| Playbooks | backend (`body`, `macro`, `structured_output_schema`, org/enterprise scope) | DOCUMENTED |
| Personal memory | a **git repository of Markdown** ("memory drive") checked out per session | DOCUMENTED |
| Secrets | backend secret store; injected as env / session secrets | DOCUMENTED |
| CLI config | `~/.config/devin/config.json`, `.devin/config.json`, `.devin/config.local.json`, `mcp_config*.json`, MDM `system.json` | DOCUMENTED |
| Outpost queue | backend (`opbeta/outposts`), Kubernetes-style objects + cursor watch | DOCUMENTED |
| Recordings/attachments | backend attachments | DOCUMENTED |
| Audit logs | enterprise API | DOCUMENTED |

### 7.4 What is cloud vs local (Devin)

| Capability | Cloud session | Devin CLI (local) | Evidence |
|---|---|---|---|
| Model inference | Cognition-hosted (mode-dependent) | Cognition-hosted or team gateway | DOCUMENTED |
| Tool execution | VM | local machine | DOCUMENTED |
| Sandbox | VM isolation | `--sandbox` → bwrap+seccomp / seatbelt | DOCUMENTED |
| Planning | in-session, no published planner/executor split | same agent loop | `UNVERIFIED` (internals) |
| Memory | memory drive + Dreaming | reads config/import only | DOCUMENTED |
| Permissions | security profiles + approval policy | rule grammar + modes | DOCUMENTED |
| Knowledge/playbooks | injected server-side | not applicable (CLI has rules/skills) | DOCUMENTED |
| Local machine access | Local Hands (paired, per-call approval) | n/a | DOCUMENTED |
| Outposts | `devin-remote` on customer machine | n/a | DOCUMENTED |

## 8. Low-level design and contracts (Devin)

### 8.1 API surface and auth

| Version | Base path | Auth | Scope |
|---|---|---|---|
| v1 | `/v1/*` | `Authorization: Bearer` — personal `apk_user_*` or service `apk_*` | flat, session-centric |
| v2 | `/v2/*` | same family | (not fetched in depth) |
| v3 | `/v3/organizations/{org_id}/…` and `/v3/enterprise/…` | `Bearer` **service-user credential, prefix `cog_`** | org/enterprise scoped, RBAC |

v3 resources (161 paths), grouped:

- **Sessions**: list/create/get, `archive`/`unarchive`, `messages`, `attachments`, `tags`, `insights`,
  `insights/generate`.
- **Configuration**: `playbooks`, `knowledge/folders`, `knowledge/notes`, `secrets`,
  `snapshot-setup/blueprints` (+ `/contents`, `/files`), `snapshot-setup/builds` (+ `/logs`, `/cancel`,
  `/pin`), `repositories` (+ `/indexing`, branch indexing).
- **Automation**: `automations`, `automations/schemas`, `automations/templates`, `schedules`.
- **Delivery**: `pr-reviews`, `code-scans` (+ profiles, findings, remediate, auto-scan, effort),
  `attachments`.
- **Governance**: `enterprise/{organizations,members,roles,idp-groups,audit-logs,ip-access-list,
  hypervisors,git-providers,org-group-limits,consumption,metrics,queue}`.
- **Meta**: `/v3/self`.

Pagination: `CursorPaginationParams {after, first (default 100, max 200)}`; responses use
`nextCursor`-style opaque cursors. Notably, v3 has **no `If-Match`/ETag contract** on mutable resources
and no idempotency-key header documented — creation is not idempotent by contract (a retried
`POST /sessions` may create a second session).

### 8.2 Session lifecycle contract

**`SessionCreateRequest`** (DOCUMENTED, condensed):

```
prompt (required)
repos[]                            # repository names/paths already connected to the org
playbook_id | child_playbook_id
knowledge_ids[]
secret_ids[] | session_secrets[{…}] | attachment_urls[] | session_links[]
max_acu_limit                      # integer ACU budget for this session
devin_mode: normal|fast|fusion|lite|ultra|swe-2-medium|swe-2-high|swe-2-max
platform                           # e.g. windows, or an outpost pool name; "inherit" for children
resumable: true (default)          # preserve VM state after stop so the session can resume
security_profile: {profile_id|null} # null = explicit opt-out
bypass_approval
create_as_user_id
structured_output_required: true (default)   # agent MUST call provide_structured_output
```

**`SessionResponse`** fields: `session_id`, `status`, `status_detail`, `title`, `url`, `org_id`,
`user_id`, `service_user_id`, `created_at`, `updated_at`, `acus_consumed`, `on_demand_usage`,
`category` (15-value enum, e.g. `bug_fixing`, `migrations_and_upgrades`, `security`), `subcategory`,
`tags`, `pull_requests[{pr_url,pr_state}]`, `parent_session_id`, `child_session_ids`, `playbook_id`,
`automation_id`, `origin` (`webapp|slack|teams|api|linear|jira|automation|cli|desktop|code_scan|other`),
`devin_mode`, `is_archived`, `security_profile{selection: inherit|none|profile, profile_id}`,
`structured_output`.

**State machine** (DOCUMENTED enum + documented detail semantics):

```
new ──► claimed ──► running ──► exit
                       │  ▲        │
                       │  └ resuming
                       ├──► suspended ──► resuming ──► running
                       └──► error
```

| `status` | `status_detail` values (documented) |
|---|---|
| `running` | `working`, `waiting_for_user`, `waiting_for_approval`, `finished` |
| `suspended` | `inactivity`, `user_request`, `usage_limit_exceeded`, `out_of_credits`, `out_of_quota`, `no_quota_allocation`, `payment_declined`, `org_usage_limit_exceeded`, `user_usage_limit_exceeded`, `total_session_limit_exceeded`, `contract_expired`, `error` |
| `new`/`claimed`/`exit`/`error`/`resuming` | none documented |

This is the richest *published* failure taxonomy of the three products: it distinguishes **who** ran out
of budget (org vs user vs session-count vs contract) and **why** a session slept (inactivity vs user
request). HorizonCode's `UNKNOWN`/`CANCELLED`/`EXPIRED` set is semantically different — Devin is
describing *commercial* terminal reasons, not effect-settlement states. Both are needed; they must not
be conflated.

**Message contract**: `POST /v3/organizations/{org}/sessions/{devin_id}/messages`
`{message (required), message_as_user_id?, attachment_urls[]?}`. There is no published message id,
sequence number, or idempotency key — so a retried message is a second message. Consumption endpoints
(`/consumption/daily/sessions/{session_id}`) give per-session ACU/day, not per-effect cost.

### 8.3 Environment and snapshot contract (blueprints)

Blueprint = declarative environment spec in YAML, three scopes (**enterprise**, **org**, **repo**), two
sources (`git` synced from `.devin/blueprint.yaml`, or `database`). Top-level sections:

| Section | Executed? | Purpose |
|---|---|---|
| `initialize` | yes (full builds; skipped on differential builds) | system tools, runtimes, global CLIs |
| `maintenance` | during builds **and surfaced to the agent at session start** (not auto-run) | dependency install/update (`npm install`, `uv sync`, …) |
| `knowledge` | **never** | reference info: how to lint/test/build; each item `{name, contents}` with conventional `lint`/`test`/`build` |
| `runs-on` | build matrix | `default`/`linux` aliases, or registered machines (`windows`, `macos`) |
| `shell` | build steps only | `bash`/`powershell` per block (multi-doc YAML for multi-platform) |
| `post-build` | yes (org/enterprise only) | after all repos cloned; non-zero exit **fails the build**, no snapshot produced |
| `clone` | repo-level only | override clone destination/path defaults |

Step types: shell `run` (with step-level env and cross-step `$ENVRC`), and GitHub Actions `uses`
(`initialize`/`post-build` only; a `uses` in `maintenance` fails the build). Builds run on blueprint
change **and periodically (~24 h)**; results are per-platform snapshot images; builds are addressable
(`GET builds`, `logs`, `cancel`, `pin`) and the active build is queryable.

Architecturally this is a **content-addressed environment artifact**: the session references a snapshot,
so "works on my machine" is replaced by "works in the last successful build of this blueprint". The
`maintenance`-surfaced-not-executed decision is a notable cost/latency trade: sessions do not pay for
`npm install` unless the agent decides it is needed.

### 8.4 Playbooks, knowledge, memory — three different retrieval mechanisms

| Mechanism | Storage | Binding | Retrieval |
|---|---|---|---|
| **Playbook** | backend `body` + `macro` + optional `structured_output_schema`; org/enterprise access | `playbook_id` on session; `macro` in chat | Explicit selection (or automation default); body becomes task instruction |
| **Knowledge** | backend notes: `name`, `body`, `folder_path`, `trigger`, `pinned_repo`, `is_enabled`, `macro` | session `knowledge_ids[]`, org-wide, or repo-pinned | `trigger` is the retrieval key; repo-pinned notes apply to that repo |
| **Memory** | git repo of Markdown; `MEMORY.md` index + topic files | per-user per-org | `MEMORY.md` always in context; other notes read on demand |
| **AGENTS.md** | repo file | repo | auto-injected up to **16 KiB** (documented limit), longer guidance must be referenced |

Two design lessons:
1. **Three tiers with different authority**: playbook (explicit task procedure) ≠ knowledge (reference)
   ≠ memory (learned preference). Collapsing them into one "context" pile loses the ability to say
   "this is a procedure the user chose" vs "this is a fact we inferred".
2. **Memory is a git repo with merge semantics**: per-session checkout, commit on learn, "a stale write
   is rejected and retried, and conflicting edits are resolved rather than overwritten", plus a daily
   background "Dreaming" session that consolidates/dedupes and preserves source links. Entries carry
   `[source: <session url>; added: <date>]`. Automations do **not** read or write memory.

### 8.5 Automations contract

`AutomationCreateRequest` (DOCUMENTED): `name`, `enabled`, `triggers[]` (OR semantics), optional
`conditions` (group tree with `match`, `glob`, `list`, `numeric`, `range`, `recurrence`, `comparison`
leaves), `actions[]` (**at most one `start_session`**; `monitor_session` must be the only action),
`concurrency`, `limits`, `notifications`, `run_as` (**required**: `organization` | `creator` |
`service_user`), `security_profile`, `session_settings`, `slack_reply_access`
(`devin_users|slack_users|external_slack_users`), `metadata` (≤16 pairs), plus a **Preflight** check.

Trigger sources: Slack (message, reaction, user-group mention), GitHub (issue, issue comment, PR
opened/updated, PR review, check run/CI, push), GitLab, Linear, Jira, PagerDuty, Schedule
(cron/one-off), Webhook. Public-repo GitHub triggers are opt-in per connection with an explicit
prompt-injection warning (DOCUMENTED) — a rare case of a vendor shipping the threat model with the
feature.

`run_as` being **required** is a good contract: an automation cannot silently inherit an ambient
identity; the creator must choose org/creator/service-user, which is exactly the kind of explicit
principal binding HorizonCode's lease/owner model needs.

### 8.6 Devin CLI contracts

**Config file**: JSON **with comments** (documented), at
`~/.config/devin/config.json`, `.devin/config.json`, `.devin/config.local.json`, plus
`mcp_config.json`/`mcp_config.local.json` (split out in v3000.3), plus MDM `system.json`.

Key fields (documented defaults):

```
agent.model ("swe-1-6-fast") | agent.subagent_model | agent.show_history_on_continue (true)
theme_mode (null=auto | light | dark | terminal-dark | terminal-light | nocolor)
permissions { allow[], deny[], ask[] }
maxMode? — not present; CLI has no "max" toggle
show_path (false) | unicode_mode ("auto") | show_hints (true)
include_gitignored_files (false) | respect_gitignore (false)
attribution (true)                     # "Generated with Devin" + Co-Authored-By
subagents_enabled (true)               # live-applies; removes run_subagent/read_subagent
keymap { context: { action: "spec" | ["spec"] | [] } }   # Ctrl+C cancel cannot be unbound
auto_update (true)                     # staged temp + atomic rename + file lock
notify ("never"|"smart"|"always")      # BEL + OSC 9 + OSC 777
read_config_from { agents_standard, cursor, windsurf, claude, copilot, opencode, zed, cloud } (all true)
proxy { mode: system|manual|off, url, no_proxy }
sandbox { allowed_domains[], denied_domains[], network_mode: full|limited, excluded{allow,ask,deny} }
local_tools_bypass_permissions (false)
```

**`read_config_from` is the single most interesting CLI decision for HorizonCode.** By default Devin
imports rules, skills, commands, and MCP servers from **Cursor, Windsurf, Claude Code, GitHub Copilot,
OpenCode, Zed, and `AGENTS.md`**, and loads MCP + personal plugins from the Devin Cloud account. That is
a deliberate compatibility moat: switching cost is lowered to zero by reading the competitor's files
rather than asking for migration.

**Permissions grammar** (DOCUMENTED):

```
Read(glob)      Read(src/**)  Read(~/projects/x/**)  Read(/**)
Write(glob)     Write(tests/**)
Exec(prefix)    Exec(git)  Exec(npm run)     # prefix must match a complete word; "git" ≠ "gitk"
Fetch(pattern)  Fetch(https://api.github.com/*)  Fetch(domain:npmjs.org)   # WHATWG URL Pattern
<tool>          read | edit | grep | glob | exec
mcp__server__tool | mcp__server__* | mcp__*
```

Resolution (DOCUMENTED): **deny → ask → allow → default prompt**, with a same-level specificity
carve-out (`ask:["exec"]` + `allow:["Exec(git status)"]` lets `git status` run), and explicitly **no**
carve-out for `Read()`/`Write()` path globs ("if a path matches an ask rule, Devin prompts even when a
narrower path allow also matches"). Org deny/ask always win over user modes, including Bypass.

**Modes**: `normal` (alias `auto`), `accept-edits`, `smart`, `dangerous` (aliases `yolo`, `bypass`),
`autonomous` (requires `--sandbox`; the *only* mode available in a sandbox session).

| Tool class | Normal | Accept Edits | Smart | Bypass | Autonomous (sandbox) |
|---|---|---|---|---|---|
| read-only | auto | auto | auto | auto | auto |
| fetch | prompt | prompt | auto-if-judged-safe | auto | auto |
| bash | prompt | prompt | auto-if-judged-safe | auto | auto |
| edit/write | prompt | auto (workspace) | auto (workspace) | auto | **prompt** |

The last cell is the sharpest design insight in Devin's CLI: **`edit`/`write` tools run in the CLI
process, outside the OS sandbox, so they still prompt even in "autonomous"** — and approving a
`Write(...)` scope *dynamically expands* the sandbox for later shell commands. That is an honest
statement of a real boundary gap; HorizonCode instead routes file writes through the same
Guard/ExecutionHost, so it does not have this split.

**Smart mode** never auto-approves: package installs, mutating git, `rm`/`sudo`/destructive commands,
destructive cloud CLIs, and anything touching dotenv/key material/git config/agent config — regardless
of what the judge model says. It also fails safe when the model is unavailable ("you get the normal
approval prompt").

**Sandbox**: `--sandbox` → Linux `bwrap` + `seccomp` (requires `bubblewrap` and `socat`, else **hard
fail with install instructions**), macOS `seatbelt`; Windows **unsupported** and hard-fails (documented,
including when running as an ACP server in an IDE). Writable roots = granted `Write(...)` scopes +
workspace; readable = everything except `Read(...)` deny paths, which are hidden from sandboxed
commands entirely. `sandbox.excluded` uses `Exec(...)` rules with restrictive-verdict-wins
(`deny > ask > allow`), most-specific-match within a source, and **fail-closed** if a command cannot be
parsed; PTY-shell commands always stay inside. Enterprise enforcement: `Optional` (default) | `Required`
(forces `--sandbox`); a future `Strict` is mentioned.

**Network filtering**: when sandbox + domain config are active, "a managed network proxy starts on
loopback and the sandbox restricts all child traffic to route through it". `network_mode: limited`
allows only `GET/HEAD/OPTIONS`. Patterns: `example.com` exact, `*.example.com` subdomains (not apex),
`**.example.com` apex + subdomains. Deny beats allow; enterprise allowlist replaces local, enterprise
denylist merges. The docs flag this feature as "currently unstable" — an unusual but welcome honesty.

**Hooks** (DOCUMENTED): events `PreToolUse`, `PostToolUse`, `PermissionRequest`, `UserPromptSubmit`,
`Stop`, `PostCompaction`, `SessionStart`, `SessionEnd`; `matcher` is a **regex** against `tool_name`
(and is *not* the permission glob syntax — `mcp__github__*` is wrong, `mcp__github__.*` is right);
stdin includes `session_id` and per-turn `prompt_id`; output uses `hookSpecificOutput{additionalContext}`
and `{decision:"approve"}`; exit code 2 blocks. This is intentionally **Claude-Code-shaped** — same
event names, same `hookSpecificOutput` envelope — consistent with `read_config_from.claude`.

**Subagents** (DOCUMENTED): `run_subagent`/`read_subagent`; profiles `subagent_explore` (read-only +
web search, **default subagent model chosen by a server-side router**) and `subagent_general` (**the
parent's model**, full tools in foreground). Background subagents "inherit any tool permissions you have
already granted … any tool that has not been pre-approved is automatically denied" and cannot prompt;
they can be resumed in the **foreground** to grant permissions. Nesting is capped (documented section).
Cost is independent per subagent. Enterprise can disable subagents entirely ("Default subagent model =
None"), which overrides the user setting.

That model-resolution split (explore → router-chosen cheap model, general → parent model) is a
cost-control pattern HorizonCode's `AgentProfileV2` already supports via per-profile model, but the
*server-side router* is a hidden provider-selection mechanism that conflicts with HorizonCode's
no-silent-provider-change rule unless it is an explicit, named, local policy.

### 8.7 Outposts: the worker/lease contract

This is the most directly reusable subsystem for HorizonCode's `§37.17–19` / `§21.11` worker work.

**Objects** (Kubernetes-style `metadata`/`spec`/`status`):

Queue entry (`devins`):
```
metadata {session_id, outpost_id, created_at, updated_at}
spec     {kind: new|resume, platform, remote_binary_sha|null, network_policy{enabled, allow[{hostname|ipv4|ipv6}]}}
status   {phase: pending|claimed, acceptor_id|null, claim_deadline|null,
          session_status: pending|running|suspended|terminated,
          connect_token?, gateway_url?}      # tokens only on successful claim
```

Outpost: `metadata{outpost_id, account_id, created_at}`, `spec{name, platform, description}`,
`status{queue_depth, active_claims}`.

**Endpoints** (`https://api.devin.ai/opbeta/outposts/`, bearer token with `account.outposts.read|write`):

```
GET  /outposts/devins?outpost=&phase=&acceptor_id=&first=1..200&cursor=&watch=
GET  /outposts/devins/{session_id}
POST /outposts/devins/{session_id}/claim     {acceptor_id}      # 409 if already claimed
POST /outposts/devins/{session_id}/release   {acceptor_id}
POST /outposts/devins/{session_id}/operator-message {message}   # ≤2000 chars, 1/30 s, replaces banner
GET|POST /outposts ; GET|DELETE /outposts/{id}
```

**Delivery semantics** (DOCUMENTED, and unusually precise):

- List-then-watch with an **opaque cursor** that is interchangeable between list and watch.
- **At-least-once**: "a session at a page boundary can appear in both pages, so upsert entries by
  `metadata.session_id`"; the claim CAS makes duplicates harmless.
- Watch streams **end after at most five minutes**; a reconnecting loop is expected.
- Omitting the cursor starts from the beginning → always list-then-watch.
- Claim "promises that a worker will be ready within the server-assigned claim deadline"; **expired
  claims return to the queue automatically**; release is immediate.
- `phase`/`acceptor_id` filters are **ignored** when `watch=true` — filter client-side.

**Spawn contract** (`devin-remote serve`):

| Env | Required | Notes |
|---|---|---|
| `DEVIN_OUTPOST_GATEWAY_URL` | yes | e.g. `wss://outpost-gateway.devin.ai` |
| `DEVIN_OUTPOST_CONNECT_TOKEN` | yes | from claim response |
| `DEVIN_OUTPOST_SESSION_ID` | yes | all three must be set together |
| `DEVIN_REMOTE_STATE_DIR` | "strongly recommended" | per-session state; shared default leaks between concurrent sessions |
| `DEVIN_CHROME_PATH` | optional | no managed Chrome on outposts |
| `DEVIN_OUTPOST_DESKTOP` | optional | lazy VNC capture |

Operators must pass a **clean environment** (only the above + `PATH/HOME/USER/LOGNAME/TMPDIR/LANG/TZ`
and X11 variables for desktop) because it is "inherited by the agent's shell" — i.e. the vendor states
the credential-leak risk explicitly.

Lifecycle: launch from the work directory (repos under `$(pwd)/repos/<repo>`); on session end the remote
"exits with status 0 on its own"; the operator must confirm `session_status ∈ {suspended, terminated}`,
then release — and because "the status update can lag the exit by a few seconds", re-read a few times.
Binary distribution is content-addressed by git SHA from `static.devin.ai/devin-rs/remote/` with a
`.sha256` file; a session may pin `spec.remote_binary_sha`.

**Comparison to HorizonCode:** Devin has a clean claim-CAS + deadline + at-least-once queue with
explicit upsert keys — *better specified than* HorizonCode's current worker-lease design in one respect
(published wire contract) and *weaker* in another (no durable receipt per session, no owner-epoch
rotation on reconnect, no UNKNOWN state; a lagging status is explicitly tolerated rather than
reconciled).

### 8.8 Security profiles

Restrictions a profile can carry (DOCUMENTED):

| Restriction | Encoding | Enforcement notes |
|---|---|---|
| Network | allowlist of hostnames (`*` wildcard incl. dots) + IPv4/IPv6 CIDR | applies to *all* session egress (shell, browser, installs); blocked requests can be approved mid-session and are **clamped** by a mandatory parent |
| MCP access | allowlist of MCP servers | independent of network policy; allowed servers reachable automatically |
| Devin MCP | `read-only` toggle | blocks child-session creation, knowledge/playbook edits, schedules |
| Git access | `read-only` \| `full` | read-only = clone/fetch but no push/PR |
| GitHub CLI token | present \| removed | token may only be kept if git=full **and** network allows `api.github.com` (validated at save) |

Binding hierarchy (broad → specific): **enterprise default → org default → automations default →
automation → session**. Each level chooses `inherit` | pin a profile | **no profile** (explicit opt-out).
Resolution walks top-down; **most specific wins unless a mandatory profile above locks it**. Child
sessions inherit the parent's chain so "restrictions can't be escaped by delegating work".

Enforcement levels: **recommended** (a default; lower levels may change/opt out) vs **mandatory**
(a floor; lower levels may only *tighten*; two profiles are **intersected**: network/MCP allowlists
narrow to the intersection, git takes the minimum, Devin-MCP read-only if either says so, gh token
removed if either removes it; mid-session grants are intersected again).

**Freshness semantics** (DOCUMENTED, and the part HorizonCode should reject): a session resolves its
profile **at boot and at each wake/reboot**; edits do not propagate to a running session, which "keeps
the restrictions it resolved at its last wake". For a long-running session that is a stale-policy window
of hours; HorizonCode binds policy revision/digest to every effect (`§14.2`, `§14.23`).

### 8.9 Consumption / cost contracts

- Unit: **ACU** (enterprise) or plan quota + on-demand credits (self-serve).
- Metered on "number and complexity of actions" + VM time ("typically a small fraction"); **not** while
  sleeping, waiting for the user, waiting for tests, or during repo setup/clone.
- Idle sleep: 30 min default; **5 min** for Lite and API-created sessions (except child sessions);
  enterprise can set 5–120 min.
- Per-session cap: `max_acu_limit` on create. Org/enterprise caps: usage policies, `acu-limits`,
  `org-group-limits`, per-user overrides. Windows sessions cost ~9% more; macOS currently same as Linux
  (promotional).
- Reporting: `session.acus_consumed`, `on_demand_usage` (Teams), `/consumption/daily/*` (by org, user,
  service user, session), `/metrics/*`.
- Model-routing modes (`devin_mode`: `fast`, `fusion`, `lite`, `ultra`, …) change which model/compute
  tier runs — i.e. **cost is a session-level mode, not a per-call parameter**.

Architectural note: Devin meters **work performed**, not tokens, and exposes no per-effect receipt.
HorizonCode's `providerCostMicros` budget dimension plus per-Attempt usage evidence is a *stronger*
accounting design, but it currently has no live pressure ingress (`§18.18` source status), so the
practical comparison is "HC designs better accounting, Devin ships usable caps".

## 9. Execution flows (Devin)

### 9.1 Cloud session, end to end

```
trigger (web/Slack/API/automation/CLI handoff)
  → create session: prompt + repos + playbook + knowledge + secrets + security_profile + max_acu_limit
  → placement: platform (linux/windows/macos) or outpost pool; child inherits parent placement by default
  → provision from snapshot (blueprint build) → clone repos into ~/repos/<name> → inject secrets
  → resolve security profile chain at boot (network/MCP/git/gh)
  → agent loop in VM: plan → shell/IDE/browser/desktop/MCP → observe → iterate
      ├─ approval prompts when policy requires (waiting_for_approval)
      ├─ child sessions ("managed Devins") for parallel sub-work; coordinator woken on completion
      └─ dynamic workflow: Python script orchestrates agents, records calls, replays on resume
  → deliverable: branch + PR(s) (optionally stacked), structured_output (provide_structured_output),
     attachments (videos), knowledge/memory updates, tags, session insights
  → idle → sleep (status suspended, reason inactivity) → wake on message (resuming → running)
  → terminal: exit | error | suspended indefinitely; archive/unarchive; delete
```

Documented specifics worth capturing:
- `structured_output_required: true` means the agent **must** call `provide_structured_output`; the
  validated object lands in `SessionResponse.structured_output`. That is a contract-level guarantee that
  a session produces machine-readable output — a pattern HorizonCode's `VerificationService` could use
  for machine-checkable deliverables.
- Child sessions are first-class: `parent_session_id`/`child_session_ids`, placement inheritance,
  same security chain, coordinator can message/sleep/terminate children and is woken automatically
  "even if it is asleep".
- PR production: `pull_requests[{pr_url,pr_state}]` per session; stacked PRs supported; review loop via
  Devin Review and PR comments (`@devin`, bot-comment settings); repo blocklists at team level.

### 9.2 Local CLI session

```
devin [--model] [--permission-mode] [--sandbox] [--cloud] [--continue|--resume <id>] [-p] [prompt]
  → load config (user + project + local) → import from Cursor/Claude/OpenCode/Zed/Windsurf/Copilot
  → discover rules (AGENTS.md etc.), skills (.agents/skills), MCP (mcp_config.json + imports)
  → trust check (--respect-workspace-trust, default true)
  → agent loop; per tool: permission rules → (deny|ask|allow|prompt) → sandbox decision
  → session saved locally; /handoff to cloud; devin ssh / devin forward for cloud VM access
```

CLI↔cloud continuity (DOCUMENTED): `devin --cloud` drives a cloud session from the terminal; `/handoff`
pushes a local task to cloud and can bring the cloud PR back; `devin ssh` opens a shell into the cloud
VM; `devin forward` forwards ports. `--export` writes the conversation each turn in **ATIF** format
(public name, format not published in the fetched corpus → `UNVERIFIED`).

### 9.3 Local Hands (inverse execution)

```
cloud session needs the user's machine
  → posts "Local machine access requested" card (reason, expiry)
  → owner runs `devin connect <CODE>` (single-use, 10-minute expiry, new code replaces old)
     or clicks Approve in Devin Desktop
  → local tools become available; each call requires approval unless bypass is on
     (credential files and destructive commands ALWAYS ask)
  → revoke / stop connect / close desktop / session end tears the connection down
```

Constraints (DOCUMENTED): only the **session owner** can pair; automations/scheduled/API-service-user
sessions "cannot request a machine"; the cloud VM remains the primary environment — Local Hands is a
*second* tool set, and data moves only through approved copy tool calls. This is a well-scoped
"remote hands" design that avoids giving the cloud agent ambient local authority.

### 9.4 Verification loop (post-PR testing)

Documented three-phase flow after a PR exists: **setup** (read PR + codebase, look for
`.agents/skills/`, log into services, check staging/dev/local reachability, request missing secrets and
**save them for future sessions**) → **plan** (single most important end-to-end flow proving the
feature) → **record** (start screen recording, execute plan in the desktop, annotate key moments, attach
video to the session).

Two things HorizonCode should take and one it should not:
- Take: the *explicit test plan derived from the diff*, and the requirement that proof be
  human-watchable.
- Take: looking for repo-local skills to drive the verification.
- Reject: the video attachment as *authoritative* completion evidence (it is hosted by the vendor, not
  repo-local, and is a model-produced artefact). HorizonCode's rule "model self-report is not completion
  evidence" (`AGENTS.md`) still requires independent commands/results.

### 9.5 Cancellation, sleep, resume, failure paths

| Path | Devin behaviour | Tag |
|---|---|---|
| Cancel/stop | session → `exit` (or `suspended` with `user_request`); children terminate too | DOCUMENTED (status/status_detail) |
| Idle | auto-sleep after 30 min (5 for Lite/API); VM preserved when `resumable: true` | DOCUMENTED |
| Wake | message → `resuming` → `running`; security profile re-resolved at wake | DOCUMENTED |
| Budget exhaustion | `suspended` + specific detail (`out_of_credits`, `out_of_quota`, `user_usage_limit_exceeded`, …) | DOCUMENTED |
| Error | `error` (+ detail `error`) | DOCUMENTED |
| Network blocked | agent sees the allowlist and can *request* a destination; approval adds it for the session, clamped by mandatory profile | DOCUMENTED |
| Outpost worker dies | claim deadline expires → session returns to queue; at-least-once delivery means a session may be claimed twice across boundary | DOCUMENTED |
| Message retry | no idempotency key → duplicate message possible | `UNVERIFIED` (absence of key in schema) |
| Session delete | `archive` then permanent delete; archived sessions still listed with `is_archived` | DOCUMENTED |

## 10. Cost, permission and sandbox model (Devin)

### 10.1 Cost

- ACU metering by action complexity + VM time; sleeps free; per-session `max_acu_limit`; org/user caps;
  `devin_mode` selects a cost/compute tier; Windows +9%.
- `Session Insights` exposes per-session usage to any user; enterprise consumption APIs expose
  daily/cycle rollups per org/user/service-user/session.
- Cost is not per-token; there is no published price per ACU in the API.

### 10.2 Permission model

Five layers, only some of which are OS-enforced:

1. **Permission rules** (`allow`/`deny`/`ask`) — deterministic, grammar-based, org-overridable.
2. **Modes** — UX presets over the rules (`normal` → `bypass`), with `autonomous` bound to the sandbox.
3. **Smart judge** — a fast model; explicitly bypassed by existing rules and never allowed to approve a
   hard-coded dangerous class.
4. **Security profiles** — infrastructure-level restrictions resolved at boot/wake (§8.8).
5. **OS sandbox** — bwrap+seccomp/seatbelt, fail-closed, `Write(...)`-derived writable roots.

The layering is coherent because each layer has a *different* job, and the docs state where the seams
are (e.g. `edit`/`write` bypass the sandbox; Smart cannot approve installs). That is materially better
documented than Cursor's three-plane model, even though the authority is still the model + backend, not
a local kernel.

### 10.3 Sandbox model

| Dimension | Devin CLI | Devin Cloud |
|---|---|---|
| Mechanism | `bwrap`+`seccomp` (Linux), `seatbelt` (macOS); Windows unsupported | provider-managed VM isolation (opaque) |
| Fail mode | **hard fail** if tools missing or profile unresolvable | n/a |
| Filesystem | writable = `Write()` scopes + workspace; reads = all except `Read()` deny (hidden) | VM disk |
| Network | default full, optional allowlist via loopback proxy; `limited` = GET/HEAD/OPTIONS | allowlist via security profile, all egress |
| Dynamic grants | mid-session `Write()` approval expands sandbox | mid-session destination approval, clamped |
| Exclusions | `sandbox.excluded` `Exec()` rules, fail-closed, PTY always inside | n/a |
| Enterprise | Optional / Required (Strict future) | mandatory profiles |

### 10.4 What is cloud-mediated vs local (Devin)

| Capability | Cloud | Local CLI | Evidence |
|---|---|---|---|
| Agent loop | VM | local | DOCUMENTED |
| Planning | in-session (no published split) | same | `UNVERIFIED` |
| Model choice | `devin_mode` | `/model`, `--model`, fuzzy names | DOCUMENTED |
| Sandbox | VM | OS sandbox | DOCUMENTED |
| Knowledge/playbooks/memory | yes | no (CLI has rules/skills) | DOCUMENTED |
| Automations | yes | no | DOCUMENTED |
| DeepWiki | yes (public MCP server too) | no | DOCUMENTED |
| PR creation | yes (native git integrations) | yes (local git + gh) | DOCUMENTED |
| Review (Devin Review) | yes | no | DOCUMENTED |
| Outposts | yes (placement) | no | DOCUMENTED |
| Local Hands | yes (pairs to user machine) | n/a | DOCUMENTED |

---

# Part C — HorizonCode comparison, adaptations, rejects

## 11. HorizonCode comparison

**How to read the HorizonCode column.** Status reflects (a) what the cited `arch_V1` owner states and
(b) whether the cited source path exists in the working tree. I did **not** run the Rust/TS suites, so
nothing here may be promoted to `TESTED`/`VERIFIED` on my authority (`arch_V1/33` §33.1: a catalog entry
is not runtime proof). Where I could not establish the current state I write `UNKNOWN` rather than
guess.

Gap classes: `MISSING` (no design/source), `WEAKER` (present but narrower or unproven),
`DIFFERENT-DESIGN` (HorizonCode solves it another way on purpose), `ALREADY-EQUAL` (parity or better),
`NOT-APPLICABLE` (outside the Linux/WSL-first V1 scope per `arch_V1/17` A-V2-31).

Effort scale (implementation units, not calendar): **S** ≈ a bounded contract + tests inside one owner;
**M** ≈ a schema/interface plus wiring across two owners; **L** ≈ new subsystem or cross-phase
integration with negative/recovery acceptance.

### 11.1 Local agent runtime, permissions, sandbox

| # | Capability (product) | Evidence | HorizonCode current state | Gap | Owner | Effort |
|---|---|---|---|---|---|---|
| 1 | Headless machine protocol: `-p`, `text/json/stream-json`, NDJSON `system/init → assistant/tool_call → result` (Cursor) | DOCUMENTED + OBSERVED | CLI `run`/`serve` and `packages/sdk`/`sdks` exist; `§37.19` covers multi-client SDK/source import; no published NDJSON turn-event schema with a terminal-event guarantee | WEAKER | P9 §37.19 + P7 §13.12 | M |
| 2 | ACP server over stdio JSON-RPC with `session/request_permission`, `allow-once/always`, `reject-once`, extension methods (Cursor) | DOCUMENTED | ACP **client/adapter** design `§37.20` is post-V1 (`DEC-V1-24`); server mode not exposed | NOT-APPLICABLE (V1) | P4 §37.20 | L |
| 3 | Deterministic permission grammar `Shell/Read/Write/WebFetch/Mcp(...)`, deny > allow, globs, `command:args` (Cursor) plus `Read/Write/Exec/Fetch/tool/mcp__server__tool` with specificity carve-outs (Devin) | DOCUMENTED | `§37.25–27` define modes/grants/profiles; `§14.2` owns Guard decisions; no published `Tool(specifier)` grammar, no documented specificity carve-out rule | WEAKER | P6 §37.25–27 | M |
| 4 | LLM-judge auto-approval plane (`--auto-review` + natural-language `permissions.json`; Devin `smart` mode) | DOCUMENTED + OBSERVED | Explicitly not exposed in V1: automatic review requires an authenticated independent reviewer (`§37.25`; R1 recorded the same) | NOT-APPLICABLE (design rejection) | — | — |
| 5 | OS sandbox for shell with per-dimension policy, protected paths, SSRF defaults, network allow/deny/CIDR (Cursor); bwrap+seccomp/seatbelt, fail-closed, `Write()`-derived roots (Devin) | DOCUMENTED + OBSERVED | `§14.5` guarantee `vector` + bubblewrap fresh namespaces/deny masks/private `/tmp`/network namespace; `§14.6` typed destination policy rejecting loopback/link-local/metadata; unsatisfiable guarantees fail closed | ALREADY-EQUAL (design; source partial P1) | P1 §14.5/§14.6 | S |
| 6 | Layered sandbox policy merge: user < repo < team-admin < hardcoded; union paths, replace boundary, intersect allow, union deny, OR restrictive booleans (Cursor) | DOCUMENTED | `§16` owns settings precedence; `§14.2` binds policy revision to each Guard decision; no published sandbox-specific merge algebra or protected-path list | WEAKER | P6 §16 + P1 §14.5 | M |
| 7 | Sandbox **default-off / opt-in** (Cursor) vs **fail-closed if unresolvable** (Devin) | DOCUMENTED | Fail-closed by design (`§14.5`: unsupported platform → typed `Unsupported`; profiles requiring unmet guarantees refuse) | ALREADY-EQUAL+ | P1 §14.5 | — |
| 8 | Hook system: per-event input schema, command + LLM prompt hooks, exit `0/2/other`, `failClosed`, `loop_limit`, `matcher` (Cursor); Claude-shaped events with `hookSpecificOutput` (Devin) | DOCUMENTED | `§29.7` `HookBindingV2`: 23 events, 3 modes, 3 handler kinds, "cannot turn a Guard DENY into ALLOW", project hooks disabled until trusted. **No runtime hook executor found**: `HookBinding` appears only in `packages/schema/src/composition-v1.ts` + `packages/core/src/composition-manifest.ts` | WEAKER (design richer, runtime missing) | P1 §29.7 | L |
| 9 | Hook failure policy that can never widen authority | DOCUMENTED (Cursor fails open by default; Devin blocks on exit 2) | `§29.7` states the invariant; `failClosed`-style matrix not specified | ALREADY-EQUAL (rule) / WEAKER (matrix) | P1 §14.2 | S |
| 10 | MCP: stdio/SSE/streamable HTTP, OAuth PKCE with RFC 9728+8707, static client credentials, config interpolation, per-server approval (Cursor); stdio/http + OAuth + scopes (Devin) | DOCUMENTED + OBSERVED | `§29.8` `McpServerProfileV2`: stdio/streamable_http/json_rpc_http, SecretBroker-backed auth, `trustClass`, `networkPolicyRef`, toolset generations; no SSE/ws, no OAuth flow contract, no per-server approval state | WEAKER | P6 §29.8 | M |
| 11 | Project instruction ingestion: `.cursor/rules/*.mdc` frontmatter, `.cursorrules`, nested `AGENTS.md`, `CLAUDE.md`, team rules, precedence Team→Project→User (Cursor) | DOCUMENTED + OBSERVED | `§29.23` `ProjectInstructionResolverV1`: managed/user/project-ancestor/subdir/skills scopes, on-demand nested load, modes `prefer_agents_md\|prefer_claude_md\|merge_both\|config_only`, 128 KiB compile cap; **no `.mdc`/`.cursorrules` ingestion, no remote team-rule source** | WEAKER | P6 §29.23 | M |
| 12 | Skills: `SKILL.md` + frontmatter, `.agents/skills`, recursive discovery, subtree scoping, `allowed-tools` | DOCUMENTED | `§29.6` `SkillManifestV2` + `.agents/skills` support (`§29.6` line ~542) + sealed built-in identities + revision pinning; `packages/core/src/skill.ts` present | ALREADY-EQUAL+ | P6 §29.6 | — |
| 13 | CLI config import from Cursor/Windsurf/Claude/Copilot/OpenCode/Zed/AGENTS (Devin `read_config_from`) | DOCUMENTED | No importer found in `arch_V1/16`, `§29.23`, or `packages/core/src/config*`; cross-tool import is not designed | MISSING | P6 §16 | M |
| 14 | Config format: JSON-with-comments, per-scope files (user/project/local/MDM `system.json`), self-repair + `.bad` quarantine (Cursor/Devin) | DOCUMENTED + OBSERVED | `packages/core/src/config.ts` + `packages/core/src/v1/config/*`; `§16` precedence. JSONC + MDM system policy + corrupt-file quarantine not documented | WEAKER | P6 §16 | S |
| 15 | Session resume: `--resume/--continue`, interactive picker, background `persist` daemon (Cursor); `-c/-r`, cloud `--resume`, `/handoff` (Devin) | DOCUMENTED + OBSERVED | Durable journals (`kernel/src/session_projection.rs`, `direct_turn_journal.rs`, `direct_message_journal.rs`) + `history.attach` (`§33.10`); `persist`-style detached session daemon has no equivalent | DIFFERENT-DESIGN (durable journal) | P7 §37.19 | M |
| 16 | Worktrees: `-w`, setup scripts, `$ROOT_WORKTREE_PATH`, retention cleanup (Cursor); agent-per-worktree in cloud (Devin) | DOCUMENTED | `§21.4` pool record `FREE/LEASED/QUARANTINED` + dirty/process/port ownership; `§14.20` guarded worktree lifecycle executable; `git.worktree.acquire/release` (`§33.6`) | ALREADY-EQUAL+ (Cursor is weaker: retention, no leases) | P8 §21.4 | S |

### 11.2 Extension ecosystem

| # | Capability (product) | Evidence | HorizonCode current state | Gap | Owner | Effort |
|---|---|---|---|---|---|---|
| 17 | Plugin bundle (rules/skills/agents/commands/hooks/MCP) + git marketplace + vendor-neutral Agent Plugins manifest (Cursor) | DOCUMENTED | `CompositionManifestV1` (`packages/core/src/composition-manifest.ts`) + `packages/plugin`; no marketplace/index, no remote install, no `plugin.json` importer | WEAKER | P6 §29 | L |
| 18 | Subagent profiles with per-profile model; explore routed to a cheap model, general inherits parent (Devin); custom subagents with model/inherit (Cursor) | DOCUMENTED | `AgentProfileV2` `§29.2` has per-profile model/variants/capabilityCeiling; `§29.13` depth/comm limits; `kernel/src/subagent_delivery.rs` + `task_dag.rs`. Server-side router would violate pinning | DIFFERENT-DESIGN | P6 §29.2 | M |
| 19 | Marketplace/registry distributed MCP + plugins with provenance (Cursor team marketplace; Devin MCP marketplace + plugins) | DOCUMENTED | No marketplace; §29.8 keeps MCP client-side and non-authoritative; `DEC-V1-23` forbids HC-as-MCP-server | MISSING (intentional) | P6 §29.8 | L |
| 20 | Knowledge/playbook objects: reusable procedure with macro + `structured_output_schema`; reference notes with trigger + repo pinning (Devin) | DOCUMENTED | Skills (`§29.6`) + custom actions (`§29.9`) cover procedures; no parameterised playbook object, no org knowledge store, no output schema attached to a procedure | DIFFERENT-DESIGN / MISSING | P6 §29.6 | M |
| 21 | Personal persistent memory as a git-backed note drive with merge + daily consolidation ("Dreaming") (Devin) | DOCUMENTED | No cross-session personal memory found (grep: none). `§30.15` "named reviewed memory blocks" and `§30.20–21` memory-recall are **context-scoped**, not durable personal preference memory | MISSING | P3 §30.15 (new capability; needs §17 decision) | L |
| 22 | Repo knowledge index + generated wiki + public MCP server (Devin DeepWiki) | DOCUMENTED | RepoIntel `§30.7–30.10` (`SymbolIndexV2`, generations, authenticated `query_structure`), `indexd`; no wiki generation, and HC-as-MCP-server is unavailable (`DEC-V1-23`) | DIFFERENT-DESIGN | P3 §30.7 | L |

### 11.3 Remote execution, lifecycle, verification

| # | Capability (product) | Evidence | HorizonCode current state | Gap | Owner | Effort |
|---|---|---|---|---|---|---|
| 23 | Self-hosted worker claim: claim CAS (409), claim deadline, release/fail, session token, OIDC claim token (5 min), wake flag, `/healthz`+`/readyz`+`/metrics` (Cursor) | DOCUMENTED | `§37.17–19` resource/worker/headless-broker design + `§21.11` leasing + `§18.18` reservation states; no published claim wire contract, no OIDC claim-token analogue | WEAKER | P8 §37.18 | L |
| 24 | Queue with list-then-watch cursors, at-least-once delivery, upsert key, 5-minute streams, pinned binary by SHA (Devin Outposts) | DOCUMENTED | `§13.12` event cursor/ACK (opaque cursor, ACK only completed pages, replay from last ACK) is **stronger** for events; no worker-queue schema with at-least-once upsert semantics | WEAKER (queue) / ALREADY-EQUAL (event cursor) | P8 §37.18 | L |
| 25 | Session lifecycle with rich reason taxonomy (`suspended` + `inactivity\|user_request\|out_of_credits\|out_of_quota\|payment_declined\|user_usage_limit_exceeded\|contract_expired\|error`) (Devin) | DOCUMENTED | `§11` lifecycle + `UNKNOWN` settlement semantics; commercial/quota suspension reasons are not modelled separately from failure | DIFFERENT-DESIGN | P2 §11 | M |
| 26 | Resumable VM + sleep/wake + boot-from-snapshot; `resumable` flag (Devin) | DOCUMENTED | No VM/machine-image capability. `§31.18` checkpoint store snapshots **session/workspace state**, not an OS image | MISSING (post-V1) | P8 §31.18 | L |
| 27 | Declarative environment blueprint (`initialize`/`maintenance`/`knowledge`/`runs-on`/`post-build`/`clone`), builds → per-platform snapshots, differential builds, ~24 h rebuild, logs/cancel/pin (Devin) | DOCUMENTED | No environment-build artifact or image lifecycle. `job.repo.detect` (`§33.4`) detects stack only | MISSING (post-V1) | P3 §30.7 | L |
| 28 | Structured output contract: `structured_output_required`, mandatory `provide_structured_output`, validated object on the session (Devin) | DOCUMENTED | `run.verify`/`tasks.verify` (`§33.11`) + Rust Evidence/Verification ownership; no declared per-Run output schema and no "terminal receipt requires validated object" rule | WEAKER | P2 §33.11 | M |
| 29 | Security profiles: 5-level binding, `inherit\|pin\|none`, recommended vs mandatory, **intersection** on tighten, resolve-at-boot/wake, mid-session clamp (Devin) | DOCUMENTED | `§14.2` durable approvals + `§14.23` request-bound context integrity bind **policy revision/digest per effect** (fresher than Devin); no named reusable profile object with intersection algebra | DIFFERENT-DESIGN (HC fresher) | P6 §16 | L |
| 30 | Local Hands: cloud session → user machine, 10-min single-use pairing code, per-call approval, always-ask credential/destructive classes, instant revoke (Devin) | DOCUMENTED | Virtual attachment/`SessionLink` ingress `§37.16` + `§13.12` virtual-owner binding; no local-hands pairing/bridge | MISSING (post-V1) | P8 §37.16 | L |
| 31 | Automations: trigger sources (Slack/GitHub/GitLab/Linear/Jira/PagerDuty/schedule/webhook), OR triggers, condition tree, action limits, required `run_as`, concurrency, preflight (Devin) | DOCUMENTED | `§31.12` automation UX + `§31.20` durable automation registry + replay fencing + `§33.16` `automations.*` tools. Wire tracker `W-P7-06` = Partial; no trigger-source matrix or `run_as` principal rule | WEAKER | P7 §31.20 | L |
| 32 | Post-PR verification with a diff-derived test plan and attached recording (Devin) | DOCUMENTED | `§32` acceptance + Evidence/Verification; verification evidence must be repo-local and independently reproducible. Recordings are vendor-hosted | NOT-APPLICABLE as authority (see §13) | P2 §32 | — |
| 33 | Agent-run SSE stream with `Last-Event-ID`, retention header, `410 stream_expired` → read terminal state (Cursor) | DOCUMENTED | `§13.12` page ACK + replay-from-ACK; `§04` durable/ephemeral events. Cursor's explicit retention/expiry fallback is a good published shape, not present as a wire contract | ALREADY-EQUAL (semantics) / WEAKER (published contract) | P7 §13.12 | M |
| 34 | Steering a running turn + documented duplicate-delivery hazard, no idempotency key (Cursor) | DOCUMENTED | `§15` interruption semantics: a steer affects only a future provider step; prepared batches freeze digest/args/lease; post-send pre-receipt = `UNKNOWN`, never retried blind | ALREADY-EQUAL+ | P1 §14.3 + P7 §15 | S |

### 11.4 Cost, governance, platform

| # | Capability (product) | Evidence | HorizonCode current state | Gap | Owner | Effort |
|---|---|---|---|---|---|---|
| 35 | Per-session budget cap (`max_acu_limit`) + org/user ACU caps + idle-sleep-free metering (Devin) | DOCUMENTED | `§18.18` `BudgetDimension` includes `providerCostMicros`/`tokens`, reservation states and pressure machine; `kernel/src/resource_budget.rs` is a **CODE_PRESENT pure calculator**; no live authenticated ingress, so no enforced per-session spend cap | WEAKER (design strong, enforcement absent) | P8 §18.18 | L |
| 36 | Per-run token usage endpoint with explicit subagent/time-window attribution holes (Cursor) | DOCUMENTED | `§31.21` usage projection separates `provider-reported`/`measured`/`estimated`, unknown count per field, no fabricated currency total; `§18.18` accounting invariants | ALREADY-EQUAL+ (design) | P8 §31.21 | S |
| 37 | Remote feature gates controlling local behaviour (Statsig at `api2.cursor.sh`) | OBSERVED | `§33.32` exposure tiers are local config decisions; no remote gate service, and hidden remote behaviour control would violate the provider/config authority rules | DIFFERENT-DESIGN (reject remote gating) | P6 §33.32 | S |
| 38 | Enterprise governance: custom RBAC roles, IdP groups/SCIM, IP allowlists, CMK, audit logs, private networking, dedicated deployment (Devin); team rules/model access/spend/audit (Cursor) | DOCUMENTED | `§16` UX/settings, `§17` governance, `§18` operations/privacy, `packages/enterprise`; narrower surface, no CMK/private-networking analogue | WEAKER | P6 §16 | L |
| 39 | CLI auto-update with staged atomic swap + file lock (Devin); `cursor-agent update` | DOCUMENTED + OBSERVED | `§18.12` requires signed metadata/artifacts, staged download separate from activation, health check and rollback; atomic rename + concurrent-updater lock are not specified | WEAKER | P9 §18.12 | S |
| 40 | MCP-apps / interactive tool UI; canvas/desktop/browser surfaces (both) | DOCUMENTED | Browser/desktop post-V1 (`A-V2-31`, `A-V2-18`); MCP Apps extension not designed | NOT-APPLICABLE (V1) | — | — |

### 11.5 Comparison summary

- **Where HorizonCode is already stronger (by design):** one Guard/ExecutionHost for every effect origin;
  durable lease/`UNKNOWN`/receipt semantics; page-level event ACK with replay-from-ACK; policy revision
  bound per effect (no boot-time staleness); sealed capability identities; worktree leases/quarantine;
  usage provenance that refuses to fabricate totals. Cursor's and Devin's own docs concede the two
  biggest gaps in the commercial designs — Cursor says Auto-review "is not a security boundary", Devin
  says `edit`/`write` tools run outside the sandbox and must still prompt even in "autonomous".
- **Where both competitors are stronger:** *published, implementable contracts*. Cursor publishes a
  stream-json event schema, an ACP method list, and a full Cloud Agent REST/SSE surface. Devin publishes
  a 161-path OpenAPI 3.1 spec with enum-level lifecycle semantics and a worker queue with at-least-once
  delivery rules. HorizonCode's equivalents are mostly internal designs (`§13`, `§18.18`, `§37.17–19`)
  without a wire schema a third party could implement against. The gap class that dominates is
  `WEAKER`, and it is a contract-publication gap before it is a capability gap.
- **Where HorizonCode is genuinely behind in capability, not documentation:** cloud VM/snapshot
  environments, personal persistent memory, local-machine bridging, playbook/knowledge objects,
  config import from other tools, and any *enforced* spend cap.
- **Where the two competitors disagree with each other, and HorizonCode should pick a side:**
  sandbox default (Cursor opt-in vs Devin/HC fail-closed); hook failure (Cursor fail-open default vs
  HC "cannot widen Guard"); policy freshness (Devin boot-time vs HC per-effect); delivery idempotency
  (Cursor at-least-once with documented duplicates vs HC receipts/`UNKNOWN`). HorizonCode's existing
  choices are the defensible ones; the work is to *publish* them, not to change them.

## 12. Ranked upgrades

Ranked by leverage ÷ effort **for V1**, with the concrete contract change each one requires. "Contract"
means: a schema/interface in the owning section plus an acceptance row; per `arch_V1/README.md` a
material change also needs a `§17` decision and a `§32` case.

| # | Upgrade | Why (evidence) | V1 / post-V1 | Owner | Effort | Concrete contract change |
|---|---|---|---|---|---|---|
| 1 | **Publish the headless turn protocol** (`system/init` → `assistant`/`tool_call` → `result`), with a rule that a stream is only successful when a terminal receipt is present, and explicit `NOT_DISPATCHED` vs `UNKNOWN` mapping | Cursor's `stream-json` is the de-facto integration surface for CI/IDE/scripts, and its failure path ("stream may end early without a terminal event") is exactly the ambiguity HC already solves internally | **V1** | P9 §37.19 + P7 §13.12 | M | New `HeadlessTurnEventV1` in `contracts-v2` (discriminated union: `system.init`, `assistant.delta`, `tool.started`, `tool.completed`, `turn.result`, `turn.error`, `stream.expired`); `§37.19` gains the CLI `run --output-format ndjson` mapping; `packages/sdk` client fixture; new `§32` row `HARNESS-00x` with "no terminal event ⇒ non-zero exit and no success claim" |
| 2 | **Freeze a worker-claim wire contract** (claim CAS, deadline, owner epoch, session token, wake, queue cursor + at-least-once upsert) | Both competitors independently converged on claim/deadline/token; Devin publishes the queue semantics, Cursor publishes the token split. HC has the states (`§18.18`) but no wire shape, and P8 fan-out stays gated without it | **V1** | P8 §37.18 + §21.11 | L | `WorkerClaimV1 {workerId, sessionId, queueCursor, claimDeadline, ownerEpoch, idempotencyKey}` and `QueueEntryV1 {metadata, spec, status}`; claim returns a **one-use** session token bound to the claim; release/fail transitions must reuse the exact `§18.18` states; `§32.37` JC-RES negatives extended with "duplicate delivery at page boundary is harmless by upsert key", "expired claim returns to queue", "reconnect cannot revive a stale owner epoch" |
| 3 | **Specify the sandbox/config merge algebra** with restrictive-wins and a protected-path list | Cursor documents union/replace/intersect/OR precedence and hard-coded protected paths; Devin documents fail-closed resolution and exclusions. HC has the guarantee vector but not the merge contract, so "which file wins" is unverifiable | **V1** | P6 §16 + P1 §14.5 | M | `SandboxPolicyV1` merge function: `paths = union`, `readBoundary = most-specific`, `network.allow = intersect when a higher mandatory layer exists else union`, `network.deny = union`, booleans = OR; output carries `policyRevisionDigest`; add a protected-path table (VCS hooks/config, agent config, ignore files) enforced **below** user config; `§32` case for "repo file cannot weaken mandatory layer" |
| 4 | **Ingest other agents' instruction files** (`.cursor/rules/*.mdc`, `.cursorrules`, root `plugin.json`/`.agents/skills`) behind an explicit trust switch | Cursor's rules are the most-copied project convention; Devin ships `read_config_from` on by default and treats it as a switching-cost moat. HC reads `AGENTS.md`/`CLAUDE.md` only, so a Cursor repo loses its rules on migration | **V1** | P6 §29.23 | S | Extend `ProjectInstructionResolverV1` with `sourceKind: agents_md\|claude_md\|mdc\|cursorrules\|config_glob` and an `.mdc` frontmatter parser (`description`, `globs`, `alwaysApply`); add `importFrom` config **default off** with per-source trust + provenance recorded in `§42`; `§32` INST row for "imported rule cannot widen Guard or capability exposure" |
| 5 | **Implement the hook runtime with an explicit failure matrix** | Cursor has 14+ events, command *and* LLM hooks, `loop_limit`, `failClosed`; Devin has 8 Claude-shaped events. HC has a richer event list and the right invariant but no executor — so every hook-shaped guarantee is currently untestable | **V1** | P1 §29.7 | L | `HookInvocationV1` per-event input schema; `HookResultV1 {decision: allow\|deny\|ask, updatedInput?, additionalContext?, reason}`; exit-code matrix with **fail-closed for permission hooks, fail-open only for advisory** (inverting Cursor's default); `loopLimit` default 5 for stop/subagent-stop; `matcher` declared as regex and explicitly **not** the permission glob grammar; `§32` negatives: invalid JSON blocks, timeout blocks when `failClosed`, hook DENY cannot be overridden, project hook inactive until trust |
| 6 | **Declare machine-checkable run output** (`outputSchema` at Run creation; terminal receipt requires validated object or explicit `UNKNOWN`) | Devin makes `provide_structured_output` mandatory by default and stores a validated object. HC has `run.verify` and Evidence but no declared output schema, so "the agent said it finished" remains the only signal for machine consumers | **V1** | P2 §33.11 | M | `RunOutputSchemaV1` on Run creation; `VerificationService` requires `structuredOutput` **or** an explicit `outputUnavailable` reason before a Run may reach a verified terminal state; `§32` row for "schema mismatch ⇒ Run cannot be VERIFIED" |
| 7 | **Expose a machine-readable session status projection** with reason codes separated from settlement state | Devin's `status_detail` distinguishes `inactivity`, `user_request`, `out_of_credits`, `contract_expired`, `error`; Cursor exposes `status` in JSON. HC's `UNKNOWN` is an effect-settlement outcome, not a user-facing reason, and users currently cannot tell "cancelled" from "quota" | **V1** | P7 §31.21 + P2 §11 | S | `SessionStatusV1 {state, reasonCode, settlement: SETTLED\|UNKNOWN, detail?}` where `reasonCode ∈ user_cancel\|idle\|quota\|auth\|provider\|policy_denied\|internal_error`; expose via `status --json` and `events.tail`; **never** map `reasonCode` onto `UNKNOWN` (they are different axes) |
| 8 | **Import external plugin *content* without importing authority** (`plugin.json` / `.cursor-plugin/plugin.json` → canonical capability IDs) | Cursor supports a vendor-neutral Agent Plugins manifest; ignoring it forfeits portability, while adopting its runtime model would create a second authority | **V1** (import only) | P6 §29 | M | `ExternalPluginImportV1` maps components to `§33` IDs only if every referenced capability exists; unknown components are dropped with a report; no install-time code execution; provenance + digest in `§42`; `§32` negative: an imported plugin cannot introduce a new tool ID or bypass Guard |

**Post-V1 (explicitly deferred, in priority order for when V1 is green):**

1. **Environment builds / VM snapshots** (Devin blueprint+snapshot) — a new artifact kind and lifecycle,
   not a CLI feature: needs `§17` decision, image provenance, secret scoping, and a real "works in the
   built environment" acceptance. Do not fake it with a local script runner.
2. **Personal persistent memory** (Devin memory drive) — highest product value after V1, but requires
   an explicit review/approval path so memory writes are Guarded effects with provenance; the
   "Dreaming" consolidation job is a durable automation, not a prompt.
3. **Playbooks + org knowledge store** — a parameterised procedure object with an output schema and
   scope/ACL; maps onto existing skills + automations, so it should extend those owners, not add a
   third registry.
4. **Local Hands** — cloud→local bridging with pairing, per-call approval, always-ask classes, and
   instant revoke. Requires the virtual-attachment ingress (`§37.16`) to be live first.
5. **Automations trigger matrix** — Slack/GitHub/Linear/PagerDuty/webhook sources with OR-trigger
   semantics and a required `run_as` principal. HC already has the durable registry; this is ingestion.
6. **DeepWiki-style repo narrative** — generated wiki from `indexd` generations, read-only, with
   citations to revisions. Keep HC-as-MCP-server unavailable (`DEC-V1-23`).
7. **Enterprise breadth** — custom roles, IdP group mapping, CMK, private networking. Only after the
   local product is verifiable.

## 13. REJECT list

| Rejected | Source | Why it conflicts |
|---|---|---|
| LLM classifier as an approval authority (`--auto-review`, `smart` mode) | Cursor, Devin | Hidden paid judge, non-deterministic, and both vendors admit fallibility (Cursor: "not a security boundary"; it can even be argued past). Violates one-Guard authority and "no hidden paid fallback". HC may keep a *reviewer* only as an authenticated independent verifier (`§37.25`). |
| Natural-language `permissions.json` merged into policy | Cursor | Policy-as-prompt cannot be audited, diffed, or proven; a prompt change silently changes authority. Guard policy must stay typed and revision-bound (`§14.2`). |
| Fail-open hook default | Cursor | A crashed/timed-out security hook silently allowing the action is the exact bypass `§29.7`/`§14.1` forbid. HC must default fail-closed for permission hooks and only fail-open for advisory ones. |
| Sandbox as an opt-in UX layer that file tools can bypass | Cursor (shell-only sandbox), Devin (edit/write outside sandbox by design) | HC's invariant is every mutation through one ExecutionHost (`AGENTS.md`); adopting a "sandbox only for shell" split would reintroduce the gap Devin documents. |
| Boot-time policy resolution for long-running sessions | Devin security profiles | A session that keeps restrictions resolved at last wake can hold stale authority for hours. HC binds `policyRevision`/digest to each request/effect (`§14.2`, `§14.23`). |
| At-least-once prompt delivery without an idempotency handle | Cursor steering (`delivery:"steer"`, "retrying can deliver the prompt twice") | No receipt, no dedupe key, and the docs tell clients duplicates are possible. HC requires one-use leases + receipts and treats post-send ambiguity as `UNKNOWN` (`§14.3`), never blind retry. |
| Remote feature gates controlling local capability availability | Cursor (Statsig) | Server-side toggles that change local tool/UX behaviour are hidden remote control; HC exposure tiers are local config (`§33.32`) and provider/model choice is user-pinned. |
| Cloud-side session/VM as the authority for "done" | Devin | Completion would depend on vendor state and a model-produced narrative. HC: "model self-report is not completion evidence"; Evidence/Verification is Rust-owned. |
| Video recording as verification evidence | Devin | Vendor-hosted, non-reproducible, model-directed. Useful as *supplementary* UX proof only; never the acceptance artifact. |
| Marketplace install that executes code at install time | Cursor, Devin | Supply-chain execution outside Guard. HC may import content (skills/rules/MCP *definitions*) but must not run installer code. |
| Memory auto-writes without review | Devin ("Devin saves these on its own as you work") | Persistent preference mutation is a durable effect; without an approval/undo path it can quietly change future behaviour. If adopted, memory writes must be Guarded, attributed, and reviewable. |
| Server-side model router deciding a subagent's model | Devin (`subagent_explore` default router) | Silent provider/model change. HC allows per-profile model pinning (`§29.2`) but the selection must be explicit, recorded, and within the user's allowed set. |
| Copying prompt text, classifier instructions, playbook bodies, or any bundle content | both | `AGENTS.md` source-reuse law + `arch_V1/42` provenance; also licence/proprietary-content risk. Only schemas, enums, and behaviour are usable. |
| HorizonCode acting as an MCP server to expose itself | Devin DeepWiki MCP, Cursor MCP ecosystem | Already rejected in V1 by `DEC-V1-23`; would add an inbound authority surface before the client path is verified. |

## 14. Unknowable within the stated limits

**Cursor**

1. Internal agent-loop structure, tool-selection policy, prompt composition, and model routing
   (Composer/Auto) — requires bundle/source inspection (forbidden).
2. Auto-review classifier prompt, thresholds, and error rates — server-side; docs only assert it can be
   wrong.
3. Sandbox implementation technology on Linux (Landlock vs namespaces vs seccomp) — the helper binary was
   observed but not inspected; only the *policy* and *effects* are known.
4. Local transcript/chat store format/retention for authenticated sessions — no auth allowed; only
   `~/.cursor/projects/<slug>/` creation was observed, empty.
5. `persist` semantics (daemon? socket? survives reboot?) — help text only.
6. Cloud VM image, hypervisor, snapshot mechanics, and true isolation guarantees — vendor-managed.
7. Real per-run cost in currency, and whether `usage` counts failed/aborted runs — endpoint exists, but
   pricing is not published per token/run.
8. Actual claim lease duration, stream retention seconds, and pending-request TTLs — header/response
   values only, not observable without an account.
9. Whether silent `envVars` ignore (beta) is detectable by clients — docs say it is silently ignored.
10. Behaviour of team/enterprise policy intersections in the CLI (team rules vs user rules vs managed
    settings) — partially documented, not empirically testable.

**Devin**

1. Planner/executor split, agent loop, and any internal multi-model orchestration — no architecture doc;
   only observable session behaviour is documented.
2. Model identity per `devin_mode` (`swe-2-*`, `fusion`, `ultra`) — names only; mapping to vendors is not
   published.
3. VM hypervisor, snapshot implementation, and isolation guarantees — vendor-managed; Windows/macOS
   variants documented only at the "runs-on" level.
4. Knowledge retrieval algorithm (embeddings vs lexical vs trigger matching), and the 16 KiB AGENTS.md
   injection truncation policy beyond the limit.
5. Playbook selection/ranking when several apply.
6. ACU formula weights (per action type, per VM-second) and ACU→currency conversion.
7. "Dreaming" scheduling/consolidation algorithm and conflict-resolution details beyond "stale write is
   rejected and retried".
8. `security_profile` enforcement implementation inside the VM (iptables? proxy? both) — only the
   policy/resolution semantics are published.
9. Whether `POST /sessions` or `POST /messages` is idempotent under retry — no idempotency key in the
   published schema; absence is not proof of duplication, but it cannot be ruled out without a live
   account.
10. Outpost `devin-remote` internals, the exact claim-deadline value, and gateway protocol framing
    (WebSocket assumed from `wss://`, not specified).
11. ATIF export format (named in `--export`, no schema published in the fetched corpus).
12. Whether child-session ACU is double-counted in `SessionResponse.acus_consumed` (docs discuss
    `on_demand_usage` "excluding child sessions" but not the ACU field).

**Cross-cutting**

- Real behaviour under authentication for either product (gated). Every "does it actually work" question
  about cloud paths remains unproven here by design.
- Comparative quality/latency of the two agents on identical tasks — out of scope; this is an
  architecture document, not a benchmark.

## 15. Rebuild checklists (what a compatible implementation needs)

**A Cursor-CLI-compatible local agent (minimal rebuildable set)**

1. Arg surface + hidden commands (`sandbox`, `acp`) and a single versioned install tree with `agent` and
   `cursor-agent` aliases.
2. Config resolver with self-repair/`.bad` quarantine, `$CURSOR_CONFIG_DIR`/XDG, user + project
   (`permissions` only) scopes.
3. Deterministic permission tokens (5 families) with deny>allow, glob, `command:args`.
4. Sandbox helper contract: policy object (`type`, `readBoundary`, `networkPolicy{version,default,allow,deny}`,
   additional R/W paths, `ignoreMapping`) + preflight + fail-closed on unsupported.
5. Rules/skills loaders: `.mdc` frontmatter, `.cursorrules`, nested `AGENTS.md`, `CLAUDE.md`, user/team
   precedence.
6. MCP client: stdio + HTTP/SSE, OAuth PKCE/RFC9728/8707, interpolation, per-server approval state.
7. Hook runner: event set, stdin JSON, `permission|updated_input|additional_context`, exit matrix,
   `failClosed`, `loop_limit`.
8. Headless NDJSON emitter with `system/init`, `assistant`, `tool_call{started,completed}`, `result`, and
   duplicate-safe partial streaming.
9. ACP server: JSON-RPC stdio, initialize/authenticate/session new|load|prompt|update|request_permission|
   cancel + extension methods.
10. Session store with IDs, resume/continue, and a detached `persist` lifecycle (or an explicit refusal).
11. Worktree manager with setup scripts and `$ROOT_WORKTREE_PATH` (leases optional but recommended).
12. Plugin loader for `plugin.json` + `.cursor-plugin/plugin.json` (content only).

**A Devin-compatible cloud session system (minimal rebuildable set)**

1. Session resource with the documented state machine and reason taxonomy.
2. Environment blueprint parser (`initialize`/`maintenance`/`knowledge`/`runs-on`/`shell`/`post-build`/
   `clone`) + build pipeline + snapshot registry + logs/cancel/pin.
3. VM placement (platform or outpost pool) with resumable disk and sleep/wake.
4. Message API with attachments; no idempotency claim unless implemented.
5. Security-profile object + 5-level binding + intersection + (HC: per-effect revalidation).
6. Secrets store scoped to org/env/session with injection rules.
7. Playbook + knowledge stores with scope, macro, trigger, repo pin.
8. Memory drive (git) with merge/retry + a consolidation job.
9. Automations: trigger adapters, condition tree, action limits, required `run_as`, concurrency caps.
10. Outpost queue: K8s-style objects, cursor list/watch, at-least-once + claim CAS + deadline + release.
11. `devin-remote`-equivalent worker: pinned binary, per-session state dir, clean env, exit-on-session-end.
12. Delivery: branch push/PR, structured output validation, review loop, attachments.
13. Metering: per-action + VM-time accounting, per-session cap, org/user caps, idle sleep.

## 16. Artifacts, verification notes and blockers

**Artifacts produced (all repo-local, under `repo_take/re-sandbox/work/cursor-devin/`)**

| Artifact | Contents |
|---|---|
| `obs/help-main.txt`, `obs/help-subcommands.txt`, `obs/help-deep.txt`, `obs/help-hidden.txt` | Verbatim `--help` for the CLI and every subcommand, including the hidden `sandbox`/`acp` surfaces |
| `obs/runs/unauth-surface.txt`, `obs/runs/create-chat.txt` | Unauthenticated surface probes and the `create-chat` ID-then-hang behaviour |
| `obs/sandbox-probe.txt`, `obs/sandbox-net.txt` | Sandbox policy object, write-denial, DNS-denial, `--network` success, `--sb-debug` paths |
| `docs/cursor/*.md` (33 files) | Official Cursor docs subset actually used for every `DOCUMENTED` Cursor claim |
| `docs/devin/*.md` + `v1-openapi.yaml` + `v3-openapi.yaml` | Official Devin docs subset and the complete published API schemas |
| `probe-ws/` | Rule-discovery probe (`AGENTS.md`, 2 `.mdc`, `.cursorrules`) that produced `ruleCount: 4` |
| Installed CLI | `repo_take/re-sandbox/home/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/` — 558 MB, plus `~/.local/bin/agent` and `~/.local/bin/cursor-agent` symlinks |

**Blockers and limitations (explicit)**

1. **Both products are auth-gated.** No Cursor model call, no Cloud Agent call, no Devin session, no
   Devin CLI binary. Every runtime claim beyond help/config/sandbox probes is documentation-derived.
2. **Cursor `ls`/`resume` need a TTY.** Under piped stdin they crash in Ink (`Raw mode is not supported`)
   and hang; recorded, not worked around.
3. **`create-chat` prints a UUID then blocks on network** (timed out at 12 s). The ID is real; the
   storage location is not observable without auth.
4. **Documented-vs-observed drift exists** (idle-release default `0` vs `3600`; undocumented config keys;
   hidden commands). Treated as a finding, not an error.
5. **No Devin installer was fetched** (out of scope for the time box and not needed for the documented
   contract depth achieved). This is why Part B has zero `OBSERVED` rows.
6. **`reports/research/competitors-cursor-devin.md` is not Git-visible**: `.gitignore` unignores
   `claude-code-*.md` and `deepseek-*.md` by exact path but not this file. Parent action required if the
   file must be committed: add `!/reports/research/competitors-cursor-devin.md` (I did not edit
   `.gitignore`; output scope is one file).
7. **Disk:** the 558 MB Cursor install tree remains in the sandbox for reproducibility. It is a
   task-created artifact; if space is needed, remove
   `repo_take/re-sandbox/home/.local/share/cursor-agent/versions/2026.10.22-27dcf5f/` and the two
   symlinks after confirming no other lane uses them.
8. **No test suites were run** for HorizonCode; the comparison column is design/source presence, not
   acceptance. Nothing in this report should be cited as `VERIFIED`.

**What this report does *not* claim**

- That any HorizonCode gap listed here is a V1 release blocker. `§10.18` and the phase ledger decide
  ordering; this document only records the delta and the likely owner.
- That any competitor capability should be adopted. Every adoption still requires a `§17` decision, a
  topic-owner update, a `§32` acceptance row, and (if external source were ever consulted) a `§42`
  provenance entry. No source was reused here.
