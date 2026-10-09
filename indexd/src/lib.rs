#![doc = include_str!("README.md")]

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

pub const MAX_BASE_FILES: usize = 4_096;
pub const MAX_FILE_BYTES: usize = 1_048_576;
pub const MAX_BASE_CONTENT_BYTES: usize = 67_108_864;
pub const MAX_BASE_PATH_BYTES: usize = 4_194_304;
pub const MAX_OVERLAY_FILES: usize = 128;
pub const MAX_OVERLAY_CHANGES: usize = MAX_OVERLAY_FILES;
pub const MAX_OVERLAY_CONTENT_BYTES: usize = 8_388_608;
pub const MAX_PATH_BYTES: usize = 1_024;
pub const MAX_PIN_BYTES: usize = 4_096;
pub const MAX_QUERY_BYTES: usize = 256;
pub const MAX_QUERY_RESULTS: usize = 100;
pub const MAX_QUERY_WORK_UNITS: usize = 4_194_304;
pub const MAX_SEARCH_CURSOR_BYTES: usize = 2_400;

const BASE_DOMAIN: &[u8] = b"horizon.indexd.base-generation.v1\0";
const FILE_DOMAIN: &[u8] = b"horizon.indexd.file-content.v1\0";
const OVERLAY_DOMAIN: &[u8] = b"horizon.indexd.buffer-overlay.v1\0";
const QUERY_DOMAIN: &[u8] = b"horizon.indexd.query.v1\0";
const SEARCH_CURSOR_DOMAIN: &[u8] = b"horizon.indexd.search-cursor.v1\0";

const HEX_DIGITS: &[u8; 16] = b"0123456789abcdef";

/// BLAKE3 digest with a stable `blake3:<lowercase hex>` display representation.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Digest([u8; 32]);

impl Digest {
    fn from_hasher(hasher: blake3::Hasher) -> Self {
        Self(*hasher.finalize().as_bytes())
    }

    /// Returns the raw 32-byte BLAKE3 digest.
    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    /// Returns the canonical prefixed lowercase hexadecimal digest.
    pub fn to_tagged_string(self) -> String {
        format!("{self}")
    }
}

impl fmt::Display for Digest {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("blake3:")?;
        for byte in self.0 {
            write!(formatter, "{byte:02x}")?;
        }
        Ok(())
    }
}

/// An uninterpreted, caller-owned identity or receipt value.
///
/// Values are hashed as opaque bytes. This type does not validate that a pin is
/// authoritative, current, or authorized.
#[derive(Clone, Eq, PartialEq)]
pub struct OpaquePin(Vec<u8>);

impl fmt::Debug for OpaquePin {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("OpaquePin")
            .field("byte_len", &self.0.len())
            .finish_non_exhaustive()
    }
}

impl OpaquePin {
    pub fn new(value: impl Into<Vec<u8>>) -> Result<Self, IndexError> {
        let value = value.into();
        validate_pin(&value)?;
        Ok(Self(value))
    }

    pub fn as_bytes(&self) -> &[u8] {
        &self.0
    }
}

/// Caller-supplied provenance pins for a base generation.
///
/// The pin meanings are deliberately opaque: the integrating owner must validate
/// their authority and bind them to actual workspace/source observations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GenerationPins {
    pub repository: OpaquePin,
    pub workspace: Option<OpaquePin>,
    pub revision_set: OpaquePin,
    pub read_scope: OpaquePin,
    pub read_policy: OpaquePin,
    pub source_receipt: OpaquePin,
    pub parser_set: OpaquePin,
}

impl GenerationPins {
    fn validate(&self) -> Result<(), IndexError> {
        validate_pin(self.repository.as_bytes())?;
        if let Some(workspace) = &self.workspace {
            validate_pin(workspace.as_bytes())?;
        }
        validate_pin(self.revision_set.as_bytes())?;
        validate_pin(self.read_scope.as_bytes())?;
        validate_pin(self.read_policy.as_bytes())?;
        validate_pin(self.source_receipt.as_bytes())?;
        validate_pin(self.parser_set.as_bytes())?;
        Ok(())
    }
}

/// A bounded caller-provided UTF-8 file snapshot. No filesystem access is performed.
#[derive(Clone, Eq, PartialEq)]
pub struct FileSnapshot {
    pub path: String,
    pub contents: Vec<u8>,
}

impl FileSnapshot {
    pub fn new(path: impl Into<String>, contents: impl Into<Vec<u8>>) -> Self {
        Self {
            path: path.into(),
            contents: contents.into(),
        }
    }
}

/// One caller-supplied edit to an immutable buffer overlay.
pub enum OverlayChange {
    Replace(FileSnapshot),
    Clear { path: String },
}

/// This library can provide lexical search only; enrichment capabilities are absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct IndexCapabilities {
    pub lexical: bool,
    pub tree_sitter: bool,
    pub lsp: bool,
    pub scip: bool,
    pub vector: bool,
}

impl IndexCapabilities {
    pub const AVAILABLE: Self = Self {
        lexical: true,
        tree_sitter: false,
        lsp: false,
        scip: false,
        vector: false,
    };
}

/// P4 generation state. This slice deliberately has no `Current` variant.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GenerationStatus {
    Partial,
}

#[derive(Clone)]
struct IndexedFile {
    contents: String,
    content_digest: Digest,
}

/// Immutable lexical base snapshot. All fields are private to prevent in-place edits.
#[derive(Clone)]
pub struct BaseGeneration {
    generation_digest: Digest,
    pins: GenerationPins,
    files: BTreeMap<String, IndexedFile>,
    content_bytes: usize,
}

impl fmt::Debug for BaseGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BaseGeneration")
            .field("generation_digest", &self.generation_digest)
            .field("status", &self.status())
            .field("file_count", &self.files.len())
            .field("content_bytes", &self.content_bytes)
            .finish_non_exhaustive()
    }
}

impl BaseGeneration {
    /// Build a deterministic immutable generation from bounded caller snapshots.
    pub fn build<I>(pins: GenerationPins, snapshots: I) -> Result<Self, IndexError>
    where
        I: IntoIterator<Item = FileSnapshot>,
    {
        pins.validate()?;

        let mut files = BTreeMap::new();
        let mut content_bytes = 0usize;
        let mut path_bytes = 0usize;

        for snapshot in snapshots {
            if files.len() >= MAX_BASE_FILES {
                return Err(IndexError::TooManyBaseFiles {
                    limit: MAX_BASE_FILES,
                });
            }
            validate_path(&snapshot.path)?;
            if snapshot.contents.len() > MAX_FILE_BYTES {
                return Err(IndexError::FileTooLarge {
                    path: snapshot.path,
                    limit: MAX_FILE_BYTES,
                });
            }
            content_bytes = content_bytes
                .checked_add(snapshot.contents.len())
                .filter(|total| *total <= MAX_BASE_CONTENT_BYTES)
                .ok_or(IndexError::BaseContentLimit {
                    limit: MAX_BASE_CONTENT_BYTES,
                })?;
            path_bytes = path_bytes
                .checked_add(snapshot.path.len())
                .filter(|total| *total <= MAX_BASE_PATH_BYTES)
                .ok_or(IndexError::BasePathLimit {
                    limit: MAX_BASE_PATH_BYTES,
                })?;

            let path = snapshot.path;
            if files.contains_key(&path) {
                return Err(IndexError::DuplicatePath(path));
            }
            let content_digest = hash_content(&snapshot.contents);
            let contents = String::from_utf8(snapshot.contents)
                .map_err(|_| IndexError::InvalidUtf8 { path: path.clone() })?;
            files.insert(
                path,
                IndexedFile {
                    contents,
                    content_digest,
                },
            );
        }

        let generation_digest = hash_generation(&pins, &files);
        Ok(Self {
            generation_digest,
            pins,
            files,
            content_bytes,
        })
    }

    pub fn digest(&self) -> Digest {
        self.generation_digest
    }

    pub fn status(&self) -> GenerationStatus {
        GenerationStatus::Partial
    }

    pub fn capabilities(&self) -> IndexCapabilities {
        IndexCapabilities::AVAILABLE
    }

    pub fn pins(&self) -> &GenerationPins {
        &self.pins
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn content_bytes(&self) -> usize {
        self.content_bytes
    }

    /// Search the base generation only.
    pub fn search(&self, query: &str, max_results: usize) -> Result<QueryResult, IndexError> {
        self.search_page(query, max_results, None)
    }

    /// Search a deterministic page after an optional cursor.
    ///
    /// A cursor is valid only for this exact query and generation. It resumes after
    /// the last returned matching path and line, and the bounded scan verifies that
    /// anchor before yielding later results. `max_results` is a per-page cap and may
    /// vary between continuation calls.
    pub fn search_page(
        &self,
        query: &str,
        max_results: usize,
        cursor: Option<&SearchCursor>,
    ) -> Result<QueryResult, IndexError> {
        self.search_page_with_overlay(query, max_results, None, cursor)
    }

    /// Search using an optional exact-generation unsaved-buffer overlay.
    pub fn search_with_overlay(
        &self,
        query: &str,
        max_results: usize,
        overlay: Option<&BufferOverlay>,
    ) -> Result<QueryResult, IndexError> {
        self.search_page_with_overlay(query, max_results, overlay, None)
    }

    /// Search a deterministic page using an optional exact-generation overlay.
    /// The cursor is bound to the query, base generation, and overlay digest.
    pub fn search_page_with_overlay(
        &self,
        query: &str,
        max_results: usize,
        overlay: Option<&BufferOverlay>,
        cursor: Option<&SearchCursor>,
    ) -> Result<QueryResult, IndexError> {
        validate_query(query, max_results)?;
        if let Some(overlay) = overlay {
            if overlay.base_generation_digest != self.generation_digest {
                return Err(IndexError::OverlayGenerationMismatch {
                    expected: self.generation_digest,
                    actual: overlay.base_generation_digest,
                });
            }
        }

        let query_digest = hash_query(query);
        let cursor_anchor = if let Some(cursor) = cursor {
            let data = decode_search_cursor(cursor.as_token())?;
            if data.query_digest != query_digest {
                return Err(IndexError::CursorQueryMismatch);
            }
            if data.generation_digest != self.generation_digest {
                return Err(IndexError::CursorGenerationMismatch);
            }
            if data.overlay_digest != overlay.map(BufferOverlay::digest) {
                return Err(IndexError::CursorOverlayMismatch);
            }
            Some(data.anchor)
        } else {
            None
        };

        let pattern = query.as_bytes();
        let mut work = WorkMeter::new(MAX_QUERY_WORK_UNITS);
        let prefix = match build_prefix_table(pattern, &mut work) {
            Some(prefix) => prefix,
            None => {
                if cursor_anchor.is_some() {
                    return Err(IndexError::CursorWorkLimit);
                }
                return Ok(QueryResult::new(
                    self.generation_digest,
                    overlay,
                    Vec::new(),
                    work.used,
                    Some(SearchTruncation::WorkLimit),
                    None,
                ));
            }
        };
        let mut page = SearchPageState {
            max_results,
            matches: Vec::new(),
            cursor_anchor: cursor_anchor.clone(),
            cursor_anchor_found: cursor_anchor.is_none(),
            last_match: None,
        };
        let mut truncated_by = None;

        for (path, base_file) in &self.files {
            let contents = overlay
                .and_then(|candidate| candidate.files.get(path))
                .map(|file| file.contents.as_str())
                .unwrap_or(base_file.contents.as_str());

            match search_file(path, contents, pattern, &prefix, &mut work, &mut page) {
                FileSearchOutcome::Complete => {}
                FileSearchOutcome::ResultLimit => {
                    truncated_by = Some(SearchTruncation::ResultLimit);
                    break;
                }
                FileSearchOutcome::WorkLimit => {
                    if page.cursor_anchor.is_some() && !page.cursor_anchor_found {
                        return Err(IndexError::CursorWorkLimit);
                    }
                    truncated_by = Some(SearchTruncation::WorkLimit);
                    break;
                }
                FileSearchOutcome::CursorAnchorNotFound => {
                    return Err(IndexError::CursorAnchorNotFound);
                }
            }
        }

        if page.cursor_anchor.is_some() && !page.cursor_anchor_found {
            return Err(IndexError::CursorAnchorNotFound);
        }

        let next_cursor = if truncated_by == Some(SearchTruncation::ResultLimit) {
            page.last_match.map(|anchor| {
                SearchCursor::new(
                    self.generation_digest,
                    overlay.map(BufferOverlay::digest),
                    query_digest,
                    anchor,
                )
            })
        } else {
            None
        };

        Ok(QueryResult::new(
            self.generation_digest,
            overlay,
            page.matches,
            work.used,
            truncated_by,
            next_cursor,
        ))
    }
}

/// Immutable unsaved editor content tied to one exact base digest and editor version.
#[derive(Clone)]
pub struct BufferOverlay {
    base_generation_digest: Digest,
    editor_version: OpaquePin,
    overlay_digest: Digest,
    files: BTreeMap<String, IndexedFile>,
    content_bytes: usize,
}

impl fmt::Debug for BufferOverlay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BufferOverlay")
            .field("base_generation_digest", &self.base_generation_digest)
            .field("overlay_digest", &self.overlay_digest)
            .field("file_count", &self.files.len())
            .field("content_bytes", &self.content_bytes)
            .field("editor_version", &self.editor_version)
            .finish_non_exhaustive()
    }
}

impl BufferOverlay {
    /// Build an overlay that shadows only paths already present in `base`.
    pub fn build<I>(
        base: &BaseGeneration,
        editor_version: OpaquePin,
        snapshots: I,
    ) -> Result<Self, IndexError>
    where
        I: IntoIterator<Item = FileSnapshot>,
    {
        validate_pin(editor_version.as_bytes())?;
        let mut files = BTreeMap::new();
        let mut content_bytes = 0usize;

        for snapshot in snapshots {
            if files.len() >= MAX_OVERLAY_FILES {
                return Err(IndexError::TooManyOverlayFiles {
                    limit: MAX_OVERLAY_FILES,
                });
            }
            validate_path(&snapshot.path)?;
            if snapshot.contents.len() > MAX_FILE_BYTES {
                return Err(IndexError::FileTooLarge {
                    path: snapshot.path,
                    limit: MAX_FILE_BYTES,
                });
            }
            content_bytes = content_bytes
                .checked_add(snapshot.contents.len())
                .filter(|total| *total <= MAX_OVERLAY_CONTENT_BYTES)
                .ok_or(IndexError::OverlayContentLimit {
                    limit: MAX_OVERLAY_CONTENT_BYTES,
                })?;
            let path = snapshot.path;
            if !base.files.contains_key(&path) {
                return Err(IndexError::OverlayPathNotInBase(path));
            }
            if files.contains_key(&path) {
                return Err(IndexError::DuplicatePath(path));
            }
            let content_digest = hash_content(&snapshot.contents);
            let contents = String::from_utf8(snapshot.contents)
                .map_err(|_| IndexError::InvalidUtf8 { path: path.clone() })?;
            files.insert(
                path,
                IndexedFile {
                    contents,
                    content_digest,
                },
            );
        }

        let overlay_digest = hash_overlay(base.generation_digest, &editor_version, &files);
        Ok(Self {
            base_generation_digest: base.generation_digest,
            editor_version,
            overlay_digest,
            files,
            content_bytes,
        })
    }

    /// Return a new overlay with one existing base path replaced by an editor snapshot.
    /// The original overlay remains unchanged; no repository-wide generation is rebuilt.
    pub fn replace_file(
        &self,
        base: &BaseGeneration,
        editor_version: OpaquePin,
        snapshot: FileSnapshot,
    ) -> Result<Self, IndexError> {
        self.validate_base(base)?;
        validate_pin(editor_version.as_bytes())?;
        validate_path(&snapshot.path)?;
        if !base.files.contains_key(&snapshot.path) {
            return Err(IndexError::OverlayPathNotInBase(snapshot.path));
        }
        if snapshot.contents.len() > MAX_FILE_BYTES {
            return Err(IndexError::FileTooLarge {
                path: snapshot.path,
                limit: MAX_FILE_BYTES,
            });
        }

        let previous_bytes = self
            .files
            .get(&snapshot.path)
            .map_or(0, |file| file.contents.len());
        let content_bytes = self
            .content_bytes
            .checked_sub(previous_bytes)
            .and_then(|bytes| bytes.checked_add(snapshot.contents.len()))
            .filter(|bytes| *bytes <= MAX_OVERLAY_CONTENT_BYTES)
            .ok_or(IndexError::OverlayContentLimit {
                limit: MAX_OVERLAY_CONTENT_BYTES,
            })?;
        if !self.files.contains_key(&snapshot.path) && self.files.len() >= MAX_OVERLAY_FILES {
            return Err(IndexError::TooManyOverlayFiles {
                limit: MAX_OVERLAY_FILES,
            });
        }

        let path = snapshot.path;
        let content_digest = hash_content(&snapshot.contents);
        let contents = String::from_utf8(snapshot.contents)
            .map_err(|_| IndexError::InvalidUtf8 { path: path.clone() })?;
        let mut files = self.files.clone();
        files.insert(
            path,
            IndexedFile {
                contents,
                content_digest,
            },
        );
        Ok(Self::from_files(
            base.generation_digest,
            editor_version,
            files,
            content_bytes,
        ))
    }

    /// Return a new overlay with one buffer removed, revealing that path's base bytes.
    pub fn clear_file(
        &self,
        base: &BaseGeneration,
        editor_version: OpaquePin,
        path: &str,
    ) -> Result<Self, IndexError> {
        self.validate_base(base)?;
        validate_pin(editor_version.as_bytes())?;
        validate_path(path)?;
        if !base.files.contains_key(path) {
            return Err(IndexError::OverlayPathNotInBase(path.to_owned()));
        }

        let mut files = self.files.clone();
        let content_bytes = if let Some(removed) = files.remove(path) {
            self.content_bytes
                .checked_sub(removed.contents.len())
                .ok_or(IndexError::OverlayContentLimit {
                    limit: MAX_OVERLAY_CONTENT_BYTES,
                })?
        } else {
            self.content_bytes
        };
        Ok(Self::from_files(
            base.generation_digest,
            editor_version,
            files,
            content_bytes,
        ))
    }

    /// Apply a bounded, duplicate-free batch against one exact base generation.
    /// A successful batch returns one new immutable overlay pinned to `editor_version`;
    /// failures leave this overlay unchanged and return no partial overlay.
    pub fn apply_changes<I>(
        &self,
        base: &BaseGeneration,
        editor_version: OpaquePin,
        changes: I,
    ) -> Result<Self, IndexError>
    where
        I: IntoIterator<Item = OverlayChange>,
    {
        self.validate_base(base)?;
        validate_pin(editor_version.as_bytes())?;

        let mut staged = BTreeMap::new();
        let mut replacement_bytes = 0usize;
        for change in changes {
            let (path, replacement) = match change {
                OverlayChange::Replace(snapshot) => {
                    validate_path(&snapshot.path)?;
                    if !base.files.contains_key(&snapshot.path) {
                        return Err(IndexError::OverlayPathNotInBase(snapshot.path));
                    }
                    if staged.contains_key(&snapshot.path) {
                        return Err(IndexError::DuplicateOverlayChange(snapshot.path));
                    }
                    if staged.len() >= MAX_OVERLAY_CHANGES {
                        return Err(IndexError::TooManyOverlayChanges {
                            limit: MAX_OVERLAY_CHANGES,
                        });
                    }
                    if snapshot.contents.len() > MAX_FILE_BYTES {
                        return Err(IndexError::FileTooLarge {
                            path: snapshot.path,
                            limit: MAX_FILE_BYTES,
                        });
                    }
                    replacement_bytes = replacement_bytes
                        .checked_add(snapshot.contents.len())
                        .filter(|total| *total <= MAX_OVERLAY_CONTENT_BYTES)
                        .ok_or(IndexError::OverlayContentLimit {
                            limit: MAX_OVERLAY_CONTENT_BYTES,
                        })?;

                    let path = snapshot.path;
                    let content_digest = hash_content(&snapshot.contents);
                    let contents = String::from_utf8(snapshot.contents)
                        .map_err(|_| IndexError::InvalidUtf8 { path: path.clone() })?;
                    (
                        path,
                        Some(IndexedFile {
                            contents,
                            content_digest,
                        }),
                    )
                }
                OverlayChange::Clear { path } => {
                    validate_path(&path)?;
                    if !base.files.contains_key(&path) {
                        return Err(IndexError::OverlayPathNotInBase(path));
                    }
                    if staged.contains_key(&path) {
                        return Err(IndexError::DuplicateOverlayChange(path));
                    }
                    if staged.len() >= MAX_OVERLAY_CHANGES {
                        return Err(IndexError::TooManyOverlayChanges {
                            limit: MAX_OVERLAY_CHANGES,
                        });
                    }
                    (path, None)
                }
            };
            staged.insert(path, replacement);
        }

        let mut files = self.files.clone();
        for (path, replacement) in staged {
            match replacement {
                Some(file) => {
                    files.insert(path, file);
                }
                None => {
                    files.remove(&path);
                }
            }
        }
        if files.len() > MAX_OVERLAY_FILES {
            return Err(IndexError::TooManyOverlayFiles {
                limit: MAX_OVERLAY_FILES,
            });
        }
        let content_bytes = files.values().try_fold(0usize, |total, file| {
            total
                .checked_add(file.contents.len())
                .filter(|bytes| *bytes <= MAX_OVERLAY_CONTENT_BYTES)
                .ok_or(IndexError::OverlayContentLimit {
                    limit: MAX_OVERLAY_CONTENT_BYTES,
                })
        })?;

        Ok(Self::from_files(
            base.generation_digest,
            editor_version,
            files,
            content_bytes,
        ))
    }

    fn validate_base(&self, base: &BaseGeneration) -> Result<(), IndexError> {
        if self.base_generation_digest != base.generation_digest {
            return Err(IndexError::OverlayGenerationMismatch {
                expected: base.generation_digest,
                actual: self.base_generation_digest,
            });
        }
        Ok(())
    }

    fn from_files(
        base_generation_digest: Digest,
        editor_version: OpaquePin,
        files: BTreeMap<String, IndexedFile>,
        content_bytes: usize,
    ) -> Self {
        let overlay_digest = hash_overlay(base_generation_digest, &editor_version, &files);
        Self {
            base_generation_digest,
            editor_version,
            overlay_digest,
            files,
            content_bytes,
        }
    }

    pub fn base_generation_digest(&self) -> Digest {
        self.base_generation_digest
    }

    pub fn editor_version(&self) -> &OpaquePin {
        &self.editor_version
    }

    pub fn digest(&self) -> Digest {
        self.overlay_digest
    }

    pub fn file_count(&self) -> usize {
        self.files.len()
    }

    pub fn content_bytes(&self) -> usize {
        self.content_bytes
    }
}

/// A versioned bounded resume token for deterministic lexical search pagination.
///
/// Treat the token as opaque. Its digest bindings detect context changes but do not
/// authenticate the caller or grant access to repository data.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchCursor {
    token: String,
}

impl SearchCursor {
    /// Parse a token returned by [`QueryResult::next_cursor`].
    pub fn parse(token: &str) -> Result<Self, IndexError> {
        decode_search_cursor(token)?;
        Ok(Self {
            token: token.to_owned(),
        })
    }

    /// Return the bounded serialized token for transport and later parsing.
    pub fn as_token(&self) -> &str {
        &self.token
    }

    fn new(
        generation_digest: Digest,
        overlay_digest: Option<Digest>,
        query_digest: Digest,
        anchor: CursorAnchor,
    ) -> Self {
        let payload = format!(
            "v1:{}:{}:{}:{}:{}",
            encode_hex(generation_digest.as_bytes()),
            overlay_digest.map_or_else(|| "-".to_owned(), |digest| encode_hex(digest.as_bytes())),
            encode_hex(query_digest.as_bytes()),
            encode_hex(anchor.path.as_bytes()),
            anchor.line,
        );
        let checksum = hash_search_cursor_payload(payload.as_bytes());
        let token = format!("{payload}:{}", encode_hex(checksum.as_bytes()));
        debug_assert!(token.len() <= MAX_SEARCH_CURSOR_BYTES);
        Self { token }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CursorAnchor {
    path: String,
    line: u64,
}

struct SearchCursorData {
    generation_digest: Digest,
    overlay_digest: Option<Digest>,
    query_digest: Digest,
    anchor: CursorAnchor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QueryStatus {
    Partial,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SearchTruncation {
    WorkLimit,
    ResultLimit,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchMatch {
    pub path: String,
    pub start_line: u64,
    pub end_line: u64,
}

/// Bounded lexical observations with explicit base and optional overlay provenance.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueryResult {
    pub status: QueryStatus,
    pub generation_status: GenerationStatus,
    pub generation_digest: Digest,
    pub overlay_digest: Option<Digest>,
    pub editor_version: Option<OpaquePin>,
    pub matches: Vec<SearchMatch>,
    /// Present only when the result limit, rather than the work limit, ended the page.
    pub next_cursor: Option<SearchCursor>,
    pub work_units: usize,
    pub truncated_by: Option<SearchTruncation>,
}

impl QueryResult {
    fn new(
        generation_digest: Digest,
        overlay: Option<&BufferOverlay>,
        matches: Vec<SearchMatch>,
        work_units: usize,
        truncated_by: Option<SearchTruncation>,
        next_cursor: Option<SearchCursor>,
    ) -> Self {
        Self {
            status: QueryStatus::Partial,
            generation_status: GenerationStatus::Partial,
            generation_digest,
            overlay_digest: overlay.map(BufferOverlay::digest),
            editor_version: overlay.map(|candidate| candidate.editor_version.clone()),
            matches,
            next_cursor,
            work_units,
            truncated_by,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum IndexError {
    EmptyPin,
    PinTooLarge { limit: usize },
    InvalidPath(String),
    DuplicatePath(String),
    InvalidUtf8 { path: String },
    TooManyBaseFiles { limit: usize },
    FileTooLarge { path: String, limit: usize },
    BaseContentLimit { limit: usize },
    BasePathLimit { limit: usize },
    TooManyOverlayFiles { limit: usize },
    TooManyOverlayChanges { limit: usize },
    OverlayContentLimit { limit: usize },
    OverlayPathNotInBase(String),
    DuplicateOverlayChange(String),
    EmptyQuery,
    QueryTooLarge { limit: usize },
    MultilineQuery,
    InvalidResultLimit { limit: usize },
    OverlayGenerationMismatch { expected: Digest, actual: Digest },
    InvalidSearchCursor,
    CursorQueryMismatch,
    CursorGenerationMismatch,
    CursorOverlayMismatch,
    CursorAnchorNotFound,
    CursorWorkLimit,
}

impl fmt::Display for IndexError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyPin => formatter.write_str("opaque pins must not be empty"),
            Self::PinTooLarge { limit } => {
                write!(formatter, "opaque pin exceeds the {limit}-byte limit")
            }
            Self::InvalidPath(path) => {
                write!(formatter, "invalid normalized relative path: {path:?}")
            }
            Self::DuplicatePath(path) => write!(formatter, "duplicate snapshot path: {path:?}"),
            Self::InvalidUtf8 { path } => write!(formatter, "snapshot is not UTF-8 text: {path:?}"),
            Self::TooManyBaseFiles { limit } => {
                write!(formatter, "base generation exceeds the {limit}-file limit")
            }
            Self::FileTooLarge { path, limit } => {
                write!(formatter, "file {path:?} exceeds the {limit}-byte limit")
            }
            Self::BaseContentLimit { limit } => {
                write!(
                    formatter,
                    "base generation exceeds the {limit}-byte content limit"
                )
            }
            Self::BasePathLimit { limit } => {
                write!(
                    formatter,
                    "base generation exceeds the {limit}-byte path limit"
                )
            }
            Self::TooManyOverlayFiles { limit } => {
                write!(formatter, "buffer overlay exceeds the {limit}-file limit")
            }
            Self::TooManyOverlayChanges { limit } => {
                write!(formatter, "overlay batch exceeds the {limit}-change limit")
            }
            Self::OverlayContentLimit { limit } => {
                write!(
                    formatter,
                    "buffer overlay exceeds the {limit}-byte content limit"
                )
            }
            Self::OverlayPathNotInBase(path) => {
                write!(
                    formatter,
                    "overlay path is not present in its base: {path:?}"
                )
            }
            Self::DuplicateOverlayChange(path) => {
                write!(
                    formatter,
                    "overlay batch changes path more than once: {path:?}"
                )
            }
            Self::EmptyQuery => formatter.write_str("query must not be empty"),
            Self::QueryTooLarge { limit } => {
                write!(formatter, "query exceeds the {limit}-byte limit")
            }
            Self::MultilineQuery => formatter.write_str("query must be a single line"),
            Self::InvalidResultLimit { limit } => {
                write!(formatter, "result limit must be between 1 and {limit}")
            }
            Self::OverlayGenerationMismatch { expected, actual } => write!(
                formatter,
                "overlay is pinned to {actual}, not requested generation {expected}"
            ),
            Self::InvalidSearchCursor => formatter.write_str("search cursor is malformed"),
            Self::CursorQueryMismatch => {
                formatter.write_str("search cursor is bound to a different query")
            }
            Self::CursorGenerationMismatch => {
                formatter.write_str("search cursor is bound to a different generation")
            }
            Self::CursorOverlayMismatch => {
                formatter.write_str("search cursor is bound to a different overlay")
            }
            Self::CursorAnchorNotFound => {
                formatter.write_str("search cursor anchor is not present in this query")
            }
            Self::CursorWorkLimit => {
                formatter.write_str("search work limit was reached before the cursor anchor")
            }
        }
    }
}

impl Error for IndexError {}

fn validate_pin(value: &[u8]) -> Result<(), IndexError> {
    if value.is_empty() {
        return Err(IndexError::EmptyPin);
    }
    if value.len() > MAX_PIN_BYTES {
        return Err(IndexError::PinTooLarge {
            limit: MAX_PIN_BYTES,
        });
    }
    Ok(())
}

/// Require already-normalized slash-separated relative paths, without traversal.
pub fn validate_path(path: &str) -> Result<(), IndexError> {
    if path.is_empty()
        || path.len() > MAX_PATH_BYTES
        || path.starts_with('/')
        || path.contains('\\')
        || path.contains(':')
        || path.chars().any(char::is_control)
        || path
            .split('/')
            .any(|component| component.is_empty() || component == "." || component == "..")
    {
        return Err(IndexError::InvalidPath(path.to_owned()));
    }
    Ok(())
}

fn validate_query(query: &str, max_results: usize) -> Result<(), IndexError> {
    if query.is_empty() {
        return Err(IndexError::EmptyQuery);
    }
    if query.len() > MAX_QUERY_BYTES {
        return Err(IndexError::QueryTooLarge {
            limit: MAX_QUERY_BYTES,
        });
    }
    if query.contains('\n') || query.contains('\r') {
        return Err(IndexError::MultilineQuery);
    }
    if max_results == 0 || max_results > MAX_QUERY_RESULTS {
        return Err(IndexError::InvalidResultLimit {
            limit: MAX_QUERY_RESULTS,
        });
    }
    Ok(())
}

fn hash_query(query: &str) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(QUERY_DOMAIN);
    update_bytes(&mut hasher, query.as_bytes());
    Digest::from_hasher(hasher)
}

fn hash_search_cursor_payload(payload: &[u8]) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(SEARCH_CURSOR_DOMAIN);
    hasher.update(payload);
    Digest::from_hasher(hasher)
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push(HEX_DIGITS[usize::from(byte >> 4)] as char);
        encoded.push(HEX_DIGITS[usize::from(byte & 0x0f)] as char);
    }
    encoded
}

fn decode_hex(value: &str) -> Result<Vec<u8>, IndexError> {
    value
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            let [high, low] = pair else {
                return Err(IndexError::InvalidSearchCursor);
            };
            let high = decode_hex_digit(*high)?;
            let low = decode_hex_digit(*low)?;
            Ok((high << 4) | low)
        })
        .collect()
}

fn decode_hex_digit(value: u8) -> Result<u8, IndexError> {
    match value {
        b'0'..=b'9' => Ok(value - b'0'),
        b'a'..=b'f' => Ok(value - b'a' + 10),
        _ => Err(IndexError::InvalidSearchCursor),
    }
}

fn decode_digest(value: &str) -> Result<Digest, IndexError> {
    if value.len() != 64 {
        return Err(IndexError::InvalidSearchCursor);
    }
    let decoded = decode_hex(value)?;
    let mut bytes = [0; 32];
    bytes.copy_from_slice(&decoded);
    Ok(Digest(bytes))
}

fn decode_search_cursor(token: &str) -> Result<SearchCursorData, IndexError> {
    if token.len() > MAX_SEARCH_CURSOR_BYTES {
        return Err(IndexError::InvalidSearchCursor);
    }

    let mut fields = token.split(':');
    if fields.next() != Some("v1") {
        return Err(IndexError::InvalidSearchCursor);
    }
    let generation_digest = decode_digest(fields.next().ok_or(IndexError::InvalidSearchCursor)?)?;
    let overlay_field = fields.next().ok_or(IndexError::InvalidSearchCursor)?;
    let overlay_digest = if overlay_field == "-" {
        None
    } else {
        Some(decode_digest(overlay_field)?)
    };
    let query_digest = decode_digest(fields.next().ok_or(IndexError::InvalidSearchCursor)?)?;
    let path_field = fields.next().ok_or(IndexError::InvalidSearchCursor)?;
    if path_field.is_empty() || path_field.len() > MAX_PATH_BYTES * 2 {
        return Err(IndexError::InvalidSearchCursor);
    }
    let path_bytes = decode_hex(path_field)?;
    let path = String::from_utf8(path_bytes).map_err(|_| IndexError::InvalidSearchCursor)?;
    validate_path(&path).map_err(|_| IndexError::InvalidSearchCursor)?;

    let line_field = fields.next().ok_or(IndexError::InvalidSearchCursor)?;
    let line = line_field
        .parse::<u64>()
        .map_err(|_| IndexError::InvalidSearchCursor)?;
    if line == 0 || line.to_string() != line_field {
        return Err(IndexError::InvalidSearchCursor);
    }
    let checksum_field = fields.next().ok_or(IndexError::InvalidSearchCursor)?;
    if fields.next().is_some() {
        return Err(IndexError::InvalidSearchCursor);
    }
    let checksum = decode_digest(checksum_field)?;
    let payload = token
        .rsplit_once(':')
        .map(|(payload, _)| payload)
        .ok_or(IndexError::InvalidSearchCursor)?;
    if hash_search_cursor_payload(payload.as_bytes()) != checksum {
        return Err(IndexError::InvalidSearchCursor);
    }

    Ok(SearchCursorData {
        generation_digest,
        overlay_digest,
        query_digest,
        anchor: CursorAnchor { path, line },
    })
}

fn hash_content(contents: &[u8]) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(FILE_DOMAIN);
    update_len(&mut hasher, contents.len());
    hasher.update(contents);
    Digest::from_hasher(hasher)
}

fn hash_generation(pins: &GenerationPins, files: &BTreeMap<String, IndexedFile>) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(BASE_DOMAIN);
    update_pin(&mut hasher, &pins.repository);
    match &pins.workspace {
        Some(workspace) => {
            hasher.update(&[1]);
            update_pin(&mut hasher, workspace);
        }
        None => {
            hasher.update(&[0]);
        }
    }
    update_pin(&mut hasher, &pins.revision_set);
    update_pin(&mut hasher, &pins.read_scope);
    update_pin(&mut hasher, &pins.read_policy);
    update_pin(&mut hasher, &pins.source_receipt);
    update_pin(&mut hasher, &pins.parser_set);
    update_len(&mut hasher, files.len());
    for (path, file) in files {
        update_bytes(&mut hasher, path.as_bytes());
        update_len(&mut hasher, file.contents.len());
        hasher.update(file.content_digest.as_bytes());
    }
    Digest::from_hasher(hasher)
}

fn hash_overlay(
    base_generation_digest: Digest,
    editor_version: &OpaquePin,
    files: &BTreeMap<String, IndexedFile>,
) -> Digest {
    let mut hasher = blake3::Hasher::new();
    hasher.update(OVERLAY_DOMAIN);
    hasher.update(base_generation_digest.as_bytes());
    update_pin(&mut hasher, editor_version);
    update_len(&mut hasher, files.len());
    for (path, file) in files {
        update_bytes(&mut hasher, path.as_bytes());
        update_len(&mut hasher, file.contents.len());
        hasher.update(file.content_digest.as_bytes());
    }
    Digest::from_hasher(hasher)
}

fn update_pin(hasher: &mut blake3::Hasher, pin: &OpaquePin) {
    update_bytes(hasher, pin.as_bytes());
}

fn update_bytes(hasher: &mut blake3::Hasher, bytes: &[u8]) {
    update_len(hasher, bytes.len());
    hasher.update(bytes);
}

fn update_len(hasher: &mut blake3::Hasher, length: usize) {
    hasher.update(&(length as u64).to_be_bytes());
}

struct WorkMeter {
    remaining: usize,
    used: usize,
}

impl WorkMeter {
    fn new(limit: usize) -> Self {
        Self {
            remaining: limit,
            used: 0,
        }
    }

    fn charge(&mut self) -> bool {
        if self.remaining == 0 {
            return false;
        }
        self.remaining -= 1;
        self.used += 1;
        true
    }
}

fn build_prefix_table(pattern: &[u8], work: &mut WorkMeter) -> Option<Vec<usize>> {
    let mut prefix = vec![0; pattern.len()];
    let mut matched = 0usize;
    for index in 1..pattern.len() {
        while matched > 0 {
            if !work.charge() {
                return None;
            }
            if pattern[index] == pattern[matched] {
                break;
            }
            matched = prefix[matched - 1];
        }
        if !work.charge() {
            return None;
        }
        if pattern[index] == pattern[matched] {
            matched += 1;
        }
        prefix[index] = matched;
    }
    Some(prefix)
}

fn line_contains(
    line: &[u8],
    pattern: &[u8],
    prefix: &[usize],
    work: &mut WorkMeter,
) -> Option<bool> {
    let mut matched = 0usize;
    for byte in line {
        while matched > 0 {
            if !work.charge() {
                return None;
            }
            if *byte == pattern[matched] {
                break;
            }
            matched = prefix[matched - 1];
        }
        if !work.charge() {
            return None;
        }
        if *byte == pattern[matched] {
            matched += 1;
            if matched == pattern.len() {
                return Some(true);
            }
        }
    }
    Some(false)
}

enum FileSearchOutcome {
    Complete,
    ResultLimit,
    WorkLimit,
    CursorAnchorNotFound,
}

struct SearchPageState {
    max_results: usize,
    matches: Vec<SearchMatch>,
    cursor_anchor: Option<CursorAnchor>,
    cursor_anchor_found: bool,
    last_match: Option<CursorAnchor>,
}

fn search_file(
    path: &str,
    contents: &str,
    pattern: &[u8],
    prefix: &[usize],
    work: &mut WorkMeter,
    page: &mut SearchPageState,
) -> FileSearchOutcome {
    let bytes = contents.as_bytes();
    let mut start = 0usize;
    let mut line_number = 1u64;

    while start < bytes.len() {
        let mut end = start;
        while end < bytes.len() && bytes[end] != b'\n' {
            if !work.charge() {
                return FileSearchOutcome::WorkLimit;
            }
            end += 1;
        }

        let has_newline = end < bytes.len();
        if has_newline && !work.charge() {
            return FileSearchOutcome::WorkLimit;
        }
        let mut line_end = end;
        if line_end > start && bytes[line_end - 1] == b'\r' {
            line_end -= 1;
        }
        let line = &contents[start..line_end];
        match line_contains(line.as_bytes(), pattern, prefix, work) {
            Some(true) => {
                let candidate = CursorAnchor {
                    path: path.to_owned(),
                    line: line_number,
                };
                if let Some(anchor) = page.cursor_anchor.as_ref() {
                    if !page.cursor_anchor_found {
                        match candidate
                            .path
                            .cmp(&anchor.path)
                            .then_with(|| candidate.line.cmp(&anchor.line))
                        {
                            std::cmp::Ordering::Less => {}
                            std::cmp::Ordering::Equal => page.cursor_anchor_found = true,
                            std::cmp::Ordering::Greater => {
                                return FileSearchOutcome::CursorAnchorNotFound;
                            }
                        }
                        if !page.cursor_anchor_found {
                            if has_newline {
                                start = end + 1;
                            } else {
                                start = end;
                            }
                            line_number += 1;
                            continue;
                        }
                        if candidate.path == anchor.path && candidate.line == anchor.line {
                            if has_newline {
                                start = end + 1;
                            } else {
                                start = end;
                            }
                            line_number += 1;
                            continue;
                        }
                    }
                }
                if page.matches.len() == page.max_results {
                    return FileSearchOutcome::ResultLimit;
                }
                page.matches.push(SearchMatch {
                    path: candidate.path.clone(),
                    start_line: line_number,
                    end_line: line_number,
                });
                page.last_match = Some(candidate);
            }
            Some(false) => {}
            None => return FileSearchOutcome::WorkLimit,
        }

        if has_newline {
            start = end + 1;
        } else {
            start = end;
        }
        line_number += 1;
    }
    FileSearchOutcome::Complete
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pin(value: &str) -> OpaquePin {
        OpaquePin::new(value.as_bytes().to_vec()).unwrap()
    }

    fn pins() -> GenerationPins {
        GenerationPins {
            repository: pin("repo-opaque"),
            workspace: Some(pin("workspace-opaque")),
            revision_set: pin("revision-set-opaque"),
            read_scope: pin("scope-receipt-opaque"),
            read_policy: pin("policy-digest-opaque"),
            source_receipt: pin("source-receipt-opaque"),
            parser_set: pin("parser-set-opaque"),
        }
    }

    fn snapshot(path: &str, contents: &str) -> FileSnapshot {
        FileSnapshot::new(path, contents.as_bytes().to_vec())
    }

    fn generation(snapshots: Vec<FileSnapshot>) -> BaseGeneration {
        BaseGeneration::build(pins(), snapshots).unwrap()
    }

    #[test]
    fn generation_digest_is_independent_of_file_input_order() {
        let first = generation(vec![
            snapshot("src/z.rs", "zeta\n"),
            snapshot("src/a.rs", "alpha\n"),
        ]);
        let second = generation(vec![
            snapshot("src/a.rs", "alpha\n"),
            snapshot("src/z.rs", "zeta\n"),
        ]);
        assert_eq!(first.digest(), second.digest());
        assert_eq!(first.digest().to_string().len(), 71);
        assert!(first.digest().to_string().starts_with("blake3:"));
    }

    #[test]
    fn generation_digest_binds_snapshot_paths_and_contents() {
        let first = generation(vec![snapshot("src/lib.rs", "same\n")]);
        let identical = generation(vec![snapshot("src/lib.rs", "same\n")]);
        let changed_contents = generation(vec![snapshot("src/lib.rs", "changed\n")]);
        let changed_path = generation(vec![snapshot("src/main.rs", "same\n")]);

        assert_eq!(first.digest(), identical.digest());
        assert_ne!(first.digest(), changed_contents.digest());
        assert_ne!(first.digest(), changed_path.digest());
    }

    #[test]
    fn pins_are_part_of_the_generation_digest() {
        let snapshots = vec![snapshot("src/lib.rs", "same\n")];
        let first = BaseGeneration::build(pins(), snapshots.clone()).unwrap();

        let mut changed_pins = pins();
        changed_pins.repository = pin("different-repository");
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(first.digest(), second.digest(), "repository pin");

        let mut changed_pins = pins();
        changed_pins.workspace = Some(pin("different-workspace"));
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(first.digest(), second.digest(), "workspace pin");

        let mut changed_pins = pins();
        changed_pins.workspace = None;
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(
            first.digest(),
            second.digest(),
            "workspace None vs Some pin"
        );

        let first_without_workspace = {
            let mut pins = pins();
            pins.workspace = None;
            BaseGeneration::build(pins, snapshots.clone()).unwrap()
        };
        assert_ne!(
            first_without_workspace.digest(),
            first.digest(),
            "workspace Some vs None pin"
        );

        let mut changed_pins = pins();
        changed_pins.revision_set = pin("different-revision-set");
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(first.digest(), second.digest(), "revision_set pin");

        let mut changed_pins = pins();
        changed_pins.read_scope = pin("different-read-scope");
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(first.digest(), second.digest(), "read_scope pin");

        let mut changed_pins = pins();
        changed_pins.read_policy = pin("different-policy");
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(first.digest(), second.digest(), "read_policy pin");

        let mut changed_pins = pins();
        changed_pins.source_receipt = pin("different-source-receipt");
        let second = BaseGeneration::build(changed_pins, snapshots.clone()).unwrap();
        assert_ne!(first.digest(), second.digest(), "source_receipt pin");

        let mut changed_pins = pins();
        changed_pins.parser_set = pin("different-parser-set");
        let second = BaseGeneration::build(changed_pins, snapshots).unwrap();
        assert_ne!(first.digest(), second.digest(), "parser_set pin");
    }

    #[test]
    fn path_validation_rejects_absolute_and_traversal_forms() {
        for invalid in [
            "",
            "/etc/passwd",
            "../secret",
            "src/../secret",
            "./file",
            "a//b",
            "C:/x",
            "a\\b",
            "a\nfile",
        ] {
            assert!(
                matches!(validate_path(invalid), Err(IndexError::InvalidPath(_))),
                "{invalid:?}"
            );
        }
        assert!(validate_path("src/module/file.rs").is_ok());
        assert!(validate_path("naïve/файл.rs").is_ok());
    }

    #[test]
    fn duplicate_paths_and_invalid_utf8_are_rejected() {
        assert!(matches!(
            BaseGeneration::build(
                pins(),
                vec![snapshot("a.txt", "first"), snapshot("a.txt", "second")]
            ),
            Err(IndexError::DuplicatePath(_))
        ));
        assert!(matches!(
            BaseGeneration::build(pins(), vec![FileSnapshot::new("a.txt", vec![0xff])]),
            Err(IndexError::InvalidUtf8 { .. })
        ));
    }

    #[test]
    fn query_results_are_bounded_and_report_result_truncation() {
        let base = generation(vec![snapshot("a.txt", "hit\nhit\nhit\n")]);
        let result = base.search("hit", 2).unwrap();
        assert_eq!(result.matches.len(), 2);
        assert_eq!(result.truncated_by, Some(SearchTruncation::ResultLimit));
        assert_eq!(result.matches[0].start_line, 1);
        assert_eq!(result.matches[1].start_line, 2);
        assert!(result.work_units <= MAX_QUERY_WORK_UNITS);
        assert!(result.next_cursor.is_some());
    }

    #[test]
    fn search_pages_are_stable_and_contiguous_in_path_line_order() {
        let base = generation(vec![
            snapshot("c.txt", "hit\n"),
            snapshot("b.txt", "hit\nhit\n"),
            snapshot("a.txt", "hit\nmiss\nhit\n"),
        ]);
        let expected = base.search("hit", MAX_QUERY_RESULTS).unwrap().matches;
        let first = base.search_page("hit", 2, None).unwrap();
        let first_cursor = first.next_cursor.clone().unwrap();
        let parsed_cursor = SearchCursor::parse(first_cursor.as_token()).unwrap();
        assert_eq!(parsed_cursor, first_cursor);
        assert_eq!(first.matches[0].path, "a.txt");
        assert_eq!(first.matches[0].start_line, 1);
        assert_eq!(first.matches[1].path, "a.txt");
        assert_eq!(first.matches[1].start_line, 3);
        assert_eq!(first.truncated_by, Some(SearchTruncation::ResultLimit));

        let second = base.search_page("hit", 2, Some(&parsed_cursor)).unwrap();
        assert_eq!(second.matches[0].path, "b.txt");
        assert_eq!(second.matches[0].start_line, 1);
        assert_eq!(second.matches[1].path, "b.txt");
        assert_eq!(second.matches[1].start_line, 2);
        let second_cursor = second.next_cursor.as_ref().unwrap();

        let third = base.search_page("hit", 2, Some(second_cursor)).unwrap();
        assert_eq!(third.matches.len(), 1);
        assert_eq!(third.matches[0].path, "c.txt");
        assert_eq!(third.matches[0].start_line, 1);
        assert_eq!(third.next_cursor, None);

        let mut paged = first.matches;
        paged.extend(second.matches);
        paged.extend(third.matches);
        assert_eq!(paged, expected);
    }

    #[test]
    fn search_continuation_allows_page_size_changes_without_skips_or_duplicates() {
        let base = generation(vec![
            snapshot("b.txt", "hit\nhit\n"),
            snapshot("a.txt", "hit\nhit\nhit\n"),
        ]);
        let expected = base.search("hit", MAX_QUERY_RESULTS).unwrap().matches;

        let first = base.search_page("hit", 2, None).unwrap();
        assert_eq!(first.matches.len(), 2);
        let first_cursor = first.next_cursor.as_ref().unwrap();

        let second = base.search_page("hit", 1, Some(first_cursor)).unwrap();
        assert_eq!(second.matches.len(), 1);
        let second_cursor = second.next_cursor.as_ref().unwrap();

        let third = base.search_page("hit", 2, Some(second_cursor)).unwrap();
        assert_eq!(third.matches.len(), 2);
        assert_eq!(third.next_cursor, None);

        let mut paged = first.matches;
        paged.extend(second.matches);
        paged.extend(third.matches);
        assert_eq!(paged, expected);
    }

    #[test]
    fn search_cursors_reject_malformed_and_oversized_tokens() {
        let base = generation(vec![snapshot("a.txt", "hit\nhit\n")]);
        let cursor = base
            .search_page("hit", 1, None)
            .unwrap()
            .next_cursor
            .unwrap();
        let mut corrupted = cursor.as_token().to_owned();
        let replacement = if corrupted.as_bytes()[3] == b'0' {
            "1"
        } else {
            "0"
        };
        corrupted.replace_range(3..4, replacement);

        assert!(matches!(
            SearchCursor::parse("not-a-cursor"),
            Err(IndexError::InvalidSearchCursor)
        ));
        assert!(matches!(
            SearchCursor::parse(&corrupted),
            Err(IndexError::InvalidSearchCursor)
        ));
        assert!(matches!(
            SearchCursor::parse(&"x".repeat(MAX_SEARCH_CURSOR_BYTES + 1)),
            Err(IndexError::InvalidSearchCursor)
        ));
        assert!(cursor.as_token().len() <= MAX_SEARCH_CURSOR_BYTES);
    }

    #[test]
    fn search_cursors_reject_other_queries_generations_and_overlays() {
        let base = generation(vec![snapshot("a.txt", "hit\nhit\n")]);
        let cursor = base
            .search_page("hit", 1, None)
            .unwrap()
            .next_cursor
            .unwrap();
        let other_generation = generation(vec![snapshot("a.txt", "hit\nchanged hit\n")]);

        assert!(matches!(
            base.search_page("different", 1, Some(&cursor)),
            Err(IndexError::CursorQueryMismatch)
        ));
        assert!(matches!(
            other_generation.search_page("hit", 1, Some(&cursor)),
            Err(IndexError::CursorGenerationMismatch)
        ));

        let first_overlay = BufferOverlay::build(
            &base,
            pin("editor-1"),
            vec![snapshot("a.txt", "hit\nhit\n")],
        )
        .unwrap();
        let second_overlay = BufferOverlay::build(
            &base,
            pin("editor-2"),
            vec![snapshot("a.txt", "hit\nhit\n")],
        )
        .unwrap();
        let overlay_cursor = base
            .search_page_with_overlay("hit", 1, Some(&first_overlay), None)
            .unwrap()
            .next_cursor
            .unwrap();
        assert!(matches!(
            base.search_page_with_overlay("hit", 1, Some(&second_overlay), Some(&overlay_cursor)),
            Err(IndexError::CursorOverlayMismatch)
        ));
        assert!(matches!(
            base.search_page("hit", 1, Some(&overlay_cursor)),
            Err(IndexError::CursorOverlayMismatch)
        ));
    }

    #[test]
    fn search_cursor_must_identify_a_matching_anchor() {
        let base = generation(vec![snapshot("a.txt", "hit\nhit\n")]);
        let cursor = SearchCursor::new(
            base.digest(),
            None,
            hash_query("hit"),
            CursorAnchor {
                path: "missing.txt".to_owned(),
                line: 1,
            },
        );

        assert!(matches!(
            base.search_page("hit", 1, Some(&cursor)),
            Err(IndexError::CursorAnchorNotFound)
        ));
    }

    #[test]
    fn query_work_is_bounded_and_reports_work_truncation() {
        let repeated = "a".repeat(MAX_FILE_BYTES);
        let base = generation(vec![
            FileSnapshot::new("a.txt", repeated.as_bytes().to_vec()),
            FileSnapshot::new("b.txt", repeated.as_bytes().to_vec()),
            FileSnapshot::new("c.txt", repeated.as_bytes().to_vec()),
            FileSnapshot::new("d.txt", repeated.as_bytes().to_vec()),
        ]);
        let result = base.search("z", 1).unwrap();
        assert_eq!(result.truncated_by, Some(SearchTruncation::WorkLimit));
        assert!(result.work_units <= MAX_QUERY_WORK_UNITS);
        assert_eq!(result.work_units, MAX_QUERY_WORK_UNITS);
    }

    #[test]
    fn search_continuation_fails_if_work_limit_precedes_cursor_anchor() {
        let repeated = "a".repeat(MAX_FILE_BYTES);
        let base = generation(vec![
            FileSnapshot::new("a.txt", repeated.as_bytes().to_vec()),
            FileSnapshot::new("b.txt", repeated.as_bytes().to_vec()),
            FileSnapshot::new("c.txt", repeated.as_bytes().to_vec()),
            FileSnapshot::new("d.txt", repeated.as_bytes().to_vec()),
            snapshot("z.txt", "hit\n"),
        ]);
        let cursor = SearchCursor::new(
            base.digest(),
            None,
            hash_query("hit"),
            CursorAnchor {
                path: "z.txt".to_owned(),
                line: 1,
            },
        );

        assert!(matches!(
            base.search_page("hit", 1, Some(&cursor)),
            Err(IndexError::CursorWorkLimit)
        ));
    }

    #[test]
    fn kmp_line_search_matches_naive_search_for_bounded_binary_inputs() {
        for text_length in 0..=6 {
            for text_bits in 0..(1_usize << text_length) {
                let text: Vec<u8> = (0..text_length)
                    .map(|index| b'a' + ((text_bits >> index) & 1) as u8)
                    .collect();
                for pattern_length in 1..=4 {
                    for pattern_bits in 0..(1_usize << pattern_length) {
                        let pattern: Vec<u8> = (0..pattern_length)
                            .map(|index| b'a' + ((pattern_bits >> index) & 1) as u8)
                            .collect();
                        let expected = text
                            .windows(pattern.len())
                            .any(|window| window == pattern.as_slice());
                        let mut work = WorkMeter::new(MAX_QUERY_WORK_UNITS);
                        let prefix = build_prefix_table(&pattern, &mut work).unwrap();

                        assert_eq!(
                            line_contains(&text, &pattern, &prefix, &mut work),
                            Some(expected),
                            "text={text:?}, pattern={pattern:?}"
                        );
                    }
                }
            }
        }
    }

    #[test]
    fn overlay_shadows_matching_paths_without_mutating_base() {
        let base = generation(vec![snapshot("src/lib.rs", "old token\nkeep\n")]);
        let base_digest = base.digest();
        let overlay = BufferOverlay::build(
            &base,
            pin("editor-version-42"),
            vec![snapshot("src/lib.rs", "new token\n")],
        )
        .unwrap();

        let base_result = base.search("old", 10).unwrap();
        let overlay_result = base.search_with_overlay("new", 10, Some(&overlay)).unwrap();
        let shadowed_result = base.search_with_overlay("old", 10, Some(&overlay)).unwrap();
        assert_eq!(base_result.matches.len(), 1);
        assert_eq!(overlay_result.matches.len(), 1);
        assert!(shadowed_result.matches.is_empty());
        assert_eq!(base.digest(), base_digest);
        assert_eq!(overlay_result.generation_digest, base_digest);
        assert_eq!(overlay_result.overlay_digest, Some(overlay.digest()));
        assert_eq!(
            overlay_result.editor_version,
            Some(pin("editor-version-42"))
        );
    }

    #[test]
    fn overlay_file_replacement_is_immutable_and_matches_full_snapshot_digest() {
        let base = generation(vec![
            snapshot("a.txt", "base a\n"),
            snapshot("b.txt", "base b\n"),
        ]);
        let original = BufferOverlay::build(
            &base,
            pin("editor-1"),
            vec![snapshot("a.txt", "edited a\n")],
        )
        .unwrap();
        let replaced = original
            .replace_file(&base, pin("editor-2"), snapshot("a.txt", "revised a\n"))
            .unwrap();
        let updated = replaced
            .replace_file(&base, pin("editor-2"), snapshot("b.txt", "edited b\n"))
            .unwrap();
        let rebuilt = BufferOverlay::build(
            &base,
            pin("editor-2"),
            vec![
                snapshot("a.txt", "revised a\n"),
                snapshot("b.txt", "edited b\n"),
            ],
        )
        .unwrap();

        assert_eq!(updated.digest(), rebuilt.digest());
        assert_eq!(updated.file_count(), 2);
        assert_eq!(updated.content_bytes(), "revised a\nedited b\n".len());
        assert_eq!(updated.editor_version(), &pin("editor-2"));
        assert_eq!(
            base.search_with_overlay("edited b", 10, Some(&updated))
                .unwrap()
                .matches
                .len(),
            1
        );
        assert!(base
            .search_with_overlay("edited a", 10, Some(&updated))
            .unwrap()
            .matches
            .is_empty());
        assert_eq!(
            base.search_with_overlay("edited a", 10, Some(&original))
                .unwrap()
                .matches
                .len(),
            1
        );
        assert!(base
            .search_with_overlay("edited b", 10, Some(&original))
            .unwrap()
            .matches
            .is_empty());
    }

    #[test]
    fn clearing_overlay_file_restores_base_and_keeps_previous_overlay_immutable() {
        let base = generation(vec![
            snapshot("a.txt", "base a\n"),
            snapshot("b.txt", "base b\n"),
        ]);
        let original = BufferOverlay::build(
            &base,
            pin("editor-1"),
            vec![
                snapshot("a.txt", "edited a\n"),
                snapshot("b.txt", "edited b\n"),
            ],
        )
        .unwrap();
        let updated = original
            .clear_file(&base, pin("editor-2"), "a.txt")
            .unwrap();

        assert_eq!(updated.file_count(), 1);
        assert_eq!(updated.content_bytes(), "edited b\n".len());
        assert_eq!(
            base.search_with_overlay("base a", 10, Some(&updated))
                .unwrap()
                .matches
                .len(),
            1
        );
        assert!(base
            .search_with_overlay("edited a", 10, Some(&updated))
            .unwrap()
            .matches
            .is_empty());
        assert_eq!(
            base.search_with_overlay("edited a", 10, Some(&original))
                .unwrap()
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn overlay_batch_is_immutable_order_independent_and_matches_full_snapshot_digest() {
        let base = generation(vec![
            snapshot("a.txt", "base a\n"),
            snapshot("b.txt", "base b\n"),
            snapshot("c.txt", "base c\n"),
        ]);
        let original = BufferOverlay::build(
            &base,
            pin("editor-1"),
            vec![snapshot("a.txt", "old a\n"), snapshot("b.txt", "old b\n")],
        )
        .unwrap();
        let changes = vec![
            OverlayChange::Replace(snapshot("a.txt", "new a\n")),
            OverlayChange::Clear {
                path: "b.txt".to_owned(),
            },
            OverlayChange::Replace(snapshot("c.txt", "new c\n")),
        ];
        let updated = original
            .apply_changes(&base, pin("editor-2"), changes)
            .unwrap();
        let reversed = original
            .apply_changes(
                &base,
                pin("editor-2"),
                vec![
                    OverlayChange::Replace(snapshot("c.txt", "new c\n")),
                    OverlayChange::Clear {
                        path: "b.txt".to_owned(),
                    },
                    OverlayChange::Replace(snapshot("a.txt", "new a\n")),
                ],
            )
            .unwrap();
        let rebuilt = BufferOverlay::build(
            &base,
            pin("editor-2"),
            vec![snapshot("a.txt", "new a\n"), snapshot("c.txt", "new c\n")],
        )
        .unwrap();

        assert_eq!(updated.digest(), rebuilt.digest());
        assert_eq!(updated.digest(), reversed.digest());
        assert_eq!(updated.file_count(), 2);
        assert_eq!(updated.content_bytes(), "new a\nnew c\n".len());
        assert_eq!(updated.editor_version(), &pin("editor-2"));
        assert_eq!(
            base.search_with_overlay("base b", 10, Some(&updated))
                .unwrap()
                .matches
                .len(),
            1
        );
        assert!(base
            .search_with_overlay("old a", 10, Some(&updated))
            .unwrap()
            .matches
            .is_empty());
        assert_eq!(
            base.search_with_overlay("old a", 10, Some(&original))
                .unwrap()
                .matches
                .len(),
            1
        );
    }

    #[test]
    fn failed_overlay_batch_leaves_original_overlay_unchanged() {
        let base = generation(vec![
            snapshot("a.txt", "base a\n"),
            snapshot("b.txt", "base b\n"),
            snapshot("c.txt", "base c\n"),
        ]);
        let original =
            BufferOverlay::build(&base, pin("editor-1"), vec![snapshot("a.txt", "old a\n")])
                .unwrap();
        let digest = original.digest();
        let result = original.apply_changes(
            &base,
            pin("editor-2"),
            vec![
                OverlayChange::Replace(snapshot("a.txt", "new a\n")),
                OverlayChange::Clear {
                    path: "b.txt".to_owned(),
                },
                OverlayChange::Replace(FileSnapshot::new("c.txt", vec![0xff])),
            ],
        );

        assert!(matches!(result, Err(IndexError::InvalidUtf8 { .. })));
        assert_eq!(original.digest(), digest);
        assert_eq!(original.file_count(), 1);
        assert_eq!(original.content_bytes(), "old a\n".len());
        assert_eq!(original.editor_version(), &pin("editor-1"));
        assert_eq!(
            base.search_with_overlay("old a", 10, Some(&original))
                .unwrap()
                .matches
                .len(),
            1
        );
        assert!(base
            .search_with_overlay("new a", 10, Some(&original))
            .unwrap()
            .matches
            .is_empty());
        assert!(matches!(
            original.apply_changes(
                &base,
                pin("editor-2"),
                vec![
                    OverlayChange::Clear {
                        path: "b.txt".to_owned(),
                    },
                    OverlayChange::Replace(snapshot("b.txt", "duplicate\n")),
                ],
            ),
            Err(IndexError::DuplicateOverlayChange(path)) if path == "b.txt"
        ));
    }

    #[test]
    fn overlay_batches_enforce_change_and_final_content_limits() {
        let count_base = BaseGeneration::build(
            pins(),
            (0..=MAX_OVERLAY_CHANGES)
                .map(|index| FileSnapshot::new(format!("entry-{index}.txt"), b"base".to_vec())),
        )
        .unwrap();
        let empty = BufferOverlay::build(&count_base, pin("editor-1"), Vec::new()).unwrap();
        let too_many_changes = empty.apply_changes(
            &count_base,
            pin("editor-2"),
            (0..=MAX_OVERLAY_CHANGES).map(|index| OverlayChange::Clear {
                path: format!("entry-{index}.txt"),
            }),
        );
        assert!(matches!(
            too_many_changes,
            Err(IndexError::TooManyOverlayChanges { .. })
        ));
        assert_eq!(empty.file_count(), 0);
        assert_eq!(empty.editor_version(), &pin("editor-1"));

        let large_base = BaseGeneration::build(
            pins(),
            (0..9).map(|index| FileSnapshot::new(format!("file-{index}.txt"), vec![b'x'; 950_000])),
        )
        .unwrap();
        let large_overlay = BufferOverlay::build(
            &large_base,
            pin("editor-large"),
            (0..8).map(|index| FileSnapshot::new(format!("file-{index}.txt"), vec![b'y'; 950_000])),
        )
        .unwrap();
        let digest = large_overlay.digest();
        assert!(matches!(
            large_overlay.apply_changes(
                &large_base,
                pin("editor-too-large"),
                vec![OverlayChange::Replace(FileSnapshot::new(
                    "file-8.txt",
                    vec![b'z'; 950_000],
                ))],
            ),
            Err(IndexError::OverlayContentLimit { .. })
        ));
        assert_eq!(large_overlay.digest(), digest);
        assert_eq!(large_overlay.content_bytes(), 8 * 950_000);
    }

    #[test]
    fn overlay_updates_reject_other_bases_and_enforce_aggregate_limits() {
        let base = generation(vec![snapshot("a.txt", "base\n")]);
        let other_base = generation(vec![snapshot("a.txt", "other base\n")]);
        let overlay = BufferOverlay::build(&base, pin("editor-1"), Vec::new()).unwrap();
        assert!(matches!(
            overlay.replace_file(&other_base, pin("editor-2"), snapshot("a.txt", "edit\n")),
            Err(IndexError::OverlayGenerationMismatch { .. })
        ));

        let snapshots: Vec<_> = (0..9)
            .map(|index| FileSnapshot::new(format!("file-{index}.txt"), vec![b'x'; 950_000]))
            .collect();
        let large_base = BaseGeneration::build(pins(), snapshots).unwrap();
        let large_overlay = BufferOverlay::build(
            &large_base,
            pin("editor-large"),
            (0..8).map(|index| FileSnapshot::new(format!("file-{index}.txt"), vec![b'y'; 950_000])),
        )
        .unwrap();
        assert!(matches!(
            large_overlay.replace_file(
                &large_base,
                pin("editor-too-large"),
                FileSnapshot::new("file-8.txt", vec![b'z'; 950_000]),
            ),
            Err(IndexError::OverlayContentLimit { .. })
        ));

        let count_base = BaseGeneration::build(
            pins(),
            (0..=MAX_OVERLAY_FILES)
                .map(|index| FileSnapshot::new(format!("entry-{index}.txt"), b"base".to_vec())),
        )
        .unwrap();
        let full_overlay = BufferOverlay::build(
            &count_base,
            pin("editor-full"),
            (0..MAX_OVERLAY_FILES)
                .map(|index| FileSnapshot::new(format!("entry-{index}.txt"), b"edit".to_vec())),
        )
        .unwrap();
        assert!(matches!(
            full_overlay.replace_file(
                &count_base,
                pin("editor-over-limit"),
                FileSnapshot::new(format!("entry-{MAX_OVERLAY_FILES}.txt"), b"edit".to_vec()),
            ),
            Err(IndexError::TooManyOverlayFiles { .. })
        ));
    }

    #[test]
    fn overlay_cannot_add_paths_or_bind_to_a_different_generation() {
        let base = generation(vec![snapshot("a.txt", "base\n")]);
        assert!(matches!(
            BufferOverlay::build(&base, pin("editor-1"), vec![snapshot("new.txt", "new\n")]),
            Err(IndexError::OverlayPathNotInBase(_))
        ));
        let overlay =
            BufferOverlay::build(&base, pin("editor-1"), vec![snapshot("a.txt", "edit\n")])
                .unwrap();
        let other = generation(vec![snapshot("a.txt", "different base\n")]);
        assert!(matches!(
            other.search_with_overlay("edit", 10, Some(&overlay)),
            Err(IndexError::OverlayGenerationMismatch { .. })
        ));
    }

    #[test]
    fn generations_and_queries_are_always_partial() {
        let base = generation(vec![snapshot("a.txt", "text\n")]);
        assert_eq!(base.status(), GenerationStatus::Partial);
        assert_eq!(
            base.capabilities(),
            IndexCapabilities {
                lexical: true,
                tree_sitter: false,
                lsp: false,
                scip: false,
                vector: false,
            }
        );
        let result = base.search("text", 10).unwrap();
        assert_eq!(result.status, QueryStatus::Partial);
        assert_eq!(result.generation_status, GenerationStatus::Partial);
    }

    #[test]
    fn initial_byte_and_query_limits_are_enforced() {
        assert!(matches!(
            BaseGeneration::build(
                pins(),
                vec![FileSnapshot::new(
                    "large.txt",
                    vec![b'x'; MAX_FILE_BYTES + 1]
                )]
            ),
            Err(IndexError::FileTooLarge { .. })
        ));
        let base = generation(vec![snapshot("a.txt", "text\n")]);
        assert!(matches!(base.search("", 10), Err(IndexError::EmptyQuery)));
        assert!(matches!(
            base.search(&"q".repeat(MAX_QUERY_BYTES + 1), 10),
            Err(IndexError::QueryTooLarge { .. })
        ));
        assert!(matches!(
            base.search("text", 0),
            Err(IndexError::InvalidResultLimit { .. })
        ));
    }
}
