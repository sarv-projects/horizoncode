import ast
import re
import stat
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "scripts/architecture/validate_convergence.py"


def license_helper():
    tree = ast.parse(VALIDATOR.read_text())
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "has_first_party_root_notice"
    )
    namespace = {"Path": Path, "stat": stat}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(VALIDATOR), "exec"), namespace)
    return namespace[function.name]


def test_case_body(source, title):
    start = source.index(title)
    end = re.search(r"^\s{2}(?:it|integrated)\.(?:effect|live)\(", source[start + len(title):], re.M)
    return source[start:] if end is None else source[start:start + len(title) + end.start()]


class LicenseDetectionTests(unittest.TestCase):
    def setUp(self):
        self.detect = license_helper()
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        (self.root / "opencode").mkdir()
        self.vendor = b"Pinned vendor license\n"
        (self.root / "opencode" / "LICENSE").write_bytes(self.vendor)

    def tearDown(self):
        self.temp.cleanup()

    def test_ignored_untracked_root_license_does_not_count(self):
        (self.root / "LICENSE").write_bytes(b"Horizon grant\n")
        self.assertFalse(self.detect(self.root, set()))

    def test_tracked_vendor_copy_does_not_count_as_horizon_grant(self):
        (self.root / "LICENSE").write_bytes(self.vendor)
        self.assertFalse(self.detect(self.root, {"LICENSE"}))

    def test_tracked_distinct_first_party_notice_counts(self):
        (self.root / "NOTICE").write_bytes(b"Separate Horizon distribution notice\n")
        self.assertTrue(self.detect(self.root, {"NOTICE"}))

    def test_symlink_is_not_first_party_root_notice(self):
        (self.root / "LICENSE").symlink_to(self.root / "opencode" / "LICENSE")
        self.assertFalse(self.detect(self.root, {"LICENSE"}))


class CurrentCodeOwnerTests(unittest.TestCase):
    def test_code_001_points_to_current_write_source_and_behavioral_tests(self):
        validator = VALIDATOR.read_text()
        self.assertIn("'code_present'", validator)
        self.assertIn("CODE_PRESENT/PARTIAL", validator)
        registry = (ROOT / "packages/core/src/tool/registry.ts").read_text()
        guard = (ROOT / "kernel/src/guard.rs").read_text()
        host = (ROOT / "kernel/src/effect_host.rs").read_text()
        write_test = (ROOT / "packages/core/test/tool-write.test.ts").read_text()
        self.assertIn("isBuiltinWrite(registration.tool)", registry)
        self.assertIn('FILES_WRITE_ID: &str = "files.write"', guard)
        self.assertIn("capability_id != guard::FILES_WRITE_ID", host)
        success = test_case_body(write_test, "writes only with the prepared host lease")
        self.assertIn('expect(admission.status).toBe("prepared")', success)
        self.assertIn('fs.readFile(target, "utf8")', success)
        denied = test_case_body(write_test, "rejects settlement without a Rust Guard lease")
        self.assertIn("expect(supervisorCalls).toEqual([])", denied)
        self.assertIn("fs.stat(target)", denied)
        self.assertIn(").toBe(false)", denied)

    def test_code_002_points_to_live_spoof_and_pause_recovery_regressions(self):
        validator = VALIDATOR.read_text()
        core_test = (ROOT / "packages/core/test/session-runner-tool-registry.test.ts").read_text()
        managed_test = (ROOT / "kernel/tests/managed_control.rs").read_text()
        unsupported = test_case_body(core_test, "does not advertise unsupported effectful plugin tools")
        self.assertIn('not.toContain("mutate")', unsupported)
        self.assertIn("expect(executions).toEqual([])", unsupported)
        spoof = test_case_body(core_test, "rejects a forged Location write")
        self.assertIn('not.toContain("write")', spoof)
        self.assertIn("expect(executions).toEqual([])", spoof)
        application = test_case_body(core_test, "does not treat process/application-declared files.write")
        self.assertIn('not.toContain("write")', application)
        self.assertIn("expect(called).toBe(false)", application)
        recovery = managed_test[managed_test.index("fn unknown_attempt_during_pause_moves_run_to_reconciliation_and_blocks_resume"):]
        recovery = recovery[:recovery.index("\n}\n") + 2]
        self.assertIn("RunPhase::Paused", recovery)
        self.assertIn("RunPhase::Reconciling", recovery)
        self.assertIn("ManagedCommand::ResumeRun", recovery)
        self.assertIn("unknown_effect", recovery)
        self.assertIn("kernel/tests/managed_control.rs", validator)
        self.assertIn("packages/core/test/session-runner-tool-registry.test.ts", validator)


if __name__ == "__main__":
    unittest.main()
