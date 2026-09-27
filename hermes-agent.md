# Hermes Agent: general agent gateway, session store and tool ecosystem

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `516535b54275e963a82b4c28f866338fb768e7bc`. Focused source audit of session persistence, gateway routing and coding-relevant integrations; Hermes is a general-purpose assistant, not a coding-agent-only system.

## HLD

Hermes Agent is a Python agent runtime exposed through CLI and a long-lived gateway serving multiple messaging surfaces. The runtime combines model/provider routing, tools, skills, memory, scheduled jobs/cron and channel adapters. Gateway state maps inbound conversations to durable agent sessions; integrations and profiles configure behavior around a shared runtime.

## LLD and persistence

The session layer uses SQLite at `~/.hermes/state.db` with WAL mode, canonical sessions/messages and FTS5 indexing. The documented schema includes sessions (session ID, source/platform/user/model/title, timestamps, token metadata and optional parent linkage), messages and a full-text index. A `gateway_routing` mapping associates deterministic platform/user/conversation routing keys with session IDs. Session import paths can normalize histories from other agents, but import is transcript migration—not replay of original system prompts, tool side effects or execution state.

Sessions retain conversation context across gateway restarts and channel reconnects. Automatic retention/pruning is configurable and documented; verify the active version's default and ensure legal/operational retention requirements override convenience defaults. Token counters and parent-session fields aid observability/routing but do not amount to a coding task DAG, workspace checkpoint, lease or evidence ledger.

## Flow

Channel update → normalize identity/routing key → resolve or create session → load transcript/context → provider/model and tool loop → persist messages/tool results → send channel response. Coding-oriented use would add repository tools/skills or delegate to external coding CLIs; those integrations need their own workspace and permission boundaries.

## Limits and security questions

- Persistent conversation history does not mean safe continuation of interrupted tool operations. Reconcile side effects before retry.
- A multi-channel gateway increases identity/authorization risk: user, group, bot and session routing must be explicit and tested.
- FTS indexes and imported transcripts may include sensitive code or secrets; retention and deletion must include indexes/backups.
- Cron/scheduled tools require idempotency, timezone semantics and bounded permissions.
- A parent session pointer does not prove subagent lineage, complete cost attribution or verified child completion.

## Relevance to HorizonCode

Study long-lived gateway routing, transcript persistence/search and cross-channel session identity. Keep HorizonCode coding-task state separate: bind session IDs to external-attempt/task records, store worktree and repository revisions, permission snapshots, effect receipts and independent verification evidence.

## Primary references

[Project/architecture](https://github.com/NousResearch/hermes-agent) · [Session guide](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/sessions.md) · [Session persistence implementation](https://github.com/NousResearch/hermes-agent/blob/main/gateway/session_persistence.py) · [Repository](https://github.com/NousResearch/hermes-agent)
