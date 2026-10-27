# 14. Effects, execution, security and extension trust


> **Authoritative integration amendment, 2026-10-10:** This chapter is read with the v2 decisions in `17-GOVERNANCE-DECISIONS.md` and the active implementation/service chapters 20 and 37. Older designs of a competing Rust canonical Session, automatic model selection or unconstrained agents are superseded **only where explicitly contradicted**. Existing code does not become implemented by this edit.

## 2026-10-10 OpenCode-first reconciliation
### Concrete effect broker guards
```text
admit(intent):
 assert schema-valid, actor-authorized, action permitted by chosen mode
 normalize real path, network origin, env, write targets and arguments
 check worker fence, workspace lease, expected file hashes
 match existing idempotency receipt or reject differing payload
 reserve required budget and effect row
 dispatch to sandbox with scoped short-lived capability
 reconcile observed after-state, capture digest/exit/env
 persist APPLIED / REJECTED / UNCERTAIN; return immutable receipt
```
**YOLO is not root access**: `yolo_sandbox` only suppresses UI prompts for actions still governed by actual OS isolation; production writes, environment escalation and external side effects remain privileged. If supported OS isolation cannot be verified, it is unavailable.
**Side-effect classification**: reversible (scoped patch), compensatable (PR or staging deployment), externally uncertain (remote API), irreversible (destructive production migration). Different recovery and approval.
**Cross-agent coordination**: all writes use fencing+hash precondition; shell, MCP, browser and provider-hosted tools cannot bypass the broker. Before releasing sandbox resources, settle subprocesses, ports, mock services, test DB and artifacts.

---

This is the detailed enforcement contract for `05-SECURITY.md`. Guard, EffectService
and ExecutionHost are distinct modules: Guard decides authority; EffectService makes
the intent durable and settles outcomes; ExecutionHost performs and observes the
operation. A permission UI or process wrapper alone is not an authorization or
isolation guarantee.

## 14.1 Threat model and authority law

Treat model output, prompts from repositories, issue/web/document text, provider
metadata, plugin packages, skills, workflows, MCP/ACP traffic, external-agent output,
process output and diagnostics as hostile data. They may suggest an operation but may
not create authority, select an actor, widen policy, declare Task PASS, mutate
canonical state, or claim that an uncertain external effect did not happen.

Effective capability is the intersection:

```text
system floor
∩ managed/organization policy
∩ user security policy
∩ project restrictions
∩ approved Run policy snapshot
∩ Task and Attempt scope
∩ AgentProfile ceiling
∩ exact temporary grant
∩ current workspace lease/fence
∩ platform capability actually available
```

Any higher-level deny is final; lower levels can only narrow. Ordinary preference
precedence (theme, selected model, layout) is a separate system. Profile, project,
plugin, tool description, skill `allowed-tools`, command aliases and UI visibility
are not permission grants. A provider-hosted/opaque tool is disabled in governed mode
unless authorization can be enforced before provider-side execution; a post-fact
hook is not mediation.

Principal and scope are derived from an authenticated application ingress and the
private host/kernel connection. Request payloads cannot self-assert a user, Thread,
Run, Task, current profile generation or supervisor epoch. Child authority is the
intersection of its parent, profile, Task and policy; never the union.

## 14.2 Guard decision and durable approval

Guard input is a canonical `AuthorizationRequestV1`:

```ts
type AuthorizationRequestV1 = {
  requestId: string
  principal: PrincipalRef // derived by ingress; not accepted as caller authority
  origin: EffectOriginV1
  profileRevision: ProfileRevisionRef
  compositionGeneration?: CompositionGenerationId
  actionId: string
  argumentDigest: Digest
  resourceResolution: ResourceResolutionV1
  workspaceBinding?: WorkspaceBindingRef
  executionLocation: ExecutionLocationRef
  policySnapshotIds: string[]
  budgetReservationId?: ReservationId
  requestedGuarantees: GuaranteeRequirement[]
}
type GuardDecisionV1 = {
  decision: "ALLOW" | "ASK" | "DENY"
  decisionId: string
  policyDigest: Digest
  normalizedAction: string
  resourceDigest: Digest
  guaranteeAssessment: GuaranteeAssessment[]
  challengeId?: ApprovalChallengeId
  reasonCodes: string[]
  expiresAt?: Timestamp
}
```

Resource resolution occurs before Guard and uses the domain owner that enforces the
resource: filesystem/root handles for paths, WorkspaceService for workspace/revision,
network policy for destinations, MCP registry for server/tool identity, or connector
owner for external object IDs. Canonical path checks include symlink/reparse target
and are repeated at the enforcement/open boundary. If resolution is ambiguous, fail
closed or ask the operator; do not guess.

`ALLOW` is usable only for the exact action, argument digest, resources, revision,
principal, policy snapshot, profile/plugin generation, execution location and
expiry. `ASK` persists a single-use `ApprovalChallenge` before presenting it. The
screen shows verbatim normalized action, exact resolved resources, important
argument summary, requested/residual guarantees, policy/source, affected Thread/Run,
expiry, and what happens on no response. `ALLOW_ONCE` yields a bounded single-use
capability. `ALLOW_RUN_SCOPE` creates a revocable grant bounded to the exact Run,
principal, action/resource scope, policy digest and expiry; every later effect still
passes current Guard and execution checks. Neither response creates a permanent or
machine-wide wildcard policy. If any bound input changes, invalidate the challenge
and re-run Guard.
Interactive terminals use a distinct `InteractiveTerminalGrantV1`; it does not widen
`ALLOW_RUN_SCOPE`, which remains limited to an exact Run. The grant is created only
after an explicitly approved `terminal.start` has passed Guard and its durable
`EffectIntent` is PREPARED. The one-use launch lease is consumed by the admitted
launch; the resulting grant binds `grantId`, Rust-derived principal, host identity,
execution Location/workspace, terminal ID, exact normalized launch/config digest
(including executable/profile, command/args, cwd, environment digest, backend and
guarantee assessment), owner epoch and fence generation. It has an explicit
`expiresAt`, no more than 60 minutes after approval, and a revocation/fence state.
Every input/resize continuation rechecks current Guard policy and all grant bindings,
deadline, generation and fence. Grant expiry, explicit revocation, cancel or owner
loss fences the grant before termination; no automatic re-prompt or resume is allowed.
An expired, revoked, stale-generation or stale-fence grant cannot authorize any
further input or resize.

`terminal.cancel` is an owner-only control continuation for the exact terminal and
generation; it may reduce authority without fresh approval, but cannot start a
process or broaden a grant. It records a control receipt and persists the fence
before requesting termination. The interactive lease is not a permanent or
machine-wide policy grant.

For a managed effect, HostKernel retains only the authenticated parsed Attempt scope associated with the prepared capability lease. Immediately before resolving approval and issuing that lease, it re-resolves the current Attempt, owner epoch/revision, immutable DelegationBinding digest and live workspace/capability/budget/resource leases from canonical owners. Any mismatch, cancellation, revocation or owner restart denies before lease issue; an ephemeral approval binding is discarded on restart. The managed effect scope is not caller JSON authority, and this check does not widen the challenge-bound action.

Model-batch approval is host-issued and challenge-bound: `effects.v2.prepare_tool_batch`
returns `{status:"prepared",effectID,capabilityLeaseDigest}` only on ALLOW; ASK
returns a Guard challenge and no digest. After explicit `allow_once` against that
exact challenge, `effects.v2.resolve_approval` returns
`{status:"approved",effectID,capabilityLeaseDigest}`. Denial, expiry, mismatch or
missing approval returns no digest. The opaque, one-use digest is host-issued and
bound to challenge, input, Location, principal and owner epoch; only
`terminal.run`/`terminal.start` consume it.

Approval is surfaced as a `GuardApproval` EventV2 and a protected
`POST /api/guard/approval/:approvalID/reply` endpoint. `approvalID` is generated by
the server; the request body contains only
`{decision:"allow_once"|"deny"}`. There is no generic per-challenge `always`,
auto-accept or `ctx.ask` approval path. The explicit bounded
`DirectSessionGrantV1` choices below are the supported low-friction path for
routine direct coding; they do not turn an individual challenge into open-ended
approval. The approval UI presents the exact normalized action, resolved
resources, policy and expiry, and never exposes raw environment secrets. Approval
must match the persisted challenge binding; request-origin/surface provenance is
part of the binding.
The HTTP reply takes only the server-generated `approvalID` path parameter and
`{decision}` body. Core `replyGuardApproval({approvalID,decision})` resolves the
hidden challenge and Location from its pending record and checks the request's
trusted principal; callers never supply `challengeID`, `locationID` or principal.
Missing and wrong-principal IDs return the same 404; expired, replayed or stale
approvals return 409; malformed decisions return 400. With ServerAuth enabled the
trusted subject is the validated username, never the password; otherwise Core passes
only a host-OS marker and the kernel derives UID/SID.


`normal`, `reduced` and `auto-safe` are policy postures, not bypass modes.
`auto-safe` resolves ASK only for policy-designated low-risk action classes and
within exact resource/limit constraints. Broad delete, credential export, public
publication, arbitrary external filesystem, policy DENY and catastrophic actions
remain manually denied or explicitly reviewed by policy.

### Direct-session workspace grants

Direct-session consent UX has independent **sandbox** and **approval** controls,
matching the practical Codex pattern described in §42. (1) **Ask for approval**
is `workspace-write` + `on-request`: routine work inside the selected workspace
proceeds without repeated prompts, and effects crossing that boundary ask. (2)
**Full access** is `danger-full-access` + `never`: after an explicit user choice
for the current Session, local file, network and process operations are not
prompted or restricted by a HorizonCode sandbox. (3) **Custom** lets the user
choose sandbox and approval frequency independently. `always` asks before each
effect; `on-request` asks at the selected boundary; `never` does not ask within
the selected sandbox. Read-only remains available as a narrower sandbox.

The selected `DirectSessionPermissionModeV1` is resolved from authenticated
user configuration and projected to the canonical Rust Guard with exact
principal, Session/owner epoch, workspace, backend and policy bindings. It does
not create a lease or skip Guard. Each effect still gets current owner/scope
validation, budget admission, durable intent, a one-use lease, ExecutionHost
dispatch and receipt/UNKNOWN recovery. Under Full access, Guard must honor the
user's explicit no-prompt choice for otherwise supported effects; it may reject
only malformed or stale authority, explicit user/config policy, platform or
backend unavailability, resource limits, and non-bypassable protocol integrity
failures. Those errors must be reported as technical unavailability, not shown
as repeated approval prompts. Full access makes no OS-confinement claim and the
UI states that destructive commands, external files and network access are
enabled. Unsupported native platform paths remain unavailable.

This setting does not silently apply to managed Attempts or children. Managed
work uses the accepted SpecVersion and live AgentProfileV2 authority. Search,
provider and other separately billed routes still require their own explicit
cost consent; Full access is not consent to paid fallback. `DirectSessionGrantV1`
below remains useful for users who prefer a narrow reusable workspace grant,
but it is not the only way to avoid per-effect approval prompts.

`ALLOW_RUN_SCOPE` is managed-Run authority and is not usable by a direct Core
Session, which has no managed Run. Direct coding uses the same Guard and
ExecutionHost, with a separate persisted `DirectSessionGrantV1` representing an
explicit user choice. Bounded reads inside the registered workspace follow the
baseline read policy and require no write/process grant. Approval frequency is selected
through `DirectSessionPermissionModeV1` (`on-request`, `always`, or `never`); it is not stored
as a grant preference. A challenge, when the selected policy requires one, offers **Allow once**, **Allow this Session**,
**Remember for this workspace**, or **Deny**. The prompt identifies the exact action and
bounded scope; once issued, a matching grant removes repeated dialogs while every operation
still receives fresh Guard evaluation, budget admission, intent, lease and receipt checks.
Opening a folder, choosing a profile, enabling a plugin, model output, or a legacy
`PermissionV1` "always" value never creates this grant.

`Allow this Session` expires when its Core Session closes or is replaced, the
authenticated principal changes, the owner epoch changes, or the user revokes it.
`Remember for this workspace` is an explicit user-owned setting with a maximum
30-day lifetime and immediate revocation. Both grant kinds bind the authenticated
principal, exact Session (for session grants), owner epoch, registered Location/workspace
identity and root digest, selected execution backend, guarantee-set digest, current policy
digest, and allowed action/resource/limit scope. Workspace relocation, root or backend
change, guarantee loss, policy digest change, expiry, owner loss, session replacement or
revocation disables it before dispatch;
reconfirmation is required. The model and callers cannot create, widen, extend,
or renew grants.

On a backend whose workspace-write confinement has passed the required OS
acceptance, a user-approved `workspace-code` scope allows routine reads and edits.
Build, test, and child-process actions are included only when their specific process,
filesystem, and network controls have passed acceptance for that backend. Network is denied by
default; the user may add exact destinations/protocols and finite request/byte
budgets through a separate authenticated grant decision. Wildcard egress is never
part of `workspace-code`. Credential/secret access, publication, destructive
workspace reset, and all out-of-scope paths remain excluded. The grant is a policy input, not a Guard
bypass: every ToolBatch and each CodeMode wave still receives fresh resource
resolution, current-policy evaluation, bounded budget reservation, durable
EffectIntent, one-use lease, ExecutionHost enforcement and receipt/reconciliation.
An exact safe operation under that scope resolves without an interactive prompt;
crossing the grant boundary produces one challenge for the exact operation or
atomic batch. DENY, missing guarantees, unsupported platforms and unresolved
resources remain unavailable or require an explicit narrower operation. Never
claim this low-friction profile on a backend that cannot enforce its stated
workspace, network and secret boundaries.

This is the sole user-consent authority for direct-session effects. Core's legacy
permission store may still provide presentation compatibility, but its decisions
cannot authorize, suppress or answer a Rust Guard challenge.

## 14.3 Effect pipeline and exactly-once limits

All effect-capable tool paths normalize to this pipeline:

```text
complete call
→ schema/aggregate-bound validation
→ canonical resource resolution
→ hard budget reservation
→ Guard ALLOW or durable approval resolution
→ EffectIntent PREPARED committed
→ one-use capability lease issued
→ ExecutionHost prepare
→ dispatch/launch observation
→ bounded result/receipt capture
→ target-specific settlement or UNKNOWN
→ linked audit receipt
→ ordered model-visible result
```

No mutation, shell, connector write, MCP invocation, external-agent launch, git
integration or plugin action with effects skips `PREPARED`. A pure read still requires
an owner-scoped authorization and bounded result but need not create a mutation
intent unless policy classifies its data access as auditable. **Mutation-class** calls
require the provider tool response (or managed wave) to be structurally complete and
batch-admitted before dispatch begins. **Read-class** calls in **direct** Sessions may
start earlier under §14.3.1 (`DEC-V1-36`). If any admitted call is structurally invalid
or the aggregate exceeds bounds, reject the batch and dispatch zero **not-yet-started**
calls from that batch; already-settled read results remain valid inputs. After batch
admission, independent calls may
run in parallel only when the resource conflict graph permits; overlapping writes
serialize; shell over a writable workspace is exclusive unless a stronger contract
proves otherwise. `question` and approval are barriers: dependent later operations
cannot race ahead.

Whole-batch validation is atomic only with respect to **starting dispatch**. It does not make dispatched filesystem, process, connector, or external operations a transaction. After dispatch starts, preserve a distinct observation/receipt or UNKNOWN state per effect. On member failure, do not dispatch its not-yet-dispatched dependents; independent admitted members may continue only under the existing conflict/resource policy. On cancellation, stop all not-yet-dispatched members and request cancellation of running members through their ordinary owner. Settle or reconcile every dispatched member independently. Do not claim rollback of completed external effects. A compensating action is a new Guarded effect; UNKNOWN is not absence and cannot be blindly replayed.

Use `managed_run` for RunController-owned integration effects (including Run-level
work without a Worker Attempt); include `taskId` only when the effect is attributable
to a specific Task. A user-started maintenance/update action uses `user_action`.
Autonomously initiated maintenance/update uses `system_operation` with a durable
operation ID and authenticated service principal. These origins provide attribution,
not authority: each effectful operation still reserves budget and passes the same Guard,
approval, PREPARED, lease, ExecutionHost and settlement path. Pure reads retain the
owner-scoped authorization and bounded-result rule above, creating an intent only when
policy classifies the access as auditable. Never fabricate an Attempt to represent Run
integration or maintenance work.

Managed verifier execution follows §12.19. The coding Attempt remains live until each verifier EffectIntent has its own exact Attempt edge, one-use lease, confined process receipt and current-revision evidence. A settled coding Attempt, reviewer challenge, Goal/Run identity or caller-supplied digest cannot authorize verifier dispatch. After possible launch, cancellation or lost observation is UNKNOWN and must be reconciled without replay.

For that lifecycle, the Attempt/delegation source revision is immutable admission provenance. HostKernel derives the current workspace revision from the ordered SUCCEEDED receipt chain and checks the live registered root against its head before each dispatch; the managed reducer independently checks each receipt's before/after link. Serialize mutating effects in the V1 Attempt. `expectedManagedRevision` fences the current aggregate OwnerLog snapshot and is distinct from an effect edge's `boundRevision`. A verifier's separate read-only intent and receipt bind the chain head with before equal to after. Any failure, UNKNOWN, missing or mismatched predecessor, cancellation, epoch change, or out-of-chain workspace edit fences subsequent effects; caller-supplied rebasing is never accepted.

Before approval, HostKernel may persist a challenge-bound candidate verifier intent containing the exact profile, executable selector, criterion, literal arguments and current workspace head for reviewer display; this candidate is not an Attempt OwnerLog mutation, lease or dispatch authority. After approval by the authenticated distinct reviewer, atomically persist the exact verifier Attempt edge and immutable intent without a lease digest, refresh the managed scope to the post-bind aggregate revision, revalidate approval and the live revision/workspace fence, and only then issue the one-use Guard lease. Do not append the lease digest to the managed log before dispatch; retain it in EffectHost's durable one-use state and the HostKernel-authenticated settled receipt. Approval-pending revision/workspace changes invalidate the lease path. The authenticated distinct reviewer approves; the trusted verifier profile principal owns the supervised process.

Keep these identities as separate fields across the complete supervised-process lifecycle. The authenticated reviewer remains the Guard challenge/approval principal; the trusted verifier profile principal is the process execution principal. Both are pinned in the opaque HostKernel invocation and dispatch digest, the durable EffectHost binding, Linux containment identity/quiescence proof, and settled receipt. A reviewer identity cannot substitute for the process principal, and a process-profile identity cannot approve its own challenge. Existing non-verifier launches bind their execution principal to the authenticated process owner.

**Attempt-bound model ToolBatch ordering:** Apply the same post-bind rule to managed and direct child effects. `prepare_tool_batch` must finish complete-batch validation and Guard evaluation, but must not issue a one-use lease from the pre-bind Attempt scope. After any required explicit approval, HostKernel atomically binds the complete exact effect-ID/intent set to the live Attempt, returns the authenticated refreshed scope at the resulting OwnerLog revision, rechecks that revision plus the exact edges, workspace head, owner epoch, policy and approval, then issues each one-use lease against the refreshed scope and its exact edge/intent. The initial challenge scope is evaluation provenance only; its binding may transition once to the refreshed scope only while no lease has been issued and only for the exact atomic edge transition. An ALLOW route must defer its lease exactly like an ASK route until binding completes. Any concurrent owner/workspace change, missing edge, replay, cancellation or stale approval rejects and requires reconciliation/new authorization. Never mutate an issued lease, accept a caller-rebased scope, or let a pre-bind lease digest authorize post-bind execution. A crash after possible dispatch remains UNKNOWN/no replay. This closes the `expectedManagedRevision` self-invalidation caused by binding the effect itself while retaining the aggregate revision fence.

For an Attempt-bound batch, approval and binding cover the complete exact set before its first dispatch, but leases are issued and consumed serially just in time. After each effect settles, HostKernel observes and persists its exact receipt; a successful workspace mutation advances the ordered chain head and returns a correlated refreshed scope before the next effect is leased. A failed, UNKNOWN, missing or mismatched receipt fences every remaining member. This preserves atomic admission without treating external effects as a rollback transaction or pre-issuing stale leases against a workspace head that a prior member may change.

### 14.3.1 Direct-mode read fast path and batched Guard RPC (`DEC-V1-36`)

**Goal:** HorizonCode must not feel slower than OpenCode, Cursor CLI, Claude Code, or Codex on
read-heavy turns while preserving Guard for every capability class.

**Read-class** capabilities (registry `effectClass: read` or equivalent policy map:
`files.read`, bounded `text.search`, read-only `git.*`, `repo.*` query paths, `artifacts`
range/search, read-only LSP queries, and other explicitly enumerated read leaves) in an
authenticated **direct** Session may dispatch when:

1. the call passes schema and registry pin validation for the **current** request;
2. path/network targets resolve under current scope;
3. an active **DirectSessionGrant** or default in-sandbox read policy covers the operation, or
   Guard returns ALLOW without ASK; and
4. the call is **not** classified mutation, `terminal.*`, MCP connector write, provider-hosted
   opaque effect, or `question.ask`.

Reads may start **while the provider response is still streaming** additional tool calls.
Each read still records scope, digest, and bounded result; optional single **read-batch lease**
covers up to **8** read calls per provider tool response with **one** `prepare_tool_batch_read`
kernel RPC (implementation coalescing), instead of one RPC per read. **Core caller seam (CODE_PRESENT, not WIRED):** `packages/core/src/session/direct-read-batch.ts`; kernel handler in `host_kernel.rs`; runner routing in `packages/core/src/session/runner/llm.ts`. Acceptance: §32.49 `PERF-DIRECT-002/004`, wire tracker W-P1-07.

**Mutation-class** tools (`files.write`, `files.patch`, `terminal.run`, effectful `git.*`, MCP
mutations, etc.) remain gated on **closed** structural batch validation and full §14.3 admission.
A mutation never executes before its call object is final in the batch. Dependent ordering
(read → write → test) is preserved by the batch dependency graph.

**Kernel session warmth:** from host READY or first direct Session open, Core keeps a
**pooled authenticated IPC session** to `hz-kernel` for the process lifetime. Provider-only
turns (no local tools) never wait on kernel handshake. Effect RPC queue is per-Session;
approval challenges are prioritized over background reads.

**Managed lane:** read fast path is **optional** and **off by default** for Attempt-bound
waves; managed coding Attempts keep serialized mutation chains per §14.3.

**UX law:** default install preset **Coding (recommended)** (§16.19.1) minimizes approval
prompts for in-grant workspace work so migration from competitor agents does not regress to
“always ask.”

**Measurement (reference WSL2, warm kernel, local IPC):** architecture targets, not marketing
guarantees until §32.49 passes:

| Path | p95 target (Guard + lease issue, before worker work) |
|---|---|
| In-grant read, batched ≤8 | ≤25 ms |
| In-grant read, single | ≤15 ms |
| In-grant workspace write after grant | ≤40 ms before ExecutionHost |
| ASK challenge (user idle) | unbounded user time; UI must show ≤150 ms challenge render |

Terminal effects belong to one separate host singleton, launched as
`hz-kernel --state-dir=<state-dir> --socket=<socket> --host-exe=<host-exe> --nonce=<nonce> --incarnation=<incarnation>`.
The authenticated HelloResult returns a durable, monotonically increasing positive
`ownerEpoch`; Core `session_supervisor` receives it and remains projection/ACK-only.
There is no host-wide single `workspace-root`. Register trusted Locations internally
through `effects.v2/register_location {canonicalRoot,workspaceID?}`, where the root
comes only from a trusted `Location.Ref`; the kernel canonicalizes it, returns an
opaque stable BLAKE3 `locationID`, and rejects rebind. No request or model supplies a
root path. User-originated `terminal.start`/`terminal.run` use the distinct
`effects.v2/prepare_user_effect {locationID,sessionID?,userActionID,capabilityID,arguments}`:
the adapter generates `userActionID`; a trusted `TrustedPrincipalContext` is injected
only by validated ServerAuth middleware or as a host-OS marker. It crosses authenticated
IPC as a delegated subject; Rust always derives UID/SID independently and binds the
ServerAuth subject when present. An absent session stays absent rather than fabricated.
ExecutionHost and settlement rules apply.

Terminal output EventV2 cursors use `ownerKind:"terminal"` and `ownerId:terminalID`.
Sequence `"0"` is the base sentinel
`blake3:0000000000000000000000000000000000000000000000000000000000000000`; each
event increments decimal sequence. `eventDigest` is `blake3:` plus lowercase BLAKE3
hex of the canonical MessagePack map
`{terminalID,generation,sequence,byteCursor,kind,payload}` with sorted map keys.
Exclude `subscriptionId`, so replay to another subscriber retains the same digest;
cursor sequence equals the event payload sequence.

Interactive PTY input and resize are the narrow exception to one-shot effect
settlement: after the single `terminal.start` PREPARED intent and admitted launch,
each sequenced input/resize message is an authorized continuation of that same
running effect under its InteractiveTerminalGrantV1, not a new launch or a new
per-keystroke EffectIntent. The kernel rechecks current Guard policy, principal,
terminal/config binding, grant expiry/revocation, owner epoch, fence, generation and
attachment sequence on every message; it records a bounded payload digest and
settlement checkpoint, never raw input. Duplicate sequence numbers are acknowledged
without redispatch; gaps and stale sequences are rejected. Owner-only cancellation
uses the scoped ExecutionHost signal/terminate lane and control receipt, fences
before termination, and settles the parent only when termination is observed.
Uncertain launch/termination remains UNKNOWN; an uncertain input is never replayed
after owner-epoch loss. This continuation lane does not exempt `terminal.start` or
`terminal.run` from PREPARED, one-use lease, ExecutionHost, receipt and settlement,
and does not change the one-shot rule for any other effect.

The capability lease is unforgeable within the trust model, short-lived, single-use,
and binds EffectId, principal, action/argument/resource/policy digests, workspace
fence, budget reservation, backend, executable/plugin generation and expiry. The
executor rechecks the lease and current fence immediately before the operation. It
does not accept a host/plugin-provided “authorized” boolean.

Exactly-once external execution is not generally promised. If a target lacks an
idempotency key and the process can crash after dispatch, state becomes `UNKNOWN`;
conflicting operations remain blocked until the owner-specific reconciler proves
present/absent. No user acknowledgement converts uncertainty to absence, authorizes
replay, or satisfies Run completion; independent work may proceed only when policy and
resource analysis prove it does not depend on or conflict with the unknown effect. A
retry after proven absence creates a new EffectId linked to the old one. Tool return success is not
effect settlement; process exit code alone cannot prove an external mutation's
final state.

Effect settlement is owned by EffectService. AuditService records linked security
decisions, receipts and reconciliation facts; it does not mirror all Thread/Run
events. An audit append failure after an external operation cannot erase that
operation. The result is an explicit security-health blocker and is reconciled before
Run completion according to policy.

## 14.4 Rust ExecutionHost module interface

`ExecutionHost` is a Rust module inside the supervised `hz-kernel` process. It is not
the Bun/TypeScript `horizoncode` application host and is not a separate process. The
kernel-side module owns the single local operation/process execution seam and invokes
the selected OS sandbox or subprocess backend. `horizoncode` performs provider streaming
and collects complete tool batches only; it never executes effect-capable operations
or starts their child processes. Tool handlers, plugin code and controllers may request
an execution through the kernel-owned flow but cannot create an untracked process
manager or bypass Guard, EffectService, or the capability lease.

**Source-backed progress, 2026-10-10:** `packages/core/src/session/runner/llm.ts` now
buffers local calls until the provider stream has a terminal `finish` and a completed
`step-finish`; a provider error, transport failure, interruption, missing terminal, or
invalid local-call schema produces zero local dispatches for that batch. Tests cover
provider failure after a call, clean EOF without finish, finish without step settlement,
schema rejection of one call withholding valid siblings, and concurrent dispatch after a
valid complete batch. This is the **2026-10-10 historical implementation checkpoint**, not the current state. As of the 2026-10-14 reviewed commit, `packages/opencode/src/session/tool-batch.ts` does bounded complete-batch admission and `kernel/src/{guard,effect_host}.rs` provides a real Rust-backed `files.write` challenge, durable preparation and receipt path through `packages/core/src/session/supervisor.ts`. That narrow path does **not** mean universal effects are mediated: `terminal.run`, subprocess/subagent, plugins/MCP/hooks, hosted-provider tools and other mutation origins still require end-to-end pre-dispatch proof. See current HANDOFF.md; do not turn the historical note into a blanket runtime denial or release claim.

```rust
trait ExecutionHost {
    async fn prepare(&self, request: PrepareExecutionV1) -> Result<PreparedExecutionV1, TypedErrorV1>;
    async fn launch(&self, prepared: PreparedExecutionV1, lease: CapabilityLeaseV1) -> Result<LaunchObservationV1, TypedErrorV1>;
    async fn observe(&self, execution_id: ExecutionId) -> Result<ExecutionObservationV1, TypedErrorV1>;
    async fn signal(&self, execution_id: ExecutionId, signal: ProcessSignalV1) -> Result<SignalObservationV1, TypedErrorV1>;
    async fn terminate(&self, execution_id: ExecutionId) -> Result<TerminationObservationV1, TypedErrorV1>;
    async fn reconcile(&self, execution_id: ExecutionId) -> Result<ReconciliationObservationV1, TypedErrorV1>;
}
```

The trait uses these bounded logical request/receipt contracts (transport serialization
is owned by §13 and the shared primitives by §12):

```ts
type ExecutionLimitsV1 = {
  wallTimeMs: number; cpuTimeMs?: number; memoryBytes?: UInt64Decimal
  processCount: number; stdoutBytes: UInt64Decimal; stderrBytes: UInt64Decimal
}
type ExecutionEnvironmentEntryV1 = {
  name: string
  value: { kind: "public_literal"; value: string } | { kind: "secret_lease"; leaseId: SecretUseLeaseId }
}
type PrepareExecutionV1 = {
  executionId: ExecutionId; workerExecutionId?: WorkerExecutionId; effectId: EffectId
  capabilityLeaseDigest: Digest // kernel-issued lease already bound to this EffectId
  adapterId: string; adapterVersion: string
  executable: { identity: string; digest: Digest; resolvedPathRef: RootRef }
  argv: string[]; cwd: RootRef; environment: ExecutionEnvironmentEntryV1[]
  stdin?: ArtifactRef
  workspaceBinding?: WorkspaceBindingRef; expectedRevision?: RevisionSetV1
  confinementProfile: string; requestedGuarantees: GuaranteeRequirement[]
  inheritedHandleRefs: string[]; limits: ExecutionLimitsV1
  deadline: Timestamp; outputPolicyDigest: Digest
}
type PreparedExecutionV1 = {
  executionId: ExecutionId; workerExecutionId?: WorkerExecutionId; effectId: EffectId; requestDigest: Digest
  executableDigest: Digest; resolvedResourceDigest: Digest
  environmentDigest: Digest; selectedBackend: string
  guaranteeAssessments: GuaranteeAssessment[]; effectiveLimits: ExecutionLimitsV1
  capabilityLeaseDigest: Digest; workspaceFenceEpoch?: UInt64Decimal
  expiresAt: Timestamp; receiptDigest: Digest
}
type ProcessIdentityV1 = {
  pid?: string; processStartIdentity?: string; jobOrContainerId?: string
  launchNonce: string; executableDigest: Digest
}
type LaunchObservationV1 = {
  executionId: ExecutionId; workerExecutionId?: WorkerExecutionId; launchId: LaunchId
  status: "STARTED" | "ALREADY_STARTED" | "REFUSED" | "UNKNOWN"
  processIdentity?: ProcessIdentityV1; observedAt: Timestamp
  receipt?: ArtifactRef; error?: TypedErrorV1
}
type ExecutionObservationV1 = {
  executionId: ExecutionId; workerExecutionId?: WorkerExecutionId
  status: "RUNNING" | "EXITED" | "TERMINATED" | "UNKNOWN"
  exitCode?: number; stdoutRef?: ArtifactRef; stderrRef?: ArtifactRef
  stdoutBytesObserved: UInt64Decimal; stderrBytesObserved: UInt64Decimal
  stdoutTruncated: boolean; stderrTruncated: boolean
  processIdentity?: ProcessIdentityV1; observedAt: Timestamp
}
type ProcessSignalV1 = "INTERRUPT" | "TERMINATE" | "KILL"
type SignalObservationV1 = { executionId: ExecutionId; workerExecutionId?: WorkerExecutionId; signal: ProcessSignalV1; accepted: boolean; observedAt: Timestamp; residuals: string[] }
type TerminationObservationV1 = { executionId: ExecutionId; workerExecutionId?: WorkerExecutionId; status: "TERMINATED" | "STILL_RUNNING" | "UNKNOWN"; observedAt: Timestamp; receipt?: ArtifactRef }
type ReconciliationObservationV1 = { executionId: ExecutionId; workerExecutionId?: WorkerExecutionId; result: "PRESENT" | "ABSENT" | "UNKNOWN"; evidenceRefs: ArtifactRef[]; observedAt: Timestamp }
type GuaranteeRequirement = { dimension: GuaranteeAssessment["dimension"]; minimum: GuaranteeLevel }
```

All returned observations are authenticated to the supervisor incarnation and launch
nonce. `PRESENT`/`ABSENT` applies only to the process/launch identity; external target
effects require their own target-specific reconciler. Unknown fields are rejected by
the private protocol version. ExecutionHost errors use `TypedErrorV1`; they never embed
raw secret values or unbounded process output.

`PrepareExecutionV1` contains:

```text
execution_id, effect_id, adapter_id/version, executable identity/digest,
argv as an array (never shell-concatenated), canonical cwd/root handles,
environment allowlist and redaction class, stdin artifact/pipe contract,
workspace/repository binding, fence epoch, expected revisions,
filesystem/network/process/resource profile, inherited-handle allowlist,
wall/CPU/memory/process-count/output-byte limits, deadline,
stdout/stderr collection policy and capability requirements.
```

The host returns a `PreparedExecutionV1` receipt with the normalized executable,
resolved handles/resources, selected backend/guarantees/residuals, effective limits,
environment digest (not secret values), policy and lease binding, and an expiry. The
kernel commits this receipt before launch.
CPU, memory, process-count and FD values are requirements, not guarantees: if a request
requires one of those dimensions and the selected OS backend does not report it enforced,
preparation denies before launch. Admission, deadlines, output caps and sampling do not
substitute for those OS guarantees.
Preparation resolves the exact issued lease through EffectService using EffectId and
the request's capabilityLeaseDigest; it validates current policy, expiry, principal,
resources and limits without consuming the one-use launch allowance. It cannot create
or widen a lease. Launch requires the same digest as the prepared receipt and rechecks
current authorization, fence and expiry before atomically claiming the one-use lease;
a changed or revoked binding requires fresh guarded preparation, never substitution.
Every local operation uses an `ExecutionId`; a managed worker additionally binds
`WorkerExecutionId + incarnation + outbox_id`.
Duplicate RPC delivery for the same stable identity returns the existing launch result
or `UNKNOWN_WORKER_LAUNCH`, never a second process. Receipts
identify OS PID plus process start identity, job/container/sandbox ID when available,
and nonce. PID alone is not stable identity.

Output is streamed to bounded buffers/artifacts with independent stdout/stderr
limits and truncation markers. No unbounded in-memory capture; output beyond the
limit is dropped after recording bytes observed and a truncation event.

The execution deadline covers spawn, bounded stdin delivery and output draining, not
only child wait. Stdin writes must be interruptible/deadline-covered; on timeout stop
delivery and reconcile the process. Reader completion has a bounded post-exit drain
deadline even when descendants retain pipe handles; truncation/drain timeout is explicit
and never falsely reported as complete output. Process-tree cleanup and known effect
settlement remain separate from reader completion. Backend acceptance includes a
non-reading child and a surviving descendant holding stdout/stderr open.
Environment is cleared and rebuilt from an explicit allowlist; inherited handles, working
directory and executable resolution are explicit. Process tree containment and
resource caps are backend capabilities, not inferred from using a child process.

Cancellation/control uses a priority lane. A stop/cancel request first commits the
correct scope fence, blocks new dispatch, then signals the specific execution and
observes cleanup. Unsupported peer cancellation is reported; only an owned wrapper
process may be terminated. If process/effect state remains uncertain, the
WorkerExecution/Attempt/Run remains `UNKNOWN`, `CANCELLING` or `RECOVERING`, not
`CANCELLED`.

## 14.5 Sandbox profile vector and platform contract

Do not collapse filesystem, network, process-tree, resource and secret guarantees
into one “sandboxed” boolean. Every prepared execution exposes a vector:

```ts
type GuaranteeAssessment = {
  dimension: "filesystem_read" | "filesystem_write" | "network_egress" | "process_tree" | "resource_limits" | "credentials" | "workspace_fence"
  level: GuaranteeLevel
  backend: string
  evidenceRef?: ArtifactRef
  residuals: string[]
}
```

`GuaranteeLevel` is the shared schema primitive in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md#121-shared-primitives).

Profiles are requests, not claims:

| Profile | Requested scope | Default posture |
|---|---|---|
| `readonly` | Reads limited to declared roots; no workspace write; no network unless separately granted | Preferred for verifier and planner |
| `workspace-write` | Reads declared roots; writes only within fenced workspace and bounded temp/state roots; network denied by default | Native implementation default |
| `networked-workspace-write` | Workspace-write plus explicit egress destinations/protocols | Separate Guard decision; no implicit broad Internet |
| `full-access` | Host profile with no OS filesystem containment | Explicit high-risk opt-in; still Guard/audit/budgeted; never described as confined |

**Amended by A-V2-31 (2026-10-16): V1 releases on the Linux/WSL-first CLI/TUI; native Windows stays unavailable until native acceptance — the Windows-first text below governs the eventual Windows release target, not V1 scope.**

**V1 platform scope (A-V2-31):** ship Linux/WSL-first CLI/TUI. The current sandbox
crate is Linux-only; native Windows and macOS confined profiles return typed
`Unsupported` and remain unavailable until native acceptance. The former Windows-first
requirement below is superseded for V1. WSL uses the Linux backend and masks Windows
interop; that is not native Windows acceptance.

**Source-backed implementation state (2026-10-19):** `kernel/Cargo.toml` depends on
`horizoncode-sandbox`. `kernel/src/terminal_process.rs` probes the backend, checks the
required filesystem-read/write, network-egress and process-tree guarantees, prepares
both non-PTY stdio and external bubblewrap terminal launches, and dispatches only a
prepared launch. `kernel/src/host_kernel.rs` invokes the preflight before exposing the
guarded process surface. This closes the previous statement that the crate was absent
and establishes source wiring for these HostKernel terminal/process routes; it is not
final-revision containment acceptance for every effect origin.

The backend's enforced Linux default is bubblewrap with fresh namespaces, scoped mount
roots, protected subpaths, deny masks, private `/tmp`, and network namespace isolation.
The explicitly requested Landlock-write-scope backend has weaker residuals and cannot
satisfy an enforced read/process-tree guarantee. Its network API supports deny-default
or host sharing; it does not enforce a destination allowlist. Therefore
`networked-workspace-write` requires a separately Guarded, destination-scoped egress
proxy/service and must remain unavailable when that path cannot prove the requested
egress guarantee. Do not interpret host-network sharing as confined egress.

The backend reports each dimension and refuses when the requested `GuaranteeRequirement`
is unmet. `capability_limited` is not equivalent to `enforced`; `best_effort` must name
its mechanism and residual. The current `horizoncode-sandbox` helper owns confinement
setup only; ExecutionHost still owns bounded output/truncation receipts, end-to-end
deadlines, process-tree lifecycle, leases, receipts and UNKNOWN recovery. Source wiring
must not be promoted to `VERIFIED` until the per-kernel containment matrix (`DEC-V1-03`)
and every enabled-origin denial/recovery case pass on the integrated revision. Keep
unsupported origins unavailable until then.

**Resource-limit source status (2026-10-19):** `horizoncode-sandbox` explicitly reports
`ResourceLimits` as `unsupported`; its cgroup namespace does not impose CPU, memory or FD
quotas. Current terminal and stdio preflights require enforced filesystem read/write,
network-egress denial and process-tree dimensions, but do not request OS-enforced
`ResourceLimits`. Wall-time/output bounds and Rust resource reservations/observations are
not equivalent to OS CPU/memory/process-count enforcement. Guarantees requiring OS-enforced
CPU, memory, process-count or FD limits remain unavailable until the selected platform
backend enforces and reports them. Where a profile does not require those dimensions,
bounded admission and monitoring may be used only for the dimensions they actually constrain
or observe; they must not be described as hard OS quotas or used to satisfy a
`resource_limits` requirement. A worker profile that requires `resource_limits` fails closed
before launch until OS acceptance proves enforcement.

For Linux process-tree restart proof, the one existing `StdioExecutionSupervisor` may use an
optional delegated cgroup-v2 child as a containment identity. Create it under a no-follow
pinned directory handle, bind it to boot ID plus the exact HostProcessRef generation, kind,
profile revision/digests, Effect, lease, owner epoch and optional authenticated Attempt scope
digest (nil only where the owning capability contract has no Attempt scope), then persist
that complete identity in EffectHost's PREPARED transaction before the launcher writes its
PID to `cgroup.procs` in `pre_exec`. Failed or unavailable delegation means no dispatch.
Cancellation/restart may prove
only quiescence after revalidating the pinned mount/delegated/cgroup identity, issuing
`cgroup.kill`, and observing `populated=0`; persist that proof, but keep the effect UNKNOWN unless
its exact terminal receipt is independently durable. Do not infer CPU, memory, process-count or
FD limits from cgroup membership. Native Windows and unsupported Linux cgroup setups remain
unavailable.

## 14.6 Network, MCP and provider-hosted tools

All app-mediated outbound requests have a typed destination policy. Validate scheme,
host, port, DNS-resolved address ranges, redirects and the address actually connected
to; revalidate on redirect and connection changes. Reject loopback, link-local,
private, metadata and other prohibited ranges unless an explicit connector policy
allows the exact target. Do not resolve hostnames for check-only and then let a
different client resolve again without binding the result. Provider catalog endpoints
are data, not authority. Request bodies and redirect behavior must not leak
credentials cross-origin. No egress guarantee is claimed unless enforced by the
selected backend.

MCP integration lifecycle is: staged server config → authenticated protocol
initialization/version-capability negotiation → bounded tool/resource/prompt list
→ normalized pinned tool definitions → explicit profile/toolset selection → Guard
and EffectIntent for each invocation → bounded result capture. Tool-list changes
create a new toolset generation and apply only at the next safe provider-turn
boundary. Mid-turn loss returns a typed failure/UNKNOWN for the current invocation;
it does not bind the same tool name to another server. Credentials are selected
explicitly from SecretBroker and scoped to a server/operation. Never auto-forward
provider credentials, kernel credentials or all environment secrets to an MCP
server. Remote MCP uses the protocol's authenticated transport and origin policy;
stdio child uses ExecutionHost.

Provider-executed tools (hosted browser/search/code/file tools) cannot pass through
Guard if execution occurs inside the provider. Governed v1 excludes them unless the
provider's protocol supports a pre-execution approval handshake that the kernel can
enforce and verify. The model may receive a clear `CAPABILITY_UNAVAILABLE` or a
mediated local alternative; it must not be shown an unmediated hosted tool as if
Guard-protected.

## 14.7 SecretBroker contract

Configuration stores secret references, never raw credentials. SecretBroker owns
secret metadata, OS credential-store integration, rotation and access audit. Its
logical interface is:

```rust
trait SecretBroker {
    async fn put(&self, request: SecretPutRequestV1) -> Result<SecretRef, TypedErrorV1>;
    async fn describe(&self, reference: SecretRef) -> Result<SecretMetadataV1, TypedErrorV1>;
    async fn authorize_use(&self, request: SecretUseRequestV1) -> Result<SecretUseLeaseV1, TypedErrorV1>;
    async fn revoke(&self, reference: SecretRef) -> Result<SecretRevocationReceiptV1, TypedErrorV1>;
}
```

Canonical non-secret request and receipt records are `SecretMetadataV1`,
`SecretPutRequestV1`, `SecretUseRequestV1`, `SecretUseLeaseV1` and
`SecretRevocationReceiptV1` in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md#1217-secretbroker-credential-records).

`ISSUED → CONSUMED` is committed by SecretBroker before a single authorized request;
expiry or secret rotation/revocation moves an unused lease to `EXPIRED`/`REVOKED`.
Consumed leases are not reusable; a provider retry requires a new authorized lease.

`secureInputHandle` is a one-time reference to a protected native input channel, not
credential content; it is scoped to this put operation and is never logged or reused.
Raw credential values are deliberately absent from these wire schemas. DEC-V1-06 was
resolved on 2026-10-19: select a one-request, in-process, first-party ProviderTransport
boundary using HorizonCode's existing `packages/opencode/src/auth/provider-transport.ts`
adapter. The SecretBroker lease binds secret
version, requester, provider, operation digest, destination, purpose, expiry and
single-request limit. The transport alone receives the minimum credential bytes
immediately before that request and zeroes its buffer afterward. Raw bytes never pass
through config, general/plugin/kernel RPC, environment, child processes, tools,
diagnostics, events or artifacts. This architecture decision is not implementation
evidence: credentialed routes remain unavailable until durable OS storage, lease
consumption/revocation checks, zeroization and no-leak transport tests pass.
For V1 requester and AgentProfile reference derivation, see the canonical SecretBroker
binding in §12.17; HostKernel-authenticated identity and pinned AgentProfileV2 facts are
required, and missing profile authority denies BYO use.

Secret use binds the secret version, requesting service/process identity, provider or
MCP server, route/operation digest, destination, Run/profile if any, purpose, expiry
and single-use/request limit. The broker rechecks the current secret version and
lease state immediately before use; rotation/revocation makes older unconsumed leases
fail closed. The candidate path, if DEC-V1-06 selects byte delivery, is
an in-process trusted ProviderTransport request bound to the authorized route; the current
implementation is `packages/llm`, and a future A-V2-27 transport must satisfy the same boundary.
Only the minimum credential bytes are delivered in memory for that request. The HorizonCode host is therefore
explicitly credential-bearing. A trusted first-party host adapter may access the
per-request value; arbitrary extensions, skills, tools, provider plugins and child
processes may not. If a feature technically requires child delivery, the approval UI
names the recipient, scope, expiry and residual `credential visible to child`.

Never place credentials in prompts, tool results, environment dumps, command lines,
diagnostics, event payloads, artifacts, config files or error strings. Redaction is
best effort and is not treated as a perfect secret detector. Secret reference IDs
and use metadata may be persisted; secret bytes are not in the event log or artifact
store. Auth failure returns `NEEDS_AUTH`; no indefinite retry loop.
Credential expiry interrupts the current provider/tool call with a typed outcome; it
does not silently select another secret, server, route or auth method. Any retry waits
for an explicit brokered reauthorization and a fresh Guard/budget check where the
operation has effects. The transcript carries only the typed auth status, never the
credential value.

## 14.8 Extension execution and supply-chain trust

| Kind | v1 execution | Allowed authority |
|---|---|---|
| Sealed first-party service | Product host/kernel build | Only named owner operations; composition locked |
| First-party provider/feature plugin | Trusted host only if shipped as product code and capability-reviewed | Scoped declared service interface; no raw kernel store |
| Presentation plugin | UI/declarative renderer or isolated UI process | Query/render and foreground action tokens; cannot set canonical state or steal focus in background |
| WASM extension | A separately selected runtime with explicit imports and fuel/memory/time limits | Imported capabilities only; unavailable until runtime containment has acceptance evidence |
| External-process plugin | ExecutionHost child + typed RPC | Short capability lease; no kernel DB/state root or ambient secrets |
| OpenCode legacy server plugin | Isolated compatibility worker | Explicitly mapped supported hooks; unsupported hook returns `COMPATIBILITY_UNSUPPORTED` |
| MCP server | Separate protocol principal | Selected server tools only through Guard/Effect pipeline |
| Skill | Inert content/resources until invoked | Context hint only; text cannot authorize tools |
| Workflow | Versioned declarative task graph template | Compiles to ordinary Goal/Spec/Run/Task; no second executor |
| External coding agent | Native/ACP/CLI adapter with Attempt scope | TaskPackage, bounded workspace and effective authority ceiling; internals may be opaque |

Plugin install is not activation. Stage exact bytes, validate manifest/schema,
publisher/provenance, digest, requested capabilities, compatibility and license
metadata, then show the review surface; probe with no production authority; enable and
activate only after explicit scope choice. No downloaded JavaScript receives
unrestricted Bun APIs. First-party signature/trust root, marketplace source and
emergency revocation mechanism are release-governance decisions recorded in
[`17-GOVERNANCE-DECISIONS.md`](17-GOVERNANCE-DECISIONS.md); until settled, third-party executable install is unavailable,
not “trusted by default.”

OpenCode hook adaptation is explicit: typed config proposal instead of in-place
mutation; read-only event subscription; tool definition normalized then routed through
Guard; no post-authorization argument rewrite; no arbitrary shell environment or
prompt mutation; no direct state/database access; no navigation without a foreground
user-action token. Unsupported legacy behavior fails with a typed compatibility
error rather than bypassing the kernel.

All executable hooks use the one `HookContributionV1` registry resolved by the pinned
CompositionGeneration; profile lifecycle bindings are references into that registry,
never inline executable authority. A hook runs
with the intersection of its declared capabilities, the profile ceiling, parent/Task
authority and current Guard policy. Hooks cannot widen authority, mint capability
leases, approve Effects, rewrite tool arguments or invocation bindings, directly mutate
canonical owner state (including Task/Attempt/Run), or create accepted Evidence. Any effect-capable
request made by a hook follows the normal Guard → EffectIntent → capability lease →
ExecutionHost path.

`before_start`, `before_tool` and `before_finish` may return a bounded block decision
only where the registered hook contract and adapter can enforce it. A blocking
`before_finish` can prevent a candidate worker completion and return bounded feedback
to a mediated worker loop; it cannot certify Task PASS. Post-event hooks (`after_start`,
`after_tool`, `tool_failure`, `after_finish`, `on_failure`, and `on_idle`) are
observational with respect to lifecycle control: they cannot block, rewrite or certify
success. Any separately declared effect they request still follows the normal Guard
path above. Hook failure or unsupported required behavior remains explicit and is never
bypassed as if the hook had succeeded.

`before_compaction` may block only the proposed derived compaction; it cannot delete or
rewrite Thread history. `after_compaction` is observational and cannot change the
committed result. A blocking hook timeout, malformed response or execution failure is
fail-closed for the affected operation; an optional observational hook may be disabled
only with an explicit diagnostic and pinned unavailable status. Required hooks never
degrade to warning-only behavior. A hook's declared capability request is not a grant:
every effect still receives a fresh Guard decision, EffectIntent, lease and executor
mediation under the active policy.

For a required pre-event hook, failure prevents the not-yet-committed operation. A
required post-event hook failure is surfaced as a typed hook failure and stops dependent
work where possible, but cannot roll back an already-settled Effect or committed owner
transition. The owning lifecycle result remains truthful; the failed hook is never
reported as having succeeded.
Hook reason/feedback artifacts are bounded untrusted data; they cannot be inserted as
system authority, rewrite user/model input or change validated tool arguments.

## 14.9 Audit, privacy, retention and deletion

Each audit record names actor, action, allow/ask/deny/settlement decision, exact
subject/resource/policy digests, linked EffectId/approval/evidence refs, predecessor
digest and integrity receipt. Audit history is distinct from the operational event
streams and has a documented storage-failure posture. Security diagnostics default to
metadata and redacted snippets; they do not print full prompts, response bodies,
secret values or arbitrary process output.

Retention is explicit by data class: Thread messages, provider request metadata,
reasoning content, tool outputs, Run records, Evidence/ProofPacks, audit records,
artifacts, memory, repo indexes, plugin logs, diagnostics and update cache each have
owner, retention class, expiry/deletion operation and legal/forensic constraints.
No default numeric retention duration is asserted until privacy/product governance
sets it. User deletion removes/crypto-erases eligible content and rebuilds derived
projections, while retaining only legally/security-required integrity tombstones or
minimal audit metadata with stated reason. Deleting a projection does not erase its
canonical store; deleting canonical content requires an owner-mediated tombstone or
cryptographic-erasure workflow and must not make a false claim of physical removal
from backups.

## 14.10 Required security verification evidence

Before a capability is labeled available/enforced on a platform, acceptance records
must include the exact build/backend/OS version and test subject, plus:

- denied path/read/write outside grants, including parent traversal, symlink/reparse,
  replacement race and multi-repository boundary;
- process tree escape/child behavior, working-directory replacement, inherited
  handle/environment leakage, resource/output exhaustion and cancellation;
- network DNS rebinding, prohibited address classes, redirect/cross-origin credential
  leakage and network-disabled behavior;
- stale workspace fence rejection before any byte changes;
- approval digest/TOCTOU mutation, replay, double resolution and expiry;
- crash before/after PREPARED, after dispatch, after external mutation and before
  settlement, proving `UNKNOWN` and reconciliation behavior;
- plugin/MCP/agent attempts to access kernel state, unrelated secrets or undeclared
  capabilities; and
- secret redaction and artifact/log exclusion without claiming perfect detection.

Unit tests and mock backends establish code paths only. They do not establish OS
containment. V1 release acceptance is Linux/WSL-first. Native Windows and macOS guarantees
are reported separately and remain unavailable until their own OS acceptance passes; WSL
results do not count as native Windows evidence.

**2026-10-15 implemented narrow Guard hardening (not universal mediation):** The first-party Core `packages/core/src/tool/registry.ts` now withholds unclassified/unsupported effectful tools, refuses `files.write` settlement without a Rust challenge, and forbids `ApplicationTools` registrations from obtaining the built-in write authority merely by declaring `files.write`. The executable native write path is currently restricted to a Location-owned `write` registration; the canonical code-present Rust write leaf still redeems its challenge at the target. Tests in `packages/core/test/session-runner-tool-registry.test.ts` cover unsupported registration, unadmitted write and application spoof. A malicious same-process Location override can still execute JavaScript outside this model-facing registry, and read-only classification alone is not OS isolation. Do **not** claim arbitrary plugins, shell, MCP, hosted effects or all effect origins are universally mediated until P1.3 has end-to-end sandbox and no-bypass evidence.


## 14.15 2026-10-11 effect coverage for new capability families

The effect boundary applies uniformly to the expanded catalog (§33).

### Agent/profile/skill/hook effects

Creating or editing a profile/skill/hook definition is configuration persistence. Invoking
one does **not** grant its declared permissions. Script resources, hook shell handlers and
skill-provided commands become ordinary ToolIntents and require the same canonical resource
resolution, Guard decision, one-use lease and settlement.

### Browser/DOM effects

Browser navigation, click/type/select, downloads, file uploads, clipboard, permissions and
network requests are typed effect classes. DOM/page content is untrusted data. Browser handles
bind to one browser/session/snapshot generation; stale handles cannot execute silently.

### Local inference endpoint effects

Connecting to an endpoint is a network operation governed by the selected provider profile and
egress policy. A URL named “localhost” is resolved/validated at execution time; endpoint auth
uses SecretRefs. Offline mode denies unapproved remote egress from provider, web, MCP, plugins,
telemetry and embedding services.

### Automation effects

A schedule authorizes *when to request* an action, not the action's eventual authority.
AutomationRun invokes the same ActionDescriptor → Guard/Effect path as interactive use. Stored
approval cannot outlive its exact declared scope/revision/expiry.

### Artifact/render effects

Rendering an artifact is read-only only when the renderer is truly isolated from filesystem,
network and process side effects. Mermaid/PDF/image/conversion helpers that spawn processes or
read external resources run under ExecutionHost with explicit capability leases.

### RepoIntel effects

Reading/indexing source requires path read policy; filesystem watchers require watch
capability. Index writes target Horizon-owned cache storage and cannot alter source. LSP,
formatter or parser helper processes are ExecutionHost children and share process/resource
ownership rules.

### Context operations

Trim/prune/compact/clear mutate the **context view**, not canonical conversation history.
Explicit account/project data deletion is a separate high-impact operation with its own effect
class and confirmation semantics.

### Read-only/Plan is an effect policy

A profile's `read_only`/Plan input mode resolves to an immutable effect constraint enforced after
tool expansion and before ExecutionHost launch. The policy cannot be implemented only by denying
`file.write`.

Examples that are mutating unless proven otherwise:
- shell redirection, `sed -i`, formatter `--write`, notebook execution with file writes;
- Git commit/reset/checkout/merge/stash mutation;
- package install/update and generated lockfiles;
- database migrations/writes;
- service/process start when it changes project/runtime state;
- LSP workspace edits/code actions/executeCommand;
- MCP/plugin/skill aliases that ultimately perform any of the above.

For read-only mode, unknown/opaque effects deny or require an explicit permission-mode transition.
A tool description, model explanation or shell command name cannot classify itself as read-only.

### Language-service process boundary

Editor-owned Pyright/rust-analyzer/tsserver/etc. are **external observed resources**, not
ExecutionHost children. HorizonCode may query through an authenticated adapter but cannot kill,
restart, reconfigure or inherit secrets from them.

A Horizon-supervised language server:
- launches through ExecutionHost;
- receives only required workspace/read/env capabilities;
- runs under an OS-enforced filesystem profile: source/project content is read-only by default, and writable server caches are isolated to a separately scoped Horizon-owned cache location; no inherited credential, network, process, or arbitrary workspace-write authority;
- has bounded stdout/stderr/process lifetime;
- gets its own resource identity/generation;
- treats project-supplied binaries/config as untrusted executable inputs;
- routes any mutating workspace edit back through ordinary ToolIntent/Guard.

A language query result is data, not authority to apply the server's suggested code action.
Capability activation is not authorization: a query may request an LSP, but a supervised process start independently requires policy admission, Guard/ExecutionHost and a resource lease. If required filesystem/process/network confinement cannot be enforced on the current platform, report the affected service or action unavailable rather than running with ambient host access. A formatter/server that writes source or generated workspace files must use an explicit effect path; cache writes do not authorize source writes.

The optional LSP tool may return code-action and rename results only as bounded, versioned
text-edit proposals. It never executes `Command` values or applies `WorkspaceEdit`; accepted
text changes return through `files.patch` and its normal Guard/ExecutionHost path. A stale
document version or workspace preimage denies application.

**Launch-profile authority (2026-10-19):** Core Config remains the source of trusted launch
configuration and projects an immutable, authenticated profile to HostKernel. HostKernel
validates/resolves that profile and admits it through the existing single ExecutionHost
supervisor; this adds no second supervisor or independent mutable registry. A P4 caller may
identify a configured logical profile, but cannot choose executable path, argv, cwd, environment,
PID or process handle as authority. Built-in and explicitly user-owned config are eligible for
the V1 projection. Project/plugin/external launch config and binaries remain untrusted and
unavailable until trust resolution exists. Each admitted launch still requires Guard, a live
resource lease, the required OS confinement and a HostKernel-minted process reference; a missing
or stale profile proof denies before spawn.

### Structured-call safety

Malformed/truncated provider tool data never reaches Guard as a guessed valid intent.
Adapters may perform representation-only normalization when semantically lossless; semantic
repair produces a new proposal with a new identity. This prevents a weak/local model or gateway
from turning an unterminated path/command into an unintended effect.

## 14.16 Desktop, web search, DAP and REPL effect classification

DAP, bounded REPL and built-in web search are V1 capability families under A-V2-31 (web search per `DEC-V1-26`, 2026-10-18) and use the same Guard/ExecutionHost. Desktop control is post-V1 and unavailable; its classifications below are preserved for future promotion and must not be read as V1 exposure.

Desktop:
- display/window/screenshot/AX queries are scoped reads;
- pointer/keyboard/scroll/focus/clipboard writes are effects;
- references are invalid after observation-generation change;
- no unrestricted desktop Eval capability exists.

Web search (V1, `DEC-V1-26`):
- provider listing/status is read-only;
- network search is a network action governed by provider/privacy/cost policy;
- the effective route is the trusted ordered cascade; each route gets only its §37.5 bounded route-local retry, then policy advances to the next eligible route; after one cascade pass, exhaustion is surfaced with per-route reasons and no second full-cascade retry;
- explicit user/provider policy is required before fallback that changes billing or authentication class; enabling a route records that consent.

DAP:
- start/attach/process control, breakpoint mutation, continue/step/pause and evaluate are effects;
- stack/scopes/variables are scoped reads from a live adapter generation only when inspection is passive; property getters, lazy evaluation, formatters, or other target-code execution are effects or unavailable unless separately guarded;
- evaluate may be disabled entirely by policy and never grants ambient host shell authority.

Persistent REPL:
- start/reset/stop and code execution are controlled worker operations;
- the OS-enforced worker profile constrains filesystem/network/process/secret access; callback mediation alone is insufficient;
- callback tool invocations resolve to canonical capabilities and cross Guard;
- REPL state is bound to authenticated owner, workspace, sandbox generation and capability ceiling and never carries raw kernel/SecretBroker authority across sessions.
- callback events are read only through the bounded `ExecutionReplCallbackReadRequestV1` page for the exact interpreter HostProcessRef, owner epoch, Session, Location, workspace revision and Attempt scope. Each event pins a generation, monotonic event sequence, callback ID, canonical capability ID and bounded JSON arguments; stale generations, gaps or resnapshot requirements cannot be dispatched as callbacks.
- callback results use `ExecutionReplCallbackReplyRequestV1` and bind the exact event/callback, request sequence, action capability, EffectHost challenge/lease when granted, and durable action/Guard receipt. The callback's own tool action consumes its ordinary Guard lease; returning its result to the waiting interpreter consumes no second capability lease. A Guard denial uses a separate durable decision receipt binding the exact callback event and canonical arguments to the denied challenge, owner generation/scope and authenticated principals; that receipt establishes denial only and never claims execution or settlement. HostKernel validates either the settled action receipt or this denial decision receipt and stores a one-use reply ACK before acknowledging dispatch. `UNKNOWN` is never replied as success and quarantines the interpreter generation. No arbitrary method/callback name or caller-created event can enter this path.
- EffectHost durably stores each exact callback event and reply slot keyed by interpreter execution, generation and event sequence. It admits a reply only after validating the event, live interpreter binding and settled Guard receipt; it persists `DISPATCHING` before interpreter write and `DISPATCHED` only after an observed reply ACK. An ambiguous write, sequence gap, resnapshot or owner restart remains `UNKNOWN`; it cannot be replayed. Managed inbox consumption follows the same EffectHost durable-receipt boundary after HostKernel independently validates the immutable OwnerLog consumption proof and current authenticated consumer. Exact replay returns the original receipt; changed proof for the same child/message/sequence conflicts.
- callback event reads are capped at 16 events/256 KiB per page; callback arguments/results are capped at 64 KiB, 4096 nodes and depth 16. A lost ring segment requires an explicit resnapshot response with no events and an unchanged cursor. Event and reply DTOs do not enable interpreter execution; Guard, durable receipt/recovery and the required OS-enforced worker limits remain launch gates.

## 14.17 Shared kernel, headless pool and diagnostic effect classification (A-V2-30)

A shared Rust daemon is **not** approval to run all tools in-process. Every effectful origin still undergoes request-pinned ToolBatch collection and Guard, durable PREPARE, single-use resource/policy-bound lease, sandboxed ExecutionHost dispatch, observed result and receipt/UNKNOWN reconciliation. This applies equally to a headless specialist, warm pooled worker, imported Session adapter, file rename/rebase, Provider Doctor's full inference tests, process prewarm with external side effect, and any memory write or remote recall.

- Virtual Session attach/subscribe/resource snapshot/file-touch read: scoped queries requiring authenticated owner/workspace visibility and read budget, never actor authority. Provider Doctor `offline` must be strictly no-network/no-spend; `catalog` is bounded network/auth data access under policy; `full` incurs explicit provider/cost authorisation and records actual charges when known.
- Worker pool: reuse only for compatible, revoked/cleared secret state with identical trust/OS sandbox/resource scope; each new Attempt obtains a new fence/lease. PIDs are not identities; OS process start/lease fingerprint binds a worker. An unsupported confinement guarantee disables the origin in governed mode.
- File activity warnings are not enforcement. Before writes, resolve real destination (including symlink/reparse/race conditions), check exact expected digest, workspace lease, user edit and authorization generation. Do not advertise read overlap as a security deny.
- Cancellation: provider-stream abort does not prove a process was killed or an external effect did not happen. Propagate through child process groups/Job Objects with timeout and receipt reconciliation; preserve UNKNOWN and do not replay uncertain non-idempotent mutations.
- Daemon isolation tests: swap session/workspace/policy IDs, stale epoch, forged approval, oversized event, malicious MCP/tool stdout, crash during effect, cross-session observation, file reparse and secret exfiltration. Reject no-bypass claims until these tests and real-platform execution pass.

§05 states the threat boundary, §13 the virtual wire topology, §18 measured pressure rules, §32.32 test scenarios. No JCode shell/destructive-action heuristic replaces these controls.

## 14.18 External ACP agents, visual edits and deployment effects (post-V1 journeys)

External ACP client integration, browser-dependent visual edits and deployment journeys are outside the V1 CLI/TUI scope under A-V2-31 and remain unavailable. Existing §§3.16–3.18 and §§37.20–21 retain their future service/security boundaries; the classifications below are **required even while those features remain disabled**.

- **ACP outbound launch:** process/network EFFECT, not a harmless read. The worker executable/endpoint identity, current principal, initial cwd/repository root, credential scope, capability subset, model selection and budget are frozen before Guard. Even if ACP protocol reports a permission prompt, that is **not** Horizon's Rust Guard proof. An external remote agent whose side effects are opaque cannot be advertised as governed pre-dispatch under Horizon's lease system.
- **Native separate OpenCode backend:** always a separate explicit provider/session owner with truthful upstream security guarantees. Native OpenCode tool runs are not magically rewritten as Rust effects. If the selected native backend lacks an enforceable equivalent safety boundary, disclose and disable strict governed capability rather than claiming equivalence.
- **Visual selection:** read of DOM/AX/source-map may expose secret-bearing page data to a model or remote provider. Scope/redact before context, enforce browser generation and source digest; visual target and source mapping alone cannot authorize a filesystem write. Preview start/stop are process-control effects where applicable.
- **Deployment:** reading public target metadata is a bounded scoped read; accessing credentials, launching build/CLI processes, uploading artifacts, setting secrets, changing DNS/environment or rolling back remote state are Guarded EFFECT origins with explicit recipient/account/environment/network/cost/secret declarations. Capturing a remote result does not mean settlement or acceptance; target-specific idempotency, UNKNOWN reconciliation and independent deployed-revision health checks are mandatory.
- **Transport and audit:** secret tokens are passed only as scoped SecretBroker references to the approved host/worker. Never serialize raw credentials, production URLs containing tokens, environment values or third-party account identities into model tool arguments/artifacts. Redact errors and preserve evidence without accidental cross-project exposure.
- **Stop and rollback:** cancellation or network timeout after launch does not undo externally executed ACP/deployment actions. Record UNKNOWN until real target evidence proves state; rollback is its own approved exact-scope effect with separate receipt and verification. Do not let an imported external transcript, quoted DOM text or model-provided self-report satisfy a Run acceptance criterion.

Required acceptance evidence §32.35. Any missing OS sandbox, provider-side effect preauthorization, credential channel or robust target reconciler leaves the relevant operation UNAVAILABLE; the design table alone does not make it safe.

## 14.19 Checkpoint/restore effect semantics (LLD closure 2026-10-18)

Checkpoint/rewind is a V1 reliability capability (§32.24; tests CP-001/CP-002), not a git replacement. Closure rules:

- **Snapshot capture** — HostKernel mints one opaque, bounded snapshot bundle from the same descriptor-relative no-follow traversal that observes the registered workspace revision. The bundle binds every regular single-link file's bytes, path, mode, size and digest to the complete manifest and observed revision, with race checks before returning. P7 may persist only that HostKernel-authenticated bundle in ArtifactStore; caller-supplied snapshot bytes or a separate filesystem read are never checkpoint evidence. Until exact manifest/content binding and size bounds are available, capture is UNAVAILABLE. Fidelity is labeled honestly: changes made outside Horizon (manual edits, unmediated processes) are not captured. Storage bounds and eviction are owned by §31.18; events are §04 `checkpoint_created` and the §29.7 `checkpoint_created` hook.
- **Restore preview contract** — the bounded preview projection is `{workspaceRevisionChanged, mode: Full|SelectedPaths, selectedPaths, actions, conflicts, previewDigest}`. The digest binds checkpoint identity, current observed workspace revision, exact mode/path selection, planned actions/conflicts, and HostKernel-observed no-follow file-kind/link facts. `Full` restore has no actions and is refused whenever the observed workspace revision differs from the captured revision or dirty/untracked user data would be destroyed. `SelectedPaths` is an explicit, bounded selection of captured paths and may include only paths proven to be regular files with no symlink/hard-link ambiguity and no current conflict; dirty, untracked, conflicting and unselected paths are preserved. Every conflict is reported. HostKernel must supply authoritative file facts through its existing workspace observation boundary; P7 must not add a parallel filesystem reader. The exact preview digest is required by the Guarded restore request and is recomputed immediately before dispatch; any workspace revision, action or file-kind change makes it stale.
- **Restore is a guarded workspace effect** — restore flows through the same Guard/ExecutionHost path as any workspace mutation (PREPARED → lease → receipt), with `checkpoint.restore_preview` mandatory before `checkpoint.restore`. Restore refuses a destructive full reset and offers the explicit targeted per-path preview above (CP-001/CP-002); the user's later work is never silently destroyed.
- **Partial/uncertain outcomes** — a partially applied restore is `UNKNOWN` with a receipt and exact per-path state, never a silent "restored" claim. Symlinked/hard-linked paths and conflicts are reported, not clobbered.
- **Ownership** — conversation rewind uses the Core session revert seam (`packages/opencode/src/session/revert.ts`); Rust owns checkpoint artifacts and lifecycle. No second conversation writer.

## 14.20 Guarded Git worktree lifecycle executable and confinement (2026-10-19)

The only Git executable authority is the explicit global user-owned Core Config
`git_executable` absolute path, projected over the authenticated Core connection to
HostKernel. Project/plugin config, ambient `PATH`, RPC-selected executables and
caller/model argv are never consulted. HostKernel canonicalizes the configured file,
requires a regular executable, pins its content digest/profile revision, and rechecks
that digest immediately before the existing ExecutionHost supervisor launches it.

Managed worktree acquire/inspect/release are private P8 lifecycle operations. P8 owns
operation/worktree IDs and fixed relative paths. P1 derives fixed Git argv from the
opaque operation pin; acquire uses `worktree add --detach --no-checkout`, disables
hooks and ambient/system/global Git config, and never invokes a shell. The ordinary
workspace-write sandbox continues to protect all of `.git`. The Git lifecycle profile
is a separate broker-only OS policy: the workspace is read-only, with write access
limited to the exact canonical `.git/worktrees` metadata directory and P8's fixed
`.horizon/worktrees` destination parent. Other `.git` metadata stays read-only.
Locations whose common Git directory cannot be safely resolved and confined by the
selected backend are unavailable. No weaker fallback is permitted.

Every operation still requires the canonical Guard decision, any requested human
approval, a one-use durable lease, P8's immediate possible-dispatch marker, the single
supervisor, and a settled target-observed receipt. Release requires clean pre-delete
and post-delete MISSING evidence before P8 writes its permanent tombstone. A crash or
lost response after the dispatch marker is UNKNOWN and never triggers automatic
redispatch. If either fixed administrative directory is absent on first acquisition,
HostKernel may create only that exact directory by descriptor-relative, no-follow
creation after Guard approval, one-use lease issuance and the durable P8 dispatch marker;
an existing symlink, non-directory or user-owned collision is denied. Any subsequent
preflight failure remains behind the marker and is reconciled as no-dispatch only from
an exact supervisor proof, otherwise UNKNOWN. The supervisor retains the canonical
executable path and digest across approval and rehashes them immediately before spawn.

## 14.21 V1 first-party process-origin closure (2026-10-21; source-only)

The HorizonCode source audit classifies process origins at the last pre-spawn boundary:

- Core `AppProcess` admits only the pinned `hz-kernel` and `session_supervisor`
  control launches and their bounded digest probes. Its general `spawn`, `run` and
  `runStream` APIs reject every other executable/command before calling the underlying
  spawner. Core ripgrep and Git, and OpenCode Git and formatter routes, remain false-gated
  before executable resolution or command construction. The only enabled Core-owned
  child launches are control-plane bootstraps; they do not execute model/tool-supplied
  commands. User/tool process execution is a distinct Rust HostKernel path and remains
  Linux-only behind Guard, lease, cgroup persistence and pre-exec membership checks.
- Shell and TaskTool requests enter the admitted ToolBatch/Guard path; terminal process
  dispatch remains platform-gated and uses the existing cgroup-aware ExecutionHost.
  Persisted cgroup identity includes the exact Attempt scope digest when the owning
  capability carries one; settlement and restart reconciliation compare it to the
  durable execution row.
  PTY terminal routes remain unavailable because dispatch is still behind the product
  readiness gate; the source path persists durable containment identity before start.
  Native Windows remains unavailable pending native acceptance;
  Linux/WSL runs through the Linux cgroup backend count only for that backend and do not
  establish native Windows acceptance.
  The cgroup adapter must use the durable owner-only cleanup protocol below. It
  must not unlink a cgroup merely because a path was empty at one observation.
  The cleanup protocol is source-wired but not yet accepted. Eligible hidden-hierarchy
  groups with exact durable quiescence are reaped after terminal settlement/recovery.
  UNKNOWN, Full Access, legacy or otherwise unprovable groups remain retained in bounded
  quarantine; reaching its 256-entry ceiling keeps launches unavailable rather than
  weakening identity checks.
- Plugin initialization/hooks/project tools are withheld, plugin `$` throws a typed
  unavailable error, MCP CodeMode is absent from the model-visible registry and nested
  MCP calls refuse before dispatch, and hosted opaque tools are excluded unless a
  mediated workflow capability is available. LSP/DAP/REPL runtime gates remain false.
- The package launcher `packages/opencode/bin/opencode` has one bootstrap spawn: it
  selects and starts the packaged HorizonCode CLI after the user invokes the launcher,
  before session/tool authority exists. It is not reachable from model tools, plugins,
  hooks, TaskTool or MCP dispatch. It rejects native Windows and does not use a shell.
- SDK `createOpencodeServer`/`createOpencodeTui` exports in both `packages/sdk/js/src/server.ts`
  and `src/v2/server.ts` are public process origins, so V1 now returns a typed unavailable
  error before spawn. The corresponding SDK stop/abort helpers no longer kill arbitrary
  supplied children. This is a deliberate SDK compatibility limitation until HostKernel
  owns the launch and lifetime.
- TUI `$EDITOR` launch now returns unavailable before temp-file creation, TUI suspension,
  command resolution or spawn. Clipboard read/write are both no-ops until a Guarded
  clipboard capability exists; this includes process-backed platform helpers and the
  process-free OSC 52 mutation. Pure clipboard command-selection compatibility returns
  no executable.

These are source-level gates and authored fixtures, not acceptance evidence. Final
origin-closure evidence must prove denial before dispatch for every route and exercise
the Linux cgroup-backed path on the integrated revision. Linux/WSL evidence can qualify only
that Linux cgroup backend; it does not establish native Windows acceptance.

The stdio dispatch boundary now also has an explicit compile-time platform stop:
`EffectHost::begin_execution_dispatch` returns `UNAVAILABLE` before validating or
persisting a PREPARED dispatch on non-Linux targets. This prevents a future caller from
creating a durable launch intent that a platform lacking the V1 cgroup-v2 path could
mistake for dispatch authority. Linux launch still requires the exact cgroup identity,
including the Attempt-scope digest when present, to be persisted and revalidated before
the supervisor releases the confined child. This is source hardening only; platform and
restart acceptance remain unrun.

**P1 source re-audit (2026-10-21; not acceptance):** the current Rust
`prepare_tool_batch` bounds the complete call set and encoded payload before planning,
Guard-decides every member before persistence, rejects unsupported capability IDs, and
persists the admitted set atomically. Core also bounds streaming call count, per-call and
aggregate argument bytes, identities, stream duration, and withholds incomplete provider
tool-call batches. HostKernel serializes Attempt-bound lease issue/receipt progression; an
EffectHost lease is consumed once and any possible-dispatch ambiguity remains UNKNOWN.
The terminal command is carried as the exact Guard-approved string through the fixed
registered shell profile, bounded environment and workspace pins; no separate interpolation
or fallback process path was found in the audited tool dispatch. `AppProcess`, plugin/MCP,
CodeMode, hosted workflow, formatter, ripgrep, Git, editor and uninstall origins are either
restricted to pinned control children or rejected before their process/network operation.

The Rust EffectHost itself only compares an Attempt-scope digest; it does not authenticate
the scope. The P2-owned HostKernel must continue to resolve the live Task/Attempt/profile,
workspace, epoch, effective permission scope and receipt chain before it creates or advances
that digest-bound effect. Managed-message/provider transitions also remain unavailable
until their P2/P6 contracts are integrated. Acceptance and recovery tests for the exact
integrated revision are still required; no source status here is TESTED or VERIFIED.

### Durable cgroup-v2 cleanup (V1 source target; Linux only)

An empty cgroup may be removed only by the existing ExecutionHost's durable,
owner-only janitor. The janitor acquires the exclusive lock for the canonical
HorizonCode-managed namespace before enumeration and holds it through identity
revalidation and removal; normal creation and cleanup use this same lock. It
loads the exact persisted `CgroupIdentityV1` rows from EffectHost, including
boot ID, delegated-root device/inode, relative path, cgroup device/inode,
execution/effect/lease, execution principal, owner epoch, process generation,
profile and Attempt-scope pins. It revalidates the authenticated host owner,
current delegated-root identity, canonical managed namespace and exact cgroup
device/inode. Any nonterminal or ambiguous process is first killed through the
opened cgroup's `cgroup.kill`; cleanup waits for kernel `populated=0` and
persists the quiescence proof before removal. A dispatched UNKNOWN remains
UNKNOWN after cleanup; quiescence does not manufacture an exit or effect receipt.

Because Linux cgroupfs exposes no inode-targeted rmdir, removal by name is
permitted only under the exclusive HorizonCode namespace lock after opening
the exact directory without following links, confirming its device/inode and
empty state again, and proving no active durable execution row references it.
The managed namespace must be owner-only and must not be writable by launched
children or other principals. A name replacement, owner/lock loss, changed
root, unreadable row, populated group, missing proof or any uncertain outcome
quarantines the identity and retains it; it never falls back to an unchecked
name-based removal. Startup/recovery and bounded pre-create maintenance run the
same janitor. The 256-entry cap remains a temporary fail-closed fallback until
this cleanup path and its crash/race acceptance are implemented. Native Windows
and unsupported Linux cgroup layouts remain unavailable.

## 14.22 Secret mutation and Provider Doctor source boundary (2026-10-21)

The existing SecretBroker schemas in §12.17 define opaque put handles and metadata,
use leases and revocation receipts. They do not define an authenticated Guard grant
for put/rotate/revoke or the native-to-broker grant binding. Until that contract exists,
Core Auth must reject put and revoke before calling the broker; legacy OAuth/API-key
mutation routes must remain unavailable. A handle may be issued only by a trusted
native input channel bound to the authenticated principal and exact write operation.
Request bodies, arbitrary host-JavaScript byte helpers, logs and general Core/RPC
messages are not that channel. Credential bytes remain inside the broker/approved
first-party transport boundary and are never returned to Core or persisted in receipts.

`providers.doctor` remains a reserved design target under §33.29. §37.18 names
`NetworkReadGrantV1` and `SpendApprovalRef`, but does not define their schemas, issuer,
capability IDs/policy, exact provider/model/config binding, request/time/spend bounds,
one-use lease, cancellation receipt or restart reconciliation. Therefore catalog and
full probes must make no network request until those grants and their HostKernel
receipt path are specified and implemented. Offline inspection may only use local
configuration/catalog state and must report missing or stale facts as UNKNOWN.

This is a concrete contract dependency, not acceptance evidence. The Auth mutation
fixture asserts that an absent Guard grant makes zero broker mutation calls. Doctor
network behavior remains unavailable; no provider call or check is implied.

**Update (2026-10-27): the `secret.v1` grant contract now exists.** HostKernel
admits `secret.v1` on the authenticated dispatch allowlist with five operations:
`authorize_put`, `authorize_rotate`, `authorize_revoke`, `authorize_use` and
`redeem_use`. Mutation requests carry metadata only — `providerId`,
`idempotencyKey` and, for rotate/revoke, the exact `secretRef` plus
`expectedVersion` (and a bounded optional `label`). `authorize_use` accepts only
`secretRef`, `providerId`, exact HTTPS `destination`, `operationDigest`, purpose
`PROVIDER_REQUEST`, `idempotencyKey`, and exactly one bounded `maxExpiresAt` or
`ttlMs`. `redeem_use` accepts only the issued `leaseId` and an idempotency key.
Credential bytes, caller-supplied principals, challenge/effect IDs, secure-input
handles, and extra fields are rejected as `invalid_effect_request` before any
state is read.

Owner identity is never taken from the request. HostKernel accepts either the
typed `ServerAuth` subject already bound to the connection (the connection
principal must equal `server_auth:<subject>`) or, for a local CLI, the
kernel-attested `host_os_uid:<uid>` principal derived from `SO_PEERCRED` and the
connected process executable identity. The owner scope is a domain-separated
BLAKE3 digest over that identity, so the two identities never share a credential
scope and neither can reach the other's secrets. The grant alone moves no bytes:
it is redeemable only inside the process that owns the matching one-use
`SecureInputVault` handle, whose binding must equal the grant field for field.

Each authorization runs the normal Guard path with owner-scoped policy, a
PREPARED durable intent, a one-use EffectHost lease consumed before any receipt
exists, STARTED settlement to a durable receipt, and replay accepted only from
that exact receipt. Canonical actions are `secrets.put|rotate|revoke|use`; the
subsequent `redeem_use` consumes one issued use lease exactly once
(`ISSUED -> CONSUMED`) and is itself owner/expiry fenced. An intent recovered
without its receipt reports `secret_outcome_unknown` and is never retried as a
success. Mutation version fencing rejects stale rotate/revoke
(`secret_stale_version`); use authorization rejects provider mismatch
(`secret_provider_mismatch`), a foreign owner (`secret_not_found`), revoked
secret (`secret_revoked`), malformed request (`invalid_effect_request`), and
expiry beyond 120 seconds (`expired`). Denials do not write receipts, so the
same idempotency key remains usable after correcting the request.

Acceptance boundary. Rust coverage is `kernel/tests/secret_mutation_grant.rs`
(6/6) and `kernel/tests/secret_use_grant.rs` (10/10); guard unit tests are 46/46
and secret journal unit tests 5/5. The mutation suite covers forged owner,
untyped principal, stale version, provider mismatch, half-specified target,
revoked target, extra credential/principal fields and restart replay. The use
suite covers exact HTTPS/digest/purpose/TTL binding, owner/provider/revocation
denials, exact replay, one-use redemption, expiry and restart persistence. The
in-process SecretBroker byte store is TypeScript; HostKernel has no credential
byte-store or byte-redemption endpoint. Its `redeem_use` consumes metadata only,
so credential bytes never reach Rust. Lease and receipt retention are bounded
(256); evicted entries fail closed. `secret_outcome_unknown` is proven at
journal level, not by crash injection. Production Core request-scoped transport
and live-provider E2E are separate gates, not implied by kernel grants.

## 14.23 Request-bound context integrity at managed dispatch (2026-10-21)

Each managed provider dispatch is preceded by a HostKernel admission/advance for
its exact `ContextSelectionV1`. The selection carries the actual child Core
`sessionID`, a Core-generated `requestID`, the managed `attemptID` and positive
`requestSequence` (1–1024), plus at most 64 ordered source references. Managed
selection requires exactly one each of Rust-pinned `managed-task`, accepted
`accepted-spec`, task-pinned `agent-profile`, and `provider-input` references;
other tool, instruction, skill, template, history and artifact references are
accepted only with exact owner revisions and digests. Parent Session is lineage,
not the selected prompt Session.

The sole `provider-input` reference uses `sourceID=requestID`,
`sourceRevision=requestSequence` for managed work (the Session cursor for direct
work), authority `core-prompt-compiler`, trust `mixed`, and inclusion reason
`current_request`. Its content digest is Core's BLAKE3 digest of the exact
canonical normalized provider-visible system/messages/tool definitions. `mixed`
means the aggregate may contain multiple trust classes; the field grants no
authority. HostKernel's domain-separated canonical MessagePack BLAKE3 covers the
whole ordered reference DTO and is returned with the acknowledged sequence and
request ID. Rust cannot inspect provider payload bytes at this API: Core must hold
one immutable compiled request and dispatch those same normalized bytes only after
the exact returned digest/request/sequence matches. Any edit, stale reference,
sequence conflict, cancellation or lost admission result prevents dispatch until
reconciliation; no model call may occur between compilation and the matching pin.
The digest is provenance/integrity metadata and never widens permissions or
replaces Guard, effect leases or receipts. Context text and transcript copies are
never stored in Rust managed state.

## 14.24 Direct request pin and inference authorization (V1, DEC-V1-32)

The direct lane has no managed Attempt and does not call HostKernel to bind each
provider prompt. Core `ContextService` compiles the exact normalized provider-visible
system/messages/tool definitions from the authenticated direct Session. Before transport,
Core SessionStore atomically records the `lane: direct` ContextSelection DTO and its
domain-separated digest, exact request ID, observed Session cursor, provider-input digest,
the active AgentProfileV2 ID/revision/digest and effective permission-scope digest, selected
provider/model/account/harness/endpoint revisions, and effective privacy, network,
output-token and cost-policy revision. The same immutable normalized object and
selected route are passed to ProviderTransport; the adapter verifies the pinned input and
separate non-secret SDK transport-request digest immediately before send. Stored records
contain refs/digests and status only, never prompt bytes, credential bytes or lease tokens.

The authorization rule is DEC-V1-32 (§17.26): the authenticated user's explicit prompt or
continue authorizes the already-selected provider/model/account/harness for that bounded
turn under its configured privacy, cost, token and network policy. Normal continuation
requests inside that turn do not prompt per provider round-trip. This does not authorize
arbitrary tool network calls. A route, account credential revision, privacy/network policy,
or hard budget change before send denies; Core must not rebuild under new settings. For a
configured hard cost ceiling, Core must account or conservatively reserve the next bounded
request before dispatch; if remaining budget cannot be established, it stops and reports
unknown spend rather than continuing. No fallback, paid upgrade or account substitution is
allowed. Direct credentialed routes require the selected-route SecretBroker boundary;
credential bytes and one-use lease material never enter the selection or Session transcript.

The Core-owned direct request journal is keyed by authenticated Session owner, `sessionID`
and Core-ingress `requestID`. Exact replay of the same request, selection digest, frozen
provider-input digest, route pins and policy pins returns the existing receipt. Reusing an
ID with changed prompt, context, route, account, harness or policy conflicts. Persist
`PINNED` before transport and `DISPATCHING` before provider bytes may leave Core; persist
the assistant-entry/usage settlement as `SETTLED` atomically with its canonical Session commit. A
restart before `DISPATCHING` may resume only the exact pinned payload and route. After
`DISPATCHING`, absence of the exact persisted response/settlement is `UNKNOWN`; never
automatically resend or claim success. The user may explicitly continue with a new request
ID after the interrupted turn is surfaced. This journal belongs to Core Session storage,
not the Rust OwnerLog. Direct effectful tools still use Guard, one-use leases, ExecutionHost
and receipts; the provider request pin does not authorize them. Managed request binding and
recovery remain §14.25.

## 14.25 Managed provider dispatch is a separate durable effect (2026-10-21)

ContextSelection receipt alone never authorizes a provider call. Each managed model request
must persist a typed HostKernel/ManagedControl lifecycle: `managed_provider.prepare` binds
the live Attempt scope, request ID/sequence, selection digest, selected provider/model/harness
and route revision, and exact normalized input digest; `managed_provider.begin` rechecks the
Attempt and Guard/consent/budget, then durably records DISPATCHING before returning a fresh
one-use send authorization; `managed_provider.settle` follows durable child assistant-entry
commit and binds its entry ID/digest and usage provenance. Exact retries return existing
receipts but never a second send authorization. Restart or uncertainty after DISPATCHING
settles to UNKNOWN and blocks automatic provider replay. The request is not sent when route,
model, endpoint revision, payload digest, Attempt scope, or selection pin differs.

**P6 transport-binding amendment (2026-10-21):** the durable request carries three distinct
digests. `requestDigest` is the normalized provider-visible input digest already pinned by
`ContextSelectionV1`; `transportRequestDigest` is a digest of the exact non-secret SDK
transport request that will be sent (method, canonical destination, non-credential headers,
body, credential-header profile, provider/model/harness/route and endpoint revision); and
`operationDigest` is the SecretBroker operation digest for the one-request credential lease.
These values are not aliases and must never be substituted for one another. `prepare` binds
all three to the same request ID/sequence, ContextSelection digest, selected route, live
Attempt and owner epoch. A fresh `begin` rechecks and durably consumes the one-use permit
against all those same pins before returning an opaque, single-use authorization usable only
inside the existing Auth/Provider callback. Auth derives `TrustedSecretUseContext` from that
authorization; callers cannot supply it. Replay returns no authorization. The callback must
recreate/validate the exact non-secret SDK request against `transportRequestDigest`, verify
`requestDigest` against the frozen normalized input and `operationDigest` against SecretBroker,
then consume the credential lease and send exactly once. No request bytes are sent if any
digest, route, Attempt, sequence, ContextSelection, owner epoch, endpoint revision, or
authorization differs. All three digests and the exact response/usage pins remain distinct
through settlement and restart inspection; no digest is reconstructed from transcript text.

The remaining HostKernel/Core integration uses the existing first-party provider owner and
the internal `providers.infer` Guard/EffectHost authorization lifecycle; generic web-search
or outbound-HTTP dispatch does not authorize model inference. It must not add a second
provider transport, endpoint registry, or credential store. Core supplies an authenticated, strictly
decoded route projection containing provider ID, model ID, harness ID, opaque route ID,
fixed endpoint revision digest, exact normalized request digest, and an optional opaque
credential reference (never credential bytes or arbitrary URL/headers). `credentialLeaseRef:
null` is valid only when the canonical Rust route resolver proves that the exact selected
provider/model/harness/endpoint is anonymous; it is not a Core-selected credential mode or
a sentinel. A non-null SecretRef identifies stored credential material but is not itself a
one-use credential lease or consumption receipt. HostKernel validates the route against the
selected profile and the P6-owned Core provider configuration, then binds a per-request
HostKernel-created Guard challenge to the exact route, request, Attempt and budget before
presenting it through the existing authenticated TUI Guard approval route. That challenge is
the explicit per-effect inference consent; the caller supplies neither a consent reference nor
a Guard challenge/lease. Search-route enablement remains separate and cannot authorize model
inference. The approved one-use lease, dispatch permit, cancellation and response receipt
remain bound to that projection. Until the `providers.infer` Guard/TUI allow projection, P6
route/credential adapter and Rust pre-dispatch handoff are integrated and verified,
`managed_provider.begin` returns no send authorization and managed LLM dispatch stays gated.

**Current source gate (2026-10-21):** HostKernel exposes strict authenticated
`managed_provider.prepare`, `.begin`, `.settle`, and `.unknown` request shapes. Prepare checks
the Task-pinned profile selection and durable request-scoped ContextSelection digest, then
returns `UNAVAILABLE` without an OwnerLog transition because HostKernel route validation,
the `providers.infer` managed approval resolver, protected credential adapter and Guarded
provider transport are not integrated. P1's EffectHost prepare/authorize/consume/settle/recovery
APIs exist, but are not yet called by these HostKernel handlers. Its response
echoes exact route/request pins and the unchanged managed revision. Begin requires strict
route/request pins and returns those same exact pins, the unchanged revision, and null
`sendAuthorization`; it never persists DISPATCHING while the existing ExecutionHost cannot
consume a one-use authorization. `credentialLeaseRef` is a required nullable field in the Rust
DTO; null is shape-compatible only and does not prove an anonymous route. Settle and unknown
return UNAVAILABLE unless durable DISPATCHING and authenticated transport/Core-entry evidence
exist; they do not fabricate receipts. The OwnerLog provider record binds route ID, optional
credential, Guard challenge and capability-lease references for exact replay comparison. No
caller consent reference is accepted. No operation can send provider bytes until the existing ExecutionHost consumes a
fresh authorization and durably records its response or UNKNOWN.

**P6 DTO source continuation (2026-10-21; not acceptance evidence):** Core's typed decoder now
requires normalized `requestDigest`, exact non-secret SDK `transportRequestDigest`, and
SecretBroker `operationDigest` together in request pins and echoes those pins through begin,
settle, UNKNOWN, and settlement inspection. Fresh begin is decoded into an Auth-private,
single-use WeakMap handle only after the route, Attempt, owner epoch, request sequence and
all three digests match; replay/unavailable cannot produce a handle. The managed OwnerLog
record, reducer comparison, serialization and replay parser persist both transport and
operation digests. The generated JSON schema lives at
`arch_V1/contracts-v2/managed-provider-turn-v1.schema.json`. HostKernel handler-side DTO
wiring and the Guarded ExecutionHost sender remain pending P2/P1, so managed LLM dispatch
stays unavailable and no provider bytes can be sent. No typecheck, test, build or provider
call was run for this source continuation.

## 14.26 Internal managed `providers.infer` Guard action (2026-10-21)

Managed provider dispatch has one internal canonical Guard action,
`providers.infer`, registered once as a sealed `kind: action`. It is never exposed
as a model tool, `ActionDescriptor`, ToolRegistry/ToolBatch member, MCP tool,
plugin capability or provider route selector. HostKernel mints it only for a
live authenticated ManagedRun Attempt. Guard admission also checks the ID against
the canonical machine registry; its local policy discriminator grants no alias
or independent capability registration. Prepare binds the normalized provider
request and exact non-secret SDK transport request, SecretBroker operation,
selected provider/model/harness/route/endpoint revision, current permission
scope, and budget authority/limits. A per-request HostKernel-created Guard challenge
bound to these exact route and billing pins is the explicit consent for that inference;
there is no separate persistent route-enable setting or caller-projected `consentRef`.
The challenge and approved lease are HostKernel-owned. A fresh begin revalidates these
pins and the one-use lease, appends DISPATCHING, then returns an opaque permit usable only
in the existing Core Provider/SecretBroker callback. Immediately before credential use and
transport, that callback consumes the authorization through HostKernel; any lost or
ambiguous consume is UNKNOWN and cannot be replayed. That callback must verify the
exact serialized SDK request and send once, without arbitrary URLs, credential
bytes, hidden fallback or replay. Settlement binds the assistant entry,
response and usage; uncertain post-dispatch outcomes remain UNKNOWN. The source now has a
dedicated EffectHost approval resolver that rechecks the complete prepared binding and
Guard decision before atomically recording one authenticated allow or deny. The TUI accepts
`host.managed_provider` only for `providers.infer`, this exact guarantee list, an assessed
empty residual set, and an available non-secret summary. HostKernel projection/HTTP reply
wiring, P6 route/credential integration, and the Rust pre-dispatch handoff remain
unverified; managed inference remains unavailable until P1/P2/P6 integration and acceptance
complete.

**P2 approval-flow source update (2026-10-21; not acceptance evidence):** HostKernel now returns
the full provider-specific challenge projection from the trusted immutable Attempt route and
budget. Core strictly checks `host.managed_provider`, `providers.infer`, the exact guarantee
list, empty assessed residual, and secret-free route/budget target, then publishes the existing
`guard.approval.requested` event. An authenticated ServerAuth decision is resolved through the
dedicated `managed_provider.resolve_approval` operation; it does not use verifier or ToolBatch
resolution. P6 must call `awaitManagedProviderApproval` after prepare and before begin. The
managed sender remains gated until that caller is wired and the full consume/transport/settlement
path passes integrated acceptance.

**P2 provider lifecycle source continuation (2026-10-21; not acceptance evidence):** the
HostKernel and Core managed-control owners now expose strict authenticated prepare,
approval-resolution, begin, consume-send-authorization, per-dispatch settle, complete-turn,
settlement-inspect and UNKNOWN transitions. The selected route is resolved from the Task-pinned
AgentProfile through the existing Core provider registry and pinned at Attempt admission; route
drift denies. Approval uses the exact prepared `providers.infer` challenge and authenticated
ServerAuth subject. The HostKernel derives SecretBroker requester/profile/run references from
authenticated principal, live Run and pinned profile. UNKNOWN reason is retained and exact
replay must preserve it. P6/P7 still own the production SDK callback and persisted step-finish
caller; until they call the approval/consume/settle path and integrated acceptance passes,
managed provider dispatch remains gated. The per-dispatch response receipt binds the persisted,
schema-decoded Assistant info, exact `step-finish` part and `stepFinishIndex` using canonical
MessagePack under `horizoncode.managed-provider-response-step.v2\0`, with a separate usage
provenance digest. Completion derives contiguous settled dispatches from HostKernel OwnerLog,
not caller-supplied ordering. Post-restart successful-settlement worktree disposition recovery
still lacks a P2 HostKernel route over P8's fresh current-epoch Guarded Inspect API; a historical
Inspect or caller receipt cannot release that disposition.

## 14.27 CodeMode and managed wave admission (DEC-V1-29/30)

CodeMode is untrusted orchestration code. It runs only in the existing short-lived helper under
Rust ExecutionHost with fixed `horizoncode:codemode:bun` selection and the exact
`CodeModeResourceProfileV1` cgroup/FD limits. Progressive discovery uses the existing
`$codemode.search` interface over the authenticated caller's authorized tool tree. Existing MCP
adapters are eligible only as Core capabilities that return nested calls to the same Guarded
dispatcher; no direct MCP transport or host API is available inside the helper. All calls share
one 30-second deadline, 64-call cap, 64-KiB source/output caps and 1-MiB aggregate argument cap.
Concurrent calls from one interpreter scheduling turn form one complete atomic wave of at most 32;
dependent calls use later sequential waves. Every nested effect receives fresh resource resolution,
Guard evaluation, intent, one-use lease, ExecutionHost dispatch and exact receipt/UNKNOWN handling.
In a direct Session only, an active exact DirectSessionGrant may remove repeat prompts within its
accepted scope; a managed Attempt cannot consume a direct grant. Neither lane skips Guard or
receipt requirements.

For managed Attempts, `attempt_effect_wave_bound` is the canonical pre-lease OwnerLog event. It
binds the exact ordered edge set and separate canonical `argumentsDigest` and complete immutable
`intentDigest` values at one revision after approval. HostKernel refreshes and revalidates the live
Attempt scope before exposing one-use leases. Legacy `attempt_effects_bound` remains replayable but
cannot authorize newly admitted waves. See §§11.6, 12.19, 12.21, 32.41 and 37.24.

**CodeMode lane enablement and approval semantics:** Direct Session exposure requires an explicit
authenticated user `CodeModeEnablementV1` bound to principal, Session/owner epoch,
`codemode.execute`, fixed helper selector/digest, exact `CodeModeResourceProfileV1` digest,
backend/guarantee digest and current policy/expiry/revocation state. This enables only the helper;
nested actions still use ordinary Guard and workspace grants. Enablement itself does not launch a
pending script; a fresh execute request is required. Managed execution accepts no direct grant:
the accepted SpecVersion must name `codemode.execute`, the Task-pinned AgentProfileV2 ceiling must
permit it, and HostKernel checks those exact pins and resource digest against the live Attempt
before launch. No grant token is sent to the model. For effect challenges, `allow_once` approves
and may dispatch only that exact action/batch after fresh validation. Approval frequency comes
from `DirectSessionPermissionModeV1`; selecting a Session/workspace
grant only records authority and does not dispatch/resume the pending batch, which must be freshly
submitted and admitted.
### Routine direct-session grants and command execution (DEC-V1-28)

Guard is the single policy decision point for direct and managed effects. A direct
Session grant gives a quiet allow path only for exact user-selected actions, registered
workspace roots, immutable policy/backend/guarantee pins and finite limits. It does not
replace per-effect Guard evaluation, budgets, intent, one-use lease, ExecutionHost, receipt
or UNKNOWN reconciliation. Workspace build/test grants require a trusted immutable
Core-Config `WorkspaceCommandProfileV1`; arbitrary shell and model-selected command
strings are never grantable. Each command is launched as direct argv under the existing
ExecutionHost. If a profile requires OS guarantees the selected backend cannot enforce, the
profile remains unavailable; approval cannot override the missing guarantee, and monitoring
does not count as enforcement. Grant lifetime, revocation and profile
digest are specified in §§12.21 and 37.26–37.27; permission-mode projection is §37.25.

## 14.28 Direct-session Git workspace read effects (DEC-V1-31 / §17.31)

Bounded Git inspection is a **read-only** effect family under the same authenticated
principal, registered Location, workspace revision and `files.read` / workspace-grant scope
as other repository reads. HostKernel exposes fixed operations only:
`git.status`, `git.diff`, `git.log`, `git.show`, and `git.branch.list`. Each operation uses
a fixed argv template with repository-relative literal paths and validated object IDs; the
caller, model, plugin or MCP cannot supply executable, cwd, environment, raw argv,
arbitrary subcommands, network remotes or write flags.

Settled stdout/stderr is bounded, redacted where required, and durably replayable only under
the exact same operation binding (receipt bytes or immutable artifact ref). Missing or
conflicting post-dispatch evidence is `UNKNOWN` and is never re-executed automatically.
`repo.tree` and other RepoIntel navigation remain on RepoIntel (`§37.22`); this path does not
implement `git ls-tree` as a substitute.

Mutating Git capabilities (`git.commit`, `git.branch.create`, `git.branch.switch`, and
similar) remain separate **guarded_effect** tools in `§33` and require their own Guard
classification, argv templates and acceptance; they are outside the §17.31 read-only
inspection contract. Service boundary: `§37.29 GitWorkspaceReadServiceV1`; integration seam:
`§20.15`; acceptance: `§32.46`.

## 14.29 External editor process effects (DEC-V1-33)

Launching a user-configured editor is a first-party process effect under canonical
`editor.launch`. Only a direct root Session user action may invoke it; it is never a
model tool, managed Attempt action, plugin hook, or implicit consequence of opening a
file. Core projects an immutable user-owned editor profile and HostKernel verifies its
revision/digest, resolves the executable identity, derives Location/root/owner/mode pins,
creates EffectIntent, obtains the normal approval decision and one-use lease, then uses
the existing ExecutionHost. No Core `spawn` call, shell command parsing, inherited
unfiltered environment, model-selected executable/argv/path, or second supervisor is
permitted.

The editor itself runs as the user-selected program. In `workspace-write`, OS-enforced
filesystem scope and process-tree containment are mandatory because an editor can write
outside the file passed on argv; Guard mediation of agent tools alone cannot contain it.
If the selected backend cannot prove those guarantees, workspace editor launch is
unavailable in that mode. Explicit `danger-full-access` launches without HorizonCode
sandboxing and displays the existing risk notice. `always` prompts before launch;
`on-request` admits only inside a verified selected sandbox; `never` does not prompt and
does not widen that sandbox. The user launches the editor; the model cannot do so.

After exit, HostKernel settles the process receipt and Core compares the original file
revision before producing an ordinary `files.patch`. A changed base returns conflict and
never overwrites newer content. The file fence blocks concurrent agent writes to that
path while editing. A lost launch reply or receipt is UNKNOWN and status-only recovery;
never start a second editor on the assumption the first failed. See §12.22 and §37.28.

For a workspace file, the user-selected path and workspace revision are paired with the
`contentDigest` returned by the exact authenticated Explorer preview. The host compares
that original digest and current workspace revision after editor exit; a changed or
unavailable source is a conflict, never an implicit reread-and-overwrite. The redacted
result projection preserves EffectHost `effectID`, `executionID`, `bindingDigest`,
`receiptDigest`, process identity, exit code, result-file digest and observed revision.
See `contracts-v2/external-editor-profile-v1.schema.json` for the strict outcome shape.

