#!/usr/bin/env python3
"""Check Cargo workspace dependency direction against ARCH/05-MODULARITY.md.

Consumes `cargo metadata --no-deps` JSON on stdin so the caller controls the
toolchain/metadata invocation and this checker never downloads or executes code.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]

# Lower indexes are closer to foundation types. A package may depend only on
# its own layer or a lower layer. This classifies the checked-in 16-crate graph;
# a newly introduced workspace crate must be assigned deliberately.
LAYERS: tuple[tuple[str, tuple[str, ...]], ...] = (
    (
        "foundation",
        (
            "horizoncode-types",
            "horizoncode-config",
            "horizoncode-commands",
            "horizoncode-testkit",
        ),
    ),
    (
        "state",
        (
            "horizoncode-eventlog",
            "horizoncode-session",
            "horizoncode-audit",
            "horizoncode-artifact",
            "horizoncode-analytics",
        ),
    ),
    (
        "capability-services",
        (
            "horizoncode-provider",
            "horizoncode-guard",
            "horizoncode-sandbox",
            "horizoncode-tools",
        ),
    ),
    ("application-control", ("horizoncode-runner",)),
    ("surfaces", ("horizoncode-acp", "horizoncode-cli")),
)
PACKAGE_LAYER = {
    package: (index, layer)
    for index, (layer, packages) in enumerate(LAYERS)
    for package in packages
}

# These dependencies belong at an adapter or surface boundary, never in core.
# This is an explicit denylist, not a claim to recognize every third-party crate.
FORBIDDEN_EXTERNALS: dict[str, str] = {
    "ratatui": "terminal UI framework",
    "crossterm": "terminal UI framework",
    "termion": "terminal UI framework",
    "tui": "terminal UI framework",
    "tui-textarea": "terminal UI framework",
    "tui-input": "terminal UI framework",
    "reedline": "terminal UI framework",
    "git2": "concrete Git/workspace engine",
    "gix": "concrete Git/workspace engine",
    "gitoxide": "concrete Git/workspace engine",
    "libgit2-sys": "concrete Git/workspace engine",
    "bollard": "concrete container/workspace engine",
    "containerd-client": "concrete container/workspace engine",
    "async-openai": "provider SDK",
    "openai-api-rs": "provider SDK",
    "anthropic-sdk": "provider SDK",
    "anthropic": "provider SDK",
    "genai": "provider SDK",
    "google-generative-ai": "provider SDK",
    "google-ai": "provider SDK",
    "aws-sdk-bedrockruntime": "provider SDK",
    "azure-ai-inference": "provider SDK",
    "ollama-rs": "provider SDK",
    "mistralrs": "provider SDK",
    "xai-api": "provider SDK",
}

# These crates are the designated boundaries for their matching dependencies.
ADAPTER_OR_SURFACE_PACKAGES = {
    "horizoncode-provider",
    "horizoncode-sandbox",
    "horizoncode-acp",
    "horizoncode-cli",
}


def normalized_name(value: str) -> str:
    return value.lower().replace("_", "-")


def manifest_label(package: dict[str, Any]) -> str:
    raw = package.get("manifest_path")
    if not raw:
        return "<manifest path unavailable>"
    path = Path(raw)
    try:
        return path.resolve().relative_to(ROOT).as_posix()
    except ValueError:
        return path.as_posix()


def cycle_path(graph: dict[str, set[str]], manifests: dict[str, str]) -> list[str] | None:
    done: set[str] = set()
    active: list[str] = []
    active_index: dict[str, int] = {}

    def visit(node: str) -> list[str] | None:
        if node in active_index:
            return active[active_index[node] :] + [node]
        if node in done:
            return None
        active_index[node] = len(active)
        active.append(node)
        for target in sorted(graph.get(node, set())):
            found = visit(target)
            if found:
                return found
        active.pop()
        active_index.pop(node)
        done.add(node)
        return None

    for node in sorted(graph):
        found = visit(node)
        if found:
            return found
    return None


def inspect_metadata(metadata: dict[str, Any]) -> tuple[list[str], int, int]:
    packages = metadata.get("packages")
    if not isinstance(packages, list):
        return (["INVALID METADATA: `packages` must be an array"], 0, 0)

    workspace: dict[str, dict[str, Any]] = {}
    errors: list[str] = []
    for package in packages:
        if not isinstance(package, dict) or not isinstance(package.get("name"), str):
            errors.append("INVALID METADATA: package has no string `name`")
            continue
        name = package["name"]
        if name in workspace:
            errors.append(f"INVALID METADATA: duplicate workspace package `{name}`")
        workspace[name] = package

    graph: dict[str, set[str]] = {name: set() for name in workspace}
    edge_count = 0

    for name in sorted(workspace):
        package = workspace[name]
        source_manifest = manifest_label(package)
        layer = PACKAGE_LAYER.get(name)
        if layer is None:
            errors.append(
                f"UNCLASSIFIED WORKSPACE PACKAGE: {source_manifest} [{name}]"
            )
        dependencies = package.get("dependencies", [])
        if not isinstance(dependencies, list):
            errors.append(f"INVALID METADATA: `{name}` dependencies must be an array")
            continue

        for dependency in dependencies:
            if not isinstance(dependency, dict) or not isinstance(
                dependency.get("name"), str
            ):
                errors.append(f"INVALID METADATA: malformed dependency in {source_manifest}")
                continue
            # Cargo metadata uses kind=null for normal dependencies; dev/build
            # edges are exercised by tests but are not part of the shipped graph.
            if dependency.get("kind") is not None:
                continue

            target = dependency["name"]
            origin = dependency.get("source")
            if origin is None and target in workspace:
                graph[name].add(target)
                edge_count += 1
                target_layer = PACKAGE_LAYER.get(target)
                if layer is not None and target_layer is not None:
                    if layer[0] < target_layer[0]:
                        errors.append(
                            "LAYER VIOLATION: "
                            f"{source_manifest} [{name}:{layer[1]}] -> "
                            f"{manifest_label(workspace[target])} "
                            f"[{target}:{target_layer[1]}]"
                        )
                continue

            if origin is None and target not in workspace:
                errors.append(
                    f"UNRESOLVED LOCAL DEPENDENCY: {source_manifest} [{name}] -> {target}"
                )
                continue

            external = normalized_name(target)
            if (
                name not in ADAPTER_OR_SURFACE_PACKAGES
                and external in FORBIDDEN_EXTERNALS
            ):
                errors.append(
                    "FORBIDDEN EXTERNAL: "
                    f"{source_manifest} [{name}] -> {target} "
                    f"({FORBIDDEN_EXTERNALS[external]})"
                )

    found_cycle = cycle_path(graph, {n: manifest_label(p) for n, p in workspace.items()})
    if found_cycle:
        labels = [f"{manifest_label(workspace[name])} [{name}]" for name in found_cycle]
        errors.append("DEPENDENCY CYCLE: " + " -> ".join(labels))

    return errors, len(workspace), edge_count


def run_self_test() -> int:
    fixtures = Path(__file__).resolve().parent / "fixtures"
    valid_path = fixtures / "architecture-deps-valid.json"
    try:
        valid = json.loads(valid_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        print(f"SELF-TEST ERROR: cannot read {valid_path}: {exc}", file=sys.stderr)
        return 2
    errors, _, _ = inspect_metadata(valid)
    if errors:
        print("SELF-TEST FAILED: valid graph fixture was rejected", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1

    negative_fixtures = (
        ("architecture-deps-outward-edge.json", "LAYER VIOLATION"),
        ("architecture-deps-forbidden-package.json", "FORBIDDEN EXTERNAL"),
        ("architecture-deps-cycle.json", "DEPENDENCY CYCLE"),
    )
    for filename, expected in negative_fixtures:
        path = fixtures / filename
        try:
            fixture = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            print(f"SELF-TEST ERROR: cannot read {path}: {exc}", file=sys.stderr)
            return 2
        errors, _, _ = inspect_metadata(fixture)
        if not any(expected in error for error in errors):
            print(
                f"SELF-TEST FAILED: {filename} did not produce {expected}",
                file=sys.stderr,
            )
            for error in errors:
                print(f"  {error}", file=sys.stderr)
            return 1
        print(f"PASS {filename}: {next(e for e in errors if expected in e)}")

    print("PASS architecture-deps-valid.json")
    print("Architecture dependency fixtures passed: 1 valid, 3 violating.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--self-test",
        action="store_true",
        help="run committed positive and negative metadata fixtures",
    )
    args = parser.parse_args()
    if args.self_test:
        return run_self_test()

    try:
        metadata = json.load(sys.stdin)
    except json.JSONDecodeError as exc:
        print(f"INVALID METADATA JSON: {exc}", file=sys.stderr)
        return 2
    except OSError as exc:
        print(f"METADATA READ ERROR: {exc}", file=sys.stderr)
        return 2

    errors, package_count, edge_count = inspect_metadata(metadata)
    if errors:
        print("Architecture dependency check FAILED:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1
    print(
        "Architecture dependency check passed: "
        f"{package_count} workspace packages, {edge_count} normal internal edges."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
