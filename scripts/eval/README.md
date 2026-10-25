# HorizonCode evaluation runner (offline foundation and gated HostRun seam)

`eval_harness.py` exposes a deterministic, fake-provider HUP-005 self-check and a
library-only paired HostRun boundary for future HUP-001/HUP-002 integrations. The
CLI remains fake-only: it creates no model/provider clients, processes, sockets,
benchmark downloads, task containers, or Guarded product effects. Fake output is
labeled `FAKE_SELF_CHECK` and never eligible as a benchmark score or release evidence.
The HostRun boundary also remains non-authoritative until P1/P2 provide an installed
authenticated HostKernel adapter and independent-verifier evidence source.

When the implementation-first hold is lifted, the initial self-check can be run
from the repository root with an unused repository-local artifact path:

```sh
python3 scripts/eval/eval_harness.py --selfcheck --artifact scripts/eval/out/hup005.jsonl
```

The checked-in fixtures in `test_eval_harness.py` cover strict frozen manifests,
seeded randomized task order with balanced randomized arm order, task isolation,
scorer outcomes, grouped paired interval calculation, explicit
infrastructure/unsupported/cancellation states, descriptor-relative repository-only
artifact writes, and resuming only exact completed task/arm records. The artifact is
an append-only, fsynced JSONL journal. One runner holds a nonblocking exclusive lock
on the pinned artifact descriptor for the entire invocation; another runner targeting
the same artifact fails before reading or appending it. The journal rejects symlink
traversal, descriptor/path replacement, uncoordinated size changes, and incomplete
trailing records. Safe locking and descriptor-relative reads must be supported by the
platform or the journal stays unavailable. Tests have not been run.
The optional library-level seed argument cannot override the manifest's seed; if a
caller needs a different randomized schedule, it must create a new frozen manifest
and therefore a distinct run/artifact digest. Resumed trial rows are checked against
the frozen task/arm matrix and require unique contiguous provider-call indexes; malformed
or duplicated attempt ordering is rejected before another fake invocation.
Manifest ingestion is no-follow and byte bounded before parsing. Summary generation
rejects duplicate, stale-manifest, and out-of-manifest trial rows rather than choosing
one conflicting result. Accounting totals include every invoked arm, including
incomplete pairs; a missing counter makes that metric explicitly unknown instead of
silently dropping failed work. The fake fixture carries elapsed time, token, tool-call,
and retry counters so the report shape can be exercised without claiming real resource
measurements.
Cancellation before fake-provider dispatch is journaled without a provider-call index
and is excluded from invocation-cost totals; cancellation raised by the invoked fake
adapter retains its call index and remains an attempted invocation.
Fixture outcomes that exceed their frozen token, wall-time, tool-call, retry, or
known-cost ceiling are retained as failures with a budget-exhaustion stage and cannot
score as verified passes. The emitted report pins benchmark/split/scoring/evaluator,
task IDs and partitions, provider/model/image/prompt/oracle/permissions, arm commit and
configuration digests, seed, platform/date, failure/exclusion policy, and raw artifact
digest. It separately counts infrastructure, cancellation, unsupported-capability,
false-completion, and security-failure evidence, with status, failure-stage, and
accounting totals by arm. Fixture cost values are labeled `FIXTURE_REPORTED`, not
measured provider cost; absent values remain `UNKNOWN`. OS resource use remains
`UNKNOWN` in the fake-only path.
Real provider or benchmark adapters are intentionally absent. Adding them requires the P8 admission contract,
trusted HostRun and independent-verifier evidence, explicit selected-provider
authorization, no hidden paid fallback, and independent review of effect and
budget boundaries.

## HostRun paired-run boundary (source present; integration unavailable)

`run_host_paired_evaluation(manifest, bridge, task_resolver, artifact_path)` accepts a
frozen manifest and invokes only the supplied `HostRunBridge.dispatch_guarded_trial`
interface. It has no provider SDK, subprocess, shell, socket, or task-image loader.
The bridge and task resolver are integration seams, not trusted adapters: no
production implementation is registered, and the module CLI cannot invoke them.
An integration must authenticate the caller and dispatch through the existing Rust
HostKernel/managed Attempt path, preserve the user's selected route without fallback,
and return evidence from an independent verifier bound to the actual final workspace
revision and exact OwnerLog event.

HostRun invocations bind the frozen manifest/shared-config digests, task image input,
arm/harness digest, selected provider route and model revision. Task resolver output
is incrementally bounded to 1 MiB and must hash to the manifest's `inputDigest`.
`RepositoryTaskImageResolver` reads a no-follow, repository-local JSONL catalog whose
header pins the full benchmark and repository-image provenance digests and whose task set
must exactly match the frozen manifest. Each record binds task ID/group and canonical input digest; unknown,
duplicate, changed, oversized, symlinked, or out-of-repository workload data is rejected.
Dispatch indexes are distinct from provider request counts. An exception after
entering the bridge is journaled as `UNKNOWN` with its dispatch index and is never
replayed in the current process. Each invocation also carries a stable digest-derived
idempotency key over frozen manifest/task/arm identity; an integrated bridge must
reconcile that key to the same managed Attempt after a process restart before it can
continue. Pre-dispatch cancellation has no index, then remaining pairs are `NOT_RUN`.
The same bounded, locked, repository-local JSONL journal is used for exact task/arm
resume. The report keeps resource use `UNKNOWN` until RC0 sampling is authenticated,
retained, and bound to HostRun evidence. Provider cost is reported only with its
declared measured/estimated provenance; unknown cost stays null. All reports remain
`officialScoreEligible: false`; HostRun reports are marked
`HOST_RUN_ADAPTER_UNATTESTED` and `hup001Complete: false`. A library call with a
structurally valid outcome is not release or benchmark attestation.

Source-only acceptance fixtures cover selected-route/config binding, ordered HostRun
dispatch indexes, UNKNOWN/no-replay behavior, cancellation, bounded local task inputs,
and permanent non-official status. They have not been run under the implementation-first
hold. HUP-001/002 execution remains blocked on the concrete authenticated HostRun,
independent-verifier and RC0 evidence integrations plus explicit live-run authorization.

The `taskPartitions` field freezes development, smoke, and heldout task IDs and
rejects overlap within a manifest bundle. Each pair shares one digest-bound
provider/model, repository image, prompt, oracle, permissions, sampling, tool
allowlist, and budget configuration. The frozen bundle also declares exactly one
`modelClass` (`strong`, `small`, or `local`): strong, small, and local models are
separate frozen bundles with separate run digests, never pooled into one score.
Only the declared baseline-versus-HorizonCode harness factor differs. The frozen
comparison contract also supports full-versus-one predeclared ablation (`delegation`, `repointel`, `codemode`, or `verification_retry`);
reference/candidate roles and the ablated feature are reported explicitly. This is
manifest/report support only: the executable remains fake-provider-only and cannot
launch those product configurations.

## Source adaptation note

The local reference `repo_take/oh-my-pi/packages/metaharness` groups comparable
runs into experiments, stores normalized per-trial traces and costs, builds a
per-task arm matrix, and resumes by reusing completed trials. HorizonCode adapts
those manager concepts into a repository-local JSONL journal and fake-only runner;
it does not adopt the reference's Harbor/container launch, provider gateway,
remote service, deletion, or paid-routing behavior. No source code was copied.
See `arch_V1/42-EXTERNAL-SOURCE-PROVENANCE-REGISTER.md` for the pinned source
and license note.
