//! Credential redaction (`REQ-PROV-004`, `REQ-AUDIT-003`).
//!
//! The redactor is the last line of defence before text reaches a log, an error
//! message, or the audit trail. It replaces known secret values and common
//! bearer/JSON-secret shapes. The built-in field set may be extended but never
//! reduced.

use serde_json::Value;

/// The placeholder substituted for redacted material.
pub const REDACTED: &str = "***";

const BUILTIN_FIELDS: &[&str] = &[
    "authorization",
    "api_key",
    "apikey",
    "api-key",
    "x-api-key",
    "access_token",
    "refresh_token",
    "token",
    "secret",
    "password",
];

/// Replaces known secrets and credential-shaped substrings.
#[derive(Clone, Debug, Default)]
pub struct Redactor {
    secrets: Vec<String>,
}

impl Redactor {
    /// Builds a redactor for the given secret values.
    ///
    /// Empty values are ignored; all non-empty values are redacted verbatim.
    #[must_use]
    pub fn new(secrets: impl IntoIterator<Item = String>) -> Self {
        Self {
            secrets: secrets.into_iter().filter(|s| !s.is_empty()).collect(),
        }
    }

    /// Adds a secret to the redaction set.
    pub fn add(&mut self, secret: impl Into<String>) {
        let secret = secret.into();
        if !secret.is_empty() {
            self.secrets.push(secret);
        }
    }

    /// Redacts secrets and bearer tokens in `text`.
    #[must_use]
    pub fn redact(&self, text: &str) -> String {
        let mut out = text.to_owned();
        for secret in &self.secrets {
            out = out.replace(secret.as_str(), REDACTED);
        }
        // Redact `Bearer <token>` / `bearer <token>` shapes even when the
        // token was not registered.
        out = redact_bearer(&out);
        out
    }

    /// Redacts sensitive JSON fields in place, recursively.
    pub fn redact_json(&self, value: &mut Value) {
        match value {
            Value::Object(map) => {
                for (key, entry) in map.iter_mut() {
                    if is_sensitive_field(key) {
                        *entry = Value::String(REDACTED.to_owned());
                    } else {
                        self.redact_json(entry);
                    }
                }
            }
            Value::Array(items) => {
                for item in items {
                    self.redact_json(item);
                }
            }
            Value::String(text) => {
                let redacted = self.redact(text);
                if &redacted != text {
                    *text = redacted;
                }
            }
            _ => {}
        }
    }
}

/// Returns whether a JSON field name is sensitive by default.
#[must_use]
pub fn is_sensitive_field(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    BUILTIN_FIELDS.contains(&lower.as_str())
}

fn redact_bearer(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(index) = find_bearer(rest) {
        out.push_str(&rest[..index]);
        // Find the end of the token that follows "Bearer ".
        let token_start = index + "Bearer ".len();
        let token_end = rest[token_start..]
            .find(|c: char| c.is_whitespace() || c == '"' || c == '\'' || c == ',' || c == '}')
            .map_or(rest.len(), |offset| token_start + offset);
        out.push_str("Bearer ");
        out.push_str(REDACTED);
        rest = &rest[token_end..];
    }
    out.push_str(rest);
    out
}

fn find_bearer(text: &str) -> Option<usize> {
    text.find("Bearer ").or_else(|| text.find("bearer "))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn replaces_known_secret_values() {
        let redactor = Redactor::new(["sk-abc123".to_owned()]);
        let text = redactor.redact("failed with key sk-abc123 attached");
        assert_eq!(text, "failed with key *** attached");
        assert!(!text.contains("sk-abc123"));
    }

    #[test]
    fn redacts_bearer_tokens_even_when_unregistered() {
        let redactor = Redactor::default();
        assert_eq!(
            redactor.redact("Authorization: Bearer tok_999"),
            "Authorization: Bearer ***"
        );
    }

    #[test]
    fn redacts_sensitive_json_fields_recursively() {
        let redactor = Redactor::new(["topsecret".to_owned()]);
        let mut value = json!({
            "model": "m",
            "api_key": "plain",
            "nested": { "authorization": "Bearer abc", "note": "topsecret" }
        });
        redactor.redact_json(&mut value);
        assert_eq!(value["api_key"], "***");
        assert_eq!(value["nested"]["authorization"], "***");
        assert_eq!(value["nested"]["note"], "***");
        assert_eq!(value["model"], "m");
    }
}
