//! Bounded, durable checkpoint metadata and preview policy.
//!
//! Snapshot bytes are captured into the Rust-owned ArtifactStore through the same
//! Guard grant path as other artifact effects. Restore stays unavailable until a
//! verified P1 Guard/ExecutionHost adapter can provide one-use leases and receipts.

use crate::artifact_store::{
    ArtifactAccessV1, ArtifactAuthorizer, ArtifactEffectGrantV1, ArtifactEffectRequestV1,
    ArtifactError, ArtifactFidelityV1, ArtifactMetadataV1, ArtifactOwnerScopeV1,
    ArtifactWriteMetadataV1, CapturedArtifactV1, GuardedArtifactIngressV1,
};
use crate::guard::GuardDecisionV1;
use crate::host_kernel::{
    TrustedWorkspaceFileKindV1, TrustedWorkspaceObservationV1,
    TrustedWorkspaceSnapshotBundleV1,
};
use crate::owner_log::{
    Digest, DurabilityProfile, MAX_OWNER_READ_BATCH_EVENTS, OWNER_EVENT_SCHEMA_VERSION_V1,
    OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::{ArtifactRefV1, CursorV1};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::error::Error;
use std::fmt;
use std::num::NonZeroUsize;
use std::path::Path;

/// Production capture stays closed until the Guarded HostKernel checkpoint
/// operation is wired and accepted. The immutable bundle is necessary for
/// capture, but does not itself authorize an artifact effect.
pub const CHECKPOINT_CAPTURE_ENABLED: bool = false;
pub const CHECKPOINT_RESTORE_ENABLED: bool = false;
const OWNER_KIND: &str = "checkpoint";
const EVENT_KIND: &str = "checkpoint.transition.v1";
const STATE_FORMAT: &str = "horizon.checkpoint-state.v1";
const MAX_CHECKPOINTS_PER_SESSION: usize = 32;
const MAX_CHECKPOINT_PATHS: usize = 2_048;
const MAX_CHECKPOINT_ID_BYTES: usize = 256;
const MAX_PATH_BYTES: usize = 4_096;
const MAX_REVISION_BYTES: usize = 256;
const MAX_RECEIPT_BYTES: usize = 512;
const MAX_SNAPSHOT_BYTES: usize = 64 * 1024 * 1024;
const MAX_SESSION_SNAPSHOT_BYTES: u64 = 512 * 1024 * 1024;
const MAX_OBSERVATION_BYTES: usize = 16 * 1024 * 1024;
const MAX_RESTORE_HISTORY: usize = 64;
const MAX_JOURNAL_RECORDS: u64 = 65_536;
const MAX_SAFE_TIME_MS: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointErrorV1 {
    InvalidInput,
    InvalidSnapshot,
    CaptureUnavailable,
    NotFound,
    RetentionLimit,
    WorkspaceRevisionChanged,
    DirtyConflict,
    UntrackedConflict,
    StalePreview,
    RestoreUnavailable,
    RestoreConflict,
    InvalidReceipt,
    PersistenceUnavailable(String),
    Artifact(ArtifactError),
}

impl fmt::Display for CheckpointErrorV1 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "checkpoint error: {self:?}")
    }
}

impl Error for CheckpointErrorV1 {}

impl From<ArtifactError> for CheckpointErrorV1 {
    fn from(value: ArtifactError) -> Self {
        Self::Artifact(value)
    }
}

fn persistence(error: OwnerLogError) -> CheckpointErrorV1 {
    CheckpointErrorV1::PersistenceUnavailable(error.to_string())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CheckpointFileV1 {
    pub path: String,
    /// `None` means this path did not exist at the checkpoint boundary.
    pub digest: Option<String>,
    pub byte_length: u64,
    pub executable: bool,
    pub kind: CheckpointFileKindV1,
    pub link_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum CheckpointFileKindV1 {
    RegularFile,
    Absent,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CheckpointCaptureV1 {
    pub checkpoint_id: String,
    pub workspace_revision: String,
    /// HostKernel digest of the exact no-follow file manifest carried by the
    /// immutable snapshot bundle persisted as the checkpoint artifact.
    pub snapshot_manifest_digest: String,
    pub conversation_position: String,
    /// The complete file manifest is also encoded in the retained snapshot bytes.
    pub files: Vec<CheckpointFileV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WorkspaceFileStateV1 {
    pub path: String,
    pub digest: Option<String>,
    pub byte_length: u64,
    pub executable: bool,
    /// HostKernel-derived no-follow classification; caller-provided path text
    /// cannot establish any of these facts.
    pub kind: WorkspaceFileKindV1,
    pub link_count: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum WorkspaceFileKindV1 {
    RegularFile,
    Symlink,
    Other,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct WorkspaceObservationV1 {
    pub revision: String,
    /// Paths whose current content differs from the workspace's last committed base.
    pub dirty_paths: Vec<String>,
    /// Paths which are currently untracked and must never be removed by restore.
    pub untracked_paths: Vec<String>,
    /// False until the same trusted observation boundary can provide VCS
    /// dirty/untracked facts. No restore actions are exposed without it.
    pub workspace_status_complete: bool,
    /// Trusted current path state obtained by the HostKernel, never accepted from a model.
    pub files: Vec<WorkspaceFileStateV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RestoreConflictKindV1 {
    WorkspaceRevisionChanged,
    DirtyPath,
    UntrackedPath,
    WorkspaceStatusUnavailable,
    UnsafePath,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RestoreConflictV1 {
    pub path: Option<String>,
    pub kind: RestoreConflictKindV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RestorePathActionV1 {
    pub path: String,
    pub expected_before_digest: Option<String>,
    pub target: CheckpointFileV1,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct CheckpointRestorePreviewV1 {
    pub checkpoint_id: String,
    pub checkpoint_artifact: ArtifactRefRecordV1,
    /// `true` means the observed workspace revision differs from the checkpoint.
    /// This does not claim Git commit provenance. Full reset is refused; selected
    /// recovery requires complete trusted VCS status and conflict-free paths.
    pub workspace_revision_changed: bool,
    pub mode: CheckpointRestoreModeV1,
    /// Empty for a full restore preview; otherwise the exact user-selected paths.
    pub selected_paths: Vec<String>,
    pub observed_revision: String,
    pub actions: Vec<RestorePathActionV1>,
    pub conflicts: Vec<RestoreConflictV1>,
    pub preview_digest: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum CheckpointRestoreModeV1 {
    Full,
    SelectedPaths,
}

/// Owner-supplied evidence for a checkpoint candidate. This is a planning input,
/// not authority to delete the referenced artifact.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointEvictionCandidateV1 {
    pub checkpoint_id: String,
    pub owner_ref: String,
    pub created_at_ms: u64,
    pub byte_length: String,
    pub disposable: bool,
    pub rebuildable: bool,
    pub pinned: bool,
    pub unreferenced: bool,
    pub settled: bool,
    pub state_known: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointEvictionReasonV1 {
    Pressure,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CheckpointEvictionBlockReasonV1 {
    UnknownOrUnsettled,
    WrongScope,
    Pinned,
    Referenced,
    NotDisposable,
    NotRebuildable,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointEvictionItemV1 {
    pub checkpoint_id: String,
    pub byte_length: u64,
    pub created_at_ms: u64,
    pub reason: CheckpointEvictionReasonV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointEvictionBlockerV1 {
    pub checkpoint_id: String,
    pub byte_length: u64,
    pub reason: CheckpointEvictionBlockReasonV1,
}

/// Deterministic oldest-first preview. `planned_bytes` describes candidate
/// artifact sizes only; this function never deletes anything or claims that
/// storage has been reclaimed. Applying a plan requires a P1 Guarded one-use
/// deletion lease plus the P2 artifact-owner adapter to verify scope, references,
/// and settlement from trusted owner state. Request data cannot supply candidates.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CheckpointEvictionPreviewV1 {
    pub required_count: usize,
    pub required_bytes: u64,
    pub planned_bytes: u64,
    pub ready: bool,
    pub planned: Vec<CheckpointEvictionItemV1>,
    pub blocked: Vec<CheckpointEvictionBlockerV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct ArtifactRefRecordV1 {
    pub artifact_id: String,
    pub digest: String,
    pub byte_length: String,
    pub media_type: String,
    pub classification: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RestoreAttemptStatusV1 {
    InProgress,
    Succeeded,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) enum RestorePathOutcomeV1 {
    Applied,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RestorePathReceiptV1 {
    pub path: String,
    pub outcome: RestorePathOutcomeV1,
    pub receipt_ref: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct RestoreAttemptV1 {
    pub effect_id: String,
    pub checkpoint_id: String,
    pub preview_digest: String,
    pub lease_ref: String,
    pub planned_paths: Vec<String>,
    pub status: RestoreAttemptStatusV1,
    pub path_receipts: Vec<RestorePathReceiptV1>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct CheckpointRecordV1 {
    capture: CheckpointCaptureV1,
    artifact: ArtifactRefRecordV1,
    created_at_ms: u64,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct CheckpointStateV1 {
    format: String,
    session_id: String,
    checkpoints: Vec<CheckpointRecordV1>,
    restore_attempts: Vec<RestoreAttemptV1>,
}

impl CheckpointStateV1 {
    fn new(session_id: String) -> Self {
        Self {
            format: STATE_FORMAT.to_owned(),
            session_id,
            checkpoints: Vec::new(),
            restore_attempts: Vec::new(),
        }
    }

    fn encode(&self) -> Result<Vec<u8>, CheckpointErrorV1> {
        let bytes = serde_json::to_vec(self).map_err(|_| CheckpointErrorV1::InvalidSnapshot)?;
        if bytes.len() > crate::owner_log::MAX_OWNER_RECORD_BYTES {
            return Err(CheckpointErrorV1::InvalidSnapshot);
        }
        Ok(bytes)
    }

    fn decode(bytes: &[u8]) -> Result<Self, CheckpointErrorV1> {
        let state: Self =
            serde_json::from_slice(bytes).map_err(|_| CheckpointErrorV1::InvalidSnapshot)?;
        if serde_json::to_vec(&state).map_err(|_| CheckpointErrorV1::InvalidSnapshot)? != bytes
            || state.format != STATE_FORMAT
            || !valid_component(&state.session_id, MAX_CHECKPOINT_ID_BYTES)
            || state.checkpoints.len() > MAX_CHECKPOINTS_PER_SESSION
            || state.restore_attempts.len() > MAX_RESTORE_HISTORY
        {
            return Err(CheckpointErrorV1::InvalidSnapshot);
        }
        for record in &state.checkpoints {
            validate_capture(&record.capture)?;
            if !valid_time(record.created_at_ms) || !valid_artifact_record(&record.artifact) {
                return Err(CheckpointErrorV1::InvalidSnapshot);
            }
        }
        for attempt in &state.restore_attempts {
            validate_attempt(attempt)?;
        }
        Ok(state)
    }
}

/// OwnerLog-backed per-session checkpoint metadata and restore-preview policy.
/// The referenced snapshot bytes live in ArtifactStore, not in this journal.
pub(crate) struct CheckpointJournalV1 {
    log: OwnerLogV2,
    state: CheckpointStateV1,
    commits: u64,
    last_time_ms: u64,
}

impl CheckpointJournalV1 {
    pub(crate) fn open(root: &Path, session_id: &str) -> Result<Self, CheckpointErrorV1> {
        if !valid_component(session_id, MAX_CHECKPOINT_ID_BYTES) {
            return Err(CheckpointErrorV1::InvalidInput);
        }
        let owner = OwnerIdentity::new(OWNER_KIND.to_owned(), session_id.to_owned())
            .map_err(persistence)?;
        let log =
            OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable).map_err(persistence)?;
        let (snapshot, commits, last_time_ms) = Self::replay(&log)?;
        let mut state = snapshot
            .map(|bytes| CheckpointStateV1::decode(&bytes))
            .transpose()?
            .unwrap_or_else(|| CheckpointStateV1::new(session_id.to_owned()));
        if state.session_id != session_id {
            return Err(CheckpointErrorV1::InvalidSnapshot);
        }

        // A process crash during a guarded restore is never interpreted as success.
        // Preserve exact per-path receipt references and require reconciliation.
        let mut recovered = false;
        for attempt in &mut state.restore_attempts {
            if attempt.status == RestoreAttemptStatusV1::InProgress {
                attempt.status = RestoreAttemptStatusV1::Unknown;
                recovered = true;
            }
        }
        let mut journal = Self {
            log,
            state,
            commits,
            last_time_ms,
        };
        if recovered {
            journal.commit("restore_recovered_unknown", journal.state.clone(), 0)?;
        }
        Ok(journal)
    }

    fn replay(log: &OwnerLogV2) -> Result<(Option<Vec<u8>>, u64, u64), CheckpointErrorV1> {
        let limit =
            NonZeroUsize::new(MAX_OWNER_READ_BATCH_EVENTS).expect("nonzero owner page size");
        let mut cursor: Option<CursorV1> = None;
        let mut scanned = 0_u64;
        let mut commits = 0_u64;
        let mut last_time_ms = 0_u64;
        let mut snapshot = None;
        loop {
            let batch = log
                .read_after(cursor.as_ref(), limit)
                .map_err(persistence)?;
            scanned = scanned
                .checked_add(batch.events.len() as u64)
                .ok_or_else(|| {
                    CheckpointErrorV1::PersistenceUnavailable("journal scan overflow".to_owned())
                })?;
            if scanned > MAX_JOURNAL_RECORDS {
                return Err(CheckpointErrorV1::PersistenceUnavailable(
                    "checkpoint journal requires compaction".to_owned(),
                ));
            }
            for event in &batch.events {
                last_time_ms = last_time_ms.max(event.time_ms);
                if event.kind != EVENT_KIND {
                    continue;
                }
                let encoded = event
                    .data
                    .get("payload")
                    .and_then(|payload| payload.get("snapshotJson"))
                    .and_then(Value::as_str)
                    .ok_or(CheckpointErrorV1::InvalidSnapshot)?;
                snapshot = Some(encoded.as_bytes().to_vec());
                commits += 1;
            }
            match batch.cursor {
                Some(next) if batch.has_more => cursor = Some(next),
                _ => break,
            }
        }
        Ok((snapshot, commits, last_time_ms))
    }

    fn commit(
        &mut self,
        operation: &'static str,
        next: CheckpointStateV1,
        now_ms: u64,
    ) -> Result<(), CheckpointErrorV1> {
        let prepared =
            prepare_checkpoint_event(&next, operation, self.commits, self.last_time_ms, now_ms)?;
        let PreparedCheckpointEventV1 {
            delivery_id,
            event,
            command_digest,
        } = prepared;
        self.log
            .append_batch(&delivery_id, &command_digest, &[event], None)
            .map_err(persistence)?;
        self.state = next;
        self.commits += 1;
        self.last_time_ms = self.last_time_ms.max(now_ms);
        Ok(())
    }

    /// Captures complete snapshot bytes into ArtifactStore, verifies the immutable
    /// stored object and owner binding, then journals only its bounded reference.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn capture_guarded<A: ArtifactAuthorizer>(
        &mut self,
        ingress: &GuardedArtifactIngressV1<A>,
        principal: &str,
        owner: &ArtifactOwnerScopeV1,
        request: &ArtifactEffectRequestV1<'_>,
        decision: &GuardDecisionV1,
        grant: &ArtifactEffectGrantV1,
        artifact_id: String,
        metadata: ArtifactWriteMetadataV1,
        checkpoint_id: String,
        conversation_position: String,
        snapshot_bundle: &TrustedWorkspaceSnapshotBundleV1,
        now_ms: u64,
    ) -> Result<ArtifactRefV1, CheckpointErrorV1> {
        if !CHECKPOINT_CAPTURE_ENABLED {
            return Err(CheckpointErrorV1::CaptureUnavailable);
        }
        let capture = checkpoint_capture_from_host(
            checkpoint_id,
            conversation_position,
            snapshot_bundle,
        )?;
        let snapshot_bytes = snapshot_bundle.serialized_bytes().to_vec();
        let captured_length =
            u64::try_from(snapshot_bytes.len()).map_err(|_| CheckpointErrorV1::InvalidInput)?;
        let expected_owner = format!("session:{}", self.state.session_id);
        if owner.owner_ref() != expected_owner {
            return Err(CheckpointErrorV1::InvalidInput);
        }
        let expected_artifact = ArtifactRefRecordV1 {
            artifact_id: artifact_id.clone(),
            digest: format!("blake3:{}", Digest::from_blake3(&snapshot_bytes).to_hex()),
            byte_length: captured_length.to_string(),
            media_type: metadata.media_type.clone(),
            classification: access_classification(metadata.access).to_owned(),
        };
        let reference = publish_checkpoint_capture(
            &self.state,
            &capture,
            &expected_artifact,
            captured_length,
            now_ms,
            self.commits,
            self.last_time_ms,
            || {
                ingress
                    .capture_guarded(
                        request,
                        decision,
                        grant,
                        owner,
                        artifact_id,
                        metadata,
                        CapturedArtifactV1 {
                            bytes: snapshot_bytes,
                            observed_byte_count: captured_length,
                            dropped_byte_count: 0,
                            fidelity: ArtifactFidelityV1::Full,
                        },
                    )
                    .map_err(CheckpointErrorV1::from)
            },
        )?;
        let verified = ingress.verify_ref(
            owner,
            principal,
            &reference,
            NonZeroUsize::new(MAX_SNAPSHOT_BYTES).unwrap(),
        )?;
        self.record_verified_capture(capture, &reference, &verified, now_ms)?;
        Ok(reference)
    }

    fn record_verified_capture(
        &mut self,
        capture: CheckpointCaptureV1,
        reference: &ArtifactRefV1,
        verified: &ArtifactMetadataV1,
        now_ms: u64,
    ) -> Result<(), CheckpointErrorV1> {
        validate_capture(&capture)?;
        let expected_owner = format!("session:{}", self.state.session_id);
        if verified.artifact_id != reference.artifact_id
            || verified.digest != reference.digest
            || verified.byte_length != reference.byte_length
            || verified.fidelity != ArtifactFidelityV1::Full
            || verified
                .owner_refs
                .iter()
                .all(|value| value != &expected_owner)
            || parse_decimal(&verified.byte_length)
                .is_none_or(|length| length == 0 || length > MAX_SNAPSHOT_BYTES as u64)
        {
            return Err(CheckpointErrorV1::InvalidSnapshot);
        }
        let captured_length =
            parse_decimal(&verified.byte_length).ok_or(CheckpointErrorV1::InvalidSnapshot)?;
        validate_capture_admission(&self.state, &capture, captured_length, now_ms)?;
        let mut next = self.state.clone();
        next.checkpoints.push(CheckpointRecordV1 {
            capture,
            artifact: artifact_record(reference),
            created_at_ms: now_ms,
        });
        self.commit("checkpoint_captured", next, now_ms)
    }

    pub(crate) fn checkpoint_ids(&self) -> Vec<String> {
        self.state
            .checkpoints
            .iter()
            .map(|record| record.capture.checkpoint_id.clone())
            .collect()
    }

    /// Bind a proposed restore to a fresh trusted workspace observation. Later
    /// commits refuse the whole reset; dirty/untracked path conflicts are omitted
    /// from actions so a caller can offer safe per-path recovery for the remainder.
    pub(crate) fn preview_restore(
        &self,
        checkpoint_id: &str,
        observed: &WorkspaceObservationV1,
    ) -> Result<CheckpointRestorePreviewV1, CheckpointErrorV1> {
        self.preview_restore_mode(
            checkpoint_id,
            observed,
            CheckpointRestoreModeV1::Full,
            Vec::new(),
        )
    }

    /// Builds a digest-bound recovery preview for an explicit, bounded set of
    /// checkpoint paths. This is the only preview mode that may expose actions
    /// when the workspace revision changed. Dirty and untracked paths remain conflicts;
    /// no path outside `selected_paths` can enter the restore plan.
    pub(crate) fn preview_restore_selected_paths(
        &self,
        checkpoint_id: &str,
        observed: &WorkspaceObservationV1,
        selected_paths: Vec<String>,
    ) -> Result<CheckpointRestorePreviewV1, CheckpointErrorV1> {
        self.preview_restore_mode(
            checkpoint_id,
            observed,
            CheckpointRestoreModeV1::SelectedPaths,
            selected_paths,
        )
    }

    /// Production preview adapter. The opaque observation can only be minted
    /// by HostKernel after a complete descriptor-relative no-follow traversal.
    /// V1 currently has no authenticated VCS dirty/untracked status in that same
    /// observation, so this adapter deliberately produces blocked previews.
    pub(crate) fn preview_restore_trusted(
        &self,
        checkpoint_id: &str,
        observed: &TrustedWorkspaceObservationV1,
        mode: CheckpointRestoreModeV1,
        selected_paths: Vec<String>,
    ) -> Result<CheckpointRestorePreviewV1, CheckpointErrorV1> {
        let observed = checkpoint_observation_from_host(observed)?;
        self.preview_restore_mode(checkpoint_id, &observed, mode, selected_paths)
    }

    fn preview_restore_mode(
        &self,
        checkpoint_id: &str,
        observed: &WorkspaceObservationV1,
        mode: CheckpointRestoreModeV1,
        mut selected_paths: Vec<String>,
    ) -> Result<CheckpointRestorePreviewV1, CheckpointErrorV1> {
        let record = self
            .state
            .checkpoints
            .iter()
            .find(|record| record.capture.checkpoint_id == checkpoint_id)
            .ok_or(CheckpointErrorV1::NotFound)?;
        validate_observation(observed)?;
        if mode == CheckpointRestoreModeV1::Full {
            if !selected_paths.is_empty() {
                return Err(CheckpointErrorV1::InvalidInput);
            }
        } else {
            if selected_paths.is_empty() || selected_paths.len() > MAX_CHECKPOINT_PATHS {
                return Err(CheckpointErrorV1::InvalidInput);
            }
            selected_paths.sort();
            if selected_paths.windows(2).any(|pair| pair[0] == pair[1])
                || selected_paths.iter().any(|path| {
                    !valid_relative_path(path)
                        || !record.capture.files.iter().any(|file| file.path == *path)
                })
            {
                return Err(CheckpointErrorV1::InvalidInput);
            }
        }
        let mut conflicts = Vec::new();
        let workspace_revision_changed = observed.revision != record.capture.workspace_revision;
        if workspace_revision_changed && mode == CheckpointRestoreModeV1::Full {
            conflicts.push(RestoreConflictV1 {
                path: None,
                kind: RestoreConflictKindV1::WorkspaceRevisionChanged,
            });
        }
        if !observed.workspace_status_complete {
            if mode == CheckpointRestoreModeV1::Full {
                conflicts.push(RestoreConflictV1 {
                    path: None,
                    kind: RestoreConflictKindV1::WorkspaceStatusUnavailable,
                });
            } else {
                conflicts.extend(selected_paths.iter().cloned().map(|path| {
                    RestoreConflictV1 {
                        path: Some(path),
                        kind: RestoreConflictKindV1::WorkspaceStatusUnavailable,
                    }
                }));
            }
        }
        let dirty: std::collections::BTreeSet<_> = observed.dirty_paths.iter().collect();
        let untracked: std::collections::BTreeSet<_> = observed.untracked_paths.iter().collect();
        let current: std::collections::BTreeMap<_, _> = observed
            .files
            .iter()
            .map(|file| (file.path.as_str(), file))
            .collect();
        let selected: std::collections::BTreeSet<&str> = selected_paths
            .iter()
            .map(String::as_str)
            .collect();
        let mut actions = Vec::new();
        // Full reset is never previewed across a later workspace revision. The
        // explicit selected-path mode is separately fenced by VCS state and
        // HostKernel no-follow facts below.
        let may_plan = observed.workspace_status_complete
            && !(workspace_revision_changed && mode == CheckpointRestoreModeV1::Full);
        for target in &record.capture.files {
            if !may_plan {
                break;
            }
            if mode == CheckpointRestoreModeV1::SelectedPaths
                && !selected.contains(target.path.as_str())
            {
                continue;
            }
            if dirty.contains(&target.path) {
                conflicts.push(RestoreConflictV1 {
                    path: Some(target.path.clone()),
                    kind: RestoreConflictKindV1::DirtyPath,
                });
                continue;
            }
            if untracked.contains(&target.path) {
                conflicts.push(RestoreConflictV1 {
                    path: Some(target.path.clone()),
                    kind: RestoreConflictKindV1::UntrackedPath,
                });
                continue;
            }
            if target.kind != CheckpointFileKindV1::RegularFile || target.link_count != 1 {
                conflicts.push(RestoreConflictV1 {
                    path: Some(target.path.clone()),
                    kind: RestoreConflictKindV1::UnsafePath,
                });
                continue;
            }
            let before = current.get(target.path.as_str()).copied();
            if before.is_some_and(|file| {
                file.kind != WorkspaceFileKindV1::RegularFile || file.link_count != 1
            }) {
                conflicts.push(RestoreConflictV1 {
                    path: Some(target.path.clone()),
                    kind: RestoreConflictKindV1::UnsafePath,
                });
                continue;
            }
            if before.and_then(|file| file.digest.as_ref()) == target.digest.as_ref()
                && before.is_some_and(|file| {
                    file.byte_length == target.byte_length
                        && file.executable == target.executable
                })
            {
                continue;
            }
            actions.push(RestorePathActionV1 {
                path: target.path.clone(),
                expected_before_digest: before.and_then(|file| file.digest.clone()),
                target: target.clone(),
            });
        }
        conflicts.sort_by(|a, b| {
            a.path
                .cmp(&b.path)
                .then_with(|| format!("{:?}", a.kind).cmp(&format!("{:?}", b.kind)))
        });
        actions.sort_by(|a, b| a.path.cmp(&b.path));
        let artifact = record.artifact.clone();
        let preview_digest = preview_digest(
            checkpoint_id,
            &artifact,
            &record.capture,
            observed,
            workspace_revision_changed,
            mode,
            &selected_paths,
            &actions,
            &conflicts,
        )?;
        Ok(CheckpointRestorePreviewV1 {
            checkpoint_id: checkpoint_id.to_owned(),
            checkpoint_artifact: artifact,
            workspace_revision_changed,
            mode,
            selected_paths,
            observed_revision: observed.revision.clone(),
            actions,
            conflicts,
            preview_digest,
        })
    }

    /// Restore remains unavailable until the complete P1 pre-dispatch Guard,
    /// one-use lease, receipt and restart reconciliation contracts are verified.
    pub(crate) fn begin_restore(
        &mut self,
        preview: &CheckpointRestorePreviewV1,
        observed: &WorkspaceObservationV1,
        effect_id: &str,
        lease_ref: &str,
        guard_receipt_ref: &str,
        now_ms: u64,
    ) -> Result<(), CheckpointErrorV1> {
        let current = self.preview_restore_mode(
            &preview.checkpoint_id,
            observed,
            preview.mode,
            preview.selected_paths.clone(),
        )?;
        if current.preview_digest != preview.preview_digest {
            return Err(CheckpointErrorV1::StalePreview);
        }
        if !current.conflicts.is_empty()
            || (current.workspace_revision_changed
                && current.mode == CheckpointRestoreModeV1::Full)
        {
            return Err(CheckpointErrorV1::RestoreConflict);
        }
        if !valid_component(effect_id, MAX_CHECKPOINT_ID_BYTES)
            || !valid_component(lease_ref, MAX_RECEIPT_BYTES)
            || !valid_component(guard_receipt_ref, MAX_RECEIPT_BYTES)
            || !valid_time(now_ms)
        {
            return Err(CheckpointErrorV1::InvalidInput);
        }
        if !CHECKPOINT_RESTORE_ENABLED {
            return Err(CheckpointErrorV1::RestoreUnavailable);
        }
        Err(CheckpointErrorV1::RestoreUnavailable)
    }

    /// Production restore gate. It consumes only the opaque HostKernel
    /// observation and remains unavailable until same-boundary VCS status,
    /// Guard leases, durable receipts and recovery are wired and accepted.
    pub(crate) fn begin_restore_trusted(
        &mut self,
        preview: &CheckpointRestorePreviewV1,
        observed: &TrustedWorkspaceObservationV1,
        effect_id: &str,
        lease_ref: &str,
        guard_receipt_ref: &str,
        now_ms: u64,
    ) -> Result<(), CheckpointErrorV1> {
        let observed = checkpoint_observation_from_host(observed)?;
        self.begin_restore(
            preview,
            &observed,
            effect_id,
            lease_ref,
            guard_receipt_ref,
            now_ms,
        )
    }

    /// Reconcile exact per-path receipts for a previously dispatched restore.
    /// The HostKernel invokes this only after Guard/lease settlement; missing,
    /// failed, or uncertain paths keep the overall restore UNKNOWN.
    pub(crate) fn record_restore_receipts(
        &mut self,
        effect_id: &str,
        receipts: Vec<RestorePathReceiptV1>,
        final_observation: bool,
        now_ms: u64,
    ) -> Result<RestoreAttemptStatusV1, CheckpointErrorV1> {
        if !valid_component(effect_id, MAX_CHECKPOINT_ID_BYTES)
            || receipts.len() > MAX_CHECKPOINT_PATHS
            || !valid_time(now_ms)
        {
            return Err(CheckpointErrorV1::InvalidReceipt);
        }
        let mut next = self.state.clone();
        let attempt = next
            .restore_attempts
            .iter_mut()
            .find(|attempt| attempt.effect_id == effect_id)
            .ok_or(CheckpointErrorV1::NotFound)?;
        if !matches!(
            attempt.status,
            RestoreAttemptStatusV1::InProgress | RestoreAttemptStatusV1::Unknown
        ) {
            return Err(CheckpointErrorV1::InvalidReceipt);
        }
        for receipt in receipts {
            if !valid_relative_path(&receipt.path)
                || !valid_component(&receipt.receipt_ref, MAX_RECEIPT_BYTES)
                || !attempt
                    .planned_paths
                    .iter()
                    .any(|path| path == &receipt.path)
            {
                return Err(CheckpointErrorV1::InvalidReceipt);
            }
            match attempt
                .path_receipts
                .iter()
                .find(|existing| existing.path == receipt.path)
            {
                Some(existing) if existing == &receipt => {}
                Some(_) => return Err(CheckpointErrorV1::InvalidReceipt),
                None => attempt.path_receipts.push(receipt),
            }
        }
        attempt.path_receipts.sort_by(|a, b| a.path.cmp(&b.path));
        let all_applied = attempt.path_receipts.len() == attempt.planned_paths.len()
            && attempt
                .path_receipts
                .iter()
                .all(|receipt| receipt.outcome == RestorePathOutcomeV1::Applied);
        if final_observation {
            attempt.status = if all_applied {
                RestoreAttemptStatusV1::Succeeded
            } else {
                RestoreAttemptStatusV1::Unknown
            };
        } else if attempt
            .path_receipts
            .iter()
            .any(|receipt| receipt.outcome != RestorePathOutcomeV1::Applied)
        {
            attempt.status = RestoreAttemptStatusV1::Unknown;
        }
        let status = attempt.status;
        if next.restore_attempts.len() > MAX_RESTORE_HISTORY {
            next.restore_attempts
                .drain(..next.restore_attempts.len() - MAX_RESTORE_HISTORY);
        }
        self.commit("restore_path_receipts", next, now_ms)?;
        Ok(status)
    }

    pub(crate) fn restore_attempts(&self) -> &[RestoreAttemptV1] {
        &self.state.restore_attempts
    }

    pub(crate) fn commits(&self) -> u64 {
        self.commits
    }
}

fn validate_capture(capture: &CheckpointCaptureV1) -> Result<(), CheckpointErrorV1> {
    if !valid_component(&capture.checkpoint_id, MAX_CHECKPOINT_ID_BYTES)
        || !valid_component(&capture.workspace_revision, MAX_REVISION_BYTES)
        || !valid_digest(&capture.snapshot_manifest_digest)
        || !valid_component(&capture.conversation_position, MAX_REVISION_BYTES)
        || capture.files.len() > MAX_CHECKPOINT_PATHS
    {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    let mut paths = std::collections::BTreeSet::new();
    let mut total_bytes = 0_u64;
    for file in &capture.files {
        validate_file(file)?;
        if !paths.insert(file.path.as_str()) {
            return Err(CheckpointErrorV1::InvalidInput);
        }
        total_bytes = total_bytes
            .checked_add(file.byte_length)
            .ok_or(CheckpointErrorV1::InvalidInput)?;
        if total_bytes > MAX_SNAPSHOT_BYTES as u64 {
            return Err(CheckpointErrorV1::InvalidInput);
        }
    }
    Ok(())
}

fn checkpoint_capture_from_host(
    checkpoint_id: String,
    conversation_position: String,
    snapshot_bundle: &TrustedWorkspaceSnapshotBundleV1,
) -> Result<CheckpointCaptureV1, CheckpointErrorV1> {
    let files = snapshot_bundle
        .files()
        .iter()
        .map(|file| {
            if file.kind() != TrustedWorkspaceFileKindV1::RegularFile || file.link_count() != 1 {
                return Err(CheckpointErrorV1::InvalidSnapshot);
            }
            Ok(CheckpointFileV1 {
                path: file.path().to_owned(),
                digest: Some(file.digest().to_owned()),
                byte_length: file.byte_length(),
                executable: file.executable(),
                kind: CheckpointFileKindV1::RegularFile,
                link_count: file.link_count(),
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let capture = CheckpointCaptureV1 {
        checkpoint_id,
        workspace_revision: snapshot_bundle.revision().to_owned(),
        snapshot_manifest_digest: snapshot_bundle.manifest_digest().to_owned(),
        conversation_position,
        files,
    };
    validate_capture(&capture)?;
    Ok(capture)
}

fn checkpoint_observation_from_host(
    observed: &TrustedWorkspaceObservationV1,
) -> Result<WorkspaceObservationV1, CheckpointErrorV1> {
    let files = observed
        .files()
        .iter()
        .map(|file| WorkspaceFileStateV1 {
            path: file.path().to_owned(),
            digest: Some(file.digest().to_owned()),
            byte_length: file.byte_length(),
            executable: file.executable(),
            kind: match file.kind() {
                TrustedWorkspaceFileKindV1::RegularFile => WorkspaceFileKindV1::RegularFile,
            },
            link_count: file.link_count(),
        })
        .collect();
    let observation = WorkspaceObservationV1 {
        revision: observed.revision().to_owned(),
        dirty_paths: Vec::new(),
        untracked_paths: Vec::new(),
        workspace_status_complete: false,
        files,
    };
    validate_observation(&observation)?;
    Ok(observation)
}

fn validate_capture_admission(
    state: &CheckpointStateV1,
    capture: &CheckpointCaptureV1,
    snapshot_length: u64,
    now_ms: u64,
) -> Result<(), CheckpointErrorV1> {
    validate_capture(capture)?;
    if snapshot_length == 0 || snapshot_length > MAX_SNAPSHOT_BYTES as u64 || !valid_time(now_ms) {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    if state
        .checkpoints
        .iter()
        .any(|record| record.capture.checkpoint_id == capture.checkpoint_id)
    {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    if state.checkpoints.len() >= MAX_CHECKPOINTS_PER_SESSION {
        return Err(CheckpointErrorV1::RetentionLimit);
    }
    let current_total = state.checkpoints.iter().try_fold(0_u64, |total, record| {
        let length = parse_decimal(&record.artifact.byte_length)
            .ok_or(CheckpointErrorV1::InvalidSnapshot)?;
        total
            .checked_add(length)
            .ok_or(CheckpointErrorV1::InvalidSnapshot)
    })?;
    let next_total = current_total
        .checked_add(snapshot_length)
        .ok_or(CheckpointErrorV1::RetentionLimit)?;
    if next_total > MAX_SESSION_SNAPSHOT_BYTES {
        return Err(CheckpointErrorV1::RetentionLimit);
    }
    Ok(())
}

struct PreparedCheckpointEventV1 {
    delivery_id: String,
    event: OwnerEventInput,
    command_digest: String,
}

fn prepare_checkpoint_event(
    next: &CheckpointStateV1,
    operation: &'static str,
    commits: u64,
    last_time_ms: u64,
    now_ms: u64,
) -> Result<PreparedCheckpointEventV1, CheckpointErrorV1> {
    if !valid_time(now_ms) {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    let encoded = next.encode()?;
    let snapshot_json =
        String::from_utf8(encoded).map_err(|_| CheckpointErrorV1::InvalidSnapshot)?;
    let commit_number = commits
        .checked_add(1)
        .ok_or(CheckpointErrorV1::InvalidSnapshot)?;
    let delivery_id = format!("checkpoint-{commit_number}");
    let event = OwnerEventInput {
        schema_version: OWNER_EVENT_SCHEMA_VERSION_V1,
        time_ms: last_time_ms.max(now_ms),
        kind: EVENT_KIND.to_owned(),
        data: serde_json::json!({"operation": operation, "snapshotJson": snapshot_json}),
        delivery_id: None,
        command_digest: None,
    };
    let command_digest =
        match OwnerLogV2::command_digest(&delivery_id, std::slice::from_ref(&event)) {
            Ok(digest) => digest,
            Err(OwnerLogError::LimitExceeded(_)) => return Err(CheckpointErrorV1::InvalidSnapshot),
            Err(error) => return Err(persistence(error)),
        };
    Ok(PreparedCheckpointEventV1 {
        delivery_id,
        event,
        command_digest,
    })
}

fn validate_prospective_capture(
    state: &CheckpointStateV1,
    capture: &CheckpointCaptureV1,
    artifact: &ArtifactRefRecordV1,
    snapshot_length: u64,
    now_ms: u64,
    commits: u64,
    last_time_ms: u64,
) -> Result<(), CheckpointErrorV1> {
    validate_capture_admission(state, capture, snapshot_length, now_ms)?;
    if !valid_artifact_record(artifact)
        || parse_decimal(&artifact.byte_length) != Some(snapshot_length)
        || !valid_time(now_ms)
    {
        return Err(CheckpointErrorV1::InvalidSnapshot);
    }
    let mut next = state.clone();
    next.checkpoints.push(CheckpointRecordV1 {
        capture: capture.clone(),
        artifact: artifact.clone(),
        created_at_ms: now_ms,
    });
    // Preflight both the state record and the OwnerLog's escaped physical event.
    // `commit` uses this same preparation function after the artifact is verified.
    prepare_checkpoint_event(&next, "checkpoint_captured", commits, last_time_ms, now_ms)?;
    Ok(())
}

pub(crate) fn preview_checkpoint_eviction(
    session_id: &str,
    candidates: &[CheckpointEvictionCandidateV1],
    required_count: usize,
    required_bytes: u64,
) -> Result<CheckpointEvictionPreviewV1, CheckpointErrorV1> {
    if !valid_component(session_id, MAX_CHECKPOINT_ID_BYTES)
        || candidates.len() > MAX_CHECKPOINTS_PER_SESSION
        || required_count > MAX_CHECKPOINTS_PER_SESSION
        || required_bytes > MAX_SESSION_SNAPSHOT_BYTES
    {
        return Err(CheckpointErrorV1::InvalidInput);
    }

    let expected_owner = format!("session:{session_id}");
    let mut seen = std::collections::BTreeSet::new();
    let mut sorted = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        if !valid_component(&candidate.checkpoint_id, MAX_CHECKPOINT_ID_BYTES)
            || !valid_component(&candidate.owner_ref, MAX_CHECKPOINT_ID_BYTES * 2)
            || !valid_time(candidate.created_at_ms)
            || !seen.insert(candidate.checkpoint_id.as_str())
        {
            return Err(CheckpointErrorV1::InvalidInput);
        }
        let byte_length = parse_decimal(&candidate.byte_length)
            .filter(|length| *length > 0 && *length <= MAX_SNAPSHOT_BYTES as u64)
            .ok_or(CheckpointErrorV1::InvalidInput)?;
        sorted.push((candidate, byte_length));
    }
    sorted.sort_by(|(left, _), (right, _)| {
        left.created_at_ms
            .cmp(&right.created_at_ms)
            .then_with(|| left.checkpoint_id.cmp(&right.checkpoint_id))
    });

    let mut preview = CheckpointEvictionPreviewV1 {
        required_count,
        required_bytes,
        planned_bytes: 0,
        ready: required_count == 0 && required_bytes == 0,
        planned: Vec::new(),
        blocked: Vec::new(),
    };

    for (candidate, byte_length) in sorted {
        if preview.planned.len() >= required_count && preview.planned_bytes >= required_bytes {
            break;
        }

        let blocked_reason = if !candidate.state_known || !candidate.settled {
            Some(CheckpointEvictionBlockReasonV1::UnknownOrUnsettled)
        } else if candidate.owner_ref != expected_owner {
            Some(CheckpointEvictionBlockReasonV1::WrongScope)
        } else if candidate.pinned {
            Some(CheckpointEvictionBlockReasonV1::Pinned)
        } else if !candidate.unreferenced {
            Some(CheckpointEvictionBlockReasonV1::Referenced)
        } else if !candidate.disposable {
            Some(CheckpointEvictionBlockReasonV1::NotDisposable)
        } else if !candidate.rebuildable {
            Some(CheckpointEvictionBlockReasonV1::NotRebuildable)
        } else {
            None
        };

        if let Some(reason) = blocked_reason {
            preview.blocked.push(CheckpointEvictionBlockerV1 {
                checkpoint_id: candidate.checkpoint_id.clone(),
                byte_length,
                reason,
            });
            continue;
        }

        preview.planned_bytes = preview
            .planned_bytes
            .checked_add(byte_length)
            .ok_or(CheckpointErrorV1::InvalidInput)?;
        preview.planned.push(CheckpointEvictionItemV1 {
            checkpoint_id: candidate.checkpoint_id.clone(),
            byte_length,
            created_at_ms: candidate.created_at_ms,
            reason: CheckpointEvictionReasonV1::Pressure,
        });
    }

    preview.ready =
        preview.planned.len() >= required_count && preview.planned_bytes >= required_bytes;
    Ok(preview)
}

fn publish_checkpoint_capture<T>(
    state: &CheckpointStateV1,
    capture: &CheckpointCaptureV1,
    artifact: &ArtifactRefRecordV1,
    snapshot_length: u64,
    now_ms: u64,
    commits: u64,
    last_time_ms: u64,
    publish: impl FnOnce() -> Result<T, CheckpointErrorV1>,
) -> Result<T, CheckpointErrorV1> {
    validate_prospective_capture(
        state,
        capture,
        artifact,
        snapshot_length,
        now_ms,
        commits,
        last_time_ms,
    )?;
    publish()
}

fn validate_file(file: &CheckpointFileV1) -> Result<(), CheckpointErrorV1> {
    if !valid_relative_path(&file.path)
        || file
            .digest
            .as_ref()
            .is_some_and(|digest| !valid_digest(digest))
        || match file.kind {
            CheckpointFileKindV1::RegularFile => {
                file.digest.is_none() || file.link_count != 1
            }
            CheckpointFileKindV1::Absent => {
                file.digest.is_some() || file.byte_length != 0 || file.link_count != 0
            }
        }
    {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    Ok(())
}

fn validate_observation(observed: &WorkspaceObservationV1) -> Result<(), CheckpointErrorV1> {
    if !valid_component(&observed.revision, MAX_REVISION_BYTES)
        || observed.files.len() > MAX_CHECKPOINT_PATHS * 2
        || observed.dirty_paths.len() > MAX_CHECKPOINT_PATHS * 2
        || observed.untracked_paths.len() > MAX_CHECKPOINT_PATHS * 2
    {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    let path_bytes = observed
        .files
        .iter()
        .map(|file| file.path.len())
        .chain(observed.dirty_paths.iter().map(String::len))
        .chain(observed.untracked_paths.iter().map(String::len))
        .try_fold(0usize, usize::checked_add)
        .ok_or(CheckpointErrorV1::InvalidInput)?;
    if path_bytes > MAX_OBSERVATION_BYTES {
        return Err(CheckpointErrorV1::InvalidInput);
    }
    let mut paths = std::collections::BTreeSet::new();
    for file in &observed.files {
        if !valid_relative_path(&file.path)
            || file
                .digest
                .as_ref()
                .is_some_and(|digest| !valid_digest(digest))
            || file.digest.is_none() && file.byte_length != 0
            || (file.kind == WorkspaceFileKindV1::RegularFile && file.link_count != 1)
            || !paths.insert(file.path.as_str())
        {
            return Err(CheckpointErrorV1::InvalidInput);
        }
    }
    for path in observed.dirty_paths.iter().chain(&observed.untracked_paths) {
        if !valid_relative_path(path) {
            return Err(CheckpointErrorV1::InvalidInput);
        }
    }
    Ok(())
}

fn validate_attempt(attempt: &RestoreAttemptV1) -> Result<(), CheckpointErrorV1> {
    if !valid_component(&attempt.effect_id, MAX_CHECKPOINT_ID_BYTES)
        || !valid_component(&attempt.checkpoint_id, MAX_CHECKPOINT_ID_BYTES)
        || !valid_digest(&attempt.preview_digest)
        || !valid_component(&attempt.lease_ref, MAX_RECEIPT_BYTES)
        || attempt.planned_paths.len() > MAX_CHECKPOINT_PATHS
        || attempt.path_receipts.len() > MAX_CHECKPOINT_PATHS
    {
        return Err(CheckpointErrorV1::InvalidSnapshot);
    }
    let mut paths = std::collections::BTreeSet::new();
    for path in &attempt.planned_paths {
        if !valid_relative_path(path) || !paths.insert(path.as_str()) {
            return Err(CheckpointErrorV1::InvalidSnapshot);
        }
    }
    let mut receipt_paths = std::collections::BTreeSet::new();
    for receipt in &attempt.path_receipts {
        if !valid_relative_path(&receipt.path)
            || !valid_component(&receipt.receipt_ref, MAX_RECEIPT_BYTES)
            || !attempt
                .planned_paths
                .iter()
                .any(|path| path == &receipt.path)
            || !receipt_paths.insert(receipt.path.as_str())
        {
            return Err(CheckpointErrorV1::InvalidSnapshot);
        }
    }
    Ok(())
}

fn valid_component(value: &str, max: usize) -> bool {
    !value.is_empty() && value.len() <= max && !value.chars().any(char::is_control)
}

fn valid_relative_path(path: &str) -> bool {
    valid_component(path, MAX_PATH_BYTES)
        && !path.starts_with('/')
        && !path.starts_with('\\')
        && !path.contains('\\')
        && path
            .split('/')
            .all(|part| !part.is_empty() && part != "." && part != "..")
}

fn valid_digest(value: &str) -> bool {
    value
        .strip_prefix("blake3:")
        .is_some_and(|hex| Digest::parse_hex(hex).is_ok())
}

fn valid_time(value: u64) -> bool {
    value <= MAX_SAFE_TIME_MS
}

fn parse_decimal(value: &str) -> Option<u64> {
    if value.is_empty()
        || value.len() > 1 && value.starts_with('0')
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn artifact_record(reference: &ArtifactRefV1) -> ArtifactRefRecordV1 {
    ArtifactRefRecordV1 {
        artifact_id: reference.artifact_id.clone(),
        digest: reference.digest.clone(),
        byte_length: reference.byte_length.clone(),
        media_type: reference.media_type.clone(),
        classification: match reference.classification {
            crate::protocol::ArtifactClassificationV1::Public => "public",
            crate::protocol::ArtifactClassificationV1::Workspace => "workspace",
            crate::protocol::ArtifactClassificationV1::Sensitive => "sensitive",
        }
        .to_owned(),
    }
}

fn access_classification(access: ArtifactAccessV1) -> &'static str {
    match access {
        ArtifactAccessV1::Public => "public",
        ArtifactAccessV1::Workspace => "workspace",
        ArtifactAccessV1::Sensitive => "sensitive",
    }
}

fn valid_artifact_record(reference: &ArtifactRefRecordV1) -> bool {
    valid_component(&reference.artifact_id, MAX_CHECKPOINT_ID_BYTES)
        && valid_digest(&reference.digest)
        && parse_decimal(&reference.byte_length)
            .is_some_and(|length| length > 0 && length <= MAX_SNAPSHOT_BYTES as u64)
        && valid_component(&reference.media_type, 256)
        && matches!(
            reference.classification.as_str(),
            "public" | "workspace" | "sensitive"
        )
}

fn preview_digest(
    checkpoint_id: &str,
    artifact: &ArtifactRefRecordV1,
    capture: &CheckpointCaptureV1,
    observed: &WorkspaceObservationV1,
    workspace_revision_changed: bool,
    mode: CheckpointRestoreModeV1,
    selected_paths: &[String],
    actions: &[RestorePathActionV1],
    conflicts: &[RestoreConflictV1],
) -> Result<String, CheckpointErrorV1> {
    let mut observation = observed.clone();
    observation.dirty_paths.sort();
    observation.untracked_paths.sort();
    observation.files.sort_by(|a, b| a.path.cmp(&b.path));
    let value = serde_json::json!({
        "actions": actions,
        "artifact": artifact,
        "captureManifest": capture,
        "checkpointID": checkpoint_id,
        "conflicts": conflicts,
        "workspaceRevisionChanged": workspace_revision_changed,
        "mode": mode,
        "observation": observation,
        "selectedPaths": selected_paths,
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| CheckpointErrorV1::InvalidSnapshot)?;
    Ok(format!("blake3:{}", Digest::from_blake3(&bytes).to_hex()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::artifact_store::{
        ArtifactAccessV1, ArtifactAuthorizer, ArtifactEncryptionV1, ArtifactRedactionV1, ReadPermit,
    };
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    struct Allow;
    impl ArtifactAuthorizer for Allow {
        fn authorize_read(
            &self,
            _principal: &str,
            reference: &ArtifactRefV1,
        ) -> Result<ReadPermit, ArtifactError> {
            Ok(ReadPermit::new(reference.clone()))
        }
    }

    struct TempRoot(std::path::PathBuf);
    impl TempRoot {
        fn new() -> Self {
            let tick = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = std::env::var_os("HORIZON_OWNER_LOG_TEST_TMPDIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir)
                .join(format!(
                    "horizon-checkpoint-{}-{tick}-{}",
                    std::process::id(),
                    NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
                ));
            fs::create_dir_all(&root).unwrap();
            Self(root)
        }
    }
    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn file(path: &str, bytes: &[u8]) -> CheckpointFileV1 {
        CheckpointFileV1 {
            path: path.to_owned(),
            digest: Some(format!("blake3:{}", Digest::from_blake3(bytes).to_hex())),
            byte_length: bytes.len() as u64,
            executable: false,
            kind: CheckpointFileKindV1::RegularFile,
            link_count: 1,
        }
    }

    fn observed_file(path: &str, bytes: &[u8]) -> WorkspaceFileStateV1 {
        WorkspaceFileStateV1 {
            path: path.to_owned(),
            digest: Some(format!("blake3:{}", Digest::from_blake3(bytes).to_hex())),
            byte_length: bytes.len() as u64,
            executable: false,
            kind: WorkspaceFileKindV1::RegularFile,
            link_count: 1,
        }
    }

    fn capture(id: &str) -> CheckpointCaptureV1 {
        CheckpointCaptureV1 {
            checkpoint_id: id.to_owned(),
            workspace_revision: "commit-a".to_owned(),
            snapshot_manifest_digest: format!("blake3:{}", Digest::from_blake3(b"test manifest").to_hex()),
            conversation_position: "message-7:part-2".to_owned(),
            files: vec![file("src/main.rs", b"checkpoint bytes")],
        }
    }

    fn eviction_candidate(
        checkpoint_id: &str,
        created_at_ms: u64,
        byte_length: u64,
        owner_ref: &str,
    ) -> CheckpointEvictionCandidateV1 {
        CheckpointEvictionCandidateV1 {
            checkpoint_id: checkpoint_id.to_owned(),
            owner_ref: owner_ref.to_owned(),
            created_at_ms,
            byte_length: byte_length.to_string(),
            disposable: true,
            rebuildable: true,
            pinned: false,
            unreferenced: true,
            settled: true,
            state_known: true,
        }
    }

    fn publish_test_capture<T>(
        state: &CheckpointStateV1,
        capture: &CheckpointCaptureV1,
        snapshot_length: u64,
        now_ms: u64,
        publish: impl FnOnce() -> Result<T, CheckpointErrorV1>,
    ) -> Result<T, CheckpointErrorV1> {
        let artifact = ArtifactRefRecordV1 {
            artifact_id: format!("snapshot-{}", capture.checkpoint_id),
            digest: format!(
                "blake3:{}",
                Digest::from_blake3(b"prospective snapshot").to_hex()
            ),
            byte_length: snapshot_length.to_string(),
            media_type: "application/vnd.horizon.checkpoint+json".to_owned(),
            classification: "workspace".to_owned(),
        };
        publish_checkpoint_capture(
            state,
            capture,
            &artifact,
            snapshot_length,
            now_ms,
            1,
            100,
            publish,
        )
    }

    fn create_checkpoint(
        root: &std::path::Path,
        capture: CheckpointCaptureV1,
    ) -> (CheckpointJournalV1, WorkspaceObservationV1) {
        let artifact_root = root.join("artifacts");
        let ingress = GuardedArtifactIngressV1::open(&artifact_root, Allow).unwrap();
        let owner = ArtifactOwnerScopeV1::new("session", "session-1").unwrap();
        let mut journal = CheckpointJournalV1::open(&root.join("journal"), "session-1").unwrap();
        let bytes = serde_json::to_vec(&capture).unwrap();
        let reference = ingress
            .capture_after_guard_authorization(
                &owner,
                format!("snapshot-{}", capture.checkpoint_id),
                ArtifactWriteMetadataV1 {
                    media_type: "application/vnd.horizon.checkpoint+json".to_owned(),
                    access: ArtifactAccessV1::Workspace,
                    retention_class: "checkpoint".to_owned(),
                    created_at: "2026-10-18T12:00:00.000Z".to_owned(),
                    encryption: ArtifactEncryptionV1::None,
                    redaction: ArtifactRedactionV1::NotNeeded,
                },
                CapturedArtifactV1 {
                    observed_byte_count: bytes.len() as u64,
                    dropped_byte_count: 0,
                    fidelity: ArtifactFidelityV1::Full,
                    bytes,
                },
            )
            .unwrap();
        let verified = ingress
            .verify_ref(
                &owner,
                "session:session-1",
                &reference,
                NonZeroUsize::new(MAX_SNAPSHOT_BYTES).unwrap(),
            )
            .unwrap();
        journal
            .record_verified_capture(capture, &reference, &verified, 100)
            .unwrap();
        let observed = WorkspaceObservationV1 {
            revision: "commit-a".to_owned(),
            dirty_paths: Vec::new(),
            untracked_paths: Vec::new(),
            workspace_status_complete: true,
            files: vec![observed_file("src/main.rs", b"later code")],
        };
        (journal, observed)
    }

    #[test]
    fn cp001_changed_workspace_revision_refuses_destructive_restore() {
        let root = TempRoot::new();
        let (mut journal, mut observed) = create_checkpoint(&root.0, capture("cp-001"));
        let preview = journal.preview_restore("cp-001", &observed).unwrap();
        assert_eq!(preview.actions.len(), 1);

        observed.revision = "commit-b".to_owned();
        let refused = journal.preview_restore("cp-001", &observed).unwrap();
        assert!(refused.actions.is_empty());
        assert_eq!(
            refused.conflicts,
            [RestoreConflictV1 {
                path: None,
                kind: RestoreConflictKindV1::WorkspaceRevisionChanged
            }]
        );
        assert_ne!(preview.preview_digest, refused.preview_digest);
        assert_eq!(
            journal.begin_restore(&preview, &observed, "effect-1", "lease-1", "guard-1", 101),
            Err(CheckpointErrorV1::StalePreview)
        );
        assert_eq!(
            journal.begin_restore(&refused, &observed, "effect-1", "lease-1", "guard-1", 101),
            Err(CheckpointErrorV1::RestoreConflict)
        );
    }

    #[test]
    fn cp001_changed_workspace_revision_allows_only_explicit_conflict_free_path_preview() {
        let root = TempRoot::new();
        let capture = CheckpointCaptureV1 {
            files: vec![
                file("src/main.rs", b"checkpoint main"),
                file("src/lib.rs", b"checkpoint lib"),
            ],
            ..capture("cp-001-targeted")
        };
        let (mut journal, mut observed) = create_checkpoint(&root.0, capture);
        observed.revision = "commit-b".to_owned();
        observed.files = vec![
            observed_file("src/main.rs", b"later main"),
            observed_file("src/lib.rs", b"later lib"),
        ];
        observed.dirty_paths = vec!["src/lib.rs".to_owned()];

        let full = journal.preview_restore("cp-001-targeted", &observed).unwrap();
        assert!(full.workspace_revision_changed);
        assert_eq!(full.mode, CheckpointRestoreModeV1::Full);
        assert!(full.actions.is_empty());
        assert!(full
            .conflicts
            .iter()
            .any(|item| item.kind == RestoreConflictKindV1::WorkspaceRevisionChanged));

        let selected = journal
            .preview_restore_selected_paths(
                "cp-001-targeted",
                &observed,
                vec!["src/main.rs".to_owned()],
            )
            .unwrap();
        assert!(selected.workspace_revision_changed);
        assert_eq!(selected.mode, CheckpointRestoreModeV1::SelectedPaths);
        assert_eq!(selected.selected_paths, ["src/main.rs"]);
        assert_eq!(
            selected
                .actions
                .iter()
                .map(|action| action.path.as_str())
                .collect::<Vec<_>>(),
            ["src/main.rs"]
        );
        assert!(selected.conflicts.is_empty());

        let dirty = journal
            .preview_restore_selected_paths(
                "cp-001-targeted",
                &observed,
                vec!["src/lib.rs".to_owned()],
            )
            .unwrap();
        assert!(dirty.actions.is_empty());
        assert_eq!(
            dirty.conflicts,
            [RestoreConflictV1 {
                path: Some("src/lib.rs".to_owned()),
                kind: RestoreConflictKindV1::DirtyPath,
            }]
        );
        assert_ne!(selected.preview_digest, dirty.preview_digest);
        assert_eq!(
            journal.begin_restore(&selected, &observed, "effect", "lease", "receipt", 102),
            Err(CheckpointErrorV1::RestoreUnavailable)
        );

        assert_eq!(
            journal.preview_restore_selected_paths(
                "cp-001-targeted",
                &observed,
                vec!["src/main.rs".to_owned(), "src/main.rs".to_owned()],
            ),
            Err(CheckpointErrorV1::InvalidInput)
        );
    }

    #[test]
    fn cp002_later_untracked_target_is_preserved_and_safe_paths_remain_previewable() {
        let root = TempRoot::new();
        let capture = CheckpointCaptureV1 {
            files: vec![
                file("src/main.rs", b"checkpoint bytes"),
                file("src/other.rs", b"other baseline"),
            ],
            ..capture("cp-002")
        };
        let (mut journal, mut observed) = create_checkpoint(&root.0, capture);
        observed.untracked_paths = vec!["src/main.rs".to_owned()];
        let preview = journal.preview_restore("cp-002", &observed).unwrap();
        assert_eq!(
            preview
                .actions
                .iter()
                .map(|action| action.path.as_str())
                .collect::<Vec<_>>(),
            ["src/other.rs"]
        );
        assert_eq!(
            preview.conflicts,
            [RestoreConflictV1 {
                path: Some("src/main.rs".to_owned()),
                kind: RestoreConflictKindV1::UntrackedPath
            }]
        );
        assert_eq!(
            journal.begin_restore(&preview, &observed, "effect-2", "lease-2", "guard-2", 102),
            Err(CheckpointErrorV1::RestoreConflict)
        );
    }

    #[test]
    fn dirty_target_and_unrelated_untracked_files_are_reported_without_clobbering() {
        let root = TempRoot::new();
        let (journal, mut observed) = create_checkpoint(&root.0, capture("dirty"));
        observed.dirty_paths = vec!["src/main.rs".to_owned()];
        observed.untracked_paths = vec!["notes.txt".to_owned()];
        let preview = journal.preview_restore("dirty", &observed).unwrap();
        assert!(preview.actions.is_empty());
        assert_eq!(preview.conflicts.len(), 1);
        assert_eq!(preview.conflicts[0].kind, RestoreConflictKindV1::DirtyPath);
    }

    #[test]
    fn preview_digest_changes_for_unrelated_untracked_or_file_state_changes() {
        let root = TempRoot::new();
        let (journal, mut observed) = create_checkpoint(&root.0, capture("bind-current"));
        let original = journal.preview_restore("bind-current", &observed).unwrap();
        observed.untracked_paths.push("notes.txt".to_owned());
        let with_untracked = journal.preview_restore("bind-current", &observed).unwrap();
        assert_ne!(original.preview_digest, with_untracked.preview_digest);
        observed.untracked_paths.clear();
        observed.files[0].digest = Some(format!(
            "blake3:{}",
            Digest::from_blake3(b"different").to_hex()
        ));
        let changed_file = journal.preview_restore("bind-current", &observed).unwrap();
        assert_ne!(original.preview_digest, changed_file.preview_digest);
    }

    #[test]
    fn selected_restore_requires_complete_status_and_regular_single_link_files() {
        let root = TempRoot::new();
        let (journal, mut observed) = create_checkpoint(&root.0, capture("unsafe-selected"));

        observed.workspace_status_complete = false;
        let status_unknown = journal
            .preview_restore_selected_paths(
                "unsafe-selected",
                &observed,
                vec!["src/main.rs".to_owned()],
            )
            .unwrap();
        assert!(status_unknown.actions.is_empty());
        assert_eq!(
            status_unknown.conflicts,
            [RestoreConflictV1 {
                path: Some("src/main.rs".to_owned()),
                kind: RestoreConflictKindV1::WorkspaceStatusUnavailable,
            }]
        );

        observed.workspace_status_complete = true;
        observed.files[0].link_count = 2;
        let hard_link = journal
            .preview_restore_selected_paths(
                "unsafe-selected",
                &observed,
                vec!["src/main.rs".to_owned()],
            )
            .unwrap();
        assert!(hard_link.actions.is_empty());
        assert_eq!(
            hard_link.conflicts,
            [RestoreConflictV1 {
                path: Some("src/main.rs".to_owned()),
                kind: RestoreConflictKindV1::UnsafePath,
            }]
        );

        observed.files[0].link_count = 1;
        observed.files[0].kind = WorkspaceFileKindV1::Symlink;
        let symlink = journal
            .preview_restore_selected_paths(
                "unsafe-selected",
                &observed,
                vec!["src/main.rs".to_owned()],
            )
            .unwrap();
        assert!(symlink.actions.is_empty());
        assert_eq!(symlink.conflicts[0].kind, RestoreConflictKindV1::UnsafePath);
    }

    #[test]
    fn trusted_host_observation_is_bound_but_blocks_until_vcs_status_is_available() {
        let root = TempRoot::new();
        let workspace = root.0.join("workspace");
        fs::create_dir_all(workspace.join("src")).unwrap();
        fs::write(workspace.join("src/main.rs"), b"workspace content").unwrap();
        let trusted = crate::host_kernel::observe_trusted_workspace(&workspace).unwrap();
        let (journal, _) = create_checkpoint(&root.0, capture("trusted-observation"));

        let preview = journal
            .preview_restore_trusted(
                "trusted-observation",
                &trusted,
                CheckpointRestoreModeV1::SelectedPaths,
                vec!["src/main.rs".to_owned()],
            )
            .unwrap();
        assert!(preview.actions.is_empty());
        assert_eq!(
            preview.conflicts,
            [RestoreConflictV1 {
                path: Some("src/main.rs".to_owned()),
                kind: RestoreConflictKindV1::WorkspaceStatusUnavailable,
            }]
        );
    }

    #[test]
    fn partial_restore_restart_is_unknown_and_keeps_exact_per_path_receipts() {
        let root = TempRoot::new();
        let capture = CheckpointCaptureV1 {
            files: vec![
                file("src/main.rs", b"checkpoint bytes"),
                file("src/other.rs", b"other baseline"),
            ],
            ..capture("partial")
        };
        let (mut journal, observed) = create_checkpoint(&root.0, capture);
        let preview = journal.preview_restore("partial", &observed).unwrap();
        journal
            .begin_restore_for_test(&preview, &observed, "effect-partial", "lease-partial", 101)
            .unwrap();
        let status = journal
            .record_restore_receipts(
                "effect-partial",
                vec![RestorePathReceiptV1 {
                    path: "src/main.rs".to_owned(),
                    outcome: RestorePathOutcomeV1::Applied,
                    receipt_ref: "receipt-path-1".to_owned(),
                }],
                false,
                102,
            )
            .unwrap();
        assert_eq!(status, RestoreAttemptStatusV1::InProgress);
        drop(journal);

        let reopened = CheckpointJournalV1::open(&root.0.join("journal"), "session-1").unwrap();
        let attempt = reopened.restore_attempts().last().unwrap();
        assert_eq!(attempt.status, RestoreAttemptStatusV1::Unknown);
        assert_eq!(
            attempt.path_receipts,
            [RestorePathReceiptV1 {
                path: "src/main.rs".to_owned(),
                outcome: RestorePathOutcomeV1::Applied,
                receipt_ref: "receipt-path-1".to_owned(),
            }]
        );
    }

    #[test]
    fn restore_completion_requires_every_planned_path_receipt_and_is_durable() {
        let root = TempRoot::new();
        let capture = CheckpointCaptureV1 {
            files: vec![
                file("src/main.rs", b"checkpoint bytes"),
                file("src/other.rs", b"other baseline"),
            ],
            ..capture("complete")
        };
        let (mut journal, observed) = create_checkpoint(&root.0, capture);
        let preview = journal.preview_restore("complete", &observed).unwrap();
        journal
            .begin_restore_for_test(
                &preview,
                &observed,
                "effect-complete",
                "lease-complete",
                101,
            )
            .unwrap();
        let receipts = preview
            .actions
            .iter()
            .enumerate()
            .map(|(index, action)| RestorePathReceiptV1 {
                path: action.path.clone(),
                outcome: RestorePathOutcomeV1::Applied,
                receipt_ref: format!("receipt-{index}"),
            })
            .collect();
        assert_eq!(
            journal
                .record_restore_receipts("effect-complete", receipts, true, 102)
                .unwrap(),
            RestoreAttemptStatusV1::Succeeded
        );
        drop(journal);
        let reopened = CheckpointJournalV1::open(&root.0.join("journal"), "session-1").unwrap();
        assert_eq!(
            reopened.restore_attempts().last().unwrap().status,
            RestoreAttemptStatusV1::Succeeded
        );
    }

    #[test]
    fn capture_and_observation_bounds_reject_unsafe_paths_and_huge_manifests() {
        let mut bad = capture("bad-path");
        bad.files[0].path = "../outside".to_owned();
        assert_eq!(validate_capture(&bad), Err(CheckpointErrorV1::InvalidInput));
        let huge = CheckpointCaptureV1 {
            files: (0..=MAX_CHECKPOINT_PATHS)
                .map(|index| file(&format!("src/{index}.rs"), b"x"))
                .collect(),
            ..capture("huge")
        };
        assert_eq!(
            validate_capture(&huge),
            Err(CheckpointErrorV1::InvalidInput)
        );
    }

    #[test]
    fn capture_admission_rejects_duplicate_id_retention_and_invalid_time_before_publication() {
        let root = TempRoot::new();
        let (journal, _) = create_checkpoint(&root.0, capture("already-captured"));
        let duplicate = capture("already-captured");
        let mut published = false;
        assert_eq!(
            publish_test_capture(&journal.state, &duplicate, 16, 101, || {
                published = true;
                Ok(())
            }),
            Err(CheckpointErrorV1::InvalidInput)
        );
        assert!(
            !published,
            "duplicate checkpoints must be rejected before artifact publication"
        );

        let mut full_count = journal.state.clone();
        for index in full_count.checkpoints.len()..MAX_CHECKPOINTS_PER_SESSION {
            let mut record = full_count.checkpoints[0].clone();
            record.capture.checkpoint_id = format!("filled-{index}");
            full_count.checkpoints.push(record);
        }
        published = false;
        assert_eq!(
            publish_test_capture(&full_count, &capture("count-limit"), 16, 101, || {
                published = true;
                Ok(())
            }),
            Err(CheckpointErrorV1::RetentionLimit)
        );
        assert!(
            !published,
            "checkpoint-count retention must be checked before artifact publication"
        );

        let mut full_bytes = journal.state.clone();
        for index in 0..8 {
            let mut record = full_bytes.checkpoints[0].clone();
            record.capture.checkpoint_id = format!("bytes-{index}");
            record.artifact.byte_length = (MAX_SNAPSHOT_BYTES as u64).to_string();
            full_bytes.checkpoints.push(record);
        }
        published = false;
        assert_eq!(
            publish_test_capture(&full_bytes, &capture("byte-limit"), 16, 101, || {
                published = true;
                Ok(())
            }),
            Err(CheckpointErrorV1::RetentionLimit)
        );
        assert!(
            !published,
            "byte retention must be checked before artifact publication"
        );

        published = false;
        assert_eq!(
            publish_test_capture(
                &journal.state,
                &capture("bad-time"),
                16,
                MAX_SAFE_TIME_MS + 1,
                || {
                    published = true;
                    Ok(())
                }
            ),
            Err(CheckpointErrorV1::InvalidInput)
        );
        assert!(
            !published,
            "invalid timestamps must be rejected before artifact publication"
        );
    }

    #[test]
    fn eviction_preview_selects_oldest_eligible_same_session_candidates_only() {
        let candidates = vec![
            eviction_candidate("newest", 40, 12, "session:session-1"),
            eviction_candidate("tie-z", 30, 4, "session:session-1"),
            eviction_candidate("oldest", 10, 8, "session:session-1"),
            eviction_candidate("middle", 20, 16, "session:session-1"),
            eviction_candidate("tie-a", 30, 4, "session:session-1"),
        ];

        let preview = preview_checkpoint_eviction("session-1", &candidates, 4, 32).unwrap();

        assert!(preview.ready);
        assert_eq!(
            preview
                .planned
                .iter()
                .map(|item| item.checkpoint_id.as_str())
                .collect::<Vec<_>>(),
            ["oldest", "middle", "tie-a", "tie-z"]
        );
        assert_eq!(
            preview
                .planned
                .iter()
                .map(|item| item.byte_length)
                .sum::<u64>(),
            32
        );
        assert!(preview.blocked.is_empty());
    }

    #[test]
    fn eviction_preview_reports_ineligible_unknown_shared_and_foreign_candidates() {
        let mut pinned = eviction_candidate("pinned", 1, 8, "session:session-1");
        pinned.pinned = true;
        let mut shared = eviction_candidate("shared", 2, 8, "session:session-1");
        shared.unreferenced = false;
        let mut unknown = eviction_candidate("unknown", 3, 8, "session:session-1");
        unknown.state_known = false;
        let mut unsettled = eviction_candidate("unsettled", 4, 8, "session:session-1");
        unsettled.settled = false;
        let foreign = eviction_candidate("foreign", 5, 8, "session:session-2");
        let mut non_disposable = eviction_candidate("kept", 6, 8, "session:session-1");
        non_disposable.disposable = false;
        let mut non_rebuildable = eviction_candidate("unique", 7, 8, "session:session-1");
        non_rebuildable.rebuildable = false;

        let preview = preview_checkpoint_eviction(
            "session-1",
            &[
                pinned,
                shared,
                unknown,
                unsettled,
                foreign,
                non_disposable,
                non_rebuildable,
            ],
            1,
            8,
        )
        .unwrap();

        assert!(!preview.ready);
        assert!(preview.planned.is_empty());
        assert_eq!(
            preview
                .blocked
                .iter()
                .map(|item| (item.checkpoint_id.as_str(), item.reason))
                .collect::<Vec<_>>(),
            [
                ("pinned", CheckpointEvictionBlockReasonV1::Pinned),
                ("shared", CheckpointEvictionBlockReasonV1::Referenced),
                (
                    "unknown",
                    CheckpointEvictionBlockReasonV1::UnknownOrUnsettled
                ),
                (
                    "unsettled",
                    CheckpointEvictionBlockReasonV1::UnknownOrUnsettled
                ),
                ("foreign", CheckpointEvictionBlockReasonV1::WrongScope),
                ("kept", CheckpointEvictionBlockReasonV1::NotDisposable),
                ("unique", CheckpointEvictionBlockReasonV1::NotRebuildable),
            ]
        );
    }

    #[test]
    fn eviction_preview_skips_blocked_oldest_and_uses_next_eligible_candidate() {
        let mut oldest = eviction_candidate("oldest-pinned", 1, 8, "session:session-1");
        oldest.pinned = true;
        let next = eviction_candidate("next-eligible", 2, 8, "session:session-1");

        let preview = preview_checkpoint_eviction("session-1", &[next, oldest], 1, 8).unwrap();

        assert!(preview.ready);
        assert_eq!(preview.planned.len(), 1);
        assert_eq!(preview.planned[0].checkpoint_id, "next-eligible");
        assert_eq!(preview.planned_bytes, 8);
        assert_eq!(preview.blocked.len(), 1);
        assert_eq!(preview.blocked[0].checkpoint_id, "oldest-pinned");
        assert_eq!(
            preview.blocked[0].reason,
            CheckpointEvictionBlockReasonV1::Pinned
        );
    }

    #[test]
    fn eviction_preview_bounds_candidates_and_never_claims_unplanned_bytes() {
        let too_many = (0..=MAX_CHECKPOINTS_PER_SESSION)
            .map(|index| {
                eviction_candidate(
                    &format!("checkpoint-{index}"),
                    index as u64,
                    8,
                    "session:session-1",
                )
            })
            .collect::<Vec<_>>();
        assert_eq!(
            preview_checkpoint_eviction("session-1", &too_many, 1, 8),
            Err(CheckpointErrorV1::InvalidInput)
        );
        assert_eq!(
            preview_checkpoint_eviction("session-1", &[], 0, MAX_SESSION_SNAPSHOT_BYTES + 1),
            Err(CheckpointErrorV1::InvalidInput)
        );
        let duplicate = [
            eviction_candidate("duplicate", 1, 8, "session:session-1"),
            eviction_candidate("duplicate", 2, 8, "session:session-1"),
        ];
        assert_eq!(
            preview_checkpoint_eviction("session-1", &duplicate, 1, 8),
            Err(CheckpointErrorV1::InvalidInput)
        );

        let candidates = [eviction_candidate(
            "only-candidate",
            1,
            8,
            "session:session-1",
        )];
        let preview = preview_checkpoint_eviction("session-1", &candidates, 2, 32).unwrap();
        assert!(!preview.ready);
        assert_eq!(preview.required_count, 2);
        assert_eq!(preview.required_bytes, 32);
        assert_eq!(preview.planned.len(), 1);
        assert_eq!(preview.planned[0].byte_length, 8);
        assert_eq!(preview.planned_bytes, 8);
        assert_eq!(
            preview.planned[0].reason,
            CheckpointEvictionReasonV1::Pressure
        );
    }

    #[test]
    fn oversized_owner_event_is_rejected_before_artifact_publication() {
        let root = TempRoot::new();
        let (journal, _) = create_checkpoint(&root.0, capture("baseline"));
        let mut oversized = capture("owner-event-limit");
        oversized.files = (0..MAX_CHECKPOINT_PATHS)
            .map(|index| CheckpointFileV1 {
                path: format!("src/{index:04}-{}", "x".repeat(800)),
                digest: None,
                byte_length: 0,
                executable: false,
                kind: CheckpointFileKindV1::Absent,
                link_count: 0,
            })
            .collect();
        validate_capture(&oversized).unwrap();

        let artifact = ArtifactRefRecordV1 {
            artifact_id: "snapshot-owner-event-limit".to_owned(),
            digest: format!(
                "blake3:{}",
                Digest::from_blake3(b"prospective snapshot").to_hex()
            ),
            byte_length: "16".to_owned(),
            media_type: "application/vnd.horizon.checkpoint+json".to_owned(),
            classification: "workspace".to_owned(),
        };
        let mut projected = journal.state.clone();
        projected.checkpoints.push(CheckpointRecordV1 {
            capture: oversized.clone(),
            artifact,
            created_at_ms: 101,
        });
        assert_eq!(projected.encode(), Err(CheckpointErrorV1::InvalidSnapshot));

        let mut published = false;
        assert_eq!(
            publish_test_capture(&journal.state, &oversized, 16, 101, || {
                published = true;
                Ok(())
            }),
            Err(CheckpointErrorV1::InvalidSnapshot)
        );
        assert!(
            !published,
            "OwnerLog record limits must be checked before immutable artifact publication"
        );
    }

    #[test]
    fn oversized_owner_command_digest_is_rejected_before_artifact_publication() {
        let root = TempRoot::new();
        let (journal, _) = create_checkpoint(&root.0, capture("baseline"));
        let mut candidate = None;

        for padding in 400..=450 {
            let mut capture = capture("owner-command-limit");
            capture.files = (0..MAX_CHECKPOINT_PATHS)
                .map(|index| CheckpointFileV1 {
                    path: format!("src/{index:04}-{}", "x".repeat(padding)),
                    digest: None,
                    byte_length: 0,
                    executable: false,
                    kind: CheckpointFileKindV1::Absent,
                    link_count: 0,
                })
                .collect();
            if validate_capture(&capture).is_err() {
                continue;
            }
            let artifact = ArtifactRefRecordV1 {
                artifact_id: "snapshot-owner-command-limit".to_owned(),
                digest: format!(
                    "blake3:{}",
                    Digest::from_blake3(b"prospective snapshot").to_hex()
                ),
                byte_length: "16".to_owned(),
                media_type: "application/vnd.horizon.checkpoint+json".to_owned(),
                classification: "workspace".to_owned(),
            };
            let mut projected = journal.state.clone();
            projected.checkpoints.push(CheckpointRecordV1 {
                capture: capture.clone(),
                artifact,
                created_at_ms: 101,
            });
            let Ok(encoded) = projected.encode() else {
                continue;
            };
            let event = OwnerEventInput {
                schema_version: OWNER_EVENT_SCHEMA_VERSION_V1,
                time_ms: 101,
                kind: EVENT_KIND.to_owned(),
                data: serde_json::json!({
                    "operation": "checkpoint_captured",
                    "snapshotJson": String::from_utf8(encoded).unwrap(),
                }),
                delivery_id: None,
                command_digest: None,
            };
            if matches!(
                OwnerLogV2::command_digest("checkpoint-2", std::slice::from_ref(&event)),
                Err(OwnerLogError::LimitExceeded("command event bytes"))
            ) {
                candidate = Some(capture);
                break;
            }
        }

        let capture =
            candidate.expect("a sub-1MiB snapshot whose escaped event exceeds the OwnerLog limit");
        let mut published = false;
        assert_eq!(
            publish_test_capture(&journal.state, &capture, 16, 101, || {
                published = true;
                Ok(())
            }),
            Err(CheckpointErrorV1::InvalidSnapshot)
        );
        assert!(
            !published,
            "OwnerLog command-digest limits must be checked before immutable artifact publication"
        );
    }
}

#[cfg(test)]
impl CheckpointJournalV1 {
    fn begin_restore_for_test(
        &mut self,
        preview: &CheckpointRestorePreviewV1,
        observed: &WorkspaceObservationV1,
        effect_id: &str,
        lease_ref: &str,
        now_ms: u64,
    ) -> Result<(), CheckpointErrorV1> {
        let current = self.preview_restore_mode(
            &preview.checkpoint_id,
            observed,
            preview.mode,
            preview.selected_paths.clone(),
        )?;
        if current.preview_digest != preview.preview_digest
            || !current.conflicts.is_empty()
            || (current.workspace_revision_changed
                && current.mode == CheckpointRestoreModeV1::Full)
        {
            return Err(CheckpointErrorV1::StalePreview);
        }
        if !valid_component(effect_id, MAX_CHECKPOINT_ID_BYTES)
            || !valid_component(lease_ref, MAX_RECEIPT_BYTES)
            || self
                .state
                .restore_attempts
                .iter()
                .any(|item| item.effect_id == effect_id)
        {
            return Err(CheckpointErrorV1::InvalidInput);
        }
        let mut next = self.state.clone();
        next.restore_attempts.push(RestoreAttemptV1 {
            effect_id: effect_id.to_owned(),
            checkpoint_id: current.checkpoint_id.clone(),
            preview_digest: current.preview_digest.clone(),
            lease_ref: lease_ref.to_owned(),
            planned_paths: current
                .actions
                .iter()
                .map(|action| action.path.clone())
                .collect(),
            status: RestoreAttemptStatusV1::InProgress,
            path_receipts: Vec::new(),
        });
        self.commit("restore_started_test_fixture", next, now_ms)
    }
}
