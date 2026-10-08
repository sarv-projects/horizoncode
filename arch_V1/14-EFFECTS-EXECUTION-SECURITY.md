# 14. Effects, execution, security and extension trust

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

`normal`, `reduced` and `auto-safe` are policy postures, not bypass modes.
`auto-safe` resolves ASK only for policy-designated low-risk action classes and
within exact resource/limit constraints. Broad delete, credential export, public
publication, arbitrary external filesystem, policy DENY and catastrophic actions
remain manually denied or explicitly reviewed by policy.

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
intent unless policy classifies its data access as auditable. The whole provider tool
response is assembled and validated before any unstarted tool call executes. If any
call is structurally invalid or the aggregate exceeds bounds, reject the batch and
dispatch zero calls from that batch. After batch admission, independent calls may
run in parallel only when the resource conflict graph permits; overlapping writes
serialize; shell over a writable workspace is exclusive unless a stronger contract
proves otherwise. `question` and approval are barriers: dependent later operations
cannot race ahead.

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
the Bun/TypeScript `hzcode` application host and is not a separate process. The
kernel-side module owns the single local operation/process execution seam and invokes
the selected OS sandbox or subprocess backend. `hzcode` performs provider streaming
and collects complete tool batches only; it never executes effect-capable operations
or starts their child processes. Tool handlers, plugin code and controllers may request
an execution through the kernel-owned flow but cannot create an untracked process
manager or bypass Guard, EffectService, or the capability lease.

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

For the first product release, Windows is the target platform. This is a release
requirement, not evidence that the current backend is ready. At the reviewed source
revision `horizoncode-sandbox/src/windows.rs` returns `Unsupported` for confined
profiles; only the explicitly requested `full-access` profile may run bare. Therefore
Windows release acceptance MUST implement and independently test the selected
filesystem/process/network backend, or keep the affected operation/capability
unavailable. Do not silently ship workspace shell as “sandboxed” or treat catalog
presence as support.

Existing implementation evidence to preserve accurately:

- Linux `horizoncode-sandbox/src/linux.rs` uses bubblewrap namespaces, a restricted
  mount view, scoped roots, protected subpaths, masked deny matches and no network
  namespace sharing by default. Target guarantees still require per-kernel/runtime
  acceptance; the source implementation is not production acceptance by itself.
- macOS uses a Seatbelt profile with scoped root reads. The current implementation
  explicitly reports child-process network denial as `best_effort` and refuses a
  request that requires enforced allowlist confinement. Do not relabel it as an
  enforced whole-tree boundary.
- Windows currently fails closed for confined profiles; a job object alone is not
  filesystem or egress confinement.

The backend must report each dimension and refuse when a Task's `GuaranteeRequirement`
is not met. `capability_limited` is not equivalent to `enforced`; `best_effort` must
name its mechanism and residual. The app may offer a weaker explicit trust mode only
when policy permits and the UI shows the exact residual before dispatch.

The current local `horizoncode-sandbox` is a reference seam, not this full interface.
Its process helper retains bounded stdout and stderr separately but kills only the
direct child on watchdog timeout, and its outcome has no explicit truncation receipt;
the adopted ExecutionHost contract requires observable truncation and process-tree lifecycle
semantics before treating that helper as a production executor. See the revision-bound
observations and exact ranges in [`09-SOURCE-MAP.md`](09-SOURCE-MAP.md#96-current-horizon-implementation-seams-inspected).

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
`SecretRevocationReceiptV1` in [`12-DOMAIN-SCHEMAS.md`](12-DOMAIN-SCHEMAS.md#129-effect-approval-audit-and-reconciliation-records).

`ISSUED → CONSUMED` is committed by SecretBroker before a single authorized request;
expiry or secret rotation/revocation moves an unused lease to `EXPIRED`/`REVOKED`.
Consumed leases are not reusable; a provider retry requires a new authorized lease.

`secureInputHandle` is a one-time reference to a protected native input channel, not
credential content; it is scoped to this put operation and is never logged or reused.
Raw credential values are deliberately absent from these wire schemas. The exact
single-request delivery boundary between SecretBroker and the built-in `packages/llm`
adapter remains DEC-V1-06; until it is decided and tested, a provider auth path that
requires raw credential delivery is unavailable rather than passed through a general
plugin/kernel RPC.

Secret use binds the secret version, requesting service/process identity, provider or
MCP server, route/operation digest, destination, Run/profile if any, purpose, expiry
and single-use/request limit. The broker rechecks the current secret version and
lease state immediately before use; rotation/revocation makes older unconsumed leases
fail closed. The candidate path, if DEC-V1-06 selects byte delivery, is
an in-process host `packages/llm` request bound to the authorized route; only the
minimum credential bytes are delivered in memory for that request. The OpenCode-derived host is therefore
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
containment. Windows is the first-release acceptance target; Linux/macOS contracts
remain separately reported and cannot inherit Windows evidence or vice versa.
