//! Optional Linux cgroup-v2 process-tree containment for the existing ExecutionHost.
//!
//! The default adapter provides containment only. The `codemode.v1` profile also
//! requires cgroup-v2 CPU, memory and PID controllers plus a verified child
//! `RLIMIT_NOFILE`. Failure to find the delegated subtree, required controllers or
//! the verified child limit is a hard launch failure.

use std::fs::{self, File};
use std::io::{self, Read, Write};
use std::os::fd::{AsRawFd, FromRawFd};
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

const CGROUP2_SUPER_MAGIC: libc::c_long = 0x6367_7270;
const POLL_INTERVAL: Duration = Duration::from_millis(10);
const QUIESCE_TIMEOUT: Duration = Duration::from_secs(5);
const MAX_RETAINED_EXECUTION_CGROUPS: usize = 256;
static CGROUP_CREATE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CgroupIdentityV1 {
    pub boot_id: String,
    pub delegated_root: String,
    pub delegated_root_device: u64,
    pub delegated_root_inode: u64,
    pub delegated_root_owner_uid: u32,
    pub relative_path: String,
    pub cgroup_device: u64,
    pub cgroup_inode: u64,
    pub cgroup_owner_uid: u32,
    /// True only for a trusted confined launch whose mount view excludes the
    /// delegated cgroup hierarchy. Full Access children are never janitor-deleted.
    pub cgroup_hierarchy_hidden: bool,
    pub execution_id: String,
    pub effect_id: String,
    pub capability_lease_digest: String,
    /// Trusted process identity, distinct from the human reviewer where applicable.
    pub execution_principal: String,
    /// Exact direct/managed Attempt authority retained by the execution row.
    /// Nil is used only where the owning capability contract has no Attempt scope.
    pub attempt_scope_digest: Option<String>,
    pub owner_epoch: u64,
    pub process_generation: u64,
    pub process_kind: String,
    pub profile_id: String,
    pub profile_revision: u64,
    pub profile_digest: String,
    pub executable_digest: String,
    /// Immutable resource policy; `none` makes no resource-limit claim.
    pub resource_profile: String,
    /// Digest of the fixed, schema-versioned resource profile, distinct from the
    /// executable launch-profile digest.
    pub resource_profile_digest: String,
}

pub struct ExecutionCgroupV2 {
    identity: CgroupIdentityV1,
    placement: File,
}

impl ExecutionCgroupV2 {
    /// Create an empty per-effect cgroup below the current process's writable
    /// delegated cgroup-v2 subtree. `execution_id` is validated and hashed before
    /// it is used as a path component.
    pub fn create(
        execution_id: &str,
        effect_id: &str,
        capability_lease_digest: &str,
        execution_principal: &str,
        attempt_scope_digest: Option<&str>,
        owner_epoch: u64,
        process_generation: u64,
        process_kind: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
        executable_digest: &str,
        resource_profile: &str,
        cgroup_hierarchy_hidden: bool,
    ) -> io::Result<Self> {
        if !safe_identifier(execution_id) || !safe_identifier(effect_id)
            || !is_digest(capability_lease_digest)
            || !safe_principal(execution_principal)
            || attempt_scope_digest.is_some_and(|digest| !is_digest(digest)) || owner_epoch == 0
            || process_generation == 0 || !safe_identifier(process_kind)
            || !safe_identifier(profile_id) || profile_revision == 0
            || !is_digest(profile_digest) || !is_digest(executable_digest)
            || !matches!(resource_profile, "none" | "codemode.v1")
        {
            return Err(invalid("invalid cgroup execution binding"));
        }
        let mount = PathBuf::from("/sys/fs/cgroup");
        let mount_fd = open_directory_chain(Path::new("/"), Path::new("sys/fs/cgroup"))?;
        verify_cgroup2_fd(&mount_fd)?;
        let current = current_cgroup_path()?;
        // Resolve the delegated subtree once, walking from the mount through
        // O_NOFOLLOW directory descriptors. Do not validate a pathname and then
        // reopen it later: an ancestor replacement between those operations could
        // redirect both placement and durable recovery to another cgroup.
        let delegated_fd = open_directory_chain_at(&mount_fd, &current)?;
        let root_metadata = delegated_fd.metadata()?;
        if root_metadata.uid() != unsafe { libc::geteuid() } {
            return Err(invalid("delegated cgroup root is not owned by the ExecutionHost principal"));
        }
        // A writable cgroup.procs plus the mandatory v2 control files is the
        // delegated-subtree proof. Read-only or hybrid cgroup layouts fail closed.
        for (name, access) in [("cgroup.procs", libc::O_WRONLY), ("cgroup.events", libc::O_RDONLY), ("cgroup.kill", libc::O_WRONLY)] {
            open_control_at(&delegated_fd, name, access)?;
        }
        mkdir_at_if_absent(&delegated_fd, "horizoncode-execution-v1")?;
        let managed_root_fd = open_child_directory(&delegated_fd, "horizoncode-execution-v1")?;
        verify_owner_directory(&managed_root_fd)?;
        if resource_profile == "codemode.v1" {
            enable_codemode_controllers(&managed_root_fd)?;
        }
        let relative_path = format!("horizoncode-execution-v1/{}", digest_component(execution_id));
        let execution_component = digest_component(execution_id);
        {
            let _creation = CGROUP_CREATE_LOCK.lock().map_err(|_| invalid("execution cgroup admission lock is poisoned"))?;
            with_directory_lock(&managed_root_fd, || {
                if count_directory_entries(&managed_root_fd)? > MAX_RETAINED_EXECUTION_CGROUPS - 1 {
                    return Err(io::Error::new(io::ErrorKind::WouldBlock,
                        "retained execution cgroup bound reached; process launch is unavailable"));
                }
                mkdir_at(&managed_root_fd, &execution_component)
            })?;
        }
        let directory = open_child_directory(&managed_root_fd, &execution_component)?;
        verify_owner_directory(&directory)?;
        let metadata = directory.metadata()?;
        let placement = open_control_at(&directory, "cgroup.procs", libc::O_WRONLY)?;
        let delegated = mount.join(&current);
        let identity = CgroupIdentityV1 {
            boot_id: read_boot_id()?,
            delegated_root: delegated.to_string_lossy().into_owned(),
            delegated_root_device: root_metadata.dev(),
            delegated_root_inode: root_metadata.ino(),
            delegated_root_owner_uid: root_metadata.uid(),
            relative_path,
            cgroup_device: metadata.dev(),
            cgroup_inode: metadata.ino(),
            cgroup_owner_uid: metadata.uid(),
            cgroup_hierarchy_hidden,
            execution_id: execution_id.to_owned(),
            effect_id: effect_id.to_owned(),
            capability_lease_digest: capability_lease_digest.to_owned(),
            execution_principal: execution_principal.to_owned(),
            attempt_scope_digest: attempt_scope_digest.map(str::to_owned),
            owner_epoch,
            process_generation,
            process_kind: process_kind.to_owned(),
            profile_id: profile_id.to_owned(),
            profile_revision,
            profile_digest: profile_digest.to_owned(),
            executable_digest: executable_digest.to_owned(),
            resource_profile: resource_profile.to_owned(),
            resource_profile_digest: resource_profile_digest(resource_profile),
        };
        if resource_profile == "codemode.v1" {
            if let Err(error) = apply_codemode_limits(&directory) {
                // This identity has not escaped `create` and has never been
                // dispatched. Reclaim only while both the process-local namespace
                // lock and the cross-process parent-directory lock are held, and
                // only after reopening the exact name and proving it still names
                // this owner/inode and is empty. If any proof fails, leave it in
                // the bounded quarantine for the durable janitor/recovery path.
                if let Ok(_namespace) = CGROUP_CREATE_LOCK.lock() {
                    let _ = with_directory_lock(&managed_root_fd, || {
                    let current = open_child_directory(&managed_root_fd, &execution_component)?;
                    let current_meta = current.metadata()?;
                    let original_meta = directory.metadata()?;
                    if current_meta.dev() != metadata.dev()
                        || current_meta.ino() != metadata.ino()
                        || original_meta.dev() != metadata.dev()
                        || original_meta.ino() != metadata.ino()
                        || current_meta.uid() != unsafe { libc::geteuid() }
                        || read_populated(&current)? != 0
                    {
                        return Err(invalid("never-dispatched cgroup changed or is populated; retain for quarantine"));
                    }
                    let name = std::ffi::CString::new(execution_component.as_str())
                        .map_err(|_| invalid("cgroup name is malformed"))?;
                    if unsafe { libc::unlinkat(managed_root_fd.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
                        return Err(io::Error::last_os_error());
                    }
                    Ok(())
                    });
                }
                return Err(error);
            }
        }
        Ok(Self { identity, placement })
    }

    pub fn identity(&self) -> &CgroupIdentityV1 { &self.identity }
    pub fn placement_fd(&self) -> i32 { self.placement.as_raw_fd() }

    /// Revalidate the exact newly created containment boundary immediately before
    /// its identity is committed with the durable dispatch intent.
    pub fn confirm_empty_before_dispatch(identity: &CgroupIdentityV1) -> io::Result<()> {
        let directory = validate_identity(identity)?;
        if read_populated(&directory)? != 0 {
            return Err(invalid("new execution cgroup is not empty before durable dispatch"));
        }
        let metadata = directory.metadata()?;
        if metadata.dev() != identity.cgroup_device || metadata.ino() != identity.cgroup_inode {
            return Err(invalid("execution cgroup identity changed before durable dispatch"));
        }
        Ok(())
    }

    /// Confirm an identity is empty before dropping the local handle. Linux has
    /// no inode-targeted rmdir operation: unlinkat(parent, name) can race a name
    /// replacement even while the original directory fd is pinned. Retain the
    /// empty cgroup rather than risk deleting a different cgroup by name.
    pub fn retain_if_empty(identity: &CgroupIdentityV1) -> io::Result<()> {
        let directory = validate_identity(identity)?;
        if read_populated(&directory)? != 0 { return Err(invalid("cannot release a populated execution cgroup identity")); }
        let metadata = directory.metadata()?;
        if metadata.dev() != identity.cgroup_device || metadata.ino() != identity.cgroup_inode {
            return Err(invalid("execution cgroup identity changed before retaining empty group"));
        }
        Ok(())
    }

    /// Remove a cgroup only after its exact quiescence proof is durable. Children
    /// launched without the restricted mount view are retained for safety.
    pub fn remove_quiescent_if_empty(
        identity: &CgroupIdentityV1,
        persisted_quiescence_digest: &str,
    ) -> io::Result<()> {
        if !identity.cgroup_hierarchy_hidden
            || persisted_quiescence_digest != quiescence_digest(identity)
        {
            return Err(invalid("cgroup cleanup lacks an isolated launch or exact persisted quiescence proof"));
        }
        let mount = Path::new("/sys/fs/cgroup");
        let mount_fd = open_directory_chain(Path::new("/"), Path::new("sys/fs/cgroup"))?;
        verify_cgroup2_fd(&mount_fd)?;
        let delegated = PathBuf::from(&identity.delegated_root);
        let relative = delegated.strip_prefix(mount)
            .map_err(|_| invalid("delegated cgroup root escaped the canonical mount"))?;
        if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
            return Err(invalid("delegated cgroup root path is not canonical"));
        }
        let delegated_fd = open_directory_chain_at(&mount_fd, relative)?;
        let root_meta = delegated_fd.metadata()?;
        if root_meta.dev() != identity.delegated_root_device
            || root_meta.ino() != identity.delegated_root_inode
            || root_meta.uid() != identity.delegated_root_owner_uid
            || identity.delegated_root_owner_uid != unsafe { libc::geteuid() }
        {
            return Err(invalid("delegated cgroup owner or identity changed"));
        }
        let managed = open_child_directory(&delegated_fd, "horizoncode-execution-v1")?;
        let _process_lock = CGROUP_CREATE_LOCK.lock()
            .map_err(|_| invalid("execution cgroup namespace lock is poisoned"))?;
        with_directory_lock(&managed, || {
            let directory = validate_identity(identity)?;
            let metadata = directory.metadata()?;
            if metadata.dev() != identity.cgroup_device
                || metadata.ino() != identity.cgroup_inode
                || metadata.uid() != identity.cgroup_owner_uid
                || identity.cgroup_owner_uid != unsafe { libc::geteuid() }
                || read_populated(&directory)? != 0
            {
                return Err(invalid("cgroup is populated or its owner/inode changed before cleanup"));
            }
            drop(directory);
            let component = digest_component(&identity.execution_id);
            let name = std::ffi::CString::new(component)
                .map_err(|_| invalid("cgroup name is malformed"))?;
            // Linux has no inode-targeted cgroup rmdir. The exclusive lock,
            // child-hidden namespace and exact pinned inode authorize this name.
            if unsafe { libc::unlinkat(managed.as_raw_fd(), name.as_ptr(), libc::AT_REMOVEDIR) } < 0 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        })
    }

    /// Kill only this exact persisted cgroup and wait for kernel-reported quiescence.
    /// Callers must persist the returned proof before releasing any associated lease.
    pub fn kill_and_confirm_empty(identity: &CgroupIdentityV1) -> io::Result<String> {
        let directory = validate_identity(identity)?;
        let mut kill = open_control_at(&directory, "cgroup.kill", libc::O_WRONLY)?;
        kill.write_all(b"1\n")?;
        let deadline = Instant::now() + QUIESCE_TIMEOUT;
        loop {
            if read_populated(&directory)? == 0 {
                let metadata = directory.metadata()?;
                if metadata.dev() != identity.cgroup_device || metadata.ino() != identity.cgroup_inode {
                    return Err(invalid("cgroup identity changed during quiescence check"));
                }
                return Ok(quiescence_digest(identity));
            }
            if Instant::now() >= deadline {
                return Err(io::Error::new(io::ErrorKind::TimedOut, "cgroup did not become empty"));
            }
            std::thread::sleep(POLL_INTERVAL);
        }
    }
}

fn quiescence_digest(identity: &CgroupIdentityV1) -> String {
    let proof = format!("horizoncode.cgroup-v2.quiescence.v2\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}\0{}",
        identity.boot_id, identity.execution_id, identity.effect_id,
        identity.owner_epoch, identity.process_generation, identity.process_kind,
        identity.profile_id, identity.profile_revision, identity.profile_digest,
        identity.executable_digest, identity.cgroup_device, identity.cgroup_inode,
        identity.delegated_root, identity.delegated_root_device,
        identity.delegated_root_inode, identity.relative_path,
        identity.capability_lease_digest, identity.execution_principal,
        identity.attempt_scope_digest.as_deref().unwrap_or("none"),
        identity.delegated_root_owner_uid, identity.cgroup_owner_uid,
        identity.cgroup_hierarchy_hidden);
    format!("blake3:{}", blake3::hash(proof.as_bytes()).to_hex())
}

impl CgroupIdentityV1 {
    pub fn to_value(&self) -> crate::protocol::Value {
        use crate::protocol::Value;
        Value::Map(std::collections::BTreeMap::from([
            ("bootID".into(), Value::String(self.boot_id.clone())),
            ("delegatedRoot".into(), Value::String(self.delegated_root.clone())),
            ("delegatedRootDevice".into(), Value::String(self.delegated_root_device.to_string())),
            ("delegatedRootInode".into(), Value::String(self.delegated_root_inode.to_string())),
            ("delegatedRootOwnerUID".into(), Value::String(self.delegated_root_owner_uid.to_string())),
            ("relativePath".into(), Value::String(self.relative_path.clone())),
            ("cgroupDevice".into(), Value::String(self.cgroup_device.to_string())),
            ("cgroupInode".into(), Value::String(self.cgroup_inode.to_string())),
            ("cgroupOwnerUID".into(), Value::String(self.cgroup_owner_uid.to_string())),
            ("cgroupHierarchyHidden".into(), Value::Bool(self.cgroup_hierarchy_hidden)),
            ("executionID".into(), Value::String(self.execution_id.clone())),
            ("effectID".into(), Value::String(self.effect_id.clone())),
            ("capabilityLeaseDigest".into(), Value::String(self.capability_lease_digest.clone())),
            ("executionPrincipal".into(), Value::String(self.execution_principal.clone())),
            ("attemptScopeDigest".into(), self.attempt_scope_digest.as_ref()
                .map_or(Value::Nil, |digest| Value::String(digest.clone()))),
            ("ownerEpoch".into(), Value::String(self.owner_epoch.to_string())),
            ("processGeneration".into(), Value::String(self.process_generation.to_string())),
            ("processKind".into(), Value::String(self.process_kind.clone())),
            ("profileID".into(), Value::String(self.profile_id.clone())),
            ("profileRevision".into(), Value::String(self.profile_revision.to_string())),
            ("profileDigest".into(), Value::String(self.profile_digest.clone())),
            ("executableDigest".into(), Value::String(self.executable_digest.clone())),
            ("resourceProfile".into(), Value::String(self.resource_profile.clone())),
            ("resourceProfileDigest".into(), Value::String(self.resource_profile_digest.clone())),
        ]))
    }

    pub fn from_value(value: &crate::protocol::Value) -> io::Result<Self> {
        use crate::protocol::Value;
        let Value::Map(fields) = value else { return Err(invalid("cgroup identity is not a map")); };
        const KEYS: [&str; 24] = [
            "bootID", "delegatedRoot", "delegatedRootDevice", "delegatedRootInode",
            "delegatedRootOwnerUID",
            "relativePath", "cgroupDevice", "cgroupInode", "executionID", "effectID",
            "cgroupOwnerUID", "cgroupHierarchyHidden",
            "capabilityLeaseDigest", "executionPrincipal", "attemptScopeDigest", "ownerEpoch", "processGeneration", "processKind",
            "profileID", "profileRevision", "profileDigest", "executableDigest", "resourceProfile", "resourceProfileDigest",
        ];
        const LEGACY_KEYS: [&str; 21] = [
            "bootID", "delegatedRoot", "delegatedRootDevice", "delegatedRootInode",
            "relativePath", "cgroupDevice", "cgroupInode", "executionID", "effectID",
            "capabilityLeaseDigest", "executionPrincipal", "attemptScopeDigest", "ownerEpoch", "processGeneration", "processKind",
            "profileID", "profileRevision", "profileDigest", "executableDigest", "resourceProfile", "resourceProfileDigest",
        ];
        let legacy = fields.len() == LEGACY_KEYS.len()
            && LEGACY_KEYS.iter().all(|key| fields.contains_key(*key));
        if !legacy && (fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key))) {
            return Err(invalid("cgroup identity has an unexpected field set"));
        }
        let text = |key: &str| match fields.get(key) {
            Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => Ok(value.clone()),
            _ => Err(invalid("cgroup identity text field is invalid")),
        };
        let decimal = |key: &str| -> io::Result<u64> {
            let value = text(key)?;
            if value.len() > 1 && value.starts_with('0') || !value.bytes().all(|byte| byte.is_ascii_digit()) {
                return Err(invalid("cgroup identity integer is noncanonical"));
            }
            value.parse().map_err(|_| invalid("cgroup identity integer exceeds u64"))
        };
        let identity = Self {
            boot_id: text("bootID")?, delegated_root: text("delegatedRoot")?,
            delegated_root_device: decimal("delegatedRootDevice")?, delegated_root_inode: decimal("delegatedRootInode")?,
            delegated_root_owner_uid: if legacy { 0 } else { u32::try_from(decimal("delegatedRootOwnerUID")?).map_err(|_| invalid("delegated cgroup owner uid is invalid"))? },
            relative_path: text("relativePath")?, cgroup_device: decimal("cgroupDevice")?, cgroup_inode: decimal("cgroupInode")?,
            cgroup_owner_uid: if legacy { 0 } else { u32::try_from(decimal("cgroupOwnerUID")?).map_err(|_| invalid("cgroup owner uid is invalid"))? },
            cgroup_hierarchy_hidden: if legacy { false } else { match fields.get("cgroupHierarchyHidden") { Some(Value::Bool(value)) => *value, _ => return Err(invalid("cgroup visibility proof is invalid")) } },
            execution_id: text("executionID")?, effect_id: text("effectID")?,
            capability_lease_digest: text("capabilityLeaseDigest")?,
            execution_principal: text("executionPrincipal")?, owner_epoch: decimal("ownerEpoch")?,
            attempt_scope_digest: match fields.get("attemptScopeDigest") {
                Some(Value::Nil) => None,
                Some(Value::String(value)) if is_digest(value) => Some(value.clone()),
                _ => return Err(invalid("cgroup Attempt scope digest is invalid")),
            },
            process_generation: decimal("processGeneration")?, process_kind: text("processKind")?,
            profile_id: text("profileID")?, profile_revision: decimal("profileRevision")?,
            profile_digest: text("profileDigest")?, executable_digest: text("executableDigest")?,
            resource_profile: text("resourceProfile")?,
            resource_profile_digest: text("resourceProfileDigest")?,
        };
        if identity.boot_id.len() != 36 || !identity.boot_id.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
            || !safe_identifier(&identity.execution_id) || !safe_identifier(&identity.effect_id)
            || !safe_principal(&identity.execution_principal)
            || !is_digest(&identity.capability_lease_digest) || identity.owner_epoch == 0
            || identity.process_generation == 0 || !safe_identifier(&identity.process_kind)
            || !safe_identifier(&identity.profile_id) || identity.profile_revision == 0
            || !is_digest(&identity.profile_digest) || !is_digest(&identity.executable_digest)
            || !matches!(identity.resource_profile.as_str(), "none" | "codemode.v1")
            || identity.resource_profile_digest != resource_profile_digest(&identity.resource_profile)
        { return Err(invalid("cgroup identity pin is invalid")); }
        Ok(identity)
    }
}

fn validate_identity(identity: &CgroupIdentityV1) -> io::Result<File> {
    if !safe_identifier(&identity.execution_id) || !safe_identifier(&identity.effect_id)
        || !is_digest(&identity.capability_lease_digest)
        || !safe_principal(&identity.execution_principal)
        || identity.attempt_scope_digest.as_deref().is_some_and(|digest| !is_digest(digest))
        || identity.owner_epoch == 0
        || identity.process_generation == 0 || !safe_identifier(&identity.process_kind)
        || !safe_identifier(&identity.profile_id) || identity.profile_revision == 0
        || !is_digest(&identity.profile_digest) || !is_digest(&identity.executable_digest)
        || !matches!(identity.resource_profile.as_str(), "none" | "codemode.v1")
        || identity.resource_profile_digest != resource_profile_digest(&identity.resource_profile)
        || identity.delegated_root_owner_uid != unsafe { libc::geteuid() }
        || read_boot_id()? != identity.boot_id
    {
        return Err(invalid("cgroup identity is stale or malformed"));
    }
    let mount = Path::new("/sys/fs/cgroup");
    let mount_fd = open_directory_chain(Path::new("/"), Path::new("sys/fs/cgroup"))?;
    verify_cgroup2_fd(&mount_fd)?;
    let delegated = PathBuf::from(&identity.delegated_root);
    let delegated_relative = delegated.strip_prefix(mount)
        .map_err(|_| invalid("delegated cgroup root escaped the canonical cgroup mount"))?;
    if delegated_relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(invalid("delegated cgroup root is not a normalized child of the mount"));
    }
    let delegated_fd = open_directory_chain_at(&mount_fd, delegated_relative)?;
    let delegated_meta = delegated_fd.metadata()?;
    if delegated_meta.dev() != identity.delegated_root_device
        || delegated_meta.ino() != identity.delegated_root_inode
        || delegated_meta.uid() != identity.delegated_root_owner_uid
    {
        return Err(invalid("delegated cgroup root identity changed"));
    }
    let managed_root_fd = open_child_directory(&delegated_fd, "horizoncode-execution-v1")?;
    verify_owner_directory(&managed_root_fd)?;
    let relative = Path::new(&identity.relative_path);
    let expected_relative = format!("horizoncode-execution-v1/{}", digest_component(&identity.execution_id));
    if relative.components().any(|part| !matches!(part, Component::Normal(_)))
        || identity.relative_path != expected_relative
    { return Err(invalid("cgroup relative identity is not canonical")); }
    let directory = open_directory_chain_at(&delegated_fd, relative)?;
    let metadata = directory.metadata()?;
    if metadata.dev() != identity.cgroup_device || metadata.ino() != identity.cgroup_inode
        || metadata.uid() != identity.cgroup_owner_uid
    {
        return Err(invalid("execution cgroup path/inode identity changed"));
    }
    verify_owner_directory(&directory)?;
    if identity.resource_profile == "codemode.v1" {
        verify_codemode_limits(&directory)?;
    }
    Ok(directory)
}

fn enable_codemode_controllers(managed_root: &File) -> io::Result<()> {
    let mut controllers = String::new();
    open_control_at(managed_root, "cgroup.controllers", libc::O_RDONLY)?
        .take(1024).read_to_string(&mut controllers)?;
    let available: std::collections::BTreeSet<_> = controllers.split_ascii_whitespace().collect();
    if !["cpu", "memory", "pids"].iter().all(|name| available.contains(name)) {
        return Err(invalid("delegated subtree lacks CodeMode cgroup controllers"));
    }
    let mut control = open_control_at(managed_root, "cgroup.subtree_control", libc::O_WRONLY)?;
    control.write_all(b"+cpu +memory +pids\n")?;
    Ok(())
}

fn apply_codemode_limits(directory: &File) -> io::Result<()> {
    write_control_exact(directory, "cpu.max", crate::terminal_process::CodeModeResourceProfileV1::CPU_MAX)?;
    write_control_exact(directory, "memory.max", crate::terminal_process::CodeModeResourceProfileV1::MEMORY_MAX)?;
    write_control_exact(directory, "pids.max", crate::terminal_process::CodeModeResourceProfileV1::PIDS_MAX)?;
    verify_codemode_limits(directory)
}

fn write_control_exact(directory: &File, name: &str, value: &str) -> io::Result<()> {
    let mut control = open_control_at(directory, name, libc::O_WRONLY)?;
    control.write_all(value.as_bytes())?;
    control.write_all(b"\n")?;
    Ok(())
}

fn verify_codemode_limits(directory: &File) -> io::Result<()> {
    for (name, expected) in [
        ("cpu.max", crate::terminal_process::CodeModeResourceProfileV1::CPU_MAX),
        ("memory.max", crate::terminal_process::CodeModeResourceProfileV1::MEMORY_MAX),
        ("pids.max", crate::terminal_process::CodeModeResourceProfileV1::PIDS_MAX),
    ] {
        let mut actual = String::new();
        open_control_at(directory, name, libc::O_RDONLY)?.take(128).read_to_string(&mut actual)?;
        if actual.trim() != expected { return Err(invalid("CodeMode cgroup limit differs from its pinned resource profile")); }
    }
    Ok(())
}

fn read_populated(directory: &File) -> io::Result<u8> {
    let mut events = String::new();
    open_control_at(directory, "cgroup.events", libc::O_RDONLY)?.take(1024).read_to_string(&mut events)?;
    for line in events.lines() {
        if let Some(value) = line.strip_prefix("populated ") {
            return value.parse::<u8>().ok().filter(|value| *value <= 1)
                .ok_or_else(|| invalid("cgroup populated state is malformed"));
        }
    }
    Err(invalid("cgroup populated state is missing"))
}

fn resource_profile_digest(profile: &str) -> String {
    if profile == "codemode.v1" {
        crate::terminal_process::CodeModeResourceProfileV1::digest()
    } else {
        format!("blake3:{}", blake3::hash(b"horizoncode.resource-profile.none.v1\0").to_hex())
    }
}

/// Walk only normal relative components with an O_NOFOLLOW directory handle at
/// each level. Later checks and control-file operations remain anchored to the
/// final open directory, avoiding path re-resolution and symlink races.
fn open_directory_chain(root: &Path, relative: &Path) -> io::Result<File> {
    if !root.is_absolute() || relative.is_absolute() {
        return Err(invalid("cgroup directory chain is not absolute-root/relative-path"));
    }
    let root_path = std::ffi::CString::new("/").expect("fixed root path");
    let root_fd = unsafe { libc::open(root_path.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if root_fd < 0 { return Err(io::Error::last_os_error()); }
    let mut current = unsafe { File::from_raw_fd(root_fd) };
    for component in root.components().chain(relative.components()) {
        if matches!(component, Component::RootDir) { continue; }
        let Component::Normal(name) = component else { return Err(invalid("cgroup identity has a non-normal path component")); };
        let name = std::ffi::CString::new(name.as_encoded_bytes())
            .map_err(|_| invalid("cgroup path component is malformed"))?;
        let next_fd = unsafe { libc::openat(current.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
        if next_fd < 0 { return Err(io::Error::last_os_error()); }
        current = unsafe { File::from_raw_fd(next_fd) };
    }
    Ok(current)
}

/// Open normalized descendants relative to an already authenticated directory
/// handle. This keeps delegated-root validation and the execution-cgroup lookup
/// on the same inode, even if an ancestor pathname is concurrently replaced.
fn open_directory_chain_at(root: &File, relative: &Path) -> io::Result<File> {
    if relative.is_absolute()
        || relative.components().any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(invalid("cgroup descendant path is not normalized"));
    }
    let mut current = root.try_clone()?;
    if relative.as_os_str().is_empty() {
        return Ok(current);
    }
    for component in relative.components() {
        let Component::Normal(name) = component else {
            return Err(invalid("cgroup descendant path is malformed"));
        };
        let name = std::ffi::CString::new(name.as_encoded_bytes())
            .map_err(|_| invalid("cgroup path component is malformed"))?;
        let next_fd = unsafe {
            libc::openat(
                current.as_raw_fd(),
                name.as_ptr(),
                libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
            )
        };
        if next_fd < 0 {
            return Err(io::Error::last_os_error());
        }
        current = unsafe { File::from_raw_fd(next_fd) };
    }
    Ok(current)
}

fn open_control_at(directory: &File, name: &str, access: libc::c_int) -> io::Result<File> {
    let name = std::ffi::CString::new(name).map_err(|_| invalid("cgroup control name is malformed"))?;
    let fd = unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), access | libc::O_CLOEXEC | libc::O_NOFOLLOW) };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    let file = unsafe { File::from_raw_fd(fd) };
    if !file.metadata()?.is_file() { return Err(invalid("cgroup control is not a regular control file")); }
    Ok(file)
}

fn verify_owner_directory(directory: &File) -> io::Result<()> {
    let metadata = directory.metadata()?;
    if !metadata.is_dir() || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.permissions().mode() & 0o022 != 0
    {
        return Err(invalid("managed cgroup namespace is not owner-controlled"));
    }
    Ok(())
}

fn open_child_directory(parent: &File, name: &str) -> io::Result<File> {
    let name = std::ffi::CString::new(name).map_err(|_| invalid("cgroup directory name is malformed"))?;
    let fd = unsafe {
        libc::openat(
            parent.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC | libc::O_NOFOLLOW,
        )
    };
    if fd < 0 { return Err(io::Error::last_os_error()); }
    Ok(unsafe { File::from_raw_fd(fd) })
}

fn count_directory_entries(directory: &File) -> io::Result<usize> {
    let duplicate = unsafe { libc::fcntl(directory.as_raw_fd(), libc::F_DUPFD_CLOEXEC, 0) };
    if duplicate < 0 { return Err(io::Error::last_os_error()); }
    let stream = unsafe { libc::fdopendir(duplicate) };
    if stream.is_null() {
        let error = io::Error::last_os_error();
        unsafe { libc::close(duplicate); }
        return Err(error);
    }
    unsafe { *libc::__errno_location() = 0; }
    let mut count = 0usize;
    loop {
        // `readdir` returns storage owned by this DIR stream; only the name is read
        // before the next call, and dot entries are excluded from the bound.
        let entry = unsafe { libc::readdir(stream) };
        if entry.is_null() { break; }
        let name = unsafe { std::ffi::CStr::from_ptr((*entry).d_name.as_ptr()) };
        if name.to_bytes() != b"." && name.to_bytes() != b".." {
            let bytes = name.to_bytes();
            // A cgroup-v2 directory always exposes its control files
            // (`cgroup.procs`, `cgroup.kill`, `cpu.stat`, ...) alongside the
            // child cgroups. Every control file name carries a dot; execution
            // child names are bare 64-character lowercase hex digests. Only
            // bare names are bounded, and any bare name that is not an exact
            // execution digest is still rejected.
            if bytes.contains(&b'.') {
                continue;
            }
            if bytes.len() != 64 || !bytes.iter().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) {
                unsafe { libc::closedir(stream); }
                return Err(invalid("managed execution cgroup contains an invalid entry"));
            }
            count = count.checked_add(1).ok_or_else(|| invalid("execution cgroup count overflow"))?;
            if count == MAX_RETAINED_EXECUTION_CGROUPS + 1 {
                unsafe { libc::closedir(stream); }
                return Ok(count);
            }
        }
    }
    let read_error = unsafe { *libc::__errno_location() };
    let close_result = unsafe { libc::closedir(stream) };
    if read_error != 0 { return Err(io::Error::from_raw_os_error(read_error)); }
    if close_result != 0 { return Err(io::Error::last_os_error()); }
    Ok(count)
}

fn with_directory_lock<T>(directory: &File, operation: impl FnOnce() -> io::Result<T>) -> io::Result<T> {
    if unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_EX) } != 0 {
        return Err(io::Error::last_os_error());
    }
    let result = operation();
    let unlock_result = unsafe { libc::flock(directory.as_raw_fd(), libc::LOCK_UN) };
    if unlock_result != 0 { return Err(io::Error::last_os_error()); }
    result
}

fn mkdir_at_if_absent(parent: &File, name: &str) -> io::Result<()> {
    let name = std::ffi::CString::new(name).map_err(|_| invalid("cgroup directory name is malformed"))?;
    let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o755) };
    if result == 0 { return Ok(()); }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::AlreadyExists { Ok(()) } else { Err(error) }
}

fn mkdir_at(parent: &File, name: &str) -> io::Result<()> {
    let name = std::ffi::CString::new(name).map_err(|_| invalid("cgroup directory name is malformed"))?;
    let result = unsafe { libc::mkdirat(parent.as_raw_fd(), name.as_ptr(), 0o755) };
    if result == 0 { return Ok(()); }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::AlreadyExists {
        Err(io::Error::new(io::ErrorKind::AlreadyExists, "execution cgroup identity already exists"))
    } else {
        Err(error)
    }
}

fn current_cgroup_path() -> io::Result<PathBuf> {
    let contents = fs::read_to_string("/proc/self/cgroup")?;
    let line = contents.lines().find(|line| line.starts_with("0::"))
        .ok_or_else(|| invalid("unified cgroup-v2 membership is unavailable"))?;
    let relative = Path::new(&line[3..]).strip_prefix("/")
        .map_err(|_| invalid("current cgroup path is not rooted"))?;
    if relative.components().any(|part| !matches!(part, Component::Normal(_))) {
        return Err(invalid("current cgroup membership path is malformed"));
    }
    Ok(relative.to_path_buf())
}

fn verify_cgroup2_fd(directory: &File) -> io::Result<()> {
    let mut stat: libc::statfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::fstatfs(directory.as_raw_fd(), &mut stat) } != 0 { return Err(io::Error::last_os_error()); }
    if stat.f_type as libc::c_long != CGROUP2_SUPER_MAGIC { return Err(invalid("unified cgroup-v2 mount unavailable")); }
    Ok(())
}

fn read_boot_id() -> io::Result<String> {
    let value = fs::read_to_string("/proc/sys/kernel/random/boot_id")?.trim().to_owned();
    if value.len() != 36 || !value.bytes().all(|byte| byte.is_ascii_hexdigit() || byte == b'-') {
        return Err(invalid("boot identity is malformed"));
    }
    Ok(value)
}

fn safe_identifier(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._-".contains(&byte))
}
fn safe_principal(value: &str) -> bool {
    !value.is_empty() && value.len() <= 256 && value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}
fn is_digest(value: &str) -> bool { value.len() == 71 && value.starts_with("blake3:") && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase()) }
fn digest_component(value: &str) -> String { blake3::hash(value.as_bytes()).to_hex().to_string() }
fn invalid(reason: &'static str) -> io::Error { io::Error::new(io::ErrorKind::PermissionDenied, reason) }

#[cfg(test)]
mod tests {
    use super::*;

    fn identity() -> CgroupIdentityV1 {
        CgroupIdentityV1 {
            boot_id: "01234567-89ab-cdef-0123-456789abcdef".to_owned(),
            delegated_root: "/sys/fs/cgroup/user.slice".to_owned(),
            delegated_root_device: 1,
            delegated_root_inode: 2,
            delegated_root_owner_uid: 1000,
            relative_path: format!("horizoncode-execution-v1/{}", digest_component("execution_test")),
            cgroup_device: 3,
            cgroup_inode: 4,
            cgroup_owner_uid: 1000,
            cgroup_hierarchy_hidden: true,
            execution_id: "execution_test".to_owned(),
            effect_id: "effect_test".to_owned(),
            capability_lease_digest: format!("blake3:{}", "a".repeat(64)),
            execution_principal: "server_auth:verifier".to_owned(),
            attempt_scope_digest: Some(format!("blake3:{}", "d".repeat(64))),
            owner_epoch: 5,
            process_generation: 6,
            process_kind: "language_server".to_owned(),
            profile_id: "trusted_lsp".to_owned(),
            profile_revision: 7,
            profile_digest: format!("blake3:{}", "b".repeat(64)),
            executable_digest: format!("blake3:{}", "c".repeat(64)),
            resource_profile: "none".to_owned(),
            resource_profile_digest: resource_profile_digest("none"),
        }
    }

    #[test]
    fn identity_wire_round_trip_binds_process_generation_and_profile() {
        let original = identity();
        let decoded = CgroupIdentityV1::from_value(&original.to_value()).unwrap();
        assert_eq!(decoded, original);
        assert_eq!(decoded.process_generation, 6);
        assert_eq!(decoded.process_kind, "language_server");
        assert_eq!(decoded.profile_id, "trusted_lsp");
        assert_eq!(decoded.executable_digest, original.executable_digest);
    }

    #[test]
    fn identity_wire_rejects_missing_host_process_pins() {
        let mut value = identity().to_value();
        if let crate::protocol::Value::Map(fields) = &mut value {
            fields.remove("processGeneration");
        }
        assert!(CgroupIdentityV1::from_value(&value).is_err());
    }

    #[test]
    fn janitor_requires_hidden_hierarchy_and_exact_persisted_quiescence() {
        let mut unhidden = identity();
        unhidden.cgroup_hierarchy_hidden = false;
        let exact_proof = quiescence_digest(&unhidden);
        assert!(ExecutionCgroupV2::remove_quiescent_if_empty(&unhidden, &exact_proof).is_err());

        let hidden = identity();
        assert!(ExecutionCgroupV2::remove_quiescent_if_empty(&hidden, "blake3:stale").is_err());
    }

    #[test]
    fn legacy_cgroup_identity_cannot_claim_hidden_hierarchy() {
        let mut value = identity().to_value();
        if let crate::protocol::Value::Map(fields) = &mut value {
            fields.remove("delegatedRootOwnerUID");
            fields.remove("cgroupOwnerUID");
            fields.remove("cgroupHierarchyHidden");
        }

        let decoded = CgroupIdentityV1::from_value(&value).unwrap();
        assert!(!decoded.cgroup_hierarchy_hidden);
    }
}
