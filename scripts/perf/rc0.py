#!/usr/bin/env python3
"""Capture owner-identified RC0 process samples as JSONL; never launches workloads."""
import argparse
import json
import os
import platform
import subprocess
import re
import sys
from datetime import datetime, timezone
from pathlib import Path

MAX_PROCESSES = 256
MAX_BYTES = 1_048_576
MAX_WORK = 4096
SCENARIOS = (1, 5, 10, 20)
REQUIRED_LINUX_METRICS = ("pss_bytes", "rss_bytes", "cpu_ns", "thread_count", "fd_count")
PROC_ROOT = Path("/proc")


class Budget:
    def __init__(self, max_bytes=MAX_BYTES, max_work=MAX_WORK):
        self.max_bytes = min(max_bytes, MAX_BYTES)
        self.max_work = min(max_work, MAX_WORK)
        self.bytes = 0
        self.work = 0

    def charge_work(self, amount=1):
        if amount < 0 or self.work + amount > self.max_work:
            raise ValueError("sample work budget exceeded")
        self.work += amount

    def bounded_items(self, iterable):
        iterator = iter(iterable)
        allowance = self.max_work - self.work
        if allowance <= 0:
            raise ValueError("sample work budget exceeded")
        for _ in range(allowance):
            try:
                item = next(iterator)
            except StopIteration:
                return
            self.work += 1
            yield item
        raise ValueError("sample work budget exceeded")


def git_metadata():
    try:
        repo_root = Path(__file__).resolve().parents[2]
        commit = subprocess.run(["git", "rev-parse", "HEAD"], cwd=repo_root, check=True, text=True,
                                stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.strip()
        dirty = bool(subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"],
                                    cwd=repo_root, check=True, text=True,
                                    stdout=subprocess.PIPE, stderr=subprocess.DEVNULL).stdout.strip())
        return commit, not dirty
    except (OSError, subprocess.CalledProcessError):
        return None, False


def platform_name():
    system = platform.system()
    if system == "Linux":
        release = platform.release()
        return {"name": "linux-wsl" if "microsoft" in release.lower() else "linux-native",
                "kernel": release, "machine": platform.machine()}
    if system == "Windows":
        return {"name": "windows-native", "release": platform.version(), "machine": platform.machine()}
    return {"name": system.lower(), "release": platform.release(), "machine": platform.machine()}


def hardware_metadata():
    processor = platform.processor() or None
    if not processor and PROC_ROOT.exists():
        try:
            with open(PROC_ROOT / "cpuinfo", "rb") as stream:
                cpuinfo = stream.read(65_536)
            for line in cpuinfo.splitlines():
                if line.lower().startswith((b"model name", b"hardware")) and b":" in line:
                    processor = line.split(b":", 1)[1].decode("utf-8", errors="replace").strip()
                    if processor:
                        break
        except OSError:
            pass
    memory_bytes = None
    try:
        memory_bytes = os.sysconf("SC_PHYS_PAGES") * os.sysconf("SC_PAGE_SIZE")
    except (AttributeError, OSError, ValueError):
        pass
    return {
        "processor": processor,
        "logical_cpu_count": os.cpu_count(),
        "memory_bytes": memory_bytes,
    }


def read_limited(path, budget, per_file_limit=MAX_BYTES):
    budget.charge_work()
    remaining = budget.max_bytes - budget.bytes
    cap = min(per_file_limit, remaining)
    if cap <= 0:
        raise ValueError("sample byte budget exceeded")
    with open(path, "rb") as stream:
        data = stream.read(cap)
    budget.bytes += len(data)
    if len(data) == cap:
        raise ValueError("source reached byte budget; sample is incomplete")
    return data.decode("utf-8", errors="strict")


def proc_identity(pid, budget):
    text = read_limited(PROC_ROOT / str(pid) / "stat", budget, 16_384)
    end = text.rfind(")")
    if end < 0:
        raise ValueError("malformed /proc stat")
    fields = text[end + 2:].split()
    if len(fields) <= 19:
        raise ValueError("malformed /proc stat")
    return int(fields[19]), int(fields[1])


def linux_counters(pid, budget):
    base = PROC_ROOT / str(pid)
    reasons = {}
    counters = {}
    try:
        text = read_limited(base / "smaps_rollup", budget)
        pss = next((line.split()[1] for line in text.splitlines() if line.startswith("Pss:")), None)
        counters["pss_bytes"] = int(pss) * 1024 if pss is not None else None
        if pss is None:
            reasons["pss_bytes"] = "missing"
    except PermissionError:
        counters["pss_bytes"] = None
        reasons["pss_bytes"] = "permission_denied"
    except (OSError, ValueError, IndexError):
        counters["pss_bytes"] = None
        reasons["pss_bytes"] = "unavailable_or_malformed_or_budget_exceeded"
    try:
        text = read_limited(base / "status", budget)
        values = {line.split(":", 1)[0]: line.split(":", 1)[1].strip().split()[0]
                  for line in text.splitlines() if ":" in line}
        counters["rss_bytes"] = int(values["VmRSS"]) * 1024
        counters["thread_count"] = int(values["Threads"])
    except (OSError, ValueError, KeyError, IndexError):
        counters["rss_bytes"] = None
        counters["thread_count"] = None
        reasons["rss_bytes"] = "unavailable_or_malformed_or_budget_exceeded"
        reasons["thread_count"] = "unavailable_or_malformed_or_budget_exceeded"
    try:
        stat = read_limited(base / "stat", budget, 16_384)
        fields = stat[stat.rfind(")") + 2:].split()
        ticks = int(fields[11]) + int(fields[12])
        counters["cpu_ns"] = ticks * 1_000_000_000 // os.sysconf("SC_CLK_TCK")
    except (OSError, ValueError, IndexError, ZeroDivisionError):
        counters["cpu_ns"] = None
        reasons["cpu_ns"] = "unavailable_or_malformed_or_budget_exceeded"
    try:
        counters["fd_count"] = sum(1 for _entry in budget.bounded_items((base / "fd").iterdir()))
    except (OSError, ValueError):
        counters["fd_count"] = None
        reasons["fd_count"] = "permission_denied_or_unavailable_or_budget_exceeded"
    counters["private_bytes"] = None
    reasons["private_bytes"] = "unsupported_on_linux"
    return counters, reasons


def children(parent_pid, parent_start, budget):
    """Enumerate direct children only while fencing owner and child PID generations."""
    before, _ = proc_identity(parent_pid, budget)
    if before != parent_start:
        raise ValueError("parent identity changed before child enumeration")
    task_root = PROC_ROOT / str(parent_pid) / "task"
    child_identities = {}
    for thread_dir in budget.bounded_items(task_root.iterdir()):
        child_file = thread_dir / "children"
        child_text = read_limited(child_file, budget, 65_536)
        tokens = (match.group(0) for match in re.finditer(r"\S+", child_text))
        for raw_pid in budget.bounded_items(tokens):
            child_pid = int(raw_pid)
            child_start, actual_parent = proc_identity(child_pid, budget)
            if actual_parent != parent_pid:
                raise ValueError("child was reparented during discovery")
            child_identities[child_pid] = child_start
    parent_after, _ = proc_identity(parent_pid, budget)
    if parent_after != parent_start:
        raise ValueError("parent identity changed during child enumeration")
    for child_pid, child_start in child_identities.items():
        actual_start, actual_parent = proc_identity(child_pid, budget)
        if actual_start != child_start or actual_parent != parent_pid:
            raise ValueError("child identity or parent changed before enqueue")
    parent_after_children, _ = proc_identity(parent_pid, budget)
    if parent_after_children != parent_start:
        raise ValueError("parent identity changed before child enqueue")
    return list(child_identities.items())


def sample_identity(pid, expected_start, budget):
    before, parent = proc_identity(pid, budget)
    if before != expected_start:
        return {"pid": pid, "start_identity": str(expected_start), "quality": "UNKNOWN",
                "identity_valid": False, "reason": "identity_mismatch", "metrics": {}}
    counters, reasons = linux_counters(pid, budget)
    after, _ = proc_identity(pid, budget)
    if after != expected_start:
        return {"pid": pid, "start_identity": str(expected_start), "quality": "UNKNOWN",
                "identity_valid": False, "reason": "identity_changed_during_sample", "metrics": {}}
    complete = all(counters.get(metric) is not None for metric in REQUIRED_LINUX_METRICS)
    return {"pid": pid, "start_identity": str(expected_start), "parent_pid": parent,
            "identity_valid": True, "quality": "MEASURED" if complete else "UNKNOWN",
            "metrics": counters, "unknown_reasons": reasons}

def sample_tree(root_pid, root_start):
    if platform.system() != "Linux":
        return {"processes": [], "quality": "UNKNOWN", "truncated": True,
                "reason": "native Windows sampler is unavailable to this harness"}
    budget = Budget()
    queue = [(root_pid, root_start)]
    seen = set()
    output = []
    truncated = False
    try:
        while queue:
            pid, start = queue.pop(0)
            if (pid, start) in seen:
                continue
            seen.add((pid, start))
            budget.charge_work()
            if len(output) >= MAX_PROCESSES:
                truncated = True
                break
            sample = sample_identity(pid, start, budget)
            output.append(sample)
            if sample.get("identity_valid"):
                queue.extend(children(pid, start, budget))
    except (PermissionError, OSError, ValueError, IndexError):
        truncated = True
    complete = (not truncated and bool(output)
                and all(item.get("identity_valid") and item.get("quality") == "MEASURED" for item in output))
    return {"processes": output, "quality": "MEASURED" if complete else "UNKNOWN",
            "truncated": truncated, "source_bytes": budget.bytes, "work_items": budget.work,
            "reason": None if complete else "partial_or_unknown_sample"}


def baseline_eligible(selected, session_results, outcomes, commit, clean_tree, provider_model, build, harness, local_inference):
    if len(selected) != len(session_results) or not selected:
        return False
    if {session for session, _identity in selected} != {item.get("session_id") for item in session_results}:
        return False
    if not commit or not clean_tree or not provider_model.strip() or provider_model.lower() in ("unknown", "not-recorded"):
        return False
    if not build.strip() or not harness.strip() or local_inference not in ("included", "excluded"):
        return False
    for session, _identity in selected:
        if session not in outcomes:
            return False
        outcome = outcomes[session]
        if not isinstance(outcome, dict) or outcome.get("expected") is None:
            return False
        if outcome.get("actual") != outcome["expected"] or outcome.get("status") != "passed":
            return False
    selected_by_session = dict(selected)
    for item in session_results:
        session = item.get("session_id")
        if session not in selected_by_session:
            return False
        owner = item.get("owner_identity", {})
        expected_pid, expected_start = selected_by_session[session]
        if owner.get("pid") != expected_pid or str(owner.get("start_identity")) != str(expected_start):
            return False
        sample = item.get("sample", {})
        if sample.get("quality") != "MEASURED" or sample.get("truncated"):
            return False
        processes = sample.get("processes", [])
        if not processes or not any(
            process.get("pid") == expected_pid and str(process.get("start_identity")) == str(expected_start)
            for process in processes
        ):
            return False
        for process in processes:
            metrics = process.get("metrics", {})
            if not process.get("identity_valid") or process.get("quality") != "MEASURED":
                return False
            if any(metrics.get(metric) is None for metric in REQUIRED_LINUX_METRICS):
                return False
    return True


def identity_arg(value):
    try:
        session, encoded = value.split("=", 1)
        pid, start = encoded.split(":", 1)
        result = (session, int(pid), int(start))
        if not session or result[1] <= 0 or result[2] < 0:
            raise ValueError
        return result
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected SESSION=PID:START_IDENTITY") from error


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--identity", action="append", type=identity_arg, default=[], help="owner-issued SESSION=PID:START_IDENTITY; repeat per session")
    parser.add_argument("--outcomes", type=Path, help="JSON object mapping sessions to expected/actual/status task outcomes")
    parser.add_argument("--scenario", required=True, help="real workload/task description")
    parser.add_argument("--build", required=True, help="build profile and compiler/runtime identifiers")
    parser.add_argument("--warm-cold", choices=("warm", "cold"), required=True)
    parser.add_argument("--provider-model", required=True, help="selected provider and model")
    parser.add_argument("--harness", required=True, help="selected coding agent or harness")
    parser.add_argument("--local-inference", choices=("included", "excluded"), required=True)
    parser.add_argument("--output", type=Path, help="append JSONL to this path (default: stdout)")
    args = parser.parse_args()

    grouped = {}
    for session, pid, start in args.identity:
        if session in grouped:
            parser.error(f"duplicate owner-issued identity for session {session!r}")
        grouped[session] = (pid, start)
    outcomes = {}
    if args.outcomes:
        outcomes = json.loads(args.outcomes.read_text(encoding="utf-8"))
        if not isinstance(outcomes, dict):
            parser.error("--outcomes must contain a JSON object mapping session IDs to outcomes")
    commit, clean_tree = git_metadata()
    records = []
    for session_count in SCENARIOS:
        selected = list(grouped.items())[:session_count]
        session_results = []
        for session, (pid, start) in selected:
            session_results.append({"session_id": session,
                "owner_identity": {"pid": pid, "start_identity": str(start)},
                "task_outcome": outcomes.get(session), "sample": sample_tree(pid, start)})
        eligible = (len(selected) == session_count and bool(args.scenario.strip()) and baseline_eligible(
            selected, session_results, outcomes, commit, clean_tree, args.provider_model,
            args.build, args.harness, args.local_inference))
        measured_ids = sum(item["sample"].get("quality") == "MEASURED" for item in session_results)
        records.append({"record_type": "rc0_sample", "captured_at": datetime.now(timezone.utc).isoformat(),
            "platform": platform_name(), "machine": {"architecture": platform.machine(), **hardware_metadata()},
            "commit": commit, "working_tree_clean": clean_tree, "commit_exact": bool(commit and clean_tree),
            "build": args.build, "harness": args.harness, "warm_cold": args.warm_cold, "scenario": args.scenario,
            "sessions_requested": session_count, "sessions_supplied": len(selected),
            "provider_model": args.provider_model, "local_inference": args.local_inference,
            "measured_owned_identities": measured_ids, "expected_task_outcomes_present": bool(selected) and all(
                isinstance(outcomes.get(session), dict) and outcomes[session].get("expected") is not None for session, _ in selected),
            "task_outcomes_passed": bool(selected) and all(
                isinstance(outcomes.get(session), dict) and outcomes[session].get("expected") == outcomes[session].get("actual")
                and outcomes[session].get("status") == "passed" for session, _ in selected),
            "baseline_eligible": eligible, "status": "BASELINE_CANDIDATE" if eligible else "NOT_BASELINE",
            "sessions": session_results})
    out = open(args.output, "a", encoding="utf-8") if args.output else sys.stdout
    try:
        for record in records:
            out.write(json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n")
    finally:
        if args.output:
            out.close()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
