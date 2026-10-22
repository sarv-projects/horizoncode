#!/usr/bin/env python3
"""Prepare and optionally build a source snapshot in a guarded task-owned clone.

The source checkout is never used as the build directory. Generated output is
kept in the clone, the existing source ``dist`` trees are not copied, and the
first-party build script confines cleanup to a marked isolated package output.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
import platform
import shutil
import stat
import subprocess
import sys
import time
import uuid

if __package__ in (None, ""):
    # Support direct invocation from the checkout root, as used by CI.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.release.audit_distribution import (
    SOURCE_OUTPUT_DIRS,
    _git_source_facts,
    _source_paths,
    _source_tree_sha256,
)
from scripts.release.clean_install import _ensure_approved_temp_root
from scripts.release.clean_install import _reject_symlink_components
from scripts.release.clean_install import _validated_output_path
from scripts.release.clean_install import _write_new_artifact_file


BUILD_SCRIPT = PurePosixPath("packages/opencode/script/build.ts")
MODELS_FIXTURE = PurePosixPath("opencode/packages/opencode/test/tool/fixtures/models-api.json")
DIFF_EXCLUDED_PATHS = tuple(sorted(SOURCE_OUTPUT_DIRS - {".git"}))


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _git(root: Path, *args: str, input: bytes | None = None) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        ["git", *args],
        cwd=root,
        check=True,
        capture_output=True,
        input=input,
        timeout=120,
    )


def _validate_source(source: Path) -> Path:
    requested = Path(os.path.abspath(source))
    repository = Path(__file__).resolve().parents[2]
    if not _inside(requested, repository):
        raise ValueError(f"source checkout must be inside this repository: {source}")
    _reject_symlink_components(requested, repository, "source checkout")
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"source must be a real directory, not a symlink: {source}")
    resolved = source.resolve(strict=True)
    if not _inside(resolved, repository):
        raise ValueError(f"resolved source checkout escapes this repository: {source}")
    top = _git(resolved, "rev-parse", "--show-toplevel").stdout.decode().strip()
    if Path(top).resolve() != resolved:
        raise ValueError(f"source must be the root of its Git checkout: {source}")
    return resolved


def _validate_destination(destination: Path, source: Path) -> Path:
    base = _ensure_approved_temp_root()

    requested = Path(os.path.abspath(destination))
    if requested == base or not _inside(requested, base):
        raise ValueError(f"build copy must be a new child of {base}: {requested}")
    _reject_symlink_components(requested, base, "build destination")
    if requested.exists() or requested.is_symlink():
        raise ValueError(f"build destination already exists; refusing to reuse it: {requested}")
    if not requested.parent.is_dir():
        raise ValueError(f"build destination parent must already exist: {requested.parent}")

    cursor = requested.parent
    while _inside(cursor, base):
        if cursor.is_symlink():
            raise ValueError(f"build destination contains a symlinked parent: {cursor}")
        info = cursor.stat(follow_symlinks=False)
        if info.st_uid != os.getuid() or info.st_mode & 0o022:
            raise ValueError(f"build destination parent must be owned by this user and private: {cursor}")
        if cursor == base:
            break
        cursor = cursor.parent

    # The approved artifact root is ignored and excluded from source snapshots,
    # so it can live under this repository while the copied checkout and its
    # generated build outputs remain isolated beneath that root.
    if requested == source or _inside(source, requested):
        raise ValueError("build destination must not replace or contain the source checkout")
    return requested


def _included_paths(root: Path) -> list[str]:
    paths = _source_paths(root)
    if paths is None:
        raise ValueError(f"could not enumerate Git-visible source inputs under {root}")
    return paths


def _validate_symlinks(source: Path, paths: list[str]) -> None:
    for name in paths:
        entry = source.joinpath(*PurePosixPath(name).parts)
        if not entry.is_symlink():
            continue
        target = os.readlink(entry)
        resolved = (entry.parent / target).resolve(strict=False)
        if not _inside(resolved, source):
            raise ValueError(f"symlink target escapes source checkout: {name} -> {target}")
        relative_target = resolved.relative_to(source)
        if any(part in SOURCE_OUTPUT_DIRS for part in relative_target.parts):
            raise ValueError(f"symlink target points into an excluded build/dependency tree: {name} -> {target}")


def _copy_untracked(source: Path, destination: Path, paths: list[str]) -> None:
    untracked = _git(source, "ls-files", "--others", "--exclude-standard", "-z").stdout
    for raw_name in untracked.split(b"\0"):
        if not raw_name:
            continue
        name = os.fsdecode(raw_name)
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts:
            raise ValueError(f"unsafe untracked source path: {name}")
        if any(part in SOURCE_OUTPUT_DIRS for part in relative.parts):
            continue
        source_entry = source.joinpath(*relative.parts)
        target_entry = destination.joinpath(*relative.parts)
        if target_entry.exists() or target_entry.is_symlink():
            raise ValueError(f"untracked source path collides with the Git checkout: {name}")
        target_entry.parent.mkdir(parents=True, exist_ok=True)
        metadata = source_entry.lstat()
        if stat.S_ISREG(metadata.st_mode):
            shutil.copy2(source_entry, target_entry)
        elif stat.S_ISLNK(metadata.st_mode):
            target_entry.symlink_to(os.readlink(source_entry))
        else:
            raise ValueError(f"unsupported untracked source file type: {name}")


def _guard_build_script(destination: Path) -> None:
    """Require cleanup confinement in source instead of mutating the candidate."""
    script = destination.joinpath(*BUILD_SCRIPT.parts)
    build_root = destination.resolve(strict=True)
    if not _inside(script.parent, build_root):
        raise ValueError("isolated build script parent escaped the candidate checkout")
    _reject_symlink_components(script, build_root, "isolated build script")
    if script.is_symlink() or not script.is_file():
        raise ValueError("isolated build script must be a regular, non-symlink file")
    descriptor = os.open(script, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "r", encoding="utf-8") as source_file:
        if not stat.S_ISREG(os.fstat(source_file.fileno()).st_mode):
            raise ValueError("isolated build script must be a regular, non-symlink file")
        contents = source_file.read()
    required = (
        'const clearBuildOutput = async (relative: string) =>',
        'process.env.HORIZONCODE_P9_BUILD_ROOT',
        'process.env.HORIZONCODE_P9_BUILD_MARKER',
        'await clearBuildOutput("dist")',
        'await clearBuildOutput(`dist/${name}/bin/tui`)',
        'await $`rm -rf ${target}`',
    )
    if any(contents.count(fragment) != 1 for fragment in required):
        raise ValueError("candidate build script lacks the exact P9 isolated-output cleanup guard")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(descriptor, "rb") as file:
        if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
            raise ValueError(f"artifact digest input must be a regular non-symlink file: {path}")
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _artifact_inventory(directory: Path) -> list[dict]:
    """Hash every generated candidate file without following links or escapes."""
    root = directory.resolve(strict=True)
    if directory.is_symlink() or not directory.is_dir():
        raise ValueError("candidate artifact directory must be a real directory")
    inventory: list[dict] = []
    total_bytes = 0
    for current, directories, files in os.walk(root, followlinks=False):
        current_path = Path(current)
        for name in list(directories):
            path = current_path / name
            if path.is_symlink():
                raise ValueError(f"candidate artifact contains a symlink directory: {path.relative_to(root)}")
        for name in files:
            path = current_path / name
            if path.is_symlink():
                raise ValueError(f"candidate artifact contains a symlink file: {path.relative_to(root)}")
            descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
            with os.fdopen(descriptor, "rb") as stream:
                metadata = os.fstat(stream.fileno())
                if not stat.S_ISREG(metadata.st_mode):
                    raise ValueError(f"candidate artifact member is not a regular file: {path.relative_to(root)}")
                total_bytes += metadata.st_size
                if len(inventory) >= 10_000 or total_bytes > 4 * 1024 * 1024 * 1024:
                    raise ValueError("candidate artifact inventory exceeds the configured file or byte bound")
                digest = hashlib.sha256()
                for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                    digest.update(chunk)
            inventory.append({
                "path": path.relative_to(root).as_posix(),
                "sizeBytes": metadata.st_size,
                "sha256": digest.hexdigest(),
            })
    return sorted(inventory, key=lambda item: item["path"])


def _required_digest(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise ValueError(f"required release input is missing or is a symlink: {path}")
    return _sha256(path)


def prepare_isolated_build(source: Path, destination: Path) -> dict:
    source = _validate_source(source)
    destination = _validate_destination(destination, source)
    paths = _included_paths(source)
    _validate_symlinks(source, paths)
    source_facts = _git_source_facts(source)
    source_digest = _source_tree_sha256(source, paths)
    if not source_facts.get("revision") or not source_digest:
        raise ValueError("could not bind the isolated build copy to a source revision and SHA-256 state digest")

    _git(source.parent, "clone", "--shared", "--quiet", "--no-checkout", "--", str(source), str(destination))
    _git(destination, "checkout", "--quiet", "--detach", str(source_facts["revision"]))
    exclude_pathspecs = [f":(exclude,glob)**/{name}/**" for name in DIFF_EXCLUDED_PATHS]
    diff = _git(source, "diff", "--binary", "--no-ext-diff", "HEAD", "--", ".", *exclude_pathspecs).stdout
    if diff:
        _git(destination, "apply", "--binary", "--whitespace=nowarn", "-", input=diff)
    _copy_untracked(source, destination, paths)

    bootstrap_script = destination / "scripts" / "architecture" / "bootstrap_source.py"
    if bootstrap_script.is_symlink() or not bootstrap_script.is_file():
        raise ValueError("isolated build copy is missing the pinned-source bootstrap script")
    bootstrap = subprocess.run(
        [sys.executable, str(bootstrap_script), "--apply"],
        cwd=destination,
        capture_output=True,
        text=True,
        timeout=600,
        check=False,
    )
    if bootstrap.returncode != 0:
        raise ValueError(f"pinned-source bootstrap failed: {bootstrap.stderr[-2000:]}")

    copied_paths = _included_paths(destination)
    copied_digest = _source_tree_sha256(destination, copied_paths)
    if copied_digest != source_digest:
        raise ValueError("isolated build copy source-state digest differs from the original Git-visible source inputs")
    models_fixture = destination.joinpath(*MODELS_FIXTURE.parts)
    if models_fixture.is_symlink() or not models_fixture.is_file():
        raise ValueError(f"local MODELS_DEV_API_JSON fixture is missing or not a regular file: {models_fixture}")
    _guard_build_script(destination)

    marker = destination.parent / f".{destination.name}.p9-build-marker.json"
    if marker.exists() or marker.is_symlink():
        raise ValueError(f"P9 build marker already exists; refusing to reuse it: {marker}")
    _write_new_artifact_file(
        marker,
        json.dumps(
            {
                "schemaVersion": 1,
                "buildRoot": str(destination),
                "sourceRevision": source_facts["revision"],
                "sourceStateSha256": source_digest,
                "createdAtUnix": int(time.time()),
            },
            indent=2,
            sort_keys=True,
        )
        + "\n",
    )

    return {
        "schema_version": 1,
        "qualification_status": "NON_RELEASE_QUALIFIED" if source_facts["status"] != "CLEAN" else "CANDIDATE_BUILD",
        "source": {
            "status": source_facts["status"],
            "revision": source_facts["revision"],
            "source_state_sha256": source_digest,
        },
        "build_copy": {
            "path": str(destination),
            "status": _git_source_facts(destination)["status"],
            "source_state_sha256": copied_digest,
            "source_bootstrap": {"status": "APPLIED", "output": bootstrap.stdout.strip()},
            "models_dev_api_json": str(models_fixture),
            "build_marker": str(marker),
        },
        "build": {"status": "PREPARED", "product_binary": None, "artifact_directory": None},
        "limitations": [
            "A dirty-source build is diagnostic and never release-qualified.",
            "The copied build script may clean only packages/opencode/dist inside this marked isolated clone.",
            "No signing, publication, upload, or update activation is performed.",
        ],
    }


def _run_checked(command: list[str], *, cwd: Path, env: dict[str, str], timeout: int) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(command, cwd=cwd, env=env, capture_output=True, text=True, timeout=timeout, check=False)
    if result.returncode != 0:
        diagnostics = "\n".join(
            value for value in (result.stderr[-4000:].strip(), result.stdout[-4000:].strip()) if value
        )
        raise ValueError(f"command failed with exit status {result.returncode}: {command!r}\n{diagnostics}")
    return result


def build_candidate(report: dict) -> dict:
    artifact_root = _ensure_approved_temp_root().resolve(strict=True)
    requested_root = Path(os.path.abspath(report["build_copy"]["path"]))
    if not _inside(requested_root, artifact_root):
        raise ValueError(f"isolated build root must be inside the repository artifact root: {requested_root}")
    _reject_symlink_components(requested_root, artifact_root, "isolated build root")
    if requested_root.is_symlink() or not requested_root.is_dir():
        raise ValueError(f"isolated build root must be a regular directory: {requested_root}")
    build_root = requested_root.resolve(strict=True)
    if not _inside(build_root, artifact_root):
        raise ValueError(f"resolved isolated build root escapes the repository artifact root: {build_root}")

    marker = Path(report["build_copy"]["build_marker"])
    expected_marker = build_root.parent / f".{build_root.name}.p9-build-marker.json"
    if marker != expected_marker or marker.is_symlink() or not marker.is_file():
        raise ValueError("isolated build marker must be the regular task-owned marker beside the build copy")
    marker_fd = os.open(marker, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(marker_fd, "r", encoding="utf-8") as marker_file:
        marker_stat = os.fstat(marker_file.fileno())
        if not stat.S_ISREG(marker_stat.st_mode) or marker_stat.st_uid != os.getuid() or marker_stat.st_mode & 0o077:
            raise ValueError("isolated build marker must be a private, user-owned regular file")
        marker_value = json.load(marker_file)
    if (
        not isinstance(marker_value, dict)
        or marker_value.get("buildRoot") != str(build_root)
        or marker_value.get("sourceRevision") != report["source"].get("revision")
        or marker_value.get("sourceStateSha256") != report["source"].get("source_state_sha256")
    ):
        raise ValueError("isolated build marker does not bind this source revision, digest, and build root")

    models_fixture = Path(os.path.abspath(report["build_copy"]["models_dev_api_json"]))
    if not _inside(models_fixture, build_root):
        raise ValueError("model fixture must be inside the isolated source copy")
    _reject_symlink_components(models_fixture, build_root, "model fixture")
    if models_fixture.is_symlink() or not models_fixture.is_file():
        raise ValueError("isolated build requires a regular model fixture in its source copy")
    models_fixture = models_fixture.resolve(strict=True)
    bun = shutil.which("bun")
    cargo = shutil.which("cargo")
    rustup = shutil.which("rustup")
    if not bun or not cargo or not rustup:
        raise ValueError("the isolated Linux build requires bun, cargo, and rustup on PATH")

    private_home = build_root.parent / f".{build_root.name}.home"
    cargo_home = build_root.parent / f".{build_root.name}.cargo"
    rustup_home = build_root.parent / f".{build_root.name}.rustup"
    for label, path in (("build home", private_home), ("Cargo home", cargo_home), ("Rustup home", rustup_home)):
        if path.exists() or path.is_symlink():
            raise ValueError(f"task-owned {label} already exists; refusing to reuse it: {path}")

    private_home.mkdir(mode=0o700)
    (private_home / "tmp").mkdir(mode=0o700)
    (private_home / ".cache").mkdir(mode=0o700)
    cargo_home.mkdir(mode=0o700)
    rustup_home.mkdir(mode=0o700)

    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(private_home),
        "TMPDIR": str(private_home / "tmp"),
        "XDG_CACHE_HOME": str(private_home / ".cache"),
        "CARGO_HOME": str(cargo_home),
        # Keep toolchain metadata and installed components inside the ignored,
        # task-owned release artifact subtree. Never inherit a host Rustup
        # home: that would make the qualification build depend on and mutate
        # state outside this repository.
        "RUSTUP_HOME": str(rustup_home),
        "RUSTUP_TOOLCHAIN": "stable",
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "MODELS_DEV_API_JSON": str(models_fixture),
        "OPENCODE_CHANNEL": "p9-qualification",
        "OPENCODE_VERSION": f"0.0.0-p9-{report['source']['revision'][:12]}",
        "HORIZONCODE_P9_BUILD_ROOT": str(build_root),
        "HORIZONCODE_P9_BUILD_MARKER": str(marker),
    }
    _run_checked([rustup, "toolchain", "install", "stable", "--profile", "minimal"], cwd=build_root, env=env, timeout=900)
    kernel_manifest = build_root / "kernel" / "Cargo.toml"
    _run_checked([cargo, "+stable", "fetch", "--locked", "--manifest-path", str(kernel_manifest)], cwd=build_root, env=env, timeout=900)
    _run_checked([bun, "install", "--frozen-lockfile"], cwd=build_root, env=env, timeout=1800)
    build_result = _run_checked(
        [bun, "run", "script/build.ts", "--single", "--skip-install", "--skip-embed-web-ui"],
        cwd=build_root / "packages" / "opencode",
        env=env,
        timeout=3600,
    )

    candidates = sorted((build_root / "packages" / "opencode" / "dist").glob("opencode-linux-*/bin/opencode"))
    if len(candidates) != 1 or candidates[0].is_symlink() or not candidates[0].is_file():
        raise ValueError(f"expected exactly one regular Linux CLI candidate, found {len(candidates)}")
    binary = candidates[0]
    artifact_directory = binary.parent
    _reject_symlink_components(artifact_directory, build_root, "candidate artifact directory")
    source_after_build = _git_source_facts(build_root)
    product = json.loads((build_root / "packages" / "opencode" / "package.json").read_text(encoding="utf-8"))
    workspace = json.loads((build_root / "package.json").read_text(encoding="utf-8"))
    migration_directory = build_root / "packages" / "core" / "src" / "database" / "migration"
    migration_ids = sorted(path.name for path in migration_directory.glob("*.ts") if path.is_file() and not path.is_symlink())
    schema_contracts = sorted((build_root / "arch_V1" / "contracts-v2").glob("*.json"))
    schema_contract_digest = hashlib.sha256()
    for contract in schema_contracts:
        if contract.is_symlink() or not contract.is_file():
            raise ValueError(f"schema contract must be a regular file: {contract}")
        schema_contract_digest.update(contract.relative_to(build_root).as_posix().encode("utf-8"))
        schema_contract_digest.update(b"\0")
        schema_contract_digest.update(_required_digest(contract).encode("ascii"))
        schema_contract_digest.update(b"\n")
    lockfile_hashes = {
        "bun.lock": _required_digest(build_root / "bun.lock"),
        "kernel/Cargo.lock": _required_digest(build_root / "kernel" / "Cargo.lock"),
    }
    toolchain = {
        "bun": _run_checked([bun, "--version"], cwd=build_root, env=env, timeout=30).stdout.strip(),
        "cargo": _run_checked([cargo, "+stable", "--version"], cwd=build_root, env=env, timeout=30).stdout.strip(),
        "rustc": _run_checked([rustup, "run", "stable", "rustc", "--version"], cwd=build_root, env=env, timeout=30).stdout.strip(),
    }
    from scripts.release.audit_distribution import _product_target

    artifact_inventory = _artifact_inventory(artifact_directory)
    manifest = {
        "schemaVersion": 2,
        "sourceRevision": report["source"]["revision"],
        "sourceStateSha256": report["source"]["source_state_sha256"],
        "sourceStatus": report["source"]["status"],
        "postBuildSourceStatus": source_after_build["status"],
        "postBuildSourceStateSha256": _source_tree_sha256(build_root),
        "binaryPath": binary.name,
        "binarySha256": _sha256(binary),
        "binarySizeBytes": binary.stat(follow_symlinks=False).st_size,
        "target": binary.parents[1].name,
        "host": {"system": platform.system(), "release": platform.release(), "machine": platform.machine()},
        "buildToolchain": toolchain,
        "lockfileSha256": lockfile_hashes,
        "configAndSchema": {
            "workspaceVersion": workspace.get("version"),
            "applicationPackageVersion": product.get("version"),
            "configMigrationIDs": migration_ids,
            "contractFileCount": len(schema_contracts),
            "contractSetSha256": schema_contract_digest.hexdigest(),
        },
        "artifactFiles": artifact_inventory,
        "packageTarget": _product_target(
            workspace, product
        ),
        "toolingMode": "isolated-read-only-qualification",
    }
    _write_new_artifact_file(
        artifact_directory / "release-manifest.json",
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        mode=0o644,
    )
    report["build_copy"]["status"] = source_after_build["status"]
    report["build"]["status"] = "BUILT"
    report["build"]["product_binary"] = str(binary)
    report["build"]["artifact_directory"] = str(artifact_directory)
    report["build"]["binary_sha256"] = manifest["binarySha256"]
    report["build"]["source_state_sha256_after_build"] = manifest["postBuildSourceStateSha256"]
    report["build"]["command_output_tail"] = build_result.stdout[-4000:]
    if report["source"]["status"] != "CLEAN" or source_after_build["status"] != "CLEAN":
        report["qualification_status"] = "NON_RELEASE_QUALIFIED"
    return report


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True, type=Path, help="root of the Git source checkout to snapshot")
    parser.add_argument("--destination", required=True, type=Path, help="new child path under kernel/target/horizoncode-release")
    parser.add_argument("--build", action="store_true", help="install locked dependencies and build the Linux CLI candidate")
    parser.add_argument("--output", type=Path, help="write the JSON report to this path instead of stdout")
    args = parser.parse_args()

    try:
        output_path = _validated_output_path(args.output) if args.output else None
        report = prepare_isolated_build(args.source, args.destination)
        if args.build:
            report = build_candidate(report)
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"isolated P9 build preparation failed: {error}", file=sys.stderr)
        return 3

    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if output_path:
        _write_new_artifact_file(output_path, encoded)
        print(f"isolated P9 build: {report['build']['status']}; report={output_path}")
    else:
        print(encoded, end="")
    return 0 if report["build"]["status"] in {"PREPARED", "BUILT"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
