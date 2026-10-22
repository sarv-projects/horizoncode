//! Private P2 boundary for one Guarded, confined managed verification process.
//!
//! Only `HostKernel` constructs `VerifierInvocationV1`, from its retained challenge,
//! authenticated reviewer, immutable verifier profile, and freshly measured workspace.
//! The type deliberately has no RPC decoder or public constructor.

use std::collections::BTreeMap;
use std::ffi::OsString;
use std::path::PathBuf;
use std::time::Duration;

use crate::protocol::{ErrorCategoryV1, RetryClassV1, TypedErrorV1};
use crate::terminal_process::{
    StdioExecutionBindingV1, StdioExecutionReceiptV1, StdioExecutionStateV1,
    StdioExecutionStatusV1, StdioLaunchSpec, StdioObservedOutputV1,
};

/// HostKernel-only constructor input. Every field is populated from host-owned state;
/// none is accepted from an RPC request. The approved-arguments digest is derived from
/// the canonical core digest before the Guard challenge is created.
pub(super) struct VerifierInvocationSourceV1 {
    pub(super) goal_id: String,
    pub(super) run_id: String,
    pub(super) spec_id: String,
    pub(super) spec_digest: String,
    pub(super) verification_run_id: String,
    pub(super) criterion_id: String,
    pub(super) challenge_set_digest: String,
    /// Canonical host bundle persisted by EffectHost as `content_digest`.
    pub(super) canonical_arguments_digest: String,
    pub(super) reviewer_principal: String,
    /// Trusted identity of the registered verifier process. Unlike the reviewer,
    /// this principal is resolved from the verifier profile and owns execution.
    pub(super) execution_principal: String,
    pub(super) profile_id: String,
    pub(super) profile_revision: u64,
    pub(super) profile_digest: String,
    pub(super) executable_digest: String,
    pub(super) sandbox_policy_digest: String,
    pub(super) test_identity: String,
    pub(super) cancel_generation: u64,
    pub(super) binding: StdioExecutionBindingV1,
    pub(super) launch_spec: StdioLaunchSpec,
}

/// Opaque, non-serializable managed verifier request accepted by the P1 EffectHost
/// wrapper. Fields are immutable and only HostKernel's parent module can mint one.
pub(crate) struct VerifierInvocationV1 {
    goal_id: String,
    run_id: String,
    spec_id: String,
    spec_digest: String,
    verification_run_id: String,
    criterion_id: String,
    challenge_set_digest: String,
    canonical_arguments_digest: String,
    reviewer_principal: String,
    execution_principal: String,
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    executable_digest: String,
    sandbox_policy_digest: String,
    test_identity: String,
    cancel_generation: u64,
    binding: StdioExecutionBindingV1,
    launch_spec: StdioLaunchSpec,
    invocation_core_digest: String,
    invocation_digest: String,
}

impl VerifierInvocationV1 {
    /// This is `pub(super)` by design: the `host_kernel` module can create a request
    /// after validating retained state, but other crate modules cannot mint authority.
    pub(super) fn new(source: VerifierInvocationSourceV1) -> Result<Self, TypedErrorV1> {
        let core_digest = invocation_core_digest(&source)?;
        let expected_canonical = approved_arguments_digest(
            &core_digest,
            &source.verification_run_id,
            &source.criterion_id,
        );
        if source.challenge_set_digest.is_empty()
            || source.canonical_arguments_digest != expected_canonical
            || !is_blake3_digest(&source.binding.approved_arguments_digest)
            || source.binding.effect_id.is_empty()
            || source.binding.challenge_id.is_empty()
            || source.binding.execution_id.is_empty()
            || source.binding.principal != source.reviewer_principal
            || source.execution_principal.is_empty()
            || source.binding.execution_principal != source.execution_principal
            || source.binding.location_id.is_empty()
            || source.binding.capability_id != crate::guard::BUILTIN_VERIFIER_ID
            || source.binding.workspace_revision != source.launch_spec.workspace_revision
            || source.binding.workspace_revision.is_empty()
            || source.binding.profile_ref != source.profile_id
            || source.profile_revision == 0
            || source.binding.profile_id != source.profile_id
            || source.binding.profile_revision != source.profile_revision
            || source.binding.profile_digest != source.profile_digest
            || source.binding.executable_digest != source.executable_digest
            || source.launch_spec.executable_digest != source.executable_digest
            || !is_blake3_digest(&source.profile_digest)
            || !is_blake3_digest(&source.executable_digest)
            || source.binding.owner_epoch == 0
            || source.binding.generation == 0
            || source.binding.session_id.is_empty()
            || source
                .binding
                .attempt_scope_digest
                .as_deref()
                .is_none_or(|digest| !is_blake3_digest(digest))
            || source.launch_spec.profile_digest != source.profile_digest
            || source.launch_spec.executable_digest.is_empty()
            || source.launch_spec.max_output_bytes == 0
            || source.launch_spec.timeout.is_zero()
            || source.launch_spec.cwd != source.launch_spec.workspace_root
        {
            return Err(invalid());
        }
        let invocation_digest = final_invocation_digest(
            &core_digest,
            &source.binding,
            &source.challenge_set_digest,
            &source.canonical_arguments_digest,
            source.cancel_generation,
        );
        let mut launch_spec = source.launch_spec;
        launch_spec.retain_output_for_host();
        Ok(Self {
            goal_id: source.goal_id,
            run_id: source.run_id,
            spec_id: source.spec_id,
            spec_digest: source.spec_digest,
            verification_run_id: source.verification_run_id,
            criterion_id: source.criterion_id,
            challenge_set_digest: source.challenge_set_digest,
            canonical_arguments_digest: source.canonical_arguments_digest,
            reviewer_principal: source.reviewer_principal,
            execution_principal: source.execution_principal,
            profile_id: source.profile_id,
            profile_revision: source.profile_revision,
            profile_digest: source.profile_digest,
            executable_digest: source.executable_digest,
            sandbox_policy_digest: source.sandbox_policy_digest,
            test_identity: source.test_identity,
            cancel_generation: source.cancel_generation,
            binding: source.binding,
            launch_spec,
            invocation_core_digest: core_digest,
            invocation_digest,
        })
    }

    /// Digest to approve in the Guard challenge before a one-use lease exists.
    pub(super) fn approved_arguments_digest_for(
        source: &VerifierInvocationSourceV1,
    ) -> Result<String, TypedErrorV1> {
        let core_digest = invocation_core_digest(source)?;
        Ok(approved_arguments_digest(
            &core_digest,
            &source.verification_run_id,
            &source.criterion_id,
        ))
    }

    /// EffectHost tests cannot call the HostKernel-only production constructor. This
    /// narrowly scoped test helper builds a token from explicitly supplied fixture facts;
    /// it is not present in production builds and cannot enable any effect by itself.
    #[cfg(test)]
    pub(crate) fn test_fixture_from_host_fields(
        goal_id: String,
        run_id: String,
        spec_id: String,
        spec_digest: String,
        verification_run_id: String,
        criterion_id: String,
        challenge_set_digest: String,
        reviewer_principal: String,
        profile_id: String,
        profile_digest: String,
        sandbox_policy_digest: String,
        test_identity: String,
        cancel_generation: u64,
        binding: StdioExecutionBindingV1,
        launch_spec: StdioLaunchSpec,
    ) -> Result<Self, TypedErrorV1> {
        let mut source = VerifierInvocationSourceV1 {
            goal_id,
            run_id,
            spec_id,
            spec_digest,
            verification_run_id,
            criterion_id,
            challenge_set_digest,
            canonical_arguments_digest: String::new(),
            reviewer_principal,
            execution_principal: binding.execution_principal.clone(),
            profile_id,
            profile_digest,
            sandbox_policy_digest,
            test_identity,
            cancel_generation,
            binding,
            launch_spec,
        };
        source.canonical_arguments_digest = Self::approved_arguments_digest_for(&source)?;
        Self::new(source)
    }

    pub(crate) fn validate_digest(&self) -> bool {
        self.canonical_arguments_digest
            == approved_arguments_digest(
                &self.invocation_core_digest,
                &self.verification_run_id,
                &self.criterion_id,
            )
            && self.invocation_digest
                == final_invocation_digest(
                    &self.invocation_core_digest,
                    &self.binding,
                    &self.challenge_set_digest,
                    &self.canonical_arguments_digest,
                    self.cancel_generation,
                )
    }

    pub(crate) fn stdio_binding(&self) -> &StdioExecutionBindingV1 {
        &self.binding
    }

    /// Exact host-resolved launch data captured from the immutable registered profile.
    /// The wrapper must not accept or replace this with caller-supplied process fields.
    pub(crate) fn stdio_launch_spec(&self) -> &StdioLaunchSpec {
        &self.launch_spec
    }

    pub(crate) fn goal_id(&self) -> &str {
        &self.goal_id
    }
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }
    pub(crate) fn spec_id(&self) -> &str {
        &self.spec_id
    }
    pub(crate) fn spec_digest(&self) -> &str {
        &self.spec_digest
    }
    pub(crate) fn verification_run_id(&self) -> &str {
        &self.verification_run_id
    }
    pub(crate) fn criterion_id(&self) -> &str {
        &self.criterion_id
    }
    pub(crate) fn challenge_set_digest(&self) -> &str {
        &self.challenge_set_digest
    }
    pub(crate) fn canonical_arguments_digest(&self) -> &str {
        &self.canonical_arguments_digest
    }
    pub(crate) fn reviewer_principal(&self) -> &str {
        &self.reviewer_principal
    }

    pub(crate) fn execution_principal(&self) -> &str {
        &self.execution_principal
    }
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.binding.owner_epoch
    }
    pub(crate) fn location_id(&self) -> &str {
        &self.binding.location_id
    }
    pub(crate) fn workspace_root(&self) -> &std::path::Path {
        &self.launch_spec.workspace_root
    }
    pub(crate) fn final_revision(&self) -> &str {
        &self.binding.workspace_revision
    }
    pub(crate) fn profile_id(&self) -> &str {
        &self.profile_id
    }
    pub(crate) fn profile_revision(&self) -> u64 {
        self.profile_revision
    }
    pub(crate) fn profile_digest(&self) -> &str {
        &self.profile_digest
    }
    pub(crate) fn sandbox_policy_digest(&self) -> &str {
        &self.sandbox_policy_digest
    }
    pub(crate) fn executable_path(&self) -> &std::path::Path {
        &self.launch_spec.executable
    }
    pub(crate) fn executable_digest(&self) -> &str {
        &self.executable_digest
    }
    pub(crate) fn argv(&self) -> &[OsString] {
        &self.launch_spec.argv
    }
    pub(crate) fn environment(&self) -> &BTreeMap<OsString, OsString> {
        &self.launch_spec.env
    }
    pub(crate) fn test_identity(&self) -> &str {
        &self.test_identity
    }
    pub(crate) fn timeout(&self) -> Duration {
        self.launch_spec.timeout
    }
    pub(crate) fn max_output_bytes(&self) -> usize {
        self.launch_spec.max_output_bytes
    }
    pub(crate) fn cancel_generation(&self) -> u64 {
        self.cancel_generation
    }
    pub(crate) fn effect_id(&self) -> &str {
        &self.binding.effect_id
    }
    pub(crate) fn challenge_id(&self) -> &str {
        &self.binding.challenge_id
    }
    pub(crate) fn lease_digest(&self) -> &str {
        &self.binding.capability_lease_digest
    }
    pub(crate) fn approved_arguments_digest(&self) -> &str {
        &self.binding.approved_arguments_digest
    }
    pub(crate) fn execution_id(&self) -> &str {
        &self.binding.execution_id
    }
    pub(crate) fn execution_generation(&self) -> u64 {
        self.binding.generation
    }
    pub(crate) fn invocation_core_digest(&self) -> &str {
        &self.invocation_core_digest
    }
    pub(crate) fn invocation_digest(&self) -> &str {
        &self.invocation_digest
    }
}

/// Result of the typed P1 launch/reconciliation wrapper. Only observed output can be
/// captured into verifier evidence; UNKNOWN never carries fabricated or replayed bytes.
pub(crate) enum ManagedVerifierObservedOutcomeV1 {
    Observed {
        invocation_digest: String,
        status: StdioExecutionStatusV1,
        output: StdioObservedOutputV1,
        receipt: StdioExecutionReceiptV1,
    },
    Unknown {
        invocation_digest: String,
        execution_id: String,
        generation: u64,
        reason: ManagedVerifierUnknownReasonV1,
    },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ManagedVerifierUnknownReasonV1 {
    DispatchAmbiguous,
    ProcessLost,
    ReceiptUnavailable,
    CancelledAfterDispatch,
}

impl ManagedVerifierObservedOutcomeV1 {
    /// Transfer the uniquely observed process facts to HostKernel for artifact capture.
    /// UNKNOWN carries no output/status/receipt and therefore cannot become evidence.
    pub(crate) fn into_observed(
        self,
    ) -> Option<(
        StdioExecutionStatusV1,
        StdioObservedOutputV1,
        StdioExecutionReceiptV1,
    )> {
        match self {
            Self::Observed {
                status,
                output,
                receipt,
                ..
            } => Some((status, output, receipt)),
            Self::Unknown { .. } => None,
        }
    }

    /// UNKNOWN without a fabricated process status or output. This is used after
    /// restart when a durable receipt is settled but the one-use captured bytes
    /// are no longer available to the current supervisor instance.
    pub(crate) fn unknown(
        invocation: &VerifierInvocationV1,
        reason: ManagedVerifierUnknownReasonV1,
    ) -> Result<Self, TypedErrorV1> {
        if !invocation.validate_digest() {
            return Err(invalid());
        }
        Ok(Self::Unknown {
            invocation_digest: invocation.invocation_digest.clone(),
            execution_id: invocation.execution_id().to_owned(),
            generation: invocation.execution_generation(),
            reason,
        })
    }

    pub(crate) fn from_status(
        invocation: &VerifierInvocationV1,
        status: StdioExecutionStatusV1,
        output: Option<StdioObservedOutputV1>,
        receipt: Option<StdioExecutionReceiptV1>,
        unknown_reason: Option<ManagedVerifierUnknownReasonV1>,
    ) -> Result<Self, TypedErrorV1> {
        if !invocation.validate_digest()
            || status.execution_id != invocation.execution_id()
            || status.generation != invocation.execution_generation()
        {
            return Err(invalid());
        }
        if status.state == StdioExecutionStateV1::Exited {
            let (Some(output), Some(receipt)) = (output, receipt) else {
                return Err(invalid());
            };
            if receipt.execution_id != status.execution_id
                || receipt.effect_id != invocation.effect_id()
                || receipt.generation != status.generation
                || receipt.profile_id != invocation.profile_id()
                || receipt.profile_revision != invocation.profile_revision()
                || receipt.profile_digest != invocation.profile_digest()
                || receipt.executable_digest != invocation.executable_digest()
                || receipt.execution_principal != invocation.execution_principal()
                || receipt.receipt_digest.is_empty()
                || receipt.stdout_digest != status.stdout_digest
                || receipt.stderr_digest != status.stderr_digest
                || receipt.output_bytes != status.output_bytes
                || receipt.exit_code != status.exit_code
                || output.stdout.len().saturating_add(output.stderr.len()) as u64
                    != status.output_bytes
                || status.output_bytes > invocation.max_output_bytes() as u64
                || blake3::hash(&output.stdout).to_hex().as_str()
                    != status.stdout_digest.strip_prefix("blake3:").unwrap_or("")
                || blake3::hash(&output.stderr).to_hex().as_str()
                    != status.stderr_digest.strip_prefix("blake3:").unwrap_or("")
            {
                return Err(invalid());
            }
            return Ok(Self::Observed {
                invocation_digest: invocation.invocation_digest.clone(),
                status,
                output,
                receipt,
            });
        }
        if status.state != StdioExecutionStateV1::Unknown || output.is_some() || receipt.is_some() {
            return Err(invalid());
        }
        Ok(Self::Unknown {
            invocation_digest: invocation.invocation_digest.clone(),
            execution_id: status.execution_id,
            generation: status.generation,
            reason: unknown_reason.ok_or_else(invalid)?,
        })
    }
}

fn invocation_core_digest(source: &VerifierInvocationSourceV1) -> Result<String, TypedErrorV1> {
    let binding = &source.binding;
    let launch = &source.launch_spec;
    if source.goal_id.is_empty()
        || source.run_id.is_empty()
        || source.spec_id.is_empty()
        || source.spec_digest.is_empty()
        || source.verification_run_id.is_empty()
        || source.criterion_id.is_empty()
        || source.reviewer_principal.is_empty()
        || source.execution_principal.is_empty()
        || source.profile_id.is_empty()
        || source.profile_digest.is_empty()
        || source.sandbox_policy_digest.is_empty()
        || source.test_identity.is_empty()
        || launch.argv.len() > crate::terminal_process::MAX_STDIO_ARGUMENTS
        || launch.env.len() > crate::terminal_process::MAX_STDIO_ENV_ITEMS
        || launch.max_output_bytes > crate::terminal_process::MAX_STDIO_OUTPUT_BYTES
        || launch.timeout > crate::terminal_process::MAX_STDIO_TIMEOUT
        || launch.workspace_revision != binding.workspace_revision
        || launch
            .writable_roots
            .iter()
            .any(|path| !path.starts_with(&launch.workspace_root))
    {
        return Err(invalid());
    }
    let mut hash = blake3::Hasher::new();
    hash.update(b"horizoncode.managed-verifier-invocation-core.v1\0");
    for value in [
        &source.goal_id,
        &source.run_id,
        &source.spec_id,
        &source.spec_digest,
        &source.verification_run_id,
        &source.criterion_id,
        &source.reviewer_principal,
        &source.execution_principal,
        &source.profile_id,
        &source.profile_revision.to_string(),
        &source.profile_digest,
        &source.executable_digest,
        &source.sandbox_policy_digest,
        &source.test_identity,
        &binding.principal,
        &binding.execution_principal,
        &binding.location_id,
        &binding.workspace_revision,
        &binding.profile_ref,
        &launch.workspace_revision,
    ] {
        hash_bytes(&mut hash, value.as_bytes());
    }
    hash.update(&binding.owner_epoch.to_be_bytes());
    hash.update(&source.cancel_generation.to_be_bytes());
    hash_bytes(&mut hash, &os_bytes(&launch.executable));
    hash_bytes(&mut hash, launch.executable_digest.as_bytes());
    hash_bytes(&mut hash, &os_bytes(&launch.cwd));
    hash_bytes(&mut hash, &os_bytes(&launch.workspace_root));
    hash.update(&(launch.timeout.as_millis() as u64).to_be_bytes());
    hash.update(&(launch.max_output_bytes as u64).to_be_bytes());
    for argument in &launch.argv {
        hash_bytes(&mut hash, &os_bytes(argument));
    }
    for (key, value) in &launch.env {
        hash_bytes(&mut hash, &os_bytes(key));
        hash_bytes(&mut hash, &os_bytes(value));
    }
    for root in &launch.writable_roots {
        hash_bytes(&mut hash, &os_bytes(root));
    }
    Ok(format!("blake3:{}", hash.finalize().to_hex()))
}

fn approved_arguments_digest(
    core_digest: &str,
    verification_run_id: &str,
    criterion_id: &str,
) -> String {
    let mut hash = blake3::Hasher::new();
    hash.update(b"horizoncode.managed-verifier-approved-arguments.v1\0");
    for value in [core_digest, verification_run_id, criterion_id] {
        hash_bytes(&mut hash, value.as_bytes());
    }
    format!("blake3:{}", hash.finalize().to_hex())
}

fn final_invocation_digest(
    core_digest: &str,
    binding: &StdioExecutionBindingV1,
    challenge_set_digest: &str,
    canonical_arguments_digest: &str,
    cancel_generation: u64,
) -> String {
    let mut hash = blake3::Hasher::new();
    hash.update(b"horizoncode.managed-verifier-invocation.v1\0");
    for value in [
        core_digest,
        &binding.execution_id,
        &binding.effect_id,
        &binding.challenge_id,
        &binding.capability_id,
        &binding.capability_lease_digest,
        &binding.approved_arguments_digest,
        challenge_set_digest,
        canonical_arguments_digest,
    ] {
        hash_bytes(&mut hash, value.as_bytes());
    }
    hash.update(&binding.owner_epoch.to_be_bytes());
    hash.update(&binding.generation.to_be_bytes());
    hash.update(&cancel_generation.to_be_bytes());
    format!("blake3:{}", hash.finalize().to_hex())
}

fn hash_bytes(hash: &mut blake3::Hasher, bytes: &[u8]) {
    hash.update(&(bytes.len() as u64).to_be_bytes());
    hash.update(bytes);
}

fn is_blake3_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("blake3:")
        && value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[cfg(unix)]
fn os_bytes(value: &impl AsRef<std::ffi::OsStr>) -> Vec<u8> {
    use std::os::unix::ffi::OsStrExt;
    value.as_ref().as_bytes().to_vec()
}

#[cfg(windows)]
fn os_bytes(value: &impl AsRef<std::ffi::OsStr>) -> Vec<u8> {
    use std::os::windows::ffi::OsStrExt;
    value
        .as_ref()
        .encode_wide()
        .flat_map(u16::to_le_bytes)
        .collect()
}

#[cfg(not(any(unix, windows)))]
fn os_bytes(value: &impl AsRef<std::ffi::OsStr>) -> Vec<u8> {
    value.as_ref().to_string_lossy().as_bytes().to_vec()
}

fn invalid() -> TypedErrorV1 {
    TypedErrorV1 {
        code: "invalid_managed_verifier_invocation".to_owned(),
        category: ErrorCategoryV1::Authorization,
        message: "managed verifier invocation is malformed or no longer matches its authority"
            .to_owned(),
        retry_class: RetryClassV1::Never,
        retry_after_ms: None,
        owner_cursor: None,
        subject_ids: Vec::new(),
        details: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture() -> VerifierInvocationSourceV1 {
        let workspace = PathBuf::from("/trusted/workspace");
        let mut launch_spec = StdioLaunchSpec::new(
            "/trusted/verifier",
            format!("blake3:{}", "a".repeat(64)),
            ["--criterion", "tests"],
            &workspace,
        );
        launch_spec.workspace_root = workspace.clone();
        launch_spec.workspace_revision = format!("blake3:{}", "b".repeat(64));
        launch_spec.profile_digest = format!("blake3:{}", "c".repeat(64));
        launch_spec.timeout = Duration::from_secs(30);
        launch_spec.max_output_bytes = 4096;
        let mut source = VerifierInvocationSourceV1 {
            goal_id: "goal-1".into(),
            run_id: "run-1".into(),
            spec_id: "spec-1".into(),
            spec_digest: format!("blake3:{}", "d".repeat(64)),
            verification_run_id: "verify-1".into(),
            criterion_id: "criterion-1".into(),
            challenge_set_digest: format!("blake3:{}", "e".repeat(64)),
            canonical_arguments_digest: String::new(),
            reviewer_principal: "reviewer-1".into(),
            execution_principal: "server_auth:verifier-1".into(),
            profile_id: "profile-1".into(),
            profile_revision: 1,
            profile_digest: launch_spec.profile_digest.clone(),
            executable_digest: launch_spec.executable_digest.clone(),
            sandbox_policy_digest: format!("blake3:{}", "f".repeat(64)),
            test_identity: "tests".into(),
            cancel_generation: 4,
            binding: StdioExecutionBindingV1 {
                execution_id: "execution-1".into(),
                effect_id: "effect-1".into(),
                challenge_id: "challenge-1".into(),
                principal: "reviewer-1".into(),
                execution_principal: "server_auth:verifier-1".into(),
                scope: crate::terminal_process::StdioExecutionScopeV1::Session { session_id: "session_verifier_fixture".to_owned() },
                session_id: "session_verifier_fixture".to_owned(),
                location_id: "location-1".into(),
                capability_id: crate::guard::BUILTIN_VERIFIER_ID.into(),
                capability_lease_digest: format!("blake3:{}", "1".repeat(64)),
                approved_arguments_digest: String::new(),
                attempt_scope_digest: None,
                owner_epoch: 7,
                generation: 1,
                workspace_revision: launch_spec.workspace_revision.clone(),
                profile_ref: "profile-1".into(),
                profile_id: "profile-1".into(),
                profile_revision: 1,
                profile_digest: launch_spec.profile_digest.clone(),
                executable_digest: launch_spec.executable_digest.clone(),
            },
            launch_spec,
        };
        source.canonical_arguments_digest =
            VerifierInvocationV1::approved_arguments_digest_for(&source).unwrap();
        source.binding.approved_arguments_digest = format!("blake3:{}", "9".repeat(64));
        source
    }

    #[test]
    fn approved_digest_and_invocation_bind_the_canonical_process_and_managed_authority() {
        let source = fixture();
        let invocation = VerifierInvocationV1::new(source).unwrap();
        assert!(invocation.validate_digest());
        assert_eq!(invocation.max_output_bytes(), 4096);
        assert_eq!(
            invocation.stdio_binding().workspace_revision,
            invocation.final_revision()
        );
    }

    #[test]
    fn approved_digest_changes_when_any_process_or_attempt_authority_changes() {
        let source = fixture();
        let original = VerifierInvocationV1::approved_arguments_digest_for(&source).unwrap();
        let mut changed = fixture();
        changed.goal_id.push_str("-other");
        assert_ne!(
            VerifierInvocationV1::approved_arguments_digest_for(&changed).unwrap(),
            original
        );
        let mut changed = fixture();
        changed.launch_spec.argv.push(OsString::from("extra"));
        assert_ne!(
            VerifierInvocationV1::approved_arguments_digest_for(&changed).unwrap(),
            original
        );
        let mut changed = fixture();
        changed.launch_spec.workspace_revision.push('x');
        changed.binding.workspace_revision = changed.launch_spec.workspace_revision.clone();
        assert_ne!(
            VerifierInvocationV1::approved_arguments_digest_for(&changed).unwrap(),
            original
        );
        let mut changed = fixture();
        changed.cancel_generation += 1;
        assert_ne!(
            VerifierInvocationV1::approved_arguments_digest_for(&changed).unwrap(),
            original
        );
    }

    #[test]
    fn final_invocation_digest_binds_one_use_challenge_lease_execution_and_generation() {
        let invocation = VerifierInvocationV1::new(fixture()).unwrap();
        let mutations: [fn(&mut VerifierInvocationSourceV1); 4] = [
            |source: &mut VerifierInvocationSourceV1| {
                source.challenge_set_digest.push('x');
            },
            |source: &mut VerifierInvocationSourceV1| {
                source.binding.capability_lease_digest.push('x');
            },
            |source: &mut VerifierInvocationSourceV1| {
                source.binding.execution_id.push('x');
            },
            |source: &mut VerifierInvocationSourceV1| {
                source.binding.generation += 1;
            },
        ];
        for mutate in mutations {
            let mut changed = fixture();
            mutate(&mut changed);
            let changed = VerifierInvocationV1::new(changed).unwrap();
            assert_ne!(changed.invocation_digest(), invocation.invocation_digest());
        }
    }

    #[test]
    fn result_factory_requires_real_bounded_output_and_settled_receipt() {
        let invocation = VerifierInvocationV1::new(fixture()).unwrap();
        let stdout = b"verified".to_vec();
        let stderr = Vec::new();
        let stdout_digest = format!("blake3:{}", blake3::hash(&stdout).to_hex());
        let stderr_digest = format!("blake3:{}", blake3::hash(&stderr).to_hex());
        let status = StdioExecutionStatusV1 {
            execution_id: invocation.execution_id().to_owned(),
            generation: invocation.execution_generation(),
            state: StdioExecutionStateV1::Exited,
            stdout_sequence: 1,
            stderr_sequence: 0,
            exit_code: Some(0),
            stdout_digest: stdout_digest.clone(),
            stderr_digest: stderr_digest.clone(),
            output_bytes: stdout.len() as u64,
            truncated: false,
            duration_ms: 5,
            receipt_digest: Some(format!("blake3:{}", "2".repeat(64))),
        };
        let output = StdioObservedOutputV1 {
            stdout: stdout.clone(),
            stderr: stderr.clone(),
        };
        let receipt = StdioExecutionReceiptV1 {
            execution_id: status.execution_id.clone(),
            effect_id: invocation.effect_id().to_owned(),
            generation: status.generation,
            profile_id: invocation.profile_id().to_owned(),
            profile_revision: invocation.profile_revision(),
            profile_digest: invocation.profile_digest().to_owned(),
            executable_digest: invocation.executable_digest().to_owned(),
            execution_principal: invocation.execution_principal().to_owned(),
            exit_code: status.exit_code,
            stdout_sequence: status.stdout_sequence,
            stderr_sequence: status.stderr_sequence,
            stdout_digest: stdout_digest.clone(),
            stderr_digest: stderr_digest.clone(),
            output_bytes: status.output_bytes,
            truncated: false,
            receipt_digest: status.receipt_digest.clone().unwrap(),
        };
        assert!(matches!(
            ManagedVerifierObservedOutcomeV1::from_status(
                &invocation,
                status.clone(),
                Some(output),
                Some(receipt.clone()),
                None,
            ),
            Ok(ManagedVerifierObservedOutcomeV1::Observed { .. })
        ));

        let tampered = StdioObservedOutputV1 {
            stdout: b"forged".to_vec(),
            stderr,
        };
        assert!(
            ManagedVerifierObservedOutcomeV1::from_status(
                &invocation,
                status,
                Some(tampered),
                Some(receipt),
                None,
            )
            .is_err()
        );
    }
}
