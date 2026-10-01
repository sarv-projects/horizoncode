# State machines

## Authority

This registry owns lifecycle vocabulary and permitted transition semantics. Subsystem documents describe guarded operations against these states. Every transition is a committed owner event, never a renderer label or process inference. Unknown is nonterminal unless explicitly reconciled.

**Run:** `DISCOVERING → SPECIFYING → READY → EXECUTING → INTEGRATING → VERIFYING → AWAITING_ACCEPTANCE → COMPLETED`. Active states may transition to `RECOVERING`, condition-driven `WAITING`, user-driven `PAUSED`, hard-bound `STOPPED`, or `CANCELLING → CANCELLED`. A cancellation with unresolved process/effect state remains `CANCELLING` with a `RECONCILING` cancel receipt; it is not terminal. `WAITING` may wake only on its recorded condition; `PAUSED` requires explicit user resume and cannot auto-wake; `STOPPED`, `CANCELLED`, and `COMPLETED` are terminal and distinct. A terminal run may be forked into a new run with provenance, but is never silently reopened. An independent task may continue only when a wait does not block its dependency or shared resource.

**RunGoal:** `DRAFT → ACTIVE → PAUSED | BLOCKED | BUDGET_LIMITED → ACTIVE`; `COMPLETE` is terminal and requires the owning run's current completion evidence. Only a committed `GoalActivated` event can move a draft to `ACTIVE`. Clearing an `ActiveGoalPointer` changes no `RunGoal` or `Run` state.

**GoalApprovalChallenge:** `PENDING → ACCEPTED → CONSUMED`; alternatives are
`DECLINED`, `CANCELLED`, `EXPIRED`, or `INVALIDATED`. `ACCEPTED` means the trusted
operator response and one-use receipt are durable, not that work has started.
Activation requires the separate `GoalActivated` commit event after reservations.
It is bound to one connection and current review-bundle digest. Any
policy/base/route/budget/spec change, extra input, disconnect, or replacement
challenge closes a still-pending challenge. Reconnection before the acceptance event
requires a fresh review. After acceptance, the original intent can be reconciled only
against its original receipt/delivery, unexpired receipt, and current policy, never by
generating a replacement receipt. Expiry before activation rejects the intent and
requires a fresh review.

**GoalStartIntent:** `VALIDATING → RESERVED → COMMITTED`; recoverable uncertainty is
`UNKNOWN` until the reservation-ledger result is reconciled. Validation failure becomes
`REJECTED` only after partial reservations are confirmed released. Explicit user
cancellation before activation is `CANCEL_REQUESTED → CANCELLED`; it fences
`GoalActivated` immediately, while the terminal cancelled state waits for release
confirmation. Only a durable `GoalActivated` event produces `COMMITTED`; cancellation
after that event uses the active run cancellation state machine.

**Cancellation:** `request_cancel` resolves a tagged target and first persists one
idempotent `RunCancelRequested`, `TaskCancelRequested`, or `AttemptCancelRequested`
event plus rebuildable `CancelRequest` projection; it installs that target's fence
before acknowledging it. A `RUN` target fences all new claims;
an accepted but uncommitted goal start is serialized against `GoalActivated` under the
same run writer and its reservations must be released before cancellation is terminal.
A `TASK` target fences future attempts for that task; already-running attempts receive
cooperative cancellation and their effects are reconciled. Its dependent tasks remain
`BLOCKED` with the cancelled dependency recorded; cancellation does not cascade to
independent tasks or silently cancel descendants. An `ATTEMPT` target cancels only that
attempt; after its effects are reconciled, the task returns to `READY` only if retry
policy, budget, and attempt limit permit another attempt, otherwise it remains blocked
or requires review. If the target already completed before the fence commits, return
`ALREADY_TERMINAL` and preserve its verified state. `/cancel` is cooperative; hard
termination is a separate `/stop-now` action. Unsupported peer cancellation, lost
process acknowledgement, or an unknown effect keeps the affected scope in
`RECONCILING` and blocks unsafe retry. Duplicate delivery with the same payload returns
the same receipt; changed payload under the same ID conflicts. No cancellation may
claim success solely because a signal was sent.

**Task:** `BLOCKED → READY → CLAIMED → RUNNING → VERIFYING → PASSED`; other states include `WAITING`, `NEEDS_REVIEW`, `FAILED`, `CANCEL_REQUESTED → CANCELLED`, and `SUPERSEDED`. Any nonterminal task may enter `CANCEL_REQUESTED` under its task fence. `CANCELLED` waits for its in-flight attempts/effects to reconcile. Worker completion moves a task to `VERIFYING`. `PASSED` requires independent `PASS` evidence at the current spec digest and tested integration/workspace revision. A cancelled dependency keeps descendants `BLOCKED` with a durable blocker reason; independent tasks remain eligible. `SUPERSEDED` keeps history after a spec revision.

**Attempt:** Normal progress is `PREPARED → ACTIVE → SETTLING → SUCCEEDED | FAILED | UNKNOWN`; any nonterminal attempt may branch to `CANCEL_REQUESTED → CANCELLED | UNKNOWN`. An `UNKNOWN` external outcome blocks replay until reconciled. `CANCELLED` is terminal only when the supervisor/peer and all effects are reconciled; cancelling one attempt does not cancel its task or create a retry unless controller retry policy permits it. An ACP session is a peer conversation handle bound to the HorizonCode Thread/Attempt; it is not a run or task.

**WorkerExecution:** `PREPARED → LAUNCHING → RUNNING → SETTLING → FINISHED | FAILED | CANCELLED`, with `UNKNOWN` reachable when any transition cannot be established. `UNKNOWN` can leave only through a durable reconciliation event supported by an authoritative host/peer observation; otherwise it remains blocked for review. A controller crash between committed launch intent and process receipt is `UNKNOWN` until the supervisor checks process ownership and workspace/effect state. A heartbeat timeout is not proof of process death. `FINISHED` means the process/peer execution ended with an observed terminal receipt; it does not imply Attempt success or Task PASS. A new execution for the same Attempt requires the old execution to be terminal or fenced and reconciled.

**Verification:** `PENDING → RUNNING → PASS | FAIL | INSUFFICIENT_EVIDENCE | STALE`. Changing the spec digest, tested commit, relevant environment, or integrated diff makes evidence stale; this is a transition with an event, not deletion. Evidence can be re-used only if its exact subject and scenarios remain identical and the verifier records why.

## Supporting records

| Record | State vocabulary and guard |
|---|---|
| WorkspaceBinding | ACTIVE, RECONCILING, RELEASE_PENDING, RELEASED; no new writer until reconciliation, and release only after terminal writers/effects and current fence checks |
| EffectIntent | PREPARED, EXECUTING, SUCCEEDED, FAILED, UNKNOWN; only authoritative target/receipt observations establish a terminal result |
| MessageDelivery | PENDING, ADMITTED, PROMOTED, UNSUPPORTED, UNDELIVERABLE, EXPIRED, CANCELLED; exact receiver InputReceipt and idempotent delivery identity govern observation |
| BudgetReservation | HELD, SETTLED, RELEASED, UNKNOWN; retain potentially consumed capacity until reconciled |
| WorkAdmissionPermit | ACTIVE, UNKNOWN, SETTLED; unknown blocks executable maintenance |
| ToolBatch | COLLECTING, ADMITTED, SUSPENDED_FOR_INPUT, REJECTED, SETTLING, SETTLED; full-response admission precedes sibling dispatch |

RunGoal additionally records STOPPED and CANCELLED distinctly from COMPLETE. Attempt UNKNOWN can return to ACTIVE/SETTLING or a proven terminal state only after exact process/effect reconciliation; it is not a successful terminal marker. A failed required task prevents Run completion until a new bounded attempt or approved specification change resolves its criterion.
