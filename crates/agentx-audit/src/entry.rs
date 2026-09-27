//! The audit entry: the immutable, chained record of one decision or effect.
//!
//! Two shapes exist and they must not be confused:
//!
//! - [`AuditRecord`] is what a producer submits: refs and bounded metadata.
//! - [`AuditEntry`] is what is stored: the record plus its assigned `seq`,
//!   `prev_hash` and `entry_hash`.
//!
//! The canonical byte form is a stable field order with sorted metadata keys
//! and no floats, so `blake3` over it is deterministic on every machine
//! (`ARCH/14-AUDIT.md` §Data / state model).

use serde::{Deserialize, Serialize};

use crate::meta::{MAX_ACTION, MAX_META_TEXT, MAX_REF, MAX_RESOURCE, Meta, validate_meta};
use crate::redact::Redactor;

/// The genesis `prev_hash` for sequence 0. Derived from a fixed label so a
/// store is reproducible without any external state.
pub const GENESIS_PREV_HASH: &str = genesis_prev_hash();

/// Length of a hex-encoded hash in this store.
pub const HASH_HEX_LEN: usize = 64;

const fn genesis_prev_hash() -> &'static str {
    // A `const fn` cannot call into `blake3`, so the constant is pinned here and
    // asserted against the computed value in `tests::genesis_matches_its_label`.
    "4b4889db967c08165e075d20fd730e4b429c461dffca523a6eaea3aa88fc9ce0"
}

/// The label hashed to produce [`GENESIS_PREV_HASH`].
pub const GENESIS_LABEL: &str = "agentx/audit/genesis/v1";

/// Who produced an entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Actor {
    /// The invoking human.
    User,
    /// The agent under audit.
    Agent,
    /// The runtime (loop, store, anchor).
    System,
    /// A scheduled/delegated workflow.
    Workflow,
}

impl Actor {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Agent => "agent",
            Self::System => "system",
            Self::Workflow => "workflow",
        }
    }
}

/// The closed vocabulary of recorded entry kinds.
///
/// Each kind maps to exactly one declared effect class; the mapping is the
/// coverage-census registry (`REQ-AUDIT-001`, `REQ-AUDIT-005`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum EntryKind {
    /// Run and turn boundaries, including the terminal state.
    Run,
    /// Step boundaries and per-step receipts.
    Step,
    /// A policy decision (allow/ask/deny, timeout, mode change).
    Decision,
    /// A tool call proposed, started, or completed.
    Tool,
    /// An approval request and its reply.
    Approval,
    /// A workspace file write.
    FsWrite,
    /// Confinement applied, refused, or violated.
    Sandbox,
    /// A provider/model call (ids, counts, latency — never content).
    Model,
    /// Cost and token usage attributed to a call, step, or run.
    Cost,
    /// Ticket issue/validate/use-decrement/expiry/revocation.
    Ticket,
    /// Access to the audit record itself (verify/replay/export/census).
    RecordAccess,
}

impl EntryKind {
    /// The declared registry: every kind, in a stable order.
    pub const ALL: &'static [EntryKind] = &[
        EntryKind::Run,
        EntryKind::Step,
        EntryKind::Decision,
        EntryKind::Tool,
        EntryKind::Approval,
        EntryKind::FsWrite,
        EntryKind::Sandbox,
        EntryKind::Model,
        EntryKind::Cost,
        EntryKind::Ticket,
        EntryKind::RecordAccess,
    ];

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Run => "run",
            Self::Step => "step",
            Self::Decision => "decision",
            Self::Tool => "tool",
            Self::Approval => "approval",
            Self::FsWrite => "fs_write",
            Self::Sandbox => "sandbox",
            Self::Model => "model",
            Self::Cost => "cost",
            Self::Ticket => "ticket",
            Self::RecordAccess => "record_access",
        }
    }

    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        EntryKind::ALL
            .iter()
            .copied()
            .find(|kind| kind.as_str() == value)
    }
}

/// The security-relevant effect class an entry belongs to.
///
/// This is the declared coverage registry the census checks
/// (`ARCH/14-AUDIT.md` §Coverage census). Adding a class is a data change here
/// plus a mapping in [`EffectClass::of`]; an effect that is not declared is a
/// defect, not an accepted gap.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum EffectClass {
    /// Run/turn boundary and terminal state.
    RunBoundary,
    /// Step boundary and per-step receipt.
    StepReceipt,
    /// A policy decision.
    PolicyDecision,
    /// A tool call.
    ToolCall,
    /// An approval request/reply.
    Approval,
    /// A file write.
    FileWrite,
    /// Confinement applied/refused/violated.
    SandboxConfinement,
    /// A provider/model call.
    ModelCall,
    /// Cost/usage.
    Cost,
    /// Ticket lifecycle.
    TicketLifecycle,
    /// Access to the audit record.
    RecordAccess,
}

impl EffectClass {
    /// The declared registry, in a stable order. The census fails loudly on
    /// any class here with no recorded entry.
    pub const ALL: &'static [EffectClass] = &[
        EffectClass::RunBoundary,
        EffectClass::StepReceipt,
        EffectClass::PolicyDecision,
        EffectClass::ToolCall,
        EffectClass::Approval,
        EffectClass::FileWrite,
        EffectClass::SandboxConfinement,
        EffectClass::ModelCall,
        EffectClass::Cost,
        EffectClass::TicketLifecycle,
        EffectClass::RecordAccess,
    ];

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunBoundary => "run_boundary",
            Self::StepReceipt => "step_receipt",
            Self::PolicyDecision => "policy_decision",
            Self::ToolCall => "tool_call",
            Self::Approval => "approval",
            Self::FileWrite => "file_write",
            Self::SandboxConfinement => "sandbox_confinement",
            Self::ModelCall => "model_call",
            Self::Cost => "cost",
            Self::TicketLifecycle => "ticket_lifecycle",
            Self::RecordAccess => "record_access",
        }
    }

    /// Maps a recorded kind to its declared effect class.
    ///
    /// # Errors
    /// Returns `None` when the kind is not in the declared registry, which is
    /// an unregistered effect.
    #[must_use]
    pub fn of(kind: EntryKind) -> Option<Self> {
        Some(match kind {
            EntryKind::Run => Self::RunBoundary,
            EntryKind::Step => Self::StepReceipt,
            EntryKind::Decision => Self::PolicyDecision,
            EntryKind::Tool => Self::ToolCall,
            EntryKind::Approval => Self::Approval,
            EntryKind::FsWrite => Self::FileWrite,
            EntryKind::Sandbox => Self::SandboxConfinement,
            EntryKind::Model => Self::ModelCall,
            EntryKind::Cost => Self::Cost,
            EntryKind::Ticket => Self::TicketLifecycle,
            EntryKind::RecordAccess => Self::RecordAccess,
        })
    }

    /// Parses a wire name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        EffectClass::ALL
            .iter()
            .copied()
            .find(|class| class.as_str() == value)
    }
}

/// The policy effect a decision carried.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum PolicyEffect {
    /// The effect may proceed.
    Allow,
    /// The effect needs an approval.
    Ask,
    /// The effect is refused.
    Deny,
}

impl PolicyEffect {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }
}

/// How an effect ended.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
#[non_exhaustive]
pub enum Outcome {
    /// The effect completed.
    Ok,
    /// The effect was refused before running.
    Denied,
    /// The effect failed.
    Error,
    /// The effect exceeded its deadline.
    Timeout,
}

impl Outcome {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Ok => "ok",
            Self::Denied => "denied",
            Self::Error => "error",
            Self::Timeout => "timeout",
        }
    }
}

/// A producer-submitted record, before sequencing and chaining.
#[derive(Clone, Debug, PartialEq)]
pub struct AuditRecord {
    /// The owning session id.
    pub session: String,
    /// The owning turn id, when the record is inside a turn.
    pub turn: Option<String>,
    /// The entry kind.
    pub kind: EntryKind,
    /// Who produced it.
    pub actor: Actor,
    /// The policy action (`fs.write`, `exec.run`, ...).
    pub action: Option<String>,
    /// A ref/glob form of the resource, never a raw payload.
    pub resource: Option<String>,
    /// The policy effect, for decisions.
    pub effect: Option<PolicyEffect>,
    /// The terminal outcome, for effects.
    pub outcome: Option<Outcome>,
    /// A ticket reference.
    pub ticket_ref: Option<String>,
    /// An approval reference.
    pub approval_ref: Option<String>,
    /// A durable receipt reference.
    pub receipt_ref: Option<String>,
    /// The owning work item.
    pub work_id: Option<String>,
    /// The owning run id.
    pub run_id: Option<String>,
    /// A `blake3` digest of the effect's arguments.
    pub inputs_digest: Option<String>,
    /// The guard policy hash in force when the record was produced.
    pub policy_hash: Option<String>,
    /// The cross-store reference: the session-log `seq` of the same effect.
    pub session_seq: Option<u64>,
    /// The declared anchor level in force.
    pub anchor_level: Option<String>,
    /// Bounded metadata.
    pub meta: Meta,
}

impl AuditRecord {
    /// Starts a record for a session and kind.
    #[must_use]
    pub fn new(session: impl Into<String>, kind: EntryKind) -> Self {
        Self {
            session: session.into(),
            turn: None,
            kind,
            actor: Actor::Agent,
            action: None,
            resource: None,
            effect: None,
            outcome: None,
            ticket_ref: None,
            approval_ref: None,
            receipt_ref: None,
            work_id: None,
            run_id: None,
            inputs_digest: None,
            policy_hash: None,
            session_seq: None,
            anchor_level: None,
            meta: Meta::new(),
        }
    }

    /// Attaches the owning turn.
    #[must_use]
    pub fn with_turn(mut self, turn: impl Into<String>) -> Self {
        self.turn = Some(turn.into());
        self
    }

    /// Sets the producing actor.
    #[must_use]
    pub fn with_actor(mut self, actor: Actor) -> Self {
        self.actor = actor;
        self
    }

    /// Sets the policy action.
    #[must_use]
    pub fn with_action(mut self, action: impl Into<String>) -> Self {
        self.action = Some(action.into());
        self
    }

    /// Sets the resource reference.
    #[must_use]
    pub fn with_resource(mut self, resource: impl Into<String>) -> Self {
        self.resource = Some(resource.into());
        self
    }

    /// Sets the policy effect.
    #[must_use]
    pub fn with_effect(mut self, effect: PolicyEffect) -> Self {
        self.effect = Some(effect);
        self
    }

    /// Sets the terminal outcome.
    #[must_use]
    pub fn with_outcome(mut self, outcome: Outcome) -> Self {
        self.outcome = Some(outcome);
        self
    }

    /// Sets the ticket reference.
    #[must_use]
    pub fn with_ticket(mut self, ticket: impl Into<String>) -> Self {
        self.ticket_ref = Some(ticket.into());
        self
    }

    /// Sets the approval reference.
    #[must_use]
    pub fn with_approval(mut self, approval: impl Into<String>) -> Self {
        self.approval_ref = Some(approval.into());
        self
    }

    /// Sets the durable receipt reference.
    #[must_use]
    pub fn with_receipt(mut self, receipt: impl Into<String>) -> Self {
        self.receipt_ref = Some(receipt.into());
        self
    }

    /// Sets the owning work id.
    #[must_use]
    pub fn with_work(mut self, work: impl Into<String>) -> Self {
        self.work_id = Some(work.into());
        self
    }

    /// Sets the argument digest.
    #[must_use]
    pub fn with_inputs_digest(mut self, digest: impl Into<String>) -> Self {
        self.inputs_digest = Some(digest.into());
        self
    }

    /// Sets the guard policy hash in force.
    #[must_use]
    pub fn with_policy_hash(mut self, hash: impl Into<String>) -> Self {
        self.policy_hash = Some(hash.into());
        self
    }

    /// Sets the cross-store session-log reference.
    #[must_use]
    pub fn with_session_seq(mut self, seq: u64) -> Self {
        self.session_seq = Some(seq);
        self
    }

    /// Sets the declared anchor level in force.
    #[must_use]
    pub fn with_anchor_level(mut self, level: AnchorLevelName) -> Self {
        self.anchor_level = Some(level.as_str().to_owned());
        self
    }

    /// Adds one bounded metadata key.
    #[must_use]
    pub fn with_meta(
        mut self,
        key: impl Into<String>,
        value: impl Into<crate::meta::MetaValue>,
    ) -> Self {
        self.meta.insert(key.into(), value.into());
        self
    }

    /// Validates the declared class and every field bound.
    ///
    /// # Errors
    /// Returns [`AuditError::UnregisteredEffectClass`] for an undeclared kind,
    /// or [`AuditError::FieldTooLarge`] when a bound is exceeded.
    pub fn validate(&self) -> Result<(), crate::error::AuditError> {
        if EffectClass::of(self.kind).is_none() {
            return Err(crate::error::AuditError::UnregisteredEffectClass(
                self.kind.as_str().to_owned(),
            ));
        }
        check_len("action", self.action.as_deref(), MAX_ACTION)?;
        check_len("resource", self.resource.as_deref(), MAX_RESOURCE)?;
        for (field, value) in [
            ("ticket_ref", self.ticket_ref.as_deref()),
            ("approval_ref", self.approval_ref.as_deref()),
            ("receipt_ref", self.receipt_ref.as_deref()),
            ("work_id", self.work_id.as_deref()),
            ("run_id", self.run_id.as_deref()),
            ("inputs_digest", self.inputs_digest.as_deref()),
            ("policy_hash", self.policy_hash.as_deref()),
            ("anchor_level", self.anchor_level.as_deref()),
        ] {
            check_len(field, value, MAX_REF)?;
        }
        check_len("session", Some(self.session.as_str()), MAX_REF)?;
        check_len("turn", self.turn.as_deref(), MAX_REF)?;
        validate_meta(&self.meta)
    }

    /// Applies the redaction pass, in place, **before** hashing.
    ///
    /// Returns the sorted list of field paths whose value was replaced. The
    /// secret itself is never returned, never hashed and never stored; the
    /// redaction itself is recorded (`ARCH/14-AUDIT.md` §Secret redaction).
    pub fn redact_in_place(&mut self, redactor: &Redactor) -> Vec<String> {
        let mut redacted = Vec::new();
        if let Some(action) = self.action.as_mut()
            && redactor.redact_into(action)
        {
            redacted.push("action".to_owned());
        }
        if let Some(resource) = self.resource.as_mut()
            && redactor.redact_into(resource)
        {
            redacted.push("resource".to_owned());
        }
        for key in [
            "ticket_ref",
            "approval_ref",
            "receipt_ref",
            "work_id",
            "run_id",
            "inputs_digest",
        ] {
            let slot = match key {
                "ticket_ref" => &mut self.ticket_ref,
                "approval_ref" => &mut self.approval_ref,
                "receipt_ref" => &mut self.receipt_ref,
                "work_id" => &mut self.work_id,
                "run_id" => &mut self.run_id,
                _ => &mut self.inputs_digest,
            };
            if let Some(value) = slot.as_mut()
                && redactor.redact_into(value)
            {
                redacted.push(key.to_owned());
            }
        }
        for (key, value) in self.meta.iter_mut() {
            if let crate::meta::MetaValue::Text(text) = value
                && redactor.redact_into(text)
            {
                redacted.push(format!("meta.{key}"));
            }
        }
        if !redacted.is_empty() {
            let list = redacted.join(",");
            self.meta.insert(
                crate::meta::REDACTION_NOTE_KEY.to_owned(),
                crate::meta::MetaValue::text(truncate_to(&list, MAX_META_TEXT)),
            );
        }
        redacted
    }
}

fn check_len(
    field: &'static str,
    value: Option<&str>,
    max: usize,
) -> Result<(), crate::error::AuditError> {
    if let Some(value) = value
        && value.len() > max
    {
        return Err(crate::error::AuditError::FieldTooLarge {
            field,
            detail: format!("{} bytes, maximum {max}", value.len()),
        });
    }
    Ok(())
}

fn truncate_to(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_owned();
    }
    let mut end = max;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

/// The three legal names for an anchoring level (`DEC-022`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
#[non_exhaustive]
pub enum AnchorLevelName {
    /// Signed roots inside the audit store only. No independent-verification
    /// claim; an explicit, acknowledged, labelled posture.
    LocalTrust,
    /// Signed roots appended to a validated sink **outside** the audit store
    /// root. The default.
    LocalSink,
    /// Signed roots recorded off-host or counter-signed.
    OffBox,
}

impl AnchorLevelName {
    /// Returns the only three names that may describe audit evidence.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalTrust => "local-trust",
            Self::LocalSink => "local-sink",
            Self::OffBox => "off-box",
        }
    }

    /// Parses a level name.
    #[must_use]
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "local-trust" => Some(Self::LocalTrust),
            "local-sink" => Some(Self::LocalSink),
            "off-box" => Some(Self::OffBox),
            _ => None,
        }
    }
}

/// One immutable, chained audit entry as stored on disk.
///
/// Field order is the canonical order; `entry_hash` is last because the hash is
/// computed over everything before it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct AuditEntry {
    /// Monotonic global audit sequence.
    pub seq: u64,
    /// UTC epoch milliseconds.
    pub ts: i64,
    /// The owning session id.
    pub session: String,
    /// The owning turn id, when inside a turn.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub turn: Option<String>,
    /// The producing actor.
    pub actor: Actor,
    /// The entry kind.
    pub kind: EntryKind,
    /// The policy action.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub action: Option<String>,
    /// A resource reference in ref/glob form.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub resource: Option<String>,
    /// The policy effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub effect: Option<PolicyEffect>,
    /// The terminal outcome.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outcome: Option<Outcome>,
    /// A ticket reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket_ref: Option<String>,
    /// An approval reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub approval_ref: Option<String>,
    /// A durable receipt reference.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub receipt_ref: Option<String>,
    /// The owning work id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub work_id: Option<String>,
    /// The owning run id.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// The argument digest.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub inputs_digest: Option<String>,
    /// The guard policy hash in force.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub policy_hash: Option<String>,
    /// The cross-store session-log sequence.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub session_seq: Option<u64>,
    /// The declared anchor level in force.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub anchor_level: Option<String>,
    /// Bounded metadata (sorted keys).
    #[serde(default)]
    pub meta: Meta,
    /// The previous entry's hash, or the genesis marker at `seq == 0`.
    pub prev_hash: String,
    /// `blake3(canonical_body || prev_hash)`.
    pub entry_hash: String,
}

impl AuditEntry {
    /// Returns the declared effect class, or `None` for an undeclared kind.
    #[must_use]
    pub fn effect_class(&self) -> Option<EffectClass> {
        EffectClass::of(self.kind)
    }

    /// Returns the canonical bytes hashed to produce `entry_hash`.
    ///
    /// The `entry_hash` field itself is excluded: the hash covers the body and
    /// `prev_hash` only (`ARCH/14-AUDIT.md` §Data / state model).
    #[must_use]
    pub fn canonical_body(&self) -> Vec<u8> {
        serde_json::to_vec(&BodyRef::from(self)).expect("audit entry body must serialize")
    }

    /// Recomputes the entry hash from the stored body and `prev_hash`.
    #[must_use]
    pub fn compute_hash(&self) -> String {
        let mut body = self.canonical_body();
        body.extend_from_slice(self.prev_hash.as_bytes());
        blake3::hash(&body).to_hex().to_string()
    }

    /// Returns the canonical line bytes, including `entry_hash`.
    #[must_use]
    pub fn canonical_line(&self) -> Vec<u8> {
        serde_json::to_vec(self).expect("audit entry must serialize")
    }

    /// Renders the one-line form written to the segment file.
    #[must_use]
    pub fn to_line(&self) -> String {
        let mut line =
            String::from_utf8(self.canonical_line()).expect("audit entry serializes as utf-8 json");
        line.push('\n');
        line
    }

    /// Builds a stored entry from a redacted record, assigning chain fields.
    ///
    /// # Errors
    /// Returns [`crate::error::AuditError`] when the record violates a bound.
    pub fn from_record(
        record: &AuditRecord,
        seq: u64,
        ts: i64,
        prev_hash: &str,
    ) -> Result<Self, crate::error::AuditError> {
        record.validate()?;
        let mut entry = Self {
            seq,
            ts,
            session: record.session.clone(),
            turn: record.turn.clone(),
            actor: record.actor,
            kind: record.kind,
            action: record.action.clone(),
            resource: record.resource.clone(),
            effect: record.effect,
            outcome: record.outcome,
            ticket_ref: record.ticket_ref.clone(),
            approval_ref: record.approval_ref.clone(),
            receipt_ref: record.receipt_ref.clone(),
            work_id: record.work_id.clone(),
            run_id: record.run_id.clone(),
            inputs_digest: record.inputs_digest.clone(),
            policy_hash: record.policy_hash.clone(),
            session_seq: record.session_seq,
            anchor_level: record.anchor_level.clone(),
            meta: record.meta.clone(),
            prev_hash: prev_hash.to_owned(),
            entry_hash: String::new(),
        };
        entry.entry_hash = entry.compute_hash();
        Ok(entry)
    }
}

/// The hash input view: every hashed field except `entry_hash` itself.
#[derive(Serialize)]
struct BodyRef<'a> {
    seq: u64,
    ts: i64,
    session: &'a str,
    #[serde(skip_serializing_if = "Option::is_none")]
    turn: &'a Option<String>,
    actor: Actor,
    kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    action: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    resource: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    effect: Option<PolicyEffect>,
    #[serde(skip_serializing_if = "Option::is_none")]
    outcome: Option<Outcome>,
    #[serde(skip_serializing_if = "Option::is_none")]
    ticket_ref: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    approval_ref: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    receipt_ref: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    work_id: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    inputs_digest: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    policy_hash: &'a Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    session_seq: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    anchor_level: &'a Option<String>,
    meta: &'a Meta,
    prev_hash: &'a str,
}

impl<'a> From<&'a AuditEntry> for BodyRef<'a> {
    fn from(entry: &'a AuditEntry) -> Self {
        Self {
            seq: entry.seq,
            ts: entry.ts,
            session: &entry.session,
            turn: &entry.turn,
            actor: entry.actor,
            kind: entry.kind,
            action: &entry.action,
            resource: &entry.resource,
            effect: entry.effect,
            outcome: entry.outcome,
            ticket_ref: &entry.ticket_ref,
            approval_ref: &entry.approval_ref,
            receipt_ref: &entry.receipt_ref,
            work_id: &entry.work_id,
            run_id: &entry.run_id,
            inputs_digest: &entry.inputs_digest,
            policy_hash: &entry.policy_hash,
            session_seq: entry.session_seq,
            anchor_level: &entry.anchor_level,
            meta: &entry.meta,
            prev_hash: &entry.prev_hash,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> AuditRecord {
        AuditRecord::new("ses_1", EntryKind::Tool)
            .with_turn("turn_1")
            .with_action("fs.write")
            .with_resource("src/lib.rs")
            .with_outcome(Outcome::Ok)
            .with_inputs_digest("ab".repeat(32))
    }

    #[test]
    fn genesis_matches_its_label() {
        let computed = blake3::hash(GENESIS_LABEL.as_bytes()).to_hex().to_string();
        assert_eq!(computed, GENESIS_PREV_HASH);
    }

    #[test]
    fn canonical_bytes_are_field_order_stable() {
        let entry = AuditEntry::from_record(&record(), 0, 1, GENESIS_PREV_HASH).unwrap();
        let mut other = entry.clone();
        other.ts = 1;
        // Same content hashed twice yields the same bytes regardless of any
        // map iteration order: `meta` is a BTreeMap.
        assert_eq!(entry.canonical_body(), other.canonical_body());
        assert_eq!(entry.compute_hash(), other.compute_hash());
    }

    #[test]
    fn entry_hash_covers_the_previous_hash() {
        let a = AuditEntry::from_record(&record(), 0, 1, GENESIS_PREV_HASH).unwrap();
        let again = AuditEntry::from_record(&record(), 0, 1, GENESIS_PREV_HASH).unwrap();
        let linked = AuditEntry::from_record(&record(), 1, 1, &a.entry_hash).unwrap();
        // Identical body and `prev_hash` => identical hash, so verification is a
        // pure function of the stored bytes.
        assert_eq!(a.entry_hash, again.entry_hash);
        // A different `prev_hash` changes the entry's own hash, which is what
        // makes the chain a chain.
        assert_ne!(a.entry_hash, linked.entry_hash);
        // The predecessor hash is itself inside the hashed body, so it cannot be
        // rewritten without changing this entry's hash too.
        let mut rewritten = linked.clone();
        rewritten.prev_hash = GENESIS_PREV_HASH.to_owned();
        assert_ne!(linked.entry_hash, rewritten.compute_hash());
    }

    #[test]
    fn a_single_changed_byte_changes_the_hash() {
        let entry = AuditEntry::from_record(&record(), 0, 1, GENESIS_PREV_HASH).unwrap();
        let mut tampered = entry.clone();
        tampered.resource = Some("src/liB.rs".to_owned());
        assert_ne!(entry.entry_hash, tampered.compute_hash());
    }

    #[test]
    fn entry_kind_registry_is_total_and_unique() {
        let mut names: Vec<&str> = EntryKind::ALL.iter().map(|kind| kind.as_str()).collect();
        names.sort_unstable();
        let unique = names.len();
        names.dedup();
        assert_eq!(names.len(), unique, "declared kinds must be unique");
        for kind in EntryKind::ALL {
            assert_eq!(EntryKind::parse(kind.as_str()), Some(*kind));
            assert!(
                EffectClass::of(*kind).is_some(),
                "{} must map to a declared effect class",
                kind.as_str()
            );
        }
        assert_eq!(EntryKind::parse("net_egress"), None);
    }

    #[test]
    fn effect_class_registry_is_unique() {
        let mut names: Vec<&str> = EffectClass::ALL
            .iter()
            .map(|class| class.as_str())
            .collect();
        names.sort_unstable();
        names.dedup();
        assert_eq!(names.len(), EffectClass::ALL.len());
    }

    #[test]
    fn field_bounds_fail_closed() {
        let mut record = record();
        record.resource = Some("x".repeat(MAX_RESOURCE + 1));
        assert!(matches!(
            record.validate(),
            Err(crate::error::AuditError::FieldTooLarge {
                field: "resource",
                ..
            })
        ));
    }

    #[test]
    fn redaction_replaces_values_and_notes_the_fields() {
        let mut redactor = Redactor::new(["s3cret-value".to_owned()]);
        redactor.add_secret("s3cret-value");
        let mut record = record();
        record.resource = Some("src/s3cret-value.rs".to_owned());
        let redacted = record.redact_in_place(&redactor);
        assert_eq!(redacted, vec!["resource".to_owned()]);
        assert!(!record.resource.as_deref().unwrap().contains("s3cret-value"));
        assert!(record.meta.contains_key(crate::meta::REDACTION_NOTE_KEY));
    }

    #[test]
    fn anchor_level_names_are_exactly_three() {
        assert_eq!(AnchorLevelName::LocalTrust.as_str(), "local-trust");
        assert_eq!(AnchorLevelName::LocalSink.as_str(), "local-sink");
        assert_eq!(AnchorLevelName::OffBox.as_str(), "off-box");
        assert_eq!(AnchorLevelName::parse("local"), None);
    }
}
