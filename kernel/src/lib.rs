//! Small, independently testable Rust kernel crate.
//!
//! Implemented primitives include bounded frame and MessagePack codecs, typed v1 RPC
//! validation/feature negotiation, OwnerLog V2 canonical stream storage, an internal
//! immutable artifact-byte store, and an in-process startup-readiness gate. Artifact
//! storage currently supports Unix private-directory permissions only and is not wired to
//! a production owner/Guard authorization path. The Windows named-pipe peer-authentication
//! adapter is partial and is not integrated into a supervisor or hello state machine; the
//! request-cancellation registry is advisory, not an integrated RPC dispatch path. Windows
//! storage ACL validation, canonical Thread ownership, and managed process supervision
//! remain unavailable.

// This bounded storage seam is intentionally not wired to a production owner yet.
#[allow(dead_code)]
pub(crate) mod artifact_store;
pub mod messagepack;
pub mod owner_log;
pub(crate) mod owner_log_index;
pub mod protocol;
pub mod request_cancellation;
pub mod startup;
pub mod transport;
#[cfg(windows)]
pub mod windows_peer;
