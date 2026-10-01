# Recovery

## Purpose and ownership

CMP-orch acquires exclusive Run ownership, increases its fence epoch and reconciles canonical state before resuming work. Projection repair does not invent effects or grants.

## Failure and recovery sequences

**Process crash:** acquire the run owner lock and increase the fence epoch; replay canonical events; verify audit chain and projection; inspect provider-qualified workspace revision/dirty digest, child processes, provider requests and external effect IDs; classify each unsettled effect as completed, safely retryable, compensatable, or unknown. Rebuild stale repo context and progress signature. Preserve `PAUSED`, `STOPPED`, cancellation, wait condition, retry counts, and batch rejection across restart. Only then ready unfinished tasks. Never replay PR creation, migration, deployment, or network write solely because the local tool call lacked a result.

**Implementation failure:** preserve diagnostics and diff; determine whether code, environment, requirement, or integration caused failure. Retry locally within the persistent attempt limit if new evidence supports repair. A test that was green in an isolated worktree is re-run after integration because the combined revision is a new subject.

**Planning or intent failure:** suspend dependent tasks, record the contradicted assumption, revise plan or open clarification. A user-visible change requires a new approved `SpecVersion`; affected evidence becomes `STALE`. Preserve the previous spec and decisions for audit.

**Disconnect or cancellation:** persist the external peer capability snapshot and last event cursor. Ask for resume/load only if negotiated and supported; otherwise use a fresh session with a bounded handoff package. Terminate descendants according to the adapter's actual control surface, then reconcile workspace and effects. A heartbeat only proves a live connection, not progress or completion.

**Permission request from a child:** persist the `PermissionBridge` before forwarding. Route to an attached, authorized surface using the root's external ACP Session binding while retaining the child `ThreadId` and requester IDs locally. If routing fails, the client disconnects, or the deadline expires, deny/cancel and settle the child with a receipt. A parent turn may not remain indefinitely blocked on an orphan request.

**Queued user input:** persist a bounded `InputReceipt` before acknowledging acceptance. Duplicate delivery retries return the same receipt. On crash, replay admission/promotion events and preserve pending items. Apply fair service across steer and queued lanes; cap steer batches so new prompts cannot starve. Expired entries receive a visible terminal result; none silently vanish during compaction.

**Tool-call flood:** buffer one response only up to byte caps; do not queue unbounded provider deltas in memory. If the provider cannot be stopped promptly, drain only to a bounded sink and cancel/close the stream. Reject the whole unstarted batch, record response/argument byte counts and usage, block identical replay, and hand off the bounded diagnostic to recovery. Caps must also apply to nested JSON, malformed UTF-8 replacement, duplicate IDs, pathological numeric/string lengths, and aggregate tool output; an individual-call cap alone is insufficient.

**Explicit pause / no-progress circuit break:** write the pause fence before acknowledging control; stop scheduling new work, request cancellation for active model/agent/tool processes, and reconcile calls that may have crossed an external-effect boundary. Persist unresolved effects as `UNKNOWN`; present the user with last confirmed progress and remaining budget. Neither an agent message nor a later heartbeat clears the pause. Resume revalidates state. If the same progress signature remains blocked, it may continue only with a controller-selected, genuinely untried bounded strategy that fits the remaining per-strategy, task, and run budgets, or with new user evidence/steering; explicit `/resume` alone never resets the failure signature, attempt count, or budget.

**Condition-driven wait:** commit the wait record, release only settled execution capacity while retaining Run ownership and fence authority, then wait on a timer/event queue. Duplicate or late wake events are deduplicated by `wake_event_id` and condition version; stale approvals and expired budgets are rechecked. If the process is down at the due time, recovery emits one wake after reconciliation. A host shutdown is displayed as stopped-host/last-seen, not as an active waiter.

**RPC/event backpressure:** use bounded request lanes and event buffers. A deadline or cancellation frees request capacity; control messages cannot wait behind slow catalog/history reads. If a client cannot drain events, retain the durable cursor and report an explicit gap/disconnect, then require snapshot plus ordered replay. Never hide lost events behind a live spinner or grow an unbounded buffer.

**Client detach and reattach:** a run is owned by the controller, not its TUI or IDE
connection. A detached multi-hour run requires a supervised controller process with
an authenticated local control endpoint, durable event cursor, and replayable status
projection. `attach(run_id, after_seq)` first returns a snapshot at a stated sequence,
then ordered events after that sequence; a cursor gap forces a fresh snapshot. A
client disconnect never cancels the run. An explicit cancel is a separately
authorized command and fences new dispatch. A controller process crash follows the
normal recovery protocol; a stopped host cannot make background progress, and the
UI must show the last confirmed event time rather than imply it is working.

## Launch and cross-stream repair

Exact launch identity, host observation and workspace/effect state control relaunch. An expired claim can return to pending only with authoritative NOT_LAUNCHED proof. Adopt an existing process/peer under the same stable launch identity if receipt publication was interrupted. Replay committed bounded event segments; preserve uncommitted tails for reconciliation and refuse projection-ahead-of-head corruption.

If a Thread append succeeded without its Run TurnLinked reference, verify the Thread bytes and repair the link by run/attempt identity. If a referenced Thread range is absent or altered, mark NEEDS_REVIEW; no PASS may survive a missing evidence lineage. Migration rebuilds a temporary checked projection then atomically swaps it; an interruption leaves the old projection intact.

## Unknown-state policy

Only authoritative observations reconcile process/effect outcomes. Preserve pause/cancel fences, consumed spend, retry counters, strategy history, pending input and no-progress state across every restart. Provider/adapter query unsupported means unknown, not a fresh retry. Unsupported locking/durability or corrupt/newer stores refuse work with visible typed recovery.

## Acceptance

Crash each prepare/commit/head/projection/launch/receipt boundary. Replay must reconstruct identical canonical facts without duplicate input, reservations, processes or effects. Test controller restart, stopped host, event gaps, orphan links, corruption, pressure and backpressure.
