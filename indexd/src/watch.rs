//! Pure watcher-invalidation classification over immutable base generations.
//!
//! A host watcher observes filesystem changes and decides, without guessing,
//! whether an immutable generation remains reusable or must be rebuilt. Editor
//! buffers are a separate input and cannot be inferred from filesystem events.
//! This module performs classification and event coalescing deterministically
//! and within fixed bounds.
//!
//! This module performs no OS filesystem watching, background scheduling or overlay
//! construction. Its bounded event coalescer and lifecycle fence accept caller-fed
//! watcher events; the integrating owner remains responsible for OS watcher
//! supervision, source reads, read-scope authorization and replacement bytes.

use crate::{validate_path, BaseGeneration, Digest, IndexError, MAX_BASE_PATH_BYTES};
use std::collections::BTreeMap;

/// Maximum changes in one watcher batch.
pub const MAX_WATCH_CHANGES: usize = 256;
pub const DEFAULT_WATCH_DEBOUNCE_MS: u64 = 75;
pub const MAX_WATCH_DEBOUNCE_MS: u64 = 10_000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WatchChangeKind {
    Added,
    Modified,
    Removed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchChange {
    pub path: String,
    pub kind: WatchChangeKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WatchBatch {
    Changes(Vec<WatchChange>),
    /// More unique paths changed than can be represented in one bounded batch.
    /// The owner must perform a bounded full source rescan before reusing a base.
    FullRescanRequired,
}

/// Bounded event coalescer. It owns no OS watcher and starts no background work;
/// the host watcher feeds events and polls `take_due` on its supervised lifecycle.
pub struct WatchBatcher {
    debounce_ms: u64,
    deadline_ms: Option<u64>,
    changes: BTreeMap<String, WatchChangeKind>,
    overflowed: bool,
}

impl WatchBatcher {
    pub fn new(debounce_ms: u64) -> Self {
        Self {
            debounce_ms: debounce_ms.clamp(1, MAX_WATCH_DEBOUNCE_MS),
            deadline_ms: None,
            changes: BTreeMap::new(),
            overflowed: false,
        }
    }

    pub fn push(&mut self, now_ms: u64, change: WatchChange) -> Result<(), IndexError> {
        validate_path(&change.path)?;
        self.deadline_ms = Some(now_ms.saturating_add(self.debounce_ms));
        if self.overflowed {
            return Ok(());
        }
        if let Some(previous) = self.changes.get(&change.path).copied() {
            match coalesce_change(previous, change.kind) {
                Some(kind) => {
                    self.changes.insert(change.path, kind);
                }
                None => {
                    self.changes.remove(&change.path);
                }
            }
            return Ok(());
        }
        if self.changes.len() >= MAX_WATCH_CHANGES {
            self.changes.clear();
            self.overflowed = true;
            return Ok(());
        }
        self.changes.insert(change.path, change.kind);
        Ok(())
    }

    pub fn take_due(&mut self, now_ms: u64) -> Option<WatchBatch> {
        if self.deadline_ms.map_or(true, |deadline| now_ms < deadline) {
            return None;
        }
        self.deadline_ms = None;
        if std::mem::take(&mut self.overflowed) {
            self.changes.clear();
            return Some(WatchBatch::FullRescanRequired);
        }
        let changes = std::mem::take(&mut self.changes)
            .into_iter()
            .map(|(path, kind)| WatchChange { path, kind })
            .collect();
        Some(WatchBatch::Changes(changes))
    }

    pub fn is_empty(&self) -> bool {
        self.deadline_ms.is_none() && self.changes.is_empty() && !self.overflowed
    }
}

impl Default for WatchBatcher {
    fn default() -> Self {
        Self::new(DEFAULT_WATCH_DEBOUNCE_MS)
    }
}

fn coalesce_change(previous: WatchChangeKind, next: WatchChangeKind) -> Option<WatchChangeKind> {
    use WatchChangeKind::{Added, Modified, Removed};
    match (previous, next) {
        // Watcher create/remove sequences can be ambiguous (for example, atomic
        // replacement); retain an invalidating event instead of assuming no-op.
        (Added, Removed) => Some(Removed),
        (Added, _) => Some(Added),
        (Removed, Added | Modified) => Some(Modified),
        (Removed, Removed) => Some(Removed),
        (Modified, Removed) => Some(Removed),
        (Modified, Added | Modified) => Some(Modified),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleState {
    Absent,
    Building,
    Current,
    Stale,
    Partial,
    Failed,
    Retired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LifecycleBuildTicket {
    epoch: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LifecycleError {
    EpochExhausted,
    BuildAlreadyRunning,
    BuildRequiresInvalidation,
    Retired,
}

/// Source-generation fence for a single owner's background build lifecycle.
/// Old builds cannot publish after an invalidation or retirement.
pub struct GenerationLifecycle {
    epoch: u64,
    state: LifecycleState,
    digest: Option<Digest>,
}

impl Default for GenerationLifecycle {
    fn default() -> Self {
        Self {
            epoch: 0,
            state: LifecycleState::Absent,
            digest: None,
        }
    }
}

impl GenerationLifecycle {
    pub fn state(&self) -> LifecycleState {
        self.state
    }
    pub fn epoch(&self) -> u64 {
        self.epoch
    }

    pub fn begin_build(&mut self) -> Result<LifecycleBuildTicket, LifecycleError> {
        if self.state == LifecycleState::Retired {
            return Err(LifecycleError::Retired);
        }
        if self.state == LifecycleState::Building {
            return Err(LifecycleError::BuildAlreadyRunning);
        }
        if matches!(
            self.state,
            LifecycleState::Current | LifecycleState::Partial
        ) {
            return Err(LifecycleError::BuildRequiresInvalidation);
        }
        self.state = LifecycleState::Building;
        self.digest = None;
        Ok(LifecycleBuildTicket { epoch: self.epoch })
    }

    pub fn complete(
        &mut self,
        ticket: LifecycleBuildTicket,
        digest: Digest,
        complete: bool,
    ) -> bool {
        if ticket.epoch != self.epoch || self.state != LifecycleState::Building {
            return false;
        }
        self.digest = Some(digest);
        self.state = if complete {
            LifecycleState::Current
        } else {
            LifecycleState::Partial
        };
        true
    }

    pub fn fail(&mut self, ticket: LifecycleBuildTicket) -> bool {
        if ticket.epoch != self.epoch || self.state != LifecycleState::Building {
            return false;
        }
        self.digest = None;
        self.state = LifecycleState::Failed;
        true
    }

    pub fn invalidate(&mut self) -> Result<u64, LifecycleError> {
        if self.state == LifecycleState::Retired {
            return Err(LifecycleError::Retired);
        }
        self.epoch = match self.epoch.checked_add(1) {
            Some(epoch) => epoch,
            None => {
                self.digest = None;
                self.state = LifecycleState::Retired;
                return Err(LifecycleError::EpochExhausted);
            }
        };
        self.digest = None;
        self.state = LifecycleState::Stale;
        Ok(self.epoch)
    }

    pub fn retire(&mut self) -> Result<u64, LifecycleError> {
        if self.state != LifecycleState::Retired {
            self.digest = None;
            self.state = LifecycleState::Retired;
            self.epoch = self
                .epoch
                .checked_add(1)
                .ok_or(LifecycleError::EpochExhausted)?;
        }
        Ok(self.epoch)
    }

    pub fn serves(&self, digest: Digest) -> bool {
        matches!(
            self.state,
            LifecycleState::Current | LifecycleState::Partial
        ) && self.digest == Some(digest)
    }
}

/// The reuse decision for one classified watcher batch.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WatchDecision {
    /// No observed changes: the generation remains reusable.
    Reusable,
    /// Any filesystem change makes this immutable base stale and requires a
    /// rebuild. Unsaved editor buffers use the separate overlay API.
    RebuildRequired,
}

/// A bounded, deterministic classification bound to one exact base generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WatchClassification {
    /// The generation this classification was computed against.
    pub base_generation_digest: Digest,
    pub decision: WatchDecision,
    /// Sorted modified paths that exist in the base and must be re-read.
    pub modified_paths: Vec<String>,
    /// Sorted added paths that are not in the base.
    pub added_paths: Vec<String>,
    /// Sorted removed paths that exist in the base.
    pub removed_paths: Vec<String>,
    /// Sorted changes inconsistent with the base (an added path already present,
    /// or a removed/modified path absent). These always force a rebuild.
    pub unexpected_paths: Vec<String>,
}

impl WatchClassification {
    /// Classify one bounded change batch against one base generation.
    ///
    /// Duplicate paths in a batch are rejected: a watcher batch must describe at
    /// most one final change per path. Paths are validated with the same
    /// normalized-relative-path rule as snapshots. The result is sorted, so the
    /// same set of changes classifies identically regardless of input order.
    pub fn classify(base: &BaseGeneration, changes: &[WatchChange]) -> Result<Self, IndexError> {
        if changes.len() > MAX_WATCH_CHANGES {
            return Err(IndexError::TooManyWatchChanges {
                limit: MAX_WATCH_CHANGES,
            });
        }

        let mut modified_paths = Vec::new();
        let mut added_paths = Vec::new();
        let mut removed_paths = Vec::new();
        let mut unexpected_paths = Vec::new();
        let mut seen: Vec<&str> = Vec::with_capacity(changes.len());
        let mut path_bytes = 0usize;

        for change in changes {
            validate_path(&change.path)?;
            if seen.contains(&change.path.as_str()) {
                return Err(IndexError::DuplicateWatchChange(change.path.clone()));
            }
            seen.push(change.path.as_str());
            path_bytes = path_bytes
                .checked_add(change.path.len())
                .filter(|total| *total <= MAX_BASE_PATH_BYTES)
                .ok_or(IndexError::BasePathLimit {
                    limit: MAX_BASE_PATH_BYTES,
                })?;

            let in_base = base.files.contains_key(&change.path);
            match change.kind {
                WatchChangeKind::Modified if in_base => modified_paths.push(change.path.clone()),
                WatchChangeKind::Modified => unexpected_paths.push(change.path.clone()),
                WatchChangeKind::Added if !in_base => added_paths.push(change.path.clone()),
                WatchChangeKind::Added => unexpected_paths.push(change.path.clone()),
                WatchChangeKind::Removed if in_base => removed_paths.push(change.path.clone()),
                WatchChangeKind::Removed => unexpected_paths.push(change.path.clone()),
            }
        }

        modified_paths.sort();
        added_paths.sort();
        removed_paths.sort();
        unexpected_paths.sort();

        let decision = if changes.is_empty() {
            WatchDecision::Reusable
        } else {
            WatchDecision::RebuildRequired
        };

        Ok(Self {
            base_generation_digest: base.digest(),
            decision,
            modified_paths,
            added_paths,
            removed_paths,
            unexpected_paths,
        })
    }

    pub fn is_reusable(&self) -> bool {
        self.decision == WatchDecision::Reusable
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FileSnapshot, GenerationPins, OpaquePin};

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

    fn generation() -> BaseGeneration {
        BaseGeneration::build(
            pins(),
            vec![
                FileSnapshot::new("src/a.rs", b"fn a() {}\n".to_vec()),
                FileSnapshot::new("src/b.rs", b"fn b() {}\n".to_vec()),
            ],
        )
        .expect("generation")
    }

    fn change(path: &str, kind: WatchChangeKind) -> WatchChange {
        WatchChange {
            path: path.to_owned(),
            kind,
        }
    }

    #[test]
    fn empty_batch_is_reusable_and_digest_bound() {
        let base = generation();
        let classification = WatchClassification::classify(&base, &[]).expect("classify");
        assert!(classification.is_reusable());
        assert_eq!(classification.decision, WatchDecision::Reusable);
        assert_eq!(classification.base_generation_digest, base.digest());
    }

    #[test]
    fn base_modification_invalidates_the_generation() {
        let base = generation();
        let classification =
            WatchClassification::classify(&base, &[change("src/a.rs", WatchChangeKind::Modified)])
                .expect("classify");
        assert_eq!(classification.decision, WatchDecision::RebuildRequired);
        assert_eq!(classification.modified_paths, vec!["src/a.rs".to_owned()]);
        assert!(classification.added_paths.is_empty());
        assert!(classification.removed_paths.is_empty());
        assert!(classification.unexpected_paths.is_empty());
    }

    #[test]
    fn addition_removal_and_mix_require_rebuild() {
        let base = generation();
        let added =
            WatchClassification::classify(&base, &[change("src/c.rs", WatchChangeKind::Added)])
                .expect("classify");
        assert_eq!(added.decision, WatchDecision::RebuildRequired);
        assert_eq!(added.added_paths, vec!["src/c.rs".to_owned()]);

        let removed =
            WatchClassification::classify(&base, &[change("src/b.rs", WatchChangeKind::Removed)])
                .expect("classify");
        assert_eq!(removed.decision, WatchDecision::RebuildRequired);
        assert_eq!(removed.removed_paths, vec!["src/b.rs".to_owned()]);

        let mixed = WatchClassification::classify(
            &base,
            &[
                change("src/a.rs", WatchChangeKind::Modified),
                change("src/c.rs", WatchChangeKind::Added),
            ],
        )
        .expect("classify");
        assert_eq!(mixed.decision, WatchDecision::RebuildRequired);
        assert_eq!(mixed.modified_paths, vec!["src/a.rs".to_owned()]);
        assert_eq!(mixed.added_paths, vec!["src/c.rs".to_owned()]);
    }

    #[test]
    fn inconsistent_changes_are_flagged_not_silently_reused() {
        let base = generation();
        let classification = WatchClassification::classify(
            &base,
            &[
                change("src/a.rs", WatchChangeKind::Added),
                change("src/missing.rs", WatchChangeKind::Removed),
                change("src/other.rs", WatchChangeKind::Modified),
            ],
        )
        .expect("classify");
        assert_eq!(classification.decision, WatchDecision::RebuildRequired);
        assert_eq!(
            classification.unexpected_paths,
            vec![
                "src/a.rs".to_owned(),
                "src/missing.rs".to_owned(),
                "src/other.rs".to_owned(),
            ]
        );
        assert!(classification.modified_paths.is_empty());
        assert!(classification.added_paths.is_empty());
        assert!(classification.removed_paths.is_empty());
    }

    #[test]
    fn duplicate_change_paths_are_rejected() {
        let base = generation();
        let error = WatchClassification::classify(
            &base,
            &[
                change("src/a.rs", WatchChangeKind::Modified),
                change("src/a.rs", WatchChangeKind::Removed),
            ],
        )
        .expect_err("duplicate must fail");
        assert_eq!(
            error,
            IndexError::DuplicateWatchChange("src/a.rs".to_owned())
        );
    }

    #[test]
    fn invalid_and_oversized_batches_are_rejected() {
        let base = generation();
        let invalid =
            WatchClassification::classify(&base, &[change("../escape", WatchChangeKind::Added)])
                .expect_err("invalid path must fail");
        assert!(matches!(invalid, IndexError::InvalidPath(_)));

        let batch: Vec<WatchChange> = (0..=MAX_WATCH_CHANGES)
            .map(|index| change(&format!("src/f{index}.rs"), WatchChangeKind::Added))
            .collect();
        let too_many =
            WatchClassification::classify(&base, &batch).expect_err("oversized batch must fail");
        assert_eq!(
            too_many,
            IndexError::TooManyWatchChanges {
                limit: MAX_WATCH_CHANGES
            }
        );
    }

    #[test]
    fn classification_is_order_independent() {
        let base = generation();
        let forward = WatchClassification::classify(
            &base,
            &[
                change("src/b.rs", WatchChangeKind::Modified),
                change("src/a.rs", WatchChangeKind::Modified),
            ],
        )
        .expect("classify");
        let reverse = WatchClassification::classify(
            &base,
            &[
                change("src/a.rs", WatchChangeKind::Modified),
                change("src/b.rs", WatchChangeKind::Modified),
            ],
        )
        .expect("classify");
        assert_eq!(forward, reverse);
    }

    #[test]
    fn lifecycle_refuses_duplicate_build_and_retires_if_epoch_cannot_advance() {
        let mut lifecycle = GenerationLifecycle::default();
        let ticket = lifecycle.begin_build().unwrap();
        assert_eq!(
            lifecycle.begin_build().unwrap_err(),
            LifecycleError::BuildAlreadyRunning
        );
        lifecycle.epoch = u64::MAX;
        assert_eq!(
            lifecycle.invalidate().unwrap_err(),
            LifecycleError::EpochExhausted
        );
        assert_eq!(lifecycle.state(), LifecycleState::Retired);
        assert!(!lifecycle.complete(ticket, generation().digest(), true));
    }
}
