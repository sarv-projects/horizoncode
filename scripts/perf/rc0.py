#!/usr/bin/env python3
"""Capture owner-identified RC0 process samples as JSONL; never launches product workloads.

``--selfcheck`` samples only this process's own bounded ``sleep`` child tree to verify the
harness against the live OS; it is not a product-session measurement.

``--preflight`` validates the *shape and liveness* of the exact 1/5/10/20 capture inputs
(identities exist with the supplied ``/proc`` start identity, outcome objects are internally
consistent, scenario/build/provider/harness/model metadata present, clean commit) and prints
the exact capture command. It performs no measurement and no billing.

**Provenance:** every CLI/JSON value is caller-supplied and therefore UNVERIFIED. This harness
has no locally verifiable, owner-backed attestation source for "this PID is a Horizon Session"
or "this task outcome was attested by a Horizon Run", so captured records are always labeled
``provisional_raw_sample``/``NOT_BASELINE`` with ``release_eligible: False``; a release-eligible
baseline requires an :class:`AttestationV1` from a configured trusted owner source
(:data:`TRUSTED_ATTESTATION_SOURCES`, currently empty) and actual capture stays BLOCKED until
the Core/Rust session owner supplies independently verifiable live Session and Run-attested
task evidence.
"""
import argparse
import errno
import hashlib
import json
import os
import platform
import subprocess
import re
import sys
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path

MAX_PROCESSES = 256
MAX_BYTES = 1_048_576
MAX_WORK = 4096
MAX_OWNER_SNAPSHOT_BYTES = 1_048_576
MAX_OWNER_SNAPSHOTS = 20
MAX_OUTCOMES_BYTES = 1_048_576
MAX_SESSION_ID_BYTES = 128
MAX_CAPTURE_OUTPUT_BYTES = 64 * 1_048_576
MAX_CAPTURE_FILE_BYTES = 256 * 1_048_576
SCENARIOS = (1, 5, 10, 20)
REQUIRED_LINUX_METRICS = ("pss_bytes", "rss_bytes", "cpu_ns", "thread_count", "fd_count")
AGGREGATE_LINUX_METRICS = REQUIRED_LINUX_METRICS + ("private_bytes",)
PROC_ROOT = Path("/proc")


def append_capture_output(path, payload):
    """Append bounded JSONL under the checkout using no-follow directory handles."""
    root = Path(__file__).resolve().parents[2]
    requested = Path(path)
    if ".." in requested.parts:
        raise ValueError("RC0 output path cannot contain parent traversal")
    candidate = Path(os.path.abspath(requested if requested.is_absolute() else root / requested))
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("RC0 output must remain inside the repository") from exc
    parts = relative.parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError("RC0 output must name a repository-contained file")
    if not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY") or os.open not in os.supports_dir_fd:
        raise ValueError("safe descriptor-relative RC0 output is unavailable on this platform")
    root_flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    parent_fd = os.open(root, root_flags)
    parent_device = os.fstat(parent_fd).st_dev
    output_fd = -1
    try:
        for component in parts[:-1]:
            child_fd = os.open(component, root_flags, dir_fd=parent_fd)
            child_stat = os.fstat(child_fd)
            if not stat.S_ISDIR(child_stat.st_mode) or child_stat.st_dev != parent_device:
                os.close(child_fd)
                raise ValueError("RC0 output parent is not a repository-local directory")
            os.close(parent_fd)
            parent_fd = child_fd
        name = parts[-1]
        flags = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        try:
            output_fd = os.open(name, flags, dir_fd=parent_fd)
        except FileNotFoundError:
            output_fd = os.open(name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=parent_fd)
        info = os.fstat(output_fd)
        if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                or info.st_dev != parent_device or info.st_size + len(payload) > MAX_CAPTURE_FILE_BYTES):
            raise ValueError("RC0 output is not a bounded private repository file")
        try:
            import fcntl
        except ImportError as exc:
            raise ValueError("safe locked RC0 output is unavailable on this platform") from exc
        fcntl.flock(output_fd, fcntl.LOCK_EX)
        after_lock = os.fstat(output_fd)
        if (after_lock.st_dev, after_lock.st_ino) != (info.st_dev, info.st_ino):
            raise ValueError("RC0 output identity changed while acquiring its append lock")
        if after_lock.st_size:
            if not hasattr(os, "pread") or os.pread(output_fd, 1, after_lock.st_size - 1) != b"\n":
                raise ValueError("RC0 output has an incomplete trailing record; refusing to append")
        if after_lock.st_size + len(payload) > MAX_CAPTURE_FILE_BYTES:
            raise ValueError("RC0 output exceeds its repository artifact bound")
        view = memoryview(payload)
        while view:
            written = os.write(output_fd, view)
            if written <= 0:
                raise OSError(errno.EIO, "short RC0 output append")
            view = view[written:]
        os.fsync(output_fd)
    finally:
        if output_fd >= 0:
            os.close(output_fd)
        if parent_fd >= 0:
            os.close(parent_fd)

# --- Provenance gate -----------------------------------------------------------------
# A release-eligible RC0 baseline requires an attestation produced by a locally
# verifiable, owner-backed source (the Core/Rust session owner attesting live Session
# ownership and Run-attested task outcomes at an exact revision). No such source is
# integrated yet, so this allowlist is empty and no CLI flag or JSON payload can create
# a valid AttestationV1. Fill it only together with the owning implementation and its
# independent verification procedure -- never with an invented key or authority.
TRUSTED_ATTESTATION_SOURCES = ()
ATTESTATION_BLOCKED_REASON = (
    "no locally verifiable owner-backed attestation source is configured; live Horizon "
    "Session ownership and Run-attested task outcomes must come from the Core/Rust session "
    "owner before any baseline can be release-eligible"
)


@dataclass(frozen=True)
class AttestationV1:
    """Owner-backed attestation of live Session identities and Run-attested outcomes.

    Constructible only for sources listed in :data:`TRUSTED_ATTESTATION_SOURCES`. A
    caller-supplied dictionary or CLI value cannot pass this constructor, so fabricated
    inputs can never make a capture release-eligible.
    """

    source: str
    commit: str
    session_ids: tuple
    run_ids: tuple
    session_run_ids: tuple = ()
    host_run_receipt_refs: tuple = ()
    independent_verifier_evidence_refs: tuple = ()
    owner_log_event_digests: tuple = ()
    source_signature_digest: str = ""

    def __post_init__(self):
        if self.source not in TRUSTED_ATTESTATION_SOURCES:
            raise ValueError(
                "attestation source is not a configured trusted owner source"
            )
        if (not self.commit or not self.session_ids or not self.run_ids
                or len(self.session_ids) != len(set(self.session_ids))
                or len(self.run_ids) != len(set(self.run_ids))
                or len(self.session_run_ids) != len(self.session_ids)
                or len(self.host_run_receipt_refs) != len(self.session_ids)
                or len(self.independent_verifier_evidence_refs) != len(self.session_ids)
                or len(self.owner_log_event_digests) != len(self.session_ids)
                or not re.fullmatch(r"sha256:[0-9a-f]{64}", self.source_signature_digest)):
            raise ValueError("incomplete owner attestation")
        if (set(session for session, _run in self.session_run_ids) != set(self.session_ids)
                or set(run for _session, run in self.session_run_ids) != set(self.run_ids)
                or any(not isinstance(ref, str) or not ref or len(ref) > 256 for ref in (
                    *self.host_run_receipt_refs,
                    *self.independent_verifier_evidence_refs,
                ))
                or any(not re.fullmatch(r"blake3:[0-9a-f]{64}", digest)
                       for digest in self.owner_log_event_digests)):
            raise ValueError("owner attestation evidence does not cover exact Session/Run and OwnerLog state")


def attestation_covers(attestation, selected, commit):
    """True only for a typed owner attestation covering these sessions at this commit."""
    if not isinstance(attestation, AttestationV1):
        return False
    if attestation.commit != commit:
        return False
    expected = {session for session, _identity in selected}
    return (
        set(attestation.session_ids) == expected
        and {session for session, _run in attestation.session_run_ids} == expected
        and len(attestation.host_run_receipt_refs) == len(expected)
        and len(attestation.independent_verifier_evidence_refs) == len(expected)
        and len(attestation.owner_log_event_digests) == len(expected)
    )



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


def smaps_private_bytes(text):
    """Private resident bytes from smaps_rollup; None unless all three fields are present.

    Private_Clean + Private_Dirty + Private_Hugetlb is a separate labeled method from PSS/RSS;
    a missing field is unknown, never an under-counted partial sum."""
    values = {}
    for line in text.splitlines():
        for field in ("Private_Clean:", "Private_Dirty:", "Private_Hugetlb:"):
            if line.startswith(field):
                try:
                    values[field] = int(line.split()[1])
                except (IndexError, ValueError):
                    return None
    if len(values) != 3:
        return None
    return (values["Private_Clean:"] + values["Private_Dirty:"] + values["Private_Hugetlb:"]) * 1024


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
        private = smaps_private_bytes(text)
        counters["private_bytes"] = private
        if private is None:
            reasons["private_bytes"] = "missing_private_fields"
    except PermissionError:
        counters["pss_bytes"] = None
        counters["private_bytes"] = None
        reasons["pss_bytes"] = "permission_denied"
        reasons["private_bytes"] = "permission_denied"
    except (OSError, ValueError, IndexError):
        counters["pss_bytes"] = None
        counters["private_bytes"] = None
        reasons["pss_bytes"] = "unavailable_or_malformed_or_budget_exceeded"
        reasons["private_bytes"] = "unavailable_or_malformed_or_budget_exceeded"
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


def sample_identity(pid, expected_start, budget, expected_ancestors=()):
    before, parent = proc_identity(pid, budget)
    if before != expected_start:
        return {"pid": pid, "start_identity": str(expected_start), "quality": "UNKNOWN",
                "identity_valid": False, "reason": "identity_mismatch", "metrics": {}}
    expected_parent = expected_ancestors[-1] if expected_ancestors else None
    if expected_parent is not None and parent != expected_parent[0]:
        return {"pid": pid, "start_identity": str(expected_start), "parent_pid": parent,
                "quality": "UNKNOWN", "identity_valid": False,
                "reason": "parent_identity_mismatch", "metrics": {}}
    if not ancestors_match(expected_ancestors, budget):
        return {"pid": pid, "start_identity": str(expected_start), "parent_pid": parent,
                "quality": "UNKNOWN", "identity_valid": False,
                "reason": "parent_identity_mismatch" if len(expected_ancestors) == 1
                else "ancestor_identity_mismatch", "metrics": {}}
    counters, reasons = linux_counters(pid, budget)
    after, parent_after = proc_identity(pid, budget)
    if after != expected_start:
        return {"pid": pid, "start_identity": str(expected_start), "quality": "UNKNOWN",
                "identity_valid": False, "reason": "identity_changed_during_sample", "metrics": {}}
    if expected_parent is not None and parent_after != expected_parent[0]:
        return {"pid": pid, "start_identity": str(expected_start), "parent_pid": parent_after,
                "quality": "UNKNOWN", "identity_valid": False,
                "reason": "parent_identity_changed_during_sample", "metrics": {}}
    if not ancestors_match(expected_ancestors, budget):
        return {"pid": pid, "start_identity": str(expected_start), "parent_pid": parent_after,
                "quality": "UNKNOWN", "identity_valid": False,
                "reason": "parent_identity_changed_during_sample" if len(expected_ancestors) == 1
                else "ancestor_identity_changed_during_sample", "metrics": {}}
    complete = all(counters.get(metric) is not None for metric in REQUIRED_LINUX_METRICS)
    return {"pid": pid, "start_identity": str(expected_start), "parent_pid": parent,
            "identity_valid": True, "quality": "MEASURED" if complete else "UNKNOWN",
            "metrics": counters, "unknown_reasons": reasons}


def ancestors_match(expected_ancestors, budget):
    """Revalidate every owner-to-parent edge around sampling a queued descendant."""
    previous_pid = None
    for ancestor_pid, expected_start in expected_ancestors:
        actual_start, actual_parent = proc_identity(ancestor_pid, budget)
        if actual_start != expected_start:
            return False
        if previous_pid is not None and actual_parent != previous_pid:
            return False
        previous_pid = ancestor_pid
    return True

def sample_tree(root_pid, root_start):
    system = platform.system()
    if system != "Linux":
        result = {"processes": [], "quality": "UNKNOWN", "truncated": True,
                  "reason": f"native {system or 'unknown-platform'} sampler is unavailable to this harness"}
        result["process_tree_totals"] = aggregate_process_tree(result)
        return result
    budget = Budget()
    queue = [(root_pid, root_start, ())]
    seen = {}
    output = []
    truncated = False
    try:
        while queue:
            pid, start, expected_ancestors = queue.pop(0)
            identity = (pid, start)
            if identity in seen:
                if seen[identity] != expected_ancestors:
                    raise ValueError("process identity observed under multiple parents")
                continue
            seen[identity] = expected_ancestors
            budget.charge_work()
            if len(output) >= MAX_PROCESSES:
                truncated = True
                break
            sample = sample_identity(pid, start, budget, expected_ancestors)
            output.append(sample)
            if sample.get("identity_valid"):
                child_ancestors = expected_ancestors + (identity,)
                queue.extend((child_pid, child_start, child_ancestors)
                             for child_pid, child_start in children(pid, start, budget))
    except (PermissionError, OSError, ValueError, IndexError):
        truncated = True
    complete = (not truncated and bool(output)
                and all(item.get("identity_valid") and item.get("quality") == "MEASURED" for item in output))
    result = {"processes": output, "quality": "MEASURED" if complete else "UNKNOWN",
              "truncated": truncated, "source_bytes": budget.bytes, "work_items": budget.work,
              "reason": None if complete else "partial_or_unknown_sample"}
    result["process_tree_totals"] = aggregate_process_tree(result)
    return result


def aggregate_process_tree(sample):
    """Sum a complete owned tree; incomplete observations stay UNKNOWN, never partial zeroes."""
    metrics = {name: None for name in AGGREGATE_LINUX_METRICS}
    processes = sample.get("processes", [])
    if (sample.get("quality") != "MEASURED" or sample.get("truncated") or not processes
            or any(not process.get("identity_valid") or process.get("quality") != "MEASURED"
                   for process in processes)):
        return {"quality": "UNKNOWN", "metrics": metrics}

    for metric in AGGREGATE_LINUX_METRICS:
        values = [process.get("metrics", {}).get(metric) for process in processes]
        if any(isinstance(value, bool) or not isinstance(value, int) or value < 0 for value in values):
            continue
        if metric in REQUIRED_LINUX_METRICS:
            metrics[metric] = sum(values)
        else:
            # Private bytes are useful where available but are not substituted for PSS/RSS.
            metrics[metric] = sum(values)

    complete = all(metrics.get(metric) is not None for metric in REQUIRED_LINUX_METRICS)
    if not complete:
        return {"quality": "UNKNOWN", "metrics": {name: None for name in AGGREGATE_LINUX_METRICS}}
    return {"quality": "MEASURED", "metrics": metrics}


def aggregate_process_trees(samples):
    """Aggregate disjoint owned trees; overlapping PID generations become UNKNOWN."""
    processes = []
    identities = set()
    for sample in samples:
        if not valid_complete_sample(sample):
            return {"quality": "UNKNOWN", "metrics": {name: None for name in AGGREGATE_LINUX_METRICS}}
        for process in sample["processes"]:
            identity = identity_key(process)
            if identity is None or identity in identities:
                return {"quality": "UNKNOWN", "metrics": {name: None for name in AGGREGATE_LINUX_METRICS}}
            identities.add(identity)
            processes.append(process)
    if not processes:
        return {"quality": "UNKNOWN", "metrics": {name: None for name in AGGREGATE_LINUX_METRICS}}
    return aggregate_process_tree({"quality": "MEASURED", "truncated": False, "processes": processes})


def baseline_eligible(selected, session_results, outcomes, commit, clean_tree, provider_model, build, harness,
                      local_inference, local_inference_sample=None, machine_metadata=None, attestation=None):
    """Shape/consistency check **plus** the mandatory provenance gate.

    Without a typed owner :class:`AttestationV1` covering exactly these sessions at this
    commit the result is always False, so fabricated but well-shaped caller inputs can
    never be reported as a release-eligible baseline.
    """
    if not attestation_covers(attestation, selected, commit):
        return False
    if len(selected) != len(session_results) or not selected:
        return False
    if {session for session, _identity in selected} != {item.get("session_id") for item in session_results}:
        return False
    if not commit or not clean_tree or not provider_model.strip() or provider_model.lower() in ("unknown", "not-recorded"):
        return False
    if not build.strip() or not harness.strip() or local_inference not in ("included", "excluded"):
        return False
    if machine_metadata is not None and not (
        machine_metadata.get("processor")
        and isinstance(machine_metadata.get("logical_cpu_count"), int)
        and machine_metadata["logical_cpu_count"] > 0
        and isinstance(machine_metadata.get("memory_bytes"), int)
        and machine_metadata["memory_bytes"] > 0
    ):
        return False
    if local_inference == "included":
        if not local_inference_sample or not valid_complete_sample(local_inference_sample.get("sample", {})):
            return False
        inference_owner = identity_key(local_inference_sample.get("owner_identity", {}))
        inference_processes = local_inference_sample["sample"].get("processes", [])
        if inference_owner is None or inference_owner not in {
            identity_key(process) for process in inference_processes
        }:
            return False
        inference_totals = local_inference_sample["sample"].get("process_tree_totals", {})
        if inference_totals.get("quality") != "MEASURED" or any(
            not isinstance(inference_totals.get("metrics", {}).get(metric), int)
            or isinstance(inference_totals.get("metrics", {}).get(metric), bool)
            or inference_totals.get("metrics", {}).get(metric) < 0
            for metric in REQUIRED_LINUX_METRICS
        ):
            return False
    elif local_inference_sample is not None:
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
    selected_identities = [(pid, str(start)) for _session, (pid, start) in selected]
    if len(selected_identities) != len(set(selected_identities)):
        return False
    observed_processes = set()
    for item in session_results:
        session = item.get("session_id")
        if session not in selected_by_session:
            return False
        owner = item.get("owner_identity", {})
        expected_pid, expected_start = selected_by_session[session]
        if identity_key(owner) != (expected_pid, str(expected_start)):
            return False
        sample = item.get("sample", {})
        if not valid_complete_sample(sample):
            return False
        totals = sample.get("process_tree_totals", {})
        if totals.get("quality") != "MEASURED" or any(
            not isinstance(totals.get("metrics", {}).get(metric), int)
            or isinstance(totals.get("metrics", {}).get(metric), bool)
            or totals.get("metrics", {}).get(metric) < 0
            for metric in REQUIRED_LINUX_METRICS
        ):
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
            identity = identity_key(process)
            if identity is None:
                return False
            if identity in observed_processes:
                return False
            observed_processes.add(identity)
    if local_inference_sample is not None:
        inference_processes = local_inference_sample["sample"].get("processes", [])
        for process in inference_processes:
            identity = identity_key(process)
            if identity is None:
                return False
            if identity in observed_processes:
                return False
            observed_processes.add(identity)
    return True


def identity_key(record):
    pid = record.get("pid")
    start = record.get("start_identity")
    if isinstance(pid, bool) or not isinstance(pid, int) or pid <= 0:
        return None
    try:
        start = int(start)
    except (TypeError, ValueError):
        return None
    if start <= 0:
        return None
    return pid, str(start)


def valid_complete_sample(sample):
    if sample.get("quality") != "MEASURED" or sample.get("truncated"):
        return False
    processes = sample.get("processes", [])
    if not processes:
        return False
    return all(
        process.get("identity_valid")
        and process.get("quality") == "MEASURED"
        and identity_key(process) is not None
        and all(
            isinstance(process.get("metrics", {}).get(metric), int)
            and not isinstance(process.get("metrics", {}).get(metric), bool)
            and process.get("metrics", {}).get(metric) >= 0
            for metric in REQUIRED_LINUX_METRICS
        )
        for process in processes
    )


def identity_arg(value):
    try:
        session, encoded = value.split("=", 1)
        pid, start = encoded.split(":", 1)
        result = (session, int(pid), int(start))
        if (not session or len(session.encode("utf-8")) > MAX_SESSION_ID_BYTES
                or result[1] <= 0 or result[2] <= 0):
            raise ValueError
        return result
    except ValueError as error:
        raise argparse.ArgumentTypeError(
            f"expected SESSION=PID:START_IDENTITY with a Session ID no longer than {MAX_SESSION_ID_BYTES} UTF-8 bytes"
        ) from error


def _reject_duplicate_json_properties(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError(f"duplicate JSON property: {key}")
        result[key] = value
    return result


def load_outcomes(path):
    """Load a small bounded caller-input outcome map; it never establishes attestation."""
    data = read_repository_input(path, MAX_OUTCOMES_BYTES, "outcomes")
    if len(data) > MAX_OUTCOMES_BYTES:
        raise ValueError("outcomes file exceeds the 1 MiB input bound")
    try:
        value = json.loads(data.decode("utf-8", errors="strict"),
                           object_pairs_hook=_reject_duplicate_json_properties)
    except RecursionError as error:
        raise ValueError("outcomes JSON nesting exceeds parser bounds") from error
    if not isinstance(value, dict):
        raise ValueError("outcomes must contain a JSON object mapping Session IDs to outcomes")
    if len(value) > 20:
        raise ValueError("outcomes contain more than 20 Session IDs")
    for session in value:
        if (not isinstance(session, str) or not session
                or len(session.encode("utf-8")) > MAX_SESSION_ID_BYTES):
            raise ValueError("outcome Session ID is invalid or exceeds the 128-byte bound")
    return value


def _validate_owner_metric(item, label):
    if not isinstance(item, dict) or item.get("quality") not in ("UNKNOWN", "MEASURED"):
        raise ValueError(f"{label} metric shape is invalid")
    quality, value = item["quality"], item.get("value")
    if quality == "UNKNOWN":
        # Rust's canonical projection carries a bounded enum reason for UNKNOWN
        # metrics and omits value. Never coerce UNKNOWN to zero.
        if (set(item) != {"quality", "reason"} or not isinstance(item.get("reason"), str)
                or item["reason"] not in {
                    "UNSUPPORTED", "PERMISSION_DENIED", "EXITED", "IDENTITY_CHANGED",
                    "UNAVAILABLE", "MALFORMED", "BUDGET_EXCEEDED", "ATTRIBUTION_CONFLICT",
                }):
            raise ValueError(f"{label} UNKNOWN metric must carry a canonical reason and no value")
        return
    if set(item) != {"quality", "value"} or not is_canonical_decimal(value):
        raise ValueError(f"{label} MEASURED metric must carry a canonical nonnegative decimal")


def is_canonical_decimal(value, *, positive=False):
    """Accept only ASCII canonical base-10 strings; Python's isdigit accepts Unicode."""
    if not isinstance(value, str) or re.fullmatch(r"(?:0|[1-9][0-9]*)", value) is None:
        return False
    return not positive or int(value) > 0


def load_owner_snapshot(path):
    """Read the bounded P8 Rust owner sample envelope without elevating trust.

    This is an ingestion contract only. Files are caller-controlled, and the
    envelope intentionally cannot satisfy :func:`attestation_covers`; P1 must
    attest the live Session process and P2 must supply independent final-Run
    verifier evidence before a release baseline can be admitted.
    """
    data = read_repository_input(path, MAX_OWNER_SNAPSHOT_BYTES, "owner snapshot")
    if len(data) > MAX_OWNER_SNAPSHOT_BYTES:
        raise ValueError("owner snapshot exceeds the 1 MiB ingestion bound")
    def unique_object(pairs):
        result = {}
        for key, item in pairs:
            if key in result:
                raise ValueError(f"duplicate JSON property: {key}")
            result[key] = item
        return result

    try:
        value = json.loads(
            data.decode("utf-8"),
            object_pairs_hook=unique_object,
            parse_constant=lambda constant: (_ for _ in ()).throw(
                ValueError(f"invalid JSON constant: {constant}")
            ),
        )
    except RecursionError as error:
        raise ValueError("owner snapshot JSON nesting exceeds parser bounds") from error
    if (not isinstance(value, dict) or type(value.get("schemaVersion")) is not int
            or value.get("schemaVersion") not in (1, 2, 3)):
        raise ValueError("owner snapshot schemaVersion must be 1, 2, or 3")
    schema_version = value["schemaVersion"]
    if value.get("producer") != "horizoncode.worker-owner.resource-sampler":
        raise ValueError("owner snapshot producer is not the P8 sampler schema")
    owner = value.get("owner")
    log = value.get("ownerLog")
    workers = value.get("workers")
    if not isinstance(owner, dict) or not isinstance(log, dict) or not isinstance(workers, list):
        raise ValueError("owner snapshot is missing owner, ownerLog, or workers")
    owner_keys = ("principalRef", "workspaceBinding", "sessionId", "runId")
    if schema_version == 2:
        owner_keys += ("taskId", "attemptId")
    if schema_version == 3:
        owner_keys += ("taskId", "attemptId")
    for key in owner_keys:
        if not isinstance(owner.get(key), str) or not owner[key] or len(owner[key]) > 256:
            raise ValueError(f"owner snapshot owner.{key} is invalid")
    if schema_version == 1:
        for key in ("taskId", "attemptId"):
            if key in owner and (not isinstance(owner[key], str) or not owner[key] or len(owner[key]) > 256):
                raise ValueError(f"owner snapshot owner.{key} is invalid")
    for key in ("ownerEpoch",):
        if not is_canonical_decimal(owner.get(key), positive=True):
            raise ValueError(f"owner snapshot owner.{key} must be a positive decimal string")
    if (not isinstance(log.get("ownerId"), str) or not log["ownerId"]
            or not is_canonical_decimal(log.get("sequence"))
            or not isinstance(log.get("eventDigest"), str)
            or not re.fullmatch(r"blake3:[0-9a-f]{64}", log["eventDigest"])
            or not is_canonical_decimal(log.get("workerPoolRevision"), positive=True)):
        raise ValueError("owner snapshot OwnerLog watermark is invalid")
    sample_sequence = value.get("sampleSequence")
    if not is_canonical_decimal(sample_sequence, positive=True):
        raise ValueError("owner snapshot sample sequence is invalid")
    if not is_canonical_decimal(value.get("sampledAtMs")):
        raise ValueError("owner snapshot sampledAtMs is invalid")
    if len(workers) > MAX_PROCESSES:
        raise ValueError("owner snapshot worker count exceeds the process bound")
    process_identity_records = []
    seen_worker_ids = set()
    seen_attempt_ids = set()
    seen_worker_processes = set()
    worker_records = []
    total_processes = 0
    for worker in workers:
        if not isinstance(worker, dict) or worker.get("reservationState") not in (
            "CLAIMED", "RELEASE_PENDING", "QUARANTINED"
        ):
            raise ValueError("owner snapshot worker is invalid or not capacity-holding")
        if (not isinstance(worker.get("workerExecutionId"), str)
                or not worker["workerExecutionId"] or len(worker["workerExecutionId"]) > 256
                or not isinstance(worker.get("taskId"), str)
                or not worker["taskId"] or len(worker["taskId"]) > 256
                or not isinstance(worker.get("attemptId"), str)
                or not worker["attemptId"] or len(worker["attemptId"]) > 256
                or worker.get("quality") not in ("MEASURED", "UNKNOWN")
                or not isinstance(worker.get("processes"), list)):
            raise ValueError("owner snapshot worker fields are invalid")
        worker_id = worker["workerExecutionId"]
        attempt_identity = (worker["taskId"], worker["attemptId"])
        if worker_id in seen_worker_ids:
            raise ValueError("owner snapshot contains a duplicate workerExecutionId")
        if attempt_identity in seen_attempt_ids:
            raise ValueError("owner snapshot contains a duplicate Task/Attempt identity")
        seen_worker_ids.add(worker_id)
        seen_attempt_ids.add(attempt_identity)
        if schema_version == 3 and (
                not isinstance(worker.get("sourceRevision"), str)
                or not re.fullmatch(r"blake3:[0-9a-f]{64}", worker["sourceRevision"])):
            raise ValueError("owner snapshot worker source revision is invalid")
        metrics = worker.get("metrics")
        if not isinstance(metrics, dict):
            raise ValueError("owner snapshot worker metrics are missing")
        for metric in ("pssBytes", "rssBytes", "cpuNs", "threadCount", "fdCount", "privateBytes"):
            _validate_owner_metric(metrics.get(metric), f"worker.metrics.{metric}")
        worker_records.append({
            "worker_execution_id": worker["workerExecutionId"],
            "task_id": worker["taskId"],
            "attempt_id": worker["attemptId"],
            "source_revision": worker.get("sourceRevision"),
            "reservation_state": worker["reservationState"],
            "quality": worker["quality"],
            "metrics": metrics,
        })
        if len(worker["processes"]) > MAX_PROCESSES:
            raise ValueError("owner snapshot process count exceeds the bound")
        for process in worker["processes"]:
            total_processes += 1
            if total_processes > MAX_PROCESSES:
                raise ValueError("owner snapshot total process count exceeds the bound")
            if not isinstance(process, dict):
                raise ValueError("owner snapshot process entry is invalid")
            pid, start = process.get("pid"), process.get("startIdentity")
            if (type(pid) is not int or pid <= 0
                    or not is_canonical_decimal(start, positive=True)):
                raise ValueError("owner snapshot process identity is invalid")
            process_identity = (pid, start)
            if process_identity in seen_worker_processes:
                raise ValueError("owner snapshot contains overlapping worker process identities")
            seen_worker_processes.add(process_identity)
            process_identity_records.append({"pid": pid, "start_identity": start})
    if not isinstance(value.get("aggregate"), dict):
        raise ValueError("owner snapshot aggregate metrics are missing")
    session_process_owner = value.get("sessionProcessOwner")
    if not isinstance(session_process_owner, dict):
        raise ValueError("owner snapshot must explicitly report the Core Session process owner")
    session_owner_status = session_process_owner.get("status")
    if session_owner_status == "NOT_PROVIDED":
        if session_process_owner.get("processIdentity") is not None or session_process_owner.get("metrics") is not None:
            raise ValueError("unprovided Core process owner must not carry identity or metrics")
        session_process_identity = None
        session_process_metrics = None
    elif session_owner_status == "MEASURED":
        process = session_process_owner.get("processIdentity")
        metrics = session_process_owner.get("metrics")
        if not isinstance(process, dict) or not isinstance(metrics, dict):
            raise ValueError("measured Core process owner must include identity and metrics")
        pid, start = process.get("pid"), process.get("startIdentity")
        if (type(pid) is not int or pid <= 0
                or not is_canonical_decimal(start, positive=True)
                or not isinstance(process.get("ownerEpoch"), str)
                or not is_canonical_decimal(process["ownerEpoch"], positive=True)
                or int(process["ownerEpoch"]) != int(owner["ownerEpoch"])
                or not isinstance(process.get("processIncarnation"), str)
                or not process["processIncarnation"] or len(process["processIncarnation"]) > 128
                or not isinstance(process.get("executableIdentityDigest"), str)
                or not re.fullmatch(r"blake3:[0-9a-f]{64}", process["executableIdentityDigest"])):
            raise ValueError("measured Core process owner identity is invalid")
        for metric in ("pssBytes", "rssBytes", "cpuNs", "threadCount", "fdCount", "privateBytes"):
            _validate_owner_metric(metrics.get(metric), f"sessionProcessOwner.metrics.{metric}")
        session_process_identity = {
            "pid": pid,
            "start_identity": start,
            "owner_epoch": process["ownerEpoch"],
            "process_incarnation": process["processIncarnation"],
            "executable_identity_digest": process["executableIdentityDigest"],
        }
        session_process_metrics = metrics
    else:
        raise ValueError("owner snapshot Core process owner status is invalid")
    if session_process_identity is not None and total_processes + 1 > MAX_PROCESSES:
        raise ValueError("owner snapshot including Core process exceeds the total process bound")
    for metric in ("pssBytes", "rssBytes", "cpuNs", "threadCount", "fdCount", "privateBytes"):
        item = value["aggregate"].get(metric)
        _validate_owner_metric(item, f"owner snapshot aggregate.{metric}")
    resource_limits = value.get("resourceLimits")
    if schema_version == 2 and resource_limits is not None:
        required_limits = {"cpuTime", "memory", "processCount", "fileDescriptors"}
        if not isinstance(resource_limits, list) or len(resource_limits) != len(required_limits):
            raise ValueError("owner snapshot resourceLimits must report all four dimensions")
        by_dimension = {}
        for row in resource_limits:
            if not isinstance(row, dict):
                raise ValueError("owner snapshot resource limit row is invalid")
            dimension = row.get("dimension")
            status = row.get("status")
            enforced = row.get("enforced")
            if dimension not in required_limits or dimension in by_dimension:
                raise ValueError("owner snapshot resource limit dimension is missing or duplicated")
            if type(enforced) is not bool or status not in ("ENFORCED", "MONITORING_ONLY", "UNSUPPORTED"):
                raise ValueError("owner snapshot resource limit status is invalid")
            if status == "ENFORCED":
                if set(row) != {"dimension", "status", "enforced", "limit", "reason"}:
                    raise ValueError("enforced resource limit fields are not canonical")
                if enforced is not True or not is_canonical_decimal(row.get("limit"), positive=True) or row.get("reason") is not None:
                    raise ValueError("enforced resource limit lacks a positive verified limit")
            elif status == "MONITORING_ONLY":
                if set(row) != {"dimension", "status", "enforced", "observed", "reason"}:
                    raise ValueError("monitoring-only resource limit fields are not canonical")
                if enforced is not False or row.get("limit") is not None or row.get("reason") is not None:
                    raise ValueError("monitoring-only resource limit claims enforcement")
                observed = row.get("observed")
                if observed is not None and not is_canonical_decimal(observed):
                    raise ValueError("monitoring-only observation must be a canonical decimal or null")
            else:
                if set(row) != {"dimension", "status", "enforced", "reason"}:
                    raise ValueError("unsupported resource limit fields are not canonical")
                if enforced is not False or not isinstance(row.get("reason"), str) or not row["reason"]:
                    raise ValueError("unsupported resource limit must include a reason and no limit")
            by_dimension[dimension] = row
        if set(by_dimension) != required_limits:
            raise ValueError("owner snapshot resource limit dimensions are incomplete")
    elif resource_limits is not None and not isinstance(resource_limits, list):
        raise ValueError("legacy owner snapshot resourceLimits must be a list when present")
    attestation = value.get("productAttestation")
    required_attestation = [
        "hostRunReceiptRef", "independentVerifierEvidenceRef", "sourceCommit",
    ]
    if (not isinstance(attestation, dict)
            or set(attestation) != {
                "status", "hostRunReceiptRef", "independentVerifierEvidenceRef",
                "sourceCommit", "required",
            }
            or attestation.get("status") != "NOT_ATTESTED"
            or attestation.get("hostRunReceiptRef") is not None
            or attestation.get("independentVerifierEvidenceRef") is not None
            or attestation.get("sourceCommit") is not None
            or attestation.get("required") != required_attestation):
        raise ValueError("owner snapshot must accurately state NOT_ATTESTED")
    return {
        "session_id": owner["sessionId"],
        "run_id": owner["runId"],
        "task_id": owner.get("taskId"),
        "attempt_id": owner.get("attemptId"),
        "owner_log_id": log["ownerId"],
        "owner_log_sequence": log["sequence"],
        "owner_log_event_digest": log["eventDigest"],
        "sample_sequence": sample_sequence,
        "snapshot_digest": "sha256:" + hashlib.sha256(data).hexdigest(),
        "worker_count": len(workers),
        "workers": worker_records,
        "process_identities": process_identity_records,
        "aggregate": value["aggregate"],
        "resource_limits": resource_limits,
        # Like every field in a JSON snapshot file, these rows are caller input
        # until the HostRun/OwnerLog attestation chain is independently checked.
        "resource_limits_provenance": (
            "UNVERIFIED_CALLER_SUPPLIED" if resource_limits is not None
            else "UNAVAILABLE_LEGACY_SNAPSHOT"
        ),
        "product_attestation": "NOT_ATTESTED",
        "session_process_owner": session_process_identity,
        "session_process_metrics": session_process_metrics,
    }


def read_repository_input(path, limit, label):
    """Read one bounded regular input through repository-relative no-follow handles.

    RC0 inputs are local fixtures/evidence envelopes. A caller-supplied path may
    never make this harness read outside the checkout or follow a symlink out of
    it. This remains an input-integrity boundary only; the bytes do not attest
    Session ownership, Run completion, or release eligibility.
    """
    root = Path(__file__).resolve().parents[2]
    requested = Path(path)
    if ".." in requested.parts:
        raise ValueError(f"{label} path cannot contain parent traversal")
    candidate = Path(os.path.abspath(requested if requested.is_absolute() else root / requested))
    try:
        relative = candidate.relative_to(root)
    except ValueError as error:
        raise ValueError(f"{label} input must remain inside the repository") from error
    parts = relative.parts
    if not parts or any(part in ("", ".", "..") for part in parts):
        raise ValueError(f"{label} path must name a repository-contained file")
    if (not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY")
            or os.open not in os.supports_dir_fd):
        raise ValueError(f"safe repository-local {label} reads are unavailable on this platform")

    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        parent_fd = os.open(root, flags)
    except OSError as error:
        raise ValueError(f"repository root cannot be opened safely for {label}") from error
    root_device = os.fstat(parent_fd).st_dev
    file_fd = -1
    try:
        for component in parts[:-1]:
            try:
                child_fd = os.open(component, flags, dir_fd=parent_fd)
            except OSError as error:
                raise ValueError(f"{label} directory traversal failed safely") from error
            child_stat = os.fstat(child_fd)
            if not stat.S_ISDIR(child_stat.st_mode) or child_stat.st_dev != root_device:
                os.close(child_fd)
                raise ValueError(f"{label} directory is not repository-local")
            os.close(parent_fd)
            parent_fd = child_fd

        # O_NONBLOCK prevents a malicious repository-local FIFO from hanging
        # the preflight process before fstat can reject its file type.
        file_flags = (os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
                      | getattr(os, "O_NONBLOCK", 0))
        try:
            file_fd = os.open(parts[-1], file_flags, dir_fd=parent_fd)
        except OSError as error:
            raise ValueError(f"{label} file cannot be opened without following links") from error
        before = os.fstat(file_fd)
        if before.st_size > limit:
            raise ValueError(f"{label} file exceeds the 1 MiB input bound")
        if (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1
                or before.st_dev != root_device):
            raise ValueError(f"{label} is not a bounded repository-local regular file")
        chunks = []
        remaining = limit + 1
        while remaining:
            chunk = os.read(file_fd, min(65_536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        data = b"".join(chunks)
        after = os.fstat(file_fd)
        if ((before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
                or after.st_size != len(data) or len(data) > limit):
            raise ValueError(f"{label} changed or exceeded its byte limit while being read")
        return data
    finally:
        if file_fd >= 0:
            os.close(file_fd)
        os.close(parent_fd)


def aggregate_owner_samples(samples):
    """Sum worker trees and count each reported shared Core process once.

    The Rust owner-snapshot `aggregate` includes both worker trees and the Core
    process. Summing that aggregate per Session would count a shared Core
    process repeatedly, then adding its deduplicated sample below would count
    it once more. Build the worker total exclusively from the per-worker rows;
    the Core total is built from its separately reported identity. Metric
    quality does not establish product ownership or attestation because these
    snapshots are caller-supplied JSON.
    """
    totals = {}
    for name in ("pssBytes", "rssBytes", "cpuNs", "threadCount", "fdCount", "privateBytes"):
        values = []
        complete = bool(samples)
        for sample in samples:
            for worker in sample.get("workers", ()):
                metric = worker.get("metrics", {}).get(name, {})
                if metric.get("quality") != "MEASURED" or not is_canonical_decimal(metric.get("value")):
                    complete = False
                    break
                values.append(int(metric["value"]))
            if not complete:
                break
        totals[name] = ({"quality": "MEASURED", "value": str(sum(values))}
                        if complete else {"quality": "UNKNOWN", "value": None})
    identities = set()
    overlap = False
    for sample in samples:
        for process in sample["process_identities"]:
            key = (process["pid"], process["start_identity"])
            if key in identities:
                overlap = True
            identities.add(key)
    core_by_identity = {}
    core_overlap = False
    core_conflict = False
    for sample in samples:
        process = sample.get("session_process_owner")
        metrics = sample.get("session_process_metrics")
        if process is None:
            continue
        key = (process["pid"], process["start_identity"])
        prior = core_by_identity.get(key)
        sample_sequence = int(sample.get("sample_sequence", 0))
        if prior is None:
            core_by_identity[key] = (process, metrics, sample_sequence)
        else:
            # The same reported Core PID/start generation is shared by
            # Session snapshots. Keep its latest sampler sequence;
            # never add it once per Session or let an older good sample hide a
            # newer UNKNOWN sample.
            if prior[0] != process:
                core_conflict = True
            elif sample_sequence > prior[2]:
                core_by_identity[key] = (process, metrics, sample_sequence)
            elif sample_sequence == prior[2] and metrics != prior[1]:
                core_conflict = True
        if key in identities:
            core_overlap = True
    core_totals = {}
    for name in ("pssBytes", "rssBytes", "cpuNs", "threadCount", "fdCount", "privateBytes"):
        values = []
        for _process, metrics, _sequence in core_by_identity.values():
            metric = (metrics or {}).get(name, {})
            if metric.get("quality") != "MEASURED" or not is_canonical_decimal(metric.get("value")):
                values = []
                break
            values.append(int(metric["value"]))
        core_totals[name] = (
            {"quality": "MEASURED", "value": str(sum(values))}
            if values and not core_conflict else {"quality": "UNKNOWN", "value": None}
        )
    if overlap:
        totals = {name: {"quality": "UNKNOWN", "value": None} for name in totals}
    combined = {}
    for name in totals:
        worker_metric = totals[name]
        core_metric = core_totals[name]
        if (worker_metric["quality"] == "MEASURED"
                and core_metric["quality"] == "MEASURED" and not core_overlap):
            combined[name] = {
                "quality": "MEASURED",
                "value": str(int(worker_metric["value"]) + int(core_metric["value"])),
            }
        else:
            combined[name] = {"quality": "UNKNOWN", "value": None}
    return {
        "quality": "UNKNOWN" if overlap or core_overlap or core_conflict or not samples or any(
            metric["quality"] != "MEASURED" for metric in combined.values()
        ) else "MEASURED",
        # Metric quality describes bounded raw observations only. This aggregate
        # is never product attribution or acceptance evidence without a trusted
        # HostRun and independent-verifier attestation.
        "source_provenance": "UNVERIFIED_CALLER_SUPPLIED",
        "attestation": "NOT_ATTESTED",
        "product_attribution": "UNAVAILABLE",
        "overlapping_process_identity": overlap,
        "core_process_overlap": core_overlap,
        "core_process_identity_conflict": core_conflict,
        "session_count": len(samples),
        "worker_count": sum(sample["worker_count"] for sample in samples),
        "worker_process_count": len(identities),
        "core_process_count": len(core_by_identity),
        "process_count": len(identities.union(core_by_identity)),
        "core_process_sample_count": sum(sample.get("session_process_owner") is not None for sample in samples),
        "metrics": totals,
        "session_process_owner_metrics": core_totals,
        "combined_metrics": combined,
    }


def capture_command_template(selected, args, outcomes_path):
    """The exact capture invocation for the supplied identities; no inference is run here."""
    identities = " ".join(
        f"--identity {session}={pid}:{start}" for session, (pid, start) in sorted(selected.items())
    )
    parts = [
        "python3 scripts/perf/rc0.py",
        f"--scenario {json.dumps(args.scenario)}",
        f"--build {json.dumps(args.build)}",
        f"--warm-cold {args.warm_cold}",
        f"--provider-model {json.dumps(args.provider_model)}",
        f"--harness {json.dumps(args.harness)}",
        f"--local-inference {args.local_inference}",
        identities,
    ]
    if args.local_inference_identity:
        model, pid, start = args.local_inference_identity
        parts.append(f"--local-inference-identity {model}={pid}:{start}")
    if outcomes_path:
        parts.append(f"--outcomes {outcomes_path}")
    for snapshot in args.owner_snapshot:
        parts.append(f"--owner-snapshot {snapshot}")
    if args.output:
        parts.append(f"--output {args.output}")
    return " ".join(part for part in parts if part)


def preflight(selected, outcomes, args, commit, clean_tree, machine, min_sessions):
    """Validates the *shape and liveness* of the capture inputs; never verifies provenance.

    Returns (inputs_present, record). The record is a plain JSON object so a caller can keep
    the readiness decision as raw evidence rather than prose. Every value here is
    caller-supplied and UNVERIFIED: a complete result means only that the inputs are
    well-shaped, and ``release_eligible`` stays False until a configured owner-backed
    attestation covers these sessions at this commit."""
    missing = []
    sessions = []
    linux_proc_supported = platform.system() == "Linux"
    if not linux_proc_supported:
        missing.append(
            "UNSUPPORTED_PLATFORM: RC0 preflight liveness checks require Linux /proc; "
            "native Windows/macOS capture is unavailable (WSL is Linux evidence, not native Windows evidence)"
        )
    if not isinstance(min_sessions, int) or isinstance(min_sessions, bool) or not 1 <= min_sessions <= 20:
        missing.append("--min-sessions must be between 1 and 20")
    if len(selected) > 20:
        missing.append("at most 20 Session identities are supported for the 1/5/10/20 matrix")
    if len(selected) < min_sessions:
        missing.append(
            f"caller-supplied live session identities: {len(selected)} supplied, "
            f"{min_sessions} required for the 1/5/10/20 capture"
        )
    identities = [(pid, str(start)) for _session, (pid, start) in selected.items()]
    if len(identities) != len(set(identities)):
        missing.append("duplicate owner process identity across sessions")
    for session, (pid, start) in sorted(selected.items()):
        entry = {"session_id": session, "pid": pid, "identity_alive": False,
                 "identity_matches": False, "task_outcome": None}
        if linux_proc_supported:
            try:
                observed_start, _parent = proc_identity(pid, Budget())
                entry["identity_alive"] = True
                entry["identity_matches"] = int(observed_start) == int(start)
            except (OSError, ValueError):
                entry["identity_alive"] = False
            if not entry["identity_alive"]:
                missing.append(f"session {session!r}: owner process {pid} is not live")
            elif not entry["identity_matches"]:
                missing.append(
                    f"session {session!r}: start identity mismatch for pid {pid} (pid reuse or wrong identity)"
                )
        else:
            entry["identity_status"] = "UNSUPPORTED_PLATFORM"
        outcome = outcomes.get(session)
        if not isinstance(outcome, dict) or outcome.get("expected") is None:
            missing.append(f"session {session!r}: matching task outcome is missing")
        elif outcome.get("actual") != outcome["expected"] or outcome.get("status") != "passed":
            missing.append(f"session {session!r}: task outcome did not pass against expectation")
        else:
            entry["task_outcome"] = "passed"
        sessions.append(entry)
    extra = sorted(set(outcomes) - set(selected))
    if extra:
        missing.append("outcomes for sessions without identities: " + ", ".join(sorted(extra)))

    for flag, value in (("--scenario", args.scenario), ("--build", args.build),
                        ("--provider-model", args.provider_model), ("--harness", args.harness)):
        if not value or not str(value).strip():
            missing.append(f"{flag} is required and must be recorded")
    local_inference_owner = None
    if args.local_inference == "included":
        if args.local_inference_identity is None:
            missing.append("--local-inference included requires --local-inference-identity")
        else:
            model, pid, start = args.local_inference_identity
            local_inference_owner = {
                "model": model,
                "pid": pid,
                "start_identity": str(start),
                "identity_alive": False,
                "identity_matches": False,
            }
            if linux_proc_supported:
                try:
                    observed_start, _parent = proc_identity(pid, Budget())
                    local_inference_owner["identity_alive"] = True
                    local_inference_owner["identity_matches"] = int(observed_start) == int(start)
                except (OSError, ValueError):
                    pass
                if not local_inference_owner["identity_alive"]:
                    missing.append(f"local inference owner process {pid} is not live")
                elif not local_inference_owner["identity_matches"]:
                    missing.append(
                        f"local inference start identity mismatch for pid {pid} (pid reuse or wrong identity)"
                    )
            else:
                local_inference_owner["identity_status"] = "UNSUPPORTED_PLATFORM"
            if (pid, str(start)) in set(identities):
                missing.append("local inference owner identity duplicates a Session owner identity")
    elif args.local_inference_identity is not None:
        missing.append("--local-inference excluded but a local-inference identity was supplied")
    if not commit or not clean_tree:
        missing.append("exact commit requires a clean working tree (commit_exact)")
    if not (machine.get("processor")
            and isinstance(machine.get("logical_cpu_count"), int)
            and machine.get("logical_cpu_count", 0) > 0
            and isinstance(machine.get("memory_bytes"), int)
            and machine.get("memory_bytes", 0) > 0):
        missing.append("machine metadata (processor, logical CPU count, memory bytes) is incomplete")

    record = {
        "record_type": "rc0_preflight",
        "status": "INPUTS_UNVERIFIED_COMPLETE" if not missing else "INPUTS_INCOMPLETE",
        "input_provenance": "UNVERIFIED_CALLER_SUPPLIED",
        "release_eligible": False,
        "baseline_eligible": False,
        "blocked_reason": ATTESTATION_BLOCKED_REASON,
        "trusted_attestation_sources": list(TRUSTED_ATTESTATION_SOURCES),
        "captured_at": datetime.now(timezone.utc).isoformat(),
        "platform": platform_name(),
        "commit": commit,
        "working_tree_clean": clean_tree,
        "sessions_requested": min_sessions,
        "sessions_supplied": len(selected),
        "scenario": args.scenario,
        "build": args.build,
        "harness": args.harness,
        "provider_model": args.provider_model,
        "local_inference": args.local_inference,
        "local_inference_owner": local_inference_owner,
        "sessions": sessions,
        "missing_inputs": missing,
        "capture_command": capture_command_template(selected, args,
                                                     str(args.outcomes) if args.outcomes else None),
        "measurement_performed": False,
        "note": "input shape/liveness only: caller-supplied values are unverified, and this "
                "mode never launches a workload, opens a provider, or bills",
    }
    return not missing, record


def run_selfcheck():
    """Sample this process's own bounded child tree through the real OS sampler."""
    platform = platform_name()
    if platform["name"] not in ("linux-native", "linux-wsl"):
        return False, {
            "record_type": "rc0_harness_selfcheck",
            "status": "UNSUPPORTED_PLATFORM",
            "platform": platform,
            "known_limitations": ["this smoke check requires Linux /proc"],
        }
    child = subprocess.Popen(["sleep", "60"])
    try:
        start, _parent = proc_identity(os.getpid(), Budget())
        sample = sample_tree(os.getpid(), start)
        pids = sorted(item["pid"] for item in sample["processes"])
        complete = (
            sample["quality"] == "MEASURED"
            and not sample["truncated"]
            and os.getpid() in pids
            and child.pid in pids
            and all(
                item["identity_valid"] and item["quality"] == "MEASURED"
                and all(item["metrics"].get(metric) is not None
                        for metric in REQUIRED_LINUX_METRICS)
                for item in sample["processes"]
            )
        )
        return complete, {
            "record_type": "rc0_harness_selfcheck",
            "status": "MEASURED" if complete else "INCOMPLETE",
            "provisional_raw_sample": False,
            "input_provenance": "HARNESS_SELFCHECK",
            "release_eligible": False,
            "note": "harness self-check only: this process's own bounded child tree, never a "
                    "product-session measurement",
            "platform": platform,
            "commit": git_metadata()[0],
            "owner": {"pid": os.getpid(), "start_identity": str(start)},
            "pids": pids,
            "quality": sample["quality"],
            "truncated": sample["truncated"],
            "processes": sample["processes"],
        }
    finally:
        child.kill()
        child.wait()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selfcheck", action="store_true",
                        help="sample only this process's own bounded sleep tree to verify the harness against the live OS")
    parser.add_argument("--preflight", action="store_true",
                        help="validate the shape/liveness of the 1/5/10/20 capture inputs (unverified provenance) without measuring or billing anything")
    parser.add_argument("--min-sessions", type=int, default=20,
                        help="with --preflight: required distinct live caller-supplied session identities (default: 20)")
    parser.add_argument("--identity", action="append", type=identity_arg, default=[], help="caller-supplied SESSION=PID:START_IDENTITY (unverified: the Core/Rust session owner must attest ownership); repeat per session")
    parser.add_argument("--local-inference-identity", type=identity_arg,
                        help="caller-supplied local model MODEL=PID:START_IDENTITY when local inference is included (unverified provenance)")
    parser.add_argument("--outcomes", type=Path, help="JSON object mapping sessions to expected/actual/status task outcomes (caller-supplied, unverified: Run attestation is required for eligibility)")
    parser.add_argument("--owner-snapshot", type=Path, action="append", default=[],
                        help="bounded P8 Rust owner-sampler JSON envelope; ingestion only, NOT an attestation; repeat once per Session")
    parser.add_argument("--scenario", help="real workload/task description")
    parser.add_argument("--build", help="build profile and compiler/runtime identifiers")
    parser.add_argument("--warm-cold", choices=("warm", "cold"))
    parser.add_argument("--provider-model", help="selected provider and model")
    parser.add_argument("--harness", help="selected coding agent or harness")
    parser.add_argument("--local-inference", choices=("included", "excluded"))
    parser.add_argument("--output", type=Path, help="append JSONL to this path (default: stdout)")
    args = parser.parse_args()

    if args.selfcheck:
        ok, record = run_selfcheck()
        print(json.dumps(record, sort_keys=True, separators=(",", ":")))
        return 0 if ok else 1

    required = {
        "--scenario": args.scenario,
        "--build": args.build,
        "--warm-cold": args.warm_cold,
        "--provider-model": args.provider_model,
        "--harness": args.harness,
        "--local-inference": args.local_inference,
    }
    missing = [flag for flag, value in required.items() if not value or not str(value).strip()]
    if missing:
        parser.error("the following arguments are required unless --selfcheck is used: " + ", ".join(missing))

    grouped = {}
    for session, pid, start in args.identity:
        if session in grouped:
            parser.error(f"duplicate caller-supplied identity for session {session!r}")
        grouped[session] = (pid, start)
    if len(args.identity) > 20:
        parser.error("at most 20 --identity values are supported for the 1/5/10/20 matrix")
    if args.preflight and not 1 <= args.min_sessions <= 20:
        parser.error("--min-sessions must be between 1 and 20")
    outcomes = {}
    if args.outcomes:
        try:
            outcomes = load_outcomes(args.outcomes)
        except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
            parser.error(f"invalid --outcomes: {error}")
    if len(args.owner_snapshot) > MAX_OWNER_SNAPSHOTS:
        parser.error(f"at most {MAX_OWNER_SNAPSHOTS} owner snapshots may be ingested")
    owner_samples = []
    try:
        owner_samples = [load_owner_snapshot(path) for path in args.owner_snapshot]
    except (OSError, UnicodeError, json.JSONDecodeError, ValueError) as error:
        parser.error(f"invalid --owner-snapshot: {error}")
    owner_sample_sessions = [sample["session_id"] for sample in owner_samples]
    if len(owner_sample_sessions) != len(set(owner_sample_sessions)):
        parser.error("duplicate owner snapshot Session ID")
    owner_samples_by_session = {sample["session_id"]: sample for sample in owner_samples}
    commit, clean_tree = git_metadata()
    machine = {"architecture": platform.machine(), **hardware_metadata()}
    if args.preflight:
        ready, record = preflight(grouped, outcomes, args, commit, clean_tree, machine,
                                  args.min_sessions)
        record["min_sessions"] = args.min_sessions
        record["owner_samples_ingested"] = len(owner_samples)
        record["owner_sample_digests"] = [sample["snapshot_digest"] for sample in owner_samples]
        record["owner_sample_attestation"] = "NOT_ATTESTED"
        record["owner_resource_limits"] = [{
            "session_id": sample["session_id"],
            "limits": sample.get("resource_limits"),
            "provenance": sample.get("resource_limits_provenance", "UNAVAILABLE"),
        } for sample in owner_samples]
        if owner_samples:
            record["blocked_reason"] = (
                ATTESTATION_BLOCKED_REASON
                + "; P1 must supply the live Core Session process identity and P2 must supply an independently verified final Run result"
            )
        print(json.dumps(record, sort_keys=True, separators=(",", ":")))
        return 0 if ready else 1

    local_inference_sample = None
    if args.local_inference_identity:
        model_owner, pid, start = args.local_inference_identity
        local_inference_sample = {
            "model": model_owner,
            "owner_identity": {"pid": pid, "start_identity": str(start)},
            "sample": sample_tree(pid, start),
        }

    records = []
    ordered_sessions = sorted(grouped.items())
    for session_count in SCENARIOS:
        selected = ordered_sessions[:session_count]
        selected_sessions = {session for session, _identity in selected}
        selected_owner_samples = [owner_samples_by_session[session]
                                  for session in sorted(selected_sessions)
                                  if session in owner_samples_by_session]
        session_results = []
        for session, (pid, start) in selected:
            session_results.append({"session_id": session,
                "owner_identity": {"pid": pid, "start_identity": str(start)},
                "task_outcome": outcomes.get(session), "sample": sample_tree(pid, start)})
        eligible = (len(selected) == session_count and bool(args.scenario.strip()) and baseline_eligible(
            selected, session_results, outcomes, commit, clean_tree, args.provider_model,
            args.build, args.harness, args.local_inference, local_inference_sample, machine))
        agent_totals = aggregate_process_trees([item["sample"] for item in session_results])
        combined_samples = [item["sample"] for item in session_results]
        if args.local_inference == "included" and local_inference_sample:
            combined_samples.append(local_inference_sample["sample"])
        combined_totals = aggregate_process_trees(combined_samples)
        measured_ids = sum(item["sample"].get("quality") == "MEASURED" for item in session_results)
        records.append({"record_type": "rc0_sample", "captured_at": datetime.now(timezone.utc).isoformat(),
            "platform": platform_name(), "machine": machine,
            "commit": commit, "working_tree_clean": clean_tree, "commit_exact": bool(commit and clean_tree),
            "build": args.build, "harness": args.harness, "warm_cold": args.warm_cold, "scenario": args.scenario,
            "sessions_requested": session_count, "sessions_supplied": len(selected),
            "provider_model": args.provider_model, "local_inference": args.local_inference,
            "local_inference_sample": local_inference_sample,
            "agent_process_tree_totals": agent_totals,
            "combined_sampled_process_tree_totals": combined_totals,
            "measured_owned_identities": measured_ids, "expected_task_outcomes_present": bool(selected) and all(
                isinstance(outcomes.get(session), dict) and outcomes[session].get("expected") is not None for session, _ in selected),
            "task_outcomes_passed": bool(selected) and all(
                isinstance(outcomes.get(session), dict) and outcomes[session].get("expected") == outcomes[session].get("actual")
                and outcomes[session].get("status") == "passed" for session, _ in selected),
            "owner_resource_limits": [{
                "session_id": sample["session_id"],
                "limits": sample.get("resource_limits"),
                "provenance": sample.get("resource_limits_provenance", "UNAVAILABLE"),
            } for sample in selected_owner_samples],
            "baseline_eligible": eligible, "status": "NOT_BASELINE",
            "provisional_raw_sample": True,
            "input_provenance": "UNVERIFIED_CALLER_SUPPLIED",
            "release_eligible": False,
            "blocked_reason": ATTESTATION_BLOCKED_REASON,
            "owner_samples_ingested": len(owner_samples),
            "owner_sample_digests": [sample["snapshot_digest"] for sample in owner_samples],
            "owner_sample_attestation": "NOT_ATTESTED",
            "owner_worker_samples": [{key: sample[key] for key in (
                "session_id", "run_id", "task_id", "attempt_id", "owner_log_id", "owner_log_sequence",
                "owner_log_event_digest", "snapshot_digest", "worker_count",
                "workers", "product_attestation", "session_process_owner")}
                for sample in selected_owner_samples],
            "owner_worker_aggregate": aggregate_owner_samples(selected_owner_samples),
            "sessions": session_results})
    serialized_records = [json.dumps(record, sort_keys=True, separators=(",", ":")) + "\n"
                          for record in records]
    output_bytes = sum(len(record.encode("utf-8")) for record in serialized_records)
    if output_bytes > MAX_CAPTURE_OUTPUT_BYTES:
        parser.error(
            f"capture output exceeds the {MAX_CAPTURE_OUTPUT_BYTES // (1024 * 1024)} MiB per-invocation bound; no records were written"
        )
    payload = "".join(serialized_records).encode("utf-8")
    if args.output:
        try:
            append_capture_output(args.output, payload)
        except (OSError, ValueError) as error:
            parser.error(f"unable to append RC0 output safely: {error}")
    else:
        sys.stdout.buffer.write(payload)
        sys.stdout.buffer.flush()
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
