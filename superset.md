# Superset: workspaces for parallel coding-agent processes

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `3fe2c3636e303ecd3a62d4e63bfaba4428bfbdaf`; desktop release v1.30.2 (2026-09-22). Focused audit of workspace model, terminal/session schema, agent bindings and MCP surface.

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

## Primary references

[Mental model](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/superset-model.mdx) · [Workspaces](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/workspaces.mdx) · [Host schema](https://github.com/superset-sh/superset/blob/main/packages/host-service/src/db/schema.ts) · [Agent presets](https://github.com/superset-sh/superset/blob/main/packages/shared/src/builtin-terminal-agents.ts) · [MCP server](https://github.com/superset-sh/superset/blob/main/apps/docs/content/docs/mcp-server.mdx) · [Session-history issue #5304](https://github.com/superset-sh/superset/issues/5304)
