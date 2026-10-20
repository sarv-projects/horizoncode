//! Deterministic, bounded Task-DAG admission and typed artifact-edge validation.
//!
//! This module is a pure admission planner/validator, **not** a second Task
//! scheduler authority. The canonical durable Task/Attempt owner remains
//! [`crate::managed_control`]; a [`ValidatedTaskGraph`] here is a *proposal*
//! that a trusted coordinator may persist after these fail-closed checks. No
//! worker launch, effect, capacity reservation or OwnerLog write happens in
//! this module, and no caller may use a compiled graph as permission to run
//! work. §29.17/§29.18 and §21.11 own the normative semantics.
//!
//! Enforced invariants:
//! - every edge refers to the same Run and the graph stays acyclic;
//! - graph-wide member, depth (recursion) and per-parent breadth caps;
//! - accepted-criterion coverage unless explicitly deferred, and no invented
//!   criterion IDs;
//! - typed artifact edges: a consumer may only require a kind its declared
//!   producer task actually outputs, and artifact edges are dependency edges;
//! - parallel write scopes either do not overlap or are ordered by a
//!   dependency edge; read-only overlap is safe; unknown writes are rejected;
//! - result ingestion verifies attempt/worker/epoch binding, artifact digest
//!   shape, source revision and late/duplicate delivery rules;
//! - verification is revision-bound and never self-approved by the producing
//!   worker/attempt.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::json;

const MAX_ID_LENGTH: usize = 128;
const MAX_TEXT_LENGTH: usize = 512;
const MAX_ARTIFACT_REFS: usize = 16;
const MAX_SCOPES: usize = 32;
const MAX_CRITERIA_PER_TASK: usize = 32;
const MAX_ACCEPTED_CRITERIA: usize = 512;
const MAX_ERRORS: usize = 16;
const MAX_FILE_TOUCHES: usize = 256;
const MAX_REF_LENGTH: usize = 256;
const MAX_EVIDENCE_REFS: usize = 64;
/// Graph-wide member cap (including nested fan-out children).
pub const MAX_GRAPH_MEMBERS: usize = 64;
/// Recursion/depth cap for a fan-out tree.
pub const MAX_GRAPH_DEPTH: u32 = 8;
/// §29.18: a 21st direct child beyond the configured 20-child limit is rejected.
pub const MAX_CHILDREN_PER_TASK: usize = 20;

/// One admitted deliverable in a validated Task graph.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ArtifactFidelity {
    Full,
    Sample,
}

impl ArtifactFidelity {
    pub fn wire_name(self) -> &'static str {
        match self {
            Self::Full => "FULL",
            Self::Sample => "SAMPLE",
        }
    }

    pub fn parse_wire(value: &str) -> Option<Self> {
        match value {
            "FULL" => Some(Self::Full),
            "SAMPLE" => Some(Self::Sample),
            _ => None,
        }
    }
}

/// `CandidateTaskResultV1.artifacts[]` plus the declared artifact kind. The
/// kind is validated against the producer Task's declared output kinds.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactRefV1 {
    pub artifact_id: String,
    pub artifact_kind: String,
    pub sha256: String,
    pub mime: String,
    pub source_revision: String,
    pub fidelity: ArtifactFidelity,
}

impl ArtifactRefV1 {
    fn validate(&self) -> Result<(), DagError> {
        validate_id("artifact ID", &self.artifact_id)?;
        validate_id("artifact kind", &self.artifact_kind)?;
        if !is_sha256_hex(&self.sha256) {
            return Err(DagError::InvalidArtifactDigest);
        }
        validate_text("artifact mime", &self.mime, MAX_ID_LENGTH)?;
        validate_id("artifact source revision", &self.source_revision)?;
        Ok(())
    }
}

/// Declared typed input of one Task: another Task in the same graph must
/// produce this artifact kind (and optionally exactly this artifact ID).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactRequirementV1 {
    pub from_task: String,
    pub kind: String,
    pub artifact_id: Option<String>,
}

/// Bounded planning estimate copied from `TaskProposalV1.estimatedUsage`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct EstimatedUsage {
    pub memory_bytes: Option<u64>,
    pub tokens: Option<u64>,
}

/// One proposed Task before graph admission (`TaskProposalV1.proposedTasks[]`).
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskNodeDraft {
    pub task_id: String,
    pub title: String,
    pub purpose: String,
    pub dependencies: Vec<String>,
    pub criterion_ids: Vec<String>,
    pub input_artifacts: Vec<ArtifactRequirementV1>,
    pub output_artifact_kinds: Vec<String>,
    pub read_scopes: Vec<String>,
    pub write_scopes: Vec<String>,
    pub read_only: bool,
    pub requires_tools: Vec<String>,
    pub requested_profile: String,
    pub estimated_usage: EstimatedUsage,
}

/// One `TaskProposalV1` admission request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskProposalV1 {
    pub run_id: String,
    pub expected_graph_revision: String,
    pub base_graph_revision: String,
    pub accepted_criteria: Vec<String>,
    /// Only an explicit user-approved deferral permits uncovered criteria.
    pub criteria_deferred: bool,
    pub tasks: Vec<TaskNodeDraft>,
}

/// Trusted binding of a proposal to the accepted SpecVersion and parent scope.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GraphBinding {
    pub accepted_spec_digest: String,
    pub parent_scope_digest: String,
}

/// Bounds applied at graph admission. Callers must not raise them past the
/// module constants; larger fan-out needs an explicit architecture decision.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct DagLimits {
    pub max_members: usize,
    pub max_depth: u32,
    pub max_children_per_task: usize,
}

impl Default for DagLimits {
    fn default() -> Self {
        Self {
            max_members: 20,
            max_depth: MAX_GRAPH_DEPTH,
            max_children_per_task: MAX_CHILDREN_PER_TASK,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DagError {
    InvalidDraft,
    InvalidArtifactDigest,
    EmptyGraph,
    DuplicateTask,
    SelfDependency,
    UnknownDependency,
    GraphCycle,
    MemberLimitExceeded,
    DepthLimitExceeded,
    ChildLimitExceeded,
    InvalidLimits,
    StaleGraphRevision,
    CriteriaUncovered,
    UnknownCriterion,
    ArtifactProducerUnknown,
    ArtifactNotADependency,
    ArtifactKindNotProduced,
    WriteScopeOverlap,
    UnknownWriteScope,
    CrossRunDelivery,
    UnknownTask,
    TaskNotRunning,
    LateDeliveryConflict,
    LateDeliveryAfterCancel,
    WrongWorkerExecution,
    StaleAttempt,
    AttemptRevisionMismatch,
    BindingDigestMismatch,
    UndeclaredArtifactKind,
    MissingOutputArtifact,
    ResultArtifactMismatch,
    InvalidResultShape,
    UnreconciledUnknown,
    SelfVerification,
    VerificationRevisionMismatch,
    MissingProof,
}

/// One validated Task node as persisted by the trusted coordinator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedTaskNode {
    pub task_id: String,
    pub title: String,
    pub purpose: String,
    pub dependencies: Vec<String>,
    pub criterion_ids: Vec<String>,
    pub input_artifacts: Vec<ArtifactRequirementV1>,
    pub output_artifact_kinds: Vec<String>,
    pub read_scopes: Vec<String>,
    pub write_scopes: Vec<String>,
    pub read_only: bool,
    pub requires_tools: Vec<String>,
    pub requested_profile: String,
    pub estimated_usage: EstimatedUsage,
    pub depth: u32,
}

/// A bounded graph that passed every admission check. The `graph_revision`
/// covers the canonical node/edge content so downstream consumers can detect
/// an out-of-date proposal before persisting it.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedTaskGraph {
    run_id: String,
    accepted_spec_digest: String,
    parent_scope_digest: String,
    graph_revision: String,
    accepted_criteria: Vec<String>,
    criteria_deferred: bool,
    uncovered_criteria: Vec<String>,
    nodes: BTreeMap<String, ValidatedTaskNode>,
    topological_order: Vec<String>,
}

impl ValidatedTaskGraph {
    /// Compiles one `TaskProposalV1` into a validated graph. Every rejection is
    /// returned before anything could be persisted; this function performs no
    /// side effect.
    pub fn compile(
        proposal: TaskProposalV1,
        binding: GraphBinding,
        limits: DagLimits,
    ) -> Result<Self, DagError> {
        if limits.max_members == 0
            || limits.max_members > MAX_GRAPH_MEMBERS
            || limits.max_depth == 0
            || limits.max_depth > MAX_GRAPH_DEPTH
            || limits.max_children_per_task == 0
            || limits.max_children_per_task > MAX_CHILDREN_PER_TASK
        {
            return Err(DagError::InvalidLimits);
        }
        validate_id("run ID", &proposal.run_id)?;
        validate_id("expected graph revision", &proposal.expected_graph_revision)?;
        validate_id("base graph revision", &proposal.base_graph_revision)?;
        if proposal.expected_graph_revision != proposal.base_graph_revision {
            return Err(DagError::StaleGraphRevision);
        }
        digest("accepted SpecVersion digest", &binding.accepted_spec_digest)?;
        digest("parent scope digest", &binding.parent_scope_digest)?;
        if proposal.tasks.is_empty() {
            return Err(DagError::EmptyGraph);
        }
        if proposal.tasks.len() > limits.max_members {
            return Err(DagError::MemberLimitExceeded);
        }
        if proposal.accepted_criteria.len() > MAX_ACCEPTED_CRITERIA {
            return Err(DagError::InvalidDraft);
        }
        let accepted_criteria: Vec<String> = proposal
            .accepted_criteria
            .iter()
            .cloned()
            .collect::<BTreeSet<_>>()
            .into_iter()
            .collect();
        if accepted_criteria.len() != proposal.accepted_criteria.len() {
            return Err(DagError::InvalidDraft);
        }
        for criterion in &accepted_criteria {
            validate_id("criterion ID", criterion)?;
        }

        let mut nodes: BTreeMap<String, ValidatedTaskNode> = BTreeMap::new();
        for draft in &proposal.tasks {
            validate_draft(draft, &accepted_criteria)?;
            if nodes.contains_key(&draft.task_id) {
                return Err(DagError::DuplicateTask);
            }
            let mut dependencies = draft.dependencies.clone();
            dependencies.sort();
            dependencies.dedup();
            if dependencies.len() != draft.dependencies.len() {
                return Err(DagError::InvalidDraft);
            }
            let mut criterion_ids = draft.criterion_ids.clone();
            criterion_ids.sort();
            criterion_ids.dedup();
            if criterion_ids.len() != draft.criterion_ids.len() {
                return Err(DagError::InvalidDraft);
            }
            let mut output_artifact_kinds = draft.output_artifact_kinds.clone();
            output_artifact_kinds.sort();
            output_artifact_kinds.dedup();
            if output_artifact_kinds.len() != draft.output_artifact_kinds.len() {
                return Err(DagError::InvalidDraft);
            }
            nodes.insert(
                draft.task_id.clone(),
                ValidatedTaskNode {
                    task_id: draft.task_id.clone(),
                    title: draft.title.clone(),
                    purpose: draft.purpose.clone(),
                    dependencies,
                    criterion_ids,
                    input_artifacts: draft.input_artifacts.clone(),
                    output_artifact_kinds,
                    read_scopes: draft.read_scopes.clone(),
                    write_scopes: draft.write_scopes.clone(),
                    read_only: draft.read_only,
                    requires_tools: draft.requires_tools.clone(),
                    requested_profile: draft.requested_profile.clone(),
                    estimated_usage: draft.estimated_usage,
                    depth: 0,
                },
            );
        }

        for node in nodes.values() {
            if node.dependencies.iter().any(|dep| dep == &node.task_id) {
                return Err(DagError::SelfDependency);
            }
            if node.dependencies.iter().any(|dep| !nodes.contains_key(dep)) {
                return Err(DagError::UnknownDependency);
            }
            if node.dependencies.len() > limits.max_children_per_task {
                return Err(DagError::ChildLimitExceeded);
            }
            for requirement in &node.input_artifacts {
                if !node.dependencies.contains(&requirement.from_task) {
                    return Err(DagError::ArtifactNotADependency);
                }
                let Some(producer) = nodes.get(&requirement.from_task) else {
                    return Err(DagError::ArtifactProducerUnknown);
                };
                if !producer.output_artifact_kinds.contains(&requirement.kind) {
                    return Err(DagError::ArtifactKindNotProduced);
                }
            }
        }

        let topological_order = topological_order(&nodes)?;
        let depths = compute_depths(&nodes)?;
        if depths.values().any(|depth| *depth > limits.max_depth) {
            return Err(DagError::DepthLimitExceeded);
        }
        for (task_id, depth) in &depths {
            nodes
                .get_mut(task_id)
                .expect("validated node present")
                .depth = *depth;
        }

        // Parallel write scopes must be ordered by a dependency edge; unknown
        // write scopes are already rejected above as `UnknownWriteScope`.
        let task_ids: Vec<&String> = topological_order.iter().collect();
        for (left_index, left_id) in task_ids.iter().enumerate() {
            for right_id in task_ids.iter().skip(left_index + 1) {
                let left = &nodes[*left_id];
                let right = &nodes[*right_id];
                if left.read_only || right.read_only {
                    continue;
                }
                if !scopes_overlap(&left.write_scopes, &right.write_scopes) {
                    continue;
                }
                let ordered =
                    reachable(&nodes, left_id, right_id) || reachable(&nodes, right_id, left_id);
                if !ordered {
                    return Err(DagError::WriteScopeOverlap);
                }
            }
        }

        let covered: BTreeSet<&str> = nodes
            .values()
            .flat_map(|node| node.criterion_ids.iter().map(String::as_str))
            .collect();
        let uncovered_criteria: Vec<String> = accepted_criteria
            .iter()
            .filter(|criterion| !covered.contains(criterion.as_str()))
            .cloned()
            .collect();
        if !uncovered_criteria.is_empty() && !proposal.criteria_deferred {
            return Err(DagError::CriteriaUncovered);
        }

        let canonical = json!({
            "runId": proposal.run_id,
            "acceptedSpecDigest": binding.accepted_spec_digest,
            "parentScopeDigest": binding.parent_scope_digest,
            "acceptedCriteria": accepted_criteria,
            "criteriaDeferred": proposal.criteria_deferred,
            "nodes": nodes.values().map(ValidatedTaskNode::canonical_value).collect::<Vec<_>>(),
        });
        let graph_revision = format!(
            "blake3:{}",
            blake3::hash(canonical.to_string().as_bytes()).to_hex()
        );

        Ok(Self {
            run_id: proposal.run_id,
            accepted_spec_digest: binding.accepted_spec_digest,
            parent_scope_digest: binding.parent_scope_digest,
            graph_revision,
            accepted_criteria,
            criteria_deferred: proposal.criteria_deferred,
            uncovered_criteria,
            nodes,
            topological_order,
        })
    }

    pub fn run_id(&self) -> &str {
        &self.run_id
    }

    pub fn graph_revision(&self) -> &str {
        &self.graph_revision
    }

    pub fn accepted_spec_digest(&self) -> &str {
        &self.accepted_spec_digest
    }

    pub fn parent_scope_digest(&self) -> &str {
        &self.parent_scope_digest
    }

    pub fn accepted_criteria(&self) -> &[String] {
        &self.accepted_criteria
    }

    pub fn uncovered_criteria(&self) -> &[String] {
        &self.uncovered_criteria
    }

    pub fn criteria_deferred(&self) -> bool {
        self.criteria_deferred
    }

    pub fn topological_order(&self) -> &[String] {
        &self.topological_order
    }

    pub fn node(&self, task_id: &str) -> Option<&ValidatedTaskNode> {
        self.nodes.get(task_id)
    }

    /// Deterministic READY list for the coordinator's scheduler. This is a
    /// recommendation order, never a permission to dispatch: the coordinator
    /// still has to admit a single Attempt and reserve resources.
    pub fn readiness(
        &self,
        states: &BTreeMap<String, TaskRunState>,
        current_revision: &str,
    ) -> Result<Vec<String>, DagError> {
        validate_id("current revision", current_revision)?;
        let mut ready = Vec::new();
        for task_id in &self.topological_order {
            let Some(node) = self.nodes.get(task_id) else {
                continue;
            };
            let state = states.get(task_id);
            let default = TaskRunState::default();
            let state = state.unwrap_or(&default);
            if state.cancelled
                || state.unknown_effect
                || state.phase != TaskPhase::Pending
                || state.attempt_count >= state.max_attempts
            {
                continue;
            }
            let mut unblocked = true;
            for dependency in &node.dependencies {
                let dependency_state = states.get(dependency).unwrap_or(&default);
                let verified = dependency_state.phase == TaskPhase::Verified
                    && dependency_state.verified_revision.as_deref() == Some(current_revision);
                if !verified {
                    unblocked = false;
                    break;
                }
            }
            if !unblocked {
                continue;
            }
            for requirement in &node.input_artifacts {
                let producer = states.get(&requirement.from_task).unwrap_or(&default);
                let producer_node = self
                    .nodes
                    .get(&requirement.from_task)
                    .ok_or(DagError::ArtifactProducerUnknown)?;
                if !producer_node
                    .output_artifact_kinds
                    .contains(&requirement.kind)
                {
                    return Err(DagError::ArtifactKindNotProduced);
                }
                let available = producer.artifacts.iter().any(|artifact| {
                    artifact.artifact_kind == requirement.kind
                        && requirement
                            .artifact_id
                            .as_deref()
                            .is_none_or(|required| artifact.artifact_id == required)
                        && artifact.source_revision == current_revision
                });
                if !available {
                    unblocked = false;
                    break;
                }
            }
            if unblocked {
                ready.push(task_id.clone());
            }
        }
        Ok(ready)
    }

    /// Validates one child delivery against the graph and the current derived
    /// Task state. The caller applies the returned acceptance to its own
    /// durable owner; this function never mutates shared state.
    pub fn validate_delivery(
        &self,
        state: &TaskRunState,
        envelope: &DeliveryEnvelopeV1,
        result: &CandidateTaskResultV1,
    ) -> Result<DeliveryAcceptance, DagError> {
        if envelope.run_id != self.run_id {
            return Err(DagError::CrossRunDelivery);
        }
        let Some(node) = self.nodes.get(&envelope.task_id) else {
            return Err(DagError::UnknownTask);
        };
        for reference in &envelope.dependency_artifact_refs {
            validate_id("dependency artifact reference", reference)?;
        }
        envelope_digest(
            "accepted SpecVersion digest",
            &envelope.accepted_spec_digest,
        )?;
        envelope_digest("parent scope digest", &envelope.parent_scope_digest)?;
        if envelope.accepted_spec_digest != self.accepted_spec_digest
            || envelope.parent_scope_digest != self.parent_scope_digest
        {
            return Err(DagError::BindingDigestMismatch);
        }
        if result.attempt_id != envelope.attempt_id
            || result.worker_execution_id != envelope.worker_execution_id
        {
            return Err(DagError::InvalidResultShape);
        }
        if state.cancelled {
            return Err(DagError::LateDeliveryAfterCancel);
        }
        if state.phase == TaskPhase::Produced || state.phase == TaskPhase::Verified {
            return if state.attempt_id.as_deref() == Some(envelope.attempt_id.as_str())
                && state.worker_execution_id.as_deref()
                    == Some(envelope.worker_execution_id.as_str())
            {
                Ok(DeliveryAcceptance {
                    phase: state.phase,
                    unknown_effect: false,
                    artifacts: state.artifacts.clone(),
                })
            } else {
                Err(DagError::LateDeliveryConflict)
            };
        }
        if state.phase != TaskPhase::Running {
            return Err(DagError::TaskNotRunning);
        }
        if state.attempt_id.as_deref() != Some(envelope.attempt_id.as_str()) {
            return Err(DagError::LateDeliveryConflict);
        }
        if state.worker_execution_id.as_deref() != Some(envelope.worker_execution_id.as_str()) {
            return Err(DagError::WrongWorkerExecution);
        }
        if state.owner_epoch != Some(envelope.owner_epoch) {
            return Err(DagError::StaleAttempt);
        }
        if state.attempt_revision.as_deref() != Some(envelope.source_revision.as_str()) {
            return Err(DagError::AttemptRevisionMismatch);
        }
        if result.artifacts.len() > MAX_ARTIFACT_REFS
            || result.touched_files.len() > MAX_FILE_TOUCHES
            || result.tool_receipt_refs.len() > MAX_EVIDENCE_REFS
            || result.proposed_evidence_refs.len() > MAX_EVIDENCE_REFS
            || result.missing_criteria_ids.len() > MAX_CRITERIA_PER_TASK
            || result.errors.len() > MAX_ERRORS
        {
            return Err(DagError::InvalidResultShape);
        }
        let mut seen_artifacts = BTreeSet::new();
        for artifact in &result.artifacts {
            artifact.validate()?;
            if artifact.source_revision != envelope.source_revision {
                return Err(DagError::ResultArtifactMismatch);
            }
            if !node.output_artifact_kinds.contains(&artifact.artifact_kind) {
                return Err(DagError::UndeclaredArtifactKind);
            }
            if !seen_artifacts.insert((artifact.artifact_id.clone(), artifact.sha256.clone())) {
                return Err(DagError::InvalidResultShape);
            }
        }
        for file in &result.touched_files {
            validate_safe_ref("touched file", &file.path_ref)?;
            validate_id("touched file revision", &file.source_revision)?;
            if file.source_revision != envelope.source_revision {
                return Err(DagError::AttemptRevisionMismatch);
            }
        }
        for reference in result
            .tool_receipt_refs
            .iter()
            .chain(result.proposed_evidence_refs.iter())
        {
            validate_safe_ref("evidence reference", reference)?;
        }
        for criterion in &result.missing_criteria_ids {
            if !node.criterion_ids.contains(criterion) {
                return Err(DagError::UnknownCriterion);
            }
        }
        for error in &result.errors {
            validate_text("error category", &error.category, MAX_ID_LENGTH)?;
            validate_text("error message", &error.safe_message, MAX_TEXT_LENGTH)?;
        }
        match result.status {
            TaskResultStatus::Produced => {
                for kind in &node.output_artifact_kinds {
                    if !result
                        .artifacts
                        .iter()
                        .any(|artifact| &artifact.artifact_kind == kind)
                    {
                        return Err(DagError::MissingOutputArtifact);
                    }
                }
                Ok(DeliveryAcceptance {
                    phase: TaskPhase::Produced,
                    unknown_effect: false,
                    artifacts: result.artifacts.clone(),
                })
            }
            TaskResultStatus::Unknown => Ok(DeliveryAcceptance {
                phase: TaskPhase::Unknown,
                unknown_effect: true,
                artifacts: result.artifacts.clone(),
            }),
            TaskResultStatus::Failed => {
                if result.errors.is_empty() {
                    return Err(DagError::InvalidResultShape);
                }
                Ok(DeliveryAcceptance {
                    phase: TaskPhase::Failed,
                    unknown_effect: false,
                    artifacts: Vec::new(),
                })
            }
            TaskResultStatus::Blocked => {
                if result.errors.is_empty() && result.missing_criteria_ids.is_empty() {
                    return Err(DagError::InvalidResultShape);
                }
                Ok(DeliveryAcceptance {
                    phase: TaskPhase::Pending,
                    unknown_effect: false,
                    artifacts: Vec::new(),
                })
            }
        }
    }

    /// Validates a revision-bound independent verification verdict. A stale
    /// verdict, a self-approving verifier or an unreconciled UNKNOWN effect can
    /// never mark the Task verified.
    pub fn validate_verification(
        &self,
        state: &TaskRunState,
        verdict: &VerificationVerdictV1,
        current_revision: &str,
    ) -> Result<VerifiedTaskOutcome, DagError> {
        validate_id("current revision", current_revision)?;
        let Some(node) = self.nodes.get(&verdict.task_id) else {
            return Err(DagError::UnknownTask);
        };
        if state.phase != TaskPhase::Produced {
            return Err(DagError::TaskNotRunning);
        }
        if state.unknown_effect {
            return Err(DagError::UnreconciledUnknown);
        }
        if state.attempt_id.as_deref() != Some(verdict.attempt_id.as_str()) {
            return Err(DagError::LateDeliveryConflict);
        }
        if state.worker_execution_id.as_deref() == Some(verdict.verifier_id.as_str())
            || verdict.verifier_id == verdict.attempt_id
        {
            return Err(DagError::SelfVerification);
        }
        if verdict.source_revision != current_revision
            || state.attempt_revision.as_deref() != Some(current_revision)
            || verdict.source_revision != verdict.verified_revision
        {
            return Err(DagError::VerificationRevisionMismatch);
        }
        if verdict.criterion_ids.is_empty() || verdict.criterion_ids.len() > MAX_CRITERIA_PER_TASK {
            return Err(DagError::MissingProof);
        }
        for criterion in &verdict.criterion_ids {
            if !node.criterion_ids.contains(criterion) {
                return Err(DagError::UnknownCriterion);
            }
        }
        digest("verification evidence digest", &verdict.evidence_digest)?;
        let mut verified: Vec<String> = verdict.criterion_ids.clone();
        verified.sort();
        verified.dedup();
        if verified.len() != verdict.criterion_ids.len() {
            return Err(DagError::MissingProof);
        }
        let mut assigned: Vec<String> = node.criterion_ids.clone();
        assigned.sort();
        assigned.dedup();
        if verified != assigned {
            return Err(DagError::MissingProof);
        }
        Ok(VerifiedTaskOutcome {
            task_id: verdict.task_id.clone(),
            attempt_id: verdict.attempt_id.clone(),
            verifier_id: verdict.verifier_id.clone(),
            verified_revision: verdict.verified_revision.clone(),
            criterion_ids: verified,
        })
    }
}

impl ValidatedTaskNode {
    fn canonical_value(&self) -> serde_json::Value {
        json!({
            "taskId": self.task_id,
            "title": self.title,
            "purpose": self.purpose,
            "dependencies": self.dependencies,
            "criterionIds": self.criterion_ids,
            "inputArtifacts": self.input_artifacts.iter().map(|requirement| json!({
                "fromTask": requirement.from_task,
                "kind": requirement.kind,
                "artifactId": requirement.artifact_id,
            })).collect::<Vec<_>>(),
            "outputArtifactKinds": self.output_artifact_kinds,
            "readScopes": self.read_scopes,
            "writeScopes": self.write_scopes,
            "readOnly": self.read_only,
            "requiresTools": self.requires_tools,
            "requestedProfile": self.requested_profile,
            "estimatedUsage": {
                "memoryBytes": self.estimated_usage.memory_bytes,
                "tokens": self.estimated_usage.tokens,
            },
            "depth": self.depth,
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskPhase {
    Pending,
    Running,
    Produced,
    Verified,
    Failed,
    Unknown,
}

/// Derived Task state supplied by the trusted durable coordinator. This type
/// is a lossy projection used for validation; it is not a second Task store.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskRunState {
    pub phase: TaskPhase,
    pub attempt_id: Option<String>,
    pub worker_execution_id: Option<String>,
    pub owner_epoch: Option<u64>,
    pub attempt_revision: Option<String>,
    pub cancelled: bool,
    pub unknown_effect: bool,
    pub attempt_count: u16,
    pub max_attempts: u16,
    pub artifacts: Vec<ArtifactRefV1>,
    pub verified_revision: Option<String>,
    pub verifier_id: Option<String>,
}

impl Default for TaskRunState {
    fn default() -> Self {
        Self {
            phase: TaskPhase::Pending,
            attempt_id: None,
            worker_execution_id: None,
            owner_epoch: None,
            attempt_revision: None,
            cancelled: false,
            unknown_effect: false,
            attempt_count: 0,
            max_attempts: 1,
            artifacts: Vec::new(),
            verified_revision: None,
            verifier_id: None,
        }
    }
}

/// `TaskDeliveryEnvelopeV1` with only control identifiers and digests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryEnvelopeV1 {
    pub run_id: String,
    pub task_id: String,
    pub attempt_id: String,
    pub worker_execution_id: String,
    pub owner_epoch: u64,
    pub accepted_spec_digest: String,
    pub source_revision: String,
    pub parent_scope_digest: String,
    pub dependency_artifact_refs: Vec<String>,
    pub deadline_ms: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TaskResultStatus {
    Produced,
    Blocked,
    Failed,
    Unknown,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TouchedFileV1 {
    pub path_ref: String,
    pub source_revision: String,
    pub access: TouchedAccess,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TouchedAccess {
    Read,
    Write,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateErrorV1 {
    pub category: String,
    pub safe_message: String,
}

/// `CandidateTaskResultV1` — candidate evidence only; never a PASS.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateTaskResultV1 {
    pub attempt_id: String,
    pub worker_execution_id: String,
    pub status: TaskResultStatus,
    pub artifacts: Vec<ArtifactRefV1>,
    pub touched_files: Vec<TouchedFileV1>,
    pub tool_receipt_refs: Vec<String>,
    pub proposed_evidence_refs: Vec<String>,
    pub missing_criteria_ids: Vec<String>,
    pub errors: Vec<CandidateErrorV1>,
}

/// Validated outcome of one candidate delivery for the caller's state machine.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeliveryAcceptance {
    pub phase: TaskPhase,
    pub unknown_effect: bool,
    pub artifacts: Vec<ArtifactRefV1>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerificationVerdictV1 {
    pub task_id: String,
    pub attempt_id: String,
    pub verifier_id: String,
    pub source_revision: String,
    pub verified_revision: String,
    pub criterion_ids: Vec<String>,
    pub evidence_digest: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedTaskOutcome {
    pub task_id: String,
    pub attempt_id: String,
    pub verifier_id: String,
    pub verified_revision: String,
    pub criterion_ids: Vec<String>,
}

/// Applies a cancellation fence to the derived state view. The durable owner
/// records the fence separately; this helper keeps derived state consistent so
/// a late child can never look deliverable.
pub fn apply_cancel(states: &mut BTreeMap<String, TaskRunState>, task_ids: &[String]) {
    for task_id in task_ids {
        if let Some(state) = states.get_mut(task_id) {
            state.cancelled = true;
            state.phase = TaskPhase::Pending;
            state.attempt_id = None;
            state.worker_execution_id = None;
            state.attempt_revision = None;
        }
    }
}

fn validate_draft(draft: &TaskNodeDraft, accepted_criteria: &[String]) -> Result<(), DagError> {
    validate_id("task ID", &draft.task_id)?;
    validate_text("task title", &draft.title, MAX_TEXT_LENGTH)?;
    validate_text("task purpose", &draft.purpose, MAX_TEXT_LENGTH)?;
    validate_id("requested profile", &draft.requested_profile)?;
    if draft.dependencies.len() > MAX_SCOPES
        || draft.criterion_ids.len() > MAX_CRITERIA_PER_TASK
        || draft.input_artifacts.len() > MAX_ARTIFACT_REFS
        || draft.output_artifact_kinds.len() > MAX_ARTIFACT_REFS
        || draft.read_scopes.len() > MAX_SCOPES
        || draft.write_scopes.len() > MAX_SCOPES
        || draft.requires_tools.len() > MAX_SCOPES
    {
        return Err(DagError::InvalidDraft);
    }
    for criterion in &draft.criterion_ids {
        if !accepted_criteria.contains(criterion) {
            return Err(DagError::UnknownCriterion);
        }
    }
    for dependency in &draft.dependencies {
        validate_id("dependency task ID", dependency)?;
    }
    for requirement in &draft.input_artifacts {
        validate_id("artifact producer task ID", &requirement.from_task)?;
        validate_id("artifact kind", &requirement.kind)?;
        if let Some(artifact_id) = &requirement.artifact_id {
            validate_id("artifact ID", artifact_id)?;
        }
    }
    for kind in &draft.output_artifact_kinds {
        validate_id("artifact kind", kind)?;
    }
    for scope in draft.read_scopes.iter().chain(draft.write_scopes.iter()) {
        validate_safe_ref("scope", scope)?;
    }
    for tool in &draft.requires_tools {
        validate_id("tool reference", tool)?;
    }
    if draft.read_only && !draft.write_scopes.is_empty() {
        return Err(DagError::InvalidDraft);
    }
    if !draft.read_only && draft.write_scopes.is_empty() {
        // Unknown write scopes must not be treated as parallel-safe.
        return Err(DagError::UnknownWriteScope);
    }
    if draft
        .estimated_usage
        .memory_bytes
        .is_some_and(|bytes| bytes == 0)
        || draft
            .estimated_usage
            .tokens
            .is_some_and(|tokens| tokens == 0)
    {
        return Err(DagError::InvalidDraft);
    }
    Ok(())
}

fn topological_order(nodes: &BTreeMap<String, ValidatedTaskNode>) -> Result<Vec<String>, DagError> {
    // Iterative DFS with explicit colors so a large-but-bounded graph cannot
    // overflow the stack. `Gray` marks the active recursion path.
    #[derive(Clone, Copy, PartialEq)]
    enum Color {
        White,
        Gray,
        Black,
    }
    let mut colors: BTreeMap<&str, Color> = nodes
        .keys()
        .map(|task_id| (task_id.as_str(), Color::White))
        .collect();
    let mut order = Vec::new();
    for root in nodes.keys() {
        if colors[root.as_str()] == Color::Black {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(root.as_str(), 0)];
        colors.insert(root.as_str(), Color::Gray);
        while let Some((task_id, next_index)) = stack.last_mut() {
            let node = nodes.get(*task_id).expect("stack holds validated nodes");
            if *next_index < node.dependencies.len() {
                let dependency = node.dependencies[*next_index].as_str();
                *next_index += 1;
                match colors.get(dependency).copied() {
                    Some(Color::White) => {
                        colors.insert(dependency, Color::Gray);
                        stack.push((dependency, 0));
                    }
                    Some(Color::Gray) => return Err(DagError::GraphCycle),
                    _ => {}
                }
            } else {
                let finished = *task_id;
                colors.insert(finished, Color::Black);
                order.push(finished.to_owned());
                stack.pop();
            }
        }
    }
    // DFS post-order is a valid deterministic topological order for a DAG.
    Ok(order)
}

fn compute_depths(
    nodes: &BTreeMap<String, ValidatedTaskNode>,
) -> Result<BTreeMap<String, u32>, DagError> {
    let order = topological_order(nodes)?;
    let mut depths: BTreeMap<String, u32> = BTreeMap::new();
    for task_id in &order {
        let node = nodes.get(task_id).expect("order covers validated nodes");
        let depth = node
            .dependencies
            .iter()
            .map(|dependency| {
                depths
                    .get(dependency)
                    .copied()
                    .unwrap_or(0)
                    .saturating_add(1)
            })
            .max()
            .unwrap_or(0);
        depths.insert(task_id.clone(), depth);
    }
    Ok(depths)
}

fn reachable(nodes: &BTreeMap<String, ValidatedTaskNode>, from: &str, to: &str) -> bool {
    let mut stack = vec![from.to_owned()];
    let mut visited = BTreeSet::new();
    while let Some(current) = stack.pop() {
        if !visited.insert(current.clone()) {
            continue;
        }
        if current == to {
            return true;
        }
        if let Some(node) = nodes.get(&current) {
            stack.extend(node.dependencies.iter().cloned());
        }
    }
    false
}

fn scopes_overlap(left: &[String], right: &[String]) -> bool {
    left.iter().any(|left_scope| {
        right.iter().any(|right_scope| {
            scope_contains(left_scope, right_scope) || scope_contains(right_scope, left_scope)
        })
    })
}

fn scope_contains(prefix: &str, candidate: &str) -> bool {
    if prefix == candidate {
        return true;
    }
    let prefix = prefix.strip_suffix("/**").unwrap_or(prefix);
    candidate == prefix
        || candidate
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}

fn validate_id(_label: &str, value: &str) -> Result<(), DagError> {
    if value.is_empty() || value.len() > MAX_ID_LENGTH || !value.is_ascii() {
        return Err(DagError::InvalidDraft);
    }
    if value
        .bytes()
        .any(|byte| byte.is_ascii_control() || byte == b'/' || byte == b'\\')
    {
        return Err(DagError::InvalidDraft);
    }
    Ok(())
}

fn validate_text(_label: &str, value: &str, limit: usize) -> Result<(), DagError> {
    if value.trim().is_empty() || value.len() > limit {
        return Err(DagError::InvalidDraft);
    }
    Ok(())
}

fn validate_safe_ref(_label: &str, value: &str) -> Result<(), DagError> {
    if value.is_empty() || value.len() > MAX_REF_LENGTH || value.chars().any(char::is_control) {
        return Err(DagError::InvalidDraft);
    }
    Ok(())
}

fn digest(_label: &str, value: &str) -> Result<(), DagError> {
    envelope_digest(_label, value)
}

fn envelope_digest(_label: &str, value: &str) -> Result<(), DagError> {
    let Some(hex) = value.strip_prefix("blake3:") else {
        return Err(DagError::InvalidDraft);
    };
    if hex.len() != 64 || !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err(DagError::InvalidDraft);
    }
    Ok(())
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest_of(seed: char) -> String {
        format!("blake3:{}", seed.to_string().repeat(64))
    }

    fn binding() -> GraphBinding {
        GraphBinding {
            accepted_spec_digest: digest_of('a'),
            parent_scope_digest: digest_of('b'),
        }
    }

    fn draft(task_id: &str) -> TaskNodeDraft {
        TaskNodeDraft {
            task_id: task_id.to_owned(),
            title: format!("task {task_id}"),
            purpose: "bounded unit of work".to_owned(),
            dependencies: Vec::new(),
            criterion_ids: vec!["crit-1".to_owned()],
            input_artifacts: Vec::new(),
            output_artifact_kinds: Vec::new(),
            read_scopes: Vec::new(),
            write_scopes: vec!["src/**".to_owned()],
            read_only: false,
            requires_tools: Vec::new(),
            requested_profile: "builder".to_owned(),
            estimated_usage: EstimatedUsage::default(),
        }
    }

    fn proposal(tasks: Vec<TaskNodeDraft>) -> TaskProposalV1 {
        TaskProposalV1 {
            run_id: "run-1".to_owned(),
            expected_graph_revision: "rev-1".to_owned(),
            base_graph_revision: "rev-1".to_owned(),
            accepted_criteria: vec!["crit-1".to_owned()],
            criteria_deferred: false,
            tasks,
        }
    }

    #[test]
    fn compile_rejects_cycles_before_any_persistable_graph_exists() {
        let mut first = draft("task-a");
        first.dependencies = vec!["task-b".to_owned()];
        let mut second = draft("task-b");
        second.dependencies = vec!["task-a".to_owned()];
        assert_eq!(
            ValidatedTaskGraph::compile(
                proposal(vec![first, second]),
                binding(),
                DagLimits::default()
            ),
            Err(DagError::GraphCycle)
        );
    }

    #[test]
    fn compile_rejects_self_edges_and_unknown_dependencies() {
        let mut self_edge = draft("task-a");
        self_edge.dependencies = vec!["task-a".to_owned()];
        assert_eq!(
            ValidatedTaskGraph::compile(proposal(vec![self_edge]), binding(), DagLimits::default()),
            Err(DagError::SelfDependency)
        );
        let mut unknown = draft("task-a");
        unknown.dependencies = vec!["task-missing".to_owned()];
        assert_eq!(
            ValidatedTaskGraph::compile(proposal(vec![unknown]), binding(), DagLimits::default()),
            Err(DagError::UnknownDependency)
        );
    }

    #[test]
    fn compile_binds_artifact_edges_to_declared_producers() {
        let mut producer = draft("task-producer");
        producer.write_scopes = vec!["src/out/**".to_owned()];
        producer.output_artifact_kinds = vec!["patch".to_owned()];
        let mut consumer = draft("task-consumer");
        consumer.dependencies = vec!["task-producer".to_owned()];
        consumer.input_artifacts = vec![ArtifactRequirementV1 {
            from_task: "task-producer".to_owned(),
            kind: "patch".to_owned(),
            artifact_id: None,
        }];
        consumer.write_scopes = vec!["src/in/**".to_owned()];
        let graph = ValidatedTaskGraph::compile(
            proposal(vec![producer, consumer]),
            binding(),
            DagLimits::default(),
        )
        .expect("typed artifact edge is admitted");
        assert_eq!(
            graph.topological_order(),
            &["task-producer", "task-consumer"]
        );
    }
}
