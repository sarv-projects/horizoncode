#!/usr/bin/env python3
"""Prepare and optionally build a source snapshot in a guarded task-owned clone.

The source checkout is never used as the build directory. Generated output is
kept in the clone, the existing source ``dist`` trees are not copied, and the
copied OpenCode build script is patched to restrict its cleanup commands to the
clone's package output directory.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path, PurePosixPath
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
from scripts.release.clean_install import APPROVED_TEMP_ROOT


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
    if source.is_symlink() or not source.is_dir():
        raise ValueError(f"source must be a real directory, not a symlink: {source}")
    resolved = source.resolve(strict=True)
    top = _git(resolved, "rev-parse", "--show-toplevel").stdout.decode().strip()
    if Path(top).resolve() != resolved:
        raise ValueError(f"source must be the root of its Git checkout: {source}")
    return resolved


def _validate_destination(destination: Path, source: Path) -> Path:
    base = APPROVED_TEMP_ROOT
    if base.is_symlink() or not base.is_dir() or base.resolve() != base:
        raise ValueError(f"approved task temp root is missing or symlinked: {base}")
    base_info = base.stat(follow_symlinks=False)
    if base_info.st_uid != os.getuid() or base_info.st_mode & 0o022:
        raise ValueError(f"approved task temp root must be owned by this user and private: {base}")

    requested = Path(os.path.abspath(destination))
    if requested == base or not _inside(requested, base):
        raise ValueError(f"build copy must be a new child of {base}: {requested}")
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

    if _inside(requested, source) or _inside(source, requested):
        raise ValueError("source checkout and build destination must be separate, non-overlapping directories")
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
    script = destination.joinpath(*BUILD_SCRIPT.parts)
    original = script.read_text(encoding="utf-8")
    crypto_import = 'import { createHash } from "node:crypto"'
    root_cleanup = "await $`rm -rf dist`"
    nested_cleanup = "await $`rm -rf ./dist/${name}/bin/tui`"
    if original.count(crypto_import) != 1 or original.count(root_cleanup) != 1 or original.count(nested_cleanup) != 1:
        raise ValueError("pinned build script cleanup sites differ from the reviewed P9 source contract")

    guarded_cleanup = '''
const p9BuildRoot = process.env.HORIZONCODE_P9_BUILD_ROOT
const p9BuildMarker = process.env.HORIZONCODE_P9_BUILD_MARKER
const clearP9BuildOutput = async (relative: string) => {
  if (!p9BuildRoot || !p9BuildMarker || !existsSync(p9BuildMarker)) {
    throw new Error("P9 build output cleanup requires a task-owned isolated build copy")
  }
  const root = path.resolve(p9BuildRoot)
  if (realpathSync(root) !== root || lstatSync(p9BuildMarker).isSymbolicLink()) {
    throw new Error("P9 build root or marker is not a regular task-owned path")
  }
  const marker = JSON.parse(readFileSync(p9BuildMarker, "utf8")) as { buildRoot?: string }
  if (marker.buildRoot !== root) throw new Error("P9 build marker does not match the isolated copy")
  const outputRoot = path.resolve(root, "packages/opencode/dist")
  const target = path.resolve(dir, relative)
  if (target !== outputRoot && !target.startsWith(`${outputRoot}${path.sep}`)) {
    throw new Error("P9 build cleanup target escaped the isolated package output directory")
  }
  let cursor = root
  for (const part of path.relative(root, target).split(path.sep)) {
    cursor = path.join(cursor, part)
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
      throw new Error("P9 build cleanup target contains a symlink")
    }
  }
  await $`rm -rf ${target}`
}
'''
    patched = original.replace(
        crypto_import,
        crypto_import + '\nimport { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs"',
    )
    dir_line = 'const dir = path.resolve(__dirname, "..")'
    if patched.count(dir_line) != 1:
        raise ValueError("pinned build script package-root declaration differs from the reviewed P9 source contract")
    patched = patched.replace(dir_line, dir_line + "\n" + guarded_cleanup, 1)
    patched = patched.replace(root_cleanup, 'await clearP9BuildOutput("dist")', 1)
    patched = patched.replace(nested_cleanup, 'await clearP9BuildOutput(`dist/${name}/bin/tui`)', 1)
    script.write_text(patched, encoding="utf-8")


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file:
        for chunk in iter(lambda: file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


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
    marker.write_text(
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
        encoding="utf-8",
    )
    marker.chmod(0o600)

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
    build_root = Path(report["build_copy"]["path"])
    marker = Path(report["build_copy"]["build_marker"])
    models_fixture = Path(report["build_copy"]["models_dev_api_json"])
    bun = shutil.which("bun")
    cargo = shutil.which("cargo")
    if not bun or not cargo:
        raise ValueError("the isolated Linux build requires bun and cargo on PATH")

    private_home = build_root.parent / f".{build_root.name}.home"
    if private_home.exists() or private_home.is_symlink():
        raise ValueError(f"task-owned build home already exists; refusing to reuse it: {private_home}")
    private_home.mkdir(mode=0o700)
    (private_home / "tmp").mkdir(mode=0o700)
    (private_home / ".cache").mkdir(mode=0o700)
    cargo_home = build_root / ".p9-cargo-home"
    cargo_home.mkdir(mode=0o700)

    env = {
        "PATH": os.environ.get("PATH", ""),
        "HOME": str(private_home),
        "TMPDIR": str(private_home / "tmp"),
        "XDG_CACHE_HOME": str(private_home / ".cache"),
        "CARGO_HOME": str(cargo_home),
        "RUSTUP_HOME": os.environ.get("RUSTUP_HOME", str(Path.home() / ".rustup")),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
        "MODELS_DEV_API_JSON": str(models_fixture),
        "OPENCODE_CHANNEL": "p9-qualification",
        "OPENCODE_VERSION": f"0.0.0-p9-{report['source']['revision'][:12]}",
        "HORIZONCODE_P9_BUILD_ROOT": str(build_root),
        "HORIZONCODE_P9_BUILD_MARKER": str(marker),
    }
    kernel_manifest = build_root / "kernel" / "Cargo.toml"
    _run_checked([cargo, "fetch", "--locked", "--manifest-path", str(kernel_manifest)], cwd=build_root, env=env, timeout=900)
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
    source_after_build = _git_source_facts(build_root)
    product = json.loads((build_root / "packages" / "opencode" / "package.json").read_text(encoding="utf-8"))
    from scripts.release.audit_distribution import _product_target

    manifest = {
        "schemaVersion": 1,
        "sourceRevision": report["source"]["revision"],
        "sourceStateSha256": report["source"]["source_state_sha256"],
        "sourceStatus": report["source"]["status"],
        "postBuildSourceStatus": source_after_build["status"],
        "postBuildSourceStateSha256": _source_tree_sha256(build_root),
        "binaryPath": binary.name,
        "binarySha256": _sha256(binary),
        "target": binary.parents[1].name,
        "packageTarget": _product_target(
            json.loads((build_root / "package.json").read_text(encoding="utf-8")), product
        ),
        "toolingMode": "isolated-read-only-qualification",
    }
    (artifact_directory / "release-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n",
        encoding="utf-8",
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
    parser.add_argument("--destination", required=True, type=Path, help="new child path under /tmp/opencode")
    parser.add_argument("--build", action="store_true", help="install locked dependencies and build the Linux CLI candidate")
    parser.add_argument("--output", type=Path, help="write the JSON report to this path instead of stdout")
    args = parser.parse_args()

    try:
        report = prepare_isolated_build(args.source, args.destination)
        if args.build:
            report = build_candidate(report)
    except (OSError, ValueError, subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        print(f"isolated P9 build preparation failed: {error}", file=sys.stderr)
        return 3

    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
        print(f"isolated P9 build: {report['build']['status']}; report={args.output}")
    else:
        print(encoded, end="")
    return 0 if report["build"]["status"] in {"PREPARED", "BUILT"} else 1


if __name__ == "__main__":
    raise SystemExit(main())
