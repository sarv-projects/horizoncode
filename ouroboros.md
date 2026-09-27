# Ouroboros: specification-first agent orchestration

> INTERNAL RESEARCH — reviewed 2026-09-27. Snapshot: main, commit `7c412aeea8cd63354723873c4567c831a84acdf2`. Focused audit of specification/seed, execution phases, event storage and adapter boundary. Treat the project architecture as a proposed/implemented-by-project description, not external validation.

## HLD

Ouroboros is a requirements-first orchestration system. It interviews for intent, freezes a structured “Seed” describing objective and constraints, expands acceptance criteria into a tree, routes through a staged design/execution/evaluation process, and records work in an event-backed store. Runtime adapters allow work to be delegated to external CLIs and ACP-capable agents.

## LLD and principal records

| Concept | Meaning |
|---|---|
| Seed | Frozen task baseline: goal, constraints, acceptance conditions, ontology/schema and exit rules. |
| Acceptance Criteria Tree | Recursive decomposition of outcomes and checks. |
| Ontology/schema | Structured domain terms and constraints used to reduce ambiguity. |
| Event store | Append-only SQLite history from which state/checkpoints can be replayed. |
| Artifact store | Artifact bodies in a separate SQLite store under `.ouroboros/artifacts/artifacts.db`; event records can refer to outputs. |
| Runtime adapter | Common boundary to native tools/external agent CLIs and ACP; protocol availability varies by adapter. |

The documented phases include a “Big Bang” interview, PAL Router, Double Diamond design, resilience work and a three-stage evaluation. CLI reference documents commands for running, inspecting and controlling the workflow. User-level skills/agents and bundled core skills are separate extension layers; general third-party plugin installation is described as planned/prototyped rather than uniformly shipped.

## Flow and control

User objective → ambiguity interview/intent capture → Seed and acceptance tree → routing/design divergence/convergence → dependency-aware implementation → staged verification/evaluation → artifact/evidence report. Runtime adapters execute bounded steps and return events/artifacts; the orchestration layer is intended to own the overall workflow and visibility.

## Risks and open questions

- Freezing a Seed protects task identity but needs an explicit revision/approval process when implementation uncovers wrong or incomplete requirements. A frozen misunderstanding can still be implemented perfectly.
- “Three-stage evaluation” does not by itself prove independence. Inspect whether evaluators see original intent, hidden acceptance cases and raw evidence, and whether they can return insufficient evidence.
- Ambiguity scores, ontology quality and completion claims require empirical calibration on real repositories.
- Event sourcing needs event schema versioning, idempotent replay, transactional artifact links, compaction policy and crash recovery tests.
- External CLI adapters vary in event, cancellation, session resume and permission support; do not erase those differences behind a lowest-common-denominator interface.

## Relevance to HorizonCode

Study immutable requirement baselines, explicit acceptance trees, staged workflow visibility and adapter boundaries. HorizonCode should make spec revision a first-class operation that invalidates affected task verification. Preserve original user request separately from derived Seed and retain provenance for every assumption.

## Primary references

[Architecture](https://github.com/Q00/ouroboros/blob/main/docs/architecture.md) · [CLI reference](https://github.com/Q00/ouroboros/blob/main/docs/cli-reference.md) · [Repository and project documentation](https://github.com/Q00/ouroboros)
