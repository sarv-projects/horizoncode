//! Small, independently testable Rust kernel crate.
//!
//! The implemented capabilities are a bounded outer frame codec, a strict bounded
//! MessagePack value codec, typed v1 RPC envelope validation/feature negotiation,
//! OwnerLog V2 record/head/seal codecs, and an in-process startup-readiness sequencing
//! gate. It also contains a partial Windows same-logon named-pipe peer-authentication
//! adapter. That adapter is not integrated into a supervisor or hello state machine; the
//! request-cancellation registry is advisory, not an integrated RPC dispatch path.
//! Unix/inherited-handle authentication, durable idempotency, process supervision, and
//! canonical owner persistence are not implemented here.

pub mod messagepack;
pub mod owner_log;
pub(crate) mod owner_log_index;
pub mod protocol;
pub mod request_cancellation;
pub mod startup;
pub mod transport;
#[cfg(windows)]
pub mod windows_peer;
