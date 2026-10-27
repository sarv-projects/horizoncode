# HostRun Contract Implementation Plan

> **For agentic workers:** Implement through the existing whole-phase P2/P8 owners; parent owns authority edits and cross-phase review. No child may commit or publish.

**Goal:** Define the minimum canonical HostRun dispatch-binding and reconciliation contract, then align P2/P8 implementation without opening runtime or release gates.

**Architecture:** Reuse the existing P8 `host_run_dispatch_key` algorithm and P2 HostKernel/ManagedControl/OwnerLog owners. P8's frozen evaluator manifest/task/arm identity is checked before its durable mirror append; P2 binds only live authenticated managed state, and dispatch remains forbidden until both durable records and their exact post-commit receipt are resolved. Unknown, missing, conflicting, stale, or post-dispatch ambiguous state remains UNKNOWN/quarantined and is never redispatched.

**Tech Stack:** Rust HostKernel/ManagedControl and P8 worker journal; Python `scripts/eval/eval_harness.py`; JSON Schema Draft 2020-12; architecture validators and existing focused tests.

**Spec:** User authorization 2026-10-25; `arch_V1/17-GOVERNANCE-DECISIONS.md` §17.24; `arch_V1/12-DOMAIN-SCHEMAS.md` §§12.18–12.19; `arch_V1/37-RUNTIME-SERVICE-LLD.md` §§37.22/RC0; `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md` §§32.33/32.40; current HostRun source in `kernel/src/managed_control.rs`, `kernel/src/host_kernel.rs`, and `scripts/eval/eval_harness.py`.

## Global Constraints

- Reuse the existing P8 key: `sha256:` + lowercase SHA-256 of canonical JSON `{armId, lane:"HUP_PAIRED_HOST_RUN_V1", manifestDigest, taskId}`; then `dispatchKeyDigest` is BLAKE3 of the UTF-8 raw key. Do not change this derivation or persist the raw key.
- Derive Run/Task/Attempt, root Run SessionLink, authenticated Core process generation, owner epoch, worker execution, principal/workspace pins, and admitted revision from their canonical owners; caller identity fields are correlation only.
- `evaluationSessionId` means the root SessionLink pinned at Run start. The child Attempt Session remains distinct and is derived from the Attempt/DelegationBinding/P8 reservation; never substitute one for the other.
- The P8 mirror append must be checked against P8's frozen manifest/task/arm invocation and durable OwnerLog state. Caller-supplied OwnerLog IDs, sequence, event digest, binding digest, or cursor are not proof.
- `host_run.bind`, `host_run.bind_receipt`, and `host_run.inspect` remain private `managed.v1` operations; they do not create a public capability or dispatch path.
- `SUCCEEDED` requires complete managed terminal/effect settlement, independent verifier evidence for the exact final revision, final Guarded Inspect, P1 projection, and P8 committed settlement receipt. Anything incomplete or ambiguous is UNKNOWN; UNKNOWN is never retry/replay authority.
- Preserve `RC0=NOT_ATTESTED`, quotas `UNSUPPORTED`, all capability/readiness/release gates closed, and LM-018 `NOT_RUN`. No provider/effect/candidate/install/publication activity.
- Keep all changes unstaged; do not commit, push, reset, clean, or remove user-owned state.

## Review Focus

- A forged manifest/task/arm or key tuple must not bind another evaluation: P2 recomputation plus P8 frozen-invocation validation.
- Root SessionLink and child Attempt Session substitution must be rejected.
- P8 post-commit receipt replay must be exact-idempotent; changed binding/cursor conflicts without mutation.
- Missing P1 projection, verifier evidence, final Inspect, or P8 settlement must remain UNKNOWN and never dispatch again.
- HostRun terminal status must not promote RC0 or release resources without exact independently verified evidence.

---

### Task 1: Freeze authority and machine contract

**Files:**
- Modify: `arch_V1/17-GOVERNANCE-DECISIONS.md`
- Modify: `arch_V1/12-DOMAIN-SCHEMAS.md`
- Create: `arch_V1/contracts-v2/host-run-dispatch-v1.schema.json`
- Modify: `arch_V1/37-RUNTIME-SERVICE-LLD.md`
- Modify: `arch_V1/32-TASK-BASED-AGENT-TEST-CATALOG.md`

- [ ] Add a narrow decision assigning P8's frozen invocation check, P2's authenticated HostKernel binding/inspect, and P1's terminal effect projection; define exact idempotency derivation by reference to the existing evaluator source algorithm.
- [ ] Define strict v1 bind, receipt, inspect request/response, binding, P8 committed mirror receipt, UNKNOWN/terminal states, root-vs-child Session semantics, and private operation ownership in the canonical schema and §12.
- [ ] Define ordering: bind managed identity; validate and append exact P8 mirror event; persist/verify the P8 post-commit receipt; only then may a future evaluator bridge enter dispatch. A cursor supplied by Core is never evidence unless re-resolved against P8 durable state.
- [ ] Add positive, substitution, replay/conflict, missing-projection, cancellation/restart/UNKNOWN, and no-redispatch acceptance rows in §32. Keep these rows NOT RUN until implementation evidence exists.
- [ ] Run JSON/schema fixtures and architecture Markdown/convergence validators; record exact outcomes without changing runtime gates.

### Task 2: Implement P2 HostKernel contract test-first

**Files:**
- Modify: `kernel/src/managed_control.rs`, `kernel/src/host_kernel.rs` and their owning test modules only as needed.
- Modify: `packages/opencode/src/session/managed-control.ts` and its tests only if the canonical wire contract requires alignment.

- [ ] Validate canonical dispatch-key digest from the frozen manifest digest, task ID, arm ID, and fixed lane using the specified existing algorithm.
- [ ] Keep all managed identity and process/workspace/owner pins host-derived; bind only the root SessionLink as `evaluationSessionId` while preserving the child Attempt Session separately.
- [ ] Verify the P8 mirror event/receipt against P8's durable owner before recording the P8 receipt; reject fabricated, stale, substituted, changed, or uncommitted cursors without mutation.
- [ ] Add real authenticated HostKernel socket tests for positive bind/receipt/inspect and malformed, cross-Run/Task/Attempt, key substitution, root/child Session, conflicting replay, lost-response/restart, no-projection UNKNOWN, and no-redispatch behavior.
- [ ] Run focused Rust targets only after the parent grants the sole Cargo slot; preserve current fail-closed readiness.

### Task 3: Implement P8 evaluator mirror and recovery contract test-first

**Files:**
- Modify: P8-owned Rust worker journal and its tests, plus `scripts/eval/eval_harness.py` and evaluator tests only where needed.

- [ ] Validate the exact P8 frozen manifest/task/arm/group and key against the invocation before appending `HostRunDispatchBoundV1`.
- [ ] Return the durable OwnerLog cursor/event digest from the append itself; never accept a caller-constructed cursor as evidence.
- [ ] Reconcile bind, mirror append, post-commit receipt, and lost acknowledgement from their stable delivery identities after restart; any post-possible-dispatch ambiguity is UNKNOWN and cannot be replayed.
- [ ] Add durable positive, exact replay, changed-payload conflict, foreign invocation, crash-window, terminal verifier/Inspect/settlement, and no-redispatch tests.
- [ ] Run Python suites offline. Rust tests require the parent-owned Cargo slot. Keep RC0 NOT_ATTESTED and all quotas unsupported.

### Task 4: Parent cross-owner acceptance and status

**Files:**
- Modify: `reports/phases/P2.md`, `reports/phases/P8.md`, `reports/phases/P1.md`, `reports/phases/LEDGER.md` only after owners return evidence.

- [ ] Review exact P2/P8 diffs and their source-backed test results; do not treat schema/docs, isolated mocks, or one phase assertion as integrated proof.
- [ ] Run authenticated P2↔P8 bind/mirror/receipt/inspect integration with P1 terminal projection and denied/recovery cases on the exact revision.
- [ ] Keep routes and all product gates closed unless the full integrated Guard, lease, receipt, verifier, final-Inspect, UNKNOWN/restart and no-redispatch acceptance passes.
- [ ] Re-run structural Markdown/convergence checks after all authority/report edits settle. Do not start Phase 10/11 or claim RC0 evidence from this contract alone.
