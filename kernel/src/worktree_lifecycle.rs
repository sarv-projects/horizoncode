//! Durable intent/receipt contract for guarded worker worktree operations.
//!
//! This module does not start Git or touch the filesystem. The only executor is a
//! P1 HostKernel port, which must resolve the registered workspace root, run the
//! operation through Guard/ExecutionHost and OS confinement, and return facts
//! collected from that same root. Pending operations become UNKNOWN on restart;
//! release is denied unless the HostKernel receipt proves a clean, user-owned
//! change-free tree at the expected workspace revision.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};

use crate::resource_sampler::ProcessIdentity;
use crate::worker_durable::RootCoordinatorExecutionProofV1;

pub const MAX_WORKTREE_OPERATIONS: usize = 256;
pub const MAX_WORKTREE_PATH_BYTES: usize = 1024;
pub const MAX_WORKTREE_RECEIPT_REF_BYTES: usize = 256;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeOperationKindV1 {
    Create,
    Inspect,
    Release,
}

/// Run-root identity for worktree lifecycle operations, which necessarily
/// happen before a child Task/Attempt exists. The value is derived from P8's
/// opaque authenticated root-coordinator proof and grants lineage only; P1
/// still evaluates Guard and performs each filesystem operation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeRootOwnerV1 {
    coordinator_id: String,
    goal_id: String,
    run_id: String,
    principal_ref: String,
    workspace_binding: String,
    session_id: String,
    location_id: String,
    owner_epoch: u64,
    process_incarnation: String,
    process_identity: ProcessIdentity,
    accepted_spec_digest: String,
    root_digest: String,
}

impl WorktreeRootOwnerV1 {
    pub(crate) fn from_live_root_proof(
        proof: &RootCoordinatorExecutionProofV1,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        let mut owner = Self {
            coordinator_id: proof.worker_execution_id().to_owned(),
            goal_id: proof.goal_id().to_owned(),
            run_id: proof.run_id().to_owned(),
            principal_ref: proof.principal_ref().to_owned(),
            workspace_binding: proof.workspace_binding().to_owned(),
            session_id: proof.session_id().to_owned(),
            location_id: proof.location_id().to_owned(),
            owner_epoch: proof.owner_epoch(),
            process_incarnation: proof.process_incarnation().to_owned(),
            process_identity: proof.process_identity().clone(),
            accepted_spec_digest: proof.accepted_spec_digest().to_owned(),
            root_digest: String::new(),
        };
        owner.validate()?;
        owner.root_digest = owner.compute_digest();
        Ok(owner)
    }

    pub(crate) fn from_owner_log(
        coordinator_id: String,
        goal_id: String,
        run_id: String,
        principal_ref: String,
        workspace_binding: String,
        session_id: String,
        location_id: String,
        owner_epoch: u64,
        process_incarnation: String,
        process_identity: ProcessIdentity,
        accepted_spec_digest: String,
        root_digest: String,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        let owner = Self { coordinator_id, goal_id, run_id, principal_ref, workspace_binding,
            session_id, location_id, owner_epoch, process_incarnation, process_identity,
            accepted_spec_digest, root_digest };
        owner.validate()?;
        if owner.root_digest != owner.compute_digest() {
            return Err(WorktreeLifecycleErrorV1::InvalidRootOwner);
        }
        Ok(owner)
    }

    fn validate(&self) -> Result<(), WorktreeLifecycleErrorV1> {
        for value in [&self.coordinator_id, &self.goal_id, &self.run_id,
            &self.workspace_binding, &self.session_id, &self.location_id,
            &self.process_incarnation] {
            if !valid_token(value, 256) { return Err(WorktreeLifecycleErrorV1::InvalidRootOwner); }
        }
        if !self.coordinator_id.starts_with("root-")
            || !self.principal_ref.starts_with("server_auth:")
            || self.principal_ref.len() > 256
            || self.principal_ref.chars().any(char::is_control)
            || self.owner_epoch == 0
            || self.process_identity.pid == 0
            || self.process_identity.start_identity == 0
            || !is_digest(&self.accepted_spec_digest)
        {
            return Err(WorktreeLifecycleErrorV1::InvalidRootOwner);
        }
        Ok(())
    }

    fn compute_digest(&self) -> String {
        let mut bytes = b"horizoncode.worktree-root-owner.v1\0".to_vec();
        for value in [&self.coordinator_id, &self.goal_id, &self.run_id, &self.principal_ref,
            &self.workspace_binding, &self.session_id, &self.location_id,
            &self.process_incarnation, &self.accepted_spec_digest] {
            bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
            bytes.extend_from_slice(value.as_bytes());
        }
        bytes.extend_from_slice(&self.owner_epoch.to_be_bytes());
        bytes.extend_from_slice(&self.process_identity.pid.to_be_bytes());
        bytes.extend_from_slice(&self.process_identity.start_identity.to_be_bytes());
        format!("blake3:{}", blake3::hash(&bytes).to_hex())
    }

    pub(crate) fn coordinator_id(&self) -> &str { &self.coordinator_id }
    pub(crate) fn goal_id(&self) -> &str { &self.goal_id }
    pub(crate) fn run_id(&self) -> &str { &self.run_id }
    pub(crate) fn principal_ref(&self) -> &str { &self.principal_ref }
    pub(crate) fn workspace_binding(&self) -> &str { &self.workspace_binding }
    pub(crate) fn session_id(&self) -> &str { &self.session_id }
    pub(crate) fn location_id(&self) -> &str { &self.location_id }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.process_incarnation }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity { &self.process_identity }
    pub(crate) fn accepted_spec_digest(&self) -> &str { &self.accepted_spec_digest }
    pub(crate) fn root_digest(&self) -> &str { &self.root_digest }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeOperationStateV1 {
    Pending,
    Completed,
    Unknown,
    Quarantined,
    RetiredNoDispatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorktreeObservedStatusV1 {
    Clean,
    DirtyOwned,
    DirtyUnattributed,
    Missing,
    Unknown,
}

/// Guard-observed state immediately before a destructive release. The P1
/// executor must obtain this and the post-operation state under the same
/// authenticated root handle; a clean preflight alone never proves deletion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreePreReleaseEvidenceV1 {
    status: WorktreeObservedStatusV1,
    dirty_entry_count: u32,
    dirty_entries_digest: String,
    contains_user_owned_changes: bool,
}

impl WorktreePreReleaseEvidenceV1 {
    pub(crate) fn from_guarded_host(
        status: WorktreeObservedStatusV1,
        dirty_entry_count: u32,
        dirty_entries_digest: String,
        contains_user_owned_changes: bool,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        validate_observation(status, dirty_entry_count, &dirty_entries_digest, contains_user_owned_changes)?;
        Ok(Self { status, dirty_entry_count, dirty_entries_digest, contains_user_owned_changes })
    }

    fn proves_clean(&self) -> bool {
        self.status == WorktreeObservedStatusV1::Clean
            && self.dirty_entry_count == 0
            && !self.contains_user_owned_changes
    }

    pub(crate) fn status(&self) -> WorktreeObservedStatusV1 { self.status }
    pub(crate) fn dirty_entry_count(&self) -> u32 { self.dirty_entry_count }
    pub(crate) fn dirty_entries_digest(&self) -> &str { &self.dirty_entries_digest }
    pub(crate) fn contains_user_owned_changes(&self) -> bool { self.contains_user_owned_changes }
}

/// Opaque registered-root reference supplied by HostKernel, never by a request.
/// It is a locator only; every operation re-resolves it against live HostKernel
/// registration and authenticated owner scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorkspaceRootRefV1 {
    location_ref: String,
    workspace_binding: String,
    registration_generation: u64,
}

impl WorkspaceRootRefV1 {
    pub(crate) fn from_host_kernel(
        location_ref: String,
        workspace_binding: String,
        registration_generation: u64,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        if !valid_token(&location_ref, 256)
            || !valid_token(&workspace_binding, 128)
            || registration_generation == 0
        {
            return Err(WorktreeLifecycleErrorV1::InvalidRootReference);
        }
        Ok(Self {
            location_ref,
            workspace_binding,
            registration_generation,
        })
    }

    pub(crate) fn location_ref(&self) -> &str {
        &self.location_ref
    }
    pub(crate) fn workspace_binding(&self) -> &str {
        &self.workspace_binding
    }
    pub(crate) fn registration_generation(&self) -> u64 {
        self.registration_generation
    }
}

/// Persist this intent in the canonical WorkerPool OwnerLog before asking P1 to
/// perform any filesystem or Git effect. The operation ID is an idempotency key,
/// not authority. All identity and root fields must come from authenticated
/// HostKernel/managed-owner facts.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeOperationIntentV1 {
    operation_id: String,
    kind: WorktreeOperationKindV1,
    owner: WorktreeRootOwnerV1,
    root: WorkspaceRootRefV1,
    worktree_id: String,
    base_revision: Option<String>,
    relative_path: PathBuf,
    expected_workspace_revision: String,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    owner_epoch: u64,
}

impl WorktreeOperationIntentV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn new(
        operation_id: String,
        kind: WorktreeOperationKindV1,
        owner: WorktreeRootOwnerV1,
        root: WorkspaceRootRefV1,
        worktree_id: String,
        base_revision: String,
        relative_path: PathBuf,
        expected_workspace_revision: String,
        owner_log_id: String,
        owner_log_sequence: String,
        owner_log_event_digest: String,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        Self::from_owner_log(
            operation_id, kind, owner, root, worktree_id, Some(base_revision), relative_path,
            expected_workspace_revision, owner_log_id, owner_log_sequence, owner_log_event_digest,
        )
    }

    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_owner_log(
        operation_id: String,
        kind: WorktreeOperationKindV1,
        owner: WorktreeRootOwnerV1,
        root: WorkspaceRootRefV1,
        worktree_id: String,
        base_revision: Option<String>,
        relative_path: PathBuf,
        expected_workspace_revision: String,
        owner_log_id: String,
        owner_log_sequence: String,
        owner_log_event_digest: String,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        validate_intent_fields(
            &operation_id,
            &owner,
            &root,
            &worktree_id,
            &base_revision,
            &relative_path,
            &expected_workspace_revision,
            &owner_log_id,
            &owner_log_sequence,
            &owner_log_event_digest,
        )?;
        if owner.workspace_binding() != root.workspace_binding {
            return Err(WorktreeLifecycleErrorV1::ScopeMismatch);
        }
        Ok(Self {
            operation_id,
            kind,
            owner_epoch: owner.owner_epoch(),
            owner,
            root,
            worktree_id,
            base_revision,
            relative_path,
            expected_workspace_revision,
            owner_log_id,
            owner_log_sequence,
            owner_log_event_digest,
        })
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub(crate) fn kind(&self) -> WorktreeOperationKindV1 {
        self.kind
    }
    pub(crate) fn owner(&self) -> &WorktreeRootOwnerV1 {
        &self.owner
    }
    pub(crate) fn root(&self) -> &WorkspaceRootRefV1 {
        &self.root
    }
    pub(crate) fn worktree_id(&self) -> &str {
        &self.worktree_id
    }
    pub(crate) fn base_revision(&self) -> Option<&str> { self.base_revision.as_deref() }
    pub(crate) fn relative_path(&self) -> &Path {
        &self.relative_path
    }
    pub(crate) fn expected_workspace_revision(&self) -> &str {
        &self.expected_workspace_revision
    }
    pub(crate) fn owner_log_id(&self) -> &str {
        &self.owner_log_id
    }
    pub(crate) fn owner_log_sequence(&self) -> &str {
        &self.owner_log_sequence
    }
    pub(crate) fn owner_log_event_digest(&self) -> &str {
        &self.owner_log_event_digest
    }
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }
}

/// Typed P1 request. It deliberately contains a registered root reference and a
/// validated relative path, never an absolute filesystem path, argv or shell
/// fragment. P1 must re-resolve every field before dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GuardedWorktreeRequestV1 {
    intent: WorktreeOperationIntentV1,
}

impl GuardedWorktreeRequestV1 {
    pub(crate) fn from_durable_intent(intent: WorktreeOperationIntentV1) -> Self {
        Self { intent }
    }
    pub(crate) fn intent(&self) -> &WorktreeOperationIntentV1 {
        &self.intent
    }
}

/// Status data gathered by P1 through the registered root handle. Paths are not
/// returned: the bounded digest/count can report user changes without leaking
/// filenames into worker control or performance records.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GuardedWorktreeReceiptV1 {
    operation_id: String,
    host_receipt_ref: String,
    workspace_binding: String,
    registration_generation: u64,
    observed_workspace_revision: String,
    status: WorktreeObservedStatusV1,
    dirty_entry_count: u32,
    dirty_entries_digest: String,
    contains_user_owned_changes: bool,
    pre_release: Option<WorktreePreReleaseEvidenceV1>,
    owned: bool,
    no_follow: bool,
}

impl GuardedWorktreeReceiptV1 {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_guarded_host(
        operation_id: String,
        host_receipt_ref: String,
        root: &WorkspaceRootRefV1,
        observed_workspace_revision: String,
        status: WorktreeObservedStatusV1,
        dirty_entry_count: u32,
        dirty_entries_digest: String,
        contains_user_owned_changes: bool,
        pre_release: Option<WorktreePreReleaseEvidenceV1>,
        owned: bool,
        no_follow: bool,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        if !valid_token(&operation_id, 128)
            || !valid_token(&host_receipt_ref, MAX_WORKTREE_RECEIPT_REF_BYTES)
            || !valid_token(&observed_workspace_revision, 256)
            || dirty_entry_count > 100_000
            || (dirty_entry_count > 0 && !is_digest(&dirty_entries_digest))
            || (!dirty_entries_digest.is_empty() && !is_digest(&dirty_entries_digest))
        {
            return Err(WorktreeLifecycleErrorV1::InvalidReceipt);
        }
        validate_observation(status, dirty_entry_count, &dirty_entries_digest, contains_user_owned_changes)?;
        match (&pre_release, status) {
            (Some(before), WorktreeObservedStatusV1::Missing) if before.proves_clean() => {}
            (None, _) => {}
            _ => return Err(WorktreeLifecycleErrorV1::InconsistentReceipt),
        }
        if pre_release.is_some() && status != WorktreeObservedStatusV1::Missing {
            return Err(WorktreeLifecycleErrorV1::InconsistentReceipt);
        }
        Ok(Self {
            operation_id,
            host_receipt_ref,
            workspace_binding: root.workspace_binding.clone(),
            registration_generation: root.registration_generation,
            observed_workspace_revision,
            status,
            dirty_entry_count,
            dirty_entries_digest,
            contains_user_owned_changes,
            pre_release,
            owned,
            no_follow,
        })
    }

    pub(crate) fn operation_id(&self) -> &str {
        &self.operation_id
    }
    pub(crate) fn host_receipt_ref(&self) -> &str {
        &self.host_receipt_ref
    }
    pub(crate) fn workspace_binding(&self) -> &str {
        &self.workspace_binding
    }
    pub(crate) fn registration_generation(&self) -> u64 {
        self.registration_generation
    }
    pub(crate) fn observed_workspace_revision(&self) -> &str {
        &self.observed_workspace_revision
    }
    pub(crate) fn status(&self) -> WorktreeObservedStatusV1 {
        self.status
    }
    pub(crate) fn dirty_entry_count(&self) -> u32 {
        self.dirty_entry_count
    }
    pub(crate) fn dirty_entries_digest(&self) -> &str {
        &self.dirty_entries_digest
    }
    pub(crate) fn contains_user_owned_changes(&self) -> bool {
        self.contains_user_owned_changes
    }
    pub(crate) fn pre_release(&self) -> Option<&WorktreePreReleaseEvidenceV1> { self.pre_release.as_ref() }
    pub(crate) fn owned(&self) -> bool { self.owned }
    pub(crate) fn no_follow(&self) -> bool { self.no_follow }
}

/// Live registration authority minted only after P1 has persisted the exact
/// guarded Create and a fresh no-follow Inspect under the same registered root.
/// The persisted legacy registration shape remains an implementation detail;
/// without this opaque provenance its cleanliness booleans cannot admit work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VerifiedWorktreeRegistrationV1 {
    owner: WorktreeRootOwnerV1,
    registration: crate::worktree_pool::WorktreeRegistration,
    verification_digest: Option<String>,
    provenance: Option<WorktreeRegistrationProvenanceV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeRegistrationProvenanceV1 {
    create_operation_id: String,
    create_receipt_ref: String,
    inspect_operation_id: String,
    inspect_receipt_ref: String,
}

impl WorktreeRegistrationProvenanceV1 {
    pub(crate) fn from_owner_log(
        create_operation_id: String,
        create_receipt_ref: String,
        inspect_operation_id: String,
        inspect_receipt_ref: String,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        if !valid_token(&create_operation_id, 128)
            || !valid_token(&inspect_operation_id, 128)
            || !valid_token(&create_receipt_ref, MAX_WORKTREE_RECEIPT_REF_BYTES)
            || !valid_token(&inspect_receipt_ref, MAX_WORKTREE_RECEIPT_REF_BYTES)
            || create_operation_id == inspect_operation_id
        {
            return Err(WorktreeLifecycleErrorV1::InvalidReceipt);
        }
        Ok(Self { create_operation_id, create_receipt_ref, inspect_operation_id, inspect_receipt_ref })
    }
    pub(crate) fn create_operation_id(&self) -> &str { &self.create_operation_id }
    pub(crate) fn create_receipt_ref(&self) -> &str { &self.create_receipt_ref }
    pub(crate) fn inspect_operation_id(&self) -> &str { &self.inspect_operation_id }
    pub(crate) fn inspect_receipt_ref(&self) -> &str { &self.inspect_receipt_ref }
}

impl VerifiedWorktreeRegistrationV1 {
    pub(crate) fn from_guarded_create_and_inspect(
        owner: &WorktreeRootOwnerV1,
        create_intent: &WorktreeOperationIntentV1,
        create_receipt: &GuardedWorktreeReceiptV1,
        inspect_intent: &WorktreeOperationIntentV1,
        inspect_receipt: &GuardedWorktreeReceiptV1,
        canonical_path: PathBuf,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        let same_target = create_intent.kind == WorktreeOperationKindV1::Create
            && inspect_intent.kind == WorktreeOperationKindV1::Inspect
            && create_intent.owner == *owner
            && inspect_intent.owner == *owner
            && create_intent.worktree_id == inspect_intent.worktree_id
            && create_intent.base_revision.is_some()
            && create_intent.base_revision == inspect_intent.base_revision
            && create_intent.relative_path == inspect_intent.relative_path
            && create_intent.root == inspect_intent.root
            && create_intent.expected_workspace_revision == inspect_intent.expected_workspace_revision
            && create_receipt.operation_id == create_intent.operation_id
            && inspect_receipt.operation_id == inspect_intent.operation_id
            && create_receipt.workspace_binding == create_intent.root.workspace_binding
            && inspect_receipt.workspace_binding == inspect_intent.root.workspace_binding
            && create_receipt.registration_generation == create_intent.root.registration_generation
            && inspect_receipt.registration_generation == inspect_intent.root.registration_generation
            && create_receipt.observed_workspace_revision == create_intent.expected_workspace_revision
            && inspect_receipt.observed_workspace_revision == inspect_intent.expected_workspace_revision
            && create_receipt.status == WorktreeObservedStatusV1::Clean
            && inspect_receipt.status == WorktreeObservedStatusV1::Clean
            && create_receipt.dirty_entry_count == 0
            && inspect_receipt.dirty_entry_count == 0
            && !create_receipt.contains_user_owned_changes
            && !inspect_receipt.contains_user_owned_changes
            && create_receipt.owned
            && inspect_receipt.owned
            && create_receipt.no_follow
            && inspect_receipt.no_follow
            && canonical_path.is_absolute()
            && !canonical_path.components().any(|part| part == Component::ParentDir);
        if !same_target {
            return Err(WorktreeLifecycleErrorV1::InconsistentReceipt);
        }
        let registration = crate::worktree_pool::WorktreeRegistration {
            id: create_intent.worktree_id.clone(),
            workspace_binding: create_intent.root.workspace_binding.clone(),
            path: canonical_path,
            base_revision: create_intent.base_revision.clone().expect("validated base revision"),
            observed_revision: Some(inspect_receipt.observed_workspace_revision.clone()),
            clean: Some(true),
            has_untracked: Some(false),
        };
        let verification_digest = verified_registration_digest(
            owner, create_intent, create_receipt, inspect_intent, inspect_receipt, &registration,
        );
        let provenance = WorktreeRegistrationProvenanceV1 {
            create_operation_id: create_intent.operation_id.clone(),
            create_receipt_ref: create_receipt.host_receipt_ref.clone(),
            inspect_operation_id: inspect_intent.operation_id.clone(),
            inspect_receipt_ref: inspect_receipt.host_receipt_ref.clone(),
        };
        Ok(Self { owner: owner.clone(), registration, verification_digest: Some(verification_digest), provenance: Some(provenance) })
    }

    pub(crate) fn from_owner_log(
        owner: WorktreeRootOwnerV1,
        registration: crate::worktree_pool::WorktreeRegistration,
        verification_digest: Option<String>,
        provenance: Option<WorktreeRegistrationProvenanceV1>,
    ) -> Result<Self, WorktreeLifecycleErrorV1> {
        if verification_digest.as_deref().is_some_and(|value| !is_digest(value)) {
            return Err(WorktreeLifecycleErrorV1::InvalidReceipt);
        }
        if verification_digest.is_some() != provenance.is_some() {
            return Err(WorktreeLifecycleErrorV1::InvalidReceipt);
        }
        Ok(Self { owner, registration, verification_digest, provenance })
    }

    pub(crate) fn owner(&self) -> &WorktreeRootOwnerV1 { &self.owner }
    pub(crate) fn registration(&self) -> &crate::worktree_pool::WorktreeRegistration { &self.registration }
    pub(crate) fn verification_digest(&self) -> Option<&str> { self.verification_digest.as_deref() }
    pub(crate) fn provenance(&self) -> Option<&WorktreeRegistrationProvenanceV1> { self.provenance.as_ref() }

    pub(crate) fn matches_durable_operations(&self, journal: &WorktreeOperationJournalV1) -> bool {
        let (Some(provenance), Some(digest)) = (&self.provenance, self.verification_digest.as_deref()) else {
            return false;
        };
        let (Some(create), Some(inspect)) = (
            journal.get(&provenance.create_operation_id),
            journal.get(&provenance.inspect_operation_id),
        ) else { return false };
        let (Some(create_receipt), Some(inspect_receipt)) = (create.receipt(), inspect.receipt()) else {
            return false;
        };
        let create_intent = create.intent();
        let inspect_intent = inspect.intent();
        create.state() == WorktreeOperationStateV1::Completed
            && inspect.state() == WorktreeOperationStateV1::Completed
            && create_intent.kind() == WorktreeOperationKindV1::Create
            && inspect_intent.kind() == WorktreeOperationKindV1::Inspect
            && create_intent.owner() == &self.owner
            && inspect_intent.owner() == &self.owner
            && create_intent.worktree_id() == inspect_intent.worktree_id()
            && create_intent.base_revision() == inspect_intent.base_revision()
            && create_intent.relative_path() == inspect_intent.relative_path()
            && create_intent.root() == inspect_intent.root()
            && create_intent.expected_workspace_revision() == inspect_intent.expected_workspace_revision()
            && create_intent.base_revision().is_some()
            && create_receipt.host_receipt_ref() == provenance.create_receipt_ref
            && inspect_receipt.host_receipt_ref() == provenance.inspect_receipt_ref
            && create_receipt.status() == WorktreeObservedStatusV1::Clean
            && inspect_receipt.status() == WorktreeObservedStatusV1::Clean
            && create_receipt.workspace_binding() == create_intent.root().workspace_binding()
            && inspect_receipt.workspace_binding() == create_intent.root().workspace_binding()
            && create_receipt.registration_generation() == create_intent.root().registration_generation()
            && inspect_receipt.registration_generation() == create_intent.root().registration_generation()
            && create_receipt.observed_workspace_revision() == create_intent.expected_workspace_revision()
            && inspect_receipt.observed_workspace_revision() == create_intent.expected_workspace_revision()
            && create_receipt.dirty_entry_count() == 0
            && inspect_receipt.dirty_entry_count() == 0
            && !create_receipt.contains_user_owned_changes()
            && !inspect_receipt.contains_user_owned_changes()
            && create_receipt.owned()
            && inspect_receipt.owned()
            && create_receipt.no_follow()
            && inspect_receipt.no_follow()
            && create_receipt.owned()
            && inspect_receipt.owned()
            && create_receipt.no_follow()
            && inspect_receipt.no_follow()
            && self.registration.id == create_intent.worktree_id()
            && self.registration.workspace_binding == create_intent.root().workspace_binding()
            && self.registration.base_revision == create_intent.base_revision().unwrap_or_default()
            && self.registration.observed_revision.as_deref() == Some(inspect_receipt.observed_workspace_revision())
            && self.registration.clean == Some(true)
            && self.registration.has_untracked == Some(false)
            && self.registration.path.is_absolute()
            && verified_registration_digest(
                &self.owner, create_intent, create_receipt, inspect_intent, inspect_receipt,
                &self.registration,
            ) == digest
    }
}

fn verified_registration_digest(
    owner: &WorktreeRootOwnerV1,
    create_intent: &WorktreeOperationIntentV1,
    create_receipt: &GuardedWorktreeReceiptV1,
    inspect_intent: &WorktreeOperationIntentV1,
    inspect_receipt: &GuardedWorktreeReceiptV1,
    registration: &crate::worktree_pool::WorktreeRegistration,
) -> String {
    let mut bytes = b"horizoncode.verified-worktree-registration.v1\0".to_vec();
    let path = registration.path.to_string_lossy();
    for value in [
        owner.coordinator_id.as_str(), owner.goal_id.as_str(), owner.principal_ref.as_str(),
        owner.workspace_binding.as_str(), owner.session_id.as_str(), owner.run_id.as_str(),
        owner.location_id.as_str(), owner.process_incarnation.as_str(),
        owner.accepted_spec_digest.as_str(), owner.root_digest.as_str(),
        create_intent.operation_id.as_str(), create_receipt.host_receipt_ref.as_str(),
        inspect_intent.operation_id.as_str(), inspect_receipt.host_receipt_ref.as_str(),
        registration.id.as_str(), registration.workspace_binding.as_str(),
        registration.base_revision.as_str(), registration.observed_revision.as_deref().unwrap_or_default(),
        path.as_ref(),
    ] {
        bytes.extend_from_slice(&(value.len() as u64).to_be_bytes());
        bytes.extend_from_slice(value.as_bytes());
    }
    bytes.extend_from_slice(&owner.owner_epoch.to_be_bytes());
    bytes.extend_from_slice(&owner.process_identity.pid.to_be_bytes());
    bytes.extend_from_slice(&owner.process_identity.start_identity.to_be_bytes());
    bytes.extend_from_slice(&create_intent.root.registration_generation.to_be_bytes());
    format!("blake3:{}", blake3::hash(&bytes).to_hex())
}

/// The only execution seam. P1 supplies the production implementation after it
/// can revalidate Guard, root handles and OS confinement. Until then the default
/// port refuses all operations.
pub(crate) trait GuardedWorktreePortV1 {
    fn execute_guarded_worktree_operation(
        &mut self,
        request: GuardedWorktreeRequestV1,
    ) -> Result<GuardedWorktreeReceiptV1, WorktreeLifecycleErrorV1>;
}

pub(crate) struct UnavailableGuardedWorktreePortV1;

impl GuardedWorktreePortV1 for UnavailableGuardedWorktreePortV1 {
    fn execute_guarded_worktree_operation(
        &mut self,
        _request: GuardedWorktreeRequestV1,
    ) -> Result<GuardedWorktreeReceiptV1, WorktreeLifecycleErrorV1> {
        Err(WorktreeLifecycleErrorV1::DriverUnavailable)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct WorktreeOperationRecordV1 {
    intent: WorktreeOperationIntentV1,
    state: WorktreeOperationStateV1,
    receipt: Option<GuardedWorktreeReceiptV1>,
}

impl WorktreeOperationRecordV1 {
    pub(crate) fn intent(&self) -> &WorktreeOperationIntentV1 {
        &self.intent
    }
    pub(crate) fn state(&self) -> WorktreeOperationStateV1 {
        self.state
    }
    pub(crate) fn receipt(&self) -> Option<&GuardedWorktreeReceiptV1> {
        self.receipt.as_ref()
    }
}

/// Rebuilt from the canonical worker OwnerLog events. This is a projection of
/// the same P8 owner stream, never a second authoritative runtime.
#[derive(Clone, Debug, Default)]
pub(crate) struct WorktreeOperationJournalV1 {
    records: BTreeMap<String, WorktreeOperationRecordV1>,
}

impl WorktreeOperationJournalV1 {
    pub(crate) fn len(&self) -> usize {
        self.records.len()
    }
    pub(crate) fn get(&self, operation_id: &str) -> Option<&WorktreeOperationRecordV1> {
        self.records.get(operation_id)
    }
    pub(crate) fn iter(&self) -> impl Iterator<Item = &WorktreeOperationRecordV1> {
        self.records.values()
    }

    pub(crate) fn dispatchable_intent(
        &self,
        operation_id: &str,
    ) -> Option<&WorktreeOperationIntentV1> {
        self.records
            .get(operation_id)
            .filter(|record| record.state == WorktreeOperationStateV1::Pending)
            .map(|record| &record.intent)
    }

    /// Durable possible-dispatch fence. UNKNOWN accepts only an authenticated
    /// terminal receipt or reconciliation; it cannot yield another request.
    pub(crate) fn record_dispatch_started(
        &mut self,
        operation_id: &str,
    ) -> Result<(), WorktreeLifecycleErrorV1> {
        let record = self.records.get_mut(operation_id)
            .ok_or(WorktreeLifecycleErrorV1::IntentNotFound)?;
        if record.state != WorktreeOperationStateV1::Pending || record.receipt.is_some() {
            return Err(WorktreeLifecycleErrorV1::InvalidTransition);
        }
        record.state = WorktreeOperationStateV1::Unknown;
        Ok(())
    }

    pub(crate) fn record_retired_no_dispatch(
        &mut self,
        operation_id: &str,
    ) -> Result<(), WorktreeLifecycleErrorV1> {
        let record = self.records.get_mut(operation_id)
            .ok_or(WorktreeLifecycleErrorV1::IntentNotFound)?;
        if record.state != WorktreeOperationStateV1::Pending || record.receipt.is_some() {
            return Err(WorktreeLifecycleErrorV1::InvalidTransition);
        }
        record.state = WorktreeOperationStateV1::RetiredNoDispatch;
        Ok(())
    }

    pub(crate) fn record_intent(
        &mut self,
        intent: WorktreeOperationIntentV1,
    ) -> Result<(), WorktreeLifecycleErrorV1> {
        if let Some(existing) = self.records.get(intent.operation_id()) {
            return if existing.intent == intent {
                Ok(())
            } else {
                Err(WorktreeLifecycleErrorV1::IdempotencyConflict)
            };
        }
        if self.records.len() >= MAX_WORKTREE_OPERATIONS {
            return Err(WorktreeLifecycleErrorV1::OperationLimitReached);
        }
        self.records.insert(
            intent.operation_id.clone(),
            WorktreeOperationRecordV1 {
                intent,
                state: WorktreeOperationStateV1::Pending,
                receipt: None,
            },
        );
        Ok(())
    }

    pub(crate) fn record_receipt(
        &mut self,
        receipt: GuardedWorktreeReceiptV1,
    ) -> Result<(), WorktreeLifecycleErrorV1> {
        let record = self
            .records
            .get_mut(receipt.operation_id())
            .ok_or(WorktreeLifecycleErrorV1::IntentNotFound)?;
        if let Some(prior) = &record.receipt {
            return if prior == &receipt {
                Ok(())
            } else {
                Err(WorktreeLifecycleErrorV1::IdempotencyConflict)
            };
        }
        if record.state != WorktreeOperationStateV1::Unknown {
            return Err(WorktreeLifecycleErrorV1::InvalidTransition);
        }
        if receipt.workspace_binding != record.intent.root.workspace_binding
            || receipt.registration_generation != record.intent.root.registration_generation
            || receipt.observed_workspace_revision != record.intent.expected_workspace_revision
        {
            record.state = WorktreeOperationStateV1::Quarantined;
            record.receipt = Some(receipt);
            return Ok(());
        }
        if (record.intent.kind == WorktreeOperationKindV1::Release
            && (receipt.status != WorktreeObservedStatusV1::Missing
                || receipt.pre_release.as_ref().is_none_or(|before| !before.proves_clean())
                || receipt.dirty_entry_count != 0
                || receipt.contains_user_owned_changes))
            || (record.intent.kind == WorktreeOperationKindV1::Create
                && receipt.status != WorktreeObservedStatusV1::Clean)
        {
            record.state = WorktreeOperationStateV1::Quarantined;
            record.receipt = Some(receipt);
            return Ok(());
        }
        if receipt.status == WorktreeObservedStatusV1::Unknown
            || receipt.status == WorktreeObservedStatusV1::DirtyUnattributed
        {
            record.state = WorktreeOperationStateV1::Quarantined;
        } else {
            record.state = WorktreeOperationStateV1::Completed;
        }
        record.receipt = Some(receipt);
        Ok(())
    }

    pub(crate) fn is_release_safe(&self, operation_id: &str) -> bool {
        let Some(record) = self.records.get(operation_id) else {
            return false;
        };
        let Some(receipt) = record.receipt.as_ref() else {
            return false;
        };
        record.intent.kind == WorktreeOperationKindV1::Release
            && record.state == WorktreeOperationStateV1::Completed
            && receipt.status == WorktreeObservedStatusV1::Missing
            && receipt.dirty_entry_count == 0
            && !receipt.contains_user_owned_changes
            && receipt.pre_release.as_ref().is_some_and(WorktreePreReleaseEvidenceV1::proves_clean)
            && receipt.observed_workspace_revision == record.intent.expected_workspace_revision
    }
}

fn validate_observation(
    status: WorktreeObservedStatusV1,
    dirty_entry_count: u32,
    dirty_entries_digest: &str,
    contains_user_owned_changes: bool,
) -> Result<(), WorktreeLifecycleErrorV1> {
    if dirty_entry_count > 100_000
        || (dirty_entry_count > 0 && !is_digest(dirty_entries_digest))
        || (!dirty_entries_digest.is_empty() && !is_digest(dirty_entries_digest))
    {
        return Err(WorktreeLifecycleErrorV1::InvalidReceipt);
    }
    let dirty = status == WorktreeObservedStatusV1::DirtyOwned
        || status == WorktreeObservedStatusV1::DirtyUnattributed;
    if (status == WorktreeObservedStatusV1::Clean
        && (dirty_entry_count != 0 || contains_user_owned_changes))
        || (dirty && dirty_entry_count == 0)
        || (contains_user_owned_changes && !dirty)
        || (status == WorktreeObservedStatusV1::Missing && dirty_entry_count != 0)
    {
        return Err(WorktreeLifecycleErrorV1::InconsistentReceipt);
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum WorktreeLifecycleErrorV1 {
    InvalidRootReference,
    InvalidRootOwner,
    InvalidIntent,
    ScopeMismatch,
    InvalidReceipt,
    InconsistentReceipt,
    DriverUnavailable,
    IdempotencyConflict,
    OperationLimitReached,
    IntentNotFound,
    InvalidTransition,
}

fn validate_intent_fields(
    operation_id: &str,
    owner: &WorktreeRootOwnerV1,
    root: &WorkspaceRootRefV1,
    worktree_id: &str,
    base_revision: &Option<String>,
    relative_path: &Path,
    revision: &str,
    log_id: &str,
    log_sequence: &str,
    log_digest: &str,
) -> Result<(), WorktreeLifecycleErrorV1> {
    if !valid_token(operation_id, 128)
        || !valid_token(worktree_id, 128)
        || base_revision.as_deref().is_some_and(|revision| !valid_token(revision, 256))
        || !valid_token(revision, 256)
        || !valid_token(log_id, 128)
        || !valid_decimal(log_sequence)
        || !is_digest(log_digest)
        || owner.owner_epoch() == 0
        || root.registration_generation == 0
        || !valid_relative_path(relative_path)
    {
        return Err(WorktreeLifecycleErrorV1::InvalidIntent);
    }
    Ok(())
}

fn valid_relative_path(path: &Path) -> bool {
    let text = path.to_string_lossy();
    !text.is_empty()
        && text.len() <= MAX_WORKTREE_PATH_BYTES
        && !text
            .bytes()
            .any(|byte| byte == b'\\' || byte == b':' || byte == 0 || byte.is_ascii_control())
        && !path.is_absolute()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn valid_token(value: &str, max: usize) -> bool {
    !value.is_empty()
        && value.len() <= max
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
}

fn valid_decimal(value: &str) -> bool {
    !value.is_empty()
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && (value == "0" || !value.starts_with('0'))
}

fn is_digest(value: &str) -> bool {
    value
        .strip_prefix("blake3:")
        .is_some_and(|hex| hex.len() == 64 && hex.bytes().all(|byte| byte.is_ascii_hexdigit()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> WorkspaceRootRefV1 {
        WorkspaceRootRefV1::from_host_kernel("location-a".into(), "workspace-a".into(), 3)
            .expect("trusted root fixture")
    }

    fn root_owner() -> WorktreeRootOwnerV1 {
        let mut owner = WorktreeRootOwnerV1 {
            coordinator_id: "root-coordinator-a".into(),
            goal_id: "goal-a".into(),
            run_id: "run-a".into(),
            principal_ref: "server_auth:principal-a".into(),
            workspace_binding: "workspace-a".into(),
            session_id: "session-a".into(),
            location_id: "location-a".into(),
            owner_epoch: 7,
            process_incarnation: "incarnation-a".into(),
            process_identity: ProcessIdentity::new(10, 20),
            accepted_spec_digest: format!("blake3:{}", "c".repeat(64)),
            root_digest: String::new(),
        };
        owner.root_digest = owner.compute_digest();
        owner
    }

    fn intent(kind: WorktreeOperationKindV1) -> WorktreeOperationIntentV1 {
        intent_named("operation-a", kind, "4")
    }

    fn intent_named(id: &str, kind: WorktreeOperationKindV1, sequence: &str) -> WorktreeOperationIntentV1 {
        WorktreeOperationIntentV1::new(
            id.into(), kind, root_owner(), root(), "worktree-a".into(), "base-rev-a".into(),
            PathBuf::from(".horizon/worktrees/worktree-a"), "workspace-rev-a".into(),
            "worker_pool-a".into(), sequence.into(), format!("blake3:{}", "a".repeat(64)),
        ).expect("valid operation fixture")
    }

    #[test]
    fn pending_intent_is_readable_until_the_possible_dispatch_marker_is_appended() {
        let mut journal = WorktreeOperationJournalV1::default();
        journal.record_intent(intent(WorktreeOperationKindV1::Inspect)).expect("record intent");

        // Guard descriptor construction may inspect this pending intent without
        // changing it into a possible external effect.
        assert!(journal.dispatchable_intent("operation-a").is_some());
        assert_eq!(journal.get("operation-a").unwrap().state(), WorktreeOperationStateV1::Pending);

        journal.record_dispatch_started("operation-a").expect("append dispatch fence");
        assert!(journal.dispatchable_intent("operation-a").is_none());
        assert_eq!(journal.get("operation-a").unwrap().state(), WorktreeOperationStateV1::Unknown);
        assert_eq!(journal.record_dispatch_started("operation-a"), Err(WorktreeLifecycleErrorV1::InvalidTransition));
    }

    #[test]
    fn no_dispatch_retirement_is_terminal_and_never_reopens_the_intent() {
        let mut journal = WorktreeOperationJournalV1::default();
        journal.record_intent(intent(WorktreeOperationKindV1::Create)).expect("record intent");
        journal.record_retired_no_dispatch("operation-a").expect("retire pending intent");
        assert_eq!(journal.get("operation-a").unwrap().state(), WorktreeOperationStateV1::RetiredNoDispatch);
        assert!(journal.dispatchable_intent("operation-a").is_none());
        assert_eq!(journal.record_dispatch_started("operation-a"), Err(WorktreeLifecycleErrorV1::InvalidTransition));
        assert_eq!(journal.record_retired_no_dispatch("operation-a"), Err(WorktreeLifecycleErrorV1::InvalidTransition));
    }

    #[test]
    fn release_requires_dispatched_operation_and_clean_predelete_plus_missing_poststate() {
        let operation = intent(WorktreeOperationKindV1::Release);
        let mut journal = WorktreeOperationJournalV1::default();
        journal.record_intent(operation).expect("record intent");
        let before = WorktreePreReleaseEvidenceV1::from_guarded_host(
            WorktreeObservedStatusV1::Clean, 0, String::new(), false,
        ).expect("clean pre-release evidence");
        let receipt = GuardedWorktreeReceiptV1::from_guarded_host(
            "operation-a".into(), "host-receipt-a".into(), &root(),
            "workspace-rev-a".into(), WorktreeObservedStatusV1::Missing, 0,
            String::new(), false, Some(before), true, true,
        ).expect("atomic guarded release receipt");
        assert_eq!(journal.record_receipt(receipt.clone()), Err(WorktreeLifecycleErrorV1::InvalidTransition));
        journal.record_dispatch_started("operation-a").expect("durable possible-dispatch fence");
        journal.record_receipt(receipt).expect("persist release receipt");
        assert!(journal.is_release_safe("operation-a"));
        assert_eq!(journal.record_dispatch_started("operation-a"), Err(WorktreeLifecycleErrorV1::InvalidTransition));
    }

    #[test]
    fn dirty_pre_release_evidence_cannot_produce_a_release_receipt() {
        let before = WorktreePreReleaseEvidenceV1::from_guarded_host(
            WorktreeObservedStatusV1::DirtyOwned, 1, format!("blake3:{}", "b".repeat(64)), false,
        ).expect("valid dirty observation");
        assert_eq!(
            GuardedWorktreeReceiptV1::from_guarded_host(
                "operation-a".into(), "host-receipt-a".into(), &root(),
                "workspace-rev-a".into(), WorktreeObservedStatusV1::Missing, 0,
                String::new(), false, Some(before), true, true,
            ),
            Err(WorktreeLifecycleErrorV1::InconsistentReceipt),
        );
    }

    #[test]
    fn only_completed_create_and_fresh_owned_nofollow_inspection_can_register() {
        let create = intent_named("create-a", WorktreeOperationKindV1::Create, "4");
        let inspect = intent_named("inspect-a", WorktreeOperationKindV1::Inspect, "6");
        let owner = create.owner().clone();
        let mut journal = WorktreeOperationJournalV1::default();
        journal.record_intent(create.clone()).expect("create intent");
        journal.record_dispatch_started("create-a").expect("create dispatch");
        journal.record_receipt(GuardedWorktreeReceiptV1::from_guarded_host(
            "create-a".into(), "create-receipt".into(), &root(),
            "workspace-rev-a".into(), WorktreeObservedStatusV1::Clean, 0,
            String::new(), false, None, true, true,
        ).expect("guarded create receipt")).expect("create completed");
        journal.record_intent(inspect.clone()).expect("inspection intent");
        journal.record_dispatch_started("inspect-a").expect("inspection dispatch");
        journal.record_receipt(GuardedWorktreeReceiptV1::from_guarded_host(
            "inspect-a".into(), "inspect-receipt".into(), &root(),
            "workspace-rev-a".into(), WorktreeObservedStatusV1::Clean, 0,
            String::new(), false, None, true, true,
        ).expect("guarded inspection receipt")).expect("inspection completed");
        let verified = VerifiedWorktreeRegistrationV1::from_guarded_create_and_inspect(
            &owner, &create, journal.get("create-a").and_then(WorktreeOperationRecordV1::receipt).unwrap(),
            &inspect, journal.get("inspect-a").and_then(WorktreeOperationRecordV1::receipt).unwrap(),
            PathBuf::from("/tmp/horizoncode/worktrees/worktree-a"),
        ).expect("verified registration");
        assert!(verified.matches_durable_operations(&journal));

        let nofollow_false = GuardedWorktreeReceiptV1::from_guarded_host(
            "inspect-a".into(), "inspect-receipt".into(), &root(),
            "workspace-rev-a".into(), WorktreeObservedStatusV1::Clean, 0,
            String::new(), false, None, true, false,
        ).expect("receipt lacking no-follow guarantee");
        assert_eq!(
            VerifiedWorktreeRegistrationV1::from_guarded_create_and_inspect(
                &owner, &create, journal.get("create-a").and_then(WorktreeOperationRecordV1::receipt).unwrap(),
                &inspect, &nofollow_false, PathBuf::from("/tmp/horizoncode/worktrees/worktree-a"),
            ),
            Err(WorktreeLifecycleErrorV1::InconsistentReceipt),
        );
    }
}
