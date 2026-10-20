#!/usr/bin/env python3
"""Combine distribution audit and isolated install evidence without publishing.

This is a release-readiness evidence gate, not a signer, publisher, or legal
decision-maker. A supplied binary can pass its install scenarios without
turning unresolved licensing, signing, V1 integration, or CI gates into PASS.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import stat
import sys
import uuid

if __package__ in (None, ""):
    # Allow `python3 scripts/release/release_gate.py` from the repository root
    # while keeping the module import path for `python3 -m scripts.release.release_gate`.
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from scripts.release.audit_distribution import audit_repository
from scripts.release.clean_install import APPROVED_TEMP_ROOT, run_matrix


PLATFORM_SUPPORT_DIMENSIONS = (
    "filesystem_process_network_containment",
    "peer_authentication",
    "durable_storage",
    "credential_store",
    "browser_desktop",
    "lsp_dap",
    "repl",
    "terminal_graphics",
    "package_signing_update",
)

KNOWN_INSTALL_MATRIX_STATUSES = frozenset({"PASS", "PARTIAL", "FAIL", "BLOCKED"})


def _sha256(path: Path) -> str | None:
    try:
        if not stat.S_ISREG(path.stat(follow_symlinks=False).st_mode):
            return None
        digest = hashlib.sha256()
        with path.open("rb") as file:
            for chunk in iter(lambda: file.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()
    except OSError:
        return None


def _checkout_facts(checkout: Path | None) -> dict | None:
    if checkout is None:
        return None
    try:
        revision = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=checkout,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
        status = subprocess.run(
            ["git", "status", "--porcelain=v1", "--untracked-files=all"],
            cwd=checkout,
            check=True,
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout
    except (OSError, subprocess.CalledProcessError, subprocess.TimeoutExpired):
        return {"status": "UNVERSIONED", "revision": None, "clean": False}
    return {"status": "CLEAN" if not status else "DIRTY", "revision": revision, "clean": not status}


def _bound_install_evidence(install_matrix: dict) -> dict | None:
    """Bind a lane to a concrete artifact only when revision and digest evidence exist."""
    checkout = install_matrix.get("source_checkout")
    artifacts = install_matrix.get("artifacts")
    candidate = artifacts.get("candidate") if isinstance(artifacts, dict) else None
    if not isinstance(checkout, dict) or checkout.get("status") != "CLEAN" or not checkout.get("revision"):
        return None
    if not isinstance(candidate, dict) or not candidate.get("sha256"):
        return None
    scenarios = install_matrix.get("scenarios")
    return {
        "source_revision": checkout.get("revision"),
        "source_checkout_status": checkout.get("status"),
        "candidate_sha256": candidate.get("sha256"),
        "scenario_statuses": {
            name: item.get("status", "UNKNOWN")
            for name, item in scenarios.items()
            if isinstance(item, dict)
        }
        if isinstance(scenarios, dict)
        else {},
    }


def build_platform_support_matrix(install_matrix: dict) -> dict:
    """Prepare lane-specific evidence without treating an install smoke as support acceptance."""
    linux_capabilities = {
        dimension: "UNAVAILABLE" if dimension == "browser_desktop" else "NOT_VERIFIED"
        for dimension in PLATFORM_SUPPORT_DIMENSIONS
    }
    windows_capabilities = {dimension: "UNAVAILABLE" for dimension in PLATFORM_SUPPORT_DIMENSIONS}
    macos_capabilities = {dimension: "OUT_OF_SCOPE" for dimension in PLATFORM_SUPPORT_DIMENSIONS}
    lanes = {
        "native_linux": {
            "support_status": "NOT_VERIFIED",
            "capability_status": dict(linux_capabilities),
            "install_matrix_status": "NOT_RUN",
            "install_evidence": None,
            "limitation": "A single artifact install smoke does not establish the complete Linux support matrix.",
        },
        "wsl2": {
            "support_status": "NOT_VERIFIED",
            "capability_status": dict(linux_capabilities),
            "install_matrix_status": "NOT_RUN",
            "install_evidence": None,
            "limitation": "WSL2 evidence is distinct from native Linux and native Windows acceptance.",
        },
        "wsl": {
            "support_status": "NOT_VERIFIED",
            "capability_status": dict(linux_capabilities),
            "install_matrix_status": "NOT_RUN",
            "install_evidence": None,
            "limitation": "The observed WSL generation must be established before qualifying a WSL support lane.",
        },
        "native_windows": {
            "support_status": "UNAVAILABLE",
            "capability_status": windows_capabilities,
            "install_matrix_status": "NOT_RUN",
            "install_evidence": None,
            "limitation": "Native Windows acceptance has not been run; WSL is not Windows evidence.",
        },
        "macos": {
            "support_status": "OUT_OF_SCOPE",
            "capability_status": macos_capabilities,
            "install_matrix_status": "NOT_RUN",
            "install_evidence": None,
            "limitation": "macOS is outside the current Linux/WSL-first V1 release scope.",
        },
    }

    host = install_matrix.get("platform")
    observed_host = None
    if isinstance(host, dict):
        observed_host = {
            key: host.get(key)
            for key in ("system", "host_kind", "kernel", "architecture", "wsl")
        }
        host_lane = {"Linux": "native_linux", "WSL": "wsl", "WSL2": "wsl2"}.get(host.get("host_kind"))
        reported_status = str(install_matrix.get("status", "UNKNOWN"))
        matrix_status = (
            reported_status
            if reported_status in KNOWN_INSTALL_MATRIX_STATUSES or reported_status == "NOT_RUN"
            else "UNKNOWN"
        )
        if host_lane is not None and matrix_status != "NOT_RUN":
            lanes[host_lane]["install_matrix_status"] = matrix_status
            if matrix_status in KNOWN_INSTALL_MATRIX_STATUSES:
                evidence = _bound_install_evidence(install_matrix)
                if evidence is not None:
                    lanes[host_lane]["install_evidence"] = evidence
                else:
                    lanes[host_lane]["install_evidence_limitation"] = (
                        "reported install-matrix status is not bound to a clean checkout revision and candidate digest"
                    )

    return {
        "schema_version": 1,
        "assessment_status": "NOT_VERIFIED",
        "scope": "install-matrix evidence only; not complete platform acceptance",
        "required_dimensions": list(PLATFORM_SUPPORT_DIMENSIONS),
        "observed_install_host": observed_host,
        "lanes": lanes,
        "limitations": [
            "The install matrix exercises one supplied artifact on one host and does not qualify all supported kernels, distributions, sandbox paths, or product capabilities.",
            "WSL evidence never qualifies native Windows support.",
            "Platform support remains unverified until the separate release acceptance matrix passes on each claimed lane.",
        ],
    }


def evaluate_release_gate(
    root: Path,
    *,
    artifact: Path | None = None,
    checkout: Path | None = None,
    candidate_binary: Path | None = None,
    previous_binary: Path | None = None,
    migration_fixture: Path | None = None,
    expected_model: str | None = None,
    state_root: Path | None = None,
) -> dict:
    root = root.resolve()
    audit = audit_repository(root, artifact)
    blockers = list(audit["blockers"])
    candidate_checkout = _checkout_facts(checkout)

    if audit["distribution_license"].get("legal_decision_made") is not True:
        blockers.append("HorizonCode distribution license and notice grant are not authorized")
    if candidate_binary is None:
        install_matrix = {
            "status": "NOT_RUN",
            "reason": "no candidate product binary was supplied",
        }
    elif checkout is None:
        install_matrix = {
            "status": "BLOCKED",
            "reason": "candidate binary requires a separate source checkout",
        }
    elif (
        candidate_checkout
        and candidate_checkout.get("revision")
        and audit["source"].get("revision")
        and candidate_checkout["revision"] != audit["source"]["revision"]
    ):
        install_matrix = {
            "status": "BLOCKED",
            "reason": (
                f"candidate checkout revision {candidate_checkout['revision']} does not match audited source revision "
                f"{audit['source']['revision']}"
            ),
            "source_checkout": candidate_checkout,
        }
    else:
        matrix_state_root = state_root or (
            APPROVED_TEMP_ROOT / f"horizoncode-p9-gate-{uuid.uuid4().hex}"
        )
        try:
            install_matrix = run_matrix(
                checkout=checkout,
                candidate_binary=candidate_binary,
                previous_binary=previous_binary,
                migration_fixture=migration_fixture,
                expected_model=expected_model,
                state_root=matrix_state_root,
            )
        except (OSError, ValueError) as error:
            install_matrix = {"status": "BLOCKED", "reason": str(error)}

    if install_matrix["status"] == "NOT_RUN":
        blockers.append("clean-install, upgrade, migration, TUI, and rollback evidence was not run")
    elif install_matrix["status"] != "PASS":
        blockers.append("clean-install, upgrade, migration, TUI, and rollback evidence did not all pass")
    blockers.append("signing/update trust root and rollback policy remain unresolved")
    blockers.append("P1/P2, integrated V1 security/performance, and final CI gates are outside this P9 helper and remain unverified")
    blockers.append(
        "Linux/WSL platform support acceptance remains unverified; install-matrix evidence is not full platform acceptance"
    )

    release_scripts = Path(__file__).resolve().parent
    tooling_hashes = {
        name: _sha256(release_scripts / name)
        for name in ("audit_distribution.py", "clean_install.py", "release_gate.py")
    }
    return {
        "schema_version": 1,
        "status": "BLOCKED" if blockers else "REVIEW_REQUIRED",
        "source": audit["source"],
        "runtime": {
            "python": sys.version.split()[0],
            "platform": platform.platform(),
            "kernel": platform.release(),
        },
        "tooling_sha256": tooling_hashes,
        "inputs": {
            "source_root": str(root),
            "artifact": str(artifact.absolute()) if artifact else audit["artifact"].get("path"),
            "checkout": str(checkout.absolute()) if checkout else None,
            "candidate_binary": str(candidate_binary.absolute()) if candidate_binary else None,
            "previous_binary": str(previous_binary.absolute()) if previous_binary else None,
            "candidate_binary_sha256": _sha256(candidate_binary) if candidate_binary else None,
            "previous_binary_sha256": _sha256(previous_binary) if previous_binary else None,
            "migration_fixture_sha256": _sha256(migration_fixture) if migration_fixture else None,
        },
        "candidate_checkout": candidate_checkout,
        "distribution_license_decision": "NOT_AUTHORIZED",
        "signing_update_policy": "UNRESOLVED",
        "audit": audit,
        "install_matrix": install_matrix,
        "platform_support_matrix": build_platform_support_matrix(install_matrix),
        "install_evidence_class": "provided-binary exercise; synthetic harness tests are not product evidence",
        "other_v1_gates": {
            "status": "NOT_ASSESSED_BY_P9_HELPERS",
            "required": ["P1/P2 integration", "V1 security and performance acceptance", "final CI/full gate"],
        },
        "blockers": list(dict.fromkeys(blockers)),
        "publication_performed": False,
        "signature_created": False,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path(__file__).resolve().parents[2])
    parser.add_argument("--artifact", type=Path, help="distribution package, directory, or archive to inspect")
    parser.add_argument("--checkout", type=Path, help="separate clean source checkout for install testing")
    parser.add_argument("--candidate-binary", type=Path, help="candidate executable inside --checkout")
    parser.add_argument("--previous-binary", type=Path, help="previous release executable inside --checkout")
    parser.add_argument("--migration-fixture", type=Path, help="isolated legacy TOML migration fixture")
    parser.add_argument("--expected-model", help="expected model after the migration fixture is read")
    parser.add_argument("--state-root", type=Path, help="new evidence directory under /tmp/opencode")
    parser.add_argument("--output", type=Path, help="write JSON evidence here instead of stdout")
    args = parser.parse_args()
    try:
        report = evaluate_release_gate(
            args.root,
            artifact=args.artifact,
            checkout=args.checkout,
            candidate_binary=args.candidate_binary,
            previous_binary=args.previous_binary,
            migration_fixture=args.migration_fixture,
            expected_model=args.expected_model,
            state_root=args.state_root,
        )
    except (OSError, ValueError) as error:
        print(f"release gate could not produce evidence: {error}", file=sys.stderr)
        return 3

    encoded = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(encoded, encoding="utf-8")
        print(f"release gate: {report['status']} ({len(report['blockers'])} blockers); report={args.output}")
    else:
        print(encoded, end="")
    return 1 if report["blockers"] else 0


if __name__ == "__main__":
    raise SystemExit(main())
