//! The independent access-evidence stream (`ARCH/14-AUDIT.md` §Read
//! authorization and evidence, `REQ-AUDIT-008`, `DEC-044`).
//!
//! Reading the record is itself a security-relevant access, so the read must
//! leave evidence. That evidence **cannot** live in the chain it describes:
//! recording a read through the writer path would open the store, reconcile its
//! head, and repair a torn tail before anyone looked at it. This stream is
//! therefore separate in every respect that matters — its own file, its own
//! monotonic sequence, its own hash chain, and its own OS-backed lock — and it
//! carries no prompt, credential, or audit payload.
//!
//! A read whose access receipt cannot be persisted is refused: the disclosure
//! never happens, because an unrecorded read is not a disclosed read.

use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};

use crate::entry::Actor;
use crate::error::AuditError;
use crate::key::{reject_group_or_other_access, set_dir_owner_only, set_owner_only};
use crate::merkle::digest as digest_hex;
use crate::store::now_ms;

/// The default access-ledger directory name, beside the audit store.
pub const ACCESS_DIR: &str = "audit-access";
/// The access-receipt file name inside [`ACCESS_DIR`].
pub const ACCESS_FILE: &str = "access.jsonl";
/// The writer lock file name inside [`ACCESS_DIR`].
pub const ACCESS_LOCK: &str = "lock";

/// The domain separator for the access chain.
const ACCESS_CHAIN_TAG: &str = "horizoncode/audit/access/v1";

/// Returns the default access-ledger root beside `audit_root`.
#[must_use]
pub fn default_access_root(audit_root: &Path) -> PathBuf {
    match audit_root.parent() {
        Some(parent) => parent.join(ACCESS_DIR),
        None => audit_root.join(ACCESS_DIR),
    }
}

/// One recorded read of the audit record.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AccessReceipt {
    /// Monotonic sequence within the access stream.
    pub seq: u64,
    /// UTC epoch milliseconds.
    pub ts: i64,
    /// Who performed the read.
    pub actor: Actor,
    /// The surface that read the record (`audit_verify`, `audit_replay`, ...).
    pub action: String,
    /// The run/session scope or filter the read applied to.
    pub resource: String,
    /// The audit store root this read targeted.
    pub target: String,
    /// The audit head digest observed when the read started, when known.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_head_digest: Option<String>,
    /// The previous receipt's hash, so the stream is a chain.
    pub prev_hash: String,
    /// This receipt's hash: `blake3(tag || prev_hash || canonical body)`.
    pub entry_hash: String,
}

impl AccessReceipt {
    /// The genesis predecessor of an empty stream.
    pub const GENESIS: &'static str = "horizoncode/audit/access/genesis/v1";

    /// The hashed body, excluding `entry_hash` itself.
    fn body(&self) -> String {
        serde_json::json!({
            "seq": self.seq,
            "ts": self.ts,
            "actor": self.actor.as_str(),
            "action": self.action,
            "resource": self.resource,
            "target": self.target,
            "target_head_digest": self.target_head_digest,
            "prev_hash": self.prev_hash,
        })
        .to_string()
    }

    /// Returns the newline-terminated canonical line, hash field included.
    #[must_use]
    pub fn to_line(&self) -> String {
        let line = serde_json::to_string(self).expect("an access receipt serializes");
        format!("{line}\n")
    }
}

/// The writer of the access stream: own lock, own sequence, own chain.
#[derive(Debug)]
pub struct AccessLedger {
    root: PathBuf,
    file: PathBuf,
    /// The OS-backed writer lock, held for the ledger's lifetime.
    _lock: File,
    state: Mutex<AccessState>,
}

#[derive(Debug)]
struct AccessState {
    seq: u64,
    last_hash: String,
}

impl AccessLedger {
    /// Opens (creating if needed) the access ledger beside `audit_root`.
    ///
    /// # Errors
    /// Returns [`AuditError::UnsafePath`] when an existing ledger grants access
    /// beyond its owner, and [`AuditError::Io`] when it cannot be created or
    /// locked.
    pub fn open(audit_root: &Path) -> Result<Self, AuditError> {
        let root = default_access_root(audit_root);
        fs::create_dir_all(&root).map_err(|error| AuditError::io(&root, &error))?;
        set_dir_owner_only(&root)?;
        let file = root.join(ACCESS_FILE);
        if file.exists() {
            let metadata = fs::metadata(&file).map_err(|error| AuditError::io(&file, &error))?;
            if !metadata.is_file() {
                return Err(AuditError::UnsafePath {
                    path: file,
                    reason: "the access ledger is not a regular file".to_owned(),
                });
            }
            reject_group_or_other_access(&file, &metadata, 0o077)?;
        } else {
            OpenOptions::new()
                .append(true)
                .create_new(true)
                .open(&file)
                .map_err(|error| AuditError::io(&file, &error))?;
            set_owner_only(&file)?;
        }
        // The lock is advisory but OS-backed, so two readers cannot interleave
        // their sequence allocation.
        let lock_path = root.join(ACCESS_LOCK);
        let lock = open_locked(&lock_path)?;
        let (seq, last_hash) = tail(&file)?;
        Ok(Self {
            root,
            file,
            _lock: lock,
            state: Mutex::new(AccessState { seq, last_hash }),
        })
    }

    /// Returns the ledger root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.root
    }

    /// Records one read of the audit record, returning its receipt.
    ///
    /// # Errors
    /// Returns [`AuditError`] when the receipt cannot be persisted; the caller
    /// must then refuse to disclose anything.
    pub fn record(
        &self,
        action: &str,
        resource: &str,
        target_head_digest: Option<String>,
    ) -> Result<AccessReceipt, AuditError> {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        let receipt = AccessReceipt {
            seq: state.seq,
            ts: now_ms(),
            actor: Actor::System,
            action: action.to_owned(),
            resource: resource.to_owned(),
            target: self.file_label(),
            target_head_digest,
            prev_hash: state.last_hash.clone(),
            entry_hash: String::new(),
        };
        let mut receipt = receipt;
        receipt.entry_hash = digest_hex(
            format!("{ACCESS_CHAIN_TAG}{}{}", receipt.prev_hash, receipt.body()).as_bytes(),
        );
        let line = receipt.to_line();
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.file)
            .map_err(|error| AuditError::io(&self.file, &error))?;
        file.write_all(line.as_bytes())
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data())
            .map_err(|error| AuditError::io(&self.file, &error))?;
        state.seq += 1;
        state.last_hash = receipt.entry_hash.clone();
        Ok(receipt)
    }

    /// Reads every receipt, in order, verifying the chain as it goes.
    ///
    /// # Errors
    /// Returns [`AuditError`] when a line is not a receipt, or when a receipt's
    /// hash does not match the one it claims.
    pub fn receipts(&self) -> Result<Vec<AccessReceipt>, AuditError> {
        read_receipts(&self.file)
    }

    /// The audit-store path this ledger describes, for display.
    fn file_label(&self) -> String {
        self.root
            .parent()
            .map(|parent| parent.join("audit").to_string_lossy().into_owned())
            .unwrap_or_else(|| self.root.to_string_lossy().into_owned())
    }
}

/// Reads and chain-verifies an access ledger file.
pub fn read_receipts(path: &Path) -> Result<Vec<AccessReceipt>, AuditError> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AuditError::io(path, &error)),
    };
    let mut out = Vec::new();
    let mut expected_prev = AccessReceipt::GENESIS.to_owned();
    for (index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let receipt: AccessReceipt = serde_json::from_str(line).map_err(|error| {
            AuditError::Config(format!(
                "access receipt {} in {} is not valid: {error}",
                index + 1,
                path.display()
            ))
        })?;
        if receipt.seq != out.len() as u64 {
            return Err(AuditError::Config(format!(
                "access receipt {} in {} has seq {} where {} was expected",
                index + 1,
                path.display(),
                receipt.seq,
                out.len()
            )));
        }
        if receipt.prev_hash != expected_prev {
            return Err(AuditError::Config(format!(
                "access receipt {} in {} does not chain to its predecessor",
                index + 1,
                path.display()
            )));
        }
        let mut body = receipt.clone();
        body.entry_hash = String::new();
        let expected = digest_hex(
            format!("{ACCESS_CHAIN_TAG}{}{}", receipt.prev_hash, body.body()).as_bytes(),
        );
        if expected != receipt.entry_hash {
            return Err(AuditError::Config(format!(
                "access receipt {} in {} has a hash that does not match its contents",
                index + 1,
                path.display()
            )));
        }
        expected_prev = receipt.entry_hash.clone();
        out.push(receipt);
    }
    Ok(out)
}

fn tail(path: &Path) -> Result<(u64, String), AuditError> {
    let receipts = read_receipts(path)?;
    Ok(match receipts.last() {
        Some(receipt) => (receipt.seq + 1, receipt.entry_hash.clone()),
        None => (0, AccessReceipt::GENESIS.to_owned()),
    })
}

fn open_locked(path: &Path) -> Result<File, AuditError> {
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| AuditError::io(path, &error))?;
    set_owner_only(path)?;
    lock.try_lock().map_err(|error| AuditError::StoreLocked {
        path: path.to_path_buf(),
        reason: error.to_string(),
    })?;
    Ok(lock)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::store::AuditConfig;

    fn store() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn a_receipt_chains_and_is_readable() {
        let dir = store();
        let config = AuditConfig::new(dir.path().join("audit"));
        let first;
        let second;
        {
            let ledger = AccessLedger::open(&config.root).unwrap();
            first = ledger
                .record("audit_verify", "all", Some("head-1".to_owned()))
                .unwrap();
            second = ledger.record("audit_census", "-", None).unwrap();
        }
        assert_eq!(first.seq, 0);
        assert_eq!(first.prev_hash, AccessReceipt::GENESIS);
        assert_eq!(second.prev_hash, first.entry_hash);

        // The stream survives a reopen and still verifies. The writer lock is
        // released with the first handle, so a reopen is possible in-process
        // exactly as it is across processes.
        let reopened = AccessLedger::open(&config.root).unwrap();
        let receipts = reopened.receipts().unwrap();
        assert_eq!(receipts.len(), 2);
        assert_eq!(receipts[1].entry_hash, second.entry_hash);
        let next = reopened.record("audit_replay", "ses_1", None).unwrap();
        assert_eq!(next.seq, 2, "the sequence continues after a reopen");
    }

    #[test]
    fn the_ledger_lives_outside_the_chain_it_describes() {
        let dir = store();
        let config = AuditConfig::new(dir.path().join("audit"));
        let ledger = AccessLedger::open(&config.root).unwrap();
        ledger.record("audit_verify", "all", None).unwrap();
        assert!(ledger.root().ends_with(ACCESS_DIR));
        assert!(!ledger.root().starts_with(&config.root));
        // Recording a read creates nothing inside the audit store.
        assert!(!config.segments_dir().exists());
    }

    #[test]
    fn a_tampered_receipt_is_refused_by_the_reader() {
        let dir = store();
        let config = AuditConfig::new(dir.path().join("audit"));
        let ledger = AccessLedger::open(&config.root).unwrap();
        let receipt = ledger.record("audit_verify", "all", None).unwrap();
        let path = ledger.root().join(ACCESS_FILE);
        let mut raw = fs::read_to_string(&path).unwrap();
        raw = raw.replace("\"audit_verify\"", "\"audit_export\"");
        fs::write(&path, raw).unwrap();
        let error = read_receipts(&path).unwrap_err();
        assert!(
            error.to_string().contains("hash that does not match"),
            "{error}"
        );
        // The pre-tamper receipt still hashes to what it claimed.
        assert_eq!(receipt.seq, 0);
    }
}
