# Budgets

## Purpose and ownership

CMP-orch reserves bounded resources before dispatch and accounts for observed, estimated and unknown consumption. Budget is the shared aggregate in [Domain model](../04-DOMAIN-MODEL.md); this document owns reservation and settlement.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `BudgetReservation` | `reservation_id`, `operation_id`, `budget_id`, `parent_chain[]`, `resource_kind`, `amount`, `state: HELD | SETTLED | RELEASED | UNKNOWN`, `observed_actual?`, `created_at`, `settled_at?`. The canonical reservation protocol in this document checks the full ancestor set before dispatch. |
| `EventStorageReservation` | `reservation_id`, `budget_id`, `owner_kind/id`, `attempt_id?`, `max_bytes`, `protected_control_bytes`, `state: HELD | RECONCILING | SETTLED | RELEASED`, `expires_at`. Held before work that can emit durable state; stable ID survives retry/restart and does not double-spend. |
| `PhysicalStorageReserve` | `reserve_id`, `run_id`, `filesystem_identity`, `backend_profile_digest`, `allocated_bytes`, `allocation_method`, `state: VERIFIED | CONSUMED | REPLENISH_REQUIRED | UNKNOWN | RELEASED`, `allocation_receipt_ref`, `fence_epoch`. It proves the protected control/recovery bytes were physically allocated before activation; a budget counter alone never satisfies this record. |

Before `GoalActivated`, `CMP-artifact`/the storage backend must physically allocate
the configured control/recovery reserve on the same filesystem or enforce an
equivalent accepted hard reservation. It records the backend identity/method and
verifies the allocation receipt after restart. Sparse files, a successful free-space
query, or an internal counter do not prove physical reservation. Workers cannot open
or consume the reserve. When the primary event area reaches its fence, only the
controller may use this preallocated capacity for cancellation, effect settlement,
terminal state, and bounded handoff records; it then marks the reserve
`REPLENISH_REQUIRED` and pauses further dispatch until capacity is safely restored.
If the platform cannot prove this behavior under ENOSPC, it refuses the multi-hour
profile instead of claiming it can always persist a stop.

### Reservation linearization and recovery

Run budget rows are checked projections of canonical Run reservation/settlement events.
Under the exclusive writer/fence, validate the current committed head and all ancestor
counters, use one SQLite transaction to check the complete reservation set, append one
bounded Run ReservationSetCommitted event containing all scope deltas and payload
identity, durably advance its head, then advance/commit the checked projection.
Dispatch requires the durable event and matching projection. Failure before the
canonical head commits authorizes nothing; failure after it commits leaves the full
reservation held until replay repairs the projection. This clarifies the preceding
SQLite algorithm: a projection commit alone is never the canonical authorization.

Counters include spent, held and disjoint unknown exposure plus protected reserve.
Settlement records actual overage honestly and fences future dispatch; it cannot
retroactively establish a hard cap on an unbounded provider operation. A required hard
cost/token guarantee demands a conservative bound or refuses the route. Ancestors are
within one Run tree; cross-Run shared reservations need a separately coordinated
canonical owner protocol and must not claim an atomic cross-log SQLite transaction.

## Admission and settlement

At each dispatch boundary, the controller: (1) checks approved spec and graph acyclicity; (2) selects `READY` tasks by stable priority, fair-lane quota, age, and task ID; (3) checks permission and capability requirements; (4) atomically reserves expected attempt cost **plus** mandatory verification and recovery reserve against HorizonCode-owned task/run ceilings and any separately negotiated, enforceable adapter ceiling; (5) claims a fenced workspace; (6) launches a bounded attempt. Provider-account observations from `REQ-PROV-014` are advisory and are not part of this reservation set. Real provider usage is reconciled to the reservation after every response, including failed/fallback responses. Estimated, included-plan, unknown, and actual costs remain distinct and carry currency. Unknown pricing or unavailable currency conversion under a monetary cap blocks dispatch or requires a separately approved token-only policy. A zero-dollar subscription label does not prove zero quota impact. User cancel and permission responses receive reserved service capacity.

Unlike currencies are never summed. Unknown usage already held in a reservation is not counted again as disjoint unknown exposure. Reservation IDs and payload digests are immutable; identical delivery returns the recorded receipt and changed payload conflicts. Validate ancestors in stable order inside one Run tree; any failed check refuses the entire set. Dispatch requires both the committed canonical head and its matching checked projection.

Settlement durably moves held units to observed spend, explicitly estimated spend, or retained unknown exposure. A possibly executed operation retains coverage until reconciled. Terminal cleanup releases only amounts proven unused. Protected verification/recovery/control capacity cannot be consumed by ordinary worker output.

OS host ceilings cover processes, file descriptors or Windows handles, PTYs, pipes, watchers, parser/index work and disk use. Platform mechanisms and unsupported enforcement are reported explicitly; POSIX RLIMIT_NOFILE is not a Windows mechanism. Financial hard caps require enforceable conservative per-operation bounds; a subscription price or provider quota observation does not prove such a bound.

## Failure and recovery

Pre-head failure grants no authority; preserve uncommitted bytes for reconciliation. Post-head projection failure keeps the whole canonical reservation set held. Actual overage is recorded honestly and fences future dispatch. Corrupt/newer-schema stores refuse work. Monetary routes with unknown pricing require a separately approved token-only policy or are refused. Counters persist across compaction, model changes, worker replacement and controller restart.

## Configuration and acceptance

Publish finite per-Run, Task, Attempt, launch, output, event, artifact and host ceilings. Reserve verification/recovery/control capacity before activation. Concurrent ancestor admission, duplicate IDs, changed-payload conflicts, crash windows, unknown usage, overage, unlike currencies and physical storage exhaustion require independent acceptance scenarios.
