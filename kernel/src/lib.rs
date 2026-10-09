//! Small, independently testable Rust kernel crate.
//!
//! The implemented capabilities are a bounded outer frame codec, a strict bounded
//! MessagePack value codec, typed v1 RPC envelope validation/feature negotiation, and
//! an in-process startup-readiness sequencing gate, and a partial Windows same-logon
//! named-pipe peer-authentication adapter. The Windows adapter is not integrated into a
//! supervisor or hello state machine; Unix/inherited-handle authentication, request
//! dispatch, durable idempotency, cancellation, process supervision, and canonical owner
//! persistence are not implemented here.

pub mod messagepack;
pub mod protocol;
pub mod startup;
pub mod transport;
#[cfg(windows)]
pub mod windows_peer;
