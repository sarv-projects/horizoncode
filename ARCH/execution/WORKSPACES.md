# Workspaces

## Purpose and ownership

CMP-workspace owns WorkspaceProvider, workspace identity, and IntegrationCoordinator.
CMP-orch holds write fences and reservations; Guard authorizes actions and Sandbox
confines reach. Workspace and WorkspaceBinding schemas are defined once in [Domain
model](../04-DOMAIN-MODEL.md). Workspace is not synonymous with Git worktree.
CMP-repo-intel owns every index and binds index views to the workspace revision;
workspace providers do not create their own parallel index.

## Data model

Shared identities use [Domain model](../04-DOMAIN-MODEL.md); state vocabulary uses
[State machines](../contracts/STATE-MACHINES.md).

| Record | Required fields and constraints |
|---|---|
| `ExecutionEnvironmentSnapshot` | `snapshot_id`, `spec_digest`, `host_type`, `os_family`, `architecture`, `runtime_versions`, `toolchain_digests`, `environment_digest`, `observed_at`, `unknown_fields[]`. It records observed identity, not confinement or reproducibility proof. |
| `IntegrationCandidate` | `candidate_id`, `task_id`, `workspace_binding`, `base_revision`, `proposed_snapshot`, `changed_paths[]`, `worker_receipt_ref`, `state: READY | CONFLICT | INTEGRATED | REJECTED | UNKNOWN`. Integration order is stable by approved graph order then task ID; overlapping paths require explicit policy/review. Integrated revisions require fresh verification. |
| `WorkspaceIndexBindingV1` | `workspace_id`, `provider_id`, `provider_version`, `base_revision`, `base_index_generation?`, `overlay_generation?`, `editor_buffer_generation?`, `workspace_revision`, `read_scope_digest`, `policy_snapshot_digest`, `index_schema_version`, `freshness: CURRENT | STALE | UNAVAILABLE`, `coverage: COMPLETE | PARTIAL | UNSUPPORTED`, `pin_refs[]`. It is a revision-bound reference to `CMP-repo-intel` generations, not another index or source of repository truth. |

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

Each receipt binds provider identity/version, immutable base/current snapshot, dirty
manifest, generation and fence. Unsupported capabilities return typed errors. Git is an
adapter: path, branch and commit metadata never enter kernel preconditions. A
fake-provider contract demonstrates abstraction; real remote/container providers
need their own durability, isolation and recovery acceptance.

## Layered repository-index view

A workspace index view is resolved as an immutable base generation plus a bounded,
workspace-specific overlay. The base generation is pinned to its exact base revision, read-scope and policy
snapshot, and parser/index identities. Each overlay records only changed
files/symbols/edges, new files, and tombstones for deleted files, together with its
workspace revision and generation. Unsaved editor buffers are a separate, versioned view layered above the
on-disk workspace records; they never mutate the committed base index.

A query resolves overlay entries first. An overlay tombstone suppresses the matching
base record; an overlay replacement/new entry shadows it. Unshadowed lookups fall
through to the pinned base generation. Every answer names both the effective
workspace revision and the generations used. A mismatch, missing overlay component,
expired pin, watcher overflow, or unverified source change returns typed stale/partial
coverage and triggers bounded reconciliation; it is not silently served as current.

Subworkspaces and worktrees share the immutable base generation by reference and do
not copy a multi-gigabyte index. Their overlays remain isolated by provider/workspace
identity, source revision, permission scope, and generation. A base generation can be
shared only when the child is authorized for its complete indexed file set; a narrower
child receives a scope-specific generation or no index result. A changed branch or base
commit selects a matching existing base generation only after identity validation;
otherwise the query is stale/unavailable while a new base generation is built. Base
and overlay retention is bounded, but active Run, TaskPackage, query, worker, or
recovery pins must be released or reconciled before reclamation.

Index generation is derived cache state. `CMP-workspace` remains authoritative for
which files actually exist and for snapshots, diffs, changed paths, integration,
restore, and disposal. `CMP-repo-intel` owns manifest/digest validation and overlay
construction. Index lookup never authorizes a read or a write; current Guard/Sandbox
and file identity checks still apply.

## Ordinary coding and integration

Ordinary direct coding edits the selected workspace under its governed write channel.
Explicit isolated exploration or managed unattended work obtains an isolated provider
snapshot. Users may inspect, apply or discard results without claiming verifier PASS.
Isolation constrains workspace mutation; external effects still need their own
authority.

IntegrationCoordinator orders approved candidates by graph order then task ID, never
completion time. Overlapping paths require governed conflict review; no silent
overwrite. Record base, proposed and integrated revisions and bounded conflict
evidence. Every combined revision is a new verification subject. Cross-repository
integration is a journaled saga with explicit partial outcomes and reviewed
compensation; it is not an atomic commit. Reaping requires proven terminal writers,
released pins, reconciled effects and current ownership.

After WorkspaceProvider returns an exact successful integration receipt, the
controller provides the integrated changed-path batch and expected before/after
workspace revisions to `CMP-repo-intel`. The indexer validates actual file identities
and digests, then advances the main workspace overlay or binds a matching new base
generation. It does not trust worker claims or blindly import the child index. If
integration is partial, unknown, or the actual content differs from the receipt, keep
the view stale and reconcile from the workspace. A successful index update is not
verification evidence and does not settle Task state.

Environment/toolchain drift produces a new observed snapshot and explicit
reconciliation before reuse; unknown fields stay unknown. Environment identity is not
confinement or reproducibility proof.

## Lease and integration fencing

Persist lease owner/epoch, wall deadline, bounded duration and clock/boot identity. A
monotonic number alone cannot survive reboot. Expired or unknown leases require
process/effect reconciliation before reclaim. Every write, restore, integration and
disposal checks the current fence. Index update jobs and overlay publication are
fenced by the same workspace identity and expected generation; an old child process
cannot publish after its workspace lease or generation has changed.

## Configuration and acceptance

Finite workspace count/disk ceilings, Git root policy, lease durations, reaping
cadence, stable merge strategy and surface-only conflict policy must be schema bound.
Index overlay retention, generation pins, per-workspace cache/disk quotas, and
reconciliation budgets are also finite and schema bound. Acceptance covers stale
fences, reboot/clock changes, overlap, partial integration, platform/provider loss,
verification invalidation, branch/base transition, overlay tombstones, buffer
isolation, shared-base safety, generation pin release, stale child publication, and
index freshness after integration (`ACC-REPO-OVERLAY-01` in the
[acceptance matrix](../acceptance/ACCEPTANCE-MATRIX.md)).

## Integration receipts

`MergeResult = { applied[], conflicts[{path, base, ours, theirs, evidence_ref}], method, deterministic_key }`. Provider-specific revision values are opaque qualified identities. Conflicts preserve all three subjects and bounded evidence; a successful provider merge never marks Task PASS. Inspection, integration, restore and disposal are separate governed actions with their own expected generation/fence.
