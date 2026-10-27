from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]


class HorizonCodeTypecheckTests(unittest.TestCase):
    def test_zero_exit_with_typescript_diagnostic_fails_and_cleans_repo_temp(self) -> None:
        with tempfile.TemporaryDirectory(prefix="typecheck-test-", dir=REPO_ROOT) as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_bun = fake_bin / "bun"
            fake_bun.write_text(
                "#!/bin/sh\nprintf 'TMPDIR=%s\\n' \"$TMPDIR\"\nprintf '%s\\n' 'src/example.ts(1,1): error TS2322: mismatch'\nexit 0\n",
                encoding="utf-8",
            )
            fake_bun.chmod(0o755)
            capture = root / "capture"
            capture.mkdir()
            result = subprocess.run(
                ["bash", "scripts/architecture/horizoncode_typecheck.sh"],
                cwd=REPO_ROOT,
                env=dict(os.environ, PATH=f"{fake_bin}:{os.environ.get('PATH', '')}", TMPDIR=str(capture)),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0, result.stdout)
            self.assertEqual(result.stderr.count("horizoncode:typecheck: diagnostics"), 3)
            self.assertEqual(list(capture.iterdir()), [])
            self.assertEqual(result.stdout.count(f"TMPDIR={REPO_ROOT / '.tmp'}"), 3)

    def test_clean_output_and_nonzero_exit_are_respected(self) -> None:
        for output, exit_code, expected_success in (
            ("typecheck clean\\n", 0, True),
            ("compiler failed\\n", 7, False),
        ):
            with self.subTest(exit_code=exit_code):
                with tempfile.TemporaryDirectory(prefix="typecheck-test-", dir=REPO_ROOT) as temporary:
                    root = Path(temporary)
                    fake_bin = root / "bin"
                    fake_bin.mkdir()
                    fake_bun = fake_bin / "bun"
                    fake_bun.write_text(
                        f"#!/bin/sh\nprintf 'TMPDIR=%s\\n' \"$TMPDIR\"\nprintf '%s' '{output}'\nexit {exit_code}\n",
                        encoding="utf-8",
                    )
                    fake_bun.chmod(0o755)
                    result = subprocess.run(
                        ["bash", "scripts/architecture/horizoncode_typecheck.sh"],
                        cwd=REPO_ROOT,
                        env=dict(os.environ, PATH=f"{fake_bin}:{os.environ.get('PATH', '')}", TMPDIR=str(root)),
                        capture_output=True,
                        text=True,
                        timeout=15,
                        check=False,
                    )
                    self.assertEqual(result.returncode == 0, expected_success, result.stdout + result.stderr)
                    self.assertEqual(list(root.glob("tmp.*")), [])
                    self.assertEqual(result.stdout.count(f"TMPDIR={REPO_ROOT / '.tmp'}"), 3)


if __name__ == "__main__":
    unittest.main()
