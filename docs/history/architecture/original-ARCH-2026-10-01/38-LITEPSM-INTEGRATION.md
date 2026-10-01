# 38 — LitePSM Extension Management Adapter

Status: **proposed**; DEC-094. HorizonCode and litePSM are separate products/processes.
Sibling architecture is a design dependency, not implementation/conformance evidence.
This document owns their integration contract; ARCH/21 remains extension UX owner.

## Ownership and topology

```text
Horizon TUI/CLI -> ControlService -> ExtensionManager port -> LitePsmAdapter
                                              -> MCP stdio bridge -> litePSM daemon
Horizon model -> registry -> Guard/budget/effect prepare -> adapter -> invocation
Horizon ControlService <- mapped status / scoped receipts / bounded observations
```

litePSM owns its catalog releases, install plans, package CAS, install journal,
provider processes, provider-side grants and provider credentials. Horizon owns
Thread/Run/Task/Attempt state, input receipts, local permissions, budgets, context,
artifact/evidence stores, audit and verification. Horizon never opens litePSM SQLite,
mutates its CAS/config directly, or launches a second copy of its managed provider.
The static marketplace is read-only metadata, never an authority or executor.

The selected extension manager is explicit per scope: `native` or `litepsm`. A given
managed installation has exactly one lifecycle owner. Existing native definitions
remain supported and detected read-only; moving one requires an explicit adoption
plan and backup. No duplicate installer/catalog builder is implemented in Horizon
for litePSM-managed entries. Native hooks, local skill discovery and release-owned
model adapters remain Horizon services. Switching managers does not migrate data,
credentials or grants, or silently reconnect an active Run.

The initial adapter uses the portable 12-tool MCP bridge described by litePSM ARCH/06:
search_catalog, get_extension, prepare_install, request_install, list_installed,
search_capabilities, describe_capability, load_skill, read_skill_resource,
invoke_capability, get_invocation, cancel_invocation. Probe actual advertised schemas;
unsupported methods stay unavailable. Direct local IPC and projected native tools
require additional versioned authenticated contracts; never assume they exist.
Horizon is not currently a named litePSM HostAdapter. Manual MCP registration is the
initial integration path; automatic setup needs a separate tested host adapter.

## Port and normalized schemas

```text
ExtensionManager {
  probe(profile) -> ManagerSnapshot;
  search(query, cursor, limits) -> ListingPage;
  inspect(external_ref) -> ExtensionDetail;
  prepare(change, scope) -> ManagedPlan;
  execute(plan_ref, authorized_channel_ref, operation_id) -> OperationReceipt;
  installed(scope, cursor) -> InstallationPage;
  describe(capability_ref) -> CapabilitySnapshot;
  load_skill(skill_ref, limits) -> SkillSnapshot;
  invoke(admitted_call, operation_id) -> InvocationReceipt;
  observe(invocation_id, cursor) -> InvocationStatus;
  cancel(invocation_id, operation_id) -> CancellationReceipt;
}
ManagerSnapshotV1 {
  schema_version: 1, adapter_id, adapter_version, external_protocol_version,
  manager_instance_id, transport, observed_at, supported_methods[],
  approval_channels[], scope_support[], confinement_observation, status
}
ManagedExtensionRefV1 {
  schema_version: 1, manager_instance_id, external_listing_id,
  external_installation_id?, catalog_release_id?, external_version?,
  external_digest?: {algorithm: sha256, value}, horizon_metadata_digest,
  workspace_id?, canonical_project_root?, owner: litepsm|native
}
ManagedPlanV1 {
  plan_ref, external_plan_hash: {algorithm: sha256, value},
  full_plan_ref, expires_at, target_scope, effects[], preconditions[],
  approval_channel, horizon_policy_digest, observation_generation
}
InvocationReceiptV1 {
  operation_id, horizon_effect_id, external_invocation_id?, capability_ref,
  schema_fingerprint, environment_identity, policy_digest,
  state: prepared|running|waiting_approval|settled|failed|cancelled|unknown,
  result_ref?, external_receipt_ref?, certainty, event_cursor?
}
```

Versions are explicit; unknown enum/required fields fail closed. Limits apply to all
pages, schema depth/bytes, decoded payloads and concurrent calls. Preserve external ID
escaping and digest algorithm labels; SHA-256 package/plan identities never become
Horizon BLAKE3 identities by relabeling. Scope binds canonical WorkspaceId and project
root through the existing WorkspaceProvider; hostId text alone is not authentication.
Delivery statuses proposed/implemented/verified/accepted/blocked remain distinct from
litePSM runtime readiness and catalog evidence labels.

## Approvals and effect settlement

1. Search/inspect is bounded inert metadata. Prepare shows exact packages, versions,
   scope, changes, dependencies, runtime/credentials and requested reach.
2. Horizon Guard authorizes the delegated effect; the existing audit/effect owner records its durable prepare receipt.
   litePSM separately authorizes its own operation. Both must permit execution;
   an external allow cannot widen Horizon authority.
3. Needs You may display a litePSM challenge but cannot mint its approval token.
   Require a proved authenticated native-host/user channel binding principal,
   plan/capability hash, scope, expiry and one-time semantics. Until available, show
   the supported CLI approval path and wait. Model text and `approved:true` never
   approve; approvalToken is never supplied as model-visible text or logs.
4. Execute pins full external plan/schema and local policy snapshot. Changed digest,
   stale plan, missing binding or unknown remote identity refuses before dispatch.
5. Settle exact external result/receipt into Horizon's effect record. Lost response
   remains UNKNOWN until reconciled by invocation identity; never replay a possible
   external write because an MCP connection died. If the bridge lacks idempotent
   dispatch/reconciliation, non-idempotent calls remain unavailable for unattended use.
6. Cancel requests external cancellation and observes settlement; transport cancel
   or boolean acknowledgement does not prove termination or rollback. Retain fences/leases protecting uncertain in-flight writes until authoritative
   settlement or explicit safe reconciliation; spinner/transport cancellation never
   releases them.

The routed `invoke_capability` is not a generic permission escape: obtain and validate
the selected capability's schema/identity/effect declarations before every admitted
call. Unknown effects require explicit capability approval or deny. Revalidate live
revocations and bind `(capability_id, schemaFingerprint, casTreeDigest)` locally or
the supported remote origin/version tuple. No wildcard grant to every bridge tool.
Current model-step schemas stay immutable; drift invalidates future execution.

## UI, startup and lifecycle

Existing `/extensions`, `/mcp`, `/skills`, `/plugins`, `/marketplace` and `/litepsm`
all reach the same overlay through shared actions; `/litepsm` selects its manager.
Tabs retain Search/Installed/Create where supported. Cards lead with name, purpose,
readiness and next action; manager/source/hashes expand in Details. Installed and
Detected are visibly different. Actions: Inspect, Prepare install, Review plan,
Approve via supported channel, Cancel, Retry safe phase, Configure, Probe, Enable,
Disable, Update preview, Remove preview, Adopt preview, Doctor. Unsupported mutations
show a reason and CLI fallback, never an invented bridge method.

Install/probe/auth/enable is a resumable stepper; cancellation preserves pre-existing
config. Detected external entries are read-only until explicit adoption. Offline
catalogs show age/release/completeness; unavailable daemon never blocks the core
composer or forces a native-manager fallback. User Connect is separate from install.
Provider credentials stay in their manager's broker; raw tokens are never copied
between products. Plugin hooks/scripts still need Horizon policy and confinement if
Horizon executes them. Imported skill bodies are untrusted bounded instructions;
Horizon persists visibility by source identity/digest, not upstream file mutation.

Separate daemon/provider execution is outside Horizon's local sandbox. Display the
actual external reach tier/residual and refuse requirements that need unproved OS
confinement. litePSM architectural process supervision does not prove filesystem or
network confinement. Shutdown/detach of Horizon does not stop unrelated litePSM
providers. Disable fences new calls first, then reconciles in-flight effects.

## Sibling compatibility gates found during review

The sibling documents contain unresolved examples/contracts that Horizon must not
copy: JSON Schema `type: bool`; install-plan example fields excluded by the displayed
closed schema; `invalidated` grant state absent from shown SQL constraint; ambiguous
planHash self-exclusion/expiry binding; rollback versus forward-recovery inconsistency;
NORMAL SQLite durability versus power-loss claims; missing IPC framing/message limits;
hostId-based caller identity; conflicting secret-environment claims; and an MCP newer
profile whose stability differs from Horizon's selected released protocol.

Before adapter acceptance, pin a sibling release with valid schemas/golden plans,
explicit authenticated approval channel, bounded framing/cancellation/reconciliation,
resolved journal/durability guarantees and versioned MCP conformance. A generic
MCP probe can inspect capabilities before these gates pass, but cannot establish
unsupported effect, grant or confinement guarantees. The sibling repo is read-only in
this task; its defects remain named dependencies, not silently corrected here.

Acceptance: ACC-EXT-01 in ARCH/23. Delivery: AX-407. Research provenance and exact
sibling snapshot are recorded in ARCH/29 and the dated review report.
