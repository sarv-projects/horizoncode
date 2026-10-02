# CURRENT_RUN — HorizonCode

## Current handoff — AX-419 fixed Runner fixture (2026-10-02)

Working base: `ff79130b9a6b40511cd3e370c567681a6f746a07` on `main`; the AX-419 fixture
increment is currently uncommitted. `hz-eval` now has bounded strict V1 record
validation plus a fixed `hz-eval run --fixture smoke` path. The latter runs the
production Runner with a scripted in-process provider, an isolated temporary workspace
and session, and a fixed development-only task. It persists a bounded Runner-observer
trajectory, exact final workspace snapshot, and sealed run record as separate
create-new artifacts under an explicit existing real output directory. It uses no
provider transport or advertised network/shell tool and makes no OS sandbox guarantee.
The verifier remains `not_run`; this is harness-mechanics evidence, not coding-quality
or benchmark acceptance. The fixture emits attempt 1 only.

Local checks on the dirty worktree pass: `cargo +1.89.0 test -p horizoncode-eval
--locked --offline` (34 library, 7 CLI, 5 Runner-fixture tests), targeted Clippy with
`-D warnings`, package-scoped rustfmt check, `git diff --check`, the Cargo
architecture graph (17 packages/49 internal edges), and its fixtures (1 valid, 3
violating). These are scoped local checks, not independent verification or
`ACC-EVAL-01` acceptance. No live provider, network benchmark, holdout, or release test
was run. AX-419 remains `implemented`, not `verified` or `accepted`; independent
verification, holdout controls, compare/report, cross-language digest execution, B0,
and HZBench remain open.

Capture-bound trajectory and workspace metadata now retain bounded incomplete evidence;
tests cover workspace byte/metadata limits and sealed trajectory-overflow outcomes. A
temporary probe checks the selected output filesystem's private modes, hard-link
publication, no-replace behavior, and directory sync before the attempt directory is
created. Open fixture gaps are tracked in TODO.md: artifact I/O and crash recovery
injection, output path TOCTOU and parent-directory durability, cross-platform publication
evidence, timeout/task-failure cases, and retries. Fixture tests do not establish
OS-level confinement or real-provider telemetry. Ledger remains 163 tasks: 50
implemented, 111 proposed, 2 verified, 0 accepted, 0 blocked. Independent review is
checking the final source/docs state; B0 remains gated on comparable routes and
authorization.

Earlier workspace-wide formatting-only changes to unrelated Rust files were reverted.
The nested `cline-probe` research checkout and user changes remain preserved.

---

## Historical handoff — Agile implementation progress (2026-10-02)

Working base: `fd7c2bdabcfca4cac58dcbedf4c627a49bfcb336`, branch `main`. P0.0's
orphan-gitlink/CI repair is committed at `f06cd649b1175a1d6eb41d6020c2aefc6b8ccb6c`;
the AX-005 loopback cancellation regression is committed at this working base.
AX-413..419 remain design targets; no index daemon, coarse repository tool,
ChangeReceipt runtime, skill library or hz-eval runtime is claimed.

Fresh-clone diagnosis on that exact revision: clone and checkout succeeded; the
`cline-probe` gitlink had no `.gitmodules` mapping, and `git submodule status --recursive`
failed. CI did not request submodules and Cargo excludes the path. The parent gitlink is
removed and `/cline-probe/` is ignored. The nested Cline research checkout is
preserved at `d7250ad39400d1485fc11011a80fdab26aeeff83` with its 4,165 user-local
changes untouched. CI now invokes the architecture graph checker and its committed
valid/negative fixtures. A clean clone of repair commit `f06cd649b1175a1d6eb41d6020c2aefc6b8ccb6c`
passes locked metadata and architecture graph/fixture checks; the superproject has no
`cline-probe` gitlink and `git submodule status --recursive` succeeds with no entries.
The nested checkout remains present at the same HEAD with 4,165 local changes. A clean
clone of the immediately preceding commit passed the offline build, Clippy, production
cargo-deny, both license negative controls, and serial full workspace tests. The test
command was `cargo +1.89.0 test --workspace --locked --offline -- --test-threads=1`
(exit 0; all executed tests passed, one manual performance capture ignored). The repair
commit changes only CI, ignore metadata and the orphan gitlink; Cargo sources are
unchanged. Hosted CI and the platform matrix remain unrun.

The 163-task ledger has 49 implemented, 112 proposed and 2 verified tasks; none are
accepted or blocked. AX-121 moved to `implemented` because its workflow gates are
present; hosted workflow evidence remains open. P0.1 read-only source/status review
found and fixed two documentation errors: AX-104 listed the closed F-65 audit-genesis
fix as open, and AX-405's source-trail evidence link pointed at the wrong directory.
The 400–419 range totals and mapped links matched; the 200–399 reviewer found no
concrete status mismatch, and the 001–126 reviewer found no other concrete mismatch
in its bounded pass. These were source/status reviews, not fresh acceptance runs or a
complete re-execution of every task's evidence. No task status was promoted. The
focused tools test at source HEAD `7441b79191aa645ad0deda0341bb67dbd9c51b8a` remains
scoped local evidence only. AX-005's provider tests pass at `fd7c2bd` (27 unit and 9
loopback integration tests), including a fixture that cancels and drops the active SSE
consumer and observes server-side EOF/reset. The full serial workspace test command
passed at the same revision; one manual performance capture is ignored. The changed
test file passes rustfmt and `git diff --check`. Workspace-wide `cargo fmt --all --check`
fails on existing formatting diffs in unrelated files; none were changed. The loopback
fixture does not exercise Runner cancellation selection end-to-end, and AX-005 remains
implemented with `ACC-PROV-RAW-01` open. Next per Agile dependency order: start AX-419's
evaluation harness before any model-call or fast-path optimization; safety repairs can
still proceed when their evidence establishes urgency. Hosted CI, live-provider
benchmarks, and push have not been performed by this run.

Everything after this handoff is a dated historical run record. Any “current,” “active,”
or “next” wording below describes only the checkpoint where that record was written.

## AX-004 bounded reads and recursive search confinement (2026-10-01)

Implemented slices for `REQ-TOOL-010`/`011` now include the opened-handle `read`
ceiling and growth detection; confined recursive `glob`/`grep`; workspace-local
`.ignore` and `.gitignore` behavior; selected-root ignore handling; typed parse,
walk, read, cancellation, and budget failures; a 1 MiB per-ignore-file ceiling,
16 MiB aggregate ignore-rule-content ceiling, 100,000 entries delivered to the
walker filter ceiling, 64 MiB aggregate `grep` input ceiling, and cooperative
turn cancellation. The ignore dependency is pinned to `ignore = 0.4.33`. `.ignore`
rules outrank `.gitignore` across directory depth; deeper files outrank parents
within the same type. Full acceptance is still open.

Verification ran on the dirty worktree based on HEAD
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`; these results are local and are not
integrated-revision acceptance evidence:

- `cargo +1.89.0 test -p horizoncode-tools --locked --offline -- --test-threads=1`
  passed: 21 unit, 23 mutation, 26 permission, and 24 tool integration tests.
- `cargo +1.89.0 test --workspace --locked --offline -- --test-threads=1` passed.
- `cargo +1.89.0 clippy --workspace --all-targets --locked --offline -- -D warnings`
  passed.
- `cargo deny check licenses` passed for the locked dependency graph.
- `cargo +1.89.0 run -p horizoncode-cli --locked --offline -- notices generate`
  regenerated the checked-in third-party notices for the new dependency. The broader `cargo deny check`
  could not acquire its advisory-database lock because the sandbox could not
  create the required directory under the Cargo home.
- `rustfmt +1.89.0 --edition 2024 --check` passed on the touched Rust files;
  `git diff --check` passed. A local Markdown-target check passed for the eight
  edited docs. `scripts/check-doc-refs.mjs` is not present in this checkout.
- The audit tamper fixture in `crates/horizoncode-audit/tests/chain.rs` now
  guarantees that its replacement Merkle-root character differs from the source;
  the previously unchanged-character case made that test flaky.

Still open: the `ignore` crate internally filters some entries before invoking
the capped callback, so total traversal work, cancellation latency, and memory
use are not bounded for every wide directory. Cancellation can wait for one
bounded synchronous file read or an unbounded internal skip run. The
walker reopens ignore files by path, leaving the documented concurrent-mutation
race. Injected walk/read failures, complete per-tool symlink/ignore/large-tree
coverage, observable proof that denied descendants are never visited, Guard
descendant-resource review, supported-platform special-file fixture evidence, and
integrated-revision `ACC-TOOL-READ-01`/`ACC-TOOL-SEARCH-01` bundles remain open.
`TODO.md` remains `implemented`, not `verified` or `accepted`. No commit or push
was made.

AX-314 was pulled forward as a safety interleave because its prior implementation
could publish earlier files before a later patch hunk failed. Its local code and
acceptance/test updates are recorded below; post-crash reconciliation still
depends on AX-311. Next, resume the AX-005 loopback cancellation assertion.

## AX-314 patch preflight and staged publication (2026-10-01)

The `apply_patch` path now resolves and authorizes every target and checks both
read/write confinement before opening target contents. It snapshots raw bases
within 16 MiB per file and 64 MiB total, caps patch text at 4 MiB and operations
at 256, simulates operations in request order (including repeated resolved
targets), and rejects invalid hunks/target states before publication. All changed
replacement contents are staged in target directories before the first publish;
all bases are rechecked before publication and each path is checked again before
its per-file rename/removal. Basic permission bits are preserved for replacement
files. A later in-process failure returns `TOOL_PARTIAL_EFFECT` with committed
digests/removals and pending paths.

This is not a multi-file transaction or a durable crash journal. A process death
may leave complete earlier files published and staging files behind; its aggregate
outcome remains `UNKNOWN` until AX-311 effect journaling/reconciliation exists.
Ownership, ACLs, extended attributes, the final race with non-cooperating writers,
and platform-specific rename behavior remain acceptance residuals. Local tests
must not be treated as `ACC-TOOL-PATCH-01` acceptance.

Verification on the dirty worktree based on HEAD
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`:

- `cargo +1.89.0 test -p horizoncode-tools --locked --offline -- --test-threads=1`
  passed: 28 unit, 24 mutation, 26 permission, and 24 tool integration tests.
  New cases cover late-hunk preflight, injected stage failure and cleanup, a
  base mutation during staging, later partial-publication receipts, patch text
  and operation caps, and exact/over snapshot limits.
- These are local crate tests only. `ACC-TOOL-PATCH-01` is not accepted; the
  full workspace suite, Clippy, aggregate-cap instrumentation, platform
  replacement checks, process-death reconciliation, and integrated evidence
  remain outstanding. No commit or push was made.

## AX-005 bounded provider response transport (2026-10-01)

Implemented the `REQ-PROV-017` v1 adapter ceilings: successful response bodies are
limited to 16,777,216 bytes after HTTP content decoding, serialized SSE lines to
1,048,576 bytes including a present terminator, and non-success preview retention to
8,192 bytes with redaction before a 512-Unicode-scalar display cap. Declared lengths
are refused before parsing when over limit; streamed counts are enforced when length
is absent or inaccurate. Overflow produces a non-retryable `response_limit`, does
not retry/fallback, and cannot produce a successful finish. HTTP failures retain
their status and parsed `Retry-After`. Dropping the consumed SSE stream drops its
underlying response source. These ceilings do not claim to bound reqwest's already
allocated yielded chunk or process RSS.

Verification on the dirty working tree based on
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`:

- `cargo +1.89.0 test -p horizoncode-provider --features testing --locked --offline
  -- --test-threads=1` passed (27 unit, 8 mock-transport integration tests).
- `cargo +1.89.0 test --workspace --locked --offline -- --test-threads=1` passed;
  one manual release performance capture remains intentionally ignored.
- `cargo +1.89.0 clippy --workspace --all-targets --locked --offline -- -D warnings`
  passed.
- `git diff --check` passed.

Focused cases cover exact/over body and SSE-line bounds, split lines, chunked aggregate
overflow, pre-parse declared-length refusal, bounded preview reads, redaction before
Unicode truncation, status and retry metadata, absence of successful finish after
overflow, and response-source drop. This is local implementation evidence, not an
`ACC-PROV-RAW-01` acceptance bundle. Explicit cancellation signaling and revision-bound
retained-byte evidence remain acceptance work. TODO stays `implemented`; no commit or
push was made.

## AX-003 bounded direct response admission (2026-10-01)

Implemented v1 admission limits for a single native runner response: 32 tool calls,
262,144 aggregate argument bytes, and 4,194,304 retained decoded-response bytes.
The runner rejects malformed or schema-invalid calls, unsupported schema constraints,
unadvertised tools, duplicate/missing call IDs, and finish/call mismatches before
dispatching any member of the response batch. Provider `length` responses remain
partial; missing or unsupported finish reasons fail closed. Cancellation preserves
bounded partial text and discards provisional tool calls. Tool input validation is
implemented for the documented schema subset and fails closed on unsupported
constraints.

Verification on the dirty working tree based on
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`:

- `cargo +1.89.0 test -p horizoncode-runner --locked --offline -- --test-threads=1`
  passed (5 unit, 18 direct-loop E2E, 2 permission-audit tests).
- `cargo +1.89.0 test -p horizoncode-tools --locked --offline` passed (15 unit,
  18 mutation, 26 permission, 13 tool tests).
- `cargo +1.89.0 test -p horizoncode-provider --features testing --locked --offline
  --test mock_transport -- --test-threads=1` passed (5 tests).
- Focused CLI audit/tool tests passed, including resource-specific Guard denial and
  plan-mode rejection of a provider call omitted from the advertised schema.
- `cargo +1.89.0 clippy --workspace --all-targets --locked --offline -- -D warnings`
  passed after the final fixture adjustment.
- The final `cargo +1.89.0 test --workspace --locked --offline -- --test-threads=1`
  passed. One manual performance capture remains intentionally ignored.

The full-suite run exposed two stale CLI fixture expectations. The blanket deny and
plan-mode fixtures returned `write` even though Guard correctly omitted it from the
advertised schema. The deny fixture now targets `blocked.txt`, so it tests an actual
runtime policy denial and audit record. The plan-mode fixture now asserts a typed
`UNADVERTISED_TOOL` rejection, no tool-call/result event, and no effect. This matches
the whole-response fail-closed contract.

This is local implementation and test evidence, not `ACC-LOOP-01` acceptance. The
acceptance artifact is absent; provider raw HTTP/SSE body and line bounds now have
their own implementation and acceptance row under AX-005; the managed `CMP-orch`
RunController, continuation, and multi-hour recovery remain unimplemented. TODO stays
`implemented`. No commit or push was made.

## AX-001 dependency license gate (2026-10-01)

Implemented the workspace dependency-license gate in `deny.toml` and the pinned
GitHub Actions workflow. The all-feature Cargo graph is checked with cargo-deny
0.20.2; `webpki-roots@1.0.9` is the only crate/version exception, for
`CDLA-Permissive-2.0`. Two standalone local fixtures exercise rejection of a
`GPL-3.0-only` dependency and of a dependency with no license declaration. The
workflow also keeps Rust 1.89 Clippy and workspace tests as build checks. It does not
yet have a hosted run record.

To satisfy the existing permissive-only dependency rule, removed the workspace
`dirs` dependency, which brought in the disallowed MPL-2.0 `option-ext` crate. The
shared config crate now resolves the OS home directory with Rust's standard library;
the CLI and Guard reuse that one resolver. This preserves the platform home lookup
while eliminating the transitive package. `Cargo.lock` SHA-256 is
`9de355037b537e320fd8d532fc8cb37b2f00029638aaff1da404f20efa9a10d6`; neither
`dirs` nor `option-ext` remains in the workspace lock.

Local checks on the dirty tree based on
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`:

- `cargo deny --version` reports `cargo-deny 0.20.2`.
- `cargo deny --manifest-path Cargo.toml --all-features --locked check licenses`
  passes. The GPL fixture fails with `license is not explicitly allowed`; the
  missing-license fixture fails with `unlicensed-license-fixture is unlicensed`.
- `cargo +1.89.0 clippy --workspace --all-targets --locked --offline -- -D warnings`
  passes.
- `cargo +1.89.0 test --quiet --workspace --locked --offline -- --test-threads=1`
  passes. The local ACP mock-provider tests required loopback binding; no live
  provider or external service was contacted. One pre-existing ignored test remains
  ignored.
- The Rust files changed for AX-001 pass
  `rustfmt +1.89.0 --edition 2024 --check` individually. A repository-wide
  `cargo +1.89.0 fmt --all -- --check` reports many existing formatting diffs in
  unrelated files, so the new workflow does not add a workspace formatting gate.
- `cargo run --offline -p horizoncode-cli -- notices generate` regenerated the
  722,913-byte bundle, and `cargo run --offline -p horizoncode-cli -- notices check`
  reports that the bundle is current.
- AX-399's metadata dependency check still passes for 16 workspace packages and 42
  normal internal edges; its self-test passes 1 valid and 3 invalid graph fixtures.
  `git diff --check` passes.

`AX-001` remains **implemented**, not verified or accepted: `ACC-DEP-01` and release
gate `G-1` require a retained hosted workflow record for the exact integrated commit.
No commit or push was made. Continue with AX-003, the next Phase 1 item, after this
handoff is reviewed; retain the pending CI evidence as a separate acceptance gate.

## AX-124 performance feasibility probe (2026-10-01)

Added `crates/horizoncode-cli/tests/perf_baseline.rs` and monotonic timing accessors
to the existing test-only mock provider. The ignored release harness runs the actual
headless binary against a scripted loopback provider, verifies completed text and list
tool turns, and writes raw per-process JSON evidence under the ignored
`target/perf/ax124-headless-diagnostic.json`.

Checks: focused helper tests passed (2/2); the release-mode capture passed (40 completed
processes: 30 text turns and 10 one-tool turns). On this WSL2 / Intel i3-1215U / four
logical CPU environment, the capture observed CLI-spawn-to-fixture-dispatch p50/p95 of
55.7/93.4 ms, text-only spawn-to-first-NDJSON-text-event p50/p95 of 57.8/94.5 ms,
list-tool start-to-finish event duration p50/p95 of 48.4/69.1 ms, and sampled child
RSS p50/p95 of 11.4/11.7 MiB for text runs and 11.8/12.1 MiB for tool runs. These
numbers include process/config/session work where applicable, exclude
model inference, and are not comparable to PERF-DISPATCH, PERF-STREAM paint, or other
UI targets. The source tree digest is
`a2e2f352826aa07397c8b066310334e06cb123fe667f35817c255caa816cec91`;
the release binary digest is
`5ed948dda9a0a547ab8a310b977f3067e5afb7fb046a7bb625c90aff597d3fe4`. The recorded
base revision is `262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`; the worktree was dirty.

No terminal/TUI render loop, interactive cancellation, managed queue/index, slow-terminal
backpressure, idle CPU, or OS-cache-controlled cold-start path exists here; those
metrics remain unmeasured and `ACC-PERF-01` remains unaccepted. A sandboxed run could
not bind the local mock socket; the same release test passed when explicitly approved
to bind only loopback. `TODO.md` marks AX-124 implemented, not verified/accepted. AX-362's pinned source
inventory is now structurally verified; AX-399's Cargo dependency-DAG gate is now verified; AX-412 owns the later adapter
contract/capability-view acceptance. The next roadmap work is Phase 1 shared runtime
and safety foundations.

## AX-362 pinned provider/auth source inventories (2026-10-01)

Rechecked the OpenCode provider source at `0112a92c416f5ad833d96e7a8308441f0a875d94`
and Cline at `8eee168b80127b0c94bad849323754b5864865e7`. The fresh credential-free
OpenCode Models.dev feed has 225 provider IDs/8,339 model rows and SHA-256
`448ae274adb22c1b8fdff113a43eaec149a5e4f6b868ac299b5d545d1d465b8d`; IDs match the
2026-09-28 snapshot. Cline's effective registry is represented by 228 unique rows
(182 generated-only, 29 generated with runtime overrides, 17 runtime-only), plus 45
source-key mappings. Unknown auth stays explicitly unknown. The Cline inventory links
each entry to its pinned generated/runtime source or catalog documentation and records
the source license/notice scan limits.

The locally captured OpenCode Go development feed passed the provider inventory
structure/digest check: row counts, uniqueness, snapshot
digest and feed counts. This is a repeatable structure/digest check, not evidence of
HorizonCode adapter support or provider acceptance. `ACC-PROV-SYNC-01`, AX-363 route
conformance, vendor-terms review, and the separate OpenCode Go refresh remain open;
no upstream provider test or live inference was run. Details and pinned URLs are in
[`OpenCode inventory`](research%20docs/opencode-provider-inventory.md),
[`Cline inventory`](research%20docs/cline-provider-inventory-2026-10-01.md), and the
[source trail](docs/research/SOURCE-TRACEABILITY.md#ax362). AX-399 is now verified;
the roadmap proceeds to Phase 1.

## AX-399 Cargo dependency DAG and boundary gate (2026-10-01)

Added [scripts/check_architecture_deps.py](scripts/check_architecture_deps.py) and
four metadata fixtures. The gate classifies every workspace crate into inward
foundation/state/capability-service/control/surface layers, checks normal local
dependency edges and cycles, rejects unclassified or unresolved local workspace
dependencies, and blocks the initial explicit denylist of known UI, VCS/container,
and provider SDK crates from core. The policy does not claim to recognize every
possible future adapter package; extending the denylist is a reviewed change.

Checks passed on HEAD `262bdb2fb8a2fef86d885a6c83ea49bae38bfcde` plus the dirty
working-tree checker: current Cargo metadata reports 16 workspace packages and 42
normal internal dependency entries; the fixtures pass one valid graph and reject an
outward edge, `ratatui` in foundation types, and a cycle. The metadata SHA-256 is
`e28555236ab695311712d446f5f3224c76c5dbc5004f42b54433d91ac8050814`; checker SHA-256
is `3a8f117fb7fc46fe5f9cb1842d353d4ca60de0c7ce970cd9f6b701320d87c2d7`. Environment:
Cargo 1.98.0, Python 3.12.3, offline metadata. TODO marks AX-399 verified for this
static check only. CI wiring remains with AX-121; adapter contracts and the Doctor
capability projection remain open under AX-412/`ACC-MOD-02`. This static result says
nothing about runtime authorization or OS confinement.

## Architecture blueprint and delivery/source reconciliation (2026-10-01)

The delivery ledger now has a dependency-ordered execution roadmap. It starts with
product-fit, performance, platform, provider, integration, release, memory, and
recovery feasibility checks; then sequences the existing 156 AX tasks through
shared foundations, durable state, controller/workers, context/provider services,
TUI/product surfaces, integrations, and release acceptance. Every existing task is
listed exactly once in the roadmap; task rows, acceptance evidence, URLs, statuses,
and scope were preserved. This is scheduling guidance, not a claim that a probe or
source slice is verified/accepted. No runtime source changed in this roadmap edit.

The user-authorized architecture refactor is complete. `ARCH/` now has a target
blueprint structure with shared domain/ownership/invariant/state/flow/event/action/
capability/performance contracts, subsystem HLD/LLD, product/UI flows, security,
integrations, and acceptance. Original ARCH files are preserved byte-for-byte in
`docs/history/architecture/original-ARCH-2026-10-01/`; decisions, research/source
traceability, dated review, and unresolved proposals live outside canonical ARCH.
External source URLs and pinned source references remain available for implementation
workers. The memory target and README/contributor navigation were updated. TODO and
`research docs/tests.md` distinguish the target blueprint from source implementation
and verification status.

Base revision: `262bdb2fb8a2fef86d885a6c83ea49bae38bfcde`. Source and delivery
reconciliation confirms the 16 existing Rust crates form a partial runtime
foundation; there is no TUI crate or installer script. Compared with source snapshot
`80400370c7898459f7e7c24642caba9af31379d1`, this HEAD adds the five-file AX-405
offline skill-inspection slice. At the time of that reconciliation the working diff
contained no Rust/Cargo changes; the later AX-124 follow-up above adds test-only
mock-provider timing accessors and an ignored benchmark, not product runtime behavior.
The ledger has 156 tasks: 47 have relevant code wholly or partly, 108 have
no relevant implementation identified, one (AX-399) has a verified static architecture
gate, and none are accepted. The 47 source-present rows still name gaps; all 156
remain unaccepted. The interactive TUI,
long-horizon Run controller, memory service, MCP/plugin lifecycle, installers,
LitePSM adapter, and code-intelligence service remain delivery work. This is why
“only some features remain” was inaccurate.

Archive manifest check:
38 original files, zero missing/hash mismatches. Active Markdown link/anchor scan:
127 files, 1,518 internal links, zero broken. A line-level read of `ARCH/02-REQUIREMENTS.md` found and
removed orphaned duplicate fragments/table markup from the old clarification block;
its effective rules remain in their canonical requirement entries. The refactor
audit and source-to-destination map are recorded in
[`architecture refactor audit`](docs/research/ARCHITECTURE-REFACTOR-AUDIT-2026-10-01.md).

The continuing audit also removed a duplicate HorizonCode catalog-ingestion/publisher
assumption from the extension target: LitePSM owns shared catalog ingestion/release
and managed package lifecycle; HorizonCode consumes that manager through its adapter
and retains user authorization, policy, and execution. Stale old-ARCH section
references were replaced with current canonical file/heading references. The moved
decision/audit record links now resolve; archived original bytes remain unchanged.
The ledger audit split implemented AX-405's exact offline skill-inspection slice
from proposed AX-411's bundled artifact skills, workflow recipes and skill-cost
visibility. Claude's official command pages and a pinned public authoring-skill
source remain linked for implementation workers; no private source is claimed.

The semantic read-through of all 38 archived original architecture files is complete
in bounded, non-overlapping ranges; original 17 was intentionally unused and had no
source file. All 272
distinct requirement IDs from archived 02 are present in canonical
`ARCH/02-REQUIREMENTS.md`; original 24's findings and source-pattern dispositions
were cross-checked against the refactored ownership structure; original 26's peer
patterns, source limits and identity conclusions were checked against current
component, product, execution and integration owners. Original 29 has now been read
through its final line; its pinned source limits, local paths/tests, task trails, and
interaction/installer traces were compared with the live source-trail map. That pass
found and corrected AX-405's stale “partial implementation” label to match its
narrow implemented scope, while retaining AX-411 and ACC-UX-12 as open. Archived 04
(DEC-001..095) has now also been read line by line and mapped to canonical owners.
Effective target changes include project-scoped ambient advisory memory with no
automatic global inference and LitePSM ownership of shared catalog ingestion/package
lifecycle. DEC-095's signed installer wrappers and resumable onboarding map to the
distribution owner, requirements, AX-410 and ACC-INSTALL-02. Preserved bytes alone
are not semantic coverage. Do not describe this documentation set as runtime
implementation or acceptance.
The decision cross-check also found a live AX-371 source-trail row that still
described DEC-067/072's explicit-only memory defaults. It now points to DEC-096 and
the ambient/explicit/off target; the memory research note now says the behavior is
specified in the blueprint, not implemented in runtime. Canonical memory acceptance
already covered new-install defaults, upgrade migration, scope, correction, freshness
and child isolation in `research docs/tests.md`.
During the architecture documentation refactor, no runtime implementation, installer,
build, product test, benchmark, deployment, commit, or push was performed. The later
AX-124 follow-up above added and ran its bounded test harness; the archived
original-file semantic read-through is complete; implementation, platform behavior,
and acceptance evidence remain open as tracked in TODO. The initial dirty
`cline-probe` worktree is preserved. Final checks: original archive manifest 38/38
hashes match; 127 active Markdown files / 1,518 internal links have zero broken
targets or anchors; 155 TODO rows have no duplicate AX IDs; and `git diff --check`
passes. These are documentation checks only. Runtime implementation/acceptance stays
open as tracked in TODO.

## AX-405 first implementation slice (2026-09-30)

Implemented content-free offline skill inspection through the existing config owner
and `/skills show <name>` headless path. Body UTF-8 byte count and a labelled
ceiling(bytes/4) heuristic estimate are shown; observed injection and activation
counts remain unknown. No skill executes, no content is injected or printed, no
resources are followed, and no session/provider is started. Listing remains metadata-only.
Digest drift, missing files and symlink replacement use existing validated-read refusals.

Source: config `skills.rs`/`lib.rs`, CLI `surfaces.rs`; regression suites:
`config/tests/skill_inspection.rs` and `cli/tests/commands_cli.rs`.
Checks: inspection 4 passed; CLI commands 10 passed. The CLI regression was observed
failing before implementation. Source hashes and commands:
[AX-405 evidence](research%20docs/source-audit-coverage/ax405-skill-inspection-2026-09-30.json).
The full serial workspace suite passed: `cargo test --workspace --offline -- --test-threads=1` (exit 0). The sandboxed run failed local ACP mock-listener binding; those isolated mock tests passed with loopback permission. A prior parallel run had one audit integration failure; the isolated audit crate and final serial workspace reruns passed. `git diff --check`, targeted `rustfmt --check`, and local link/fragment validation passed (45 Markdown files, 1,256 links, zero errors).

HEAD remains `42466aa410d50d5135195ba8823636a397524f95` with a local dirty diff;
no dependency change, commit, push, publication or sibling edit. AX-405 is partially
implemented, not accepted: bundled skills/workflows, exact tokenizer/resource costs,
activation observations and visibility controls remain open. Existing architecture
changes and cline-probe changes were preserved. Next action: implement the next
ready feature slice and record its source and acceptance evidence.

## Interaction, performance and litePSM expansion (2026-09-30)

User-authorized documentation scope completed with fresh line-by-line read-only audits
of all36 existing ARCH documents (15,949lines) and all26 litePSM ARCH documents
(3,821lines); truncated ranges were reread. New ARCH37/38 were independently read
in full after authoring. Coverage/hashes: [record](research%20docs/source-audit-coverage/interaction-review-2026-09-30.json).

Added DEC092..095, REQUI034..040, REQPERF005/006, REQPROTO009, REQUPDATE008,
SRC042..044, AX401..410 and planned ACCUX09..13/ACCPERF01/ACCEXT01/ACCINSTALL02.
Owners now link artifact picker/skills/viewer/version feedback, exact paste/image chips,
durable drafts, queue/recap/branches, skill costs, settings/theme/motion/streaming/
highlighting, measured fast path, rolling pools/optional CodeMode/Ralph strategies,
litePSM adapter and required Bash/PowerShell wrapper/onboarding contracts. Corrected
identified active owner/status/config/cancellation/protocol/preview contradictions.
[Review report](research%20docs/interaction-performance-litepsm-review-2026-09-30.md)
records source ranges and remaining gates; existing final audit is historical coverage.

HEAD remains42466aa410d50d5135195ba8823636a397524f95; no Rust/Cargo/install scripts
were implemented, no commit/push/publication occurred, and unrelated cline-probe
changes were preserved. litePSM changed externally49ac134→a3ca33ba0dc51b7e2a2411349bedd2d021be9a1f
while its ARCH content remained identical; no sibling files edited. Actual DeepSeek
source reviewed at639ed015397290b3745d163aafe02ffee4aa3f84, with limitations documented.
All ten delivery tasks remain proposed. Runtime/platform/TUI/usability/performance
acceptance and sibling schema/approval/journal/IPC fixes remain open. Documentation
validation covers links/fences/unique IDs/coverage/source paths and diff whitespace;
no runtime or live-provider tests ran. Next action is bounded implementation of an
owning task after its dependencies are available; no speed or enforcement claim is
accepted from prose alone.

## Complete final architecture read-through (2026-09-30)

Read all 36 current ARCH Markdown files in full: 15,183 initial lines in 89
bounded ranges; truncated output was reread before counting it. ARCH/17 remains
intentionally unused. Inspected the resulting additions and active replacements;
the final architecture contains 15,949 lines. Input SHA-256 hashes/read ranges and
final hashes/counts are in [the coverage record](research%20docs/source-audit-coverage/architecture-final-2026-09-30.json).
This supersedes the earlier affected-owner-only coverage claim for this request.

Documentation HEAD remains 42466aa410d50d5135195ba8823636a397524f95; Rust baseline
is 80400370c7898459f7e7c24642caba9af31379d1. Existing dirty changes and cline-probe
were preserved. No Rust/Cargo/dependency changed; no commit/push/publication occurred.

Updated every architecture owner with dated proposed refinements and corrected active
requirement/interface/protocol/integrity wording. DEC-090/091, REQ-UI-033, ACC-UX-08,
and F-103..F-109 record the outcome-first UI, shared action/event contracts, durable
identity/context, spent-aware reservations, exact worker launch keys, semantic progress,
provider workspace boundaries, required-hook/policy failure, package raw-byte integrity,
safe retention and evidence/status limits. TODO AX-396/397 and the source trail/test
plan now include those acceptance checks. Per-file findings and remaining gates:
[complete audit](research%20docs/architecture-final-audit-2026-09-30.md).

Checks: 42 Markdown files, 1,164 local links/fragments, zero broken links; 261 unique
requirement definitions, 90 decision definitions, 41 source definitions and 144 task
IDs; closed fenced blocks; contiguous full original read ranges and final file hashes;
`git diff --check` passed. Rechecked official Git COPYING, RFC 9110 Retry-After, and
the selected MCP initialized lifecycle. These are documentation checks only. No
product tests/builds, platform/live-provider acceptance or usability study were run.
No task status was promoted. Finite brief/memory bounds, strategy thresholds, portable
audit proof, production update trust, platform/remote confinement and any edge network
listener remain explicit implementation/release gates. Next safe action: select the
owning bounded TODO task and implement/verify its current reconciled contract.

## Architecture evolution review (2026-09-30)

Reconciled the proposed evolution against the existing architecture and the prior
line-by-line audit of ARCH/00-README.md..33 (14,028 lines, recorded below in the historical
reconciliation). This pass reread the affected owners and checked cross-document
identifiers/status/traceability. The architecture now indexes proposed ARCH/05-MODULARITY.md..36;
adds DEC-083..089, REQ-WORK/STOP/CTX/UI/PROTO and new tasks AX-395..400; and records
pinned, source-limited references SRC-037..041 with TODO → owning ARCH → docs/research/SOURCE-TRACEABILITY.md →
immutable upstream URL navigation. All six tasks remain proposed.

The UI contract keeps three pane slots while adding Pair/Mission Control/Review/Explore
content presets, Needs You, Proof Pack and recovery views. DEC-085 supersedes only the
fixed center content of DEC-066; chat remains the default Pair view and available as a
center tab. The existing CMP-repo-intel and ProgressSignature/StopDecision owners were
extended instead of duplicated. AG-UI stays disabled/local-only pending a separate
remote authentication/encryption decision; AutoGPT Platform is pattern-only and no
PolyForm Shield code is copied. planning-with-files Markdown remains noncanonical.

No source or dependency changed, no task status was promoted, and no product tests or
builds were run. `git diff --check` passed. A local link/fragment scan passed for all 37
changed Markdown files; requirement, decision, TODO, and source ledgers have 260, 88,
144, and 41 unique definitions respectively. The UI audit found and resolved the `/mode`
command collision by reserving `/workspace` for layout presets; F3 remains the palette
entry. These checks validate documentation structure only, not behavior or acceptance.

## TODO-to-source audit (2026-09-30)

Checked out documentation HEAD: `42466aa410d50d5135195ba8823636a397524f95`.
The source baseline is `80400370c7898459f7e7c24642caba9af31379d1`; comparing
`23d4ce8..HEAD` shows the only Rust/Cargo source delta is the AX-370 Guard/approval
change, and comparing `8040037..HEAD` shows no Rust/Cargo delta. The previous source
baseline notes have been corrected in TODO and the current source-traceability/design
headers; older dated review entries remain historical snapshots.

Cross-checked all 138 TODO IDs (46 `implemented`, 92 `proposed`, none `verified` or
`accepted`) against their owning ARCH/source-trail links. All 46 implemented rows
have a resolvable local source-trail anchor; all 186 local file links in
`docs/research/SOURCE-TRACEABILITY.md` resolve after URL decoding. The AX-370 implementation
and regression-test source are present at HEAD; its remaining run-scoped acknowledgement,
expiry/revocation, and `ACC-P1-02` acceptance are still open. Source presence and test
file presence do not establish passing behavior. The cited AX-370 test/clippy results
are historical implementation-wave evidence, not rerun here. No task status was
promoted. This is a source-presence/status audit, not a behavioral test or platform
acceptance audit; no product tests or builds were run.

Updated source-baseline statements in `TODO.md`, `docs/research/SOURCE-TRACEABILITY.md`, `ARCH/core/TOOLS.md`, `ARCH/security/GUARD.md`,
`ARCH/security/AUDIT.md`, `ARCH/product/ANALYTICS.md`, `ARCH/product/DISCOVERY-AND-EXTENSIONS.md`, `ARCH/security/SECURITY-MODEL.md`, `docs/history/architecture/audits/2026-09-30-review.md`, and `ARCH/product/MEMORY.md`. Clarified that
`ARCH/security/SECURITY-MODEL.md` T-12 describes proposed update-security controls, not the implementation
status of every control in HorizonCode. The pre-existing dirty `cline-probe` submodule
was left untouched.

## Final architecture and ledger consistency pass (2026-09-30)

Checked the current documentation checkout at `42466aa410d50d5135195ba8823636a397524f95`.
The complete active architecture set is `ARCH/00-README.md`–`ARCH/product/MEMORY.md`, with `ARCH/17`
intentionally unused; the prior three-pass line-by-line architecture review is
recorded in the historical reconciliation below. This final pass checked the latest
extension-market, Connector, Doctor, Extensions UI, skill/tool-discovery, and task
ledger changes against their owning requirements, decisions, architecture sections,
research notes, acceptance rows, TODO entries, and source-trail anchors.

Fixed the missing `u-cl-provider` anchor used by AX-363 and updated TODO's stale
architecture-finding range from F-91 to F-98. Replaced the outdated claim of a single
immediate implementation priority with the current tracked workstreams and an explicit
instruction to follow task dependencies; no task status or implementation claim
changed. The cross-product `REQ-SKILL-015` mentioned here is defined in the sibling
AgentCowork repository, not in this HorizonCode requirement registry.

Checks: 87 active Markdown files and 1,194 local Markdown links/fragments, zero broken;
all 184 GitHub repository/file links in `ARCH/` returned success (one transient timeout
passed on retry); 138 TODO task IDs are unique, and every row has an architecture owner
and source-trail link; 82 decision IDs, 36 source IDs, 50 acceptance IDs, and all
locally defined requirement references resolve. `F-01..F-98` is now consistent across
docs/history/architecture/audits/2026-09-30-review.md and TODO. `git diff --check` passes. No product tests, builds, or live provider
calls were run. The pre-existing dirty `cline-probe` submodule was left untouched.
At the time of that architecture consistency pass, the reviewed source baseline was
`23d4ce8`; the AX-370 source fix was committed later at `8040037`. See the TODO-to-source
audit above for the current baseline. That earlier pass changed documentation only.

## Shared extension marketplace and Connector design (2026-09-30)

Completed the HorizonCode-first design pass for a shared catalog later consumable by
AgentCowork. `DEC-082`, `REQ-PLUGIN-005/006`, `CMP-extension-catalog`, `ARCH/product/DISCOVERY-AND-EXTENSIONS.md`, and
`research docs/extension-marketplace-review.md` define four counted listing families:
Connectors/services, standalone MCP servers, Skills, and Plugins. The target is at
least 500 unique, source-resolvable entries for broad release and 1,000 as the
expansion target. The planning mix is 200/150/100/50 respectively; mirrors, versions,
provider offers, and plugin-contained components cannot inflate counts. This is a
target only; there is no catalog snapshot or 500-entry evidence.

The catalog uses the MCP Registry read API, documented Codex/Agent Plugins and
Claude/Grok Git marketplace adapters, Agent Skills sources, and curated service
records. It stores source/compatibility evidence but does not execute packages. A
Connector is a service identity; provider offers, product-local account Connections,
capabilities, grants, and MCP/runtime implementation remain distinct. Credentials,
installations, and grants are not shared between HorizonCode and AgentCowork.
`/connectors` and `/apps` join the shared Extensions surface; the user-facing default
is a simple Connect action with provider/scopes behind details.

Added proposed requirements `REQ-PLUGIN-005/006`, decisions `DEC-082`, acceptance
plans `ACC-MARKET-01`/`ACC-CONNECTION-01`, source trail `U-EXTENSION-ECOSYSTEM`, and
delivery tasks `AX-393`/`AX-394`; expanded `AX-378`. Updated the owning UI, command,
architecture, verification, research index, and test-plan documents. Official Codex,
Claude Code, Grok Build, MCP Registry, and Agent Skills sources were checked on
2026-09-30. Their formats and hosted catalogs differ; no closed directory or OAuth
reuse is assumed, and no upstream implementation or schema was copied.

Cross-product review found the deployment boundary needed to be explicit: both
products must consume one Shared Extension Market snapshot/API, not independently
crawl sources. Updated `ARCH/03-SYSTEM-ARCHITECTURE.md`, `docs/history/architecture/decisions/DECISIONS-THROUGH-095.md` DEC-082, `ARCH/product/DISCOVERY-AND-EXTENSIONS.md`, `ARCH/acceptance/ACCEPTANCE-MATRIX.md`, `docs/research/SOURCE-TRACEABILITY.md`,
and AX-393 to define a controlled ingestion/review pipeline publishing versioned JSON
over a public read-only endpoint; v1 has no package hosting, public upload, accounts,
or ratings. This remains proposed design: no market service, catalog snapshot, or count
evidence exists. AgentCowork has now been updated with proposed DEC-067,
REQ-SKILL-015, `TASK-ECO-004`, and `TC-071`; its requirements-to-matrix-to-task
and document-reference gates pass.

Validation: `git diff --check` passed. Cross-document identifiers, owners, acceptance
IDs, source links, and TODO anchors were reviewed. AgentCowork `git diff --check`,
`node scripts/check-doc-refs.mjs`, and `node scripts/check-doc-sync.mjs` passed (347
requirements, 347 matrix rows, 185 referenced task IDs). No product tests or catalog
sync were run; the 500/1,000 objective is not implemented or verified. Pre-existing
worktree changes were preserved. Both documentation phases are complete; DEC-082 and
DEC-067 remain proposed pending their respective review processes.

## README product overview (2026-09-30)

Rewrote `README.md` as a future-facing product overview: HorizonCode as an all-purpose
coding agent, the Explorer/chat/tasks workspace, direct coding and Managed Runs, and
user-chosen model routes and integrations. Kept one development-status note at the top.
No screenshot or mock image is included; no app screen is being represented as built.
Linked the overview to its vision, requirements, UI, security, and contributor docs.
This is copy and documentation work; no TODO delivery status changed and no tests ran.

## iCode interaction-pattern adoption (2026-09-30)

Recorded the approved iCode interaction adaptations in the owning architecture and
delivery documents. `DEC-081` and `REQ-UI-030` make action-entry parity, draft-preserving
inline suggestions, task-first default rows, in-place background status, and progressive
Extensions detail explicit while preserving HorizonCode's three-pane layout and Guard
policy. `ARCH/product/UI.md` specifies composer/file-opening distinctions, responsive path lookup,
focused task/session/diff/rollback details, and simple Installed rows; `ARCH/product/COMMANDS-AND-SETTINGS.md` specifies
one command/action catalog; `ARCH/core/CONTEXT.md` assigns path scanning to the single repository-
intelligence owner and retains the independently chosen 50% compaction threshold with a
separate reserve; `ARCH/integrations/PROTOCOLS.md` specifies ordered tool events with bounded backpressure and
gap recovery; `ARCH/product/DISCOVERY-AND-EXTENSIONS.md` keeps extension setup staged. `ACC-UX-06`, `ACC-H1-06`, and
`research docs/tests.md` record observable interaction, event-ordering, stale-result,
focus, resize, accessibility, and failure-path checks.

Updated TODO rows AX-009, AX-108, AX-207, AX-208, AX-335, AX-369, AX-373, AX-374,
AX-375, AX-378, and AX-388 with their owning architecture links, acceptance evidence, and
source-traceability anchors. Added
`SRC-035` and the pinned iCode file map `U-ICODE-TUI`/`U-ICODE-COMPACTION` for commit
`bb45692104bc1d26882729e90fc145e3a114e066`, plus `research docs/icode-ui-review.md`.
The review is limited to the named source files; it corrects the Explore-profile and
project-file-opener premise and records explicit non-adoptions. All affected work remains
proposed; this was documentation and design work only, with no code or product tests.

Validation: checked the edited contracts and TODO links against their owning sections;
all pinned iCode file paths exist in the local checkout at that commit. The local Markdown
target scan found no missing targets in the edited set, and `git diff --check` passed.
Unrelated pre-existing worktree changes were preserved. Next safe action: keep these
contracts proposed until their owning implementation and acceptance evidence are delivered.

## Architecture audit and storage-source correction (2026-09-30)

Read all 33 active `ARCH/*.md` documents (`ARCH/00-README.md`–`ARCH/product/MEMORY.md`, with `ARCH/17`
intentionally absent), through their final lines: 14,028 physical lines in the
pre-audit document snapshot. Reconciled requirements, decisions, source trails, TODO owners,
and the relevant Doctor, Extensions, skills, deferred-tool-search, LSP, and compaction
acceptance contracts. Upstream behavior remains pattern evidence only; no code was
copied and no product tests or benchmarks were run.

Corrected `ARCH/core/SESSION-AND-THREADS.md`: the segmented `EventLog` implementation is not yet
integrated into session/run stores, while `CommitSink`/`DurabilityProfile` are already
used by the flat-file session store and by the segmented EventLog. The durability
types live in `horizoncode-eventlog/src/durability.rs`; the session integration is in
`horizoncode-session/src/store.rs`. This is primitive reuse, not segmented-store
migration or proof of the full multi-hour durability contract.

The 2026-09-29 paragraph below that described the AX-350/AX-352 gate as circular is
superseded. AX-352 has an independently runnable primitive acceptance `ACC-P1-13A`;
integrated segment/reserve acceptance `ACC-P1-13` remains owned by AX-350. The durable
store task order is AX-309, then AX-311/AX-312, then AX-350 session migration and
Run-store integration. Updated the AX-350 TODO row and implementation entry point to
state these dependencies and that AX-311 is a prerequisite, not a co-delivered task.
The existing `AX-311` dependency on AX-309/AX-104 remains authoritative.

Web source review confirmed Codex's deferred tool search over bounded metadata and
OpenCode's grouped LSP operations; Grok's pinned research records the Extensions,
Doctor, skill-collision, and guided-creation patterns. The tool's direct open of the
pinned Grok pages and OpenCode LSP page returned cache misses; immutable source URLs
and focused prior checkout/review notes remain in `docs/research/SOURCE-TRACEABILITY.md` and `research docs/`.
Codex's pinned file was directly available. These source limits are retained; this
pass does not claim a fresh full-repository review.

No source code or TODO status was changed; the AX-350 TODO description and dependency
notes were clarified. `git diff --check` passed, and a local Markdown-link scan checked
85 Markdown files with zero missing local targets. The repository's documented
`scripts/check-doc-refs.mjs` is absent from this checkout, so that project-specific
checker could not run. No product tests or benchmarks were run. Preserve the
pre-existing dirty worktree and user data. Next safe action: keep AX-309/311/312/350
proposed until their owner-specific evidence is recorded.

## Context compaction threshold decision (2026-09-30)

The automatic compaction trigger is now designed as configurable
`compaction.auto_threshold`, default `0.5` of the active provider route's resolved
model context window. The separate output/buffer/estimation-uncertainty reserve stays
as the hard fit guard; disabling automatic compaction does not disable explicit
manual compaction. Updated `REQ-CTX-002`, `DEC-006`, `ARCH/core/CONTEXT.md`, `ARCH/core/COMPRESSION.md`,
`ACC-P1-07`, and TODO rows AX-203/AX-390. These remain proposed design: the current
Rust crates contain compaction event types but no context compaction engine or
automatic trigger. No tests were run; `git diff --check` passed for the edited docs.

## Upstream pattern adoption traceability (2026-09-30)

Audited TODO-to-architecture ownership for Grok Doctor/shared Extensions, Grok skill
collision and guided creation, Codex deferred tool search, and OpenCode's grouped LSP
tool. TODO rows AX-392, AX-378, AX-373, and AX-375 describe the proposed implementation
and link their owning architecture docs plus `docs/research/SOURCE-TRACEABILITY.md` source-trail anchors. Added
direct immutable upstream file links in the owning LLD/decision sections (`docs/history/architecture/decisions/DECISIONS-THROUGH-095.md`,
`ARCH/core/CONTEXT.md`, `ARCH/core/TOOLS.md`, `ARCH/product/DISCOVERY-AND-EXTENSIONS.md`); pinned URLs, exact files, license/provenance, and
pattern-only dispositions remain indexed in `docs/research/SOURCE-LEDGER.md`, `docs/research/SOURCE-TRACEABILITY.md`, and `research docs/`.
No upstream code was copied. These tasks remain proposed; `git diff --check` passed.

## Historical checkpoint — architecture audit continuation (2026-09-29)

### AX-370 guard fix (2026-09-29)

Implemented the critical guard fix (T0) across `horizoncode-guard`, the tool approval
seam, and CLI posture, with regression tests and the corresponding architecture/task
updates. No delivery row was promoted to `verified`.

- `evaluate_pairs` now resolves find-last-wins within the user/global base
  (`base_rules`: global layers + saved rules) and within each project/agent/session
  restriction layer, then composes with `deny > ask > allow`, so a lower-trust
  `allow` can no longer lower an upstream `ask`/`deny` (F-70).
- `names_the_area_deliberately` takes the requested action and searches only the
  user/global base: an `fs.read` grant no longer exempts `fs.write`/`fs.delete`/
  `fs.move`, and a project/agent/session rule can never waive the external-directory
  floor (F-69, `DEC-024`, `DEC-025`).
- `GuardMode::Yolo` now auto-resolves only eligible, rule-raised asks (`fs.*`,
  `exec.run`, `todo`, `question`). Network egress, MCP/extension installs,
  external-directory reaches, unmatched asks, explicit denials, and catastrophic
  entries remain governing (F-84, `DEC-073`).
- The approval seam carries that eligibility (`ApprovalRequest.reduced_approval_eligible`
  and `Guard::ask_is_eligible`); `AutoApproveResolver` refuses an ineligible ask, and
  the CLI no longer installs a blanket auto-approver under `--yolo` — only ineligible
  asks reach a resolver, where an interactive terminal prompts and every other posture
  denies.
- `Guard::from_rules` installs its rules as the user/global base layer; tests that
  used the session layer as the primary policy now use the base layer, and the
  policy-fingerprint fixture reflects the global layer plus its deny ceiling.
- Regression coverage added in `crates/horizoncode-guard/tests/guard.rs`; the tools
  permission helper was aligned in `crates/horizoncode-tools/tests/permission.rs`.

Evidence: `cargo test -p horizoncode-guard` (50 passed); `cargo test --workspace
--no-fail-fast` (62 suites, 519 passed, 0 failed); `cargo clippy --workspace
--all-targets -- -D warnings` clean. `cargo fmt -p horizoncode-guard -p
horizoncode-tools --check` fails on formatting deltas in unchanged sections of touched
crates and other existing files; no broad reformat was applied. No acceptance record
(`ACC-P1-02`) exists, so AX-370 remains `implemented`.

Independent verification on 2026-09-29 reran `cargo test --workspace --no-fail-fast`
and `cargo clippy --workspace --all-targets -- -D warnings`; both passed. The test suite
first failed inside the restricted sandbox because mock-provider tests bind loopback
listeners, then passed when rerun with approval outside it. `cargo fmt -p
horizoncode-guard -p horizoncode-tools --check` fails on formatting deltas in unchanged
sections of touched crates and other existing files; no broad reformat was applied.
`git diff --check` passes.

### Product priority at the requirements-revision checkpoint

The active product direction now prioritizes AX-362 (complete pinned OpenCode/Cline
provider and auth inventories), followed by AX-363 (HorizonCode-owned route parity and
the reviewed upstream-change candidate pipeline); AX-387 direct-turn coding and its
paired quick-task evaluation proceeds alongside. A provider blocker means full parity
is incomplete. These tasks do not claim implementation. AX-350/AX-311 remain necessary
for durable managed Runs after their acceptance/dependency cycle is resolved.

Source review confirms T1 integration has not started: `SessionStore` still reads and
writes `<id>.jsonl`; the segmented event-log core, AX-352 session durability seam, and
DEC-058 storage defaults are prerequisites already present. AX-350 remains proposed;
AX-311 remains proposed and depends on AX-309/AX-104; AX-379 remains proposed and
depends on the versioned store migration. Historical assessment that the TODO gate was
circular is superseded by the 2026-09-30 correction at the top of this file:
`ACC-P1-13A` is the independent AX-352 primitive gate, while integrated segment/reserve
acceptance `ACC-P1-13` belongs to AX-350. AX-311 also depends on AX-309, which remains
proposed. Follow the corrected dependency order before integrated migration, then
AX-379.

### Architecture consistency pass (2026-09-29)

A cross-document identifier/ownership review of all 33 `ARCH/` files was run and its
findings fixed. No requirement, source baseline, or delivery status changed; the
reviewed Rust source baseline remains `23d4ce8` and no Rust file was touched.

- Added `DEC-073` (reduced-approval posture is a bounded, run-scoped grant) and
  replaced the incorrect `DEC-040` citations in `ARCH/02-REQUIREMENTS.md`, `ARCH/security/GUARD.md`, `ARCH/security/SECURITY-MODEL.md`, and
  `docs/history/architecture/audits/2026-09-30-review.md` (`F-43`, `F-84`); `ARCH/acceptance/ACCEPTANCE-MATRIX.md` `ACC-P1-02`, `ARCH/product/COMMANDS-AND-SETTINGS.md`, `docs/research/SOURCE-TRACEABILITY.md` `AX-370`,
  and the `TODO.md` `AX-370` row now cite it.
- Added the `CMP-verifier` row to the `ARCH/03-SYSTEM-ARCHITECTURE.md` component table; removed the undefined
  `CMP-adapter` references in `ARCH/product/COMMANDS-AND-SETTINGS.md`/`ARCH/product/AGENT-MESSAGING.md` and recorded that adapter edges are
  mechanics of `CMP-execution-host`/`CMP-acp`.
- Defined `ACC-PROV-OC-GO` in `ARCH/acceptance/ACCEPTANCE-MATRIX.md` (live OpenCode Go route acceptance, owner
  `AX-364`) and mapped `REQ-PROV-009/010` to it.
- Added row-ID namespace notes in `ARCH/security/SECURITY-MODEL.md`, `ARCH/acceptance/ACCEPTANCE-MATRIX.md`, `docs/history/architecture/audits/2026-09-30-review.md` and qualified the
  ambiguous `F-02`/`G-05` citations; replaced the dangling `EDGE-038` reference with
  `ARCH/security/SECURITY-MODEL.md` `G-06`.
- Added the missing `UPDATE` area code and corrected the `AX-*` convention examples
  in `ARCH/00-README.md`; fixed the malformed `AX-12` license-gate citation in `docs/research/SOURCE-LEDGER.md` to
  `AX-001`/`AX-010`.
- Added one-way decision citations in `ARCH/core/CONTEXT.md`, `11`, `15`, `19`, `20`, `21`, `25`,
  `27`, and `30` for `DEC-007`, `013`, `015`, `017`, `019`, `032`, `033`, `041`,
  `061`, `068`, and `071`.
- Added the two missing anchors (`u-cx-egress`, `u-cx-retry-usage`) that `TODO.md`
  linked to in `docs/research/SOURCE-TRACEABILITY.md`.

Checks for this pass: an identifier-resolution scan over `ARCH/*.md` (all
`REQ`/`DEC`/`SRC`/`RR`/`ACC` references resolve; `DEC-028` remains the only
intentionally unassigned ID; no `DEC-*` is still cited only inside `docs/history/architecture/decisions/DECISIONS-THROUGH-095.md`), a
local-link and `git diff --check` scan of the edited files, and a `TODO.md` AX-370
traceability update. No product tests, benchmarks, provider calls, or UI runs were
performed. The documentation changes are uncommitted.

### Product README follow-up (2026-09-29)

Added a root `README.md` describing the intended HorizonCode product from the approved
vision and architecture: durable repository runs, task planning, a terminal workspace,
governed effects, model/protocol choice, and independent verification. The opening
notice says the project is in development; there are no install instructions or claims
that target capabilities are already released. The README was informed by a review of
Hermes Agent, LibreChat, CowAgent, DeepSeek Reasonix, grok-build, OpenHands, Aider, and
OpenCode README structures, using product framing and navigation patterns without
copying their implementation or promotional claims. `AGENTS.md` now explicitly allows
the root README and defines its role. `git diff --check` passes and each local README
link resolves. No product tests were run.

### Checkout and handoff status

Checked-out Git revision: `1bdea2689316904d2cc6ef884202f6c35a272a48`.
The reviewed Rust source baseline remains `23d4ce8`; the current working diff contains
the architecture consistency pass plus the AX-370 source fix in
`crates/horizoncode-guard`. `TODO.md` contains 130 unique task IDs: 46 `implemented`
and 84 `proposed`, with an owning architecture link and source-traceability link on
every row; none is `verified` or `accepted`. `TODO.md` is authoritative for the next
implementation task: AX-370 is fixed at the source level with regression tests, and
the next planned implementation wave follows AX-309, then AX-311/AX-312, then AX-350;
AX-379 follows the versioned store migration. Its 2026-09-29 claim of a circular
AX-350/AX-352 acceptance gate is superseded by the 2026-09-30 correction at the top of
this file. See the current handoff above before selecting work. Older implementation queues later
in this file are historical and must not override the ledger.

Latest checks: `git diff --check` passes; local links across `ARCH/*.md`, `TODO.md`,
`CURRENT_RUN.md`, `README.md`, and `AGENTS.md` resolve (901 checked, 0 broken); the
guard fix passed `cargo test --workspace --no-fail-fast` (62 suites, 519 passed,
0 failed) and `cargo clippy --workspace --all-targets -- -D warnings` is clean.
`cargo fmt -p horizoncode-guard -p horizoncode-tools --check` fails on formatting
deltas in unchanged sections of touched crates and other existing files (including
`ticket.rs` and `tools/src/builtin/*`); no broad reformat was applied. No benchmarks,
provider calls, or UI runs were performed. The docs and source changes are uncommitted.
Preserve existing untracked workspace data.

The current-turn follow-up checked corrections to the Codex comparison against the
local source snapshot labeled `67a709665ac7b50311b93e32612c9a8281684787`, with pinned
GitHub links spot-checked for the redirect executor, retry helper, and migration flow.
The local snapshot itself has no `.git` metadata, so it cannot independently prove its
origin commit; do not report this as a complete Codex checkout or a full-file review.
The Codex findings and corrections are in `ARCH/01-VISION.md`, `ARCH/02-REQUIREMENTS.md`, `ARCH/core/SESSION-AND-THREADS.md`, `ARCH/core/AGENT-LOOP.md`,
`ARCH/core/PROVIDERS.md`, `ARCH/security/GUARD.md`, `ARCH/security/SECURITY-MODEL.md`, `ARCH/acceptance/ACCEPTANCE-MATRIX.md`, `docs/history/architecture/audits/2026-09-30-review.md` F-95/F-98, `docs/research/CORE-AGENT-CROSSWALK.md`,
`docs/research/SOURCE-TRACEABILITY.md`, `TODO.md`, and `research docs/codex.md`. Retry safety now has explicit
finite attempt/deadline/backoff limits, terminal-error preservation, and replay
idempotency in `REQ-PROV-015`; usage fields are unknown rather than zero when absent.
The credential-endpoint environment-variable observation is recorded with the caveat
that it does not by itself prove an egress bypass. The claimed zero-peer scheduler
novelty was rejected because the existing DeepCode note describes durable scheduling;
exact equivalence against LongHorizon Harness remains unverified.

### Architecture/source reconciliation at the 2026-09-30 checkpoint

The complete active architecture set (`ARCH/00-README.md–33`, with 17 intentionally unused) was
read in three non-overlapping line-by-line reviews and reconciled with requirements,
decisions, TODO, and source trails. Current fixes align the Thread model across
security, tools, orchestration, analytics, search, UI, artifact, update, and app-server
contracts; make provider fallback/cache semantics explicit; tighten the optional
unconfined grant boundary; and align the P1 acceptance matrix at 21 rows. Findings
F-84..F-90 add the broad legacy Yolo Ask conversion, pinned-provider fallback exposure,
malformed owner-lease acceptance, conservative unknown provider-capability semantics,
model-facing compacted-history retrieval, immutable adapter-build provenance, and
canonical question-batch arbitration. F-91 / DEC-071 / REQ-PROV-014 add an optional
provider-owned quota-observation store and read-only refresh path after the KiloCode /
CodeBurn audit; observations can drive visible warnings only, never routing or local
budget reservations. AX-386 records the LLD, settings/command surface, failure cases,
and test contract across ARCH/02-REQUIREMENTS.md, 04, 11, 20, 27, 29, TODO, and tests.md. The
LongHorizon-Harness launch-crash acceptance names reservation/run-directory and
process-launch/receipt windows. OpenHands SDK review found no new completion/effect
model to adopt; its replay measurements remain a separate storage microbenchmark.
F-23's overbroad secret-scanning guarantee was corrected to distinguish broker-held
credentials from arbitrary workspace text. AX-370, AX-384, AX-359, AX-360, and AX-328
own the implementation and acceptance work.

This section remains a documentation/source audit; the AX-370 guard fix is the first
implementation wave on top of it. The source-confirmed guard defects — the
external-path action mismatch (F-69), flattened rule-layer precedence (F-70), and the
broad legacy Yolo Ask conversion (F-84) — are fixed at the source level with
regression tests (see the AX-370 section above); their `ACC-P1-02` acceptance record
and the run-scoped approval acknowledgement/expiry/revocation remain open. Source
separately preserves global/project deny ceilings; do not report those denies as
bypassed. Earlier QA counts belong to earlier commits and are not current evidence;
rerun the owning checks against the current revision.

### Claude Code and subagent memory follow-up

Two requested bounded research passes completed (`/root/claude_public_arch` and
`/root/claude_mem_injection`). The Claude Code pass used official
public docs plus the README/license of `codeaashu/claude-code` solely to establish its
stated leak/unlicensed provenance; its `src/` and backup branch were not opened. No
leaked implementation was used. Official docs say ordinary subagents start with fresh
context, do not inherit parent transcript or auto-memory, and can receive explicit
skills and their own bounded profile memory. The claude-mem pass inspected its pinned
Apache-2.0 hook manifest plus public docs and historical/open issue reports; the hook
implementation and full source tree were not read. Its duplicate-memory reports are
version/setup-specific evidence, not proof that the defect persists at the reviewed
release.

The resulting target contract is recorded in `DEC-072`, `REQ-MEM-005..007`, and
`ARCH/core/CONTEXT.md`, `ARCH/execution/ORCHESTRATION.md`, `ARCH/core/CONFIG.md`, `ARCH/product/COMMANDS-AND-SETTINGS.md`, `ARCH/product/MEMORY.md`: bounded per-child
`ContextPacket`; `fork=none` and profile memory off by default; no implicit parent or
sibling context; optional profile namespace in the existing memory store; explicit
policy/capability intersection; accepted/current/task-relevant records pinned to the
child `ContextEpoch`; candidate-only child writes; and visible source/usage disclosure.
The official `SubagentStart` hook can append context but cannot block spawn; it avoids
re-injection while the copy remains present and re-adds it after compaction. This is
recorded as adapter delivery behavior, while controller authorization and persisted
dispatch/epoch digests remain authoritative.
`AX-371`, `docs/research/SOURCE-TRACEABILITY.md`, and `research docs/tests.md` now include the source limits,
implementation trail, and fan-out/isolation/recovery acceptance cases. No product
tests or upstream tests ran in this docs-only pass.

Current documentation checks: `git diff --check` passes. A local Markdown-link scan
checked 122 Markdown files; all 11 unresolved paths are in the pre-existing generated
notices/archive documents, while the changed architecture/research documents resolve.
No implementation tests or live-provider calls were run.

### Upstream source-review extension — scoped results

The current-turn OpenCode/Codex/Cline follow-up used per-file coverage ledgers where
available. **None was an exhaustive all-source-file read.** OpenCode pin
`083ed266e058dc3d2d1b377ff5540859d79de110`: 3,630 files in the declared source
extension inventory, 14 fully read, 10 partial, 3,606 unread. Codex local source
checkout `13a966fc652d1037c7ee93a15b2bdfa0610748ae` (not the research note's broader
pin): 6,291 source-like files, 9 fully read (786 lines), several partial, remaining
files unread. Cline pin `787ad1b077d8b697892dc3bfcd42e7c65b88789e`: 3,521 source/config
candidates, 16 fully read (4,118 lines), 8 partial, 3,497 unread. Exact citations are
in their research notes. Two detailed per-file ledgers are temporary audit artifacts,
not durable project files. No upstream tests, live UIs, or providers were run.

The user renewed the request for exhaustive source review across more named
repositories. Targeted read-only reviews are now complete for DeerFlow, DeepSeek Harness,
Superset, and OpenHands Agent Canvas. Durable ledgers are under
`research docs/source-audit-coverage/`; none was an exhaustive repository read. DeerFlow
selected 2,700 code files (10 full, 14 partial, 2,676 unread); DeepSeek Harness selected
5,484 (2 full, 9 partial, 5,473 not fully read); Superset selected 8,569 (8 full, 3
partial, 8,558 unread); OpenHands Agent Canvas selected 2,094 (4 full, 6 partial,
2,084 unread). The OpenHands UI checkout is not its runtime or benchmark suite. Codex
has no durable per-file ledger yet. Earlier notes for other named repositories are
focused research, not whole-tree reads. Claude Code has no published implementation
tree; official docs and the third-party `cc-haha` source remain separate evidence
classes. Do not claim all requested codebases were fully read.

The 2026-09-29 OpenHands software-agent-sdk pass read 8 files fully, 8 partially,
and inventoried 1,771 unread tracked paths; it is targeted, not exhaustive. The Kilo/
CodeBurn quota pass is also a focused source-path audit, not full-tree coverage. A
newer OpenHands/OpenHands Canvas pass pinned `94e156a8c7b7a468d7c60bda3a38757bfbfd4a79`
and inventoried 2,115 candidates: 27 full, 13 partial, 2,075 unread. It confirms that
frontend history paging, websocket resend, and optimistic state are UI catch-up
projections, not durable task/effect recovery; partial history remains visibly
incomplete, and browser localStorage API keys are not an acceptable secret-broker
pattern. No tests or benchmarks ran. The separately requested Ruflo/Nanobot/Hermes and
ECC/wshobson passes produced bounded focused reports after inventory startup. They are
now recorded in the source-audit coverage README and crosswalk, but none is exhaustive:
Ruflo 5/2,993 full/unread; Nanobot 4/21/1,224 full/partial/unread; Hermes
4/13/12,359; ECC 6/8/2,279; and wshobson 2/10/1,156. Their findings are limited to
the cited swarm, subagent, delivery, registry, catalog, hook, adapter, and installer
paths; no upstream tests or runtime commands ran. Do not generalize them to their full
repositories.

The 2026-09-29 crosswalk added three scoped architecture changes: optional current-Thread
history retrieval after compaction via the shared Thread index (AX-385); exact local
adapter build and negotiated-capability provenance with reconnect renegotiation (AX-318);
and an explicit question-call batch suspension state (AX-380). DeepSeek Harness's
route-specific in-history system-prompt replacement semantics are modeled as a
conformance-gated optimization; full prompt replacement remains the safe default. No
universal cache mechanism was added. Superset/OpenHands did not justify a new orchestration
subsystem; their current designs already map to AX-359/AX-318. Their event-array update
path only adds a large-history/streaming stress fixture to AX-374, not a reproduced bug.

Aider was refreshed against upstream `main` commit
`5dc9490bb35f9729ef2c95d00a19ccd30c26339c` (2026-05-22): its 691 tracked paths and
38 changed `aider/` paths since v0.86.0 were inventoried; the model, repo-map,
repository, command and base-coder deltas were inspected. The note distinguishes this
branch from the still-latest published v0.86.0 release and does not claim a full-tree
read. Claude Code has no published implementation tree; its official docs and the
third-party `cc-haha` workspace remain separate evidence classes.

The source review corrected Cline's nonexistent desktop/JetBrains source paths,
disabled-at-pin Agenda behavior, Team dependency edges, completion semantics, and the
limits of its subprocess/web-fetch boundaries (`F-83`). OpenCode research records
title-only/bounded search, update confirmation/signature differences, Go route diversity,
compaction loss, V2 deferred recovery limits, and strict local capability-validation
requirements (`F-87`). Codex research records non-atomic Goal/rollout persistence,
unbounded client event-queue behavior, message-board receipt semantics, and its
thread-scoped rather than task-verified goal model. Re-run documentation QA after any
further report-driven edits.

### Architecture-document audit fixes (2026-09-29)

The report-driven documentation fixes align `ARCH/acceptance/ACCEPTANCE-MATRIX.md` at 21 P1 rows and map
`REQ-GUARD-006` / `REQ-CTX-008` to acceptance evidence; scope deterministic-input
rules to L1/L2 while explicitly recording real-host L3–L5 dependencies; and reconcile
`CMP-config` instruction discovery with `CMP-context` assembly. Security assets now
separate Thread history from Run/task/evidence state. The context estimator is labeled
rough and requires an uncertainty reserve; compression forbids abstraction of code
and tool observations. `docs/research/SOURCE-LEDGER.md` treats repo-map ranking as proposed synthesis until
pinned provenance exists and removes the claim that a subprocess alone resolves LGPL
obligations. `ARCH/integrations/PROTOCOLS.md` now names owners, safe interim behavior, and release gates for
its unresolved protocol questions. `docs/history/architecture/audits/2026-09-30-review.md` finding coverage and the source-baseline
labels were reconciled to the checked-out revision. These are documentation changes;
no product code was inspected or changed and no product tests were run. The open
protocol decisions remain release-gated as recorded in `ARCH/integrations/PROTOCOLS.md`.

The currently confirmed target layout is **Explorer/editor on the left, chat fixed in
the center, and verified Tasks on the right**. All three regions resize through
splitters. Explorer and Tasks may swap side slots; chat cannot move, be replaced, or
close while active. Opening a file expands the Explorer/editor dock group. No permanent
bottom pane or second editor sidebar is planned. Earlier sections below that describe a
right-side editor or a movable chat are superseded historical notes, not current
requirements. `ARCH/product/UI.md`, `DEC-066`, `REQ-UI-018`, `AX-374`, and the UI test plan own the
current contract. This is proposed design; the TUI is absent from source.

Distribution decision: **HorizonCode** is the product name; `hzcode` is the canonical
install/package/CLI name, and installed `horizoncode` is a compatibility alias to the
same app/state. New installation instructions use only `hzcode`. Dated npm and
crates.io exact-name lookups returned 404 on 2026-09-28; this does not reserve either
name. `ARCH/integrations/DISTRIBUTION-AND-UPDATES.md`, update requirements, and AX-366 describe the target migration. The
checked-out binary is still named `horizoncode`; no code or package rename was made.

Conversation identity decision: `DEC-069` defines a durable HorizonCode `ThreadId`
plus separately recorded `WorkerExecution` incarnations. Protocol/provider `Session`
IDs are external bindings, not duplicate HorizonCode conversation IDs. The existing
`horizoncode-session` crate and session-named v1 files remain the persistence/migration
source; legacy IDs are preserved, and hash-chained event bytes must never be rewritten
in place. `AX-379` owns API/schema migration and compatibility acceptance. This target
model is not implemented in source.

### Thread identity contract check (2026-09-28)

The contract is now explicit in `REQ-SESS-008` and `ACC-P1-15`: a new process or
adapter execution under the same Attempt may continue the same Thread; a changed
task strategy creates a new Attempt and Thread. External ACP/provider Session IDs
remain adapter bindings, Thread parent/child links stay separate from the Task DAG,
and only verifier evidence can pass a Task. The permission bridge and run-to-turn
link examples now distinguish local `ThreadId` from external/control Session IDs.
`AX-379` owns the versioned, idempotent migration; `AX-359` owns durable live
execution and restart reconciliation. These are proposed target contracts, not
implemented code.

### Durable agent questions (2026-09-28)

Added `REQ-ORCH-010` / `REQ-UI-021`, `ACC-P1-16`, and `AX-380` for durable selectable
questions from an agent, including exact requester identity, typed answers, safe
pause/resume, idempotent receipts, accessible central-chat UI, and resumable headless
`NEEDS_INPUT`. Source inspection found a basic callback/options question tool, but no
answer validation, durable broker, TUI, or headless continuation. The added tests
cover malformed answers, crash/reconnect, adapter capability gaps, UI focus/draft
preservation, and the rule that answers never grant authority. This remains proposed;
the current tool does not meet that contract.

The first long-horizon harness review also identified a race invariant worth making
explicit: asynchronous evaluator output is stale if user input, cancellation, spec,
policy, task graph, or workspace revision changes before commit. Added
`REQ-ORCH-011` / `ACC-P1-17` / `AX-381`; controller revalidation must happen after the
inference and immediately before any state transition or dispatch. DeerFlow is the
pinned source pattern, but its LLM goal evaluator is not HorizonCode acceptance
evidence.

### External long-horizon and agent ecosystem review (2026-09-28)

Pinned read-only source reviews have been recorded in `research docs/` for DeerFlow,
LongHorizon-Harness, DeepSeek-Harness, DeepCode, Plandex, Ruflo, Kilo, ECC, Hermes,
Superset, CodeBurn, Nanobot, and wshobson/agents. Their reports distinguish observed
code from README claims and call out process-local state, stale quota caches, simulated
swarm paths, and benchmark scope. OpenHuman, OpenHands/SDK, AiderDesk,
DeepSeek-Reasonix, and tool candidates also have a source review. OpenChamber's active
timeline/sidebar search paths are now traced at its pinned revision; they search
materialized user-message/title records and do not establish full-history coverage.
The detailed note records exact source/test paths and the distinction from
HorizonCode's proposed FTS design. Superset's launch, binding, hook, transcript,
child-roster, and resume paths received a second pass; its resume-claim crash gap is
now an explicit HorizonCode recovery test. No source was copied, and no peer tests or
benchmarks were executed. Existing architecture already owns the key
budget, mailbox, terminal, usage, and provider-cache boundaries; test additions specify
their failure cases rather than creating duplicate systems.

Follow-up reviews added Kilo's quota/cache, soft warning, Agent Manager, and question
flows at its pinned revision, and found no local atomic budget authority in those
surfaces. The Warp/oh-my-pi and `ARCH/00-README.md..08` reports are now complete. Repository
reviews are focused path traces, not claims that every file in each large upstream
repository has been read.

Prior documentation QA snapshot (before the 2026-09-29 reconciliation edits): 66 Markdown files under `ARCH/` and
`research docs/` checked; 901 repository-local links and heading/HTML fragments pass
after URL decoding (`THIRD-PARTY-NOTICES.md` is excluded because SPDX identifiers are
labels); `git diff --check` passes; all 125 TODO task IDs are unique and each source
trail link/anchor resolves. The only root Markdown files are `AGENTS.md`,
`CURRENT_RUN.md`, `THIRD-PARTY-NOTICES.md`, and `TODO.md`. No build, automated test,
benchmark, provider call, or UI run was performed. `.code-intelligence/` and
`uipics/` remain untouched untracked user data. No staging or commit has occurred.

Review continued against checkout HEAD `a158cb4c24fae7118e373e637573678c05e90c42`
(docs only) and unchanged Rust source baseline `23d4ce8`. The OpenCode
UI/API comparison remains pinned to
`083ed266e058dc3d2d1b377ff5540859d79de110`. The old notes below are evidence/history;
they do not override newer user decisions or architecture records.

Continued the line-by-line architecture review at HEAD
`cbba87b9c6a33fc6faac31cdef9b38d2aae67243` against the unchanged Rust source baseline
`23d4ce8`. OpenCode TUI source was inspected at
`083ed266e058dc3d2d1b377ff5540859d79de110` for idle/home, prompt submission, active
tool/generation states, permission and question surfaces, child navigation, recent
history hydration, theme/preferences, and reconnect behavior. This was a source trace;
the peer TUI was not launched, and no usability or runtime-recovery claim is made.

The UI research note and `ARCH/product/UI.md`, `docs/research/CORE-AGENT-CROSSWALK.md`, `docs/research/SOURCE-TRACEABILITY.md`, and `research docs/tests.md`
now capture the key boundaries: OpenCode renders only a recent 100-message window in
this route; that window is not whole-history search. Its UI omits a delivery mode while
the inspected V2 contract defaults to steering and also supports queueing. SSE
reconnect alone is not durable replay. HorizonCode search, queue receipts, explicit
status, and replay/gap behavior remain proposed.

Added `F-69..F-73` and `AX-370..AX-373` for the current-source external-path guard
action mismatch, policy-precedence verification, local-MAC versus portable audit
proof/effect recovery, memory-consent decisions, and implemented-versus-proposed
tool/skill capability reporting. The source-confirmed guard defect is critical and is
now the first bounded implementation item in `TODO.md`; it has **not** been fixed in
this docs pass. Added source-trail rows and tests-plan coverage. Clarified `AX-110` as
config-level discovery/digest-checked activation, while model-visible skill activation
is still absent. Pinned the Codex Goal/ThreadManager references to commit
`368e5eae2f006a70a91dddfdc96e6b2d11498f81` and kept the broad map and app-server README
at their distinct source pins.

Changed architecture/research/TODO/handoff Markdown only. No build, test, benchmark,
provider call, or UI execution was run. The following documentation QA passed on an
earlier snapshot: `git diff --check`, repository-local links/fragments, TODO task IDs
and source-trail anchors, and root Markdown layout. It does not cover subsequent edits;
the active review must rerun it on the final snapshot. The
generated third-party notices file was excluded from link parsing because its SPDX
license identifiers are labels, not repository-relative documents. Preserve the
untracked `.code-intelligence/` and `uipics/` user data; no staging or commit has
occurred. The earlier identity discussion is superseded by `DEC-069`: the target is
one durable `ThreadId` plus `WorkerExecution`. The
Codex/OpenCode mappings remain evidence-based comparisons, not a claim that HorizonCode
is implemented or superior.

## OpenCode provider and update architecture continuation (2026-09-28)

Earlier provider/update handoff details (superseded in status by the section above). HEAD is
`cbba87b9c6a33fc6faac31cdef9b38d2aae67243`; the reviewed Rust source baseline remains
`23d4ce8`, with no Rust-source or manifest difference between that baseline and HEAD.
The OpenCode source review is pinned to
`083ed266e058dc3d2d1b377ff5540859d79de110`; live official provider/Go documentation
and public catalog endpoints were checked on 2026-09-28.

A credential-free GET of `https://models.opencode.ai/api.json` at 16:30:47 UTC returned
225 provider IDs and 8,253 model records (5,214,814 bytes, SHA-256
`a03260a354cb2a97672eb582a94050a945762ad01890a368e69c4769755d69df`). A separate
credential-free GET of `https://opencode.ai/zen/go/v1/models` at 16:30:48 UTC returned
43 Go model IDs (3,569 bytes, SHA-256
`1464472961052aa41d454cce5c953d5fc3c68d7a2e19e95f7a6f41901d3b178a`). The global
feed's `opencode-go` provider record contained 33 models; official Go docs mapped only
30 current IDs to inference paths. Therefore Go model-directory presence is discovery
only: route path/protocol is local versioned data, and unknown IDs stay unavailable.
The current documented temporary zero-price examples are dynamic and still require a
Go account; the live inference acceptance waits for an implemented connector and a
user-authorized credential configured locally. No key was used or requested.

The inventory also distinguishes the 51 named provider-doc sections plus Custom, 32
pinned core integration modules, and supplemental auth plugins. It records each
provider ID in the dated global snapshot and all 51 documented setup/auth methods;
for additional IDs with no primary auth evidence the required state is explicitly
`unknown`, not an inferred API key or OAuth route. Remote env/package metadata is not
an auth/adapter authority. Exact endpoints, drift, sources, and method gaps are in
`research docs/opencode-provider-inventory.md`, `ARCH/core/PROVIDERS.md`, `docs/research/SOURCE-TRACEABILITY.md`, and TODO
`AX-360..364`.

`ARCH/integrations/DISTRIBUTION-AND-UPDATES.md` specifies one signed update service for startup
notification, `/upgrade`, and `hzcode upgrade`; settings, TUF bootstrap, install
ownership, safe maintenance, rollback, repair/uninstall behavior, and release scripts.
Notification is non-blocking; installation needs explicit operator consent and never
interrupts active work. Installer/update code is absent and no TUF client is selected.

The update CLI `--channel` override is one-command only; persistent channel selection
belongs to `/settings updates`. The helper that applies a staged update is a restricted
mode of the same signed HorizonCode binary, preserving `DEC-002`'s one-shipped-binary
contract. OpenCode Go docs say external coding agents should identify themselves and
send a stable session header, but HorizonCode is not in the current validated-client
list; any eventual test can establish local conformance only.

This pass changed architecture, provenance, test-plan, TODO, source-traceability, and
handoff Markdown only. Static documentation QA passed for 24 changed/new Markdown
files: local link targets, whitespace, newlines, exact inventory counts (225 provider
IDs, 51 documented auth/setup entries, 43 Go IDs, 30 documented routes), and
`git diff --check`. No build, code tests, benchmark, or live model-inference request
was run. No task status was promoted to implemented or verified. Preserve the
untracked user data in `.code-intelligence/` and `uipics/`; no staging or commit has
occurred. Next safe action: continue the overall architecture audit, beginning from
`TODO.md` and the owning `ARCH/` LLD; implementation of AX-360..366 remains proposed.
The follow-up concurrency review added `DEC-062` and `REQ-HORIZON-029`: system-wide
run admission, direct-turn/worker execution admission, and update maintenance must
share the durable `SupervisorControlStream` and cross-process lock. `ARCH/execution/ORCHESTRATION.md`, `ARCH/execution/LONG-HORIZON.md`,
`ARCH/integrations/DISTRIBUTION-AND-UPDATES.md`, `TODO.md`, and the update tests now describe that fence and its crash
reconciliation; it is still proposed and no updater/controller implementation exists.
The 2026-09-29 docs-only link/status QA for the current snapshot is recorded in the
active handoff at the top of this file. Continue the upstream source audit and reconcile
any resulting architecture changes before treating the whole-architecture review as
finished.
Updated 2026-09-28 (second pass, same day). This handoff covers the **first
implementation wave** plus the closure of `F-66`/`AX-355` — the permission-seam defect
the first wave's test run exposed. It supersedes the documentation-only audit handoff
of 2026-09-27, which remains the record of what was read and why.

## Source-traceability correction (2026-09-28)

The user identified that owner-design links did not tell an implementing agent which
local code and exact upstream files to inspect. `docs/research/SOURCE-TRACEABILITY.md` now
records local entry points/tests and pinned peer-file references by design owner,
including explicit absent implementations and source-coverage limits. Every AX row
in `TODO.md` links to its first owner's source trail; additional owner links in that
row still apply. `AGENTS.md`, `ARCH/00-README.md` and `docs/research/CORE-AGENT-CROSSWALK.md` require reading the trail and
rechecking paths at HEAD. This is documentation/navigation work only; it did not
change or verify runtime behavior. The trail was first recorded at documentation
commit `692eba1`; the latest reviewed source baseline is `23d4ce8`. The final
Codex/OpenCode comparison reviewed architecture status and official workflow/protocol
references, but did not run tests or promote any task to verified. Confirm the
checked-out revision again before implementation.

## Latest architecture comparison (2026-09-28)

The supplied OpenCode revision `083ed266e058dc3d2d1b377ff5540859d79de110` was
fetched and checked at the Session schema, Task tool, process-local background-job
registry, and V2 Session design. The source crosswalk now distinguishes durable
conversation identity from live execution. This paragraph records the earlier
comparison conclusion and is superseded by `DEC-069`: HorizonCode's target uses one
durable `ThreadId`, with `WorkerExecution` for each live process/adapter incarnation;
external ACP/provider session IDs are bindings only. The current implementation has
only the source-backed foundations listed in `docs/research/SOURCE-TRACEABILITY.md`. `AX-359` owns execution
reconciliation and `AX-379` owns the migration to the Thread domain model.
Architecture, source-traceability, OpenCode research, TODO and test-plan records were
updated. These remain proposed design requirements; no runtime code or test was run
and no implementation/verification status changed. The exact peer sources and
comparison limits are recorded in `docs/research/CORE-AGENT-CROSSWALK.md` and `research docs/opencode.md`.

The current doc-review changes are not a replacement for the remaining implementation
queue. Before coding, use `TODO.md` for the authoritative dependency order and recheck
the exact source revision; this handoff's older implementation-wave sections below
are historical context, not a live claim that those rows remain open.

## Prior implementation-wave goal (historical)

Deliver the first implementation wave that makes the session log and the audit chain
honest under inspection and crash, in dependency order, without adding a second
persistence path, permission system, or scheduler:

1. typed session enumeration that never reports a store failure as "no sessions" (`AX-353`);
2. read-only session paths that never truncate or repair a log (`AX-351`, read-only slice);
3. a commit durability profile with namespace durability and typed refusal (`AX-352`);
4. audit read/write integrity: read-only verification, access evidence outside the chain, typed head and enumeration failures, an OS-backed writer lock, explicit repair (`AX-346`, integrity slice);
5. the determinism and crash infrastructure the acceptance records require (`AX-122`, determinism/crash slice);
6. the permission seam: a read-only call is not denied by its own re-assertion, and one call records exactly one policy decision (`AX-355`, closing `F-66`).
7. provider-response admission owns tool-call id uniqueness, so a malformed batch is refused
   instead of surfacing as a per-call denial (`AX-356`).
8. the pinned audit genesis constants are reconciled with the labels they claim, with the
   pre-rename derivation recorded and refused (`AX-354`, closing `F-65`).
9. the first breadth slice: one configuration crate owns the discovery walk, the shared
   JSONC reader, the typed settings merge with provenance, and hierarchical `AGENTS.md`
   discovery; one `state_root()` resolves the documented `~/.horizoncode` fallback
   (`AX-008`, fixing `F-67` as `AX-357`).
10. the shipped third-party notices bundle: generated from the pinned dependency
   graph, embedded in the binary for `--credits`, and gated so a dependency change
   cannot ship stale attribution (`AX-010`).
11. the finite storage ceilings the segmented logs and artifact store need before
   they can be coded: published as `DEC-058`, carried by the config schema with
   lower-only validation, and exposed as typed limit views (`AX-348`, decision slice).
12. the shared segmented event-log core both session and run history need: canonical
   envelope, bounded segments with seals, committed head, streaming replay, version
   refusal, and preserved uncommitted tails (`AX-358`, the `AX-309` slice 1).
13. the typed slash-command registry and composer-reference parser: strict parse with
   suggestions, registry-generated help/search/completion, no fall-through to model
   text, and literal preservation for non-references (`AX-344`).
14. owner/mode/no-follow state-path hygiene applied through one shared primitive
   across the stores and the guard's policy config (`AX-126`).
15. skill discovery and progressive disclosure with a real frontmatter parser,
   metadata-only catalog, digest-verified activation, and a `/skills` surface
   (`AX-110`, first slice).
16. the artifact store's byte-admission core: bounded streaming writes, namespace
   quotas, digest-verified reads, and typed unavailable states (`AX-348`, first slice).

**Breadth program (user directive, 2026-09-28).** After the wave above, the user asked to
plan, check, and build the remaining proposed rows in dependency order without stopping
between them. The order is: `AX-008` (layered config + `AGENTS.md` discovery — the
prerequisite for nearly every other row) → `AX-010` (notices/provenance bundle) →
`AX-348` (bounded content-addressed artifacts, and publishing the finite
`session.log.*`/`run.log.*` defaults) → `AX-009`/`AX-344`/`AX-343` (TUI shell, typed
slash commands and `@` references, theme/accessibility settings) → `AX-110` (skill
discovery) → `AX-106`/`AX-332` (MCP client + schema filtering) →
`AX-112`/`AX-340`/`AX-341`/`AX-342`/`AX-304` (ACP client, agent directory, profiles,
per-agent model/quota visibility, peer pools) → `AX-320`/`AX-201`/`AX-202`/`AX-319`
(revision-bound repo index, tree-sitter map, LSP, context projection) → `AX-207`
(checkpoints/rewind, needs `AX-348`) → the governance and evidence rows
(`AX-119`, `AX-120`, `AX-121`, `AX-123`, `AX-124`, `AX-126`, `AX-307`, `AX-318`,
`AX-321`, `AX-329`, `AX-336`). Reconnaissance for the plan confirmed that none of these
subsystems exist today: no TUI/LSP/tree-sitter/WASM/MCP dependency, no artifact store,
no settings module, no notices bundle. The breadth vocabulary exists only as guard
policy words (`mcp.call`, `skill.install`).

## Historical checkpoint — where implementation stood on 2026-09-28

Starting point: Git `53a2654`/`b677443` (docs-only, Rust unchanged since `1c7a1c6`).
The Rust source has now been changed; the exact revision is the commit this handoff
travels with.

**Second pass — `AX-355` / `F-66` (permission seam).**

Three separate defects produced one symptom. Root-caused by reading the call path and
reproducing each cause independently:

1. `GuardPermissionGate::pairs` (`crates/horizoncode-tools/src/guard_gate.rs`) mapped a
   request naming **no resource** to an empty pair set, while the guard normalizes such a
   request to the wildcard and scopes its ticket to `**`. A `list` call with `{}` was
   therefore **allowed** by the rule and then **denied** by its own re-assertion, because
   the grant covered nothing. Grant bookkeeping now records the wildcard.
2. The call identity was only `(call_id, action)`. A tool-call id is a correlation token
   unique among the calls of one response, so an id reused later is a *new* call. Identity
   is now `(turn, call id, action)`: a reused id in a later turn is decided on its own
   merits, while a replay **inside** its issuing turn is still refused.
3. `AuditedGate::authorize` recorded a `policy_decision` for *every* pass, so the
   single-use spend appeared in the chain as a second outcome for the same call. The trait
   now has `consume` for the effect boundary, which spends the grant and decides nothing;
   one call records exactly one decision and the spend is ticket lifecycle.

`PermissionRequest` gained a `turn_id`; `PermissionGate::consume` defaults to `authorize`,
so a stateless gate is unchanged. The mock provider now mints a unique call id per
response, as a real provider does — that fixture defect is recorded as `AX-356` rather
than absorbed. Contracts updated in `ARCH/security/GUARD.md` §Tickets + Interfaces and `ARCH/core/TOOLS.md`
§Permission assertion; `F-66` rewritten in `docs/history/architecture/audits/2026-09-30-review.md` as closed with its residual.

**Second pass, continued — `AX-356` (the residual of `F-66`).**

`ARCH/core/AGENT-LOOP.md` §Admit batch already required it: "on the completed response, validate IDs, schemas,
sizes, ordering metadata … a batch-level defect (invalid encoding/schema, **duplicate ID**,
oversized response, or stale workspace fence) dispatches none of its calls". Admission did not
implement the ID check, so a provider that reused a correlation id was refused deeper down, by
the gate, as if the *call* were being replayed. The runner now remembers the ids it has admitted
in a turn and refuses a response that repeats one, before the assistant message is appended or
anything is dispatched; the turn ends failed with a reason naming the id, recorded as a
`protocol` failure class (a new `FailureClass` value, additive). Tests: two unit tests over the
admission helper and an end-to-end test that drives a real duplicate-id response and asserts both
the typed refusal and that only one tool result exists. **Not covered:** an id reused across
turns of one session is still admitted; that history scan belongs with the run stream (`AX-309`).

**Second pass, continued — `AX-354` (`F-65`), the last red test.**

The bounded preimage spike answered the finding's question with exact matches: the pinned
constants are `blake3("agentx/audit/genesis/v1")` and `blake3("agentx/audit/roots/genesis/v1")`.
Neither side was a random typo — the constants were correctly derived from the *pre-rename*
labels, and commit `58569f4` renamed the labels without re-deriving them. The label is
authoritative: it is the format's documented identity and what a verifier recomputes. Both
constants are now `blake3(<current label>)`, the original assertions stay, and a new test in
each module pins the pre-rename value and refuses it
(`the_pre_rename_genesis_is_not_accepted_as_genesis`). The migration consequence is recorded
in `ARCH/security/AUDIT.md` §Genesis derivation: the pre-rename derivation was never shipped, and a store
that starts from it is refused at sequence 0 rather than accepted under a compatibility rule.
With this, the workspace has **no failing test**.

**Third pass — breadth program, first slice: `AX-008` (`horizoncode-config`).**

A new `horizoncode-config` crate is the one owner of discovery and validation
(`ARCH/core/CONFIG.md`): the layer walk (global first, then project outer-to-nearest, with a path
that exists but is unusable reported as an issue instead of being skipped), the JSONC
reader the guard now consumes instead of keeping a second copy, the typed settings
merge with per-key provenance (`SettingView`: requested/effective values, scope,
source, contributors, shadowed sources, validation error, apply boundary, schema
version, effective digest), and hierarchical `AGENTS.md` discovery with
canonical-path and digest dedupe, exact rendering, and the fail-closed unreadable
case. The first schema group is the small set this slice's consumers need
(`instructions.extra`, two accessibility flags, the terminal-bell preference); the
other `ARCH/core/CONFIG.md` groups register in the same registry as their owners land, so no
second settings engine appears. Building it surfaced `F-67`: all five state-root call
sites documented `~/.horizoncode` and implemented `$HOME`. `horizoncode_config::
state_root()` is now the one resolver (`$HORIZONCODE_HOME` → `~/.horizoncode` → `.`),
all three branches are unit-tested, and the session, audit, analytics, guard, and CLI
roots consume it (`AX-357`). Not covered here: injecting the rendered instruction
source into the assembled context is `AX-319`.

**Fourth pass — `AX-010` (third-party notices and the provenance bundle).**

`horizoncode notices generate` renders `THIRD-PARTY-NOTICES.md` from `Cargo.lock`
and the license/notice files of the package sources present for the generating
platform; the bundle is embedded in the binary, so `horizoncode --credits` prints
exactly what ships and works with no HOME, store, or provider. The gate is not byte
equality — which sources are unpacked varies by machine — but three rules: the
bundle's named lockfile digest must match `Cargo.lock`, every locked package must
appear and nothing else may, and every locally present package must be in the
resolved table with its shipped license expression and all of its notice texts. A
locally built package can therefore never be hidden in the unresolved section or
lose its notice. `horizoncode notices check` exposes the gate to a release script
(exit `1` when stale). The dependency allowlist (`G-1`) and `Adapt`/`Vendor`
provenance records are still open and named in the row.

**Fifth pass — `AX-348` decision slice: finite storage ceilings.**

`ARCH/core/SESSION-AND-THREADS.md` and `ARCH/product/ARTIFACTS.md` both said the numeric defaults were a pre-implementation
decision, and `AX-309`/`AX-350` are gated on them, so this pass publishes them as
`DEC-058`: per-record, per-segment, per-stream, control-reserve, replay-batch,
artifact inline/object/namespace, decoded media, retention, and orphan-grace values,
each finite and nonzero, with the segment numbers mirroring the audit store's
4,096-entry / 8 MiB precedent. The same decision records the durability posture:
Linux is the reference backend, macOS carries a declared contract, and Windows
cannot sync a directory through the standard API, so `run_durable` is **refused
typed** there rather than silently weakened. The `horizoncode-config` schema now
carries all 22 keys with the values as defaults *and* compiled ceilings, so a
configuration or project may lower a limit but never raise it and zero is rejected;
typed `LogLimits`/`ArtifactLimits` views are what the storage work will consume.
The artifact store itself (`BlobRef`, quota reservation, GC) is the next step in
`AX-348`, not this one.

**Sixth pass — `AX-358`: the shared segmented event-log core.**

`DEC-055` says session and run history use one bounded segmented framing, so
`horizoncode-eventlog` now implements it: the canonical envelope with a `blake3`
digest over a versioned domain and recursively sorted keys (`DEC-059`), segments
that rotate on the `DEC-058` ceilings, seals synchronized before a successor
segment receives a record, an atomically replaced committed head with typed
absent/malformed/unreadable states, an OS-backed writer lock, streaming replay
with a per-line ceiling, refusal of a newer schema version before any segment is
decoded, and bytes beyond the head preserved and reported rather than truncated.
The commit order is pinned by tests: a line is durable before the head
acknowledges it. The suite is 14 unit tests plus 12 log cases (round trip,
rotation by events and bytes, oversized and stream refusals, restart resume, torn
and complete tails, a corrupt sealed segment, the version refusal, a second
writer, an empty log, and a refused durability backend). The session store still
uses its single-file layout until the `AX-350` migration; run payloads and
projections are `AX-309`; tail recovery is `AX-311`. The notices gate did its job
on the dependency change: the regenerated bundle is part of this commit.

**Seventh pass — `AX-344`: the typed command registry and reference parser.**

`horizoncode-commands` now owns the registry both the headless surface and the
future TUI consume. Only commands whose owner exists are registered (`/help`,
`/commands`, `/usage`, `/insights`, each naming its owner and effect class);
unknown names return typed errors with nearest-name suggestions, malformed
arguments name the grammar, unavailable owners and unsupported surfaces are
typed refusals, and help, search, and completion are generated from the same
registry. The CLI's ad-hoc `/usage`-only parser is gone; `/usage` now takes no
arguments (the old `--all` was accepted and ignored, which is exactly the
plausible-no-op the architecture forbids). The composer-reference parser
recognizes the six namespaces, keeps bare `@name`, email, escaped, and
unknown-delimiter text literal, diagnoses unknown namespaces without blocking,
and supports quoted paths; parsing is never resolution and grants no authority.
Black-box tests prove the safety property: an unknown command exits `4` with
suggestions and prints no answer with no provider configured.

**Eighth pass — `AX-126`: state-path hygiene.**

One implementation (`horizoncode-config::state_fs`) now answers *is this path a
symlink, and is this file owner-only*: the stores and discovery walks refuse a
final-component symlink instead of following it, set `0600`/`0700` on what they
create, and the event log additionally refuses a lock or head whose mode grants
group/other access. It is applied to config layers, instruction files (a
repo-planted `AGENTS.md` link can no longer pull a host file into context — a
real exfiltration path), the session store, the analytics ledger, the event log,
the guard's policy config, and the audit store (which now consumes the shared
primitive instead of keeping its own copy). The residual is stated, not hidden:
Unix modes only, final component only, check/open TOCTOU, and no containment
claim — confinement remains `ARCH/security/SANDBOX.md`'s job.

**Ninth pass — `AX-110`: skill discovery and progressive disclosure.**

`horizoncode-config::skills` discovers `SKILL.md` (or a sibling `<name>.md`)
under the global `<state>/skills` directory and the project walk, parsing real
YAML frontmatter with `serde_yaml_ng` instead of a bespoke subset. Only `{name,
description, slash}` enter the catalog; the body is returned only by `activate`,
which re-reads the file, refuses a symlink, re-parses it, and verifies its
digest against the listing so a file swapped after listing is a typed mismatch.
A malformed skill is a diagnostic and never a silent omission, and a nearer
skill of the same name shadows an outer one with the shadowed location reported.
Content is returned verbatim as untrusted data. The headless surface gains
`/skills [list | show <name>]`, which prints metadata and never a body.
**Not covered:** the enable/disable/archive lifecycle, context injection and its
budget (`AX-319`), remote provenance/signing, and plugin contributions.

**Tenth pass — `AX-348`: the artifact store's byte-admission core.**

`horizoncode-artifact` implements the write/read half of `ARCH/product/ARTIFACTS.md`: `put` streams
from a reader, hashing and enforcing the `DEC-058` object and namespace ceilings
while it reads, so an over-cap payload is refused before it is buffered or
published; staging is exclusive and owner-only and publishes by digest, and an
existing digest path is re-verified rather than replaced. The per-namespace quota
ledger is durable, writes are idempotent by operation id with a typed conflict on
different bytes, and `read`/`stat`/`list` verify digest and length and return
typed missing/corrupt/unsupported/over-limit results. State paths go through the
shared hygiene primitive, so a link planted at an object, quota, lock, or
namespace directory is refused. The suite is 9 integration tests. What remains is
named in the row: leases and the owner graph, GC, decoders, export/import, the
physical reserve, and the session/run integration.

**Contract-first edits (architecture, before code).**

- `ARCH/core/SESSION-AND-THREADS.md`: exact `SessionListResult`/`SessionListEntry`/`SessionListIssue`
  payload, integrity derivation order, and the rule that only a store-level failure
  clears `enumeration_complete`; a new *Commit durability backend* section (profiles,
  the `sync_file`→`sync_dir`→acknowledge order, refusal conditions); a dated source-status
  block for the read-only split, stating that `recover(...)` is still unimplemented.
- `ARCH/integrations/PROTOCOLS.md`: session-listing result/error mapping, including that a
  `session/list` is not advertised until implemented and tested, and that no surface may
  substitute "no sessions" for a failed scan.
- `ARCH/security/AUDIT.md`: dated source-status block for the access stream, typed head,
  refusal on torn tails, and the OS-backed lock, with the remaining work named.
- `docs/history/architecture/audits/2026-09-30-review.md`: a dated implementation-pass section, plus **F-65**
  and **F-66** (see below).
- `research docs/tests.md`: the determinism/fault-injection/kill-matrix inventory, the
  quarantine policy, and the baseline failure list with what each test proves.

**Source changes.**

- `crates/horizoncode-types/src/clock.rs` (new): the injectable `Clock` trait,
  `SystemClock`, and `system_clock()`. The session store takes an `Arc<dyn Clock>`;
  other host-clock reads remain and are listed in `research docs/tests.md`.
- `crates/horizoncode-testkit` (new crate, dev-only): `TestClock`, `ScriptedFaults`/
  `FaultOp`, `StoreSnapshot` (byte-level before/after proof) and the kill-point
  environment contract. It is a dev-dependency of test suites and is never linked into
  the binary. `ARCH/03-SYSTEM-ARCHITECTURE.md`/`ARCH/core/SESSION-AND-THREADS.md` note the non-product crate in prose.
- `crates/horizoncode-session/src/durability.rs` (new): `DurabilityProfile`, the
  `CommitSink` seam (`supports_run_durable`, `sync_file`, `sync_dir`), `StdCommitSink`,
  `UnsupportedSink`.
- `crates/horizoncode-session/src/listing.rs` (new): the typed listing contract, the
  integrity enum, the issue kinds and payload, and `SessionListResult`.
- `crates/horizoncode-session/src/store.rs`: one pure `scan_log` behind
  `read_only`/`scan`/`inspect`/`list`; `list` returns `SessionListResult`; `inspect`
  reports a present-but-unreadable log; `latest` prefers a readable session; `create`/`append`
  commit through the durability profile; the torn-tail truncation moved behind the
  documented repairing path and no longer appends a repair event.
- `crates/horizoncode-session/src/error.rs`: `HeaderMissing`, `HeaderCorrupt`, `Durability`.
- `crates/horizoncode-audit/src/access.rs` (new): the independent access-evidence stream
  with its own sequence, `blake3` chain, ownership/mode checks and OS lock, plus a
  chain-verifying reader.
- `crates/horizoncode-audit/src/store.rs`: the writer lock is taken before head/segments
  are read and held for the store's lifetime; the head is read as
  `Absent | Present | Malformed | Unreadable`; a torn tail refuses an ordinary open;
  `AuditLog::repair_segment` is the explicit, byte-preserving repair with a linked
  recovery artifact; `segment_indices` returns typed errors; the head replace syncs its
  directory entry.
- `crates/horizoncode-audit/src/error.rs`: `HeadInvalid`, `HeadMissing`, `RecoveryRequired`,
  `StoreLocked`.
- `crates/horizoncode-cli`: `audit repair --segment --output`; access recording moved to
  the access stream and is required **before** any read; new exit code `7`
  ("the audit access record could not be written, so nothing was disclosed"), documented in
  `--help` and asserted against it.
- `Cargo.toml`: `rust-version` 1.88 → 1.89, because the OS-backed lock uses
  `std::fs::File::try_lock` and no process-lock dependency was added.

**Tests added or changed.**

- `horizoncode-session/tests/list.rs` (8), `tests/read_only.rs` (8),
  `tests/kill_matrix.rs` (1 test, 20 cycles × 5 crash points, real child processes).
- `horizoncode-audit/tests/integrity.rs` (10), `tests/writer_race.rs` (1 test, 20
  two-process cycles).
- Three existing tests were changed because they asserted the behaviour this pass removed:
  an audit census test that held two writers open at once; a census test that counted a
  read as chain coverage; and an exit-code test whose negative control relied on `verify`
  creating the store it reads.

## Checks run, at this revision

- `cargo fmt` for every file this pass wrote or changed: clean
  (`cargo fmt -p horizoncode-session -p horizoncode-audit -p horizoncode-cli -p
  horizoncode-types -p horizoncode-testkit`). The **workspace as a whole is not
  rustfmt-clean at the baseline**: `cargo fmt --all --check` reports 67 pre-existing
  diffs, including two inside crates this pass touched
  (`horizoncode-audit/src/redact.rs`, `horizoncode-cli/src/approval.rs`). Those
  reformats were deliberately reverted rather than bundled into this wave, so
  `cargo fmt --all --check` is a pre-existing failure here and must not be reported as
  a pass. Formatting the rest of the tree is its own cleanup task.
- `cargo clippy --workspace --all-targets -- -D warnings` — pass.
- `cargo test --workspace --no-fail-fast` — **508 passing, 0 failing** at this revision
  (the count grows with the new suites; the totals above are per-run, not additive across
  passes). The two `F-65` genesis failures measured at baseline `b677443` are fixed under
  `AX-354`; the two `F-66` failures measured earlier in the day went green under `AX-355`.
- `cargo test -p horizoncode-config` — 28 tests: 7 unit (JSONC edge cases, the three
  `state_root` branches), 4 discovery, 11 settings/provenance (including the
  `DEC-058` defaults table, the lower-only/zero refusals, and the typed limit views),
  6 instructions.
- `cargo test -p horizoncode-eventlog` — 26 tests: 14 unit (envelope canonicalization
  and verification, seal digest coverage, content digest, head states/versions) and 12
  log cases.
- `cargo test -p horizoncode-commands` — 18 tests over the registry (owners, uniqueness,
  documented arguments, refusals with suggestions, help/search/completion, surface
  gating) and the reference parser (namespaces, quoting, escapes, spans, diagnostics).
- `cargo test -p horizoncode-cli --test commands_cli` — 6 black-box cases: help/list
  without a provider, an unknown command exiting `4` with suggestions and no output, a
  malformed argument naming the grammar, and an unknown help topic.
- `cargo test -p horizoncode-cli` — includes the notices gate: 5 unit tests (the
  generator's lock parsing, rendering, determinism, and the four refused edits) and 3
  black-box tests (`--credits` with no configuration, `notices check`, `notices
  generate --output`).
- Baseline comparison was performed in a clean worktree at `b677443`; no test that passed
  there fails here.
- One unreproduced flake was observed once and not in 11 subsequent runs:
  `horizoncode-audit` `chain::a_recomputed_merkle_root_matches_the_signed_root_and_a_tampered_root_fails`.
  It is reported rather than dismissed, because a flake re-opens the requirement it covers
  (`ARCH/acceptance/ACCEPTANCE-MATRIX.md`).

## Known limitations of this pass

- `ACC-P1-12` is satisfied only in its read-only and enumeration halves. Explicit
  recovery (`AX-311`) and the index rebuild (`AX-350`) are still missing, so a torn tail is
  retained and reported rather than reconciled.
- `ACC-P1-13` is satisfied at the ordering and refusal level only. Real ENOSPC and power
  loss need an isolated fixture and explicit authorization; they are `insufficient
  evidence`, not passes. The advisory lock is per-host-filesystem and does not claim
  anything about NFS.
- `ACC-P1-04` is satisfied for read-command non-mutation, typed read failures, access
  receipts and writer locking. The global `audit_seq`/`segment_seq` migration, per-effect
  prepare/terminal reconciliation, device-key rotation and the tamper matrix remain
  `AX-346` remainder / `AX-311`.
- `run_durable` currently promises namespace durability of the **event log** only: no
  segmentation, no committed head file, and no physical control/recovery reserve yet.
- Fuzz targets, corpora and seeded-RNG coverage of provider retry jitter (`AX-122`
  remainder) are untouched.

## Decisions and gotchas

- `std::fs::File::try_lock` is the OS-backed lock, which is why the workspace MSRV moved to
  1.89 and why no new dependency (and no license-gate entry) was needed. `flock`-style
  advisory locks do not help across NFS; records must name the filesystem they were proven on.
- Holding the audit writer lock for the store's lifetime changes the contract for callers:
  two `AuditLog::open` calls on one store in one process are now a typed `StoreLocked`
  refusal, not a silently tolerated second writer.
- The access ledger holds its lock for the ledger's lifetime too, so a test that wants to
  read receipts while the CLI still runs must use `read_receipts(path)` (no lock) instead of
  opening an `AccessLedger`.
- `record_access` runs *before* every read, so an unwritable access stream makes `verify`,
  `replay` and `census` exit `7` with no output. That is deliberate: disclosure without a
  durable record of disclosure is the outcome the access ledger exists to prevent.
- The session `load()` path still repairs (truncates) a torn tail. It is now documented as
  the repairing path and is not reachable from any read-only surface, but it is **not** the
  `recover(session_id, expected_head, recovery_id)` the architecture specifies; that
  operation remains `AX-311`.
- `latest()` returns the newest **readable** session, so `--continue` no longer silently
  resumes a corrupt session.
- A tool-call id is a correlation token, not a globally unique identity: scoping grants to
  `(turn, call id, action)` is the fix that makes an id collision across turns stop denying
  legitimate calls, while in-turn replay protection is unchanged. Any test that builds two
  requests for "the same call" must give them the **same** turn, or it is testing two calls.

## Implementation queue from the prior coding wave (recheck TODO before acting)

0. Decide whether to format the rest of the tree in its own change, so the documented
   `cargo fmt --all --check` baseline becomes enforceable (`AX-121` builds the gate that
   would catch this). Every file this handoff's passes touched is `rustfmt`-clean; the
   workspace-wide check still reports the 67 pre-existing diffs.
1. Recheck the current checkout and `TODO.md`; this architecture review has a
   documentation diff, and the user-owned untracked `uipics/` and `.code-intelligence/`
   must remain untouched.
2. The **`AX-350` session migration** onto `horizoncode-eventlog`: bounded
   digest-linked segments, committed head, streaming replay, event-byte quota and the
   protected control reserve, keeping the read-only/typed-enumeration contract stable.
   The run-log half waits for `AX-309`/`AX-312`.
3. Then the rest of `AX-348` (reference leases and the owner graph, GC with the
   incomplete-scan abort, decoders, export/import, the physical reserve, and the
   session/run integration); then the TUI and settings surfaces
   (`AX-009`, `AX-343`), which consume the command registry and the `/skills`
   surface, then MCP (`AX-106`, `AX-332`) and the plugin/WASM rows. `AX-010`,
   `AX-344`'s headless half, and `AX-110`'s first slice are done; their remaining
   work is named in their rows, and `DEC-058`'s numbers may be revised only by a
   new decision.
4. `AX-311`: the effect journal, which unblocks `AX-351`'s recovery half and gives
   `ACC-P1-06`/`ACC-P1-12` their recovery evidence.
5. Then the rest of the controller chain (`AX-301`, `AX-310`, `AX-312`, `AX-313`,
   `AX-317`, `AX-337`, `AX-347`) before any multi-hour claim. The remaining breadth rows
   (agent directory and ACP client/pools, repo map/LSP, checkpoints/rewind,
   host probe, config recovery, peer adapters, delegation measurement,
   eval/perf, safety/config/provenance) follow in the dependency order recorded in
   §Active goal.

## Unresolved questions

- ~~Which side of F-65 is authoritative~~ Resolved 2026-09-28: the label is authoritative,
  the pre-rename derivation is refused, and the migration consequence is recorded in
  `ARCH/security/AUDIT.md` (`AX-354`).
- ~~Whether provider-response admission should reject a duplicate call id or repair it~~
  Resolved 2026-09-28: reject, before dispatch, with a typed reason (`AX-356`).
- How the `DEC-058` numbers perform on real workloads: they are published ceilings,
  deliberately conservative, and may be revised only by a new decision with a
  schema-version note. No benchmark has run yet.
- Whether `AX-350`'s session migration needs a format-version bump for the segmented
  layout: the session header currently names `CURRENT_FORMAT_VERSION`, and the new
  stream carries its own `CURRENT_SCHEMA_VERSION`; the migration must define how the
  two relate before it lands.
- The `DEC-058` `session.log.*`, `session.artifacts.*`, and `run.log.*` finite defaults
  are chosen. AX-348 implementation and workload/platform validation remain open and
  gate the relevant AX-309/350 slices.
- Whether the segment/head format (`AX-350`) needs a format version bump for the durability
  backend, given that no head file exists yet.

## Commits in this wave

One commit per coherent unit; the session and audit changes each touch a single
large file, so they are not split further for the sake of a commit boundary.

1. `docs: specify typed session enumeration, durability profile, and read-only boundary`
2. `feat(harness): add an injectable clock and a test-support crate`
3. `feat(session): add typed enumeration, byte-preserving reads, and a durability profile`
4. `fix(audit): record access outside the chain and refuse unverifiable store state`
5. `feat(cli): add the audit repair surface and the access-record exit code`
6. `docs: record the implementation pass, the measured findings, and the handoff`
7. `fix(guard): stop denying a read-only call at its own effect boundary`
8. `docs: close F-66 and record the admission gap it exposed`
9. `docs(review): mark the findings wave 1 actually addressed, and say what remains`
10. `fix(loop): refuse a provider batch that reuses a tool-call id`
11. `fix(audit): re-derive the genesis constants from the labels they claim`
12. `docs: close F-65 with the spike evidence and the migration note`
13. `feat(config): resolve layered settings, instruction discovery, and one state root`
14. `docs: record the config slice, F-67, and the unified state root`
15. `feat(cli): ship and gate the third-party notices bundle`
16. `docs: record the notices bundle and its gate`
17. `feat(config): carry the storage ceilings with lower-only validation`
18. `docs: publish the finite storage ceilings before the storage code`
19. `feat(eventlog): add the shared event envelope and commit durability backend`
20. `feat(eventlog): add bounded segments, a committed head, and streaming replay`
21. `docs: record the shared segmented event-log core`
22. `feat(commands): add the typed slash-command registry and reference parser`
23. `docs: record the command registry and the reference parser`
24. `feat(state): refuse symlinked state paths and keep owner-only modes`
25. `docs: record the state-path hygiene slice and its residual`
26. `feat(config): discover skills with digest-verified activation`
27. `docs: record the skill slice and what it does not cover`
28. `feat(artifact): add bounded content-addressed byte admission`
29. `docs: record the artifact slice and what remains`

Each commit is self-contained and builds; commit 2 carries the workspace manifest,
so its body notes the MSRV move that commit 4's OS-backed lock depends on.

## Worktree preservation

The user-owned untracked `uipics/` and `.code-intelligence/` are preserved and were not
staged. No remote was touched, nothing was pushed, published, or deployed, and no
production data was changed. Two temporary baseline worktrees were created under
temporary OpenCode checkout for the failure comparison; temporary clones were
removed after the review.

## Product requirements and provider-maintenance revision (2026-09-29)

Expanded the proposed product contract so HorizonCode targets both fast direct coding
and durable managed Runs. A normal natural-language turn may explain, inspect, edit,
check, review a diff, and respond to correction without creating a goal or accepting a
Run plan. `/goal` remains optional and is the path for work needing managed planning,
recovery, and independent verification. The new paired benchmark records quick tasks,
long-horizon outcomes, permissions, latency, cost/unknown usage, regressions, and
uncertainty; no competitor superiority claim is made.

Added architecture contracts for ordinary permission ergonomics, editor profiles and
external-edit coordination, Turn Diff versus Total Working Diff, safe stale-base
reconciliation, no auto-stage/commit, direct-turn cancellation and resource ceilings,
bounded inner checks, shell profiles (including PowerShell), trusted hooks, lightweight
direct-thread compaction, optional hybrid retrieval, progressive UI state, and
Thread/Turn analytics without fabricated Run IDs. PTY use is explicit and does not
claim confinement. The reviewer-proposed fixed `$0.50`/five-step defaults, universal
cache-neutral mode switching, automatic whitespace normalization, fuzzy `±5` patch
matching, and Git-shadow commits were not adopted because they are unmeasured or can
weaken existing contracts.

Provider scope now explicitly targets integration parity with every connector in the
pinned OpenCode and Cline matrices. Models.dev/catalog records remain inert metadata.
An upstream monitor is to detect source changes and prepare reviewable HorizonCode
adapter/fixture candidates with exact provenance and per-file license/notice review;
only the normal reviewed signed release can deliver those changes. Runtime download or
execution of changed upstream code remains disallowed. AX-362/363 remain proposed and
the existing Cline provider review is explicitly incomplete; no full provider parity
or new adapter is claimed.

Added proposed acceptance IDs `ACC-UX-01..05`, `ACC-EDITOR-01`, `ACC-EDIT-02`,
`ACC-REPO-01`, `ACC-PROV-SYNC-01`, and `ACC-ANALYTICS-01`; created delivery rows
AX-387..391 and source-traceability rows. `research docs/tests.md` now records the
paired competitor protocol and cross-feature edge cases. These are test plans, not
results. No code, schema, provider integration, benchmark, or acceptance record was
implemented or verified in this documentation pass; no tests were run.

The current checkout is Git `1bdea2689316904d2cc6ef884202f6c35a272a48` with the
pre-existing dirty worktree preserved. `git diff --check` and a local-link target scan
passed for the touched Markdown set. The next product-priority work is AX-362 (complete
pinned provider/auth matrices), then AX-363 (native connector parity and the reviewed
upstream-change candidate pipeline), with AX-387 direct-turn implementation/evaluation
proceeding alongside it. The existing AX-350/AX-311 storage path remains required for
managed Runs. Before implementation, inspect current source and exact upstream pins,
then update the selected task’s source trail and acceptance scope.

## Extensions-manager source check (2026-09-29)

Checked the Grok Build public source at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8`
for its Extensions modal and slash-command routing. The pinned pager has six category
tabs and 74 static built-ins; ACP commands and skills/workflows are additional dynamic
sources. Updated proposed `DEC-078`, `REQ-UI-020`, `ARCH/product/UI.md`, `ARCH/product/DISCOVERY-AND-EXTENSIONS.md`, and `ARCH/product/COMMANDS-AND-SETTINGS.md`
so all extension slash entry points share one category-aware overlay, while `/workflow`
continues to use the existing Run-controller boundary. Added source trail `U-GROK-EXTENSIONS`,
provenance `SRC-029`, and focused research note `research docs/grok-build-extensions.md`.
AX-378 remains proposed; these are architecture and acceptance-plan changes only. No
implementation or tests were run, and no upstream code was copied.

## Grok Build Doctor and adjacent-pattern review (2026-09-29)

Reviewed the pinned Grok Build Doctor command, model, probe, fix, renderer, and test
paths at `2bdd1d6a6369de0e8c68132ea4539e9abd9e14a8` (Apache-2.0). The review is
focused on Doctor and its direct paths; it is not a claim that every Grok Build source
line or subsystem was audited. Findings and adoption decisions are recorded in
`research docs/grok-build-doctor.md` and `docs/research/SOURCE-TRACEABILITY.md` `U-GROK-DOCTOR`.

Decided to adapt the shared typed diagnostics report, stable finding IDs, explicit
unknown/unavailable/error states, human plus versioned JSON output, and named repair
planning. HorizonCode's proposed implementation uses `CMP-diagnostics`, shared by
`hzcode doctor [--json]` and `/doctor`; routine reports are bounded local reads with no
provider/network call or mutation. Repairs require finite first-party IDs, current
target revalidation, exact preview, authenticated Guard confirmation, safe owned-service
application, audit, and postcondition verification. Grok's terminal-specific checks and
`--yes` option are excluded. Other candidates were checked against existing contracts:
typed slash dispatch and source-aware command registry are already specified; shared
extension routing is AX-378; concurrent `/btw` is deferred; eager loading of every
extension category and a second task registry are not adopted.

Added proposed `DEC-079`, `REQ-UI-029`, `CMP-diagnostics`, `ACC-DIAG-01`, and delivery
row `AX-392`; updated `ARCH/02-REQUIREMENTS.md`, `ARCH/03-SYSTEM-ARCHITECTURE.md`, `docs/history/architecture/decisions/DECISIONS-THROUGH-095.md`, `docs/research/SOURCE-LEDGER.md`, `ARCH/acceptance/ACCEPTANCE-MATRIX.md`, `ARCH/product/COMMANDS-AND-SETTINGS.md`,
`docs/research/SOURCE-TRACEABILITY.md`, `TODO.md`, `research docs/tests.md`, and the research index. No HorizonCode
implementation exists for Doctor, and no upstream code/tests/schema were copied or run.
No tests were run for this design pass.

## Focused Grok/Codex/OpenCode pattern adoption (2026-09-29)

Added proposed architecture only; no implementation status changed and no upstream
code, schemas, tests, or assets were copied. AX-392 Doctor and AX-378 shared
Extensions were already tracked and remain the owners. Skill collision-safe
source-qualified invocation is now `DEC-080` / `REQ-SKILL-005` under AX-373;
`/skill` stays manager navigation and `/create-skill` opens the existing Skills →
Create view under AX-378. Codex deferred tool discovery is specified in `ARCH/core/TOOLS.md`
under existing `REQ-CTX-010` and AX-373, using one registry with bounded search,
selected permission-filtered schemas, per-step pinning, and stale-call refusal.
OpenCode's grouped read-only LSP operations are assigned to the one `CMP-repo-intel`
owner under `REQ-CTX-012`, `ARCH/core/CONTEXT.md`, and AX-375.

Updated `ARCH/02-REQUIREMENTS.md`, `04`, `05`, `09`, `10`, `21`, `23`, `27`, `29`, `TODO.md`,
`research docs/tests.md`, the research index, and the focused note
`research docs/agent-tool-skill-command-adoption.md`. Pinned source records identify
the exact Grok skill guide, Codex `tool_search.rs`, and OpenCode `lsp.ts`, with
pattern-only dispositions and stated review limits. All affected TODO rows remain
`proposed`; acceptance contracts are `ACC-SKILL-01`, `ACC-TOOL-DISCOVERY-01`, and
`ACC-REPO-LSP-01`. No product tests or benchmark were run for this documentation-only
change. `git diff --check` passes; a local-link target check across the 14 edited
Markdown files found zero missing targets, and the new requirement/decision/source/
acceptance identifiers resolve in `ARCH/`. No Rust/source files were changed.
