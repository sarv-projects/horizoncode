//! Small, independently testable Rust kernel crate.
//!
//! Implemented primitives include bounded frame and MessagePack codecs, typed v1 RPC
//! validation/feature negotiation, OwnerLog V2 canonical stream storage, an internal
//! immutable artifact-byte store, an in-process startup-readiness gate, and bounded
//! generation-scoped terminal replay/grant/sequence state. On Linux, private Unix peer
//! authentication, first-message negotiation, READY-gated application RPC, and redacted
//! per-Session projection pages with bounded ACK delivery are connected. The projection
//! worker is not the EffectHost owner; Linux guarded file effects are integrated through
//! the host-scoped `hz-kernel`, which also executes the single-shot `terminal.run` effect.
//! Session-style terminal operations (`start`, `cancel`, `status`, tickets) remain
//! unavailable.
//!
//! Artifact storage is not wired to a production owner. The Windows named-pipe
//! peer-authentication adapter is partial and is not integrated into the Session RPC
//! state machine; request cancellation remains an advisory primitive. Windows runtime,
//! PTY/ConPTY backends, and managed worker/process supervision remain unavailable.

// This bounded storage seam is intentionally not wired to a production owner yet.
#[allow(dead_code)]
pub(crate) mod artifact_store;
// Durable checkpoint journal and fail-closed restore preview/recovery policy.
#[allow(dead_code)]
pub(crate) mod checkpoint;
/// Strict bounded stdio frames for the private CodeMode helper RPC.
pub(crate) mod codemode_protocol;
// Deterministic automation scheduling state only. Guarded invocation is not wired.
#[allow(dead_code)]
pub(crate) mod automation;
/// Canonical hashes for authenticated managed AgentProfileV2 definitions.
pub(crate) mod agent_profile;
pub(crate) mod context_selection;
/// Optional Linux cgroup-v2 containment identity and restart quiescence proof.
#[cfg(target_os = "linux")]
pub mod cgroup_v2;
/// OwnerLog-backed direct child mailbox admission and append receipt recovery.
pub(crate) mod direct_message_journal;
/// Strict DirectSessionGrantV1 schema and canonical digest validation.
pub(crate) mod direct_session_grant;
/// Strict, digest-checked Core Config command profiles for bounded build/test.
pub(crate) mod workspace_command_profile;
/// Same-child OwnerLog direct provider-turn cycles and one-use fresh-turn proofs.
pub(crate) mod direct_turn_journal;
#[cfg(target_os = "linux")]
pub mod effect_host;
pub mod guard;
#[cfg(target_os = "linux")]
pub mod host_kernel;
/// HTTPS-only, DNS-pinned outbound HTTP primitives; not dispatched until the durable
/// HostKernel lease/receipt adapter and SecretBroker resolver are accepted.
pub mod http_execution;
pub mod managed_control;
pub mod messagepack;
pub mod owner_log;
pub(crate) mod owner_log_index;
pub mod protocol;
/// Bounded Content-Length JSON framing for supervised LSP/DAP stdio.
pub(crate) mod protocol_framing;
/// Durable HostKernel intent/ACK and bounded protocol-event replay journal.
pub(crate) mod protocol_io_journal;
pub(crate) mod search_secret_journal;
pub mod request_cancellation;
pub mod resource_budget;
/// Bounded, ownership-scoped process-tree sampling with explicit unknown states.
pub mod resource_sampler;
pub mod startup;
pub mod subscription;
/// Strict cross-language decoding for direct and managed child deliveries.
pub mod subagent_delivery;
#[cfg(target_os = "linux")]
pub mod supervisor_lease;
#[cfg(target_os = "linux")]
pub mod supervisor_session;
/// Bounded, deterministic Task-DAG admission and typed artifact-edge validation.
pub mod task_dag;
/// Bounded generation-scoped terminal grants, input sequencing, and replay state.
pub mod terminal;
/// Bounded terminal process execution using the platform-specific process backend.
pub mod terminal_process;
/// Host-controlled, deterministic configured shell profiles; request bodies carry IDs only.
pub mod terminal_profile;
pub mod transport;
#[cfg(windows)]
pub mod windows_peer;

/// Read-only, durable correlation projection of OpenCode Session events.
pub mod session_projection;

/// Bounded Rust-owned worker pool composing capacity, worktree and Attempt leases.
pub mod worker_pool;

/// OwnerLog-backed durable clone-apply-commit adapter for the worker pool.
pub mod worker_durable;

/// Bounded, process-local model of the Rust-owned worktree lease lifecycle.
pub mod worktree_pool;

/// Durable intent/receipt contract for HostKernel-guarded worker worktrees.
pub(crate) mod worktree_lifecycle;

/// Linux private Unix-domain peer authentication used by the RPC session adapter.
#[cfg(target_os = "linux")]
pub mod unix_peer;

/// First-message hello negotiation over an authenticated Linux local channel.
#[cfg(target_os = "linux")]
pub mod rpc_handshake;
