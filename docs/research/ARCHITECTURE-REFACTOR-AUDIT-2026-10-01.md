# Architecture refactor and audit — 2026-10-01

## Scope and authority

This is a documentation-only consolidation of the final HorizonCode target blueprint.
`ARCH/` describes the intended product and architecture; it does not claim those
features are implemented or accepted. `TODO.md` remains the delivery ledger,
`research docs/tests.md` the test and benchmark plan, and `CURRENT_RUN.md` the
session handoff. Runtime code, installer scripts, builds, tests, and benchmarks were
not changed or run in this pass.

Base revision: `262bdb2fb8a2fef86d885a6c83ea49bae38bfcde` (2026-10-01). The
pre-existing dirty `cline-probe` worktree was preserved. No commit, push, publish,
deployment, or sibling-repository edit occurred.

## Architecture, delivery and source status

The architecture is a target blueprint, not a report that its features already run.
The codebase was separately reconciled with the delivery ledger at source HEAD
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`. Sixteen Rust crates form a partial
runtime foundation; there is no TUI crate or installer script. The current worktree
has no Rust/Cargo diff. The source delta from
`80400370c7898459f7e7c24642caba9af31379d1` to HEAD is the AX-405 skill-inspection
slice: five CLI/config implementation and regression-test files. The live source
trail and test inventory now name that delta and its limits.

`TODO.md` contains 155 tasks: 47 marked `implemented` because relevant code exists
wholly or partly (each row states what remains), 108 `proposed` with no relevant
implementation identified, and zero `verified`, `accepted` or `blocked`. No task is
accepted as complete. Major target areas without their owning runtime service include
the interactive TUI, managed long-horizon Run controller, persistent memory, MCP and
plugin lifecycle, installers/onboarding, LitePSM adapter and repository code
intelligence. Existing provider, session, tool, Guard, sandbox, audit, artifact,
configuration and CLI crates are real implementation foundations, but do not satisfy
the entire architecture or its acceptance matrix. The phrase “only some features
remain” would materially understate the gap: all 155 tracked tasks remain short of
acceptance, and 108 have no relevant implementation identified.

## Information disposition

All 38 original architecture files (16,829 physical lines) were preserved byte for
byte under
[`docs/history/architecture/original-ARCH-2026-10-01/`](../history/architecture/original-ARCH-2026-10-01/).
Their SHA-256 manifest is
[`original-ARCH-2026-10-01-manifest.json`](../history/architecture/original-ARCH-2026-10-01-manifest.json).
Decision history, the dated architecture review, research/source traceability, and
unresolved design proposals were moved outside canonical `ARCH/`; source URLs and
pinned paths remain available in the research ledger and traceability files.

| Original files | Canonical destination or disposition |
|---|---|
| 00 Index; 01 Vision; 02 Requirements; 03 Architecture | `ARCH/00-README.md`, `ARCH/01-VISION.md`, `ARCH/02-REQUIREMENTS.md`, `ARCH/03-SYSTEM-ARCHITECTURE.md` |
| 04 Decisions; 24 Architecture Review | Decision ledger and dated review in `docs/history/architecture/` |
| 05 Source Ledger; 26 Core Agent Crosswalk; 29 Source Traceability | `docs/research/SOURCE-LEDGER.md`, `CORE-AGENT-CROSSWALK.md`, `SOURCE-TRACEABILITY.md` |
| 06 UI; 27 Commands/Agents/Settings; 28 Artifact Store | `ARCH/product/UI.md`, `COMMANDS-AND-SETTINGS.md`, `ARTIFACTS.md` |
| 07 Session; 08 Loop; 09 Context; 10 Tools; 11 Provider; 18 Config; 19 Compression | `ARCH/core/` session, loop, context, tools, provider, config, and compression owners |
| 12 Guard; 13 Sandbox; 14 Audit; 22 Security | `ARCH/security/` Guard, Sandbox, Audit, and Security Model owners |
| 15 Protocols; 30 Distribution/Updates; 31 Control API; 38 litePSM | `ARCH/integrations/` protocol, distribution, control API, and litePSM owners |
| 16 Orchestration; 25 Long-Horizon Control | `ARCH/execution/` orchestration, long-horizon, worker, workspace, scheduling, budget, effect, recovery, stopping, and verification owners |
| 20 Analytics; 21 Discovery; 32 Agent Messaging; 33 Memory; 36 Code Intelligence; 37 Interaction/Fast Path | `ARCH/product/` analytics, discovery, messaging, memory, code intelligence, and interaction owners |
| 23 Verification | `ARCH/execution/VERIFICATION.md`, `ARCH/acceptance/ACCEPTANCE-MODEL.md`, and `ACCEPTANCE-MATRIX.md` |
| 34 Modularity; 35 Capability Parity | `ARCH/05-MODULARITY.md` and `ARCH/contracts/CAPABILITIES.md`; competitor evidence remains in research |

The new shared registries define domain identities, ownership, invariants, states,
flows, events, actions, capabilities, and performance in one canonical location.
Accepted semantics were rewritten in owning sections instead of retaining appended
correction/reconciliation blocks. Product UI requirements retain the three-slot
workspace and Pair/Mission Control/Review/Explore content presets, composer and
attachment behavior, attention inbox, keyboard/pointer parity, themes, motion,
streaming, highlighting, narrow-terminal behavior, and truthful completion. Memory
was redesigned as scoped advisory context with explicit saves, low-friction
correction, freshness/revalidation, deletion fences, and no authority transfer.
Installers, Bash/PowerShell wrappers, first-run onboarding, performance targets, and
their acceptance requirements are specified but remain unimplemented.

## Semantic review coverage

Reviewers used bounded, non-overlapping reads and source-to-destination dispositions,
then checked cross-owner schemas and links. The coverage record distinguishes full
reads from inventories; heading inventories are not semantic review. Complete
semantic reads cover all 38 archived original files: 00–16 and 18–38. Original 17
was intentionally unused and had no source file. The core-owner review read 07–11
and 18–19, including late append ranges reread during this pass; the memory redesign
review covered original 33; and originals 24, 26, 29, and 04 received separate
line-by-line reviews with their findings checked against canonical owners. Current
`ARCH/02-REQUIREMENTS.md` and archived original `02-REQUIREMENTS.md` were read in
bounded ranges through their final lines. All 272
distinct archived requirement IDs are present in the canonical requirement set.
Archived `05-SOURCE-LEDGER.md` was also read in full; its research/provenance role
remains outside canonical `ARCH/`. Archived original 04 (DEC-001..095) has now been
read line by line and mapped to the target owners. Effective decisions are embodied
by canonical contracts rather than requiring implementation readers to replay
decision history. Deliberate target changes include project-scoped ambient advisory
memory with no automatic global inference, and LitePSM ownership of shared catalog
ingestion/package lifecycle. DEC-095's signed installer wrappers and resumable
onboarding map to the distribution owner, requirements, AX-410 and ACC-INSTALL-02.
Original 24 has been read line by line; its findings
F-01..F-102, source-pattern limits, implementation-pass evidence, migration gates,
and late architecture findings were checked against the refactored ownership
structure and separate implementation-status ledger. Its dated audit/reconciliation
content remains historical and is intentionally outside canonical `ARCH/`. Original
26 has also been read line by line; its peer-pattern dispositions, source-coverage
limits, identity conclusions, and focused ecosystem crosswalk were checked against
the new subsystem owners. Original 29 has now been read through its final line; its
pinned upstream boundaries, local path/test map, AX task trails, and installer/UI
interaction traces were compared with the live source-trail map. This found a stale
AX-405 “partial implementation” label; the live trail now matches the implemented
metadata/body-size inspection slice and leaves AX-411/ACC-UX-12 open. Archive
preservation is not itself semantic coverage. Every existing archived original ARCH
Markdown file has now received a complete semantic read; original 17 was
intentionally unused. This does not claim runtime implementation, verification,
user acceptance, or independent product-market-fit evidence.

The material corrections made during reconciliation include: one owner per durable
fact; Thread/Run/Task/Attempt/WorkerExecution/Workspace/Effect/Evidence/Artifact/
Completion separation; direct-turn nullable managed identities; provider-neutral
workspace bindings; per-invocation dependency/effect-aware rolling tool scheduling
with ordered model observations; atomic budget reservation and recovery capacity;
unknown outcome fencing; trusted operator identity at control ingress; bounded,
reversible UI transitions; and exact source-backed acceptance states. The requirement
pass found malformed leftover lines from the former clarification block in
`ARCH/02-REQUIREMENTS.md`; duplicate fragments and the orphan table header were
removed because their effective rules already exist in canonical requirements.

The continuing owner audit found two additional consolidation defects and repaired
them in place. The extension design mixed the LitePSM-owned shared catalog/package
lifecycle with wording that implied a separate HorizonCode crawler and publisher;
the canonical contract now assigns ingestion, release, and managed package lifecycle
to LitePSM, while HorizonCode consumes the selected manager port and retains local
policy, permission review, execution, and runtime materialization. Catalog search is
read-only and package operations use the manager's separate versioned API. Several
canonical files also retained references to section numbers and filenames from the
old ARCH hierarchy; these now point to current owning files and headings.

The decision/source-trail cross-check found the live AX-371 trail still pointing to
DEC-067/072's historical explicit-only defaults after the accepted target moved to
DEC-096. The trail now points to the ambient/explicit/off target and names migration,
scoped advisory capture, direct saves, correction and child policy; the research note
now says these semantics are specified in the blueprint rather than implemented in
runtime. `research docs/tests.md` already covers the matching new-install, migration,
scope, freshness, correction and child-isolation cases.

The ledger audit found AX-405 marked `implemented` while its title and acceptance
text still included bundled artifact skills, workflow recipes and skill-cost
visibility that are absent from source. AX-405 now names only the implemented
offline metadata/body-size inspection slice; proposed AX-411 owns the remaining
target work. Current Claude command/artifact documentation and a pinned public
`web-artifacts-builder/SKILL.md` are linked as research. The public authoring skill
is not presented as the source of Claude's private bundled capability/diagramming
skills. ACC-UX-12 and the test plan require measured capability, revision, budget,
cancellation and no-false-PASS evidence.

## Documentation checks

- Original archive integrity was checked against the manifest: 38 files, no missing
  files or hash mismatches.
- Internal Markdown links and heading/custom anchors were checked across 127 active
  Markdown files: 1,518 internal links, zero unresolved targets or fragments. The
  verbatim original-ARCH snapshot, legacy `archives/`, and generated third-party
  notice output were excluded from this check. Moved decision and audit records were
  included and their relative links were repaired.
- `ARCH/02-REQUIREMENTS.md` was read in bounded line ranges through its final line;
  the orphaned fragments at the end of that file were removed and UI requirement
  `REQ-UI-033` was placed beside the related interaction requirements.
- The archived requirements file contains 272 distinct requirement IDs, all present
  in canonical `ARCH/02-REQUIREMENTS.md`; the archived source ledger was read in full.
- AX-405/AX-411 now distinguish the implemented skill-inspection slice from proposed
  bundled-skill, workflow-recipe and skill-cost-visibility work.
- Archived architecture/decision consistency was rechecked after the complete read:
  38/38 original-file hashes match the manifest, DEC-096 is reflected in the live
  AX-371 source trail, 155 TODO task IDs are unique, and `git diff --check` passes.
- Source/delivery reconciliation corrected the stale source-baseline claim and added
  the AX-405 test files to the inventory. Current source revision, implementation
  gaps, and exact TODO status counts are recorded in `TODO.md` and `CURRENT_RUN.md`;
  no runtime status was promoted.
- Original archive integrity was rechecked after this continuation: 38 files, no
  missing entries or hash mismatches. `git diff --check` passed after the AX-411
  split and link-anchor repair.

These are structural/documentation checks, not runtime evidence. The 2026 developer
sentiment research is qualitative and non-representative; Reddit/forum/Product Hunt
and official product sources were reviewed, while X/social search coverage was
limited by inaccessible full pages. Nothing in that sample establishes product-market
fit. Validate the hypotheses with user studies and measured task scenarios.

## Remaining boundary

Do not report the implementation or acceptance as complete. Runtime TUI/composer,
animations/rendering, tool scheduling, installer/onboarding, memory, controller,
platform confinement, MCP/skill/plugin lifecycle, and user-facing acceptance remain
delivery work tracked in `TODO.md`. No numerical speed claim is verified by this
documentation refactor. Continue line-level semantic review where source/coverage
records do not establish it, and repair canonical owners, requirements, acceptance
cases, source links, and the test plan together. This report does not claim that every
original ARCH line has been semantically reviewed.
