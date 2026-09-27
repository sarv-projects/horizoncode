# cc-haha: third-party Claude Code workspace and channel shell

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `76619c9c64807e1e52c3027cc6e9ca0b6f6c1852`. This is a third-party project; its public source does not establish Anthropic's private Claude Code implementation.

## Scope and HLD

cc-haha is an MIT-licensed desktop/workspace and multi-channel project that wraps or integrates Claude Code-oriented sessions. Public code includes an Electron/React/Vite desktop, Bun-based CLI/runtime pieces, service and IPC layers, local indexing, session recovery and messaging connectors (including Telegram/WhatsApp/WeChat families). Project claims about repaired/reconstructed Claude Code sources are not independently verifiable from this repository and are not treated as authoritative Claude internals.

## LLD and visible models

The desktop separates Electron main/preload/renderer responsibilities and validates IPC channels/capabilities. Workspace/session services manage per-session Git worktrees, diffs, approval UI and browser surface. The common adapter layer hosts cross-channel conversation/session persistence, queues, permission synchronization and recovery logic. A local SQLite index supports workspace/repository lookup. A subagent-run service provides visible child-run tracking in the project's own orchestration layer.

The project documents a temporary worktree mode: the worktree may be cleaned at session end while chat history remains, so the old conversation cannot continue editing that removed branch. This shows why transcript persistence and workspace persistence must be modeled separately.

## Flows and permission boundaries

Desktop or messaging channel → application/session service → CLI/agent process → worktree/tools → transcript/events → approval/diff/result UI. Permissions are surfaced through GUI/channel synchronization. CLI print mode can skip a trust dialog; hooks/MCP may still execute. A bypass-permissions mode removes checks. Therefore, UI visibility does not substitute for process-level policy and workspace sandboxing.

## Limits

- The adapter/desktop code can be inspected; Claude Code model/runtime internals cannot be established from this third-party wrapper.
- Multi-channel session recovery is project-owned and can differ from native agent resume semantics.
- Chat history may outlive its worktree or process; this is not proof of reproducible code state.
- Permission prompts and IPC channel validation need threat-model review, especially around untrusted channel input and local MCP/hooks.
- Do not port code or claims about a purported reconstructed engine without provenance and license review.

## Relevance to HorizonCode

Useful comparison for session/worktree UX, messaging channels, visible subagent runs and the distinction between transcript and workspace lifetime. For external workers, HorizonCode should separately persist native session ID, worktree ID/commit, permission state, event cursor and verified result.

## Sources

[Repository](https://github.com/NanmiCoder/cc-haha) · [Workspace behavior](https://github.com/NanmiCoder/cc-haha/blob/main/docs/en/desktop/workspace.md) · [CLI safety](https://github.com/NanmiCoder/cc-haha/blob/main/docs/en/cli/reference.md) · [Common session recovery adapters](https://github.com/NanmiCoder/cc-haha/tree/main/adapters/common)
