use std::collections::HashSet;

const DEFAULT_MAX_PROCESSES: usize = 256;
const DEFAULT_MAX_WORK: usize = 4096;
const DEFAULT_MAX_BYTES: usize = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq, Hash)]
pub struct ProcessIdentity {
    pub pid: u32,
    /// OS-issued start-time/generation value, not a caller-visible command-line identity.
    pub start_identity: u64,
    #[cfg(windows)]
    /// Live handle supplied by the owning runtime; this module never opens arbitrary PIDs.
    pub process_handle: isize,
}

/// Process identity and owner scope derived from a replayed durable worker
/// lease. The constructor is crate-private: request JSON and arbitrary PID
/// lists cannot create sampling authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OwnedProcessLeaseV1 {
    worker_execution_id: String,
    owner: crate::resource_budget::AuthenticatedOwnerContext,
    process_identity: ProcessIdentity,
    state: crate::resource_budget::ReservationState,
}

impl OwnedProcessLeaseV1 {
    pub(crate) fn from_durable_owner(
        worker_execution_id: String,
        owner: crate::resource_budget::AuthenticatedOwnerContext,
        process_identity: ProcessIdentity,
        state: crate::resource_budget::ReservationState,
    ) -> Result<Self, ResourceLeaseAttributionError> {
        if worker_execution_id.is_empty()
            || worker_execution_id.len() > 128
            || process_identity.pid == 0
            || process_identity.start_identity == 0
            || !matches!(
                state,
                crate::resource_budget::ReservationState::Claimed
                    | crate::resource_budget::ReservationState::ReleasePending
                    | crate::resource_budget::ReservationState::Quarantined
            )
        {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        }
        Ok(Self {
            worker_execution_id,
            owner,
            process_identity,
            state,
        })
    }

    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn owner(&self) -> &crate::resource_budget::AuthenticatedOwnerContext {
        &self.owner
    }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity {
        &self.process_identity
    }
    pub(crate) fn state(&self) -> crate::resource_budget::ReservationState {
        self.state
    }
}

/// Authenticated live Core peer identity for a single-process resource sample.
/// This conveys sampling identity only, never worker or effect authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct SessionProcessOwnerIdentityV1 {
    process_identity: ProcessIdentity,
    owner_epoch: u64,
    process_incarnation: String,
    executable_identity_digest: String,
}

impl SessionProcessOwnerIdentityV1 {
    pub(crate) fn from_authenticated_peer(
        peer: &crate::host_kernel::AuthenticatedCorePeerFactsV1,
    ) -> Result<Self, ResourceLeaseAttributionError> {
        let process_identity = ProcessIdentity::new(peer.pid(), peer.start_identity());
        if process_identity.pid == 0
            || process_identity.start_identity == 0
            || peer.owner_epoch() == 0
            || peer.process_incarnation().is_empty()
            || peer.process_incarnation().len() > 128
            || !peer.executable_identity_digest().starts_with("blake3:")
            || peer.executable_identity_digest().len() != 71
            || !peer.executable_identity_digest()[7..]
                .bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
        {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        }
        Ok(Self {
            process_identity,
            owner_epoch: peer.owner_epoch(),
            process_incarnation: peer.process_incarnation().to_owned(),
            executable_identity_digest: peer.executable_identity_digest().to_owned(),
        })
    }

    pub(crate) fn process_identity(&self) -> &ProcessIdentity { &self.process_identity }
    pub(crate) fn owner_epoch(&self) -> u64 { self.owner_epoch }
    pub(crate) fn process_incarnation(&self) -> &str { &self.process_incarnation }
    pub(crate) fn executable_identity_digest(&self) -> &str { &self.executable_identity_digest }
    pub(crate) fn matches_authenticated_peer(
        &self,
        peer: &crate::host_kernel::AuthenticatedCorePeerFactsV1,
    ) -> bool {
        self.process_identity.pid == peer.pid()
            && self.process_identity.start_identity == peer.start_identity()
            && self.owner_epoch == peer.owner_epoch()
            && self.process_incarnation == peer.process_incarnation()
            && self.executable_identity_digest == peer.executable_identity_digest()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourceLeaseAttributionError {
    InvalidLease,
}

/// Bounded immutable process set and OwnerLog watermark for one resource
/// sample. Samples are derived telemetry and never mutate reservations.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DurableOwnedProcessLeaseSetV1 {
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    leases: Vec<OwnedProcessLeaseV1>,
}

impl DurableOwnedProcessLeaseSetV1 {
    pub(crate) fn from_durable_owner(
        owner_log_id: String,
        owner_log_sequence: String,
        owner_log_event_digest: String,
        worker_pool_revision: u64,
        leases: Vec<OwnedProcessLeaseV1>,
    ) -> Result<Self, ResourceLeaseAttributionError> {
        if owner_log_id.is_empty()
            || owner_log_sequence.parse::<u64>().is_err()
            || !owner_log_event_digest.starts_with("blake3:")
            || worker_pool_revision == 0
            || leases.len() > crate::worker_pool::MAX_WORKER_RECORDS
        {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        }
        Ok(Self {
            owner_log_id,
            owner_log_sequence,
            owner_log_event_digest,
            worker_pool_revision,
            leases,
        })
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
    pub(crate) fn worker_pool_revision(&self) -> u64 {
        self.worker_pool_revision
    }
    pub(crate) fn leases(&self) -> &[OwnedProcessLeaseV1] {
        &self.leases
    }
}

impl ProcessIdentity {
    pub const fn new(pid: u32, start_identity: u64) -> Self {
        Self {
            pid,
            start_identity,
            #[cfg(windows)]
            process_handle: 0,
        }
    }

    #[cfg(windows)]
    pub const fn with_handle(pid: u32, start_identity: u64, process_handle: isize) -> Self {
        Self {
            pid,
            start_identity,
            process_handle,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum UnknownReason {
    Unsupported,
    PermissionDenied,
    Exited,
    IdentityChanged,
    Unavailable,
    Malformed,
    BudgetExceeded,
    AttributionConflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Metric<T> {
    Measured(T),
    Unknown(UnknownReason),
}

impl<T> Metric<T> {
    pub const fn measured(value: T) -> Self {
        Self::Measured(value)
    }
    pub const fn unknown(reason: UnknownReason) -> Self {
        Self::Unknown(reason)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CounterSet {
    pub pss_bytes: Metric<u128>,
    pub rss_bytes: Metric<u128>,
    pub cpu_ns: Metric<u128>,
    pub thread_count: Metric<u128>,
    pub fd_count: Metric<u128>,
    pub private_bytes: Metric<u128>,
}

impl CounterSet {
    pub fn unknown(reason: UnknownReason) -> Self {
        Self {
            pss_bytes: Metric::unknown(reason.clone()),
            rss_bytes: Metric::unknown(reason.clone()),
            cpu_ns: Metric::unknown(reason.clone()),
            thread_count: Metric::unknown(reason.clone()),
            fd_count: Metric::unknown(reason.clone()),
            private_bytes: Metric::unknown(reason),
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub struct SampleBudget {
    pub max_processes: usize,
    pub max_work: usize,
    pub max_bytes: usize,
}

impl Default for SampleBudget {
    fn default() -> Self {
        Self {
            max_processes: DEFAULT_MAX_PROCESSES,
            max_work: DEFAULT_MAX_WORK,
            max_bytes: DEFAULT_MAX_BYTES,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AggregateCounters {
    pub pss_bytes: Metric<u128>,
    pub rss_bytes: Metric<u128>,
    pub cpu_ns: Metric<u128>,
    pub thread_count: Metric<u128>,
    pub fd_count: Metric<u128>,
    pub private_bytes: Metric<u128>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TreeSample {
    pub process_count: usize,
    pub metrics: AggregateCounters,
    pub truncated: bool,
    /// Confirmed PID/start-time pairs only. No command-line or environment data is retained.
    pub processes: Vec<ProcessIdentity>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SampleError {
    InvalidBudget,
    LeaseSetTooLarge,
    IdentityUnavailable { pid: u32, reason: UnknownReason },
    IdentityChanged { pid: u32 },
}

/// OS adapter. Implementations must return only descendants of the supplied identity, verify
/// the owner's PID/start identity around discovery, and never infer ownership from process data.
/// A production backend must enforce the supplied cumulative source-byte and work-item limits
/// while reading, before allocating/iterating beyond them; the default accounting is for test backends.
pub trait ProcessBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason>;
    fn children(&mut self, parent: &ProcessIdentity)
    -> Result<Vec<ProcessIdentity>, UnknownReason>;
    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet;
    fn begin_sample(&mut self, _max_bytes: usize, _max_work: usize) {}
    fn bytes_consumed(&self) -> usize {
        0
    }
    fn work_consumed(&self) -> usize {
        0
    }
}

pub fn sample_owned_process<B: ProcessBackend>(
    backend: &mut B,
    owner: ProcessIdentity,
) -> Result<CounterSet, SampleError> {
    sample_owned_process_bounded(backend, owner, DEFAULT_MAX_BYTES, DEFAULT_MAX_WORK)
}

fn sample_owned_process_bounded<B: ProcessBackend>(
    backend: &mut B,
    owner: ProcessIdentity,
    max_bytes: usize,
    max_work: usize,
) -> Result<CounterSet, SampleError> {
    if max_bytes == 0 || max_bytes > DEFAULT_MAX_BYTES || max_work == 0 || max_work > DEFAULT_MAX_WORK {
        return Err(SampleError::InvalidBudget);
    }
    backend.begin_sample(max_bytes, max_work);
    let before =
        backend
            .identity(owner.pid)
            .map_err(|reason| SampleError::IdentityUnavailable {
                pid: owner.pid,
                reason,
            })?;
    if before != owner {
        return Err(SampleError::IdentityChanged { pid: owner.pid });
    }
    let counters = backend.counters(&owner);
    if backend.bytes_consumed() > max_bytes || backend.work_consumed() > max_work {
        return Ok(CounterSet::unknown(UnknownReason::BudgetExceeded));
    }
    match backend.identity(owner.pid) {
        Ok(identity) if identity == owner => Ok(counters),
        Ok(_) => Ok(CounterSet::unknown(UnknownReason::IdentityChanged)),
        Err(reason) => Ok(CounterSet::unknown(reason)),
    }
}

pub fn sample_owned_tree<B: ProcessBackend>(
    backend: &mut B,
    owner: ProcessIdentity,
    budget: SampleBudget,
) -> Result<TreeSample, SampleError> {
    if budget.max_processes == 0
        || budget.max_work == 0
        || budget.max_bytes == 0
        || budget.max_processes > DEFAULT_MAX_PROCESSES
        || budget.max_work > DEFAULT_MAX_WORK
        || budget.max_bytes > DEFAULT_MAX_BYTES
    {
        return Err(SampleError::InvalidBudget);
    }
    backend.begin_sample(budget.max_bytes, budget.max_work);
    let actual =
        backend
            .identity(owner.pid)
            .map_err(|reason| SampleError::IdentityUnavailable {
                pid: owner.pid,
                reason,
            })?;
    if actual != owner {
        return Err(SampleError::IdentityChanged { pid: owner.pid });
    }
    let root_pid = owner.pid;
    let mut queue = vec![(owner, Vec::<ProcessIdentity>::new())];
    let mut visited = HashSet::new();
    let mut processes = Vec::new();
    let mut metrics = AggregateCounters {
        pss_bytes: Metric::measured(0),
        rss_bytes: Metric::measured(0),
        cpu_ns: Metric::measured(0),
        thread_count: Metric::measured(0),
        fd_count: Metric::measured(0),
        private_bytes: Metric::measured(0),
    };
    let mut work = 0usize;
    let mut truncation_reason = None;
    let mut truncated = false;

    while let Some((expected, expected_ancestors)) = queue.pop() {
        if !visited.insert(expected.clone()) {
            continue;
        }
        work = work.saturating_add(1);
        if work.saturating_add(backend.work_consumed()) > budget.max_work
            || processes.len() >= budget.max_processes
        {
            truncation_reason = Some(UnknownReason::BudgetExceeded);
            truncated = true;
            break;
        }
        let before =
            backend
                .identity(expected.pid)
                .map_err(|reason| SampleError::IdentityUnavailable {
                    pid: expected.pid,
                    reason,
                })?;
        if before != expected {
            if expected.pid == root_pid {
                return Err(SampleError::IdentityChanged { pid: expected.pid });
            }
            truncation_reason = Some(UnknownReason::IdentityChanged);
            truncated = true;
            continue;
        }
        if let Err(reason) =
            verify_ancestry(backend, &expected_ancestors, &expected, &mut work, budget)
        {
            truncation_reason = Some(reason);
            truncated = true;
            break;
        }
        let counters = backend.counters(&expected);
        if backend.bytes_consumed() > budget.max_bytes || backend.work_consumed() > budget.max_work
        {
            truncation_reason = Some(UnknownReason::BudgetExceeded);
            truncated = true;
            break;
        }
        match backend.identity(expected.pid) {
            Ok(identity) if identity == expected => {}
            Ok(_) if expected.pid == root_pid => {
                return Ok(unknown_tree(UnknownReason::IdentityChanged));
            }
            Err(reason) if expected.pid == root_pid => return Ok(unknown_tree(reason)),
            Ok(_) => {
                truncation_reason = Some(UnknownReason::IdentityChanged);
                truncated = true;
                continue;
            }
            Err(reason) => {
                truncation_reason = Some(reason);
                truncated = true;
                continue;
            }
        }
        if let Err(reason) =
            verify_ancestry(backend, &expected_ancestors, &expected, &mut work, budget)
        {
            truncation_reason = Some(reason);
            truncated = true;
            break;
        }
        merge(&mut metrics, counters);
        processes.push(expected.clone());
        match backend.children(&expected) {
            Ok(children) => {
                work = work.saturating_add(children.len());
                if work.saturating_add(backend.work_consumed()) > budget.max_work
                    || backend.bytes_consumed() > budget.max_bytes
                {
                    truncation_reason = Some(UnknownReason::BudgetExceeded);
                    truncated = true;
                    break;
                }
                let mut child_ancestors = expected_ancestors;
                child_ancestors.push(expected.clone());
                for child in children.into_iter().rev() {
                    if !visited.contains(&child) {
                        queue.push((child, child_ancestors.clone()));
                    }
                }
            }
            Err(reason) => {
                truncation_reason = Some(reason);
                truncated = true;
            }
        }
    }
    if truncated {
        set_all_unknown(
            &mut metrics,
            truncation_reason.unwrap_or(UnknownReason::BudgetExceeded),
        );
    }
    Ok(TreeSample {
        process_count: processes.len(),
        metrics,
        truncated,
        processes,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AttributedProcessTreeSampleV1 {
    worker_execution_id: String,
    task_id: String,
    attempt_id: String,
    state: crate::resource_budget::ReservationState,
    sample: TreeSample,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SessionProcessOwnerSampleV1 {
    identity: SessionProcessOwnerIdentityV1,
    metrics: AggregateCounters,
}

impl AttributedProcessTreeSampleV1 {
    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }
    pub(crate) fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub(crate) fn state(&self) -> crate::resource_budget::ReservationState {
        self.state
    }
    pub(crate) fn sample(&self) -> &TreeSample {
        &self.sample
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct DurableOwnedResourceSnapshotV1 {
    owner: crate::resource_budget::AuthenticatedOwnerContext,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    /// Sequence allocated by the trusted HostKernel OS sampler for the
    /// machine-wide capacity observation paired with this process sample.
    sample_sequence: u64,
    sampled_at_ms: u64,
    trees: Vec<AttributedProcessTreeSampleV1>,
    aggregate: AggregateCounters,
    session_process_owner: Option<SessionProcessOwnerSampleV1>,
}

impl DurableOwnedResourceSnapshotV1 {
    pub(crate) fn matches_owner(
        &self,
        owner: &crate::resource_budget::AuthenticatedOwnerContext,
    ) -> bool {
        self.owner == *owner
    }

    /// Stable RC0 ingestion shape. Values are decimal strings so counters above
    /// JavaScript's exact integer range remain exact. This sample is not a
    /// Session/Run completion attestation; P2 must independently bind its
    /// verifier result and P1 must bind the live HostKernel process owner.
    pub(crate) fn to_rc0_owner_sample_json(&self) -> serde_json::Value {
        use serde_json::json;
        json!({
            "schemaVersion": 1,
            "producer": "horizoncode.worker-owner.resource-sampler",
            "owner": {
                "principalRef": self.owner.principal_ref(),
                "workspaceBinding": self.owner.workspace_binding(),
                "sessionId": self.owner.session_id(),
                "runId": self.owner.run_id(),
                "ownerEpoch": self.owner.owner_epoch().to_string(),
            },
            "ownerLog": {
                "ownerId": self.owner_log_id,
                "sequence": self.owner_log_sequence,
                "eventDigest": self.owner_log_event_digest,
                "workerPoolRevision": self.worker_pool_revision.to_string(),
            },
            "sampledAtMs": self.sampled_at_ms.to_string(),
            "sampleSequence": self.sample_sequence.to_string(),
            "sessionProcessOwner": {
                "status": self.session_process_owner.as_ref().map_or("NOT_PROVIDED", |_| "MEASURED"),
                "processIdentity": self.session_process_owner.as_ref().map(|sample| json!({
                    "pid": sample.identity.process_identity.pid,
                    "startIdentity": sample.identity.process_identity.start_identity.to_string(),
                    "ownerEpoch": sample.identity.owner_epoch.to_string(),
                    "processIncarnation": sample.identity.process_incarnation,
                    "executableIdentityDigest": sample.identity.executable_identity_digest,
                })),
                "metrics": self.session_process_owner.as_ref().map(|sample| json!({
                    "pssBytes": metric_json(&sample.metrics.pss_bytes),
                    "rssBytes": metric_json(&sample.metrics.rss_bytes),
                    "cpuNs": metric_json(&sample.metrics.cpu_ns),
                    "threadCount": metric_json(&sample.metrics.thread_count),
                    "fdCount": metric_json(&sample.metrics.fd_count),
                    "privateBytes": metric_json(&sample.metrics.private_bytes),
                })),
                "source": "authenticated HostKernel Core peer sampled as one process; descendants belong to worker samples",
            },
            "workers": self.trees.iter().map(|tree| json!({
                "workerExecutionId": tree.worker_execution_id,
                "taskId": tree.task_id,
                "attemptId": tree.attempt_id,
                "reservationState": reservation_state_label(tree.state),
                "quality": tree_quality(&tree.sample),
                "processes": tree.sample.processes.iter().map(|process| json!({
                    "pid": process.pid,
                    "startIdentity": process.start_identity.to_string(),
                })).collect::<Vec<_>>(),
            })).collect::<Vec<_>>(),
            "aggregate": {
                "pssBytes": metric_json(&self.aggregate.pss_bytes),
                "rssBytes": metric_json(&self.aggregate.rss_bytes),
                "cpuNs": metric_json(&self.aggregate.cpu_ns),
                "threadCount": metric_json(&self.aggregate.thread_count),
                "fdCount": metric_json(&self.aggregate.fd_count),
                "privateBytes": metric_json(&self.aggregate.private_bytes),
            },
            "productAttestation": {
                "status": "NOT_ATTESTED",
                "hostRunReceiptRef": null,
                "independentVerifierEvidenceRef": null,
                "required": ["hostRunReceiptRef", "independentVerifierEvidenceRef", "sourceCommit"],
            },
        })
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
    pub(crate) fn worker_pool_revision(&self) -> u64 {
        self.worker_pool_revision
    }
    pub(crate) fn sampled_at_ms(&self) -> u64 {
        self.sampled_at_ms
    }
    pub(crate) fn sample_sequence(&self) -> u64 {
        self.sample_sequence
    }

    /// Creates a narrow, opaque memory telemetry record only when the exact
    /// worker tree is fully measured and belongs to this OwnerLog snapshot.
    /// It does not change admission capacity or prove an OS quota.
    pub(crate) fn attributed_memory_usage(
        &self,
        worker_execution_id: &str,
    ) -> Result<AttributedWorkerUsageV1, ResourceLeaseAttributionError> {
        // A per-tree counter cannot reduce reserved headroom when the complete
        // sample detected overlapping process trees or incomplete attribution.
        // Keeping the full reserve is safer than double-crediting shared PSS.
        if !matches!(self.aggregate.pss_bytes, Metric::Measured(_)) {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        }
        let tree = self
            .trees
            .iter()
            .find(|tree| tree.worker_execution_id == worker_execution_id)
            .ok_or(ResourceLeaseAttributionError::InvalidLease)?;
        let Metric::Measured(value) = &tree.sample.metrics.pss_bytes else {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        };
        if tree.sample.truncated || *value > u128::from(u64::MAX) {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        }
        Ok(AttributedWorkerUsageV1 {
            worker_execution_id: tree.worker_execution_id.clone(),
            task_id: tree.task_id.clone(),
            attempt_id: tree.attempt_id.clone(),
            process_identity: tree
                .sample
                .processes
                .first()
                .cloned()
                .ok_or(ResourceLeaseAttributionError::InvalidLease)?,
            units: *value as u64,
            sample_sequence: self.sample_sequence,
            owner_log_id: self.owner_log_id.clone(),
            owner_log_sequence: self.owner_log_sequence.clone(),
            owner_log_event_digest: self.owner_log_event_digest.clone(),
            worker_pool_revision: self.worker_pool_revision,
        })
    }
    pub(crate) fn trees(&self) -> &[AttributedProcessTreeSampleV1] {
        &self.trees
    }
    pub(crate) fn aggregate(&self) -> &AggregateCounters {
        &self.aggregate
    }
}

/// Opaque, sample-derived usage. Only the sampler can mint it; it conveys no
/// launch/effect authority and must be checked against the live pool and
/// matching HostKernel sample sequence before it is durably recorded as
/// telemetry. It does not change reservation accounting.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AttributedWorkerUsageV1 {
    worker_execution_id: String,
    task_id: String,
    attempt_id: String,
    process_identity: ProcessIdentity,
    units: u64,
    sample_sequence: u64,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
}

impl AttributedWorkerUsageV1 {
    pub(crate) fn worker_execution_id(&self) -> &str {
        &self.worker_execution_id
    }
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }
    pub(crate) fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub(crate) fn process_identity(&self) -> &ProcessIdentity {
        &self.process_identity
    }
    pub(crate) fn units(&self) -> u64 {
        self.units
    }
    pub(crate) fn sample_sequence(&self) -> u64 {
        self.sample_sequence
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
    pub(crate) fn worker_pool_revision(&self) -> u64 {
        self.worker_pool_revision
    }

    pub(crate) fn from_owner_log(
        worker_execution_id: String,
        task_id: String,
        attempt_id: String,
        process_identity: ProcessIdentity,
        units: u64,
        sample_sequence: u64,
        owner_log_id: String,
        owner_log_sequence: String,
        owner_log_event_digest: String,
        worker_pool_revision: u64,
    ) -> Result<Self, ResourceLeaseAttributionError> {
        if worker_execution_id.is_empty()
            || worker_execution_id.len() > 128
            || task_id.is_empty()
            || attempt_id.is_empty()
            || process_identity.pid == 0
            || process_identity.start_identity == 0
            || sample_sequence == 0
            || owner_log_id.is_empty()
            || owner_log_sequence.parse::<u64>().is_err()
            || !owner_log_event_digest.starts_with("blake3:")
            || worker_pool_revision == 0
        {
            return Err(ResourceLeaseAttributionError::InvalidLease);
        }
        Ok(Self {
            worker_execution_id,
            task_id,
            attempt_id,
            process_identity,
            units,
            sample_sequence,
            owner_log_id,
            owner_log_sequence,
            owner_log_event_digest,
            worker_pool_revision,
        })
    }
}

/// Samples only process generations from a P8 OwnerLog-derived lease set and
/// attributes them to its authenticated Run. Work/byte/process budgets are
/// partitioned across worker trees; duplicate descendants make the aggregate
/// UNKNOWN to prevent physical memory from being counted twice.
pub(crate) fn sample_durable_owned_process_leases<B: ProcessBackend>(
    backend: &mut B,
    leases: &DurableOwnedProcessLeaseSetV1,
    authenticated_owner: &crate::resource_budget::AuthenticatedOwnerContext,
    authenticated_session_peer: Option<&crate::host_kernel::AuthenticatedCorePeerFactsV1>,
    budget: SampleBudget,
    sampled_at_ms: u64,
    sample_sequence: u64,
) -> Result<DurableOwnedResourceSnapshotV1, SampleError> {
    if budget.max_processes == 0
        || budget.max_work == 0
        || budget.max_bytes == 0
        || budget.max_processes > DEFAULT_MAX_PROCESSES
        || budget.max_work > DEFAULT_MAX_WORK
        || budget.max_bytes > DEFAULT_MAX_BYTES
        || sample_sequence == 0
    {
        return Err(SampleError::InvalidBudget);
    }
    // Construct the session identity from fresh HostKernel peer facts for each
    // sample. Accepting a previously projected identity here could accidentally
    // sample a stale Core PID generation after its authenticated peer changed.
    let session_process_owner = authenticated_session_peer
        .map(SessionProcessOwnerIdentityV1::from_authenticated_peer)
        .transpose()
        .map_err(|_| SampleError::InvalidBudget)?;
    let selected: Vec<_> = leases
        .leases
        .iter()
        .filter(|lease| {
            lease.owner.principal_ref() == authenticated_owner.principal_ref()
                && lease.owner.workspace_binding() == authenticated_owner.workspace_binding()
                && lease.owner.session_id() == authenticated_owner.session_id()
                && lease.owner.run_id() == authenticated_owner.run_id()
                && lease.owner.owner_epoch() == authenticated_owner.owner_epoch()
        })
        .collect();
    if selected.len() > budget.max_processes {
        return Err(SampleError::LeaseSetTooLarge);
    }
    if let Some(peer) = session_process_owner.as_ref() {
        if peer.owner_epoch() != authenticated_owner.owner_epoch() {
            return Err(SampleError::IdentityChanged {
                pid: peer.process_identity().pid,
            });
        }
    }
    let sample_count = selected.len() + usize::from(session_process_owner.is_some());
    if sample_count > budget.max_processes {
        return Err(SampleError::LeaseSetTooLarge);
    }
    if sample_count > 0 && (budget.max_work < sample_count || budget.max_bytes < sample_count) {
        return Err(SampleError::InvalidBudget);
    }
    let mut aggregate = empty_aggregate();
    let mut trees = Vec::with_capacity(selected.len());
    let mut seen = HashSet::new();
    if !selected.is_empty() {
        let share = SampleBudget {
            max_processes: (budget.max_processes / sample_count).max(1),
            max_work: (budget.max_work / sample_count).max(1),
            max_bytes: (budget.max_bytes / sample_count).max(1),
        };
        for lease in selected {
            let sample = match sample_owned_tree(backend, lease.process_identity.clone(), share) {
                Ok(sample) => sample,
                Err(SampleError::IdentityUnavailable { reason, .. }) => unknown_tree(reason),
                Err(SampleError::IdentityChanged { .. }) => {
                    unknown_tree(UnknownReason::IdentityChanged)
                }
                Err(_) => unknown_tree(UnknownReason::BudgetExceeded),
            };
            if sample
                .processes
                .iter()
                .any(|process| !seen.insert(process.clone()))
            {
                set_all_unknown(&mut aggregate, UnknownReason::AttributionConflict);
            } else {
                merge_aggregate(&mut aggregate, &sample.metrics);
            }
            trees.push(AttributedProcessTreeSampleV1 {
                worker_execution_id: lease.worker_execution_id.clone(),
                task_id: lease.owner.task_id().to_owned(),
                attempt_id: lease.owner.attempt_id().to_owned(),
                state: lease.state,
                sample,
            });
        }
    }
    let mut session_process_owner = session_process_owner.map(|identity| {
        let max_bytes = (budget.max_bytes / (trees.len() + 1)).max(1);
        let max_work = (budget.max_work / (trees.len() + 1)).max(1);
        let metrics = match sample_owned_process_bounded(
            backend,
            identity.process_identity().clone(),
            max_bytes,
            max_work,
        ) {
            Ok(counters) => AggregateCounters {
                pss_bytes: counters.pss_bytes,
                rss_bytes: counters.rss_bytes,
                cpu_ns: counters.cpu_ns,
                thread_count: counters.thread_count,
                fd_count: counters.fd_count,
                private_bytes: counters.private_bytes,
            },
            Err(SampleError::IdentityUnavailable { reason, .. }) => AggregateCounters::unknown(reason),
            Err(SampleError::IdentityChanged { .. }) => {
                AggregateCounters::unknown(UnknownReason::IdentityChanged)
            }
            Err(_) => AggregateCounters::unknown(UnknownReason::BudgetExceeded),
        };
        SessionProcessOwnerSampleV1 { identity: identity.clone(), metrics }
    });
    if let Some(session_sample) = session_process_owner.as_mut() {
        if trees.iter().any(|tree| tree.sample.processes.contains(session_sample.identity.process_identity())) {
            set_all_unknown(&mut aggregate, UnknownReason::AttributionConflict);
            set_all_unknown(&mut session_sample.metrics, UnknownReason::AttributionConflict);
        }
    }
    Ok(DurableOwnedResourceSnapshotV1 {
        owner: authenticated_owner.clone(),
        owner_log_id: leases.owner_log_id.clone(),
        owner_log_sequence: leases.owner_log_sequence.clone(),
        owner_log_event_digest: leases.owner_log_event_digest.clone(),
        worker_pool_revision: leases.worker_pool_revision,
        sampled_at_ms,
        sample_sequence,
        trees,
        aggregate,
        session_process_owner,
    })
}

fn empty_aggregate() -> AggregateCounters {
    AggregateCounters {
        pss_bytes: Metric::measured(0),
        rss_bytes: Metric::measured(0),
        cpu_ns: Metric::measured(0),
        thread_count: Metric::measured(0),
        fd_count: Metric::measured(0),
        private_bytes: Metric::measured(0),
    }
}

fn metric_json(metric: &Metric<u128>) -> serde_json::Value {
    use serde_json::json;
    match metric {
        Metric::Measured(value) => json!({"quality":"MEASURED","value":value.to_string()}),
        Metric::Unknown(reason) => {
            json!({"quality":"UNKNOWN","reason":unknown_reason_label(reason)})
        }
    }
}

fn unknown_reason_label(reason: &UnknownReason) -> &'static str {
    match reason {
        UnknownReason::Unsupported => "UNSUPPORTED",
        UnknownReason::PermissionDenied => "PERMISSION_DENIED",
        UnknownReason::Exited => "EXITED",
        UnknownReason::IdentityChanged => "IDENTITY_CHANGED",
        UnknownReason::Unavailable => "UNAVAILABLE",
        UnknownReason::Malformed => "MALFORMED",
        UnknownReason::BudgetExceeded => "BUDGET_EXCEEDED",
        UnknownReason::AttributionConflict => "ATTRIBUTION_CONFLICT",
    }
}

fn tree_quality(sample: &TreeSample) -> &'static str {
    if !sample.truncated
        && matches!(&sample.metrics.pss_bytes, Metric::Measured(_))
        && matches!(&sample.metrics.rss_bytes, Metric::Measured(_))
        && matches!(&sample.metrics.cpu_ns, Metric::Measured(_))
        && matches!(&sample.metrics.thread_count, Metric::Measured(_))
        && matches!(&sample.metrics.fd_count, Metric::Measured(_))
    {
        "MEASURED"
    } else {
        "UNKNOWN"
    }
}

fn reservation_state_label(state: crate::resource_budget::ReservationState) -> &'static str {
    use crate::resource_budget::ReservationState;
    match state {
        ReservationState::Proposed => "PROPOSED",
        ReservationState::Reserved => "RESERVED",
        ReservationState::Claimed => "CLAIMED",
        ReservationState::ReleasePending => "RELEASE_PENDING",
        ReservationState::Quarantined => "QUARANTINED",
        ReservationState::Released => "RELEASED",
        ReservationState::Expired => "EXPIRED",
    }
}

fn merge_aggregate(target: &mut AggregateCounters, source: &AggregateCounters) {
    add_metric(&mut target.pss_bytes, source.pss_bytes.clone());
    add_metric(&mut target.rss_bytes, source.rss_bytes.clone());
    add_metric(&mut target.cpu_ns, source.cpu_ns.clone());
    add_metric(&mut target.thread_count, source.thread_count.clone());
    add_metric(&mut target.fd_count, source.fd_count.clone());
    add_metric(&mut target.private_bytes, source.private_bytes.clone());
}

fn verify_ancestry<B: ProcessBackend>(
    backend: &mut B,
    ancestors: &[ProcessIdentity],
    process: &ProcessIdentity,
    work: &mut usize,
    budget: SampleBudget,
) -> Result<(), UnknownReason> {
    if ancestors.is_empty() {
        return Ok(());
    }

    let mut lineage = ancestors.to_vec();
    lineage.push(process.clone());
    for edge in lineage.windows(2) {
        let children = backend.children(&edge[0])?;
        *work = work.saturating_add(children.len());
        if work.saturating_add(backend.work_consumed()) > budget.max_work
            || backend.bytes_consumed() > budget.max_bytes
        {
            return Err(UnknownReason::BudgetExceeded);
        }
        if !children.iter().any(|child| child == &edge[1]) {
            return Err(UnknownReason::IdentityChanged);
        }
    }
    Ok(())
}

fn unknown_tree(reason: UnknownReason) -> TreeSample {
    TreeSample {
        process_count: 0,
        metrics: AggregateCounters {
            pss_bytes: Metric::unknown(reason.clone()),
            rss_bytes: Metric::unknown(reason.clone()),
            cpu_ns: Metric::unknown(reason.clone()),
            thread_count: Metric::unknown(reason.clone()),
            fd_count: Metric::unknown(reason.clone()),
            private_bytes: Metric::unknown(reason),
        },
        truncated: false,
        processes: Vec::new(),
    }
}

fn set_all_unknown(metrics: &mut AggregateCounters, reason: UnknownReason) {
    metrics.pss_bytes = Metric::unknown(reason.clone());
    metrics.rss_bytes = Metric::unknown(reason.clone());
    metrics.cpu_ns = Metric::unknown(reason.clone());
    metrics.thread_count = Metric::unknown(reason.clone());
    metrics.fd_count = Metric::unknown(reason.clone());
    metrics.private_bytes = Metric::unknown(reason);
}

fn add_metric(target: &mut Metric<u128>, source: Metric<u128>) {
    let current = std::mem::replace(target, Metric::unknown(UnknownReason::Unavailable));
    *target = match (current, source) {
        (Metric::Measured(left), Metric::Measured(right)) => left
            .checked_add(right)
            .map(Metric::Measured)
            .unwrap_or(Metric::Unknown(UnknownReason::Malformed)),
        (Metric::Unknown(reason), _) | (_, Metric::Unknown(reason)) => Metric::Unknown(reason),
    };
}

fn merge(target: &mut AggregateCounters, source: CounterSet) {
    add_metric(&mut target.pss_bytes, source.pss_bytes);
    add_metric(&mut target.rss_bytes, source.rss_bytes);
    add_metric(&mut target.cpu_ns, source.cpu_ns);
    add_metric(&mut target.thread_count, source.thread_count);
    add_metric(&mut target.fd_count, source.fd_count);
    add_metric(&mut target.private_bytes, source.private_bytes);
}

#[cfg(target_os = "linux")]
pub struct LinuxProcBackend {
    proc_root: std::path::PathBuf,
    clock_ticks: u128,
    byte_limit: usize,
    bytes_read: usize,
    work_limit: usize,
    work_used: usize,
}

#[cfg(target_os = "linux")]
impl LinuxProcBackend {
    pub fn system() -> Self {
        Self {
            proc_root: "/proc".into(),
            clock_ticks: unsafe { libc::sysconf(libc::_SC_CLK_TCK) }.max(1) as u128,
            byte_limit: DEFAULT_MAX_BYTES,
            bytes_read: 0,
            work_limit: DEFAULT_MAX_WORK,
            work_used: 0,
        }
    }

    fn charge_work(&mut self) -> Result<(), UnknownReason> {
        if self.work_used >= self.work_limit {
            return Err(UnknownReason::BudgetExceeded);
        }
        self.work_used += 1;
        Ok(())
    }

    fn read_source(&mut self, path: &std::path::Path) -> Result<String, UnknownReason> {
        self.charge_work()?;
        let remaining = self.byte_limit.saturating_sub(self.bytes_read);
        if remaining == 0 {
            return Err(UnknownReason::BudgetExceeded);
        }
        let cap = remaining.min(DEFAULT_MAX_BYTES);
        let text = match bounded_read(path, cap) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {
                self.bytes_read = self.bytes_read.saturating_add(cap);
                return Err(UnknownReason::BudgetExceeded);
            }
            Err(error) if error.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(UnknownReason::PermissionDenied);
            }
            Err(_) => return Err(UnknownReason::Unavailable),
        };
        self.bytes_read = self.bytes_read.saturating_add(text.len());
        Ok(text)
    }

    fn stat(&mut self, pid: u32) -> Result<(u32, u64, u128), UnknownReason> {
        let path = self.proc_root.join(pid.to_string()).join("stat");
        let text = self.read_source(&path)?;
        let close = text.rfind(')').ok_or(UnknownReason::Malformed)?;
        let fields: Vec<&str> = text
            .get(close + 2..)
            .ok_or(UnknownReason::Malformed)?
            .split_whitespace()
            .collect();
        if fields.len() <= 19 {
            return Err(UnknownReason::Malformed);
        }
        let parent = fields[1].parse().map_err(|_| UnknownReason::Malformed)?;
        let utime: u128 = fields[11].parse().map_err(|_| UnknownReason::Malformed)?;
        let stime: u128 = fields[12].parse().map_err(|_| UnknownReason::Malformed)?;
        let start = fields[19].parse().map_err(|_| UnknownReason::Malformed)?;
        let cpu_ns = (utime + stime).saturating_mul(1_000_000_000) / self.clock_ticks;
        Ok((parent, start, cpu_ns))
    }
}

#[cfg(target_os = "linux")]
impl ProcessBackend for LinuxProcBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason> {
        let (_, start, _) = self.stat(pid)?;
        Ok(ProcessIdentity::new(pid, start))
    }

    fn children(
        &mut self,
        parent: &ProcessIdentity,
    ) -> Result<Vec<ProcessIdentity>, UnknownReason> {
        if self.identity(parent.pid)? != *parent {
            return Err(UnknownReason::IdentityChanged);
        }
        self.charge_work()?;
        let task_root = self.proc_root.join(parent.pid.to_string()).join("task");
        let tasks = std::fs::read_dir(&task_root).map_err(|error| {
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                UnknownReason::PermissionDenied
            } else {
                UnknownReason::Unavailable
            }
        })?;
        let mut seen = HashSet::new();
        let mut result = Vec::new();
        let mut tasks = tasks;
        loop {
            if self.work_used >= self.work_limit {
                return Err(UnknownReason::BudgetExceeded);
            }
            let Some(task) = tasks.next() else { break };
            self.work_used += 1;
            let task = task.map_err(|_| UnknownReason::Unavailable)?;
            let tid = task
                .file_name()
                .to_string_lossy()
                .parse::<u32>()
                .map_err(|_| UnknownReason::Malformed)?;
            let path = task_root.join(tid.to_string()).join("children");
            let child_data = self.read_source(&path)?;
            let mut child_values = child_data.split_whitespace();
            loop {
                if self.work_used >= self.work_limit {
                    return Err(UnknownReason::BudgetExceeded);
                }
                let Some(value) = child_values.next() else {
                    break;
                };
                self.work_used += 1;
                let child: u32 = value.parse().map_err(|_| UnknownReason::Malformed)?;
                if seen.insert(child) {
                    let (actual_parent, start, _) = self.stat(child)?;
                    if actual_parent != parent.pid {
                        return Err(UnknownReason::IdentityChanged);
                    }
                    result.push(ProcessIdentity::new(child, start));
                }
            }
        }
        let verify_allowance = self.work_limit.saturating_sub(self.work_used);
        if result.len().saturating_add(1) > verify_allowance {
            return Err(UnknownReason::BudgetExceeded);
        }
        for child in &result {
            let (actual_parent, start, _) = self.stat(child.pid)?;
            if actual_parent != parent.pid || start != child.start_identity {
                return Err(UnknownReason::IdentityChanged);
            }
        }
        if self.identity(parent.pid)? != *parent {
            return Err(UnknownReason::IdentityChanged);
        }
        Ok(result)
    }

    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet {
        let base = self.proc_root.join(identity.pid.to_string());
        let (pss, private_bytes) = match self.read_source(&base.join("smaps_rollup")) {
            Ok(data) => (
                parse_smaps_pss_bytes(&data),
                parse_smaps_private_bytes(&data),
            ),
            Err(reason) => (Metric::unknown(reason.clone()), Metric::unknown(reason)),
        };
        let status_path = base.join("status");
        let status = self.read_source(&status_path);
        let (rss, threads) = match status {
            Ok(data) => (
                data.lines()
                    .find_map(|line| {
                        line.strip_prefix("VmRSS:")?
                            .split_whitespace()
                            .next()?
                            .parse::<u128>()
                            .ok()
                    })
                    .map(|kb| Metric::measured(kb * 1024))
                    .unwrap_or(Metric::unknown(UnknownReason::Malformed)),
                data.lines()
                    .find_map(|line| {
                        line.strip_prefix("Threads:")?
                            .split_whitespace()
                            .next()?
                            .parse::<u128>()
                            .ok()
                    })
                    .map(Metric::measured)
                    .unwrap_or(Metric::unknown(UnknownReason::Malformed)),
            ),
            Err(reason) => (Metric::unknown(reason.clone()), Metric::unknown(reason)),
        };
        let fd_path = base.join("fd");
        let fd_count = match self.charge_work().and_then(|_| {
            std::fs::read_dir(fd_path).map_err(|error| {
                if error.kind() == std::io::ErrorKind::PermissionDenied {
                    UnknownReason::PermissionDenied
                } else {
                    UnknownReason::Unavailable
                }
            })
        }) {
            Ok(entries) => {
                let mut count = 0u128;
                let mut failure = None;
                let allowance = self.work_limit.saturating_sub(self.work_used);
                if allowance == 0 {
                    failure = Some(UnknownReason::BudgetExceeded);
                } else {
                    let mut item_count = 0usize;
                    for entry in entries.take(allowance) {
                        self.work_used += 1;
                        item_count += 1;
                        if entry.is_err() {
                            failure = Some(UnknownReason::Unavailable);
                            break;
                        }
                        count += 1;
                    }
                    if item_count == allowance {
                        failure = Some(UnknownReason::BudgetExceeded);
                    }
                }
                failure
                    .map(Metric::unknown)
                    .unwrap_or(Metric::measured(count))
            }
            Err(reason) => Metric::unknown(reason),
        };
        let cpu_ns = match self.stat(identity.pid) {
            Ok((_, _, ns)) => Metric::measured(ns),
            Err(reason) => Metric::Unknown(reason),
        };
        CounterSet {
            pss_bytes: pss,
            rss_bytes: rss,
            cpu_ns,
            thread_count: threads,
            fd_count,
            private_bytes,
        }
    }

    fn begin_sample(&mut self, max_bytes: usize, max_work: usize) {
        self.byte_limit = max_bytes.min(DEFAULT_MAX_BYTES);
        self.bytes_read = 0;
        self.work_limit = max_work.min(DEFAULT_MAX_WORK);
        self.work_used = 0;
    }

    fn bytes_consumed(&self) -> usize {
        self.bytes_read
    }
    fn work_consumed(&self) -> usize {
        self.work_used
    }
}

#[cfg(target_os = "linux")]
fn smaps_kb_field(data: &str, name: &str) -> Option<u128> {
    data.lines().find_map(|line| {
        line.strip_prefix(name)?
            .split_whitespace()
            .next()?
            .parse::<u128>()
            .ok()
    })
}

/// Linux PSS from `smaps_rollup`. A missing or malformed field is UNKNOWN, never 0 and never RSS.
#[cfg(target_os = "linux")]
fn parse_smaps_pss_bytes(data: &str) -> Metric<u128> {
    smaps_kb_field(data, "Pss:")
        .and_then(|kb| kb.checked_mul(1024))
        .map(Metric::measured)
        .unwrap_or(Metric::Unknown(UnknownReason::Malformed))
}

/// Linux private resident bytes from `smaps_rollup` (`Private_Clean + Private_Dirty +
/// Private_Hugetlb`). This is a separate, explicitly labeled method from PSS/RSS; any missing
/// field is UNKNOWN rather than an under-counted partial sum.
#[cfg(target_os = "linux")]
fn parse_smaps_private_bytes(data: &str) -> Metric<u128> {
    let mut total = 0u128;
    for field in ["Private_Clean:", "Private_Dirty:", "Private_Hugetlb:"] {
        let Some(kb) = smaps_kb_field(data, field) else {
            return Metric::Unknown(UnknownReason::Malformed);
        };
        let Some(sum) = kb
            .checked_mul(1024)
            .and_then(|bytes| total.checked_add(bytes))
        else {
            return Metric::Unknown(UnknownReason::Malformed);
        };
        total = sum;
    }
    Metric::measured(total)
}

#[cfg(target_os = "linux")]
fn bounded_read(path: &std::path::Path, limit: usize) -> std::io::Result<String> {
    use std::io::Read;
    let mut bytes = Vec::with_capacity(limit.min(16 * 1024));
    std::fs::File::open(path)?
        .take(limit as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() == limit {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "proc file reached sampler byte budget",
        ));
    }
    String::from_utf8(bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))
}

#[cfg(target_os = "windows")]
pub struct WindowsHandleBackend {
    owner: ProcessIdentity,
}

#[cfg(target_os = "windows")]
impl WindowsHandleBackend {
    pub fn new(owner: ProcessIdentity) -> Self {
        Self { owner }
    }
    fn handle_identity(&self) -> Result<ProcessIdentity, UnknownReason> {
        if self.owner.process_handle == 0 {
            return Err(UnknownReason::Unavailable);
        }
        let handle = self.owner.process_handle as *mut core::ffi::c_void;
        let mut creation = FileTime { low: 0, high: 0 };
        let mut exit = FileTime { low: 0, high: 0 };
        let mut kernel = FileTime { low: 0, high: 0 };
        let mut user = FileTime { low: 0, high: 0 };
        let ok =
            unsafe { GetProcessTimes(handle, &mut creation, &mut exit, &mut kernel, &mut user) };
        let pid = unsafe { GetProcessId(handle) };
        if ok == 0 || pid == 0 {
            return Err(UnknownReason::Exited);
        }
        Ok(ProcessIdentity::with_handle(
            pid,
            (u64::from(creation.high) << 32) | u64::from(creation.low),
            self.owner.process_handle,
        ))
    }
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}

#[cfg(target_os = "windows")]
#[repr(C)]
struct ProcessMemoryCountersEx {
    cb: u32,
    page_fault_count: u32,
    peak_working_set_size: usize,
    working_set_size: usize,
    quota_peak_paged_pool_usage: usize,
    quota_paged_pool_usage: usize,
    quota_peak_non_paged_pool_usage: usize,
    quota_non_paged_pool_usage: usize,
    pagefile_usage: usize,
    peak_pagefile_usage: usize,
    private_usage: usize,
}

#[cfg(target_os = "windows")]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetProcessId(process: *mut core::ffi::c_void) -> u32;
    fn GetProcessTimes(
        process: *mut core::ffi::c_void,
        creation: *mut FileTime,
        exit: *mut FileTime,
        kernel: *mut FileTime,
        user: *mut FileTime,
    ) -> i32;
}

#[cfg(target_os = "windows")]
#[link(name = "psapi")]
unsafe extern "system" {
    fn GetProcessMemoryInfo(
        process: *mut core::ffi::c_void,
        counters: *mut ProcessMemoryCountersEx,
        size: u32,
    ) -> i32;
}

#[cfg(target_os = "windows")]
impl ProcessBackend for WindowsHandleBackend {
    fn identity(&mut self, pid: u32) -> Result<ProcessIdentity, UnknownReason> {
        if pid != self.owner.pid {
            return Err(UnknownReason::Unsupported);
        }
        self.handle_identity()
    }
    fn children(
        &mut self,
        _parent: &ProcessIdentity,
    ) -> Result<Vec<ProcessIdentity>, UnknownReason> {
        Err(UnknownReason::Unsupported)
    }
    fn counters(&mut self, identity: &ProcessIdentity) -> CounterSet {
        let mut counters = ProcessMemoryCountersEx {
            cb: std::mem::size_of::<ProcessMemoryCountersEx>() as u32,
            page_fault_count: 0,
            peak_working_set_size: 0,
            working_set_size: 0,
            quota_peak_paged_pool_usage: 0,
            quota_paged_pool_usage: 0,
            quota_peak_non_paged_pool_usage: 0,
            quota_non_paged_pool_usage: 0,
            pagefile_usage: 0,
            peak_pagefile_usage: 0,
            private_usage: 0,
        };
        let handle = identity.process_handle as *mut core::ffi::c_void;
        let size = counters.cb;
        let ok = unsafe { GetProcessMemoryInfo(handle, &mut counters, size) };
        let mut result = CounterSet::unknown(if ok == 0 {
            UnknownReason::Unavailable
        } else {
            UnknownReason::Unsupported
        });
        if ok != 0 {
            result.private_bytes = Metric::measured(counters.private_usage as u128);
        }
        result
    }
}

#[cfg(all(test, target_os = "linux"))]
mod linux_backend_tests {
    use super::*;
    use std::{
        fs,
        path::PathBuf,
        process::Command,
        time::{Duration, Instant, SystemTime, UNIX_EPOCH},
    };

    struct TempProcRoot(PathBuf);

    impl TempProcRoot {
        fn new() -> Self {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("clock before unix epoch")
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "horizoncode-resource-sampler-{}-{nonce}",
                std::process::id()
            ));
            fs::create_dir_all(&path).expect("create fake proc root");
            Self(path)
        }
    }

    impl Drop for TempProcRoot {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn linux_backend_measures_private_bytes_from_smaps_rollup() {
        let proc_root = TempProcRoot::new();
        let process_root = proc_root.0.join("123");
        fs::create_dir_all(process_root.join("fd")).expect("create fake fd directory");

        let mut fields = vec!["0"; 20];
        fields[0] = "S";
        fields[1] = "1";
        fields[11] = "3";
        fields[12] = "4";
        fields[19] = "77";
        fs::write(
            process_root.join("stat"),
            format!("123 (horizoncode-sampler) {}\n", fields.join(" ")),
        )
        .expect("write fake stat");
        fs::write(process_root.join("status"), "VmRSS: 20 kB\nThreads: 1\n")
            .expect("write fake status");
        fs::write(
            process_root.join("smaps_rollup"),
            "Pss: 10 kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\nPrivate_Hugetlb: 1 kB\n",
        )
        .expect("write fake smaps rollup");

        let mut backend = LinuxProcBackend {
            proc_root: proc_root.0.clone(),
            clock_ticks: 100,
            byte_limit: DEFAULT_MAX_BYTES,
            bytes_read: 0,
            work_limit: DEFAULT_MAX_WORK,
            work_used: 0,
        };
        let counters = backend.counters(&ProcessIdentity::new(123, 77));

        assert_eq!(counters.pss_bytes, Metric::measured(10 * 1024));
        assert_eq!(counters.private_bytes, Metric::measured(6 * 1024));
    }

    #[test]
    fn linux_backend_private_bytes_never_fabricates_partial_sums() {
        let proc_root = TempProcRoot::new();

        // PSS present but hugetlb missing: private bytes stay UNKNOWN, PSS is independent.
        let partial = proc_root.0.join("124");
        fs::create_dir_all(&partial).expect("create fake proc dir");
        fs::write(
            partial.join("smaps_rollup"),
            "Pss: 10 kB\nPrivate_Clean: 2 kB\nPrivate_Dirty: 3 kB\n",
        )
        .expect("write fake smaps rollup");
        let mut backend = LinuxProcBackend {
            proc_root: proc_root.0.clone(),
            clock_ticks: 100,
            byte_limit: DEFAULT_MAX_BYTES,
            bytes_read: 0,
            work_limit: DEFAULT_MAX_WORK,
            work_used: 0,
        };
        let counters = backend.counters(&ProcessIdentity::new(124, 78));
        assert_eq!(counters.pss_bytes, Metric::measured(10 * 1024));
        assert_eq!(
            counters.private_bytes,
            Metric::unknown(UnknownReason::Malformed)
        );

        // Unreadable smaps: both are UNKNOWN with the read reason, never a fabricated zero.
        let counters = backend.counters(&ProcessIdentity::new(125, 79));
        assert_eq!(
            counters.pss_bytes,
            Metric::unknown(UnknownReason::Unavailable)
        );
        assert_eq!(
            counters.private_bytes,
            Metric::unknown(UnknownReason::Unavailable)
        );

        // Private fields present but PSS missing: PSS stays UNKNOWN, private remains measured.
        let no_pss = proc_root.0.join("126");
        fs::create_dir_all(&no_pss).expect("create fake proc dir");
        fs::write(
            no_pss.join("smaps_rollup"),
            "Private_Clean: 1 kB\nPrivate_Dirty: 1 kB\nPrivate_Hugetlb: 0 kB\n",
        )
        .expect("write fake smaps rollup");
        let counters = backend.counters(&ProcessIdentity::new(126, 80));
        assert_eq!(
            counters.pss_bytes,
            Metric::unknown(UnknownReason::Malformed)
        );
        assert_eq!(counters.private_bytes, Metric::measured(2 * 1024));
    }

    #[test]
    fn smaps_parsers_reject_malformed_and_overflowing_values() {
        assert_eq!(
            parse_smaps_pss_bytes("Pss: not-a-number kB\n"),
            Metric::unknown(UnknownReason::Malformed)
        );
        assert_eq!(
            parse_smaps_pss_bytes("Rss: 1 kB\n"),
            Metric::unknown(UnknownReason::Malformed)
        );
        assert_eq!(
            parse_smaps_private_bytes("Private_Clean: 1 kB\nPrivate_Dirty: 2 kB\n"),
            Metric::unknown(UnknownReason::Malformed)
        );
        let overflowing = format!(
            "Private_Clean: {} kB\nPrivate_Dirty: 0 kB\nPrivate_Hugetlb: 0 kB\n",
            u128::MAX / 1024 + 1
        );
        assert_eq!(
            parse_smaps_private_bytes(&overflowing),
            Metric::unknown(UnknownReason::Malformed)
        );
        let overflowing_pss = format!("Pss: {} kB\n", u128::MAX / 1024 + 1);
        assert_eq!(
            parse_smaps_pss_bytes(&overflowing_pss),
            Metric::unknown(UnknownReason::Malformed)
        );
    }

    #[test]
    fn linux_backend_tracks_a_real_owned_process_tree_until_release() {
        // Real /proc integration: own a bounded bash+sleep tree, fence both PIDs by start
        // identity, sample them, then prove the identity no longer matches after reaping.
        // The owner is this test's own child, so sibling lib tests that spawn their own
        // children cannot be misattributed into the sampled tree.
        let mut shell = Command::new("bash")
            .arg("-c")
            .arg("sleep 30 & wait")
            .spawn()
            .expect("spawn owned bash tree");
        let mut backend = LinuxProcBackend::system();
        let owner = backend
            .identity(shell.id())
            .expect("read owned bash identity");

        let deadline = Instant::now() + Duration::from_secs(5);
        let descendant = loop {
            match backend.children(&owner) {
                Ok(children) if !children.is_empty() => break children[0].clone(),
                _ if Instant::now() >= deadline => {
                    let _ = shell.kill();
                    let _ = shell.wait();
                    panic!("owned sleep descendant did not appear");
                }
                _ => std::thread::sleep(Duration::from_millis(20)),
            }
        };

        let counters = sample_owned_process(&mut backend, descendant.clone())
            .expect("sample owned descendant");
        assert!(matches!(counters.pss_bytes, Metric::Measured(value) if value > 0));
        assert!(matches!(counters.rss_bytes, Metric::Measured(value) if value > 0));
        assert!(matches!(counters.cpu_ns, Metric::Measured(_)));
        assert!(matches!(counters.fd_count, Metric::Measured(_)));
        assert!(
            !matches!(
                counters.private_bytes,
                Metric::Unknown(UnknownReason::IdentityChanged)
            ),
            "a live owned descendant must not be misreported as PID reuse"
        );

        let sample = sample_owned_tree(&mut backend, owner.clone(), SampleBudget::default())
            .expect("sample owned tree");
        assert!(!sample.truncated);
        assert!(
            sample
                .processes
                .iter()
                .any(|process| process.pid == owner.pid)
        );
        assert!(
            sample
                .processes
                .iter()
                .any(|process| process.pid == descendant.pid)
        );
        assert!(matches!(sample.metrics.rss_bytes, Metric::Measured(value) if value > 0));
        assert!(matches!(sample.metrics.thread_count, Metric::Measured(value) if value > 0));

        unsafe { libc::kill(descendant.pid as i32, libc::SIGKILL) };
        let _ = shell.kill();
        let _ = shell.wait();
        let after = backend.identity(owner.pid);
        assert!(match after {
            Ok(identity) => identity != owner,
            Err(_) => true,
        });
    }
}
