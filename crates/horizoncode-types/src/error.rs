//! Typed provider errors and their retry classification (`ARCH/11-PROVIDER.md`).
//!
//! Error messages are constructed from already-redacted text: the provider
//! adapter must never place a credential in `message` (`REQ-PROV-004`).

use std::fmt;
use std::time::Duration;

use serde::{Deserialize, Serialize};

/// The provider failure taxonomy.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ProviderErrorKind {
    /// Missing, invalid, expired or insufficient credentials.
    Auth,
    /// Rate limited; carries `retry_after` when the provider supplies it.
    RateLimit,
    /// Quota or plan exhausted; not retryable.
    Quota,
    /// The request was rejected as invalid.
    InvalidRequest,
    /// The request exceeded the model's context window.
    ContextOverflow,
    /// Provider-internal failure (typically 5xx); retryable within bounds.
    ProviderInternal,
    /// Network, timeout or idle-watchdog failure.
    Transport,
    /// The provider response exceeded a local adapter body/frame ceiling.
    ResponseLimit,
    /// Any unclassified failure.
    Unknown,
}

impl ProviderErrorKind {
    /// Returns the stable, machine-readable kind name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Auth => "auth",
            Self::RateLimit => "rate_limit",
            Self::Quota => "quota",
            Self::InvalidRequest => "invalid_request",
            Self::ContextOverflow => "context_overflow",
            Self::ProviderInternal => "provider_internal",
            Self::Transport => "transport",
            Self::ResponseLimit => "response_limit",
            Self::Unknown => "unknown",
        }
    }

    /// Returns whether this class is worth retrying by default.
    #[must_use]
    pub fn default_retryable(self) -> bool {
        matches!(
            self,
            Self::RateLimit | Self::ProviderInternal | Self::Transport
        )
    }
}

/// A classified provider failure.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProviderError {
    /// The failure class.
    pub kind: ProviderErrorKind,
    /// A redacted, human-readable message. Never contains credentials.
    pub message: String,
    /// The HTTP status, when the failure came from a response.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    /// How long the provider asked the caller to wait.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub retry_after: Option<Duration>,
    /// Whether the caller may retry this failure.
    pub retryable: bool,
}

impl ProviderError {
    fn build(kind: ProviderErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
            status: None,
            retry_after: None,
            retryable: kind.default_retryable(),
        }
    }

    /// Builds an authentication failure.
    #[must_use]
    pub fn auth(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::Auth, message)
    }

    /// Builds a rate-limit failure.
    #[must_use]
    pub fn rate_limit(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::RateLimit, message)
    }

    /// Builds a quota-exhausted failure.
    #[must_use]
    pub fn quota(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::Quota, message)
    }

    /// Builds an invalid-request failure.
    #[must_use]
    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::InvalidRequest, message)
    }

    /// Builds a context-overflow failure.
    #[must_use]
    pub fn context_overflow(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::ContextOverflow, message)
    }

    /// Builds a provider-internal failure.
    #[must_use]
    pub fn provider_internal(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::ProviderInternal, message)
    }

    /// Builds a transport failure.
    #[must_use]
    pub fn transport(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::Transport, message)
    }

    /// Builds a non-retryable local provider-response ceiling failure.
    #[must_use]
    pub fn response_limit(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::ResponseLimit, message)
    }

    /// Builds an unclassified failure.
    #[must_use]
    pub fn unknown(message: impl Into<String>) -> Self {
        Self::build(ProviderErrorKind::Unknown, message)
    }

    /// Attaches the originating HTTP status.
    #[must_use]
    pub fn with_status(mut self, status: u16) -> Self {
        self.status = Some(status);
        self
    }

    /// Attaches a provider-supplied retry delay.
    #[must_use]
    pub fn with_retry_after(mut self, delay: Duration) -> Self {
        self.retry_after = Some(delay);
        self
    }

    /// Overrides the default retryability.
    #[must_use]
    pub fn retryable(mut self, retryable: bool) -> Self {
        self.retryable = retryable;
        self
    }

    /// Classifies an HTTP status code into a provider error.
    ///
    /// `body_hint` must already be redacted and truncated by the caller.
    #[must_use]
    pub fn from_status(status: u16, body_hint: &str) -> Self {
        let message = || {
            if body_hint.is_empty() {
                format!("provider returned HTTP {status}")
            } else {
                format!("provider returned HTTP {status}: {body_hint}")
            }
        };
        match status {
            401 | 403 => Self::auth(message()),
            408 | 504 | 524 => Self::transport(message()),
            409 => Self::invalid_request(message()).retryable(true),
            413 => Self::context_overflow(message()),
            429 => Self::rate_limit(message()),
            400 | 404 | 422 => Self::invalid_request(message()),
            402 => Self::quota(message()),
            s if (500..600).contains(&s) => Self::provider_internal(message()),
            _ => Self::unknown(message()),
        }
    }
}

impl fmt::Display for ProviderError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.kind.as_str(), self.message)
    }
}

impl std::error::Error for ProviderError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn response_limit_is_a_stable_non_retryable_kind() {
        let error = ProviderError::response_limit("provider response limit exceeded");
        assert_eq!(error.kind.as_str(), "response_limit");
        assert!(!error.retryable);
        assert_eq!(error.kind, ProviderErrorKind::ResponseLimit);
    }
}
