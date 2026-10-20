//! Owner-only crash journal for managed verifier authority.
//!
//! This is a bounded persistence helper, not an execution scheduler. HostKernel remains
//! the sole authority: each record is revalidated against the managed OwnerLog, the
//! immutable local verifier profile, the registered Location, and EffectHost's durable
//! intent/lease before it can mint an opaque invocation or reconcile an execution.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::fs::{self, File, OpenOptions};
#[cfg(unix)]
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::sync::atomic::{AtomicU64, Ordering};

const FILE_NAME: &str = "managed-verifier-journal.v1.json";
const FORMAT_VERSION: u64 = 1;
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ENTRIES: usize = 128;
#[cfg(unix)]
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(super) enum VerifierJournalStateV1 {
    AwaitingApproval,
    Approved,
    Dispatching,
    Unknown,
    Settled,
    Aborted,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VerifierJournalMemberV1 {
    pub(super) criterion_id: String,
    pub(super) challenge_id: String,
    pub(super) effect_id: String,
    /// Guard's approved intent digest. It must match EffectHost `argument_digest`.
    pub(super) guard_argument_digest: String,
    /// Host's canonical verifier argument bundle. It must match EffectHost `content_digest`.
    pub(super) canonical_content_digest: String,
    pub(super) expires_at_unix_ms: u64,
    /// Bounded canonical MessagePack encoding of the Guard-normalized targets.
    pub(super) normalized_targets_hex: String,
    pub(super) lease_digest: Option<String>,
    pub(super) execution_id: Option<String>,
    pub(super) execution_generation: Option<u64>,
    pub(super) state: VerifierJournalStateV1,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct VerifierJournalEntryV1 {
    pub(super) goal_id: String,
    pub(super) run_id: String,
    pub(super) spec_id: String,
    pub(super) spec_digest: String,
    pub(super) verification_run_id: String,
    /// Durable live Attempt binding for every verifier edge; empty legacy values fail closed.
    #[serde(default)]
    pub(super) attempt_id: String,
    pub(super) challenge_set_digest: String,
    pub(super) owner_epoch: u64,
    pub(super) cancel_generation: u64,
    pub(super) delivery_id: String,
    pub(super) reviewer_principal: String,
    pub(super) profile_id: String,
    pub(super) profile_digest: String,
    pub(super) location_id: String,
    pub(super) final_revision: String,
    pub(super) created_at_unix_ms: u64,
    pub(super) state: VerifierJournalStateV1,
    pub(super) members: Vec<VerifierJournalMemberV1>,
}

impl VerifierJournalEntryV1 {
    pub(super) fn requires_reconcile_only(&self) -> bool {
        matches!(
            self.state,
            VerifierJournalStateV1::Dispatching
                | VerifierJournalStateV1::Unknown
                | VerifierJournalStateV1::Settled
        ) && !self.members.is_empty()
            && self.members.iter().all(|member| {
                member.execution_id.is_some() == member.execution_generation.is_some()
            })
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalFileV1 {
    version: u64,
    entries: BTreeMap<String, VerifierJournalEntryV1>,
}

pub(super) struct VerifierJournalV1 {
    path: PathBuf,
    entries: BTreeMap<String, VerifierJournalEntryV1>,
    integrity_lost: bool,
    #[cfg(test)]
    fail_directory_sync_once: bool,
}

impl VerifierJournalV1 {
    pub(super) fn open(state_dir: &Path) -> Result<Self, String> {
        #[cfg(unix)]
        {
            let path = state_dir.join(FILE_NAME);
            let (entries, integrity_lost) = match read_entries(&path) {
                Ok(entries) => (entries, false),
                Err(_) => (BTreeMap::new(), true),
            };
            Ok(Self {
                path,
                entries,
                integrity_lost,
                #[cfg(test)]
                fail_directory_sync_once: false,
            })
        }
        #[cfg(not(unix))]
        {
            Ok(Self {
                path: state_dir.join(FILE_NAME),
                entries: BTreeMap::new(),
                integrity_lost: true,
                #[cfg(test)]
                fail_directory_sync_once: false,
            })
        }
    }

    pub(super) fn entries(&self) -> &BTreeMap<String, VerifierJournalEntryV1> {
        &self.entries
    }

    pub(super) fn entry(&self, verification_run_id: &str) -> Option<&VerifierJournalEntryV1> {
        self.entries.get(verification_run_id)
    }

    pub(super) fn integrity_lost(&self) -> bool {
        self.integrity_lost
    }

    pub(super) fn upsert(&mut self, entry: VerifierJournalEntryV1) -> Result<(), String> {
        if self.integrity_lost
            || entry.verification_run_id.is_empty()
            || entry.members.is_empty()
            || entry.members.len() > 32
            || (!self.entries.contains_key(&entry.verification_run_id)
                && (entry.state != VerifierJournalStateV1::AwaitingApproval
                    || entry
                        .members
                        .iter()
                        .any(|member| member.state != VerifierJournalStateV1::AwaitingApproval)))
            || (!self.entries.contains_key(&entry.verification_run_id)
                && self.entries.len() >= MAX_ENTRIES)
        {
            return Err("managed verifier journal bounds are exceeded".to_owned());
        }
        let key = entry.verification_run_id.clone();
        if let Some(previous) = self.entries.get(&key)
            && !valid_update(previous, &entry)
        {
            return Err("managed verifier journal state regression or rebinding".to_owned());
        }
        let previous = self.entries.insert(key.clone(), entry);
        if let Err(error) = self.flush() {
            if !self.integrity_lost {
                match previous {
                    Some(value) => {
                        self.entries.insert(key, value);
                    }
                    None => {
                        self.entries.remove(&key);
                    }
                }
            }
            return Err(error);
        }
        Ok(())
    }

    pub(super) fn remove(&mut self, verification_run_id: &str) -> Result<(), String> {
        if self.entries.get(verification_run_id).is_some_and(|entry| {
            !matches!(
                entry.state,
                VerifierJournalStateV1::Aborted | VerifierJournalStateV1::Settled
            )
        }) {
            return Err("managed verifier journal cannot drop unresolved authority".to_owned());
        }
        let Some(previous) = self.entries.remove(verification_run_id) else {
            return Ok(());
        };
        if let Err(error) = self.flush() {
            if !self.integrity_lost {
                self.entries
                    .insert(verification_run_id.to_owned(), previous);
            }
            return Err(error);
        }
        Ok(())
    }

    #[cfg(unix)]
    fn flush(&mut self) -> Result<(), String> {
        let bytes = serde_json::to_vec(&JournalFileV1 {
            version: FORMAT_VERSION,
            entries: self.entries.clone(),
        })
        .map_err(|_| "managed verifier journal could not be encoded".to_owned())?;
        if bytes.len() > MAX_FILE_BYTES {
            return Err("managed verifier journal exceeds its byte bound".to_owned());
        }
        let parent = self
            .path
            .parent()
            .ok_or_else(|| "managed verifier journal has no parent directory".to_owned())?;
        let temp = parent.join(format!(
            ".managed-verifier-journal.{}.{}.tmp",
            std::process::id(),
            NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)
        ));
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
            .open(&temp)
            .map_err(|_| "managed verifier journal temp file is unavailable".to_owned())?;
        let write_result = file
            .write_all(&bytes)
            .and_then(|_| file.sync_all())
            .map_err(|_| "managed verifier journal could not be durably written".to_owned());
        drop(file);
        if let Err(error) = write_result {
            let _ = fs::remove_file(&temp);
            return Err(error);
        }
        if fs::rename(&temp, &self.path).is_err() {
            let _ = fs::remove_file(&temp);
            return Err("managed verifier journal could not be atomically replaced".to_owned());
        }
        #[cfg(test)]
        let directory_sync_failed = if std::mem::take(&mut self.fail_directory_sync_once) {
            true
        } else {
            sync_parent_directory(parent).is_err()
        };
        #[cfg(not(test))]
        let directory_sync_failed = sync_parent_directory(parent).is_err();
        if directory_sync_failed {
            // rename already changed the durable namespace; callers cannot roll the
            // in-memory state back because the old file may no longer exist.
            self.integrity_lost = true;
            return Err("managed verifier journal directory sync failed".to_owned());
        }
        Ok(())
    }

    #[cfg(not(unix))]
    fn flush(&mut self) -> Result<(), String> {
        Err("managed verifier journal is unavailable on this platform".to_owned())
    }
}

fn valid_update(previous: &VerifierJournalEntryV1, next: &VerifierJournalEntryV1) -> bool {
    if previous.goal_id != next.goal_id
        || previous.run_id != next.run_id
        || previous.spec_id != next.spec_id
        || previous.spec_digest != next.spec_digest
        || previous.verification_run_id != next.verification_run_id
        || previous.challenge_set_digest != next.challenge_set_digest
        || previous.owner_epoch != next.owner_epoch
        || previous.cancel_generation != next.cancel_generation
        || previous.delivery_id != next.delivery_id
        || previous.reviewer_principal != next.reviewer_principal
        || previous.profile_id != next.profile_id
        || previous.profile_digest != next.profile_digest
        || previous.location_id != next.location_id
        || previous.final_revision != next.final_revision
        || previous.created_at_unix_ms != next.created_at_unix_ms
        || !transition_allowed(previous.state, next.state)
        || previous.members.len() != next.members.len()
    {
        return false;
    }
    previous
        .members
        .iter()
        .zip(&next.members)
        .all(|(old, new)| {
            old.criterion_id == new.criterion_id
                && old.challenge_id == new.challenge_id
                && old.effect_id == new.effect_id
                && old.guard_argument_digest == new.guard_argument_digest
                && old.canonical_content_digest == new.canonical_content_digest
                && old.expires_at_unix_ms == new.expires_at_unix_ms
                && old.normalized_targets_hex == new.normalized_targets_hex
                && monotone_optional(&old.lease_digest, &new.lease_digest)
                && monotone_optional(&old.execution_id, &new.execution_id)
                && monotone_optional(&old.execution_generation, &new.execution_generation)
                && transition_allowed(old.state, new.state)
        })
}

fn monotone_optional<T: PartialEq>(old: &Option<T>, new: &Option<T>) -> bool {
    old.as_ref().is_none_or(|value| Some(value) == new.as_ref())
}

fn transition_allowed(old: VerifierJournalStateV1, new: VerifierJournalStateV1) -> bool {
    use VerifierJournalStateV1::*;
    old == new
        || matches!(
            (old, new),
            (AwaitingApproval, Approved | Aborted | Unknown)
                | (Approved, Dispatching | Aborted | Unknown)
                | (Dispatching, Unknown | Settled)
                | (Unknown, Settled)
        )
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TempDir(PathBuf);

    impl TempDir {
        fn new() -> Self {
            let stamp = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "horizon-verifier-journal-{}-{stamp}",
                std::process::id()
            ));
            fs::create_dir(&path).expect("temporary directory creates");
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700))
                .expect("temporary directory is private");
            Self(path)
        }
    }

    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn entry(id: &str) -> VerifierJournalEntryV1 {
        VerifierJournalEntryV1 {
            goal_id: "goal-1".to_owned(),
            run_id: "run-1".to_owned(),
            spec_id: "spec-1".to_owned(),
            spec_digest: format!("blake3:{}", "a".repeat(64)),
            verification_run_id: id.to_owned(),
            attempt_id: "attempt-fixture".to_owned(),
            challenge_set_digest: format!("blake3:{}", "b".repeat(64)),
            owner_epoch: 1,
            cancel_generation: 2,
            delivery_id: "delivery-1".to_owned(),
            reviewer_principal: "server_auth:reviewer".to_owned(),
            profile_id: "profile-1".to_owned(),
            profile_digest: format!("blake3:{}", "c".repeat(64)),
            location_id: "loc_0000000000000000000000000000000000000000000000000000000000000000"
                .to_owned(),
            final_revision: format!("blake3:{}", "d".repeat(64)),
            created_at_unix_ms: 10,
            state: VerifierJournalStateV1::AwaitingApproval,
            members: vec![VerifierJournalMemberV1 {
                criterion_id: "tests-pass".to_owned(),
                challenge_id: "challenge-1".to_owned(),
                effect_id: "effect-1".to_owned(),
                guard_argument_digest: format!("blake3:{}", "e".repeat(64)),
                canonical_content_digest: format!("blake3:{}", "f".repeat(64)),
                expires_at_unix_ms: 20,
                normalized_targets_hex: "80".to_owned(),
                lease_digest: None,
                execution_id: None,
                execution_generation: None,
                state: VerifierJournalStateV1::AwaitingApproval,
            }],
        }
    }

    #[test]
    fn dispatching_invocation_survives_restart_and_cannot_regress_to_approval() {
        let directory = TempDir::new();
        let mut journal = VerifierJournalV1::open(&directory.0).unwrap();
        journal.upsert(entry("verification-1")).unwrap();
        let mut approved = journal.entry("verification-1").unwrap().clone();
        approved.state = VerifierJournalStateV1::Approved;
        approved.members[0].state = VerifierJournalStateV1::Approved;
        approved.members[0].lease_digest = Some(format!("blake3:{}", "1".repeat(64)));
        journal.upsert(approved).unwrap();
        let mut dispatching = journal.entry("verification-1").unwrap().clone();
        dispatching.state = VerifierJournalStateV1::Dispatching;
        dispatching.members[0].state = VerifierJournalStateV1::Dispatching;
        dispatching.members[0].execution_id = Some("execution-1".to_owned());
        dispatching.members[0].execution_generation = Some(1);
        journal.upsert(dispatching).unwrap();

        let recovered = VerifierJournalV1::open(&directory.0).unwrap();
        let record = recovered.entry("verification-1").unwrap();
        assert_eq!(record.state, VerifierJournalStateV1::Dispatching);
        assert_eq!(
            record.members[0].execution_id.as_deref(),
            Some("execution-1")
        );
        assert_eq!(record.members[0].execution_generation, Some(1));

        let mut regression = record.clone();
        regression.state = VerifierJournalStateV1::Approved;
        regression.members[0].state = VerifierJournalStateV1::Approved;
        assert!(
            recovered
                .entries
                .get("verification-1")
                .is_some_and(|old| !valid_update(old, &regression))
        );
        assert!(record.requires_reconcile_only());
    }

    #[test]
    fn only_persisted_possible_dispatches_are_reconcile_only() {
        let mut pending = entry("verification-pending");
        assert!(!pending.requires_reconcile_only());
        pending.state = VerifierJournalStateV1::Dispatching;
        assert!(pending.requires_reconcile_only());
        pending.members[0].execution_id = Some("execution-1".to_owned());
        pending.members[0].execution_generation = Some(1);
        assert!(pending.requires_reconcile_only());

        pending.state = VerifierJournalStateV1::Approved;
        assert!(!pending.requires_reconcile_only());
        pending.state = VerifierJournalStateV1::Unknown;
        assert!(pending.requires_reconcile_only());
        pending.state = VerifierJournalStateV1::Settled;
        assert!(pending.requires_reconcile_only());

        pending.members[0].execution_id = None;
        assert!(!pending.requires_reconcile_only());
    }

    #[test]
    fn directory_sync_failure_after_rename_quarantines_without_memory_rollback() {
        let directory = TempDir::new();
        let mut journal = VerifierJournalV1::open(&directory.0).unwrap();
        journal.fail_directory_sync_once = true;

        assert!(journal.upsert(entry("verification-uncertain")).is_err());
        assert!(journal.integrity_lost());
        assert!(journal.entry("verification-uncertain").is_some());
        assert!(journal.upsert(entry("verification-replay")).is_err());

        let reopened = VerifierJournalV1::open(&directory.0).unwrap();
        assert!(reopened.entry("verification-uncertain").is_some());
        assert!(reopened.entry("verification-replay").is_none());
    }

    #[test]
    fn journal_capacity_is_bounded_and_unknown_authority_cannot_be_removed() {
        let directory = TempDir::new();
        let mut journal = VerifierJournalV1::open(&directory.0).unwrap();
        for index in 0..MAX_ENTRIES {
            journal
                .upsert(entry(&format!("verification-{index}")))
                .unwrap();
        }
        assert!(journal.upsert(entry("verification-over-capacity")).is_err());
        assert!(journal.remove("verification-0").is_err());
    }

    #[test]
    fn corrupt_wrong_mode_symlink_and_oversized_journals_are_quarantined() {
        let corrupt = TempDir::new();
        let corrupt_path = corrupt.0.join(FILE_NAME);
        fs::write(&corrupt_path, b"not-json").unwrap();
        fs::set_permissions(&corrupt_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            VerifierJournalV1::open(&corrupt.0)
                .unwrap()
                .integrity_lost()
        );

        let wrong_mode = TempDir::new();
        let wrong_path = wrong_mode.0.join(FILE_NAME);
        fs::write(&wrong_path, b"{}").unwrap();
        fs::set_permissions(&wrong_path, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(
            VerifierJournalV1::open(&wrong_mode.0)
                .unwrap()
                .integrity_lost()
        );

        let oversized = TempDir::new();
        let oversized_path = oversized.0.join(FILE_NAME);
        fs::write(&oversized_path, vec![b' '; MAX_FILE_BYTES + 1]).unwrap();
        fs::set_permissions(&oversized_path, fs::Permissions::from_mode(0o600)).unwrap();
        assert!(
            VerifierJournalV1::open(&oversized.0)
                .unwrap()
                .integrity_lost()
        );

        let symlink = TempDir::new();
        let target = symlink.0.join("target");
        fs::write(&target, b"{}").unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&target, symlink.0.join(FILE_NAME)).unwrap();
        assert!(
            VerifierJournalV1::open(&symlink.0)
                .unwrap()
                .integrity_lost()
        );
    }
}

#[cfg(unix)]
fn sync_parent_directory(parent: &Path) -> std::io::Result<()> {
    File::open(parent)?.sync_all()
}

#[cfg(unix)]
fn read_entries(path: &Path) -> Result<BTreeMap<String, VerifierJournalEntryV1>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err("managed verifier journal cannot be inspected".to_owned()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
        || metadata.len() > MAX_FILE_BYTES as u64
    {
        return Err("managed verifier journal is not a private bounded regular file".to_owned());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW)
        .open(path)
        .map_err(|_| "managed verifier journal cannot be opened safely".to_owned())?;
    let opened = file
        .metadata()
        .map_err(|_| "managed verifier journal metadata is unavailable".to_owned())?;
    if opened.dev() != metadata.dev()
        || opened.ino() != metadata.ino()
        || opened.uid() != unsafe { libc::geteuid() }
        || opened.mode() & 0o077 != 0
        || opened.len() > MAX_FILE_BYTES as u64
    {
        return Err("managed verifier journal changed during secure open".to_owned());
    }
    let mut bytes = Vec::with_capacity(opened.len() as usize);
    file.take((MAX_FILE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "managed verifier journal could not be read".to_owned())?;
    if bytes.len() > MAX_FILE_BYTES {
        return Err("managed verifier journal exceeds its byte bound".to_owned());
    }
    let journal: JournalFileV1 = serde_json::from_slice(&bytes)
        .map_err(|_| "managed verifier journal is corrupt".to_owned())?;
    if journal.version != FORMAT_VERSION || journal.entries.len() > MAX_ENTRIES {
        return Err("managed verifier journal version or entry count is invalid".to_owned());
    }
    for (key, entry) in &journal.entries {
        if key != &entry.verification_run_id
            || entry.members.is_empty()
            || entry.members.len() > 32
            || entry.members.iter().any(|member| {
                member.criterion_id.is_empty()
                    || member.challenge_id.is_empty()
                    || member.effect_id.is_empty()
                    || member.normalized_targets_hex.len() > 128 * 1024
                    || member.execution_id.is_some() != member.execution_generation.is_some()
            })
        {
            return Err("managed verifier journal entry is invalid".to_owned());
        }
    }
    Ok(journal.entries)
}
