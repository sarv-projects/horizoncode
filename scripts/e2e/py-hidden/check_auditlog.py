#!/usr/bin/env python3
"""Independent acceptance check for the `auditlog` deliverable.

Read-only against the arena: every fixture lives in a temp directory, the CLI is
driven as a subprocess, and nothing is written inside the agent's tree.

    python3 scripts/e2e/py-hidden/check_auditlog.py bench/py/auditlog
"""
from __future__ import annotations

import ast
import json
import os
import re
import socket
import subprocess
import sys
import tempfile
import traceback

RESULTS: list[tuple[str, bool, str]] = []
ARENA = ""
CWD = ""
PY = sys.executable
ENV = {}


def record(name: str, ok: bool, detail: str = "") -> None:
    RESULTS.append((name, ok, detail))
    print("CHECK %-42s %s %s" % (name, "PASS" if ok else "FAIL", detail))


def check(name: str):
    """Run the decorated check immediately and record its verdict."""

    def deco(fn):
        try:
            fn()
        except AssertionError as exc:
            record(name, False, str(exc)[:300])
        except Exception as exc:  # noqa: BLE001
            record(name, False, "%s: %s" % (type(exc).__name__, exc))
        else:
            record(name, True)
        return fn

    return deco


def run_cli(*args: str, timeout: int = 120):
    proc = subprocess.run(
        [PY, "-m", "auditlog", *args],
        cwd=CWD, env=ENV, capture_output=True, text=True, timeout=timeout,
    )
    return proc.returncode, proc.stdout, proc.stderr


def write_jsonl(directory: str, name: str, rows: list) -> str:
    path = os.path.join(directory, name)
    with open(path, "w", encoding="utf-8") as fh:
        for row in rows:
            fh.write(row if isinstance(row, str) else json.dumps(row))
            fh.write("\n")
    return path


def parse_error(proc_out: str):
    try:
        return json.loads(proc_out)
    except json.JSONDecodeError as exc:
        raise AssertionError("stdout is not one JSON document: %s | %r" % (exc, proc_out[:200]))


def locate(arena: str):
    hits = []
    for base, dirs, files in os.walk(arena):
        dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "venv", "node_modules")]
        for d in dirs:
            if d == "auditlog" and os.path.isfile(os.path.join(base, d, "__init__.py")):
                hits.append(base)
    if not hits:
        raise SystemExit("FATAL no auditlog/__init__.py found under %s" % arena)
    hits.sort(key=lambda p: (len(p.split(os.sep)), p))
    return hits[0]


def main() -> int:
    global ARENA, CWD, ENV
    ARENA = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "bench/py/auditlog")
    CWD = locate(ARENA)
    ENV = dict(os.environ)
    ENV["PYTHONPATH"] = CWD + (os.pathsep + ENV["PYTHONPATH"] if ENV.get("PYTHONPATH") else "")
    ENV["PYTHONDONTWRITEBYTECODE"] = "1"
    ENV.pop("PYTHONSTARTUP", None)
    print("INFO arena=%s package_root=%s" % (ARENA, CWD))

    tmp = tempfile.mkdtemp(prefix="auditlog-check-")

    # ------------------------------------------------------------------ input
    valid_rows = [
        {"seq": 5, "ts": "2024-05-01T10:00:05Z", "kind": "auth", "message": "login ok"},
        {"seq": 1, "ts": "2024-05-01T10:00:01Z", "kind": "auth", "message": "boot"},
        {"seq": 3, "ts": "2024-05-01T10:00:03Z", "kind": "billing", "message": "charge"},
        {"seq": 4, "ts": "2024-05-01T10:00:04Z", "kind": "billing", "message": "refund"},
        {"seq": 2, "ts": "2024-05-01T10:00:02Z", "kind": "auth", "message": "token"},
    ]
    valid_path = write_jsonl(tmp, "valid.jsonl", valid_rows)

    # ---- requirement 1/9/10: pure deterministic JSON on stdout -----------
    @check("r1.stdout_pure_json")
    def _():
        rc, out, err = run_cli("summarize", valid_path)
        assert rc == 0, "rc=%d stderr=%r" % (rc, err[:200])
        doc = parse_error(out)
        assert isinstance(doc, dict), "top-level is %s" % type(doc).__name__
        for key in ("count", "counts_by_kind", "events"):
            assert key in doc, "missing key %r (got %r)" % (key, list(doc))
        assert doc["count"] == 5, "count=%r" % (doc["count"],)
        assert len(doc["events"]) == 5, "events=%d" % len(doc["events"])

    @check("r9.counts_before_limit_and_sorted")
    def _():
        rc, out, _ = run_cli("summarize", valid_path, "--limit", "2")
        assert rc == 0
        doc = parse_error(out)
        assert doc["count"] == 5, "count before limit = %r" % (doc["count"],)
        assert doc["counts_by_kind"] == {"auth": 3, "billing": 2}, "counts=%r" % (doc["counts_by_kind"],)
        keys = list(doc["counts_by_kind"])
        assert keys == sorted(keys), "counts_by_kind keys not sorted: %r" % (keys,)

    @check("r10.deterministic_output")
    def _():
        a = run_cli("summarize", valid_path)
        b = run_cli("summarize", valid_path)
        assert a[1] == b[1], "stdout differs between runs"
        assert a[1].strip(), "stdout empty"

    @check("r4.sorted_by_seq_ascending")
    def _():
        rc, out, _ = run_cli("summarize", valid_path)
        assert rc == 0
        doc = parse_error(out)
        seqs = [e.get("seq") for e in doc["events"]]
        assert seqs == [1, 2, 3, 4, 5], "seq order %r" % (seqs,)

    # ---- requirement 1: blank lines --------------------------------------
    @check("r1.blank_lines_ignored")
    def _():
        path = write_jsonl(tmp, "blank.jsonl", [
            "",
            json.dumps(valid_rows[0]),
            "   ",
            "",
            json.dumps(valid_rows[1]),
            "\t",
        ])
        rc, out, err = run_cli("summarize", path)
        assert rc == 0, "rc=%d stderr=%r" % (rc, err[:200])
        doc = parse_error(out)
        assert doc["count"] == 2, "count=%r (blank lines counted?)" % (doc["count"],)
        assert "Traceback" not in err

    # ---- requirement 2: per-line diagnostics, keep going -----------------
    @check("r2.malformed_line_diagnostic")
    def _():
        path = write_jsonl(tmp, "malformed.jsonl", [
            json.dumps(valid_rows[0]),
            '{"seq": 2, "ts": "2024-05-01T10:00:02Z", "kind": "auth", "message": ',  # bad JSON
            json.dumps(valid_rows[2]),
        ])
        rc, out, err = run_cli("summarize", path)
        assert rc == 0, "rc=%d" % rc
        doc = parse_error(out)
        assert doc["count"] == 2, "count=%r" % (doc["count"],)
        assert err.strip(), "no diagnostic on stderr"
        assert "2" in err, "diagnostic does not carry the line number: %r" % err[:300]
        assert os.path.basename(path) in err or path in err, "diagnostic does not name the input: %r" % err[:300]
        assert "Traceback" not in err, "traceback on stderr"

    @check("r2.invalid_records_rejected")
    def _():
        bad = [
            {"seq": 0, "ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": "zero"},
            {"seq": -3, "ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": "negative"},
            {"seq": True, "ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": "bool"},
            {"seq": "9", "ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": "string seq"},
            {"seq": 9, "ts": "not-a-timestamp", "kind": "auth", "message": "bad ts"},
            {"seq": 9, "ts": "2024-05-01T10:00:09+00:00", "kind": "auth", "message": "not Z"},
            {"seq": 9, "ts": "2024-05-01T10:00:09Z", "kind": "", "message": "empty kind"},
            {"seq": 9, "ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": 7},
            {"seq": 9, "ts": "2024-05-01T10:00:09Z", "kind": "auth"},
            {"ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": "no seq"},
        ]
        path = write_jsonl(tmp, "invalid.jsonl", [json.dumps(valid_rows[0])] + [json.dumps(r) for r in bad] + [json.dumps(valid_rows[1])])
        rc, out, err = run_cli("summarize", path)
        assert rc == 0, "rc=%d" % rc
        doc = parse_error(out)
        assert doc["count"] == 2, "count=%r, so %d invalid record(s) were accepted" % (doc["count"], doc["count"] - 2)
        assert err.strip(), "no diagnostics for invalid records"
        assert "Traceback" not in err

    # ---- requirement 3: duplicate seq ------------------------------------
    @check("r3.duplicate_seq_first_wins")
    def _():
        path = write_jsonl(tmp, "dup.jsonl", [
            {"seq": 7, "ts": "2024-05-01T10:00:07Z", "kind": "auth", "message": "first"},
            {"seq": 7, "ts": "2024-05-01T10:00:08Z", "kind": "auth", "message": "second"},
            {"seq": 8, "ts": "2024-05-01T10:00:09Z", "kind": "auth", "message": "other"},
        ])
        rc, out, err = run_cli("summarize", path)
        assert rc == 0, "rc=%d" % rc
        doc = parse_error(out)
        assert doc["count"] == 2, "count=%r" % (doc["count"],)
        msgs = [e["message"] for e in doc["events"]]
        assert msgs == ["first", "other"], "events=%r" % (msgs,)
        assert re.search(r"dup", err, re.I), "duplicate not reported: %r" % err[:300]
        assert "7" in err, "duplicate diagnostic does not name the seq: %r" % err[:300]

    # ---- requirement 5: --kind -------------------------------------------
    @check("r5.kind_filter_exact")
    def _():
        rc, out, _ = run_cli("summarize", valid_path, "--kind", "billing")
        assert rc == 0
        doc = parse_error(out)
        assert doc["count"] == 2, "count=%r" % (doc["count"],)
        assert all(e["kind"] == "billing" for e in doc["events"]), "filter leaked"
        rc2, out2, _ = run_cli("summarize", valid_path, "--kind", "Billing")
        assert rc2 == 0
        assert parse_error(out2)["count"] == 0, "filter is case-insensitive, spec says exact"

    # ---- requirement 6: inclusive timestamp bounds ------------------------
    @check("r6.since_until_inclusive")
    def _():
        rc, out, _ = run_cli("summarize", valid_path, "--since", "2024-05-01T10:00:02Z", "--until", "2024-05-01T10:00:04Z")
        assert rc == 0
        doc = parse_error(out)
        seqs = [e["seq"] for e in doc["events"]]
        assert seqs == [2, 3, 4], "inclusive bounds gave %r" % (seqs,)
        assert doc["count"] == 3

    @check("r6.since_only_and_until_only")
    def _():
        rc, out, _ = run_cli("summarize", valid_path, "--since", "2024-05-01T10:00:04Z")
        assert rc == 0 and [e["seq"] for e in parse_error(out)["events"]] == [4, 5]
        rc, out, _ = run_cli("summarize", valid_path, "--until", "2024-05-01T10:00:02Z")
        assert rc == 0 and [e["seq"] for e in parse_error(out)["events"]] == [1, 2]

    # ---- requirement 7: CLI errors ---------------------------------------
    @check("r7.since_after_until_rejected")
    def _():
        rc, out, err = run_cli("summarize", valid_path, "--since", "2024-05-01T10:00:05Z", "--until", "2024-05-01T10:00:01Z")
        assert rc != 0, "exit 0 for since>until"
        assert err.strip(), "no error message"
        assert "Traceback" not in err
        assert out.strip() == "", "wrote to stdout on a CLI error: %r" % out[:200]

    @check("r7.non_positive_limit_rejected")
    def _():
        for bad in ("0", "-1", "-100"):
            rc, out, err = run_cli("summarize", valid_path, "--limit", bad)
            assert rc != 0, "--limit %s exited 0" % bad
            assert err.strip(), "--limit %s gave no message" % bad
            assert "Traceback" not in err

    @check("r7.invalid_timestamp_arg_rejected")
    def _():
        for bad in ("nonsense", "2024-13-40T99:00:00Z", "2024-05-01", ""):
            rc, out, err = run_cli("summarize", valid_path, "--since", bad)
            assert rc != 0, "--since %r exited 0" % bad
            assert "Traceback" not in err

    # ---- requirement 8: --limit picks most recent -------------------------
    @check("r8.limit_most_recent_ascending")
    def _():
        rows = [{"seq": i, "ts": "2024-05-01T10:00:%02dZ" % i, "kind": "k", "message": "m%d" % i} for i in range(1, 11)]
        path = write_jsonl(tmp, "ten.jsonl", rows)
        rc, out, _ = run_cli("summarize", path, "--limit", "3")
        assert rc == 0
        doc = parse_error(out)
        seqs = [e["seq"] for e in doc["events"]]
        assert seqs == [8, 9, 10], "limit gave %r" % (seqs,)
        assert doc["count"] == 10, "count=%r" % (doc["count"],)

    # ---- requirement 11: missing / unreadable input ----------------------
    @check("r11.missing_file_clean_failure")
    def _():
        missing = os.path.join(tmp, "does-not-exist.jsonl")
        rc, out, err = run_cli("summarize", missing)
        assert rc != 0, "exit 0 for a missing file"
        assert "Traceback" not in err, "traceback for a missing file:\n%s" % err[:400]
        assert err.strip(), "no message"
        assert "does-not-exist.jsonl" in err, "message does not name the file: %r" % err[:300]

    @check("r11.unreadable_file_clean_failure")
    def _():
        path = write_jsonl(tmp, "locked.jsonl", [json.dumps(valid_rows[0])])
        os.chmod(path, 0o000)
        try:
            if os.geteuid() == 0:
                raise AssertionError("skipped: running as root")
            rc, out, err = run_cli("summarize", path)
            assert rc != 0, "exit 0 for an unreadable file"
            assert "Traceback" not in err
        except AssertionError:
            raise
        finally:
            os.chmod(path, 0o600)

    # ---- requirement 12: stdlib only -------------------------------------
    @check("r12.no_third_party_imports")
    def _():
        stdlib = set(sys.stdlib_module_names)
        offenders = []
        for base, dirs, files in os.walk(ARENA):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "venv", "node_modules")]
            for name in files:
                if not name.endswith(".py"):
                    continue
                path = os.path.join(base, name)
                tree = ast.parse(open(path, encoding="utf-8", errors="replace").read(), filename=path)
                for node in ast.walk(tree):
                    mods = []
                    if isinstance(node, ast.Import):
                        mods = [a.name.split(".")[0] for a in node.names]
                    elif isinstance(node, ast.ImportFrom) and node.level == 0 and node.module:
                        mods = [node.module.split(".")[0]]
                    for mod in mods:
                        if mod in stdlib or mod in ("auditlog",):
                            continue
                        offenders.append("%s:%s" % (os.path.relpath(path, ARENA), mod))
        assert not offenders, "non-stdlib imports: %s" % offenders[:8]

    @check("r12.agent_suite_passes")
    def _():
        proc = subprocess.run([PY, "-m", "unittest", "discover", "-v"], cwd=ARENA, env=ENV,
                              capture_output=True, text=True, timeout=600)
        tail = "\n".join([l for l in (proc.stderr or proc.stdout).splitlines() if l.strip()][-6:])
        assert proc.returncode == 0, "unittest discover rc=%d\n%s" % (proc.returncode, tail)
        assert re.search(r"^Ran [1-9]\d* test", proc.stderr or "", re.M), "no tests ran:\n%s" % tail

    # ---- requirement 12: README ------------------------------------------
    @check("r12.readme_documents_contract")
    def _():
        readme = None
        for base, _d, files in os.walk(ARENA):
            for name in files:
                if name.lower().startswith("readme"):
                    readme = os.path.join(base, name)
                    break
            if readme:
                break
        assert readme, "no README"
        text = open(readme, encoding="utf-8", errors="replace").read()
        low = text.lower()
        assert "summarize" in low, "README does not show the CLI"
        assert len(text) > 900, "README is %d chars" % len(text)
        for token in ("--kind", "--since", "--until", "--limit"):
            assert token in text, "README does not document %s" % token
        assert "stderr" in low, "README does not document diagnostics"
        assert "exit" in low, "README does not document exit behaviour"
        assert "seq" in low and "ts" in low and "kind" in low and "message" in low, "README does not document the schema"

    # ---- requirement 14: the UI ------------------------------------------
    @check("r14.ui_present_and_self_contained")
    def _():
        pages = []
        for base, dirs, files in os.walk(ARENA):
            dirs[:] = [d for d in dirs if d not in (".git", "__pycache__", ".venv", "venv", "node_modules")]
            for name in files:
                if name.endswith(".html"):
                    pages.append(os.path.join(base, name))
        if not pages:
            # A terminal UI is a legitimate choice for a JSONL inspector ("decide
            # the stack yourself"), and it leaves no HTML behind. Accept a UI that
            # is actually reachable from the CLI: a listed subcommand that answers
            # --help. Presence and reachability only -- this is not a quality
            # judgement.
            rc, out, err = run_cli("--help")
            listing = out + err
            names = [n for n in ("tui", "ui", "browse", "view", "inspect") if n in listing]
            assert names, ("no HTML page and no ui/tui subcommand in `python -m auditlog --help`; "
                           "checked for: tui, ui, browse, view, inspect")
            sub = names[0]
            rc2, out2, err2 = run_cli(sub, "--help")
            assert rc2 == 0, "`python -m auditlog %s --help` exited %d: %r" % (sub, rc2, (err2 or out2)[:200])
            print("INFO ui=tui-subcommand `%s` reachable (no HTML by design)" % sub)
            return
        best = max(pages, key=lambda p: os.path.getsize(p))
        size = os.path.getsize(best)
        text = open(best, encoding="utf-8", errors="replace").read()
        rel = os.path.relpath(best, ARENA)
        assert size > 1500, "largest page %s is only %d bytes" % (rel, size)
        assert "<html" in text.lower(), "%s has no <html> root" % rel
        assert "<script" in text.lower() or "<form" in text.lower(), "%s is not interactive" % rel
        external = re.findall(r'(?:src|href)\s*=\s*["\']https?://[^"\']+', text, re.I)
        assert not external, "%s loads %d external asset(s), so it cannot run offline: %s" % (rel, len(external), external[:3])
        readme = ""
        for base, _d, files in os.walk(ARENA):
            for name in files:
                if name.lower().startswith("readme"):
                    readme = open(os.path.join(base, name), encoding="utf-8", errors="replace").read()
                    break
            if readme:
                break
        assert os.path.basename(best) in readme or rel in readme, "README does not tell the user how to open the UI (%s)" % rel
        print("INFO ui_page=%s bytes=%d" % (rel, size))

    @check("r14.no_junk_left_behind")
    def _():
        junk = []
        for base, dirs, files in os.walk(ARENA):
            rel = os.path.relpath(base, ARENA)
            for d in dirs:
                if d in ("__pycache__", ".venv", "venv", "node_modules", "build", "dist", ".pytest_cache", ".mypy_cache"):
                    junk.append(os.path.join(rel, d))
            for name in files:
                if name.endswith((".pyc", ".orig", ".rej", ".bak", ".tmp")) or name == ".DS_Store":
                    junk.append(os.path.join(rel, name))
        assert not junk, "leftover junk: %s" % junk[:10]

    # ------------------------------------------------------------------ report
    passed = sum(1 for _, ok, _ in RESULTS if ok)
    failed = len(RESULTS) - passed
    print("")
    print("AUDITLOG_CHECKS=%d" % len(RESULTS))
    print("AUDITLOG_PASS=%d" % passed)
    print("AUDITLOG_FAIL=%d" % failed)
    for name, ok, detail in RESULTS:
        if not ok:
            print("AUDITLOG_FINDING %s :: %s" % (name, detail))
    print("AUDITLOG=%s" % ("VERIFIED" if failed == 0 else "PARTIAL"))
    return 0 if failed == 0 else 2


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        print("AUDITLOG=HARNESS_ERROR")
        sys.exit(3)
