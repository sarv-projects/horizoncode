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
        let revision = match fields.get("revision")? {
            Value::Unsigned(value) if *value > 0 => *value,
            _ => return None,
        };
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
        match limits.get("tokenBudget") {
            Some(Value::Unsigned(value)) if *value > 0 => Some(*value),
            _ => None,
        }
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
        match limits.get("wallTimeMs")? {
            Value::Unsigned(value) if *value > 0 => Some(*value),
            _ => None,
        }
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
}
