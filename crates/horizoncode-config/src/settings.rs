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

/// The groups this schema knows. A top-level group outside the list is reported
/// once by name instead of once per leaf.
const GROUPS: &[&str] = &["instructions", "ui"];

/// The keys this schema resolves, in a stable order.
#[must_use]
pub fn schema_keys() -> &'static [&'static str] {
    &[
        "instructions.extra",
        "ui.accessibility.reduced_motion",
        "ui.accessibility.screen_reader",
        "ui.notifications.terminal_bell",
    ]
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
}

#[derive(Clone, Copy)]
struct Spec {
    kind: Kind,
    merge: Merge,
    apply: ApplyBoundary,
    default: fn() -> Value,
}

fn spec(key: &str) -> Option<Spec> {
    Some(match key {
        "instructions.extra" => Spec {
            kind: Kind::StringList,
            merge: Merge::Concat,
            apply: ApplyBoundary::NextTurn,
            default: || json!([]),
        },
        "ui.accessibility.reduced_motion" => Spec {
            kind: Kind::Bool,
            merge: Merge::Replace,
            apply: ApplyBoundary::Immediate,
            default: || json!(false),
        },
        "ui.accessibility.screen_reader" => Spec {
            kind: Kind::Bool,
            merge: Merge::Replace,
            apply: ApplyBoundary::Immediate,
            default: || json!(false),
        },
        "ui.notifications.terminal_bell" => Spec {
            kind: Kind::Bool,
            merge: Merge::Replace,
            apply: ApplyBoundary::Immediate,
            default: || json!(false),
        },
        _ => return None,
    })
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
                    effective: default(),
                    requested: None,
                    error: None,
                    contributors: Vec::new(),
                },
            )
        })
        .collect();
    let mut extras: Vec<(PathBuf, ConfigLayer)> = Vec::new();

    for source in &discovery.sources {
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
