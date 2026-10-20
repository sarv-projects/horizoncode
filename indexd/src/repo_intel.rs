use crate::{
    BaseGeneration, BufferOverlay, Digest, FileSnapshot, GenerationPins, GenerationStatus,
    IndexError, QueryResult, SearchCursor,
};

/// Supported RepoIntel query operations. Only bounded lexical text search is implemented.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoIntelOperation {
    Text,
    Symbol,
    References,
    Impact,
    Expand,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoIntelStatus {
    Partial,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RepoIntelUnavailableReason {
    UnsupportedOperation(RepoIntelOperation),
}

/// Immutable RepoIntel view over caller-provided snapshots and provenance pins.
///
/// The generation identity is exactly the underlying `BaseGeneration` digest, which
/// binds repository/workspace/revision/read-scope/read-policy/source-receipt/parser pins
/// and sorted file contents. This adapter does not acquire or authorize any of them.
#[derive(Clone)]
pub struct RepoIntelGeneration {
    base: BaseGeneration,
}

impl RepoIntelGeneration {
    pub fn build<I>(pins: GenerationPins, snapshots: I) -> Result<Self, IndexError>
    where
        I: IntoIterator<Item = FileSnapshot>,
    {
        Ok(Self {
            base: BaseGeneration::build(pins, snapshots)?,
        })
    }

    pub fn id(&self) -> Digest {
        self.base.digest()
    }

    /// Wrap an already-built immutable base generation without rebuilding or
    /// re-hashing it.
    ///
    /// The transport handler adopts a decoded [`crate::GenerationPack`] this way,
    /// so a served generation carries exactly the digest the host built.
    pub fn from_base(base: BaseGeneration) -> Self {
        Self { base }
    }

    pub fn status(&self) -> GenerationStatus {
        self.base.status()
    }

    /// Borrow the underlying index for overlay construction and low-level queries.
    pub fn base(&self) -> &BaseGeneration {
        &self.base
    }

    /// Run one generation-bound query without introducing a second search engine.
    pub fn query(&self, request: RepoIntelQuery) -> Result<RepoIntelQueryResult, IndexError> {
        if request.generation_id != self.id() {
            return Err(IndexError::GenerationMismatch {
                expected: self.id(),
                actual: request.generation_id,
            });
        }

        match request.operation {
            RepoIntelOperation::Text => {
                let result = self.base.search_page_with_overlay(
                    &request.query,
                    request.max_results,
                    request.overlay.as_ref(),
                    request.cursor.as_ref(),
                )?;
                Ok(RepoIntelQueryResult {
                    status: RepoIntelStatus::Partial,
                    generation_id: self.id(),
                    text: Some(result),
                    unavailable_reason: None,
                })
            }
            operation => Ok(RepoIntelQueryResult {
                status: RepoIntelStatus::Unavailable,
                generation_id: self.id(),
                text: None,
                unavailable_reason: Some(RepoIntelUnavailableReason::UnsupportedOperation(
                    operation,
                )),
            }),
        }
    }
}

/// Generation-scoped query inputs. `generation_id` is required to fence stale callers.
pub struct RepoIntelQuery {
    pub generation_id: Digest,
    pub operation: RepoIntelOperation,
    pub query: String,
    pub max_results: usize,
    pub overlay: Option<BufferOverlay>,
    pub cursor: Option<SearchCursor>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RepoIntelQueryResult {
    pub status: RepoIntelStatus,
    pub generation_id: Digest,
    pub text: Option<QueryResult>,
    pub unavailable_reason: Option<RepoIntelUnavailableReason>,
}
