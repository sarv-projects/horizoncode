//! The adapter that implements the tool-plane [`PermissionGate`] seam on top of
//! the `agentx-guard` policy engine (`ARCH/12-GUARD.md`).
//!
//! It is the single place a tool call is authorized. `allow` issues a scoped
//! ticket; `deny` is returned to the model as a typed failure and the effect
//! never runs; `ask` is handed to an [`ApprovalResolver`] and, on approval,
//! issues a ticket or persists an exact "always" rule (`REQ-GUARD-003`). A call
//! identity that already resolved to `allow` is memoized, so the registry's
//! assertion and a tool's own re-assertion cannot prompt twice.

use std::collections::HashSet;
use std::sync::{Arc, Mutex};

use agentx_guard::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, Guard, GuardRequest, SavedRule,
    canonical_action, catastrophic,
};
use async_trait::async_trait;

use crate::policy::{
    ApprovalObserver, ApprovalOutcome, ApprovalRecord, GateDecision, PermissionGate,
    PermissionRequest, PolicyOutcome, TicketNotice,
};

/// A permission gate backed by the policy engine.
pub struct GuardPermissionGate {
    guard: Arc<Guard>,
    resolver: Arc<dyn ApprovalResolver>,
    granted: Mutex<HashSet<String>>,
    observer: Mutex<Option<Arc<dyn ApprovalObserver>>>,
}

impl std::fmt::Debug for GuardPermissionGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuardPermissionGate")
            .field("mode", &self.guard.mode())
            .field("policy_hash", &self.guard.policy_hash())
            .finish_non_exhaustive()
    }
}

impl GuardPermissionGate {
    /// Builds a gate over a shared guard and approval resolver.
    #[must_use]
    pub fn new(guard: Arc<Guard>, resolver: Arc<dyn ApprovalResolver>) -> Self {
        Self {
            guard,
            resolver,
            granted: Mutex::new(HashSet::new()),
            observer: Mutex::new(None),
        }
    }

    /// Attaches an observer that is told how each `ask` resolved.
    ///
    /// The observer watches the single authorization path; it cannot change a
    /// decision.
    #[must_use]
    pub fn with_approval_observer(mut self, observer: Arc<dyn ApprovalObserver>) -> Self {
        self.observer = Mutex::new(Some(observer));
        self
    }

    /// Returns the underlying guard.
    #[must_use]
    pub fn guard(&self) -> &Arc<Guard> {
        &self.guard
    }

    fn guard_request(&self, request: &PermissionRequest) -> GuardRequest {
        GuardRequest {
            action: request.action.clone(),
            resources: request.resources.clone(),
            session_id: request.session_id.to_string(),
            source: request.source.to_string(),
            tool: request.tool_name.clone(),
            metadata: request.metadata.clone(),
        }
    }

    fn is_granted(&self, source: &str, action: &str) -> bool {
        self.granted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .contains(&memo_key(source, action))
    }

    fn mark_granted(&self, source: &str, action: &str) {
        self.granted
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(memo_key(source, action));
    }

    /// Tells the attached observer, if any, that a ticket was issued.
    fn notify_ticket(
        &self,
        request: &PermissionRequest,
        ticket_ref: Option<String>,
        granted_by: &'static str,
    ) {
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(observer) = observer {
            observer.on_ticket(&TicketNotice {
                tool: request.tool_name.clone(),
                action: canonical_action(&request.action).to_owned(),
                resources: request.resources.clone(),
                ticket_ref,
                granted_by,
            });
        }
    }

    /// Tells the attached observer, if any, how an approval resolved.
    fn notify(&self, record: &ApprovalRecord) {
        let observer = self
            .observer
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        if let Some(observer) = observer {
            observer.on_approval(record);
        }
    }

    async fn resolve_ask(
        &self,
        request: &PermissionRequest,
        guard_request: &GuardRequest,
    ) -> GateDecision {
        let canonical = canonical_action(&request.action);
        let save = if request.resources.is_empty() {
            vec![SavedRule::new(canonical, "*")]
        } else {
            request
                .resources
                .iter()
                .map(|resource| SavedRule::new(canonical, resource))
                .collect()
        };
        let approval = ApprovalRequest {
            action: canonical.to_owned(),
            tool: request.tool_name.clone(),
            source: request.source.to_string(),
            resources: request.resources.clone(),
            save,
            prompt: format!(
                "approve `{}` for {}",
                request.tool_name,
                if request.resources.is_empty() {
                    "*".to_owned()
                } else {
                    request.resources.join(", ")
                }
            ),
            catastrophic: catastrophic(canonical, &request.resources).is_some(),
        };
        let reply = self.resolver.resolve(&approval).await;
        // One notification, on the single resolution point, so exactly one
        // approval record exists per request (`ACC-P1-03`).
        self.notify(&ApprovalRecord {
            source: request.source.clone(),
            tool: request.tool_name.clone(),
            action: canonical.to_owned(),
            resources: request.resources.clone(),
            outcome: match reply {
                ApprovalReply::Once => ApprovalOutcome::AllowOnce,
                ApprovalReply::Always => ApprovalOutcome::AllowAlways,
                ApprovalReply::Reject => ApprovalOutcome::Reject,
            },
        });
        match reply {
            ApprovalReply::Once => {
                let ticket = self
                    .guard
                    .issue_ticket(guard_request, Some("once".to_owned()));
                self.notify_ticket(request, Some(ticket.id.clone()), "approval_once");
                self.mark_granted(request.source.as_str(), &request.action);
                GateDecision::Allow
            }
            ApprovalReply::Always => {
                for rule in &approval.save {
                    let _ = self.guard.persist_saved_rule(&rule.action, &rule.resource);
                }
                let ticket = self
                    .guard
                    .issue_ticket(guard_request, Some("always".to_owned()));
                self.notify_ticket(request, Some(ticket.id.clone()), "approval_always");
                self.mark_granted(request.source.as_str(), &request.action);
                GateDecision::Allow
            }
            ApprovalReply::Reject => GateDecision::Deny {
                reason: format!("permission rejected for `{}`", request.tool_name),
            },
        }
    }
}

#[async_trait]
impl PermissionGate for GuardPermissionGate {
    async fn authorize(&self, request: &PermissionRequest) -> GateDecision {
        if self.is_granted(request.source.as_str(), &request.action) {
            // The gate was already satisfied for this call, so no second
            // authorization ran. It is still a decision the record must show.
            self.notify_ticket(request, None, "bypassed");
            return GateDecision::Allow;
        }
        let guard_request = self.guard_request(request);
        match self.guard.check(&guard_request) {
            agentx_guard::GuardDecision::Allow => {
                let ticket = self.guard.issue_ticket(&guard_request, None);
                self.notify_ticket(request, Some(ticket.id.clone()), "rule");
                self.mark_granted(request.source.as_str(), &request.action);
                GateDecision::Allow
            }
            agentx_guard::GuardDecision::Deny { reason } => GateDecision::Deny { reason },
            agentx_guard::GuardDecision::Ask => self.resolve_ask(request, &guard_request).await,
        }
    }

    fn classify(&self, request: &PermissionRequest) -> Option<PolicyOutcome> {
        match self.guard.check(&self.guard_request(request)) {
            agentx_guard::GuardDecision::Allow => Some(PolicyOutcome::Allow),
            agentx_guard::GuardDecision::Ask => Some(PolicyOutcome::Ask),
            agentx_guard::GuardDecision::Deny { reason } => Some(PolicyOutcome::Deny { reason }),
        }
    }

    fn wholly_denied(&self, action: &str) -> bool {
        self.guard.wholly_denied(action)
    }
}

/// A memo key that scopes a grant to both the call identity and the action.
fn memo_key(source: &str, action: &str) -> String {
    format!("{source}\u{0}{action}")
}
