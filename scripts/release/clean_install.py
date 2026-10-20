#!/usr/bin/env python3
"""Run a Linux/WSL install, upgrade, migration, and binary rollback matrix.

The runner accepts artifacts from a separate clean checkout, installs only via
that checkout's local ``install --binary`` path, and keeps every home/config/
data/cache file beneath a new task-owned directory under /tmp/opencode. It does
not download, publish, change shell profiles, or delete its evidence directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import select
import signal
import shutil
import subprocess
import sys
import tempfile
import time
import uuid


APPROVED_TEMP_ROOT = Path("/tmp/opencode")
CLI_COMMAND = "horizoncode"
CLI_ALIAS = "hzcode"
TIMEOUT_SECONDS = 45
SANDBOX_STARTUP_TIMEOUT_SECONDS = 10
TUI_STARTUP_SECONDS = 1.0
# The shutdown window applies to the sandboxed app's own SIGINT handling. Under
# CPU oversubscription a clean shutdown was observed to take >3s (P9 evidence,
# 2026-10-17), so the window is bounded but generous; the observed exit code,
# not the latency, decides pass/fail.
TUI_SHUTDOWN_SECONDS = 10.0
TUI_OUTPUT_LIMIT_BYTES = 1024 * 1024
CONTAINER_CHECKOUT = Path("/workspace")
CONTAINER_EVIDENCE = Path("/evidence")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _require_regular_executable(path: Path, checkout: Path, label: str) -> Path:
    resolved = path.resolve()
    if not _inside(resolved, checkout):
        raise ValueError(f"{label} must be inside the separate checkout: {path}")
    if path.is_symlink() or not resolved.is_file() or not os.access(resolved, os.X_OK):
        raise ValueError(f"{label} must be a regular executable file: {path}")
    return resolved


def _checkout_facts(checkout: Path) -> dict:
    try:
        top = subprocess.run(
            ["git", "rev-parse", "--show-toplevel"],
            cwd=checkout,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=checkout,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=checkout,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {"status": "UNVERSIONED", "revision": None, "clean": False}
    return {
        "status": "CLEAN" if not status else "DIRTY",
        "root": str(Path(top).resolve()),
        "revision": revision,
        "clean": not status,
    }


def _validated_state_root(state_root: Path) -> Path:
    base = APPROVED_TEMP_ROOT
    if base.is_symlink() or not base.is_dir():
        raise ValueError(f"approved task temp root is missing or is a symlink: {base}")
    resolved_base = base.resolve()
    if resolved_base != base:
        raise ValueError(f"approved task temp root must not resolve through a symlink: {base}")
    base_stat = base.stat(follow_symlinks=False)
    if base_stat.st_uid != os.getuid() or base_stat.st_mode & 0o022:
        raise ValueError(f"approved task temp root must be owned by this user and not group/world-writable: {base}")
    requested = Path(os.path.abspath(state_root))
    if requested.exists() or requested.is_symlink():
        raise ValueError(f"test state directory already exists; refusing to reuse it: {requested}")
    if not _inside(requested, resolved_base) or requested == resolved_base:
        raise ValueError(f"test state directory must be a new child of {resolved_base}: {requested}")
    if not requested.parent.is_dir():
        raise ValueError(f"test state directory parent must already exist: {requested.parent}")
    cursor = requested.parent
    while _inside(cursor, resolved_base):
        if cursor.is_symlink():
            raise ValueError(f"test state path contains a symlinked parent: {cursor}")
        metadata = cursor.stat(follow_symlinks=False)
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ValueError(f"test state parent must be owned by this user and not group/world-writable: {cursor}")
        if cursor == resolved_base:
            break
        cursor = cursor.parent
    return requested


def _safe_environment(home: Path, temporary: Path) -> dict[str, str]:
    home = home.resolve()
    config = home / ".config"
    data = home / ".local" / "share"
    state = home / ".local" / "state"
    cache = home / ".cache"
    tmp = temporary / "tmp"
    for path in (home, config, data, state, cache, tmp):
        path.mkdir(parents=True, exist_ok=True, mode=0o700)
    return {
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "HOME": str(home),
        "SHELL": "/bin/sh",
        "TMPDIR": str(tmp),
        "XDG_CONFIG_HOME": str(config),
        "XDG_DATA_HOME": str(data),
        "XDG_STATE_HOME": str(state),
        "XDG_CACHE_HOME": str(cache),
        "OPENCODE_TEST_HOME": str(home),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


def _profile_hashes(home: Path) -> dict[str, str | None]:
    candidates = [home / name for name in (".bashrc", ".bash_profile", ".profile", ".zshrc", ".zshenv", ".ashrc")]
    candidates.append(home / ".config" / "fish" / "config.fish")
    return {str(path): _sha256(path) if path.is_file() else None for path in candidates}


def _sandbox_base(bubblewrap: str) -> list[str]:
    command = [bubblewrap, "--unshare-net", "--die-with-parent"]
    for system_path in ("/usr", "/bin", "/lib", "/lib64"):
        if Path(system_path).exists():
            command.extend(["--ro-bind", system_path, system_path])
    command.extend(["--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp"])
    return command


def _sandbox_preflight() -> dict:
    bubblewrap = shutil.which("bwrap")
    if not bubblewrap:
        raise ValueError("bubblewrap is required for fail-closed network isolation")
    command = [*_sandbox_base(bubblewrap), "--", "/bin/true"]
    try:
        result = subprocess.run(
            command,
            cwd="/",
            env={"PATH": "/usr/bin:/bin", "LANG": "C.UTF-8", "LC_ALL": "C.UTF-8"},
            capture_output=True,
            text=True,
            timeout=SANDBOX_STARTUP_TIMEOUT_SECONDS,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise ValueError(f"bubblewrap network isolation preflight failed: {error}") from error
    if result.returncode != 0:
        detail = (result.stderr or result.stdout).strip()[-1000:]
        raise ValueError(f"bubblewrap network isolation preflight failed (exit {result.returncode}): {detail}")
    return {
        "status": "ENABLED",
        "backend": "bubblewrap",
        "network_namespace": "unshared",
        "filesystem": "system runtime read-only; source checkout read-only; evidence root writable; private tmpfs",
        "host_home_mounted": False,
        "host_tmp_mounted": False,
        "preflight_exit_code": result.returncode,
    }


def _container_path(path: Path, source_checkout: Path, state_root: Path) -> Path:
    absolute = Path(os.path.abspath(path))
    if _inside(absolute, source_checkout):
        return CONTAINER_CHECKOUT / absolute.relative_to(source_checkout)
    if _inside(absolute, state_root):
        return CONTAINER_EVIDENCE / absolute.relative_to(state_root)
    raise ValueError(f"sandbox path must be inside the source checkout or evidence root: {path}")


def _sandbox_command(
    command: list[str],
    *,
    cwd: Path,
    source_checkout: Path,
    state_root: Path,
    environment: dict[str, str],
) -> tuple[list[str], dict[str, str]]:
    if _inside(source_checkout, state_root) or _inside(state_root, source_checkout):
        raise ValueError("source checkout and evidence root must be separate, non-overlapping directories")
    bubblewrap = shutil.which("bwrap")
    if not bubblewrap:
        raise ValueError("bubblewrap is required for fail-closed network isolation")

    container_env = dict(environment)
    for name in (
        "HOME",
        "TMPDIR",
        "XDG_CONFIG_HOME",
        "XDG_DATA_HOME",
        "XDG_STATE_HOME",
        "XDG_CACHE_HOME",
        "OPENCODE_TEST_HOME",
    ):
        if name in container_env:
            container_env[name] = str(_container_path(Path(container_env[name]), source_checkout, state_root))

    container_command = []
    for argument in command:
        if argument.startswith("/"):
            try:
                argument = str(_container_path(Path(argument), source_checkout, state_root))
            except ValueError:
                pass
        container_command.append(argument)

    container_cwd = _container_path(cwd, source_checkout, state_root)
    sandbox = _sandbox_base(bubblewrap)
    sandbox.extend(["--dir", str(CONTAINER_CHECKOUT), "--ro-bind", str(source_checkout), str(CONTAINER_CHECKOUT)])
    sandbox.extend(["--dir", str(CONTAINER_EVIDENCE), "--bind", str(state_root), str(CONTAINER_EVIDENCE)])
    sandbox.extend(["--chdir", str(container_cwd), "--", *container_command])
    return sandbox, container_env


def _run(
    command: list[str],
    cwd: Path,
    environment: dict[str, str],
    label: str,
    *,
    source_checkout: Path,
    state_root: Path,
) -> dict:
    sandbox_command, sandbox_environment = _sandbox_command(
        command,
        cwd=cwd,
        source_checkout=source_checkout,
        state_root=state_root,
        environment=environment,
    )
    try:
        result = subprocess.run(
            sandbox_command,
            cwd="/",
            env=sandbox_environment,
            capture_output=True,
            text=True,
            timeout=TIMEOUT_SECONDS,
            check=False,
        )
    except subprocess.TimeoutExpired as error:
        return {
            "label": label,
            "command": command,
            "sandbox_backend": "bubblewrap",
            "network_isolated": True,
            "exit_code": None,
            "timed_out": True,
            "stdout_sha256": hashlib.sha256((error.stdout or b"") if isinstance(error.stdout, bytes) else (error.stdout or "").encode()).hexdigest(),
            "stderr_sha256": hashlib.sha256((error.stderr or b"") if isinstance(error.stderr, bytes) else (error.stderr or "").encode()).hexdigest(),
            "_stdout": "",
            "_stderr": "timed out",
        }
    return {
        "label": label,
        "command": command,
        "sandbox_backend": "bubblewrap",
        "network_isolated": True,
        "exit_code": result.returncode,
        "timed_out": False,
        "stdout_sha256": hashlib.sha256(result.stdout.encode()).hexdigest(),
        "stderr_sha256": hashlib.sha256(result.stderr.encode()).hexdigest(),
        "_stdout": result.stdout,
        "_stderr": result.stderr,
    }


def _public_step(step: dict) -> dict:
    return {key: value for key, value in step.items() if not key.startswith("_")}


def _install(
    checkout: Path,
    binary: Path,
    home: Path,
    temporary: Path,
    env: dict[str, str],
    state_root: Path,
) -> dict:
    install_script = checkout / "install"
    result = _run(
        ["bash", str(install_script), "--binary", str(binary), "--no-modify-path"],
        checkout,
        env,
        f"install:{binary.name}",
        source_checkout=checkout,
        state_root=state_root,
    )
    installed = home / ".opencode" / "bin" / CLI_COMMAND
    result["installed_path"] = str(installed)
    result["installed_sha256"] = _sha256(installed) if installed.is_file() else None
    result["expected_sha256"] = _sha256(binary)
    result["copied_exact_binary"] = result["installed_sha256"] == result["expected_sha256"]
    result["passed"] = result["exit_code"] == 0 and result["copied_exact_binary"]
    return result


def _invoke_installed(
    home: Path,
    args: list[str],
    env: dict[str, str],
    label: str,
    *,
    source_checkout: Path,
    state_root: Path,
    command: str = CLI_COMMAND,
) -> dict:
    binary = home / ".opencode" / "bin" / command
    if not binary.is_file():
        return {"label": label, "passed": False, "reason": "installed binary missing"}
    step = _run(
        [str(binary), *args],
        binary.parent,
        env,
        label,
        source_checkout=source_checkout,
        state_root=state_root,
    )
    step["passed"] = step["exit_code"] == 0 and not step["timed_out"]
    return step


def _direct_children(pid: int) -> list[int]:
    try:
        text = Path(f"/proc/{pid}/task/{pid}/children").read_text(encoding="utf-8")
    except OSError:
        return []
    return [int(part) for part in text.split() if part.isdigit()]


def _group_members(pgid: int) -> list[int]:
    members = []
    for entry in Path("/proc").iterdir():
        if not entry.name.isdigit():
            continue
        try:
            stat_text = (entry / "stat").read_text(encoding="utf-8")
        except OSError:
            continue
        after_comm = stat_text.rsplit(")", 1)[-1].split()
        if len(after_comm) < 3:
            continue
        state, _ppid, pgrp = after_comm[0], after_comm[1], after_comm[2]
        if state != "Z" and pgrp.isdigit() and int(pgrp) == pgid:
            members.append(int(entry.name))
    return members


def _tui_smoke(
    home: Path,
    env: dict[str, str],
    *,
    source_checkout: Path,
    state_root: Path,
) -> dict:
    binary = home / ".opencode" / "bin" / CLI_COMMAND
    if not binary.is_file():
        return {"status": "FAIL", "passed": False, "reason": "installed binary missing"}
    workspace = state_root / "tui" / "workspace"
    workspace.mkdir(parents=True, exist_ok=True, mode=0o700)
    tui_env = dict(env)
    tui_env.update({"TERM": "xterm-256color", "COLUMNS": "80", "LINES": "24"})
    command, sandbox_environment = _sandbox_command(
        [str(binary), "--mini", "--no-replay"],
        cwd=workspace,
        source_checkout=source_checkout,
        state_root=state_root,
        environment=tui_env,
    )
    master_fd, slave_fd = pty.openpty()
    tty_detected = os.isatty(slave_fd)
    process = None
    output_hash = hashlib.sha256()
    output_bytes = 0
    output_limit_exceeded = False
    startup_complete = False
    timed_out = False
    exit_code = None
    try:
        process = subprocess.Popen(
            command,
            cwd="/",
            env=sandbox_environment,
            stdin=slave_fd,
            stdout=slave_fd,
            stderr=slave_fd,
            close_fds=True,
            start_new_session=True,
        )
        os.close(slave_fd)
        slave_fd = -1
        deadline = time.monotonic() + TUI_STARTUP_SECONDS
        while time.monotonic() < deadline:
            if process.poll() is not None:
                break
            ready, _, _ = select.select([master_fd], [], [], min(0.1, max(0.0, deadline - time.monotonic())))
            if ready:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output_bytes += len(chunk)
                if output_bytes <= TUI_OUTPUT_LIMIT_BYTES:
                    output_hash.update(chunk)
                else:
                    output_limit_exceeded = True
                    break
        startup_complete = process.poll() is None
        locate_failed = False
        shutdown_performed = False
        if startup_complete and not output_limit_exceeded:
            # Signal only the sandboxed app (the direct bubblewrap child), not
            # the process group: bubblewrap itself dies on SIGINT and its
            # --die-with-parent PDEATHSIG would then mask the app's own
            # shutdown behavior. Bubblewrap stays alive as the observer and
            # propagates the app's exit status.
            app_pids: list[int] = []
            if process.poll() is None:
                for _ in range(10):
                    app_pids = _direct_children(process.pid)
                    if app_pids:
                        break
                    time.sleep(0.1)
                    if process.poll() is not None:
                        break
            if process.poll() is None:
                if not app_pids:
                    locate_failed = True
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    try:
                        process.wait(timeout=1.0)
                    except subprocess.TimeoutExpired:
                        timed_out = True
                else:
                    shutdown_performed = True
                    for pid in app_pids:
                        try:
                            os.kill(pid, signal.SIGINT)
                        except ProcessLookupError:
                            pass
            if process.poll() is None:
                shutdown_deadline = time.monotonic() + TUI_SHUTDOWN_SECONDS
                while time.monotonic() < shutdown_deadline and process.poll() is None:
                    ready, _, _ = select.select([master_fd], [], [], min(0.1, max(0.0, shutdown_deadline - time.monotonic())))
                    if ready:
                        try:
                            chunk = os.read(master_fd, 65536)
                        except OSError:
                            chunk = b""
                        if chunk:
                            output_bytes += len(chunk)
                            if output_bytes <= TUI_OUTPUT_LIMIT_BYTES:
                                output_hash.update(chunk)
                            else:
                                output_limit_exceeded = True
                                break
                if process.poll() is None:
                    timed_out = True
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
            try:
                exit_code = process.wait(timeout=1.0)
            except subprocess.TimeoutExpired:
                timed_out = True
        else:
            if process.poll() is None:
                try:
                    os.killpg(process.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                try:
                    process.wait(timeout=1.0)
                except subprocess.TimeoutExpired:
                    timed_out = True
            exit_code = process.poll()
        leftover_processes = _group_members(process.pid)
        if leftover_processes:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
    except (OSError, subprocess.SubprocessError) as error:
        return {
            "status": "FAIL",
            "passed": False,
            "reason": f"PTY launch failed: {error}",
            "sandbox_backend": "bubblewrap",
            "network_isolated": True,
        }
    finally:
        if slave_fd >= 0:
            os.close(slave_fd)
        os.close(master_fd)

    clean_exit_codes = {0, 130, -signal.SIGINT}
    passed = (
        startup_complete
        and tty_detected
        and output_bytes > 0
        and not output_limit_exceeded
        and not timed_out
        and not locate_failed
        and not leftover_processes
        and exit_code in clean_exit_codes
    )
    reason = None
    if not startup_complete:
        reason = "process exited before the interactive startup window completed"
    elif not tty_detected or output_bytes == 0:
        reason = "interactive launch did not establish a visible terminal session"
    elif output_limit_exceeded:
        reason = f"terminal output exceeded the {TUI_OUTPUT_LIMIT_BYTES}-byte bound"
    elif locate_failed:
        reason = "sandboxed interactive process could not be located for the shutdown signal"
    elif timed_out or exit_code not in clean_exit_codes:
        reason = "interactive process did not shut down cleanly within the bounded signal window"
    elif leftover_processes:
        reason = "interactive process left background descendants running after the shutdown signal"
    return {
        "status": "PASS" if passed else "FAIL",
        "passed": passed,
        "reason": reason,
        "command": [str(binary), "--mini", "--no-replay"],
        "tty_detected": tty_detected,
        "startup_window_seconds": TUI_STARTUP_SECONDS,
        "startup_completed": startup_complete,
        "startup_output_bytes": output_bytes,
        "startup_output_sha256": output_hash.hexdigest(),
        "output_limit_bytes": TUI_OUTPUT_LIMIT_BYTES,
        "output_limit_exceeded": output_limit_exceeded,
        "shutdown_signal": "SIGINT",
        "shutdown_window_seconds": TUI_SHUTDOWN_SECONDS,
        "shutdown_signal_target": "sandboxed-process" if shutdown_performed else "not-sent",
        "exit_code": exit_code,
        "timed_out": timed_out,
        "leftover_processes": leftover_processes,
        "sandbox_backend": "bubblewrap",
        "network_isolated": True,
    }


def _seed_legacy_config(fixture: Path, home: Path) -> Path:
    config_dir = home / ".config" / "opencode"
    config_dir.mkdir(parents=True, exist_ok=True, mode=0o700)
    legacy_path = config_dir / "config"
    shutil.copyfile(fixture, legacy_path)
    return legacy_path


def _assert_config_migration(home: Path, step: dict, expected_model: str) -> tuple[bool, str]:
    config_dir = home / ".config" / "opencode"
    legacy = config_dir / "config"
    current = config_dir / "config.json"
    try:
        decoded = json.loads(step.get("_stdout", ""))
        saved = json.loads(current.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return False, "debug config did not return valid JSON or write config.json"
    passed = (
        step.get("passed") is True
        and not legacy.exists()
        and current.is_file()
        and decoded.get("model") == expected_model
        and saved.get("model") == expected_model
    )
    return passed, "legacy file removed and expected model persisted" if passed else "legacy config migration did not match expected state"


def _migration_command(
    home: Path,
    env: dict[str, str],
    label: str,
    expected_model: str,
    *,
    source_checkout: Path,
    state_root: Path,
) -> tuple[dict, bool, str]:
    step = _invoke_installed(
        home,
        ["debug", "config"],
        env,
        label,
        source_checkout=source_checkout,
        state_root=state_root,
    )
    passed, reason = _assert_config_migration(home, step, expected_model)
    step["passed"] = passed
    step["migration_check"] = reason
    return step, passed, reason


def run_matrix(
    *,
    checkout: Path,
    candidate_binary: Path,
    previous_binary: Path | None,
    migration_fixture: Path | None,
    expected_model: str | None,
    state_root: Path,
    require_clean_checkout: bool = True,
) -> dict:
    if not sys.platform.startswith("linux"):
        raise ValueError("the release install matrix currently runs only on Linux/WSL")
    checkout = checkout.resolve()
    if not checkout.is_dir():
        raise ValueError(f"separate source checkout does not exist: {checkout}")
    install_script = checkout / "install"
    if install_script.is_symlink() or not install_script.is_file():
        raise ValueError(f"separate checkout must contain a regular local install script: {install_script}")
    checkout_state = _checkout_facts(checkout)
    if require_clean_checkout and (not checkout_state["clean"] or checkout_state["status"] != "CLEAN"):
        raise ValueError(f"release matrix requires a clean Git checkout; observed {checkout_state['status']}")
    candidate = _require_regular_executable(candidate_binary, checkout, "candidate binary")
    previous = _require_regular_executable(previous_binary, checkout, "previous binary") if previous_binary else None
    fixture = migration_fixture.resolve() if migration_fixture else None
    if migration_fixture and (migration_fixture.is_symlink() or not migration_fixture.is_file()):
        raise ValueError(f"migration fixture must be a regular file: {migration_fixture}")
    fixture = migration_fixture.absolute() if migration_fixture else None
    if (fixture is None) != (expected_model is None):
        raise ValueError("migration fixture and expected model must be supplied together")
    if previous and candidate == previous:
        raise ValueError("previous and candidate artifacts must be different files")
    state_root = _validated_state_root(state_root)
    if _inside(checkout, state_root) or _inside(state_root, checkout):
        raise ValueError("source checkout and evidence root must be separate, non-overlapping directories")
    sandbox_facts = _sandbox_preflight()
    state_root.mkdir(mode=0o700)

    report = {
        "schema_version": 1,
        "status": "BLOCKED",
        "platform": {
            "system": "Linux",
            "kernel": os.uname().release,
            "wsl": "microsoft" in Path("/proc/version").read_text(encoding="utf-8", errors="replace").lower(),
            "host_kind": (
                "WSL2"
                if "microsoft" in Path("/proc/version").read_text(encoding="utf-8", errors="replace").lower()
                and "wsl2" in os.uname().release.lower()
                else "WSL"
                if "microsoft" in Path("/proc/version").read_text(encoding="utf-8", errors="replace").lower()
                else "Linux"
            ),
            "architecture": os.uname().machine,
        },
        "source_checkout": checkout_state,
        "artifacts": {
            "candidate": {"path": str(candidate), "sha256": _sha256(candidate)},
            "previous": {"path": str(previous), "sha256": _sha256(previous)} if previous else None,
        },
        "evidence_root": str(state_root),
        "scenarios": {
            "clean_install": {"status": "NOT_RUN"},
            "tui_launch": {"status": "NOT_RUN"},
            "upgrade": {"status": "NOT_RUN"},
            "migration": {"status": "NOT_RUN"},
            "rollback": {"status": "NOT_RUN"},
        },
        "network_isolation": sandbox_facts,
        "isolation": {
            "sandbox_filesystem": sandbox_facts["filesystem"],
            "host_home_mounted": sandbox_facts["host_home_mounted"],
            "host_tmp_mounted": sandbox_facts["host_tmp_mounted"],
        },
        "limitations": [
            "This exercises the checkout's local --binary install path; it does not test network downloads, package publication, signing, or an automatic updater.",
            "Bubblewrap unshares networking and exposes only read-only system/source mounts plus task-owned evidence state; this does not qualify a product-provided OS sandbox.",
            "A passed harness scenario exercises only the supplied artifact; synthetic binaries are harness tests and do not establish product install evidence.",
            "All user state is disposable test state under evidence_root; this is not a native Windows or macOS test.",
        ],
    }

    all_passed = True
    profiles_unchanged = True
    clean_home = state_root / "clean" / "home"
    clean_temp = state_root / "clean"
    clean_env = _safe_environment(clean_home, clean_temp)
    before_profiles = _profile_hashes(clean_home)
    installed = _install(checkout, candidate, clean_home, clean_temp, clean_env, state_root)
    version = _invoke_installed(
        clean_home,
        ["--version"],
        clean_env,
        "clean-install:version",
        source_checkout=checkout,
        state_root=state_root,
    )
    help_result = _invoke_installed(
        clean_home,
        ["--help"],
        clean_env,
        "clean-install:help",
        source_checkout=checkout,
        state_root=state_root,
    )
    alias_binary = clean_home / ".opencode" / "bin" / CLI_ALIAS
    alias_result = (
        _invoke_installed(
            clean_home,
            ["--version"],
            clean_env,
            "clean-install:alias-version",
            source_checkout=checkout,
            state_root=state_root,
            command=CLI_ALIAS,
        )
        if alias_binary.exists()
        else {"label": "clean-install:alias-version", "passed": False, "reason": f"installed {CLI_ALIAS} command missing"}
    )
    tui_result = _tui_smoke(clean_home, clean_env, source_checkout=checkout, state_root=state_root)
    after_profiles = _profile_hashes(clean_home)
    profiles_unchanged &= before_profiles == after_profiles
    clean_passed = (
        installed["passed"]
        and version["passed"]
        and help_result["passed"]
        and alias_result["passed"]
        and tui_result["passed"]
        and profiles_unchanged
    )
    report["scenarios"]["clean_install"] = {
        "status": "PASS" if clean_passed else "FAIL",
        "install": _public_step(installed),
        "version": {**_public_step(version), "reported_version": version.get("_stdout", "").strip()},
        "help": _public_step(help_result),
        "alias_version": _public_step(alias_result),
        "shell_profiles_unchanged": before_profiles == after_profiles,
    }
    report["scenarios"]["tui_launch"] = tui_result
    report["isolation"]["clean_home"] = str(clean_home)
    report["isolation"]["clean_config_root"] = clean_env["XDG_CONFIG_HOME"]
    all_passed &= clean_passed

    if previous is None:
        report["scenarios"]["upgrade"]["reason"] = "previous release binary not supplied"
        report["scenarios"]["migration"]["reason"] = "not run without a previous binary and migration fixture"
        report["scenarios"]["rollback"]["reason"] = "not run without a previous release binary"
    else:
        upgrade_home = state_root / "upgrade" / "home"
        upgrade_temp = state_root / "upgrade"
        upgrade_env = _safe_environment(upgrade_home, upgrade_temp)
        config_root = upgrade_home / ".config" / "opencode"
        snapshot = state_root / "upgrade" / "pre-migration-config"
        migration_evidence_supplied = fixture is not None and expected_model is not None
        if migration_evidence_supplied:
            _seed_legacy_config(fixture, upgrade_home)
            shutil.copytree(config_root, snapshot)
            before_profiles = _profile_hashes(upgrade_home)

        install_previous = _install(checkout, previous, upgrade_home, upgrade_temp, upgrade_env, state_root)
        old_version_before = _invoke_installed(
            upgrade_home,
            ["--version"],
            upgrade_env,
            "upgrade:previous-version",
            source_checkout=checkout,
            state_root=state_root,
        )
        install_candidate = _install(checkout, candidate, upgrade_home, upgrade_temp, upgrade_env, state_root)
        candidate_version = _invoke_installed(
            upgrade_home,
            ["--version"],
            upgrade_env,
            "upgrade:candidate-version",
            source_checkout=checkout,
            state_root=state_root,
        )

        upgrade_passed = (
            install_previous["passed"]
            and old_version_before["passed"]
            and install_candidate["passed"]
            and candidate_version["passed"]
            and bool(old_version_before.get("_stdout", "").strip())
            and bool(candidate_version.get("_stdout", "").strip())
            and old_version_before.get("_stdout", "").strip() != candidate_version.get("_stdout", "").strip()
        )
        report["scenarios"]["upgrade"] = {
            "status": "PASS" if upgrade_passed else "FAIL",
            "previous_version": old_version_before.get("_stdout", "").strip(),
            "candidate_version": candidate_version.get("_stdout", "").strip(),
            "previous_install": _public_step(install_previous),
            "candidate_install": _public_step(install_candidate),
            "previous_binary_was_replaced": install_candidate["copied_exact_binary"],
        }
        report["isolation"]["upgrade_home"] = str(upgrade_home)
        report["isolation"]["config_root"] = str(upgrade_home / ".config")
        all_passed &= upgrade_passed

        if not migration_evidence_supplied:
            report["scenarios"]["migration"]["reason"] = "migration fixture and expected model not supplied"
            report["scenarios"]["rollback"]["reason"] = "not run without migration fixture/expected value"
        else:
            migration_step, migration_passed, migration_reason = _migration_command(
                upgrade_home,
                upgrade_env,
                "migration:candidate-debug-config",
                expected_model,
                source_checkout=checkout,
                state_root=state_root,
            )
            report["scenarios"]["migration"] = {
                "status": "PASS" if migration_passed else "FAIL",
                "command": _public_step(migration_step),
                "reason": migration_reason,
                "legacy_config_backup": str(snapshot),
                "legacy_config_backup_sha256": _sha256(snapshot / "config"),
            }

            # A manual rollback rehearsal: reinstall the previous binary against the
            # migrated state, then restore the pre-migration snapshot in a new path.
            rollback_install = _install(checkout, previous, upgrade_home, upgrade_temp, upgrade_env, state_root)
            backward_compatibility, backward_ok, backward_reason = _migration_command(
                upgrade_home,
                upgrade_env,
                "rollback:previous-on-migrated-config",
                expected_model,
                source_checkout=checkout,
                state_root=state_root,
            )
            migrated_home = state_root / "upgrade" / "candidate-migrated-config"
            shutil.move(str(config_root), str(migrated_home))
            shutil.copytree(snapshot, config_root)
            restored_state, restored_ok, restored_reason = _migration_command(
                upgrade_home,
                upgrade_env,
                "rollback:previous-on-restored-config",
                expected_model,
                source_checkout=checkout,
                state_root=state_root,
            )
            after_profiles = _profile_hashes(upgrade_home)
            profiles_unchanged &= before_profiles == after_profiles
            rollback_passed = rollback_install["passed"] and backward_ok and restored_ok and profiles_unchanged
            report["scenarios"]["rollback"] = {
                "status": "PASS" if rollback_passed else "FAIL",
                "mode": "manual previous-binary reinstall plus pre-migration config snapshot restore",
                "previous_binary_reinstall": _public_step(rollback_install),
                "backward_compatibility": {"command": _public_step(backward_compatibility), "reason": backward_reason},
                "restored_snapshot": {"command": _public_step(restored_state), "reason": restored_reason},
                "shell_profiles_unchanged": before_profiles == after_profiles,
            }
            all_passed &= migration_passed and rollback_passed

    scenario_statuses = [item["status"] for item in report["scenarios"].values()]
    if any(status == "FAIL" for status in scenario_statuses):
        report["status"] = "FAIL"
    elif all_passed and all(status == "PASS" for status in scenario_statuses):
        report["status"] = "PASS"
    else:
        report["status"] = "PARTIAL"
    report["isolation"]["shell_profiles_unchanged"] = profiles_unchanged
    report["isolation"]["credential_environment_inherited"] = False
    report["isolation"]["state_is_under_approved_temp_root"] = _inside(state_root, APPROVED_TEMP_ROOT)
    report_path = state_root / "report.json"
    report_path.write_text(json.dumps(report, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path, help="separate, clean source checkout containing install")
    parser.add_argument("--candidate-binary", required=True, type=Path, help="built candidate binary inside --checkout")
    parser.add_argument("--previous-binary", type=Path, help="previous release binary inside --checkout; enables upgrade/rollback")
    parser.add_argument("--migration-fixture", type=Path, help="legacy TOML config fixture; runs `debug config` in isolated state")
    parser.add_argument("--expected-model", help="model value expected after config migration")
    parser.add_argument("--state-root", type=Path, help="new evidence directory under /tmp/opencode; never reused/deleted")
    args = parser.parse_args()
    state_root = args.state_root or (APPROVED_TEMP_ROOT / f"horizoncode-p9-{uuid.uuid4().hex}")
    try:
        report = run_matrix(
            checkout=args.checkout,
            candidate_binary=args.candidate_binary,
            previous_binary=args.previous_binary,
            migration_fixture=args.migration_fixture,
            expected_model=args.expected_model,
            state_root=state_root,
        )
    except (OSError, ValueError) as error:
        print(f"release install matrix blocked: {error}", file=sys.stderr)
        return 3
    print(
        f"release install matrix: {report['status']}; evidence={report['evidence_root']}; "
        f"checkout={report['source_checkout'].get('revision') or 'unknown'}"
    )
    return {"PASS": 0, "PARTIAL": 2, "FAIL": 1}.get(report["status"], 3)


if __name__ == "__main__":
    raise SystemExit(main())
