#!/usr/bin/env python3
"""Dry-run planner for the HorizonCode first-party package-identity migration.

This tool is item-50 preparation: it reads ``scripts/release/IDENTITY-MAPPING.json``
and computes the *exact* transformation set a migration would apply — every
manifest name, workspace dependency edge, ``bun.lock`` edge, source import
specifier, documentation mention, generated-header string and runtime identifier
that would change under the plan's MIGRATE rows.

It is a planner, not a migrator:

* it never writes to the tree; the only write it can perform is the single
  explicit ``--output`` report file, created exclusively inside the root;
* it fails closed when the plan and the live workspace disagree (drift), so a
  stale plan can never be used to justify a rename;
* every MIGRATE row must either have at least one planned transform or carry an
  explicit ``no_transform_reason`` in the plan.

Vendor and upstream identities (the pinned ``opencode/**`` snapshot, the
``hold_vendor`` list, provider/API identifiers) are never planned as transforms.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath

REPO_ROOT = Path(__file__).resolve().parents[2]
PLAN_FILE = "scripts/release/IDENTITY-MAPPING.json"
LOCK_FILE = "bun.lock"
SCAN_BASES = ("packages", "scripts", "kernel", "nix", ".github")
ROOT_SCAN_FILES = ("package.json", "install", "flake.nix")
CODE_SUFFIXES = frozenset({".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".json"})
DOC_SUFFIXES = frozenset({".md", ".mdx"})
SKIP_PARTS = frozenset(
    {".git", "node_modules", "dist", "target", "target-p2", ".turbo", ".bun", ".tmp", "__pycache__"}
)
MAX_SCAN_FILE_BYTES = 4 * 1024 * 1024
MAX_LOCK_LINES_RECORDED = 200
MAX_SOURCE_LINES_RECORDED = 10
MAX_REPORT_BYTES = 32 * 1024 * 1024
DEPENDENCY_SECTIONS = ("dependencies", "devDependencies", "peerDependencies", "optionalDependencies")


def _read_jsonc(path: Path) -> dict:
    """Read Bun's JSONC lockfile, tolerating trailing commas only."""
    text = path.read_text(encoding="utf-8")
    stripped: list[str] = []
    in_string = False
    escaped = False
    for character in text:
        if in_string:
            stripped.append(character)
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                in_string = False
            continue
        if character == '"':
            in_string = True
            stripped.append(character)
            continue
        if character in "}]":
            while stripped and stripped[-1] in " \t\r\n":
                stripped.pop()
            if stripped and stripped[-1] == ",":
                stripped.pop()
        stripped.append(character)
    value = json.loads("".join(stripped))
    if not isinstance(value, dict):
        raise ValueError(f"{path}: lockfile root is not an object")
    return value


def _workspace_manifests(root: Path) -> dict[str, Path]:
    manifests = sorted(root.glob("packages/*/package.json")) + sorted(
        root.glob("packages/*/*/package.json")
    )
    found: dict[str, Path] = {}
    for path in manifests:
        manifest = json.loads(path.read_text(encoding="utf-8"))
        name = manifest.get("name")
        if not isinstance(name, str) or not name.strip():
            raise ValueError(
                f"workspace manifest {path.relative_to(root).as_posix()}"
                " must have a non-empty package name"
            )
        previous = found.get(name)
        if previous is not None:
            raise ValueError(
                f"duplicate workspace package name {name!r}: "
                f"{previous.relative_to(root).as_posix()} and {path.relative_to(root).as_posix()}"
            )
        found[name] = path
    return found


def _scoped_specifier_regex(package_id: str) -> re.Pattern[str]:
    return re.compile(r"""["']""" + re.escape(package_id) + r"""(?:/[^"']*)?["']""")


def _bare_import_regex(package_id: str) -> re.Pattern[str]:
    # A bare package id only counts inside a real import/require statement, so
    # prose, paths such as packages/opencode/... and CLI examples never become
    # planned transforms.
    return re.compile(
        r"""(?:from\s*|import\s+|import\s*\(\s*|require\(\s*)["']"""
        + re.escape(package_id)
        + r"""(?:/[^"']*)?["']"""
    )


def _iter_scan_files(root: Path):
    for base in SCAN_BASES:
        base_path = root / base
        if base_path.is_file():
            yield base_path
            continue
        if not base_path.is_dir():
            continue
        for path in sorted(base_path.rglob("*")):
            if not path.is_file() or path.is_symlink():
                continue
            # Skip decisions use root-relative parts so a repository nested
            # under a generated directory is not silently excluded.
            if any(part in SKIP_PARTS for part in path.relative_to(root).parts):
                continue
            if path.suffix.lower() not in CODE_SUFFIXES | DOC_SUFFIXES:
                continue
            try:
                if path.stat().st_size > MAX_SCAN_FILE_BYTES:
                    continue
            except OSError:
                continue
            yield path
    for relative in ROOT_SCAN_FILES:
        path = root / relative
        if path.is_file() and not path.is_symlink():
            yield path


def _plan_drift_error(message: str) -> ValueError:
    return ValueError(f"identity plan drift: {message}")


def build_migration_dry_run(root: Path) -> dict:
    """Compute the exact planned transformation set. Reads only; writes nothing."""
    root = root.resolve()
    plan_path = root / PLAN_FILE
    plan = json.loads(plan_path.read_text(encoding="utf-8"))
    plan_rows = plan.get("packages")
    if not isinstance(plan_rows, dict):
        raise ValueError(f"{plan_path}: packages map is missing")

    migrate = {name for name, row in plan_rows.items() if row.get("disposition") == "MIGRATE"}
    done = {name for name, row in plan_rows.items() if row.get("disposition") == "DONE"}
    hold_vendor = set(plan.get("hold_vendor", {}))
    manifests = _workspace_manifests(root)
    live_names = set(manifests)
    live_migrate = {name for name in live_names if name.startswith("@opencode-ai/") or name == "opencode"}
    live_done = {name for name in live_names if name.startswith("@horizoncode/")}

    drift: list[str] = []
    migration_targets: dict[str, str] = {}
    for name in sorted(migrate):
        target = plan_rows[name].get("target")
        if not isinstance(target, str) or not target.strip():
            drift.append(f"{name}: migration target must be a non-empty package id")
            continue
        if target in done:
            drift.append(f"{name}: target {target!r} already exists as a workspace package id")
        elif target in migration_targets:
            drift.append(
                f"duplicate migration target {target!r}: "
                f"{migration_targets[target]!r} and {name!r}"
            )
        else:
            migration_targets[target] = name
    if migrate != live_migrate:
        drift.append(f"MIGRATE rows {sorted(migrate ^ live_migrate)} do not match live workspace ids")
    if done != live_done:
        drift.append(f"DONE rows {sorted(done ^ live_done)} do not match live workspace ids")
    if live_names != migrate | done:
        drift.append(f"unclassified workspace packages: {sorted(live_names - migrate - done)}")
    overlapping_vendor = hold_vendor & live_names
    if overlapping_vendor:
        drift.append(f"vendor hold ids present as workspace packages: {sorted(overlapping_vendor)}")
    for name, row in plan_rows.items():
        own_manifest = row.get("own_manifest")
        if not isinstance(own_manifest, str) or not (root / own_manifest).is_file():
            drift.append(f"{name}: own_manifest {own_manifest!r} is missing")
        elif manifests.get(name) != root / own_manifest:
            drift.append(f"{name}: own_manifest does not resolve to the live workspace manifest")
    if drift:
        raise _plan_drift_error("; ".join(sorted(drift)))

    lock_path = root / LOCK_FILE
    lock_text = lock_path.read_text(encoding="utf-8") if lock_path.is_file() else ""
    lock_lines = lock_text.splitlines()
    _read_jsonc(lock_path) if lock_lines else None  # fail closed on a malformed lockfile

    patterns = {name: (_scoped_specifier_regex(name), _bare_import_regex(name)) for name in migrate}
    row_transforms: dict[str, list[dict]] = {name: [] for name in migrate}
    per_file_source_hits: dict[tuple[str, str], dict] = {}
    per_file_doc_hits: dict[tuple[str, str], dict] = {}

    for path in _iter_scan_files(root):
        relative = path.relative_to(root).as_posix()
        if relative == PLAN_FILE:
            continue  # the migration map describes identities; it is not a caller
        try:
            text = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        is_doc = path.suffix.lower() in DOC_SUFFIXES
        for name in migrate:
            own_manifest = plan_rows[name]["own_manifest"]
            if relative == own_manifest:
                continue
            scoped, bare = patterns[name]
            pattern = scoped if name.startswith("@") else bare
            hits = list(pattern.finditer(text))
            if not hits:
                continue
            key = (name, relative)
            bucket = per_file_doc_hits if is_doc else per_file_source_hits
            entry = bucket.setdefault(key, {"occurrences": 0, "lines": []})
            entry["occurrences"] += len(hits)
            if len(entry["lines"]) < MAX_SOURCE_LINES_RECORDED:
                entry["lines"].extend(
                    text.count("\n", 0, hit.start()) + 1 for hit in hits[: MAX_SOURCE_LINES_RECORDED]
                )

    for name in sorted(migrate):
        row = plan_rows[name]
        target = row["target"]
        transforms = row_transforms[name]

        transforms.append(
            {"kind": "manifest_name", "path": row["own_manifest"], "from": name, "to": target}
        )

        for other_name, manifest_path in sorted(manifests.items()):
            if other_name == name:
                continue
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            for section in DEPENDENCY_SECTIONS:
                values = manifest.get(section)
                if isinstance(values, dict) and name in values:
                    transforms.append(
                        {
                            "kind": "workspace_dependency_edge",
                            "path": manifest_path.relative_to(root).as_posix(),
                            "section": section,
                            "from": name,
                            "to": target,
                            "spec": str(values[name]),
                        }
                    )

        recorded_lock_lines = 0
        for index, line in enumerate(lock_lines, start=1):
            stripped = line.strip()
            planned: dict | None = None
            if stripped == f'"name": "{name}",':
                planned = {"kind": "lockfile_importer_name"}
            elif re.match(r'^"' + re.escape(name) + r'@', stripped):
                key = stripped.split(":", 1)[0].strip().rstrip(",").strip('"')
                planned = {"kind": "lockfile_resolution_key", "from_key": key, "to_key": key.replace(name, target, 1)}
            elif re.match(r'^"' + re.escape(name) + r'":\s*"', stripped):
                spec = stripped.split(":", 1)[1].strip().rstrip(",").strip('"')
                planned = {"kind": "lockfile_dependency_spec", "spec": spec}
            if planned is None:
                continue
            planned.update(
                {
                    "path": LOCK_FILE,
                    "line": index,
                    "from": name,
                    "to": target,
                    "recorded": recorded_lock_lines < MAX_LOCK_LINES_RECORDED,
                }
            )
            transforms.append(planned)
            recorded_lock_lines += 1

        for (source_name, relative), entry in sorted(per_file_source_hits.items()):
            if source_name != name:
                continue
            transforms.append(
                {
                    "kind": "source_import_specifier",
                    "path": relative,
                    "occurrences": entry["occurrences"],
                    "lines": entry["lines"][:MAX_SOURCE_LINES_RECORDED],
                    "from": name,
                    "to": target,
                }
            )
        for (source_name, relative), entry in sorted(per_file_doc_hits.items()):
            if source_name != name:
                continue
            transforms.append(
                {
                    "kind": "documentation_mention",
                    "path": relative,
                    "occurrences": entry["occurrences"],
                    "review_only": True,
                }
            )

        impact = row.get("impact", {})
        for detail in impact.get("generated_identifiers", []):
            transforms.append({"kind": "generated_identifier", "detail": str(detail), "manual": True})
        for detail in impact.get("runtime_identifiers", []):
            transforms.append({"kind": "runtime_identifier", "detail": str(detail), "manual": True})

        row_transforms[name] = transforms

    totals: dict[str, int] = {}
    for transforms in row_transforms.values():
        for item in transforms:
            totals[item["kind"]] = totals.get(item["kind"], 0) + 1

    planned_rows: dict[str, dict] = {}
    for name in sorted(migrate):
        row = plan_rows[name]
        transforms = row_transforms[name]
        counts: dict[str, int] = {}
        for item in transforms:
            counts[item["kind"]] = counts.get(item["kind"], 0) + 1
        planned_total = sum(
            value
            for kind, value in counts.items()
            if kind not in {"documentation_mention"}
        )
        planned_rows[name] = {
            "target": row["target"],
            "own_manifest": row["own_manifest"],
            "transform_counts": counts,
            "transforms": transforms,
            "completeness": (
                "transforms_planned"
                if planned_total
                else "no_transform_reason" if row.get("no_transform_reason") else "incomplete"
            ),
            "no_transform_reason": row.get("no_transform_reason"),
        }

    return {
        "schema": 1,
        "status": "DRY_RUN_ONLY",
        "writes_performed": False,
        "root": str(root),
        "plan_file": PLAN_FILE,
        "plan_sha256": hashlib.sha256(plan_path.read_bytes()).hexdigest(),
        "lockfile_sha256": hashlib.sha256(lock_text.encode("utf-8")).hexdigest() if lock_text else None,
        "scope": {
            "scan_bases": list(SCAN_BASES),
            "root_scan_files": list(ROOT_SCAN_FILES),
            "code_suffixes": sorted(CODE_SUFFIXES),
            "doc_suffixes": sorted(DOC_SUFFIXES),
            "skipped_parts": sorted(SKIP_PARTS),
            "bare_package_id_rule": "only import/require statements count; prose and paths never do",
        },
        "rows": planned_rows,
        "totals": {"rows": len(migrate), "transforms": sum(totals.values()), "by_kind": totals},
        "hold_vendor": sorted(hold_vendor),
        "preserve": plan.get("preserve", []),
    }


def _summary(report: dict) -> str:
    lines = [
        f"identity migration dry run: {report['status']} (writes_performed={report['writes_performed']})",
        f"plan: {report['plan_file']} sha256={report['plan_sha256'][:16]}…",
        f"rows: {report['totals']['rows']}  transforms: {report['totals']['transforms']}",
        "",
        f"{'package':38} {'target':34} transforms",
    ]
    for name, row in sorted(report["rows"].items()):
        counts = ", ".join(f"{kind}={value}" for kind, value in sorted(row["transform_counts"].items()))
        lines.append(f"{name:38} {row['target']:34} {counts} [{row['completeness']}]")
    lines.append("")
    lines.append("by kind: " + ", ".join(f"{k}={v}" for k, v in sorted(report["totals"]["by_kind"].items())))
    lines.append("No file was modified; this report is a plan, not an execution.")
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=REPO_ROOT, help="repository root to plan against")
    parser.add_argument("--output", type=Path, help="write the JSON report to this repo-local file")
    parser.add_argument("--json", action="store_true", help="print the full JSON report to stdout")
    args = parser.parse_args(argv)

    root = args.root.resolve()
    try:
        report = build_migration_dry_run(root)
    except ValueError as error:
        print(str(error), file=sys.stderr)
        return 2

    if args.output is not None:
        output = args.output if args.output.is_absolute() else (Path.cwd() / args.output)
        output = Path(os.path.abspath(output))
        try:
            output.relative_to(root)
        except ValueError:
            print("refusing to write the report outside the repository root", file=sys.stderr)
            return 2
        payload = json.dumps(report, indent=2, sort_keys=True) + "\n"
        if len(payload.encode("utf-8")) > MAX_REPORT_BYTES:
            print("report exceeds the bounded size; refusing to write", file=sys.stderr)
            return 2
        descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            stream.write(payload)

    print(json.dumps(report, indent=2, sort_keys=True) if args.json else _summary(report))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
