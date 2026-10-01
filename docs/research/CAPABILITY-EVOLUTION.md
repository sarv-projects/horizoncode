# 35 — Capability Registry, Parity Radar, and Evolution Protocol

**Status:** proposed architecture contract. No continuous competitor monitor,
capability registry, or automated parity claim is implemented.

## Capability records

Each capability has a stable HorizonCode key, description, owner/port, required inputs,
security tier, supported platforms, dependencies, and dated evidence references.
Examples include `workspace.worktree`, `tools.lsp`, `execution.container`, and
`verification.visual`. Records distinguish product support from upstream availability.

Evidence states are `ABSENT`, `DISCOVERED`, `CONFIGURED`, `AVAILABLE`,
`IMPLEMENTED`, `VERIFIED`, `DEGRADED`, `BLOCKED`, and `UNKNOWN`. These labels are
not a single linear promotion ladder: each claim carries source, subject/version,
scope, timestamp, and limitations. Only HorizonCode executable evidence can mark an
HorizonCode capability `VERIFIED`; competitor documentation can establish only a
scoped `DISCOVERED` observation.

## Parity review lifecycle

The review process is: observe a pinned source; classify its feature and evidence;
map it to a generic HorizonCode capability/port; decide adopt, adapt, defer, or reject;
implement only through the owning boundary; then verify with named tests/benchmarks.
Every comparison identifies the upstream revision, exact files/docs, date, license
disposition, and coverage limitations. A repository list or announcement is a radar
input, not implementation evidence or proof of parity.

Capability packs are declarative bundles of compatible tools, skills, and checks.
They identify members and compatibility requirements; they cannot grant Guard rights,
execute installation hooks, bypass per-member trust review, or start a runtime.

## Replacement property

The replacement objective is demonstrated through contract tests: substitute a
provider/worker/workspace adapter while keeping the same controller contracts, and
verify state, permission decisions, receipts, and acceptance evidence retain their
meaning. This is a testable modularity goal, not a guarantee that every implementation
can be swapped without configuration, migration, or capability loss.

Related owners: `CMP-worker`, `CMP-provider`, `CMP-tools`, `CMP-workspace`,
`CMP-repo-intel`; `ARCH/product/DISCOVERY-AND-EXTENSIONS.md` owns package discovery and installation trust, while this
document owns capability semantics and evidence classifications. See `ARCH/05-MODULARITY.md` for
dependency rules and `ARCH/acceptance/ACCEPTANCE-MATRIX.md` for acceptance evidence.

## Ecosystem radar scope

The capability radar may track pinned primary sources for products such as Codex,
Claude Code, OpenCode, Cline, and other reviewed peers, but must not treat an
unqualified awesome-list repository as evidence. Search surfaced multiple distinct
lists sharing similar names; none was selected as canonical. Every adopted claim needs
an exact product/version/source and bounded review scope under REQ-RESEARCH-001.

## Final capability classification clarification

Use a versioned CapabilityRecord with stable key, owner, subject/build/platform,
dependencies, configuration/trust snapshot, observed_at, evidence refs and limits.
The nine labels are separate observations: availability/configuration is runtime
health, implementation/verification is delivery evidence, and degraded/blocked/
unknown is current condition. Render these axes separately so an implemented but
unavailable capability cannot look ready. ARCH/00-README.md's five canonical delivery statuses
remain authoritative; DISCOVERED/AVAILABLE are not substitute acceptance statuses.
Radar refresh is explicit or a separately authorized bounded metadata job; it cannot
install code, send repository data, or start costly probes in the background.

## Interaction and integration reconciliation (2026-09-30)

Artifact renderers, clipboard support, optional Code Mode and litePSM methods declare actual availability and evidence independently. Supplied competitor menus are hypotheses until pinned primary checks; no parity status promotion from a command label.

Detailed shared contracts: [ARCH/product/INTERACTIONS.md](../../ARCH/product/INTERACTIONS.md) and [ARCH/integrations/LITEPSM.md](../../ARCH/integrations/LITEPSM.md). Status remains proposed; see TODO AX-401..410.
