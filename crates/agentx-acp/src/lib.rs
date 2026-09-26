//! The Agent Client Protocol edge (`CMP-acp`, `ARCH/15-PROTOCOLS.md`).
//!
//! agentX is an ACP **server** over stdio: newline-delimited JSON-RPC 2.0,
//! protocol v1. The surface is a thin translation onto the one control plane
//! (`agentx-runner`); it contains no loop logic (`REQ-PROTO-005`).
//!
//! ## Implementation path
//! This crate uses the official `agent-client-protocol` Rust SDK (Apache-2.0,
//! crates.io) rather than hand-rolling the wire protocol, following
//! `ARCH/03` §5 and `DEC-001`. The SDK provides the stable v1 schema types, the
//! stdio transport, request/notification dispatch, capability negotiation, and
//! typed agent-to-client requests. Only methods agentX actually implements are
//! advertised (`REQ-PROTO-006`).
//!
//! Implemented: `initialize`, `session/new`, `session/prompt`, `session/cancel`,
//! `session/close`, streamed `session/update`, and `session/request_permission`
//! (`REQ-PROTO-001`, `REQ-PROTO-002`).

#![forbid(unsafe_code)]

mod error;
mod observer;
mod permission;
mod server;

pub use error::AcpError;
pub use server::{AcpOptions, run_stdio};
