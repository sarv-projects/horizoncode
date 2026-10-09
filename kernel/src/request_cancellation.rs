//! Bounded per-connection registry for advisory RPC request cancellation.
//!
//! A cancellation signal never rolls back an owner commit or external effect. The
//! operation handler must observe the token and apply its own domain cancellation and
//! reconciliation rules. The RPC connection owner creates one registry per connection;
//! the registry itself is not authentication or request-origin proof. This module does
//! not implement dispatch or process supervision.

use std::collections::HashMap;
use std::error::Error;
use std::fmt;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, Weak};

use crate::protocol::{MAX_IDENTIFIER_BYTES, RpcControlV1};

struct RegistryState {
    active: HashMap<String, Arc<AtomicBool>>,
}

struct RegistryInner {
    max_active: NonZeroUsize,
    state: Mutex<RegistryState>,
}

/// Clonable, cooperative cancellation signal for one in-flight RPC request.
#[derive(Clone)]
pub struct RequestCancellation(Arc<AtomicBool>);

impl RequestCancellation {
    /// Whether an advisory cancellation has been requested for this operation.
    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

/// One active request registration. Dropping it removes the request ID from its
/// connection registry, including when the handler exits early or unwinds.
#[must_use = "keep the request registration alive until its handler completes"]
pub struct ActiveRequest {
    request_id: String,
    cancellation: RequestCancellation,
    registry: Weak<RegistryInner>,
}

impl ActiveRequest {
    /// Clone the cooperative signal for the operation handler.
    pub fn cancellation(&self) -> RequestCancellation {
        self.cancellation.clone()
    }
}

impl Drop for ActiveRequest {
    fn drop(&mut self) {
        let Some(registry) = self.registry.upgrade() else {
            return;
        };
        let mut state = match registry.state.lock() {
            Ok(state) => state,
            Err(poisoned) => poisoned.into_inner(),
        };
        if state
            .active
            .get(&self.request_id)
            .is_some_and(|signal| Arc::ptr_eq(signal, &self.cancellation.0))
        {
            state.active.remove(&self.request_id);
        }
    }
}

/// Errors from request registration and cancellation routing.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestCancellationError {
    InvalidRequestId,
    DuplicateRequestId,
    CapacityReached,
    RegistryPoisoned,
}

/// Outcome when a decoded control is offered to the cancellation router.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CancellationControlResult {
    /// The control is not a cancellation request; this module leaves it to its owner.
    NotCancellation,
    /// The request ID was valid but was not active on this registry.
    RequestNotActive,
    /// An active request's cooperative token was signaled.
    CancellationRequested,
}

impl fmt::Display for RequestCancellationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequestId => {
                formatter.write_str("request ID is invalid or exceeds its byte limit")
            }
            Self::DuplicateRequestId => {
                formatter.write_str("request ID is already active on this connection")
            }
            Self::CapacityReached => {
                formatter.write_str("active request limit reached for this connection")
            }
            Self::RegistryPoisoned => {
                formatter.write_str("request cancellation registry is unavailable")
            }
        }
    }
}

impl Error for RequestCancellationError {}

/// Advisory cancellation routing for one RPC connection.
#[derive(Clone)]
pub struct RequestCancellationRegistry(Arc<RegistryInner>);

impl RequestCancellationRegistry {
    /// Create a registry with a caller-selected concurrency bound.
    pub fn new(max_active: NonZeroUsize) -> Self {
        Self(Arc::new(RegistryInner {
            max_active,
            state: Mutex::new(RegistryState {
                active: HashMap::new(),
            }),
        }))
    }

    /// Register one request before dispatch. The returned guard unregisters it on drop.
    pub fn register(&self, request_id: &str) -> Result<ActiveRequest, RequestCancellationError> {
        validate_request_id(request_id)?;
        let mut state = self
            .0
            .state
            .lock()
            .map_err(|_| RequestCancellationError::RegistryPoisoned)?;
        if state.active.contains_key(request_id) {
            return Err(RequestCancellationError::DuplicateRequestId);
        }
        if state.active.len() >= self.0.max_active.get() {
            return Err(RequestCancellationError::CapacityReached);
        }

        let signal = Arc::new(AtomicBool::new(false));
        state.active.insert(request_id.to_owned(), signal.clone());
        Ok(ActiveRequest {
            request_id: request_id.to_owned(),
            cancellation: RequestCancellation(signal),
            registry: Arc::downgrade(&self.0),
        })
    }

    /// Signal an active request. Returns `false` when the ID is not in flight.
    /// Repeated cancellation of an active ID is idempotent and returns `true`.
    pub fn cancel_request(&self, request_id: &str) -> Result<bool, RequestCancellationError> {
        validate_request_id(request_id)?;
        let state = self
            .0
            .state
            .lock()
            .map_err(|_| RequestCancellationError::RegistryPoisoned)?;
        let Some(signal) = state.active.get(request_id) else {
            return Ok(false);
        };
        signal.store(true, Ordering::Release);
        Ok(true)
    }

    /// Route only a decoded `CancelRequest` control to this connection's active requests.
    /// Other control variants are explicitly left to their owning dispatcher.
    pub fn route_control(
        &self,
        control: &RpcControlV1,
    ) -> Result<CancellationControlResult, RequestCancellationError> {
        let RpcControlV1::CancelRequest { request_id } = control else {
            return Ok(CancellationControlResult::NotCancellation);
        };
        match self.cancel_request(request_id)? {
            true => Ok(CancellationControlResult::CancellationRequested),
            false => Ok(CancellationControlResult::RequestNotActive),
        }
    }

    /// Return the current number of registered in-flight requests.
    pub fn active_count(&self) -> Result<usize, RequestCancellationError> {
        self.0
            .state
            .lock()
            .map(|state| state.active.len())
            .map_err(|_| RequestCancellationError::RegistryPoisoned)
    }
}

fn validate_request_id(request_id: &str) -> Result<(), RequestCancellationError> {
    if request_id.is_empty() || request_id.len() > MAX_IDENTIFIER_BYTES || request_id.contains('\0')
    {
        return Err(RequestCancellationError::InvalidRequestId);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Barrier;
    use std::thread;

    fn registry(capacity: usize) -> RequestCancellationRegistry {
        RequestCancellationRegistry::new(NonZeroUsize::new(capacity).unwrap())
    }

    #[test]
    fn cancellation_is_advisory_idempotent_and_scoped_to_active_registration() {
        let registry = registry(2);
        let request = registry.register("req_1").unwrap();
        let signal = request.cancellation();

        assert!(!signal.is_cancelled());
        assert!(registry.cancel_request("req_1").unwrap());
        assert!(signal.is_cancelled());
        assert!(registry.cancel_request("req_1").unwrap());
        assert_eq!(registry.active_count().unwrap(), 1);

        drop(request);
        assert_eq!(registry.active_count().unwrap(), 0);
        assert!(!registry.cancel_request("req_1").unwrap());

        let next_request = registry.register("req_1").unwrap();
        assert!(!next_request.cancellation().is_cancelled());
    }

    #[test]
    fn request_ids_are_isolated_between_connection_registries() {
        let first_connection = registry(1);
        let second_connection = registry(1);
        let first_request = first_connection.register("shared_id").unwrap();
        let second_request = second_connection.register("shared_id").unwrap();

        assert!(second_connection.cancel_request("shared_id").unwrap());
        assert!(second_request.cancellation().is_cancelled());
        assert!(!first_request.cancellation().is_cancelled());
        assert_eq!(
            first_connection.route_control(&RpcControlV1::CancelRequest {
                request_id: "shared_id".to_owned(),
            }),
            Ok(CancellationControlResult::CancellationRequested)
        );
        assert!(first_request.cancellation().is_cancelled());
    }

    #[test]
    fn decoded_cancel_control_routes_only_to_active_request_ids() {
        let registry = registry(1);
        let request = registry.register("req_1").unwrap();
        let signal = request.cancellation();

        assert_eq!(
            registry
                .route_control(&RpcControlV1::CancelRequest {
                    request_id: "req_1".to_owned(),
                })
                .unwrap(),
            CancellationControlResult::CancellationRequested
        );
        assert!(signal.is_cancelled());
        assert_eq!(
            registry
                .route_control(&RpcControlV1::CancelRequest {
                    request_id: "not_active".to_owned(),
                })
                .unwrap(),
            CancellationControlResult::RequestNotActive
        );
        assert_eq!(
            registry
                .route_control(&RpcControlV1::Ping {
                    nonce: "ping".to_owned(),
                })
                .unwrap(),
            CancellationControlResult::NotCancellation
        );
    }

    #[test]
    fn duplicate_and_over_capacity_requests_do_not_replace_existing_signals() {
        let registry = registry(1);
        let first = registry.register("req_1").unwrap();

        assert_eq!(
            registry.register("req_1").err().unwrap(),
            RequestCancellationError::DuplicateRequestId
        );
        assert_eq!(
            registry.register("req_2").err().unwrap(),
            RequestCancellationError::CapacityReached
        );
        assert_eq!(registry.active_count().unwrap(), 1);
        assert!(registry.cancel_request("req_1").unwrap());
        assert!(first.cancellation().is_cancelled());
    }

    #[test]
    fn invalid_request_ids_are_rejected_without_entering_the_registry() {
        let registry = registry(2);
        for request_id in ["", "req\0bad"] {
            assert_eq!(
                registry.register(request_id).err().unwrap(),
                RequestCancellationError::InvalidRequestId
            );
            assert_eq!(
                registry.cancel_request(request_id).unwrap_err(),
                RequestCancellationError::InvalidRequestId
            );
        }

        let oversized = "x".repeat(MAX_IDENTIFIER_BYTES + 1);
        assert_eq!(
            registry.register(&oversized).err().unwrap(),
            RequestCancellationError::InvalidRequestId
        );
        assert_eq!(registry.active_count().unwrap(), 0);
    }

    #[test]
    fn cancellation_racing_with_completion_is_linearized_by_registry_state() {
        for _ in 0..32 {
            let registry = registry(1);
            let request = registry.register("req_1").unwrap();
            let signal = request.cancellation();
            let barrier = Arc::new(Barrier::new(2));
            let cancel_registry = registry.clone();
            let cancel_barrier = barrier.clone();
            let cancellation = thread::spawn(move || {
                cancel_barrier.wait();
                cancel_registry.cancel_request("req_1").unwrap()
            });

            barrier.wait();
            drop(request);
            let cancellation_routed_to_active_request = cancellation.join().unwrap();

            assert_eq!(signal.is_cancelled(), cancellation_routed_to_active_request);
            assert_eq!(registry.active_count().unwrap(), 0);
        }
    }
}
