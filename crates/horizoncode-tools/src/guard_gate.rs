//! The adapter that implements the tool-plane [`PermissionGate`] seam on top of
//! the `horizoncode-guard` policy engine (`ARCH/12-GUARD.md`).
//!
//! It is the single place a tool call is authorized. `allow` issues a scoped,
//! single-use ticket; `deny` is returned to the model as a typed failure and the
//! effect never runs; `ask` is handed to an [`ApprovalResolver`] and, on approval,
//! issues a single-use ticket or persists an exact "always" rule
//! (`REQ-GUARD-003`).
//!
//! ## One decision, one grant, one effect
//!
//! There are two passes over a call, and they are different acts:
//!
//! - [`PermissionGate::authorize`] is the **decision**: it evaluates the policy
//!   once, records that decision, and issues a single-use grant for it.
//! - [`PermissionGate::consume`] is the tool's re-assertion immediately before
//!   its effect: it **spends** that grant, checking scope, action, expiry,
//!   remaining uses, and the policy fingerprint it was issued under, then removes
//!   it. It never decides anything, so it is never recorded as a decision.
//!
//! Collapsing the two is what produced `F-66`: a call recorded an `allow` and
//! then a `deny` for the same effect, and every read-only call that named no
//! resource failed its own re-assertion because the grant's coverage set was
//! empty. Keeping them apart also means "allow once" still means once — the
//! grant is consumed at the effect, and a replayed identity has nothing left to
//! spend.

use std::collections::{HashMap, HashSet};
use std::sync::{Arc, Mutex};

use async_trait::async_trait;
use horizoncode_guard::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, Guard, GuardRequest, SavedRule, Ticket,
    canonical_action, catastrophic,
};

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
    /// request cannot widen a narrow grant, and a whole-action request is not
    /// covered by a narrow grant. This is grant bookkeeping, not policy: whether
    /// the grant was authorized at all is the guard's answer, recorded here at
    /// issue time.
    fn covers(&self, action: &str, resource: &str) -> bool {
        self.pairs.iter().any(|(granted, value)| {
            granted == action && (value == resource || value == WILDCARD_RESOURCE)
        })
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
            guard_request =
                guard_request.with_target(target.action.clone(), target.resources.clone());
        }
        guard_request
    }

    /// Every `(action, resource)` pair a request names, as the guard sees them.
    ///
    /// A request that names no resource is a **whole-action** request, which the
    /// guard evaluates against the wildcard (`Guard::evaluate_pairs`) and whose
    /// ticket is scoped to `**` (`Guard::issue_ticket`). This bookkeeping must
    /// record that same wildcard: mapping it to nothing instead would produce a
    /// grant that covers no pair at all, and a tool that names its default
    /// resource at the effect boundary could never spend it. That made every
    /// resource-less call — `list` with no arguments, for instance — fail its own
    /// re-assertion after the guard had already allowed it (`F-66`).
    fn pairs(request: &PermissionRequest) -> Vec<(String, String)> {
        let action = canonical_action(&request.action).to_owned();
        let mut pairs: Vec<(String, String)> = if request.resources.is_empty() {
            vec![(action, WILDCARD_RESOURCE.to_owned())]
        } else {
            request
                .resources
                .iter()
                .map(|resource| (action.clone(), resource.clone()))
                .collect()
        };
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
    fn is_granted(&self, request: &PermissionRequest) -> bool {
        self.lock_grants().contains_key(&identity_key(request))
    }

    fn take_grant(&self, request: &PermissionRequest) -> Option<Grant> {
        self.lock_grants().remove(&identity_key(request))
    }

    /// Records the grant issued for a call identity.
    fn mark_granted(&self, request: &PermissionRequest, ticket: Ticket) {
        self.lock_grants().insert(
            identity_key(request),
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
        let Some(grant) = self.take_grant(request) else {
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
                save.push(SavedRule::new(canonical_action(&target.action), resource));
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
    /// Makes the policy decision and issues the grant it implies.
    ///
    /// This is the *only* place a call is decided, so a call produces exactly one
    /// decision. The effect boundary calls [`PermissionGate::consume`], which
    /// spends the grant rather than deciding again.
    async fn authorize(&self, request: &PermissionRequest) -> GateDecision {
        let key = identity_key(request);
        if self.lock_spent().contains(&key) {
            return GateDecision::Deny {
                reason:
                    "this call was already authorized and its single-use grant spent; re-authorize \
                          as a new call rather than replaying it"
                        .to_owned(),
            };
        }
        // A live grant for this identity means the caller is asking twice where
        // one decision was already made. Issuing a second grant would make the
        // effect's own spend ambiguous, so it is refused with the reason.
        if self.is_granted(request) {
            return GateDecision::Deny {
                reason:
                    "this call already holds a live authorization; spend it at the effect boundary \
                          instead of authorizing it again"
                        .to_owned(),
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
            horizoncode_guard::GuardDecision::Ask => {
                self.resolve_ask(request, &guard_request).await
            }
        }
    }

    /// Spends the grant the decision issued, at the effect boundary.
    ///
    /// The coverage check is re-run here rather than waved through, because the
    /// request the effect names is the one that must be covered — a request that
    /// grew since it was authorized is refused before the use is spent, and the
    /// ticket is validated against the current policy fingerprint, so a widened
    /// or narrowed policy cannot be spent through the old grant.
    async fn consume(&self, request: &PermissionRequest) -> GateDecision {
        if !self.is_granted(request) {
            // Either the grant was already spent, or this identity never had
            // one. Both are refusals: an effect runs only on a grant this call
            // still holds.
            return GateDecision::Deny {
                reason: "no live authorization ticket covers this effect".to_owned(),
            };
        }
        match self.spend(request) {
            Ok(()) => {
                self.lock_spent().insert(identity_key(request));
                self.notify_ticket(request, None, "validated");
                GateDecision::Allow
            }
            Err(reason) => GateDecision::Deny { reason },
        }
    }

    fn classify(&self, request: &PermissionRequest) -> Option<PolicyOutcome> {
        match self.guard.check(&self.guard_request(request)) {
            horizoncode_guard::GuardDecision::Allow => Some(PolicyOutcome::Allow),
            horizoncode_guard::GuardDecision::Ask => Some(PolicyOutcome::Ask),
            horizoncode_guard::GuardDecision::Deny { reason } => {
                Some(PolicyOutcome::Deny { reason })
            }
        }
    }

    fn wholly_denied(&self, action: &str) -> bool {
        self.guard.wholly_denied(action)
    }
}

/// A memo key that scopes a grant to the call identity, the turn, and the
/// action.
///
/// The turn belongs in the identity because a provider's tool-call id is a
/// correlation token: it is only required to be unique among the calls of one
/// response, and a model that reuses an id in a later turn has issued a *new*
/// call. Scoping the key this way keeps replay protection where it is exact —
/// within the turn that issued the grant — instead of turning an id collision
/// into a denial of a legitimate later call (`F-66`).
fn identity_key(request: &PermissionRequest) -> String {
    let turn = request.turn_id.as_ref().map_or("-", |turn| turn.as_str());
    format!(
        "{turn}\u{0}{}\u{0}{}",
        request.source.as_str(),
        request.action
    )
}

/// The resource a whole-action request is evaluated against, matching the
/// guard's own normalization and its ticket scope.
const WILDCARD_RESOURCE: &str = "**";
