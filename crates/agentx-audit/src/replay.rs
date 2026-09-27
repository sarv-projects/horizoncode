//! `audit replay`: reconstruct a run's decision/effect timeline from the
//! recorded evidence (`REQ-SESS-002`).
//!
//! Replay **reads** evidence; it never re-executes an effect. It refuses to
//! present a timeline as trusted history when the chain does not verify
//! (`ARCH/14-AUDIT.md` §Replay).

use std::fmt;

use serde::Serialize;

use crate::entry::{AuditEntry, EffectClass, EntryKind};
use crate::error::AuditError;
use crate::store::AuditConfig;
use crate::verify::{Divergence, VerifyError, verify};

/// A bounded window over the recorded sequence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReplayWindow {
    /// Only entries with `seq >= from` are replayed.
    pub from: Option<u64>,
    /// Only entries with `seq <= to` are replayed.
    pub to: Option<u64>,
}

impl ReplayWindow {
    /// Builds a window from inclusive bounds.
    #[must_use]
    pub fn between(from: Option<u64>, to: Option<u64>) -> Self {
        Self { from, to }
    }

    fn contains(&self, seq: u64) -> bool {
        self.from.is_none_or(|from| seq >= from) && self.to.is_none_or(|to| seq <= to)
    }
}

/// One reconstructed moment in the timeline.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReplayItem {
    /// The audit sequence.
    pub seq: u64,
    /// The recorded timestamp.
    pub ts: i64,
    /// The session the entry belongs to.
    pub session: String,
    /// The turn, when the entry is inside one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    /// The entry kind.
    pub kind: EntryKind,
    /// The declared effect class.
    pub class: EffectClass,
    /// A bounded, human-readable summary. It contains refs and digests only —
    /// never a document, prompt, or completion.
    pub summary: String,
}

/// A reconstructed timeline.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ReplayReport {
    /// The anchoring level the evidence was evaluated at.
    pub level: crate::entry::AnchorLevelName,
    /// The session filter, when one was applied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session: Option<String>,
    /// How many entries were examined.
    pub entries_examined: u64,
    /// The reconstructed timeline, in order.
    pub timeline: Vec<ReplayItem>,
    /// A reminder rendered alongside every replay.
    pub note: String,
}

impl ReplayReport {
    /// Renders the timeline as plain text.
    #[must_use]
    pub fn render(&self) -> String {
        let mut out = String::new();
        out.push_str(&format!(
            "replay: {} entries, anchoring level {}\n",
            self.timeline.len(),
            self.level.as_str()
        ));
        for item in &self.timeline {
            out.push_str(&format!(
                "{:>6}  {:<16} {}\n",
                item.seq,
                item.kind.as_str(),
                item.summary
            ));
        }
        out.push_str(&self.note);
        out.push('\n');
        out
    }
}

/// Replays a session's timeline from the recorded evidence.
///
/// # Errors
/// Returns [`ReplayError::Divergence`] when the chain does not verify — replay
/// then refuses to assert trusted history — and [`ReplayError::Audit`] when the
/// store cannot be read.
pub fn replay(
    config: &AuditConfig,
    session: Option<&str>,
    window: ReplayWindow,
) -> Result<ReplayReport, ReplayError> {
    let report = verify(config).map_err(ReplayError::from)?;
    let entries = crate::store::read_segments(config)
        .map_err(ReplayError::Audit)?
        .into_iter()
        .flat_map(|segment| segment.entries)
        .collect::<Vec<AuditEntry>>();
    let mut timeline = Vec::new();
    let mut examined = 0u64;
    for entry in entries {
        if let Some(session) = session
            && entry.session != session
        {
            continue;
        }
        if !window.contains(entry.seq) {
            continue;
        }
        examined = examined.saturating_add(1);
        timeline.push(summarize(entry));
    }
    Ok(ReplayReport {
        level: report.claim.level,
        session: session.map(str::to_owned),
        entries_examined: examined,
        timeline,
        note: "replay reconstructs recorded evidence; it does not re-execute effects and does \
               not re-establish content authenticity."
            .to_owned(),
    })
}

fn summarize(entry: AuditEntry) -> ReplayItem {
    let class = entry.effect_class().unwrap_or(EffectClass::RecordAccess);
    let mut summary = match entry.kind {
        EntryKind::Run => format!("run {}", entry.action.as_deref().unwrap_or("boundary")),
        EntryKind::Step => format!("step {}", entry.action.as_deref().unwrap_or("boundary")),
        EntryKind::Decision => format!(
            "decision {} {}",
            entry.action.as_deref().unwrap_or("-"),
            entry.effect.map_or("-", |effect| effect.as_str())
        ),
        EntryKind::Tool => format!(
            "tool {} {}",
            entry.action.as_deref().unwrap_or("-"),
            entry.outcome.map_or("-", |outcome| outcome.as_str())
        ),
        EntryKind::Approval => format!(
            "approval {} {}",
            entry.action.as_deref().unwrap_or("-"),
            entry.outcome.map_or("-", |outcome| outcome.as_str())
        ),
        EntryKind::FsWrite => format!(
            "file write {} {}",
            entry.resource.as_deref().unwrap_or("-"),
            entry.outcome.map_or("-", |outcome| outcome.as_str())
        ),
        EntryKind::Sandbox => format!(
            "sandbox {} {}",
            entry.action.as_deref().unwrap_or("-"),
            entry.outcome.map_or("-", |outcome| outcome.as_str())
        ),
        EntryKind::Model => format!("model {}", entry.action.as_deref().unwrap_or("call")),
        EntryKind::Cost => format!(
            "cost {} {}",
            entry.action.as_deref().unwrap_or("usage"),
            entry.outcome.map_or("-", |outcome| outcome.as_str())
        ),
        EntryKind::Ticket => format!(
            "ticket {} {}",
            entry.action.as_deref().unwrap_or("-"),
            entry.outcome.map_or("-", |outcome| outcome.as_str())
        ),
        EntryKind::RecordAccess => format!(
            "record access {} {}",
            entry.action.as_deref().unwrap_or("-"),
            entry.resource.as_deref().unwrap_or("-")
        ),
    };
    if let Some(receipt) = &entry.receipt_ref {
        summary.push_str(&format!(" receipt={receipt}"));
    }
    if let Some(ticket) = &entry.ticket_ref {
        summary.push_str(&format!(" ticket={ticket}"));
    }
    ReplayItem {
        seq: entry.seq,
        ts: entry.ts,
        session: entry.session,
        turn: entry.turn,
        kind: entry.kind,
        class,
        summary,
    }
}

/// Why a replay could not produce a trusted timeline.
#[derive(Debug)]
pub enum ReplayError {
    /// The chain does not verify.
    Divergence(Divergence),
    /// The store could not be read.
    Audit(AuditError),
}

impl fmt::Display for ReplayError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Divergence(divergence) => {
                write!(f, "replay refuses to assert trusted history: {divergence}")
            }
            Self::Audit(error) => write!(f, "{error}"),
        }
    }
}

impl std::error::Error for ReplayError {}

impl From<VerifyError> for ReplayError {
    fn from(error: VerifyError) -> Self {
        match error {
            VerifyError::Divergence(divergence) => Self::Divergence(divergence),
            VerifyError::Audit(error) => Self::Audit(error),
        }
    }
}
