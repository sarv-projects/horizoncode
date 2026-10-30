"""Comprehensive unittest suite for auditlog.

Covers: timestamp parsing, event validation, duplicate handling, filters,
limit behavior, deterministic output, CLI argument errors, and clean file
failure without tracebacks.
"""

from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

from auditlog.cli import main
from auditlog.core import (
    FileError,
    load_events,
    parse_rfc3339_utc,
    summarize,
    validate_event,
)

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def write_jsonl(path: str, lines: list[str]) -> None:
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines) + "\n")


def run_cli(args: list[str]) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["/usr/bin/python3", "-m", "auditlog", "summarize"] + args,
        cwd=REPO_ROOT,
        capture_output=True,
        text=True,
    )


class TestTimestampParsing(unittest.TestCase):
    def test_valid_timestamps(self) -> None:
        for ts in [
            "2023-01-01T00:00:00Z",
            "2023-12-31T23:59:59Z",
            "2023-06-15T12:30:45.123456Z",
            "2023-02-28T00:00:00.000001Z",
        ]:
            with self.subTest(ts=ts):
                self.assertIsNotNone(parse_rfc3339_utc(ts))

    def test_invalid_timestamps(self) -> None:
        for ts in [
            "",
            "not-a-timestamp",
            "2023-01-01",
            "2023-01-01T00:00:00",            # missing Z
            "2023-01-01T00:00:00+05:00",       # non-Z offset
            "2023-13-01T00:00:00Z",            # invalid month
            "2023-01-01T25:00:00Z",            # invalid hour
            True,
            12345,
            None,
            {"ts": "x"},
        ]:
            with self.subTest(ts=ts):
                self.assertIsNone(parse_rfc3339_utc(ts))


class TestEventValidation(unittest.TestCase):
    def test_valid_record(self) -> None:
        obj = {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "hi"}
        record = validate_event(obj, "path", 1)
        self.assertIsNotNone(record)
        self.assertEqual(record["seq"], 1)
        self.assertEqual(record["ts"], "2023-01-01T00:00:00Z")

    def test_bool_seq_rejected(self) -> None:
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            obj = {"seq": True, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "hi"}
            self.assertIsNone(validate_event(obj, "p", 1))
        self.assertIn("invalid seq", err.getvalue())

    def test_missing_field_rejected(self) -> None:
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            obj = {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info"}
            self.assertIsNone(validate_event(obj, "p", 2))
        self.assertIn("missing required field: message", err.getvalue())
        self.assertIn("p line 2", err.getvalue())

    def test_empty_kind_rejected(self) -> None:
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            obj = {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "", "message": "hi"}
            self.assertIsNone(validate_event(obj, "p", 3))
        self.assertIn("non-empty string", err.getvalue())

    def test_non_string_message_rejected(self) -> None:
        with patch("sys.stderr", new_callable=io.StringIO) as err:
            obj = {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": 7}
            self.assertIsNone(validate_event(obj, "p", 4))
        self.assertIn("message (must be a string)", err.getvalue())

    def test_zero_and_negative_seq_rejected(self) -> None:
        for seq in (0, -5):
            with patch("sys.stderr", new_callable=io.StringIO):
                obj = {"seq": seq, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "hi"}
                self.assertIsNone(validate_event(obj, "p", 1))


class TestLoadEvents(unittest.TestCase):
    def test_blank_lines_ignored(self) -> None:
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            path = handle.name
            handle.write("\n\n  \n")
        try:
            with patch("sys.stderr", new_callable=io.StringIO) as err:
                records = load_events(path)
            self.assertEqual(records, [])
            self.assertEqual(err.getvalue(), "")
        finally:
            os.unlink(path)

    def test_malformed_json_reported_and_continued(self) -> None:
        lines = [
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "ok"}',
            "not json at all",
            '{"seq": 2, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "ok2"}',
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            path = handle.name
            handle.write("\n".join(lines) + "\n")
        try:
            with patch("sys.stderr", new_callable=io.StringIO) as err:
                records = load_events(path)
            self.assertEqual([r["seq"] for r in records], [1, 2])
            self.assertIn(path, err.getvalue())
            self.assertIn("line 2", err.getvalue())
            self.assertIn("malformed JSON", err.getvalue())
        finally:
            os.unlink(path)

    def test_invalid_records_do_not_block_valid_ones(self) -> None:
        lines = [
            '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "ok"}',
            '{"seq": true, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "bad"}',
            '{"seq": 3, "ts": "not-a-time", "kind": "info", "message": "bad"}',
            '{"seq": 2, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "ok2"}',
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            path = handle.name
            handle.write("\n".join(lines) + "\n")
        try:
            with patch("sys.stderr", new_callable=io.StringIO):
                records = load_events(path)
            self.assertEqual([r["seq"] for r in records], [1, 2])
        finally:
            os.unlink(path)

    def test_duplicate_seq_keeps_first_and_reports(self) -> None:
        lines = [
            '{"seq": 5, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "first"}',
            '{"seq": 5, "ts": "2023-01-01T01:00:00Z", "kind": "error", "message": "duplicate"}',
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            path = handle.name
            handle.write("\n".join(lines) + "\n")
        try:
            with patch("sys.stderr", new_callable=io.StringIO) as err:
                records = load_events(path)
            self.assertEqual(len(records), 1)
            self.assertEqual(records[0]["message"], "first")
            self.assertIn("duplicate seq 5", err.getvalue())
            self.assertIn("keeping first occurrence", err.getvalue())
        finally:
            os.unlink(path)

    def test_records_sorted_by_seq(self) -> None:
        lines = [
            '{"seq": 30, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "c"}',
            '{"seq": 10, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}',
            '{"seq": 20, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "b"}',
        ]
        with tempfile.NamedTemporaryFile("w", suffix=".jsonl", delete=False) as handle:
            path = handle.name
            handle.write("\n".join(lines) + "\n")
        try:
            with patch("sys.stderr", new_callable=io.StringIO):
                records = load_events(path)
        finally:
            os.unlink(path)
        self.assertEqual([r["seq"] for r in records], [10, 20, 30])

    def test_missing_file_raises_file_error(self) -> None:
        with self.assertRaises(FileError):
            load_events("/nonexistent/path/to/file.jsonl")

    def test_directory_raises_file_error(self) -> None:
        with tempfile.TemporaryDirectory() as dirpath:
            with self.assertRaises(FileError):
                load_events(dirpath)


class TestSummarize(unittest.TestCase):
    def _records(self) -> list[dict]:
        return [
            {"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "error", "message": "b", "_dt": None},  # type: ignore[arg-type]
            {"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a", "_dt": None},  # type: ignore[arg-type]
            {"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "info", "message": "c", "_dt": None},  # type: ignore[arg-type]
        ]

    def test_count_and_counts_by_kind_sorted(self) -> None:
        records = self._records()
        summary = summarize(records)
        self.assertEqual(summary["count"], 3)
        self.assertEqual(summary["counts_by_kind"], {"error": 1, "info": 2})
        self.assertEqual([e["seq"] for e in summary["events"]], [1, 2, 3])

    def test_kind_filter(self) -> None:
        records = self._records()
        summary = summarize(records, kind="info")
        self.assertEqual(summary["count"], 2)
        self.assertEqual(summary["counts_by_kind"], {"info": 2})
        self.assertEqual([e["seq"] for e in summary["events"]], [1, 3])

    def test_since_until_inclusive(self) -> None:
        from datetime import datetime, timezone

        records = [
            {
                "seq": 1,
                "ts": "2023-01-01T00:00:00Z",
                "kind": "info",
                "message": "a",
                "_dt": datetime(2023, 1, 1, tzinfo=timezone.utc),
            },
            {
                "seq": 2,
                "ts": "2023-01-02T00:00:00Z",
                "kind": "error",
                "message": "b",
                "_dt": datetime(2023, 1, 2, tzinfo=timezone.utc),
            },
            {
                "seq": 3,
                "ts": "2023-01-03T00:00:00Z",
                "kind": "info",
                "message": "c",
                "_dt": datetime(2023, 1, 3, tzinfo=timezone.utc),
            },
        ]
        since = datetime(2023, 1, 2, tzinfo=timezone.utc)
        until = datetime(2023, 1, 2, tzinfo=timezone.utc)
        summary = summarize(records, since=since, until=until)
        self.assertEqual(summary["count"], 1)
        self.assertEqual(summary["events"][0]["seq"], 2)

    def test_limit_returns_most_recent_ascending(self) -> None:
        records = self._records()
        summary = summarize(records, limit=2)
        self.assertEqual(summary["count"], 3)  # count is before limit
        self.assertEqual(summary["counts_by_kind"], {"error": 1, "info": 2})
        self.assertEqual([e["seq"] for e in summary["events"]], [2, 3])

    def test_limit_larger_than_results(self) -> None:
        records = self._records()
        summary = summarize(records, limit=100)
        self.assertEqual([e["seq"] for e in summary["events"]], [1, 2, 3])

    def test_output_contains_only_output_fields(self) -> None:
        records = self._records()
        summary = summarize(records)
        for event in summary["events"]:
            self.assertEqual(set(event.keys()), {"seq", "ts", "kind", "message"})

    def test_deterministic_rendering(self) -> None:
        records = self._records()
        summary = summarize(records)
        first = json.dumps(summary, sort_keys=True, indent=2)
        second = json.dumps(summary, sort_keys=True, indent=2)
        self.assertEqual(first, second)
        # keys are sorted in the serialized text
        self.assertTrue(first.index("count") < first.index("counts_by_kind") < first.index("events"))


class TestCLI(unittest.TestCase):
    def setUp(self) -> None:
        self.tmpdir = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmpdir.cleanup)

    def _path(self, name: str = "log.jsonl") -> str:
        return os.path.join(self.tmpdir.name, name)

    def test_basic_summarize(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            [
                '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "error", "message": "b"}',
                '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}',
                '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "info", "message": "c"}',
            ],
        )
        result = run_cli([path])
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["count"], 3)
        self.assertEqual([e["seq"] for e in data["events"]], [1, 2, 3])
        self.assertEqual(result.stderr, "")

    def test_malformed_and_duplicate_records_smoke(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            [
                '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}',
                "this is not json",
                '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "dup"}',
                '{"seq": 2, "ts": "bad-stamp", "kind": "info", "message": "bad ts"}',
                '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "info", "message": "c"}',
                "",
            ],
        )
        result = run_cli([path])
        self.assertEqual(result.returncode, 0, result.stderr)
        data = json.loads(result.stdout)
        self.assertEqual(data["count"], 2)
        self.assertEqual([e["seq"] for e in data["events"]], [1, 3])
        self.assertIn(path, result.stderr)
        self.assertIn("line 2", result.stderr)
        self.assertIn("line 3", result.stderr)
        self.assertIn("line 4", result.stderr)
        self.assertIn("duplicate seq 1", result.stderr)
        self.assertIn("malformed JSON", result.stderr)

    def test_kind_filter_cli(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            [
                '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}',
                '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "error", "message": "b"}',
                '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "error", "message": "c"}',
            ],
        )
        result = run_cli([path, "--kind", "error"])
        data = json.loads(result.stdout)
        self.assertEqual(data["count"], 2)
        self.assertEqual(data["counts_by_kind"], {"error": 2})
        self.assertEqual([e["seq"] for e in data["events"]], [2, 3])

    def test_since_until_filters_cli(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            [
                '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}',
                '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "info", "message": "b"}',
                '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "info", "message": "c"}',
            ],
        )
        result = run_cli([path, "--since", "2023-01-02T00:00:00Z", "--until", "2023-01-02T00:00:00Z"])
        data = json.loads(result.stdout)
        self.assertEqual(data["count"], 1)
        self.assertEqual(data["events"][0]["seq"], 2)

    def test_limit_cli(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            [
                '{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}',
                '{"seq": 2, "ts": "2023-01-02T00:00:00Z", "kind": "info", "message": "b"}',
                '{"seq": 3, "ts": "2023-01-03T00:00:00Z", "kind": "info", "message": "c"}',
                '{"seq": 4, "ts": "2023-01-04T00:00:00Z", "kind": "info", "message": "d"}',
            ],
        )
        result = run_cli([path, "--limit", "2"])
        data = json.loads(result.stdout)
        self.assertEqual(data["count"], 4)
        self.assertEqual([e["seq"] for e in data["events"]], [3, 4])

    def test_output_only_json_on_stdout(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            ['{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}'],
        )
        result = run_cli([path])
        self.assertEqual(result.returncode, 0)
        json.loads(result.stdout)  # must parse
        self.assertEqual(result.stdout.strip(), result.stdout.rstrip("\n"))
        self.assertNotIn("auditlog", result.stdout)

    def test_invalid_timestamp_argument_rejected(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            ['{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}'],
        )
        for flag, value in (("--since", "not-a-time"), ("--until", "2023-01-01")):
            with self.subTest(flag=flag):
                result = run_cli([path, flag, value])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(flag, result.stderr)
                self.assertEqual(result.stdout, "")

    def test_since_later_than_until_rejected(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            ['{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}'],
        )
        result = run_cli([path, "--since", "2023-01-02T00:00:00Z", "--until", "2023-01-01T00:00:00Z"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("--since", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_non_positive_limit_rejected(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            ['{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}'],
        )
        for value in ("0", "-1"):
            with self.subTest(value=value):
                result = run_cli([path, "--limit", value])
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("--limit", result.stderr)
                self.assertEqual(result.stdout, "")

    def test_missing_file_clean_failure(self) -> None:
        result = run_cli(["/nonexistent/dir/nope.jsonl"])
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("not found", result.stderr)
        self.assertNotIn("Traceback", result.stderr)
        self.assertEqual(result.stdout, "")

    def test_exit_status_is_zero_on_success(self) -> None:
        path = self._path()
        write_jsonl(
            path,
            ['{"seq": 1, "ts": "2023-01-01T00:00:00Z", "kind": "info", "message": "a"}'],
        )
        result = run_cli([path])
        self.assertEqual(result.returncode, 0)

    def test_no_subcommand_errors(self) -> None:
        result = run_cli([])
        self.assertNotEqual(result.returncode, 0)


if __name__ == "__main__":
    unittest.main()
