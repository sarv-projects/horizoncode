#!/usr/bin/env python3
"""Fail when a HorizonCode root overlay delta is hidden by Git.

The pinned upstream source is tracked under opencode/. The runnable workspace is
hydrated at the repository root. Identical upstream copies may stay ignored, but
any file that differs from the pinned snapshot must be Git-visible so a commit
cannot silently omit HorizonCode behavior.
"""
from __future__ import annotations
import hashlib
import os
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
SNAPSHOT = ROOT / "opencode"
SKIP = {".git", "node_modules", ".turbo", "target", "dist", "build", ".next", ".cache", ".venv", "vendor"}
def skip_scan_dir(name: str) -> bool:
    # Generated E2E workspaces are ignored artifacts, not overlay source.
    return name in SKIP or name.startswith(".horizoncode-e2e-")
FIRST_PARTY_NEW_ROOTS = (
    ROOT / "packages",
    ROOT / "kernel",
    ROOT / "indexd",
    ROOT / "scripts",
    ROOT / "arch_V1",
    ROOT / "docs" / "superpowers",
    ROOT / ".github" / "workflows",
)
SOURCE_SUFFIXES = {
    ".ts", ".tsx", ".rs", ".py", ".js", ".jsx", ".mjs", ".cjs",
    ".json", ".jsonc", ".toml", ".yml", ".yaml", ".sh", ".md", ".mdx",
    ".sql", ".proto", ".kdl", ".css", ".scss", ".html", ".xml",
}

def digest(path: Path) -> bytes:
    h = hashlib.sha256()
    with path.open("rb") as f:
        for chunk in iter(lambda: f.read(1024 * 1024), b""):
            h.update(chunk)
    return h.digest()

def ignored(path: str) -> bool:
    return subprocess.run(
        ["git", "check-ignore", "-q", "--", path],
        cwd=ROOT,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    ).returncode == 0

def main() -> int:
    if not SNAPSHOT.is_dir():
        print("OVERLAY_AUDIT_FAILED: pinned opencode/ snapshot is missing", file=sys.stderr)
        return 1
    deltas: list[str] = []
    missing: list[str] = []
    symlink_deltas: list[str] = []
    compared = 0
    for base, dirs, files in os.walk(SNAPSHOT):
        dirs[:] = sorted(d for d in dirs if d not in SKIP)
        for name in sorted(files):
            source = Path(base) / name
            rel = source.relative_to(SNAPSHOT)
            if any(part in SKIP for part in rel.parts):
                continue
            target = ROOT / rel
            compared += 1
            if source.is_symlink():
                if not target.is_symlink() or os.readlink(source) != os.readlink(target):
                    symlink_deltas.append(rel.as_posix())
                continue
            if not target.exists():
                missing.append(rel.as_posix())
                continue
            if not target.is_file():
                deltas.append(rel.as_posix())
                continue
            if source.stat().st_size != target.stat().st_size or digest(source) != digest(target):
                deltas.append(rel.as_posix())
    hidden = [path for path in deltas + symlink_deltas if ignored(path)]

    hidden_new_source: list[str] = []
    for root in FIRST_PARTY_NEW_ROOTS:
        if not root.exists():
            continue
        for base, dirs, files in os.walk(root):
            dirs[:] = sorted(d for d in dirs if not skip_scan_dir(d))
            for name in sorted(files):
                target = Path(base) / name
                if target.suffix.lower() not in SOURCE_SUFFIXES and name != "Dockerfile":
                    continue
                rel = target.relative_to(ROOT)
                if (SNAPSHOT / rel).exists():
                    continue
                if ignored(rel.as_posix()):
                    hidden_new_source.append(rel.as_posix())

    stale_unignore: list[str] = []
    for line_number, raw in enumerate((ROOT / ".gitignore").read_text().splitlines(), 1):
        if not raw.startswith("!/") or any(token in raw for token in ("*", "?", "[")):
            continue
        relative = raw[2:]
        if relative.endswith("/"):
            continue
        if not (ROOT / relative).exists():
            stale_unignore.append(f"{line_number}:{relative}")

    print(
        f"OVERLAY_VISIBILITY compared={compared} changed={len(deltas)} "
        f"missing={len(missing)} symlink_delta={len(symlink_deltas)} "
        f"hidden_changed={len(hidden)} hidden_new_source={len(hidden_new_source)} "
        f"stale_unignore={len(stale_unignore)}"
    )
    for path in hidden:
        print(f"HIDDEN_CHANGED {path}")
    for path in hidden_new_source:
        print(f"HIDDEN_NEW_SOURCE {path}")
    for entry in stale_unignore:
        print(f"STALE_UNIGNORE {entry}")
    for path in missing[:50]:
        print(f"MISSING_HYDRATED {path}")
    if hidden:
        print("Every changed root overlay file must be unignored explicitly.", file=sys.stderr)
        return 1
    if hidden_new_source:
        print("Every first-party source file without an upstream counterpart must be Git-visible.", file=sys.stderr)
        return 1
    if stale_unignore:
        print("Remove or repair exact Git unignore rules that point to missing files.", file=sys.stderr)
        return 1
    if missing:
        print("Run bootstrap_source.py --apply on an incomplete hydrated checkout.", file=sys.stderr)
        return 1
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
