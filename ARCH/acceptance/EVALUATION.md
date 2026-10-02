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
and `report`. The implemented initial slice currently provides only `hz-eval validate`
for bounded V1 records; it does not execute tasks, verify outcomes, enforce holdout
access, compare runs, or report benchmark results. Dataset/task/config IDs are validated
references, never arbitrary shell arguments. A future run path cannot publish results,
acquire credentials or contact a live provider implicitly. Fixture subprocesses use
isolated roots, finite ceilings and explicit network policy. Required external
accounts/services remain authorization-gated.

```text
EvaluationRunV1 {
  schema_version: 1, evaluation_id, benchmark_id, benchmark_version,
  dataset_digest, criteria_digest, split: DEV | HOLDOUT, task_id, task_digest,
  task_stratum, repository_identity, start_revision, integrated_revision,
  tested_revision, initial_workspace_digest, final_workspace_digest,
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
