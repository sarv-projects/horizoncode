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


if __name__ == '__main__':
    unittest.main()
