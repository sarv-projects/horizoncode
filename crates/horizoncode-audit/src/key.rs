//! The device key that signs finalized segment roots.
//!
//! Signing is **unconditional**: there is no configuration that turns it off,
//! because a signature is a security control rather than a convenience
//! (`ARCH/14-AUDIT.md` §Anchoring levels, `REQ-AUDIT-004`). The key lives
//! beside the audit store, is created `0600` inside a `0700` directory, and is
//! refused when it is readable by anyone but its owner.
//!
//! The primitive is a **BLAKE3 keyed hash** (a MAC), not an asymmetric
//! signature. That is exactly what the local levels need and it is labelled as
//! such everywhere the level is rendered: a MAC proves the root was produced by
//! a holder of the device key, and it is only as strong as the trust in that
//! key and in the sink it is anchored to.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use rand::RngCore;

use crate::error::AuditError;
use crate::merkle::keyed_digest;

/// The device key length in bytes.
pub const DEVICE_KEY_LEN: usize = 32;

/// The algorithm name recorded alongside every signature.
pub const SIGNATURE_ALGORITHM: &str = "blake3-keyed-mac";

/// A 32-byte device key.
#[derive(Clone)]
pub struct DeviceKey {
    bytes: [u8; DEVICE_KEY_LEN],
}

impl std::fmt::Debug for DeviceKey {
    /// Never renders key material.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DeviceKey").finish_non_exhaustive()
    }
}

impl DeviceKey {
    /// Wraps raw key bytes.
    #[must_use]
    pub fn from_bytes(bytes: [u8; DEVICE_KEY_LEN]) -> Self {
        Self { bytes }
    }

    /// Signs `data`, returning the hex MAC and the algorithm name.
    #[must_use]
    pub fn sign(&self, data: &[u8]) -> SignedDigest {
        SignedDigest {
            algorithm: SIGNATURE_ALGORITHM.to_owned(),
            value: keyed_digest(&self.bytes, data),
        }
    }

    /// Verifies a signature over `data`.
    #[must_use]
    pub fn verify(&self, data: &[u8], signature: &SignedDigest) -> bool {
        signature.algorithm == SIGNATURE_ALGORITHM && self.sign(data).value == signature.value
    }
}

/// A signature over a root record.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct SignedDigest {
    /// The algorithm that produced the signature.
    pub algorithm: String,
    /// The hex signature.
    pub value: String,
}

/// The device key file name inside the audit store root.
pub const DEVICE_KEY_FILE: &str = "device.key";

/// Returns the device key path for an audit store root.
#[must_use]
pub fn device_key_path(root: &Path) -> PathBuf {
    root.join(DEVICE_KEY_FILE)
}

/// Loads the device key, creating it from OS randomness when absent.
///
/// # Errors
/// Returns [`AuditError::DeviceKey`] when the key is missing on a read-only
/// path, is the wrong length, or is readable by group or other. The key is
/// never created world-readable, and an existing over-permissive key is refused
/// rather than used.
pub fn load_or_create_device_key(root: &Path) -> Result<DeviceKey, AuditError> {
    let path = device_key_path(root);
    if path.exists() {
        return load_device_key(&path);
    }
    let mut bytes = [0u8; DEVICE_KEY_LEN];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    fs::create_dir_all(root).map_err(|error| AuditError::io(root, &error))?;
    write_private_file(&path, &bytes)?;
    load_device_key(&path)
}

/// Loads an existing device key without creating one.
///
/// # Errors
/// Returns [`AuditError::DeviceKey`] when the key is absent or fails
/// validation.
pub fn load_device_key(path: &Path) -> Result<DeviceKey, AuditError> {
    let metadata = fs::metadata(path)
        .map_err(|error| AuditError::DeviceKey(format!("{}: {error}", path.display())))?;
    reject_group_or_other_access(path, &metadata, 0o077)?;
    let raw = fs::read(path)
        .map_err(|error| AuditError::DeviceKey(format!("{}: {error}", path.display())))?;
    if raw.len() != DEVICE_KEY_LEN {
        return Err(AuditError::DeviceKey(format!(
            "{}: expected {DEVICE_KEY_LEN} bytes, found {}",
            path.display(),
            raw.len()
        )));
    }
    let mut bytes = [0u8; DEVICE_KEY_LEN];
    bytes.copy_from_slice(&raw);
    Ok(DeviceKey::from_bytes(bytes))
}

/// Writes `bytes` to `path` with owner-only permissions, atomically.
fn write_private_file(path: &Path, bytes: &[u8]) -> Result<(), AuditError> {
    let temp = path.with_extension("new");
    {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp)
            .map_err(|error| AuditError::io(&temp, &error))?;
        set_owner_only(&temp)?;
        file.write_all(bytes)
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data())
            .map_err(|error| AuditError::io(&temp, &error))?;
    }
    fs::rename(&temp, path).map_err(|error| AuditError::io(path, &error))
}

/// Sets a **file** to owner-only access (0600).
pub(crate) fn set_owner_only(path: &Path) -> Result<(), AuditError> {
    set_mode(path, 0o600)
}

/// Sets a **directory** to owner-only access (0700). A directory needs the
/// execute bit to be traversable, so it must not share the file mode.
pub(crate) fn set_dir_owner_only(path: &Path) -> Result<(), AuditError> {
    set_mode(path, 0o700)
}

fn set_mode(path: &Path, mode: u32) -> Result<(), AuditError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = fs::Permissions::from_mode(mode);
        fs::set_permissions(path, mode).map_err(|error| AuditError::io(path, &error))?;
    }
    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }
    Ok(())
}

/// Refuses a path whose mode grants any access beyond its owner.
pub(crate) fn reject_group_or_other_access(
    path: &Path,
    metadata: &fs::Metadata,
    forbidden: u32,
) -> Result<(), AuditError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = metadata.permissions().mode() & 0o777;
        if mode & forbidden != 0 {
            return Err(AuditError::UnsafePath {
                path: path.to_path_buf(),
                reason: format!("mode {:04o} grants access beyond its owner", mode),
            });
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (path, metadata, forbidden);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn signature_round_trips_and_rejects_a_wrong_key() {
        let key = DeviceKey::from_bytes([1u8; DEVICE_KEY_LEN]);
        let other = DeviceKey::from_bytes([2u8; DEVICE_KEY_LEN]);
        let data = b"segment root bytes";
        let signature = key.sign(data);
        assert!(key.verify(data, &signature));
        assert!(!other.verify(data, &signature));
        assert!(!key.verify(b"different bytes", &signature));
    }

    #[test]
    fn signature_from_another_algorithm_is_refused() {
        let key = DeviceKey::from_bytes([3u8; DEVICE_KEY_LEN]);
        let data = b"segment root bytes";
        let mut signature = key.sign(data);
        signature.algorithm = "unsigned".to_owned();
        assert!(!key.verify(data, &signature));
    }

    #[test]
    fn debug_never_renders_key_material() {
        let key = DeviceKey::from_bytes([9u8; DEVICE_KEY_LEN]);
        let rendered = format!("{key:?}");
        assert!(!rendered.contains("09"), "{rendered}");
    }

    #[test]
    fn key_is_created_owner_only_and_reloadable() {
        let dir = tempfile::tempdir().unwrap();
        let key = load_or_create_device_key(dir.path()).unwrap();
        let again = load_or_create_device_key(dir.path()).unwrap();
        assert!(key.verify(b"x", &again.sign(b"x")));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(device_key_path(dir.path()))
                .unwrap()
                .permissions()
                .mode()
                & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    #[cfg(unix)]
    fn a_group_readable_key_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        load_or_create_device_key(dir.path()).unwrap();
        let path = device_key_path(dir.path());
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let error = load_device_key(&path).unwrap_err();
        assert!(matches!(error, AuditError::UnsafePath { .. }), "{error}");
    }

    #[test]
    fn a_wrong_length_key_is_refused() {
        let dir = tempfile::tempdir().unwrap();
        let path = device_key_path(dir.path());
        fs::write(&path, b"too-short").unwrap();
        set_owner_only(&path).unwrap();
        assert!(matches!(
            load_device_key(&path).unwrap_err(),
            AuditError::DeviceKey(_)
        ));
    }
}
