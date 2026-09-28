//! Typed settings with per-key provenance (`ARCH/18` §Data / state model).
//!
//! Values resolve over the discovered layers, global first, nearest last. Every
//! effective value carries the file that supplied it, the files it shadowed,
//! and a digest that a run can pin. The rules implemented here are the ones
//! `ARCH/18` fixes:
//!
//! - a nearer layer wins per key; there is no blanket object overwrite;
//! - an unknown group or key is reported and never becomes effective;
//! - a value of the wrong type is **not** coerced: the last valid value stays
//!   effective and the view carries the validation error, so the requested and
//!   the effective value can be shown side by side;
//! - a layer that cannot be read or parsed contributes nothing and is reported;
//!   it can never widen or blank out a value by accident.
//!
//! Security policy does not live here: the guard keeps its own stricter rule
//! where a malformed layer installs a deny-all ceiling. This crate's schema is
//! for preferences, and its first slice covers the accessibility, notification,
//! and instruction-extension keys that the UI and context planes consume. The
//! remaining groups of `ARCH/18` register here as their owners land, so no
//! second settings engine appears.

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::{Value, json};

use crate::discovery::{ConfigLayer, Discovery};

/// The schema version stamped into every setting view.
pub const SCHEMA_VERSION: u32 = 1;

/// Compiled defaults and ceilings for the session event log (`DEC-058`).
pub const SESSION_LOG_MAX_EVENT_BYTES: u64 = 256 * 1024;
/// See [`SESSION_LOG_MAX_EVENT_BYTES`].
pub const SESSION_LOG_MAX_SEGMENT_BYTES: u64 = 8 * 1024 * 1024;
/// See [`SESSION_LOG_MAX_EVENT_BYTES`].
pub const SESSION_LOG_MAX_SEGMENT_EVENTS: u64 = 4096;
/// See [`SESSION_LOG_MAX_EVENT_BYTES`].
pub const SESSION_LOG_MAX_SESSION_EVENT_BYTES: u64 = 256 * 1024 * 1024;
/// See [`SESSION_LOG_MAX_EVENT_BYTES`].
pub const SESSION_LOG_CONTROL_RESERVE_BYTES: u64 = 4 * 1024 * 1024;
/// See [`SESSION_LOG_MAX_EVENT_BYTES`].
pub const SESSION_LOG_REPLAY_BATCH_EVENTS: u64 = 256;

/// Compiled defaults and ceilings for the run event log (`DEC-058`).
pub const RUN_LOG_MAX_EVENT_BYTES: u64 = 256 * 1024;
/// See [`RUN_LOG_MAX_EVENT_BYTES`].
pub const RUN_LOG_MAX_SEGMENT_BYTES: u64 = 8 * 1024 * 1024;
/// See [`RUN_LOG_MAX_EVENT_BYTES`].
pub const RUN_LOG_MAX_SEGMENT_EVENTS: u64 = 4096;
/// See [`RUN_LOG_MAX_EVENT_BYTES`].
pub const RUN_LOG_MAX_RUN_EVENT_BYTES: u64 = 512 * 1024 * 1024;
/// See [`RUN_LOG_MAX_EVENT_BYTES`].
pub const RUN_LOG_CONTROL_RESERVE_BYTES: u64 = 16 * 1024 * 1024;
/// See [`RUN_LOG_MAX_EVENT_BYTES`].
pub const RUN_LOG_REPLAY_BATCH_EVENTS: u64 = 256;

/// Compiled artifact defaults and ceilings (`DEC-058`).
pub const ARTIFACT_MAX_INLINE_EVENT_BYTES: u64 = 64 * 1024;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_MAX_OBJECT_BYTES: u64 = 64 * 1024 * 1024;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const SESSION_ARTIFACT_MAX_SESSION_BYTES: u64 = 1024 * 1024 * 1024;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const RUN_ARTIFACT_MAX_RUN_BYTES: u64 = 2 * 1024 * 1024 * 1024;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_MAX_DECODED_BYTES: u64 = 256 * 1024 * 1024;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_MAX_DECODED_PIXELS: u64 = 16_777_216;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_MAX_EXPANSION_RATIO: u64 = 128;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_DECODE_TIMEOUT_MS: u64 = 5_000;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_RETENTION_DAYS: u64 = 30;
/// See [`ARTIFACT_MAX_INLINE_EVENT_BYTES`].
pub const ARTIFACT_ORPHAN_GRACE_HOURS: u64 = 24;

/// The groups this schema knows. A top-level group outside the list is reported
/// once by name instead of once per leaf.
const GROUPS: &[&str] = &["instructions", "run", "session", "ui"];

/// The keys this schema resolves, in a stable order.
#[must_use]
pub fn schema_keys() -> Vec<&'static str> {
    let mut keys: Vec<&'static str> = NON_LIMIT_KEYS.to_vec();
    keys.extend(LIMITS.iter().map(|(key, _, _)| *key));
    keys.sort_unstable();
    keys
}

/// Keys that are not storage limits.
const NON_LIMIT_KEYS: &[&str] = &[
    "instructions.extra",
    "ui.accessibility.reduced_motion",
    "ui.accessibility.screen_reader",
    "ui.notifications.terminal_bell",
];

/// `(key, default, compiled ceiling)` for every storage limit (`DEC-058`).
///
/// The default and the ceiling are the same number: a configuration may lower a
/// limit, never raise it. Revising a number requires a new decision and a
/// schema-version note, so the values are pinned here once.
const LIMITS: &[(&str, u64, u64)] = &[
    (
        "run.artifacts.max_run_bytes",
        RUN_ARTIFACT_MAX_RUN_BYTES,
        RUN_ARTIFACT_MAX_RUN_BYTES,
    ),
    (
        "run.log.control_reserve_bytes",
        RUN_LOG_CONTROL_RESERVE_BYTES,
        RUN_LOG_CONTROL_RESERVE_BYTES,
    ),
    (
        "run.log.max_event_bytes",
        RUN_LOG_MAX_EVENT_BYTES,
        RUN_LOG_MAX_EVENT_BYTES,
    ),
    (
        "run.log.max_run_event_bytes",
        RUN_LOG_MAX_RUN_EVENT_BYTES,
        RUN_LOG_MAX_RUN_EVENT_BYTES,
    ),
    (
        "run.log.max_segment_bytes",
        RUN_LOG_MAX_SEGMENT_BYTES,
        RUN_LOG_MAX_SEGMENT_BYTES,
    ),
    (
        "run.log.max_segment_events",
        RUN_LOG_MAX_SEGMENT_EVENTS,
        RUN_LOG_MAX_SEGMENT_EVENTS,
    ),
    (
        "run.log.replay_batch_events",
        RUN_LOG_REPLAY_BATCH_EVENTS,
        RUN_LOG_REPLAY_BATCH_EVENTS,
    ),
    (
        "session.artifacts.decode_timeout_ms",
        ARTIFACT_DECODE_TIMEOUT_MS,
        ARTIFACT_DECODE_TIMEOUT_MS,
    ),
    (
        "session.artifacts.max_decoded_bytes",
        ARTIFACT_MAX_DECODED_BYTES,
        ARTIFACT_MAX_DECODED_BYTES,
    ),
    (
        "session.artifacts.max_decoded_pixels",
        ARTIFACT_MAX_DECODED_PIXELS,
        ARTIFACT_MAX_DECODED_PIXELS,
    ),
    (
        "session.artifacts.max_expansion_ratio",
        ARTIFACT_MAX_EXPANSION_RATIO,
        ARTIFACT_MAX_EXPANSION_RATIO,
    ),
    (
        "session.artifacts.max_inline_event_bytes",
        ARTIFACT_MAX_INLINE_EVENT_BYTES,
        ARTIFACT_MAX_INLINE_EVENT_BYTES,
    ),
    (
        "session.artifacts.max_object_bytes",
        ARTIFACT_MAX_OBJECT_BYTES,
        ARTIFACT_MAX_OBJECT_BYTES,
    ),
    (
        "session.artifacts.max_session_bytes",
        SESSION_ARTIFACT_MAX_SESSION_BYTES,
        SESSION_ARTIFACT_MAX_SESSION_BYTES,
    ),
    (
        "session.artifacts.orphan_grace_hours",
        ARTIFACT_ORPHAN_GRACE_HOURS,
        ARTIFACT_ORPHAN_GRACE_HOURS,
    ),
    (
        "session.artifacts.retention_days",
        ARTIFACT_RETENTION_DAYS,
        ARTIFACT_RETENTION_DAYS,
    ),
    (
        "session.log.control_reserve_bytes",
        SESSION_LOG_CONTROL_RESERVE_BYTES,
        SESSION_LOG_CONTROL_RESERVE_BYTES,
    ),
    (
        "session.log.max_event_bytes",
        SESSION_LOG_MAX_EVENT_BYTES,
        SESSION_LOG_MAX_EVENT_BYTES,
    ),
    (
        "session.log.max_segment_bytes",
        SESSION_LOG_MAX_SEGMENT_BYTES,
        SESSION_LOG_MAX_SEGMENT_BYTES,
    ),
    (
        "session.log.max_segment_events",
        SESSION_LOG_MAX_SEGMENT_EVENTS,
        SESSION_LOG_MAX_SEGMENT_EVENTS,
    ),
    (
        "session.log.max_session_event_bytes",
        SESSION_LOG_MAX_SESSION_EVENT_BYTES,
        SESSION_LOG_MAX_SESSION_EVENT_BYTES,
    ),
    (
        "session.log.replay_batch_events",
        SESSION_LOG_REPLAY_BATCH_EVENTS,
        SESSION_LOG_REPLAY_BATCH_EVENTS,
    ),
];

fn spec(key: &str) -> Option<Spec> {
    if let Some((_, default, ceiling)) = LIMITS.iter().find(|(name, _, _)| *name == key) {
        return Some(Spec {
            kind: Kind::Limit { ceiling: *ceiling },
            merge: Merge::Replace,
            apply: ApplyBoundary::NextTurn,
            default: json!(*default),
        });
    }
    Some(match key {
        "instructions.extra" => Spec {
            kind: Kind::StringList,
            merge: Merge::Concat,
            apply: ApplyBoundary::NextTurn,
            default: json!([]),
        },
        "ui.accessibility.reduced_motion" => Spec {
            kind: Kind::Bool,
            merge: Merge::Replace,
            apply: ApplyBoundary::Immediate,
            default: json!(false),
        },
        "ui.accessibility.screen_reader" => Spec {
            kind: Kind::Bool,
            merge: Merge::Replace,
            apply: ApplyBoundary::Immediate,
            default: json!(false),
        },
        "ui.notifications.terminal_bell" => Spec {
            kind: Kind::Bool,
            merge: Merge::Replace,
            apply: ApplyBoundary::Immediate,
            default: json!(false),
        },
        _ => return None,
    })
}

/// When a change to a setting takes effect.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApplyBoundary {
    /// The value is read when it is needed, so the change is visible at once.
    Immediate,
    /// The value is consumed when assembling the next turn.
    NextTurn,
}

impl ApplyBoundary {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Immediate => "immediate",
            Self::NextTurn => "next_turn",
        }
    }
}

/// Which scope an effective value came from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum SettingScope {
    /// No layer supplied a value; the compiled default stands.
    Default,
    /// The user's global layer.
    Global,
    /// A project layer.
    Project,
}

impl SettingScope {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Default => "default",
            Self::Global => "global",
            Self::Project => "project",
        }
    }

    fn from_layer(layer: ConfigLayer) -> Self {
        match layer {
            ConfigLayer::Global => Self::Global,
            ConfigLayer::Project => Self::Project,
        }
    }
}

/// One resolved setting, with where it came from and what it shadowed.
#[derive(Clone, Debug, PartialEq)]
pub struct SettingView {
    /// The dotted key.
    pub key: String,
    /// The nearest explicitly requested value, valid or not.
    pub requested_value: Option<Value>,
    /// The value in force.
    pub effective_value: Value,
    /// The scope of the nearest file that contributed a value.
    pub source_scope: SettingScope,
    /// The nearest file that contributed a value.
    pub source_ref: Option<PathBuf>,
    /// Every file that contributed a value, in application order.
    pub contributors: Vec<PathBuf>,
    /// Contributors whose value did not win. For a direct (`Replace`) key this
    /// is every contributor before the nearest; an accumulating (`Concat`) key
    /// overrides nothing, so it is empty.
    pub shadowed_sources: Vec<PathBuf>,
    /// Why the requested value is not effective, when it was rejected.
    pub validation_error: Option<String>,
    /// When a change takes effect.
    pub apply_boundary: ApplyBoundary,
    /// The schema version the effective value was resolved under.
    pub schema_version: u32,
    /// `blake3` over the key, schema version, and canonical value; pinned to a
    /// run so a later change is a new epoch rather than a silent rewrite.
    pub effective_digest: String,
}

/// A problem found while resolving settings.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigDiagnostic {
    /// The file involved, when the problem belongs to one.
    pub path: Option<PathBuf>,
    /// The key involved, when the problem belongs to one.
    pub key: Option<String>,
    /// What is wrong.
    pub detail: String,
}

/// The resolved configuration.
#[derive(Clone, Debug)]
pub struct EffectiveConfig {
    settings: BTreeMap<String, SettingView>,
    diagnostics: Vec<ConfigDiagnostic>,
    extras: Vec<(PathBuf, ConfigLayer)>,
}

/// The resolved event-log limits for a session or run (`DEC-058`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct LogLimits {
    /// The largest canonical byte length of one event.
    pub max_event_bytes: u64,
    /// Bytes per segment before rotation.
    pub max_segment_bytes: u64,
    /// Events per segment before rotation.
    pub max_segment_events: u64,
    /// The largest total event bytes one session or run may commit.
    pub max_stream_event_bytes: u64,
    /// Physically allocated control/recovery capacity.
    pub control_reserve_bytes: u64,
    /// Events decoded per replay batch.
    pub replay_batch_events: u64,
}

/// The resolved artifact limits for a session or run namespace (`DEC-058`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ArtifactLimits {
    /// The largest payload kept inline in an event.
    pub max_inline_event_bytes: u64,
    /// The largest single encoded object.
    pub max_object_bytes: u64,
    /// The largest encoded bytes for the whole namespace.
    pub namespace_bytes: u64,
    /// The largest decoded byte count.
    pub max_decoded_bytes: u64,
    /// The largest decoded pixel count.
    pub max_decoded_pixels: u64,
    /// The largest decoder expansion ratio.
    pub max_expansion_ratio: u64,
    /// Wall-clock bound for one decode.
    pub decode_timeout_ms: u64,
    /// Days an unreferenced object stays GC-eligible.
    pub retention_days: u64,
    /// Hours of grace for an orphan between publication and owner commit.
    pub orphan_grace_hours: u64,
}

impl EffectiveConfig {
    /// Returns the session event-log limits.
    ///
    /// # Panics
    /// Panics only if the schema and `load` disagree about a limit key, which
    /// is a programming error: every schema key is always present with a
    /// validated numeric value.
    #[must_use]
    pub fn session_log_limits(&self) -> LogLimits {
        LogLimits {
            max_event_bytes: self.number("session.log.max_event_bytes"),
            max_segment_bytes: self.number("session.log.max_segment_bytes"),
            max_segment_events: self.number("session.log.max_segment_events"),
            max_stream_event_bytes: self.number("session.log.max_session_event_bytes"),
            control_reserve_bytes: self.number("session.log.control_reserve_bytes"),
            replay_batch_events: self.number("session.log.replay_batch_events"),
        }
    }

    /// Returns the run event-log limits.
    ///
    /// # Panics
    /// As [`EffectiveConfig::session_log_limits`].
    #[must_use]
    pub fn run_log_limits(&self) -> LogLimits {
        LogLimits {
            max_event_bytes: self.number("run.log.max_event_bytes"),
            max_segment_bytes: self.number("run.log.max_segment_bytes"),
            max_segment_events: self.number("run.log.max_segment_events"),
            max_stream_event_bytes: self.number("run.log.max_run_event_bytes"),
            control_reserve_bytes: self.number("run.log.control_reserve_bytes"),
            replay_batch_events: self.number("run.log.replay_batch_events"),
        }
    }

    /// Returns the session artifact limits.
    ///
    /// # Panics
    /// As [`EffectiveConfig::session_log_limits`].
    #[must_use]
    pub fn session_artifact_limits(&self) -> ArtifactLimits {
        ArtifactLimits {
            max_inline_event_bytes: self.number("session.artifacts.max_inline_event_bytes"),
            max_object_bytes: self.number("session.artifacts.max_object_bytes"),
            namespace_bytes: self.number("session.artifacts.max_session_bytes"),
            max_decoded_bytes: self.number("session.artifacts.max_decoded_bytes"),
            max_decoded_pixels: self.number("session.artifacts.max_decoded_pixels"),
            max_expansion_ratio: self.number("session.artifacts.max_expansion_ratio"),
            decode_timeout_ms: self.number("session.artifacts.decode_timeout_ms"),
            retention_days: self.number("session.artifacts.retention_days"),
            orphan_grace_hours: self.number("session.artifacts.orphan_grace_hours"),
        }
    }

    /// Returns the run artifact limits (only the namespace ceiling differs from
    /// the session namespace).
    ///
    /// # Panics
    /// As [`EffectiveConfig::session_log_limits`].
    #[must_use]
    pub fn run_artifact_limits(&self) -> ArtifactLimits {
        ArtifactLimits {
            namespace_bytes: self.number("run.artifacts.max_run_bytes"),
            ..self.session_artifact_limits()
        }
    }

    fn number(&self, key: &str) -> u64 {
        self.get(key)
            .and_then(|view| view.effective_value.as_u64())
            .unwrap_or_else(|| panic!("`{key}` is a schema limit with a numeric effective value"))
    }
}

impl EffectiveConfig {
    /// Returns one setting view.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&SettingView> {
        self.settings.get(key)
    }

    /// Returns every setting view.
    #[must_use]
    pub fn settings(&self) -> &BTreeMap<String, SettingView> {
        &self.settings
    }

    /// Returns the problems found while resolving.
    #[must_use]
    pub fn diagnostics(&self) -> &[ConfigDiagnostic] {
        &self.diagnostics
    }

    /// Returns the `instructions.extra` entries as resolved absolute paths with
    /// the layer that declared them, in application order.
    #[must_use]
    pub fn extra_instruction_paths(&self) -> &[(PathBuf, ConfigLayer)] {
        &self.extras
    }
}

/// How a key's value combines across layers.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Merge {
    /// The nearest valid value wins.
    Replace,
    /// Values accumulate in application order.
    Concat,
}

/// The declared type of a key.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Bool,
    StringList,
    /// A nonzero integer no greater than a compiled ceiling.
    Limit {
        /// The compiled safety ceiling; a configuration may lower the value,
        /// never raise it (`DEC-058`, `ARCH/18`).
        ceiling: u64,
    },
}

#[derive(Clone)]
struct Spec {
    kind: Kind,
    merge: Merge,
    apply: ApplyBoundary,
    default: Value,
}

struct State {
    effective: Value,
    requested: Option<Value>,
    error: Option<String>,
    contributors: Vec<(ConfigLayer, PathBuf)>,
}

/// Resolves settings over a discovery result. Never fails: a layer that cannot
/// be read, parsed, or validated is reported and contributes nothing.
#[must_use]
pub fn load(discovery: &Discovery) -> EffectiveConfig {
    let mut diagnostics: Vec<ConfigDiagnostic> = discovery
        .issues
        .iter()
        .map(|issue| ConfigDiagnostic {
            path: Some(issue.path.clone()),
            key: None,
            detail: issue.detail.clone(),
        })
        .collect();
    let mut states: BTreeMap<String, State> = schema_keys()
        .iter()
        .map(|key| {
            let default = spec(key).expect("schema key").default;
            (
                (*key).to_owned(),
                State {
                    effective: default,
                    requested: None,
                    error: None,
                    contributors: Vec::new(),
                },
            )
        })
        .collect();
    let mut extras: Vec<(PathBuf, ConfigLayer)> = Vec::new();

    for source in &discovery.sources {
        if let Err(error) = crate::state_fs::refuse_symlink(&source.path) {
            diagnostics.push(diagnostic(Some(&source.path), None, error.to_string()));
            continue;
        }
        let text = match fs::read_to_string(&source.path) {
            Ok(text) => text,
            Err(error) => {
                diagnostics.push(diagnostic(
                    Some(&source.path),
                    None,
                    format!("cannot be read: {error}"),
                ));
                continue;
            }
        };
        let stripped = match crate::jsonc::strip(&text) {
            Ok(stripped) => stripped,
            Err(detail) => {
                diagnostics.push(diagnostic(Some(&source.path), None, detail));
                continue;
            }
        };
        let document: Value = match serde_json::from_str(&stripped) {
            Ok(document) => document,
            Err(error) => {
                diagnostics.push(diagnostic(
                    Some(&source.path),
                    None,
                    format!("invalid JSON: {error}"),
                ));
                continue;
            }
        };
        let Some(root) = document.as_object() else {
            diagnostics.push(diagnostic(
                Some(&source.path),
                None,
                "the configuration root must be an object".to_owned(),
            ));
            continue;
        };

        let mut leaves: Vec<(String, Value)> = Vec::new();
        for (group, value) in root {
            if !GROUPS.contains(&group.as_str()) {
                diagnostics.push(diagnostic(
                    Some(&source.path),
                    Some(group),
                    format!("unknown configuration group `{group}`"),
                ));
                continue;
            }
            let Some(object) = value.as_object() else {
                diagnostics.push(diagnostic(
                    Some(&source.path),
                    Some(group),
                    format!("group `{group}` must be an object"),
                ));
                continue;
            };
            flatten(object, group, &mut leaves);
        }

        for (key, value) in leaves {
            let Some(declared) = spec(&key) else {
                diagnostics.push(diagnostic(
                    Some(&source.path),
                    Some(&key),
                    format!("unknown configuration key `{key}`"),
                ));
                continue;
            };
            let state = states.get_mut(&key).expect("schema key");
            state.requested = Some(value.clone());
            let validated = match validate(declared.kind, &value) {
                Ok(validated) => validated,
                Err(detail) => {
                    state.error = Some(detail.clone());
                    diagnostics.push(diagnostic(Some(&source.path), Some(&key), detail));
                    continue;
                }
            };
            state.error = None;
            match declared.merge {
                Merge::Replace => {
                    state.effective = validated;
                    state.contributors.push((source.layer, source.path.clone()));
                }
                Merge::Concat => {
                    let entries = validated.as_array().expect("validated string list");
                    let array = state.effective.as_array_mut().expect("array default");
                    for entry in entries {
                        let raw = entry.as_str().expect("validated string");
                        let path = resolve(&source.root, raw);
                        array.push(Value::String(path.to_string_lossy().into_owned()));
                        extras.push((path, source.layer));
                    }
                    state.contributors.push((source.layer, source.path.clone()));
                }
            }
        }
    }

    let settings = states
        .into_iter()
        .map(|(key, state)| {
            let declared = spec(&key).expect("schema key");
            let nearest = state.contributors.last().cloned();
            let shadowed = if declared.merge == Merge::Replace {
                state.contributors[..state.contributors.len().saturating_sub(1)]
                    .iter()
                    .map(|(_, path)| path.clone())
                    .collect()
            } else {
                Vec::new()
            };
            let view = SettingView {
                key: key.clone(),
                requested_value: state.requested,
                effective_digest: digest(&key, &state.effective),
                effective_value: state.effective,
                source_scope: nearest
                    .as_ref()
                    .map_or(SettingScope::Default, |(layer, _)| {
                        SettingScope::from_layer(*layer)
                    }),
                source_ref: nearest.map(|(_, path)| path),
                contributors: state
                    .contributors
                    .into_iter()
                    .map(|(_, path)| path)
                    .collect(),
                shadowed_sources: shadowed,
                validation_error: state.error,
                apply_boundary: declared.apply,
                schema_version: SCHEMA_VERSION,
            };
            (key, view)
        })
        .collect();

    EffectiveConfig {
        settings,
        diagnostics,
        extras,
    }
}

fn diagnostic(path: Option<&Path>, key: Option<&str>, detail: String) -> ConfigDiagnostic {
    ConfigDiagnostic {
        path: path.map(Path::to_path_buf),
        key: key.map(str::to_owned),
        detail,
    }
}

fn flatten(object: &serde_json::Map<String, Value>, prefix: &str, out: &mut Vec<(String, Value)>) {
    for (key, value) in object {
        let dotted = format!("{prefix}.{key}");
        match value {
            Value::Object(nested) if !nested.is_empty() => flatten(nested, &dotted, out),
            other => out.push((dotted, other.clone())),
        }
    }
}

fn validate(kind: Kind, value: &Value) -> Result<Value, String> {
    match kind {
        Kind::Bool => value
            .as_bool()
            .map(Value::Bool)
            .ok_or_else(|| "must be a boolean".to_owned()),
        Kind::StringList => {
            let Some(array) = value.as_array() else {
                return Err("must be an array of strings".to_owned());
            };
            if array.iter().any(|entry| !entry.is_string()) {
                return Err("must contain only strings".to_owned());
            }
            Ok(value.clone())
        }
        Kind::Limit { ceiling } => {
            let Some(number) = value.as_u64() else {
                return Err("must be a non-negative integer".to_owned());
            };
            if number == 0 {
                return Err("must be nonzero".to_owned());
            }
            if number > ceiling {
                return Err(format!("exceeds the compiled ceiling of {ceiling}"));
            }
            Ok(Value::from(number))
        }
    }
}

/// Resolves a declared path against the layer root that declared it.
fn resolve(layer_root: &Path, raw: &str) -> PathBuf {
    let path = Path::new(raw);
    if path.is_absolute() {
        path.to_path_buf()
    } else {
        layer_root.join(path)
    }
}

fn digest(key: &str, value: &Value) -> String {
    let canonical = json!({
        "key": key,
        "schema_version": SCHEMA_VERSION,
        "value": value,
    });
    blake3::hash(canonical.to_string().as_bytes())
        .to_hex()
        .to_string()
}
