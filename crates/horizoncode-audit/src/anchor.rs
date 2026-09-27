//! Root anchoring: signed segment roots, the local root chain, and the
//! declared anchor sink (`ARCH/14-AUDIT.md` §Root anchoring, `DEC-022`).
//!
//! Three things happen when a segment is finalized:
//!
//! 1. its **Merkle root** is computed over the committed entry hashes;
//! 2. the root is **signed** with the device key and appended to `roots.jsonl`,
//!    chain-linked by `prev_root` so deleting or editing a root breaks the root
//!    chain;
//! 3. the signed root is **anchored** to the declared sink when the cadence is
//!    due.
//!
//! A configured-but-unreachable sink is a **fail-closed** error, never a silent
//! degradation to a weaker level presented as the configured one.

use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::entry::AnchorLevelName;
use crate::error::AuditError;
use crate::key::{DeviceKey, SignedDigest, reject_group_or_other_access, set_owner_only};
use crate::merkle::digest;

/// The genesis `prev_root` for the first finalized segment.
pub const GENESIS_PREV_ROOT: &str = genesis_prev_root();

const fn genesis_prev_root() -> &'static str {
    // Pinned here and asserted against the computed value in
    // `tests::genesis_root_matches_its_label`.
    "ead29c1af873fcbf3077516ed6c06b7747cbe9997358597ec0fface4162bd57c"
}

/// The label hashed to produce [`GENESIS_PREV_ROOT`].
pub const GENESIS_ROOT_LABEL: &str = "horizoncode/audit/roots/genesis/v1";

/// The default sink directory name, a **sibling** of the audit store root.
pub const DEFAULT_SINK_DIR: &str = "audit-anchor";
/// The sink file name inside the sink directory.
pub const SINK_FILE: &str = "roots.jsonl";
/// The reference file used to learn the process's own uid without a syscall
/// dependency.
const OWNER_REFERENCE_FILE: &str = ".owner-ref";

/// The only supported hash function (`ARCH/03` §5).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum HashAlgorithm {
    /// `blake3`, the chain and Merkle hash.
    #[default]
    Blake3,
}

impl HashAlgorithm {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Blake3 => "blake3",
        }
    }
}

/// Where the signed root is anchored.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum OffBox {
    /// No sink: signed roots stay inside the audit store (`local-trust`).
    None,
    /// A distinct, validated append-only file sink outside the audit store
    /// root (`local-sink`, the default).
    #[default]
    File,
    /// An off-host object store or counter-signing service (`off-box`).
    Remote,
}

impl OffBox {
    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "file" => Some(Self::File),
            "remote" => Some(Self::Remote),
            _ => None,
        }
    }

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::File => "file",
            Self::Remote => "remote",
        }
    }
}

/// A deployment-declared trust requirement.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum TrustRequirement {
    /// No off-box requirement is declared.
    #[default]
    None,
    /// The deployment requires an off-box anchor.
    OffBox,
}

impl TrustRequirement {
    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "none" => Some(Self::None),
            "off_box" => Some(Self::OffBox),
            _ => None,
        }
    }
}

/// When a finalized root is pushed to the sink.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum AnchorCadence {
    /// Anchor at every session/turn close (`DEC-022`'s zero-config default).
    #[default]
    SessionClose,
    /// Anchor every `n` finalized segments.
    EveryNSegments(u32),
}

impl AnchorCadence {
    /// Parses a wire name (`session_close` or `every_n_segments:N`).
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        if value == "session_close" {
            return Some(Self::SessionClose);
        }
        let count = value.strip_prefix("every_n_segments:")?;
        let count = count.parse::<u32>().ok()?;
        (count > 0).then_some(Self::EveryNSegments(count))
    }

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> String {
        match self {
            Self::SessionClose => "session_close".to_owned(),
            Self::EveryNSegments(count) => format!("every_n_segments:{count}"),
        }
    }
}

/// The anchoring configuration. `sign` is deliberately absent: signing is
/// unconditional (`REQ-AUDIT-004`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AnchorConfig {
    /// The sink transport.
    pub offbox: OffBox,
    /// An explicit sink path; the default is a sibling of the audit store root.
    pub sink_path: Option<PathBuf>,
    /// The deployment's declared trust requirement.
    pub trust_requirement: TrustRequirement,
    /// When a finalized root is anchored.
    pub cadence: AnchorCadence,
}

impl Default for AnchorConfig {
    fn default() -> Self {
        Self {
            offbox: OffBox::File,
            sink_path: None,
            trust_requirement: TrustRequirement::None,
            cadence: AnchorCadence::SessionClose,
        }
    }
}

impl AnchorConfig {
    /// Parses an `anchor` object (or a whole `audit` object) from configuration.
    ///
    /// # Errors
    /// Returns [`AuditError::Config`] for an unknown key value, an unknown
    /// cadence, a `trust_requirement: "off_box"` without `offbox: "remote"`, and
    /// — deliberately — for `sign: false`, which is a configuration error rather
    /// than a supported posture.
    pub fn from_json(value: &Value) -> Result<Self, AuditError> {
        let anchor = value.get("anchor").unwrap_or(value);
        let Some(anchor) = anchor.as_object() else {
            return Err(AuditError::Config(
                "audit.anchor must be a JSON object".to_owned(),
            ));
        };
        match anchor.get("sign") {
            None | Some(Value::Null) => {}
            Some(Value::Bool(true)) => {}
            Some(Value::Bool(false)) => {
                return Err(AuditError::Config(
                    "audit.anchor.sign is false; signing is a security control and is not \
                     configurable off"
                        .to_owned(),
                ));
            }
            Some(_) => {
                return Err(AuditError::Config(
                    "audit.anchor.sign must be a boolean".to_owned(),
                ));
            }
        }
        let offbox = match anchor.get("offbox") {
            None => OffBox::default(),
            Some(Value::String(value)) => OffBox::parse(value).ok_or_else(|| {
                AuditError::Config(format!(
                    "audit.anchor.offbox must be one of none|file|remote, got `{value}`"
                ))
            })?,
            Some(_) => {
                return Err(AuditError::Config(
                    "audit.anchor.offbox must be a string".to_owned(),
                ));
            }
        };
        let sink_path = match anchor.get("sink_path") {
            None | Some(Value::Null) => None,
            Some(Value::String(value)) => Some(PathBuf::from(value)),
            Some(_) => {
                return Err(AuditError::Config(
                    "audit.anchor.sink_path must be a string".to_owned(),
                ));
            }
        };
        let trust_requirement = match anchor.get("trust_requirement") {
            None => TrustRequirement::default(),
            Some(Value::String(value)) => TrustRequirement::parse(value).ok_or_else(|| {
                AuditError::Config(format!(
                    "audit.anchor.trust_requirement must be none|off_box, got `{value}`"
                ))
            })?,
            Some(_) => {
                return Err(AuditError::Config(
                    "audit.anchor.trust_requirement must be a string".to_owned(),
                ));
            }
        };
        let cadence = match anchor.get("cadence") {
            None => AnchorCadence::default(),
            Some(Value::String(value)) => AnchorCadence::parse(value).ok_or_else(|| {
                AuditError::Config(format!(
                    "audit.anchor.cadence must be session_close or every_n_segments:N, got `{value}`"
                ))
            })?,
            Some(_) => {
                return Err(AuditError::Config(
                    "audit.anchor.cadence must be a string".to_owned(),
                ));
            }
        };
        let declared_hash = anchor
            .get("hash")
            .or_else(|| value.get("hash"))
            .and_then(Value::as_str);
        if let Some(name) = declared_hash
            && name != HashAlgorithm::Blake3.as_str()
        {
            return Err(AuditError::Config(format!(
                "audit.hash must be `{}`; this build implements no other hash",
                HashAlgorithm::Blake3.as_str()
            )));
        }
        let config = Self {
            offbox,
            sink_path,
            trust_requirement,
            cadence,
        };
        config.validate()?;
        Ok(config)
    }

    /// Validates the internal consistency of the configuration.
    ///
    /// # Errors
    /// Returns [`AuditError::Config`] when a declared off-box trust requirement
    /// is not backed by `offbox: "remote"`, or when a `remote` sink carries an
    /// explicit local path.
    pub fn validate(&self) -> Result<(), AuditError> {
        if self.trust_requirement == TrustRequirement::OffBox && self.offbox != OffBox::Remote {
            return Err(AuditError::Config(format!(
                "trust_requirement `off_box` requires audit.anchor.offbox `remote`, got `{}`",
                self.offbox.as_str()
            )));
        }
        if self.offbox == OffBox::Remote && self.sink_path.is_some() {
            return Err(AuditError::Config(
                "audit.anchor.offbox `remote` must not carry a local sink_path".to_owned(),
            ));
        }
        Ok(())
    }

    /// Returns the anchoring level this configuration puts in force.
    #[must_use]
    pub fn level(&self) -> AnchorLevelName {
        match self.offbox {
            OffBox::None => AnchorLevelName::LocalTrust,
            OffBox::File => AnchorLevelName::LocalSink,
            OffBox::Remote => AnchorLevelName::OffBox,
        }
    }

    /// Resolves the sink path for a given audit store root.
    ///
    /// # Errors
    /// Returns [`AuditError::SinkInsideAuditRoot`] when the resolved sink lies
    /// inside the audit store root, and [`AuditError::Config`] when a `remote`
    /// sink is requested.
    pub fn resolve_sink(&self, root: &Path) -> Result<Option<PathBuf>, AuditError> {
        self.validate()?;
        match self.offbox {
            OffBox::None => Ok(None),
            OffBox::Remote => Err(AuditError::Unsupported(
                "audit.anchor.offbox `remote` (an off-host object store or counter-signing \
                 service)"
                    .to_owned(),
            )),
            OffBox::File => {
                let sink = match &self.sink_path {
                    Some(path) => path.clone(),
                    None => default_sink_path(root),
                };
                if sink.starts_with(root) {
                    return Err(AuditError::SinkInsideAuditRoot {
                        sink,
                        root: root.to_path_buf(),
                    });
                }
                Ok(Some(sink))
            }
        }
    }
}

/// The default sink path: a sibling directory of the audit store root.
#[must_use]
pub fn default_sink_path(root: &Path) -> PathBuf {
    root.parent()
        .unwrap_or(root)
        .join(DEFAULT_SINK_DIR)
        .join(SINK_FILE)
}

/// A finalized, signed segment root.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct RootRecord {
    /// The segment index this root covers.
    pub segment: u32,
    /// The first audit `seq` in the segment.
    pub first_seq: u64,
    /// The last audit `seq` in the segment.
    pub last_seq: u64,
    /// How many entries the segment holds.
    pub count: u64,
    /// The Merkle root over the segment's entry hashes.
    pub merkle_root: String,
    /// The previous root's chain hash, or the genesis marker.
    pub prev_root: String,
    /// `blake3(canonical_root_body || prev_root)`.
    pub root_chain: String,
    /// The signature over the canonical root body.
    pub signature: SignedDigest,
    /// When the root was finalized (epoch milliseconds).
    pub ts: i64,
    /// The anchoring level in force when the root was finalized.
    pub level: AnchorLevelName,
}

/// Inputs for [`RootRecord::finalize`], grouped so the constructor stays
/// within the argument limit without losing any field.
#[derive(Clone, Copy, Debug)]
pub struct FinalizeOptions<'a> {
    /// The segment index this root covers.
    pub segment: u32,
    /// The ordered entry hashes of the segment.
    pub leaves: &'a [String],
    /// The first audit `seq` in the segment.
    pub first_seq: u64,
    /// The last audit `seq` in the segment.
    pub last_seq: u64,
    /// The previous root's chain hash, or the genesis marker.
    pub prev_root: &'a str,
    /// The device key the root is signed with.
    pub key: &'a DeviceKey,
    /// When the root was finalized (epoch milliseconds).
    pub ts: i64,
    /// The anchoring level in force when the root was finalized.
    pub level: AnchorLevelName,
}

impl RootRecord {
    /// The canonical bytes covered by the signature and the root chain.
    ///
    /// The six fields the architecture names are all present, plus the
    /// declared level and the timestamp; the extra two only strengthen the
    /// check and cannot weaken it.
    #[must_use]
    pub fn canonical_body(&self) -> Vec<u8> {
        serde_json::to_vec(&RootBody {
            segment: self.segment,
            first_seq: self.first_seq,
            last_seq: self.last_seq,
            count: self.count,
            merkle_root: &self.merkle_root,
            prev_root: &self.prev_root,
            level: self.level,
            ts: self.ts,
        })
        .expect("root body must serialize")
    }

    /// Builds a signed, chain-linked root record.
    #[must_use]
    pub fn finalize(options: FinalizeOptions<'_>) -> Self {
        let FinalizeOptions {
            segment,
            leaves,
            first_seq,
            last_seq,
            prev_root,
            key,
            ts,
            level,
        } = options;
        let mut record = Self {
            segment,
            first_seq,
            last_seq,
            count: leaves.len() as u64,
            merkle_root: crate::merkle::merkle_root(leaves),
            prev_root: prev_root.to_owned(),
            root_chain: String::new(),
            signature: SignedDigest {
                algorithm: String::new(),
                value: String::new(),
            },
            ts,
            level,
        };
        record.root_chain = record.compute_chain();
        record.signature = key.sign(&record.canonical_body());
        record
    }

    /// Recomputes the root chain hash.
    #[must_use]
    pub fn compute_chain(&self) -> String {
        let mut body = self.canonical_body();
        body.extend_from_slice(self.prev_root.as_bytes());
        digest(&body)
    }

    /// Returns whether the signature verifies under `key`.
    #[must_use]
    pub fn signature_ok(&self, key: &DeviceKey) -> bool {
        key.verify(&self.canonical_body(), &self.signature)
    }

    /// Renders the one-line form written to `roots.jsonl` and the sink.
    #[must_use]
    pub fn to_line(&self) -> String {
        let mut line = serde_json::to_string(self).expect("root record must serialize");
        line.push('\n');
        line
    }
}

#[derive(Serialize)]
struct RootBody<'a> {
    segment: u32,
    first_seq: u64,
    last_seq: u64,
    count: u64,
    merkle_root: &'a str,
    prev_root: &'a str,
    level: AnchorLevelName,
    ts: i64,
}

/// A validated append-only sink outside the audit store root.
#[derive(Clone, Debug)]
pub struct AnchorSink {
    path: PathBuf,
}

impl AnchorSink {
    /// Opens (creating if needed) and validates the sink.
    ///
    /// # Errors
    /// Returns [`AuditError::SinkUnreachable`] when the sink cannot be reached
    /// or appended to, and [`AuditError::UnsafePath`] when an existing sink
    /// fails the ownership/mode check. Both are fail-closed: a configured sink
    /// that cannot be validated is never silently replaced by a weaker level.
    pub fn open(path: &Path) -> Result<Self, AuditError> {
        let Some(parent) = path.parent() else {
            return Err(AuditError::SinkUnreachable {
                path: path.to_path_buf(),
                reason: "sink path has no parent directory".to_owned(),
            });
        };
        if !parent.exists() {
            fs::create_dir_all(parent).map_err(|error| AuditError::SinkUnreachable {
                path: path.to_path_buf(),
                reason: format!("cannot create the sink directory: {error}"),
            })?;
            crate::key::set_dir_owner_only(parent)?;
        }
        if !parent.is_dir() {
            return Err(AuditError::SinkUnreachable {
                path: path.to_path_buf(),
                reason: format!("parent {} is not a directory", parent.display()),
            });
        }
        let owner_uid = owner_uid(parent)?;
        if path.exists() {
            let metadata = fs::metadata(path).map_err(|error| AuditError::SinkUnreachable {
                path: path.to_path_buf(),
                reason: error.to_string(),
            })?;
            if !metadata.is_file() {
                return Err(AuditError::UnsafePath {
                    path: path.to_path_buf(),
                    reason: "sink is not a regular file".to_owned(),
                });
            }
            reject_group_or_other_access(path, &metadata, 0o022)?;
            check_owner(path, &metadata, owner_uid)?;
        } else {
            fs::OpenOptions::new()
                .append(true)
                .create_new(true)
                .open(path)
                .map_err(|error| AuditError::SinkUnreachable {
                    path: path.to_path_buf(),
                    reason: format!("cannot create the sink: {error}"),
                })?;
            set_owner_only(path)?;
        }
        // Reachability probe: the configured sink must be openable for append
        // now, not merely at some later anchor.
        OpenOptions::new()
            .append(true)
            .open(path)
            .map_err(|error| AuditError::SinkUnreachable {
                path: path.to_path_buf(),
                reason: format!("sink is not appendable: {error}"),
            })?;
        Ok(Self {
            path: path.to_path_buf(),
        })
    }

    /// Returns the sink path.
    #[must_use]
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one signed root, durably.
    ///
    /// # Errors
    /// Returns [`AuditError::SinkUnreachable`] on any write failure; the
    /// caller must treat that as a failed evidence gate.
    pub fn append_root(&self, record: &RootRecord) -> Result<(), AuditError> {
        let mut file = OpenOptions::new()
            .append(true)
            .open(&self.path)
            .map_err(|error| AuditError::SinkUnreachable {
                path: self.path.clone(),
                reason: error.to_string(),
            })?;
        file.write_all(record.to_line().as_bytes())
            .and_then(|()| file.flush())
            .and_then(|()| file.sync_data())
            .map_err(|error| AuditError::SinkUnreachable {
                path: self.path.clone(),
                reason: error.to_string(),
            })
    }

    /// Reads every anchored root line.
    ///
    /// # Errors
    /// Returns [`AuditError::SinkUnreachable`] when the sink cannot be read.
    pub fn read_roots(&self) -> Result<Vec<RootRecord>, AuditError> {
        let content =
            fs::read_to_string(&self.path).map_err(|error| AuditError::SinkUnreachable {
                path: self.path.clone(),
                reason: error.to_string(),
            })?;
        let mut out = Vec::new();
        for (index, line) in content.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let record = serde_json::from_str::<RootRecord>(line).map_err(|error| {
                AuditError::SinkUnreachable {
                    path: self.path.clone(),
                    reason: format!("line {}: {error}", index + 1),
                }
            })?;
            out.push(record);
        }
        Ok(out)
    }
}

/// Learns this process's uid by creating an owner-only reference file.
fn owner_uid(parent: &Path) -> Result<u32, AuditError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let reference = parent.join(OWNER_REFERENCE_FILE);
        if !reference.exists() {
            OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&reference)
                .map_err(|error| AuditError::SinkUnreachable {
                    path: reference.clone(),
                    reason: format!("cannot establish the sink owner reference: {error}"),
                })?;
            set_owner_only(&reference)?;
        }
        let metadata =
            fs::metadata(&reference).map_err(|error| AuditError::io(&reference, &error))?;
        Ok(metadata.uid())
    }
    #[cfg(not(unix))]
    {
        let _ = parent;
        let _ = OWNER_REFERENCE_FILE;
        Ok(0)
    }
}

#[cfg(unix)]
fn check_owner(path: &Path, metadata: &fs::Metadata, owner_uid: u32) -> Result<(), AuditError> {
    use std::os::unix::fs::MetadataExt;
    if metadata.uid() != owner_uid {
        return Err(AuditError::UnsafePath {
            path: path.to_path_buf(),
            reason: format!(
                "sink is owned by uid {} but this process is uid {owner_uid}",
                metadata.uid()
            ),
        });
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_owner(_path: &Path, _metadata: &fs::Metadata, _owner_uid: u32) -> Result<(), AuditError> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn default_posture_is_local_sink() {
        let config = AnchorConfig::default();
        assert_eq!(config.offbox, OffBox::File);
        assert_eq!(config.level(), AnchorLevelName::LocalSink);
    }

    #[test]
    fn sign_false_is_a_configuration_error() {
        let value = json!({ "anchor": { "sign": false, "offbox": "file" } });
        let error = AnchorConfig::from_json(&value).unwrap_err();
        assert!(matches!(error, AuditError::Config(_)));
        assert!(
            error.to_string().contains("not configurable off"),
            "{error}"
        );
    }

    #[test]
    fn a_zero_config_anchor_document_parses_to_local_sink() {
        let value = json!({ "anchor": { "sign": true } });
        let config = AnchorConfig::from_json(&value).unwrap();
        assert_eq!(config.level(), AnchorLevelName::LocalSink);
        assert_eq!(config.cadence, AnchorCadence::SessionClose);
    }

    #[test]
    fn an_off_box_trust_requirement_requires_a_remote_sink() {
        let value = json!({
            "anchor": { "sign": true, "offbox": "file", "trust_requirement": "off_box" }
        });
        let error = AnchorConfig::from_json(&value).unwrap_err();
        assert!(error.to_string().contains("requires"), "{error}");

        let value = json!({
            "anchor": { "sign": true, "offbox": "remote", "trust_requirement": "off_box" }
        });
        let config = AnchorConfig::from_json(&value).unwrap();
        assert_eq!(config.level(), AnchorLevelName::OffBox);
    }

    #[test]
    fn an_unknown_offbox_value_is_refused() {
        let value = json!({ "anchor": { "offbox": "s3" } });
        assert!(matches!(
            AnchorConfig::from_json(&value).unwrap_err(),
            AuditError::Config(_)
        ));
    }

    #[test]
    fn a_non_blake3_hash_is_refused() {
        let value = json!({ "hash": "sha256", "anchor": { "offbox": "file" } });
        assert!(AnchorConfig::from_json(&value).is_err());
    }

    #[test]
    fn the_sink_defaults_outside_the_audit_store_root() {
        let root = Path::new("/state/audit");
        let sink = AnchorConfig::default().resolve_sink(root).unwrap().unwrap();
        assert_eq!(sink, PathBuf::from("/state/audit-anchor/roots.jsonl"));
        assert!(!sink.starts_with(root));
    }

    #[test]
    fn a_sink_inside_the_audit_store_is_refused() {
        let root = Path::new("/state/audit");
        let config = AnchorConfig {
            sink_path: Some(PathBuf::from("/state/audit/inner.jsonl")),
            ..AnchorConfig::default()
        };
        assert!(matches!(
            config.resolve_sink(root).unwrap_err(),
            AuditError::SinkInsideAuditRoot { .. }
        ));
    }

    #[test]
    fn a_remote_sink_is_unsupported_rather_than_downgraded() {
        let root = Path::new("/state/audit");
        let config = AnchorConfig {
            offbox: OffBox::Remote,
            ..AnchorConfig::default()
        };
        assert!(matches!(
            config.resolve_sink(root).unwrap_err(),
            AuditError::Unsupported(_)
        ));
    }

    #[test]
    fn a_sink_under_a_regular_file_is_unreachable() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("not-a-dir");
        fs::write(&blocker, b"x").unwrap();
        let sink = blocker.join("roots.jsonl");
        let error = AnchorSink::open(&sink).unwrap_err();
        assert!(
            matches!(error, AuditError::SinkUnreachable { .. }),
            "{error}"
        );
    }

    #[test]
    #[cfg(unix)]
    fn a_world_writable_sink_is_refused() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let sink = dir.path().join("roots.jsonl");
        fs::write(&sink, b"").unwrap();
        fs::set_permissions(&sink, fs::Permissions::from_mode(0o666)).unwrap();
        let error = AnchorSink::open(&sink).unwrap_err();
        assert!(matches!(error, AuditError::UnsafePath { .. }), "{error}");
    }

    #[test]
    fn roots_round_trip_through_a_sink() {
        let dir = tempfile::tempdir().unwrap();
        let sink = AnchorSink::open(&dir.path().join("roots.jsonl")).unwrap();
        let key = DeviceKey::from_bytes([5u8; 32]);
        let record = RootRecord::finalize(FinalizeOptions {
            segment: 0,
            leaves: &[digest(b"a"), digest(b"b")],
            first_seq: 0,
            last_seq: 1,
            prev_root: GENESIS_PREV_ROOT,
            key: &key,
            ts: 1_700_000_000_000,
            level: AnchorLevelName::LocalSink,
        });
        sink.append_root(&record).unwrap();
        let read = sink.read_roots().unwrap();
        assert_eq!(read, vec![record]);
    }

    #[test]
    fn genesis_root_matches_its_label() {
        assert_eq!(
            crate::merkle::digest(GENESIS_ROOT_LABEL.as_bytes()),
            GENESIS_PREV_ROOT
        );
    }

    #[test]
    fn the_root_chain_links_to_its_predecessor() {
        let key = DeviceKey::from_bytes([6u8; 32]);
        let first = RootRecord::finalize(FinalizeOptions {
            segment: 0,
            leaves: &[digest(b"a")],
            first_seq: 0,
            last_seq: 0,
            prev_root: GENESIS_PREV_ROOT,
            key: &key,
            ts: 1,
            level: AnchorLevelName::LocalSink,
        });
        let second = RootRecord::finalize(FinalizeOptions {
            segment: 1,
            leaves: &[digest(b"b")],
            first_seq: 1,
            last_seq: 1,
            prev_root: &first.root_chain,
            key: &key,
            ts: 2,
            level: AnchorLevelName::LocalSink,
        });
        assert_ne!(first.root_chain, second.root_chain);
        assert_eq!(second.prev_root, first.root_chain);
    }

    #[test]
    fn cadence_parses_both_forms() {
        assert_eq!(
            AnchorCadence::parse("session_close"),
            Some(AnchorCadence::SessionClose)
        );
        assert_eq!(
            AnchorCadence::parse("every_n_segments:4"),
            Some(AnchorCadence::EveryNSegments(4))
        );
        assert_eq!(AnchorCadence::parse("every_n_segments:0"), None);
        assert_eq!(AnchorCadence::parse("hourly"), None);
    }
}
