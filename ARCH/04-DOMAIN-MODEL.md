# Domain model

## Purpose and ownership

This document defines shared durable concepts. Component ownership is fixed in [Ownership](contracts/OWNERSHIP.md). Specialized control, execution, budget and transport records belong to their subsystem documents.

Conversation (Thread) ≠ Run ≠ Task ≠ Attempt ≠ WorkerExecution ≠ Workspace ≠ Effect ≠ Evidence ≠ Artifact ≠ Completion.

A Thread is the conversation aggregate, owned by CMP-session, with ordered turns/items and explicit lineage. External Session handles are protocol bindings. A direct coding turn need not have a Run, Task or orchestration Attempt; it uses ThreadId, TurnId and model_attempt_id. A managed Attempt may bind several Threads and sequential WorkerExecutions. Its Task dependency graph and Thread tree are independent.

Worker is a role/profile; Runner is the native model/tool loop; ExecutionHost performs process mechanics; Workspace is editable software state; Sandbox confines operating system reach. Artifact bytes are not verification Evidence. Memory is contextual data and cannot establish task truth or authority.

## Data model

State vocabulary uses [State machines](contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `Run` | `run_id`, `original_request_ref`, `project_id`, `repository_set_id`, `repository_members[]`, `workspace_id?`, `base_revision?`, `integration_revisions[]`, `spec_digest`, `active_plan_digest?`, `status`, `state_reason`, `policy_digest`, `config_digest`, `owner_epoch`, `budget_id`, `created_at`, `updated_at`. `repository_members[]` pins one canonical `repo_id`, canonical root identity, base revision, workspace, and integration status per repository. `workspace_id`/`base_revision` are optional single-repository convenience fields only and MUST agree with the single member when present. Each Task names its affected repository member IDs and per-member workspace/base revision. Cross-repository work integrates and verifies per repository; it is a journaled saga, not an atomic multi-repository commit. A partial integration is reported explicitly and never rolled back or declared complete as a unit without a reviewed compensation plan. |
| `Task` | `task_id`, `run_id`, `spec_digest`, `title`, `inputs[]`, `output_contract`, `acceptance_ids[]`, `deps[]`, `state`, `priority`, `write_scope`, `permission_ceiling`, `budget_id`, `attempt_limit`, `repository_member_ids[]`, `workspace_bindings[]`, `evidence_ids[]`. Each workspace binding carries its member ID, workspace ID, base revision, and fence epoch. `deps` must be acyclic. |
| `Attempt` | `attempt_id`, `task_id`, `strategy_id`, `model_route`, `repository_revisions[]`, `workspace_bindings[]`, `environment_digest`, `execution_limit`, `state`, `started_at`, `ended_at`, `failure_fingerprint`, `usage_status`. Attempts are append-only; retries create a new ID. One attempt may own several Threads; an individual Thread binds to at most one current Attempt. `execution_limit` is a finite immutable ceiling bounded by parent budgets. |
| `Workspace` | `workspace_id`, `provider_id`, provider version, scope/root identity, current immutable snapshot reference, dirty manifest digest, writer epoch, lease reference, status and cleanup state. Provider metadata carries Git path/branch/commit fields when applicable. Every mutation checks the current fence. |
| `WorkspaceBinding` | `workspace_id`, `provider_id`, `provider_version`, `repository_member_id?`, `base_revision`, `snapshot_ref`, `dirty_manifest_digest`, `generation`, `fence_epoch`, `lease_ref`, state. Git fields are adapter metadata. Direct turns do not require a fabricated repository member or Run. |
| `Budget` | `budget_id`, `parent_id?`, ceilings for money (`amount`, `currency`, `rate_snapshot?`), tokens/time/tool calls/worker-execution launches/output/event-log bytes/artifact bytes/concurrency, `reserved`, `spent`, `unknown_usage`, `verification_reserve`, `recovery_reserve`, `control_reserve`. Event-log and artifact sub-budgets are separately reserved so payloads cannot consume settlement capacity. `BudgetReservation` rows have stable IDs and idempotency digests. Unlike currencies are never added. |
| `Evidence` | `evidence_id`, `task_id`, `spec_digest`, `repository_revisions[]`, `workspace_digests[]`, `scenario_ids[]`, `producer`, `environment_digest`, `artifact_refs[]`, `verdict`, `limitations`, `created_at`. `verdict = PASS | FAIL | INSUFFICIENT_EVIDENCE`; only current `PASS` for every required member/revision unlocks a dependency. |
| `OriginalRequest` | `request_id`, `run_id`, `source_surface`, scoped `ArtifactRef payload_ref`, `payload_digest`, `received_at`, `actor_ref`, `control_session_ref`. Exact request bytes are immutable and retained with their source; normalized intent never replaces them. |
| `RunGoal` | `goal_id`, `run_id`, `objective_ref`, `outcome`, `success_conditions[]`, `verification_surface[]`, `constraints[]`, `scope[]`, `iteration_policy`, `blocked_stop_condition`, `lifecycle`, `budget_id`, `spec_digest`, `created_by`, `created_at`, `updated_at`. Goal is run-scoped, versioned, user-controlled, and never thread/session-scoped or global memory. `lifecycle = DRAFT | ACTIVE | PAUSED | BLOCKED | BUDGET_LIMITED | STOPPED | CANCELLED | COMPLETE`; `COMPLETE` requires current evidence, while budget/blocker states never imply success. Clearing a UI selection does not alter this lifecycle. |
| `SpecVersion` | `spec_id`, `run_id`, `parent_digest`, `digest`, `requirements[]`, `examples[]`, `invariants[]`, `exclusions[]`, `state: PROPOSED | APPROVED | SUPERSEDED`, `approver?`, `approved_at?`. Proposal is immutable by digest; approval binds to the exact digest and cannot be inferred from planner output. A clarification or material revision produces a child digest and invalidates any unused receipt for an ancestor digest. |
| `RepositoryMember` | `repo_member_id`, `run_id`, `repo_id`, canonical root identity, `base_revision`, `workspace_id`, `head_revision?`, `integration_state`, `verification_state`, `fence_epoch`. Tasks and evidence reference exact affected members and per-member revisions. |

## Execution and content identities

`WorkerExecution = { execution_id, launch_id, thread_id, turn_id?, model_attempt_id?, run_id?, task_id?, attempt_id?, host_ref, workspace_binding_ref?, adapter_build_digest?, state, observation_refs[], receipt_refs[] }`. Identities are immutable; external peer capability/cursor/usage details are stored only in ExternalExecutionBinding. A new incarnation receives a new execution/launch identity.

`Effect` is one prepared governed operation, owned by its initiating Thread/Run owner for intent/outcome, with independent CMP-audit prepare/terminal receipts joined by a stable effect ID. `Artifact = { scoped_namespace, digest, size, media_type, retention_owner_refs[], redaction_status }` identifies immutable bytes; CMP-artifact owns ingestion, bounded readers and lifecycle. `Completion` is a controller-derived result supported by current required Evidence, never an agent phrase or process exit.

Every globally unique identity is never reused. Events include schema version, aggregate ID, monotonic owner-local sequence, actor, causation/correlation IDs and payload/previous/event digests. Newer unsupported event versions are refused before partial replay.

## Repository and execution projections

`IndexGeneration` identifies an immutable published derived repository view; a binding
may join an immutable base generation and a workspace overlay generation. Source files
and WorkspaceProvider revision identity remain truth. The index schema, generation
publication and overlay records are defined in [Code intelligence](product/CODE-INTELLIGENCE.md).

`RepoBriefV1` and `TaskPackageV1` are bounded context selections from that view, defined
once in [Context](core/CONTEXT.md#repository-task-projections). A task package is a
projection/reference within `ContextPacketV1`, not another canonical task or packet
store. Direct-turn packages refer to admitted intent without fabricating a Task.

`ChangeReceiptV1` is the runner's composite observation of settled edits, index updates,
formatting, diagnostics, selected checks, diff and impact, defined once in
[Scheduling](execution/SCHEDULING.md#deterministic-coding-pipeline). Its constituent
facts retain their original owners. It does not imply independent verification PASS.
