//! The policy engine (`CMP-guard`, `ARCH/12-GUARD.md`).
//!
//! Guard answers one question for every effectful action: *may this run now?*
//! Ordered rules evaluate find-last-wins with a non-overridable outer deny
//! ceiling and a fail-closed default. It also owns the plan/act/yolo mode
//! ceiling, the irreducible catastrophic gate, scoped TTL'd tickets, and the
//! persisted "always allow" memory.

use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde_json::Value;

use crate::approval::SavedRule;
use crate::catastrophic::catastrophic;
use crate::config::{global_config_path, load_layer, parse_document, project_config_paths};
use crate::decision::{GuardDecision, GuardMode};
use crate::error::GuardError;
use crate::rule::{Effect, Rule, RuleLayer, RuleSource, combine_effects};
use crate::ticket::{DEFAULT_TTL_MS, Ticket, TicketStore, now_ms};

/// A request to authorize one effect.
#[derive(Clone, Debug, PartialEq)]
pub struct GuardRequest {
    /// The canonical capability action.
    pub action: String,
    /// The concrete resources the effect will touch.
    pub resources: Vec<String>,
    /// The owning session.
    pub session_id: String,
    /// The tool call id, tying approvals and audit to the exact call.
    pub source: String,
    /// The advertised tool name.
    pub tool: String,
    /// Non-secret context for the approval surface.
    pub metadata: Value,
}

impl GuardRequest {
    /// Builds a request with only an action and resources.
    #[must_use]
    pub fn new(action: impl Into<String>, resources: Vec<String>) -> Self {
        Self {
            action: action.into(),
            resources,
            session_id: String::new(),
            source: String::new(),
            tool: String::new(),
            metadata: Value::Null,
        }
    }
}

/// The guard engine; cheap to clone (it shares one inner value).
#[derive(Clone)]
pub struct Guard {
    inner: Arc<GuardInner>,
}

struct GuardInner {
    layers: Vec<RuleLayer>,
    ceiling: Vec<Rule>,
    mode: GuardMode,
    unmatched: Effect,
    approval_timeout_ms: u64,
    degraded: Option<String>,
    saved: Mutex<Vec<Rule>>,
    tickets: TicketStore,
    policy_hash: String,
    saved_path: Option<PathBuf>,
}

impl std::fmt::Debug for Guard {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Guard")
            .field("mode", &self.inner.mode)
            .field("unmatched", &self.inner.unmatched)
            .field("layers", &self.inner.layers.len())
            .field("policy_hash", &self.inner.policy_hash)
            .field("degraded", &self.inner.degraded)
            .finish_non_exhaustive()
    }
}

impl Guard {
    /// Builds a guard from an explicit session-level rule set.
    #[must_use]
    pub fn from_rules(rules: Vec<Rule>, mode: GuardMode, unmatched: Effect) -> Self {
        GuardBuilder::new()
            .discover_global(false)
            .with_mode(mode)
            .with_unmatched(unmatched)
            .with_session_rules(rules)
            .build()
    }

    /// Starts a builder.
    #[must_use]
    pub fn builder() -> GuardBuilder {
        GuardBuilder::new()
    }

    /// Returns the active mode.
    #[must_use]
    pub fn mode(&self) -> GuardMode {
        self.inner.mode
    }

    /// Returns the configured fallback for unmatched actions.
    #[must_use]
    pub fn unmatched(&self) -> Effect {
        self.inner.unmatched
    }

    /// Returns a stable fingerprint of the effective policy.
    #[must_use]
    pub fn policy_hash(&self) -> &str {
        &self.inner.policy_hash
    }

    /// Returns the load-failure reason when config was rejected fail-closed.
    #[must_use]
    pub fn degraded(&self) -> Option<&str> {
        self.inner.degraded.as_deref()
    }

    /// Returns the effective rule layers (discovered + synthetic).
    #[must_use]
    pub fn layers(&self) -> &[RuleLayer] {
        &self.inner.layers
    }

    /// Serializes the effective ruleset snapshot recorded with a session
    /// (`REQ-SESS-004`).
    #[must_use]
    pub fn snapshot(&self) -> Value {
        let rules: Vec<Value> = self
            .effective_rules()
            .iter()
            .map(|rule| {
                serde_json::json!({
                    "action": rule.action,
                    "resource": rule.resource,
                    "effect": rule.effect.as_str(),
                })
            })
            .collect();
        serde_json::json!({
            "mode": self.inner.mode.as_str(),
            "unmatched": self.inner.unmatched.as_str(),
            "policy_hash": self.inner.policy_hash,
            "degraded": self.inner.degraded,
            "rules": rules,
        })
    }

    /// Evaluates an action against the merged rule set.
    #[must_use]
    pub fn evaluate(&self, action: &str, resources: &[String]) -> GuardDecision {
        if let Some(reason) = &self.inner.degraded {
            return GuardDecision::deny(format!(
                "guard policy failed to load; failing closed: {reason}"
            ));
        }
        let action = canonical_action(action);
        // A resource-less action (for example `list` or `todo`) is a
        // whole-action check; evaluate it against the wildcard resource so a
        // rule that allows the action for `**` applies.
        let wildcard = [String::from("**")];
        let resources: &[String] = if resources.is_empty() {
            &wildcard
        } else {
            resources
        };
        if self.inner.mode == GuardMode::Plan && is_mutating(action) {
            return GuardDecision::deny(format!("plan mode blocks the mutating action `{action}`"));
        }
        if let Some(reason) = catastrophic(action, resources) {
            return GuardDecision::deny(reason);
        }
        for rule in &self.inner.ceiling {
            if resources
                .iter()
                .any(|resource| rule.matches(action, resource).unwrap_or(false))
            {
                return GuardDecision::deny(format!(
                    "denied by the non-overridable `{action}` deny ceiling"
                ));
            }
        }
        let rules = self.effective_rules();
        let mut effects = Vec::with_capacity(resources.len());
        for resource in resources {
            let last = rules
                .iter()
                .rev()
                .find(|rule| rule.matches(action, resource).unwrap_or(false));
            effects.push(last.map_or(self.inner.unmatched, |rule| rule.effect));
        }
        let combined = combine_effects(&effects).unwrap_or(self.inner.unmatched);
        match combined {
            Effect::Deny => GuardDecision::deny(format!("action `{action}` is denied by policy")),
            Effect::Ask => {
                if self.inner.mode == GuardMode::Yolo {
                    GuardDecision::Allow
                } else {
                    GuardDecision::Ask
                }
            }
            Effect::Allow => GuardDecision::Allow,
        }
    }

    /// Evaluates a request.
    #[must_use]
    pub fn check(&self, request: &GuardRequest) -> GuardDecision {
        self.evaluate(&request.action, &request.resources)
    }

    /// Issues a ticket after an allow decision.
    #[must_use]
    pub fn issue_ticket(&self, request: &GuardRequest, approval_ref: Option<String>) -> Ticket {
        let scope = if request.resources.is_empty() {
            vec!["**".to_owned()]
        } else {
            request.resources.clone()
        };
        let ttl = self.inner.approval_timeout_ms.max(DEFAULT_TTL_MS);
        let ticket = Ticket {
            id: format!("tkt_{}", uuid::Uuid::now_v7().simple()),
            action: canonical_action(&request.action).to_owned(),
            scope,
            uses: u32::MAX,
            single_use: false,
            expires_at_ms: now_ms().saturating_add(ttl),
            policy_hash: self.inner.policy_hash.clone(),
            approval_ref,
        };
        self.inner.tickets.issue(ticket)
    }

    /// Validates a ticket for an action and resource, consuming a use when the
    /// ticket is single-use.
    ///
    /// # Errors
    /// Returns [`GuardError::InvalidTicket`] on any failure.
    pub fn validate_ticket(
        &self,
        ticket_id: &str,
        action: &str,
        resource: &str,
    ) -> Result<Ticket, GuardError> {
        self.inner
            .tickets
            .validate(ticket_id, canonical_action(action), resource)
    }

    /// Issues a single-use ticket with a bounded TTL.
    #[must_use]
    pub fn issue_single_use(&self, action: &str, resources: Vec<String>, ttl_ms: u64) -> Ticket {
        let scope = if resources.is_empty() {
            vec!["**".to_owned()]
        } else {
            resources
        };
        let ticket = Ticket {
            id: format!("tkt_{}", uuid::Uuid::now_v7().simple()),
            action: canonical_action(action).to_owned(),
            scope,
            uses: 1,
            single_use: true,
            expires_at_ms: now_ms().saturating_add(ttl_ms),
            policy_hash: self.inner.policy_hash.clone(),
            approval_ref: None,
        };
        self.inner.tickets.issue(ticket)
    }

    /// Revokes one ticket.
    pub fn revoke_ticket(&self, ticket_id: &str) -> bool {
        self.inner.tickets.revoke(ticket_id)
    }

    /// Revokes every ticket (for example when a provider restarts).
    pub fn revoke_all_tickets(&self) {
        self.inner.tickets.revoke_all();
    }

    /// Returns the number of live tickets.
    #[must_use]
    pub fn live_tickets(&self) -> usize {
        self.inner.tickets.len()
    }

    /// Returns whether an action is denied in every resource context, used for
    /// tool materialization (`REQ-TOOL-003`).
    #[must_use]
    pub fn wholly_denied(&self, action: &str) -> bool {
        matches!(
            self.evaluate(action, &[String::from("**")]),
            GuardDecision::Deny { .. }
        )
    }

    /// Materializes the set of canonical actions denied in every resource
    /// context, used by the tool registry to remove denied tool definitions.
    #[must_use]
    pub fn materialize_filter(&self) -> BTreeSet<String> {
        KNOWN_TOOL_ACTIONS
            .iter()
            .map(|action| canonical_action(action).to_owned())
            .filter(|action| self.wholly_denied(action))
            .collect()
    }

    /// Persists an "always allow" rule. The rule takes effect immediately and is
    /// written to the saved-rule store when one is configured.
    ///
    /// # Errors
    /// Returns [`GuardError`] when the pattern is malformed or the store cannot
    /// be written.
    pub fn persist_saved_rule(
        &self,
        action: &str,
        resource: &str,
    ) -> Result<SavedRule, GuardError> {
        Rule::new(action, resource, Effect::Allow).validate()?;
        let mut saved = self
            .inner
            .saved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let rule = Rule::new(action, resource, Effect::Allow);
        if !saved
            .iter()
            .any(|existing| existing.action == rule.action && existing.resource == rule.resource)
        {
            saved.push(rule);
        }
        self.write_saved(&saved)?;
        Ok(SavedRule::new(action, resource))
    }

    /// Returns the saved rules currently in force.
    #[must_use]
    pub fn saved_rules(&self) -> Vec<SavedRule> {
        self.inner
            .saved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .map(|rule| SavedRule::new(rule.action.clone(), rule.resource.clone()))
            .collect()
    }

    fn effective_rules(&self) -> Vec<Rule> {
        let mut rules = Vec::new();
        for layer in &self.inner.layers {
            rules.extend(layer.rules.iter().cloned());
        }
        let saved = self
            .inner
            .saved
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        rules.extend(saved.iter().cloned());
        rules
    }

    fn write_saved(&self, rules: &[Rule]) -> Result<(), GuardError> {
        let Some(path) = &self.inner.saved_path else {
            return Ok(());
        };
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|error| GuardError::Persist(error.to_string()))?;
        }
        let value: Vec<Value> = rules
            .iter()
            .map(|rule| {
                serde_json::json!({
                    "action": rule.action,
                    "resource": rule.resource,
                    "effect": rule.effect.as_str(),
                })
            })
            .collect();
        let text = serde_json::to_string_pretty(&value)
            .map_err(|error| GuardError::Persist(error.to_string()))?;
        std::fs::write(path, text).map_err(|error| GuardError::Persist(error.to_string()))
    }
}

/// Tool actions whose whole-action denial removes the tool definition.
const KNOWN_TOOL_ACTIONS: &[&str] = &[
    "read",
    "glob",
    "grep",
    "list",
    "write",
    "edit",
    "apply_patch",
    "bash",
    "todo",
    "question",
    "webfetch",
    "websearch",
];

/// Maps a tool action onto a canonical capability action.
#[must_use]
pub fn canonical_action(action: &str) -> &str {
    match action {
        "read" | "list" | "glob" | "grep" => "fs.read",
        "write" | "edit" | "apply_patch" => "fs.write",
        "delete" => "fs.delete",
        "move" => "fs.move",
        "bash" | "shell" | "exec" => "exec.run",
        "webfetch" | "websearch" | "fetch" => "net.connect",
        "todo" | "todowrite" => "todo",
        "question" => "question",
        other => other,
    }
}

/// Returns whether a canonical action mutates state and is therefore blocked in
/// plan mode.
#[must_use]
pub fn is_mutating(action: &str) -> bool {
    matches!(
        canonical_action(action),
        "fs.write"
            | "fs.delete"
            | "fs.move"
            | "exec.run"
            | "net.connect"
            | "mcp.call"
            | "skill.install"
    )
}

/// Builds a guard by discovering config and merging explicit overrides.
pub struct GuardBuilder {
    workspace: Option<PathBuf>,
    global_config: Option<PathBuf>,
    discover_global: bool,
    default_rules: Vec<Rule>,
    agent_rules: Vec<Rule>,
    session_rules: Vec<Rule>,
    mode: Option<GuardMode>,
    unmatched: Option<Effect>,
    approval_timeout_ms: u64,
    saved_path: Option<PathBuf>,
}

impl std::fmt::Debug for GuardBuilder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("GuardBuilder")
            .field("workspace", &self.workspace)
            .field("mode", &self.mode)
            .field("unmatched", &self.unmatched)
            .finish_non_exhaustive()
    }
}

impl Default for GuardBuilder {
    fn default() -> Self {
        Self::new()
    }
}

impl GuardBuilder {
    /// Builds an empty builder with fail-closed defaults.
    #[must_use]
    pub fn new() -> Self {
        Self {
            workspace: None,
            global_config: None,
            discover_global: true,
            default_rules: Vec::new(),
            agent_rules: Vec::new(),
            session_rules: Vec::new(),
            mode: None,
            unmatched: None,
            approval_timeout_ms: DEFAULT_TTL_MS,
            saved_path: None,
        }
    }

    /// Sets the workspace used for the project config walk.
    #[must_use]
    pub fn with_workspace(mut self, workspace: impl Into<PathBuf>) -> Self {
        self.workspace = Some(workspace.into());
        self
    }

    /// Sets an explicit global config path, disabling the default lookup.
    #[must_use]
    pub fn with_global_config(mut self, path: impl Into<PathBuf>) -> Self {
        self.global_config = Some(path.into());
        self.discover_global = false;
        self
    }

    /// Enables or disables default global-config discovery.
    #[must_use]
    pub fn discover_global(mut self, discover: bool) -> Self {
        self.discover_global = discover;
        self
    }

    /// Sets the default (lowest-precedence) rules.
    #[must_use]
    pub fn with_default_rules(mut self, rules: Vec<Rule>) -> Self {
        self.default_rules = rules;
        self
    }

    /// Sets agent-level override rules.
    #[must_use]
    pub fn with_agent_rules(mut self, rules: Vec<Rule>) -> Self {
        self.agent_rules = rules;
        self
    }

    /// Sets ephemeral session override rules.
    #[must_use]
    pub fn with_session_rules(mut self, rules: Vec<Rule>) -> Self {
        self.session_rules = rules;
        self
    }

    /// Sets the interaction mode, overriding any discovered document.
    #[must_use]
    pub fn with_mode(mut self, mode: GuardMode) -> Self {
        self.mode = Some(mode);
        self
    }

    /// Sets the unmatched-action effect, overriding any discovered document.
    #[must_use]
    pub fn with_unmatched(mut self, effect: Effect) -> Self {
        self.unmatched = Some(effect);
        self
    }

    /// Sets the ticket/approval TTL in milliseconds.
    #[must_use]
    pub fn with_approval_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.approval_timeout_ms = timeout_ms;
        self
    }

    /// Sets the project-scoped saved-rule store path.
    #[must_use]
    pub fn with_saved_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.saved_path = Some(path.into());
        self
    }

    /// Builds the guard, discovering config and installing the deny ceiling.
    #[must_use]
    pub fn build(self) -> Guard {
        let mut layers: Vec<RuleLayer> = Vec::new();
        let mut ceiling: Vec<Rule> = Vec::new();
        let mut degraded: Option<String> = None;
        let mut mode = self.mode.unwrap_or(GuardMode::Act);
        let mut unmatched = self.unmatched.unwrap_or(Effect::Deny);

        if !self.default_rules.is_empty() {
            push_layer(
                &mut layers,
                &mut ceiling,
                RuleLayer::new(RuleSource::Global, self.default_rules),
            );
        }

        let global_path = self
            .global_config
            .clone()
            .or_else(|| self.discover_global.then(global_config_path).flatten());
        if let Some(path) = global_path
            && path.is_file()
        {
            match load_layer(&path, RuleSource::Global) {
                Ok(layer) => push_layer(&mut layers, &mut ceiling, layer),
                Err(error) => {
                    ceiling.push(deny_all());
                    degraded.get_or_insert_with(|| error.to_string());
                }
            }
        }

        if let Some(workspace) = &self.workspace {
            for path in project_config_paths(workspace) {
                match load_layer(&path, RuleSource::Project) {
                    Ok(layer) => {
                        if self.mode.is_none()
                            && let Some(document_mode) = document_mode(&path)
                        {
                            mode = document_mode;
                        }
                        if self.unmatched.is_none()
                            && let Some(document_unmatched) = document_unmatched(&path)
                        {
                            unmatched = document_unmatched;
                        }
                        push_layer(&mut layers, &mut ceiling, layer);
                    }
                    Err(error) => {
                        ceiling.push(deny_all());
                        degraded.get_or_insert_with(|| error.to_string());
                    }
                }
            }
        }

        if !self.agent_rules.is_empty() {
            layers.push(RuleLayer::new(RuleSource::Agent, self.agent_rules));
        }
        if !self.session_rules.is_empty() {
            layers.push(RuleLayer::new(RuleSource::Session, self.session_rules));
        }
        if unmatched == Effect::Allow {
            unmatched = Effect::Deny;
        }

        let policy_hash = compute_policy_hash(&layers, &ceiling, mode, unmatched);
        Guard {
            inner: Arc::new(GuardInner {
                layers,
                ceiling,
                mode,
                unmatched,
                approval_timeout_ms: self.approval_timeout_ms,
                degraded,
                saved: Mutex::new(Vec::new()),
                tickets: TicketStore::new(),
                policy_hash,
                saved_path: self.saved_path,
            }),
        }
    }
}

fn document_mode(path: &std::path::Path) -> Option<GuardMode> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_document(&text, &path.display().to_string()).ok())
        .and_then(|document| document.mode)
}

fn document_unmatched(path: &std::path::Path) -> Option<Effect> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|text| parse_document(&text, &path.display().to_string()).ok())
        .and_then(|document| document.unmatched)
}

fn deny_all() -> Rule {
    Rule::new("**", "**", Effect::Deny)
}

fn push_layer(layers: &mut Vec<RuleLayer>, ceiling: &mut Vec<Rule>, layer: RuleLayer) {
    if matches!(layer.source, RuleSource::Global | RuleSource::Project) {
        for rule in &layer.rules {
            if rule.effect == Effect::Deny {
                ceiling.push(rule.clone());
            }
        }
    }
    layers.push(layer);
}

/// Computes the policy fingerprint recorded on every session, ticket, and
/// audit entry.
///
/// The digest is **BLAKE3 over an explicit canonical byte form** — the same
/// primitive and the same canonicalization discipline the audit chain uses
/// (`ARCH/14-AUDIT.md` §Data / state model). It is deliberately *not*
/// `std::collections::hash_map::DefaultHasher`: that is a 64-bit,
/// SipHash-1-3-keyed, **not cryptographically stable across releases** hash
/// whose output changes whenever the standard library's hashing internals
/// change. A policy hash that is quoted into an audit chain must be stable
/// forever, and an attacker must not be able to find two different policies
/// that collide. `agentx-audit` is the owner of that digest, so it is reused
/// rather than reimplemented.
fn compute_policy_hash(
    layers: &[RuleLayer],
    ceiling: &[Rule],
    mode: GuardMode,
    unmatched: Effect,
) -> String {
    // A stable domain tag keeps a policy fingerprint from colliding with any
    // other blake3 value in the same system.
    let mut hasher = blake3::Hasher::new();
    hasher.update(POLICY_HASH_LABEL);
    // Length-prefixed framing: no two distinct field sequences can produce the
    // same byte stream, so "fs.write" + "x" cannot be read as "fs.writex" + "".
    let field = |hasher: &mut blake3::Hasher, value: &str| {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    };
    field(&mut hasher, mode.as_str());
    field(&mut hasher, unmatched.as_str());
    hasher.update(&(layers.len() as u64).to_be_bytes());
    for layer in layers {
        field(&mut hasher, layer.source.as_str());
        hasher.update(&(layer.rules.len() as u64).to_be_bytes());
        for rule in &layer.rules {
            field(&mut hasher, &rule.action);
            field(&mut hasher, &rule.resource);
            field(&mut hasher, rule.effect.as_str());
        }
    }
    hasher.update(&(ceiling.len() as u64).to_be_bytes());
    for rule in ceiling {
        field(&mut hasher, &rule.action);
        field(&mut hasher, &rule.resource);
        field(&mut hasher, rule.effect.as_str());
    }
    format!("ph_{}", hasher.finalize().to_hex())
}

/// The domain label hashed ahead of a policy fingerprint.
const POLICY_HASH_LABEL: &[u8] = b"agentx/guard/policy/v1";
