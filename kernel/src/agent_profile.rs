//! Canonical digest helpers for authenticated AgentProfileDefinitionV2 values.
//! HostKernel must strictly decode the complete schema before calling this module.

use crate::messagepack::{self, Value, FRAME_LIMITS};
use crate::protocol::AuthenticatedPrincipalV1;
use std::collections::{BTreeMap, BTreeSet};

const PROFILE_DOMAIN: &[u8] = b"horizoncode.agent-profile-definition.v2\0";
const CEILING_DOMAIN: &[u8] = b"horizoncode.agent-profile-permission-ceiling.v2\0";
const OWNER_BUILTIN_DOMAIN: &[u8] = b"horizoncode.agent-profile-owner.builtin.v1\0";
const OWNER_USER_DOMAIN: &[u8] = b"horizoncode.agent-profile-owner.user.v1\0";
const PROFILE_KEYS: [&str; 33] = [
    "schemaVersion", "profileId", "revision", "name", "description", "source", "roles",
    "purpose", "whenToUse", "whenNotToUse", "adapter", "model", "harness", "reasoning",
    "variants", "instructions", "tools", "allowedSkillIds", "deniedSkillIds",
    "allowedMcpServers", "allowedMcpToolPatterns", "allowedSubagentIds",
    "deniedSubagentIds", "pathRules", "context", "inputMode", "memoryPolicy",
    "isolation", "lifecycleHooks", "capabilityCeiling", "limits", "maxParallelChildren",
    "enabled",
];
const PERMISSION_KEYS: [&str; 18] = [
    "allowedMcpServers", "allowedMcpToolPatterns", "allowedSkillIds", "allowedSubagentIds",
    "capabilityCeiling", "context", "deniedSkillIds", "deniedSubagentIds", "inputMode",
    "enabled", "isolation", "lifecycleHooks", "limits", "maxParallelChildren", "pathRules",
    "roles", "source", "tools",
];

/// Rust-minted immutable profile revision persisted on a managed Task.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProfileRevisionRefV1 {
    pub profile_id: String,
    pub revision: u64,
    pub definition_digest: String,
}

/// Durable owner binding for a selected profile. User subjects are never stored
/// in the managed log; the digest is specific to the V1 profile-owner domain.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ProfileOwnerBindingV1 {
    Builtin,
    User { subject_digest: String },
}

impl ProfileOwnerBindingV1 {
    pub(crate) fn from_authenticated_principal(
        source: &str,
        principal: &AuthenticatedPrincipalV1,
    ) -> Option<Self> {
        match (source, principal) {
            ("builtin", AuthenticatedPrincipalV1::ServerAuth { .. }) => Some(Self::Builtin),
            ("user", AuthenticatedPrincipalV1::ServerAuth { subject })
                if !subject.is_empty() && subject.len() <= 256 && !subject.bytes().any(|b| b.is_ascii_control()) =>
            {
                let mut preimage = OWNER_USER_DOMAIN.to_vec();
                preimage.extend_from_slice(subject.as_bytes());
                Some(Self::User {
                    subject_digest: format!("blake3:{}", blake3::hash(&preimage).to_hex()),
                })
            }
            _ => None,
        }
    }

    pub(crate) fn digest(&self) -> String {
        match self {
            Self::Builtin => format!("blake3:{}", blake3::hash(OWNER_BUILTIN_DOMAIN).to_hex()),
            Self::User { subject_digest } => subject_digest.clone(),
        }
    }

    pub(crate) fn is_valid(&self) -> bool {
        match self {
            Self::Builtin => true,
            Self::User { subject_digest } => subject_digest.strip_prefix("blake3:").is_some_and(|digest| {
                digest.len() == 64 && digest.bytes().all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            }),
        }
    }
}

impl ProfileRevisionRefV1 {
    pub(crate) fn from_definition(
        profile: &AgentProfileDefinitionV2,
    ) -> Result<Self, messagepack::MessagePackError> {
        Ok(Self {
            profile_id: profile.profile_id.clone(),
            revision: profile.revision,
            definition_digest: profile.definition_digest()?,
        })
    }

    pub(crate) fn is_valid(&self) -> bool {
        valid_id(&self.profile_id)
            && self.revision > 0
            && self.definition_digest.strip_prefix("blake3:").is_some_and(|digest| {
                digest.len() == 64
                    && digest.bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
            })
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct AgentProfileDefinitionV2 {
    value: Value,
    pub(crate) profile_id: String,
    pub(crate) revision: u64,
    pub(crate) source: String,
    pub(crate) capability_ceiling: Vec<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct AgentProfileChildLimitsV1 {
    pub(crate) max_total_children: u64,
    pub(crate) max_active_children: u64,
    pub(crate) max_parallel_children: u64,
}

impl AgentProfileDefinitionV2 {
    /// The caller must validate the complete AgentProfileDefinitionV2 schema first.
    pub(crate) fn from_host_validated_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else { return None };
        if fields.len() != PROFILE_KEYS.len()
            || PROFILE_KEYS.iter().any(|key| !fields.contains_key(*key))
            || fields.keys().any(|key| !PROFILE_KEYS.contains(&key.as_str()))
            || fields.get("schemaVersion") != Some(&Value::Unsigned(2))
        {
            return None;
        }
        let profile_id = match fields.get("profileId")? {
            Value::String(value) if valid_id(value) => value.clone(),
            _ => return None,
        };
        // `arch_V1/12-DOMAIN-SCHEMAS.md` line 28: an unsigned 64-bit counter
        // crossing JSON is a canonical `DecimalU64` **string**, never a JSON
        // number. A number fails closed instead of being coerced.
        let revision = decimal_u64(fields.get("revision"), true)?;
        let Value::Map(instructions) = fields.get("instructions")? else { return None };
        decimal_u64(instructions.get("maxCompiledTokens"), false)?;
        let Value::Map(context) = fields.get("context")? else { return None };
        if let Some(parent_history) = context.get("maxParentHistoryTokens") {
            if !matches!(parent_history, Value::Nil) {
                decimal_u64(Some(parent_history), false)?;
            }
        }
        let source = match fields.get("source")? {
            Value::String(value) if matches!(value.as_str(), "builtin" | "user") => value.clone(),
            _ => return None,
        };
        let capability_ceiling = sorted_capabilities(fields.get("capabilityCeiling")?)?;
        Some(Self { value: value.clone(), profile_id, revision, source, capability_ceiling })
    }

    pub(crate) fn definition_digest(&self) -> Result<String, messagepack::MessagePackError> {
        canonical_digest(PROFILE_DOMAIN, &self.value)
    }

    pub(crate) fn selected_provider_model(&self) -> Option<(String, String)> {
        let Value::Map(fields) = &self.value else { return None };
        let Value::Map(selection) = fields.get("model")? else { return None };
        let Value::String(provider_id) = selection.get("providerId")? else { return None };
        let Value::String(model_id) = selection.get("modelId")? else { return None };
        if valid_id(provider_id) && valid_id(model_id) {
            Some((provider_id.clone(), model_id.clone()))
        } else { None }
    }

    /// Returns the trusted harness selector from the complete pinned profile.
    /// Callers must still resolve it through the configured provider adapter;
    /// this value is not a route or endpoint authorization by itself.
    pub(crate) fn harness_id(&self) -> Option<String> {
        let Value::Map(fields) = &self.value else { return None };
        match fields.get("harness") {
            Some(Value::String(value)) if valid_id(value) => Some(value.clone()),
            _ => None,
        }
    }

    pub(crate) fn token_budget(&self) -> Option<u64> {
        let Value::Map(fields) = &self.value else { return None };
        let Value::Map(limits) = fields.get("limits")? else { return None };
        decimal_u64(limits.get("tokenBudget"), true)
    }

    /// This binds profile rules, role scope, source and enabled state. It is
    /// never an effective Guard ceiling or lease.
    pub(crate) fn permission_ceiling_digest(&self) -> Result<String, messagepack::MessagePackError> {
        let Value::Map(fields) = &self.value else { unreachable!("validated profile map") };
        let selected = PERMISSION_KEYS.iter()
            .map(|key| ((*key).to_owned(), fields.get(*key).expect("required profile field").clone()))
            .collect::<BTreeMap<_, _>>();
        canonical_digest(CEILING_DOMAIN, &Value::Map(selected))
    }

    /// Child fan-out limits are validated with the complete profile definition and
    /// remain bound to its canonical definition digest. Unknown or non-positive
    /// values fail closed instead of being normalized into a default.
    pub(crate) fn child_limits(&self) -> Option<AgentProfileChildLimitsV1> {
        let Value::Map(fields) = &self.value else { return None };
        let Value::Map(limits) = fields.get("limits")? else { return None };
        let positive = |value: Option<&Value>| match value {
            Some(Value::Unsigned(value)) if *value > 0 => Some(*value),
            _ => None,
        };
        let max_total_children = positive(limits.get("maxTotalChildren"))?;
        let max_active_children = positive(limits.get("maxActiveChildren"))?;
        let max_parallel_children = positive(fields.get("maxParallelChildren"))?;
        if max_parallel_children > max_active_children
            || max_active_children > max_total_children
        {
            return None;
        }
        Some(AgentProfileChildLimitsV1 {
            max_total_children,
            max_active_children,
            max_parallel_children,
        })
    }

    /// Optional profile wall-clock cap used to bound a managed worker lease.
    /// The value comes only from the fully validated immutable profile revision;
    /// malformed or zero limits fail closed as unavailable.
    pub(crate) fn wall_time_ms(&self) -> Option<u64> {
        let Value::Map(fields) = &self.value else { return None };
        let Value::Map(limits) = fields.get("limits")? else { return None };
        decimal_u64(limits.get("wallTimeMs"), true)
    }
}

fn canonical_digest(domain: &[u8], value: &Value) -> Result<String, messagepack::MessagePackError> {
    let bytes = messagepack::encode(value, FRAME_LIMITS)?;
    let mut preimage = Vec::with_capacity(domain.len() + bytes.len());
    preimage.extend_from_slice(domain);
    preimage.extend_from_slice(&bytes);
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
        && !value.bytes().any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
}

/// Reads an unsigned 64-bit counter that crossed JSON as a `DecimalU64`
/// (`arch_V1/contracts-v2/wire-primitives-v1.schema.json`): a base-10 string
/// with no sign, no leading zero (except `"0"` itself) and a value inside
/// `0..=18446744073709551615`. A JSON number, `null`, an empty or padded
/// spelling, a non-digit or an overflowing value all fail closed — nothing is
/// coerced or normalized onto the wire. `positive` additionally enforces the
/// `PositiveDecimalU64` / `> 0` rule used by revision and budget counters.
fn decimal_u64(value: Option<&Value>, positive: bool) -> Option<u64> {
    let Value::String(text) = value? else { return None };
    if text.is_empty()
        || text.len() > 20
        || !text.bytes().all(|byte| byte.is_ascii_digit())
        || (text.len() > 1 && text.starts_with('0'))
    {
        return None;
    }
    let parsed = text.parse::<u64>().ok()?;
    if parsed.to_string() != text.as_str() || (positive && parsed == 0) {
        return None;
    }
    Some(parsed)
}

fn sorted_capabilities(value: &Value) -> Option<Vec<String>> {
    let Value::Array(values) = value else { return None };
    if values.len() > 64 { return None; }
    let mut output = Vec::with_capacity(values.len());
    let mut seen = BTreeSet::new();
    for value in values {
        let Value::String(value) = value else { return None };
        if value.len() > 128
            || !value.bytes().enumerate().all(|(index, byte)| {
                if index == 0 { byte.is_ascii_lowercase() }
                else { byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"._-".contains(&byte) }
            })
            || !seen.insert(value.clone())
            || output.last().is_some_and(|prior| prior >= value)
        {
            return None;
        }
        output.push(value.clone());
    }
    Some(output)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value as JsonValue;

    fn json_to_value(value: &JsonValue) -> Value {
        match value {
            JsonValue::Null => Value::Nil,
            JsonValue::Bool(value) => Value::Bool(*value),
            JsonValue::Number(value) if value.is_u64() => Value::Unsigned(value.as_u64().unwrap()),
            JsonValue::Number(value) if value.is_i64() => Value::Signed(value.as_i64().unwrap()),
            JsonValue::Number(value) => Value::Float(value.as_f64().unwrap().to_bits()),
            JsonValue::String(value) => Value::String(value.clone()),
            JsonValue::Array(values) => Value::Array(values.iter().map(json_to_value).collect()),
            JsonValue::Object(values) => Value::Map(
                values.iter().map(|(key, value)| (key.clone(), json_to_value(value))).collect(),
            ),
        }
    }

    #[test]
    fn profile_digest_matches_shared_golden_and_preserves_profile_identity() {
        let fixture: JsonValue = serde_json::from_str(include_str!("../tests/fixtures/agent-profile-definition-v2.json")).unwrap();
        let definition = json_to_value(&fixture["definition"]);
        let profile = AgentProfileDefinitionV2::from_host_validated_value(&definition).unwrap();
        assert_eq!(profile.profile_id, "specialist.reader");
        assert_eq!(profile.revision, 1);
        assert_eq!(profile.source, "user");
        assert_eq!(profile.capability_ceiling, vec!["files.read"]);
        assert_eq!(profile.definition_digest().unwrap(), fixture["definitionDigest"].as_str().unwrap());
        assert_eq!(profile.permission_ceiling_digest().unwrap(), fixture["permissionCeilingDigest"].as_str().unwrap());
    }

    #[test]
    fn profile_definition_rejects_extra_digest_fields_and_noncanonical_capabilities() {
        let fixture: JsonValue = serde_json::from_str(include_str!("../tests/fixtures/agent-profile-definition-v2.json")).unwrap();
        let Value::Map(mut definition) = json_to_value(&fixture["definition"]) else { unreachable!() };
        definition.insert("definitionDigest".into(), Value::String("blake3:".to_owned() + &"a".repeat(64)));
        assert!(AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(definition.clone())).is_none());
        definition.remove("definitionDigest");
        definition.insert("capabilityCeiling".into(), Value::Array(vec![
            Value::String("files.write".into()), Value::String("files.read".into()),
        ]));
        assert!(AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(definition)).is_none());
    }

    #[test]
    fn permission_digest_binds_source_roles_and_enabled_state() {
        let fixture: JsonValue = serde_json::from_str(include_str!("../tests/fixtures/agent-profile-definition-v2.json")).unwrap();
        let Value::Map(original) = json_to_value(&fixture["definition"]) else { unreachable!() };
        let base = AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(original.clone())).unwrap();
        let digest = base.permission_ceiling_digest().unwrap();
        for (field, value) in [
            ("source", Value::String("builtin".into())),
            ("roles", Value::Array(vec![Value::String("main".into())])),
            ("enabled", Value::Bool(false)),
        ] {
            let mut changed = original.clone();
            changed.insert(field.to_owned(), value);
            let profile = AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(changed)).unwrap();
            assert_ne!(profile.permission_ceiling_digest().unwrap(), digest, "{field} must affect permission digest");
        }
    }

    /// `arch_V1/12-DOMAIN-SCHEMAS.md` line 28 and the canonical
    /// `contracts-v2/agent-profile-v2.schema.json` contract: every unsigned
    /// 64-bit counter or budget crossing JSON is a canonical `DecimalU64`
    /// **string**, never a JSON number. A JSON number and every non-canonical
    /// spelling must fail closed instead of being coerced or normalized.
    #[test]
    fn decimal_u64_revision_is_a_canonical_string_never_a_json_number() {
        let definition = || {
            let fixture: JsonValue =
                serde_json::from_str(include_str!("../tests/fixtures/agent-profile-definition-v2.json")).unwrap();
            match json_to_value(&fixture["definition"]) {
                Value::Map(fields) => fields,
                _ => unreachable!("fixture definition is an object"),
            }
        };

        // A JSON number must not be accepted for `revision`.
        let mut numeric = definition();
        numeric.insert("revision".into(), Value::Unsigned(7));
        assert!(
            AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(numeric)).is_none(),
            "a JSON number revision must be rejected, never coerced into a u64"
        );

        // The canonical decimal string is the accepted wire spelling.
        let mut canonical = definition();
        canonical.insert("revision".into(), Value::String("7".into()));
        let profile = AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(canonical))
            .expect("canonical decimal revision must be accepted");
        assert_eq!(profile.revision, 7);

        for rejected in [
            "0", "00", "007", "+7", "-7", "7.0", " 7", "7 ", "", "7x",
            "18446744073709551616",
        ] {
            let mut fields = definition();
            fields.insert("revision".into(), Value::String(rejected.into()));
            assert!(
                AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(fields)).is_none(),
                "non-canonical revision {rejected:?} must be rejected"
            );
        }

        // The full u64 range is representable precisely because the wire is a string.
        let mut maximum = definition();
        maximum.insert("revision".into(), Value::String("18446744073709551615".into()));
        let profile = AgentProfileDefinitionV2::from_host_validated_value(&Value::Map(maximum))
            .expect("u64::MAX is a valid PositiveDecimalU64");
        assert_eq!(profile.revision, u64::MAX);
    }

    #[test]
    fn decimal_u64_instruction_and_context_limits_reject_json_numbers() {
        let fixture: JsonValue =
            serde_json::from_str(include_str!("../tests/fixtures/agent-profile-definition-v2.json")).unwrap();
        let base = json_to_value(&fixture["definition"]);
        let Value::Map(base_fields) = base else { unreachable!() };

        let with_limits = |max_compiled: Value, max_parent_history: Value| {
            let mut fields = base_fields.clone();
            let Value::Map(instructions) = fields.get_mut("instructions").unwrap() else {
                unreachable!()
            };
            instructions.insert("maxCompiledTokens".into(), max_compiled);
            let Value::Map(context) = fields.get_mut("context").unwrap() else { unreachable!() };
            context.insert("maxParentHistoryTokens".into(), max_parent_history);
            Value::Map(fields)
        };

        // The complete schema requires maxCompiledTokens and allows the context
        // budget to be either null or a canonical DecimalU64 string.
        for (field, value) in [
            ("maxCompiledTokens", Value::Unsigned(4096)),
            ("maxParentHistoryTokens", Value::Unsigned(2048)),
        ] {
            let (compiled, parent) = if field == "maxCompiledTokens" {
                (value, Value::Nil)
            } else {
                (Value::String("4096".into()), value)
            };
            assert!(
                AgentProfileDefinitionV2::from_host_validated_value(&with_limits(compiled, parent)).is_none(),
                "JSON number {field} must be rejected"
            );
        }

        let canonical = with_limits(Value::String("4096".into()), Value::String("2048".into()));
        let profile = AgentProfileDefinitionV2::from_host_validated_value(&canonical)
            .expect("canonical decimal limit strings must be accepted");
        let Value::Map(fields) = profile.value else { unreachable!() };
        let Value::Map(instructions) = &fields["instructions"] else { unreachable!() };
        assert_eq!(decimal_u64(instructions.get("maxCompiledTokens"), false), Some(4096));
        let Value::Map(context) = &fields["context"] else { unreachable!() };
        assert_eq!(decimal_u64(context.get("maxParentHistoryTokens"), false), Some(2048));
    }

    /// Same contract for the two optional budget counters read by
    /// `token_budget()` and `wall_time_ms()`: canonical decimal string, `> 0`,
    /// fail closed on a JSON number, an empty/leading-zero/overflowing
    /// spelling or an absent value.
    #[test]
    fn decimal_u64_budget_counters_are_positive_canonical_strings() {
        fn with_limits(token_budget: Option<Value>, wall_time_ms: Option<Value>) -> Value {
            let fixture: JsonValue =
                serde_json::from_str(include_str!("../tests/fixtures/agent-profile-definition-v2.json")).unwrap();
            let Value::Map(mut fields) = json_to_value(&fixture["definition"]) else {
                unreachable!("fixture definition is an object")
            };
            {
                let Some(Value::Map(limits)) = fields.get_mut("limits") else {
                    unreachable!("fixture limits is an object")
                };
                if let Some(value) = token_budget {
                    limits.insert("tokenBudget".into(), value);
                }
                if let Some(value) = wall_time_ms {
                    limits.insert("wallTimeMs".into(), value);
                }
            }
            Value::Map(fields)
        }
        let read = |value: Value| {
            AgentProfileDefinitionV2::from_host_validated_value(&value)
                .expect("profile definition must still validate")
        };

        // JSON numbers fail closed in both accessors.
        let numeric = read(with_limits(Some(Value::Unsigned(8_192)), Some(Value::Unsigned(60_000))));
        assert_eq!(numeric.token_budget(), None, "JSON number tokenBudget must be rejected");
        assert_eq!(numeric.wall_time_ms(), None, "JSON number wallTimeMs must be rejected");

        // Canonical decimal strings are the accepted spelling.
        let canonical = read(with_limits(
            Some(Value::String("8192".into())),
            Some(Value::String("60000".into())),
        ));
        assert_eq!(canonical.token_budget(), Some(8_192));
        assert_eq!(canonical.wall_time_ms(), Some(60_000));

        // Absent optional counters stay unavailable rather than defaulting.
        let absent = read(with_limits(None, None));
        assert_eq!(absent.token_budget(), None);
        assert_eq!(absent.wall_time_ms(), None);

        // Non-canonical spellings and the required `> 0` rule fail closed.
        for rejected in ["0", "00", "007", " 8192", "8192 ", "8192.0", "", "8192x"] {
            let closed = read(with_limits(Some(Value::String(rejected.into())), None));
            assert_eq!(
                closed.token_budget(),
                None,
                "non-canonical tokenBudget {rejected:?} must be rejected"
            );
        }

        // Out-of-u64-range decimal strings fail closed too.
        let overflow = read(with_limits(
            Some(Value::String("18446744073709551616".into())),
            Some(Value::String("18446744073709551616".into())),
        ));
        assert_eq!(overflow.token_budget(), None);
        assert_eq!(overflow.wall_time_ms(), None);

        // The whole u64 range remains representable.
        let maximum = read(with_limits(
            Some(Value::String("18446744073709551615".into())),
            Some(Value::String("18446744073709551615".into())),
        ));
        assert_eq!(maximum.token_budget(), Some(u64::MAX));
        assert_eq!(maximum.wall_time_ms(), Some(u64::MAX));
    }
}
