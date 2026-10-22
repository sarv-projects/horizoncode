//! Private immutable artifact storage seam. HostKernel currently wires it only
//! for settled verifier-output capture; general artifact effect routes stay
//! unavailable until their Guarded owner path is integrated.

use crate::guard::{
    self, AuthorizationRequestV1, DecisionKind, EffectOriginV1, GuardDecisionV1,
    ResourceResolutionV1,
};
use crate::host_kernel::HostCapturedVerifierOutputV1;
use crate::owner_log::Digest;
use crate::protocol::{ArtifactClassificationV1, ArtifactRefV1};
use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

#[cfg(target_os = "linux")]
use std::os::fd::AsRawFd;

// Leave 1 KiB for the encoded reference, offsets, and chunk-body fields.
const MAX_ARTIFACT_CHUNK_BYTES: usize = crate::protocol::MAX_ARTIFACT_CHUNK_BODY_BYTES - 1024;
const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const DEFAULT_CAPTURE_BYTES: usize = 16 * 1024 * 1024;
const MAX_ARTIFACT_METADATA_BYTES: usize = 128 * 1024;
const DEFAULT_STORE_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
const DEFAULT_STORE_MAX_ARTIFACTS: usize = 4_096;
const LEGACY_ARTIFACT_METADATA_FORMAT: &str = "horizon.artifact-metadata.v1";
const ARTIFACT_METADATA_FORMAT: &str = "horizon.artifact-metadata.v2";
const BLOB_DIRECTORY: &str = "blobs";
const METADATA_DIRECTORY: &str = "metadata";

static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactAccessV1 {
    Public,
    Workspace,
    Sensitive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactEncryptionV1 {
    None,
    StateKey,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactRedactionV1 {
    NotNeeded,
    Applied,
    Unknown,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactFidelityV1 {
    Full,
    HeadTailSample,
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactMetadataV1 {
    pub(crate) artifact_id: String,
    pub(crate) digest: String,
    pub(crate) byte_length: String,
    pub(crate) media_type: String,
    pub(crate) owner_refs: Vec<String>,
    pub(crate) access: ArtifactAccessV1,
    pub(crate) retention_class: String,
    pub(crate) created_at: String,
    pub(crate) fidelity: ArtifactFidelityV1,
    pub(crate) dropped_byte_count: String,
    pub(crate) encryption: ArtifactEncryptionV1,
    pub(crate) redaction: ArtifactRedactionV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactStoreLimitsV1 {
    pub(crate) max_bytes: u64,
    pub(crate) max_artifacts: usize,
}

impl Default for ArtifactStoreLimitsV1 {
    fn default() -> Self {
        Self {
            max_bytes: DEFAULT_STORE_MAX_BYTES,
            max_artifacts: DEFAULT_STORE_MAX_ARTIFACTS,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(crate) struct ArtifactStoreUsageV1 {
    /// Physical bytes across immutable blob files, including orphaned blobs.
    pub(crate) bytes: u64,
    /// Metadata files, including abandoned metadata temporaries after a crash.
    pub(crate) artifacts: usize,
}

impl ArtifactMetadataV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_capture(
        artifact_id: String,
        media_type: String,
        owner_refs: Vec<String>,
        access: ArtifactAccessV1,
        retention_class: String,
        created_at: String,
        encryption: ArtifactEncryptionV1,
        redaction: ArtifactRedactionV1,
        capture: &CapturedArtifactV1,
    ) -> Self {
        Self {
            artifact_id,
            digest: format!("blake3:{}", Digest::from_blake3(&capture.bytes).to_hex()),
            byte_length: capture.bytes.len().to_string(),
            media_type,
            owner_refs,
            access,
            retention_class,
            created_at,
            fidelity: capture.fidelity,
            dropped_byte_count: capture.dropped_byte_count.to_string(),
            encryption,
            redaction,
        }
    }
}

pub(crate) struct CapturedArtifactV1 {
    pub(crate) bytes: Vec<u8>,
    pub(crate) observed_byte_count: u64,
    pub(crate) dropped_byte_count: u64,
    pub(crate) fidelity: ArtifactFidelityV1,
}

/// Bounded stream capture. Small results remain complete; oversized results keep
/// the first and last halves and report the exact number of omitted bytes.
///
/// All retained content lives in one buffer whose capacity is exactly
/// `max_stored_bytes`, so neither `Vec` nor `VecDeque` growth rounding can
/// exceed the configured budget. Before overflow the buffer holds the complete
/// prefix; afterwards it holds the head bytes followed by a ring of the most
/// recent tail bytes at `[head_limit, max_stored_bytes)`.
pub(crate) struct ArtifactCapture {
    max_stored_bytes: usize,
    head_limit: usize,
    tail_limit: usize,
    observed_byte_count: u64,
    buffer: Vec<u8>,
    head_len: usize,
    tail_start: usize,
    tail_len: usize,
    sampling: bool,
}

impl ArtifactCapture {
    pub(crate) fn new(max_stored_bytes: usize) -> Result<Self, ArtifactError> {
        if max_stored_bytes < 2 || max_stored_bytes as u128 > u128::from(MAX_ARTIFACT_BYTES) {
            return Err(ArtifactError::TooLarge);
        }
        let head_limit = max_stored_bytes / 2;
        let tail_limit = max_stored_bytes - head_limit;
        Ok(Self {
            max_stored_bytes,
            head_limit,
            tail_limit,
            observed_byte_count: 0,
            buffer: Vec::with_capacity(max_stored_bytes),
            head_len: 0,
            tail_start: 0,
            tail_len: 0,
            sampling: false,
        })
    }

    pub(crate) fn default_limit() -> usize {
        DEFAULT_CAPTURE_BYTES
    }

    pub(crate) fn push(&mut self, bytes: &[u8]) -> Result<(), ArtifactError> {
        self.observed_byte_count = self
            .observed_byte_count
            .checked_add(u64::try_from(bytes.len()).map_err(|_| ArtifactError::TooLarge)?)
            .ok_or(ArtifactError::TooLarge)?;

        if !self.sampling && self.observed_byte_count <= self.max_stored_bytes as u64 {
            self.buffer.extend_from_slice(bytes);
            return Ok(());
        }

        if !self.sampling {
            self.sampling = true;
            self.head_len = self.head_limit.min(self.buffer.len());
            self.buffer.truncate(self.head_len);
            // The pre-sampling allocation already has exactly `max_stored_bytes`
            // capacity; resizing to the ring layout never reallocates.
            self.buffer.resize(self.max_stored_bytes, 0);
            self.tail_start = 0;
            self.tail_len = 0;
        }

        self.append_sample(bytes);
        Ok(())
    }

    pub(crate) fn retained_byte_count(&self) -> usize {
        if self.sampling {
            self.head_len + self.tail_len
        } else {
            self.buffer.len()
        }
    }

    pub(crate) fn finish(self) -> CapturedArtifactV1 {
        if !self.sampling {
            return CapturedArtifactV1 {
                bytes: self.buffer,
                observed_byte_count: self.observed_byte_count,
                dropped_byte_count: 0,
                fidelity: ArtifactFidelityV1::Full,
            };
        }

        let mut bytes = Vec::with_capacity(self.head_len + self.tail_len);
        bytes.extend_from_slice(&self.buffer[..self.head_len]);
        if self.tail_len > 0 {
            let region = self.head_limit;
            let first = (self.tail_limit - self.tail_start).min(self.tail_len);
            bytes.extend_from_slice(
                &self.buffer[region + self.tail_start..region + self.tail_start + first],
            );
            let second = self.tail_len - first;
            if second > 0 {
                bytes.extend_from_slice(&self.buffer[region..region + second]);
            }
        }
        let dropped_byte_count = self.observed_byte_count.saturating_sub(bytes.len() as u64);
        CapturedArtifactV1 {
            bytes,
            observed_byte_count: self.observed_byte_count,
            dropped_byte_count,
            fidelity: ArtifactFidelityV1::HeadTailSample,
        }
    }

    fn append_sample(&mut self, bytes: &[u8]) {
        let head_bytes = (self.head_limit - self.head_len).min(bytes.len());
        if head_bytes > 0 {
            self.buffer[self.head_len..self.head_len + head_bytes]
                .copy_from_slice(&bytes[..head_bytes]);
            self.head_len += head_bytes;
        }
        self.append_tail(&bytes[head_bytes..]);
    }

    fn append_tail(&mut self, bytes: &[u8]) {
        if bytes.len() >= self.tail_limit {
            let retained = &bytes[bytes.len() - self.tail_limit..];
            self.write_tail(0, retained);
            self.tail_start = 0;
            self.tail_len = self.tail_limit;
            return;
        }

        let total = self.tail_len + bytes.len();
        if total > self.tail_limit {
            // With `bytes.len() < tail_limit` the excess is always smaller than
            // the currently retained tail, so only the oldest bytes are dropped.
            let drop = total - self.tail_limit;
            self.tail_start = (self.tail_start + drop) % self.tail_limit;
            self.tail_len -= drop;
        }

        let write_start = (self.tail_start + self.tail_len) % self.tail_limit;
        self.write_tail(write_start, bytes);
        self.tail_len += bytes.len();
    }

    fn write_tail(&mut self, start: usize, bytes: &[u8]) {
        debug_assert!(start < self.tail_limit);
        debug_assert!(bytes.len() <= self.tail_limit);
        let region = self.head_limit;
        let first = (self.tail_limit - start).min(bytes.len());
        self.buffer[region + start..region + start + first].copy_from_slice(&bytes[..first]);
        if first < bytes.len() {
            self.buffer[region..region + bytes.len() - first].copy_from_slice(&bytes[first..]);
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactError {
    TooLarge,
    LengthMismatch,
    DigestMismatch,
    InvalidMetadata,
    SensitiveEncryptionRequired,
    EncryptionUnavailable,
    AuthorizationDenied,
    InvalidPermit,
    InvalidOffset,
    NotFound,
    Collision,
    MetadataConflict,
    CorruptMetadata,
    CorruptObject,
    GuardDenied {
        reason: &'static str,
    },
    InvalidEffectGrant,
    EffectUnavailable,
    StoreLimitExceeded,
    StoragePermissionsUnavailable,
    DurabilityUnavailable,
    PublicationUncertain,
    PublishedCleanupFailed,
    InvalidVerifierEvidence,
    VerifierCaptureIncomplete {
        published: Vec<VerifierArtifactPublicationV1>,
        failed: VerifierArtifactSlotV1,
        remaining: Vec<VerifierArtifactSlotV1>,
        cause: Box<ArtifactError>,
    },
    Io {
        operation: &'static str,
        kind: std::io::ErrorKind,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifierArtifactSlotV1 {
    pub(crate) criterion_id: String,
    pub(crate) stream: &'static str,
    pub(crate) artifact_id: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct VerifierArtifactPublicationV1 {
    pub(crate) slot: VerifierArtifactSlotV1,
    pub(crate) artifact_ref: ArtifactRefV1,
}

impl fmt::Display for ArtifactError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "artifact store error: {self:?}")
    }
}

impl Error for ArtifactError {}

pub(crate) struct ReadPermit {
    artifact_ref: ArtifactRefV1,
    store_scope: Option<Arc<()>>,
    state: Mutex<PermitState>,
}

struct PermitState {
    next_offset: u64,
    verified_snapshot: Option<File>,
}

impl ReadPermit {
    pub(crate) fn new(artifact_ref: ArtifactRefV1) -> Self {
        Self {
            artifact_ref,
            store_scope: None,
            state: Mutex::new(PermitState {
                next_offset: 0,
                verified_snapshot: None,
            }),
        }
    }

    /// Next sequential offset this permit will accept.
    pub(crate) fn next_offset(&self) -> u64 {
        self.state
            .lock()
            .map(|state| state.next_offset)
            .unwrap_or(0)
    }
}

pub(crate) trait ArtifactAuthorizer {
    fn authorize_read(
        &self,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
    ) -> Result<ReadPermit, ArtifactError>;
}

pub(crate) struct ArtifactChunkV1 {
    pub(crate) artifact_ref: ArtifactRefV1,
    pub(crate) offset: u64,
    pub(crate) next_offset: u64,
    pub(crate) bytes: Vec<u8>,
    pub(crate) complete: bool,
}

pub(crate) struct ArtifactStore<A> {
    root: std::path::PathBuf,
    root_directory: File,
    authorizer: A,
    scope: Arc<()>,
    limits: ArtifactStoreLimitsV1,
}

impl<A: ArtifactAuthorizer> ArtifactStore<A> {
    pub(crate) fn open(root: &Path, authorizer: A) -> Result<Self, ArtifactError> {
        Self::open_with_limits(root, authorizer, ArtifactStoreLimitsV1::default())
    }

    pub(crate) fn open_with_limits(
        root: &Path,
        authorizer: A,
        limits: ArtifactStoreLimitsV1,
    ) -> Result<Self, ArtifactError> {
        if !cfg!(target_os = "linux") {
            return Err(ArtifactError::StoragePermissionsUnavailable);
        }
        if limits.max_bytes == 0 || limits.max_bytes > u64::MAX / 2 || limits.max_artifacts == 0 {
            return Err(ArtifactError::InvalidMetadata);
        }
        ensure_directory_tree(root, true)?;
        ensure_private_directory(&root.join(BLOB_DIRECTORY))?;
        ensure_private_directory(&root.join(METADATA_DIRECTORY))?;
        let root_directory = open_private_root(root)?;
        let store = Self {
            root: root.to_path_buf(),
            root_directory,
            authorizer,
            scope: Arc::new(()),
            limits,
        };
        let _lock = store.admission_lock()?;
        let usage = scan_store_usage(&store.root, &store.root_directory)?;
        if usage.bytes > limits.max_bytes || usage.artifacts > limits.max_artifacts {
            return Err(ArtifactError::StoreLimitExceeded);
        }
        Ok(store)
    }

    pub(crate) fn usage(&self) -> Result<ArtifactStoreUsageV1, ArtifactError> {
        let _lock = self.admission_lock()?;
        scan_store_usage(&self.root, &self.root_directory)
    }

    /// Resolves metadata for a HostKernel-derived immutable artifact ID without
    /// granting read access to arbitrary caller-selected references. Callers must
    /// still compare the returned reference and owner metadata with their trusted
    /// effect receipt before exposing it.
    pub(crate) fn reference_for_host_id(
        &self,
        artifact_id: &str,
    ) -> Result<(ArtifactRefV1, ArtifactMetadataV1), ArtifactError> {
        if !valid_text(artifact_id) || artifact_id.len() > 256 {
            return Err(ArtifactError::InvalidMetadata);
        }
        let bytes = read_private_file(
            &self.root_directory,
            &metadata_relative_path(artifact_id),
            MAX_ARTIFACT_METADATA_BYTES,
            true,
        )?;
        let metadata = decode_metadata(&bytes)?;
        if metadata.artifact_id != artifact_id {
            return Err(ArtifactError::CorruptMetadata);
        }
        let reference = metadata_reference(&metadata)
            .map_err(|_| ArtifactError::CorruptMetadata)?;
        Ok((reference, metadata))
    }

    /// Persists host-generated, bounded verifier manifests after independently
    /// authorized verifier effects settled. Raw child output is validated against
    /// its observed digest and byte count, but is never stored or user-visible.
    /// The opaque, non-cloneable token is consumed by value; no caller can supply
    /// artifact bytes, digests, owners, or refs. Every criterion is validated
    /// before the first store mutation.
    pub(crate) fn capture_host_verifier_output(
        &self,
        output: HostCapturedVerifierOutputV1,
    ) -> Result<BTreeMap<String, Vec<ArtifactRefV1>>, ArtifactError> {
        validate_host_verifier_output(&output)?;

        let created_at = timestamp_from_unix_millis(output.captured_at_ms())?;
        let owner_ref = output.owner_scope().owner_ref();
        let mut slots = Vec::with_capacity(output.criteria().len());
        for criterion in output.criteria() {
            let criterion_id = criterion.criterion_id();
            let manifest = criterion.manifest();
            slots.push(VerifierArtifactSlotV1 {
                criterion_id: criterion_id.to_owned(),
                stream: "manifest",
                artifact_id: verifier_artifact_id(
                    output.verification_run_id(),
                    output.profile_id(),
                    criterion_id,
                    "manifest",
                    criterion.effect_id(),
                    criterion.challenge_id(),
                    criterion.capability_lease_digest(),
                    criterion.receipt_digest(),
                    manifest.bytes(),
                ),
            });
        }

        let mut references = BTreeMap::new();
        let mut published = Vec::with_capacity(slots.len());
        let mut artifact_index = 0;
        for criterion in output.criteria() {
            let criterion_id = criterion.criterion_id().to_owned();
            let manifest = criterion.manifest();
            let slot = slots[artifact_index].clone();
            artifact_index += 1;
            let mut capture = ArtifactCapture::new(manifest.bytes().len().max(2))?;
            capture.push(manifest.bytes())?;
            let reference = match self.put_capture(
                slot.artifact_id.clone(),
                "application/json".to_owned(),
                vec![owner_ref.clone()],
                ArtifactAccessV1::Workspace,
                "verification".to_owned(),
                created_at.clone(),
                ArtifactEncryptionV1::None,
                manifest.redaction(),
                capture.finish(),
            ) {
                Ok(reference) => reference,
                Err(cause) => {
                    return Err(ArtifactError::VerifierCaptureIncomplete {
                        published,
                        failed: slot,
                        remaining: slots[artifact_index..].to_vec(),
                        cause: Box::new(cause),
                    });
                }
            };
            published.push(VerifierArtifactPublicationV1 {
                slot,
                artifact_ref: reference.clone(),
            });
            references.insert(criterion_id, vec![reference]);
        }
        Ok(references)
    }

    fn admission_lock(&self) -> Result<ArtifactStoreLock, ArtifactError> {
        let path = self.root.join(".artifact-store.lock");
        let mut options = private_open_options();
        #[cfg(target_os = "linux")]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
        }
        let file = options
            .read(true)
            .write(true)
            .create(true)
            .open(&path)
            .map_err(|error| io_error("open artifact admission lock", error))?;
        let metadata = file
            .metadata()
            .map_err(|error| io_error("inspect artifact admission lock", error))?;
        validate_private_file(&metadata, false)?;
        lock_artifact_store(&file)?;
        Ok(ArtifactStoreLock(file))
    }

    pub(crate) fn put(
        &self,
        bytes: &[u8],
        metadata: ArtifactMetadataV1,
    ) -> Result<ArtifactRefV1, ArtifactError> {
        let artifact_ref = validate_metadata(bytes, &metadata)?;
        ensure_private_directory(&self.root)?;
        ensure_private_directory(&self.root.join(BLOB_DIRECTORY))?;
        ensure_private_directory(&self.root.join(METADATA_DIRECTORY))?;
        let metadata_bytes = encode_metadata(&metadata)?;
        let metadata_path = metadata_path(&self.root, &metadata.artifact_id);
        ensure_private_directory(
            metadata_path
                .parent()
                .ok_or(ArtifactError::InvalidMetadata)?,
        )?;
        let _lock = self.admission_lock()?;
        let existing_metadata = existing_file_matches(&metadata_path, &metadata_bytes)?;
        if existing_metadata == Some(false) {
            return Err(ArtifactError::MetadataConflict);
        }

        let blob_path = blob_path(&self.root, &metadata.digest)?;
        ensure_private_directory(blob_path.parent().ok_or(ArtifactError::InvalidMetadata)?)?;
        let current = scan_store_usage(&self.root, &self.root_directory)?;
        let blob_exists = existing_file_matches(&blob_path, bytes)?.is_some();
        let next_bytes = current
            .bytes
            .checked_add(if blob_exists { 0 } else { bytes.len() as u64 })
            .ok_or(ArtifactError::StoreLimitExceeded)?;
        let next_artifacts = current
            .artifacts
            .checked_add(usize::from(existing_metadata.is_none()))
            .ok_or(ArtifactError::StoreLimitExceeded)?;
        if next_bytes > self.limits.max_bytes || next_artifacts > self.limits.max_artifacts {
            return Err(ArtifactError::StoreLimitExceeded);
        }
        publish_no_clobber(
            blob_path.parent().ok_or(ArtifactError::InvalidMetadata)?,
            &blob_path,
            bytes,
            ArtifactError::Collision,
        )?;

        publish_no_clobber(
            metadata_path
                .parent()
                .ok_or(ArtifactError::InvalidMetadata)?,
            &metadata_path,
            &metadata_bytes,
            ArtifactError::MetadataConflict,
        )?;
        Ok(artifact_ref)
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn put_capture(
        &self,
        artifact_id: String,
        media_type: String,
        owner_refs: Vec<String>,
        access: ArtifactAccessV1,
        retention_class: String,
        created_at: String,
        encryption: ArtifactEncryptionV1,
        redaction: ArtifactRedactionV1,
        capture: CapturedArtifactV1,
    ) -> Result<ArtifactRefV1, ArtifactError> {
        let metadata = ArtifactMetadataV1::from_capture(
            artifact_id,
            media_type,
            owner_refs,
            access,
            retention_class,
            created_at,
            encryption,
            redaction,
            &capture,
        );
        self.put(&capture.bytes, metadata)
    }

    pub(crate) fn authorize_read(
        &self,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
    ) -> Result<ReadPermit, ArtifactError> {
        validate_reference(artifact_ref)?;
        let mut permit = self.authorizer.authorize_read(principal, artifact_ref)?;
        if permit.artifact_ref != *artifact_ref || permit.store_scope.is_some() {
            return Err(ArtifactError::InvalidPermit);
        }
        permit.store_scope = Some(Arc::clone(&self.scope));
        Ok(permit)
    }

    pub(crate) fn metadata(
        &self,
        permit: &ReadPermit,
    ) -> Result<ArtifactMetadataV1, ArtifactError> {
        self.validate_permit(permit)?;
        let path = metadata_relative_path(&permit.artifact_ref.artifact_id);
        let bytes = read_private_file(
            &self.root_directory,
            &path,
            MAX_ARTIFACT_METADATA_BYTES,
            true,
        )
        .map_err(|error| {
            if error == ArtifactError::CorruptObject {
                ArtifactError::CorruptMetadata
            } else {
                error
            }
        })?;
        let metadata = decode_metadata(&bytes)?;
        let validated_ref =
            metadata_reference(&metadata).map_err(|_| ArtifactError::CorruptMetadata)?;
        if validated_ref != permit.artifact_ref {
            return Err(ArtifactError::CorruptMetadata);
        }
        Ok(metadata)
    }

    pub(crate) fn read(
        &self,
        permit: &ReadPermit,
        offset: u64,
        max_bytes: NonZeroUsize,
    ) -> Result<ArtifactChunkV1, ArtifactError> {
        self.validate_permit(permit)?;
        let mut state = permit
            .state
            .lock()
            .map_err(|_| ArtifactError::InvalidPermit)?;
        if offset != state.next_offset {
            return Err(ArtifactError::InvalidOffset);
        }
        let metadata = self.metadata(permit)?;
        let total_length =
            parse_decimal(&metadata.byte_length).map_err(|_| ArtifactError::CorruptMetadata)?;
        if offset > total_length {
            return Err(ArtifactError::InvalidOffset);
        }

        let path = blob_relative_path(&metadata.digest)?;
        if state.verified_snapshot.is_none() {
            state.verified_snapshot = Some(open_private_object(
                &self.root_directory,
                &path,
                total_length,
                &metadata.digest,
            )?);
        }
        let file = state
            .verified_snapshot
            .as_mut()
            .ok_or(ArtifactError::InvalidPermit)?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| io_error("seek artifact object", error))?;
        let requested = max_bytes.get().min(MAX_ARTIFACT_CHUNK_BYTES);
        let bytes_to_read = (total_length - offset).min(requested as u64) as usize;
        let mut bytes = vec![0; bytes_to_read];
        if let Err(error) = file.read_exact(&mut bytes) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(ArtifactError::CorruptObject)
            } else {
                Err(io_error("read artifact object", error))
            };
        }
        let next_offset = offset + bytes_to_read as u64;
        state.next_offset = next_offset;
        Ok(ArtifactChunkV1 {
            artifact_ref: permit.artifact_ref.clone(),
            offset,
            next_offset,
            complete: next_offset == total_length,
            bytes,
        })
    }

    /// Read one independently authorized range. Unlike `read`, this does not
    /// rely on mutable per-permit cursor state: HTTP callers may issue each
    /// bounded range as a separate RPC, and every RPC receives a fresh permit.
    /// The exact permit, metadata/ref equality, no-follow object open and full
    /// object digest verification are repeated for every range.
    fn read_at(
        &self,
        permit: &ReadPermit,
        offset: u64,
        max_bytes: NonZeroUsize,
    ) -> Result<ArtifactChunkV1, ArtifactError> {
        self.validate_permit(permit)?;
        let metadata = self.metadata(permit)?;
        let total_length =
            parse_decimal(&metadata.byte_length).map_err(|_| ArtifactError::CorruptMetadata)?;
        if offset > total_length {
            return Err(ArtifactError::InvalidOffset);
        }
        let path = blob_relative_path(&metadata.digest)?;
        let mut file = open_private_object(
            &self.root_directory,
            &path,
            total_length,
            &metadata.digest,
        )?;
        file.seek(SeekFrom::Start(offset))
            .map_err(|error| io_error("seek artifact object", error))?;
        let requested = max_bytes.get().min(MAX_ARTIFACT_CHUNK_BYTES);
        let bytes_to_read = (total_length - offset).min(requested as u64) as usize;
        let mut bytes = vec![0; bytes_to_read];
        if let Err(error) = file.read_exact(&mut bytes) {
            return if error.kind() == io::ErrorKind::UnexpectedEof {
                Err(ArtifactError::CorruptObject)
            } else {
                Err(io_error("read artifact object", error))
            };
        }
        let next_offset = offset + bytes_to_read as u64;
        Ok(ArtifactChunkV1 {
            artifact_ref: permit.artifact_ref.clone(),
            offset,
            next_offset,
            complete: next_offset == total_length,
            bytes,
        })
    }

    fn validate_permit(&self, permit: &ReadPermit) -> Result<(), ArtifactError> {
        let Some(scope) = &permit.store_scope else {
            return Err(ArtifactError::InvalidPermit);
        };
        if !Arc::ptr_eq(scope, &self.scope) {
            return Err(ArtifactError::InvalidPermit);
        }
        validate_reference(&permit.artifact_ref)
    }
}

struct ArtifactStoreLock(File);

#[cfg(target_os = "linux")]
fn lock_artifact_store(file: &File) -> Result<(), ArtifactError> {
    // SAFETY: `file` is a live descriptor for the private lock file. `flock` only
    // changes the descriptor's advisory lock, which remains held until close.
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX) } == 0 {
        Ok(())
    } else {
        Err(io_error(
            "lock artifact store admission",
            io::Error::last_os_error(),
        ))
    }
}

#[cfg(not(target_os = "linux"))]
fn lock_artifact_store(_file: &File) -> Result<(), ArtifactError> {
    Err(ArtifactError::StoragePermissionsUnavailable)
}

fn scan_store_usage(
    root: &Path,
    root_directory: &File,
) -> Result<ArtifactStoreUsageV1, ArtifactError> {
    let mut usage = ArtifactStoreUsageV1::default();
    scan_blob_tree(&root.join(BLOB_DIRECTORY), &mut usage)?;
    scan_metadata_tree(
        root,
        root_directory,
        &root.join(METADATA_DIRECTORY),
        &mut usage,
    )?;
    Ok(usage)
}

fn scan_blob_tree(path: &Path, usage: &mut ArtifactStoreUsageV1) -> Result<(), ArtifactError> {
    let entries = fs::read_dir(path).map_err(|error| io_error("scan artifact blobs", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_error("read artifact blob entry", error))?;
        let metadata = fs::symlink_metadata(entry.path())
            .map_err(|error| io_error("inspect artifact blob entry", error))?;
        if metadata.file_type().is_symlink() {
            return Err(ArtifactError::CorruptObject);
        }
        if metadata.file_type().is_dir() {
            validate_private_directory(&metadata)?;
            scan_blob_tree(&entry.path(), usage)?;
            continue;
        }
        validate_private_file(&metadata, true)?;
        usage.bytes = usage
            .bytes
            .checked_add(metadata.len())
            .ok_or(ArtifactError::StoreLimitExceeded)?;
    }
    Ok(())
}

fn scan_metadata_tree(
    root: &Path,
    root_directory: &File,
    path: &Path,
    usage: &mut ArtifactStoreUsageV1,
) -> Result<(), ArtifactError> {
    let entries = fs::read_dir(path).map_err(|error| io_error("scan artifact metadata", error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_error("read artifact metadata entry", error))?;
        let entry_path = entry.path();
        let metadata = fs::symlink_metadata(&entry_path)
            .map_err(|error| io_error("inspect artifact metadata entry", error))?;
        if metadata.file_type().is_symlink() {
            return Err(ArtifactError::CorruptMetadata);
        }
        if metadata.file_type().is_dir() {
            validate_private_directory(&metadata)?;
            scan_metadata_tree(root, root_directory, &entry_path, usage)?;
            continue;
        }
        validate_private_file(&metadata, true)?;
        usage.artifacts = usage
            .artifacts
            .checked_add(1)
            .ok_or(ArtifactError::StoreLimitExceeded)?;
        let relative = entry_path
            .strip_prefix(root)
            .map_err(|_| ArtifactError::CorruptMetadata)?;
        let bytes = read_private_file(root_directory, relative, MAX_ARTIFACT_METADATA_BYTES, true)?;
        let decoded = decode_metadata(&bytes)?;
        if metadata_path(root, &decoded.artifact_id) != entry_path {
            return Err(ArtifactError::CorruptMetadata);
        }
        let reference = metadata_reference(&decoded).map_err(|_| ArtifactError::CorruptMetadata)?;
        let blob_relative =
            blob_relative_path(&reference.digest).map_err(|_| ArtifactError::CorruptMetadata)?;
        let blob = open_private_file_at(root_directory, &blob_relative, true)
            .map_err(|_| ArtifactError::CorruptObject)?;
        if blob
            .metadata()
            .map_err(|error| io_error("inspect artifact blob", error))?
            .len()
            != reference
                .byte_length
                .parse::<u64>()
                .map_err(|_| ArtifactError::CorruptMetadata)?
        {
            return Err(ArtifactError::CorruptObject);
        }
    }
    Ok(())
}

fn io_error(operation: &'static str, error: io::Error) -> ArtifactError {
    ArtifactError::Io {
        operation,
        kind: error.kind(),
    }
}

fn ensure_directory_tree(path: &Path, private: bool) -> Result<(), ArtifactError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        && parent != path
    {
        ensure_directory_tree(parent, false)?;
    }
    ensure_directory(path, private)
}

fn ensure_directory(path: &Path, private: bool) -> Result<(), ArtifactError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            if private {
                validate_private_directory(&metadata)?;
            }
            return Ok(());
        }
        Ok(_) => return Err(ArtifactError::StoragePermissionsUnavailable),
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect artifact directory", error)),
    }
    match create_directory(path, private) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return ensure_directory(path, private);
        }
        Err(error) => return Err(io_error("create artifact directory", error)),
    }
    let parent = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    sync_directory(parent).map_err(|_| ArtifactError::DurabilityUnavailable)?;
    sync_directory(path).map_err(|_| ArtifactError::DurabilityUnavailable)
}

fn ensure_private_directory(path: &Path) -> Result<(), ArtifactError> {
    ensure_directory(path, true)
}

fn create_directory(path: &Path, private: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;

        let mut builder = fs::DirBuilder::new();
        builder.mode(if private { 0o700 } else { 0o755 });
        builder.create(path)
    }
    #[cfg(not(unix))]
    {
        let _ = private;
        fs::create_dir(path)
    }
}

fn validate_private_directory(metadata: &fs::Metadata) -> Result<(), ArtifactError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        if metadata.permissions().mode() & 0o077 == 0 {
            Ok(())
        } else {
            Err(ArtifactError::StoragePermissionsUnavailable)
        }
    }
    #[cfg(not(unix))]
    {
        let _ = metadata;
        Err(ArtifactError::StoragePermissionsUnavailable)
    }
}

fn validate_private_file(metadata: &fs::Metadata, read_only: bool) -> Result<(), ArtifactError> {
    if !metadata.file_type().is_file() {
        return Err(ArtifactError::CorruptObject);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let mode = metadata.permissions().mode();
        if mode & 0o077 != 0 || (read_only && mode & 0o222 != 0) {
            return Err(ArtifactError::StoragePermissionsUnavailable);
        }
        Ok(())
    }
    #[cfg(not(unix))]
    {
        let _ = read_only;
        Err(ArtifactError::StoragePermissionsUnavailable)
    }
}

#[cfg(target_os = "linux")]
fn open_at(
    directory: &File,
    name: &std::ffi::OsStr,
    flags: libc::c_int,
) -> Result<File, ArtifactError> {
    use std::os::fd::{AsRawFd, FromRawFd};
    use std::os::unix::ffi::OsStrExt;

    let name =
        std::ffi::CString::new(name.as_bytes()).map_err(|_| ArtifactError::InvalidMetadata)?;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), flags) };
    if fd < 0 {
        let error = io::Error::last_os_error();
        return match error.raw_os_error() {
            Some(libc::ELOOP | libc::ENOTDIR) => Err(ArtifactError::CorruptObject),
            Some(libc::ENOENT) => Err(ArtifactError::NotFound),
            _ => Err(io_error("open artifact handle-relative path", error)),
        };
    }
    Ok(unsafe { File::from_raw_fd(fd) })
}

#[cfg(target_os = "linux")]
fn open_directory_at(
    directory: &File,
    name: &std::ffi::OsStr,
    private: bool,
) -> Result<File, ArtifactError> {
    let opened = open_at(
        directory,
        name,
        libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
    )?;
    let metadata = opened
        .metadata()
        .map_err(|error| io_error("inspect opened artifact directory", error))?;
    if !metadata.file_type().is_dir() {
        return Err(ArtifactError::CorruptObject);
    }
    if private {
        validate_private_directory(&metadata)?;
    }
    Ok(opened)
}

#[cfg(target_os = "linux")]
fn open_private_root(root: &Path) -> Result<File, ArtifactError> {
    use std::path::Component;

    let mut directory = File::open(if root.is_absolute() { "/" } else { "." })
        .map_err(|error| io_error("open artifact root anchor", error))?;
    for component in root.components() {
        match component {
            Component::RootDir | Component::CurDir => {}
            Component::Normal(name) => {
                directory = open_directory_at(&directory, name, false)?;
            }
            Component::ParentDir => {
                directory = open_directory_at(&directory, std::ffi::OsStr::new(".."), false)?;
            }
            Component::Prefix(_) => return Err(ArtifactError::StoragePermissionsUnavailable),
        }
    }
    let metadata = directory
        .metadata()
        .map_err(|error| io_error("inspect artifact root handle", error))?;
    validate_private_directory(&metadata)?;
    Ok(directory)
}

#[cfg(not(target_os = "linux"))]
fn open_private_root(_root: &Path) -> Result<File, ArtifactError> {
    Err(ArtifactError::StoragePermissionsUnavailable)
}

#[cfg(target_os = "linux")]
fn open_private_file_at(
    root: &File,
    relative: &Path,
    read_only: bool,
) -> Result<File, ArtifactError> {
    use std::path::Component;

    let components = relative
        .components()
        .map(|component| match component {
            Component::Normal(name) => Ok(name.to_os_string()),
            _ => Err(ArtifactError::InvalidMetadata),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (name, directories) = components
        .split_last()
        .ok_or(ArtifactError::InvalidMetadata)?;

    let mut directory = root
        .try_clone()
        .map_err(|error| io_error("clone artifact root handle", error))?;
    for component in directories {
        directory = open_directory_at(&directory, component, true)?;
    }
    let opened = open_at(
        &directory,
        name,
        libc::O_RDONLY | libc::O_CLOEXEC | libc::O_NOFOLLOW | libc::O_NONBLOCK,
    )?;
    let metadata = opened
        .metadata()
        .map_err(|error| io_error("inspect opened artifact file", error))?;
    validate_private_file(&metadata, read_only)?;
    Ok(opened)
}

#[cfg(not(target_os = "linux"))]
fn open_private_file_at(
    _root: &File,
    _relative: &Path,
    _read_only: bool,
) -> Result<File, ArtifactError> {
    Err(ArtifactError::StoragePermissionsUnavailable)
}

fn sync_directory(path: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(path)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Err(io::Error::new(
            io::ErrorKind::Unsupported,
            "directory synchronization is unavailable",
        ))
    }
}

fn private_open_options() -> OpenOptions {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;

        let mut options = OpenOptions::new();
        options.mode(0o600);
        options
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
    }
}

fn blob_path(root: &Path, digest: &str) -> Result<PathBuf, ArtifactError> {
    Ok(root.join(blob_relative_path(digest)?))
}

fn blob_relative_path(digest: &str) -> Result<PathBuf, ArtifactError> {
    let Some(hex) = digest.strip_prefix("blake3:") else {
        return Err(ArtifactError::InvalidMetadata);
    };
    Digest::parse_hex(hex).map_err(|_| ArtifactError::InvalidMetadata)?;
    Ok(Path::new(BLOB_DIRECTORY).join(&hex[..2]).join(&hex[2..]))
}

fn metadata_path(root: &Path, artifact_id: &str) -> PathBuf {
    root.join(metadata_relative_path(artifact_id))
}

fn metadata_relative_path(artifact_id: &str) -> PathBuf {
    let key = blake3::hash(artifact_id.as_bytes()).to_hex().to_string();
    Path::new(METADATA_DIRECTORY)
        .join(&key[..2])
        .join(format!("{}.json", &key[2..]))
}

struct TemporaryPath(PathBuf);

impl TemporaryPath {
    fn remove(mut self) -> Result<(), ArtifactError> {
        fs::remove_file(&self.0)
            .map_err(|error| io_error("remove artifact temporary file", error))?;
        self.0.clear();
        Ok(())
    }
}

impl Drop for TemporaryPath {
    fn drop(&mut self) {
        if !self.0.as_os_str().is_empty() {
            let _ = fs::remove_file(&self.0);
        }
    }
}

fn publish_no_clobber(
    directory: &Path,
    destination: &Path,
    bytes: &[u8],
    collision_error: ArtifactError,
) -> Result<(), ArtifactError> {
    publish_no_clobber_with(
        directory,
        destination,
        bytes,
        collision_error,
        sync_directory,
        |source, target| fs::hard_link(source, target),
    )
}

fn publish_no_clobber_with<S, H>(
    directory: &Path,
    destination: &Path,
    bytes: &[u8],
    collision_error: ArtifactError,
    sync_directory_fn: S,
    hard_link_fn: H,
) -> Result<(), ArtifactError>
where
    S: Fn(&Path) -> io::Result<()>,
    H: Fn(&Path, &Path) -> io::Result<()>,
{
    if let Some(matches) = existing_file_matches(destination, bytes)? {
        return if matches {
            sync_existing_file_and_directory(destination, directory, &sync_directory_fn)
        } else {
            Err(collision_error)
        };
    }

    let (temporary_path, mut temporary_file) = create_temporary_file(directory)?;
    let temporary = TemporaryPath(temporary_path.clone());
    temporary_file
        .write_all(bytes)
        .map_err(|error| io_error("write artifact temporary file", error))?;
    temporary_file
        .sync_all()
        .map_err(|_| ArtifactError::DurabilityUnavailable)?;
    set_read_only(&temporary_file)?;
    temporary_file
        .sync_all()
        .map_err(|_| ArtifactError::DurabilityUnavailable)?;
    drop(temporary_file);

    match hard_link_fn(&temporary_path, destination) {
        Ok(()) => {
            sync_directory_fn(directory).map_err(|_| ArtifactError::PublicationUncertain)?;
            temporary
                .remove()
                .map_err(|_| ArtifactError::PublishedCleanupFailed)?;
            sync_directory_fn(directory).map_err(|_| ArtifactError::PublishedCleanupFailed)
        }
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            let matches = existing_file_matches(destination, bytes)?
                .ok_or(ArtifactError::PublicationUncertain)?;
            if matches {
                sync_existing_file_and_directory(destination, directory, &sync_directory_fn)?;
            }
            if matches {
                temporary
                    .remove()
                    .map_err(|_| ArtifactError::PublishedCleanupFailed)?;
                sync_directory_fn(directory).map_err(|_| ArtifactError::PublishedCleanupFailed)
            } else {
                temporary.remove()?;
                Err(collision_error)
            }
        }
        Err(error) => Err(io_error("publish immutable artifact", error)),
    }
}

fn sync_existing_file_and_directory<S>(
    path: &Path,
    directory: &Path,
    sync_directory_fn: &S,
) -> Result<(), ArtifactError>
where
    S: Fn(&Path) -> io::Result<()>,
{
    File::open(path)
        .and_then(|file| file.sync_all())
        .map_err(|_| ArtifactError::PublicationUncertain)?;
    sync_directory_fn(directory).map_err(|_| ArtifactError::PublicationUncertain)
}

fn create_temporary_file(directory: &Path) -> Result<(PathBuf, File), ArtifactError> {
    for _ in 0..32 {
        let id = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(".artifact-{}-{id}.tmp", std::process::id()));
        let mut options = private_open_options();
        match options.write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error("create artifact temporary file", error)),
        }
    }
    Err(ArtifactError::Io {
        operation: "allocate unique artifact temporary file",
        kind: io::ErrorKind::AlreadyExists,
    })
}

fn set_read_only(file: &File) -> Result<(), ArtifactError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        file.set_permissions(fs::Permissions::from_mode(0o400))
            .map_err(|error| io_error("make artifact immutable", error))
    }
    #[cfg(not(unix))]
    {
        let _ = file;
        Err(ArtifactError::StoragePermissionsUnavailable)
    }
}

fn existing_file_matches(path: &Path, expected: &[u8]) -> Result<Option<bool>, ArtifactError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error("inspect existing artifact", error)),
    };
    validate_private_file(&metadata, true)?;
    if metadata.len() != expected.len() as u64 {
        return Ok(Some(false));
    }
    let mut file = File::open(path).map_err(|error| io_error("open existing artifact", error))?;
    let mut offset = 0usize;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| io_error("read existing artifact", error))?;
        if count == 0 {
            return Ok(Some(offset == expected.len()));
        }
        let end = offset.saturating_add(count);
        if end > expected.len() || buffer[..count] != expected[offset..end] {
            return Ok(Some(false));
        }
        offset = end;
    }
}

fn read_private_file(
    root: &File,
    relative: &Path,
    limit: usize,
    read_only: bool,
) -> Result<Vec<u8>, ArtifactError> {
    let file = open_private_file_at(root, relative, read_only)?;
    let metadata = file
        .metadata()
        .map_err(|error| io_error("inspect opened artifact file", error))?;
    if metadata.len() > limit as u64 {
        return Err(ArtifactError::CorruptMetadata);
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("read artifact file", error))?;
    if bytes.len() > limit {
        return Err(ArtifactError::CorruptMetadata);
    }
    Ok(bytes)
}

#[cfg(target_os = "linux")]
fn open_private_object(
    root: &File,
    relative: &Path,
    expected_length: u64,
    expected_digest: &str,
) -> Result<File, ArtifactError> {
    let mut source = open_private_file_at(root, relative, true)?;
    if source
        .metadata()
        .map_err(|error| io_error("inspect opened artifact object", error))?
        .len()
        != expected_length
    {
        return Err(ArtifactError::CorruptObject);
    }
    let Some(hex) = expected_digest.strip_prefix("blake3:") else {
        return Err(ArtifactError::CorruptMetadata);
    };
    let expected = Digest::parse_hex(hex).map_err(|_| ArtifactError::CorruptMetadata)?;

    let mut snapshot = {
        use std::os::fd::FromRawFd;

        let name = std::ffi::CString::new("horizon-artifact-snapshot")
            .map_err(|_| ArtifactError::StoragePermissionsUnavailable)?;
        let fd = unsafe {
            libc::memfd_create(name.as_ptr(), libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING)
        };
        if fd < 0 {
            return Err(io_error(
                "create immutable artifact snapshot",
                io::Error::last_os_error(),
            ));
        }
        unsafe { File::from_raw_fd(fd) }
    };
    let mut hasher = blake3::Hasher::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let remaining_with_probe = expected_length.saturating_sub(total).saturating_add(1);
        let read_limit = usize::try_from(remaining_with_probe.min(buffer.len() as u64))
            .map_err(|_| ArtifactError::CorruptObject)?;
        let count = source
            .read(&mut buffer[..read_limit])
            .map_err(|error| io_error("read artifact object for verification", error))?;
        if count == 0 {
            break;
        }
        if count as u64 > expected_length.saturating_sub(total) {
            return Err(ArtifactError::CorruptObject);
        }
        snapshot
            .write_all(&buffer[..count])
            .map_err(|error| io_error("write verified artifact snapshot", error))?;
        total = total
            .checked_add(count as u64)
            .ok_or(ArtifactError::CorruptObject)?;
        hasher.update(&buffer[..count]);
    }
    if total != expected_length || Digest::from_bytes(*hasher.finalize().as_bytes()) != expected {
        return Err(ArtifactError::CorruptObject);
    }

    {
        use std::os::fd::AsRawFd;

        let seals =
            libc::F_SEAL_WRITE | libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL;
        if unsafe { libc::fcntl(snapshot.as_raw_fd(), libc::F_ADD_SEALS, seals) } < 0 {
            return Err(io_error(
                "seal verified artifact snapshot",
                io::Error::last_os_error(),
            ));
        }
    }
    snapshot
        .seek(SeekFrom::Start(0))
        .map_err(|error| io_error("rewind verified artifact snapshot", error))?;
    Ok(snapshot)
}

#[cfg(not(target_os = "linux"))]
fn open_private_object(
    _root: &File,
    _relative: &Path,
    _expected_length: u64,
    _expected_digest: &str,
) -> Result<File, ArtifactError> {
    Err(ArtifactError::StoragePermissionsUnavailable)
}

fn validate_metadata(
    bytes: &[u8],
    metadata: &ArtifactMetadataV1,
) -> Result<ArtifactRefV1, ArtifactError> {
    let artifact_ref = metadata_reference(metadata)?;
    let declared_length = parse_decimal(&metadata.byte_length)?;
    if declared_length > MAX_ARTIFACT_BYTES {
        return Err(ArtifactError::TooLarge);
    }
    if declared_length != u64::try_from(bytes.len()).map_err(|_| ArtifactError::LengthMismatch)? {
        return Err(ArtifactError::LengthMismatch);
    }
    let Some(hex_digest) = metadata.digest.strip_prefix("blake3:") else {
        return Err(ArtifactError::InvalidMetadata);
    };
    let declared_digest =
        Digest::parse_hex(hex_digest).map_err(|_| ArtifactError::InvalidMetadata)?;
    if declared_digest != Digest::from_blake3(bytes) {
        return Err(ArtifactError::DigestMismatch);
    }
    Ok(artifact_ref)
}

fn valid_verifier_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= crate::protocol::MAX_IDENTIFIER_BYTES
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_verifier_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("blake3:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[allow(clippy::too_many_arguments)]
fn verifier_artifact_id(
    verification_run_id: &str,
    profile_id: &str,
    criterion_id: &str,
    stream_name: &str,
    effect_id: &str,
    challenge_id: &str,
    lease_digest: &str,
    receipt_digest: &str,
    bytes: &[u8],
) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in [
        verification_run_id,
        profile_id,
        criterion_id,
        stream_name,
        effect_id,
        challenge_id,
        lease_digest,
        receipt_digest,
    ] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    hasher.update(bytes);
    format!("verifier-{}", hasher.finalize().to_hex())
}

fn validate_host_verifier_output(
    output: &HostCapturedVerifierOutputV1,
) -> Result<(), ArtifactError> {
    if !valid_verifier_identifier(output.verification_run_id())
        || !valid_text(output.principal())
        || !valid_verifier_identifier(output.goal_id())
        || !valid_verifier_identifier(output.run_id())
        || !valid_verifier_identifier(output.spec_id())
        || !valid_verifier_identifier(output.profile_id())
        || !valid_verifier_digest(output.spec_digest())
        || !valid_verifier_digest(output.profile_digest())
        || !valid_verifier_digest(output.live_workspace_revision())
        || output.owner_epoch() == 0
        || output.criteria().is_empty()
        || output.criteria().len() > 256
    {
        return Err(ArtifactError::InvalidVerifierEvidence);
    }
    let expected_scope =
        ArtifactOwnerScopeV1::new("verification_run", output.verification_run_id())?;
    if output.owner_scope() != &expected_scope {
        return Err(ArtifactError::InvalidVerifierEvidence);
    }

    let mut criterion_ids = std::collections::BTreeSet::new();
    let mut aggregate_output_bytes = 0_u64;
    let mut aggregate_manifest_bytes = 0_u64;
    for criterion in output.criteria() {
        let observation = criterion.observation();
        let id = criterion.criterion_id();
        let manifest = criterion.manifest();
        if !valid_verifier_identifier(id)
            || !criterion_ids.insert(id)
            || id != observation.criterion_id()
            || !valid_verifier_identifier(observation.test_identity())
            || !valid_verifier_identifier(observation.test_run_id())
            || !valid_verifier_identifier(observation.execution_id())
            || observation.generation() == 0
            || !valid_verifier_identifier(criterion.effect_id())
            || !valid_verifier_identifier(criterion.challenge_id())
            || !valid_verifier_digest(criterion.capability_lease_digest())
            || !valid_verifier_digest(criterion.receipt_digest())
            || !valid_verifier_digest(observation.stdout_digest())
            || !valid_verifier_digest(observation.stderr_digest())
            || (observation.verdict() == crate::managed_control::VerificationVerdictV1::Pass
                && (observation.exit_code() != 0 || observation.truncated()))
            || manifest.redaction() != ArtifactRedactionV1::NotNeeded
            || !valid_verifier_digest(manifest.digest())
        {
            return Err(ArtifactError::InvalidVerifierEvidence);
        }
        let stdout_length = u64::try_from(criterion.stdout().len())
            .map_err(|_| ArtifactError::InvalidVerifierEvidence)?;
        let stderr_length = u64::try_from(criterion.stderr().len())
            .map_err(|_| ArtifactError::InvalidVerifierEvidence)?;
        let observed_total = stdout_length
            .checked_add(stderr_length)
            .ok_or(ArtifactError::InvalidVerifierEvidence)?;
        if observed_total != observation.output_bytes()
            || format!(
                "blake3:{}",
                Digest::from_blake3(criterion.stdout()).to_hex()
            ) != observation.stdout_digest()
            || format!(
                "blake3:{}",
                Digest::from_blake3(criterion.stderr()).to_hex()
            ) != observation.stderr_digest()
        {
            return Err(ArtifactError::InvalidVerifierEvidence);
        }
        let manifest_length = u64::try_from(manifest.bytes().len())
            .map_err(|_| ArtifactError::InvalidVerifierEvidence)?;
        if manifest_length == 0
            || manifest_length != manifest.byte_count()
            || manifest_length > 64 * 1024
            || format!("blake3:{}", Digest::from_blake3(manifest.bytes()).to_hex())
                != manifest.digest()
        {
            return Err(ArtifactError::InvalidVerifierEvidence);
        }
        validate_verifier_manifest_claims(
            output,
            criterion,
            stdout_length,
            stderr_length,
            manifest.bytes(),
        )?;
        aggregate_output_bytes = aggregate_output_bytes
            .checked_add(observed_total)
            .ok_or(ArtifactError::InvalidVerifierEvidence)?;
        aggregate_manifest_bytes = aggregate_manifest_bytes
            .checked_add(manifest_length)
            .ok_or(ArtifactError::InvalidVerifierEvidence)?;
        if aggregate_output_bytes > 64 * 1024 * 1024
            || aggregate_manifest_bytes > 4 * 1024 * 1024
            || stdout_length > 16 * 1024 * 1024
            || stderr_length > 16 * 1024 * 1024
        {
            return Err(ArtifactError::InvalidVerifierEvidence);
        }
    }
    Ok(())
}

fn validate_verifier_manifest_claims(
    output: &HostCapturedVerifierOutputV1,
    criterion: &crate::host_kernel::HostCapturedVerifierCriterionV1,
    stdout_length: u64,
    stderr_length: u64,
    bytes: &[u8],
) -> Result<(), ArtifactError> {
    let observation = criterion.observation();
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ArtifactError::InvalidVerifierEvidence)?;
    let string = |key: &str| value.get(key).and_then(serde_json::Value::as_str);
    let number = |key: &str| value.get(key).and_then(serde_json::Value::as_u64);
    let signed_number = |key: &str| value.get(key).and_then(serde_json::Value::as_i64);
    let expected_verdict = match observation.verdict() {
        crate::managed_control::VerificationVerdictV1::Pass => "PASS",
        crate::managed_control::VerificationVerdictV1::Fail => "FAIL",
    };
    if string("schema") != Some("horizoncode.verifier-result.v1")
        || string("verificationRunID") != Some(output.verification_run_id())
        || string("goalID") != Some(output.goal_id())
        || string("runID") != Some(output.run_id())
        || string("specID") != Some(output.spec_id())
        || string("specDigest") != Some(output.spec_digest())
        || string("verifierPrincipal") != Some(output.principal())
        || string("profileID") != Some(output.profile_id())
        || string("profileDigest") != Some(output.profile_digest())
        || string("liveWorkspaceRevision") != Some(output.live_workspace_revision())
        || string("criterionID") != Some(criterion.criterion_id())
        || string("effectID") != Some(criterion.effect_id())
        || string("challengeID") != Some(criterion.challenge_id())
        || string("capabilityLeaseDigest") != Some(criterion.capability_lease_digest())
        || string("receiptDigest") != Some(criterion.receipt_digest())
        || string("testIdentity") != Some(observation.test_identity())
        || string("testRunID") != Some(observation.test_run_id())
        || string("executionID") != Some(observation.execution_id())
        || string("stdoutDigest") != Some(observation.stdout_digest())
        || string("stderrDigest") != Some(observation.stderr_digest())
        || string("verdict") != Some(expected_verdict)
        || number("generation") != Some(observation.generation())
        || number("ownerEpoch") != Some(output.owner_epoch())
        || signed_number("exitCode") != Some(i64::from(observation.exit_code()))
        || number("durationMs") != Some(observation.duration_ms())
        || number("stdoutByteCount") != Some(stdout_length)
        || number("stderrByteCount") != Some(stderr_length)
        || number("outputByteCount") != Some(observation.output_bytes())
        || value.get("truncated").and_then(serde_json::Value::as_bool)
            != Some(observation.truncated())
    {
        return Err(ArtifactError::InvalidVerifierEvidence);
    }
    Ok(())
}

pub(crate) fn timestamp_from_unix_millis(value: u64) -> Result<String, ArtifactError> {
    let seconds = i64::try_from(value / 1000).map_err(|_| ArtifactError::InvalidMetadata)?;
    let days = seconds.div_euclid(86_400);
    let second_of_day = seconds.rem_euclid(86_400);
    let shifted = days
        .checked_add(719_468)
        .ok_or(ArtifactError::InvalidMetadata)?;
    let era = shifted.div_euclid(146_097);
    let day_of_era = shifted - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let mut year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_prime = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_prime + 2) / 5 + 1;
    let month = month_prime + if month_prime < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    if !(0..=9999).contains(&year) {
        return Err(ArtifactError::InvalidMetadata);
    }
    let hour = second_of_day / 3_600;
    let minute = (second_of_day % 3_600) / 60;
    let second = second_of_day % 60;
    let millis = value % 1000;
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z"
    ))
}

fn metadata_reference(metadata: &ArtifactMetadataV1) -> Result<ArtifactRefV1, ArtifactError> {
    validate_text(&metadata.artifact_id)?;
    validate_text(&metadata.media_type)?;
    validate_text(&metadata.retention_class)?;
    if !valid_timestamp(&metadata.created_at)
        || metadata.owner_refs.len() > crate::protocol::MAX_SUBJECT_IDS
        || metadata.owner_refs.iter().any(|value| !valid_text(value))
    {
        return Err(ArtifactError::InvalidMetadata);
    }
    let dropped_byte_count = parse_decimal(&metadata.dropped_byte_count)?;
    match metadata.fidelity {
        ArtifactFidelityV1::Full if dropped_byte_count != 0 => {
            return Err(ArtifactError::InvalidMetadata);
        }
        ArtifactFidelityV1::HeadTailSample if dropped_byte_count == 0 => {
            return Err(ArtifactError::InvalidMetadata);
        }
        ArtifactFidelityV1::Full
        | ArtifactFidelityV1::HeadTailSample
        | ArtifactFidelityV1::Failed => {}
    }
    let mut owner_refs = std::collections::BTreeSet::new();
    if metadata
        .owner_refs
        .iter()
        .any(|owner_ref| !owner_refs.insert(owner_ref))
    {
        return Err(ArtifactError::InvalidMetadata);
    }
    validate_reference_fields(
        &metadata.artifact_id,
        &metadata.digest,
        &metadata.byte_length,
        &metadata.media_type,
    )?;
    if parse_decimal(&metadata.byte_length)? > MAX_ARTIFACT_BYTES {
        return Err(ArtifactError::TooLarge);
    }

    if metadata.encryption == ArtifactEncryptionV1::StateKey {
        return Err(ArtifactError::EncryptionUnavailable);
    }
    if metadata.redaction == ArtifactRedactionV1::Unknown {
        return Err(ArtifactError::InvalidMetadata);
    }
    if metadata.access == ArtifactAccessV1::Sensitive {
        return Err(ArtifactError::SensitiveEncryptionRequired);
    }

    Ok(ArtifactRefV1 {
        artifact_id: metadata.artifact_id.clone(),
        digest: metadata.digest.clone(),
        byte_length: metadata.byte_length.clone(),
        media_type: metadata.media_type.clone(),
        classification: match metadata.access {
            ArtifactAccessV1::Public => ArtifactClassificationV1::Public,
            ArtifactAccessV1::Workspace => ArtifactClassificationV1::Workspace,
            ArtifactAccessV1::Sensitive => ArtifactClassificationV1::Sensitive,
        },
    })
}

fn encode_metadata(metadata: &ArtifactMetadataV1) -> Result<Vec<u8>, ArtifactError> {
    metadata_reference(metadata)?;
    let value = serde_json::json!({
        "access": access_name(metadata.access),
        "artifactId": metadata.artifact_id,
        "byteLength": metadata.byte_length,
        "createdAt": metadata.created_at,
        "digest": metadata.digest,
        "droppedByteCount": metadata.dropped_byte_count,
        "encryption": encryption_name(metadata.encryption),
        "fidelity": fidelity_name(metadata.fidelity),
        "format": ARTIFACT_METADATA_FORMAT,
        "mediaType": metadata.media_type,
        "ownerRefs": metadata.owner_refs,
        "redaction": redaction_name(metadata.redaction),
        "retentionClass": metadata.retention_class,
    });
    let bytes = serde_json::to_vec(&value).map_err(|_| ArtifactError::InvalidMetadata)?;
    if bytes.len() > MAX_ARTIFACT_METADATA_BYTES {
        return Err(ArtifactError::InvalidMetadata);
    }
    Ok(bytes)
}

fn decode_metadata(bytes: &[u8]) -> Result<ArtifactMetadataV1, ArtifactError> {
    let value: serde_json::Value =
        serde_json::from_slice(bytes).map_err(|_| ArtifactError::CorruptMetadata)?;
    if serde_json::to_vec(&value).map_err(|_| ArtifactError::CorruptMetadata)? != bytes {
        return Err(ArtifactError::CorruptMetadata);
    }
    let object = value.as_object().ok_or(ArtifactError::CorruptMetadata)?;
    let format = object.get("format").and_then(serde_json::Value::as_str);
    let legacy = format == Some(LEGACY_ARTIFACT_METADATA_FORMAT);
    if (legacy && object.len() != 11)
        || (!legacy && (object.len() != 13 || format != Some(ARTIFACT_METADATA_FORMAT)))
    {
        return Err(ArtifactError::CorruptMetadata);
    }
    let owner_refs = object
        .get("ownerRefs")
        .and_then(serde_json::Value::as_array)
        .ok_or(ArtifactError::CorruptMetadata)?
        .iter()
        .map(|value| {
            value
                .as_str()
                .map(str::to_owned)
                .ok_or(ArtifactError::CorruptMetadata)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let metadata = ArtifactMetadataV1 {
        artifact_id: metadata_string(object, "artifactId")?,
        digest: metadata_string(object, "digest")?,
        byte_length: metadata_string(object, "byteLength")?,
        media_type: metadata_string(object, "mediaType")?,
        dropped_byte_count: if legacy {
            "0".to_owned()
        } else {
            metadata_string(object, "droppedByteCount")?
        },
        owner_refs,
        access: match metadata_string(object, "access")?.as_str() {
            "public" => ArtifactAccessV1::Public,
            "workspace" => ArtifactAccessV1::Workspace,
            "sensitive" => ArtifactAccessV1::Sensitive,
            _ => return Err(ArtifactError::CorruptMetadata),
        },
        retention_class: metadata_string(object, "retentionClass")?,
        created_at: metadata_string(object, "createdAt")?,
        fidelity: if legacy {
            ArtifactFidelityV1::Full
        } else {
            match metadata_string(object, "fidelity")?.as_str() {
                "full" => ArtifactFidelityV1::Full,
                "head_tail_sample" => ArtifactFidelityV1::HeadTailSample,
                "failed" => ArtifactFidelityV1::Failed,
                _ => return Err(ArtifactError::CorruptMetadata),
            }
        },
        encryption: match metadata_string(object, "encryption")?.as_str() {
            "none" => ArtifactEncryptionV1::None,
            "state-key" => ArtifactEncryptionV1::StateKey,
            _ => return Err(ArtifactError::CorruptMetadata),
        },
        redaction: match metadata_string(object, "redaction")?.as_str() {
            "not-needed" => ArtifactRedactionV1::NotNeeded,
            "applied" => ArtifactRedactionV1::Applied,
            "unknown" => ArtifactRedactionV1::Unknown,
            _ => return Err(ArtifactError::CorruptMetadata),
        },
    };
    metadata_reference(&metadata).map_err(|_| ArtifactError::CorruptMetadata)?;
    Ok(metadata)
}

fn metadata_string(
    object: &serde_json::Map<String, serde_json::Value>,
    key: &str,
) -> Result<String, ArtifactError> {
    object
        .get(key)
        .and_then(serde_json::Value::as_str)
        .map(str::to_owned)
        .ok_or(ArtifactError::CorruptMetadata)
}

fn access_name(access: ArtifactAccessV1) -> &'static str {
    match access {
        ArtifactAccessV1::Public => "public",
        ArtifactAccessV1::Workspace => "workspace",
        ArtifactAccessV1::Sensitive => "sensitive",
    }
}

fn encryption_name(encryption: ArtifactEncryptionV1) -> &'static str {
    match encryption {
        ArtifactEncryptionV1::None => "none",
        ArtifactEncryptionV1::StateKey => "state-key",
    }
}

fn fidelity_name(fidelity: ArtifactFidelityV1) -> &'static str {
    match fidelity {
        ArtifactFidelityV1::Full => "full",
        ArtifactFidelityV1::HeadTailSample => "head_tail_sample",
        ArtifactFidelityV1::Failed => "failed",
    }
}

fn redaction_name(redaction: ArtifactRedactionV1) -> &'static str {
    match redaction {
        ArtifactRedactionV1::NotNeeded => "not-needed",
        ArtifactRedactionV1::Applied => "applied",
        ArtifactRedactionV1::Unknown => "unknown",
    }
}

fn validate_reference(reference: &ArtifactRefV1) -> Result<(), ArtifactError> {
    validate_reference_fields(
        &reference.artifact_id,
        &reference.digest,
        &reference.byte_length,
        &reference.media_type,
    )
}

fn validate_reference_fields(
    artifact_id: &str,
    digest: &str,
    byte_length: &str,
    media_type: &str,
) -> Result<(), ArtifactError> {
    validate_text(artifact_id)?;
    validate_text(media_type)?;
    let Some(hex_digest) = digest.strip_prefix("blake3:") else {
        return Err(ArtifactError::InvalidMetadata);
    };
    Digest::parse_hex(hex_digest).map_err(|_| ArtifactError::InvalidMetadata)?;
    parse_decimal(byte_length)?;
    Ok(())
}

fn validate_text(value: &str) -> Result<(), ArtifactError> {
    if valid_text(value) {
        Ok(())
    } else {
        Err(ArtifactError::InvalidMetadata)
    }
}

fn valid_text(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= crate::protocol::MAX_IDENTIFIER_BYTES
        && !value.chars().any(char::is_control)
}

fn parse_decimal(value: &str) -> Result<u64, ArtifactError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(ArtifactError::InvalidMetadata);
    }
    value.parse().map_err(|_| ArtifactError::InvalidMetadata)
}

fn valid_timestamp(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return false;
    }
    let Some(year) = decimal_component(&bytes[0..4]) else {
        return false;
    };
    let Some(month) = decimal_component(&bytes[5..7]) else {
        return false;
    };
    let Some(day) = decimal_component(&bytes[8..10]) else {
        return false;
    };
    let Some(hour) = decimal_component(&bytes[11..13]) else {
        return false;
    };
    let Some(minute) = decimal_component(&bytes[14..16]) else {
        return false;
    };
    let Some(second) = decimal_component(&bytes[17..19]) else {
        return false;
    };
    if !bytes[20..23].iter().all(u8::is_ascii_digit)
        || !(1..=12).contains(&month)
        || !(1..=days_in_month(year, month)).contains(&day)
        || hour > 23
        || minute > 59
        || second > 60
        || (second == 60 && (hour != 23 || minute != 59 || day != days_in_month(year, month)))
    {
        return false;
    }
    true
}

fn decimal_component(bytes: &[u8]) -> Option<u32> {
    if !bytes.iter().all(u8::is_ascii_digit) {
        return None;
    }
    bytes.iter().try_fold(0u32, |value, byte| {
        value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))
    })
}

fn days_in_month(year: u32, month: u32) -> u32 {
    match month {
        2 if year.is_multiple_of(400) || (year.is_multiple_of(4) && !year.is_multiple_of(100)) => {
            29
        }
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

/// Canonical capability IDs for the artifact surface (§33.10). Read actions
/// (`list`/`inspect`/`read_range`) are authorized by authenticated bounded
/// artifact-store read permits, never by human-approval Guard mutations.
pub(crate) const ARTIFACTS_LIST_ID: &str = "artifacts.list";
pub(crate) const ARTIFACTS_INSPECT_ID: &str = "artifacts.inspect";
pub(crate) const ARTIFACTS_READ_RANGE_ID: &str = "artifacts.read_range";
/// User-facing durable-export capability; its Guard action composes the
/// canonical `files.write` path (P1 decision).
pub(crate) const ARTIFACTS_EXPORT_ID: &str = "artifacts.export";
/// Durable capture effect action. Not supported by the canonical Guard yet, so
/// capture stays fail-closed via `ARTIFACT_EFFECTS_ENABLED`.
pub(crate) const ARTIFACTS_CAPTURE_ID: &str = "artifacts.capture";

/// Artifact effects stay unavailable until P1 issues a supported canonical Guard
/// action scope and a one-use ExecutionHost lease/receipt for them.
pub(crate) const ARTIFACT_EFFECTS_ENABLED: bool = false;

/// Largest bounded `artifacts.list` scan; never a whole-store enumeration.
const MAX_LIST_ENTRIES: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ArtifactEffectActionV1 {
    Capture,
    Export,
}

impl ArtifactEffectActionV1 {
    /// Canonical Guard action this effect composes. Export is a workspace write
    /// and therefore uses the existing `files.write` policy path; capture has no
    /// canonical Guard action yet and stays denied until P1 adds one.
    pub(crate) fn guard_action_id(self) -> &'static str {
        match self {
            Self::Export => guard::FILES_WRITE_ID,
            Self::Capture => ARTIFACTS_CAPTURE_ID,
        }
    }
}

/// Authenticated owner scope. Writes bind this scope into artifact metadata and
/// reads are authorized against it; callers cannot supply their own owner refs.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ArtifactOwnerScopeV1 {
    kind: String,
    id: String,
}

impl ArtifactOwnerScopeV1 {
    pub(crate) fn new(kind: &str, id: &str) -> Result<Self, ArtifactError> {
        if !valid_text(kind) || !valid_text(id) {
            return Err(ArtifactError::InvalidMetadata);
        }
        Ok(Self {
            kind: kind.to_owned(),
            id: id.to_owned(),
        })
    }

    pub(crate) fn owner_ref(&self) -> String {
        format!("{}:{}", self.kind, self.id)
    }
}

/// Canonical Guard inputs for one artifact effect, supplied by the authenticated
/// caller. The `guard_request` builder fixes the action id, resource and origin so
/// an artifact effect cannot present itself as another capability. For export the
/// target is the destination file the bytes are written to, and the action is the
/// canonical `files.write` policy; for capture the target is the bounded artifact
/// store scope.
pub(crate) struct ArtifactEffectRequestV1<'a> {
    pub action: ArtifactEffectActionV1,
    pub principal: &'a str,
    pub request_id: &'a str,
    pub origin: EffectOriginV1<'a>,
    pub argument_digest: &'a str,
    pub turn_context_digest: &'a str,
    pub workspace_root: &'a Path,
    pub workspace_binding: &'a str,
    pub target: &'a Path,
    pub resource: &'a str,
    pub policy_snapshot_ids: &'a [&'a str],
    pub requested_guarantees: &'a [&'a str],
}

/// One-use effect grant that must come from the canonical ExecutionHost
/// settlement before a durable artifact write or export is published.
pub(crate) struct ArtifactEffectGrantV1 {
    pub lease_id: String,
    pub receipt_digest: String,
}

impl ArtifactEffectGrantV1 {
    fn validate(&self) -> Result<(), ArtifactError> {
        if !valid_text(&self.lease_id) {
            return Err(ArtifactError::InvalidEffectGrant);
        }
        let Some(hex) = self.receipt_digest.strip_prefix("blake3:") else {
            return Err(ArtifactError::InvalidEffectGrant);
        };
        if hex.len() != 64
            || !hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(ArtifactError::InvalidEffectGrant);
        }
        Ok(())
    }
}

/// Caller-supplied artifact metadata; owner refs are derived from the
/// authenticated owner scope instead of being accepted from the caller.
pub(crate) struct ArtifactWriteMetadataV1 {
    pub media_type: String,
    pub access: ArtifactAccessV1,
    pub retention_class: String,
    pub created_at: String,
    pub encryption: ArtifactEncryptionV1,
    pub redaction: ArtifactRedactionV1,
}

/// Production caller for the `artifacts.*` capability surface. Every durable write
/// and export goes through the canonical Guard decision first, and every read goes
/// through the store's guard-mediated read permits. While the canonical policy does
/// not authorize an artifact action, that action fails closed with a typed denial
/// and no store state is touched.
pub(crate) struct GuardedArtifactIngressV1<A> {
    store: ArtifactStore<A>,
}

impl<A: ArtifactAuthorizer> GuardedArtifactIngressV1<A> {
    pub(crate) fn open(root: &Path, authorizer: A) -> Result<Self, ArtifactError> {
        Ok(Self {
            store: ArtifactStore::open(root, authorizer)?,
        })
    }

    /// Builds the canonical Guard request for an artifact effect. Export composes
    /// the existing `files.write` policy path over the destination file; capture
    /// keeps its own action id and stays denied until P1 supports it.
    pub(crate) fn guard_request<'a>(
        &self,
        request: &'a ArtifactEffectRequestV1<'a>,
    ) -> AuthorizationRequestV1<'a> {
        AuthorizationRequestV1 {
            request_id: request.request_id,
            principal: request.principal,
            origin: request.origin,
            action_id: request.action.guard_action_id(),
            argument_digest: request.argument_digest,
            turn_context_digest: request.turn_context_digest,
            resource_resolution: ResourceResolutionV1 {
                workspace_root: request.workspace_root,
                workspace_binding: request.workspace_binding,
                target: request.target,
                resource: request.resource,
            },
            executable: None,
            policy_snapshot_ids: request.policy_snapshot_ids,
            requested_guarantees: request.requested_guarantees,
        }
    }

    /// Recomputes the canonical decision and requires an exact, non-denied match
    /// bound to the requested artifact action.
    fn authorize_effect(
        &self,
        request: &ArtifactEffectRequestV1<'_>,
        decision: &GuardDecisionV1,
    ) -> Result<(), ArtifactError> {
        let canonical_request = self.guard_request(request);
        let recomputed = guard::authorize(&canonical_request, &decision.decision_id);
        if recomputed != *decision {
            return Err(ArtifactError::GuardDenied {
                reason: "decision does not match the canonical request",
            });
        }
        if decision.normalized_action != canonical_request.action_id
            || decision.decision != DecisionKind::Ask
            || decision.reason_code.is_some()
        {
            return Err(ArtifactError::GuardDenied {
                reason: decision.reason_code.unwrap_or("artifact action denied"),
            });
        }
        Ok(())
    }

    /// Durable capture after canonical authorization and a one-use effect grant.
    /// Fails closed: artifact effects are disabled until P1 issues a supported
    /// canonical Guard scope plus an ExecutionHost lease/receipt, so no store
    /// write happens through this production entry point.
    pub(crate) fn capture_guarded(
        &self,
        request: &ArtifactEffectRequestV1<'_>,
        decision: &GuardDecisionV1,
        grant: &ArtifactEffectGrantV1,
        owner: &ArtifactOwnerScopeV1,
        artifact_id: String,
        metadata: ArtifactWriteMetadataV1,
        capture: CapturedArtifactV1,
    ) -> Result<ArtifactRefV1, ArtifactError> {
        if !ARTIFACT_EFFECTS_ENABLED {
            return Err(ArtifactError::EffectUnavailable);
        }
        self.authorize_effect(request, decision)?;
        grant.validate()?;
        self.capture_after_guard_authorization(owner, artifact_id, metadata, capture)
    }

    /// Guarded durable export (§37: durable export is a separate Guarded action).
    /// Export composes the canonical `files.write` Guard path, but stays
    /// unavailable until artifact effects are enabled with a supported
    /// ExecutionHost lease/receipt.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn export_guarded(
        &self,
        request: &ArtifactEffectRequestV1<'_>,
        decision: &GuardDecisionV1,
        grant: &ArtifactEffectGrantV1,
        owner: &ArtifactOwnerScopeV1,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
        max_bytes: NonZeroUsize,
    ) -> Result<Vec<u8>, ArtifactError> {
        if !ARTIFACT_EFFECTS_ENABLED {
            return Err(ArtifactError::EffectUnavailable);
        }
        self.authorize_effect(request, decision)?;
        grant.validate()?;
        self.export_after_guard_authorization(owner, principal, artifact_ref, max_bytes)
    }

    /// Publishes a capture that has already passed canonical authorization.
    /// Crate-private so the only production entry point is `capture_guarded`.
    pub(crate) fn capture_after_guard_authorization(
        &self,
        owner: &ArtifactOwnerScopeV1,
        artifact_id: String,
        metadata: ArtifactWriteMetadataV1,
        capture: CapturedArtifactV1,
    ) -> Result<ArtifactRefV1, ArtifactError> {
        self.store.put_capture(
            artifact_id,
            metadata.media_type,
            vec![owner.owner_ref()],
            metadata.access,
            metadata.retention_class,
            metadata.created_at,
            metadata.encryption,
            metadata.redaction,
            capture,
        )
    }

    /// Copies artifact bytes for an export that has already passed canonical
    /// authorization and grant validation. Crate-private so the only production
    /// entry point is `export_guarded`; requires the artifact to be bound to the
    /// authenticated owner scope.
    pub(crate) fn export_after_guard_authorization(
        &self,
        owner: &ArtifactOwnerScopeV1,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
        max_bytes: NonZeroUsize,
    ) -> Result<Vec<u8>, ArtifactError> {
        let mut permit = self.store.authorize_read(principal, artifact_ref)?;
        let metadata = self.store.metadata(&permit)?;
        if !metadata
            .owner_refs
            .iter()
            .any(|value| *value == owner.owner_ref())
        {
            return Err(ArtifactError::AuthorizationDenied);
        }
        let limit = max_bytes.get().min(MAX_ARTIFACT_BYTES as usize);
        let mut exported = Vec::new();
        loop {
            let remaining = limit
                .checked_sub(exported.len())
                .ok_or(ArtifactError::TooLarge)?;
            if remaining == 0 {
                break;
            }
            let chunk_limit = NonZeroUsize::new(remaining).ok_or(ArtifactError::TooLarge)?;
            let next_offset = permit.next_offset();
            let chunk = self.store.read(&mut permit, next_offset, chunk_limit)?;
            exported.extend_from_slice(&chunk.bytes);
            if chunk.complete {
                break;
            }
        }
        Ok(exported)
    }

    /// Guard-mediated read authorization bounded to the authenticated principal.
    pub(crate) fn authorize_read(
        &self,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
    ) -> Result<ReadPermit, ArtifactError> {
        self.store.authorize_read(principal, artifact_ref)
    }

    pub(crate) fn inspect(
        &self,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
    ) -> Result<ArtifactMetadataV1, ArtifactError> {
        let permit = self.store.authorize_read(principal, artifact_ref)?;
        self.store.metadata(&permit)
    }

    /// Resolves a deterministic HostKernel artifact ID. This does not authorize
    /// the caller or expose bytes; the caller must validate the exact effect
    /// receipt and metadata owner refs, then use the ordinary `inspect`/range
    /// path with the resulting reference.
    pub(crate) fn reference_for_host_id(
        &self,
        artifact_id: &str,
    ) -> Result<(ArtifactRefV1, ArtifactMetadataV1), ArtifactError> {
        self.store.reference_for_host_id(artifact_id)
    }

    /// Verifies an authenticated owner's bounded artifact reference against the
    /// canonical metadata and the complete immutable content-addressed object.
    /// The returned metadata is read from disk; the caller-supplied digest is
    /// accepted only as part of an exact reference match and is independently
    /// checked against the object's bytes by `open_private_object`.
    pub(crate) fn verify_ref(
        &self,
        owner: &ArtifactOwnerScopeV1,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
        max_bytes: NonZeroUsize,
    ) -> Result<ArtifactMetadataV1, ArtifactError> {
        let permit = self.store.authorize_read(principal, artifact_ref)?;
        let metadata = self.store.metadata(&permit)?;
        let owner_ref = owner.owner_ref();
        if !metadata.owner_refs.iter().any(|value| value == &owner_ref) {
            return Err(ArtifactError::AuthorizationDenied);
        }
        let total_length =
            parse_decimal(&metadata.byte_length).map_err(|_| ArtifactError::CorruptMetadata)?;
        let read_bound = u64::try_from(max_bytes.get())
            .unwrap_or(u64::MAX)
            .min(MAX_ARTIFACT_BYTES);
        if total_length > read_bound {
            return Err(ArtifactError::TooLarge);
        }

        let chunk_size = max_bytes.get().min(MAX_ARTIFACT_CHUNK_BYTES).max(1);
        let chunk_size = NonZeroUsize::new(chunk_size).ok_or(ArtifactError::TooLarge)?;
        let mut offset = 0;
        loop {
            let chunk = self.store.read(&permit, offset, chunk_size)?;
            offset = chunk.next_offset;
            if chunk.complete {
                break;
            }
        }
        Ok(metadata)
    }

    /// One bounded, independently authorized range read.
    pub(crate) fn read_range(
        &self,
        principal: &str,
        artifact_ref: &ArtifactRefV1,
        offset: u64,
        max_bytes: NonZeroUsize,
    ) -> Result<ArtifactChunkV1, ArtifactError> {
        let permit = self.store.authorize_read(principal, artifact_ref)?;
        self.store.read_at(&permit, offset, max_bytes)
    }

    /// Bounded `artifacts.list`: scans at most `limit` digest-verified metadata
    /// entries, authorizes every entry for the principal, and fails closed on the
    /// first corrupt record instead of returning a partial view. If the store
    /// holds more entries than the requested bound the call reports `TooLarge`
    /// rather than silently omitting artifacts.
    pub(crate) fn list(
        &self,
        principal: &str,
        limit: NonZeroUsize,
    ) -> Result<Vec<ArtifactMetadataV1>, ArtifactError> {
        let limit = limit.get().min(MAX_LIST_ENTRIES);
        let metadata_root = self.store.root.join(METADATA_DIRECTORY);
        let mut listed = Vec::new();
        let shards = fs::read_dir(&metadata_root)
            .map_err(|error| io_error("list metadata shards", error))?;
        for shard in shards {
            let shard = shard.map_err(|error| io_error("list metadata shards", error))?;
            let shard_name = shard.file_name();
            let Some(shard_name) = shard_name.to_str() else {
                return Err(ArtifactError::CorruptMetadata);
            };
            if shard_name.len() != 2
                || !shard_name
                    .bytes()
                    .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            {
                continue;
            }
            let entries =
                fs::read_dir(shard.path()).map_err(|error| io_error("list metadata", error))?;
            for entry in entries {
                let entry = entry.map_err(|error| io_error("list metadata", error))?;
                let file_name = entry.file_name();
                let Some(file_name) = file_name.to_str() else {
                    return Err(ArtifactError::CorruptMetadata);
                };
                let Some(hex) = file_name.strip_suffix(".json") else {
                    continue;
                };
                if hex.len() != 62
                    || !hex
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                {
                    continue;
                }
                if listed.len() >= limit {
                    return Err(ArtifactError::TooLarge);
                }
                let relative = Path::new(METADATA_DIRECTORY)
                    .join(shard_name)
                    .join(file_name);
                let bytes = read_private_file(
                    &self.store.root_directory,
                    &relative,
                    MAX_ARTIFACT_METADATA_BYTES,
                    true,
                )?;
                let metadata = decode_metadata(&bytes)?;
                let reference = metadata_reference(&metadata)?;
                let permit = self.store.authorize_read(principal, &reference)?;
                listed.push(self.store.metadata(&permit)?);
            }
        }
        Ok(listed)
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use crate::guard::{DecisionKind, EffectOriginKindV1, EffectOriginV1, GuardDecisionV1};
    use crate::owner_log::Digest;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_ROOT: AtomicU64 = AtomicU64::new(0);

    struct DenyAll;

    impl ArtifactAuthorizer for DenyAll {
        fn authorize_read(
            &self,
            _principal: &str,
            _artifact_ref: &ArtifactRefV1,
        ) -> Result<ReadPermit, ArtifactError> {
            Err(ArtifactError::AuthorizationDenied)
        }
    }

    struct Allow;

    impl ArtifactAuthorizer for Allow {
        fn authorize_read(
            &self,
            _principal: &str,
            artifact_ref: &ArtifactRefV1,
        ) -> Result<ReadPermit, ArtifactError> {
            Ok(ReadPermit::new(artifact_ref.clone()))
        }
    }

    struct TempRoot(std::path::PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let base = std::env::var_os("HORIZON_OWNER_LOG_TEST_TMPDIR")
                .map(std::path::PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            let tick = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let root = base.join(format!(
                "horizon-artifact-store-{}-{tick}-{}",
                std::process::id(),
                NEXT_ROOT.fetch_add(1, Ordering::Relaxed)
            ));
            Self(root)
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn metadata(bytes: &[u8], byte_length: &str) -> ArtifactMetadataV1 {
        ArtifactMetadataV1 {
            artifact_id: "artifact-1".to_owned(),
            digest: format!("blake3:{}", Digest::from_blake3(bytes).to_hex()),
            byte_length: byte_length.to_owned(),
            media_type: "application/octet-stream".to_owned(),
            owner_refs: vec!["thread:1".to_owned()],
            access: ArtifactAccessV1::Workspace,
            retention_class: "default".to_owned(),
            created_at: "2026-10-10T12:00:00.000Z".to_owned(),
            fidelity: ArtifactFidelityV1::Full,
            dropped_byte_count: "0".to_owned(),
            encryption: ArtifactEncryptionV1::None,
            redaction: ArtifactRedactionV1::NotNeeded,
        }
    }

    fn metadata_for(id: &str, bytes: &[u8]) -> ArtifactMetadataV1 {
        let mut metadata = metadata(bytes, &bytes.len().to_string());
        metadata.artifact_id = id.to_owned();
        metadata
    }

    #[test]
    fn artifact_store_enforces_aggregate_bytes_and_count_without_partial_publication() {
        let root = TempRoot::new();
        let limits = ArtifactStoreLimitsV1 {
            max_bytes: 10,
            max_artifacts: 2,
        };
        let store = ArtifactStore::open_with_limits(&root.0, Allow, limits).unwrap();

        let mut first = metadata(b"123456", "6");
        first.artifact_id = "artifact-first".to_owned();
        store.put(b"123456", first).unwrap();
        assert_eq!(
            store.usage().unwrap(),
            ArtifactStoreUsageV1 {
                bytes: 6,
                artifacts: 1
            }
        );

        let mut over_bytes = metadata(b"12345", "5");
        over_bytes.artifact_id = "artifact-over-bytes".to_owned();
        assert_eq!(
            store.put(b"12345", over_bytes),
            Err(ArtifactError::StoreLimitExceeded)
        );
        assert_eq!(
            store.usage().unwrap(),
            ArtifactStoreUsageV1 {
                bytes: 6,
                artifacts: 1
            }
        );

        let mut second = metadata(b"abcd", "4");
        second.artifact_id = "artifact-second".to_owned();
        store.put(b"abcd", second).unwrap();
        assert_eq!(
            store.usage().unwrap(),
            ArtifactStoreUsageV1 {
                bytes: 10,
                artifacts: 2
            }
        );

        let reopened = ArtifactStore::open_with_limits(&root.0, Allow, limits).unwrap();
        assert_eq!(
            reopened.usage().unwrap(),
            ArtifactStoreUsageV1 {
                bytes: 10,
                artifacts: 2
            }
        );
        let mut over_count = metadata(b"z", "1");
        over_count.artifact_id = "artifact-over-count".to_owned();
        assert_eq!(
            reopened.put(b"z", over_count),
            Err(ArtifactError::StoreLimitExceeded)
        );
        assert_eq!(
            reopened.usage().unwrap(),
            ArtifactStoreUsageV1 {
                bytes: 10,
                artifacts: 2
            }
        );
    }

    #[test]
    fn artifact_store_rejects_startup_when_reconciled_usage_exceeds_new_limits() {
        let root = TempRoot::new();
        let permissive = ArtifactStoreLimitsV1 {
            max_bytes: 16,
            max_artifacts: 2,
        };
        let store = ArtifactStore::open_with_limits(&root.0, Allow, permissive).unwrap();
        let metadata = metadata_for("restart-over-limit", b"123456");
        store.put(b"123456", metadata).unwrap();

        let smaller = ArtifactStoreLimitsV1 {
            max_bytes: 5,
            max_artifacts: 2,
        };
        assert!(matches!(
            ArtifactStore::open_with_limits(&root.0, Allow, smaller),
            Err(ArtifactError::StoreLimitExceeded)
        ));
    }

    #[test]
    fn verifier_capture_timestamp_is_canonical_utc_milliseconds() {
        assert_eq!(
            timestamp_from_unix_millis(0).unwrap(),
            "1970-01-01T00:00:00.000Z"
        );
        assert_eq!(
            timestamp_from_unix_millis(1_767_225_600_123).unwrap(),
            "2026-01-01T00:00:00.123Z"
        );
    }

    #[test]
    fn host_verifier_artifact_capture_persists_only_host_manifest_with_safe_provenance() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let output =
            crate::host_kernel::HostCapturedVerifierOutputV1::test_fixture_for_artifact_store(
                crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::SecretSentinel,
            );

        let refs = store.capture_host_verifier_output(output).unwrap();
        assert_eq!(refs.len(), 1);
        let criterion_refs = refs.get("criterion-one").unwrap();
        assert_eq!(criterion_refs.len(), 1);
        assert_eq!(store.usage().unwrap().artifacts, 1);
        for reference in criterion_refs {
            let permit = store
                .authorize_read("server_auth:fixture-verifier", reference)
                .unwrap();
            let metadata = store.metadata(&permit).unwrap();
            assert_eq!(
                metadata.owner_refs,
                vec!["verification_run:fixture-verification"]
            );
            assert_eq!(metadata.access, ArtifactAccessV1::Workspace);
            assert_eq!(metadata.redaction, ArtifactRedactionV1::NotNeeded);
            assert_eq!(metadata.fidelity, ArtifactFidelityV1::Full);
            assert_eq!(metadata.media_type, "application/json");
        }
        let mut manifest_permit = store
            .authorize_read("server_auth:fixture-verifier", &criterion_refs[0])
            .unwrap();
        let manifest = store
            .read(&mut manifest_permit, 0, NonZeroUsize::new(4096).unwrap())
            .unwrap();
        assert!(manifest.complete);
        let manifest_text = String::from_utf8_lossy(&manifest.bytes);
        assert!(!manifest_text.contains("secret-sentinel-stdout"));
        assert!(!manifest_text.contains("secret-sentinel-stderr"));
        let value: serde_json::Value = serde_json::from_slice(&manifest.bytes).unwrap();
        assert_eq!(value["goalID"], "fixture-goal");
        assert_eq!(value["runID"], "fixture-run");
        assert_eq!(value["specID"], "fixture-spec");
        assert_eq!(value["specDigest"], format!("blake3:{}", "c".repeat(64)));
        assert_eq!(value["criterionID"], "criterion-one");
        assert_eq!(value["verifierPrincipal"], "server_auth:fixture-verifier");
        assert_eq!(value["profileID"], "fixture-profile");
        assert_eq!(value["profileDigest"], format!("blake3:{}", "e".repeat(64)));
        assert_eq!(value["ownerEpoch"], 7);
        assert_eq!(
            value["liveWorkspaceRevision"],
            format!("blake3:{}", "f".repeat(64))
        );
        assert_eq!(value["effectID"], "fixture-effect-0");
        assert_eq!(value["challengeID"], "fixture-challenge-0");
        assert_eq!(
            value["capabilityLeaseDigest"],
            format!("blake3:{}", "a".repeat(64))
        );
        assert_eq!(value["receiptDigest"], format!("blake3:{}", "b".repeat(64)));
        assert_eq!(value["stdoutDigest"].as_str().unwrap().len(), 71);
        assert_eq!(value["stderrDigest"].as_str().unwrap().len(), 71);
    }

    #[test]
    fn host_verifier_artifact_capture_rejects_unassessed_or_invalid_bundle_before_writing() {
        for fixture in [
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::UnknownRedaction,
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::ManifestDigestMismatch,
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::ManifestLengthMismatch,
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::RawDigestMismatch,
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::RawLengthMismatch,
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::ProvenanceMismatch,
            crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::DuplicateCriterion,
        ] {
            let root = TempRoot::new();
            let store = ArtifactStore::open(&root.0, Allow).unwrap();
            let output =
                crate::host_kernel::HostCapturedVerifierOutputV1::test_fixture_for_artifact_store(
                    fixture,
                );

            assert!(store.capture_host_verifier_output(output).is_err());
            assert_eq!(store.usage().unwrap(), ArtifactStoreUsageV1::default());
        }
    }

    #[test]
    fn host_verifier_artifact_capture_marks_truncated_observation_as_failure() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let output =
            crate::host_kernel::HostCapturedVerifierOutputV1::test_fixture_for_artifact_store(
                crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::Truncated,
            );

        let refs = store.capture_host_verifier_output(output).unwrap();
        let reference = &refs["criterion-one"][0];
        let mut permit = store
            .authorize_read("server_auth:fixture-verifier", reference)
            .unwrap();
        let artifact = store
            .read(&mut permit, 0, NonZeroUsize::new(4096).unwrap())
            .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&artifact.bytes).unwrap();
        assert_eq!(manifest["truncated"], true);
        assert_eq!(manifest["verdict"], "FAIL");
    }

    #[test]
    fn host_verifier_artifact_capture_reports_recoverable_partial_publication() {
        let root = TempRoot::new();
        let store = ArtifactStore::open_with_limits(
            &root.0,
            Allow,
            ArtifactStoreLimitsV1 {
                max_bytes: 64 * 1024,
                max_artifacts: 1,
            },
        )
        .unwrap();
        let output =
            crate::host_kernel::HostCapturedVerifierOutputV1::test_fixture_for_artifact_store(
                crate::host_kernel::HostCapturedVerifierOutputFixtureFaultV1::TwoCriteria,
            );

        let error = store.capture_host_verifier_output(output).unwrap_err();
        let ArtifactError::VerifierCaptureIncomplete {
            published,
            failed,
            remaining,
            cause,
        } = error
        else {
            panic!("expected recoverable partial publication details");
        };
        assert_eq!(published.len(), 1);
        assert_eq!(published[0].slot.criterion_id, "criterion-one");
        assert_eq!(published[0].slot.stream, "manifest");
        assert_eq!(failed.criterion_id, "criterion-two");
        assert_eq!(failed.stream, "manifest");
        assert!(failed.artifact_id.starts_with("verifier-"));
        assert!(remaining.is_empty());
        assert_eq!(*cause, ArtifactError::StoreLimitExceeded);
        assert_eq!(store.usage().unwrap().artifacts, 1);
    }

    #[test]
    fn artifact_store_serializes_concurrent_admission_across_instances() {
        let root = TempRoot::new();
        let limits = ArtifactStoreLimitsV1 {
            max_bytes: 10,
            max_artifacts: 4,
        };
        let first = ArtifactStore::open_with_limits(&root.0, Allow, limits).unwrap();
        let second = ArtifactStore::open_with_limits(&root.0, Allow, limits).unwrap();
        let barrier = Arc::new(std::sync::Barrier::new(3));
        let first_barrier = Arc::clone(&barrier);
        let first_thread = std::thread::spawn(move || {
            first_barrier.wait();
            first.put(b"123456", metadata_for("concurrent-one", b"123456"))
        });
        let second_barrier = Arc::clone(&barrier);
        let second_thread = std::thread::spawn(move || {
            second_barrier.wait();
            second.put(b"abcdef", metadata_for("concurrent-two", b"abcdef"))
        });
        barrier.wait();
        let results = [first_thread.join().unwrap(), second_thread.join().unwrap()];
        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| **result == Err(ArtifactError::StoreLimitExceeded))
                .count(),
            1
        );
        let reopened = ArtifactStore::open_with_limits(&root.0, Allow, limits).unwrap();
        assert_eq!(
            reopened.usage().unwrap(),
            ArtifactStoreUsageV1 {
                bytes: 6,
                artifacts: 1
            }
        );
    }

    #[test]
    fn artifact_store_fails_closed_when_persisted_blob_is_missing() {
        let root = TempRoot::new();
        let limits = ArtifactStoreLimitsV1 {
            max_bytes: 16,
            max_artifacts: 2,
        };
        let store = ArtifactStore::open_with_limits(&root.0, Allow, limits).unwrap();
        let reference = store
            .put(b"stored", metadata_for("missing-blob", b"stored"))
            .unwrap();
        fs::remove_file(blob_path(&root.0, &reference.digest).unwrap()).unwrap();
        assert!(matches!(
            ArtifactStore::open_with_limits(&root.0, Allow, limits),
            Err(ArtifactError::CorruptObject)
        ));
    }

    #[test]
    fn artifact_capture_keeps_complete_small_payloads_full() {
        let mut capture = ArtifactCapture::new(8).unwrap();
        capture.push(b"1234").unwrap();
        capture.push(b"5678").unwrap();

        assert_eq!(capture.retained_byte_count(), 8);
        let result = capture.finish();
        assert_eq!(result.bytes, b"12345678");
        assert_eq!(result.observed_byte_count, 8);
        assert_eq!(result.dropped_byte_count, 0);
        assert_eq!(result.fidelity, ArtifactFidelityV1::Full);
    }

    #[test]
    fn artifact_capture_preallocates_only_the_configured_storage_budget() {
        const STORAGE_LIMIT: usize = 16 * 1024;
        let mut capture = ArtifactCapture::new(STORAGE_LIMIT).unwrap();
        let allocated_capacity = |capture: &ArtifactCapture| capture.buffer.capacity();

        assert!(allocated_capacity(&capture) <= STORAGE_LIMIT);
        capture
            .push(&vec![b'x'; STORAGE_LIMIT.saturating_add(1)])
            .unwrap();
        assert_eq!(allocated_capacity(&capture), STORAGE_LIMIT);
        capture.push(b"more").unwrap();
        assert_eq!(allocated_capacity(&capture), STORAGE_LIMIT);
    }

    #[test]
    fn artifact_capture_bounds_allocated_capacity_for_non_power_of_two_budgets() {
        const STORAGE_LIMIT: usize = 9;
        let mut capture = ArtifactCapture::new(STORAGE_LIMIT).unwrap();
        let allocated_capacity = |capture: &ArtifactCapture| capture.buffer.capacity();

        assert!(allocated_capacity(&capture) <= STORAGE_LIMIT);
        capture.push(b"1234567890").unwrap();
        assert!(capture.retained_byte_count() <= STORAGE_LIMIT);
        assert!(allocated_capacity(&capture) <= STORAGE_LIMIT);
        for chunk in [b"ab".as_slice(), b"cd", b"ef", b"gh"] {
            capture.push(chunk).unwrap();
            assert!(capture.retained_byte_count() <= STORAGE_LIMIT);
            assert!(allocated_capacity(&capture) <= STORAGE_LIMIT);
        }

        let result = capture.finish();
        assert_eq!(result.bytes, b"1234defgh");
        assert_eq!(result.observed_byte_count, 18);
        assert_eq!(result.dropped_byte_count, 9);
        assert_eq!(result.fidelity, ArtifactFidelityV1::HeadTailSample);
    }

    #[test]
    fn artifact_capture_preserves_head_tail_and_reports_exact_omission() {
        let mut capture = ArtifactCapture::new(8).unwrap();
        capture.push(b"12345678").unwrap();
        capture.push(b"9abc").unwrap();

        let result = capture.finish();
        assert_eq!(result.bytes, b"12349abc");
        assert_eq!(result.observed_byte_count, 12);
        assert_eq!(result.dropped_byte_count, 4);
        assert_eq!(result.fidelity, ArtifactFidelityV1::HeadTailSample);
    }

    #[test]
    fn artifact_capture_bounds_retained_bytes_for_large_streams() {
        const STORED_LIMIT: usize = 16 * 1024;
        const CHUNK: [u8; 64 * 1024] = [b'x'; 64 * 1024];
        let mut capture = ArtifactCapture::new(STORED_LIMIT).unwrap();
        for _ in 0..1600 {
            capture.push(&CHUNK).unwrap();
            assert!(capture.retained_byte_count() <= STORED_LIMIT);
        }

        let result = capture.finish();
        let observed = (CHUNK.len() * 1600) as u64;
        assert_eq!(result.bytes.len(), STORED_LIMIT);
        assert_eq!(result.observed_byte_count, observed);
        assert_eq!(result.dropped_byte_count, observed - STORED_LIMIT as u64);
        assert_eq!(result.fidelity, ArtifactFidelityV1::HeadTailSample);
    }

    #[test]
    fn captured_artifact_persists_sample_fidelity_and_exact_size_digest_and_drop_count() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let mut capture = ArtifactCapture::new(8).unwrap();
        capture.push(b"12345678").unwrap();
        capture.push(b"9abc").unwrap();

        let reference = store
            .put_capture(
                "sample-1".to_owned(),
                "text/plain".to_owned(),
                vec!["thread:1".to_owned()],
                ArtifactAccessV1::Workspace,
                "default".to_owned(),
                "2026-10-10T12:00:00.000Z".to_owned(),
                ArtifactEncryptionV1::None,
                ArtifactRedactionV1::NotNeeded,
                capture.finish(),
            )
            .unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();
        let metadata = store.metadata(&permit).unwrap();

        assert_eq!(reference.byte_length, "8");
        assert_eq!(
            reference.digest,
            format!("blake3:{}", Digest::from_blake3(b"12349abc").to_hex())
        );
        assert_eq!(metadata.fidelity, ArtifactFidelityV1::HeadTailSample);
        assert_eq!(metadata.dropped_byte_count, "4");
        let chunk = store
            .read(&permit, 0, NonZeroUsize::new(8).unwrap())
            .unwrap();
        assert_eq!(chunk.bytes, b"12349abc");
        assert!(chunk.complete);
    }

    #[test]
    fn metadata_rejects_inconsistent_full_and_sample_fidelity() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut full_with_drops = metadata(b"bytes", "5");
        full_with_drops.dropped_byte_count = "1".to_owned();
        assert_eq!(
            store.put(b"bytes", full_with_drops),
            Err(ArtifactError::InvalidMetadata)
        );

        let mut sample_without_drops = metadata(b"bytes", "5");
        sample_without_drops.fidelity = ArtifactFidelityV1::HeadTailSample;
        assert_eq!(
            store.put(b"bytes", sample_without_drops),
            Err(ArtifactError::InvalidMetadata)
        );
    }

    #[test]
    fn failed_artifacts_remain_explicit_in_durable_metadata() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let mut failed = metadata(b"", "0");
        failed.fidelity = ArtifactFidelityV1::Failed;
        failed.dropped_byte_count = "37".to_owned();
        let reference = store.put(b"", failed).unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();

        let metadata = store.metadata(&permit).unwrap();
        assert_eq!(metadata.fidelity, ArtifactFidelityV1::Failed);
        assert_eq!(metadata.dropped_byte_count, "37");
        assert_eq!(metadata.byte_length, "0");
    }

    #[test]
    fn put_rejects_a_declared_length_that_does_not_match_exact_bytes() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        assert_eq!(
            store.put(b"bytes", metadata(b"bytes", "6")),
            Err(ArtifactError::LengthMismatch)
        );
    }

    #[test]
    fn put_rejects_a_declared_digest_that_does_not_match_exact_bytes() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.digest = format!("blake3:{}", Digest::from_blake3(b"other").to_hex());
        assert_eq!(
            store.put(b"bytes", metadata),
            Err(ArtifactError::DigestMismatch)
        );
    }

    #[test]
    fn put_rejects_unknown_redaction_before_publishing_any_artifact() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"secret", "6");
        metadata.redaction = ArtifactRedactionV1::Unknown;
        assert_eq!(
            store.put(b"secret", metadata),
            Err(ArtifactError::InvalidMetadata)
        );
        assert_eq!(store.usage().unwrap(), ArtifactStoreUsageV1::default());
    }

    #[test]
    fn put_rejects_noncanonical_decimal_lengths() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        assert_eq!(
            store.put(b"bytes", metadata(b"bytes", "05")),
            Err(ArtifactError::InvalidMetadata)
        );
    }

    #[test]
    fn put_rejects_declared_artifact_lengths_above_256_mib_before_hashing() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.digest = format!("blake3:{}", Digest::from_blake3(b"other").to_hex());
        metadata.byte_length = (MAX_ARTIFACT_BYTES + 1).to_string();
        assert_eq!(store.put(b"bytes", metadata), Err(ArtifactError::TooLarge));
        assert_eq!(
            fs::read_dir(root.0.join(BLOB_DIRECTORY)).unwrap().count(),
            0
        );
    }

    #[test]
    fn put_rejects_sensitive_bytes_without_state_key_encryption() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.access = ArtifactAccessV1::Sensitive;
        assert_eq!(
            store.put(b"bytes", metadata),
            Err(ArtifactError::SensitiveEncryptionRequired)
        );
    }

    #[test]
    fn put_fails_closed_when_state_key_encryption_is_requested() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.encryption = ArtifactEncryptionV1::StateKey;
        assert_eq!(
            store.put(b"bytes", metadata),
            Err(ArtifactError::EncryptionUnavailable)
        );
    }

    #[test]
    fn put_rejects_invalid_rfc3339_utc_millisecond_timestamp() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.created_at = "2026-02-29T12:00:00.000Z".to_owned();
        assert_eq!(
            store.put(b"bytes", metadata),
            Err(ArtifactError::InvalidMetadata)
        );
    }

    #[test]
    fn put_accepts_the_rfc3339_leap_second() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.created_at = "2016-12-31T23:59:60.000Z".to_owned();
        assert!(store.put(b"bytes", metadata).is_ok());
    }

    #[test]
    fn put_rejects_leap_seconds_outside_the_end_of_a_utc_month() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.created_at = "2026-01-01T00:59:60.000Z".to_owned();
        assert_eq!(
            store.put(b"bytes", metadata),
            Err(ArtifactError::InvalidMetadata)
        );
    }

    #[test]
    fn put_rejects_duplicate_owner_references() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.owner_refs.push(metadata.owner_refs[0].clone());
        assert_eq!(
            store.put(b"bytes", metadata),
            Err(ArtifactError::InvalidMetadata)
        );
    }

    #[test]
    fn put_returns_the_exact_digest_length_media_type_and_access_class() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let artifact = store.put(b"bytes", metadata(b"bytes", "5")).unwrap();
        assert_eq!(artifact.artifact_id, "artifact-1");
        assert_eq!(
            artifact.digest,
            format!("blake3:{}", Digest::from_blake3(b"bytes").to_hex())
        );
        assert_eq!(artifact.byte_length, "5");
        assert_eq!(artifact.media_type, "application/octet-stream");
        assert_eq!(artifact.classification, ArtifactClassificationV1::Workspace);
    }

    #[test]
    fn legacy_artifact_metadata_is_read_as_complete_and_untruncated() {
        let metadata = metadata(b"bytes", "5");
        let bytes = serde_json::to_vec(&serde_json::json!({
            "access": access_name(metadata.access),
            "artifactId": metadata.artifact_id,
            "byteLength": metadata.byte_length,
            "createdAt": metadata.created_at,
            "digest": metadata.digest,
            "encryption": encryption_name(metadata.encryption),
            "format": LEGACY_ARTIFACT_METADATA_FORMAT,
            "mediaType": metadata.media_type,
            "ownerRefs": metadata.owner_refs,
            "redaction": redaction_name(metadata.redaction),
            "retentionClass": metadata.retention_class,
        }))
        .unwrap();

        let decoded = decode_metadata(&bytes).unwrap();
        assert_eq!(decoded.fidelity, ArtifactFidelityV1::Full);
        assert_eq!(decoded.dropped_byte_count, "0");
    }

    #[test]
    fn duplicate_identical_put_returns_the_same_reference() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let metadata = metadata(b"bytes", "5");
        let first = store.put(b"bytes", metadata.clone()).unwrap();
        let second = store.put(b"bytes", metadata).unwrap();
        assert_eq!(second, first);
    }

    #[test]
    fn conflicting_artifact_id_is_rejected_before_publishing_new_bytes() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        store.put(b"bytes", metadata(b"bytes", "5")).unwrap();
        let conflicting = metadata(b"other", "5");
        let conflicting_blob = blob_path(&root.0, &conflicting.digest).unwrap();

        assert_eq!(
            store.put(b"other", conflicting),
            Err(ArtifactError::MetadataConflict)
        );
        assert!(!conflicting_blob.exists());
    }

    #[cfg(unix)]
    #[test]
    fn put_refuses_to_overwrite_different_bytes_at_the_digest_path() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let metadata = metadata(b"bytes", "5");
        let hex = metadata.digest.strip_prefix("blake3:").unwrap();
        let shard = root.0.join("blobs").join(&hex[..2]);
        fs::create_dir_all(&shard).unwrap();
        fs::set_permissions(&shard, fs::Permissions::from_mode(0o700)).unwrap();
        let object = shard.join(&hex[2..]);
        fs::write(&object, b"other").unwrap();
        fs::set_permissions(&object, fs::Permissions::from_mode(0o400)).unwrap();
        assert_eq!(store.put(b"bytes", metadata), Err(ArtifactError::Collision));
        assert_eq!(fs::read(object).unwrap(), b"other");
    }

    #[test]
    fn authorized_reads_return_metadata_and_sequential_chunks() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let metadata = metadata(b"abcdef", "6");
        let reference = store.put(b"abcdef", metadata.clone()).unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();
        assert_eq!(store.metadata(&permit).unwrap(), metadata);

        let first = store
            .read(&permit, 0, NonZeroUsize::new(3).unwrap())
            .unwrap();
        assert_eq!(first.artifact_ref, reference);
        assert_eq!(first.offset, 0);
        assert_eq!(first.next_offset, 3);
        assert_eq!(first.bytes, b"abc");
        assert!(!first.complete);

        let second = store
            .read(&permit, 3, NonZeroUsize::new(3).unwrap())
            .unwrap();
        assert_eq!(second.offset, 3);
        assert_eq!(second.next_offset, 6);
        assert_eq!(second.bytes, b"def");
        assert!(second.complete);
    }

    #[test]
    fn verify_ref_returns_disk_metadata_after_digest_verified_bounded_read() {
        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let owner = ArtifactOwnerScopeV1::new("thread", "1").unwrap();
        let reference = ingress
            .capture_after_guard_authorization(
                &owner,
                "verify-1".to_owned(),
                ArtifactWriteMetadataV1 {
                    media_type: "text/plain".to_owned(),
                    access: ArtifactAccessV1::Workspace,
                    retention_class: "default".to_owned(),
                    created_at: "2026-10-10T12:00:00.000Z".to_owned(),
                    encryption: ArtifactEncryptionV1::None,
                    redaction: ArtifactRedactionV1::NotNeeded,
                },
                CapturedArtifactV1 {
                    bytes: b"verified bytes".to_vec(),
                    observed_byte_count: 14,
                    dropped_byte_count: 0,
                    fidelity: ArtifactFidelityV1::Full,
                },
            )
            .unwrap();

        let verified = ingress
            .verify_ref(
                &owner,
                "thread:1",
                &reference,
                NonZeroUsize::new(32).unwrap(),
            )
            .unwrap();

        assert_eq!(verified.artifact_id, reference.artifact_id);
        assert_eq!(verified.digest, reference.digest);
        assert_eq!(verified.byte_length, "14");
        assert_eq!(verified.owner_refs, vec!["thread:1"]);
    }

    #[test]
    fn verify_ref_rejects_a_tampered_digest_even_when_the_ref_is_authorized() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let owner = ArtifactOwnerScopeV1::new("thread", "1").unwrap();
        let reference = ingress
            .capture_after_guard_authorization(
                &owner,
                "verify-tampered".to_owned(),
                ArtifactWriteMetadataV1 {
                    media_type: "text/plain".to_owned(),
                    access: ArtifactAccessV1::Workspace,
                    retention_class: "default".to_owned(),
                    created_at: "2026-10-10T12:00:00.000Z".to_owned(),
                    encryption: ArtifactEncryptionV1::None,
                    redaction: ArtifactRedactionV1::NotNeeded,
                },
                CapturedArtifactV1 {
                    bytes: b"verified bytes".to_vec(),
                    observed_byte_count: 14,
                    dropped_byte_count: 0,
                    fidelity: ArtifactFidelityV1::Full,
                },
            )
            .unwrap();
        let original = blob_path(&root.0, &reference.digest).unwrap();
        fs::remove_file(&original).unwrap();
        fs::write(&original, b"tampered bytes").unwrap();
        fs::set_permissions(&original, fs::Permissions::from_mode(0o400)).unwrap();

        assert_eq!(
            ingress.verify_ref(
                &owner,
                "thread:1",
                &reference,
                NonZeroUsize::new(32).unwrap()
            ),
            Err(ArtifactError::CorruptObject)
        );
    }

    #[test]
    fn verify_ref_rejects_missing_artifacts_and_unowned_scope() {
        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let owner = ArtifactOwnerScopeV1::new("thread", "1").unwrap();
        let reference = ArtifactRefV1 {
            artifact_id: "missing".to_owned(),
            digest: format!("blake3:{}", Digest::from_blake3(b"missing").to_hex()),
            byte_length: "7".to_owned(),
            media_type: "application/octet-stream".to_owned(),
            classification: ArtifactClassificationV1::Workspace,
        };

        assert_eq!(
            ingress.verify_ref(
                &owner,
                "thread:1",
                &reference,
                NonZeroUsize::new(32).unwrap()
            ),
            Err(ArtifactError::NotFound)
        );

        let other_owner = ArtifactOwnerScopeV1::new("thread", "2").unwrap();
        assert_eq!(
            ingress.verify_ref(
                &other_owner,
                "thread:1",
                &reference,
                NonZeroUsize::new(32).unwrap()
            ),
            Err(ArtifactError::NotFound)
        );

        let owned_reference = ingress
            .capture_after_guard_authorization(
                &owner,
                "verify-owned".to_owned(),
                ArtifactWriteMetadataV1 {
                    media_type: "text/plain".to_owned(),
                    access: ArtifactAccessV1::Workspace,
                    retention_class: "default".to_owned(),
                    created_at: "2026-10-10T12:00:00.000Z".to_owned(),
                    encryption: ArtifactEncryptionV1::None,
                    redaction: ArtifactRedactionV1::NotNeeded,
                },
                CapturedArtifactV1 {
                    bytes: b"owned bytes".to_vec(),
                    observed_byte_count: 11,
                    dropped_byte_count: 0,
                    fidelity: ArtifactFidelityV1::Full,
                },
            )
            .unwrap();
        assert_eq!(
            ingress.verify_ref(
                &other_owner,
                "thread:1",
                &owned_reference,
                NonZeroUsize::new(32).unwrap()
            ),
            Err(ArtifactError::AuthorizationDenied)
        );
    }

    #[test]
    fn verify_ref_rejects_artifacts_above_the_explicit_read_bound() {
        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let owner = ArtifactOwnerScopeV1::new("thread", "1").unwrap();
        let reference = ingress
            .capture_after_guard_authorization(
                &owner,
                "verify-oversize".to_owned(),
                ArtifactWriteMetadataV1 {
                    media_type: "text/plain".to_owned(),
                    access: ArtifactAccessV1::Workspace,
                    retention_class: "default".to_owned(),
                    created_at: "2026-10-10T12:00:00.000Z".to_owned(),
                    encryption: ArtifactEncryptionV1::None,
                    redaction: ArtifactRedactionV1::NotNeeded,
                },
                CapturedArtifactV1 {
                    bytes: b"too many bytes".to_vec(),
                    observed_byte_count: 14,
                    dropped_byte_count: 0,
                    fidelity: ArtifactFidelityV1::Full,
                },
            )
            .unwrap();

        assert_eq!(
            ingress.verify_ref(
                &owner,
                "thread:1",
                &reference,
                NonZeroUsize::new(13).unwrap()
            ),
            Err(ArtifactError::TooLarge)
        );
    }

    #[cfg(unix)]
    #[test]
    fn metadata_read_rejects_a_replaced_shard_directory_symlink() {
        use std::os::unix::fs::symlink;

        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let reference = store.put(b"bytes", metadata(b"bytes", "5")).unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();
        let path = metadata_path(&root.0, &reference.artifact_id);
        let shard = path.parent().unwrap();
        let moved_shard = root.0.join("moved-metadata-shard");
        fs::rename(shard, &moved_shard).unwrap();
        symlink(&moved_shard, shard).unwrap();

        assert!(matches!(
            store.metadata(&permit),
            Err(ArtifactError::CorruptMetadata | ArtifactError::StoragePermissionsUnavailable)
        ));
    }

    #[cfg(unix)]
    #[test]
    fn sequential_chunks_stay_bound_to_the_digest_verified_object_after_path_swap() {
        use std::os::unix::fs::PermissionsExt;

        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let reference = store.put(b"abcdef", metadata(b"abcdef", "6")).unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();
        let first = store
            .read(&permit, 0, NonZeroUsize::new(3).unwrap())
            .unwrap();
        assert_eq!(first.bytes, b"abc");

        let original = blob_path(&root.0, &reference.digest).unwrap();
        let replacement = root.0.join("replacement-object");
        fs::write(&replacement, b"UVWXYZ").unwrap();
        fs::set_permissions(&replacement, fs::Permissions::from_mode(0o400)).unwrap();
        fs::remove_file(&original).unwrap();
        fs::rename(&replacement, &original).unwrap();

        let second = store
            .read(&permit, 3, NonZeroUsize::new(3).unwrap())
            .unwrap();
        assert_eq!(second.bytes, b"def");
        assert!(second.complete);
    }

    #[test]
    fn denied_authorization_never_produces_a_read_permit() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, DenyAll).unwrap();
        let mut metadata = metadata(b"bytes", "5");
        metadata.access = ArtifactAccessV1::Public;
        let reference = store.put(b"bytes", metadata).unwrap();
        assert!(matches!(
            store.authorize_read("thread:1", &reference),
            Err(ArtifactError::AuthorizationDenied)
        ));
    }

    #[test]
    fn read_rejects_offsets_that_skip_the_next_sequential_chunk() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let reference = store.put(b"abcdef", metadata(b"abcdef", "6")).unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();
        assert!(matches!(
            store.read(&permit, 1, NonZeroUsize::new(3).unwrap()),
            Err(ArtifactError::InvalidOffset)
        ));
    }

    #[test]
    fn read_permits_are_bound_to_the_store_that_issued_them() {
        let root = TempRoot::new();
        let first_store = ArtifactStore::open(&root.0, Allow).unwrap();
        let reference = first_store.put(b"bytes", metadata(b"bytes", "5")).unwrap();
        let permit = first_store.authorize_read("thread:1", &reference).unwrap();
        let second_store = ArtifactStore::open(&root.0, Allow).unwrap();
        assert!(matches!(
            second_store.read(&permit, 0, NonZeroUsize::new(3).unwrap()),
            Err(ArtifactError::InvalidPermit)
        ));
    }

    #[test]
    fn caller_cannot_raise_the_maximum_chunk_size() {
        let root = TempRoot::new();
        let store = ArtifactStore::open(&root.0, Allow).unwrap();
        let bytes = vec![b'x'; MAX_ARTIFACT_CHUNK_BYTES + 128];
        let reference = store
            .put(&bytes, metadata(&bytes, &bytes.len().to_string()))
            .unwrap();
        let permit = store.authorize_read("thread:1", &reference).unwrap();
        let chunk = store
            .read(&permit, 0, NonZeroUsize::new(usize::MAX).unwrap())
            .unwrap();
        assert_eq!(chunk.bytes.len(), MAX_ARTIFACT_CHUNK_BYTES);
        assert_eq!(chunk.next_offset, MAX_ARTIFACT_CHUNK_BYTES as u64);
        assert!(!chunk.complete);
    }

    #[test]
    fn ingress_range_reads_accept_fresh_permits_at_exact_prior_offsets() {
        let root = TempRoot::new();
        let owner = ArtifactOwnerScopeV1::new("session", "ses_artifact").unwrap();
        let bytes = vec![b'r'; MAX_ARTIFACT_CHUNK_BYTES + 128];
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let reference = ingress
            .capture_after_guard_authorization(
                &owner,
                "artifact-range".to_owned(),
                write_metadata(),
                capture(&bytes),
            )
            .unwrap();

        let first = ingress
            .read_range(
                "ses_artifact",
                &reference,
                0,
                NonZeroUsize::new(usize::MAX).unwrap(),
            )
            .unwrap();
        assert_eq!(first.offset, 0);
        assert_eq!(first.bytes.len(), MAX_ARTIFACT_CHUNK_BYTES);
        assert!(!first.complete);

        // This is a separate authorization/permit, as it is for each HostKernel
        // RPC. Its offset must be validated against the immutable object, not a
        // cursor stored in the previous RPC's permit.
        let second = ingress
            .read_range(
                "ses_artifact",
                &reference,
                first.next_offset,
                NonZeroUsize::new(usize::MAX).unwrap(),
            )
            .unwrap();
        assert_eq!(second.offset, first.next_offset);
        assert_eq!(second.bytes, vec![b'r'; 128]);
        assert!(second.complete);
    }

    #[test]
    fn retry_syncs_an_existing_entry_after_an_uncertain_publish() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::AtomicUsize;

        let root = TempRoot::new();
        let directory = root.0.join("publish");
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let destination = directory.join("object");
        let sync_attempts = AtomicUsize::new(0);

        let first = publish_no_clobber_with(
            &directory,
            &destination,
            b"payload",
            ArtifactError::Collision,
            |path| {
                if sync_attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                    Err(io::Error::other("injected directory-sync failure"))
                } else {
                    sync_directory(path)
                }
            },
            |source, target| fs::hard_link(source, target),
        );
        assert_eq!(first, Err(ArtifactError::PublicationUncertain));
        assert_eq!(fs::read(&destination).unwrap(), b"payload");

        let retry_syncs = AtomicUsize::new(0);
        let retry = publish_no_clobber_with(
            &directory,
            &destination,
            b"payload",
            ArtifactError::Collision,
            |path| {
                retry_syncs.fetch_add(1, Ordering::SeqCst);
                sync_directory(path)
            },
            |source, target| fs::hard_link(source, target),
        );
        assert_eq!(retry, Ok(()));
        assert_eq!(retry_syncs.load(Ordering::SeqCst), 1);
    }

    #[cfg(unix)]
    #[test]
    fn already_exists_publication_race_syncs_the_matching_winner() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::AtomicUsize;

        let root = TempRoot::new();
        let directory = root.0.join("publish");
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let destination = directory.join("object");
        let sync_attempts = AtomicUsize::new(0);

        let result = publish_no_clobber_with(
            &directory,
            &destination,
            b"payload",
            ArtifactError::Collision,
            |path| {
                sync_attempts.fetch_add(1, Ordering::SeqCst);
                sync_directory(path)
            },
            |_source, target| {
                let mut options = private_open_options();
                let mut winner = options.write(true).create_new(true).open(target)?;
                winner.write_all(b"payload")?;
                winner.sync_all()?;
                set_read_only(&winner)
                    .map_err(|_| io::Error::other("set winner read-only failed"))?;
                winner.sync_all()?;
                Err(io::Error::new(
                    io::ErrorKind::AlreadyExists,
                    "injected concurrent publisher",
                ))
            },
        );

        assert_eq!(result, Ok(()));
        assert_eq!(sync_attempts.load(Ordering::SeqCst), 2);
        assert_eq!(fs::read(destination).unwrap(), b"payload");
    }

    #[test]
    fn cleanup_sync_failure_reports_that_the_destination_was_published() {
        use std::os::unix::fs::PermissionsExt;
        use std::sync::atomic::AtomicUsize;

        let root = TempRoot::new();
        let directory = root.0.join("publish");
        fs::create_dir_all(&directory).unwrap();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let destination = directory.join("object");
        let sync_attempts = AtomicUsize::new(0);

        let result = publish_no_clobber_with(
            &directory,
            &destination,
            b"payload",
            ArtifactError::Collision,
            |path| {
                if sync_attempts.fetch_add(1, Ordering::SeqCst) == 1 {
                    Err(io::Error::other("injected cleanup sync failure"))
                } else {
                    sync_directory(path)
                }
            },
            |source, target| fs::hard_link(source, target),
        );

        assert_eq!(result, Err(ArtifactError::PublishedCleanupFailed));
        assert_eq!(fs::read(destination).unwrap(), b"payload");
    }

    // ---- Guard-mediated ingress ----

    const EFFECT_ARGUMENT_DIGEST: &str =
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const EFFECT_TURN_DIGEST: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const EFFECT_WORKSPACE_BINDING: &str =
        "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const EFFECT_GUARANTEES: &[&str] = &[
        "beneath_workspace_root",
        "no_symlink",
        "no_hardlink",
        "one_use",
    ];

    fn effect_request<'a>(
        root: &'a std::path::Path,
        target: &'a std::path::Path,
        resource: &'a str,
        action: ArtifactEffectActionV1,
        policies: &'a [&'a str],
        guarantees: &'a [&'a str],
    ) -> ArtifactEffectRequestV1<'a> {
        ArtifactEffectRequestV1 {
            action,
            principal: "ses_artifact",
            request_id: "batch_artifact",
            origin: EffectOriginV1 {
                kind: EffectOriginKindV1::SessionBatch,
                session_id: "ses_artifact",
                batch_id: "batch_artifact",
                call_id: "call_artifact",
                scope_digest: None,
            },
            argument_digest: EFFECT_ARGUMENT_DIGEST,
            turn_context_digest: EFFECT_TURN_DIGEST,
            workspace_root: root,
            workspace_binding: EFFECT_WORKSPACE_BINDING,
            target,
            resource,
            policy_snapshot_ids: policies,
            requested_guarantees: guarantees,
        }
    }

    fn write_metadata() -> ArtifactWriteMetadataV1 {
        ArtifactWriteMetadataV1 {
            media_type: "text/plain".to_owned(),
            access: ArtifactAccessV1::Workspace,
            retention_class: "default".to_owned(),
            created_at: "2026-10-10T12:00:00.000Z".to_owned(),
            encryption: ArtifactEncryptionV1::None,
            redaction: ArtifactRedactionV1::NotNeeded,
        }
    }

    fn capture(bytes: &[u8]) -> CapturedArtifactV1 {
        CapturedArtifactV1 {
            bytes: bytes.to_vec(),
            observed_byte_count: bytes.len() as u64,
            dropped_byte_count: 0,
            fidelity: ArtifactFidelityV1::Full,
        }
    }

    #[test]
    fn artifact_reads_are_permit_scoped_and_effects_compose_canonical_guard_actions() {
        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let policies = [crate::guard::WORKSPACE_WRITE_POLICY_ID];

        // Read capabilities keep their catalog IDs and are authorized by bounded
        // artifact-store permits, never by an approval mutation action.
        assert_eq!(ARTIFACTS_LIST_ID, "artifacts.list");
        assert_eq!(ARTIFACTS_INSPECT_ID, "artifacts.inspect");
        assert_eq!(ARTIFACTS_READ_RANGE_ID, "artifacts.read_range");
        assert_eq!(ARTIFACTS_EXPORT_ID, "artifacts.export");

        // Capture has its own canonical action id and is still unsupported.
        let capture = effect_request(
            &root.0,
            &root.0,
            ".",
            ArtifactEffectActionV1::Capture,
            &policies,
            EFFECT_GUARANTEES,
        );
        assert_eq!(
            ArtifactEffectActionV1::Capture.guard_action_id(),
            ARTIFACTS_CAPTURE_ID
        );
        assert_eq!(
            ingress.guard_request(&capture).action_id,
            ARTIFACTS_CAPTURE_ID
        );
        let capture_decision = guard::authorize(&ingress.guard_request(&capture), "batch_artifact");
        assert_eq!(capture_decision.decision, DecisionKind::Deny);
        assert_eq!(capture_decision.reason_code, Some("unsupported_action"));

        // Export composes the existing files.write Guard path over its destination.
        let destination = root.0.join("export.txt");
        let export = effect_request(
            &root.0,
            &destination,
            "export.txt",
            ArtifactEffectActionV1::Export,
            &policies,
            EFFECT_GUARANTEES,
        );
        assert_eq!(
            ArtifactEffectActionV1::Export.guard_action_id(),
            crate::guard::FILES_WRITE_ID
        );
        let request = ingress.guard_request(&export);
        assert_eq!(request.action_id, crate::guard::FILES_WRITE_ID);
        assert_eq!(request.resource_resolution.target, destination);
        assert_eq!(request.resource_resolution.resource, "export.txt");
        let decision = guard::authorize(&request, "batch_artifact");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);
    }

    #[test]
    fn capture_guarded_is_unavailable_and_never_touches_the_store() {
        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let policies = [crate::guard::WORKSPACE_WRITE_POLICY_ID];
        let request = effect_request(
            &root.0,
            &root.0,
            ".",
            ArtifactEffectActionV1::Capture,
            &policies,
            EFFECT_GUARANTEES,
        );
        let decision = guard::authorize(&ingress.guard_request(&request), "batch_artifact");
        let grant = ArtifactEffectGrantV1 {
            lease_id: "lease_1".to_owned(),
            receipt_digest:
                "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned(),
        };
        let owner = ArtifactOwnerScopeV1::new("session", "ses_artifact").unwrap();

        assert!(!ARTIFACT_EFFECTS_ENABLED);
        assert_eq!(
            ingress.capture_guarded(
                &request,
                &decision,
                &grant,
                &owner,
                "artifact-1".to_owned(),
                write_metadata(),
                capture(b"denied"),
            ),
            Err(ArtifactError::EffectUnavailable)
        );
        // No metadata entry was published by the unavailable effect.
        assert!(
            ingress
                .list("ses_artifact", NonZeroUsize::new(16).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn forged_or_mismatched_guard_decisions_are_rejected() {
        let root = TempRoot::new();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let policies = [crate::guard::WORKSPACE_WRITE_POLICY_ID];
        let request = effect_request(
            &root.0,
            &root.0,
            ".",
            ArtifactEffectActionV1::Capture,
            &policies,
            EFFECT_GUARANTEES,
        );
        let owner = ArtifactOwnerScopeV1::new("session", "ses_artifact").unwrap();
        let forged = GuardDecisionV1 {
            decision_id: "batch_artifact".to_owned(),
            decision: DecisionKind::Ask,
            policy_digest: "blake3:policy".to_owned(),
            resource_digest: "blake3:resource".to_owned(),
            normalized_action: ARTIFACTS_CAPTURE_ID.to_owned(),
            reason_code: None,
        };
        assert!(matches!(
            ingress.authorize_effect(&request, &forged),
            Err(ArtifactError::GuardDenied { .. })
        ));

        // A real decision for a different artifact action cannot authorize capture.
        let destination = root.0.join("export.txt");
        let export = effect_request(
            &root.0,
            &destination,
            "export.txt",
            ArtifactEffectActionV1::Export,
            &policies,
            EFFECT_GUARANTEES,
        );
        let export_decision = guard::authorize(&ingress.guard_request(&export), "batch_artifact");
        assert!(matches!(
            ingress.authorize_effect(&request, &export_decision),
            Err(ArtifactError::GuardDenied { .. })
        ));

        // The production entry point stays unavailable regardless.
        let grant = ArtifactEffectGrantV1 {
            lease_id: "lease_1".to_owned(),
            receipt_digest:
                "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned(),
        };
        assert_eq!(
            ingress.capture_guarded(
                &request,
                &forged,
                &grant,
                &owner,
                "artifact-1".to_owned(),
                write_metadata(),
                capture(b"forged"),
            ),
            Err(ArtifactError::EffectUnavailable)
        );
        assert!(
            ingress
                .list("ses_artifact", NonZeroUsize::new(16).unwrap())
                .unwrap()
                .is_empty()
        );
    }

    #[test]
    fn effect_grants_are_validated_before_any_publish() {
        let valid = ArtifactEffectGrantV1 {
            lease_id: "lease_1".to_owned(),
            receipt_digest:
                "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned(),
        };
        assert_eq!(valid.validate(), Ok(()));

        for invalid in [
            ArtifactEffectGrantV1 {
                lease_id: String::new(),
                receipt_digest: valid.receipt_digest.clone(),
            },
            ArtifactEffectGrantV1 {
                lease_id: "lease_1".to_owned(),
                receipt_digest: "sha256:dddd".to_owned(),
            },
            ArtifactEffectGrantV1 {
                lease_id: "lease_1".to_owned(),
                receipt_digest: "blake3:DDDD".to_owned(),
            },
        ] {
            assert_eq!(invalid.validate(), Err(ArtifactError::InvalidEffectGrant));
        }
    }

    #[test]
    fn ingress_reads_require_authorization_and_bind_the_derived_owner_scope() {
        let root = TempRoot::new();
        let owner = ArtifactOwnerScopeV1::new("session", "ses_artifact").unwrap();
        let bytes = b"artifact body";
        let allow = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let artifact_ref = allow
            .capture_after_guard_authorization(
                &owner,
                "artifact-1".to_owned(),
                write_metadata(),
                capture(bytes),
            )
            .unwrap();
        assert_eq!(
            artifact_ref.digest,
            format!("blake3:{}", Digest::from_blake3(bytes).to_hex())
        );

        // Owner refs are derived from the authenticated scope, not caller metadata.
        let metadata = allow.inspect("ses_artifact", &artifact_ref).unwrap();
        assert_eq!(metadata.owner_refs, vec!["session:ses_artifact".to_owned()]);
        assert_eq!(metadata.digest, artifact_ref.digest);

        let chunk = allow
            .read_range(
                "ses_artifact",
                &artifact_ref,
                0,
                NonZeroUsize::new(64).unwrap(),
            )
            .unwrap();
        assert_eq!(chunk.bytes, bytes);
        assert!(chunk.complete);

        let denied = GuardedArtifactIngressV1::open(&root.0, DenyAll).unwrap();
        assert_eq!(
            denied.inspect("ses_artifact", &artifact_ref),
            Err(ArtifactError::AuthorizationDenied)
        );
        assert!(matches!(
            denied.read_range(
                "ses_artifact",
                &artifact_ref,
                0,
                NonZeroUsize::new(64).unwrap()
            ),
            Err(ArtifactError::AuthorizationDenied)
        ));
        assert_eq!(
            denied.list("ses_artifact", NonZeroUsize::new(16).unwrap()),
            Err(ArtifactError::AuthorizationDenied)
        );
    }

    #[test]
    fn ingress_list_is_bounded_and_reports_overflow_instead_of_omitting_artifacts() {
        let root = TempRoot::new();
        let owner = ArtifactOwnerScopeV1::new("session", "ses_artifact").unwrap();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        for (id, body) in [("artifact-1", b"one".as_slice()), ("artifact-2", b"two")] {
            ingress
                .capture_after_guard_authorization(
                    &owner,
                    id.to_owned(),
                    write_metadata(),
                    capture(body),
                )
                .unwrap();
        }

        let listed = ingress
            .list("ses_artifact", NonZeroUsize::new(16).unwrap())
            .unwrap();
        assert_eq!(listed.len(), 2);
        assert_eq!(
            ingress.list("ses_artifact", NonZeroUsize::new(1).unwrap()),
            Err(ArtifactError::TooLarge)
        );
    }

    #[test]
    fn export_guarded_is_unavailable_and_the_post_guard_copy_is_owner_bound() {
        let root = TempRoot::new();
        let owner = ArtifactOwnerScopeV1::new("session", "ses_artifact").unwrap();
        let ingress = GuardedArtifactIngressV1::open(&root.0, Allow).unwrap();
        let artifact_ref = ingress
            .capture_after_guard_authorization(
                &owner,
                "artifact-1".to_owned(),
                write_metadata(),
                capture(b"secret"),
            )
            .unwrap();
        let policies = [crate::guard::WORKSPACE_WRITE_POLICY_ID];
        let destination = root.0.join("export.txt");
        let request = effect_request(
            &root.0,
            &destination,
            "export.txt",
            ArtifactEffectActionV1::Export,
            &policies,
            EFFECT_GUARANTEES,
        );
        let decision = guard::authorize(&ingress.guard_request(&request), "batch_artifact");
        assert_eq!(decision.decision, DecisionKind::Ask);
        let grant = ArtifactEffectGrantV1 {
            lease_id: "lease_1".to_owned(),
            receipt_digest:
                "blake3:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd".to_owned(),
        };

        assert_eq!(
            ingress.export_guarded(
                &request,
                &decision,
                &grant,
                &owner,
                "ses_artifact",
                &artifact_ref,
                NonZeroUsize::new(1_024).unwrap(),
            ),
            Err(ArtifactError::EffectUnavailable)
        );

        // The post-guard copy path is used by the guarded entry point once the
        // P1 lease/receipt boundary exists; it still enforces owner binding.
        assert_eq!(
            ingress
                .export_after_guard_authorization(
                    &owner,
                    "ses_artifact",
                    &artifact_ref,
                    NonZeroUsize::new(1_024).unwrap()
                )
                .unwrap(),
            b"secret"
        );
        let other_owner = ArtifactOwnerScopeV1::new("session", "ses_other").unwrap();
        assert_eq!(
            ingress.export_after_guard_authorization(
                &other_owner,
                "ses_artifact",
                &artifact_ref,
                NonZeroUsize::new(1_024).unwrap(),
            ),
            Err(ArtifactError::AuthorizationDenied)
        );
    }
}
