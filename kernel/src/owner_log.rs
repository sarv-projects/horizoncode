//! Canonical V2 owner-log records and metadata codecs.
//!
//! This module defines the physical encoding only. It does not open files, acquire an
//! owner lock, provide durability, or recover a committed stream; those responsibilities
//! belong to the later OwnerLog storage implementation.

use serde_json::{Map, Number, Value};
use std::error::Error;
use std::fmt;
use std::fmt::Write as _;

pub const OWNER_LOG_FORMAT_VERSION_V2: u16 = 2;
pub const MAX_OWNER_RECORD_BYTES: usize = 1024 * 1024;
pub const MAX_OWNER_SEGMENT_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_OWNER_METADATA_BYTES: usize = 64 * 1024;

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
    UnsupportedFormatVersion(u16),
    LimitExceeded(&'static str),
    JsonEncoding,
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
        }
    }
}

impl Error for OwnerLogError {}

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

/// Stateless V2 record and metadata codec. File ownership and durable commit are not
/// implemented by this type yet.
pub struct OwnerLogV2;

impl OwnerLogV2 {
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

fn validate_record_fields(record: &PhysicalRecordV2) -> Result<(), OwnerLogError> {
    if record.format_version != OWNER_LOG_FORMAT_VERSION_V2 {
        return Err(OwnerLogError::UnsupportedFormatVersion(
            record.format_version,
        ));
    }
    if record.seq == 0 {
        return Err(OwnerLogError::InvalidRecord("sequence must be nonzero"));
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
        return Err(OwnerLogError::UnsupportedFormatVersion(head.format_version));
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
    Ok(())
}

fn validate_seal(seal: &SegmentSealV2) -> Result<(), OwnerLogError> {
    if seal.format_version != OWNER_LOG_FORMAT_VERSION_V2 {
        return Err(OwnerLogError::UnsupportedFormatVersion(seal.format_version));
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
