# Evaluation architecture

## Purpose and ownership

`hz-eval` is the shared offline-first evaluation runner and reporting interface for
HZBench, feature experiments and controlled competitor comparisons (`REQ-VER-019/020`,
AX-419). It consumes the production executable/ports and isolated task fixtures; it
does not replace production scheduling, Guard, budgets or verification. Evaluation
orchestration/statistics may use Python under [the language boundary](../05-MODULARITY.md).
[The test plan](../../research%20docs/tests.md) owns procedures and datasets;
[Performance](../contracts/PERFORMANCE.md) owns numerical budgets.

## Architecture and contracts

The flow is manifest validation → isolated repository/environment preparation →
pinned harness/model execution → complete trajectory capture → independent task
verification → immutable run record → comparison/report. Each attempt and independent
verification result is first retained as a separate immutable artifact; the run record
references and digests those artifacts and is sealed only after their terminal outcome
is known. Recovery never edits a sealed record. Setup failures, unavailable
routes, timeouts and harness crashes are retained outcomes. Setup failure, harness
failure, provider failure and unsupported routes are distinct typed outcomes. A benchmark PASS proves
only the benchmark's declared task rubric on its exact subject; product acceptance
still requires the relevant acceptance record.

The target command interface provides `hz-eval validate`, `run`, `verify`, `compare`
and `report`. Implemented slices provide `hz-eval validate` for bounded V1 records and
the fixed `hz-eval run --fixture smoke` mechanics fixture described below. General
task execution, independent verification, holdout access enforcement, run comparison
and benchmark reporting remain unimplemented. Dataset/task/config IDs are validated
references, never arbitrary shell arguments. A future run path cannot publish results,
acquire credentials or contact a live provider implicitly. Fixture subprocesses use
isolated roots, finite ceilings and explicit network policy. Required external
accounts/services remain authorization-gated.

The first execution increment is `hz-eval run --fixture smoke`. It is a fixed,
development-only harness-mechanics fixture, not a general task runner or a benchmark
quality claim. The command accepts no user-supplied prompt, repository path, shell
command, model, provider, route, or split. It requires an explicit `--output-dir` for
evaluation artifacts, which is distinct from and cannot select the temporary task
workspace. It always records `split=dev`, selects a scripted in-process provider,
uses a newly-created temporary workspace and session store, and has no provider
transport or network-capable tool in its advertised or authorized fixture tool set.
The materialized built-in tool set is pinned by the fixture manifest to
`apply_patch`, `edit`, `glob`, `grep`, `list`, `read`, `todo`, and `write`; `bash` is
explicitly denied and absent from the provider-visible schema.
The fixture task, prompts, tool calls, tool schemas, and expected output are versioned
with the fixture implementation. Every fixture execution has finite step, input,
response, event, workspace-content, serialized-snapshot, and wall-time ceilings.
For the smoke fixture these are four Runner steps, one tool call and 1 KiB total tool
arguments per response, 2 KiB model response, 256 KiB serialized trajectory, 256
observer events, 64 KiB captured file content, 4 MiB serialized workspace snapshot,
2 MiB conservative serialized workspace metadata, and a five-second total Runner
deadline. A ceiling hit, Runner error,
provider stream error, cancellation, or confinement refusal is retained as a typed
terminal run outcome; the command must not silently omit a failed attempt.

The trajectory and final workspace snapshot are bounded immutable artifacts stored
separately from the run record. The workspace snapshot preserves the exact testable
files (with declared exclusions and content digests), not merely a digest that cannot
be retrieved by a verifier. Both artifacts and the record are written without
overwriting an existing attempt; write/flush/rename failure leaves no record that
refers to a missing or partial artifact. The record binds the fixture version,
binary/source revision, task and criteria digests, tool-schema and policy digests,
initial/final workspace digests, workspace-snapshot reference/digest,
trajectory digest/completeness, and execution outcome. A non-Git fixture tree uses an
explicit `tree-digest:<blake3>` revision identity; it never fabricates a Git commit.
`harness_revision` identifies the source/build revision and is separate from
`binary_digest`; the executable digest must never be substituted for a source revision.
If the exact source revision is unavailable, use the literal `unknown` with a limitation and
exclude that attempt from source-revision-paired quality comparisons.
Fixture trajectory completeness is defined at a versioned `RunObserver` event-stream
boundary: complete means every event delivered at that boundary was retained in order
within the declared bounds. It does not imply capture of hidden reasoning, full model
request bodies, or internal Runner state that the observer does not expose.
The scripted fixture does not measure real model latency, token usage, cost, or process
resource use; these fields remain `unknown` unless the fixture collects the named
metric through an actual measurement source. A scripted token or clock counter is not
provider telemetry. `first_model_token_ms` remains unknown when the provider interface
exposes only text deltas rather than token boundaries. First useful action is measured
only from a successfully settled local effect, never from the pre-authorization
`ToolStarted` observer event.

`evaluation_id` identifies one immutable execution attempt, not a retryable logical
task. V1 also records a stable `evaluation_group_id`, one-based `attempt_number`, and
optional `retry_of` attempt ID. A retry creates a new attempt record and never replaces
or edits its predecessor. Attempts for one logical task remain independently
addressable even when paired or repeated. `--output-dir` receives a newly-created
attempt subdirectory; the output root must already exist, be a directory and not be a
symlink. The command canonicalizes the root, uses an exclusive create for the attempt
directory and create-new semantics for artifact files, and refuses collisions rather
than overwriting prior evidence. The record is staged and atomically published last
without replacing an existing record, only after the distinct trajectory and workspace
snapshot artifacts are completely written and their digests verified. An I/O failure
may leave visibly unreferenced artifacts, but never a record that references partial
or missing bytes. On platforms without a verified private-artifact and no-replace
publication mechanism, the command fails before creating artifacts; platform support
must be reported explicitly rather than inferred from filesystem API availability.
Before creating evidence artifacts, the implementation must verify that the selected
output filesystem supports the required private permissions and no-replace publication
primitive; a Unix target alone is not proof that a mounted filesystem provides them.
The fixture's probe is point-in-time and path-based; it does not protect against a
concurrent output-root/parent replacement or remount between probing and publication.
Such races require a pinned-handle publication design and remain separately tracked.

The fixture's confinement claim is limited to the production tool path's resolved
workspace scope and the absence of advertised/authorized shell or network-capable
tools and the absence of a network provider.
A resolved profile alone is not evidence that an OS sandbox backend was applied; the
fixture must not claim OS-level network or process confinement. Source and fixture
tests establish that the execution path uses an in-process scripted provider and
advertises no network-capable tool; they do not prove that the process cannot open a
socket. A dedicated network-denial regression and OS-level network confinement
acceptance remain separate work.

Trajectory and workspace capture enforce byte, event, entry, depth, and conservative
serialized-metadata ceilings while collecting data. A trajectory cap retains the
bounded event prefix, marks its completeness false, records the omitted-event reason,
and produces `insufficient_evidence`. Workspace metadata overflow similarly retains a
bounded incomplete snapshot and gap reason; content bytes are separately capped at
64 KiB. The 4 MiB serialized artifact limit remains a final assertion after bounded
capture, not the mechanism that controls allocation.

Until a separately scoped verifier consumes the retained final workspace bytes and
predeclared criteria, the record uses `verifier_outcome=not_run` with null verifier
metadata. Runner completion, expected fixture output observed by the command itself,
and record validity do not establish benchmark task acceptance. Fixture execution is
restricted to HZBench-Dev; there is no command-line path to choose Holdout. These
constraints do not implement holdout custody, independent verification, crash-safe
attempt retention, or general `run` execution, which remain separate AX-419 work.

`hz-eval verify` emits an immutable `VerificationResultV1` artifact, never edits a
sealed run record. It binds the attempt ID, workspace-snapshot reference and digest,
task/criteria digests, verifier binary/version/environment, result and limitations.
Comparison/report joins that artifact to the attempt and requires every identity and
digest to match. A stale, missing, inaccessible or mismatched snapshot produces
`insufficient_evidence`; it cannot become a pass. If verification runs before the
initial run record is sealed, its identity may also be summarized in that record, but
the separate result artifact remains authoritative.

```text
EvaluationRunV1 {
  schema_version: 1, evaluation_id, evaluation_group_id, attempt_number, retry_of?,
  benchmark_id, benchmark_version,
  dataset_digest, criteria_digest, split: DEV | HOLDOUT, task_id, task_digest,
  task_stratum, repository_identity, start_revision, integrated_revision,
  tested_revision, initial_workspace_digest, final_workspace_digest,
  workspace_snapshot: {reference: opaque artifact ID, digest},
  harness_id, harness_revision, binary_digest, harness_config_digest,
  model_id, provider_id, route_id, route_version, reasoning_setting,
  model_capability_snapshot, prompt_digest, tool_schema_digest,
  policy_snapshot_digest, environment_digest, limits, network_policy_digest,
  seed, repetition, run_order, paired_run_id,
  trajectory: {reference: opaque artifact ID, digest, completeness, redaction, event_gaps},
  timing: {started_at, ended_at, first_action_ms, first_model_token_ms,
           pre_model_overhead_ms, total_duration_ms, durations_ms},
  usage: {input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          cost, context: {bytes, tokens, tokenizer_id},
          resources: {cpu_time_ms, peak_rss_bytes, peak_pss_bytes,
                      disk_read_bytes, disk_write_bytes}},
  model_call_counts, tool_counts, tool_counts_by_category, file_read_counts,
  repeat_read_counts, search_counts, failed_tool_counts, patch_retry_counts,
  check_counts, human_interventions[],
verifier_id?, verifier_version?, verifier_environment_digest?,
  verifier_result_ref?, verifier_result_digest?, verifier_outcome, regressions[], outcome, terminal_reason,
  limitations[], record_digest
}
```

Tool lifecycle counts have these exact boundaries: `attempted` is a complete model
response's admitted tool proposal; `started` is dispatch into the runner's
authorization/execution pipeline; `completed` is a successful settled result; `failed`
is a non-cancelled unsuccessful settlement, including denial; and `cancelled` is a
call explicitly settled as cancelled. Since `started` precedes the actual effect,
it does not prove that a tool ran or changed state. If an adapter cannot observe one
boundary reliably, that field remains unknown rather than being inferred from another
event.

The serialized field names above are required unless a field is explicitly defined as
nullable by the versioned schema. A nullable `Measured<T>` uses
`{state: reported|estimated, value: ...}` or
`{state: unknown, reason: <stable-code>}`. The value `0` is a measured zero, never a stand-in
for missing telemetry. Model-call and tool-call counts each require attempted,
started, completed, failed and cancelled fields. Aggregate tool counts are accompanied
by per-category counts or an explicit unknown state; reported category totals reconcile
with their reported aggregate totals. File reads, repeat reads, searches, failed tools,
patch retries and checks are individually measured or explicitly unknown.
Limits name the ceiling and whether it is enforced or observed. Usage
records input/output/cache-read/cache-write and monetary values with provenance; money
also records currency, rate source and rate basis. Timing records start/end wall-clock metadata and
monotonic durations. Model capability snapshots and structured human-intervention
categories are explicit; free-form prompts and credentials are never stored.
Trajectories use bounded artifact capture with digest, completeness, redaction and
event-gap status; credentials and hidden reasoning are excluded. Unknown or absent
telemetry remains unknown, and a gap that prevents a required metric or verification
produces insufficient evidence. Record/dataset/schema versions are explicit;
incompatible input fails before execution.

The record digest is BLAKE3 over canonical V1 JSON with the `record_digest` field
omitted. Emit UTF-8 with no whitespace; recursively sort object keys by their UTF-8 byte
sequence; preserve array order; write `null`, `true`, and `false` literally; and write
integers as base-10 digits with no leading zero (except `0`) or plus sign. V1 has no
floating-point fields. For strings, emit non-control Unicode directly as UTF-8, do not
escape `/`, escape `"` and `\\`, use the short JSON escapes `\\b`, `\\t`, `\\n`, `\\f`,
`\\r`, and encode other U+0000–U+001F controls as lowercase `\\u00xx`. Reject duplicate
object keys before canonicalization. This rule is independent of input object-key order.
Do not normalize Unicode. The initial Rust validator implements it. A fixed vector is
input `{"b":2,"a":1}`, canonical bytes `{"a":1,"b":2}`, digest
`blake3:8e80439b77ac62d4194499edd46684c479da3aa1ac80dd5511468efae049166e`.
Independent cross-language implementation of this vector remains an acceptance
requirement.
Unknown fields fail validation in version 1, preventing credentials or unreviewed
fields from being silently retained.
The record binds the repository start, integrated and tested revisions separately;
they may be equal but must not be inferred to be equal.

Every record has a declared `wall_time_ms` ceiling. Timing values are monotonic
durations in milliseconds; start/end are UTC RFC3339 timestamps. Known first-action,
first-token and pre-model durations cannot exceed a known total duration. Context bytes
and token counts are separate measurements; a known token count requires a known
tokenizer identity. CPU, RSS, PSS and disk values use the units in their field names.
Cost is a non-negative decimal plus a three-letter uppercase currency code, rate source
and rate basis. V1 validates currency-code syntax, not membership in a particular live
ISO registry; comparisons require matching currency, rate basis and rate source or
report cost as incomparable. Run outcome and independent verifier outcome are separate
facts: a provider failure can leave a workspace that passes, and a completed run can
lack a verifier verdict. `not_run` has null verifier identity/environment/result fields;
other verifier outcomes require complete identity and a separately retained result
artifact with digest. A passed/failed verifier result requires a reported final
workspace digest. An unknown digest cannot support an acceptance result. Unsupported
routes/tasks have explicit `unsupported` outcome and terminal reason.

Trajectory references are opaque `artifact:<id>` identifiers where `<id>` is 1–128
lowercase ASCII letters, digits, hyphens or underscores. Path separators, dot segments,
percent encoding and URL syntax are rejected. Artifact retrieval separately verifies
the declared content digest; the ID itself is not content-addressed.

Independent verifiers run outside the implementation agent's context against the exact
final workspace, predeclared criteria and environment. A worker report, test selected by
the implementation or self-review cannot establish benchmark task acceptance. Tests
that the task requires are retained alongside independent checks and regression results.

## Development, holdout and comparison policy

HZBench-Dev is visible for iteration. HZBench-Holdout is versioned and frozen before
tuning, with task/evaluator/config digests and custodian/access records. Task solutions,
hidden checks and detailed holdout feedback are withheld from tuning agents. Release
attempt count, stopping rule, configuration and analysis are declared before the first
holdout run. All attempts, failures, timeouts and exclusions are retained. Retuning
after holdout exposure invalidates a claim of untouched holdout performance and requires
a fresh independently prepared holdout version; repeated runs cannot cherry-pick wins.

Track A controls the exact model/provider/reasoning, task/revision, environment, network,
permissions and ceilings to compare harnesses. Track B measures each product's supported
configuration ceiling and explicitly retains model/product confounds. Track C enables
HorizonCode layers incrementally: basic tools, index, coarse repository tools,
TaskPackage, ChangeReceipt, skills, scheduler and subagents. Randomize paired run order,
repeat according to predeclared statistical rules and report uncertainty.

The baseline B0 is captured before tuning the relevant harness feature. A stub baseline
can measure local mechanics; it cannot measure coding quality. A real same-model B0
requires supported, conformance-tested routes in both harnesses. The requested OpenCode
Go examples depend on AX-360/361 and current route availability; model names are
configurable examples, not permanent support or free-access promises. Safety fixes
proceed even while live comparative evidence is blocked.

## Metrics, suites and failure policy

Correctness and regression gates precede efficiency comparisons. Report accepted tasks
per model call, per million tokens, per dollar and per minute alongside absolute counts,
failures and quality. Unknown denominators yield unknown ratios; zero-call deterministic
outcomes are reported separately. Better ratios cannot compensate for lower correctness,
unsafe effects, lost intent or weaker verification.

HZBench suites cover QuickEdit, RepoUnderstanding, FeatureBuild, TestEngineering,
Refactoring, TerminalOps, LongRun, CrashRecovery, Context/Compaction, Stop/NoProgress,
MultiAgent, Permission/Security, WorkspaceConflict, ProviderFailure, PR/Verification,
RepoScale and ModelCallEfficiency. Suites share the run schema; they do not create
parallel task/evidence stores. Feature-specific plans remain with their existing owners.

Cancellation retains partial trajectory and outcome. Run restart uses stable evaluation
identity and reconciles effects before any replay; execution never retries an unknown
non-idempotent command merely because a report was lost. Corrupt/missing artifacts,
unsupported telemetry, environment drift, leaked holdout data and invalid comparisons
produce typed failures/limitations with the affected claims withheld.

## Acceptance

`ACC-EVAL-01` proves manifest validation, exact revision/config binding, deterministic
fixture replay, independent verification, complete failure retention, unknown metrics,
holdout access/freeze rules and comparable-track reporting. Performance/correctness
results become claims only through retained exact-build evidence and the applicable
product acceptance gates. Source navigation is preserved in
[AX-419's trail](../../docs/research/SOURCE-TRACEABILITY.md#ax419).
