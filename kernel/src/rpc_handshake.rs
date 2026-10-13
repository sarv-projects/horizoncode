//! Version and feature negotiation on an OS-authenticated Linux channel.
//!
//! This exchange is deliberately limited to the first hello frame. It neither claims
//! startup readiness nor admits application RPC; a supervisor must complete canonical
//! state validation, epoch acquisition and recovery before it sends `READY`.

use std::fmt;
use std::io::{self, Write};

use crate::protocol::{
    ErrorCategoryV1, HandshakePolicy, KernelHelloResultV1, RetryClassV1, RpcMessageV1,
    TypedErrorV1, hello_result_for, negotiate_hello, read_message, write_message,
};
use crate::unix_peer::AuthenticatedUnixStream;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HelloOutcome {
    Negotiated(KernelHelloResultV1),
    Rejected(TypedErrorV1),
}

#[derive(Debug)]
pub enum HelloExchangeError {
    Protocol(crate::protocol::ProtocolError),
    Io(io::Error),
    Closed,
    ExpectedHello,
}

impl fmt::Display for HelloExchangeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Protocol(error) => write!(formatter, "hello protocol failed: {error}"),
            Self::Io(error) => write!(formatter, "hello response write failed: {error}"),
            Self::Closed => formatter.write_str("peer closed before sending hello"),
            Self::ExpectedHello => formatter.write_str("first RPC frame must be hello"),
        }
    }
}

impl std::error::Error for HelloExchangeError {}

/// Reads and negotiates the first message on a channel that has already passed OS peer
/// authentication. Incompatible peers receive a bounded typed rejection; malformed or
/// non-hello frames are closed by the caller without application RPC dispatch.
pub fn serve_authenticated_unix_hello(
    stream: &mut AuthenticatedUnixStream,
    policy: &HandshakePolicy,
) -> Result<HelloOutcome, HelloExchangeError> {
    let Some(message) = read_message(stream).map_err(HelloExchangeError::Protocol)? else {
        return Err(HelloExchangeError::Closed);
    };
    let RpcMessageV1::Hello(hello) = message else {
        return Err(HelloExchangeError::ExpectedHello);
    };

    let (outcome, response) = match negotiate_hello(&hello, policy) {
        Ok(negotiated) => {
            let result = hello_result_for(&hello, &negotiated, policy.owner_epoch)
                .map_err(HelloExchangeError::Protocol)?;
            let response = RpcMessageV1::HelloResult(Box::new(result.clone()));
            (HelloOutcome::Negotiated(result), response)
        }
        Err(error) => {
            let rejection = TypedErrorV1 {
                code: if matches!(
                    error.0,
                    crate::protocol::ProtocolErrorKind::TransportIncompatible
                ) {
                    "TRANSPORT_INCOMPATIBLE"
                } else {
                    "INVALID_HELLO"
                }
                .to_owned(),
                category: if matches!(
                    error.0,
                    crate::protocol::ProtocolErrorKind::TransportIncompatible
                ) {
                    ErrorCategoryV1::Capability
                } else {
                    ErrorCategoryV1::Validation
                },
                message: error.to_string(),
                retry_class: RetryClassV1::Never,
                retry_after_ms: None,
                owner_cursor: None,
                subject_ids: Vec::new(),
                details: None,
            };
            let response =
                RpcMessageV1::HelloRejected(Box::new(crate::protocol::KernelHelloRejectedV1 {
                    error: rejection.clone(),
                }));
            (HelloOutcome::Rejected(rejection), response)
        }
    };

    write_message(stream, &response).map_err(HelloExchangeError::Protocol)?;
    stream.flush().map_err(HelloExchangeError::Io)?;
    Ok(outcome)
}
