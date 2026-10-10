//! Private immutable artifact storage seam. It is not wired to a production owner yet.

use crate::owner_log::Digest;
use crate::protocol::{ArtifactClassificationV1, ArtifactRefV1};
use std::error::Error;
use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

// Leave 1 KiB for the encoded reference, offsets, and chunk-body fields.
const MAX_ARTIFACT_CHUNK_BYTES: usize = crate::protocol::MAX_ARTIFACT_CHUNK_BODY_BYTES - 1024;
const MAX_ARTIFACT_BYTES: u64 = 256 * 1024 * 1024;
const MAX_ARTIFACT_METADATA_BYTES: usize = 128 * 1024;
const ARTIFACT_METADATA_FORMAT: &str = "horizon.artifact-metadata.v1";
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
    pub(crate) encryption: ArtifactEncryptionV1,
    pub(crate) redaction: ArtifactRedactionV1,
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
    StoragePermissionsUnavailable,
    DurabilityUnavailable,
    PublicationUncertain,
    PublishedCleanupFailed,
    Io {
        operation: &'static str,
        kind: std::io::ErrorKind,
    },
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
    digest_verified: bool,
}

impl ReadPermit {
    pub(crate) fn new(artifact_ref: ArtifactRefV1) -> Self {
        Self {
            artifact_ref,
            store_scope: None,
            state: Mutex::new(PermitState {
                next_offset: 0,
                digest_verified: false,
            }),
        }
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
    authorizer: A,
    scope: Arc<()>,
}

impl<A: ArtifactAuthorizer> ArtifactStore<A> {
    pub(crate) fn open(root: &Path, authorizer: A) -> Result<Self, ArtifactError> {
        if !cfg!(unix) {
            return Err(ArtifactError::StoragePermissionsUnavailable);
        }
        ensure_directory_tree(root, true)?;
        ensure_private_directory(&root.join(BLOB_DIRECTORY))?;
        ensure_private_directory(&root.join(METADATA_DIRECTORY))?;
        Ok(Self {
            root: root.to_path_buf(),
            authorizer,
            scope: Arc::new(()),
        })
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
        if existing_file_matches(&metadata_path, &metadata_bytes)? == Some(false) {
            return Err(ArtifactError::MetadataConflict);
        }

        let blob_path = blob_path(&self.root, &metadata.digest)?;
        ensure_private_directory(blob_path.parent().ok_or(ArtifactError::InvalidMetadata)?)?;
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
        let path = metadata_path(&self.root, &permit.artifact_ref.artifact_id);
        let bytes =
            read_private_file(&path, MAX_ARTIFACT_METADATA_BYTES, true).map_err(|error| {
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

        let path = blob_path(&self.root, &metadata.digest)?;
        let mut file = open_private_object(&path, total_length)?;
        if !state.digest_verified {
            verify_object_digest(&mut file, &metadata.digest, total_length)?;
            state.digest_verified = true;
        }
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
    let Some(hex) = digest.strip_prefix("blake3:") else {
        return Err(ArtifactError::InvalidMetadata);
    };
    Digest::parse_hex(hex).map_err(|_| ArtifactError::InvalidMetadata)?;
    Ok(root.join(BLOB_DIRECTORY).join(&hex[..2]).join(&hex[2..]))
}

fn metadata_path(root: &Path, artifact_id: &str) -> PathBuf {
    let key = blake3::hash(artifact_id.as_bytes()).to_hex().to_string();
    root.join(METADATA_DIRECTORY)
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

fn read_private_file(path: &Path, limit: usize, read_only: bool) -> Result<Vec<u8>, ArtifactError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(ArtifactError::NotFound);
        }
        Err(error) => return Err(io_error("inspect artifact file", error)),
    };
    validate_private_file(&metadata, read_only)?;
    if metadata.len() > limit as u64 {
        return Err(ArtifactError::CorruptMetadata);
    }
    let file = File::open(path).map_err(|error| io_error("open artifact file", error))?;
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("read artifact file", error))?;
    if bytes.len() > limit {
        return Err(ArtifactError::CorruptMetadata);
    }
    Ok(bytes)
}

fn open_private_object(path: &Path, expected_length: u64) -> Result<File, ArtifactError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Err(ArtifactError::NotFound);
        }
        Err(error) => return Err(io_error("inspect artifact object", error)),
    };
    validate_private_file(&metadata, true)?;
    if metadata.len() != expected_length {
        return Err(ArtifactError::CorruptObject);
    }
    let file = File::open(path).map_err(|error| io_error("open artifact object", error))?;
    if file
        .metadata()
        .map_err(|error| io_error("inspect open artifact object", error))?
        .len()
        != expected_length
    {
        return Err(ArtifactError::CorruptObject);
    }
    Ok(file)
}

fn verify_object_digest(
    file: &mut File,
    expected_digest: &str,
    expected_length: u64,
) -> Result<(), ArtifactError> {
    let Some(hex) = expected_digest.strip_prefix("blake3:") else {
        return Err(ArtifactError::CorruptMetadata);
    };
    let expected = Digest::parse_hex(hex).map_err(|_| ArtifactError::CorruptMetadata)?;
    file.seek(SeekFrom::Start(0))
        .map_err(|error| io_error("rewind artifact object", error))?;
    let mut hasher = blake3::Hasher::new();
    let mut total = 0u64;
    let mut buffer = [0u8; 64 * 1024];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|error| io_error("verify artifact object", error))?;
        if count == 0 {
            break;
        }
        total = total
            .checked_add(count as u64)
            .ok_or(ArtifactError::CorruptObject)?;
        hasher.update(&buffer[..count]);
    }
    if total != expected_length || Digest::from_bytes(*hasher.finalize().as_bytes()) != expected {
        return Err(ArtifactError::CorruptObject);
    }
    Ok(())
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
        "encryption": encryption_name(metadata.encryption),
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
    if object.len() != 11
        || object.get("format").and_then(serde_json::Value::as_str)
            != Some(ARTIFACT_METADATA_FORMAT)
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
        owner_refs,
        access: match metadata_string(object, "access")?.as_str() {
            "public" => ArtifactAccessV1::Public,
            "workspace" => ArtifactAccessV1::Workspace,
            "sensitive" => ArtifactAccessV1::Sensitive,
            _ => return Err(ArtifactError::CorruptMetadata),
        },
        retention_class: metadata_string(object, "retentionClass")?,
        created_at: metadata_string(object, "createdAt")?,
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

#[cfg(test)]
mod tests {
    use super::*;
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
            encryption: ArtifactEncryptionV1::None,
            redaction: ArtifactRedactionV1::NotNeeded,
        }
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
}
