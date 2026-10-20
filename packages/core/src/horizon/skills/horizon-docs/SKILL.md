---
name: horizon-docs
description: Retrieve the installed HorizonCode architecture, contracts, implementation status, and acceptance requirements without loading the full corpus.
---

# Horizon Docs

This is the canonical HorizonCode product skill for architecture/status retrieval.
The .opencode/skills/horizon-docs/SKILL.md file is only a discovery compatibility shim.

## Authority

Read the smallest relevant set.

1. arch_V1/README.md — active topic-owner index and authority order.
2. arch_V1/17-GOVERNANCE-DECISIONS.md — ownership/product decisions and open gates.
3. One topic-owning normative document for the current question.
4. arch_V1/20-OPENCODE-INTEGRATION-LLD.md for current local source placement when implementation is involved.
5. arch_V1/37-RUNTIME-SERVICE-LLD.md for runtime-service contracts.
6. arch_V1/33-BUILTIN-CAPABILITIES-CATALOG.md for canonical capability IDs.
7. arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md for acceptance.
8. HANDOFF.md plus exact local source/tests for current implementation truth.
9. arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md only when external source extraction is needed.

Do not load compatibility stubs, docs/architecture-archive, old plans/specs or CURRENT_RUN history as product authority.

Core ownership:
- OpenCode Core owns canonical Session/Input/Message/Part/provider continuation.
- Rust owns managed Goal/SpecVersion/Run/Task/Attempt, ToolBatch control, effects/leases/receipts, verification/evidence.
- UI/index/analytics/research are not state authorities.
- direct coding does not require a Goal.
- every mutation uses the same Guard/ExecutionHost.

## Retrieval workflow

For a requested subsystem:
1. identify its single owner from arch_V1/README.md;
2. read only that owner section plus §17 invariants;
3. read §20/§37/§33/§32 only if needed;
4. inspect exact source/tests before saying CODE_PRESENT/WIRED/TESTED/VERIFIED;
5. use §42 only for exact immutable upstream evidence.

Return:
- decision/invariant;
- owner;
- exact interface/capability IDs;
- implementation status from source/tests/HANDOFF;
- acceptance test;
- unresolved gate.

## Current implementation and recovery sources

- Use `implementationtov1release.md` for the main-agent-maintained V1 scope/status map, `HANDOFF.md` for observed implementation evidence, and `docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md` for dependency order. These are not architecture authorities; resolve design questions from the normative topic owner.
- At a fresh session or after context compaction, follow the exact bootstrap order in root `AGENTS.md`, then reload Engram context and search the active phase/blocker. A summary or dated `CURRENT_RUN.md` entry is a lead, not proof: re-check current source, tests, and owner evidence before relying on a status claim.
- For architecture/catalog/schema documentation changes, preserve one canonical owner and validate both `python3 scripts/architecture/audit_markdown_repo.py` and `python3 scripts/architecture/validate_convergence.py`. The capability registry is a design/alias seed, not a second runtime authority; catalog/schema/test rows do not establish runtime support.

## Status vocabulary

DESIGNED -> CODE_PRESENT -> WIRED -> TESTED -> VERIFIED -> RELEASED.

Never infer a later state from Markdown, JSON Schema, catalog membership, mocks or competitor source.

## Common lookups

- System/domain/flows/events/security: §§01–05.
- Delivery: §10.
- Lifecycle/schemas/IPC/effects/runtime: §§11–15.
- UI/settings/provider/model UX: §16.
- Governance/open gates: §17.
- Operations/release: §18.
- OpenCode/local implementation placement: §20.
- Healing/permissions/worktrees: §21.
- Agents/subagents/skills/hooks/MCP: §29.
- Context/index/LSP/local models: §30.
- Streaming/artifacts/analytics/automations: §31.
- Acceptance/regression/UAT: §32.
- Canonical capabilities: §33.
- Runtime services including browser/desktop/web search/DAP/REPL: §37.
- External immutable source/provenance: §42.
- Current implementation checkpoint: HANDOFF.md.
- Operative checklist: docs/superpowers/plans/2026-10-11-horizoncode-converged-implementation.md.

## Token discipline

Never inject the entire architecture into a task prompt.
For implementation, usually 3–5 relevant documents plus exact source/tests are enough.

## Resource/RAM/JCode implementation lookup (A-V2-30)

For the resource-efficiency implementation request, read §01.13 HLD, §11.20 state, §12.16 schema, §13.12 IPC, §15.20 call graph, §18.17–19 RAM/OS, §20.12 exact hydrated source paths, §21.11 leases/worktrees, §29.18 DAG, §30.21 cache/recall, §31.17 TUI, §37.16–18 proposed APIs and §32.33–34 tests. The one executable checklist is root current plan RC0–RC5; HANDOFF determines what is *actually implemented*. Do not load the retained upstream Markdown/architecture archive as current authority.
