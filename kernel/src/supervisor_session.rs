//! Authenticated per-connection hello/startup state for the Linux RPC supervisor seam.
//!
//! This binds an OS-authenticated stream to the existing `StartupGate`, emits status only
//! after each reported milestone, and prevents application frame reads before READY. The
//! owning supervisor must perform the canonical-state/recovery work before reporting it.

use std::collections::BTreeSet;
use std::fmt;
use std::io::{self, Write};

use crate::protocol::{
    CursorV1, ErrorCategoryV1, FEATURE_SESSION_PAGE_CONTROL_V1, HandshakePolicy, RetryClassV1,
    RpcControlV1, RpcMessageV1, RpcOutcomeV1, RpcRequestV1, RpcResponseV1, TypedErrorV1,
    read_message, write_message,
};
use crate::rpc_handshake::{HelloExchangeError, HelloOutcome, serve_authenticated_unix_hello};
use crate::session_projection::{
    SessionProjection, SessionSubscriptionPage, SubscriptionPageError,
};
use crate::startup::{StartupGate, StartupPhase, StartupTransitionError};
use crate::unix_peer::AuthenticatedUnixStream;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionPageDelivery {
    pub cursor: CursorV1,
    pub has_more: bool,
    pub delivered: usize,
}

#[derive(Debug)]
pub enum SupervisorSessionError {
    Hello(HelloExchangeError),
    Startup(StartupTransitionError),
    Protocol(crate::protocol::ProtocolError),
    Io(io::Error),
    Closed,
    ExpectedApplicationMessage,
    ProjectionSubscription(SubscriptionPageError),
    Subscription(SubscriptionError),
    WrongSubscription,
    UnexpectedControl,
    AckBudgetExceeded,
    PageBackpressured,
    FeatureNotNegotiated,
}

impl fmt::Display for SupervisorSessionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Hello(error) => write!(formatter, "supervisor hello failed: {error}"),
            Self::Startup(error) => {
                write!(formatter, "supervisor startup transition failed: {error}")
            }
            Self::Protocol(error) => write!(formatter, "supervisor RPC failed: {error}"),
            Self::Io(error) => write!(formatter, "supervisor RPC write failed: {error}"),
            Self::Closed => formatter.write_str("supervisor closed the authenticated channel"),
            Self::ExpectedApplicationMessage => {
                formatter.write_str("expected an application request or control message")
            }
            Self::ProjectionSubscription(error) => write!(formatter, "{error}"),
            Self::Subscription(error) => write!(formatter, "{error}"),
            Self::WrongSubscription => {
                formatter.write_str("acknowledgment names a different subscription")
            }
            Self::UnexpectedControl => {
                formatter.write_str("expected an acknowledgment control message")
            }
            Self::AckBudgetExceeded => {
                formatter.write_str("too many duplicate acknowledgments for one page")
            }
            Self::PageBackpressured => {
                formatter.write_str("projected page exceeded its bounded subscription window")
            }
            Self::FeatureNotNegotiated => {
                formatter.write_str("subscription page controls were not negotiated")
            }
        }
    }
}

impl std::error::Error for SupervisorSessionError {}

/// One authenticated projection-worker connection. The channel cannot be read or written by
/// application handlers except through its readiness-gated methods.
pub struct AuthenticatedKernelSession {
    stream: AuthenticatedUnixStream,
    startup: StartupGate,
    negotiated_features: BTreeSet<String>,
}

impl AuthenticatedKernelSession {
    pub fn new(stream: AuthenticatedUnixStream) -> Self {
        Self {
            stream,
            startup: StartupGate::new(),
            negotiated_features: BTreeSet::new(),
        }
    }

    /// Binds protocol negotiation to this already-authenticated OS channel.
    pub fn negotiate(
        &mut self,
        policy: &HandshakePolicy,
    ) -> Result<HelloOutcome, SupervisorSessionError> {
        self.startup
            .record_peer_authenticated()
            .map_err(SupervisorSessionError::Startup)?;
        let outcome = serve_authenticated_unix_hello(&mut self.stream, policy)
            .map_err(SupervisorSessionError::Hello)?;
        match &outcome {
            HelloOutcome::Negotiated(result) => {
                self.negotiated_features = result.enabled_features.iter().cloned().collect();
                self.startup
                    .record_hello_negotiated()
                    .map_err(SupervisorSessionError::Startup)?;
            }
            HelloOutcome::Rejected(error) => self.startup.fail(error.clone()),
        }
        self.send_status()?;
        Ok(outcome)
    }

    pub fn canonical_state_validated(&mut self) -> Result<(), SupervisorSessionError> {
        self.startup
            .record_canonical_state_validated()
            .map_err(SupervisorSessionError::Startup)?;
        self.send_status()
    }

    /// Records the host kernel epoch without acquiring or retaining its lease.
    pub fn owner_epoch_acquired(
        &mut self,
        epoch: u64,
    ) -> Result<(), SupervisorSessionError> {
        self.startup
            .record_owner_epoch_acquired(epoch)
            .map_err(SupervisorSessionError::Startup)?;
        self.send_status()
    }

    pub fn recovery_reconciled(&mut self) -> Result<(), SupervisorSessionError> {
        self.startup
            .record_recovery_reconciled()
            .map_err(SupervisorSessionError::Startup)?;
        self.send_status()
    }

    pub fn required_services_ready(&mut self) -> Result<(), SupervisorSessionError> {
        self.startup
            .record_required_services_ready()
            .map_err(SupervisorSessionError::Startup)?;
        self.send_status()
    }

    /// Read the next request/control message only after the gate reaches READY.
    pub fn next_application_message(&mut self) -> Result<RpcMessageV1, SupervisorSessionError> {
        self.startup
            .admit_application_rpc()
            .map_err(SupervisorSessionError::Startup)?;
        let Some(message) =
            read_message(&mut self.stream).map_err(SupervisorSessionError::Protocol)?
        else {
            return Err(SupervisorSessionError::Closed);
        };
        if matches!(message, RpcMessageV1::Request(_) | RpcMessageV1::Control(_)) {
            Ok(message)
        } else {
            Err(SupervisorSessionError::ExpectedApplicationMessage)
        }
    }

    pub fn next_application_request(&mut self) -> Result<RpcRequestV1, SupervisorSessionError> {
        match self.next_application_message()? {
            RpcMessageV1::Request(request) => Ok(*request),
            _ => Err(SupervisorSessionError::ExpectedApplicationMessage),
        }
    }

    /// Send an application message only after READY.
    pub fn write_application_message(
        &mut self,
        message: &RpcMessageV1,
    ) -> Result<(), SupervisorSessionError> {
        self.startup
            .admit_application_rpc()
            .map_err(SupervisorSessionError::Startup)?;
        write_message(&mut self.stream, message).map_err(SupervisorSessionError::Protocol)?;
        self.stream.flush().map_err(SupervisorSessionError::Io)
    }

    /// Deliver a page while retaining a rejecting handler for interleaved requests.
    pub fn send_subscription_page(
        &mut self,
        projection: &SessionProjection,
        subscription_id: &str,
        after: &CursorV1,
        capacity: usize,
    ) -> Result<SessionPageDelivery, SupervisorSessionError> {
        self.send_subscription_page_with_requests(
            projection,
            subscription_id,
            after,
            capacity,
            |request| RpcResponseV1 {
                request_id: request.request_id,
                outcome: RpcOutcomeV1::Error,
                owner_cursor: None,
                receipt_digest: None,
                body: None,
                error: Some(TypedErrorV1 {
                    code: "unsupported_interleaved_request".to_owned(),
                    category: ErrorCategoryV1::Capability,
                    message: "request is not supported by this supervisor operation".to_owned(),
                    retry_class: RetryClassV1::Never,
                    retry_after_ms: None,
                    owner_cursor: None,
                    subject_ids: Vec::new(),
                    details: None,
                }),
            },
        )
    }

    /// Deliver one bounded metadata-only page and wait for contiguous client ACKs.
    /// Application requests arriving while waiting for ACKs are serialized through the
    /// supplied handler and answered before ACK delivery resumes.
    pub fn send_subscription_page_with_requests<F>(
        &mut self,
        projection: &SessionProjection,
        subscription_id: &str,
        after: &CursorV1,
        capacity: usize,
        mut request_handler: F,
    ) -> Result<SessionPageDelivery, SupervisorSessionError>
    where
        F: FnMut(RpcRequestV1) -> RpcResponseV1,
    {
        self.startup
            .admit_application_rpc()
            .map_err(SupervisorSessionError::Startup)?;
        let SessionSubscriptionPage { events, has_more } = projection
            .subscription_page(subscription_id, after, capacity)
            .map_err(SupervisorSessionError::ProjectionSubscription)?;
        let mut window = BoundedSubscription::new(
            subscription_id,
            after.owner_kind.clone(),
            after.owner_id.clone(),
            after.clone(),
            capacity,
        )
        .map_err(SupervisorSessionError::Subscription)?;
        for event in events {
            match window
                .offer(event)
                .map_err(SupervisorSessionError::Subscription)?
            {
                OfferResult::Queued | OfferResult::Duplicate => {}
                OfferResult::Backpressured => {
                    return Err(SupervisorSessionError::PageBackpressured);
                }
            }
        }

        let mut delivered: usize = 0;
        while let Some(event) = window.next_event() {
            self.write_application_message(&RpcMessageV1::Event(Box::new(event)))?;
            delivered += 1;
        }
        let mut application_frames = 0usize;
        let application_frame_limit = delivered.saturating_mul(2).max(1);
        while window.buffered() > 0 {
            let message = self.next_application_message()?;
            application_frames += 1;
            if application_frames > application_frame_limit {
                return Err(SupervisorSessionError::AckBudgetExceeded);
            }
            match message {
                RpcMessageV1::Request(request) => {
                    let response = request_handler(*request);
                    self.write_application_message(&RpcMessageV1::Response(Box::new(response)))?;
                    continue;
                }
                RpcMessageV1::Control(control) => {
                    let RpcControlV1::Ack {
                        subscription_id: ack_subscription,
                        through,
                    } = *control
                    else {
                        return Err(SupervisorSessionError::UnexpectedControl);
                    };
                    if ack_subscription != subscription_id {
                        return Err(SupervisorSessionError::WrongSubscription);
                    }
                    match window
                        .ack(&through)
                        .map_err(SupervisorSessionError::Subscription)?
                    {
                        AckResult::Advanced { .. } | AckResult::Duplicate => {}
                    }
                }
                _ => return Err(SupervisorSessionError::UnexpectedControl),
            }
        }
        let cursor = window.acknowledged_cursor().clone();
        self.send_page_end(subscription_id, &cursor, has_more)?;
        Ok(SessionPageDelivery {
            cursor,
            has_more,
            delivered,
        })
    }

    pub fn send_resnapshot_required(
        &mut self,
        subscription_id: &str,
        requested: &CursorV1,
        latest: &CursorV1,
    ) -> Result<(), SupervisorSessionError> {
        self.require_page_control_feature()?;
        self.write_application_message(&RpcMessageV1::Control(Box::new(
            RpcControlV1::ResnapshotRequired {
                subscription_id: subscription_id.to_owned(),
                requested: requested.clone(),
                latest: latest.clone(),
            },
        )))
    }

    fn send_page_end(
        &mut self,
        subscription_id: &str,
        through: &CursorV1,
        has_more: bool,
    ) -> Result<(), SupervisorSessionError> {
        self.require_page_control_feature()?;
        self.write_application_message(&RpcMessageV1::Control(Box::new(RpcControlV1::PageEnd {
            subscription_id: subscription_id.to_owned(),
            through: through.clone(),
            has_more,
        })))
    }

    fn require_page_control_feature(&self) -> Result<(), SupervisorSessionError> {
        if self
            .negotiated_features
            .contains(FEATURE_SESSION_PAGE_CONTROL_V1)
        {
            Ok(())
        } else {
            Err(SupervisorSessionError::FeatureNotNegotiated)
        }
    }

    pub fn phase(&self) -> StartupPhase {
        self.startup.phase()
    }

    pub fn peer(&self) -> &crate::unix_peer::UnixPeerIdentity {
        self.stream.peer()
    }

    fn send_status(&mut self) -> Result<(), SupervisorSessionError> {
        let status = self.startup.status();
        write_message(
            &mut self.stream,
            &RpcMessageV1::StartupStatus(Box::new(status)),
        )
        .map_err(SupervisorSessionError::Protocol)?;
        self.stream.flush().map_err(SupervisorSessionError::Io)
    }
}
