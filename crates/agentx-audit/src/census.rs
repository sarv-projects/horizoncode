//! The coverage census (`REQ-AUDIT-001`, `REQ-AUDIT-005`).
//!
//! `REQ-AUDIT-001` — every declared security-relevant effect class appends
//! exactly one entry — is only meaningful if coverage is *checkable*. The
//! census turns it into a deliverable:
//!
//! - the declared registry is [`EffectClass::ALL`], seeded from the
//!   architecture's "What is recorded" table;
//! - the census maps every declared class to at least one recorded entry over a
//!   bounded window and reports per-class counts;
//! - **any uncovered declared class fails loudly**, and so does **any recorded
//!   effect that is not a declared class**.
//!
//! What the census proves: every declared class is represented in the window.
//! What it does not prove: that no undeclared class exists — the registry is
//! reviewed as part of the security boundary.

use std::fmt;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::entry::{EffectClass, EntryKind};
use crate::error::AuditError;
use crate::store::{AuditConfig, read_segment_lines, segment_indices};

/// One stored line, read as raw text.
///
/// The census deliberately does **not** deserialize an entry: an effect class
/// that is not declared must be *countable* for the census to fail on it, and a
/// record that does not verify must still be census-able, because coverage and
/// integrity are separate deliverables (`REQ-AUDIT-001` vs `REQ-AUDIT-002`).
#[derive(Clone, Debug, Deserialize)]
struct RawEntryLine {
    seq: u64,
    #[serde(default)]
    session: Option<String>,
    kind: String,
}

/// The census window.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
pub struct CensusWindow {
    /// Only entries with `seq >= from` are counted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub from: Option<u64>,
    /// Only entries with `seq <= to` are counted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub to: Option<u64>,
    /// Only entries for this session are counted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// Only these segments are counted.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub segments: Option<Vec<u32>>,
}

impl CensusWindow {
    /// The whole store.
    #[must_use]
    pub fn all() -> Self {
        Self::default()
    }

    /// Restricts the census to one session.
    #[must_use]
    pub fn for_session(session: impl Into<String>) -> Self {
        Self {
            session: Some(session.into()),
            ..Self::default()
        }
    }

    /// Restricts the census to a sequence range.
    #[must_use]
    pub fn between(from: Option<u64>, to: Option<u64>) -> Self {
        Self {
            from,
            to,
            ..Self::default()
        }
    }

    /// Restricts the census to an explicit segment set.
    #[must_use]
    pub fn for_segments(segments: Vec<u32>) -> Self {
        Self {
            segments: Some(segments),
            ..Self::default()
        }
    }

    fn contains(&self, entry: &RawEntryLine, segment: u32) -> bool {
        self.from.is_none_or(|from| entry.seq >= from)
            && self.to.is_none_or(|to| entry.seq <= to)
            && self
                .session
                .as_ref()
                .is_none_or(|session| entry.session.as_deref() == Some(session.as_str()))
            && self
                .segments
                .as_ref()
                .is_none_or(|segments| segments.contains(&segment))
    }
}

/// Per-class coverage evidence.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct ClassCensus {
    /// The declared class.
    pub class: EffectClass,
    /// The entry kinds that map to it.
    pub kinds: Vec<EntryKind>,
    /// How many entries of this class were recorded in the window.
    pub count: u64,
    /// The first audit `seq` evidencing it, when covered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub first_seq: Option<u64>,
    /// The last audit `seq` evidencing it, when covered.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_seq: Option<u64>,
}

/// The generated census evidence artifact.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct CensusReport {
    /// The window examined.
    pub window: CensusWindow,
    /// How many entries were examined.
    pub entries_examined: u64,
    /// How many segments were examined.
    pub segments_examined: u64,
    /// Per-class coverage.
    pub classes: Vec<ClassCensus>,
    /// Declared classes with no recorded entry. Non-empty means the census
    /// fails.
    pub uncovered: Vec<EffectClass>,
    /// Recorded entry kinds that are not a declared class. Non-empty means the
    /// census fails.
    pub unregistered: Vec<String>,
    /// The anchoring level the record is held at.
    pub level: crate::entry::AnchorLevelName,
    /// What the artifact does and does not establish.
    pub proves: Vec<String>,
    pub does_not_prove: Vec<String>,
}

impl CensusReport {
    /// Returns whether the census passes.
    #[must_use]
    pub fn is_clean(&self) -> bool {
        self.uncovered.is_empty() && self.unregistered.is_empty()
    }

    /// Returns the strict result, failing loudly on any gap.
    ///
    /// # Errors
    /// Returns [`CensusError::UnregisteredEffect`] for a recorded effect outside
    /// the declared registry and [`CensusError::UncoveredClass`] for a declared
    /// class with no entry. Both are defects, not accepted gaps.
    pub fn into_strict(self) -> Result<Self, CensusError> {
        if let Some(class) = self.unregistered.first() {
            return Err(CensusError::UnregisteredEffect {
                class: class.clone(),
                entries_examined: self.entries_examined,
            });
        }
        if !self.uncovered.is_empty() {
            return Err(CensusError::UncoveredClass {
                classes: self.uncovered.clone(),
                entries_examined: self.entries_examined,
            });
        }
        Ok(self)
    }

    /// Renders the artifact as indented JSON.
    ///
    /// # Errors
    /// Returns [`AuditError::Config`] when serialization fails, which would be a
    /// programming error for this type.
    pub fn to_json(&self) -> Result<String, AuditError> {
        serde_json::to_string_pretty(self).map_err(|error| AuditError::Config(error.to_string()))
    }
}

/// Why a census failed.
#[derive(Debug)]
#[non_exhaustive]
pub enum CensusError {
    /// A recorded entry kind is not a declared effect class.
    UnregisteredEffect {
        /// The offending kind.
        class: String,
        /// How many entries were examined.
        entries_examined: u64,
    },
    /// One or more declared classes have no recorded entry.
    UncoveredClass {
        /// The uncovered classes.
        classes: Vec<EffectClass>,
        /// How many entries were examined.
        entries_examined: u64,
    },
    /// The store could not be read.
    Audit(AuditError),
}

impl fmt::Display for CensusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnregisteredEffect {
                class,
                entries_examined,
            } => write!(
                f,
                "census failed: unregistered effect class `{class}` is recorded in the log but \
                 is not in the declared registry ({entries_examined} entries examined)"
            ),
            Self::UncoveredClass {
                classes,
                entries_examined,
            } => {
                let names: Vec<&str> = classes.iter().map(|class| class.as_str()).collect();
                write!(
                    f,
                    "census failed: declared effect class(es) with no recorded entry: {} \
                     ({entries_examined} entries examined)",
                    names.join(", ")
                )
            }
            Self::Audit(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for CensusError {}

impl From<AuditError> for CensusError {
    fn from(error: AuditError) -> Self {
        Self::Audit(error)
    }
}

/// Builds the census report for a window, without judging it.
///
/// # Errors
/// Returns [`AuditError`] when a segment file cannot be read or holds a line
/// that is not a JSON object with a `seq` and a `kind`.
pub fn census(config: &AuditConfig, window: CensusWindow) -> Result<CensusReport, AuditError> {
    let mut counts: Vec<(EffectClass, u64, Option<u64>, Option<u64>)> = EffectClass::ALL
        .iter()
        .map(|class| (*class, 0u64, None, None))
        .collect();
    let mut unregistered: Vec<String> = Vec::new();
    let mut examined = 0u64;
    let mut segments_examined = 0u64;
    for index in segment_indices(config) {
        if let Some(allowed) = &window.segments
            && !allowed.contains(&index)
        {
            continue;
        }
        segments_examined = segments_examined.saturating_add(1);
        for (position, raw) in read_segment_lines(config, index)?.iter().enumerate() {
            let line: RawEntryLine = serde_json::from_str(raw).map_err(|error| {
                AuditError::Config(format!(
                    "audit segment {index} line {} is not a censusable entry: {error}",
                    position + 1
                ))
            })?;
            if !window.contains(&line, index) {
                continue;
            }
            examined = examined.saturating_add(1);
            // An entry kind outside the declared registry is an unregistered
            // effect, and the census fails on it rather than skipping it.
            let Some(class) = EntryKind::parse(&line.kind).and_then(EffectClass::of) else {
                if !unregistered.contains(&line.kind) {
                    unregistered.push(line.kind.clone());
                }
                continue;
            };
            if let Some(slot) = counts.iter_mut().find(|(item, ..)| *item == class) {
                slot.1 = slot.1.saturating_add(1);
                slot.2 = Some(slot.2.map_or(line.seq, |first| first.min(line.seq)));
                slot.3 = Some(slot.3.map_or(line.seq, |last| last.max(line.seq)));
            }
        }
    }
    let classes: Vec<ClassCensus> = counts
        .into_iter()
        .map(|(class, count, first_seq, last_seq)| ClassCensus {
            class,
            kinds: EntryKind::ALL
                .iter()
                .copied()
                .filter(|kind| EffectClass::of(*kind) == Some(class))
                .collect(),
            count,
            first_seq,
            last_seq,
        })
        .collect();
    let uncovered = classes
        .iter()
        .filter(|class| class.count == 0)
        .map(|class| class.class)
        .collect();
    unregistered.sort();
    Ok(CensusReport {
        window,
        entries_examined: examined,
        segments_examined,
        classes,
        uncovered,
        unregistered,
        level: config.anchor.level(),
        proves: vec![
            "every declared effect class is represented by at least one recorded entry in the \
             window"
                .to_owned(),
            "no recorded entry in the window carries an effect class outside the declared \
             registry"
                .to_owned(),
        ],
        does_not_prove: vec![
            "that no undeclared effect class exists; the declared registry is reviewed as part of \
             the security boundary"
                .to_owned(),
            "that the recorded entries are truthful; coverage is orthogonal to authenticity \
             (REQ-AUDIT-007)"
                .to_owned(),
        ],
    })
}

/// Builds the census and fails loudly on any gap.
///
/// # Errors
/// Returns [`CensusError`] for an uncovered declared class, an unregistered
/// recorded effect, or an unreadable store.
pub fn census_strict(
    config: &AuditConfig,
    window: CensusWindow,
) -> Result<CensusReport, CensusError> {
    census(config, window)?.into_strict()
}

/// Writes the census evidence artifact to `path`.
///
/// # Errors
/// Returns [`AuditError`] when the census fails or the artifact cannot be
/// written. A failing census never writes an artifact that could be mistaken
/// for a passing one.
pub fn write_artifact(
    config: &AuditConfig,
    window: CensusWindow,
    path: &Path,
) -> Result<CensusReport, AuditError> {
    let report = census(config, window)?;
    let json = report.to_json()?;
    std::fs::write(path, format!("{json}\n")).map_err(|error| AuditError::io(path, &error))?;
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::anchor::AnchorConfig;
    use crate::entry::{Actor, AuditRecord, Outcome};
    use crate::store::AuditLog;

    struct Fixture {
        _dir: tempfile::TempDir,
        config: AuditConfig,
    }

    impl Fixture {
        fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let config = AuditConfig {
                root: dir.path().join("audit"),
                ..AuditConfig::default()
            };
            Self { _dir: dir, config }
        }

        /// Appends one entry per declared class, in registry order.
        fn cover_every_class(&self) {
            let log = AuditLog::open(self.config.clone(), &[]).unwrap();
            for kind in EntryKind::ALL {
                log.append(
                    AuditRecord::new("ses_1", *kind)
                        .with_actor(Actor::Agent)
                        .with_action(kind.as_str())
                        .with_outcome(Outcome::Ok),
                )
                .unwrap();
            }
        }
    }

    #[test]
    fn a_full_run_has_no_gap() {
        let fixture = Fixture::new();
        fixture.cover_every_class();
        let report = census_strict(&fixture.config, CensusWindow::all()).unwrap();
        assert!(report.is_clean());
        assert_eq!(report.classes.len(), EffectClass::ALL.len());
        assert!(report.classes.iter().all(|class| class.count == 1));
    }

    #[test]
    fn a_missing_class_fails_loudly() {
        let fixture = Fixture::new();
        let log = AuditLog::open(fixture.config.clone(), &[]).unwrap();
        for kind in EntryKind::ALL {
            if *kind == EntryKind::Cost {
                continue;
            }
            log.append(
                AuditRecord::new("ses_1", *kind)
                    .with_actor(Actor::Agent)
                    .with_action(kind.as_str())
                    .with_outcome(Outcome::Ok),
            )
            .unwrap();
        }
        let error = census_strict(&fixture.config, CensusWindow::all()).unwrap_err();
        assert!(
            matches!(error, CensusError::UncoveredClass { ref classes, .. } if classes.contains(&EffectClass::Cost)),
            "{error}"
        );
        assert!(error.to_string().contains("cost"), "{error}");
    }

    #[test]
    fn an_unregistered_recorded_effect_fails_loudly() {
        let fixture = Fixture::new();
        fixture.cover_every_class();
        // A negative control: a hand-written line whose kind is outside the
        // declared registry.
        let path = fixture.config.segment_path(0);
        let mut raw = std::fs::read_to_string(&path).unwrap();
        raw.push_str(concat!(
            r#"{"seq":99,"ts":1,"session":"ses_1","actor":"agent","kind":"net_egress","#,
            r#""prev_hash":"00","entry_hash":"00"}"#,
            "\n"
        ));
        std::fs::write(&path, raw).unwrap();

        let error = census_strict(&fixture.config, CensusWindow::all()).unwrap_err();
        assert!(
            matches!(error, CensusError::UnregisteredEffect { ref class, .. } if class == "net_egress"),
            "{error}"
        );
    }

    #[test]
    fn a_session_filter_narrows_the_window() {
        let fixture = Fixture::new();
        fixture.cover_every_class();
        let error =
            census_strict(&fixture.config, CensusWindow::for_session("ses_other")).unwrap_err();
        assert!(matches!(error, CensusError::UncoveredClass { .. }));
        let report = census(&fixture.config, CensusWindow::for_session("ses_1")).unwrap();
        assert_eq!(report.entries_examined, EntryKind::ALL.len() as u64);
    }

    #[test]
    fn the_artifact_renders_as_json() {
        let fixture = Fixture::new();
        fixture.cover_every_class();
        let path = fixture.config.root.parent().unwrap().join("census.json");
        let report = write_artifact(&fixture.config, CensusWindow::all(), &path).unwrap();
        assert!(path.exists());
        let raw = std::fs::read_to_string(&path).unwrap();
        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            parsed["classes"].as_array().unwrap().len(),
            EffectClass::ALL.len()
        );
        assert_eq!(parsed["level"], "local-sink");
        assert_eq!(report.level, crate::entry::AnchorLevelName::LocalSink);
    }

    #[test]
    fn a_local_trust_store_reports_local_trust() {
        let dir = tempfile::tempdir().unwrap();
        let config = AuditConfig {
            root: dir.path().join("audit"),
            anchor: AnchorConfig {
                offbox: crate::anchor::OffBox::None,
                ..AnchorConfig::default()
            },
            ..AuditConfig::default()
        };
        let log = AuditLog::open(config.clone(), &[]).unwrap();
        log.append(AuditRecord::new("ses_1", EntryKind::Run).with_outcome(Outcome::Ok))
            .unwrap();
        let report = census(&config, CensusWindow::all()).unwrap();
        assert_eq!(report.level, crate::entry::AnchorLevelName::LocalTrust);
    }
}
