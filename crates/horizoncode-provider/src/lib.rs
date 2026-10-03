//! Vendor-neutral provider transport (`CMP-provider`, `ARCH/11-PROVIDER.md`).
//!
//! One [`Provider`] trait and one adapter are shipped here: a
//! chat-completions-compatible transport that speaks SSE. The adapter
//! owns wire framing, retry with exponential backoff and jitter, `Retry-After`
//! handling, and full secret redaction (`REQ-PROV-003`, `REQ-PROV-004`). The
//! loop above it sees exactly one request type and one typed event stream.
//!
//! # Secret handling
//! Credentials are held in a [`SecretString`] whose `Debug` implementation
//! redacts them. The adapter never writes a credential into an error message,
//! a log line, or a request echo. See [`Redactor`].

#![forbid(unsafe_code)]

mod compatible;
mod redact;
mod retry;
mod secret;
mod sse;

#[cfg(feature = "testing")]
pub mod testing;

pub use compatible::{ChatCompletionsProvider, ProviderConfig};
pub use redact::Redactor;
pub use retry::{RetryDecision, RetryPolicy, parse_retry_after};
pub use secret::SecretString;
pub use sse::SseBuffer;

use futures::stream::BoxStream;
use horizoncode_types::{CancelToken, ModelEvent, ModelRequest, ProviderError};

/// A streaming model provider.
///
/// Implementations are `Send + Sync` so a single provider can serve concurrent
/// sessions. The stream is `'static` and boxed; consumers drive it with
/// `futures::StreamExt` while racing a [`CancelToken`] for prompt interruption
/// (`REQ-LOOP-005`).
pub type ModelStream = BoxStream<'static, Result<ModelEvent, ProviderError>>;

/// The one model-facing capability the loop depends on.
#[async_trait::async_trait]
pub trait Provider: Send + Sync + std::fmt::Debug {
    /// Returns the provider/route id.
    fn name(&self) -> &str;

    /// Returns the default model id.
    fn model(&self) -> &str;

    /// Opens a streaming completion.
    ///
    /// Retries request-start failures internally, honoring `Retry-After`.
    /// Mid-stream failures are surfaced on the returned stream so the loop owns
    /// turn-level recovery (`ARCH/11-PROVIDER.md` §3).
    ///
    /// # Errors
    /// Returns a classified [`ProviderError`] when the request cannot be opened
    /// within the retry budget or when cancellation was requested.
    async fn stream(
        &self,
        request: ModelRequest,
        cancel: CancelToken,
    ) -> Result<ModelStream, ProviderError>;
}
