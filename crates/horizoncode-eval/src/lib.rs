//! Versioned, offline-first evaluation records.

#![recursion_limit = "256"]

use std::collections::{BTreeMap, BTreeSet};

use serde::de::{MapAccess, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize};
use thiserror::Error;

pub mod fixture;

/// Maximum accepted serialized run record. Trajectories are separate artifacts.
pub const MAX_RECORD_BYTES: usize = 1_048_576;

/// A measured value whose provenance cannot be confused with a fabricated zero.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(tag = "state", rename_all = "snake_case", deny_unknown_fields)]
pub enum Measured<T> {
    /// Reported directly by the named measurement source.
    Reported { value: T },
    /// Estimated by the named method; estimates are not provider-reported facts.
    Estimated { value: T, provenance: String },
    /// Not available; carries a stable reason code rather than a numeric sentinel.
    Unknown { reason: String },
}

impl<T> Measured<T> {
    fn value(&self) -> Option<&T> {
        match self {
            Self::Reported { value } | Self::Estimated { value, .. } => Some(value),
            Self::Unknown { .. } => None,
        }
    }

    fn validate(&self) -> Result<(), RecordError> {
        match self {
            Self::Reported { .. } => Ok(()),
            Self::Estimated { provenance, .. } => validate_code(provenance),
            Self::Unknown { reason } => validate_code(reason),
        }
    }

    fn reported_value(&self) -> Option<&T> {
        match self {
            Self::Reported { value } => Some(value),
            Self::Estimated { .. } | Self::Unknown { .. } => None,
        }
    }
}

/// Development or holdout split.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Split {
    /// Visible data allowed for iteration.
    Dev,
    /// Frozen data governed by the holdout access policy.
    Holdout,
}

/// Enforcement quality for one declared limit.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Enforcement {
    /// The harness actively enforces this ceiling.
    Enforced,
    /// The harness records this value but does not enforce it.
    Observed,
}

/// One resource or time ceiling included in the experiment.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct DeclaredLimit {
    /// Stable limit name, such as `wall_time_ms` or `model_calls`.
    pub name: String,
    /// Non-negative ceiling; zero is a distinct valid configured value.
    pub value: u64,
    /// Whether the evaluator enforces the ceiling or only reports it.
    pub enforcement: Enforcement,
}

/// Bounded trajectory artifact reference and its evidence quality.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Trajectory {
    /// Opaque local artifact ID; its separate digest binds the referenced bytes.
    pub reference: String,
    /// Digest of the referenced artifact.
    pub digest: String,
    /// Whether capture is complete enough for the declared checks.
    pub completeness: Completeness,
    /// Redaction status of the captured artifact.
    pub redaction: Redaction,
    /// Explicit gaps in the event stream.
    pub event_gaps: Vec<String>,
}

/// Opaque immutable artifact reference whose bytes are retained separately.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct ArtifactReference {
    /// Opaque local artifact ID.
    pub reference: String,
    /// Digest of the exact retained bytes.
    pub digest: String,
}

/// Trajectory completeness.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Completeness {
    /// All required events were captured.
    Complete,
    /// A known capture gap exists.
    Incomplete,
    /// Completeness could not be determined.
    Unknown,
}

/// Redaction state for a trajectory.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Redaction {
    /// The artifact passed the configured redaction path.
    Applied,
    /// No redaction was required or applied.
    NotRequired,
    /// The state could not be established.
    Unknown,
}

/// Wall-clock boundaries and monotonic phase durations.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Timing {
    /// RFC3339 timestamp for the evaluation start.
    pub started_at: String,
    /// RFC3339 timestamp for the evaluation end.
    pub ended_at: String,
    /// Submit-to-first-useful-local-action duration.
    pub first_action_ms: Measured<u64>,
    /// Submit-to-first-model-token duration.
    pub first_model_token_ms: Measured<u64>,
    /// Local admission/preparation time before the first model dispatch.
    pub pre_model_overhead_ms: Measured<u64>,
    /// Total monotonic duration.
    pub total_duration_ms: Measured<u64>,
    /// Monotonic elapsed durations by stable phase name.
    pub durations_ms: BTreeMap<String, Measured<u64>>,
}

/// Monetary measurement with explicit currency and rate provenance.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Money {
    /// Decimal amount as text to avoid floating point ambiguity.
    pub amount: String,
    /// Three-letter uppercase currency code (syntax checked; registry membership is not).
    pub currency: String,
    /// Rate source or billing schedule identity.
    pub rate_source: String,
    /// Basis for this amount, such as provider-reported or estimated list price.
    pub rate_basis: String,
}

impl Money {
    fn validate(&self) -> Result<(), RecordError> {
        let mut parts = self.amount.split('.');
        let whole = parts.next().unwrap_or_default();
        let fraction = parts.next();
        if whole.is_empty()
            || !whole.bytes().all(|byte| byte.is_ascii_digit())
            || parts.next().is_some()
            || fraction.is_some_and(|digits| {
                digits.is_empty() || !digits.bytes().all(|byte| byte.is_ascii_digit())
            })
            || self.currency.len() != 3
            || !self.currency.bytes().all(|byte| byte.is_ascii_uppercase())
        {
            return Err(RecordError::Invalid);
        }
        validate_code(&self.rate_source)?;
        validate_code(&self.rate_basis)
    }
}

/// Token and cost observations for a run.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Usage {
    /// Input tokens, when reported or estimated.
    pub input_tokens: Measured<u64>,
    /// Output tokens, when reported or estimated.
    pub output_tokens: Measured<u64>,
    /// Cached input tokens read, when reported or estimated.
    pub cache_read_tokens: Measured<u64>,
    /// Cached input tokens written/created, when reported or estimated.
    pub cache_write_tokens: Measured<u64>,
    /// Monetary cost with currency and rate source, or explicit unknown state.
    pub cost: Measured<Money>,
    /// Context amount by unit and the tokenizer identity when tokenized.
    pub context: ContextUsage,
    /// Measured process and disk resource use; unavailable values stay unknown.
    pub resources: ResourceUsage,
}

/// Context size with explicit units.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ContextUsage {
    /// Serialized context bytes.
    pub bytes: Measured<u64>,
    /// Token count.
    pub tokens: Measured<u64>,
    /// Tokenizer/model identity used for the token count.
    pub tokenizer_id: Measured<String>,
}

/// Process and disk measurements with units in each field name.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ResourceUsage {
    /// CPU time consumed by the evaluated product, in milliseconds.
    pub cpu_time_ms: Measured<u64>,
    /// Peak resident set size, in bytes.
    pub peak_rss_bytes: Measured<u64>,
    /// Peak proportional set size, in bytes.
    pub peak_pss_bytes: Measured<u64>,
    /// Disk bytes read by the evaluated process tree.
    pub disk_read_bytes: Measured<u64>,
    /// Disk bytes written by the evaluated process tree.
    pub disk_write_bytes: Measured<u64>,
}

/// Lifecycle counts for one operation family.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct ActivityCounts {
    /// Calls requested by the model/controller.
    pub attempted: Measured<u64>,
    /// Calls admitted to execution.
    pub started: Measured<u64>,
    /// Calls that returned a successful terminal result.
    pub completed: Measured<u64>,
    /// Calls that failed.
    pub failed: Measured<u64>,
    /// Calls cancelled before completion.
    pub cancelled: Measured<u64>,
}

impl ActivityCounts {
    fn validate(&self) -> Result<(), RecordError> {
        for value in [
            &self.attempted,
            &self.started,
            &self.completed,
            &self.failed,
            &self.cancelled,
        ] {
            value.validate()?;
        }
        let attempted = self.attempted.reported_value().copied();
        let started = self.started.reported_value().copied();
        let completed = self.completed.reported_value().copied();
        let terminal = [
            completed,
            self.failed.reported_value().copied(),
            self.cancelled.reported_value().copied(),
        ];
        if attempted.zip(started).is_some_and(|(a, s)| a < s) {
            return Err(RecordError::Invalid);
        }
        if let Some(started) = started {
            let known_terminal_total = terminal
                .into_iter()
                .flatten()
                .try_fold(0u64, u64::checked_add)
                .ok_or(RecordError::Invalid)?;
            if known_terminal_total > started {
                return Err(RecordError::Invalid);
            }
        }
        if started
            .zip(completed)
            .is_some_and(|(started, completed)| completed > started)
        {
            return Err(RecordError::Invalid);
        }
        Ok(())
    }
}

impl Timing {
    fn validate(&self) -> Result<(), RecordError> {
        for metric in [
            &self.first_action_ms,
            &self.first_model_token_ms,
            &self.pre_model_overhead_ms,
            &self.total_duration_ms,
        ] {
            metric.validate()?;
        }
        for (name, metric) in &self.durations_ms {
            validate_code(name)?;
            metric.validate()?;
        }
        let total = self.total_duration_ms.value().copied();
        for phase in [
            self.first_action_ms.value().copied(),
            self.first_model_token_ms.value().copied(),
            self.pre_model_overhead_ms.value().copied(),
        ]
        .into_iter()
        .flatten()
        {
            if total.is_some_and(|total| phase > total) {
                return Err(RecordError::Invalid);
            }
        }
        Ok(())
    }
}

impl Usage {
    fn validate(&self) -> Result<(), RecordError> {
        for metric in [
            &self.input_tokens,
            &self.output_tokens,
            &self.cache_read_tokens,
            &self.cache_write_tokens,
            &self.context.bytes,
            &self.context.tokens,
            &self.resources.cpu_time_ms,
            &self.resources.peak_rss_bytes,
            &self.resources.peak_pss_bytes,
            &self.resources.disk_read_bytes,
            &self.resources.disk_write_bytes,
        ] {
            metric.validate()?;
        }
        validate_measured_label(&self.context.tokenizer_id)?;
        if self.context.tokens.value().is_some() && self.context.tokenizer_id.value().is_none() {
            return Err(RecordError::Invalid);
        }
        self.cost.validate()?;
        if let Some(money) = self.cost.value() {
            money.validate()?;
        }
        Ok(())
    }
}

fn category_totals_match(
    total: &ActivityCounts,
    categories: &BTreeMap<String, ActivityCounts>,
) -> Result<bool, RecordError> {
    type CountSelector = for<'a> fn(&'a ActivityCounts) -> &'a Measured<u64>;
    let stages: [(&Measured<u64>, CountSelector); 5] = [
        (&total.attempted, |counts| &counts.attempted),
        (&total.started, |counts| &counts.started),
        (&total.completed, |counts| &counts.completed),
        (&total.failed, |counts| &counts.failed),
        (&total.cancelled, |counts| &counts.cancelled),
    ];
    for (aggregate, select) in stages {
        let Some(aggregate) = aggregate.reported_value().copied() else {
            continue;
        };
        let values: Option<Vec<u64>> = categories
            .values()
            .map(|counts| select(counts).reported_value().copied())
            .collect();
        if let Some(values) = values {
            let sum = values
                .into_iter()
                .try_fold(0u64, u64::checked_add)
                .ok_or(RecordError::Invalid)?;
            if aggregate != sum {
                return Ok(false);
            }
        }
    }
    Ok(true)
}

/// Independent-verifier outcome.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerifierOutcome {
    /// Task rubric passed independently.
    Passed,
    /// Task rubric failed independently.
    Failed,
    /// Evidence was not sufficient to decide.
    InsufficientEvidence,
    /// Verifier did not run.
    NotRun,
}

/// Terminal run outcome; failures are retained as first-class records.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Outcome {
    /// The evaluated operation ended normally.
    Completed,
    /// The evaluated operation failed.
    Failed,
    /// The harness crashed or returned an invalid infrastructure result.
    HarnessFailure,
    /// The operation was cancelled.
    Cancelled,
    /// A declared wall-time ceiling expired.
    TimedOut,
    /// Provider failed or was unavailable.
    ProviderFailure,
    /// The run lacked evidence to make its declared determination.
    InsufficientEvidence,
    /// Fixture or environment setup failed before task execution.
    SetupFailure,
    /// Product/harness route is unsupported for this task/environment.
    Unsupported,
}

/// User intervention categories; free-form prompt/credential text is not stored.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum HumanIntervention {
    /// An explicit approval/denial response.
    Approval,
    /// The user changed the task prompt.
    PromptChanged,
    /// The user cancelled the run.
    Cancel,
    /// The user paused the run.
    Pause,
    /// The user resumed the run.
    Resume,
    /// The user supplied a structured correction.
    Correction,
}

/// Stable terminal reason codes, with no free-form provider or user text.
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum TerminalReason {
    /// Run reached its declared normal completion state.
    Completed,
    /// Task acceptance criteria failed.
    TaskFailed,
    /// Harness execution failed independently of the task rubric.
    HarnessFailure,
    /// User or controller cancelled the execution.
    Cancelled,
    /// A declared deadline expired.
    Timeout,
    /// Provider could not complete its request.
    ProviderFailure,
    /// Evaluation setup failed.
    SetupFailure,
    /// Required evidence was unavailable or incomplete.
    InsufficientEvidence,
    /// Route or capability is unsupported for the declared comparison.
    Unsupported,
}

/// Strict schema-v1 immutable evaluation record.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct EvaluationRunV1 {
    /// Exact record schema version.
    pub schema_version: u32,
    /// Stable unique run ID.
    pub evaluation_id: String,
    /// Stable logical group shared by retries/repetitions of one task.
    pub evaluation_group_id: String,
    /// One-based immutable attempt number within the group.
    pub attempt_number: u32,
    /// Previous immutable attempt ID for a retry, if this is not the first.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub retry_of: Option<String>,
    /// Benchmark suite ID.
    pub benchmark_id: String,
    /// Benchmark suite version.
    pub benchmark_version: String,
    /// Digest of the dataset revision.
    pub dataset_digest: String,
    /// Digest of the acceptance criteria revision.
    pub criteria_digest: String,
    /// Whether this is visible development data or frozen holdout data.
    pub split: Split,
    /// Stable task ID.
    pub task_id: String,
    /// Digest of the task definition.
    pub task_digest: String,
    /// Task category/stratum used for analysis.
    pub task_stratum: String,
    /// Stable repository identity, without credentials.
    pub repository_identity: String,
    /// Initial source revision.
    pub start_revision: String,
    /// Revision after candidate integration.
    pub integrated_revision: String,
    /// Exact revision used for verification.
    pub tested_revision: String,
    /// Digest of the initial workspace state.
    pub initial_workspace_digest: String,
    /// Final workspace digest or explicit unknown state.
    pub final_workspace_digest: Measured<String>,
    /// Retrievable final workspace snapshot, retained separately from the record.
    pub workspace_snapshot: ArtifactReference,
    /// Product or harness ID.
    pub harness_id: String,
    /// Exact harness source revision.
    pub harness_revision: String,
    /// Digest of the executable or source build.
    pub binary_digest: String,
    /// Digest of harness configuration.
    pub harness_config_digest: String,
    /// Model identity or explicit unknown state.
    pub model_id: Measured<String>,
    /// Provider identity or explicit unknown state.
    pub provider_id: Measured<String>,
    /// Route identity or explicit unknown state.
    pub route_id: Measured<String>,
    /// Provider adapter/route version or explicit unknown state.
    pub route_version: Measured<String>,
    /// Reasoning setting or explicit unknown state.
    pub reasoning_setting: Measured<String>,
    /// Digest of the model/provider capability snapshot or explicit unknown state.
    pub model_capability_snapshot: Measured<String>,
    /// Digest of the system/user prompt contract.
    pub prompt_digest: String,
    /// Digest of the exposed tool schemas.
    pub tool_schema_digest: String,
    /// Digest of the effective policy/permission snapshot.
    pub policy_snapshot_digest: String,
    /// Digest of environment identity and relevant variables.
    pub environment_digest: String,
    /// Declared enforced and observed limits.
    pub limits: Vec<DeclaredLimit>,
    /// Digest of the network policy.
    pub network_policy_digest: String,
    /// Controlled random seed where available.
    pub seed: Option<u64>,
    /// Repetition number within one run configuration.
    pub repetition: u32,
    /// Position in the declared execution order.
    pub run_order: u32,
    /// Paired-run identity, when part of a controlled comparison.
    pub paired_run_id: Option<String>,
    /// Bounded trajectory artifact metadata.
    pub trajectory: Trajectory,
    /// Start/end timestamps and monotonic durations.
    pub timing: Timing,
    /// Provider-reported, estimated, or unknown usage.
    pub usage: Usage,
    /// Model calls by lifecycle state.
    pub model_call_counts: ActivityCounts,
    /// Aggregate tool calls by lifecycle state.
    pub tool_counts: ActivityCounts,
    /// Per-category tool lifecycle counts, or an explicit unknown state.
    pub tool_counts_by_category: Measured<BTreeMap<String, ActivityCounts>>,
    /// Files read by stable category/state.
    pub file_read_counts: Measured<u64>,
    /// Repeated reads by stable category/state.
    pub repeat_read_counts: Measured<u64>,
    /// Repository search calls by stable category/state.
    pub search_counts: Measured<u64>,
    /// Failed tool calls by stable category/state.
    pub failed_tool_counts: Measured<u64>,
    /// Patch retries by stable category/state.
    pub patch_retry_counts: Measured<u64>,
    /// Checks run by stable category/state.
    pub check_counts: Measured<u64>,
    /// Structured operator interventions; never stores prompt text or credentials.
    pub human_interventions: Vec<HumanIntervention>,
    /// Independent verifier identity and version.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub verifier_id: Option<String>,
    /// Independent verifier implementation version.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub verifier_version: Option<String>,
    /// Digest of verifier environment.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub verifier_environment_digest: Option<String>,
    /// Reference to the verifier result artifact.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub verifier_result_ref: Option<String>,
    /// Digest of the verifier result artifact bytes.
    #[serde(deserialize_with = "deserialize_required_option")]
    pub verifier_result_digest: Option<String>,
    /// Independent verifier's explicit result.
    pub verifier_outcome: VerifierOutcome,
    /// Regression IDs found by the declared checks.
    pub regressions: Vec<String>,
    /// Terminal run outcome.
    pub outcome: Outcome,
    /// Stable terminal reason code.
    pub terminal_reason: TerminalReason,
    /// Controlled limitation codes for interpretation.
    pub limitations: Vec<String>,
    /// BLAKE3 of canonical record with this field omitted.
    pub record_digest: String,
}

impl EvaluationRunV1 {
    fn validate(&self, digest_required: bool) -> Result<(), RecordError> {
        if self.schema_version != 1 || self.repetition == 0 || self.run_order == 0 {
            return Err(RecordError::Invalid);
        }
        for value in [
            &self.evaluation_id,
            &self.evaluation_group_id,
            &self.benchmark_id,
            &self.benchmark_version,
            &self.task_id,
            &self.task_stratum,
            &self.start_revision,
            &self.integrated_revision,
            &self.tested_revision,
            &self.harness_id,
            &self.harness_revision,
        ] {
            validate_label(value)?;
        }
        validate_repository_identity(&self.repository_identity)?;
        validate_code(&self.evaluation_id)?;
        if self.attempt_number == 0
            || (self.attempt_number == 1 && self.retry_of.is_some())
            || (self.attempt_number > 1 && self.retry_of.is_none())
        {
            return Err(RecordError::Invalid);
        }
        if let Some(retry_of) = self.retry_of.as_deref() {
            validate_code(retry_of)?;
            if retry_of == self.evaluation_id {
                return Err(RecordError::Invalid);
            }
        }
        if self
            .paired_run_id
            .as_deref()
            .is_some_and(|value| validate_code(value).is_err())
        {
            return Err(RecordError::Invalid);
        }
        for digest in [
            &self.dataset_digest,
            &self.criteria_digest,
            &self.task_digest,
            &self.initial_workspace_digest,
            &self.binary_digest,
            &self.harness_config_digest,
            &self.prompt_digest,
            &self.tool_schema_digest,
            &self.policy_snapshot_digest,
            &self.environment_digest,
            &self.network_policy_digest,
            &self.trajectory.digest,
            &self.workspace_snapshot.digest,
        ] {
            validate_digest(digest)?;
        }
        if let Some(digest) = &self.verifier_environment_digest {
            validate_digest(digest)?;
        }
        if let Some(digest) = &self.verifier_result_digest {
            validate_digest(digest)?;
        }
        validate_measured_digest(&self.final_workspace_digest)?;
        validate_measured_label(&self.model_id)?;
        validate_measured_label(&self.provider_id)?;
        validate_measured_label(&self.route_id)?;
        validate_measured_label(&self.route_version)?;
        validate_measured_label(&self.reasoning_setting)?;
        validate_measured_digest(&self.model_capability_snapshot)?;
        self.usage.validate()?;
        self.model_call_counts.validate()?;
        self.tool_counts.validate()?;
        match &self.tool_counts_by_category {
            Measured::Reported { value } => {
                for (category, counts) in value {
                    validate_code(category)?;
                    counts.validate()?;
                }
                if !category_totals_match(&self.tool_counts, value)? {
                    return Err(RecordError::Invalid);
                }
            }
            Measured::Estimated { .. } => return Err(RecordError::Invalid),
            Measured::Unknown { .. } => self.tool_counts_by_category.validate()?,
        }
        for metric in [
            &self.file_read_counts,
            &self.repeat_read_counts,
            &self.search_counts,
            &self.failed_tool_counts,
            &self.patch_retry_counts,
            &self.check_counts,
        ] {
            metric.validate()?;
        }
        self.timing.validate()?;
        validate_artifact_reference(&self.trajectory.reference)?;
        validate_artifact_reference(&self.workspace_snapshot.reference)?;
        if self.trajectory.reference == self.workspace_snapshot.reference {
            return Err(RecordError::Invalid);
        }
        let verifier_fields = [
            self.verifier_id.as_deref(),
            self.verifier_version.as_deref(),
            self.verifier_environment_digest.as_deref(),
            self.verifier_result_ref.as_deref(),
            self.verifier_result_digest.as_deref(),
        ];
        let verifier_absent = verifier_fields.iter().all(Option::is_none);
        let verifier_complete = verifier_fields.iter().all(Option::is_some);
        if (self.verifier_outcome == VerifierOutcome::NotRun && !verifier_absent)
            || (self.verifier_outcome != VerifierOutcome::NotRun && !verifier_complete)
        {
            return Err(RecordError::Invalid);
        }
        if let Some(value) = &self.verifier_id {
            validate_label(value)?;
        }
        if let Some(value) = &self.verifier_version {
            validate_label(value)?;
        }
        if let Some(value) = &self.verifier_result_ref {
            validate_artifact_reference(value)?;
        }
        if parse_utc_timestamp(&self.timing.started_at)?
            > parse_utc_timestamp(&self.timing.ended_at)?
        {
            return Err(RecordError::Invalid);
        }
        if self.limits.is_empty()
            || !self.limits.iter().any(|limit| limit.name == "wall_time_ms")
            || self
                .limits
                .iter()
                .any(|limit| validate_code(&limit.name).is_err())
            || (self.trajectory.completeness == Completeness::Complete
                && !self.trajectory.event_gaps.is_empty())
            || (self.trajectory.completeness == Completeness::Incomplete
                && self.trajectory.event_gaps.is_empty())
        {
            return Err(RecordError::Invalid);
        }
        let reason_matches = matches!(
            (self.outcome, self.terminal_reason),
            (Outcome::Completed, TerminalReason::Completed)
                | (Outcome::Failed, TerminalReason::TaskFailed)
                | (Outcome::HarnessFailure, TerminalReason::HarnessFailure)
                | (Outcome::Cancelled, TerminalReason::Cancelled)
                | (Outcome::TimedOut, TerminalReason::Timeout)
                | (Outcome::ProviderFailure, TerminalReason::ProviderFailure)
                | (Outcome::SetupFailure, TerminalReason::SetupFailure)
                | (
                    Outcome::InsufficientEvidence,
                    TerminalReason::InsufficientEvidence
                )
                | (Outcome::Unsupported, TerminalReason::Unsupported)
        );
        let verifier_requires_workspace = matches!(
            self.verifier_outcome,
            VerifierOutcome::Passed | VerifierOutcome::Failed
        );
        if !reason_matches
            || (verifier_requires_workspace
                && self.final_workspace_digest.reported_value().is_none())
        {
            return Err(RecordError::Invalid);
        }
        let mut limit_names = BTreeSet::new();
        if self
            .limits
            .iter()
            .any(|limit| !limit_names.insert(&limit.name))
        {
            return Err(RecordError::Invalid);
        }
        for gap in &self.trajectory.event_gaps {
            validate_code(gap)?;
        }
        for value in self.regressions.iter().chain(&self.limitations) {
            validate_code(value)?;
        }
        if digest_required {
            validate_prefixed_digest(&self.record_digest, "blake3")?;
        }
        Ok(())
    }
}

/// Safe validation failures that never echo untrusted record content.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum RecordError {
    /// Input exceeds the evaluator's fixed read bound.
    #[error("evaluation record exceeds the 1 MiB input limit")]
    TooLarge,
    /// JSON is malformed or does not match schema version 1.
    #[error("evaluation record is invalid JSON or does not match schema v1")]
    InvalidSchema,
    /// A schema-valid record's digest or a required value is invalid.
    #[error("evaluation record failed validation or integrity checking")]
    Invalid,
}

/// Validated run record returned only when schema and content digest agree.
#[derive(Clone, Debug, PartialEq)]
pub struct ValidatedRun(pub EvaluationRunV1);

impl std::ops::Deref for ValidatedRun {
    type Target = EvaluationRunV1;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

/// JSON value parser that rejects duplicate object keys at every nesting level.
struct UniqueJson(serde_json::Value);

impl<'de> Deserialize<'de> for UniqueJson {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        struct UniqueJsonVisitor;

        impl<'de> Visitor<'de> for UniqueJsonVisitor {
            type Value = UniqueJson;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON value without duplicate object keys")
            }

            fn visit_unit<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::Null))
            }

            fn visit_none<E: serde::de::Error>(self) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::Null))
            }

            fn visit_bool<E>(self, value: bool) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::Bool(value)))
            }

            fn visit_i64<E>(self, value: i64) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::Number(value.into())))
            }

            fn visit_u64<E>(self, value: u64) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::Number(value.into())))
            }

            fn visit_f64<E>(self, value: f64) -> Result<Self::Value, E>
            where
                E: serde::de::Error,
            {
                let number = serde_json::Number::from_f64(value)
                    .ok_or_else(|| E::custom("non-finite JSON number"))?;
                Ok(UniqueJson(serde_json::Value::Number(number)))
            }

            fn visit_str<E>(self, value: &str) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::String(value.to_owned())))
            }

            fn visit_string<E>(self, value: String) -> Result<Self::Value, E> {
                Ok(UniqueJson(serde_json::Value::String(value)))
            }

            fn visit_seq<A>(self, mut sequence: A) -> Result<Self::Value, A::Error>
            where
                A: SeqAccess<'de>,
            {
                let mut values = Vec::new();
                while let Some(value) = sequence.next_element::<UniqueJson>()? {
                    values.push(value.0);
                }
                Ok(UniqueJson(serde_json::Value::Array(values)))
            }

            fn visit_map<A>(self, mut map: A) -> Result<Self::Value, A::Error>
            where
                A: MapAccess<'de>,
            {
                let mut values = serde_json::Map::new();
                while let Some(key) = map.next_key::<String>()? {
                    if values.contains_key(&key) {
                        return Err(serde::de::Error::custom("duplicate JSON object key"));
                    }
                    let value = map.next_value::<UniqueJson>()?;
                    values.insert(key, value.0);
                }
                Ok(UniqueJson(serde_json::Value::Object(values)))
            }
        }

        deserializer.deserialize_any(UniqueJsonVisitor)
    }
}

/// Parse, validate and integrity-check one bounded V1 record.
pub fn validate_bytes(bytes: &[u8]) -> Result<ValidatedRun, RecordError> {
    if bytes.len() > MAX_RECORD_BYTES {
        return Err(RecordError::TooLarge);
    }
    let mut deserializer = serde_json::Deserializer::from_slice(bytes);
    let UniqueJson(value) =
        UniqueJson::deserialize(&mut deserializer).map_err(|_| RecordError::InvalidSchema)?;
    deserializer.end().map_err(|_| RecordError::InvalidSchema)?;
    let record: EvaluationRunV1 =
        serde_json::from_value(value).map_err(|_| RecordError::InvalidSchema)?;
    record.validate(true)?;
    let expected = digest_record(&record)?;
    if record.record_digest != expected {
        return Err(RecordError::Invalid);
    }
    Ok(ValidatedRun(record))
}

/// Seal a JSON V1 record after strict schema and semantic validation.
///
/// This is exposed to fixture/evaluator producers. The record is replaced with
/// normalized typed serialization only after validation succeeds.
pub fn seal_value(value: &mut serde_json::Value) -> Result<String, RecordError> {
    if serde_json::to_vec(value)
        .map_err(|_| RecordError::InvalidSchema)?
        .len()
        > MAX_RECORD_BYTES
    {
        return Err(RecordError::TooLarge);
    }
    let mut record: EvaluationRunV1 =
        serde_json::from_value(value.clone()).map_err(|_| RecordError::InvalidSchema)?;
    record.record_digest.clear();
    record.validate(false)?;
    let digest = digest_record(&record)?;
    record.record_digest.clone_from(&digest);
    *value = serde_json::to_value(record).map_err(|_| RecordError::InvalidSchema)?;
    Ok(digest)
}

fn digest_record(record: &EvaluationRunV1) -> Result<String, RecordError> {
    let mut value = serde_json::to_value(record).map_err(|_| RecordError::InvalidSchema)?;
    value
        .as_object_mut()
        .ok_or(RecordError::InvalidSchema)?
        .remove("record_digest");
    let canonical = canonical_json_bytes(&value)?;
    Ok(format!("blake3:{}", blake3::hash(&canonical).to_hex()))
}

fn canonical_json_bytes(value: &serde_json::Value) -> Result<Vec<u8>, RecordError> {
    fn write_string(value: &str, output: &mut Vec<u8>) {
        output.push(b'"');
        for character in value.chars() {
            match character {
                '"' => output.extend_from_slice(b"\\\""),
                '\\' => output.extend_from_slice(b"\\\\"),
                '\u{0008}' => output.extend_from_slice(b"\\b"),
                '\t' => output.extend_from_slice(b"\\t"),
                '\n' => output.extend_from_slice(b"\\n"),
                '\u{000c}' => output.extend_from_slice(b"\\f"),
                '\r' => output.extend_from_slice(b"\\r"),
                control if control <= '\u{001f}' => {
                    output.extend_from_slice(format!("\\u{:04x}", control as u32).as_bytes());
                }
                other => {
                    let mut encoded = [0u8; 4];
                    output.extend_from_slice(other.encode_utf8(&mut encoded).as_bytes());
                }
            }
        }
        output.push(b'"');
    }

    fn write(value: &serde_json::Value, output: &mut Vec<u8>) -> Result<(), RecordError> {
        match value {
            serde_json::Value::Null => output.extend_from_slice(b"null"),
            serde_json::Value::Bool(false) => output.extend_from_slice(b"false"),
            serde_json::Value::Bool(true) => output.extend_from_slice(b"true"),
            serde_json::Value::Number(number) => {
                if let Some(integer) = number.as_i64() {
                    output.extend_from_slice(integer.to_string().as_bytes());
                } else if let Some(integer) = number.as_u64() {
                    output.extend_from_slice(integer.to_string().as_bytes());
                } else {
                    // V1 contains integer-valued counters and limits only.
                    return Err(RecordError::InvalidSchema);
                }
            }
            serde_json::Value::String(string) => write_string(string, output),
            serde_json::Value::Array(values) => {
                output.push(b'[');
                for (index, value) in values.iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    write(value, output)?;
                }
                output.push(b']');
            }
            serde_json::Value::Object(values) => {
                let sorted: BTreeMap<_, _> = values.iter().collect();
                output.push(b'{');
                for (index, (key, value)) in sorted.into_iter().enumerate() {
                    if index > 0 {
                        output.push(b',');
                    }
                    write_string(key, output);
                    output.push(b':');
                    write(value, output)?;
                }
                output.push(b'}');
            }
        }
        Ok(())
    }

    let mut output = Vec::new();
    write(value, &mut output)?;
    Ok(output)
}

fn validate_label(value: &str) -> Result<(), RecordError> {
    if value.trim().is_empty() || value.len() > 4096 || value.chars().any(char::is_control) {
        return Err(RecordError::Invalid);
    }
    Ok(())
}

fn deserialize_required_option<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn validate_code(value: &str) -> Result<(), RecordError> {
    if value.is_empty()
        || value.len() > 128
        || !value.bytes().all(|byte| {
            byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_.:".contains(&byte)
        })
    {
        return Err(RecordError::Invalid);
    }
    Ok(())
}

fn validate_repository_identity(value: &str) -> Result<(), RecordError> {
    validate_label(value)?;
    if value.contains('?') || value.contains('#') {
        return Err(RecordError::Invalid);
    }
    if let Some((scheme, rest)) = value.split_once("://")
        && (scheme.is_empty()
            || rest
                .split('/')
                .next()
                .is_some_and(|authority| authority.contains('@')))
    {
        return Err(RecordError::Invalid);
    }
    Ok(())
}

fn validate_artifact_reference(value: &str) -> Result<(), RecordError> {
    validate_label(value)?;
    let Some(id) = value.strip_prefix("artifact:") else {
        return Err(RecordError::Invalid);
    };
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte))
    {
        return Err(RecordError::Invalid);
    }
    Ok(())
}

fn parse_utc_timestamp(value: &str) -> Result<[u32; 7], RecordError> {
    let bytes = value.as_bytes();
    if (bytes.len() != 20 && !(bytes.len() >= 22 && bytes.get(19) == Some(&b'.')))
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
        || bytes.last() != Some(&b'Z')
        || !bytes[..19]
            .iter()
            .enumerate()
            .all(|(index, byte)| matches!(index, 4 | 7 | 10 | 13 | 16) || byte.is_ascii_digit())
        || (bytes.len() > 20 && !bytes[20..bytes.len() - 1].iter().all(u8::is_ascii_digit))
    {
        return Err(RecordError::Invalid);
    }
    let number = |start, end| {
        value
            .get(start..end)
            .and_then(|part| part.parse::<u32>().ok())
    };
    let year = number(0, 4).ok_or(RecordError::Invalid)?;
    let month = number(5, 7).ok_or(RecordError::Invalid)?;
    let day = number(8, 10).ok_or(RecordError::Invalid)?;
    let hour = number(11, 13).ok_or(RecordError::Invalid)?;
    let minute = number(14, 16).ok_or(RecordError::Invalid)?;
    let second = number(17, 19).ok_or(RecordError::Invalid)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if year == 0 || !(1..=days_in_month).contains(&day) || hour > 23 || minute > 59 || second > 59 {
        return Err(RecordError::Invalid);
    }
    let fraction = if bytes.len() > 20 {
        let digits = &value[20..value.len() - 1];
        if digits.len() > 9 {
            return Err(RecordError::Invalid);
        }
        format!("{digits:0<9}")
            .parse::<u32>()
            .map_err(|_| RecordError::Invalid)?
    } else {
        0
    };
    Ok([year, month, day, hour, minute, second, fraction])
}

fn validate_measured_label(metric: &Measured<String>) -> Result<(), RecordError> {
    metric.validate()?;
    if let Some(value) = metric.value() {
        validate_label(value)?;
    }
    Ok(())
}

fn validate_measured_digest(metric: &Measured<String>) -> Result<(), RecordError> {
    metric.validate()?;
    match metric {
        Measured::Reported { value } => validate_digest(value)?,
        Measured::Estimated { .. } => return Err(RecordError::Invalid),
        Measured::Unknown { .. } => {}
    }
    Ok(())
}

fn validate_digest(value: &str) -> Result<(), RecordError> {
    if value.starts_with("sha256:") {
        validate_prefixed_digest(value, "sha256")
    } else {
        validate_prefixed_digest(value, "blake3")
    }
}

fn validate_prefixed_digest(value: &str, algorithm: &str) -> Result<(), RecordError> {
    let Some(hex) = value.strip_prefix(&format!("{algorithm}:")) else {
        return Err(RecordError::Invalid);
    };
    if hex.len() != 64
        || !hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(RecordError::Invalid);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::{MAX_RECORD_BYTES, Measured, seal_value, validate_bytes};

    fn valid_record() -> Value {
        json!({
            "schema_version": 1,
            "evaluation_id": "eval-smoke-001",
            "evaluation_group_id": "group-smoke-001",
            "attempt_number": 1,
            "retry_of": null,
            "benchmark_id": "HZBench-Dev",
            "benchmark_version": "1",
            "dataset_digest": format!("sha256:{}", "a".repeat(64)),
            "criteria_digest": format!("sha256:{}", "b".repeat(64)),
            "split": "dev",
            "task_id": "smoke-echo",
            "task_digest": format!("sha256:{}", "c".repeat(64)),
            "task_stratum": "mechanics",
            "repository_identity": "fixture:empty-workspace",
            "start_revision": "fixture-rev-1",
            "integrated_revision": "fixture-rev-1",
            "tested_revision": "fixture-rev-1",
            "initial_workspace_digest": format!("blake3:{}", "d".repeat(64)),
            "final_workspace_digest": {"state":"reported", "value":format!("blake3:{}", "d".repeat(64))},
            "workspace_snapshot": {"reference":"artifact:workspace-1", "digest":format!("blake3:{}", "9".repeat(64))},
            "harness_id": "horizoncode",
            "harness_revision": "fixture-build-1",
            "binary_digest": format!("blake3:{}", "e".repeat(64)),
            "harness_config_digest": format!("blake3:{}", "f".repeat(64)),
            "model_id": {"state":"reported", "value":"scripted-fixture"},
            "provider_id": {"state":"reported", "value":"in-process"},
            "route_id": {"state":"reported", "value":"fixture-v1"},
            "route_version": {"state":"unknown", "reason":"not_applicable"},
            "reasoning_setting": {"state":"unknown", "reason":"not_applicable"},
            "model_capability_snapshot": {"state":"unknown", "reason":"not_applicable"},
            "prompt_digest": format!("blake3:{}", "1".repeat(64)),
            "tool_schema_digest": format!("blake3:{}", "2".repeat(64)),
            "policy_snapshot_digest": format!("blake3:{}", "3".repeat(64)),
            "environment_digest": format!("blake3:{}", "4".repeat(64)),
            "limits": [{"name":"wall_time_ms", "value":1000, "enforcement":"enforced"}],
            "network_policy_digest": format!("blake3:{}", "5".repeat(64)),
            "seed": null,
            "repetition": 1,
            "run_order": 1,
            "paired_run_id": null,
            "trajectory": {
                "reference":"artifact:trajectory-1",
                "digest":format!("blake3:{}", "6".repeat(64)),
                "completeness":"complete",
                "redaction":"applied",
                "event_gaps":[]
            },
            "timing": {
                "started_at":"2026-10-02T00:00:00Z",
                "ended_at":"2026-10-02T00:00:00Z",
                "first_action_ms":{"state":"unknown","reason":"not_reported"},
                "first_model_token_ms":{"state":"unknown","reason":"not_reported"},
                "pre_model_overhead_ms":{"state":"unknown","reason":"not_reported"},
                "total_duration_ms":{"state":"reported","value":0},
                "durations_ms":{"total":{"state":"reported","value":0}}
            },
            "usage": {
                "input_tokens":{"state":"unknown","reason":"not_reported"},
                "output_tokens":{"state":"unknown","reason":"not_reported"},
                "cache_read_tokens":{"state":"unknown","reason":"not_reported"},
                "cache_write_tokens":{"state":"unknown","reason":"not_reported"},
                "cost":{"state":"unknown","reason":"not_applicable"},
                "context":{
                    "bytes":{"state":"unknown","reason":"not_reported"},
                    "tokens":{"state":"unknown","reason":"not_reported"},
                    "tokenizer_id":{"state":"unknown","reason":"not_reported"}
                },
                "resources":{
                    "cpu_time_ms":{"state":"unknown","reason":"not_reported"},
                    "peak_rss_bytes":{"state":"unknown","reason":"not_reported"},
                    "peak_pss_bytes":{"state":"unknown","reason":"not_reported"},
                    "disk_read_bytes":{"state":"unknown","reason":"not_reported"},
                    "disk_write_bytes":{"state":"unknown","reason":"not_reported"}
                }
            },
            "model_call_counts":{
                "attempted":{"state":"reported","value":1},
                "started":{"state":"reported","value":1},
                "completed":{"state":"reported","value":1},
                "failed":{"state":"reported","value":0},
                "cancelled":{"state":"reported","value":0}
            },
            "tool_counts":{
                "attempted":{"state":"reported","value":0},
                "started":{"state":"reported","value":0},
                "completed":{"state":"reported","value":0},
                "failed":{"state":"reported","value":0},
                "cancelled":{"state":"reported","value":0}
            },
            "tool_counts_by_category":{"state":"reported","value":{}},
            "file_read_counts":{"state":"reported","value":0},
            "repeat_read_counts":{"state":"reported","value":0},
            "search_counts":{"state":"reported","value":0},
            "failed_tool_counts":{"state":"reported","value":0},
            "patch_retry_counts":{"state":"reported","value":0},
            "check_counts":{"state":"reported","value":0},
            "human_interventions":[],
            "verifier_id":"hz-eval-fixture-v1",
            "verifier_version":"1",
            "verifier_environment_digest":format!("blake3:{}", "7".repeat(64)),
            "verifier_result_ref":"artifact:verifier-result-1",
            "verifier_result_digest":format!("blake3:{}", "8".repeat(64)),
            "regressions":[],
            "outcome":"completed",
            "verifier_outcome":"passed",
            "terminal_reason":"completed",
            "limitations":["mechanics_only_not_coding_quality"],
            "record_digest":""
        })
    }

    #[test]
    fn validates_a_sealed_v1_record_and_distinguishes_unknown_from_zero() {
        let mut record = valid_record();
        record["record_digest"] = Value::String(seal_value(&mut record).unwrap());

        let bytes = serde_json::to_vec(&record).unwrap();
        let validated = validate_bytes(&bytes).unwrap();
        assert_eq!(validated.evaluation_id, "eval-smoke-001");
        assert!(matches!(
            validated.timing.durations_ms["total"],
            Measured::Reported { value: 0 }
        ));
        assert!(matches!(
            validated.usage.input_tokens,
            Measured::Unknown { .. }
        ));
    }

    #[test]
    fn accepts_estimated_values_with_provenance_but_rejects_unclassified_unknowns() {
        let mut record = valid_record();
        record["usage"]["input_tokens"] = json!({
            "state":"estimated",
            "value":0,
            "provenance":"fixture_token_counter_v1"
        });
        record["record_digest"] = Value::String(seal_value(&mut record).unwrap());
        let validated = validate_bytes(&serde_json::to_vec(&record).unwrap()).unwrap();
        assert!(matches!(
            validated.usage.input_tokens,
            Measured::Estimated { value: 0, .. }
        ));

        let mut invalid = valid_record();
        invalid["usage"]["input_tokens"] =
            json!({"state":"unknown","reason":"contains arbitrary prose"});
        assert!(seal_value(&mut invalid).is_err());
    }

    #[test]
    fn rejects_a_tampered_record_after_digest_sealing() {
        let mut record = valid_record();
        record["record_digest"] = Value::String(seal_value(&mut record).unwrap());
        record["task_id"] = Value::String("changed-after-seal".to_owned());

        let bytes = serde_json::to_vec(&record).unwrap();
        assert!(validate_bytes(&bytes).is_err());
    }

    #[test]
    fn rejects_inconsistent_counts_outcomes_and_artifact_path_references() {
        let mut counts = valid_record();
        counts["model_call_counts"]["attempted"] = json!({"state":"reported","value":0});
        assert!(seal_value(&mut counts).is_err());

        let mut outcome = valid_record();
        outcome["terminal_reason"] = json!("timeout");
        assert!(seal_value(&mut outcome).is_err());

        for unsafe_reference in [
            "artifact:../outside",
            "artifact:..",
            "artifact:%2e%2e",
            "file:///tmp/trajectory",
        ] {
            let mut reference = valid_record();
            reference["trajectory"]["reference"] = json!(unsafe_reference);
            assert!(seal_value(&mut reference).is_err(), "{unsafe_reference}");
        }
    }

    #[test]
    fn incomplete_trajectory_requires_an_explicit_capture_gap() {
        let mut record = valid_record();
        record["trajectory"]["completeness"] = json!("incomplete");
        assert!(seal_value(&mut record).is_err());

        record["trajectory"]["event_gaps"] = json!(["trajectory_capture_limit"]);
        assert!(seal_value(&mut record).is_ok());
    }

    #[test]
    fn rejects_duplicate_json_keys_and_non_chronological_timestamps() {
        let bytes = serde_json::to_vec(&valid_record()).unwrap();
        let mut duplicated = b"{\"schema_version\":1,".to_vec();
        duplicated.extend_from_slice(&bytes[1..]);
        assert!(validate_bytes(&duplicated).is_err());

        let duplicate_duration = serde_json::to_vec(&valid_record()).unwrap();
        let duplicate_duration = String::from_utf8(duplicate_duration).unwrap();
        let duplicate_duration = duplicate_duration.replacen(
            r#""durations_ms":{"total":{"state":"reported","value":0}}"#,
            r#""durations_ms":{"total":{"state":"reported","value":0},"total":{"state":"reported","value":0}}"#,
            1,
        );
        assert!(validate_bytes(duplicate_duration.as_bytes()).is_err());

        let mut record = valid_record();
        record["timing"]["ended_at"] = json!("2026-10-01T23:59:59Z");
        assert!(seal_value(&mut record).is_err());
    }

    #[test]
    fn rejects_excessively_nested_json_with_a_typed_error() {
        let nested = format!("{}null{}", "[".repeat(256), "]".repeat(256));
        assert!(validate_bytes(nested.as_bytes()).is_err());
    }

    #[test]
    fn canonical_digest_uses_recursively_sorted_object_keys() {
        let mut record = valid_record();
        let expected = seal_value(&mut record).unwrap();
        let reordered: Value =
            serde_json::from_str(r#"{"z":{"b":2,"a":1},"a":[{"y":true,"x":false}]}"#).unwrap();
        let normal: Value =
            serde_json::from_str(r#"{"a":[{"x":false,"y":true}],"z":{"a":1,"b":2}}"#).unwrap();
        assert_eq!(
            super::canonical_json_bytes(&reordered).unwrap(),
            super::canonical_json_bytes(&normal).unwrap()
        );
        assert_eq!(
            super::canonical_json_bytes(&normal).unwrap(),
            br#"{"a":[{"x":false,"y":true}],"z":{"a":1,"b":2}}"#
        );
        assert_eq!(seal_value(&mut record).unwrap(), expected);
    }

    #[test]
    fn canonical_json_has_a_fixed_byte_and_digest_vector() {
        let value = serde_json::from_str(r#"{"b":2,"a":1}"#).unwrap();
        let bytes = super::canonical_json_bytes(&value).unwrap();
        assert_eq!(bytes, br#"{"a":1,"b":2}"#);
        assert_eq!(
            blake3::hash(&bytes).to_hex().to_string(),
            "8e80439b77ac62d4194499edd46684c479da3aa1ac80dd5511468efae049166e"
        );
    }

    #[test]
    fn validates_same_sealed_record_after_root_keys_are_reordered() {
        let mut record = valid_record();
        record["record_digest"] = Value::String(seal_value(&mut record).unwrap());
        let encoded = serde_json::to_vec(&record).unwrap();
        let reordered = reverse_root_members(&encoded);
        assert_eq!(
            validate_bytes(&encoded).unwrap().record_digest,
            validate_bytes(&reordered).unwrap().record_digest
        );
    }

    fn reverse_root_members(bytes: &[u8]) -> Vec<u8> {
        assert_eq!(bytes.first(), Some(&b'{'));
        assert_eq!(bytes.last(), Some(&b'}'));
        let mut members = Vec::new();
        let mut start = 1;
        let mut depth = 1usize;
        let mut in_string = false;
        let mut escaped = false;
        for (index, byte) in bytes.iter().enumerate().skip(1).take(bytes.len() - 2) {
            if in_string {
                if escaped {
                    escaped = false;
                } else if *byte == b'\\' {
                    escaped = true;
                } else if *byte == b'"' {
                    in_string = false;
                }
                continue;
            }
            match byte {
                b'"' => in_string = true,
                b'{' | b'[' => depth += 1,
                b'}' | b']' => depth -= 1,
                b',' if depth == 1 => {
                    members.push(&bytes[start..index]);
                    start = index + 1;
                }
                _ => {}
            }
        }
        members.push(&bytes[start..bytes.len() - 1]);
        let mut reordered = vec![b'{'];
        for (index, member) in members.iter().rev().enumerate() {
            if index > 0 {
                reordered.push(b',');
            }
            reordered.extend_from_slice(member);
        }
        reordered.push(b'}');
        reordered
    }

    #[test]
    fn rejects_missing_wall_limit_inconsistent_timing_and_negative_cost() {
        let mut no_wall_limit = valid_record();
        no_wall_limit["limits"] = json!([]);
        assert!(seal_value(&mut no_wall_limit).is_err());

        let mut timing = valid_record();
        timing["timing"]["first_action_ms"] = json!({"state":"reported","value":2});
        assert!(seal_value(&mut timing).is_err());

        let mut negative = valid_record();
        negative["usage"]["cost"] = json!({
            "state":"reported",
            "value":{"amount":"-1.00","currency":"USD","rate_source":"fixture_rates_v1","rate_basis":"provider_invoice"}
        });
        assert!(seal_value(&mut negative).is_err());

        let mut invalid_fraction = valid_record();
        invalid_fraction["timing"]["started_at"] = json!("2026-10-02T00:00:00.Z");
        assert!(seal_value(&mut invalid_fraction).is_err());

        let mut estimated_total = valid_record();
        estimated_total["timing"]["total_duration_ms"] = json!({
            "state":"estimated","value":1,"provenance":"fixture_clock_v1"
        });
        estimated_total["timing"]["first_model_token_ms"] = json!({"state":"reported","value":2});
        assert!(seal_value(&mut estimated_total).is_err());
    }

    #[test]
    fn category_counts_reconcile_with_reported_tool_totals() {
        let mut mismatch = valid_record();
        mismatch["tool_counts"]["attempted"] = json!({"state":"reported","value":1});
        assert!(seal_value(&mut mismatch).is_err());

        let mut matching = valid_record();
        matching["tool_counts"]["attempted"] = json!({"state":"reported","value":1});
        matching["tool_counts"]["started"] = json!({"state":"reported","value":1});
        matching["tool_counts"]["completed"] = json!({"state":"reported","value":1});
        matching["tool_counts_by_category"]["value"]["filesystem_write"] = json!({
            "attempted":{"state":"reported","value":1},
            "started":{"state":"reported","value":1},
            "completed":{"state":"reported","value":1},
            "failed":{"state":"reported","value":0},
            "cancelled":{"state":"reported","value":0}
        });
        assert!(seal_value(&mut matching).is_ok());
    }

    #[test]
    fn accepts_exact_input_limit_and_rejects_one_byte_over() {
        let mut record = valid_record();
        record["record_digest"] = Value::String(seal_value(&mut record).unwrap());
        let mut bytes = serde_json::to_vec(&record).unwrap();
        bytes.resize(MAX_RECORD_BYTES, b' ');
        assert!(validate_bytes(&bytes).is_ok());
        bytes.push(b' ');
        assert!(validate_bytes(&bytes).is_err());
    }

    #[test]
    fn rejects_unknown_schema_and_unreviewed_or_credential_fields() {
        let mut record = valid_record();
        record["schema_version"] = json!(2);
        assert!(seal_value(&mut record).is_err());

        let mut record = valid_record();
        record["api_key"] = json!("must never be accepted or echoed");
        assert!(seal_value(&mut record).is_err());
    }

    #[test]
    fn rejects_missing_required_revision_and_malformed_digest() {
        let mut record = valid_record();
        record.as_object_mut().unwrap().remove("tested_revision");
        assert!(seal_value(&mut record).is_err());

        let mut record = valid_record();
        record.as_object_mut().unwrap().remove("verifier_id");
        assert!(seal_value(&mut record).is_err());

        let mut record = valid_record();
        record["task_digest"] = json!("sha256:not-a-digest");
        assert!(seal_value(&mut record).is_err());
    }

    #[test]
    fn run_outcome_and_independent_verifier_result_are_separate_facts() {
        let mut failed_but_accepted = valid_record();
        failed_but_accepted["outcome"] = json!("provider_failure");
        failed_but_accepted["terminal_reason"] = json!("provider_failure");
        failed_but_accepted["verifier_outcome"] = json!("passed");
        // A terminal provider failure may still leave a workspace that satisfies
        // the independent task rubric; execution outcome does not imply acceptance.
        assert!(seal_value(&mut failed_but_accepted).is_ok());

        let mut completed_unverified = valid_record();
        completed_unverified["verifier_outcome"] = json!("not_run");
        completed_unverified["verifier_id"] = Value::Null;
        completed_unverified["verifier_version"] = Value::Null;
        completed_unverified["verifier_environment_digest"] = Value::Null;
        completed_unverified["verifier_result_ref"] = Value::Null;
        completed_unverified["verifier_result_digest"] = Value::Null;
        assert!(seal_value(&mut completed_unverified).is_ok());

        let mut setup_failure = valid_record();
        setup_failure["outcome"] = json!("setup_failure");
        setup_failure["terminal_reason"] = json!("setup_failure");
        setup_failure["verifier_outcome"] = json!("not_run");
        setup_failure["verifier_id"] = Value::Null;
        setup_failure["verifier_version"] = Value::Null;
        setup_failure["verifier_environment_digest"] = Value::Null;
        setup_failure["verifier_result_ref"] = Value::Null;
        setup_failure["verifier_result_digest"] = Value::Null;
        assert!(seal_value(&mut setup_failure).is_ok());

        let mut harness_failure = setup_failure.clone();
        harness_failure["outcome"] = json!("harness_failure");
        harness_failure["terminal_reason"] = json!("harness_failure");
        assert!(seal_value(&mut harness_failure).is_ok());

        let mut passed_without_workspace = valid_record();
        passed_without_workspace["final_workspace_digest"] =
            json!({"state":"unknown","reason":"capture_unavailable"});
        assert!(seal_value(&mut passed_without_workspace).is_err());
    }

    #[test]
    fn known_context_tokens_require_a_tokenizer_identity() {
        let mut missing_tokenizer = valid_record();
        missing_tokenizer["usage"]["context"]["tokens"] = json!({"state":"reported","value":256});
        assert!(seal_value(&mut missing_tokenizer).is_err());

        let mut identified = valid_record();
        identified["usage"]["context"]["tokens"] = json!({"state":"reported","value":0});
        identified["usage"]["context"]["tokenizer_id"] =
            json!({"state":"reported","value":"model-tokenizer-v1"});
        assert!(seal_value(&mut identified).is_ok());
    }

    #[test]
    fn attempt_lineage_and_separate_snapshot_reference_are_required() {
        let mut record = valid_record();
        assert!(record.get("workspace_snapshot").is_some());

        let mut retry_without_parent = record.clone();
        retry_without_parent["attempt_number"] = Value::from(2);
        assert!(seal_value(&mut retry_without_parent).is_err());

        record["attempt_number"] = Value::from(2);
        record["retry_of"] = Value::String("eval-prior-001".to_owned());
        assert!(seal_value(&mut record).is_ok());
    }
}
