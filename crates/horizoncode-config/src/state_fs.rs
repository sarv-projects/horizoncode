//! Hygiene for state and configuration paths (`ARCH/22` threat rows `F-02`,
//! `FO-15`, `L-06`, `L-07`; `TODO.md` `AX-126`).
//!
//! Every store and discovery walk shares three rules:
//!
//! 1. a state or config path whose final component is a symlink is **refused**,
//!    never followed — a link planted inside a granted root must not retarget a
//!    write or read outside it;
//! 2. a file or directory the store creates is owner-only (`0600`/`0700`);
//! 3. new files are created exclusively, so a pre-existing link or file cannot
//!    be written through.
//!
//! The mode checks are Unix mode checks. On other targets `set_owner_only` is a
//! no-op and `refuse_group_or_other_access` reports the mode as unobservable,
//! so the caller must not claim an ACL guarantee: Windows ACL enforcement and
//! junction refusal are an explicit residual (`ARCH/22`, `AX-126`).
//!
//! These are primitives, not policy: the caller decides whether an unsafe path
//! is a typed refusal, a skipped layer, or a recorded issue.

use std::fs;
use std::io;
use std::path::Path;

/// What a path's final component is, without following a symlink.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PathEntry {
    /// Nothing exists at the path.
    Missing,
    /// A regular file.
    File,
    /// A directory.
    Directory,
    /// A symlink (or a junction on Windows).
    Symlink,
    /// Something else (socket, fifo, device).
    Other,
}

/// Classifies a path without following a final symlink.
///
/// # Errors
/// Returns the filesystem error for anything other than `NotFound`.
pub fn classify(path: &Path) -> io::Result<PathEntry> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => {
            let file_type = metadata.file_type();
            Ok(if file_type.is_symlink() {
                PathEntry::Symlink
            } else if file_type.is_file() {
                PathEntry::File
            } else if file_type.is_dir() {
                PathEntry::Directory
            } else {
                PathEntry::Other
            })
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(PathEntry::Missing),
        Err(error) => Err(error),
    }
}

/// Refuses a final-component symlink, returning what the path is otherwise.
///
/// # Errors
/// Returns [`io::ErrorKind::InvalidInput`] for a symlink and the filesystem
/// error for anything other than `NotFound`.
pub fn refuse_symlink(path: &Path) -> io::Result<PathEntry> {
    let entry = classify(path)?;
    if entry == PathEntry::Symlink {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            format!(
                "{} is a symlink; state and config paths are never followed",
                path.display()
            ),
        ));
    }
    Ok(entry)
}

/// Which owner-only mode a path needs.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum OwnerOnly {
    /// A regular file: `0600`.
    File,
    /// A directory: `0700`, because traversal needs the execute bit.
    Directory,
}

impl OwnerOnly {
    fn mode(self) -> u32 {
        match self {
            Self::File => 0o600,
            Self::Directory => 0o700,
        }
    }

    fn mask(self) -> u32 {
        match self {
            Self::File => 0o077,
            Self::Directory => 0o077,
        }
    }
}

/// Sets owner-only permissions. A no-op on non-Unix targets.
///
/// # Errors
/// Returns the filesystem error when the mode cannot be set.
pub fn set_owner_only(path: &Path, kind: OwnerOnly) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(kind.mode()))
            .map_err(|error| io::Error::new(error.kind(), format!("{}: {error}", path.display())))
    }
    #[cfg(not(unix))]
    {
        let _ = (path, kind);
        Ok(())
    }
}

/// Returns the permission bits, refusing any group or other access.
///
/// On non-Unix targets the mode is not observable and `0` is returned; the
/// caller must not present that as a verified owner-only state.
///
/// # Errors
/// Returns [`io::ErrorKind::PermissionDenied`] when the path grants access
/// beyond its owner, and the filesystem error when metadata cannot be read.
pub fn refuse_group_or_other_access(path: &Path, kind: OwnerOnly) -> io::Result<u32> {
    let metadata = fs::symlink_metadata(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & kind.mask() != 0 {
            return Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                format!(
                    "{} is mode {mode:04o}; owner-only access is required",
                    path.display()
                ),
            ));
        }
        Ok(mode)
    }
    #[cfg(not(unix))]
    {
        let _ = (metadata, kind);
        Ok(0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_distinguishes_absence_files_and_directories() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("missing");
        assert_eq!(classify(&missing).unwrap(), PathEntry::Missing);
        assert_eq!(classify(dir.path()).unwrap(), PathEntry::Directory);
        let file = dir.path().join("file");
        fs::write(&file, b"x").unwrap();
        assert_eq!(classify(&file).unwrap(), PathEntry::File);
        assert_eq!(refuse_symlink(&file).unwrap(), PathEntry::File);
        assert_eq!(refuse_symlink(&missing).unwrap(), PathEntry::Missing);
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_is_refused_and_not_followed() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join("target");
        fs::write(&target, b"secret").unwrap();
        let link = dir.path().join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();

        assert_eq!(classify(&link).unwrap(), PathEntry::Symlink);
        let error = refuse_symlink(&link).unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        assert!(error.to_string().contains("symlink"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn owner_only_modes_are_set_and_enforced() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("file");
        fs::write(&file, b"x").unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(refuse_group_or_other_access(&file, OwnerOnly::File).is_err());
        set_owner_only(&file, OwnerOnly::File).unwrap();
        assert_eq!(
            fs::metadata(&file).unwrap().permissions().mode() & 0o777,
            0o600
        );
        assert!(refuse_group_or_other_access(&file, OwnerOnly::File).is_ok());

        let nested = dir.path().join("nested");
        fs::create_dir(&nested).unwrap();
        fs::set_permissions(&nested, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(refuse_group_or_other_access(&nested, OwnerOnly::Directory).is_err());
        set_owner_only(&nested, OwnerOnly::Directory).unwrap();
        assert_eq!(
            fs::metadata(&nested).unwrap().permissions().mode() & 0o777,
            0o700
        );
    }
}
