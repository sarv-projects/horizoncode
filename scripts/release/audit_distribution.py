#!/usr/bin/env python3
"""Fail-closed inventory of HorizonCode distribution licensing and artifacts.

This reports facts for human/legal review. It does not decide whether a license
permits redistribution or turn package metadata into legal clearance.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
import tarfile
import zipfile


LEGAL_BASENAME = re.compile(
    r"^(license|licence|copying|notice|patents|third[._-]?party[._-]?notices?)(?:[._-].*)?$", re.IGNORECASE
)
SOURCE_OUTPUT_DIRS = frozenset({".git", ".turbo", ".cache", "__pycache__", "dist", "node_modules", "target"})
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")
REPOSITORY_ROOT = Path(__file__).resolve().parents[2]
MAX_PACKAGE_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_RUNTIME_PACKAGES = 10_000
MAX_DEPENDENCIES_PER_MANIFEST = 4_096
MAX_PACKAGE_DIRECTORY_ENTRIES = 8_192
MAX_PACKAGE_DIRECTORY_ENTRIES_TOTAL = 100_000
MAX_AUDIT_TEXT_BYTES = 4 * 1024 * 1024


def _inside(path: Path, parent: Path) -> bool:
    try:
        path.relative_to(parent)
        return True
    except ValueError:
        return False


def _reject_symlink_components(path: Path, root: Path, label: str) -> None:
    cursor = path
    while _inside(cursor, root):
        if cursor.is_symlink():
            raise ValueError(f"{label} path contains a symlink: {cursor}")
        if cursor == root:
            return
        cursor = cursor.parent
    raise ValueError(f"{label} path is outside its approved root: {path}")


def _read_local_bytes(path: Path, allowed_root: Path, limit: int) -> bytes | None:
    """Read a bounded regular file without following a path outside its root."""
    try:
        root = allowed_root.resolve(strict=True)
        if not _inside(path, root):
            return None
        _reject_symlink_components(path, root, "audit input")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            metadata = os.fstat(stream.fileno())
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
                return None
            value = stream.read(limit + 1)
        return value if len(value) <= limit else None
    except (OSError, ValueError):
        return None


def _read_manifest(path: Path, allowed_root: Path | None = None, errors: list[str] | None = None) -> dict:
    try:
        if allowed_root is not None:
            root = allowed_root.resolve(strict=True)
            if not _inside(path, root):
                raise ValueError("manifest path is outside the audited source root")
            _reject_symlink_components(path, root, "package manifest")
            resolved = path.resolve(strict=True)
            if not _inside(resolved, root):
                raise ValueError("manifest resolves outside the audited source root")
            _reject_symlink_components(resolved, root, "package manifest")
            path = resolved
        raw = _read_local_bytes(path, allowed_root or path.parent, MAX_PACKAGE_MANIFEST_BYTES)
        if raw is None:
            raise ValueError("manifest is not a bounded regular file")
        value = json.loads(raw.decode("utf-8"))
        if not isinstance(value, dict):
            raise ValueError("manifest root is not an object")
    except (OSError, UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        if errors is not None:
            errors.append(f"{path}: {error}")
        return {}
    return value


def _license_value(value: object) -> str | None:
    if isinstance(value, str):
        return value
    if isinstance(value, dict):
        return json.dumps(value, sort_keys=True)
    if isinstance(value, list):
        return " OR ".join(str(item) for item in value)
    return None


def _is_tracked(root: Path, relative: str) -> bool:
    try:
        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", "--", relative],
            cwd=root,
            check=False,
            capture_output=True,
            text=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0 and relative in result.stdout.splitlines()


def _is_git_visible(root: Path, relative: str) -> bool:
    """True when Git does not hide a release overlay behind ignore rules."""
    try:
        result = subprocess.run(
            ["git", "check-ignore", "--no-index", "--quiet", "--", relative],
            cwd=root,
            check=False,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    # check-ignore returns 1 for a visible path and 0 for an ignored one.
    return result.returncode == 1


def _file_sha256(path: Path, allowed_root: Path | None = None) -> str | None:
    try:
        if allowed_root is not None:
            root = allowed_root.resolve(strict=True)
            if not _inside(path, root):
                return None
            _reject_symlink_components(path, root, "hashed audit input")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        digest = hashlib.sha256()
        with os.fdopen(descriptor, "rb") as file:
            if not stat.S_ISREG(os.fstat(file.fileno()).st_mode):
                return None
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _regular_file(path: Path, allowed_root: Path | None = None) -> bool:
    try:
        if allowed_root is not None:
            root = allowed_root.resolve(strict=True)
            if not _inside(path, root):
                return False
            _reject_symlink_components(path, root, "audited file")
        descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
        with os.fdopen(descriptor, "rb") as stream:
            return stat.S_ISREG(os.fstat(stream.fileno()).st_mode)
    except OSError:
        return False
    except ValueError:
        return False


def _git_source_facts(root: Path) -> dict:
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=root,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
        source_state_sha256 = _source_tree_sha256(root)
        return {
            "revision": revision,
            "clean": not status,
            "status": "CLEAN" if not status else "DIRTY",
            "source_state_sha256": source_state_sha256,
            "source_state_digest_status": "AVAILABLE" if source_state_sha256 else "UNAVAILABLE",
        }
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {
            "revision": None,
            "clean": False,
            "status": "UNVERSIONED",
            "source_state_sha256": None,
            "source_state_digest_status": "UNAVAILABLE",
        }


def _source_paths(root: Path) -> list[str] | None:
    """Return Git-visible source inputs, excluding dependency/build output trees."""
    try:
        result = subprocess.run(
            ["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
            cwd=root,
            check=True,
            capture_output=True,
            timeout=30,
        )
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return None

    paths = sorted({os.fsdecode(item) for item in result.stdout.split(b"\0") if item})
    return [
        name
        for name in paths
        if not any(component in SOURCE_OUTPUT_DIRS for component in PurePosixPath(name).parts)
    ]


def _source_tree_sha256(root: Path, paths: list[str] | None = None) -> str | None:
    """Hash exact Git-visible source inputs without hashing dependency/build output trees."""
    if paths is None:
        paths = _source_paths(root)
    if paths is None:
        return None

    digest = hashlib.sha256()
    for name in paths:
        relative = PurePosixPath(name)
        if relative.is_absolute() or ".." in relative.parts:
            return None
        item = root.joinpath(*relative.parts)
        cursor = root
        for component in relative.parts[:-1]:
            cursor = cursor / component
            if cursor.is_symlink():
                return None
        try:
            metadata = item.lstat()
        except OSError:
            continue
        digest.update(os.fsencode(name))
        digest.update(b"\0")
        digest.update(str(metadata.st_mode & 0o777).encode("ascii"))
        digest.update(b"\0")
        if stat.S_ISREG(metadata.st_mode):
            try:
                with item.open("rb") as file:
                    for chunk in iter(lambda: file.read(1024 * 1024), b""):
                        digest.update(chunk)
            except OSError:
                return None
        elif stat.S_ISLNK(metadata.st_mode):
            try:
                digest.update(os.fsencode(os.readlink(item)))
            except OSError:
                return None
        else:
            return None
        digest.update(b"\0")
    return digest.hexdigest()


def _resolve_dependency(package_root: Path, dependency: str, allowed_root: Path) -> Path | None:
    for parent in (package_root, *package_root.parents):
        candidate = parent / "node_modules" / dependency / "package.json"
        if not _inside(candidate, allowed_root):
            continue
        try:
            # Containment is decided by the resolved target: an in-root install
            # link (isolated package store) is resolvable, an escaping link is not.
            resolved = candidate.resolve(strict=True)
        except OSError:
            continue
        if not _inside(resolved, allowed_root):
            return None
        try:
            metadata = resolved.lstat()
        except OSError:
            continue
        if not stat.S_ISREG(metadata.st_mode):
            return None
        return resolved.parent
    return None


def _package_legal_files(
    package_root: Path,
    errors: list[str],
    remaining_entries: list[int],
) -> list[str]:
    legal_files: list[str] = []
    visited = 0
    try:
        with os.scandir(package_root) as entries:
            for entry in entries:
                visited += 1
                remaining_entries[0] -= 1
                if visited > MAX_PACKAGE_DIRECTORY_ENTRIES:
                    errors.append(
                        f"{package_root}: legal-file inventory exceeds {MAX_PACKAGE_DIRECTORY_ENTRIES} entries"
                    )
                    return []
                if remaining_entries[0] < 0:
                    errors.append(
                        f"runtime package legal-file inventory exceeds {MAX_PACKAGE_DIRECTORY_ENTRIES_TOTAL} total entries"
                    )
                    return []
                try:
                    if entry.is_file(follow_symlinks=False) and LEGAL_BASENAME.match(entry.name):
                        legal_files.append(entry.name)
                except OSError as error:
                    errors.append(f"{package_root / entry.name}: legal-file metadata unavailable: {error}")
                    return []
    except OSError as error:
        errors.append(f"{package_root}: legal-file directory inventory failed: {error}")
        return []
    return sorted(legal_files)


def scan_runtime_dependencies(package_root: Path, allowed_root: Path | None = None, errors: list[str] | None = None) -> dict:
    """Walk runtime/optional/required-peer dependencies from one package."""
    allowed_root = (allowed_root or package_root).resolve()
    packages: dict[str, dict] = {}
    missing: list[dict] = []
    inventory_errors = errors if errors is not None else []
    try:
        resolved_package_root = package_root.resolve(strict=True)
    except OSError as error:
        resolved_package_root = package_root
        inventory_errors.append(f"{package_root}: {error}")
    if not _inside(resolved_package_root, allowed_root):
        inventory_errors.append("runtime package root resolves outside the audited source root")
        pending = []
    else:
        pending = [resolved_package_root]
    visited: set[Path] = set()
    remaining_package_entries = [MAX_PACKAGE_DIRECTORY_ENTRIES_TOTAL]

    while pending:
        if len(visited) >= MAX_RUNTIME_PACKAGES:
            inventory_errors.append(f"runtime dependency traversal exceeds {MAX_RUNTIME_PACKAGES} packages")
            break
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        manifest = _read_manifest(current / "package.json", allowed_root, inventory_errors)
        if not manifest:
            continue

        peer_meta = manifest.get("peerDependenciesMeta", {})
        requirements: list[tuple[str, str, bool]] = []
        for role in ("dependencies", "optionalDependencies", "peerDependencies"):
            values = manifest.get(role, {})
            if not isinstance(values, dict):
                continue
            for name, spec in values.items():
                optional_peer = role == "peerDependencies" and isinstance(peer_meta, dict) and bool(
                    peer_meta.get(name, {}).get("optional")
                    if isinstance(peer_meta.get(name, {}), dict)
                    else False
                )
                is_optional = role == "optionalDependencies" or optional_peer
                requirements.append((str(name), str(spec), is_optional))

        if len(requirements) > MAX_DEPENDENCIES_PER_MANIFEST:
            inventory_errors.append(
                f"{current / 'package.json'} declares more than {MAX_DEPENDENCIES_PER_MANIFEST} dependencies"
            )
            continue

        for name, spec, is_optional in requirements:
            resolved = _resolve_dependency(current, name, allowed_root)
            if resolved is None:
                missing.append(
                    {
                        "from": str(current),
                        "name": name,
                        "requested": spec,
                        "optional": is_optional,
                    }
                )
                continue
            dependency_manifest = _read_manifest(resolved / "package.json", allowed_root, inventory_errors)
            package_name = str(dependency_manifest.get("name", name))
            version = str(dependency_manifest.get("version", "unknown"))
            key = f"{package_name}@{version}:{resolved}"
            if key not in packages:
                packages[key] = {
                    "name": package_name,
                    "version": version,
                    "license": _license_value(dependency_manifest.get("license")),
                    "path": str(resolved),
                    "license_files": _package_legal_files(resolved, inventory_errors, remaining_package_entries),
                    "requested_by": [],
                }
                pending.append(resolved)
            packages[key]["requested_by"].append(str(current))

    inventory = sorted(packages.values(), key=lambda item: (item["name"], item["version"], item["path"]))
    missing_license_metadata = [item for item in inventory if item["license"] is None]
    missing_license_files = [item for item in inventory if not item["license_files"]]
    required_missing = [item for item in missing if not item["optional"]]
    return {
        "basis": "installed workspace package manifests; not the final shipping artifact closure",
        "root_package": str(package_root.resolve()),
        "package_count": len(inventory),
        "packages": inventory,
        "missing_license_metadata": missing_license_metadata,
        "missing_license_files": missing_license_files,
        "unresolved_required_dependencies": required_missing,
        "unresolved_optional_dependencies": [item for item in missing if item["optional"]],
        "inventory_errors": inventory_errors,
    }


def _artifact_members(path: Path) -> tuple[list[str], list[str]]:
    """Return archive/directory member names and unsafe paths without extracting."""
    if path.is_dir():
        members: list[str] = []
        symlinks: list[str] = []

        def fail_on_walk_error(error: OSError) -> None:
            raise error

        for current, directories, files in os.walk(path, followlinks=False, onerror=fail_on_walk_error):
            current_path = Path(current)
            for name in list(directories):
                entry = current_path / name
                if entry.is_symlink():
                    symlinks.append(entry.relative_to(path).as_posix())
                    directories.remove(name)
            for name in files:
                entry = current_path / name
                relative = entry.relative_to(path).as_posix()
                if entry.is_symlink():
                    symlinks.append(relative)
                else:
                    members.append(relative)
        return sorted(members), sorted(symlinks)

    if zipfile.is_zipfile(path):
        with zipfile.ZipFile(path) as archive:
            members = []
            symlinks = []
            for item in archive.infolist():
                if item.is_dir():
                    continue
                mode = item.external_attr >> 16
                if stat.S_ISLNK(mode):
                    symlinks.append(item.filename)
                else:
                    members.append(item.filename)
        return members, symlinks

    if tarfile.is_tarfile(path):
        with tarfile.open(path, "r:*") as archive:
            members = [item.name for item in archive.getmembers() if item.isfile()]
            symlinks = [item.name for item in archive.getmembers() if item.issym() or item.islnk()]
        return members, symlinks

    return [path.name], []


def _unsafe_member_path(name: str) -> bool:
    normalized = name.replace("\\", "/")
    path = PurePosixPath(normalized)
    return (
        path.is_absolute()
        or ".." in path.parts
        or bool(path.parts and re.match(r"^[A-Za-z]:", path.parts[0]))
    )


def _read_artifact_member(path: Path, name: str, limit: int = 16 * 1024 * 1024) -> bytes | None:
    """Read one safe, bounded regular file from a directory or archive."""
    if _unsafe_member_path(name):
        return None
    if path.is_dir():
        member = path.joinpath(*PurePosixPath(name.replace("\\", "/")).parts)
        if member.is_symlink() or not member.is_file():
            return None
        try:
            if member.stat(follow_symlinks=False).st_size > limit:
                return None
            return member.read_bytes()
        except OSError:
            return None
    try:
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                matches = [item for item in archive.infolist() if item.filename == name and not item.is_dir()]
                if len(matches) != 1 or matches[0].file_size > limit:
                    return None
                with archive.open(matches[0]) as stream:
                    value = stream.read(limit + 1)
                return value if len(value) <= limit else None
        if tarfile.is_tarfile(path):
            with tarfile.open(path, "r:*") as archive:
                matches = [item for item in archive.getmembers() if item.name == name and item.isfile()]
                if len(matches) != 1 or matches[0].size > limit:
                    return None
                stream = archive.extractfile(matches[0])
                if stream is None:
                    return None
                with stream:
                    value = stream.read(limit + 1)
                return value if len(value) <= limit else None
    except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError):
        return None
    if path.is_file() and name == path.name:
        try:
            if path.stat().st_size > limit:
                return None
            return path.read_bytes()
        except OSError:
            return None
    return None


def _artifact_member_sha256(path: Path, name: str, limit: int = 2 * 1024 * 1024 * 1024) -> str | None:
    """Hash one bounded, unambiguous regular artifact member without extracting it."""
    if _unsafe_member_path(name):
        return None

    digest = hashlib.sha256()
    total = 0

    def update(stream) -> str | None:
        nonlocal total
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            total += len(chunk)
            if total > limit:
                return None
            digest.update(chunk)
        return digest.hexdigest()

    try:
        if path.is_dir():
            member = path.joinpath(*PurePosixPath(name.replace("\\", "/")).parts)
            cursor = path
            for part in PurePosixPath(name.replace("\\", "/")).parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    return None
            metadata = member.stat(follow_symlinks=False)
            if not stat.S_ISREG(metadata.st_mode) or metadata.st_size > limit:
                return None
            with member.open("rb") as stream:
                return update(stream)
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                matches = [item for item in archive.infolist() if item.filename == name and not item.is_dir()]
                if len(matches) != 1 or matches[0].file_size > limit:
                    return None
                mode = matches[0].external_attr >> 16
                if stat.S_ISLNK(mode):
                    return None
                with archive.open(matches[0]) as stream:
                    return update(stream)
        if tarfile.is_tarfile(path):
            with tarfile.open(path, "r:*") as archive:
                matches = [item for item in archive.getmembers() if item.name == name and item.isfile()]
                if len(matches) != 1 or matches[0].size > limit:
                    return None
                stream = archive.extractfile(matches[0])
                if stream is None:
                    return None
                with stream:
                    return update(stream)
    except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError):
        return None
    return None


def _artifact_member_size(path: Path, name: str) -> int | None:
    """Read bounded metadata for one unambiguous regular artifact member."""
    if _unsafe_member_path(name):
        return None
    try:
        if path.is_dir():
            member = path.joinpath(*PurePosixPath(name).parts)
            cursor = path
            for part in PurePosixPath(name).parts:
                cursor = cursor / part
                if cursor.is_symlink():
                    return None
            metadata = member.stat(follow_symlinks=False)
            return metadata.st_size if stat.S_ISREG(metadata.st_mode) else None
        if zipfile.is_zipfile(path):
            with zipfile.ZipFile(path) as archive:
                matches = [item for item in archive.infolist() if item.filename == name and not item.is_dir()]
                if len(matches) != 1 or stat.S_ISLNK(matches[0].external_attr >> 16):
                    return None
                return matches[0].file_size
        if tarfile.is_tarfile(path):
            with tarfile.open(path, "r:*") as archive:
                matches = [item for item in archive.getmembers() if item.name == name and item.isfile()]
                return matches[0].size if len(matches) == 1 else None
        if path.is_file() and name == path.name:
            metadata = path.stat(follow_symlinks=False)
            return metadata.st_size if stat.S_ISREG(metadata.st_mode) else None
    except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError):
        return None
    return None


def _validate_artifact_inventory(
    path: Path,
    manifest: dict,
    members: list[str],
    manifest_name: str,
) -> tuple[bool, list[str]]:
    """Check manifest file membership, sizes and hashes against the exact artifact."""
    if manifest.get("schemaVersion") != 2:
        return False, ["candidate provenance manifest must use schemaVersion 2"]
    source_digest = manifest.get("sourceStateSha256")
    post_build_digest = manifest.get("postBuildSourceStateSha256")
    if (
        not isinstance(source_digest, str)
        or not SHA256_HEX.fullmatch(source_digest)
        or post_build_digest != source_digest
    ):
        return False, ["candidate provenance must bind an unchanged, valid post-build source-state digest"]
    raw = manifest.get("artifactFiles")
    if not isinstance(raw, list) or len(raw) > 10_000:
        return False, ["candidate file inventory is missing or exceeds 10,000 entries"]
    expected = {name for name in members if name != manifest_name}
    seen: set[str] = set()
    total = 0
    errors: list[str] = []
    for item in raw:
        if not isinstance(item, dict):
            errors.append("candidate file inventory contains a malformed row")
            continue
        name, size, digest = item.get("path"), item.get("sizeBytes"), item.get("sha256")
        if (
            not isinstance(name, str)
            or _unsafe_member_path(name)
            or name in seen
            or not isinstance(size, int)
            or isinstance(size, bool)
            or size < 0
            or not isinstance(digest, str)
            or not SHA256_HEX.fullmatch(digest)
        ):
            errors.append("candidate file inventory contains an unsafe, duplicate, or malformed entry")
            continue
        seen.add(name)
        total += size
        if total > 4 * 1024 * 1024 * 1024:
            errors.append("candidate file inventory exceeds the 4 GiB bound")
            break
        actual_size = _artifact_member_size(path, name)
        actual_digest = _artifact_member_sha256(path, name, limit=4 * 1024 * 1024 * 1024)
        if actual_size != size or actual_digest != digest:
            errors.append(f"candidate file inventory does not match artifact member: {name}")
    binary_path = manifest.get("binaryPath")
    binary_size = manifest.get("binarySizeBytes")
    if (
        not isinstance(binary_path, str)
        or _unsafe_member_path(binary_path)
        or not isinstance(binary_size, int)
        or isinstance(binary_size, bool)
        or binary_size < 0
        or _artifact_member_size(path, binary_path) != binary_size
    ):
        errors.append("candidate provenance binary size does not match its regular artifact member")
    if seen != expected:
        errors.append("candidate file inventory does not enumerate every artifact member exactly once")
    return not errors, errors


def _artifact_legal_file_facts(path: Path, members: list[str]) -> list[dict]:
    facts = []
    for name in sorted(members):
        if _unsafe_member_path(name) or not LEGAL_BASENAME.match(PurePosixPath(name.replace("\\", "/")).name):
            continue
        contents = _read_artifact_member(path, name)
        if contents is None:
            facts.append({"path": name, "error": "missing, ambiguous, or larger than the 16 MiB audit limit"})
            continue
        facts.append({"path": name, "size": len(contents), "sha256": hashlib.sha256(contents).hexdigest()})
    return facts


def _artifact_file_facts(path: Path, members: list[str]) -> list[dict]:
    facts = []
    if not path.is_dir():
        return facts
    for name in members:
        item = path.joinpath(*PurePosixPath(name).parts)
        try:
            metadata = item.stat(follow_symlinks=False)
            facts.append(
                {
                    "path": name,
                    "size": metadata.st_size,
                    "mode": oct(metadata.st_mode & 0o777),
                    "mtime_ns": metadata.st_mtime_ns,
                    "sha256": _file_sha256(item),
                }
            )
        except OSError:
            facts.append({"path": name, "error": "file became unavailable during audit"})
    return facts


def inspect_artifact(path: Path) -> dict:
    requested_path = Path(os.path.abspath(path))
    symlink_component = next(
        (component for component in (requested_path, *requested_path.parents) if component.is_symlink()),
        None,
    )
    if symlink_component is not None:
        return {
            "path": str(requested_path),
            "status": "BLOCKED",
            "file_count": 0,
            "sha256": None,
            "file_facts": [],
            "legal_file_facts": [],
            "source_revision": None,
            "source_revision_bound": False,
            "source_state_sha256": None,
            "source_state_digest_valid": False,
            "source_state_digest_matches": False,
            "binary_path": None,
            "binary_sha256": None,
            "binary_digest_valid": False,
            "binary_digest_matches": False,
            "artifact_inventory_valid": False,
            "artifact_inventory_errors": ["artifact is unavailable or unsafe"],
            "legal_files": [],
            "contains_license_file": False,
            "contains_notice_file": False,
            "symlinks": [str(symlink_component)],
            "unsafe_paths": [],
            "members": [],
        }
    path = requested_path
    if not path.exists():
        return {
            "path": str(requested_path),
            "status": "MISSING",
            "members": [],
            "source_state_sha256": None,
            "source_state_digest_valid": False,
            "source_state_digest_matches": False,
            "binary_path": None,
            "binary_sha256": None,
            "binary_digest_valid": False,
            "binary_digest_matches": False,
            "artifact_inventory_valid": False,
            "artifact_inventory_errors": ["artifact is missing"],
        }
    try:
        members, symlinks = _artifact_members(path)
    except (OSError, tarfile.TarError, zipfile.BadZipFile, EOFError) as error:
        return {
            "path": str(requested_path),
            "status": "BLOCKED",
            "file_count": 0,
            "sha256": _file_sha256(path) if _regular_file(path) else None,
            "file_facts": [],
            "legal_file_facts": [],
            "source_revision": None,
            "source_revision_bound": False,
            "source_state_sha256": None,
            "source_state_digest_valid": False,
            "source_state_digest_matches": False,
            "binary_path": None,
            "binary_sha256": None,
            "binary_digest_valid": False,
            "binary_digest_matches": False,
            "artifact_inventory_valid": False,
            "artifact_inventory_errors": ["artifact inventory could not be read"],
            "legal_files": [],
            "contains_license_file": False,
            "contains_notice_file": False,
            "symlinks": [],
            "unsafe_paths": [],
            "members": [],
            "error": f"artifact inventory failed: {type(error).__name__}: {error}",
        }
    unsafe_paths = [
        name
        for name in members + symlinks
        if _unsafe_member_path(name)
    ]
    basenames = [PurePosixPath(name.replace("\\", "/")).name for name in members]
    licenses = sorted(name for name in basenames if LEGAL_BASENAME.match(name))
    has_license = any(re.match(r"^(license|licence|copying)(?:[._-].*)?$", name, re.I) for name in licenses)
    has_notice = any(
        re.match(r"^(notice|patents|third[._-]?party[._-]?notices?)(?:[._-].*)?$", name, re.I) for name in licenses
    )
    status = "REVIEW_REQUIRED" if has_license or has_notice else "BLOCKED"
    if unsafe_paths or symlinks:
        status = "BLOCKED"
    safe_members = [name for name in members if not _unsafe_member_path(name)]
    file_facts = _artifact_file_facts(path, safe_members)
    legal_file_facts = _artifact_legal_file_facts(path, safe_members)
    if any("error" in item for item in legal_file_facts):
        status = "BLOCKED"
    provenance_files = [
        name
        for name in safe_members
        if PurePosixPath(name).name.lower() in {"build-info.json", "provenance.json", "artifact-manifest.json", "release-manifest.json"}
    ]
    source_revision = None
    source_state_sha256 = None
    source_state_digest_valid = False
    binary_path = None
    binary_sha256 = None
    binary_digest_valid = False
    binary_digest_matches = False
    artifact_inventory_valid = False
    artifact_inventory_errors: list[str] = ["release manifest has no validated artifactFiles inventory"]
    for name in provenance_files:
        contents = _read_artifact_member(path, name)
        if contents is None:
            continue
        try:
            manifest = json.loads(contents.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            continue
        if not isinstance(manifest, dict):
            continue
        source_revision = manifest.get("sourceRevision") or manifest.get("source_commit") or manifest.get("gitHead")
        if source_revision:
            source_revision = str(source_revision)
        raw_source_digest = manifest.get("sourceStateSha256")
        if isinstance(raw_source_digest, str):
            source_state_sha256 = raw_source_digest
            source_state_digest_valid = bool(SHA256_HEX.fullmatch(raw_source_digest))
        raw_binary_path = manifest.get("binaryPath")
        raw_binary_digest = manifest.get("binarySha256")
        if isinstance(raw_binary_path, str):
            binary_path = raw_binary_path
        if isinstance(raw_binary_digest, str) and SHA256_HEX.fullmatch(raw_binary_digest):
            binary_sha256 = raw_binary_digest
            actual_binary_digest = _artifact_member_sha256(path, binary_path) if binary_path else None
            binary_digest_valid = actual_binary_digest is not None
            binary_digest_matches = actual_binary_digest == binary_sha256
        artifact_inventory_valid, artifact_inventory_errors = _validate_artifact_inventory(
            path, manifest, safe_members, name
        )
        if source_revision or source_state_sha256 or binary_path or binary_sha256:
            break
    return {
        "path": str(requested_path),
        "status": status,
        "file_count": len(members),
        "sha256": _file_sha256(path) if _regular_file(path) else None,
        "file_facts": file_facts,
        "legal_file_facts": legal_file_facts,
        "source_revision": source_revision,
        "source_revision_bound": bool(source_revision),
        "source_state_sha256": source_state_sha256,
        "source_state_digest_valid": source_state_digest_valid,
        "source_state_digest_matches": False,
        "binary_path": binary_path,
        "binary_sha256": binary_sha256,
        "binary_digest_valid": binary_digest_valid,
        "binary_digest_matches": binary_digest_matches,
        "artifact_inventory_valid": artifact_inventory_valid,
        "artifact_inventory_errors": artifact_inventory_errors,
        "legal_files": licenses,
        "contains_license_file": has_license,
        "contains_notice_file": has_notice,
        "symlinks": symlinks,
        "unsafe_paths": unsafe_paths,
        "members": members,
    }


def _discover_artifact(root: Path) -> Path | None:
    package_root = root / "packages" / "opencode"
    dist = package_root / "dist"
    if dist.is_dir():
        return dist
    for pattern in ("*.tgz", "*.tar.gz", "*.zip"):
        candidates = sorted(package_root.glob(pattern))
        if candidates:
            return candidates[0]
    return None


def _product_target(root_package: dict, app_package: dict) -> dict:
    workspace_name = root_package.get("name")
    package_name = app_package.get("name")
    normalized_workspace = workspace_name.lower() if isinstance(workspace_name, str) else ""
    normalized_package = package_name.lower() if isinstance(package_name, str) else ""
    workspace_identity = (
        "HORIZONCODE"
        if normalized_workspace == "horizoncode" or normalized_workspace.startswith("horizoncode-")
        else "OTHER"
    )
    if (
        normalized_package == "horizoncode"
        or normalized_package.startswith("horizoncode-")
        or normalized_package.startswith("@horizoncode/")
    ):
        classification = "HORIZONCODE"
    elif (
        normalized_package in {"opencode", "opencode-ai"}
        or normalized_package.startswith("opencode-")
        or normalized_package.startswith("@opencode-ai/")
    ):
        classification = "UPSTREAM_OPENCODE"
    else:
        classification = "UNCLASSIFIED"
    return {
        "workspace_package_name": workspace_name,
        "workspace_identity": workspace_identity,
        "package_name": package_name,
        "classification": classification,
        "is_horizoncode_package": classification == "HORIZONCODE",
        "is_upstream_opencode_package": classification == "UPSTREAM_OPENCODE",
    }


def _container_builder_has_push_command(source: str) -> bool:
    """Detect push flags on Docker command lines, not policy prose/comments."""
    executable_lines = "\n".join(
        line for line in source.splitlines() if not line.lstrip().startswith("//")
    )
    return bool(re.search(r"\bdocker\b[^\n]*(?:--push|\bpush\b)", executable_lines, re.IGNORECASE))


def _top_level_yaml_block(source: str, key: str) -> list[str] | None:
    """Read one indentation-based YAML top-level block without loading YAML."""
    lines = source.splitlines()
    header = f"{key}:"
    for index, line in enumerate(lines):
        if line != header:
            continue
        block: list[str] = []
        for candidate in lines[index + 1 :]:
            if candidate and not candidate[0].isspace():
                break
            block.append(candidate)
        return block
    return None


def _publication_workflow_is_fail_closed(source: str) -> bool:
    """Require the root publication workflow to be manual, read-only, and inert."""
    triggers = _top_level_yaml_block(source, "on")
    if triggers is None:
        return False
    trigger_names = [
        line.strip().removesuffix(":")
        for line in triggers
        if line.startswith("  ") and not line.startswith("   ") and line.strip()
    ]
    if trigger_names != ["workflow_dispatch"]:
        return False

    permissions = _top_level_yaml_block(source, "permissions")
    if permissions is None:
        return False
    permission_entries = [line.strip() for line in permissions if line.strip() and not line.lstrip().startswith("#")]
    if permission_entries != ["contents: read"]:
        return False

    jobs = _top_level_yaml_block(source, "jobs")
    if jobs is None:
        return False
    job_starts = [
        index
        for index, line in enumerate(jobs)
        if re.fullmatch(r"  [A-Za-z0-9_-]+:\s*", line)
    ]
    if not job_starts:
        return False
    for start_index, end_index in zip(job_starts, [*job_starts[1:], len(jobs)], strict=True):
        job = jobs[start_index:end_index]
        if not any(re.fullmatch(r"    if:\s*\$\{\{\s*false\s*\}\}\s*", line) for line in job):
            return False
    return True


def audit_repository(root: Path, artifact: Path | None = None) -> dict:
    requested_root = Path(os.path.abspath(root))
    if not _inside(requested_root, REPOSITORY_ROOT):
        raise ValueError(f"distribution audit source root must be inside this repository: {root}")
    _reject_symlink_components(requested_root, REPOSITORY_ROOT, "distribution audit source root")
    root = root.resolve()
    if not _inside(root, REPOSITORY_ROOT):
        raise ValueError(f"resolved distribution audit source root escapes this repository: {root}")
    if artifact is not None:
        requested_artifact = Path(os.path.abspath(artifact))
        if not _inside(requested_artifact, root):
            raise ValueError("distribution artifact must be inside the repository-local source root")
    manifest_errors: list[str] = []
    root_package = _read_manifest(root / "package.json", root, manifest_errors)
    app_package_path = root / "packages" / "opencode" / "package.json"
    app_package = _read_manifest(app_package_path, root, manifest_errors)
    root_license_path = root / "LICENSE"
    vendor_license_path = root / "opencode" / "LICENSE"
    root_license_regular = _regular_file(root_license_path, root)
    vendor_license_regular = _regular_file(vendor_license_path, root)
    root_license = _read_local_bytes(root_license_path, root, MAX_AUDIT_TEXT_BYTES) if root_license_regular else None
    vendor_license = _read_local_bytes(vendor_license_path, root, MAX_AUDIT_TEXT_BYTES) if vendor_license_regular else None
    root_license_matches_vendor = root_license is not None and vendor_license is not None and root_license == vendor_license
    tracked_root_license = root_license_regular and _is_tracked(root, "LICENSE")
    tracked_root_notice = any(
        _regular_file(root / name, root) and _is_tracked(root, name)
        for name in ("NOTICE", "NOTICE.md", "NOTICE.txt")
    )

    license_reasons = []
    if root_package.get("license") == "UNLICENSED":
        license_reasons.append("root package metadata is UNLICENSED")
    try:
        root_license_path.lstat()
        root_license_entry_present = True
    except OSError:
        root_license_entry_present = False
    if root_license_entry_present and not root_license_regular:
        license_reasons.append("root LICENSE is not a regular file")
    if root_license_matches_vendor:
        license_reasons.append("root LICENSE is byte-identical to the OpenCode vendor license and carries upstream-only attribution")
    if not tracked_root_license:
        license_reasons.append("no tracked first-party root distribution license was established")
    if not tracked_root_notice:
        license_reasons.append("no tracked first-party root distribution notice was established")
    if root_license_regular and root_license is None:
        license_reasons.append("root distribution license could not be safely read within the audit bound")
    if vendor_license_regular and vendor_license is None:
        license_reasons.append("vendor license could not be safely read within the audit bound")
    distribution_license_status = "BLOCKED" if license_reasons else "REVIEW_REQUIRED"
    first_party_license_decision_made = (
        root_package.get("license") == "MIT"
        and root_license_regular
        and tracked_root_license
        and not root_license_matches_vendor
        and tracked_root_notice
    )

    runtime_dependencies = scan_runtime_dependencies(root / "packages" / "opencode", root, manifest_errors) if app_package else {
        "basis": "no packages/opencode/package.json",
        "root_package": str(root / "packages" / "opencode"),
        "package_count": 0,
        "packages": [],
        "missing_license_metadata": [],
        "missing_license_files": [],
        "unresolved_required_dependencies": [],
        "unresolved_optional_dependencies": [],
        "inventory_errors": manifest_errors,
    }
    artifact_path = Path(os.path.abspath(artifact)) if artifact else _discover_artifact(root)
    artifact_report = inspect_artifact(artifact_path) if artifact_path else {
        "path": None,
        "status": "NOT_PROVIDED",
        "members": [],
        "contains_license_file": False,
        "contains_notice_file": False,
        "source_state_sha256": None,
        "source_state_digest_valid": False,
        "source_state_digest_matches": False,
        "binary_path": None,
        "binary_sha256": None,
        "binary_digest_valid": False,
        "binary_digest_matches": False,
    }
    source = _git_source_facts(root)

    installer = root / "install"
    installer_bytes = _read_local_bytes(installer, root, MAX_AUDIT_TEXT_BYTES)
    installer_text = installer_bytes.decode("utf-8", errors="replace") if installer_bytes is not None else ""
    installer_command_match = re.search(r"^COMMAND=(.+)$", installer_text, re.MULTILINE)
    installer_command = installer_command_match.group(1).strip().strip('"') if installer_command_match else None
    installer_alias_match = re.search(r"^ALIAS=(.+)$", installer_text, re.MULTILINE)
    installer_alias = installer_alias_match.group(1).strip().strip('"') if installer_alias_match else None
    package_bin = app_package.get("bin")
    workflow = root / ".github" / "workflows" / "publish.yml"
    workflow_bytes = _read_local_bytes(workflow, root, MAX_AUDIT_TEXT_BYTES)
    workflow_text = workflow_bytes.decode("utf-8", errors="replace") if workflow_bytes is not None else ""
    inherited_publication_workflows = (
        "publish-vscode.yml",
        "publish-github-action.yml",
        "release-github-action.yml",
        "containers.yml",
        "nix-hashes.yml",
    )
    disabled_workflow_facts: dict[str, bool] = {}
    workflow_git_visibility_facts: dict[str, bool] = {}
    for workflow_name in inherited_publication_workflows:
        relative_path = f".github/workflows/{workflow_name}"
        path = root / relative_path
        raw = _read_local_bytes(path, root, MAX_AUDIT_TEXT_BYTES)
        text = raw.decode("utf-8", errors="replace") if raw is not None else ""
        disabled_workflow_facts[workflow_name] = "if: ${{ false }}" in text
        workflow_git_visibility_facts[workflow_name] = raw is not None and _is_git_visible(root, relative_path)
    publisher = root / "packages" / "opencode" / "script" / "publish.ts"
    publisher_bytes = _read_local_bytes(publisher, root, MAX_AUDIT_TEXT_BYTES)
    publisher_text = publisher_bytes.decode("utf-8", errors="replace") if publisher_bytes is not None else ""
    container_builder = root / "packages" / "containers" / "script" / "build.ts"
    container_builder_bytes = _read_local_bytes(container_builder, root, MAX_AUDIT_TEXT_BYTES)
    container_builder_text = (
        container_builder_bytes.decode("utf-8", errors="replace") if container_builder_bytes is not None else ""
    )
    publisher_disabled = "HorizonCode publication is disabled pending release authorization." in publisher_text
    publisher_mutation_tokens = ("npm publish", "docker buildx build", "gh release upload", "git push")
    publisher_has_mutation = any(token in publisher_text for token in publisher_mutation_tokens)
    container_push_guard = 'if (process.argv.includes("--push") || process.env.PUSH === "1")'
    container_guard_index = container_builder_text.find(container_push_guard)
    container_docker_index = container_builder_text.find("docker build")
    container_has_push_command = _container_builder_has_push_command(container_builder_text)
    package_build = root / "packages" / "opencode" / "script" / "build.ts"
    package_build_bytes = _read_local_bytes(package_build, root, MAX_AUDIT_TEXT_BYTES)
    package_build_text = package_build_bytes.decode("utf-8", errors="replace") if package_build_bytes is not None else ""
    nix_package_bytes = _read_local_bytes(root / "nix" / "opencode.nix", root, MAX_AUDIT_TEXT_BYTES)
    nix_package_text = nix_package_bytes.decode("utf-8", errors="replace") if nix_package_bytes is not None else ""
    nix_package_license_claim = (
        "MIT"
        if re.search(r"(?m)^\s*license\s*=\s*lib\.licenses\.mit\s*;", nix_package_text)
        else None
    )
    package_release_upload_disabled = (
        re.search(
            r"HorizonCode release upload is unavailable (?:until|while)\b",
            package_build_text,
        )
        is not None
        and "gh release upload" not in package_build_text
    )
    release_source_paths = (
        ".github/workflows/publish.yml",
        "packages/opencode/script/publish.ts",
        "packages/opencode/script/build.ts",
        "packages/containers/README.md",
        "packages/containers/base/Dockerfile",
        "packages/containers/bun-node/Dockerfile",
        "packages/containers/rust/Dockerfile",
        "packages/containers/tauri-linux/Dockerfile",
        "packages/containers/publish/Dockerfile",
        "packages/containers/script/build.ts",
        "scripts/release/audit_distribution.py",
        "scripts/release/clean_install.py",
        "scripts/release/prepare_build.py",
        "scripts/release/release_gate.py",
        ".github/workflows/horizoncode-release-qualification.yml",
        "flake.nix",
        "flake.lock",
        "nix/opencode.nix",
        "nix/node_modules.nix",
        "nix/desktop.nix",
        "nix/hashes.json",
        "nix/scripts/canonicalize-node-modules.ts",
        "nix/scripts/normalize-bun-binaries.ts",
    )
    release_source_visibility = {
        name: (root / name).is_file() and _is_git_visible(root, name)
        for name in release_source_paths
    }
    container_dockerfiles = {
        name: _read_local_bytes(root / "packages" / "containers" / name / "Dockerfile", root, MAX_AUDIT_TEXT_BYTES)
        for name in ("bun-node", "rust", "tauri-linux", "publish")
    }
    container_local_chain_safe = (
        'process.env.REGISTRY ?? "localhost/horizoncode"' in container_builder_text
        and '"--build-arg"' in container_builder_text
        and '`IMAGE_TAG=${tag}`' in container_builder_text
        and all(
            raw is not None
            and "ARG REGISTRY=localhost/horizoncode" in raw.decode("utf-8", errors="replace")
            and "ARG IMAGE_TAG=24.04" in raw.decode("utf-8", errors="replace")
            and "${IMAGE_TAG}" in raw.decode("utf-8", errors="replace")
            for raw in container_dockerfiles.values()
        )
    )
    container_builder_rejects_publication = (
        container_guard_index >= 0
        and container_docker_index >= 0
        and container_guard_index < container_docker_index
        and not container_has_push_command
        and "HorizonCode container publication is disabled pending release authorization." in container_builder_text
    )

    blockers = []
    if distribution_license_status == "BLOCKED":
        blockers.extend(license_reasons)
    if app_package.get("private") is True:
        blockers.append("packages/opencode is private and is not a public package target")
    if package_bin != {"horizoncode": "./bin/horizoncode", "hzcode": "./bin/horizoncode"}:
        blockers.append("packages/opencode must expose horizoncode and hzcode from the same launcher")
    if installer_command != "horizoncode" or installer_alias != "hzcode":
        blockers.append("standalone installer must install horizoncode with the hzcode short command")
    if artifact_path is None:
        blockers.append("no built package artifact was supplied or found")
    elif artifact_report.get("status") == "BLOCKED":
        blockers.append("supplied artifact is missing legal files or contains unsafe links/paths")
    if artifact_path is not None and not artifact_report.get("artifact_inventory_valid"):
        blockers.append("candidate file inventory is missing, incomplete, or does not match the inspected artifact")
    if artifact_path is not None and not artifact_report.get("source_revision_bound"):
        blockers.append("inspected artifact does not carry commit-bound source/build provenance")
    if artifact_path is not None and not artifact_report.get("source_state_digest_valid"):
        blockers.append("inspected artifact does not carry a valid source-state SHA-256 provenance digest")
    if artifact_path is not None:
        artifact_report["source_state_digest_matches"] = bool(
            artifact_report.get("source_state_digest_valid")
            and source.get("source_state_sha256")
            and artifact_report.get("source_state_sha256") == source.get("source_state_sha256")
        )
        if artifact_report["source_state_digest_valid"] and not artifact_report["source_state_digest_matches"]:
            blockers.append("artifact source-state SHA-256 does not match the audited source tree")
        if not artifact_report.get("binary_digest_valid"):
            blockers.append("inspected artifact does not carry a verifiable candidate-binary SHA-256 digest")
        elif not artifact_report.get("binary_digest_matches"):
            blockers.append("artifact binary SHA-256 does not match its provenance manifest")
    for legal_fact in artifact_report.get("legal_file_facts", []):
        if "error" in legal_fact:
            blockers.append(f"archive legal file could not be inspected: {legal_fact['path']}")
    if "anomalyco/opencode" in installer_text or "anomalyco/opencode" in workflow_text:
        blockers.append("the available installer/workflow still targets the upstream anomalyco/opencode release")
    if "anomalyco/opencode" in workflow_text and "github.repository == 'anomalyco/opencode'" in workflow_text:
        blockers.append("the copied publish workflow only runs in the upstream anomalyco/opencode repository")
    enabled_inherited_publishers = [name for name, disabled in disabled_workflow_facts.items() if not disabled]
    if enabled_inherited_publishers:
        blockers.append(
            "inherited publication/update workflows are absent or not explicitly disabled: "
            + ", ".join(enabled_inherited_publishers)
        )
    hidden_workflow_overlays = [name for name, visible in workflow_git_visibility_facts.items() if not visible]
    if hidden_workflow_overlays:
        blockers.append(
            "publication workflow overlays are absent or hidden by Git ignore rules: "
            + ", ".join(hidden_workflow_overlays)
        )
    hidden_release_sources = [name for name, visible in release_source_visibility.items() if not visible]
    if hidden_release_sources:
        blockers.append(
            "release control sources are absent or hidden by Git ignore rules: "
            + ", ".join(hidden_release_sources)
        )
    publish_workflow_fail_closed = _publication_workflow_is_fail_closed(workflow_text)
    if not publish_workflow_fail_closed:
        blockers.append("root publication workflow is absent or not fail-closed")
    if not publisher_disabled or publisher_has_mutation:
        blockers.append("the direct package publisher is absent, not HorizonCode-disabled, or retains publication commands")
    if not container_builder_rejects_publication:
        blockers.append("the direct container builder is absent or does not reject push mode before build side effects")
    if not container_local_chain_safe:
        blockers.append("the local container build chain defaults to upstream image sources or lacks consistent local tag pinning")
    if not package_release_upload_disabled:
        blockers.append("the direct package build still permits or lacks a source guard for release upload")
    if not artifact_report.get("contains_license_file"):
        blockers.append("the inspected artifact has no LICENSE/COPYING file")
    if not artifact_report.get("contains_notice_file"):
        blockers.append("the inspected artifact has no separate NOTICE/PATENTS file")
    if runtime_dependencies["missing_license_metadata"]:
        blockers.append(
            f"{len(runtime_dependencies['missing_license_metadata'])} installed runtime packages have no license metadata; manual review required"
        )
    if runtime_dependencies["unresolved_required_dependencies"]:
        blockers.append(
            f"{len(runtime_dependencies['unresolved_required_dependencies'])} required runtime dependencies were not resolved from this checkout"
        )
    if runtime_dependencies["missing_license_files"]:
        blockers.append(
            f"{len(runtime_dependencies['missing_license_files'])} installed runtime packages have no direct LICENSE/NOTICE file; inspect package metadata and artifact contents"
        )
    if runtime_dependencies.get("inventory_errors"):
        blockers.append(
            f"{len(runtime_dependencies['inventory_errors'])} package manifest or dependency traversal errors prevent a complete license inventory"
        )

    if source["status"] != "CLEAN":
        blockers.append(f"source checkout is {source['status']}; release evidence requires a clean commit")
    artifact_revision = artifact_report.get("source_revision")
    if artifact_revision and source.get("revision") and artifact_revision != source["revision"]:
        blockers.append(
            f"artifact source revision {artifact_revision} does not match checkout revision {source['revision']}"
        )
    return {
        "schema_version": 1,
        "source_root": str(root),
        "source": source,
        "input_hashes": {
            "root_package_json": _file_sha256(root / "package.json", root),
            "opencode_package_json": _file_sha256(app_package_path, root),
            "bun_lock": _file_sha256(root / "bun.lock", root),
        },
        "distribution_license": {
            "status": distribution_license_status,
            "root_package_license": root_package.get("license"),
            "root_package_private": root_package.get("private"),
            "root_license_present": root_license is not None,
            "root_license_is_regular": root_license_regular,
            "root_license_tracked": tracked_root_license,
            "root_license_sha256": hashlib.sha256(root_license).hexdigest() if root_license is not None else None,
            "root_notice_tracked": tracked_root_notice,
            "vendor_license_present": vendor_license is not None,
            "vendor_license_sha256": hashlib.sha256(vendor_license).hexdigest() if vendor_license is not None else None,
            "root_license_matches_vendor": root_license_matches_vendor,
            "separate_notice_tracked": tracked_root_notice,
            "reasons": license_reasons,
            "legal_decision_made": first_party_license_decision_made,
        },
        "package_target": {
            "name": app_package.get("name"),
            "version": app_package.get("version"),
            "private": app_package.get("private"),
            "license": _license_value(app_package.get("license")),
            "bin": app_package.get("bin"),
            "npm_publish_script_present": "npm publish" in publisher_text,
            "direct_publisher_disabled": publisher_disabled,
            "direct_publisher_has_mutation_commands": publisher_has_mutation,
            "direct_container_builder_rejects_publication": container_builder_rejects_publication,
            "direct_container_builder_has_push_command": container_has_push_command,
            "container_local_chain_safe": container_local_chain_safe,
            "direct_package_release_upload_disabled": package_release_upload_disabled,
            "installer_app_name": re.search(r"^APP=(.+)$", installer_text, re.MULTILINE).group(1) if re.search(r"^APP=(.+)$", installer_text, re.MULTILINE) else None,
            "installer_command_name": installer_command,
            "installer_alias_name": installer_alias,
            "publish_workflow_upstream_guard": "github.repository == 'anomalyco/opencode'" in workflow_text,
            "publish_workflow_fail_closed": publish_workflow_fail_closed,
            "nix_package_license_claim": nix_package_license_claim,
            "inherited_publication_workflows_disabled": disabled_workflow_facts,
            "inherited_publication_workflows_git_visible": workflow_git_visibility_facts,
            "release_control_sources_git_visible": release_source_visibility,
        },
        "product_target": _product_target(root_package, app_package),
        "runtime_dependencies": runtime_dependencies,
        "artifact": artifact_report,
        "platform_support": {
            "v1_surface": "Linux/WSL CLI/TUI",
            "native_linux_acceptance": "NOT_VERIFIED",
            "wsl_acceptance": "NOT_VERIFIED",
            "native_windows": "UNAVAILABLE",
            "macos": "OUT_OF_SCOPE",
            "basis": "A static distribution audit does not execute platform acceptance tests.",
        },
        "blockers": list(dict.fromkeys(blockers)),
        "release_status": "BLOCKED" if blockers else "REVIEW_REQUIRED",
        "limitations": [
            "Package license metadata and adjacent legal files are inventory, not legal interpretation.",
            "Installed workspace dependencies are not a substitute for auditing the exact final shipping artifact and its native assets.",
            "A legal decision/redistribution grant must come from the user or legal counsel; this tool never chooses one.",
        ],
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--artifact", type=Path, help="built package/artifact directory, tarball, zip, or binary")
    parser.add_argument("--output", type=Path, help="write the full JSON audit to this path instead of stdout")
    parser.add_argument("--strict", action="store_true", help="exit 1 when any blocker remains")
    args = parser.parse_args()
    if __package__ in (None, ""):
        sys.path.insert(0, str(REPOSITORY_ROOT))
    from scripts.release.clean_install import _validated_output_path, _write_new_artifact_file

    output_path = _validated_output_path(args.output) if args.output else None
    report = audit_repository(args.root, args.artifact)
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if output_path:
        _write_new_artifact_file(output_path, encoded)
        print(f"release audit: {report['release_status']} ({len(report['blockers'])} blockers); report={output_path}")
    else:
        print(encoded, end="")
    return 1 if args.strict and report["blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
