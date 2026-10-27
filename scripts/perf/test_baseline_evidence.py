"""Item 46 — 1/5/10/20 paired-baseline evidence harness tests.

The harness must stay NOT_RUN with an exact reason while workload authority and
trusted attestation are absent, and must never write fabricated rows into
docs/performance/evidence/.
"""
import contextlib
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import rc0
import baseline_evidence as be

SOURCE = 'horizoncore.owner.v1'
KEY = b'\x55' * 32
COMMIT = 'abc123'
MATCHED = {
    'provider_model': 'provider/model@1',
    'task_set_digest': 'sha256:' + 'e' * 64,
    'tools': ['bash', 'edit', 'grep'],
    'permissions': 'workspace-write+ask',
    'budgets': {'tokens': '100000', 'cost_micros': '0'},
    'environment': {'os': 'linux', 'container': 'none'},
    'machine': {'processor': 'test-cpu', 'logical_cpu_count': 8,
                'memory_bytes': 34359738368},
    'task_repo_commit': 'f' * 40,
}


def signed_attestation(selected, outcomes, commit=COMMIT):
    """Test-fixture attestation bound to these exact sessions/commit/outcomes.

    Built like the rc0 suite's adversarial fixtures: construction is bypassed so
    fixtures do not need a configured registry, but the object must still pass
    verify_attestation (configured registry) and attestation_covers before any
    evaluation accepts it.
    """
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


def scenario_entry(n):
    selected = [(f's{n}-{i}', (1000 + 10 * n + i, i + 1)) for i in range(n)]
    outcomes = {session: {'expected': 'ok', 'actual': 'ok', 'status': 'passed'}
                for session, _ in selected}
    attestation = signed_attestation(selected, outcomes)
    return {
        'selected': selected,
        'outcomes': outcomes,
        'attestation': attestation,
        'capture_records': [{
            'record_type': 'rc0_sample',
            'commit': COMMIT,
            'commit_exact': True,
            'sessions_requested': n,
            'release_eligible': True,
            'baseline_eligible': True,
            'status': 'BASELINE',
            'provisional_raw_sample': False,
            'owner_sample_attestation': 'ATTESTED',
            'owner_attestation_source': attestation.source,
            'owner_attestation_signature_digest': attestation.source_signature_digest,
        }],
    }


def complete_candidate():
    return {
        'commit': COMMIT,
        'scenarios': {str(n): scenario_entry(n) for n in be.SCENARIOS},
        'arms': {
            'baseline': {'harness': 'opencode-baseline', **MATCHED},
            'horizoncode': {'harness': 'hzcode-tui', **MATCHED},
        },
    }


@contextlib.contextmanager
def configured_trusted_source():
    """Test-only stand-in for a landed, configured trusted source."""
    with patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES', (SOURCE,)), \
         patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                    {SOURCE: rc0.hmac_sha256_verifier(KEY)}), \
         patch.object(rc0, 'landed_hostrun_contract_gaps', return_value=[]):
        yield


@contextlib.contextmanager
def authorized_workload():
    with patch.object(be, 'WORKLOAD_AUTHORIZATION', {
            'granted_by': 'parent-test-stand-in',
            'scope': 'rc0-paired-baseline',
            'scenarios': list(be.SCENARIOS),
    }):
        yield


class BaselineEvidenceAuthorityTests(unittest.TestCase):
    def assert_not_run(self, result, reason_fragment):
        self.assertEqual(result['status'], 'NOT_RUN')
        self.assertEqual(result['rows'], [])
        self.assertIn(reason_fragment, result['reason'])

    def test_production_authority_is_absent_so_the_matrix_stays_not_run(self):
        # No parent authorization and empty trusted registries in this checkout.
        self.assertIsNone(be.WORKLOAD_AUTHORIZATION)
        result = be.evaluate_baseline_evidence(complete_candidate())
        self.assert_not_run(result, 'workload_authorization_absent')
        self.assertEqual(rc0.attestation_registry_status()['status'],
                         'NOT_CONFIGURED')

    def test_authorization_alone_cannot_produce_rows_without_a_trusted_source(self):
        with authorized_workload():
            result = be.evaluate_baseline_evidence(complete_candidate())
        self.assert_not_run(result, 'trusted_attestation_not_configured')

    def test_incomplete_scenario_matrix_is_not_run(self):
        candidate = complete_candidate()
        del candidate['scenarios']['10']
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(candidate)
        self.assert_not_run(result, 'scenario_matrix_incomplete')
        self.assertIn('10', result['reason'])

    def test_attestation_must_cover_every_scenario(self):
        candidate = complete_candidate()
        # A genuine attestation for a different Session set cannot cover 5.
        other = [(f'other-{i}', (7000 + i, i + 1)) for i in range(5)]
        other_outcomes = {session: {'expected': 'ok', 'actual': 'ok',
                                    'status': 'passed'} for session, _ in other}
        candidate['scenarios']['5']['attestation'] = signed_attestation(
            other, other_outcomes)
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(candidate)
        self.assert_not_run(result, 'attestation_not_covering_scenario_5')

    def test_matched_arm_pins_must_be_identical(self):
        candidate = complete_candidate()
        candidate['arms']['baseline']['provider_model'] = 'other/model@1'
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(candidate)
        self.assert_not_run(result, 'matched_arm_incomplete')
        self.assertIn('provider_model', result['reason'])

    def test_capture_records_must_come_from_the_attested_producer(self):
        candidate = complete_candidate()
        candidate['scenarios']['20']['capture_records'][0]['release_eligible'] = False
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(candidate)
        self.assert_not_run(result, 'capture_records_not_release_eligible')

    def test_capture_rows_must_match_exact_attestation_and_baseline_state(self):
        variants = (
            ("owner_sample_attestation", "NOT_ATTESTED"),
            ("owner_attestation_source", "foreign.source.v1"),
            ("owner_attestation_signature_digest", "sha256:" + "0" * 64),
            ("baseline_eligible", False),
            ("status", "NOT_BASELINE"),
            ("provisional_raw_sample", True),
            ("commit_exact", False),
        )
        for field, value in variants:
            candidate = complete_candidate()
            candidate["scenarios"]["5"]["capture_records"][0][field] = value
            with self.subTest(field=field), authorized_workload(), \
                    configured_trusted_source():
                result = be.evaluate_baseline_evidence(candidate)
            self.assert_not_run(result, "capture_record_provenance_incomplete")

    def test_complete_authorized_candidate_produces_ready_rows(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        self.assertEqual(result['status'], 'READY')
        self.assertIsNone(result['reason'])
        self.assertEqual([row['scenario'] for row in result['rows']],
                         list(be.SCENARIOS))
        for row in result['rows']:
            self.assertTrue(row['release_eligible'])
            self.assertEqual(row['attestation_source'], SOURCE)
            self.assertTrue(str(row['evidence_path']).startswith(
                'docs/performance/evidence/'))
            self.assertEqual(row['record_type'], 'rc0_baseline_evidence')


class BaselineEvidencePathAndWriteTests(unittest.TestCase):
    def test_evidence_path_is_repository_prefixed_without_traversal(self):
        self.assertEqual(str(be.evidence_path(1)),
                         'docs/performance/evidence/rc0-baseline-1-sessions.jsonl')
        with self.assertRaises(ValueError):
            be.evidence_path(3)

    def test_not_run_results_are_never_writable(self):
        result = be.evaluate_baseline_evidence(complete_candidate())
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, 'not READY'):
                be.append_evidence(result, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_ready_result_constructor_requires_private_evaluator_capability(self):
        with self.assertRaisesRegex(TypeError, "only be minted"):
            be._EvaluatorIssuedReadyResult(
                {"status": "READY"}, object(), {}, ())

    def test_fabricated_ready_mapping_cannot_bypass_evaluation_gates(self):
        fabricated = {
            "status": "READY",
            "reason": None,
            "authorization": {"scope": "rc0-paired-baseline"},
            "rows": [{
                "record_type": "rc0_baseline_evidence",
                "scenario": n,
                "release_eligible": True,
            } for n in be.SCENARIOS],
        }
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, "evaluator-issued"):
                be.append_evidence(fabricated, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_mutated_evaluator_ready_result_cannot_be_written(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        self.assertEqual(result["status"], "READY")
        result["rows"][0]["commit"] = "tampered-commit"
        with authorized_workload(), configured_trusted_source(), \
                tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, "evaluator-issued"):
                be.append_evidence(result, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_serialized_ready_result_loses_append_capability(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        restored = json.loads(json.dumps(result))
        with authorized_workload(), configured_trusted_source(), \
                tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, "evaluator-issued"):
                be.append_evidence(restored, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_hidden_authorization_snapshot_mutation_invalidates_ready_result(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            replacement = {
                'granted_by': 'replacement-hidden-grantor',
                'scope': be.AUTHORIZATION_SCOPE,
                'scenarios': list(be.SCENARIOS),
            }
            result._EvaluatorIssuedReadyResult__authorization = (
                be._canonical_json_bytes(replacement))
            self.assertFalse(result._is_intact())
            with patch.object(be, 'WORKLOAD_AUTHORIZATION', replacement), \
                    tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                with self.assertRaisesRegex(ValueError, 'evaluator-issued'):
                    be.append_evidence(result, directory)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_hidden_verifier_snapshot_mutation_invalidates_ready_result(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            replacement_verifier = rc0.hmac_sha256_verifier(b'v' * 32)
            result._EvaluatorIssuedReadyResult__verifier_snapshot = (
                (SOURCE, replacement_verifier),)
            self.assertFalse(result._is_intact())
            with patch.dict(rc0.TRUSTED_ATTESTATION_VERIFIERS,
                            {SOURCE: replacement_verifier}, clear=True), \
                    tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                with self.assertRaisesRegex(ValueError, 'evaluator-issued'):
                    be.append_evidence(result, directory)
                self.assertEqual(list(Path(directory).iterdir()), [])

    def test_ready_result_cannot_be_appended_under_replaced_workload_grant(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        replacement = {
            'granted_by': 'replacement-test-grantor',
            'scope': be.AUTHORIZATION_SCOPE,
            'scenarios': list(be.SCENARIOS),
        }
        with patch.object(be, 'WORKLOAD_AUTHORIZATION', replacement), \
                configured_trusted_source(), \
                tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, 'authorization changed'):
                be.append_evidence(result, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_ready_result_cannot_be_appended_after_its_verifier_is_replaced(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        replacement_source = SOURCE + '.replacement'
        with authorized_workload(), \
                patch.object(rc0, 'TRUSTED_ATTESTATION_SOURCES',
                             (replacement_source,)), \
                patch.object(rc0, 'TRUSTED_ATTESTATION_VERIFIERS', {
                    replacement_source: rc0.hmac_sha256_verifier(KEY),
                }), \
                patch.object(rc0, 'landed_hostrun_contract_gaps', return_value=[]), \
                tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, 'attestation source.*changed'):
                be.append_evidence(result, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_ready_result_cannot_be_appended_after_trusted_source_revocation(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        with authorized_workload(), tempfile.TemporaryDirectory(
                dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, "trusted attestation"):
                be.append_evidence(result, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_ready_result_cannot_be_appended_after_authority_is_revoked(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            with self.assertRaisesRegex(ValueError, "workload authorization"):
                be.append_evidence(result, directory)
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_ready_rows_append_once_and_refuse_overwrite(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                paths = be.append_evidence(result, directory)
                self.assertEqual(len(paths), len(be.SCENARIOS) + 1)
                self.assertEqual(paths[-1].name, 'rc0-baseline-matrix.complete.json')
                for path in paths[:-1]:
                    lines = [json.loads(line) for line in
                             path.read_text(encoding='utf-8').splitlines() if line.strip()]
                    self.assertEqual(len(lines), 1)
                    self.assertTrue(lines[0]['release_eligible'])
                matrix = be.load_complete_matrix(directory)
                self.assertEqual(matrix['commit_state'], 'COMMITTED')
                self.assertEqual(matrix['trust'], 'UNVERIFIED')
                self.assertFalse(matrix['aggregation_eligible'])
                self.assertFalse(matrix['attestation_eligible'])
                self.assertNotEqual(matrix.get('status'), 'PASS')
                self.assertEqual([row['scenario'] for row in matrix['rows']],
                                 list(be.SCENARIOS))
                with self.assertRaisesRegex(ValueError, 'already exists'):
                    be.append_evidence(result, directory)

    def test_injected_failure_between_rows_has_no_commit_marker(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                real_fsync = be.os.fsync
                syncs = 0

                def fail_after_first_row(descriptor):
                    nonlocal syncs
                    syncs += 1
                    if syncs == 1:
                        raise OSError('injected failure between evidence rows')
                    return real_fsync(descriptor)

                with patch.object(be.os, 'fsync', side_effect=fail_after_first_row):
                    with self.assertRaisesRegex(OSError, 'injected failure between evidence rows'):
                        be.append_evidence(result, directory)
                partial_rows = list(Path(directory).glob('rc0-baseline-*-sessions.jsonl'))
                self.assertEqual(len(partial_rows), 1)
                self.assertFalse((Path(directory) / 'rc0-baseline-matrix.complete.json').exists())
                loader = getattr(be, 'load_complete_matrix', None)
                self.assertTrue(callable(loader),
                                'consumers need a complete-matrix validation API')
                if callable(loader):
                    with self.assertRaisesRegex(ValueError, 'incomplete|manifest'):
                        loader(directory)

    def test_loader_rejects_marker_when_temporary_hardlink_retirement_fails(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                real_write = be._write_new_private_file
                real_unlink = be.os.unlink
                temporary_names = []

                def fail_temporary_link_retirement(name, *, dir_fd=None):
                    if temporary_names and name == temporary_names[0]:
                        raise OSError('injected temporary-link retirement failure')
                    return real_unlink(name, dir_fd=dir_fd)

                def write_marker_then_inject_unlink(directory_fd, name, payload, purpose):
                    real_write(directory_fd, name, payload, purpose)
                    if purpose == 'temporary commit marker':
                        temporary_names.append(name)
                        be.os.unlink = fail_temporary_link_retirement

                try:
                    with patch.object(
                            be, '_write_new_private_file',
                            side_effect=write_marker_then_inject_unlink):
                        with self.assertRaisesRegex(
                                ValueError, 'temporary link could not be retired'):
                            be.append_evidence(result, directory)
                finally:
                    be.os.unlink = real_unlink

                self.assertEqual(len(temporary_names), 1)
                temporary = Path(directory) / temporary_names[0]
                marker = Path(directory) / 'rc0-baseline-matrix.complete.json'
                self.assertTrue(temporary.is_file())
                self.assertTrue(marker.is_file())
                self.assertEqual(temporary.stat().st_ino, marker.stat().st_ino)
                self.assertEqual(marker.stat().st_nlink, 2)
                with self.assertRaisesRegex(ValueError, 'private regular-file checks'):
                    be.load_complete_matrix(directory)

    def test_loader_rejects_malformed_commit_marker(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            marker = Path(directory) / 'rc0-baseline-matrix.complete.json'
            marker.write_text('{', encoding='utf-8')
            marker.chmod(0o600)
            with self.assertRaisesRegex(ValueError, 'malformed evidence commit manifest'):
                be.load_complete_matrix(directory)

    def test_loader_rejects_mismatched_commit_marker_digest(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                paths = be.append_evidence(result, directory)
                marker = paths[-1]
                payload = json.loads(marker.read_text(encoding='utf-8'))
                payload['matrixDigest'] = 'sha256:' + '0' * 64
                marker.write_text(
                    json.dumps(payload, sort_keys=True, separators=(',', ':')),
                    encoding='utf-8')
                with self.assertRaisesRegex(ValueError, 'commit manifest digest mismatch'):
                    be.load_complete_matrix(directory)
    def test_loader_rejects_row_digest_mismatch(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                paths = be.append_evidence(result, directory)
                paths[0].write_bytes(paths[0].read_bytes() + b' ')
                with self.assertRaisesRegex(ValueError, 'evidence row digest mismatch'):
                    be.load_complete_matrix(directory)

    def test_append_refuses_symlinked_destination_component(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                root = Path(directory)
                target = root / "target"
                target.mkdir()
                link = root / "destination-link"
                try:
                    link.symlink_to(target, target_is_directory=True)
                except OSError:
                    self.skipTest("symlinks are unavailable here")
                with self.assertRaisesRegex(ValueError, "symlink|safe"):
                    be.append_evidence(result, link)
                self.assertEqual(list(target.iterdir()), [])

    def test_append_refuses_root_path_rebound_to_contained_decoy(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                decoy_root = Path(directory) / 'decoy-root'
                decoy_root.mkdir()
                simulated_module = decoy_root / 'scripts' / 'perf' / 'baseline_evidence.py'
                destination = decoy_root / 'evidence'
                with patch.object(be, '__file__', str(simulated_module)):
                    with self.assertRaisesRegex(
                            ValueError, 'trusted repository root identity'):
                        be.append_evidence(result, destination)
                self.assertFalse(destination.exists())

class BaselineEvidenceLoaderSymlinkAndMarkerIsolationTests(unittest.TestCase):
    """Audit g9/g10 — LOAD-side symlink denial and marker-name isolation.

    Append-side symlink denial is already locked by
    ``test_append_refuses_symlinked_destination_component``. These tests lock
    the loader's ``O_DIRECTORY|O_NOFOLLOW`` traversal and identity checks
    (baseline_evidence.py:336-399, :573-583, :687-689) plus the
    marker-name-specific no-overwrite branches (:536-537 and :649-650) that the
    existing second-append test never reaches alone because it fails on the
    first row name. The source already denies all of these, so each test is a
    GREEN regression lock; no production change is required.
    """

    def committed_matrix(self, destination):
        """Produce a genuine committed matrix through the evaluator path."""
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            return be.append_evidence(result, destination)

    def test_loader_refuses_symlinked_destination_directory(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            real = root / 'real-destination'
            real.mkdir()
            self.committed_matrix(real)
            link = root / 'destination-link'
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError:
                self.skipTest('symlinks are unavailable here')
            with self.assertRaisesRegex(ValueError, 'safely without following links'):
                be.load_complete_matrix(link)
            # The identical real directory still loads: the refusal is link-specific.
            self.assertEqual(
                be.load_complete_matrix(real)['commit_state'], 'COMMITTED')

    def test_loader_refuses_symlinked_intermediate_component_below_repo_root(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            real = root / 'real-tree'
            sub = real / 'sub'
            sub.mkdir(parents=True)
            self.committed_matrix(sub)
            link = root / 'tree-link'
            try:
                link.symlink_to(real, target_is_directory=True)
            except OSError:
                self.skipTest('symlinks are unavailable here')
            # ``tree-link`` is an intermediate component of this destination path.
            with self.assertRaisesRegex(ValueError, 'safely without following links'):
                be.load_complete_matrix(link / 'sub')
            self.assertEqual(
                be.load_complete_matrix(sub)['commit_state'], 'COMMITTED')

    def test_loader_refuses_symlinked_commit_marker_file(self):
        with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
            root = Path(directory)
            destination = root / 'destination'
            destination.mkdir()
            paths = self.committed_matrix(destination)
            marker = paths[-1]
            backup = destination / (be.COMMIT_MARKER_NAME + '.genuine-backup')
            marker.replace(backup)
            decoy = root / 'decoy-marker.json'
            decoy.write_text('{"decoy": true}\n', encoding='utf-8')
            decoy.chmod(0o600)
            try:
                marker.symlink_to(decoy)
            except OSError:
                backup.replace(marker)
                self.skipTest('symlinks are unavailable here')
            try:
                # The symlink targets a well-formed private regular file, so the
                # refusal must come from O_NOFOLLOW, not permission/shape checks.
                with self.assertRaisesRegex(
                        ValueError,
                        'evidence commit manifest cannot be opened safely'):
                    be.load_complete_matrix(destination)
            finally:
                marker.unlink()
                backup.replace(marker)
            self.assertEqual(
                be.load_complete_matrix(destination)['commit_state'], 'COMMITTED')

    def test_second_append_is_refused_by_commit_marker_name_precheck(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                destination = Path(directory)
                paths = be.append_evidence(result, directory)
                marker = paths[-1]
                marker_bytes = marker.read_bytes()
                # Remove only the row files so the second append walks past the
                # missing row names and reaches the marker-name branch alone.
                for row_path in paths[:-1]:
                    row_path.unlink()
                with self.assertRaisesRegex(
                        ValueError,
                        'evidence file already exists: '
                        + be.COMMIT_MARKER_NAME
                        + '; refusing to overwrite or merge evidence'):
                    be.append_evidence(result, directory)
                self.assertEqual(marker.read_bytes(), marker_bytes)
                self.assertEqual(
                    list(destination.glob('rc0-baseline-*-sessions.jsonl')), [])
                with self.assertRaisesRegex(ValueError, 'evidence row is missing'):
                    be.load_complete_matrix(directory)

    def test_marker_publication_refuses_interloped_commit_marker_name(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                destination = Path(directory)
                interloper = destination / be.COMMIT_MARKER_NAME
                real_write = be._write_new_private_file

                def write_row_then_interlop(directory_fd, name, payload, purpose):
                    real_write(directory_fd, name, payload, purpose)
                    if purpose == 'evidence file' and not interloper.exists():
                        interloper.write_text(
                            '{"interloped": true}\n', encoding='utf-8')
                        interloper.chmod(0o600)

                # The marker name appears after the append pre-check and before
                # the atomic link: the FileExistsError branch must refuse it.
                with patch.object(
                        be, '_write_new_private_file',
                        side_effect=write_row_then_interlop):
                    with self.assertRaisesRegex(
                            ValueError,
                            'evidence commit marker already exists; '
                            'refusing to overwrite'):
                        be.append_evidence(result, directory)
                self.assertEqual(
                    interloper.read_text(encoding='utf-8'),
                    '{"interloped": true}\n')
                self.assertEqual(
                    len(list(destination.glob('rc0-baseline-*-sessions.jsonl'))),
                    len(be.SCENARIOS))

    def test_append_refuses_preexisting_temporary_marker_name(self):
        with authorized_workload(), configured_trusted_source():
            result = be.evaluate_baseline_evidence(complete_candidate())
            with tempfile.TemporaryDirectory(dir=Path(__file__).resolve().parent) as directory:
                destination = Path(directory)
                squatted_name = (
                    '.' + be.COMMIT_MARKER_NAME + '.' + ('ab' * 16) + '.tmp')
                squatter = destination / squatted_name
                squatter.write_text('{"squatted": true}\n', encoding='utf-8')
                squatter.chmod(0o600)
                # Pin the atomic temp name so the pre-existing-name surface is real.
                with patch.object(be.os, 'urandom',
                                  return_value=bytes.fromhex('ab' * 16)):
                    with self.assertRaisesRegex(
                            ValueError,
                            'temporary commit marker already exists: '
                            '.* refusing to overwrite'):
                        be.append_evidence(result, directory)
                self.assertEqual(
                    squatter.read_text(encoding='utf-8'), '{"squatted": true}\n')
                self.assertFalse((destination / be.COMMIT_MARKER_NAME).exists())
                with self.assertRaisesRegex(ValueError, 'manifest'):
                    be.load_complete_matrix(directory)


if __name__ == '__main__':
    unittest.main()
