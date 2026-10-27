#!/usr/bin/env python3
"""Worker fan-out / pressure admission policy over authenticated owner samples
(item 47).

This is an offline policy evaluator for the P8 harness, not a second runtime
authority: Rust owns worker admission (§18.18/§21.11). The runtime gate stays
closed until P1/P2 settlement evidence exists, and no decision can activate
from a caller-claimed field -- the owner sample must be covered by a configured
trusted RC0 attestation for its exact sessions/commit/outcomes. Nothing here
opens fan-out, pressure actions, cache retirement or an OS quota guarantee.
"""
import rc0

# Runtime gate. Never opened by this module; flipping it is a parent/P1/P2
# action backed by settled Guard receipts and terminal managed evidence.
ADMISSION_RUNTIME_GATE_OPEN = False

MAX_SAMPLE_AGE_MS = 30_000
DEFAULT_REQUIRED_CALM_SAMPLES = 3
MAX_U64 = (1 << 64) - 1

# §11.20/§18.18 sole vocabulary (frozen against
# kernel/tests/fixtures/reservation-wire-v1.json by the tests).
RESERVATION_STATES = (
    "PROPOSED", "RESERVED", "CLAIMED", "RELEASE_PENDING", "QUARANTINED",
    "RELEASED", "EXPIRED",
)
PRESSURE_STATES = ("NORMAL", "SOFT_PRESSURE", "HARD_PRESSURE", "RECOVERING")

_HEADROOM_STATES = ("RESERVED", "CLAIMED", "RELEASE_PENDING", "QUARANTINED")
_TERMINAL_STATES = ("RELEASED", "EXPIRED")


def _nonnegative_int(value, name):
    if (isinstance(value, bool) or not isinstance(value, int)
            or value < 0 or value > MAX_U64):
        raise ValueError(f"{name} must be a u64 nonnegative integer")
    return value


def reservation_headroom(status, reserved, measured=None, terminal_proof=False):
    """Unconsumed reservation headroom for one §11.20 state (§18.18 formula).

    ``PROPOSED`` reserves nothing. A worker reservation contributes its full
    reserved amount while its usage is unattributed, and only the unmeasured
    remainder once a measurement reflects it -- never the full reservation a
    second time. ``RELEASED``/``EXPIRED`` free capacity only with the exact
    §11.20 proof; otherwise the reserve is retained conservatively.
    """
    if not isinstance(status, str) or status not in RESERVATION_STATES:
        raise ValueError(f"unknown reservation status {status!r}; canonical "
                         f"states are {list(RESERVATION_STATES)}")
    if type(terminal_proof) is not bool:
        raise ValueError("terminal_proof must be a bool")
    _nonnegative_int(reserved, "reserved")
    if measured is not None:
        _nonnegative_int(measured, "measured")
    if status == "PROPOSED":
        return 0
    if status in _TERMINAL_STATES:
        return 0 if terminal_proof else reserved
    if status not in _HEADROOM_STATES:  # pragma: no cover - defensive
        raise ValueError(f"unhandled reservation status {status!r}")
    if measured is None:
        return reserved
    return max(reserved - measured, 0)


def remaining_capacity(hard_limit, measured_usage, headroom_total, safety_reserve):
    """``hard - measured - unconsumed reservations - safety`` exactly.

    A missing hard limit yields ``None`` (UNKNOWN_CAPACITY), never an infinite
    quota; arithmetic is exact-integer and saturates at zero instead of
    underflowing.
    """
    if hard_limit is None:
        return None
    _nonnegative_int(hard_limit, "hard_limit")
    _nonnegative_int(measured_usage, "measured_usage")
    _nonnegative_int(headroom_total, "headroom_total")
    _nonnegative_int(safety_reserve, "safety_reserve")
    return max(hard_limit - measured_usage - headroom_total - safety_reserve, 0)


def evaluate_pressure(state, *, measured, soft_limit, hard_limit,
                      calm_samples=0, required_calm=DEFAULT_REQUIRED_CALM_SAMPLES,
                      os_alarm=False):
    """Deterministic §18.18 pressure ladder with hysteresis.

    ``HARD`` never collapses to ``NORMAL``: recovery must pass through
    ``RECOVERING`` and survive the sustained-calm window. Unknown limits yield
    no invented signal (``reason == "unknown_capacity"``).
    """
    if not isinstance(state, str) or state not in PRESSURE_STATES:
        raise ValueError(f"unknown pressure state {state!r}; canonical states "
                         f"are {list(PRESSURE_STATES)}")
    _nonnegative_int(measured, "measured")
    _nonnegative_int(calm_samples, "calm_samples")
    _nonnegative_int(required_calm, "required_calm")
    if soft_limit is None or hard_limit is None:
        return {"state": state, "reason": "unknown_capacity"}
    _nonnegative_int(soft_limit, "soft_limit")
    _nonnegative_int(hard_limit, "hard_limit")
    breach = os_alarm or measured >= hard_limit
    if state == "NORMAL":
        if breach:
            return {"state": "HARD_PRESSURE", "reason": None}
        if measured >= soft_limit:
            return {"state": "SOFT_PRESSURE", "reason": None}
        return {"state": "NORMAL", "reason": None}
    if state == "SOFT_PRESSURE":
        if breach:
            return {"state": "HARD_PRESSURE", "reason": None}
        if measured < soft_limit:
            return {"state": "RECOVERING", "reason": None}
        return {"state": "SOFT_PRESSURE", "reason": None}
    if state == "HARD_PRESSURE":
        if measured < soft_limit and not os_alarm:
            return {"state": "RECOVERING", "reason": None}
        return {"state": "HARD_PRESSURE", "reason": None}
    # RECOVERING
    if breach:
        return {"state": "HARD_PRESSURE", "reason": None}
    if measured >= soft_limit:
        return {"state": "RECOVERING", "reason": None}
    if calm_samples >= required_calm:
        return {"state": "NORMAL", "reason": None}
    return {"state": "RECOVERING", "reason": None}


def admission_gate_status():
    """Truthful gate state: closed here until parent/P1/P2 open it."""
    open_gate = bool(ADMISSION_RUNTIME_GATE_OPEN)
    return {
        "runtime_gate_open": open_gate,
        "status": "OPEN" if open_gate else "CLOSED",
        "reason": ("runtime gate closed: fan-out admission activates only with "
                   "P1/P2 settlement evidence and an authenticated owner sample"),
        "authenticated_owner_sample_required": True,
        "settlement_evidence_required": ("p1_receipts_settled",
                                         "p2_terminal_verified"),
        "os_quota_enforcement": "UNSUPPORTED",
    }


def evaluate_admission(*, owner_sample, request, settlement_evidence,
                       pressure_state, capacity):
    """Admit/queue/block one fan-out request, or fail closed.

    Order: authenticated owner sample (attestation coverage, freshness, owner
    match) -> request shape -> P1/P2 settlement evidence -> runtime gate ->
    capacity/pressure/fan-out ceilings. Caller-claimed authentication fields are
    ignored; only :func:`rc0.attestation_covers` establishes sample authority.
    """
    def closed(reason):
        return {"decision": "CLOSED", "reason": reason,
                "pressure_state": pressure_state,
                "capacity_remaining": None, "os_quota_enforced": False,
                "enforcement": "UNSUPPORTED"}

    if not isinstance(owner_sample, dict):
        return closed("unauthenticated_owner_sample")
    if not rc0.attestation_covers(
            owner_sample.get("attestation"), owner_sample.get("selected"),
            owner_sample.get("commit"), outcomes=owner_sample.get("outcomes")):
        return closed("unauthenticated_owner_sample")
    age = owner_sample.get("age_ms")
    if isinstance(age, bool) or not isinstance(age, int) or age < 0 \
            or age > MAX_SAMPLE_AGE_MS:
        return closed("stale_owner_sample")
    if not isinstance(request, dict) \
            or request.get("owner_id") != owner_sample.get("owner_id"):
        return closed("owner_mismatch")
    requested = request.get("requested_workers")
    active = request.get("active_workers")
    pool_ceiling = request.get("pool_ceiling")
    spec_ceiling = request.get("spec_max_workers")
    for name, value in (("requested_workers", requested),
                        ("active_workers", active),
                        ("pool_ceiling", pool_ceiling),
                        ("spec_max_workers", spec_ceiling)):
        if isinstance(value, bool) or not isinstance(value, int) or value < 0:
            return closed("invalid_worker_request")
    if requested < 1:
        return closed("invalid_worker_request")
    if not isinstance(settlement_evidence, dict) \
            or settlement_evidence.get("p1_receipts_settled") is not True \
            or settlement_evidence.get("p2_terminal_verified") is not True:
        return closed("p1_p2_settlement_evidence_absent")
    if not ADMISSION_RUNTIME_GATE_OPEN:
        return closed("runtime_gate_closed")

    remaining = None

    def decided(decision, reason):
        return {"decision": decision, "reason": reason,
                "pressure_state": pressure_state,
                "capacity_remaining": remaining,
                "os_quota_enforced": False,
                # Bounded admission only: never an OS quota guarantee (§18.18).
                "enforcement": "ADMISSION_ONLY"}

    if not isinstance(capacity, dict):
        return decided("BLOCK", "unknown_capacity")
    required_capacity_fields = (
        "hard_limit", "measured_usage", "headroom_total", "safety_reserve")
    if any(field not in capacity or capacity[field] is None
           for field in required_capacity_fields):
        return decided("BLOCK", "unknown_capacity")
    try:
        remaining = remaining_capacity(
            hard_limit=capacity["hard_limit"],
            measured_usage=capacity["measured_usage"],
            headroom_total=capacity["headroom_total"],
            safety_reserve=capacity["safety_reserve"],
        )
    except (TypeError, ValueError):
        return closed("invalid_capacity")

    if remaining is None:
        return decided("BLOCK", "unknown_capacity")
    if remaining == 0:
        return decided("BLOCK", "capacity_exhausted")
    if pressure_state not in PRESSURE_STATES:
        return closed("invalid_pressure_state")
    if pressure_state == "HARD_PRESSURE":
        return decided("BLOCK", "hard_pressure")
    if pressure_state in ("SOFT_PRESSURE", "RECOVERING"):
        return decided("QUEUE", "soft_pressure_reduce_admissions"
                       if pressure_state == "SOFT_PRESSURE"
                       else "recovering_hysteresis")
    ceiling = min(pool_ceiling, spec_ceiling)
    if active + requested > ceiling:
        return decided("QUEUE", "fan_out_ceiling")
    return decided("ADMIT", "within_capacity")


if __name__ == "__main__":
    import json
    print(json.dumps(admission_gate_status(), sort_keys=True))
