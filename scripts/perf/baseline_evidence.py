#!/usr/bin/env python3
"""1/5/10/20 paired-baseline evidence preparation (item 46).

Read-only preparation for ``docs/performance/evidence/``: a candidate becomes
READY only when (1) a parent workload authorization is configured, (2) a
configured trusted RC0 source's registered verifier attests every scenario's
exact sessions/commit/outcomes, (3) the full 1/5/10/20 matrix is present,
(4) the matched-arm environment pins are identical across arms, and (5) every
capture row came from the attested producer. Otherwise the result is NOT_RUN
with the exact reason and zero rows.

This module never launches a workload, never measures anything, and never
writes under ``docs/performance/evidence/`` on its own: writing happens only
through :func:`append_evidence` with a READY result and an explicit
destination. In this checkout workload authority is absent, so every
evaluation stops at NOT_RUN.
"""
import hashlib
import hmac
import json
import os
import stat
from pathlib import Path

import rc0

SCENARIOS = (1, 5, 10, 20)
EVIDENCE_ROOT = "docs/performance/evidence"
COMMIT_MARKER_NAME = "rc0-baseline-matrix.complete.json"
COMMIT_MARKER_KIND = "rc0_baseline_matrix_commit"
COMMIT_MARKER_SCHEMA_VERSION = 1
MAX_EVIDENCE_ROW_BYTES = 1 << 20
MAX_COMMIT_MARKER_BYTES = 64 << 10


def _pin_repository_root():
    """Pin the checkout directory identity once, when this process imports us."""
    root = Path(__file__).resolve().parents[2]
    try:
        info = os.stat(root, follow_symlinks=False)
    except OSError as error:
        raise RuntimeError("trusted repository root cannot be pinned") from error
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode):
        raise RuntimeError("trusted repository root is not a real directory")
    return root, (info.st_dev, info.st_ino)


_TRUSTED_REPOSITORY_ROOT, _TRUSTED_REPOSITORY_IDENTITY = _pin_repository_root()


# Parent authorization for real product workloads. Empty in this checkout: no
# parent grant has been recorded, so every evaluation stops at NOT_RUN with
# reason ``workload_authorization_absent``. This is configuration, never a
# caller-supplied override.
WORKLOAD_AUTHORIZATION = None
AUTHORIZATION_SCOPE = "rc0-paired-baseline"

# Fields that must be byte-identical between the baseline and HorizonCode arms
# of a matched comparison (DEC-V1-34: model/version, task set, tools,
# permissions, budgets and environment held constant). The harness name is the
# arm variable and is deliberately not matched.
MATCHED_ARM_FIELDS = (
    "provider_model", "task_set_digest", "tools", "permissions", "budgets",
    "environment", "machine", "task_repo_commit",
)
REQUIRED_ARMS = ("baseline", "horizoncode")

# READY evidence is a same-process integrity capability against ordinary caller
# mapping/mutation, not a sandbox against arbitrary Python executing in this process.
# JSON/dict reconstruction loses the exact type; a process-local HMAC seals the
# result mapping and the canonical authority snapshots used for write-time checks.
_READY_RESULT_CAPABILITY = object()
_READY_RESULT_KEY = os.urandom(32)


def _canonical_json_bytes(value):
    return json.dumps(value, sort_keys=True, separators=(",", ":"),
                      ensure_ascii=False, allow_nan=False).encode("utf-8")


def _ready_result_payload(result, authorization_snapshot, verifier_snapshot):
    if not isinstance(authorization_snapshot, bytes):
        raise ValueError("invalid evaluator authorization snapshot")
    verifier_identities = []
    for snapshot in verifier_snapshot:
        try:
            source, verifier = snapshot
        except (TypeError, ValueError) as error:
            raise ValueError("invalid evaluator verifier snapshot") from error
        if not isinstance(source, str) or not callable(verifier):
            raise ValueError("invalid evaluator verifier snapshot")
        verifier_identities.append([source, id(verifier)])
    return _canonical_json_bytes({
        "result": result,
        "authorization_snapshot": authorization_snapshot.hex(),
        "verifier_snapshot": verifier_identities,
    })


class _EvaluatorIssuedReadyResult(dict):
    """Same-process result integrity against ordinary mapping and metadata mutation."""

    def __init__(self, values, capability, authorization, verifier_snapshot):
        if capability is not _READY_RESULT_CAPABILITY:
            raise TypeError("READY result can only be minted by the evaluator")
        super().__init__(values)
        self.__authorization = _canonical_json_bytes(authorization)
        self.__verifier_snapshot = tuple(verifier_snapshot)
        self.__seal = hmac.new(
            _READY_RESULT_KEY,
            _ready_result_payload(self, self.__authorization,
                                  self.__verifier_snapshot),
            hashlib.sha256).digest()

    def _is_intact(self):
        try:
            seal = self.__seal
            if not isinstance(seal, bytes):
                return False
            current = hmac.new(
                _READY_RESULT_KEY,
                _ready_result_payload(self, self.__authorization,
                                      self.__verifier_snapshot),
                hashlib.sha256).digest()
            return hmac.compare_digest(seal, current)
        except (AttributeError, OverflowError, TypeError, ValueError):
            return False

    def _authorization_is_current(self):
        if not isinstance(WORKLOAD_AUTHORIZATION, dict):
            return False
        try:
            current = _canonical_json_bytes(WORKLOAD_AUTHORIZATION)
            result_authorization = _canonical_json_bytes(self["authorization"])
        except (KeyError, TypeError, ValueError):
            return False
        return (isinstance(self.__authorization, bytes)
                and hmac.compare_digest(result_authorization, self.__authorization)
                and hmac.compare_digest(current, self.__authorization))

    def _attestation_sources_are_current(self):
        if not self.__verifier_snapshot:
            return False
        for source, verifier in self.__verifier_snapshot:
            if (not callable(verifier)
                    or source not in rc0.TRUSTED_ATTESTATION_SOURCES
                    or rc0.TRUSTED_ATTESTATION_VERIFIERS.get(source) is not verifier):
                return False
        return True


def _evaluator_ready_result(values):
    sources = sorted({row["attestation_source"] for row in values["rows"]})
    verifier_snapshot = tuple(
        (source, rc0.TRUSTED_ATTESTATION_VERIFIERS.get(source))
        for source in sources)
    if any(not callable(verifier) for _, verifier in verifier_snapshot):
        raise ValueError("trusted attestation verifier changed during evaluation")
    return _EvaluatorIssuedReadyResult(
        values, _READY_RESULT_CAPABILITY, WORKLOAD_AUTHORIZATION,
        verifier_snapshot)


def evidence_path(scenario, destination_root=EVIDENCE_ROOT):
    """Repository-relative JSONL path for one scenario's evidence rows."""
    if scenario not in SCENARIOS:
        raise ValueError(f"scenario must be one of {SCENARIOS}, got {scenario!r}")
    root = Path(destination_root)
    if ".." in root.parts:
        raise ValueError("evidence destination cannot contain parent traversal")
    return root / f"rc0-baseline-{scenario}-sessions.jsonl"


def _authorization_reason():
    """Exact reason the workload authorization gate is closed, or None."""
    authorization = WORKLOAD_AUTHORIZATION
    if authorization is None:
        return "workload_authorization_absent: no parent grant for real product "\
               "workloads is configured in this checkout"
    if not isinstance(authorization, dict):
        return "workload_authorization_invalid: authorization must be a record"
    if authorization.get("scope") != AUTHORIZATION_SCOPE:
        return "workload_authorization_scope_invalid: scope must be "\
               f"{AUTHORIZATION_SCOPE!r}"
    if not isinstance(authorization.get("granted_by"), str) \
            or not authorization["granted_by"].strip():
        return "workload_authorization_grantor_missing: granted_by is required"
    if sorted(authorization.get("scenarios", [])) != list(SCENARIOS):
        return "workload_authorization_scenarios_incomplete: grant must cover "\
               f"{list(SCENARIOS)}"
    return None


def _scenario_reasons(candidate):
    """Validate the scenario matrix, attestations, pins and producer rows."""
    scenarios = candidate.get("scenarios")
    if not isinstance(scenarios, dict):
        return ["scenario_matrix_incomplete: candidate has no scenarios"]
    missing = [str(n) for n in SCENARIOS if str(n) not in scenarios]
    extra = sorted(set(scenarios) - {str(n) for n in SCENARIOS})
    if missing or extra:
        return [f"scenario_matrix_incomplete: missing={missing} extra={extra}"]
    commit = candidate.get("commit")
    if not isinstance(commit, str) or not commit:
        return ["candidate_commit_missing: the exact task repository commit is required"]
    reasons = []
    for n in SCENARIOS:
        entry = scenarios[str(n)]
        if not isinstance(entry, dict):
            reasons.append(f"scenario_{n}_invalid: entry must be an object")
            continue
        selected = entry.get("selected")
        outcomes = entry.get("outcomes")
        attestation = entry.get("attestation")
        if not isinstance(selected, list) or len(selected) != n:
            reasons.append(f"scenario_{n}_incomplete: {n} session identities required")
            continue
        if not rc0.attestation_covers(attestation, selected, commit,
                                      outcomes=outcomes):
            reasons.append(
                f"attestation_not_covering_scenario_{n}: no configured trusted "
                "source attested exactly these sessions, commit and outcome rows")
            continue
        records = entry.get("capture_records")
        if not isinstance(records, list) or not records:
            reasons.append(f"capture_records_missing: scenario_{n}")
            continue
        for index, record in enumerate(records):
            if not isinstance(record, dict) \
                    or record.get("record_type") != "rc0_sample" \
                    or record.get("commit") != commit \
                    or record.get("sessions_requested") != n:
                reasons.append(
                    f"capture_record_invalid: scenario_{n} row {index} is not an "
                    "rc0_sample row bound to this commit/scenario")
                break
            if record.get("release_eligible") is not True:
                reasons.append(
                    f"capture_records_not_release_eligible: scenario_{n} row "
                    f"{index} was not produced under a covering attestation")
                break
            if (record.get("owner_sample_attestation") != "ATTESTED"
                    or record.get("owner_attestation_source") != attestation.source
                    or record.get("owner_attestation_signature_digest")
                    != attestation.source_signature_digest
                    or record.get("baseline_eligible") is not True
                    or record.get("status") != "BASELINE"
                    or record.get("provisional_raw_sample") is not False
                    or record.get("commit_exact") is not True):
                reasons.append(
                    f"capture_record_provenance_incomplete: scenario_{n} row "
                    f"{index} does not match its exact owner attestation and "
                    "baseline eligibility state")
                break
    return reasons


def _matched_arm_reasons(candidate):
    arms = candidate.get("arms")
    if not isinstance(arms, dict) or set(arms) != set(REQUIRED_ARMS):
        return [f"matched_arm_incomplete: arms must be exactly {list(REQUIRED_ARMS)}"]
    reasons = []
    for field in MATCHED_ARM_FIELDS:
        values = []
        for arm in REQUIRED_ARMS:
            value = arms[arm].get(field) if isinstance(arms[arm], dict) else None
            if value is None or value == "" or value == {}:
                reasons.append(f"matched_arm_incomplete: {field} missing in {arm}")
                values = None
                break
            values.append(json.dumps(value, sort_keys=True))
        if values is not None and len(set(values)) != 1:
            reasons.append(
                f"matched_arm_incomplete: {field} differs between arms")
    return reasons


def evaluate_baseline_evidence(candidate):
    """Return READY rows or NOT_RUN with the exact blocking reason.

    No row is ever produced without every authority gate passing; a NOT_RUN
    result carries ``rows: []`` so a caller cannot mistake intent for evidence.
    """
    if not isinstance(candidate, dict):
        return {"status": "NOT_RUN", "rows": [],
                "reason": "candidate_invalid: expected an object"}
    authorization_reason = _authorization_reason()
    if authorization_reason:
        return {"status": "NOT_RUN", "rows": [], "reason": authorization_reason}
    registry = rc0.attestation_registry_status()
    if registry["status"] != "CONFIGURED":
        return {"status": "NOT_RUN", "rows": [],
                "reason": "trusted_attestation_not_configured: "
                          + "; ".join(registry["contract_gaps"] or
                                      ["trusted source/verifier registry is empty"])}
    reasons = _scenario_reasons(candidate)
    if not reasons:
        reasons = _matched_arm_reasons(candidate)
    if reasons:
        return {"status": "NOT_RUN", "rows": [], "reason": "; ".join(reasons)}
    rows = []
    for n in SCENARIOS:
        entry = candidate["scenarios"][str(n)]
        rows.append({
            "record_type": "rc0_baseline_evidence",
            "scenario": n,
            "sessions": n,
            "commit": candidate["commit"],
            "attestation_source": entry["attestation"].source,
            "capture_records": len(entry["capture_records"]),
            "arms": {arm: candidate["arms"][arm]["harness"]
                     for arm in REQUIRED_ARMS},
            "evidence_path": str(evidence_path(n)),
            "release_eligible": True,
            "producer": "scripts/perf/rc0.py attested capture rows",
        })
    return _evaluator_ready_result({
        "status": "READY", "reason": None, "rows": rows,
        "authorization": dict(WORKLOAD_AUTHORIZATION),
    })


def _observed_repository_root():
    """Reject a changed module-root observation using the import-time identity."""
    try:
        observed = Path(__file__).resolve().parents[2]
        info = os.stat(observed, follow_symlinks=False)
    except (OSError, RuntimeError, IndexError) as error:
        raise ValueError("trusted repository root identity changed") from error
    if (stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode)
            or (info.st_dev, info.st_ino) != _TRUSTED_REPOSITORY_IDENTITY):
        raise ValueError("trusted repository root identity changed")
    return _TRUSTED_REPOSITORY_ROOT


def _open_repository_directory(repository, relative_parts, *, create=True):
    """Open/create a repository-relative directory chain without following links."""
    if Path(repository) != _TRUSTED_REPOSITORY_ROOT:
        raise ValueError("trusted repository root identity changed")
    if (not hasattr(os, "O_NOFOLLOW") or not hasattr(os, "O_DIRECTORY")
            or os.open not in os.supports_dir_fd
            or os.mkdir not in os.supports_dir_fd
            or os.stat not in os.supports_dir_fd
            or os.stat not in os.supports_follow_symlinks):
        raise ValueError(
            "safe descriptor-relative evidence writing is unavailable on this platform")

    directory_flags = (os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
                       | getattr(os, "O_CLOEXEC", 0))
    root_fd = -1
    parent_fd = -1
    child_fd = -1
    try:
        root_fd = os.open(repository, directory_flags)
        root_info = os.fstat(root_fd)
        path_info = os.stat(repository, follow_symlinks=False)
        expected_identity = _TRUSTED_REPOSITORY_IDENTITY
        if (not stat.S_ISDIR(root_info.st_mode)
                or stat.S_ISLNK(path_info.st_mode)
                or not stat.S_ISDIR(path_info.st_mode)
                or (root_info.st_dev, root_info.st_ino) != expected_identity
                or (path_info.st_dev, path_info.st_ino) != expected_identity):
            raise ValueError("trusted repository root identity changed")
        if root_info.st_mode & 0o022:
            raise ValueError("repository evidence path must not be group/world writable")

        device = root_info.st_dev
        parent_fd = root_fd
        root_fd = -1
        for component in relative_parts:
            try:
                child_fd = os.open(component, directory_flags, dir_fd=parent_fd)
            except FileNotFoundError as error:
                if not create:
                    raise ValueError("evidence destination directory is missing") from error
                os.mkdir(component, 0o700, dir_fd=parent_fd)
                child_fd = os.open(component, directory_flags, dir_fd=parent_fd)
            child_info = os.fstat(child_fd)
            if (not stat.S_ISDIR(child_info.st_mode)
                    or child_info.st_dev != device
                    or child_info.st_mode & 0o022):
                raise ValueError(
                    "evidence destination contains an unsafe, writable, or cross-device directory")
            os.close(parent_fd)
            parent_fd = child_fd
            child_fd = -1
        result_fd = parent_fd
        parent_fd = -1
        return result_fd
    except OSError as error:
        raise ValueError(
            "evidence destination cannot be opened safely without following links") from error
    finally:
        if child_fd >= 0:
            os.close(child_fd)
        if parent_fd >= 0:
            os.close(parent_fd)
        if root_fd >= 0:
            os.close(root_fd)


def _atomic_marker_publication_supported():
    return (
        hasattr(os, "O_NOFOLLOW")
        and os.link in getattr(os, "supports_dir_fd", set())
        and os.link in getattr(os, "supports_follow_symlinks", set())
        and os.unlink in getattr(os, "supports_dir_fd", set())
    )


def _private_regular_file(info):
    return (
        stat.S_ISREG(info.st_mode)
        and info.st_nlink == 1
        and hasattr(os, "geteuid")
        and info.st_uid == os.geteuid()
        and not (info.st_mode & 0o077)
    )


def _safe_leaf_name(name):
    return (
        isinstance(name, str)
        and name not in ("", ".", "..")
        and "/" not in name
        and "\\" not in name
    )


def _write_all(descriptor, payload):
    view = memoryview(payload)
    while view:
        count = os.write(descriptor, view)
        if count <= 0:
            raise OSError("short evidence write")
        view = view[count:]


def _write_new_private_file(directory_fd, name, payload, purpose):
    if not _safe_leaf_name(name):
        raise ValueError(f"invalid {purpose} name")
    file_flags = (os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW
                  | getattr(os, "O_CLOEXEC", 0))
    try:
        descriptor = os.open(name, file_flags, 0o600, dir_fd=directory_fd)
    except FileExistsError as error:
        raise ValueError(f"{purpose} already exists: {name}; refusing to overwrite") from error
    except OSError as error:
        raise ValueError(f"{purpose} cannot be created safely: {name}") from error
    try:
        info = os.fstat(descriptor)
        if not _private_regular_file(info):
            raise ValueError(f"new {purpose} failed private regular-file checks")
        _write_all(descriptor, payload)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def _read_private_file_at(directory_fd, name, purpose, max_bytes):
    if not _safe_leaf_name(name):
        raise ValueError(f"invalid {purpose} name")
    file_flags = os.O_RDONLY | os.O_NOFOLLOW | getattr(os, "O_CLOEXEC", 0)
    try:
        descriptor = os.open(name, file_flags, dir_fd=directory_fd)
    except FileNotFoundError as error:
        raise ValueError(f"{purpose} is missing") from error
    except OSError as error:
        raise ValueError(f"{purpose} cannot be opened safely") from error
    try:
        before = os.fstat(descriptor)
        if not _private_regular_file(before):
            raise ValueError(f"{purpose} failed private regular-file checks")
        if before.st_size < 0 or before.st_size > max_bytes:
            raise ValueError(f"{purpose} exceeds its bounded size")
        remaining = before.st_size
        chunks = []
        while remaining:
            chunk = os.read(descriptor, min(remaining, 65536))
            if not chunk:
                raise ValueError(f"{purpose} was truncated during read")
            chunks.append(chunk)
            remaining -= len(chunk)
        if os.read(descriptor, 1):
            raise ValueError(f"{purpose} changed size during read")
        after = os.fstat(descriptor)
        if (after.st_dev, after.st_ino, after.st_size, after.st_nlink) != (
                before.st_dev, before.st_ino, before.st_size, before.st_nlink):
            raise ValueError(f"{purpose} changed during read")
        if not _private_regular_file(after):
            raise ValueError(f"{purpose} failed private regular-file checks")
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _evidence_row_bytes(row):
    return (json.dumps(row, sort_keys=True, separators=(",", ":"),
                        allow_nan=False) + "\n").encode("utf-8")


def _manifest_base(files):
    return {
        "schemaVersion": COMMIT_MARKER_SCHEMA_VERSION,
        "kind": COMMIT_MARKER_KIND,
        "commitState": "COMMITTED",
        "trust": "UNVERIFIED",
        "aggregationEligible": False,
        "attestationEligible": False,
        "files": files,
    }


def _manifest_bytes(files):
    base = _manifest_base(files)
    digest = "sha256:" + hashlib.sha256(_canonical_json_bytes(base)).hexdigest()
    manifest = dict(base)
    manifest["matrixDigest"] = digest
    payload = _canonical_json_bytes(manifest) + b"\n"
    if len(payload) > MAX_COMMIT_MARKER_BYTES:
        raise ValueError("evidence commit manifest exceeds its bounded size")
    return payload


def _publish_commit_marker(directory_fd, payload):
    if not _atomic_marker_publication_supported():
        raise ValueError("atomic evidence commit marker publication is unavailable")
    temporary_name = (
        f".{COMMIT_MARKER_NAME}.{os.urandom(16).hex()}.tmp")
    _write_new_private_file(
        directory_fd, temporary_name, payload, "temporary commit marker")
    try:
        os.link(temporary_name, COMMIT_MARKER_NAME,
                src_dir_fd=directory_fd, dst_dir_fd=directory_fd,
                follow_symlinks=False)
    except FileExistsError as error:
        raise ValueError("evidence commit marker already exists; refusing to overwrite") from error
    except (OSError, TypeError) as error:
        raise ValueError("evidence commit marker could not be atomically published") from error
    try:
        os.unlink(temporary_name, dir_fd=directory_fd)
    except OSError as error:
        raise ValueError(
            "evidence commit marker temporary link could not be retired") from error
    os.fsync(directory_fd)


def _unique_json_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON object key")
        result[key] = value
    return result


def _reject_nonfinite_json(value):
    raise ValueError(f"non-finite JSON value is not allowed: {value}")


def _parse_json_object(payload, purpose):
    try:
        value = json.loads(
            payload.decode("utf-8"), object_pairs_hook=_unique_json_object,
            parse_constant=_reject_nonfinite_json)
    except (UnicodeDecodeError, ValueError) as error:
        raise ValueError(f"malformed {purpose}") from error
    if not isinstance(value, dict):
        raise ValueError(f"malformed {purpose}: expected an object")
    return value


def _repository_destination(destination_root):
    root = Path(destination_root)
    if not root.is_absolute():
        root = Path.cwd() / root
    repository = _observed_repository_root()
    resolved = Path(os.path.abspath(root))
    try:
        relative = resolved.relative_to(repository)
    except ValueError as error:
        raise ValueError("evidence destination must stay inside the repository") from error
    return repository, resolved, relative


def append_evidence(result, destination_root):
    """Write an evaluator-issued matrix and atomically publish its commit marker.

    The four scenario rows are written with exclusive no-follow creation, fsynced,
    then read back and checked against the exact expected scenario set and byte
    digests. Only then is the private commit manifest atomically linked into place.
    A failure before that final publication leaves any partial rows untrusted and
    uncommitted; they are never merged or removed. Consumers must use
    :func:`load_complete_matrix`, which rejects a missing or mismatched manifest.
    The marker proves file-set completeness only: it is not RC0 trust, a signature,
    aggregation eligibility, attestation, or product PASS evidence.
    """
    if not isinstance(result, dict) or result.get("status") != "READY":
        status = result.get("status") if isinstance(result, dict) else "invalid"
        raise ValueError(f"evidence is not READY: {status}; nothing was written")
    if (type(result) is not _EvaluatorIssuedReadyResult
            or not result._is_intact()):
        raise ValueError(
            "evidence is not an intact evaluator-issued READY result; nothing was written")
    authorization_reason = _authorization_reason()
    if authorization_reason:
        raise ValueError(
            f"workload authorization is no longer active: {authorization_reason}")
    if not result._authorization_is_current():
        raise ValueError("workload authorization changed after evaluation")
    registry = rc0.attestation_registry_status()
    if registry["status"] != "CONFIGURED":
        raise ValueError(
            "trusted attestation source is no longer configured: "
            + "; ".join(registry["contract_gaps"] or
                        ["trusted source/verifier registry is empty"]))
    if not result._attestation_sources_are_current():
        raise ValueError(
            "trusted attestation source or verifier used by this result has changed")
    if not _atomic_marker_publication_supported():
        raise ValueError("atomic evidence commit marker publication is unavailable")

    outputs = []
    for row in result["rows"]:
        scenario = row.get("scenario") if isinstance(row, dict) else None
        if type(scenario) is not int or scenario not in SCENARIOS:
            raise ValueError("evidence matrix has an invalid scenario identity")
        path = evidence_path(scenario, destination_root)
        try:
            payload = _evidence_row_bytes(row)
        except (TypeError, ValueError) as error:
            raise ValueError("evidence row cannot be serialized canonically") from error
        if len(payload) > MAX_EVIDENCE_ROW_BYTES:
            raise ValueError("evidence row exceeds its bounded size")
        outputs.append((scenario, path, payload))
    if [scenario for scenario, _path, _payload in outputs] != list(SCENARIOS):
        raise ValueError("evidence matrix does not contain the exact expected scenario set")

    repository, resolved, relative = _repository_destination(destination_root)
    directory_fd = _open_repository_directory(repository, relative.parts)
    try:
        expected_names = [path.name for _scenario, path, _payload in outputs]
        expected_names.append(COMMIT_MARKER_NAME)
        for name in expected_names:
            try:
                os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
            except FileNotFoundError:
                continue
            raise ValueError(
                f"evidence file already exists: {name}; refusing to overwrite or merge evidence")

        for _scenario, path, payload in outputs:
            _write_new_private_file(directory_fd, path.name, payload, "evidence file")
        os.fsync(directory_fd)

        file_refs = []
        for scenario, path, payload in outputs:
            actual = _read_private_file_at(
                directory_fd, path.name, "evidence row", MAX_EVIDENCE_ROW_BYTES)
            if actual != payload:
                raise ValueError(f"evidence row read-back mismatch: {path.name}")
            file_refs.append({
                "scenario": scenario,
                "name": path.name,
                "sha256": "sha256:" + hashlib.sha256(actual).hexdigest(),
            })

        marker_payload = _manifest_bytes(file_refs)
        _publish_commit_marker(directory_fd, marker_payload)
        marker_readback = _read_private_file_at(
            directory_fd, COMMIT_MARKER_NAME,
            "evidence commit manifest", MAX_COMMIT_MARKER_BYTES)
        if marker_readback != marker_payload:
            raise ValueError("evidence commit manifest read-back mismatch")
        return [path for _scenario, path, _payload in outputs] + [
            resolved / COMMIT_MARKER_NAME]
    finally:
        os.close(directory_fd)


def load_complete_matrix(destination_root):
    """Load only a fully committed matrix; never confer RC0 trust or eligibility."""
    repository, resolved, relative = _repository_destination(destination_root)
    directory_fd = _open_repository_directory(
        repository, relative.parts, create=False)
    try:
        marker_payload = _read_private_file_at(
            directory_fd, COMMIT_MARKER_NAME,
            "evidence commit manifest", MAX_COMMIT_MARKER_BYTES)
        marker = _parse_json_object(marker_payload, "evidence commit manifest")
        expected_keys = {
            "schemaVersion", "kind", "commitState", "trust",
            "aggregationEligible", "attestationEligible", "files", "matrixDigest",
        }
        if set(marker) != expected_keys:
            raise ValueError("malformed evidence commit manifest fields")
        if (type(marker["schemaVersion"]) is not int
                or marker["schemaVersion"] != COMMIT_MARKER_SCHEMA_VERSION
                or marker["kind"] != COMMIT_MARKER_KIND
                or marker["commitState"] != "COMMITTED"
                or marker["trust"] != "UNVERIFIED"
                or marker["aggregationEligible"] is not False
                or marker["attestationEligible"] is not False):
            raise ValueError("evidence commit manifest claims unsupported authority")
        base = {key: marker[key] for key in expected_keys - {"matrixDigest"}}
        expected_matrix_digest = (
            "sha256:" + hashlib.sha256(_canonical_json_bytes(base)).hexdigest())
        if marker["matrixDigest"] != expected_matrix_digest:
            raise ValueError("evidence commit manifest digest mismatch")
        files = marker["files"]
        if not isinstance(files, list) or len(files) != len(SCENARIOS):
            raise ValueError("evidence commit manifest has an incomplete file set")

        rows = []
        expected_file_keys = {"scenario", "name", "sha256"}
        for index, scenario in enumerate(SCENARIOS):
            file_ref = files[index]
            if (not isinstance(file_ref, dict)
                    or set(file_ref) != expected_file_keys
                    or type(file_ref["scenario"]) is not int
                    or file_ref["scenario"] != scenario):
                raise ValueError("evidence commit manifest scenario set mismatch")
            expected_name = evidence_path(scenario, resolved).name
            if file_ref["name"] != expected_name:
                raise ValueError("evidence commit manifest file name mismatch")
            row_payload = _read_private_file_at(
                directory_fd, expected_name, "evidence row", MAX_EVIDENCE_ROW_BYTES)
            expected_row_digest = (
                "sha256:" + hashlib.sha256(row_payload).hexdigest())
            if file_ref["sha256"] != expected_row_digest:
                raise ValueError("evidence row digest mismatch")
            row = _parse_json_object(row_payload, "evidence row")
            if (type(row.get("scenario")) is not int
                    or row["scenario"] != scenario
                    or row.get("record_type") != "rc0_baseline_evidence"):
                raise ValueError("evidence row identity mismatch")
            if _evidence_row_bytes(row) != row_payload:
                raise ValueError("evidence row encoding is not canonical")
            rows.append(row)

        return {
            "commit_state": "COMMITTED",
            "trust": "UNVERIFIED",
            "aggregation_eligible": False,
            "attestation_eligible": False,
            "matrix_digest": marker["matrixDigest"],
            "rows": rows,
        }
    finally:
        os.close(directory_fd)

if __name__ == "__main__":
    print(json.dumps({"status": "NOT_RUN",
                      "reason": _authorization_reason() or "candidate required"},
                     sort_keys=True))
