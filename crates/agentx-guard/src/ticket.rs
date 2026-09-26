//! Scoped, TTL'd authorization tickets (`ARCH/12-GUARD.md`).
//!
//! A ticket is issued only for an authorized effect. Validation checks scope,
//! expiry, and remaining uses; a bounded-use ticket is decremented atomically
//! so it can never be spent twice. Tickets are in-memory and never persisted:
//! a restart revokes them by construction.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::error::GuardError;
use crate::pattern::Pattern;

/// The default ticket time-to-live.
pub const DEFAULT_TTL_MS: u64 = 120_000;

/// A capability use of a ticket.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FsOp {
    /// A read.
    Read,
    /// A write/rename/delete.
    Write,
}

/// One issued authorization ticket.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Ticket {
    /// The opaque ticket id.
    pub id: String,
    /// The canonical action the ticket authorizes.
    pub action: String,
    /// The resource scope; the ticket authorizes a resource matching any entry.
    pub scope: Vec<String>,
    /// Remaining uses; `u32::MAX` for unbounded session tickets.
    pub uses: u32,
    /// Whether a use is consumed on each successful validation.
    pub single_use: bool,
    /// Absolute expiry in epoch milliseconds.
    pub expires_at_ms: u64,
    /// The policy hash the ticket was issued under.
    pub policy_hash: String,
    /// The approval that produced the ticket, when any.
    pub approval_ref: Option<String>,
}

impl Ticket {
    /// Returns whether the ticket has expired at `now_ms`.
    #[must_use]
    pub fn is_expired(&self, now_ms: u64) -> bool {
        now_ms >= self.expires_at_ms
    }
}

/// Returns the current time in epoch milliseconds.
#[must_use]
pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

/// An in-memory ticket store.
#[derive(Debug, Default)]
pub struct TicketStore {
    inner: Mutex<HashMap<String, Ticket>>,
}

impl TicketStore {
    /// Builds an empty store.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Issues a ticket and returns it.
    pub fn issue(&self, ticket: Ticket) -> Ticket {
        let mut inner = self.lock();
        // Drop expired entries lazily so the store cannot grow without bound.
        let now = now_ms();
        inner.retain(|_, existing| !existing.is_expired(now));
        inner.insert(ticket.id.clone(), ticket.clone());
        ticket
    }

    /// Validates a ticket for an action and resource, consuming a use.
    ///
    /// # Errors
    /// Returns [`GuardError::InvalidTicket`] when the ticket is unknown,
    /// expired, out of scope, or exhausted.
    pub fn validate(
        &self,
        ticket_id: &str,
        action: &str,
        resource: &str,
    ) -> Result<Ticket, GuardError> {
        let mut inner = self.lock();
        let ticket = inner
            .get(ticket_id)
            .cloned()
            .ok_or_else(|| GuardError::InvalidTicket(format!("unknown ticket `{ticket_id}`")))?;
        if ticket.is_expired(now_ms()) {
            inner.remove(ticket_id);
            return Err(GuardError::InvalidTicket(format!(
                "ticket `{ticket_id}` expired"
            )));
        }
        if ticket.action != action {
            return Err(GuardError::InvalidTicket(format!(
                "ticket `{ticket_id}` is for `{}`, not `{action}`",
                ticket.action
            )));
        }
        let in_scope = ticket
            .scope
            .iter()
            .any(|pattern| matches_resource(action, pattern, resource));
        if !in_scope {
            return Err(GuardError::InvalidTicket(format!(
                "ticket `{ticket_id}` does not cover `{resource}`"
            )));
        }
        if ticket.uses == 0 {
            return Err(GuardError::InvalidTicket(format!(
                "ticket `{ticket_id}` is exhausted"
            )));
        }
        if ticket.single_use
            && let Some(stored) = inner.get_mut(ticket_id)
        {
            stored.uses = stored.uses.saturating_sub(1);
        }
        Ok(ticket)
    }

    /// Revokes a ticket, returning whether it existed.
    pub fn revoke(&self, ticket_id: &str) -> bool {
        self.lock().remove(ticket_id).is_some()
    }

    /// Revokes every ticket.
    pub fn revoke_all(&self) {
        self.lock().clear();
    }

    /// Returns the number of live tickets.
    #[must_use]
    pub fn len(&self) -> usize {
        self.lock().len()
    }

    /// Returns whether the store is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.lock().is_empty()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, HashMap<String, Ticket>> {
        self.inner
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn matches_resource(action: &str, pattern: &str, resource: &str) -> bool {
    let mode = crate::rule::resource_mode(action);
    Pattern::compile(pattern, mode)
        .map(|pattern| pattern.matches(resource))
        .unwrap_or(false)
}

/// Validates a filesystem operation against a ticket's scope.
///
/// # Errors
/// Returns [`GuardError::InvalidTicket`] when the ticket does not authorize
/// the operation.
pub fn validate_fs(ticket: &Ticket, op: FsOp, path: &str) -> Result<(), GuardError> {
    let required = match op {
        FsOp::Read => "fs.read",
        FsOp::Write => "fs.write",
    };
    if ticket.action != required && ticket.action != "fs.write" {
        return Err(GuardError::InvalidTicket(format!(
            "ticket for `{}` does not authorize {required}",
            ticket.action
        )));
    }
    if ticket.is_expired(now_ms()) {
        return Err(GuardError::InvalidTicket("ticket expired".to_owned()));
    }
    if !ticket
        .scope
        .iter()
        .any(|pattern| matches_resource(&ticket.action, pattern, path))
    {
        return Err(GuardError::InvalidTicket(format!(
            "ticket does not cover `{path}`"
        )));
    }
    Ok(())
}
