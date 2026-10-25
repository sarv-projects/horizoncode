import argparse
import contextlib
import hmac
import io
import json
import os
import platform
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rc0


def temporary_directory():
    """Keep fixture artifacts inside the repository even when tests run later."""
    return tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent)


class Rc0UnsupportedPlatformTests(unittest.TestCase):
    def test_fixture_scratch_is_repository_local(self):
        with temporary_directory() as directory:
            self.assertEqual(Path(directory).parent.resolve(), Path(__file__).resolve().parent)

    def test_sampler_names_the_actual_unsupported_platform(self):
        with patch.object(rc0.platform, 'system', return_value='Darwin'):
            result = rc0.sample_tree(10, 1)
        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertTrue(result['truncated'])
        self.assertIn('native Darwin sampler is unavailable', result['reason'])

    def test_capture_output_is_bounded_and_descriptor_relative(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            output = Path(directory) / 'capture.jsonl'
            rc0.append_capture_output(output, b'{"record_type":"fixture"}\n')
            rc0.append_capture_output(output, b'{"record_type":"second"}\n')
            self.assertEqual(output.read_bytes(),
                             b'{"record_type":"fixture"}\n{"record_type":"second"}\n')
            link = Path(directory) / 'redirect.jsonl'
            link.symlink_to(output)
            with self.assertRaises(ValueError):
                rc0.append_capture_output(link, b'{"should_not":"follow"}\n')
            partial = Path(directory) / 'partial.jsonl'
            partial.write_bytes(b'{"truncated"')
            with self.assertRaises(ValueError):
                rc0.append_capture_output(partial, b'{"new":"row"}\n')


def measured_session(session_id):
    pid, start = {'s1': (101, 1), 's2': (102, 2)}[session_id]
    return {
        'session_id': session_id,
        'owner_identity': {'pid': pid, 'start_identity': str(start)},
        'sample': {
            'quality': 'MEASURED',
            'truncated': False,
            'processes': [{
                'pid': pid,
                'start_identity': str(start),
                'identity_valid': True,
                'quality': 'MEASURED',
                'metrics': {name: 1 for name in rc0.REQUIRED_LINUX_METRICS},
            }],
            'process_tree_totals': {
                'quality': 'MEASURED',
                'metrics': {name: 1 for name in rc0.REQUIRED_LINUX_METRICS},
            },
        },
    }


class Rc0BaselineTests(unittest.TestCase):
    def setUp(self):
        self.selected = [('s1', (101, 1)), ('s2', (102, 2))]
        self.results = [measured_session('s1'), measured_session('s2')]
        self.outcomes = {
            's1': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'},
            's2': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'},
        }

    def eligible(self, **changes):
        args = {
            'selected': self.selected,
            'session_results': self.results,
            'outcomes': self.outcomes,
            'commit': 'abc123',
            'clean_tree': True,
            'provider_model': 'provider/model',
            'build': 'release rustc pinned',
            'harness': 'native',
            'local_inference': 'excluded',
            'attestation': None,
        }
        args.update(changes)
        return rc0.baseline_eligible(**args)

    def test_requires_selected_harness_identity(self):
        self.assertFalse(self.eligible(harness=''))

    def test_requires_at_least_one_owner_issued_session(self):
        # No live 1/5/10/20 capture without valid Session owner identities: an empty
        # selection must never be promoted to a baseline.
        self.assertFalse(self.eligible(selected=[], session_results=[]))

    def test_requires_explicit_provider_model_build_and_local_inference_decisions(self):
        # No provider inference and no unnamed build: unrecorded values stay NOT_BASELINE.
        for provider_model in ('', '   ', 'unknown', 'NOT-RECORDED'):
            self.assertFalse(self.eligible(provider_model=provider_model))
        self.assertFalse(self.eligible(build=''))
        self.assertFalse(self.eligible(local_inference='maybe'))

    def test_requires_every_requested_session_to_have_raw_samples(self):
        self.assertFalse(self.eligible(session_results=self.results[:1]))

    def test_requires_all_platform_counters_for_every_process(self):
        del self.results[1]['sample']['processes'][0]['metrics']['fd_count']
        self.assertFalse(self.eligible())

    def test_rejects_truncated_or_unknown_process_trees(self):
        self.results[0]['sample']['truncated'] = True
        self.assertFalse(self.eligible())

    def test_task_actual_must_match_expected_and_pass(self):
        self.outcomes['s2']['actual'] = 'wrong'
        self.assertFalse(self.eligible())

    def test_dirty_head_is_not_an_exact_commit_baseline(self):
        self.assertFalse(self.eligible(clean_tree=False))

    def test_rejects_unknown_or_missing_process_identity(self):
        self.results[1]['sample']['processes'][0]['identity_valid'] = False
        self.assertFalse(self.eligible())

    def test_rejects_sample_for_a_different_owner_identity(self):
        self.results[0]['owner_identity']['pid'] = 999
        self.assertFalse(self.eligible())

    def test_rejects_zero_process_start_identity(self):
        self.selected[0] = ('s1', (101, 0))
        self.results[0]['owner_identity']['start_identity'] = '0'
        self.results[0]['sample']['processes'][0]['start_identity'] = '0'
        self.assertFalse(self.eligible())

    def test_identity_argument_rejects_zero_start_identity(self):
        with self.assertRaises(argparse.ArgumentTypeError):
            rc0.identity_arg('s1=101:0')

    def test_rejects_duplicate_session_owner_identity(self):
        self.selected[1] = ('s2', (101, 1))
        self.results[1]['owner_identity'] = {'pid': 101, 'start_identity': '1'}
        self.results[1]['sample']['processes'][0]['pid'] = 101
        self.results[1]['sample']['processes'][0]['start_identity'] = '1'
        self.assertFalse(self.eligible())

    def test_rejects_process_tree_overlap_between_sessions(self):
        self.results[1]['sample']['processes'].append({
            'pid': 101,
            'start_identity': '1',
            'identity_valid': True,
            'quality': 'MEASURED',
            'metrics': {name: 1 for name in rc0.REQUIRED_LINUX_METRICS},
        })
        self.assertFalse(self.eligible())

    def test_local_inference_included_requires_a_separate_measured_tree(self):
        self.assertFalse(self.eligible(local_inference='included'))
        # A well-shaped local-inference tree is still only caller-supplied input;
        # without owner attestation it cannot be eligible.
        self.assertFalse(self.eligible(
            local_inference='included',
            local_inference_sample={
                'owner_identity': {'pid': 201, 'start_identity': '3'},
                'sample': {
                    'quality': 'MEASURED', 'truncated': False,
                    'processes': [{
                        'pid': 201, 'start_identity': '3', 'identity_valid': True,
                        'quality': 'MEASURED',
                        'metrics': {name: 1 for name in rc0.REQUIRED_LINUX_METRICS},
                    }],
                    'process_tree_totals': {
                        'quality': 'MEASURED',
                        'metrics': {name: 1 for name in rc0.REQUIRED_LINUX_METRICS},
                    },
                },
            },
        ))

    def test_complete_clean_inputs_still_require_owner_attestation(self):
        """Well-shaped caller inputs alone can never produce a baseline."""
        self.assertFalse(self.eligible())


class Rc0AttestationCoverageTests(unittest.TestCase):
    @staticmethod
    def forged_attestation(**overrides):
        """Build an adversarial in-process object; this is never owner evidence.

        The payload digest is recomputed so these cases exercise the *coverage*
        predicate rather than tripping the structural digest check. A signature is
        attached only where a caller explicitly asks for one.
        """
        values = {
            'source': 'untrusted-test-source',
            'commit': 'abc123',
            'session_ids': ('s1', 's2'),
            'run_ids': ('r1', 'r2'),
            'session_run_ids': (('s1', 'r1'), ('s2', 'r2')),
            'session_owner_identities': (('s1', 101, '1'), ('s2', 102, '2')),
            'host_run_receipt_refs': ('receipt-1', 'receipt-2'),
            'independent_verifier_evidence_refs': ('evidence-1', 'evidence-2'),
            'owner_log_event_digests': ('blake3:' + 'a' * 64, 'blake3:' + 'b' * 64),
            'source_signature_digest': '',
            'source_signature': '',
        }
        values.update(overrides)
        result = object.__new__(rc0.AttestationV1)
        for name, value in values.items():
            object.__setattr__(result, name, value)
        if not values['source_signature_digest']:
            object.__setattr__(
                result,
                'source_signature_digest',
                rc0.attestation_signature_digest(rc0.attestation_payload(result)),
            )
        return result

    def test_attestation_must_bind_exact_selected_session_process_generations(self):
        selected = [('s1', (101, 1)), ('s2', (102, 2))]
        attestation = self.forged_attestation(
            session_owner_identities=(('s1', 101, '999'), ('s2', 102, '2')),
        )
        self.assertFalse(rc0.attestation_covers(attestation, selected, 'abc123'))

    def test_attestation_without_process_generation_binding_is_rejected(self):
        selected = [('s1', (101, 1)), ('s2', (102, 2))]
        attestation = self.forged_attestation()
        object.__delattr__(attestation, 'session_owner_identities')
        self.assertFalse(rc0.attestation_covers(attestation, selected, 'abc123'))

    def test_missing_stale_or_untyped_attestation_never_covers_capture(self):
        selected = [('s1', (101, 1)), ('s2', (102, 2))]
        self.assertFalse(rc0.attestation_covers(None, selected, 'abc123'))
        self.assertFalse(rc0.attestation_covers({'source': 'trusted'}, selected, 'abc123'))
        stale = self.forged_attestation(commit='old-commit')
        self.assertFalse(rc0.attestation_covers(stale, selected, 'abc123'))

    def test_source_allowlist_and_verifier_registry_stay_empty(self):
        self.assertEqual(rc0.TRUSTED_ATTESTATION_SOURCES, ())
        self.assertEqual(rc0.TRUSTED_ATTESTATION_VERIFIERS, {})
        self.assertEqual(rc0.ATTESTATION_SIGNATURE_ALGORITHMS, ('hmac-sha256',))

    def test_test_only_candidate_must_match_session_run_and_process_generations(self):
        # The temporary allowlist and verifier exist only to exercise the pure
        # coverage predicate. No such source is configured in production and
        # these in-memory candidates are never accepted as capture evidence.
        selected = [('s1', (101, 1)), ('s2', (102, 2))]
        key = b'\x5a' * 32
        with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ('test-only',)), \
             patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                        {'test-only': rc0.hmac_sha256_verifier(key)}):
            exact = self.signed(self.forged_attestation(source='test-only'), key)
            self.assertTrue(rc0.attestation_covers(exact, selected, 'abc123'))
            cases = (
                self.signed(self.forged_attestation(source='test-only', commit='stale-commit'), key),
                self.signed(self.forged_attestation(
                    source='test-only',
                    session_owner_identities=(('s1', 101, '999'), ('s2', 102, '2')),
                ), key),
                self.signed(self.forged_attestation(
                    source='test-only',
                    session_owner_identities=(('s1', 101, '1'), ('s2', 999, '2')),
                ), key),
                self.signed(self.forged_attestation(
                    source='test-only',
                    session_run_ids=(('s1', 'foreign-run'), ('s2', 'r2')),
                ), key),
                self.signed(self.forged_attestation(
                    source='test-only', host_run_receipt_refs=('', 'receipt-2'),
                ), key),
            )
            for candidate in cases:
                with self.subTest(candidate=candidate.commit):
                    self.assertFalse(rc0.attestation_covers(candidate, selected, 'abc123'))

    @staticmethod
    def signed(attestation, key):
        """Attach a keyed MAC over the canonical payload (test key only)."""
        object.__setattr__(attestation, 'source_signature_digest',
                           rc0.attestation_signature_digest(rc0.attestation_payload(attestation)))
        object.__setattr__(attestation, 'source_signature', rc0.sign_attestation(attestation, key))
        return attestation


class Rc0AttestationSignatureTests(unittest.TestCase):
    """A digest alone is not a signature; only keyed verification may attest."""

    KEY = b'\x11' * 32
    FOREIGN_KEY = b'\x22' * 32

    def attestation(self, **overrides):
        return Rc0AttestationCoverageTests.signed(
            Rc0AttestationCoverageTests.forged_attestation(source='test-only', **overrides),
            self.KEY,
        )

    def verify(self, attestation, key=None):
        with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ('test-only',)), \
             patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                        {'test-only': rc0.hmac_sha256_verifier(key or self.KEY)}):
            return rc0.verify_attestation(attestation)

    def test_keyed_signature_over_the_exact_payload_verifies(self):
        self.assertTrue(self.verify(self.attestation()))

    def test_forged_signature_hex_is_rejected(self):
        forged = self.attestation()
        object.__setattr__(forged, 'source_signature', 'hmac-sha256:' + 'f' * 64)
        self.assertFalse(self.verify(forged))

    def test_foreign_key_signature_is_rejected(self):
        foreign = Rc0AttestationCoverageTests.signed(
            Rc0AttestationCoverageTests.forged_attestation(source='test-only'),
            self.FOREIGN_KEY,
        )
        self.assertFalse(self.verify(foreign))

    def test_tampered_authority_field_after_signing_is_rejected(self):
        for overrides in (
            {'commit': 'other-commit'},
            {'session_owner_identities': (('s1', 101, '1'), ('s2', 102, '3'))},
            {'run_ids': ('r1', 'r3'), 'session_run_ids': (('s1', 'r1'), ('s2', 'r3'))},
            {'owner_log_event_digests': ('blake3:' + 'c' * 64, 'blake3:' + 'b' * 64)},
            {'independent_verifier_evidence_refs': ('evidence-1', 'evidence-forged')},
        ):
            with self.subTest(overrides=sorted(overrides)):
                tampered = self.attestation()
                for name, value in overrides.items():
                    object.__setattr__(tampered, name, value)
                self.assertFalse(self.verify(tampered))

    def test_stale_commit_signature_is_valid_but_does_not_cover_the_capture(self):
        stale = self.attestation(commit='old-commit')
        selected = [('s1', (101, 1)), ('s2', (102, 2))]
        with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ('test-only',)), \
             patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                        {'test-only': rc0.hmac_sha256_verifier(self.KEY)}):
            self.assertTrue(rc0.verify_attestation(stale))
            self.assertFalse(rc0.attestation_covers(stale, selected, 'abc123'))

    def test_revoked_source_or_missing_verifier_is_rejected(self):
        attestation = self.attestation()
        # Source removed from the allowlist: revoked.
        with patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                        {'test-only': rc0.hmac_sha256_verifier(self.KEY)}):
            self.assertFalse(rc0.verify_attestation(attestation))
        # Allowlisted source without a registered local verifier: unverifiable.
        with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ('test-only',)):
            self.assertFalse(rc0.verify_attestation(attestation))

    def test_unsupported_public_key_algorithm_is_rejected_not_trusted(self):
        self.assertNotIn('ed25519', rc0.ATTESTATION_SIGNATURE_ALGORITHMS)
        attestation = self.attestation()
        object.__setattr__(attestation, 'source_signature', 'ed25519:' + 'a' * 64)
        self.assertFalse(self.verify(attestation))

    def test_broken_or_non_boolean_verifier_denies(self):
        attestation = self.attestation()
        selected = [('s1', (101, 1)), ('s2', (102, 2))]

        def raising(_payload, _algorithm, _signature):
            raise RuntimeError("verifier backend unavailable")

        for verifier in (raising, lambda *_: 1, lambda *_: "true", lambda *_: None):
            with self.subTest(verifier=getattr(verifier, '__name__', 'anonymous')):
                with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ('test-only',)), \
                     patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS, {'test-only': verifier}):
                    self.assertFalse(rc0.verify_attestation(attestation))
                    self.assertFalse(rc0.attestation_covers(attestation, selected, 'abc123'))

    def test_signature_digest_must_cover_the_signed_payload(self):
        attestation = self.attestation()
        object.__setattr__(attestation, 'source_signature_digest',
                           rc0.attestation_signature_digest(b'other'))
        self.assertFalse(self.verify(attestation))

    def test_constructor_rejects_missing_or_inconsistent_signature_material(self):
        with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', ('test-only',)):
            with self.assertRaisesRegex(ValueError, 'incomplete owner attestation'):
                rc0.AttestationV1(
                    source='test-only', commit='abc123',
                    session_ids=('s1',), run_ids=('r1',),
                    session_run_ids=(('s1', 'r1'),),
                    session_owner_identities=(('s1', 101, '1'),),
                    host_run_receipt_refs=('receipt-1',),
                    independent_verifier_evidence_refs=('evidence-1',),
                    owner_log_event_digests=('blake3:' + 'a' * 64,),
                    source_signature_digest='sha256:' + 'c' * 64,
                )
            with self.assertRaisesRegex(ValueError, 'signature digest does not cover'):
                rc0.AttestationV1(
                    source='test-only', commit='abc123',
                    session_ids=('s1',), run_ids=('r1',),
                    session_run_ids=(('s1', 'r1'),),
                    session_owner_identities=(('s1', 101, '1'),),
                    host_run_receipt_refs=('receipt-1',),
                    independent_verifier_evidence_refs=('evidence-1',),
                    owner_log_event_digests=('blake3:' + 'a' * 64,),
                    source_signature_digest='sha256:' + 'c' * 64,
                    source_signature='hmac-sha256:' + 'd' * 64,
                )


class Rc0AttestationKeyLoaderTests(unittest.TestCase):
    """Only private, repository-contained, bounded key material is loadable."""

    def key_file(self, directory, material=None, mode=0o600):
        directory = Path(directory)
        directory.mkdir(parents=True, exist_ok=True)
        path = directory / 'attestation.key'
        path.write_bytes(self.KEY if material is None else material)
        path.chmod(mode)
        return path

    KEY = b'\x33' * 32

    def test_private_repository_key_is_loaded_exactly(self):
        with temporary_directory() as directory:
            path = self.key_file(directory)
            self.assertEqual(rc0.load_attestation_key(path), self.KEY)
            verifier = rc0.hmac_sha256_verifier(rc0.load_attestation_key(path))
            self.assertTrue(verifier(b'payload', 'hmac-sha256',
                                     hmac.new(self.KEY, b'payload',
                                              rc0.hashlib.sha256).hexdigest()))

    def test_insecure_or_malformed_key_material_is_rejected(self):
        with temporary_directory() as directory:
            permissive = self.key_file(Path(directory) / 'permissive', mode=0o644)
            with self.assertRaisesRegex(ValueError, 'private single-link'):
                rc0.load_attestation_key(permissive)
            short = self.key_file(Path(directory) / 'short', material=b'\x01' * 16)
            with self.assertRaisesRegex(ValueError, 'size'):
                rc0.load_attestation_key(short)
            oversized = self.key_file(Path(directory) / 'oversized', material=b'\x01' * 65)
            with self.assertRaisesRegex(ValueError, 'size'):
                rc0.load_attestation_key(oversized)
            zeroed = self.key_file(Path(directory) / 'zeroed', material=b'\x00' * 32)
            with self.assertRaisesRegex(ValueError, 'all zeros'):
                rc0.load_attestation_key(zeroed)
            missing = Path(directory) / 'absent.key'
            with self.assertRaisesRegex(ValueError, 'cannot be opened safely'):
                rc0.load_attestation_key(missing)

    def test_symlinked_or_external_key_paths_are_rejected(self):
        with temporary_directory() as directory:
            target = self.key_file(Path(directory) / 'target')
            link = Path(directory) / 'link.key'
            link.symlink_to(target)
            with self.assertRaises(ValueError):
                rc0.load_attestation_key(link)
            with self.assertRaisesRegex(ValueError, 'inside the repository'):
                rc0.load_attestation_key(
                    Path(__file__).resolve().parents[3] / 'outside.key')
            with self.assertRaisesRegex(ValueError, 'parent traversal'):
                rc0.load_attestation_key('scripts/../../scripts/perf/attestation.key')

    def test_hmac_verifier_refuses_wrong_algorithm_and_key_length(self):
        with self.assertRaisesRegex(ValueError, 'exactly 32 bytes'):
            rc0.hmac_sha256_verifier(b'\x01' * 16)
        verifier = rc0.hmac_sha256_verifier(self.KEY)
        self.assertFalse(verifier(b'payload', 'ed25519', 'a' * 64))
        self.assertFalse(verifier(b'payload', 'hmac-sha256', 'a' * 64))


class Rc0AggregateTests(unittest.TestCase):
    def test_process_tree_totals_sum_each_metric_without_losing_units(self):
        sample = {
            'quality': 'MEASURED', 'truncated': False,
            'processes': [
                {'identity_valid': True, 'quality': 'MEASURED', 'metrics': {
                    'pss_bytes': 10, 'rss_bytes': 20, 'cpu_ns': 30,
                    'thread_count': 1, 'fd_count': 2, 'private_bytes': 12,
                }},
                {'identity_valid': True, 'quality': 'MEASURED', 'metrics': {
                    'pss_bytes': 11, 'rss_bytes': 21, 'cpu_ns': 31,
                    'thread_count': 3, 'fd_count': 4, 'private_bytes': 13,
                }},
            ],
        }
        self.assertEqual(rc0.aggregate_process_tree(sample), {
            'quality': 'MEASURED',
            'metrics': {
                'pss_bytes': 21, 'rss_bytes': 41, 'cpu_ns': 61,
                'thread_count': 4, 'fd_count': 6, 'private_bytes': 25,
            },
        })

    def test_process_tree_totals_are_unknown_not_zero_when_any_input_is_unknown(self):
        sample = {
            'quality': 'UNKNOWN', 'truncated': True,
            'processes': [{'identity_valid': True, 'quality': 'MEASURED', 'metrics': {
                'pss_bytes': 10, 'rss_bytes': None, 'cpu_ns': 30,
                'thread_count': 1, 'fd_count': 2,
            }}],
        }
        totals = rc0.aggregate_process_tree(sample)
        self.assertEqual(totals['quality'], 'UNKNOWN')
        self.assertIsNone(totals['metrics']['pss_bytes'])
        self.assertIsNone(totals['metrics']['rss_bytes'])

    def test_aggregate_math_stays_exact_beyond_javascript_safe_integer(self):
        # JC-RES-012.G analogue on the offline harness: PSS/RSS totals must be summed as
        # exact integers (never floats) even above 2**53 and up to the u64 wire maximum.
        above_safe = 2 ** 53 + 1
        u64_max = 2 ** 64 - 1
        sample = {
            'quality': 'MEASURED', 'truncated': False,
            'processes': [{
                'identity_valid': True, 'quality': 'MEASURED',
                'metrics': {'pss_bytes': above_safe, 'rss_bytes': u64_max, 'cpu_ns': 1,
                            'thread_count': 1, 'fd_count': 1},
            }],
        }
        totals = rc0.aggregate_process_tree(sample)
        self.assertEqual(totals['quality'], 'MEASURED')
        self.assertEqual(totals['metrics']['pss_bytes'], above_safe)
        self.assertEqual(totals['metrics']['rss_bytes'], u64_max)
        self.assertIsInstance(totals['metrics']['pss_bytes'], int)
        self.assertEqual(json.loads(json.dumps(totals))['metrics']['pss_bytes'], above_safe)
        self.assertEqual(rc0.is_canonical_decimal(str(u64_max)), True)

    def test_aggregate_overflow_past_u64_wire_max_is_unknown(self):
        u64_max = 2 ** 64 - 1
        sample = {
            'quality': 'MEASURED', 'truncated': False,
            'processes': [
                {'identity_valid': True, 'quality': 'MEASURED',
                 'metrics': {'pss_bytes': u64_max, 'rss_bytes': 1, 'cpu_ns': 1,
                             'thread_count': 1, 'fd_count': 1}},
                {'identity_valid': True, 'quality': 'MEASURED',
                 'metrics': {'pss_bytes': 1, 'rss_bytes': 1, 'cpu_ns': 1,
                             'thread_count': 1, 'fd_count': 1}},
            ],
        }
        totals = rc0.aggregate_process_tree(sample)
        self.assertEqual(totals['quality'], 'UNKNOWN')
        self.assertTrue(all(value is None for value in totals['metrics'].values()))

    def test_boolean_or_float_metrics_are_unknown_not_summed(self):
        for bad in (True, 1.5, -1, '10'):
            with self.subTest(bad=bad):
                sample = {
                    'quality': 'MEASURED', 'truncated': False,
                    'processes': [{
                        'identity_valid': True, 'quality': 'MEASURED',
                        'metrics': {'pss_bytes': bad, 'rss_bytes': 1, 'cpu_ns': 1,
                                    'thread_count': 1, 'fd_count': 1},
                    }],
                }
                totals = rc0.aggregate_process_tree(sample)
                self.assertEqual(totals['quality'], 'UNKNOWN')
                self.assertIsNone(totals['metrics']['pss_bytes'])

    def test_cross_tree_aggregation_rejects_shared_process_identity(self):
        first = measured_session('s1')['sample']
        second = measured_session('s2')['sample']
        self.assertEqual(rc0.aggregate_process_trees([first, second])['quality'], 'MEASURED')
        second['processes'][0]['pid'] = first['processes'][0]['pid']
        second['processes'][0]['start_identity'] = first['processes'][0]['start_identity']
        totals = rc0.aggregate_process_trees([first, second])
        self.assertEqual(totals['quality'], 'UNKNOWN')
        self.assertIsNone(totals['metrics']['pss_bytes'])

class Rc0BudgetTests(unittest.TestCase):
    def test_source_read_cannot_exceed_remaining_byte_budget(self):
        with temporary_directory() as directory:
            path = Path(directory) / 'sample'
            path.write_bytes(b'12345678')
            budget = rc0.Budget(max_bytes=8, max_work=2)
            with self.assertRaisesRegex(ValueError, 'byte budget'):
                rc0.read_limited(path, budget)
            self.assertEqual(budget.bytes, 8)
            self.assertEqual(budget.work, 1)

    def test_work_counter_stops_at_configured_limit(self):
        budget = rc0.Budget(max_bytes=8, max_work=1)
        budget.charge_work()
        with self.assertRaisesRegex(ValueError, 'work budget'):
            budget.charge_work()


class Rc0InputBoundTests(unittest.TestCase):
    def test_identity_session_key_is_bounded(self):
        self.assertEqual(rc0.identity_arg('s=1:2'), ('s', 1, 2))
        with self.assertRaises(argparse.ArgumentTypeError):
            rc0.identity_arg('s' * (rc0.MAX_SESSION_ID_BYTES + 1) + '=1:2')

    def test_outcomes_reject_duplicate_properties(self):
        with temporary_directory() as directory:
            path = Path(directory) / 'outcomes.json'
            path.write_text('{"s":{"expected":"a","expected":"b"}}', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate JSON property'):
                rc0.load_outcomes(path)

    def test_outcomes_enforce_byte_and_session_count_bounds(self):
        with temporary_directory() as directory:
            path = Path(directory) / 'outcomes.json'
            path.write_bytes(b' ' * (rc0.MAX_OUTCOMES_BYTES + 1))
            with self.assertRaisesRegex(ValueError, '1 MiB input bound'):
                rc0.load_outcomes(path)
            path.write_text(json.dumps({f's{i}': {} for i in range(21)}), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'more than 20 Session IDs'):
                rc0.load_outcomes(path)

    def test_caller_inputs_are_repository_local_and_do_not_follow_symlinks(self):
        with temporary_directory() as directory:
            root = Path(directory)
            target = root / 'outcomes.json'
            target.write_text('{}', encoding='utf-8')
            link = root / 'linked.json'
            link.symlink_to(target)
            with self.assertRaisesRegex(ValueError, 'without following links'):
                rc0.load_outcomes(link)

            directory_link = root / 'directory-link'
            directory_link.symlink_to(root, target_is_directory=True)
            with self.assertRaisesRegex(ValueError, 'directory traversal failed safely'):
                rc0.load_outcomes(directory_link / 'outcomes.json')

            if hasattr(os, 'mkfifo'):
                fifo = root / 'outcomes.fifo'
                os.mkfifo(fifo)
                with self.assertRaisesRegex(ValueError, 'regular file'):
                    rc0.load_outcomes(fifo)

        with self.assertRaisesRegex(ValueError, 'inside the repository'):
            rc0.load_outcomes(Path('/outside-agentx/outcomes.json'))


class Rc0DeterministicCohortTests(unittest.TestCase):
    def test_preflight_rejects_capture_matrix_overflow(self):
        pid, start = (101, 1)
        selected = {f's{i:02}': (pid + i, start + i) for i in range(21)}
        outcomes = {session: {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}
                    for session in selected}
        ready, record = rc0.preflight(selected, outcomes, preflight_args(), 'abc123', True,
                                      machine_metadata(), 1)
        self.assertFalse(ready)
        self.assertTrue(any('at most 20 Session identities' in item
                            for item in record['missing_inputs']))


class Rc0ChildFenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = temporary_directory()
        self.proc_root = Path(self.directory.name)
        child_file = self.proc_root / '10' / 'task' / '10' / 'children'
        child_file.parent.mkdir(parents=True)
        child_file.write_text('11', encoding='ascii')

    def tearDown(self):
        self.directory.cleanup()

    def test_parent_pid_reuse_during_child_walk_is_rejected(self):
        with patch.object(rc0, 'PROC_ROOT', self.proc_root), patch.object(
            rc0, 'proc_identity', side_effect=[(1, 0), (2, 10), (9, 0)]
        ):
            with self.assertRaisesRegex(ValueError, 'parent identity changed'):
                rc0.children(10, 1, rc0.Budget())

    def test_reparented_child_is_not_returned_as_owned(self):
        with patch.object(rc0, 'PROC_ROOT', self.proc_root), patch.object(
            rc0, 'proc_identity', side_effect=[(1, 0), (2, 99)]
        ):
            with self.assertRaisesRegex(ValueError, 'reparented'):
                rc0.children(10, 1, rc0.Budget())

    def test_child_reparented_after_enumeration_is_not_attributed_to_owner_tree(self):
        with temporary_directory() as directory:
            proc_root = Path(directory)
            write_process(proc_root, 10, 1, 1, [11])
            write_process(proc_root, 11, 2, 10, [])
            real_children = rc0.children

            def reparent_after_validation(parent_pid, parent_start, budget):
                children = real_children(parent_pid, parent_start, budget)
                if parent_pid == 10:
                    # Model the race after the child's final identity/parent check but
                    # before sample_tree dequeues and samples that child.
                    (proc_root / '11' / 'stat').write_text(
                        stat_text(11, 2, 99), encoding='ascii'
                    )
                return children

            with patch.object(rc0, 'PROC_ROOT', proc_root), patch.object(
                rc0, 'children', side_effect=reparent_after_validation
            ):
                result = rc0.sample_tree(10, 1)

        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertEqual([item['pid'] for item in result['processes']], [10, 11])
        self.assertFalse(result['processes'][1]['identity_valid'])
        self.assertEqual(result['processes'][1]['reason'], 'parent_identity_mismatch')
        self.assertEqual(result['processes'][1]['metrics'], {})

    def test_reused_parent_pid_generation_does_not_authorize_queued_child(self):
        with temporary_directory() as directory:
            proc_root = Path(directory)
            write_process(proc_root, 10, 1, 1, [11])
            write_process(proc_root, 11, 2, 10, [])
            real_children = rc0.children

            def reuse_parent_after_validation(parent_pid, parent_start, budget):
                children = real_children(parent_pid, parent_start, budget)
                if parent_pid == 10:
                    # The child still reports PPID 10, but it now names a
                    # different process generation than the sampled owner.
                    (proc_root / '10' / 'stat').write_text(
                        stat_text(10, 99, 1), encoding='ascii'
                    )
                return children

            with patch.object(rc0, 'PROC_ROOT', proc_root), patch.object(
                rc0, 'children', side_effect=reuse_parent_after_validation
            ):
                result = rc0.sample_tree(10, 1)

        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertFalse(result['processes'][1]['identity_valid'])
        self.assertEqual(result['processes'][1]['reason'], 'parent_identity_mismatch')
        self.assertEqual(result['processes'][1]['metrics'], {})

    def test_reparented_intermediate_ancestor_does_not_authorize_queued_grandchild(self):
        with temporary_directory() as directory:
            proc_root = Path(directory)
            write_process(proc_root, 10, 1, 1, [11])
            write_process(proc_root, 11, 2, 10, [12])
            write_process(proc_root, 12, 3, 11, [])
            write_process(proc_root, 99, 8, 1, [])
            real_children = rc0.children

            def reparent_intermediate_after_enumeration(parent_pid, parent_start, budget):
                children = real_children(parent_pid, parent_start, budget)
                if parent_pid == 11:
                    # The grandchild remains under PID 11, but PID 11 is no
                    # longer a descendant of the sampled owner by dequeue time.
                    (proc_root / '11' / 'stat').write_text(
                        stat_text(11, 2, 99), encoding='ascii'
                    )
                return children

            with patch.object(rc0, 'PROC_ROOT', proc_root), patch.object(
                rc0, 'children', side_effect=reparent_intermediate_after_enumeration
            ):
                result = rc0.sample_tree(10, 1)

        self.assertEqual(result['quality'], 'UNKNOWN')
        grandchild = next(item for item in result['processes'] if item['pid'] == 12)
        self.assertFalse(grandchild['identity_valid'])
        self.assertEqual(grandchild['metrics'], {})


def stat_text(pid, start, parent):
    fields = ['0'] * 20
    fields[0] = 'S'
    fields[1] = str(parent)
    fields[11] = '1'
    fields[12] = '1'
    fields[19] = str(start)
    return f'{pid} (p{pid}) {" ".join(fields)}\n'


def write_process(proc_root, pid, start, parent, children):
    root = proc_root / str(pid)
    (root / 'fd').mkdir(parents=True)
    task = root / 'task' / str(pid)
    task.mkdir(parents=True)
    (task / 'children').write_text(' '.join(str(child) for child in children), encoding='ascii')
    (root / 'stat').write_text(stat_text(pid, start, parent), encoding='ascii')
    (root / 'status').write_text('VmRSS: 20 kB\nThreads: 2\n', encoding='ascii')
    (root / 'smaps_rollup').write_text(
        'Pss: 10 kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\nPrivate_Hugetlb: 1 kB\n',
        encoding='ascii',
    )


class Rc0LinuxCounterTests(unittest.TestCase):
    def setUp(self):
        self.directory = temporary_directory()
        self.proc_root = Path(self.directory.name)
        write_process(self.proc_root, 123, 77, 1, [])
        for name in ('0', '1'):
            (self.proc_root / '123' / 'fd' / name).touch()

    def tearDown(self):
        self.directory.cleanup()

    def counters(self):
        with patch.object(rc0, 'PROC_ROOT', self.proc_root):
            return rc0.linux_counters(123, rc0.Budget())

    def test_counts_include_private_bytes_from_the_same_smaps_read(self):
        counters, reasons = self.counters()
        self.assertEqual(counters['pss_bytes'], 10 * 1024)
        self.assertEqual(counters['rss_bytes'], 20 * 1024)
        self.assertEqual(counters['thread_count'], 2)
        self.assertEqual(counters['fd_count'], 2)
        self.assertEqual(counters['private_bytes'], 6 * 1024)
        self.assertEqual(counters['cpu_ns'], 2 * 1_000_000_000 // os.sysconf('SC_CLK_TCK'))
        self.assertEqual(reasons, {})

    def test_missing_private_fields_are_unknown_not_a_partial_sum(self):
        (self.proc_root / '123' / 'smaps_rollup').write_text(
            'Pss: 10 kB\nPrivate_Clean: 2 kB\n', encoding='ascii'
        )
        counters, reasons = self.counters()
        self.assertEqual(counters['pss_bytes'], 10 * 1024)
        self.assertIsNone(counters['private_bytes'])
        self.assertEqual(reasons['private_bytes'], 'missing_private_fields')

    def test_missing_smaps_marks_pss_and_private_unknown_with_reason(self):
        (self.proc_root / '123' / 'smaps_rollup').unlink()
        counters, reasons = self.counters()
        self.assertIsNone(counters['pss_bytes'])
        self.assertIsNone(counters['private_bytes'])
        self.assertIn('pss_bytes', reasons)
        self.assertIn('private_bytes', reasons)

    def test_permission_denied_smaps_is_unknown_with_reason(self):
        real_read_limited = rc0.read_limited

        def denied(path, budget, per_file_limit=rc0.MAX_BYTES):
            if path.name == 'smaps_rollup':
                raise PermissionError('denied')
            return real_read_limited(path, budget, per_file_limit)

        with patch.object(rc0, 'PROC_ROOT', self.proc_root), patch.object(
            rc0, 'read_limited', side_effect=denied
        ):
            counters, reasons = rc0.linux_counters(123, rc0.Budget())
        self.assertIsNone(counters['pss_bytes'])
        self.assertIsNone(counters['private_bytes'])
        self.assertEqual(reasons['pss_bytes'], 'permission_denied')
        self.assertEqual(reasons['private_bytes'], 'permission_denied')


class Rc0SmapsPrivateBytesTests(unittest.TestCase):
    def test_private_bytes_requires_all_three_fields(self):
        complete = 'Pss: 1 kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\nPrivate_Hugetlb: 1 kB\n'
        self.assertEqual(rc0.smaps_private_bytes(complete), 6 * 1024)
        self.assertIsNone(rc0.smaps_private_bytes('Private_Clean: 2 kB\nPrivate_Dirty: 3 kB\n'))
        self.assertIsNone(
            rc0.smaps_private_bytes(
                'Private_Clean: bad\nPrivate_Dirty: 3 kB\nPrivate_Hugetlb: 1 kB\n'
            )
        )


@unittest.skipUnless(platform.system() == 'Linux', 'Linux /proc harness')
class Rc0SampleTreeTests(unittest.TestCase):
    def setUp(self):
        self.directory = temporary_directory()
        self.proc_root = Path(self.directory.name)
        write_process(self.proc_root, 10, 1, 1, [11])
        write_process(self.proc_root, 11, 2, 10, [])
        write_process(self.proc_root, 99, 8, 1, [])

    def tearDown(self):
        self.directory.cleanup()

    def test_tree_walk_measures_only_owned_descendants(self):
        with patch.object(rc0, 'PROC_ROOT', self.proc_root):
            result = rc0.sample_tree(10, 1)
        self.assertEqual(result['quality'], 'MEASURED')
        self.assertFalse(result['truncated'])
        self.assertEqual(sorted(item['pid'] for item in result['processes']), [10, 11])
        for item in result['processes']:
            self.assertTrue(item['identity_valid'])
            self.assertEqual(item['quality'], 'MEASURED')
            self.assertEqual(item['metrics']['pss_bytes'], 10 * 1024)
            self.assertEqual(item['metrics']['private_bytes'], 6 * 1024)

    def test_stale_owner_start_identity_yields_unknown_without_metrics(self):
        with patch.object(rc0, 'PROC_ROOT', self.proc_root):
            result = rc0.sample_tree(10, 999)
        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertFalse(result['truncated'])
        self.assertEqual(result['processes'][0]['identity_valid'], False)
        self.assertEqual(result['processes'][0]['metrics'], {})

    def test_owner_missing_before_sampling_is_an_explicit_unknown_scope(self):
        with patch.object(rc0, 'PROC_ROOT', self.proc_root):
            result = rc0.sample_tree(777, 1)
        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertTrue(result['truncated'])
        self.assertEqual(result['processes'], [])

    def test_child_exit_during_walk_keeps_scope_explicit(self):
        # The child is enumerated, then disappears before it is sampled: the walk must not
        # crash and must not attribute counters to the stale PID; the explicit result is a
        # partial tree (owner measured, aggregate UNKNOWN).
        real_identity = rc0.proc_identity
        calls = {'pid11': 0}

        def flaky(pid, budget):
            if pid == 11:
                calls['pid11'] += 1
                if calls['pid11'] >= 3:
                    raise FileNotFoundError('child exited')
            return real_identity(pid, budget)

        with patch.object(rc0, 'PROC_ROOT', self.proc_root), patch.object(
            rc0, 'proc_identity', side_effect=flaky
        ):
            result = rc0.sample_tree(10, 1)
        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertTrue(result['truncated'])
        self.assertEqual([item['pid'] for item in result['processes']], [10])
        self.assertEqual(result['processes'][0]['quality'], 'MEASURED')
        self.assertEqual(calls['pid11'], 3)


@unittest.skipUnless(platform.system() == 'Linux', 'Linux /proc harness')
class Rc0SelfcheckTests(unittest.TestCase):
    def test_selfcheck_measures_its_own_bounded_tree(self):
        ok, record = rc0.run_selfcheck()
        self.assertTrue(ok, record)
        self.assertEqual(record['status'], 'MEASURED')
        self.assertEqual(record['quality'], 'MEASURED')
        self.assertFalse(record['truncated'])
        self.assertIn(os.getpid(), record['pids'])
        self.assertGreaterEqual(len(record['pids']), 2)
        for process in record['processes']:
            for metric in rc0.REQUIRED_LINUX_METRICS:
                self.assertIsNotNone(process['metrics'].get(metric), process)


def preflight_args(**changes):
    defaults = {
        'scenario': 'ten direct coding sessions with identical tasks',
        'build': 'release rustc 1.98.1',
        'warm_cold': 'warm',
        'provider_model': 'local/model',
        'harness': 'hzcode-tui',
        'local_inference': 'excluded',
        'local_inference_identity': None,
        'outcomes': None,
        'output': None,
        'min_sessions': 1,
    }
    defaults.update(changes)
    return argparse.Namespace(**defaults)


def live_identity():
    """A real, currently live (pid, start_identity) pair for this test process."""
    with open(f'/proc/{os.getpid()}/stat', 'rb') as stream:
        text = stream.read().decode('utf-8')
    fields = text[text.rfind(')') + 2:].split()
    return os.getpid(), int(fields[19])


def machine_metadata():
    return {'processor': platform.processor() or 'test-cpu', 'logical_cpu_count': 8,
            'memory_bytes': 16 * 1024 * 1024 * 1024}


@unittest.skipUnless(platform.system() == 'Linux', 'Linux /proc harness')
class Rc0PreflightTests(unittest.TestCase):
    def check(self, selected, outcomes, args, commit='abc123', clean_tree=True,
              local_inference_sample=None):
        return rc0.preflight(dict(selected), outcomes, args, commit, clean_tree,
                             machine_metadata(), args.min_sessions)

    def test_live_identities_with_passed_outcomes_are_unverified_inputs_only(self):
        pid, start = live_identity()
        selected = {'ses-live': (pid, start)}
        outcomes = {'ses-live': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        ready, record = self.check(selected, outcomes, preflight_args())
        self.assertTrue(ready, record['missing_inputs'])
        self.assertEqual(record['status'], 'INPUTS_UNVERIFIED_COMPLETE')
        self.assertEqual(record['input_provenance'], 'UNVERIFIED_CALLER_SUPPLIED')
        self.assertFalse(record['release_eligible'])
        self.assertFalse(record['baseline_eligible'])
        self.assertIn('attestation', record['blocked_reason'])
        self.assertFalse(record['measurement_performed'])
        self.assertIn('--identity ses-live=', record['capture_command'])
        self.assertIn('rc0.py', record['capture_command'])

    def test_dead_or_reused_identity_is_not_ready(self):
        pid, start = live_identity()
        selected = {'ses-dead': (pid, start + 1)}
        outcomes = {'ses-dead': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        ready, record = self.check(selected, outcomes, preflight_args())
        self.assertFalse(ready)
        self.assertTrue(any('start identity mismatch' in item for item in record['missing_inputs']),
                        record['missing_inputs'])

    def test_missing_or_unpassed_outcomes_are_not_ready(self):
        pid, start = live_identity()
        selected = {'ses-a': (pid, start)}
        ready, record = self.check(selected, {}, preflight_args())
        self.assertFalse(ready)
        self.assertTrue(any('task outcome is missing' in item for item in record['missing_inputs']))
        outcomes = {'ses-a': {'expected': 'ok', 'actual': 'failed', 'status': 'failed'}}
        ready, record = self.check(selected, outcomes, preflight_args())
        self.assertFalse(ready)
        self.assertTrue(any('did not pass' in item for item in record['missing_inputs']))

    def test_extra_outcomes_and_insufficient_sessions_are_not_ready(self):
        pid, start = live_identity()
        selected = {'ses-a': (pid, start)}
        outcomes = {
            'ses-a': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'},
            'ses-ghost': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'},
        }
        ready, record = self.check(selected, outcomes, preflight_args(min_sessions=2))
        self.assertFalse(ready)
        self.assertTrue(any('identities: 1 supplied, 2 required' in item
                            for item in record['missing_inputs']), record['missing_inputs'])
        self.assertTrue(any('without identities' in item for item in record['missing_inputs']))

    def test_duplicate_process_identity_across_sessions_is_not_ready(self):
        pid, start = live_identity()
        selected = {'ses-a': (pid, start), 'ses-b': (pid, start)}
        outcomes = {session: {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}
                    for session in selected}
        ready, record = self.check(selected, outcomes, preflight_args(min_sessions=2))
        self.assertFalse(ready)
        self.assertTrue(any('duplicate owner process identity' in item
                            for item in record['missing_inputs']))

    def test_local_inference_decision_and_identity_are_required(self):
        pid, start = live_identity()
        selected = {'ses-a': (pid, start)}
        outcomes = {'ses-a': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        ready, record = self.check(selected, outcomes, preflight_args(local_inference='included'))
        self.assertFalse(ready)
        self.assertTrue(any('requires --local-inference-identity' in item
                            for item in record['missing_inputs']))
        inference_pid = os.getppid()
        inference_start, _parent = rc0.proc_identity(inference_pid, rc0.Budget())
        ready, record = self.check(
            selected, outcomes,
            preflight_args(local_inference='included',
                           local_inference_identity=('local/model', inference_pid, inference_start)))
        self.assertTrue(ready, record['missing_inputs'])
        self.assertFalse(record['measurement_performed'])
        self.assertTrue(record['local_inference_owner']['identity_matches'])
        ready, record = self.check(
            selected, outcomes,
            preflight_args(local_inference='excluded',
                           local_inference_identity=('local/model', inference_pid, inference_start)))
        self.assertFalse(ready)
        self.assertTrue(any('excluded but a local-inference identity was supplied' in item
                            for item in record['missing_inputs']))

    def test_cli_preflight_checks_local_inference_identity_without_sampling(self):
        with temporary_directory() as directory:
            outcomes_path = Path(directory) / 'outcomes.json'
            outcomes_path.write_text(json.dumps({
                'ses-a': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'},
            }), encoding='utf-8')
            argv = [
                'rc0.py', '--preflight', '--min-sessions', '1', '--scenario', 'task',
                '--build', 'debug test build', '--warm-cold', 'warm',
                '--provider-model', 'local/model', '--harness', 'hzcode-tui',
                '--local-inference', 'included', '--identity', 'ses-a=101:11',
                '--local-inference-identity', 'model=202:22', '--outcomes', str(outcomes_path),
            ]
            output = io.StringIO()
            with patch.object(sys, 'argv', argv), \
                 patch.object(rc0, 'git_metadata', return_value=('a' * 40, True)), \
                 patch.object(rc0, 'hardware_metadata', return_value=machine_metadata()), \
                 patch.object(rc0, 'proc_identity', side_effect=[(11, 1), (22, 1)]), \
                 patch.object(rc0, 'sample_tree', side_effect=AssertionError('preflight sampled')), \
                 contextlib.redirect_stdout(output):
                self.assertEqual(rc0.main(), 0)

        record = json.loads(output.getvalue())
        self.assertEqual(record['status'], 'INPUTS_UNVERIFIED_COMPLETE')
        self.assertFalse(record['measurement_performed'])
        self.assertEqual(record['local_inference_owner']['pid'], 202)
        self.assertTrue(record['local_inference_owner']['identity_matches'])

    def test_dirty_tree_and_missing_metadata_are_not_ready(self):
        pid, start = live_identity()
        selected = {'ses-a': (pid, start)}
        outcomes = {'ses-a': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        ready, record = self.check(selected, outcomes, preflight_args(), clean_tree=False)
        self.assertFalse(ready)
        self.assertTrue(any('clean working tree' in item for item in record['missing_inputs']))
        args = preflight_args()
        ready, record = rc0.preflight(dict(selected), outcomes, args, 'abc123', True, {}, 1)
        self.assertFalse(ready)
        self.assertTrue(any('machine metadata' in item for item in record['missing_inputs']))


class Rc0ProvenanceGateTests(unittest.TestCase):
    """Fabricated caller inputs must never look owner-verified or release-eligible."""

    def test_no_trusted_attestation_source_is_configured_yet(self):
        self.assertEqual(rc0.TRUSTED_ATTESTATION_SOURCES, ())
        with self.assertRaises(ValueError):
            rc0.AttestationV1(source='self-declared', commit='abc123',
                              session_ids=('s1',), run_ids=('run-a',))

    def test_well_shaped_inputs_without_owner_attestation_are_not_eligible(self):
        selected = [('s1', (101, 1)), ('s2', (102, 2))]
        results = [measured_session('s1'), measured_session('s2')]
        outcomes = {session: {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}
                    for session in ('s1', 's2')}
        common = dict(selected=selected, session_results=results, outcomes=outcomes,
                      commit='abc123', clean_tree=True, provider_model='provider/model',
                      build='release rustc pinned', harness='native',
                      local_inference='excluded')
        self.assertFalse(rc0.baseline_eligible(**common))
        # A dictionary that merely mimics an attestation is not a typed attestation.
        self.assertFalse(rc0.baseline_eligible(
            attestation={'source': 'self-declared', 'commit': 'abc123',
                         'session_ids': ('s1', 's2'), 'run_ids': ('run-a',)},
            **common))


class Rc0UnsupportedPlatformPreflightTests(unittest.TestCase):
    def test_non_linux_preflight_reports_unsupported_instead_of_mislabeling_processes_dead(self):
        selected = {'session-a': (101, 1)}
        outcomes = {'session-a': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        args = preflight_args(
            local_inference='included',
            local_inference_identity=('local-model', 202, 2),
        )
        with patch.object(rc0.platform, 'system', return_value='Windows'), \
             patch.object(rc0, 'proc_identity', side_effect=AssertionError(
                 'unsupported platforms must not probe Linux /proc')):
            ready, record = rc0.preflight(
                selected, outcomes, args, 'abc123', True, machine_metadata(), 1,
            )

        self.assertFalse(ready)
        self.assertEqual(record['status'], 'INPUTS_INCOMPLETE')
        self.assertTrue(any('UNSUPPORTED_PLATFORM' in item for item in record['missing_inputs']))
        self.assertEqual(record['sessions'][0]['identity_status'], 'UNSUPPORTED_PLATFORM')
        self.assertEqual(record['local_inference_owner']['identity_status'], 'UNSUPPORTED_PLATFORM')
        self.assertFalse(record['release_eligible'])
        self.assertFalse(record['baseline_eligible'])

    @unittest.skipUnless(platform.system() == 'Linux', 'Linux /proc harness')
    def test_fabricated_identity_and_outcomes_are_not_owner_verified(self):
        child = subprocess.Popen(['sleep', '0'])
        child.wait()
        fabricated = {'ses-fabricated': (child.pid, 1)}
        outcomes = {'ses-fabricated': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        args = preflight_args()
        ready, record = rc0.preflight(fabricated, outcomes, args, 'abc123', True,
                                      machine_metadata(), 1)
        self.assertFalse(ready)
        self.assertEqual(record['status'], 'INPUTS_INCOMPLETE')
        self.assertFalse(record['release_eligible'])
        self.assertFalse(record['baseline_eligible'])
        self.assertEqual(record['input_provenance'], 'UNVERIFIED_CALLER_SUPPLIED')
        self.assertTrue(record['missing_inputs'])

        # A live caller-supplied PID with a passed caller-supplied outcome is
        # well-shaped but still never owner-verified.
        pid, start = live_identity()
        live = {'ses-live': (pid, start)}
        outcomes = {'ses-live': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}
        ready, record = rc0.preflight(live, outcomes, args, 'abc123', True,
                                      machine_metadata(), 1)
        self.assertTrue(ready, record['missing_inputs'])
        self.assertEqual(record['status'], 'INPUTS_UNVERIFIED_COMPLETE')
        self.assertFalse(record['release_eligible'])
        self.assertFalse(record['baseline_eligible'])
        self.assertIn('attestation', record['blocked_reason'])

    @unittest.skipUnless(platform.system() == 'Linux', 'Linux /proc harness')
    def test_capture_output_is_labeled_provisional_raw_sample(self):
        pid, start = live_identity()
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            outcomes_path = Path(directory) / 'outcomes.json'
            output_path = Path(directory) / 'rc0.jsonl'
            outcomes_path.write_text(json.dumps(
                {'ses-live': {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}}),
                encoding='utf-8')
            argv = [
                'rc0.py', '--scenario', 'provisional capture', '--build', 'release rustc 1.98.1',
                '--warm-cold', 'warm', '--provider-model', 'local/model', '--harness', 'hzcode-tui',
                '--local-inference', 'excluded', '--identity', f'ses-live={pid}:{start}',
                '--outcomes', str(outcomes_path), '--output', str(output_path),
            ]
            with patch.object(sys, 'argv', argv):
                self.assertEqual(rc0.main(), 0)
            records = [json.loads(line) for line in
                       output_path.read_text(encoding='utf-8').splitlines() if line.strip()]
        self.assertEqual(len(records), len(rc0.SCENARIOS))
        for record in records:
            self.assertEqual(record['record_type'], 'rc0_sample')
            self.assertEqual(record['status'], 'NOT_BASELINE')
            self.assertTrue(record['provisional_raw_sample'])
            self.assertFalse(record['release_eligible'])
            self.assertFalse(record['baseline_eligible'])
            self.assertEqual(record['input_provenance'], 'UNVERIFIED_CALLER_SUPPLIED')
            self.assertIn('attestation', record['blocked_reason'])


class Rc0OwnerSampleAggregationTests(unittest.TestCase):
    def test_owner_metrics_reject_values_for_unknown_and_noncanonical_numbers(self):
        with self.assertRaisesRegex(ValueError, 'UNKNOWN metric must carry a canonical reason'):
            rc0._validate_owner_metric({'quality': 'UNKNOWN', 'value': '0'}, 'metric')
        with self.assertRaisesRegex(ValueError, 'UNKNOWN metric must carry a canonical reason'):
            rc0._validate_owner_metric({'quality': 'UNKNOWN', 'reason': 'invented'}, 'metric')
        with self.assertRaisesRegex(ValueError, 'canonical nonnegative decimal'):
            rc0._validate_owner_metric({'quality': 'MEASURED', 'value': '00'}, 'metric')

    def test_owner_metrics_accept_the_rust_unknown_reason_projection(self):
        # Rust serializes UNKNOWN as {quality, reason}; it never emits a value.
        rc0._validate_owner_metric(
            {'quality': 'UNKNOWN', 'reason': 'PERMISSION_DENIED'}, 'metric')
        rc0._validate_owner_metric(
            {'quality': 'MEASURED', 'value': '0'}, 'metric')

    def test_owner_metrics_reject_unicode_decimal_digits(self):
        with self.assertRaisesRegex(ValueError, 'canonical nonnegative decimal'):
            rc0._validate_owner_metric(
                {'quality': 'MEASURED', 'value': '٠'}, 'metric')

    def test_owner_snapshot_ingest_rejects_duplicate_json_properties(self):
        with temporary_directory() as directory:
            path = Path(directory) / 'owner.json'
            path.write_text('{"schemaVersion":1,"schemaVersion":1}', encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'duplicate JSON property'):
                rc0.load_owner_snapshot(path)

    def test_owner_snapshot_rejects_boolean_schema_version(self):
        with temporary_directory() as directory:
            path = Path(directory) / 'owner.json'
            path.write_text('{"schemaVersion":true}', encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'schemaVersion must be 1, 2, or 3'):
                rc0.load_owner_snapshot(path)

    def test_owner_snapshot_ingests_rust_unknowns_and_preserves_worker_attribution(self):
        measured = {'quality': 'MEASURED', 'value': '0'}
        unknown = {'quality': 'UNKNOWN', 'reason': 'PERMISSION_DENIED'}
        metrics = {
            'pssBytes': measured, 'rssBytes': measured, 'cpuNs': unknown,
            'threadCount': measured, 'fdCount': measured, 'privateBytes': unknown,
        }
        snapshot = {
            'schemaVersion': 3,
            'producer': 'horizoncode.worker-owner.resource-sampler',
            'owner': {
                'principalRef': 'server_auth:test', 'workspaceBinding': 'workspace-a',
                'sessionId': 'session-a', 'runId': 'run-a', 'taskId': 'task-a',
                'attemptId': 'attempt-a', 'ownerEpoch': '1',
            },
            'ownerLog': {
                'ownerId': 'worker-pool-a', 'sequence': '4',
                'eventDigest': 'blake3:' + 'a' * 64, 'workerPoolRevision': '3',
            },
            'sampledAtMs': '10', 'sampleSequence': '2',
            'sessionProcessOwner': {'status': 'NOT_PROVIDED', 'processIdentity': None, 'metrics': None},
            'workers': [{
                'workerExecutionId': 'worker-a', 'taskId': 'task-a', 'attemptId': 'attempt-a',
                'sourceRevision': 'blake3:' + 'b' * 64,
                'reservationState': 'QUARANTINED', 'quality': 'UNKNOWN',
                'metrics': metrics, 'processes': [],
            }],
            'aggregate': metrics,
            'resourceLimits': [
                {'dimension': dimension, 'status': 'UNSUPPORTED', 'enforced': False,
                 'reason': 'worker OS quota backend is not integrated'}
                for dimension in ('cpuTime', 'memory', 'processCount', 'fileDescriptors')
            ],
            'productAttestation': {
                'status': 'NOT_ATTESTED', 'hostRunReceiptRef': None,
                'independentVerifierEvidenceRef': None,
                'sourceCommit': None,
                'required': ['hostRunReceiptRef', 'independentVerifierEvidenceRef', 'sourceCommit'],
            },
        }
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parents[2]) as directory:
            path = Path(directory) / 'owner.json'
            path.write_text(json.dumps(snapshot), encoding='utf-8')
            ingested = rc0.load_owner_snapshot(path)
            self.assertEqual(
                ingested['workers'][0]['source_revision'],
                'blake3:' + 'b' * 64,
            )
            claimed_attested = json.loads(json.dumps(snapshot))
            claimed_attested['productAttestation'] = {
                'status': 'ATTESTED',
                'hostRunReceiptRef': 'caller-receipt',
                'independentVerifierEvidenceRef': 'caller-evidence',
                'sourceCommit': 'abc123',
                'required': ['hostRunReceiptRef', 'independentVerifierEvidenceRef', 'sourceCommit'],
            }
            path.write_text(json.dumps(claimed_attested), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'accurately state NOT_ATTESTED'):
                rc0.load_owner_snapshot(path)

            duplicate_worker = json.loads(json.dumps(snapshot))
            duplicate_worker['workers'].append(json.loads(json.dumps(duplicate_worker['workers'][0])))
            path.write_text(json.dumps(duplicate_worker), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate workerExecutionId'):
                rc0.load_owner_snapshot(path)

            duplicate_attempt = json.loads(json.dumps(snapshot))
            second_worker = json.loads(json.dumps(duplicate_attempt['workers'][0]))
            second_worker['workerExecutionId'] = 'worker-b'
            duplicate_attempt['workers'].append(second_worker)
            path.write_text(json.dumps(duplicate_attempt), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate Task/Attempt identity'):
                rc0.load_owner_snapshot(path)

            overlapping_process = json.loads(json.dumps(snapshot))
            first_worker = overlapping_process['workers'][0]
            first_worker['processes'] = [{'pid': 77, 'startIdentity': '8'}]
            second_worker = json.loads(json.dumps(first_worker))
            second_worker['workerExecutionId'] = 'worker-b'
            second_worker['attemptId'] = 'attempt-b'
            overlapping_process['workers'].append(second_worker)
            path.write_text(json.dumps(overlapping_process), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'overlapping worker process identities'):
                rc0.load_owner_snapshot(path)

            snapshot['workers'][0].pop('sourceRevision')
            path.write_text(json.dumps(snapshot), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'worker source revision is invalid'):
                rc0.load_owner_snapshot(path)
            snapshot['workers'][0]['sourceRevision'] = 'blake3:' + 'b' * 64
            snapshot['sessionProcessOwner'] = {
                'status': 'MEASURED',
                'processIdentity': {
                    'pid': True, 'startIdentity': '77', 'ownerEpoch': '1',
                    'processIncarnation': 'inc-1',
                    'executableIdentityDigest': 'blake3:' + 'a' * 64,
                },
                'metrics': metrics,
            }
            path.write_text(json.dumps(snapshot), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Core process owner identity is invalid'):
                rc0.load_owner_snapshot(path)

        self.assertEqual(ingested['workers'][0]['worker_execution_id'], 'worker-a')
        self.assertEqual((ingested['task_id'], ingested['attempt_id']), ('task-a', 'attempt-a'))
        self.assertEqual(ingested['workers'][0]['metrics']['cpuNs'], unknown)
        self.assertEqual(len(ingested['resource_limits']), 4)
        self.assertEqual(ingested['resource_limits_provenance'], 'UNVERIFIED_CALLER_SUPPLIED')

    def test_owner_snapshot_never_accepts_monitoring_as_os_enforcement(self):
        # Start from the complete schema-2 shape used above and alter only the
        # resource-limit claim. Caller-authored counters cannot become proof.
        snapshot = {
            'schemaVersion': 2,
            'producer': 'horizoncode.worker-owner.resource-sampler',
            'owner': {
                'principalRef': 'server_auth:test', 'workspaceBinding': 'workspace-a',
                'sessionId': 'session-a', 'runId': 'run-a', 'taskId': 'task-a',
                'attemptId': 'attempt-a', 'ownerEpoch': '1',
            },
            'ownerLog': {
                'ownerId': 'worker-pool-a', 'sequence': '4',
                'eventDigest': 'blake3:' + 'a' * 64, 'workerPoolRevision': '3',
            },
            'sampledAtMs': '10', 'sampleSequence': '2',
            'sessionProcessOwner': {'status': 'NOT_PROVIDED', 'processIdentity': None, 'metrics': None},
            'workers': [],
            'aggregate': {name: {'quality': 'UNKNOWN', 'reason': 'UNAVAILABLE'} for name in (
                'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')},
            'resourceLimits': [
                {'dimension': dimension, 'status': 'UNSUPPORTED', 'enforced': False,
                 'reason': 'worker OS quota backend is not integrated'}
                for dimension in ('cpuTime', 'memory', 'processCount', 'fileDescriptors')
            ],
            'productAttestation': {
                'status': 'NOT_ATTESTED', 'hostRunReceiptRef': None,
                'independentVerifierEvidenceRef': None,
                'sourceCommit': None,
                'required': ['hostRunReceiptRef', 'independentVerifierEvidenceRef', 'sourceCommit'],
            },
        }
        snapshot['resourceLimits'][0] = {
            'dimension': 'cpuTime', 'status': 'MONITORING_ONLY', 'enforced': True,
            'observed': '100', 'reason': None,
        }
        with temporary_directory() as directory:
            path = Path(directory) / 'owner.json'
            path.write_text(json.dumps(snapshot), encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'monitoring-only resource limit claims enforcement'):
                rc0.load_owner_snapshot(path)

    def test_shared_reported_core_process_is_counted_once_but_unattested(self):
        metrics = {name: {'quality': 'MEASURED', 'value': '5'} for name in (
            'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')}
        owner = {
            'pid': 901, 'start_identity': '77', 'owner_epoch': '4',
            'process_incarnation': 'inc-4',
            'executable_identity_digest': 'blake3:' + 'a' * 64,
        }
        samples = [{
            'worker_count': 0,
            'workers': [],
            'process_identities': [],
            # The supplied aggregate includes the Core process in each
            # Session sample. Duplicated aggregates must not be summed.
            'aggregate': {name: {'quality': 'MEASURED', 'value': '5'} for name in metrics},
            'session_process_owner': owner,
            'session_process_metrics': metrics,
            'sample_sequence': sequence,
        } for sequence in (1, 2)]

        result = rc0.aggregate_owner_samples(samples)

        self.assertEqual(result['core_process_sample_count'], 2)
        self.assertEqual(result['core_process_count'], 1)
        self.assertEqual(result['session_process_owner_metrics']['pssBytes']['value'], '5')
        self.assertEqual(result['combined_metrics']['pssBytes']['value'], '5')
        self.assertEqual(result['quality'], 'MEASURED')
        self.assertEqual(result['source_provenance'], 'UNVERIFIED_CALLER_SUPPLIED')
        self.assertEqual(result['attestation'], 'NOT_ATTESTED')
        self.assertEqual(result['product_attribution'], 'UNAVAILABLE')

    def test_worker_rows_are_summed_and_shared_core_is_added_once(self):
        core_metrics = {name: {'quality': 'MEASURED', 'value': '5'} for name in (
            'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')}
        worker_metrics = {name: {'quality': 'MEASURED', 'value': '7'} for name in core_metrics}
        result = rc0.aggregate_owner_samples([{
            'worker_count': 1,
            'sample_sequence': 1,
            'workers': [{'metrics': worker_metrics}],
            'process_identities': [{'pid': 902, 'start_identity': '78'}],
            # Aggregate is 12, but is intentionally not the source used for
            # the worker total because it already includes the Core process.
            'aggregate': {name: {'quality': 'MEASURED', 'value': '12'} for name in core_metrics},
            'session_process_owner': {
                'pid': 901, 'start_identity': '77', 'owner_epoch': '4',
                'process_incarnation': 'inc-4',
                'executable_identity_digest': 'blake3:' + 'a' * 64,
            },
            'session_process_metrics': core_metrics,
        }])

        self.assertEqual(result['metrics']['pssBytes']['value'], '7')
        self.assertEqual(result['session_process_owner_metrics']['pssBytes']['value'], '5')
        self.assertEqual(result['combined_metrics']['pssBytes']['value'], '12')
        self.assertEqual(result['source_provenance'], 'UNVERIFIED_CALLER_SUPPLIED')
        self.assertEqual(result['attestation'], 'NOT_ATTESTED')
        self.assertEqual(result['product_attribution'], 'UNAVAILABLE')

    def test_owner_sample_worker_and_combined_totals_reject_u64_overflow(self):
        u64_max = str((1 << 64) - 1)
        names = ('pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')
        measured = lambda value: {name: {'quality': 'MEASURED', 'value': value} for name in names}

        worker_overflow = rc0.aggregate_owner_samples([{
            'worker_count': 2,
            'sample_sequence': 1,
            'workers': [{'metrics': measured(u64_max)}, {'metrics': measured('1')}],
            'process_identities': [
                {'pid': 910, 'start_identity': '90'},
                {'pid': 911, 'start_identity': '91'},
            ],
            'aggregate': measured(u64_max),
            'session_process_owner': None,
            'session_process_metrics': None,
        }])
        self.assertEqual(worker_overflow['metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertIsNone(worker_overflow['metrics']['pssBytes']['value'])

        combined_overflow = rc0.aggregate_owner_samples([{
            'worker_count': 1,
            'sample_sequence': 1,
            'workers': [{'metrics': measured('1')}],
            'process_identities': [{'pid': 912, 'start_identity': '92'}],
            'aggregate': measured(u64_max),
            'session_process_owner': {
                'pid': 901, 'start_identity': '77', 'owner_epoch': '4',
                'process_incarnation': 'inc-4',
                'executable_identity_digest': 'blake3:' + 'a' * 64,
            },
            'session_process_metrics': measured(u64_max),
        }])
        self.assertEqual(combined_overflow['combined_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertIsNone(combined_overflow['combined_metrics']['pssBytes']['value'])

    def test_unknown_core_owner_keeps_combined_resource_truth_unknown(self):
        metrics = {name: {'quality': 'MEASURED', 'value': '0'} for name in (
            'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')}
        result = rc0.aggregate_owner_samples([{
            'worker_count': 0,
            'sample_sequence': 1,
            'process_identities': [],
            'aggregate': metrics,
            'session_process_owner': None,
            'session_process_metrics': None,
        }])

        self.assertEqual(result['session_process_owner_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertEqual(result['combined_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertEqual(result['quality'], 'UNKNOWN')

    def test_latest_shared_core_unknown_sample_is_not_hidden_by_older_measurement(self):
        measured = {name: {'quality': 'MEASURED', 'value': '5'} for name in (
            'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')}
        latest = dict(measured)
        latest['pssBytes'] = {'quality': 'UNKNOWN', 'value': None, 'reason': 'permission_denied'}
        owner = {
            'pid': 901, 'start_identity': '77', 'owner_epoch': '4',
            'process_incarnation': 'inc-4',
            'executable_identity_digest': 'blake3:' + 'a' * 64,
        }
        samples = [
            {'sample_sequence': 1, 'worker_count': 0, 'workers': [], 'process_identities': [],
             'aggregate': measured, 'session_process_owner': owner,
             'session_process_metrics': measured},
            {'sample_sequence': 2, 'worker_count': 0, 'workers': [], 'process_identities': [],
             'aggregate': latest, 'session_process_owner': owner,
             'session_process_metrics': latest},
        ]

        result = rc0.aggregate_owner_samples(samples)

        self.assertEqual(result['session_process_owner_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertEqual(result['combined_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertEqual(result['quality'], 'UNKNOWN')


class Rc0LeakSlopeTests(unittest.TestCase):
    def test_constant_pss_reports_a_zero_slope(self):
        slope = rc0.leak_slope([(1_000, 500), (2_000, 500), (3_000, 500)])
        self.assertEqual(slope['quality'], 'MEASURED')
        self.assertEqual(slope['slope_bytes_per_hour'], '0.0')
        self.assertEqual(slope['sample_count'], 3)
        self.assertEqual(slope['window_ms'], 2_000)

    def test_growth_and_shrink_slopes_use_exact_integer_math(self):
        # +150 bytes over 30 minutes -> 300.0 bytes/hour.
        growth = rc0.leak_slope([(0, 100), (1_800_000, 250)])
        self.assertEqual(growth['slope_bytes_per_hour'], '300.0')
        # -90 bytes over 60 minutes -> -90.0 bytes/hour; shrink is never clamped.
        shrink = rc0.leak_slope([(0, 500), (3_600_000, 410)])
        self.assertEqual(shrink['slope_bytes_per_hour'], '-90.0')

    def test_one_tenth_rounding_is_deterministic(self):
        # 1 byte over 3600 s = 1.0 B/h; 1 byte over 7200 s = 0.5 B/h rounds
        # through integer math, never floating point.
        self.assertEqual(rc0.leak_slope([(0, 0), (3_600_000, 1)])['slope_bytes_per_hour'], '1.0')
        self.assertEqual(rc0.leak_slope([(0, 0), (7_200_000, 1)])['slope_bytes_per_hour'], '0.5')
        # 7 bytes over 8 hours = 0.875 B/h -> nearest tenth is 0.9.
        self.assertEqual(rc0.leak_slope([(0, 0), (28_800_000, 7)])['slope_bytes_per_hour'], '0.9')

    def test_single_or_empty_series_is_unknown_not_zero(self):
        for series in ([], [(1_000, 10)]):
            slope = rc0.leak_slope(series)
            self.assertEqual(slope['quality'], 'UNKNOWN')
            self.assertIsNone(slope['slope_bytes_per_hour'])

    def test_non_increasing_timestamps_are_unknown(self):
        slope = rc0.leak_slope([(2_000, 10), (2_000, 20)])
        self.assertEqual(slope['quality'], 'UNKNOWN')

    def test_negative_or_boolean_inputs_are_unknown(self):
        self.assertEqual(rc0.leak_slope([(0, -1), (1_000, 5)])['quality'], 'UNKNOWN')
        self.assertEqual(rc0.leak_slope([(0, True), (1_000, 5)])['quality'], 'UNKNOWN')
        self.assertEqual(rc0.leak_slope([(False, 1), (1_000, 5)])['quality'], 'UNKNOWN')

    def test_series_above_the_sample_bound_is_unknown(self):
        series = [(index * 1_000, 10) for index in range(rc0.MAX_LEAK_SLOPE_SAMPLES + 1)]
        self.assertEqual(rc0.leak_slope(series)['quality'], 'UNKNOWN')

    def test_raw_endpoints_are_retained_for_review(self):
        slope = rc0.leak_slope([(1_000, 10), (4_000, 40)])
        self.assertEqual(slope['first'], {'timestamp_ms': '1000', 'pss_bytes': '10'})
        self.assertEqual(slope['last'], {'timestamp_ms': '4000', 'pss_bytes': '40'})


class Rc0DiskRootTests(unittest.TestCase):
    def test_measures_regular_files_without_following_symlinks(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            (root / 'build').mkdir()
            (root / 'build' / 'a.bin').write_bytes(b'x' * 100)
            (root / 'build' / 'nested').mkdir()
            (root / 'build' / 'nested' / 'b.bin').write_bytes(b'y' * 250)
            outside = root / 'outside.bin'
            outside.write_bytes(b'z' * 1_000)
            link = root / 'build' / 'escape'
            try:
                link.symlink_to(outside)
            except OSError:
                self.skipTest('symlinks are unavailable here')
            result = rc0.repository_tree_bytes(root / 'build')
        self.assertEqual(result['quality'], 'MEASURED')
        self.assertEqual(result['bytes'], '350')
        self.assertEqual(result['file_count'], '2')
        self.assertEqual(result['special_entry_count'], '1', 'the symlink is counted, never followed')

    def test_missing_root_is_unknown_not_zero(self):
        result = rc0.repository_tree_bytes('scripts/perf/definitely-missing-dir')
        self.assertEqual(result['quality'], 'UNKNOWN')
        self.assertIsNone(result['bytes'])

    def test_parent_traversal_and_outside_paths_are_rejected(self):
        for path in ('../outside', '/etc'):
            with self.assertRaises(ValueError, msg=path):
                rc0.repository_tree_bytes(path)

    def test_symlinked_root_is_unknown_not_followed(self):
        with temporary_directory() as tmp:
            root = Path(tmp)
            real = root / 'real'
            real.mkdir()
            (real / 'f.bin').write_bytes(b'x' * 8)
            link = root / 'link'
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError:
                self.skipTest('symlinks are unavailable here')
            result = rc0.repository_tree_bytes(link)
        self.assertEqual(result['quality'], 'UNKNOWN')


class Rc0CacheEvidenceTests(unittest.TestCase):
    def envelope(self, **overrides):
        value = {
            'schemaVersion': 1,
            'producer': 'horizoncode.worker-owner.cache-registry',
            'families': [{
                'family': 'syntax', 'principal': 'principal-a', 'workspace': 'workspace-a',
                'sourceGeneration': 'gen-1', 'buildVersion': 'build-1', 'generation': '1',
                'allocatedBytes': '30', 'accountedSourceBytes': None, 'entryCount': '1',
                'maxBytes': '1024', 'maxAccountedSourceBytes': '1024', 'maxEntries': '128',
                'ttlMs': '100', 'lastUsedMs': '5', 'protection': 'DERIVED_READ_ONLY',
                'ownerPinCount': '0', 'pinned': False, 'evictionPending': False,
                'evictionOwner': rc0.CACHE_EVICTION_OWNER,
            }],
            'measuredBytes': '30', 'measuredEntries': '1', 'accountedSourceBytes': None,
            'evictionOwner': rc0.CACHE_EVICTION_OWNER,
            'reclaimedBytes': None,
            'reclaimedBytesNote': 'physical reclaimed bytes remain unknown until the next '
                                  'authenticated post-retirement observation',
        }
        value.update(overrides)
        return value

    def write(self, tmp, value):
        path = Path(tmp) / 'cache-evidence.json'
        path.write_text(json.dumps(value), encoding='utf-8')
        return path

    def test_valid_envelope_ingests_with_bounds_and_owner(self):
        with temporary_directory() as tmp:
            envelope = rc0.load_cache_evidence(self.write(tmp, self.envelope()))
        row = envelope['families'][0]
        self.assertEqual(row['maxBytes'], '1024')
        self.assertEqual(row['maxEntries'], '128')
        self.assertEqual(row['evictionOwner'], rc0.CACHE_EVICTION_OWNER)
        self.assertIsNone(envelope['reclaimedBytes'])

    def test_unknown_allocation_stays_null_never_zero(self):
        envelope = self.envelope()
        envelope['families'][0]['allocatedBytes'] = None
        envelope['families'][0]['entryCount'] = None
        envelope['measuredBytes'] = None
        envelope['measuredEntries'] = None
        with temporary_directory() as tmp:
            loaded = rc0.load_cache_evidence(self.write(tmp, envelope))
        self.assertIsNone(loaded['families'][0]['allocatedBytes'])
        self.assertIsNone(loaded['measuredBytes'])

    def test_reclaimed_bytes_claim_is_rejected(self):
        with temporary_directory() as tmp:
            with self.assertRaisesRegex(ValueError, 'reclaimed'):
                rc0.load_cache_evidence(self.write(tmp, self.envelope(reclaimedBytes='10')))

    def test_wrong_eviction_owner_is_rejected(self):
        envelope = self.envelope()
        envelope['families'][0]['evictionOwner'] = 'caller-chosen-owner'
        with temporary_directory() as tmp:
            with self.assertRaisesRegex(ValueError, 'eviction owner'):
                rc0.load_cache_evidence(self.write(tmp, envelope))

    def test_allocation_over_declared_bound_is_rejected(self):
        envelope = self.envelope()
        envelope['families'][0]['allocatedBytes'] = '2048'
        envelope['measuredBytes'] = '2048'
        with temporary_directory() as tmp:
            with self.assertRaisesRegex(ValueError, 'exceeds'):
                rc0.load_cache_evidence(self.write(tmp, envelope))

    def test_noncanonical_protection_class_is_rejected(self):
        envelope = self.envelope()
        envelope['families'][0]['protection'] = 'DERIVED'
        with temporary_directory() as tmp:
            with self.assertRaisesRegex(ValueError, 'protection'):
                rc0.load_cache_evidence(self.write(tmp, envelope))

    def test_duplicate_family_key_is_rejected(self):
        envelope = self.envelope()
        envelope['families'] = [envelope['families'][0], dict(envelope['families'][0])]
        with temporary_directory() as tmp:
            with self.assertRaisesRegex(ValueError, 'repeats one family key'):
                rc0.load_cache_evidence(self.write(tmp, envelope))

    def test_duplicate_json_properties_are_rejected(self):
        raw = ('{"schemaVersion": 1, "producer": "horizoncode.worker-owner.cache-registry",'
               ' "families": [], "measuredBytes": null, "measuredEntries": null,'
               ' "accountedSourceBytes": null, "evictionOwner": "hostkernel.cache-owner",'
               ' "reclaimedBytes": null, "reclaimedBytesNote": "note",'
               ' "reclaimedBytes": null}')
        with temporary_directory() as tmp:
            path = Path(tmp) / 'dup.json'
            path.write_text(raw, encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'duplicate'):
                rc0.load_cache_evidence(path)


if __name__ == '__main__':
    unittest.main()
