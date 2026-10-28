"""`PreAdmissionReserved` lease-proof fixture generator (P2 item-25 blocker).

Why this exists
---------------
P2's managed admission reducer (`durable_lease_proof_matches_attempt`,
kernel/src/managed_control.rs:2435) accepts only a lease proof whose purpose is
``PreAdmissionReserved`` with complete ``pre_admission_pins``; the existing
in-crate ``DurableManagedLeaseProofV1::test_fixture`` mints ``LegacyAdmitted``.
P2 holds Cargo and owns the Rust constructor; this module is the Python/data
half: it emits the exact proof-record JSON shape P2's Rust reducer tests
deserialize, with the candidate tuple and the Stage-A -> Stage-B digest chain
**derived** from validated inputs.

Derivation law (same as the HostRun minter)
--------------------------------------------
Never caller-choose: ``candidateAttemptID`` (BLAKE3 over the canonical
``horizoncode.managed-task-attempt-candidate.v1`` preimage), ``childSessionID``
(``ses_managed_<attempt>``), the ticket/worker/budget lease identities (derived
from the canonical pins digest exactly like Rust ``pre_admission_ids`` /
``worker-reservation-``), ``purpose``, ``workerState``, ``pinsDigest`` and the
whole digest chain. Caller claims for any of these are cross-checked and
rejected. The manifest supplies provenance only; managed identity comes from
the pins block.

Digest byte layouts are transcribed from ``kernel/src/worker_durable.rs``
(``TrustedPreAdmissionPinsV1::compute_digest``,
``ReservedPreAdmissionTargetProofV1::new``, ``ReservedWorkerLeaseProofV1::
proof_digest`` / ``context_bound_receipt_digest``, ``managed_task_attempt_
candidate_id``). BLAKE3 comes from the cross-validated pure-Python ``blake3``
helper. **These digests are a Python reimplementation**: P2's Rust test must
recompute them with the canonical Rust code and compare; any mismatch is a P8
defect to route back, never something to weaken.

This module grants no authority: the record is fixture *data* for P2's
reducer tests. It does not attest, admit, reserve, dispatch, or touch Cargo.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import unicodedata
from pathlib import Path

import blake3
import eval_harness

FIXTURE_SCHEMA = "horizoncode.tests.pre-admission-reserved-proof.v1"
INPUT_SCHEMA = "horizoncode.eval.pre-admission-fixture-input.v1"
PURPOSE = "PreAdmissionReserved"
FIXTURE_FILENAME_PREFIX = "pre-admission-reserved-"
MAX_WORKER_LEASE_MS = 24 * 60 * 60 * 1000  # worker_pool.rs MAX_WORKER_LEASE_MS

BLAKE3_PATTERN = re.compile(r"blake3:[0-9a-f]{64}")
SHA256_PATTERN = re.compile(r"sha256:[0-9a-f]{64}")
DECIMAL_PATTERN = re.compile(r"(?:0|[1-9][0-9]*)")
MAX_U64 = (1 << 64) - 1
MAX_TOKEN_BYTES = 256  # worker_durable.rs validate_owner_token

# Exact JSON field sets (documented to P2 in reports/phases/P8.md).
LEASE_PROOF_FIELDS = (
    "purpose", "facts", "preAdmissionPins", "admissionPins", "delegation",
    "ownerLogId", "workerPoolRevision", "ownerLogSequence", "ownerLogEventDigest",
)
LEASE_FACTS_FIELDS = (
    "workerExecutionId", "goalId", "ticketId", "principalRef", "workspaceBinding",
    "sessionId", "runId", "taskId", "attemptId", "ownerEpoch", "sourceRevision",
    "acceptedSpecDigest", "workspaceLeaseId", "budgetLeaseId", "resourceLeaseIds",
    "workerState", "budgetDimension", "reservedAmount", "expiresAtMs",
    "processIdentity",
)
PINS_FIELDS = (
    "owner", "goalId", "taskRevision", "taskAttemptCount", "candidateGeneration",
    "acceptedSpecDigest", "workspaceRevision", "locationId", "processIncarnation",
    "profileId", "profileRevision", "profileDigest", "profilePermissionCeilingDigest",
    "contextSelectionDigest", "acceptedScopeDigest", "capabilityCeilingDigest",
    "specMaxWorkers", "resourcePolicyRevision", "resourcePolicyDigest",
    "resourceActiveWorkerLimit", "dimension", "amount", "expiresAtMs", "worktree",
    "worktreePoolRevision", "idempotencyKey", "parentProof", "stagedPreAdmission",
    "pinsDigest",
)
RESERVATION_FIELDS = (
    "attemptId", "workerExecutionId", "ticketId", "budgetLeaseId",
    "workspaceLeaseId", "resourceLeaseIds", "pinsDigest", "contextSelectionDigest",
    "bindingDigest", "ownerLogId", "ownerLogSequence", "ownerLogEventDigest",
    "workerPoolRevision",
)
OWNER_FIELDS = (
    "principalRef", "workspaceBinding", "sessionId", "attemptId", "runId",
    "taskId", "ownerEpoch",
)
RECORD_FIELDS = (
    "schema", "purpose", "stage", "provenance", "derived", "digestChain",
    "stageAReservation", "stageBReservation", "leaseProof",
)

# Input pins: base authenticated facts only. Derived fields (dimension, amount,
# stagedPreAdmission, pinsDigest, contextSelectionDigest) are never accepted
# from the caller.
INPUT_PIN_FIELDS = (
    "goalId", "taskRevision", "taskAttemptCount", "candidateGeneration",
    "acceptedSpecDigest", "workspaceRevision", "locationId", "processIncarnation",
    "profileId", "profileRevision", "profileDigest", "profilePermissionCeilingDigest",
    "acceptedScopeDigest", "capabilityCeilingDigest", "specMaxWorkers",
    "resourcePolicyRevision", "resourcePolicyDigest", "resourceActiveWorkerLimit",
    "expiresAtMs", "worktree", "worktreePoolRevision", "idempotencyKey",
    "owner", "parentProof",
)
INPUT_TOP_FIELDS = ("schema", "manifest", "taskId", "nowMs", "pins",
                    "contextSelectionDigest", "workspaceLeaseId", "ownerLog")
INPUT_CLAIM_FIELDS = ("purpose", "candidateAttemptID", "childSessionID",
                      "pinsDigest", "stageAProofDigest", "stageBReceiptDigest")


class PreAdmissionFixtureError(ValueError):
    """A fixture input was invalid; no record is produced."""


# --- byte helpers (exact Rust layouts) ---------------------------------------

def _lp(value: str) -> bytes:
    encoded = value.encode("utf-8")
    return len(encoded).to_bytes(8, "big") + encoded


def _u64(value: int) -> bytes:
    return int(value).to_bytes(8, "big")


def _u32(value: int) -> bytes:
    return int(value).to_bytes(4, "big")


def _token(value, field: str) -> str:
    """Exact parity with Rust `validate_owner_token` (Cc controls, 256 bytes)."""
    if not isinstance(value, str) or not value:
        raise PreAdmissionFixtureError(f"{field} must be a non-empty string")
    encoded = value.encode("utf-8")
    if len(encoded) > MAX_TOKEN_BYTES:
        raise PreAdmissionFixtureError(f"{field} exceeds {MAX_TOKEN_BYTES} bytes")
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise PreAdmissionFixtureError(f"{field} contains a control character")
    return value


def _blake3(value, field: str) -> str:
    if not isinstance(value, str) or BLAKE3_PATTERN.fullmatch(value) is None:
        raise PreAdmissionFixtureError(f"{field} must be a blake3 digest")
    return value


def _sha256(value, field: str) -> str:
    if not isinstance(value, str) or SHA256_PATTERN.fullmatch(value) is None:
        raise PreAdmissionFixtureError(f"{field} must be a sha256 digest")
    return value


def _messagepack_string(value: str) -> bytes:
    encoded = value.encode("utf-8")
    length = len(encoded)
    if length <= 31:
        header = bytes((0xA0 | length,))
    elif length <= 0xFF:
        header = b"\xd9" + bytes((length,))
    elif length <= 0xFFFF:
        header = b"\xda" + length.to_bytes(2, "big")
    elif length <= 0xFFFFFFFF:
        header = b"\xdb" + length.to_bytes(4, "big")
    else:
        raise PreAdmissionFixtureError("MessagePack string exceeds u32 length")
    return header + encoded


def _messagepack_value(value) -> bytes:
    """Encode the exact MessagePack subset used by Guard's digest maps."""
    if isinstance(value, str):
        return _messagepack_string(value)
    if type(value) is int:
        if value < 0 or value > MAX_U64:
            raise PreAdmissionFixtureError("MessagePack integer is outside u64")
        if value <= 0x7F:
            return bytes((value,))
        if value <= 0xFF:
            return b"\xcc" + bytes((value,))
        if value <= 0xFFFF:
            return b"\xcd" + value.to_bytes(2, "big")
        if value <= 0xFFFFFFFF:
            return b"\xce" + value.to_bytes(4, "big")
        return b"\xcf" + value.to_bytes(8, "big")
    if isinstance(value, list):
        length = len(value)
        if length <= 15:
            header = bytes((0x90 | length,))
        elif length <= 0xFFFF:
            header = b"\xdc" + length.to_bytes(2, "big")
        elif length <= 0xFFFFFFFF:
            header = b"\xdd" + length.to_bytes(4, "big")
        else:
            raise PreAdmissionFixtureError("MessagePack array exceeds u32 length")
        return header + b"".join(_messagepack_value(item) for item in value)
    if isinstance(value, dict):
        if any(not isinstance(key, str) for key in value):
            raise PreAdmissionFixtureError("MessagePack map keys must be strings")
        pairs = sorted(value.items())  # Rust BTreeMap canonical key order.
        length = len(pairs)
        if length <= 15:
            header = bytes((0x80 | length,))
        elif length <= 0xFFFF:
            header = b"\xde" + length.to_bytes(2, "big")
        elif length <= 0xFFFFFFFF:
            header = b"\xdf" + length.to_bytes(4, "big")
        else:
            raise PreAdmissionFixtureError("MessagePack map exceeds u32 length")
        return header + b"".join(
            _messagepack_string(key) + _messagepack_value(item)
            for key, item in pairs)
    raise PreAdmissionFixtureError("unsupported value in Guard MessagePack digest")


def _guard_component_digest(values: tuple[bytes, ...]) -> str:
    preimage = b"".join(_u64(len(value)) + value for value in values)
    return "blake3:" + blake3.blake3(preimage).hex()


def _current_guard_policy_revision() -> str:
    """Exact transcription of guard.rs current_capability_policy_revision()."""
    policy = {
        "capabilities": [
            "builtin.verifier", "debug.attach", "debug.evaluate", "debug.start",
            "debug.stop", "language.start", "language.stop", "repl.execute",
            "repl.reset", "repl.start", "repl.stop",
        ],
        "brokerPolicy": _guard_component_digest((
            b"horizoncode.guard.broker-process.local.v1:ask;configured-executable;"
            b"bounded-argv-env;beneath-root;one-use",)),
        "readPolicy": _guard_component_digest((
            b"horizoncode.guard.workspace-read.local.v1:allow;beneath-root;"
            b"no-symlink;generation-pinned",)),
        "writePolicy": _guard_component_digest((
            b"horizoncode.guard.workspace-write.local.v1:ask;beneath-root;"
            b"no-symlink;no-hardlink;one-use",)),
        "schemaVersion": 1,
    }
    preimage = (b"horizoncode.guard-effective-capability-policy.v1\0"
                + _messagepack_value(policy))
    return "blake3:" + blake3.blake3(preimage).hex()


def _effective_capability_ceiling_digest(pins: dict) -> str:
    """Mirror guard.rs's 13-field effective ceiling MessagePack digest."""
    owner = pins["owner"]
    builtin_owner_digest = (
        "blake3:" + blake3.blake3(
            b"horizoncode.agent-profile-owner.builtin.v1\0").hex())
    value = {
        "acceptedScopeDigest": pins["acceptedScopeDigest"],
        "attemptID": owner["attemptId"],
        "capabilities": [],
        "guardPolicyRevision": _current_guard_policy_revision(),
        "ownerEpoch": str(owner["ownerEpoch"]),
        "profileDigest": pins["profileDigest"],
        "profileID": pins["profileId"],
        "profileOwnerBindingDigest": builtin_owner_digest,
        "profilePermissionDigest": pins["profilePermissionCeilingDigest"],
        "profileRevision": str(pins["profileRevision"]),
        "runID": owner["runId"],
        "schemaVersion": 1,
        "taskID": owner["taskId"],
    }
    preimage = (b"horizoncode.effective-capability-ceiling.v1\0"
                + _messagepack_value(value))
    return "sha256:" + hashlib.sha256(preimage).hexdigest()


def effective_capability_ceiling_digest(pins: dict) -> str:
    """P2's Guard-derived capability ceiling for one pin set.

    Public entry point for the same classifier the fixture builder uses, so a
    regression can recompute a durable fixture's ceiling instead of trusting it.
    """
    return _effective_capability_ceiling_digest(pins)


def _uint(value, field: str, *, minimum: int = 0) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < minimum:
        raise PreAdmissionFixtureError(
            f"{field} must be an integer >= {minimum}, got {value!r}")
    if value > MAX_U64:
        raise PreAdmissionFixtureError(f"{field} exceeds the u64 range")
    return value


def _sequence(value, field: str) -> str:
    if (not isinstance(value, str) or len(value) > 20
            or DECIMAL_PATTERN.fullmatch(value) is None
            or int(value) == 0 or int(value) > MAX_U64):
        raise PreAdmissionFixtureError(
            f"{field} must be a canonical positive decimal u64 string")
    return value


def _require_fields(obj, fields, what: str) -> dict:
    if not isinstance(obj, dict):
        raise PreAdmissionFixtureError(f"{what} must be an object")
    missing = [name for name in fields if name not in obj]
    if missing:
        raise PreAdmissionFixtureError(f"missing {what} field(s): {missing}")
    return obj


def _require_exact(obj, fields, what: str) -> dict:
    _require_fields(obj, fields, what)
    unknown = sorted(set(obj) - set(fields))
    if unknown:
        raise PreAdmissionFixtureError(f"unknown {what} field(s): {unknown}")
    return obj


# --- derivation (never caller-chosen) ----------------------------------------

def candidate_attempt_id(task_id: str, attempt_count: int, generation: int) -> str:
    """Rust `managed_task_attempt_candidate_id` (worker_durable.rs:782)."""
    data = bytearray(b"horizoncode.managed-task-attempt-candidate.v1\0")
    data += _lp(task_id)
    data += _u64(attempt_count) + _u64(generation)
    return "attempt_" + blake3.blake3(bytes(data)).hex()


def child_session_id(attempt_id: str) -> str:
    """Rust `managed_child_session_id` (host_kernel.rs:38511)."""
    if not re.fullmatch(r"attempt_[0-9a-f]{64}", attempt_id):
        raise PreAdmissionFixtureError(
            "candidate Attempt ID must be attempt_<64 lowercase hex>")
    return f"ses_managed_{attempt_id}"


def pre_admission_ids(pins_digest: str) -> tuple[str, str, str]:
    """Rust `pre_admission_ids`: (ticket, worker execution, delivery)."""
    suffix = pins_digest.removeprefix("blake3:")
    return (f"worker-ticket-{suffix}", f"worker-execution-{suffix}",
            f"worker-pre-admission-{suffix}")


def budget_lease_id(worker_execution_id: str) -> str:
    """Rust `reserved_worker_proof_at`: worker-reservation-<worker execution>."""
    return f"worker-reservation-{worker_execution_id}"


# --- digest chain (byte-exact Rust layouts) ----------------------------------

def compute_pins_digest(pins: dict) -> str:
    """`TrustedPreAdmissionPinsV1::compute_digest` for staged pre-admission.

    The staged domain is used and the ContextSelection digest is excluded
    (staged pins keep the same digest from Stage A through Stage B), exactly
    like `staged_pre_admission == true` in Rust.
    """
    owner = pins["owner"]
    execution = pins["parentProof"]["execution"]
    data = bytearray(b"horizoncode.trusted-pre-admission-pins.staged.v1\0")
    for value in (
        owner["principalRef"], owner["workspaceBinding"], owner["sessionId"],
        owner["runId"], owner["taskId"], owner["attemptId"],
        pins["goalId"], pins["taskRevision"], pins["acceptedSpecDigest"],
        pins["workspaceRevision"], pins["locationId"], pins["processIncarnation"],
        pins["profileId"], pins["profileDigest"],
        pins["profilePermissionCeilingDigest"],
    ):
        data += _lp(value)
    # staged == true: contextSelectionDigest deliberately not included.
    for value in (
        pins["acceptedScopeDigest"], pins["capabilityCeilingDigest"],
        pins["worktree"]["worktreeId"], pins["worktree"]["baseRevision"],
        pins["idempotencyKey"],
    ):
        data += _lp(value)
    data += _u64(owner["ownerEpoch"])
    data += _u64(pins["taskAttemptCount"])
    data += _u64(pins["candidateGeneration"])
    data += _u64(pins["profileRevision"])
    data += _u64(pins["specMaxWorkers"])
    revision = pins["resourcePolicyRevision"]
    if revision != 0:
        data += _u64(revision)
        data += _lp(pins["resourcePolicyDigest"])
        limit = pins["resourceActiveWorkerLimit"]
        if limit is None:
            data += b"\x00"
        else:
            data += b"\x01" + _u64(limit)
    data += _u64(pins["worktreePoolRevision"])
    data += _u64(pins["amount"])
    data += _u64(pins["expiresAtMs"])
    data += bytes([7])  # BudgetDimension::ActiveWorkers == 7
    proof = pins["parentProof"]
    if proof["kind"] != "RootCoordinator":
        raise PreAdmissionFixtureError(
            "parentProof.kind must be RootCoordinator for this fixture")
    data += b"\x01"
    for value in (
        execution["workerExecutionId"], execution["goalId"], execution["runId"],
        execution["principalRef"], execution["workspaceBinding"],
        execution["sessionId"], execution["locationId"],
        execution["processIncarnation"], execution["sourceRevision"],
        execution["acceptedSpecDigest"], proof["ownerLogId"],
        proof["ownerLogSequence"], proof["ownerLogEventDigest"],
    ):
        data += _lp(value)
    data += _u64(execution["ownerEpoch"])
    data += _u64(proof["workerPoolRevision"])
    data += _u64(execution["expiresAtMs"])
    data += _u32(execution["processIdentity"]["pid"])
    data += _u64(execution["processIdentity"]["startIdentity"])
    return "blake3:" + blake3.blake3(bytes(data)).hex()


def stage_a_proof_digest_inputs(stage_a: dict) -> list[str]:
    """Inputs of `ReservedPreAdmissionTargetProofV1::new` (in order)."""
    return [stage_a["pinsDigest"], stage_a["workerExecutionId"],
            stage_a["ticketId"], stage_a["workspaceLeaseId"]]


def stage_a_proof_digest(pins_digest: str, worker_execution_id: str,
                         ticket_id: str, workspace_lease_id: str) -> str:
    """Rust `ReservedPreAdmissionTargetProofV1::new` proof digest (Stage A)."""
    data = bytearray(b"horizoncode.pre-admission-target-proof.v1\0")
    for value in (pins_digest, worker_execution_id, ticket_id, workspace_lease_id):
        data += _lp(value)
    return "blake3:" + blake3.blake3(bytes(data)).hex()


def _reservation_values(reservation: dict, *, with_context: bool) -> list[str]:
    values = [
        reservation["attemptId"], reservation["workerExecutionId"],
        reservation["ticketId"], reservation["budgetLeaseId"],
        reservation["workspaceLeaseId"], reservation["pinsDigest"],
    ]
    if with_context:
        context = reservation["contextSelectionDigest"]
        if context is None:
            raise PreAdmissionFixtureError(
                "Stage-B reservation requires a ContextSelection digest")
        values.append(context)
    else:
        if reservation["contextSelectionDigest"] is not None:
            raise PreAdmissionFixtureError(
                "Stage-A reservation must not carry a ContextSelection digest")
    return values


def lease_proof_digest(reservation: dict) -> str:
    """Rust `ReservedWorkerLeaseProofV1::proof_digest` (cursor-bound)."""
    data = bytearray(b"horizoncode.reserved-worker-lease-proof.v1\0")
    values = [
        reservation["attemptId"], reservation["workerExecutionId"],
        reservation["ticketId"], reservation["budgetLeaseId"],
        reservation["workspaceLeaseId"], reservation["pinsDigest"],
        reservation["ownerLogId"], reservation["ownerLogSequence"],
        reservation["ownerLogEventDigest"],
    ]
    if reservation["contextSelectionDigest"] is not None:
        values.append(reservation["contextSelectionDigest"])
    values.extend(reservation["resourceLeaseIds"])
    for value in values:
        data += _lp(value)
    data += _u64(reservation["workerPoolRevision"])
    return "blake3:" + blake3.blake3(bytes(data)).hex()


def context_bound_receipt_digest(reservation: dict) -> str:
    """Rust `ReservedWorkerLeaseProofV1::context_bound_receipt_digest` (Stage B)."""
    data = bytearray(b"horizoncode.pre-admission-context-bound-receipt.v1\0")
    values = _reservation_values(reservation, with_context=True)
    values.extend(reservation["resourceLeaseIds"])
    for value in values:
        data += _lp(value)
    return "blake3:" + blake3.blake3(bytes(data)).hex()


# --- input validation --------------------------------------------------------

def _validate_owner(owner: dict) -> dict:
    _require_fields(owner, OWNER_FIELDS, "pins.owner")
    _token(owner["principalRef"], "owner.principalRef")
    _token(owner["workspaceBinding"], "owner.workspaceBinding")
    _token(owner["sessionId"], "owner.sessionId")
    _token(owner["attemptId"], "owner.attemptId")
    _token(owner["runId"], "owner.runId")
    _token(owner["taskId"], "owner.taskId")
    _uint(owner["ownerEpoch"], "owner.ownerEpoch", minimum=1)
    return owner


def _validate_parent_proof(proof: dict, *, goal_id: str, owner: dict,
                           pins: dict) -> dict:
    _require_fields(proof, ("kind", "execution", "ownerLogId", "ownerLogSequence",
                            "ownerLogEventDigest", "workerPoolRevision"),
                    "pins.parentProof")
    if proof["kind"] != "RootCoordinator":
        raise PreAdmissionFixtureError(
            "parentProof.kind must be RootCoordinator for this fixture")
    execution = _require_fields(
        proof["execution"],
        ("workerExecutionId", "goalId", "runId", "principalRef",
         "workspaceBinding", "sessionId", "locationId", "ownerEpoch",
         "processIncarnation", "processIdentity", "sourceRevision",
         "acceptedSpecDigest", "expiresAtMs"),
        "parentProof.execution")
    identity = _require_fields(execution["processIdentity"], ("pid", "startIdentity"),
                               "parentProof.execution.processIdentity")
    _uint(identity["pid"], "processIdentity.pid", minimum=1)
    _uint(identity["startIdentity"], "processIdentity.startIdentity", minimum=1)
    for field in ("workerExecutionId", "goalId", "runId", "principalRef",
                  "workspaceBinding", "sessionId", "locationId",
                  "processIncarnation", "sourceRevision", "acceptedSpecDigest"):
        _token(execution[field], f"parentProof.execution.{field}")
    _uint(execution["ownerEpoch"], "parentProof.execution.ownerEpoch", minimum=1)
    _uint(execution["expiresAtMs"], "parentProof.execution.expiresAtMs", minimum=1)
    _blake3(execution["acceptedSpecDigest"],
            "parentProof.execution.acceptedSpecDigest")
    _token(proof["ownerLogId"], "parentProof.ownerLogId")
    _sequence(proof["ownerLogSequence"], "parentProof.ownerLogSequence")
    _blake3(proof["ownerLogEventDigest"], "parentProof.ownerLogEventDigest")
    _uint(proof["workerPoolRevision"], "parentProof.workerPoolRevision", minimum=1)
    # The root coordinator proof must agree with the managed Run/owner facts.
    if execution["goalId"] != goal_id:
        raise PreAdmissionFixtureError(
            "parentProof.execution.goalId must equal pins.goalId")
    if execution["runId"] != owner["runId"]:
        raise PreAdmissionFixtureError(
            "parentProof.execution.runId must equal owner.runId")
    if execution["locationId"] != pins["locationId"]:
        raise PreAdmissionFixtureError(
            "parentProof.execution.locationId must equal pins.locationId")
    if execution["workspaceBinding"] != owner["workspaceBinding"]:
        raise PreAdmissionFixtureError(
            "parentProof.execution.workspaceBinding must equal owner.workspaceBinding")
    if execution["ownerEpoch"] != owner["ownerEpoch"]:
        raise PreAdmissionFixtureError(
            "parentProof.execution.ownerEpoch must equal owner.ownerEpoch")
    return proof


def _validate_input_pins(pins: dict) -> dict:
    _require_exact(pins, INPUT_PIN_FIELDS, "pins")
    _token(pins["goalId"], "pins.goalId")
    _token(pins["taskRevision"], "pins.taskRevision")
    _uint(pins["taskAttemptCount"], "pins.taskAttemptCount")
    _uint(pins["candidateGeneration"], "pins.candidateGeneration")
    _blake3(pins["acceptedSpecDigest"], "pins.acceptedSpecDigest")
    _token(pins["workspaceRevision"], "pins.workspaceRevision")
    _token(pins["locationId"], "pins.locationId")
    _token(pins["processIncarnation"], "pins.processIncarnation")
    _token(pins["profileId"], "pins.profileId")
    _uint(pins["profileRevision"], "pins.profileRevision", minimum=1)
    _blake3(pins["profileDigest"], "pins.profileDigest")
    _blake3(pins["profilePermissionCeilingDigest"],
            "pins.profilePermissionCeilingDigest")
    _blake3(pins["acceptedScopeDigest"], "pins.acceptedScopeDigest")
    _sha256(pins["capabilityCeilingDigest"], "pins.capabilityCeilingDigest")
    _uint(pins["specMaxWorkers"], "pins.specMaxWorkers", minimum=1)
    _uint(pins["resourcePolicyRevision"], "pins.resourcePolicyRevision")
    _uint(pins["expiresAtMs"], "pins.expiresAtMs", minimum=1)
    _uint(pins["worktreePoolRevision"], "pins.worktreePoolRevision", minimum=1)
    _token(pins["idempotencyKey"], "pins.idempotencyKey")
    if len(pins["idempotencyKey"].encode("utf-8")) > 256:
        raise PreAdmissionFixtureError("pins.idempotencyKey exceeds 256 bytes")
    _require_exact(pins["worktree"], ("worktreeId", "baseRevision"), "pins.worktree")
    _token(pins["worktree"]["worktreeId"], "pins.worktree.worktreeId")
    _token(pins["worktree"]["baseRevision"], "pins.worktree.baseRevision")
    revision = pins["resourcePolicyRevision"]
    limit = pins["resourceActiveWorkerLimit"]
    if revision == 0:
        if pins["resourcePolicyDigest"] not in ("", None) or limit is not None:
            raise PreAdmissionFixtureError(
                "legacy pins (resourcePolicyRevision 0) carry no resource authority")
    else:
        if not isinstance(pins["resourcePolicyDigest"], str) or not pins["resourcePolicyDigest"]:
            raise PreAdmissionFixtureError("pins.resourcePolicyDigest is required")
        _blake3(pins["resourcePolicyDigest"], "pins.resourcePolicyDigest")
        if limit is not None:
            _uint(limit, "pins.resourceActiveWorkerLimit", minimum=1)
    owner = _validate_owner(pins["owner"])
    _validate_parent_proof(pins["parentProof"], goal_id=pins["goalId"],
                           owner=owner, pins=pins)
    return pins


def _validate_manifest_provenance(manifest, task_id: str) -> dict:
    if manifest is None:
        raise PreAdmissionFixtureError("manifest is required")
    # Let eval_harness.EvalError propagate: an invalid manifest is a typed
    # evaluator rejection, not a fixture-shape problem.
    eval_harness.validate_manifest(manifest)
    if not isinstance(task_id, str) or not any(
            task.get("taskId") == task_id for task in manifest["tasks"]):
        raise PreAdmissionFixtureError("taskId is not in the frozen manifest")
    return manifest


# --- builder -----------------------------------------------------------------

def build_pre_admission_reserved_fixture(inputs: dict) -> dict:
    """Build the `PreAdmissionReserved` proof record, or raise (no record).

    Every required input is validated first; every identity/digest in the
    output is derived. Caller `claims` are cross-checks that must equal the
    derived value — a mismatch produces no fixture.
    """
    if not isinstance(inputs, dict):
        raise PreAdmissionFixtureError("inputs must be an object")
    _require_fields(inputs, INPUT_TOP_FIELDS, "fixture input")
    unknown_inputs = sorted(set(inputs) - set(INPUT_TOP_FIELDS) - {"claims"})
    if unknown_inputs:
        raise PreAdmissionFixtureError(
            f"unknown fixture input field(s): {unknown_inputs}")
    if inputs["schema"] != INPUT_SCHEMA:
        raise PreAdmissionFixtureError(
            f"fixture input schema must be {INPUT_SCHEMA!r}")
    claims = inputs.get("claims") or {}
    _require_fields(claims, (), "claims")  # must be an object
    unknown_claims = sorted(set(claims) - set(INPUT_CLAIM_FIELDS))
    if unknown_claims:
        raise PreAdmissionFixtureError(f"unknown claims field(s): {unknown_claims}")
    if "purpose" in claims and claims["purpose"] != PURPOSE:
        raise PreAdmissionFixtureError(
            f"claims.purpose must be {PURPOSE!r}, got {claims['purpose']!r}")

    manifest = _validate_manifest_provenance(inputs["manifest"], inputs["taskId"])
    now_ms = _uint(inputs["nowMs"], "nowMs", minimum=1)
    context = _blake3(inputs["contextSelectionDigest"], "contextSelectionDigest")
    workspace_lease_id = _token(inputs["workspaceLeaseId"], "workspaceLeaseId")
    owner_log = _require_fields(
        inputs["ownerLog"],
        ("ownerLogId", "ownerLogSequence", "ownerLogEventDigest", "workerPoolRevision"),
        "ownerLog")
    _token(owner_log["ownerLogId"], "ownerLog.ownerLogId")
    _sequence(owner_log["ownerLogSequence"], "ownerLog.ownerLogSequence")
    _blake3(owner_log["ownerLogEventDigest"], "ownerLog.ownerLogEventDigest")
    _uint(owner_log["workerPoolRevision"], "ownerLog.workerPoolRevision", minimum=1)

    pins_in = _validate_input_pins(inputs["pins"])
    owner = pins_in["owner"]

    # Expiry window mirrors `resolve_pre_admission_lease_facts`: the lease must
    # be live now and never longer than MAX_WORKER_LEASE_MS.
    expires_at = pins_in["expiresAtMs"]
    if expires_at <= now_ms:
        raise PreAdmissionFixtureError("pins.expiresAtMs must be in the future")
    if expires_at - now_ms > MAX_WORKER_LEASE_MS:
        raise PreAdmissionFixtureError(
            "pins.expiresAtMs exceeds the 24h maximum worker lease window")

    # --- derived candidate tuple (never caller-chosen) ---
    attempt_id = candidate_attempt_id(owner["taskId"], pins_in["taskAttemptCount"],
                                      pins_in["candidateGeneration"])
    session_id = child_session_id(attempt_id)
    if owner["attemptId"] != attempt_id:
        raise PreAdmissionFixtureError(
            f"owner.attemptId must equal the derived candidate {attempt_id!r}")
    if owner["sessionId"] != session_id:
        raise PreAdmissionFixtureError(
            f"owner.sessionId must equal the derived child Session {session_id!r}")
    if claims.get("candidateAttemptID", attempt_id) != attempt_id:
        raise PreAdmissionFixtureError(
            "claims.candidateAttemptID differs from the derived candidate Attempt")
    if claims.get("childSessionID", session_id) != session_id:
        raise PreAdmissionFixtureError(
            "claims.childSessionID differs from the derived child Session")

    expected_ceiling_digest = _effective_capability_ceiling_digest(pins_in)
    if pins_in["capabilityCeilingDigest"] != expected_ceiling_digest:
        raise PreAdmissionFixtureError(
            "pins.capabilityCeilingDigest differs from the Guard-derived ceiling")

    # --- output pins record (derived fields fixed here) ---
    pins = {
        "owner": dict(owner),
        "goalId": pins_in["goalId"],
        "taskRevision": pins_in["taskRevision"],
        "taskAttemptCount": pins_in["taskAttemptCount"],
        "candidateGeneration": pins_in["candidateGeneration"],
        "acceptedSpecDigest": pins_in["acceptedSpecDigest"],
        "workspaceRevision": pins_in["workspaceRevision"],
        "locationId": pins_in["locationId"],
        "processIncarnation": pins_in["processIncarnation"],
        "profileId": pins_in["profileId"],
        "profileRevision": pins_in["profileRevision"],
        "profileDigest": pins_in["profileDigest"],
        "profilePermissionCeilingDigest": pins_in["profilePermissionCeilingDigest"],
        "contextSelectionDigest": context,
        "acceptedScopeDigest": pins_in["acceptedScopeDigest"],
        "capabilityCeilingDigest": pins_in["capabilityCeilingDigest"],
        "specMaxWorkers": pins_in["specMaxWorkers"],
        "resourcePolicyRevision": pins_in["resourcePolicyRevision"],
        "resourcePolicyDigest": pins_in["resourcePolicyDigest"],
        "resourceActiveWorkerLimit": pins_in["resourceActiveWorkerLimit"],
        "dimension": "ACTIVE_WORKERS",
        "amount": 1,
        "expiresAtMs": expires_at,
        "worktree": dict(pins_in["worktree"]),
        "worktreePoolRevision": pins_in["worktreePoolRevision"],
        "idempotencyKey": pins_in["idempotencyKey"],
        "parentProof": dict(pins_in["parentProof"]),
        "stagedPreAdmission": True,
        "pinsDigest": "",
    }
    pins["pinsDigest"] = compute_pins_digest(pins)
    if claims.get("pinsDigest", pins["pinsDigest"]) != pins["pinsDigest"]:
        raise PreAdmissionFixtureError(
            "claims.pinsDigest differs from the recomputed pins digest")

    ticket_id, worker_execution_id, _ = pre_admission_ids(pins["pinsDigest"])
    reservation_id = budget_lease_id(worker_execution_id)
    resource_lease_ids = [workspace_lease_id]

    def reservation(context_digest):
        return {
            "attemptId": attempt_id,
            "workerExecutionId": worker_execution_id,
            "ticketId": ticket_id,
            "budgetLeaseId": reservation_id,
            "workspaceLeaseId": workspace_lease_id,
            "resourceLeaseIds": list(resource_lease_ids),
            "pinsDigest": pins["pinsDigest"],
            "contextSelectionDigest": context_digest,
            "bindingDigest": None,
            "ownerLogId": owner_log["ownerLogId"],
            "ownerLogSequence": owner_log["ownerLogSequence"],
            "ownerLogEventDigest": owner_log["ownerLogEventDigest"],
            "workerPoolRevision": owner_log["workerPoolRevision"],
        }

    stage_a = reservation(None)
    stage_b = reservation(context)

    stage_a_proof = stage_a_proof_digest(
        pins["pinsDigest"], worker_execution_id, ticket_id, workspace_lease_id)
    if claims.get("stageAProofDigest", stage_a_proof) != stage_a_proof:
        raise PreAdmissionFixtureError(
            "claims.stageAProofDigest differs from the recomputed Stage-A proof digest")
    stage_b_receipt = context_bound_receipt_digest(stage_b)
    if claims.get("stageBReceiptDigest", stage_b_receipt) != stage_b_receipt:
        raise PreAdmissionFixtureError(
            "claims.stageBReceiptDigest differs from the recomputed Stage-B receipt digest")

    facts = {
        "workerExecutionId": worker_execution_id,
        "goalId": pins["goalId"],
        "ticketId": ticket_id,
        "principalRef": owner["principalRef"],
        "workspaceBinding": owner["workspaceBinding"],
        "sessionId": owner["sessionId"],
        "runId": owner["runId"],
        "taskId": owner["taskId"],
        "attemptId": owner["attemptId"],
        "ownerEpoch": owner["ownerEpoch"],
        "sourceRevision": pins["workspaceRevision"],
        "acceptedSpecDigest": pins["acceptedSpecDigest"],
        "workspaceLeaseId": workspace_lease_id,
        "budgetLeaseId": reservation_id,
        "resourceLeaseIds": list(resource_lease_ids),
        "workerState": "RESERVED",
        "budgetDimension": "ACTIVE_WORKERS",
        "reservedAmount": 1,
        "expiresAtMs": expires_at,
        "processIdentity": None,
    }

    lease_proof = {
        "purpose": PURPOSE,
        "facts": facts,
        "preAdmissionPins": pins,
        "admissionPins": None,
        "delegation": None,
        "ownerLogId": owner_log["ownerLogId"],
        "workerPoolRevision": owner_log["workerPoolRevision"],
        "ownerLogSequence": owner_log["ownerLogSequence"],
        "ownerLogEventDigest": owner_log["ownerLogEventDigest"],
    }

    record = {
        "schema": FIXTURE_SCHEMA,
        "purpose": PURPOSE,
        "stage": "RESERVED_CONTEXT_BOUND",
        "provenance": {
            "manifestDigest": eval_harness.host_run_manifest_digest(manifest),
            "manifestRunId": manifest["runId"],
            "lane": manifest["lane"],
            "taskId": inputs["taskId"],
        },
        "derived": {
            "candidateAttemptID": attempt_id,
            "childSessionID": session_id,
            "ticketID": ticket_id,
            "workerExecutionID": worker_execution_id,
            "budgetLeaseID": reservation_id,
        },
        "digestChain": {
            "pinsDigest": pins["pinsDigest"],
            "stageAProofDigest": stage_a_proof,
            "stageALeaseProofDigest": lease_proof_digest(stage_a),
            "contextSelectionDigest": context,
            "stageBReceiptDigest": stage_b_receipt,
        },
        "stageAReservation": stage_a,
        "stageBReservation": stage_b,
        "leaseProof": lease_proof,
    }
    return _require_exact(record, RECORD_FIELDS, "fixture record")


def canonical_input() -> dict:
    """Deterministic, public-safe base input (no authority, no real identity).

    The owner's session/attempt claims are pre-filled with the *derived*
    candidate tuple so the canonical input is valid; every negative test
    overrides exactly one claim to prove it cannot be caller-chosen.
    """
    now_ms = 1_790_000_000_000
    task_id = "task-preadm-fixture"
    attempt_count = 0
    generation = 0
    attempt = candidate_attempt_id(task_id, attempt_count, generation)
    session = child_session_id(attempt)
    inputs = {
        "schema": INPUT_SCHEMA,
        "manifest": eval_harness.selfcheck_manifest(),
        "taskId": "fixture-1",
        "nowMs": now_ms,
        "contextSelectionDigest": "blake3:" + "cd" * 32,
        "workspaceLeaseId": "worktree-lease-fixture",
        "ownerLog": {
            "ownerLogId": "worker-pool-fixture",
            "ownerLogSequence": "42",
            "ownerLogEventDigest": "blake3:" + "ef" * 32,
            "workerPoolRevision": 3,
        },
        "pins": {
            "goalId": "goal-preadm-fixture",
            "taskRevision": "task-rev-1",
            "taskAttemptCount": attempt_count,
            "candidateGeneration": generation,
            "acceptedSpecDigest": "blake3:" + "a1" * 32,
            "workspaceRevision": "rev-preadm-1",
            "locationId": "loc-preadm-fixture",
            "processIncarnation": "inc-preadm-fixture",
            "profileId": "profile.preadm",
            "profileRevision": 1,
            "profileDigest": "blake3:" + "b2" * 32,
            "profilePermissionCeilingDigest": "blake3:" + "b3" * 32,
            "acceptedScopeDigest": "blake3:" + "b4" * 32,
            "capabilityCeilingDigest": "",  # derived below from Guard inputs
            "specMaxWorkers": 4,
            "resourcePolicyRevision": 1,
            "resourcePolicyDigest": "blake3:" + "b6" * 32,
            "resourceActiveWorkerLimit": 4,
            "expiresAtMs": now_ms + 3_600_000,
            "worktree": {"worktreeId": "wt-preadm-fixture",
                         "baseRevision": "rev-preadm-1"},
            "worktreePoolRevision": 1,
            "idempotencyKey": "preadm-fixture-key-1",
            "owner": {
                "principalRef": "server_auth:fixture-principal",
                "workspaceBinding": "workspace-fixture",
                "sessionId": session,
                "attemptId": attempt,
                "runId": "run-preadm-fixture",
                "taskId": task_id,
                "ownerEpoch": 7,
            },
            "parentProof": {
                "kind": "RootCoordinator",
                "execution": {
                    "workerExecutionId": "worker-execution-root-fixture",
                    "goalId": "goal-preadm-fixture",
                    "runId": "run-preadm-fixture",
                    "principalRef": "server_auth:fixture-principal",
                    "workspaceBinding": "workspace-fixture",
                    "sessionId": "ses-root-fixture",
                    "locationId": "loc-preadm-fixture",
                    "ownerEpoch": 7,
                    "processIncarnation": "inc-preadm-fixture",
                    "processIdentity": {"pid": 4242, "startIdentity": 1},
                    "sourceRevision": "rev-root-1",
                    "acceptedSpecDigest": "blake3:" + "a1" * 32,
                    "expiresAtMs": now_ms + 3_600_000,
                },
                "ownerLogId": "worker-pool-fixture",
                "ownerLogSequence": "7",
                "ownerLogEventDigest": "blake3:" + "ee" * 32,
                "workerPoolRevision": 3,
            },
        },
    }
    inputs["pins"]["capabilityCeilingDigest"] = (
        _effective_capability_ceiling_digest(inputs["pins"]))
    return inputs


def write_fixture(record: dict, path) -> Path:
    """Create one NEW fixture file; never overwrite an existing fixture."""
    target = Path(path)
    name = target.name
    if not (name.startswith(FIXTURE_FILENAME_PREFIX) and name.endswith(".json")
            and len(name) > len(FIXTURE_FILENAME_PREFIX) + len(".json")):
        raise PreAdmissionFixtureError(
            f"fixture filename must start with {FIXTURE_FILENAME_PREFIX!r} "
            "and end with .json (new fixtures only)")
    if target.parent.parts[-3:] != ("kernel", "tests", "fixtures"):
        raise PreAdmissionFixtureError(
            "fixture destination must be inside kernel/tests/fixtures")
    payload = json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
    try:
        descriptor = os.open(
            target, os.O_WRONLY | os.O_CREAT | os.O_EXCL
            | getattr(os, "O_CLOEXEC", 0), 0o644)
    except FileExistsError as error:
        raise PreAdmissionFixtureError(
            f"fixture already exists: {name}; existing fixtures are never overwritten"
        ) from error
    try:
        view = memoryview(payload.encode("utf-8"))
        while view:
            written = os.write(descriptor, view)
            if written <= 0:
                raise OSError("short fixture write")
            view = view[written:]
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    return target


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--emit", required=True, type=Path,
                        help="NEW path under kernel/tests/fixtures/ "
                             "(prefixed pre-admission-reserved-)")
    args = parser.parse_args(argv)
    record = build_pre_admission_reserved_fixture(canonical_input())
    written = write_fixture(record, args.emit)
    print(json.dumps({"status": "EMITTED", "path": str(written),
                      "purpose": record["purpose"],
                      "candidateAttemptID": record["derived"]["candidateAttemptID"]},
                     sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
