//! Config discovery and JSONC parsing (`ARCH/12-GUARD.md`, `ARCH/18-CONFIG.md`).
//!
//! Discovery walks global → project (nearest wins). A malformed layer is
//! rejected and the caller installs a deny-all ceiling for that layer position
//! so a typo can never widen the effective posture (fail closed).

use std::path::{Path, PathBuf};

use serde_json::Value;

use crate::decision::GuardMode;
use crate::error::GuardError;
use crate::rule::{Effect, Rule, RuleLayer, RuleSource};

/// The configuration directory name used during the project walk.
pub const PROJECT_CONFIG_DIR: &str = ".agentx";

/// The configuration file name.
pub const CONFIG_FILE: &str = "config.jsonc";

/// A parsed guard document.
#[derive(Clone, Debug, Default)]
pub struct GuardDocument {
    /// The mode, when specified.
    pub mode: Option<GuardMode>,
    /// The unmatched-action effect, when specified.
    pub unmatched: Option<Effect>,
    /// The approval timeout in milliseconds, when specified.
    pub approval_timeout_ms: Option<u64>,
    /// The ordered rules.
    pub rules: Vec<Rule>,
}

/// Returns the global config path: `$AGENTX_HOME/config.jsonc` when set,
/// otherwise `~/.agentx/config.jsonc`.
#[must_use]
pub fn global_config_path() -> Option<PathBuf> {
    let base = std::env::var_os("AGENTX_HOME")
        .filter(|value| !value.is_empty())
        .map(PathBuf::from)
        .or_else(dirs::home_dir)?;
    Some(base.join(CONFIG_FILE))
}

/// Walks from `workspace` up to the filesystem root and returns the project
/// config paths outer-to-inner (the workspace's own file last, so nearest wins).
#[must_use]
pub fn project_config_paths(workspace: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut walk = Some(workspace);
    while let Some(dir) = walk {
        let candidate = dir.join(PROJECT_CONFIG_DIR).join(CONFIG_FILE);
        if candidate.is_file() {
            found.push(candidate);
        }
        walk = dir.parent();
    }
    found.reverse();
    found
}

/// Reads and parses one config file into a layer.
///
/// # Errors
/// Returns [`GuardError`] when the file cannot be read or is malformed.
pub fn load_layer(path: &Path, source: RuleSource) -> Result<RuleLayer, GuardError> {
    let text = std::fs::read_to_string(path)
        .map_err(|error| GuardError::io(path.display().to_string(), error.to_string()))?;
    let document = parse_document(&text, &path.display().to_string())?;
    Ok(RuleLayer {
        source,
        rules: document.rules,
        file: Some(path.display().to_string()),
    })
}

/// Parses a JSONC guard document with strict key/effect validation.
///
/// # Errors
/// Returns [`GuardError::Config`] for malformed JSONC or any unknown key,
/// effect, mode or unmatched value.
pub fn parse_document(text: &str, path: &str) -> Result<GuardDocument, GuardError> {
    let stripped = strip_jsonc(text).map_err(|message| GuardError::config(path, message))?;
    let value: Value = serde_json::from_str(&stripped)
        .map_err(|error| GuardError::config(path, format!("invalid JSON: {error}")))?;
    let mut document = GuardDocument::default();
    let root = value
        .as_object()
        .ok_or_else(|| GuardError::config(path, "config root must be an object"))?;
    for (key, value) in root {
        match key.as_str() {
            "guard" => parse_guard(value, path, &mut document)?,
            other => {
                return Err(GuardError::config(
                    path,
                    format!("unknown top-level key `{other}`"),
                ));
            }
        }
    }
    Ok(document)
}

fn parse_guard(value: &Value, path: &str, document: &mut GuardDocument) -> Result<(), GuardError> {
    let guard = value
        .as_object()
        .ok_or_else(|| GuardError::config(path, "`guard` must be an object"))?;
    for (key, value) in guard {
        match key.as_str() {
            "mode" => {
                let raw = value
                    .as_str()
                    .ok_or_else(|| GuardError::config(path, "`guard.mode` must be a string"))?;
                document.mode = Some(GuardMode::parse(raw, path)?);
            }
            "unmatched" => {
                let raw = value.as_str().ok_or_else(|| {
                    GuardError::config(path, "`guard.unmatched` must be a string")
                })?;
                let effect = Effect::parse(raw, path)?;
                if effect == Effect::Allow {
                    return Err(GuardError::config(
                        path,
                        "`guard.unmatched` may not be `allow` (fail-closed)",
                    ));
                }
                document.unmatched = Some(effect);
            }
            "approval" => {
                let approval = value.as_object().ok_or_else(|| {
                    GuardError::config(path, "`guard.approval` must be an object")
                })?;
                for (key, value) in approval {
                    match key.as_str() {
                        "default_timeout_ms" => {
                            document.approval_timeout_ms = Some(value.as_u64().ok_or_else(|| {
                                GuardError::config(
                                    path,
                                    "`guard.approval.default_timeout_ms` must be a non-negative integer",
                                )
                            })?);
                        }
                        other => {
                            return Err(GuardError::config(
                                path,
                                format!("unknown `guard.approval` key `{other}`"),
                            ));
                        }
                    }
                }
            }
            "rules" => {
                let rules = value
                    .as_array()
                    .ok_or_else(|| GuardError::config(path, "`guard.rules` must be an array"))?;
                for (index, value) in rules.iter().enumerate() {
                    document.rules.push(parse_rule(value, path, index)?);
                }
            }
            other => {
                return Err(GuardError::config(
                    path,
                    format!("unknown `guard` key `{other}`"),
                ));
            }
        }
    }
    Ok(())
}

fn parse_rule(value: &Value, path: &str, index: usize) -> Result<Rule, GuardError> {
    let object = value
        .as_object()
        .ok_or_else(|| GuardError::config(path, format!("rule {index} must be an object")))?;
    let mut action = None;
    let mut resource = None;
    let mut effect = None;
    for (key, value) in object {
        match key.as_str() {
            "action" => action = Some(require_string(value, path, index, "action")?),
            "resource" => resource = Some(require_string(value, path, index, "resource")?),
            "effect" => {
                effect = Some(Effect::parse(
                    &require_string(value, path, index, "effect")?,
                    path,
                )?);
            }
            other => {
                return Err(GuardError::config(
                    path,
                    format!("unknown key `{other}` in rule {index}"),
                ));
            }
        }
    }
    let rule = Rule {
        action: action
            .ok_or_else(|| GuardError::config(path, format!("rule {index} is missing `action`")))?,
        resource: resource.ok_or_else(|| {
            GuardError::config(path, format!("rule {index} is missing `resource`"))
        })?,
        effect: effect
            .ok_or_else(|| GuardError::config(path, format!("rule {index} is missing `effect`")))?,
    };
    rule.validate()?;
    Ok(rule)
}

fn require_string(
    value: &Value,
    path: &str,
    index: usize,
    key: &str,
) -> Result<String, GuardError> {
    value
        .as_str()
        .map(str::to_owned)
        .filter(|text| !text.is_empty())
        .ok_or_else(|| {
            GuardError::config(
                path,
                format!("rule {index} `{key}` must be a non-empty string"),
            )
        })
}

/// Strips `//` and `/* */` comments and trailing commas from JSONC.
///
/// # Errors
/// Returns a message for an unterminated block comment or string.
pub fn strip_jsonc(input: &str) -> Result<String, String> {
    let bytes: Vec<char> = input.chars().collect();
    let mut out = String::with_capacity(input.len());
    let mut index = 0;
    let mut in_string = false;
    while index < bytes.len() {
        let ch = bytes[index];
        if in_string {
            out.push(ch);
            if ch == '\\' {
                if let Some(next) = bytes.get(index + 1) {
                    out.push(*next);
                    index += 2;
                    continue;
                }
            } else if ch == '"' {
                in_string = false;
            }
            index += 1;
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(ch);
                index += 1;
            }
            '/' if bytes.get(index + 1) == Some(&'/') => {
                while index < bytes.len() && bytes[index] != '\n' {
                    index += 1;
                }
            }
            '/' if bytes.get(index + 1) == Some(&'*') => {
                index += 2;
                loop {
                    match (bytes.get(index), bytes.get(index + 1)) {
                        (Some('*'), Some('/')) => {
                            index += 2;
                            break;
                        }
                        (Some(_), _) => index += 1,
                        (None, _) => return Err("unterminated block comment".to_owned()),
                    }
                }
            }
            _ => {
                out.push(ch);
                index += 1;
            }
        }
    }
    if in_string {
        return Err("unterminated string".to_owned());
    }
    Ok(remove_trailing_commas(&out))
}

fn remove_trailing_commas(input: &str) -> String {
    let mut out = String::with_capacity(input.len());
    let mut in_string = false;
    let chars: Vec<char> = input.chars().collect();
    for (index, ch) in chars.iter().enumerate() {
        if in_string {
            out.push(*ch);
            if *ch == '\\' {
                // Skip the escaped character on the next iteration.
            } else if *ch == '"' {
                in_string = false;
            }
            continue;
        }
        match ch {
            '"' => {
                in_string = true;
                out.push(*ch);
            }
            ',' => {
                let next = chars[index + 1..]
                    .iter()
                    .find(|candidate| !candidate.is_whitespace());
                if matches!(next, Some('}') | Some(']')) {
                    // Drop the trailing comma.
                } else {
                    out.push(*ch);
                }
            }
            _ => out.push(*ch),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_a_guard_document_with_comments_and_trailing_commas() {
        let text = r#"
        {
          // the mode
          "guard": {
            "mode": "plan",
            "unmatched": "deny",
            "rules": [
              { "action": "fs.read", "resource": "**", "effect": "allow" },
            ],
          },
        }
        "#;
        let document = parse_document(text, "test").unwrap();
        assert_eq!(document.mode, Some(GuardMode::Plan));
        assert_eq!(document.unmatched, Some(Effect::Deny));
        assert_eq!(document.rules.len(), 1);
    }

    #[test]
    fn unknown_keys_and_effects_fail_closed() {
        assert!(parse_document(r#"{"guard":{"mystery":1}}"#, "t").is_err());
        assert!(
            parse_document(
                r#"{"guard":{"rules":[{"action":"a","resource":"b","effect":"permit"}]}}"#,
                "t"
            )
            .is_err()
        );
        assert!(parse_document(r#"{"guard":{"unmatched":"allow"}}"#, "t").is_err());
    }
}
