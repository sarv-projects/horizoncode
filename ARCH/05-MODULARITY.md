# Modularity, Ports, Adapters, and Boundary Integrity

## Laws

1. One control plane: `CMP-orch` commits Run/Task/Attempt state; provider, worker,
   protocol, and model responses are proposals or receipts.
2. Capability parity is an evaluated product requirement, not a reason to add vendor
   types to core or to weaken trust boundaries (`ARCH/contracts/CAPABILITIES.md`).
3. Vendor nouns and schemas stay in adapters. Core contracts use HorizonCode-owned
   `WorkerAdapter`, `ModelProvider`, `WorkspaceProvider`, and `ExecutionHostProvider`
   ports.
4. Durable canonical state lives in owner stores/logs. Prompt context and UI views are
   bounded, revision-pinned projections, never alternate truth.
5. Completion belongs to HorizonCode: worker exit/done is a candidate outcome; only
   independent, current, integrated-revision verification may produce Task PASS.
6. Module dependencies form an acyclic graph that points inward. Interfaces must not
   create duplicate state, policy, scheduling, or verification authorities.

## Ports and ownership

Shared durable concepts use [Domain model](04-DOMAIN-MODEL.md) and [Ownership](contracts/OWNERSHIP.md). CMP-agent-directory owns profile registration/trust; CMP-worker negotiates/renders/routes adapters; CMP-orch alone schedules and commits execution lifecycle. ExecutionHost performs launch/reap, Sandbox enforces reach, WorkspaceProvider owns source-state operations. Host placement and workspace implementation cannot prove OS confinement. Vendor-specific fields remain adapter metadata.

## Language boundary

HorizonCode is Rust-first, not Rust-exclusive (`REQ-MOD-001`). Runner, controller,
schedulers, Guard, Sandbox, effect settlement, canonical state, workspace operations,
native tools, repository-index runtime and TUI are Rust-owned implementations.
Language choice cannot move their authority into an adapter.

| Edge | Permitted language and boundary |
|---|---|
| Evaluation and statistics | The `hz-eval` CLI is a Rust surface over isolated fixtures and versioned evaluation records. Python may support offline statistics through versioned files; it cannot bypass production authority. |
| Web/browser surfaces and SDKs | TypeScript may implement clients of the Control API and typed SDKs. Business state and policy remain in their canonical owners. |
| Installation/bootstrap | Bash and PowerShell are thin launchers for the authenticated installation service; they do not implement alternative update or signature policy. |
| Extensions | WASM modules use the mediated extension port and declared capabilities. They receive no ambient host authority. |

Cross-language boundaries use finite, versioned IPC/API or WASM contracts with typed
failure, cancellation and resource bounds. Arbitrary FFI chains and a second agent
runtime are excluded. An additional runtime language or native grammar dependency
requires an explicit boundary decision, pinned supply chain, support matrix and
failure/conformance evidence before adoption. Rust bindings to pinned Tree-sitter
grammars are a parsing adapter boundary, not an exemption for unrestricted native code.

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

The checked-in [workspace architecture checker](../scripts/check_architecture_deps.py)
consumes `cargo metadata --no-deps` and validates
normal workspace path dependencies against the inward layers in this document. It
ignores `dev-dependencies` when evaluating the shipped graph, detects cycles, rejects
edges from an inner layer to an outer layer, rejects unclassified workspace crates,
and reports the source `Cargo.toml` plus the offending dependency edge. A small
explicit denylist rejects known UI frameworks, concrete Git/container workspace
engines, and provider SDKs from core crates; new adapter libraries must be placed at
an adapter boundary or added to the reviewed policy. Committed violating fixtures
prove outward-edge, forbidden-package, and cycle failures. `cargo-deny` may cover
licenses/dependencies but is not by itself an architecture-boundary checker.

The static workspace gate is separate from adapter contract suites. Those suites
exercise port dispatch, authorization identity, workspace fences, typed failure
receipts, owner semantics, and recovery. A sourced capability view is a derived
projection of owner records; it cannot create availability evidence or authority.
Adapter contracts and the capability-view owner/query remain a separately tracked
design and implementation item (AX-412). Static rules and passing mocks do not prove
OS isolation or runtime behavior; acceptance must include executable cross-adapter
tests and platform-specific confinement evidence
(`ARCH/security/SECURITY-MODEL.md`, `ARCH/acceptance/ACCEPTANCE-MATRIX.md`).

## Acceptance

Boundary fixtures reject duplicate registries/indexes, mandatory Git fields in core, direct surface access to owner databases and vendor/framework imports through inward ports. Substitute adapters and validate lifecycle, scope, receipt and recovery parity. Markdown skills and WASM plugins are distinct. LitePsmAdapter stays at the edge; its ExtensionManager port points inward and adds no scheduler or policy authority.
