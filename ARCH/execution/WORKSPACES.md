# Workspaces

## Purpose and ownership

CMP-workspace owns WorkspaceProvider and IntegrationCoordinator. CMP-orch holds write fences and reservations; Guard authorizes actions and Sandbox confines reach. Workspace and WorkspaceBinding schemas are defined once in [Domain model](../04-DOMAIN-MODEL.md). Workspace is not synonymous with Git worktree.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses [State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `ExecutionEnvironmentSnapshot` | `snapshot_id`, `spec_digest`, `host_type`, `os_family`, `architecture`, `runtime_versions`, `toolchain_digests`, `environment_digest`, `observed_at`, `unknown_fields[]`. It records observed identity, not confinement or reproducibility proof. |
| `IntegrationCandidate` | `candidate_id`, `task_id`, `workspace_binding`, `base_revision`, `proposed_snapshot`, `changed_paths[]`, `worker_receipt_ref`, `state: READY | CONFLICT | INTEGRATED | REJECTED | UNKNOWN`. Integration order is stable by approved graph order then task ID; overlapping paths require explicit policy/review. Integrated revisions require fresh verification. |

## Provider contract

```text
WorkspaceProvider.create(request) -> WorkspaceBinding
WorkspaceProvider.snapshot(binding) -> SnapshotReceipt
WorkspaceProvider.diff(base, current) -> BoundedDiff
WorkspaceProvider.changed_paths(base, current) -> ChangedPathPage
WorkspaceProvider.integrate(candidate, expected_generation) -> IntegrationReceipt
WorkspaceProvider.restore(snapshot, expected_generation) -> RestoreReceipt
WorkspaceProvider.dispose(binding, expected_fence) -> DisposalReceipt
```

Each receipt binds provider identity/version, immutable base/current snapshot, dirty manifest, generation and fence. Unsupported capabilities return typed errors. Git is an adapter: path, branch and commit metadata never enter kernel preconditions. A fake-provider contract demonstrates abstraction; real remote/container providers need their own durability, isolation and recovery acceptance.

Ordinary direct coding edits the selected workspace under its governed write channel. Explicit isolated exploration or managed unattended work obtains an isolated provider snapshot. Users may inspect, apply or discard results without claiming verifier PASS. Isolation constrains workspace mutation; external effects still need their own authority.

## Lease and integration

Persist lease owner/epoch, wall deadline, bounded duration and clock/boot identity. A monotonic number alone cannot survive reboot. Expired or unknown leases require process/effect reconciliation before reclaim. Every write, restore, integration and disposal checks the current fence.

IntegrationCoordinator orders approved candidates by graph order then task ID, never completion time. Overlapping paths require governed conflict review; no silent overwrite. Record base, proposed and integrated revisions and bounded conflict evidence. Every combined revision is a new verification subject. Cross-repository integration is a journaled saga with explicit partial outcomes and reviewed compensation; it is not an atomic commit. Reaping requires proven terminal writers, released pins, reconciled effects and current ownership.

Environment/toolchain drift produces a new observed snapshot and explicit reconciliation before reuse; unknown fields stay unknown. Environment identity is not confinement or reproducibility proof.

## Configuration and acceptance

Finite workspace count/disk ceilings, Git root policy, lease durations, reaping cadence, stable merge strategy and surface-only conflict policy must be schema bound. Acceptance covers stale fences, reboot/clock changes, overlap, partial integration, platform/provider loss and verification invalidation.

## Integration receipts

`MergeResult = { applied[], conflicts[{path, base, ours, theirs, evidence_ref}], method, deterministic_key }`. Provider-specific revision values are opaque qualified identities. Conflicts preserve all three subjects and bounded evidence; a successful provider merge never marks Task PASS. Inspection, integration, restore and disposal are separate governed actions with their own expected generation/fence.
