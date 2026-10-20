//! Bounded, versioned request/response frames for the indexd RepoIntel backend.
//!
//! This module is the crate-side of the transport that replaces the TypeScript
//! fork's fail-closed `unavailableBackend` (`RepoIntelBackend` in
//! `packages/opencode/src/tool/repo-intel.ts`). It defines exactly one
//! deterministic, length-prefixed, checksummed frame per RepoIntel backend call
//! and mirrors the port one call at a time:
//!
//! | Port call | Request | Success response |
//! |---|---|---|
//! | `build(pins, snapshots)` | [`TransportRequest::Build`] carrying a [`GenerationPack`] | [`TransportResponse::Build`] |
//! | `buildOverlay(handle, overlay)` | [`TransportRequest::BuildOverlay`] | [`TransportResponse::Overlay`] |
//! | `query(handle, request)` | [`TransportRequest::Query`] | [`TransportResponse::Query`] |
//! | `release(handle)` | [`TransportRequest::ReleaseGeneration`] | [`TransportResponse::Released`] |
//! | `releaseOverlay(overlay)` | [`TransportRequest::ReleaseOverlay`] | [`TransportResponse::Released`] |
//!
//! Every semantic failure — unknown generation, dangling overlay, stale cursor,
//! invalid query, unusable overlay batch — is a typed [`TransportResponse::Error`]
//! whose [`WireErrorCode`] string is exactly a TypeScript
//! `RepoIntelBackendErrorCode` value, so a host bridge maps codes mechanically.
//! Frame-level failures — direction, version, kind, declared length, checksum,
//! truncation — are [`TransportError`]s: no response frame is produced and the
//! host must treat the exchange as failed (`rejected`).
//!
//! This module performs no I/O, no authentication and no authorization. Frames
//! are bytes a host owner transmits, and the digest bindings inside them detect
//! context changes but never authorize access. Decoding is the hostile-input
//! boundary: the declared body length is bounded before any allocation, the
//! checksum is verified before the body is interpreted, and every declared field
//! length must fit the remaining body. Decode additionally enforces exactly the
//! wire caps that guard allocation (per-kind body caps, overlay change count,
//! response match count); all other value-level limits are reported by the
//! handler as typed error responses, matching what the port can observe.

use std::fmt;

use crate::{
    Digest, FileSnapshot, GenerationPack, IndexError, OpaquePin, OverlayChange, RepoIntelOperation,
    SearchCursor, SearchMatch, SearchTruncation, DEFAULT_MAX_PACK_BYTES, MAX_OVERLAY_CHANGES,
    MAX_OVERLAY_CONTENT_BYTES, MAX_PATH_BYTES, MAX_PIN_BYTES, MAX_QUERY_BYTES, MAX_QUERY_RESULTS,
    MAX_SEARCH_CURSOR_BYTES,
};

/// Envelope version of every transport frame.
pub const TRANSPORT_VERSION: u8 = 1;

/// Envelope bytes before the body: magic (4) + version (1) + kind (1) + body length (4).
pub const TRANSPORT_HEADER_BYTES: usize = 10;

/// Trailing BLAKE3 checksum bytes of every transport frame.
pub const TRANSPORT_CHECKSUM_BYTES: usize = 32;

/// Request kind: `build` — body is one [`GenerationPack`] frame.
pub const REQUEST_BUILD: u8 = 0;
/// Request kind: `buildOverlay`.
pub const REQUEST_OVERLAY: u8 = 1;
/// Request kind: `query`.
pub const REQUEST_QUERY: u8 = 2;
/// Request kind: `release` of one generation.
pub const REQUEST_RELEASE_GENERATION: u8 = 3;
/// Request kind: `releaseOverlay`.
pub const REQUEST_RELEASE_OVERLAY: u8 = 4;

/// Response kind for a `build` request.
pub const RESPONSE_BUILD: u8 = 0;
/// Response kind for a `buildOverlay` request.
pub const RESPONSE_OVERLAY: u8 = 1;
/// Response kind for a `query` request.
pub const RESPONSE_QUERY: u8 = 2;
/// Response kind for a `release` or `releaseOverlay` request.
pub const RESPONSE_RELEASED: u8 = 3;
/// Typed error response for any request kind.
pub const RESPONSE_ERROR: u8 = 4;

const REQUEST_MAGIC: &[u8; 4] = b"HZRQ";
const RESPONSE_MAGIC: &[u8; 4] = b"HZRS";
const FRAME_DOMAIN: &[u8] = b"horizon.indexd.transport.v1\0";

const OPERATION_TEXT: u8 = 0;
const OPERATION_SYMBOL: u8 = 1;
const OPERATION_REFERENCES: u8 = 2;
const OPERATION_IMPACT: u8 = 3;
const OPERATION_EXPAND: u8 = 4;

const CHANGE_CLEAR: u8 = 0;
const CHANGE_REPLACE: u8 = 1;

const STATUS_PARTIAL: u8 = 0;
const STATUS_UNAVAILABLE: u8 = 1;

const TRUNCATION_NONE: u8 = 0;
const TRUNCATION_WORK_LIMIT: u8 = 1;
const TRUNCATION_RESULT_LIMIT: u8 = 2;

/// Maximum bytes of a `build` request body (one [`GenerationPack`] frame).
pub const MAX_BUILD_BODY_BYTES: usize = DEFAULT_MAX_PACK_BYTES;

/// Maximum bytes of a `buildOverlay` request body.
///
/// Covers the generation id, a maximum opaque editor version, a maximum change
/// count with maximum per-field length prefixes and paths, and the maximum
/// aggregate replacement content. Clear changes contribute no content bytes.
pub const MAX_OVERLAY_BODY_BYTES: usize = 32
    + 4
    + MAX_PIN_BYTES
    + 4
    + MAX_OVERLAY_CHANGES * (4 + MAX_PATH_BYTES + 1 + 4)
    + MAX_OVERLAY_CONTENT_BYTES;

/// Maximum bytes of a `query` request body.
pub const MAX_QUERY_BODY_BYTES: usize =
    32 + 1 + 4 + MAX_QUERY_BYTES + 4 + 1 + 32 + 1 + 4 + MAX_SEARCH_CURSOR_BYTES;

/// Maximum bytes of a `release` or `releaseOverlay` request body.
pub const MAX_RELEASE_BODY_BYTES: usize = 32;

/// Maximum bytes of any one query success response body.
pub const MAX_QUERY_RESPONSE_BODY_BYTES: usize = 32
    + 1
    + (1 + 32
        + 4
        + MAX_QUERY_RESULTS * (4 + MAX_PATH_BYTES + 8 + 8)
        + 1
        + 4
        + MAX_SEARCH_CURSOR_BYTES
        + 8
        + 1);

/// Maximum UTF-8 bytes of one error response detail string.
pub const MAX_ERROR_DETAIL_BYTES: usize = 1_024;

/// Hard cap for any one transport body (the largest kind is `build`).
pub const MAX_TRANSPORT_BODY_BYTES: usize = MAX_BUILD_BODY_BYTES;

/// Hard cap for any one complete transport frame, checksum included.
pub const MAX_TRANSPORT_FRAME_BYTES: usize =
    TRANSPORT_HEADER_BYTES + MAX_TRANSPORT_BODY_BYTES + TRANSPORT_CHECKSUM_BYTES;

#[derive(Clone, Copy)]
enum Direction {
    Request,
    Response,
}

impl Direction {
    fn magic(self) -> &'static [u8; 4] {
        match self {
            Self::Request => REQUEST_MAGIC,
            Self::Response => RESPONSE_MAGIC,
        }
    }

    fn kind_known(self, kind: u8) -> bool {
        match self {
            Self::Request => matches!(
                kind,
                REQUEST_BUILD
                    | REQUEST_OVERLAY
                    | REQUEST_QUERY
                    | REQUEST_RELEASE_GENERATION
                    | REQUEST_RELEASE_OVERLAY
            ),
            Self::Response => matches!(
                kind,
                RESPONSE_BUILD
                    | RESPONSE_OVERLAY
                    | RESPONSE_QUERY
                    | RESPONSE_RELEASED
                    | RESPONSE_ERROR
            ),
        }
    }

    fn body_cap(self, kind: u8) -> usize {
        match self {
            Self::Request => match kind {
                REQUEST_BUILD => MAX_BUILD_BODY_BYTES,
                REQUEST_OVERLAY => MAX_OVERLAY_BODY_BYTES,
                REQUEST_QUERY => MAX_QUERY_BODY_BYTES,
                _ => MAX_RELEASE_BODY_BYTES,
            },
            Self::Response => match kind {
                RESPONSE_BUILD => 32,
                RESPONSE_OVERLAY => 64,
                RESPONSE_QUERY => MAX_QUERY_RESPONSE_BODY_BYTES,
                RESPONSE_RELEASED => 0,
                _ => 1 + 4 + MAX_ERROR_DETAIL_BYTES,
            },
        }
    }
}

/// Envelope facts of one frame, readable before the body arrives.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct FrameHeader {
    /// Request or response kind byte.
    pub kind: u8,
    /// Declared body byte length.
    pub body_len: usize,
    /// Total frame bytes to read: header + body + checksum.
    pub frame_len: usize,
}

/// Read the envelope header of a request frame without verifying its checksum.
///
/// A stream reader uses this to learn exactly how many bytes to read next; the
/// checksum is verified by [`TransportRequest::decode`] once the frame is
/// complete. Structural envelope fields (direction, version, kind, bounded body
/// length) are validated here so an incompatible peer is rejected before any
/// body is buffered.
pub fn peek_request_frame(header: &[u8]) -> Result<FrameHeader, TransportError> {
    peek_frame(Direction::Request, header)
}

/// Read the envelope header of a response frame without verifying its checksum.
pub fn peek_response_frame(header: &[u8]) -> Result<FrameHeader, TransportError> {
    peek_frame(Direction::Response, header)
}

fn peek_frame(direction: Direction, header: &[u8]) -> Result<FrameHeader, TransportError> {
    if header.len() < TRANSPORT_HEADER_BYTES {
        return Err(TransportError::Truncated);
    }
    if &header[..4] != direction.magic() {
        return Err(TransportError::InvalidDirection);
    }
    if header[4] != TRANSPORT_VERSION {
        return Err(TransportError::UnsupportedVersion {
            actual: header[4],
            expected: TRANSPORT_VERSION,
        });
    }
    let kind = header[5];
    if !direction.kind_known(kind) {
        return Err(TransportError::UnknownKind { kind });
    }
    let body_len = read_declared_body_len(&header[6..10])?;
    let cap = direction.body_cap(kind);
    if body_len > cap {
        return Err(TransportError::TooLarge { limit: cap });
    }
    Ok(FrameHeader {
        kind,
        body_len,
        frame_len: TRANSPORT_HEADER_BYTES + body_len + TRANSPORT_CHECKSUM_BYTES,
    })
}

/// One RepoIntel call from the host bridge to the indexd side.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportRequest {
    /// `RepoIntelBackend::build`: adopt one immutable generation.
    Build {
        /// A [`GenerationPack`] frame; its contents are validated when the
        /// indexd side handles the request, so pack failures become typed error
        /// responses instead of framing failures.
        pack: GenerationPack,
    },
    /// `RepoIntelBackend::query`: run one generation-bound operation.
    Query {
        generation_id: Digest,
        operation: RepoIntelOperation,
        query: String,
        max_results: usize,
        /// Digest of a previously built overlay to apply to this query.
        overlay_digest: Option<Digest>,
        /// Opaque serialized search cursor from a previous page.
        cursor: Option<String>,
    },
    /// `RepoIntelBackend::buildOverlay`: build an exact-generation overlay.
    BuildOverlay {
        generation_id: Digest,
        /// Opaque editor/buffer version pinned into the overlay identity.
        editor_version: OpaquePin,
        /// Bounded replacements and clears; each path must exist in the generation.
        changes: Vec<OverlayChange>,
    },
    /// `RepoIntelBackend::release`: drop one generation and its overlays.
    ReleaseGeneration { generation_id: Digest },
    /// `RepoIntelBackend::releaseOverlay`: drop one overlay.
    ReleaseOverlay { overlay_digest: Digest },
}

/// One indexd-side answer for a [`TransportRequest`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportResponse {
    /// Answer to [`TransportRequest::Build`].
    Build { generation_id: Digest },
    /// Answer to [`TransportRequest::BuildOverlay`].
    Overlay {
        base_generation_id: Digest,
        overlay_digest: Digest,
    },
    /// Answer to [`TransportRequest::Query`].
    Query(QueryResponse),
    /// Answer to a release request. Releases are idempotent.
    Released,
    /// Typed failure of any request kind.
    Error {
        code: WireErrorCode,
        detail: Option<String>,
    },
}

/// Success payloads of a query operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QueryResponse {
    /// The bounded lexical text result. Symbol/reference/impact/expand queries
    /// never produce this variant.
    Partial {
        generation_id: Digest,
        overlay_digest: Option<Digest>,
        matches: Vec<SearchMatch>,
        next_cursor: Option<String>,
        work_units: u64,
        truncated_by: Option<SearchTruncation>,
    },
    /// A well-formed operation this lexical backend cannot answer.
    Unavailable {
        generation_id: Digest,
        overlay_digest: Option<Digest>,
        operation: RepoIntelOperation,
    },
}

/// Stable error codes carried by [`TransportResponse::Error`].
///
/// The strings are exactly the TypeScript `RepoIntelBackendErrorCode` values, so
/// a host bridge maps them one-to-one. `unavailable` is reserved for "no
/// transport is wired" and is never produced by a decoded frame; `rejected`
/// covers indexd failures that the port has no dedicated code for.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum WireErrorCode {
    Unavailable,
    Rejected,
    GenerationMismatch,
    CursorGenerationMismatch,
    CursorQueryMismatch,
    CursorOverlayMismatch,
    CursorAnchorNotFound,
    CursorWorkLimit,
    InvalidSearchCursor,
    InvalidPath,
    DuplicatePath,
    InvalidUtf8,
    TooManyBaseFiles,
    FileTooLarge,
    BaseContentLimit,
    BasePathLimit,
    EmptyQuery,
    QueryTooLarge,
    MultilineQuery,
    InvalidResultLimit,
    OverlayGenerationMismatch,
}

impl WireErrorCode {
    /// Every code, in wire-tag order.
    pub const ALL: [Self; 21] = [
        Self::Unavailable,
        Self::Rejected,
        Self::GenerationMismatch,
        Self::CursorGenerationMismatch,
        Self::CursorQueryMismatch,
        Self::CursorOverlayMismatch,
        Self::CursorAnchorNotFound,
        Self::CursorWorkLimit,
        Self::InvalidSearchCursor,
        Self::InvalidPath,
        Self::DuplicatePath,
        Self::InvalidUtf8,
        Self::TooManyBaseFiles,
        Self::FileTooLarge,
        Self::BaseContentLimit,
        Self::BasePathLimit,
        Self::EmptyQuery,
        Self::QueryTooLarge,
        Self::MultilineQuery,
        Self::InvalidResultLimit,
        Self::OverlayGenerationMismatch,
    ];

    /// The stable snake-case string shared with the TypeScript port.
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Unavailable => "unavailable",
            Self::Rejected => "rejected",
            Self::GenerationMismatch => "generation_mismatch",
            Self::CursorGenerationMismatch => "cursor_generation_mismatch",
            Self::CursorQueryMismatch => "cursor_query_mismatch",
            Self::CursorOverlayMismatch => "cursor_overlay_mismatch",
            Self::CursorAnchorNotFound => "cursor_anchor_not_found",
            Self::CursorWorkLimit => "cursor_work_limit",
            Self::InvalidSearchCursor => "invalid_search_cursor",
            Self::InvalidPath => "invalid_path",
            Self::DuplicatePath => "duplicate_path",
            Self::InvalidUtf8 => "invalid_utf8",
            Self::TooManyBaseFiles => "too_many_base_files",
            Self::FileTooLarge => "file_too_large",
            Self::BaseContentLimit => "base_content_limit",
            Self::BasePathLimit => "base_path_limit",
            Self::EmptyQuery => "empty_query",
            Self::QueryTooLarge => "query_too_large",
            Self::MultilineQuery => "multiline_query",
            Self::InvalidResultLimit => "invalid_result_limit",
            Self::OverlayGenerationMismatch => "overlay_generation_mismatch",
        }
    }

    /// Parse a code from its stable string.
    pub fn parse(value: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|code| code.as_str() == value)
    }

    fn tag(self) -> u8 {
        self as u8
    }

    fn from_tag(tag: u8) -> Option<Self> {
        Self::ALL.get(usize::from(tag)).copied()
    }
}

impl fmt::Display for WireErrorCode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.as_str())
    }
}

impl From<&IndexError> for WireErrorCode {
    fn from(error: &IndexError) -> Self {
        match error {
            IndexError::GenerationMismatch { .. } => Self::GenerationMismatch,
            IndexError::CursorGenerationMismatch => Self::CursorGenerationMismatch,
            IndexError::CursorQueryMismatch => Self::CursorQueryMismatch,
            IndexError::CursorOverlayMismatch => Self::CursorOverlayMismatch,
            IndexError::CursorAnchorNotFound => Self::CursorAnchorNotFound,
            IndexError::CursorWorkLimit => Self::CursorWorkLimit,
            IndexError::InvalidSearchCursor => Self::InvalidSearchCursor,
            IndexError::InvalidPath(_) => Self::InvalidPath,
            IndexError::DuplicatePath(_) => Self::DuplicatePath,
            IndexError::InvalidUtf8 { .. } => Self::InvalidUtf8,
            IndexError::TooManyBaseFiles { .. } => Self::TooManyBaseFiles,
            IndexError::FileTooLarge { .. } => Self::FileTooLarge,
            IndexError::BaseContentLimit { .. } => Self::BaseContentLimit,
            IndexError::BasePathLimit { .. } => Self::BasePathLimit,
            IndexError::EmptyQuery => Self::EmptyQuery,
            IndexError::QueryTooLarge { .. } => Self::QueryTooLarge,
            IndexError::MultilineQuery => Self::MultilineQuery,
            IndexError::InvalidResultLimit { .. } => Self::InvalidResultLimit,
            IndexError::OverlayGenerationMismatch { .. } => Self::OverlayGenerationMismatch,
            // Caller-side or pack-structure failures with no dedicated port code.
            IndexError::EmptyPin
            | IndexError::PinTooLarge { .. }
            | IndexError::TooManyOverlayFiles { .. }
            | IndexError::TooManyOverlayChanges { .. }
            | IndexError::OverlayContentLimit { .. }
            | IndexError::OverlayPathNotInBase(_)
            | IndexError::DuplicateOverlayChange(_)
            | IndexError::PackTooLarge { .. }
            | IndexError::InvalidPackEncoding
            | IndexError::PackChecksumMismatch
            | IndexError::TooManyWatchChanges { .. }
            | IndexError::DuplicateWatchChange(_) => Self::Rejected,
        }
    }
}

impl From<IndexError> for WireErrorCode {
    fn from(error: IndexError) -> Self {
        Self::from(&error)
    }
}

/// A frame-level failure. No response frame exists for these; a host bridge maps
/// them to the port's `rejected` code.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TransportError {
    /// The frame (actual or declared) exceeds the kind's byte cap.
    TooLarge { limit: usize },
    /// Fewer bytes than the frame's declared length requires.
    Truncated,
    /// More bytes than the frame's declared length covers.
    TrailingBytes,
    /// Envelope magic is not the expected direction's magic.
    InvalidDirection,
    /// Envelope version is not [`TRANSPORT_VERSION`].
    UnsupportedVersion { actual: u8, expected: u8 },
    /// Envelope kind tag is not defined for this direction.
    UnknownKind { kind: u8 },
    /// A tagged body field carries an undefined tag.
    UnknownTag { field: &'static str, tag: u8 },
    /// Frame checksum does not match its content.
    ChecksumMismatch,
    /// The body layout does not match the kind's schema.
    MalformedBody,
    /// A value cannot be represented in the wire encoding.
    NotEncodable { field: &'static str },
    /// A bounded indexd value failed validation while decoding.
    Index(IndexError),
}

impl TransportError {
    /// The stable port code a host bridge must report for this failure.
    pub fn wire_code(&self) -> WireErrorCode {
        match self {
            Self::Index(error) => WireErrorCode::from(error),
            _ => WireErrorCode::Rejected,
        }
    }
}

impl fmt::Display for TransportError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TooLarge { limit } => {
                write!(formatter, "transport frame exceeds the {limit}-byte limit")
            }
            Self::Truncated => formatter.write_str("transport frame is truncated"),
            Self::TrailingBytes => formatter.write_str("transport frame has trailing bytes"),
            Self::InvalidDirection => {
                formatter.write_str("transport frame direction does not match this decoder")
            }
            Self::UnsupportedVersion { actual, expected } => write!(
                formatter,
                "transport frame version {actual} is not supported (expected {expected})"
            ),
            Self::UnknownKind { kind } => {
                write!(formatter, "transport frame kind {kind} is not defined")
            }
            Self::UnknownTag { field, tag } => {
                write!(
                    formatter,
                    "transport field {field} carries unknown tag {tag}"
                )
            }
            Self::ChecksumMismatch => {
                formatter.write_str("transport frame checksum does not match its content")
            }
            Self::MalformedBody => formatter.write_str("transport frame body is malformed"),
            Self::NotEncodable { field } => {
                write!(formatter, "transport field {field} cannot be encoded")
            }
            Self::Index(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for TransportError {}

impl From<IndexError> for TransportError {
    fn from(error: IndexError) -> Self {
        Self::Index(error)
    }
}

/// Map one RepoIntel operation to its wire tag.
pub fn operation_tag(operation: RepoIntelOperation) -> u8 {
    match operation {
        RepoIntelOperation::Text => OPERATION_TEXT,
        RepoIntelOperation::Symbol => OPERATION_SYMBOL,
        RepoIntelOperation::References => OPERATION_REFERENCES,
        RepoIntelOperation::Impact => OPERATION_IMPACT,
        RepoIntelOperation::Expand => OPERATION_EXPAND,
    }
}

/// Parse one RepoIntel operation wire tag.
pub fn operation_from_tag(tag: u8) -> Option<RepoIntelOperation> {
    match tag {
        OPERATION_TEXT => Some(RepoIntelOperation::Text),
        OPERATION_SYMBOL => Some(RepoIntelOperation::Symbol),
        OPERATION_REFERENCES => Some(RepoIntelOperation::References),
        OPERATION_IMPACT => Some(RepoIntelOperation::Impact),
        OPERATION_EXPAND => Some(RepoIntelOperation::Expand),
        _ => None,
    }
}

impl TransportRequest {
    /// The request's envelope kind byte.
    pub fn kind_tag(&self) -> u8 {
        match self {
            Self::Build { .. } => REQUEST_BUILD,
            Self::BuildOverlay { .. } => REQUEST_OVERLAY,
            Self::Query { .. } => REQUEST_QUERY,
            Self::ReleaseGeneration { .. } => REQUEST_RELEASE_GENERATION,
            Self::ReleaseOverlay { .. } => REQUEST_RELEASE_OVERLAY,
        }
    }

    /// Encode one deterministic frame: magic, version, kind, body length, body, checksum.
    pub fn encode(&self) -> Result<Vec<u8>, TransportError> {
        let kind = self.kind_tag();
        let mut body = Vec::new();
        match self {
            Self::Build { pack } => body.extend_from_slice(pack.as_bytes()),
            Self::BuildOverlay {
                generation_id,
                editor_version,
                changes,
            } => {
                body.extend_from_slice(generation_id.as_bytes());
                write_bytes(&mut body, "editor_version", editor_version.as_bytes())?;
                write_len(&mut body, "changes", changes.len())?;
                for change in changes {
                    match change {
                        OverlayChange::Replace(snapshot) => {
                            write_bytes(&mut body, "path", snapshot.path.as_bytes())?;
                            body.push(CHANGE_REPLACE);
                            write_bytes(&mut body, "contents", &snapshot.contents)?;
                        }
                        OverlayChange::Clear { path } => {
                            write_bytes(&mut body, "path", path.as_bytes())?;
                            body.push(CHANGE_CLEAR);
                        }
                    }
                }
            }
            Self::Query {
                generation_id,
                operation,
                query,
                max_results,
                overlay_digest,
                cursor,
            } => {
                body.extend_from_slice(generation_id.as_bytes());
                body.push(operation_tag(*operation));
                write_bytes(&mut body, "query", query.as_bytes())?;
                write_len(&mut body, "max_results", *max_results)?;
                write_optional_digest(&mut body, *overlay_digest);
                match cursor {
                    Some(cursor) => {
                        body.push(1);
                        write_bytes(&mut body, "cursor", cursor.as_bytes())?;
                    }
                    None => body.push(0),
                }
            }
            Self::ReleaseGeneration { generation_id } => {
                body.extend_from_slice(generation_id.as_bytes())
            }
            Self::ReleaseOverlay { overlay_digest } => {
                body.extend_from_slice(overlay_digest.as_bytes())
            }
        }
        build_frame(
            REQUEST_MAGIC,
            kind,
            Direction::Request.body_cap(kind),
            &body,
        )
    }

    /// Decode one complete request frame under the wire bounds.
    ///
    /// The checksum is verified before the body is interpreted. Declared lengths
    /// are bounded before any allocation, and the per-kind body cap is enforced
    /// both on the actual frame and on the declared body length.
    pub fn decode(bytes: &[u8]) -> Result<Self, TransportError> {
        let (kind, body) = split_frame(Direction::Request, bytes)?;
        if kind == REQUEST_BUILD {
            let pack =
                GenerationPack::from_encoded(body.to_vec()).map_err(TransportError::Index)?;
            return Ok(Self::Build { pack });
        }

        let mut reader = Reader::new(body);
        let request = match kind {
            REQUEST_OVERLAY => {
                let generation_id = reader.take_digest()?;
                let editor_version_len = reader.take_len()?;
                let editor_version = OpaquePin::new(reader.take(editor_version_len)?.to_vec())
                    .map_err(TransportError::Index)?;
                let change_count = reader.take_len()?;
                if change_count > MAX_OVERLAY_CHANGES {
                    return Err(TransportError::Index(IndexError::TooManyOverlayChanges {
                        limit: MAX_OVERLAY_CHANGES,
                    }));
                }
                let mut changes = Vec::with_capacity(change_count);
                for _ in 0..change_count {
                    let path_len = reader.take_len()?;
                    let path = std::str::from_utf8(reader.take(path_len)?)
                        .map_err(|_| TransportError::MalformedBody)?
                        .to_owned();
                    match reader.take_u8()? {
                        CHANGE_CLEAR => changes.push(OverlayChange::Clear { path }),
                        CHANGE_REPLACE => {
                            let content_len = reader.take_len()?;
                            let contents = reader.take(content_len)?.to_vec();
                            changes.push(OverlayChange::Replace(FileSnapshot::new(path, contents)));
                        }
                        tag => {
                            return Err(TransportError::UnknownTag {
                                field: "overlay_change_kind",
                                tag,
                            })
                        }
                    }
                }
                Self::BuildOverlay {
                    generation_id,
                    editor_version,
                    changes,
                }
            }
            REQUEST_QUERY => {
                let generation_id = reader.take_digest()?;
                let operation_tag = reader.take_u8()?;
                let operation =
                    operation_from_tag(operation_tag).ok_or(TransportError::UnknownTag {
                        field: "operation",
                        tag: operation_tag,
                    })?;
                let query_len = reader.take_len()?;
                let query = std::str::from_utf8(reader.take(query_len)?)
                    .map_err(|_| TransportError::MalformedBody)?
                    .to_owned();
                let max_results = reader.take_len()?;
                let overlay_digest = read_optional_digest(&mut reader)?;
                let cursor = if reader.take_presence("cursor_present")? {
                    let cursor_len = reader.take_len()?;
                    Some(
                        std::str::from_utf8(reader.take(cursor_len)?)
                            .map_err(|_| TransportError::MalformedBody)?
                            .to_owned(),
                    )
                } else {
                    None
                };
                Self::Query {
                    generation_id,
                    operation,
                    query,
                    max_results,
                    overlay_digest,
                    cursor,
                }
            }
            REQUEST_RELEASE_GENERATION => Self::ReleaseGeneration {
                generation_id: reader.take_digest()?,
            },
            REQUEST_RELEASE_OVERLAY => Self::ReleaseOverlay {
                overlay_digest: reader.take_digest()?,
            },
            other => return Err(TransportError::UnknownKind { kind: other }),
        };
        reader.finish()?;
        Ok(request)
    }
}

impl TransportResponse {
    /// The response's envelope kind byte.
    pub fn kind_tag(&self) -> u8 {
        match self {
            Self::Build { .. } => RESPONSE_BUILD,
            Self::Overlay { .. } => RESPONSE_OVERLAY,
            Self::Query(_) => RESPONSE_QUERY,
            Self::Released => RESPONSE_RELEASED,
            Self::Error { .. } => RESPONSE_ERROR,
        }
    }

    /// Build a bounded typed error response.
    pub(crate) fn error(code: WireErrorCode, detail: impl Into<String>) -> Self {
        Self::Error {
            code,
            detail: truncate_detail(detail.into()),
        }
    }

    /// Encode one deterministic response frame.
    pub fn encode(&self) -> Result<Vec<u8>, TransportError> {
        let kind = self.kind_tag();
        let body = match self {
            Self::Build { generation_id } => generation_id.as_bytes().to_vec(),
            Self::Overlay {
                base_generation_id,
                overlay_digest,
            } => {
                let mut body = Vec::with_capacity(64);
                body.extend_from_slice(base_generation_id.as_bytes());
                body.extend_from_slice(overlay_digest.as_bytes());
                body
            }
            Self::Query(query) => query.encode_body()?,
            Self::Released => Vec::new(),
            Self::Error { code, detail } => {
                let mut body = Vec::new();
                body.push(code.tag());
                let detail = detail.as_deref().unwrap_or("");
                if detail.len() > MAX_ERROR_DETAIL_BYTES {
                    return Err(TransportError::NotEncodable { field: "detail" });
                }
                write_bytes(&mut body, "detail", detail.as_bytes())?;
                body
            }
        };
        build_frame(
            RESPONSE_MAGIC,
            kind,
            Direction::Response.body_cap(kind),
            &body,
        )
    }

    /// Decode one complete response frame under the wire bounds.
    pub fn decode(bytes: &[u8]) -> Result<Self, TransportError> {
        let (kind, body) = split_frame(Direction::Response, bytes)?;
        let mut reader = Reader::new(body);
        let response = match kind {
            RESPONSE_BUILD => Self::Build {
                generation_id: reader.take_digest()?,
            },
            RESPONSE_OVERLAY => Self::Overlay {
                base_generation_id: reader.take_digest()?,
                overlay_digest: reader.take_digest()?,
            },
            RESPONSE_QUERY => Self::Query(QueryResponse::decode_body(&mut reader)?),
            RESPONSE_RELEASED => Self::Released,
            RESPONSE_ERROR => {
                let code_tag = reader.take_u8()?;
                let code = WireErrorCode::from_tag(code_tag).ok_or(TransportError::UnknownTag {
                    field: "error_code",
                    tag: code_tag,
                })?;
                let detail_len = reader.take_len()?;
                if detail_len > MAX_ERROR_DETAIL_BYTES {
                    return Err(TransportError::MalformedBody);
                }
                let detail_bytes = reader.take(detail_len)?;
                let detail = std::str::from_utf8(detail_bytes)
                    .map_err(|_| TransportError::MalformedBody)?
                    .to_owned();
                Self::Error {
                    code,
                    detail: if detail.is_empty() {
                        None
                    } else {
                        Some(detail)
                    },
                }
            }
            other => return Err(TransportError::UnknownKind { kind: other }),
        };
        reader.finish()?;
        Ok(response)
    }
}

impl QueryResponse {
    fn encode_body(&self) -> Result<Vec<u8>, TransportError> {
        let mut body = Vec::new();
        match self {
            Self::Partial {
                generation_id,
                overlay_digest,
                matches,
                next_cursor,
                work_units,
                truncated_by,
            } => {
                if matches.len() > MAX_QUERY_RESULTS {
                    return Err(TransportError::NotEncodable { field: "matches" });
                }
                body.extend_from_slice(generation_id.as_bytes());
                body.push(STATUS_PARTIAL);
                write_optional_digest(&mut body, *overlay_digest);
                write_len(&mut body, "matches", matches.len())?;
                for matched in matches {
                    write_bytes(&mut body, "path", matched.path.as_bytes())?;
                    body.extend_from_slice(&matched.start_line.to_be_bytes());
                    body.extend_from_slice(&matched.end_line.to_be_bytes());
                }
                match next_cursor {
                    Some(cursor) => {
                        if cursor.len() > MAX_SEARCH_CURSOR_BYTES {
                            return Err(TransportError::NotEncodable {
                                field: "next_cursor",
                            });
                        }
                        body.push(1);
                        write_bytes(&mut body, "next_cursor", cursor.as_bytes())?;
                    }
                    None => body.push(0),
                }
                body.extend_from_slice(&work_units.to_be_bytes());
                body.push(match truncated_by {
                    None => TRUNCATION_NONE,
                    Some(SearchTruncation::WorkLimit) => TRUNCATION_WORK_LIMIT,
                    Some(SearchTruncation::ResultLimit) => TRUNCATION_RESULT_LIMIT,
                });
            }
            Self::Unavailable {
                generation_id,
                overlay_digest,
                operation,
            } => {
                body.extend_from_slice(generation_id.as_bytes());
                body.push(STATUS_UNAVAILABLE);
                body.push(operation_tag(*operation));
                write_optional_digest(&mut body, *overlay_digest);
            }
        }
        Ok(body)
    }

    fn decode_body(reader: &mut Reader<'_>) -> Result<Self, TransportError> {
        let generation_id = reader.take_digest()?;
        let status = reader.take_u8()?;
        match status {
            STATUS_PARTIAL => {
                let overlay_digest = read_optional_digest(reader)?;
                let match_count = reader.take_len()?;
                if match_count > MAX_QUERY_RESULTS {
                    return Err(TransportError::MalformedBody);
                }
                let mut matches = Vec::with_capacity(match_count);
                for _ in 0..match_count {
                    let path_len = reader.take_len()?;
                    let path = std::str::from_utf8(reader.take(path_len)?)
                        .map_err(|_| TransportError::MalformedBody)?
                        .to_owned();
                    let start_line = reader.take_u64()?;
                    let end_line = reader.take_u64()?;
                    matches.push(SearchMatch {
                        path,
                        start_line,
                        end_line,
                    });
                }
                let next_cursor = if reader.take_presence("cursor_present")? {
                    let cursor_len = reader.take_len()?;
                    if cursor_len > MAX_SEARCH_CURSOR_BYTES {
                        return Err(TransportError::Index(IndexError::InvalidSearchCursor));
                    }
                    let token = std::str::from_utf8(reader.take(cursor_len)?)
                        .map_err(|_| TransportError::MalformedBody)?
                        .to_owned();
                    SearchCursor::parse(&token)?;
                    Some(token)
                } else {
                    None
                };
                let work_units = reader.take_u64()?;
                let truncated_by = match reader.take_u8()? {
                    TRUNCATION_NONE => None,
                    TRUNCATION_WORK_LIMIT => Some(SearchTruncation::WorkLimit),
                    TRUNCATION_RESULT_LIMIT => Some(SearchTruncation::ResultLimit),
                    tag => {
                        return Err(TransportError::UnknownTag {
                            field: "truncated_by",
                            tag,
                        })
                    }
                };
                Ok(Self::Partial {
                    generation_id,
                    overlay_digest,
                    matches,
                    next_cursor,
                    work_units,
                    truncated_by,
                })
            }
            STATUS_UNAVAILABLE => {
                let operation_tag = reader.take_u8()?;
                let operation =
                    operation_from_tag(operation_tag).ok_or(TransportError::UnknownTag {
                        field: "operation",
                        tag: operation_tag,
                    })?;
                let overlay_digest = read_optional_digest(reader)?;
                Ok(Self::Unavailable {
                    generation_id,
                    overlay_digest,
                    operation,
                })
            }
            tag => Err(TransportError::UnknownTag {
                field: "query_status",
                tag,
            }),
        }
    }
}

fn read_declared_body_len(bytes: &[u8]) -> Result<usize, TransportError> {
    let raw: [u8; 4] = bytes.try_into().map_err(|_| TransportError::Truncated)?;
    usize::try_from(u32::from_be_bytes(raw)).map_err(|_| TransportError::MalformedBody)
}

fn split_frame(direction: Direction, bytes: &[u8]) -> Result<(u8, &[u8]), TransportError> {
    if bytes.len() < TRANSPORT_HEADER_BYTES + TRANSPORT_CHECKSUM_BYTES {
        return Err(TransportError::Truncated);
    }
    if bytes.len() > MAX_TRANSPORT_FRAME_BYTES {
        return Err(TransportError::TooLarge {
            limit: MAX_TRANSPORT_FRAME_BYTES,
        });
    }
    let body_len = read_declared_body_len(&bytes[6..10])?;
    if body_len > MAX_TRANSPORT_BODY_BYTES {
        return Err(TransportError::TooLarge {
            limit: MAX_TRANSPORT_BODY_BYTES,
        });
    }
    let expected = TRANSPORT_HEADER_BYTES + body_len + TRANSPORT_CHECKSUM_BYTES;
    if bytes.len() < expected {
        return Err(TransportError::Truncated);
    }
    if bytes.len() > expected {
        return Err(TransportError::TrailingBytes);
    }

    let (signed, checksum) = bytes.split_at(expected - TRANSPORT_CHECKSUM_BYTES);
    if hash_frame(signed).as_bytes().as_slice() != checksum {
        return Err(TransportError::ChecksumMismatch);
    }
    if &signed[..4] != direction.magic() {
        return Err(TransportError::InvalidDirection);
    }
    if signed[4] != TRANSPORT_VERSION {
        return Err(TransportError::UnsupportedVersion {
            actual: signed[4],
            expected: TRANSPORT_VERSION,
        });
    }
    let kind = signed[5];
    if !direction.kind_known(kind) {
        return Err(TransportError::UnknownKind { kind });
    }
    let cap = direction.body_cap(kind);
    if body_len > cap {
        return Err(TransportError::TooLarge { limit: cap });
    }
    Ok((kind, &signed[TRANSPORT_HEADER_BYTES..]))
}

fn build_frame(
    magic: &[u8; 4],
    kind: u8,
    body_cap: usize,
    body: &[u8],
) -> Result<Vec<u8>, TransportError> {
    if body.len() > body_cap {
        return Err(TransportError::TooLarge { limit: body_cap });
    }
    let body_len =
        u32::try_from(body.len()).map_err(|_| TransportError::NotEncodable { field: "body" })?;
    let mut frame =
        Vec::with_capacity(TRANSPORT_HEADER_BYTES + body.len() + TRANSPORT_CHECKSUM_BYTES);
    frame.extend_from_slice(magic);
    frame.push(TRANSPORT_VERSION);
    frame.push(kind);
    frame.extend_from_slice(&body_len.to_be_bytes());
    frame.extend_from_slice(body);
    let checksum = hash_frame(&frame);
    frame.extend_from_slice(checksum.as_bytes());
    Ok(frame)
}

fn hash_frame(signed: &[u8]) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(FRAME_DOMAIN);
    hasher.update(signed);
    Digest::from_hasher(hasher)
}

fn write_len(
    buffer: &mut Vec<u8>,
    field: &'static str,
    value: usize,
) -> Result<(), TransportError> {
    let value = u32::try_from(value).map_err(|_| TransportError::NotEncodable { field })?;
    buffer.extend_from_slice(&value.to_be_bytes());
    Ok(())
}

fn write_bytes(
    buffer: &mut Vec<u8>,
    field: &'static str,
    bytes: &[u8],
) -> Result<(), TransportError> {
    write_len(buffer, field, bytes.len())?;
    buffer.extend_from_slice(bytes);
    Ok(())
}

fn write_optional_digest(buffer: &mut Vec<u8>, digest: Option<Digest>) {
    match digest {
        Some(digest) => {
            buffer.push(1);
            buffer.extend_from_slice(digest.as_bytes());
        }
        None => buffer.push(0),
    }
}

fn read_optional_digest(reader: &mut Reader<'_>) -> Result<Option<Digest>, TransportError> {
    if reader.take_presence("overlay_present")? {
        Ok(Some(reader.take_digest()?))
    } else {
        Ok(None)
    }
}

fn truncate_detail(mut detail: String) -> Option<String> {
    if detail.is_empty() {
        return None;
    }
    if detail.len() > MAX_ERROR_DETAIL_BYTES {
        let mut end = MAX_ERROR_DETAIL_BYTES;
        while !detail.is_char_boundary(end) {
            end -= 1;
        }
        detail.truncate(end);
    }
    Some(detail)
}

/// Decode one indexd-side response for `error` with a bounded detail string.
pub(crate) fn response_from_index_error(error: &IndexError) -> TransportResponse {
    TransportResponse::error(WireErrorCode::from(error), error.to_string())
}

struct Reader<'a> {
    bytes: &'a [u8],
    position: usize,
}

impl<'a> Reader<'a> {
    fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, position: 0 }
    }

    fn remaining(&self) -> usize {
        self.bytes.len() - self.position
    }

    fn finish(&self) -> Result<(), TransportError> {
        if self.remaining() == 0 {
            Ok(())
        } else {
            Err(TransportError::MalformedBody)
        }
    }

    fn take(&mut self, length: usize) -> Result<&'a [u8], TransportError> {
        let end = self
            .position
            .checked_add(length)
            .ok_or(TransportError::MalformedBody)?;
        if end > self.bytes.len() {
            return Err(TransportError::MalformedBody);
        }
        let slice = &self.bytes[self.position..end];
        self.position = end;
        Ok(slice)
    }

    fn take_u8(&mut self) -> Result<u8, TransportError> {
        Ok(self.take(1)?[0])
    }

    fn take_len(&mut self) -> Result<usize, TransportError> {
        let raw: [u8; 4] = self
            .take(4)?
            .try_into()
            .map_err(|_| TransportError::MalformedBody)?;
        usize::try_from(u32::from_be_bytes(raw)).map_err(|_| TransportError::MalformedBody)
    }

    fn take_u64(&mut self) -> Result<u64, TransportError> {
        let raw: [u8; 8] = self
            .take(8)?
            .try_into()
            .map_err(|_| TransportError::MalformedBody)?;
        Ok(u64::from_be_bytes(raw))
    }

    fn take_presence(&mut self, field: &'static str) -> Result<bool, TransportError> {
        match self.take_u8()? {
            0 => Ok(false),
            1 => Ok(true),
            tag => Err(TransportError::UnknownTag { field, tag }),
        }
    }

    fn take_digest(&mut self) -> Result<Digest, TransportError> {
        let raw: [u8; 32] = self
            .take(32)?
            .try_into()
            .map_err(|_| TransportError::MalformedBody)?;
        Ok(Digest(raw))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{BaseGeneration, GenerationPins};

    fn pin(value: &str) -> OpaquePin {
        OpaquePin::new(value.as_bytes().to_vec()).expect("valid pin")
    }

    fn pins() -> GenerationPins {
        GenerationPins {
            repository: pin("repo-1"),
            workspace: None,
            revision_set: pin("rev-1"),
            read_scope: pin("scope-1"),
            read_policy: pin("policy-1"),
            source_receipt: pin("receipt-1"),
            parser_set: pin("parser-1"),
        }
    }

    fn pack(files: Vec<(&str, &str)>) -> GenerationPack {
        let generation = BaseGeneration::build(
            pins(),
            files
                .into_iter()
                .map(|(path, contents)| FileSnapshot::new(path, contents.as_bytes().to_vec()))
                .collect::<Vec<_>>(),
        )
        .expect("generation");
        GenerationPack::from_generation(&generation).expect("pack")
    }

    fn digest(byte: u8) -> Digest {
        Digest([byte; 32])
    }

    fn query_request() -> TransportRequest {
        TransportRequest::Query {
            generation_id: digest(1),
            operation: RepoIntelOperation::Symbol,
            query: "needle".to_owned(),
            max_results: 10,
            overlay_digest: Some(digest(2)),
            cursor: Some("v1:not-a-real-cursor".to_owned()),
        }
    }

    fn overlay_request() -> TransportRequest {
        TransportRequest::BuildOverlay {
            generation_id: digest(3),
            editor_version: pin("editor-7"),
            changes: vec![
                OverlayChange::Replace(FileSnapshot::new("src/a.rs", b"edited\n".to_vec())),
                OverlayChange::Clear {
                    path: "src/b.rs".to_owned(),
                },
            ],
        }
    }

    fn partial_response() -> TransportResponse {
        TransportResponse::Query(QueryResponse::Partial {
            generation_id: digest(4),
            overlay_digest: Some(digest(5)),
            matches: vec![SearchMatch {
                path: "src/lib.rs".to_owned(),
                start_line: 3,
                end_line: 3,
            }],
            next_cursor: None,
            work_units: 42,
            truncated_by: Some(SearchTruncation::ResultLimit),
        })
    }

    /// Rebuild a frame with a recomputed checksum after mutating its signed bytes.
    fn reframe(frame: &[u8], mutate: impl FnOnce(&mut Vec<u8>)) -> Vec<u8> {
        let signed_len = frame.len() - TRANSPORT_CHECKSUM_BYTES;
        let mut rebuilt = frame[..signed_len].to_vec();
        mutate(&mut rebuilt);
        let checksum = hash_frame(&rebuilt);
        rebuilt.extend_from_slice(checksum.as_bytes());
        rebuilt
    }

    /// Hand-build a frame that declares a body length independent of its payload.
    fn raw_frame(magic: &[u8; 4], kind: u8, declared_body_len: usize, payload: &[u8]) -> Vec<u8> {
        let mut frame = Vec::new();
        frame.extend_from_slice(magic);
        frame.push(TRANSPORT_VERSION);
        frame.push(kind);
        frame.extend_from_slice(
            &u32::try_from(declared_body_len)
                .expect("declared length fits u32")
                .to_be_bytes(),
        );
        frame.extend_from_slice(payload);
        let checksum = hash_frame(&frame);
        frame.extend_from_slice(checksum.as_bytes());
        frame
    }

    #[test]
    fn every_request_kind_round_trips() {
        let requests = vec![
            TransportRequest::Build {
                pack: pack(vec![("a.txt", "alpha\n")]),
            },
            overlay_request(),
            query_request(),
            TransportRequest::ReleaseGeneration {
                generation_id: digest(6),
            },
            TransportRequest::ReleaseOverlay {
                overlay_digest: digest(7),
            },
        ];
        for request in requests {
            let frame = request.encode().expect("encode");
            assert_eq!(TransportRequest::decode(&frame).expect("decode"), request);
            assert_eq!(
                peek_request_frame(&frame).expect("peek").kind,
                request.kind_tag()
            );
        }
    }

    #[test]
    fn every_response_kind_round_trips() {
        let responses = vec![
            TransportResponse::Build {
                generation_id: digest(8),
            },
            TransportResponse::Overlay {
                base_generation_id: digest(9),
                overlay_digest: digest(10),
            },
            TransportResponse::Query(QueryResponse::Unavailable {
                generation_id: digest(11),
                overlay_digest: None,
                operation: RepoIntelOperation::References,
            }),
            partial_response(),
            TransportResponse::Released,
            TransportResponse::Error {
                code: WireErrorCode::CursorOverlayMismatch,
                detail: Some("bound to another overlay".to_owned()),
            },
            TransportResponse::Error {
                code: WireErrorCode::Rejected,
                detail: None,
            },
        ];
        for response in responses {
            let frame = response.encode().expect("encode");
            assert_eq!(TransportResponse::decode(&frame).expect("decode"), response);
            assert_eq!(
                peek_response_frame(&frame).expect("peek").kind,
                response.kind_tag()
            );
        }
    }

    #[test]
    fn encoding_is_deterministic_and_frames_are_not_interchangeable() {
        let request = query_request();
        let first = request.encode().expect("encode");
        let second = request.encode().expect("encode");
        assert_eq!(first, second);
        assert_eq!(&first[..4], REQUEST_MAGIC);
        assert!(matches!(
            TransportResponse::decode(&first),
            Err(TransportError::InvalidDirection)
        ));
        let response = partial_response().encode().expect("encode");
        assert!(matches!(
            TransportRequest::decode(&response),
            Err(TransportError::InvalidDirection)
        ));
    }

    #[test]
    fn any_single_byte_flip_is_rejected() {
        let frame = query_request().encode().expect("encode");
        for position in 0..frame.len() {
            let mut tampered = frame.clone();
            tampered[position] ^= 0x20;
            assert!(
                TransportRequest::decode(&tampered).is_err(),
                "flip at byte {position} must be rejected"
            );
        }
    }

    #[test]
    fn truncation_at_every_boundary_is_rejected() {
        let frame = overlay_request().encode().expect("encode");
        for length in 0..frame.len() {
            assert!(
                TransportRequest::decode(&frame[..length]).is_err(),
                "truncation to {length} bytes must be rejected"
            );
        }
        assert!(matches!(
            TransportRequest::decode(&frame[..frame.len() - 1]),
            Err(TransportError::Truncated)
        ));
    }

    #[test]
    fn trailing_bytes_are_rejected() {
        let mut frame = TransportRequest::ReleaseOverlay {
            overlay_digest: digest(12),
        }
        .encode()
        .expect("encode");
        frame.push(0);
        assert!(matches!(
            TransportRequest::decode(&frame),
            Err(TransportError::TrailingBytes)
        ));
    }

    #[test]
    fn wrong_version_is_rejected_with_a_valid_checksum() {
        let frame = query_request().encode().expect("encode");
        let mutated = reframe(&frame, |signed| signed[4] = TRANSPORT_VERSION + 1);
        assert!(matches!(
            TransportRequest::decode(&mutated),
            Err(TransportError::UnsupportedVersion {
                actual: 2,
                expected: 1
            })
        ));
        assert!(matches!(
            peek_request_frame(&mutated),
            Err(TransportError::UnsupportedVersion { .. })
        ));
    }

    #[test]
    fn wrong_magic_and_unknown_kind_are_rejected_with_a_valid_checksum() {
        let frame = query_request().encode().expect("encode");
        let wrong_magic = reframe(&frame, |signed| signed[0] = b'X');
        assert!(matches!(
            TransportRequest::decode(&wrong_magic),
            Err(TransportError::InvalidDirection)
        ));
        let unknown_kind = reframe(&frame, |signed| signed[5] = 9);
        assert!(matches!(
            TransportRequest::decode(&unknown_kind),
            Err(TransportError::UnknownKind { kind: 9 })
        ));
    }

    #[test]
    fn unknown_tags_are_rejected_with_a_valid_checksum() {
        let frame = query_request().encode().expect("encode");
        let unknown_operation = reframe(&frame, |signed| {
            signed[TRANSPORT_HEADER_BYTES + 32] = 9;
        });
        assert!(matches!(
            TransportRequest::decode(&unknown_operation),
            Err(TransportError::UnknownTag {
                field: "operation",
                tag: 9
            })
        ));

        let overlay = overlay_request().encode().expect("encode");
        let unknown_status = reframe(&partial_response().encode().expect("encode"), |signed| {
            signed[TRANSPORT_HEADER_BYTES + 32] = 9;
        });
        assert!(matches!(
            TransportResponse::decode(&unknown_status),
            Err(TransportError::UnknownTag {
                field: "query_status",
                tag: 9
            })
        ));
        // A request frame is never a response frame even with a valid checksum.
        assert!(TransportResponse::decode(&overlay).is_err());
    }

    #[test]
    fn oversized_declared_body_is_rejected_before_any_allocation() {
        let oversized = raw_frame(
            REQUEST_MAGIC,
            REQUEST_BUILD,
            MAX_TRANSPORT_BODY_BYTES + 1,
            &[],
        );
        assert!(matches!(
            TransportRequest::decode(&oversized),
            Err(TransportError::TooLarge {
                limit: MAX_TRANSPORT_BODY_BYTES
            })
        ));
        assert!(matches!(
            peek_request_frame(&oversized),
            Err(TransportError::TooLarge { .. })
        ));
    }

    #[test]
    fn per_kind_body_cap_is_enforced_on_the_declared_length() {
        // A peek trusts only the declared length, so an over-cap declaration is
        // rejected before the body (or checksum) is available.
        let declared = raw_frame(REQUEST_MAGIC, REQUEST_QUERY, MAX_QUERY_BODY_BYTES + 1, &[]);
        assert!(matches!(
            peek_request_frame(&declared),
            Err(TransportError::TooLarge {
                limit: MAX_QUERY_BODY_BYTES
            })
        ));
        // A complete frame must match its declaration, so the same declaration
        // with a short body fails the completeness check instead.
        assert!(matches!(
            TransportRequest::decode(&declared),
            Err(TransportError::Truncated)
        ));
        // With a complete body, the per-kind cap is the failing bound.
        let oversized_body = vec![0u8; MAX_QUERY_BODY_BYTES + 1];
        let oversized = raw_frame(
            REQUEST_MAGIC,
            REQUEST_QUERY,
            MAX_QUERY_BODY_BYTES + 1,
            &oversized_body,
        );
        assert!(matches!(
            TransportRequest::decode(&oversized),
            Err(TransportError::TooLarge {
                limit: MAX_QUERY_BODY_BYTES
            })
        ));

        let oversized_response_body = vec![0u8; MAX_ERROR_DETAIL_BYTES + 8];
        let oversized_response = raw_frame(
            RESPONSE_MAGIC,
            RESPONSE_ERROR,
            MAX_ERROR_DETAIL_BYTES + 8,
            &oversized_response_body,
        );
        assert!(matches!(
            TransportResponse::decode(&oversized_response),
            Err(TransportError::TooLarge { .. })
        ));
    }

    #[test]
    fn structurally_invalid_bodies_are_rejected() {
        // A query body that ends before its first field.
        let truncated_body = raw_frame(REQUEST_MAGIC, REQUEST_QUERY, 4, &[0; 4]);
        assert!(matches!(
            TransportRequest::decode(&truncated_body),
            Err(TransportError::MalformedBody)
        ));
        // An error response body with trailing bytes inside the declared body.
        let trailing_body = raw_frame(RESPONSE_MAGIC, RESPONSE_ERROR, 6, &[1, 0, 0, 0, 0, 0]);
        assert!(matches!(
            TransportResponse::decode(&trailing_body),
            Err(TransportError::MalformedBody)
        ));
        // A response build body that is not exactly one digest.
        let short_build = raw_frame(RESPONSE_MAGIC, RESPONSE_BUILD, 16, &[0; 16]);
        assert!(matches!(
            TransportResponse::decode(&short_build),
            Err(TransportError::MalformedBody)
        ));
    }

    #[test]
    fn too_many_overlay_changes_are_rejected_before_allocation() {
        let mut body = Vec::new();
        body.extend_from_slice(digest(13).as_bytes());
        write_bytes(&mut body, "editor_version", b"editor-1").expect("write");
        write_len(&mut body, "changes", MAX_OVERLAY_CHANGES + 1).expect("write");
        let frame = raw_frame(REQUEST_MAGIC, REQUEST_OVERLAY, body.len(), &body);
        assert!(matches!(
            TransportRequest::decode(&frame),
            Err(TransportError::Index(IndexError::TooManyOverlayChanges {
                limit: MAX_OVERLAY_CHANGES
            }))
        ));
    }

    #[test]
    fn oversized_response_match_count_is_rejected() {
        let mut body = Vec::new();
        body.extend_from_slice(digest(14).as_bytes());
        body.push(STATUS_PARTIAL);
        body.push(0);
        write_len(&mut body, "matches", MAX_QUERY_RESULTS + 1).expect("write");
        let frame = raw_frame(RESPONSE_MAGIC, RESPONSE_QUERY, body.len(), &body);
        assert!(matches!(
            TransportResponse::decode(&frame),
            Err(TransportError::MalformedBody)
        ));
    }

    #[test]
    fn encoder_refuses_unrepresentable_values() {
        if usize::BITS > u32::BITS {
            let request = TransportRequest::Query {
                generation_id: digest(15),
                operation: RepoIntelOperation::Text,
                query: "needle".to_owned(),
                max_results: usize::MAX,
                overlay_digest: None,
                cursor: None,
            };
            assert!(matches!(
                request.encode(),
                Err(TransportError::NotEncodable {
                    field: "max_results"
                })
            ));
        }

        let response = TransportResponse::Error {
            code: WireErrorCode::Rejected,
            detail: Some("x".repeat(MAX_ERROR_DETAIL_BYTES + 1)),
        };
        assert!(matches!(
            response.encode(),
            Err(TransportError::NotEncodable { field: "detail" })
        ));
    }

    #[test]
    fn error_details_are_truncated_on_a_character_boundary() {
        let response = TransportResponse::error(WireErrorCode::Rejected, "é".repeat(1_000));
        let frame = response.encode().expect("encode");
        let decoded = TransportResponse::decode(&frame).expect("decode");
        let TransportResponse::Error { detail, .. } = decoded else {
            panic!("expected an error response");
        };
        let detail = detail.expect("detail");
        assert!(detail.len() <= MAX_ERROR_DETAIL_BYTES);
        assert!(detail.chars().all(|character| character == 'é'));
    }

    #[test]
    fn wire_error_codes_are_stable_and_complete() {
        assert_eq!(WireErrorCode::ALL.len(), 21);
        for (index, code) in WireErrorCode::ALL.into_iter().enumerate() {
            assert_eq!(usize::from(code.tag()), index, "{code}");
            assert_eq!(WireErrorCode::from_tag(code.tag()), Some(code));
            assert_eq!(WireErrorCode::parse(code.as_str()), Some(code));
            assert!(
                code.as_str()
                    .bytes()
                    .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'_'),
                "{code}"
            );
        }
        assert_eq!(WireErrorCode::from_tag(21), None);
        assert_eq!(WireErrorCode::parse("not_a_code"), None);
    }

    #[test]
    fn index_errors_map_to_their_port_codes() {
        assert_eq!(
            WireErrorCode::from(&IndexError::GenerationMismatch {
                expected: digest(1),
                actual: digest(2)
            }),
            WireErrorCode::GenerationMismatch
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::CursorGenerationMismatch),
            WireErrorCode::CursorGenerationMismatch
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::CursorQueryMismatch),
            WireErrorCode::CursorQueryMismatch
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::CursorOverlayMismatch),
            WireErrorCode::CursorOverlayMismatch
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::InvalidSearchCursor),
            WireErrorCode::InvalidSearchCursor
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::InvalidPath("a".to_owned())),
            WireErrorCode::InvalidPath
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::DuplicatePath("a".to_owned())),
            WireErrorCode::DuplicatePath
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::EmptyQuery),
            WireErrorCode::EmptyQuery
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::QueryTooLarge { limit: 1 }),
            WireErrorCode::QueryTooLarge
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::MultilineQuery),
            WireErrorCode::MultilineQuery
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::InvalidResultLimit { limit: 1 }),
            WireErrorCode::InvalidResultLimit
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::PackChecksumMismatch),
            WireErrorCode::Rejected
        );
        assert_eq!(
            WireErrorCode::from(&IndexError::TooManyWatchChanges { limit: 1 }),
            WireErrorCode::Rejected
        );
        assert_eq!(
            TransportError::ChecksumMismatch.wire_code(),
            WireErrorCode::Rejected
        );
        assert_eq!(
            TransportError::Index(IndexError::CursorQueryMismatch).wire_code(),
            WireErrorCode::CursorQueryMismatch
        );
        assert_eq!(
            TransportError::Truncated.wire_code(),
            WireErrorCode::Rejected
        );
    }

    #[test]
    fn body_caps_cover_the_maximum_valid_payloads() {
        const {
            assert!(MAX_OVERLAY_BODY_BYTES >= MAX_OVERLAY_CONTENT_BYTES);
            assert!(MAX_QUERY_BODY_BYTES > MAX_QUERY_BYTES + MAX_SEARCH_CURSOR_BYTES);
            assert!(MAX_QUERY_RESPONSE_BODY_BYTES >= MAX_QUERY_RESULTS * MAX_PATH_BYTES);
            assert!(
                MAX_TRANSPORT_FRAME_BYTES
                    == TRANSPORT_HEADER_BYTES + MAX_BUILD_BODY_BYTES + TRANSPORT_CHECKSUM_BYTES
            );
            assert!(MAX_BUILD_BODY_BYTES == DEFAULT_MAX_PACK_BYTES);
        }
        // Exact wire limits pinned so documentation and code cannot drift.
        assert_eq!(MAX_BUILD_BODY_BYTES, 72_351_744);
        assert_eq!(MAX_OVERLAY_BODY_BYTES, 8_524_968);
        assert_eq!(MAX_QUERY_BODY_BYTES, 2_735);
        assert_eq!(MAX_RELEASE_BODY_BYTES, 32);
        assert_eq!(MAX_QUERY_RESPONSE_BODY_BYTES, 106_884);
        assert_eq!(MAX_ERROR_DETAIL_BYTES, 1_024);
        assert_eq!(MAX_TRANSPORT_FRAME_BYTES, 72_351_786);
        // A maximum-size frame of every kind encodes within the envelope cap.
        let query = TransportRequest::Query {
            generation_id: digest(16),
            operation: RepoIntelOperation::Text,
            query: "q".repeat(MAX_QUERY_BYTES),
            max_results: MAX_QUERY_RESULTS,
            overlay_digest: Some(digest(17)),
            cursor: None,
        };
        let frame = query.encode().expect("encode");
        assert!(frame.len() <= MAX_TRANSPORT_FRAME_BYTES);
        assert_eq!(TransportRequest::decode(&frame).expect("decode"), query);
    }
}
