//! Fixed, offline-only execution fixture for exercising the production Runner.
//!
//! This module deliberately accepts no prompt, path, command, model, or provider
//! input. It does not construct an HTTP transport, claim OS sandbox enforcement,
//! or run an independent verifier. The returned workspace bytes are evidence
//! material for a caller to retain as a separate immutable artifact.

use std::sync::Arc;
use std::time::{Duration, Instant};

use chrono::{SecondsFormat, Utc};
use futures::{StreamExt, stream};
use horizoncode_provider::{ModelStream, Provider};
use horizoncode_runner::{RunConfig, RunEvent, RunObserver, Runner};
use horizoncode_sandbox::{ConfinementProfile, NetworkPolicy, ResolvedProfile};
use horizoncode_session::{ModelRef, SessionCreatedPayload, SessionStore, TurnEndStatus};
use horizoncode_tools::{
    BuiltinOptions, PermissionGate, PolicyGate, ToolRegistry, register_all_builtins,
};
use horizoncode_types::{
    CancelToken, FinishReason, ModelEvent, ModelRequest, ProviderError, SessionId,
};
use serde::Serialize;
use serde_json::json;
use thiserror::Error;

use crate::{MAX_RECORD_BYTES, Outcome, TerminalReason, seal_value, validate_bytes};

/// Hard maximum serialized observer trajectory bytes.
pub const MAX_TRAJECTORY_BYTES: usize = 256 * 1024;
/// Hard maximum observer events retained for the fixture.
pub const MAX_TRAJECTORY_EVENTS: usize = 256;
/// Hard maximum captured workspace bytes.
pub const MAX_WORKSPACE_BYTES: usize = 64 * 1024;
/// Hard maximum serialized workspace snapshot artifact bytes.
pub const MAX_WORKSPACE_SNAPSHOT_BYTES: usize = 4 * 1024 * 1024;
/// Maximum conservative JSON expansion budget for workspace paths, link targets,
/// entry metadata, and digests. File byte arrays have their own 64 KiB cap.
pub const MAX_WORKSPACE_METADATA_BYTES: usize = 2 * 1024 * 1024;
/// Hard wall-clock ceiling for the fixed fixture.
pub const FIXTURE_TIMEOUT: Duration = Duration::from_secs(5);
/// Fixed production loop step cap; it includes a bounded final response.
pub const FIXTURE_MAX_STEPS: usize = 4;
const TASK_PROMPT: &str =
    "Create hello.txt with exactly this text followed by a newline: hello from HorizonCode fixture";
const EXPECTED_FILE: &str = "hello.txt";
const EXPECTED_CONTENT: &str = "hello from HorizonCode fixture\n";
const TASK_ID: &str = "smoke-write-fixed-file-v1";
const FIXTURE_VERSION: &str = "hz-eval-smoke-v1";
const MAX_WORKSPACE_ENTRIES: usize = 4096;
const MAX_WORKSPACE_DEPTH: usize = 64;
const MAX_SYMLINK_TARGET_BYTES: usize = 1024;

/// One fixed relative file retained from the final fixture workspace.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct SnapshotFile {
    /// Relative path in the isolated workspace.
    pub path: String,
    /// Entry kind; directories and symlinks are represented without following them.
    pub kind: SnapshotEntryKind,
    /// Exact file bytes.
    pub bytes: Vec<u8>,
    /// Exact symlink target, when `kind` is `Symlink`.
    pub symlink_target: Option<String>,
    /// True only when file bytes had to be truncated at a hard capture bound.
    pub truncated: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SnapshotEntryKind {
    File,
    Directory,
    Symlink,
    Unsupported,
}

/// Result of exercising the production Runner with the deterministic fixture.
#[derive(Clone, Debug)]
pub struct FixtureExecution {
    /// Unique immutable attempt ID.
    pub evaluation_id: String,
    /// Actual terminal state emitted by the production Runner.
    pub status: TurnEndStatus,
    /// Typed terminal outcome independent of the verifier.
    pub outcome: Outcome,
    /// Stable typed terminal reason.
    pub terminal_reason: TerminalReason,
    /// Whether every event at the production observer boundary was captured.
    pub trajectory_complete: bool,
    /// Production Runner model-step count.
    pub steps: usize,
    /// Bounded prefix of observer events; may be incomplete when a capture cap is hit.
    pub trajectory: Vec<RunEvent>,
    /// Stable reason codes for observer events omitted at a configured bound.
    pub trajectory_gaps: Vec<String>,
    /// Serialized event bytes; callers digest and retain this separately.
    pub trajectory_bytes: Vec<u8>,
    /// Bounded fixed-file snapshot from the isolated final workspace.
    pub workspace_files: Vec<SnapshotFile>,
    /// Whether the full workspace tree was captured within declared bounds.
    pub workspace_capture_complete: bool,
    /// Stable capture gaps, if a filesystem limit or unsupported entry was encountered.
    pub workspace_capture_gaps: Vec<String>,
    /// Whether the tree violates the fixed task's allowed path set.
    pub unexpected_workspace_entries: bool,
    /// Whether the fixed escape-write attempt created a sibling outside the workspace.
    pub outside_target_created: bool,
    /// Digest of the empty initial workspace tree.
    pub initial_workspace_digest: String,
    /// Digest of the final fixed workspace tree.
    pub final_workspace_digest: String,
    /// Wall-clock timestamps and monotonic timing observed around the Runner.
    pub started_at: String,
    /// Wall-clock timestamp after the Runner returned.
    pub ended_at: String,
    /// Monotonic duration around the production Runner.
    pub total_duration_ms: u64,
    /// Elapsed Runner latency to the first successfully settled tool action.
    pub first_action_ms: Option<u64>,
    /// Digest of exact executable bytes.
    pub binary_digest: String,
    /// Digest of the exposed tool definitions.
    pub tool_schema_digest: String,
    /// Exact names advertised to the scripted provider.
    pub advertised_tools: Vec<String>,
    /// Digest of the fixture policy configuration.
    pub policy_snapshot_digest: String,
}

/// Fixed-fixture setup/execution failures. Messages contain no untrusted input.
#[derive(Debug, Error)]
pub enum FixtureError {
    /// A local temporary resource or session failed to initialize.
    #[error("fixture setup failed")]
    Setup,
    /// The production Runner could not complete within the fixed ceiling.
    #[error("fixture exceeded its five-second wall-time ceiling")]
    TimedOut,
    /// Observer capture exceeded its strict byte or event bounds.
    #[error("fixture trajectory exceeded its capture bounds")]
    TrajectoryLimit,
    /// The fixed workspace snapshot exceeded its strict byte bound.
    #[error("fixture workspace exceeded its capture bound")]
    WorkspaceLimit,
    /// The production Runner encountered an infrastructure failure.
    #[error("fixture Runner infrastructure failed")]
    Runner,
    /// Output root/attempt/artifact creation or durability failed.
    #[error("fixture artifact output failed")]
    Output,
    /// Artifact creation would overwrite prior evidence or follow a symlink.
    #[error("fixture output path is not a fresh safe directory")]
    OutputPath,
    /// The platform cannot guarantee owner-only artifact publication.
    #[error("private fixture artifact publication is unavailable on this platform or filesystem")]
    UnsupportedPlatform,
}

/// Metadata printed after immutable artifacts and a sealed record are written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FixtureReport {
    /// New attempt identifier.
    pub evaluation_id: String,
    /// New attempt directory relative to the provided output root.
    pub attempt_directory: String,
    /// Terminal Runner status.
    pub outcome: String,
    /// Verifier state, always `not_run` for this fixture.
    pub verifier_outcome: String,
}

#[derive(Serialize)]
struct WorkspaceSnapshot<'a> {
    schema_version: u32,
    complete: bool,
    gaps: &'a [String],
    files: Vec<SnapshotEntry<'a>>,
}

#[derive(Serialize)]
struct SnapshotEntry<'a> {
    path: &'a str,
    kind: SnapshotEntryKind,
    bytes: Option<&'a [u8]>,
    symlink_target: Option<&'a str>,
    truncated: bool,
    digest: String,
}

#[derive(Serialize)]
struct FixtureManifest<'a> {
    fixture_id: &'a str,
    fixture_version: &'a str,
    task_id: &'a str,
    prompt: &'a str,
    expected_path: &'a str,
    expected_output: &'a str,
    success_predicate: &'a str,
    allowed_paths: [&'a str; 1],
    tool_set_version: &'a str,
}

fn fixture_manifest() -> FixtureManifest<'static> {
    FixtureManifest {
        fixture_id: "hz-eval-smoke",
        fixture_version: FIXTURE_VERSION,
        task_id: TASK_ID,
        prompt: TASK_PROMPT,
        expected_path: EXPECTED_FILE,
        expected_output: EXPECTED_CONTENT,
        success_predicate: "runner_completed_and_workspace_contains_only_expected_file_with_exact_bytes_v1",
        allowed_paths: [EXPECTED_FILE],
        tool_set_version: "workspace-scoped-builtins-minus-bash-v1",
    }
}

/// Executes the sole public fixture through the production Runner.
pub async fn execute_smoke() -> Result<FixtureExecution, FixtureError> {
    let id = evaluation_id();
    execute_with(ProviderMode::Smoke, FIXTURE_MAX_STEPS, false, id).await
}

/// Executes the fixed smoke fixture and retains the three independent artifacts.
/// The output root must already exist and must not itself be a symlink.
pub async fn run_smoke(output_dir: &std::path::Path) -> Result<FixtureReport, FixtureError> {
    run_mode_to(output_dir, ProviderMode::Smoke, FIXTURE_MAX_STEPS, false).await
}

async fn run_mode_to(
    output_dir: &std::path::Path,
    mode: ProviderMode,
    max_steps: usize,
    pre_cancel: bool,
) -> Result<FixtureReport, FixtureError> {
    run_mode_to_id(output_dir, mode, max_steps, pre_cancel, evaluation_id()).await
}

async fn run_mode_to_id(
    output_dir: &std::path::Path,
    mode: ProviderMode,
    max_steps: usize,
    pre_cancel: bool,
    id: String,
) -> Result<FixtureReport, FixtureError> {
    run_mode_to_id_with_capture_limits(
        output_dir,
        mode,
        max_steps,
        pre_cancel,
        id,
        MAX_TRAJECTORY_BYTES,
        MAX_TRAJECTORY_EVENTS,
    )
    .await
}

async fn run_mode_to_id_with_capture_limits(
    output_dir: &std::path::Path,
    mode: ProviderMode,
    max_steps: usize,
    pre_cancel: bool,
    id: String,
    trajectory_byte_limit: usize,
    trajectory_event_limit: usize,
) -> Result<FixtureReport, FixtureError> {
    if !cfg!(unix) {
        return Err(FixtureError::UnsupportedPlatform);
    }
    let output_root = prepare_output_root(output_dir)?;
    probe_output_publication(&output_root)?;
    let attempt_dir = output_root.join(&id);
    std::fs::create_dir(&attempt_dir).map_err(|_| FixtureError::OutputPath)?;
    horizoncode_config::state_fs::set_owner_only(
        &attempt_dir,
        horizoncode_config::state_fs::OwnerOnly::Directory,
    )
    .map_err(|_| FixtureError::Output)?;
    let execution = match execute_with_capture_limits(
        mode,
        max_steps,
        pre_cancel,
        id,
        trajectory_byte_limit,
        trajectory_event_limit,
    )
    .await
    {
        Ok(execution) => execution,
        Err(error) => {
            let _ = std::fs::remove_dir(&attempt_dir);
            return Err(error);
        }
    };
    horizoncode_config::state_fs::refuse_group_or_other_access(
        &attempt_dir,
        horizoncode_config::state_fs::OwnerOnly::Directory,
    )
    .map_err(|_| FixtureError::Output)?;

    let trajectory_digest = write_artifact(
        &attempt_dir.join("trajectory.json"),
        &execution.trajectory_bytes,
        MAX_TRAJECTORY_BYTES,
    )?;
    let snapshot = workspace_snapshot(&WorkspaceCapture {
        entries: execution.workspace_files.clone(),
        complete: execution.workspace_capture_complete,
        gaps: execution.workspace_capture_gaps.clone(),
    })?;
    let snapshot_digest = write_artifact(
        &attempt_dir.join("workspace.snapshot.json"),
        &snapshot,
        MAX_WORKSPACE_SNAPSHOT_BYTES,
    )?;
    let mut record = smoke_record(&execution, &trajectory_digest, &snapshot_digest)?;
    seal_value(&mut record).map_err(|_| FixtureError::Output)?;
    let record_bytes = serde_json::to_vec(&record).map_err(|_| FixtureError::Output)?;
    if record_bytes.len() > MAX_RECORD_BYTES {
        return Err(FixtureError::Output);
    }
    validate_bytes(&record_bytes).map_err(|_| FixtureError::Output)?;
    write_sealed_record(&attempt_dir, &record_bytes)?;
    Ok(FixtureReport {
        evaluation_id: execution.evaluation_id,
        attempt_directory: attempt_dir
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or(FixtureError::Output)?
            .to_owned(),
        outcome: outcome_name(execution.outcome).to_owned(),
        verifier_outcome: "not_run".to_owned(),
    })
}

/// Verify the selected output filesystem before creating any evidence artifacts.
/// The temporary probe checks owner-only modes, hard-link creation, no-replace
/// behavior when a destination exists, and directory sync used by publication.
fn probe_output_publication(root: &std::path::Path) -> Result<(), FixtureError> {
    if !cfg!(unix) {
        return Err(FixtureError::UnsupportedPlatform);
    }
    let probe = tempfile::Builder::new()
        .prefix(".hz-eval-publication-probe-")
        .tempdir_in(root)
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    horizoncode_config::state_fs::set_owner_only(
        probe.path(),
        horizoncode_config::state_fs::OwnerOnly::Directory,
    )
    .map_err(|_| FixtureError::UnsupportedPlatform)?;
    horizoncode_config::state_fs::refuse_group_or_other_access(
        probe.path(),
        horizoncode_config::state_fs::OwnerOnly::Directory,
    )
    .map_err(|_| FixtureError::UnsupportedPlatform)?;

    let source = probe.path().join("source");
    let linked = probe.path().join("linked");
    let occupied = probe.path().join("occupied");
    use std::io::Write;
    let mut source_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&source)
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    horizoncode_config::state_fs::set_owner_only(
        &source,
        horizoncode_config::state_fs::OwnerOnly::File,
    )
    .map_err(|_| FixtureError::UnsupportedPlatform)?;
    source_file
        .write_all(b"hz-eval publication capability probe")
        .and_then(|()| source_file.sync_all())
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    horizoncode_config::state_fs::refuse_group_or_other_access(
        &source,
        horizoncode_config::state_fs::OwnerOnly::File,
    )
    .map_err(|_| FixtureError::UnsupportedPlatform)?;
    drop(source_file);

    std::fs::hard_link(&source, &linked).map_err(|_| FixtureError::UnsupportedPlatform)?;
    horizoncode_config::state_fs::refuse_group_or_other_access(
        &linked,
        horizoncode_config::state_fs::OwnerOnly::File,
    )
    .map_err(|_| FixtureError::UnsupportedPlatform)?;
    if std::fs::read(&linked).ok().as_deref() != Some(b"hz-eval publication capability probe") {
        return Err(FixtureError::UnsupportedPlatform);
    }
    let mut occupied_file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&occupied)
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    occupied_file
        .write_all(b"must remain unchanged")
        .and_then(|()| occupied_file.sync_all())
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    drop(occupied_file);
    let no_replace = matches!(
        std::fs::hard_link(&source, &occupied),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists
    );
    if !no_replace || std::fs::read(&occupied).ok().as_deref() != Some(b"must remain unchanged") {
        return Err(FixtureError::UnsupportedPlatform);
    }
    std::fs::File::open(probe.path())
        .and_then(|directory| directory.sync_all())
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    std::fs::File::open(root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    probe
        .close()
        .map_err(|_| FixtureError::UnsupportedPlatform)?;
    Ok(())
}

fn prepare_output_root(path: &std::path::Path) -> Result<std::path::PathBuf, FixtureError> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err(FixtureError::OutputPath);
            }
            std::fs::canonicalize(path).map_err(|_| FixtureError::OutputPath)
        }
        Err(_) => Err(FixtureError::OutputPath),
    }
}

fn write_artifact(
    path: &std::path::Path,
    bytes: &[u8],
    max_bytes: usize,
) -> Result<String, FixtureError> {
    if bytes.len() > max_bytes {
        return Err(FixtureError::Output);
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|_| FixtureError::OutputPath)?;
    horizoncode_config::state_fs::set_owner_only(
        path,
        horizoncode_config::state_fs::OwnerOnly::File,
    )
    .map_err(|_| FixtureError::Output)?;
    use std::io::Write;
    file.write_all(bytes).map_err(|_| FixtureError::Output)?;
    file.sync_all().map_err(|_| FixtureError::Output)?;
    drop(file);
    let stored = std::fs::read(path).map_err(|_| FixtureError::Output)?;
    if stored != bytes {
        return Err(FixtureError::Output);
    }
    Ok(blake3_digest(&stored))
}

fn workspace_snapshot(capture: &WorkspaceCapture) -> Result<Vec<u8>, FixtureError> {
    let entries = capture
        .entries
        .iter()
        .map(|file| {
            Ok(SnapshotEntry {
                path: &file.path,
                kind: file.kind,
                bytes: (file.kind == SnapshotEntryKind::File).then_some(file.bytes.as_slice()),
                symlink_target: file.symlink_target.as_deref(),
                truncated: file.truncated,
                digest: digest_json(&(
                    file.kind,
                    &file.path,
                    &file.bytes,
                    &file.symlink_target,
                    file.truncated,
                ))?,
            })
        })
        .collect::<Result<Vec<_>, FixtureError>>()?;
    serde_json::to_vec(&WorkspaceSnapshot {
        schema_version: 1,
        complete: capture.complete,
        gaps: &capture.gaps,
        files: entries,
    })
    .map_err(|_| FixtureError::Output)
}

#[derive(Clone, Debug, Serialize)]
struct WorkspaceCapture {
    entries: Vec<SnapshotFile>,
    complete: bool,
    gaps: Vec<String>,
}

fn write_sealed_record(attempt_dir: &std::path::Path, bytes: &[u8]) -> Result<(), FixtureError> {
    let staging = attempt_dir.join("record.staging");
    let final_path = attempt_dir.join("record.json");
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&staging)
        .map_err(|_| FixtureError::OutputPath)?;
    horizoncode_config::state_fs::set_owner_only(
        &staging,
        horizoncode_config::state_fs::OwnerOnly::File,
    )
    .map_err(|_| FixtureError::Output)?;
    use std::io::Write;
    file.write_all(bytes).map_err(|_| FixtureError::Output)?;
    file.sync_all().map_err(|_| FixtureError::Output)?;
    drop(file);
    // A hard link publishes the completed record atomically and fails if its
    // destination exists; rename is intentionally avoided because it replaces.
    std::fs::hard_link(&staging, &final_path).map_err(|_| FixtureError::Output)?;
    let published = std::fs::read(&final_path).map_err(|_| FixtureError::Output)?;
    if published != bytes {
        let _ = std::fs::remove_file(&final_path);
        return Err(FixtureError::Output);
    }
    std::fs::remove_file(staging).map_err(|_| FixtureError::Output)?;
    std::fs::File::open(attempt_dir)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| FixtureError::Output)?;
    Ok(())
}

fn smoke_record(
    execution: &FixtureExecution,
    trajectory_digest: &str,
    snapshot_digest: &str,
) -> Result<serde_json::Value, FixtureError> {
    let unknown = |reason: &str| json!({"state":"unknown","reason":reason});
    let reported = |value: serde_json::Value| json!({"state":"reported","value":value});
    let unknown_counts = || {
        json!({
            "attempted":unknown("fixture_does_not_collect_lifecycle_metrics"),
            "started":unknown("fixture_does_not_collect_lifecycle_metrics"),
            "completed":unknown("fixture_does_not_collect_lifecycle_metrics"),
            "failed":unknown("fixture_does_not_collect_lifecycle_metrics"),
            "cancelled":unknown("fixture_does_not_collect_lifecycle_metrics")
        })
    };
    let initial_revision = format!("tree-digest:{}", execution.initial_workspace_digest);
    let final_revision = if execution.workspace_capture_complete {
        format!("tree-digest:{}", execution.final_workspace_digest)
    } else {
        "unknown:workspace_capture_incomplete".to_owned()
    };
    let trajectory_ref = format!("artifact:{}-trajectory", execution.evaluation_id);
    let snapshot_ref = format!("artifact:{}-workspace", execution.evaluation_id);
    let manifest = fixture_manifest();
    let dataset_digest = digest_json(&manifest)?;
    let criteria_digest = digest_json(&(
        manifest.fixture_id,
        manifest.fixture_version,
        manifest.task_id,
        manifest.expected_path,
        manifest.expected_output,
        manifest.success_predicate,
        manifest.allowed_paths,
    ))?;
    let outcome = match execution.outcome {
        Outcome::Completed => ("completed", "completed"),
        Outcome::Failed => ("failed", "task_failed"),
        Outcome::HarnessFailure => ("harness_failure", "harness_failure"),
        Outcome::Cancelled => ("cancelled", "cancelled"),
        Outcome::TimedOut => ("timed_out", "timeout"),
        Outcome::ProviderFailure => ("provider_failure", "provider_failure"),
        Outcome::InsufficientEvidence => ("insufficient_evidence", "insufficient_evidence"),
        Outcome::SetupFailure => ("setup_failure", "setup_failure"),
        Outcome::Unsupported => ("unsupported", "unsupported"),
    };
    let elapsed = reported(json!(execution.total_duration_ms));
    let first_action = execution
        .first_action_ms
        .map(|value| reported(json!(value)))
        .unwrap_or_else(|| unknown("not_observed"));
    Ok(json!({
        "schema_version": 1,
        "evaluation_id": execution.evaluation_id,
        "evaluation_group_id": format!("group-{}", execution.evaluation_id),
        "attempt_number": 1,
        "retry_of": null,
        "benchmark_id": "HZBench-Dev",
        "benchmark_version": "1",
        "dataset_digest": dataset_digest,
        "criteria_digest": criteria_digest,
        "split": "dev",
        "task_id": TASK_ID,
        "task_digest": digest_text(TASK_PROMPT.as_bytes()),
        "task_stratum": "runner_mechanics",
        "repository_identity": "fixture:isolated-temporary-workspace",
        "start_revision": initial_revision,
        "integrated_revision": final_revision,
        "tested_revision": final_revision,
        "initial_workspace_digest": execution.initial_workspace_digest,
        "final_workspace_digest": if execution.workspace_capture_complete {
            reported(json!(execution.final_workspace_digest))
        } else {
            unknown("workspace_capture_incomplete")
        },
        "workspace_snapshot": {"reference": snapshot_ref, "digest": snapshot_digest},
        "harness_id": "horizoncode",
        "harness_revision": "unknown:source_revision_not_embedded",
        "binary_digest": execution.binary_digest,
        "harness_config_digest": digest_json(&(
            &manifest,
            &execution.tool_schema_digest,
            &execution.policy_snapshot_digest,
        ))?,
        "model_id": reported(json!("hz-eval-smoke-v1")),
        "provider_id": reported(json!("hz-eval-scripted")),
        "route_id": reported(json!("in-process-fixture-v1")),
        "route_version": unknown("not_applicable"),
        "reasoning_setting": unknown("not_applicable"),
        "model_capability_snapshot": unknown("not_applicable"),
        "prompt_digest": digest_json(&(manifest.task_id, manifest.prompt))?,
        "tool_schema_digest": execution.tool_schema_digest,
        "policy_snapshot_digest": execution.policy_snapshot_digest,
        "environment_digest": digest_text(format!("{}:{}:eval-crate-{}", std::env::consts::OS, std::env::consts::ARCH, env!("CARGO_PKG_VERSION")).as_bytes()),
        "limits": [
            {"name":"wall_time_ms", "value":FIXTURE_TIMEOUT.as_millis(), "enforcement":"enforced"},
            {"name":"model_steps", "value":FIXTURE_MAX_STEPS, "enforcement":"enforced"},
            {"name":"tool_calls_per_response", "value":1, "enforcement":"enforced"},
            {"name":"trajectory_bytes", "value":MAX_TRAJECTORY_BYTES, "enforcement":"enforced"},
            {"name":"workspace_bytes", "value":MAX_WORKSPACE_BYTES, "enforcement":"enforced"},
            {"name":"workspace_snapshot_bytes", "value":MAX_WORKSPACE_SNAPSHOT_BYTES, "enforcement":"enforced"},
            {"name":"workspace_metadata_bytes", "value":MAX_WORKSPACE_METADATA_BYTES, "enforcement":"enforced"}
        ],
        "network_policy_digest": digest_json(&("network-none", "scripted-provider", "no-shell-authorized"))?,
        "seed": null,
        "repetition": 1,
        "run_order": 1,
        "paired_run_id": null,
        "trajectory": {
            "reference": trajectory_ref,
            "digest": trajectory_digest,
            "completeness": if execution.trajectory_complete { "complete" } else { "incomplete" },
            "redaction": "not_required",
            "event_gaps": execution.trajectory_gaps
        },
        "timing": {
            "started_at": execution.started_at,
            "ended_at": execution.ended_at,
            "first_action_ms": first_action,
            "first_model_token_ms": unknown("provider_interface_has_no_token_boundary"),
            "pre_model_overhead_ms": unknown("not_measured"),
            "total_duration_ms": elapsed,
            "durations_ms": {"runner": elapsed}
        },
        "usage": {
            "input_tokens": unknown("provider_usage_not_reported"),
            "output_tokens": unknown("provider_usage_not_reported"),
            "cache_read_tokens": unknown("provider_usage_not_reported"),
            "cache_write_tokens": unknown("provider_usage_not_reported"),
            "cost": unknown("not_applicable"),
            "context": {"bytes":unknown("not_measured"),"tokens":unknown("not_measured"),"tokenizer_id":unknown("not_measured")},
            "resources": {"cpu_time_ms":unknown("not_measured"),"peak_rss_bytes":unknown("not_measured"),"peak_pss_bytes":unknown("not_measured"),"disk_read_bytes":unknown("not_measured"),"disk_write_bytes":unknown("not_measured")}
        },
        "model_call_counts": unknown_counts(),
        "tool_counts": unknown_counts(),
        "tool_counts_by_category": unknown("fixture_does_not_collect_lifecycle_metrics"),
        "file_read_counts": unknown("not_measured"),
        "repeat_read_counts": unknown("not_measured"),
        "search_counts": unknown("not_measured"),
        "failed_tool_counts": unknown("not_measured"),
        "patch_retry_counts": unknown("not_measured"),
        "check_counts": unknown("not_measured"),
        "human_interventions": [],
        "verifier_id": null,
        "verifier_version": null,
        "verifier_environment_digest": null,
        "verifier_result_ref": null,
        "verifier_result_digest": null,
        "verifier_outcome": "not_run",
        "regressions": [],
        "outcome": outcome.0,
        "terminal_reason": outcome.1,
        "limitations": ["mechanics_fixture_only", "independent_verifier_not_run", "telemetry_unavailable", "source_revision_not_embedded"],
        "record_digest": ""
    }))
}

fn digest_json(value: &impl Serialize) -> Result<String, FixtureError> {
    serde_json::to_vec(value)
        .map(|bytes| blake3_digest(&bytes))
        .map_err(|_| FixtureError::Setup)
}

fn tree_digest(capture: &WorkspaceCapture) -> Result<String, FixtureError> {
    let bytes = serde_json::to_vec(capture).map_err(|_| FixtureError::Setup)?;
    Ok(digest_text(&bytes))
}

fn digest_text(bytes: &[u8]) -> String {
    blake3_digest(bytes)
}

fn blake3_digest(bytes: &[u8]) -> String {
    format!("blake3:{}", blake3::hash(bytes).to_hex())
}

fn executable_digest() -> Result<String, FixtureError> {
    let executable = std::env::current_exe().map_err(|_| FixtureError::Setup)?;
    let metadata = std::fs::metadata(&executable).map_err(|_| FixtureError::Setup)?;
    if metadata.len() > 256 * 1024 * 1024 {
        return Err(FixtureError::WorkspaceLimit);
    }
    let bytes = std::fs::read(executable).map_err(|_| FixtureError::Setup)?;
    Ok(blake3_digest(&bytes))
}

fn outcome_name(outcome: Outcome) -> &'static str {
    match outcome {
        Outcome::Completed => "completed",
        Outcome::Failed => "failed",
        Outcome::HarnessFailure => "harness_failure",
        Outcome::Cancelled => "cancelled",
        Outcome::TimedOut => "timed_out",
        Outcome::ProviderFailure => "provider_failure",
        Outcome::InsufficientEvidence => "insufficient_evidence",
        Outcome::SetupFailure => "setup_failure",
        Outcome::Unsupported => "unsupported",
    }
}

#[derive(Clone, Copy, Debug)]
#[cfg_attr(not(test), allow(dead_code))]
enum ProviderMode {
    Smoke,
    ProviderFailure,
    EscapeWrite,
    Pending,
    UnexpectedFile,
    WorkspaceOverflow,
    WorkspaceSymlink,
}

#[derive(Debug)]
struct ScriptedProvider {
    mode: ProviderMode,
    calls: std::sync::atomic::AtomicUsize,
}

#[async_trait::async_trait]
impl Provider for ScriptedProvider {
    fn name(&self) -> &str {
        "hz-eval-scripted"
    }

    fn model(&self) -> &str {
        "hz-eval-smoke-v1"
    }

    async fn stream(
        &self,
        _request: ModelRequest,
        _cancel: CancelToken,
    ) -> Result<ModelStream, ProviderError> {
        use std::sync::atomic::Ordering;

        let call = self.calls.fetch_add(1, Ordering::Relaxed);
        if matches!(self.mode, ProviderMode::ProviderFailure) {
            return Ok(stream::iter(vec![Err(ProviderError::provider_internal(
                "fixed fixture provider failure",
            ))])
            .boxed());
        }
        if matches!(self.mode, ProviderMode::Pending) {
            return Ok(stream::pending().boxed());
        }
        let events = if call == 0 {
            let path = if matches!(self.mode, ProviderMode::EscapeWrite) {
                "../outside.txt"
            } else {
                EXPECTED_FILE
            };
            vec![
                ModelEvent::Started,
                ModelEvent::ToolCallDelta {
                    index: 0,
                    id: Some("call_fixture_write".to_owned()),
                    name: Some("write".to_owned()),
                    arguments_delta: serde_json::to_string(&json!({
                        "path": path,
                        "content": EXPECTED_CONTENT
                    }))
                    .expect("fixed JSON serializes"),
                },
                ModelEvent::Finished {
                    reason: FinishReason::ToolCalls,
                },
            ]
        } else {
            vec![
                ModelEvent::Started,
                ModelEvent::TextDelta {
                    text: "Created hello.txt.".to_owned(),
                },
                ModelEvent::Finished {
                    reason: FinishReason::Stop,
                },
            ]
        };
        Ok(stream::iter(events.into_iter().map(Ok)).boxed())
    }
}

struct BoundedObserver {
    events: Vec<RunEvent>,
    bytes: usize,
    overflow: bool,
    max_bytes: usize,
    max_events: usize,
    run_started: Option<Instant>,
    first_action_ms: Option<u64>,
}

impl Default for BoundedObserver {
    fn default() -> Self {
        Self {
            events: Vec::new(),
            bytes: 0,
            overflow: false,
            max_bytes: MAX_TRAJECTORY_BYTES,
            max_events: MAX_TRAJECTORY_EVENTS,
            run_started: None,
            first_action_ms: None,
        }
    }
}

impl RunObserver for BoundedObserver {
    fn on_event(&mut self, event: RunEvent) {
        if self.overflow || self.events.len() >= self.max_events {
            self.overflow = true;
            return;
        }
        let Ok(encoded) = serde_json::to_vec(&event) else {
            self.overflow = true;
            return;
        };
        // Count the JSON array brackets and separators too, so the retained
        // prefix always serializes within the artifact ceiling.
        let framing_bytes = if self.events.is_empty() { 2 } else { 1 };
        let Some(new_size) = self
            .bytes
            .checked_add(encoded.len())
            .and_then(|size| size.checked_add(framing_bytes))
        else {
            self.overflow = true;
            return;
        };
        if new_size > self.max_bytes {
            self.overflow = true;
            return;
        }
        self.bytes = new_size;
        if self.first_action_ms.is_none()
            && matches!(&event, RunEvent::ToolFinished { settlement } if settlement.status == horizoncode_types::ToolStatus::Success)
        {
            self.first_action_ms = self
                .run_started
                .map(|start| u64::try_from(start.elapsed().as_millis()).unwrap_or(u64::MAX));
        }
        self.events.push(event);
    }
}

async fn execute_with(
    mode: ProviderMode,
    max_steps: usize,
    pre_cancel: bool,
    evaluation_id: String,
) -> Result<FixtureExecution, FixtureError> {
    execute_with_capture_limits(
        mode,
        max_steps,
        pre_cancel,
        evaluation_id,
        MAX_TRAJECTORY_BYTES,
        MAX_TRAJECTORY_EVENTS,
    )
    .await
}

async fn execute_with_capture_limits(
    mode: ProviderMode,
    max_steps: usize,
    pre_cancel: bool,
    evaluation_id: String,
    trajectory_byte_limit: usize,
    trajectory_event_limit: usize,
) -> Result<FixtureExecution, FixtureError> {
    let root = tempfile::tempdir().map_err(|_| FixtureError::Setup)?;
    let workspace = root.path().join("workspace");
    std::fs::create_dir(&workspace).map_err(|_| FixtureError::Setup)?;
    let initial_capture = capture_workspace_tree(&workspace);
    let session_dir = root.path().join("sessions");
    let store = Arc::new(SessionStore::open(session_dir).map_err(|_| FixtureError::Setup)?);
    let session = store
        .create(SessionCreatedPayload::new(
            "fixture:hz-eval-smoke-v1",
            "Offline smoke fixture",
            ModelRef {
                id: "hz-eval-smoke-v1".to_owned(),
                provider: "hz-eval-scripted".to_owned(),
                variant: None,
            },
            "chat",
            json!({"fixture": "hz-eval-smoke-v1", "network": "none"}),
        ))
        .map_err(|_| FixtureError::Setup)?;

    let mut registry = ToolRegistry::new();
    register_all_builtins(&mut registry, BuiltinOptions::headless())
        .map_err(|_| FixtureError::Setup)?;
    let registry = Arc::new(registry);
    let policy: Arc<dyn PermissionGate> = Arc::new(
        PolicyGate::read_only()
            .allow(["edit".to_owned()])
            .deny(["bash".to_owned()]),
    );
    let materialized = registry.materialize(policy.as_ref());
    let tool_schema_digest = digest_json(&materialized.definitions)?;
    let policy_snapshot_digest = digest_json(&json!({
        "fixture": "hz-eval-smoke-v1",
        "advertised_tools": &materialized.names,
        "allowed_actions": ["edit", "glob", "grep", "list", "read"],
        "network": "none"
    }))?;
    let requested = ConfinementProfile::workspace_write(&workspace)
        .with_network(NetworkPolicy::None)
        .with_limits(horizoncode_sandbox::Limits {
            wall_clock_ms: Some(FIXTURE_TIMEOUT.as_millis() as u64),
            max_output_bytes: 64 * 1024,
        });
    let resolved = ResolvedProfile {
        backend: "fixture-path-guard".to_owned(),
        profile: requested.profile,
        network: requested.network.clone(),
        workspace: requested.workspace.clone(),
        writable_roots: requested.writable_roots(),
        readable_roots: requested.readable_roots(),
        protected: requested.protected.clone(),
        deny: requested.deny.clone(),
        session_dir: requested.session_dir.clone(),
        limits: requested.limits,
        applied: Vec::new(),
        epoch: 1,
        bare: false,
    };
    let provider: Arc<dyn Provider> = Arc::new(ScriptedProvider {
        mode,
        calls: std::sync::atomic::AtomicUsize::new(0),
    });
    let runner = Runner::new(
        provider,
        registry,
        store,
        policy,
        RunConfig {
            model: "hz-eval-smoke-v1".to_owned(),
            provider: "hz-eval-scripted".to_owned(),
            workspace: workspace.clone(),
            max_steps,
            max_tool_calls_per_response: 1,
            max_tool_argument_bytes_per_response: 1024,
            max_response_bytes: 2048,
            max_parallel_tools: 1,
            sandbox_resolved: Some(Arc::new(resolved)),
            ..RunConfig::default()
        },
    );
    let cancel = CancelToken::new();
    if pre_cancel {
        cancel.cancel();
    }
    let started_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let run_started = Instant::now();
    let mut observer = BoundedObserver {
        max_bytes: trajectory_byte_limit,
        max_events: trajectory_event_limit,
        run_started: Some(run_started),
        ..BoundedObserver::default()
    };
    let (run_result, timed_out) = {
        let run_future = runner.run_turn(&session.id, TASK_PROMPT, cancel.clone(), &mut observer);
        tokio::pin!(run_future);
        let deadline = tokio::time::Instant::now() + FIXTURE_TIMEOUT;
        let cancellation_deadline = deadline - Duration::from_millis(250);
        tokio::select! {
            result = &mut run_future => (Some(result), false),
            () = tokio::time::sleep_until(cancellation_deadline) => {
                cancel.cancel();
                let terminal = tokio::time::timeout_at(deadline, &mut run_future).await.ok();
                (terminal, true)
            }
        }
    };
    let total_duration_ms = u64::try_from(run_started.elapsed().as_millis()).unwrap_or(u64::MAX);
    let ended_at = Utc::now().to_rfc3339_opts(SecondsFormat::Millis, true);
    let (status, mut outcome_kind, mut terminal_reason, steps) = if timed_out {
        (
            TurnEndStatus::Interrupted,
            Outcome::TimedOut,
            TerminalReason::Timeout,
            run_result
                .and_then(Result::ok)
                .map_or(0, |outcome| outcome.steps),
        )
    } else {
        match run_result.expect("non-timeout branch returns a Runner result") {
            Ok(outcome) => {
                let (kind, reason) = match (mode, outcome.status) {
                    (ProviderMode::ProviderFailure, _) => {
                        (Outcome::ProviderFailure, TerminalReason::ProviderFailure)
                    }
                    (_, TurnEndStatus::Completed) => {
                        (Outcome::Completed, TerminalReason::Completed)
                    }
                    (_, TurnEndStatus::Failed | TurnEndStatus::Declined) => {
                        (Outcome::Failed, TerminalReason::TaskFailed)
                    }
                    (_, TurnEndStatus::Interrupted) => {
                        (Outcome::Cancelled, TerminalReason::Cancelled)
                    }
                    (_, TurnEndStatus::Partial) => (
                        Outcome::InsufficientEvidence,
                        TerminalReason::InsufficientEvidence,
                    ),
                };
                (outcome.status, kind, reason, outcome.steps)
            }
            Err(_) => (
                TurnEndStatus::Failed,
                Outcome::HarnessFailure,
                TerminalReason::HarnessFailure,
                0,
            ),
        }
    };
    if observer.overflow {
        outcome_kind = Outcome::InsufficientEvidence;
        terminal_reason = TerminalReason::InsufficientEvidence;
    }
    let trajectory_bytes =
        serde_json::to_vec(&observer.events).map_err(|_| FixtureError::Runner)?;
    if trajectory_bytes.len() > MAX_TRAJECTORY_BYTES {
        return Err(FixtureError::TrajectoryLimit);
    }
    match mode {
        ProviderMode::UnexpectedFile => {
            std::fs::write(workspace.join("surprise.txt"), b"unexpected fixture file\n")
                .map_err(|_| FixtureError::Setup)?
        }
        ProviderMode::WorkspaceOverflow => std::fs::write(
            workspace.join("oversized.txt"),
            vec![b'x'; MAX_WORKSPACE_BYTES + 1],
        )
        .map_err(|_| FixtureError::Setup)?,
        #[cfg(unix)]
        ProviderMode::WorkspaceSymlink => {
            std::os::unix::fs::symlink(root.path().join("outside-target"), workspace.join("linked"))
                .map_err(|_| FixtureError::Setup)?
        }
        _ => (),
    }
    let workspace_capture = capture_workspace_tree(&workspace);
    let unexpected_workspace_entries = workspace_capture
        .entries
        .iter()
        .any(|entry| entry.kind != SnapshotEntryKind::File || entry.path != EXPECTED_FILE);
    let smoke_result_ok = status == TurnEndStatus::Completed
        && workspace_capture.complete
        && !unexpected_workspace_entries
        && workspace_capture.entries.len() == 1
        && workspace_capture.entries[0].path == EXPECTED_FILE
        && workspace_capture.entries[0].bytes == EXPECTED_CONTENT.as_bytes();
    let (outcome_kind, terminal_reason) = if !workspace_capture.complete {
        (
            Outcome::InsufficientEvidence,
            TerminalReason::InsufficientEvidence,
        )
    } else if matches!(
        mode,
        ProviderMode::Smoke
            | ProviderMode::UnexpectedFile
            | ProviderMode::WorkspaceOverflow
            | ProviderMode::WorkspaceSymlink
    ) && max_steps == FIXTURE_MAX_STEPS
        && !smoke_result_ok
    {
        (Outcome::Failed, TerminalReason::TaskFailed)
    } else {
        (outcome_kind, terminal_reason)
    };
    let outside_target_created = root.path().join("outside.txt").exists();
    let initial_workspace_digest = tree_digest(&initial_capture)?;
    let final_workspace_digest = tree_digest(&workspace_capture)?;
    let binary_digest = executable_digest()?;
    Ok(FixtureExecution {
        evaluation_id,
        status,
        outcome: outcome_kind,
        terminal_reason,
        trajectory_complete: observer
            .events
            .last()
            .is_some_and(|event| matches!(event, RunEvent::TurnFinished { .. }))
            && !observer.overflow,
        trajectory_gaps: if observer.overflow {
            vec!["trajectory_capture_limit".to_owned()]
        } else if observer
            .events
            .last()
            .is_some_and(|event| matches!(event, RunEvent::TurnFinished { .. }))
        {
            Vec::new()
        } else {
            vec!["runner_terminal_not_observed".to_owned()]
        },
        steps,
        trajectory: observer.events,
        trajectory_bytes,
        workspace_files: workspace_capture.entries,
        workspace_capture_complete: workspace_capture.complete,
        workspace_capture_gaps: workspace_capture.gaps,
        unexpected_workspace_entries,
        outside_target_created,
        initial_workspace_digest,
        final_workspace_digest,
        started_at,
        ended_at,
        total_duration_ms,
        first_action_ms: observer.first_action_ms,
        binary_digest,
        tool_schema_digest,
        advertised_tools: materialized.names,
        policy_snapshot_digest,
    })
}

fn evaluation_id() -> String {
    let session = SessionId::generate();
    format!(
        "eval-smoke-{}",
        session.as_str().strip_prefix("ses_").unwrap_or("invalid")
    )
}

fn capture_workspace_tree(root: &std::path::Path) -> WorkspaceCapture {
    fn add_gap(capture: &mut WorkspaceCapture, gap: &str) {
        capture.complete = false;
        if capture.gaps.len() < 16 && !capture.gaps.iter().any(|existing| existing == gap) {
            capture.gaps.push(gap.to_owned());
        }
    }
    fn visit(
        root: &std::path::Path,
        directory: &std::path::Path,
        capture: &mut WorkspaceCapture,
        total_bytes: &mut usize,
        total_metadata_bytes: &mut usize,
        total_entries: &mut usize,
        depth: usize,
    ) {
        if depth > MAX_WORKSPACE_DEPTH {
            add_gap(capture, "workspace_depth_limit");
            return;
        }
        let read_dir = match std::fs::read_dir(directory) {
            Ok(entries) => entries,
            Err(_) => {
                add_gap(capture, "directory_read_failed");
                return;
            }
        };
        let mut entries = Vec::new();
        for item in read_dir {
            if *total_entries >= MAX_WORKSPACE_ENTRIES {
                add_gap(capture, "workspace_entry_limit");
                break;
            }
            *total_entries += 1;
            match item {
                Ok(entry) => entries.push(entry),
                Err(_) => add_gap(capture, "directory_entry_read_failed"),
            }
        }
        entries.sort_by_key(std::fs::DirEntry::file_name);
        for entry in entries {
            let path = entry.path();
            let Ok(relative) = path.strip_prefix(root) else {
                add_gap(capture, "path_outside_root");
                continue;
            };
            let Some(relative) = relative.to_str() else {
                add_gap(capture, "non_utf8_path");
                continue;
            };
            let relative = relative.replace('\\', "/");
            let Some(path_cost) = relative
                .len()
                .checked_mul(6)
                .and_then(|size| size.checked_add(256))
            else {
                add_gap(capture, "workspace_metadata_limit");
                return;
            };
            if total_metadata_bytes.saturating_add(path_cost) > MAX_WORKSPACE_METADATA_BYTES {
                add_gap(capture, "workspace_metadata_limit");
                return;
            }
            *total_metadata_bytes += path_cost;
            let Ok(metadata) = std::fs::symlink_metadata(&path) else {
                add_gap(capture, "metadata_failed");
                continue;
            };
            let mut item = SnapshotFile {
                path: relative,
                kind: SnapshotEntryKind::Unsupported,
                bytes: Vec::new(),
                symlink_target: None,
                truncated: false,
            };
            if metadata.file_type().is_symlink() {
                item.kind = SnapshotEntryKind::Symlink;
                match std::fs::read_link(&path) {
                    Ok(target) => match target.to_str() {
                        Some(target) if target.len() <= MAX_SYMLINK_TARGET_BYTES => {
                            let target_cost = target.len().saturating_mul(6);
                            if total_metadata_bytes.saturating_add(target_cost)
                                <= MAX_WORKSPACE_METADATA_BYTES
                            {
                                *total_metadata_bytes += target_cost;
                                item.symlink_target = Some(target.to_owned());
                            } else {
                                add_gap(capture, "workspace_metadata_limit");
                            }
                        }
                        Some(target) => {
                            let target = target
                                .chars()
                                .take(MAX_SYMLINK_TARGET_BYTES)
                                .collect::<String>();
                            let target_cost = target.len().saturating_mul(6);
                            if total_metadata_bytes.saturating_add(target_cost)
                                <= MAX_WORKSPACE_METADATA_BYTES
                            {
                                *total_metadata_bytes += target_cost;
                                item.symlink_target = Some(target);
                                add_gap(capture, "symlink_target_limit");
                            } else {
                                add_gap(capture, "workspace_metadata_limit");
                            }
                        }
                        None => add_gap(capture, "non_utf8_symlink_target"),
                    },
                    Err(_) => add_gap(capture, "symlink_read_failed"),
                }
            } else if metadata.is_dir() {
                item.kind = SnapshotEntryKind::Directory;
            } else if metadata.is_file() {
                item.kind = SnapshotEntryKind::File;
                let remaining = MAX_WORKSPACE_BYTES.saturating_sub(*total_bytes);
                use std::io::Read;
                match std::fs::File::open(&path).and_then(|file| {
                    let mut bytes = Vec::new();
                    file.take((remaining + 1) as u64).read_to_end(&mut bytes)?;
                    Ok(bytes)
                }) {
                    Ok(mut bytes) => {
                        if bytes.len() > remaining {
                            bytes.truncate(remaining);
                            item.truncated = true;
                            add_gap(capture, "workspace_byte_limit");
                        }
                        *total_bytes = (*total_bytes).saturating_add(bytes.len());
                        item.bytes = bytes;
                    }
                    Err(_) => add_gap(capture, "file_read_failed"),
                }
            } else {
                add_gap(capture, "unsupported_workspace_entry");
            }
            let descend = item.kind == SnapshotEntryKind::Directory;
            let stop = item.truncated;
            capture.entries.push(item);
            if descend {
                visit(
                    root,
                    &path,
                    capture,
                    total_bytes,
                    total_metadata_bytes,
                    total_entries,
                    depth + 1,
                );
            }
            if stop
                || capture.gaps.iter().any(|gap| {
                    gap == "workspace_byte_limit"
                        || gap == "workspace_entry_limit"
                        || gap == "workspace_depth_limit"
                        || gap == "workspace_metadata_limit"
                })
            {
                return;
            }
        }
    }

    let mut capture = WorkspaceCapture {
        entries: Vec::new(),
        complete: true,
        gaps: Vec::new(),
    };
    let mut total_bytes = 0;
    let mut total_metadata_bytes = 0;
    let mut total_entries = 0;
    visit(
        root,
        root,
        &mut capture,
        &mut total_bytes,
        &mut total_metadata_bytes,
        &mut total_entries,
        0,
    );
    capture.entries.sort_by(|a, b| a.path.cmp(&b.path));
    capture
}

#[cfg(test)]
mod tests {
    use super::{
        BoundedObserver, ProviderMode, execute_with, probe_output_publication, run_mode_to,
        run_mode_to_id, run_mode_to_id_with_capture_limits,
    };
    use horizoncode_runner::{RunEvent, RunObserver};
    use horizoncode_session::TurnEndStatus;

    #[cfg(unix)]
    #[test]
    fn output_filesystem_publication_probe_runs_before_evidence_and_cleans_up() {
        let output = tempfile::tempdir().unwrap();
        probe_output_publication(output.path()).unwrap();
        assert_eq!(std::fs::read_dir(output.path()).unwrap().count(), 0);
    }

    #[test]
    fn trajectory_overflow_retains_a_serializable_prefix_and_marks_the_gap() {
        let mut observer = BoundedObserver::default();
        observer.on_event(RunEvent::TextDelta {
            text: "x".repeat(super::MAX_TRAJECTORY_BYTES),
        });
        assert!(observer.overflow);
        assert!(observer.events.is_empty());
        assert!(serde_json::to_vec(&observer.events).unwrap().len() <= super::MAX_TRAJECTORY_BYTES);
    }

    #[tokio::test]
    async fn trajectory_overflow_is_sealed_as_incomplete_evidence() {
        let output = tempfile::tempdir().unwrap();
        let baseline = execute_with(
            ProviderMode::Smoke,
            super::FIXTURE_MAX_STEPS,
            false,
            super::evaluation_id(),
        )
        .await
        .unwrap();
        assert!(baseline.trajectory.len() > 1);
        let first_event = baseline.trajectory.first().unwrap().clone();
        let prefix_limit = serde_json::to_vec(&vec![first_event.clone()])
            .unwrap()
            .len();
        let report = run_mode_to_id_with_capture_limits(
            output.path(),
            ProviderMode::Smoke,
            super::FIXTURE_MAX_STEPS,
            false,
            super::evaluation_id(),
            prefix_limit,
            super::MAX_TRAJECTORY_EVENTS,
        )
        .await
        .unwrap();
        let attempt = output.path().join(report.attempt_directory);
        let record =
            crate::validate_bytes(&std::fs::read(attempt.join("record.json")).unwrap()).unwrap();
        assert_eq!(record.outcome, crate::Outcome::InsufficientEvidence);
        assert_eq!(
            record.trajectory.completeness,
            crate::Completeness::Incomplete
        );
        assert_eq!(
            record.trajectory.event_gaps,
            vec!["trajectory_capture_limit".to_owned()]
        );
        let trajectory_bytes = std::fs::read(attempt.join("trajectory.json")).unwrap();
        assert!(trajectory_bytes.len() <= prefix_limit);
        let trajectory: Vec<serde_json::Value> = serde_json::from_slice(&trajectory_bytes).unwrap();
        assert_eq!(trajectory.len(), 1);
        assert_eq!(trajectory[0]["type"], "turn_started");
        assert!(matches!(first_event, RunEvent::TurnStarted { .. }));
        assert_eq!(
            record.trajectory.digest,
            super::blake3_digest(&trajectory_bytes)
        );
        assert!(attempt.join("workspace.snapshot.json").exists());
    }

    #[cfg(unix)]
    #[test]
    fn workspace_metadata_expansion_is_bounded_before_snapshot_serialization() {
        let root = tempfile::tempdir().unwrap();
        let mut nested = root.path().to_path_buf();
        for index in 0..10 {
            let name = format!("{index:02}-{}", "d".repeat(90));
            nested.push(name);
            std::fs::create_dir(&nested).unwrap();
        }
        for index in 0..500 {
            let name = format!("{index:04}-{}.txt", "f".repeat(48));
            std::fs::write(nested.join(name), b"x").unwrap();
        }
        let capture = super::capture_workspace_tree(root.path());
        assert!(!capture.complete);
        assert!(
            capture
                .gaps
                .iter()
                .any(|gap| gap == "workspace_metadata_limit")
        );
        let snapshot = super::workspace_snapshot(&capture).unwrap();
        assert!(snapshot.len() <= super::MAX_WORKSPACE_SNAPSHOT_BYTES);
    }

    #[tokio::test]
    async fn provider_failure_is_a_runner_failure_with_partial_trajectory() {
        let result = execute_with(
            ProviderMode::ProviderFailure,
            2,
            false,
            super::evaluation_id(),
        )
        .await
        .unwrap();
        assert_eq!(result.status, TurnEndStatus::Failed);
        assert!(matches!(
            result.trajectory.last(),
            Some(RunEvent::TurnFinished {
                status: TurnEndStatus::Failed,
                ..
            })
        ));
        assert!(result.workspace_files.is_empty());
    }

    #[tokio::test]
    async fn provider_failure_attempt_is_sealed_and_keeps_its_typed_outcome() {
        let output = tempfile::tempdir().unwrap();
        let report = run_mode_to(output.path(), ProviderMode::ProviderFailure, 2, false)
            .await
            .unwrap();
        let attempt = output.path().join(report.attempt_directory);
        let record =
            crate::validate_bytes(&std::fs::read(attempt.join("record.json")).unwrap()).unwrap();
        assert_eq!(record.outcome, crate::Outcome::ProviderFailure);
        assert_eq!(
            record.terminal_reason,
            crate::TerminalReason::ProviderFailure
        );
        assert_eq!(record.verifier_outcome, crate::VerifierOutcome::NotRun);
        assert!(attempt.join("trajectory.json").exists());
        assert!(attempt.join("workspace.snapshot.json").exists());
    }

    #[tokio::test]
    async fn run_record_binds_the_fixture_manifest_without_faking_source_revision() {
        let output = tempfile::tempdir().unwrap();
        let report = run_mode_to(
            output.path(),
            ProviderMode::Smoke,
            super::FIXTURE_MAX_STEPS,
            false,
        )
        .await
        .unwrap();
        let attempt = output.path().join(report.attempt_directory);
        let record =
            crate::validate_bytes(&std::fs::read(attempt.join("record.json")).unwrap()).unwrap();

        assert_eq!(
            record.dataset_digest,
            super::digest_json(&super::fixture_manifest()).unwrap()
        );
        let manifest = super::fixture_manifest();
        assert_eq!(
            record.criteria_digest,
            super::digest_json(&(
                manifest.fixture_id,
                manifest.fixture_version,
                manifest.task_id,
                manifest.expected_path,
                manifest.expected_output,
                manifest.success_predicate,
                manifest.allowed_paths,
            ))
            .unwrap()
        );
        assert_eq!(
            record.harness_revision,
            "unknown:source_revision_not_embedded"
        );
        assert!(
            record
                .limitations
                .iter()
                .any(|limitation| limitation == "source_revision_not_embedded")
        );
        assert!(record.binary_digest.starts_with("blake3:"));
        assert_ne!(record.binary_digest, record.harness_revision);
    }

    #[tokio::test]
    async fn step_bound_attempt_is_sealed_as_insufficient_evidence() {
        let output = tempfile::tempdir().unwrap();
        let report = run_mode_to(output.path(), ProviderMode::Smoke, 1, false)
            .await
            .unwrap();
        let attempt = output.path().join(report.attempt_directory);
        let record =
            crate::validate_bytes(&std::fs::read(attempt.join("record.json")).unwrap()).unwrap();
        assert_eq!(record.outcome, crate::Outcome::InsufficientEvidence);
        assert_eq!(record.verifier_outcome, crate::VerifierOutcome::NotRun);
    }

    #[tokio::test]
    async fn pre_cancel_is_retained_as_interrupted_without_tool_effects() {
        let result = execute_with(ProviderMode::Pending, 2, true, super::evaluation_id())
            .await
            .unwrap();
        assert_eq!(result.status, TurnEndStatus::Interrupted);
        assert!(result.workspace_files.is_empty());
        assert!(matches!(
            result.trajectory.last(),
            Some(RunEvent::TurnFinished {
                status: TurnEndStatus::Interrupted,
                ..
            })
        ));
    }

    #[tokio::test]
    async fn existing_attempt_collision_never_overwrites_prior_artifacts() {
        #[cfg(unix)]
        {
            let output = tempfile::tempdir().unwrap();
            let attempt = output.path().join("eval-smoke-collision");
            std::fs::create_dir(&attempt).unwrap();
            let sentinel = attempt.join("record.json");
            std::fs::write(&sentinel, b"prior immutable record").unwrap();

            let result = run_mode_to_id(
                output.path(),
                ProviderMode::Smoke,
                super::FIXTURE_MAX_STEPS,
                false,
                "eval-smoke-collision".to_owned(),
            )
            .await;

            assert!(matches!(result, Err(super::FixtureError::OutputPath)));
            assert_eq!(std::fs::read(sentinel).unwrap(), b"prior immutable record");
            assert_eq!(std::fs::read_dir(attempt).unwrap().count(), 1);
        }
    }

    #[tokio::test]
    async fn step_limit_does_not_claim_completed_task() {
        let result = execute_with(ProviderMode::Smoke, 1, false, super::evaluation_id())
            .await
            .unwrap();
        assert_eq!(result.status, TurnEndStatus::Partial);
        assert!(result.workspace_files.is_empty());
    }

    #[tokio::test]
    async fn production_write_tool_refuses_workspace_escape() {
        let result = execute_with(ProviderMode::EscapeWrite, 2, false, super::evaluation_id())
            .await
            .unwrap();
        assert!(!result.outside_target_created);
        assert!(
            matches!(result.trajectory.iter().find(|event| matches!(event, RunEvent::ToolFinished { .. })), Some(RunEvent::ToolFinished { settlement, .. }) if settlement.status == horizoncode_types::ToolStatus::Error)
        );
    }

    #[tokio::test]
    async fn fixture_advertises_only_its_fixed_non_shell_tool_set() {
        let result = super::execute_smoke().await.unwrap();
        assert_eq!(
            result.advertised_tools,
            [
                "apply_patch",
                "edit",
                "glob",
                "grep",
                "list",
                "read",
                "todo",
                "write"
            ]
        );
        assert!(!result.advertised_tools.iter().any(|name| name == "bash"));
    }

    #[tokio::test]
    async fn unexpected_workspace_entry_is_captured_and_fails_the_fixture() {
        let result = execute_with(
            ProviderMode::UnexpectedFile,
            super::FIXTURE_MAX_STEPS,
            false,
            super::evaluation_id(),
        )
        .await
        .unwrap();
        assert!(result.workspace_capture_complete);
        assert!(result.unexpected_workspace_entries);
        assert!(
            result
                .workspace_files
                .iter()
                .any(|entry| entry.path == "surprise.txt")
        );
        assert_eq!(result.outcome, crate::Outcome::Failed);
    }

    #[tokio::test]
    async fn oversized_workspace_is_captured_as_incomplete_and_digest_is_unknown() {
        let output = tempfile::tempdir().unwrap();
        let report = run_mode_to(
            output.path(),
            ProviderMode::WorkspaceOverflow,
            super::FIXTURE_MAX_STEPS,
            false,
        )
        .await
        .unwrap();
        let attempt = output.path().join(report.attempt_directory);
        let record =
            crate::validate_bytes(&std::fs::read(attempt.join("record.json")).unwrap()).unwrap();
        assert_eq!(record.outcome, crate::Outcome::InsufficientEvidence);
        assert_eq!(
            record.final_workspace_digest,
            crate::Measured::Unknown {
                reason: "workspace_capture_incomplete".to_owned()
            }
        );
        let snapshot: serde_json::Value = serde_json::from_slice(
            &std::fs::read(attempt.join("workspace.snapshot.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(snapshot["complete"], false);
        assert!(
            snapshot["gaps"]
                .as_array()
                .unwrap()
                .iter()
                .any(|gap| gap == "workspace_byte_limit")
        );
        let oversized = snapshot["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|entry| entry["path"] == "oversized.txt")
            .unwrap();
        assert_eq!(oversized["truncated"], true);
        assert!(oversized["bytes"].as_array().unwrap().len() <= super::MAX_WORKSPACE_BYTES);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn workspace_symlinks_are_snapshotted_without_following_and_fail_the_fixture() {
        let result = execute_with(
            ProviderMode::WorkspaceSymlink,
            super::FIXTURE_MAX_STEPS,
            false,
            super::evaluation_id(),
        )
        .await
        .unwrap();
        assert!(result.workspace_capture_complete);
        assert!(result.unexpected_workspace_entries);
        let link = result
            .workspace_files
            .iter()
            .find(|entry| entry.path == "linked")
            .unwrap();
        assert_eq!(link.kind, super::SnapshotEntryKind::Symlink);
        assert_eq!(result.outcome, crate::Outcome::Failed);
    }
}
