//! The injectable clock every durable store stamps records with.
//!
//! `ARCH/23-VERIFICATION.md` makes an injectable clock a **hard prerequisite**
//! for determinism: a test may not depend on wall-clock time, and no test may
//! synchronize by sleeping. Production code therefore never calls
//! `SystemTime::now` directly — it takes a [`Clock`], so a test can hand over a
//! clock it advances by hand and get byte-identical stored records.

use std::fmt;
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

/// A source of UTC epoch milliseconds.
pub trait Clock: Send + Sync + fmt::Debug {
    /// Returns the current time in epoch milliseconds, saturating at zero
    /// before the epoch rather than panicking.
    fn now_ms(&self) -> i64;
}

/// The production clock: the host wall clock.
#[derive(Clone, Copy, Debug, Default)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> i64 {
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0)
    }
}

/// Returns the shared production clock.
///
/// Callers store an `Arc<dyn Clock>` so a test can substitute its own without
/// changing a signature.
#[must_use]
pub fn system_clock() -> Arc<dyn Clock> {
    Arc::new(SystemClock)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Debug)]
    struct Frozen(i64);

    impl Clock for Frozen {
        fn now_ms(&self) -> i64 {
            self.0
        }
    }

    #[test]
    fn an_injected_clock_is_the_only_source_of_record_time() {
        assert_eq!(Clock::now_ms(&Frozen(1_700_000_000_123)), 1_700_000_000_123);
        // The production clock is monotonic-ish and never panics.
        assert!(SystemClock.now_ms() > 0);
        assert!(system_clock().now_ms() > 0);
    }
}
