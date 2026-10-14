# HorizonCode V1 architecture — implementation authority

Status: normative V1 architecture. Historical/research material is preserved outside the active authority chain.

## Authority order

For implementation, resolve questions in this order:

1. 17-GOVERNANCE-DECISIONS.md — frozen product/ownership decisions and open capability gates.
2. The single topic owner named below.
3. 20-OPENCODE-INTEGRATION-LLD.md and 37-RUNTIME-SERVICE-LLD.md for exact implementation/service seams.
4. 42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md only when external source extraction is required.
5. HANDOFF.md and the current implementation plan for observed code status and the next gate.

A research report, audit snapshot, archived plan, source repository, test result, or compatibility stub never overrides a normative topic owner.

## Core ownership law

- HorizonCode direct Core (derived from the pinned OpenCode base) owns direct conversational Session/Input/Message/Part/continuation and conversational tool-call/result parts; an optional native adapter owns only its separate upstream OpenCode sessions.
- Rust kernel owns Horizon managed Goal/SpecVersion/Run/Task/Attempt, ToolBatch authorization/control facts, EffectIntent/lease/receipt, Evidence/Verification, resource leases, and durable automation control.
- UI, plugins, agents, MCPs, LSP/DAP, browser/desktop backends, and external workers are never independent authorities.
- Ordinary direct coding does not require a Goal or managed Run.
- Every mutation crosses the same Guard and authorized ExecutionHost path.
- No hidden model/provider/harness or paid-service fallback is permitted.

## Active normative topic owners

| Topic | Owner |
|---|---|
| Process/topology and aggregate ownership | 01-SYSTEM.md |
| Domain identity and managed records | 02-DOMAIN.md |
| End-to-end flows | 03-FLOWS.md |
| Durable/ephemeral events and recovery | 04-STATE-EVENTS.md |
| Threat model and security policy | 05-SECURITY.md |
| Delivery dependency order | 10-DELIVERY.md |
| Current state machines and terminal criteria | 11-LIFECYCLE.md |
| Canonical schema registry and ownership | 12-DOMAIN-SCHEMAS.md |
| Process composition and IPC | 13-COMPOSITION-IPC.md |
| Guard, EffectService, ExecutionHost, sandboxing | 14-EFFECTS-EXECUTION-SECURITY.md |
| Direct/managed runtime, context, providers, recovery | 15-RUNTIME-EXECUTION.md |
| UI, ActionDescriptor, settings, provider/model UX | 16-UX-SETTINGS-ECOSYSTEM.md |
| Decisions and unresolved capability gates | 17-GOVERNANCE-DECISIONS.md |
| Storage, telemetry, packaging, release | 18-OPERATIONS-RELEASE.md |
| Existing OpenCode/local source integration map | 20-OPENCODE-INTEGRATION-LLD.md |
| Healing, permissions, bounded worktree pool | 21-HEALING-PERMISSIONS-WORKTREE-POOL.md |
| Agents, subagents, skills, hooks, MCP | 29-AGENTS-SKILLS-HOOKS-MCP.md |
| Context, indexing, LSP and local/small models | 30-CONTEXT-INDEXING-LOCAL-MODELS.md |
| Streaming UI, artifacts, analytics, automations | 31-UI-PERFORMANCE-ARTIFACTS-ANALYTICS.md |
| Real-work, security and regression acceptance | 32-TASK-BASED-AGENT-TEST-CATALOG.md |
| Canonical public capability IDs | 33-BUILTIN-CAPABILITIES-CATALOG.md |
| Runtime service interfaces including browser, desktop, web search, DAP and REPL | 37-RUNTIME-SERVICE-LLD.md |
| External source pins/provenance | 42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md |
| Terms | GLOSSARY.md |

## Compatibility/non-normative documents

Other numbered Markdown files in arch_V1 are compatibility stubs or retained navigation. Their original pre-consolidation bodies are preserved under docs/architecture-archive/2026-10-11-pre-lean-consolidation/. Do not load archived material during normal implementation.

Research material for OMP and other competitors is evidence only. Accepted behavior has been distilled into 16, 31, 33, 37 and the test catalog.

## Implementation reading rule

Do not read every architecture file for every task.

Start with 17 and this index once. For a work unit, read only:
- the owning topic document;
- 20 or 37 if an implementation/service seam is involved;
- 33 for a capability ID;
- 32 for acceptance;
- the exact local source and tests;
- 42 only if external extraction is needed.

This is the intended low-context implementation path.

## Machine contracts

contracts-v2 contains design/runtime boundary schemas. A schema is not proof a service is wired. Shared fixtures must validate generated TypeScript and Rust representations before release.

The canonical capability names live in 33. capability-registry-v1.json is a design/alias seed and must never create a second registry.

## Current implementation status

Architecture does not freeze implementation status. Read root HANDOFF.md and inspect the working tree/tests. CURRENT_RUN.md is an activity/evidence diary, not an architecture or runtime-status authority.

## Change rule

A material architecture change requires:
1. a decision update in 17;
2. the single topic owner update;
3. affected schemas/capability IDs/service LLD;
4. 32 acceptance cases;
5. delivery dependency update when ordering changes.

Never solve a conflict by adding another authority document.

## Resource-efficiency and JCode source navigation

Decision: **17.10 A-V2-30**. HLD is §01.13, state machines §11.20, generated machine contract requirements §12.16, exact IPC §13.12, effect security §14, runtime call graph §15.20, resource/OS/release §18.17–19, hydrated source map §20.12, worker/worktree/conflict §21.11, subagent DAG §29.18, context/cache §30.21, UI scheduler §31.17, detailed test/source gates §32.33–34, capability IDs §33.29, proposed service interfaces §37.16–18, exact JCode provenance and all 24 source-candidates §42.9–10.

The executable checklist is the existing `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` RC0–RC5 sections. For resource reservation and budget implementations, §11.20 is the state/transition authority, §18.18 owns exact accounting, §12.16 owns generated schema constraints, §37.16–17 provide proposed adapter interfaces, and §32.37 supplies conflicting-state, stale-owner and release/impersonation negative fixtures. `docs/performance/README.md` is a **measurement runbook only**, not an additional owner. `HANDOFF.md` records current verified status; root `CURRENT_RUN.md` is an append-only work/evidence diary, never another source of architecture or runtime truth. A line in the catalog or an unchecked task cannot be represented as an implemented feature.

## ACP, visual editing and deployment gap reconciliation

Existing §§3.16–3.18 and §29 agent adapters imply explicit external-agent, source-selection and deployment boundaries. The source/owner map is §20.13, safety §14.18, AgentProfile and adapter rules §29.19, design-only catalog IDs §33.30, service contracts §37.19–20 and release/negative tests §32.35. This adds no second provider, capability registry, Session writer or effect path. Upstream ACP **server** support is not evidence of an outbound Horizon ACP **client**.

Some numbered heading gaps (e.g. §14.11–14.14, §20.9 and §32.30) are unallocated after earlier consolidation. Do not infer that a missing numbered heading is a missing product requirement; verify against the active owner and test catalog, and preserve existing cross-references when renumbering. Current accepted flows are normative regardless of these historical gaps.
