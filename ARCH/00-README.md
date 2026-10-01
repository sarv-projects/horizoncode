# HorizonCode architecture

`ARCH/` is the final target blueprint for HorizonCode. It specifies the product and system the implementation is intended to become. A design contract does not claim that its feature is already implemented, verified, or accepted; delivery status belongs in [`TODO.md`](../TODO.md), executable evidence in source and verification records, and session handoff in [`CURRENT_RUN.md`](../CURRENT_RUN.md).

## How to read this architecture

Start with the vision, requirements, system map, domain vocabulary, and module boundaries. Then follow the subsystem that owns the behavior. Shared identities, states, events, invariants, actions, flows, capabilities, and performance limits are defined once under `contracts/` and referenced elsewhere.

The architecture is edited in place. Historical snapshots and decision history are kept under `docs/history/architecture/`; external evidence and source links are kept under `docs/research/`; genuinely unresolved design choices are kept under `docs/design-proposals/`. Canonical documents state the effective target contract without requiring readers to apply a chain of corrections.

## Foundation

- [Vision](01-VISION.md)
- [Requirements](02-REQUIREMENTS.md)
- [System architecture](03-SYSTEM-ARCHITECTURE.md)
- [Domain model](04-DOMAIN-MODEL.md)
- [Modularity and boundaries](05-MODULARITY.md)

## Core runtime

- [Sessions and threads](core/SESSION-AND-THREADS.md)
- [Agent loop](core/AGENT-LOOP.md)
- [Context assembly](core/CONTEXT.md)
- [Tools and scheduling contracts](core/TOOLS.md)
- [Providers](core/PROVIDERS.md)
- [Configuration](core/CONFIG.md)
- [Compression and compaction](core/COMPRESSION.md)

## Execution

- [Orchestration](execution/ORCHESTRATION.md)
- [Long-horizon goals and runs](execution/LONG-HORIZON.md)
- [Workspaces](execution/WORKSPACES.md)
- [Workers and execution hosts](execution/WORKERS.md)
- [Scheduling](execution/SCHEDULING.md)
- [Budgets](execution/BUDGETS.md)
- [Effects](execution/EFFECTS.md)
- [Recovery](execution/RECOVERY.md)
- [Stopping and cancellation](execution/STOPPING.md)
- [Verification](execution/VERIFICATION.md)

## Security

- [Security model](security/SECURITY-MODEL.md)
- [Guard and authorization](security/GUARD.md)
- [Sandbox and confinement](security/SANDBOX.md)
- [Audit](security/AUDIT.md)

## Product

- [User interface](product/UI.md)
- [Interactions, composer, and fast path](product/INTERACTIONS.md)
- [Commands, agents, and settings](product/COMMANDS-AND-SETTINGS.md)
- [Artifacts](product/ARTIFACTS.md)
- [Memory](product/MEMORY.md)
- [Agent messaging](product/AGENT-MESSAGING.md)
- [Code intelligence](product/CODE-INTELLIGENCE.md)
- [Discovery and extensions](product/DISCOVERY-AND-EXTENSIONS.md)
- [Analytics](product/ANALYTICS.md)

## Integrations and distribution

- [Protocols](integrations/PROTOCOLS.md)
- [Control API](integrations/CONTROL-API.md)
- [External agents](integrations/EXTERNAL-AGENTS.md)
- [litePSM extension-manager adapter](integrations/LITEPSM.md)
- [Distribution and updates](integrations/DISTRIBUTION-AND-UPDATES.md)

## Shared contracts

- [Ownership registry](contracts/OWNERSHIP.md)
- [Invariant registry](contracts/INVARIANTS.md)
- [State machines](contracts/STATE-MACHINES.md)
- [Canonical flows](contracts/FLOWS.md)
- [Event envelope and durable log contracts](contracts/EVENTS.md)
- [Action descriptors](contracts/ACTIONS.md)
- [Capability contracts](contracts/CAPABILITIES.md)
- [Performance budgets](contracts/PERFORMANCE.md)

## Acceptance

- [Acceptance model](acceptance/ACCEPTANCE-MODEL.md)
- [Acceptance matrix](acceptance/ACCEPTANCE-MATRIX.md)

## Authority rules

1. Every statement in `ARCH/` describes the final target architecture.
2. No subsystem may redefine a shared durable identity, state vocabulary, invariant, flow, action, event envelope, capability record, or numerical performance budget owned by `contracts/`.
3. Every durable fact has one canonical component owner. Other components hold references or derived projections.
4. A model, worker, extension, or external client may propose work or submit evidence; only the owning controller commits canonical state.
5. A proposed design is not evidence of implementation. `TODO.md` and revision-bound acceptance evidence report delivery separately.
6. Keep all source URLs and pinned repository/file references in the research trail; link them from the owning design where they help explain a contract.
7. Update affected owner documents, shared contracts, requirements, and acceptance cases together when a change crosses boundaries.
8. Keep historical architecture outside `ARCH/`. Preserve original snapshots without edits and use Git history for ordinary revision history.
9. Keep unaccepted design alternatives in `docs/design-proposals/`; merge an accepted choice into the canonical owner in place.
10. Keep user-facing flows fast and understandable while retaining durable intent, visible blockers, exact review evidence, and responsive stop controls.

