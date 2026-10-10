//! Linux single-supervisor lease with a durable, monotonically increasing epoch.
//!
//! The caller must resolve and create the state directory before startup. This module
//! accepts only a canonical owner-only directory with no unprotected shared-writable
//! ancestor and keeps an advisory lock held for the lease lifetime. The epoch is advanced
//! atomically before a lease is returned.

use std::fmt;
use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SupervisorLeaseErrorKind {
    Io,
    InsecureDirectory,
    UnsafeFile,
    Busy,
    CorruptEpoch,
    EpochOverflow,
}

#[derive(Debug)]
pub struct SupervisorLeaseError {
    kind: SupervisorLeaseErrorKind,
    detail: String,
}

impl SupervisorLeaseError {
    fn new(kind: SupervisorLeaseErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    pub const fn kind(&self) -> SupervisorLeaseErrorKind {
        self.kind
    }
}

impl fmt::Display for SupervisorLeaseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "supervisor lease {:?}: {}",
            self.kind, self.detail
        )
    }
}

impl std::error::Error for SupervisorLeaseError {}

/// A process-held lock and the fresh epoch claimed by that lock holder.
#[derive(Debug)]
pub struct SupervisorLease {
    _lock: File,
    epoch: u64,
}

impl SupervisorLease {
    /// Acquire the only lease for an existing canonical owner-private state directory.
    /// Reopening after a prior process exits advances the persisted epoch by one.
    pub fn acquire(directory: &Path) -> Result<Self, SupervisorLeaseError> {
        validate_directory(directory)?;
        let lock = open_private_file(directory, "supervisor.lock", true)?;
        // SAFETY: `lock` is a live regular file descriptor and the operation changes only
        // its advisory process lock. The descriptor remains held for the lease lifetime.
        let locked = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if locked != 0 {
            let error = io::Error::last_os_error();
            let kind = if error.kind() == io::ErrorKind::WouldBlock {
                SupervisorLeaseErrorKind::Busy
            } else {
                SupervisorLeaseErrorKind::Io
            };
            return Err(SupervisorLeaseError::new(kind, error.to_string()));
        }

        let previous = read_epoch(directory)?;
        let epoch = previous
            .checked_add(1)
            .filter(|value| *value > 0)
            .ok_or_else(|| {
                SupervisorLeaseError::new(
                    SupervisorLeaseErrorKind::EpochOverflow,
                    "persisted epoch cannot be incremented",
                )
            })?;
        publish_epoch(directory, epoch)?;
        Ok(Self { _lock: lock, epoch })
    }

    pub const fn epoch(&self) -> u64 {
        self.epoch
    }
}

fn validate_directory(directory: &Path) -> Result<(), SupervisorLeaseError> {
    if !directory.is_absolute() {
        return Err(SupervisorLeaseError::new(
            SupervisorLeaseErrorKind::InsecureDirectory,
            "state directory must be absolute",
        ));
    }
    let canonical = fs::canonicalize(directory).map_err(io_error)?;
    let metadata = fs::symlink_metadata(directory).map_err(io_error)?;
    let uid = unsafe { libc::geteuid() };
    if canonical != directory
        || metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
    {
        return Err(SupervisorLeaseError::new(
            SupervisorLeaseErrorKind::InsecureDirectory,
            "state directory must be canonical, non-symlink, owned by this user and mode 0700 or stricter",
        ));
    }
    validate_parent_directories(directory)?;
    Ok(())
}

fn validate_parent_directories(directory: &Path) -> Result<(), SupervisorLeaseError> {
    let mut parent = directory.parent();
    while let Some(path) = parent {
        let metadata = fs::symlink_metadata(path).map_err(io_error)?;
        let mode = metadata.mode();
        if metadata.file_type().is_symlink()
            || !metadata.is_dir()
            || (mode & 0o022 != 0 && mode & 0o1000 == 0)
        {
            return Err(SupervisorLeaseError::new(
                SupervisorLeaseErrorKind::InsecureDirectory,
                "state directory parent must not be shared-writable unless protected by the sticky bit",
            ));
        }
        if path == Path::new("/") {
            break;
        }
        parent = path.parent();
    }
    Ok(())
}

fn open_private_file(
    directory: &Path,
    name: &str,
    create: bool,
) -> Result<File, SupervisorLeaseError> {
    let path = directory.join(name);
    let mut options = OpenOptions::new();
    options
        .read(true)
        .write(create)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW);
    if create {
        options.create(true).mode(0o600);
    }
    let file = options.open(&path).map_err(|error| {
        let kind = if error.raw_os_error() == Some(libc::ELOOP) {
            SupervisorLeaseErrorKind::UnsafeFile
        } else {
            SupervisorLeaseErrorKind::Io
        };
        SupervisorLeaseError::new(kind, error.to_string())
    })?;
    let metadata = file.metadata().map_err(io_error)?;
    let uid = unsafe { libc::geteuid() };
    if !metadata.is_file()
        || metadata.uid() != uid
        || metadata.mode() & 0o777 != 0o600
        || metadata.nlink() != 1
    {
        return Err(SupervisorLeaseError::new(
            SupervisorLeaseErrorKind::UnsafeFile,
            format!(
                "{} must be a private, singly linked regular file",
                path.display()
            ),
        ));
    }
    Ok(file)
}

fn read_epoch(directory: &Path) -> Result<u64, SupervisorLeaseError> {
    let mut file = match open_private_file(directory, "supervisor.epoch", false) {
        Ok(file) => file,
        Err(error) if error.kind == SupervisorLeaseErrorKind::Io => {
            let path = directory.join("supervisor.epoch");
            if fs::symlink_metadata(&path)
                .is_err_and(|metadata_error| metadata_error.kind() == io::ErrorKind::NotFound)
            {
                return Ok(0);
            }
            return Err(error);
        }
        Err(error) => return Err(error),
    };
    let mut bytes = Vec::with_capacity(20);
    (&mut file)
        .take(21)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.is_empty() || bytes.len() > 20 || !bytes.iter().all(u8::is_ascii_digit) {
        return Err(SupervisorLeaseError::new(
            SupervisorLeaseErrorKind::CorruptEpoch,
            "epoch must be a canonical positive unsigned decimal integer",
        ));
    }
    let text = std::str::from_utf8(&bytes).map_err(|error| {
        SupervisorLeaseError::new(SupervisorLeaseErrorKind::CorruptEpoch, error.to_string())
    })?;
    let epoch = text.parse::<u64>().map_err(|error| {
        SupervisorLeaseError::new(SupervisorLeaseErrorKind::CorruptEpoch, error.to_string())
    })?;
    if epoch == 0 || epoch.to_string().as_bytes() != bytes.as_slice() {
        return Err(SupervisorLeaseError::new(
            SupervisorLeaseErrorKind::CorruptEpoch,
            "epoch must be canonical and nonzero",
        ));
    }
    Ok(epoch)
}

fn publish_epoch(directory: &Path, epoch: u64) -> Result<(), SupervisorLeaseError> {
    let temp_name = format!(
        ".supervisor.epoch.{}.{}",
        std::process::id(),
        NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed)
    );
    let temp_path: PathBuf = directory.join(temp_name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&temp_path)
            .map_err(io_error)?;
        file.write_all(epoch.to_string().as_bytes())
            .map_err(io_error)?;
        file.sync_all().map_err(io_error)?;
        fs::rename(&temp_path, directory.join("supervisor.epoch")).map_err(io_error)?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(io_error)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temp_path);
    }
    result
}

fn io_error(error: io::Error) -> SupervisorLeaseError {
    SupervisorLeaseError::new(SupervisorLeaseErrorKind::Io, error.to_string())
}
