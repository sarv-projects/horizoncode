# HorizonCode — OpenCode-first universal software-agent architecture
**Architecture revision:** v2 integrated into existing `arch_V1/` · **Design status:** approved target to implement; not an integrated released runtime.

## Start here
The existing local code is derived from pinned OpenCode `b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`. Existing `packages/` providers, Session runner, tools and UI should be reused. `kernel/` contains real Rust codecs/event-log primitives but not a complete supervisor or verification gate. Do not implement a parallel model-provider SDK or rewrite upstream Session management without a measured parity test.

**One authority per aggregate:** OpenCode is targeted to own canonical conversations and provider-native Session parts; Rust owns managed goals, task DAG, effects, scoped approvals, worktree leases, recovery and evidence. The Session migration is **not yet implemented**. Preserve existing Rust OwnerLog work and gated tests until cutover proves parity.

**User-pinned models:** free/local and cheap models first-class; no cost-aware automatic routing and no unexpected switch to a paid provider. Permission modes ask/safe-auto/yolo-in-sandbox; tool effects always brokered.

## Read order
1. [Governance and decisions](17-GOVERNANCE-DECISIONS.md) + [existing code audit](24-LOCAL-CODE-AUDIT-AND-MIGRATION.md).
2. [Upstream OpenCode reuse](19-OPENCODE-UPSTREAM-REUSE.md) + [exact integration LLD](20-OPENCODE-INTEGRATION-LLD.md).
3. [System topology](01-SYSTEM.md), [domain](02-DOMAIN.md), [schemas and APIs](25-DATA-AND-CONTROL-PLANE-CROSSWALK.md), [IPC](13-COMPOSITION-IPC.md).
4. [Runtime](15-RUNTIME-EXECUTION.md), [recovery and worktree pooling](21-HEALING-PERMISSIONS-WORKTREE-POOL.md), [lifecycle](11-LIFECYCLE.md).
5. [UI](16-UX-SETTINGS-ECOSYSTEM.md), [builder experience](22-UNIVERSAL-UI-COMMANDS-MEMORY.md), [acceptance journeys](26-UX-ACCEPTANCE-AND-RELEASE.md).
6. [Delivery](10-DELIVERY.md) and [v2 tests](23-ADOPTION-GATES-TESTS.md).

## Single-source-of-truth rule
The original 01–18 design contracts remain authoritative *within their topic* after the **2026-10-10 OpenCode-first reconciliation** blocks inserted in each document. Conflicts are resolved by documented A-V2 decisions in 17 and implementation-specific 19–26, not silently guessed. Mark any unremediated contradiction in the integration ledger before coding. The uploaded comprehensive v2 source is preserved under `../docs/architecture-input/` for provenance only; it is NOT a competing architecture.

## Document index
| File | Responsibility |
|---|---|
| [01-SYSTEM.md](01-SYSTEM.md) | System topology and OpenCode/Rust process ownership |
| [02-DOMAIN.md](02-DOMAIN.md) | Canonical aggregates and stable identity model |
| [03-FLOWS.md](03-FLOWS.md) | Interactive, managed, visual, recovery flows |
| [04-STATE-EVENTS.md](04-STATE-EVENTS.md) | State/event/outbox/reconciliation semantics |
| [05-SECURITY.md](05-SECURITY.md) | Policy, isolation, threat boundaries |
| [06-CAPABILITIES.md](06-CAPABILITIES.md) | Upstream parity and implementation states |
| [07-UX-COMMANDS.md](07-UX-COMMANDS.md) | UI surfaces, action registry, slash commands |
| [08-RECONCILIATION.md](08-RECONCILIATION.md) | Historical versus adopted design decisions |
| [09-SOURCE-MAP.md](09-SOURCE-MAP.md) | Pinned repository path map and source audit |
| [10-DELIVERY.md](10-DELIVERY.md) | Phased delivery with acceptance gates |
| [11-LIFECYCLE.md](11-LIFECYCLE.md) | State machines, transition guards, terminal criteria |
| [12-DOMAIN-SCHEMAS.md](12-DOMAIN-SCHEMAS.md) | Domain/wire/versioned schema definitions |
| [13-COMPOSITION-IPC.md](13-COMPOSITION-IPC.md) | Service composition and private kernel transport |
| [14-EFFECTS-EXECUTION-SECURITY.md](14-EFFECTS-EXECUTION-SECURITY.md) | Effect authorization and sandbox/execution host |
| [15-RUNTIME-EXECUTION.md](15-RUNTIME-EXECUTION.md) | Context, provider turn, managed work and recovery |
| [16-UX-SETTINGS-ECOSYSTEM.md](16-UX-SETTINGS-ECOSYSTEM.md) | Settings, provider profiles, plugin UI and UX |
| [17-GOVERNANCE-DECISIONS.md](17-GOVERNANCE-DECISIONS.md) | Adopted ADRs, unresolved gates, normative priority |
| [18-OPERATIONS-RELEASE.md](18-OPERATIONS-RELEASE.md) | Storage, telemetry, packaging and release |
| [19-OPENCODE-UPSTREAM-REUSE.md](19-OPENCODE-UPSTREAM-REUSE.md) | v2 upstream ownership, reuse, licensing and extension seams |
| [20-OPENCODE-INTEGRATION-LLD.md](20-OPENCODE-INTEGRATION-LLD.md) | v2 integration packages/classes/functions and bridge |
| [21-HEALING-PERMISSIONS-WORKTREE-POOL.md](21-HEALING-PERMISSIONS-WORKTREE-POOL.md) | v2 recovery tiers, broker rules, worktree pool |
| [22-UNIVERSAL-UI-COMMANDS-MEMORY.md](22-UNIVERSAL-UI-COMMANDS-MEMORY.md) | v2 universal software-building UX, models, harnesses |
| [23-ADOPTION-GATES-TESTS.md](23-ADOPTION-GATES-TESTS.md) | v2 implementation stages, source-specific test gates |
| [24-LOCAL-CODE-AUDIT-AND-MIGRATION.md](24-LOCAL-CODE-AUDIT-AND-MIGRATION.md) | audited paths, existing implementation, exact change targets |
| [25-DATA-AND-CONTROL-PLANE-CROSSWALK.md](25-DATA-AND-CONTROL-PLANE-CROSSWALK.md) | v2 schemas, event ownership, control API and replay |
| [26-UX-ACCEPTANCE-AND-RELEASE.md](26-UX-ACCEPTANCE-AND-RELEASE.md) | reference UI, command list, end-to-end user acceptance |
| [27-IMPLEMENTATION-READINESS-AUDIT.md](27-IMPLEMENTATION-READINESS-AUDIT.md) | Coverage audit, contradicting decisions, implementation status and handoff truth |

## Machine-readable additions
- [Managed-work additive SQLite schema](contracts-v2/managed-work-additive.sql) — prototype migration, **not applied**.
- [Managed event envelope](contracts-v2/managed-event.schema.json) — example envelope slice; full event vocabulary remains in chapter 04.
- [Control-plane OpenAPI](contracts-v2/control-api.openapi.json) — additive run/goal route skeletons; does not replace OpenCode HTTP Session API.
- [Upstream source inventory](opencode-b1fe25ab-path-inventory.jsonl) — pinned historical source path counts, not code review.

## Completion standard
Source code copied, documentation authored, unit tests passing, or task-worker claims are not sufficient for feature acceptance. Every shipped feature needs explicit provenance, contract tests, isolated effects, final integrated-revision evidence, crash/replay checks where relevant, and a named UI acceptance path. Remaining prerequisites are recorded in [delivery gates](23-ADOPTION-GATES-TESTS.md) and [existing code audit](24-LOCAL-CODE-AUDIT-AND-MIGRATION.md).

## What this architecture update did not do
No production runtime rewrites, provider/session replacement, package deletion, git reset, auto-routing switch, worktree pruning or released user-visible feature implementation. Preserve the existing kernel/source and implement in bounded verified slices.

## Agent implementation handoff (2026-10-10)

Read [27-IMPLEMENTATION-READINESS-AUDIT.md](27-IMPLEMENTATION-READINESS-AUDIT.md) before changing a system boundary. The tracked repo-root `AGENTS.md`, `HANDOFF.md` and `IMPLEMENTER_PROMPT.md` define agent execution procedures and actual next gate. These govern **how to execute** this architecture; they do not override the normative contracts of 01–26. The latest working Rust event follower is implemented only as P1.2-A; authenticated supervisor P1.2-B and ToolIntent broker remain unverified.
