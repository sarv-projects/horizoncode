//! The permission seam's evidence: one call, one policy decision.
//!
//! `F-66` recorded an `allow` **and** a `deny` for the same tool call in one
//! turn, because the tool's re-assertion of the guard was recorded as if it were
//! a second decision. These tests pin the record itself: a call that is
//! authorized and whose grant is spent at the effect produces exactly one
//! `policy_decision` entry, and the spend is visible as ticket lifecycle
//! instead (`ARCH/12` §Tickets, `ARCH/14` §What is recorded, `ACC-P1-04`).

use std::sync::Arc;

use horizoncode_audit::{AuditConfig, AuditLog, EntryKind};
use horizoncode_runner::{AuditedGate, Recorder};
use horizoncode_tools::{GateDecision, PermissionGate, PermissionRequest, PolicyGate};
use horizoncode_types::{SessionId, ToolCallId, TurnId};
use serde_json::json;

/// A recorded access stream beside a real audit store, so the two are separable.
struct Chain {
    _dir: tempfile::TempDir,
    config: AuditConfig,
    session: SessionId,
    turn: TurnId,
    gate: Option<Arc<AuditedGate>>,
}

impl Chain {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let config = AuditConfig {
            root: dir.path().join("audit"),
            ..AuditConfig::default()
        };
        let session = SessionId::new("ses_test");
        let turn = TurnId::new("turn_1");
        let audit = AuditLog::open(config.clone(), &[]).expect("the audit store must open");
        let recorder = Recorder::new().with_audit(Some(Arc::new(audit)));
        recorder.set_session(Some(session.clone()));
        recorder.set_turn(Some(turn.clone()));
        let gate = AuditedGate::new(
            Arc::new(PolicyGate::read_only()) as Arc<dyn PermissionGate>,
            recorder,
            session.clone(),
        );
        Self {
            _dir: dir,
            config,
            session,
            turn,
            gate: Some(Arc::new(gate)),
        }
    }

    fn request(&self) -> PermissionRequest {
        PermissionRequest {
            action: "list".to_owned(),
            tool_name: "list".to_owned(),
            resources: Vec::new(),
            session_id: self.session.clone(),
            source: ToolCallId::new("call_1"),
            turn_id: Some(self.turn.clone()),
            metadata: json!({}),
            targets: Vec::new(),
        }
    }

    /// Reads the recorded entries back, in order.
    fn entries(&self) -> Vec<horizoncode_audit::AuditEntry> {
        let log = AuditLog::open_read_only(self.config.clone()).expect("a read-only open");
        log.entries().expect("readable entries")
    }
}

fn decisions(entries: &[horizoncode_audit::AuditEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| entry.kind == EntryKind::Decision)
        .count()
}

/// The call decides once, spends once, and the record says so: a reader of the
/// chain sees one outcome for the call, not a contradiction.
#[tokio::test]
async fn a_spent_grant_is_not_recorded_as_a_second_policy_decision() {
    let chain = Chain::new();
    let gate = chain.gate.as_ref().expect("the audited gate");
    let request = chain.request();

    assert_eq!(gate.authorize(&request).await, GateDecision::Allow);
    // The tool's re-assertion spends the grant; it decides nothing.
    assert_eq!(gate.consume(&request).await, GateDecision::Allow);

    // The decision is recorded once, and only once. The grant lifecycle that
    // replaces the removed second decision is the gate's own ticket notice, so
    // it is pinned where it is produced: in `horizoncode-tools`' observer tests.
    let entries = chain.entries();
    assert_eq!(
        decisions(&entries),
        1,
        "one call is one decision, however many passes the effect makes: {entries:?}"
    );
    assert!(
        entries.iter().all(|entry| entry.effect.is_some()),
        "a decision entry names its outcome: {entries:?}"
    );
}

/// A denied call is recorded once as a deny, and the refusal is not papered over
/// by a later pass.
#[tokio::test]
async fn a_denied_call_records_exactly_one_decision() {
    let chain = Chain::new();
    let gate = chain.gate.as_ref().expect("the audited gate");
    // `bash` is outside the read-only posture, so the call is refused outright.
    let mut request = chain.request();
    request.action = "bash".to_owned();
    request.tool_name = "bash".to_owned();

    assert!(matches!(
        gate.authorize(&request).await,
        GateDecision::Deny { .. }
    ));
    assert!(
        matches!(gate.consume(&request).await, GateDecision::Deny { .. }),
        "an effect with no grant must not run"
    );

    let entries = chain.entries();
    assert_eq!(
        decisions(&entries),
        1,
        "a refusal is one decision however often the effect asks again: {entries:?}"
    );
}
