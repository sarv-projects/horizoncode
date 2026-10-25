"""Synthetic harness tests; these do not establish product install evidence."""

from __future__ import annotations

import json
import hashlib
import io
import os
from pathlib import Path
import shutil
import socket
import stat
import subprocess
import sys
import tarfile
import tempfile
import textwrap
import time
import unittest
import zipfile
from unittest.mock import patch

from scripts.release.audit_distribution import (
    MAX_PACKAGE_MANIFEST_BYTES,
    audit_repository,
    inspect_artifact,
    scan_runtime_dependencies,
)
from scripts.release import clean_install
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
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--no-modify-path"],
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
                ["bash", str(repository_root / "install"), "--version", "1.2.3", "--binary", str(candidate)],
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
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--no-modify-path"],
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
                ["bash", str(repository_root / "install"), "--binary", str(candidate_link), "--no-modify-path"],
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
                    ["bash", str(repository_root / "install"), "--binary", str(versions[version]), "--no-modify-path"],
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
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--no-modify-path", "--dry-run"],
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
                ["bash", str(repository_root / "install"), "--binary", str(candidate), "--no-modify-path"],
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
        self.assertIn("DEC-V1-12", (repository_root / "NOTICE").read_text(encoding="utf-8"))

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

    def test_first_party_mit_decision_requires_distinct_license_and_notice(self) -> None:
        (self.root / "package.json").write_text(
            json.dumps({"name": "horizoncode-workspace", "private": True, "license": "MIT"}),
            encoding="utf-8",
        )
        (self.root / "LICENSE").write_text("MIT License\nfirst-party grant\n", encoding="utf-8")
        (self.root / "NOTICE").write_text("OpenCode attribution; exact third-party closure pending\\n", encoding="utf-8")

        report = audit_repository(self.root)

        self.assertTrue(report["distribution_license"]["legal_decision_made"])
        self.assertFalse(report["distribution_license"]["root_license_matches_vendor"])
        self.assertIn("no built package artifact was supplied or found", report["blockers"])

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
        (artifact / "bin" / "horizoncode").write_bytes(b"candidate executable")
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
            "source_checkout": {"status": "CLEAN", "revision": "source-revision"},
            "artifacts": {"candidate": {"sha256": "candidate-sha256"}},
        }

        matrix = build_platform_support_matrix(evidence)

        self.assertEqual(matrix["observed_install_host"]["host_kind"], "WSL2")
        wsl2 = matrix["lanes"]["wsl2"]
        self.assertEqual(wsl2["install_matrix_status"], "PASS")
        self.assertEqual(wsl2["support_status"], "NOT_VERIFIED")
        self.assertEqual(wsl2["install_evidence"]["source_revision"], "source-revision")
        self.assertEqual(wsl2["install_evidence"]["candidate_sha256"], "candidate-sha256")
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
            "source_checkout": {"status": "CLEAN", "revision": "source-revision"},
            "artifacts": {"candidate": {"sha256": "candidate-sha256"}},
            "scenarios": {
                "clean_install": {"status": "PASS"},
                "tui_launch": {"status": "PASS"},
            },
        }

        matrix = build_platform_support_matrix(evidence)

        lane = matrix["lanes"]["native_linux"]
        self.assertEqual(lane["install_matrix_status"], "PASS")
        self.assertEqual(lane["support_status"], "NOT_VERIFIED")
        self.assertEqual(lane["install_evidence"]["source_revision"], "source-revision")
        self.assertEqual(
            lane["install_evidence"]["scenario_statuses"],
            {"clean_install": "PASS", "tui_launch": "PASS"},
        )
        self.assertEqual(matrix["lanes"]["wsl2"]["install_matrix_status"], "NOT_RUN")
        self.assertEqual(matrix["lanes"]["native_windows"]["support_status"], "UNAVAILABLE")
        self.assertEqual(matrix["lanes"]["macos"]["support_status"], "OUT_OF_SCOPE")
        self.assertEqual(matrix["assessment_status"], "NOT_VERIFIED")

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
        self.network_probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.network_probe.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        self.network_probe.bind(("127.0.0.1", 0))
        self.network_probe.listen(8)
        self.network_probe_port = self.network_probe.getsockname()[1]
        self.host_only_sentinel = self.root / "host-only-sentinel"
        self.host_only_sentinel.write_text("not mounted into the child sandbox", encoding="utf-8")
        shutil.copy2(Path(__file__).resolve().parents[2] / "install", self.checkout / "install")
        (self.checkout / "artifacts").mkdir()
        fixture_dir = self.checkout / "scripts" / "release" / "fixtures"
        fixture_dir.mkdir(parents=True)
        shutil.copy2(Path(__file__).resolve().parent / "fixtures" / "legacy-config.toml", fixture_dir / "legacy-config.toml")
        self.old_binary = self.checkout / "artifacts" / "previous-opencode"
        self.new_binary = self.checkout / "artifacts" / "candidate-opencode"
        self._write_test_binary(self.old_binary, "1.0.0")
        self._write_test_binary(self.new_binary, "2.0.0")
        self.fixture = fixture_dir / "legacy-config.toml"

    def tearDown(self) -> None:
        self.network_probe.close()
        self.temp.cleanup()

    def _write_test_binary(self, path: Path, version: str) -> None:
        path.write_text(
            textwrap.dedent(
                f"""\
                #!/usr/bin/env python3
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
                    print(version + "|network-" + network)
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
            "2.0.0|network-blocked",
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
        candidate_link = self.checkout / "artifacts" / "candidate-link"
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
        self.assertEqual(upgrade["previous_version"], "1.0.0|network-blocked")
        self.assertEqual(upgrade["candidate_version"], "2.0.0|network-blocked")
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

    def test_release_matrix_rejects_unversioned_checkout_by_default(self) -> None:
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
        subprocess.run(["git", "init", "--quiet"], cwd=self.checkout, check=True)
        subprocess.run(["git", "config", "user.name", "P9 test"], cwd=self.checkout, check=True)
        subprocess.run(["git", "config", "user.email", "p9-test@example.invalid"], cwd=self.checkout, check=True)
        subprocess.run(["git", "add", "install", "artifacts", "scripts"], cwd=self.checkout, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "synthetic artifacts"], cwd=self.checkout, check=True)

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

        subprocess.run(["git", "init", "--quiet"], cwd=self.checkout, check=True)
        subprocess.run(["git", "config", "user.name", "P9 test"], cwd=self.checkout, check=True)
        subprocess.run(["git", "config", "user.email", "p9-test@example.invalid"], cwd=self.checkout, check=True)
        subprocess.run(["git", "add", "install", "artifacts", "scripts"], cwd=self.checkout, check=True)
        subprocess.run(["git", "commit", "--quiet", "-m", "different candidate source"], cwd=self.checkout, check=True)
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
            "#!/usr/bin/env python3\n"
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
        report = plan_isolated_build(self.source, self.destination)

        self.assertTrue(report["dry_run"])
        self.assertEqual(report["build"]["status"], "DRY_RUN")
        self.assertEqual(report["build_copy"]["status"], "NOT_CREATED")
        self.assertEqual(report["source"]["status"], "DIRTY")
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


if __name__ == "__main__":
    unittest.main()
