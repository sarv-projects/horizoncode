# Stopping and user control

## Purpose and ownership

CMP-orch owns deterministic stop decisions and target-scoped fences. Input/control ingress remains responsive independently of model streaming, catalog work and background jobs.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `StopDecision` | `CONTINUE | CHANGE_STRATEGY | WAIT | PAUSE | STOP | COMPLETE`, plus `reason`, `signature_ref?`, `next_action_ref?`, and `state_revision`. It is emitted by the existing controller only; `COMPLETE` requires all required tasks to have current independent PASS evidence on the integrated revision. |

The deterministic stop controller returns `CONTINUE | CHANGE_STRATEGY | WAIT | PAUSE | STOP | COMPLETE`. It runs before every model/tool/peer dispatch and after each response, task transition, verification, budget, permission, cancellation, or external-status event. Model evaluators may recommend but cannot override it. `COMPLETE` requires every mandatory current criterion to have current `PASS` evidence, integrated diff checks, no unknown effect, and required acceptance. `WAIT` records a condition and performs no inference while idle; `PAUSE` requires user resume; `STOP` is a terminal hard-bound or non-recoverable outcome. When no task is READY, return WAIT with a concrete dependency/resource condition or report a graph defect/deadlock; never return COMPLETE by default.

Ingress is a control boundary. Structured commands (including `/goal pause`, `/pause`,
`/resume`, `/cancel`, and `/stop-now`) are parsed and authorized before normal prompt
admission. Natural-language pause/cancel/stop requests are classified as
`CONTROL | NORMAL | AMBIGUOUS` and persisted as `ControlIntent`. A clear control fences
automatic continuation before it is acknowledged; a negated or quoted discussion is
ordinary content when it can be identified as such. Ambiguous intent or cancel target
fences dispatch and asks the user to clarify. A model cannot decide to ignore or
reinterpret an already persisted fence. `/resume` and `/goal resume` are explicit user
acts and never reset attempt, budget, or no-progress history.

Before automatic continuation, write a `ProgressSignature` from the current specification/task graph, revision and dirty-workspace digest, verifier evidence and actionable failure evidence. The semantic digest excludes timestamps, IDs, strategy labels, heartbeats, raw external cursors and changing tool-batch labels; diagnostic provenance retains those separately. Meaningful progress is a new verifiable artifact, resolved blocker, changed failure evidence, task/acceptance transition, or a user steer that changes the task/spec. Assistant text saying “continuing,” tool-call volume, heartbeats, repeated reads, and compaction do not count. A repeated signature without meaningful progress increments a counter that survives model/session changes, compaction, adapter replacement, and restart. No model-emitted prose, plan item, reasoning summary, or confidence value may increment, reset, or satisfy a no-progress counter; only controller-validated state/evidence transitions affect it. At the configured finite threshold the controller selects an untried evidence-backed strategy only while its per-strategy and run-level attempt/resource limits allow it. If none exists, the controller may spend a separately reserved re-planning allowance to create a child `SpecVersion` and candidate plan preserving every approved requirement, exclusion, permission ceiling, and acceptance condition. Record its trigger/evidence, invalidate affected plan/evidence approvals, and re-evaluate readiness. Any change to user intent, scope, security posture, or acceptance criteria remains `PROPOSED` and requires operator approval; a controller cannot approve its own changed requirements. If safe re-planning does not fit the remaining budget or preserve the approved contract, enter `PAUSED` with an inspectable reason. `/resume` does not clear consumed attempt/no-progress history; it authorizes reconciliation, then a bounded untried strategy, eligible replan, or work made ready by new user steering/evidence. If none applies, the controller remains paused. Repeating the same unchanged signature and strategy immediately re-pauses.

A PROPOSED candidate ExecutionPlan exists during preparation; only approval activates
its exact digest as the active plan. A generated plan or todo item never changes task
truth. No-ready-work yields an explained wait or graph-defect review, not success.

## Pause, resume, cancel and stop

request_pause, request_resume and stop_now require exact authenticated Run scope, stable delivery IDs and current owner fence. Receipts distinguish requested, reconciling and terminal. Run cancellation fences the whole owned graph; Task cancellation fences only its attempts and blocks descendants; Attempt cancellation affects only that attempt. A delivered signal is not terminal cancellation. Hard termination is separate from cooperative cancel and still requires effect reconciliation. Client detach/view close never cancels a managed Run.

A WAIT condition consumes no idle model inference. It may release settled execution slots while retaining controller ownership and workspace fence authority. Event wake is idempotent and rechecks current condition, permissions and budgets. PAUSED requires explicit user resume, which does not clear consumed attempts, spend or repeated-state history. No ready work yields a concrete wait or graph-defect review, never default success.

## Completion

COMPLETE requires mandatory current independent PASS evidence on integrated subjects, reconciled effects, durable audit/state and required acceptance. Budget exhaustion, worker termination, heartbeat, text completion, empty output and successful background maintenance are distinct from verified completion. Optional bounded maintenance cannot silently hold foreground completion.

## Acceptance

Test cancellation/activation races, ambiguous/quoted/negated control, explicit target ancestry, child permissions, late result fencing, unknown external effects, no-progress cycling, replay persistence and safe resumption. Numeric acknowledgement targets are centralized in [Performance](../contracts/PERFORMANCE.md).
