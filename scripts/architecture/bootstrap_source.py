#!/usr/bin/env python3
"""Hydrate only absent files from HorizonCode's pinned OpenCode source snapshot.

The pinned source lives at opencode/. First-party overlays already checked out
at the repository root take priority. Never overwrite any existing file.
Use --check by default; use --apply to restore missing files on a fresh clone.
"""
from __future__ import annotations

import argparse
import shutil
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "opencode"
# SNAPSHOT is already the top-level `opencode` directory; a nested packages/opencode is source.
# The nested packages/opencode workspace is required by Bun; do not skip it.
# The pinned source root itself is never hydrated as a relative directory.
SKIP = {
    ".git", ".turbo", ".cache", ".next", "dist", "build",
    "node_modules", "target", ".venv",
}
# Files the first-party overlay deliberately deleted from the repository after
# the snapshot was pinned (commit bc439637a removed the upstream translated
# READMEs and their screenshot alongside the de-upstreamed root README). Those
# deletions are authoritative: not being on disk is not drift, and `--apply`
# must never resurrect them from the snapshot.
FIRST_PARTY_DELETIONS = frozenset({
    *(
        f"README.{lang}.md" for lang in (
            "ar", "bn", "br", "bs", "da", "de", "es", "fr", "gr", "it",
            "ja", "ko", "no", "pl", "ru", "th", "tr", "uk", "vi", "zh", "zht",
        )
    ),
    "screenshot-uk.png",
})


def candidates():
    if not SNAPSHOT.is_dir():
        raise RuntimeError(f"Pinned OpenCode source snapshot missing: {SNAPSHOT}")
    for source in sorted(SNAPSHOT.rglob("*")):
        relative = source.relative_to(SNAPSHOT)
        if any(segment in SKIP for segment in relative.parts):
            continue
        # The runtime workspace is packages/horizoncode. The snapshot still carries
        # the older packages/opencode tree, and hydrating it alongside the renamed
        # workspace puts two conflicting dependency graphs in the same Bun workspace
        # root, which makes a fresh `bun install` fail with every @opencode-ai/*
        # dependency unresolved. Never materialise it.
        if relative.parts[:2] == ("packages", "opencode"):
            continue
        if str(relative) in FIRST_PARTY_DELETIONS:
            continue
        if source.is_symlink():
            link = source.readlink()
            if link.is_absolute() or not (source.parent / link).resolve().is_relative_to(SNAPSHOT.resolve()):
                raise RuntimeError(f"Symlink escapes pinned source snapshot: {relative} -> {link}")
            yield source, ROOT / relative
        elif source.is_file():
            yield source, ROOT / relative


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--check", action="store_true", help="Report missing files; do not copy (default)")
    mode.add_argument("--apply", action="store_true", help="Copy missing files only")
    parser.add_argument("--require-complete", action="store_true", help="Fail in check mode if any pinned files are missing")
    args = parser.parse_args()

    existing = missing = copied = 0
    for source, target in candidates():
        if target.exists() or target.is_symlink():
            existing += 1
            continue
        missing += 1
        if not args.apply:
            continue
        target.parent.mkdir(parents=True, exist_ok=True)
        if target.exists() or target.is_symlink():
            raise RuntimeError(f"Destination appeared during hydration: {target}")
        if source.is_symlink():
            target.symlink_to(source.readlink())
        else:
            shutil.copy2(source, target)
        copied += 1

    if args.apply and not (ROOT / "packages/horizoncode/package.json").is_file():
        raise RuntimeError("Required Bun workspace packages/horizoncode is missing")

    print(
        f"PINNED_SOURCE_BOOTSTRAP existing={existing} "
        f"missing={missing} copied={copied} "
        f"mode={'apply' if args.apply else 'check'}"
    )
    if not args.apply and missing:
        print("Run with --apply only on a fresh checkout after inspecting status.")
        if args.require_complete:
            return 1
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (OSError, RuntimeError) as error:
        print(f"BOOTSTRAP_FAILED: {error}", file=sys.stderr)
        sys.exit(1)
