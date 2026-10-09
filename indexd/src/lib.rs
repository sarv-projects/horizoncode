#![doc = include_str!("README.md")]

use std::collections::BTreeMap;
use std::error::Error;
use std::fmt;

pub const MAX_BASE_FILES: usize = 4_096;
pub const MAX_FILE_BYTES: usize = 1_048_576;
pub const MAX_BASE_CONTENT_BYTES: usize = 67_108_864;
pub const MAX_BASE_PATH_BYTES: usize = 4_194_304;
pub const MAX_OVERLAY_FILES: usize = 128;
pub const MAX_OVERLAY_CONTENT_BYTES: usize = 8_388_608;
pub const MAX_PATH_BYTES: usize = 1_024;
pub const MAX_PIN_BYTES: usize = 4_096;
pub const MAX_QUERY_BYTES: usize = 256;
pub const MAX_QUERY_RESULTS: usize = 100;
pub const MAX_QUERY_WORK_UNITS: usize = 4_194_304;

const BASE_DOMAIN: &[u8] = b"horizon.indexd.base-generation.v1\0";
const FILE_DOMAIN: &[u8] = b"horizon.indexd.file-content.v1\0";
const OVERLAY_DOMAIN: &[u8] = b"horizon.indexd.buffer-overlay.v1\0";

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
        self.search_with_overlay(query, max_results, None)
    }

    /// Search using an optional exact-generation unsaved-buffer overlay.
    pub fn search_with_overlay(
        &self,
        query: &str,
        max_results: usize,
        overlay: Option<&BufferOverlay>,
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

        let pattern = query.as_bytes();
        let mut work = WorkMeter::new(MAX_QUERY_WORK_UNITS);
        let prefix = match build_prefix_table(pattern, &mut work) {
            Some(prefix) => prefix,
            None => {
                return Ok(QueryResult::new(
                    self.generation_digest,
                    overlay,
                    Vec::new(),
                    work.used,
                    Some(SearchTruncation::WorkLimit),
                ));
            }
        };
        let mut matches = Vec::new();
        let mut truncated_by = None;

        for (path, base_file) in &self.files {
            let contents = overlay
                .and_then(|candidate| candidate.files.get(path))
                .map(|file| file.contents.as_str())
                .unwrap_or(base_file.contents.as_str());

            match search_file(
                path,
                contents,
                pattern,
                &prefix,
                &mut work,
                max_results,
                &mut matches,
            ) {
                FileSearchOutcome::Complete => {}
                FileSearchOutcome::ResultLimit => {
                    truncated_by = Some(SearchTruncation::ResultLimit);
                    break;
                }
                FileSearchOutcome::WorkLimit => {
                    truncated_by = Some(SearchTruncation::WorkLimit);
                    break;
                }
            }
        }

        Ok(QueryResult::new(
            self.generation_digest,
            overlay,
            matches,
            work.used,
            truncated_by,
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
}

impl fmt::Debug for BufferOverlay {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BufferOverlay")
            .field("base_generation_digest", &self.base_generation_digest)
            .field("overlay_digest", &self.overlay_digest)
            .field("file_count", &self.files.len())
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
        })
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
    ) -> Self {
        Self {
            status: QueryStatus::Partial,
            generation_status: GenerationStatus::Partial,
            generation_digest,
            overlay_digest: overlay.map(BufferOverlay::digest),
            editor_version: overlay.map(|candidate| candidate.editor_version.clone()),
            matches,
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
    OverlayContentLimit { limit: usize },
    OverlayPathNotInBase(String),
    EmptyQuery,
    QueryTooLarge { limit: usize },
    MultilineQuery,
    InvalidResultLimit { limit: usize },
    OverlayGenerationMismatch { expected: Digest, actual: Digest },
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
}

fn search_file(
    path: &str,
    contents: &str,
    pattern: &[u8],
    prefix: &[usize],
    work: &mut WorkMeter,
    max_results: usize,
    matches: &mut Vec<SearchMatch>,
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
                if matches.len() == max_results {
                    return FileSearchOutcome::ResultLimit;
                }
                matches.push(SearchMatch {
                    path: path.to_owned(),
                    start_line: line_number,
                    end_line: line_number,
                });
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
    fn pins_are_part_of_the_generation_digest() {
        let first = generation(vec![snapshot("src/lib.rs", "same\n")]);
        let mut changed_pins = pins();
        changed_pins.read_policy = pin("different-policy");
        let second =
            BaseGeneration::build(changed_pins, vec![snapshot("src/lib.rs", "same\n")]).unwrap();
        assert_ne!(first.digest(), second.digest());
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
