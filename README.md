# HorizonCode

HorizonCode v1 is a rebuild targeting the pinned OpenCode source revision
[`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322).
That is the intended implementation base, **not** the parent of the current HorizonCode
Git history and not evidence of HorizonCode implementation or acceptance.

## Repository status

- Root commit `0009178` (`docs: add finalized HorizonCode v1 architecture`) was the
  docs-only bootstrap baseline. The `p2-foundation` work adds the verified pinned OpenCode
  source under `opencode/` without rewriting HorizonCode history; until that branch is
  merged and pushed, `main` and fresh clones do not contain the source snapshot. This
  subdirectory snapshot is not an OpenCode-derived root Git base and does not by itself
  establish a reproducible build or release.
- `origin` is the only configured remote; no OpenCode `upstream` remote is configured.
- The prior Horizon archive gate and OpenCode-derived root-base gate remain incomplete.
  The pinned source tree and byte-level path inventory are verified; baseline build,
  generated-output, full path-disposition, dependency/bundled-asset license, and release
  review gates remain open.
  See [`arch_V1/10-DELIVERY.md`](arch_V1/10-DELIVERY.md) for status and evidence
  requirements. This repository is not a verified HorizonCode runtime or release.

## Architecture authority

[`arch_V1/README.md`](arch_V1/README.md) is the entry point to the finalized, self-contained
v1 architecture. **Only `arch_V1/` is normative.** OpenCode source is an implementation
reference, not an architecture authority; historical HorizonCode `ARCH/` documents and
`crates/` are not active guidance. Prior Git metadata and archive refs were purged, so
historical source must not be presumed locally recoverable. Consider any recovered
component for porting only after verifying its source and recording the required owner,
interface, disposition, impact, and tests in the migration matrix in
[`arch_V1/10-DELIVERY.md`](arch_V1/10-DELIVERY.md).

Open P0 and capability-specific decisions are documented in
[`arch_V1/10-DELIVERY.md`](arch_V1/10-DELIVERY.md) and
[`arch_V1/17-GOVERNANCE-DECISIONS.md`](arch_V1/17-GOVERNANCE-DECISIONS.md). Keep gated
capabilities unavailable and claims evidence-based; architecture finalization alone
does not establish implementation, security, platform readiness, acceptance, or release
readiness. Current working-copy handoff details are in [`CURRENT_RUN.md`](CURRENT_RUN.md).

## Development guidance

See [`AGENTS.md`](AGENTS.md) for repository-state cautions and applicable OpenCode
working conventions. The pinned source snapshot is included only on the P2 work branch
until merge; implementation and release acceptance remain evidence-gated.
