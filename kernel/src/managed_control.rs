//! Durable, non-executing managed-work admission fence.
//!
//! This is the first P2 state owner, not a scheduler or an execution permission.
//! The private OwnerLogV2 stream owns immutable spec acceptance and Run admission.
//! No user-facing RPC exposes these commands until authenticated ingress, leases,
//! effect reconciliation and independent verification are implemented. In particular,
//! the accepted-by/proposed-by identity fields are owner-log facts populated by a future
//! trusted ingress; they are not themselves authentication proofs.

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
    Paused,
    Reconciling,
    Cancelling,
    /// Terminal. Reached only from CANCELLING once no admitted effect remains
    /// active or UNKNOWN; the future authenticated EffectService settles those.
    Cancelled,
    Verifying,
    Succeeded,
    NeedsYou,
    /// Terminal. Reached from VERIFYING, or from RECONCILING after a future
    /// authenticated EffectService has reconciled every UNKNOWN attempt.
    Failed,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GoalDraft {
    pub objective: String,
    pub project_ref: String,
    pub workspace_ref: String,
    pub created_by: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Goal {
    pub objective: String,
    pub project_ref: String,
    pub workspace_ref: String,
    pub created_by: String,
    pub active_spec_version_id: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AcceptanceCriterion {
    pub id: String,
    pub description: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecBudget {
    pub max_tasks: u16,
    pub max_attempts_per_task: u16,
    pub max_run_duration_ms: u64,
    pub max_memory_bytes: Option<u64>,
    pub max_disk_bytes: Option<u64>,
    pub max_workers: u16,
    pub max_tokens: Option<u64>,
    pub max_cost_micros: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecVersionDraft {
    pub parent_version_id: Option<String>,
    pub objective: String,
    pub project_ref: String,
    pub workspace_ref: String,
    pub scope: Vec<String>,
    pub constraints: Vec<String>,
    pub criteria: Vec<AcceptanceCriterion>,
    pub budget: SpecBudget,
    pub source_digests: Vec<String>,
    /// Supplied by trusted ingress from its authenticated principal. The current
    /// managed-control module has no authenticated public ingress and stays private.
    pub proposed_by: String,
}

impl SpecVersionDraft {
    pub fn digest(&self) -> String {
        let canonical = spec_draft_value(self).to_string();
        format!("blake3:{}", blake3::hash(canonical.as_bytes()).to_hex())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SpecVersion {
    pub digest: String,
    pub content: SpecVersionDraft,
    pub accepted: bool,
    pub accepted_by: Option<String>,
    pub accepted_at_ms: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SessionLink {
    pub session_id: String,
    pub source_store_id: String,
    pub source_instance_id: String,
    pub source_cursor: CursorV1,
    pub source_epoch: u64,
    pub latest_observed_message_id: Option<String>,
    pub latest_observed_part_id: Option<String>,
    pub source_digest: String,
    pub redaction_profile: String,
    pub owner_epoch: u64,
    pub protocol_version: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Task {
    pub dependencies: Vec<String>,
    pub criterion_ids: Vec<String>,
    pub ready: bool,
    pub active_attempt: Option<String>,
    pub unknown_effect: bool,
    pub verified_revision: Option<String>,
    pub attempt_count: u16,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Run {
    pub spec_id: String,
    pub phase: RunPhase,
    pub tasks: BTreeMap<String, Task>,
    pub session_link: Option<SessionLink>,
    pub final_revision: Option<String>,
    pub criterion_evidence: BTreeMap<String, CriterionEvidence>,
    /// Bounded failure code recorded when the Run reaches FAILED.
    pub failure_code: Option<String>,
}

/// Only an independent, trusted verifier adapter may submit this evidence.
/// No model-facing, plugin or public command path may submit these events.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CriterionEvidence {
    pub source_revision: String,
    pub evidence_digest: String,
    pub verifier_id: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttemptPhase {
    Admitted,
    Unknown,
    Failed,
    Verified,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttemptRecord {
    pub run_id: String,
    pub task_id: String,
    pub phase: AttemptPhase,
    pub failure_code: Option<String>,
    pub retryable: Option<bool>,
}

#[derive(Clone, Debug, Default)]
pub struct ManagedSnapshot {
    pub revision: u64,
    pub goal: Option<Goal>,
    pub specs: BTreeMap<String, SpecVersion>,
    pub runs: BTreeMap<String, Run>,
    pub attempts: BTreeMap<String, AttemptRecord>,
    deliveries: BTreeMap<String, String>,
}

/// Commands contain only control identifiers and digests, never conversation
/// transcripts or mutable provider messages.
#[derive(Clone, Debug)]
pub enum ManagedCommand {
    CreateGoal {
        goal: GoalDraft,
    },
    ProposeSpec {
        spec_id: String,
        spec: SpecVersionDraft,
        spec_digest: String,
    },
    AcceptSpec {
        spec_id: String,
        spec_digest: String,
        accepted_by: String,
        accepted_at_ms: u64,
    },
    StartRun {
        run_id: String,
        spec_id: String,
    },
    AddTask {
        run_id: String,
        task_id: String,
        dependencies: Vec<String>,
        criterion_ids: Vec<String>,
    },
    MarkTaskReady {
        run_id: String,
        task_id: String,
    },
    AdmitAttempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
    MarkAttemptUnknown {
        run_id: String,
        task_id: String,
        attempt_id: String,
    },
    FailAttempt {
        run_id: String,
        task_id: String,
        attempt_id: String,
        failure_code: String,
        retryable: bool,
    },
    VerifyTask {
        run_id: String,
        task_id: String,
        attempt_id: String,
        source_revision: String,
        evidence_digest: String,
    },
    BeginVerification {
        run_id: String,
        final_revision: String,
    },
    AttachSessionLink {
        run_id: String,
        link: SessionLink,
    },
    RecordCriterionEvidence {
        run_id: String,
        criterion_id: String,
        source_revision: String,
        evidence_digest: String,
        verifier_id: String,
    },
    FinalizeRun {
        run_id: String,
        final_revision: String,
    },
    NeedsYou {
        run_id: String,
    },
    PauseRun {
        run_id: String,
    },
    ResumeRun {
        run_id: String,
    },
    RequestCancel {
        run_id: String,
    },
    /// Records CANCELLED once a cancelling Run has no active or UNKNOWN
    /// attempts left. This command never settles an effect itself.
    CompleteCancel {
        run_id: String,
    },
    /// Terminally fails a settled Run. From RECONCILING this stays fenced until
    /// a future authenticated EffectService reconciles UNKNOWN attempts.
    FailRun {
        run_id: String,
        failure_code: String,
    },
}

fn goal_draft_value(goal: &GoalDraft) -> Value {
    json!({
        "objective": goal.objective,
        "projectRef": goal.project_ref,
        "workspaceRef": goal.workspace_ref,
        "createdBy": goal.created_by,
    })
}

fn spec_draft_value(spec: &SpecVersionDraft) -> Value {
    json!({
        "parentVersionId": spec.parent_version_id,
        "objective": spec.objective,
        "projectRef": spec.project_ref,
        "workspaceRef": spec.workspace_ref,
        "scope": spec.scope,
        "constraints": spec.constraints,
        "criteria": spec.criteria.iter().map(|criterion| json!({
            "id": criterion.id,
            "description": criterion.description,
        })).collect::<Vec<_>>(),
        "budget": {
            "maxTasks": spec.budget.max_tasks,
            "maxAttemptsPerTask": spec.budget.max_attempts_per_task,
            "maxRunDurationMs": spec.budget.max_run_duration_ms,
            "maxMemoryBytes": spec.budget.max_memory_bytes,
            "maxDiskBytes": spec.budget.max_disk_bytes,
            "maxWorkers": spec.budget.max_workers,
            "maxTokens": spec.budget.max_tokens,
            "maxCostMicros": spec.budget.max_cost_micros,
        },
        "sourceDigests": spec.source_digests,
        "proposedBy": spec.proposed_by,
    })
}

fn session_link_value(link: &SessionLink) -> Value {
    json!({
        "sessionId": link.session_id,
        "sourceStoreId": link.source_store_id,
        "sourceInstanceId": link.source_instance_id,
        "sourceCursor": {
            "ownerKind": link.source_cursor.owner_kind,
            "ownerId": link.source_cursor.owner_id,
            "seq": link.source_cursor.seq,
            "eventDigest": link.source_cursor.event_digest,
        },
        "sourceEpoch": link.source_epoch,
        "latestObservedMessageId": link.latest_observed_message_id,
        "latestObservedPartId": link.latest_observed_part_id,
        "sourceDigest": link.source_digest,
        "redactionProfile": link.redaction_profile,
        "ownerEpoch": link.owner_epoch,
        "protocolVersion": link.protocol_version,
    })
}

fn exact_object(
    value: &Value,
    expected_fields: usize,
) -> Result<&serde_json::Map<String, Value>, ManagedError> {
    let object = value.as_object().ok_or(ManagedError::Invalid(
        "managed event payload must be object",
    ))?;
    if object.len() != expected_fields {
        return Err(ManagedError::Invalid("managed event fields mismatch"));
    }
    Ok(object)
}

fn required_string(value: &Value, name: &str) -> Result<String, ManagedError> {
    value
        .get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or(ManagedError::Invalid(
            "managed event field missing or wrong type",
        ))
}

fn optional_string(value: &Value, name: &str) -> Result<Option<String>, ManagedError> {
    match value.get(name) {
        Some(Value::Null) => Ok(None),
        Some(Value::String(value)) => Ok(Some(value.clone())),
        _ => Err(ManagedError::Invalid("managed optional string is invalid")),
    }
}

fn required_u64(value: &Value, name: &str) -> Result<u64, ManagedError> {
    value
        .get(name)
        .and_then(Value::as_u64)
        .ok_or(ManagedError::Invalid(
            "managed event integer missing or invalid",
        ))
}

fn optional_u64(value: &Value, name: &str) -> Result<Option<u64>, ManagedError> {
    match value.get(name) {
        Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(Some)
            .ok_or(ManagedError::Invalid("managed optional integer is invalid")),
        None => Err(ManagedError::Invalid("managed optional integer is missing")),
    }
}

fn string_list(value: &Value, name: &str) -> Result<Vec<String>, ManagedError> {
    value
        .get(name)
        .and_then(Value::as_array)
        .ok_or(ManagedError::Invalid("managed event array missing"))?
        .iter()
        .map(|item| {
            item.as_str()
                .map(str::to_owned)
                .ok_or(ManagedError::Invalid("managed event array item invalid"))
        })
        .collect()
}

fn decode_goal_draft(value: &Value) -> Result<GoalDraft, ManagedError> {
    exact_object(value, 4)?;
    Ok(GoalDraft {
        objective: required_string(value, "objective")?,
        project_ref: required_string(value, "projectRef")?,
        workspace_ref: required_string(value, "workspaceRef")?,
        created_by: required_string(value, "createdBy")?,
    })
}

fn decode_spec_draft(value: &Value) -> Result<SpecVersionDraft, ManagedError> {
    exact_object(value, 10)?;
    let criteria_value = value
        .get("criteria")
        .and_then(Value::as_array)
        .ok_or(ManagedError::Invalid("managed criteria array missing"))?;
    let criteria = criteria_value
        .iter()
        .map(|value| {
            exact_object(value, 2)?;
            Ok(AcceptanceCriterion {
                id: required_string(value, "id")?,
                description: required_string(value, "description")?,
            })
        })
        .collect::<Result<Vec<_>, ManagedError>>()?;
    let budget_value = value
        .get("budget")
        .ok_or(ManagedError::Invalid("managed budget missing"))?;
    exact_object(budget_value, 8)?;
    let max_tasks = u16::try_from(required_u64(budget_value, "maxTasks")?)
        .map_err(|_| ManagedError::Invalid("managed task budget overflow"))?;
    let max_attempts_per_task = u16::try_from(required_u64(budget_value, "maxAttemptsPerTask")?)
        .map_err(|_| ManagedError::Invalid("managed attempt budget overflow"))?;
    let max_workers = u16::try_from(required_u64(budget_value, "maxWorkers")?)
        .map_err(|_| ManagedError::Invalid("managed worker budget overflow"))?;
    Ok(SpecVersionDraft {
        parent_version_id: optional_string(value, "parentVersionId")?,
        objective: required_string(value, "objective")?,
        project_ref: required_string(value, "projectRef")?,
        workspace_ref: required_string(value, "workspaceRef")?,
        scope: string_list(value, "scope")?,
        constraints: string_list(value, "constraints")?,
        criteria,
        budget: SpecBudget {
            max_tasks,
            max_attempts_per_task,
            max_run_duration_ms: required_u64(budget_value, "maxRunDurationMs")?,
            max_memory_bytes: optional_u64(budget_value, "maxMemoryBytes")?,
            max_disk_bytes: optional_u64(budget_value, "maxDiskBytes")?,
            max_workers,
            max_tokens: optional_u64(budget_value, "maxTokens")?,
            max_cost_micros: optional_u64(budget_value, "maxCostMicros")?,
        },
        source_digests: string_list(value, "sourceDigests")?,
        proposed_by: required_string(value, "proposedBy")?,
    })
}

fn decode_session_link(value: &Value) -> Result<SessionLink, ManagedError> {
    exact_object(value, 11)?;
    let cursor = value
        .get("sourceCursor")
        .ok_or(ManagedError::Invalid("SessionLink cursor missing"))?;
    exact_object(cursor, 4)?;
    let protocol_version = u16::try_from(required_u64(value, "protocolVersion")?)
        .map_err(|_| ManagedError::Invalid("SessionLink protocol version overflow"))?;
    Ok(SessionLink {
        session_id: required_string(value, "sessionId")?,
        source_store_id: required_string(value, "sourceStoreId")?,
        source_instance_id: required_string(value, "sourceInstanceId")?,
        source_cursor: CursorV1 {
            owner_kind: required_string(cursor, "ownerKind")?,
            owner_id: required_string(cursor, "ownerId")?,
            seq: required_string(cursor, "seq")?,
            event_digest: required_string(cursor, "eventDigest")?,
        },
        source_epoch: required_u64(value, "sourceEpoch")?,
        latest_observed_message_id: optional_string(value, "latestObservedMessageId")?,
        latest_observed_part_id: optional_string(value, "latestObservedPartId")?,
        source_digest: required_string(value, "sourceDigest")?,
        redaction_profile: required_string(value, "redactionProfile")?,
        owner_epoch: required_u64(value, "ownerEpoch")?,
        protocol_version,
    })
}

impl ManagedCommand {
    fn event(&self) -> (&'static str, Value) {
        match self {
            Self::CreateGoal { goal } => ("goal_created", json!({"goal": goal_draft_value(goal)})),
            Self::ProposeSpec {
                spec_id,
                spec,
                spec_digest,
            } => (
                "spec_proposed",
                json!({"specId": spec_id, "spec": spec_draft_value(spec), "specDigest": spec_digest}),
            ),
            Self::AcceptSpec {
                spec_id,
                spec_digest,
                accepted_by,
                accepted_at_ms,
            } => (
                "spec_accepted",
                json!({"specId": spec_id, "specDigest": spec_digest, "acceptedBy": accepted_by, "acceptedAtMs": accepted_at_ms}),
            ),
            Self::StartRun { run_id, spec_id } => {
                ("run_started", json!({"runId": run_id, "specId": spec_id}))
            }
            Self::AddTask {
                run_id,
                task_id,
                dependencies,
                criterion_ids,
            } => (
                "task_proposed",
                json!({"runId": run_id, "taskId": task_id, "dependencies": dependencies, "criterionIds": criterion_ids}),
            ),
            Self::MarkTaskReady { run_id, task_id } => {
                ("task_ready", json!({"runId": run_id, "taskId": task_id}))
            }
            Self::AdmitAttempt {
                run_id,
                task_id,
                attempt_id,
            } => (
                "attempt_admitted",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id}),
            ),
            Self::MarkAttemptUnknown {
                run_id,
                task_id,
                attempt_id,
            } => (
                "attempt_unknown",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id}),
            ),
            Self::FailAttempt {
                run_id,
                task_id,
                attempt_id,
                failure_code,
                retryable,
            } => (
                "attempt_failed",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "failureCode": failure_code, "retryable": retryable}),
            ),
            Self::VerifyTask {
                run_id,
                task_id,
                attempt_id,
                source_revision,
                evidence_digest,
            } => (
                "task_passed",
                json!({"runId": run_id, "taskId": task_id, "attemptId": attempt_id, "sourceRevision": source_revision, "evidenceDigest": evidence_digest}),
            ),
            Self::BeginVerification {
                run_id,
                final_revision,
            } => (
                "run_verifying",
                json!({"runId": run_id, "finalRevision": final_revision}),
            ),
            Self::AttachSessionLink { run_id, link } => (
                "session_link_attached",
                json!({"runId": run_id, "sessionLink": session_link_value(link)}),
            ),
            Self::RecordCriterionEvidence {
                run_id,
                criterion_id,
                source_revision,
                evidence_digest,
                verifier_id,
            } => (
                "evidence_accepted",
                json!({"runId": run_id, "criterionId": criterion_id, "sourceRevision": source_revision, "evidenceDigest": evidence_digest, "verifierId": verifier_id}),
            ),
            Self::FinalizeRun {
                run_id,
                final_revision,
            } => (
                "run_succeeded",
                json!({"runId": run_id, "finalRevision": final_revision}),
            ),
            Self::NeedsYou { run_id } => ("run_needs_you", json!({"runId": run_id})),
            Self::PauseRun { run_id } => ("run_paused", json!({"runId": run_id})),
            Self::ResumeRun { run_id } => ("run_resumed", json!({"runId": run_id})),
            Self::RequestCancel { run_id } => ("run_cancelling", json!({"runId": run_id})),
            Self::CompleteCancel { run_id } => ("run_cancelled", json!({"runId": run_id})),
            Self::FailRun {
                run_id,
                failure_code,
            } => (
                "run_failed",
                json!({"runId": run_id, "failureCode": failure_code}),
            ),
        }
    }

    fn decode(kind: &str, payload: &Value) -> Result<Self, ManagedError> {
        fn field(payload: &Value, name: &str) -> Result<String, ManagedError> {
            payload
                .get(name)
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or(ManagedError::Invalid(
                    "managed event field missing or wrong type",
                ))
        }
        fn list(payload: &Value, name: &str) -> Result<Vec<String>, ManagedError> {
            payload
                .get(name)
                .and_then(Value::as_array)
                .ok_or(ManagedError::Invalid("managed event array missing"))?
                .iter()
                .map(|item| {
                    item.as_str()
                        .map(str::to_owned)
                        .ok_or(ManagedError::Invalid("managed event array item invalid"))
                })
                .collect()
        }
        let count = payload
            .as_object()
            .ok_or(ManagedError::Invalid(
                "managed event payload must be object",
            ))?
            .len();
        let command = match kind {
            "goal_created" if count == 1 => Self::CreateGoal {
                goal: decode_goal_draft(
                    payload
                        .get("goal")
                        .ok_or(ManagedError::Invalid("managed Goal payload missing"))?,
                )?,
            },
            "spec_proposed" if count == 3 => Self::ProposeSpec {
                spec_id: field(payload, "specId")?,
                spec: decode_spec_draft(
                    payload
                        .get("spec")
                        .ok_or(ManagedError::Invalid("managed SpecVersion payload missing"))?,
                )?,
                spec_digest: field(payload, "specDigest")?,
            },
            "spec_accepted" if count == 4 => Self::AcceptSpec {
                spec_id: field(payload, "specId")?,
                spec_digest: field(payload, "specDigest")?,
                accepted_by: field(payload, "acceptedBy")?,
                accepted_at_ms: payload
                    .get("acceptedAtMs")
                    .and_then(Value::as_u64)
                    .ok_or(ManagedError::Invalid("acceptance time is invalid"))?,
            },
            "run_started" if count == 2 => Self::StartRun {
                run_id: field(payload, "runId")?,
                spec_id: field(payload, "specId")?,
            },
            "task_proposed" if count == 4 => Self::AddTask {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                dependencies: list(payload, "dependencies")?,
                criterion_ids: list(payload, "criterionIds")?,
            },
            "task_ready" if count == 2 => Self::MarkTaskReady {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
            },
            "attempt_admitted" if count == 3 => Self::AdmitAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
            },
            "attempt_unknown" if count == 3 => Self::MarkAttemptUnknown {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
            },
            "attempt_failed" if count == 5 => Self::FailAttempt {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                failure_code: field(payload, "failureCode")?,
                retryable: payload
                    .get("retryable")
                    .and_then(Value::as_bool)
                    .ok_or(ManagedError::Invalid("attempt retry class is invalid"))?,
            },
            "task_passed" if count == 5 => Self::VerifyTask {
                run_id: field(payload, "runId")?,
                task_id: field(payload, "taskId")?,
                attempt_id: field(payload, "attemptId")?,
                source_revision: field(payload, "sourceRevision")?,
                evidence_digest: field(payload, "evidenceDigest")?,
            },
            "run_verifying" if count == 2 => Self::BeginVerification {
                run_id: field(payload, "runId")?,
                final_revision: field(payload, "finalRevision")?,
            },
            "session_link_attached" if count == 2 => Self::AttachSessionLink {
                run_id: field(payload, "runId")?,
                link: decode_session_link(
                    payload
                        .get("sessionLink")
                        .ok_or(ManagedError::Invalid("SessionLink payload missing"))?,
                )?,
            },
            "evidence_accepted" if count == 5 => Self::RecordCriterionEvidence {
                run_id: field(payload, "runId")?,
                criterion_id: field(payload, "criterionId")?,
                source_revision: field(payload, "sourceRevision")?,
                evidence_digest: field(payload, "evidenceDigest")?,
                verifier_id: field(payload, "verifierId")?,
            },
            "run_succeeded" if count == 2 => Self::FinalizeRun {
                run_id: field(payload, "runId")?,
                final_revision: field(payload, "finalRevision")?,
            },
            "run_needs_you" if count == 1 => Self::NeedsYou {
                run_id: field(payload, "runId")?,
            },
            "run_paused" if count == 1 => Self::PauseRun {
                run_id: field(payload, "runId")?,
            },
            "run_resumed" if count == 1 => Self::ResumeRun {
                run_id: field(payload, "runId")?,
            },
            "run_cancelling" if count == 1 => Self::RequestCancel {
                run_id: field(payload, "runId")?,
            },
            "run_cancelled" if count == 1 => Self::CompleteCancel {
                run_id: field(payload, "runId")?,
            },
            "run_failed" if count == 2 => Self::FailRun {
                run_id: field(payload, "runId")?,
                failure_code: field(payload, "failureCode")?,
            },
            _ => {
                return Err(ManagedError::Invalid(
                    "unknown managed event kind or fields",
                ));
            }
        };
        Ok(command)
    }
}

fn id(value: &str) -> Result<(), ManagedError> {
    if value.is_empty()
        || value.len() > 256
        || !value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    {
        return Err(ManagedError::Invalid("invalid managed identifier"));
    }
    Ok(())
}

fn principal(value: &str) -> Result<(), ManagedError> {
    if value.is_empty() || value.len() > 256 || !value.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err(ManagedError::Invalid("invalid managed principal"));
    }
    Ok(())
}

fn nonempty_text(value: &str, max_bytes: usize, field: &'static str) -> Result<(), ManagedError> {
    if value.trim().is_empty() || value.len() > max_bytes {
        return Err(ManagedError::Invalid(field));
    }
    Ok(())
}

fn logical_command_digest(kind: &str, data: &Value) -> String {
    // Idempotency identifies the logical operation, independent of the
    // timestamp in OwnerLog's separately authenticated physical envelope.
    let command = json!({"kind": kind, "data": data});
    format!(
        "blake3:{}",
        blake3::hash(command.to_string().as_bytes()).to_hex()
    )
}

fn digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71
        || !value.starts_with("sha256:")
        || !value.as_bytes()[7..].iter().all(u8::is_ascii_hexdigit)
    {
        return Err(ManagedError::Invalid("invalid managed digest"));
    }
    Ok(())
}

fn blake3_digest(value: &str) -> Result<(), ManagedError> {
    if value.len() != 71
        || !value.starts_with("blake3:")
        || !value.as_bytes()[7..]
            .iter()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(ManagedError::Invalid("invalid managed BLAKE3 digest"));
    }
    Ok(())
}

fn validate_goal(goal: &GoalDraft) -> Result<(), ManagedError> {
    nonempty_text(&goal.objective, 16 * 1024, "invalid Goal objective")?;
    id(&goal.project_ref)?;
    id(&goal.workspace_ref)?;
    principal(&goal.created_by)
}

fn validate_spec(spec: &SpecVersionDraft) -> Result<(), ManagedError> {
    nonempty_text(&spec.objective, 16 * 1024, "invalid SpecVersion objective")?;
    id(&spec.project_ref)?;
    id(&spec.workspace_ref)?;
    if let Some(parent) = &spec.parent_version_id {
        id(parent)?;
    }
    principal(&spec.proposed_by)?;
    if spec.scope.is_empty() || spec.scope.len() > 128 || spec.constraints.len() > 128 {
        return Err(ManagedError::Invalid(
            "invalid SpecVersion scope or constraints",
        ));
    }
    for item in spec.scope.iter().chain(&spec.constraints) {
        nonempty_text(item, 4096, "invalid SpecVersion scope item")?;
    }
    if spec.criteria.is_empty() || spec.criteria.len() > 256 {
        return Err(ManagedError::Invalid("invalid acceptance criteria count"));
    }
    let mut criterion_ids = BTreeSet::new();
    for criterion in &spec.criteria {
        id(&criterion.id)?;
        nonempty_text(
            &criterion.description,
            4096,
            "invalid criterion description",
        )?;
        if !criterion_ids.insert(&criterion.id) {
            return Err(ManagedError::Invalid("duplicate criterion"));
        }
    }
    if spec.source_digests.len() > 256 {
        return Err(ManagedError::Invalid("too many SpecVersion source digests"));
    }
    let mut source_digests = BTreeSet::new();
    for source_digest in &spec.source_digests {
        digest(source_digest)?;
        if !source_digests.insert(source_digest) {
            return Err(ManagedError::Invalid("duplicate SpecVersion source digest"));
        }
    }
    let budget = &spec.budget;
    if budget.max_tasks == 0
        || budget.max_tasks > 256
        || budget.max_attempts_per_task == 0
        || budget.max_attempts_per_task > 100
        || budget.max_run_duration_ms == 0
        || budget.max_run_duration_ms > 9_007_199_254_740_991
        || budget.max_workers == 0
        || budget.max_workers > 20
        || budget.max_memory_bytes == Some(0)
        || budget.max_disk_bytes == Some(0)
        || budget.max_tokens == Some(0)
    {
        return Err(ManagedError::Invalid("invalid SpecVersion budget"));
    }
    Ok(())
}

fn validate_session_link(link: &SessionLink) -> Result<(), ManagedError> {
    id(&link.session_id)?;
    id(&link.source_store_id)?;
    id(&link.source_instance_id)?;
    id(&link.source_cursor.owner_kind)?;
    id(&link.source_cursor.owner_id)?;
    if link.source_cursor.owner_kind != "session" || link.source_cursor.owner_id != link.session_id
    {
        return Err(ManagedError::Invalid("SessionLink cursor owner mismatch"));
    }
    if link.source_cursor.seq.is_empty()
        || (link.source_cursor.seq.len() > 1 && link.source_cursor.seq.starts_with('0'))
        || link.source_cursor.seq.parse::<u64>().is_err()
    {
        return Err(ManagedError::Invalid("SessionLink cursor sequence invalid"));
    }
    blake3_digest(&link.source_cursor.event_digest)?;
    if link.source_epoch == 0 || link.owner_epoch == 0 || link.protocol_version == 0 {
        return Err(ManagedError::Invalid(
            "SessionLink epoch or protocol version invalid",
        ));
    }
    if let Some(message_id) = &link.latest_observed_message_id {
        id(message_id)?;
    }
    if let Some(part_id) = &link.latest_observed_part_id {
        id(part_id)?;
    }
    digest(&link.source_digest)?;
    id(&link.redaction_profile)
}

impl ManagedSnapshot {
    fn apply(&mut self, command: &ManagedCommand) -> Result<(), ManagedError> {
        match command {
            ManagedCommand::CreateGoal { goal } => {
                validate_goal(goal)?;
                if self.goal.is_some() {
                    return Err(ManagedError::Conflict("goal already exists"));
                }
                self.goal = Some(Goal {
                    objective: goal.objective.clone(),
                    project_ref: goal.project_ref.clone(),
                    workspace_ref: goal.workspace_ref.clone(),
                    created_by: goal.created_by.clone(),
                    active_spec_version_id: None,
                });
            }
            ManagedCommand::ProposeSpec {
                spec_id,
                spec,
                spec_digest,
            } => {
                id(spec_id)?;
                validate_spec(spec)?;
                blake3_digest(spec_digest)?;
                if spec_digest != &spec.digest() {
                    return Err(ManagedError::Invalid("SpecVersion digest mismatch"));
                }
                let goal = self
                    .goal
                    .as_ref()
                    .ok_or(ManagedError::Conflict("goal not created"))?;
                if spec.project_ref != goal.project_ref || spec.workspace_ref != goal.workspace_ref
                {
                    return Err(ManagedError::Conflict(
                        "SpecVersion project/workspace mismatch",
                    ));
                }
                if spec_draft_value(spec).to_string().len() > 512 * 1024 {
                    return Err(ManagedError::Invalid(
                        "SpecVersion exceeds durable payload limit",
                    ));
                }
                if let Some(parent_id) = &spec.parent_version_id {
                    let parent = self
                        .specs
                        .get(parent_id)
                        .ok_or(ManagedError::Conflict("parent SpecVersion missing"))?;
                    if !parent.accepted
                        || parent.content.project_ref != spec.project_ref
                        || parent.content.workspace_ref != spec.workspace_ref
                    {
                        return Err(ManagedError::Conflict("parent SpecVersion is not accepted"));
                    }
                }
                if self.goal.is_none() {
                    return Err(ManagedError::Conflict("goal not created"));
                }
                if self.specs.contains_key(spec_id) {
                    return Err(ManagedError::Conflict("spec ID already used"));
                }
                self.specs.insert(
                    spec_id.clone(),
                    SpecVersion {
                        digest: spec_digest.clone(),
                        content: spec.clone(),
                        accepted: false,
                        accepted_by: None,
                        accepted_at_ms: None,
                    },
                );
            }
            ManagedCommand::AcceptSpec {
                spec_id,
                spec_digest,
                accepted_by,
                accepted_at_ms,
            } => {
                id(spec_id)?;
                blake3_digest(spec_digest)?;
                principal(accepted_by)?;
                if *accepted_at_ms == 0 || *accepted_at_ms > 9_007_199_254_740_991 {
                    return Err(ManagedError::Invalid("SpecVersion acceptance time invalid"));
                }
                let proposed = self
                    .specs
                    .get(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                if proposed.digest.as_str() != spec_digest.as_str()
                    || proposed.content.digest().as_str() != spec_digest.as_str()
                {
                    return Err(ManagedError::Conflict(
                        "accepted SpecVersion digest is stale",
                    ));
                }
                if proposed.content.proposed_by.as_str() == accepted_by.as_str() {
                    return Err(ManagedError::Conflict(
                        "SpecVersion author cannot approve it",
                    ));
                }
                if proposed.accepted {
                    return Err(ManagedError::Conflict("spec already accepted"));
                }
                let spec = self
                    .specs
                    .get_mut(spec_id)
                    .ok_or(ManagedError::Conflict("spec not proposed"))?;
                spec.accepted = true;
                spec.accepted_by = Some(accepted_by.clone());
                spec.accepted_at_ms = Some(*accepted_at_ms);
                self.goal
                    .as_mut()
                    .ok_or(ManagedError::Conflict("goal missing"))?
                    .active_spec_version_id = Some(spec_id.clone());
            }
            ManagedCommand::StartRun { run_id, spec_id } => {
                id(run_id)?;
                let goal = self
                    .goal
                    .as_ref()
                    .ok_or(ManagedError::Conflict("goal missing"))?;
                if goal.active_spec_version_id.as_deref() != Some(spec_id.as_str()) {
                    return Err(ManagedError::Conflict(
                        "Run must use the accepted active SpecVersion",
                    ));
                }
                let spec = self
                    .specs
                    .get(spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec.accepted {
                    return Err(ManagedError::Conflict("spec not accepted"));
                }
                if self.runs.contains_key(run_id) {
                    return Err(ManagedError::Conflict("run ID already used"));
                }
                self.runs.insert(
                    run_id.clone(),
                    Run {
                        spec_id: spec_id.clone(),
                        phase: RunPhase::Running,
                        tasks: BTreeMap::new(),
                        session_link: None,
                        final_revision: None,
                        criterion_evidence: BTreeMap::new(),
                        failure_code: None,
                    },
                );
            }
            ManagedCommand::AttachSessionLink { run_id, link } => {
                validate_session_link(link)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running || run.session_link.is_some() {
                    return Err(ManagedError::Conflict(
                        "Run cannot attach or rebind SessionLink",
                    ));
                }
                run.session_link = Some(link.clone());
            }
            ManagedCommand::AddTask {
                run_id,
                task_id,
                dependencies,
                criterion_ids,
            } => {
                id(task_id)?;
                if dependencies.len() > 256 {
                    return Err(ManagedError::Invalid("too many dependencies"));
                }
                if criterion_ids.len() > 256 {
                    return Err(ManagedError::Invalid("too many Task criteria"));
                }
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let spec = self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if criterion_ids.iter().any(|criterion_id| {
                    !spec.content.criteria.iter().any(|c| c.id == *criterion_id)
                }) {
                    return Err(ManagedError::Conflict(
                        "Task criterion is outside accepted SpecVersion",
                    ));
                }
                let mut seen_criteria = BTreeSet::new();
                for criterion_id in criterion_ids {
                    id(criterion_id)?;
                    if !seen_criteria.insert(criterion_id) {
                        return Err(ManagedError::Invalid("duplicate Task criterion"));
                    }
                }
                let max_tasks = usize::from(spec.content.budget.max_tasks);
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                if run.tasks.contains_key(task_id) {
                    return Err(ManagedError::Conflict("task ID already used"));
                }
                if run.tasks.len() >= max_tasks {
                    return Err(ManagedError::Conflict(
                        "accepted SpecVersion task budget exhausted",
                    ));
                }
                let mut seen = BTreeSet::new();
                for dependency in dependencies {
                    id(dependency)?;
                    if dependency == task_id
                        || !run.tasks.contains_key(dependency)
                        || !seen.insert(dependency)
                    {
                        return Err(ManagedError::Conflict(
                            "task dependency invalid or duplicated",
                        ));
                    }
                }
                run.tasks.insert(
                    task_id.clone(),
                    Task {
                        dependencies: dependencies.clone(),
                        criterion_ids: criterion_ids.clone(),
                        ready: false,
                        active_attempt: None,
                        unknown_effect: false,
                        verified_revision: None,
                        attempt_count: 0,
                    },
                );
            }
            ManagedCommand::MarkTaskReady { run_id, task_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                let dependencies = run
                    .tasks
                    .get(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?
                    .dependencies
                    .clone();
                let prerequisites_passed = dependencies.iter().all(|dependency| {
                    run.tasks
                        .get(dependency)
                        .is_some_and(|prior| prior.verified_revision.is_some())
                });
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.ready
                    || !prerequisites_passed
                    || task.unknown_effect
                    || task.active_attempt.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "task dependencies not independently verified",
                    ));
                }
                task.ready = true;
            }
            ManagedCommand::AdmitAttempt {
                run_id,
                task_id,
                attempt_id,
            } => {
                id(attempt_id)?;
                if self.attempts.contains_key(attempt_id) {
                    return Err(ManagedError::Conflict("attempt ID already used"));
                }
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let budget = &self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?
                    .content
                    .budget;
                let max_attempts = budget.max_attempts_per_task;
                let max_workers = budget.max_workers;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                // The accepted SpecVersion worker budget caps concurrently active
                // Attempts. An UNKNOWN Attempt keeps its worker slot until a future
                // authenticated EffectService reconciles it, so it still counts.
                let active_attempts = run
                    .tasks
                    .values()
                    .filter(|task| task.active_attempt.is_some())
                    .count();
                if active_attempts >= usize::from(max_workers) {
                    return Err(ManagedError::Conflict(
                        "accepted SpecVersion worker budget exhausted",
                    ));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                // Without independent Task PASS, dependencies are never presumed satisfied.
                if !task.ready
                    || task.verified_revision.is_some()
                    || task.active_attempt.is_some()
                    || task.unknown_effect
                    || task.attempt_count >= max_attempts
                {
                    return Err(ManagedError::Conflict("task not ready for another attempt"));
                }
                task.active_attempt = Some(attempt_id.clone());
                task.attempt_count = task
                    .attempt_count
                    .checked_add(1)
                    .ok_or(ManagedError::Invalid("Task attempt count overflow"))?;
                self.attempts.insert(
                    attempt_id.clone(),
                    AttemptRecord {
                        run_id: run_id.clone(),
                        task_id: task_id.clone(),
                        phase: AttemptPhase::Admitted,
                        failure_code: None,
                        retryable: None,
                    },
                );
            }
            ManagedCommand::FailAttempt {
                run_id,
                task_id,
                attempt_id,
                failure_code,
                retryable,
            } => {
                id(failure_code)?;
                let spec_id = self
                    .runs
                    .get(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?
                    .spec_id
                    .clone();
                let max_attempts = self
                    .specs
                    .get(&spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?
                    .content
                    .budget
                    .max_attempts_per_task;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(run.phase, RunPhase::Running | RunPhase::Paused) {
                    return Err(ManagedError::Conflict(
                        "Run does not accept Attempt settlement",
                    ));
                }
                let exhausted = {
                    let task = run
                        .tasks
                        .get_mut(task_id)
                        .ok_or(ManagedError::Conflict("task missing"))?;
                    if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                        return Err(ManagedError::Conflict("attempt is not safely settleable"));
                    }
                    let attempt = self
                        .attempts
                        .get_mut(attempt_id)
                        .ok_or(ManagedError::Conflict("attempt record missing"))?;
                    if attempt.run_id != *run_id
                        || attempt.task_id != *task_id
                        || attempt.phase != AttemptPhase::Admitted
                    {
                        return Err(ManagedError::Conflict("attempt ownership or state changed"));
                    }
                    attempt.phase = AttemptPhase::Failed;
                    attempt.failure_code = Some(failure_code.clone());
                    attempt.retryable = Some(*retryable);
                    task.active_attempt = None;
                    let exhausted = !retryable || task.attempt_count >= max_attempts;
                    if exhausted {
                        task.ready = false;
                    }
                    exhausted
                };
                if exhausted {
                    run.phase = RunPhase::NeedsYou;
                }
            }
            ManagedCommand::MarkAttemptUnknown {
                run_id,
                task_id,
                attempt_id,
            } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id) || task.unknown_effect {
                    return Err(ManagedError::Conflict("attempt is not active"));
                }
                task.unknown_effect = true;
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Admitted
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                attempt.phase = AttemptPhase::Unknown;
                if matches!(run.phase, RunPhase::Running | RunPhase::Paused) {
                    run.phase = RunPhase::Reconciling;
                }
                // Keep CANCELLING as the durable user-intent fence. The active
                // Attempt remains UNKNOWN until a future authenticated EffectService
                // can reconcile process/target evidence; this state owner cannot settle it.
            }

            ManagedCommand::VerifyTask {
                run_id,
                task_id,
                attempt_id,
                source_revision,
                evidence_digest,
            } => {
                digest(source_revision)?;
                digest(evidence_digest)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("run fenced"));
                }
                let task = run
                    .tasks
                    .get_mut(task_id)
                    .ok_or(ManagedError::Conflict("task missing"))?;
                if task.active_attempt.as_deref() != Some(attempt_id)
                    || task.unknown_effect
                    || task.verified_revision.is_some()
                {
                    return Err(ManagedError::Conflict(
                        "task has no verifiable active attempt",
                    ));
                }
                let attempt = self
                    .attempts
                    .get_mut(attempt_id)
                    .ok_or(ManagedError::Conflict("attempt record missing"))?;
                if attempt.run_id != *run_id
                    || attempt.task_id != *task_id
                    || attempt.phase != AttemptPhase::Admitted
                {
                    return Err(ManagedError::Conflict("attempt ownership or state changed"));
                }
                attempt.phase = AttemptPhase::Verified;
                task.verified_revision = Some(source_revision.clone());
                task.active_attempt = None;
            }
            ManagedCommand::BeginVerification {
                run_id,
                final_revision,
            } => {
                digest(final_revision)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                let revision_changed = run.phase == RunPhase::Verifying
                    && run.final_revision.as_deref() != Some(final_revision);
                if !(run.phase == RunPhase::Running || revision_changed)
                    || run.tasks.is_empty()
                    || run.tasks.values().any(|task| {
                        task.unknown_effect
                            || task.active_attempt.is_some()
                            || task.verified_revision.is_none()
                    })
                {
                    return Err(ManagedError::Conflict(
                        "run has unresolved or unverified Tasks",
                    ));
                }
                run.phase = RunPhase::Verifying;
                run.final_revision = Some(final_revision.clone());
                run.criterion_evidence.clear(); // Evidence must be fresh on this revision.
            }
            ManagedCommand::RecordCriterionEvidence {
                run_id,
                criterion_id,
                source_revision,
                evidence_digest,
                verifier_id,
            } => {
                digest(source_revision)?;
                digest(evidence_digest)?;
                id(verifier_id)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Verifying
                    || run.final_revision.as_deref() != Some(source_revision)
                {
                    return Err(ManagedError::Conflict(
                        "stale or out-of-phase criterion evidence",
                    ));
                }
                let spec = self
                    .specs
                    .get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if !spec
                    .content
                    .criteria
                    .iter()
                    .any(|criterion| criterion.id == *criterion_id)
                    || run.criterion_evidence.contains_key(criterion_id)
                {
                    return Err(ManagedError::Conflict(
                        "unknown or duplicated acceptance criterion",
                    ));
                }
                run.criterion_evidence.insert(
                    criterion_id.clone(),
                    CriterionEvidence {
                        source_revision: source_revision.clone(),
                        evidence_digest: evidence_digest.clone(),
                        verifier_id: verifier_id.clone(),
                    },
                );
            }
            ManagedCommand::FinalizeRun {
                run_id,
                final_revision,
            } => {
                digest(final_revision)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Verifying
                    || run.final_revision.as_deref() != Some(final_revision)
                    || run
                        .tasks
                        .values()
                        .any(|task| task.unknown_effect || task.active_attempt.is_some())
                {
                    return Err(ManagedError::Conflict("run not ready to finalize"));
                }
                let spec = self
                    .specs
                    .get(&run.spec_id)
                    .ok_or(ManagedError::Conflict("spec missing"))?;
                if spec.content.criteria.iter().any(|criterion| {
                    run.criterion_evidence
                        .get(&criterion.id)
                        .is_none_or(|proof| proof.source_revision != *final_revision)
                }) {
                    return Err(ManagedError::Conflict(
                        "missing or stale final-revision evidence",
                    ));
                }
                run.phase = RunPhase::Succeeded;
            }
            ManagedCommand::NeedsYou { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if matches!(
                    run.phase,
                    RunPhase::Succeeded
                        | RunPhase::Cancelling
                        | RunPhase::Cancelled
                        | RunPhase::NeedsYou
                        | RunPhase::Failed
                ) || run.tasks.values().any(|task| task.active_attempt.is_some())
                {
                    return Err(ManagedError::Conflict("run cannot transition to NEEDS_YOU"));
                }
                run.phase = RunPhase::NeedsYou;
            }
            ManagedCommand::PauseRun { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Running {
                    return Err(ManagedError::Conflict("only running Runs can pause"));
                }
                run.phase = RunPhase::Paused; // Durable admission fence precedes stopping workers.
            }
            ManagedCommand::ResumeRun { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Paused
                    || run.tasks.values().any(|task| task.unknown_effect)
                {
                    return Err(ManagedError::Conflict("run not safely resumable"));
                }
                run.phase = RunPhase::Running;
            }
            ManagedCommand::RequestCancel { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if matches!(
                    run.phase,
                    RunPhase::Cancelling
                        | RunPhase::Cancelled
                        | RunPhase::Succeeded
                        | RunPhase::NeedsYou
                        | RunPhase::Failed
                ) {
                    return Err(ManagedError::Conflict(
                        "run cannot be cancelled from terminal/fenced phase",
                    ));
                }
                run.phase = RunPhase::Cancelling; // Persist admission fence before signaling workers.
            }
            ManagedCommand::CompleteCancel { run_id } => {
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if run.phase != RunPhase::Cancelling {
                    return Err(ManagedError::Conflict(
                        "only cancelling Runs can complete cancellation",
                    ));
                }
                // Settlement of admitted effects belongs to the future
                // authenticated EffectService. CANCELLED is recorded only when
                // nothing remains active or UNKNOWN; otherwise this fails closed.
                if run
                    .tasks
                    .values()
                    .any(|task| task.active_attempt.is_some() || task.unknown_effect)
                {
                    return Err(ManagedError::Conflict(
                        "cancellation still has unsettled attempts",
                    ));
                }
                run.phase = RunPhase::Cancelled;
            }
            ManagedCommand::FailRun {
                run_id,
                failure_code,
            } => {
                id(failure_code)?;
                let run = self
                    .runs
                    .get_mut(run_id)
                    .ok_or(ManagedError::Conflict("run missing"))?;
                if !matches!(run.phase, RunPhase::Verifying | RunPhase::Reconciling) {
                    return Err(ManagedError::Conflict("run cannot fail from this phase"));
                }
                // RECONCILING is only entered alongside an unsettled UNKNOWN
                // Attempt; until a future authenticated EffectService reconciles
                // it with target-side proof, failure stays fenced and this fails
                // closed rather than abandoning an unknown effect.
                if run
                    .tasks
                    .values()
                    .any(|task| task.active_attempt.is_some() || task.unknown_effect)
                {
                    return Err(ManagedError::Conflict("run still has unsettled attempts"));
                }
                run.failure_code = Some(failure_code.clone());
                run.phase = RunPhase::Failed;
            }
        }
        self.revision = self
            .revision
            .checked_add(1)
            .ok_or(ManagedError::Invalid("revision overflow"))?;
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
                let envelope = event
                    .data
                    .as_object()
                    .ok_or(ManagedError::Invalid("invalid managed envelope"))?;
                let version = envelope.get("schemaVersion").and_then(Value::as_u64);
                if version != Some(1) {
                    return Err(ManagedError::Invalid("unknown managed schema version"));
                }
                let payload = envelope
                    .get("payload")
                    .ok_or(ManagedError::Invalid("missing managed payload"))?;
                let delivery = envelope
                    .get("deliveryId")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid("missing delivery"))?;
                let command_digest = envelope
                    .get("commandDigest")
                    .and_then(Value::as_str)
                    .ok_or(ManagedError::Invalid("missing command digest"))?;
                if snapshot.deliveries.contains_key(delivery) {
                    return Err(ManagedError::Invalid("duplicate physical delivery"));
                }
                let command = ManagedCommand::decode(&event.kind, payload)?;
                snapshot.apply(&command)?;
                let logical = logical_command_digest(&event.kind, payload);
                // OwnerLog already authenticates the physical command digest;
                // this projection additionally records retry-equivalence.
                if !command_digest.starts_with("blake3:") {
                    return Err(ManagedError::Invalid("invalid physical command digest"));
                }
                snapshot.deliveries.insert(delivery.to_owned(), logical);
            }
            cursor = batch.cursor;
            if !batch.has_more {
                break;
            }
        }
        // After a host crash we cannot infer whether a previously admitted
        // Attempt launched external work or obtained an EffectReceipt. Do not
        // resume it automatically. Recovery must obtain target-side evidence
        // and explicitly settle UNKNOWN through the future EffectService.
        for run in snapshot.runs.values_mut() {
            let unsettled = run.tasks.values().any(|task| task.active_attempt.is_some());
            if unsettled {
                for task in run.tasks.values_mut() {
                    if let Some(attempt_id) = task.active_attempt.as_deref() {
                        task.unknown_effect = true;
                        if let Some(attempt) = snapshot.attempts.get_mut(attempt_id) {
                            attempt.phase = AttemptPhase::Unknown;
                        }
                    }
                }
                if run.phase == RunPhase::Running || run.phase == RunPhase::Paused {
                    run.phase = RunPhase::Reconciling;
                }
                // A persisted CANCELLING phase remains fenced across restart; an
                // unsettled Attempt is not evidence that cancellation completed.
            }
        }
        Ok(Self {
            log,
            snapshot,
            cursor,
        })
    }

    pub fn snapshot(&self) -> &ManagedSnapshot {
        &self.snapshot
    }

    pub fn apply(
        &mut self,
        expected_revision: u64,
        delivery_id: &str,
        command: ManagedCommand,
    ) -> Result<(), ManagedError> {
        id(delivery_id)?;
        let (kind, data) = command.event();
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| ManagedError::Invalid("system time invalid"))?
            .as_millis() as u64;
        let mut event = OwnerEventInput {
            schema_version: 1,
            time_ms: timestamp,
            kind: kind.to_owned(),
            data,
            delivery_id: None,
            command_digest: None,
        };
        let command_digest = OwnerLogV2::command_digest(delivery_id, &[event.clone()])?;
        // An exact retry is successful even after the aggregate revision
        // advanced. Reuse with a different command fails closed.
        let logical = logical_command_digest(kind, &event.data);
        if let Some(previous) = self.snapshot.deliveries.get(delivery_id) {
            return if previous == &logical {
                Ok(())
            } else {
                Err(ManagedError::Conflict(
                    "idempotency key reused for different command",
                ))
            };
        }
        if self.snapshot.revision != expected_revision {
            return Err(ManagedError::Conflict("stale managed revision"));
        }
        let mut next = self.snapshot.clone();
        next.apply(&command)?;
        event.delivery_id = Some(delivery_id.to_owned());
        event.command_digest = Some(command_digest.clone());
        let receipt =
            self.log
                .append_batch(delivery_id, &command_digest, &[event], self.cursor.as_ref())?;
        next.deliveries.insert(delivery_id.to_owned(), logical);
        self.snapshot = next;
        self.cursor = Some(receipt.owner_cursor);
        Ok(())
    }
}
