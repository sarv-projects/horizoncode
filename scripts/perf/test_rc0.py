import os
import platform
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
        }
        args.update(changes)
        return rc0.baseline_eligible(**args)

    def test_requires_selected_harness_identity(self):
        self.assertFalse(self.eligible(harness=''))

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

    def test_complete_clean_samples_with_matching_outcomes_are_eligible(self):
        self.assertTrue(self.eligible())


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


if __name__ == '__main__':
    unittest.main()
