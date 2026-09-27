//! Analytics configuration (`ARCH/20-ANALYTICS.md` §Configuration).
//!
//! Two switches are off by default and are **fail-loud** when turned on without
//! an implementation: OpenTelemetry export and remote opt-in. Analytics is
//! local-only, so neither may be quietly accepted and then ignored
//! (`REQ-ANALYTICS-004`).

use std::path::PathBuf;

use crate::error::AnalyticsError;
use crate::ledger::default_analytics_root;

/// Whether OpenTelemetry export is requested.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OtelMode {
    /// Off, which is the only implemented mode.
    #[default]
    Off,
    /// Requested. This build has no exporter, so the request fails closed
    /// rather than being accepted and ignored.
    Requested,
}

/// Whether remote (off-box) analytics is requested.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum RemoteMode {
    /// Off: no network egress, and no opt-in has been given.
    #[default]
    Off,
    /// Explicitly opted in. This build exports nothing, so the request fails
    /// closed.
    OptedIn,
}

/// The effective analytics settings.
///
/// Analytics records by default; only the *egress* switches are off by default.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnalyticsSettings {
    /// Whether analytics records at all.
    pub enabled: bool,
    /// OpenTelemetry export.
    pub otel: OtelMode,
    /// Remote analytics opt-in.
    pub remote: RemoteMode,
    /// Whether a managed policy locks analytics off regardless of local
    /// configuration.
    pub managed_lockdown: bool,
}

impl Default for AnalyticsSettings {
    fn default() -> Self {
        Self {
            enabled: true,
            otel: OtelMode::Off,
            remote: RemoteMode::Off,
            managed_lockdown: false,
        }
    }
}

impl AnalyticsSettings {
    /// Returns whether recording is permitted.
    #[must_use]
    pub fn recording_enabled(&self) -> bool {
        self.enabled && !self.managed_lockdown
    }

    /// Validates the settings.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Unsupported`] when telemetry is requested, so
    /// the request surfaces as an error rather than as silence.
    pub fn validate(&self) -> Result<(), AnalyticsError> {
        if self.otel == OtelMode::Requested {
            return Err(AnalyticsError::Unsupported(
                "analytics.otel (OpenTelemetry export)".to_owned(),
            ));
        }
        if self.remote == RemoteMode::OptedIn {
            return Err(AnalyticsError::Unsupported(
                "analytics.remote_optin (remote analytics export)".to_owned(),
            ));
        }
        Ok(())
    }

    /// Returns the statement a surface renders about egress.
    #[must_use]
    pub fn egress_statement(&self) -> &'static str {
        "network egress: none; the ledger and rollups are local files"
    }
}

/// The analytics configuration.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AnalyticsConfig {
    /// The analytics root (`~/.agentx/analytics` by default).
    pub root: PathBuf,
    /// The effective settings.
    pub settings: AnalyticsSettings,
}

impl Default for AnalyticsConfig {
    fn default() -> Self {
        Self {
            root: default_analytics_root(),
            settings: AnalyticsSettings::default(),
        }
    }
}

impl AnalyticsConfig {
    /// Builds a config rooted at `root` with the default local-only settings.
    #[must_use]
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            ..Self::default()
        }
    }

    /// Parses an `analytics` configuration document.
    ///
    /// # Errors
    /// Returns [`AnalyticsError::Config`] for an unknown value and
    /// [`AnalyticsError::Unsupported`] for a requested telemetry posture.
    pub fn from_json(root: PathBuf, value: &serde_json::Value) -> Result<Self, AnalyticsError> {
        let flag = |key: &str, default: bool| -> Result<bool, AnalyticsError> {
            match value.get(key) {
                None | Some(serde_json::Value::Null) => Ok(default),
                Some(serde_json::Value::Bool(flag)) => Ok(*flag),
                Some(_) => Err(AnalyticsError::Config(format!(
                    "analytics.{key} must be a boolean"
                ))),
            }
        };
        let settings = AnalyticsSettings {
            enabled: flag("enabled", true)?,
            otel: match flag("otel", false)? {
                true => OtelMode::Requested,
                false => OtelMode::Off,
            },
            remote: match flag("remote_optin", false)? {
                true => RemoteMode::OptedIn,
                false => RemoteMode::Off,
            },
            managed_lockdown: flag("managed_lockdown", false)?,
        };
        let config = Self { root, settings };
        config.settings.validate()?;
        Ok(config)
    }

    /// Validates the configuration.
    ///
    /// # Errors
    /// As [`AnalyticsSettings::validate`].
    pub fn validate(&self) -> Result<(), AnalyticsError> {
        self.settings.validate()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn the_default_posture_is_local_only() {
        let settings = AnalyticsSettings::default();
        assert_eq!(settings.otel, OtelMode::Off);
        assert_eq!(settings.remote, RemoteMode::Off);
        assert!(settings.recording_enabled());
        assert!(settings.egress_statement().contains("none"));
    }

    #[test]
    fn requesting_otel_fails_closed() {
        let value = json!({ "enabled": true, "otel": true });
        let error = AnalyticsConfig::from_json(PathBuf::from("/tmp/a"), &value).unwrap_err();
        assert!(matches!(error, AnalyticsError::Unsupported(_)), "{error}");
        assert!(
            error.to_string().contains("no telemetry left this machine"),
            "{error}"
        );
    }

    #[test]
    fn requesting_remote_export_fails_closed() {
        let value = json!({ "enabled": true, "remote_optin": true });
        assert!(AnalyticsConfig::from_json(PathBuf::from("/tmp/a"), &value).is_err());
    }

    #[test]
    fn a_zero_config_document_parses() {
        let config = AnalyticsConfig::from_json(PathBuf::from("/tmp/a"), &json!({})).unwrap();
        assert!(config.settings.recording_enabled());
    }

    #[test]
    fn managed_lockdown_disables_recording() {
        let value = json!({ "enabled": true, "managed_lockdown": true });
        let config = AnalyticsConfig::from_json(PathBuf::from("/tmp/a"), &value).unwrap();
        assert!(!config.settings.recording_enabled());
    }

    #[test]
    fn a_non_boolean_flag_is_refused() {
        let value = json!({ "enabled": "yes" });
        assert!(AnalyticsConfig::from_json(PathBuf::from("/tmp/a"), &value).is_err());
    }
}
