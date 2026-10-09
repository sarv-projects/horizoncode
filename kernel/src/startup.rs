//! Startup readiness choreography for the future kernel supervisor.
//!
//! This gate enforces the order in §13.1/§4.7 after the owning subsystems report their
//! milestones. It does not authenticate a peer, validate an event log, allocate a
//! durable owner epoch, reconcile effects, supervise a process, or establish release
//! readiness. In particular, callers must authenticate the OS channel before recording
//! peer authentication; a matching `KernelHelloV1` nonce is not that authentication.

use std::fmt;
use std::num::NonZeroU64;

use crate::protocol::{KernelStartupStatusV1, TypedErrorV1};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupPhase {
    AwaitingPeerAuthentication,
    AwaitingHelloNegotiation,
    AwaitingCanonicalStateValidation,
    AwaitingOwnerEpoch,
    Reconciling,
    AwaitingRequiredServices,
    Ready,
    Fenced,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum StartupTransitionError {
    WrongPhase {
        expected: StartupPhase,
        actual: StartupPhase,
    },
    InvalidOwnerEpoch,
    ApplicationRpcBeforeReady {
        actual: StartupPhase,
    },
}

impl fmt::Display for StartupTransitionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WrongPhase { expected, actual } => {
                write!(
                    formatter,
                    "startup milestone requires {expected:?}, found {actual:?}"
                )
            }
            Self::InvalidOwnerEpoch => formatter.write_str("owner epoch must be nonzero"),
            Self::ApplicationRpcBeforeReady { actual } => {
                write!(
                    formatter,
                    "application RPC rejected while kernel is {actual:?}"
                )
            }
        }
    }
}

impl std::error::Error for StartupTransitionError {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StartupGate {
    phase: StartupPhase,
    owner_epoch: Option<NonZeroU64>,
    failure: Option<TypedErrorV1>,
}

impl Default for StartupGate {
    fn default() -> Self {
        Self::new()
    }
}

impl StartupGate {
    pub const fn new() -> Self {
        Self {
            phase: StartupPhase::AwaitingPeerAuthentication,
            owner_epoch: None,
            failure: None,
        }
    }

    pub const fn phase(&self) -> StartupPhase {
        self.phase
    }

    /// Returns an epoch only while this gate admits managed work.
    pub const fn ready_owner_epoch(&self) -> Option<NonZeroU64> {
        if matches!(self.phase, StartupPhase::Ready) {
            self.owner_epoch
        } else {
            None
        }
    }

    pub const fn admits_managed_work(&self) -> bool {
        matches!(self.phase, StartupPhase::Ready)
    }

    /// Returns the wire status for the latest startup milestone.
    pub fn status(&self) -> KernelStartupStatusV1 {
        match self.phase {
            StartupPhase::Ready => KernelStartupStatusV1::Ready,
            StartupPhase::Failed | StartupPhase::Fenced => KernelStartupStatusV1::Failed(Box::new(
                self.failure
                    .clone()
                    .expect("failed startup gate always records a typed error"),
            )),
            _ => KernelStartupStatusV1::Starting,
        }
    }

    /// Rejects application requests until all startup milestones are complete.
    pub fn admit_application_rpc(&self) -> Result<(), StartupTransitionError> {
        if self.admits_managed_work() {
            Ok(())
        } else {
            Err(StartupTransitionError::ApplicationRpcBeforeReady { actual: self.phase })
        }
    }

    /// Record only after the OS transport has authenticated this exact channel peer.
    /// The protocol nonce is an additional binding, not a substitute for this step.
    pub fn record_peer_authenticated(&mut self) -> Result<(), StartupTransitionError> {
        self.advance(
            StartupPhase::AwaitingPeerAuthentication,
            StartupPhase::AwaitingHelloNegotiation,
        )
    }

    pub fn record_hello_negotiated(&mut self) -> Result<(), StartupTransitionError> {
        self.advance(
            StartupPhase::AwaitingHelloNegotiation,
            StartupPhase::AwaitingCanonicalStateValidation,
        )
    }

    pub fn record_canonical_state_validated(&mut self) -> Result<(), StartupTransitionError> {
        self.advance(
            StartupPhase::AwaitingCanonicalStateValidation,
            StartupPhase::AwaitingOwnerEpoch,
        )
    }

    /// Record an epoch returned by the canonical supervisor owner; this gate never mints one.
    pub fn record_owner_epoch_acquired(
        &mut self,
        epoch: u64,
    ) -> Result<(), StartupTransitionError> {
        self.require_phase(StartupPhase::AwaitingOwnerEpoch)?;
        let Some(epoch) = NonZeroU64::new(epoch) else {
            return Err(StartupTransitionError::InvalidOwnerEpoch);
        };
        self.owner_epoch = Some(epoch);
        self.phase = StartupPhase::Reconciling;
        Ok(())
    }

    pub fn record_recovery_reconciled(&mut self) -> Result<(), StartupTransitionError> {
        self.advance(
            StartupPhase::Reconciling,
            StartupPhase::AwaitingRequiredServices,
        )
    }

    pub fn record_required_services_ready(&mut self) -> Result<(), StartupTransitionError> {
        self.advance(StartupPhase::AwaitingRequiredServices, StartupPhase::Ready)
    }

    /// Permanently closes this startup instance after ownership is lost.
    pub fn fence(&mut self, error: TypedErrorV1) {
        if !matches!(self.phase, StartupPhase::Failed | StartupPhase::Fenced) {
            self.failure = Some(error);
            self.phase = StartupPhase::Fenced;
        }
    }

    /// Permanently closes this startup instance after a required startup failure.
    pub fn fail(&mut self, error: TypedErrorV1) {
        if !matches!(self.phase, StartupPhase::Fenced) {
            self.failure = Some(error);
            self.phase = StartupPhase::Failed;
        }
    }

    fn advance(
        &mut self,
        expected: StartupPhase,
        next: StartupPhase,
    ) -> Result<(), StartupTransitionError> {
        self.require_phase(expected)?;
        self.phase = next;
        Ok(())
    }

    fn require_phase(&self, expected: StartupPhase) -> Result<(), StartupTransitionError> {
        if self.phase != expected {
            return Err(StartupTransitionError::WrongPhase {
                expected,
                actual: self.phase,
            });
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::{ErrorCategoryV1, RetryClassV1};

    fn reach_ready(gate: &mut StartupGate) {
        gate.record_peer_authenticated().unwrap();
        gate.record_hello_negotiated().unwrap();
        gate.record_canonical_state_validated().unwrap();
        gate.record_owner_epoch_acquired(7).unwrap();
        gate.record_recovery_reconciled().unwrap();
        gate.record_required_services_ready().unwrap();
    }

    fn startup_failure() -> TypedErrorV1 {
        TypedErrorV1 {
            code: "STARTUP_FAILED".to_owned(),
            category: ErrorCategoryV1::Unavailable,
            message: "required kernel service failed".to_owned(),
            retry_class: RetryClassV1::UserActionRequired,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        }
    }

    #[test]
    fn startup_status_tracks_readiness_and_application_rpc_admission() {
        let mut gate = StartupGate::new();
        assert_eq!(gate.status(), KernelStartupStatusV1::Starting);
        assert!(gate.admit_application_rpc().is_err());

        reach_ready(&mut gate);
        assert_eq!(gate.status(), KernelStartupStatusV1::Ready);
        assert!(gate.admit_application_rpc().is_ok());

        let failure = startup_failure();
        gate.fail(failure.clone());
        assert_eq!(
            gate.status(),
            KernelStartupStatusV1::Failed(Box::new(failure))
        );
        assert!(gate.admit_application_rpc().is_err());
    }

    #[test]
    fn managed_work_is_admitted_only_after_ordered_startup_milestones() {
        let mut gate = StartupGate::new();
        assert_eq!(gate.phase(), StartupPhase::AwaitingPeerAuthentication);
        assert!(!gate.admits_managed_work());
        assert_eq!(gate.ready_owner_epoch(), None);

        assert!(matches!(
            gate.record_hello_negotiated(),
            Err(StartupTransitionError::WrongPhase {
                expected: StartupPhase::AwaitingHelloNegotiation,
                actual: StartupPhase::AwaitingPeerAuthentication,
            })
        ));
        assert_eq!(gate.phase(), StartupPhase::AwaitingPeerAuthentication);

        gate.record_peer_authenticated().unwrap();
        gate.record_hello_negotiated().unwrap();
        gate.record_canonical_state_validated().unwrap();
        assert!(matches!(
            gate.record_owner_epoch_acquired(0),
            Err(StartupTransitionError::InvalidOwnerEpoch)
        ));
        assert_eq!(gate.phase(), StartupPhase::AwaitingOwnerEpoch);
        assert!(!gate.admits_managed_work());

        gate.record_owner_epoch_acquired(7).unwrap();
        assert_eq!(gate.phase(), StartupPhase::Reconciling);
        assert_eq!(gate.ready_owner_epoch(), None);
        gate.record_recovery_reconciled().unwrap();
        assert!(!gate.admits_managed_work());
        gate.record_required_services_ready().unwrap();

        assert_eq!(gate.phase(), StartupPhase::Ready);
        assert!(gate.admits_managed_work());
        assert_eq!(gate.ready_owner_epoch(), NonZeroU64::new(7));
    }

    #[test]
    fn required_startup_failure_cannot_be_reopened() {
        let mut gate = StartupGate::new();
        gate.fail(startup_failure());
        assert_eq!(gate.phase(), StartupPhase::Failed);
        assert!(!gate.admits_managed_work());
        assert!(matches!(
            gate.record_peer_authenticated(),
            Err(StartupTransitionError::WrongPhase {
                expected: StartupPhase::AwaitingPeerAuthentication,
                actual: StartupPhase::Failed,
            })
        ));
    }

    #[test]
    fn ownership_loss_fences_a_ready_gate_and_hides_its_epoch() {
        let mut gate = StartupGate::new();
        reach_ready(&mut gate);
        assert!(gate.admits_managed_work());

        gate.fence(startup_failure());
        assert_eq!(gate.phase(), StartupPhase::Fenced);
        assert!(!gate.admits_managed_work());
        assert_eq!(gate.ready_owner_epoch(), None);
        assert!(gate.record_peer_authenticated().is_err());
        gate.fail(startup_failure());
        assert_eq!(gate.phase(), StartupPhase::Fenced);
    }
}
