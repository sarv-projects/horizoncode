//! Bounded, content-addressed artifact storage (`ARCH/28-ARTIFACT-STORE.md`,
//! `DEC-053`, `DEC-058`).
//!
//! This crate owns the bytes for payloads that must not sit inline in an event:
//! images and media, large tool output, partial model attempts, retained
//! evidence. It owns byte admission, per-namespace content-addressed storage,
//! digest verification, quota enforcement, and typed unavailable states. It
//! does **not** own session/run truth, permissions, or the audit chain: the
//! canonical event stores remain authoritative for *why* an artifact exists and
//! which owner references it.
//!
//! ## Guarantees this slice implements
//!
//! - **Bounded while streaming.** Bytes are hashed and capped as they pass
//!   through; a payload larger than the object or namespace ceiling is refused
//!   before it is buffered or published, never truncated into a plausible
//!   smaller object.
//! - **Exclusive, owner-only staging.** A staged object is created exclusively
//!   inside its namespace, is never opened through a symlink, and is published
//!   under its digest only after it is flushed; a digest path that already
//!   exists is re-verified, never blindly replaced.
//! - **Durable before reference.** The caller receives the reference only after
//!   the object is durable; the event that references it is then appended by the
//!   caller, so a crash can leave an orphan but never a committed reference to
//!   unverified bytes (`ARCH/28` §Write and bind).
//! - **Idempotent by operation.** Repeating a write with the same operation id
//!   and bytes returns the original reference; the same operation id with
//!   different bytes is a typed conflict (`ARCH/28` §Write and bind).
//! - **Verified on read.** A read checks digest and length before returning
//!   bytes; missing, corrupt, or over-limit content is a typed result, never an
//!   empty payload.
//!
//! ## Not implemented in this slice
//!
//! Decoders and media limits beyond the encoded bytes (`max_decoded_bytes`,
//! pixels and expansion ratio are carried but not exercised: decoding work
//! belongs to the consuming feature), reference leases and the owner graph,
//! garbage collection, export/import, and the physical control reserve. Those
//! are `AX-348`'s remaining work and are named in `TODO.md`.

#![forbid(unsafe_code)]

use std::collections::BTreeMap;
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use horizoncode_config::{ArtifactLimits, OwnerOnly};
use serde::{Deserialize, Serialize};

/// The schema version of a stored reference.
pub const REFERENCE_SCHEMA_VERSION: u32 = 1;

/// The directory holding published objects, by algorithm and digest.
pub const BLOBS_DIR: &str = "blobs";

/// The hash directory name for published objects (`DEC-059`).
pub const HASH_DIR: &str = "blake3";

/// The staging directory name.
pub const STAGING_DIR: &str = "staging";

/// The namespace quota file name.
pub const QUOTA_FILE: &str = "quota.json";

/// The writer lock file name.
pub const LOCK_FILE: &str = "lock";

/// Which store a namespace belongs to.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum NamespaceKind {
    /// A session's artifacts, inside its portable package.
    Session,
    /// A run's artifacts, below its run namespace.
    Run,
}

impl NamespaceKind {
    /// Returns the stable wire name and directory name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Run => "run",
        }
    }
}

/// A namespace identity: one session's or one run's artifact partition.
///
/// There is deliberately no cross-namespace deduplication in v1: sharing bytes
/// would share deletion, retention, privacy, and accounting domains
/// (`ARCH/28` §HLD boundaries).
#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub struct NamespaceId {
    /// Which kind of store owns it.
    pub kind: NamespaceKind,
    /// The owning session or run id.
    pub id: String,
}

impl NamespaceId {
    /// A session namespace.
    #[must_use]
    pub fn session(id: impl Into<String>) -> Self {
        Self {
            kind: NamespaceKind::Session,
            id: id.into(),
        }
    }

    /// A run namespace.
    #[must_use]
    pub fn run(id: impl Into<String>) -> Self {
        Self {
            kind: NamespaceKind::Run,
            id: id.into(),
        }
    }

    /// The namespace's directory name under the store root.
    fn key(&self) -> String {
        format!("{}/{}", self.kind.as_str(), self.id)
    }
}

/// A compact reference to a published object, as a session event carries it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct BlobRef {
    /// Immutable id assigned when the object was first published.
    pub blob_id: String,
    /// `blake3` over the stored bytes (`DEC-059`).
    pub digest: String,
    /// The sniffed media type.
    pub media_type: String,
    /// The exact stored byte length.
    pub encoded_bytes: u64,
    /// The reference schema version.
    pub schema_version: u32,
}

/// Metadata about a published object, without bytes.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactStat {
    /// The reference.
    pub reference: BlobRef,
    /// The file's length on disk, which must equal `encoded_bytes`.
    pub stored_bytes: u64,
}

/// Why an artifact operation failed.
#[derive(Debug, thiserror::Error)]
pub enum ArtifactError {
    /// A filesystem operation failed.
    #[error("{path} failed: {detail}")]
    Io {
        /// The path involved.
        path: PathBuf,
        /// The underlying failure.
        detail: String,
    },
    /// A state path is not safe to use (`ARCH/22`).
    #[error("unsafe artifact path {path}: {detail}")]
    UnsafePath {
        /// The path involved.
        path: PathBuf,
        /// What is wrong with it.
        detail: String,
    },
    /// The payload exceeds the per-object ceiling.
    #[error("the object is larger than the {limit}-byte object ceiling")]
    ObjectTooLarge {
        /// The effective ceiling.
        limit: u64,
    },
    /// The namespace has reached its encoded-byte ceiling.
    #[error("namespace {namespace} has reached its {limit}-byte ceiling ({committed} committed)")]
    NamespaceFull {
        /// The namespace key.
        namespace: String,
        /// The effective ceiling.
        limit: u64,
        /// Bytes already committed.
        committed: u64,
    },
    /// The same operation id was used with different bytes.
    #[error("operation `{operation_id}` already wrote different bytes in this namespace")]
    OperationConflict {
        /// The conflicting operation id.
        operation_id: String,
    },
    /// A referenced object does not exist.
    #[error("no object {digest} in namespace {namespace}")]
    Missing {
        /// The namespace key.
        namespace: String,
        /// The digest that was requested.
        digest: String,
    },
    /// The stored content does not match its reference.
    #[error("object {digest} is corrupt: {detail}")]
    Corrupt {
        /// The digest that was requested.
        digest: String,
        /// What failed verification.
        detail: String,
    },
    /// The reference names a newer schema than this build understands.
    #[error("reference schema version {found} is newer than this build supports ({supported})")]
    UnsupportedSchema {
        /// The version in the reference.
        found: u32,
        /// The version this build writes.
        supported: u32,
    },
    /// The caller's byte ceiling for this read is smaller than the object.
    #[error("the object is {bytes} bytes, above the {limit}-byte read ceiling")]
    ReadTooLarge {
        /// The object's stored size.
        bytes: u64,
        /// The caller's ceiling.
        limit: u64,
    },
}

impl ArtifactError {
    fn io(path: &Path, error: &std::io::Error) -> Self {
        Self::Io {
            path: path.to_path_buf(),
            detail: error.to_string(),
        }
    }
}

/// What a completed write means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PutOutcome {
    /// New bytes were published.
    Published(BlobRef),
    /// The same operation id and bytes were already published.
    AlreadyPublished(BlobRef),
}

#[derive(Default, Serialize, Deserialize)]
struct QuotaFile {
    committed_bytes: u64,
}

/// The shared writer state: one lock and the committed-byte ledger.
#[derive(Debug)]
struct Ledger {
    _lock: File,
    committed: u64,
}

/// A content-addressed artifact store rooted at one directory.
#[derive(Debug)]
pub struct ArtifactStore {
    root: PathBuf,
    limits: ArtifactLimits,
    namespaces: Mutex<BTreeMap<String, Arc<Mutex<Ledger>>>>,
}

impl ArtifactStore {
    /// Opens (creating if needed) a store at `root`.
    ///
    /// # Errors
    /// Returns [`ArtifactError`] when the root is unusable or unsafe.
    pub fn open(root: impl Into<PathBuf>, limits: ArtifactLimits) -> Result<Self, ArtifactError> {
        let root = root.into();
        horizoncode_config::refuse_symlink(&root).map_err(|error| ArtifactError::UnsafePath {
            path: root.clone(),
            detail: error.to_string(),
        })?;
        fs::create_dir_all(&root).map_err(|error| ArtifactError::io(&root, &error))?;
        horizoncode_config::set_owner_only(&root, OwnerOnly::Directory).map_err(|error| {
            ArtifactError::UnsafePath {
                path: root.clone(),
                detail: error.to_string(),
            }
        })?;
        Ok(Self {
            root,
            limits,
            namespaces: Mutex::new(BTreeMap::new()),
        })
    }

    /// Returns the store root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Returns the effective limits.
    #[must_use]
    pub fn limits(&self) -> ArtifactLimits {
        self.limits
    }

    /// Stores the bytes from `reader` under `operation_id` in `namespace`.
    ///
    /// The declared `media_type` is advisory; the caller's stored value is
    /// recorded as given (sniffing belongs to the decoding feature). Bytes are
    /// hashed and capped while streaming.
    ///
    /// # Errors
    /// Returns [`ArtifactError::ObjectTooLarge`] or
    /// [`ArtifactError::NamespaceFull`] before publishing, and
    /// [`ArtifactError::OperationConflict`] when the operation id was used with
    /// different bytes.
    pub fn put(
        &self,
        namespace: &NamespaceId,
        operation_id: &str,
        media_type: &str,
        reader: &mut dyn Read,
    ) -> Result<PutOutcome, ArtifactError> {
        let ledger = self.namespace(namespace)?;
        let mut ledger = ledger
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let dirs = NamespaceDirs::ensure(&self.root, namespace)?;

        // Idempotency: a completed operation returns its original reference.
        let operation_path = dirs.operations.join(operation_id);
        horizoncode_config::refuse_symlink(&operation_path).map_err(|error| {
            ArtifactError::UnsafePath {
                path: operation_path.clone(),
                detail: error.to_string(),
            }
        })?;
        if operation_path.is_file() {
            let text = fs::read_to_string(&operation_path)
                .map_err(|error| ArtifactError::io(&operation_path, &error))?;
            let existing: BlobRef =
                serde_json::from_str(&text).map_err(|error| ArtifactError::Corrupt {
                    digest: operation_path.display().to_string(),
                    detail: error.to_string(),
                })?;
            let outcome = self.matches_existing(namespace, &dirs, reader, &existing)?;
            return match outcome {
                MatchingOutcome::Same => Ok(PutOutcome::AlreadyPublished(existing)),
                MatchingOutcome::Different => Err(ArtifactError::OperationConflict {
                    operation_id: operation_id.to_owned(),
                }),
            };
        }

        // Stream into an exclusive staging file while hashing and capping.
        let staging = dirs.staging.join(format!("{operation_id}.part"));
        horizoncode_config::refuse_symlink(&staging).map_err(|error| {
            ArtifactError::UnsafePath {
                path: staging.clone(),
                detail: error.to_string(),
            }
        })?;
        let mut hasher = blake3::Hasher::new();
        let mut staged = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&staging)
            .map_err(|error| ArtifactError::io(&staging, &error))?;
        horizoncode_config::set_owner_only(&staging, OwnerOnly::File).map_err(|error| {
            ArtifactError::UnsafePath {
                path: staging.clone(),
                detail: error.to_string(),
            }
        })?;
        let mut written = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        let result = (|| -> Result<(), ArtifactError> {
            loop {
                let read = reader
                    .read(&mut buffer)
                    .map_err(|error| ArtifactError::io(&staging, &error))?;
                if read == 0 {
                    break;
                }
                written = written.saturating_add(read as u64);
                if written > self.limits.max_object_bytes {
                    return Err(ArtifactError::ObjectTooLarge {
                        limit: self.limits.max_object_bytes,
                    });
                }
                if ledger.committed.saturating_add(written) > self.limits.namespace_bytes {
                    return Err(ArtifactError::NamespaceFull {
                        namespace: namespace.key(),
                        limit: self.limits.namespace_bytes,
                        committed: ledger.committed,
                    });
                }
                hasher.update(&buffer[..read]);
                staged
                    .write_all(&buffer[..read])
                    .map_err(|error| ArtifactError::io(&staging, &error))?;
            }
            staged
                .flush()
                .and_then(|()| staged.sync_all())
                .map_err(|error| ArtifactError::io(&staging, &error))?;
            Ok(())
        })();
        drop(staged);
        if let Err(error) = result {
            let _ = fs::remove_file(&staging);
            return Err(error);
        }

        let digest = hasher.finalize().to_hex().to_string();
        let object = dirs.blobs.join(&digest);
        horizoncode_config::refuse_symlink(&object).map_err(|error| ArtifactError::UnsafePath {
            path: object.clone(),
            detail: error.to_string(),
        })?;
        if object.is_file() {
            // Re-verify an existing digest path instead of replacing it.
            let stored = fs::read(&object).map_err(|error| ArtifactError::io(&object, &error))?;
            let stored_digest = blake3::hash(&stored).to_hex().to_string();
            if stored_digest != digest || stored.len() as u64 != written {
                let _ = fs::remove_file(&staging);
                return Err(ArtifactError::Corrupt {
                    digest,
                    detail: "a digest path already exists with different bytes".to_owned(),
                });
            }
            let _ = fs::remove_file(&staging);
        } else {
            fs::rename(&staging, &object).map_err(|error| ArtifactError::io(&object, &error))?;
            horizoncode_config::set_owner_only(&object, OwnerOnly::File).map_err(|error| {
                ArtifactError::UnsafePath {
                    path: object.clone(),
                    detail: error.to_string(),
                }
            })?;
            sync_dir(&dirs.blobs)?;
        }

        let reference = BlobRef {
            blob_id: format!("blob_{}", uuid::Uuid::now_v7()),
            digest,
            media_type: media_type.to_owned(),
            encoded_bytes: written,
            schema_version: REFERENCE_SCHEMA_VERSION,
        };
        let line = serde_json::to_string(&reference).map_err(|error| ArtifactError::Io {
            path: operation_path.clone(),
            detail: error.to_string(),
        })?;
        write_new_file(&operation_path, line.as_bytes())?;

        ledger.committed = ledger.committed.saturating_add(written);
        write_quota(&dirs.quota, ledger.committed)?;
        Ok(PutOutcome::Published(reference))
    }

    /// Reads and verifies an object, bounded by `max_bytes`.
    ///
    /// # Errors
    /// Returns [`ArtifactError::Missing`], [`ArtifactError::Corrupt`],
    /// [`ArtifactError::UnsupportedSchema`], or [`ArtifactError::ReadTooLarge`]
    /// as typed results.
    pub fn read(
        &self,
        namespace: &NamespaceId,
        reference: &BlobRef,
        max_bytes: u64,
    ) -> Result<Vec<u8>, ArtifactError> {
        check_schema(reference)?;
        if reference.encoded_bytes > max_bytes {
            return Err(ArtifactError::ReadTooLarge {
                bytes: reference.encoded_bytes,
                limit: max_bytes,
            });
        }
        let dirs = NamespaceDirs::paths(&self.root, namespace);
        let object = dirs.blobs.join(&reference.digest);
        horizoncode_config::refuse_symlink(&object).map_err(|error| ArtifactError::UnsafePath {
            path: object.clone(),
            detail: error.to_string(),
        })?;
        let bytes = match fs::read(&object) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ArtifactError::Missing {
                    namespace: namespace.key(),
                    digest: reference.digest.clone(),
                });
            }
            Err(error) => return Err(ArtifactError::io(&object, &error)),
        };
        if bytes.len() as u64 != reference.encoded_bytes {
            return Err(ArtifactError::Corrupt {
                digest: reference.digest.clone(),
                detail: format!(
                    "stored {} bytes, the reference names {}",
                    bytes.len(),
                    reference.encoded_bytes
                ),
            });
        }
        if blake3::hash(&bytes).to_hex().to_string() != reference.digest {
            return Err(ArtifactError::Corrupt {
                digest: reference.digest.clone(),
                detail: "the stored bytes do not hash to the reference digest".to_owned(),
            });
        }
        Ok(bytes)
    }

    /// Returns an object's metadata after verifying its stored length.
    ///
    /// # Errors
    /// As [`ArtifactStore::read`], without reading the payload.
    pub fn stat(
        &self,
        namespace: &NamespaceId,
        reference: &BlobRef,
    ) -> Result<ArtifactStat, ArtifactError> {
        check_schema(reference)?;
        let dirs = NamespaceDirs::paths(&self.root, namespace);
        let object = dirs.blobs.join(&reference.digest);
        horizoncode_config::refuse_symlink(&object).map_err(|error| ArtifactError::UnsafePath {
            path: object.clone(),
            detail: error.to_string(),
        })?;
        let metadata = match fs::metadata(&object) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return Err(ArtifactError::Missing {
                    namespace: namespace.key(),
                    digest: reference.digest.clone(),
                });
            }
            Err(error) => return Err(ArtifactError::io(&object, &error)),
        };
        if metadata.len() != reference.encoded_bytes {
            return Err(ArtifactError::Corrupt {
                digest: reference.digest.clone(),
                detail: format!(
                    "stored {} bytes, the reference names {}",
                    metadata.len(),
                    reference.encoded_bytes
                ),
            });
        }
        Ok(ArtifactStat {
            reference: reference.clone(),
            stored_bytes: metadata.len(),
        })
    }

    /// Lists the digests published in a namespace, with their stored lengths.
    ///
    /// # Errors
    /// Returns [`ArtifactError`] when the namespace cannot be inspected; a
    /// missing namespace is an empty list.
    pub fn list(&self, namespace: &NamespaceId) -> Result<Vec<(String, u64)>, ArtifactError> {
        let dirs = NamespaceDirs::paths(&self.root, namespace);
        horizoncode_config::refuse_symlink(&dirs.blobs).map_err(|error| {
            ArtifactError::UnsafePath {
                path: dirs.blobs.clone(),
                detail: error.to_string(),
            }
        })?;
        let entries = match fs::read_dir(&dirs.blobs) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(ArtifactError::io(&dirs.blobs, &error)),
        };
        let mut out = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let metadata = entry
                .metadata()
                .map_err(|error| ArtifactError::io(&entry.path(), &error))?;
            if metadata.is_file() {
                out.push((name, metadata.len()));
            }
        }
        out.sort();
        Ok(out)
    }

    /// The committed encoded bytes of a namespace, from its durable ledger.
    ///
    /// # Errors
    /// Returns [`ArtifactError`] when the quota file cannot be read.
    pub fn committed_bytes(&self, namespace: &NamespaceId) -> Result<u64, ArtifactError> {
        let dirs = NamespaceDirs::paths(&self.root, namespace);
        read_quota(&dirs.quota)
    }

    fn namespace(&self, namespace: &NamespaceId) -> Result<Arc<Mutex<Ledger>>, ArtifactError> {
        let mut namespaces = self
            .namespaces
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(ledger) = namespaces.get(&namespace.key()) {
            return Ok(Arc::clone(ledger));
        }
        let dirs = NamespaceDirs::ensure(&self.root, namespace)?;
        horizoncode_config::refuse_symlink(&dirs.lock).map_err(|error| {
            ArtifactError::UnsafePath {
                path: dirs.lock.clone(),
                detail: error.to_string(),
            }
        })?;
        let lock = OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&dirs.lock)
            .map_err(|error| ArtifactError::io(&dirs.lock, &error))?;
        horizoncode_config::set_owner_only(&dirs.lock, OwnerOnly::File).map_err(|error| {
            ArtifactError::UnsafePath {
                path: dirs.lock.clone(),
                detail: error.to_string(),
            }
        })?;
        lock.try_lock().map_err(|_| ArtifactError::UnsafePath {
            path: dirs.lock.clone(),
            detail: "another writer holds this namespace".to_owned(),
        })?;
        let committed = read_quota(&dirs.quota)?;
        let ledger = Arc::new(Mutex::new(Ledger {
            _lock: lock,
            committed,
        }));
        namespaces.insert(namespace.key(), Arc::clone(&ledger));
        Ok(ledger)
    }

    /// Compares a submitted payload against an existing operation's reference
    /// without publishing anything.
    fn matches_existing(
        &self,
        namespace: &NamespaceId,
        dirs: &NamespaceDirs,
        reader: &mut dyn Read,
        existing: &BlobRef,
    ) -> Result<MatchingOutcome, ArtifactError> {
        let mut hasher = blake3::Hasher::new();
        let mut written = 0u64;
        let mut buffer = vec![0u8; 64 * 1024];
        loop {
            let read = reader
                .read(&mut buffer)
                .map_err(|error| ArtifactError::io(&dirs.operations, &error))?;
            if read == 0 {
                break;
            }
            written = written.saturating_add(read as u64);
            hasher.update(&buffer[..read]);
        }
        if existing.encoded_bytes == written
            && existing.digest == hasher.finalize().to_hex().to_string()
            && self.stat(namespace, existing).is_ok()
        {
            Ok(MatchingOutcome::Same)
        } else {
            Ok(MatchingOutcome::Different)
        }
    }
}

enum MatchingOutcome {
    Same,
    Different,
}

fn check_schema(reference: &BlobRef) -> Result<(), ArtifactError> {
    if reference.schema_version > REFERENCE_SCHEMA_VERSION {
        return Err(ArtifactError::UnsupportedSchema {
            found: reference.schema_version,
            supported: REFERENCE_SCHEMA_VERSION,
        });
    }
    Ok(())
}

/// The directories one namespace uses.
#[derive(Debug)]
struct NamespaceDirs {
    blobs: PathBuf,
    staging: PathBuf,
    operations: PathBuf,
    quota: PathBuf,
    lock: PathBuf,
}

impl NamespaceDirs {
    fn paths(root: &Path, namespace: &NamespaceId) -> Self {
        let base = root.join(namespace.kind.as_str()).join(&namespace.id);
        Self {
            blobs: base.join(BLOBS_DIR).join(HASH_DIR),
            staging: base.join(STAGING_DIR),
            operations: base.join("operations"),
            quota: base.join(QUOTA_FILE),
            lock: base.join(LOCK_FILE),
        }
    }

    fn ensure(root: &Path, namespace: &NamespaceId) -> Result<Self, ArtifactError> {
        let dirs = Self::paths(root, namespace);
        let base = root.join(namespace.kind.as_str()).join(&namespace.id);
        for dir in [
            base.clone(),
            base.join(BLOBS_DIR),
            dirs.blobs.clone(),
            dirs.staging.clone(),
            dirs.operations.clone(),
        ] {
            horizoncode_config::refuse_symlink(&dir).map_err(|error| {
                ArtifactError::UnsafePath {
                    path: dir.clone(),
                    detail: error.to_string(),
                }
            })?;
            fs::create_dir_all(&dir).map_err(|error| ArtifactError::io(&dir, &error))?;
            horizoncode_config::set_owner_only(&dir, OwnerOnly::Directory).map_err(|error| {
                ArtifactError::UnsafePath {
                    path: dir.clone(),
                    detail: error.to_string(),
                }
            })?;
        }
        Ok(dirs)
    }
}

fn read_quota(path: &Path) -> Result<u64, ArtifactError> {
    match fs::read_to_string(path) {
        Ok(text) => {
            let quota: QuotaFile =
                serde_json::from_str(&text).map_err(|error| ArtifactError::Corrupt {
                    digest: path.display().to_string(),
                    detail: error.to_string(),
                })?;
            Ok(quota.committed_bytes)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(ArtifactError::io(path, &error)),
    }
}

fn write_quota(path: &Path, committed: u64) -> Result<(), ArtifactError> {
    let line = serde_json::to_string(&QuotaFile {
        committed_bytes: committed,
    })
    .map_err(|error| ArtifactError::Io {
        path: path.to_path_buf(),
        detail: error.to_string(),
    })?;
    let temp = path.with_extension("new");
    let mut file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(&temp)
        .map_err(|error| ArtifactError::io(&temp, &error))?;
    file.write_all(line.as_bytes())
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|error| ArtifactError::io(&temp, &error))?;
    horizoncode_config::set_owner_only(&temp, OwnerOnly::File).map_err(|error| {
        ArtifactError::UnsafePath {
            path: temp.clone(),
            detail: error.to_string(),
        }
    })?;
    fs::rename(&temp, path).map_err(|error| ArtifactError::io(path, &error))
}

fn write_new_file(path: &Path, bytes: &[u8]) -> Result<(), ArtifactError> {
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(path)
        .map_err(|error| ArtifactError::io(path, &error))?;
    file.write_all(bytes)
        .and_then(|()| file.write_all(b"\n"))
        .and_then(|()| file.flush())
        .and_then(|()| file.sync_all())
        .map_err(|error| ArtifactError::io(path, &error))?;
    horizoncode_config::set_owner_only(path, OwnerOnly::File).map_err(|error| {
        ArtifactError::UnsafePath {
            path: path.to_path_buf(),
            detail: error.to_string(),
        }
    })
}

fn sync_dir(path: &Path) -> Result<(), ArtifactError> {
    #[cfg(unix)]
    {
        // A directory is opened read-only to synchronize its entry list.
        let handle = File::open(path).map_err(|error| ArtifactError::io(path, &error))?;
        handle
            .sync_all()
            .map_err(|error| ArtifactError::io(path, &error))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}
