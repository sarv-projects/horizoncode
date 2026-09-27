# Qwen Code: architecture and implementation study

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `88d881491b321e9a4b3e90d5b219c3ce73b6fe51`. Focused source audit of runtime boundaries, daemon/ACP, task delegation and persistence; not a line-by-line certification of the repository.

## Evidence and scope

Qwen Code is a public TypeScript/npm-workspace coding-agent implementation. This note describes documented architecture and source-backed public contracts. Release-only/nightly behavior is labeled separately; a main-branch observation is not automatically in the stable release. Start with the [architecture guide](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/architecture.md), [daemon index](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/daemon/00-index.md), [subagent guide](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sub-agents.md), and [task tool](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/tools/task.md).

## HLD

The architecture has two execution modes. In direct mode, CLI/TUI or headless surfaces construct the core runtime in-process. In daemon mode, SDK, IDE, web, channel, and custom clients connect to `qwen serve` over HTTP/SSE; a workspace runtime and ACP bridge own a `qwen --acp` child which runs the shared core. Platform UI and transport stay outside the agent core.

| Boundary | Responsibility |
|---|---|
| `packages/cli` | Executable, configuration assembly, interactive/headless/ACP/daemon entry points and adapters. |
| `packages/core` | Agent loop, model/provider calls, prompt/context, tool registry and dispatch, permissions, sessions, memory, telemetry. |
| `packages/acp-bridge` | ACP child/channel lifecycle, session multiplexing, event forwarding, cancellation and permission mediation. |
| SDK and web shell | Process-backed local query or daemon HTTP/SSE client; React projection of daemon events. |
| Extensions/channels | Add skills, agents, MCP, commands and host-specific integration without putting UI concerns in core. |

## LLD and contracts

Subagents are Markdown files with YAML frontmatter: `name`, `description`, optional `model`, `approvalMode`, tool allow/deny lists, followed by the instruction body. Project-level `.qwen/agents/` takes precedence over user and extension agents. Task delegation can fork parent context, constrain tools, specialize roles, run foreground or background and surface progress. A task result/status is distinct from proof that the delegated code satisfies acceptance criteria.

Daemon mode has a versioned typed event contract, HTTP routes, SSE replay and paged transcripts. A daemon workspace runtime owns its ACP bridge and child; filesystem, session, MCP transport and environment scope resolve to that workspace. Multi-client permission mediation allows connected clients to observe a permission request and applies a configured voting policy. The server-side event ring supports reconnect with `Last-Event-ID` within its retention window; persisted transcript replay is a separate path.

## Flows and delegated agents

Direct request: CLI resolves layered config → builds core → model/tool loop → policy check → tool execution in workspace → TUI/headless events.

Daemon request: client SDK → authenticated daemon route → workspace resolution → ACP bridge → child ACP session → shared core/tool loop → bridge event stream → SSE clients. Subagent task: resolve Markdown profile/executor → prepare bounded prompt/context/tools → launch owned process or selected workspace/worktree → stream events/result → parent incorporates output. Ownership matters: unnamed caller-owned `working_dir` work runs foreground; the agent cannot safely promise background lifecycle ownership over an external directory.

Qwen's native adapters demonstrate capability asymmetry. The Claude adapter uses ACP and can retain/continue state when the peer supports it. Codex `app-server --stdio` is treated as one-task/ephemeral: no general message-continuation or Qwen-side session recovery, and progress/usage visibility is limited. Extra peer permission or user-input requests may be declined. Adapter support must therefore report capabilities, not merely a common `run()` method.

## Reliability, security, gaps

- ACP peer lifecycle and durable task lifecycle are different: the daemon/session event model does not make every external peer resumable.
- SSE replay is bounded; consumers still need gap detection and transcript reconciliation.
- Team coordination is experimental and uses a restricted worker model; verify writer/worktree and parent-death cleanup behavior in the exact build.
- A daemon/bridge adds authentication, workspace resolution, multi-client permission and child-process trust boundaries. Local binding is not itself an authorization model.
- Stable v0.24.5 is listed on Sep 24; Sep 25 nightly notes include managed-session journal/failover work. Do not attribute nightly-only work to stable without a tagged-source check. [Releases](https://github.com/QwenLM/qwen-code/releases).

## Relevance to HorizonCode

Study package boundaries, daemon event replay, workspace ownership, the Markdown agent profile, and explicit peer capability negotiation. HorizonCode should persist its own task/attempt/evidence ledger; a Qwen/ACP session ID is a foreign reference, not completion proof. For external workers, persist peer identity, executable/version, protocol capability snapshot, worktree commit, event cursor, cancellation result and result artifact.

## Primary references

[Architecture](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/architecture.md) · [Daemon architecture](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/daemon/01-architecture.md) · [Daemon protocol](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/qwen-serve-protocol.md) · [Subagents](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/sub-agents.md) · [Teams](https://github.com/QwenLM/qwen-code/blob/main/docs/users/features/multi-agent-coordination.md) · [Task tool](https://github.com/QwenLM/qwen-code/blob/main/docs/developers/tools/task.md)
