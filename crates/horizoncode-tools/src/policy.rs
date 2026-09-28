//! The permission-assertion seam invoked before every tool execution.
//!
//! The guard owns the allow/ask/deny *rules* (`CMP-guard`); this module owns
//! the *seam* through which the tool plane asserts an action. The default
//! posture fails closed (`REQ-GUARD-002`).

use std::collections::BTreeSet;
use std::fmt;
use std::fmt::Debug;

use async_trait::async_trait;
use horizoncode_types::{SessionId, ToolCallId, TurnId};
use serde_json::Value;

/// One `(action, resources)` pair a call names.
///
/// A shell command is judged as a command prefix for `exec.run` **and** as the
/// `fs.*` paths its arguments name. Both travel in the same request, so the guard
/// returns exactly one decision over the whole set (`ARCH/10` §Permission
/// assertion, `DEC-025`). The tool plane only extracts; it never decides.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PermissionTarget {
    /// The policy action for this pair.
    pub action: String,
    /// The resources this pair names.
    pub resources: Vec<String>,
}

impl PermissionTarget {
    /// Builds a target.
    #[must_use]
    pub fn new(action: impl Into<String>, resources: Vec<String>) -> Self {
        Self {
            action: action.into(),
            resources,
        }
    }
}

/// What a tool asks the guard to authorize.
#[derive(Clone, Debug, PartialEq)]
pub struct PermissionRequest {
    /// The policy action (for example `read` or `edit`).
    pub action: String,
    /// The advertised tool name.
    pub tool_name: String,
    /// The non-secret resources the call will touch.
    pub resources: Vec<String>,
    /// The session the call belongs to.
    pub session_id: SessionId,
    /// The tool call id, so approvals tie back to the exact call.
    pub source: ToolCallId,
    /// The turn the call was issued in, when it is inside one.
    ///
    /// The call identity is the pair *(turn, call id)*, because a provider's
    /// tool-call id is a correlation token and is only required to be unique
    /// among the calls of one response. A turn makes a reused id in a *later*
    /// turn a different call instead of an indistinguishable replay, while a
    /// replay inside the turn that issued it is still the same call
    /// (`ARCH/12` §Tickets).
    pub turn_id: Option<TurnId>,
    /// Additional non-secret context for the approval surface.
    pub metadata: Value,
    /// Further action domains the same call names, beyond `action`.
    pub targets: Vec<PermissionTarget>,
}

/// The guard's answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GateDecision {
    /// The effect may proceed.
    Allow,
    /// The effect must not run.
    Deny {
        /// A short reason surfaced to the model.
        reason: String,
    },
}

/// A policy evaluation before ask-resolution.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum PolicyOutcome {
    /// The action is allowed.
    Allow,
    /// The action must prompt an approval surface.
    Ask,
    /// The action is denied.
    Deny {
        /// A short reason.
        reason: String,
    },
}

/// The permission-assertion interface.
///
/// Implementations may be synchronous policy (`PolicyGate`) or may round-trip
/// to a client (`session/request_permission` in the ACP surface).
#[async_trait]
pub trait PermissionGate: Send + Sync + Debug {
    /// Authorizes one action. This is the decision point: the call is
    /// authorized, and a gate that holds grants issues the grant here.
    async fn authorize(&self, request: &PermissionRequest) -> GateDecision;

    /// Spends the authorization a call already holds, at the effect boundary.
    ///
    /// A tool re-asserts immediately before its effect, and that second pass is
    /// *not* a second policy decision — it is the single-use grant being
    /// consumed. Separating the two keeps a replay from looking like a new
    /// request and keeps one call from producing a contradictory pair of
    /// decision records (`ARCH/12` §Tickets, `F-66`).
    ///
    /// A stateless gate has nothing to spend and re-evaluates, so the default
    /// is [`PermissionGate::authorize`].
    async fn consume(&self, request: &PermissionRequest) -> GateDecision {
        self.authorize(request).await
    }

    /// Returns whether the action is wholly denied, so the tool is absent from
    /// the model's advertised set rather than merely blocked at call time
    /// (`REQ-TOOL-003`).
    fn wholly_denied(&self, _action: &str) -> bool {
        false
    }

    /// Classifies a request without resolving an `ask`, so a surface can emit an
    /// approval request before the async authorization runs.
    ///
    /// The default returns `None` (unknown), which emits no approval event.
    fn classify(&self, _request: &PermissionRequest) -> Option<PolicyOutcome> {
        None
    }
}

/// A sink for resolved approvals.
///
/// The permission seam stays the single authorization path: an observer only
/// *watches* it. `GuardPermissionGate` notifies exactly once per `ask`, on the
/// one place a reply is produced, so exactly one approval record exists per
/// request (`ACC-P1-03`).
pub trait ApprovalObserver: Send + Sync + fmt::Debug {
    /// Records how one approval resolved.
    fn on_approval(&self, record: &ApprovalRecord);

    /// Records that a scoped ticket was issued for an allowed effect.
    ///
    /// The default does nothing: an observer that does not track tickets pays
    /// nothing.
    fn on_ticket(&self, _record: &TicketNotice) {}
}

/// A scoped ticket issued for an allowed effect.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TicketNotice {
    /// The tool name.
    pub tool: String,
    /// The canonical policy action.
    pub action: String,
    /// The exact resources the ticket is scoped to.
    pub resources: Vec<String>,
    /// The ticket reference, when the gate exposes one.
    pub ticket_ref: Option<String>,
    /// Whether the ticket came from an approval (`once`/`always`) or from a
    /// rule that allowed the effect outright.
    pub granted_by: &'static str,
}

/// An observer that discards everything.
#[derive(Clone, Copy, Debug, Default)]
pub struct NullApprovalObserver;

impl ApprovalObserver for NullApprovalObserver {
    fn on_approval(&self, _record: &ApprovalRecord) {}
}

/// How a request that would otherwise prompt is resolved.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AskResolution {
    /// Approve (used by an interactive surface or an explicit headless posture).
    Allow,
    /// Reject (the headless default; never blocks on stdin).
    Deny,
}

/// How an `ask` resolved.
///
/// This is the tool plane's own neutral vocabulary. `GuardPermissionGate`
/// maps the guard's reply onto it, so a surface can observe the outcome —
/// including `always` — without knowing which resolver answered. The default
/// implementation notifies nobody, so a gate that is not interested pays
/// nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[non_exhaustive]
pub enum ApprovalOutcome {
    /// Approved for this call only.
    AllowOnce,
    /// Approved and remembered as a rule for later calls.
    AllowAlways,
    /// Refused.
    Reject,
}

impl ApprovalOutcome {
    /// Returns the stable wire name recorded in the audit trail.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::AllowOnce => "allow_once",
            Self::AllowAlways => "allow_always",
            Self::Reject => "reject",
        }
    }
}

/// A resolved approval, as observed on the permission seam.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ApprovalRecord {
    /// The call the approval was for.
    pub source: ToolCallId,
    /// The tool name.
    pub tool: String,
    /// The canonical policy action.
    pub action: String,
    /// The exact resources the call would touch — the pattern a remembered
    /// rule is built from, so what is persisted can be checked against what was
    /// shown.
    pub resources: Vec<String>,
    /// How the approval resolved.
    pub outcome: ApprovalOutcome,
}

/// A deterministic, ordered action policy.
///
/// Evaluation order is deny → ask → allow → default. The default posture is
/// fail closed: an unmatched action is denied.
#[derive(Clone, Debug)]
pub struct PolicyGate {
    deny: BTreeSet<String>,
    ask: BTreeSet<String>,
    allow: BTreeSet<String>,
    ask_resolution: AskResolution,
}

impl PolicyGate {
    /// Builds the default read-only posture: the read-only action set is
    /// allowed, everything else fails closed.
    #[must_use]
    pub fn read_only() -> Self {
        Self {
            deny: BTreeSet::new(),
            ask: BTreeSet::new(),
            allow: ["read", "glob", "grep", "list"]
                .into_iter()
                .map(str::to_owned)
                .collect(),
            ask_resolution: AskResolution::Deny,
        }
    }

    /// Adds actions that are always allowed.
    #[must_use]
    pub fn allow(mut self, actions: impl IntoIterator<Item = String>) -> Self {
        self.allow.extend(actions);
        self
    }

    /// Adds actions that always prompt (resolved per [`AskResolution`]).
    #[must_use]
    pub fn ask(mut self, actions: impl IntoIterator<Item = String>) -> Self {
        self.ask.extend(actions);
        self
    }

    /// Adds actions that are always denied.
    #[must_use]
    pub fn deny(mut self, actions: impl IntoIterator<Item = String>) -> Self {
        self.deny.extend(actions);
        self
    }

    /// Sets how `ask` actions resolve.
    #[must_use]
    pub fn with_ask_resolution(mut self, resolution: AskResolution) -> Self {
        self.ask_resolution = resolution;
        self
    }

    /// Returns the configured allow set (useful for diagnostics and tests).
    #[must_use]
    pub fn allowed_actions(&self) -> Vec<String> {
        self.allow.iter().cloned().collect()
    }

    /// Returns the configured ask set.
    #[must_use]
    pub fn ask_actions(&self) -> Vec<String> {
        self.ask.iter().cloned().collect()
    }

    /// Returns the configured deny set.
    #[must_use]
    pub fn deny_actions(&self) -> Vec<String> {
        self.deny.iter().cloned().collect()
    }

    /// Evaluates the ordered policy for an action.
    ///
    /// Order: deny → ask → allow → fail-closed default. This is the raw
    /// evaluation; [`PermissionGate::authorize`] additionally collapses `Ask`
    /// per the configured [`AskResolution`], while an interactive surface can
    /// use `evaluate` directly to decide whether to prompt (`REQ-GUARD-001`).
    #[must_use]
    pub fn evaluate(&self, action: &str) -> PolicyOutcome {
        if self.deny.contains(action) {
            return PolicyOutcome::Deny {
                reason: format!("action `{action}` is denied by policy"),
            };
        }
        if self.ask.contains(action) {
            return PolicyOutcome::Ask;
        }
        if self.allow.contains(action) {
            return PolicyOutcome::Allow;
        }
        PolicyOutcome::Deny {
            reason: format!("action `{action}` is not permitted by the default posture"),
        }
    }
}

impl Default for PolicyGate {
    fn default() -> Self {
        Self::read_only()
    }
}

#[async_trait]
impl PermissionGate for PolicyGate {
    async fn authorize(&self, request: &PermissionRequest) -> GateDecision {
        match self.evaluate(&request.action) {
            PolicyOutcome::Allow => GateDecision::Allow,
            PolicyOutcome::Deny { reason } => GateDecision::Deny { reason },
            PolicyOutcome::Ask => match self.ask_resolution {
                AskResolution::Allow => GateDecision::Allow,
                AskResolution::Deny => GateDecision::Deny {
                    reason: format!(
                        "action `{}` requires approval that is unavailable",
                        request.action
                    ),
                },
            },
        }
    }

    fn wholly_denied(&self, action: &str) -> bool {
        self.deny.contains(action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use horizoncode_types::ToolCallId;
    use serde_json::json;

    fn request(action: &str) -> PermissionRequest {
        PermissionRequest {
            action: action.to_owned(),
            tool_name: action.to_owned(),
            resources: vec!["a.txt".to_owned()],
            session_id: SessionId::new("ses_test"),
            source: ToolCallId::new("call_1"),
            turn_id: Some(TurnId::generate()),
            metadata: json!({}),
            targets: Vec::new(),
        }
    }

    #[tokio::test]
    async fn read_only_posture_allows_reads_and_fails_closed() {
        let gate = PolicyGate::read_only();
        assert_eq!(gate.authorize(&request("read")).await, GateDecision::Allow);
        assert_eq!(gate.authorize(&request("grep")).await, GateDecision::Allow);
        assert!(matches!(
            gate.authorize(&request("bash")).await,
            GateDecision::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn deny_wins_over_allow() {
        let gate = PolicyGate::read_only().deny(["read".to_owned()]);
        assert!(gate.wholly_denied("read"));
        assert!(matches!(
            gate.authorize(&request("read")).await,
            GateDecision::Deny { .. }
        ));
    }

    #[tokio::test]
    async fn ask_resolution_is_configurable() {
        let deny_gate = PolicyGate::read_only().ask(["read".to_owned()]);
        assert!(matches!(
            deny_gate.authorize(&request("read")).await,
            GateDecision::Deny { .. }
        ));
        let allow_gate = PolicyGate::read_only()
            .ask(["read".to_owned()])
            .with_ask_resolution(AskResolution::Allow);
        assert_eq!(
            allow_gate.authorize(&request("read")).await,
            GateDecision::Allow
        );
    }
}
