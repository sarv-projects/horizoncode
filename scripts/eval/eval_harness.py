#!/usr/bin/env python3
"""Paired-evaluation protocol, fake self-check, and guarded HostRun bridge contract.

The module never calls a provider, starts a process, downloads benchmark data, or
accesses a workspace. Live paired execution is available only as a library seam to
the authenticated HorizonCode HostRun owner; the CLI intentionally remains fake-only
until P1/P2 wire that owner and its independent verifier.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
import random
import re
import stat
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Protocol

import blake3

SCHEMA = "horizoncode.eval.manifest.v1"
MAX_MANIFEST_BYTES = 2 * 1024 * 1024
MAX_TASKS = 10_000
MAX_ID_BYTES = 128
MAX_ARTIFACT_BYTES = 64 * 1024 * 1024
MAX_TASK_CATALOG_BYTES = 64 * 1024 * 1024
MAX_FAKE_OUTPUT_BYTES = 65_536
MAX_TASK_INPUT_BYTES = 1_048_576
ARMS = ("minimal", "horizoncode")
ABLATION_FEATURES = {"delegation", "repointel", "codemode", "verification_retry"}
LANES = {"development", "smoke", "heldout"}
# §30.27 HUP-001/002: one frozen bundle per model class so a strong, small and
# local comparison are separately identified and never conflated in one score.
MODEL_CLASSES = ("strong", "small", "local")


class EvalError(ValueError):
    pass


class EvaluationCancelled(Exception):
    """A controlled cancellation from a provider adapter."""


class InfrastructureFailure(Exception):
    """An infrastructure failure, distinct from a task/model failure."""


def _pairs_no_duplicates(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise EvalError(f"duplicate JSON property: {key}")
        result[key] = value
    return result


def _artifact_location(path: Path) -> tuple[Path, tuple[str, ...]]:
    """Normalize lexically; actual traversal is descriptor-relative and no-follow."""
    root = Path(__file__).resolve().parents[2]
    candidate = Path(os.path.abspath(path if path.is_absolute() else root / path))
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise EvalError("evaluation artifacts must remain inside the repository") from exc
    parts = relative.parts
    if not parts or any(part in {"", ".", ".."} for part in parts):
        raise EvalError("artifact path must name a repository-contained file")
    required_flags = ("O_NOFOLLOW", "O_DIRECTORY")
    if any(not hasattr(os, flag) for flag in required_flags) or not hasattr(os, "supports_dir_fd"):
        raise EvalError("this platform lacks safe descriptor-relative artifact operations")
    if os.open not in os.supports_dir_fd:
        raise EvalError("this platform lacks safe descriptor-relative artifact operations")
    return root, parts


def _open_parent(root: Path, components: tuple[str, ...], *, create: bool) -> int:
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        current = os.open(root, flags)
    except OSError as exc:
        raise EvalError(f"repository root cannot be opened safely: {exc.__class__.__name__}") from exc
    root_device = os.fstat(current).st_dev
    for component in components:
        try:
            try:
                child = os.open(component, flags, dir_fd=current)
            except FileNotFoundError:
                if not create:
                    raise
                try:
                    os.mkdir(component, mode=0o700, dir_fd=current)
                except FileExistsError:
                    pass
                child = os.open(component, flags, dir_fd=current)
            info = os.fstat(child)
            if not stat.S_ISDIR(info.st_mode) or info.st_dev != root_device:
                os.close(child)
                raise EvalError("artifact directory is not a repository-local directory")
        except EvalError:
            os.close(current)
            raise
        except OSError as exc:
            os.close(current)
            raise EvalError(f"artifact directory traversal failed safely: {exc.__class__.__name__}") from exc
        os.close(current)
        current = child
    return current


def _read_open_regular(fd: int, limit: int) -> tuple[bytes, os.stat_result]:
    """Read a pinned artifact descriptor without reopening its path."""
    before = os.fstat(fd)
    if not stat.S_ISREG(before.st_mode) or before.st_nlink != 1 or before.st_size > limit:
        raise EvalError("artifact is not a bounded private regular file")
    if not hasattr(os, "pread"):
        raise EvalError("safe locked artifact reads are unavailable on this platform")
    chunks = []
    offset = 0
    while offset <= limit:
        chunk = os.pread(fd, min(65_536, limit + 1 - offset), offset)
        if not chunk:
            break
        chunks.append(chunk)
        offset += len(chunk)
    raw = b"".join(chunks)
    after = os.fstat(fd)
    if (len(raw) > limit or (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
            or after.st_size != len(raw)):
        raise EvalError("artifact changed or exceeded its byte limit while it was being read")
    return raw, after


def canonical_json(value: object) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"),
                      allow_nan=False).encode("utf-8")


def bounded_canonical_json(value: object, limit: int) -> bytes:
    """Canonicalize with bounded writes so a resolver cannot force a large intermediate string."""
    output = bytearray()

    def write(raw: bytes):
        if len(output) + len(raw) > limit:
            raise EvalError("canonical value exceeds its byte limit")
        output.extend(raw)

    def string(text: str):
        write(b'"')
        escapes = {"\b": b"\\b", "\f": b"\\f", "\n": b"\\n",
                   "\r": b"\\r", "\t": b"\\t", '"': b'\\"', "\\": b"\\\\"}
        for char in text:
            escaped = escapes.get(char)
            if escaped is not None:
                write(escaped)
            elif ord(char) < 0x20:
                write(f"\\u{ord(char):04x}".encode("ascii"))
            else:
                write(char.encode("utf-8", errors="strict"))
        write(b'"')

    nodes = 0

    def encode(item, depth: int):
        nonlocal nodes
        nodes += 1
        if nodes > 100_000 or depth > 64:
            raise EvalError("canonical value exceeds its node or nesting limit")
        if item is None:
            write(b"null")
        elif item is True:
            write(b"true")
        elif item is False:
            write(b"false")
        elif isinstance(item, str):
            string(item)
        elif isinstance(item, int):
            if item.bit_length() > limit * 4:
                raise EvalError("canonical integer exceeds its byte limit")
            write(str(item).encode("ascii"))
        elif isinstance(item, float):
            write(json.dumps(item, allow_nan=False, separators=(",", ":")).encode("ascii"))
        elif isinstance(item, list) or isinstance(item, tuple):
            if len(item) > 100_000:
                raise EvalError("canonical array exceeds its item limit")
            write(b"[")
            for index, child in enumerate(item):
                if index:
                    write(b",")
                encode(child, depth + 1)
            write(b"]")
        elif isinstance(item, dict):
            if len(item) > 100_000 or any(not isinstance(key, str) for key in item):
                raise EvalError("canonical object exceeds its item limit or has non-string keys")
            if sum(len(key) + 3 for key in item) > limit:
                raise EvalError("canonical object keys exceed their byte limit")
            write(b"{")
            for index, key in enumerate(sorted(item)):
                if index:
                    write(b",")
                string(key)
                write(b":")
                encode(item[key], depth + 1)
            write(b"}")
        else:
            raise EvalError("value is not canonical JSON")

    try:
        encode(value, 0)
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise EvalError("value is not bounded canonical JSON") from exc
    return bytes(output)


def digest(value: object) -> str:
    return "sha256:" + hashlib.sha256(canonical_json(value)).hexdigest()


def _token(value, field: str) -> str:
    if not isinstance(value, str) or not value or len(value.encode("utf-8")) > MAX_ID_BYTES:
        raise EvalError(f"{field} must be a non-empty bounded string")
    if any(ord(char) < 0x20 for char in value):
        raise EvalError(f"{field} contains a control character")
    return value


def load_manifest(path: Path) -> dict:
    fd = -1
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0))
        before = os.fstat(fd)
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_MANIFEST_BYTES:
            raise EvalError("manifest is not a bounded regular file")
        chunks = []
        remaining = MAX_MANIFEST_BYTES + 1
        while remaining:
            chunk = os.read(fd, min(65_536, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        raw = b"".join(chunks)
        after = os.fstat(fd)
        if ((before.st_dev, before.st_ino) != (after.st_dev, after.st_ino)
                or after.st_size != len(raw) or len(raw) > MAX_MANIFEST_BYTES):
            raise EvalError("manifest changed or exceeded its byte limit while being read")
    except OSError as exc:
        raise EvalError(f"manifest read failed: {exc.__class__.__name__}") from exc
    finally:
        if fd >= 0:
            os.close(fd)
    if not raw or len(raw) > MAX_MANIFEST_BYTES:
        raise EvalError("manifest is empty or exceeds the byte limit")
    try:
        value = json.loads(raw.decode("utf-8", errors="strict"), object_pairs_hook=_pairs_no_duplicates)
    except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
        raise EvalError("manifest is not valid UTF-8 JSON") from exc
    validate_manifest(value)
    return value


def validate_manifest(value: object) -> None:
    if not isinstance(value, dict) or value.get("schema") != SCHEMA:
        raise EvalError("unsupported evaluation manifest schema")
    required_keys = {"schema", "runId", "lane", "benchmark", "shared", "arms", "tasks",
                     "taskPartitions", "analysis", "comparison", "failurePolicy",
                     "exclusionPolicy"}
    optional_keys = {"seed", "cancelAfterCalls", "fakeSelfcheck"}
    if not required_keys.issubset(value) or set(value) - required_keys - optional_keys:
        raise EvalError("manifest fields do not match the frozen v1 schema")
    try:
        if len(canonical_json(value)) > MAX_MANIFEST_BYTES:
            raise EvalError("manifest exceeds the canonical byte limit")
    except (TypeError, ValueError, UnicodeError, RecursionError) as exc:
        raise EvalError("manifest contains a non-canonical or unbounded value") from exc
    _token(value.get("runId"), "runId")
    if value["failurePolicy"] != "typed_fail_closed_v1":
        raise EvalError("failurePolicy must preserve typed infrastructure and task failures")
    if value["exclusionPolicy"] != "declared_partition_only_v1":
        raise EvalError("exclusionPolicy must use only the frozen task partition")
    if value.get("lane") not in LANES:
        raise EvalError("lane must be development, smoke, or heldout")
    benchmark = value.get("benchmark")
    if not isinstance(benchmark, dict) or set(benchmark) != {
        "name", "version", "split", "splitDigest", "scoringField", "evaluatorDigest"
    }:
        raise EvalError("benchmark provenance is required")
    for field in ("name", "version", "split", "splitDigest", "scoringField", "evaluatorDigest"):
        _token(benchmark.get(field), f"benchmark.{field}")

    shared = value.get("shared")
    if not isinstance(shared, dict) or set(shared) != {
        "providerRoute", "modelRevision", "modelClass", "repositoryImageDigest", "promptDigest",
        "oracleDigest", "permissionProfileDigest", "sampling", "budgets", "toolAllowlist"
    }:
        raise EvalError("shared paired-arm configuration is required")
    if shared.get("modelClass") not in MODEL_CLASSES:
        raise EvalError("shared.modelClass must be strong, small, or local")
    for field in ("providerRoute", "modelRevision", "repositoryImageDigest", "promptDigest",
                  "oracleDigest", "permissionProfileDigest"):
        _token(shared.get(field), f"shared.{field}")
    for field in ("sampling", "budgets", "toolAllowlist"):
        if field not in shared:
            raise EvalError(f"shared.{field} is required")
    if not isinstance(shared["sampling"], dict) or not isinstance(shared["budgets"], dict):
        raise EvalError("sampling and budgets must be objects")
    required_budgets = {"tokenBudget", "wallTimeMs", "maxToolCalls", "maxRetries", "costMicros"}
    if set(shared["budgets"]) != required_budgets:
        raise EvalError("budgets must pin token, wall-time, tool-call, retry, and cost ceilings")
    for field in ("tokenBudget", "wallTimeMs"):
        ceiling = shared["budgets"][field]
        if (not isinstance(ceiling, int) or isinstance(ceiling, bool)
                or ceiling <= 0 or ceiling > 2**63 - 1):
            raise EvalError(f"shared.budgets.{field} must be a positive integer")
    for field in ("maxToolCalls", "maxRetries"):
        ceiling = shared["budgets"][field]
        if (not isinstance(ceiling, int) or isinstance(ceiling, bool)
                or ceiling < 0 or ceiling > 2**63 - 1):
            raise EvalError(f"shared.budgets.{field} must be a non-negative integer")
    cost_ceiling = shared["budgets"]["costMicros"]
    if (not isinstance(cost_ceiling, int) or isinstance(cost_ceiling, bool)
            or cost_ceiling < 0 or cost_ceiling > 2**63 - 1):
        raise EvalError("shared.budgets.costMicros must be a non-negative integer")
    if not isinstance(shared["toolAllowlist"], list) or any(not isinstance(x, str) for x in shared["toolAllowlist"]):
        raise EvalError("toolAllowlist must be a string array")
    if shared["toolAllowlist"] != sorted(set(shared["toolAllowlist"])):
        raise EvalError("toolAllowlist must be sorted and unique")

    arms = value.get("arms")
    if not isinstance(arms, list) or len(arms) != 2 or any(not isinstance(arm, dict) for arm in arms):
        raise EvalError("exactly two paired arms are required")
    arm_ids = [arm.get("id") for arm in arms]
    if any(not isinstance(arm_id, str) or not arm_id for arm_id in arm_ids) or len(set(arm_ids)) != 2:
        raise EvalError("paired arm IDs must be distinct non-empty strings")
    for arm in arms:
        if set(arm) != {"id", "harnessDigest", "harnessCommit", "declaredFactor"}:
            raise EvalError("each arm must pin its harness digest, source commit, and comparison factor")
        _token(arm["id"], "arms.id")
        _token(arm["harnessDigest"], f"arms.{arm['id']}.harnessDigest")
        _token(arm["harnessCommit"], f"arms.{arm['id']}.harnessCommit")
        _token(arm["declaredFactor"], f"arms.{arm['id']}.declaredFactor")
    comparison = value.get("comparison")
    if not isinstance(comparison, dict):
        raise EvalError("comparison roles must be frozen")
    kind = comparison.get("kind")
    if kind == "baseline_vs_full":
        if set(comparison) != {"kind", "referenceArmId", "candidateArmId"}:
            raise EvalError("baseline-versus-full comparison fields are invalid")
        if (comparison["referenceArmId"], comparison["candidateArmId"]) != ARMS:
            raise EvalError("baseline-versus-full arm identities are invalid")
        expected_factors = {"minimal": "minimal_single_turn", "horizoncode": "horizoncode_harness"}
    elif kind == "full_vs_ablation":
        if set(comparison) != {"kind", "referenceArmId", "candidateArmId", "ablatedFeature"}:
            raise EvalError("full-versus-ablation comparison fields are invalid")
        feature = comparison.get("ablatedFeature")
        if not isinstance(feature, str) or feature not in ABLATION_FEATURES:
            raise EvalError("ablation feature is not in the predeclared P8 set")
        if (comparison["referenceArmId"], comparison["candidateArmId"]) != ("full", "ablation"):
            raise EvalError("full-versus-ablation arm identities are invalid")
        expected_factors = {"full": "horizoncode_harness", "ablation": f"without:{feature}"}
    else:
        raise EvalError("unsupported paired comparison kind")
    if set(arm_ids) != set(expected_factors) or any(
            arm["declaredFactor"] != expected_factors[arm["id"]] for arm in arms):
        raise EvalError("arm factors do not match the pinned comparison")

    tasks = value.get("tasks")
    if not isinstance(tasks, list) or not tasks or len(tasks) > MAX_TASKS:
        raise EvalError("tasks must be a non-empty bounded array")
    ids = []
    groups = []
    for task in tasks:
        if not isinstance(task, dict) or set(task) != {"taskId", "taskGroup", "inputDigest"}:
            raise EvalError("each task requires taskId, taskGroup, and inputDigest only")
        ids.append(_token(task["taskId"], "task.taskId"))
        groups.append(_token(task["taskGroup"], "task.taskGroup"))
        _token(task["inputDigest"], "task.inputDigest")
    if len(ids) != len(set(ids)):
        raise EvalError("task IDs must be unique within a manifest")
    partitions = value.get("taskPartitions")
    if not isinstance(partitions, dict) or set(partitions) != LANES:
        raise EvalError("taskPartitions must pin development, smoke, and heldout IDs")
    flattened = []
    for lane, lane_ids in partitions.items():
        if not isinstance(lane_ids, list) or any(not isinstance(item, str) or not item for item in lane_ids):
            raise EvalError(f"taskPartitions.{lane} must be a string array")
        if lane_ids != sorted(set(lane_ids)):
            raise EvalError(f"taskPartitions.{lane} must be sorted and unique")
        flattened.extend(lane_ids)
    if len(flattened) != len(set(flattened)):
        raise EvalError("development, smoke, and heldout task partitions overlap")
    if partitions[value["lane"]] != sorted(ids):
        raise EvalError("manifest tasks do not exactly match the frozen lane partition")
    if value.get("seed") is not None and (not isinstance(value["seed"], int) or isinstance(value["seed"], bool)):
        raise EvalError("seed must be an integer or null")
    if value.get("seed") is not None and not -(2**63) <= value["seed"] <= 2**63 - 1:
        raise EvalError("seed is outside the supported signed 64-bit range")
    if "fakeSelfcheck" in value and not isinstance(value["fakeSelfcheck"], bool):
        raise EvalError("fakeSelfcheck must be boolean")
    if (not isinstance(value.get("cancelAfterCalls", 0), int)
            or isinstance(value.get("cancelAfterCalls", 0), bool)
            or value.get("cancelAfterCalls", 0) < 0):
        raise EvalError("cancelAfterCalls must be a non-negative integer")
    analysis = value.get("analysis")
    if not isinstance(analysis, dict) or set(analysis) != {
        "intervalMethod", "confidenceLevel", "bootstrapReplicates", "minimumMeaningfulDifferencePp"
    }:
        raise EvalError("analysis must freeze the paired uncertainty method and threshold")
    if analysis["intervalMethod"] != "repository_cluster_bootstrap_percentile":
        raise EvalError("unsupported paired uncertainty interval method")
    confidence = analysis["confidenceLevel"]
    if (not isinstance(confidence, (int, float)) or isinstance(confidence, bool)
            or not 0 < confidence < 1):
        raise EvalError("analysis.confidenceLevel must be between zero and one")
    reps = analysis["bootstrapReplicates"]
    if not isinstance(reps, int) or isinstance(reps, bool) or not 100 <= reps <= 100_000:
        raise EvalError("analysis.bootstrapReplicates is outside the bounded range")
    minimum = analysis["minimumMeaningfulDifferencePp"]
    if (not isinstance(minimum, (int, float)) or isinstance(minimum, bool)
            or not 0 <= minimum <= 100):
        raise EvalError("analysis.minimumMeaningfulDifferencePp must be from zero to 100")


@dataclass(frozen=True)
class Invocation:
    task_id: str
    task_group: str
    input_digest: str
    arm_id: str
    arm_harness_digest: str
    shared_digest: str
    manifest_digest: str
    call_index: int


@dataclass(frozen=True)
class FakeResponse:
    output: str
    expected_output: str
    evidence: str
    elapsed_ms: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    cost_micros: int | None = None
    capability_complete: bool = True
    tool_calls: int = 0
    retries: int = 0
    completion_claimed: bool = True
    security_failure: bool = False
    interventions: int = 0


class Provider(Protocol):
    def invoke(self, request: Invocation) -> FakeResponse: ...


@dataclass(frozen=True)
class EvaluationResult:
    records: tuple[dict, ...]
    artifact_digest: str
    mode: str = "FAKE_SELF_CHECK"
    official_score_eligible: bool = False


@dataclass(frozen=True)
class HostRunInvocationV1:
    """A frozen paired trial request handed to the authenticated product host.

    This runner deliberately has no provider, process, shell, socket, or workspace
    implementation. A production bridge must resolve this request through the
    authenticated Rust HostKernel/managed-run path, where user consent, selected
    route, Guard, worktree leases, and independent verification are enforced.
    """

    manifest_digest: str
    shared_digest: str
    dispatch_idempotency_key: str
    call_index: int
    task: Mapping
    arm: Mapping
    shared: Mapping


@dataclass(frozen=True)
class HostRunOutcomeV1:
    """Redacted, evidence-bearing outcome returned by the trusted HostRun bridge."""

    run_id: str
    attempt_id: str
    task_id: str
    arm_id: str
    dispatch_idempotency_key: str
    provider_route: str
    model_revision: str
    harness_digest: str
    workspace_revision: str
    verifier_digest: str
    verifier_verdict: str
    host_run_receipt_ref: str
    verifier_evidence_ref: str
    owner_log_event_digest: str
    elapsed_ms: int | None
    input_tokens: int | None
    output_tokens: int | None
    cost_micros: int | None
    cost_provenance: str
    tool_calls: int | None
    retries: int | None
    interventions: int | None
    resource_use: Mapping
    security_failure: bool = False
    capability_complete: bool = True


class HostRunBridge(Protocol):
    """Authenticated bridge to the existing HorizonCode managed execution path.

    Implementations must call Rust HostKernel, never a provider SDK, shell, or
    worker process directly. They must resolve/reconcile `dispatch_idempotency_key`
    against the same live managed Attempt before any dispatch, so process restart
    cannot repeat an ambiguous effect. In V1 this protocol is not installed by the
    CLI; until P1/P2 wire its authenticated source, live evaluation is unavailable.

    Optional control-plane members (all required once a control plane is used):

    * ``prepare_dispatch(invocation) -> HostRunDispatchHandleV1`` reports the
      host-derived Goal/Attempt identity the pre-dispatch `host_run.bind` body
      must name. It grants no authority: HostKernel re-derives every pin.
    * ``control_plane`` / ``owner_log`` supply the default
      ``HostRunControlPlaneClient`` and P8 OwnerLog append seam for
      `run_host_paired_evaluation`.
    """

    def dispatch_guarded_trial(self, invocation: HostRunInvocationV1) -> HostRunOutcomeV1: ...


class TaskImageResolver(Protocol):
    """Resolve only repository-local frozen task data whose canonical digest matches."""

    def resolve_task(self, task_id: str) -> Mapping: ...


class RepositoryTaskImageResolver:
    """Load an immutable, bounded JSONL workload that exactly matches a frozen manifest.

    File layout: one header with `recordType=catalog`, schema, benchmarkDigest,
    repositoryImageDigest and taskCount, followed by one record per task with `recordType=task`, taskId,
    taskGroup, and input. The canonical digest of each returned task envelope must
    match the manifest's `inputDigest`.
    """

    SCHEMA = "horizoncode.eval.task-catalog.v1"

    def __init__(self, path: Path, manifest: Mapping):
        frozen = json.loads(canonical_json(dict(manifest)))
        validate_manifest(frozen)
        root, components = _artifact_location(path)
        parent_fd = _open_parent(root, components[:-1], create=False)
        fd = -1
        try:
            flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
            fd = os.open(components[-1], flags, dir_fd=parent_fd)
            info = os.fstat(fd)
            parent_info = os.fstat(parent_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_dev != parent_info.st_dev):
                raise EvalError("task catalog is not a private repository-local regular file")
            raw, _ = _read_open_regular(fd, MAX_TASK_CATALOG_BYTES)
        except OSError as exc:
            raise EvalError(f"task catalog read failed: {exc.__class__.__name__}") from exc
        finally:
            if fd >= 0:
                os.close(fd)
            os.close(parent_fd)
        if not raw or not raw.endswith(b"\n"):
            raise EvalError("task catalog must be non-empty newline-terminated JSONL")
        lines = raw.splitlines()
        if not lines or any(not line for line in lines):
            raise EvalError("task catalog contains an empty line")
        try:
            header = json.loads(lines[0].decode("utf-8", errors="strict"),
                                object_pairs_hook=_pairs_no_duplicates)
        except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
            raise EvalError("task catalog header is malformed") from exc
        expected_header = {
            "recordType": "catalog", "schema": self.SCHEMA,
            "benchmarkDigest": digest(frozen["benchmark"]), "taskCount": len(frozen["tasks"]),
            "repositoryImageDigest": frozen["shared"]["repositoryImageDigest"],
        }
        if (type(header) is not dict
                or set(header) != set(expected_header)
                or type(header.get("taskCount")) is not int
                or header != expected_header):
            raise EvalError("task catalog header differs from frozen benchmark provenance")
        expected_tasks = {task["taskId"]: task for task in frozen["tasks"]}
        resolved = {}
        for line in lines[1:]:
            if len(line) > MAX_TASK_INPUT_BYTES + 4096:
                raise EvalError("task catalog record exceeds its byte limit")
            try:
                record = json.loads(line.decode("utf-8", errors="strict"),
                                    object_pairs_hook=_pairs_no_duplicates)
            except (UnicodeError, json.JSONDecodeError, RecursionError) as exc:
                raise EvalError("task catalog contains malformed JSON") from exc
            if (not isinstance(record, dict)
                    or set(record) != {"recordType", "taskId", "taskGroup", "input"}
                    or record["recordType"] != "task"):
                raise EvalError("task catalog record fields do not match the frozen format")
            task_id = _token(record["taskId"], "taskCatalog.taskId")
            group = _token(record["taskGroup"], "taskCatalog.taskGroup")
            task_pin = expected_tasks.get(task_id)
            if task_pin is None or task_id in resolved or group != task_pin["taskGroup"]:
                raise EvalError("task catalog contains a duplicate, foreign, or mismatched task")
            envelope = {"taskId": task_id, "taskGroup": group, "input": record["input"]}
            task_bytes = bounded_canonical_json(envelope, MAX_TASK_INPUT_BYTES)
            if "sha256:" + hashlib.sha256(task_bytes).hexdigest() != task_pin["inputDigest"]:
                raise EvalError("task catalog input differs from its frozen task digest")
            resolved[task_id] = envelope
        if set(resolved) != set(expected_tasks):
            raise EvalError("task catalog does not contain the exact frozen task set")
        self._tasks = resolved

    def resolve_task(self, task_id: str) -> Mapping:
        _token(task_id, "taskId")
        try:
            raw = bounded_canonical_json(self._tasks[task_id], MAX_TASK_INPUT_BYTES)
            return json.loads(raw.decode("utf-8", errors="strict"))
        except KeyError as exc:
            raise EvalError("task is not present in the frozen local catalog") from exc


def _bounded_optional_counter(value, name: str) -> int | None:
    if value is None:
        return None
    if not isinstance(value, int) or isinstance(value, bool) or not 0 <= value <= 2**63 - 1:
        raise EvalError(f"HostRun {name} is not a bounded non-negative integer")
    return value


def _validate_host_run_trial_evidence(row: Mapping, *, require_complete: bool) -> None:
    """Reject self-contradictory HostRun trial evidence and unverified resource claims.

    Only rows produced for an actual HostRun outcome are checked. A locally edited but
    well-shaped journal is still not authenticated evidence; this function exists so a
    persisted/summarized row cannot assert a PASS, security state, or resource figure that
    contradicts its own recorded verdict. Missing evidence stays blocked by the runner's
    authenticated-reconciliation guard.
    """
    outcome_keys = {"verifierVerdict", "securityFailure", "resourceUse", "falseCompletion",
                    "failureClass"}
    if not require_complete and not (outcome_keys & set(row)):
        return
    status = row.get("status")
    verdict = row.get("verifierVerdict")
    security = row.get("securityFailure")
    false_completion = row.get("falseCompletion")
    failure_class = row.get("failureClass")
    resource = row.get("resourceUse")
    if verdict not in {"PASS", "FAIL", "INCOMPLETE"}:
        raise EvalError("HostRun trial is missing a valid verifier verdict")
    if not isinstance(security, bool):
        raise EvalError("HostRun trial is missing its security outcome")
    if not isinstance(false_completion, bool):
        raise EvalError("HostRun trial is missing its false-completion verdict")
    if (not isinstance(resource, Mapping) or set(resource) - {"status", "reason"}
            or resource.get("status") != "UNKNOWN"):
        raise EvalError(
            "HostRun trial resource use must stay UNKNOWN without a verified RC0 attestation")
    if status == "PASS_VERIFIED":
        if security or verdict != "PASS" or false_completion or failure_class != "none":
            raise EvalError("HostRun PASS_VERIFIED contradicts its verifier/security evidence")
    elif status == "FAIL_UNVERIFIED":
        if false_completion != (verdict == "FAIL"):
            raise EvalError("HostRun failure contradicts its false-completion verdict")
        if security and failure_class != "security_failure":
            raise EvalError("HostRun security failure must carry the security failure class")
        if verdict == "PASS" and failure_class != "budget_exhaustion":
            raise EvalError("HostRun PASS verdict may only fail on budget exhaustion")
        if verdict == "INCOMPLETE" and failure_class != "test_verification":
            raise EvalError("HostRun incomplete verdict must fail at test verification")


def _validate_host_run_outcome(outcome, invocation, manifest, task, arm) -> tuple[str, dict]:
    """Require exact route/config/evidence pins before any trial can score."""
    if not isinstance(outcome, HostRunOutcomeV1):
        raise EvalError("HostKernel bridge returned an untyped HostRun outcome")
    expected = {
        "run_id": manifest["runId"],
        "task_id": task["taskId"],
        "arm_id": arm["id"],
        "dispatch_idempotency_key": invocation.dispatch_idempotency_key,
        "provider_route": manifest["shared"]["providerRoute"],
        "model_revision": manifest["shared"]["modelRevision"],
        "harness_digest": arm["harnessDigest"],
        "verifier_digest": manifest["benchmark"]["evaluatorDigest"],
    }
    if any(getattr(outcome, field) != value for field, value in expected.items()):
        raise EvalError("HostRun outcome differs from frozen task, route, arm, or verifier pins")
    for field in ("attempt_id", "workspace_revision", "host_run_receipt_ref", "verifier_evidence_ref"):
        value = getattr(outcome, field)
        _token(value, f"HostRun.{field}")
    if outcome.host_run_receipt_ref == outcome.verifier_evidence_ref:
        raise EvalError(
            "HostRun receipt and independent verifier evidence must be distinct references")
    if not re.fullmatch(r"blake3:[0-9a-f]{64}", outcome.owner_log_event_digest):
        raise EvalError("HostRun outcome lacks an exact OwnerLog event digest")
    if outcome.verifier_verdict not in {"PASS", "FAIL", "INCOMPLETE"}:
        raise EvalError("HostRun verifier verdict is invalid")
    if outcome.cost_provenance not in {"MEASURED", "ESTIMATED", "UNKNOWN"}:
        raise EvalError("HostRun cost provenance is invalid")
    counters = {
        "elapsed_ms": _bounded_optional_counter(outcome.elapsed_ms, "elapsed time"),
        "input_tokens": _bounded_optional_counter(outcome.input_tokens, "input tokens"),
        "output_tokens": _bounded_optional_counter(outcome.output_tokens, "output tokens"),
        "cost_micros": _bounded_optional_counter(outcome.cost_micros, "cost"),
        "tool_calls": _bounded_optional_counter(outcome.tool_calls, "tool calls"),
        "retries": _bounded_optional_counter(outcome.retries, "retries"),
        "interventions": _bounded_optional_counter(outcome.interventions, "interventions"),
    }
    if (outcome.cost_provenance == "UNKNOWN") != (outcome.cost_micros is None):
        raise EvalError("HostRun cost value and provenance disagree")
    if (type(outcome.resource_use) is not dict
            or set(outcome.resource_use) != {"status"}
            or outcome.resource_use.get("status") != "UNKNOWN"):
        raise EvalError("HostRun resource use remains UNKNOWN until RC0 attestation is integrated")
    if not isinstance(outcome.security_failure, bool) or not isinstance(outcome.capability_complete, bool):
        raise EvalError("HostRun security and capability outcomes must be booleans")
    # Don't copy untrusted resource figures into a result; the current OwnerLog /
    # HostRun bridge does not yet bind an RC0 sample reference.
    if outcome.security_failure and outcome.verifier_verdict == "PASS":
        raise EvalError("HostRun security failure conflicts with verifier PASS")
    budgets = manifest["shared"]["budgets"]
    total_tokens = None if counters["input_tokens"] is None or counters["output_tokens"] is None else (
        counters["input_tokens"] + counters["output_tokens"]
    )
    exceeded = (
        counters["elapsed_ms"] is not None and counters["elapsed_ms"] > budgets["wallTimeMs"]
        or total_tokens is not None and total_tokens > budgets["tokenBudget"]
        or counters["tool_calls"] is not None and counters["tool_calls"] > budgets["maxToolCalls"]
        or counters["retries"] is not None and counters["retries"] > budgets["maxRetries"]
        or counters["cost_micros"] is not None and counters["cost_micros"] > budgets["costMicros"]
    )
    if not outcome.capability_complete:
        status, failure_stage = "UNSUPPORTED_CAPABILITY", "unsupported_capability"
    elif outcome.verifier_verdict == "PASS" and not outcome.security_failure and not exceeded:
        status, failure_stage = "PASS_VERIFIED", None
    else:
        status = "FAIL_UNVERIFIED"
        failure_stage = "security_failure" if outcome.security_failure else (
            "budget_exhaustion" if exceeded else "test_verification"
        )
    row = {
        "taskId": task["taskId"], "taskGroup": task["taskGroup"], "armId": arm["id"],
        "hostRunDispatchIndex": invocation.call_index,
        "dispatchIdempotencyKey": invocation.dispatch_idempotency_key,
        "manifestDigest": invocation.manifest_digest,
        "sharedConfigDigest": invocation.shared_digest,
        "status": status, "dispatchStarted": True,
        "failureClass": "none" if status == "PASS_VERIFIED" else failure_stage,
        "evidenceStage": failure_stage,
        "falseCompletion": status != "PASS_VERIFIED" and outcome.verifier_verdict == "FAIL",
        "securityFailure": outcome.security_failure,
        "interventions": counters["interventions"],
        "resourceUse": {"status": "UNKNOWN", "reason": "HostRun RC0 attestation is not integrated"},
        "hostRunReceiptRef": outcome.host_run_receipt_ref,
        "verifierEvidenceRef": outcome.verifier_evidence_ref,
        "ownerLogEventDigest": outcome.owner_log_event_digest,
        "verifierVerdict": outcome.verifier_verdict,
        "workspaceRevision": outcome.workspace_revision,
        "elapsedMs": counters["elapsed_ms"],
        "inputTokens": counters["input_tokens"], "outputTokens": counters["output_tokens"],
        "toolCalls": counters["tool_calls"], "retries": counters["retries"],
        "costMicros": counters["cost_micros"], "costProvenance": outcome.cost_provenance,
        "mode": "HOST_RUN_PAIRED",
    }
    return status, row


# ---------------------------------------------------------------------------
# HostRun control plane — P2's authenticated `managed.v1` HostRun routes
# ---------------------------------------------------------------------------
#
#   append      managed.v1/host_run.bind          strict 7-field body, pre-dispatch
#   post-commit managed.v1/host_run.bind_receipt  strict 6-field body
#   resolve     managed.v1/host_run.inspect       strict 2-field body, read-only
#
# Every authority pin inside the returned binding is derived host-side by
# HostKernel from the authenticated peer/fence, the live managed Attempt, the
# start-pinned SessionLink, the registered Location and P8's durable
# reservation. This module only ever *sends* the evaluator's own correlation
# facts (the Goal/Attempt handle the bridge reports, the frozen manifest
# digest, task/arm/group) and *reads* the reconciliation; no request field and
# no response field is treated as authority without an exact contract check.
# The raw dispatch idempotency key is never sent: only its BLAKE3 digest.

MANAGED_SERVICE_ID = "managed.v1"
HOST_RUN_BIND_OPERATION = "host_run.bind"
HOST_RUN_BIND_RECEIPT_OPERATION = "host_run.bind_receipt"
HOST_RUN_INSPECT_OPERATION = "host_run.inspect"

BLAKE3_DIGEST_PATTERN = re.compile(r"blake3:[0-9a-f]{64}")
# P2 accepts the bare hex or the `blake3:`-prefixed form for OwnerLog event digests.
OWNER_EVENT_DIGEST_PATTERN = re.compile(r"(?:blake3:)?[0-9a-f]{64}")
DECIMAL_PATTERN = re.compile(r"[0-9]{1,19}")

# The complete typed UNKNOWN-reason catalogue produced by
# `ManagedSnapshot::reconcile_host_run` and the HostKernel `host_run.inspect`
# route (kernel/src/managed_control.rs). Frozen here so a response carrying any
# other reason — or none at all — is treated as ambiguous instead of being
# quietly accepted. No reason in this catalogue may ever authorize redispatch.
HOST_RUN_UNKNOWN_REASONS = (
    "host_run_binding_absent",
    "host_run_binding_identity_mismatch",
    "host_run_effect_projection_unavailable",
    "host_run_effect_projection_incomplete",
    "host_run_effect_projection_identity_mismatch",
    "host_run_effect_projection_ambiguous",
    "host_run_managed_terminal_unsettled",
    "host_run_task_unverified",
    "host_run_attempt_unknown",
    "host_run_attempt_receipt_missing",
    "host_run_binding_receipt_missing",
    "host_run_verifier_evidence_missing",
    "host_run_verifier_pins_unavailable",
    "host_run_p8_owner_receipt_missing",
    "host_run_p8_settlement_missing",
)
HOST_RUN_BINDING_ABSENT = "host_run_binding_absent"
HOST_RUN_TERMINAL_STATUSES = ("SUCCEEDED", "FAILED", "CANCELLED")
HOST_RUN_OUTCOME_STATUSES = ("PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY")

# Which terminal host status corroborates which persisted evaluator row.
# PASS_VERIFIED may only be corroborated by SUCCEEDED — never by FAILED or
# CANCELLED. FAIL_UNVERIFIED requires FAILED: a cancelled Attempt does not
# evidence a failed verification. UNSUPPORTED_CAPABILITY is never a scoring
# status, so either non-success terminal corroborates it; it still never
# releases a PASS.
HOST_RUN_RECONCILIATION_STATUS_FOR_OUTCOME = {
    "PASS_VERIFIED": ("SUCCEEDED",),
    "FAIL_UNVERIFIED": ("FAILED",),
    "UNSUPPORTED_CAPABILITY": ("FAILED", "CANCELLED"),
}

# Exact field sets published by the Rust route handlers (strict_fields()).
HOST_RUN_BIND_BODY_FIELDS = (
    "goalID", "attemptID", "dispatchKeyDigest", "manifestDigest",
    "evaluatorTaskId", "armId", "taskGroup",
)
HOST_RUN_BIND_RECEIPT_BODY_FIELDS = (
    "goalID", "dispatchKeyDigest", "bindingDigest",
    "ownerLogID", "ownerLogSequence", "ownerLogEventDigest",
)
HOST_RUN_INSPECT_BODY_FIELDS = ("goalID", "dispatchKeyDigest")

# `HostRunDispatchBindingV1::value()` — 21 preimage fields plus bindingDigest.
HOST_RUN_BINDING_FIELDS = (
    "schemaVersion", "dispatchKeyDigest", "manifestDigest", "evaluatorTaskId",
    "armId", "taskGroup", "runId", "managedTaskId", "attemptId",
    "evaluationSessionId", "coreProcessGeneration", "ownerId", "ownerEpoch",
    "workerExecutionId", "delegationBindingDigest", "acceptedSpecDigest",
    "providerSelectionDigest", "workspaceBindingDigest",
    "admittedWorkspaceRevision", "attemptScopeDigest",
    "ownerPrincipalBindingDigest", "bindingDigest",
)
HOST_RUN_BINDING_DIGEST_FIELDS = (
    "dispatchKeyDigest", "manifestDigest", "delegationBindingDigest",
    "acceptedSpecDigest", "providerSelectionDigest", "workspaceBindingDigest",
    "attemptScopeDigest", "ownerPrincipalBindingDigest", "bindingDigest",
)
HOST_RUN_BINDING_ID_FIELDS = (
    "evaluatorTaskId", "armId", "taskGroup", "runId", "managedTaskId",
    "attemptId", "evaluationSessionId", "ownerId", "workerExecutionId",
)
# `HostRunDispatchBindingReceiptV1::value()`.
HOST_RUN_BINDING_RECEIPT_FIELDS = (
    "schemaVersion", "dispatchKeyDigest", "bindingDigest", "ownerLogSequence",
    "ownerLogEventDigest", "bindingManagedRevision",
)
# `HostRunDispatchP8OwnerReceiptV1::value()`.
HOST_RUN_P8_OWNER_RECEIPT_FIELDS = (
    "schemaVersion", "dispatchKeyDigest", "bindingDigest", "ownerLogID",
    "ownerLogSequence", "ownerLogEventDigest",
)
HOST_RUN_RECONCILIATION_FIELDS = (
    "schemaVersion", "dispatchKeyDigest", "status", "unknownReason", "binding",
    "bindingDigest", "attemptReceiptDigest", "verifiedRevision",
)


class HostRunReconciliationBlocked(EvalError):
    """A persisted or in-flight dispatch key could not be exactly resolved.

    Raised instead of reusing, skipping or redispatching an ambiguous key.
    Always fail-closed: the caller keeps the run blocked and journals UNKNOWN.
    """

    def __init__(self, message: str, reason: str | None = None):
        super().__init__(message)
        self.reason = reason


def host_run_manifest_digest(manifest: Mapping) -> str:
    """BLAKE3 of the canonical frozen manifest bytes sent to `host_run.bind`."""
    return "blake3:" + blake3.blake3(canonical_json(dict(manifest))).hex()


def host_run_dispatch_key_digest(dispatch_idempotency_key: str) -> str:
    """BLAKE3 of the raw dispatch idempotency key; the raw key is never sent."""
    return blake3.blake3_digest(_token(dispatch_idempotency_key, "dispatchIdempotencyKey"))


def host_run_dispatch_key(manifest_digest: str, task_id: str, arm_id: str) -> str:
    """Canonical per-pair dispatch idempotency key (rebuildable from a journal row)."""
    return digest({"manifestDigest": manifest_digest, "taskId": task_id,
                   "armId": arm_id, "lane": "HUP_PAIRED_HOST_RUN_V1"})


def _require_exact_fields(value, fields, what: str) -> dict:
    if type(value) is not dict:
        raise EvalError(f"{what} must be a plain JSON object")
    if set(value) != set(fields):
        raise EvalError(f"{what} fields differ from the frozen HostRun contract")
    return value


def _require_schema_version(value: Mapping, what: str) -> None:
    version = value.get("schemaVersion")
    if type(version) is not int or version != 1:
        raise EvalError(f"{what} schema version is unsupported")


def _require_blake3(value, what: str) -> str:
    if not isinstance(value, str) or BLAKE3_DIGEST_PATTERN.fullmatch(value) is None:
        raise EvalError(f"{what} must be a canonical blake3 digest")
    return value


def _require_id(value, what: str) -> str:
    return _token(value, what)


def _require_decimal(value, what: str, *, nonzero: bool = True) -> str:
    if not isinstance(value, str) or DECIMAL_PATTERN.fullmatch(value) is None:
        raise EvalError(f"{what} must be a canonical decimal string")
    if nonzero and int(value) == 0:
        raise EvalError(f"{what} must be positive")
    return value


def _require_owner_event_digest(value, what: str) -> str:
    if not isinstance(value, str) or OWNER_EVENT_DIGEST_PATTERN.fullmatch(value) is None:
        raise EvalError(f"{what} is not an OwnerLog event digest")
    return value


def host_run_bind_body(*, goal_id: str, attempt_id: str, dispatch_key_digest: str,
                       manifest_digest: str, evaluator_task_id: str, arm_id: str,
                       task_group: str) -> dict:
    """Strict `managed.v1/host_run.bind` request body (exactly seven fields)."""
    body = {
        "goalID": _require_id(goal_id, "hostRun.goalID"),
        "attemptID": _require_id(attempt_id, "hostRun.attemptID"),
        "dispatchKeyDigest": _require_blake3(dispatch_key_digest, "hostRun.dispatchKeyDigest"),
        "manifestDigest": _require_blake3(manifest_digest, "hostRun.manifestDigest"),
        "evaluatorTaskId": _require_id(evaluator_task_id, "hostRun.evaluatorTaskId"),
        "armId": _require_id(arm_id, "hostRun.armId"),
        "taskGroup": _require_id(task_group, "hostRun.taskGroup"),
    }
    return _require_exact_fields(body, HOST_RUN_BIND_BODY_FIELDS, "hostRun.bind body")


def host_run_bind_receipt_body(*, goal_id: str, dispatch_key_digest: str,
                               binding_digest: str, owner_log_id: str,
                               owner_log_sequence: str,
                               owner_log_event_digest: str) -> dict:
    """Strict `managed.v1/host_run.bind_receipt` body (exactly six fields).

    The OwnerLog cursor facts come from the P8 post-commit append receipt, never
    from an event body.
    """
    body = {
        "goalID": _require_id(goal_id, "hostRun.goalID"),
        "dispatchKeyDigest": _require_blake3(dispatch_key_digest, "hostRun.dispatchKeyDigest"),
        "bindingDigest": _require_blake3(binding_digest, "hostRun.bindingDigest"),
        "ownerLogID": _require_id(owner_log_id, "hostRun.ownerLogID"),
        "ownerLogSequence": _require_decimal(owner_log_sequence, "hostRun.ownerLogSequence"),
        "ownerLogEventDigest": _require_owner_event_digest(
            owner_log_event_digest, "hostRun.ownerLogEventDigest"),
    }
    return _require_exact_fields(body, HOST_RUN_BIND_RECEIPT_BODY_FIELDS,
                                 "hostRun.bind_receipt body")


def host_run_inspect_body(*, goal_id: str, dispatch_key_digest: str) -> dict:
    """Strict `managed.v1/host_run.inspect` body (exactly two fields)."""
    body = {
        "goalID": _require_id(goal_id, "hostRun.goalID"),
        "dispatchKeyDigest": _require_blake3(dispatch_key_digest, "hostRun.dispatchKeyDigest"),
    }
    return _require_exact_fields(body, HOST_RUN_INSPECT_BODY_FIELDS, "hostRun.inspect body")


def _validate_host_run_binding(value, what: str) -> dict:
    binding = _require_exact_fields(value, HOST_RUN_BINDING_FIELDS, what)
    _require_schema_version(binding, what)
    for field in HOST_RUN_BINDING_DIGEST_FIELDS:
        _require_blake3(binding[field], f"{what}.{field}")
    for field in HOST_RUN_BINDING_ID_FIELDS:
        _require_id(binding[field], f"{what}.{field}")
    for field in ("coreProcessGeneration", "ownerEpoch"):
        _require_decimal(binding[field], f"{what}.{field}")
    _require_id(binding["admittedWorkspaceRevision"], f"{what}.admittedWorkspaceRevision")
    return binding


def parse_host_run_bind_response(value, *, dispatch_key_digest: str,
                                 manifest_digest: str) -> tuple[dict, dict]:
    """Validate `host_run.bind`'s `{schemaVersion, binding, receipt}` reply."""
    response = _require_exact_fields(
        value, ("schemaVersion", "binding", "receipt"), "hostRun.bind response")
    _require_schema_version(response, "hostRun.bind response")
    binding = _validate_host_run_binding(response["binding"], "hostRun.bind binding")
    receipt = _require_exact_fields(
        response["receipt"], HOST_RUN_BINDING_RECEIPT_FIELDS, "hostRun.bind receipt")
    _require_schema_version(receipt, "hostRun.bind receipt")
    _require_blake3(receipt["dispatchKeyDigest"], "hostRun.bind receipt.dispatchKeyDigest")
    _require_blake3(receipt["bindingDigest"], "hostRun.bind receipt.bindingDigest")
    _require_decimal(receipt["ownerLogSequence"], "hostRun.bind receipt.ownerLogSequence")
    _require_owner_event_digest(receipt["ownerLogEventDigest"],
                                "hostRun.bind receipt.ownerLogEventDigest")
    _require_decimal(receipt["bindingManagedRevision"],
                     "hostRun.bind receipt.bindingManagedRevision")
    if binding["dispatchKeyDigest"] != dispatch_key_digest:
        raise EvalError("host_run.bind returned a binding for a different dispatch key")
    if binding["manifestDigest"] != manifest_digest:
        raise EvalError("host_run.bind returned a binding for a different manifest")
    if receipt["dispatchKeyDigest"] != dispatch_key_digest:
        raise EvalError("host_run.bind receipt names a different dispatch key")
    if receipt["bindingDigest"] != binding["bindingDigest"]:
        raise EvalError("host_run.bind receipt names a different binding")
    return binding, receipt


def parse_host_run_bind_receipt_response(value, *, dispatch_key_digest: str,
                                         binding_digest: str) -> dict:
    """Validate `host_run.bind_receipt`'s `{schemaVersion, status, receipt}` reply."""
    response = _require_exact_fields(
        value, ("schemaVersion", "status", "receipt"), "hostRun.bind_receipt response")
    _require_schema_version(response, "hostRun.bind_receipt response")
    if response["status"] != "RECORDED":
        raise EvalError("host_run.bind_receipt did not record the post-commit receipt")
    receipt = _require_exact_fields(
        response["receipt"], HOST_RUN_P8_OWNER_RECEIPT_FIELDS,
        "hostRun.bind_receipt receipt")
    _require_schema_version(receipt, "hostRun.bind_receipt receipt")
    _require_blake3(receipt["dispatchKeyDigest"], "hostRun.bind_receipt receipt.dispatchKeyDigest")
    _require_blake3(receipt["bindingDigest"], "hostRun.bind_receipt receipt.bindingDigest")
    _require_id(receipt["ownerLogID"], "hostRun.bind_receipt receipt.ownerLogID")
    _require_decimal(receipt["ownerLogSequence"], "hostRun.bind_receipt receipt.ownerLogSequence")
    _require_owner_event_digest(receipt["ownerLogEventDigest"],
                                "hostRun.bind_receipt receipt.ownerLogEventDigest")
    if receipt["dispatchKeyDigest"] != dispatch_key_digest:
        raise EvalError("host_run.bind_receipt names a different dispatch key")
    if receipt["bindingDigest"] != binding_digest:
        raise EvalError("host_run.bind_receipt names a different binding")
    return receipt


def parse_host_run_inspect_response(value, *, dispatch_key_digest: str) -> dict:
    """Validate `host_run.inspect`'s `HostRunReconciliationV1` reply.

    Null fields are omitted by the route, so absent keys are expected. A
    terminal status must carry no unknown reason; an UNKNOWN status must carry
    one of the frozen typed reasons; a status outside the four published values
    or an unrecognised reason is rejected rather than trusted.
    """
    if type(value) is not dict:
        raise EvalError("hostRun.inspect response must be a plain JSON object")
    if set(value) - set(HOST_RUN_RECONCILIATION_FIELDS):
        raise EvalError("hostRun.inspect response carries fields outside the frozen contract")
    reconciliation = dict(value)
    _require_schema_version(reconciliation, "hostRun.inspect response")
    status = reconciliation.get("status")
    if status not in ("SUCCEEDED", "FAILED", "CANCELLED", "UNKNOWN"):
        raise EvalError("hostRun.inspect response status is invalid")
    if reconciliation.get("dispatchKeyDigest") != dispatch_key_digest:
        raise EvalError("hostRun.inspect resolved a different dispatch key")
    reason = reconciliation.get("unknownReason")
    if status == "UNKNOWN":
        if reason not in HOST_RUN_UNKNOWN_REASONS:
            raise EvalError("hostRun.inspect UNKNOWN status carries an unrecognised reason")
    elif reason is not None:
        raise EvalError("hostRun.inspect terminal status carries an unknown reason")
    binding = reconciliation.get("binding")
    if binding is not None:
        binding = _validate_host_run_binding(binding, "hostRun.inspect binding")
        if binding["dispatchKeyDigest"] != dispatch_key_digest:
            raise EvalError("hostRun.inspect binding names a different dispatch key")
        reconciliation["binding"] = binding
    digest_value = reconciliation.get("bindingDigest")
    if digest_value is not None:
        _require_blake3(digest_value, "hostRun.inspect bindingDigest")
        if binding is None:
            raise EvalError("hostRun.inspect returned a binding digest without a binding")
        if digest_value != binding["bindingDigest"]:
            raise EvalError("hostRun.inspect binding digest disagrees with its binding")
    for field in ("attemptReceiptDigest", "verifiedRevision"):
        present = reconciliation.get(field)
        if present is not None:
            _require_id(present, f"hostRun.inspect {field}")
    return reconciliation


class HostRunTransport(Protocol):
    """RPC seam to the authenticated HostKernel; no implementation is installed."""

    def call(self, service: str, operation: str, body: Mapping) -> Mapping: ...


class HostRunOwnerLog(Protocol):
    """P8 OwnerLog append seam for the mirrored `HostRunDispatchBoundV1` event.

    The Rust append (P8 `worker_durable`) is not compiled into any Python
    path; it must return the *receipt* facts derived from the committed
    OwnerLog cursor, which this consumer then submits through
    `host_run.bind_receipt`. A caller-supplied cursor is never accepted here.
    """

    def append_dispatch_bound(self, binding: Mapping, binding_digest: str) -> Mapping: ...


@dataclass(frozen=True)
class HostRunDispatchHandleV1:
    """Host-derived Goal/Attempt identity for one pair, reported by the bridge."""

    goal_id: str
    attempt_id: str


class HostRunControlPlaneClient:
    """Typed consumer for the three HostRun routes with strict bodies/replies."""

    def __init__(self, transport: HostRunTransport, goal_id: str):
        if not callable(getattr(transport, "call", None)):
            raise EvalError("HostRun transport is unavailable")
        self._transport = transport
        self.goal_id = _require_id(goal_id, "hostRun.goalID")

    def _call(self, operation: str, body: Mapping) -> Mapping:
        try:
            response = self._transport.call(MANAGED_SERVICE_ID, operation, dict(body))
        except EvalError:
            raise
        except Exception as exc:
            raise EvalError(
                f"host_run route {operation} failed: {type(exc).__name__}") from exc
        if not isinstance(response, Mapping):
            raise EvalError(f"host_run route {operation} returned a non-object response")
        return dict(response)

    def bind(self, *, attempt_id: str, dispatch_key_digest: str, manifest_digest: str,
             evaluator_task_id: str, arm_id: str, task_group: str) -> tuple[dict, dict]:
        body = host_run_bind_body(
            goal_id=self.goal_id, attempt_id=attempt_id,
            dispatch_key_digest=dispatch_key_digest, manifest_digest=manifest_digest,
            evaluator_task_id=evaluator_task_id, arm_id=arm_id, task_group=task_group)
        return parse_host_run_bind_response(
            self._call(HOST_RUN_BIND_OPERATION, body),
            dispatch_key_digest=dispatch_key_digest, manifest_digest=manifest_digest)

    def commit_owner_receipt(self, *, dispatch_key_digest: str, binding_digest: str,
                             owner_receipt: Mapping) -> dict:
        receipt = _require_exact_fields(
            owner_receipt,
            ("ownerLogID", "ownerLogSequence", "ownerLogEventDigest"),
            "P8 OwnerLog post-commit receipt")
        body = host_run_bind_receipt_body(
            goal_id=self.goal_id, dispatch_key_digest=dispatch_key_digest,
            binding_digest=binding_digest,
            owner_log_id=receipt["ownerLogID"],
            owner_log_sequence=receipt["ownerLogSequence"],
            owner_log_event_digest=receipt["ownerLogEventDigest"])
        return parse_host_run_bind_receipt_response(
            self._call(HOST_RUN_BIND_RECEIPT_OPERATION, body),
            dispatch_key_digest=dispatch_key_digest, binding_digest=binding_digest)

    def inspect(self, dispatch_key_digest: str) -> dict:
        body = host_run_inspect_body(goal_id=self.goal_id,
                                     dispatch_key_digest=dispatch_key_digest)
        return parse_host_run_inspect_response(
            self._call(HOST_RUN_INSPECT_OPERATION, body),
            dispatch_key_digest=dispatch_key_digest)


def host_run_binding_is_absent(reconciliation: Mapping, dispatch_key_digest: str) -> bool:
    """True only for the exact typed "this key was never bound" resolution.

    Anything else — a present binding, a different key, an unrecognised shape —
    means the key may already have been dispatched and must not be redispatched.
    """
    return (
        isinstance(reconciliation, Mapping)
        and reconciliation.get("status") == "UNKNOWN"
        and reconciliation.get("unknownReason") == HOST_RUN_BINDING_ABSENT
        and reconciliation.get("dispatchKeyDigest") == dispatch_key_digest
        and not reconciliation.get("binding")
        and not reconciliation.get("bindingDigest")
        and not reconciliation.get("attemptReceiptDigest")
        and not reconciliation.get("verifiedRevision")
    )


def _require_exact_terminal_resolution(reconciliation, *, dispatch_key_digest: str,
                                       expected_statuses, manifest_digest: str,
                                       task_id: str, arm_id: str, task_group: str,
                                       workspace_revision, context: str) -> None:
    """Release a dispatch key only on an exact, fully pinned terminal resolution."""
    detail = None
    try:
        parsed = parse_host_run_inspect_response(
            reconciliation, dispatch_key_digest=dispatch_key_digest)
    except EvalError as exc:
        detail = str(exc)
        parsed = None
    if parsed is not None:
        status = parsed.get("status")
        if status not in HOST_RUN_TERMINAL_STATUSES:
            detail = f"resolution is {status} with reason "\
                     f"{parsed.get('unknownReason')!r}"
        elif status not in expected_statuses:
            detail = f"resolution {status} does not corroborate the persisted row"
        else:
            binding = parsed.get("binding")
            if binding is None or parsed.get("bindingDigest") is None:
                detail = "terminal resolution carries no binding"
            elif binding.get("manifestDigest") != manifest_digest:
                detail = "binding names a different manifest"
            elif (binding.get("evaluatorTaskId") != task_id
                    or binding.get("armId") != arm_id
                    or binding.get("taskGroup") != task_group):
                detail = "binding names a different task/arm/group"
            elif not parsed.get("attemptReceiptDigest"):
                detail = "terminal resolution carries no Attempt receipt digest"
            elif status == "SUCCEEDED":
                verified = parsed.get("verifiedRevision")
                if not isinstance(verified, str) or not verified:
                    detail = "SUCCEEDED resolution carries no verified revision"
                elif workspace_revision is None:
                    detail = "persisted row records no final workspace revision"
                elif verified != workspace_revision:
                    detail = "verified revision differs from the recorded final revision"
    if detail is not None:
        raise HostRunReconciliationBlocked(
            f"{context} ({detail})",
            reason=str(parsed.get("unknownReason")) if parsed else None,
        )


def host_run_row_dispatch_key(manifest_digest: str, row: Mapping,
                              context: str) -> str:
    """Rebuild the canonical dispatch key for a persisted row, exactly.

    The row's own recorded key, when present, must agree with the frozen
    pair identity; a disagreement is a foreign row and stays blocked.
    """
    task_id = _require_id(row.get("taskId"), "journal.taskId")
    arm_id = _require_id(row.get("armId"), "journal.armId")
    expected = host_run_dispatch_key(manifest_digest, task_id, arm_id)
    recorded = row.get("dispatchIdempotencyKey")
    if recorded is not None and recorded != expected:
        raise HostRunReconciliationBlocked(
            f"{context} (recorded dispatch key differs from the frozen pair identity)")
    return expected


def reconcile_persisted_host_run_outcome(control_plane, manifest: Mapping,
                                         manifest_digest: str, row: Mapping) -> None:
    """Resolve a persisted PASS/FAIL/UNSUPPORTED row through `host_run.inspect`.

    Only an exact terminal resolution releases the row for reuse. Everything
    else — missing, stale, foreign, duplicate, conflicting or ambiguous
    evidence, an unavailable route, or an exception — keeps the run blocked and
    never redispatches.
    """
    context = "persisted HostRun outcome requires authenticated reconciliation before reuse"
    status = row.get("status")
    if status not in HOST_RUN_OUTCOME_STATUSES:
        raise HostRunReconciliationBlocked(f"{context} (row status {status!r})")
    dispatch_key = host_run_row_dispatch_key(manifest_digest, row, context)
    dispatch_key_digest = host_run_dispatch_key_digest(dispatch_key)
    task_id = row["taskId"]
    try:
        task_group = (row.get("taskGroup")
                      or next(task["taskGroup"] for task in manifest["tasks"]
                              if task["taskId"] == task_id))
    except StopIteration as exc:
        raise HostRunReconciliationBlocked(
            f"{context} (row names a task outside the frozen manifest)") from exc
    try:
        reconciliation = control_plane.inspect(dispatch_key_digest)
    except HostRunReconciliationBlocked:
        raise
    except Exception as exc:
        raise HostRunReconciliationBlocked(
            f"{context} (host_run.inspect failed: {type(exc).__name__})") from exc
    _require_exact_terminal_resolution(
        reconciliation,
        dispatch_key_digest=dispatch_key_digest,
        expected_statuses=HOST_RUN_RECONCILIATION_STATUS_FOR_OUTCOME[status],
        manifest_digest=host_run_manifest_digest(manifest),
        task_id=task_id,
        arm_id=row["armId"],
        task_group=task_group,
        workspace_revision=row.get("workspaceRevision"),
        context=context,
    )


def _begin_host_run_dispatch(control_plane, owner_log, bridge, invocation, manifest,
                             task_pin, arm_pin, dispatch_key_digest: str) -> None:
    """Pre-dispatch append: reconcile → bind → P8 OwnerLog mirror → post-commit.

    Reconciling *before* anything else is what makes a crashed or restarted
    sibling safe: a key that already carries a durable binding is possibly
    dispatched and raises instead of binding or dispatching a second time.
    Nothing here is dispatched; HostRun dispatch happens only after the
    post-commit receipt is durable.
    """
    reconciliation = control_plane.inspect(dispatch_key_digest)
    if not host_run_binding_is_absent(reconciliation, dispatch_key_digest):
        raise HostRunReconciliationBlocked(
            "a durable HostRun binding already exists for this dispatch key; "
            "a possibly-dispatched key is never redispatched",
            reason=(reconciliation.get("unknownReason")
                    if isinstance(reconciliation, Mapping) else None))
    handle = bridge.prepare_dispatch(invocation)
    if not isinstance(handle, HostRunDispatchHandleV1):
        raise EvalError("HostRun bridge prepare_dispatch must return a HostRunDispatchHandleV1")
    if handle.goal_id != control_plane.goal_id:
        raise EvalError("HostRun dispatch handle names a foreign Goal")
    binding, receipt = control_plane.bind(
        attempt_id=handle.attempt_id,
        dispatch_key_digest=dispatch_key_digest,
        manifest_digest=host_run_manifest_digest(manifest),
        evaluator_task_id=task_pin["taskId"],
        arm_id=arm_pin["id"],
        task_group=task_pin["taskGroup"],
    )
    # The OwnerLog cursor/event digest comes from this separate post-commit
    # receipt, never from the event body itself.
    owner_receipt = owner_log.append_dispatch_bound(binding, receipt["bindingDigest"])
    control_plane.commit_owner_receipt(
        dispatch_key_digest=dispatch_key_digest,
        binding_digest=receipt["bindingDigest"],
        owner_receipt=owner_receipt,
    )


def _resolve_host_run_dispatch(control_plane, row: Mapping, outcome, manifest,
                               invocation, dispatch_key_digest: str) -> str:
    """Post-dispatch resolve: a non-exact terminal resolution demotes to UNKNOWN."""
    context = "HostRun dispatch requires an exact terminal reconciliation"
    try:
        reconciliation = control_plane.inspect(dispatch_key_digest)
    except HostRunReconciliationBlocked:
        raise
    except Exception as exc:
        raise HostRunReconciliationBlocked(
            f"{context} (host_run.inspect failed: {type(exc).__name__})") from exc
    _require_exact_terminal_resolution(
        reconciliation,
        dispatch_key_digest=dispatch_key_digest,
        expected_statuses=HOST_RUN_RECONCILIATION_STATUS_FOR_OUTCOME[row["status"]],
        manifest_digest=host_run_manifest_digest(manifest),
        task_id=row["taskId"],
        arm_id=row["armId"],
        task_group=row["taskGroup"],
        workspace_revision=outcome.workspace_revision,
        context=context,
    )
    return dispatch_key_digest


def run_host_paired_evaluation(
    manifest: Mapping,
    bridge: HostRunBridge,
    task_resolver: TaskImageResolver,
    artifact_path: Path,
    control_plane: HostRunControlPlaneClient | None = None,
    owner_log: HostRunOwnerLog | None = None,
) -> EvaluationResult:
    """Run paired tasks only through authenticated HostRun; never call providers directly.

    This source interface is intentionally not exposed by ``main``. Its real
    bridge remains unavailable until authenticated P1/P2 HostRun and independent
    verifier integration lands. Its reports can inform development but never become
    official benchmark or release claims automatically.

    When ``control_plane`` (or ``bridge.control_plane``) is supplied, every pair
    goes through the published HostRun sequence — pre-dispatch
    ``host_run.inspect`` reconciliation, ``host_run.bind`` append, P8 OwnerLog
    mirror append, ``host_run.bind_receipt`` post-commit, dispatch, then a
    resolving ``host_run.inspect``. A persisted PASS/FAIL/UNSUPPORTED row is
    reused only after ``host_run.inspect`` returns an exact terminal resolution;
    every other outcome keeps the run blocked and never redispatches. Without a
    control plane the runner behaves exactly as before and stays non-authoritative.
    """
    frozen = json.loads(canonical_json(dict(manifest)))
    validate_manifest(frozen)
    if frozen.get("fakeSelfcheck") is True:
        raise EvalError("fake self-check manifests cannot be used by the HostRun runner")
    if not callable(getattr(bridge, "dispatch_guarded_trial", None)):
        raise EvalError("authenticated HostRun bridge is unavailable")
    if not callable(getattr(task_resolver, "resolve_task", None)):
        raise EvalError("repository-local task image resolver is unavailable")
    control = control_plane if control_plane is not None else getattr(
        bridge, "control_plane", None)
    if control is not None:
        if not all(callable(getattr(control, name, None))
                   for name in ("bind", "commit_owner_receipt", "inspect")):
            raise EvalError(
                "HostRun control plane must expose bind, commit_owner_receipt and inspect")
        if owner_log is None:
            owner_log = getattr(bridge, "owner_log", None)
        if not callable(getattr(owner_log, "append_dispatch_bound", None)):
            raise EvalError(
                "P8 OwnerLog append seam for HostRunDispatchBoundV1 is unavailable")
        if not callable(getattr(bridge, "prepare_dispatch", None)):
            raise EvalError(
                "HostRun bridge cannot supply the host-derived dispatch handle")
    frozen_digest = digest(frozen)
    shared_digest = digest(frozen["shared"])
    tasks = {task["taskId"]: task for task in frozen["tasks"]}
    arms = {arm["id"]: arm for arm in frozen["arms"]}
    journal = _ArtifactJournal(artifact_path, frozen, frozen_digest, mode="HOST_RUN_PAIRED")
    try:
        plan = paired_call_plan(frozen)
        plan_keys = set(plan)
        existing_keys = {(row.get("taskId"), row.get("armId")) for row in journal.records}
        if not existing_keys.issubset(plan_keys):
            raise EvalError("HostRun artifact contains trial rows outside this frozen paired plan")
        outcome_rows = [row for row in journal.records
                        if row.get("status") in HOST_RUN_OUTCOME_STATUSES]
        if outcome_rows:
            if control is None:
                raise EvalError(
                    "persisted HostRun outcome requires authenticated reconciliation before reuse"
                )
            for row in outcome_rows:
                reconcile_persisted_host_run_outcome(control, frozen, frozen_digest, row)
        stopped = next((row for row in journal.records if row.get("status") in {
            "CANCELLED", "INFRASTRUCTURE_FAILURE", "NOT_RUN", "UNKNOWN"
        }), None)
        dispatch_field = "hostRunDispatchIndex"
        call_indexes = [row[dispatch_field] for row in journal.records
                        if isinstance(row.get(dispatch_field), int)]
        call_index = max(call_indexes, default=-1) + 1
        for task_id, arm_id in plan:
            if (task_id, arm_id) in existing_keys:
                continue
            task_pin = tasks[task_id]
            arm_pin = arms[arm_id]
            if stopped is not None:
                journal.append({"taskId": task_id, "taskGroup": task_pin["taskGroup"],
                                "armId": arm_id, "manifestDigest": frozen_digest,
                                "status": "NOT_RUN", "dispatchStarted": False,
                                "failureClass": "infrastructure", "stopReason": stopped["status"],
                                "mode": "HOST_RUN_PAIRED"})
                continue
            if frozen.get("cancelAfterCalls", 0) > 0 and call_index >= frozen["cancelAfterCalls"]:
                cancelled = {"taskId": task_id, "taskGroup": task_pin["taskGroup"],
                             "armId": arm_id, "manifestDigest": frozen_digest,
                             "status": "CANCELLED", "dispatchStarted": False,
                             "failureClass": "infrastructure", "mode": "HOST_RUN_PAIRED"}
                journal.append(cancelled)
                existing_keys.add((task_id, arm_id))
                stopped = cancelled
                continue
            local_task = task_resolver.resolve_task(task_id)
            if not isinstance(local_task, Mapping):
                raise EvalError("resolved local task input is malformed or oversized")
            if type(local_task) is not dict:
                raise EvalError("resolved local task must be a plain JSON object")
            task_bytes = bounded_canonical_json(local_task, MAX_TASK_INPUT_BYTES)
            if "sha256:" + hashlib.sha256(task_bytes).hexdigest() != task_pin["inputDigest"]:
                raise EvalError("resolved task input differs from its frozen digest")
            task_envelope = json.loads(task_bytes.decode("utf-8", errors="strict"))
            if (task_envelope.get("taskId") != task_id
                    or task_envelope.get("taskGroup") != task_pin["taskGroup"]
                    or set(task_envelope) != {"taskId", "taskGroup", "input"}):
                raise EvalError("resolved task group differs from frozen manifest")
            invocation = HostRunInvocationV1(
                frozen_digest, shared_digest,
                host_run_dispatch_key(frozen_digest, task_id, arm_id),
                call_index, task_envelope,
                dict(arm_pin), dict(frozen["shared"]),
            )
            journal.assert_current()
            dispatch_key_digest = (
                host_run_dispatch_key_digest(invocation.dispatch_idempotency_key)
                if control is not None else None)
            try:
                if control is not None:
                    _begin_host_run_dispatch(
                        control, owner_log, bridge, invocation, frozen, task_pin, arm_pin,
                        dispatch_key_digest)
                outcome = bridge.dispatch_guarded_trial(invocation)
                status, row = _validate_host_run_outcome(outcome, invocation, frozen, task_pin, arm_pin)
                if control is not None:
                    row["hostRunDispatchKeyDigest"] = _resolve_host_run_dispatch(
                        control, row, outcome, frozen, invocation, dispatch_key_digest)
            except Exception as exc:
                row = {"taskId": task_id, "taskGroup": task_pin["taskGroup"],
                       "armId": arm_id, "manifestDigest": frozen_digest,
                       # The HostRun flow was entered (a binding may exist), so
                       # dispatch may have happened. Treat the result as
                       # UNKNOWN and never retry this pair.
                       "status": "UNKNOWN", "failureClass": "unknown",
                       "errorType": type(exc).__name__, "dispatchStarted": True,
                       "hostRunDispatchIndex": call_index,
                       "dispatchIdempotencyKey": invocation.dispatch_idempotency_key,
                       "mode": "HOST_RUN_PAIRED"}
                if dispatch_key_digest is not None:
                    row["hostRunDispatchKeyDigest"] = dispatch_key_digest
                if isinstance(exc, HostRunReconciliationBlocked) and exc.reason:
                    row["hostRunUnknownReason"] = exc.reason
                status = row["status"]
            journal.append(row)
            existing_keys.add((task_id, arm_id))
            call_index += 1
            if status in {"CANCELLED", "INFRASTRUCTURE_FAILURE", "UNKNOWN"}:
                stopped = row
        artifact_digest = journal.digest()
        return EvaluationResult(tuple(journal.records), artifact_digest, mode="HOST_RUN_PAIRED")
    except Exception:
        journal.close()
        raise


def evaluation_report(result: EvaluationResult, manifest: Mapping) -> dict:
    """Attach required run provenance to a non-authoritative paired summary."""
    validate_manifest(dict(manifest))
    manifest_digest = digest(dict(manifest))
    return {
        "schema": "horizoncode.eval.report.v1",
        "runId": manifest["runId"],
        "mode": result.mode,
        "officialScoreEligible": False,
        "authorityStatus": ("HOST_RUN_ADAPTER_UNATTESTED" if result.mode == "HOST_RUN_PAIRED"
                             else "FAKE_SELF_CHECK_ONLY"),
        "capturedAt": datetime.now(timezone.utc).isoformat(),
        "platform": {"system": platform.system(), "machine": platform.machine()},
        "manifestDigest": manifest_digest,
        "rawArtifactDigest": result.artifact_digest,
        "benchmark": manifest["benchmark"],
        "lane": manifest["lane"],
        "taskIds": [task["taskId"] for task in manifest["tasks"]],
        "taskPartitions": manifest["taskPartitions"],
        "comparison": manifest["comparison"],
        "arms": manifest["arms"],
        "sharedConfiguration": manifest["shared"],
        "seed": manifest.get("seed"),
        "failurePolicy": manifest["failurePolicy"],
        "exclusionPolicy": manifest["exclusionPolicy"],
        "summary": summarize_pairs(result.records, manifest),
    }


def paired_call_plan(manifest: Mapping, seed: int | None = None) -> list[tuple[str, str]]:
    """Return a deterministic randomized arm order, paired within each task."""
    validate_manifest(dict(manifest))
    frozen_seed = manifest.get("seed")
    if seed is not None and (not isinstance(seed, int) or isinstance(seed, bool)
                             or seed != frozen_seed):
        raise EvalError("arm order seed must match the seed frozen in the manifest")
    chosen_seed = frozen_seed
    if chosen_seed is None:
        raise EvalError("a frozen seed is required for reproducible arm order")
    rng = random.Random(chosen_seed)
    tasks = list(manifest["tasks"])
    rng.shuffle(tasks)
    arm_orders = ["reference_first"] * ((len(tasks) + 1) // 2) + ["candidate_first"] * (len(tasks) // 2)
    rng.shuffle(arm_orders)
    plan = []
    for task, first in zip(tasks, arm_orders, strict=True):
        arm_ids = (manifest["comparison"]["referenceArmId"], manifest["comparison"]["candidateArmId"])
        order = arm_ids if first == "reference_first" else tuple(reversed(arm_ids))
        plan.extend((task["taskId"], arm) for arm in order)
    return plan


def classify_failure(record: Mapping) -> str:
    """Classify only from typed runner/verifier evidence; model text is ignored."""
    status = record.get("status")
    if status in ("CANCELLED", "INFRASTRUCTURE_FAILURE"):
        return "infrastructure"
    if status == "UNKNOWN":
        return "unknown"
    if status == "UNSUPPORTED_CAPABILITY":
        return "unsupported_capability"
    if status == "PASS_VERIFIED":
        return "none"
    stage = record.get("evidenceStage")
    allowed = {"task_interpretation_planning", "context_retrieval", "tool_selection_arguments",
               "effect_execution", "patch_quality", "test_verification", "budget_exhaustion",
               "infrastructure", "security_failure", "unknown"}
    return stage if stage in allowed else "unknown"


def _summarized_cost_provenance(rows: list[dict], reported_cost: int | None) -> str:
    if not rows or reported_cost is None:
        return "UNKNOWN"
    modes = {row.get("mode") for row in rows}
    if modes == {"FAKE_SELF_CHECK"}:
        return "FIXTURE_REPORTED"
    values = {row.get("costProvenance") for row in rows}
    if not values or None in values or "UNKNOWN" in values:
        return "UNKNOWN"
    return next(iter(values)) if len(values) == 1 else "MIXED"


def summarize_pairs(records: list[dict] | tuple[dict, ...], manifest: Mapping) -> dict:
    """Build a paired matrix and repository-cluster interval; points alone are not evidence."""
    validate_manifest(dict(manifest))
    manifest_digest = digest(dict(manifest))
    task_groups = {task["taskId"]: task["taskGroup"] for task in manifest["tasks"]}
    declared_arm_ids = {arm["id"] for arm in manifest["arms"]}
    matrix: dict[str, dict[str, dict]] = {task_id: {} for task_id in task_groups}
    trials = []
    dispatch_indexes = set()
    execution_modes = set()
    for row in records:
        if not isinstance(row, dict):
            raise EvalError("summary records must be objects")
        if row.get("recordType", "trial") != "trial":
            raise EvalError("summary accepts trial rows only")
        task_id, arm_id = row.get("taskId"), row.get("armId")
        if task_id not in matrix or arm_id not in declared_arm_ids:
            raise EvalError("summary contains a task or arm outside the frozen manifest")
        if row.get("manifestDigest") != manifest_digest:
            raise EvalError("summary trial belongs to a different frozen manifest")
        if arm_id in matrix[task_id]:
            raise EvalError("summary contains duplicate task/arm evidence")
        if row.get("status") not in {"PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY",
                                     "CANCELLED", "INFRASTRUCTURE_FAILURE", "NOT_RUN", "UNKNOWN"}:
            raise EvalError("summary contains an unknown trial status")
        if row.get("taskGroup", task_groups[task_id]) != task_groups[task_id]:
            raise EvalError("summary task group differs from the frozen manifest")
        mode = row.get("mode")
        if mode not in {"FAKE_SELF_CHECK", "HOST_RUN_PAIRED"}:
            raise EvalError("summary trial has an unknown execution mode")
        if mode == "HOST_RUN_PAIRED" and row.get("status") in {
            "PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY"
        }:
            _validate_host_run_trial_evidence(row, require_complete=True)
        execution_modes.add(mode)
        for field in ("elapsedMs", "inputTokens", "outputTokens", "toolCalls", "retries",
                      "interventions", "costMicros"):
            metric = row.get(field)
            if metric is not None and (not isinstance(metric, int) or isinstance(metric, bool)
                                       or metric < 0 or metric > 2**63 - 1):
                raise EvalError(f"summary {field} is not a bounded non-negative integer")
        call_index_field = "providerCallIndex" if mode == "FAKE_SELF_CHECK" else "hostRunDispatchIndex"
        call_index = row.get(call_index_field)
        if call_index is not None:
            if (not isinstance(call_index, int) or isinstance(call_index, bool)
                    or call_index < 0 or call_index > 2**63 - 1 or call_index in dispatch_indexes):
                raise EvalError("summary dispatch indexes must be unique bounded non-negative integers")
            dispatch_indexes.add(call_index)
        elif row.get("status") != "NOT_RUN" and not (
                row.get("status") == "CANCELLED" and row.get("dispatchStarted") is False):
            raise EvalError("invoked or ambiguous trial is missing its dispatch index")
        matrix[task_id][arm_id] = {
            "status": row.get("status"),
            "costMicros": row.get("costMicros"),
            "elapsedMs": row.get("elapsedMs"),
        }
        trials.append(row)
    if len(execution_modes) > 1:
        raise EvalError("summary cannot combine fake and HostRun execution modes")
    if dispatch_indexes != set(range(len(dispatch_indexes))):
        raise EvalError("summary dispatch indexes are not a contiguous execution prefix")
    reference_arm = manifest["comparison"]["referenceArmId"]
    candidate_arm = manifest["comparison"]["candidateArmId"]
    eligible = {"PASS_VERIFIED", "FAIL_UNVERIFIED"}
    complete = {task: arms for task, arms in matrix.items()
                if all(arm in arms and arms[arm]["status"] in eligible
                       for arm in (reference_arm, candidate_arm))}
    capability_incomplete = sum(
        any(arm in arms and arms[arm]["status"] == "UNSUPPORTED_CAPABILITY"
            for arm in declared_arm_ids)
        for arms in matrix.values()
    )
    improved = sum(complete[t][candidate_arm]["status"] == "PASS_VERIFIED"
                   and complete[t][reference_arm]["status"] != "PASS_VERIFIED" for t in complete)
    regressed = sum(complete[t][reference_arm]["status"] == "PASS_VERIFIED"
                    and complete[t][candidate_arm]["status"] != "PASS_VERIFIED" for t in complete)
    unchanged = len(complete) - improved - regressed
    denominator = len(complete)
    reference_passes = sum(pair[reference_arm]["status"] == "PASS_VERIFIED" for pair in complete.values())
    candidate_passes = sum(pair[candidate_arm]["status"] == "PASS_VERIFIED" for pair in complete.values())
    is_baseline_comparison = manifest["comparison"]["kind"] == "baseline_vs_full"
    invocation_rows = [row for row in trials if row.get("providerCallIndex") is not None
                       or row.get("hostRunDispatchIndex") is not None]

    def sum_known_nonnegative(field: str):
        values = [row.get(field) for row in invocation_rows]
        valid = all(
            isinstance(value, int)
            and not isinstance(value, bool) and value >= 0
            for value in values
        )
        return sum(values) if values and valid else None

    # Accounting is reported across every invoked arm, including incomplete pairs.
    # Omitting failed/incomplete work would understate the evaluation's resource cost.
    # Fixture/accounting input is not an authoritative provider invoice or meter.
    # Report it as fixture-reported; reserve measured/estimated for future adapters
    # that carry a trusted measurement method and provenance.
    reported_cost = sum_known_nonnegative("costMicros")
    elapsed_ms = sum_known_nonnegative("elapsedMs")
    input_tokens = sum_known_nonnegative("inputTokens")
    output_tokens = sum_known_nonnegative("outputTokens")
    tool_calls = sum_known_nonnegative("toolCalls")
    retries = sum_known_nonnegative("retries")
    false_completion_rows = [row for row in invocation_rows if isinstance(row.get("falseCompletion"), bool)]
    security_rows = [row for row in invocation_rows if isinstance(row.get("securityFailure"), bool)]
    intervention_rows = [row for row in invocation_rows if isinstance(row.get("interventions"), int)
                         and not isinstance(row.get("interventions"), bool)]
    status_counts = {status: sum(row.get("status") == status for row in trials) for status in (
        "PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY", "CANCELLED",
        "INFRASTRUCTURE_FAILURE", "NOT_RUN", "UNKNOWN")}
    failure_stage_counts: dict[str, int] = {}
    failure_stage_counts_by_arm: dict[str, dict[str, int]] = {
        arm_id: {} for arm_id in sorted(declared_arm_ids)
    }
    for row in trials:
        stage = classify_failure(row)
        if stage != "none":
            failure_stage_counts[stage] = failure_stage_counts.get(stage, 0) + 1
            arm_stages = failure_stage_counts_by_arm[row["armId"]]
            arm_stages[stage] = arm_stages.get(stage, 0) + 1
    accounting_by_arm = {}
    for arm_id in sorted(declared_arm_ids):
        arm_rows = [row for row in invocation_rows if row["armId"] == arm_id]
        arm_trials = [row for row in trials if row["armId"] == arm_id]
        # Keep all per-arm accounting provenance explicit; never compare only
        # successful/complete pairs because failures still consumed resources.
        def arm_total(field: str):
            values = [row.get(field) for row in arm_rows]
            if not values or any(not isinstance(value, int) or isinstance(value, bool) or value < 0
                                 for value in values):
                return None
            return sum(values)
        arm_cost = arm_total("costMicros")
        accounting_by_arm[arm_id] = {
            "invocations": len(arm_rows),
            "trials": len(arm_trials),
            "costMicros": arm_cost,
            "costProvenance": _summarized_cost_provenance(arm_rows, arm_cost),
            "elapsedMs": arm_total("elapsedMs"),
            "inputTokens": arm_total("inputTokens"),
            "outputTokens": arm_total("outputTokens"),
            "toolCalls": arm_total("toolCalls"),
            "retries": arm_total("retries"),
            "statusCounts": {status: sum(row.get("status") == status for row in arm_trials)
                             for status in ("PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY",
                                            "CANCELLED", "INFRASTRUCTURE_FAILURE", "NOT_RUN", "UNKNOWN")},
            "failureStageCounts": failure_stage_counts_by_arm[arm_id],
        }
    groups: dict[str, list[float]] = {}
    for task, pair in complete.items():
        delta = float(pair[candidate_arm]["status"] == "PASS_VERIFIED") - float(
            pair[reference_arm]["status"] == "PASS_VERIFIED")
        groups.setdefault(task_groups[task], []).append(delta)
    interval = None
    gain_evidence = "INSUFFICIENT_INDEPENDENT_REPOSITORIES"
    if len(groups) >= 2 and denominator:
        analysis = manifest["analysis"]
        rng = random.Random(f"{manifest['seed']}:paired-cluster-bootstrap:v1")
        cluster_ids = sorted(groups)
        samples = []
        for _ in range(analysis["bootstrapReplicates"]):
            picked = [rng.choice(cluster_ids) for _ in cluster_ids]
            values = [outcome for group in picked for outcome in groups[group]]
            samples.append(100.0 * sum(values) / len(values))
        samples.sort()
        alpha = 1.0 - float(analysis["confidenceLevel"])
        lower = samples[max(0, int((alpha / 2) * len(samples)))]
        upper = samples[min(len(samples) - 1, int((1 - alpha / 2) * len(samples)))]
        interval = {"method": analysis["intervalMethod"], "confidenceLevel": analysis["confidenceLevel"],
                    "lowerPercentagePoints": lower, "upperPercentagePoints": upper,
                    "independentRepositoryGroups": len(cluster_ids),
                    "replicates": analysis["bootstrapReplicates"]}
        minimum = float(analysis["minimumMeaningfulDifferencePp"])
        if lower > minimum:
            gain_evidence = "MEANINGFUL_GAIN_SUPPORTED"
        elif upper <= 0:
            gain_evidence = "REGRESSION_SUPPORTED"
        else:
            gain_evidence = "NO_CLEAR_IMPROVEMENT"
    return {
        "completePairs": denominator,
        "comparisonKind": manifest["comparison"]["kind"],
        "referenceArmId": reference_arm,
        "candidateArmId": candidate_arm,
        "ablatedFeature": manifest["comparison"].get("ablatedFeature"),
        "incompletePairs": len(matrix) - denominator,
        "capabilityIncompletePairs": capability_incomplete,
        "referencePasses": reference_passes,
        "candidatePasses": candidate_passes,
        "referencePassRate": reference_passes / denominator if denominator else None,
        "candidatePassRate": candidate_passes / denominator if denominator else None,
        "baselinePasses": reference_passes if is_baseline_comparison else None,
        "harnessPasses": candidate_passes if is_baseline_comparison else None,
        "baselinePassRate": reference_passes / denominator if denominator and is_baseline_comparison else None,
        "harnessPassRate": candidate_passes / denominator if denominator and is_baseline_comparison else None,
        "absoluteChangePercentagePoints": (100 * (candidate_passes - reference_passes) / denominator)
        if denominator else None,
        "relativeUplift": ((candidate_passes - reference_passes) / reference_passes)
        if reference_passes and is_baseline_comparison else None,
        "improved": improved,
        "regressed": regressed,
        "unchanged": unchanged,
        "costMicros": reported_cost,
        "costProvenance": _summarized_cost_provenance(invocation_rows, reported_cost),
        "costUnknown": reported_cost is None,
        "elapsedMs": elapsed_ms,
        "elapsedTimeUnknown": elapsed_ms is None,
        "inputTokens": input_tokens,
        "inputTokensUnknown": input_tokens is None,
        "outputTokens": output_tokens,
        "outputTokensUnknown": output_tokens is None,
        "toolCalls": tool_calls,
        "toolCallsUnknown": tool_calls is None,
        "retries": retries,
        "retriesUnknown": retries is None,
        "statusCounts": status_counts,
        "failureStageCounts": failure_stage_counts,
        "failureStageCountsByArm": failure_stage_counts_by_arm,
        "accountingByArm": accounting_by_arm,
        "falseCompletionTrials": sum(row["falseCompletion"] for row in false_completion_rows),
        "falseCompletionEvidenceComplete": len(false_completion_rows) == len(invocation_rows),
        "securityFailureTrials": sum(row["securityFailure"] for row in security_rows),
        "securityFailureEvidenceComplete": len(security_rows) == len(invocation_rows),
        "interventions": (sum(row["interventions"] for row in intervention_rows)
                          if len(intervention_rows) == len(invocation_rows) and invocation_rows else None),
        "interventionsUnknown": len(intervention_rows) != len(invocation_rows) or not invocation_rows,
        "resourceUse": {"status": "UNKNOWN", "reason": (
            "host_run_rc0_attestation_not_integrated" if execution_modes == {"HOST_RUN_PAIRED"}
            else "fake_only_runner_has_no_os_resource_sampler"
        )},
        "excludedTaskIds": sorted(task_id for task_id, arms in matrix.items()
                                   if task_id not in complete or any(arm.get("status") in {
                                       "UNSUPPORTED_CAPABILITY", "CANCELLED",
                                       "INFRASTRUCTURE_FAILURE", "NOT_RUN", "UNKNOWN"
                                   } for arm in arms.values())),
        "pairedUncertaintyInterval": interval,
        "gainEvidence": gain_evidence,
        "estimateType": "POINT_ESTIMATE_ONLY" if interval is None else "GROUPED_BOOTSTRAP",
        "taskMatrix": matrix,
        "officialScoreEligible": False,
        "hup001Complete": False,
    }


class _ArtifactJournal:
    """Append-only, fsynced artifact store; exact prior rows are reusable on resume."""

    def __init__(self, path: Path, manifest: Mapping, manifest_digest: str,
                 mode: str = "FAKE_SELF_CHECK"):
        if mode not in {"FAKE_SELF_CHECK", "HOST_RUN_PAIRED"}:
            raise EvalError("unsupported evaluation journal mode")
        # Initialize owned descriptors first so __del__ is safe when a later
        # path/validation step raises before the journal is fully constructed.
        self.artifact_fd = -1
        self.parent_fd = -1
        root, components = _artifact_location(path)
        self.root = root
        self.components = components
        self.parent_fd = _open_parent(root, components[:-1], create=True)
        self.name = components[-1]
        self.file_identity: tuple[int, int] | None = None
        self.manifest_digest = manifest_digest
        self.mode = mode
        self.task_groups = {task["taskId"]: task["taskGroup"] for task in manifest["tasks"]}
        self.arm_ids = {arm["id"] for arm in manifest["arms"]}
        header = {"recordType": "manifest", "schema": SCHEMA, "manifestDigest": manifest_digest,
                  "manifest": manifest, "mode": mode, "officialScoreEligible": False,
                  "authorityStatus": ("HOST_RUN_ADAPTER_UNATTESTED" if mode == "HOST_RUN_PAIRED"
                                      else "FAKE_SELF_CHECK_ONLY")}
        flags = os.O_RDWR | os.O_APPEND | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
        created = False
        try:
            try:
                self.artifact_fd = os.open(self.name, flags, dir_fd=self.parent_fd)
            except FileNotFoundError:
                self.artifact_fd = os.open(
                    self.name, flags | os.O_CREAT | os.O_EXCL, 0o600, dir_fd=self.parent_fd
                )
                created = True
            try:
                import fcntl
            except ImportError as exc:
                raise EvalError("safe exclusive artifact locking is unavailable on this platform") from exc
            try:
                fcntl.flock(self.artifact_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as exc:
                raise EvalError("evaluation artifact is already in use by another runner") from exc

            parent_info = os.fstat(self.parent_fd)
            info = os.fstat(self.artifact_fd)
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1
                    or info.st_dev != parent_info.st_dev):
                raise EvalError("artifact is not a private repository-local regular file")
            self.file_identity = (info.st_dev, info.st_ino)
            raw, info = _read_open_regular(self.artifact_fd, MAX_ARTIFACT_BYTES)
            self.file_size = info.st_size
            if created:
                if raw:
                    raise EvalError("new artifact unexpectedly contains data")
                encoded = canonical_json(header) + b"\n"
                if len(encoded) > MAX_ARTIFACT_BYTES:
                    raise EvalError("artifact header exceeds the byte limit")
                view = memoryview(encoded)
                while view:
                    written = os.write(self.artifact_fd, view)
                    if written <= 0:
                        raise OSError("short artifact header write")
                    view = view[written:]
                os.fsync(self.artifact_fd)
                self.file_size = len(encoded)
                self.records = []
            else:
                if not raw or not raw.endswith(b"\n"):
                    raise EvalError("artifact is empty, oversized, or has an incomplete trailing record")
                try:
                    rows = [json.loads(line, object_pairs_hook=_pairs_no_duplicates)
                            for line in raw.splitlines()]
                except (UnicodeError, json.JSONDecodeError) as exc:
                    raise EvalError("artifact contains malformed JSON") from exc
                if not rows or rows[0] != header:
                    raise EvalError("artifact header does not match the frozen manifest")
                self.records = rows[1:]
        except OSError as exc:
            raise EvalError(f"artifact initialization failed: {exc.__class__.__name__}") from exc
        self._validate_records()

    def close(self):
        if getattr(self, "artifact_fd", -1) >= 0:
            os.close(self.artifact_fd)
            self.artifact_fd = -1
        if getattr(self, "parent_fd", -1) >= 0:
            os.close(self.parent_fd)
            self.parent_fd = -1

    def __del__(self):
        try:
            self.close()
        except OSError:
            pass

    def _validate_records(self):
        seen = set()
        call_indexes = set()
        stopped = False
        for row in self.records:
            if not isinstance(row, dict) or row.get("recordType") != "trial":
                raise EvalError("artifact contains a non-trial row after its header")
            if row.get("manifestDigest") != self.manifest_digest:
                raise EvalError("artifact trial belongs to a different manifest")
            task_id, arm_id = row.get("taskId"), row.get("armId")
            if not isinstance(task_id, str) or not isinstance(arm_id, str):
                raise EvalError("artifact task and arm identities must be strings")
            key = (task_id, arm_id)
            if key[0] not in self.task_groups or key[1] not in self.arm_ids:
                raise EvalError("artifact trial is outside the frozen task/arm matrix")
            if (("taskGroup" in row and row["taskGroup"] != self.task_groups[key[0]])
                    or row.get("mode") != self.mode):
                raise EvalError("artifact trial differs from its frozen task group or execution mode")
            if key in seen:
                raise EvalError("artifact contains a duplicate task/arm result")
            status = row.get("status")
            if not isinstance(status, str) or status not in {
                "PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY", "CANCELLED",
                "INFRASTRUCTURE_FAILURE", "NOT_RUN", "UNKNOWN",
            }:
                raise EvalError("artifact contains an unknown trial status")
            if stopped and status != "NOT_RUN":
                raise EvalError("artifact dispatches a trial after a terminal trial")
            if status == "NOT_RUN" and not stopped:
                raise EvalError("artifact NOT_RUN precedes a terminal trial")
            dispatch_started = row.get("dispatchStarted")
            expected_dispatch = status not in {"NOT_RUN", "CANCELLED"} or (
                status == "CANCELLED" and dispatch_started is True
            )
            if not isinstance(dispatch_started, bool) or dispatch_started != expected_dispatch:
                raise EvalError("artifact dispatch state contradicts trial status")
            call_index_field = "providerCallIndex" if self.mode == "FAKE_SELF_CHECK" else "hostRunDispatchIndex"
            call_index = row.get(call_index_field)
            if status == "NOT_RUN":
                if call_index is not None:
                    raise EvalError("not-run artifact trial cannot claim a provider call index")
            elif status == "CANCELLED" and row.get("dispatchStarted") is False:
                if call_index is not None:
                    raise EvalError("pre-dispatch cancellation cannot claim a provider call index")
            elif (not isinstance(call_index, int) or isinstance(call_index, bool)
                  or call_index < 0 or call_index > 2**63 - 1 or call_index in call_indexes):
                raise EvalError("artifact provider call indexes must be unique bounded integers")
            else:
                call_indexes.add(call_index)
            if status in {"CANCELLED", "INFRASTRUCTURE_FAILURE", "UNKNOWN"}:
                stopped = True
            if self.mode == "HOST_RUN_PAIRED" and status in {
                "PASS_VERIFIED", "FAIL_UNVERIFIED", "UNSUPPORTED_CAPABILITY"
            }:
                _validate_host_run_trial_evidence(row, require_complete=False)
            seen.add(key)
        if call_indexes != set(range(len(call_indexes))):
            raise EvalError("artifact provider call indexes are not a contiguous execution prefix")

    def assert_current(self):
        """Fence a resumed invocation before spending its next provider call."""
        try:
            info = os.fstat(self.artifact_fd)
            current_path = os.stat(self.name, dir_fd=self.parent_fd, follow_symlinks=False)
        except OSError as exc:
            raise EvalError(f"evaluation artifact identity check failed: {exc.__class__.__name__}") from exc
        if (not stat.S_ISREG(current_path.st_mode)
                or (current_path.st_dev, current_path.st_ino) != self.file_identity
                or (info.st_dev, info.st_ino) != self.file_identity
                or info.st_size != self.file_size):
            raise EvalError("evaluation artifact changed before provider dispatch")

    def append(self, record: dict):
        row = {"recordType": "trial", **record}
        encoded = canonical_json(row) + b"\n"
        try:
            current, info = _read_open_regular(self.artifact_fd, MAX_ARTIFACT_BYTES)
            if self.file_identity != (info.st_dev, info.st_ino):
                raise EvalError("artifact file identity changed after it was pinned")
            if len(current) + len(encoded) > MAX_ARTIFACT_BYTES:
                raise EvalError("evaluation artifact exceeds the byte limit")
            current_path = os.stat(self.name, dir_fd=self.parent_fd, follow_symlinks=False)
            if ((current_path.st_dev, current_path.st_ino) != self.file_identity
                    or not stat.S_ISREG(current_path.st_mode)):
                raise EvalError("artifact path identity changed before append")
            if info.st_size != len(current) or info.st_size != self.file_size:
                raise EvalError("artifact size changed before append")
            view = memoryview(encoded)
            while view:
                written = os.write(self.artifact_fd, view)
                if written <= 0:
                    raise OSError("short artifact append")
                view = view[written:]
            os.fsync(self.artifact_fd)
            self.file_size += len(encoded)
        except OSError as exc:
            raise EvalError(f"artifact append failed: {exc.__class__.__name__}") from exc
        self.records.append(row)

    def digest(self) -> str:
        try:
            raw, info = _read_open_regular(self.artifact_fd, MAX_ARTIFACT_BYTES)
            if self.file_identity != (info.st_dev, info.st_ino):
                raise EvalError("artifact file identity changed before digest")
            if info.st_size != self.file_size or len(raw) != self.file_size:
                raise EvalError("artifact size changed outside the journal")
            current_path = os.stat(self.name, dir_fd=self.parent_fd, follow_symlinks=False)
            if ((current_path.st_dev, current_path.st_ino) != self.file_identity
                    or not stat.S_ISREG(current_path.st_mode)):
                raise EvalError("artifact path identity changed before digest")
        except OSError as exc:
            raise EvalError(f"artifact digest read failed: {exc.__class__.__name__}") from exc
        value = "sha256:" + hashlib.sha256(raw).hexdigest()
        self.close()
        return value


def run_fake_selfcheck(manifest: Mapping, provider: Provider, artifact_path: Path) -> EvaluationResult:
    """Exercise paired isolation, oracle scoring, cancellation and durable artifacts.

    This is explicitly a fake-only pathway. No API, subprocess, shell, socket, task image,
    or Guarded product effect is available through this function.
    """
    frozen = json.loads(canonical_json(dict(manifest)))
    validate_manifest(frozen)
    if frozen["lane"] != "development" or frozen.get("fakeSelfcheck") is not True:
        raise EvalError("fake self-check accepts only an explicitly marked development manifest")
    if type(provider) is not FixtureFakeProvider:
        raise EvalError("offline self-check accepts only the deterministic FixtureFakeProvider")
    for value in provider._responses.values():
        if not isinstance(value, (FakeResponse, Exception)):
            raise EvalError("fake provider inputs must be immutable response fixtures or typed failures")
    frozen_digest = digest(frozen)
    common_digest = digest(frozen["shared"])
    tasks = {task["taskId"]: task for task in frozen["tasks"]}
    arms = {arm["id"]: arm for arm in frozen["arms"]}
    journal = _ArtifactJournal(artifact_path, frozen, frozen_digest)
    plan = paired_call_plan(frozen)
    plan_keys = set(plan)
    existing_keys = {(row.get("taskId"), row.get("armId")) for row in journal.records}
    if not existing_keys.issubset(plan_keys):
        raise EvalError("artifact contains task/arm rows outside this manifest")
    stopped = next((row for row in journal.records
                    if row.get("status") in {"CANCELLED", "INFRASTRUCTURE_FAILURE", "NOT_RUN"}), None)
    prior_call_indexes = [row.get("providerCallIndex") for row in journal.records
                          if isinstance(row.get("providerCallIndex"), int)]
    call_index = max(prior_call_indexes, default=-1) + 1
    for plan_index, (task_id, arm_id) in enumerate(plan):
        if (task_id, arm_id) in existing_keys:
            continue
        if stopped is not None:
            journal.append({"taskId": task_id, "armId": arm_id, "manifestDigest": frozen_digest,
                            "status": "NOT_RUN", "failureClass": "infrastructure",
                            "dispatchStarted": False, "stopReason": stopped["status"],
                            "mode": "FAKE_SELF_CHECK"})
            continue
        if call_index >= frozen.get("cancelAfterCalls", 0) > 0:
            stopped_record = {"taskId": task_id, "armId": arm_id, "manifestDigest": frozen_digest,
                              "status": "CANCELLED", "failureClass": "infrastructure",
                              "dispatchStarted": False, "mode": "FAKE_SELF_CHECK"}
            journal.append(stopped_record)
            stopped = stopped_record
            continue
        task = tasks[task_id]
        journal.assert_current()
        request = Invocation(task_id, task["taskGroup"], task["inputDigest"], arm_id,
                             arms[arm_id]["harnessDigest"], common_digest, frozen_digest, call_index)
        try:
            response = provider.invoke(request)
            if not isinstance(response, FakeResponse):
                raise InfrastructureFailure("fake provider returned an invalid response")
            if (not isinstance(response.output, str) or not isinstance(response.expected_output, str)
                    or not isinstance(response.evidence, str)
                    or len(response.output.encode("utf-8")) > MAX_FAKE_OUTPUT_BYTES
                    or len(response.expected_output.encode("utf-8")) > MAX_FAKE_OUTPUT_BYTES
                    or len(response.evidence.encode("utf-8")) > MAX_ID_BYTES * 4):
                raise InfrastructureFailure("fake provider returned invalid or oversized text")
            accounting = (response.elapsed_ms, response.input_tokens, response.output_tokens,
                          response.tool_calls, response.retries, response.interventions)
            if (any(not isinstance(value, int) or isinstance(value, bool) or value < 0
                    or value > 2**63 - 1 for value in accounting)
                    or (response.cost_micros is not None and
                        (not isinstance(response.cost_micros, int) or isinstance(response.cost_micros, bool)
                         or response.cost_micros < 0 or response.cost_micros > 2**63 - 1))):
                raise InfrastructureFailure("fake provider returned invalid accounting")
            if not isinstance(response.capability_complete, bool):
                raise InfrastructureFailure("fake provider returned invalid capability status")
            if (not isinstance(response.completion_claimed, bool)
                    or not isinstance(response.security_failure, bool)):
                raise InfrastructureFailure("fake provider returned invalid verification/security status")
            budget = frozen["shared"]["budgets"]
            budget_exceeded = (
                response.elapsed_ms > budget["wallTimeMs"]
                or response.input_tokens + response.output_tokens > budget["tokenBudget"]
                or response.tool_calls > budget["maxToolCalls"]
                or response.retries > budget["maxRetries"]
                or (response.cost_micros is not None
                    and response.cost_micros > budget["costMicros"])
            )
            verified = (response.capability_complete and not response.security_failure and not budget_exceeded
                        and response.output == response.expected_output and bool(response.evidence))
            status = "UNSUPPORTED_CAPABILITY" if not response.capability_complete else (
                "FAIL_UNVERIFIED" if budget_exceeded or not verified else "PASS_VERIFIED")
            record = {
                "taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
                "providerCallIndex": call_index,
                "manifestDigest": frozen_digest, "sharedConfigDigest": common_digest,
                "status": status,
                "dispatchStarted": True,
                "failureClass": "none" if verified else (
                    "unsupported_capability" if not response.capability_complete else
                    "security_failure" if response.security_failure else
                    "budget_exhaustion" if budget_exceeded else "unknown"),
                "evidenceStage": ("budget_exhaustion" if budget_exceeded else
                                  "effect_execution" if response.security_failure else
                                  "unknown" if not verified else None),
                "falseCompletion": (response.completion_claimed and not verified
                                    and response.capability_complete),
                "securityFailure": response.security_failure,
                "interventions": response.interventions,
                "resourceUse": {"status": "UNKNOWN", "reason": "fake_only_runner_has_no_os_resource_sampler"},
                "oracleEvidenceDigest": digest({"expected": response.expected_output, "evidence": response.evidence}),
                "outputDigest": digest(response.output), "fixtureOutput": response.output,
                "elapsedMs": response.elapsed_ms,
                "inputTokens": response.input_tokens, "outputTokens": response.output_tokens,
                "toolCalls": response.tool_calls, "retries": response.retries,
                "costMicros": response.cost_micros, "mode": "FAKE_SELF_CHECK",
            }
        except EvaluationCancelled:
            record = {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
                      "manifestDigest": frozen_digest, "status": "CANCELLED",
                      "providerCallIndex": call_index, "failureClass": "infrastructure",
                      "dispatchStarted": True, "mode": "FAKE_SELF_CHECK"}
        except InfrastructureFailure as exc:
            record = {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
                      "manifestDigest": frozen_digest, "status": "INFRASTRUCTURE_FAILURE",
                      "providerCallIndex": call_index,
                      "failureClass": "infrastructure", "errorType": type(exc).__name__,
                      "dispatchStarted": True,
                      "mode": "FAKE_SELF_CHECK"}
        except Exception as exc:  # provider adapter faults are infrastructure, not task failure
            record = {"taskId": task_id, "taskGroup": task["taskGroup"], "armId": arm_id,
                      "manifestDigest": frozen_digest, "status": "INFRASTRUCTURE_FAILURE",
                      "providerCallIndex": call_index,
                      "failureClass": "infrastructure", "errorType": type(exc).__name__,
                      "dispatchStarted": True,
                      "mode": "FAKE_SELF_CHECK"}
        record["recordType"] = "trial"
        journal.append(record)
        call_index += 1
        if record["status"] in {"CANCELLED", "INFRASTRUCTURE_FAILURE"}:
            stopped = record
    artifact_digest = journal.digest()
    return EvaluationResult(tuple(journal.records), artifact_digest)


class FixtureFakeProvider:
    """Small deterministic provider for tests/self-check; keyed by exact task and arm."""
    def __init__(self, responses: Mapping[tuple[str, str], FakeResponse | Exception]):
        self._responses = dict(responses)
        self.calls: list[Invocation] = []

    def invoke(self, request: Invocation) -> FakeResponse:
        if (request.task_id, request.arm_id) in {(c.task_id, c.arm_id) for c in self.calls}:
            raise InfrastructureFailure("duplicate task/arm invocation")
        self.calls.append(request)
        key = (request.task_id, request.arm_id)
        if key not in self._responses:
            raise InfrastructureFailure("fake response is absent for task/arm")
        value = self._responses[key]
        if isinstance(value, Exception):
            raise value
        return value


def selfcheck_manifest() -> dict:
    """Fixed, public-safe fixture; it contains no benchmark task or provider data."""
    return {
        "schema": SCHEMA, "runId": "hup005-selfcheck-v1", "lane": "development",
        "fakeSelfcheck": True, "seed": 23, "cancelAfterCalls": 0,
        "failurePolicy": "typed_fail_closed_v1",
        "exclusionPolicy": "declared_partition_only_v1",
        "comparison": {"kind": "baseline_vs_full", "referenceArmId": "minimal",
                       "candidateArmId": "horizoncode"},
        "analysis": {"intervalMethod": "repository_cluster_bootstrap_percentile", "confidenceLevel": 0.95,
                     "bootstrapReplicates": 500, "minimumMeaningfulDifferencePp": 5.0},
        "taskPartitions": {"development": ["fixture-1", "fixture-2"], "smoke": [], "heldout": []},
        "benchmark": {"name": "horizoncode-hup005-fixture", "version": "1", "split": "selfcheck",
                      "splitDigest": digest(["fixture-1", "fixture-2"]), "scoringField": "passed",
                      "evaluatorDigest": digest("fixture-oracle-v1")},
        "shared": {"providerRoute": "FAKE_ONLY", "modelRevision": "fake-v1", "modelClass": "small",
                   "repositoryImageDigest": digest("fixture-repo"), "promptDigest": digest("fixture-prompt"),
                   "oracleDigest": digest("fixture-oracle-v1"), "permissionProfileDigest": digest("no-effects"),
                   "sampling": {"seed": 23, "temperature": 0},
                   "budgets": {"tokenBudget": 1000, "wallTimeMs": 1000, "maxToolCalls": 4,
                               "maxRetries": 0, "costMicros": 64},
                   "toolAllowlist": []},
        "arms": [{"id": "minimal", "harnessDigest": digest("minimal-fixture"),
                  "harnessCommit": "fixture-source-v1", "declaredFactor": "minimal_single_turn"},
                 {"id": "horizoncode", "harnessDigest": digest("horizoncode-fixture"),
                  "harnessCommit": "fixture-source-v1",
                  "declaredFactor": "horizoncode_harness"}],
        "tasks": [{"taskId": "fixture-1", "taskGroup": "fixture-repo-a", "inputDigest": digest("input-1")},
                  {"taskId": "fixture-2", "taskGroup": "fixture-repo-b", "inputDigest": digest("input-2")}],
    }


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--selfcheck", action="store_true", help="run deterministic fake-only HUP-005 check")
    parser.add_argument("--artifact", type=Path, help="repository-local self-check artifact destination")
    args = parser.parse_args(argv)
    if not args.selfcheck or args.artifact is None:
        parser.error("only --selfcheck --artifact <repository-local-path> is supported; live runs are unavailable")
    # Keep the caller's lexical path so the dirfd/O_NOFOLLOW walker can reject
    # symlink components instead of blessing their resolved targets.
    target = args.artifact
    manifest = selfcheck_manifest()
    response_map = {}
    for task in manifest["tasks"]:
        for arm in ARMS:
            response_map[(task["taskId"], arm)] = FakeResponse("ok", "ok", "fixture-evidence")
    result = run_fake_selfcheck(manifest, FixtureFakeProvider(response_map), target)
    report = evaluation_report(result, manifest)
    report["recordCount"] = len(result.records)
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
