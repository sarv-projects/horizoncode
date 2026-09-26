//! Cooperative cancellation shared by the loop, the provider stream and the
//! protocol surface (`REQ-LOOP-005`).
//!
//! The token is a cheap, clonable flag plus a wake-up notification. Cancelling
//! is synchronous and idempotent; awaiting [`CancelToken::cancelled`] resolves
//! promptly in `select!` arms so streaming can stop mid-turn.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tokio::sync::Notify;

#[derive(Debug, Default)]
struct Inner {
    cancelled: AtomicBool,
    notify: Notify,
}

/// A clonable cooperative-cancellation handle.
#[derive(Clone, Debug, Default)]
pub struct CancelToken {
    inner: Arc<Inner>,
}

impl CancelToken {
    /// Creates a fresh, uncancelled token.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Requests cancellation. Idempotent and safe to call from any thread.
    pub fn cancel(&self) {
        self.inner.cancelled.store(true, Ordering::SeqCst);
        self.inner.notify.notify_waiters();
    }

    /// Returns whether cancellation has been requested.
    #[must_use]
    pub fn is_cancelled(&self) -> bool {
        self.inner.cancelled.load(Ordering::SeqCst)
    }

    /// Resolves once cancellation has been requested.
    ///
    /// Returns immediately if the token is already cancelled.
    pub async fn cancelled(&self) {
        loop {
            // Register interest before re-checking the flag so a concurrent
            // cancel cannot be lost.
            let notified = self.inner.notify.notified();
            if self.is_cancelled() {
                return;
            }
            notified.await;
            if self.is_cancelled() {
                return;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn resolves_when_cancelled_from_another_task() {
        let token = CancelToken::new();
        let waiter = token.clone();
        let handle = tokio::spawn(async move {
            waiter.cancelled().await;
        });
        assert!(!token.is_cancelled());
        token.cancel();
        assert!(token.is_cancelled());
        handle.await.unwrap();
    }

    #[tokio::test]
    async fn already_cancelled_resolves_immediately() {
        let token = CancelToken::new();
        token.cancel();
        // Must not hang.
        token.cancelled().await;
    }
}
