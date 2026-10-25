import ast
import re
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
AUDIT = ROOT / "scripts/architecture/audit_overlay_visibility.py"


def load_skip_scan_dir():
    tree = ast.parse(AUDIT.read_text())
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "skip_scan_dir"
    )
    namespace = {"SKIP": {".git", "node_modules", "target"}, "re": re}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(AUDIT), "exec"), namespace)
    return namespace[function.name]


class OverlayVisibilityScratchTests(unittest.TestCase):
    def test_dot_tmp_is_generated_scratch_not_first_party_source(self):
        self.assertTrue(load_skip_scan_dir()(".tmp"))

    def test_phase_cargo_scratch_dirs_are_generated_not_first_party_source(self):
        # `kernel/tmp-p1`, `kernel/tmp-p8` and `packages/core/tmp-p7` hold
        # repository-local generated fixture state and acceptance logs. Their
        # leaf names do not always embed the 15+ digit monotonic timestamp used
        # by other scratch dirs, so they need an exact-name classifier.
        skip = load_skip_scan_dir()
        for name in ("tmp-p1", "tmp-p7", "tmp-p8", "tmp-p12", "tmp-b2", "tmp-a1"):
            with self.subTest(name=name):
                self.assertTrue(skip(name))

    def test_real_source_directory_names_are_not_skipped_by_scratch_rule(self):
        # `tmp` is intentionally scratch (asserted separately); everything that
        # merely resembles it must remain visible.
        skip = load_skip_scan_dir()
        for name in ("tmpp8", "tmp-p", "tmp-pa", "tmt-p8", "provider", "tmp-p8x", "tmp-tools"):
            with self.subTest(name=name):
                self.assertFalse(skip(name))

    def test_phase_agent_scratch_directories_are_generated_not_first_party_source(self):
        # Per-phase test scratch written by Bun/Python harnesses. It must never
        # count as first-party source, and deleting it is its owning phase's job.
        skip = load_skip_scan_dir()
        for name in (".agent-tmp", ".p7-sandbox", ".p9-offline-home", ".p9probe", ".p4test"):
            with self.subTest(name=name):
                self.assertTrue(skip(name))

    def test_package_level_tmp_probe_directory_is_scratch(self):
        # Live owner probes such as `packages/opencode/tmp/probe-*.ts` are scratch
        # inside an existing generated-tmp policy (`.tmp`, `.tmp-*`), not source.
        skip = load_skip_scan_dir()
        self.assertTrue(skip("tmp"))
        # A real source directory that merely starts with the same letters stays visible.
        self.assertFalse(skip("tmpx"))
        self.assertFalse(skip("tmp-tools"))


def load_skip_hidden_file():
    tree = ast.parse(AUDIT.read_text())
    function = next(
        node for node in tree.body
        if isinstance(node, ast.FunctionDef) and node.name == "skip_hidden_file"
    )
    namespace = {"re": re}
    exec(compile(ast.Module(body=[function], type_ignores=[]), str(AUDIT), "exec"), namespace)
    return namespace[function.name]


class OverlayVisibilityHiddenFileTests(unittest.TestCase):
    def test_phase_focused_typecheck_projects_are_scratch(self):
        # `skip_hidden_file` documents that focused per-phase typecheck projects
        # are scratch the owning phase deletes at task end. The original pattern
        # only matched `tsconfig.p*-focus.json`, so live probe names such as
        # `tsconfig.p7typefix.json` and `tsconfig.p7-rows6.json` were wrongly
        # reported as hidden first-party source.
        skip = load_skip_hidden_file()
        for name in (
            "tsconfig.p7typefix.json",
            "tsconfig.p7-rows6.json",
            "tsconfig.p6focus.json",
            "tsconfig.p6-focus.json",
            "tsconfig.p5-typecheck.json",
            "tsconfig.p4.json",
        ):
            with self.subTest(name=name):
                self.assertTrue(skip(name))

    def test_real_typecheck_configurations_are_never_skipped(self):
        skip = load_skip_hidden_file()
        for name in ("tsconfig.json", "tsconfig.build.json", "tsconfig.a1focus.json", "tsconfig.p.json"):
            with self.subTest(name=name):
                self.assertFalse(skip(name))


if __name__ == "__main__":
    unittest.main()
