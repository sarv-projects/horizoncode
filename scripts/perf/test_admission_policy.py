"""Item 47 — worker fan-out / pressure admission policy tests.

The policy may only activate from a genuinely authenticated owner sample, the
runtime gate stays closed until P1/P2 settlement evidence exists, and no
pressure/fan-out/quota claim may open from caller-supplied fields.
"""
import json
import unittest
from pathlib import Path
from unittest.mock import patch

import rc0
import admission_policy as ap

SOURCE = 'horizoncore.owner.v1'
KEY = b'\x66' * 32
COMMIT = 'abc123'
FIXTURE = (Path(__file__).resolve().parents[2] / 'kernel' / 'tests' / 'fixtures'
           / 'reservation-wire-v1.json')


def signed_attestation(selected, outcomes, commit=COMMIT):
    """Test-fixture attestation; still must pass verify + coverage checks."""
    attestation = object.__new__(rc0.AttestationV1)
    values = {
        'source': SOURCE,
        'commit': commit,
        'session_ids': tuple(session for session, _ in selected),
        'run_ids': tuple(f'run-{session}' for session, _ in selected),
        'session_run_ids': tuple((session, f'run-{session}') for session, _ in selected),
        'session_owner_identities': tuple(
            (session, pid, str(start)) for session, (pid, start) in selected),
        'host_run_receipt_refs': tuple(f'receipt-{session}' for session, _ in selected),
        'independent_verifier_evidence_refs': tuple(
            f'verifier-{session}' for session, _ in selected),
        'owner_log_event_digests': tuple('blake3:' + f'{i:02x}' * 32 for i, _ in
                                         enumerate(selected)),
        'session_outcome_digests': tuple(
            (session, rc0.outcome_digest(outcomes[session])) for session, _ in selected),
        'source_signature_digest': '',
        'source_signature': '',
    }
    for name, value in values.items():
        object.__setattr__(attestation, name, value)
    digest = rc0.attestation_signature_digest(rc0.attestation_payload(attestation))
    signature = rc0.sign_attestation(attestation, KEY)
    object.__setattr__(attestation, 'source_signature_digest', digest)
    object.__setattr__(attestation, 'source_signature', signature)
    return attestation


def authenticated_sample(**overrides):
    selected = [('ses-a', (4242, 7))]
    outcomes = {'ses-a': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
    sample = {
        'owner_id': 'owner-a',
        'session_ids': ['ses-a'],
        'selected': selected,
        'outcomes': outcomes,
        'commit': COMMIT,
        'attestation': signed_attestation(selected, outcomes),
        'age_ms': 1_000,
    }
    sample.update(overrides)
    return sample


def request(**overrides):
    value = {
        'owner_id': 'owner-a',
        'active_workers': 0,
        'requested_workers': 1,
        'pool_ceiling': 4,
        'spec_max_workers': 4,
    }
    value.update(overrides)
    return value


def settlement(**overrides):
    value = {'p1_receipts_settled': True, 'p2_terminal_verified': True}
    value.update(overrides)
    return value


def capacity(**overrides):
    value = {'hard_limit': 1_000, 'measured_usage': 200, 'headroom_total': 300,
             'safety_reserve': 100}
    value.update(overrides)
    return value


@unittest.skipUnless(FIXTURE.exists(), 'frozen wire fixture is tracked')
class ReservationVocabularyTests(unittest.TestCase):
    def test_policy_vocabulary_matches_the_frozen_section_11_20_fixture(self):
        fixture = json.loads(FIXTURE.read_text(encoding='utf-8'))
        self.assertEqual(list(ap.RESERVATION_STATES),
                         fixture['reservationStatus']['canonical'])
        self.assertEqual(list(ap.PRESSURE_STATES),
                         fixture['pressureState']['canonical'])
        for forbidden in fixture['reservationStatus']['forbidden']:
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, ap.RESERVATION_STATES)

    def test_obsolete_reservation_aliases_are_rejected(self):
        for alias in ('ACTIVE', 'UNKNOWN', 'Reserved', 'pending'):
            with self.subTest(alias=alias):
                with self.assertRaises(ValueError):
                    ap.reservation_headroom(alias, 100)


class AdmissionArithmeticTests(unittest.TestCase):
    def test_jc_res_012_headroom_math_is_exact_and_conservative(self):
        # JC-RES-012.C: remaining = 1000 - 200 - 300 - 100 = 400.
        self.assertEqual(
            ap.remaining_capacity(**capacity()), 400)
        # JC-RES-012.D: measured 250 of a 300 reservation -> headroom 50;
        # remaining stays 400 (never subtract the full reservation twice).
        self.assertEqual(ap.reservation_headroom('RESERVED', 300, 250), 50)
        self.assertEqual(
            ap.remaining_capacity(hard_limit=1_000, measured_usage=450,
                                  headroom_total=50, safety_reserve=100), 400)
        # JC-RES-012.E: measured 350 exceeds the 300 reservation -> no headroom.
        self.assertEqual(ap.reservation_headroom('RESERVED', 300, 350), 0)
        self.assertEqual(
            ap.remaining_capacity(hard_limit=1_000, measured_usage=550,
                                  headroom_total=0, safety_reserve=100), 350)

    def test_reservation_states_never_release_capacity_without_proof(self):
        self.assertEqual(ap.reservation_headroom('PROPOSED', 300), 0)
        self.assertEqual(ap.reservation_headroom('RESERVED', 300), 300)
        # Unavailable/stale measurement keeps the full reserve.
        self.assertEqual(ap.reservation_headroom('CLAIMED', 300, None), 300)
        self.assertEqual(ap.reservation_headroom('QUARANTINED', 300, None), 300)
        # Terminal states free capacity only with the §11.20 proof.
        self.assertEqual(ap.reservation_headroom('RELEASED', 300), 300)
        self.assertEqual(ap.reservation_headroom('RELEASED', 300,
                                                 terminal_proof=True), 0)
        self.assertEqual(ap.reservation_headroom('EXPIRED', 300), 300)
        self.assertEqual(ap.reservation_headroom('EXPIRED', 300,
                                                 terminal_proof=True), 0)

    def test_capacity_math_is_exact_beyond_javascript_safe_integers(self):
        huge = 2 ** 53 + 1
        self.assertEqual(
            ap.remaining_capacity(hard_limit=huge + 500, measured_usage=huge,
                                  headroom_total=200, safety_reserve=100), 200)
        # Saturating, never wrapping: exhausted capacity blocks instead of
        # underflowing to a huge unsigned value.
        self.assertEqual(
            ap.remaining_capacity(hard_limit=100, measured_usage=500,
                                  headroom_total=100, safety_reserve=100), 0)

    def test_capacity_math_rejects_u64_overflow(self):
        for field in ("hard_limit", "measured_usage", "headroom_total",
                      "safety_reserve"):
            with self.subTest(field=field):
                with self.assertRaises(ValueError):
                    ap.remaining_capacity(**capacity(**{field: 1 << 64}))

    def test_missing_hard_limit_is_unknown_capacity_not_infinite_quota(self):
        self.assertIsNone(ap.remaining_capacity(
            hard_limit=None, measured_usage=1, headroom_total=0, safety_reserve=0))

    def test_negative_and_boolean_inputs_are_rejected(self):
        for kwargs in ({'hard_limit': -1}, {'measured_usage': True},
                       {'headroom_total': '10'}, {'safety_reserve': 1.5}):
            with self.subTest(kwargs=sorted(kwargs)):
                with self.assertRaises(ValueError):
                    ap.remaining_capacity(**capacity(**kwargs))


class PressureLadderTests(unittest.TestCase):
    def test_ladder_requires_recovering_between_hard_and_normal(self):
        # HARD with a calm reading first enters RECOVERING, never NORMAL.
        state = ap.evaluate_pressure('HARD_PRESSURE', measured=100, soft_limit=500,
                                     hard_limit=900, calm_samples=99)
        self.assertEqual(state['state'], 'RECOVERING')
        # RECOVERING needs the sustained calm window before NORMAL.
        state = ap.evaluate_pressure('RECOVERING', measured=100, soft_limit=500,
                                     hard_limit=900, calm_samples=1,
                                     required_calm=3)
        self.assertEqual(state['state'], 'RECOVERING')
        state = ap.evaluate_pressure('RECOVERING', measured=100, soft_limit=500,
                                     hard_limit=900, calm_samples=3,
                                     required_calm=3)
        self.assertEqual(state['state'], 'NORMAL')
        # A renewed hard reading during recovery returns to HARD.
        state = ap.evaluate_pressure('RECOVERING', measured=950, soft_limit=500,
                                     hard_limit=900, calm_samples=3,
                                     required_calm=3)
        self.assertEqual(state['state'], 'HARD_PRESSURE')

    def test_soft_pressure_and_direct_os_alarm_transitions(self):
        state = ap.evaluate_pressure('NORMAL', measured=600, soft_limit=500,
                                     hard_limit=900)
        self.assertEqual(state['state'], 'SOFT_PRESSURE')
        state = ap.evaluate_pressure('NORMAL', measured=100, soft_limit=500,
                                     hard_limit=900, os_alarm=True)
        self.assertEqual(state['state'], 'HARD_PRESSURE')
        state = ap.evaluate_pressure('SOFT_PRESSURE', measured=100, soft_limit=500,
                                     hard_limit=900)
        self.assertEqual(state['state'], 'RECOVERING')

    def test_unknown_limits_do_not_invent_a_pressure_signal(self):
        state = ap.evaluate_pressure('NORMAL', measured=100, soft_limit=None,
                                     hard_limit=None)
        self.assertEqual(state['state'], 'NORMAL')
        self.assertEqual(state['reason'], 'unknown_capacity')

    def test_invalid_pressure_state_is_rejected(self):
        with self.assertRaises(ValueError):
            ap.evaluate_pressure('SOFT', measured=1, soft_limit=1, hard_limit=2)


def trusted_context():
    return patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', (SOURCE,)), \
        patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                   {SOURCE: rc0.hmac_sha256_verifier(KEY)}), \
        patch.object(rc0, 'landed_hostrun_contract_gaps', return_value=[])


class AdmissionDecisionTests(unittest.TestCase):
    def evaluate(self, *, sample=None, req=None, evidence=None,
                 pressure=None, cap=None, gate=False):
        patches = trusted_context()
        with patches[0], patches[1], patches[2], \
             patch.object(ap, 'ADMISSION_RUNTIME_GATE_OPEN', gate):
            return ap.evaluate_admission(
                owner_sample=authenticated_sample() if sample is None else sample,
                request=request() if req is None else req,
                settlement_evidence=settlement() if evidence is None else evidence,
                pressure_state='NORMAL' if pressure is None else pressure,
                capacity=capacity() if cap is None else cap)

    def test_gate_starts_closed_and_names_the_prerequisites(self):
        status = ap.admission_gate_status()
        self.assertFalse(status['runtime_gate_open'])
        self.assertEqual(status['status'], 'CLOSED')
        self.assertIn('P1/P2 settlement', status['reason'])

    def test_caller_claimed_authentication_is_closed(self):
        # A caller-asserted `authenticated` flag with no genuine attestation
        # can never substitute for trusted-source coverage.
        result = self.evaluate(sample=authenticated_sample(authenticated=True,
                                                           attestation=None))
        self.assertEqual(result['decision'], 'CLOSED')
        self.assertEqual(result['reason'], 'unauthenticated_owner_sample')

    def test_empty_trusted_registry_closes_admission(self):
        sample = authenticated_sample()
        with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ()), \
             patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS, {}, clear=True):
            result = ap.evaluate_admission(
                owner_sample=sample, request=request(),
                settlement_evidence=settlement(), pressure_state='NORMAL',
                capacity=capacity())
        self.assertEqual(result['decision'], 'CLOSED')
        self.assertEqual(result['reason'], 'unauthenticated_owner_sample')

    def test_stale_or_foreign_owner_samples_are_closed(self):
        stale = self.evaluate(sample=authenticated_sample(age_ms=60_000))
        self.assertEqual((stale['decision'], stale['reason']),
                         ('CLOSED', 'stale_owner_sample'))
        foreign = self.evaluate(req=request(owner_id='owner-b'))
        self.assertEqual((foreign['decision'], foreign['reason']),
                         ('CLOSED', 'owner_mismatch'))

    def test_settlement_evidence_is_required_before_any_admission(self):
        result = self.evaluate(evidence=settlement(p2_terminal_verified=False),
                               gate=True)
        self.assertEqual((result['decision'], result['reason']),
                         ('CLOSED', 'p1_p2_settlement_evidence_absent'))

    def test_runtime_gate_stays_closed_without_an_explicit_opening(self):
        result = self.evaluate(gate=False)
        self.assertEqual((result['decision'], result['reason']),
                         ('CLOSED', 'runtime_gate_closed'))

    def test_unknown_capacity_blocks_new_costly_admission(self):
        result = self.evaluate(gate=True, cap=capacity(hard_limit=None))
        self.assertEqual((result['decision'], result['reason']),
                         ('BLOCK', 'unknown_capacity'))
        exhausted = self.evaluate(gate=True, cap=capacity(
            hard_limit=100, measured_usage=500, headroom_total=100,
            safety_reserve=100))
        self.assertEqual((exhausted['decision'], exhausted['reason']),
                         ('BLOCK', 'capacity_exhausted'))

    def test_missing_resource_inputs_never_default_to_zero(self):
        partial_inputs = (
            {"hard_limit": 1_000},
            {"hard_limit": 1_000, "measured_usage": 200},
            {"hard_limit": 1_000, "measured_usage": 200,
             "headroom_total": 300},
            {"hard_limit": 1_000, "measured_usage": None,
             "headroom_total": 300, "safety_reserve": 100},
        )
        for partial in partial_inputs:
            with self.subTest(capacity=partial):
                result = self.evaluate(gate=True, cap=partial)
                self.assertEqual((result["decision"], result["reason"]),
                                 ("BLOCK", "unknown_capacity"))
                self.assertIsNone(result["capacity_remaining"])
                self.assertFalse(result["os_quota_enforced"])

    def test_malformed_capacity_returns_closed_not_exception(self):
        malformed = (
            capacity(hard_limit=True),
            capacity(measured_usage=-1),
            capacity(safety_reserve=1 << 64),
        )
        for values in malformed:
            with self.subTest(capacity=values):
                result = self.evaluate(gate=True, cap=values)
                self.assertEqual((result["decision"], result["reason"]),
                                 ("CLOSED", "invalid_capacity"))
                self.assertIsNone(result["capacity_remaining"])
                self.assertFalse(result["os_quota_enforced"])

    def test_pressure_states_gate_new_admissions(self):
        hard = self.evaluate(gate=True, pressure='HARD_PRESSURE')
        self.assertEqual((hard['decision'], hard['reason']),
                         ('BLOCK', 'hard_pressure'))
        soft = self.evaluate(gate=True, pressure='SOFT_PRESSURE')
        self.assertEqual((soft['decision'], soft['reason']),
                         ('QUEUE', 'soft_pressure_reduce_admissions'))
        recovering = self.evaluate(gate=True, pressure='RECOVERING')
        self.assertEqual((recovering['decision'], recovering['reason']),
                         ('QUEUE', 'recovering_hysteresis'))

    def test_fan_out_ceiling_queues_new_workers(self):
        beyond = self.evaluate(gate=True, req=request(active_workers=4,
                                                      requested_workers=1))
        self.assertEqual((beyond['decision'], beyond['reason']),
                         ('QUEUE', 'fan_out_ceiling'))
        invalid = self.evaluate(gate=True, req=request(requested_workers=0))
        self.assertEqual((invalid['decision'], invalid['reason']),
                         ('CLOSED', 'invalid_worker_request'))
        admitted = self.evaluate(gate=True)
        self.assertEqual((admitted['decision'], admitted['reason']),
                         ('ADMIT', 'within_capacity'))
        self.assertEqual(admitted['capacity_remaining'], 400)

    def test_admission_never_reports_a_quota_guarantee(self):
        result = self.evaluate(gate=True)
        self.assertFalse(result['os_quota_enforced'])
        self.assertEqual(result['enforcement'], 'ADMISSION_ONLY')


if __name__ == '__main__':
    unittest.main()
