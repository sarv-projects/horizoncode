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
verification → immutable run record → comparison/report. Setup failures, unavailable
routes, timeouts and harness crashes are retained outcomes. A benchmark PASS proves
only the benchmark's declared task rubric on its exact subject; product acceptance
still requires the relevant acceptance record.

The finite command interface provides `hz-eval validate`, `run`, `verify`, `compare`
and `report`. Dataset/task/config IDs are validated references, never arbitrary shell
arguments. A run cannot publish results, acquire credentials or contact a live provider
implicitly. Fixture subprocesses use isolated roots, finite ceilings and explicit
network policy. Required external accounts/services remain authorization-gated.

```text
EvaluationRunV1 {
  schema_version: 1, evaluation_id, benchmark_id, benchmark_version,
  dataset_digest, split: DEV | HOLDOUT, task_id, task_digest,
  repository_revision, initial_workspace_digest, final_workspace_digest?,
  harness_id, harness_revision, binary_digest, harness_config_digest,
  model_id, provider_id, route_version, reasoning_setting,
  prompt_digest, tool_schema_digest, environment_digest,
  limits_digest, network_policy_digest, seed?, repetition, run_order,
  trajectory_ref, timing, usage, model_call_counts, tool_counts,
  file_read_counts, repeat_read_counts, search_counts, failed_tool_counts,
  patch_retry_counts, check_counts, context_usage,
  verifier_id, verifier_version, verifier_environment_digest,
  verifier_result_ref, outcome, limitations[], record_digest
}
```

Timing preserves measured start/end boundaries and monotonic duration plus wall-clock
capture metadata. Usage distinguishes provider-reported, estimated and unknown input,
output, cache-read, cache-write and monetary fields; money carries currency/rate source.
Counts distinguish attempted, started, completed, failed and cancelled work. Missing
telemetry stays unknown. Trajectories use bounded artifact capture with completeness,
redaction and event-gap status; credentials and hidden reasoning are excluded. A gap
that prevents a required metric or verification produces insufficient evidence.
Record/dataset/schema versions are explicit; incompatible input fails before execution.

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
