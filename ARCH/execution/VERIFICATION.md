# Runtime verification

## Purpose and ownership

CMP-verifier independently evaluates the exact approved subject under a controller-issued verification permit. It returns evidence; CMP-orch decides Task/Run transitions. Release acceptance is defined separately in [Acceptance model](../acceptance/ACCEPTANCE-MODEL.md) and [Acceptance matrix](../acceptance/ACCEPTANCE-MATRIX.md).

## Public contract

```rust
trait RuntimeVerifier {
    fn verify(&self, subject: VerifiedSubject, scenarios: &[ScenarioId],
              permit: VerificationPermit) -> Result<VerificationResult, VerifyError>;
}

```

VerificationPermit is opaque, one-use and minted/consumed only by CMP-orch. It binds Run/Task/Attempt, specification digest, verifier class, exact subject and reserved budget. A worker cannot construct it or replace it with an arbitrary reservation.

VerifiedSubject contains repository/provider identity, immutable revision or exact dirty snapshot, spec digest, scenario versions, environment digest and toolchain versions. Evidence schema is defined in [Domain model](../04-DOMAIN-MODEL.md). PASS requires retained evidence artifact digests and an independent producer; prose confidence is insufficient.

### Asynchronous evaluation freshness fence

Planning, review, risk assessment, goal completion, and verifier work can finish after
the operator or workspace has changed. Treat every such result as a proposal against
captured state, never as a write capability.

```text
EvaluationSnapshot {
  evaluation_id, run_id?, task_id?, attempt_id?, source_event_seq,
  input_receipt_seq, spec_digest, task_graph_digest, policy_digest,
  workspace_id, workspace_fence_epoch, base_revision, dirty_digest,
  evaluator_kind, route_snapshot_id?, reservation_id,
  created_at, result_digest?, completed_at?, disposition
}
```

Before persisting a result that changes state or allowing it to dispatch work, the
controller reloads the canonical projection and compares every relevant revision.
Changed user input, a cancellation fence, spec/graph/policy digest, workspace
epoch/base/dirty digest, terminal task state, or superseding evaluation makes the
result `STALE`. Store its bounded result/evidence reference for diagnosis, but do not
let it overwrite a newer plan, complete or reopen a task, resume an attempt, or
authorize an effect. Unrelated derived analytics sequence changes do not alone
invalidate it. Re-evaluation is a new bounded action with a fresh reservation.

The commit path is serialized with the authoritative Run writer:
`read snapshot → evaluate → acquire current writer fence → reload and compare → append
result+transition or stale diagnostic`. If the process crashes before append, recovery
sees no accepted result and may retry only under the original bounded reservation and
idempotency ID. If newer input arrives before commit, that input wins. The evaluator
cannot choose which revisions to ignore.

| Condition | Required outcome |
|---|---|
| Relevant revisions match and task remains eligible | Persist result; apply only the allowed transition; re-check permission/budget before dispatch |
| Input/cancel/spec/policy/graph/workspace changed | Persist `STALE` diagnostic; do not overwrite state or dispatch |
| Task became terminal or evidence was superseded | Reject transition; preserve current evidence lineage |
| Current revision cannot load or digest validation fails | Typed `WAITING`/`BLOCKED`; fail closed |
| Reevaluation budget cannot be reserved | Do not invoke evaluator; report budget-limited state |

This fence does not make an LLM completion judgment independent verification.
`CMP-verifier` evidence must still bind to the current integrated revision and approved
specification.

## Evidence interpretation

PASS means all required current scenarios passed on the named subject within stated limitations. FAIL records observed requirement violation. INSUFFICIENT_EVIDENCE records missing, unsupported, corrupt or incomplete observations. STALE preserves prior evidence whose specification, relevant environment, workspace/integration revision or scenario version no longer matches. No unit/fake-provider result proves platform confinement. No isolated workspace PASS proves the combined integration revision.

Only current independent PASS for every required member/revision unlocks task dependencies. User acceptance, release acceptance and runtime verification are separate records. A producer cannot loosen approved scenarios, grant permissions, or promote its own worker completion. Missing mandatory evidence keeps completion nonterminal.

## Failure, bounds and acceptance

Reserve verification/recovery capacity before work. Bound verification duration, output, event/artifact bytes and scenario count. Capture executable commands, exact revision/environment and raw evidence references. Test stale result races, changed intent/policy/workspace, terminal targets, unknown effects, exhausted reserve, missing artifacts and forged producer/permit. Re-evaluation is a new bounded action, never silent reuse of stale evidence.
