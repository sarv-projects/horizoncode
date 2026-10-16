//! Conservative, deterministic resource headroom calculation.
//!
//! This is a pure admission *input*, not a permission check, worker lease,
//! OS sampler, executor, or live ResourcePolicyV1 service. OS quota discovery,
//! sample trust/process identity and atomic lease accounting remain separate
//! work. Missing effective capacity must never mean infinite free resources.
//! [`PressureState::evaluate`] is a derived control hint with the same
//! boundary: it never authorizes or performs termination, eviction or launch.

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

impl PressureState {
    /// Pure transition for the §18.18/§11.20 controller. Escalation is immediate, including
    /// `NORMAL → HARD_PRESSURE` on an OS quota alarm. De-escalation requires `sustained_calm`
    /// and never skips `HARD_PRESSURE → RECOVERING → NORMAL`; `HARD_PRESSURE` does not fall back
    /// to `SOFT_PRESSURE` while usage merely drops below the hard limit.
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
            _ => {
                if limits.soft.is_some_and(|soft| measured_usage >= soft) {
                    SoftPressure
                } else if sustained_calm {
                    Normal
                } else {
                    self
                }
            }
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
    fn hard_pressure_recovers_only_through_recovering_with_sustained_calm() {
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
        assert_eq!(SoftPressure.evaluate(calm), Normal);
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
