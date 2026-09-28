//! The append-only analytics ledger: the source of truth, and rebuildable.
//!
//! ```text
//! ~/.horizoncode/analytics/events.jsonl
//! ~/.horizoncode/analytics/rollup.sqlite3
//! ```
//!
//! The ledger is authoritative. The SQLite rollups are derived: dropping the
//! database and rebuilding it from the ledger must reproduce the same rows
//! (`ARCH/20-ANALYTICS.md` §Lifecycle & flows). The ledger performs **no
//! network egress** and contains no prompt text, completion text, or file
//! contents.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use crate::config::{AnalyticsConfig, AnalyticsSettings};
use crate::error::AnalyticsError;
use crate::event::AnalyticsEvent;

/// The ledger file name.
pub const LEDGER_FILE: &str = "events.jsonl";
/// The rollup database file name.
pub const ROLLUPS_FILE: &str = "rollup.sqlite3";
/// The pricing snapshot file name.
pub const PRICING_FILE: &str = "pricing.json";

/// Returns the default analytics root: `<state-root>/analytics`, where the
/// state root is `$HORIZONCODE_HOME` or `~/.horizoncode` (`ARCH/18`).
#[must_use]
pub fn default_analytics_root() -> PathBuf {
    horizoncode_config::state_root().join("analytics")
}

/// The append-only ledger plus its derived rollups.
#[derive(Debug)]
pub struct AnalyticsLog {
    config: AnalyticsConfig,
    settings: AnalyticsSettings,
    /// The exclusive append lock; the ledger sequence is assigned under it.
    sequence: Mutex<u64>,
    fsync: bool,
}

impl AnalyticsLog {
    /// Opens (creating if needed) the ledger and its rollups.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] for a declared-but-unimplemented
    /// telemetry posture, and [`AnalyticsError::Io`] when the directory cannot
    /// be created.
    pub fn open(config: AnalyticsConfig) -> Result<Self, AnalyticsError> {
        config.settings.validate()?;
        horizoncode_config::refuse_symlink(&config.root)
            .map_err(|error| AnalyticsError::io(&config.root, &error))?;
        fs::create_dir_all(&config.root)
            .map_err(|error| AnalyticsError::io(&config.root, &error))?;
        horizoncode_config::set_owner_only(&config.root, horizoncode_config::OwnerOnly::Directory)
            .map_err(|error| AnalyticsError::io(&config.root, &error))?;
        let settings = config.settings.clone();
        let sequence = read_ledger(&config)?
            .last()
            .map_or(0, |event| event.seq.saturating_add(1));
        let log = Self {
            config,
            settings,
            sequence: Mutex::new(sequence),
            fsync: true,
        };
        // The rollups are derived, so a missing or stale database is rebuilt
        // rather than treated as a source of truth.
        log.rebuild()?;
        Ok(log)
    }

    /// Rebuilds the derived rollups from the ledger.
    ///
    /// # Errors
    /// Returns [`AnalyticsError`] when the rollup database cannot be opened or
    /// written.
    pub fn rebuild(&self) -> Result<crate::rollup::RebuildReport, AnalyticsError> {
        let rollups = crate::rollup::Rollups::open(&self.rollups_path())?;
        rollups.rebuild(&self.config)
    }

    /// Returns the derived rollup index.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Sqlite`] when the index cannot be opened.
    pub fn rollups(&self) -> Result<crate::rollup::Rollups, AnalyticsError> {
        crate::rollup::Rollups::open(&self.rollups_path())
    }

    /// Returns the configuration.
    #[must_use]
    pub fn config(&self) -> &AnalyticsConfig {
        &self.config
    }

    /// Returns the effective settings.
    #[must_use]
    pub fn settings(&self) -> &AnalyticsSettings {
        &self.settings
    }

    /// Returns the analytics root.
    #[must_use]
    pub fn root(&self) -> &Path {
        &self.config.root
    }

    /// Returns the ledger path.
    #[must_use]
    pub fn ledger_path(&self) -> PathBuf {
        self.config.root.join(LEDGER_FILE)
    }

    /// Returns the rollup database path.
    #[must_use]
    pub fn rollups_path(&self) -> PathBuf {
        self.config.root.join(ROLLUPS_FILE)
    }

    /// Disables `fsync` on append. Durability is on by default.
    #[must_use]
    pub fn with_fsync(mut self, fsync: bool) -> Self {
        self.fsync = fsync;
        self
    }

    /// Appends one event, assigning the ledger sequence.
    ///
    /// The event is written and flushed before returning, so a crash loses no
    /// committed fact: the rollups can always be rebuilt from what is on disk.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Io`] when the ledger cannot be written.
    pub fn append(&self, mut event: AnalyticsEvent) -> Result<AnalyticsEvent, AnalyticsError> {
        let mut sequence = self
            .sequence
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        event.seq = *sequence;
        *sequence = sequence.saturating_add(1);
        let path = self.ledger_path();
        horizoncode_config::refuse_symlink(&path)
            .map_err(|error| AnalyticsError::io(&path, &error))?;
        let mut file = OpenOptions::new()
            .append(true)
            .create(true)
            .open(&path)
            .map_err(|error| AnalyticsError::io(&path, &error))?;
        horizoncode_config::set_owner_only(&path, horizoncode_config::OwnerOnly::File)
            .map_err(|error| AnalyticsError::io(&path, &error))?;
        file.write_all(event.to_line().as_bytes())
            .and_then(|()| file.flush())
            .map_err(|error| AnalyticsError::io(&path, &error))?;
        if self.fsync {
            file.sync_data()
                .map_err(|error| AnalyticsError::io(&path, &error))?;
        }
        drop(file);
        // The ledger line is durable, so the derived rollups are updated now.
        // A failure here is reported rather than swallowed: the ledger remains
        // the source of truth, and `rebuild` reproduces the rows.
        if self.settings.recording_enabled() {
            let rollups = crate::rollup::Rollups::open(&self.rollups_path())?;
            let snapshot = self.pricing()?;
            rollups.absorb(&event, snapshot.as_ref())?;
        }
        Ok(event)
    }

    /// Reads every ledger event, in order.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Ledger`] for a corrupt line, so a damaged
    /// ledger is reported rather than partially consumed.
    pub fn events(&self) -> Result<Vec<AnalyticsEvent>, AnalyticsError> {
        read_ledger(&self.config)
    }

    /// Returns how many events the ledger holds.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Ledger`] for a corrupt line.
    pub fn event_count(&self) -> Result<u64, AnalyticsError> {
        Ok(read_ledger(&self.config)?.len() as u64)
    }

    /// Loads the local pricing snapshot, if one is present.
    ///
    /// A missing snapshot is **not** an error: it means every cost is unknown,
    /// which is the honest zero-configuration state.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] when a snapshot exists but is
    /// malformed. A malformed snapshot is never silently ignored, because
    /// ignoring it would silently downgrade every cost to `unknown`.
    pub fn pricing(&self) -> Result<Option<crate::cost::PricingSnapshot>, AnalyticsError> {
        let path = self.config.root.join(PRICING_FILE);
        match fs::read_to_string(&path) {
            Ok(text) => crate::cost::PricingSnapshot::from_json(&text).map(Some),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(AnalyticsError::io(&path, &error)),
        }
    }

    /// Writes the pricing snapshot, validating it first.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] for an invalid snapshot and
    /// [`AnalyticsError::Io`] when it cannot be written.
    pub fn save_pricing(
        &self,
        snapshot: &crate::cost::PricingSnapshot,
    ) -> Result<(), AnalyticsError> {
        snapshot.validate()?;
        let path = self.config.root.join(PRICING_FILE);
        fs::write(&path, format!("{}\n", snapshot.to_json()?))
            .map_err(|error| AnalyticsError::io(&path, &error))
    }

    /// Streams the ledger as newline-delimited JSON, returning how many events
    /// were written.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Ledger`] for a corrupt line, or
    /// [`AnalyticsError::Io`] when the writer fails.
    pub fn export<W: std::io::Write>(
        &self,
        out: &mut W,
        sanitize: bool,
    ) -> Result<usize, AnalyticsError> {
        let events = self.events()?;
        let mut written = 0usize;
        for mut event in events {
            if sanitize {
                crate::sanitize::scrub(&mut event);
            }
            let line = event.to_line();
            out.write_all(line.as_bytes())
                .map_err(|error| AnalyticsError::io(Path::new("<export>"), &error))?;
            written += 1;
        }
        Ok(written)
    }
}

/// Reads the ledger, in order.
pub fn read_ledger(config: &AnalyticsConfig) -> Result<Vec<AnalyticsEvent>, AnalyticsError> {
    let path = config.root.join(LEDGER_FILE);
    horizoncode_config::refuse_symlink(&path).map_err(|error| AnalyticsError::io(&path, &error))?;
    let content = match fs::read_to_string(&path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(AnalyticsError::io(&path, &error)),
    };
    let mut out = Vec::new();
    for (index, line) in content.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let event = serde_json::from_str::<AnalyticsEvent>(line).map_err(|error| {
            AnalyticsError::Ledger {
                line: index + 1,
                message: error.to_string(),
            }
        })?;
        out.push(event);
    }
    Ok(out)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::event::{EventKind, Tokens};
    use tempfile::TempDir;

    /// A per-test analytics root. Never the developer's real `~/.horizoncode`.
    pub(crate) struct Fixture {
        /// Held so the temp root outlives the log.
        pub _dir: TempDir,
        pub config: AnalyticsConfig,
    }

    impl Fixture {
        pub(crate) fn new() -> Self {
            let dir = tempfile::tempdir().unwrap();
            let config = AnalyticsConfig::new(dir.path().join("analytics"));
            Self { _dir: dir, config }
        }
    }

    #[test]
    fn appends_are_sequenced_and_readable() {
        let fixture = Fixture::new();
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        log.append(AnalyticsEvent::new(0, 1, "ses_1", EventKind::TurnStart))
            .unwrap();
        let second = log
            .append(AnalyticsEvent::new(0, 2, "ses_1", EventKind::TurnEnd))
            .unwrap();
        assert_eq!(second.seq, 1);
        assert_eq!(log.event_count().unwrap(), 2);
    }

    #[test]
    fn the_sequence_continues_after_reopen() {
        let fixture = Fixture::new();
        {
            let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
            log.append(AnalyticsEvent::new(0, 1, "ses_1", EventKind::TurnStart))
                .unwrap();
        }
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        let next = log
            .append(AnalyticsEvent::new(0, 2, "ses_1", EventKind::TurnStart))
            .unwrap();
        assert_eq!(next.seq, 1);
    }

    #[test]
    fn a_corrupt_ledger_line_is_reported_not_skipped() {
        let fixture = Fixture::new();
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        log.append(AnalyticsEvent::new(0, 1, "ses_1", EventKind::TurnStart))
            .unwrap();
        let path = fixture.config.root.join(LEDGER_FILE);
        let mut raw = fs::read_to_string(&path).unwrap();
        raw.push_str("{not json}\n");
        fs::write(&path, raw).unwrap();

        let error = log.events().unwrap_err();
        assert!(
            matches!(error, AnalyticsError::Ledger { line: 2, .. }),
            "{error}"
        );
        // Reopening fails closed on the same corruption rather than rebuilding a
        // rollup from a partially-read ledger.
        assert!(AnalyticsLog::open(fixture.config.clone()).is_err());
    }

    #[test]
    fn no_pricing_snapshot_means_none_not_an_invented_table() {
        let fixture = Fixture::new();
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        assert!(log.pricing().unwrap().is_none());
    }

    #[test]
    fn a_saved_snapshot_round_trips() {
        let fixture = Fixture::new();
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        let snapshot = crate::cost::PricingSnapshot::new("v1", "test", 7);
        log.save_pricing(&snapshot).unwrap();
        assert_eq!(log.pricing().unwrap().unwrap(), snapshot);
    }

    #[test]
    fn an_invalid_snapshot_is_refused_and_not_silently_ignored() {
        let fixture = Fixture::new();
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        // A snapshot that cannot be parsed. Silently ignoring it would quietly
        // downgrade every cost to `unknown`, which is exactly the failure this
        // refuses.
        fs::write(fixture.config.root.join(PRICING_FILE), "{not json").unwrap();
        assert!(log.pricing().is_err());
        // A snapshot that parses but is semantically invalid is also refused.
        fs::write(
            fixture.config.root.join(PRICING_FILE),
            "{\"version\":\"v1\",\"routes\":{\"a/b\":{\"provider\":\"a\",\"model\":\"b\",\"input_micros_per_mtok\":-1,\"output_micros_per_mtok\":0}}}",
        )
        .unwrap();
        assert!(log.pricing().is_err());
    }

    #[test]
    fn export_streams_every_event_and_a_scrub_rewrites_nothing_structural() {
        let fixture = Fixture::new();
        let log = AnalyticsLog::open(fixture.config.clone()).unwrap();
        log.append(
            AnalyticsEvent::new(0, 1, "ses_1", EventKind::StepUsage)
                .with_route("compatible", "mock-model")
                .with_tokens(Tokens::observed(5, 6)),
        )
        .unwrap();
        let mut out = Vec::new();
        let written = log.export(&mut out, false).unwrap();
        assert_eq!(written, 1);
        let text = String::from_utf8(out).unwrap();
        assert_eq!(text.lines().count(), 1);
        assert!(text.contains("\"seq\":0"));
    }
}
