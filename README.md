# HorizonCode

A standalone, ACP-native, **long-horizon** command-line coding agent.

- **Rust core, terminal-first.** Host tools and optional integrations are probed
  per capability; detached operation may use a supervised controller process.
- **Protocol-native.** Speaks the Agent Client Protocol (ACP) on stdio as a first-class server; speaks Model Context Protocol (MCP) as a host.
- **Long-horizon by design.** Durable sessions, checkpoints, verified audit, eval-gated context — built for work that runs for hours, not one prompt.
- **Own the moat, vendor the leaves.** The agent loop, guard, audit, context engine, routing, and orchestration are first-party. Everything solved and permissive is a dependency.

## Status

**Architecture under review; P0 slice implemented, P1 in progress.** The design set lives in
`ARCH/`. The Rust workspace at `crates/` implements the P0 vertical slice (session log,
one provider transport, the read-only and mutating tool plane, the step loop, the ACP
stdio server, and the headless `-p` mode) plus the first half of P1 (the policy guard
and the local sandbox backends). Audit and analytics crates are present.

Honest labelling, per `ARCH/23`: this is **implemented and test-covered, not accepted.**
No `ACC-P1-*` acceptance record exists, so no containment, audit, or readiness claim is
verified. See `TODO.md` for per-task status
and the open-defect list.

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
| `ARCH/22-SECURITY.md` | Consolidated threat model, residual-risk register |
| `ARCH/23-VERIFICATION.md` | Evidence layers, acceptance matrix, release gates |
| `ARCH/24-ARCHITECTURE-REVIEW.md` | Dated findings and migration order |
| `ARCH/25-LONG-HORIZON-CONTROL.md` | Proposed durable run, task, evidence and recovery contracts |
| `ARCH/26-CORE-AGENT-CROSSWALK.md` | Claude Code, Codex, OpenCode, Cline and Aider pattern disposition |
| `TODO.md` | Delivery tracker: status, evidence, open defects |
| `CURRENT_RUN.md` | Handover state for the next session |

`archives/` holds reference material copied from an unrelated project. It is **not** an authority for this repository and is git-ignored.

## Non-negotiables

1. The differentiating layers are first-party code.
2. No copyleft, source-available, or unlicensed code enters the tree.
3. Protocols are seams, never a second engine.
4. Readiness is evidence-gated; no capability is "done" without executable proof.
5. Product comparisons require evidence. Factual source, provider and model names
   remain visible for configuration, provenance and required attribution.

## Rename from agentX

The product, binary, Rust crates, environment variables and default state directory
are now `horizoncode`, `horizoncode-*`, `HORIZONCODE_*` and
`~/.horizoncode`. Existing local data under `~/.agentx` is **not**
automatically migrated; set `HORIZONCODE_HOME` to an existing state directory
when intentionally continuing an earlier run. The local checkout directory may
retain its old name without affecting the binary or remote repository.
