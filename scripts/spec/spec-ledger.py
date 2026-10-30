#!/usr/bin/env python3
"""Spec ledger: an executable coverage gate for a HorizonCode run.

The ledger is a machine-readable list of the requirements a brief actually
contains, each with a check the *harness* runs. The agent may write the ledger
and may not grade itself: every verdict below comes from executing a command and
looking at its exit status.

    .opencode/SPEC.json          written once, at the start of the work
    .opencode/SPEC.report.json   written by this script, never by the model

Usage:
    python3 scripts/spec/spec-ledger.py --workspace bench/py/retrykit
    python3 scripts/spec/spec-ledger.py --workspace . --format json
    python3 scripts/spec/spec-ledger.py --workspace . --scaffold prompts.txt

Exit status:
    0  every requirement passed its check, or was explicitly waived with a reason
    1  at least one requirement failed, or has no check (unresolved)
    2  no ledger, or the ledger is malformed
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
import time

SPEC_REL = os.path.join(".opencode", "SPEC.json")
REPORT_REL = os.path.join(".opencode", "SPEC.report.json")

VERDICT_PASS = "pass"
VERDICT_FAIL = "fail"
VERDICT_UNRESOLVED = "unresolved"
VERDICT_WAIVED = "waived"


def trace(message: str) -> None:
    print(message, file=sys.stderr)


def load_spec(workspace: str) -> dict:
    path = os.path.join(workspace, SPEC_REL)
    if not os.path.isfile(path):
        trace("no ledger at %s" % path)
        raise SystemExit(2)
    try:
        with open(path, encoding="utf-8") as handle:
            spec = json.load(handle)
    except json.JSONDecodeError as exc:
        trace("ledger is not valid JSON: %s" % exc)
        raise SystemExit(2)
    if not isinstance(spec, dict):
        trace("ledger must be a JSON object")
        raise SystemExit(2)
    requirements = spec.get("requirements")
    if not isinstance(requirements, list) or not requirements:
        trace("ledger has no requirements array")
        raise SystemExit(2)
    seen: set[str] = set()
    for index, row in enumerate(requirements, start=1):
        if not isinstance(row, dict):
            trace("requirement %d is not an object" % index)
            raise SystemExit(2)
        rid = row.get("id")
        if not isinstance(rid, str) or not rid.strip():
            trace("requirement %d has no id" % index)
            raise SystemExit(2)
        if rid in seen:
            trace("duplicate requirement id %r: ids are the identity of a requirement and may not repeat" % rid)
            raise SystemExit(2)
        seen.add(rid)
        if not isinstance(row.get("text"), str) or not row["text"].strip():
            trace("requirement %s has no text" % rid)
            raise SystemExit(2)
        check = row.get("check")
        waived = row.get("waived")
        if check is None and waived is None:
            # Legal: it is an unresolved requirement, and that is exactly what the
            # gate exists to surface. Not a schema error.
            continue
        if check is not None:
            if not isinstance(check, dict) or not isinstance(check.get("command"), str) or not check["command"].strip():
                trace("requirement %s has a check without a command" % rid)
                raise SystemExit(2)
            timeout = check.get("timeoutSeconds", 600)
            if not isinstance(timeout, int) or isinstance(timeout, bool) or timeout < 1:
                trace("requirement %s has an invalid timeoutSeconds" % rid)
                raise SystemExit(2)
        if waived is not None:
            if not isinstance(waived, dict) or not isinstance(waived.get("reason"), str) or not waived["reason"].strip():
                trace("requirement %s is waived without a reason" % rid)
                raise SystemExit(2)
    return spec


def run_check(workspace: str, command: str, timeout: int) -> tuple[int, str, float]:
    started = time.time()
    try:
        completed = subprocess.run(
            ["bash", "-lc", command],
            cwd=workspace,
            capture_output=True,
            text=True,
            timeout=timeout,
            env={**os.environ, "NO_COLOR": "1", "PYTHONDONTWRITEBYTECODE": "1"},
        )
    except subprocess.TimeoutExpired:
        return 124, "timed out after %ds" % timeout, time.time() - started
    output = (completed.stdout or "") + (completed.stderr or "")
    digest = hashlib.blake2b(output.encode("utf-8", "replace"), digest_size=8).hexdigest()
    tail = " ".join(output.strip().splitlines()[-3:])[:240]
    return completed.returncode, "%s (output blake2b:%s)" % (tail or "no output", digest), time.time() - started


def evaluate(workspace: str, spec: dict) -> list[dict]:
    rows: list[dict] = []
    for row in spec["requirements"]:
        rid = row["id"]
        check = row.get("check")
        waived = row.get("waived")
        if waived is not None:
            rows.append({"id": rid, "text": row["text"], "verdict": VERDICT_WAIVED, "detail": waived["reason"], "seconds": 0.0})
            continue
        if check is None:
            rows.append({
                "id": rid, "text": row["text"], "verdict": VERDICT_UNRESOLVED,
                "detail": "no check was ever defined for this requirement", "seconds": 0.0,
            })
            continue
        code, detail, seconds = run_check(workspace, check["command"], check.get("timeoutSeconds", 600))
        rows.append({
            "id": rid, "text": row["text"],
            "verdict": VERDICT_PASS if code == 0 else VERDICT_FAIL,
            "command": check["command"], "exit": code, "detail": detail, "seconds": round(seconds, 2),
        })
    return rows


def summarise(rows: list[dict]) -> dict:
    counts = {VERDICT_PASS: 0, VERDICT_FAIL: 0, VERDICT_UNRESOLVED: 0, VERDICT_WAIVED: 0}
    for row in rows:
        counts[row["verdict"]] += 1
    return {
        "total": len(rows),
        **counts,
        "covered": counts[VERDICT_PASS] + counts[VERDICT_WAIVED],
        "complete": counts[VERDICT_FAIL] == 0 and counts[VERDICT_UNRESOLVED] == 0,
    }


def scaffold(prompt_path: str, out_path: str) -> int:
    """Write a skeleton ledger with one row per numbered requirement in a brief.

    The rows carry no checks: deciding *how* each requirement is checked is the
    extractor's job, and an unedited scaffold must fail the gate. What this buys
    is that no requirement can be silently forgotten — the count is fixed by the
    brief, not by the agent's memory.
    """
    text = open(prompt_path, encoding="utf-8").read()
    items = re.findall(r"^\s*(\d+)[.)]\s+(.+?)\s*$", text, re.M)
    if not items:
        trace("no numbered requirements found in %s" % prompt_path)
        return 2
    requirements = [
        {"id": "R%d" % int(number), "text": body, "check": None}
        for number, body in items
    ]
    spec = {"objective": os.path.basename(prompt_path), "requirements": requirements}
    os.makedirs(os.path.dirname(out_path) or ".", exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as handle:
        json.dump(spec, handle, indent=2)
        handle.write("\n")
    print("wrote %d requirement rows to %s" % (len(requirements), out_path))
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Execute a spec ledger and report requirement coverage.")
    parser.add_argument("--workspace", default=".", help="directory containing .opencode/SPEC.json")
    parser.add_argument("--format", choices=("table", "json"), default="table")
    parser.add_argument("--scaffold", metavar="PROMPT", help="write a skeleton ledger from a brief's numbered requirements")
    parser.add_argument("--out", help="where --scaffold writes (default: WORKSPACE/.opencode/SPEC.json)")
    args = parser.parse_args()

    workspace = os.path.abspath(args.workspace)
    if args.scaffold:
        return scaffold(args.scaffold, args.out or os.path.join(workspace, SPEC_REL))

    spec = load_spec(workspace)
    rows = evaluate(workspace, spec)
    summary = summarise(rows)
    report = {
        "objective": spec.get("objective"),
        "workspace": workspace,
        "generatedAtUnix": int(time.time()),
        "summary": summary,
        "requirements": rows,
    }
    os.makedirs(os.path.join(workspace, ".opencode"), exist_ok=True)
    with open(os.path.join(workspace, REPORT_REL), "w", encoding="utf-8") as handle:
        json.dump(report, handle, indent=2, sort_keys=True)
        handle.write("\n")

    if args.format == "json":
        print(json.dumps(report, indent=2, sort_keys=True))
    else:
        print("%-6s %-11s %s" % ("id", "verdict", "requirement"))
        for row in rows:
            print("%-6s %-11s %s" % (row["id"], row["verdict"], row["text"][:96]))
            if row["verdict"] != VERDICT_PASS:
                print("       %s" % row["detail"][:200])
        print("")
        print("COVERAGE total=%d pass=%d fail=%d unresolved=%d waived=%d covered=%d/%d" % (
            summary["total"], summary[VERDICT_PASS], summary[VERDICT_FAIL],
            summary[VERDICT_UNRESOLVED], summary[VERDICT_WAIVED],
            summary["covered"], summary["total"],
        ))
        print("LEDGER=%s" % ("COMPLETE" if summary["complete"] else "INCOMPLETE"))
        print("REPORT %s" % os.path.join(workspace, REPORT_REL))
    return 0 if summary["complete"] else 1


if __name__ == "__main__":
    sys.exit(main())
