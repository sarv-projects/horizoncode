#!/usr/bin/env python3
"""Apply MIGRATE rows from scripts/release/IDENTITY-MAPPING.json (first-party rename only)."""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
PLAN_FILE = REPO_ROOT / "scripts/release/IDENTITY-MAPPING.json"
SCAN_BASES = ("packages", "scripts", "kernel", "nix", ".github")
ROOT_SCAN_FILES = ("package.json", "bun.lock", "flake.nix")
SKIP_PARTS = frozenset(
    {".git", "node_modules", "dist", "target", "target-p2", ".turbo", ".bun", ".tmp", "__pycache__"}
)
PRESERVE_PREFIXES = (
    "opencode/",
    "docs/architecture-archive/",
)
DEP_SECTIONS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")
TEXT_SUFFIXES = frozenset(
    {
        ".ts",
        ".tsx",
        ".js",
        ".jsx",
        ".mjs",
        ".cjs",
        ".json",
        ".md",
        ".mdx",
        ".yml",
        ".yaml",
        ".sh",
        ".rs",
        ".nix",
        ".toml",
        ".snap",
        ".css",
        ".Dockerfile",
        ".dockerfile",
    }
)


def should_skip(relative: str) -> bool:
    if relative == "scripts/release/IDENTITY-MAPPING.json":
        return True
    for prefix in PRESERVE_PREFIXES:
        if relative.startswith(prefix):
            return True
    return False


def iter_files(root: Path):
    for base in SCAN_BASES:
        base_path = root / base
        if not base_path.exists():
            continue
        if base_path.is_file():
            yield base_path
            continue
        for path in sorted(base_path.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            rel = path.relative_to(root).as_posix()
            if any(part in SKIP_PARTS for part in path.relative_to(root).parts):
                continue
            if should_skip(rel):
                continue
            if path.suffix.lower() not in TEXT_SUFFIXES and path.name not in ROOT_SCAN_FILES:
                continue
            yield path
    for name in ROOT_SCAN_FILES:
        path = root / name
        if path.is_file():
            rel = path.relative_to(root).as_posix()
            if not should_skip(rel):
                yield path


def main() -> int:
    plan = json.loads(PLAN_FILE.read_text(encoding="utf-8"))
    rows = plan["packages"]
    pairs = [
        (name, row["target"])
        for name, row in rows.items()
        if row.get("disposition") == "MIGRATE"
    ]
    # Longest source ids first so scoped names do not partially overlap.
    pairs.sort(key=lambda item: len(item[0]), reverse=True)

    path_replacements = [
        ("packages/opencode/", "packages/horizoncode/"),
        ("packages/opencode", "packages/horizoncode"),
    ]

    changed_files = 0
    for path in iter_files(REPO_ROOT):
        rel = path.relative_to(REPO_ROOT).as_posix()
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError):
            continue
        original = text

        for old, new in path_replacements:
            text = text.replace(old, new)

        for source, target in pairs:
            if source.startswith("@"):
                text = text.replace(source, target)

        # Host workspace package id (not vendor ids such as opencode-gitlab-auth).
        text = re.sub(r'"name"\s*:\s*"opencode"', '"name": "horizoncode"', text)
        text = re.sub(
            r'"opencode"\s*:\s*"workspace:\*"',
            '"horizoncode": "workspace:*"',
            text,
        )
        text = text.replace(
            '"opencode@workspace:packages/horizoncode"',
            '"horizoncode@workspace:packages/horizoncode"',
        )
        text = text.replace(
            'opencode@workspace:packages/horizoncode',
            'horizoncode@workspace:packages/horizoncode',
        )

        if path.name == "package.json":
            try:
                data = json.loads(text)
            except json.JSONDecodeError:
                pass
            else:
                updated = False
                if isinstance(data, dict) and data.get("name") == "opencode":
                    data["name"] = "horizoncode"
                    updated = True
                if isinstance(data, dict):
                    for section in DEP_SECTIONS:
                        deps = data.get(section)
                        if isinstance(deps, dict) and "opencode" in deps and deps["opencode"] == "workspace:*":
                            deps["horizoncode"] = deps.pop("opencode")
                            updated = True
                if updated:
                    text = json.dumps(data, indent=2) + "\n"

        if text != original:
            path.write_text(text, encoding="utf-8")
            changed_files += 1

    # Fix host manifest path in the plan file (documentation of record).
    plan_text = PLAN_FILE.read_text(encoding="utf-8")
    plan_text = plan_text.replace(
        '"own_manifest": "packages/opencode/package.json"',
        '"own_manifest": "packages/horizoncode/package.json"',
    )
    plan_text = plan_text.replace(
        '"packages/opencode importer name"',
        '"packages/horizoncode importer name"',
    )
    plan_text = plan_text.replace(
        "opencode@workspace:packages/opencode",
        "horizoncode@workspace:packages/horizoncode",
    )
    if plan_text != PLAN_FILE.read_text(encoding="utf-8"):
        PLAN_FILE.write_text(plan_text, encoding="utf-8")
        changed_files += 1

    print(f"apply_identity_migration: updated {changed_files} files")
    return 0


if __name__ == "__main__":
    sys.exit(main())
