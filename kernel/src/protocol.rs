//! Typed `HzKernelRpcV1` messages and deterministic handshake negotiation.
//!
//! This module validates the wire shape only. A successful handshake does not prove
//! that the operating-system peer was authenticated; callers must first enforce the
//! platform-specific inherited-handle/socket/named-pipe checks from §13.3.

use crate::messagepack::{self, FRAME_LIMITS, Limits, Value};
use crate::transport::{self, FrameError, MAX_FRAME_SIZE, MAX_PAYLOAD_SIZE};
use std::collections::{BTreeMap, BTreeSet};
use std::error::Error;
use std::fmt;
use std::io::{Read, Write};

pub const PROTOCOL_V1: u16 = 1;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
pub const MAX_BODY_BYTES: usize = 1024 * 1024;
pub const MAX_EVENT_PAYLOAD_BYTES: usize = 256 * 1024;
pub const MAX_ERROR_BYTES: usize = 64 * 1024;
pub const MAX_ARTIFACT_CHUNK_BODY_BYTES: usize = 768 * 1024;
pub const MAX_IDENTIFIER_BYTES: usize = 256;
pub const MAX_FEATURE_COUNT: usize = 256;
pub const MAX_SUBJECT_IDS: usize = 256;
pub const MAX_DEADLINE_INTERACTIVE_MS: u64 = 5 * 60 * 1000;
pub const MAX_DEADLINE_DURABLE_MS: u64 = 24 * 60 * 60 * 1000;

/// A stream cursor scoped to one canonical owner; it is not a global sequence.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CursorV1 {
    pub owner_kind: String,
    pub owner_id: String,
    /// Canonical unsigned base-10 integer, without a leading zero except for "0".
    pub seq: String,
    pub event_digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ArtifactRefV1 {
    pub artifact_id: String,
    pub digest: String,
    /// Canonical unsigned base-10 integer, without a leading zero except for "0".
    pub byte_length: String,
    pub media_type: String,
    pub classification: ArtifactClassificationV1,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ArtifactClassificationV1 {
    Public,
    Workspace,
    Sensitive,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ErrorCategoryV1 {
    Validation,
    Conflict,
    Authorization,
    Capability,
    NotFound,
    Unavailable,
    Deadline,
    Uncertain,
    Corruption,
    Internal,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryClassV1 {
    Never,
    SafeQueryRetry,
    RetryAfterReconciliation,
    RetryAfterContextRecovery,
    UserActionRequired,
    RetryWithNewId,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TypedErrorV1 {
    pub code: String,
    pub category: ErrorCategoryV1,
    pub message: String,
    pub retry_class: RetryClassV1,
    pub retry_after_ms: Option<u64>,
    pub owner_cursor: Option<CursorV1>,
    pub subject_ids: Vec<String>,
    pub details: Option<ArtifactRefV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelHelloV1 {
    pub min_protocol: u16,
    pub max_protocol: u16,
    pub host_build_digest: String,
    pub kernel_build_digest: Option<String>,
    pub host_instance_id: String,
    pub process_incarnation: String,
    pub supervisor_nonce: String,
    pub required_features: Vec<String>,
    pub optional_features: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelHelloResultV1 {
    pub protocol: u16,
    pub enabled_features: Vec<String>,
    pub unavailable_optional_features: Vec<String>,
    pub supervisor_nonce: String,
    pub process_incarnation: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct KernelHelloRejectedV1 {
    pub error: TypedErrorV1,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum KernelStartupStatusV1 {
    Starting,
    Ready,
    Failed(Box<TypedErrorV1>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcRequestV1 {
    pub request_id: String,
    pub service_id: String,
    pub operation: String,
    pub delivery_id: Option<String>,
    pub expected_cursor: Option<CursorV1>,
    pub deadline_unix_ms: u64,
    pub trace_id: String,
    /// Operation-specific schema validation is performed by the service owner.
    pub body: Value,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RpcOutcomeV1 {
    Ok,
    Error,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcResponseV1 {
    pub request_id: String,
    pub outcome: RpcOutcomeV1,
    pub owner_cursor: Option<CursorV1>,
    pub receipt_digest: Option<String>,
    pub body: Option<Value>,
    pub error: Option<TypedErrorV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RpcEventV1 {
    pub subscription_id: String,
    pub cursor: CursorV1,
    pub event_type: String,
    pub payload: Value,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcControlV1 {
    Subscribe {
        subscription_id: String,
        owner_kind: String,
        owner_id: String,
        after: Option<CursorV1>,
    },
    Unsubscribe {
        subscription_id: String,
    },
    Ack {
        subscription_id: String,
        through: CursorV1,
    },
    CancelRequest {
        request_id: String,
    },
    Ping {
        nonce: String,
    },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum RpcMessageV1 {
    Hello(Box<KernelHelloV1>),
    HelloResult(Box<KernelHelloResultV1>),
    HelloRejected(Box<KernelHelloRejectedV1>),
    StartupStatus(Box<KernelStartupStatusV1>),
    Request(Box<RpcRequestV1>),
    Response(Box<RpcResponseV1>),
    Event(Box<RpcEventV1>),
    Control(Box<RpcControlV1>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProtocolError(pub ProtocolErrorKind);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ProtocolErrorKind {
    MessagePack(messagepack::ErrorKind),
    Frame,
    InvalidField {
        field: &'static str,
        reason: &'static str,
    },
    MissingField {
        field: &'static str,
    },
    UnsupportedKind,
    UnsupportedProtocol {
        protocol: u64,
    },
    TransportIncompatible,
    DeadlineExceeded,
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match &self.0 {
            ProtocolErrorKind::MessagePack(kind) => {
                write!(formatter, "invalid RPC MessagePack: {kind:?}")
            }
            ProtocolErrorKind::Frame => formatter.write_str("invalid RPC frame"),
            ProtocolErrorKind::InvalidField { field, reason } => {
                write!(formatter, "invalid RPC field {field}: {reason}")
            }
            ProtocolErrorKind::MissingField { field } => {
                write!(formatter, "missing RPC field {field}")
            }
            ProtocolErrorKind::UnsupportedKind => {
                formatter.write_str("unsupported RPC message kind")
            }
            ProtocolErrorKind::UnsupportedProtocol { protocol } => {
                write!(formatter, "unsupported RPC protocol {protocol}")
            }
            ProtocolErrorKind::TransportIncompatible => {
                formatter.write_str("kernel RPC peers have no compatible protocol/features")
            }
            ProtocolErrorKind::DeadlineExceeded => {
                formatter.write_str("RPC deadline is expired or too distant")
            }
        }
    }
}

impl Error for ProtocolError {}

impl From<messagepack::MessagePackError> for ProtocolError {
    fn from(error: messagepack::MessagePackError) -> Self {
        Self(ProtocolErrorKind::MessagePack(error.0))
    }
}

impl From<FrameError> for ProtocolError {
    fn from(_: FrameError) -> Self {
        Self(ProtocolErrorKind::Frame)
    }
}

fn invalid(field: &'static str, reason: &'static str) -> ProtocolError {
    ProtocolError(ProtocolErrorKind::InvalidField { field, reason })
}

fn missing(field: &'static str) -> ProtocolError {
    ProtocolError(ProtocolErrorKind::MissingField { field })
}

/// Encodes one protocol message as a bounded MessagePack payload.
pub fn encode_message(message: &RpcMessageV1) -> Result<Vec<u8>, ProtocolError> {
    validate_message(message)?;
    let value = message_to_value(message);
    let encoded = messagepack::encode(&value, FRAME_LIMITS)?;
    if encoded.len() > MAX_PAYLOAD_SIZE || encoded.len() + 4 > MAX_FRAME_SIZE {
        return Err(invalid("frame", "encoded payload exceeds the frame limit"));
    }
    Ok(encoded)
}

/// Decodes one typed protocol message, rejecting malformed fields and trailing bytes.
pub fn decode_message(payload: &[u8]) -> Result<RpcMessageV1, ProtocolError> {
    if payload.len() > MAX_PAYLOAD_SIZE {
        return Err(invalid("frame", "payload exceeds the frame limit"));
    }
    let value = messagepack::decode(payload, FRAME_LIMITS)?;
    let message = value_to_message(value)?;
    validate_message(&message)?;
    Ok(message)
}

/// Reads one framed message; clean EOF before a new frame is `Ok(None)`.
pub fn read_message<R: Read>(reader: &mut R) -> Result<Option<RpcMessageV1>, ProtocolError> {
    let Some(payload) = transport::read_frame(reader)? else {
        return Ok(None);
    };
    decode_message(&payload).map(Some)
}

/// Writes one bounded framed message. On partial I/O failure the channel must be dropped.
pub fn write_message<W: Write>(
    writer: &mut W,
    message: &RpcMessageV1,
) -> Result<(), ProtocolError> {
    let payload = encode_message(message)?;
    transport::write_frame(writer, &payload)?;
    Ok(())
}

fn validate_message(message: &RpcMessageV1) -> Result<(), ProtocolError> {
    match message {
        RpcMessageV1::Hello(hello) => validate_hello(hello),
        RpcMessageV1::HelloResult(result) => validate_hello_result(result),
        RpcMessageV1::HelloRejected(rejected) => validate_typed_error(&rejected.error),
        RpcMessageV1::StartupStatus(status) => match status.as_ref() {
            KernelStartupStatusV1::Starting | KernelStartupStatusV1::Ready => Ok(()),
            KernelStartupStatusV1::Failed(error) => validate_typed_error(error),
        },
        RpcMessageV1::Request(request) => {
            text("requestId", &request.request_id, MAX_IDENTIFIER_BYTES)?;
            text("serviceId", &request.service_id, MAX_IDENTIFIER_BYTES)?;
            text("operation", &request.operation, MAX_IDENTIFIER_BYTES)?;
            if let Some(delivery_id) = &request.delivery_id {
                text("deliveryId", delivery_id, MAX_IDENTIFIER_BYTES)?;
            }
            if let Some(cursor) = &request.expected_cursor {
                validate_cursor(cursor)?;
            }
            text("traceId", &request.trace_id, MAX_IDENTIFIER_BYTES)?;
            validate_safe_integer("deadlineUnixMs", request.deadline_unix_ms)?;
            validate_value_bound("body", &request.body, MAX_BODY_BYTES)?;
            Ok(())
        }
        RpcMessageV1::Response(response) => {
            text("requestId", &response.request_id, MAX_IDENTIFIER_BYTES)?;
            match response.outcome {
                RpcOutcomeV1::Ok if response.error.is_some() => {
                    return Err(invalid("error", "success response cannot contain an error"));
                }
                RpcOutcomeV1::Ok
                    if response.owner_cursor.is_some() != response.receipt_digest.is_some() =>
                {
                    return Err(invalid(
                        "receiptDigest",
                        "owner cursor and receipt digest must be present together",
                    ));
                }
                RpcOutcomeV1::Error
                    if response.error.is_none()
                        || response.body.is_some()
                        || response.owner_cursor.is_some()
                        || response.receipt_digest.is_some() =>
                {
                    return Err(invalid(
                        "outcome",
                        "error response must contain only a typed error",
                    ));
                }
                _ => {}
            }
            if let Some(cursor) = &response.owner_cursor {
                validate_cursor(cursor)?;
            }
            if let Some(digest) = &response.receipt_digest {
                validate_digest("receiptDigest", digest)?;
            }
            if let Some(body) = &response.body {
                validate_value_bound("body", body, MAX_BODY_BYTES)?;
            }
            if let Some(error) = &response.error {
                validate_typed_error(error)?;
            }
            Ok(())
        }
        RpcMessageV1::Event(event) => {
            text(
                "subscriptionId",
                &event.subscription_id,
                MAX_IDENTIFIER_BYTES,
            )?;
            validate_cursor(&event.cursor)?;
            text("eventType", &event.event_type, MAX_IDENTIFIER_BYTES)?;
            validate_value_bound("payload", &event.payload, MAX_EVENT_PAYLOAD_BYTES)
        }
        RpcMessageV1::Control(control) => match control.as_ref() {
            RpcControlV1::Subscribe {
                subscription_id,
                owner_kind,
                owner_id,
                after,
            } => {
                text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)?;
                text("ownerKind", owner_kind, MAX_IDENTIFIER_BYTES)?;
                text("ownerId", owner_id, MAX_IDENTIFIER_BYTES)?;
                if let Some(cursor) = after {
                    validate_cursor(cursor)?;
                    if cursor.owner_kind != *owner_kind || cursor.owner_id != *owner_id {
                        return Err(invalid(
                            "after",
                            "subscription cursor must belong to the requested owner",
                        ));
                    }
                }
                Ok(())
            }
            RpcControlV1::Unsubscribe { subscription_id } => {
                text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)
            }
            RpcControlV1::Ack {
                subscription_id,
                through,
            } => {
                text("subscriptionId", subscription_id, MAX_IDENTIFIER_BYTES)?;
                validate_cursor(through)
            }
            RpcControlV1::CancelRequest { request_id } => {
                text("requestId", request_id, MAX_IDENTIFIER_BYTES)
            }
            RpcControlV1::Ping { nonce } => text("nonce", nonce, MAX_IDENTIFIER_BYTES),
        },
    }
}

fn validate_hello(hello: &KernelHelloV1) -> Result<(), ProtocolError> {
    if hello.min_protocol == 0 || hello.min_protocol > hello.max_protocol {
        return Err(invalid(
            "protocolRange",
            "minimum must be nonzero and no greater than maximum",
        ));
    }
    validate_digest("hostBuildDigest", &hello.host_build_digest)?;
    if let Some(digest) = &hello.kernel_build_digest {
        validate_digest("kernelBuildDigest", digest)?;
    }
    text(
        "hostInstanceId",
        &hello.host_instance_id,
        MAX_IDENTIFIER_BYTES,
    )?;
    text(
        "processIncarnation",
        &hello.process_incarnation,
        MAX_IDENTIFIER_BYTES,
    )?;
    text(
        "supervisorNonce",
        &hello.supervisor_nonce,
        MAX_IDENTIFIER_BYTES,
    )?;
    validate_features("requiredFeatures", &hello.required_features)?;
    validate_features("optionalFeatures", &hello.optional_features)?;
    let required: BTreeSet<&str> = hello.required_features.iter().map(String::as_str).collect();
    if hello
        .optional_features
        .iter()
        .any(|feature| required.contains(feature.as_str()))
    {
        return Err(invalid(
            "features",
            "required and optional feature sets overlap",
        ));
    }
    Ok(())
}

fn validate_hello_result(result: &KernelHelloResultV1) -> Result<(), ProtocolError> {
    if result.protocol != PROTOCOL_V1 {
        return Err(ProtocolError(ProtocolErrorKind::UnsupportedProtocol {
            protocol: result.protocol as u64,
        }));
    }
    validate_features("enabledFeatures", &result.enabled_features)?;
    validate_features(
        "unavailableOptionalFeatures",
        &result.unavailable_optional_features,
    )?;
    if result
        .enabled_features
        .iter()
        .any(|feature| result.unavailable_optional_features.contains(feature))
    {
        return Err(invalid(
            "features",
            "enabled and unavailable optional feature sets overlap",
        ));
    }
    text(
        "supervisorNonce",
        &result.supervisor_nonce,
        MAX_IDENTIFIER_BYTES,
    )?;
    text(
        "processIncarnation",
        &result.process_incarnation,
        MAX_IDENTIFIER_BYTES,
    )
}

fn validate_features(field: &'static str, features: &[String]) -> Result<(), ProtocolError> {
    if features.len() > MAX_FEATURE_COUNT {
        return Err(invalid(field, "feature count exceeds the limit"));
    }
    let mut unique = BTreeSet::new();
    for feature in features {
        text(field, feature, MAX_IDENTIFIER_BYTES)?;
        if !unique.insert(feature) {
            return Err(invalid(field, "feature names must be unique"));
        }
    }
    Ok(())
}

fn validate_cursor(cursor: &CursorV1) -> Result<(), ProtocolError> {
    text("cursor.ownerKind", &cursor.owner_kind, MAX_IDENTIFIER_BYTES)?;
    text("cursor.ownerId", &cursor.owner_id, MAX_IDENTIFIER_BYTES)?;
    validate_decimal("cursor.seq", &cursor.seq)?;
    validate_digest("cursor.eventDigest", &cursor.event_digest)
}

fn validate_artifact_ref(reference: &ArtifactRefV1) -> Result<(), ProtocolError> {
    text(
        "artifactRef.artifactId",
        &reference.artifact_id,
        MAX_IDENTIFIER_BYTES,
    )?;
    validate_digest("artifactRef.digest", &reference.digest)?;
    validate_decimal("artifactRef.byteLength", &reference.byte_length)?;
    text(
        "artifactRef.mediaType",
        &reference.media_type,
        MAX_IDENTIFIER_BYTES,
    )?;
    Ok(())
}

fn validate_typed_error(error: &TypedErrorV1) -> Result<(), ProtocolError> {
    text("error.code", &error.code, MAX_IDENTIFIER_BYTES)?;
    text("error.message", &error.message, MAX_ERROR_BYTES)?;
    if let Some(retry_after_ms) = error.retry_after_ms {
        validate_safe_integer("error.retryAfterMs", retry_after_ms)?;
    }
    if error.subject_ids.len() > MAX_SUBJECT_IDS {
        return Err(invalid(
            "error.subjectIds",
            "subject count exceeds the limit",
        ));
    }
    for subject_id in &error.subject_ids {
        text("error.subjectIds", subject_id, MAX_IDENTIFIER_BYTES)?;
    }
    if let Some(cursor) = &error.owner_cursor {
        validate_cursor(cursor)?;
    }
    if let Some(reference) = &error.details {
        validate_artifact_ref(reference)?;
    }
    let value = typed_error_to_value(error);
    validate_value_bound("error", &value, MAX_ERROR_BYTES)
}

fn validate_value_bound(
    field: &'static str,
    value: &Value,
    max_bytes: usize,
) -> Result<(), ProtocolError> {
    let limits = Limits {
        max_encoded_bytes: max_bytes,
        ..FRAME_LIMITS
    };
    messagepack::encoded_len(value, limits)
        .map(|_| ())
        .map_err(|error| match error.0 {
            messagepack::ErrorKind::InputTooLarge { .. } => {
                invalid(field, "encoded value exceeds the byte limit")
            }
            other => ProtocolError(ProtocolErrorKind::MessagePack(other)),
        })
}

fn text(field: &'static str, value: &str, max_bytes: usize) -> Result<(), ProtocolError> {
    if value.is_empty() || value.len() > max_bytes || value.contains('\0') {
        return Err(invalid(
            field,
            "must be nonempty, NUL-free, and within the byte limit",
        ));
    }
    Ok(())
}

fn validate_safe_integer(field: &'static str, value: u64) -> Result<(), ProtocolError> {
    if value > MAX_SAFE_INTEGER {
        return Err(invalid(
            field,
            "must be an exactly representable JavaScript safe integer",
        ));
    }
    Ok(())
}

fn validate_digest(field: &'static str, digest: &str) -> Result<(), ProtocolError> {
    let Some(hex) = digest.strip_prefix("blake3:") else {
        return Err(invalid(field, "must use the blake3: digest form"));
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid(
            field,
            "must contain exactly 64 lowercase hexadecimal digits",
        ));
    }
    Ok(())
}

fn validate_decimal(field: &'static str, value: &str) -> Result<(), ProtocolError> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
        || value.parse::<u64>().is_err()
    {
        return Err(invalid(
            field,
            "must be a canonical unsigned 64-bit decimal string",
        ));
    }
    Ok(())
}

/// Validates an absolute Unix-millisecond deadline against the trusted operation class.
/// The class must come from the operation registry, never from the RPC caller.
pub fn validate_deadline(
    deadline_unix_ms: u64,
    now_unix_ms: u64,
    durable_managed: bool,
) -> Result<(), ProtocolError> {
    validate_safe_integer("nowUnixMs", now_unix_ms)?;
    validate_safe_integer("deadlineUnixMs", deadline_unix_ms)?;
    let max_ahead = if durable_managed {
        MAX_DEADLINE_DURABLE_MS
    } else {
        MAX_DEADLINE_INTERACTIVE_MS
    };
    let latest = now_unix_ms
        .checked_add(max_ahead)
        .ok_or(ProtocolError(ProtocolErrorKind::DeadlineExceeded))?;
    if deadline_unix_ms <= now_unix_ms || deadline_unix_ms > latest {
        return Err(ProtocolError(ProtocolErrorKind::DeadlineExceeded));
    }
    Ok(())
}

/// Locally trusted protocol/feature policy for hello negotiation.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct HandshakePolicy {
    pub min_protocol: u16,
    pub max_protocol: u16,
    pub supported_features: BTreeSet<String>,
    pub expected_supervisor_nonce: String,
    pub expected_host_process_incarnation: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NegotiatedProtocol {
    pub protocol: u16,
    pub enabled_features: Vec<String>,
    pub unavailable_optional_features: Vec<String>,
}

/// Negotiates a host's `KernelHelloV1` against trusted kernel capabilities.
/// This validates the nonce binding but is not OS identity verification or channel
/// authentication; callers must authenticate the pipe/socket peer separately.
pub fn negotiate_hello(
    hello: &KernelHelloV1,
    policy: &HandshakePolicy,
) -> Result<NegotiatedProtocol, ProtocolError> {
    validate_hello(hello)?;
    if policy.min_protocol == 0
        || policy.min_protocol > policy.max_protocol
        || hello.supervisor_nonce != policy.expected_supervisor_nonce
        || policy
            .expected_host_process_incarnation
            .as_ref()
            .is_none_or(|expected| expected != &hello.process_incarnation)
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    if PROTOCOL_V1 < policy.min_protocol
        || PROTOCOL_V1 > policy.max_protocol
        || PROTOCOL_V1 < hello.min_protocol
        || PROTOCOL_V1 > hello.max_protocol
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    if hello
        .required_features
        .iter()
        .any(|feature| !policy.supported_features.contains(feature))
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    let enabled_features = hello
        .required_features
        .iter()
        .chain(hello.optional_features.iter())
        .filter(|feature| policy.supported_features.contains(*feature))
        .cloned()
        .collect();
    let unavailable_optional_features = hello
        .optional_features
        .iter()
        .filter(|feature| !policy.supported_features.contains(*feature))
        .cloned()
        .collect();

    Ok(NegotiatedProtocol {
        protocol: PROTOCOL_V1,
        enabled_features,
        unavailable_optional_features,
    })
}

/// Binds a negotiation result to the exact host hello that initiated the handshake.
/// This is protocol binding only; callers must separately authenticate the OS peer.
pub fn validate_hello_result_binding(
    hello: &KernelHelloV1,
    result: &KernelHelloResultV1,
) -> Result<(), ProtocolError> {
    validate_hello(hello)?;
    validate_hello_result(result)?;
    if result.protocol < hello.min_protocol || result.protocol > hello.max_protocol {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }
    if result.supervisor_nonce != hello.supervisor_nonce
        || result.process_incarnation != hello.process_incarnation
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    let expected_enabled: Vec<&String> = hello
        .required_features
        .iter()
        .chain(hello.optional_features.iter())
        .filter(|feature| {
            result
                .enabled_features
                .iter()
                .any(|enabled| enabled == *feature)
        })
        .collect();
    let actual_enabled: Vec<&String> = result.enabled_features.iter().collect();
    if expected_enabled != actual_enabled
        || hello
            .required_features
            .iter()
            .any(|required| !result.enabled_features.contains(required))
    {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }

    let expected_unavailable: Vec<&String> = hello
        .optional_features
        .iter()
        .filter(|optional| !result.enabled_features.contains(optional))
        .collect();
    let actual_unavailable: Vec<&String> = result.unavailable_optional_features.iter().collect();
    if expected_unavailable != actual_unavailable {
        return Err(ProtocolError(ProtocolErrorKind::TransportIncompatible));
    }
    Ok(())
}

/// Creates the host-visible success response from a trusted negotiation result.
pub fn hello_result_for(
    hello: &KernelHelloV1,
    negotiated: &NegotiatedProtocol,
) -> Result<KernelHelloResultV1, ProtocolError> {
    let result = KernelHelloResultV1 {
        protocol: negotiated.protocol,
        enabled_features: negotiated.enabled_features.clone(),
        unavailable_optional_features: negotiated.unavailable_optional_features.clone(),
        supervisor_nonce: hello.supervisor_nonce.clone(),
        process_incarnation: hello.process_incarnation.clone(),
    };
    validate_hello_result_binding(hello, &result)?;
    Ok(result)
}

/// Validates a service body using an owner-declared byte cap, lowered to the global
/// request/response limit. The cap must come from the trusted operation registry.
pub fn validate_operation_body(body: &Value, owner_max_bytes: usize) -> Result<(), ProtocolError> {
    validate_value_bound("body", body, owner_max_bytes.min(MAX_BODY_BYTES))
}

/// Produces canonical MessagePack body bytes for an owner payload digest after
/// operation-schema normalization. Never substitute the original frame byte slice.
pub fn canonical_body_bytes(
    body: &Value,
    owner_max_bytes: usize,
) -> Result<Vec<u8>, ProtocolError> {
    let limits = Limits {
        max_encoded_bytes: owner_max_bytes.min(MAX_BODY_BYTES),
        ..FRAME_LIMITS
    };
    messagepack::encode(body, limits).map_err(Into::into)
}

/// Applies the stricter chunk-body ceiling for the dedicated artifact-transfer
/// operation. Artifact ownership, offsets, totals, digest and authorization are
/// validated by the ArtifactService and are deliberately not inferred here.
pub fn validate_artifact_chunk_body(body: &Value) -> Result<(), ProtocolError> {
    validate_value_bound("body", body, MAX_ARTIFACT_CHUNK_BODY_BYTES)
}

fn message_to_value(message: &RpcMessageV1) -> Value {
    let mut map = BTreeMap::new();
    match message {
        RpcMessageV1::Hello(hello) => {
            put(&mut map, "kind", string("hello"));
            put(&mut map, "minProtocol", number(hello.min_protocol as u64));
            put(&mut map, "maxProtocol", number(hello.max_protocol as u64));
            put(
                &mut map,
                "hostBuildDigest",
                string(&hello.host_build_digest),
            );
            put_optional(
                &mut map,
                "kernelBuildDigest",
                hello.kernel_build_digest.as_deref().map(string),
            );
            put(&mut map, "hostInstanceId", string(&hello.host_instance_id));
            put(
                &mut map,
                "processIncarnation",
                string(&hello.process_incarnation),
            );
            put(&mut map, "supervisorNonce", string(&hello.supervisor_nonce));
            put(
                &mut map,
                "requiredFeatures",
                strings(&hello.required_features),
            );
            put(
                &mut map,
                "optionalFeatures",
                strings(&hello.optional_features),
            );
        }
        RpcMessageV1::HelloResult(result) => {
            put(&mut map, "kind", string("hello_result"));
            put(&mut map, "protocol", number(result.protocol as u64));
            put(
                &mut map,
                "enabledFeatures",
                strings(&result.enabled_features),
            );
            put(
                &mut map,
                "unavailableOptionalFeatures",
                strings(&result.unavailable_optional_features),
            );
            put(
                &mut map,
                "supervisorNonce",
                string(&result.supervisor_nonce),
            );
            put(
                &mut map,
                "processIncarnation",
                string(&result.process_incarnation),
            );
        }
        RpcMessageV1::HelloRejected(rejected) => {
            put(&mut map, "kind", string("hello_rejected"));
            put(&mut map, "error", typed_error_to_value(&rejected.error));
        }
        RpcMessageV1::StartupStatus(status) => {
            put(&mut map, "kind", string("startup_status"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            match status.as_ref() {
                KernelStartupStatusV1::Starting => {
                    put(&mut map, "state", string("STARTING"));
                }
                KernelStartupStatusV1::Ready => {
                    put(&mut map, "state", string("READY"));
                }
                KernelStartupStatusV1::Failed(error) => {
                    put(&mut map, "state", string("FAILED"));
                    put(&mut map, "error", typed_error_to_value(error));
                }
            }
        }
        RpcMessageV1::Request(request) => {
            put(&mut map, "kind", string("request"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            put(&mut map, "requestId", string(&request.request_id));
            put(&mut map, "serviceId", string(&request.service_id));
            put(&mut map, "operation", string(&request.operation));
            put_optional(
                &mut map,
                "deliveryId",
                request.delivery_id.as_deref().map(string),
            );
            put_optional(
                &mut map,
                "expectedCursor",
                request.expected_cursor.as_ref().map(cursor_to_value),
            );
            put(&mut map, "deadlineUnixMs", number(request.deadline_unix_ms));
            put(&mut map, "traceId", string(&request.trace_id));
            put(&mut map, "body", request.body.clone());
        }
        RpcMessageV1::Response(response) => {
            put(&mut map, "kind", string("response"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            put(&mut map, "requestId", string(&response.request_id));
            put(
                &mut map,
                "outcome",
                string(match response.outcome {
                    RpcOutcomeV1::Ok => "ok",
                    RpcOutcomeV1::Error => "error",
                }),
            );
            put_optional(
                &mut map,
                "ownerCursor",
                response.owner_cursor.as_ref().map(cursor_to_value),
            );
            put_optional(
                &mut map,
                "receiptDigest",
                response.receipt_digest.as_deref().map(string),
            );
            put_optional(&mut map, "body", response.body.clone());
            put_optional(
                &mut map,
                "error",
                response.error.as_ref().map(typed_error_to_value),
            );
        }
        RpcMessageV1::Event(event) => {
            put(&mut map, "kind", string("event"));
            put(&mut map, "protocol", number(PROTOCOL_V1 as u64));
            put(&mut map, "subscriptionId", string(&event.subscription_id));
            put(&mut map, "cursor", cursor_to_value(&event.cursor));
            put(&mut map, "eventType", string(&event.event_type));
            put(&mut map, "payload", event.payload.clone());
        }
        RpcMessageV1::Control(control) => match control.as_ref() {
            RpcControlV1::Subscribe {
                subscription_id,
                owner_kind,
                owner_id,
                after,
            } => {
                put(&mut map, "kind", string("subscribe"));
                put(&mut map, "subscriptionId", string(subscription_id));
                put(&mut map, "ownerKind", string(owner_kind));
                put(&mut map, "ownerId", string(owner_id));
                put_optional(&mut map, "after", after.as_ref().map(cursor_to_value));
            }
            RpcControlV1::Unsubscribe { subscription_id } => {
                put(&mut map, "kind", string("unsubscribe"));
                put(&mut map, "subscriptionId", string(subscription_id));
            }
            RpcControlV1::Ack {
                subscription_id,
                through,
            } => {
                put(&mut map, "kind", string("ack"));
                put(&mut map, "subscriptionId", string(subscription_id));
                put(&mut map, "through", cursor_to_value(through));
            }
            RpcControlV1::CancelRequest { request_id } => {
                put(&mut map, "kind", string("cancel_request"));
                put(&mut map, "requestId", string(request_id));
            }
            RpcControlV1::Ping { nonce } => {
                put(&mut map, "kind", string("ping"));
                put(&mut map, "nonce", string(nonce));
            }
        },
    }
    Value::Map(map)
}

fn value_to_message(value: Value) -> Result<RpcMessageV1, ProtocolError> {
    let mut map = into_map(value, "message")?;
    let kind = take_string(&mut map, "kind", MAX_IDENTIFIER_BYTES)?;
    match kind.as_str() {
        "hello" => Ok(RpcMessageV1::Hello(Box::new(KernelHelloV1 {
            min_protocol: take_u16(&mut map, "minProtocol")?,
            max_protocol: take_u16(&mut map, "maxProtocol")?,
            host_build_digest: take_string(&mut map, "hostBuildDigest", MAX_IDENTIFIER_BYTES)?,
            kernel_build_digest: take_optional_string(
                &mut map,
                "kernelBuildDigest",
                MAX_IDENTIFIER_BYTES,
            )?,
            host_instance_id: take_string(&mut map, "hostInstanceId", MAX_IDENTIFIER_BYTES)?,
            process_incarnation: take_string(&mut map, "processIncarnation", MAX_IDENTIFIER_BYTES)?,
            supervisor_nonce: take_string(&mut map, "supervisorNonce", MAX_IDENTIFIER_BYTES)?,
            required_features: take_strings(&mut map, "requiredFeatures", MAX_FEATURE_COUNT)?,
            optional_features: take_strings(&mut map, "optionalFeatures", MAX_FEATURE_COUNT)?,
        }))),
        "hello_result" => {
            take_protocol(&mut map)?;
            Ok(RpcMessageV1::HelloResult(Box::new(KernelHelloResultV1 {
                protocol: PROTOCOL_V1,
                enabled_features: take_strings(&mut map, "enabledFeatures", MAX_FEATURE_COUNT)?,
                unavailable_optional_features: take_strings(
                    &mut map,
                    "unavailableOptionalFeatures",
                    MAX_FEATURE_COUNT,
                )?,
                supervisor_nonce: take_string(&mut map, "supervisorNonce", MAX_IDENTIFIER_BYTES)?,
                process_incarnation: take_string(
                    &mut map,
                    "processIncarnation",
                    MAX_IDENTIFIER_BYTES,
                )?,
            })))
        }
        "hello_rejected" => Ok(RpcMessageV1::HelloRejected(Box::new(
            KernelHelloRejectedV1 {
                error: value_to_typed_error(take_required(&mut map, "error")?)?,
            },
        ))),
        "startup_status" => {
            take_protocol(&mut map)?;
            let state = take_string(&mut map, "state", 16)?;
            let error = take_optional(&mut map, "error")?;
            let status = match (state.as_str(), error) {
                ("STARTING", None) => KernelStartupStatusV1::Starting,
                ("READY", None) => KernelStartupStatusV1::Ready,
                ("FAILED", Some(error)) => {
                    KernelStartupStatusV1::Failed(Box::new(value_to_typed_error(error)?))
                }
                ("STARTING" | "READY", Some(_)) => {
                    return Err(invalid("error", "only FAILED startup status has an error"));
                }
                ("FAILED", None) => {
                    return Err(missing("error"));
                }
                _ => return Err(invalid("state", "unknown startup status")),
            };
            Ok(RpcMessageV1::StartupStatus(Box::new(status)))
        }
        "request" => {
            take_protocol(&mut map)?;
            Ok(RpcMessageV1::Request(Box::new(RpcRequestV1 {
                request_id: take_string(&mut map, "requestId", MAX_IDENTIFIER_BYTES)?,
                service_id: take_string(&mut map, "serviceId", MAX_IDENTIFIER_BYTES)?,
                operation: take_string(&mut map, "operation", MAX_IDENTIFIER_BYTES)?,
                delivery_id: take_optional_string(&mut map, "deliveryId", MAX_IDENTIFIER_BYTES)?,
                expected_cursor: take_optional(&mut map, "expectedCursor")?
                    .map(value_to_cursor)
                    .transpose()?,
                deadline_unix_ms: take_u64(&mut map, "deadlineUnixMs")?,
                trace_id: take_string(&mut map, "traceId", MAX_IDENTIFIER_BYTES)?,
                body: take_required(&mut map, "body")?,
            })))
        }
        "response" => {
            take_protocol(&mut map)?;
            let request_id = take_string(&mut map, "requestId", MAX_IDENTIFIER_BYTES)?;
            let outcome = match take_string(&mut map, "outcome", 16)?.as_str() {
                "ok" => RpcOutcomeV1::Ok,
                "error" => RpcOutcomeV1::Error,
                _ => return Err(invalid("outcome", "must be `ok` or `error`")),
            };
            Ok(RpcMessageV1::Response(Box::new(RpcResponseV1 {
                request_id,
                outcome,
                owner_cursor: take_optional(&mut map, "ownerCursor")?
                    .map(value_to_cursor)
                    .transpose()?,
                receipt_digest: take_optional_string(
                    &mut map,
                    "receiptDigest",
                    MAX_IDENTIFIER_BYTES,
                )?,
                body: take_optional(&mut map, "body")?,
                error: take_optional(&mut map, "error")?
                    .map(value_to_typed_error)
                    .transpose()?,
            })))
        }
        "event" => {
            take_protocol(&mut map)?;
            Ok(RpcMessageV1::Event(Box::new(RpcEventV1 {
                subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
                cursor: value_to_cursor(take_required(&mut map, "cursor")?)?,
                event_type: take_string(&mut map, "eventType", MAX_IDENTIFIER_BYTES)?,
                payload: take_required(&mut map, "payload")?,
            })))
        }
        "subscribe" => Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
            subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
            owner_kind: take_string(&mut map, "ownerKind", MAX_IDENTIFIER_BYTES)?,
            owner_id: take_string(&mut map, "ownerId", MAX_IDENTIFIER_BYTES)?,
            after: take_optional(&mut map, "after")?
                .map(value_to_cursor)
                .transpose()?,
        }))),
        "unsubscribe" => Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Unsubscribe {
            subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
        }))),
        "ack" => Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
            subscription_id: take_string(&mut map, "subscriptionId", MAX_IDENTIFIER_BYTES)?,
            through: value_to_cursor(take_required(&mut map, "through")?)?,
        }))),
        "cancel_request" => Ok(RpcMessageV1::Control(Box::new(
            RpcControlV1::CancelRequest {
                request_id: take_string(&mut map, "requestId", MAX_IDENTIFIER_BYTES)?,
            },
        ))),
        "ping" => Ok(RpcMessageV1::Control(Box::new(RpcControlV1::Ping {
            nonce: take_string(&mut map, "nonce", MAX_IDENTIFIER_BYTES)?,
        }))),
        _ => Err(ProtocolError(ProtocolErrorKind::UnsupportedKind)),
    }
}

fn cursor_to_value(cursor: &CursorV1) -> Value {
    let mut map = BTreeMap::new();
    put(&mut map, "ownerKind", string(&cursor.owner_kind));
    put(&mut map, "ownerId", string(&cursor.owner_id));
    put(&mut map, "seq", string(&cursor.seq));
    put(&mut map, "eventDigest", string(&cursor.event_digest));
    Value::Map(map)
}

fn value_to_cursor(value: Value) -> Result<CursorV1, ProtocolError> {
    let mut map = into_map(value, "cursor")?;
    Ok(CursorV1 {
        owner_kind: take_string(&mut map, "ownerKind", MAX_IDENTIFIER_BYTES)?,
        owner_id: take_string(&mut map, "ownerId", MAX_IDENTIFIER_BYTES)?,
        seq: take_string(&mut map, "seq", 20)?,
        event_digest: take_string(&mut map, "eventDigest", MAX_IDENTIFIER_BYTES)?,
    })
}

fn artifact_ref_to_value(reference: &ArtifactRefV1) -> Value {
    let mut map = BTreeMap::new();
    put(&mut map, "artifactId", string(&reference.artifact_id));
    put(&mut map, "digest", string(&reference.digest));
    put(&mut map, "byteLength", string(&reference.byte_length));
    put(&mut map, "mediaType", string(&reference.media_type));
    put(
        &mut map,
        "classification",
        string(match reference.classification {
            ArtifactClassificationV1::Public => "public",
            ArtifactClassificationV1::Workspace => "workspace",
            ArtifactClassificationV1::Sensitive => "sensitive",
        }),
    );
    Value::Map(map)
}

fn value_to_artifact_ref(value: Value) -> Result<ArtifactRefV1, ProtocolError> {
    let mut map = into_map(value, "artifactRef")?;
    let classification = match take_string(&mut map, "classification", 32)?.as_str() {
        "public" => ArtifactClassificationV1::Public,
        "workspace" => ArtifactClassificationV1::Workspace,
        "sensitive" => ArtifactClassificationV1::Sensitive,
        _ => {
            return Err(invalid(
                "artifactRef.classification",
                "unknown classification",
            ));
        }
    };
    Ok(ArtifactRefV1 {
        artifact_id: take_string(&mut map, "artifactId", MAX_IDENTIFIER_BYTES)?,
        digest: take_string(&mut map, "digest", MAX_IDENTIFIER_BYTES)?,
        byte_length: take_string(&mut map, "byteLength", 20)?,
        media_type: take_string(&mut map, "mediaType", MAX_IDENTIFIER_BYTES)?,
        classification,
    })
}

fn typed_error_to_value(error: &TypedErrorV1) -> Value {
    let mut map = BTreeMap::new();
    put(&mut map, "code", string(&error.code));
    put(
        &mut map,
        "category",
        string(category_to_str(error.category)),
    );
    put(&mut map, "message", string(&error.message));
    put(
        &mut map,
        "retryClass",
        string(retry_class_to_str(error.retry_class)),
    );
    put_optional(&mut map, "retryAfterMs", error.retry_after_ms.map(number));
    put_optional(
        &mut map,
        "ownerCursor",
        error.owner_cursor.as_ref().map(cursor_to_value),
    );
    put(&mut map, "subjectIds", strings(&error.subject_ids));
    put_optional(
        &mut map,
        "details",
        error.details.as_ref().map(artifact_ref_to_value),
    );
    Value::Map(map)
}

fn value_to_typed_error(value: Value) -> Result<TypedErrorV1, ProtocolError> {
    let mut map = into_map(value, "error")?;
    let category = match take_string(&mut map, "category", 32)?.as_str() {
        "validation" => ErrorCategoryV1::Validation,
        "conflict" => ErrorCategoryV1::Conflict,
        "authorization" => ErrorCategoryV1::Authorization,
        "capability" => ErrorCategoryV1::Capability,
        "not_found" => ErrorCategoryV1::NotFound,
        "unavailable" => ErrorCategoryV1::Unavailable,
        "deadline" => ErrorCategoryV1::Deadline,
        "uncertain" => ErrorCategoryV1::Uncertain,
        "corruption" => ErrorCategoryV1::Corruption,
        "internal" => ErrorCategoryV1::Internal,
        _ => return Err(invalid("error.category", "unknown error category")),
    };
    let retry_class = match take_string(&mut map, "retryClass", 40)?.as_str() {
        "NEVER" => RetryClassV1::Never,
        "SAFE_QUERY_RETRY" => RetryClassV1::SafeQueryRetry,
        "RETRY_AFTER_RECONCILIATION" => RetryClassV1::RetryAfterReconciliation,
        "RETRY_AFTER_CONTEXT_RECOVERY" => RetryClassV1::RetryAfterContextRecovery,
        "USER_ACTION_REQUIRED" => RetryClassV1::UserActionRequired,
        "RETRY_WITH_NEW_ID" => RetryClassV1::RetryWithNewId,
        _ => return Err(invalid("error.retryClass", "unknown retry class")),
    };
    Ok(TypedErrorV1 {
        code: take_string(&mut map, "code", MAX_IDENTIFIER_BYTES)?,
        category,
        message: take_string(&mut map, "message", MAX_ERROR_BYTES)?,
        retry_class,
        retry_after_ms: take_optional(&mut map, "retryAfterMs")?
            .map(value_to_u64)
            .transpose()?,
        owner_cursor: take_optional(&mut map, "ownerCursor")?
            .map(value_to_cursor)
            .transpose()?,
        subject_ids: take_strings(&mut map, "subjectIds", MAX_SUBJECT_IDS)?,
        details: take_optional(&mut map, "details")?
            .map(value_to_artifact_ref)
            .transpose()?,
    })
}

fn category_to_str(category: ErrorCategoryV1) -> &'static str {
    match category {
        ErrorCategoryV1::Validation => "validation",
        ErrorCategoryV1::Conflict => "conflict",
        ErrorCategoryV1::Authorization => "authorization",
        ErrorCategoryV1::Capability => "capability",
        ErrorCategoryV1::NotFound => "not_found",
        ErrorCategoryV1::Unavailable => "unavailable",
        ErrorCategoryV1::Deadline => "deadline",
        ErrorCategoryV1::Uncertain => "uncertain",
        ErrorCategoryV1::Corruption => "corruption",
        ErrorCategoryV1::Internal => "internal",
    }
}

fn retry_class_to_str(retry_class: RetryClassV1) -> &'static str {
    match retry_class {
        RetryClassV1::Never => "NEVER",
        RetryClassV1::SafeQueryRetry => "SAFE_QUERY_RETRY",
        RetryClassV1::RetryAfterReconciliation => "RETRY_AFTER_RECONCILIATION",
        RetryClassV1::RetryAfterContextRecovery => "RETRY_AFTER_CONTEXT_RECOVERY",
        RetryClassV1::UserActionRequired => "USER_ACTION_REQUIRED",
        RetryClassV1::RetryWithNewId => "RETRY_WITH_NEW_ID",
    }
}

fn put(map: &mut BTreeMap<String, Value>, key: &str, value: Value) {
    map.insert(key.to_owned(), value);
}

fn put_optional(map: &mut BTreeMap<String, Value>, key: &str, value: Option<Value>) {
    if let Some(value) = value {
        put(map, key, value);
    }
}

fn string(value: &str) -> Value {
    Value::String(value.to_owned())
}

fn number(value: u64) -> Value {
    Value::Unsigned(value)
}

fn strings(values: &[String]) -> Value {
    Value::Array(values.iter().map(|value| string(value)).collect())
}

fn into_map(value: Value, field: &'static str) -> Result<BTreeMap<String, Value>, ProtocolError> {
    match value {
        Value::Map(map) => Ok(map),
        _ => Err(invalid(field, "must be a MessagePack map")),
    }
}

fn take_required(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Value, ProtocolError> {
    map.remove(field).ok_or_else(|| missing(field))
}

fn take_optional(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
) -> Result<Option<Value>, ProtocolError> {
    Ok(map.remove(field))
}

fn take_string(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
    max: usize,
) -> Result<String, ProtocolError> {
    let value = match take_required(map, field)? {
        Value::String(value) => value,
        _ => return Err(invalid(field, "must be a string")),
    };
    text(field, &value, max)?;
    Ok(value)
}

fn take_optional_string(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
    max: usize,
) -> Result<Option<String>, ProtocolError> {
    take_optional(map, field)?
        .map(|value| match value {
            Value::String(value) => {
                text(field, &value, max)?;
                Ok(value)
            }
            _ => Err(invalid(field, "must be a string when present")),
        })
        .transpose()
}

fn take_u64(map: &mut BTreeMap<String, Value>, field: &'static str) -> Result<u64, ProtocolError> {
    value_to_u64(take_required(map, field)?)
        .map_err(|_| invalid(field, "must be an unsigned integer"))
}

fn value_to_u64(value: Value) -> Result<u64, ProtocolError> {
    match value {
        Value::Unsigned(value) => Ok(value),
        Value::Signed(value) if value >= 0 => Ok(value as u64),
        _ => Err(invalid("integer", "must be an unsigned integer")),
    }
}

fn take_u16(map: &mut BTreeMap<String, Value>, field: &'static str) -> Result<u16, ProtocolError> {
    u16::try_from(take_u64(map, field)?).map_err(|_| invalid(field, "exceeds u16 range"))
}

fn take_strings(
    map: &mut BTreeMap<String, Value>,
    field: &'static str,
    max_items: usize,
) -> Result<Vec<String>, ProtocolError> {
    let values = match take_required(map, field)? {
        Value::Array(values) => values,
        _ => return Err(invalid(field, "must be an array")),
    };
    if values.len() > max_items {
        return Err(invalid(field, "array exceeds the item limit"));
    }
    values
        .into_iter()
        .map(|value| match value {
            Value::String(value) => {
                text(field, &value, MAX_IDENTIFIER_BYTES)?;
                Ok(value)
            }
            _ => Err(invalid(field, "array entries must be strings")),
        })
        .collect()
}

fn take_protocol(map: &mut BTreeMap<String, Value>) -> Result<(), ProtocolError> {
    let protocol = take_u64(map, "protocol")?;
    if protocol != PROTOCOL_V1 as u64 {
        return Err(ProtocolError(ProtocolErrorKind::UnsupportedProtocol {
            protocol,
        }));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    const DIGEST: &str = "blake3:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn hello(required: &[&str], optional: &[&str]) -> KernelHelloV1 {
        KernelHelloV1 {
            min_protocol: 1,
            max_protocol: 2,
            host_build_digest: DIGEST.to_owned(),
            kernel_build_digest: None,
            host_instance_id: "host-1".to_owned(),
            process_incarnation: "inc-1".to_owned(),
            supervisor_nonce: "nonce-1".to_owned(),
            required_features: required.iter().map(|value| (*value).to_owned()).collect(),
            optional_features: optional.iter().map(|value| (*value).to_owned()).collect(),
        }
    }

    fn cursor() -> CursorV1 {
        CursorV1 {
            owner_kind: "thread".to_owned(),
            owner_id: "thr_1".to_owned(),
            seq: "42".to_owned(),
            event_digest: DIGEST.to_owned(),
        }
    }

    fn wire_message(fields: BTreeMap<String, Value>) -> Vec<u8> {
        messagepack::encode(&Value::Map(fields), FRAME_LIMITS).unwrap()
    }

    fn protocol_error() -> TypedErrorV1 {
        TypedErrorV1 {
            code: "TRANSPORT_INCOMPATIBLE".to_owned(),
            category: ErrorCategoryV1::Capability,
            message: "required protocol feature is unavailable".to_owned(),
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        }
    }

    fn hello_result() -> KernelHelloResultV1 {
        let host = hello(&["threads.v1"], &["memory.v1", "other.v1"]);
        let policy = HandshakePolicy {
            min_protocol: 1,
            max_protocol: 1,
            supported_features: BTreeSet::from(["threads.v1".to_owned(), "memory.v1".to_owned()]),
            expected_supervisor_nonce: "nonce-1".to_owned(),
            expected_host_process_incarnation: Some("inc-1".to_owned()),
        };
        let negotiated = negotiate_hello(&host, &policy).unwrap();
        hello_result_for(&host, &negotiated).unwrap()
    }

    #[test]
    fn accepts_hello_result_wire_message() {
        let wire = wire_message(BTreeMap::from([
            ("kind".to_owned(), string("hello_result")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            (
                "enabledFeatures".to_owned(),
                Value::Array(vec![string("threads.v1")]),
            ),
            (
                "unavailableOptionalFeatures".to_owned(),
                Value::Array(vec![string("memory.v1")]),
            ),
            ("supervisorNonce".to_owned(), string("nonce-1")),
            ("processIncarnation".to_owned(), string("inc-1")),
        ]));

        assert!(decode_message(&wire).is_ok());
    }

    #[test]
    fn accepts_typed_hello_rejection_wire_message() {
        let wire = wire_message(BTreeMap::from([
            ("kind".to_owned(), string("hello_rejected")),
            ("error".to_owned(), typed_error_to_value(&protocol_error())),
        ]));

        assert!(decode_message(&wire).is_ok());
    }

    #[test]
    fn accepts_startup_status_wire_variants() {
        for (state, error) in [
            ("STARTING", None),
            ("READY", None),
            ("FAILED", Some(typed_error_to_value(&protocol_error()))),
        ] {
            let mut fields = BTreeMap::from([
                ("kind".to_owned(), string("startup_status")),
                ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
                ("state".to_owned(), string(state)),
            ]);
            if let Some(error) = error {
                fields.insert("error".to_owned(), error);
            }
            assert!(decode_message(&wire_message(fields)).is_ok(), "{state}");
        }
    }

    #[test]
    fn handshake_messages_match_fixed_v1_wire_vectors() {
        let error = protocol_error();
        let messages = [
            (
                RpcMessageV1::HelloResult(Box::new(hello_result())),
                "86af656e61626c6564466561747572657392aa746872656164732e7631a96d656d6f72792e7631a46b696e64ac68656c6c6f5f726573756c74b270726f63657373496e6361726e6174696f6ea5696e632d31a870726f746f636f6c01af73757065727669736f724e6f6e6365a76e6f6e63652d31bb756e617661696c61626c654f7074696f6e616c466561747572657391a86f746865722e7631",
            ),
            (
                RpcMessageV1::HelloRejected(Box::new(KernelHelloRejectedV1 {
                    error: error.clone(),
                })),
                "82a56572726f7285a863617465676f7279aa6361706162696c697479a4636f6465b65452414e53504f52545f494e434f4d50415449424c45a76d657373616765d92872657175697265642070726f746f636f6c206665617475726520697320756e617661696c61626c65aa7265747279436c617373a54e45564552aa7375626a65637449647390a46b696e64ae68656c6c6f5f72656a6563746564",
            ),
            (
                RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Starting)),
                "83a46b696e64ae737461727475705f737461747573a870726f746f636f6c01a57374617465a85354415254494e47",
            ),
            (
                RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Ready)),
                "83a46b696e64ae737461727475705f737461747573a870726f746f636f6c01a57374617465a55245414459",
            ),
            (
                RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Failed(Box::new(
                    error,
                )))),
                "84a56572726f7285a863617465676f7279aa6361706162696c697479a4636f6465b65452414e53504f52545f494e434f4d50415449424c45a76d657373616765d92872657175697265642070726f746f636f6c206665617475726520697320756e617661696c61626c65aa7265747279436c617373a54e45564552aa7375626a65637449647390a46b696e64ae737461727475705f737461747573a870726f746f636f6c01a57374617465a64641494c4544",
            ),
        ];

        for (message, expected_hex) in messages {
            let expected = decode_hex(expected_hex);
            assert_eq!(encode_message(&message).unwrap(), expected);
            assert_eq!(decode_message(&expected).unwrap(), message);
        }
    }

    fn decode_hex(value: &str) -> Vec<u8> {
        assert_eq!(value.len() % 2, 0);
        value
            .as_bytes()
            .chunks(2)
            .map(|pair| {
                let pair = std::str::from_utf8(pair).unwrap();
                u8::from_str_radix(pair, 16).unwrap()
            })
            .collect()
    }

    fn request(body: Value) -> RpcMessageV1 {
        RpcMessageV1::Request(Box::new(RpcRequestV1 {
            request_id: "req_1".to_owned(),
            service_id: "thread".to_owned(),
            operation: "query".to_owned(),
            delivery_id: None,
            expected_cursor: Some(cursor()),
            deadline_unix_ms: 1_800_000_000_000,
            trace_id: "trace_1".to_owned(),
            body,
        }))
    }

    #[test]
    fn round_trips_all_message_families_and_framed_io() {
        let failure = protocol_error();
        let messages = [
            RpcMessageV1::Hello(Box::new(hello(&["threads.v1"], &["memory.v1"]))),
            RpcMessageV1::HelloResult(Box::new(hello_result())),
            RpcMessageV1::HelloRejected(Box::new(KernelHelloRejectedV1 {
                error: failure.clone(),
            })),
            RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Starting)),
            RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Ready)),
            RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Failed(Box::new(failure)))),
            request(Value::Map(BTreeMap::from([(
                "input".to_owned(),
                Value::String("hello".to_owned()),
            )]))),
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                request_id: "req_1".to_owned(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: Some(cursor()),
                receipt_digest: Some(DIGEST.to_owned()),
                body: Some(Value::Bool(true)),
                error: None,
            })),
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                request_id: "req_error".to_owned(),
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(TypedErrorV1 {
                    code: "STALE_CURSOR".to_owned(),
                    category: ErrorCategoryV1::Conflict,
                    message: "owner cursor changed".to_owned(),
                    retry_class: RetryClassV1::SafeQueryRetry,
                    retry_after_ms: None,
                    owner_cursor: Some(cursor()),
                    subject_ids: vec!["thr_1".to_owned()],
                    details: None,
                }),
            })),
            RpcMessageV1::Event(Box::new(RpcEventV1 {
                subscription_id: "sub_1".to_owned(),
                cursor: cursor(),
                event_type: "thread/message_committed".to_owned(),
                payload: Value::Array(vec![Value::Unsigned(1)]),
            })),
            RpcMessageV1::Control(Box::new(RpcControlV1::CancelRequest {
                request_id: "req_1".to_owned(),
            })),
        ];

        for message in messages {
            let encoded = encode_message(&message).unwrap();
            assert_eq!(decode_message(&encoded).unwrap(), message);
            let mut framed = Vec::new();
            write_message(&mut framed, &message).unwrap();
            assert_eq!(
                read_message(&mut Cursor::new(framed)).unwrap(),
                Some(message)
            );
        }
    }

    #[test]
    fn hello_result_binding_rejects_nonce_incarnation_and_feature_mismatches() {
        let host = hello(&["threads.v1"], &["memory.v1", "other.v1"]);
        let result = hello_result();
        assert!(validate_hello_result_binding(&host, &result).is_ok());

        let mut wrong_nonce = result.clone();
        wrong_nonce.supervisor_nonce = "other-nonce".to_owned();
        assert!(validate_hello_result_binding(&host, &wrong_nonce).is_err());

        let mut wrong_incarnation = result.clone();
        wrong_incarnation.process_incarnation = "other-incarnation".to_owned();
        assert!(validate_hello_result_binding(&host, &wrong_incarnation).is_err());

        let mut missing_required = result.clone();
        missing_required.enabled_features.clear();
        missing_required.unavailable_optional_features = vec!["threads.v1".to_owned()];
        assert!(validate_hello_result_binding(&host, &missing_required).is_err());

        let mut unrequested_feature = result;
        unrequested_feature
            .enabled_features
            .push("unrequested.v1".to_owned());
        assert!(validate_hello_result_binding(&host, &unrequested_feature).is_err());
    }

    #[test]
    fn rejects_malformed_hello_result_and_startup_status_fields() {
        let mut wrong_protocol = BTreeMap::from([
            ("kind".to_owned(), string("hello_result")),
            ("protocol".to_owned(), number(2)),
            ("enabledFeatures".to_owned(), Value::Array(vec![])),
            (
                "unavailableOptionalFeatures".to_owned(),
                Value::Array(vec![]),
            ),
            ("supervisorNonce".to_owned(), string("nonce-1")),
            ("processIncarnation".to_owned(), string("inc-1")),
        ]);
        assert!(decode_message(&wire_message(wrong_protocol.clone())).is_err());

        wrong_protocol.insert("protocol".to_owned(), number(PROTOCOL_V1 as u64));
        wrong_protocol.insert(
            "enabledFeatures".to_owned(),
            Value::Array(vec![string("threads.v1"), string("threads.v1")]),
        );
        assert!(decode_message(&wire_message(wrong_protocol)).is_err());

        let ready_with_error = BTreeMap::from([
            ("kind".to_owned(), string("startup_status")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            ("state".to_owned(), string("READY")),
            ("error".to_owned(), typed_error_to_value(&protocol_error())),
        ]);
        assert!(decode_message(&wire_message(ready_with_error)).is_err());

        let failed_without_error = BTreeMap::from([
            ("kind".to_owned(), string("startup_status")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            ("state".to_owned(), string("FAILED")),
        ]);
        assert!(decode_message(&wire_message(failed_without_error)).is_err());

        let unknown_state = BTreeMap::from([
            ("kind".to_owned(), string("startup_status")),
            ("protocol".to_owned(), number(PROTOCOL_V1 as u64)),
            ("state".to_owned(), string("RESTARTING")),
        ]);
        assert!(decode_message(&wire_message(unknown_state)).is_err());
    }

    #[test]
    fn hello_result_features_are_bounded_unique_and_disjoint() {
        let mut too_many = hello_result();
        too_many.enabled_features = (0..=MAX_FEATURE_COUNT)
            .map(|index| format!("feature-{index}"))
            .collect();
        assert!(validate_message(&RpcMessageV1::HelloResult(Box::new(too_many))).is_err());

        let mut duplicate = hello_result();
        duplicate.enabled_features.push("threads.v1".to_owned());
        assert!(validate_message(&RpcMessageV1::HelloResult(Box::new(duplicate))).is_err());

        let mut overlap = hello_result();
        overlap
            .unavailable_optional_features
            .push("threads.v1".to_owned());
        assert!(validate_message(&RpcMessageV1::HelloResult(Box::new(overlap))).is_err());
    }

    #[test]
    fn startup_status_wire_omits_error_except_for_failure() {
        for status in [
            KernelStartupStatusV1::Starting,
            KernelStartupStatusV1::Ready,
        ] {
            let Value::Map(map) = message_to_value(&RpcMessageV1::StartupStatus(Box::new(status)))
            else {
                panic!("startup status must encode as a map");
            };
            assert!(!map.contains_key("error"));
        }

        let failed = RpcMessageV1::StartupStatus(Box::new(KernelStartupStatusV1::Failed(
            Box::new(protocol_error()),
        )));
        let Value::Map(map) = message_to_value(&failed) else {
            panic!("startup status must encode as a map");
        };
        assert!(map.contains_key("error"));
    }

    #[test]
    fn control_messages_match_fixed_v1_wire_vectors() {
        let control_messages = [
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                    subscription_id: "sub_1".to_owned(),
                    owner_kind: "thread".to_owned(),
                    owner_id: "thr_1".to_owned(),
                    after: None,
                })),
                "84a46b696e64a9737562736372696265a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164ae737562736372697074696f6e4964a57375625f31",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                    subscription_id: "sub_1".to_owned(),
                    owner_kind: "thread".to_owned(),
                    owner_id: "thr_1".to_owned(),
                    after: Some(cursor()),
                })),
                "85a5616674657284ab6576656e74446967657374d947626c616b65333a30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164a3736571a23432a46b696e64a9737562736372696265a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164ae737562736372697074696f6e4964a57375625f31",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Unsubscribe {
                    subscription_id: "sub_1".to_owned(),
                })),
                "82a46b696e64ab756e737562736372696265ae737562736372697074696f6e4964a57375625f31",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Ack {
                    subscription_id: "sub_1".to_owned(),
                    through: cursor(),
                })),
                "83a46b696e64a361636bae737562736372697074696f6e4964a57375625f31a77468726f75676884ab6576656e74446967657374d947626c616b65333a30313233343536373839616263646566303132333435363738396162636465663031323334353637383961626364656630313233343536373839616263646566a76f776e65724964a57468725f31a96f776e65724b696e64a6746872656164a3736571a23432",
            ),
            (
                RpcMessageV1::Control(Box::new(RpcControlV1::Ping {
                    nonce: "nonce_1".to_owned(),
                })),
                "82a46b696e64a470696e67a56e6f6e6365a76e6f6e63655f31",
            ),
        ];

        for (message, expected_hex) in control_messages {
            let expected = decode_hex(expected_hex);
            assert_eq!(encode_message(&message).unwrap(), expected);
            assert_eq!(decode_message(&expected).unwrap(), message);
        }
    }

    #[test]
    fn subscription_start_cursor_must_match_requested_owner() {
        let subscription_for = |cursor| {
            RpcMessageV1::Control(Box::new(RpcControlV1::Subscribe {
                subscription_id: "sub_1".to_owned(),
                owner_kind: "thread".to_owned(),
                owner_id: "thr_1".to_owned(),
                after: Some(cursor),
            }))
        };

        assert!(encode_message(&subscription_for(cursor())).is_ok());

        let mut wrong_owner_kind = cursor();
        wrong_owner_kind.owner_kind = "run".to_owned();
        assert!(encode_message(&subscription_for(wrong_owner_kind)).is_err());

        let mut wrong_owner_id = cursor();
        wrong_owner_id.owner_id = "thr_other".to_owned();
        assert!(encode_message(&subscription_for(wrong_owner_id)).is_err());
    }

    #[test]
    fn rejects_invalid_digest_decimal_response_shape_and_protocol_version() {
        let mut invalid_cursor = cursor();
        invalid_cursor.seq = "042".to_owned();
        assert!(validate_cursor(&invalid_cursor).is_err());

        let mut invalid_digest = hello(&[], &[]);
        invalid_digest.host_build_digest = "blake3:ABC".to_owned();
        assert!(validate_hello(&invalid_digest).is_err());

        let mismatched_receipt = RpcMessageV1::Response(Box::new(RpcResponseV1 {
            request_id: "req_1".to_owned(),
            outcome: RpcOutcomeV1::Ok,
            owner_cursor: Some(cursor()),
            receipt_digest: None,
            body: None,
            error: None,
        }));
        assert!(validate_message(&mismatched_receipt).is_err());

        let mut bad_protocol = message_to_value(&request(Value::Nil));
        if let Value::Map(map) = &mut bad_protocol {
            map.insert("protocol".to_owned(), Value::Unsigned(2));
        }
        let encoded = messagepack::encode(&bad_protocol, FRAME_LIMITS).unwrap();
        assert!(matches!(
            decode_message(&encoded).unwrap_err().0,
            ProtocolErrorKind::UnsupportedProtocol { protocol: 2 }
        ));
    }

    #[test]
    fn negotiation_selects_highest_kernel_version_and_rejects_unknown_required_features() {
        let mut host = hello(&["threads.v1"], &["memory.v1", "other.v1"]);
        host.process_incarnation = "host-inc-1".to_owned();
        let policy = HandshakePolicy {
            min_protocol: 1,
            max_protocol: 3,
            supported_features: BTreeSet::from(["threads.v1".to_owned(), "memory.v1".to_owned()]),
            expected_supervisor_nonce: "nonce-1".to_owned(),
            expected_host_process_incarnation: Some("host-inc-1".to_owned()),
        };
        let negotiated = negotiate_hello(&host, &policy).unwrap();
        assert_eq!(negotiated.protocol, 1);
        assert_eq!(negotiated.enabled_features, vec!["threads.v1", "memory.v1"]);
        assert_eq!(negotiated.unavailable_optional_features, vec!["other.v1"]);

        let mut unknown_required = hello(&["unknown.required"], &[]);
        unknown_required.process_incarnation = "host-inc-1".to_owned();
        assert!(matches!(
            negotiate_hello(&unknown_required, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let mut protocol_two_host = host.clone();
        protocol_two_host.min_protocol = 2;
        assert!(matches!(
            negotiate_hello(&protocol_two_host, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let protocol_two_kernel = HandshakePolicy {
            min_protocol: 2,
            ..policy.clone()
        };
        assert!(matches!(
            negotiate_hello(&host, &protocol_two_kernel).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let mut wrong_nonce = host.clone();
        wrong_nonce.supervisor_nonce = "wrong-nonce".to_owned();
        assert!(matches!(
            negotiate_hello(&wrong_nonce, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let mut wrong_incarnation = host;
        wrong_incarnation.process_incarnation = "wrong-incarnation".to_owned();
        assert!(matches!(
            negotiate_hello(&wrong_incarnation, &policy).unwrap_err().0,
            ProtocolErrorKind::TransportIncompatible
        ));

        let missing_expected_incarnation = HandshakePolicy {
            expected_host_process_incarnation: None,
            ..policy
        };
        assert!(matches!(
            negotiate_hello(
                &hello(&["threads.v1"], &["memory.v1"]),
                &missing_expected_incarnation
            )
            .unwrap_err()
            .0,
            ProtocolErrorKind::TransportIncompatible
        ));
    }

    #[test]
    fn request_response_and_event_bodies_have_independent_decoded_value_limits() {
        let too_large = Value::String("x".repeat(MAX_BODY_BYTES));
        assert!(validate_message(&request(too_large)).is_err());

        let response_for_body = |body| {
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                request_id: "req_body".to_owned(),
                outcome: RpcOutcomeV1::Ok,
                owner_cursor: None,
                receipt_digest: None,
                body: Some(body),
                error: None,
            }))
        };
        let body_at_limit = Value::Binary(vec![0; MAX_BODY_BYTES - 5]);
        assert_eq!(
            messagepack::encoded_len(&body_at_limit, FRAME_LIMITS).unwrap(),
            MAX_BODY_BYTES
        );
        assert!(encode_message(&response_for_body(body_at_limit)).is_ok());
        assert!(
            encode_message(&response_for_body(Value::Binary(vec![
                0;
                MAX_BODY_BYTES - 4
            ])))
            .is_err()
        );

        let event_for_payload = |payload| {
            RpcMessageV1::Event(Box::new(RpcEventV1 {
                subscription_id: "sub_1".to_owned(),
                cursor: cursor(),
                event_type: "test".to_owned(),
                payload,
            }))
        };
        let payload_at_limit = Value::Binary(vec![0; MAX_EVENT_PAYLOAD_BYTES - 5]);
        assert_eq!(
            messagepack::encoded_len(&payload_at_limit, FRAME_LIMITS).unwrap(),
            MAX_EVENT_PAYLOAD_BYTES
        );
        assert!(encode_message(&event_for_payload(payload_at_limit)).is_ok());
        assert!(
            encode_message(&event_for_payload(Value::Binary(vec![
                0;
                MAX_EVENT_PAYLOAD_BYTES
                    - 4
            ])))
            .is_err()
        );
    }

    #[test]
    fn trusted_operation_and_artifact_chunk_limits_can_only_lower_global_body_limit() {
        assert!(validate_operation_body(&Value::Nil, 0).is_err());
        let above_global_limit = Value::Binary(vec![0; MAX_BODY_BYTES - 4]);
        assert_eq!(
            messagepack::encoded_len(&above_global_limit, FRAME_LIMITS).unwrap(),
            MAX_BODY_BYTES + 1
        );
        assert!(validate_operation_body(&above_global_limit, MAX_BODY_BYTES + 1).is_err());
        assert!(canonical_body_bytes(&above_global_limit, MAX_BODY_BYTES + 1).is_err());
        let chunk_at_limit = Value::Binary(vec![0; MAX_ARTIFACT_CHUNK_BODY_BYTES - 5]);
        assert_eq!(
            messagepack::encoded_len(&chunk_at_limit, FRAME_LIMITS).unwrap(),
            MAX_ARTIFACT_CHUNK_BODY_BYTES
        );
        assert!(validate_artifact_chunk_body(&chunk_at_limit).is_ok());
        assert!(
            validate_artifact_chunk_body(&Value::Binary(vec![
                0;
                MAX_ARTIFACT_CHUNK_BODY_BYTES - 4
            ]))
            .is_err()
        );
    }

    #[test]
    fn operation_body_limit_matches_canonical_encoded_bytes() {
        let body = Value::String("x".to_owned());
        let encoded_length = messagepack::encoded_len(&body, FRAME_LIMITS).unwrap();
        assert_eq!(encoded_length, 2);
        assert!(validate_operation_body(&body, encoded_length).is_ok());
        assert!(validate_operation_body(&body, encoded_length - 1).is_err());
        assert_eq!(
            canonical_body_bytes(&body, encoded_length).unwrap(),
            [0xa1, b'x']
        );
        assert!(canonical_body_bytes(&body, encoded_length - 1).is_err());
    }

    #[test]
    fn deadline_limits_depend_on_trusted_operation_class() {
        assert!(validate_deadline(10_000, 1_000, false).is_ok());
        assert!(validate_deadline(400_000, 1_000, false).is_err());
        assert!(validate_deadline(400_000, 1_000, true).is_ok());
        assert!(validate_deadline(1_000, 1_000, true).is_err());
        assert!(validate_deadline(MAX_SAFE_INTEGER + 1, 1_000, true).is_err());
        assert!(validate_deadline(1_000 + MAX_DEADLINE_INTERACTIVE_MS, 1_000, false).is_ok());
        assert!(validate_deadline(1_001 + MAX_DEADLINE_INTERACTIVE_MS, 1_000, false).is_err());
        assert!(validate_deadline(1_000 + MAX_DEADLINE_DURABLE_MS, 1_000, true).is_ok());
        assert!(validate_deadline(1_001 + MAX_DEADLINE_DURABLE_MS, 1_000, true).is_err());
    }

    #[test]
    fn rejects_javascript_unsafe_deadline_and_retry_duration_fields() {
        let mut request = match request(Value::Nil) {
            RpcMessageV1::Request(request) => *request,
            _ => unreachable!(),
        };
        request.deadline_unix_ms = MAX_SAFE_INTEGER + 1;
        assert!(validate_message(&RpcMessageV1::Request(Box::new(request))).is_err());

        let response = RpcMessageV1::Response(Box::new(RpcResponseV1 {
            request_id: "req_error".to_owned(),
            outcome: RpcOutcomeV1::Error,
            owner_cursor: None,
            receipt_digest: None,
            body: None,
            error: Some(TypedErrorV1 {
                code: "RATE_LIMITED".to_owned(),
                category: ErrorCategoryV1::Unavailable,
                message: "retry later".to_owned(),
                retry_class: RetryClassV1::Never,
                retry_after_ms: Some(u64::MAX),
                owner_cursor: None,
                subject_ids: Vec::new(),
                details: None,
            }),
        }));
        assert!(validate_message(&response).is_err());
    }

    #[test]
    fn enforces_the_encoded_typed_error_detail_limit_at_the_boundary() {
        assert_eq!(MAX_ERROR_BYTES, 64 * 1024);

        let error_for_message = |message: String| TypedErrorV1 {
            code: "UNAVAILABLE".to_owned(),
            category: ErrorCategoryV1::Unavailable,
            message,
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        };
        let encoded_error_len = |message_length: usize| {
            let value = typed_error_to_value(&error_for_message("x".repeat(message_length)));
            messagepack::encoded_len(&value, FRAME_LIMITS).unwrap()
        };
        let response_for_message = |message: String| {
            RpcMessageV1::Response(Box::new(RpcResponseV1 {
                request_id: "req_error".to_owned(),
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(error_for_message(message)),
            }))
        };

        let mut largest_accepted_message = 0;
        let mut upper_message_length = MAX_ERROR_BYTES;
        while largest_accepted_message < upper_message_length {
            let candidate = largest_accepted_message
                + (upper_message_length - largest_accepted_message).div_ceil(2);
            if encoded_error_len(candidate) <= MAX_ERROR_BYTES {
                largest_accepted_message = candidate;
            } else {
                upper_message_length = candidate - 1;
            }
        }

        assert!(largest_accepted_message < MAX_ERROR_BYTES);
        assert!(encoded_error_len(largest_accepted_message) <= MAX_ERROR_BYTES);
        assert!(encoded_error_len(largest_accepted_message + 1) > MAX_ERROR_BYTES);
        assert!(
            encode_message(&response_for_message("x".repeat(largest_accepted_message))).is_ok()
        );
        assert!(
            encode_message(&response_for_message(
                "x".repeat(largest_accepted_message + 1)
            ))
            .is_err()
        );
    }
}
