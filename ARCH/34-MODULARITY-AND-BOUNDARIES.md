# 34 — Modularity, Ports, Adapters, and Boundary Integrity

**Status:** proposed architecture contract. This document does not describe the
current crate graph or claim an architecture lint is implemented.

## Laws

1. One control plane: `CMP-orch` commits Run/Task/Attempt state; provider, worker,
   protocol, and model responses are proposals or receipts.
2. Capability parity is an evaluated product requirement, not a reason to add vendor
   types to core or to weaken trust boundaries (`ARCH/35`).
3. Vendor nouns and schemas stay in adapters. Core contracts use HorizonCode-owned
   `WorkerAdapter`, `ModelProvider`, `WorkspaceProvider`, and `ExecutionHostProvider`
   ports.
4. Durable canonical state lives in owner stores/logs. Prompt context and UI views are
   bounded, revision-pinned projections, never alternate truth.
5. Completion belongs to HorizonCode: worker exit/done is a candidate outcome; only
   independent, current, integrated-revision verification may produce Task PASS.
6. Module dependencies form an acyclic graph that points inward. Interfaces must not
   create duplicate state, policy, scheduling, or verification authorities.

## Vocabulary and ownership

| Term | Meaning | Owner |
|---|---|---|
| Worker | Registered role/profile plus declared capabilities and adapter choice | `CMP-agent-directory` definition; `CMP-worker` execution adapter |
| Runner | Bounded native HorizonCode model/tool loop | `CMP-runner` |
| WorkerExecution | One process/runtime incarnation for an admitted Attempt | `CMP-orch` identity; `CMP-execution-host` lifecycle |
| ExecutionHost | Host/process/container/remote endpoint that creates and observes processes | `CMP-execution-host` |
| Workspace | Mutable source state, its base, dirty state, and revision/fence identity | `CMP-workspace` |
| Sandbox | Enforced reach policy on an execution host | `CMP-sandbox` |
| Evidence | Immutable, provenance-bearing observation bound to a subject revision | `CMP-verifier` / `CMP-artifact` |

Workspace identity is not synonymous with a Git worktree. `WorkspaceProvider` owns
`create`, `snapshot`, `diff`, `changed_paths`, `integrate`, `restore`, and `dispose`.
The existing Git worktree/lease behavior is the first adapter and retains its fencing
and merge rules. A future container or remote adapter must state its revision model,
isolation tier, durability, and residual risks before orchestration may use it.

The execution host creates/reaps processes and reports observed lifecycle. Sandbox
policy decides and enforces reachable resources where the platform supports it.
Neither process placement nor a workspace implementation proves OS confinement.

## Dependency direction

```text
Surfaces and protocol adapters
            ↓
Application/control services and ports
            ↓
Domain contracts and state owners
            ↓
Foundation types and schemas
```

Provider SDKs, concrete Git/container clients, TUI frameworks, OS-specific APIs, and
foreign protocol types terminate at adapter boundaries. `CMP-tui` calls
`CMP-control-api`; it does not import audit/database/scheduler internals. A surface
may render an owner projection but cannot author canonical owner events directly.

The future crate layout is a bounded cluster map, not a mandate for one crate per
trait: foundation, control, runtime, intelligence, security, state, and platform.
Keep the current single Cargo workspace and split crates only where independently
owned interfaces or compilation boundaries justify the cost.

## Boundary checks and evidence

The proposed release gate checks a dependency DAG, denies forbidden imports of vendor
SDKs/concrete workspace engines/UI frameworks in core, and requires adapter contract
fixtures for dispatch, authorization identity, workspace fences, failure receipts, and
recovery. It reports exact offending path and dependency edge. `cargo-deny` may cover
licenses/dependencies but is not by itself an architecture-boundary checker. Static
rules and passing mocks do not prove OS isolation or runtime behavior; acceptance must
include executable cross-adapter tests and platform-specific confinement evidence
(`ARCH/22`, `ARCH/23`).

## Related requirements and decisions

`REQ-WORK-001/002`, `REQ-ORCH-012`, `DEC-083/084/089`, `ARCH/03`, `ARCH/13`,
`ARCH/16`, and `ARCH/25` define the related contracts. Implementation remains
proposed until tracked TODO rows have source inspection and their named acceptance
records.

## Final port ownership and status refinement

CMP-agent-directory owns profile registration/trust. CMP-worker consumes profiles and
implements adapter routing/config rendering; CMP-orch alone schedules and commits
execution state. ExecutionHost reports process observations, not canonical lifecycle
transitions. Shared schema/route value types break context/provider cycles. UI only
imports the control contracts and renderer-local state. Seven named functional clusters
are a planning map, not six and not a mandatory crate-per-port rewrite. Boundary
fixtures must also reject duplicate registries/indexes, concrete Git requirements in
core types, and direct surface access to owner databases.

## Interaction and integration reconciliation (2026-09-30)

ARCH38 extension manager port lives inward; LitePsmAdapter lives at the edge. ARCH37 adds no state owner or vendor imports. UI depends on ControlService and projections; rendering worker contracts do not expose store paths.

Detailed shared contracts: [ARCH/37](37-INTERACTION-AND-FAST-PATH.md) and [ARCH/38](38-LITEPSM-INTEGRATION.md). Status remains proposed; see TODO AX-401..410.
