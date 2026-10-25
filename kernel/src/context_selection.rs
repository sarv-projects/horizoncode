//! Strict decoder and canonical digest for Core-owned ContextSelectionV1 refs.

use crate::messagepack::{self, FRAME_LIMITS, Value};
use std::collections::BTreeSet;

const DOMAIN: &[u8] = b"horizoncode.context-selection.v1\0";
const MANAGED_TASK_DOMAIN: &[u8] = b"horizoncode.context-selection.managed-task.v1\0";

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContextSelectionV1 {
    value: Value,
    pub(crate) lane: String,
    pub(crate) session_id: String,
    pub(crate) request_id: String,
    pub(crate) attempt_id: Option<String>,
    pub(crate) request_sequence: Option<u64>,
    pub(crate) mode: String,
    pub(crate) source_revision: u64,
    pub(crate) sources: Vec<ContextSelectionSourceV1>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ContextSelectionSourceV1 {
    pub(crate) kind: String,
    pub(crate) source_id: String,
    pub(crate) source_revision: String,
    pub(crate) content_digest: String,
    pub(crate) source_authority: String,
    pub(crate) trust: String,
    pub(crate) inclusion_reason: String,
    pub(crate) harness_revision: Option<u64>,
}

impl ContextSelectionV1 {
    pub(crate) fn wire_value(&self) -> Value { self.value.clone() }

    pub(crate) fn decode_json(value: &serde_json::Value) -> Option<Self> {
        fn convert(value: &serde_json::Value) -> Option<Value> {
            Some(match value {
                serde_json::Value::Null => Value::Null,
                serde_json::Value::Bool(value) => Value::Bool(*value),
                serde_json::Value::Number(value) if value.is_u64() => Value::Unsigned(value.as_u64()?),
                serde_json::Value::Number(value) if value.is_i64() => Value::Signed(value.as_i64()?),
                serde_json::Value::Number(value) => Value::Float(value.as_f64()?.to_bits()),
                serde_json::Value::String(value) => Value::String(value.clone()),
                serde_json::Value::Array(values) => Value::Array(values.iter().map(convert).collect::<Option<Vec<_>>>()?),
                serde_json::Value::Object(values) => Value::Map(values.iter().map(|(key, value)| Some((key.clone(), convert(value)?))).collect::<Option<std::collections::BTreeMap<_, _>>>()?),
            })
        }
        Self::decode(&convert(value)?)
    }

    pub(crate) fn decode(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else { return None };
        if !(7..=9).contains(&fields.len())
            || fields.keys().any(|key| !matches!(key.as_str(),
                "schemaVersion" | "lane" | "sessionID" | "requestID" | "attemptID" | "requestSequence" | "mode" | "sourceRevision" | "sources"))
            || fields.get("schemaVersion") != Some(&Value::Unsigned(1))
        { return None }
        let lane = match fields.get("lane")? {
            Value::String(value) if matches!(value.as_str(), "direct" | "managed") => value.clone(),
            _ => return None,
        };
        let session_id = match fields.get("sessionID")? {
            Value::String(value) if valid_session(value) => value.clone(),
            _ => return None,
        };
        let request_id = match fields.get("requestID")? {
            Value::String(value) if valid_opaque_id(value) => value.clone(),
            _ => return None,
        };
        let attempt_id = match fields.get("attemptID") {
            None => None,
            Some(Value::String(value)) if valid_opaque_id(value) => Some(value.clone()),
            _ => return None,
        };
        let request_sequence = match fields.get("requestSequence") {
            None => None,
            Some(Value::String(value)) => canonical_u64(value).filter(|sequence| (1..=1024).contains(sequence)),
            _ => return None,
        };
        if attempt_id.is_some() != request_sequence.is_some()
            || (lane == "managed") != attempt_id.is_some()
        { return None }
        let mode = match fields.get("mode")? {
            Value::String(value) if matches!(value.as_str(), "fresh" | "conversation_slice" | "fork") => value.clone(),
            _ => return None,
        };
        let source_revision = match fields.get("sourceRevision")? {
            Value::String(value) => canonical_u64(value)?,
            _ => return None,
        };
        let Value::Array(sources) = fields.get("sources")? else { return None };
        if sources.is_empty() || sources.len() > 64 { return None }
        let mut seen = BTreeSet::new();
        let mut decoded = Vec::with_capacity(sources.len());
        let mut has_session_message = false;
        for source in sources {
            let Value::Map(fields) = source else { return None };
            if !(fields.len() == 8 || fields.len() == 9) || fields.keys().any(|key| !matches!(key.as_str(),
                "kind" | "sourceID" | "sourceRevision" | "contentDigest" | "sourceAuthority" | "trust" | "included" | "inclusionReason" | "harnessRevision"))
            { return None }
            let kind = text_enum(fields, "kind", &["session-message", "agent-profile", "managed-task", "accepted-spec", "provider-input", "tool", "instruction", "skill", "prompt-template", "artifact"])?;
            let source_id = match fields.get("sourceID")? {
                Value::String(value) if valid_opaque_id(value) => value.clone(),
                _ => return None,
            };
            if kind == "session-message" && !source_id.starts_with("msg_") { return None }
            if !seen.insert((kind.clone(), source_id.clone())) { return None }
            let source_revision = match fields.get("sourceRevision")? {
                Value::String(value) if valid_opaque_id(value) => value.clone(),
                _ => return None,
            };
            let content_digest = match fields.get("contentDigest")? {
                Value::String(value) if valid_source_digest(value) => value.clone(),
                _ => return None,
            };
            let harness_revision = match fields.get("harnessRevision") {
                None => None,
                Some(Value::Unsigned(value)) => Some(*value),
                _ => return None,
            };
            let source_authority = text_enum(fields, "sourceAuthority", &[
                "session-store", "core-config", "managed-control", "core-prompt-compiler", "tool-registry", "instruction-resolver", "skill-resolver", "template-resolver", "artifact-store",
            ])?;
            let expected_authority = match kind.as_str() {
                "session-message" => { has_session_message = true; "session-store" }
                "agent-profile" => "core-config",
                "managed-task" | "accepted-spec" => "managed-control",
                "provider-input" => "core-prompt-compiler",
                "tool" => "tool-registry",
                "instruction" => "instruction-resolver",
                "skill" => "skill-resolver",
                "prompt-template" => "template-resolver",
                "artifact" => "artifact-store",
                _ => return None,
            };
            if source_authority != expected_authority || fields.get("included") != Some(&Value::Bool(true)) { return None }
            let trust = text_enum(fields, "trust", &["system", "user", "workspace", "external", "mixed"])?;
            let inclusion_reason = text_enum(fields, "inclusionReason", &[
                "required", "current_request", "selected_tool", "profile", "instruction", "skill", "template", "artifact", "retrieval", "context_anchor", "history", "summary",
            ])?;
            if harness_revision.is_some() != (kind == "tool" && source_id.starts_with("toolset:")) { return None }
            // Canonical `harnessRevision` bounds live on `$defs/source`
            // (integer `1..=9007199254740991`), i.e. lane-independent, and the
            // TS mirror enforces them on `ContextSelectionSourceV1` for every
            // lane. Enforce here so the direct lane cannot accept `0` or
            // `> MAX_SAFE_INTEGER`; the managed toolset branch below repeats the
            // same bound on the value it feeds into the generation digest.
            if harness_revision.is_some_and(|revision| !(1..=9_007_199_254_740_991).contains(&revision)) { return None }
            decoded.push(ContextSelectionSourceV1 { kind, source_id, source_revision, content_digest, source_authority, trust, inclusion_reason, harness_revision });
        }
        if (mode == "fresh" && has_session_message) || (mode != "fresh" && !has_session_message) { return None }
        let provider_inputs = decoded.iter().filter(|source| source.kind == "provider-input").collect::<Vec<_>>();
        let expected_provider_revision = request_sequence.map(|value| value.to_string()).unwrap_or_else(|| source_revision.to_string());
        if provider_inputs.len() != 1 || provider_inputs[0].source_id != request_id
            || provider_inputs[0].source_revision != expected_provider_revision
            || provider_inputs[0].trust != "mixed"
            || provider_inputs[0].inclusion_reason != "current_request"
        { return None }
        let profile_refs = decoded.iter().filter(|source| source.kind == "agent-profile").collect::<Vec<_>>();
        if lane == "direct" {
            if profile_refs.len() != 1
                || profile_refs[0].source_revision.parse::<u64>().ok().is_none_or(|revision| revision == 0)
                || !profile_refs[0].content_digest.starts_with("blake3:")
                || !valid_source_digest(&profile_refs[0].content_digest)
                || !matches!(profile_refs[0].trust.as_str(), "system" | "user")
                || profile_refs[0].inclusion_reason != "profile"
            { return None }
        }
        if lane == "managed" {
            for kind in ["managed-task", "accepted-spec", "agent-profile"] {
                if decoded.iter().filter(|source| source.kind == kind).count() != 1 { return None }
            }
            // The actual provider-visible tools are a single immutable registry
            // generation. The manifest row pins the selected harness/generation;
            // per-tool rows pin canonical IDs and schema digests. These refs are
            // context evidence only and never grant a capability.
            let tool_rows = decoded.iter().filter(|source| source.kind == "tool").collect::<Vec<_>>();
            let toolsets = tool_rows.iter().filter(|source| source.source_id.starts_with("toolset:")).collect::<Vec<_>>();
            if toolsets.len() != 1 || tool_rows.len() > 33 { return None }
            let toolset = toolsets[0];
            let generation = toolset.source_revision.strip_prefix("blake3:")?;
            let harness_id = toolset.source_id.strip_prefix("toolset:")?;
            let harness_revision = toolset.harness_revision?;
            if toolset.source_id.len() <= "toolset:".len()
                || !valid_toolset_harness_id(harness_id)
                || harness_revision == 0
                || harness_revision > 9_007_199_254_740_991
                || generation.len() != 64
                || !generation.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                || toolset.content_digest != toolset.source_revision
                || toolset.trust != "system"
                || toolset.inclusion_reason != "selected_tool"
            { return None }
            let mut prior_tool_id: Option<&str> = None;
            let mut members = Vec::with_capacity(tool_rows.len().saturating_sub(1));
            for tool in tool_rows.iter().filter(|source| !source.source_id.starts_with("toolset:")) {
                let schema_digest = tool.content_digest.strip_prefix("blake3:");
                if tool.source_revision != toolset.source_revision
                    || schema_digest.is_none_or(|digest| digest.len() != 64
                        || !digest.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)))
                    || !valid_tool_capability_id(&tool.source_id)
                    || tool.trust != "system"
                    || tool.inclusion_reason != "selected_tool"
                    || prior_tool_id.is_some_and(|prior| prior >= tool.source_id.as_str())
                { return None }
                prior_tool_id = Some(&tool.source_id);
                members.push(serde_json::json!({"id": tool.source_id.as_str(), "schemaDigest": tool.content_digest.as_str()}));
            }
            let generation_input = serde_json::json!({
                "harnessID": harness_id,
                "harnessRevision": harness_revision,
                "members": members,
            });
            let canonical = serde_json::to_vec(&generation_input).ok()?;
            let mut preimage = b"horizon.toolset.v1\0".to_vec();
            preimage.extend_from_slice(&canonical);
            let computed = format!("blake3:{}", blake3::hash(&preimage).to_hex());
            if computed != toolset.source_revision { return None }
        }
        Some(Self { value: value.clone(), lane, session_id, request_id, attempt_id, request_sequence, mode, source_revision, sources: decoded })
    }

    pub(crate) fn digest(&self) -> Result<String, messagepack::MessagePackError> {
        let bytes = messagepack::encode(&self.value, FRAME_LIMITS)?;
        let mut preimage = Vec::with_capacity(DOMAIN.len() + bytes.len());
        preimage.extend_from_slice(DOMAIN);
        preimage.extend_from_slice(&bytes);
        Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
    }

    pub(crate) fn json_value(&self) -> serde_json::Value {
        fn convert(value: &Value) -> serde_json::Value {
            match value {
                Value::Nil => serde_json::Value::Null,
                Value::Bool(value) => serde_json::Value::Bool(*value),
                Value::Unsigned(value) => serde_json::Value::Number((*value).into()),
                Value::Signed(value) => serde_json::Value::Number((*value).into()),
                Value::Float(bits) => serde_json::Number::from_f64(f64::from_bits(*bits))
                    .map(serde_json::Value::Number).unwrap_or(serde_json::Value::Null),
                Value::String(value) => serde_json::Value::String(value.clone()),
                Value::Binary(bytes) => serde_json::Value::Array(
                    bytes.iter().map(|byte| serde_json::Value::Number((*byte).into())).collect(),
                ),
                Value::Array(values) => serde_json::Value::Array(values.iter().map(convert).collect()),
                Value::Map(values) => serde_json::Value::Object(values.iter().map(|(key, value)| (key.clone(), convert(value))).collect()),
            }
        }
        convert(&self.value)
    }

    #[cfg(test)]
    pub(crate) fn test_fixture() -> Self {
        let source = Value::Map(std::collections::BTreeMap::from([
            ("kind".to_owned(), Value::String("session-message".to_owned())),
            ("sourceID".to_owned(), Value::String("msg_01J9ABCDEF0123456789ABCDEFGH".to_owned())),
            ("sourceRevision".to_owned(), Value::String("12".to_owned())),
            ("contentDigest".to_owned(), Value::String(format!("sha256:{}", "a".repeat(64)))),
            ("sourceAuthority".to_owned(), Value::String("session-store".to_owned())),
            ("trust".to_owned(), Value::String("user".to_owned())),
            ("included".to_owned(), Value::Bool(true)),
            ("inclusionReason".to_owned(), Value::String("history".to_owned())),
        ]));
        let provider_input = Value::Map(std::collections::BTreeMap::from([
            ("kind".to_owned(), Value::String("provider-input".to_owned())),
            ("sourceID".to_owned(), Value::String("ctxreq_01J9ABCDEF0123456789ABCDEFGH".to_owned())),
            ("sourceRevision".to_owned(), Value::String("12".to_owned())),
            ("contentDigest".to_owned(), Value::String(format!("blake3:{}", "b".repeat(64)))),
            ("sourceAuthority".to_owned(), Value::String("core-prompt-compiler".to_owned())),
            ("trust".to_owned(), Value::String("mixed".to_owned())),
            ("included".to_owned(), Value::Bool(true)),
            ("inclusionReason".to_owned(), Value::String("current_request".to_owned())),
        ]));
        let profile = Value::Map(std::collections::BTreeMap::from([
            ("kind".to_owned(), Value::String("agent-profile".to_owned())),
            ("sourceID".to_owned(), Value::String("profile_default".to_owned())),
            ("sourceRevision".to_owned(), Value::String("1".to_owned())),
            ("contentDigest".to_owned(), Value::String(format!("blake3:{}", "c".repeat(64)))),
            ("sourceAuthority".to_owned(), Value::String("core-config".to_owned())),
            ("trust".to_owned(), Value::String("system".to_owned())),
            ("included".to_owned(), Value::Bool(true)),
            ("inclusionReason".to_owned(), Value::String("profile".to_owned())),
        ]));
        let value = Value::Map(std::collections::BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("lane".to_owned(), Value::String("direct".to_owned())),
            ("sessionID".to_owned(), Value::String("ses_01J9ABCDEF0123456789ABCDEFGH".to_owned())),
            ("requestID".to_owned(), Value::String("ctxreq_01J9ABCDEF0123456789ABCDEFGH".to_owned())),
            ("mode".to_owned(), Value::String("conversation_slice".to_owned())),
            ("sourceRevision".to_owned(), Value::String("12".to_owned())),
            ("sources".to_owned(), Value::Array(vec![source, provider_input, profile])),
        ]));
        Self::decode(&value).expect("test ContextSelection fixture must be valid")
    }
}

/// Rust-issued immutable digest for the exact managed Task fields projected to Core.
/// The accepted Spec is pinned separately by its immutable Spec ID and digest.
pub(crate) fn managed_task_context_digest(
    task_id: &str,
    task_revision: u64,
    title: &str,
    purpose: &str,
    dependencies: &[String],
    criterion_ids: &[String],
    required_capabilities: &[String],
) -> Result<String, messagepack::MessagePackError> {
    let array = |values: &[String]| Value::Array(values.iter().cloned().map(Value::String).collect());
    let value = Value::Map(std::collections::BTreeMap::from([
        ("schemaVersion".to_owned(), Value::Unsigned(1)),
        ("taskID".to_owned(), Value::String(task_id.to_owned())),
        ("taskRevision".to_owned(), Value::String(task_revision.to_string())),
        ("title".to_owned(), Value::String(title.to_owned())),
        ("purpose".to_owned(), Value::String(purpose.to_owned())),
        ("dependencies".to_owned(), array(dependencies)),
        ("criterionIDs".to_owned(), array(criterion_ids)),
        ("requiredCapabilities".to_owned(), array(required_capabilities)),
    ]));
    let bytes = messagepack::encode(&value, FRAME_LIMITS)?;
    let mut preimage = Vec::with_capacity(MANAGED_TASK_DOMAIN.len() + bytes.len());
    preimage.extend_from_slice(MANAGED_TASK_DOMAIN);
    preimage.extend_from_slice(&bytes);
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

fn text_enum(fields: &std::collections::BTreeMap<String, Value>, key: &str, allowed: &[&str]) -> Option<String> {
    match fields.get(key)? {
        Value::String(value) if allowed.contains(&value.as_str()) => Some(value.clone()),
        _ => None,
    }
}

fn valid_session(value: &str) -> bool {
    value.starts_with("ses_") && value.len() <= 132 && !value[4..].is_empty()
        && value[4..].bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-'))
}

fn valid_opaque_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
        && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b':' ))
}

fn valid_toolset_harness_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_tool_capability_id(value: &str) -> bool {
    let mut segments = value.split(['.', '_', '-']);
    let Some(first) = segments.next() else { return false };
    first.as_bytes().first().is_some_and(u8::is_ascii_lowercase)
        && first.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
        && segments.all(|segment| !segment.is_empty() && segment.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit()))
}

fn canonical_u64(value: &str) -> Option<u64> {
    if value.is_empty() || (value.len() > 1 && value.starts_with('0')) || value.len() > 20
        || !value.bytes().all(|b| b.is_ascii_digit()) { return None }
    value.parse().ok()
}

fn valid_source_digest(value: &str) -> bool {
    ["sha256:", "blake3:"].iter().any(|prefix| value.strip_prefix(prefix).is_some_and(|hex| {
        hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn value(input: serde_json::Value) -> Value {
        match input {
            serde_json::Value::Null => Value::Nil,
            serde_json::Value::Bool(value) => Value::Bool(value),
            serde_json::Value::Number(value) if value.is_u64() => Value::Unsigned(value.as_u64().unwrap()),
            serde_json::Value::Number(value) if value.is_i64() => Value::Signed(value.as_i64().unwrap()),
            serde_json::Value::Number(value) => Value::Float(value.as_f64().unwrap().to_bits()),
            serde_json::Value::String(value) => Value::String(value),
            serde_json::Value::Array(values) => Value::Array(values.into_iter().map(value).collect()),
            serde_json::Value::Object(values) => Value::Map(values.into_iter().map(|(k, v)| (k, value(v))).collect()),
        }
    }

    fn valid() -> serde_json::Value {
        serde_json::from_str(include_str!("../tests/fixtures/context-selection-v1.json")).unwrap()
    }

    /// The exact domain-separated BLAKE3 generation digests the decoder
    /// recomputes over `horizon.toolset.v1\0` + compact JSON
    /// `{"harnessID":"horizon.native","harnessRevision":N,"members":[]}`.
    /// Shared by the managed (CTX-006) and direct-lane bound matrices so both
    /// tests pin identical fixture bytes.
    const GENERATION_1: &str = "blake3:2e76c0a2b5575398bb1f0e70bbf5f9f952680e9f1320c45b9aebe87950dfcd41";
    const GENERATION_MAX: &str = "blake3:3da61f55abff1515f9d596e7fc31fc7080060df9d71f5a86e9f993ec435d7ba8";
    const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

    /// The canonical direct-lane selection fixture (§30.26 direct pins) with one
    /// extra source appended, so both new matrices start from bytes that already
    /// decode today.
    fn direct_selection_with(extra: serde_json::Value) -> serde_json::Value {
        let mut selection = ContextSelectionV1::test_fixture().json_value();
        selection["sources"].as_array_mut().unwrap().push(extra);
        selection
    }

    #[test]
    fn strict_context_selection_decoder_binds_the_full_canonical_map() {
        let fixture = valid();
        let selection = fixture["selection"].clone();
        let decoded = ContextSelectionV1::decode(&value(selection)).unwrap();
        assert_eq!(decoded.session_id, "ses_01J9ABCDEF0123456789ABCDEFGH");
        assert_eq!(decoded.request_id, "ctxreq_01J9ABCDEF0123456789ABCDEFGH");
        assert_eq!(decoded.source_revision, 12);
        assert_eq!(decoded.digest().unwrap(), fixture["digest"].as_str().unwrap());
        let mut unknown = fixture["selection"].clone(); unknown["unexpected"] = json!(true);
        assert!(ContextSelectionV1::decode(&value(unknown)).is_none());
        let mut duplicate = fixture["selection"].clone();
        let first_source = duplicate["sources"][0].clone(); duplicate["sources"].as_array_mut().unwrap().push(first_source);
        assert!(ContextSelectionV1::decode(&value(duplicate)).is_none());
        let mut overflow = fixture["selection"].clone(); overflow["sourceRevision"] = json!("18446744073709551616");
        assert!(ContextSelectionV1::decode(&value(overflow)).is_none());
        let mut untrusted = fixture["selection"].clone(); untrusted["sources"][0]["sourceAuthority"] = json!("artifact-store");
        assert!(ContextSelectionV1::decode(&value(untrusted)).is_none());
        let mut omitted = fixture["selection"].clone(); omitted["sources"][0]["included"] = json!(false);
        assert!(ContextSelectionV1::decode(&value(omitted)).is_none());
        let mut malformed_session = fixture["selection"].clone(); malformed_session["sessionID"] = json!("session-without-prefix");
        assert!(ContextSelectionV1::decode(&value(malformed_session)).is_none());
    }

    /// CTX-006 (arch_V1/32 §32.45) — cross-runtime `harnessRevision` parity.
    ///
    /// The exact same fixture bytes the canonical
    /// `arch_V1/contracts-v2/context-selection-v1.schema.json` (Draft 2020-12
    /// validator) and the TS strict mirror
    /// (`packages/schema/test/context-selection-v1.test.ts`) validate:
    /// all three accept the positive u64 integer forms `1` and
    /// `9_007_199_254_740_991`, and all three reject the decimal-string form,
    /// `0`, a negative, and `> 9_007_199_254_740_991`. `sourceRevision` stays
    /// a `DecimalU64` string and is asserted as a regression guard.
    ///
    /// The toolset `sourceRevision`/`contentDigest` are the exact domain-
    /// separated BLAKE3 digests this decoder recomputes over
    /// `horizon.toolset.v1\0` + compact JSON
    /// `{"harnessID":"horizon.native","harnessRevision":N,"members":[]}`,
    /// so a digest mismatch would fail the accept cases.
    #[test]
    fn ctx_006_harness_revision_matrix_matches_canonical_schema_and_ts_mirror() {
        const MAX_SAFE: u64 = MAX_SAFE_INTEGER;
        let fixture = |harness_revision: serde_json::Value, generation: &str| json!({
            "schemaVersion": 1,
            "lane": "managed",
            "sessionID": "ses_01J9ABCDEF0123456789ABCDEFGH",
            "requestID": "ctxreq_01J9ABCDEF0123456789ABCDEFGH",
            "attemptID": "attempt_01J9ABCDEF0123456789ABCDEFGH",
            "requestSequence": "1",
            "mode": "conversation_slice",
            "sourceRevision": "12",
            "sources": [
                {
                    "kind": "session-message",
                    "sourceID": "msg_01J9ABCDEF0123456789ABCDEFGH",
                    "sourceRevision": "12",
                    "contentDigest": format!("sha256:{}", "a".repeat(64)),
                    "sourceAuthority": "session-store",
                    "trust": "user",
                    "included": true,
                    "inclusionReason": "history"
                },
                {
                    "kind": "provider-input",
                    "sourceID": "ctxreq_01J9ABCDEF0123456789ABCDEFGH",
                    "sourceRevision": "1",
                    "contentDigest": format!("blake3:{}", "b".repeat(64)),
                    "sourceAuthority": "core-prompt-compiler",
                    "trust": "mixed",
                    "included": true,
                    "inclusionReason": "current_request"
                },
                {
                    "kind": "managed-task",
                    "sourceID": "task_01J9ABCDEF0123456789ABCDEFGH",
                    "sourceRevision": "7",
                    "contentDigest": format!("blake3:{}", "9".repeat(64)),
                    "sourceAuthority": "managed-control",
                    "trust": "workspace",
                    "included": true,
                    "inclusionReason": "required"
                },
                {
                    "kind": "accepted-spec",
                    "sourceID": "spec_01J9ABCDEF0123456789ABCDEFGH",
                    "sourceRevision": "3",
                    "contentDigest": format!("blake3:{}", "6".repeat(64)),
                    "sourceAuthority": "managed-control",
                    "trust": "workspace",
                    "included": true,
                    "inclusionReason": "required"
                },
                {
                    "kind": "agent-profile",
                    "sourceID": "profile_default",
                    "sourceRevision": "1",
                    "contentDigest": format!("blake3:{}", "c".repeat(64)),
                    "sourceAuthority": "core-config",
                    "trust": "system",
                    "included": true,
                    "inclusionReason": "profile"
                },
                {
                    "kind": "tool",
                    "sourceID": "toolset:horizon.native",
                    "sourceRevision": generation.to_owned(),
                    "contentDigest": generation.to_owned(),
                    "sourceAuthority": "tool-registry",
                    "trust": "system",
                    "included": true,
                    "inclusionReason": "selected_tool",
                    "harnessRevision": harness_revision
                }
            ]
        });
        // Accept: exact positive u64 integer forms; the digests are
        // recomputed by the decoder, so they must match the fixture bytes.
        let decoded = ContextSelectionV1::decode(&value(fixture(json!(1), GENERATION_1)))
            .expect("harnessRevision 1 must decode like the canonical schema and TS mirror");
        assert_eq!(decoded.sources.last().unwrap().harness_revision, Some(1));
        let decoded = ContextSelectionV1::decode(&value(fixture(json!(MAX_SAFE), GENERATION_MAX)))
            .expect("harnessRevision at MAX_SAFE_INTEGER must decode like the canonical schema and TS mirror");
        assert_eq!(decoded.sources.last().unwrap().harness_revision, Some(MAX_SAFE));
        // Reject: decimal-string form, zero, negative, above MAX_SAFE_INTEGER.
        for (label, bad) in [
            ("decimal_string", json!("1")),
            ("zero", json!(0)),
            ("negative", json!(-1)),
            ("above_max_safe", json!(MAX_SAFE + 1)),
        ] {
            assert!(
                ContextSelectionV1::decode(&value(fixture(bad, GENERATION_1))).is_none(),
                "harnessRevision {label} must be rejected like the canonical schema and TS mirror"
            );
        }
        // Regression guard against over-correcting: `sourceRevision` stays a
        // DecimalU64 string and is never re-typed to an integer.
        let mut numeric_revision = fixture(json!(1), GENERATION_1);
        numeric_revision["sourceRevision"] = json!(12);
        assert!(ContextSelectionV1::decode(&value(numeric_revision)).is_none());
    }

    /// CTX-006 (arch_V1/32 §32.45) — the *direct* lane of the same
    /// `harnessRevision` parity matrix.
    ///
    /// Canonical `contracts-v2/context-selection-v1.schema.json` declares
    /// `harnessRevision` as `integer` `minimum: 1` `maximum: 9007199254740991`
    /// on `$defs/source` — lane-independent — and the TS strict mirror mirrors
    /// it on `ContextSelectionSourceV1` (`Schema.Int` `>=1` `<= MAX_SAFE_INTEGER`),
    /// also lane-independent. The Rust decoder previously enforced the bound
    /// only inside the *managed* toolset branch (which also recomputes the
    /// generation digest), so a **direct-lane** `toolset:` manifest with
    /// `harnessRevision: 0` (or `> MAX_SAFE_INTEGER`) decoded here while both
    /// other runtimes rejected it.
    ///
    /// Direct lane is the right lane for this probe: the canonical schema
    /// excludes only `managed-task`/`accepted-spec` from `lane: direct`, the
    /// `toolset:` → `harnessRevision` presence rule (allOf[5]) is global, and
    /// the bounds live on the source definition itself.
    #[test]
    fn ctx_006_direct_lane_harness_revision_bounds_match_canonical_schema_and_ts_mirror() {
        let fixture = |harness_revision: serde_json::Value| direct_selection_with(json!({
            "kind": "tool",
            "sourceID": "toolset:horizon.native",
            "sourceRevision": GENERATION_1,
            "contentDigest": GENERATION_1,
            "sourceAuthority": "tool-registry",
            "trust": "system",
            "included": true,
            "inclusionReason": "selected_tool",
            "harnessRevision": harness_revision
        }));
        // Accept: the exact positive u64 integer forms, in the direct lane too.
        let decoded = ContextSelectionV1::decode(&value(fixture(json!(1))))
            .expect("direct-lane harnessRevision 1 must decode like the canonical schema and TS mirror");
        assert_eq!(decoded.sources.last().unwrap().harness_revision, Some(1));
        let decoded = ContextSelectionV1::decode(&value(fixture(json!(MAX_SAFE_INTEGER))))
            .expect("direct-lane harnessRevision at MAX_SAFE_INTEGER must decode like the canonical schema and TS mirror");
        assert_eq!(decoded.sources.last().unwrap().harness_revision, Some(MAX_SAFE_INTEGER));
        // Reject: the identical CTX-006 matrix, previously accepted by the
        // direct lane because the bound check lived only in the managed branch.
        for (label, bad) in [
            ("decimal_string", json!("1")),
            ("zero", json!(0)),
            ("negative", json!(-1)),
            ("above_max_safe", json!(MAX_SAFE_INTEGER + 1)),
        ] {
            assert!(
                ContextSelectionV1::decode(&value(fixture(bad))).is_none(),
                "direct-lane harnessRevision {label} must be rejected like the canonical schema and TS mirror"
            );
        }
    }

    /// §30.26 context anchors — `inclusionReason: context_anchor` is a canonical
    /// selection value.
    ///
    /// Canonical `$defs/source.properties.inclusionReason` and the TS strict
    /// mirror `ContextSelectionInclusionReasonV1` both allow **12** values with
    /// `context_anchor` between `retrieval` and `history`; the Rust decoder's
    /// `text_enum` list carried only 11, so a §30.26 anchor selection
    /// (`kind: artifact`, `inclusionReason: context_anchor`) decoded in the
    /// canonical schema and the TS mirror and was rejected here.
    #[test]
    fn ctx_030_26_context_anchor_inclusion_reason_decodes_like_canonical_and_ts_mirror() {
        let selection = || direct_selection_with(json!({
            "kind": "artifact",
            "sourceID": "artifact_repo_context_anchor",
            "sourceRevision": "3",
            "contentDigest": format!("blake3:{}", "d".repeat(64)),
            "sourceAuthority": "artifact-store",
            "trust": "workspace",
            "included": true,
            "inclusionReason": "context_anchor"
        }));
        let decoded = ContextSelectionV1::decode(&value(selection()))
            .expect("§30.26 context_anchor selection must decode like the canonical schema and TS mirror");
        assert_eq!(decoded.sources.last().unwrap().inclusion_reason, "context_anchor");
        // The enum stays closed: an invented 13th reason is still rejected.
        let mut invented = selection();
        invented["sources"].as_array_mut().unwrap()[3]["inclusionReason"] = json!("context_anchor_v2");
        assert!(ContextSelectionV1::decode(&value(invented)).is_none());
    }
}
