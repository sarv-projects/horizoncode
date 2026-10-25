# P8 Stage-A/B pre-admission lease & proof contract (handoff for P1 / P2)

**Owner:** P8 (resource/worker/worktree durability). **Written:** 2026-10-25.
**Scope of this file:** documentation only — it records the exact on-wire and
durable proof shape that the managed `reserve → bind_context → admit` journey
requires, which producer owns each fact, and what fixture evidence P8 itself
owns. It grants no authority, changes no gate, and is not a test result.

All line numbers below were read from the working tree on 2026-10-25; the
function names are the stable anchors.

---

## 1. The three operations and their exact bodies

All three belong to `service_id = managed.v1` and are dispatched in
`kernel/src/host_kernel.rs` (`managed_pre_admission_target_reserve` for
`managed.pre_admission_target.reserve`, `managed_admit` for both
`managed.pre_admission_target.bind_context` and `admit`).

`strict_fields(body, required, optional)` (`host_kernel.rs:35534`) rejects a
missing required key **and any key that is not listed**, all with
`invalid_effect_request`. There is no optional-key tolerance in `managed_admit`.

| Operation | Required body keys (exact, in source order) | Optional |
|---|---|---|
| `managed.pre_admission_target.reserve` | `goalID`, `runID`, `taskID`, `expectedRevision`, `parentSessionID`, `locationID`, `sessionID`, `profileDefinition` | `resourcePolicyProjectionRevision`, `resourcePolicyProjectionDigest` (compare-only: if present they must equal the HostKernel pin, else `resource_policy_stale`) |
| `managed.pre_admission_target.bind_context` (`bind_context = true`) | the 12 common keys `goalID`, `runID`, `taskID`, `expectedRevision`, `parentSessionID`, `locationID`, `sessionID`, `profileDefinition`, `contextSelection`, `resourcePolicyProjectionRevision`, `resourcePolicyProjectionDigest`, `preAdmissionProofDigest` **+** `candidateAttemptID` | none — `managedProviderRoute` is deliberately **not** accepted in this mode |
| `admit` (`bind_context = false`) | the same 12 common keys **+** `managedProviderRoute` **+** `attemptID` | none |

The 12 common keys are built as one `vec![…]` in `managed_admit`; the mode
split is exactly:

```rust
if !bind_context { required.push("managedProviderRoute"); }
required.push(if bind_context { "candidateAttemptID" } else { "attemptID" });
```

Transport-level (not body) requirements: `admit` and the reserve/bind handlers
need an authenticated `ServerAuth` principal whose `server_auth:<subject>`
matches `principal`, a registered `locationID` owned by that subject, a fresh
`FrameFence`, and — for `admit` — a `delivery_id` on the envelope
(`managed_delivery`), because admission is an idempotent append.

**Observed client/fixture state (2026-10-25):** P2 continuation 38 corrected
the production `admit` closed key set and added the exact projection pins, but
the managed client still has no executable `project_policy` call. Its current
mentions are comments and the revision/digest DTO fields. P2 added an
authenticated-kernel integration fixture in
`kernel/tests/managed_control_plan_ingress.rs` which negotiates
`resource-policy.ingress-v1` and exercises `project_policy` plus the
fail-closed no-configured-policy behavior. This proves the Rust test ingress,
not production Core feature negotiation or policy projection. P1 still owns
offering the optional feature in `packages/core/src/session/supervisor.ts`, and
P6 owns the trusted Config projection producer.

## 2. The digest chain (what each proof digest *is*)

```text
Stage A  managed.pre_admission_target.reserve
   └─ preAdmissionProof.proofDigest      = ReservedPreAdmissionTargetProofV1::proof_digest()
        (binds ManagedPreAdmissionTargetPinsV1 + ReservedWorkerLeaseProofV1,
         no ContextSelection yet; status RESERVED_CONTEXT_UNBOUND)

Stage B  managed.pre_admission_target.bind_context      (or inside `admit`)
   ├─ in : preAdmissionProofDigest       must equal Stage-A proofDigest
   │        (host_kernel: `stage_a_proof.proof_digest() != expected_pre_admission_proof_digest`
   │         → managed_conflict "Stage-A proof digest differs from the exact reserved Task candidate")
   └─ out: preAdmissionProof.receiptDigest = reservation.context_bound_receipt_digest()
        (binds the exact blake3 ContextSelection digest to the same RESERVED lease;
         status RESERVED_CONTEXT_BOUND)

admit    managed.admit
   ├─ in : preAdmissionProofDigest       must equal Stage-B receiptDigest
   │        (host_kernel: `stage_b_digest != expected_pre_admission_proof_digest`
   │         → managed_conflict "Stage-B proof digest differs from the context-bound reservation";
   │         replay path compares `reservation.context_bound_receipt_digest()`)
   └─ out: ADMITTED + bindingDigest (DelegationBinding), contextSelectionDigest,
           managedProviderRoute, pinsDigest, revision, worktreeTarget, managedAttempt
```

Every `preAdmissionProof` object also carries the durable OwnerLog anchors that
make it re-resolvable after restart: `leaseProofDigest` (`reservation.proof_digest()`),
`pinsDigest`, `ownerLogID`, `ownerLogSequence`, `ownerLogEventDigest`,
`ownerEpoch`, `workerPoolRevision`, `workerExecutionID`, `ticketID`. These are
derived by P8 from the committed cursor — no caller can supply them.

## 3. P8's durable API surface that produces the chain

All in `kernel/src/worker_durable.rs` (`pub(crate)`, i.e. crate-internal):

| P8 API | Line | Signature (abridged) | Stage |
|---|---|---|---|
| `reserve_managed_pre_admission_target` | 6189 | `(&mut self, &ManagedPreAdmissionTargetPinsV1) -> Result<ReservedPreAdmissionTargetProofV1, _>` | A |
| `resolve_reserved_managed_pre_admission_target` | 6248 | `(&self, &RootCoordinatorExecutionProofV1, now_ms, &pins, &proof) -> Result<(ReservedPreAdmissionTargetProofV1, ManagedAttemptWorktreeTargetV1), _>` | A re-resolve |
| `resolve_managed_pre_admission_target_for_candidate` | 6286 | `(&self, &root, now_ms, attempt_id, identity) -> Result<(pins, proof, target), _>` | A replay/restart |
| `bind_managed_pre_admission_context_digest` | 6338 | `(&mut self, &ReservedPreAdmissionTargetProofV1, &str /*blake3 ContextSelection*/) -> Result<(ManagedReadyTaskPinV1, ReservedWorkerLeaseProofV1), _>` | B |
| `resolve_pre_admission_admission_lease_proof` | 6559 | `(&self, &pins, &reservation, &owner, now_ms) -> Result<DurableManagedLeaseProofV1, _>` | admission lease |
| `attach_managed_ready_task_binding` | 6613 | post-`admit_attempt_with_delegation` binding attach | attached lease |
| `resolve_attached_pre_admission_lease_proof` | 6695 | re-validate the attached lease (`purpose == AttachedAttempt`) | replay/settlement |
| `resolve_reserved_managed_worktree_target` | 5352 | exact reserved worktree target, never a search | A/B target |

Hard invariants enforced by P8 (all currently tested in the lib target):

- Stage-A pins **must omit** `context_selection_digest`
  (`"Stage-A pins must omit ContextSelection"`).
- Stage-B requires the same **unclaimed `RESERVED`** lease: no cancellation, no
  `unknown_effect`, no `process_identity`, no existing
  `delegation_bindings` entry; the lease must not be expired
  (`"pre-admission reservation expired before ContextSelection bind"`).
- Stage-B refuses a *different* ContextSelection than a previously bound one
  (`"ContextSelection is already bound differently"`).
- `pins.owner_epoch()` must equal the pool's resumed epoch, else
  `StaleOwnerEpoch`.
- A candidate Attempt may hold only one Stage-A identity
  (`"candidate Attempt already has a different durable Stage-A identity"`).

## 4. The six pins P2 named — source of truth per pin

| Pin | Rust validation site (all in `host_kernel.rs`) | Authentic producer | Phase |
|---|---|---|---|
| `parentSessionID` | reserve + admit: must equal `run.session_link.session_id` and `link.owner_epoch == fence.owner_epoch()`; also `sessionID != parentSessionID` and `sessionID == managed_child_session_id(attempt_id)` | P2 Run coordinator's `SessionLink` (returned by `start_planned_run`) | P2 |
| `profileDefinition` | `validate_agent_profile_definition`, then Task immutable pin (`profile_id`/`revision`/`definition_digest`), profile owner binding (`ProfileOwnerBindingV1::from_authenticated_principal`), `permission_ceiling_digest`, and route equality | the pinned AgentProfileV2 for the Task (client re-reads it from trusted Config: `trustedManagedProfileDefinition`) | P2/Core + P1 guard ceiling |
| `contextSelection` | `validate_context_selection`: `attempt_id` matches, `request_sequence == 1`, exactly one `agent-profile` source equal to the profile (id/revision/digest/trust), `session_id` == child session; plus exactly one `managed-task` source and one `accepted-spec` source whose digests are re-derived from Rust-owned Task/Spec state | Core's `ContextSelectionV1` for the child session's first request | P2/Core (digest is minted by Rust: `context.digest()`) |
| `resourcePolicyProjectionRevision` / `…Digest` | reserve: compare-only against `resource_policy_pin_for_owner(&owner)`; admit: **exact equality**, else `resource_policy_stale`; missing pin → `resource_policy_unavailable` | `resource-policy.ingress-v1` / `project_policy` → `dispatch_resource_policy_projection` inserts `AuthenticatedResourcePolicyPinV1` | **P6 ingress content, P2 client call** (see §6) |
| `preAdmissionProofDigest` | Stage-A `proofDigest` at bind; Stage-B `receiptDigest` at admit (§2) | **P8** via the three operations | P8 (already wired) |
| `managedProviderRoute` | must equal `profile.selected_provider_model()` and `profile.harness_id()` exactly, else `managed_conflict` | Core's route projection (`managedRouteProjection`) | P2/Core |

## 5. What P1 must produce (exact interface for the parent → P1 handoff)

P1-owned code that `managed_admit` calls, in order:

1. `crate::guard::derive_effective_capability_ceiling(&AuthenticatedAttemptAdmissionProofV1, &AcceptedTaskCapabilityScopeFactsV1, &RegisteredAgentProfileProofV1) -> Result<EffectiveCapabilityCeilingProofV1, &'static str>` (`guard.rs:801`).
   Inputs it requires: a valid non-empty `attempt_id`, non-zero `owner_epoch`,
   matching `run_id`/`task_id`, a Task profile pin equal to the registered
   profile (`profile_id`, `revision`, `definition_digest`), the profile owner
   binding digest recorded on the accepted scope, and **strictly sorted**
   `capability_scope` and `required_capabilities` (`windows(2)` pairwise
   ascending check). It fails `task_profile_pin_missing` when the accepted
   scope carries no profile revision pin. Its output digest becomes
   `ManagedPreAdmissionTargetPinsV1.capability_ceiling_digest` (Stage A) and
   `ManagedDelegationAdmissionFactsV1.effective_ceiling`, and is later
   re-derived during replay and compared with the committed receipt
   (`"admission replay effective permission scope changed"`).
2. `crate::guard::workspace_binding(dev, ino)` and
   `crate::guard::location_principal_binding(subject)` — the OS-identity
   binding for the registered Location and workspace; a mismatch is
   `effect_denied`.
3. `crate::guard::derive_effective_permission_scope` digest —
   `protocol::managed_effective_permission_scope_digest_v1(...)` over attempt,
   owner epoch, run/task, accepted scope digest, profile id/revision/digest,
   profile owner-binding digest, permission-ceiling digest,
   `guard_policy_revision` and `capabilities`. This digest is persisted in the
   `DelegationBinding` and must be reproducible on replay.
4. `authenticated_core_peer_facts(fence)` / `authenticated_core_process_identity(fence)`
   — the authenticated peer PID + start identity + process incarnation that go
   into `RootCoordinatorRegistrationPinsV1::from_authenticated_core_peer`.

**P1 does not mint Stage-A/B digests and must not.** Stage A/B are P8 durable
transitions; P1 only supplies the Guard/peer facts that the pins bind.

## 6. Resource-policy projection: the actual next stop after the body is fixed

`resource_policy_pin_for_owner` (`host_kernel.rs:2506`) reads
`self.resource_policy_pins`, which is initialised **empty** (`:2235`) and
written in exactly one place: `dispatch_resource_policy_projection`
(`:4941`, insert at `:5027`), behind

```rust
if !self.resource_policy_enabled { return Err(("feature_not_negotiated", …, "resource-policy.ingress-v1 was not negotiated")) }
```

`resource_policy_enabled` defaults to `false` (`:2232`) and is set only from
the handshake in `kernel/src/bin/hz-kernel.rs:270`
(`resource_policy_negotiated`, feature advertised at `:203`). Negotiation
therefore depends on the **client's** hello offering
`resource-policy.ingress-v1`.

Evidence as of this writing:

- P2's new authenticated test fixture negotiates the optional feature and calls
  `project_policy`; the other managed fixture still offers only `effects.v2`.
- No production file in `packages/**` calls `project_policy`. The managed
  client sends the exact projection pin fields but does not yet invoke the
  projection operation.
- `FEATURE_RESOURCE_POLICY_INGRESS_V1` (`protocol.rs:143`) is referenced only
  by the binary and the gate; nothing else consumes it.

Consequence: production admission still stops at
`resource_policy_unavailable` until Core (a) offers
`resource-policy.ingress-v1` in the hello and (b) posts a valid
`project_policy` body — exactly 9 keys: `goalID`, `runID`, `taskID`,
`candidateAttemptID`, `parentSessionID`, `locationID`, `sessionID`,
`expectedRevision`, `projection` — for the same Rust-derived candidate. The
P2 test fixture now covers this protocol and verifies that unsupported rows
cannot widen admission; it is not production Core wiring. The projection rows
are the P6-owned *content*; P8 owns no policy content.

## 7. Call order a fixture must follow (verified against the source)

1. `plan_run` → `start_planned_run` (P2) so `run.session_link` exists, Task is
   `ready`, phase `RUNNING`, no active/pending Attempt.
2. negotiate `effects.v2` **and** `resource-policy.ingress-v1`, then
   `project_policy` for the exact candidate (§6).
3. `managed.pre_admission_target.reserve` → keep
   `preAdmissionProof.proofDigest`.
4. `admit` with `preAdmissionProofDigest` = Stage-B receipt digest. `admit`
   performs the Stage-B context bind itself when it is not already bound; it
   **requires Stage A to already exist** (`resolve_managed_pre_admission_target_for_candidate`,
   otherwise `managed_pre_admission_uncertain`), so `reserve` is mandatory.
   (`bind_context` is the separately exposed Stage-B operation used by the
   production client and returns early with `RESERVED_CONTEXT_BOUND`.)
5. `admit` then re-checks the aggregate CAS, appends
   `admit_attempt_with_delegation`, attaches the P8 binding and re-resolves the
   attached lease before returning `ADMITTED`.

## 8. Fixture evidence P8 owns, and its reachability

Both P8 composition helpers are `#[cfg(test)] pub(crate)` in
`kernel/src/worker_durable.rs`:

- `test_reserve_and_bind_managed_pre_admission(pins, context_selection_digest, owner, now_ms) -> (ManagedReadyTaskPinV1, DurableManagedLeaseProofV1)` (`:6409`)
  — runs the real Stage-A reserve, Stage-B bind and current lease resolution
  through a live OwnerLog; it never constructs a proof field.
- `test_reserve_authenticated_managed_pre_admission(root_pins, root_delivery_id, registration_delivery_id, registration_owner, create_intent, create_receipt, inspect_intent, inspect_receipt, canonical_worktree_path, parent_session_id, location_id, workspace_revision, pins, context_selection_digest, owner, now_ms, expires_at_ms) -> (RootCoordinatorExecutionProofV1, ResolvedManagedWorktreeV1, ManagedReadyTaskPinV1, DurableManagedLeaseProofV1)` (`:6437`)
  — additionally persists the authenticated root registration and the guarded
  Create+Inspect worktree registration first. The guarded intent/receipt pairs
  must be genuine (P1/P2-owned Guard facts); the helper cannot mint them.

**Reachability constraint:** because both are `#[cfg(test)]`+`pub(crate)`,
only the **library test target** (`cargo test --lib`) can call them.
`kernel/tests/*.rs` integration targets (where P2's managed fixtures live)
cannot see them, and must not: P2's fixtures should reach this journey through
the real RPC route (§7), which is already implemented. P8 therefore owns no
new cross-target fixture seam; the missing pieces are the client body, the
resource-policy ingress (§6), and P1's Guard inputs (§5).

## 9. Current status of the owning blockers (unchanged by this document)

- RC0 stays `NOT_ATTESTED` (`TRUSTED_ATTESTATION_SOURCES` is empty); this
  document adds no attestation source or measurement claim.
- Hard CPU/memory/process/FD quotas stay `UNSUPPORTED`; fan-out, pressure
  admission and cache retirement stay disabled.
- JC-RES-012.K/L authenticated ingress negatives stay OPEN (P1/P2/P6).
- P2's two managed-admission positives remain BLOCKED on §5/§6; the two
  in-crate `managed_control::managed_delegation_admission_tests` failures
  observed in the full lib run are P2-owned.
