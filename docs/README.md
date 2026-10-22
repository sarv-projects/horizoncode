# HorizonCode documentation map

This is **navigation only**. It is not another product architecture, runtime contract or implementation-status authority.

| Need | Current source of truth |
|---|---|
| Architecture decisions and single owner for each subsystem | [arch_V1/README.md](../arch_V1/README.md) → [§17 governance](../arch_V1/17-GOVERNANCE-DECISIONS.md) → the topic owner |
| Current implemented/untested runtime state and release blockers | [HANDOFF.md](../HANDOFF.md), verified against the current source, tests and GitHub CI |
| What to implement next | [The converged implementation plan](superpowers/plans/2026-10-11-horizoncode-converged-implementation.md), including P0–P9 and RC0–RC5 |
| Agent and contributor instructions | [AGENTS.md](../AGENTS.md), [CONTRIBUTING.md](../CONTRIBUTING.md) |
| Resource and RAM evidence | [Performance measurement runbook](performance/README.md), then actual recorded benchmark artifacts (none should be inferred from a blank template) |
| Full tracked-Markdown structural audit | `python3 scripts/architecture/audit_markdown_repo.py` (from repository root), optional `--json-report` for per-file evidence; [immutable 278-file baseline manifest](audits/2026-10-15-tracked-markdown-structural-manifest.json); consult root [HANDOFF.md](../HANDOFF.md) for audited baseline and exclusions |
| Risk, disclosure and OS sandbox qualification | [SECURITY.md](../SECURITY.md), [§05](../arch_V1/05-SECURITY.md), [§14](../arch_V1/14-EFFECTS-EXECUTION-SECURITY.md), [§18](../arch_V1/18-OPERATIONS-RELEASE.md) |
| Original external source decisions/attribution | [§42 provenance register](../arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md) |
| Chronological development notes | [CURRENT_RUN.md](../CURRENT_RUN.md); never an alternate live architecture |
| Root file roles / redundancy candidates | [repository-root-inventory.md](repository-root-inventory.md) |
| V1 wire tracker (done / partial / not done) | [arch_V1/46-V1-WIRE-TRACKER.md](../arch_V1/46-V1-WIRE-TRACKER.md) |
| Historical design and displaced notes | [architecture-archive/](architecture-archive/) — non-operative |
| Source material that informed the architecture | [architecture-input/](architecture-input/) — design provenance, not current instructions |
| Hydrated workspace source layout | Run `python3 scripts/architecture/bootstrap_source.py --apply` from repo root before builds; then inspect `packages/` and `kernel/` |

## How to read for implementation

Start with the current topic owner's HLD and its §37 service LLD, then §20's **hydrated source map** and §32's acceptance cases. Before calling any capability WIRED or VERIFIED, ensure its wire schema has one generated owner, it is registered under an existing capability ID, the actual entry points and platform implementation exist, and both positive and negative/system tests have been run. A design, an old CI success or a proposed code snippet is not executable proof.

Run `python3 scripts/architecture/audit_markdown_repo.py` for structural Markdown checks and `python3 scripts/architecture/validate_convergence.py` for architecture convergence gates. Neither script establishes per-sentence semantic correctness, machine-schema generation, or runtime feature completion.

Release, legal, and security guarantees remain explicit outstanding gates until V1 qualification passes.
