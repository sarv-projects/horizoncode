//! Durable, bounded HostKernel journal for LSP/DAP process IO acknowledgements
//! and replayable typed events. A PREPARED row recovered after restart is UNKNOWN;
//! it never authorizes another write to the old process generation.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
#[cfg(unix)]
use std::{fs::{self, OpenOptions}, io::Write, os::unix::fs::{MetadataExt, OpenOptionsExt}, sync::atomic::{AtomicU64, Ordering}};
use std::path::{Path, PathBuf};

const FILE_NAME: &str = "execution-protocol-io.v1.json";
const MAX_FILE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROCESSES: usize = 256;
const MAX_OPS_PER_PROCESS: usize = 512;
const MAX_EVENTS_PER_PROCESS: usize = 64;
const MAX_EVENT_BYTES: usize = 1024 * 1024;
const MAX_EVENTS_BYTES: usize = 1024 * 1024;
#[cfg(unix)]
static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum ProtocolIoStateV1 { Prepared, Dispatched, Unknown }

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProtocolIoIntentV1 {
    pub(crate) request_sequence: u64,
    pub(crate) process_io_sequence: u64,
    pub(crate) operation_digest: String,
    pub(crate) effect_id: String,
    pub(crate) challenge_id: String,
    pub(crate) capability_id: String,
    pub(crate) lease_digest: String,
    pub(crate) frame_digest: String,
    pub(crate) frame_bytes: u64,
    #[serde(default)]
    pub(crate) reply_correlation_digest: Option<String>,
    pub(crate) state: ProtocolIoStateV1,
    pub(crate) receipt: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProtocolEventV1 {
    pub(crate) event_sequence: u64,
    pub(crate) process_io_sequence: u64,
    pub(crate) digest: String,
    pub(crate) event: serde_json::Value,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct ProtocolProcessJournalV1 {
    pub(crate) execution_id: String,
    pub(crate) generation: u64,
    pub(crate) owner_epoch: u64,
    pub(crate) process_kind: String,
    pub(crate) profile_id: String,
    pub(crate) profile_revision: u64,
    pub(crate) profile_digest: String,
    pub(crate) executable_digest: String,
    pub(crate) principal: String,
    pub(crate) session_id: String,
    pub(crate) location_id: String,
    pub(crate) workspace_revision: String,
    pub(crate) next_request_sequence: u64,
    pub(crate) process_io_sequence: u64,
    pub(crate) next_event_sequence: u64,
    pub(crate) earliest_event_sequence: u64,
    pub(crate) unknown: bool,
    pub(crate) operations: BTreeMap<u64, ProtocolIoIntentV1>,
    pub(crate) events: Vec<ProtocolEventV1>,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ProtocolJournalFileV1 { version: u64, processes: BTreeMap<String, ProtocolProcessJournalV1> }

pub(crate) struct ProtocolIoJournalV1 {
    path: PathBuf,
    processes: BTreeMap<String, ProtocolProcessJournalV1>,
    integrity_lost: bool,
}

impl ProtocolIoJournalV1 {
    pub(crate) fn open(state_dir: &Path) -> Self {
        let path = state_dir.join(FILE_NAME);
        #[cfg(unix)]
        {
            match read_file(&path) {
                Ok(processes) => {
                    let mut journal = Self { path, processes, integrity_lost: false };
                    // Any operation whose ACK was not durably settled before the
                    // prior owner stopped is uncertain and must never be replayed.
                    let mut changed = false;
                    for process in journal.processes.values_mut() {
                        for intent in process.operations.values_mut() {
                            if intent.state != ProtocolIoStateV1::Dispatched {
                                intent.state = ProtocolIoStateV1::Unknown;
                                process.unknown = true;
                                changed = true;
                            }
                        }
                        // The supervisor does not survive HostKernel restart. Even a
                        // fully journaled generation is now unavailable for IO.
                        if !process.unknown { process.unknown = true; changed = true; }
                    }
                    if changed && journal.flush().is_err() { journal.integrity_lost = true; }
                    journal
                }
                Err(_) => Self { path, processes: BTreeMap::new(), integrity_lost: true },
            }
        }
        #[cfg(not(unix))]
        { Self { path, processes: BTreeMap::new(), integrity_lost: true } }
    }

    pub(crate) fn integrity_lost(&self) -> bool { self.integrity_lost }
    pub(crate) fn process(&self, execution_id: &str) -> Option<&ProtocolProcessJournalV1> { self.processes.get(execution_id) }

    pub(crate) fn register_process(&mut self, entry: ProtocolProcessJournalV1) -> Result<(), ()> {
        if self.integrity_lost || entry.execution_id.is_empty() || entry.generation == 0
            || entry.owner_epoch == 0 || entry.operations.len() > MAX_OPS_PER_PROCESS
            || entry.events.len() > MAX_EVENTS_PER_PROCESS
        { return Err(()); }
        if let Some(old) = self.processes.get(&entry.execution_id) {
            if old.generation != entry.generation || old.owner_epoch != entry.owner_epoch
                || old.profile_digest != entry.profile_digest || old.executable_digest != entry.executable_digest
                || old.principal != entry.principal || old.session_id != entry.session_id
                || old.location_id != entry.location_id || old.workspace_revision != entry.workspace_revision
            { return Err(()); }
            return Ok(());
        }
        if self.processes.len() >= MAX_PROCESSES { return Err(()); }
        self.processes.insert(entry.execution_id.clone(), entry);
        self.flush()
    }

    /// Persist the immutable operation intent before lease consumption or process IO.
    /// Returns an existing identical settled receipt on idempotent retry.
    pub(crate) fn prepare_operation(&mut self, execution_id: &str, mut intent: ProtocolIoIntentV1) -> Result<Option<serde_json::Value>, ()> {
        if self.integrity_lost { return Err(()); }
        let process = self.processes.get_mut(execution_id).ok_or(())?;
        if process.unknown { return Err(()); }
        if let Some(existing) = process.operations.get(&intent.request_sequence) {
            if existing.operation_digest != intent.operation_digest || existing.frame_digest != intent.frame_digest
                || existing.effect_id != intent.effect_id || existing.challenge_id != intent.challenge_id
                || existing.capability_id != intent.capability_id || existing.lease_digest != intent.lease_digest
                || existing.reply_correlation_digest != intent.reply_correlation_digest
            { process.unknown = true; self.flush()?; return Err(()); }
            if existing.state == ProtocolIoStateV1::Dispatched { return Ok(existing.receipt.clone()); }
            process.unknown = true;
            self.flush()?;
            return Err(());
        }
        if process.operations.len() >= MAX_OPS_PER_PROCESS
            || intent.request_sequence != process.next_request_sequence
            || intent.process_io_sequence != process.process_io_sequence.checked_add(1).ok_or(())?
            || intent.state != ProtocolIoStateV1::Prepared
            || intent.receipt.is_some()
        { return Err(()); }
        if let Some(correlation) = &intent.reply_correlation_digest {
            if process.operations.values().any(|prior| prior.reply_correlation_digest.as_ref() == Some(correlation)) {
                process.unknown = true;
                self.flush()?;
                return Err(());
            }
        }
        process.next_request_sequence = intent.request_sequence.checked_add(1).ok_or(())?;
        process.process_io_sequence = intent.process_io_sequence;
        intent.state = ProtocolIoStateV1::Prepared;
        process.operations.insert(intent.request_sequence, intent);
        self.flush()?;
        Ok(None)
    }

    pub(crate) fn settle_operation(&mut self, execution_id: &str, request_sequence: u64, receipt: serde_json::Value) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let process = self.processes.get_mut(execution_id).ok_or(())?;
        let operation = process.operations.get_mut(&request_sequence).ok_or(())?;
        if process.unknown || operation.state != ProtocolIoStateV1::Prepared { return Err(()); }
        operation.state = ProtocolIoStateV1::Dispatched;
        operation.receipt = Some(receipt);
        self.flush()
    }

    pub(crate) fn append_events(&mut self, execution_id: &str, events: Vec<ProtocolEventV1>) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let process = self.processes.get_mut(execution_id).ok_or(())?;
        if process.unknown { return Err(()); }
        for event in events {
            if event.event_sequence != process.next_event_sequence || event.process_io_sequence > process.process_io_sequence
                || serde_json::to_vec(&event.event).map_err(|_| ())?.len() > MAX_EVENT_BYTES
            { process.unknown = true; self.flush()?; return Err(()); }
            process.next_event_sequence = process.next_event_sequence.checked_add(1).ok_or(())?;
            process.events.push(event);
        }
        while process.events.len() > MAX_EVENTS_PER_PROCESS
            || serialized_events_size(&process.events)? > MAX_EVENTS_BYTES
        {
            if process.events.is_empty() { break; }
            process.events.remove(0);
        }
        process.earliest_event_sequence = process.events.first().map(|event| event.event_sequence)
            .unwrap_or(process.next_event_sequence);
        self.flush()
    }

    pub(crate) fn events_after(&self, execution_id: &str, after: u64) -> Result<&[ProtocolEventV1], EventCursorErrorV1> {
        let process = self.processes.get(execution_id).ok_or(EventCursorErrorV1::Unavailable)?;
        if process.unknown { return Err(EventCursorErrorV1::Unknown); }
        if after >= process.next_event_sequence {
            return Err(EventCursorErrorV1::FutureCursor);
        }
        if after.checked_add(1).is_none_or(|next| next < process.earliest_event_sequence) {
            return Err(EventCursorErrorV1::ResnapshotRequired);
        }
        let offset = usize::try_from(after + 1 - process.earliest_event_sequence)
            .map_err(|_| EventCursorErrorV1::ResnapshotRequired)?;
        Ok(process.events.get(offset..).unwrap_or(&[]))
    }

    pub(crate) fn mark_unknown(&mut self, execution_id: &str) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let process = self.processes.get_mut(execution_id).ok_or(())?;
        process.unknown = true;
        for operation in process.operations.values_mut() {
            if operation.state == ProtocolIoStateV1::Prepared { operation.state = ProtocolIoStateV1::Unknown; }
        }
        self.flush()
    }

    #[cfg(unix)]
    fn flush(&mut self) -> Result<(), ()> {
        if self.integrity_lost { return Err(()); }
        let bytes = serde_json::to_vec(&ProtocolJournalFileV1 { version: 1, processes: self.processes.clone() }).map_err(|_| ())?;
        if bytes.len() > MAX_FILE_BYTES { self.integrity_lost = true; return Err(()); }
        let parent = self.path.parent().ok_or(())?;
        let temp = parent.join(format!(".execution-protocol-io.{}.{}.tmp", std::process::id(), NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed)));
        let mut file = OpenOptions::new().write(true).create_new(true).mode(0o600).custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(&temp).map_err(|_| ())?;
        if file.write_all(&bytes).and_then(|_| file.sync_all()).is_err() { let _ = fs::remove_file(&temp); return Err(()); }
        drop(file);
        if fs::rename(&temp, &self.path).is_err() { let _ = fs::remove_file(&temp); return Err(()); }
        let directory = OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC | libc::O_DIRECTORY | libc::O_NOFOLLOW).open(parent).map_err(|_| ())?;
        if directory.sync_all().is_err() { self.integrity_lost = true; return Err(()); }
        Ok(())
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EventCursorErrorV1 { Unavailable, Unknown, ResnapshotRequired, FutureCursor }

fn serialized_events_size(events: &[ProtocolEventV1]) -> Result<usize, ()> {
    serde_json::to_vec(events).map(|bytes| bytes.len()).map_err(|_| ())
}

#[cfg(unix)]
fn read_file(path: &Path) -> Result<BTreeMap<String, ProtocolProcessJournalV1>, ()> {
    use std::io::Read;
    let mut file = match OpenOptions::new().read(true).custom_flags(libc::O_CLOEXEC | libc::O_NOFOLLOW).open(path) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(BTreeMap::new()),
        Err(_) => return Err(()),
    };
    let metadata = file.metadata().map_err(|_| ())?;
    if !metadata.is_file() || metadata.len() > MAX_FILE_BYTES as u64 || metadata.mode() & 0o077 != 0 { return Err(()); }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    file.read_to_end(&mut bytes).map_err(|_| ())?;
    let journal: ProtocolJournalFileV1 = serde_json::from_slice(&bytes).map_err(|_| ())?;
    if journal.version != 1 || journal.processes.len() > MAX_PROCESSES { return Err(()); }
    for (id, process) in &journal.processes {
        if id != &process.execution_id || process.operations.len() > MAX_OPS_PER_PROCESS
            || process.events.len() > MAX_EVENTS_PER_PROCESS || serialized_events_size(&process.events)? > MAX_EVENTS_BYTES
            || process.events.iter().any(|event| event.event_sequence == 0 || event.event_sequence >= process.next_event_sequence)
        { return Err(()); }
    }
    Ok(journal.processes)
}

#[cfg(not(unix))]
fn read_file(_path: &Path) -> Result<BTreeMap<String, ProtocolProcessJournalV1>, ()> { Err(()) }
