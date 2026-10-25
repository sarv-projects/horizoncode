#!/usr/bin/env python3
"""Run a Linux/WSL install, upgrade, migration, and binary rollback matrix.

The runner accepts artifacts from a separate clean checkout, installs only via
that checkout's local ``install --binary`` path, and keeps every home/config/
data/cache file beneath a new task-owned directory under the repository's
ignored ``kernel/target/horizoncode-release`` subtree. It does
not download, publish, change shell profiles, or delete its evidence directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import pty
import secrets
import select
import signal
import shutil
import stat
import subprocess
import sys
import tempfile
import time
import uuid


REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
APPROVED_TEMP_ROOT = REPOSITORY_ROOT / "kernel" / "target" / "horizoncode-release"
CLI_COMMAND = "horizoncode"
CLI_ALIAS = "hzcode"
TIMEOUT_SECONDS = 45
SANDBOX_STARTUP_TIMEOUT_SECONDS = 10
# Cold, network-isolated launches of a full CLI can take several seconds before
# the first terminal frame. Bound the wait, then drain a short settle window.
TUI_STARTUP_SECONDS = 10.0
TUI_FRAME_SETTLE_SECONDS = 1.0
# The shutdown window applies to the sandboxed app's own SIGINT handling. Under
# CPU oversubscription a clean shutdown was observed to take >3s (P9 evidence,
# 2026-10-17), so the window is bounded but generous; the observed exit code,
# not the latency, decides pass/fail.
TUI_SHUTDOWN_SECONDS = 10.0
TUI_OUTPUT_LIMIT_BYTES = 1024 * 1024
CONTAINER_CHECKOUT = Path("/workspace")
CONTAINER_EVIDENCE = Path("/evidence")


def _sha256(path: Path) -> str:
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    digest = hashlib.sha256()
    with os.fdopen(descriptor, "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError(f"artifact digest input must be a regular non-symlink file: {path}")
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _reject_symlink_components(path: Path, root: Path, label: str) -> None:
    """Check lexical components before resolving paths that may escape root."""
    cursor = path
    while _inside(cursor, root):
        if cursor.is_symlink():
            raise ValueError(f"{label} path contains a symlink: {cursor}")
        if cursor == root:
            return
        cursor = cursor.parent
    raise ValueError(f"{label} path is not inside its approved root: {path}")


def _ensure_approved_temp_root() -> Path:
    """Create/check the private, ignored task artifact root inside this checkout."""
    repository_path = Path(__file__).absolute().parents[2]
    if repository_path != REPOSITORY_ROOT or repository_path.is_symlink() or not repository_path.is_dir():
        raise ValueError("release repository root must be a real, non-symlink directory")
    if repository_path.resolve(strict=True) != REPOSITORY_ROOT:
        raise ValueError("release repository root resolves through a symlink")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("repository-local release artifacts require Linux no-follow directory descriptors")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    opened: list[int] = []
    components = ("kernel", "target", "horizoncode-release")
    try:
        current_fd = os.open(REPOSITORY_ROOT, directory_flags)
        opened.append(current_fd)
        repository_info = os.fstat(current_fd)
        if repository_info.st_uid != os.getuid() or repository_info.st_mode & 0o022:
            raise ValueError("release repository root must be user-owned and not group/world-writable")

        for index, component in enumerate(components):
            try:
                next_fd = os.open(component, directory_flags, dir_fd=current_fd)
            except FileNotFoundError:
                os.mkdir(component, 0o700, dir_fd=current_fd)
                next_fd = os.open(component, directory_flags, dir_fd=current_fd)
            opened.append(next_fd)
            metadata = os.fstat(next_fd)
            if metadata.st_uid != os.getuid() or metadata.st_mode & (0o077 if index == len(components) - 1 else 0o022):
                raise ValueError(f"approved task artifact path component has unsafe ownership or permissions: {component}")
            current_fd = next_fd
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)
    return APPROVED_TEMP_ROOT


def _require_regular_executable(path: Path, checkout: Path, label: str) -> Path:
    requested = Path(os.path.abspath(path))
    if path.is_symlink() or not requested.is_file() or not os.access(requested, os.X_OK):
        raise ValueError(f"{label} must be a regular executable file: {path}")
    if not _inside(requested, checkout):
        raise ValueError(f"{label} must be inside the separate checkout: {path}")
    _reject_symlink_components(requested, checkout, label)
    resolved = path.resolve()
    if not _inside(resolved, checkout):
        raise ValueError(f"{label} must be inside the separate checkout: {path}")
    if not resolved.is_file() or not os.access(resolved, os.X_OK):
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
    base = _ensure_approved_temp_root()
    resolved_base = base
    requested = Path(os.path.abspath(state_root))
    if not _inside(requested, resolved_base) or requested == resolved_base:
        raise ValueError(f"test state directory must be a new child of {resolved_base}: {requested}")
    _reject_symlink_components(requested, resolved_base, "test state")
    if requested.exists() or requested.is_symlink():
        raise ValueError(f"test state directory already exists; refusing to reuse it: {requested}")
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


def _create_state_root(state_root: Path) -> None:
    """Create the validated fresh evidence directory beneath a pinned root."""
    base = _ensure_approved_temp_root()
    requested = Path(os.path.abspath(state_root))
    if requested == base or not _inside(requested, base):
        raise ValueError(f"test state directory must be a new child of {base}: {state_root}")
    _reject_symlink_components(requested, base, "test state")
    relative = requested.relative_to(base)
    if not relative.parts or not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("test state creation requires Linux no-follow directory descriptors")
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    opened: list[int] = []
    try:
        parent_fd = os.open(base, flags)
        opened.append(parent_fd)
        for component in relative.parts[:-1]:
            parent_fd = os.open(component, flags, dir_fd=parent_fd)
            opened.append(parent_fd)
            metadata = os.fstat(parent_fd)
            if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
                raise ValueError(f"test state parent is not safely owned: {component}")
        metadata = os.fstat(parent_fd)
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ValueError("test state parent is not safely owned")
        os.mkdir(relative.name, 0o700, dir_fd=parent_fd)
        state_fd = os.open(relative.name, flags, dir_fd=parent_fd)
        opened.append(state_fd)
        state_metadata = os.fstat(state_fd)
        if state_metadata.st_uid != os.getuid() or state_metadata.st_mode & 0o077:
            raise ValueError("new test state directory is not private and user-owned")
        os.fsync(parent_fd)
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


def _validated_output_path(output_path: Path) -> Path:
    """Require a new evidence file under the repository-local artifact root."""
    base = _ensure_approved_temp_root()
    requested = Path(os.path.abspath(output_path))
    if requested == base or not _inside(requested, base):
        raise ValueError(f"release evidence output must be a new file under {base}: {output_path}")
    _reject_symlink_components(requested, base, "release evidence output")
    if requested.exists() or requested.is_symlink():
        raise ValueError(f"release evidence output already exists; refusing to replace it: {requested}")
    if not requested.parent.is_dir():
        raise ValueError(f"release evidence output parent must already exist: {requested.parent}")
    cursor = requested.parent
    while _inside(cursor, base):
        if cursor.is_symlink():
            raise ValueError(f"release evidence output path contains a symlinked parent: {cursor}")
        metadata = cursor.stat(follow_symlinks=False)
        if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
            raise ValueError(f"release evidence output parent must be user-owned and private: {cursor}")
        if cursor == base:
            break
        cursor = cursor.parent
    return requested


def _write_new_artifact_file(
    path: Path,
    content: str,
    *,
    root: Path = APPROVED_TEMP_ROOT,
    mode: int = 0o600,
) -> None:
    """Atomically create a new private artifact file beneath a pinned directory."""
    base = _ensure_approved_temp_root()
    requested = Path(os.path.abspath(path))
    if requested == base or not _inside(requested, base):
        raise ValueError(f"artifact file must be a new child of {base}: {path}")
    _reject_symlink_components(requested, base, "artifact file")

    root_path = Path(os.path.abspath(root))
    if root_path != base:
        raise ValueError(f"artifact writer root must be the approved repository artifact root: {root}")
    relative = requested.relative_to(base)
    if not relative.parts or relative.name in {"", ".", ".."}:
        raise ValueError(f"artifact output must have a regular filename: {requested}")
    if mode & 0o022 or mode & ~0o777:
        raise ValueError("artifact output mode must not be group/world-writable or include special bits")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY"):
        raise ValueError("atomic repository-local artifact writing requires Linux no-follow directory descriptors")

    directory_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    opened: list[int] = []
    temporary_name = f".{relative.name}.p9-{secrets.token_hex(12)}.tmp"
    temporary_created = False
    try:
        directory_fd = os.open(base, directory_flags)
        opened.append(directory_fd)
        base_stat = os.fstat(directory_fd)
        if base_stat.st_uid != os.getuid() or base_stat.st_mode & 0o077:
            raise ValueError(f"artifact root must be user-owned and private: {base}")
        for component in relative.parts[:-1]:
            directory_fd = os.open(component, directory_flags, dir_fd=directory_fd)
            opened.append(directory_fd)
            metadata = os.fstat(directory_fd)
            if metadata.st_uid != os.getuid() or metadata.st_mode & 0o022:
                raise ValueError(f"artifact parent must be user-owned and not group/world-writable: {component}")

        file_fd = os.open(
            temporary_name,
            os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
            mode,
            dir_fd=directory_fd,
        )
        temporary_created = True
        with os.fdopen(file_fd, "wb") as output:
            os.fchmod(output.fileno(), mode)
            output.write(content.encode("utf-8"))
            output.flush()
            os.fsync(output.fileno())
        os.link(
            temporary_name,
            relative.name,
            src_dir_fd=directory_fd,
            dst_dir_fd=directory_fd,
            follow_symlinks=False,
        )
        os.unlink(temporary_name, dir_fd=directory_fd)
        os.fsync(directory_fd)
    except BaseException:
        if opened and temporary_created:
            try:
                os.unlink(temporary_name, dir_fd=opened[-1])
            except OSError:
                pass
        raise
    finally:
        for descriptor in reversed(opened):
            os.close(descriptor)


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
    expected_sha256: str,
) -> dict:
    # Pin every install/upgrade step to the digest captured when the matrix
    # started. Re-reading the source path alone would let an artifact replaced
    # between scenarios silently become the reported candidate.
    source_sha256 = _sha256(binary)
    if source_sha256 != expected_sha256:
        return {
            "label": f"install:{binary.name}",
            "passed": False,
            "reason": "binary digest changed after the release matrix pinned the artifact",
            "source_sha256": source_sha256,
            "expected_sha256": expected_sha256,
            "installed_path": str(home / ".opencode" / "bin" / CLI_COMMAND),
            "installed_sha256": None,
            "copied_exact_binary": False,
        }
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
    result["source_sha256_after"] = _sha256(binary)
    result["expected_sha256"] = expected_sha256
    result["copied_exact_binary"] = (
        result["installed_sha256"] == expected_sha256
        and result["source_sha256_after"] == expected_sha256
    )
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
    # The process group was created by this task-owned Popen(start_new_session=True).
    # Probe only that group instead of enumerating unrelated host processes.
    try:
        os.killpg(pgid, 0)
    except ProcessLookupError:
        return []
    except PermissionError:
        return [pgid]
    return [pgid]


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
        first_frame_at: float | None = None
        while True:
            now = time.monotonic()
            if process.poll() is not None:
                break
            window_end = deadline if first_frame_at is None else min(deadline, first_frame_at + TUI_FRAME_SETTLE_SECONDS)
            if now >= window_end:
                break
            ready, _, _ = select.select([master_fd], [], [], min(0.1, max(0.0, window_end - now)))
            if ready:
                try:
                    chunk = os.read(master_fd, 65536)
                except OSError:
                    break
                if not chunk:
                    break
                output_bytes += len(chunk)
                if output_bytes > TUI_OUTPUT_LIMIT_BYTES:
                    output_limit_exceeded = True
                    break
                output_hash.update(chunk)
                if first_frame_at is None:
                    # First terminal bytes prove the interactive surface is
                    # painting. Keep draining for a short settle window so the
                    # app can finish initializing before the shutdown signal.
                    first_frame_at = time.monotonic()
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
        # SIGKILL delivery is asynchronous. Give the kernel a bounded window to
        # reap a killed group before treating a member as a leaked descendant.
        reap_deadline = time.monotonic() + 2.0
        while leftover_processes and time.monotonic() < reap_deadline:
            time.sleep(0.05)
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
        "first_frame_settle_seconds": TUI_FRAME_SETTLE_SECONDS,
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
    dry_run: bool = False,
) -> dict:
    if not sys.platform.startswith("linux"):
        raise ValueError("the release install matrix currently runs only on Linux/WSL")
    requested_checkout = Path(os.path.abspath(checkout))
    if not _inside(requested_checkout, REPOSITORY_ROOT):
        raise ValueError(f"release checkout must be inside this repository: {checkout}")
    _reject_symlink_components(requested_checkout, REPOSITORY_ROOT, "release checkout")
    checkout = checkout.resolve()
    if not _inside(checkout, REPOSITORY_ROOT):
        raise ValueError(f"resolved release checkout escapes this repository: {checkout}")
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
    candidate_sha256 = _sha256(candidate)
    previous_sha256 = _sha256(previous) if previous else None
    if candidate_sha256 is None or (previous is not None and previous_sha256 is None):
        raise ValueError("candidate and previous artifacts must be readable regular files")
    if previous is not None:
        assert previous_sha256 is not None
    if migration_fixture is not None:
        requested_fixture = Path(os.path.abspath(migration_fixture))
        if migration_fixture.is_symlink() or not migration_fixture.is_file():
            raise ValueError(f"migration fixture must be a regular file: {migration_fixture}")
        if not _inside(requested_fixture, checkout):
            raise ValueError("migration fixture must be inside the repository-local candidate checkout")
        _reject_symlink_components(requested_fixture, checkout, "migration fixture")
    fixture = migration_fixture.resolve() if migration_fixture else None
    if fixture is not None and not _inside(fixture, checkout):
        raise ValueError("resolved migration fixture escapes the repository-local candidate checkout")
    fixture = migration_fixture.absolute() if migration_fixture else None
    if (fixture is None) != (expected_model is None):
        raise ValueError("migration fixture and expected model must be supplied together")
    if previous and candidate == previous:
        raise ValueError("previous and candidate artifacts must be different files")
    state_root = _validated_state_root(state_root)
    if not dry_run and (_inside(checkout, state_root) or _inside(state_root, checkout)):
        raise ValueError("source checkout and evidence root must be separate, non-overlapping directories")
    sandbox_facts = _sandbox_preflight()
    kernel_release = os.uname().release.lower()
    wsl_hint = bool(os.environ.get("WSL_INTEROP") or os.environ.get("WSL_DISTRO_NAME"))
    wsl = "microsoft" in kernel_release or wsl_hint
    host_kind = "WSL2" if "microsoft" in kernel_release and "wsl2" in kernel_release else "WSL" if wsl else "Linux"

    report = {
        "schema_version": 1,
        "status": "BLOCKED",
        "platform": {
            "system": "Linux",
            "kernel": os.uname().release,
            "wsl": wsl,
            "host_kind": host_kind,
            "architecture": os.uname().machine,
        },
        "source_checkout": checkout_state,
        "artifacts": {
            "candidate": {"path": str(candidate), "sha256": candidate_sha256},
            "previous": {"path": str(previous), "sha256": previous_sha256} if previous else None,
        },
        "evidence_root": str(state_root),
        "scenarios": {
            "clean_install": {"status": "NOT_RUN"},
            "tui_launch": {"status": "NOT_RUN"},
            "upgrade": {"status": "NOT_RUN"},
            "migration": {"status": "NOT_RUN"},
            "rollback": {"status": "NOT_RUN"},
            "artifact_integrity": {"status": "NOT_RUN"},
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

    if dry_run:
        report["status"] = "DRY_RUN"
        report["dry_run"] = True
        report["planned_scenarios"] = [
            "clean_install",
            "tui_launch",
            "upgrade" if previous is not None else "upgrade:not-run",
            "migration" if fixture is not None else "migration:not-run",
            "rollback" if fixture is not None and previous is not None else "rollback:not-run",
            "artifact_integrity",
        ]
        report["limitations"].append("Dry run validates inputs and isolation only; it executes no installer or product binary.")
        return report

    _create_state_root(state_root)
    all_passed = True
    profiles_unchanged = True
    clean_home = state_root / "clean" / "home"
    clean_temp = state_root / "clean"
    clean_env = _safe_environment(clean_home, clean_temp)
    before_profiles = _profile_hashes(clean_home)
    installed = _install(
        checkout, candidate, clean_home, clean_temp, clean_env, state_root,
        expected_sha256=candidate_sha256,
    )
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

        install_previous = _install(
            checkout, previous, upgrade_home, upgrade_temp, upgrade_env, state_root,
            expected_sha256=previous_sha256,
        )
        old_version_before = _invoke_installed(
            upgrade_home,
            ["--version"],
            upgrade_env,
            "upgrade:previous-version",
            source_checkout=checkout,
            state_root=state_root,
        )
        install_candidate = _install(
            checkout, candidate, upgrade_home, upgrade_temp, upgrade_env, state_root,
            expected_sha256=candidate_sha256,
        )
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
            rollback_install = _install(
                checkout, previous, upgrade_home, upgrade_temp, upgrade_env, state_root,
                expected_sha256=previous_sha256,
            )
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

    final_candidate_sha256 = _sha256(candidate)
    final_previous_sha256 = _sha256(previous) if previous else None
    artifact_integrity_passed = (
        final_candidate_sha256 == candidate_sha256
        and (previous is None or final_previous_sha256 == previous_sha256)
    )
    report["scenarios"]["artifact_integrity"] = {
        "status": "PASS" if artifact_integrity_passed else "FAIL",
        "candidate_expected_sha256": candidate_sha256,
        "candidate_observed_sha256": final_candidate_sha256,
        "previous_expected_sha256": previous_sha256,
        "previous_observed_sha256": final_previous_sha256,
        "passed": artifact_integrity_passed,
    }
    all_passed &= artifact_integrity_passed
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
    _write_new_artifact_file(report_path, json.dumps(report, indent=2, sort_keys=True) + "\n")
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--checkout", required=True, type=Path, help="separate, clean source checkout containing install")
    parser.add_argument("--candidate-binary", required=True, type=Path, help="built candidate binary inside --checkout")
    parser.add_argument("--previous-binary", type=Path, help="previous release binary inside --checkout; enables upgrade/rollback")
    parser.add_argument("--migration-fixture", type=Path, help="legacy TOML config fixture; runs `debug config` in isolated state")
    parser.add_argument("--expected-model", help="model value expected after config migration")
    parser.add_argument("--state-root", type=Path, help="new evidence directory under kernel/target/horizoncode-release; never reused/deleted")
    parser.add_argument("--dry-run", action="store_true", help="validate checkout, artifacts, and isolation without creating state or executing the installer")
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
            dry_run=args.dry_run,
        )
    except (OSError, ValueError) as error:
        print(f"release install matrix blocked: {error}", file=sys.stderr)
        return 3
    print(
        f"release install matrix: {report['status']}; evidence={report['evidence_root']}; "
        f"checkout={report['source_checkout'].get('revision') or 'unknown'}"
    )
    return {"PASS": 0, "PARTIAL": 2, "DRY_RUN": 0, "FAIL": 1}.get(report["status"], 3)


if __name__ == "__main__":
    raise SystemExit(main())
