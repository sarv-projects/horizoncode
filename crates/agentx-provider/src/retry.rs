//! Bounded retry with exponential backoff and jitter, honoring `Retry-After`
//! (`ARCH/11-PROVIDER.md` §3).

use std::time::Duration;

/// Retry configuration for the request-start phase.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct RetryPolicy {
    /// Maximum number of retries after the initial attempt.
    pub max_retries: u32,
    /// Base delay for the exponential backoff.
    pub base_delay: Duration,
    /// Ceiling applied to any single computed delay.
    pub max_delay: Duration,
    /// Whether a provider `Retry-After` header overrides computed backoff.
    pub respect_retry_after: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay: Duration::from_millis(250),
            max_delay: Duration::from_secs(8),
            respect_retry_after: true,
        }
    }
}

/// The decision for one failed attempt.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RetryDecision {
    /// Wait, then retry.
    RetryAfter(Duration),
    /// Give up; the caller surfaces the failure.
    Stop,
}

impl RetryPolicy {
    /// Computes the delay before retry number `attempt` (zero-based).
    ///
    /// `jitter` must be a uniform sample in `[0, 1)`, supplied by the caller so
    /// tests are deterministic. Full jitter is used: `delay = cap * jitter`.
    #[must_use]
    pub fn delay_for(
        &self,
        attempt: u32,
        retry_after: Option<Duration>,
        jitter: f64,
    ) -> Option<Duration> {
        if attempt >= self.max_retries {
            return None;
        }
        if self.respect_retry_after
            && let Some(after) = retry_after
        {
            return Some(after.min(self.max_delay));
        }
        let factor = 2u32.saturating_pow(attempt.min(16));
        let cap = self.base_delay.saturating_mul(factor).min(self.max_delay);
        let millis = cap.as_secs_f64() * jitter.clamp(0.0, 1.0);
        Some(Duration::from_secs_f64(millis))
    }

    /// Returns the retry decision for `attempt` using `jitter` and an optional
    /// provider-supplied delay.
    #[must_use]
    pub fn decide(
        &self,
        attempt: u32,
        retry_after: Option<Duration>,
        jitter: f64,
    ) -> RetryDecision {
        match self.delay_for(attempt, retry_after, jitter) {
            Some(delay) => RetryDecision::RetryAfter(delay),
            None => RetryDecision::Stop,
        }
    }
}

/// Parses a `Retry-After` header value.
///
/// Accepts integer seconds, fractional seconds, and HTTP-date per RFC 9110.
#[must_use]
pub fn parse_retry_after(value: &str) -> Option<Duration> {
    let value = value.trim();
    if value.is_empty() {
        return None;
    }
    if let Ok(seconds) = value.parse::<u64>() {
        return Some(Duration::from_secs(seconds));
    }
    if let Ok(seconds) = value.parse::<f64>()
        && seconds.is_finite()
        && seconds >= 0.0
    {
        return Some(Duration::from_secs_f64(seconds));
    }
    if let Ok(deadline) = httpdate::parse_http_date(value)
        && let Ok(now) = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH)
    {
        let deadline_ms = deadline
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i128)
            .unwrap_or(0);
        let now_ms = now.as_millis() as i128;
        let delta_ms = deadline_ms - now_ms;
        if delta_ms > 0 {
            return Some(Duration::from_millis(delta_ms as u64));
        }
        return Some(Duration::ZERO);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_jitter_scales_the_exponential_cap() {
        let policy = RetryPolicy {
            max_retries: 20,
            base_delay: Duration::from_millis(100),
            max_delay: Duration::from_secs(10),
            respect_retry_after: true,
        };
        // attempt 0 cap = 100ms; jitter 0.5 -> 50ms.
        assert_eq!(
            policy.delay_for(0, None, 0.5),
            Some(Duration::from_millis(50))
        );
        // attempt 2 cap = 400ms; jitter 1.0 -> 400ms.
        assert_eq!(
            policy.delay_for(2, None, 1.0),
            Some(Duration::from_millis(400))
        );
        // attempt 10 cap = 102.4s, clamped to max_delay.
        assert_eq!(
            policy.delay_for(10, None, 1.0),
            Some(Duration::from_secs(10))
        );
        // beyond the retry budget there is no delay.
        assert_eq!(policy.delay_for(20, None, 0.5), None);
    }

    #[test]
    fn retry_after_overrides_backoff_but_is_capped() {
        let policy = RetryPolicy {
            max_delay: Duration::from_secs(2),
            ..RetryPolicy::default()
        };
        assert_eq!(
            policy.delay_for(0, Some(Duration::from_secs(1)), 0.1),
            Some(Duration::from_secs(1))
        );
        assert_eq!(
            policy.delay_for(0, Some(Duration::from_secs(60)), 0.1),
            Some(Duration::from_secs(2))
        );
    }

    #[test]
    fn parses_retry_after_forms() {
        assert_eq!(parse_retry_after("3"), Some(Duration::from_secs(3)));
        assert_eq!(parse_retry_after("0.5"), Some(Duration::from_millis(500)));
        assert!(parse_retry_after("").is_none());
        assert!(parse_retry_after("not-a-date").is_none());
        // HTTP-date in the past clamps to zero.
        let past = httpdate::fmt_http_date(std::time::SystemTime::UNIX_EPOCH);
        assert_eq!(parse_retry_after(&past), Some(Duration::ZERO));
    }

    #[test]
    fn retry_after_can_be_ignored() {
        let policy = RetryPolicy {
            respect_retry_after: false,
            base_delay: Duration::from_millis(100),
            ..RetryPolicy::default()
        };
        assert_eq!(
            policy.delay_for(0, Some(Duration::from_secs(30)), 1.0),
            Some(Duration::from_millis(100))
        );
    }
}
