# External agents

## Purpose and ownership

External coding agents participate as subordinate Workers through WorkerFabric.
[CMP-orch](../execution/ORCHESTRATION.md) owns dispatch, durable attempts, budgets,
stop decisions and verification; [Workers](../execution/WORKERS.md) owns the generic
WorkerAdapter contract. This adapter owns foreign protocol/config translation and
bounded observations. It owns no second controller, permission engine or task store.

## Architecture

```text
RunController -> committed dispatch -> WorkerFabric -> WorkerAdapter
                                                 -> ExecutionHost + SandboxPlan
                                                 -> ACP peer / opaque CLI
owner streams <- validated observations + bounded receipts <- adapter
```

A Worker is a role/profile, Runner is the native loop, WorkerExecution is one
incarnation, ExecutionHost owns process lifecycle, WorkspaceProvider owns mutable
software state, and Sandbox owns applied confinement. Foreign Session handles are
adapter bindings, never Horizon Thread identities.

## Public contracts and data

Use the canonical WorkerAdapter operations: probe, start, send, observe, interrupt,
cancel, resume and reconcile. Pin adapter build digest, profile digest, negotiated
protocol/capabilities, peer identity and WorkspaceBinding to WorkerExecution before
launch. Optional capabilities are independently observed: progress, tool events,
usage, cancellation, session load/resume, workspace ownership, permissions and nested
agents. Unexposed facts remain UNKNOWN; product names never imply capability support.

The external binding records peer/session identity, protocol/schema version,
capability digest, last validated event cursor and receipt references. Event pages
are byte/count/depth bounded and scoped to the bound execution. Preserve the owner's
causal sequence; transport sequence is not a global Run/Thread order. Duplicate
sequence with different content is corruption. A gap requires a negotiated snapshot
or explicit reconciliation; never synthesize missing effects or progress.

WorkerConfigRenderer creates disposable digest-pinned foreign configuration from
approved policy/capability snapshots. It rejects unsupported security mappings,
scrubs secrets, and activates before an eligible launch. Rendered files are adapter
inputs, not policy authority; configuration translation proves no OS guarantee.

## Normal flow

1. Probe required capabilities and authenticate the peer or local managed process.
2. Reserve scheduler/process/connection/output capacity and the approved budget.
3. Bind the workspace snapshot, write scope and fence epoch. Commit dispatch before
   host launch; supply no operator credential, control socket or canonical state path.
4. Negotiate the selected ACP schema or invoke a configured CLI with argv and bounded
   I/O. Remote peers require explicit identity, authorization, encrypted transport,
   host fencing and observed confinement; unsupported requirements refuse delegation.
5. Validate frames and correlate observed tools/effects/permission requests before
   committing owner observations. Peer results are data, never approval or PASS.
6. Integrate candidate workspace changes through IntegrationCoordinator; verify the
   exact combined revision independently before task acceptance.

For ACP, baseline wire version and SDK/package release are different values. Use
[Protocols](PROTOCOLS.md) capability fixtures, correct request direction and persisted
PermissionBridge routing. Parent tickets never cross the peer boundary. Each peer
filesystem/terminal proposal is locally authorized and confined within the parent
ceiling. A peer elicitation or approval-looking prompt cannot mint operator approval.

For opaque CLI agents, observe authenticated process identity, exit status, bounded
stdout/stderr, workspace diff and Horizon-run checks. Internal tools, hidden agents,
quota and cost remain unknown unless exposed with trustworthy measurement. A process
exit or “done” text does not prove successful effects, Task PASS or termination of
all descendants. A required unobservable cost ceiling refuses or uses an explicitly
approved token/other known bound; estimates are labelled separately from observations.

## Recovery, cancellation and errors

Persist capability snapshot and cursor before disconnect handling. Resume/load only
when negotiated; a fresh peer session requires an explicit new Attempt or approved
bounded handoff after reconciliation. Controller upgrades retain the exact adapter
build or use a versioned compatibility path; never parse old events as new schemas
by assumption. Unknown effects and surviving writers retain fences/leases.

Cancellation records owner intent first, requests the supported peer/host control,
and observes actual settlement. A transport acknowledgement is not rollback or proof
of termination. Deny/cancel orphaned permission requests by their finite deadline;
parent control remains responsive. Worker loss, malformed frames, output floods,
wrong principal, schema drift or unsupported resume produce typed outcomes and retain
available receipts. Never replay a possibly completed non-idempotent operation merely
because its response was lost.

## Resource bounds and acceptance

Apply finite depth, count, parallelism, wall time, process/PTY/descriptor, queued byte,
event page and receipt limits. Delegation is optional and justified by independent
work, integration cost and remaining budget. Limits and retry spend survive restart
and adapter replacement. Acceptance covers spoofed identity/approval, wrong-connection
permission replies, disconnect/expiry, schema/cursor drift, unknown-cost refusal,
opaque CLI observations, orphan descendants, cancellation races, process-exit unknown
effects, workspace conflicts and independent post-integration verification.
