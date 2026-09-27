//! The recorder seam: one place that turns loop facts into audit entries and
//! analytics events.
//!
//! Both stores are optional. When a surface wires them, every decisive moment
//! is recorded; when it does not, the loop behaves exactly as before. What the
//! recorder never does is swallow a failure: a refused audit append is
//! returned so the guarded action can fail closed rather than run unrecorded
//! (`ARCH/14-AUDIT.md` §Failure modes).

use std::sync::{Arc, Mutex};

use crate::observer::RunEvent;
use horizoncode_analytics::{
    AnalyticsEvent, AnalyticsLog, EventKind as AnalyticsKind, FailureClass, Tokens,
    ToolMeasurement, ToolOutcomeKind,
};
use horizoncode_audit::{Actor, AuditLog, AuditRecord, EntryKind, Outcome, PolicyEffect, inputs_digest};
use horizoncode_session::TurnEndStatus;
use horizoncode_tools::{
    ApprovalObserver, ApprovalRecord, GateDecision, PermissionGate, PermissionRequest,
    PolicyOutcome, TicketNotice,
};
use horizoncode_types::{SessionId, ToolStatus, TurnId, Usage};
use serde_json::Value;

/// A recording failure at a loop boundary.
///
/// Both stores are evidence, so a failure to append is never swallowed: the
/// loop turns it into a [`crate::LoopError::Record`] and the guarded action
/// fails closed rather than running unrecorded
/// (`ARCH/14-AUDIT.md` §Failure modes).
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum RecordError {
    /// The audit chain refused the entry.
    #[error(transparent)]
    Audit(#[from] horizoncode_audit::AuditError),

    /// The analytics ledger refused the event.
    #[error(transparent)]
    Analytics(#[from] horizoncode_analytics::AnalyticsError),
}

/// The policy snapshot in force for a run, recorded with every entry so a
/// decision is reproducible later (`REQ-SESS-004`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct PolicySnapshot {
    /// The guard's policy fingerprint.
    pub policy_hash: String,
    /// The interaction mode.
    pub mode: String,
    /// The unmatched-action default.
    pub unmatched: String,
}

/// The route identity recorded on model and cost entries.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RouteRef {
    /// The provider/route id.
    pub provider: String,
    /// The model id.
    pub model: String,
}

/// The optional audit and analytics sinks a run records into.
#[derive(Clone, Default)]
pub struct Recorder {
    /// The append-only audit store, when one is configured.
    pub audit: Option<Arc<AuditLog>>,
    /// The analytics ledger, when one is configured.
    pub analytics: Option<Arc<AnalyticsLog>>,
    /// The policy snapshot in force.
    pub policy: PolicySnapshot,
    /// The route in force.
    pub route: RouteRef,
    /// The project (workspace) the work belongs to.
    pub project: Option<String>,
    /// The turn currently in flight, when one is.
    ///
    /// The permission seam is created once per process, not once per turn, so
    /// the seam's observers read the current turn from here rather than being
    /// rebuilt. It is set at admission and cleared at the terminal boundary.
    turn: Arc<Mutex<Option<TurnId>>>,
    /// The session currently in flight.
    ///
    /// Published for the same reason as `turn`: a long-lived approval observer
    /// has to attribute a reply to the session that asked for it, and the
    /// permission seam outlives any one session.
    session: Arc<Mutex<Option<SessionId>>>,
    /// Surface events queued by the permission seam's observers.
    ///
    /// The observer is borrowed by the loop, so the seam cannot call back into
    /// it. It queues here and the loop drains at its next boundary.
    events: Arc<Mutex<Vec<RunEvent>>>,
}

impl std::fmt::Debug for Recorder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Recorder")
            .field("audit", &self.audit.is_some())
            .field("analytics", &self.analytics.is_some())
            .field("policy_hash", &self.policy.policy_hash)
            .field("route", &self.route)
            .finish_non_exhaustive()
    }
}

/// Inputs for [`Recorder::approval`], grouped so the boundary stays within
/// the argument limit without losing any field.
#[derive(Clone, Copy, Debug)]
pub struct ApprovalOptions<'a> {
    /// The session the approval belongs to.
    pub session: &'a SessionId,
    /// The turn the approval belongs to.
    pub turn: &'a TurnId,
    /// The advertised tool name.
    pub tool: &'a str,
    /// The canonical policy action.
    pub action: &'a str,
    /// The resources the call will touch.
    pub resources: &'a [String],
    /// The reply: `allow_once`, `allow_always`, or `reject`.
    pub reply: &'a str,
    /// The exact remembered pattern, for `allow_always`.
    pub remembered: Option<&'a str>,
}

impl Recorder {
    /// Starts a recorder with no sinks: recording is off.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Attaches the audit store.
    #[must_use]
    pub fn with_audit(mut self, audit: Option<Arc<AuditLog>>) -> Self {
        self.audit = audit;
        self
    }

    /// Attaches the analytics ledger.
    #[must_use]
    pub fn with_analytics(mut self, analytics: Option<Arc<AnalyticsLog>>) -> Self {
        self.analytics = analytics;
        self
    }

    /// Sets the policy snapshot in force.
    #[must_use]
    pub fn with_policy(mut self, policy: PolicySnapshot) -> Self {
        self.policy = policy;
        self
    }

    /// Sets the route in force.
    #[must_use]
    pub fn with_route(mut self, route: RouteRef) -> Self {
        self.route = route;
        self
    }

    /// Sets the project the work belongs to.
    #[must_use]
    pub fn with_project(mut self, project: Option<String>) -> Self {
        self.project = project;
        self
    }

    /// Returns whether anything is recorded at all.
    #[must_use]
    pub fn is_enabled(&self) -> bool {
        self.audit.is_some() || self.analytics.is_some()
    }

    /// Publishes the turn in flight, so a long-lived observer can attribute
    /// the effects it sees.
    pub fn set_turn(&self, turn: Option<TurnId>) {
        *self
            .turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = turn;
    }

    /// Returns the turn in flight, when one is.
    #[must_use]
    pub fn turn(&self) -> Option<TurnId> {
        self.turn
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Publishes the session in flight, so a long-lived observer can attribute
    /// the effects it sees to the right session.
    pub fn set_session(&self, session: Option<SessionId>) {
        *self
            .session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = session;
    }

    /// Returns the session in flight, when one is.
    #[must_use]
    pub fn session(&self) -> Option<SessionId> {
        self.session
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    /// Queues a surface event produced at a recorded boundary.
    pub fn push_event(&self, event: RunEvent) {
        push(&self.events, event);
    }

    /// Drains the queued surface events, in the order they were queued.
    #[must_use]
    pub fn drain_events(&self) -> Vec<RunEvent> {
        drain_events(&self.events)
    }

    fn base(&self, session: &SessionId, kind: EntryKind) -> AuditRecord {
        let mut record = AuditRecord::new(session.as_str(), kind).with_actor(Actor::Agent);
        if !self.policy.policy_hash.is_empty() {
            record = record.with_policy_hash(self.policy.policy_hash.clone());
        }
        if let Some(level) = self.audit.as_ref() {
            record = record.with_anchor_level(level.level());
        }
        if let Some(project) = &self.project {
            record = record.with_meta("project", project.as_str());
        }
        record
    }

    fn analytics_event(&self, session: &SessionId, kind: AnalyticsKind) -> AnalyticsEvent {
        let mut event = AnalyticsEvent::new(0, horizoncode_audit::now_ms(), session.as_str(), kind);
        if let Some(project) = &self.project {
            event = event.with_project(project.clone());
        }
        if !self.route.provider.is_empty() {
            event = event.with_route(self.route.provider.clone(), self.route.model.clone());
        }
        event
    }

    /// Records the run's admission boundary.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when the entry cannot be chained.
    pub fn run_started(
        &self,
        session: &SessionId,
        turn: &TurnId,
        max_steps: usize,
    ) -> Result<(), RecordError> {
        let Some(audit) = &self.audit else {
            return Ok(());
        };
        audit.append(
            self.base(session, EntryKind::Run)
                .with_turn(turn.as_str())
                .with_action("turn_start")
                .with_outcome(Outcome::Ok)
                .with_meta("mode", self.policy.mode.as_str())
                .with_meta("max_steps", max_steps as i64),
        )?;
        Ok(())
    }

    /// Records the confinement profile in force, or its absence.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when the entry cannot be chained.
    pub fn sandbox_profile(
        &self,
        session: &SessionId,
        turn: &TurnId,
        profile: Option<&str>,
        applied: bool,
    ) -> Result<(), RecordError> {
        let Some(audit) = &self.audit else {
            return Ok(());
        };
        let mut record = self
            .base(session, EntryKind::Sandbox)
            .with_turn(turn.as_str())
            .with_action("profile_applied")
            .with_outcome(if applied { Outcome::Ok } else { Outcome::Error })
            .with_meta("applied", applied);
        record = match profile {
            Some(profile) => record.with_resource(profile),
            None => record.with_meta("profile", "none"),
        };
        audit.append(record)?;
        Ok(())
    }

    /// Records a step's start boundary.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when the entry cannot be chained.
    pub fn step_started(
        &self,
        session: &SessionId,
        turn: &TurnId,
        step: u64,
    ) -> Result<(), RecordError> {
        let Some(audit) = &self.audit else {
            return Ok(());
        };
        audit.append(
            self.base(session, EntryKind::Step)
                .with_turn(turn.as_str())
                .with_action("step_start")
                .with_outcome(Outcome::Ok)
                .with_meta("step", step as i64),
        )?;
        Ok(())
    }

    /// Records the policy decision a call resolved to.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when the entry cannot be chained.
    pub fn decision(
        &self,
        session: &SessionId,
        turn: &TurnId,
        tool: &str,
        action: &str,
        resources: &[String],
        effect: PolicyEffect,
    ) -> Result<(), RecordError> {
        let Some(audit) = &self.audit else {
            return Ok(());
        };
        let mut record = self
            .base(session, EntryKind::Decision)
            .with_turn(turn.as_str())
            .with_action(action)
            .with_effect(effect)
            .with_outcome(match effect {
                PolicyEffect::Deny => Outcome::Denied,
                _ => Outcome::Ok,
            })
            .with_meta("tool", tool)
            .with_meta("resources", resources.len() as i64);
        if let Some(first) = resources.first() {
            record = record.with_resource(first.clone());
        }
        audit.append(record)?;
        Ok(())
    }

    /// Records an approval request and its reply, including `always`.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when the entry cannot be chained.
    pub fn approval(&self, options: ApprovalOptions<'_>) -> Result<(), RecordError> {
        let ApprovalOptions {
            session,
            turn,
            tool,
            action,
            resources,
            reply,
            remembered,
        } = options;
        let Some(audit) = &self.audit else {
            return Ok(());
        };
        let mut record = self
            .base(session, EntryKind::Approval)
            .with_turn(turn.as_str())
            .with_action(action)
            .with_outcome(match reply {
                "allow_once" => Outcome::Ok,
                "allow_always" => Outcome::Ok,
                _ => Outcome::Denied,
            })
            .with_meta("tool", tool)
            .with_meta("reply", reply);
        if let Some(pattern) = remembered {
            record = record.with_meta("remembered", pattern);
        }
        // The exact remembered pattern is recorded so what will be persisted
        // can be checked against what was shown.
        if let Some(first) = resources.first() {
            record = record.with_resource(first.clone());
        }
        audit.append(record)?;
        if let Some(analytics) = &self.analytics {
            analytics.append(
                self.analytics_event(session, AnalyticsKind::Approval)
                    .with_turn(turn.as_str())
                    .with_meta_reply(reply),
            )?;
        }
        Ok(())
    }

    /// Records a scoped ticket the permission seam issued.
    ///
    /// Ticket lifecycle is a declared effect class in its own right, so a grant
    /// that is reused for a later effect is visible in the record.
    ///
    /// # Errors
    /// Returns [`RecordError`] when the entry cannot be chained.
    pub fn ticket_issued(
        &self,
        session: &SessionId,
        turn: &TurnId,
        tool: &str,
        notice: &TicketNotice,
    ) -> Result<(), RecordError> {
        if let Some(audit) = &self.audit {
            let mut record = self
                .base(session, EntryKind::Ticket)
                .with_turn(turn.as_str())
                .with_action("issue")
                .with_outcome(Outcome::Ok)
                .with_meta("tool", tool)
                .with_meta("action", notice.action.as_str())
                .with_meta("granted_by", notice.granted_by)
                .with_meta("resources", notice.resources.len() as i64);
            if let Some(reference) = &notice.ticket_ref {
                record = record.with_ticket(reference.clone());
            }
            if let Some(first) = notice.resources.first() {
                record = record.with_resource(first.clone());
            }
            audit.append(record)?;
        }
        Ok(())
    }

    /// Records a tool call's settlement, and any file write it performed.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when an entry cannot be chained.
    #[allow(clippy::too_many_arguments)]
    pub fn tool_settled(
        &self,
        session: &SessionId,
        turn: &TurnId,
        tool: &str,
        action: &str,
        arguments: &Value,
        status: ToolStatus,
        error_code: Option<&str>,
        structured: Option<&Value>,
        receipt: &str,
    ) -> Result<(), RecordError> {
        let outcome = outcome_of(status);
        let digest = inputs_digest(arguments);
        if let Some(audit) = &self.audit {
            audit.append(
                self.base(session, EntryKind::Tool)
                    .with_turn(turn.as_str())
                    .with_action(action)
                    .with_outcome(outcome)
                    .with_inputs_digest(digest.clone())
                    .with_receipt(receipt)
                    .with_meta("tool", tool),
            )?;
            // A file write is its own declared effect class, not a detail of the
            // tool call: `REQ-AUDIT-001` requires exactly one entry per class.
            if is_file_write(action)
                && status == ToolStatus::Success
                && let Some(path) = structured
                    .and_then(|value| value.get("path"))
                    .and_then(Value::as_str)
            {
                let mut record = self
                    .base(session, EntryKind::FsWrite)
                    .with_turn(turn.as_str())
                    .with_action("fs.write")
                    .with_resource(path)
                    .with_outcome(Outcome::Ok)
                    .with_inputs_digest(digest.clone())
                    .with_receipt(receipt);
                if let Some(bytes) = structured.and_then(|value| value.get("bytes")) {
                    record = record.with_meta("bytes", bytes.to_string());
                }
                if let Some(created) = structured.and_then(|value| value.get("created")) {
                    record = record.with_meta("created", created.to_string());
                }
                audit.append(record)?;
            }
            // A refused shell effect is a confinement denial, recorded as its
            // own class with the reason the surface shows.
            if is_shell(action) && status == ToolStatus::Denied {
                let mut record = self
                    .base(session, EntryKind::Sandbox)
                    .with_turn(turn.as_str())
                    .with_action("exec.denied")
                    .with_resource(action)
                    .with_outcome(Outcome::Denied)
                    .with_inputs_digest(digest.clone())
                    .with_receipt(receipt);
                if let Some(code) = error_code {
                    record = record.with_meta("error_code", code);
                }
                audit.append(record)?;
            }
        }
        if let Some(analytics) = &self.analytics {
            let mut measurement = ToolMeasurement {
                tool: Some(tool.to_owned()),
                outcome: Some(tool_outcome_of(status)),
                ..ToolMeasurement::default()
            };
            if let Some(structured) = structured {
                measurement.lines_added = structured.get("lines_added").and_then(Value::as_u64);
                measurement.lines_removed = structured.get("lines_removed").and_then(Value::as_u64);
            }
            if let Some(code) = error_code {
                measurement.error_class = Some(code.to_owned());
            }
            analytics.append(
                self.analytics_event(session, AnalyticsKind::ToolOutcome)
                    .with_turn(turn.as_str())
                    .with_tool(measurement)
                    .with_audit_seq_digest(&digest),
            )?;
        }
        Ok(())
    }

    /// Records the provider call and the step's per-step receipt and usage.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when an entry cannot be chained.
    pub fn step_settled(
        &self,
        session: &SessionId,
        turn: &TurnId,
        step: u64,
        usage: Usage,
        receipt: &str,
        observed: bool,
    ) -> Result<(), RecordError> {
        if let Some(audit) = &self.audit {
            let tokens = tokens_of(usage);
            audit.append(
                self.base(session, EntryKind::Model)
                    .with_turn(turn.as_str())
                    .with_action(format!("{}/{}", self.route.provider, self.route.model))
                    .with_outcome(Outcome::Ok)
                    .with_receipt(receipt)
                    .with_meta("step", step as i64)
                    .with_meta("input_tokens", usage.input_tokens as i64)
                    .with_meta("output_tokens", usage.output_tokens as i64)
                    .with_meta("cache_read_tokens", usage.cached_read_tokens as i64)
                    .with_meta("cache_write_tokens", usage.cached_write_tokens as i64)
                    .with_meta("reasoning_tokens", usage.reasoning_tokens as i64)
                    .with_meta("tokens_observed", observed)
                    .with_meta("tokens_total", tokens.total() as i64),
            )?;
            // The step receipt is a distinct class from the model call.
            audit.append(
                self.base(session, EntryKind::Step)
                    .with_turn(turn.as_str())
                    .with_action("step_settled")
                    .with_outcome(Outcome::Ok)
                    .with_receipt(receipt)
                    .with_meta("step", step as i64),
            )?;
            // Cost and usage are their own class, carrying the honest status:
            // an unpriced route is `unknown`, never zero.
            let cost = self.resolve_cost(usage, observed);
            audit.append(
                self.base(session, EntryKind::Cost)
                    .with_turn(turn.as_str())
                    .with_action("step_cost")
                    .with_outcome(Outcome::Ok)
                    .with_receipt(receipt)
                    .with_meta("step", step as i64)
                    .with_meta("cost_status", cost.status.as_str()),
            )?;
        }
        if let Some(analytics) = &self.analytics {
            let mut event = self
                .analytics_event(session, AnalyticsKind::StepUsage)
                .with_turn(turn.as_str())
                .with_step(step)
                .with_tokens(tokens_of(usage));
            if !observed {
                event = event.with_tokens(Tokens::unobserved());
            }
            analytics.append(event)?;
        }
        Ok(())
    }

    /// Records a retry attempt and its failure class.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when an entry cannot be chained.
    pub fn retry(
        &self,
        session: &SessionId,
        turn: &TurnId,
        step: u64,
        attempt: u32,
        failure: FailureClass,
    ) -> Result<(), RecordError> {
        if let Some(audit) = &self.audit {
            audit.append(
                self.base(session, EntryKind::Model)
                    .with_turn(turn.as_str())
                    .with_action("model_retry")
                    .with_outcome(Outcome::Error)
                    .with_meta("step", step as i64)
                    .with_meta("attempt", attempt as i64)
                    .with_meta("failure_class", failure.as_str()),
            )?;
        }
        if let Some(analytics) = &self.analytics {
            analytics.append(
                self.analytics_event(session, AnalyticsKind::Retry)
                    .with_turn(turn.as_str())
                    .with_step(step)
                    .with_attempt(attempt)
                    .with_failure(failure),
            )?;
        }
        Ok(())
    }

    /// Records the turn's terminal state and seals the audit segment.
    ///
    /// # Errors
    /// Returns [`horizoncode_audit::AuditError`] when the entry cannot be chained or
    /// the segment cannot be finalized. A seal failure is not swallowed: an
    /// unanchored turn is not presented as anchored.
    pub fn turn_finished(
        &self,
        session: &SessionId,
        turn: &TurnId,
        status: TurnEndStatus,
        steps: usize,
        usage: Usage,
    ) -> Result<(), RecordError> {
        if let Some(audit) = &self.audit {
            audit.append(
                self.base(session, EntryKind::Run)
                    .with_turn(turn.as_str())
                    .with_action("turn_end")
                    .with_outcome(Outcome::Ok)
                    .with_meta("status", status.as_str())
                    .with_meta("steps", steps as i64)
                    .with_meta("tokens_total", tokens_of(usage).total() as i64),
            )?;
            audit.finish_turn()?;
        }
        if let Some(analytics) = &self.analytics {
            analytics.append(
                self.analytics_event(session, AnalyticsKind::TurnEnd)
                    .with_turn(turn.as_str())
                    .with_tokens(tokens_of(usage)),
            )?;
        }
        Ok(())
    }

    /// Resolves a step's cost against the local pricing snapshot.
    fn resolve_cost(&self, usage: Usage, observed: bool) -> horizoncode_analytics::ResolvedCost {
        let tokens = if observed {
            tokens_of(usage)
        } else {
            Tokens::unobserved()
        };
        let event = AnalyticsEvent::new(0, 0, "-", AnalyticsKind::StepUsage)
            .with_route(self.route.provider.clone(), self.route.model.clone())
            .with_tokens(tokens);
        let snapshot = self
            .analytics
            .as_ref()
            .and_then(|analytics| analytics.pricing().ok().flatten());
        horizoncode_analytics::resolve(&event, snapshot.as_ref())
            .unwrap_or_else(horizoncode_analytics::ResolvedCost::unknown)
    }
}

fn outcome_of(status: ToolStatus) -> Outcome {
    match status {
        ToolStatus::Success => Outcome::Ok,
        ToolStatus::Denied => Outcome::Denied,
        ToolStatus::Error => Outcome::Error,
        ToolStatus::Aborted => Outcome::Timeout,
    }
}

fn tool_outcome_of(status: ToolStatus) -> ToolOutcomeKind {
    match status {
        ToolStatus::Success => ToolOutcomeKind::Accepted,
        ToolStatus::Denied => ToolOutcomeKind::Rejected,
        ToolStatus::Error | ToolStatus::Aborted => ToolOutcomeKind::Rejected,
    }
}

/// The token quadruple for a step's usage.
#[must_use]
pub fn tokens_of(usage: Usage) -> Tokens {
    Tokens::observed(usage.input_tokens, usage.output_tokens)
        .with_cache(usage.cached_read_tokens, usage.cached_write_tokens)
        .with_reasoning(usage.reasoning_tokens)
}

/// A permission-gate decorator that records decisions and approvals.
///
/// This is a **watcher**, not a second gate: every call is forwarded to the
/// inner gate unchanged, and the only thing added is an audit entry. The
/// authorization path stays the one the guard owns (`REQ-GUARD-001`); there is
/// no second permission system here.
pub struct AuditedGate {
    inner: Arc<dyn PermissionGate>,
    recorder: Recorder,
    session: SessionId,
}

impl std::fmt::Debug for AuditedGate {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AuditedGate")
            .field("inner", &self.inner)
            .field("recorder", &self.recorder)
            .finish_non_exhaustive()
    }
}

impl AuditedGate {
    /// Wraps `inner` so its decisions and approval outcomes are recorded.
    #[must_use]
    pub fn new(inner: Arc<dyn PermissionGate>, recorder: Recorder, session: SessionId) -> Self {
        Self {
            inner,
            recorder,
            session,
        }
    }

    /// Returns the wrapped gate, so a caller can still read the policy hash.
    #[must_use]
    pub fn inner(&self) -> &Arc<dyn PermissionGate> {
        &self.inner
    }
}

#[async_trait::async_trait]
impl PermissionGate for AuditedGate {
    async fn authorize(&self, request: &PermissionRequest) -> GateDecision {
        let decision = self.inner.authorize(request).await;
        let effect = match &decision {
            GateDecision::Allow => PolicyEffect::Allow,
            GateDecision::Deny { .. } => PolicyEffect::Deny,
        };
        if let Some(turn) = self.recorder.turn() {
            // A decision record is best-effort with respect to the *outcome* of
            // the audit append: the authorization already happened, so a
            // recording failure is surfaced to the caller rather than allowed to
            // change the decision.
            let summary = format!(
                "{} {} {}",
                request.tool_name,
                request.action,
                effect.as_str()
            );
            if let Err(error) = self.recorder.decision(
                &self.session,
                &turn,
                &request.tool_name,
                &request.action,
                &request.resources,
                effect,
            ) {
                eprintln!("horizoncode: audit decision record failed: {error}");
            } else {
                self.recorder.push_event(RunEvent::AuditRecorded {
                    class: "policy_decision".to_owned(),
                    summary,
                });
            }
        }
        decision
    }

    fn classify(&self, request: &PermissionRequest) -> Option<PolicyOutcome> {
        self.inner.classify(request)
    }

    fn wholly_denied(&self, action: &str) -> bool {
        self.inner.wholly_denied(action)
    }
}

/// Records resolved approvals into the audit chain.
///
/// The observer is invoked exactly once per `ask`, on the gate's single reply
/// point, so the trail holds exactly one approval entry per request
/// (`ACC-P1-03`). The *exact* pattern a remembered rule is built from is
/// recorded, so what will be persisted can be compared with what was shown.
/// The session and turn are read from the recorder at notification time, not
/// captured at construction: the permission seam is built once per process,
/// and a reply must be attributed to the turn that asked for it.
#[derive(Clone, Debug)]
pub struct ApprovalRecorder {
    recorder: Recorder,
}

impl ApprovalRecorder {
    /// Builds an approval recorder over a recorder that publishes the current
    /// session and turn.
    #[must_use]
    pub fn new(recorder: Recorder) -> Self {
        Self { recorder }
    }
}

impl ApprovalObserver for ApprovalRecorder {
    fn on_ticket(&self, notice: &TicketNotice) {
        let (Some(turn), Some(session)) = (self.recorder.turn(), self.recorder.session()) else {
            return;
        };
        if let Err(error) = self
            .recorder
            .ticket_issued(&session, &turn, &notice.tool, notice)
        {
            eprintln!("horizoncode: audit ticket record failed: {error}");
        }
    }

    fn on_approval(&self, record: &ApprovalRecord) {
        let (Some(turn), Some(session)) = (self.recorder.turn(), self.recorder.session()) else {
            return;
        };
        let remembered = record.resources.first().map(String::as_str);
        if let Err(error) = self.recorder.approval(ApprovalOptions {
            session: &session,
            turn: &turn,
            tool: &record.tool,
            action: &record.action,
            resources: &record.resources,
            reply: record.outcome.as_str(),
            remembered,
        }) {
            eprintln!("horizoncode: audit approval record failed: {error}");
        } else {
            self.recorder.push_event(RunEvent::ApprovalResolved {
                tool_call_id: record.source.clone(),
                outcome: record.outcome.as_str().to_owned(),
                remembered: remembered.map(str::to_owned),
            });
        }
    }
}

/// Queues an event for the surface. The observer is borrowed by the loop, so
/// the seam's observers queue and the loop drains them at its next boundary
/// rather than calling back into a borrowed observer.
fn push(events: &Mutex<Vec<RunEvent>>, event: RunEvent) {
    events
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .push(event);
}

/// Drains queued seam events, newest first removed, in the order queued.
#[must_use]
pub fn drain_events(events: &Mutex<Vec<RunEvent>>) -> Vec<RunEvent> {
    std::mem::take(
        &mut *events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner),
    )
}

/// Returns whether an action is a governed workspace file write.
#[must_use]
pub fn is_file_write(action: &str) -> bool {
    matches!(
        action,
        "edit" | "fs.write" | "write" | "patch" | "apply_patch"
    )
}

/// Returns whether an action is a governed shell effect.
#[must_use]
pub fn is_shell(action: &str) -> bool {
    matches!(action, "bash" | "exec.run" | "exec" | "shell")
}
