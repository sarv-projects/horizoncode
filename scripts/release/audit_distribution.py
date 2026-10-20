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
import tarfile
import zipfile


LEGAL_BASENAME = re.compile(
    r"^(license|licence|copying|notice|patents|third[._-]?party[._-]?notices?)(?:[._-].*)?$", re.IGNORECASE
)
SOURCE_OUTPUT_DIRS = frozenset({".git", ".turbo", ".cache", "__pycache__", "dist", "node_modules", "target"})
SHA256_HEX = re.compile(r"^[0-9a-f]{64}$")


def _read_manifest(path: Path) -> dict:
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return {}
    return value if isinstance(value, dict) else {}


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


def _file_sha256(path: Path) -> str | None:
    try:
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _regular_file(path: Path) -> bool:
    try:
        return stat.S_ISREG(path.stat(follow_symlinks=False).st_mode)
    except OSError:
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
        and ((root / name).exists() or (root / name).is_symlink())
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


def _resolve_dependency(package_root: Path, dependency: str) -> Path | None:
    for parent in (package_root, *package_root.parents):
        candidate = parent / "node_modules" / dependency / "package.json"
        if candidate.is_file():
            return candidate.resolve().parent
    return None


def _package_legal_files(package_root: Path) -> list[str]:
    try:
        return sorted(
            entry.name
            for entry in package_root.iterdir()
            if not entry.is_symlink() and entry.is_file() and LEGAL_BASENAME.match(entry.name)
        )
    except OSError:
        return []


def scan_runtime_dependencies(package_root: Path) -> dict:
    """Walk runtime/optional/required-peer dependencies from one package."""
    packages: dict[str, dict] = {}
    missing: list[dict] = []
    pending = [package_root.resolve()]
    visited: set[Path] = set()

    while pending:
        current = pending.pop()
        if current in visited:
            continue
        visited.add(current)
        manifest = _read_manifest(current / "package.json")
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

        for name, spec, is_optional in requirements:
            resolved = _resolve_dependency(current, name)
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
            dependency_manifest = _read_manifest(resolved / "package.json")
            package_name = str(dependency_manifest.get("name", name))
            version = str(dependency_manifest.get("version", "unknown"))
            key = f"{package_name}@{version}:{resolved}"
            if key not in packages:
                packages[key] = {
                    "name": package_name,
                    "version": version,
                    "license": _license_value(dependency_manifest.get("license")),
                    "path": str(resolved),
                    "license_files": _package_legal_files(resolved),
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


def audit_repository(root: Path, artifact: Path | None = None) -> dict:
    root = root.resolve()
    root_package = _read_manifest(root / "package.json")
    app_package_path = root / "packages" / "opencode" / "package.json"
    app_package = _read_manifest(app_package_path)
    root_license_path = root / "LICENSE"
    vendor_license_path = root / "opencode" / "LICENSE"
    root_license_regular = _regular_file(root_license_path)
    vendor_license_regular = _regular_file(vendor_license_path)
    root_license = root_license_path.read_bytes() if root_license_regular else None
    vendor_license = vendor_license_path.read_bytes() if vendor_license_regular else None
    root_license_matches_vendor = root_license is not None and vendor_license is not None and root_license == vendor_license
    tracked_root_license = root_license_regular and _is_tracked(root, "LICENSE")

    license_reasons = []
    if root_package.get("license") == "UNLICENSED":
        license_reasons.append("root package metadata is UNLICENSED")
    if (root_license_path.exists() or root_license_path.is_symlink()) and not root_license_regular:
        license_reasons.append("root LICENSE is not a regular file")
    if root_license_matches_vendor:
        license_reasons.append("root LICENSE is byte-identical to the OpenCode vendor license and carries upstream-only attribution")
    if not tracked_root_license:
        license_reasons.append("no tracked first-party root distribution license was established")
    distribution_license_status = "BLOCKED" if license_reasons else "REVIEW_REQUIRED"

    runtime_dependencies = scan_runtime_dependencies(root / "packages" / "opencode") if app_package else {
        "basis": "no packages/opencode/package.json",
        "root_package": str(root / "packages" / "opencode"),
        "package_count": 0,
        "packages": [],
        "missing_license_metadata": [],
        "missing_license_files": [],
        "unresolved_required_dependencies": [],
        "unresolved_optional_dependencies": [],
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
    installer_text = installer.read_text(encoding="utf-8", errors="replace") if installer.is_file() else ""
    installer_command_match = re.search(r"^COMMAND=(.+)$", installer_text, re.MULTILINE)
    installer_command = installer_command_match.group(1).strip().strip('"') if installer_command_match else None
    installer_alias_match = re.search(r"^ALIAS=(.+)$", installer_text, re.MULTILINE)
    installer_alias = installer_alias_match.group(1).strip().strip('"') if installer_alias_match else None
    package_bin = app_package.get("bin")
    workflow = root / ".github" / "workflows" / "publish.yml"
    workflow_text = workflow.read_text(encoding="utf-8", errors="replace") if workflow.is_file() else ""
    publisher = root / "packages" / "opencode" / "script" / "publish.ts"
    publisher_text = publisher.read_text(encoding="utf-8", errors="replace") if publisher.is_file() else ""

    blockers = []
    if distribution_license_status == "BLOCKED":
        blockers.extend(license_reasons)
    if app_package.get("private") is True:
        blockers.append("packages/opencode is private and is not a public package target")
    if package_bin != {"horizoncode": "./bin/opencode", "hzcode": "./bin/opencode"}:
        blockers.append("packages/opencode must expose horizoncode and hzcode from the same launcher")
    if installer_command != "horizoncode" or installer_alias != "hzcode":
        blockers.append("standalone installer must install horizoncode with the hzcode short command")
    if artifact_path is None:
        blockers.append("no built package artifact was supplied or found")
    elif artifact_report.get("status") == "BLOCKED":
        blockers.append("supplied artifact is missing legal files or contains unsafe links/paths")
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
            "root_package_json": _file_sha256(root / "package.json"),
            "opencode_package_json": _file_sha256(app_package_path),
            "bun_lock": _file_sha256(root / "bun.lock"),
        },
        "distribution_license": {
            "status": distribution_license_status,
            "root_package_license": root_package.get("license"),
            "root_package_private": root_package.get("private"),
            "root_license_present": root_license is not None,
            "root_license_is_regular": root_license_regular,
            "root_license_tracked": tracked_root_license,
            "root_license_sha256": hashlib.sha256(root_license).hexdigest() if root_license is not None else None,
            "vendor_license_present": vendor_license is not None,
            "vendor_license_sha256": hashlib.sha256(vendor_license).hexdigest() if vendor_license is not None else None,
            "root_license_matches_vendor": root_license_matches_vendor,
            "separate_notice_tracked": any(
                _regular_file(root / name) and _is_tracked(root, name)
                for name in ("NOTICE", "NOTICE.md", "NOTICE.txt")
            ),
            "reasons": license_reasons,
            "legal_decision_made": False,
        },
        "package_target": {
            "name": app_package.get("name"),
            "version": app_package.get("version"),
            "private": app_package.get("private"),
            "license": _license_value(app_package.get("license")),
            "bin": app_package.get("bin"),
            "npm_publish_script_present": "npm publish" in publisher_text,
            "installer_app_name": re.search(r"^APP=(.+)$", installer_text, re.MULTILINE).group(1) if re.search(r"^APP=(.+)$", installer_text, re.MULTILINE) else None,
            "installer_command_name": installer_command,
            "installer_alias_name": installer_alias,
            "publish_workflow_upstream_guard": "github.repository == 'anomalyco/opencode'" in workflow_text,
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
    report = audit_repository(args.root, args.artifact)
    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
        print(f"release audit: {report['release_status']} ({len(report['blockers'])} blockers); report={args.output}")
    else:
        print(encoded, end="")
    return 1 if args.strict and report["blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
