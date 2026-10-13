//! Small, independently testable Rust kernel crate.
//!
//! Implemented primitives include bounded frame and MessagePack codecs, typed v1 RPC
//! validation/feature negotiation, OwnerLog V2 canonical stream storage, an internal
//! immutable artifact-byte store, an in-process startup-readiness gate, and bounded
//! generation-scoped terminal replay/grant/sequence state. On Linux, private Unix peer
//! authentication, first-message negotiation, READY-gated application RPC, and redacted
//! per-Session projection pages with bounded ACK delivery are connected. The projection
//! worker is not the EffectHost owner; guarded effect hosting and terminal process execution
//! are not yet integrated into a host-scoped `hz-kernel`.
//!
//! Artifact storage is not wired to a production owner. The Windows named-pipe
//! peer-authentication adapter is partial and is not integrated into the Session RPC
//! state machine; request cancellation remains an advisory primitive. Windows runtime,
//! PTY/ConPTY backends, and managed worker/process supervision remain unavailable.

// This bounded storage seam is intentionally not wired to a production owner yet.
#[allow(dead_code)]
pub(crate) mod artifact_store;
#[cfg(target_os = "linux")]
pub mod effect_host;
pub mod guard;
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
/// Bounded generation-scoped terminal grants, input sequencing, and replay state.
pub mod terminal;
/// Host-controlled, deterministic configured shell profiles; request bodies carry IDs only.
pub mod terminal_profile;
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
