import argparse
import contextlib
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
        with tempfile.TemporaryDirectory() as directory:
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


class Rc0ChildFenceTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
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
        with tempfile.TemporaryDirectory() as directory:
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
        with tempfile.TemporaryDirectory() as directory:
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
        with tempfile.TemporaryDirectory() as directory:
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
        self.directory = tempfile.TemporaryDirectory()
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
        self.directory = tempfile.TemporaryDirectory()
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
        with tempfile.TemporaryDirectory() as directory:
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
        with tempfile.TemporaryDirectory() as directory:
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
        with self.assertRaisesRegex(ValueError, 'UNKNOWN metric must not carry a value'):
            rc0._validate_owner_metric({'quality': 'UNKNOWN', 'value': '0'}, 'metric')
        with self.assertRaisesRegex(ValueError, 'canonical nonnegative decimal'):
            rc0._validate_owner_metric({'quality': 'MEASURED', 'value': '00'}, 'metric')

    def test_owner_snapshot_ingest_rejects_duplicate_json_properties(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'owner.json'
            path.write_text('{"schemaVersion":1,"schemaVersion":1}', encoding='utf-8')

            with self.assertRaisesRegex(ValueError, 'duplicate JSON property'):
                rc0.load_owner_snapshot(path)

    def test_shared_authenticated_core_process_is_counted_once_across_sessions(self):
        metrics = {name: {'quality': 'MEASURED', 'value': '5'} for name in (
            'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')}
        owner = {
            'pid': 901, 'start_identity': '77', 'owner_epoch': '4',
            'process_incarnation': 'inc-4',
            'executable_identity_digest': 'blake3:' + 'a' * 64,
        }
        samples = [{
            'worker_count': 0,
            'process_identities': [],
            'aggregate': {name: {'quality': 'MEASURED', 'value': '0'} for name in metrics},
            'session_process_owner': owner,
            'session_process_metrics': metrics,
        } for _ in range(2)]

        result = rc0.aggregate_owner_samples(samples)

        self.assertEqual(result['core_process_sample_count'], 2)
        self.assertEqual(result['core_process_count'], 1)
        self.assertEqual(result['session_process_owner_metrics']['pssBytes']['value'], '5')
        self.assertEqual(result['combined_metrics']['pssBytes']['value'], '5')
        self.assertEqual(result['quality'], 'MEASURED')

    def test_unknown_core_owner_keeps_combined_resource_truth_unknown(self):
        metrics = {name: {'quality': 'MEASURED', 'value': '0'} for name in (
            'pssBytes', 'rssBytes', 'cpuNs', 'threadCount', 'fdCount', 'privateBytes')}
        result = rc0.aggregate_owner_samples([{
            'worker_count': 0,
            'process_identities': [],
            'aggregate': metrics,
            'session_process_owner': None,
            'session_process_metrics': None,
        }])

        self.assertEqual(result['session_process_owner_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertEqual(result['combined_metrics']['pssBytes']['quality'], 'UNKNOWN')
        self.assertEqual(result['quality'], 'UNKNOWN')


if __name__ == '__main__':
    unittest.main()
