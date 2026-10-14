//! Durable, non-executing managed-work admission fence.
//!
//! This is the first P2 state owner, not a scheduler or an execution permission.
//! The private OwnerLogV2 stream owns immutable spec acceptance and Run admission.
//! No user-facing RPC exposes these commands until authenticated ingress, leases,
//! effect reconciliation and independent verification are implemented.

use crate::owner_log::{
    DurabilityProfile, OwnerEventInput, OwnerIdentity, OwnerLogError, OwnerLogV2,
};
use crate::protocol::CursorV1;
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::num::NonZeroUsize;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Debug)]
pub enum ManagedError {
    Storage(OwnerLogError),
    Invalid(&'static str),
    Conflict(&'static str),
}

impl From<OwnerLogError> for ManagedError {
    fn from(value: OwnerLogError) -> Self {
        Self::Storage(value)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum RunPhase {
    Running,
    Reconciling,
    Cancelling,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecVersion {
    pub digest: String,
    pub criteria: Vec<String>,
    pub accepted: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub dependencies: Vec<String>,
    pub active_attempt: Option<String>,
    pub unknown_effect: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub spec_id: String,
    pub phase: RunPhase,
    pub tasks: BTreeMap<String, Task>,
}

#[derive(Clone, Debug, Default)]
pub struct ManagedSnapshot {
    pub revision: u64,
    pub goal_digest: Option<String>,
    pub specs: BTreeMap<String, SpecVersion>,
    pub runs: BTreeMap<String, Run>,
    attempts: BTreeSet<String>,
    deliveries: BTreeMap<String, String>,
}

/// Commands contain only control identifiers and digests, never conversation
/// transcripts or mutable provider messages.
#[derive(Clone, Debug)]
pub enum ManagedCommand {
    CreateGoal { objective_digest: String },
    ProposeSpec { spec_id: String, digest: String, criteria: Vec<String> },
    AcceptSpec { spec_id: String },
    StartRun { run_id: String, spec_id: String },
    AddTask { run_id: String, task_id: String, dependencies: Vec<String> },
    AdmitAttempt { run_id: String, task_id: String, attempt_id: String },
    MarkAttemptUnknown { run_id: String, task_id: String, attempt_id: String },
    RequestCancel { run_id: String },
}

impl ManagedCommand {
    fn event(&self) -> (&'static str, Value) {
        match self {
            Self::CreateGoal { objective_digest } =>
                ("goal.created", json!({"objectiveDigest": objective_digest})),
            Self::ProposeSpec { spec_id, digest, criteria } =>
                ("spec.proposed", json!({"specId": spec_id, "digest": digest, "criteria": criteria})),
            Self::AcceptSpec { spec_id } =>
                ("spec.accepted", json!({"specId": spec_id})),
            Self::StartRun { run_id, spec_id } =>
                ("run.started", json!({"runId": run_id, "specId": spec_id})),
            Self::AddTask { run_id, task_id, dependencies } =>
                ("task.created", json!({"runId": run_id, "taskId": task_id, "dependencies": dependencies})),
            Self::AdmitAttempt { run_id, task_id, attempt_id } =>
                ("attempt.admitted", json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id})),
            Self::MarkAttemptUnknown { run_id, task_id, attempt_id } =>
                ("attempt.unknown", json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id})),
            Self::RequestCancel { run_id } =>
                ("run.cancelling", json!({"runId": run_id})),
        }
    }

    fn decode(kind: &str, payload: &Value) -> Result<Self, ManagedError> {
        fn field(payload: &Value, name: &str) -> Result<String, ManagedError> {
            payload.get(name).and_then(Value::as_str).map(str::to_owned)
                .ok_or(ManagedError::Invalid("managed event field missing or wrong type"))
        }
        fn list(payload: &Value, name: &str) -> Result<Vec<String>, ManagedError> {
            payload.get(name).and_then(Value::as_array)
                .ok_or(ManagedError::Invalid("managed event array missing"))?
                .iter().map(|item| item.as_str().map(str::to_owned)
                    .ok_or(ManagedError::Invalid("managed event array item invalid"))).collect()
        }
        let count = payload.as_object()
            .ok_or(ManagedError::Invalid("managed event payload must be object"))?.len();
        let command = match kind {
            "goal.created" if count == 1 =>
                Self::CreateGoal { objective_digest: field(payload, "objectiveDigest")? },
            "spec.proposed" if count == 3 =>
                Self::ProposeSpec { spec_id: field(payload, "specId")?, digest: field(payload, "digest")?, criteria: list(payload, "criteria")? },
            "spec.accepted" if count == 1 =>
                Self::AcceptSpec { spec_id: field(payload, "specId")? },
            "run.started" if count == 2 =>
                Self::StartRun { run_id: field(payload, "runId")?, spec_id: field(payload, "specId")? },
            "task.created" if count == 3 =>
                Self::AddTask { run_id: field(payload, "runId")?, task_id: field(payload, "taskId")?, dependencies: list(payload, "dependencies")? },
            "attempt.admitted" if count == 3 =>
                Self::AdmitAttempt { run_id: field(payload, "runId")?, task_id: field(payload, "taskId")?, attempt_id: field(payload, "attemptId")? },
            "attempt.unknown" if count == 3 =>
                Self::MarkAttemptUnknown { run_id: field(payload, "runId")?, task_id: field(payload, "taskId")?, attempt_id: field(payload, "attemptId")? },
            "run.cancelling" if count == 1 =>
                Self::RequestCancel { run_id: field(payload, "runId")? },
            _ => return Err(ManagedError::Invalid("unknown managed event kind or fields")),
        };
        Ok(command)
    }
}

fn id(value: &str) -> Result<(), ManagedError> {
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c)) {
        return Err(ManagedError::Invalid("invalid managed identifier"));
    }
    Ok(())
}

fn digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71 || !value.starts_with("sha256:") ||
        !value.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit) {
        return Err(ManagedError::Invalid("invalid managed digest"));
    }
    Ok(())
}

impl ManagedSnapshot {
    fn apply(&mut self, command: &ManagedCommand) -> Result<(), ManagedError> {
        match command {
            ManagedCommand::CreateGoal { objective_digest } => {
                digest(objective_digest)?;
                if self.goal_digest.is_some() { return Err(ManagedError::Conflict("goal already exists")); }
                self.goal_digest = Some(objective_digest.clone());
            }
            ManagedCommand::ProposeSpec { spec_id, digest: spec_digest, criteria } => {
                id(spec_id)?;
                digest(spec_digest)?;
                if self.goal_digest.is_none() { return Err(ManagedError::Conflict("goal not created")); }
                if self.specs.contains_key(spec_id) { return Err(ManagedError::Conflict("spec ID already used")); }
                if criteria.is_empty() || criteria.len() > 256 { return Err(ManagedError::Invalid("invalid acceptance criteria count")); }
                let mut seen = BTreeSet::new();
                for criterion in criteria {
                    id(criterion)?;
                    if !seen.insert(criterion) { return Err(ManagedError::Invalid("duplicate criterion")); }
                }
                self.specs.insert(spec_id.clone(), SpecVersion { digest: spec_digest.clone(), criteria: criteria.clone(), accepted: false });
            }
            ManagedCommand::AcceptSpec { spec_id } => {
                let spec = self.specs.get_mut(spec_id).ok_or(ManagedError::Conflict("spec not proposed"))?;
                if spec.accepted { return Err(ManagedError::Conflict("spec already accepted")); }
                spec.accepted = true; // All content/digest stays immutable.
            }
            ManagedCommand::StartRun { run_id, spec_id } => {
                id(run_id)?;
                let spec = self.specs.get(spec_id).ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec.accepted { return Err(ManagedError::Conflict("spec not accepted")); }
                if self.runs.contains_key(run_id) { return Err(ManagedError::Conflict("run ID already used")); }
                self.runs.insert(run_id.clone(), Run { spec_id: spec_id.clone(), phase: RunPhase::Running, tasks: BTreeMap::new() });
            }
            ManagedCommand::AddTask { run_id, task_id, dependencies } => {
                id(task_id)?;
                if dependencies.len() > 256 { return Err(ManagedError::Invalid("too many dependencies")); }
                let run = self.runs.get_mut(run_id).ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running { return Err(ManagedError::Conflict("run fenced")); }
                if run.tasks.contains_key(task_id) { return Err(ManagedError::Conflict("task ID already used")); }
                let mut seen = BTreeSet::new();
                for dependency in dependencies {
                    id(dependency)?;
                    if dependency == task_id || !run.tasks.contains_key(dependency) || !seen.insert(dependency) {
                        return Err(ManagedError::Conflict("task dependency invalid or duplicated"));
                    }
                }
                run.tasks.insert(task_id.clone(), Task { dependencies: dependencies.clone(), active_attempt: None, unknown_effect: false });
            }
            ManagedCommand::AdmitAttempt { run_id, task_id, attempt_id } => {
                id(attempt_id)?;
                if self.attempts.contains(attempt_id) { return Err(ManagedError::Conflict("attempt ID already used")); }
                let run = self.runs.get_mut(run_id).ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running { return Err(ManagedError::Conflict("run fenced")); }
                let task = run.tasks.get_mut(task_id).ok_or(ManagedError::Conflict("task missing"))?;
                // Without independent Task PASS, dependencies are never presumed satisfied.
                if !task.dependencies.is_empty() || task.active_attempt.is_some() || task.unknown_effect {
                    return Err(ManagedError::Conflict("task not ready for another attempt"));
                }
                task.active_attempt = Some(attempt_id.clone());
                self.attempts.insert(attempt_id.clone());
            }
            ManagedCommand::MarkAttemptUnknown { run_id, task_id, attempt_id } => {
                let run = self.runs.get_mut(run_id).ok_or(ManagedError::Conflict("run missing"))?;
                let task = run.tasks.get_mut(task_id).ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                    return Err(ManagedError::Conflict("attempt is not active"));
                }
                task.unknown_effect = true;
                if run.phase == RunPhase::Running { run.phase = RunPhase::Reconciling; }
            }
            ManagedCommand::RequestCancel { run_id } => {
                let run = self.runs.get_mut(run_id).ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase == RunPhase::Cancelling { return Err(ManagedError::Conflict("run already cancelling")); }
                run.phase = RunPhase::Cancelling; // Persist admission fence before signaling workers.
            }
        }
        self.revision = self.revision.checked_add(1).ok_or(ManagedError::Invalid("revision overflow"))?;
        Ok(())
    }
}

/// Acquires one durable owner lock per Goal. Another process cannot write the
/// same Goal concurrently; all commands also compare the caller's revision.
pub struct ManagedControl {
    log: OwnerLogV2,
    snapshot: ManagedSnapshot,
    cursor: Option<CursorV1>,
}

impl ManagedControl {
    pub fn open(root: &Path, goal_id: &str) -> Result<Self, ManagedError> {
        id(goal_id)?;
        let owner = OwnerIdentity::new("managed_goal".to_owned(), goal_id.to_owned())?;
        let log = OwnerLogV2::open(root, owner, DurabilityProfile::RunDurable)?;
        let mut snapshot = ManagedSnapshot::default();
        let mut cursor: Option<CursorV1> = None;
        loop {
            let batch = log.read_after(cursor.as_ref(), NonZeroUsize::new(128).unwrap())?;
            for event in &batch.events {
                let envelope = event.data.as_object().ok_or(ManagedError::Invalid("invalid managed envelope"))?;
                let version = envelope.get("schemaVersion").and_then(Value::as_u64);
                if version != Some(1) { return Err(ManagedError::Invalid("unknown managed schema version")); }
                let payload = envelope.get("payload").ok_or(ManagedError::Invalid("missing managed payload"))?;
                let delivery = envelope.get("deliveryId").and_then(Value::as_str).ok_or(ManagedError::Invalid("missing delivery"))?;
                let command_digest = envelope.get("commandDigest").and_then(Value::as_str).ok_or(ManagedError::Invalid("missing command digest"))?;
                if snapshot.deliveries.contains_key(delivery) { return Err(ManagedError::Invalid("duplicate physical delivery")); }
                snapshot.apply(&ManagedCommand::decode(&event.kind, payload)?)?;
                snapshot.deliveries.insert(delivery.to_owned(), command_digest.to_owned());
            }
            cursor = batch.cursor;
            if !batch.has_more { break; }
        }
        Ok(Self { log, snapshot, cursor })
    }

    pub fn snapshot(&self) -> &ManagedSnapshot { &self.snapshot }

    pub fn apply(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        command: ManagedCommand,
    ) -> Result<(), ManagedError> {
        id(delivery_id)?;
        let (kind, data) = command.event();
        let timestamp = SystemTime::now().duration_since(UNIX_EPOCH)
            .map_err(|_| ManagedError::Invalid("system time invalid"))?.as_millis() as u64;
        let mut event = OwnerEventInput {
            schema_version: 1, time_ms: timestamp, kind: kind.to_owned(),
            data, delivery_id: None, command_digest: None,
        };
        let command_digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()])?;
        // True retries must carry the same committed command bytes. Wall-clock
        // observation timestamps must therefore be pinned by the caller in a
        // future public API, rather than interpreted as idempotent here.
        if self.snapshot.deliveries.contains_key(delivery_id) {
            return Err(ManagedError::Conflict("delivery already committed; query status before retry"));
        }
        if self.snapshot.revision != expected_revision { return Err(ManagedError::Conflict("stale managed revision")); }
        let mut next = self.snapshot.clone();
        next.apply(&command)?;
        event.delivery_id = Some(delivery_id.to_owned());
        event.command_digest = Some(command_digest.clone());
        let receipt = self.log.append_batch(delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        next.deliveries.insert(delivery_id.to_owned(), command_digest);
        self.snapshot = next;
        self.cursor = Some(receipt.owner_cursor);
        Ok(())
    }
}
