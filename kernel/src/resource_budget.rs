//! Conservative, deterministic resource headroom calculation.
//!
//! This is a pure admission *input*, not a permission check, worker lease,
//! OS sampler, executor, or live ResourcePolicyV1 service. OS quota discovery,
//! sample trust/process identity and atomic lease accounting remain separate
//! work. Missing effective capacity must never mean infinite free resources.
//! [`PressureState::evaluate`] is a derived control hint with the same
//! boundary: it never authorizes or performs termination, eviction or launch.

use std::collections::{BTreeMap, HashMap};

/// Mirrors the single §11.20 reservation lifecycle; no ACTIVE/UNKNOWN aliases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationState {
    Proposed,
    Reserved,
    Claimed,
    ReleasePending,
    Quarantined,
    Released,
    Expired,
}

/// Pure transition guard for §11.20. This checks proof flags only; the
/// authenticated Rust owner must obtain the underlying process/receipt evidence
/// and atomically persist the transition against the expected owner epoch.
/// No caller may use this helper itself as proof that a process exited.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ReservationProof {
    pub no_launch_or_dispatch: bool,
    pub owned_process_exited: bool,
    pub effects_settled: bool,
    pub reconciliation_complete: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ReservationTransitionError {
    ForbiddenTransition,
    MissingProof,
}

impl ReservationState {
    /// A closed transition relation. Staying in the same state is handled as
    /// an idempotent replay by the owner log, not as a new state transition.
    pub fn validate_transition(
        self,
        next: Self,
        proof: ReservationProof,
    ) -> Result<(), ReservationTransitionError> {
        use ReservationState::{
            Claimed, Expired, Proposed, Quarantined, ReleasePending, Released, Reserved,
        };
        use ReservationTransitionError::{ForbiddenTransition, MissingProof};

        let permitted = match (self, next) {
            (Proposed, Reserved) | (Reserved, Claimed) => true,
            (Reserved, Expired) => proof.no_launch_or_dispatch,
            (Claimed, ReleasePending) => true,
            (Claimed, Quarantined) | (ReleasePending, Quarantined) => true,
            (Quarantined, ReleasePending) => proof.reconciliation_complete,
            (ReleasePending, Released) => proof.owned_process_exited && proof.effects_settled,
            _ => return Err(ForbiddenTransition),
        };
        if permitted { Ok(()) } else { Err(MissingProof) }
    }
}

/// One owner reservation for one budget dimension and accounting epoch.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Reservation {
    pub state: ReservationState,
    pub reserved_units: u64,
    /// Only supply Some(value) if the OS sampler verified this owner/process
    /// generation and the value is already in measured_total exactly once.
    /// Missing, stale, uncertain or un-attributed measurements must be None.
    pub already_counted_units: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Capacity {
    /// No trusted hard limit: do not admit a new costly worker.
    UnknownCapacity,
    /// All values use the caller's same dimension/unit and sampling epoch.
    Remaining(u64),
}

impl Reservation {
    /// Outstanding headroom beyond units already counted in measured_total.
    /// Unknown usage retains the full conservative reservation.
    pub fn outstanding_units(self) -> u64 {
        match self.state {
            ReservationState::Proposed | ReservationState::Released | ReservationState::Expired => {
                0
            }
            ReservationState::Reserved => self.reserved_units,
            ReservationState::Claimed
            | ReservationState::ReleasePending
            | ReservationState::Quarantined => self
                .reserved_units
                .saturating_sub(self.already_counted_units.unwrap_or(0)),
        }
    }
}

/// Computes §18.18 remaining(d) without double-debit or u64 subtraction wrap.
///
/// The caller must attribute shared services once globally, keep worker
/// measurements from the same trusted epoch and preserve unresolved leases.
/// A Remaining amount is *not* a Guard approval or worker launch permission.
pub fn remaining_capacity(
    effective_hard_limit: Option<u64>,
    measured_total: u64,
    safety_reserve: u64,
    reservations: &[Reservation],
) -> Capacity {
    let Some(hard_limit) = effective_hard_limit else {
        return Capacity::UnknownCapacity;
    };
    let reserved_headroom = reservations.iter().fold(0u128, |sum, reservation| {
        sum.saturating_add(u128::from(reservation.outstanding_units()))
    });
    let charged = u128::from(measured_total)
        .saturating_add(u128::from(safety_reserve))
        .saturating_add(reserved_headroom);
    Capacity::Remaining(u128::from(hard_limit).saturating_sub(charged) as u64)
}

/// §11.20/§18.18 canonical pressure states, without `SOFT`/`HARD` aliases.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PressureState {
    Normal,
    SoftPressure,
    HardPressure,
    Recovering,
}

/// Trusted limits for the observed dimension in one sampling epoch. `None` means the effective
/// limit is unknown: new costly worker admission is blocked through
/// [`Capacity::UnknownCapacity`]; this module must not invent a threshold from a missing limit.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PressureLimits {
    pub soft: Option<u64>,
    pub hard: Option<u64>,
}

/// One bounded observation for [`PressureState::evaluate`]. The caller must own the reading
/// history and set `sustained_calm` only after the configured lower watermark held across the
/// calibrated hysteresis window; a single calm reading must not clear pressure by itself.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct PressureObservation {
    pub limits: PressureLimits,
    /// Trusted same-epoch usage for the observed dimension. Hard admission additionally considers
    /// outstanding reservations through [`remaining_capacity`]; this helper only evaluates the
    /// configured caps and the OS alarm the caller supplies.
    pub measured_usage: u64,
    /// OS quota alarm (cgroup v2/Job Object/task limit) independent of configured limits.
    pub os_quota_alarm: bool,
    pub sustained_calm: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum PressureControllerErrorV1 {
    InvalidConfiguration,
    StaleOwnerEpoch,
    StaleSample,
}

/// Bounded in-memory hysteresis over authenticated, monotonic resource samples.
/// It is a derived scheduling hint only. OwnerLog durability and a trusted
/// HostKernel/Core ingress are separate requirements; resetting this controller
/// never manufactures a calm history or opens worker fan-out.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ResourcePressureControllerV1 {
    limits: PressureLimits,
    lower_watermark: u64,
    required_calm_samples: u16,
    calm_samples: u16,
    owner_epoch: u64,
    last_sample_sequence: u64,
    state: PressureState,
}

impl ResourcePressureControllerV1 {
    pub(crate) fn new(
        limits: PressureLimits,
        lower_watermark: u64,
        required_calm_samples: u16,
        owner_epoch: u64,
    ) -> Result<Self, PressureControllerErrorV1> {
        let Some(recovery_ceiling) = limits.soft.or(limits.hard) else {
            return Err(PressureControllerErrorV1::InvalidConfiguration);
        };
        if owner_epoch == 0
            || required_calm_samples == 0
            || required_calm_samples > 1024
            || lower_watermark >= recovery_ceiling
            || limits.hard.zip(limits.soft).is_some_and(|(hard, soft)| hard < soft)
        {
            return Err(PressureControllerErrorV1::InvalidConfiguration);
        }
        Ok(Self {
            limits,
            lower_watermark,
            required_calm_samples,
            calm_samples: 0,
            owner_epoch,
            last_sample_sequence: 0,
            state: PressureState::Normal,
        })
    }

    /// Consume one strictly newer sample from the current authenticated owner
    /// epoch. Unknown usage never de-escalates pressure. A new owner epoch
    /// fences the old hysteresis history and requires a fresh calm window
    /// before leaving pressure recovery.
    pub(crate) fn observe(
        &mut self,
        owner_epoch: u64,
        sample_sequence: u64,
        measured_usage: Option<u64>,
        os_quota_alarm: bool,
    ) -> Result<PressureState, PressureControllerErrorV1> {
        if owner_epoch < self.owner_epoch || owner_epoch == 0 {
            return Err(PressureControllerErrorV1::StaleOwnerEpoch);
        }
        if sample_sequence == 0 {
            return Err(PressureControllerErrorV1::StaleSample);
        }
        if owner_epoch > self.owner_epoch {
            self.owner_epoch = owner_epoch;
            self.last_sample_sequence = 0;
            self.calm_samples = 0;
            self.state = PressureState::Recovering;
        }
        if sample_sequence <= self.last_sample_sequence {
            return Err(PressureControllerErrorV1::StaleSample);
        }
        self.last_sample_sequence = sample_sequence;

        if os_quota_alarm {
            self.calm_samples = 0;
            self.state = PressureState::HardPressure;
            return Ok(self.state);
        }
        let Some(measured_usage) = measured_usage else {
            self.calm_samples = 0;
            return Ok(self.state);
        };
        if measured_usage < self.lower_watermark {
            self.calm_samples = self.calm_samples.saturating_add(1)
                .min(self.required_calm_samples);
        } else {
            self.calm_samples = 0;
        }
        let sustained_calm = self.calm_samples >= self.required_calm_samples;
        self.state = self.state.evaluate(PressureObservation {
            limits: self.limits,
            measured_usage,
            os_quota_alarm: false,
            sustained_calm,
        });
        Ok(self.state)
    }

    pub(crate) fn state(&self) -> PressureState {
        self.state
    }

    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    pub(crate) fn last_sample_sequence(&self) -> u64 {
        self.last_sample_sequence
    }
}

/// Authenticated identity copied from a trusted Rust ingress after principal,
/// workspace, Session, Run, Task, Attempt, and owner epoch validation. It is
/// deliberately opaque to callers; constructing it is not an authentication API.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct AuthenticatedOwnerContext {
    principal_ref: String,
    workspace_binding: String,
    session_id: String,
    run_id: String,
    task_id: String,
    attempt_id: String,
    owner_epoch: u64,
}

impl AuthenticatedOwnerContext {
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn from_verified_ingress(
        principal_ref: String,
        workspace_binding: String,
        session_id: String,
        run_id: String,
        task_id: String,
        attempt_id: String,
        owner_epoch: u64,
    ) -> Result<Self, ResourceOwnerError> {
        let identity = Self {
            principal_ref,
            workspace_binding,
            session_id,
            run_id,
            task_id,
            attempt_id,
            owner_epoch,
        };
        identity.validate()?;
        Ok(identity)
    }

    /// Rebuilds one owner scope from an authenticated durable OwnerLog record
    /// during replay. The persisted record was written by trusted ingress after
    /// its original identity check; this constructor is not an ingress
    /// authentication API and must not be called with caller-supplied strings.
    #[allow(clippy::too_many_arguments)]
    pub(crate) fn rehydrate_from_durable_scope(
        principal_ref: String,
        workspace_binding: String,
        session_id: String,
        run_id: String,
        task_id: String,
        attempt_id: String,
        owner_epoch: u64,
    ) -> Result<Self, ResourceOwnerError> {
        Self::from_verified_ingress(
            principal_ref,
            workspace_binding,
            session_id,
            run_id,
            task_id,
            attempt_id,
            owner_epoch,
        )
    }

    fn validate(&self) -> Result<(), ResourceOwnerError> {
        let values = [
            self.principal_ref.as_str(),
            self.workspace_binding.as_str(),
            self.session_id.as_str(),
            self.run_id.as_str(),
            self.task_id.as_str(),
            self.attempt_id.as_str(),
        ];
        if self.owner_epoch == 0
            || values
                .into_iter()
                .any(|value| value.is_empty() || value.len() > 256)
        {
            return Err(ResourceOwnerError::InvalidIdentity);
        }
        Ok(())
    }

    pub fn principal_ref(&self) -> &str {
        &self.principal_ref
    }

    pub fn workspace_binding(&self) -> &str {
        &self.workspace_binding
    }

    pub fn session_id(&self) -> &str {
        &self.session_id
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn task_id(&self) -> &str {
        &self.task_id
    }

    pub fn attempt_id(&self) -> &str {
        &self.attempt_id
    }

    pub fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    #[cfg(test)]
    pub(crate) fn test_fixture(
        principal_ref: &str,
        workspace_binding: &str,
        session_id: &str,
        run_id: &str,
        task_id: &str,
        attempt_id: &str,
        owner_epoch: u64,
    ) -> Self {
        Self::from_verified_ingress(
            principal_ref.to_owned(),
            workspace_binding.to_owned(),
            session_id.to_owned(),
            run_id.to_owned(),
            task_id.to_owned(),
            attempt_id.to_owned(),
            owner_epoch,
        )
        .expect("test identity must be valid")
    }
}

/// §18.18 quota dimension. Each dimension uses its own exact integer unit.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum BudgetDimension {
    MemoryBytes,
    CpuMillicores,
    Processes,
    FileDescriptors,
    DiskBytes,
    ToolOutputBytes,
    ActiveWorkers,
    Tokens,
    ProviderCostMicros,
}

impl BudgetDimension {
    pub const WIRE_NAMES: [&'static str; 9] = [
        "MEMORY_BYTES",
        "CPU_MILLICORES",
        "PROCESSES",
        "FILE_DESCRIPTORS",
        "DISK_BYTES",
        "TOOL_OUTPUT_BYTES",
        "ACTIVE_WORKERS",
        "TOKENS",
        "PROVIDER_COST_MICROS",
    ];

    pub fn wire_name(self) -> &'static str {
        match self {
            Self::MemoryBytes => "MEMORY_BYTES",
            Self::CpuMillicores => "CPU_MILLICORES",
            Self::Processes => "PROCESSES",
            Self::FileDescriptors => "FILE_DESCRIPTORS",
            Self::DiskBytes => "DISK_BYTES",
            Self::ToolOutputBytes => "TOOL_OUTPUT_BYTES",
            Self::ActiveWorkers => "ACTIVE_WORKERS",
            Self::Tokens => "TOKENS",
            Self::ProviderCostMicros => "PROVIDER_COST_MICROS",
        }
    }

    pub fn parse_wire(value: &str) -> Result<Self, ResourceWireError> {
        match value {
            "MEMORY_BYTES" => Ok(Self::MemoryBytes),
            "CPU_MILLICORES" => Ok(Self::CpuMillicores),
            "PROCESSES" => Ok(Self::Processes),
            "FILE_DESCRIPTORS" => Ok(Self::FileDescriptors),
            "DISK_BYTES" => Ok(Self::DiskBytes),
            "TOOL_OUTPUT_BYTES" => Ok(Self::ToolOutputBytes),
            "ACTIVE_WORKERS" => Ok(Self::ActiveWorkers),
            "TOKENS" => Ok(Self::Tokens),
            "PROVIDER_COST_MICROS" => Ok(Self::ProviderCostMicros),
            _ => Err(ResourceWireError::UnknownDimension),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourceLimitSourceV1 {
    OsQuota,
    User,
    Workspace,
    Run,
    SystemDefault,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourceLimitEnforcementPolicyV1 {
    HardOs,
    AdmissionOnly,
    ObserveOnly,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct EffectiveResourceLimitV1 {
    pub dimension: BudgetDimension,
    pub soft: Option<u64>,
    pub hard: Option<u64>,
    pub source: ResourceLimitSourceV1,
    pub enforcement: ResourceLimitEnforcementPolicyV1,
}

/// One strict row from the P6 projection after HostKernel has authenticated
/// the current Attempt and resolved the exact Config projection. The requested
/// value and UI provenance remain in the projection digest; they are never
/// promoted into effective authority here.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthenticatedResourcePolicyRowV1 {
    pub dimension: BudgetDimension,
    pub effective: Option<EffectiveResourceLimitV1>,
    pub enforcement: ResourceLimitEnforcementPolicyV1,
}

/// Opaque HostKernel-minted policy projection for one exact authenticated
/// Attempt/owner epoch. It is an immutable pin, not a global resource-policy
/// registry. Only effective HARD_OS/ADMISSION_ONLY limits can contribute to
/// resource admission; absent and OBSERVE_ONLY/UNSUPPORTED limits remain
/// unknown. P8 never accepts raw settings or caller-supplied owner fields.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthenticatedResourcePolicyPinV1 {
    owner: AuthenticatedOwnerContext,
    projection_revision: u64,
    projection_digest: String,
    rows: BTreeMap<BudgetDimension, AuthenticatedResourcePolicyRowV1>,
}

impl AuthenticatedResourcePolicyPinV1 {
    pub(crate) fn from_host_kernel(
        owner: AuthenticatedOwnerContext,
        projection_revision: u64,
        projection_digest: String,
        rows: Vec<AuthenticatedResourcePolicyRowV1>,
    ) -> Result<Self, ResourcePolicyPinErrorV1> {
        const DIMENSIONS: [BudgetDimension; 9] = [
            BudgetDimension::MemoryBytes,
            BudgetDimension::CpuMillicores,
            BudgetDimension::Processes,
            BudgetDimension::FileDescriptors,
            BudgetDimension::DiskBytes,
            BudgetDimension::ToolOutputBytes,
            BudgetDimension::ActiveWorkers,
            BudgetDimension::Tokens,
            BudgetDimension::ProviderCostMicros,
        ];
        if projection_revision == 0
            || !valid_blake3_digest(&projection_digest)
            || rows.len() != DIMENSIONS.len()
        {
            return Err(ResourcePolicyPinErrorV1::InvalidProjection);
        }
        owner.validate().map_err(|_| ResourcePolicyPinErrorV1::InvalidOwner)?;
        let mut indexed = BTreeMap::new();
        for row in rows {
            let valid_effective = match row.effective.as_ref() {
                Some(effective) => {
                    effective.dimension == row.dimension
                        && !effective.hard.zip(effective.soft).is_some_and(|(hard, soft)| hard < soft)
                        && effective.enforcement == row.enforcement
                        // The enforcement label and its source are a single
                        // HostKernel assertion. Do not let an admission-only
                        // settings cap masquerade as an installed OS quota,
                        // or accept an OS quota label without OS provenance.
                        && match effective.enforcement {
                            ResourceLimitEnforcementPolicyV1::HardOs => {
                                effective.source == ResourceLimitSourceV1::OsQuota
                                    && effective.hard.is_some_and(|hard| hard > 0)
                            }
                            ResourceLimitEnforcementPolicyV1::AdmissionOnly => {
                                effective.source != ResourceLimitSourceV1::OsQuota
                            }
                            ResourceLimitEnforcementPolicyV1::ObserveOnly
                            | ResourceLimitEnforcementPolicyV1::Unsupported => true,
                        }
                }
                None => row.enforcement == ResourceLimitEnforcementPolicyV1::Unsupported,
            };
            if !DIMENSIONS.contains(&row.dimension)
                || !valid_effective
                || indexed.insert(row.dimension, row).is_some()
            {
                return Err(ResourcePolicyPinErrorV1::InvalidProjection);
            }
        }
        if DIMENSIONS.iter().any(|dimension| !indexed.contains_key(dimension)) {
            return Err(ResourcePolicyPinErrorV1::InvalidProjection);
        }
        Ok(Self { owner, projection_revision, projection_digest, rows: indexed })
    }

    pub(crate) fn matches_owner(&self, owner: &AuthenticatedOwnerContext) -> bool {
        &self.owner == owner
    }

    pub(crate) fn projection_revision(&self) -> u64 {
        self.projection_revision
    }

    pub(crate) fn projection_digest(&self) -> &str {
        &self.projection_digest
    }

    pub(crate) fn row(
        &self,
        dimension: BudgetDimension,
    ) -> Option<&AuthenticatedResourcePolicyRowV1> {
        self.rows.get(&dimension)
    }

    /// Only verified OS hard limits and explicit admission-only caps may
    /// constrain worker admission. Observation-only/unsupported settings and
    /// P2-owned token/cost dimensions never become P8 quotas.
    pub(crate) fn worker_admission_limit(&self, dimension: BudgetDimension) -> Option<u64> {
        if !matches!(dimension,
            BudgetDimension::MemoryBytes
                | BudgetDimension::CpuMillicores
                | BudgetDimension::Processes
                | BudgetDimension::FileDescriptors
                | BudgetDimension::DiskBytes
                | BudgetDimension::ToolOutputBytes
                | BudgetDimension::ActiveWorkers
        ) {
            return None;
        }
        let row = self.rows.get(&dimension)?;
        match row.enforcement {
            ResourceLimitEnforcementPolicyV1::HardOs
            | ResourceLimitEnforcementPolicyV1::AdmissionOnly => row.effective.as_ref()?.hard,
            ResourceLimitEnforcementPolicyV1::ObserveOnly
            | ResourceLimitEnforcementPolicyV1::Unsupported => None,
        }
    }
}

/// Process-local pressure tracker bound to one exact HostKernel policy pin and
/// authenticated owner epoch. The lower watermark and calm window are explicit
/// inputs from the trusted configuration projection; P8 does not synthesize
/// either value. This tracker is advisory and must be discarded on owner-epoch
/// change or policy revision change. It is not durable admission authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ManagedResourcePressureTrackerV1 {
    owner: AuthenticatedOwnerContext,
    policy_revision: u64,
    policy_digest: String,
    dimension: BudgetDimension,
    lower_watermark: u64,
    required_calm_samples: u16,
    last_sampled_at_ms: u64,
    controller: ResourcePressureControllerV1,
}

impl ManagedResourcePressureTrackerV1 {
    pub(crate) fn from_authenticated_policy(
        policy: &AuthenticatedResourcePolicyPinV1,
        dimension: BudgetDimension,
        lower_watermark: u64,
        required_calm_samples: u16,
    ) -> Result<Self, ResourcePressureConsumerErrorV1> {
        // V1 has an accepted owner-attributed PSS source. Other dimensions
        // require their own same-unit sampler before they may produce pressure.
        if dimension != BudgetDimension::MemoryBytes {
            return Err(ResourcePressureConsumerErrorV1::UnsupportedDimension);
        }
        let row = policy.row(dimension)
            .ok_or(ResourcePressureConsumerErrorV1::PolicyUnavailable)?;
        let effective = row.effective.as_ref()
            .filter(|limit| limit.enforcement != ResourceLimitEnforcementPolicyV1::Unsupported)
            .ok_or(ResourcePressureConsumerErrorV1::PolicyUnavailable)?;
        let limits = PressureLimits { soft: effective.soft, hard: effective.hard };
        let mut controller = ResourcePressureControllerV1::new(
            limits,
            lower_watermark,
            required_calm_samples,
            policy.owner.owner_epoch(),
        ).map_err(|_| ResourcePressureConsumerErrorV1::InvalidPolicy)?;
        // A new tracker has no authenticated calm history. Require the same
        // sustained-calm window as a resumed owner before projecting NORMAL.
        controller.state = PressureState::Recovering;
        Ok(Self {
            owner: policy.owner.clone(),
            policy_revision: policy.projection_revision,
            policy_digest: policy.projection_digest.clone(),
            dimension,
            lower_watermark,
            required_calm_samples,
            last_sampled_at_ms: 0,
            controller,
        })
    }

    pub(crate) fn matches_inputs(
        &self,
        policy: &AuthenticatedResourcePolicyPinV1,
        owner: &AuthenticatedOwnerContext,
        dimension: BudgetDimension,
        lower_watermark: u64,
        required_calm_samples: u16,
    ) -> bool {
        self.owner == *owner
            && policy.matches_owner(owner)
            && self.policy_revision == policy.projection_revision
            && self.policy_digest == policy.projection_digest
            && self.dimension == dimension
            && self.lower_watermark == lower_watermark
            && self.required_calm_samples == required_calm_samples
    }

    /// Advisory hysteresis has no durable retention contract. The caller may
    /// discard it once its last supporting sample is older than the caller's
    /// bounded freshness window; a later observation then starts RECOVERING.
    pub(crate) fn is_expired_at(&self, now_ms: u64, max_age_ms: u64) -> bool {
        self.last_sampled_at_ms == 0
            || now_ms < self.last_sampled_at_ms
            || now_ms - self.last_sampled_at_ms > max_age_ms
    }

    /// P8 calls this only after revalidating the snapshot against the current
    /// OwnerLog cursor and freshness bound. `None` usage cannot create a NORMAL
    /// signal or advance the recovery window.
    pub(crate) fn observe_verified_usage(
        &mut self,
        policy: &AuthenticatedResourcePolicyPinV1,
        owner: &AuthenticatedOwnerContext,
        sample_sequence: u64,
        sampled_at_ms: u64,
        owner_log_id: &str,
        owner_log_sequence: &str,
        owner_log_event_digest: &str,
        worker_pool_revision: u64,
        measured_usage: Option<u64>,
    ) -> Result<AuthenticatedResourcePressureSignalV1, ResourcePressureConsumerErrorV1> {
        if self.owner != *owner
            || !policy.matches_owner(owner)
            || policy.projection_revision != self.policy_revision
            || policy.projection_digest != self.policy_digest
            || sample_sequence == 0 || sampled_at_ms == 0
            || sampled_at_ms <= self.last_sampled_at_ms
            || owner_log_id.is_empty() || owner_log_sequence.is_empty()
            || !valid_blake3_digest(owner_log_event_digest) || worker_pool_revision == 0
        {
            return Err(ResourcePressureConsumerErrorV1::StaleAuthority);
        }
        let measured_usage = measured_usage
            .ok_or(ResourcePressureConsumerErrorV1::UsageUnavailable)?;
        let state = self.controller.observe(
            owner.owner_epoch(), sample_sequence, Some(measured_usage), false,
        ).map_err(|_| ResourcePressureConsumerErrorV1::StaleAuthority)?;
        self.last_sampled_at_ms = sampled_at_ms;
        Ok(AuthenticatedResourcePressureSignalV1 {
            owner: owner.clone(),
            policy_revision: self.policy_revision,
            policy_digest: self.policy_digest.clone(),
            dimension: self.dimension,
            sample_sequence,
            sampled_at_ms,
            owner_log_id: owner_log_id.to_owned(),
            owner_log_sequence: owner_log_sequence.to_owned(),
            owner_log_event_digest: owner_log_event_digest.to_owned(),
            worker_pool_revision,
            measured_usage,
            state,
        })
    }
}

/// Opaque, bounded advisory output. It carries provenance so consumers cannot
/// accidentally reuse pressure from another Attempt, policy revision or
/// sample sequence. It never grants launch, cancellation, eviction or release
/// authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AuthenticatedResourcePressureSignalV1 {
    owner: AuthenticatedOwnerContext,
    policy_revision: u64,
    policy_digest: String,
    dimension: BudgetDimension,
    sample_sequence: u64,
    sampled_at_ms: u64,
    owner_log_id: String,
    owner_log_sequence: String,
    owner_log_event_digest: String,
    worker_pool_revision: u64,
    measured_usage: u64,
    state: PressureState,
}

impl AuthenticatedResourcePressureSignalV1 {
    pub(crate) fn owner(&self) -> &AuthenticatedOwnerContext { &self.owner }
    pub(crate) fn policy_revision(&self) -> u64 { self.policy_revision }
    pub(crate) fn policy_digest(&self) -> &str { &self.policy_digest }
    pub(crate) fn dimension(&self) -> BudgetDimension { self.dimension }
    pub(crate) fn sample_sequence(&self) -> u64 { self.sample_sequence }
    pub(crate) fn sampled_at_ms(&self) -> u64 { self.sampled_at_ms }
    pub(crate) fn owner_log_id(&self) -> &str { &self.owner_log_id }
    pub(crate) fn owner_log_sequence(&self) -> &str { &self.owner_log_sequence }
    pub(crate) fn owner_log_event_digest(&self) -> &str { &self.owner_log_event_digest }
    pub(crate) fn worker_pool_revision(&self) -> u64 { self.worker_pool_revision }
    pub(crate) fn measured_usage(&self) -> u64 { self.measured_usage }
    pub(crate) fn state(&self) -> PressureState { self.state }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourcePressureConsumerErrorV1 {
    PolicyUnavailable,
    UnsupportedDimension,
    InvalidPolicy,
    StaleAuthority,
    UsageUnavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ResourcePolicyPinErrorV1 {
    InvalidOwner,
    InvalidProjection,
}

fn valid_blake3_digest(value: &str) -> bool {
    value.len() == 71
        && value.starts_with("blake3:")
        && value[7..].bytes().all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ResourceOwnerError {
    InvalidConfiguration,
    InvalidIdentity,
    InvalidRequest,
    StaleRevision,
    StaleOwnerEpoch,
    ScopeMismatch,
    IdempotencyConflict,
    CapacityUnknown,
    UnknownCapacity,
    InsufficientCapacity,
    ReservationLimitReached,
    ReservationNotFound,
    InvalidTransition,
    MissingProof,
    ProcessIdentityMismatch,
    StaleSample,
    NotExpired,
    WorkerIdentityConflict,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReservationRequest {
    pub reservation_id: String,
    pub idempotency_key: String,
    pub dimension: BudgetDimension,
    pub amount: u64,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OwnedReservation {
    pub reservation_id: String,
    pub idempotency_key: String,
    pub owner: AuthenticatedOwnerContext,
    pub dimension: BudgetDimension,
    pub amount: u64,
    pub state: ReservationState,
    pub expires_at_ms: u64,
    pub worker_execution_id: Option<String>,
    pub process_identity: Option<crate::resource_sampler::ProcessIdentity>,
    pub already_counted_units: Option<u64>,
    pub usage_sample_sequence: Option<u64>,
}

impl OwnedReservation {
    fn budget_reservation(&self) -> Reservation {
        Reservation {
            state: self.state,
            reserved_units: self.amount,
            already_counted_units: self.already_counted_units,
        }
    }

    pub fn outstanding_units(&self) -> u64 {
        self.budget_reservation().outstanding_units()
    }
}

#[derive(Clone, Copy, Debug)]
struct DimensionCapacity {
    hard_limit: Option<u64>,
    measured_total: Option<u64>,
    safety_reserve: u64,
    sample_sequence: u64,
}

/// Process-local, bounded model of the canonical reservation owner. This is
/// not yet attached to OwnerLog; production dispatch must persist every
/// revision/transition before using a lease. Its API keeps the authorization,
/// CAS, quota, idempotency and settlement rules executable for the eventual
/// durable adapter without enabling worker fan-out.
#[derive(Clone, Debug)]
pub struct ResourceReservationOwner {
    owner_epoch: u64,
    revision: u64,
    max_reservations: usize,
    capacity: BTreeMap<BudgetDimension, DimensionCapacity>,
    reservations: BTreeMap<String, OwnedReservation>,
    idempotency: HashMap<(String, String), String>,
}

impl ResourceReservationOwner {
    pub fn new(owner_epoch: u64, max_reservations: usize) -> Result<Self, ResourceOwnerError> {
        if owner_epoch == 0 || max_reservations == 0 || max_reservations > 4096 {
            return Err(ResourceOwnerError::InvalidConfiguration);
        }
        Ok(Self {
            owner_epoch,
            revision: 0,
            max_reservations,
            capacity: BTreeMap::new(),
            reservations: BTreeMap::new(),
            idempotency: HashMap::new(),
        })
    }

    pub fn revision(&self) -> u64 {
        self.revision
    }

    /// The epoch this owner was created with. Inner pools keep the epoch of
    /// their creation: the worker pool advances its own fence and passes the
    /// record's original scope for settlement, so persisted reservations are
    /// never reinterpreted under a newer epoch.
    #[allow(dead_code)]
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }

    /// Internal primitive only. Product ingress must not accept caller-provided
    /// hard limits or usage values; HostKernel must first mint an authenticated
    /// policy pin and a same-owner measured observation before a future adapter
    /// can call this.
    pub(crate) fn update_capacity(
        &mut self,
        dimension: BudgetDimension,
        hard_limit: Option<u64>,
        measured_total: Option<u64>,
        safety_reserve: u64,
        owner_epoch: u64,
        sample_sequence: u64,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_epoch(owner_epoch)?;
        self.check_revision(expected_revision)?;
        let previous_sequence = self
            .capacity
            .get(&dimension)
            .map_or(0, |current| current.sample_sequence);
        if sample_sequence == 0 || sample_sequence <= previous_sequence {
            return Err(ResourceOwnerError::StaleSample);
        }
        let next_revision = self.next_revision()?;
        self.capacity.insert(
            dimension,
            DimensionCapacity {
                hard_limit,
                measured_total,
                safety_reserve,
                sample_sequence,
            },
        );
        for reservation in self.reservations.values_mut().filter(|reservation| {
            reservation.dimension == dimension && is_capacity_holding(reservation.state)
        }) {
            // A new global sample invalidates worker-specific usage attribution until
            // this exact process generation is sampled in the same sequence.
            reservation.already_counted_units = None;
            reservation.usage_sample_sequence = None;
        }
        self.revision = next_revision;
        Ok(next_revision)
    }

    pub fn capacity(&self, dimension: BudgetDimension) -> Capacity {
        let Some(snapshot) = self.capacity.get(&dimension) else {
            return Capacity::UnknownCapacity;
        };
        let (Some(hard_limit), Some(measured_total)) =
            (snapshot.hard_limit, snapshot.measured_total)
        else {
            return Capacity::UnknownCapacity;
        };
        let reservations: Vec<_> = self
            .reservations
            .values()
            .filter(|reservation| reservation.dimension == dimension)
            .map(OwnedReservation::budget_reservation)
            .collect();
        remaining_capacity(
            Some(hard_limit),
            measured_total,
            snapshot.safety_reserve,
            &reservations,
        )
    }

    pub fn propose(
        &mut self,
        request: ReservationRequest,
        owner: AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<OwnedReservation, ResourceOwnerError> {
        self.check_owner(&owner)?;
        validate_request(&request)?;
        let key = (owner.attempt_id.clone(), request.idempotency_key.clone());
        if let Some(existing_id) = self.idempotency.get(&key) {
            let existing = self
                .reservations
                .get(existing_id)
                .ok_or(ResourceOwnerError::ReservationNotFound)?;
            if existing.owner == owner
                && existing.reservation_id == request.reservation_id
                && existing.dimension == request.dimension
                && existing.amount == request.amount
                && existing.expires_at_ms == request.expires_at_ms
            {
                return Ok(existing.clone());
            }
            return Err(ResourceOwnerError::IdempotencyConflict);
        }
        self.check_revision(expected_revision)?;
        if self.reservations.contains_key(&request.reservation_id) {
            return Err(ResourceOwnerError::IdempotencyConflict);
        }
        if self.reservations.len() >= self.max_reservations {
            return Err(ResourceOwnerError::ReservationLimitReached);
        }
        let reservation = OwnedReservation {
            reservation_id: request.reservation_id.clone(),
            idempotency_key: request.idempotency_key.clone(),
            owner,
            dimension: request.dimension,
            amount: request.amount,
            state: ReservationState::Proposed,
            expires_at_ms: request.expires_at_ms,
            worker_execution_id: None,
            process_identity: None,
            already_counted_units: None,
            usage_sample_sequence: None,
        };
        let next_revision = self.next_revision()?;
        self.idempotency.insert(key, request.reservation_id.clone());
        self.reservations
            .insert(request.reservation_id, reservation.clone());
        self.revision = next_revision;
        Ok(reservation)
    }

    pub fn reserve(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<OwnedReservation, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.state == ReservationState::Reserved {
            return Ok(existing.clone());
        }
        if existing.state != ReservationState::Proposed {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        match self.capacity(existing.dimension) {
            Capacity::UnknownCapacity => return Err(ResourceOwnerError::UnknownCapacity),
            Capacity::Remaining(remaining) if remaining < existing.amount => {
                return Err(ResourceOwnerError::InsufficientCapacity);
            }
            Capacity::Remaining(_) => {}
        }
        existing
            .state
            .validate_transition(ReservationState::Reserved, ReservationProof::default())
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = ReservationState::Reserved;
        let result = current.clone();
        self.revision = next_revision;
        Ok(result)
    }

    /// Replay-only: re-applies an already-committed `PROPOSED → RESERVED`
    /// transition without re-evaluating live capacity, which was validated
    /// before the durable append. Owner, scope, state and revision fences still
    /// apply. This is never a live admission path: derived telemetry must not
    /// be able to rewrite committed history.
    #[allow(dead_code)]
    pub(crate) fn reserve_replayed(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<OwnedReservation, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.state == ReservationState::Reserved {
            return Ok(existing.clone());
        }
        if existing.state != ReservationState::Proposed {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        existing
            .state
            .validate_transition(ReservationState::Reserved, ReservationProof::default())
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = ReservationState::Reserved;
        let result = current.clone();
        self.revision = next_revision;
        Ok(result)
    }

    pub fn claim(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        worker_execution_id: &str,
        expected_revision: u64,
    ) -> Result<OwnedReservation, ResourceOwnerError> {
        self.check_owner(owner)?;
        if worker_execution_id.is_empty() || worker_execution_id.len() > 256 {
            return Err(ResourceOwnerError::InvalidRequest);
        }
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.state == ReservationState::Claimed {
            if existing.worker_execution_id.as_deref() == Some(worker_execution_id) {
                return Ok(existing.clone());
            }
            return Err(ResourceOwnerError::WorkerIdentityConflict);
        }
        self.check_revision(expected_revision)?;
        existing
            .state
            .validate_transition(ReservationState::Claimed, ReservationProof::default())
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = ReservationState::Claimed;
        current.worker_execution_id = Some(worker_execution_id.to_owned());
        let result = current.clone();
        self.revision = next_revision;
        Ok(result)
    }

    pub fn bind_process(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        process_identity: crate::resource_sampler::ProcessIdentity,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let current = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(current, owner)?;
        if process_identity.pid == 0 || process_identity.start_identity == 0 {
            return Err(ResourceOwnerError::InvalidRequest);
        }
        if current.state != ReservationState::Claimed {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        if let Some(existing) = &current.process_identity {
            return if *existing == process_identity {
                Ok(self.revision)
            } else {
                Err(ResourceOwnerError::ProcessIdentityMismatch)
            };
        }
        self.check_revision(expected_revision)?;
        let next_revision = self.next_revision()?;
        self.reservations
            .get_mut(reservation_id)
            .expect("checked reservation")
            .process_identity = Some(process_identity);
        self.revision = next_revision;
        Ok(next_revision)
    }

    pub fn record_process_usage(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        process_identity: &crate::resource_sampler::ProcessIdentity,
        measured_units: u64,
        sample_sequence: u64,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let reservation = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(reservation, owner)?;
        if !is_capacity_holding(reservation.state) {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        if reservation.process_identity.as_ref() != Some(process_identity) {
            return Err(ResourceOwnerError::ProcessIdentityMismatch);
        }
        let capacity = self
            .capacity
            .get(&reservation.dimension)
            .ok_or(ResourceOwnerError::UnknownCapacity)?;
        if capacity.sample_sequence != sample_sequence
            || capacity.measured_total.is_none()
            || capacity
                .measured_total
                .is_some_and(|total| measured_units > total)
        {
            return Err(ResourceOwnerError::StaleSample);
        }
        if reservation.usage_sample_sequence == Some(sample_sequence) {
            return if reservation.already_counted_units == Some(measured_units) {
                Ok(self.revision)
            } else {
                Err(ResourceOwnerError::StaleSample)
            };
        }
        self.check_revision(expected_revision)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.already_counted_units = Some(measured_units);
        current.usage_sample_sequence = Some(sample_sequence);
        self.revision = next_revision;
        Ok(next_revision)
    }

    pub fn expire_unlaunched(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        now_ms: u64,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        match existing.state {
            ReservationState::Expired => return Ok(self.revision),
            ReservationState::Reserved => {}
            _ => return Err(ResourceOwnerError::InvalidTransition),
        }
        if now_ms < existing.expires_at_ms {
            return Err(ResourceOwnerError::NotExpired);
        }
        self.check_revision(expected_revision)?;
        existing
            .state
            .validate_transition(ReservationState::Expired, proof)
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = ReservationState::Expired;
        self.revision = next_revision;
        Ok(next_revision)
    }

    pub(crate) fn expire_unlaunched_reconciled(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self.reservations.get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.state == ReservationState::Expired { return Ok(self.revision); }
        if existing.state != ReservationState::Reserved
            || !proof.no_launch_or_dispatch || !proof.reconciliation_complete
        {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        self.check_revision(expected_revision)?;
        existing.state.validate_transition(ReservationState::Expired, proof)
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        self.reservations.get_mut(reservation_id).expect("checked reservation").state = ReservationState::Expired;
        self.revision = next_revision;
        Ok(next_revision)
    }

    pub fn quarantine(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.transition(
            reservation_id,
            owner,
            ReservationState::Quarantined,
            ReservationProof::default(),
            expected_revision,
        )
    }

    pub fn begin_release(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.transition(
            reservation_id,
            owner,
            ReservationState::ReleasePending,
            proof,
            expected_revision,
        )
    }

    pub fn release(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.process_identity.is_none() {
            return Err(ResourceOwnerError::MissingProof);
        }
        if existing.state == ReservationState::Released {
            return if proof.owned_process_exited && proof.effects_settled {
                Ok(self.revision)
            } else {
                Err(ResourceOwnerError::MissingProof)
            };
        }
        self.check_revision(expected_revision)?;
        existing
            .state
            .validate_transition(ReservationState::Released, proof)
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = ReservationState::Released;
        current.already_counted_units = None;
        current.usage_sample_sequence = None;
        self.revision = next_revision;
        Ok(next_revision)
    }

    /// Release a logical managed-session worker's ActiveWorkers lease after
    /// WorkerPoolControl has consumed the opaque P1/P2 terminal proof. Logical
    /// sessions share Core's PID, so this path intentionally requires no child
    /// process identity and accepts no process-exit flag.
    pub(crate) fn release_logical_managed_worker(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self.reservations.get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.dimension != BudgetDimension::ActiveWorkers
            || existing.worker_execution_id.is_none()
            || existing.process_identity.is_some()
            || !matches!(existing.state, ReservationState::Claimed | ReservationState::Quarantined | ReservationState::ReleasePending)
        {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        if existing.state != ReservationState::ReleasePending {
            self.check_revision(expected_revision)?;
            existing.state.validate_transition(
                ReservationState::ReleasePending,
                ReservationProof::default(),
            ).map_err(map_transition_error)?;
            let next = self.next_revision()?;
            self.reservations.get_mut(reservation_id).expect("checked reservation").state =
                ReservationState::ReleasePending;
            self.revision = next;
        }
        self.check_revision(self.revision)?;
        let next = self.next_revision()?;
        let current = self.reservations.get_mut(reservation_id).expect("checked reservation");
        current.state = ReservationState::Released;
        current.already_counted_units = None;
        current.usage_sample_sequence = None;
        self.revision = next;
        Ok(next)
    }

    pub(crate) fn release_logical_managed_worker_reconciled(
        &mut self,
        reservation_id: &str,
        recorded_owner: &AuthenticatedOwnerContext,
        current_owner_epoch: u64,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        let existing = self.reservations.get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        if &existing.owner != recorded_owner
            || current_owner_epoch != self.owner_epoch
            || current_owner_epoch < recorded_owner.owner_epoch()
            || existing.dimension != BudgetDimension::ActiveWorkers
            || existing.worker_execution_id.is_none()
            || existing.process_identity.is_some()
            || !matches!(existing.state, ReservationState::Quarantined | ReservationState::ReleasePending)
        {
            return Err(ResourceOwnerError::InvalidTransition);
        }
        if existing.state != ReservationState::ReleasePending {
            self.check_revision(expected_revision)?;
            existing.state.validate_transition(ReservationState::ReleasePending, ReservationProof {
                reconciliation_complete: true, ..ReservationProof::default()
            }).map_err(map_transition_error)?;
            let next = self.next_revision()?;
            self.reservations.get_mut(reservation_id).expect("checked reservation").state =
                ReservationState::ReleasePending;
            self.revision = next;
        }
        let next = self.next_revision()?;
        let current = self.reservations.get_mut(reservation_id).expect("checked reservation");
        current.state = ReservationState::Released;
        current.already_counted_units = None;
        current.usage_sample_sequence = None;
        self.revision = next;
        Ok(next)
    }

    /// Reconciliation-only release for a quarantined reservation whose OS
    /// process generation was never bound (for example a crash between the
    /// durable claim and the process bind). The trusted reconciler must have
    /// obtained target-side evidence for `owned_process_exited` and
    /// `effects_settled`; absent that evidence the reservation keeps its
    /// conservative budget. Never a live success path.
    #[allow(dead_code)]
    pub fn release_reconciled(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if !proof.owned_process_exited || !proof.effects_settled {
            return Err(ResourceOwnerError::MissingProof);
        }
        if existing.state == ReservationState::Released {
            return Ok(self.revision);
        }
        self.check_revision(expected_revision)?;
        existing
            .state
            .validate_transition(ReservationState::Released, proof)
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = ReservationState::Released;
        current.already_counted_units = None;
        current.usage_sample_sequence = None;
        self.revision = next_revision;
        Ok(next_revision)
    }

    pub fn reservation(&self, reservation_id: &str) -> Option<&OwnedReservation> {
        self.reservations.get(reservation_id)
    }

    fn transition(
        &mut self,
        reservation_id: &str,
        owner: &AuthenticatedOwnerContext,
        next: ReservationState,
        proof: ReservationProof,
        expected_revision: u64,
    ) -> Result<u64, ResourceOwnerError> {
        self.check_owner(owner)?;
        let existing = self
            .reservations
            .get(reservation_id)
            .ok_or(ResourceOwnerError::ReservationNotFound)?;
        self.check_reservation_owner(existing, owner)?;
        if existing.state == next {
            return Ok(self.revision);
        }
        self.check_revision(expected_revision)?;
        existing
            .state
            .validate_transition(next, proof)
            .map_err(map_transition_error)?;
        let next_revision = self.next_revision()?;
        let current = self
            .reservations
            .get_mut(reservation_id)
            .expect("checked reservation");
        current.state = next;
        if next == ReservationState::Quarantined {
            current.already_counted_units = None;
            current.usage_sample_sequence = None;
        }
        self.revision = next_revision;
        Ok(next_revision)
    }

    fn check_owner(&self, owner: &AuthenticatedOwnerContext) -> Result<(), ResourceOwnerError> {
        owner.validate()?;
        self.check_epoch(owner.owner_epoch)
    }

    fn check_epoch(&self, owner_epoch: u64) -> Result<(), ResourceOwnerError> {
        if owner_epoch != self.owner_epoch {
            return Err(ResourceOwnerError::StaleOwnerEpoch);
        }
        Ok(())
    }

    fn check_reservation_owner(
        &self,
        reservation: &OwnedReservation,
        owner: &AuthenticatedOwnerContext,
    ) -> Result<(), ResourceOwnerError> {
        if &reservation.owner == owner {
            Ok(())
        } else {
            Err(ResourceOwnerError::ScopeMismatch)
        }
    }

    fn check_revision(&self, expected_revision: u64) -> Result<(), ResourceOwnerError> {
        if expected_revision == self.revision {
            Ok(())
        } else {
            Err(ResourceOwnerError::StaleRevision)
        }
    }

    fn next_revision(&self) -> Result<u64, ResourceOwnerError> {
        self.revision
            .checked_add(1)
            .ok_or(ResourceOwnerError::InvalidConfiguration)
    }
}

fn validate_request(request: &ReservationRequest) -> Result<(), ResourceOwnerError> {
    if request.reservation_id.is_empty()
        || request.reservation_id.len() > 128
        || request.idempotency_key.is_empty()
        || request.idempotency_key.len() > 128
        || request.amount == 0
        || request.expires_at_ms == 0
    {
        return Err(ResourceOwnerError::InvalidRequest);
    }
    Ok(())
}

fn is_capacity_holding(state: ReservationState) -> bool {
    matches!(
        state,
        ReservationState::Reserved
            | ReservationState::Claimed
            | ReservationState::ReleasePending
            | ReservationState::Quarantined
    )
}

fn map_transition_error(error: ReservationTransitionError) -> ResourceOwnerError {
    match error {
        ReservationTransitionError::ForbiddenTransition => ResourceOwnerError::InvalidTransition,
        ReservationTransitionError::MissingProof => ResourceOwnerError::MissingProof,
    }
}

impl PressureState {
    /// Pure transition for the §18.18/§11.20 controller. Escalation is immediate, including
    /// `NORMAL → HARD_PRESSURE` on an OS quota alarm. De-escalation requires `sustained_calm`
    /// and never skips a pressure state through `RECOVERING → NORMAL`;
    /// `HARD_PRESSURE` does not fall back to `SOFT_PRESSURE` while usage merely
    /// drops below the hard limit.
    pub fn evaluate(self, observation: PressureObservation) -> Self {
        use PressureState::{HardPressure, Normal, Recovering, SoftPressure};
        let PressureObservation {
            limits,
            measured_usage,
            os_quota_alarm,
            sustained_calm,
        } = observation;
        if os_quota_alarm || limits.hard.is_some_and(|hard| measured_usage >= hard) {
            return HardPressure;
        }
        match self {
            HardPressure => {
                if sustained_calm {
                    Recovering
                } else {
                    HardPressure
                }
            }
            SoftPressure => {
                if limits.soft.is_some_and(|soft| measured_usage >= soft) {
                    SoftPressure
                } else if sustained_calm {
                    Recovering
                } else {
                    SoftPressure
                }
            }
            Recovering => {
                if limits.soft.is_some_and(|soft| measured_usage >= soft) {
                    SoftPressure
                } else if sustained_calm {
                    Normal
                } else {
                    Recovering
                }
            }
            Normal => {
                if limits.soft.is_some_and(|soft| measured_usage >= soft) {
                    SoftPressure
                } else {
                    Normal
                }
            }
        }
    }
}

/// Strict §11.20/§18.18 wire vocabulary rejection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResourceWireError {
    UnknownReservationStatus,
    UnknownPressureState,
    UnknownDimension,
}

impl ReservationState {
    /// The exact `WorkerResourceReservationV1.status` names. `ACTIVE` and
    /// `UNKNOWN` are not reservation states and never appear on the wire.
    pub const WIRE_NAMES: [&'static str; 7] = [
        "PROPOSED",
        "RESERVED",
        "CLAIMED",
        "RELEASE_PENDING",
        "QUARANTINED",
        "RELEASED",
        "EXPIRED",
    ];

    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Proposed => "PROPOSED",
            Self::Reserved => "RESERVED",
            Self::Claimed => "CLAIMED",
            Self::ReleasePending => "RELEASE_PENDING",
            Self::Quarantined => "QUARANTINED",
            Self::Released => "RELEASED",
            Self::Expired => "EXPIRED",
        }
    }

    /// Strict decoder: exact upper-case §11.20 names only. Obsolete `ACTIVE`,
    /// `UNKNOWN`, lower-case or otherwise aliased values fail closed.
    pub fn parse_wire(value: &str) -> Result<Self, ResourceWireError> {
        match value {
            "PROPOSED" => Ok(Self::Proposed),
            "RESERVED" => Ok(Self::Reserved),
            "CLAIMED" => Ok(Self::Claimed),
            "RELEASE_PENDING" => Ok(Self::ReleasePending),
            "QUARANTINED" => Ok(Self::Quarantined),
            "RELEASED" => Ok(Self::Released),
            "EXPIRED" => Ok(Self::Expired),
            _ => Err(ResourceWireError::UnknownReservationStatus),
        }
    }
}

impl PressureState {
    /// The exact §18.18 pressure names; `SOFT`/`HARD` aliases are not defined.
    pub const WIRE_NAMES: [&'static str; 4] =
        ["NORMAL", "SOFT_PRESSURE", "HARD_PRESSURE", "RECOVERING"];

    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Normal => "NORMAL",
            Self::SoftPressure => "SOFT_PRESSURE",
            Self::HardPressure => "HARD_PRESSURE",
            Self::Recovering => "RECOVERING",
        }
    }

    /// Strict decoder: exact §18.18 names only; `SOFT`/`HARD` fail closed.
    pub fn parse_wire(value: &str) -> Result<Self, ResourceWireError> {
        match value {
            "NORMAL" => Ok(Self::Normal),
            "SOFT_PRESSURE" => Ok(Self::SoftPressure),
            "HARD_PRESSURE" => Ok(Self::HardPressure),
            "RECOVERING" => Ok(Self::Recovering),
            _ => Err(ResourceWireError::UnknownPressureState),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reservation(
        state: ReservationState,
        reserved_units: u64,
        counted: Option<u64>,
    ) -> Reservation {
        Reservation {
            state,
            reserved_units,
            already_counted_units: counted,
        }
    }

    fn authenticated_owner(epoch: u64, attempt: &str) -> AuthenticatedOwnerContext {
        AuthenticatedOwnerContext::test_fixture(
            "principal-a",
            "workspace-a",
            "session-a",
            "run-a",
            "task-a",
            attempt,
            epoch,
        )
    }

    fn policy_rows() -> Vec<AuthenticatedResourcePolicyRowV1> {
        [
            BudgetDimension::MemoryBytes,
            BudgetDimension::CpuMillicores,
            BudgetDimension::Processes,
            BudgetDimension::FileDescriptors,
            BudgetDimension::DiskBytes,
            BudgetDimension::ToolOutputBytes,
            BudgetDimension::ActiveWorkers,
            BudgetDimension::Tokens,
            BudgetDimension::ProviderCostMicros,
        ]
        .into_iter()
        .map(|dimension| AuthenticatedResourcePolicyRowV1 {
            dimension,
            effective: None,
            enforcement: ResourceLimitEnforcementPolicyV1::Unsupported,
        })
        .collect()
    }

    fn reservation_owner(epoch: u64) -> ResourceReservationOwner {
        ResourceReservationOwner::new(epoch, 8).expect("valid reservation owner")
    }

    #[test]
    fn authenticated_policy_pin_uses_only_effective_admission_limits() {
        let owner = authenticated_owner(7, "attempt-a");
        let mut rows = policy_rows();
        rows[0] = AuthenticatedResourcePolicyRowV1 {
            dimension: BudgetDimension::MemoryBytes,
            enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            effective: Some(EffectiveResourceLimitV1 {
                dimension: BudgetDimension::MemoryBytes,
                soft: Some(80),
                hard: Some(100),
                source: ResourceLimitSourceV1::User,
                enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            }),
        };
        rows[7] = AuthenticatedResourcePolicyRowV1 {
            dimension: BudgetDimension::Tokens,
            enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            effective: Some(EffectiveResourceLimitV1 {
                dimension: BudgetDimension::Tokens,
                soft: None,
                hard: Some(500),
                source: ResourceLimitSourceV1::Run,
                enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            }),
        };
        let pin = AuthenticatedResourcePolicyPinV1::from_host_kernel(
            owner.clone(), 3, format!("blake3:{}", "a".repeat(64)), rows,
        ).expect("strict HostKernel pin");
        assert!(pin.matches_owner(&owner));
        assert_eq!(pin.projection_revision(), 3);
        assert_eq!(pin.worker_admission_limit(BudgetDimension::MemoryBytes), Some(100));
        assert_eq!(pin.worker_admission_limit(BudgetDimension::Tokens), None);
        assert_eq!(pin.worker_admission_limit(BudgetDimension::ProviderCostMicros), None);
        assert_eq!(pin.worker_admission_limit(BudgetDimension::Processes), None);
    }

    #[test]
    fn authenticated_policy_pin_rejects_incomplete_duplicate_or_invalid_limits() {
        let owner = authenticated_owner(7, "attempt-a");
        let digest = format!("blake3:{}", "a".repeat(64));
        assert_eq!(
            AuthenticatedResourcePolicyPinV1::from_host_kernel(
                owner.clone(), 1, digest.clone(), policy_rows().into_iter().take(8).collect(),
            ),
            Err(ResourcePolicyPinErrorV1::InvalidProjection),
        );
        let mut duplicate = policy_rows();
        duplicate[8].dimension = BudgetDimension::Tokens;
        assert_eq!(
            AuthenticatedResourcePolicyPinV1::from_host_kernel(owner.clone(), 1, digest.clone(), duplicate),
            Err(ResourcePolicyPinErrorV1::InvalidProjection),
        );
        let mut inverted = policy_rows();
        inverted[0] = AuthenticatedResourcePolicyRowV1 {
            dimension: BudgetDimension::MemoryBytes,
            enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            effective: Some(EffectiveResourceLimitV1 {
                dimension: BudgetDimension::MemoryBytes,
                soft: Some(101),
                hard: Some(100),
                source: ResourceLimitSourceV1::User,
                enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            }),
        };
        assert_eq!(
            AuthenticatedResourcePolicyPinV1::from_host_kernel(owner, 1, digest, inverted),
            Err(ResourcePolicyPinErrorV1::InvalidProjection),
        );
    }

    #[test]
    fn authenticated_policy_pin_keeps_os_enforcement_and_source_consistent() {
        let owner = authenticated_owner(7, "attempt-a");
        let digest = format!("blake3:{}", "b".repeat(64));
        let mut rows = policy_rows();
        rows[0] = AuthenticatedResourcePolicyRowV1 {
            dimension: BudgetDimension::MemoryBytes,
            enforcement: ResourceLimitEnforcementPolicyV1::HardOs,
            effective: Some(EffectiveResourceLimitV1 {
                dimension: BudgetDimension::MemoryBytes,
                soft: None,
                hard: Some(100),
                source: ResourceLimitSourceV1::User,
                enforcement: ResourceLimitEnforcementPolicyV1::HardOs,
            }),
        };
        assert_eq!(
            AuthenticatedResourcePolicyPinV1::from_host_kernel(
                owner.clone(), 1, digest.clone(), rows,
            ),
            Err(ResourcePolicyPinErrorV1::InvalidProjection),
        );

        let mut rows = policy_rows();
        rows[0] = AuthenticatedResourcePolicyRowV1 {
            dimension: BudgetDimension::MemoryBytes,
            enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            effective: Some(EffectiveResourceLimitV1 {
                dimension: BudgetDimension::MemoryBytes,
                soft: None,
                hard: Some(100),
                source: ResourceLimitSourceV1::OsQuota,
                enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            }),
        };
        assert_eq!(
            AuthenticatedResourcePolicyPinV1::from_host_kernel(owner, 1, digest, rows),
            Err(ResourcePolicyPinErrorV1::InvalidProjection),
        );
    }

    #[test]
    fn authenticated_pressure_consumer_fences_policy_owner_and_unknown_usage() {
        let owner = authenticated_owner(7, "attempt-a");
        let mut rows = policy_rows();
        rows[0] = AuthenticatedResourcePolicyRowV1 {
            dimension: BudgetDimension::MemoryBytes,
            enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            effective: Some(EffectiveResourceLimitV1 {
                dimension: BudgetDimension::MemoryBytes,
                soft: Some(80),
                hard: Some(100),
                source: ResourceLimitSourceV1::Run,
                enforcement: ResourceLimitEnforcementPolicyV1::AdmissionOnly,
            }),
        };
        let policy = AuthenticatedResourcePolicyPinV1::from_host_kernel(
            owner.clone(), 3, format!("blake3:{}", "c".repeat(64)), rows.clone(),
        ).expect("authenticated policy");
        let mut tracker = ManagedResourcePressureTrackerV1::from_authenticated_policy(
            &policy, BudgetDimension::MemoryBytes, 60, 2,
        ).expect("explicit hysteresis policy");

        assert_eq!(
            tracker.observe_verified_usage(&policy, &owner, 1, 10, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, None),
            Err(ResourcePressureConsumerErrorV1::UsageUnavailable),
        );
        assert_eq!(
            tracker.observe_verified_usage(&policy, &owner, 1, 10, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(100))
                .expect("fresh measured usage").state(),
            PressureState::HardPressure,
        );
        let other_owner = authenticated_owner(7, "attempt-b");
        assert_eq!(
            tracker.observe_verified_usage(&policy, &other_owner, 2, 11, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50)),
            Err(ResourcePressureConsumerErrorV1::StaleAuthority),
        );

        let changed_policy = AuthenticatedResourcePolicyPinV1::from_host_kernel(
            owner.clone(), 4, format!("blake3:{}", "d".repeat(64)), rows,
        ).expect("new policy revision");
        assert_eq!(
            tracker.observe_verified_usage(&changed_policy, &owner, 2, 11, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50)),
            Err(ResourcePressureConsumerErrorV1::StaleAuthority),
        );
        assert_eq!(
            tracker.observe_verified_usage(&policy, &owner, 1, 10, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50)),
            Err(ResourcePressureConsumerErrorV1::StaleAuthority),
        );

        let mut fresh_tracker = ManagedResourcePressureTrackerV1::from_authenticated_policy(
            &policy, BudgetDimension::MemoryBytes, 60, 2,
        ).expect("fresh owner epoch starts without calm history");
        assert_eq!(
            fresh_tracker.observe_verified_usage(&policy, &owner, 1, 10, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50))
                .expect("first calm sample").state(),
            PressureState::Recovering,
        );
        assert_eq!(
            fresh_tracker.observe_verified_usage(&policy, &owner, 2, 11, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50))
                .expect("sustained calm window").state(),
            PressureState::Normal,
        );
        assert_eq!(
            fresh_tracker.observe_verified_usage(&policy, &owner, 3, 11, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50)),
            Err(ResourcePressureConsumerErrorV1::StaleAuthority),
            "a newer sequence with a repeated timestamp cannot advance hysteresis",
        );
        assert_eq!(
            fresh_tracker.observe_verified_usage(&policy, &owner, 3, 12, "pool", "5",
                &format!("blake3:{}", "e".repeat(64)), 1, Some(50))
                .expect("strictly newer sample time").state(),
            PressureState::Normal,
        );
        assert!(!fresh_tracker.is_expired_at(21, 10));
        // The freshness bound matches P2's snapshot validation: a sample is
        // stale only when it is strictly older than the caller's window.
        assert!(!fresh_tracker.is_expired_at(22, 10));
        assert!(fresh_tracker.is_expired_at(23, 10));
    }

    fn set_memory_capacity(
        owner: &mut ResourceReservationOwner,
        epoch: u64,
        hard_limit: Option<u64>,
        measured_total: Option<u64>,
        safety_reserve: u64,
        sample_sequence: u64,
    ) -> u64 {
        owner
            .update_capacity(
                BudgetDimension::MemoryBytes,
                hard_limit,
                measured_total,
                safety_reserve,
                epoch,
                sample_sequence,
                owner.revision(),
            )
            .expect("valid same-epoch capacity sample")
    }

    fn request(id: &str, idempotency_key: &str, amount: u64) -> ReservationRequest {
        ReservationRequest {
            reservation_id: id.to_owned(),
            idempotency_key: idempotency_key.to_owned(),
            dimension: BudgetDimension::MemoryBytes,
            amount,
            expires_at_ms: 10_000,
        }
    }

    type OwnerDump = (
        u64,
        u64,
        usize,
        Vec<(BudgetDimension, Option<u64>, Option<u64>, u64, u64)>,
        BTreeMap<String, OwnedReservation>,
        HashMap<(String, String), String>,
    );

    /// Full deterministic owner state used to prove a failed operation did not
    /// partially mutate capacity, reservations or the idempotency index.
    fn owner_dump(owner: &ResourceReservationOwner) -> OwnerDump {
        (
            owner.owner_epoch,
            owner.revision,
            owner.max_reservations,
            owner
                .capacity
                .iter()
                .map(|(dimension, capacity)| {
                    (
                        *dimension,
                        capacity.hard_limit,
                        capacity.measured_total,
                        capacity.safety_reserve,
                        capacity.sample_sequence,
                    )
                })
                .collect(),
            owner.reservations.clone(),
            owner.idempotency.clone(),
        )
    }

    #[test]
    fn capacity_update_rejects_stale_owner_epoch_without_mutation() {
        let mut owner = reservation_owner(7);
        assert_eq!(
            owner.update_capacity(
                BudgetDimension::MemoryBytes,
                Some(1_000),
                Some(0),
                0,
                6,
                1,
                owner.revision(),
            ),
            Err(ResourceOwnerError::StaleOwnerEpoch)
        );
        assert_eq!(owner.revision(), 0);
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::UnknownCapacity
        );
    }

    #[test]
    fn revision_overflow_does_not_partially_apply_transition() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        owner
            .propose(
                request("lease-a", "request-a", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal");
        owner
            .reserve("lease-a", &attempt, owner.revision())
            .expect("reserve");
        owner
            .claim("lease-a", &attempt, "worker-a", owner.revision())
            .expect("claim");
        let process = crate::resource_sampler::ProcessIdentity::new(101, 4_001);
        owner
            .bind_process("lease-a", &attempt, process.clone(), owner.revision())
            .expect("bind process identity");
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(450), 100, 2);
        owner
            .record_process_usage("lease-a", &attempt, &process, 250, 2, owner.revision())
            .expect("record attributed process usage");

        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.quarantine("lease-a", &attempt, u64::MAX),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(
            owner_dump(&owner),
            before,
            "overflow must not partially mutate owner state"
        );
    }

    #[test]
    fn revision_overflow_is_fail_closed_for_every_mutating_entry_point() {
        let attempt = authenticated_owner(7, "attempt-a");
        let process = crate::resource_sampler::ProcessIdentity::new(101, 4_001);
        let propose = |owner: &mut ResourceReservationOwner| {
            owner
                .propose(
                    request("lease-a", "request-a", 300),
                    attempt.clone(),
                    owner.revision(),
                )
                .expect("proposal");
        };
        let reserve = |owner: &mut ResourceReservationOwner| {
            owner
                .reserve("lease-a", &attempt, owner.revision())
                .expect("reserve");
        };
        let claim = |owner: &mut ResourceReservationOwner| {
            owner
                .claim("lease-a", &attempt, "worker-a", owner.revision())
                .expect("claim");
        };
        let bind = |owner: &mut ResourceReservationOwner| {
            owner
                .bind_process("lease-a", &attempt, process.clone(), owner.revision())
                .expect("bind");
        };

        // propose fails before the idempotency row or reservation record is inserted.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.propose(
                request("lease-a", "request-a", 300),
                attempt.clone(),
                u64::MAX
            ),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);

        // reserve fails before Proposed -> Reserved is persisted.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.reserve("lease-a", &attempt, u64::MAX),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);
        assert_eq!(
            owner.reservation("lease-a").expect("retained").state,
            ReservationState::Proposed
        );

        // claim fails before Reserved -> Claimed is persisted.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        reserve(&mut owner);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.claim("lease-a", &attempt, "worker-a", u64::MAX),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);

        // bind_process fails before the process generation is attached.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        reserve(&mut owner);
        claim(&mut owner);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.bind_process("lease-a", &attempt, process.clone(), u64::MAX),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);
        assert_eq!(
            owner
                .reservation("lease-a")
                .expect("retained")
                .process_identity,
            None
        );

        // record_process_usage fails before attributed usage is stored.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        reserve(&mut owner);
        claim(&mut owner);
        bind(&mut owner);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.record_process_usage("lease-a", &attempt, &process, 150, 1, u64::MAX),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);

        // update_capacity fails before the new sample epoch is adopted.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.update_capacity(
                BudgetDimension::MemoryBytes,
                Some(1_000),
                Some(300),
                100,
                7,
                2,
                u64::MAX,
            ),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);

        // expire_unlaunched fails before the terminal EXPIRED state is persisted.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        reserve(&mut owner);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.expire_unlaunched(
                "lease-a",
                &attempt,
                10_000,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..ReservationProof::default()
                },
                u64::MAX,
            ),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);

        // begin_release fails before Claimed -> ReleasePending is persisted.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        reserve(&mut owner);
        claim(&mut owner);
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.begin_release("lease-a", &attempt, ReservationProof::default(), u64::MAX),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);

        // release fails before settling frees reserved capacity.
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        propose(&mut owner);
        reserve(&mut owner);
        claim(&mut owner);
        bind(&mut owner);
        owner
            .begin_release(
                "lease-a",
                &attempt,
                ReservationProof::default(),
                owner.revision(),
            )
            .expect("begin release");
        owner.revision = u64::MAX;
        let before = owner_dump(&owner);
        assert_eq!(
            owner.release(
                "lease-a",
                &attempt,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    ..ReservationProof::default()
                },
                u64::MAX,
            ),
            Err(ResourceOwnerError::InvalidConfiguration)
        );
        assert_eq!(owner_dump(&owner), before);
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(400),
            "a failed release must not free reserved capacity"
        );
    }

    #[test]
    fn competing_release_and_claim_admits_exactly_one_winner() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        let other_attempt = authenticated_owner(7, "attempt-b");
        owner
            .propose(
                request("lease-a", "request-a", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal");
        // A never-claimed reservation cannot skip CLAIMED into release.
        assert_eq!(
            owner.begin_release(
                "lease-a",
                &attempt,
                ReservationProof::default(),
                owner.revision()
            ),
            Err(ResourceOwnerError::InvalidTransition)
        );
        owner
            .reserve("lease-a", &attempt, owner.revision())
            .expect("reserve");
        owner
            .claim("lease-a", &attempt, "worker-a", owner.revision())
            .expect("claim");
        owner
            .bind_process(
                "lease-a",
                &attempt,
                crate::resource_sampler::ProcessIdentity::new(101, 4_001),
                owner.revision(),
            )
            .expect("bind");
        owner
            .begin_release(
                "lease-a",
                &attempt,
                ReservationProof::default(),
                owner.revision(),
            )
            .expect("release pending");
        // The release wins: no competing claim can steal a release-pending lease.
        assert_eq!(
            owner.claim("lease-a", &attempt, "worker-b", owner.revision()),
            Err(ResourceOwnerError::InvalidTransition)
        );
        assert_eq!(
            owner.claim("lease-a", &other_attempt, "worker-b", owner.revision()),
            Err(ResourceOwnerError::ScopeMismatch)
        );
        assert_eq!(
            owner.release(
                "lease-a",
                &attempt,
                ReservationProof::default(),
                owner.revision()
            ),
            Err(ResourceOwnerError::MissingProof)
        );
        let released_revision = owner
            .release(
                "lease-a",
                &attempt,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    ..ReservationProof::default()
                },
                owner.revision(),
            )
            .expect("settle release");
        // Terminal RELEASED records reject late transitions and replay idempotently.
        assert_eq!(
            owner.claim("lease-a", &attempt, "worker-a", released_revision),
            Err(ResourceOwnerError::InvalidTransition)
        );
        assert_eq!(
            owner.release(
                "lease-a",
                &attempt,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    ..ReservationProof::default()
                },
                released_revision,
            ),
            Ok(released_revision)
        );
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(700)
        );
    }

    #[test]
    fn duplicate_expiry_delivery_is_an_idempotent_no_op() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        owner
            .propose(
                request("lease-a", "request-a", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal");
        owner
            .reserve("lease-a", &attempt, owner.revision())
            .expect("reserve");
        let proof = ReservationProof {
            no_launch_or_dispatch: true,
            ..ReservationProof::default()
        };
        let expired_revision = owner
            .expire_unlaunched("lease-a", &attempt, 10_000, proof, owner.revision())
            .expect("proven unlaunched expiry");
        let before = owner_dump(&owner);
        assert_eq!(
            owner.expire_unlaunched("lease-a", &attempt, 10_000, proof, expired_revision - 1),
            Ok(expired_revision),
            "duplicate expiry delivery is an idempotent no-op"
        );
        assert_eq!(owner_dump(&owner), before);
        // A staged record that was never reserved is still rejected.
        owner
            .propose(
                request("lease-b", "request-b", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal b");
        assert_eq!(
            owner.expire_unlaunched("lease-b", &attempt, 10_000, proof, owner.revision()),
            Err(ResourceOwnerError::InvalidTransition)
        );
    }

    #[test]
    fn reservation_owner_blocks_unknown_capacity_and_overcommit() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, None, Some(0), 0, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        owner
            .propose(
                request("unknown", "request-unknown", 1),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal itself reserves no capacity");
        assert_eq!(
            owner.reserve("unknown", &attempt, owner.revision()),
            Err(ResourceOwnerError::UnknownCapacity)
        );

        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 2);
        owner
            .propose(
                request("first", "request-first", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("first proposal");
        let first = owner
            .reserve("first", &attempt, owner.revision())
            .expect("first reserve");
        assert_eq!(first.state, ReservationState::Reserved);
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(400)
        );

        owner
            .propose(
                request("second", "request-second", 401),
                attempt.clone(),
                owner.revision(),
            )
            .expect("second proposal");
        assert_eq!(
            owner.reserve("second", &attempt, owner.revision()),
            Err(ResourceOwnerError::InsufficientCapacity)
        );
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(400)
        );
    }

    #[test]
    fn reservation_idempotency_scope_and_revision_fences_prevent_double_debit() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        let reservation_request = request("lease-a", "request-a", 300);
        let proposed = owner
            .propose(
                reservation_request.clone(),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal");
        let replay = owner
            .propose(reservation_request, attempt.clone(), 0)
            .expect("lost-response replay is idempotent");
        assert_eq!(proposed.reservation_id, replay.reservation_id);
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(700)
        );

        assert_eq!(
            owner.propose(
                request("lease-b", "request-a", 301),
                attempt.clone(),
                owner.revision()
            ),
            Err(ResourceOwnerError::IdempotencyConflict)
        );
        let reserved = owner
            .reserve("lease-a", &attempt, owner.revision())
            .expect("reserve");
        let replayed_reserve = owner
            .reserve("lease-a", &attempt, 0)
            .expect("reserve replay");
        assert_eq!(reserved.state, ReservationState::Reserved);
        assert_eq!(replayed_reserve.state, ReservationState::Reserved);
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(400)
        );

        let other_attempt = authenticated_owner(7, "attempt-b");
        assert_eq!(
            owner.reserve("lease-a", &other_attempt, owner.revision()),
            Err(ResourceOwnerError::ScopeMismatch)
        );
        assert_eq!(
            owner.claim(
                "lease-a",
                &attempt,
                "worker-a",
                owner.revision().saturating_sub(1),
            ),
            Err(ResourceOwnerError::StaleRevision)
        );
        assert_eq!(
            owner.reservation("lease-a").unwrap().state,
            ReservationState::Reserved
        );
        let stale_epoch = authenticated_owner(6, "attempt-a");
        assert_eq!(
            owner.reserve("lease-a", &stale_epoch, owner.revision()),
            Err(ResourceOwnerError::StaleOwnerEpoch)
        );
    }

    #[test]
    fn measured_active_usage_debits_only_unconsumed_reservation_headroom() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        owner
            .propose(
                request("lease-a", "request-a", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal");
        owner
            .reserve("lease-a", &attempt, owner.revision())
            .expect("reserve");
        owner
            .claim("lease-a", &attempt, "worker-a", owner.revision())
            .expect("authenticated worker claim");
        assert_eq!(
            owner.bind_process(
                "lease-a",
                &attempt,
                crate::resource_sampler::ProcessIdentity::new(0, 0),
                owner.revision(),
            ),
            Err(ResourceOwnerError::InvalidRequest)
        );
        let identity = crate::resource_sampler::ProcessIdentity::new(101, 4_001);
        owner
            .bind_process("lease-a", &attempt, identity.clone(), owner.revision())
            .expect("bind exact worker process generation");
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(450), 100, 2);
        owner
            .record_process_usage("lease-a", &attempt, &identity, 250, 2, owner.revision())
            .expect("same-epoch measured process usage");
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(400)
        );

        let reused_pid = crate::resource_sampler::ProcessIdentity::new(101, 9_999);
        assert_eq!(
            owner.record_process_usage("lease-a", &attempt, &reused_pid, 250, 2, owner.revision()),
            Err(ResourceOwnerError::ProcessIdentityMismatch)
        );
        set_memory_capacity(&mut owner, 7, Some(1_000), None, 100, 3);
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::UnknownCapacity
        );
        assert_eq!(
            owner
                .reservation("lease-a")
                .expect("retained reservation")
                .outstanding_units(),
            300
        );
    }

    #[test]
    fn expiry_and_quarantine_cannot_free_launched_unsettled_capacity() {
        let mut owner = reservation_owner(7);
        set_memory_capacity(&mut owner, 7, Some(1_000), Some(200), 100, 1);
        let attempt = authenticated_owner(7, "attempt-a");
        owner
            .propose(
                request("lease-a", "request-a", 300),
                attempt.clone(),
                owner.revision(),
            )
            .expect("proposal");
        owner
            .reserve("lease-a", &attempt, owner.revision())
            .expect("reserve");
        owner
            .claim("lease-a", &attempt, "worker-a", owner.revision())
            .expect("claim");
        owner
            .bind_process(
                "lease-a",
                &attempt,
                crate::resource_sampler::ProcessIdentity::new(101, 4_001),
                owner.revision(),
            )
            .expect("bind process generation before settlement");
        assert_eq!(
            owner.expire_unlaunched(
                "lease-a",
                &attempt,
                20_000,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..ReservationProof::default()
                },
                owner.revision(),
            ),
            Err(ResourceOwnerError::InvalidTransition)
        );
        owner
            .quarantine("lease-a", &attempt, owner.revision())
            .expect("uncertain launched worker is quarantined");
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(400)
        );
        assert_eq!(
            owner.begin_release(
                "lease-a",
                &attempt,
                ReservationProof::default(),
                owner.revision(),
            ),
            Err(ResourceOwnerError::MissingProof)
        );
        owner
            .begin_release(
                "lease-a",
                &attempt,
                ReservationProof {
                    reconciliation_complete: true,
                    ..ReservationProof::default()
                },
                owner.revision(),
            )
            .expect("reconciled quarantine may enter release-pending");
        assert_eq!(
            owner.release(
                "lease-a",
                &attempt,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: false,
                    ..ReservationProof::default()
                },
                owner.revision(),
            ),
            Err(ResourceOwnerError::MissingProof)
        );
        owner
            .release(
                "lease-a",
                &attempt,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    ..ReservationProof::default()
                },
                owner.revision(),
            )
            .expect("settled worker releases capacity");
        let released_revision = owner.revision();
        assert_eq!(
            owner.release(
                "lease-a",
                &attempt,
                ReservationProof::default(),
                released_revision - 1,
            ),
            Err(ResourceOwnerError::MissingProof)
        );
        assert_eq!(
            owner.release(
                "lease-a",
                &attempt,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    ..ReservationProof::default()
                },
                released_revision - 1,
            ),
            Ok(released_revision),
            "duplicate settlement delivery is an idempotent no-op"
        );
        assert_eq!(
            owner.capacity(BudgetDimension::MemoryBytes),
            Capacity::Remaining(700)
        );
    }

    #[test]
    fn unlaunched_reserved_worker_debits_capacity_once() {
        // JC-RES-012.C: 1000 - 200 - 300 - 100 = 400.
        assert_eq!(
            remaining_capacity(
                Some(1000),
                200,
                100,
                &[reservation(ReservationState::Reserved, 300, None)]
            ),
            Capacity::Remaining(400)
        );
    }

    #[test]
    fn claimed_worker_uses_only_unconsumed_headroom() {
        // JC-RES-012.D: measured_total includes 250 worker units.
        assert_eq!(
            remaining_capacity(
                Some(1000),
                450,
                100,
                &[reservation(ReservationState::Claimed, 300, Some(250))]
            ),
            Capacity::Remaining(400)
        );
        // JC-RES-012.E: worker grows above its original reservation.
        assert_eq!(
            remaining_capacity(
                Some(1000),
                550,
                100,
                &[reservation(ReservationState::Claimed, 300, Some(350))]
            ),
            Capacity::Remaining(350)
        );
    }

    #[test]
    fn missing_or_stale_owner_sample_keeps_full_reserve() {
        // JC-RES-012.F: sampler must pass None on PID reuse/unknown ownership.
        for state in [
            ReservationState::Claimed,
            ReservationState::ReleasePending,
            ReservationState::Quarantined,
        ] {
            assert_eq!(
                remaining_capacity(Some(1000), 200, 100, &[reservation(state, 300, None)]),
                Capacity::Remaining(400)
            );
            assert_eq!(
                remaining_capacity(Some(1000), 450, 100, &[reservation(state, 300, Some(250))]),
                Capacity::Remaining(400)
            );
        }
    }

    #[test]
    fn proposed_and_proven_terminal_records_do_not_reserve() {
        for state in [
            ReservationState::Proposed,
            ReservationState::Released,
            ReservationState::Expired,
        ] {
            assert_eq!(
                remaining_capacity(Some(1000), 200, 100, &[reservation(state, 300, None)]),
                Capacity::Remaining(700)
            );
        }
        // A RESERVED lease is nonterminal even when past its wall-clock expiry.
        assert_eq!(
            reservation(ReservationState::Reserved, 300, None).outstanding_units(),
            300
        );
    }

    #[test]
    fn exact_integer_math_beyond_javascript_safe_integer() {
        // JC-RES-012.G: arithmetic is exact well beyond 2^53.
        const HUGE: u64 = 9_007_199_254_740_993;
        assert_eq!(
            remaining_capacity(
                Some(HUGE + 1000),
                HUGE,
                100,
                &[reservation(ReservationState::Reserved, 300, None)]
            ),
            Capacity::Remaining(600)
        );
        // Both adding units and subtracting from a hard cap must never overflow.
        assert_eq!(
            remaining_capacity(
                Some(u64::MAX),
                u64::MAX - 2,
                10,
                &[reservation(ReservationState::Quarantined, u64::MAX, None)]
            ),
            Capacity::Remaining(0)
        );
        assert_eq!(
            remaining_capacity(
                Some(u64::MAX),
                0,
                0,
                &[reservation(ReservationState::Reserved, u64::MAX, None)]
            ),
            Capacity::Remaining(0)
        );
    }

    #[test]
    fn reservation_transition_requires_proven_no_launch_before_expiry() {
        use ReservationState::*;
        let empty = ReservationProof::default();
        assert_eq!(
            Reserved.validate_transition(Expired, empty),
            Err(ReservationTransitionError::MissingProof)
        );
        assert_eq!(
            Claimed.validate_transition(
                Expired,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..empty
                }
            ),
            Err(ReservationTransitionError::ForbiddenTransition)
        );
        assert_eq!(
            Reserved.validate_transition(
                Expired,
                ReservationProof {
                    no_launch_or_dispatch: true,
                    ..empty
                }
            ),
            Ok(())
        );
        assert_eq!(
            Expired.validate_transition(Claimed, empty),
            Err(ReservationTransitionError::ForbiddenTransition)
        );
    }

    #[test]
    fn quarantine_reconciliation_and_settlement_are_not_bypassed() {
        use ReservationState::*;
        let empty = ReservationProof::default();
        assert_eq!(Proposed.validate_transition(Reserved, empty), Ok(()));
        assert_eq!(Reserved.validate_transition(Claimed, empty), Ok(()));
        assert_eq!(Claimed.validate_transition(Quarantined, empty), Ok(()));
        assert_eq!(
            Quarantined.validate_transition(ReleasePending, empty),
            Err(ReservationTransitionError::MissingProof)
        );
        assert_eq!(
            Quarantined.validate_transition(
                ReleasePending,
                ReservationProof {
                    reconciliation_complete: true,
                    ..empty
                }
            ),
            Ok(())
        );
        assert_eq!(
            ReleasePending.validate_transition(Released, empty),
            Err(ReservationTransitionError::MissingProof)
        );
        assert_eq!(
            ReleasePending.validate_transition(
                Released,
                ReservationProof {
                    owned_process_exited: true,
                    ..empty
                }
            ),
            Err(ReservationTransitionError::MissingProof)
        );
        assert_eq!(
            ReleasePending.validate_transition(
                Released,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    ..empty
                }
            ),
            Ok(())
        );
        assert_eq!(
            Quarantined.validate_transition(
                Released,
                ReservationProof {
                    owned_process_exited: true,
                    effects_settled: true,
                    reconciliation_complete: true,
                    ..empty
                }
            ),
            Err(ReservationTransitionError::ForbiddenTransition)
        );
        assert_eq!(
            Released.validate_transition(Claimed, empty),
            Err(ReservationTransitionError::ForbiddenTransition)
        );
        assert_eq!(
            Released.validate_transition(Released, empty),
            Err(ReservationTransitionError::ForbiddenTransition)
        );
    }

    #[test]
    fn every_terminal_state_is_one_way() {
        use ReservationState::*;
        let proof = ReservationProof {
            no_launch_or_dispatch: true,
            owned_process_exited: true,
            effects_settled: true,
            reconciliation_complete: true,
        };
        for terminal in [Expired, Released] {
            for destination in [
                Proposed,
                Reserved,
                Claimed,
                ReleasePending,
                Quarantined,
                Released,
                Expired,
            ] {
                assert_eq!(
                    terminal.validate_transition(destination, proof),
                    Err(ReservationTransitionError::ForbiddenTransition)
                );
            }
        }
    }

    #[test]
    fn absent_hard_limit_is_unknown_not_unbounded() {
        assert_eq!(
            remaining_capacity(None, 0, 0, &[]),
            Capacity::UnknownCapacity
        );
        assert_eq!(
            remaining_capacity(Some(250), 200, 100, &[]),
            Capacity::Remaining(0)
        );
    }

    fn pressure(usage: u64, soft: Option<u64>, hard: Option<u64>) -> PressureObservation {
        PressureObservation {
            limits: PressureLimits { soft, hard },
            measured_usage: usage,
            os_quota_alarm: false,
            sustained_calm: false,
        }
    }

    #[test]
    fn pressure_escalates_immediately_and_holds_without_sustained_calm() {
        use PressureState::*;
        assert_eq!(Normal.evaluate(pressure(50, Some(100), Some(200))), Normal);
        assert_eq!(
            Normal.evaluate(pressure(100, Some(100), Some(200))),
            SoftPressure
        );
        assert_eq!(
            SoftPressure.evaluate(pressure(150, Some(100), Some(200))),
            SoftPressure
        );
        assert_eq!(
            SoftPressure.evaluate(pressure(200, Some(100), Some(200))),
            HardPressure
        );
        assert_eq!(
            Normal.evaluate(pressure(250, Some(100), Some(200))),
            HardPressure
        );
        // One calm reading below the soft cap does not clear SOFT or HARD pressure.
        assert_eq!(
            SoftPressure.evaluate(pressure(10, Some(100), Some(200))),
            SoftPressure
        );
        assert_eq!(
            HardPressure.evaluate(pressure(10, Some(100), Some(200))),
            HardPressure
        );
    }

    #[test]
    fn soft_and_hard_pressure_recover_through_recovering_with_sustained_calm() {
        use PressureState::*;
        let mut calm = pressure(10, Some(100), Some(200));
        calm.sustained_calm = true;
        // A soft-band reading while HARD does not downgrade directly to SOFT_PRESSURE.
        assert_eq!(
            HardPressure.evaluate(pressure(150, Some(100), Some(200))),
            HardPressure
        );
        assert_eq!(HardPressure.evaluate(calm), Recovering);
        assert_eq!(Recovering.evaluate(calm), Normal);
        assert_eq!(SoftPressure.evaluate(calm), Recovering);
        assert_eq!(Recovering.evaluate(calm), Normal);
        // Re-escalation out of RECOVERING is immediate.
        assert_eq!(
            Recovering.evaluate(pressure(200, Some(100), Some(200))),
            HardPressure
        );
        assert_eq!(
            Recovering.evaluate(pressure(100, Some(100), Some(200))),
            SoftPressure
        );
        // RECOVERING holds until a sustained calm reading arrives.
        assert_eq!(
            Recovering.evaluate(pressure(10, Some(100), Some(200))),
            Recovering
        );
    }

    #[test]
    fn os_quota_alarm_escalates_directly_to_hard_pressure() {
        use PressureState::*;
        let mut alarm = pressure(10, Some(100), Some(200));
        alarm.os_quota_alarm = true;
        assert_eq!(Normal.evaluate(alarm), HardPressure);
        assert_eq!(Recovering.evaluate(alarm), HardPressure);
        // An alarm is never cleared in the same observation that reports it.
        let mut calm_alarm = alarm;
        calm_alarm.sustained_calm = true;
        assert_eq!(HardPressure.evaluate(calm_alarm), HardPressure);
    }

    #[test]
    fn pressure_never_invents_limits_for_unknown_capacity() {
        use PressureState::*;
        // No configured caps and no OS alarm: state is unchanged; new costly admission is
        // blocked separately through Capacity::UnknownCapacity, not by a fabricated pressure.
        assert_eq!(Normal.evaluate(pressure(10_000, None, None)), Normal);
        assert_eq!(
            SoftPressure.evaluate(pressure(10_000, None, None)),
            SoftPressure
        );
        assert_eq!(
            Recovering.evaluate(pressure(10_000, None, None)),
            Recovering
        );
    }

    #[test]
    fn owned_pressure_controller_derives_calm_window_from_fresh_samples() {
        use PressureState::*;
        let mut controller = ResourcePressureControllerV1::new(
            PressureLimits { soft: Some(100), hard: Some(200) },
            80,
            2,
            7,
        ).expect("valid pressure policy");
        assert_eq!(controller.observe(7, 1, Some(100), false), Ok(SoftPressure));
        assert_eq!(controller.observe(7, 2, Some(79), false), Ok(SoftPressure));
        assert_eq!(controller.observe(7, 3, Some(79), false), Ok(Recovering));
        assert_eq!(controller.observe(7, 4, Some(79), false), Ok(Normal));
        assert_eq!(controller.observe(7, 4, Some(1), false), Err(PressureControllerErrorV1::StaleSample));
        // Unknown usage and an OS alarm cannot create a calm transition.
        assert_eq!(controller.observe(7, 5, None, false), Ok(Normal));
        assert_eq!(controller.observe(7, 6, None, true), Ok(HardPressure));
        // A new owner epoch fences prior calm history and requires fresh samples.
        assert_eq!(controller.observe(8, 1, Some(79), false), Ok(Recovering));
        assert_eq!(controller.owner_epoch(), 8);
        assert_eq!(controller.observe(7, 2, Some(79), false), Err(PressureControllerErrorV1::StaleOwnerEpoch));
    }

    #[test]
    fn owned_pressure_controller_rejects_unordered_policy_and_zero_sample() {
        assert_eq!(
            ResourcePressureControllerV1::new(
                PressureLimits { soft: Some(100), hard: Some(90) }, 80, 2, 1,
            ),
            Err(PressureControllerErrorV1::InvalidConfiguration),
        );
        let mut controller = ResourcePressureControllerV1::new(
            PressureLimits { soft: Some(100), hard: None }, 80, 2, 1,
        ).unwrap();
        assert_eq!(controller.observe(1, 0, Some(10), false), Err(PressureControllerErrorV1::StaleSample));
    }

    #[test]
    fn owner_epoch_rotation_requires_fresh_calm_before_normal_state() {
        use PressureState::*;
        let mut controller = ResourcePressureControllerV1::new(
            PressureLimits { soft: Some(100), hard: Some(200) }, 80, 2, 1,
        ).unwrap();
        assert_eq!(controller.observe(2, 1, Some(20), false), Ok(Recovering));
        // Two calm samples satisfy the configured window, then the state moves
        // one hysteresis step from RECOVERING to NORMAL.
        assert_eq!(controller.observe(2, 2, Some(20), false), Ok(Normal));
        assert_eq!(controller.observe(2, 3, Some(20), false), Ok(Normal));
    }

    #[test]
    fn canonical_state_vocabulary_has_no_aliases() {
        // JC-RES-012.I: exhaustive matches compile only for the canonical §11.20/§18.18 states;
        // reintroducing ACTIVE/UNKNOWN reservations or SOFT/HARD pressure aliases as variants
        // breaks this fixture at compile time. Strict wire decoding lives in the owner crate.
        let reservation_states = [
            ReservationState::Proposed,
            ReservationState::Reserved,
            ReservationState::Claimed,
            ReservationState::ReleasePending,
            ReservationState::Quarantined,
            ReservationState::Released,
            ReservationState::Expired,
        ];
        let names: Vec<&str> = reservation_states
            .into_iter()
            .map(|state| match state {
                ReservationState::Proposed => "PROPOSED",
                ReservationState::Reserved => "RESERVED",
                ReservationState::Claimed => "CLAIMED",
                ReservationState::ReleasePending => "RELEASE_PENDING",
                ReservationState::Quarantined => "QUARANTINED",
                ReservationState::Released => "RELEASED",
                ReservationState::Expired => "EXPIRED",
            })
            .collect();
        assert_eq!(
            names,
            [
                "PROPOSED",
                "RESERVED",
                "CLAIMED",
                "RELEASE_PENDING",
                "QUARANTINED",
                "RELEASED",
                "EXPIRED"
            ]
        );
        let pressure_states = [
            PressureState::Normal,
            PressureState::SoftPressure,
            PressureState::HardPressure,
            PressureState::Recovering,
        ];
        let names: Vec<&str> = pressure_states
            .into_iter()
            .map(|state| match state {
                PressureState::Normal => "NORMAL",
                PressureState::SoftPressure => "SOFT_PRESSURE",
                PressureState::HardPressure => "HARD_PRESSURE",
                PressureState::Recovering => "RECOVERING",
            })
            .collect();
        assert_eq!(
            names,
            ["NORMAL", "SOFT_PRESSURE", "HARD_PRESSURE", "RECOVERING"]
        );
    }

    #[test]
    fn unlaunched_reservation_expires_but_launched_uncertainty_quarantines() {
        // JC-RES-012.H: a RESERVED record with proven absence of dispatch may expire; any
        // timeout after launch is QUARANTINED and keeps holding capacity until reconciliation
        // and confirmed owner/process/effect settlement.
        use ReservationState::*;
        let unlaunched = ReservationProof {
            no_launch_or_dispatch: true,
            ..ReservationProof::default()
        };
        assert_eq!(Reserved.validate_transition(Expired, unlaunched), Ok(()));
        assert_eq!(
            Claimed.validate_transition(Expired, unlaunched),
            Err(ReservationTransitionError::ForbiddenTransition)
        );
        assert_eq!(
            Claimed.validate_transition(Quarantined, ReservationProof::default()),
            Ok(())
        );
        let quarantined = reservation(Quarantined, 300, Some(100));
        assert_eq!(quarantined.outstanding_units(), 200);
        assert_eq!(
            Quarantined.validate_transition(ReleasePending, ReservationProof::default()),
            Err(ReservationTransitionError::MissingProof)
        );
    }
}
