//! Strict decoder and canonical digest for Core-owned ContextSelectionV1 refs.

use crate::messagepack::{self, FRAME_LIMITS, Value};
use std::collections::BTreeSet;

const DOMAIN: &[u8] = b"horizoncode.context-selection.v1\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContextSelectionV1 {
    value: Value,
    pub(crate) session_id: String,
    pub(crate) mode: String,
    pub(crate) source_revision: u64,
    pub(crate) sources: Vec<ContextSelectionSourceV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContextSelectionSourceV1 {
    pub(crate) message_id: String,
    pub(crate) content_digest: String,
}

impl ContextSelectionV1 {
    pub(crate) fn decode(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else {
            return None;
        };
        if fields.len() != 5
            || fields.keys().any(|key| {
                !matches!(
                    key.as_str(),
                    "schemaVersion" | "sessionID" | "mode" | "sourceRevision" | "sources"
                )
            })
            || fields.get("schemaVersion") != Some(&Value::Unsigned(1))
        {
            return None;
        }
        let session_id = match fields.get("sessionID")? {
            Value::String(value)
                if value.starts_with("ses_")
                    && value.len() <= 132
                    && value[4..]
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
                    && !value[4..].is_empty() =>
            {
                value.clone()
            }
            _ => return None,
        };
        let mode = match fields.get("mode")? {
            Value::String(value)
                if matches!(value.as_str(), "fresh" | "conversation_slice" | "fork") =>
            {
                value.clone()
            }
            _ => return None,
        };
        let source_revision = match fields.get("sourceRevision")? {
            Value::String(value) => canonical_u64(value)?,
            _ => return None,
        };
        let Value::Array(sources) = fields.get("sources")? else {
            return None;
        };
        if sources.len() > 64
            || (mode == "fresh" && !sources.is_empty())
            || (mode != "fresh" && sources.is_empty())
        {
            return None;
        }
        let mut seen = BTreeSet::new();
        let mut decoded = Vec::with_capacity(sources.len());
        for source in sources {
            let Value::Map(fields) = source else {
                return None;
            };
            if fields.len() != 3
                || fields
                    .keys()
                    .any(|key| !matches!(key.as_str(), "kind" | "messageID" | "contentDigest"))
                || fields.get("kind") != Some(&Value::String("session-message".to_owned()))
            {
                return None;
            }
            let message_id = match fields.get("messageID")? {
                Value::String(value)
                    if value.starts_with("msg_") && valid_identifier(value, 256) =>
                {
                    value.clone()
                }
                _ => return None,
            };
            if !seen.insert(message_id.clone()) {
                return None;
            }
            let content_digest = match fields.get("contentDigest")? {
                Value::String(value) if valid_source_digest(value) => value.clone(),
                _ => return None,
            };
            decoded.push(ContextSelectionSourceV1 {
                message_id,
                content_digest,
            });
        }
        Some(Self {
            value: value.clone(),
            session_id,
            mode,
            source_revision,
            sources: decoded,
        })
    }

    pub(crate) fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        let bytes = messagepack::encode(&self.value, FRAME_LIMITS)?;
        let mut preimage = Vec::with_capacity(DOMAIN.len() + bytes.len());
        preimage.extend_from_slice(DOMAIN);
        preimage.extend_from_slice(&bytes);
        Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
    }

    #[cfg(test)]
    pub(crate) fn test_fixture() -> Self {
        let value = Value::Map(std::collections::BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            (
                "sessionID".to_owned(),
                Value::String("ses_01J9ABCDEF0123456789ABCDEFGH".to_owned()),
            ),
            ("mode".to_owned(), Value::String("fresh".to_owned())),
            ("sourceRevision".to_owned(), Value::String("1".to_owned())),
            ("sources".to_owned(), Value::Array(Vec::new())),
        ]));
        Self::decode(&value).expect("test ContextSelection fixture must be valid")
    }
}

fn canonical_u64(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || value.len() > 20
        || !value.bytes().all(|b| b.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn valid_identifier(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && !value
            .chars()
            .any(|ch| ch.is_whitespace() || ch.is_control())
}

fn valid_source_digest(value: &str) -> bool {
    ["sha256:", "blake3:"].iter().any(|prefix| {
        value.strip_prefix(prefix).is_some_and(|hex| {
            hex.len() == 64
                && hex
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
        })
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(input: serde_json::Value) -> Value {
        match input {
            serde_json::Value::Null => Value::Nil,
            serde_json::Value::Bool(value) => Value::Bool(value),
            serde_json::Value::Number(value) if value.is_u64() => {
                Value::Unsigned(value.as_u64().unwrap())
            }
            serde_json::Value::Number(value) if value.is_i64() => {
                Value::Signed(value.as_i64().unwrap())
            }
            serde_json::Value::Number(value) => Value::Float(value.as_f64().unwrap().to_bits()),
            serde_json::Value::String(value) => Value::String(value),
            serde_json::Value::Array(values) => {
                Value::Array(values.into_iter().map(value).collect())
            }
            serde_json::Value::Object(values) => {
                Value::Map(values.into_iter().map(|(k, v)| (k, value(v))).collect())
            }
        }
    }

    fn valid() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/context-selection-v1.json")).unwrap()
    }

    #[test]
    fn strict_context_selection_decoder_binds_the_full_canonical_map() {
        let fixture = valid();
        let selection = fixture["selection"].clone();
        let decoded = ContextSelectionV1::decode(&value(selection)).unwrap();
        assert_eq!(decoded.session_id, "ses_01J9ABCDEF0123456789ABCDEFGH");
        assert_eq!(decoded.source_revision, 12);
        assert_eq!(
            decoded.digest().unwrap(),
            fixture["digest"].as_str().unwrap()
        );
        let mut unknown = fixture["selection"].clone();
        unknown["unexpected"] = json!(true);
        assert!(ContextSelectionV1::decode(&value(unknown)).is_none());
        let mut duplicate = fixture["selection"].clone();
        let first_source = duplicate["sources"][0].clone();
        duplicate["sources"]
            .as_array_mut()
            .unwrap()
            .push(first_source);
        assert!(ContextSelectionV1::decode(&value(duplicate)).is_none());
        let mut overflow = fixture["selection"].clone();
        overflow["sourceRevision"] = json!("18446744073709551616");
        assert!(ContextSelectionV1::decode(&value(overflow)).is_none());
        let mut fresh = fixture["selection"].clone();
        fresh["mode"] = json!("fresh");
        assert!(ContextSelectionV1::decode(&value(fresh)).is_none());
        let mut malformed_session = fixture["selection"].clone();
        malformed_session["sessionID"] = json!("session-without-prefix");
        assert!(ContextSelectionV1::decode(&value(malformed_session)).is_none());
    }
}
