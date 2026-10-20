//! Host-facing, generation-bound structure query/page contract.
//!
//! This adapter currently reports structural operations as explicitly unavailable:
//! the library has a lexical index but no parser or symbol graph. It never turns
//! lexical occurrences into AST symbols or write authority. The HostKernel supplies
//! the response provenance only after it has authenticated the out-of-band
//! Session/Location context and verified the live read grant.

use crate::{BufferOverlay, Digest, RepoIntelGeneration};
use std::fmt;

pub const MAX_STRUCTURE_NODES: usize = 100;
pub const MAX_STRUCTURE_BYTES: usize = 262_144;
pub const MAX_STRUCTURE_DEPTH: usize = 16;
pub const MAX_STRUCTURE_CURSOR_BYTES: usize = 4_096;
pub const MAX_STRUCTURE_IDENTIFIER_BYTES: usize = 200;
pub const MAX_STRUCTURE_SYMBOL_BYTES: usize = 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoNodeRefV1 {
    pub workspace_binding: String,
    pub source_generation: String,
    pub source_revision: String,
    pub overlay_digest: Option<String>,
    pub path_ref: String,
    pub file_digest: String,
    pub node_id: String,
    pub node_kind: String,
    pub symbol: String,
    pub byte_range: StructureByteRangeV1,
    pub parser_id: String,
    pub parser_version: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct StructureByteRangeV1 {
    pub start: u64,
    pub end: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RepoStructureSelectorV1 {
    pub symbols: Vec<String>,
    pub node_refs: Vec<RepoNodeRefV1>,
    pub include_callers: bool,
}

/// Caller body only. Principal, Session, Location, root authority, policy and
/// permission are deliberately absent and must come from the authenticated host
/// envelope and Guard-owned `RepoReadGrantV1`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoStructureQueryV1 {
    pub schema_version: u8,
    pub message_type: String,
    pub query_id: String,
    pub root_ref: String,
    pub source_generation: String,
    /// Host-minted ID only. HostKernel resolves it to an owner-bound lease and
    /// passes the immutable snapshot separately; this string is never authority.
    pub overlay_ref: Option<String>,
    pub selector: RepoStructureSelectorV1,
    pub cursor: Option<String>,
    pub max_nodes: usize,
    pub max_bytes: usize,
    pub max_depth: usize,
    pub deadline: String,
}

/// Provenance that only HostKernel can construct after validating its registered
/// Location and host-measured revision. This is descriptive output metadata; it
/// carries no filesystem access or authorization.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoStructureProvenanceV1 {
    pub workspace_binding: String,
    pub source_revision: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStructureSourceKindV1 {
    SymbolIndex,
    Parser,
    Lexical,
    Lsp,
    None,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStructureStatusV1 {
    Current,
    Stale,
    Partial,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStructureFreshnessV1 {
    Current,
    Stale,
    Unknown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStructureCompletenessV1 {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoStructureCoverageV1 {
    pub files: usize,
    pub nodes: usize,
    pub bytes: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoStructureFallbackReasonV1 {
    ParserUnsupported,
    ParsePartial,
    LspUnavailable,
    ResourceRefused,
    GenerationStale,
    OverlayUnavailable,
    IndexCorrupt,
    ScopeMismatch,
    DeadlineExceeded,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RepoStructureFallbackV1 {
    pub reason: RepoStructureFallbackReasonV1,
    pub source_kind: RepoStructureSourceKindV1,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoStructurePageV1 {
    pub schema_version: u8,
    pub message_type: String,
    pub query_id: String,
    pub workspace_binding: String,
    pub source_generation: String,
    pub source_revision: String,
    pub overlay_digest: Option<String>,
    pub source_kind: RepoStructureSourceKindV1,
    pub parser_id: Option<String>,
    pub parser_version: Option<String>,
    pub status: RepoStructureStatusV1,
    pub freshness: RepoStructureFreshnessV1,
    pub completeness: RepoStructureCompletenessV1,
    pub coverage: RepoStructureCoverageV1,
    pub nodes: Vec<RepoNodeRefV1>,
    pub fallback: Option<RepoStructureFallbackV1>,
    /// Reserved for HostKernel-minted opaque continuation leases. The indexd
    /// structural adapter does not mint or expose caller-reusable cursors.
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RepoStructureError {
    InvalidQuery(&'static str),
    InvalidProvenance(&'static str),
    GenerationMismatch { expected: String, actual: String },
    OverlayMismatch,
}

impl fmt::Display for RepoStructureError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidQuery(detail) => {
                write!(formatter, "invalid RepoIntel structure query: {detail}")
            }
            Self::InvalidProvenance(detail) => {
                write!(formatter, "invalid RepoIntel provenance: {detail}")
            }
            Self::GenerationMismatch { expected, actual } => {
                write!(
                    formatter,
                    "RepoIntel generation mismatch: expected {expected}, current {actual}"
                )
            }
            Self::OverlayMismatch => formatter.write_str(
                "RepoIntel overlay reference does not match a live overlay bound to this generation",
            ),
        }
    }
}

impl std::error::Error for RepoStructureError {}

impl RepoIntelGeneration {
    /// Validate the wire query and return honest typed unavailability until a
    /// structural parser/index is integrated. Guard and host freshness checks
    /// happen before this method; expected-generation mismatch is checked again
    /// here to fence stale callers.
    pub fn query_structure(
        &self,
        query: &RepoStructureQueryV1,
        provenance: &RepoStructureProvenanceV1,
        overlay: Option<&BufferOverlay>,
    ) -> Result<RepoStructurePageV1, RepoStructureError> {
        validate_query(query)?;
        validate_provenance(provenance)?;
        let actual_generation = self.id().to_string();
        if query.source_generation != actual_generation {
            return Err(RepoStructureError::GenerationMismatch {
                expected: query.source_generation.clone(),
                actual: actual_generation,
            });
        }
        match (&query.overlay_ref, overlay) {
            (None, None) => {}
            (Some(_), Some(overlay))
                if overlay.base_generation_digest().to_string() == actual_generation => {}
            _ => return Err(RepoStructureError::OverlayMismatch),
        }
        validate_node_refs(self, query, provenance, overlay)?;

        Ok(RepoStructurePageV1 {
            schema_version: 1,
            message_type: "page".to_owned(),
            query_id: query.query_id.clone(),
            workspace_binding: provenance.workspace_binding.clone(),
            source_generation: query.source_generation.clone(),
            source_revision: provenance.source_revision.clone(),
            overlay_digest: overlay.map(|overlay| overlay.digest().to_string()),
            source_kind: RepoStructureSourceKindV1::None,
            parser_id: None,
            parser_version: None,
            status: RepoStructureStatusV1::Unavailable,
            freshness: RepoStructureFreshnessV1::Unknown,
            completeness: RepoStructureCompletenessV1::Unavailable,
            coverage: RepoStructureCoverageV1 {
                files: 0,
                nodes: 0,
                bytes: 0,
            },
            nodes: Vec::new(),
            fallback: Some(RepoStructureFallbackV1 {
                reason: RepoStructureFallbackReasonV1::ParserUnsupported,
                source_kind: RepoStructureSourceKindV1::None,
            }),
            next_cursor: None,
        })
    }
}

fn validate_query(query: &RepoStructureQueryV1) -> Result<(), RepoStructureError> {
    if query.schema_version != 1 || query.message_type != "query" {
        return Err(RepoStructureError::InvalidQuery(
            "unsupported schema or message type",
        ));
    }
    if query.query_id.is_empty() || query.query_id.len() > MAX_STRUCTURE_IDENTIFIER_BYTES {
        return Err(RepoStructureError::InvalidQuery(
            "queryId is empty or over the byte limit",
        ));
    }
    if query.root_ref != "." {
        crate::validate_path(&query.root_ref).map_err(|_| {
            RepoStructureError::InvalidQuery("rootRef must be a normalized relative path")
        })?;
    }
    if Digest::parse(&query.source_generation).is_none() {
        return Err(RepoStructureError::InvalidQuery(
            "sourceGeneration is not a canonical digest",
        ));
    }
    if query.overlay_ref.as_ref().is_some_and(|reference| {
        !(reference.starts_with("ovl_")
            && (20..=132).contains(&reference.len())
            && reference[4..].bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-'
            }))
    }) {
        return Err(RepoStructureError::InvalidQuery(
            "overlayRef is not a bounded host-issued opaque reference",
        ));
    }
    let selector = &query.selector;
    if selector.symbols.is_empty() && selector.node_refs.is_empty() && !selector.include_callers {
        return Err(RepoStructureError::InvalidQuery(
            "selector must not be empty",
        ));
    }
    if selector
        .symbols
        .len()
        .saturating_add(selector.node_refs.len())
        > MAX_STRUCTURE_NODES
        || selector.symbols.iter().any(|symbol| {
            symbol.is_empty()
                || symbol.len() > MAX_STRUCTURE_SYMBOL_BYTES
                || symbol.contains(['\n', '\r'])
        })
    {
        return Err(RepoStructureError::InvalidQuery(
            "selector exceeds its count or symbol bounds",
        ));
    }
    if query.max_nodes == 0 || query.max_nodes > MAX_STRUCTURE_NODES {
        return Err(RepoStructureError::InvalidQuery(
            "maxNodes is outside 1..=100",
        ));
    }
    if query.max_bytes == 0 || query.max_bytes > MAX_STRUCTURE_BYTES {
        return Err(RepoStructureError::InvalidQuery(
            "maxBytes is outside 1..=262144",
        ));
    }
    if query.max_depth == 0 || query.max_depth > MAX_STRUCTURE_DEPTH {
        return Err(RepoStructureError::InvalidQuery(
            "maxDepth is outside 1..=16",
        ));
    }
    if query
        .cursor
        .as_ref()
        .is_some_and(|cursor| cursor.is_empty() || cursor.len() > MAX_STRUCTURE_CURSOR_BYTES)
    {
        return Err(RepoStructureError::InvalidQuery(
            "cursor is empty or over the byte limit",
        ));
    }
    if query.deadline.is_empty() || query.deadline.len() > 64 {
        return Err(RepoStructureError::InvalidQuery(
            "deadline is empty or over the byte limit",
        ));
    }
    Ok(())
}

fn validate_node_refs(
    generation: &RepoIntelGeneration,
    query: &RepoStructureQueryV1,
    provenance: &RepoStructureProvenanceV1,
    overlay: Option<&BufferOverlay>,
) -> Result<(), RepoStructureError> {
    let expected_overlay_digest = overlay.map(|overlay| overlay.digest().to_string());
    for node in &query.selector.node_refs {
        if node.workspace_binding != provenance.workspace_binding
            || node.source_generation != query.source_generation
            || node.source_revision != provenance.source_revision
            || node.overlay_digest.as_deref() != expected_overlay_digest.as_deref()
        {
            return Err(RepoStructureError::InvalidQuery(
                "node reference belongs to another workspace or generation",
            ));
        }
        if crate::validate_path(&node.path_ref).is_err()
            || (query.root_ref != "."
                && node.path_ref != query.root_ref
                && !node
                    .path_ref
                    .strip_prefix(&query.root_ref)
                    .is_some_and(|tail| tail.starts_with('/')))
        {
            return Err(RepoStructureError::InvalidQuery(
                "node reference path is invalid or outside rootRef",
            ));
        }
        let observed = match overlay {
            Some(overlay) => overlay.file_observation(generation.base(), &node.path_ref),
            None => generation.base().file_observation(&node.path_ref),
        };
        let Some((expected_file_digest, file_bytes)) = observed
        else {
            return Err(RepoStructureError::InvalidQuery(
                "node reference path is absent from the pinned generation",
            ));
        };
        if Digest::parse(&node.file_digest) != Some(expected_file_digest)
            || node.node_id.is_empty()
            || node.node_id.len() > MAX_STRUCTURE_IDENTIFIER_BYTES
            || node.node_kind.is_empty()
            || node.node_kind.len() > MAX_STRUCTURE_IDENTIFIER_BYTES
            || node.symbol.len() > MAX_STRUCTURE_SYMBOL_BYTES
            || node.byte_range.start >= node.byte_range.end
            || node.byte_range.end > file_bytes as u64
            || node.parser_id.is_empty()
            || node.parser_id.len() > MAX_STRUCTURE_IDENTIFIER_BYTES
            || node.parser_version.is_empty()
            || node.parser_version.len() > MAX_STRUCTURE_IDENTIFIER_BYTES
        {
            return Err(RepoStructureError::InvalidQuery(
                "node reference metadata or byte range is invalid",
            ));
        }
    }
    Ok(())
}

fn validate_provenance(provenance: &RepoStructureProvenanceV1) -> Result<(), RepoStructureError> {
    if provenance.workspace_binding.is_empty()
        || provenance.workspace_binding.len() > MAX_STRUCTURE_IDENTIFIER_BYTES
    {
        return Err(RepoStructureError::InvalidProvenance(
            "workspaceBinding is empty or over the byte limit",
        ));
    }
    if Digest::parse(&provenance.source_revision).is_none() {
        return Err(RepoStructureError::InvalidProvenance(
            "sourceRevision is not a canonical digest",
        ));
    }
    Ok(())
}
