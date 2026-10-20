//! In-memory staging primitives for transferring a bounded generation pack in
//! small pieces.
//!
//! This module has no I/O, persistence, authentication, workspace lookup, or
//! authorization. The trusted HostKernel caller creates cryptographically random
//! upload tokens and binds them to its authenticated principal, owner epoch,
//! workspace and read scope. [`GenerationUploadId::from_host_token`] validates
//! only token length; possession of an ID is not evidence of trust. Dropping or
//! clearing a store discards every partial upload, which is the only restart
//! behavior this library can establish.

use crate::{BaseGeneration, GenerationPack, IndexError, DEFAULT_MAX_PACK_BYTES};
use std::collections::BTreeMap;
use std::fmt;

/// Maximum bytes accepted by one append call (smaller than the 6 MiB HostKernel
/// request body limit to leave room for request framing).
pub const MAX_UPLOAD_CHUNK_BYTES: usize = 512 * 1024;

/// Maximum lifetime for a staged pack. `now_ms` is a monotonic tick supplied by
/// the host; wall-clock timestamps must not be passed here.
pub const MAX_UPLOAD_TTL_MS: u64 = 60_000;

/// Simultaneous upload slots per in-memory store.
pub const MAX_STAGED_UPLOADS: usize = 2;

/// Aggregate declared-byte reservation per store. The existing generation pack
/// cap is also the aggregate cap, so a full-sized generation occupies the only
/// byte budget until it is committed, aborted or expired.
pub const MAX_STAGED_BYTES: usize = DEFAULT_MAX_PACK_BYTES;

const UPLOAD_DIGEST_DOMAIN: &[u8] = b"horizon.indexd.staged-pack.v1\0";
const MIN_UPLOAD_ID_BYTES: usize = 16;
const MAX_UPLOAD_ID_BYTES: usize = 64;

/// Opaque token supplied by the trusted HostKernel owner.
#[derive(Clone, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct GenerationUploadId(Vec<u8>);

impl GenerationUploadId {
    /// Wrap a host-generated token. This checks only size; the caller must
    /// generate an unpredictable token and bind it to authenticated scope.
    pub fn from_host_token(token: &[u8]) -> Result<Self, GenerationUploadError> {
        if !(MIN_UPLOAD_ID_BYTES..=MAX_UPLOAD_ID_BYTES).contains(&token.len()) {
            return Err(GenerationUploadError::InvalidUploadId);
        }
        Ok(Self(token.to_vec()))
    }
}

impl fmt::Debug for GenerationUploadId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("GenerationUploadId")
            .field("byte_len", &self.0.len())
            .finish_non_exhaustive()
    }
}

/// Digest of the complete encoded pack, including its GenerationPack checksum.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub struct PackDigest([u8; 32]);

impl PackDigest {
    pub fn of_bytes(bytes: &[u8]) -> Self {
        let mut hasher = blake3::Hasher::new();
        hasher.update(UPLOAD_DIGEST_DOMAIN);
        hasher.update(bytes);
        Self(*hasher.finalize().as_bytes())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum GenerationUploadError {
    InvalidUploadId,
    DuplicateUpload,
    UnknownUpload,
    TooManyUploads { limit: usize },
    TotalTooLarge { limit: usize },
    StagingBudgetExceeded { limit: usize },
    EmptyChunk,
    ChunkTooLarge { limit: usize },
    OffsetMismatch { expected: usize, actual: usize },
    ChunkExceedsTotal,
    Incomplete { expected: usize, actual: usize },
    DigestMismatch,
    Expired,
    InvalidPack(IndexError),
    AllocationFailed,
    DeadlineOverflow,
}

impl fmt::Display for GenerationUploadError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidUploadId => write!(formatter, "host upload token must be 16..=64 bytes"),
            Self::DuplicateUpload => write!(formatter, "upload token is already in use"),
            Self::UnknownUpload => write!(formatter, "upload token is unknown"),
            Self::TooManyUploads { limit } => write!(formatter, "upload count exceeds {limit}"),
            Self::TotalTooLarge { limit } => {
                write!(formatter, "declared pack exceeds {limit} bytes")
            }
            Self::StagingBudgetExceeded { limit } => {
                write!(formatter, "staged byte reservation exceeds {limit} bytes")
            }
            Self::EmptyChunk => write!(formatter, "upload chunk must not be empty"),
            Self::ChunkTooLarge { limit } => {
                write!(formatter, "upload chunk exceeds {limit} bytes")
            }
            Self::OffsetMismatch { expected, actual } => {
                write!(
                    formatter,
                    "upload offset {actual} does not match expected {expected}"
                )
            }
            Self::ChunkExceedsTotal => write!(formatter, "upload chunk exceeds declared total"),
            Self::Incomplete { expected, actual } => {
                write!(formatter, "upload has {actual} of {expected} bytes")
            }
            Self::DigestMismatch => write!(formatter, "staged pack digest does not match"),
            Self::Expired => write!(formatter, "staged upload has expired"),
            Self::InvalidPack(error) => {
                write!(formatter, "staged generation pack is invalid: {error}")
            }
            Self::AllocationFailed => {
                write!(formatter, "unable to reserve bounded upload chunk bytes")
            }
            Self::DeadlineOverflow => write!(formatter, "upload expiry tick overflowed"),
        }
    }
}

impl std::error::Error for GenerationUploadError {}

struct StagedUpload {
    expected_len: usize,
    expected_digest: PackDigest,
    expires_at_ms: u64,
    bytes: Vec<u8>,
}

/// Bounded, ephemeral store for partial generation pack bytes.
#[derive(Default)]
pub struct GenerationUploadStore {
    uploads: BTreeMap<GenerationUploadId, StagedUpload>,
}

impl GenerationUploadStore {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn upload_count(&self) -> usize {
        self.uploads.len()
    }

    /// Logical reservation count; actual memory grows only as chunks arrive.
    pub fn reserved_bytes(&self) -> usize {
        self.uploads
            .values()
            .map(|upload| upload.expected_len)
            .sum()
    }

    /// Start an upload using the store's fixed maximum TTL.
    pub fn begin(
        &mut self,
        id: GenerationUploadId,
        total_len: usize,
        expected_digest: PackDigest,
        now_ms: u64,
    ) -> Result<(), GenerationUploadError> {
        self.expire(now_ms);
        if self.uploads.contains_key(&id) {
            return Err(GenerationUploadError::DuplicateUpload);
        }
        if self.uploads.len() >= MAX_STAGED_UPLOADS {
            return Err(GenerationUploadError::TooManyUploads {
                limit: MAX_STAGED_UPLOADS,
            });
        }
        if total_len == 0 || total_len > DEFAULT_MAX_PACK_BYTES {
            return Err(GenerationUploadError::TotalTooLarge {
                limit: DEFAULT_MAX_PACK_BYTES,
            });
        }
        let reserved = self.reserved_bytes();
        if reserved
            .checked_add(total_len)
            .filter(|total| *total <= MAX_STAGED_BYTES)
            .is_none()
        {
            return Err(GenerationUploadError::StagingBudgetExceeded {
                limit: MAX_STAGED_BYTES,
            });
        }
        let expires_at_ms = now_ms
            .checked_add(MAX_UPLOAD_TTL_MS)
            .ok_or(GenerationUploadError::DeadlineOverflow)?;
        self.uploads.insert(
            id,
            StagedUpload {
                expected_len: total_len,
                expected_digest,
                expires_at_ms,
                bytes: Vec::new(),
            },
        );
        Ok(())
    }

    /// Append exactly the next contiguous piece. Rejected calls do not advance
    /// the offset or mutate staged bytes.
    pub fn append(
        &mut self,
        id: &GenerationUploadId,
        offset: usize,
        chunk: &[u8],
        now_ms: u64,
    ) -> Result<(), GenerationUploadError> {
        if self.expire_one(id, now_ms) {
            return Err(GenerationUploadError::Expired);
        }
        let upload = self
            .uploads
            .get_mut(id)
            .ok_or(GenerationUploadError::UnknownUpload)?;
        if chunk.is_empty() {
            return Err(GenerationUploadError::EmptyChunk);
        }
        if chunk.len() > MAX_UPLOAD_CHUNK_BYTES {
            return Err(GenerationUploadError::ChunkTooLarge {
                limit: MAX_UPLOAD_CHUNK_BYTES,
            });
        }
        if offset != upload.bytes.len() {
            return Err(GenerationUploadError::OffsetMismatch {
                expected: upload.bytes.len(),
                actual: offset,
            });
        }
        let end = upload
            .bytes
            .len()
            .checked_add(chunk.len())
            .filter(|end| *end <= upload.expected_len)
            .ok_or(GenerationUploadError::ChunkExceedsTotal)?;
        upload
            .bytes
            .try_reserve_exact(end.saturating_sub(upload.bytes.len()))
            .map_err(|_| GenerationUploadError::AllocationFailed)?;
        upload.bytes.extend_from_slice(chunk);
        Ok(())
    }

    /// Validate and consume a complete staged pack.
    pub fn commit(
        &mut self,
        id: &GenerationUploadId,
        now_ms: u64,
    ) -> Result<BaseGeneration, GenerationUploadError> {
        if self.expire_one(id, now_ms) {
            return Err(GenerationUploadError::Expired);
        }
        let upload = self
            .uploads
            .get(id)
            .ok_or(GenerationUploadError::UnknownUpload)?;
        if upload.bytes.len() != upload.expected_len {
            return Err(GenerationUploadError::Incomplete {
                expected: upload.expected_len,
                actual: upload.bytes.len(),
            });
        }

        let upload = self.uploads.remove(id).expect("upload was checked above");
        if PackDigest::of_bytes(&upload.bytes) != upload.expected_digest {
            return Err(GenerationUploadError::DigestMismatch);
        }
        GenerationPack::decode(&upload.bytes).map_err(GenerationUploadError::InvalidPack)
    }

    /// Explicitly discard an upload (used by host abort, cancellation and
    /// authenticated disconnect cleanup).
    pub fn abort(&mut self, id: &GenerationUploadId) -> Result<(), GenerationUploadError> {
        self.uploads
            .remove(id)
            .map(|_| ())
            .ok_or(GenerationUploadError::UnknownUpload)
    }

    /// Remove all uploads whose monotonic deadline has passed.
    pub fn expire(&mut self, now_ms: u64) -> usize {
        let before = self.uploads.len();
        self.uploads
            .retain(|_, upload| now_ms < upload.expires_at_ms);
        before - self.uploads.len()
    }

    /// Expire one ID before an operation, distinguishing expiry from an unknown
    /// token while keeping the API deterministic for host-supplied monotonic time.
    fn expire_one(&mut self, id: &GenerationUploadId, now_ms: u64) -> bool {
        let expired = self
            .uploads
            .get(id)
            .is_some_and(|upload| now_ms >= upload.expires_at_ms);
        if expired {
            self.uploads.remove(id);
        }
        expired
    }

    /// Model an owner restart by discarding all ephemeral staging state.
    pub fn clear_for_restart(&mut self) {
        self.uploads.clear();
    }
}
