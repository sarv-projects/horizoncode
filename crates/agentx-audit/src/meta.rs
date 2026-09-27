//! Bounded, typed audit metadata.
//!
//! Entries carry **refs, digests and bounded metadata only** — never documents,
//! file bodies, prompt text or completion text (`ARCH/14-AUDIT.md` §Data).
//! A metadata value is a scalar, so the canonical form contains no floats and no
//! nested objects: verification is byte-deterministic.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

use crate::error::AuditError;

/// Maximum number of metadata keys on one entry.
pub const MAX_META_FIELDS: usize = 32;
/// Maximum byte length of one metadata string value.
pub const MAX_META_TEXT: usize = 256;
/// Maximum byte length of an action string.
pub const MAX_ACTION: usize = 128;
/// Maximum byte length of a resource reference.
pub const MAX_RESOURCE: usize = 512;
/// Maximum byte length of a reference (ticket/approval/receipt/run id).
pub const MAX_REF: usize = 128;

/// The metadata key that records that a redaction pass replaced a value.
pub const REDACTION_NOTE_KEY: &str = "redacted_fields";

/// A bounded scalar attached to an entry.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum MetaValue {
    /// A boolean flag.
    Bool(bool),
    /// A signed 64-bit integer (never a float).
    Int(i64),
    /// A short string.
    Text(String),
}

impl MetaValue {
    /// Builds a text value.
    #[must_use]
    pub fn text(value: impl Into<String>) -> Self {
        Self::Text(value.into())
    }

    /// Builds an integer value.
    #[must_use]
    pub fn int(value: i64) -> Self {
        Self::Int(value)
    }

    /// Returns the text payload when this value is text.
    #[must_use]
    pub fn as_text(&self) -> Option<&str> {
        match self {
            Self::Text(value) => Some(value),
            _ => None,
        }
    }

    /// Returns the integer payload when this value is an integer.
    #[must_use]
    pub fn as_int(&self) -> Option<i64> {
        match self {
            Self::Int(value) => Some(*value),
            _ => None,
        }
    }
}

impl From<bool> for MetaValue {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<i64> for MetaValue {
    fn from(value: i64) -> Self {
        Self::Int(value)
    }
}

impl From<u64> for MetaValue {
    fn from(value: u64) -> Self {
        Self::Int(value as i64)
    }
}

impl From<String> for MetaValue {
    fn from(value: String) -> Self {
        Self::Text(value)
    }
}

impl From<&str> for MetaValue {
    fn from(value: &str) -> Self {
        Self::Text(value.to_owned())
    }
}

/// The bounded metadata map on one entry.
pub type Meta = BTreeMap<String, MetaValue>;

/// Validates the metadata bounds, failing closed when exceeded.
///
/// # Errors
/// Returns [`AuditError::FieldTooLarge`] when a key count, key length, or
/// string value exceeds its bound.
pub fn validate_meta(meta: &Meta) -> Result<(), AuditError> {
    if meta.len() > MAX_META_FIELDS {
        return Err(AuditError::FieldTooLarge {
            field: "meta",
            detail: format!("{} keys, maximum {MAX_META_FIELDS}", meta.len()),
        });
    }
    for (key, value) in meta {
        if key.is_empty() || key.len() > MAX_META_TEXT {
            return Err(AuditError::FieldTooLarge {
                field: "meta key",
                detail: format!("`{key}` exceeds {MAX_META_TEXT} bytes"),
            });
        }
        if let MetaValue::Text(text) = value
            && text.len() > MAX_META_TEXT
        {
            return Err(AuditError::FieldTooLarge {
                field: "meta value",
                detail: format!("`{key}` is {} bytes, maximum {MAX_META_TEXT}", text.len()),
            });
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_a_small_meta_map() {
        let mut meta = Meta::new();
        meta.insert("bytes".to_owned(), MetaValue::int(12));
        meta.insert("created".to_owned(), MetaValue::Bool(true));
        assert!(validate_meta(&meta).is_ok());
    }

    #[test]
    fn rejects_an_oversized_text_value() {
        let mut meta = Meta::new();
        meta.insert(
            "note".to_owned(),
            MetaValue::text("x".repeat(MAX_META_TEXT + 1)),
        );
        let error = validate_meta(&meta).unwrap_err();
        assert!(matches!(
            error,
            AuditError::FieldTooLarge {
                field: "meta value",
                ..
            }
        ));
    }

    #[test]
    fn rejects_too_many_keys() {
        let meta: Meta = (0..=MAX_META_FIELDS)
            .map(|index| (format!("k{index}"), MetaValue::int(index as i64)))
            .collect();
        let error = validate_meta(&meta).unwrap_err();
        assert!(matches!(
            error,
            AuditError::FieldTooLarge { field: "meta", .. }
        ));
    }

    #[test]
    fn meta_values_serialize_without_floats() {
        let mut meta = Meta::new();
        meta.insert("n".to_owned(), MetaValue::int(7));
        let line = serde_json::to_string(&meta).unwrap();
        assert_eq!(line, r#"{"n":{"int":7}}"#);
        assert!(!line.contains('.'));
    }
}
