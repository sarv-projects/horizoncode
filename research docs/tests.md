# HorizonCode test and benchmark plan

Status: **test plan plus scoped local evidence for AX-001, AX-003, AX-005, AX-124, AX-314, and AX-405**.
The architecture refactor itself did not run a test, build, benchmark, or acceptance
suite. On 2026-10-01, AX-003's direct runner response-admission implementation passed
the focused runner, tools, provider, and CLI tests and the serial full workspace test
command recorded in `CURRENT_RUN.md`. AX-005 now implements bounded provider response
body/SSE-line handling and bounded redacted error previews; its focused provider tests,
and serial full workspace suite pass at source revision
`fd7c2bdabcfca4cac58dcbedf4c627a49bfcb336`; workspace Clippy passed on an earlier
dirty source snapshot and was not rerun at that revision. These are local implementation
checks only: they do not create the `ACC-LOOP-01` or
`ACC-PROV-RAW-01` evidence bundles or prove managed-run acceptance. On the same date,
the AX-124 helper tests and a release-mode headless diagnostic were run; that capture
is not an `ACC-PERF-01` acceptance record. The 2026-10-01 local source snapshot also
contained AX-314's all-file patch preflight/staged-publication slice, which passed
the focused tools suite locally, including injected stage/publication failures and
partial receipts. Two retained summaries disagree on the historical unit-test count
(28 in `CURRENT_RUN.md`, 33 in this plan); the raw output was not retained, so that
historical count is unknown. Its platform and crash-recovery acceptance remains open. It also
changed the Rust home-directory resolver, added the locked dependency license policy
and CI negative control, and removed a disallowed transitive dependency. AX-001's
local gate/test results are recorded in `CURRENT_RUN.md`; hosted CI evidence is still
required for `ACC-DEP-01`. The historical documentation/source capture base was
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde` (2026-10-01); the architecture/status
reconciliation baseline is `f06cd649b1175a1d6eb41d6020c2aefc6b8ccb6c` (2026-10-02).
AX-005 loopback evidence is bound to source revision
`fd7c2bdabcfca4cac58dcbedf4c627a49bfcb336`. That historical working tree
also contained the preserved architecture migration and prior research changes, so
its runtime evidence is not evidence for the refactored target. See the revision-stamped
[`SOURCE-TRACEABILITY.md`](../docs/research/SOURCE-TRACEABILITY.md) and
[`CURRENT_RUN.md`](../CURRENT_RUN.md) for the exact local capture summary and
[`ACCEPTANCE-MODEL.md`](../ARCH/acceptance/ACCEPTANCE-MODEL.md) for evidence rules. A
proposed test is not evidence that its behavior exists.

On 2026-10-02, the focused tools suite was rerun against source HEAD
`7441b79191aa645ad0deda0341bb67dbd9c51b8a` with
`cargo +1.89.0 test -p horizoncode-tools --locked --offline -- --test-threads=1`:
34 unit, 24 mutation, 26 permission, and 24 tool-integration tests passed. This is
local crate evidence only; it does not resolve the missing historical output or create
`ACC-TOOL-PATCH-01` acceptance.

### Read-only repository-health observation (2026-10-02)

At repository revision `7441b79191aa645ad0deda0341bb67dbd9c51b8a`, `HEAD` tracks
`cline-probe` as a mode-160000 gitlink to `d7250ad39400d1485fc11011a80fdab26aeeff83`,
but the repository has no `.gitmodules` mapping. `git submodule status --recursive`
therefore returns `fatal: no submodule mapping found in .gitmodules for path
'cline-probe'`. The nested checkout was already dirty with 4,165 porcelain entries;
it was preserved without edits. Static inspection of
[`ci.yml`](../.github/workflows/ci.yml) found that `actions/checkout` does not request
submodules, and [`Cargo.toml`](../Cargo.toml) limits workspace members to `crates/*`.
This establishes malformed submodule metadata but does **not** establish that the
configured CI checkout or Cargo build is blocked. A clean-clone checkout and CI
reproduction are still required before deciding whether the gitlink should be removed
or declared as a legitimate submodule. No clone, build, test, or network operation was
performed for this observation or this documentation update.

## Dependency license gate (`ACC-DEP-01`, AX-001)

Plan and local execution evidence only; hosted acceptance is pending. From the
repository root, check the exact locked, all-feature dependency graph using
`cargo deny --manifest-path Cargo.toml --all-features --locked check licenses` and
the version-pinned `cargo-deny` tool with `deny.toml`. Run the same command against
`scripts/fixtures/license-deny/Cargo.toml` while retaining the root policy. The
standalone fixture under
Run `cargo deny --manifest-path ... --all-features --locked check licenses` from the
repository root for each target, so cargo-deny discovers the same root `deny.toml`.
`scripts/fixtures/license-deny/` depends on a local synthetic package whose manifest
declares `GPL-3.0-only`, and `scripts/fixtures/license-deny/unlicensed/` depends on a
local package with no license declaration; verify the same policy rejects both
transitive dependencies.
Record the tool version, command lines, workspace lock digest, result and exact
diagnostic. Also verify the fixture is excluded from the workspace and no fixture
package is shipped. Unknown or unparseable license metadata must fail closed or be
resolved through reviewed, package-specific clarification; never broaden the global
allowlist to make a check pass. A local pass and a checked-in workflow do not replace
the hosted CI evidence required for `G-1`. The repository-wide rustfmt check has
existing unrelated diffs under Rust 1.89, so it is not a CI gate in AX-001; the Rust
files changed for this task pass `rustfmt +1.89.0 --edition 2024 --check` individually.

## Operator diagnostics (`REQ-UI-029`, `ACC-DIAG-01`)

Plan only: exercise the same report through `hzcode doctor --json` and `/doctor` and
compare normalized findings for the same observation set, and verify any startup
warning points to the matching stable finding ID. Cover supported, unknown, unsupported,
not-checked, unavailable, permission-denied, timeout, and probe-error observations;
report collection must make no provider or network call and must not mutate files.
Include secret canaries in environment and config fixtures and verify output redaction;
configured sandbox settings must not be rendered as observed OS enforcement. Exercise
unknown fix IDs, stale report/target digests, out-of-root and symlink targets, preview
decline, unauthenticated/stale Guard
confirmation, atomic-write/backup failures, audit failure, and postcondition failure.
Successful repairs must use a finite named fix and owning config/service, carry an
authenticated confirmation and audit receipt, and verify the resulting state. No live
provider endpoint or arbitrary shell fixer is part of this suite.
Current protocol references were rechecked against official ACP v1, its elicitation
RFD, and changelog on 2026-09-27. The RFD says elicitation was completed on
2026-07-22; changelog 1.7.0 (2026-08-20) stabilizes its schema, while 1.9.1
(2026-09-18) is the latest upstream release entry. Those semver values are not ACP
wire protocol versions; fixtures must pin an actual released schema revision rather
than follow mutable `main`.

## Goals and claim boundaries

The evaluation has two co-equal product targets: **fast interactive coding** and
**verified completion of long-horizon software tasks**. Everyday tasks must not be
forced through goal creation or plan approval. Measure correctness, latency, cost,
memory, integration breadth, permission friction, and UI quality without silently
lowering security, intent alignment, or verification requirements. Do not claim that
HorizonCode is better than another agent until a reproducible, task-matched comparison
has been completed and its failures and uncertainty are reported.

## Paired quick-coding benchmark

The benchmark compares HorizonCode and selected coding agents from equivalent
repository snapshots, task prompts, available model/provider routes, tool permissions,
network settings, and resource budgets. Pin each product version, configuration,
model ID, and starting commit. Where exact model parity is impossible, report that
confound and do not combine the runs into a headline ranking. Randomize run order,
repeat tasks sufficiently to estimate uncertainty, retain per-run outcomes, and report
provider-reported usage separately from estimated or unavailable usage.

Use a stratified task set that includes:

1. Explain or locate behavior without changing files.
2. Make a small targeted edit.
3. Fix a failing test or reproducible bug.
4. Add a modest endpoint or feature.
5. Run an appropriate check, inspect the diff, and respond to a user correction.

Score task success and regressions using held-out acceptance criteria and the exact
integrated working-tree revision. Also record time to first useful action, time to
first model token, local pre-model overhead, permission prompts and repeated prompts,
human interventions, tool calls, total duration, output/check quality, and
provider-reported/estimated/unknown input, output, cache-read, cache-write/creation,
and money. Capture failures and incomplete attempts; do not discard runs because a
product or provider failed. User-visible approval count is a product metric, not a
reason to bypass hard safety gates.

Compare default workflows as users encounter them. Record whether a product required
goal/plan setup, editor changes, or user-directed tests. The benchmark is a plan until
the pinned harness, tasks, acceptance rubric, and competitor configurations are
published and runs are executed; architecture descriptions do not count as results.

## `hz-eval` and benchmark lifecycle

The evaluator and run-record contract are specified in
[`EVALUATION.md`](../ARCH/acceptance/EVALUATION.md). The current `hz-eval` source has
bounded V1 record validation and a fixed offline Runner mechanics fixture. Until
independent verification, holdout controls and `ACC-EVAL-01` pass, benchmark stages
below remain a plan, not measured HorizonCode coding performance. The run manifest
must include at least:

V1 uses a strict, versioned schema. `Measured<T>` is explicitly `reported`,
`estimated` (with stable provenance), or `unknown` (with a stable reason code); zero is
a known value.
Unknown fields and duplicate JSON object keys are rejected. The record digest is BLAKE3
over compact typed V1 JSON with the digest omitted, object keys sorted recursively and
array order preserved. Validation rejects unsafe artifact IDs, malformed UTC timestamps,
inconsistent reported lifecycle counts, terminal-reason/outcome contradictions,
negative costs, empty limits, or a missing scoped deadline (`wall_time_ms` or
`runner_wall_time_ms`). Per-category reported
tool counts reconcile with reported totals. A verifier may be absent only with the
explicit `not_run` state; accepted/failed verifier outcomes bind a reported final
workspace digest and a separate result artifact digest. Timing, context,
tokenizer, CPU, memory and disk metrics have explicit units; unavailable values remain
unknown. The validator itself is schema validation only. The separate fixed fixture
creates a bounded trajectory and runs one deterministic task, but does not enforce
holdout policy or verify a result independently.

Validation regression command and current local evidence:

```sh
cargo +1.89.0 test -p horizoncode-eval --locked --offline
cargo +1.89.0 clippy -p horizoncode-eval --all-targets --locked --offline -- -D warnings
```

#### Fixed Runner fixture (development-only)

The first execution path is the fixed `hz-eval run --fixture smoke` fixture. It calls
the production `Runner` with an in-process scripted `Provider`, a fresh temporary
workspace/session store, fixed prompts/tool calls/expected output, and a
workspace-scoped tool registry. It has no network provider or network-capable tool;
this does not claim OS-level network/process confinement. It accepts no arbitrary
prompt, repository path, shell command, model, provider, route, or split override and
always records `split=dev`. Its bounded trajectory, exact workspace snapshot and
sealed run record are separate immutable artifacts. `evaluation_id` is unique per
attempt; retries use a distinct ID, increasing attempt number and optional `retry_of`
link. Non-Git revisions use an explicit content-tree digest identity.
Trajectory completeness is scoped to the versioned `RunObserver` event boundary and
does not claim hidden reasoning, full model request bodies, or internal Runner state.

The fixture is harness-mechanics evidence only. It does not establish coding quality,
live-model latency, actual provider token/cost usage, or `ACC-EVAL-01` acceptance. The
independent-verifier fields remain `not_run` until a separately scoped verifier reads
the retained final workspace snapshot and predeclared criteria. Text deltas are not
token-boundary evidence; first-model-token timing stays unknown. A tool proposal before
authorization is not a successful first action; first-action timing means elapsed time
from Runner start until the first successful settled effect, not the duration of that
tool call. Model/provider/resource/token/cost metrics stay unknown unless measured by
the named actual source. The fixed smoke command emits a first attempt only; durable
retry-group linkage remains unimplemented and open in TODO.

Focused and failure-path coverage for this slice:

- successful bounded scripted turn writes only the declared workspace file, captures
  ordered complete Runner events, and produces a record accepted by `hz-eval validate`;
- path escape and undeclared tool are denied before outside-workspace mutation and are
  not counted as successful execution; a denied call may be `started` (authorization
  dispatch) but is never `completed`;
- scripted provider failure is sealed with its typed outcome; pre-cancellation and a
  one-step limit produce interrupted/insufficient-evidence outcomes rather than a false
  task completion;
- a forced attempt-directory collision preserves existing bytes; CLI tests reject
  symlinked output roots, unknown fixture IDs and unsupported arbitrary prompt/path/
  command/model/provider/split arguments;
- current Unix smoke execution verifies three distinct artifacts and validates the
  sealed record; non-Unix refusal is represented by a cfg-gated test but is not executed
  by the current Unix test run; the selected output filesystem is probed for private
  modes, hard-link publication, no-replace behavior and directory sync before the
  attempt directory is created. This is point-in-time path-based evidence and does not
  cover concurrent output-root/parent replacement or remount races;
- timeout behavior, partial artifact writes,
  disk-full/sync failures, digest-mismatch injection, root-replacement races, and
  parent-directory crash durability remain unproven and are tracked in TODO;
- unit and end-to-end fixture tests force observer trajectory overflow; the sealed
  record retains the bounded prefix, explicit gap and `insufficient_evidence` outcome.
  Workspace metadata expansion tests verify a bounded/incomplete snapshot. Runtime
  timeout and artifact-store failure injection remain open;
- separate attempts must preserve prior failures and bind exact predecessor identity
  once retry execution is implemented; the fixed smoke fixture currently creates only
  attempt 1 and does not exercise retry linkage;
- repeated execution preserves task, trajectory-event, workspace-result and verifier
  semantics; generated IDs and timestamps may vary;
- source inspection and fixture tests show the execution path uses an in-process
  scripted provider and advertises no network-capable tool. They do not prove the
  process cannot open sockets; a dedicated network-denial regression and OS-level
  network-confinement acceptance remain open in TODO.

Record focused commands and exact revision in `CURRENT_RUN.md`. Passing fixture tests
are local evidence for the fixed mechanics only, not independent verification or
holdout evidence. Keep crash/restart attempt recovery, independent verification, and
holdout access policy as open AX-419 backlog until each has separate evidence.

The current validator test suite covers required fields, record tampering, unknown and
estimated metrics, unknown/credential fields, duplicate keys, explicit gap reasons for
incomplete trajectories, key-order-independent
digest validation with a fixed BLAKE3 vector, deep nesting, exact 1 MiB and one-byte-over input, artifact path traversal,
timestamps, count/outcome consistency, required wall limit and negative cost. The CLI
tests also prove untrusted invalid JSON is not echoed and its input read is capped.
These are local focused checks on source revision `2919e26`, not independent
`ACC-EVAL-01` verification or a full evaluation-run acceptance record. Add tests for the
execution/holdout/reporting lifecycle as those slices are implemented.

- schema version and run ID;
- benchmark ID/version, dataset and acceptance-criteria digests, task ID, task stratum,
  and verifier identity/version;
- repository identity, starting revision, integrated/tested revision, and workspace
  digest;
- product/harness identity, exact harness revision/build digest, configuration digest,
  prompt digest, tool-schema digest, policy/permission snapshot digest, and environment
  digest;
- model ID, provider, exact route/adapter and versions, reasoning setting, and known
  model/provider capability snapshot;
- declared wall-time, token, spend, tool-call, step/turn, concurrency, and verification
  limits, including whether a limit is enforced or merely observed;
- random seed/repetition where controllable and paired-run identity where applicable;
- trajectory/artifact references and digests, protected by the normal artifact and
  secret-handling policy; manifests store references/digests, never credentials;
- start/end and phase timings, model-call/tool-call counts, tool categories, input/output
  tokens, cache-read/cache-write tokens, provider-reported/estimated/unknown usage,
  currency basis, and human interventions;
- independent verifier result reference and digest, accepted-task outcome, regressions, and terminal reason
  including completed, task failure, harness failure, cancelled, timed out, provider
  failure, setup failure, unsupported, and insufficient evidence. Unknown or unavailable fields stay unknown
  rather than zero.

### Baselines and staged regressions

Create `HZBench-Dev` first and capture **B0** before optimizing the harness. Use matched
repository revisions, task and verifier, provider route, model/settings, permissions,
network policy, environment, concurrency, and resource limits. If exact model parity or
route readiness is missing, retain separate strata and report the confound. Candidate
examples such as “Muse Spark 1.3” and “DeepSeek V4.1 Flash” are only examples to
investigate; they are not claims that HorizonCode currently supports those routes, that
they are free, or that they are currently available. OpenCode Go catalog/connector
readiness remains pending AX-360/AX-361; the separate live route acceptance remains
AX-364. This plan does not authorize or record a live-provider run.

Keep these named comparisons as separate datasets/reports:

1. **Track A — harness-controlled:** HorizonCode and a comparable peer on the same
   exact model/provider where both routes are supported, with identical task,
   environment, permissions, limits, and verifier. It estimates harness effects only
   within those controlled conditions.
2. **Track B — product ceiling:** HorizonCode, OpenCode, Claude Code, and Codex using
   each product's explicitly recorded configuration. This is a product-level comparison,
   not a model-independent or causal harness comparison.
3. **Track C — HorizonCode ablation:** the same HorizonCode task/model strata with
   progressively enabled capabilities: basic tools; repository index; high-level repo
   tools; TaskPackage; deterministic ChangeReceipt; skills; fast tool scheduler; and
   subagents. Preserve an identical verifier and report interactions between layers.

Capture B1 after Phase 1 runtime/security foundations, B2 after durable state/effects/
budgets, B3 after managed controller/workspace recovery, and B4 after repository
intelligence/TaskPackage/ChangeReceipt. Each stage reruns the pinned B0 set and all
appropriate negative controls. A stage cannot pass on speed or call-count gains if
independently verified correctness, user-intent alignment, safety, recovery, or
regression outcomes decline. Report each result against its exact source/build/spec
revision; changing the task set, verifier, route, or scoring requires a new comparable
stratum rather than overwriting the earlier result.

### Development and frozen holdout

`HZBench-Dev` is visible to implementation and may guide changes. `HZBench-Holdout`
has separately versioned content and acceptance-criteria digests, access controls,
and immutable attempt history. Implementation agents must not retrieve hidden prompts,
solutions, or verifier details; benchmark maintainers audit access and version changes.
Freeze the suite and scoring before a candidate run. Keep failed, cancelled, unsupported,
provider-failed, and insufficient-evidence attempts. A holdout change creates a new
version; it never replaces old results. Holdout evidence gates release claims and is not
used for iterative skill, prompt, model, or threshold tuning. Public-suite contamination
and model training exposure are residuals to disclose, not guarantees that the access
controls eliminate.

The suite registry covers QuickEdit, RepoUnderstanding, FeatureBuild, TestEngineering,
Refactoring, TerminalOps, LongRun, CrashRecovery, Context/Compaction, Stop/NoProgress,
MultiAgent, Permission/Security, WorkspaceConflict, ProviderFailure, PR/Verification,
RepoScale, and ModelCallEfficiency. Every task must have pinned criteria and an
independent verifier. Report accepted tasks per model call, per million input/output
tokens, per tool call, and per elapsed time only alongside task count, verifier-pass
rate, regression/safety outcomes, and uncertainty. The numerator includes only tasks
independently accepted on the exact integrated revision; the denominator includes all
attempted runs/calls/tokens for that declared stratum. No ratio permits dropping failed
attempts or masking a correctness regression. `RepoScale` follows the corpus/workload
matrix in [`PERFORMANCE.md`](../ARCH/contracts/PERFORMANCE.md).

### Competitor selection and comparability

Use Claude Code, Codex, OpenCode, Cursor, Kimi Code, Cline, and Aider as direct
coding-agent comparators where their current surfaces can run the same task. Pin the
release, model, provider route, permissions, network access, editor/runtime surface,
and starting revision for every trial. A same-model comparison is preferred; when a
product's hosted route or model cannot be matched, publish it as a separate stratum and
do not merge its score into a causal product ranking. Record setup friction, failed
provider/auth routes, unavailable features, and product version changes. Hermes Agent,
DeepSeek Harness preview, CowAgent, LibreChat, and Reasonix are adjacent or distinct
products; include them only in a task-specific comparison that states the surface and
does not imply coding-agent parity.

### Cross-feature acceptance coverage

The acceptance records in `ARCH/acceptance/ACCEPTANCE-MATRIX.md` map implementation
work to reproducible checks. The case descriptions remain the acceptance plan; local
checks listed below or in `CURRENT_RUN.md` are not acceptance records.

- **Provider transport response bounds (`REQ-PROV-017`, `ACC-PROV-RAW-01`, AX-005):**
  test exact and one-over boundaries for the 16 MiB post-content-decoding success-body
  ceiling and the 1 MiB serialized SSE-line ceiling, including a line split across
  chunks and an aggregate body with no trustworthy `Content-Length`. Exercise the
  bounded non-stream JSON path and confirm it parses only a complete in-limit body.
  For HTTP failures, prove the preview retains at most 8 KiB, redacts before display,
  caps rendered text at 512 Unicode scalar values, and preserves status and
  `Retry-After`. Overflow must be non-retryable, emit no successful finish, and never
  parse any prefix from a violating chunk. Measure adapter-retained bytes; do not
  claim a process RSS limit because the HTTP client may allocate its yielded chunk.
  Local provider tests now cover unit boundaries, split lines, aggregate chunked-body
  overflow, declared-length refusal, status/`Retry-After` preservation, redaction, and
  response-stream drop. A loopback test at `fd7c2bdabcfca4cac58dcbedf4c627a49bfcb336`
  also cancels and drops an active SSE consumer, then asserts the server observes TCP
  EOF/reset. It does not exercise the Runner cancellation select end-to-end. The raw
  transport acceptance bundle and retained-byte acceptance artifact remain open; see
  `CURRENT_RUN.md` for the exact commands and status.

  Timeout regression (`AX-419-B05`): inject a short private Runner deadline and
  cancellation grace using controlled Tokio time; a provider that waits 25 ms after
  cancellation must settle inside the 50 ms grace, producing a measured 175 ms Runner
  duration for the 200 ms budget. Prove this case fails when grace reservation is
  removed. It must have a typed timeout outcome and complete terminal trajectory. A
  never-settling provider must be dropped at the
  deadline, retain a typed timeout record, and mark the trajectory incomplete with an
  explicit cancellation gap. Check the exact `runner_wall_time_ms` scope and measured
  `runner_deadline_overrun` field; do not assert a strict real-clock duration below the
  budget. Tokio deadlines cannot preempt synchronous work, so overrun is reported and
  no process-level wall-time guarantee is claimed. Setup and artifact publication are
  outside the Runner-only limit; no overall CLI wall-time claim is valid.

- **Provider parity and maintenance (`ACC-PROV-SYNC-01`):** compare complete pinned
  OpenCode and Cline connector/auth inventories with HorizonCode's supported/blocked
  rows; a blocked row fails the full-parity claim. Exercise every route's auth,
  request/stream/tool/error/cancellation,
  context, usage, pricing/cache reporting and quota semantics. Simulate upstream source
  changes and verify the monitor creates a reviewable candidate with exact source
  commit/files and per-file license/notice review. Verify candidate generation does
  not change installed code, active route snapshots, or execute upstream code.
- **Provider inventory snapshot structure:** run
  `node "research docs/scripts/check-provider-inventory-docs.mjs"` to check the
  pinned Cline effective-table counts/uniqueness and OpenCode provider-ID table
  structure. Pass the captured OpenCode feed path as a positional argument to also
  verify its exact SHA-256, 225/8,339 counts, and exact provider-ID set against the
  committed sorted OpenCode table. This check validates the
  committed research snapshot structure only; it does not re-fetch upstream sources,
  prove auth support, establish provider terms, verify every source row semantically,
  or accept any HorizonCode adapter. Those remain in `ACC-PROV-SYNC-01` and AX-363.
- **Architecture dependency gate (`G-17`, AX-399):** run
  `cargo metadata --no-deps --format-version 1 --offline | python3 scripts/check_architecture_deps.py`
  and `python3 scripts/check_architecture_deps.py --self-test`. The workspace check
  covers normal path dependencies, inward layer direction, cycles, unclassified crates,
  and the explicit denylist of known UI/workspace/provider adapter libraries in core.
  Fixtures must reject an outward layer edge, a forbidden external package, and a
  dependency cycle with the exact manifest path and edge; a valid graph fixture must
  pass. Dev-dependency edges are excluded from the shipped graph and remain exercised
  by their owning tests. This static gate does not establish runtime ownership,
  authorization, or OS confinement. AX-412 owns contract tests for adapter failure
  receipts/owner semantics and the sourced capability projection.
  The CI Rust job runs both commands after installing Rust 1.89.0. The independent
  dependency-license job runs the pinned cargo-deny production check and requires
  rejection of its GPL and missing-license fixture manifests. A local pass is not
  evidence that hosted CI ran; record the workflow URL and exact commit before
  marking hosted CI verified.
  On 2026-10-02, a fresh clone at `02fee2b610ef6a45f68330925303e7f9c781ac0d` passed
  the offline workspace build, Clippy, and serial full workspace tests. Repair commit
  `f06cd649b1175a1d6eb41d6020c2aefc6b8ccb6c` changes CI, ignore metadata and the
  orphan gitlink only; it does not change Cargo sources. A fresh clone of that repair
  commit passed locked metadata and architecture graph/fixture checks. Hosted CI still
  must run before hosted verification is claimed.
- **Editors and concurrent edits (`ACC-EDITOR-01`, `ACC-EDIT-02`):** exercise
  terminal-wait, GUI-wait and GUI-detach profiles on every advertised OS/editor
  combination (VS Code, Vim/Neovim, Zed, Helix, and explicitly configured editors).
  Resize while a terminal editor owns the terminal; test cleanup after spawn/exit
  failures, fresh dimensions and layout rebuild. Save through detached editors and
  prove watcher refresh, operator-edit lock, and write admission behavior. Exercise
  raw-byte digests, CRLF/LF alignment, meaningful trailing whitespace, unique and
  ambiguous hunk relocation, clean/conflicting three-way merges, compare-and-swap
  races, and confirm no staging/index/commit/reflog mutation. Show Turn Diff separately
  from Total Working Diff when the checkout already contains user edits.
- **Direct coding and approvals (`ACC-UX-01`, `ACC-UX-02`):** measure direct prompts
  with no goal/plan/Run review, Chat/Explore and Plan restrictions, user correction,
  and Code edits. Count repeated prompts for unchanged valid grants while also testing
  explicit deny, external paths, network, catastrophic commands, and required
  confinement. Validate any competitor-reported settings and prompts from that exact
  pinned release; do not infer them from marketing copy.
- **Cancellation, checks, and capacity (`ACC-UX-03`):** cancel during provider
  streaming, tool dispatch, process spawn, descendant process execution, and a quick
  check. Verify process-tree cleanup using the OS-specific mechanism, grace deadline,
  force termination where supported, truthful pending/unknown state, stale-result
  fencing, and explicit continuation after measured per-turn ceilings. Stress worker
  FD/handle allocations while preserving a declared supervisor/control reserve.
- **Direct compaction and retrieval (`ACC-UX-04`, `ACC-REPO-01`):** adversarially test
  long casual threads with task changes and corrections to detect both lost and
  resurrected instructions. Compare lexical, syntax/reference ranking, and optional
  local embedding retrieval on exact-symbol, error/path, and natural-language tasks;
  test semantic indexing off-by-default, opt-in, stale-index fallback, local-only
  operation, and explicit remote embedding data-egress disclosure.
- **Compaction trigger and recovery (`ACC-P1-07`, `ACC-P1-10`):** use multiple route
  context windows to prove the configurable fractional trigger defaults to 0.5 of the
  selected resolved window; independently test output/buffer/uncertainty hard-fit
  refusal. With auto disabled, exercise threshold, hard-fit, pre-content provider
  rejection, and proven remaining-context truncation; assert zero automatic compact
  or retry, zero dispatch after hard-fit failure, and a typed `CONTEXT_TOO_LARGE` or
  incomplete-attempt result while explicit manual compact still works. With auto
  enabled, test both typed recovery causes, route/revision/effect fences, budget
  admission, exact partial usage accounting, and one shared recovery counter per
  logical step: if provider rejection spends it, subsequent output truncation cannot
  compact/retry again, and vice versa. Test no-progress compaction, compaction model
  failure/empty output, cancellation races, and restart with the counter retained.
  Use a compaction model with a smaller context window than the conversation and prove
  automatic and manual compaction fail visibly with `COMPACTION_CONTEXT_TOO_LARGE`
  without route switching, silent skip, or dispatch of an oversized original request.
  For output clearing, prove compaction changes only the model-context projection:
  canonical Thread bytes and artifact digest remain unchanged; full exact bytes are
  retrievable by authorized read/grep while retained; expiry/corruption yields typed
  `EXPIRED`/`UNAVAILABLE`, never an empty successful tool result; open output and
  verifier-pinned evidence are not cleared.
- **Hooks, shells, output and events (`ACC-UX-05`):** run Bash, PowerShell, cmd, zsh,
  and fish where advertised; verify shell choice changes command interpretation only,
  not Guard/Sandbox/Audit ownership. Test noninteractive pipe defaults, explicit PTY
  behavior, bounded output and process resources. Exercise hook source changes, trust
  prompts, JSON input/output, scrubbed environment, malformed/oversized responses,
  timeout and process failure; none may widen permission. Flood UI subscriptions with
  output/event deltas and verify summaries remain bounded while durable records remain
  retrievable by cursor without hidden gaps.
- **Direct analytics (`ACC-ANALYTICS-01`):** attribute ordinary usage to Thread/Turn;
  verify managed IDs are nullable, cache reads differ from cache writes/creation, and
  missing provider usage remains unknown rather than zero. Rebuild projections from
  canonical records and check idempotent replay.

For the competitor benchmark, report confidence intervals or another predeclared
uncertainty estimate, all failures and timeouts, and missing/unsupported configurations.
Public benchmark scores and architecture descriptions are context only; they cannot
replace paired quick-task results or the acceptance evidence above.

Keep these outcomes separate:

1. **Task success** — required acceptance scenarios pass on the exact integrated
   revision.
2. **Intent alignment** — implementation satisfies the original and confirmed user
   intent, including independent examples not copied from the implementation spec.
3. **Recovery correctness** — crashes, context loss, cancellation, and retries do not
   lose known progress, duplicate effects, or convert uncertainty into success.
4. **Safety** — effects obey the declared permission, filesystem, network, and
   deployment boundaries on the tested host.
5. **Efficiency** — tokens, money by currency and basis, elapsed time, CPU, RSS/PSS,
   disk, model wait, and human interventions are measured without conflating estimates
   with provider-reported facts.

Never treat model confidence, number of tool calls, number of child agents, lines
changed, a passing mock, or a provider's “completed” event as task success.

## Existing test inventory at the source baseline

This list is a file inventory, not a fresh run result. The referenced tests should be
re-read and run against the exact revision before relying on them.

| Area | Existing integration-test file(s) | Scope visible from source names |
|---|---|---|
| Analytics | `crates/horizoncode-analytics/tests/ledger.rs` | Ledger and rollups |
| Audit | `crates/horizoncode-audit/tests/chain.rs` | Chain behavior |
| CLI / ACP | `crates/horizoncode-cli/tests/e2e_acp.rs`, `e2e_acp_usage.rs` | ACP stdio and usage integration |
| CLI / audit and analytics | `crates/horizoncode-cli/tests/e2e_audit_analytics.rs` | CLI surfaces and persistence |
| CLI / headless | `crates/horizoncode-cli/tests/e2e_binary.rs`, `exit_codes.rs`, `state_root.rs` | Built-binary behavior, exit contract, state paths |
| CLI / tools | `crates/horizoncode-cli/tests/e2e_tools.rs` | Tool path through CLI |
| Config / skill inspection | `crates/horizoncode-config/tests/skill_inspection.rs`, `crates/horizoncode-cli/tests/commands_cli.rs` | AX-405 content-free skill metadata/body-size inspection; does not cover activation or bundles |
| Config / discovery | `crates/horizoncode-config/tests/discovery.rs`, `instructions.rs`, `settings.rs` | Configuration discovery, hierarchical instructions and settings validation |
| Guard | `crates/horizoncode-guard/tests/guard.rs` | Policy and approval rules |
| Provider | `crates/horizoncode-provider/tests/mock_transport.rs` | Mocked HTTP/SSE provider transport |
| Runner | `crates/horizoncode-runner/tests/e2e_loop.rs` | Turn loop, tool calls, limits, cancellation |
| Sandbox | `crates/horizoncode-sandbox/tests/sandbox.rs` | Host backend and path-policy behavior |
| Session | `crates/horizoncode-session/tests/log.rs` | Append/replay/resume/repair |
| Tools | `crates/horizoncode-tools/tests/mutations.rs`, `permission.rs`, `tools.rs` | Mutations, filtering, built-ins |

### Native read byte-limit checks (`REQ-TOOL-010`, `ACC-TOOL-READ-01`)

- A regular file of exactly 16,777,216 bytes is accepted; a declared larger size
  fails before content is read with `TOOL_OUTPUT_LIMIT`, exposing the reported size
  and limit and returning no partial content.
- If the opened file grows after metadata inspection, the bounded reader consumes at
  most 16,777,217 bytes, reports that observed lower bound with `TOOL_OUTPUT_LIMIT`,
  and returns no partial file content.
- A non-regular, non-directory target fails with `TOOL_UNSUPPORTED_TARGET`; directory listing stays
  on its existing path. Preserve binary reporting, page offsets, sandbox path checks,
  and downstream output-bound behavior.
- Include workspace escape and symlink cases, sparse-file fixtures, exact typed
  settlement assertions, and platform labels for fixtures not supported everywhere.
  The file-byte ceiling is not an RSS guarantee; measure memory separately if a
  process-memory acceptance claim is required.

### Recursive search reach and error checks (`REQ-TOOL-011`, `ACC-TOOL-SEARCH-01`)

- Deny a descendant directory and a matching file through the resolved
  confinement profile. Both `glob` and `grep` must stop with a typed denial and
  return no partial paths or matching content; a denied directory must not be
  traversed further.
- Inject a directory-walk error and a file-open/read error. Each must become a
  typed `TOOL_IO_ERROR`, and no partial success may be returned. Add observable
  instrumentation before claiming denied descendants were never visited. `grep` must
  check the opened handle is regular and use the same 16 MiB plus one-byte
  bounded reader as `read`; test exact size, oversize, post-metadata growth,
  binary input, and symlink targets.
- Verify recursive traversal excludes `.git`, applies only `.ignore` and
  `.gitignore` rules beneath the selected root (including a selected root with no
  Git marker), honors negation and directory rules, and places `.ignore` above
  `.gitignore` across directory depth while deeper files win within the same
  type. Parent/global Git excludes and `.git/info/exclude` must not affect
  results. Hidden files remain searchable unless ignored or excluded by the
  explicit `include` pattern. Ignore files must be regular, non-symlink files at
  or below 1 MiB; combined rule contents are capped at 16 MiB. Malformed,
  oversized, denied, and unreadable ignore files fail typed without partial
  matches.
- Verify the 100,000 delivered-entry filter ceiling, 64 MiB aggregate `grep`
  input ceiling, per-file 16 MiB ceiling, and cancellation before walker advances,
  in delivered-entry callbacks, after every 64 delivered entries, and, for `grep`,
  after every 256 scanned lines. Use test-injected lower budgets for fast
  exact/one-over boundary checks. The walker
  can internally filter ignored entries before invoking its entry filter, so an
  internal skip run can delay cancellation without a bound; the entry ceiling
  does not establish a total traversal-work or cancellation-latency bound.
  The filesystem path-based ignore reread and normal symlink-swap race remain
  explicit residuals; no race-free confinement claim is supported.

### Native patch preflight and staged publication (`REQ-SEC-022`, `ACC-TOOL-PATCH-01`)

- Assert exact/over boundaries for the 4 MiB patch-text cap, 131,072 patch-line
  cap, 1,000,000 target-lines-per-update cap, 256-operation cap, 4,096-hunk
  cap, 134,217,728-byte aggregate transformation/comparison-work cap, 16 MiB
  per-file base cap, and 64 MiB aggregate base cap. Oversized metadata is refused
  before content read; growth beyond the captured bound is detected with a
  bounded limit-plus-one read and no target publication.
- Submit a multi-file patch with a valid first operation and a missing, ambiguous,
  invalid-UTF-8, unsupported-target, or missing-file later operation. Assert the
  complete patch fails before any target file changes and returns no success receipt.
  A hunk longer than its target returns a typed error and never panics.
- Deny or fail confinement on a later target. Assert no target contents were read
  and no target was published before the denial. Repeated operations and lexical
  aliases for one resolved target must preserve the defined request order while
  producing one final file publication.
- Inject a stage/write/sync failure at each target index. Assert no target changed,
  all ordinary-return staging files are removed, and newly created empty parent
  directories are cleaned where possible. Inject target-byte and symlink changes
  during staging; the all-target pre-publication recheck must preserve concurrent
  bytes and publish nothing. On Unix, verify staging files are owner-only before
  replacement bytes are written and assert the declared mode for newly added
  targets plus basic permission-bit preservation for replacements.
- Inject a later publication failure after one complete per-file replacement.
  Assert the result is `TOOL_PARTIAL_EFFECT`, lists exact committed digests/removal
  receipts and pending paths, and never reports overall success. Verify update,
  add, and delete base checks, read-only mode refusal, permission-bit preservation,
  replacement behavior on every advertised OS/filesystem, and temp cleanup.
- Kill a subprocess during stage write and between file publications. Each individual
  target must contain either its complete captured base or complete replacement,
  never truncated bytes. The process-death patch outcome stays `UNKNOWN`; the test
  must not infer recovery from temporary-file cleanup and remains blocked from
  acceptance until `AX-311` durably enumerates and reconciles effect receipts.
- Bind evidence to exact tool/spec revisions and platform. Report ACL, ownership,
  xattr, directory-creation and non-cooperating-writer races as residuals; do not
  claim a cross-file atomic transaction.

There is no test file inventory yet for the proposed run controller, durable goal/spec
state, task DAG, settings/command registry, UI, repository map, ACP client, MCP host,
agent directory, plugin/skill runtime, PR lifecycle, cost reservation, or multi-hour
recovery. Their target gates are specified below and in `ARCH/acceptance/ACCEPTANCE-MATRIX.md`.

## Source status at the 2026-09-28 implementation pass

The first implementation pass ran the baseline commands and produced, for the first
time, a measured failure list. `cargo clippy --workspace --all-targets -- -D warnings` and
`cargo test --workspace --no-fail-fast` are clean except for four pre-existing failures
that also fail at the documented baseline revision `b677443` and are therefore recorded
as findings (`docs/history/architecture/audits/2026-09-30-review.md` `F-65`, `F-66`) rather than silently absorbed.
`cargo fmt --all --check` also fails at the baseline, with 67 pre-existing diffs; the
2026-09-28 pass formatted only the files it wrote and reverted unrelated reformatting, so
this remains an open cleanup item rather than a pass:

| Failing test | What it proves |
|---|---|
| `horizoncode-audit` `entry::tests::genesis_matches_its_label` | the pinned `GENESIS_PREV_HASH` is not `blake3(GENESIS_LABEL)` |
| `horizoncode-audit` `anchor::tests::genesis_root_matches_its_label` | the pinned `GENESIS_PREV_ROOT` is not `blake3(GENESIS_ROOT_LABEL)` |
| `horizoncode-cli` `e2e_acp::acp_initializes_creates_a_session_and_streams_updates` | a read-only tool call is denied, so no `tool_call_update` reaches `completed` |
| `horizoncode-cli` `e2e_tools::headless_write_edit_and_sandboxed_bash` | the same denial reaches the headless tool path |

A test that fails at the baseline is a source defect, not a flake; it re-opens the
requirement it claims to cover.

## Determinism, fault injection, and kill matrices

Deterministic fault fixtures are supplied by `horizoncode-testkit`, which test suites
use as a dev-dependency. The production `Clock` abstraction is separate; it enables
clock injection but is linked into the relevant production crates:

| Piece | Where | What it provides |
|---|---|---|
| `horizoncode_types::clock::Clock` | `crates/horizoncode-types/src/clock.rs` | the injectable clock; the session store stamps records from one, while `horizoncode-audit`, the runner's analytics recorder, guard ticket TTL and analytics day-bucketing still read the host clock and are named as the remaining sweep |
| `horizoncode-testkit` | `crates/horizoncode-testkit/src/lib.rs` | `TestClock`, `ScriptedFaults`/`FaultOp`, `StoreSnapshot` (byte-level before/after proof), and the kill-point environment contract |
| Durability seam | `horizoncode_session::CommitSink` | the two commit primitives (`sync_file`, `sync_dir`) a test substitutes to make a directory-sync failure or a real process death deterministic |
| Session kill matrix | `crates/horizoncode-session/tests/kill_matrix.rs` | real child processes that die from inside the file sync or the directory sync, plus interrupted-final-write states; 20 cycles per scenario, asserting that acknowledged rows stay dense, retained torn bytes are reported, and the store is usable afterwards |
| Audit writer race | `crates/horizoncode-audit/tests/writer_race.rs` | two real processes contending for one store; 20 cycles asserting unique contiguous sequence numbers and a chain that still verifies |
| Read-path immutability | `horizoncode-audit/tests/integrity.rs`, `horizoncode-session/tests/list.rs` | byte- and metadata-level proof that `verify`/`replay`/`census`, `read_only`/`scan`/`inspect`/`list` change nothing |
| Explicit repair | `horizoncode-audit` `AuditLog::repair_segment` | torn-tail repair that preserves the original bytes in a linked artifact, and the `audit repair` surface that drives it |

### Commit durability gates (`ACC-P1-13A`, `ACC-P1-13`)

Run `ACC-P1-13A` as a primitive-only gate as soon as AX-352 lands: assert the exact
`sync_file` → committed-head sync → required `sync_dir` → acknowledgement ordering;
inject each sync failure/unavailable backend and disabled per-append sync; prove none
returns durable success; and record the profile/backend/revision in
`acceptance/commit-durability-primitive/<platform>/<build-id>.json`. This gate does
not wait for session migration, segment rotation, or physical reserve. Run
`ACC-P1-13` only after AX-350 integrates the primitive with session creation, segment
rotation, seals/heads, and physical control reserve; include actual ENOSPC and the
declared platform acceptance method. Primitive evidence must not be presented as
integrated-store or power-loss acceptance.

Two boundaries remain honest gaps and must be reported as `insufficient evidence`
rather than as passes:

- **real ENOSPC and power loss** need an isolated fixture and explicit authorization
  (L5). Fault injection proves the *ordering* of the commit steps, not what a
  particular disk controller does on power loss;
- **cross-host filesystems** (NFS and similar) are outside the advisory-lock
  guarantee; the record must name the filesystem it was proven on.

Quarantine policy: a quarantined test carries an owner, a reason, a linked issue and
an expiry, and a quarantined security-relevant test is a release blocker. No test is
quarantined in this pass.

## Verification layers

Use the layer definitions and anti-claims in `ARCH/acceptance/ACCEPTANCE-MATRIX.md`; do not promote lower-layer
evidence into a higher-layer claim.

| Layer | Run when | Required evidence |
|---|---|---|
| Unit | Every code change | Pure behavior, boundary arithmetic, typed errors, parsers, migrations, status transitions, no wall clock or live network |
| Contract | Every changed component/API | Schema and capability conformance; happy path, malformed input, unavailable dependency, denial, timeout, cancellation |
| Integration | Every governed effect class | Real temp directories/processes/worktrees/loopback fixtures; full guard → sandbox → effect → receipt path |
| Binary/UI E2E | Every user-visible change | Built executable or real terminal harness driven from outside the component; key input, output, exit status, setting persistence |
| Platform acceptance | Before platform/support claim | Exact OS/build/backend, observed filesystem/network boundary, residual and host details, raw evidence |
| Long-horizon acceptance | Before any multi-hour autonomy claim | `ACC-H1-01..12` as applicable to the claimed feature set on the exact integrated revision; include restart, user-intent changes, artifact integrity, segmented-log growth, and storage-pressure recovery |
| Comparative benchmark | Before comparative quality claim | Pinned tasks/models/versions/budgets, paired runs, raw outcomes, uncertainty and complete failure log |

For Rust changes the planned local baseline is `cargo fmt --all --check`,
`cargo clippy --workspace --all-targets -- -D warnings`, and `cargo test --workspace`.
Run crate-focused tests while iterating, then the complete workspace and applicable
platform/acceptance suites before changing a readiness claim.

Use deterministic fixtures and injected clocks, IDs, random sources, homes, process
environments, model transports, and filesystem failures. Live model/provider tests are
opt-in experiments, never default test dependencies. All benchmark/test records bind
the build artifact, commit, spec digest, OS/runtime, configuration, model/parser and
test-data revision.

## Must-have adversarial suites

### Intent, goals, plans, and task state

- Preserve the original request verbatim; classify confirmed, assumed, excluded, and
  proposed behavior with provenance. Model-generated claims cannot become confirmed.
- Test ambiguity discovery, explicit answers, user correction, spec-version creation,
  and the exact affected-task/evidence invalidation graph.
- Evaluate a deliberately wrong but internally consistent specification against
  independent intent scenarios; result must be rejection or `INSUFFICIENT_EVIDENCE`,
  not success because spec-derived tests pass.
- `/goal set` persists the original request only: assert no model request, repository
  traversal/indexing, tool, or peer spawn. `/goal prepare` requires an explicit user
  action, finite separate budget, pinned base, and read-only repository capability;
  deny write, shell, child-agent, and external effects at the service boundary.
- Kill preparation before dispatch, after provider acceptance, and after response but
  before its receipt. Reconcile provider request/usage when supported; otherwise keep
  the goal inert, preserve a conservative reservation/unknown outcome, and require a
  new explicit preparation delivery. Same delivery plus same payload is idempotent;
  reused ID with changed input conflicts.
- Clarification creates a new proposal/spec/task/plan digest and invalidates stale
  review/approval receipts. A planner cannot label its own interpretation confirmed.
- Validate task DAG cycles, missing dependencies, stale spec digests, stale commits,
  worker `completed` without evidence, failed verification, and failed descendants.
- Clear the selected goal pointer for a paused run, restart/rebuild the projection, and
  verify the goal/run remain resumable by ID; reject clear for a running or wrong-scope
  run without changing durable goal/task state.
- Start a goal only against the displayed spec, task-graph, plan, base, route,
  permission, and budget digests; mutate each after review, inject unresolved ambiguity
  or reservation failure, redeliver the same receipt, and crash between accepted
  response, individual reservations, activation commit, projection update, outbox
  claim, worker launch, and launch receipt. No task dispatches before the durable
  `GoalActivated` event. Before it, recovery reconciles the same intent/reservation
  IDs or safely releases reservations; after it, recovery reuses the same outbox and
  attempt IDs. An unknown reservation/launch blocks new work until reconciled.
- Race two authenticated review surfaces for one goal: the newer challenge invalidates
  the older; out-of-order clicks, a stale tab, a reused delivery ID with changed
  payload, response from another control session, cross-connection replay, expiry,
  disconnect, changed policy/budget/base/route, or additional input cannot activate.
  Change policy or budget revisions in the race window between durable reservation
  and activation append; the revision CAS must reject and reconcile reservations. Let
  an accepted receipt expire before recovery; no activation may occur.
  Same-ID/same-payload retry returns the original challenge or result. Verify one
  pending challenge and one nonterminal intent per goal, exact rendered bundle digest
  equality, and that `ACCEPTED` alone is not shown as running.
- Race `/cancel` against `GoalActivated` repeatedly under a barrier. When cancellation
  commits first, assert activation is fenced, every created reservation is idempotently
  released, no outbox row/attempt is dispatched, and the intent reaches `CANCELLED`
  only after confirmed release. When activation commits first, assert the ordinary run
  cancel fence handles queued and in-flight work. Kill/restart during reservation
  release; `CANCEL_REQUESTED` remains visible and cannot become terminal while any
  reservation or launch is `UNKNOWN`. Replaying the same cancel delivery must not
  release twice or create a second cancellation event.
- Exercise typed `/cancel run <id>`, `/cancel task <id>`, and `/cancel attempt <id>`.
  Reject missing/foreign IDs, inconsistent ancestry, and mismatched operation scopes.
  A run cancel fences every new claim; task cancellation does not cascade to descendants
  or unrelated tasks and preserves a visible blocked-dependency reason; attempt cancel
  permits a new attempt only if retry policy, budget, and attempt limit allow it. Race
  each request with normal task completion, replay the same delivery, then reuse its ID
  with a changed target. Unknown child/process/effect outcomes must remain
  `RECONCILING`; a sent signal alone is not a cancellation receipt. Restart during
  cleanup and verify cancelled tasks remain cancelled while independent eligible work
  can continue. Confirm `/stop-now` exercises its separate hard-stop contract.
- Exercise start approval independently through TUI, CLI, and ACP. For ACP, test
  advertised form elicitation accept/decline/cancel, invalid schema, timeout,
  disconnect, reconnect/new-connection binding, and client without elicitation using
  the exact one-use typed receipt. Plain “yes”, extra text, stale/reused IDs, wrong
  session/principal, unauthenticated client, untrusted connector, and
  `session/request_permission` must never activate or dispatch. Assert ACP
  connection/session binding alone cannot mint an operator principal;
  `elicitation/create` is agent-to-client only; peer-originated elicitation when
  acting as an ACP client is ordinary untrusted input. The trusted connector must
  display every review digest and capture an explicit choice; the protocol itself
  does not attest a human saw the UI. Test worker invocation of the HorizonCode CLI,
  forged flags/env/config, direct local socket access, process-environment or
  descriptor/token leakage, canonical state/audit/budget/evidence path read and write
  attempts, symlink/junction/mount retargeting, and fake `todowrite` status updates.
  Denial leaves canonical state and the approval receipt set unchanged. A same-UID
  bare `full-access` profile refuses; an isolated worker identity/VM proves the
  private-state/control boundary on each claimed backend. Unit mocks do not prove
  process isolation. At the typed controller boundary, attempt to construct/deserialize
  a `MutationContext`, pass `UserActor { USER_OPERATOR }`, change a scope/run/epoch,
  reuse an expired or consumed nonce, replay a receipt on a different control session,
  or exploit a public constructor. Every forged request returns its specific typed
  denial (`WrongPrincipal`, `ScopeDenied`, `ExpiredCapability`, `ReplayConflict`) and
  leaves events, reservations, goal pointers, and receipts unchanged. Legitimate UI,
  CLI, and trusted-connector requests still bind to the authenticated origin.
  While approval is pending, non-receipt input invalidates the review before any
  model continuation. Muted notifications and custom color palettes cannot obscure or
  change the durable approval state.
- Verify controller pause fences before acknowledging pause; resume uses current
  state, durable counters, and a materially new bounded strategy after a no-progress
  stop. Repeated sessions/models do not reset retries.
- Test command intent against exact `/pause`, `/resume`, `/cancel`, `/stop-now`, and
  goal aliases; natural language, negation, quoted examples, another run's ID,
  ambiguous target, queued steering, and ordinary discussion of “pause”. Ambiguity
  must not dispatch another model turn before clarification.
- After compaction/model switch/restart, reconstruct goal, accepted spec, open work,
  budget, permission ceiling, user input receipts, and stop state from durable records;
  never rely on summary prose as source of truth.
- Empty successful model output, no tool calls, repeated reads, unchanged diffs,
  broken process waits, and “continuing” text are not progress. Waiting on timer, user,
  approval, child process, or provider quota consumes no model inference unless an
  explicit bounded poll action was scheduled.
- Foreground result and maintenance drain are separate. A CLI may report
  `maintenance_pending`, but may not silently print success and wait indefinitely.

### Durable state, tools, integration, and restart

- Worker-execution lifecycle (`AX-359`): crash before/after durable launch intent,
  after an expiring resume claim but before spawn, between spawn and receipt, after
  receipt but before event publication, after peer acceptance, during heartbeat expiry,
  during cancel, and after process exit but before settlement. Restart with a surviving,
  dead, PID-reused, unreachable, or opaque peer handle. Reconcile workspace fence,
  event cursor, usage and every pending effect before allowing another writer. Same
  launch ID must return the same execution; changed payload under that ID conflicts.
  A claimed auto-resume must not become unrecoverable if the host exits before launch:
  expire/reconcile the claim, inspect the outbox and process table, and prove no second
  writer launches while outcome is unknown. Inject stale/forged hook events and verify
  the specific reservation-committed/run-directory-not-yet-created window, and the
  process-launched/launch-response-not-yet-delivered window: restart must return the
  original receipt or keep the outcome `UNKNOWN`, never create a duplicate run/worker.
  Stale or forged hook events cannot change the bound workspace/launch status; test missing hooks and child
  roster after restart as `UNKNOWN`, never as “no child.” Reject symlink traversal in
  any transcript reader and keep private reasoning out of user-visible artifacts.
  Verify unsupported resume/query stays `UNKNOWN`, client disconnect leaves work
  running under the detached controller, worker exit cannot pass the Attempt/Task,
  infrastructure relaunch stays within the same strategy/Attempt only after
  settlement, and a changed strategy creates a new Attempt. Run this with native,
  ACP-capable, and opaque CLI fixtures; mark unavailable peer data `unknown` rather
  than inventing evidence.
- External adapter upgrade/reconnect (`AX-318`): pin each live execution to the local
  adapter build digest and negotiated protocol/capability snapshot. Pause an execution,
  activate a new adapter build for future work, then reconnect. The old execution must
  either continue under a compatible old adapter or transition to a reconciled/blocked
  state before a new adapter takes ownership. Exercise capability removal, protocol
  mismatch, unknown peer version, cursor reset, duplicate/stale events, and route/model
  catalog refresh. Prove usage/event provenance names the exact build that observed
  it; do not infer compatibility from a version string alone.
- Thread/Execution identity migration (`AX-379`): migrate legacy session IDs and
  event/index names in a copied fixture without changing identity, dropping committed
  events, duplicating a conversation, or making search/navigation cursors point at a
  different message. Kill/restart at every migration phase; rerun migration to prove
  idempotency; load old bundles read-only; verify the new Thread format remains
  exportable and readable after rollback to a migration-capable build. Exercise root
  and child Threads, several Threads in one Attempt, external Codex/OpenCode/ACP
  bindings, opaque workers with unknown peer IDs, input inbox replay, and a
  WorkerExecution restart on the same Thread. Confirm thread/worker completion never
  marks an Attempt or Task passed and that a changed strategy creates a new Attempt.
  This is the `ACC-P1-15` evidence set: retain source/target manifests and digests,
  migration receipt, crash matrix, graph/cursor parity report, and verifier refusal
  evidence in `acceptance/thread-migration/<build-id>.json`.
- Evaluator freshness (`AX-381`): pause deterministic planner/reviewer/evaluator
  responses behind test barriers, mutate each bound source revision (new user input,
  cancellation, spec/task-graph/policy/workspace update, terminal task) and then release
  the old response. Verify the controller reloads state before commit and leaves the
  stale response diagnostic-only; it must not complete a task/run, overwrite newer
  state, resume a worker, or dispatch an effect. Cover two evaluators returning out of
  order, a crash after response but before state commit, restart/replay of the stale
  response, same revision with unrelated analytics updates, digest collision/encoding
  boundaries, and reevaluation with a newly reserved budget. Record deterministic
  schedules and state/event digests in `acceptance/evaluator-freshness/<build-id>.json`
  for `ACC-P1-17`.
- Agent questions and selectable answers (`AX-380`): validate stable request,
  question, and option IDs; duplicate IDs; single-choice, multi-choice, required,
  optional, free-text, and “other” cardinality; empty/oversized payloads; malformed
  schemas; unknown options; and answers that exceed declared counts. Reject before
  persistence/delivery, with no fallback to the first option. Persist the request
  before rendering or acknowledging it, bind it to the exact originating Run/Task/
  Attempt/Thread/Turn/tool call, and verify that a child question returns to the
  authorized operator surface without losing child identity. Test duplicate answer
  delivery after reconnect, same-payload idempotency, changed-payload conflict,
  answer persistence before delivery, crash between commit and worker resume, stale
  request, expiry, cancellation, missing operator authorization, and unsupported
  ACP/opaque worker question capabilities. A pending request pauses only its caller
  at a safe boundary, releases unused worker resources, and does not block unrelated
  tasks, cancellation, permission replies, or recovery control lanes. Headless mode
  must return structured `NEEDS_INPUT` plus a stable resume reference; test resume
  with valid answers and prove `--yes` never invents one. In the TUI, cover keyboard
  selection, multi-select, free text/other, visible focus and selected state, screen
  reader labels, color themes, narrow terminal resizing, composer draft preservation,
  pane layout preservation, provenance (which agent/task asked), receipt/error state,
  double-submit, and reconnect. Prove question answers cannot authorize tools,
  change policy, approve long-horizon start, or count as verification. Record
  schema/property tests, control API receipts, adapter capability fixtures, process
  kill matrix, TUI interaction captures, and headless transcripts under
  `acceptance/agent-questions/<build-id>.json` for `ACC-P1-16`.
- Mixed question batches: make the provider return one valid question call beside
  `write`, `bash`, and network/effect calls. Assert that no sibling dispatches while
  input is pending, then verify each receives `not_run_question_boundary` only after
  the durable answer and the model replans. Return malformed question arguments,
  duplicate question calls, and malformed siblings; each invalid batch must dispatch
  zero calls. Race an external ACP elicitation against already-started calls; verify
  new dispatch is fenced and each in-flight effect is cancelled or reconciled as
  `UNKNOWN`, never assumed rolled back (`REQ-TOOL-006`, `ACC-P1-16`).
- Model-facing compacted-history retrieval (AX-385 / `ACC-P1-19`): after compaction
  removes older visible turns, search and read only the controller-selected current
  Thread; reject any model-supplied foreign Thread ID; revalidate immutable message
  refs before read; enforce query/page/byte/token budgets; and return exact
  `COMPLETE`/`PARTIAL`/`EXPIRED`/`UNAVAILABLE` coverage. Exercise compaction, rename,
  index rebuild, retention expiry, partial/corrupt index, FTS5 unavailable, tool-output
  opt-in then opt-out, hidden-reasoning exclusion, cancellation, duplicate/malformed
  refs, prompt injection in recalled text, disabled feature, and crash/reconnect. Prove
  history can inform a worker but cannot satisfy Evidence, grant permissions, or change
  approved specification. Compare UI search and tool search against the same authorized
  canonical oracle; retain references, not a second archive. Verify
  `search.model_history_retrieval=false` by default, project config cannot enable it,
  explicit user opt-in enables it only while `search.enabled=true`, and disabling or
  purging search immediately prevents new history retrieval.
- Route-specific system-prompt update semantics (`ACC-P1-20`): default to complete
  effective-prompt replacement. A fake adapter may use in-history updates only when a
  pinned route capability says later system messages replace the effective prompt;
  compare requests after baseline update/removal, compaction, resume, tool-schema change,
  provider refresh, and route change. Unknown/malformed capability must replace. Stable
  prefix or cache usage alone is not evidence of semantic support. Separate deterministic
  request-construction fixtures from optional, authorized live cache-hit/billing tests;
  mocks cannot prove remote cache behavior.
- Crash before effect; after external effect but before receipt; between event append
  and SQLite projection; during task settlement; while applying patch; during checkout,
  merge, checkpoint, or PR creation. Restart reconciles before replay and never treats
  an unknown side effect as absent or successful.
- Segmented session/run event logs: cross every record/segment boundary; rotate at
  exact byte and record limits; verify dense sequence, event/segment digest links, and
  committed head; kill after append/before head, during seal/next-segment creation,
  during projection update, and during recovery. Inject missing/reordered/truncated
  committed segments and verify fail-closed behavior. Replay a large history while
  measuring RSS; memory must follow the configured batch bound rather than total log
  size. Race independent writers for the same session/run and event-byte reservation.
- Event-log quota and disk pressure: saturate artifact bytes without consuming log
  reserve, then saturate event bytes without consuming artifact quota; prove atomic
  parent/task reservations; fill storage near the hard boundary and verify dispatch is
  fenced before control/reconciliation/handoff reserve use. Disk-full during a tool
  result, cancel, terminal event, and effect reconciliation must retain a typed
  `UNKNOWN`/`RECONCILING` state and must never report `COMPLETED` without durable
  evidence. Check that UI/context compaction does not prune canonical records and that
  a resumed run requires approved capacity/policy revalidation.
  Verify the protected reserve is physically preallocated before activation and can
  still accept bounded control/handoff records under actual ENOSPC; a sparse reserve,
  free-space probe, or internal quota counter must fail the guarantee. Restart must
  revalidate reserve identity and allocation. Exercise each advertised filesystem
  backend; unsupported reservation behavior blocks that run profile.
- Read-only event-store non-mutation: snapshot all session/run files, lengths, hashes,
  metadata, and committed heads; exercise `read_only`, list, status, index verification,
  and export inspection with valid, corrupt, and unterminated final records. Every
  read path leaves the canonical bytes and recovery state unchanged. Explicit
  recovery must preserve/hash-pin the original tail, reconcile effect/operation IDs,
  write only an idempotent recovery record/new generation, and refuse when the
  external outcome is unknown. Test duplicate and changed-payload recovery IDs.
- Session search (`AX-369`, `ACC-P1-14`): compare the derived message/title FTS tables
  with a reference scan of committed canonical events. Cover globally authorized
  sessions and a selected session; user/assistant text and opt-in displayable tool
  output; hidden reasoning, uncommitted events, deltas, binary content, and secrets
  excluded by explicit classification; case/diacritic behavior, whole-token terms,
  contiguous quoted phrases, punctuation tokenization, repeated terms, Unicode,
  malformed quotes, FTS operators as inert text, empty/oversized queries, and bounded
  page/cursor behavior. Exercise current and historical titles, rename then search,
  rename back, duplicate titles, title-only hits, role/date filtering of title hits,
  and message-ID navigation when the target history window is not loaded. Force
  equal timestamps/ranks across message and title hits at a page boundary; prove the
  complete tie-break tuple gives deterministic no-duplicate/no-skip keyset pagination.
  When title and body both match in one Thread, verify message hits carry title context
  and redundant title-only rows are suppressed. Bind the index to a versioned text
  extractor; fixtures cover each persisted part type, ordering/spacing, normalization,
  truncation, replacement/edit policy, and explicit non-text omission. Toggle
  tool-output indexing off while purge is pending and prove queries/snippets hide
  existing tool rows immediately. Inject
  rename/message commit between snapshot and query; assert captured-head consistency,
  stale cursor handling, event-digest revalidation, no jump to a neighboring message,
  and no leak across project/session authorization scopes.
- Search-index recovery/privacy: crash between canonical append, projection rows,
  FTS maintenance, and indexed-head commit; rebuild must produce the same rows/digests
  as uninterrupted projection. Inject missing/corrupt FTS table, unsupported FTS5,
  stale generation, corrupt/unreadable session, interrupted enumeration, delete/expiry,
  search disable/purge, and tool-output opt-out. Coverage must be `COMPLETE` only when
  every authorized session is indexed through its captured head; otherwise return
  visible `INDEXING`/`PARTIAL`/`FAILED` issues, never a complete zero-hit result.
  Compare the index against a reference scan and prove search/listing never repairs,
  truncates, or changes canonical events. Run concurrent readers/indexer and cancel
  queries while checking bounded memory and that cancelled indexing does not advance
  its checkpoint.
- Search load protocol: use fixed synthetic corpora of 10k and 100k committed display
  messages across varied session/project counts, message sizes, title aliases and hit
  densities. Record hardware, SQLite build/FTS5 capability, corpus digest, query
  distribution, p50/p95/p99 latency, index build/rebuild time, bytes/RSS, and result
  parity. No latency target is claimed until a baseline is recorded; query deadlines,
  maximum page size, and index batches must still bound work under deliberately broad
  terms and cold-cache scans.
- Guard regression (`AX-370`): demonstrate that a path-scoped `fs.read` allow cannot
  exempt `fs.write`, delete, or move from the external-path ask floor; a same-action
  rule can only affect its own action. Cover user/global ask plus project allow,
  higher-scope deny plus lower-scope allow, per-layer last-match, multi-resource
  aggregation, wildcard and relative paths, and replayed/expired approval receipts.
  Bind every assertion to the actual decision trace; do not test only a helper mock.
- **Memory lifecycle (`AX-371`, `ACC-MEM-02`):** Test the approved target in
  `ARCH/product/MEMORY.md`; runtime implementation and acceptance remain open. A new
  store uses local scoped project advisory capture, while migration preserves its prior
  effective capture mode. Automatic global inference is off. An admitted explicit
  `/memory remember` request saves only exact user-authorized content once in its
  resolved scope, without second approval; model-added claims get no inherited consent,
  and ambiguous scope is clarified. Cover explicit-only, ambient and off modes; retrieval
  disablement is distinct from capture disablement.

  Verify preferences survive source changes, while repository facts become bounded
  revalidation leads and cannot establish current API/build/configuration truth until
  checked. Current task instructions and code/configuration win. Forget, disable, dismiss
  and purge advance a durable capture/retrieval generation; race pending extractors,
  workers, queued ContextEpochs and restarts to prove old observations cannot resurrect.
  No repeated prompt occurs merely because a source file changed.

  Exercise exact ProjectIdentity through Thread creation, Run admission, worktrees,
  search, retrieval, export and purge. Test moved/ambiguous repositories, clones,
  monorepos, credential-bearing remotes, symlinks and backup/restore. For children,
  require bounded source selection intersected with user/managed policy, Run consent,
  profile settings, adapter capability and egress scope; default parent/sibling sharing
  is none. Child capture remains advisory and cannot create user confirmation, policy,
  task truth or evidence. Replay a dispatch and ContextEpoch idempotently; intentional
  refresh uses a new epoch.

  Test SQLite event/projection/FTS/outbox transaction boundaries, stable request IDs,
  conflict/CAS editing, concurrent writers, bounded quotas/retrieval, expiry,
  corruption/newer schema, crashes before/after commit, lost outbox acknowledgement,
  redacted export, single-record forget, bulk-purge confirmation and delayed audit
  receipts. Do not claim complete arbitrary-secret detection. `/learn` and `/analyze`
  perform bounded read-only analysis: never run package scripts/tests or silently write
  `.horizonrules`; export requires explicit Preview/Apply through Guard. Compare
  no-memory, explicit-save and ambient modes for quality, false recollection, correction
  time, context cost, latency and confidence, with participant/task limitations. Anecdotes
  and synthetic fixtures do not establish product-market fit.
- Audit and effect recovery (`AX-372`): verify current local keyed-MAC semantics and
  reject claims of public signature or off-box authenticity. Exercise key replacement,
  relocation, rotation, sink loss, and bundle verification under the selected proof
  design. For effects, crash before/after external execution, between prepare and
  terminal receipt, and between event append and projection; recovery must reconcile
  stable effect IDs and preserve `UNKNOWN` without duplicate replay. Include an
  external fixture that can report whether an idempotency key was committed. Exercise
  bounded hot/archive storage, verified range archival and restart, archive corruption
  or unavailability, high-water admission, full storage, and preservation of the
  protected control/effect reserve; verify that no effect dispatches without durable
  capacity for prepare and terminal evidence.
- Analytics projection recovery (`AX-382`): compare every analytics row's
  `DurableFactRef` with its canonical owner record, including store/aggregate/sequence,
  event/schema identity, payload digest, and audit reference for security effects.
  Inject missing ranges, corrupt sources, digest/ID mismatch, schema upgrades, crashes
  during projection rebuild, Thread migration, and archived audit refs. The result must
  be deterministic, quarantine invalid rows, and show exact incomplete-coverage ranges
  in query/export; it must never turn unknown/missing usage into zero or task/effect
  success.
- Tool formatter/recall (`AX-383`): compare each command-family formatter against
  unfiltered output on paired tasks. Check exact original-byte retrieval, artifact
  digest/ownership/retention and pin behavior, formatter omissions against verifier
  evidence, argv and stream/exit semantics, and fallback when artifact admission,
  recall, or decoding fails. Measure verified task success, evidence recall, tokens
  by class, provider-reported cost, latency/retries, and RSS; byte reduction by itself
  is not a pass criterion.
- Skill/tool capability inventory (`AX-373`, `ACC-SKILL-01`,
  `ACC-TOOL-DISCOVERY-01`): test skill discovery, explicit activation, content
  digest/source changes between discovery and use, built-in/skill and skill/skill
  name collisions across multiple plugins and duplicate same-source paths; assert
  stable `/<source-kind>:<source-id>:<skill-name>` keys and path disambiguation,
  visible full-source suggestions independent of load order,
  `/skill` manager separation, and symlink/frontmatter rejection. For deferred tool
  catalogs, use a large synthetic MCP/tool set to bound search candidates and tokens;
  cover exact-ID and natural-language search, malicious metadata, only-selected
  schema materialization, permission filtering, and schema/catalog/permission races
  before dispatch. Prove no execution happens during search and stale/guessed tools
  fail before effects. `allowed-tools` is metadata, never permission. Any script
  must use the same Guard/Sandbox/Audit path. Candidate LSP/web/MCP resource/prompt/
  Code Mode tools require their own security and conformance acceptance before they
  appear in a model schema.
- First-party skill library (`AX-418`, `REQ-SKILL-006`, `ACC-SKILL-01`): activate every
  bundled SWE/architecture/agile skill only through the existing progressive loader;
  check metadata-only discovery, exact body/resource digest, scope, context budget,
  source qualification, permission filtering and cancellation. Artifact capability and
  diagramming guidance reuse the single AX-411 skill registration. Compare each skill
  with a matched no-skill control for accepted correctness, regressions, model/tool
  calls, tokens, latency and unsafe effects; include failures and uncertainty and
  revise/remove a skill that does not meet predeclared usefulness criteria. Do not
  assert usefulness from presence, activation, or model self-report.
- OpenCode TUI comparison tests (design-derived, not peer implementation reuse):
  acceptance should cover home/empty state, normal and shell submission, active model
  and tool status, permission/question blocking, child navigation, narrow/wide
  terminals, theme/preferences, and reconnect. Verify search navigates beyond the
  visible recent-message window, and show steer versus queued input status explicitly.
  Reconnect must use durable cursors and report gaps; an SSE reconnect or peer UI
  source trace alone does not prove replay correctness. This pass inspected source
  only; it did not launch OpenCode's TUI or run HorizonCode UI tests.
- UI/server history-boundary tests (OpenHands Canvas comparison): load a bounded recent
  page, scroll older pages, inject a cursor gap, unsupported filter, empty fallback
  page, out-of-order event, duplicate event, websocket resend, and optimistic echo.
  The UI must mark incomplete coverage, replace projections from canonical replay, and
  never let an optimistic bubble or empty fallback prove event absence, export
  completeness, or Task evidence. Test reconnect and server restart independently.
- Session-artifact fault matrix: concurrent writes racing the encoded-byte quota;
  oversize streaming without preallocation; temp-file symlink/replace races; duplicate
  digest with mismatching bytes; file flush, atomic rename, directory-flush and event
  append failures; disk-full and power-loss/restart at each boundary; orphan cleanup
  with a missing/unreadable directory entry; active lease and retention races; retained
  checkpoint/evidence/export/quarantined-tail references; corruption, truncation, wrong length, future
  schema, MIME mismatch, SVG/HTML active content, decoder timeout, decompression bombs,
  pixel/expansion ceiling, and media payload omitted from session export. Test every
  advertised filesystem durability backend; a backend that cannot meet the configured
  contract must refuse durable commit or report the explicit weaker mode.
- Copy-on-write artifact migration: interruption after each copied object, event,
  manifest write and generation switch; restart from source; power loss around atomic
  manifest publication; unsupported/newer schemas; source digest changed; duplicate
  IDs; corrupted target; rollback before switch; and GC while old/new generations or
  export jobs are retained. The original generation must remain byte-identical and
  authoritative until the complete target graph verifies.
- Repeat external requests using stable idempotency keys; inject duplicate delivery,
  mismatched content under a reused ID, timeout-after-commit, and provider response
  loss. Require an effect receipt or visible `UNKNOWN` result.
- For multi-file edits, fail on a later invalid hunk, symlink swap, changed base hash,
  permission loss, disk full, and process death. All files must be staged/preflighted
  or every partial effect must be durably enumerated.
- Native direct-turn response admission (`ACC-LOOP-01`, AX-003) must exercise all three
  versioned runner ceilings (distinct-call count, aggregate streamed argument bytes,
  retained decoded-response bytes), malformed JSON, schema-invalid mixed batches,
  duplicate and missing call IDs, unadvertised tool names, finish/call mismatch,
  missing finish markers, output-limit partial responses, and cancellation after a
  provisional tool call. Every rejected or cancelled batch must have zero durable
  `tool/call` and `tool/result` events; cancellation may retain bounded partial text.
  Unsupported schema keywords fail closed. Run deterministic fixtures with no live
  provider. `ACC-PROV-RAW-01` separately specifies raw post-content-decoding body and
  SSE-line bounds; AX-005 now has local boundary/overflow, consumer-drop, and
  loopback connection-close tests. The raw-transport acceptance bundle remains open.
  Neither acceptance row claims a bound on process RSS or an
  HTTP-client chunk allocated before the adapter receives it.
- Managed response batches must additionally exercise rotated/non-adjacent calls,
  oversized nested arguments, stream overflow, repeated rejected batches, and saved
  “always” approval. An over-limit or malformed unstarted batch dispatches none by
  default. Managed controller admission and effect reservation require their own
  controller/effect acceptance; direct-runner tests do not substitute for them.
- Concurrency tests: competing task claims, expired lease with stale writer, two
  controller processes, concurrent budget reservations, overlapping worktree writes,
  deterministic merge order, late peer messages, duplicate event IDs, cursor gaps, and
  slow consumers. Control/approval/cancel lanes remain responsive while bulk work is
  saturated.
- Verify the merged integration revision, not only isolated worker worktrees. A
  conflict becomes evidence and a new bounded task; never silently select one result.

### Audit and filesystem/network boundaries

Run the audit matrix in `ARCH/acceptance/ACCEPTANCE-MATRIX.md` `ACC-P1-04`: target-file byte/metadata snapshots
around actual CLI `verify`/`replay`/`census`; corrupt/missing head; torn line; corrupt or
missing segment; unreadable file; failed `read_dir`; iterator error; valid initialized
empty store; same- and cross-process writers; lock timeout/loss; sequence duplication;
head/segment/root mismatch; explicit repair preserving original bytes; access-stream
failure; authorization by actor/run/session/destination; redaction canaries; and
prepare/terminal reconciliation. Verify reads may not repair or rewrite evidence.

For every supported sandbox tier, execute `ACC-P1-01` on that actual OS/backend. Test
read/write roots, symlink/rename races, inherited file descriptors, subprocesses and
descendants, DNS/IPv4/IPv6, loopback, Unix sockets, helper services, VM sockets, proxies,
allowlist bypass, missing enforcement binary, and capability changes. Record observed
network reachability separately from syscall restrictions. Unsupported or unproven
requested guarantees are refusals. Linux namespace isolation, macOS Seatbelt, and
Windows paths need separate fixtures and evidence; one OS run cannot establish another.
Also prove `REQ-SEC-026` against real model-controlled child processes: the worker
cannot read or mutate canonical state or reach operator control, and approval comes
only from an authenticated trusted ingress. Same-user path checks alone are
insufficient.

Security suites include secret canaries through prompt, model errors, tool output,
audit, analytics, crash/panic reports, TUI notifications, exports, and peer receipts;
path/command injection; malformed config and partial writes; symlinked state/config;
extension archive bombs/traversal; untrusted web/MCP/skill instructions; stale policy
snapshots; privilege escalation; and reduced-approval/full-access composition.

### Providers, local runtimes, agents, and quotas

Treat `{provider, exact model, server version, tokenizer, prompt template, tool-call
parser, context limit, quantization}` as one tested route. A compatible HTTP endpoint
does not prove tool-call correctness or usage accounting.

For each supported hosted or local route test: authentication errors; 429 and
`Retry-After`; stream interruption; duplicate/partial tool-call chunks; invalid JSON;
thinking/reasoning fields; tool-choice modes; parallel calls; cancellation; context
overflow; output/token cap; cache read/write reporting; usage omission/duplication; late
usage; currency/pricing source; and provider status reset. Required missing capability
means route refusal or an explicit, accepted user override.
For parallel calls, deliberately complete safe calls out of order and assert that
canonical events preserve actual completion order while the next model-visible
projection emits call/result pairs in provider-response `call_ordinal` order. Crash
after one call settles and before the rest: replay settled receipts into the same
ordered projection without repeating their effects; preserve failure/cancel slots and
reject duplicate IDs before dispatching any call in that malformed batch.

Output termination gets a dedicated decision table: completed, pre-content context-window rejection,
explicit requested output cap, validated server remaining-context cap, and unknown
finish reason. Inject generic `length` with a requested cap, a smaller remaining-context
cap, missing usage, mismatched route fingerprint, local-server version/template drift,
partial text, malformed partial tool JSON, provider-side tools enabled, streamed
side-effect receipts, user input/cancel during compaction, budget reservation loss,
compaction failure/truncation, retry route outage, and a second truncation. Assert that
`compaction.auto=false` blocks all automatic recovery paths and that one shared
logical-step recovery admission prevents a second retry across provider rejection
then output truncation (and in the reverse order). Assert that provider-hosted
execution is refused before dispatch for HorizonCode-managed turns and
can never count as a local effect receipt; partial tool arguments never execute;
incomplete assistant attempts survive restart but are excluded from completed
conversation context; both attempts and compaction are billed/recorded independently;
and retries never recur for the same `logical_step_id` after recovery depth is consumed.
Use Cline's local-model recovery only as a peer design precedent, not as evidence of
HorizonCode behavior or universal provider semantics.

Evaluate Ollama, LM Studio, vLLM, SGLang, MLX-LM, and llama.cpp with the same
model-weight/quantization where the backend supports it. Record the exact template and
parser. Measure tool call validity, schema adherence, cancellation latency, context
overflow, token/usage provenance, queueing and concurrent sessions. Do not call an
OpenAI-compatible endpoint “compatible” beyond the individual tested capabilities.

External-agent adapters (ACP and CLI/process) need per-capability tests for discovery,
path pinning/re-probe, install staging, launch, permissions, model selection, progress,
usage, cancellation, resume, child visibility, workspace ownership, output capture,
disconnect, and retries. Unsupported values stay `unknown`; peer completion does not
pass a task. Subagent quota tests distinguish HorizonCode-enforced launch budgets from
opaque internal provider quotas. Verify aggregate deduplication when parents and
children both report usage; preserve currency, basis, freshness, and provenance.

OpenCode provider coverage adds a snapshot-specific registry suite. Use the exact
upstream commit and provider docs captured in
[`opencode-provider-inventory.md`](opencode-provider-inventory.md); its 2026-09-28
historical global-feed snapshot has 225 provider IDs/8,253 model records, while the
2026-10-01 refresh has the same 225 IDs/8,339 models (SHA-256
`448ae274adb22c1b8fdff113a43eaec149a5e4f6b868ac299b5d545d1d465b8d`). The current
refresh records 51 named documentation entries plus Custom and 32 core integration
modules; the separate Go directory remains on its dated 2026-09-28 snapshot. Cline's
pinned source inventory contains 228 effective registrations (211 generated specs,
17 runtime-only, 29 overlapping generated/runtime records) and 45 key-mapping rows.
These are separate upstream inventories, not HorizonCode support claims. Tests must
detect newly added, removed, renamed, or
auth-changed entries and fail into review-required/unknown state; they must never
auto-enable new integrations. Feed fixtures must cover malformed, deep, oversized,
duplicate, unknown-version, changed-origin, hostile header/body, untrusted
`npm`/`env`/endpoint fields, partial fetch, expiry, cache corruption, and concurrent
refresh. Verify source/digest provenance, last-good-cache retention, freshness display,
offline primary behavior, and immutable route snapshots across a later refresh. Confirm
that unknown provider/auth methods stay inert and that every discovered provider has
either a pinned auth-evidence reference or an explicit unknown state.

For each integration marked usable, test its exact auth method and protocol independently:
API key/token secrecy, cloud identity chain selection, OAuth state/PKCE/device-code
polling and cancellation, callback collision/timeout, expired/revoked credential,
least scope, missing registration, terms restriction/conflict, wrong account/tenant,
model availability, and all provider-stream/tool/usage failure cases above. Mock or
test only a HorizonCode-owned OAuth client registration. Assert that OpenCode-specific
client IDs, `auth.json`, token cache, and environment credential values are never
read, copied, emitted, or inherited by model/worker processes. A provider page entry,
mock response, or reusable protocol implementation cannot promote a row to usable.

A successful HorizonCode Go probe is local conformance evidence only. Verify that the
UI, CLI, documentation, and release notes do not call HorizonCode an OpenCode-validated
client unless the current official validated-client list explicitly includes it.

The OpenCode Go connector needs protocol contract tests and a separately authorized
live acceptance (`ACC-PROV-OC-GO`). Test the distinct general catalog feed
(`https://models.opencode.ai/api.json`), Go availability directory
(`https://opencode.ai/zen/go/v1/models`), and fixed inference origin separately; assert
the Go key never goes to the general feed. Include fixtures for the observed
2026-09-28 drift (225 global provider IDs, 33 models in its `opencode-go` record, 43
IDs from Go `/models`, and only 30 models with a current documentation endpoint map).
The live test must refuse any ID without an exact locally versioned model-to-path map,
and must check that the map contains no arbitrary host or path. It must test the three
wire families independently: `/responses`, `/chat/completions`, and `/messages`.

The opt-in live test chooses an ID only from the intersection of the current Go
directory, a current official price/offer source showing zero listed model price, and a
locally supported/conformance-tested route. It must use a user-authorized Go API key
configured locally through the secret broker; never ask the user to paste a credential
into chat or commit it. Record retrieval time, exact model ID, source/catalog digests,
adapter/build revision, route capabilities, HorizonCode User-Agent, whether stable
opaque `x-opencode-session` affinity arrived, observed usage/quota and any charge
evidence, but no key, session ID, workspace name, or repository path. Exercise one
bounded coding request, a stream, capability-backed tool calling, cancellation,
provider errors, and usage/quota handling. The 2026-09-28 limited-time zero-price
examples are not permanent fixtures; Go remains a subscription service. If no eligible
model/account exists, report `not applicable` or `blocked` with evidence, never PASS.
Do not run this live test by default in CI.

Provider projection fixtures must include absent, malformed, and conflicting optional
capability fields. In particular, a missing `tool_call` field must not enable tool
calling; `supported | unsupported | unknown` must survive refresh, cache, route
snapshot, UI explanation, and request-materialization paths. Unknown capability may
not satisfy a required task capability and must not silently emit that feature in the
provider request. Include refresh rollback and old-snapshot/new-catalog cases.

### UI, commands, settings, and accessibility

- Use an actual terminal matrix: truecolor, 256-color, ANSI-16, monochrome,
  `NO_COLOR`, `TERM=dumb`, slow/remote terminal transport, common shells and terminal
  multiplexers. Test keyboard collision discovery, custom remapping, composer focus,
  paste, resize, reconnect, and interrupted rendering.
- Check transcript/composer stability, virtualized large output, command palette,
  focus/docking, diff/editor modes, large/binary file handling, dirty buffers, external
  editor roundtrip and concurrent disk changes. At wide widths, verify the exact
  Explorer/editor-left, chat-center, Tasks-right default. Selecting a file opens or
  activates its tab in the left dock group and expands that pane while chat stays
  central; background work must not steal focus. Exercise resizing all three regions,
  swapping Explorer and Tasks between side slots, keyboard move/drop/cancel,
  collapse/restore, maximize/restore, invalid
  minimum widths, restart persistence, and restored focus/layout after an overlay.
  At narrow widths verify focus layout (no compressed unreadable columns), one-action
  pane switching, and preservation of task/composer state. Verify task checkmarks derive
  only from current independent PASS evidence for the integrated revision. Validate
  screen-reader labels, glyph
  alternatives, contrast, high contrast and reduced motion.
- For each representative intent, invoke it from every available button, command
  palette entry, slash command, and shortcut; compare the resolved action ID, owning
  controller result, permission decision, and visible result. Test state-dependent
  unavailable reasons and keyboard/pointer parity. Composer `/`, `@`, `#`, and `$`
  suggestions must preserve draft/focus until explicit commit; command arguments may
  use a second suggestion stage. Verify `@file:` inserts a reference without opening
  a document, while Explorer selection opens the left-dock document tab. If prompt
  history is provided, selecting an entry fills the draft and never submits it.
- Task-list projection tests must show one requested task as the default row with a
  concise state and user-needed action; select it to inspect dependencies, attempts,
  Threads, worker executions, adapters, events, evidence, and diffs. Assert these
  execution identities are not peer rows in the default checklist, remain in
  controller/detail data, and that background completion changes the row/badge without
  changing focus, scroll, draft, or open document. Verify narrow focused mode restores
  the prior three-pane arrangement.
- Session-history UI tests cover searchable/paginated results, incomplete-coverage
  disclosure, explicit resume, delete confirmation, and preservation of the current
  composer/layout when browsing. Diff/rollback UI tests cover per-file/per-turn
  navigation back to chat, affected-file preview, cancel/confirm, and no claim that an
  external effect was reversed; never auto-stage or commit. These are focused-surface
  patterns only (`SRC-035`/`U-ICODE-TUI`), with HorizonCode semantics owned by
  `ARCH/product/UI.md`, `ARCH/core/SESSION-AND-THREADS.md`, `ARCH/acceptance/ACCEPTANCE-MATRIX.md`, and `AX-207`/`AX-369`/`AX-388`.
- Event-stream ordering tests interleave multiple tool calls, delay/fail subscribers,
  overflow bounded notification queues, and reconnect across a cursor gap. Assert
  start/progress/result ordering and exact call identity; cancellation and permission
  remain responsive, durable events are not silently lost, and the client reports a
  gap before resnapshot. iCode's inline-subscriber wait is only pattern evidence
  (`SRC-035`/`U-ICODE-TUI`); test HorizonCode's bounded sequencing contract.
- Composer attachment tests cover multiline paste, threshold crossing, exact original
  bytes/digest, large-text attachment preview, supported clipboard image MIME types,
  decompression/pixel bombs, unsupported formats, missing terminal clipboard support,
  disk-full/staging errors, cancellation, retry/recovery references, and cleanup only
  after all owners release the artifact. Assert raw base64 never enters the transcript
  and oversized user text is never silently truncated.
- Right Tasks-pane projection tests cover dependency order, multi-worker labels and
  adapter/model provenance (`unknown` stays visible), blocked/failed/waiting/verifying
  states, stale evidence, spec revision invalidation, integrated revision mismatch,
  and layout changes while events arrive. Clicking a worker opens its thread/detail but
  does not alter task state or implicitly cancel it.
- Credential-boundary tests for a future desktop/web client must prove API keys and
  session credentials do not reside in browser localStorage/sessionStorage as the
  canonical secret store; a UI adapter receives opaque refs, redacts diagnostics, and
  cannot turn confirmation policy or client-tool annotations into sandbox/confinement
  evidence.
- Workflow Builder tests (AX-377) cover typed parameters, graph cycle/missing dependency
  rejection, input validation, template version migration, changed-template digest,
  model/profile availability, permission ceiling, budget reservation, review-before-run,
  cancellation and process-crash recovery through the normal Run controller. Templates
  must not execute arbitrary script code or create a second scheduler.
- Extension manager tests (AX-378, `ACC-SKILL-01`) distinguish search result, staged, configured,
  authenticated, probed, enabled, and permitted states. Include malicious/changed
  manifests, license/source review, registry outage, duplicate IDs, missing/expired
  secrets, failed health check, tool-schema drift during a turn, cancellation and
  uninstall with active calls. Verify `/extensions`, singular/plural MCP, skill, and
  plugin spellings, `/connectors`/`/apps`, `/hooks`, `/workflows`, and `/marketplace` all open the same
  category-aware overlay on the expected category, preserve composer/layout state,
  and have no trust/enable/execute effect. Verify `/create-skill` opens the same
  Skills → Create view; its guided project/user scope, name/frontmatter validation,
  exact preview, cancel/decline, overwrite refusal, guarded write, and no automatic
  enable/script execution. Cover headless typed results, bounded
  category loading, cancellation, and loading/empty/stale/error presentation.
  Search/install never executes an extension. Verify the default Installed category
  shows only concise item/type/state and primary Add/Remove/Enable/Connect actions; advanced
  provenance, scopes, capability lists, probe details, and configuration appear after
  selecting an item or entering the staged review step.
- LitePSM catalog conformance tests (AX-393/407, ACC-MARKET-01) pin a dated
  LitePSM release and prove at least 500 unique, source-resolvable, type-qualified
  entries for broad release; report per-family/source counts and progress toward
  1,000. Count invariants exclude versions, duplicate mirrors, provider offers, and
  embedded bundle components unless separately published. Verify HorizonCode and
  AgentCowork consume that same catalog revision through their adapters. Test bounded
  metadata pagination, cursor restart/idempotency, deletion/stale/error visibility,
  malformed/oversized metadata, URL/redirect policy, and provenance/compatibility
  separation. Confirm HorizonCode does not run a second public-source crawler/publisher,
  execute payloads during search, or turn catalog presence into trust/enablement.
  Adapter fixtures prove conformance only; the 500-entry claim requires an actual
  pinned LitePSM snapshot.
- Connector lifecycle tests (AX-394, `ACC-CONNECTION-01`) distinguish a service
  listing from provider offers and per-account Connections; test multiple
  providers/accounts, secret-reference isolation, product-local auth, disconnect
  without package removal, Guard scopes/effect classes, and active-Run
  provider/schema/policy pinning. UI entry-point parity and category selection for
  Connectors are covered under AX-378/`ACC-UX-06`.
- Web capability tests (AX-376) cover redirect loops, public-to-private DNS rebinding,
  IPv4/IPv6 private/link-local ranges, credential-bearing URLs, sensitive query
  stripping, `no-store`/personalized response exclusion, cache expiry/size eviction,
  stale-cache labels, cancellation, response limits, duplicate fetches, project history
  opt-out/purge, and network guard/audit receipts. Compare cached and uncached results
  for digest/freshness correctness.
- Repository intelligence tests (AX-375, `ACC-REPO-LSP-01`) cover initial scan and incremental updates,
  ignored/vendor/generated files, symlink escape, rename/delete, dirty buffers,
  revision drift, stale symbol/reference edges, missing parser/LSP, malformed syntax,
  huge files/monorepos, cancellation, concurrent edits, and bounded cache/RSS. Exercise
  the shared LSP owner for definitions, references, hover, document/workspace symbols,
  implementations, and call hierarchy. Verify read-only operations have no workspace
  writes, external paths are guarded, lexical fallback stays available, and every
  context package reports its source commit and per-file freshness.
- **Incremental index and overlays** (`REQ-REPO-005..007`,
  `ACC-REPO-INDEX-01`, `ACC-REPO-OVERLAY-01`): run a supervised Rust index child
  without daemonization/network listeners; test optional-startup degradation and
  interactive fairness. Validate exact mutation/buffer/Git/watcher hints against
  BLAKE3 bytes, and cover exclusion/denied-path parity, credential canaries, access
  revocation and index-cache invalidation. Inject watcher overflow, event loss, parser
  panic, crash/restart, corrupt/incompatible schema/parser/grammar, interrupted
  migration/rebuild, cross-store generation failure, cancellation and resource
  pressure. Exercise immutable base plus multiple workspace overlays for add/change/
  delete/rename, tombstones, rebase, concurrent writes, main integration and stale
  retrieval handles. Compare overlay queries with a fresh full rebuild; missing or
  mixed generations must be typed stale/unavailable, never silently current.
- **High-level repository context/tools** (`REQ-REPO-008`, `ACC-REPO-TOOLS-01`): test
  `repo_query`, `repo_context`, `repo_impact`, and `repo_expand` schema/policy through
  one owner; batch exact-symbol, lexical, syntactic and semantic requests. Confirm
  TaskPackage is a bounded, digest-pinned projection under ContextPacket; the raw index
  is never inserted into context. Test handle scope/expiry/revocation/generation races,
  omission/provenance labels, model-context bounds, inaccessible files, unavailable
  index fallback, and stable `read`/`list`/`glob`/`grep` behavior. Count navigation
  calls and independently accepted tasks in matched evals; call reduction alone is not
  a quality result.
- **Deterministic ChangeReceipt pipeline** (`REQ-REPO-009`,
  `ACC-REPO-PIPELINE-01`): cover authorized edit finalization, index generation update,
  formatter/diagnostic errors, affected-test selection, policy-denied/unaffordable
  checks, and cancellation/failure/unknown effects. Bind every result to tested source
  revision and workspace/index generations. Verify all canonical statuses
  (`NOT_RUN`, `PASSED`, `FAILED`, `CANCELLED`, `UNKNOWN`), missing checks and partial receipts remain visible;
  edits/checks obey Guard/Sandbox/effect journaling, and neither a receipt nor a passing
  test can mark a Task/Run `PASS` without independent verification.
- UI resource benchmark (AX-374) records startup/idle/active RSS and PSS, CPU, render
  latency, peak transcript/search/tree size and allocation behavior on fixed terminal
  sizes and corpus digests. Measure HorizonCode process tree separately from provider
  or local model server. No RAM target becomes a release claim until a baseline and
  reference hardware are published. Include a large preloaded history with sustained
  token deltas while scrolling/searching; measure allocations, render latency, retained
  virtualized-window size, and whether stale events are coalesced without losing
  durable boundaries. OpenHands Agent Canvas's array-copy event append is a source-path
  risk signal, not a reproduced defect or an architecture to copy.
- Every semantic color is configurable through `/settings`; validate contrast and
  preserve distinct status/error/warning/approval meaning without color. Preview before
  apply; invalid or conflicting palettes are rejected with a useful explanation.
- Settings tests cover global/project/run precedence, schema version migration,
  effective value/source/lock display, invalid values, reload and restart boundaries,
  managed policy locks, stale agent capability snapshots, and settings that change only
  future runs versus active immutable policy.
- Command registry tests generate help/completion from schemas; unknown command,
  alias collision, malformed arguments, unavailable capability, stale ID, quoting,
  path spaces, Unicode and command-like user text never fall through into a model
  prompt or action. `@agent`, `@file`, `@task`, `@run`, and `@symbol` mentions resolve
  deterministically and never launch/grant authority by themselves.
- Search UI tests cover `Ctrl+F`, `Ctrl+Shift+F`, `/search`, CLI JSON paging, current
  session/global scope, project/date/role/archive filters, display-timezone conversion,
  accessible keyboard navigation, exact hit reveal/highlight, title-only open, stale
  target and corrupt-session states, coverage banners, retry/rebuild, fast query
  cancellation, composer/draft preservation, search privacy settings, tool-output
  indexing opt-in, purge confirmation, and `NO_COLOR`/narrow-terminal layout.
- Agents panel tests include native and external agents, actual provider/model vs
  peer-managed/unknown values, nested visibility gaps, attempt tree, cost/quota sources,
  soft warnings, hard limits, stale quota, muted channels, pause/cancel responsiveness,
  failed connection, and recovered cursor snapshots.
- Usage and quota tests additionally include delayed/stale provider observations,
  reset-period rollover, partial provider failures with retained-but-stale snapshots,
  per-agent attribution gaps, parent-plus-child aggregate deduplication, and cross-
  provider cache fields whose wire schema or billing meaning differs. A stale remote
  quota observation never frees or creates a HorizonCode local reservation. If the
  adapter cannot report cache/quota usage, UI and exports preserve `unknown`; they do
  not infer zero from missing values. Use Kilo/CodeBurn/Nanobot only as source-specific
  parser and privacy test fixtures after license review, not as budget authorities.
  Verify soft-warning thresholds persist at their declared Settings scope across
  restart, dismissal/snooze cannot disable a controller-enforced ceiling, and a
  soft-warning "continue" response is not recorded as user approval to raise a hard
  budget. Reset/stale quota windows and Kilo-style ephemeral warning state are not
  valid defaults for HorizonCode persisted settings.
- Provider quota-observer contract tests (AX-386) are distinct from model usage
  accounting: verify per-provider/account in-flight coalescing, one waiter cancelling
  without cancelling another, forced refresh under minimum intervals, persisted 429
  backoff, 401/403 and unsupported states, timeout and malformed/partial multi-window
  responses, reset rollover, last-good retention, cache bound/pruning/reopen, provider
  failure isolation, and that the adapter cannot read raw credentials or write auth
  state while `CMP-secrets` remains the only owner of its authorized token refresh.
  Assert a provider quota response can never mutate/release a local budget reservation.
  Test UI freshness and
  status labels separately from source parsing.
- Provider quota command tests must prove `/providers quota` and
  `hzcode providers quota` read only the local cache, while explicit refresh requires a
  supported documented endpoint and emits no credential/body data in output or audit.
  Disabling background refresh must not disable explicit refresh; provider failure must
  not block metadata refresh, inference, or another provider's quota view.
  Project instructions/config cannot enable polling. Confirmed local clear/retention
  removes whole observations and dependent analytics projections while leaving provider
  credentials and remote account state unchanged.
- Test notification preferences independently: per-event/per-channel disable, sound
  off, terminal bell off, quiet hours, rate limiting, desktop permission denied, and
  required approval/stop persistence. Muting sound or desktop delivery never hides the
  in-client blocking state or durable event.
- “Auto-approve eligible asks” cannot affect explicit deny, protected paths,
  production/deploy/publish/push/merge, missing sandbox, external network, or expired
  run authority. Turning it off immediately fences future dispatch; in-flight effects
  are reconciled. Preference is not activation.

Current target commands, argument contracts, `@` namespaces, agent panel and settings
are in [`ARCH/product/COMMANDS-AND-SETTINGS.md`](../ARCH/product/COMMANDS-AND-SETTINGS.md).
They are designs; no interactive TUI exists at the source baseline. The attach tests
are **same-host/local-socket only**. A user-managed server may run headless; it does not
imply SSH UI access, remote-control protocol, multi-user isolation, or HorizonCode cloud
hosting.

## Control API, app-server, and detached-client tests

- Exercise identical typed methods through in-process and same-host IPC clients;
  verify equivalent results/errors and that all routes still call the same owner.
- Negotiate protocol major/minor/capabilities; refuse an incompatible major or
  required missing capability without partial mutation. Fuzz oversized/deep frames,
  duplicate JSON fields/IDs, deadlines, changed idempotency payloads, and method scope.
- Race two launchers for one state root; test stale socket/PID files, symlink/junction
  redirection, owner/mode/ACL checks, PID reuse, server identity mismatch, and lock
  loss on each supported OS. Never signal a process based only on stored PID data.
- Disconnect the TUI during a multi-hour run, kill/restart the client, and reconnect
  at each aggregate cursor. Verify `/quit` detaches without cancelling, `/attach` does
  not dispatch work, duplicate event replay is idempotent, and gaps force a new
  snapshot without pretending to have a total order across Run and Session streams.
- Kill the supervisor between mutation intent, canonical owner write, grant, response,
  and projection update. Retry the same `delivery_id` and query status; assert one
  domain event/effect and a truthful `UNKNOWN` when the owner cannot reconcile.
- Flood a slow client and all non-control lanes with catalog/history/event traffic;
  control cancel, permission, pause, and maintenance requests must meet the configured
  dispatch deadline or return an explicit overload. Buffers stay within their byte
  caps and report a cursor gap/disconnect, never silently discard durable events.
- Verify worker/plugin subprocesses cannot read the controller endpoint or inherit
  operator capabilities; same-user local process trust residual is documented.
- Crash during state recovery and update handoff; do not accept mutations until the
  control stream and nonterminal Run/active Session owners reconcile. Test a platform
  with no accepted IPC/supervisor backend and ensure detach is reported unavailable.
- Stop an idle supervisor only when all Runs, work permits, approvals, effects, and
  maintenance operations are settled. Concurrent new work must win or lose atomically
  against idle shutdown without a duplicate controller.

## Multi-hour reliability and resource benchmarks

Build the internal acceptance workload before claiming long-horizon capability. Use
real multi-step repository tasks with hidden acceptance tests, dependency edges,
ambiguous requirements that require clarification, at least one intentional spec
revision, integrations/PR simulation, and optional parallel work. Run at short (10–30
minute), medium (1–3 hour), and long (4–8 hour) tiers; 25-hour experiments are a later
stress test, not an initial requirement. Kill the process/controller at random
durability boundaries and recover from cold start. Include offline waits and provider
quota exhaustion. No task is complete until final integrated-revision verification.

Benchmark paired baselines with identical repository commits, objectives/specs, model
weights and parameters, provider route, tool permissions, context limits, wall-clock,
token/currency ceiling, concurrency, temperature/seed where available, and verification
budget. Compare a single-agent loop, HorizonCode without delegation, HorizonCode with
bounded delegation, and selected peer agents (Codex, Claude Code, OpenCode, Cline,
Aider, Qwen Code, OpenHands, Goose). Use at least three pairs only as smoke evidence;
publish sample size, distributions, confidence intervals or uncertainty, raw per-task
outcomes, failures, and rerun policy. Do not compare public leaderboard scores as though
they were same-condition trials.

Treat event-store replay benchmarks separately from code-task benchmarks. The OpenHands
SDK replay/index/recovery benchmark is a candidate only after its runtime repository,
script, dataset, event corpus, and license are independently pinned and reviewed; it
measures storage/replay behavior, not SWE-Bench issue-solving quality. Keep it in a
separate lane and do not combine its score with coding-agent task success.

### Public benchmarks to include

- **Terminal-Bench 4.0** (released 2026-08-28) for terminal tasks and long-running
  workflows. It uses calibrated CPU/memory/time constraints, adjusts saturated tasks,
  and documents a flat eight-hour task timeout. Use its Harbor runner and pin the task
  suite/version; report container/runtime, timeout and agent harness. It complements
  rather than replaces coding-repository acceptance. [Official Terminal-Bench 4.0
  announcement](https://www.tbench.ai/news/terminal-bench-4-0).
- **SWE-Bench Pro V2** (leaderboard updated 2026-09-22) for realistic issue resolution
  across 642 tasks and 11 repositories. The revised process describes two-sided task
  gates, no network during the agent phase, and grading on a pristine image. Pin the
  dataset, Harbor task environment, images, verifier, network policy and grader; publish
  both agent and grader details. It cannot by itself measure long-horizon recovery,
  user intent alignment, or TUI workflow. [Official leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2),
  [dataset and methodology](https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/README.md).
- Keep SWE-bench Verified and older Terminal-Bench versions as historical references
  only where comparison is useful; document contamination, saturation, task/patch
  validity, grader changes, network, retries, and model snapshot. Do not merge scores
  across incompatible versions.

Benchmark results need exact provider/API/model snapshot and price sheet. If usage is
not reported, label estimated or unknown; if a hosted agent hides its internal spend,
do not claim cost parity. Measure actual spend where observable and separately report
latency, total wall time, active inference time, waiting, and human time.

### Memory and throughput measurements

Measure cold-start, idle, active single run, compaction, indexing, and N concurrent
runs. Record process-tree RSS **and** PSS where available, peak/steady memory, allocator
growth, cache use, CPU time, disk growth, startup latency, event lag, tokens/sec, tool
queue delay, and cancellation latency. Include hosted models and local inference as
separate resource owners: model weights/server memory are not agent-harness memory.
Use fixed hardware/OS and state whether local embeddings/model weights are resident.

jcode's README reports Linux PSS figures for its own measured setups; these are
project-reported and must not be compared directly to HorizonCode RSS or used as a
target without reproducing its process tree, workload, cache, and embedding settings.
Keep process overhead and model-server memory as separate series. A memory optimization
must retain task completion, tool correctness, context recall, and recovery results.

## Metrics and release gates

Report at least:

- Verified completion and regression rate per task category.
- Intent-alignment failure and consequential-ambiguity escape rate.
- False completion, false stop, false continue, and pause-fence violation rates.
- Crash recovery success, recovery time, duplicated/unknown external effects, and stale
  worker write prevention.
- Correct tool-batch admission/refusal and no-progress loop rate.
- Cost per independently verified task, separated by source currency/basis; tokens,
  provider quota, elapsed time, waiting time, and human intervention.
- Context retrieval recall and context overflow; compaction loss against fixed probes.
- Context preflight must use saturating window arithmetic, return `ROUTE_UNSATISFIABLE`
  when output/buffer reserve consumes the route window, and return
  `PINNED_CONTEXT_OVER_BUDGET` rather than silently drop required pins. Calibrate
  pre-send byte estimates against provider-reported token counts for Latin, CJK, Arabic,
  mixed-script text, code, and serialized tool schemas; report drift by route/model
  class, ensure the safety margin prevents overflow admission, and never claim the
  estimate is a tokenizer measurement.
- Delegation benefit after context replay, integration, and merge costs.
- RAM/CPU/disk and responsiveness per active run and per worker.
- UI command completion, keyboard reachability, accessibility, and notification delivery
without masking state.

### Distribution, installation, and updates

- Interactive TUI startup update checks are background/non-blocking, cancellable, and
  rate-limited. Headless/CLI startup performs no implicit network check; explicit
  `hzcode upgrade --check` remains available. Test both cached update display and
  offline/stale/no-update outcomes; `CHECK_UNAVAILABLE` must never render as current.
  Default startup checks use `stable`; startup on `preview` is valid only after explicit
  user selection and only while signed preview targets exist. An unknown/removed
  channel must fail closed without falling back to another channel.
- Test TUF root bootstrap and rotation, threshold signatures, expiry, rollback/freeze,
  mix-and-match, metadata/target substitution, revoked keys, wrong channel/platform,
  length/hash mismatch, archive traversal/symlinks/zip bombs, unknown schema range,
  oversized release notes, mirror mismatch, and corrupt cache. No target activates
  before all signed metadata, digest, size, platform, and install-method checks pass.
- Test the explicit `Install` consent, `Later`, `Details`, cancellation, duplicate
  update invocation, and one-time prompt suppression. `Install` must not become
  auto-install from settings, project instructions, model output, cached metadata, or
  another CLI process. Details must expose target version/channel, publisher/source,
  notes, size, signature status, and active-run deferral before consent.
- Start a long-running task, approve a download, disconnect/reattach clients, and
  assert the current binary remains in use. Installation must wait at a safe restart
  boundary; it must not kill workers, change model/adapter snapshots, migrate live
  state, or mark the run complete. A pending update must remain visible after restart.
- Race update activation against starting a new run, run attempt, and standalone
  interactive model turn. One durable `SupervisorControlStream` must atomically
  arbitrate run admission, worker/direct-turn execution admission, and maintenance;
  it must fence new run/work admission before granting `MaintenancePermit`. Active or
  unknown worker/effect state, expired permit, controller restart, or stale binary
  digest must defer activation and must not reopen the gate until helper/swap outcome
  is reconciled. A confirmed rollback or successful target health check settles the
  permit exactly once.
- Crash at each boundary between `RunAdmissionIntent`, creation of the initial
  per-run stream head, `RunAdmissionGranted`, `WorkAdmissionIntent`, creation or
  reconciliation of the canonical session/attempt execution, `WorkAdmissionGranted`,
  `MaintenanceIntent`, `MaintenanceGranted`, and helper launch. Restart must reconcile
  stable operation IDs and exact run/session stream heads before acknowledging an
  operation or reopening admission; replay cannot create a duplicate run, direct turn,
  worker, budget reservation, or update operation. Corrupt/newer-schema control streams
  and unsupported cross-process locks fail closed rather than falling back to SQLite.
- Test `hzcode upgrade`, read-only `hzcode upgrade --check`, accepted and
  rejected channel selection, `/upgrade`, TUI startup notice, `/settings updates`, and
  structured/headless output. `--check` must never download or mutate state. Muted
  notifications/sound suppress only configured non-critical channels; explicit
  command output, security failures, and durable update state remain visible.
- Verify `hzcode upgrade --channel preview` is a one-invocation override and does
  not change the saved channel; only an explicit settings edit persists a new channel.
- Approve installation while work is active; after all work is terminal, stage
  application for normal shutdown/next launch without a second prompt, run
  interruption, or forced application restart. Cancelling a staged update before
  activation must leave the current version intact.
- Simulate concurrent CLI/TUI checks, process kill during each fetch/verify/stage/swap/
  health-check/rollback state, low disk, permission loss, failed startup, incompatible
  schema, interrupted migration, unavailable package manager, and symlink/junction
  replacement. State must recover to known-good version or a clearly blocked/refused
  state, never a false `UPDATED` result.
- Verify activation helper mode is the same signed HorizonCode binary, cannot bypass
  TUF/ownership checks, and is not a separately distributed updater runtime; exercise
  its platform-specific parent-exit and replacement protocol.
- Test first install separately from in-place update: validate platform/package-manager
  ownership, bootstrap-root authentication independent of the asset mirror, repair,
  uninstall preserving user data by default, and documented supported target matrix.
  Exercise every published OS/architecture in a disposable clean image. Shell and
  PowerShell wrappers, if added, are thin launchers and must be audited not to download
  and execute unauthenticated code or implement their own signature logic.
- Package-name checks are point-in-time evidence: recheck `hzcode` availability on npm
  and crates.io immediately before publication. Test `npm install -g hzcode` and
  `cargo install hzcode` in clean environments, ensuring no hidden installer side
  effects, no credential/state reset, and no unsupported platform claim. Test both
  installed commands (`hzcode` and `horizoncode`) with identical arguments, signals,
  environment, working directory, exit codes, state root, and `--version`; verify
  uninstall/upgrade removes or replaces only HorizonCode-owned links. The curl path
  remains unavailable until separate-file download, authenticated bootstrap root,
  signature verification, and platform-specific first-install tests all pass. Never
  test/publish `curl | sh` as a supported path.
- Release-pipeline tests cover locked reproducible builds, notices/SBOM/provenance
  gates, artifact and target metadata consistency, offline signing separation, release
  authorization, immutable publication, key rotation, and rollback rehearsal. A mock
  unsigned server proves parser behavior only and cannot qualify a release.

Release claims follow `ARCH/acceptance/ACCEPTANCE-MATRIX.md` gates. Any unsupported platform, provider, agent
capability, usage amount, cost conversion, or quota is explicitly unknown or refused,
not silently inferred. Security-relevant failure, incomplete acceptance sub-check,
stale spec evidence, or hard-budget exhaustion blocks `accepted` status.

## Sources and dated snapshots

- [Compaction upstream comparison](compaction-upstream-comparison.md) — pinned Codex, Grok Build, and OpenCode source comparison; distinct defaults do not imply a universal threshold. Historical OpenCode issues are failure reports, not source-contract evidence.
- [Cline v4.1.21 release](https://github.com/cline/cline/releases/tag/v4.1.21) — released 2026-09-24; documents local-model remaining-context output truncation recovery and explicitly limits automatic replay to text-only turns without tool activity. Treat this as route-specific peer evidence, not a provider guarantee.
- [DeepSeek-Reasonix releases](https://github.com/esengine/DeepSeek-Reasonix/releases) — checked 2026-09-27; Studio release notes report the image/event-log size and recovery problem that motivates `ACC-P1-09`. This is an upstream report, not a HorizonCode reproduction.
- [Codex Goals in the CLI](https://developers.openai.com/cookbook/examples/codex/using_goals_in_codex) — checked 2026-09-27; available in Codex CLI 0.128.0+; documents structured goal lifecycle commands, thread-scoped state, idle-boundary continuation, queued-input checks, no-tool-call suppression, and budget-limited stopping. These are peer workflow references, not a HorizonCode implementation or proof of multi-hour reliability.
- [Codex long-horizon task report](https://developers.openai.com/blog/run-long-horizon-tasks-with-codex) — useful empirical workflow report; not a reliability guarantee.
- [OpenCode provider directory](https://opencode.ai/docs/providers/) and [OpenCode Go](https://opencode.ai/docs/go/) — provider directory and general Models.dev feed refreshed 2026-10-01; Go counts/routes remain on the dated 2026-09-28 snapshot. The provider list, supported auth methods, model directory, prices, quotas and Go-client compatibility are volatile. Research pins and file maps: [`opencode-provider-inventory.md`](opencode-provider-inventory.md) and [`cline-provider-inventory-2026-10-01.md`](cline-provider-inventory-2026-10-01.md) for Cline commit `8eee168b80127b0c94bad849323754b5864865e7`.
- [The Update Framework specification](https://github.com/theupdateframework/specification/blob/master/tuf-spec.md) — metadata/target verification and repository-attack model; it does not authenticate the initial installer by itself.
- [Terminal-Bench 4.0](https://www.tbench.ai/news/terminal-bench-4-0).
- [SWE-Bench Pro V2 leaderboard](https://labs.scale.com/leaderboard/swe_bench_pro_public_v2) and [benchmark task/method README](https://github.com/scaleapi/SWE-bench_Pro-os/blob/main/README.md).
- [Agent Client Protocol](https://agentclientprotocol.com/) — protocol behavior must be capability/version pinned; ACP is not a scheduler or durable task database.

### Provider fallback and prompt-cache capability (`AX-384`, `ACC-P1-18`)

Use deterministic provider fixtures to pin a managed attempt's selected route and ordered fallback list, then change/refresh the catalog while the attempt is active. Inject transport failures before content, partial text, tool-call deltas, auth/quota/policy/protocol errors, cancellation, and budget exhaustion. Verify that only the typed pre-content transient case can move to an already-pinned compatible route, that every dispatch gets its own immutable route and usage evidence, and that visible text/tool calls are never duplicated. Include stale route, endpoint/policy denial, incompatible context/tool/vision requirements, and crash/recovery between fallback reservation and provider dispatch.

Prompt-cache fixtures cover byte-stable request prefixes, explicitly supported cache-control encoding, session-affinity/cache keys, unsupported routes, and local OpenAI-compatible endpoints. Confirm request reconstruction and translation of separately reported cache-read/write usage for each supported adapter/model; generic API compatibility alone must leave cache support and savings `unknown`. Cached input remains a distinct accounting class and cannot reduce the recorded input total. Record provider ID/model/adapter version, capability and pricing digests, raw request fixture digest, usage source, and tested environment. Deterministic fixtures use no live service and cannot prove a remote cache hit or lower bill. A separately authorized live OpenCode Go check remains the narrow task in AX-364 and is not implied by P1 fixture success.


Search query fixtures for AX-369 must include literal SQL/FTS wildcard characters (`%`, `_`, quotes), case-folding and Unicode normalization, alongside exact phrases; user text is literal unless wildcard syntax is explicitly designed and rendered in the UI. These cases prevent SQL `LIKE` implementation details from changing user intent.

## Final architecture reconciliation acceptance additions (2026-09-30)

Plan only; no product tests or builds were run in this documentation audit. Follow
DEC-090/091 and ARCH/acceptance/ACCEPTANCE-MATRIX.md ACC-UX-08. Inspect every action entry (button, key, palette,
slash) for one owner, exact target, availability reason, confirmation and durable
receipt; test narrow/monochrome/screen-reader layouts, focus/draft retention, required
attention without focus theft, offline/partial search, stale/duplicate responses,
reconnect, and distinct failed/cancelled/stopped/unknown/unverified/verified outcomes.
Usability testing must record actual participant/scenario/build observations before
claiming these defaults improve appeal or reduce effort.

Controller fault tests include spent+held+unknown+protected budget admission, every
reservation-event/head/projection commit crash boundary, cross-process contention,
multiple execution incarnations per attempt with stable redelivery keys, restart-safe
lease clocks, pause/resume/stop typed scope and priority, and metadata-only progress
churn. Compaction tests assert a single shared recovery allowance, auto=false on all
paths, bounded brief reconstruction, epoch source attestation, and no task/model attempt
ID collision. Test exact-byte/closed-manifest package drift, required-hook failure,
policy parse failures, audit terminal-append failure after effects, filtered export
proof limitations, MCP initialized lifecycle/direction, and refusal of any AG-UI network
listener until its separate decision. Test generic provider workspace lifecycle and
full dirty-files/buffer revision freshness. Deterministic fixtures do not replace real
OS confinement, filesystem durability, production signing, or authorized route evidence.

## Artifact/composer/performance/litePSM/installer expansion (2026-09-30)

Plan only; no runtime suite was executed. [Interactions](../ARCH/product/INTERACTIONS.md)
and [LitePSM integration](../ARCH/integrations/LITEPSM.md) define contracts; the
[acceptance matrix](../ARCH/acceptance/ACCEPTANCE-MATRIX.md) defines ACC-UX-09..13,
ACC-PERF-01, ACC-EXT-01 and ACC-INSTALL-02.

Use property fixtures over UTF-8 parts/byte preservation, duplicate display chips,
grapheme editing and CAS races; crash injection around artifact/draft/owner commits;
fake clipboard/renderer/route/capability matrices; adversarial decoder resources and
control sequences. Check every button/palette/command/key path produces the same
normalized receipt/event trace and preserves focus/draft on failure. Test reduced/off
motion, dark/light/high-contrast, ANSI/truecolor/monochrome, narrow terminals, remote
TTY, selection/scroll during streaming and partial Markdown highlighting.

Scheduler fixtures use delayed calls with known barriers, out-of-order completion,
live revocation and uncertain effects; verify settlement occurs promptly but model
observations are ordered. Code Mode fake tools verify nested ceilings and no ambient
I/O, approval bypass or replay. Compare ordinary versus program composition on matched
tasks with correctness/effect equivalence and inclusive latency; cache is observed,
not inferred from prompt digest. Warm/cold measurements publish hardware, terminal,
code/config/model/stub revisions, fsync mode, raw distributions and percentiles.

litePSM fixtures must fix the sibling schema/approval/journal/IPC compatibility gates
before real mutation acceptance. Fake lost-response/write/cancel tests require UNKNOWN
and safe reconciliation. Installer tests run only in disposable supported-platform
fixtures, never change this host's PATH/profile/permissions or publish artifacts.
Session import/branch, notebooks, side questions and feedback canaries must retain scope,
preserve original content and prevent unintended writes/approval inheritance.

## AX-124 headless diagnostic harness (2026-10-01)

`crates/horizoncode-cli/tests/perf_baseline.rs` provides an ignored release-mode
capture against the existing in-process loopback provider fixture. The fixture records
monotonic request arrival and response-start instants. The harness launches the actual
CLI binary, parses its NDJSON events, verifies completed text and list-tool turns, and
records raw samples, nearest-rank p50/p95, sampled child RSS on Linux, host/build/source
metadata, and digests for the executable Rust source tree and the performance/acceptance
contracts.

Run the deterministic helper tests with
`cargo test -p horizoncode-cli --test perf_baseline --offline`. For a release capture,
run
`cargo test --release -p horizoncode-cli --test perf_baseline --offline -- --ignored --nocapture`.
The default output is `target/perf/ax124-headless-diagnostic.json`; set
`HORIZONCODE_PERF_OUTPUT` to select another artifact path and
`HORIZONCODE_PERF_SAMPLES` to select 6–100 text samples (tool samples are derived from
that count). The fixture uses a synthetic API key and does not contact a live provider.

This diagnostic measures CLI process-to-turn/fixture-dispatch, first text event,
fixture-response-start-to-CLI-event, list-tool event duration, turn completion, process
exit, and sampled process RSS. It cannot measure key-to-paint, composer readiness,
first-token-to-paint, frame/animation cost, terminal backpressure, interactive
cancellation, idle UI CPU, controller queue/index costs, or managed scheduling because
those runtime paths are not implemented in the checked-out binary. Operating-system
page cache is uncontrolled; the first run uses a fresh HorizonCode home and later runs
reuse the home, so the report does not label them true cold/warm OS-cache samples.
The 2 ms procfs RSS sampler can miss brief peaks. A local fixture, WSL machine, debug
capture, or unaccepted host cannot establish release-machine budgets. Use this harness
to collect repeatable headless diagnostics; retain its JSON as a local/CI artifact and
do not mark `ACC-PERF-01` passed until the complete workload runs on an accepted
reference terminal/build with every required metric.

Local run record: the ignored report at
`target/perf/ax124-headless-diagnostic.json` contains 30 text and 10 one-tool release
samples on Linux x86_64 / WSL2, kernel `6.18.33.2-microsoft-standard-WSL2`, Intel
i3-1215U (4 logical CPUs), Rust 1.98.0, with a 1-minute load average of 1.23 before
capture. CLI spawn-to-fixture-dispatch was p50 55.7 ms / p95 93.4 ms; text-only
spawn-to-first-NDJSON-text-event was p50 57.8 ms / p95 94.5 ms; observed list-tool
event duration was p50 48.4 ms / p95 69.1 ms; sampled RSS was p50/p95 11.4/11.7 MiB
(text) and 11.8/12.1 MiB (tool). These tails are host-sensitive and process-inclusive;
they are not performance-target comparisons. Source revision was
`262bdb2fb8a2fef86d885a6c83ea49bae38bfcde` with a dirty worktree, Rust source tree
digest `a2e2f352826aa07397c8b066310334e06cb123fe667f35817c255caa816cec91`, and release
binary digest `5ed948dda9a0a547ab8a310b977f3067e5afb7fb046a7bb625c90aff597d3fe4`.
The accepted reference-machine flag is false and the artifact explicitly says it is
not an ACC-PERF-01 record.

AX-411 / `ACC-UX-12` verifies that bundled artifact skills use the ordinary skill
registry, collision-safe routing and digest rechecks. Capability output comes from
the actual renderer/model/integration snapshot and reports unsupported or unknown
states when evidence is absent. Diagram guidance supplies a text alternative and
theme-aware source without activating SVG/script execution. Optional recipe runs use
the existing controller, revision binding, budgets, cancellation and evidence
contracts; previews and recipe output cannot create verifier `PASS`. Report actual
tokenizer measurements only when available; otherwise label estimates and
unobserved activation/injection counts explicitly. The pinned public authoring
reference is `U-CLAUDE-ARTIFACT-SKILL` in
[`SOURCE-TRACEABILITY.md`](../docs/research/SOURCE-TRACEABILITY.md#u-claude-artifact-skill); it is not
the source of Claude Code's private bundled capabilities or diagramming skills.

## AX-405 offline skill inspection evidence (2026-09-30)

Implemented slice only; full ACC-UX-12 remains open. `cargo test -p horizoncode-config --test skill_inspection --offline`: 4 passed
(empty/Unicode/CRLF, rounding, content-free result, changed digest, missing file,
Unix symlink replacement).
`cargo test -p horizoncode-cli --test commands_cli --offline`: 10 passed (including
provider-free inspection, body secrecy, no session creation, existing listing/help
and refusal regressions). The CLI feature test failed before implementation.
Source hashes and environment: [record](source-audit-coverage/ax405-skill-inspection-2026-09-30.json).
The serial full workspace regression suite passed: `cargo test --workspace --offline -- --test-threads=1` (exit 0); ACP local mock tests required loopback permission outside the network sandbox. An earlier parallel run had one transient audit test failure; isolated audit and final serial workspace reruns passed. Heuristic tokens are not tokenizer measurements, performance evidence, resource totals or activation statistics.
