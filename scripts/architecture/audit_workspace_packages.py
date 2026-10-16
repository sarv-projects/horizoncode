#!/usr/bin/env python3
"""Static workspace/package manifest audit for the HorizonCode monorepo."""

from __future__ import annotations

import glob
import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]


def target_exists(package_dir: Path, value: object) -> bool:
    if not isinstance(value, str) or not value.startswith("./"):
        return True
    if "*" in value:
        prefix = value.split("*", 1)[0]
        return (package_dir / prefix).parent.exists()
    target = package_dir / value
    if target.exists():
        return True
    return any(Path(str(target) + suffix).exists() for suffix in (".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"))


def export_targets(value: object, label: str = "exports"):
    if isinstance(value, str):
        yield label, value
    elif isinstance(value, dict):
        for key, nested in value.items():
            yield from export_targets(nested, f"{label}.{key}")


def main() -> int:
    root_package = json.loads((ROOT / "package.json").read_text())
    workspace_config = root_package.get("workspaces", {})
    patterns = workspace_config.get("packages", workspace_config) if isinstance(workspace_config, dict) else workspace_config
    if not isinstance(patterns, list):
        print("PACKAGE_AUDIT_FAILED root workspaces.packages is not a list", file=sys.stderr)
        return 1

    resolved: dict[Path, Path] = {}
    for pattern in patterns:
        if not isinstance(pattern, str):
            continue
        for raw in glob.glob(str(ROOT / pattern)):
            path = Path(raw)
            if path.is_dir() and (path / "package.json").is_file():
                resolved[path.resolve()] = path

    package_dirs = sorted(resolved.values())
    errors: list[str] = []
    names: dict[str, str] = {}
    packages: list[tuple[Path, dict]] = []

    for package_dir in package_dirs:
        rel = package_dir.relative_to(ROOT).as_posix()
        try:
            package = json.loads((package_dir / "package.json").read_text())
        except Exception as error:
            errors.append(f"INVALID_PACKAGE_JSON {rel}: {error}")
            continue
        name = package.get("name")
        if not isinstance(name, str) or not name:
            errors.append(f"MISSING_PACKAGE_NAME {rel}")
        elif name in names:
            errors.append(f"DUPLICATE_PACKAGE_NAME {name}: {names[name]} and {rel}")
        else:
            names[name] = rel
        packages.append((package_dir, package))

    # E2E fixture sandboxes are hidden beneath packages/ but are not workspace members.
    # Exclude only this owned sandbox namespace; other hidden package manifests remain
    # visible to the undeclared-package check.
    e2e_sandbox = ".horizoncode-e2e-"
    all_package_dirs = {
        path.parent.resolve()
        for path in (ROOT / "packages").rglob("package.json")
        if "node_modules" not in path.parts
        and "dist" not in path.parts
        and not any(part.startswith(e2e_sandbox) for part in path.relative_to(ROOT / "packages").parts)
    }
    undeclared = sorted(path.relative_to(ROOT).as_posix() for path in all_package_dirs if path not in resolved)
    for rel in undeclared:
        errors.append(f"UNDECLARED_PACKAGE_DIRECTORY {rel}")

    internal_names = set(names)
    dependency_buckets = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
    for package_dir, package in packages:
        rel = package_dir.relative_to(ROOT).as_posix()
        for bucket in dependency_buckets:
            dependencies = package.get(bucket) or {}
            if not isinstance(dependencies, dict):
                errors.append(f"INVALID_DEPENDENCY_MAP {rel} {bucket}")
                continue
            for dependency, version in dependencies.items():
                if isinstance(version, str) and version.startswith("workspace:") and dependency not in internal_names:
                    errors.append(f"BROKEN_WORKSPACE_DEPENDENCY {rel} {bucket} {dependency}={version}")

        for label, value in export_targets(package.get("exports")):
            if not target_exists(package_dir, value):
                errors.append(f"MISSING_PACKAGE_TARGET {rel} {label} -> {value}")

        binary = package.get("bin")
        if isinstance(binary, str):
            if not target_exists(package_dir, binary):
                errors.append(f"MISSING_PACKAGE_TARGET {rel} bin -> {binary}")
        elif isinstance(binary, dict):
            for name, value in binary.items():
                if not target_exists(package_dir, value):
                    errors.append(f"MISSING_PACKAGE_TARGET {rel} bin.{name} -> {value}")

        for field in ("main", "module", "types", "typings"):
            value = package.get(field)
            if target_exists(package_dir, value):
                continue
            generated = (
                isinstance(value, str)
                and value.startswith(("./out/", "./dist/", "./build/"))
                and isinstance((package.get("scripts") or {}).get("build"), str)
            )
            if not generated:
                errors.append(f"MISSING_PACKAGE_TARGET {rel} {field} -> {value}")

    print(
        "WORKSPACE_PACKAGE_AUDIT"
        f" workspaces={len(package_dirs)}"
        f" unique_names={len(names)}"
        f" undeclared={len(undeclared)}"
        f" with_typecheck={sum(bool((package.get('scripts') or {}).get('typecheck')) for _, package in packages)}"
        f" with_test_script={sum(bool((package.get('scripts') or {}).get('test')) for _, package in packages)}"
        f" errors={len(errors)}"
    )
    for error in errors:
        print(error)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
