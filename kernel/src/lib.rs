//! Small, independently testable Rust kernel crate.
//!
//! The implemented capabilities are a bounded outer frame codec, a strict bounded
//! MessagePack value codec, typed v1 RPC envelope validation/feature negotiation, and
//! an in-process startup-readiness sequencing gate. OS peer authentication, request
//! dispatch, durable idempotency, cancellation, process supervision, and canonical
//! owner persistence are not implemented here.

pub mod messagepack;
pub mod protocol;
pub mod startup;
pub mod transport;
