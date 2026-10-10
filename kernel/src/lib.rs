//! Small, independently testable Rust kernel crate.
//!
//! Implemented primitives include bounded frame and MessagePack codecs, typed v1 RPC
//! validation/feature negotiation, OwnerLog V2 canonical stream storage, an internal
//! immutable artifact-byte store, and an in-process startup-readiness gate. On Linux,
//! private Unix peer authentication, first-message negotiation, READY-gated application
//! RPC, redacted Session projection pages and bounded ACK delivery are connected and
//! integration-tested. A Linux one-connection Session observer executable now assembles
//! these pieces for one bounded page, but is not yet under an application-owned persistent
//! host lifecycle. Artifact storage is not wired to a production owner/Guard
//! authorization path. The Windows named-pipe peer-authentication adapter is partial and
//! is not integrated into the Session RPC state machine; the request-cancellation registry
//! remains an advisory primitive. Windows runtime, canonical owner lifecycle and managed
//! process supervision remain unavailable.

// This bounded storage seam is intentionally not wired to a production owner yet.
#[allow(dead_code)]
pub(crate) mod artifact_store;
pub mod messagepack;
pub mod owner_log;
pub(crate) mod owner_log_index;
pub mod protocol;
pub mod request_cancellation;
pub mod startup;
pub mod subscription;
#[cfg(target_os = "linux")]
pub mod supervisor_lease;
#[cfg(target_os = "linux")]
pub mod supervisor_session;
pub mod transport;
#[cfg(windows)]
pub mod windows_peer;

/// Read-only, durable correlation projection of OpenCode Session events.
pub mod session_projection;

/// Linux private Unix-domain peer authentication used by the RPC session adapter.
#[cfg(target_os = "linux")]
pub mod unix_peer;

/// First-message hello negotiation over an authenticated Linux local channel.
#[cfg(target_os = "linux")]
pub mod rpc_handshake;
