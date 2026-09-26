# agentX

A standalone, ACP-native, **long-horizon** command-line coding agent.

- **One binary.** Rust monolith, single static executable, terminal-first.
- **Protocol-native.** Speaks the Agent Client Protocol (ACP) on stdio as a first-class server; speaks Model Context Protocol (MCP) as a host.
- **Long-horizon by design.** Durable sessions, checkpoints, verified audit, eval-gated context — built for work that runs for hours, not one prompt.
- **Own the moat, vendor the leaves.** The agent loop, guard, audit, context engine, routing, and orchestration are first-party. Everything solved and permissive is a dependency.

## Status

**Architecture phase.** No implementation code yet. The design set lives in `ARCH/`.

## Documentation map

| Document | What it covers |
|---|---|
| `ARCH/00-INDEX.md` | Authority, conventions, and how to read this set |
| `ARCH/01-VISION.md` | Product definition, differentiators, non-goals |
| `ARCH/02-REQUIREMENTS.md` | Testable requirements (`REQ-*`) |
| `ARCH/03-ARCHITECTURE.md` | High-level architecture and boundaries |
| `ARCH/04-DECISIONS.md` | Architecture decisions (`DEC-*`) |
| `ARCH/05-SOURCE-LEDGER.md` | What we build, vendor, or only draw patterns from |
| `ARCH/06-UI.md` | TUI, dockable workspace, and the worktree cockpit |
| `ARCH/07-SESSION.md` | Sessions: durable event log, replay, checkpoint |
| `ARCH/08-LOOP.md` | The agent loop and turn lifecycle |
| `ARCH/09-CONTEXT.md` | Context assembly, repo map, compaction |
| `ARCH/10-TOOLS.md` | Tool contract, registry, execution |
| `ARCH/11-PROVIDER.md` | Provider transports, catalog, routing |
| `ARCH/12-GUARD.md` | Policy guard and approvals |
| `ARCH/13-SANDBOX.md` | Execution confinement tiers |
| `ARCH/14-AUDIT.md` | Tamper-evident execution log |
| `ARCH/15-PROTOCOLS.md` | ACP (server + client), MCP, headless |
| `ARCH/16-ORCH.md` | Sub-agents, task graph, merge |
| `ARCH/18-CONFIG.md` | Configuration, instructions, memory |
| `ARCH/19-COMPRESSION.md` | Context compression (evidence-gated) |
| `ARCH/20-ANALYTICS.md` | Usage, cost, tool, and routing analytics |
| `ARCH/21-DISCOVERY.md` | MCP/skills/plugins/agents discovery & use |
| `TODO.md` | Delivery tracker |

`archives/` holds reference material copied from an unrelated project. It is **not** an authority for this repository and is git-ignored.

## Non-negotiables

1. The differentiating layers are first-party code.
2. No copyleft, source-available, or unlicensed code enters the tree.
3. Protocols are seams, never a second engine.
4. Readiness is evidence-gated; no capability is "done" without executable proof.
5. No vendor or competitor brand names in source, commits, help text, or docs.
