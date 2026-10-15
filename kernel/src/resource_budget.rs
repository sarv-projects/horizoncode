//! Conservative, deterministic resource headroom calculation.
//!
//! This is a pure admission *input*, not a permission check, worker lease,
//! OS sampler, executor, or live ResourcePolicyV1 service. OS quota discovery,
//! sample trust/process identity and atomic lease accounting remain separate
//! work. Missing effective capacity must never mean infinite free resources.

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
            ReservationState::Proposed | ReservationState::Released | ReservationState::Expired => 0,
            ReservationState::Reserved => self.reserved_units,
            ReservationState::Claimed | ReservationState::ReleasePending | ReservationState::Quarantined => {
                self.reserved_units.saturating_sub(self.already_counted_units.unwrap_or(0))
            }
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
    let reserved_headroom = reservations.iter()
        .fold(0u128, |sum, reservation| sum.saturating_add(u128::from(reservation.outstanding_units())));
    let charged = u128::from(measured_total)
        .saturating_add(u128::from(safety_reserve))
        .saturating_add(reserved_headroom);
    Capacity::Remaining(u128::from(hard_limit).saturating_sub(charged) as u64)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reservation(state: ReservationState, reserved_units: u64, counted: Option<u64>) -> Reservation {
        Reservation { state, reserved_units, already_counted_units: counted }
    }

    #[test]
    fn unlaunched_reserved_worker_debits_capacity_once() {
        // JC-RES-012.C: 1000 - 200 - 300 - 100 = 400.
        assert_eq!(remaining_capacity(Some(1000), 200, 100,
            &[reservation(ReservationState::Reserved, 300, None)]),
            Capacity::Remaining(400));
    }

    #[test]
    fn claimed_worker_uses_only_unconsumed_headroom() {
        // JC-RES-012.D: measured_total includes 250 worker units.
        assert_eq!(remaining_capacity(Some(1000), 450, 100,
            &[reservation(ReservationState::Claimed, 300, Some(250))]),
            Capacity::Remaining(400));
        // JC-RES-012.E: worker grows above its original reservation.
        assert_eq!(remaining_capacity(Some(1000), 550, 100,
            &[reservation(ReservationState::Claimed, 300, Some(350))]),
            Capacity::Remaining(350));
    }

    #[test]
    fn missing_or_stale_owner_sample_keeps_full_reserve() {
        // JC-RES-012.F: sampler must pass None on PID reuse/unknown ownership.
        for state in [ReservationState::Claimed, ReservationState::ReleasePending, ReservationState::Quarantined] {
            assert_eq!(remaining_capacity(Some(1000), 200, 100,
                &[reservation(state, 300, None)]), Capacity::Remaining(400));
            assert_eq!(remaining_capacity(Some(1000), 450, 100,
                &[reservation(state, 300, Some(250))]), Capacity::Remaining(400));
        }
    }

    #[test]
    fn proposed_and_proven_terminal_records_do_not_reserve() {
        for state in [ReservationState::Proposed, ReservationState::Released, ReservationState::Expired] {
            assert_eq!(remaining_capacity(Some(1000), 200, 100,
                &[reservation(state, 300, None)]), Capacity::Remaining(700));
        }
        // A RESERVED lease is nonterminal even when past its wall-clock expiry.
        assert_eq!(reservation(ReservationState::Reserved, 300, None).outstanding_units(), 300);
    }

    #[test]
    fn exact_integer_math_beyond_javascript_safe_integer() {
        // JC-RES-012.G: arithmetic is exact well beyond 2^53.
        const HUGE: u64 = 9_007_199_254_740_993;
        assert_eq!(remaining_capacity(Some(HUGE + 1000), HUGE, 100,
            &[reservation(ReservationState::Reserved, 300, None)]),
            Capacity::Remaining(600));
        // Both adding units and subtracting from a hard cap must never overflow.
        assert_eq!(remaining_capacity(Some(u64::MAX), u64::MAX - 2, 10,
            &[reservation(ReservationState::Quarantined, u64::MAX, None)]),
            Capacity::Remaining(0));
        assert_eq!(remaining_capacity(Some(u64::MAX), 0, 0,
            &[reservation(ReservationState::Reserved, u64::MAX, None)]),
            Capacity::Remaining(0));
    }

    #[test]
    fn absent_hard_limit_is_unknown_not_unbounded() {
        assert_eq!(remaining_capacity(None, 0, 0, &[]), Capacity::UnknownCapacity);
        assert_eq!(remaining_capacity(Some(250), 200, 100, &[]), Capacity::Remaining(0));
    }
}
