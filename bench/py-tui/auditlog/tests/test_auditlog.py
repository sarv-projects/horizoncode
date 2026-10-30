"""Comprehensive unit tests for auditlog.

Tests exercise the core validation/filtering modules and the CLI end to end
(capturing stdout/stderr and exit codes) without invoking a subprocess.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from auditlog.cli import main
from auditlog.core import (
    AuditlogError,
    InvalidRecord,
    build_summary,
    filter_events,
    parse_rfc3339_utc,
    read_events,
    render_summary,
    validate_event,
)

UTC = timezone.utc


def make_event(seq, ts, kind, message):
    return {"seq": seq, "ts": ts, "kind": kind, "message": message}


def write_temp_jsonl(lines):
    """Write ``lines`` to a temp file and return its path."""
    handle, path = tempfile.mkstemp(suffix=".jsonl")
    with os.fdopen(handle, "w", encoding="utf-8") as handle:
        for line in lines:
            handle.write(line + "\n")
    return path


class Rfc3339ParsingTests(unittest.TestCase):
    def test_accepts_whole_seconds(self):
        self.assertEqual(
            parse_rfc3339_utc("2023-01-01T00:00:00Z"),
            datetime(2023, 1, 1, tzinfo=UTC),
        )

    def test_accepts_fractional_seconds(self):
        dt = parse_rfc3339_utc("2023-12-31T23:59:59.5Z")
        self.assertEqual(dt.microsecond, 500000)
        self.assertEqual(dt.tzinfo, UTC)

    def test_accepts_microseconds(self):
        dt = parse_rfc3339_utc("2023-06-15T12:30:45.123456Z")
        self.assertEqual(dt.microsecond, 123456)

    def test_rejects_non_string(self):
        for bad in (123, None, ["2023-01-01T00:00:00Z"]):
            with self.assertRaises(ValueError):
                parse_rfc3339_utc(bad)

    def test_rejects_missing_z(self):
        with self.assertRaises(ValueError):
            parse_rfc3339_utc("2023-01-01T00:00:00+00:00")
        with self.assertRaises(ValueError):
            parse_rfc3339_utc("2023-01-01T00:00:00")

    def test_rejects_invalid_date(self):
        with self.assertRaises(ValueError):
            parse_rfc3339_utc("2023-13-01T00:00:00Z")
        with self.assertRaises(ValueError):
            parse_rfc3339_utc("2023-01-32T00:00:00Z")

    def test_rejects_non_utc_offset(self):
        with self.assertRaises(ValueError):
            parse_rfc3339_utc("2023-01-01T00:00:00+05:00")
        # Also reject a Z-less form that fromisoformat might otherwise parse.


class ValidationTests(unittest.TestCase):
    def test_accepts_valid_event(self):
        event = make_event(1, "2023-01-01T00:00:00Z", "login", "signed in")
        validate_event(event)  # should not raise

    def test_rejects_non_dict(self):
        with self.assertRaises(InvalidRecord):
            validate_event([1, 2, 3])
        with self.assertRaises(InvalidRecord):
            validate_event("not an object")

    def test_rejects_missing_fields(self):
        base = make_event(1, "2023-01-01T00:00:00Z", "login", "hi")
        for field in ("seq", "ts", "kind", "message"):
            bad = dict(base)
            del bad[field]
            with self.assertRaises(InvalidRecord):
                validate_event(bad)

    def test_rejects_bool_seq(self):
        bad = make_event(True, "2023-01-01T00:00:00Z", "login", "hi")
        with self.assertRaises(InvalidRecord):
            validate_event(bad)

    def test_rejects_non_positive_seq(self):
        for bad_seq in (0, -1, 1.5, "1", None):
            bad = make_event(bad_seq, "2023-01-01T00:00:00Z", "login", "hi")
            with self.assertRaises(InvalidRecord):
                validate_event(bad)

    def test_rejects_bad_ts(self):
        bad = make_event(1, "not-a-timestamp", "login", "hi")
        with self.assertRaises(InvalidRecord):
            validate_event(bad)
        bad = make_event(1, "2023-01-01T00:00:00+05:00", "login", "hi")
        with self.assertRaises(InvalidRecord):
            validate_event(bad)

    def test_rejects_empty_or_non_string_kind(self):
        for bad_kind in ("", 1, None, ["login"]):
            bad = make_event(1, "2023-01-01T00:00:00Z", bad_kind, "hi")
            with self.assertRaises(InvalidRecord):
                validate_event(bad)

    def test_rejects_non_string_message(self):
        for bad_msg in (1, None, ["msg"], {"msg": "x"}):
            bad = make_event(1, "2023-01-01T00:00:00Z", "login", bad_msg)
            with self.assertRaises(InvalidRecord):
                validate_event(bad)


class ReadEventsTests(unittest.TestCase):
    def test_ignores_blank_lines(self):
        path = write_temp_jsonl(
            [
                '',
                json.dumps(make_event(1, "2023-01-01T00:00:00Z", "a", "x")),
                '   ',
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "a", "y")),
                "\t\n",
            ]
        )
        events, diagnostics = read_events(path)
        self.assertEqual([e["seq"] for e in events], [1, 2])
        self.assertEqual(diagnostics, [])
        os.unlink(path)

    def test_malformed_json_continues(self):
        path = write_temp_jsonl(
            [
                "not json",
                json.dumps(make_event(1, "2023-01-01T00:00:00Z", "a", "x")),
                "{broken",
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "a", "y")),
            ]
        )
        events, diagnostics = read_events(path)
        self.assertEqual([e["seq"] for e in events], [1, 2])
        joined = "\n".join(diagnostics)
        self.assertEqual(len(diagnostics), 2)
        self.assertIn(":1: malformed JSON:", joined)
        self.assertIn(":3: malformed JSON:", joined)
        os.unlink(path)

    def test_invalid_records_continue(self):
        path = write_temp_jsonl(
            [
                json.dumps({"seq": 1, "ts": "bad", "kind": "a", "message": "x"}),
                json.dumps(make_event(2, "2023-01-01T00:00:00Z", "a", "y")),
                json.dumps({"seq": 3, "ts": "2023-01-01T00:00:00Z", "kind": "", "message": "z"}),
            ]
        )
        events, diagnostics = read_events(path)
        self.assertEqual([e["seq"] for e in events], [2])
        self.assertEqual(len(diagnostics), 2)
        os.unlink(path)

    def test_duplicate_seq_keeps_first(self):
        path = write_temp_jsonl(
            [
                json.dumps(make_event(5, "2023-01-01T00:00:05Z", "a", "first")),
                json.dumps(make_event(3, "2023-01-01T00:00:03Z", "a", "early")),
                json.dumps(make_event(5, "2023-01-01T00:00:05Z", "b", "duplicate")),
                json.dumps(make_event(1, "2023-01-01T00:00:01Z", "a", "last")),
            ]
        )
        events, diagnostics = read_events(path)
        self.assertEqual([e["seq"] for e in events], [1, 3, 5])
        self.assertEqual(events[2]["message"], "first")
        self.assertEqual(len(diagnostics), 1)
        self.assertIn("duplicate seq 5", diagnostics[0])
        os.unlink(path)

    def test_returns_sorted_by_seq(self):
        path = write_temp_jsonl(
            [
                json.dumps(make_event(9, "2023-01-01T00:00:09Z", "a", "i")),
                json.dumps(make_event(1, "2023-01-01T00:00:01Z", "a", "i")),
                json.dumps(make_event(5, "2023-01-01T00:00:05Z", "a", "i")),
            ]
        )
        events, _ = read_events(path)
        self.assertEqual([e["seq"] for e in events], [1, 5, 9])
        os.unlink(path)

    def test_missing_file_fails_cleanly(self):
        with self.assertRaises(AuditlogError):
            read_events("/nonexistent/path/to/auditlog.jsonl")

    def test_unreadable_file_fails_cleanly(self):
        handle, path = tempfile.mkstemp(suffix=".jsonl")
        os.close(handle)
        os.chmod(path, 0o000)
        try:
            with self.assertRaises(AuditlogError):
                read_events(path)
        finally:
            os.chmod(path, 0o644)
            os.unlink(path)


class FilterEventsTests(unittest.TestCase):
    events = [
        make_event(1, "2023-01-01T00:00:00Z", "login", "a"),
        make_event(2, "2023-01-01T00:00:01Z", "logout", "b"),
        make_event(3, "2023-01-01T00:00:02Z", "login", "c"),
        make_event(4, "2023-01-01T00:00:03Z", "error", "d"),
    ]

    def test_no_filter_returns_all(self):
        self.assertEqual(len(filter_events(self.events, None, None, None)), 4)

    def test_kind_filter(self):
        result = filter_events(self.events, "login", None, None)
        self.assertEqual([e["seq"] for e in result], [1, 3])

    def test_since_inclusive(self):
        result = filter_events(self.events, None, parse_rfc3339_utc("2023-01-01T00:00:01Z"), None)
        self.assertEqual([e["seq"] for e in result], [2, 3, 4])

    def test_until_inclusive(self):
        result = filter_events(self.events, None, None, parse_rfc3339_utc("2023-01-01T00:00:01Z"))
        self.assertEqual([e["seq"] for e in result], [1, 2])

    def test_since_until_window(self):
        result = filter_events(
            self.events, None,
            parse_rfc3339_utc("2023-01-01T00:00:01Z"),
            parse_rfc3339_utc("2023-01-01T00:00:02Z"),
        )
        self.assertEqual([e["seq"] for e in result], [2, 3])


class BuildSummaryTests(unittest.TestCase):
    events = [
        make_event(1, "2023-01-01T00:00:00Z", "login", "a"),
        make_event(2, "2023-01-01T00:00:01Z", "logout", "b"),
        make_event(3, "2023-01-01T00:00:02Z", "login", "c"),
        make_event(4, "2023-01-01T00:00:03Z", "error", "d"),
        make_event(5, "2023-01-01T00:00:04Z", "login", "e"),
    ]

    def test_count_before_limit(self):
        summary = build_summary(self.events, 2)
        self.assertEqual(summary["count"], 5)

    def test_counts_by_kind_sorted(self):
        summary = build_summary(self.events, None)
        self.assertEqual(summary["counts_by_kind"], {"error": 1, "login": 3, "logout": 1})

    def test_limit_returns_n_most_recent_ascending(self):
        summary = build_summary(self.events, 3)
        self.assertEqual([e["seq"] for e in summary["events"]], [3, 4, 5])

    def test_limit_larger_than_count_returns_all(self):
        summary = build_summary(self.events, 100)
        self.assertEqual([e["seq"] for e in summary["events"]], [1, 2, 3, 4, 5])

    def test_render_deterministic(self):
        summary = build_summary(self.events, None)
        first = render_summary(summary)
        second = render_summary(summary)
        self.assertEqual(first, second)
        parsed = json.loads(first)
        self.assertEqual(list(parsed.keys()), ["count", "counts_by_kind", "events"])


class CliTests(unittest.TestCase):
    valid_line = json.dumps(make_event(1, "2023-01-01T00:00:00Z", "login", "signed in"))

    def run_cli(self, argv):
        out = io.StringIO()
        err = io.StringIO()
        try:
            with contextlib.redirect_stdout(out), contextlib.redirect_stderr(err):
                code = main(argv)
        except SystemExit as exc:  # argparse exits 2 on argument errors
            code = exc.code if isinstance(exc.code, int) else 2
        return code, out.getvalue(), err.getvalue()

    def test_happy_path(self):
        path = write_temp_jsonl(
            [
                self.valid_line,
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "logout", "signed out")),
                json.dumps(make_event(3, "2023-01-01T00:00:02Z", "login", "again")),
            ]
        )
        try:
            code, out, err = self.run_cli(["summarize", path])
            self.assertEqual(code, 0, err)
            self.assertEqual(err, "", err)
            data = json.loads(out)
            self.assertEqual(data["count"], 3)
            self.assertEqual(data["counts_by_kind"], {"login": 2, "logout": 1})
            self.assertEqual([e["seq"] for e in data["events"]], [1, 2, 3])
        finally:
            os.unlink(path)

    def test_output_json_only_on_stdout(self):
        path = write_temp_jsonl(["not json", self.valid_line])
        try:
            code, out, err = self.run_cli(["summarize", path])
            self.assertEqual(code, 0)
            json.loads(out)  # stdout is valid JSON
            self.assertIn(":1: malformed JSON:", err)
        finally:
            os.unlink(path)

    def test_kind_filter(self):
        path = write_temp_jsonl(
            [
                self.valid_line,
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "logout", "out")),
                json.dumps(make_event(3, "2023-01-01T00:00:02Z", "login", "again")),
            ]
        )
        try:
            code, out, err = self.run_cli(["summarize", "--kind", "login", path])
            self.assertEqual(code, 0)
            data = json.loads(out)
            self.assertEqual(data["count"], 2)
            self.assertEqual([e["seq"] for e in data["events"]], [1, 3])
        finally:
            os.unlink(path)

    def test_since_until_filters(self):
        path = write_temp_jsonl(
            [
                self.valid_line,
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "login", "b")),
                json.dumps(make_event(3, "2023-01-01T00:00:02Z", "login", "c")),
            ]
        )
        try:
            code, out, err = self.run_cli(
                ["summarize", "--since", "2023-01-01T00:00:01Z", "--until", "2023-01-01T00:00:01Z", path]
            )
            self.assertEqual(code, 0)
            data = json.loads(out)
            self.assertEqual(data["count"], 1)
            self.assertEqual(data["events"][0]["seq"], 2)
        finally:
            os.unlink(path)

    def test_limit_most_recent_ascending(self):
        path = write_temp_jsonl(
            [
                self.valid_line,
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "login", "b")),
                json.dumps(make_event(3, "2023-01-01T00:00:02Z", "login", "c")),
                json.dumps(make_event(4, "2023-01-01T00:00:03Z", "login", "d")),
            ]
        )
        try:
            code, out, err = self.run_cli(["summarize", "--limit", "2", path])
            self.assertEqual(code, 0)
            data = json.loads(out)
            self.assertEqual(data["count"], 4)  # before limit
            self.assertEqual([e["seq"] for e in data["events"]], [3, 4])
        finally:
            os.unlink(path)

    def test_duplicate_seq_keeps_first(self):
        path = write_temp_jsonl(
            [
                json.dumps(make_event(1, "2023-01-01T00:00:00Z", "login", "first")),
                json.dumps(make_event(1, "2023-01-01T00:00:00Z", "logout", "duplicate")),
            ]
        )
        try:
            code, out, err = self.run_cli(["summarize", path])
            self.assertEqual(code, 0)
            self.assertIn("duplicate seq 1", err)
            data = json.loads(out)
            self.assertEqual(data["events"][0]["message"], "first")
        finally:
            os.unlink(path)

    def test_missing_file_no_traceback(self):
        code, out, err = self.run_cli(["summarize", "/nonexistent/auditlog.jsonl"])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")
        self.assertIn("cannot read input file", err)
        self.assertNotIn("Traceback", err)

    def test_invalid_since_rejected(self):
        path = write_temp_jsonl([self.valid_line])
        try:
            code, out, err = self.run_cli(["summarize", "--since", "not-a-time", path])
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
            self.assertIn("--since", err)
        finally:
            os.unlink(path)

    def test_invalid_until_rejected(self):
        path = write_temp_jsonl([self.valid_line])
        try:
            code, out, err = self.run_cli(["summarize", "--until", "nope", path])
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
            self.assertIn("--until", err)
        finally:
            os.unlink(path)

    def test_since_after_until_rejected(self):
        path = write_temp_jsonl([self.valid_line])
        try:
            code, out, err = self.run_cli(
                ["summarize", "--since", "2023-01-02T00:00:00Z", "--until", "2023-01-01T00:00:00Z", path]
            )
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
            self.assertIn("--since", err)
            self.assertIn("--until", err)
        finally:
            os.unlink(path)

    def test_non_positive_limit_rejected(self):
        path = write_temp_jsonl([self.valid_line])
        try:
            for bad in ("0", "-1"):
                code, out, err = self.run_cli(["summarize", "--limit", bad, path])
                self.assertNotEqual(code, 0, bad)
                self.assertEqual(out, "")
                self.assertIn("--limit", err)
        finally:
            os.unlink(path)

    def test_non_integer_limit_rejected(self):
        path = write_temp_jsonl([self.valid_line])
        try:
            code, out, err = self.run_cli(["summarize", "--limit", "abc", path])
            self.assertNotEqual(code, 0)
            self.assertEqual(out, "")
        finally:
            os.unlink(path)

    def test_no_command_exits_nonzero(self):
        code, out, err = self.run_cli([])
        self.assertNotEqual(code, 0)
        self.assertEqual(out, "")

    def test_deterministic_output_across_runs(self):
        path = write_temp_jsonl(
            [
                self.valid_line,
                json.dumps(make_event(2, "2023-01-01T00:00:01Z", "logout", "out")),
                json.dumps(make_event(3, "2023-01-01T00:00:02Z", "login", "again")),
            ]
        )
        try:
            results = []
            for _ in range(3):
                code, out, _ = self.run_cli(["summarize", path])
                self.assertEqual(code, 0)
                results.append(out)
            self.assertEqual(results[0], results[1])
            self.assertEqual(results[1], results[2])
        finally:
            os.unlink(path)


if __name__ == "__main__":
    unittest.main()
