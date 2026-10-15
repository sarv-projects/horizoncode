//! Linux Unix-domain transport with filesystem and process-bound peer checks.
//!
//! A channel is returned only after checking the socket's owner-only parent and mode,
//! `SO_PEERCRED`, and the connected process's `/proc/<pid>/exe` identity. The hello
//! handshake still has to bind the authenticated channel to its launch nonce and process
//! incarnation. This module does not start or supervise the peer process.

use std::ffi::OsStr;
use std::fmt;
use std::fs::{self, FileType, Metadata};
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnixPeerPolicy {
    pub uid: u32,
    pub executable: PathBuf,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnixPeerIdentity {
    pub pid: u32,
    pub uid: u32,
    pub gid: u32,
    pub executable: PathBuf,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum UnixPeerErrorKind {
    Io,
    InvalidPolicy,
    InsecureDirectory,
    UnsafeSocket,
    PeerMismatch,
    PeerIdentityUnavailable,
}

#[derive(Debug)]
pub struct UnixPeerError {
    kind: UnixPeerErrorKind,
    detail: String,
}

impl UnixPeerError {
    fn new(kind: UnixPeerErrorKind, detail: impl Into<String>) -> Self {
        Self {
            kind,
            detail: detail.into(),
        }
    }

    pub const fn kind(&self) -> UnixPeerErrorKind {
        self.kind
    }

    pub const fn is_peer_mismatch(&self) -> bool {
        matches!(self.kind, UnixPeerErrorKind::PeerMismatch)
    }

    pub const fn is_insecure_directory(&self) -> bool {
        matches!(self.kind, UnixPeerErrorKind::InsecureDirectory)
    }
}

impl fmt::Display for UnixPeerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "Unix peer {:?}: {}", self.kind, self.detail)
    }
}

impl std::error::Error for UnixPeerError {}

impl From<io::Error> for UnixPeerError {
    fn from(error: io::Error) -> Self {
        Self::new(UnixPeerErrorKind::Io, error.to_string())
    }
}

/// A listener rooted in a private directory and bound to one peer executable/UID.
pub struct UnixPeerListener {
    listener: UnixListener,
    policy: UnixPeerPolicy,
    socket_path: PathBuf,
    socket_device: u64,
    socket_inode: u64,
}

impl UnixPeerListener {
    /// Bind without replacing an existing path. The parent must already be an owner-only
    /// directory owned by this user; the socket is created with mode `0600`.
    pub fn bind(path: &Path, policy: UnixPeerPolicy) -> Result<Self, UnixPeerError> {
        let policy = validate_policy(policy)?;
        validate_socket_parent(path)?;
        if path
            .file_name()
            .is_none_or(|name| name == OsStr::new(".") || name == OsStr::new(".."))
        {
            return Err(UnixPeerError::new(
                UnixPeerErrorKind::UnsafeSocket,
                "socket path has no valid filename",
            ));
        }
        if fs::symlink_metadata(path).is_ok() {
            return Err(UnixPeerError::new(
                UnixPeerErrorKind::UnsafeSocket,
                "refusing to replace an existing socket path",
            ));
        }

        let listener = UnixListener::bind(path)?;
        if let Err(error) = fs::set_permissions(path, fs::Permissions::from_mode(0o600)) {
            let _ = fs::remove_file(path);
            return Err(error.into());
        }
        let metadata = fs::symlink_metadata(path)?;
        validate_socket_metadata(&metadata)?;
        Ok(Self {
            listener,
            policy,
            socket_path: path.to_owned(),
            socket_device: metadata.dev(),
            socket_inode: metadata.ino(),
        })
    }

    /// Accept one connection and authenticate its kernel-reported credentials and image.
    /// A rejected peer never receives an `AuthenticatedUnixStream`.
    pub fn accept_authenticated(
        &self,
    ) -> Result<(AuthenticatedUnixStream, UnixPeerIdentity), UnixPeerError> {
        let (stream, _) = self.listener.accept()?;
        let identity = authenticate(&stream, &self.policy)?;
        Ok((
            AuthenticatedUnixStream {
                stream,
                peer: identity.clone(),
            },
            identity,
        ))
    }
}

impl Drop for UnixPeerListener {
    fn drop(&mut self) {
        // Remove only the socket inode this listener created. If the path was replaced,
        // leave the replacement untouched.
        if let Ok(metadata) = fs::symlink_metadata(&self.socket_path)
            && metadata.file_type().is_socket()
            && metadata.dev() == self.socket_device
            && metadata.ino() == self.socket_inode
        {
            let _ = fs::remove_file(&self.socket_path);
        }
    }
}

/// Connect and authenticate the server before exposing the stream to protocol code.
pub fn connect_authenticated(
    path: &Path,
    policy: UnixPeerPolicy,
) -> Result<AuthenticatedUnixStream, UnixPeerError> {
    let policy = validate_policy(policy)?;
    validate_socket_parent(path)?;
    let metadata = fs::symlink_metadata(path)
        .map_err(|error| UnixPeerError::new(UnixPeerErrorKind::UnsafeSocket, error.to_string()))?;
    validate_socket_metadata(&metadata)?;
    let stream = UnixStream::connect(path)?;
    let peer = authenticate(&stream, &policy)?;
    Ok(AuthenticatedUnixStream { stream, peer })
}

pub struct AuthenticatedUnixStream {
    stream: UnixStream,
    peer: UnixPeerIdentity,
}

impl AuthenticatedUnixStream {
    pub fn peer(&self) -> &UnixPeerIdentity {
        &self.peer
    }

    /// Clone the authenticated socket endpoint for a dedicated blocking reader.
    /// The clone retains the same OS-authenticated peer binding; callers should keep
    /// exactly one reader and one writer for the shared connection.
    pub fn try_clone(&self) -> io::Result<Self> {
        Ok(Self {
            stream: self.stream.try_clone()?,
            peer: self.peer.clone(),
        })
    }

    pub fn shutdown(&self) -> io::Result<()> {
        self.stream.shutdown(std::net::Shutdown::Both)
    }
}

impl Read for AuthenticatedUnixStream {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        self.stream.read(buffer)
    }
}

impl Write for AuthenticatedUnixStream {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        self.stream.write(buffer)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.stream.flush()
    }
}

fn validate_policy(mut policy: UnixPeerPolicy) -> Result<UnixPeerPolicy, UnixPeerError> {
    let uid = unsafe { libc::geteuid() };
    if policy.uid != uid {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::InvalidPolicy,
            "peer UID policy must match the current user",
        ));
    }
    policy.executable = fs::canonicalize(&policy.executable)
        .map_err(|error| UnixPeerError::new(UnixPeerErrorKind::InvalidPolicy, error.to_string()))?;
    let metadata = fs::metadata(&policy.executable)
        .map_err(|error| UnixPeerError::new(UnixPeerErrorKind::InvalidPolicy, error.to_string()))?;
    if !metadata.is_file() {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::InvalidPolicy,
            "expected executable path is not a regular file",
        ));
    }
    Ok(policy)
}

fn validate_private_directory(path: &Path) -> Result<(), UnixPeerError> {
    let metadata = fs::symlink_metadata(path).map_err(|error| {
        UnixPeerError::new(UnixPeerErrorKind::InsecureDirectory, error.to_string())
    })?;
    let uid = unsafe { libc::geteuid() };
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != uid
        || metadata.mode() & 0o077 != 0
    {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::InsecureDirectory,
            "socket parent must be a non-symlink owner-only directory",
        ));
    }
    Ok(())
}

fn validate_socket_parent(path: &Path) -> Result<(), UnixPeerError> {
    if !path.is_absolute() {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::InsecureDirectory,
            "socket path must be absolute",
        ));
    }
    let parent = path.parent().ok_or_else(|| {
        UnixPeerError::new(UnixPeerErrorKind::InsecureDirectory, "socket has no parent")
    })?;
    let canonical = fs::canonicalize(parent).map_err(|error| {
        UnixPeerError::new(UnixPeerErrorKind::InsecureDirectory, error.to_string())
    })?;
    if canonical != parent {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::InsecureDirectory,
            "socket parent path must not contain symlink or traversal components",
        ));
    }
    validate_private_directory(parent)
}

fn validate_socket_metadata(metadata: &Metadata) -> Result<(), UnixPeerError> {
    let uid = unsafe { libc::geteuid() };
    let file_type: FileType = metadata.file_type();
    if !file_type.is_socket() || metadata.uid() != uid || metadata.mode() & 0o777 != 0o600 {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::UnsafeSocket,
            "socket must be owned by the current user and inaccessible to group/other",
        ));
    }
    Ok(())
}

fn authenticate(
    stream: &UnixStream,
    policy: &UnixPeerPolicy,
) -> Result<UnixPeerIdentity, UnixPeerError> {
    let mut credentials = std::mem::MaybeUninit::<libc::ucred>::zeroed();
    let mut length = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: `credentials` is writable for `length` bytes and the descriptor belongs to
    // a live connected Unix stream. The kernel fills the fixed-size SO_PEERCRED structure.
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            credentials.as_mut_ptr().cast(),
            &mut length,
        )
    };
    if result != 0 || length as usize != std::mem::size_of::<libc::ucred>() {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::PeerIdentityUnavailable,
            io::Error::last_os_error().to_string(),
        ));
    }
    // SAFETY: the successful getsockopt above initialized the complete structure.
    let credentials = unsafe { credentials.assume_init() };
    if credentials.pid <= 0 || credentials.uid != policy.uid {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::PeerMismatch,
            "kernel peer PID or UID does not match policy",
        ));
    }
    let executable =
        fs::canonicalize(format!("/proc/{}/exe", credentials.pid)).map_err(|error| {
            UnixPeerError::new(
                UnixPeerErrorKind::PeerIdentityUnavailable,
                error.to_string(),
            )
        })?;
    if executable != policy.executable {
        return Err(UnixPeerError::new(
            UnixPeerErrorKind::PeerMismatch,
            "kernel peer executable does not match policy",
        ));
    }
    Ok(UnixPeerIdentity {
        pid: credentials.pid as u32,
        uid: credentials.uid,
        gid: credentials.gid,
        executable,
    })
}
