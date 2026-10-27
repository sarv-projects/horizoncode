"""Synthetic harness tests; these do not establish product install evidence."""

from __future__ import annotations

import json
import sys
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
import contextlib
import hashlib
import io
import os
import re
import shutil
import socket
import stat
import subprocess
import tarfile
import tempfile
import textwrap
import time
import unittest
import zipfile
from unittest.mock import patch

try:  # PyYAML is used only to parse the GitHub Actions workflow fixtures below.
    import yaml
except ImportError:  # pragma: no cover - the workflow tests fail loudly instead.
    yaml = None

from scripts.release.audit_distribution import (
    MAX_PACKAGE_MANIFEST_BYTES,
    audit_repository,
    inspect_artifact,
    scan_runtime_dependencies,
)
from scripts.release import clean_install
from scripts.release import audit_distribution
from scripts.release.clean_install import run_matrix
from scripts.release.prepare_build import _guard_build_script, _run_checked, build_candidate, plan_isolated_build
from scripts.release.release_gate import build_platform_support_matrix, evaluate_release_gate
from scripts.release import release_gate


SANDBOX_PARENT = clean_install.APPROVED_TEMP_ROOT


def setUpModule() -> None:
    clean_install._ensure_approved_temp_root()


def _process_id_running(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def _load_bun_lock(path: Path) -> dict:
    """Read Bun's JSONC lockfile without accepting anything but trailing commas.

    This only strips trailing commas outside strings; comments, single quotes or
    any other non-JSON syntax still raise so a malformed lockfile cannot pass a
    release check silently.
    """
    text = path.read_text(encoding="utf-8")
    stripped: list[str] = []
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            stripped.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
            stripped.append(character)
            continue
        if character in "}]":
            while stripped and stripped[-1] in " \t\r\n":
                stripped.pop()
            if stripped and stripped[-1] == ",":
                stripped.pop()
        stripped.append(character)
    return json.loads("".join(stripped))


def _normalized_bin(manifest: dict) -> dict[str, str] | None:
    bin_value = manifest.get("bin")
    if bin_value is None:
        return None
    if isinstance(bin_value, str):
        return {str(manifest.get("name")): bin_value}
    return dict(bin_value)


class ReleaseGateCliTests(unittest.TestCase):
    def test_opencode_attribution_requires_a_standalone_copyright_line(self) -> None:
        self.assertTrue(
            audit_distribution._notice_preserves_opencode_attribution(
                b"OpenCode-derived software\nCopyright (c) 2025 opencode\n"
                b"The license text is preserved in opencode/LICENSE.\n"
            )
        )
        self.assertFalse(
            audit_distribution._notice_preserves_opencode_attribution(
                b"This is not an attribution: Copyright (c) 2025 opencode; "
                b"see opencode/LICENSE for unrelated background.\n"
            )
        )
        self.assertFalse(
            audit_distribution._notice_preserves_opencode_attribution(
                b"Copyright (c) 2025 opencode\n"
                b"See xopencode/LICENSE-backup for unrelated background.\n"
            )
        )

    def test_authoritative_dec_v1_12_deferral_exempts_only_the_signing_gate_row(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        report = evaluate_release_gate(repository_root)

        self.assertNotIn("signing/update trust root and rollback policy remain unresolved", report["blockers"])
        self.assertEqual(report["signing_update_policy"], "DEFERRED_UNAVAILABLE")
        self.assertEqual(report["signing_update"]["status"], "UNAVAILABLE")
        self.assertIsNone(report["signing_update"]["trust_root"])
        self.assertEqual(report["signing_update"]["channels"], [])
        self.assertEqual(report["signing_update"]["rollback_policy"], "NOT_CONFIGURED")
        self.assertEqual(report["signing_update"]["remote_install"], "UNAVAILABLE")
        self.assertEqual(report["signing_update"]["automatic_update"], "UNAVAILABLE")
        self.assertEqual(report["signing_update"]["v1_scope"], "LOCAL_ONLY_UNSIGNED")
        self.assertIn("accepted V1 deferral applies only to local unsigned use", report["signing_update"]["reason"])
        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("clean-install, upgrade, migration, TUI, and rollback evidence was not run", report["blockers"])
        self.assertIn("Linux/WSL platform support acceptance remains unverified; install-matrix evidence is not full platform acceptance", report["blockers"])

    def test_signing_deferral_exception_rejects_missing_unapproved_or_mismatched_decision(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        authority = (repository_root / "arch_V1" / "17-GOVERNANCE-DECISIONS.md").read_text(encoding="utf-8")

        self.assertTrue(release_gate._has_accepted_dec_v1_12_deferral(authority))
        invalid_authorities = {
            "missing": authority.replace(
                "| DEC-V1-12 | **Deferred by user decision 2026-10-25:** signing/update policy is out of V1 | Signing, remote artifact installation and automatic updates remain UNAVAILABLE; no signing root, channel or remote rollback behavior is implied |\n",
                "",
            ),
            "unapproved": authority.replace("**Deferred by user decision 2026-10-25:**", "Deferred without user decision:", 1),
            "mismatched": authority.replace("| DEC-V1-12 |", "| DEC-V1-13 |", 1),
        }
        for case, content in invalid_authorities.items():
            with self.subTest(case=case):
                self.assertFalse(release_gate._has_accepted_dec_v1_12_deferral(content))

    def test_local_client_identity_does_not_shadow_the_vendored_opencode_client(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        local_client = json.loads((repository_root / "packages/client/package.json").read_text(encoding="utf-8"))
        sdk_next = json.loads((repository_root / "packages/sdk-next/package.json").read_text(encoding="utf-8"))
        sdk_next_source = (repository_root / "packages/sdk-next/src/opencode.ts").read_text(encoding="utf-8")
        app = json.loads((repository_root / "packages/app/package.json").read_text(encoding="utf-8"))
        session_ui = json.loads((repository_root / "packages/session-ui/package.json").read_text(encoding="utf-8"))
        lock = (repository_root / "bun.lock").read_text(encoding="utf-8")

        self.assertEqual(local_client["name"], "@horizoncode/client")
        self.assertEqual(sdk_next["dependencies"]["@horizoncode/client"], "workspace:*")
        self.assertIn('from "@horizoncode/client/effect"', sdk_next_source)
        self.assertNotIn("@opencode-ai/client", local_client["name"])
        self.assertEqual(app["dependencies"]["@opencode-ai/client"], "file:vendor/opencode-ai-client-1.17.13-v2.tgz")
        self.assertEqual(
            session_ui["dependencies"]["@opencode-ai/client"],
            "file:../app/vendor/opencode-ai-client-1.17.13-v2.tgz",
        )
        self.assertIn('"@horizoncode/client": "workspace:*"', lock)
        self.assertIn('"@opencode-ai/client": "file:vendor/opencode-ai-client-1.17.13-v2.tgz"', lock)
        self.assertIn('"@opencode-ai/client": "file:../app/vendor/opencode-ai-client-1.17.13-v2.tgz"', lock)

    def test_workspace_lockfile_importers_match_manifest_identity(self) -> None:
        # A workspace importer is Bun's projection of the manifest name, version
        # and public bins. A bin path that only exists in the manifest (or only in
        # the lockfile) means the recorded install graph no longer describes the
        # release artifact, so frozen resolution/qualification cannot be trusted.
        repository_root = Path(__file__).resolve().parents[2]
        root_manifest = json.loads((repository_root / "package.json").read_text(encoding="utf-8"))
        importers = _load_bun_lock(repository_root / "bun.lock")["workspaces"]
        workspace_dirs = sorted(
            {
                path.relative_to(repository_root).as_posix()
                for pattern in root_manifest["workspaces"]["packages"]
                for path in repository_root.glob(pattern)
                if (path / "package.json").is_file()
            }
        )

        self.assertTrue(workspace_dirs, "no workspace manifests were found for the lockfile cross-check")
        mismatches: list[str] = []
        for directory in workspace_dirs:
            manifest = json.loads((repository_root / directory / "package.json").read_text(encoding="utf-8"))
            importer = importers.get(directory)
            if importer is None:
                mismatches.append(f"{directory}: no lockfile importer")
                continue
            if importer.get("name") != manifest.get("name"):
                mismatches.append(f"{directory}: lockfile name {importer.get('name')!r} != manifest {manifest.get('name')!r}")
            if (importer.get("version") or None) != (manifest.get("version") or None):
                mismatches.append(
                    f"{directory}: lockfile version {importer.get('version')!r} != manifest {manifest.get('version')!r}"
                )
            if _normalized_bin(importer) != _normalized_bin(manifest):
                mismatches.append(
                    f"{directory}: lockfile bin {_normalized_bin(importer)!r} != manifest {_normalized_bin(manifest)!r}"
                )
        unexpected_importers = sorted(
            directory for directory in importers if directory not in workspace_dirs and directory != ""
        )
        self.assertEqual(unexpected_importers, [], "lockfile records importers without a workspace manifest")

        product = json.loads((repository_root / "packages/opencode/package.json").read_text(encoding="utf-8"))
        self.assertEqual(
            _normalized_bin(product),
            {"horizoncode": "./bin/horizoncode", "hzcode": "./bin/horizoncode"},
        )
        self.assertEqual(mismatches, [], "workspace manifest/lockfile identity mismatch: " + "; ".join(mismatches))

    def test_evidence_output_must_stay_under_the_repository_artifact_root(self) -> None:
        with self.assertRaisesRegex(ValueError, "release evidence output must be a new file under"):
            clean_install._validated_output_path(Path("release-report.json"))

    def test_evidence_writer_creates_without_replacing_an_existing_file(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p9-evidence-write-", dir=SANDBOX_PARENT) as temporary:
            report = Path(temporary) / "report.json"
            clean_install._write_new_artifact_file(report, "first\n")
            self.assertEqual(report.read_text(encoding="utf-8"), "first\n")
            with self.assertRaises(FileExistsError):
                clean_install._write_new_artifact_file(report, "replacement\n")
            self.assertEqual(report.read_text(encoding="utf-8"), "first\n")

    def test_evidence_writer_does_not_follow_a_final_symlink(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p9-evidence-link-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            sentinel = root / "sentinel.txt"
            sentinel.write_text("unchanged\n", encoding="utf-8")
            link = root / "report.json"
            link.symlink_to(sentinel)
            with self.assertRaises(ValueError):
                clean_install._write_new_artifact_file(link, "replacement\n")
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "unchanged\n")

    def test_state_root_is_created_exclusively_under_the_pinned_artifact_root(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p9-state-root-", dir=SANDBOX_PARENT) as temporary:
            state_root = Path(temporary) / "evidence"
            clean_install._create_state_root(clean_install._validated_state_root(state_root))
            self.assertTrue(state_root.is_dir())
            self.assertEqual(stat.S_IMODE(state_root.stat(follow_symlinks=False).st_mode), 0o700)
            with self.assertRaises(FileExistsError):
                clean_install._create_state_root(state_root)

    def test_release_gate_cli_runs_directly_from_the_repository_root(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        environment = dict(os.environ, PYTHONDONTWRITEBYTECODE="1")

        result = subprocess.run(
            [sys.executable, "scripts/release/release_gate.py", "--help"],
            cwd=repository_root,
            env=environment,
            capture_output=True,
            text=True,
            timeout=60,
        )

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("release-readiness evidence gate", result.stdout)


class PublicCliLauncherTests(unittest.TestCase):
    def test_desktop_first_party_workspace_identity_updates_all_lock_namespaces(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        manifest = json.loads((repository_root / "packages/desktop/package.json").read_text(encoding="utf-8"))
        lock = _load_bun_lock(repository_root / "bun.lock")
        packages = lock["packages"]
        upstream_packages = _load_bun_lock(repository_root / "opencode/bun.lock")["packages"]
        old_prefix = "@opencode-ai/desktop"
        new_prefix = "@horizoncode/desktop"
        expected_nested = {
            "@actions/artifact",
            "typescript",
            "@actions/artifact/@actions/http-client",
            "@actions/artifact/@actions/http-client/undici",
        }

        self.assertEqual(manifest["name"], new_prefix)
        self.assertEqual(lock["workspaces"]["packages/desktop"]["name"], new_prefix)
        self.assertNotIn(old_prefix, packages)
        self.assertEqual(packages[new_prefix], [f"{new_prefix}@workspace:packages/desktop"])
        self.assertEqual(
            {key.removeprefix(new_prefix + "/") for key in packages if key.startswith(new_prefix + "/")},
            expected_nested,
        )
        for suffix in expected_nested:
            self.assertEqual(packages[f"{new_prefix}/{suffix}"], upstream_packages[f"{old_prefix}/{suffix}"])

    def test_web_first_party_workspace_identity_updates_lock_namespaces_only(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        manifest = json.loads((repository_root / "packages/web/package.json").read_text(encoding="utf-8"))
        lock = _load_bun_lock(repository_root / "bun.lock")
        upstream_packages = _load_bun_lock(repository_root / "opencode/bun.lock")["packages"]
        packages = lock["packages"]
        importer = lock["workspaces"]["packages/web"]
        old_prefix = "@opencode-ai/web"
        new_prefix = "@horizoncode/web"
        expected_nested = {
            "@shikijs/transformers",
            "@shikijs/transformers/@shikijs/core",
            "@shikijs/transformers/@shikijs/types",
        }

        self.assertEqual(manifest["name"], new_prefix)
        self.assertEqual(importer["name"], new_prefix)
        self.assertNotIn(old_prefix, packages)
        self.assertEqual(packages[new_prefix], [f"{new_prefix}@workspace:packages/web"])
        self.assertEqual(
            {key.removeprefix(new_prefix + "/") for key in packages if key.startswith(new_prefix + "/")},
            expected_nested,
        )
        for suffix in expected_nested:
            self.assertEqual(packages[f"{new_prefix}/{suffix}"], upstream_packages[f"{old_prefix}/{suffix}"])

    def test_unreferenced_enterprise_package_uses_horizoncode_workspace_identity(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        manifest = json.loads((repository_root / "packages/enterprise/package.json").read_text(encoding="utf-8"))
        lock = _load_bun_lock(repository_root / "bun.lock")

        self.assertEqual(manifest["name"], "@horizoncode/enterprise")
        self.assertEqual(lock["workspaces"]["packages/enterprise"]["name"], manifest["name"])
        self.assertNotIn("@opencode-ai/enterprise", lock["packages"])
        self.assertEqual(
            lock["packages"]["@horizoncode/enterprise"],
            ["@horizoncode/enterprise@workspace:packages/enterprise"],
        )

    def test_unreferenced_first_party_packages_have_horizoncode_workspace_ids(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        lock = _load_bun_lock(repository_root / "bun.lock")
        for folder, package_id in (
            ("function", "@horizoncode/function"),
            ("slack", "@horizoncode/slack"),
        ):
            with self.subTest(folder=folder):
                manifest = json.loads(
                    (repository_root / f"packages/{folder}/package.json").read_text(encoding="utf-8")
                )
                importer = lock["workspaces"][f"packages/{folder}"]

                self.assertEqual(manifest["name"], package_id)
                self.assertEqual(importer["name"], package_id)
                self.assertNotIn(f"@opencode-ai/{folder}", lock["packages"])
                self.assertEqual(lock["packages"][package_id], [f"{package_id}@workspace:packages/{folder}"])

    def test_storybook_first_party_workspace_identity_matches_lock(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        manifest = json.loads((repository_root / "packages/storybook/package.json").read_text(encoding="utf-8"))
        lock = _load_bun_lock(repository_root / "bun.lock")

        self.assertEqual(manifest["name"], "@horizoncode/storybook")
        self.assertEqual(lock["workspaces"]["packages/storybook"]["name"], manifest["name"])
        self.assertNotIn("@opencode-ai/storybook", lock["packages"])
        self.assertEqual(
            lock["packages"]["@horizoncode/storybook"],
            ["@horizoncode/storybook@workspace:packages/storybook"],
        )

    def test_manifest_selected_horizoncode_and_hzcode_launchers_forward_arguments_and_exit_status(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        package_root = repository_root / "packages" / "opencode"
        manifest = json.loads((package_root / "package.json").read_text(encoding="utf-8"))
        bin_entries = manifest.get("bin")
        self.assertEqual(bin_entries, {"horizoncode": "./bin/horizoncode", "hzcode": "./bin/horizoncode"})

        node = shutil.which("node")
        self.assertIsNotNone(node, "the package launcher requires Node.js")
        with tempfile.TemporaryDirectory(prefix="p9-launcher-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            fake_binary = root / "candidate"
            fake_binary.write_text(
                "#!" + sys.executable + "\n"
                "import json, os, sys\n"
                "from pathlib import Path\n"
                "Path(os.environ['P9_LAUNCHER_CAPTURE']).write_text(json.dumps(sys.argv[1:]), encoding='utf-8')\n"
                "raise SystemExit(23)\n",
                encoding="utf-8",
            )
            fake_binary.chmod(0o755)
            for command_name in sorted(bin_entries):
                capture = root / f"{command_name}-arguments.json"
                launcher = package_root / bin_entries[command_name]
                environment = dict(
                    os.environ,
                    OPENCODE_BIN_PATH=str(fake_binary),
                    P9_LAUNCHER_CAPTURE=str(capture),
                )

                result = subprocess.run(
                    [node, str(launcher), "--from-manifest", "two words"],
                    cwd=repository_root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )

                self.assertEqual(result.returncode, 23, f"{command_name}: {result.stderr}")
                self.assertEqual(json.loads(capture.read_text(encoding="utf-8")), ["--from-manifest", "two words"])

    def test_horizoncode_binary_override_precedes_legacy_opencode_override(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        package_root = repository_root / "packages" / "opencode"
        node = shutil.which("node")
        self.assertIsNotNone(node, "the package launcher requires Node.js")
        with tempfile.TemporaryDirectory(prefix="p9-launcher-priority-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            selected = root / "selected"
            canonical = root / "horizoncode-candidate"
            legacy = root / "opencode-candidate"
            canonical.write_text(
                "#!" + sys.executable + "\n"
                "import os, sys\n"
                "from pathlib import Path\n"
                "Path(os.environ['P9_LAUNCHER_SELECTED']).write_text('horizoncode', encoding='utf-8')\n"
                "raise SystemExit(23)\n",
                encoding="utf-8",
            )
            legacy.write_text(
                "#!" + sys.executable + "\n"
                "import os, sys\n"
                "from pathlib import Path\n"
                "Path(os.environ['P9_LAUNCHER_SELECTED']).write_text('legacy', encoding='utf-8')\n"
                "raise SystemExit(42)\n",
                encoding="utf-8",
            )
            canonical.chmod(0o755)
            legacy.chmod(0o755)
            result = subprocess.run(
                [
                    node,
                    str(package_root / "bin" / "horizoncode"),
                    "--identity-priority",
                ],
                cwd=repository_root,
                env=dict(
                    os.environ,
                    HORIZONCODE_BIN_PATH=str(canonical),
                    OPENCODE_BIN_PATH=str(legacy),
                    P9_LAUNCHER_SELECTED=str(selected),
                ),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertEqual(result.returncode, 23, result.stderr)
            self.assertEqual(selected.read_text(encoding="utf-8"), "horizoncode")


class StandaloneInstallerCommandTests(unittest.TestCase):
    def _installer_function(self, name: str) -> str:
        repository_root = Path(__file__).resolve().parents[2]
        source = (repository_root / "install").read_text(encoding="utf-8")
        match = re.search(rf"(?ms)^{re.escape(name)}\(\) \{{\n.*?^\}}", source)
        self.assertIsNotNone(
            match,
            f"install lacks {name}(); raw install-path interpolation remains unguarded",
        )
        return match.group(0)

    def _run_installer_function(self, name: str, body: str, *arguments: str) -> subprocess.CompletedProcess[str]:
        function = self._installer_function(name)
        return subprocess.run(
            ["bash", "-c", f"{function}\n{body}", "installer-function-test", *arguments],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )

    def test_install_dir_validation_rejects_command_substitution_and_shell_controls(self) -> None:
        for value in ("/tmp/$(touch marker)", "/tmp/ok; echo injected", "/tmp/control\x01byte"):
            with self.subTest(value=value):
                result = self._run_installer_function(
                    "validate_install_dir", 'validate_install_dir "$1"', value
                )
                self.assertNotEqual(result.returncode, 0, f"unsafe path accepted: {value!r}")

    def test_install_path_formatting_preserves_whitespace_as_one_shell_argument(self) -> None:
        value = "/home/example user/.local/bin"
        validation = self._run_installer_function("validate_install_dir", 'validate_install_dir "$1"', value)
        self.assertEqual(validation.returncode, 0, validation.stderr)
        for shell_name, expected in (
            ("bash", "export PATH='/home/example user/.local/bin':$PATH"),
            ("fish", "fish_add_path '/home/example user/.local/bin'"),
        ):
            with self.subTest(shell=shell_name):
                result = self._run_installer_function(
                    "format_install_path_command",
                    'format_install_path_command "$1" "$2"',
                    shell_name,
                    value,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout, expected)

    def test_install_dir_validation_rejects_carriage_return_and_line_feed(self) -> None:
        for value in ("/tmp/install\nGITHUB_PATH_INJECTED", "/tmp/install\rGITHUB_PATH_INJECTED"):
            with self.subTest(value=value):
                result = self._run_installer_function(
                    "validate_install_dir", 'validate_install_dir "$1"', value
                )
                self.assertNotEqual(result.returncode, 0, f"line-breaking path accepted: {value!r}")

    def test_github_path_addition_is_idempotent_for_the_canonical_install_directory(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-github-path-install-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)
            github_path = root / "github-path"
            environment = dict(
                os.environ,
                HOME=str(home),
                SHELL="/bin/bash",
                GITHUB_ACTIONS="true",
                GITHUB_PATH=str(github_path),
            )

            for _ in range(2):
                result = subprocess.run(
                    [
                        "bash", str(repository_root / "install"), "--binary", str(candidate),
                        "--sha256", hashlib.sha256(candidate.read_bytes()).hexdigest(),
                        "--no-modify-path",
                    ],
                    cwd=repository_root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

            self.assertEqual(github_path.read_text(encoding="utf-8").splitlines(), [str(home / ".opencode" / "bin")])

    def test_local_binary_install_provisions_horizoncode_and_the_hzcode_short_command(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-installer-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)

            result = subprocess.run(
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--sha256", hashlib.sha256(candidate.read_bytes()).hexdigest(), "--no-modify-path"],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), TMPDIR=str(root), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            horizoncode = home / ".opencode" / "bin" / "horizoncode"
            hzcode = home / ".opencode" / "bin" / "hzcode"
            self.assertTrue(horizoncode.is_file())
            self.assertTrue(hzcode.exists())
            if hzcode.is_symlink():
                self.assertEqual(os.readlink(hzcode), "horizoncode")
            self.assertFalse((home / ".opencode" / "bin" / "opencode").exists())
            for command_name in ("horizoncode", "hzcode"):
                launched = subprocess.run(
                    [str(home / ".opencode" / "bin" / command_name)],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                self.assertEqual(launched.returncode, 0, f"{command_name}: {launched.stderr}")

    def test_network_install_fails_before_creating_install_state_until_signing_policy_exists(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-no-network-install-", dir=SANDBOX_PARENT) as temporary:
            home = Path(temporary) / "home"
            home.mkdir(mode=0o700)
            result = subprocess.run(
                ["bash", str(repository_root / "install")],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("release signing trust policy", result.stderr)
            self.assertFalse((home / ".opencode" / "bin").exists())

    def test_version_selector_cannot_be_silently_ignored_for_local_candidate(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-versioned-local-install-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)

            result = subprocess.run(
                ["bash", str(repository_root / "install"), "--version", "1.2.3", "--binary", str(candidate), "--sha256", hashlib.sha256(candidate.read_bytes()).hexdigest()],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("cannot be combined with --binary", result.stderr)
            self.assertFalse((home / ".opencode" / "bin").exists())

    def test_installer_rejects_native_windows_before_creating_install_state(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-windows-installer-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            uname = fake_bin / "uname"
            uname.write_text("#!/bin/sh\nprintf '%s\\n' MINGW_NT\n", encoding="utf-8")
            uname.chmod(0o755)
            home = root / "home"
            home.mkdir(mode=0o700)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)

            result = subprocess.run(
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--sha256", hashlib.sha256(candidate.read_bytes()).hexdigest(), "--no-modify-path"],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), PATH=f"{fake_bin}:{os.environ.get('PATH', '')}"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("native Windows is unavailable", result.stderr)
            self.assertFalse((home / ".opencode" / "bin").exists())

    def test_installer_rejects_symlink_candidate_and_preserves_existing_cli(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-symlink-candidate-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            install_dir = home / ".opencode" / "bin"
            install_dir.mkdir(parents=True, mode=0o700)
            existing = install_dir / "horizoncode"
            existing.write_text("existing candidate\n", encoding="utf-8")
            source = root / "candidate"
            source.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            source.chmod(0o755)
            candidate_link = root / "candidate-link"
            candidate_link.symlink_to(source)

            result = subprocess.run(
                ["bash", str(repository_root / "install"), "--binary", str(candidate_link), "--sha256", hashlib.sha256(source.read_bytes()).hexdigest(), "--no-modify-path"],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("regular executable file", result.stderr)
            self.assertEqual(existing.read_text(encoding="utf-8"), "existing candidate\n")
            self.assertFalse((install_dir / "hzcode").exists())

    def test_installer_is_idempotent_and_upgrades_both_public_commands(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-idempotent-install-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            install_dir = home / ".opencode" / "bin"
            versions = {}
            for version in ("1.0.0", "2.0.0"):
                candidate = root / f"candidate-{version}"
                candidate.write_text(f"#!/bin/sh\nprintf '%s\\n' {version}\n", encoding="utf-8")
                candidate.chmod(0o755)
                versions[version] = candidate

            environment = dict(os.environ, HOME=str(home), SHELL="/bin/bash")
            for version in ("1.0.0", "2.0.0", "2.0.0"):
                result = subprocess.run(
                    ["bash", str(repository_root / "install"), "--binary", str(versions[version]), "--sha256", hashlib.sha256(versions[version].read_bytes()).hexdigest(), "--no-modify-path"],
                    cwd=repository_root,
                    env=environment,
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)

            self.assertEqual(sorted(path.name for path in install_dir.iterdir()), ["horizoncode", "hzcode"])
            for command in ("horizoncode", "hzcode"):
                launched = subprocess.run(
                    [str(install_dir / command)],
                    capture_output=True,
                    text=True,
                    timeout=15,
                    check=False,
                )
                self.assertEqual(launched.returncode, 0, launched.stderr)
                self.assertEqual(launched.stdout.strip(), "2.0.0")
            self.assertTrue((install_dir / "hzcode").is_symlink())
            self.assertEqual(os.readlink(install_dir / "hzcode"), "horizoncode")

    def test_installer_dry_run_validates_without_creating_install_state(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-dry-run-install-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)

            result = subprocess.run(
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--sha256", hashlib.sha256(candidate.read_bytes()).hexdigest(), "--no-modify-path", "--dry-run"],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertIn("Dry run: no files will be written.", result.stdout)
            self.assertFalse((home / ".opencode").exists())

    def test_installer_refuses_directory_alias_without_replacing_canonical(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-directory-alias-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            install_dir = home / ".opencode" / "bin"
            install_dir.mkdir(parents=True, mode=0o700)
            canonical = install_dir / "horizoncode"
            canonical.write_text("previous binary\n", encoding="utf-8")
            (install_dir / "hzcode").mkdir()
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)

            result = subprocess.run(
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--sha256", hashlib.sha256(candidate.read_bytes()).hexdigest(), "--no-modify-path"],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Install destination must not be a directory", result.stderr)
            self.assertEqual(canonical.read_text(encoding="utf-8"), "previous binary\n")
            self.assertTrue((install_dir / "hzcode").is_dir())
            self.assertEqual(sorted(path.name for path in install_dir.iterdir()), ["horizoncode", "hzcode"])

    def test_installer_shell_syntax_is_valid(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        result = subprocess.run(
            ["bash", "-n", str(repository_root / "install")],
            cwd=repository_root,
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)

    def test_build_script_packages_first_party_license_and_upstream_notice(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        build_script = (repository_root / "packages" / "opencode" / "script" / "build.ts").read_text(encoding="utf-8")
        self.assertIn('LICENSE', build_script)
        self.assertIn('NOTICE', build_script)
        self.assertIn('dist/${name}/bin/LICENSE', build_script)
        self.assertIn('dist/${name}/bin/NOTICE', build_script)
        self.assertIn('candidateLicense', build_script)
        self.assertIn('MIT License', (repository_root / "LICENSE").read_text(encoding="utf-8"))
        self.assertIn('path.resolve(dir, "../../NOTICE")', build_script)
        notice = (repository_root / "NOTICE").read_text(encoding="utf-8")
        self.assertIn("Copyright (c) 2025 opencode", notice)
        self.assertIn("OpenCode is licensed under the MIT License", notice)
        self.assertIn("opencode/LICENSE", notice)
        self.assertIn("DEC-V1-12", notice)

    def test_first_party_workspace_manifests_declare_the_selected_mit_grant(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        root_manifest = json.loads((repository_root / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(root_manifest.get("license"), "MIT")

        manifests = sorted(repository_root.glob("packages/*/package.json")) + sorted(
            repository_root.glob("packages/*/*/package.json")
        )
        self.assertEqual(len(manifests), 36, "workspace manifest inventory changed; review license coverage")
        for path in manifests:
            with self.subTest(path=path.relative_to(repository_root).as_posix()):
                manifest = json.loads(path.read_text(encoding="utf-8"))
                self.assertEqual(manifest.get("license"), "MIT")

    def test_build_script_emits_the_horizoncode_product_binary(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        build_script = (repository_root / "packages" / "opencode" / "script" / "build.ts").read_text(encoding="utf-8")
        self.assertIn('outfile: `dist/${name}/bin/horizoncode`', build_script)
        self.assertIn('const binaryPath = `dist/${name}/bin/horizoncode`', build_script)
        self.assertIn('codesign --force --sign - dist/${name}/bin/horizoncode', build_script)
        self.assertIn('`--user-agent=horizoncode/${Script.version}`', build_script)

    def test_nix_package_consumes_horizoncode_artifacts_and_keeps_one_compatibility_alias(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        nix_package = (repository_root / "nix" / "opencode.nix").read_text(encoding="utf-8")
        self.assertIn('dist/horizoncode-*/bin/horizoncode $out/bin/horizoncode', nix_package)
        self.assertIn('ln -s horizoncode $out/bin/opencode', nix_package)

    def test_container_build_consumes_the_horizoncode_artifact_and_command(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        dockerfile = (repository_root / "packages" / "opencode" / "Dockerfile").read_text(encoding="utf-8")
        self.assertIn("dist/horizoncode-linux-x64-baseline-musl/bin/horizoncode /usr/local/bin/horizoncode", dockerfile)
        self.assertIn("dist/horizoncode-linux-arm64-musl/bin/horizoncode /usr/local/bin/horizoncode", dockerfile)
        self.assertIn('ENTRYPOINT ["horizoncode"]', dockerfile)
        self.assertIn("ln -s horizoncode /usr/local/bin/opencode", dockerfile)

    def test_nix_and_container_release_controls_keep_one_horizoncode_runtime(self) -> None:
        # Static only: `nix` is unavailable here, so this asserts the packaged
        # identities and aliases agree instead of claiming an evaluated derivation.
        repository_root = Path(__file__).resolve().parents[2]
        flake = (repository_root / "flake.nix").read_text(encoding="utf-8")
        nix_package = (repository_root / "nix" / "opencode.nix").read_text(encoding="utf-8")
        container_builder = (repository_root / "packages" / "containers" / "script" / "build.ts").read_text(
            encoding="utf-8"
        )
        publish_dockerfile = (repository_root / "packages" / "containers" / "publish" / "Dockerfile").read_text(
            encoding="utf-8"
        )

        self.assertIn("horizoncode = opencode;", flake)
        self.assertRegex(flake, r"default = (?:opencode|horizoncode);")
        self.assertIn('mainProgram = "horizoncode"', nix_package)
        self.assertIn("ln -s horizoncode $out/bin/hzcode", nix_package)
        self.assertIn("ln -s horizoncode $out/bin/opencode", nix_package)
        self.assertIn("dist/horizoncode-*/bin/horizoncode $out/bin/horizoncode", nix_package)

        self.assertIn('if (process.argv.includes("--push") || process.env.PUSH === "1")', container_builder)
        self.assertIn(
            "HorizonCode container publication is disabled pending release authorization.", container_builder
        )
        self.assertIn("ARG REGISTRY=localhost/horizoncode", publish_dockerfile)
        self.assertNotIn("docker push", container_builder)
        self.assertNotIn(":latest", publish_dockerfile)


class DistributionAuditTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="p9-audit-", dir=SANDBOX_PARENT)
        self.root = Path(self.temp.name)
        (self.root / "opencode").mkdir()
        (self.root / "packages" / "opencode").mkdir(parents=True)
        (self.root / "node_modules" / "first-party-runtime").mkdir(parents=True)
        (self.root / "node_modules" / "transitive-runtime").mkdir()
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "UNLICENSED"}),
            encoding="utf-8",
        )
        self.vendor_license = "MIT License\nCopyright (c) upstream\nPermission notice\n"
        (self.root / "opencode" / "LICENSE").write_text(self.vendor_license, encoding="utf-8")
        (self.root / "LICENSE").write_text(self.vendor_license, encoding="utf-8")
        (self.root / "packages" / "opencode" / "package.json").write_text(
            json.dumps(
                {
                    "name": "opencode",
                    "version": "1.0.0",
                    "private": True,
                    "license": "MIT",
                    "dependencies": {"first-party-runtime": "1.0.0"},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "node_modules" / "first-party-runtime" / "package.json").write_text(
            json.dumps(
                {
                    "name": "first-party-runtime",
                    "version": "1.0.0",
                    "license": "MIT",
                    "dependencies": {"transitive-runtime": "2.0.0"},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "node_modules" / "first-party-runtime" / "LICENSE").write_text(
            "MIT License\n", encoding="utf-8"
        )
        (self.root / "node_modules" / "transitive-runtime" / "package.json").write_text(
            json.dumps({"name": "transitive-runtime", "version": "2.0.0"}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def test_container_publication_audit_ignores_comments_but_detects_docker_push(self) -> None:
        from scripts.release.audit_distribution import _container_builder_has_push_command

        self.assertFalse(
            _container_builder_has_push_command(
                "// rejects --push before Docker\n"
                'await $`docker build --tag example/image .`\n'
            )
        )
        self.assertTrue(_container_builder_has_push_command('await $`docker buildx build --push .`\n'))

    def test_distribution_audit_accepts_current_release_upload_unavailable_policy(self) -> None:
        build_script = self.root / "packages" / "opencode" / "script" / "build.ts"
        build_script.parent.mkdir(parents=True, exist_ok=True)
        build_script.write_text(
            'throw new Error("HorizonCode release upload is unavailable while exact third-party notices, '
            'signing/update policy, and release acceptance remain incomplete.");\n',
            encoding="utf-8",
        )

        report = audit_repository(self.root)

        self.assertTrue(report["package_target"]["direct_package_release_upload_disabled"])
        self.assertNotIn(
            "the direct package build still permits or lacks a source guard for release upload",
            report["blockers"],
        )

    def test_release_audit_tracks_nix_packaging_inputs_for_git_visibility(self) -> None:
        self._commit_audit_fixture()
        nix_sources = (
            "flake.nix",
            "flake.lock",
            "nix/opencode.nix",
            "nix/node_modules.nix",
            "nix/desktop.nix",
            "nix/hashes.json",
            "nix/scripts/canonicalize-node-modules.ts",
            "nix/scripts/normalize-bun-binaries.ts",
        )
        for name in nix_sources:
            path = self.root / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("packaging input\n", encoding="utf-8")
        with (self.root / ".gitignore").open("a", encoding="utf-8") as ignore:
            ignore.write("\n/flake.nix\n/flake.lock\n/nix/\n")

        report = audit_repository(self.root)
        visibility = report["package_target"]["release_control_sources_git_visible"]

        for name in nix_sources:
            self.assertIn(name, visibility)
            self.assertFalse(visibility[name], f"ignored release packaging input was not reported: {name}")
        self.assertTrue(
            any("flake.nix" in blocker and "nix/opencode.nix" in blocker for blocker in report["blockers"])
        )

    def test_nix_mit_metadata_does_not_override_an_unresolved_root_distribution_notice(self) -> None:
        nix_package = self.root / "nix" / "opencode.nix"
        nix_package.parent.mkdir(parents=True)
        nix_package.write_text(
            "meta = {\n    license = lib.licenses.mit;\n};\n",
            encoding="utf-8",
        )

        report = audit_repository(self.root)

        self.assertEqual(report["package_target"].get("nix_package_license_claim"), "MIT")
        self.assertNotIn(
            "Nix package metadata declares MIT while first-party distribution rights remain unresolved",
            report["blockers"],
        )

    def test_distribution_audit_blocks_a_runnable_or_write_enabled_publish_workflow(self) -> None:
        workflow = self.root / ".github" / "workflows" / "publish.yml"
        workflow.parent.mkdir(parents=True)
        safe_workflow = (
            "on:\n  workflow_dispatch:\n"
            "permissions:\n  contents: read\n"
            "jobs:\n  publish:\n    if: ${{ false }}\n"
            "    runs-on: ubuntu-latest\n    steps:\n      - run: echo disabled\n"
        )
        unsafe_variants = (
            safe_workflow.replace("contents: read", "contents: write"),
            safe_workflow.replace("    if: ${{ false }}\n", ""),
            safe_workflow.replace("  workflow_dispatch:", "  push:", 1),
        )

        for source in unsafe_variants:
            with self.subTest(source=source):
                workflow.write_text(source, encoding="utf-8")
                report = audit_repository(self.root)
                self.assertIn("root publication workflow is absent or not fail-closed", report["blockers"])

    def _commit_audit_fixture(self) -> str:
        (self.root / ".gitignore").write_text("node_modules/\n/LICENSE\nrelease-artifacts/\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.name", "P9 test"], cwd=self.root, check=True)
        subprocess.run(["git", "config", "user.email", "p9-test@example.invalid"], cwd=self.root, check=True)
        subprocess.run(
            [
                "git",
                "add",
                ".gitignore",
                "package.json",
                "opencode/LICENSE",
                "packages/opencode/package.json",
            ],
            cwd=self.root,
            check=True,
        )
        subprocess.run(["git", "commit", "--quiet", "-m", "fixture"], cwd=self.root, check=True)
        return subprocess.run(
            ["git", "rev-parse", "HEAD"], cwd=self.root, check=True, capture_output=True, text=True
        ).stdout.strip()

    def test_runtime_dependency_symlink_cannot_escape_audited_root(self) -> None:
        external = self.root.parent / f"{self.root.name}-external"
        external.mkdir()
        try:
            (external / "package.json").write_text(
                json.dumps({"name": "outside", "version": "1", "license": "MIT"}),
                encoding="utf-8",
            )
            runtime = self.root / "node_modules" / "first-party-runtime"
            shutil.rmtree(runtime)
            runtime.symlink_to(external, target_is_directory=True)

            inventory = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)

            self.assertEqual(inventory["package_count"], 0)
            self.assertEqual(
                [item["name"] for item in inventory["unresolved_required_dependencies"]],
                ["first-party-runtime"],
            )
        finally:
            shutil.rmtree(external, ignore_errors=True)

    def test_runtime_dependency_store_symlink_inside_audited_root_is_resolved(self) -> None:
        # Bun's isolated install resolves every dependency to an in-repository
        # content store and symlinks it into place; the audit must resolve links
        # whose target stays inside the audited root (containment is the rule,
        # not a blanket link ban) while the escape negative below stays blocked.
        store = (
            self.root
            / "node_modules"
            / ".bun"
            / "first-party-runtime@1.0.0"
            / "node_modules"
            / "first-party-runtime"
        )
        store.mkdir(parents=True)
        linked = self.root / "node_modules" / "first-party-runtime"
        shutil.move(str(linked / "package.json"), store / "package.json")
        shutil.move(str(linked / "LICENSE"), store / "LICENSE")
        linked.rmdir()
        linked.symlink_to(store, target_is_directory=True)

        inventory = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)

        self.assertEqual(inventory["inventory_errors"], [])
        self.assertEqual(inventory["package_count"], 2)
        self.assertEqual(inventory["unresolved_required_dependencies"], [])
        self.assertEqual(
            {item["name"] for item in inventory["packages"]},
            {"first-party-runtime", "transitive-runtime"},
        )
        self.assertEqual(
            [item for item in inventory["packages"] if item["name"] == "first-party-runtime"][0][
                "license_files"
            ],
            ["LICENSE"],
        )

    def test_runtime_dependency_manifest_and_graph_limits_fail_closed(self) -> None:
        package_manifest = self.root / "packages" / "opencode" / "package.json"
        package_manifest.write_text(
            json.dumps({"dependencies": {f"dep-{index}": "1" for index in range(4097)}}),
            encoding="utf-8",
        )
        inventory = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)
        self.assertTrue(any("4096 dependencies" in item for item in inventory["inventory_errors"]))

        package_manifest.write_text(json.dumps({"dependencies": {"first-party-runtime": "1"}}), encoding="utf-8")
        dependency_manifest = self.root / "node_modules" / "first-party-runtime" / "package.json"
        dependency_manifest.write_bytes(b"{" + b" " * MAX_PACKAGE_MANIFEST_BYTES)
        inventory = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)
        self.assertTrue(any("bounded regular file" in item for item in inventory["inventory_errors"]))

    def test_audit_reports_vendor_license_copy_and_full_runtime_dependency_closure(self) -> None:
        report = audit_repository(self.root)

        self.assertEqual(report["distribution_license"]["status"], "BLOCKED")
        self.assertTrue(report["distribution_license"]["root_license_matches_vendor"])
        self.assertEqual(report["package_target"]["private"], True)
        self.assertEqual(
            {item["name"] for item in report["runtime_dependencies"]["packages"]},
            {"first-party-runtime", "transitive-runtime"},
        )
        self.assertIn(
            "transitive-runtime",
            {item["name"] for item in report["runtime_dependencies"]["missing_license_metadata"]},
        )
        self.assertIn("no built package artifact was supplied or found", report["blockers"])

    def test_first_party_mit_decision_requires_tracked_distinct_license_and_notice(self) -> None:
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "MIT"}),
            encoding="utf-8",
        )
        (self.root / "LICENSE").write_text("MIT License\nfirst-party grant\n", encoding="utf-8")
        (self.root / "NOTICE").write_text(
            "OpenCode-derived software\nCopyright (c) 2025 opencode\nSee opencode/LICENSE. "
            "Exact third-party closure pending\n",
            encoding="utf-8",
        )
        self._commit_audit_fixture()
        subprocess.run(["git", "add", "-f", "LICENSE", "NOTICE"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "track legal artifacts"], cwd=self.root, check=True)

        report = audit_repository(self.root)

        self.assertTrue(report["distribution_license"]["legal_decision_made"])
        self.assertTrue(report["distribution_license"]["root_license_tracked"])
        self.assertTrue(report["distribution_license"]["root_notice_tracked"])
        self.assertTrue(report["distribution_license"]["notice_preserves_opencode_attribution"])
        self.assertFalse(report["distribution_license"]["root_license_matches_vendor"])
        self.assertIn("no built package artifact was supplied or found", report["blockers"])

    def test_first_party_mit_decision_requires_upstream_attribution_in_notice(self) -> None:
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "MIT"}),
            encoding="utf-8",
        )
        (self.root / "LICENSE").write_text("MIT License\nfirst-party grant\n", encoding="utf-8")
        (self.root / "NOTICE").write_text(
            "HorizonCode first-party distribution notice\nNo third-party attribution listed.\n",
            encoding="utf-8",
        )
        self._commit_audit_fixture()
        subprocess.run(["git", "add", "-f", "LICENSE", "NOTICE"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "track legal artifacts"], cwd=self.root, check=True)

        report = audit_repository(self.root)

        self.assertFalse(report["distribution_license"]["legal_decision_made"])
        self.assertEqual(report["distribution_license"]["status"], "BLOCKED")

    def test_untracked_first_party_license_and_notice_are_not_authorization_evidence(self) -> None:
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "MIT"}),
            encoding="utf-8",
        )
        (self.root / "LICENSE").write_text("MIT License\\nfirst-party grant\\n", encoding="utf-8")
        (self.root / "NOTICE").write_text("OpenCode attribution\\n", encoding="utf-8")
        self._commit_audit_fixture()

        report = audit_repository(self.root)

        self.assertFalse(report["distribution_license"]["legal_decision_made"])
        self.assertFalse(report["distribution_license"]["root_license_tracked"])
        self.assertFalse(report["distribution_license"]["root_notice_tracked"])

    def test_dependency_license_symlink_is_not_counted_as_direct_legal_file(self) -> None:
        package_license = self.root / "node_modules" / "first-party-runtime" / "LICENSE"
        package_license.unlink()
        package_license.symlink_to(self.root / "opencode" / "LICENSE")

        report = audit_repository(self.root)

        first_party = next(
            item
            for item in report["runtime_dependencies"]["packages"]
            if item["name"] == "first-party-runtime"
        )
        self.assertEqual(first_party["license_files"], [])
        self.assertIn(
            "first-party-runtime",
            {item["name"] for item in report["runtime_dependencies"]["missing_license_files"]},
        )

    MIT_GRANT_TEXT = (
        "MIT License\n\nCopyright (c) 2020 Example Contributors\n\n"
        "Permission is hereby granted, free of charge, to any person obtaining a copy "
        "of this software and associated documentation files (the 'Software'), to deal "
        "in the Software without restriction, including without limitation the rights "
        "to use, copy, modify, merge, publish, distribute, sublicense, and/or sell "
        "copies of the Software, and to permit persons to whom the Software is "
        "furnished to do so, subject to the following conditions:\n\n"
        "The above copyright notice and this permission notice shall be included in all "
        "copies or substantial portions of the Software.\n\n"
        "THE SOFTWARE IS PROVIDED 'AS IS', WITHOUT WARRANTY OF ANY KIND, EXPRESS OR "
        "IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, "
        "FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.\n"
    )

    def _install_license_fixture_package(
        self, name: str, version: str, declared: str | None, files: dict[str, str]
    ) -> None:
        package = self.root / "node_modules" / name
        package.mkdir(parents=True)
        manifest: dict = {"name": name, "version": version}
        if declared is not None:
            manifest["license"] = declared
        (package / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
        for relative, content in files.items():
            target = package / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(content, encoding="utf-8")
        product = self.root / "packages" / "opencode" / "package.json"
        product_manifest = json.loads(product.read_text(encoding="utf-8"))
        product_manifest.setdefault("dependencies", {})[name] = version
        product.write_text(json.dumps(product_manifest), encoding="utf-8")

    def test_local_full_grant_text_closes_only_hashed_declared_package_rows(self) -> None:
        # Item 8: a direct-notice row closes only when the package's own grant
        # text is present locally, hashed, and matches its declared license.
        self._install_license_fixture_package(
            "readme-license-runtime", "1.0.0", "MIT", {"README.md": self.MIT_GRANT_TEXT}
        )
        self._install_license_fixture_package(
            "mismatch-license-runtime", "1.0.0", "Apache-2.0", {"README.md": self.MIT_GRANT_TEXT}
        )
        self._install_license_fixture_package(
            "undeclared-license-runtime", "1.0.0", None, {"README.md": self.MIT_GRANT_TEXT}
        )
        self._install_license_fixture_package(
            "nested-license-runtime", "1.0.0", "MIT", {"sub/LICENSE": self.MIT_GRANT_TEXT}
        )

        report = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)
        rows = {item["name"]: item for item in report["packages"]}
        missing = {item["name"] for item in report["missing_license_files"]}

        closed = rows["readme-license-runtime"]
        self.assertNotIn("readme-license-runtime", missing)
        self.assertEqual(closed["license_files"], [])
        self.assertEqual(closed["grant_text_status"], "package_grant_text")
        self.assertEqual(len(closed["license_text_files"]), 1)
        evidence = closed["license_text_files"][0]
        self.assertEqual(evidence["file"], "README.md")
        self.assertEqual(evidence["grant"], "MIT")
        payload = self.MIT_GRANT_TEXT.encode("utf-8")
        self.assertEqual(evidence["bytes"], len(payload))
        self.assertEqual(evidence["sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(
            {item["name"] for item in report["grant_text_without_dedicated_license_file"]},
            {"readme-license-runtime"},
        )

        # A grant text that does not match the declared identifier never closes.
        self.assertIn("mismatch-license-runtime", missing)
        self.assertEqual(rows["mismatch-license-runtime"]["license_text_files"], [])

        # Missing metadata is never closed by text alone (no inferred grant).
        self.assertIn("undeclared-license-runtime", missing)
        self.assertIn(
            "undeclared-license-runtime",
            {item["name"] for item in report["missing_license_metadata"]},
        )
        self.assertEqual(rows["undeclared-license-runtime"]["license_text_files"], [])
        self.assertEqual(rows["undeclared-license-runtime"]["grant_text_status"], "none")

        # Component-scoped text in a nested directory is not package-level text.
        self.assertIn("nested-license-runtime", missing)

    def test_missing_license_metadata_rows_keep_named_blockers_with_text_evidence(self) -> None:
        # Exact evidence shapes for the three live blockers: text without a
        # manifest field (seq-queue), and no local grant at all (openauth,
        # poe-oauth).
        self._install_license_fixture_package(
            "text-only-license-runtime", "1.0.0", None, {"LICENSE": self.MIT_GRANT_TEXT}
        )
        self._install_license_fixture_package("no-evidence-license-runtime", "1.0.0", None, {})

        report = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)
        metadata_rows = {item["name"]: item for item in report["missing_license_metadata"]}
        missing = {item["name"] for item in report["missing_license_files"]}

        text_only = metadata_rows["text-only-license-runtime"]
        self.assertEqual(text_only["license_files"], ["LICENSE"])
        self.assertEqual(text_only["grant_text_status"], "direct_file")
        self.assertEqual(text_only["license_text_files"], [])
        self.assertNotIn("text-only-license-runtime", missing)

        no_evidence = metadata_rows["no-evidence-license-runtime"]
        self.assertEqual(no_evidence["license_files"], [])
        self.assertEqual(no_evidence["grant_text_status"], "none")
        self.assertIn("no-evidence-license-runtime", missing)

    def test_artifact_license_grant_and_notice_attribution_are_content_validated(self) -> None:
        # Item 49: candidate legal files must carry the selected first-party
        # grant and preserve upstream attribution, not merely exist by name.
        weak = self.root / "weak-legal-artifact"
        weak.mkdir()
        (weak / "horizoncode").write_bytes(b"candidate")
        (weak / "LICENSE").write_text("not a grant\n", encoding="utf-8")
        (weak / "NOTICE.txt").write_text("third-party notes\n", encoding="utf-8")

        strong = self.root / "strong-legal-artifact"
        strong.mkdir()
        (strong / "horizoncode").write_bytes(b"candidate")
        (strong / "LICENSE").write_text(self.MIT_GRANT_TEXT, encoding="utf-8")
        (strong / "NOTICE.txt").write_text(
            "OpenCode-derived software\nCopyright (c) 2025 opencode\n"
            "The license text is preserved in opencode/LICENSE.\n",
            encoding="utf-8",
        )

        weak_report = inspect_artifact(weak)
        strong_report = inspect_artifact(strong)

        self.assertFalse(weak_report["license_grant_present"])
        self.assertFalse(weak_report["notice_attribution_valid"])
        self.assertTrue(strong_report["license_grant_present"])
        self.assertTrue(strong_report["notice_attribution_valid"])

        report = audit_repository(self.root, artifact=weak)
        blockers = report["blockers"]
        self.assertIn(
            "the inspected artifact LICENSE file does not contain the selected first-party MIT grant text",
            blockers,
        )
        self.assertIn(
            "the inspected artifact NOTICE file does not preserve the OpenCode copyright/license attribution",
            blockers,
        )

    # Synthetic structural skeleton only: it carries the canonical Apache-2.0
    # marker and section markers so the audit's completeness rule is testable
    # without copying any real license body into this test file.
    APACHE_GRANT_TEXT = (
        "Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/\n"
        "TERMS AND CONDITIONS FOR USE, REPRODUCTION, AND DISTRIBUTION\n"
        "1. Definitions.\n2. Grant of Copyright License.\n3. Grant of Patent License.\n"
        "8. Limitation of Liability.\n9. Accepting Warranty or Additional Liability.\n"
        "END OF TERMS AND CONDITIONS\n"
        "APPENDIX: How to apply the Apache License to your work\n"
        "[yyyy] [name of copyright owner]\n"
        'distributed under the License is distributed on an "AS IS" BASIS, WITHOUT '
        "WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the "
        "License for the specific language governing permissions and limitations "
        "under the License.\n"
    )

    def _install_canonical_notice_fixture(self, text: str, recorded_sha: str | None = None) -> Path:
        canonical_dir = self.root / "scripts" / "release" / "notice-texts"
        canonical_dir.mkdir(parents=True, exist_ok=True)
        payload = text.encode("utf-8")
        (canonical_dir / "Apache-2.0.txt").write_bytes(payload)
        provenance = {
            "Apache-2.0": {
                "file": "scripts/release/notice-texts/Apache-2.0.txt",
                "sha256": recorded_sha or hashlib.sha256(payload).hexdigest(),
                "source": {
                    "package": "fixture-package@1.0.0",
                    "path": "node_modules/fixture-package/LICENSE",
                    "byte_identical_copies_observed": 1,
                },
            }
        }
        (self.root / "scripts" / "release" / "notice-texts-provenance.json").write_text(
            json.dumps(provenance), encoding="utf-8"
        )
        return canonical_dir

    def test_canonical_notice_text_closes_only_declared_complete_canonical_grants(self) -> None:
        # Thread 1: a promoted canonical body closes a row only for grants whose
        # canonical text carries no package-specific copyright line, and only
        # when the stored bytes match the recorded provenance hash.
        canonical_dir = self._install_canonical_notice_fixture(self.APACHE_GRANT_TEXT)
        self._install_license_fixture_package("apache-declared-runtime", "1.0.0", "Apache-2.0", {})
        self._install_license_fixture_package("apache-lowercase-runtime", "1.0.0", "apache-2.0", {})
        self._install_license_fixture_package("dual-declared-runtime", "1.0.0", "MIT OR Apache-2.0", {})
        self._install_license_fixture_package("mit-declared-runtime", "1.0.0", "MIT", {})
        self._install_license_fixture_package("unlicensed-declared-runtime", "1.0.0", None, {})

        report = scan_runtime_dependencies(
            self.root / "packages" / "opencode",
            self.root,
            canonical_notice_dir=canonical_dir,
        )
        rows = {item["name"]: item for item in report["packages"]}
        missing = {item["name"] for item in report["missing_license_files"]}

        for name in ("apache-declared-runtime", "apache-lowercase-runtime", "dual-declared-runtime"):
            with self.subTest(closed=name):
                self.assertNotIn(name, missing)
                evidence = rows[name]["license_text_files"]
                self.assertEqual(len(evidence), 1)
                self.assertEqual(evidence[0]["grant"], "Apache-2.0")
                self.assertEqual(evidence[0]["evidence"], "canonical_text_promoted")
                self.assertEqual(evidence[0]["sha256"], hashlib.sha256(self.APACHE_GRANT_TEXT.encode()).hexdigest())
                self.assertEqual(rows[name]["grant_text_status"], "canonical_text")
                self.assertIn(
                    name,
                    {item["name"] for item in report["grant_text_without_dedicated_license_file"]},
                )

        # MIT needs this package's own copyright line, and an undeclared
        # package has no grant at all: neither can be closed by promotion.
        self.assertIn("mit-declared-runtime", missing)
        self.assertEqual(rows["mit-declared-runtime"]["license_text_files"], [])
        self.assertIn("unlicensed-declared-runtime", missing)
        self.assertIn(
            "unlicensed-declared-runtime",
            {item["name"] for item in report["missing_license_metadata"]},
        )

    def test_canonical_notice_text_requires_matching_provenance_and_complete_markers(self) -> None:
        tampered_dir = self._install_canonical_notice_fixture(
            self.APACHE_GRANT_TEXT, recorded_sha="0" * 64
        )
        self._install_license_fixture_package("tampered-text-runtime", "1.0.0", "Apache-2.0", {})
        report = scan_runtime_dependencies(
            self.root / "packages" / "opencode", self.root, canonical_notice_dir=tampered_dir
        )
        self.assertIn(
            "tampered-text-runtime",
            {item["name"] for item in report["missing_license_files"]},
        )

        # A truncated/incomplete canonical body never closes even with a
        # matching provenance hash.
        short = "Apache License\nVersion 2.0\n"
        short_dir = self._install_canonical_notice_fixture(short)
        self._install_license_fixture_package("short-text-runtime", "1.0.0", "Apache-2.0", {})
        report = scan_runtime_dependencies(
            self.root / "packages" / "opencode", self.root, canonical_notice_dir=short_dir
        )
        self.assertIn(
            "short-text-runtime",
            {item["name"] for item in report["missing_license_files"]},
        )

    def test_artifact_legal_files_must_match_the_tracked_root_grant_and_notice(self) -> None:
        # Thread 2 hardening: the build packages the tracked root LICENSE and
        # NOTICE verbatim, so an artifact whose legal files silently differ is
        # not the reviewed candidate.
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "MIT"}),
            encoding="utf-8",
        )
        (self.root / "LICENSE").write_text(self.MIT_GRANT_TEXT, encoding="utf-8")
        (self.root / "NOTICE").write_text(
            "OpenCode-derived software\nCopyright (c) 2025 opencode\n"
            "The license text is preserved in opencode/LICENSE.\n",
            encoding="utf-8",
        )
        self._commit_audit_fixture()
        subprocess.run(["git", "add", "-f", "LICENSE", "NOTICE"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "track grant"], cwd=self.root, check=True)

        mismatched = self.root / "mismatched-legal-artifact"
        mismatched.mkdir()
        (mismatched / "horizoncode").write_bytes(b"candidate")
        (mismatched / "LICENSE").write_text(self.MIT_GRANT_TEXT + "\nlocal extra line\n", encoding="utf-8")
        (mismatched / "NOTICE").write_text(
            "OpenCode-derived software\nCopyright (c) 2025 opencode\nSee opencode/LICENSE.\n",
            encoding="utf-8",
        )
        matched = self.root / "matched-legal-artifact"
        matched.mkdir()
        (matched / "horizoncode").write_bytes(b"candidate")
        shutil.copyfile(self.root / "LICENSE", matched / "LICENSE")
        shutil.copyfile(self.root / "NOTICE", matched / "NOTICE")

        report = audit_repository(self.root, artifact=mismatched)
        blockers = report["blockers"]
        self.assertIn("artifact LICENSE does not match the tracked repository LICENSE", blockers)
        self.assertIn("artifact NOTICE does not match the tracked repository NOTICE", blockers)

        clean = audit_repository(self.root, artifact=matched)
        self.assertNotIn(
            "artifact LICENSE does not match the tracked repository LICENSE", clean["blockers"]
        )
        self.assertNotIn(
            "artifact NOTICE does not match the tracked repository NOTICE", clean["blockers"]
        )

    def test_package_legal_file_scan_limit_marks_inventory_incomplete(self) -> None:
        with patch("scripts.release.audit_distribution.MAX_PACKAGE_DIRECTORY_ENTRIES", 1):
            inventory = scan_runtime_dependencies(self.root / "packages" / "opencode", self.root)

        self.assertTrue(
            any("legal-file inventory exceeds 1 entries" in item for item in inventory["inventory_errors"])
        )

    def test_artifact_inventory_finds_licenses_without_claiming_legal_clearance(self) -> None:
        artifact = self.root / "release-artifact"
        artifact.mkdir()
        (artifact / "opencode").write_bytes(b"test executable")
        (artifact / "LICENSE").write_text(self.vendor_license, encoding="utf-8")
        (artifact / "THIRD_PARTY_NOTICES.txt").write_text("third-party notices\n", encoding="utf-8")

        report = audit_repository(self.root, artifact=artifact)

        self.assertEqual(report["artifact"]["status"], "REVIEW_REQUIRED")
        self.assertTrue(report["artifact"]["contains_license_file"])
        self.assertTrue(report["artifact"]["contains_notice_file"])
        self.assertFalse(report["artifact"]["source_revision_bound"])
        self.assertEqual(report["distribution_license"]["status"], "BLOCKED")

    def test_artifact_inventory_rejects_multiple_provenance_manifests(self) -> None:
        artifact = self.root / "multiple-provenance-manifests"
        artifact.mkdir()
        binary = artifact / "horizoncode"
        binary.write_bytes(b"candidate binary")
        license_file = artifact / "LICENSE"
        license_file.write_bytes(b"license\n")
        notice_file = artifact / "NOTICE.txt"
        notice_file.write_bytes(b"notice\n")
        competing_manifest = artifact / "release-manifest.json"
        competing_manifest.write_text(
            json.dumps({"sourceRevision": "different-revision", "sourceStateSha256": "f" * 64}),
            encoding="utf-8",
        )
        inventory = []
        for path in (binary, license_file, notice_file, competing_manifest):
            contents = path.read_bytes()
            inventory.append({
                "path": path.name,
                "sizeBytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            })
        source_digest = "0" * 64
        primary_manifest = {
            "schemaVersion": 2,
            "sourceRevision": "0123456789abcdef",
            "sourceStateSha256": source_digest,
            "postBuildSourceStateSha256": source_digest,
            "binaryPath": binary.name,
            "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "binarySizeBytes": binary.stat().st_size,
            "artifactFiles": inventory,
        }
        (artifact / "artifact-manifest.json").write_text(json.dumps(primary_manifest), encoding="utf-8")

        report = inspect_artifact(artifact)

        self.assertFalse(report["artifact_inventory_valid"])
        self.assertIn("artifact contains multiple provenance manifests", report["artifact_inventory_errors"])

    def test_artifact_inventory_rejects_legal_file_as_candidate_binary(self) -> None:
        artifact = self.root / "legal-file-as-binary"
        artifact.mkdir()
        binary = artifact / "horizoncode"
        binary.write_bytes(b"candidate binary")
        license_file = artifact / "LICENSE"
        license_file.write_bytes(b"license\n")
        notice_file = artifact / "NOTICE.txt"
        notice_file.write_bytes(b"notice\n")
        inventory = []
        for path in (binary, license_file, notice_file):
            contents = path.read_bytes()
            inventory.append({
                "path": path.name,
                "sizeBytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            })
        source_digest = "0" * 64
        manifest = {
            "schemaVersion": 2,
            "sourceRevision": "0123456789abcdef",
            "sourceStateSha256": source_digest,
            "postBuildSourceStateSha256": source_digest,
            "binaryPath": license_file.name,
            "binarySha256": hashlib.sha256(license_file.read_bytes()).hexdigest(),
            "binarySizeBytes": license_file.stat().st_size,
            "artifactFiles": inventory,
        }
        (artifact / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        report = inspect_artifact(artifact)

        self.assertFalse(report["artifact_inventory_valid"])
        self.assertFalse(report["binary_digest_valid"])

    def test_artifact_inventory_rejects_non_executable_horizoncode(self) -> None:
        artifact = self.root / "non-executable-candidate"
        artifact.mkdir()
        binary = artifact / "horizoncode"
        binary.write_bytes(b"candidate bytes")
        binary.chmod(0o644)
        license_file = artifact / "LICENSE"
        license_file.write_bytes(b"license\n")
        notice_file = artifact / "NOTICE.txt"
        notice_file.write_bytes(b"notice\n")
        inventory = []
        for path in (binary, license_file, notice_file):
            contents = path.read_bytes()
            inventory.append({
                "path": path.name,
                "sizeBytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            })
        source_digest = "0" * 64
        manifest = {
            "schemaVersion": 2,
            "sourceRevision": "0123456789abcdef",
            "sourceStateSha256": source_digest,
            "postBuildSourceStateSha256": source_digest,
            "binaryPath": binary.name,
            "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "binarySizeBytes": binary.stat().st_size,
            "artifactFiles": inventory,
        }
        (artifact / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        report = inspect_artifact(artifact)

        self.assertFalse(report["artifact_inventory_valid"])
        self.assertFalse(report["binary_digest_valid"])

    def test_artifact_inventory_rejects_empty_executable_horizoncode(self) -> None:
        artifact = self.root / "empty-executable-candidate"
        artifact.mkdir()
        binary = artifact / "horizoncode"
        binary.write_bytes(b"")
        binary.chmod(0o755)
        license_file = artifact / "LICENSE"
        license_file.write_bytes(b"license\n")
        notice_file = artifact / "NOTICE.txt"
        notice_file.write_bytes(b"notice\n")
        inventory = []
        for path in (binary, license_file, notice_file):
            contents = path.read_bytes()
            inventory.append({
                "path": path.name,
                "sizeBytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            })
        source_digest = "0" * 64
        manifest = {
            "schemaVersion": 2,
            "sourceRevision": "0123456789abcdef",
            "sourceStateSha256": source_digest,
            "postBuildSourceStateSha256": source_digest,
            "binaryPath": binary.name,
            "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            "binarySizeBytes": binary.stat().st_size,
            "artifactFiles": inventory,
        }
        (artifact / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        report = inspect_artifact(artifact)

        self.assertFalse(report["artifact_inventory_valid"])
        self.assertFalse(report["binary_digest_valid"])

    def test_archive_inventory_reads_commit_and_notice_hashes_without_extracting(self) -> None:
        artifact = self.root / "release.tar.gz"
        license_bytes = b"MIT License\nupstream text\n"
        notice_bytes = b"third-party notice\n"
        manifest_bytes = b'{"sourceRevision":"0123456789abcdef"}'
        with tarfile.open(artifact, "w:gz") as archive:
            for name, contents in (
                ("opencode/LICENSE", license_bytes),
                ("opencode/THIRD_PARTY_NOTICES.txt", notice_bytes),
                ("opencode/release-manifest.json", manifest_bytes),
            ):
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))

        report = inspect_artifact(artifact)

        self.assertEqual(report["source_revision"], "0123456789abcdef")
        self.assertTrue(report["source_revision_bound"])
        self.assertEqual(
            report["legal_file_facts"],
            [
                {
                    "path": "opencode/LICENSE",
                    "size": len(license_bytes),
                    "sha256": hashlib.sha256(license_bytes).hexdigest(),
                },
                {
                    "path": "opencode/THIRD_PARTY_NOTICES.txt",
                    "size": len(notice_bytes),
                    "sha256": hashlib.sha256(notice_bytes).hexdigest(),
                },
            ],
        )
        self.assertFalse((self.root / "opencode" / "release-manifest.json").exists())

    def test_artifact_symlink_is_blocked_instead_of_auditing_its_target(self) -> None:
        artifact = self.root / "release-artifact"
        artifact.mkdir()
        (artifact / "LICENSE").write_text("license\n", encoding="utf-8")
        (artifact / "NOTICE.txt").write_text("notice\n", encoding="utf-8")
        link = self.root / "release-artifact-link"
        link.symlink_to(artifact, target_is_directory=True)

        report = inspect_artifact(link)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["symlinks"], [str(link)])
        self.assertEqual(report["members"], [])
        self.assertEqual(report["legal_file_facts"], [])

        repository_report = audit_repository(self.root, artifact=link)
        self.assertEqual(repository_report["artifact"]["status"], "BLOCKED")
        self.assertEqual(repository_report["artifact"]["members"], [])

    def test_directory_artifact_hardlink_is_reported_as_unsafe(self) -> None:
        artifact = self.root / "hardlink-artifact"
        artifact.mkdir()
        original = artifact / "LICENSE"
        original.write_text("license\\n", encoding="utf-8")
        (artifact / "NOTICE.txt").write_text("notice\\n", encoding="utf-8")
        alias = artifact / "bin" / "horizoncode"
        alias.parent.mkdir()
        alias.hardlink_to(original)

        report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["special_entries"], ["LICENSE", "bin/horizoncode"])

    def test_zip_artifact_symlink_is_reported_and_blocks_inventory(self) -> None:
        artifact = self.root / "release.zip"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("LICENSE", "license\n")
            archive.writestr("NOTICE.txt", "notice\n")
            link = zipfile.ZipInfo("linked-notice.txt")
            link.create_system = 3
            link.external_attr = (stat.S_IFLNK | 0o777) << 16
            archive.writestr(link, "../outside/NOTICE.txt")

        report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["symlinks"], ["linked-notice.txt"])

    def test_tar_artifact_special_file_is_reported_and_blocks_inventory(self) -> None:
        artifact = self.root / "special-entry.tar.gz"
        with tarfile.open(artifact, "w:gz") as archive:
            for name, contents in (("LICENSE", b"license\n"), ("NOTICE.txt", b"notice\n")):
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
            fifo = tarfile.TarInfo("runtime/device-pipe")
            fifo.type = tarfile.FIFOTYPE
            archive.addfile(fifo)

        report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["special_entries"], ["runtime/device-pipe"])

    def test_artifact_inventory_fails_closed_when_directory_walk_skips_unreadable_subtrees(self) -> None:
        artifact = self.root / "partially-readable-artifact"
        artifact.mkdir()
        (artifact / "LICENSE").write_text("license\n", encoding="utf-8")
        (artifact / "NOTICE.txt").write_text("notice\n", encoding="utf-8")

        def walk_with_unreadable_subtree(path, *, followlinks, onerror=None):
            yield str(path), ["unreadable"], ["LICENSE", "NOTICE.txt"]
            if onerror is not None:
                onerror(PermissionError("cannot enumerate artifact subtree"))

        with patch("scripts.release.audit_distribution.os.walk", side_effect=walk_with_unreadable_subtree):
            report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("PermissionError", report["error"])

    def test_ambiguous_archive_legal_file_is_a_release_blocker(self) -> None:
        artifact = self.root / "ambiguous.tar.gz"
        with tarfile.open(artifact, "w:gz") as archive:
            for contents in (b"first license\n", b"different license\n"):
                member = tarfile.TarInfo("LICENSE")
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
            notice = tarfile.TarInfo("NOTICE.txt")
            notice_bytes = b"notice\n"
            notice.size = len(notice_bytes)
            archive.addfile(notice, io.BytesIO(notice_bytes))

        report = audit_repository(self.root, artifact=artifact)

        self.assertEqual(report["artifact"]["status"], "BLOCKED")
        self.assertIn("archive legal file could not be inspected: LICENSE", report["blockers"])

    def test_zip_artifact_rejects_noncanonical_path_aliases(self) -> None:
        artifact = self.root / "path-alias.zip"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("LICENSE", "license\\n")
            archive.writestr("NOTICE.txt", "notice\\n")
            archive.writestr("bin/./horizoncode", "first binary\\n")
            archive.writestr("bin/horizoncode", "second binary\\n")

        report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("bin/./horizoncode", report["unsafe_paths"])

    def test_zip_artifact_rejects_traversal_directory_entries(self) -> None:
        artifact = self.root / "traversal-directory.zip"
        with zipfile.ZipFile(artifact, "w") as archive:
            archive.writestr("LICENSE", "license\n")
            archive.writestr("NOTICE.txt", "notice\n")
            archive.writestr("../outside/", "")

        report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("../outside/", report["special_entries"])

    def test_tar_artifact_rejects_traversal_directory_entries(self) -> None:
        artifact = self.root / "traversal-directory.tar"
        with tarfile.open(artifact, "w") as archive:
            for name, contents in (("LICENSE", b"license\n"), ("NOTICE.txt", b"notice\n")):
                member = tarfile.TarInfo(name)
                member.size = len(contents)
                archive.addfile(member, io.BytesIO(contents))
            directory = tarfile.TarInfo("../outside/")
            directory.type = tarfile.DIRTYPE
            archive.addfile(directory)

        report = inspect_artifact(artifact)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertIn("../outside", report["special_entries"])

    def test_tracked_root_license_symlink_is_not_first_party_license_evidence(self) -> None:
        self._commit_audit_fixture()
        (self.root / "LICENSE").unlink()
        (self.root / "LICENSE").symlink_to("opencode/LICENSE")
        subprocess.run(["git", "add", "-f", "LICENSE"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "track symlink"], cwd=self.root, check=True)

        report = audit_repository(self.root)

        self.assertFalse(report["distribution_license"]["root_license_is_regular"])
        self.assertFalse(report["distribution_license"]["root_license_tracked"])
        self.assertFalse(report["distribution_license"]["root_license_matches_vendor"])

    def test_dirty_source_checkout_is_a_release_blocker(self) -> None:
        self._commit_audit_fixture()
        (self.root / "uncommitted-source.ts").write_text("export const localOnly = true\n", encoding="utf-8")

        report = audit_repository(self.root)

        self.assertEqual(report["source"]["status"], "DIRTY")
        self.assertIn("source checkout is DIRTY; release evidence requires a clean commit", report["blockers"])

    def test_artifact_revision_must_match_the_clean_source_revision(self) -> None:
        revision = self._commit_audit_fixture()
        artifact = self.root / "release-artifacts" / "candidate"
        artifact.mkdir(parents=True)
        (artifact / "opencode").write_bytes(b"opaque executable")
        (artifact / "LICENSE").write_text("license\n", encoding="utf-8")
        (artifact / "NOTICE.txt").write_text("notice\n", encoding="utf-8")
        (artifact / "release-manifest.json").write_text(
            json.dumps({"sourceRevision": "different-revision"}), encoding="utf-8"
        )

        report = audit_repository(self.root, artifact=artifact)

        self.assertEqual(report["source"]["revision"], revision)
        self.assertIn(
            "artifact source revision different-revision does not match checkout revision " + revision,
            report["blockers"],
        )

    def test_artifact_source_state_digest_must_match_the_audited_checkout(self) -> None:
        revision = self._commit_audit_fixture()
        artifact = self.root / "release-artifacts" / "candidate"
        (artifact / "bin").mkdir(parents=True)
        binary = artifact / "bin" / "horizoncode"
        binary.write_bytes(b"candidate executable")
        (artifact / "LICENSE").write_text("license\n", encoding="utf-8")
        (artifact / "NOTICE.txt").write_text("notice\n", encoding="utf-8")
        (artifact / "release-manifest.json").write_text(
            json.dumps(
                {
                    "sourceRevision": revision,
                    "sourceStateSha256": "0" * 64,
                    "binaryPath": "bin/horizoncode",
                    "binarySha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
                }
            ),
            encoding="utf-8",
        )

        report = audit_repository(self.root, artifact=artifact)

        self.assertRegex(report["source"]["source_state_sha256"], r"^[0-9a-f]{64}$")
        self.assertFalse(report["artifact"]["source_state_digest_matches"])
        self.assertIn(
            "artifact source-state SHA-256 does not match the audited source tree",
            report["blockers"],
        )

    def test_artifact_binary_digest_must_match_the_manifest(self) -> None:
        revision = self._commit_audit_fixture()
        artifact = self.root / "release-artifacts" / "candidate"
        (artifact / "bin").mkdir(parents=True)
        executable = artifact / "bin" / "horizoncode"
        executable.write_bytes(b"candidate executable")
        executable.chmod(0o755)
        (artifact / "LICENSE").write_text("license\n", encoding="utf-8")
        (artifact / "NOTICE.txt").write_text("notice\n", encoding="utf-8")
        (artifact / "release-manifest.json").write_text(
            json.dumps(
                {
                    "sourceRevision": revision,
                    "sourceStateSha256": "0" * 64,
                    "binaryPath": "bin/horizoncode",
                    "binarySha256": "f" * 64,
                }
            ),
            encoding="utf-8",
        )

        report = audit_repository(self.root, artifact=artifact)

        self.assertFalse(report["artifact"]["binary_digest_matches"])
        self.assertIn("artifact binary SHA-256 does not match its provenance manifest", report["blockers"])

    def test_product_target_report_distinguishes_horizoncode_workspace_from_upstream_package(self) -> None:
        report = audit_repository(self.root)

        self.assertEqual(report["product_target"]["workspace_identity"], "HORIZONCODE")
        self.assertEqual(report["product_target"]["package_name"], "opencode")
        self.assertEqual(report["product_target"]["classification"], "UPSTREAM_OPENCODE")
        self.assertFalse(report["product_target"]["is_horizoncode_package"])

    def test_product_target_report_recognizes_a_horizoncode_package(self) -> None:
        package_path = self.root / "packages" / "opencode" / "package.json"
        manifest = json.loads(package_path.read_text(encoding="utf-8"))
        manifest["name"] = "horizoncode"
        package_path.write_text(json.dumps(manifest), encoding="utf-8")

        report = audit_repository(self.root)

        self.assertEqual(report["product_target"]["classification"], "HORIZONCODE")
        self.assertTrue(report["product_target"]["is_horizoncode_package"])

    def test_distribution_audit_rejects_non_horizoncode_package_launcher(self) -> None:
        package_path = self.root / "packages" / "opencode" / "package.json"
        manifest = json.loads(package_path.read_text(encoding="utf-8"))
        manifest["bin"] = {"opencode": "./bin/opencode"}
        package_path.write_text(json.dumps(manifest), encoding="utf-8")
        (self.root / "install").write_text("COMMAND=horizoncode\nALIAS=hzcode\n", encoding="utf-8")

        report = audit_repository(self.root)

        self.assertIn("packages/opencode must expose horizoncode and hzcode from the same launcher", report["blockers"])

    def test_distribution_audit_rejects_non_horizoncode_installer_command(self) -> None:
        package_path = self.root / "packages" / "opencode" / "package.json"
        manifest = json.loads(package_path.read_text(encoding="utf-8"))
        manifest["bin"] = {"horizoncode": "./bin/horizoncode", "hzcode": "./bin/horizoncode"}
        package_path.write_text(json.dumps(manifest), encoding="utf-8")
        (self.root / "install").write_text("COMMAND=opencode\n", encoding="utf-8")

        report = audit_repository(self.root)

        self.assertIn("standalone installer must install horizoncode with the hzcode short command", report["blockers"])

    def test_combined_release_gate_never_passes_without_license_signing_and_install_evidence(self) -> None:
        report = evaluate_release_gate(self.root)

        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["distribution_license_decision"], "NOT_AUTHORIZED")
        self.assertEqual(report["signing_update_policy"], "DEFERRED_UNAVAILABLE")
        self.assertEqual(report["signing_update"]["status"], "UNAVAILABLE")
        self.assertEqual(report["signing_update"]["remote_install"], "UNAVAILABLE")
        self.assertEqual(report["signing_update"]["automatic_update"], "UNAVAILABLE")
        self.assertIsNone(report["signing_update"]["trust_root"])
        self.assertEqual(report["install_matrix"]["status"], "NOT_RUN")
        self.assertEqual(report["platform_support_matrix"]["assessment_status"], "NOT_VERIFIED")
        self.assertEqual(report["platform_support_matrix"]["lanes"]["native_windows"]["support_status"], "UNAVAILABLE")
        self.assertIn("HorizonCode distribution license and notice grant are not authorized", report["blockers"])
        self.assertIn(
            "Linux/WSL platform support acceptance remains unverified; install-matrix evidence is not full platform acceptance",
            report["blockers"],
        )
        self.assertNotIn("signing/update trust root and rollback policy remain unresolved", report["blockers"])
        self.assertIn("clean-install, upgrade, migration, TUI, and rollback evidence was not run", report["blockers"])
        self.assertIn("previous_binary_sha256", report["inputs"])
        self.assertIsNone(report["inputs"]["previous_binary_sha256"])

    # --- first-party license/notice reconciliation (DEC-V1-11) ---

    def _track_distinct_first_party_grant(self) -> None:
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "MIT"}),
            encoding="utf-8",
        )
        (self.root / "LICENSE").write_text("MIT License\nfirst-party grant\n", encoding="utf-8")
        (self.root / "NOTICE").write_text(
            "OpenCode-derived software\nCopyright (c) 2025 opencode\nSee opencode/LICENSE. "
            "Closure pending\n",
            encoding="utf-8",
        )
        self._commit_audit_fixture()
        subprocess.run(["git", "add", "-f", "LICENSE", "NOTICE"], cwd=self.root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "track grant"], cwd=self.root, check=True)

    def _install_first_party_workspace_packages(self) -> None:
        for name, license_value in (("first-party-ws", "MIT"), ("apache-ws", "Apache-2.0")):
            workspace_package = self.root / "packages" / name
            workspace_package.mkdir(parents=True)
            manifest: dict = {"name": name, "version": "3.0.0"}
            if license_value is not None:
                manifest["license"] = license_value
            (workspace_package / "package.json").write_text(json.dumps(manifest), encoding="utf-8")
            (self.root / "node_modules" / name).symlink_to(workspace_package, target_is_directory=True)
            product = self.root / "packages" / "opencode" / "package.json"
            product_manifest = json.loads(product.read_text(encoding="utf-8"))
            product_manifest.setdefault("dependencies", {})[name] = "workspace:*"
            product.write_text(json.dumps(product_manifest), encoding="utf-8")

    def test_first_party_workspace_package_is_covered_by_the_tracked_root_grant_and_notice(self) -> None:
        self._install_first_party_workspace_packages()
        self._track_distinct_first_party_grant()

        report = audit_repository(self.root)

        self.assertTrue(report["distribution_license"]["legal_decision_made"])
        missing_files = {item["name"] for item in report["runtime_dependencies"]["missing_license_files"]}
        self.assertNotIn("first-party-ws", missing_files)
        # A workspace package whose declared license differs from the decided
        # first-party grant is never covered by that grant.
        self.assertIn("apache-ws", missing_files)
        evidence = report["runtime_dependencies"]["first_party_workspace_grant_evidence"]
        self.assertEqual(evidence["declared_license"], "MIT")
        self.assertEqual({item["name"] for item in evidence["packages"]}, {"first-party-ws"})

    def test_workspace_package_without_a_tracked_root_grant_stays_a_notice_blocker(self) -> None:
        self._install_first_party_workspace_packages()

        report = audit_repository(self.root)

        self.assertFalse(report["distribution_license"]["legal_decision_made"])
        missing_files = {item["name"] for item in report["runtime_dependencies"]["missing_license_files"]}
        self.assertIn("first-party-ws", missing_files)
        self.assertEqual(report["runtime_dependencies"]["first_party_workspace_grant_evidence"]["packages"], [])

    def test_first_party_workspace_manifest_license_deviations_are_reported_as_facts(self) -> None:
        devtool = self.root / "packages" / "devtool"
        devtool.mkdir(parents=True)
        (devtool / "package.json").write_text(
            json.dumps({"name": "@horizoncode/devtool", "private": True}), encoding="utf-8"
        )

        report = audit_repository(self.root)
        reconciliation = report["distribution_license"]["workspace_manifest_reconciliation"]

        self.assertGreaterEqual(reconciliation["scanned"], 2)
        self.assertIn(
            "packages/devtool/package.json",
            {item["path"] for item in reconciliation["deviations"]},
        )
        self.assertFalse(any("devtool" in blocker for blocker in report["blockers"]))

    def test_runtime_dependency_legacy_licenses_metadata_is_not_reported_as_missing(self) -> None:
        transitive = self.root / "node_modules" / "transitive-runtime" / "package.json"
        manifest = json.loads(transitive.read_text(encoding="utf-8"))
        manifest["licenses"] = [{"type": "MIT", "url": "https://example.invalid/mit"}]
        transitive.write_text(json.dumps(manifest), encoding="utf-8")

        unlicensed = self.root / "node_modules" / "unlicensed-runtime"
        unlicensed.mkdir()
        (unlicensed / "package.json").write_text(
            json.dumps({"name": "unlicensed-runtime", "version": "3.0.0"}), encoding="utf-8"
        )
        first_party = self.root / "node_modules" / "first-party-runtime" / "package.json"
        first_party_manifest = json.loads(first_party.read_text(encoding="utf-8"))
        first_party_manifest["dependencies"]["unlicensed-runtime"] = "3.0.0"
        first_party.write_text(json.dumps(first_party_manifest), encoding="utf-8")

        report = audit_repository(self.root)
        runtime = report["runtime_dependencies"]
        transitive_row = next(item for item in runtime["packages"] if item["name"] == "transitive-runtime")
        missing_metadata = {item["name"] for item in runtime["missing_license_metadata"]}

        # Declared license metadata in the package's own manifest — including the
        # legacy npm `licenses` form — counts as metadata evidence.
        self.assertEqual(transitive_row["license"], "MIT")
        self.assertNotIn("transitive-runtime", missing_metadata)
        # A manifest that declares no license metadata at all stays blocked.
        self.assertIn("unlicensed-runtime", missing_metadata)

    # --- stale artifact / candidate path detection ---

    def _write_legacy_output(self) -> Path:
        legacy = self.root / "packages" / "opencode" / "dist" / "opencode-linux-x64"
        (legacy / "bin").mkdir(parents=True)
        (legacy / "bin" / "opencode").write_bytes(b"legacy binary")
        (legacy / "package.json").write_text(json.dumps({"name": "opencode-linux-x64"}), encoding="utf-8")
        return legacy

    def _write_product_candidate(self, target: str = "horizoncode-linux-x64") -> Path:
        candidate = self.root / "packages" / "opencode" / "dist" / target / "bin"
        candidate.mkdir(parents=True)
        (candidate / "horizoncode").write_bytes(b"candidate binary")
        (candidate / "LICENSE").write_text("MIT License\n", encoding="utf-8")
        (candidate / "NOTICE").write_text("notice\n", encoding="utf-8")
        return candidate

    def test_distribution_audit_prefers_the_product_candidate_over_stale_legacy_output(self) -> None:
        legacy = self._write_legacy_output()
        candidate = self._write_product_candidate()

        report = audit_repository(self.root)
        artifact = report["artifact"]

        self.assertEqual(artifact["discovery"]["kind"], "CANDIDATE")
        self.assertEqual(Path(artifact["path"]), candidate)
        self.assertNotIn("opencode-linux-x64/bin/opencode", artifact["members"])
        self.assertIn(
            legacy.relative_to(self.root).as_posix(),
            artifact["discovery"]["stale_outputs"],
        )
        self.assertFalse(any("stale legacy build output" in blocker for blocker in report["blockers"]))
        # The candidate itself is still unqualified: no provenance manifest.
        self.assertIn(
            "candidate file inventory is missing, incomplete, or does not match the inspected artifact",
            report["blockers"],
        )
        self.assertEqual(report["release_status"], "BLOCKED")

    def test_distribution_audit_blocks_stale_legacy_build_output_that_is_not_a_candidate(self) -> None:
        legacy = self._write_legacy_output()

        report = audit_repository(self.root)
        artifact = report["artifact"]

        self.assertEqual(artifact["discovery"]["kind"], "STALE_LEGACY")
        self.assertEqual(Path(artifact["path"]), self.root / "packages" / "opencode" / "dist")
        self.assertIn(
            f"stale legacy build output is not a HorizonCode candidate artifact: "
            f"{legacy.relative_to(self.root).as_posix()}",
            report["blockers"],
        )
        self.assertIn("inspected artifact is missing legal files or contains unsafe links/paths", report["blockers"])
        self.assertEqual(report["release_status"], "BLOCKED")

    def test_distribution_audit_rejects_ambiguous_candidate_discovery_without_an_explicit_artifact(self) -> None:
        self._write_product_candidate("horizoncode-linux-x64")
        self._write_product_candidate("horizoncode-linux-arm64")

        report = audit_repository(self.root)

        self.assertEqual(report["artifact"]["discovery"]["kind"], "AMBIGUOUS")
        self.assertIn(
            "multiple candidate artifacts were found; supply --artifact to select the exact candidate",
            report["blockers"],
        )
        self.assertIsNone(report["artifact"]["discovery"]["selected"])
        self.assertEqual(report["release_status"], "BLOCKED")

        explicit = self.root / "packages" / "opencode" / "dist" / "horizoncode-linux-x64" / "bin"
        resolved = audit_repository(self.root, artifact=explicit)

        self.assertEqual(resolved["artifact"]["discovery"]["kind"], "SUPPLIED")
        self.assertNotIn(
            "multiple candidate artifacts were found; supply --artifact to select the exact candidate",
            resolved["blockers"],
        )
        self.assertNotIn("no built package artifact was supplied or found", resolved["blockers"])


class PlatformSupportMatrixTests(unittest.TestCase):
    def test_missing_product_run_keeps_linux_unverified_windows_unavailable_and_macos_out_of_scope(self) -> None:
        matrix = build_platform_support_matrix({"status": "NOT_RUN"})

        self.assertEqual(matrix["scope"], "install-matrix evidence only; not complete platform acceptance")
        self.assertEqual(matrix["lanes"]["native_linux"]["support_status"], "NOT_VERIFIED")
        self.assertEqual(matrix["lanes"]["native_linux"]["install_matrix_status"], "NOT_RUN")
        self.assertEqual(matrix["lanes"]["wsl2"]["support_status"], "NOT_VERIFIED")
        self.assertEqual(matrix["lanes"]["wsl2"]["install_matrix_status"], "NOT_RUN")
        self.assertEqual(matrix["lanes"]["native_windows"]["support_status"], "UNAVAILABLE")
        self.assertEqual(matrix["lanes"]["macos"]["support_status"], "OUT_OF_SCOPE")
        expected_dimensions = {
            "filesystem_process_network_containment",
            "peer_authentication",
            "durable_storage",
            "credential_store",
            "browser_desktop",
            "lsp_dap",
            "repl",
            "terminal_graphics",
            "package_signing_update",
        }
        self.assertEqual(set(matrix["required_dimensions"]), expected_dimensions)
        self.assertEqual(
            set(matrix["lanes"]["native_linux"]["capability_status"]), expected_dimensions
        )
        self.assertTrue(
            all(
                status == "NOT_VERIFIED"
                for name, status in matrix["lanes"]["native_linux"]["capability_status"].items()
                if name != "browser_desktop"
            )
        )
        self.assertEqual(matrix["lanes"]["native_linux"]["capability_status"]["browser_desktop"], "UNAVAILABLE")
        self.assertIsNone(matrix["observed_install_host"])

    def test_passed_wsl_install_smoke_is_recorded_without_promoting_wsl_support(self) -> None:
        evidence = {
            "status": "PASS",
            "platform": {
                "system": "Linux",
                "host_kind": "WSL2",
                "kernel": "6.6.0-microsoft-standard-WSL2",
                "architecture": "x86_64",
                "wsl": True,
            },
            "source_checkout": {"status": "CLEAN", "revision": "a" * 40},
            "artifacts": {"candidate": {"sha256": "a" * 64}},
            "scenarios": {
                name: {"status": "PASS"}
                for name in ("clean_install", "tui_launch", "upgrade", "migration", "rollback", "artifact_integrity")
            },
        }

        matrix = build_platform_support_matrix(evidence)

        self.assertEqual(matrix["observed_install_host"]["host_kind"], "WSL2")
        wsl2 = matrix["lanes"]["wsl2"]
        self.assertEqual(wsl2["install_matrix_status"], "PASS")
        self.assertEqual(wsl2["support_status"], "NOT_VERIFIED")
        self.assertEqual(wsl2["install_evidence"]["source_revision"], "a" * 40)
        self.assertEqual(wsl2["install_evidence"]["candidate_sha256"], "a" * 64)
        self.assertEqual(matrix["lanes"]["native_windows"]["support_status"], "UNAVAILABLE")

    def test_passed_native_linux_install_smoke_is_recorded_without_promoting_linux_support(self) -> None:
        evidence = {
            "status": "PASS",
            "platform": {
                "system": "Linux",
                "host_kind": "Linux",
                "kernel": "6.8.0-generic",
                "architecture": "x86_64",
                "wsl": False,
            },
            "source_checkout": {"status": "CLEAN", "revision": "b" * 40},
            "artifacts": {"candidate": {"sha256": "b" * 64}},
            "scenarios": {
                name: {"status": "PASS"}
                for name in ("clean_install", "tui_launch", "upgrade", "migration", "rollback", "artifact_integrity")
            },
        }

        matrix = build_platform_support_matrix(evidence)

        lane = matrix["lanes"]["native_linux"]
        self.assertEqual(lane["install_matrix_status"], "PASS")
        self.assertEqual(lane["support_status"], "NOT_VERIFIED")
        self.assertEqual(lane["install_evidence"]["source_revision"], "b" * 40)
        self.assertEqual(
            lane["install_evidence"]["scenario_statuses"],
            {
                name: "PASS"
                for name in ("clean_install", "tui_launch", "upgrade", "migration", "rollback", "artifact_integrity")
            },
        )
        self.assertEqual(matrix["lanes"]["wsl2"]["install_matrix_status"], "NOT_RUN")
        self.assertEqual(matrix["lanes"]["native_windows"]["support_status"], "UNAVAILABLE")
        self.assertEqual(matrix["lanes"]["macos"]["support_status"], "OUT_OF_SCOPE")
        self.assertEqual(matrix["assessment_status"], "NOT_VERIFIED")

    def test_malformed_or_incomplete_install_matrix_is_not_bound_as_evidence(self) -> None:
        base = {
            "status": "PASS",
            "platform": {"system": "Linux", "host_kind": "Linux"},
            "source_checkout": {"status": "CLEAN", "revision": "c" * 40},
            "artifacts": {"candidate": {"sha256": "c" * 64}},
            "scenarios": {
                name: {"status": "PASS"}
                for name in ("clean_install", "tui_launch", "upgrade", "migration", "rollback", "artifact_integrity")
            },
        }
        cases = {
            "malformed candidate digest": {
                **base,
                "artifacts": {"candidate": {"sha256": "candidate-sha256"}},
            },
            "incomplete scenario map": {
                **base,
                "scenarios": {"clean_install": {"status": "PASS"}},
            },
            "contradictory PASS status": {
                **base,
                "scenarios": {
                    **base["scenarios"],
                    "rollback": {"status": "NOT_RUN"},
                },
            },
        }

        for label, evidence in cases.items():
            with self.subTest(label=label):
                matrix = build_platform_support_matrix(evidence)
                lane = matrix["lanes"]["native_linux"]
                self.assertEqual(lane["install_matrix_status"], "PASS")
                self.assertIsNone(lane["install_evidence"])
                self.assertIn("not bound", lane["install_evidence_limitation"])
                self.assertEqual(lane["support_status"], "NOT_VERIFIED")

    def test_unrecognized_install_scenario_is_not_bound_as_evidence(self) -> None:
        evidence = {
            "status": "PASS",
            "platform": {"system": "Linux", "host_kind": "Linux"},
            "source_checkout": {"status": "CLEAN", "revision": "d" * 40},
            "artifacts": {"candidate": {"sha256": "d" * 64}},
            "scenarios": {
                name: {"status": "PASS"}
                for name in (
                    "clean_install",
                    "tui_launch",
                    "upgrade",
                    "migration",
                    "rollback",
                    "artifact_integrity",
                )
            },
        }
        evidence["scenarios"]["unexpected_claim"] = {"status": "PASS"}

        lane = build_platform_support_matrix(evidence)["lanes"]["native_linux"]

        self.assertIsNone(lane["install_evidence"])
        self.assertIn("not bound", lane["install_evidence_limitation"])
        self.assertEqual(lane["support_status"], "NOT_VERIFIED")

    def test_foreign_or_unbound_install_status_is_not_recorded_as_bound_evidence(self) -> None:
        foreign = build_platform_support_matrix(
            {
                "status": "SUPPORTED",
                "platform": {"system": "Linux", "host_kind": "WSL2"},
                "source_checkout": {"status": "CLEAN", "revision": "source-revision"},
                "artifacts": {"candidate": {"sha256": "candidate-sha256"}},
            }
        )
        foreign_lane = foreign["lanes"]["wsl2"]
        self.assertEqual(foreign_lane["install_matrix_status"], "UNKNOWN")
        self.assertIsNone(foreign_lane["install_evidence"])
        self.assertEqual(foreign_lane["support_status"], "NOT_VERIFIED")

        unbound = build_platform_support_matrix(
            {
                "status": "PASS",
                "platform": {"system": "Linux", "host_kind": "WSL2"},
                "source_checkout": {"status": "DIRTY", "revision": "source-revision"},
                "artifacts": {"candidate": {"sha256": "candidate-sha256"}},
            }
        )
        unbound_lane = unbound["lanes"]["wsl2"]
        self.assertEqual(unbound_lane["install_matrix_status"], "PASS")
        self.assertIsNone(unbound_lane["install_evidence"])
        self.assertIn("not bound", unbound_lane["install_evidence_limitation"])
        self.assertEqual(unbound_lane["support_status"], "NOT_VERIFIED")


class SyntheticCleanInstallMatrixTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="p9-install-", dir=SANDBOX_PARENT)
        self.root = Path(self.temp.name)
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        product_manifest = self.checkout / "packages" / "opencode" / "package.json"
        product_manifest.parent.mkdir(parents=True)
        product_manifest.write_text(
            json.dumps({"name": "horizoncode", "version": "2.0.0"}), encoding="utf-8"
        )
        self.network_probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.network_probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.network_probe.bind(("127.0.0.1", 0))
        self.network_probe.listen(8)
        self.network_probe_port = self.network_probe.getsockname()[1]
        self.host_only_sentinel = self.root / "host-only-sentinel"
        self.host_only_sentinel.write_text("not mounted into the child sandbox", encoding="utf-8")
        shutil.copy2(Path(__file__).resolve().parents[2] / "install", self.checkout / "install")
        artifact_dir = self.checkout / "packages" / "opencode" / "dist" / "horizoncode-linux-x64" / "bin"
        artifact_dir.mkdir(parents=True)
        fixture_dir = self.checkout / "scripts" / "release" / "fixtures"
        fixture_dir.mkdir(parents=True)
        shutil.copy2(Path(__file__).resolve().parent / "fixtures" / "legacy-config.toml", fixture_dir / "legacy-config.toml")
        (self.checkout / ".gitignore").write_text("packages/opencode/dist/\n", encoding="utf-8")
        subprocess.run(["git", "init", "--quiet"], cwd=self.checkout, check=True)
        subprocess.run(["git", "config", "user.name", "P9 test"], cwd=self.checkout, check=True)
        subprocess.run(["git", "config", "user.email", "p9-test@example.invalid"], cwd=self.checkout, check=True)
        subprocess.run(
            ["git", "add", ".gitignore", "install", "packages/opencode/package.json", "scripts/release/fixtures"],
            cwd=self.checkout,
            check=True,
        )
        subprocess.run(["git", "commit", "--quiet", "-m", "synthetic source checkout"], cwd=self.checkout, check=True)
        self.old_binary = artifact_dir / "previous-opencode"
        self.new_binary = artifact_dir / "candidate-opencode"
        self._write_test_binary(self.old_binary, "1.0.0")
        self._write_test_binary(self.new_binary, "2.0.0")
        self._write_candidate_manifest("2.0.0")
        self.fixture = fixture_dir / "legacy-config.toml"

    def tearDown(self) -> None:
        self.network_probe.close()
        self.temp.cleanup()

    def _write_test_binary(self, path: Path, version: str) -> None:
        path.write_text(
            textwrap.dedent(
                f"""\
                #!{sys.executable}
                import json
                import os
                from pathlib import Path
                import signal
                import socket
                import sys
                import time
                import tomllib

                version = {version!r}
                network_probe_port = {self.network_probe_port!r}
                host_only_sentinel = {str(self.host_only_sentinel)!r}
                checkout_write_blocked = False
                try:
                    Path("/workspace/.p9-checkout-write-probe").write_text("unexpected", encoding="utf-8")
                except OSError:
                    checkout_write_blocked = True
                host_temp_hidden = not Path(host_only_sentinel).exists()
                Path(os.environ["HOME"], ".release-test-env").write_text(
                    json.dumps({{
                        "inherited_secret": "OPENAI_API_KEY" in os.environ,
                        "checkout_write_blocked": checkout_write_blocked,
                        "host_temp_hidden": host_temp_hidden,
                    }}), encoding="utf-8"
                )
                if sys.argv[1:] == ["--version"]:
                    network = "blocked"
                    try:
                        with socket.create_connection(("127.0.0.1", network_probe_port), timeout=0.25):
                            network = "reachable"
                    except OSError:
                        pass
                    print(version)
                    print("network-" + network, file=sys.stderr)
                    raise SystemExit(0)
                if sys.argv[1:] == ["--help"]:
                    print("usage: horizoncode [command]")
                    raise SystemExit(0)
                if len(sys.argv) == 3 and sys.argv[1] == "--mini":
                    if not sys.stdin.isatty():
                        print("interactive launch requires a TTY", file=sys.stderr)
                        raise SystemExit(65)
                    def stop(_signum, _frame):
                        raise SystemExit(0)
                    signal.signal(signal.SIGINT, stop)
                    print("SYNTHETIC_TUI_READY", flush=True)
                    while True:
                        time.sleep(0.1)
                if sys.argv[1:] == ["debug", "config"]:
                    config_dir = Path(os.environ["XDG_CONFIG_HOME"]) / "opencode"
                    legacy = config_dir / "config"
                    current = config_dir / "config.json"
                    config = {{}}
                    if current.is_file():
                        config.update(json.loads(current.read_text(encoding="utf-8")))
                    if legacy.exists():
                        old = tomllib.loads(legacy.read_text(encoding="utf-8"))
                        provider = old.pop("provider", None)
                        model = old.pop("model", None)
                        if provider and model:
                            config["model"] = f"{{provider}}/{{model}}"
                        config.update(old)
                        config["$schema"] = "https://opencode.ai/config.json"
                        (config_dir / "config.json").write_text(json.dumps(config), encoding="utf-8")
                        legacy.unlink()
                    print(json.dumps(config))
                    raise SystemExit(0)
                raise SystemExit(64)
                """
            ),
            encoding="utf-8",
        )
        path.chmod(0o755)

    def _write_candidate_manifest(self, expected_version: str) -> None:
        checkout_facts = clean_install._checkout_facts(self.checkout)
        manifest = {
            "schemaVersion": 2,
            "sourceRevision": checkout_facts["revision"],
            "sourceStateSha256": checkout_facts["source_state_sha256"],
            "binaryPath": self.new_binary.name,
            "binarySha256": hashlib.sha256(self.new_binary.read_bytes()).hexdigest(),
            "binarySizeBytes": self.new_binary.stat().st_size,
            "configAndSchema": {"applicationPackageVersion": "1.18.35"},
            "runtimeVersion": expected_version,
        }
        (self.new_binary.parent / "release-manifest.json").write_text(
            json.dumps(manifest), encoding="utf-8"
        )

    def test_candidate_manifest_must_bind_checkout_revision_and_source_state(self) -> None:
        manifest_path = self.new_binary.parent / "release-manifest.json"
        invalid_values = {
            "sourceRevision mismatch": ("sourceRevision", "0" * 40),
            "sourceRevision missing": ("sourceRevision", None),
            "sourceStateSha256 mismatch": ("sourceStateSha256", "f" * 64),
            "sourceStateSha256 missing": ("sourceStateSha256", None),
        }
        for case, (field, invalid_value) in invalid_values.items():
            with self.subTest(case=case):
                self._write_candidate_manifest("2.0.0")
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                if invalid_value is None:
                    manifest.pop(field)
                else:
                    manifest[field] = invalid_value
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                state_root = self.root / ("bad-provenance-" + case.replace(" ", "-"))

                with self.assertRaisesRegex(ValueError, "candidate release manifest does not bind the checked-out source revision and source state"):
                    run_matrix(
                        checkout=self.checkout,
                        candidate_binary=self.new_binary,
                        previous_binary=None,
                        migration_fixture=None,
                        expected_model=None,
                        state_root=state_root,
                        require_clean_checkout=False,
                    )
                self.assertFalse(state_root.exists())

    def test_installed_candidate_version_must_match_candidate_provenance(self) -> None:
        self._write_test_binary(self.new_binary, "999.0.0")
        self._write_candidate_manifest("2.0.0")
        report = run_matrix(
            checkout=self.checkout,
            candidate_binary=self.new_binary,
            previous_binary=self.old_binary,
            migration_fixture=None,
            expected_model=None,
            state_root=self.root / "mismatched-version-state",
            require_clean_checkout=False,
        )

        self.assertEqual(report["scenarios"]["clean_install"]["status"], "FAIL")
        self.assertEqual(report["scenarios"]["clean_install"]["version"]["expected_version"], "2.0.0")
        self.assertFalse(
            report["scenarios"]["clean_install"]["version"]["matches_expected_version"]
        )
        self.assertEqual(report["scenarios"]["upgrade"]["status"], "FAIL")
        self.assertFalse(report["scenarios"]["upgrade"]["candidate_version_matches_expected"])
        self.assertEqual(report["status"], "FAIL")

    def test_upgrade_migration_and_binary_rollback_are_confined_to_temp_home(self) -> None:
        state_root = self.root / "state"

        with patch.dict(os.environ, {"OPENAI_API_KEY": "must-not-cross-the-test-boundary"}):
            report = run_matrix(
                checkout=self.checkout,
                candidate_binary=self.new_binary,
                previous_binary=self.old_binary,
                migration_fixture=self.fixture,
                expected_model="openai/release-test-model",
                state_root=state_root,
                require_clean_checkout=False,
            )

        self.assertEqual(report["status"], "PASS", json.dumps(report, indent=2))
        self.assertEqual(report["scenarios"]["clean_install"]["status"], "PASS")
        self.network_probe.setblocking(False)
        try:
            connection, _ = self.network_probe.accept()
        except BlockingIOError:
            pass
        else:
            connection.close()
            self.fail("sandboxed release binary reached the host loopback listener")
        self.assertEqual(report["scenarios"]["tui_launch"]["status"], "PASS")
        self.assertTrue(report["scenarios"]["tui_launch"]["tty_detected"])
        self.assertGreater(report["scenarios"]["tui_launch"]["startup_output_bytes"], 0)
        self.assertEqual(report["network_isolation"]["status"], "ENABLED")
        self.assertEqual(
            report["scenarios"]["clean_install"]["version"]["reported_version"],
            "2.0.0",
        )
        self.assertEqual(report["scenarios"]["upgrade"]["status"], "PASS")
        self.assertEqual(report["scenarios"]["migration"]["status"], "PASS")
        self.assertEqual(report["scenarios"]["rollback"]["status"], "PASS")
        self.assertTrue((state_root / "clean" / "home" / ".opencode" / "bin" / "horizoncode").is_file())
        self.assertFalse((state_root / "clean" / "home" / ".bashrc").exists())
        self.assertEqual(report["isolation"]["config_root"], str(state_root / "upgrade" / "home" / ".config"))
        self.assertTrue((state_root / "upgrade" / "home" / ".config" / "opencode" / "config.json").is_file())
        self.assertFalse((state_root / "upgrade" / "home" / ".config" / "opencode" / "config").exists())
        expected_sandbox_facts = {
            "inherited_secret": False,
            "checkout_write_blocked": True,
            "host_temp_hidden": True,
        }
        self.assertEqual(
            json.loads((state_root / "clean" / "home" / ".release-test-env").read_text()),
            expected_sandbox_facts,
        )
        self.assertEqual(
            json.loads((state_root / "upgrade" / "home" / ".release-test-env").read_text()),
            expected_sandbox_facts,
        )
        self.assertFalse((self.checkout / ".p9-checkout-write-probe").exists())
        self.assertEqual(report["network_isolation"]["status"], "ENABLED")
        self.assertFalse(report["isolation"]["host_home_mounted"])
        self.assertFalse(report["isolation"]["host_tmp_mounted"])

    def test_matrix_rejects_a_symlinked_legacy_fixture_before_creating_state(self) -> None:
        fixture_link = self.root / "legacy-config-link.toml"
        fixture_link.symlink_to(self.fixture)
        state_root = self.root / "fixture-link-state"

        with self.assertRaisesRegex(ValueError, "migration fixture must be a regular file"):
            run_matrix(
                checkout=self.checkout,
                candidate_binary=self.new_binary,
                previous_binary=self.old_binary,
                migration_fixture=fixture_link,
                expected_model="openai/release-test-model",
                state_root=state_root,
                require_clean_checkout=False,
            )
        self.assertFalse(state_root.exists())

    def test_matrix_rejects_symlinked_or_external_candidate_before_creating_state(self) -> None:
        artifacts = self.checkout / "artifacts"
        artifacts.mkdir(exist_ok=True)
        candidate_link = artifacts / "candidate-link"
        candidate_link.symlink_to(self.new_binary)
        linked_state = self.root / "linked-candidate-state"

        with self.assertRaisesRegex(ValueError, "candidate binary must be a regular executable"):
            run_matrix(
                checkout=self.checkout,
                candidate_binary=candidate_link,
                previous_binary=None,
                migration_fixture=None,
                expected_model=None,
                state_root=linked_state,
                require_clean_checkout=False,
            )
        self.assertFalse(linked_state.exists())

        external_candidate = self.root / "external-candidate"
        shutil.copy2(self.new_binary, external_candidate)
        external_state = self.root / "external-candidate-state"
        with self.assertRaisesRegex(ValueError, "candidate binary must be inside the separate checkout"):
            run_matrix(
                checkout=self.checkout,
                candidate_binary=external_candidate,
                previous_binary=None,
                migration_fixture=None,
                expected_model=None,
                state_root=external_state,
                require_clean_checkout=False,
            )
        self.assertFalse(external_state.exists())

    def test_matrix_rejects_symlinked_state_parent_before_writing_through_it(self) -> None:
        state_link = self.root / "state-parent-link"
        state_link.symlink_to(self.checkout, target_is_directory=True)
        state_root = state_link / "new-state"

        with self.assertRaisesRegex(ValueError, "test state path contains a symlink"):
            run_matrix(
                checkout=self.checkout,
                candidate_binary=self.new_binary,
                previous_binary=None,
                migration_fixture=None,
                expected_model=None,
                state_root=state_root,
                require_clean_checkout=False,
            )
        self.assertFalse((self.checkout / "new-state").exists())

    def test_matrix_fails_closed_when_network_namespace_is_unavailable(self) -> None:
        state_root = self.root / "blocked-state"
        with patch("scripts.release.clean_install.shutil.which", return_value=None):
            with self.assertRaisesRegex(ValueError, "bubblewrap.*network isolation"):
                run_matrix(
                    checkout=self.checkout,
                    candidate_binary=self.new_binary,
                    previous_binary=None,
                    migration_fixture=None,
                    expected_model=None,
                    state_root=state_root,
                    require_clean_checkout=False,
                )
        self.assertFalse(state_root.exists())

    def test_matrix_dry_run_validates_inputs_without_creating_state_or_installing(self) -> None:
        state_root = self.root / "dry-run-state"
        report = run_matrix(
            checkout=self.checkout,
            candidate_binary=self.new_binary,
            previous_binary=self.old_binary,
            migration_fixture=self.fixture,
            expected_model="openai/release-test-model",
            state_root=state_root,
            require_clean_checkout=False,
            dry_run=True,
        )

        self.assertEqual(report["status"], "DRY_RUN")
        self.assertTrue(report["dry_run"])
        self.assertEqual(report["network_isolation"]["status"], "ENABLED")
        self.assertIn("migration", report["planned_scenarios"])
        self.assertFalse(state_root.exists())

    def test_missing_previous_binary_is_explicitly_partial_not_release_pass(self) -> None:
        report = run_matrix(
            checkout=self.checkout,
            candidate_binary=self.new_binary,
            previous_binary=None,
            migration_fixture=None,
            expected_model=None,
            state_root=self.root / "partial-state",
            require_clean_checkout=False,
        )

        self.assertEqual(report["scenarios"]["clean_install"]["status"], "PASS")
        self.assertEqual(report["scenarios"]["upgrade"]["status"], "NOT_RUN")
        self.assertEqual(report["scenarios"]["migration"]["status"], "NOT_RUN")
        self.assertEqual(report["scenarios"]["rollback"]["status"], "NOT_RUN")
        self.assertEqual(report["status"], "PARTIAL")

    def test_upgrade_smoke_runs_without_a_migration_fixture_and_stays_partial(self) -> None:
        report = run_matrix(
            checkout=self.checkout,
            candidate_binary=self.new_binary,
            previous_binary=self.old_binary,
            migration_fixture=None,
            expected_model=None,
            state_root=self.root / "upgrade-only-state",
            require_clean_checkout=False,
        )

        self.assertEqual(report["scenarios"]["clean_install"]["status"], "PASS")
        upgrade = report["scenarios"]["upgrade"]
        self.assertEqual(upgrade["status"], "PASS")
        self.assertEqual(upgrade["previous_version"], "1.0.0")
        self.assertEqual(upgrade["candidate_version"], "2.0.0")
        self.assertTrue(upgrade["previous_binary_was_replaced"])
        self.assertEqual(report["scenarios"]["migration"]["status"], "NOT_RUN")
        self.assertIn("migration fixture", report["scenarios"]["migration"]["reason"])
        self.assertEqual(report["scenarios"]["rollback"]["status"], "NOT_RUN")
        self.assertIn("migration fixture", report["scenarios"]["rollback"]["reason"])
        self.assertEqual(report["status"], "PARTIAL")
        self.assertEqual(report["isolation"]["config_root"], str(self.root / "upgrade-only-state" / "upgrade" / "home" / ".config"))

    def test_state_root_outside_approved_temp_parent_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            run_matrix(
                checkout=self.checkout,
                candidate_binary=self.new_binary,
                previous_binary=None,
                migration_fixture=None,
                expected_model=None,
                state_root=Path(__file__).resolve().parents[2] / "release-state-outside-artifact-root",
                require_clean_checkout=False,
            )

    def test_release_matrix_rejects_dirty_checkout_by_default(self) -> None:
        source_manifest = self.checkout / "packages" / "opencode" / "package.json"
        source_manifest.write_text(source_manifest.read_text(encoding="utf-8") + "\\n", encoding="utf-8")
        state_root = self.root / "must-not-be-created"
        with self.assertRaisesRegex(ValueError, "clean Git checkout"):
            run_matrix(
                checkout=self.checkout,
                candidate_binary=self.new_binary,
                previous_binary=None,
                migration_fixture=None,
                expected_model=None,
                state_root=state_root,
            )
        self.assertFalse(state_root.exists())

    def test_combined_gate_keeps_synthetic_install_pass_separate_from_release_clearance(self) -> None:

        report = evaluate_release_gate(
            self.checkout,
            checkout=self.checkout,
            candidate_binary=self.new_binary,
            previous_binary=self.old_binary,
            migration_fixture=self.fixture,
            expected_model="openai/release-test-model",
            state_root=self.root / "gate-state",
        )

        self.assertEqual(report["install_matrix"]["status"], "PASS", json.dumps(report["install_matrix"], indent=2))
        self.assertEqual(report["install_evidence_class"], "provided-binary exercise; synthetic harness tests are not product evidence")
        self.assertEqual(report["status"], "BLOCKED")
        self.assertEqual(report["distribution_license_decision"], "NOT_AUTHORIZED")
        self.assertEqual(report["signing_update_policy"], "DEFERRED_UNAVAILABLE")
        host_lane = {"Linux": "native_linux", "WSL": "wsl", "WSL2": "wsl2"}[
            report["install_matrix"]["platform"]["host_kind"]
        ]
        self.assertEqual(
            report["platform_support_matrix"]["lanes"][host_lane]["install_matrix_status"],
            "PASS",
        )

    def test_combined_gate_refuses_to_install_when_checkout_revision_differs_from_audit_source(self) -> None:
        audit_root = self.root / "audit-source"
        audit_root.mkdir()
        (audit_root / "package.json").write_text(
            json.dumps({"name": "horizoncode", "private": True, "license": "UNLICENSED"}),
            encoding="utf-8",
        )
        (audit_root / "opencode").mkdir()
        (audit_root / "opencode" / "LICENSE").write_text("upstream vendor license\n", encoding="utf-8")
        (audit_root / "packages" / "opencode").mkdir(parents=True)
        (audit_root / "packages" / "opencode" / "package.json").write_text(
            json.dumps({"name": "opencode", "private": True, "license": "MIT"}), encoding="utf-8"
        )
        subprocess.run(["git", "init", "--quiet"], cwd=audit_root, check=True)
        subprocess.run(["git", "config", "user.name", "P9 test"], cwd=audit_root, check=True)
        subprocess.run(["git", "config", "user.email", "p9-test@example.invalid"], cwd=audit_root, check=True)
        subprocess.run(["git", "add", "package.json", "opencode", "packages"], cwd=audit_root, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "audited source"], cwd=audit_root, check=True)

        state_root = self.root / "must-not-install"

        report = evaluate_release_gate(
            audit_root,
            checkout=self.checkout,
            candidate_binary=self.new_binary,
            state_root=state_root,
        )

        self.assertEqual(report["install_matrix"]["status"], "BLOCKED")
        self.assertIn("does not match audited source revision", report["install_matrix"]["reason"])
        self.assertFalse(state_root.exists())


class SyntheticTuiShutdownWindowTests(unittest.TestCase):
    """Pins the bounded PTY shutdown contract of the TUI smoke.

    A process that shuts down cleanly but slowly on SIGINT (the observed flake
    band under CPU oversubscription) must pass inside the bounded window, and a
    process that ignores SIGINT must still be failed, escalated and reported.

    Synthetic harness tests; these do not establish product install evidence.
    """

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="p9-tui-", dir=SANDBOX_PARENT)
        self.root = Path(self.temp.name)
        self.checkout = self.root / "checkout"
        self.checkout.mkdir()
        state_root = clean_install._validated_state_root(self.root / "state")
        state_root.mkdir(mode=0o700)
        self.state_root = state_root
        self.home = state_root / "home"
        self.env = clean_install._safe_environment(self.home, state_root)

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _write_tui_binary(
        self,
        *,
        shutdown_delay: float = 0.0,
        startup_delay: float = 0.0,
        ignore_sigint: bool = False,
        raw: bool = False,
        spawn_marker: str | None = None,
    ) -> None:
        binary_dir = self.home / ".opencode" / "bin"
        binary_dir.mkdir(parents=True)
        binary = binary_dir / "horizoncode"
        if ignore_sigint:
            handler = "signal.signal(signal.SIGINT, signal.SIG_IGN)"
        elif raw:
            handler = "# default disposition: SIGINT terminates this process"
        else:
            handler = textwrap.dedent(
                f"""\
                def stop(_signum, _frame):
                    time.sleep({shutdown_delay!r})
                    raise SystemExit(0)

                signal.signal(signal.SIGINT, stop)"""
            )
        spawn = ""
        if spawn_marker is not None:
            spawn = (
                "import subprocess\n"
                "import sys\n\n"
                "import os\n"
                "from pathlib import Path\n\n"
                f"child = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(3600)', {spawn_marker!r}])\n"
                "Path(os.environ['XDG_STATE_HOME'], 'p9-leftover-child.pid').write_text(str(child.pid), encoding='utf-8')\n"
            )
        binary.write_text(
            "#!" + sys.executable + "\n"
            "import signal\n"
            "import time\n"
            "\n"
            f"{spawn}"
            f"{handler}\n"
            f"time.sleep({startup_delay!r})\n"
            "print('SYNTHETIC_TUI_READY', flush=True)\n"
            "while True:\n"
            "    time.sleep(0.1)\n",
            encoding="utf-8",
        )
        binary.chmod(0o755)

    def test_tui_smoke_tolerates_a_slow_but_clean_sigint_exit_inside_the_window(self) -> None:
        # 3.5s of deliberate shutdown delay exceeds the former 3.0s window that
        # flaked under load; the harness must tolerate it and still require a
        # clean exit inside its bounded window. The delay also proves the
        # observed exit is the sandboxed app's own shutdown and not bubblewrap
        # dying on the signal.
        self._write_tui_binary(shutdown_delay=3.5)

        report = clean_install._tui_smoke(
            self.home, self.env, source_checkout=self.checkout, state_root=self.state_root
        )

        self.assertEqual(report["status"], "PASS", report)
        self.assertTrue(report["passed"])
        self.assertTrue(report["startup_completed"])
        self.assertEqual(report["exit_code"], 0)
        self.assertFalse(report["timed_out"])
        self.assertIsNone(report["reason"])
        self.assertEqual(report["shutdown_signal_target"], "sandboxed-process")
        self.assertEqual(report["shutdown_window_seconds"], clean_install.TUI_SHUTDOWN_SECONDS)
        self.assertGreaterEqual(report["shutdown_window_seconds"], 8.0)
        self.assertEqual(report["leftover_processes"], [])

    def test_tui_smoke_waits_for_a_slow_first_frame_inside_the_bound(self) -> None:
        # A cold CLI can take longer than the former 1.0s window to paint its
        # first frame. Startup must wait for output, not fail a slow-but-live UI.
        self._write_tui_binary(startup_delay=2.0)

        report = clean_install._tui_smoke(
            self.home, self.env, source_checkout=self.checkout, state_root=self.state_root
        )

        self.assertEqual(report["status"], "PASS", report)
        self.assertGreater(report["startup_output_bytes"], 0)
        self.assertGreaterEqual(report["startup_window_seconds"], 10.0)

    def test_tui_smoke_fails_and_escalates_when_the_process_ignores_sigint(self) -> None:
        self._write_tui_binary(ignore_sigint=True)

        with patch("scripts.release.clean_install.TUI_SHUTDOWN_SECONDS", 1.0):
            report = clean_install._tui_smoke(
                self.home, self.env, source_checkout=self.checkout, state_root=self.state_root
            )

        self.assertEqual(report["status"], "FAIL")
        self.assertFalse(report["passed"])
        self.assertTrue(report["timed_out"])
        self.assertEqual(report["exit_code"], -9)
        self.assertEqual(report["shutdown_signal"], "SIGINT")
        self.assertEqual(report["shutdown_signal_target"], "sandboxed-process")
        self.assertEqual(report["shutdown_window_seconds"], 1.0)
        self.assertEqual(report["leftover_processes"], [])
        self.assertEqual(
            report["reason"],
            "interactive process did not shut down cleanly within the bounded signal window",
        )

    def test_tui_smoke_reports_the_default_sigint_termination_of_the_app(self) -> None:
        self._write_tui_binary(raw=True)

        report = clean_install._tui_smoke(
            self.home, self.env, source_checkout=self.checkout, state_root=self.state_root
        )

        self.assertEqual(report["status"], "PASS", report)
        self.assertFalse(report["timed_out"])
        self.assertEqual(report["exit_code"], 130)

    def test_tui_smoke_fails_when_the_app_leaves_a_background_descendant(self) -> None:
        self._write_tui_binary(spawn_marker="P9-LEFTOVER")

        report = clean_install._tui_smoke(
            self.home, self.env, source_checkout=self.checkout, state_root=self.state_root
        )

        self.assertEqual(report["status"], "FAIL")
        self.assertFalse(report["passed"])
        self.assertGreaterEqual(len(report["leftover_processes"]), 1)
        self.assertEqual(
            report["reason"],
            "interactive process left background descendants running after the shutdown signal",
        )
        pid_path = self.env["XDG_STATE_HOME"]
        child_pid_file = Path(pid_path) / "p9-leftover-child.pid"
        child_pid = int(child_pid_file.read_text(encoding="utf-8"))
        deadline = time.monotonic() + 3.0
        while time.monotonic() < deadline and _process_id_running(child_pid):
            time.sleep(0.1)
        self.assertFalse(_process_id_running(child_pid))


class IsolatedBuildPreparationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="p9-build-", dir=SANDBOX_PARENT)
        self.root = Path(self.temp.name)
        self.source = self.root / "source"
        self.source.mkdir()
        (self.source / "bun.lock").write_text("{}\n", encoding="utf-8")
        (self.source / "kernel").mkdir()
        (self.source / "kernel" / "Cargo.lock").write_text("version = 4\n", encoding="utf-8")
        migration = self.source / "packages" / "core" / "src" / "database" / "migration" / "20260101000000_fixture.ts"
        migration.parent.mkdir(parents=True)
        migration.write_text("export {}\n", encoding="utf-8")
        contract = self.source / "arch_V1" / "contracts-v2" / "fixture.schema.json"
        contract.parent.mkdir(parents=True)
        contract.write_text('{"$schema":"fixture"}\n', encoding="utf-8")
        (self.source / ".gitignore").write_text(
            "node_modules/\n**/dist/\npackages/plugin/\npackages/opencode/test/\n", encoding="utf-8"
        )
        (self.source / "package.json").write_text('{"name":"horizoncode-workspace"}\n', encoding="utf-8")
        bootstrap_script = self.source / "scripts" / "architecture" / "bootstrap_source.py"
        bootstrap_script.parent.mkdir(parents=True)
        shutil.copy2(
            Path(__file__).resolve().parents[2] / "scripts" / "architecture" / "bootstrap_source.py",
            bootstrap_script,
        )
        build_script = self.source / "packages" / "opencode" / "script" / "build.ts"
        build_script.parent.mkdir(parents=True)
        build_script.write_text(
            'import { createHash } from "node:crypto"\n'
            'const dir = path.resolve(__dirname, "..")\n'
            'const clearBuildOutput = async (relative: string) => {\n'
            '  const p9BuildRoot = process.env.HORIZONCODE_P9_BUILD_ROOT\n'
            '  const p9BuildMarker = process.env.HORIZONCODE_P9_BUILD_MARKER\n'
            '  await $`rm -rf ${target}`\n'
            '}\n'
            'await clearBuildOutput("dist")\n'
            'await clearBuildOutput(`dist/${name}/bin/tui`)\n',
            encoding="utf-8",
        )
        fixture = self.source / "opencode" / "packages" / "opencode" / "test" / "tool" / "fixtures" / "models-api.json"
        fixture.parent.mkdir(parents=True)
        fixture.write_text('{"fixture":true}\n', encoding="utf-8")
        plugin_manifest = self.source / "opencode" / "packages" / "plugin" / "package.json"
        plugin_manifest.parent.mkdir(parents=True)
        plugin_manifest.write_text('{"name":"@opencode-ai/plugin","version":"1.0.0"}\n', encoding="utf-8")
        (self.source / "packages" / "opencode" / "dist").mkdir()
        (self.source / "packages" / "opencode" / "dist" / "existing.bin").write_bytes(b"preserve")
        (self.source / "packages" / "opencode" / "node_modules").mkdir()
        (self.source / "packages" / "opencode" / "node_modules" / "ignored.bin").write_bytes(b"outside build source")
        self._git("init", "--quiet")
        self._git("config", "user.name", "P9 test")
        self._git("config", "user.email", "p9-test@example.invalid")
        self._git(
            "add",
            ".gitignore",
            "package.json",
            "bun.lock",
            "kernel/Cargo.lock",
            "packages/core/src/database/migration/20260101000000_fixture.ts",
            "arch_V1/contracts-v2/fixture.schema.json",
            "packages/opencode/script/build.ts",
            "opencode",
            "scripts/architecture/bootstrap_source.py",
        )
        self._git("commit", "--quiet", "-m", "fixture")
        (self.source / "packages" / "opencode" / "script" / "dirty.ts").write_text("export const dirty = true\n")
        self.destination = self.root / "isolated-build"

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _git(self, *args: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", *args], cwd=self.source, check=True, capture_output=True, text=True)

    def _prepare(self) -> dict:
        result = subprocess.run(
            [
                sys.executable,
                "scripts/release/prepare_build.py",
                "--source",
                str(self.source),
                "--destination",
                str(self.destination),
            ],
            cwd=Path(__file__).resolve().parents[2],
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
            capture_output=True,
            text=True,
            timeout=30,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return json.loads(result.stdout)

    def test_isolated_build_copy_preserves_source_dist_and_marks_dirty_evidence_nonqualified(self) -> None:
        report = self._prepare()

        self.assertEqual(report["qualification_status"], "NON_RELEASE_QUALIFIED")
        self.assertEqual(report["source"]["status"], "DIRTY")
        self.assertEqual(report["source"]["source_state_sha256"], report["build_copy"]["source_state_sha256"])
        self.assertEqual((self.source / "packages/opencode/dist/existing.bin").read_bytes(), b"preserve")
        self.assertFalse((self.destination / "packages/opencode/dist").exists())
        self.assertFalse((self.destination / "packages/opencode/node_modules").exists())
        self.assertTrue((self.destination / "packages/opencode/script/dirty.ts").is_file())
        copied_build = (self.destination / "packages/opencode/script/build.ts").read_text(encoding="utf-8")
        self.assertNotIn("rm -rf dist", copied_build)
        self.assertIn("HORIZONCODE_P9_BUILD_ROOT", copied_build)
        self.assertEqual(
            report["build_copy"]["models_dev_api_json"],
            str(self.destination / "opencode/packages/opencode/test/tool/fixtures/models-api.json"),
        )
        self.assertEqual(
            (self.destination / "opencode/packages/opencode/test/tool/fixtures/models-api.json").read_text(),
            '{"fixture":true}\n',
        )

    def test_isolated_build_dry_run_validates_without_creating_the_destination(self) -> None:
        tool_names = {"bun", "cargo", "rustup"}
        with patch(
            "scripts.release.prepare_build.shutil.which",
            side_effect=lambda name: str(self.root / "toolchain" / name) if name in tool_names else None,
        ):
            report = plan_isolated_build(self.source, self.destination)

        self.assertTrue(report["dry_run"])
        self.assertEqual(report["build"]["status"], "DRY_RUN")
        self.assertEqual(report["build_copy"]["status"], "NOT_CREATED")
        self.assertEqual(report["source"]["status"], "DIRTY")
        self.assertFalse(self.destination.exists())

    def test_isolated_build_dry_run_fails_closed_when_bun_is_missing(self) -> None:
        tool_names = {"cargo", "rustup"}
        with patch(
            "scripts.release.prepare_build.shutil.which",
            side_effect=lambda name: str(self.root / "toolchain" / name) if name in tool_names else None,
        ):
            with self.assertRaisesRegex(ValueError, "requires on PATH: bun"):
                plan_isolated_build(self.source, self.destination)

        self.assertFalse(self.destination.exists())

    def test_build_script_guard_rejects_a_final_symlink_without_touching_its_target(self) -> None:
        build_script = self.source / "packages" / "opencode" / "script" / "build.ts"
        sentinel = build_script.with_name("build-script-sentinel.ts")
        original = build_script.read_bytes()
        sentinel.write_bytes(original)
        build_script.unlink()
        build_script.symlink_to(sentinel.name)

        with self.assertRaisesRegex(ValueError, "regular, non-symlink file"):
            _guard_build_script(self.source)

        self.assertEqual(sentinel.read_bytes(), original)

    def test_build_candidate_rejects_marker_for_another_source_revision(self) -> None:
        report = self._prepare()
        marker = Path(report["build_copy"]["build_marker"])
        marker_data = json.loads(marker.read_text(encoding="utf-8"))
        marker_data["sourceRevision"] = "0" * 40
        marker.write_text(json.dumps(marker_data), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "does not bind this source revision"):
            build_candidate(report)

    def test_isolated_build_copy_hydrates_ignored_pinned_workspaces(self) -> None:
        report = self._prepare()

        plugin_manifest = self.destination / "packages/plugin/package.json"
        self.assertTrue(plugin_manifest.is_file())
        self.assertEqual(
            json.loads(plugin_manifest.read_text(encoding="utf-8")),
            {"name": "@opencode-ai/plugin", "version": "1.0.0"},
        )
        self.assertEqual(report["source"]["source_state_sha256"], report["build_copy"]["source_state_sha256"])

    def test_isolated_build_copy_rejects_external_symlinks_before_creating_destination(self) -> None:
        outside = self.root / "outside.txt"
        outside.write_text("do not copy", encoding="utf-8")
        link = self.source / "packages" / "opencode" / "script" / "external.ts"
        link.symlink_to(outside)

        result = subprocess.run(
            [
                sys.executable,
                "scripts/release/prepare_build.py",
                "--source",
                str(self.source),
                "--destination",
                str(self.destination),
            ],
            cwd=Path(__file__).resolve().parents[2],
            env=dict(os.environ, PYTHONDONTWRITEBYTECODE="1"),
            capture_output=True,
            text=True,
            timeout=30,
        )

        self.assertEqual(result.returncode, 3)
        self.assertIn("symlink target escapes source checkout", result.stderr)
        self.assertFalse(self.destination.exists())
        self.assertEqual(outside.read_text(encoding="utf-8"), "do not copy")

    def test_candidate_manifest_binds_binary_digest_and_reports_the_linux_target(self) -> None:
        app_package = self.source / "packages" / "opencode" / "package.json"
        app_package.write_text(
            json.dumps({"name": "opencode", "version": "1.18.35", "private": True}),
            encoding="utf-8",
        )
        report = self._prepare()
        build_root = Path(report["build_copy"]["path"])
        build_calls = []

        def fake_run(command, *, cwd, env, timeout):
            build_calls.append((command, cwd, env, timeout))
            if "script/build.ts" in command:
                binary = build_root / "packages" / "opencode" / "dist" / "horizoncode-linux-x64" / "bin" / "horizoncode"
                binary.parent.mkdir(parents=True)
                binary.write_bytes(b"candidate-linux-binary")
                binary.chmod(0o755)
                output_manifest = binary.parents[1] / "package.json"
                output_manifest.write_text(
                    json.dumps({"name": "horizoncode-linux-x64", "version": env["OPENCODE_VERSION"]}),
                    encoding="utf-8",
                )
            return subprocess.CompletedProcess(command, 0, stdout="build step completed\n", stderr="")

        with patch("scripts.release.prepare_build.shutil.which", side_effect=lambda name: f"/usr/bin/{name}"), patch(
            "scripts.release.prepare_build._run_checked", side_effect=fake_run
        ):
            result = build_candidate(report)

        artifact = Path(result["build"]["artifact_directory"])
        manifest = json.loads((artifact / "release-manifest.json").read_text(encoding="utf-8"))
        binary = artifact / "horizoncode"
        self.assertEqual(result["build"]["status"], "BUILT")
        self.assertEqual(manifest["schemaVersion"], 2)
        self.assertEqual(manifest["binarySha256"], hashlib.sha256(binary.read_bytes()).hexdigest())
        self.assertEqual(manifest["binarySizeBytes"], binary.stat().st_size)
        self.assertEqual(manifest["sourceRevision"], result["source"]["revision"])
        self.assertEqual(manifest["sourceStateSha256"], result["source"]["source_state_sha256"])
        self.assertEqual(manifest["postBuildSourceStateSha256"], manifest["sourceStateSha256"])
        self.assertEqual(manifest["target"], "horizoncode-linux-x64")
        self.assertEqual(manifest["runtimeVersion"], build_calls[2][2]["OPENCODE_VERSION"])
        self.assertEqual(manifest["lockfileSha256"].keys(), {"bun.lock", "kernel/Cargo.lock"})
        self.assertEqual(manifest["artifactFiles"], [{
            "path": "horizoncode",
            "sizeBytes": len(b"candidate-linux-binary"),
            "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
        }])
        artifact_inspection = inspect_artifact(artifact)
        self.assertTrue(artifact_inspection["artifact_inventory_valid"])
        self.assertEqual(artifact_inspection["artifact_inventory_errors"], [])
        self.assertTrue(manifest["configAndSchema"]["contractSetSha256"])
        self.assertEqual(manifest["packageTarget"]["classification"], "UPSTREAM_OPENCODE")
        self.assertEqual(build_calls[0][2]["RUSTUP_TOOLCHAIN"], "stable")
        self.assertEqual(build_calls[2][2]["MODELS_DEV_API_JSON"], result["build_copy"]["models_dev_api_json"])
        self.assertEqual(build_calls[0][2]["CARGO_HOME"], str(build_root.parent / f".{build_root.name}.cargo"))
        self.assertEqual(
            build_calls[0][2]["RUSTUP_HOME"],
            str(build_root.parent / f".{build_root.name}.rustup"),
        )
        self.assertTrue(Path(build_calls[0][2]["RUSTUP_HOME"]).is_dir())
        self.assertNotEqual(build_calls[0][2]["RUSTUP_HOME"], os.environ.get("RUSTUP_HOME"))
        self.assertEqual(result["qualification_status"], "NON_RELEASE_QUALIFIED")

    def test_artifact_inventory_rejects_legacy_manifest_schema(self) -> None:
        artifact = self.source / "legacy-artifact"
        artifact.mkdir()
        binary = artifact / "opencode"
        binary.write_bytes(b"candidate")
        manifest = {
            "schemaVersion": 1,
            "sourceStateSha256": "0" * 64,
            "postBuildSourceStateSha256": "0" * 64,
            "binaryPath": "opencode",
            "binarySizeBytes": len(b"candidate"),
            "artifactFiles": [{
                "path": "opencode",
                "sizeBytes": len(b"candidate"),
                "sha256": hashlib.sha256(binary.read_bytes()).hexdigest(),
            }],
        }
        (artifact / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")

        report = inspect_artifact(artifact)

        self.assertFalse(report["artifact_inventory_valid"])
        self.assertIn("candidate provenance manifest must use schemaVersion 2", report["artifact_inventory_errors"])

    def test_artifact_inventory_rejects_duplicate_manifest_keys(self) -> None:
        artifact = self.source / "duplicate-key-artifact"
        artifact.mkdir()
        binary = artifact / "horizoncode"
        binary.write_bytes(b"candidate")
        license_file = artifact / "LICENSE"
        license_file.write_bytes(b"license\n")
        notice_file = artifact / "NOTICE.txt"
        notice_file.write_bytes(b"notice\n")
        files = []
        for path in (binary, license_file, notice_file):
            contents = path.read_bytes()
            files.append({
                "path": path.name,
                "sizeBytes": len(contents),
                "sha256": hashlib.sha256(contents).hexdigest(),
            })
        valid_digest = "0" * 64
        manifest = (
            '{"schemaVersion":2,"sourceRevision":"0123456789abcdef",'
            '"sourceStateSha256":"not-a-digest",'
            f'"sourceStateSha256":"{valid_digest}",'
            f'"postBuildSourceStateSha256":"{valid_digest}",'
            '"binaryPath":"horizoncode",'
            f'"binarySizeBytes":{binary.stat().st_size},'
            f'"binarySha256":"{hashlib.sha256(binary.read_bytes()).hexdigest()}",'
            f'"artifactFiles":{json.dumps(files)}}}'
        )
        (artifact / "release-manifest.json").write_text(manifest, encoding="utf-8")

        report = inspect_artifact(artifact)

        self.assertFalse(report["artifact_inventory_valid"])

    def test_failed_build_command_surfaces_captured_diagnostics(self) -> None:
        try:
            _run_checked(
                [
                    sys.executable,
                    "-c",
                    "import os, sys; print(os.environ['P9_DIAGNOSTIC'], file=sys.stderr); sys.exit(7)",
                ],
                cwd=self.source,
                env={"P9_DIAGNOSTIC": "known isolated build failure"},
                timeout=10,
            )
        except (ValueError, subprocess.CalledProcessError) as error:
            self.assertIn("known isolated build failure", str(error))
        else:
            self.fail("a failing build command must not return successfully")


class QualificationWorkflowTests(unittest.TestCase):
    def test_release_qualification_workflow_is_read_only_for_model_catalog_and_never_publishes(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        workflow = repository_root / ".github" / "workflows" / "horizoncode-release-qualification.yml"
        self.assertTrue(workflow.is_file(), f"qualification workflow is missing: {workflow}")
        contents = workflow.read_text(encoding="utf-8")

        self.assertIn("workflow_dispatch:", contents)
        self.assertNotIn("pull_request:", contents)
        self.assertNotIn("push:", contents)
        self.assertIn("permissions:\n  contents: read", contents)
        self.assertIn("python3 scripts/release/prepare_build.py", contents)
        self.assertIn("python3 scripts/release/clean_install.py", contents)
        self.assertIn("python3 scripts/release/release_gate.py", contents)
        self.assertIn("bash -n install", contents)
        self.assertIn("python3 -m unittest scripts.release.test_release_readiness", contents)
        self.assertIn("--dry-run", contents)
        self.assertIn("MODELS_DEV_API_JSON", contents)
        self.assertIn("opencode/packages/opencode/test/tool/fixtures/models-api.json", contents)
        self.assertIn("kernel/target/horizoncode-release", contents)
        self.assertNotIn("/tmp/", contents)
        self.assertNotIn("$RUNNER_TEMP", contents)
        self.assertNotIn("npm publish", contents)
        self.assertNotIn("gh release upload", contents)
        self.assertNotIn("upload-artifact", contents)
        self.assertNotIn("codesign", contents)
        self.assertNotIn("secrets.", contents)
        self.assertNotIn("id-token: write", contents)

    def test_release_qualification_candidate_binary_matches_the_product_artifact_name(self) -> None:
        # `build.ts` now emits `dist/horizoncode-<target>/bin/horizoncode`. Every
        # `--candidate-binary` derived from the build report must resolve to that
        # artifact; pointing at the retired `opencode` name fails the job at the
        # install and gate steps with "no candidate product binary".
        repository_root = Path(__file__).resolve().parents[2]
        workflow = repository_root / ".github" / "workflows" / "horizoncode-release-qualification.yml"
        contents = workflow.read_text(encoding="utf-8")

        self.assertIn('--candidate-binary "$artifact_directory/horizoncode"', contents)
        self.assertNotIn('--candidate-binary "$artifact_directory/opencode"', contents)

    def test_root_publication_workflow_is_manual_read_only_and_has_no_runnable_job(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        workflow = repository_root / ".github" / "workflows" / "publish.yml"
        self.assertTrue(workflow.is_file(), f"publication workflow overlay is missing: {workflow}")
        report = audit_repository(repository_root)

        self.assertTrue(report["package_target"].get("publish_workflow_fail_closed"))


class IdentityAndCleanMachinePlanTests(unittest.TestCase):
    """Items 50/51: the stage-2 identity map and clean-machine plan stay in sync."""

    @staticmethod
    def _workspace_manifests(root: Path) -> dict[str, Path]:
        manifests = sorted(root.glob("packages/*/package.json")) + sorted(
            root.glob("packages/*/*/package.json")
        )
        return {
            json.loads(path.read_text(encoding="utf-8"))["name"]: path for path in manifests
        }

    @staticmethod
    def _importer_facts(root: Path, package_ids: set[str], own_manifests: dict[str, Path]) -> dict[str, bool]:
        """Single pass mirroring IDENTITY-MAPPING.json facts.importer_scan_scope."""
        flags = {package_id: False for package_id in package_ids}
        extensions = {".ts", ".tsx", ".json", ".md"}
        skipped = {"node_modules", ".git", "dist", "target", ".turbo", ".bun"}
        for path in (root / "packages").rglob("*"):
            if not path.is_file() or path.suffix not in extensions:
                continue
            if any(part in skipped for part in path.parts):
                continue
            try:
                text = path.read_text(encoding="utf-8", errors="ignore")
            except OSError:
                continue
            for package_id in package_ids:
                if flags[package_id] or path == own_manifests.get(package_id):
                    continue
                if package_id + "/" in text:
                    flags[package_id] = True
        return flags

    def test_identity_mapping_plan_matches_the_workspace_manifests(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        plan = json.loads(
            (repository_root / "scripts" / "release" / "IDENTITY-MAPPING.json").read_text(encoding="utf-8")
        )
        manifests = self._workspace_manifests(repository_root)
        packages = plan["packages"]

        migrate = {name for name, row in packages.items() if row["disposition"] == "MIGRATE"}
        done = {name for name, row in packages.items() if row["disposition"] == "DONE"}
        expected_migrate = {
            name for name in manifests if name.startswith("@opencode-ai/") or name == "opencode"
        }
        expected_done = {name for name in manifests if name.startswith("@horizoncode/")}

        self.assertEqual(set(packages), set(manifests))
        self.assertEqual(migrate, expected_migrate)
        self.assertEqual(done, expected_done)

        hold_vendor = plan["hold_vendor"]
        self.assertIn("@opencode-ai/client", hold_vendor)
        self.assertEqual(set(hold_vendor) & set(manifests), set())

        facts = self._importer_facts(repository_root, set(manifests), manifests)
        for name, row in packages.items():
            with self.subTest(package=name):
                self.assertEqual(
                    row["own_manifest"], manifests[name].relative_to(repository_root).as_posix()
                )
                impact = row["impact"]
                for key in ("lockfile_edges", "has_source_importers", "generated_identifiers", "runtime_identifiers"):
                    self.assertIn(key, impact)
                if row["disposition"] == "MIGRATE":
                    expected_target = (
                        "horizoncode" if name == "opencode" else name.replace("@opencode-ai/", "@horizoncode/")
                    )
                    self.assertEqual(row["target"], expected_target)
                    self.assertTrue(impact["lockfile_edges"])
                    self.assertEqual(impact["has_source_importers"], facts[name])

        self.assertIn("opencode/** pinned snapshot", plan["preserve"])

    def test_private_unreferenced_leaf_identity_layer_has_matching_lock_resolution(self) -> None:
        from scripts.release import identity_migration

        repository_root = Path(__file__).resolve().parents[2]
        expected = {
            "@opencode-ai/console-function": (
                "@horizoncode/console-function",
                "packages/console/function",
            ),
            "@opencode-ai/stats-app": ("@horizoncode/stats-app", "packages/stats/app"),
            "@opencode-ai/stats-server": ("@horizoncode/stats-server", "packages/stats/server"),
        }
        plan = json.loads(
            (repository_root / "scripts" / "release" / "IDENTITY-MAPPING.json").read_text(
                encoding="utf-8"
            )
        )
        lock = _load_bun_lock(repository_root / "bun.lock")

        for old_name, (new_name, workspace_path) in expected.items():
            with self.subTest(package=new_name):
                manifest_path = repository_root / workspace_path / "package.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
                self.assertEqual(manifest.get("name"), new_name)
                self.assertTrue(manifest.get("private"))
                self.assertNotIn(old_name, plan["packages"])
                self.assertEqual(plan["packages"][new_name]["disposition"], "DONE")
                self.assertEqual(
                    plan["packages"][new_name]["own_manifest"],
                    manifest_path.relative_to(repository_root).as_posix(),
                )
                self.assertEqual(lock["workspaces"][workspace_path]["name"], new_name)
                self.assertEqual(
                    lock["packages"].get(new_name),
                    [f"{new_name}@workspace:{workspace_path}"],
                )
                self.assertNotIn(old_name, lock["packages"])
                for importer_path, importer in lock["workspaces"].items():
                    for section in (
                        "dependencies",
                        "devDependencies",
                        "peerDependencies",
                        "optionalDependencies",
                    ):
                        self.assertNotIn(
                            old_name,
                            importer.get(section, {}),
                            f"unexpected workspace caller {importer_path}:{section}",
                        )

                callers = []
                for path in identity_migration._iter_scan_files(repository_root):
                    relative = path.relative_to(repository_root).as_posix()
                    if relative in {identity_migration.PLAN_FILE, manifest_path.relative_to(repository_root).as_posix()}:
                        continue
                    if old_name in path.read_text(encoding="utf-8", errors="ignore"):
                        callers.append(relative)
                self.assertEqual([], callers, f"unmapped first-party callers remain: {callers}")

    def test_identity_mapping_runtime_impacts_are_still_real(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        plan = json.loads(
            (repository_root / "scripts" / "release" / "IDENTITY-MAPPING.json").read_text(encoding="utf-8")
        )
        sqlite_text = (
            repository_root / "packages" / "effect-sqlite-node" / "src" / "index.ts"
        ).read_text(encoding="utf-8")
        for identifier in plan["packages"]["@opencode-ai/effect-sqlite-node"]["impact"]["runtime_identifiers"]:
            self.assertIn(identifier.split(" (")[0], sqlite_text)

        generated = (
            repository_root / "packages" / "client" / "src" / "generated-effect" / "client.ts"
        ).read_text(encoding="utf-8")
        self.assertIn("Generated by @opencode-ai/httpapi-codegen", generated)

    def test_clean_machine_plan_covers_required_scenarios_and_stays_not_run(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        plan = json.loads(
            (repository_root / "scripts" / "release" / "CLEAN-MACHINE-PLAN.json").read_text(encoding="utf-8")
        )

        self.assertEqual(plan["status"], "NOT_RUN")
        self.assertEqual(set(plan["scenarios"]), set(release_gate.REQUIRED_INSTALL_SCENARIOS))
        for name, scenario in plan["scenarios"].items():
            with self.subTest(scenario=name):
                self.assertEqual(scenario["status"], "NOT_RUN")
                self.assertTrue(scenario["steps"])

        self.assertIn(
            "--sha256 <pinned candidate SHA-256>",
            plan["scenarios"]["clean_install"]["steps"][1],
        )

        rules = plan["candidate_rules"]
        self.assertFalse(rules["stale_legacy_output_allowed"])
        self.assertIn("packages/opencode/dist", rules["stale_paths"])
        self.assertIn("genuine previous release binary", rules["required_inputs"])

        environment = plan["environment"]
        self.assertFalse(environment["remote_download"])
        self.assertEqual(environment["signing"], "UNAVAILABLE by DEC-V1-12")

        matrix = plan["platform_matrix"]
        self.assertEqual(matrix["native_linux"], "NOT_VERIFIED")
        self.assertEqual(matrix["wsl2"], "NOT_VERIFIED")
        self.assertEqual(matrix["wsl"], "NOT_VERIFIED")
        self.assertEqual(matrix["native_windows"], "UNAVAILABLE")

    def test_prepare_build_documents_the_exact_real_candidate_command(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        readme = (repository_root / "scripts" / "release" / "README.md").read_text(encoding="utf-8")
        flattened = " ".join(readme.replace("\\\n", " ").split())

        self.assertIn(
            "prepare_build.py --source . --destination kernel/target/horizoncode-release/<revision>-candidate --build",
            flattened,
        )


class IdentityMigrationDryRunTests(unittest.TestCase):
    """Item 50 preparation: the migration planner is exact, drift-checked, read-only."""

    @staticmethod
    def _tree_digest(root: Path) -> dict[str, str]:
        """Hash every bounded file, excluding only generated/volatile trees.

        Exclusions are decided on root-relative parts and cover Git internals,
        installed/build caches, phase scratch directories and the external
        reference clones under ``repo_take/``. Everything else — source, tests,
        scripts, manifests, lockfile and release metadata — is hashed.
        """
        skipped = {
            ".git", "node_modules", "target", "target-p2", ".turbo", ".bun",
            ".tmp", "__pycache__", "tmp", ".agent-tmp", ".p7-sandbox", ".p9probe",
            ".tmp-a1", "repo_take",
        }
        digest: dict[str, str] = {}
        for path in sorted(root.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            if any(part in skipped for part in path.relative_to(root).parts):
                continue
            try:
                if path.stat().st_size > 8 * 1024 * 1024:
                    continue
                payload = path.read_bytes()
            except OSError:
                continue
            digest[path.relative_to(root).as_posix()] = hashlib.sha256(payload).hexdigest()
        return digest

    @staticmethod
    def _p9_scope_digest(root: Path) -> dict[str, str]:
        """Snapshot P9-owned identity and release inputs without racing other phases."""
        candidates = {
            root / "install",
            root / "LICENSE",
            root / "NOTICE",
            root / "package.json",
            root / "bun.lock",
        }
        for relative_root in ("scripts/release",):
            base = root / relative_root
            if base.is_dir():
                candidates.update(path for path in base.rglob("*") if path.is_file())
        packages = root / "packages"
        if packages.is_dir():
            candidates.update(packages.glob("**/package.json"))

        digest: dict[str, str] = {}
        for path in sorted(candidates):
            if not path.is_file() or path.is_symlink():
                continue
            if any(part in {"node_modules", "target", "dist", "build", "__pycache__"} for part in path.relative_to(root).parts):
                continue
            try:
                if path.stat().st_size > 8 * 1024 * 1024:
                    continue
                payload = path.read_bytes()
            except OSError:
                continue
            digest[path.relative_to(root).as_posix()] = hashlib.sha256(payload).hexdigest()
        return digest

    def _fixture_root(self) -> Path:
        temp = tempfile.TemporaryDirectory(prefix="p9-idmig-", dir=SANDBOX_PARENT)
        self.addCleanup(temp.cleanup)
        root = Path(temp.name)
        (root / "scripts" / "release").mkdir(parents=True)
        (root / "packages" / "alpha" / "src").mkdir(parents=True)
        (root / "packages" / "beta" / "src").mkdir(parents=True)
        (root / "packages" / "host").mkdir(parents=True)
        (root / "package.json").write_text(
            json.dumps({"name": "fixture-workspace", "private": True}), encoding="utf-8"
        )
        (root / "packages" / "alpha" / "package.json").write_text(
            json.dumps({"name": "@opencode-ai/alpha", "version": "1.0.0"}), encoding="utf-8"
        )
        (root / "packages" / "host" / "package.json").write_text(
            json.dumps({"name": "opencode", "version": "1.0.0"}), encoding="utf-8"
        )
        (root / "packages" / "beta" / "package.json").write_text(
            json.dumps(
                {
                    "name": "@opencode-ai/beta",
                    "version": "1.0.0",
                    "dependencies": {"@opencode-ai/alpha": "workspace:*", "opencode": "workspace:*"},
                }
            ),
            encoding="utf-8",
        )
        (root / "packages" / "beta" / "src" / "user.ts").write_text(
            'import { a } from "@opencode-ai/alpha/runtime"\n'
            'import { h } from "opencode/cli"\n'
            'export const keep = "@opencode-ai/alpha"\n',
            encoding="utf-8",
        )
        (root / "packages" / "beta" / "README.md").write_text(
            'Consumes "@opencode-ai/alpha/runtime" in an example import.\n', encoding="utf-8"
        )
        (root / "bun.lock").write_text(
            '{\n'
            ' "packages": {\n'
            '  "packages/alpha": {\n'
            '   "name": "@opencode-ai/alpha",\n'
            '  },\n'
            '  "packages/host": {\n'
            '   "name": "opencode",\n'
            '  },\n'
            '  "packages/beta": {\n'
            '   "name": "@opencode-ai/beta",\n'
            '   "dependencies": {\n'
            '    "@opencode-ai/alpha": "workspace:*",\n'
            '    "opencode": "workspace:*",\n'
            '   },\n'
            '  },\n'
            ' },\n'
            ' "resolution": {\n'
            '  "@opencode-ai/alpha@workspace:packages/alpha": {},\n'
            '  "@opencode-ai/alpha@1.2.3": {},\n'
            '  "opencode@workspace:packages/host": {},\n'
            '  "@opencode-ai/beta@workspace:packages/beta": {},\n'
            ' },\n'
            '}\n',
            encoding="utf-8",
        )
        (root / "scripts" / "release" / "IDENTITY-MAPPING.json").write_text(
            json.dumps(
                {
                    "schema": 1,
                    "packages": {
                        "@opencode-ai/alpha": {
                            "disposition": "MIGRATE",
                            "target": "@horizoncode/alpha",
                            "own_manifest": "packages/alpha/package.json",
                            "impact": {
                                "lockfile_edges": ["packages/alpha importer name"],
                                "has_source_importers": True,
                                "generated_identifiers": ["packages/beta/src/generated.ts header"],
                                "runtime_identifiers": [],
                            },
                        },
                        "opencode": {
                            "disposition": "MIGRATE",
                            "target": "horizoncode",
                            "own_manifest": "packages/host/package.json",
                            "impact": {
                                "lockfile_edges": ["packages/host importer name"],
                                "has_source_importers": True,
                                "generated_identifiers": [],
                                "runtime_identifiers": ["compatibility symlink opencode"],
                            },
                        },
                        "@opencode-ai/beta": {
                            "disposition": "MIGRATE",
                            "target": "@horizoncode/beta",
                            "own_manifest": "packages/beta/package.json",
                            "impact": {
                                "lockfile_edges": ["packages/beta importer name"],
                                "has_source_importers": False,
                                "generated_identifiers": [],
                                "runtime_identifiers": [],
                            },
                        },
                    },
                    "hold_vendor": {"@opencode-ai/client": "vendored tarball"},
                    "preserve": ["opencode/** pinned snapshot"],
                }
            ),
            encoding="utf-8",
        )
        return root

    def test_dry_run_plans_a_fixture_tree_exactly_and_writes_nothing(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        before = self._tree_digest(root)
        report = identity_migration.build_migration_dry_run(root)
        after = self._tree_digest(root)

        self.assertEqual(before, after, "dry-run planner modified the tree")
        self.assertEqual(report["status"], "DRY_RUN_ONLY")
        self.assertFalse(report["writes_performed"])

        rows = report["rows"]
        alpha = rows["@opencode-ai/alpha"]
        kinds = {item["kind"] for item in alpha["transforms"]}
        self.assertIn("manifest_name", kinds)
        self.assertIn("workspace_dependency_edge", kinds)
        self.assertIn("lockfile_importer_name", kinds)
        self.assertIn("lockfile_resolution_key", kinds)
        self.assertIn("lockfile_dependency_spec", kinds)
        self.assertIn("source_import_specifier", kinds)
        self.assertIn("documentation_mention", kinds)
        self.assertIn("generated_identifier", kinds)
        self.assertEqual(alpha["completeness"], "transforms_planned")

        # The bare host id only counts as an import specifier, never as prose.
        host = rows["opencode"]
        host_kinds = {item["kind"] for item in host["transforms"]}
        self.assertIn("manifest_name", host_kinds)
        self.assertIn("lockfile_dependency_spec", host_kinds)
        self.assertIn("source_import_specifier", host_kinds)
        self.assertIn("runtime_identifier", host_kinds)
        source = [
            item for item in host["transforms"] if item["kind"] == "source_import_specifier"
        ]
        self.assertEqual(source[0]["occurrences"], 1)
        self.assertNotIn("documentation_mention", host_kinds)

        beta = rows["@opencode-ai/beta"]
        beta_kinds = {item["kind"] for item in beta["transforms"]}
        self.assertIn("manifest_name", beta_kinds)
        self.assertIn("lockfile_importer_name", beta_kinds)
        self.assertEqual(beta["completeness"], "transforms_planned")

    def test_plan_file_is_not_counted_as_a_source_importer(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        report = identity_migration.build_migration_dry_run(root)
        plan_hits = [
            (package, item)
            for package, row in report["rows"].items()
            for item in row["transforms"]
            if item["kind"] == "source_import_specifier"
            and item["path"] == identity_migration.PLAN_FILE
        ]

        self.assertEqual([], plan_hits, "the migration map is metadata, not an import consumer")

    def test_dry_run_rejects_duplicate_workspace_package_names(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        duplicate = root / "packages" / "00-duplicate" / "package.json"
        duplicate.parent.mkdir(parents=True)
        duplicate.write_text(
            json.dumps({"name": "@opencode-ai/alpha", "version": "1.0.0"}),
            encoding="utf-8",
        )

        with self.assertRaisesRegex(ValueError, "duplicate workspace package name"):
            identity_migration.build_migration_dry_run(root)

    def test_dry_run_rejects_workspace_manifests_without_nonempty_names(self) -> None:
        from scripts.release import identity_migration

        for case, manifest in (("missing", {}), ("empty", {"name": ""}), ("whitespace", {"name": " \t"})):
            with self.subTest(case=case):
                root = self._fixture_root()
                malformed = root / "packages" / "gamma" / "package.json"
                malformed.parent.mkdir(parents=True)
                malformed.write_text(json.dumps(manifest), encoding="utf-8")

                with self.assertRaisesRegex(ValueError, "workspace manifest.*non-empty package name"):
                    identity_migration.build_migration_dry_run(root)

    def test_dry_run_rejects_duplicate_migration_targets(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        plan_path = root / "scripts" / "release" / "IDENTITY-MAPPING.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan["packages"]["@opencode-ai/beta"]["target"] = "@horizoncode/alpha"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "duplicate migration target"):
            identity_migration.build_migration_dry_run(root)

    def test_dry_run_rejects_whitespace_only_migration_target(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        plan_path = root / "scripts" / "release" / "IDENTITY-MAPPING.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan["packages"]["@opencode-ai/alpha"]["target"] = " \t\n"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "migration target must be a non-empty package id"):
            identity_migration.build_migration_dry_run(root)

    def test_dry_run_allows_a_migration_target_equal_to_its_source_id(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        plan_path = root / "scripts" / "release" / "IDENTITY-MAPPING.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan["packages"]["@opencode-ai/alpha"]["target"] = "@opencode-ai/alpha"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")

        report = identity_migration.build_migration_dry_run(root)
        self.assertEqual(report["rows"]["@opencode-ai/alpha"]["target"], "@opencode-ai/alpha")

    def test_dry_run_rejects_target_that_already_names_a_workspace(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        existing = root / "packages" / "existing-client"
        existing.mkdir(parents=True)
        existing_manifest = existing / "package.json"
        existing_manifest.write_text(
            json.dumps({"name": "@horizoncode/client", "version": "1.0.0"}),
            encoding="utf-8",
        )
        plan_path = root / "scripts" / "release" / "IDENTITY-MAPPING.json"
        plan = json.loads(plan_path.read_text(encoding="utf-8"))
        plan["packages"]["@horizoncode/client"] = {
            "disposition": "DONE",
            "own_manifest": "packages/existing-client/package.json",
            "impact": {},
        }
        plan["packages"]["@opencode-ai/alpha"]["target"] = "@horizoncode/client"
        plan_path.write_text(json.dumps(plan), encoding="utf-8")

        with self.assertRaisesRegex(ValueError, "target .* already exists as a workspace package id"):
            identity_migration.build_migration_dry_run(root)

    def test_dry_run_fails_closed_on_workspace_drift(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        (root / "packages" / "gamma").mkdir()
        (root / "packages" / "gamma" / "package.json").write_text(
            json.dumps({"name": "@opencode-ai/gamma", "version": "1.0.0"}), encoding="utf-8"
        )

        with self.assertRaises(ValueError) as caught:
            identity_migration.build_migration_dry_run(root)
        self.assertIn("drift", str(caught.exception))

    def test_dry_run_on_the_real_tree_is_complete_and_read_only(self) -> None:
        from scripts.release import identity_migration

        repository_root = Path(__file__).resolve().parents[2]
        plan = json.loads(
            (repository_root / "scripts" / "release" / "IDENTITY-MAPPING.json").read_text(encoding="utf-8")
        )
        migrate = {name for name, row in plan["packages"].items() if row["disposition"] == "MIGRATE"}

        before = self._p9_scope_digest(repository_root)
        report = identity_migration.build_migration_dry_run(repository_root)
        after = self._p9_scope_digest(repository_root)

        # Other phase owners legitimately add or edit their own files while this
        # test runs. The synthetic fixture test above provides a whole-tree
        # equality proof; this real-tree check binds only the P9-owned inputs.
        self.assertEqual(before, after, "identity planner changed a P9-owned release/identity input")
        self.assertFalse(report["writes_performed"])
        self.assertEqual(report["status"], "DRY_RUN_ONLY")
        self.assertEqual(set(report["rows"]), migrate)

        for name in migrate:
            with self.subTest(row=name):
                row = report["rows"][name]
                planned = row["transform_counts"]
                total = sum(value for kind, value in planned.items() if not kind.startswith("no_transform"))
                if total == 0:
                    self.assertEqual(row["completeness"], "no_transform_reason")
                else:
                    self.assertEqual(row["completeness"], "transforms_planned")

        # Named generated/runtime impacts stay visible in the plan output.
        self.assertTrue(report["rows"]["@opencode-ai/httpapi-codegen"]["transform_counts"]["generated_identifier"])
        self.assertTrue(report["rows"]["@opencode-ai/effect-sqlite-node"]["transform_counts"]["runtime_identifier"])

    def test_planner_module_has_no_write_path_beyond_the_report_writer(self) -> None:
        from scripts.release import identity_migration

        source = Path(identity_migration.__file__).read_text(encoding="utf-8")
        body = "\n".join(
            line for line in source.splitlines() if not line.lstrip().startswith("#")
        )

        self.assertNotIn("write_text(", body)
        self.assertNotIn("write_bytes(", body)
        self.assertNotIn("shutil.", body)
        self.assertEqual(body.count("os.open("), 1, "only the report writer may open a file for writing")
        self.assertIn("O_EXCL", body)
        self.assertIn("os.O_WRONLY", body)

    def test_cli_writes_only_the_explicit_report_file(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        output = root / "dry-run-report.json"
        before = self._tree_digest(root)
        result = subprocess.run(
            [
                sys.executable,
                str(Path(identity_migration.__file__)),
                "--root",
                str(root),
                "--output",
                str(output),
            ],
            cwd=repository_root_for_tests(),
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("DRY_RUN_ONLY", result.stdout)
        self.assertTrue(output.is_file())
        written = json.loads(output.read_text(encoding="utf-8"))
        self.assertEqual(written["status"], "DRY_RUN_ONLY")
        self.assertFalse(written["writes_performed"])
        after = self._tree_digest(root)
        after.pop("dry-run-report.json", None)
        self.assertEqual(before, after)

    def test_cli_rejects_output_outside_the_root(self) -> None:
        from scripts.release import identity_migration

        root = self._fixture_root()
        outside = Path(tempfile.gettempdir()) / "p9-idmig-outside.json"
        result = subprocess.run(
            [
                sys.executable,
                str(Path(identity_migration.__file__)),
                "--root",
                str(root),
                "--output",
                str(outside),
            ],
            cwd=repository_root_for_tests(),
            capture_output=True,
            text=True,
            timeout=180,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertFalse(outside.exists())


def repository_root_for_tests() -> Path:
    return Path(__file__).resolve().parents[2]



class DistributionStrictExitTests(unittest.TestCase):
    """A BLOCKED distribution audit must never exit 0 under --strict."""

    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory(prefix="p9-strict-exit-", dir=SANDBOX_PARENT)
        self.root = Path(self.temp.name)
        (self.root / "opencode").mkdir()
        (self.root / "packages" / "opencode").mkdir(parents=True)
        (self.root / "node_modules" / "first-party-runtime").mkdir(parents=True)
        (self.root / "node_modules" / "transitive-runtime").mkdir()
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "UNLICENSED"}),
            encoding="utf-8",
        )
        vendor_license = "MIT License\nCopyright (c) upstream\nPermission notice\n"
        (self.root / "opencode" / "LICENSE").write_text(vendor_license, encoding="utf-8")
        (self.root / "LICENSE").write_text(vendor_license, encoding="utf-8")
        (self.root / "packages" / "opencode" / "package.json").write_text(
            json.dumps(
                {
                    "name": "opencode",
                    "version": "1.0.0",
                    "private": True,
                    "license": "MIT",
                    "dependencies": {"first-party-runtime": "1.0.0"},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "node_modules" / "first-party-runtime" / "package.json").write_text(
            json.dumps(
                {
                    "name": "first-party-runtime",
                    "version": "1.0.0",
                    "license": "MIT",
                    "dependencies": {"transitive-runtime": "2.0.0"},
                }
            ),
            encoding="utf-8",
        )
        (self.root / "node_modules" / "first-party-runtime" / "LICENSE").write_text(
            "MIT License\n", encoding="utf-8"
        )
        (self.root / "node_modules" / "transitive-runtime" / "package.json").write_text(
            json.dumps({"name": "transitive-runtime", "version": "2.0.0"}),
            encoding="utf-8",
        )

    def tearDown(self) -> None:
        self.temp.cleanup()

    def _run_cli(self, *arguments: str) -> subprocess.CompletedProcess[str]:
        script = Path(__file__).resolve().parents[2] / "scripts" / "release" / "audit_distribution.py"
        return subprocess.run(
            [sys.executable, str(script), "--root", str(self.root), *arguments],
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
        )

    def test_strict_cli_exits_non_zero_when_the_report_is_blocked(self) -> None:
        result = self._run_cli("--strict")

        self.assertNotEqual(
            result.returncode,
            0,
            f"--strict accepted a BLOCKED report (stdout tail: {result.stdout[-1500:]})",
        )
        report = json.loads(result.stdout)
        self.assertEqual(report["release_status"], "BLOCKED")
        self.assertTrue(report["blockers"])

        # The default, non-strict invocation stays informational-only on purpose.
        informational = self._run_cli()
        self.assertEqual(informational.returncode, 0, informational.stderr)
        self.assertEqual(json.loads(informational.stdout)["release_status"], "BLOCKED")

    def test_strict_fails_closed_even_when_only_the_reported_status_is_blocked(self) -> None:
        with patch.object(
            audit_distribution,
            "audit_repository",
            return_value={"release_status": "BLOCKED", "blockers": []},
        ), patch.object(sys, "argv", ["audit_distribution.py", "--strict"]), contextlib.redirect_stdout(
            io.StringIO()
        ):
            self.assertEqual(audit_distribution.main(), 1)

        with patch.object(
            audit_distribution,
            "audit_repository",
            return_value={"release_status": "REVIEW_REQUIRED", "blockers": []},
        ), patch.object(sys, "argv", ["audit_distribution.py", "--strict"]), contextlib.redirect_stdout(
            io.StringIO()
        ):
            self.assertEqual(audit_distribution.main(), 0)


class ContinuousIntegrationWorkflowTests(unittest.TestCase):
    """CI triggers, Guard-suite selection and publication fail-closed gates."""

    @staticmethod
    def _read_workflow(name: str) -> tuple[Path, str]:
        path = Path(__file__).resolve().parents[2] / ".github" / "workflows" / name
        if not path.is_file():
            raise AssertionError(f"workflow is missing: {path}")
        return path, path.read_text(encoding="utf-8")

    def _triggers(self, name: str, text: str) -> dict:
        self.assertIsNotNone(yaml, "PyYAML is required to verify GitHub Actions triggers")
        document = yaml.safe_load(text)
        for key in (True, "on"):
            if key in document:
                return document[key] or {}
        self.fail(f"{name} has no workflow trigger block")

    def test_full_validation_fires_on_main_push_and_pull_request(self) -> None:
        _, text = self._read_workflow("horizoncode-full-validation.yml")
        triggers = self._triggers("horizoncode-full-validation.yml", text)

        self.assertEqual(triggers["push"]["branches"], ["main"])
        self.assertEqual(triggers["pull_request"]["branches"], ["main"])
        self.assertIn("workflow_dispatch", triggers)

    def test_typecheck_and_unit_workflows_fire_on_main_and_dev(self) -> None:
        _, typecheck = self._read_workflow("typecheck.yml")
        typecheck_triggers = self._triggers("typecheck.yml", typecheck)
        self.assertEqual(typecheck_triggers["push"]["branches"], ["main", "dev"])
        self.assertEqual(typecheck_triggers["pull_request"]["branches"], ["main", "dev"])
        self.assertIn("workflow_dispatch", typecheck_triggers)

        _, unit = self._read_workflow("test.yml")
        unit_triggers = self._triggers("test.yml", unit)
        self.assertEqual(unit_triggers["push"]["branches"], ["main", "dev"])
        self.assertIn("pull_request", unit_triggers)
        self.assertIn("refs/heads/main", unit)
        for text in (typecheck, unit):
            self.assertNotIn("publish", text.lower())
            self.assertNotIn("id-token: write", text)

    def test_full_validation_executes_every_guard_and_worker_wire_suite(self) -> None:
        _, text = self._read_workflow("horizoncode-full-validation.yml")
        selectors = (
            "--lib resource_budget",
            "--lib worker_pool::jc_res_012_wire_tests",
            "--test managed_control",
            "--test tool_batch_guard_matrix",
            "--test effects_host_process",
            "--test host_terminal_process",
            "--test host_terminal_events_process",
        )
        for selector in selectors:
            with self.subTest(selector=selector):
                self.assertIn(selector, text)
        # The readiness-false suites are classified against the documented
        # `capability_unavailable` denials, never skipped or force-passed.
        self.assertIn("capability_unavailable", text)
        self.assertIn("silently skipping is forbidden", text)
        for forbidden in ("continue-on-error", "--skip ", "--exclude", "|| true", "|| echo", "|| :"):
            with self.subTest(forbidden=forbidden):
                self.assertNotIn(forbidden, text)

    def test_every_publication_workflow_job_stays_disabled(self) -> None:
        workflow_dir = Path(__file__).resolve().parents[2] / ".github" / "workflows"
        workflows = sorted(workflow_dir.glob("publish*.yml"))
        self.assertEqual(
            [path.name for path in workflows],
            ["publish-github-action.yml", "publish-vscode.yml", "publish.yml"],
        )
        for path in workflows:
            text = path.read_text(encoding="utf-8")
            with self.subTest(workflow=path.name):
                self.assertIsNotNone(yaml, "PyYAML is required to verify publication jobs")
                jobs = yaml.safe_load(text).get("jobs") or {}
                self.assertTrue(jobs, f"{path.name} defines no jobs")
                for job, definition in jobs.items():
                    self.assertEqual(
                        definition.get("if"),
                        "${{ false }}",
                        f"{path.name}:{job} is not fail-closed",
                    )
                self.assertNotIn("id-token: write", text)
                self.assertNotIn("npm publish", text)


class StandaloneInstallerIntegrityTests(unittest.TestCase):
    """Local install enforces digest and architecture integrity checks."""

    @staticmethod
    def _install(repository_root: Path, home: Path, candidate: Path, *extra: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(
            ["bash", str(repository_root / "install"), "--binary", str(candidate), "--no-modify-path", *extra],
            cwd=repository_root,
            env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
            capture_output=True,
            text=True,
            timeout=15,
            check=False,
        )

    def test_installer_rehashes_staged_candidate_before_activation(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-staged-tamper-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            home = root / "home"
            home.mkdir(mode=0o700)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_cp = fake_bin / "cp"
            fake_cp.write_text(
                "#!/bin/sh\n"
                "case \"${3:-}\" in\n"
                "  */.horizoncode-install.*)\n"
                "    printf '#!/bin/sh\\necho tampered\\n' > \"$3\"\n"
                "    chmod 755 \"$3\"\n"
                "    ;;\n"
                "  *) exec /bin/cp \"$@\" ;;\n"
                "esac\n",
                encoding="utf-8",
            )
            fake_cp.chmod(0o755)

            result = subprocess.run(
                [
                    "bash", str(repository_root / "install"), "--binary", str(candidate),
                    "--sha256", digest, "--no-modify-path",
                ],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash", PATH=f"{fake_bin}:{os.environ.get('PATH', '')}"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            install_dir = home / ".opencode" / "bin"
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("staged candidate SHA-256 mismatch", result.stderr)
            self.assertFalse((install_dir / "horizoncode").exists())
            self.assertFalse((install_dir / "hzcode").exists())

    def test_sha256_verification_does_not_require_awk(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-no-awk-sha256-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            home = root / "home"
            home.mkdir(mode=0o700)
            fake_bin = root / "bin"
            fake_bin.mkdir()
            fake_awk = fake_bin / "awk"
            fake_awk.write_text("#!/bin/sh\nexit 127\n", encoding="utf-8")
            fake_awk.chmod(0o755)
            env = dict(
                os.environ,
                HOME=str(home),
                SHELL="/bin/bash",
                PATH=f"{fake_bin}:{os.environ.get('PATH', '')}",
            )

            result = subprocess.run(
                [
                    "bash", str(repository_root / "install"), "--binary", str(candidate),
                    "--sha256", digest, "--no-modify-path",
                ],
                cwd=repository_root,
                env=env,
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )

            self.assertEqual(result.returncode, 0, result.stderr)
            installed = home / ".opencode" / "bin" / "horizoncode"
            self.assertTrue(installed.is_file())
            self.assertEqual(hashlib.sha256(installed.read_bytes()).hexdigest(), digest)

    def test_binary_install_requires_sha256_before_creating_install_state(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-required-sha256-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)
            home = root / "home"
            home.mkdir(mode=0o700)

            result = self._install(repository_root, home, candidate)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("--sha256 is required", result.stderr)
            self.assertFalse((home / ".opencode").exists())

    def test_installer_rejects_elf_for_another_host_architecture(self) -> None:
        if not hasattr(os, "uname"):
            self.skipTest("native Linux architecture detection requires os.uname")
        repository_root = Path(__file__).resolve().parents[2]
        host = os.uname().machine.lower()
        if host in ("x86_64", "amd64"):
            wrong_machine = 183  # EM_AARCH64
        elif host in ("aarch64", "arm64"):
            wrong_machine = 62  # EM_X86_64
        else:
            self.skipTest(f"no V1 installer target mapping for host {host}")
        header = bytearray(64)
        header[:4] = b"\x7fELF"
        header[4:7] = bytes((2, 1, 1))  # ELF64, little-endian, current version
        header[18:20] = wrong_machine.to_bytes(2, "little")

        with tempfile.TemporaryDirectory(prefix="p9-wrong-arch-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            candidate = root / "candidate"
            candidate.write_bytes(header)
            candidate.chmod(0o755)
            home = root / "home"
            home.mkdir(mode=0o700)
            digest = hashlib.sha256(header).hexdigest()

            result = self._install(repository_root, home, candidate, "--sha256", digest)

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("architecture does not match", result.stderr)
            self.assertFalse((home / ".opencode").exists())

    def test_clean_install_passes_its_pinned_digest_to_the_installer(self) -> None:
        with tempfile.TemporaryDirectory(prefix="p9-pinned-install-call-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            checkout = root / "checkout"
            checkout.mkdir()
            (checkout / "install").write_text("installer", encoding="utf-8")
            binary = root / "candidate"
            binary.write_bytes(b"candidate bytes")
            digest = hashlib.sha256(binary.read_bytes()).hexdigest()
            home = root / "home"
            env = dict(os.environ, HOME=str(home))

            with patch("scripts.release.clean_install._run", return_value={"exit_code": 0}) as invoke:
                clean_install._install(
                    checkout, binary, home, root, env, root / "state", digest
                )

            command = invoke.call_args.args[0]
            self.assertIn("--sha256", command)
            self.assertEqual(command[command.index("--sha256") + 1], digest)

    def test_binary_install_verifies_sha256_and_fails_closed_on_mismatch(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        with tempfile.TemporaryDirectory(prefix="p9-sha256-install-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)
            digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
            mismatched = ("0" if digest[0] != "0" else "1") + digest[1:]

            accepted_home = root / "accepted-home"
            accepted_home.mkdir(mode=0o700)
            accepted = self._install(repository_root, accepted_home, candidate, "--sha256", digest.upper())
            self.assertEqual(accepted.returncode, 0, accepted.stderr)
            self.assertTrue((accepted_home / ".opencode" / "bin" / "horizoncode").is_file())

            rejected_home = root / "rejected-home"
            rejected_home.mkdir(mode=0o700)
            rejected = self._install(repository_root, rejected_home, candidate, "--sha256", mismatched)
            self.assertNotEqual(rejected.returncode, 0)
            self.assertIn("SHA-256 mismatch", rejected.stderr)
            self.assertFalse((rejected_home / ".opencode").exists())

            dry_home = root / "dry-home"
            dry_home.mkdir(mode=0o700)
            rejected_dry_run = self._install(
                repository_root, dry_home, candidate, "--sha256", mismatched, "--dry-run"
            )
            self.assertNotEqual(rejected_dry_run.returncode, 0)
            self.assertIn("SHA-256 mismatch", rejected_dry_run.stderr)
            self.assertFalse((dry_home / ".opencode").exists())

            verified_home = root / "verified-home"
            verified_home.mkdir(mode=0o700)
            verified_dry_run = self._install(
                repository_root, verified_home, candidate, "--sha256", digest, "--dry-run"
            )
            self.assertEqual(verified_dry_run.returncode, 0, verified_dry_run.stderr)
            self.assertIn("sha256: verified", verified_dry_run.stdout)
            self.assertFalse((verified_home / ".opencode").exists())

    def test_sha256_option_requires_a_binary_and_a_well_formed_digest(self) -> None:
        repository_root = Path(__file__).resolve().parents[2]
        digest = "a" * 64
        with tempfile.TemporaryDirectory(prefix="p9-sha256-invalid-", dir=SANDBOX_PARENT) as temporary:
            root = Path(temporary)
            home = root / "home"
            home.mkdir(mode=0o700)

            without_binary = subprocess.run(
                ["bash", str(repository_root / "install"), "--sha256", digest],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            self.assertNotEqual(without_binary.returncode, 0)
            self.assertIn("--sha256 requires --binary", without_binary.stderr)
            self.assertFalse((home / ".opencode").exists())

            missing_value = subprocess.run(
                ["bash", str(repository_root / "install"), "--sha256"],
                cwd=repository_root,
                env=dict(os.environ, HOME=str(home), SHELL="/bin/bash"),
                capture_output=True,
                text=True,
                timeout=15,
                check=False,
            )
            self.assertNotEqual(missing_value.returncode, 0)
            self.assertIn("--sha256 requires a 64-character", missing_value.stderr)

            candidate = root / "candidate"
            candidate.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
            candidate.chmod(0o755)
            for malformed in ("abc", "g" * 64, "a" * 63, digest + "a"):
                with self.subTest(malformed=malformed):
                    rejected = self._install(repository_root, home, candidate, "--sha256", malformed)
                    self.assertNotEqual(rejected.returncode, 0)
                    self.assertIn("64 hexadecimal", rejected.stderr)
            self.assertFalse((home / ".opencode").exists())


if __name__ == "__main__":
    unittest.main()
