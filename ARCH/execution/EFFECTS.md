# Effects

## Purpose and ownership

CMP-guard authorizes the exact operation; CMP-sandbox enforces selected reach; CMP-audit owns effect preparation and terminal receipts. CMP-orch prevents unsafe replay and completion with unsettled effects.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `EffectIntent` | `effect_id`, `attempt_id`, `kind`, `canonical_resource_digest`, `idempotency_key?`, `authorization_ref`, `workspace_base`, `state`, `audit_prepare_ref`, `terminal_receipt_ref`, `reconciliation`. One stable ID from prepare through outcome. |
| `Delivery` | `delivery_id`, `base_revision`, `head_revision`, `diff_digest`, `review_ids[]`, `ci_status`, `pr_remote_id?`, `release_status`, `external_effect_ids[]`. PR create/comment/merge/deploy are distinct effects. |
| `PermissionBridge` | `bridge_id`, `run_id`, `root_thread_id`, `child_attempt_id`, `child_thread_id?`, `request_id`, authenticated `principal_ref`, `control_session_id`, exact `connection_ref`, `requester_identity`, `display_digest`, `action_digest`, `resource_digest`, `guard_policy_digest`, `revision_vector`, `cancel_generation`, `expires_at`, `state: PENDING | ALLOWED | DENIED | CANCELLED | EXPIRED | STALE`, `decision_ref?`. One terminal answer; same-connection response only; connection close durably invalidates pending challenges before teardown; parent policy reauthorization is mandatory. The stored display digest binds approval to the exact canonical review content presented to the operator, while the resource digest/revision vector bind execution to the current world. |
| `ArtifactPin` | `pin_id`, `run_id`, `artifact_ref`, `owner_kind`, `owner_id`, `owner_revision`, `retention_class`, `state: PINNED | RELEASE_PENDING | RELEASED`, `event_seq`. A canonical run event owns each cross-record pin; the projection alone never retains or frees bytes. |

**Effect transaction.** Create a deterministic `effect_id` and idempotency key where
supported; obtain guard decision and frozen confinement profile; durably append the
prepare record (with roots anchored at the configured cadence); execute once; append one terminal
receipt; link session state and artifact digests. If the process dies after effect but
before receipt, recover to `UNKNOWN` and inspect the actual target. A file write
reconciles base/head digests; PR creation queries remote state by idempotency marker;
deployment or migration with no safe probe waits for an operator. An audit append
failure before execution refuses the action; a terminal append failure after a real
effect is an incident and blocks completion rather than pretending the effect never
happened.

## Identity and outcomes

Direct-turn EffectIntent uses ThreadId/TurnId/model_attempt_id with nullable managed IDs. Every effect binds canonical resource digest, current workspace revision/fence, exact authorization, confinement snapshot and prepared audit reference. Guard decision alone cannot establish OS reach. Ticket consumption and revocation are checked at the actual effect boundary.

A multi-tool batch is not an atomic transaction. Settle individual effects as they complete, even when observations await earlier call order. Unstarted suppressed calls are not executed effects. Started operations without established terminal outcomes remain UNKNOWN. Retry cannot erase or replay a possibly completed non-idempotent action. Approval, authorization, effect preparation, process execution and verification are separate facts.

## Failure and recovery

If prepare/audit/storage publication fails before execution, refuse dispatch. If terminal publication fails after a real effect, preserve the incident and block completion. Reconcile actual target state, base/head digests and exact idempotency identity. Missing telemetry, timeout and process exit do not prove an external write failed. Unsupported safe probes require operator review.

## Acceptance

Inject crashes before prepare, after durable prepare, after target mutation and before receipt publication; test idempotent redelivery, changed payload, revocation, partial multi-file publication, unknown external writes and audit failure. Task PASS requires current verification in addition to reconciled effect receipts.
