//! Host-facing, generation-bound structure query/page contract.
//!
//! This adapter reports bounded exact-text lexical candidates until a structural
//! parser or symbol graph is available. It never labels lexical occurrences as AST
//! symbols or grants write authority. The HostKernel supplies
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
/// Upper bound on repeated lexical scan work. `max_bytes` bounds unique source
/// coverage, while this bound accounts for scanning the same source once per
/// selector. Keeping both limits prevents a small input body with many selectors
/// from multiplying CPU work without changing the reported source-byte coverage.
pub const MAX_STRUCTURE_WORK_UNITS: usize = 4_194_304;

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

/// Internal continuation position in immutable generation order. This is not a
/// token or authority; only HostKernel may retain it behind an authenticated
/// opaque cursor lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoStructurePositionV1 {
    /// Canonical path in `BaseGeneration::file_entries()` BTreeMap order.
    pub path_ref: String,
    /// Index in `selector.symbols`, preserving selector order.
    pub symbol_index: usize,
    /// UTF-8 byte offset of the last emitted match (exclusive on continuation).
    pub byte_offset: u64,
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
    /// Internal position for HostKernel to bind into its opaque cursor lease.
    /// Never serialize this as a public cursor or accept it from a caller.
    pub next_position: Option<RepoStructurePositionV1>,
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
    /// Validate the wire query and return bounded lexical candidates from the
    /// immutable generation. Guard and host freshness checks happen before this
    /// method; expected-generation mismatch is checked again to fence stale callers.
    pub fn query_structure(
        &self,
        query: &RepoStructureQueryV1,
        provenance: &RepoStructureProvenanceV1,
        overlay: Option<&BufferOverlay>,
    ) -> Result<RepoStructurePageV1, RepoStructureError> {
        self.query_structure_page(query, provenance, overlay, None)
    }

    /// Query one deterministic bounded page. `resume_after` is a HostKernel-
    /// resolved exclusive occurrence position; indexd never mints cursor tokens.
    /// Paths follow immutable BTreeMap order and symbols follow selector order.
    /// `next_position` is set only after observing a matching node beyond this page.
    pub fn query_structure_page(
        &self,
        query: &RepoStructureQueryV1,
        provenance: &RepoStructureProvenanceV1,
        overlay: Option<&BufferOverlay>,
        resume_after: Option<&RepoStructurePositionV1>,
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

        let base = self.base();
        validate_resume_position(base, query, resume_after)?;
        let mut nodes = Vec::new();
        let mut files_scanned = 0usize;
        let mut bytes_scanned = 0usize;
        let mut work_units = 0usize;
        let mut truncated = false;
        let mut resource_limited = false;
        let mut next_position = None;
        let mut last_position = None;
        let symbols = &query.selector.symbols;

        // A structure request may return only evidence derived from the exact
        // immutable snapshot. We bound both bytes scanned and node count, and do
        // not claim parser-backed declarations or reference edges.
        'files: if overlay.is_none() && !symbols.is_empty() {
            for (path, contents, file_digest) in base.file_entries() {
                if resume_after.is_some_and(|position| path < position.path_ref.as_str()) {
                    continue;
                }
                if query.root_ref != "."
                    && path != query.root_ref
                    && !path
                        .strip_prefix(query.root_ref.as_str())
                        .is_some_and(|tail| tail.starts_with('/'))
                {
                    continue;
                }
                let depth = if query.root_ref == "." {
                    path.split('/').count()
                } else {
                    path.strip_prefix(query.root_ref.as_str())
                        .unwrap_or("")
                        .trim_start_matches('/')
                        .split('/')
                        .count()
                };
                if depth > query.max_depth {
                    continue;
                }
                // A continuation resumes after its exact emitted occurrence. Do
                // not charge immutable files before that anchor against every
                // page's independent byte budget.
                let file_scan_start = match resume_after {
                    Some(position) if path == position.path_ref => {
                        let symbol = &symbols[position.symbol_index];
                        usize::try_from(position.byte_offset)
                            .ok()
                            .and_then(|offset| offset.checked_add(symbol.len()))
                            .ok_or(RepoStructureError::InvalidQuery("resume position overflows"))?
                    }
                    _ => 0,
                };
                let scan_bytes = contents.len().saturating_sub(file_scan_start);
                let Some(next_bytes) = bytes_scanned.checked_add(scan_bytes) else {
                    truncated = true;
                    continue;
                };
                if next_bytes > query.max_bytes {
                    // This immutable file suffix cannot fit in the remaining page
                    // scan budget. Report partial coverage and skip it so a later,
                    // smaller file can still make forward progress. A cursor is
                    // emitted only from a real extra match beyond the node cap.
                    truncated = true;
                    continue;
                }
                bytes_scanned = next_bytes;
                files_scanned = files_scanned.saturating_add(1);

                for (symbol_index, symbol) in symbols.iter().enumerate() {
                    let start_offset = match resume_after {
                        Some(position) if path == position.path_ref && symbol_index < position.symbol_index => continue,
                        Some(position) if path == position.path_ref && symbol_index == position.symbol_index => {
                            usize::try_from(position.byte_offset)
                                .ok()
                                .and_then(|offset| offset.checked_add(symbol.len()))
                                .ok_or(RepoStructureError::InvalidQuery("resume position overflows"))?
                        }
                        _ => 0,
                    };
                    let Some(next_work_units) = work_units.checked_add(contents.len().saturating_sub(start_offset)) else {
                        truncated = true;
                        resource_limited = true;
                        break 'files;
                    };
                    if next_work_units > MAX_STRUCTURE_WORK_UNITS {
                        // `maxBytes` counts unique source bytes. Bound the
                        // repeated selector scans separately and report the
                        // omitted work as resource-limited partial coverage.
                        truncated = true;
                        resource_limited = true;
                        break 'files;
                    }
                    work_units = next_work_units;
                    let remaining = contents
                        .get(start_offset..)
                        .ok_or(RepoStructureError::InvalidQuery("resume position is not a UTF-8 boundary"))?;
                    for (relative_offset, _) in remaining.match_indices(symbol.as_str()) {
                        let offset = start_offset + relative_offset;
                        if nodes.len() == query.max_nodes {
                            // This extra occurrence proves more results remain.
                            // Reuse the last emitted node as an exclusive anchor.
                            next_position = last_position.clone();
                            truncated = true;
                            break 'files;
                        }
                        let end = offset.saturating_add(symbol.len());
                        let mut hasher = blake3::Hasher::new();
                        hasher.update(b"horizon.repo-intel.lexical-node.v1\0");
                        hasher.update(query.source_generation.as_bytes());
                        hasher.update(path.as_bytes());
                        hasher.update(&(offset as u64).to_le_bytes());
                        hasher.update(&(end as u64).to_le_bytes());
                        hasher.update(symbol.as_bytes());
                        let node_id = format!("lex_{}", hex_digest(hasher.finalize().as_bytes()));
                        nodes.push(RepoNodeRefV1 {
                            workspace_binding: provenance.workspace_binding.clone(),
                            source_generation: query.source_generation.clone(),
                            source_revision: provenance.source_revision.clone(),
                            overlay_digest: None,
                            path_ref: path.to_owned(),
                            file_digest: file_digest.to_string(),
                            node_id,
                            node_kind: "text_occurrence".to_owned(),
                            symbol: symbol.clone(),
                            byte_range: StructureByteRangeV1 {
                                start: offset as u64,
                                end: end as u64,
                            },
                            parser_id: "horizoncode.lexical".to_owned(),
                            parser_version: "1".to_owned(),
                        });
                        last_position = Some(RepoStructurePositionV1 {
                            path_ref: path.to_owned(),
                            symbol_index,
                            byte_offset: offset as u64,
                        });
                    }
                }
            }
        }

        let has_lexical_source = overlay.is_none() && !symbols.is_empty();
        Ok(RepoStructurePageV1 {
            schema_version: 1,
            message_type: "page".to_owned(),
            query_id: query.query_id.clone(),
            workspace_binding: provenance.workspace_binding.clone(),
            source_generation: query.source_generation.clone(),
            source_revision: provenance.source_revision.clone(),
            overlay_digest: overlay.map(|overlay| overlay.digest().to_string()),
            source_kind: if has_lexical_source {
                RepoStructureSourceKindV1::Lexical
            } else {
                RepoStructureSourceKindV1::None
            },
            parser_id: None,
            parser_version: None,
            status: if has_lexical_source {
                RepoStructureStatusV1::Partial
            } else {
                RepoStructureStatusV1::Unavailable
            },
            freshness: if has_lexical_source {
                RepoStructureFreshnessV1::Current
            } else {
                RepoStructureFreshnessV1::Unknown
            },
            completeness: if has_lexical_source {
                RepoStructureCompletenessV1::Partial
            } else {
                RepoStructureCompletenessV1::Unavailable
            },
            coverage: RepoStructureCoverageV1 {
                files: files_scanned,
                nodes: nodes.len(),
                bytes: bytes_scanned,
            },
            nodes,
            fallback: Some(RepoStructureFallbackV1 {
                reason: if truncated {
                    if resource_limited {
                        RepoStructureFallbackReasonV1::ResourceRefused
                    } else {
                        RepoStructureFallbackReasonV1::ParsePartial
                    }
                } else {
                    RepoStructureFallbackReasonV1::ParserUnsupported
                },
                source_kind: if has_lexical_source {
                    RepoStructureSourceKindV1::Lexical
                } else {
                    RepoStructureSourceKindV1::None
                },
            }),
            next_cursor: None,
            next_position,
        })
    }
}

fn validate_resume_position(
    generation: &crate::BaseGeneration,
    query: &RepoStructureQueryV1,
    position: Option<&RepoStructurePositionV1>,
) -> Result<(), RepoStructureError> {
    let Some(position) = position else {
        if query.cursor.is_some() {
            return Err(RepoStructureError::InvalidQuery(
                "HostKernel must resolve an opaque cursor before indexd paging",
            ));
        }
        return Ok(());
    };
    if query.cursor.is_none()
        || crate::validate_path(&position.path_ref).is_err()
        || position.symbol_index >= query.selector.symbols.len()
    {
        return Err(RepoStructureError::InvalidQuery(
            "resume position does not match a HostKernel-resolved continuation",
        ));
    }
    let symbol = &query.selector.symbols[position.symbol_index];
    let offset = usize::try_from(position.byte_offset)
        .map_err(|_| RepoStructureError::InvalidQuery("resume byte offset overflows"))?;
    let (path, contents, _) = generation
        .file_entries()
        .find(|(path, _, _)| *path == position.path_ref)
        .ok_or(RepoStructureError::InvalidQuery("resume path is absent from generation"))?;
    if query.root_ref != "."
        && path != query.root_ref
        && !path
            .strip_prefix(query.root_ref.as_str())
            .is_some_and(|tail| tail.starts_with('/'))
    {
        return Err(RepoStructureError::InvalidQuery("resume path is outside rootRef"));
    }
    let depth = if query.root_ref == "." {
        path.split('/').count()
    } else {
        path.strip_prefix(query.root_ref.as_str())
            .unwrap_or("")
            .trim_start_matches('/')
            .split('/')
            .count()
    };
    let end = offset
        .checked_add(symbol.len())
        .ok_or(RepoStructureError::InvalidQuery("resume match range overflows"))?;
    if depth > query.max_depth || contents.get(offset..end) != Some(symbol.as_str()) {
        return Err(RepoStructureError::InvalidQuery(
            "resume position is not an exact in-scope selector match",
        ));
    }
    Ok(())
}

fn hex_digest(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(HEX[(byte >> 4) as usize] as char);
        output.push(HEX[(byte & 0x0f) as usize] as char);
    }
    output
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
