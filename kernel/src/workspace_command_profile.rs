//! Strict Rust validation and immutable digest for Core-Config-owned
//! `WorkspaceCommandProfileV1` projections. This profile is configuration, not
//! execution authority; HostKernel still resolves its owner, workspace and binary.

use crate::messagepack::{self, Value, FRAME_LIMITS};
use std::{collections::{BTreeMap, BTreeSet}, path::PathBuf};

const DIGEST_DOMAIN: &[u8] = b"horizoncode.workspace-command-profile.v1\0";

#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub(crate) enum WorkspaceCommandActionV1 { Build, Test }

impl WorkspaceCommandActionV1 {
    pub(crate) fn as_str(self) -> &'static str {
        match self { Self::Build => "build", Self::Test => "test" }
    }

    fn parse(value: &str) -> Option<Self> {
        match value { "build" => Some(Self::Build), "test" => Some(Self::Test), _ => None }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct WorkspaceCommandProfileV1 {
    pub(crate) profile_id: String,
    pub(crate) revision: u64,
    pub(crate) enabled: bool,
    pub(crate) actions: BTreeSet<WorkspaceCommandActionV1>,
    pub(crate) executable_selector: String,
    pub(crate) executable_digest: String,
    pub(crate) fixed_prefix: Vec<String>,
    pub(crate) allowed_values_by_position: Vec<Vec<String>>,
    pub(crate) max_argument_count: u64,
    pub(crate) max_argument_bytes: u64,
    pub(crate) allowed_environment_names: BTreeSet<String>,
    pub(crate) network_policy: String,
    pub(crate) max_wall_time_ms: u64,
    pub(crate) max_stdout_bytes: u64,
    pub(crate) max_stderr_bytes: u64,
    pub(crate) max_processes: u64,
    pub(crate) required_os_guarantees: BTreeSet<String>,
    pub(crate) profile_digest: String,
    immutable_claims: Value,
}

impl WorkspaceCommandProfileV1 {
    /// Decode the exact schema-v1 DTO, validate bounds and recompute its
    /// domain-separated canonical MessagePack digest. HostKernel must separately
    /// establish that this is the current user-owned Core Config revision.
    pub(crate) fn from_value(value: &Value) -> Option<Self> {
        let Value::Map(fields) = value else { return None };
        exact_keys(fields, &["schemaVersion", "profileId", "revision", "enabled", "actions",
            "executable", "arguments", "workingDirectory", "environment", "filesystem",
            "network", "limits", "profileDigest"])?;
        if unsigned(fields, "schemaVersion")? != 1
            || text(fields, "workingDirectory")? != "registered_workspace_root"
            || text(fields, "filesystem")? != "registered_workspace_and_isolated_temp_cache_roots"
        { return None; }

        let profile_id = text(fields, "profileId")?.to_owned();
        if !valid_id(&profile_id) { return None; }
        let revision = decimal(fields, "revision", true)?;
        let enabled = match fields.get("enabled")? { Value::Bool(value) => *value, _ => return None };
        let Value::Array(action_values) = fields.get("actions")? else { return None };
        if action_values.is_empty() || action_values.len() > 2 { return None; }
        let mut actions = BTreeSet::new();
        for value in action_values {
            let Value::String(value) = value else { return None };
            if !actions.insert(WorkspaceCommandActionV1::parse(value)?) { return None; }
        }

        let executable = map(fields.get("executable")?, &["selector", "resolvedDigest"])?;
        let executable_selector = text(executable, "selector")?.to_owned();
        let executable_digest = digest(executable, "resolvedDigest")?.to_owned();
        if executable_selector.len() > 256 || executable_selector.contains('\0') { return None; }

        let arguments = map(fields.get("arguments")?, &["fixedPrefix", "allowedValuesByPosition", "maxCount", "maxBytes"])?;
        let fixed_prefix = strings(arguments, "fixedPrefix", 64, 256, false)?;
        let allowed_values_by_position = string_matrix(arguments, "allowedValuesByPosition", 64, 128, 256)?;
        let max_argument_count = unsigned(arguments, "maxCount")?;
        let max_argument_bytes = unsigned(arguments, "maxBytes")?;
        if max_argument_count > 128 || fixed_prefix.len().saturating_add(allowed_values_by_position.len()) as u64 > max_argument_count
            || !(1..=32_768).contains(&max_argument_bytes)
        { return None; }

        let environment = map(fields.get("environment")?, &["policy", "allowedNames"])?;
        if text(environment, "policy")? != "sanitized_allowlist" { return None; }
        let environment_names: BTreeSet<_> = strings(environment, "allowedNames", 64, 128, false)?
            .into_iter().collect();
        if environment_names.len() != match environment.get("allowedNames")? { Value::Array(values) => values.len(), _ => return None }
            || environment_names.iter().any(|name| !valid_env_name(name))
        { return None; }

        let network_policy = text(fields, "network")?.to_owned();
        if !matches!(network_policy.as_str(), "deny" | "explicit_network_egress_grant") { return None; }
        let limits = map(fields.get("limits")?, &["maxWallTimeMs", "maxStdoutBytes", "maxStderrBytes", "maxProcesses", "requiredOsGuarantees"])?;
        let max_wall_time_ms = unsigned(limits, "maxWallTimeMs")?;
        let max_stdout_bytes = unsigned(limits, "maxStdoutBytes")?;
        let max_stderr_bytes = unsigned(limits, "maxStderrBytes")?;
        let max_processes = unsigned(limits, "maxProcesses")?;
        if !(1..=3_600_000).contains(&max_wall_time_ms)
            || !(1..=16_777_216).contains(&max_stdout_bytes)
            || !(1..=16_777_216).contains(&max_stderr_bytes)
            || !(1..=256).contains(&max_processes)
        { return None; }
        let required_os_guarantees: BTreeSet<String> = strings(limits, "requiredOsGuarantees", 6, 64, false)?
            .into_iter().collect();
        if required_os_guarantees.len() != match limits.get("requiredOsGuarantees")? { Value::Array(values) => values.len(), _ => return None }
            || required_os_guarantees.iter().any(|item| !matches!(item.as_str(),
                "cpu" | "memory" | "process_count" | "file_descriptors" | "filesystem_write_confinement" | "network_confinement"))
        { return None; }

        let profile_digest = digest(fields, "profileDigest")?.to_owned();
        let mut immutable_claims = fields.clone();
        immutable_claims.remove("profileDigest");
        let encoded = messagepack::encode(&Value::Map(immutable_claims.clone()), FRAME_LIMITS).ok()?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(DIGEST_DOMAIN);
        hasher.update(&encoded);
        if format!("blake3:{}", hasher.finalize().to_hex()) != profile_digest { return None; }

        Some(Self { profile_id, revision, enabled, actions, executable_selector, executable_digest,
            fixed_prefix, allowed_values_by_position, max_argument_count, max_argument_bytes,
            allowed_environment_names: environment_names, network_policy, max_wall_time_ms,
            max_stdout_bytes, max_stderr_bytes, max_processes, required_os_guarantees,
            profile_digest, immutable_claims: Value::Map(std::mem::take(&mut immutable_claims)) })
    }

    pub(crate) fn allows(&self, action: WorkspaceCommandActionV1) -> bool {
        self.enabled && self.actions.contains(&action)
    }

    /// Build argv only from the Core-owned prefix and exact per-position literals.
    /// The caller still must use Guard and the single ExecutionHost supervisor.
    pub(crate) fn argv(&self, action: WorkspaceCommandActionV1, tail: &[String]) -> Option<Vec<String>> {
        if !self.allows(action) || self.fixed_prefix.len().saturating_add(tail.len()) > self.max_argument_count as usize
            || tail.len() != self.allowed_values_by_position.len()
            || tail.iter().zip(&self.allowed_values_by_position).any(|(arg, allowed)| !allowed.contains(arg))
        { return None; }
        let mut argv = self.fixed_prefix.clone();
        argv.extend_from_slice(tail);
        let bytes = argv.iter().try_fold(0usize, |sum, arg| sum.checked_add(arg.len()))?;
        (bytes as u64 <= self.max_argument_bytes).then_some(argv)
    }

    pub(crate) fn immutable_digest(&self) -> Result<String, messagepack::MessagePackError> {
        let encoded = messagepack::encode(&self.immutable_claims, FRAME_LIMITS)?;
        let mut hasher = blake3::Hasher::new();
        hasher.update(DIGEST_DOMAIN);
        hasher.update(&encoded);
        Ok(format!("blake3:{}", hasher.finalize().to_hex()))
    }

    /// Resolve only an installation-owned selector and pin the executable bytes
    /// again at the point where HostKernel is preparing a launch. The selector
    /// table is host state; neither its path nor an executable path can come from
    /// the invocation or workspace profile.
    pub(crate) fn resolve_executable(
        &self,
        selectors: &BTreeMap<String, PathBuf>,
    ) -> Result<PathBuf, WorkspaceCommandProfileErrorV1> {
        let path = selectors.get(&self.executable_selector)
            .ok_or(WorkspaceCommandProfileErrorV1::SelectorUnavailable)?;
        if !path.is_absolute() || path.to_str().is_none() {
            return Err(WorkspaceCommandProfileErrorV1::SelectorUnavailable);
        }
        let metadata = std::fs::symlink_metadata(path)
            .map_err(|_| WorkspaceCommandProfileErrorV1::SelectorUnavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(WorkspaceCommandProfileErrorV1::SelectorUnavailable);
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if metadata.permissions().mode() & 0o111 == 0 {
                return Err(WorkspaceCommandProfileErrorV1::SelectorUnavailable);
            }
        }
        let canonical = std::fs::canonicalize(path)
            .map_err(|_| WorkspaceCommandProfileErrorV1::SelectorUnavailable)?;
        if canonical != *path {
            return Err(WorkspaceCommandProfileErrorV1::SelectorUnavailable);
        }
        let observed = crate::terminal_process::executable_digest(&canonical)
            .map_err(|_| WorkspaceCommandProfileErrorV1::SelectorUnavailable)?;
        if observed != self.executable_digest {
            return Err(WorkspaceCommandProfileErrorV1::ExecutableChanged);
        }
        Ok(canonical)
    }

    /// Refuse a profile whose required hard guarantees are not explicitly proven
    /// by the selected host backend. Monitoring and admission bounds are not
    /// accepted as substitutes for OS-enforced dimensions.
    pub(crate) fn require_guarantees(
        &self,
        available: &BTreeSet<String>,
    ) -> Result<(), WorkspaceCommandProfileErrorV1> {
        if self.required_os_guarantees.iter().all(|required| available.contains(required)) {
            Ok(())
        } else {
            Err(WorkspaceCommandProfileErrorV1::GuaranteeUnavailable)
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WorkspaceCommandProfileErrorV1 {
    SelectorUnavailable,
    ExecutableChanged,
    GuaranteeUnavailable,
}

fn map<'a>(value: &'a Value, keys: &[&str]) -> Option<&'a BTreeMap<String, Value>> {
    let Value::Map(fields) = value else { return None };
    exact_keys(fields, keys)?;
    Some(fields)
}
fn exact_keys(fields: &BTreeMap<String, Value>, expected: &[&str]) -> Option<()> {
    (fields.len() == expected.len() && expected.iter().all(|key| fields.contains_key(*key))).then_some(())
}
fn text<'a>(fields: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    match fields.get(key)? { Value::String(value) if !value.is_empty() && !value.contains('\0') => Some(value), _ => None }
}
fn unsigned(fields: &BTreeMap<String, Value>, key: &str) -> Option<u64> {
    match fields.get(key)? { Value::Unsigned(value) => Some(*value), _ => None }
}
fn decimal(fields: &BTreeMap<String, Value>, key: &str, positive: bool) -> Option<u64> {
    let value = text(fields, key)?;
    let parsed = value.parse::<u64>().ok()?;
    (parsed.to_string() == value && (!positive || parsed > 0)).then_some(parsed)
}
fn digest<'a>(fields: &'a BTreeMap<String, Value>, key: &str) -> Option<&'a str> {
    let value = text(fields, key)?;
    (value.len() == 71 && value.starts_with("blake3:")
        && value[7..].bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))).then_some(value)
}
fn strings(fields: &BTreeMap<String, Value>, key: &str, max_items: usize, max_len: usize, nonempty: bool) -> Option<Vec<String>> {
    let Value::Array(values) = fields.get(key)? else { return None };
    if values.len() > max_items { return None; }
    values.iter().map(|value| match value {
        Value::String(value) if value.len() <= max_len && (!nonempty || !value.is_empty()) && !value.contains('\0') => Some(value.clone()),
        _ => None,
    }).collect()
}
fn string_matrix(fields: &BTreeMap<String, Value>, key: &str, max_positions: usize, max_items: usize, max_len: usize) -> Option<Vec<Vec<String>>> {
    let Value::Array(rows) = fields.get(key)? else { return None };
    if rows.len() > max_positions { return None; }
    let mut output = Vec::with_capacity(rows.len());
    for row in rows {
        let Value::Array(values) = row else { return None };
        if values.is_empty() || values.len() > max_items { return None; }
        let parsed: Vec<String> = values.iter().map(|value| match value {
            Value::String(value) if value.len() <= max_len && !value.contains('\0') => Some(value.clone()),
            _ => None,
        }).collect::<Option<_>>()?;
        let unique: BTreeSet<_> = parsed.iter().collect();
        if unique.len() != parsed.len() { return None; }
        output.push(parsed);
    }
    Some(output)
}
fn valid_id(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256
        && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
fn valid_env_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    let syntax_ok = bytes.next().is_some_and(|byte| byte.is_ascii_alphabetic() || byte == b'_')
        && value.len() <= 128 && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_');
    let upper = value.to_ascii_uppercase();
    syntax_ok
        && !["PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "TEMP", "TMP"]
            .iter().any(|reserved| upper == *reserved)
        && !["SECRET", "TOKEN", "PASSWORD", "API_KEY", "ACCESS_KEY", "PRIVATE_KEY"]
            .iter().any(|suffix| upper == *suffix || upper.ends_with(&format!("_{suffix}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile_value() -> Value {
        let mut fields = BTreeMap::from([
            ("schemaVersion".into(), Value::Unsigned(1)),
            ("profileId".into(), Value::String("trusted.build".into())),
            ("revision".into(), Value::String("7".into())),
            ("enabled".into(), Value::Bool(true)),
            ("actions".into(), Value::Array(vec![Value::String("build".into())])),
            ("executable".into(), Value::Map(BTreeMap::from([
                ("selector".into(), Value::String("toolchain.cc".into())),
                ("resolvedDigest".into(), Value::String(format!("blake3:{}", "a".repeat(64)))),
            ]))),
            ("arguments".into(), Value::Map(BTreeMap::from([
                ("fixedPrefix".into(), Value::Array(vec![Value::String("--build".into())])),
                ("allowedValuesByPosition".into(), Value::Array(vec![Value::Array(vec![
                    Value::String("--offline".into()), Value::String("--locked".into()),
                ])])),
                ("maxCount".into(), Value::Unsigned(3)),
                ("maxBytes".into(), Value::Unsigned(128)),
            ]))),
            ("workingDirectory".into(), Value::String("registered_workspace_root".into())),
            ("environment".into(), Value::Map(BTreeMap::from([
                ("policy".into(), Value::String("sanitized_allowlist".into())),
                ("allowedNames".into(), Value::Array(vec![])),
            ]))),
            ("filesystem".into(), Value::String("registered_workspace_and_isolated_temp_cache_roots".into())),
            ("network".into(), Value::String("deny".into())),
            ("limits".into(), Value::Map(BTreeMap::from([
                ("maxWallTimeMs".into(), Value::Unsigned(60_000)),
                ("maxStdoutBytes".into(), Value::Unsigned(4096)),
                ("maxStderrBytes".into(), Value::Unsigned(4096)),
                ("maxProcesses".into(), Value::Unsigned(4)),
                ("requiredOsGuarantees".into(), Value::Array(vec![])),
            ]))),
        ]);
        let encoded = messagepack::encode(&Value::Map(fields.clone()), FRAME_LIMITS).unwrap();
        let mut hasher = blake3::Hasher::new();
        hasher.update(DIGEST_DOMAIN);
        hasher.update(&encoded);
        fields.insert("profileDigest".into(), Value::String(format!("blake3:{}", hasher.finalize().to_hex())));
        Value::Map(fields)
    }

    #[test]
    fn fixed_argv_requires_the_exact_configured_literal_tuple() {
        let profile = WorkspaceCommandProfileV1::from_value(&profile_value()).unwrap();

        assert_eq!(profile.argv(WorkspaceCommandActionV1::Build, &["--offline".into()]),
            Some(vec!["--build".into(), "--offline".into()]));
        assert_eq!(profile.argv(WorkspaceCommandActionV1::Test, &["--offline".into()]), None);
        assert_eq!(profile.argv(WorkspaceCommandActionV1::Build, &["--offline; touch marker".into()]), None);
        assert_eq!(profile.argv(WorkspaceCommandActionV1::Build, &["--offline".into(), "--locked".into()]), None);
    }

    #[test]
    fn immutable_profile_digest_rejects_definition_drift() {
        let mut value = profile_value();
        let Value::Map(fields) = &mut value else { unreachable!() };
        fields.insert("enabled".into(), Value::Bool(false));

        assert!(WorkspaceCommandProfileV1::from_value(&value).is_none());
    }
}
