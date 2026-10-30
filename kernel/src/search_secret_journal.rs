//! Durable host-owned PREPARED/DISPATCHING/receipt journal for BYO search.
//! Secret bytes and SecretBroker leases never enter this store. A dispatch in
//! flight at restart is UNKNOWN and is never granted again.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::{fs::{self, OpenOptions}, io::Write, os::unix::fs::{MetadataExt, OpenOptionsExt}, sync::atomic::{AtomicU64, Ordering}};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "search-secret-attempts.v1.json";
const MAX_FILE_BYTES: usize = 4 * 1024 * 1024;
const MAX_ATTEMPTS: usize = 4096;
#[cfg(unix)]
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum SearchSecretAttemptStateV1 { Prepared, Dispatching, Settled, Unknown, Aborted }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchSecretAttemptV1 {
    pub(crate) attempt_ref: String,
    pub(crate) attempt_digest: String,
    pub(crate) principal: String,
    pub(crate) session_id: String,
    pub(crate) location_id: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) lease_digest: String,
    pub(crate) attempt_scope_digest: Option<String>,
    pub(crate) secret_ref: String,
    pub(crate) route_key: String,
    pub(crate) attempt: u8,
    pub(crate) provider_id: String,
    pub(crate) operation_digest: String,
    pub(crate) destination: String,
    pub(crate) expires_at_unix_ms: u64,
    pub(crate) state: SearchSecretAttemptStateV1,
    pub(crate) created_at_unix_ms: u64,
    pub(crate) receipt: Option<serde_json::Value>,
    /// Present only when this one-use route belongs to a HostKernel-owned
    /// resumable aggregate. The aggregate cursor, never the caller, chooses it.
    #[serde(default)]
    pub(crate) cascade_ref: Option<String>,
    #[serde(default)]
    pub(crate) cascade_digest: Option<String>,
    #[serde(default)]
    pub(crate) route_index: Option<u8>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct SearchCascadeProgressV1 {
    pub(crate) cascade_ref: String,
    pub(crate) cascade_digest: String,
    pub(crate) principal: String,
    pub(crate) session_id: String,
    pub(crate) location_id: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) lease_digest: String,
    pub(crate) attempt_scope_digest: Option<String>,
    pub(crate) owner_epoch: u64,
    pub(crate) approved_arguments_digest: String,
    pub(crate) route_plan_digest: String,
    pub(crate) query_digest: String,
    pub(crate) limit: u8,
    /// Exact optional domain filter from the Guard-approved arguments. `None`
    /// and `Some([])` are distinct request shapes and must survive pause/resume.
    #[serde(default)]
    pub(crate) domains: Option<Vec<String>>,
    /// Opaque SecretBroker references from Guard-approved arguments; never key bytes.
    pub(crate) credential_refs: BTreeMap<String, String>,
    /// Fixed ordered route keys from the Guard-approved plan.
    pub(crate) routes: Vec<String>,
    /// Index of the single PREPARED route the Core sender may dispatch.
    pub(crate) route_index: u8,
    pub(crate) attempt: u8,
    pub(crate) active_attempt_ref: String,
    pub(crate) active_attempt_digest: String,
    /// Settled receipt digest for the active route, present only at resume.
    pub(crate) settled_receipt_digest: Option<String>,
    #[serde(default)]
    pub(crate) last_receipt_digest: Option<String>,
    #[serde(default)]
    pub(crate) aggregate_receipt_digest: Option<String>,
    /// Bounded route projections accumulated across pause/resume turns. No body
    /// content, credential material, or transport header is retained here.
    #[serde(default)]
    pub(crate) attempts: Vec<serde_json::Value>,
    /// Exact metadata-only authorization returned with the active PREPARED
    /// attempt, retained for lossless cursor projection after RPC response loss.
    #[serde(default)]
    pub(crate) next_route_projection: Option<serde_json::Value>,
    /// State is terminal on UNKNOWN; Core cannot choose fallback or retry.
    pub(crate) state: SearchCascadeStateV1,
    pub(crate) updated_at_unix_ms: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum SearchCascadeStateV1 { Prepared, AwaitingReceipt, Running, Succeeded, Exhausted, Failed, Cancelled, Unknown }

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct JournalFileV1 {
    version: u64,
    attempts: BTreeMap<String, SearchSecretAttemptV1>,
    #[serde(default)]
    cascades: BTreeMap<String, SearchCascadeProgressV1>,
}

pub(crate) struct SearchSecretAttemptJournalV1 {
    path: PathBuf,
    attempts: BTreeMap<String, SearchSecretAttemptV1>,
    cascades: BTreeMap<String, SearchCascadeProgressV1>,
    integrity_lost: bool,
}

impl SearchSecretAttemptJournalV1 {
    pub(crate) fn open(state_dir: &Path) -> Self {
        let path = state_dir.join(FILE_NAME);
        #[cfg(unix)]
        {
            match read_file(&path) {
                Ok((mut attempts, mut cascades)) => {
                    let mut changed = false;
                    for attempt in attempts.values_mut() {
                        match attempt.state {
                            SearchSecretAttemptStateV1::Prepared => {
                                attempt.state = SearchSecretAttemptStateV1::Aborted;
                                changed = true;
                            }
                            SearchSecretAttemptStateV1::Dispatching => {
                                attempt.state = SearchSecretAttemptStateV1::Unknown;
                                changed = true;
                            }
                            _ => {}
                        }
                    }
                    for cascade in cascades.values_mut() {
                        if !matches!(cascade.state, SearchCascadeStateV1::Succeeded | SearchCascadeStateV1::Exhausted | SearchCascadeStateV1::Failed | SearchCascadeStateV1::Cancelled | SearchCascadeStateV1::Unknown) {
                            cascade.state = SearchCascadeStateV1::Unknown;
                            changed = true;
                        }
                    }
                    let mut journal = Self { path, attempts, cascades, integrity_lost: false };
                    if changed && journal.flush().is_err() { journal.integrity_lost = true; }
                    journal
                }
                Err(_) => Self { path, attempts: BTreeMap::new(), cascades: BTreeMap::new(), integrity_lost: true },
            }
        }
        #[cfg(not(unix))]
        { Self { path, attempts: BTreeMap::new(), cascades: BTreeMap::new(), integrity_lost: true } }
    }

    pub(crate) fn integrity_lost(&self) -> bool { self.integrity_lost }
    pub(crate) fn get(&self, attempt_ref: &str) -> Option<&SearchSecretAttemptV1> { self.attempts.get(attempt_ref) }
    pub(crate) fn cascade(&self, cascade_ref: &str) -> Option<&SearchCascadeProgressV1> { self.cascades.get(cascade_ref) }

    pub(crate) fn begin_cascade_dispatch(&mut self, cascade_ref: &str, cascade_digest: &str, attempt_ref: &str, attempt_digest: &str) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let cascade = self.cascades.get_mut(cascade_ref).ok_or(())?;
        if cascade.cascade_digest != cascade_digest || cascade.active_attempt_ref != attempt_ref
            || cascade.active_attempt_digest != attempt_digest || cascade.state != SearchCascadeStateV1::Prepared
        { return Err(()); }
        cascade.state = SearchCascadeStateV1::AwaitingReceipt;
        self.flush()
    }

    pub(crate) fn note_cascade_settlement(&mut self, cascade_ref: &str, cascade_digest: &str, attempt_ref: &str, attempt_digest: &str, receipt_digest: &str, now_ms: u64) -> Result<(), ()> {
        if self.integrity_lost || !receipt_digest.starts_with("blake3:") || receipt_digest.len() != 71 { return Err(()); }
        let cascade = self.cascades.get_mut(cascade_ref).ok_or(())?;
        if cascade.cascade_digest != cascade_digest || cascade.active_attempt_ref != attempt_ref
            || cascade.active_attempt_digest != attempt_digest || cascade.state != SearchCascadeStateV1::AwaitingReceipt
            || cascade.settled_receipt_digest.is_some()
        { return Err(()); }
        cascade.settled_receipt_digest = Some(receipt_digest.to_owned());
        cascade.updated_at_unix_ms = now_ms;
        self.flush()
    }

    pub(crate) fn finish_cascade(&mut self, cascade_ref: &str, cascade_digest: &str, state: SearchCascadeStateV1, aggregate_receipt_digest: Option<&str>, attempts: Option<Vec<serde_json::Value>>, now_ms: u64) -> Result<(), ()> {
        if self.integrity_lost || !matches!(state, SearchCascadeStateV1::Succeeded | SearchCascadeStateV1::Exhausted | SearchCascadeStateV1::Failed | SearchCascadeStateV1::Cancelled | SearchCascadeStateV1::Unknown) { return Err(()); }
        let cascade = self.cascades.get_mut(cascade_ref).ok_or(())?;
        if cascade.cascade_digest != cascade_digest || cascade.state != SearchCascadeStateV1::AwaitingReceipt
            || (state != SearchCascadeStateV1::Cancelled && cascade.settled_receipt_digest.is_none()) { return Err(()); }
        if attempts.as_ref().is_some_and(|items| items.len() > 20
            || items.iter().any(|item| serde_json::to_vec(item).map_or(true, |bytes| bytes.len() > 4 * 1024)))
        { return Err(()); }
        cascade.state = state;
        cascade.aggregate_receipt_digest = aggregate_receipt_digest.map(str::to_owned);
        if cascade.settled_receipt_digest.is_some() {
            cascade.last_receipt_digest = cascade.settled_receipt_digest.clone();
        }
        if let Some(attempts) = attempts {
            cascade.attempts = attempts;
        }
        cascade.updated_at_unix_ms = now_ms;
        self.flush()
    }

    pub(crate) fn cancel_cascade(
        &mut self,
        cascade_ref: &str,
        cascade_digest: &str,
        aggregate_receipt_digest: Option<&str>,
        now_ms: u64,
    ) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let cascade = self.cascades.get(cascade_ref).cloned().ok_or(())?;
        if cascade.cascade_digest != cascade_digest || !matches!(cascade.state, SearchCascadeStateV1::Prepared | SearchCascadeStateV1::AwaitingReceipt) { return Err(()); }
        if cascade.state == SearchCascadeStateV1::Prepared {
            if aggregate_receipt_digest.is_some_and(|digest| !(digest.starts_with("blake3:") && digest.len() == 71)) {
                return Err(());
            }
            let attempt = self.attempts.get_mut(&cascade.active_attempt_ref).ok_or(())?;
            if attempt.attempt_digest != cascade.active_attempt_digest || attempt.state != SearchSecretAttemptStateV1::Prepared { return Err(()); }
            attempt.state = SearchSecretAttemptStateV1::Aborted;
        } else if aggregate_receipt_digest.is_some() {
            return Err(());
        }
        let cursor = self.cascades.get_mut(cascade_ref).ok_or(())?;
        if cascade.state == SearchCascadeStateV1::Prepared {
            cursor.state = if aggregate_receipt_digest.is_some() { SearchCascadeStateV1::Cancelled } else { SearchCascadeStateV1::Unknown };
            cursor.aggregate_receipt_digest = aggregate_receipt_digest.map(str::to_owned);
        } else {
            cursor.state = SearchCascadeStateV1::Unknown;
        }
        cursor.updated_at_unix_ms = now_ms;
        self.flush()
    }

    /// Durably install the one active aggregate cursor before Core can dispatch
    /// the prepared route. Duplicate refs and malformed order are rejected.
    pub(crate) fn prepare_cascade(&mut self, progress: SearchCascadeProgressV1) -> Result<(), ()> {
        if self.integrity_lost || self.cascades.len() >= MAX_ATTEMPTS
            || !valid_cascade(&progress) || self.cascades.contains_key(&progress.cascade_ref)
        { return Err(()); }
        let attempt = self.attempts.get(&progress.active_attempt_ref).ok_or(())?;
        if attempt.attempt_digest != progress.active_attempt_digest
            || attempt.cascade_ref.as_deref() != Some(&progress.cascade_ref)
            || attempt.cascade_digest.as_deref() != Some(&progress.cascade_digest)
            || attempt.route_index != Some(progress.route_index)
            || attempt.state != SearchSecretAttemptStateV1::Prepared
        { return Err(()); }
        self.cascades.insert(progress.cascade_ref.clone(), progress);
        self.flush()
    }

    /// Replace a cursor only after HostKernel has validated the exact durable
    /// receipt and selected the next route. UNKNOWN is terminal.
    pub(crate) fn advance_cascade(&mut self, expected_digest: &str, progress: SearchCascadeProgressV1) -> Result<(), ()> {
        if self.integrity_lost || !valid_cascade(&progress) { return Err(()); }
        let current = self.cascades.get(&progress.cascade_ref).ok_or(())?;
        if current.cascade_digest != expected_digest
            || current.state != SearchCascadeStateV1::AwaitingReceipt
            || progress.route_index < current.route_index
            || (progress.route_index == current.route_index && progress.attempt != current.attempt.saturating_add(1))
            || (progress.route_index > current.route_index
                && (progress.route_index != current.route_index.saturating_add(1) || progress.attempt != 1))
            || current.principal != progress.principal || current.session_id != progress.session_id
            || current.location_id != progress.location_id || current.effect_id != progress.effect_id
            || current.challenge_id != progress.challenge_id || current.lease_digest != progress.lease_digest
            || current.approved_arguments_digest != progress.approved_arguments_digest
            || current.route_plan_digest != progress.route_plan_digest || current.routes != progress.routes
            || current.query_digest != progress.query_digest || current.limit != progress.limit
            || current.credential_refs != progress.credential_refs
            || current.owner_epoch != progress.owner_epoch
            || current.attempt_scope_digest != progress.attempt_scope_digest
        { return Err(()); }
        let mut progress = progress;
        if progress.last_receipt_digest.is_none() { progress.last_receipt_digest = current.settled_receipt_digest.clone(); }
        let attempt = self.attempts.get(&progress.active_attempt_ref).ok_or(())?;
        if attempt.attempt_digest != progress.active_attempt_digest
            || attempt.cascade_ref.as_deref() != Some(&progress.cascade_ref)
            || attempt.cascade_digest.as_deref() != Some(&progress.cascade_digest)
            || attempt.route_index != Some(progress.route_index)
            || attempt.state != SearchSecretAttemptStateV1::Prepared
        { return Err(()); }
        self.cascades.insert(progress.cascade_ref.clone(), progress);
        self.flush()
    }

    pub(crate) fn prepare(&mut self, attempt: SearchSecretAttemptV1) -> Result<(), ()> {
        if self.integrity_lost || self.attempts.len() >= MAX_ATTEMPTS
            || attempt.attempt_ref.is_empty() || attempt.attempt_digest.is_empty()
            || !(1..=2).contains(&attempt.attempt)
            || attempt.state != SearchSecretAttemptStateV1::Prepared || attempt.receipt.is_some()
            || self.attempts.contains_key(&attempt.attempt_ref)
        { return Err(()); }
        self.attempts.insert(attempt.attempt_ref.clone(), attempt);
        self.flush()
    }

    /// One-use durable transition performed immediately before provider send.
    pub(crate) fn begin(&mut self, attempt_ref: &str, digest: &str) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let attempt = self.attempts.get_mut(attempt_ref).ok_or(())?;
        if attempt.attempt_digest != digest || attempt.state != SearchSecretAttemptStateV1::Prepared {
            return Err(());
        }
        attempt.state = SearchSecretAttemptStateV1::Dispatching;
        self.flush()
    }

    pub(crate) fn settle(&mut self, attempt_ref: &str, digest: &str, receipt: serde_json::Value) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let attempt = self.attempts.get_mut(attempt_ref).ok_or(())?;
        if attempt.attempt_digest != digest || attempt.state != SearchSecretAttemptStateV1::Dispatching {
            return Err(());
        }
        attempt.state = SearchSecretAttemptStateV1::Settled;
        attempt.receipt = Some(receipt);
        self.flush()
    }

    pub(crate) fn mark_unknown(&mut self, attempt_ref: &str, digest: &str) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let attempt = self.attempts.get_mut(attempt_ref).ok_or(())?;
        if attempt.attempt_digest != digest || attempt.state != SearchSecretAttemptStateV1::Dispatching {
            return Err(());
        }
        attempt.state = SearchSecretAttemptStateV1::Unknown;
        self.flush()
    }

    #[cfg(unix)]
    fn flush(&mut self) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let bytes = serde_json::to_vec(&JournalFileV1 { version: 2, attempts: self.attempts.clone(), cascades: self.cascades.clone() }).map_err(|_| ())?;
        if bytes.len() > MAX_FILE_BYTES { self.integrity_lost = true; return Err(()); }
        let parent = self.path.parent().ok_or(())?;
        let temp = parent.join(format!(".search-secret-attempts.{}.{}.tmp", std::process::id(), NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)));
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600)
            .custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(&temp).map_err(|_| ())?;
        if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() { let _ = fs::remove_file(&temp); return Err(()); }
        drop(file);
        if fs::rename(&temp, &self.path).is_err() { let _ = fs::remove_file(&temp); return Err(()); }
        let directory = OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW)
            .open(parent).map_err(|_| ())?;
        if directory.sync_all().is_err() { self.integrity_lost = true; return Err(()); }
        Ok(())
    }
}

#[cfg(unix)]
fn read_file(path: &Path) -> Result<(BTreeMap<String, SearchSecretAttemptV1>, BTreeMap<String, SearchCascadeProgressV1>), ()> {
    use std::io::Read;
    let mut file = match OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok((BTreeMap::new(), BTreeMap::new())),
        Err(_) => return Err(()),
    };
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES as u64 || metadata.mode() & 0o077 != 0 { return Err(()); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(|_| ())?;
    let journal: JournalFileV1 = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if !matches!(journal.version, 1 | 2) || journal.attempts.len() > MAX_ATTEMPTS || journal.cascades.len() > MAX_ATTEMPTS
        || journal.attempts.iter().any(|(key, attempt)| key != &attempt.attempt_ref || !valid_attempt(attempt))
        || journal.cascades.iter().any(|(key, cascade)| key != &cascade.cascade_ref || !valid_cascade(cascade)) { return Err(()); }
    Ok((journal.attempts, journal.cascades))
}

#[cfg(not(unix))]
fn read_file(_path: &Path) -> Result<(BTreeMap<String, SearchSecretAttemptV1>, BTreeMap<String, SearchCascadeProgressV1>), ()> { Err(()) }

fn valid_attempt(attempt: &SearchSecretAttemptV1) -> bool {
    let short_id = |value: &str| !value.is_empty() && value.len() <= 256
        && !value.bytes().any(|byte| byte.is_ascii_control());
    let digest = |value: &str, prefix: &str| value.strip_prefix(prefix).is_some_and(|hex|
        hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()));
    short_id(&attempt.attempt_ref) && digest(&attempt.attempt_digest, "blake3:")
        && short_id(&attempt.principal) && short_id(&attempt.session_id) && short_id(&attempt.location_id)
        && short_id(&attempt.effect_id) && short_id(&attempt.challenge_id) && digest(&attempt.lease_digest, "blake3:")
        && matches!(attempt.route_key.as_str(), "brave" | "exa" | "youcom" | "tavily" | "firecrawl" | "parallel")
        && (1..=2).contains(&attempt.attempt) && short_id(&attempt.provider_id)
        && digest(&attempt.operation_digest, "sha256:") && short_id(&attempt.destination)
        && short_id(&attempt.secret_ref) && attempt.expires_at_unix_ms > attempt.created_at_unix_ms
        && (attempt.state == SearchSecretAttemptStateV1::Settled) == attempt.receipt.is_some()
        && attempt.receipt.as_ref().is_none_or(|receipt| serde_json::to_vec(receipt).is_ok_and(|bytes| bytes.len() <= 16 * 1024))
        && attempt.cascade_ref.as_ref().is_none_or(|value| short_id(value))
        && attempt.cascade_digest.as_ref().is_none_or(|value| digest(value, "blake3:"))
        && attempt.route_index.is_none_or(|value| value < 10)
        && (attempt.cascade_ref.is_some() == attempt.cascade_digest.is_some())
        && (attempt.cascade_ref.is_some() == attempt.route_index.is_some())
}

fn valid_cascade(cascade: &SearchCascadeProgressV1) -> bool {
    let short = |value: &str| !value.is_empty() && value.len() <= 256 && !value.bytes().any(|b| b.is_ascii_control());
    let digest = |value: &str| value.strip_prefix("blake3:").is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
    // V1 has five anonymous-free and six separately enabled routes. Retired or
    // legacy route keys are invalid for continuation, so persisted cursors can
    // never revive a route that current HostKernel admission no longer allows.
    let route = |value: &str| crate::http_execution::is_search_route_key(value);
    short(&cascade.cascade_ref) && digest(&cascade.cascade_digest) && short(&cascade.principal)
        && short(&cascade.session_id) && short(&cascade.location_id) && short(&cascade.effect_id)
        && short(&cascade.challenge_id) && digest(&cascade.lease_digest)
        && cascade.attempt_scope_digest.as_ref().is_none_or(|value| digest(value))
        && cascade.owner_epoch > 0
        && digest(&cascade.approved_arguments_digest) && digest(&cascade.route_plan_digest)
        && digest(&cascade.query_digest) && (1..=10).contains(&cascade.limit)
        && cascade.domains.as_ref().is_none_or(|domains| domains.len() <= 100
            && domains.iter().all(|value| valid_search_domain(value))
            && domains.iter().collect::<std::collections::BTreeSet<_>>().len() == domains.len())
        && cascade.credential_refs.len() <= 6
        && cascade.credential_refs.iter().all(|(route, reference)| matches!(route.as_str(), "brave" | "exa" | "youcom" | "tavily" | "firecrawl" | "parallel")
            && !reference.is_empty() && reference.len() <= 256
            && reference.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte)))
        && !cascade.routes.is_empty() && cascade.routes.len() <= 10
        && cascade.routes.iter().all(|value| route(value))
        && cascade.routes.iter().collect::<std::collections::BTreeSet<_>>().len() == cascade.routes.len()
        && usize::from(cascade.route_index) < cascade.routes.len()
        && (1..=2).contains(&cascade.attempt) && short(&cascade.active_attempt_ref)
        && digest(&cascade.active_attempt_digest)
        && cascade.settled_receipt_digest.as_ref().is_none_or(|value| digest(value))
        && cascade.last_receipt_digest.as_ref().is_none_or(|value| digest(value))
        && cascade.aggregate_receipt_digest.as_ref().is_none_or(|value| digest(value))
        && cascade.attempts.len() <= 20
        && cascade.attempts.iter().all(|item| serde_json::to_vec(item).is_ok_and(|bytes| bytes.len() <= 4 * 1024))
        && cascade.next_route_projection.as_ref().is_none_or(|item| serde_json::to_vec(item).is_ok_and(|bytes| bytes.len() <= 32 * 1024))
}

fn valid_search_domain(value: &str) -> bool {
    if value.is_empty() || value.len() > 253 || !value.is_ascii() { return false; }
    let domain = value.strip_prefix("*.").unwrap_or(value);
    if domain.is_empty() || domain.contains('*') { return false; }
    domain.split('.').all(|label| {
        let bytes = label.as_bytes();
        !bytes.is_empty() && bytes.len() <= 63
            && bytes[0].is_ascii_alphanumeric()
            && bytes[bytes.len() - 1].is_ascii_alphanumeric()
            && bytes.iter().all(|byte| byte.is_ascii_alphanumeric() || *byte == b'-')
    })
}
