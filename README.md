# HorizonCode

HorizonCode v1 is a rebuild targeting the pinned OpenCode source revision
[`b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322`](https://github.com/anomalyco/opencode/tree/b1fe25ab5ecc9f9bc911a8a2e6a51565cc764322).
That is the intended implementation base, **not** the parent of the current HorizonCode
Git history and not evidence of HorizonCode implementation or acceptance.

## Repository status

- Root commit `0009178` (`docs: add finalized HorizonCode v1 architecture`) was the
  docs-only bootstrap baseline. Current `main` also contains bounded HorizonCode P1/P2/P4
  prototype slices; it is still not a buildable OpenCode application because the pinned
  OpenCode source base remains ignored and untracked. The repository's `README.md` and
  `AGENTS.md` guidance are tracked; a fresh clone does not include the local OpenCode
  source snapshot.
- `origin` is the only configured remote; no OpenCode `upstream` remote is configured.
- The archive/source-provenance and OpenCode-base P0 gates remain incomplete. So do the
  repository inventory, baseline verification, generated-output, and license gates.
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
working conventions. Current `main` includes bounded HorizonCode prototype slices but
still cannot build the OpenCode application without the separately pinned source base.
