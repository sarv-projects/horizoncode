//! The ask/approve lifecycle (`ARCH/12-GUARD.md`).
//!
//! Guard creates a pending approval and hands it to an [`ApprovalResolver`].
//! The resolver is surface-specific: a headless run answers deny by default, a
//! `--yolo` run auto-allows non-catastrophic asks, an interactive surface
//! prompts, and the ACP server forwards `session/request_permission`. A resolver
//! can never widen the catastrophic gate, which Guard applies before asking.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};

/// A saved "always allow" rule, persisted only with the exact pattern shown to
/// the user (`REQ-GUARD-003`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct SavedRule {
    /// The capability action pattern.
    pub action: String,
    /// The resource pattern.
    pub resource: String,
}

impl SavedRule {
    /// Builds a saved rule.
    #[must_use]
    pub fn new(action: impl Into<String>, resource: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            resource: resource.into(),
        }
    }
}

/// A request for human approval.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRequest {
    /// The canonical action.
    pub action: String,
    /// The advertised tool name.
    pub tool: String,
    /// The tool call id the request ties back to.
    pub source: String,
    /// The concrete resources the call will touch.
    pub resources: Vec<String>,
    /// The exact patterns an `always` reply would persist.
    pub save: Vec<SavedRule>,
    /// A human-readable prompt fragment.
    pub prompt: String,
    /// Whether the action is catastrophic (resolvers must never auto-allow).
    pub catastrophic: bool,
}

/// The user's reply to an approval request.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ApprovalReply {
    /// Approve this call only.
    Once,
    /// Approve and persist each pattern in `save`.
    Always,
    /// Reject the call.
    Reject,
}

/// Resolves an [`ApprovalRequest`] into a reply.
///
/// Implementations must be fail-closed: returning [`ApprovalReply::Reject`] is
/// always safe.
#[async_trait]
pub trait ApprovalResolver: Send + Sync + std::fmt::Debug {
    /// Resolves one request.
    async fn resolve(&self, request: &ApprovalRequest) -> ApprovalReply;
}

/// A resolver that rejects every request (the headless default).
#[derive(Debug, Default, Clone, Copy)]
pub struct DenyAllResolver;

#[async_trait]
impl ApprovalResolver for DenyAllResolver {
    async fn resolve(&self, _request: &ApprovalRequest) -> ApprovalReply {
        ApprovalReply::Reject
    }
}

/// A resolver that approves every non-catastrophic request once.
///
/// This is the explicit `--yolo` posture: `ask` collapses to allow, while a
/// `deny` decision and the catastrophic gate are applied by Guard and never
/// reach the resolver.
#[derive(Debug, Default, Clone, Copy)]
pub struct AutoApproveResolver;

#[async_trait]
impl ApprovalResolver for AutoApproveResolver {
    async fn resolve(&self, request: &ApprovalRequest) -> ApprovalReply {
        if request.catastrophic {
            ApprovalReply::Reject
        } else {
            ApprovalReply::Once
        }
    }
}
