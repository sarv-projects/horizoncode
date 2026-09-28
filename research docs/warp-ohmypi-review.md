# Warp and oh-my-pi runtime review

Review date: 2026-09-28. Focused source traces through runtime/orchestration,
provider/catalog, persistence/compaction, permissions/subagents, and terminal UI.
Relevant test paths were identified but their assertions were not opened or verified.
This is not a literal read of every file in either large repository. No upstream code
was copied and no tests were executed. Product specs are not treated as proof of
shipped behavior.

| Repository | Pin | License / reuse boundary |
|---|---|---|
| [warpdotdev/warp](https://github.com/warpdotdev/warp/tree/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7) | `0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7` | Root Cargo workspace says AGPL-3.0-only. A `LICENSE-MIT` file also exists, but that does not establish every file is dual-licensed. Pattern-only absent file-specific clearance. |
| [can1357/oh-my-pi](https://github.com/can1357/oh-my-pi/tree/6dad5de125c2a508983c0f3e7ef9e79205ab71df) | `6dad5de125c2a508983c0f3e7ef9e79205ab71df` | MIT at root and coding-agent package. No source copied. |

## Warp: UI orchestration over conversation topology

Warp's TUI orchestration model is a projection over shared conversation history and
topology; its local retained TUI sessions/event consumers are a separate UI/runtime
concern. The inspected local child path prepares/materializes an Oz session, attaches
it to shared conversation history, and prompts it. The TUI path explicitly rejects
unsupported local non-Oz child harnesses. Tree navigation and status aggregation are
described in the feature design, but that spec is not evidence that every described UI
behavior works at runtime.

The AgentWake path classifies a wake-up by structured origin rather than prompt text,
then sends a typed input. The client deduplicates server-echoed message IDs before
injecting pending messages. This is a useful message-inbox pattern; the inspected
checkout verifies client-side dedupe only, not server-side exactly-once delivery or
server persistence. A local SQLite table stores conversation metadata/tasks and a
last-observed event sequence; a migration removed earlier local orchestration event
and message persistence. Current event/message reconciliation is client memory plus
server acknowledgements, so a durable local mailbox must not be inferred from the old
migration.

Local kill tombstones a child before cancellation/deletion; remote cancellation is
best-effort. Nested children are killed deepest-first. Restoration skips unsupported or
unidentifiable child kinds and ignores stale async loads after the parent tree changes.
Those are useful failure behaviors, but do not imply durable remote cancellation.

Pinned evidence: [workspace license](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/Cargo.toml#L25-L28), [orchestration model](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/crates/warp_tui/src/orchestration_model.rs#L101-L112), [local child launch](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/crates/warp_tui/src/orchestration_model.rs#L778-L867), [kill path](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/crates/warp_tui/src/orchestration_model.rs#L1138-L1230), [typed wake origin](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/app/src/ai/agent/base_user_query.rs#L132-L141), [client message dedupe](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/app/src/ai/blocklist/orchestration_events.rs#L430-L548), [local persistence migration](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/crates/persistence/migrations/2026-03-23-180000_remove_orchestration_persistence/up.sql#L1-L3), [TUI tree feature design](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/specs/code-1946-tui-multi-level-orchestration/TECH.md#L15-L78), and [CLI orchestration command](https://github.com/warpdotdev/warp/blob/0e5949c9297089c8fc1a2afc1e9bb31d3102f0a7/crates/warp_cli/src/agent.rs#L696-L759).

Test files located but **not inspected**: `orchestration_model_tests.rs`,
`orchestration_tab_bar_tests.rs`, `orchestration_block_tests.rs`,
`agent_message_tests.rs`, `orchestration_event_streamer_tests.rs`,
`orchestration_events_tests.rs`, and `controller/startup_queue_tests.rs`.

**HorizonCode:** reuse only the general pattern: explicit message origin, stable delivery
IDs, server/client receipt distinction, parent/child navigation, stale async result
discard, and explicit unsupported peer capabilities. `ARCH/32` already makes the Run
stream canonical and the Thread inbox a receipt-linked projection. Keep Task DAG separate
from the agent thread tree and keep UI rollups non-authoritative. Any remote exactly-once
or durable-mailbox guarantee requires its own server protocol and acceptance tests.

## oh-my-pi: shared agent loop, provider registry, and context recovery

The CLI lazily loads its interactive TUI with an `AgentSession`; session creation is
centralized through `createAgentSession`. Its reusable loop coordinates provider
requests, tool batches, steering, deadlines, stop conditions, malformed/truncated tool
call recovery, and bounded forced-tool retries. Parallel tool calls can settle in any
order while tool results are presented in original call order. A tool protocol error
cannot quietly turn into an unrelated detour while a required tool remains pending.

Provider metadata and auth policies are factored into registry/catalog modules, with a
type-level completeness check for chat-capable catalog providers without an auth
policy. This single-source registry plus validation is a useful pattern for provider
growth, not a reason to reuse its credentials or provider implementations.

Session history is a branched typed entry stream containing messages, compaction,
model changes, and usage. The storage comments promise append visibility after a
software crash but explicitly do not fsync, so the last page can be lost after power
loss. Resume adds an idempotent aborted assistant entry to a nonterminal interrupted
tail; this restores transcript structure but does not provide exactly-once recovery for
external effects. Compaction records strategy, retained-entry boundary, token counts,
and provider replay cursor; strategies include provider compaction, image-based
compression, handoff, summary, and local pruning. Subagent preflight bounds depth,
recursion, agent allowlist, model selection and isolation; optional isolated work
captures branch/patch artifacts and separates merge/apply from worker execution.
Tool approval is not OS sandbox proof.

Pinned evidence: [agent loop](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/agent/src/agent-loop.ts#L1279-L1345), [provider registry completeness](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/ai/src/registry/registry.ts#L11-L46), [session entry types](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/session/session-entries.ts#L35-L90), [storage durability contract](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/session/session-storage.ts#L25-L53), [resume tail repair](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/sdk.ts#L1834-L1847), [compaction checkpoint](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/session/session-maintenance.ts#L1040-L1080), [subagent preflight](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/task/structured-subagent.ts#L263-L385), [isolated artifact/merge path](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/task/structured-subagent.ts#L748-L825), and [tool approval policy](https://github.com/can1357/oh-my-pi/blob/6dad5de125c2a508983c0f3e7ef9e79205ab71df/packages/coding-agent/src/tools/approval.ts#L203-L279).

Test paths located but **not inspected**: `turn-persistence.test.ts`,
`turn-recovery-replay-unsafe.test.ts`, `session-manager-indexed-durability.test.ts`,
the mid-turn compaction dead-end/cancellation tests, `compaction-hooks.test.ts`,
`compaction-speculation.test.ts`, and two subagent runtime/auth fallback tests. No
dedicated test path was verified for Warp or oh-my-pi tool-result ordering or the full
approval policy; source inspection is not test coverage evidence.

## HorizonCode consequences and tests

These peers reinforce already-owned HorizonCode contracts rather than justify new
parallel owners: one provider registry/auth policy owner (`ARCH/11`), tool-call order
and bounded tool batches (`ARCH/10`), durable inbox receipt/cursor/replay (`ARCH/32`),
and controller-owned persistence/effect recovery (`ARCH/07`, `ARCH/25`). Make the
boundary explicit between a desktop message echo and a durable server receipt. Test
duplicate IDs across local echo/server replay, out-of-order parallel completion with
ordered model-visible results, no-fsync software-crash versus power-loss claims,
interrupted-tail repair without effect replay, compaction cancellation/fallback, stale
tree results, nested cancellation timeout, and worktree patch merge conflicts. Existing
`research docs/tests.md` covers most of these; this note adds exact peer patterns and
license/source provenance, not evidence of HorizonCode implementation.
