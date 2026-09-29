# Claude Code — public architecture and workflow map

> INTERNAL RESEARCH — reviewed 2026-09-27. Anthropic does not publish Claude Code's implementation source tree. This is a map of documented public behavior and configuration contracts, not a reverse-engineered internal HLD/LLD. Private schemas and undisclosed flows are marked unknown.

## Evidence boundary

The primary evidence is Anthropic's [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works), [subagents](https://code.claude.com/docs/en/sub-agents), [agent teams](https://code.claude.com/docs/en/agent-teams), [hooks](https://code.claude.com/docs/en/hooks), and [settings](https://code.claude.com/docs/en/settings). These describe supported product interfaces. They do not expose the full implementation or guarantee that local storage is a public stable API.

As of this review, the official docs describe Auto permission mode and note that it is the interactive terminal/VS Code default on Claude Code v2.1.283 or later. Use documentation and feature negotiation rather than assuming an installed release behaves identically.

## Public high-level architecture

    Terminal / desktop / IDE / web / Remote Control / Slack / CI
                              │
                    Claude Code harness
             context │ tools │ permissions │ sessions
                              │
                       Claude model
                              │
       local or remote execution environment + extensions
        filesystem / shell / Git / MCP / skills / hooks
                 │                         │
           session JSONL              isolated subagents

The same documented model/tool loop appears across interfaces; the execution environment and client experience vary. Public docs describe three repeating activities: gather context, take action, verify results. The model chooses the next action from the previous tool result.

## Public component and interface map

| Area | Public responsibility | Configuration or data contract |
|---|---|---|
| Project context | Read project files, Git state, instruction files, persistent memory. | CLAUDE.md; can also read AGENTS.md. Auto-memory loads up to the first 200 lines or 25 KB of MEMORY.md. |
| Agent loop | Call file, search, shell, web and code-intelligence tools; feed outputs back to the model. | Tool contracts are documented, but no public internal dispatcher schema. |
| Permission system | Gate shell, edits, tool calls and other actions. | Organization/user/project/local settings, allow/ask/deny rules and permission modes. Current Auto mode applies classifier review to most actions and blocks risky actions; other modes include Manual, Accept edits, and Plan. |
| Context management | Include history, files, tool output, instructions, skills, MCP tools; compact as context fills. | Context inspection via /context; auto-compaction clears older tool output before summarizing; MCP tool definitions are deferred and loaded on demand. |
| Sessions | Persist user/assistant messages and tool uses; resume or fork. | Local plaintext JSONL under ~/.claude/projects/; session resume/fork documented. Internal line-level schema is not published as a stable contract. |
| Checkpoints | Snapshot files before edits and allow rewind. | Separate from Git; covers file content only, not remote database/API/deploy side effects. |
| Skills | Load reusable workflow instructions on demand. | Markdown files with YAML frontmatter; descriptions are visible for selection while full body loads on use. |
| MCP | Connect external tools/services. | Configured server definitions; tool discovery is deferred. |
| Hooks | Run user commands or prompts at lifecycle/tool events. | Settings JSON hook entries and documented hook event/input/output contracts; hooks can block, continue, modify behavior, or provide feedback depending on event. |
| Subagents | Run focused workers in separate context windows with prompts, tools and permissions. | Markdown files with YAML frontmatter; built-ins include Explore, Plan, general-purpose and task-specific helpers. |
| Agent teams/background agents | Coordinate independent Claude Code sessions and multi-agent activity. | Separate from single-session subagents; shared tasks/messages and team visibility are documented. |
| Interfaces | Terminal, desktop, IDE, web, remote control, Slack and CI/CD. | Interface is a client surface; model and tool loop remains the harness. |

## Documented session and subagent schemas

These are schema families, not a claim to reproduce every internal field. The authoritative current field list is in each linked reference page.

| Schema family | Public fields/concepts | Authoritative docs |
|---|---|---|
| Project instructions | Plain text project rules and context in CLAUDE.md; instruction hierarchy and optional imports. | [Memory and instructions](https://code.claude.com/docs/en/memory) |
| Subagent definition | Name, description, model selection, allowed/disallowed tools, permission mode, skills, memory scope, hooks, background behavior, isolation options and prompt body. | [Subagent frontmatter reference](https://code.claude.com/docs/en/sub-agents) |
| Hook definition | Hook event, matcher, command/prompt/agent handler, timeout and behavior-specific fields. Hook I/O is JSON where supported; exit status and output can affect action lifecycle. | [Hooks reference](https://code.claude.com/docs/en/hooks) |
| Permission rule | Tool/action pattern and allow/ask/deny posture, layered by organization/user/project/local scope. | [Permissions](https://code.claude.com/docs/en/permissions) |
| Settings | Typed JSON settings with managed, user, project and local sources; settings include permissions, hooks, MCP, sandbox, model, environment and feature controls. | [Settings](https://code.claude.com/docs/en/settings) |
| Session history | Local JSONL stream sufficient for product resume/fork and UI projections. | [How sessions work](https://code.claude.com/docs/en/how-claude-code-works#work-with-sessions); exact line schema is not a public API. |

Do not parse undocumented JSONL as an HorizonCode integration contract without version detection, fixture tests, and a fallback for schema changes. Where the official SDK or ACP adapter is available, use the supported protocol surface.

## User-linked third-party archive: README-only leads

The user-linked [`codeaashu/claude-code` README](https://github.com/codeaashu/claude-code/blob/main/README.md)
claims tool families including file operations, notebook editing, `glob`/`grep`, web
search/fetch, shell, MCP/LSP, subagents, team messaging, tasks, worktrees, and deferred
tool discovery. These are README claims from a repository that identifies its source
as leaked proprietary Anthropic code and says it is unlicensed; the listed counts are
internally inconsistent. Only the README and LICENSE were read to establish this
provenance boundary. No source tree, branch, implementation detail, code, schema, or
asset was used. Treat the inventory only as a set of prompts to compare against
independently sourced designs.

The general families already have HorizonCode owners or proposed rows: file/search
and shell tools plus lazy schema materialization in `ARCH/10`; web search/fetch in
`AX-376`; MCP/LSP in `ARCH/21`/`AX-202`; subagent delegation and messaging in
`ARCH/16`/`ARCH/32`; worktrees in `ARCH/25`; and workflow authoring in `AX-377`.
Notebook-specific editing is not added: the README alone does not establish a user
need, a safe notebook cell/output contract, or an independent implementation source.
No extra tool is justified by this unverified inventory.

## Main task flow

1. Load repository context, CLAUDE.md/AGENTS.md, settings, available tools and extensions.
2. Interpret the request and choose context/search/tool operations.
3. Request or perform actions under the current permission mode.
4. Incorporate tool output and repeat; the user may steer mid-task.
5. Verify by tests, commands, code inspection, or user feedback.
6. Record session messages and tool results; file checkpoints are available for edits.
7. Return a summary. Git commit/PR activity occurs only when requested or when an authorized workflow invokes it.

Claude Code's official guide presents this as an adaptive loop, not a deterministic staged planner. A model may chain many actions and course-correct, but the public docs do not define a durable dependency graph with independently verified task nodes.

## Context, persistence, and long horizon

- Sessions are tied to a directory/worktree and can resume with the same ID or fork to a new ID.
- The transcript is stored locally as plaintext JSONL. New sessions begin with fresh context; auto-memory and instruction files can carry learnings forward.
- Auto-compaction may discard early conversational detail; persistent project rules belong in CLAUDE.md.
- Subagents isolate context and return a summary. Background agents and agent teams support broader parallel workflows.
- `SubagentStart` hooks receive the child `agent_id` and `agent_type`; their `additionalContext` output is appended before the child's first prompt. The hook cannot block creation. Repeated hook delivery skips a context copy that is still present, and adds it again after compaction removes it. This is a Claude Code-specific context-delivery behavior, not a durable cross-agent idempotency or authorization contract.
- File snapshots enable undo of file edits, but Git is separate and external service side effects cannot be rewound by file checkpoints.

Anthropic's public [long-running harness research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents) and [planner/generator/evaluator work](https://www.anthropic.com/engineering/harness-design-long-running-apps) describe experimental patterns beyond what can be claimed as an internal Claude Code implementation: initializer/coder handoffs, durable feature lists/progress, Git checkpoints, separate evaluator roles and longer-running app checks. They are research approaches, not proof of a universal best design.

## Subagent tracking

Inside the documented product, the parent can delegate focused tasks and receive summaries. Agent teams and background agents expose more session-level visibility. The exact internal event store for all nested tool activity is not a public stable interface.

For HorizonCode orchestration, treat a peer session as an ExternalAttempt with an independent task ID, protocol/session ID, worktree and base commit, permission snapshot, event cursor, start/end state, and final receipt. Record only events the selected interface emits. A summary from Claude Code does not prove test success. A child spawned by a peer is trackable by the parent only if the peer exposes its identity and events through its supported API/protocol.

## Testing, debugging, code review, and PR workflows

- Testing/debugging: the shell and code/search tools allow the model to run tests, inspect failures, change code, and rerun checks. The harness does not make an agent's self-report independent verification.
- Code understanding: repository search, file reads, Git state and optional code intelligence support multi-file navigation.
- Review: read-only Explore/reviewer subagents can inspect diffs and report findings. A separate reviewer has a distinct context but may still share the same model/failure modes.
- PR support: Claude Code can use shell/Git, MCP integrations, hooks, IDE/GitHub workflows and CI. Product documentation does not define a universal built-in PR lifecycle schema that replaces GitHub/GitLab state.
- Development workflows: CLAUDE.md, skills, MCP, hooks, plugins/extensions, settings and CI integrations extend behavior. Extension authority and permission policy must remain explicit.

## Architecture strengths and limits for HorizonCode

**Useful patterns:** progressive context loading; focused subagent contexts; tool restrictions; separate file checkpoints and Git state; user steering during execution; broad interface parity; explicit hook lifecycle.

**Do not infer:** a public per-task durable store; exact JSONL format; cross-provider subagent orchestration; crash-safe external-effect replay; independent completion proof; or a source-available implementation architecture.

**HorizonCode implications:** keep intent/spec/task state outside the peer conversation; wrap each peer call in a durable adapter attempt; map permission requests into HorizonCode Guard; require a diff and evidence bundle; preserve user clarification and approval decisions; never treat file rewind as rollback for remote side effects.

For child context, `SubagentStart` is a useful adapter hook but runs too late to be
HorizonCode's policy gate: it cannot prevent creation. HorizonCode must authorize and
persist its bounded `ContextPacket` before dispatch; an adapter hook may deliver only
that already-approved packet. HorizonCode's stable dispatch ID and `ContextEpoch`
digest remain the replay authority, including across compaction and reconnect.

## Source and public-document index

- [How Claude Code works](https://code.claude.com/docs/en/how-claude-code-works)
- [Custom subagents](https://code.claude.com/docs/en/sub-agents)
- [Agent teams](https://code.claude.com/docs/en/agent-teams)
- [Hooks](https://code.claude.com/docs/en/hooks)
- [Settings](https://code.claude.com/docs/en/settings)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Memory](https://code.claude.com/docs/en/memory)
- [Anthropic long-running agent research](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)
- [Planner/generator/evaluator research](https://www.anthropic.com/engineering/harness-design-long-running-apps)

## 2026-09-29 subagent memory and source-boundary follow-up

The official [`sub-agents`](https://code.claude.com/docs/en/sub-agents) and
[`memory`](https://code.claude.com/docs/en/memory) pages were rechecked on
2026-09-29. A normal child starts in a fresh context with its own prompt and the
delegation message; applicable instruction files, Git status, and explicitly
preloaded skill bodies are also included. The parent's conversation transcript,
output style, and auto-memory do not carry over; a fork is a distinct exception.
Explore/Plan and `omitClaudeMd` have further instruction-loading exceptions.
Subagent memory is separately configured per agent with `user`, `project`, or
`local` scope. When enabled, that agent gets its own memory instructions and Read,
Write, and Edit tools, plus the first 200 lines or 25 KB of that memory's
`MEMORY.md`; topic notes are loaded on demand. Skills named in the profile are
preloaded in full. These are documented product contracts, not evidence about
undocumented storage internals.

The user-linked [`codeaashu/claude-code` README](https://github.com/codeaashu/claude-code/blob/main/README.md)
was inspected as a lead list only at the visible main snapshot reported as
`6a2590911df240ff5ea56aa355696cfb94d128cb`; README cache freshness is uncertain.
It describes tool, command, service, bridge, coordinator, skill, plugin, task,
memory, and remote subsystems, but is internally inconsistent about inventory
counts. The repository explicitly calls its `src/` leaked Anthropic source and
says it is not licensed for redistribution; its LICENSE says `UNLICENSED`.
Therefore no `src/`, backup branch, leaked copy, or implementation detail was
inspected or adopted. Its list is not source-verified and does not justify adding
a second HorizonCode tool catalog. Public reporting on the March 31, 2026
source-map disclosure is [Axios](https://www.axios.com/2026/03/31/anthropic-leaked-source-code-ai);
this is incident context only, not a technical source.

HorizonCode disposition is recorded in `DEC-072`, `REQ-MEM-005..007`,
`ARCH/16`, `ARCH/27`, and `ARCH/33`: synthesize a per-child context packet from
the approved task contract, explicit source references, effective policy, and
bounded memory retrieval. Do not inherit the parent's transcript or all memory
implicitly. Optional agent-profile memory remains provenance-bound context;
child writes go through the existing reviewable memory-candidate path. See
`ARCH/26` for the decision crosswalk and `research docs/tests.md` for acceptance
cases.
