//! Canonical V2 owner-log codecs and committed-head filesystem storage.
//!
//! The head is the sole commit authority. Replay validates canonical bytes, segment seals,
//! owner sequence, and delivery identity before exposing committed records.

use crate::owner_log_index::{IndexedDelivery, OwnerIndex, OwnerIndexRebuild};
use crate::protocol::CursorV1;
use serde_json::{Map, Number, Value};
use std::error::Error;
use std::fmt;
use std::fmt::Write as _;
use std::fs::{self, File, OpenOptions, TryLockError};
use std::io::{self, Read, Write};
use std::num::NonZeroUsize;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
#[cfg(windows)]
use std::os::windows::ffi::OsStrExt;

pub const OWNER_LOG_FORMAT_VERSION_V2: u16 = 2;
pub const OWNER_EVENT_SCHEMA_VERSION_V1: u16 = 1;
pub const MAX_OWNER_RECORD_BYTES: usize = 1024 * 1024;
pub const MAX_OWNER_SEGMENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OWNER_METADATA_BYTES: usize = 64 * 1024;
pub const MAX_OWNER_BATCH_EVENTS: usize = 16_384;
pub const MAX_OWNER_READ_BATCH_EVENTS: usize = 4096;
pub const MAX_OWNER_READ_BATCH_BYTES: usize = MAX_OWNER_SEGMENT_BYTES;

const MAX_JSON_NESTING_DEPTH: usize = 64;
const MAX_JSON_NODES: usize = 32_768;
const MAX_IDENTIFIER_BYTES: usize = 256;
const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum OwnerLogError {
    InvalidOwner(&'static str),
    InvalidRecord(&'static str),
    InvalidMetadata(&'static str),
    InvalidDigest,
    UnsupportedFormatVersion(u64),
    LimitExceeded(&'static str),
    JsonEncoding,
    Io {
        operation: &'static str,
        kind: io::ErrorKind,
    },
    OwnerBusy,
    OwnerMismatch,
    ProfileMismatch,
    CursorConflict,
    ReplayConflict,
    CommandDigestMismatch,
    DurabilityUnavailable,
    StoragePermissionsUnavailable,
    IndexUnavailable,
    UnsupportedSchemaVersion(u16),
    EmptyBatch,
    UnknownStorageEntry,
    CorruptCommittedLog(&'static str),
    Fenced,
    #[cfg(test)]
    InjectedFailure,
}

impl fmt::Display for OwnerLogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidOwner(reason) => write!(formatter, "invalid owner identity: {reason}"),
            Self::InvalidRecord(reason) => write!(formatter, "invalid owner-log record: {reason}"),
            Self::InvalidMetadata(reason) => {
                write!(formatter, "invalid owner-log metadata: {reason}")
            }
            Self::InvalidDigest => formatter.write_str("invalid or mismatched BLAKE3 digest"),
            Self::UnsupportedFormatVersion(version) => {
                write!(formatter, "unsupported owner-log format version {version}")
            }
            Self::LimitExceeded(limit) => write!(formatter, "owner-log {limit} limit exceeded"),
            Self::JsonEncoding => formatter.write_str("canonical JSON encoding failed"),
            Self::Io { operation, kind } => write!(formatter, "{operation} failed: {kind}"),
            Self::OwnerBusy => formatter.write_str("owner stream is already open"),
            Self::OwnerMismatch => {
                formatter.write_str("owner head does not match the requested owner")
            }
            Self::ProfileMismatch => {
                formatter.write_str("owner head durability profile does not match")
            }
            Self::CursorConflict => {
                formatter.write_str("owner cursor does not match committed history")
            }
            Self::ReplayConflict => {
                formatter.write_str("delivery ID was already committed with another digest")
            }
            Self::CommandDigestMismatch => {
                formatter.write_str("command digest does not match canonical command bytes")
            }
            Self::DurabilityUnavailable => {
                formatter.write_str("requested durability profile is unavailable")
            }
            Self::StoragePermissionsUnavailable => {
                formatter.write_str("owner-log state root is not owner-private")
            }
            Self::IndexUnavailable => {
                formatter.write_str("rebuildable owner lookup index is unavailable")
            }
            Self::UnsupportedSchemaVersion(version) => {
                write!(
                    formatter,
                    "unsupported owner event schema version {version}"
                )
            }
            Self::EmptyBatch => {
                formatter.write_str("owner command must contain at least one event")
            }
            Self::UnknownStorageEntry => {
                formatter.write_str("owner directory contains an unknown storage entry")
            }
            Self::CorruptCommittedLog(reason) => {
                write!(formatter, "committed owner history is corrupt: {reason}")
            }
            Self::Fenced => {
                formatter.write_str("owner stream requires close and recovery before further use")
            }
            #[cfg(test)]
            Self::InjectedFailure => formatter.write_str("injected owner-log commit failure"),
        }
    }
}

impl Error for OwnerLogError {}

fn io_error(operation: &'static str, error: io::Error) -> OwnerLogError {
    OwnerLogError::Io {
        operation,
        kind: error.kind(),
    }
}

#[cfg(test)]
fn injected_sync_error() -> io::Error {
    io::Error::other("injected synchronization failure")
}

/// A BLAKE3 digest represented as exactly 32 bytes internally and lowercase hex on disk.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct Digest([u8; 32]);

impl Digest {
    pub const ZERO: Self = Self([0; 32]);

    pub const fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn parse_hex(value: &str) -> Result<Self, OwnerLogError> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(OwnerLogError::InvalidDigest);
        }

        let mut bytes = [0; 32];
        for (index, pair) in value.as_bytes().as_chunks::<2>().0.iter().enumerate() {
            let high = hex_nibble(pair[0]).ok_or(OwnerLogError::InvalidDigest)?;
            let low = hex_nibble(pair[1]).ok_or(OwnerLogError::InvalidDigest)?;
            bytes[index] = (high << 4) | low;
        }
        Ok(Self(bytes))
    }

    pub fn from_blake3(bytes: &[u8]) -> Self {
        Self(*blake3::hash(bytes).as_bytes())
    }

    pub fn to_hex(self) -> String {
        let mut output = String::with_capacity(64);
        for byte in self.0 {
            write!(&mut output, "{byte:02x}").expect("writing to String cannot fail");
        }
        output
    }

    pub const fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

fn hex_nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        _ => None,
    }
}

/// Owner identity validated independently of filesystem paths.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerIdentity {
    kind: String,
    id: String,
}

impl OwnerIdentity {
    pub fn new(kind: String, id: String) -> Result<Self, OwnerLogError> {
        validate_identity_component(&kind, "kind")?;
        validate_identity_component(&id, "id")?;
        Ok(Self { kind, id })
    }

    pub fn kind(&self) -> &str {
        &self.kind
    }

    pub fn id(&self) -> &str {
        &self.id
    }

    /// Lowercase BLAKE3 key over length-prefixed UTF-8 owner fields.
    pub fn directory_key(&self) -> String {
        let mut preimage = Vec::with_capacity(8 + self.kind.len() + self.id.len());
        preimage.extend_from_slice(&(self.kind.len() as u32).to_be_bytes());
        preimage.extend_from_slice(self.kind.as_bytes());
        preimage.extend_from_slice(&(self.id.len() as u32).to_be_bytes());
        preimage.extend_from_slice(self.id.as_bytes());
        Digest::from_blake3(&preimage).to_hex()
    }
}

fn validate_identity_component(value: &str, field: &'static str) -> Result<(), OwnerLogError> {
    if value.is_empty() {
        return Err(OwnerLogError::InvalidOwner("components must be non-empty"));
    }
    if value.len() > MAX_IDENTIFIER_BYTES {
        return Err(OwnerLogError::LimitExceeded(field));
    }
    Ok(())
}

/// One validated event command before it is assigned a stream sequence.
#[derive(Clone, Debug, PartialEq)]
pub struct OwnerEventInput {
    pub schema_version: u16,
    pub time_ms: u64,
    pub kind: String,
    pub data: Value,
    pub delivery_id: Option<String>,
    pub command_digest: Option<String>,
}

impl OwnerEventInput {
    /// Builds the versioned physical `data` object, keeping command identity in the same
    /// committed record as the event payload.
    pub fn physical_data(&self) -> Result<Value, OwnerLogError> {
        if self.schema_version == 0 {
            return Err(OwnerLogError::InvalidRecord(
                "schema version must be nonzero",
            ));
        }
        if self.time_ms > MAX_SAFE_INTEGER {
            return Err(OwnerLogError::InvalidRecord(
                "event time exceeds the safe integer range",
            ));
        }
        validate_kind(&self.kind)?;
        validate_json(&self.data)?;
        let Value::Object(payload) = canonicalize_json(self.data.clone())? else {
            return Err(OwnerLogError::InvalidRecord(
                "event payload must be an object",
            ));
        };

        match (&self.delivery_id, &self.command_digest) {
            (Some(delivery_id), Some(command_digest)) => {
                validate_identity_component(delivery_id, "delivery ID")?;
                parse_wire_digest(command_digest)?;
            }
            (None, None) => {}
            _ => {
                return Err(OwnerLogError::InvalidRecord(
                    "delivery ID and command digest must be present together",
                ));
            }
        }

        let mut data = Map::new();
        if let Some(command_digest) = &self.command_digest {
            data.insert(
                "commandDigest".to_owned(),
                Value::String(command_digest.clone()),
            );
        }
        if let Some(delivery_id) = &self.delivery_id {
            data.insert("deliveryId".to_owned(), Value::String(delivery_id.clone()));
        }
        data.insert("payload".to_owned(), Value::Object(payload));
        data.insert(
            "schemaVersion".to_owned(),
            Value::Number(Number::from(self.schema_version)),
        );
        canonicalize_json(Value::Object(data))
    }
}

fn parse_wire_digest(value: &str) -> Result<Digest, OwnerLogError> {
    value
        .strip_prefix("blake3:")
        .ok_or(OwnerLogError::InvalidDigest)
        .and_then(Digest::parse_hex)
}

/// Canonical physical event record. `event_digest` is over the record with that field
/// omitted; `encode_record` verifies it before producing the JSONL line.
#[derive(Clone, Debug, PartialEq)]
pub struct PhysicalRecordV2 {
    pub format_version: u16,
    pub seq: u64,
    pub time_ms: u64,
    pub kind: String,
    pub data: Value,
    pub previous_digest: Digest,
    pub event_digest: Digest,
}

impl PhysicalRecordV2 {
    pub fn new(
        seq: u64,
        time_ms: u64,
        kind: String,
        data: Value,
        previous_digest: Digest,
    ) -> Result<Self, OwnerLogError> {
        let data = canonicalize_json(data)?;
        let mut record = Self {
            format_version: OWNER_LOG_FORMAT_VERSION_V2,
            seq,
            time_ms,
            kind,
            data,
            previous_digest,
            event_digest: Digest::ZERO,
        };
        record.event_digest = OwnerLogV2::event_digest(&record)?;
        Ok(record)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DurabilityProfile {
    InteractiveOnly,
    RunDurable,
}

impl DurabilityProfile {
    fn as_str(self) -> &'static str {
        match self {
            Self::InteractiveOnly => "interactive_only",
            Self::RunDurable => "run_durable",
        }
    }
}

/// Authoritative committed-prefix metadata. The head digest excludes its own field.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OwnerHeadV2 {
    pub format_version: u16,
    pub owner_kind: String,
    pub owner_id: String,
    pub schema_version: u16,
    pub generation: u64,
    pub durability_profile: DurabilityProfile,
    pub committed_seq: u64,
    pub committed_event_digest: Digest,
    pub active_segment_id: u64,
    pub committed_offset: u64,
    pub head_digest: Digest,
}

impl OwnerHeadV2 {
    #[allow(clippy::too_many_arguments)]
    pub fn new(
        owner: &OwnerIdentity,
        schema_version: u16,
        generation: u64,
        durability_profile: DurabilityProfile,
        committed_seq: u64,
        committed_event_digest: Digest,
        active_segment_id: u64,
        committed_offset: u64,
    ) -> Result<Self, OwnerLogError> {
        let mut head = Self {
            format_version: OWNER_LOG_FORMAT_VERSION_V2,
            owner_kind: owner.kind.clone(),
            owner_id: owner.id.clone(),
            schema_version,
            generation,
            durability_profile,
            committed_seq,
            committed_event_digest,
            active_segment_id,
            committed_offset,
            head_digest: Digest::ZERO,
        };
        head.head_digest = OwnerLogV2::head_digest(&head)?;
        Ok(head)
    }
}

/// Seal metadata for one immutable committed segment prefix.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SegmentSealV2 {
    format_version: u16,
    segment_id: u64,
    committed_offset: u64,
    first_seq: u64,
    last_seq: u64,
    record_count: u64,
    last_event_digest: Digest,
    segment_digest: Digest,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CommitReceiptV1 {
    pub delivery_id: String,
    pub command_digest: String,
    pub owner_cursor: CursorV1,
    pub event_count: u64,
    pub receipt_digest: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ReadBatchV1 {
    pub events: Vec<PhysicalRecordV2>,
    pub cursor: Option<CursorV1>,
    pub has_more: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct SegmentSummary {
    pub(crate) segment_id: u64,
    pub(crate) committed_offset: u64,
    pub(crate) first_seq: u64,
    pub(crate) last_seq: u64,
    pub(crate) record_count: u64,
    pub(crate) last_event_digest: Digest,
    pub(crate) previous_seq: u64,
    pub(crate) previous_digest: Digest,
    pub(crate) sealed: bool,
}

struct ReplaySummary {
    active_segment: Option<SegmentSummary>,
    active_has_tail: bool,
    active_sealed: bool,
    max_segment_id: u64,
}

#[cfg(test)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum CommitFailPoint {
    SegmentAppend,
    SegmentSync,
    SegmentDirectorySync,
    HeadTempWrite,
    HeadTempSync,
    HeadReplace,
    HeadDirectorySync,
}

static NEXT_TEMP_FILE_ID: AtomicU64 = AtomicU64::new(0);

impl SegmentSealV2 {
    pub fn new(
        segment_id: u64,
        committed_offset: u64,
        first_seq: u64,
        last_seq: u64,
        record_count: u64,
        last_event_digest: Digest,
        committed_prefix: &[u8],
    ) -> Result<Self, OwnerLogError> {
        if committed_prefix.is_empty() || committed_prefix.len() > MAX_OWNER_SEGMENT_BYTES {
            return Err(OwnerLogError::LimitExceeded("sealed segment bytes"));
        }
        if committed_prefix.len() as u64 != committed_offset {
            return Err(OwnerLogError::InvalidMetadata(
                "segment offset must equal the committed prefix length",
            ));
        }
        let seal = Self {
            format_version: OWNER_LOG_FORMAT_VERSION_V2,
            segment_id,
            committed_offset,
            first_seq,
            last_seq,
            record_count,
            last_event_digest,
            segment_digest: Digest::from_blake3(committed_prefix),
        };
        validate_seal(&seal)?;
        Ok(seal)
    }

    pub const fn segment_id(&self) -> u64 {
        self.segment_id
    }

    pub const fn committed_offset(&self) -> u64 {
        self.committed_offset
    }

    pub const fn first_seq(&self) -> u64 {
        self.first_seq
    }

    pub const fn last_seq(&self) -> u64 {
        self.last_seq
    }

    pub const fn record_count(&self) -> u64 {
        self.record_count
    }

    pub const fn last_event_digest(&self) -> Digest {
        self.last_event_digest
    }

    pub const fn segment_digest(&self) -> Digest {
        self.segment_digest
    }
}

/// Canonical V2 owner stream with one process-held owner lock and a committed head.
pub struct OwnerLogV2 {
    directory: PathBuf,
    owner: OwnerIdentity,
    profile: DurabilityProfile,
    _lock_file: File,
    head: OwnerHeadV2,
    index: Option<OwnerIndex>,
    active_segment: Option<SegmentSummary>,
    active_has_tail: bool,
    active_sealed: bool,
    next_segment_id: Option<u64>,
    fenced: bool,
    #[cfg(test)]
    failpoint: Option<CommitFailPoint>,
}

impl OwnerLogV2 {
    /// Computes the v1 command identity over the delivery ID and ordered canonical events.
    pub fn command_digest(
        delivery_id: &str,
        events: &[OwnerEventInput],
    ) -> Result<String, OwnerLogError> {
        validate_identity_component(delivery_id, "delivery ID")?;
        if events.is_empty() {
            return Err(OwnerLogError::EmptyBatch);
        }
        if events.len() > MAX_OWNER_BATCH_EVENTS {
            return Err(OwnerLogError::LimitExceeded("command event count"));
        }
        let mut encoded = Vec::with_capacity(256);
        encoded.extend_from_slice(b"{\"deliveryId\":");
        let encoded_delivery_id = serde_json::to_vec(&Value::String(delivery_id.to_owned()))
            .map_err(|_| OwnerLogError::JsonEncoding)?;
        append_bounded(&mut encoded, &encoded_delivery_id, MAX_OWNER_SEGMENT_BYTES)?;
        encoded.extend_from_slice(b",\"events\":[");
        for (index, event) in events.iter().enumerate() {
            if let Some(event_delivery_id) = &event.delivery_id
                && event_delivery_id != delivery_id
            {
                return Err(OwnerLogError::CommandDigestMismatch);
            }
            if event.delivery_id.is_some() != event.command_digest.is_some() {
                return Err(OwnerLogError::InvalidRecord(
                    "delivery ID and command digest must be present together",
                ));
            }

            let mut payload_event = event.clone();
            payload_event.delivery_id = None;
            payload_event.command_digest = None;
            let data = payload_event.physical_data()?;
            let mut item = Map::new();
            item.insert("data".to_owned(), data);
            item.insert("kind".to_owned(), Value::String(event.kind.clone()));
            item.insert(
                "timeMs".to_owned(),
                Value::Number(Number::from(event.time_ms)),
            );
            let canonical_event = canonicalize_json(Value::Object(item))?;
            let encoded_event =
                serde_json::to_vec(&canonical_event).map_err(|_| OwnerLogError::JsonEncoding)?;
            if encoded_event.len() > MAX_OWNER_RECORD_BYTES {
                return Err(OwnerLogError::LimitExceeded("command event bytes"));
            }
            if index > 0 {
                append_bounded(&mut encoded, b",", MAX_OWNER_SEGMENT_BYTES)?;
            }
            append_bounded(&mut encoded, &encoded_event, MAX_OWNER_SEGMENT_BYTES)?;
        }
        append_bounded(
            &mut encoded,
            b"],\"format\":\"horizon.owner-command.v1\"}",
            MAX_OWNER_SEGMENT_BYTES,
        )?;
        let digest = format!("blake3:{}", Digest::from_blake3(&encoded).to_hex());

        for event in events {
            if let Some(supplied) = &event.command_digest
                && parse_wire_digest(supplied)? != parse_wire_digest(&digest)?
            {
                return Err(OwnerLogError::CommandDigestMismatch);
            }
        }
        Ok(digest)
    }

    /// Opens one owner beneath a trusted, owner-private state root. Windows currently
    /// fails closed until trusted state-root DACL validation is integrated.
    pub fn open(
        root: &Path,
        owner: OwnerIdentity,
        profile: DurabilityProfile,
    ) -> Result<Self, OwnerLogError> {
        Self::open_internal(root, owner, profile)
    }

    fn open_internal(
        root: &Path,
        owner: OwnerIdentity,
        profile: DurabilityProfile,
    ) -> Result<Self, OwnerLogError> {
        if profile == DurabilityProfile::RunDurable && !platform_can_sync_directory() {
            return Err(OwnerLogError::DurabilityUnavailable);
        }
        if !platform_can_validate_private_storage() {
            return Err(OwnerLogError::StoragePermissionsUnavailable);
        }

        ensure_directory_tree(root, profile, true)?;
        let owners_directory = root.join("owners");
        ensure_directory(&owners_directory, profile, true)?;
        let directory = owners_directory.join(owner.directory_key());
        ensure_directory(&directory, profile, true)?;
        let lock_path = directory.join("owner.lock");
        let lock_file = open_lock_file(&lock_path)?;
        match lock_file.try_lock() {
            Ok(()) => {}
            Err(TryLockError::WouldBlock) => return Err(OwnerLogError::OwnerBusy),
            Err(TryLockError::Error(error)) => return Err(io_error("lock owner stream", error)),
        }

        if profile == DurabilityProfile::RunDurable {
            sync_directory(&directory).map_err(|_| OwnerLogError::DurabilityUnavailable)?;
        }

        let (max_segment_id, has_segment_data) = inspect_owner_directory(&directory)?;
        let mut index = OwnerIndex::open(&directory)?;
        let mut index_rebuild = index.begin_rebuild()?;
        let head_path = directory.join("head.json");
        let head = match read_optional_bounded(&head_path, MAX_OWNER_METADATA_BYTES)? {
            Some(bytes) => {
                let head = decode_head(&bytes)?;
                if head.owner_kind != owner.kind || head.owner_id != owner.id {
                    return Err(OwnerLogError::OwnerMismatch);
                }
                if head.durability_profile != profile {
                    return Err(OwnerLogError::ProfileMismatch);
                }
                if head.schema_version != OWNER_EVENT_SCHEMA_VERSION_V1 {
                    return Err(OwnerLogError::UnsupportedSchemaVersion(head.schema_version));
                }
                head
            }
            None if has_segment_data => {
                return Err(OwnerLogError::CorruptCommittedLog(
                    "segment data exists without a committed head",
                ));
            }
            None => {
                let initial = OwnerHeadV2::new(&owner, 1, 1, profile, 0, Digest::ZERO, 1, 0)?;
                publish_head(&directory, &initial, profile)?;
                initial
            }
        };

        let replay = replay_directory(&directory, &owner, &head, &mut index_rebuild)?;
        let delivery_filter = index_rebuild.finish(&head)?;
        index.set_delivery_filter(delivery_filter);
        let highest_segment = max_segment_id.max(replay.max_segment_id);
        let next_segment_id = if highest_segment == 0 {
            Some(1)
        } else {
            highest_segment.checked_add(1)
        };

        Ok(Self {
            directory,
            owner,
            profile,
            _lock_file: lock_file,
            head,
            index: Some(index),
            active_segment: replay.active_segment,
            active_has_tail: replay.active_has_tail,
            active_sealed: replay.active_sealed,
            next_segment_id,
            fenced: false,
            #[cfg(test)]
            failpoint: None,
        })
    }

    pub fn append_batch(
        &mut self,
        delivery_id: &str,
        command_digest: &str,
        events: &[OwnerEventInput],
        expected: Option<&CursorV1>,
    ) -> Result<CommitReceiptV1, OwnerLogError> {
        self.ensure_usable()?;
        if events.is_empty() {
            return Err(OwnerLogError::EmptyBatch);
        }
        validate_identity_component(delivery_id, "delivery ID")?;
        let supplied_digest = parse_wire_digest(command_digest)?;
        let computed_digest = Self::command_digest(delivery_id, events)?;
        if supplied_digest != parse_wire_digest(&computed_digest)? {
            return Err(OwnerLogError::CommandDigestMismatch);
        }

        self.verify_committed_state()?;

        if let Some(receipt) = self.delivery_receipt(delivery_id)? {
            if receipt.command_digest == command_digest {
                return Ok(receipt);
            }
            return Err(OwnerLogError::ReplayConflict);
        }

        if let Some(expected) = expected
            && !cursor_matches_head(expected, &self.owner, &self.head)?
        {
            return Err(OwnerLogError::CursorConflict);
        }

        if let Some(event) = events
            .iter()
            .find(|event| event.schema_version != OWNER_EVENT_SCHEMA_VERSION_V1)
        {
            return Err(OwnerLogError::UnsupportedSchemaVersion(
                event.schema_version,
            ));
        }
        let schema_version = events[0].schema_version;
        if self.head.committed_seq > 0 && schema_version != self.head.schema_version
            || events
                .iter()
                .any(|event| event.schema_version != schema_version)
        {
            return Err(OwnerLogError::InvalidRecord(
                "an owner batch must use one nonzero schema version",
            ));
        }

        let mut next_seq = self.head.committed_seq;
        let mut previous_digest = self.head.committed_event_digest;
        let mut records = Vec::with_capacity(events.len());
        let mut encoded_records = Vec::with_capacity(events.len());
        let mut total_bytes = 0usize;
        for event in events {
            if event
                .delivery_id
                .as_deref()
                .is_some_and(|id| id != delivery_id)
            {
                return Err(OwnerLogError::CommandDigestMismatch);
            }
            if event
                .command_digest
                .as_deref()
                .is_some_and(|digest| digest != command_digest)
            {
                return Err(OwnerLogError::CommandDigestMismatch);
            }
            let mut committed_event = event.clone();
            committed_event.delivery_id = Some(delivery_id.to_owned());
            committed_event.command_digest = Some(command_digest.to_owned());
            let data = committed_event.physical_data()?;
            next_seq = next_seq
                .checked_add(1)
                .ok_or(OwnerLogError::LimitExceeded("owner sequence"))?;
            let record = PhysicalRecordV2::new(
                next_seq,
                event.time_ms,
                event.kind.clone(),
                data,
                previous_digest,
            )?;
            let encoded = Self::encode_record(&record)?;
            total_bytes = total_bytes
                .checked_add(encoded.len())
                .ok_or(OwnerLogError::LimitExceeded("segment bytes"))?;
            if total_bytes > MAX_OWNER_SEGMENT_BYTES {
                return Err(OwnerLogError::LimitExceeded("segment bytes"));
            }
            previous_digest = record.event_digest;
            records.push(record);
            encoded_records.push(encoded);
        }

        let active = self.active_segment;
        let active_path = active.map(|summary| segment_path(&self.directory, summary.segment_id));
        let disk_active_len = match (&active_path, active) {
            (Some(path), Some(summary)) => {
                let metadata = fs::symlink_metadata(path)
                    .map_err(|error| io_error("inspect active owner segment", error))?;
                if !metadata.file_type().is_file() || metadata.len() < summary.committed_offset {
                    return Err(OwnerLogError::CorruptCommittedLog(
                        "active segment is missing or shorter than its committed prefix",
                    ));
                }
                metadata.len()
            }
            _ => 0,
        };
        let active_offset = active.map_or(0, |summary| summary.committed_offset);
        let new_active_offset = active_offset
            .checked_add(total_bytes as u64)
            .ok_or(OwnerLogError::LimitExceeded("segment bytes"))?;
        let rotate_segment = active.is_none()
            || self.active_has_tail
            || self.active_sealed
            || disk_active_len > active_offset
            || new_active_offset > MAX_OWNER_SEGMENT_BYTES as u64;
        let segment_id = if rotate_segment {
            self.next_segment_id
                .ok_or(OwnerLogError::LimitExceeded("segment ID"))?
        } else {
            active
                .expect("non-rotating append has an active segment")
                .segment_id
        };
        let committed_offset = if rotate_segment {
            total_bytes as u64
        } else {
            new_active_offset
        };
        let first_seq = active
            .filter(|_| !rotate_segment)
            .map_or(records[0].seq, |summary| summary.first_seq);
        let record_count = if rotate_segment {
            records.len() as u64
        } else {
            active
                .expect("non-rotating append has an active segment")
                .record_count
                .checked_add(records.len() as u64)
                .ok_or(OwnerLogError::LimitExceeded("segment record count"))?
        };
        let generation = self
            .head
            .generation
            .checked_add(1)
            .ok_or(OwnerLogError::LimitExceeded("head generation"))?;
        let new_head = OwnerHeadV2::new(
            &self.owner,
            schema_version,
            generation,
            self.profile,
            next_seq,
            previous_digest,
            segment_id,
            committed_offset,
        )?;
        let head_bytes = Self::encode_head(&new_head)?;
        let last_record = records.last().expect("nonempty batch was validated");
        let receipt = make_receipt(
            delivery_id,
            command_digest,
            &self.owner,
            last_record.seq,
            last_record.event_digest,
            records.len() as u64,
        )?;

        if rotate_segment
            && let Some(summary) = self.active_segment
            && let Err(error) = self.seal_active_segment(summary)
        {
            self.fenced = true;
            return Err(error);
        }

        let segment_path = segment_path(&self.directory, segment_id);
        let mut segment_file = if rotate_segment {
            let mut options = private_open_options();
            options
                .write(true)
                .create_new(true)
                .open(&segment_path)
                .map_err(|error| {
                    self.fenced = true;
                    io_error("create owner segment", error)
                })?
        } else {
            OpenOptions::new()
                .append(true)
                .open(&segment_path)
                .map_err(|error| {
                    self.fenced = true;
                    io_error("append owner segment", error)
                })?
        };
        if !rotate_segment
            && segment_file
                .metadata()
                .map_err(|error| io_error("inspect active owner segment", error))?
                .len()
                != active_offset
        {
            self.fenced = true;
            return Err(OwnerLogError::CorruptCommittedLog(
                "active segment changed while the owner lock was held",
            ));
        }

        for encoded in &encoded_records {
            let split = encoded.len() / 2;
            segment_file.write_all(&encoded[..split]).map_err(|error| {
                self.fenced = true;
                io_error("append owner segment", error)
            })?;
            #[cfg(test)]
            self.maybe_fail(CommitFailPoint::SegmentAppend)?;
            segment_file.write_all(&encoded[split..]).map_err(|error| {
                self.fenced = true;
                io_error("append owner segment", error)
            })?;
        }
        #[cfg(test)]
        let segment_sync = if self.consume_sync_failure(CommitFailPoint::SegmentSync) {
            Err(injected_sync_error())
        } else {
            segment_file.sync_all()
        };
        #[cfg(not(test))]
        let segment_sync = segment_file.sync_all();
        if let Err(error) = segment_sync {
            self.fenced = true;
            return Err(io_error("synchronize owner segment", error));
        }
        drop(segment_file);

        if rotate_segment && self.profile == DurabilityProfile::RunDurable {
            #[cfg(test)]
            let sync_result = if self.consume_sync_failure(CommitFailPoint::SegmentDirectorySync) {
                Err(injected_sync_error())
            } else {
                sync_directory(&self.directory)
            };
            #[cfg(not(test))]
            let sync_result = sync_directory(&self.directory);
            sync_result.map_err(|_| {
                self.fenced = true;
                OwnerLogError::DurabilityUnavailable
            })?;
        }

        let (temporary, temporary_file) = match write_head_temporary(&self.directory, &head_bytes) {
            Ok(file) => file,
            Err(error) => {
                self.fenced = true;
                return Err(error);
            }
        };
        #[cfg(test)]
        self.maybe_fail(CommitFailPoint::HeadTempWrite)?;
        #[cfg(test)]
        let head_sync = if self.consume_sync_failure(CommitFailPoint::HeadTempSync) {
            Err(injected_sync_error())
        } else {
            temporary_file.sync_all()
        };
        #[cfg(not(test))]
        let head_sync = temporary_file.sync_all();
        if let Err(error) = head_sync {
            self.fenced = true;
            return Err(io_error("synchronize temporary owner head", error));
        }
        drop(temporary_file);
        #[cfg(test)]
        self.maybe_fail(CommitFailPoint::HeadReplace)?;
        if let Err(error) = atomic_replace(&temporary, &self.directory.join("head.json")) {
            self.fenced = true;
            return Err(error);
        }
        if self.profile == DurabilityProfile::RunDurable {
            #[cfg(test)]
            let sync_result = if self.consume_sync_failure(CommitFailPoint::HeadDirectorySync) {
                Err(injected_sync_error())
            } else {
                sync_directory(&self.directory)
            };
            #[cfg(not(test))]
            let sync_result = sync_directory(&self.directory);
            sync_result.map_err(|_| {
                self.fenced = true;
                OwnerLogError::DurabilityUnavailable
            })?;
        }

        let new_summary = SegmentSummary {
            segment_id,
            committed_offset,
            first_seq,
            last_seq: next_seq,
            record_count,
            last_event_digest: previous_digest,
            previous_seq: if rotate_segment {
                self.head.committed_seq
            } else {
                active
                    .expect("a reused segment has an active summary")
                    .previous_seq
            },
            previous_digest: if rotate_segment {
                self.head.committed_event_digest
            } else {
                active
                    .expect("a reused segment has an active summary")
                    .previous_digest
            },
            sealed: false,
        };
        let previous_active_segment = if rotate_segment {
            active.map(|summary| summary.segment_id)
        } else {
            None
        };
        let indexed_delivery = IndexedDelivery {
            receipt: receipt.clone(),
            segment_id,
            start_offset: if rotate_segment { 0 } else { active_offset },
            end_offset: committed_offset,
        };
        if let Some(index) = &mut self.index
            && index
                .commit_batch(
                    previous_active_segment,
                    new_summary,
                    &indexed_delivery,
                    &new_head,
                )
                .is_err()
        {
            self.index = None;
        }
        self.active_segment = Some(new_summary);
        if rotate_segment {
            self.next_segment_id = segment_id.checked_add(1);
        }
        self.active_has_tail = false;
        self.active_sealed = false;
        self.head = new_head;
        Ok(receipt)
    }

    pub fn read_after(
        &self,
        cursor: Option<&CursorV1>,
        limit: NonZeroUsize,
    ) -> Result<ReadBatchV1, OwnerLogError> {
        self.ensure_usable()?;
        let after_seq = if let Some(cursor) = cursor {
            cursor_sequence(cursor, &self.owner, &self.head)?
        } else {
            0
        };
        if after_seq == self.head.committed_seq {
            if let Some(cursor) = cursor
                && !cursor_matches_head(cursor, &self.owner, &self.head)?
            {
                return Err(OwnerLogError::CursorConflict);
            }
            return Ok(ReadBatchV1 {
                events: Vec::new(),
                cursor: cursor.cloned(),
                has_more: false,
            });
        }
        self.read_after_indexed(after_seq, cursor, limit)
            .or_else(|_| self.read_after_streaming(after_seq, cursor, limit))
    }

    fn read_after_indexed(
        &self,
        after_seq: u64,
        cursor: Option<&CursorV1>,
        limit: NonZeroUsize,
    ) -> Result<ReadBatchV1, OwnerLogError> {
        let index = self.index.as_ref().ok_or(OwnerLogError::IndexUnavailable)?;
        let mut summary = index
            .segment_for_seq(after_seq)?
            .ok_or(OwnerLogError::IndexUnavailable)?;
        if after_seq == 0 && (summary.previous_seq != 0 || summary.previous_digest != Digest::ZERO)
        {
            return Err(OwnerLogError::IndexUnavailable);
        }
        if after_seq > 0 && after_seq < summary.first_seq {
            return Err(OwnerLogError::IndexUnavailable);
        }
        let max_events = limit.get().min(MAX_OWNER_READ_BATCH_EVENTS);
        let mut events = Vec::new();
        let mut bytes = 0usize;
        let mut has_more = false;
        let mut found_cursor = after_seq == 0;
        let mut cursor_digest = Digest::ZERO;
        let mut previous_segment: Option<SegmentSummary> = None;

        loop {
            let scanned = validate_indexed_segment(
                &self.directory,
                self.head.schema_version,
                summary,
                summary.previous_seq,
                summary.previous_digest,
                |record| {
                    if record.seq == after_seq {
                        found_cursor = true;
                        cursor_digest = record.event_digest;
                    }
                    if record.seq <= after_seq || has_more {
                        return Ok(());
                    }
                    if events.len() >= max_events {
                        has_more = true;
                        return Ok(());
                    }
                    let encoded_len = Self::encode_record(record)?.len();
                    if bytes.saturating_add(encoded_len) > MAX_OWNER_READ_BATCH_BYTES {
                        has_more = true;
                        return Ok(());
                    }
                    bytes += encoded_len;
                    events.push(record.clone());
                    Ok(())
                },
            )?;
            if scanned.summary.previous_seq != summary.previous_seq
                || scanned.summary.previous_digest != summary.previous_digest
            {
                return Err(OwnerLogError::IndexUnavailable);
            }
            if let Some(previous) = previous_segment
                && (summary.previous_seq != previous.last_seq
                    || summary.previous_digest != previous.last_event_digest)
            {
                return Err(OwnerLogError::IndexUnavailable);
            }
            if has_more {
                break;
            }
            if events.len() >= max_events {
                has_more = index.next_segment(summary.segment_id)?.is_some();
                if has_more {
                    break;
                }
            }
            let Some(next) = index.next_segment(summary.segment_id)? else {
                if summary.segment_id != self.head.active_segment_id
                    || summary.last_seq != self.head.committed_seq
                    || summary.last_event_digest != self.head.committed_event_digest
                {
                    return Err(OwnerLogError::IndexUnavailable);
                }
                break;
            };
            previous_segment = Some(summary);
            summary = next;
        }

        if !found_cursor {
            return Err(OwnerLogError::CursorConflict);
        }
        if let Some(cursor) = cursor
            && parse_wire_digest(&cursor.event_digest)? != cursor_digest
        {
            return Err(OwnerLogError::CursorConflict);
        }
        let next_cursor = events
            .last()
            .map(|record| cursor_for_record(&self.owner, record))
            .or_else(|| cursor.cloned());
        Ok(ReadBatchV1 {
            events,
            cursor: next_cursor,
            has_more,
        })
    }

    fn read_after_streaming(
        &self,
        after_seq: u64,
        cursor: Option<&CursorV1>,
        limit: NonZeroUsize,
    ) -> Result<ReadBatchV1, OwnerLogError> {
        let max_events = limit.get().min(MAX_OWNER_READ_BATCH_EVENTS);
        let mut events = Vec::new();
        let mut bytes = 0usize;
        let mut has_more = false;
        let mut found_cursor = after_seq == 0;
        let mut cursor_digest = Digest::ZERO;
        scan_committed_history(
            &self.directory,
            &self.owner,
            &self.head,
            None,
            |record| {
                if record.seq == after_seq {
                    found_cursor = true;
                    cursor_digest = record.event_digest;
                }
                if record.seq <= after_seq || has_more {
                    return Ok(());
                }
                if events.len() >= max_events {
                    has_more = true;
                    return Ok(());
                }
                let encoded_len = Self::encode_record(record)?.len();
                if bytes.saturating_add(encoded_len) > MAX_OWNER_READ_BATCH_BYTES {
                    has_more = true;
                    return Ok(());
                }
                bytes += encoded_len;
                events.push(record.clone());
                Ok(())
            },
            |_, _| Ok(()),
        )?;
        if !found_cursor {
            return Err(OwnerLogError::CursorConflict);
        }
        if let Some(cursor) = cursor
            && parse_wire_digest(&cursor.event_digest)? != cursor_digest
        {
            return Err(OwnerLogError::CursorConflict);
        }
        let next_cursor = events
            .last()
            .map(|record| cursor_for_record(&self.owner, record))
            .or_else(|| cursor.cloned());
        Ok(ReadBatchV1 {
            events,
            cursor: next_cursor,
            has_more,
        })
    }

    fn delivery_receipt(
        &mut self,
        delivery_id: &str,
    ) -> Result<Option<CommitReceiptV1>, OwnerLogError> {
        if let Some(index) = &self.index {
            if !index.may_contain_delivery(delivery_id) {
                return Ok(None);
            }
            match index.delivery(delivery_id, &self.owner) {
                Ok(Some(entry)) => match self.verify_indexed_delivery(delivery_id, &entry) {
                    Ok(receipt) => return Ok(Some(receipt)),
                    Err(_) => self.index = None,
                },
                Ok(None) => {}
                Err(_) => self.index = None,
            }
        }
        self.find_delivery_in_history(delivery_id)
    }

    fn verify_indexed_delivery(
        &self,
        delivery_id: &str,
        entry: &IndexedDelivery,
    ) -> Result<CommitReceiptV1, OwnerLogError> {
        let index = self.index.as_ref().ok_or(OwnerLogError::IndexUnavailable)?;
        let summary = index
            .segment(entry.segment_id)?
            .ok_or(OwnerLogError::IndexUnavailable)?;
        let scanned = validate_indexed_segment(
            &self.directory,
            self.head.schema_version,
            summary,
            summary.previous_seq,
            summary.previous_digest,
            |_| Ok(()),
        )?;
        let delivery = scanned
            .deliveries
            .into_iter()
            .find(|delivery| delivery.delivery_id == delivery_id)
            .ok_or(OwnerLogError::IndexUnavailable)?;
        if delivery.command_digest
            != OwnerLogV2::command_digest(&delivery.delivery_id, &delivery.events)?
            || delivery.start_offset != entry.start_offset
            || delivery.end_offset != entry.end_offset
        {
            return Err(OwnerLogError::IndexUnavailable);
        }
        let receipt = make_receipt(
            &delivery.delivery_id,
            &delivery.command_digest,
            &self.owner,
            delivery.last_seq,
            delivery.last_event_digest,
            delivery.event_count,
        )?;
        if receipt != entry.receipt {
            return Err(OwnerLogError::IndexUnavailable);
        }
        Ok(receipt)
    }

    fn find_delivery_in_history(
        &self,
        delivery_id: &str,
    ) -> Result<Option<CommitReceiptV1>, OwnerLogError> {
        let mut found = None;
        scan_committed_history(
            &self.directory,
            &self.owner,
            &self.head,
            None,
            |_| Ok(()),
            |delivery, receipt| {
                if delivery.delivery_id == delivery_id {
                    if found.is_some() {
                        return Err(OwnerLogError::CorruptCommittedLog(
                            "delivery ID appears more than once in committed history",
                        ));
                    }
                    found = Some(receipt.clone());
                }
                Ok(())
            },
        )?;
        Ok(found)
    }

    fn ensure_usable(&self) -> Result<(), OwnerLogError> {
        if self.fenced {
            return Err(OwnerLogError::Fenced);
        }
        Ok(())
    }

    fn verify_committed_state(&mut self) -> Result<(), OwnerLogError> {
        let result = (|| {
            let expected_head = Self::encode_head(&self.head)?;
            let Some(on_disk_head) =
                read_optional_bounded(&self.directory.join("head.json"), MAX_OWNER_METADATA_BYTES)?
            else {
                return Err(OwnerLogError::CorruptCommittedLog(
                    "committed head disappeared while the owner was open",
                ));
            };
            if on_disk_head != expected_head {
                return Err(OwnerLogError::CorruptCommittedLog(
                    "committed head changed while the owner was open",
                ));
            }
            scan_committed_history(
                &self.directory,
                &self.owner,
                &self.head,
                None,
                |_| Ok(()),
                |_, _| Ok(()),
            )?;
            Ok(())
        })();
        if result.is_err() {
            self.fenced = true;
        }
        result
    }

    #[cfg(test)]
    fn maybe_fail(&mut self, point: CommitFailPoint) -> Result<(), OwnerLogError> {
        if self.failpoint == Some(point) {
            self.fenced = true;
            return Err(OwnerLogError::InjectedFailure);
        }
        Ok(())
    }

    #[cfg(test)]
    fn consume_sync_failure(&mut self, point: CommitFailPoint) -> bool {
        if self.failpoint == Some(point) {
            self.failpoint = None;
            true
        } else {
            false
        }
    }

    fn seal_active_segment(&self, summary: SegmentSummary) -> Result<(), OwnerLogError> {
        let path = segment_path(&self.directory, summary.segment_id);
        let prefix = read_committed_prefix(&path, summary.committed_offset)?;
        let seal = SegmentSealV2::new(
            summary.segment_id,
            summary.committed_offset,
            summary.first_seq,
            summary.last_seq,
            summary.record_count,
            summary.last_event_digest,
            &prefix,
        )?;
        publish_seal(&self.directory, &seal, self.profile)
    }

    pub fn event_digest(record: &PhysicalRecordV2) -> Result<Digest, OwnerLogError> {
        validate_record_fields(record)?;
        let preimage = record_json(record, false)?;
        if preimage.len() >= MAX_OWNER_RECORD_BYTES {
            return Err(OwnerLogError::LimitExceeded("record bytes"));
        }
        Ok(Digest::from_blake3(&preimage))
    }

    pub fn encode_record(record: &PhysicalRecordV2) -> Result<Vec<u8>, OwnerLogError> {
        validate_record_fields(record)?;
        if Self::event_digest(record)? != record.event_digest {
            return Err(OwnerLogError::InvalidDigest);
        }
        let mut encoded = record_json(record, true)?;
        encoded.push(b'\n');
        if encoded.len() > MAX_OWNER_RECORD_BYTES {
            return Err(OwnerLogError::LimitExceeded("record bytes"));
        }
        Ok(encoded)
    }

    pub fn head_digest(head: &OwnerHeadV2) -> Result<Digest, OwnerLogError> {
        validate_head(head)?;
        let preimage = head_json(head, false)?;
        if preimage.len() >= MAX_OWNER_METADATA_BYTES {
            return Err(OwnerLogError::LimitExceeded("head bytes"));
        }
        Ok(Digest::from_blake3(&preimage))
    }

    pub fn encode_head(head: &OwnerHeadV2) -> Result<Vec<u8>, OwnerLogError> {
        validate_head(head)?;
        if Self::head_digest(head)? != head.head_digest {
            return Err(OwnerLogError::InvalidDigest);
        }
        let mut encoded = head_json(head, true)?;
        encoded.push(b'\n');
        if encoded.len() > MAX_OWNER_METADATA_BYTES {
            return Err(OwnerLogError::LimitExceeded("head bytes"));
        }
        Ok(encoded)
    }

    pub fn encode_seal(seal: &SegmentSealV2) -> Result<Vec<u8>, OwnerLogError> {
        validate_seal(seal)?;
        let mut encoded = seal_json(seal)?;
        encoded.push(b'\n');
        if encoded.len() > MAX_OWNER_METADATA_BYTES {
            return Err(OwnerLogError::LimitExceeded("seal bytes"));
        }
        Ok(encoded)
    }
}

fn ensure_directory_tree(
    path: &Path,
    profile: DurabilityProfile,
    private: bool,
) -> Result<(), OwnerLogError> {
    if let Some(parent) = path
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        && parent != path
    {
        ensure_directory_tree(parent, profile, false)?;
    }
    ensure_directory(path, profile, private)
}

fn ensure_directory(
    path: &Path,
    profile: DurabilityProfile,
    private: bool,
) -> Result<(), OwnerLogError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_dir() => {
            if private {
                validate_private_directory(path, &metadata)?;
            }
            return Ok(());
        }
        Ok(_) => {
            return Err(OwnerLogError::CorruptCommittedLog(
                "owner storage path is not a regular directory",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect owner directory", error)),
    }

    match create_directory(path, private) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return ensure_directory(path, profile, private);
        }
        Err(error) => return Err(io_error("create owner directory", error)),
    }
    if profile == DurabilityProfile::RunDurable {
        let parent = path
            .parent()
            .filter(|parent| !parent.as_os_str().is_empty())
            .unwrap_or_else(|| Path::new("."));
        sync_directory(parent).map_err(|_| OwnerLogError::DurabilityUnavailable)?;
        sync_directory(path).map_err(|_| OwnerLogError::DurabilityUnavailable)?;
    }
    Ok(())
}

fn create_directory(path: &Path, private: bool) -> io::Result<()> {
    #[cfg(unix)]
    {
        let mut builder = fs::DirBuilder::new();
        builder.mode(if private { 0o700 } else { 0o777 });
        builder.create(path)
    }
    #[cfg(not(unix))]
    {
        let _ = private;
        fs::create_dir(path)
    }
}

fn validate_private_directory(path: &Path, metadata: &fs::Metadata) -> Result<(), OwnerLogError> {
    #[cfg(unix)]
    {
        let _ = path;
        if metadata.permissions().mode() & 0o077 != 0 {
            Err(OwnerLogError::StoragePermissionsUnavailable)
        } else {
            Ok(())
        }
    }
    #[cfg(windows)]
    {
        let _ = (path, metadata);
        Err(OwnerLogError::StoragePermissionsUnavailable)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Err(OwnerLogError::StoragePermissionsUnavailable)
    }
}

pub(crate) fn validate_private_file(
    path: &Path,
    metadata: &fs::Metadata,
) -> Result<(), OwnerLogError> {
    #[cfg(unix)]
    {
        let _ = path;
        if metadata.permissions().mode() & 0o077 != 0 {
            Err(OwnerLogError::StoragePermissionsUnavailable)
        } else {
            Ok(())
        }
    }
    #[cfg(windows)]
    {
        let _ = (path, metadata);
        Err(OwnerLogError::StoragePermissionsUnavailable)
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (path, metadata);
        Err(OwnerLogError::StoragePermissionsUnavailable)
    }
}

fn open_lock_file(path: &Path) -> Result<File, OwnerLogError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() => {
            validate_private_file(path, &metadata)?;
        }
        Ok(_) => {
            return Err(OwnerLogError::CorruptCommittedLog(
                "owner lock path is not a regular file",
            ));
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect owner lock", error)),
    }
    let mut options = private_open_options();
    options
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| io_error("open owner lock", error))
}

fn read_optional_bounded(path: &Path, limit: usize) -> Result<Option<Vec<u8>>, OwnerLogError> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(io_error("inspect owner metadata", error)),
    };
    if !metadata.file_type().is_file() {
        return Err(OwnerLogError::CorruptCommittedLog(
            "owner metadata path is not a regular file",
        ));
    }
    validate_private_file(path, &metadata)?;
    if metadata.len() > limit as u64 {
        return Err(OwnerLogError::LimitExceeded("metadata bytes"));
    }
    read_bounded(path, limit).map(Some)
}

fn read_bounded(path: &Path, limit: usize) -> Result<Vec<u8>, OwnerLogError> {
    let file = File::open(path).map_err(|error| io_error("open owner data", error))?;
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| io_error("read owner data", error))?;
    if bytes.len() > limit {
        return Err(OwnerLogError::LimitExceeded("file bytes"));
    }
    Ok(bytes)
}

fn read_committed_prefix(path: &Path, offset: u64) -> Result<Vec<u8>, OwnerLogError> {
    if offset == 0 || offset > MAX_OWNER_SEGMENT_BYTES as u64 {
        return Err(OwnerLogError::CorruptCommittedLog(
            "committed segment offset is outside its bounds",
        ));
    }
    let metadata =
        fs::symlink_metadata(path).map_err(|error| io_error("inspect owner segment", error))?;
    if !metadata.file_type().is_file() || metadata.len() < offset {
        return Err(OwnerLogError::CorruptCommittedLog(
            "committed segment prefix is missing or truncated",
        ));
    }
    validate_private_file(path, &metadata)?;
    let mut file = File::open(path).map_err(|error| io_error("open owner segment", error))?;
    let mut prefix = Vec::with_capacity(offset as usize);
    Read::by_ref(&mut file)
        .take(offset)
        .read_to_end(&mut prefix)
        .map_err(|error| io_error("read committed segment prefix", error))?;
    if prefix.len() as u64 != offset {
        return Err(OwnerLogError::CorruptCommittedLog(
            "committed segment prefix is truncated",
        ));
    }
    Ok(prefix)
}

fn segment_path(directory: &Path, segment_id: u64) -> PathBuf {
    directory.join(format!("segment-{segment_id:020}.jsonl"))
}

fn seal_path(directory: &Path, segment_id: u64) -> PathBuf {
    directory.join(format!("segment-{segment_id:020}.seal.json"))
}

fn parse_segment_id(name: &str, suffix: &str) -> Option<u64> {
    let value = name.strip_prefix("segment-")?.strip_suffix(suffix)?;
    if value.len() != 20 || !value.bytes().all(|byte| byte.is_ascii_digit()) {
        return None;
    }
    value.parse().ok()
}

fn inspect_owner_directory(directory: &Path) -> Result<(u64, bool), OwnerLogError> {
    let mut max_segment_id = 0;
    let mut has_segment_data = false;
    for entry in fs::read_dir(directory).map_err(|error| io_error("list owner directory", error))? {
        let entry = entry.map_err(|error| io_error("read owner directory entry", error))?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            return Err(OwnerLogError::UnknownStorageEntry);
        };
        let metadata = entry
            .file_type()
            .map_err(|error| io_error("inspect owner directory entry", error))?;
        if metadata.is_symlink() {
            return Err(OwnerLogError::UnknownStorageEntry);
        }
        match name {
            "owner.lock" | "head.json" => continue,
            crate::owner_log_index::INDEX_FILENAME => {
                if !metadata.is_file() {
                    return Err(OwnerLogError::UnknownStorageEntry);
                }
                let path = entry.path();
                let file_metadata = entry
                    .metadata()
                    .map_err(|error| io_error("inspect owner lookup index", error))?;
                validate_private_file(&path, &file_metadata)?;
                continue;
            }
            "owner-index.sqlite-journal" => {
                if !metadata.is_file() {
                    return Err(OwnerLogError::UnknownStorageEntry);
                }
                let path = entry.path();
                let file_metadata = entry
                    .metadata()
                    .map_err(|error| io_error("inspect owner lookup journal", error))?;
                validate_private_file(&path, &file_metadata)?;
                continue;
            }
            _ => {}
        }
        if name.starts_with(".head-") && name.ends_with(".tmp")
            || name.starts_with(".seal-") && name.ends_with(".tmp")
        {
            if metadata.is_file() {
                let path = entry.path();
                let metadata = entry
                    .metadata()
                    .map_err(|error| io_error("inspect owner temporary file", error))?;
                validate_private_file(&path, &metadata)?;
                continue;
            }
            return Err(OwnerLogError::UnknownStorageEntry);
        }
        if let Some(segment_id) = parse_segment_id(name, ".jsonl") {
            if segment_id == 0 || !metadata.is_file() {
                return Err(OwnerLogError::UnknownStorageEntry);
            }
            let path = entry.path();
            let file_metadata = entry
                .metadata()
                .map_err(|error| io_error("inspect owner segment", error))?;
            validate_private_file(&path, &file_metadata)?;
            max_segment_id = max_segment_id.max(segment_id);
            has_segment_data = true;
            continue;
        }
        if let Some(segment_id) = parse_segment_id(name, ".seal.json") {
            if segment_id == 0 || !metadata.is_file() {
                return Err(OwnerLogError::UnknownStorageEntry);
            }
            let path = entry.path();
            let file_metadata = entry
                .metadata()
                .map_err(|error| io_error("inspect segment seal", error))?;
            validate_private_file(&path, &file_metadata)?;
            max_segment_id = max_segment_id.max(segment_id);
            has_segment_data = true;
            continue;
        }
        return Err(OwnerLogError::UnknownStorageEntry);
    }
    Ok((max_segment_id, has_segment_data))
}

fn create_temporary_file(directory: &Path, prefix: &str) -> Result<(PathBuf, File), OwnerLogError> {
    for _ in 0..32 {
        let id = NEXT_TEMP_FILE_ID.fetch_add(1, Ordering::Relaxed);
        let path = directory.join(format!(".{prefix}-{}-{id}.tmp", std::process::id()));
        let mut options = private_open_options();
        match options.write(true).create_new(true).open(&path) {
            Ok(file) => return Ok((path, file)),
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(io_error("create owner temporary file", error)),
        }
    }
    Err(OwnerLogError::LimitExceeded("temporary file attempts"))
}

fn private_open_options() -> OpenOptions {
    #[cfg(unix)]
    {
        let mut options = OpenOptions::new();
        options.mode(0o600);
        options
    }
    #[cfg(not(unix))]
    {
        OpenOptions::new()
    }
}

fn write_head_temporary(directory: &Path, bytes: &[u8]) -> Result<(PathBuf, File), OwnerLogError> {
    let (path, mut file) = create_temporary_file(directory, "head")?;
    file.write_all(bytes)
        .map_err(|error| io_error("write temporary owner head", error))?;
    Ok((path, file))
}

fn atomic_replace(source: &Path, destination: &Path) -> Result<(), OwnerLogError> {
    #[cfg(unix)]
    {
        fs::rename(source, destination)
            .map_err(|error| io_error("replace committed owner head", error))
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::Storage::FileSystem::{
            MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH, MoveFileExW,
        };

        let source: Vec<u16> = source.as_os_str().encode_wide().chain(Some(0)).collect();
        let destination: Vec<u16> = destination
            .as_os_str()
            .encode_wide()
            .chain(Some(0))
            .collect();
        // Both paths are generated in the same owner directory; the replacement never
        // crosses volumes and does not accept caller-controlled file names.
        let moved = unsafe {
            MoveFileExW(
                source.as_ptr(),
                destination.as_ptr(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
            )
        };
        if moved == 0 {
            return Err(io_error(
                "replace committed owner head",
                io::Error::last_os_error(),
            ));
        }
        Ok(())
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = (source, destination);
        Err(OwnerLogError::DurabilityUnavailable)
    }
}

fn platform_can_sync_directory() -> bool {
    cfg!(unix)
}

fn platform_can_validate_private_storage() -> bool {
    cfg!(unix)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> io::Result<()> {
    File::open(path)?.sync_all()
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> io::Result<()> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "directory synchronization is unavailable",
    ))
}

fn publish_head(
    directory: &Path,
    head: &OwnerHeadV2,
    profile: DurabilityProfile,
) -> Result<(), OwnerLogError> {
    let bytes = OwnerLogV2::encode_head(head)?;
    let (temporary, file) = write_head_temporary(directory, &bytes)?;
    file.sync_all()
        .map_err(|error| io_error("synchronize temporary owner head", error))?;
    drop(file);
    atomic_replace(&temporary, &directory.join("head.json"))?;
    if profile == DurabilityProfile::RunDurable {
        sync_directory(directory).map_err(|_| OwnerLogError::DurabilityUnavailable)?;
    }
    Ok(())
}

fn publish_seal(
    directory: &Path,
    seal: &SegmentSealV2,
    profile: DurabilityProfile,
) -> Result<(), OwnerLogError> {
    let bytes = OwnerLogV2::encode_seal(seal)?;
    let destination = seal_path(directory, seal.segment_id());
    if let Some(existing) = read_optional_bounded(&destination, MAX_OWNER_METADATA_BYTES)? {
        if existing != bytes {
            return Err(OwnerLogError::CorruptCommittedLog(
                "segment seal conflicts with its committed prefix",
            ));
        }
        return Ok(());
    }
    let (temporary, mut file) = create_temporary_file(directory, "seal")?;
    file.write_all(&bytes)
        .map_err(|error| io_error("write segment seal", error))?;
    file.sync_all()
        .map_err(|error| io_error("synchronize segment seal", error))?;
    drop(file);
    atomic_replace(&temporary, &destination)?;
    if profile == DurabilityProfile::RunDurable {
        sync_directory(directory).map_err(|_| OwnerLogError::DurabilityUnavailable)?;
    }
    Ok(())
}

fn parse_json_line(
    bytes: &[u8],
    field: &'static str,
    limit: usize,
) -> Result<Map<String, Value>, OwnerLogError> {
    if bytes.len() > limit || !bytes.ends_with(b"\n") || bytes[..bytes.len() - 1].contains(&b'\n') {
        return Err(OwnerLogError::CorruptCommittedLog(field));
    }
    let value: Value = serde_json::from_slice(&bytes[..bytes.len() - 1])
        .map_err(|_| OwnerLogError::CorruptCommittedLog(field))?;
    match value {
        Value::Object(map) => Ok(map),
        _ => Err(OwnerLogError::CorruptCommittedLog(field)),
    }
}

fn take_json_value(
    map: &mut Map<String, Value>,
    key: &'static str,
    field: &'static str,
) -> Result<Value, OwnerLogError> {
    map.remove(key)
        .ok_or(OwnerLogError::CorruptCommittedLog(field))
}

fn take_json_u64(
    map: &mut Map<String, Value>,
    key: &'static str,
    field: &'static str,
) -> Result<u64, OwnerLogError> {
    take_json_value(map, key, field)?
        .as_u64()
        .ok_or(OwnerLogError::CorruptCommittedLog(field))
}

fn take_json_string(
    map: &mut Map<String, Value>,
    key: &'static str,
    field: &'static str,
) -> Result<String, OwnerLogError> {
    take_json_value(map, key, field)?
        .as_str()
        .map(str::to_owned)
        .ok_or(OwnerLogError::CorruptCommittedLog(field))
}

fn decode_head(bytes: &[u8]) -> Result<OwnerHeadV2, OwnerLogError> {
    let mut map = parse_json_line(
        bytes,
        "committed head is not canonical JSONL",
        MAX_OWNER_METADATA_BYTES,
    )?;
    let version = take_json_u64(
        &mut map,
        "format_version",
        "committed head format is invalid",
    )?;
    if version != u64::from(OWNER_LOG_FORMAT_VERSION_V2) {
        return Err(OwnerLogError::UnsupportedFormatVersion(version));
    }
    let owner_kind = take_json_string(&mut map, "owner_kind", "committed head owner is invalid")?;
    let owner_id = take_json_string(&mut map, "owner_id", "committed head owner is invalid")?;
    let schema_version = take_json_u64(
        &mut map,
        "schema_version",
        "committed head schema is invalid",
    )?;
    let generation = take_json_u64(
        &mut map,
        "generation",
        "committed head generation is invalid",
    )?;
    let durability_profile = match take_json_string(
        &mut map,
        "durability_profile",
        "committed head durability profile is invalid",
    )?
    .as_str()
    {
        "interactive_only" => DurabilityProfile::InteractiveOnly,
        "run_durable" => DurabilityProfile::RunDurable,
        _ => {
            return Err(OwnerLogError::CorruptCommittedLog(
                "head durability profile is unknown",
            ));
        }
    };
    let committed_seq = take_json_u64(
        &mut map,
        "committed_seq",
        "committed head sequence is invalid",
    )?;
    let committed_event_digest = Digest::parse_hex(&take_json_string(
        &mut map,
        "committed_event_digest",
        "committed head digest is invalid",
    )?)?;
    let active_segment_id = take_json_u64(
        &mut map,
        "active_segment_id",
        "committed head segment is invalid",
    )?;
    let committed_offset = take_json_u64(
        &mut map,
        "committed_offset",
        "committed head offset is invalid",
    )?;
    let head_digest = Digest::parse_hex(&take_json_string(
        &mut map,
        "head_digest",
        "committed head digest is invalid",
    )?)?;
    if !map.is_empty() {
        return Err(OwnerLogError::CorruptCommittedLog(
            "committed head has unknown fields",
        ));
    }
    let schema_version = u16::try_from(schema_version)
        .map_err(|_| OwnerLogError::CorruptCommittedLog("committed head schema is out of range"))?;
    let head = OwnerHeadV2 {
        format_version: OWNER_LOG_FORMAT_VERSION_V2,
        owner_kind,
        owner_id,
        schema_version,
        generation,
        durability_profile,
        committed_seq,
        committed_event_digest,
        active_segment_id,
        committed_offset,
        head_digest,
    };
    if OwnerLogV2::encode_head(&head)? != bytes {
        return Err(OwnerLogError::CorruptCommittedLog(
            "committed head is not canonical",
        ));
    }
    Ok(head)
}

fn decode_record(bytes: &[u8]) -> Result<PhysicalRecordV2, OwnerLogError> {
    let mut map = parse_json_line(
        bytes,
        "committed record is not canonical JSONL",
        MAX_OWNER_RECORD_BYTES,
    )?;
    let version = take_json_u64(&mut map, "format_version", "record format is invalid")?;
    if version != u64::from(OWNER_LOG_FORMAT_VERSION_V2) {
        return Err(OwnerLogError::UnsupportedFormatVersion(version));
    }
    let seq = take_json_u64(&mut map, "seq", "record sequence is invalid")?;
    let time_ms = take_json_u64(&mut map, "time_ms", "record timestamp is invalid")?;
    let kind = take_json_string(&mut map, "kind", "record kind is invalid")?;
    let data = take_json_value(&mut map, "data", "record data is missing")?;
    let previous_digest = Digest::parse_hex(&take_json_string(
        &mut map,
        "previous_digest",
        "record previous digest is invalid",
    )?)?;
    let event_digest = Digest::parse_hex(&take_json_string(
        &mut map,
        "event_digest",
        "record event digest is invalid",
    )?)?;
    if !map.is_empty() {
        return Err(OwnerLogError::CorruptCommittedLog(
            "record has unknown fields",
        ));
    }
    let record = PhysicalRecordV2 {
        format_version: OWNER_LOG_FORMAT_VERSION_V2,
        seq,
        time_ms,
        kind,
        data,
        previous_digest,
        event_digest,
    };
    let encoded = OwnerLogV2::encode_record(&record).map_err(|error| match error {
        OwnerLogError::InvalidDigest => OwnerLogError::CorruptCommittedLog(
            "record digest does not match its canonical contents",
        ),
        error => error,
    })?;
    if encoded != bytes {
        return Err(OwnerLogError::CorruptCommittedLog(
            "record is not canonical",
        ));
    }
    Ok(record)
}

fn decode_seal(bytes: &[u8]) -> Result<SegmentSealV2, OwnerLogError> {
    let mut map = parse_json_line(
        bytes,
        "segment seal is not canonical JSONL",
        MAX_OWNER_METADATA_BYTES,
    )?;
    let version = take_json_u64(&mut map, "format_version", "segment seal format is invalid")?;
    if version != u64::from(OWNER_LOG_FORMAT_VERSION_V2) {
        return Err(OwnerLogError::UnsupportedFormatVersion(version));
    }
    let segment_id = take_json_u64(&mut map, "segment_id", "segment seal ID is invalid")?;
    let committed_offset = take_json_u64(
        &mut map,
        "committed_offset",
        "segment seal offset is invalid",
    )?;
    let first_seq = take_json_u64(
        &mut map,
        "first_seq",
        "segment seal first sequence is invalid",
    )?;
    let last_seq = take_json_u64(
        &mut map,
        "last_seq",
        "segment seal last sequence is invalid",
    )?;
    let record_count = take_json_u64(
        &mut map,
        "record_count",
        "segment seal record count is invalid",
    )?;
    let last_event_digest = Digest::parse_hex(&take_json_string(
        &mut map,
        "last_event_digest",
        "segment seal event digest is invalid",
    )?)?;
    let segment_digest = Digest::parse_hex(&take_json_string(
        &mut map,
        "segment_digest",
        "segment seal digest is invalid",
    )?)?;
    if !map.is_empty() {
        return Err(OwnerLogError::CorruptCommittedLog(
            "segment seal has unknown fields",
        ));
    }
    let seal = SegmentSealV2 {
        format_version: OWNER_LOG_FORMAT_VERSION_V2,
        segment_id,
        committed_offset,
        first_seq,
        last_seq,
        record_count,
        last_event_digest,
        segment_digest,
    };
    validate_seal(&seal)?;
    if OwnerLogV2::encode_seal(&seal)? != bytes {
        return Err(OwnerLogError::CorruptCommittedLog(
            "segment seal is not canonical",
        ));
    }
    Ok(seal)
}

fn replay_directory(
    directory: &Path,
    owner: &OwnerIdentity,
    head: &OwnerHeadV2,
    index: &mut OwnerIndexRebuild<'_>,
) -> Result<ReplaySummary, OwnerLogError> {
    scan_committed_history(
        directory,
        owner,
        head,
        Some(index),
        |_| Ok(()),
        |_, _| Ok(()),
    )
}

fn validate_indexed_segment(
    directory: &Path,
    schema_version: u16,
    expected: SegmentSummary,
    previous_seq: u64,
    previous_digest: Digest,
    mut visit: impl FnMut(&PhysicalRecordV2) -> Result<(), OwnerLogError>,
) -> Result<ScannedSegment, OwnerLogError> {
    let prefix = read_committed_prefix(
        &segment_path(directory, expected.segment_id),
        expected.committed_offset,
    )?;
    let seal_bytes = read_optional_bounded(
        &seal_path(directory, expected.segment_id),
        MAX_OWNER_METADATA_BYTES,
    )?;
    let seal = seal_bytes.as_deref().map(decode_seal).transpose()?;
    if expected.sealed != seal.is_some() {
        return Err(OwnerLogError::CorruptCommittedLog(
            "segment seal state changed after owner-log replay",
        ));
    }

    let scanned = scan_segment_prefix(
        expected.segment_id,
        &prefix,
        previous_seq,
        previous_digest,
        schema_version,
        &mut visit,
    )?;
    if scanned.summary.committed_offset != expected.committed_offset
        || scanned.summary.first_seq != expected.first_seq
        || scanned.summary.last_seq != expected.last_seq
        || scanned.summary.record_count != expected.record_count
        || scanned.summary.last_event_digest != expected.last_event_digest
    {
        return Err(OwnerLogError::CorruptCommittedLog(
            "segment contents changed after owner-log replay",
        ));
    }
    if let Some(seal) = seal
        && (seal.segment_id() != expected.segment_id
            || seal.committed_offset() != expected.committed_offset
            || seal.first_seq() != expected.first_seq
            || seal.last_seq() != expected.last_seq
            || seal.record_count() != expected.record_count
            || seal.last_event_digest() != expected.last_event_digest
            || seal.segment_digest() != Digest::from_blake3(&prefix))
    {
        return Err(OwnerLogError::CorruptCommittedLog(
            "segment seal does not match committed records",
        ));
    }
    validate_segment_command_digests(&scanned)?;
    Ok(scanned)
}

fn validate_segment_command_digests(scanned: &ScannedSegment) -> Result<(), OwnerLogError> {
    for delivery in &scanned.deliveries {
        let computed_digest = OwnerLogV2::command_digest(&delivery.delivery_id, &delivery.events)?;
        if computed_digest != delivery.command_digest {
            return Err(OwnerLogError::CorruptCommittedLog(
                "segment command digest does not match its events",
            ));
        }
    }
    Ok(())
}

fn scan_committed_history(
    directory: &Path,
    owner: &OwnerIdentity,
    head: &OwnerHeadV2,
    mut index: Option<&mut OwnerIndexRebuild<'_>>,
    mut visit: impl FnMut(&PhysicalRecordV2) -> Result<(), OwnerLogError>,
    mut visit_delivery: impl FnMut(&ScannedDelivery, &CommitReceiptV1) -> Result<(), OwnerLogError>,
) -> Result<ReplaySummary, OwnerLogError> {
    validate_head(head)?;
    if head.owner_kind != owner.kind || head.owner_id != owner.id {
        return Err(OwnerLogError::OwnerMismatch);
    }
    if OwnerLogV2::head_digest(head)? != head.head_digest {
        return Err(OwnerLogError::CorruptCommittedLog(
            "head digest does not match",
        ));
    }

    let (max_segment_id, _) = inspect_owner_directory(directory)?;
    for entry in fs::read_dir(directory).map_err(|error| io_error("list owner seals", error))? {
        let entry = entry.map_err(|error| io_error("read owner seal entry", error))?;
        if let Some(name) = entry.file_name().to_str()
            && parse_segment_id(name, ".seal.json")
                .is_some_and(|segment_id| segment_id > head.active_segment_id)
        {
            return Err(OwnerLogError::CorruptCommittedLog(
                "segment seal is newer than the committed head",
            ));
        }
    }
    if head.committed_seq == 0 {
        if head.committed_offset != 0 || head.committed_event_digest != Digest::ZERO {
            return Err(OwnerLogError::CorruptCommittedLog(
                "empty head is inconsistent",
            ));
        }
        if fs::read_dir(directory)
            .map_err(|error| io_error("list owner seals", error))?
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_str()
                    .is_some_and(|name| parse_segment_id(name, ".seal.json").is_some())
            })
        {
            return Err(OwnerLogError::CorruptCommittedLog(
                "empty stream has a segment seal",
            ));
        }
        return Ok(ReplaySummary {
            active_segment: None,
            active_has_tail: false,
            active_sealed: false,
            max_segment_id,
        });
    }
    if head.committed_offset == 0 {
        return Err(OwnerLogError::CorruptCommittedLog(
            "nonempty head has a zero committed offset",
        ));
    }
    let mut previous_seq = 0;
    let mut previous_digest = Digest::ZERO;
    let mut active_segment = None;
    let mut active_has_tail = false;
    let mut active_sealed = false;
    for segment_id in 1..=head.active_segment_id {
        let is_active = segment_id == head.active_segment_id;
        let (offset, seal) = if is_active {
            let seal =
                read_optional_bounded(&seal_path(directory, segment_id), MAX_OWNER_METADATA_BYTES)?
                    .as_deref()
                    .map(decode_seal)
                    .transpose()?;
            (head.committed_offset, seal)
        } else {
            let Some(bytes) =
                read_optional_bounded(&seal_path(directory, segment_id), MAX_OWNER_METADATA_BYTES)?
            else {
                let orphan_path = segment_path(directory, segment_id);
                let metadata = fs::symlink_metadata(&orphan_path)
                    .map_err(|error| io_error("inspect unsealed segment gap", error))?;
                if !metadata.file_type().is_file() {
                    return Err(OwnerLogError::CorruptCommittedLog(
                        "unsealed segment gap is not a regular file",
                    ));
                }
                validate_private_file(&orphan_path, &metadata)?;
                continue;
            };
            let seal = decode_seal(&bytes)?;
            if seal.segment_id() != segment_id {
                return Err(OwnerLogError::CorruptCommittedLog(
                    "segment seal ID does not match its path",
                ));
            }
            (seal.committed_offset(), Some(seal))
        };
        if let Some(seal) = &seal
            && (seal.segment_id() != segment_id || seal.committed_offset() != offset)
        {
            return Err(OwnerLogError::CorruptCommittedLog(
                "segment seal does not match its committed prefix",
            ));
        }

        let path = segment_path(directory, segment_id);
        let prefix = read_committed_prefix(&path, offset)?;
        let scanned = scan_segment_prefix(
            segment_id,
            &prefix,
            previous_seq,
            previous_digest,
            head.schema_version,
            &mut visit,
        )?;
        if let Some(seal) = &seal
            && (seal.first_seq() != scanned.summary.first_seq
                || seal.last_seq() != scanned.summary.last_seq
                || seal.record_count() != scanned.summary.record_count
                || seal.last_event_digest() != scanned.summary.last_event_digest
                || seal.segment_digest() != Digest::from_blake3(&prefix))
        {
            return Err(OwnerLogError::CorruptCommittedLog(
                "segment seal does not match committed records",
            ));
        }
        validate_segment_command_digests(&scanned)?;
        for delivery in &scanned.deliveries {
            let computed_digest =
                OwnerLogV2::command_digest(&delivery.delivery_id, &delivery.events)?;
            if computed_digest != delivery.command_digest {
                return Err(OwnerLogError::CorruptCommittedLog(
                    "segment command digest does not match its events",
                ));
            }
            let receipt = make_receipt(
                &delivery.delivery_id,
                &delivery.command_digest,
                owner,
                delivery.last_seq,
                delivery.last_event_digest,
                delivery.event_count,
            )?;
            let indexed_delivery = IndexedDelivery {
                receipt: receipt.clone(),
                segment_id: delivery.segment_id,
                start_offset: delivery.start_offset,
                end_offset: delivery.end_offset,
            };
            if let Some(index) = index.as_deref_mut() {
                index.insert_delivery(&indexed_delivery)?;
            }
            visit_delivery(delivery, &receipt)?;
        }
        let mut summary = scanned.summary;
        summary.sealed = seal.is_some();
        if let Some(index) = index.as_deref_mut() {
            index.insert_segment(summary)?;
        }
        previous_seq = summary.last_seq;
        previous_digest = summary.last_event_digest;
        if is_active {
            active_segment = Some(summary);
            active_has_tail = fs::metadata(segment_path(directory, segment_id))
                .map_err(|error| io_error("inspect active segment", error))?
                .len()
                > offset;
            active_sealed = seal.is_some();
        }
    }

    if previous_seq != head.committed_seq || previous_digest != head.committed_event_digest {
        return Err(OwnerLogError::CorruptCommittedLog(
            "committed head does not match replayed event chain",
        ));
    }
    Ok(ReplaySummary {
        active_segment,
        active_has_tail,
        active_sealed,
        max_segment_id,
    })
}

struct ScannedSegment {
    summary: SegmentSummary,
    deliveries: Vec<ScannedDelivery>,
}

struct ScannedDelivery {
    segment_id: u64,
    start_offset: u64,
    end_offset: u64,
    delivery_id: String,
    command_digest: String,
    events: Vec<OwnerEventInput>,
    last_seq: u64,
    last_event_digest: Digest,
    event_count: u64,
}

struct PendingScannedDelivery {
    segment_id: u64,
    start_offset: u64,
    delivery_id: Option<String>,
    command_digest: Option<String>,
    events: Vec<OwnerEventInput>,
    last_seq: u64,
    last_event_digest: Digest,
}

impl PendingScannedDelivery {
    fn new(segment_id: u64) -> Self {
        Self {
            segment_id,
            start_offset: 0,
            delivery_id: None,
            command_digest: None,
            events: Vec::new(),
            last_seq: 0,
            last_event_digest: Digest::ZERO,
        }
    }
}

fn scan_segment_prefix(
    segment_id: u64,
    prefix: &[u8],
    previous_seq: u64,
    previous_digest: Digest,
    schema_version: u16,
    visit: &mut impl FnMut(&PhysicalRecordV2) -> Result<(), OwnerLogError>,
) -> Result<ScannedSegment, OwnerLogError> {
    if prefix.is_empty() || prefix.len() > MAX_OWNER_SEGMENT_BYTES {
        return Err(OwnerLogError::CorruptCommittedLog(
            "segment prefix is empty or oversized",
        ));
    }
    let mut records = Vec::new();
    let mut offset = 0usize;
    let mut expected_seq = previous_seq;
    let mut expected_digest = previous_digest;
    let mut first_seq = None;
    let mut deliveries = Vec::new();
    let mut pending = PendingScannedDelivery::new(segment_id);
    while offset < prefix.len() {
        let relative_end = prefix[offset..]
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or(OwnerLogError::CorruptCommittedLog(
                "committed record is missing its line terminator",
            ))?;
        let end = offset + relative_end + 1;
        let record = decode_record(&prefix[offset..end])?;
        expected_seq = expected_seq
            .checked_add(1)
            .ok_or(OwnerLogError::CorruptCommittedLog(
                "owner sequence overflowed",
            ))?;
        if record.seq != expected_seq || record.previous_digest != expected_digest {
            return Err(OwnerLogError::CorruptCommittedLog(
                "record sequence or digest chain is discontinuous",
            ));
        }
        let event = extract_event_input(&record)?;
        if event.schema_version != schema_version {
            return Err(OwnerLogError::CorruptCommittedLog(
                "record schema version does not match the committed head",
            ));
        }
        let event_delivery_id =
            event
                .delivery_id
                .clone()
                .ok_or(OwnerLogError::CorruptCommittedLog(
                    "record delivery ID is missing",
                ))?;
        let event_command_digest =
            event
                .command_digest
                .clone()
                .ok_or(OwnerLogError::CorruptCommittedLog(
                    "record command digest is missing",
                ))?;
        match (&pending.delivery_id, &pending.command_digest) {
            (None, None) => {
                pending.start_offset = offset as u64;
                pending.delivery_id = Some(event_delivery_id);
                pending.command_digest = Some(event_command_digest);
            }
            (Some(expected_id), Some(expected_digest))
                if &event_delivery_id == expected_id
                    && &event_command_digest == expected_digest => {}
            (Some(_), Some(_)) => {
                flush_scanned_delivery(&mut deliveries, &mut pending, offset as u64)?;
                pending.delivery_id = Some(event_delivery_id);
                pending.command_digest = Some(event_command_digest);
            }
            _ => {
                return Err(OwnerLogError::CorruptCommittedLog(
                    "delivery metadata is incomplete",
                ));
            }
        }
        first_seq.get_or_insert(record.seq);
        expected_digest = record.event_digest;
        visit(&record)?;
        records.push(record);
        pending.events.push(event);
        pending.last_seq = expected_seq;
        pending.last_event_digest = expected_digest;
        offset = end;
    }
    flush_scanned_delivery(&mut deliveries, &mut pending, prefix.len() as u64)?;
    let first_seq = first_seq.ok_or(OwnerLogError::CorruptCommittedLog(
        "committed segment contains no records",
    ))?;
    let last = records.last().expect("nonempty segment checked above");
    Ok(ScannedSegment {
        summary: SegmentSummary {
            segment_id,
            committed_offset: prefix.len() as u64,
            first_seq,
            last_seq: last.seq,
            record_count: records.len() as u64,
            last_event_digest: last.event_digest,
            previous_seq,
            previous_digest,
            sealed: false,
        },
        deliveries,
    })
}

fn flush_scanned_delivery(
    deliveries: &mut Vec<ScannedDelivery>,
    pending: &mut PendingScannedDelivery,
    end_offset: u64,
) -> Result<(), OwnerLogError> {
    if pending.events.is_empty() {
        if pending.delivery_id.is_some() || pending.command_digest.is_some() {
            return Err(OwnerLogError::CorruptCommittedLog(
                "delivery metadata has no corresponding events",
            ));
        }
        return Ok(());
    }
    let delivery_id = pending
        .delivery_id
        .take()
        .ok_or(OwnerLogError::CorruptCommittedLog("delivery ID is missing"))?;
    let command_digest =
        pending
            .command_digest
            .take()
            .ok_or(OwnerLogError::CorruptCommittedLog(
                "command digest is missing",
            ))?;
    deliveries.push(ScannedDelivery {
        segment_id: pending.segment_id,
        start_offset: pending.start_offset,
        end_offset,
        delivery_id,
        command_digest,
        event_count: pending.events.len() as u64,
        events: std::mem::take(&mut pending.events),
        last_seq: pending.last_seq,
        last_event_digest: pending.last_event_digest,
    });
    pending.start_offset = end_offset;
    pending.last_seq = 0;
    pending.last_event_digest = Digest::ZERO;
    Ok(())
}

fn extract_event_input(record: &PhysicalRecordV2) -> Result<OwnerEventInput, OwnerLogError> {
    let Value::Object(mut map) = record.data.clone() else {
        return Err(OwnerLogError::CorruptCommittedLog(
            "record data is not an object",
        ));
    };
    let delivery_id = take_json_string(&mut map, "deliveryId", "record delivery ID is missing")?;
    let command_digest = take_json_string(
        &mut map,
        "commandDigest",
        "record command digest is missing",
    )?;
    let payload = take_json_value(&mut map, "payload", "record payload is missing")?;
    let Value::Object(_) = &payload else {
        return Err(OwnerLogError::CorruptCommittedLog(
            "record payload is not an object",
        ));
    };
    let schema_version = take_json_u64(
        &mut map,
        "schemaVersion",
        "record schema version is missing",
    )?;
    if !map.is_empty() {
        return Err(OwnerLogError::CorruptCommittedLog(
            "record data has unknown fields",
        ));
    }
    let schema_version = u16::try_from(schema_version)
        .map_err(|_| OwnerLogError::CorruptCommittedLog("record schema version is out of range"))?;
    let event = OwnerEventInput {
        schema_version,
        time_ms: record.time_ms,
        kind: record.kind.clone(),
        data: payload,
        delivery_id: Some(delivery_id),
        command_digest: Some(command_digest),
    };
    if event.physical_data()? != record.data {
        return Err(OwnerLogError::CorruptCommittedLog(
            "record event data is not canonical",
        ));
    }
    Ok(event)
}

fn parse_decimal_u64(value: &str) -> Result<u64, OwnerLogError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(OwnerLogError::CursorConflict);
    }
    let parsed: u64 = value.parse().map_err(|_| OwnerLogError::CursorConflict)?;
    if parsed.to_string() != value {
        return Err(OwnerLogError::CursorConflict);
    }
    Ok(parsed)
}

fn append_bounded(output: &mut Vec<u8>, bytes: &[u8], limit: usize) -> Result<(), OwnerLogError> {
    let new_len = output
        .len()
        .checked_add(bytes.len())
        .ok_or(OwnerLogError::LimitExceeded("canonical command bytes"))?;
    if new_len > limit {
        return Err(OwnerLogError::LimitExceeded("canonical command bytes"));
    }
    output.extend_from_slice(bytes);
    Ok(())
}

fn cursor_sequence(
    cursor: &CursorV1,
    owner: &OwnerIdentity,
    head: &OwnerHeadV2,
) -> Result<u64, OwnerLogError> {
    if cursor.owner_kind != owner.kind || cursor.owner_id != owner.id {
        return Err(OwnerLogError::CursorConflict);
    }
    let seq = parse_decimal_u64(&cursor.seq)?;
    let digest = parse_wire_digest(&cursor.event_digest)?;
    if seq > head.committed_seq || (seq == 0 && digest != Digest::ZERO) {
        return Err(OwnerLogError::CursorConflict);
    }
    Ok(seq)
}

fn cursor_matches_head(
    cursor: &CursorV1,
    owner: &OwnerIdentity,
    head: &OwnerHeadV2,
) -> Result<bool, OwnerLogError> {
    let seq = cursor_sequence(cursor, owner, head)?;
    let digest = parse_wire_digest(&cursor.event_digest)?;
    Ok(seq == head.committed_seq && digest == head.committed_event_digest)
}

fn cursor_for_record(owner: &OwnerIdentity, record: &PhysicalRecordV2) -> CursorV1 {
    CursorV1 {
        owner_kind: owner.kind.clone(),
        owner_id: owner.id.clone(),
        seq: record.seq.to_string(),
        event_digest: format!("blake3:{}", record.event_digest.to_hex()),
    }
}

fn make_receipt(
    delivery_id: &str,
    command_digest: &str,
    owner: &OwnerIdentity,
    seq: u64,
    event_digest: Digest,
    event_count: u64,
) -> Result<CommitReceiptV1, OwnerLogError> {
    validate_identity_component(delivery_id, "delivery ID")?;
    parse_wire_digest(command_digest)?;
    if event_count == 0 {
        return Err(OwnerLogError::InvalidMetadata(
            "receipt event count must be nonzero",
        ));
    }
    let owner_cursor = CursorV1 {
        owner_kind: owner.kind.clone(),
        owner_id: owner.id.clone(),
        seq: seq.to_string(),
        event_digest: format!("blake3:{}", event_digest.to_hex()),
    };
    let mut cursor = Map::new();
    cursor.insert(
        "eventDigest".to_owned(),
        Value::String(owner_cursor.event_digest.clone()),
    );
    cursor.insert(
        "ownerId".to_owned(),
        Value::String(owner_cursor.owner_id.clone()),
    );
    cursor.insert(
        "ownerKind".to_owned(),
        Value::String(owner_cursor.owner_kind.clone()),
    );
    cursor.insert("seq".to_owned(), Value::String(owner_cursor.seq.clone()));
    let mut preimage = Map::new();
    preimage.insert(
        "commandDigest".to_owned(),
        Value::String(command_digest.to_owned()),
    );
    preimage.insert(
        "deliveryId".to_owned(),
        Value::String(delivery_id.to_owned()),
    );
    preimage.insert(
        "eventCount".to_owned(),
        Value::Number(Number::from(event_count)),
    );
    preimage.insert(
        "format".to_owned(),
        Value::String("horizon.owner-receipt.v1".to_owned()),
    );
    preimage.insert("ownerCursor".to_owned(), Value::Object(cursor));
    let canonical = canonicalize_json(Value::Object(preimage))?;
    let bytes = serde_json::to_vec(&canonical).map_err(|_| OwnerLogError::JsonEncoding)?;
    Ok(CommitReceiptV1 {
        delivery_id: delivery_id.to_owned(),
        command_digest: command_digest.to_owned(),
        owner_cursor,
        event_count,
        receipt_digest: format!("blake3:{}", Digest::from_blake3(&bytes).to_hex()),
    })
}

fn validate_record_fields(record: &PhysicalRecordV2) -> Result<(), OwnerLogError> {
    if record.format_version != OWNER_LOG_FORMAT_VERSION_V2 {
        return Err(OwnerLogError::UnsupportedFormatVersion(u64::from(
            record.format_version,
        )));
    }
    if record.seq == 0 {
        return Err(OwnerLogError::InvalidRecord("sequence must be nonzero"));
    }
    if record.time_ms > MAX_SAFE_INTEGER {
        return Err(OwnerLogError::InvalidRecord(
            "event time exceeds the safe integer range",
        ));
    }
    validate_kind(&record.kind)?;
    let Value::Object(_) = &record.data else {
        return Err(OwnerLogError::InvalidRecord("event data must be an object"));
    };
    validate_json(&record.data)?;
    let canonical = canonicalize_json(record.data.clone())?;
    if canonical != record.data {
        return Err(OwnerLogError::InvalidRecord("event data is not canonical"));
    }
    Ok(())
}

fn validate_kind(kind: &str) -> Result<(), OwnerLogError> {
    if kind.is_empty() {
        return Err(OwnerLogError::InvalidRecord("event kind must be non-empty"));
    }
    if kind.len() > MAX_IDENTIFIER_BYTES {
        return Err(OwnerLogError::LimitExceeded("event kind bytes"));
    }
    Ok(())
}

fn canonicalize_json(value: Value) -> Result<Value, OwnerLogError> {
    validate_json(&value)?;
    canonicalize_json_at(value)
}

fn validate_json(value: &Value) -> Result<(), OwnerLogError> {
    let mut nodes = 0;
    let mut string_bytes = 0;
    validate_json_at(value, 0, &mut nodes, &mut string_bytes)
}

fn validate_json_at(
    value: &Value,
    depth: usize,
    nodes: &mut usize,
    string_bytes: &mut usize,
) -> Result<(), OwnerLogError> {
    if depth > MAX_JSON_NESTING_DEPTH {
        return Err(OwnerLogError::LimitExceeded("JSON nesting depth"));
    }
    *nodes += 1;
    if *nodes > MAX_JSON_NODES {
        return Err(OwnerLogError::LimitExceeded("JSON node count"));
    }

    match value {
        Value::Null | Value::Bool(_) => Ok(()),
        Value::Number(number) => validate_number(number),
        Value::String(value) => add_json_bytes(string_bytes, value.len()),
        Value::Array(values) => {
            for value in values {
                validate_json_at(value, depth + 1, nodes, string_bytes)?;
            }
            Ok(())
        }
        Value::Object(values) => {
            for (key, value) in values {
                add_json_bytes(string_bytes, key.len())?;
                validate_json_at(value, depth + 1, nodes, string_bytes)?;
            }
            Ok(())
        }
    }
}

fn add_json_bytes(total: &mut usize, additional: usize) -> Result<(), OwnerLogError> {
    *total = total
        .checked_add(additional)
        .ok_or(OwnerLogError::LimitExceeded("JSON string bytes"))?;
    if *total > MAX_OWNER_RECORD_BYTES {
        return Err(OwnerLogError::LimitExceeded("JSON string bytes"));
    }
    Ok(())
}

fn canonicalize_json_at(value: Value) -> Result<Value, OwnerLogError> {
    match value {
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => Ok(value),
        Value::Array(values) => values
            .into_iter()
            .map(canonicalize_json_at)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Object(values) => {
            let mut entries: Vec<_> = values.into_iter().collect();
            entries.sort_by(|(left, _), (right, _)| left.as_bytes().cmp(right.as_bytes()));
            let mut canonical = Map::new();
            for (key, value) in entries {
                canonical.insert(key, canonicalize_json_at(value)?);
            }
            Ok(Value::Object(canonical))
        }
    }
}

fn validate_number(number: &Number) -> Result<(), OwnerLogError> {
    if let Some(value) = number.as_u64() {
        if value > MAX_SAFE_INTEGER {
            return Err(OwnerLogError::InvalidRecord(
                "JSON integer exceeds the safe integer range",
            ));
        }
        return Ok(());
    }
    if let Some(value) = number.as_i64() {
        if value.unsigned_abs() > MAX_SAFE_INTEGER {
            return Err(OwnerLogError::InvalidRecord(
                "JSON integer exceeds the safe integer range",
            ));
        }
        return Ok(());
    }
    let value = number
        .as_f64()
        .ok_or(OwnerLogError::InvalidRecord("JSON number is not finite"))?;
    if !value.is_finite() || value.abs() > MAX_SAFE_INTEGER as f64 {
        return Err(OwnerLogError::InvalidRecord(
            "JSON number is non-finite or outside the safe range",
        ));
    }
    Ok(())
}

fn record_json(record: &PhysicalRecordV2, include_digest: bool) -> Result<Vec<u8>, OwnerLogError> {
    let kind = json_string(&record.kind)?;
    let data = serde_json::to_string(&record.data).map_err(|_| OwnerLogError::JsonEncoding)?;
    let previous_digest = json_string(&record.previous_digest.to_hex())?;
    let mut encoded = String::with_capacity(128 + kind.len() + data.len());
    write!(
        encoded,
        "{{\"format_version\":{},\"seq\":{},\"time_ms\":{},\"kind\":{},\"data\":{},\"previous_digest\":{}",
        record.format_version, record.seq, record.time_ms, kind, data, previous_digest
    )
    .map_err(|_| OwnerLogError::JsonEncoding)?;
    if include_digest {
        write!(
            encoded,
            ",\"event_digest\":{}}}",
            json_string(&record.event_digest.to_hex())?
        )
        .map_err(|_| OwnerLogError::JsonEncoding)?;
    } else {
        encoded.push('}');
    }
    Ok(encoded.into_bytes())
}

fn head_json(head: &OwnerHeadV2, include_digest: bool) -> Result<Vec<u8>, OwnerLogError> {
    let owner_kind = json_string(&head.owner_kind)?;
    let owner_id = json_string(&head.owner_id)?;
    let durability_profile = json_string(head.durability_profile.as_str())?;
    let committed_event_digest = json_string(&head.committed_event_digest.to_hex())?;
    let mut encoded = String::with_capacity(256);
    write!(
        encoded,
        "{{\"format_version\":{},\"owner_kind\":{},\"owner_id\":{},\"schema_version\":{},\"generation\":{},\"durability_profile\":{},\"committed_seq\":{},\"committed_event_digest\":{},\"active_segment_id\":{},\"committed_offset\":{}",
        head.format_version,
        owner_kind,
        owner_id,
        head.schema_version,
        head.generation,
        durability_profile,
        head.committed_seq,
        committed_event_digest,
        head.active_segment_id,
        head.committed_offset
    )
    .map_err(|_| OwnerLogError::JsonEncoding)?;
    if include_digest {
        write!(
            encoded,
            ",\"head_digest\":{}}}",
            json_string(&head.head_digest.to_hex())?
        )
        .map_err(|_| OwnerLogError::JsonEncoding)?;
    } else {
        encoded.push('}');
    }
    Ok(encoded.into_bytes())
}

fn seal_json(seal: &SegmentSealV2) -> Result<Vec<u8>, OwnerLogError> {
    let last_event_digest = json_string(&seal.last_event_digest.to_hex())?;
    let segment_digest = json_string(&seal.segment_digest.to_hex())?;
    let mut encoded = String::with_capacity(256);
    write!(
        encoded,
        "{{\"format_version\":{},\"segment_id\":{},\"committed_offset\":{},\"first_seq\":{},\"last_seq\":{},\"record_count\":{},\"last_event_digest\":{},\"segment_digest\":{}}}",
        seal.format_version,
        seal.segment_id,
        seal.committed_offset,
        seal.first_seq,
        seal.last_seq,
        seal.record_count,
        last_event_digest,
        segment_digest
    )
    .map_err(|_| OwnerLogError::JsonEncoding)?;
    Ok(encoded.into_bytes())
}

fn json_string(value: &str) -> Result<String, OwnerLogError> {
    serde_json::to_string(value).map_err(|_| OwnerLogError::JsonEncoding)
}

fn validate_head(head: &OwnerHeadV2) -> Result<(), OwnerLogError> {
    if head.format_version != OWNER_LOG_FORMAT_VERSION_V2 {
        return Err(OwnerLogError::UnsupportedFormatVersion(u64::from(
            head.format_version,
        )));
    }
    validate_identity_component(&head.owner_kind, "kind")?;
    validate_identity_component(&head.owner_id, "id")?;
    if head.schema_version == 0 || head.generation == 0 || head.active_segment_id == 0 {
        return Err(OwnerLogError::InvalidMetadata(
            "schema version, generation, and active segment ID must be nonzero",
        ));
    }
    if head.committed_offset > MAX_OWNER_SEGMENT_BYTES as u64 {
        return Err(OwnerLogError::LimitExceeded("segment bytes"));
    }
    if head.committed_seq == 0
        && (head.committed_event_digest != Digest::ZERO || head.committed_offset != 0)
    {
        return Err(OwnerLogError::InvalidMetadata(
            "empty head must use a zero digest and offset",
        ));
    }
    if head.committed_seq > 0 && head.committed_offset == 0 {
        return Err(OwnerLogError::InvalidMetadata(
            "nonempty head must have a committed segment offset",
        ));
    }
    Ok(())
}

fn validate_seal(seal: &SegmentSealV2) -> Result<(), OwnerLogError> {
    if seal.format_version != OWNER_LOG_FORMAT_VERSION_V2 {
        return Err(OwnerLogError::UnsupportedFormatVersion(u64::from(
            seal.format_version,
        )));
    }
    if seal.segment_id == 0 || seal.first_seq == 0 || seal.record_count == 0 {
        return Err(OwnerLogError::InvalidMetadata(
            "segment ID, first sequence, and record count must be nonzero",
        ));
    }
    if seal.first_seq > seal.last_seq {
        return Err(OwnerLogError::InvalidMetadata(
            "first sequence cannot exceed last sequence",
        ));
    }
    if seal.committed_offset == 0 || seal.committed_offset > MAX_OWNER_SEGMENT_BYTES as u64 {
        return Err(OwnerLogError::LimitExceeded("sealed segment bytes"));
    }
    Ok(())
}

#[cfg(all(test, unix))]
mod persistence_tests {
    use super::*;
    use std::fs;
    use std::num::NonZeroUsize;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::time::{SystemTime, UNIX_EPOCH};

    static NEXT_TEMP_ID: AtomicUsize = AtomicUsize::new(0);

    struct TempRoot(PathBuf);

    impl TempRoot {
        fn new() -> Self {
            let base = std::env::var_os("HORIZON_OWNER_LOG_TEST_TMPDIR")
                .map(PathBuf::from)
                .unwrap_or_else(std::env::temp_dir);
            for _ in 0..32 {
                let id = NEXT_TEMP_ID.fetch_add(1, Ordering::Relaxed);
                let tick = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos();
                let path = base.join(format!(
                    "horizon-owner-log-fault-{}-{tick}-{id}",
                    std::process::id()
                ));
                match fs::create_dir(&path) {
                    Ok(()) => {
                        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
                        return Self(path);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                    Err(error) => panic!("failed creating test root: {error}"),
                }
            }
            panic!("could not allocate a unique OwnerLog fault-test root")
        }
    }

    impl Drop for TempRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn assert_sync_failure(result: Result<CommitReceiptV1, OwnerLogError>, point: CommitFailPoint) {
        match point {
            CommitFailPoint::SegmentSync => assert!(matches!(
                result,
                Err(OwnerLogError::Io {
                    operation: "synchronize owner segment",
                    kind: io::ErrorKind::Other,
                })
            )),
            CommitFailPoint::HeadTempSync => assert!(matches!(
                result,
                Err(OwnerLogError::Io {
                    operation: "synchronize temporary owner head",
                    kind: io::ErrorKind::Other,
                })
            )),
            CommitFailPoint::SegmentDirectorySync | CommitFailPoint::HeadDirectorySync => {
                assert!(matches!(result, Err(OwnerLogError::DurabilityUnavailable)))
            }
            _ => assert!(matches!(result, Err(OwnerLogError::InjectedFailure))),
        }
    }

    #[cfg(unix)]
    #[test]
    fn injected_commit_failures_recover_only_the_old_or_new_prefix() {
        for (point, expected_events) in [
            (CommitFailPoint::SegmentAppend, 0),
            (CommitFailPoint::SegmentSync, 0),
            (CommitFailPoint::SegmentDirectorySync, 0),
            (CommitFailPoint::HeadTempWrite, 0),
            (CommitFailPoint::HeadTempSync, 0),
            (CommitFailPoint::HeadReplace, 0),
            (CommitFailPoint::HeadDirectorySync, 1),
        ] {
            let root = TempRoot::new();
            let owner =
                OwnerIdentity::new("thread".to_owned(), format!("fault-{point:?}")).unwrap();
            let mut log =
                OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
            let first_events = [OwnerEventInput {
                schema_version: 1,
                time_ms: 1_700_000_000_123,
                kind: "thread.created".to_owned(),
                data: serde_json::json!({"name": "before"}),
                delivery_id: None,
                command_digest: None,
            }];
            let first_digest = OwnerLogV2::command_digest("delivery-0", &first_events).unwrap();
            log.append_batch("delivery-0", &first_digest, &first_events, None)
                .unwrap();
            drop(log);

            let owner_directory = root.0.join("owners").join(owner.directory_key());
            let mut tail = OpenOptions::new()
                .append(true)
                .open(segment_path(&owner_directory, 1))
                .unwrap();
            tail.write_all(b"{\"uncommitted\":").unwrap();
            tail.sync_all().unwrap();
            drop(tail);

            let mut log =
                OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
            log.failpoint = Some(point);

            let events = [OwnerEventInput {
                schema_version: 1,
                time_ms: 1_700_000_000_124,
                kind: "thread.renamed".to_owned(),
                data: serde_json::json!({"name": "after"}),
                delivery_id: None,
                command_digest: None,
            }];
            let command_digest = OwnerLogV2::command_digest("delivery-1", &events).unwrap();
            let result = log.append_batch("delivery-1", &command_digest, &events, None);
            assert_sync_failure(result, point);
            assert!(matches!(
                log.read_after(None, NonZeroUsize::new(4).unwrap()),
                Err(OwnerLogError::Fenced)
            ));
            drop(log);

            let recovered =
                OwnerLogV2::open(&root.0, owner, DurabilityProfile::RunDurable).unwrap();
            let batch = recovered
                .read_after(None, NonZeroUsize::new(4).unwrap())
                .unwrap();
            assert_eq!(batch.events.len(), expected_events + 1, "{point:?}");
            assert_eq!(batch.events[0].seq, 1, "{point:?}");
            if expected_events == 1 {
                assert_eq!(batch.events[1].seq, 2, "{point:?}");
                assert_eq!(batch.events[1].data["payload"]["name"], "after");
            }
        }
    }

    #[cfg(unix)]
    #[test]
    fn recovered_orphan_segment_id_does_not_poison_later_commits() {
        let root = TempRoot::new();
        let owner = OwnerIdentity::new("thread".to_owned(), "orphan-gap".to_owned()).unwrap();
        let mut log =
            OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
        let first_events = [OwnerEventInput {
            schema_version: 1,
            time_ms: 1_700_000_000_123,
            kind: "thread.created".to_owned(),
            data: serde_json::json!({"name": "first"}),
            delivery_id: None,
            command_digest: None,
        }];
        let first_digest = OwnerLogV2::command_digest("delivery-0", &first_events).unwrap();
        log.append_batch("delivery-0", &first_digest, &first_events, None)
            .unwrap();
        drop(log);

        let directory = root.0.join("owners").join(owner.directory_key());
        let mut tail = OpenOptions::new()
            .append(true)
            .open(segment_path(&directory, 1))
            .unwrap();
        tail.write_all(b"uncommitted-tail").unwrap();
        tail.sync_all().unwrap();
        drop(tail);

        let mut log =
            OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
        log.failpoint = Some(CommitFailPoint::HeadReplace);
        let failed_events = [OwnerEventInput {
            schema_version: 1,
            time_ms: 1_700_000_000_124,
            kind: "thread.renamed".to_owned(),
            data: serde_json::json!({"name": "uncommitted"}),
            delivery_id: None,
            command_digest: None,
        }];
        let failed_digest = OwnerLogV2::command_digest("delivery-1", &failed_events).unwrap();
        assert!(matches!(
            log.append_batch("delivery-1", &failed_digest, &failed_events, None),
            Err(OwnerLogError::InjectedFailure)
        ));
        drop(log);

        let mut recovered =
            OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
        let committed_events = [OwnerEventInput {
            schema_version: 1,
            time_ms: 1_700_000_000_125,
            kind: "thread.renamed".to_owned(),
            data: serde_json::json!({"name": "committed"}),
            delivery_id: None,
            command_digest: None,
        }];
        let committed_digest = OwnerLogV2::command_digest("delivery-2", &committed_events).unwrap();
        recovered
            .append_batch("delivery-2", &committed_digest, &committed_events, None)
            .unwrap();
        drop(recovered);

        let reopened = OwnerLogV2::open(&root.0, owner, DurabilityProfile::RunDurable).unwrap();
        let history = reopened
            .read_after(None, NonZeroUsize::new(4).unwrap())
            .unwrap();
        assert_eq!(history.events.len(), 2);
        assert_eq!(history.events[0].seq, 1);
        assert_eq!(history.events[1].seq, 2);
        assert_eq!(history.events[1].data["payload"]["name"], "committed");
    }

    #[cfg(unix)]
    #[test]
    fn injected_in_place_failures_recover_without_truncating_the_active_segment() {
        for (point, expected_count, expect_tail) in [
            (CommitFailPoint::SegmentAppend, 1, true),
            (CommitFailPoint::SegmentSync, 1, true),
            (CommitFailPoint::HeadTempWrite, 1, true),
            (CommitFailPoint::HeadTempSync, 1, true),
            (CommitFailPoint::HeadReplace, 1, true),
            (CommitFailPoint::HeadDirectorySync, 2, false),
        ] {
            let root = TempRoot::new();
            let owner =
                OwnerIdentity::new("thread".to_owned(), format!("in-place-{point:?}")).unwrap();
            let mut log =
                OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
            let first_events = [OwnerEventInput {
                schema_version: 1,
                time_ms: 1_700_000_000_123,
                kind: "thread.created".to_owned(),
                data: serde_json::json!({"name": "before"}),
                delivery_id: None,
                command_digest: None,
            }];
            let first_digest = OwnerLogV2::command_digest("delivery-0", &first_events).unwrap();
            log.append_batch("delivery-0", &first_digest, &first_events, None)
                .unwrap();

            let owner_directory = root.0.join("owners").join(owner.directory_key());
            let segment_one = segment_path(&owner_directory, 1);
            let committed_prefix = fs::read(&segment_one).unwrap();
            log.failpoint = Some(point);
            let next_events = [OwnerEventInput {
                schema_version: 1,
                time_ms: 1_700_000_000_124,
                kind: "thread.renamed".to_owned(),
                data: serde_json::json!({"name": "after"}),
                delivery_id: None,
                command_digest: None,
            }];
            let next_digest = OwnerLogV2::command_digest("delivery-1", &next_events).unwrap();
            let result = log.append_batch("delivery-1", &next_digest, &next_events, None);
            assert_sync_failure(result, point);
            assert!(matches!(
                log.read_after(None, NonZeroUsize::new(4).unwrap()),
                Err(OwnerLogError::Fenced)
            ));
            drop(log);

            let mut recovered =
                OwnerLogV2::open(&root.0, owner.clone(), DurabilityProfile::RunDurable).unwrap();
            let batch = recovered
                .read_after(None, NonZeroUsize::new(4).unwrap())
                .unwrap();
            assert_eq!(batch.events.len(), expected_count, "{point:?}");
            let bytes_after_failure = fs::read(&segment_one).unwrap();
            assert!(
                bytes_after_failure.starts_with(&committed_prefix),
                "{point:?}"
            );
            let recovered_head =
                decode_head(&fs::read(owner_directory.join("head.json")).unwrap()).unwrap();
            assert_eq!(
                bytes_after_failure.len() as u64 > recovered_head.committed_offset,
                expect_tail,
                "{point:?}"
            );

            if expect_tail {
                let third_events = [OwnerEventInput {
                    schema_version: 1,
                    time_ms: 1_700_000_000_125,
                    kind: "thread.renamed".to_owned(),
                    data: serde_json::json!({"name": "after-recovery"}),
                    delivery_id: None,
                    command_digest: None,
                }];
                let third_digest = OwnerLogV2::command_digest("delivery-2", &third_events).unwrap();
                recovered
                    .append_batch("delivery-2", &third_digest, &third_events, None)
                    .unwrap();
                assert!(segment_path(&owner_directory, 2).exists(), "{point:?}");
                assert_eq!(fs::read(&segment_one).unwrap(), bytes_after_failure);
            }
        }
    }
}

#[cfg(all(test, windows))]
mod windows_storage_tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn owner_log_fails_closed_until_private_root_acl_validation_is_available() {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::env::temp_dir().join(format!(
            "horizon-owner-log-windows-{}-{nonce}",
            std::process::id()
        ));
        let owner =
            OwnerIdentity::new("thread".to_owned(), "windows-private-root".to_owned()).unwrap();

        assert!(matches!(
            OwnerLogV2::open(&root, owner, DurabilityProfile::InteractiveOnly),
            Err(OwnerLogError::StoragePermissionsUnavailable)
        ));
        assert!(!root.exists());
    }
}
