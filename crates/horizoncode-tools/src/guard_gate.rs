//! The adapter that implements the tool-plane [`PermissionGate`] seam on top of
//! the `horizoncode-guard` policy engine (`ARCH/12-GUARD.md`).
//!
//! It is the single place a tool call is authorized. `allow` issues a scoped,
//! single-use ticket; `deny` is returned to the model as a typed failure and the
//! effect never runs; `ask` is handed to an [`ApprovalResolver`] and, on approval,
//! issues a single-use ticket or persists an exact "always" rule
//! (`REQ-GUARD-003`).
//!
//! ## The ticket is validated, not merely issued
//! An authorization is only a *proposal*; the effect needs a grant. So a second
//! authorization for the same call identity — which is exactly what a tool's
//! re-assertion immediately before its effect is — does not shortcut to `allow`:
//! it **spends** the ticket, checking its scope, its action, its expiry, its
//! remaining uses, and the policy fingerprint it was issued under, and then
//! removes it. "Allow once" therefore means once: a replayed call identity has no
//! ticket left to spend and is refused.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use horizoncode_guard::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, Guard, GuardRequest, SavedRule, Ticket,
    canonical_action, catastrophic,
};
use async_trait::async_trait;

use crate::policy::{
    ApprovalObserver, ApprovalOutcome, ApprovalRecord, GateDecision, PermissionGate,
    PermissionRequest, PolicyOutcome, TicketNotice,
};

/// A live authorization: the ticket plus the exact `(action, resource)` set the
/// grant covers.
///
/// The ticket proves the grant is live (expiry, remaining uses, policy
/// fingerprint); the pair set proves the effect asks for what was authorized. A
/// request that names anything else is refused before the use is spent.
#[derive(Clone, Debug)]
struct Grant {
    ticket: Ticket,
    pairs: Vec<(String, String)>,
}

impl Grant {
    /// Returns whether the grant covers one `(action, resource)` pair.
    ///
    /// A grant issued for the **whole action** — the wildcard resource a request
    /// carries when the tool named none — covers every resource of that action.
    /// A grant issued for a specific resource covers only that resource, so a
    /// request cannot widen a narrow grant. This is grant bookkeeping, not policy:
    /// whether the grant was authorized at all is the guard's answer, recorded
    /// here at issue time.
    fn covers(&self, action: &str, resource: &str) -> bool {
        self.pairs
            .iter()
            .any(|(granted, value)| granted == action && (value == resource || value == "**"))
    }
}

/// A permission gate backed by the policy engine.
pub struct GuardPermissionGate {
    guard: Arc<Guard>,
    resolver: Arc<dyn ApprovalResolver>,
    /// The live grant for each call identity, if one has been issued.
    grants: Mutex<HashMap<String, Grant>>,
    /// Call identities whose grant has already been spent.
    ///
    /// A spent identity can never be authorized again, so "allow once" means once
    /// even if the same call is replayed against this process.
    spent: Mutex<HashSet<String>>,
    observer: Mutex<Option<Arc<dyn ApprovalObserver>>>,
}

impl std::fmt::Debug for GuardPermissionGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuardPermissionGate")
            .field("mode", &self.guard.mode())
            .field("policy_hash", &self.guard.policy_hash())
            .field("live_grants", &self.grants.lock().map(|g| g.len()).ok())
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
            grants: Mutex::new(HashMap::new()),
            spent: Mutex::new(HashSet::new()),
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

    /// Returns the number of grants issued and not yet spent.
    #[must_use]
    pub fn live_grants(&self) -> usize {
        self.lock_grants().len()
    }

    fn lock_grants(&self) -> std::sync::MutexGuard<'_, HashMap<String, Grant>> {
        self.grants
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn lock_spent(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.spent
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    fn guard_request(&self, request: &PermissionRequest) -> GuardRequest {
        let mut guard_request = GuardRequest {
            action: request.action.clone(),
            resources: request.resources.clone(),
            session_id: request.session_id.to_string(),
            source: request.source.to_string(),
            tool: request.tool_name.clone(),
            metadata: request.metadata.clone(),
            targets: Vec::new(),
        };
        for target in &request.targets {
            guard_request = guard_request.with_target(target.action.clone(), target.resources.clone());
        }
        guard_request
    }

    /// Every `(action, resource)` pair a request names, as the guard sees them.
    fn pairs(request: &PermissionRequest) -> Vec<(String, String)> {
        let mut pairs: Vec<(String, String)> = request
            .resources
            .iter()
            .map(|resource| (canonical_action(&request.action).to_owned(), resource.clone()))
            .collect();
        for target in &request.targets {
            for resource in &target.resources {
                pairs.push((
                    canonical_action(&target.action).to_owned(),
                    resource.clone(),
                ));
            }
        }
        pairs
    }

    /// Returns whether a live grant is held for this call identity.
    fn is_granted(&self, source: &str, action: &str) -> bool {
        self.lock_grants()
            .contains_key(&memo_key(source, action))
    }

    fn take_grant(&self, source: &str, action: &str) -> Option<Grant> {
        self.lock_grants()
            .remove(&memo_key(source, action))
    }

    /// Records the grant issued for a call identity.
    fn mark_granted(&self, request: &PermissionRequest, ticket: Ticket) {
        self.lock_grants().insert(
            memo_key(request.source.as_str(), &request.action),
            Grant {
                ticket,
                pairs: Self::pairs(request),
            },
        );
    }

    /// Drops every outstanding grant.
    ///
    /// A provider restart or a cancellation revokes the grants already issued:
    /// they were made against a policy and an epoch that no longer hold
    /// (`ARCH/12` §Tickets). Each revoked call identity is marked spent, so the
    /// effect that was in flight cannot quietly re-authorize itself against the
    /// new state — it has to be re-run as a new call.
    pub fn revoke_all(&self) {
        let mut grants = self.lock_grants();
        let mut spent = self.lock_spent();
        for key in grants.keys() {
            spent.insert(key.clone());
        }
        grants.clear();
        drop(grants);
        drop(spent);
        self.guard.revoke_all_tickets();
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

    /// Spends the grant held for this call identity, or explains why it cannot.
    ///
    /// Every pair the request names must be one the grant was issued for, and the
    /// ticket must still be live under the current policy. A request that grew
    /// after it was authorized is refused **before** the use is spent, so the
    /// grant cannot be narrowed into a wider effect.
    fn spend(&self, request: &PermissionRequest) -> Result<(), String> {
        let Some(grant) = self.take_grant(request.source.as_str(), &request.action) else {
            return Err("no live authorization ticket covers this call".to_owned());
        };
        for pair in Self::pairs(request) {
            if !grant.covers(&pair.0, &pair.1) {
                // The grant is already removed, so the identity cannot be retried.
                return Err(format!(
                    "the authorization does not cover `{}` on `{}`",
                    pair.0, pair.1
                ));
            }
        }
        self.guard
            .consume_ticket(&grant.ticket.id)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    async fn resolve_ask(
        &self,
        request: &PermissionRequest,
        guard_request: &GuardRequest,
    ) -> GateDecision {
        let canonical = canonical_action(&request.action);
        let mut save = Vec::new();
        if request.resources.is_empty() {
            save.push(SavedRule::new(canonical, "*"));
        } else {
            save.extend(
                request
                    .resources
                    .iter()
                    .map(|resource| SavedRule::new(canonical, resource)),
            );
        }
        // The approval names every resource the call touches, including the
        // paths a shell argument carried, so what "always" would remember is what
        // the user was shown (`REQ-GUARD-003`).
        for target in &request.targets {
            for resource in &target.resources {
                save.push(SavedRule::new(
                    canonical_action(&target.action),
                    resource,
                ));
            }
        }
        let named: Vec<String> = request
            .resources
            .iter()
            .cloned()
            .chain(
                request
                    .targets
                    .iter()
                    .flat_map(|target| target.resources.iter().cloned()),
            )
            .collect();
        let approval = ApprovalRequest {
            action: canonical.to_owned(),
            tool: request.tool_name.clone(),
            source: request.source.to_string(),
            resources: named.clone(),
            save,
            prompt: format!(
                "approve `{}` for {}",
                request.tool_name,
                if named.is_empty() {
                    "*".to_owned()
                } else {
                    named.join(", ")
                }
            ),
            catastrophic: catastrophic(canonical, &named).is_some(),
        };
        let reply = self.resolver.resolve(&approval).await;
        // One notification, on the single resolution point, so exactly one
        // approval record exists per request (`ACC-P1-03`).
        self.notify(&ApprovalRecord {
            source: request.source.clone(),
            tool: request.tool_name.clone(),
            action: canonical.to_owned(),
            resources: named,
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
                self.mark_granted(request, ticket);
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
                self.mark_granted(request, ticket);
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
        let key = memo_key(request.source.as_str(), &request.action);
        if self.lock_spent().contains(&key) {
            return GateDecision::Deny {
                reason: "this call was already authorized and its single-use grant spent;                          re-authorize as a new call rather than replaying it"
                    .to_owned(),
            };
        }
        // A grant already exists for this call identity: this is the effect's own
        // re-assertion, so the grant is spent here rather than waved through.
        if self.is_granted(request.source.as_str(), &request.action) {
            return match self.spend(request) {
                Ok(()) => {
                    self.lock_spent().insert(key);
                    self.notify_ticket(request, None, "validated");
                    GateDecision::Allow
                }
                Err(reason) => GateDecision::Deny { reason },
            };
        }
        let guard_request = self.guard_request(request);
        match self.guard.check(&guard_request) {
            horizoncode_guard::GuardDecision::Allow => {
                let ticket = self.guard.issue_ticket(&guard_request, None);
                self.notify_ticket(request, Some(ticket.id.clone()), "rule");
                self.mark_granted(request, ticket);
                GateDecision::Allow
            }
            horizoncode_guard::GuardDecision::Deny { reason } => GateDecision::Deny { reason },
            horizoncode_guard::GuardDecision::Ask => self.resolve_ask(request, &guard_request).await,
        }
    }

    fn classify(&self, request: &PermissionRequest) -> Option<PolicyOutcome> {
        match self.guard.check(&self.guard_request(request)) {
            horizoncode_guard::GuardDecision::Allow => Some(PolicyOutcome::Allow),
            horizoncode_guard::GuardDecision::Ask => Some(PolicyOutcome::Ask),
            horizoncode_guard::GuardDecision::Deny { reason } => Some(PolicyOutcome::Deny { reason }),
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
