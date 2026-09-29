# Superset: workspaces for parallel coding-agent processes

2026-09-29 coverage follow-up pins revision
[`f37599e2774a99dce67f21b887c88bac331da6fc`](source-audit-coverage/superset-f37599e.csv):
10,286 tracked files, 8,569 selected source candidates, 8 full, 3 partial, and 8,558
unread. This is not an exhaustive codebase read. The per-file ledger and cross-source
findings are linked from [coverage index](source-audit-coverage/README.md).

> INTERNAL RESEARCH — initial review 2026-09-27 at `3fe2c3636e303ecd3a62d4e63bfaba4428bfbdaf`; focused follow-up 2026-09-28 at `f37599e2774a99dce67f21b887c88bac331da6fc`. Source-path review of workspace model, terminal/session schema, agent launch/binding, hooks, subagent transcript, and resume. Not a line-by-line review of the full repository; no tests or benchmarks were run and no source was copied.

## HLD

Superset is a desktop/web/CLI/MCP workbench for launching many coding-agent CLIs in isolated project workspaces. Its value is primarily workspace and process orchestration, terminal persistence, diffs/PR review, remote access and automation; it does not proxy every model call or impose one universal agent runtime.

| Resource | Semantics |
|---|---|
| Project | Repository/root grouping. |
| Workspace | Git worktree/branch plus workspace-scoped files, terminals and ports. |
| Persistent terminal | Long-lived PTY/daemon process and terminal scrollback. |
| Agent | Preset or configured CLI process with launch options/hooks; can be a third-party agent. |
| Device/automation | Remote host or scheduled/triggered workflow surface. |

## LLD and tracking schema

Host service owns a SQLite/Drizzle schema with projects, workspaces, terminal sessions, terminal-agent bindings, host agent configs and PR records. `terminal_sessions` identifies the PTY/process lifecycle (status, timestamps, disposal request); it is not itself the coding agent's conversation/session ID. `terminal_agent_bindings` associates a terminal with workspace and agent IDs plus an opaque `agent_session_id`, event/lifecycle timestamps and end reason, allowing agent-reported detached/resumed/disposed transitions when the adapter exposes them.

The MCP/CLI can create, list, send input to, inspect and close terminals, and exposes agent/workspace actions. This makes Superset capable of tracking a child agent's lifecycle to the extent that the integration reports a stable session ID and lifecycle events. It does not imply a universal transcript, tool-call event stream, cost record, task graph or recoverable session for every arbitrary CLI.

## Flows and external subagents

Project → workspace/worktree → terminal/PTy → agent command and preset hooks → CLI/desktop surface. A workspace may be controlled through UI, CLI, MCP or remote device; persistent terminal service retains process/scrollback. An agent binding can join a PTY to an opaque peer session ID when known. On process termination, the PTY result and agent-session result must be reconciled separately.

**Answer to “can we track Codex/OpenCode as subagents?”** Yes, at the process/workspace level through terminal identity, and at the peer-session lifecycle level only when the child agent integration exposes/binds its session ID and events. For robust HorizonCode supervision, add an adapter that records peer version, native session/thread ID, event cursor, parent task, worktree/base commit, requested permissions, cancellation outcome, usage evidence and result artifacts. A PID or terminal ID alone cannot prove the agent's task status or completion.

## Reliability and security

- A PTY can survive UI detachment while the CLI cannot resume; conversely an agent session may persist after PTY exit. Persist both identities.
- Project issue #5304 documents a gap between terminal persistence and agent session history; do not assume every transcript can be restored through Superset.
- Worktree isolation helps prevent concurrent writes, but integration still needs merge conflict detection and combined verification.
- Built-in presets can pass permissive skip/bypass flags for some agents. Review effective child permissions before launching unattended work.
- Old reports of PTY leaks/timeouts are versioned issues; distinguish fixed older defects from current release behavior.

## Relevance to HorizonCode

Study worktree lifecycle, multi-session UI and terminal abstraction. HorizonCode should use Superset-like process management only behind its own durable external-attempt record and permission controller. Never collapse terminal status, ACP/native session status, task state and verified outcome into one enum.

## Pinned follow-up: launch, hooks, child roster, and recovery

At `f37599e2774a99dce67f21b887c88bac331da6fc`, the New Workspace UI turns a selected
agent profile, prompt, and attachments into an `AgentLaunchRequest`; the desktop
orchestrator stages prompt/attachments and launches a terminal command. A separate
host `agents.run` route supports automation. Host profiles are SQLite-backed and
include command/argv, prompt transport, environment, resume/fork arguments, and UI
metadata. Renderer launch idempotency is process-local. These are distinct launch
surfaces; a Horizon adapter should normalize them behind one checked launch contract,
not assume the UI path protects direct host callers.

Root terminal-agent bindings persist, while the subagent roster is deliberately
process-local and only live children are returned to the UI. After restart, a missing
child roster therefore means **unknown visibility**, not “no children.” Hook-derived
status is an activity projection, not correctness evidence. The inspected notification
route accepts lifecycle hooks without authentication; knowing a terminal ID can allow
status spoofing, and no route-level rate limit was found. Horizon's event ingestion
must bind authenticated source, launch ID, workspace, and fence, bound request rates
and payload sizes, and retain a separate `UNKNOWN` state for missing peer events.

Transcript paths are lexically constrained to absolute `.jsonl` files under home, but
the inspected check does not resolve symlinks; a symlink could cross the intended
path boundary unless the eventual implementation uses safe descriptor-based open and
canonical containment checks. Claude/Codex transcript adapters also include reasoning
or reasoning-summary blocks. Horizon must not expose private reasoning by default;
only explicitly supported user-visible events enter its transcript or search index.

Auto-resume has a concrete crash window: the durable candidate claim changes the
original end reason to `resumed` before launching the replacement terminal. A caught
launch failure rolls back, but process death between claim and successful launch can
leave the candidate unavailable with no successor. This is inferred from the inspected
claim/rollback path and was not reproduced. Horizon's durable outbox/launch state must
survive this window: claim with an expiring owner/fencing token, write launch intent
and reservation before spawn, then reconcile claim/receipt on restart; never mark
resumed based only on claim. Add a crash test after claim, before spawn, between spawn
and receipt, and after receipt before UI event. This refines `AX-359` and the
`WorkerExecution` launch protocol; it does not make Superset a durable task controller.

Evidence at the pinned revision: [launch request UI](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/apps/desktop/src/renderer/components/NewWorkspaceModal/components/PromptGroup/PromptGroup.tsx#L311), [launch request contract](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/shared/src/agent-launch-request.ts#L17), [desktop orchestrator](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/apps/desktop/src/renderer/lib/agent-session-orchestrator/agent-session-orchestrator.ts#L16), [host launch route](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/agents/agents.ts#L47), [agent profile schema](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/db/schema.ts#L193), [hook endpoint](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/notifications/notifications.ts#L105), [child roster](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/store.ts#L244), [transcript path check](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/transcript-path.ts#L4), [resume route](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/terminal-agents/terminal-agents.ts#L101), and [resume lifecycle tests](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/terminal-agents/terminal-agents.test.ts).

Additional inspected tests at this pin: [hook routing/attribution](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/notifications/notifications.test.ts#L179), [transcript path predicate](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/terminal-agents/transcript-path.test.ts), [profile-backed launch](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/packages/host-service/src/trpc/router/agents/agents.test.ts), and [desktop request/orchestration](https://github.com/superset-sh/superset/blob/f37599e2774a99dce67f21b887c88bac331da6fc/apps/desktop/src/renderer/lib/agent-session-orchestrator/agent-session-orchestrator.test.ts). The resume tests exercise concurrent callers and handled launch failure but do not inject process death after the durable claim.

## Primary references

[Mental model](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/superset-model.mdx) · [Workspaces](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/workspaces.mdx) · [Host schema](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/db/schema.ts) · [Agent presets](https://github.com/superset-sh/superset/blob/main/packages/shared/src/builtin-terminal-agents.ts) · [MCP server](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/mcp-server.mdx) · [Session-history issue #5304](https://github.com/superset-sh/superset/issues/5304)
