"""Unit tests for the auditlog package."""

from __future__ import annotations

import io
import json
import os
import shutil
import subprocess
import tempfile
import unittest
from contextlib import redirect_stderr

from auditlog.core import (
    AuditlogError,
    Event,
    filter_events,
    parse_timestamp,
    read_events,
    summarize,
    validate_record,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PYTHON = shutil.which("python3") or "/usr/bin/python3"


def write_temp_jsonl(lines):
    """Write ``lines`` to a temp JSONL file and return its path."""
    fd, path = tempfile.mkstemp(suffix=".jsonl", text=True)
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line + "\n")
    return path


class ParseTimestampTests(unittest.TestCase):
    def test_valid_utc_timestamp(self):
        dt = parse_timestamp("2023-01-01T00:00:00Z")
        self.assertEqual(dt, __import__("datetime").datetime(2023, 1, 1, tzinfo=__import__("datetime").timezone.utc))

    def test_fractional_seconds(self):
        dt = parse_timestamp("2023-12-31T23:59:59.999999Z")
        self.assertEqual(dt.microsecond, 999999)

    def test_rejects_no_z(self):
        with self.assertRaises(ValueError):
            parse_timestamp("2023-01-01T00:00:00+00:00")

    def test_rejects_space_separator(self):
        with self.assertRaises(ValueError):
            parse_timestamp("2023-01-01 00:00:00Z")

    def test_rejects_lowercase_z(self):
        with self.assertRaises(ValueError):
            parse_timestamp("2023-01-01T00:00:00z")

    def test_rejects_invalid_date(self):
        with self.assertRaises(ValueError):
            parse_timestamp("2023-13-01T00:00:00Z")

    def test_rejects_invalid_hour(self):
        with self.assertRaises(ValueError):
            parse_timestamp("2023-01-01T25:00:00Z")

    def test_rejects_non_string_and_garbage(self):
        with self.assertRaises(ValueError):
            parse_timestamp("not-a-timestamp")
        with self.assertRaises(ValueError):
            parse_timestamp("")


class ValidateRecordTests(unittest.TestCase):
    def test_valid_record(self):
        error, event = validate_record({"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "hi"})
        self.assertIsNone(error)
        self.assertIsInstance(event, Event)
        self.assertEqual(event.seq, 1)
        self.assertEqual(event.kind, "login")
        self.assertEqual(event.message, "hi")

    def test_empty_message_is_valid(self):
        error, event = validate_record({"seq": 2, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": ""})
        self.assertIsNone(error)
        self.assertEqual(event.message, "")

    def test_non_object(self):
        error, event = validate_record([1, 2, 3])
        self.assertIsNotNone(error)
        self.assertIsNone(event)

    def test_missing_fields(self):
        for field in ("seq", "ts", "kind", "message"):
            obj = {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "m"}
            del obj[field]
            error, event = validate_record(obj)
            self.assertIsNotNone(error, field)
            self.assertIsNone(event)
            self.assertIn(field, error)

    def test_seq_boolean_rejected(self):
        error, _ = validate_record({"seq": True, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "m"})
        self.assertIsNotNone(error)
        self.assertIn("seq", error)

    def test_seq_invalid_values(self):
        for seq in (0, -1, 1.5, "3", 3.0):
            error, _ = validate_record({"seq": seq, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "m"})
            self.assertIsNotNone(error, seq)

    def test_ts_invalid(self):
        error, _ = validate_record({"seq": 1, "ts": "2023-13-01T00:00:00Z", "kind": "k", "message": "m"})
        self.assertIsNotNone(error)
        error, _ = validate_record({"seq": 1, "ts": 123, "kind": "k", "message": "m"})
        self.assertIsNotNone(error)

    def test_kind_invalid(self):
        for kind in ("", 1, None):
            error, _ = validate_record({"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": kind, "message": "m"})
            self.assertIsNotNone(error, kind)

    def test_message_invalid(self):
        error, _ = validate_record({"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": 5})
        self.assertIsNotNone(error)


class ReadEventsTests(unittest.TestCase):
    def test_sorts_by_seq(self):
        path = write_temp_jsonl([
            '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "k", "message": "c"}',
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "a"}',
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "k", "message": "b"}',
        ])
        try:
            events = read_events(path)
            self.assertEqual([e.seq for e in events], [1, 2, 3])
        finally:
            os.unlink(path)

    def test_ignores_blank_lines(self):
        path = write_temp_jsonl([
            '',
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "a"}',
            "   ",
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "k", "message": "b"}',
            "",
        ])
        try:
            events = read_events(path)
            self.assertEqual([e.seq for e in events], [1, 2])
        finally:
            os.unlink(path)

    def test_malformed_json_continues(self):
        path = write_temp_jsonl([
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "a"}',
            "{not json",
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "k", "message": "b"}',
        ])
        err = io.StringIO()
        try:
            with redirect_stderr(err):
                events = read_events(path)
            self.assertEqual([e.seq for e in events], [1, 2])
            self.assertIn("invalid JSON", err.getvalue())
            self.assertIn(":2:", err.getvalue())
        finally:
            os.unlink(path)

    def test_invalid_records_continue(self):
        path = write_temp_jsonl([
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "a"}',
            '{"seq": 2, "ts": "not-a-date", "kind": "k", "message": "b"}',
            '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "", "message": "c"}',
            '{"seq": 4, "ts": "2023-01-04T00:00:00Z", "kind": "k", "message": "d"}',
        ])
        err = io.StringIO()
        try:
            with redirect_stderr(err):
                events = read_events(path)
            self.assertEqual([e.seq for e in events], [1, 4])
            diagnostics = err.getvalue()
            self.assertIn("invalid record", diagnostics)
            self.assertIn(":2:", diagnostics)
            self.assertIn(":3:", diagnostics)
        finally:
            os.unlink(path)

    def test_duplicate_seq_keeps_first(self):
        path = write_temp_jsonl([
            '{"seq": 5, "ts": "2023-01-01T00:00:00Z", "kind": "k", "message": "first"}',
            '{"seq": 5, "ts": "2023-01-02T00:00:00Z", "kind": "k", "message": "second"}',
        ])
        err = io.StringIO()
        try:
            with redirect_stderr(err):
                events = read_events(path)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0].message, "first")
            self.assertIn("duplicate seq 5", err.getvalue())
            self.assertIn(":2:", err.getvalue())
        finally:
            os.unlink(path)

    def test_missing_file_clean_failure(self):
        with self.assertRaises(AuditlogError):
            read_events("/nonexistent/path/to/file.jsonl")

    def test_unreadable_file_clean_failure(self):
        fd, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(fd)
        os.chmod(path, 0o000)
        try:
            with self.assertRaises(AuditlogError):
                read_events(path)
        finally:
            os.chmod(path, 0o600)
            os.unlink(path)


class FilterEventsTests(unittest.TestCase):
    def _events(self):
        return [
            Event(1, "2023-01-01T00:00:00Z", "login", "a", parse_timestamp("2023-01-01T00:00:00Z")),
            Event(2, "2023-01-02T00:00:00Z", "logout", "b", parse_timestamp("2023-01-02T00:00:00Z")),
            Event(3, "2023-01-03T00:00:00Z", "login", "c", parse_timestamp("2023-01-03T00:00:00Z")),
        ]

    def test_kind_filter(self):
        events = self._events()
        self.assertEqual([e.seq for e in filter_events(events, kind="login")], [1, 3])
        self.assertEqual([e.seq for e in filter_events(events, kind="missing")], [])

    def test_since_until_inclusive(self):
        events = self._events()
        since = parse_timestamp("2023-01-02T00:00:00Z")
        until = parse_timestamp("2023-01-02T00:00:00Z")
        self.assertEqual([e.seq for e in filter_events(events, since=since, until=until)], [2])
        until = parse_timestamp("2023-01-01T23:59:59Z")
        self.assertEqual([e.seq for e in filter_events(events, since=since, until=until)], [])


class SummarizeTests(unittest.TestCase):
    def _path(self):
        return write_temp_jsonl([
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "login", "message": "b"}',
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "a"}',
            '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "logout", "message": "c"}',
        ])

    def test_result_structure(self):
        path = self._path()
        try:
            result = summarize(path)
            self.assertEqual(set(result), {"count", "counts_by_kind", "events"})
            self.assertEqual(result["count"], 3)
            self.assertEqual(result["counts_by_kind"], {"login": 2, "logout": 1})
            self.assertEqual([e["seq"] for e in result["events"]], [1, 2, 3])
        finally:
            os.unlink(path)

    def test_counts_by_kind_sorted_keys(self):
        path = write_temp_jsonl([
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "zeta", "message": "a"}',
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "alpha", "message": "b"}',
            '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "zeta", "message": "c"}',
        ])
        try:
            result = summarize(path)
            self.assertEqual(list(result["counts_by_kind"]), ["alpha", "zeta"])
        finally:
            os.unlink(path)

    def test_kind_filter(self):
        path = self._path()
        try:
            result = summarize(path, kind="login")
            self.assertEqual(result["count"], 2)
            self.assertEqual(result["counts_by_kind"], {"login": 2})
            self.assertEqual([e["seq"] for e in result["events"]], [1, 2])
        finally:
            os.unlink(path)

    def test_since_until_inclusive(self):
        path = self._path()
        try:
            result = summarize(path, since="2023-01-02T00:00:00Z", until="2023-01-02T00:00:00Z")
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["events"][0]["seq"], 2)
        finally:
            os.unlink(path)

    def test_since_after_until(self):
        path = self._path()
        try:
            with self.assertRaises(AuditlogError):
                summarize(path, since="2023-01-03T00:00:00Z", until="2023-01-01T00:00:00Z")
        finally:
            os.unlink(path)

    def test_invalid_since_argument(self):
        path = self._path()
        try:
            with self.assertRaises(ValueError):
                summarize(path, since="not-a-timestamp")
        finally:
            os.unlink(path)

    def test_limit(self):
        path = self._path()
        try:
            result = summarize(path, limit=2)
            self.assertEqual(result["count"], 3)  # before limit
            self.assertEqual(result["counts_by_kind"], {"login": 2, "logout": 1})
            self.assertEqual([e["seq"] for e in result["events"]], [2, 3])  # most recent, ascending
            self.assertTrue(all(set(e) == {"seq", "ts", "kind", "message"} for e in result["events"]))
        finally:
            os.unlink(path)

    def test_limit_larger_than_count(self):
        path = self._path()
        try:
            result = summarize(path, limit=100)
            self.assertEqual([e["seq"] for e in result["events"]], [1, 2, 3])
        finally:
            os.unlink(path)

    def test_limit_non_positive(self):
        path = self._path()
        try:
            with self.assertRaises(AuditlogError):
                summarize(path, limit=0)
            with self.assertRaises(AuditlogError):
                summarize(path, limit=-3)
        finally:
            os.unlink(path)

    def test_empty_file(self):
        path = write_temp_jsonl(["", "   "])
        try:
            result = summarize(path)
            self.assertEqual(result, {"count": 0, "counts_by_kind": {}, "events": []})
        finally:
            os.unlink(path)

    def test_output_is_deterministic(self):
        path = self._path()
        try:
            first = json.dumps(summarize(path), indent=2, sort_keys=True)
            second = json.dumps(summarize(path), indent=2, sort_keys=True)
            self.assertEqual(first, second)
        finally:
            os.unlink(path)


class CLITests(unittest.TestCase):
    def run_cli(self, *args):
        return subprocess.run(
            [PYTHON, "-m", "auditlog", *args],
            capture_output=True,
            text=True,
            cwd=REPO_ROOT,
        )

    def test_success(self):
        path = write_temp_jsonl([
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "a"}',
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "logout", "message": "b"}',
        ])
        try:
            proc = self.run_cli("summarize", path)
            self.assertEqual(proc.returncode, 0, proc.stderr)
            self.assertEqual(proc.stderr, "")
            result = json.loads(proc.stdout)
            self.assertEqual(result["count"], 2)
            self.assertEqual([e["seq"] for e in result["events"]], [1, 2])
        finally:
            os.unlink(path)

    def test_missing_file_no_traceback(self):
        proc = self.run_cli("summarize", "/nonexistent/nope.jsonl")
        self.assertNotEqual(proc.returncode, 0)
        self.assertNotIn("Traceback", proc.stderr)
        self.assertIn("cannot read", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_invalid_since_cli_error(self):
        proc = self.run_cli("summarize", "/dev/null", "--since", "bad")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("invalid RFC3339", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_since_after_until_cli_error(self):
        proc = self.run_cli(
            "summarize", "/dev/null",
            "--since", "2023-01-02T00:00:00Z",
            "--until", "2023-01-01T00:00:00Z",
        )
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("--since must not be later", proc.stderr)
        self.assertEqual(proc.stdout, "")

    def test_limit_must_be_positive(self):
        for limit in ("0", "-1"):
            proc = self.run_cli("summarize", "/dev/null", "--limit", limit)
            self.assertNotEqual(proc.returncode, 0, limit)
            self.assertIn("--limit", proc.stderr)
            self.assertEqual(proc.stdout, "")

    def test_no_args_errors(self):
        proc = self.run_cli()
        self.assertNotEqual(proc.returncode, 0)

    def test_end_to_end_filters_and_limit(self):
        path = write_temp_jsonl([
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "login", "message": "a"}',
            "this is not json",
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "login", "message": "b"}',
            '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "login", "message": "dup"}',
            '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "logout", "message": "c"}',
        ])
        try:
            proc = self.run_cli("summarize", path, "--kind", "login", "--limit", "1")
            self.assertEqual(proc.returncode, 0, proc.stderr)
            result = json.loads(proc.stdout)
            self.assertEqual(result["count"], 2)  # after filter, before limit
            self.assertEqual(result["counts_by_kind"], {"login": 2})
            self.assertEqual([e["seq"] for e in result["events"]], [2])  # most recent
            diagnostics = proc.stderr
            self.assertIn("invalid JSON", diagnostics)
            self.assertIn("duplicate seq 2", diagnostics)
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
