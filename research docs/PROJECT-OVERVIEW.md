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

Honest labelling, per `ARCH/acceptance/ACCEPTANCE-MATRIX.md`: this is **implemented and test-covered, not accepted.**
No `ACC-P1-*` acceptance record exists, so no containment, audit, or readiness claim is
verified. See `TODO.md` for per-task status
and the open-defect list.

## Documentation map

| Document | What it covers |
|---|---|
| `ARCH/00-README.md` | Authority, conventions, and how to read this set |
| `ARCH/01-VISION.md` | Product definition, differentiators, non-goals |
| `ARCH/02-REQUIREMENTS.md` | Testable requirements (`REQ-*`) |
| `ARCH/03-SYSTEM-ARCHITECTURE.md` | High-level architecture and boundaries |
| `docs/history/architecture/decisions/DECISIONS-THROUGH-095.md` | Architecture decisions (`DEC-*`) |
| `docs/research/SOURCE-LEDGER.md` | What we build, vendor, or only draw patterns from |
| `ARCH/product/UI.md` | TUI, dockable workspace, and the worktree cockpit |
| `ARCH/core/SESSION-AND-THREADS.md` | Sessions: durable event log, replay, checkpoint |
| `ARCH/core/AGENT-LOOP.md` | The agent loop and turn lifecycle |
| `ARCH/core/CONTEXT.md` | Context assembly, repo map, compaction |
| `ARCH/core/TOOLS.md` | Tool contract, registry, execution |
| `ARCH/core/PROVIDERS.md` | Provider transports, catalog, routing |
| `ARCH/security/GUARD.md` | Policy guard and approvals |
| `ARCH/security/SANDBOX.md` | Execution confinement tiers |
| `ARCH/security/AUDIT.md` | Tamper-evident execution log |
| `ARCH/integrations/PROTOCOLS.md` | ACP (server + client), MCP, headless |
| `ARCH/execution/ORCHESTRATION.md` | Sub-agents, task graph, merge |
| `ARCH/core/CONFIG.md` | Configuration, instructions, memory |
| `ARCH/core/COMPRESSION.md` | Context compression (evidence-gated) |
| `ARCH/product/ANALYTICS.md` | Usage, cost, tool, and routing analytics |
| `ARCH/product/DISCOVERY-AND-EXTENSIONS.md` | MCP/skills/plugins/agents discovery & use |
| `ARCH/security/SECURITY-MODEL.md` | Consolidated threat model, residual-risk register |
| `ARCH/acceptance/ACCEPTANCE-MATRIX.md` | Evidence layers, acceptance matrix, release gates |
| `docs/history/architecture/audits/2026-09-30-review.md` | Dated findings and migration order |
| `ARCH/execution/LONG-HORIZON.md` | Proposed durable run, task, evidence and recovery contracts |
| `docs/research/CORE-AGENT-CROSSWALK.md` | Claude Code, Codex, OpenCode, Cline and Aider pattern disposition |
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
