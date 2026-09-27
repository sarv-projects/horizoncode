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
use crate::config::{GuardDocument, global_config_path, load_document, project_config_paths};
use crate::decision::{GuardDecision, GuardMode};
use crate::error::GuardError;
use crate::rule::{Effect, Rule, RuleLayer, RuleSource, combine_effects};
use crate::ticket::{DEFAULT_TTL_MS, Ticket, TicketStore, now_ms};

/// One `(action, resources)` pair inside a request.
///
/// A single effect can name more than one action domain: a shell command is
/// judged as a command prefix for `exec.run` **and** as the `fs.*` paths its
/// arguments name, and the guard returns exactly one decision over the whole set
/// (`ARCH/10` §Permission assertion, `DEC-025`). The tool plane supplies these
/// pairs; it never decides anything about them.
#[derive(Clone, Debug, PartialEq)]
pub struct GuardTarget {
    /// The canonical capability action.
    pub action: String,
    /// The concrete resources the pair names.
    pub resources: Vec<String>,
}

impl GuardTarget {
    /// Builds a target.
    #[must_use]
    pub fn new(action: impl Into<String>, resources: Vec<String>) -> Self {
        Self {
            action: action.into(),
            resources,
        }
    }
}

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
    /// Additional action domains the same call names.
    pub targets: Vec<GuardTarget>,
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
            targets: Vec::new(),
        }
    }

    /// Attaches one more action domain the call names.
    #[must_use]
    pub fn with_target(mut self, action: impl Into<String>, resources: Vec<String>) -> Self {
        self.targets.push(GuardTarget::new(action, resources));
        self
    }

    /// Returns every `(action, resources)` pair the request names, canonically
    /// actioned, in evaluation order. An empty pair is dropped: an action with no
    /// resource is a whole-action check the caller has not asked for.
    #[must_use]
    pub fn pairs(&self) -> Vec<(&str, Vec<String>)> {
        let mut pairs = vec![(canonical_action(&self.action), self.resources.clone())];
        for target in &self.targets {
            if target.resources.is_empty() {
                continue;
            }
            pairs.push((canonical_action(&target.action), target.resources.clone()));
        }
        pairs
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
    /// The roots a path resource is inside, for the external-directory floor.
    ///
    /// Empty means nothing has been granted, so every absolute path counts as
    /// external: the floor fails closed rather than assuming a scope it was not
    /// told about.
    granted_roots: Vec<PathBuf>,
    /// The home directory, so a `~`-anchored resource can be resolved.
    home: Option<PathBuf>,
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
        self.evaluate_pairs(&[(canonical_action(action), resources.to_vec())])
    }

    /// Evaluates one request: every action domain it names, one decision.
    #[must_use]
    pub fn check(&self, request: &GuardRequest) -> GuardDecision {
        self.evaluate_pairs(&request.pairs())
    }

    /// Evaluates a set of `(action, resources)` pairs into one decision.
    ///
    /// deny dominates, then ask, then allow, then the configured unmatched
    /// effect. The deny ceiling, the catastrophic gate, the plan ceiling, and the
    /// external-directory floor all run over the **whole** set, so an extracted
    /// path target can raise the outcome but never lower it (`DEC-024`).
    #[must_use]
    pub fn evaluate_pairs(&self, pairs: &[(&str, Vec<String>)]) -> GuardDecision {
        if let Some(reason) = &self.inner.degraded {
            return GuardDecision::deny(format!(
                "guard policy failed to load; failing closed: {reason}"
            ));
        }
        // A resource-less action is a whole-action check; evaluate it against the
        // wildcard resource so a rule that allows the action for `**` applies.
        let wildcard = [String::from("**")];
        let normalized: Vec<(&str, Vec<String>)> = pairs
            .iter()
            .map(|(action, resources)| {
                if resources.is_empty() {
                    (*action, wildcard.to_vec())
                } else {
                    (*action, resources.clone())
                }
            })
            .collect();
        if self.inner.mode == GuardMode::Plan
            && let Some((action, _)) = normalized.iter().find(|(action, _)| is_mutating(action))
        {
            return GuardDecision::deny(format!("plan mode blocks the mutating action `{action}`"));
        }
        for (action, resources) in &normalized {
            if let Some(reason) = catastrophic(action, resources) {
                return GuardDecision::deny(reason);
            }
            let ceiling_hit = self.inner.ceiling.iter().any(|rule| {
                resources
                    .iter()
                    .any(|resource| rule.matches(action, resource).unwrap_or(false))
            });
            if ceiling_hit {
                return GuardDecision::deny(format!(
                    "denied by the non-overridable `{action}` deny ceiling"
                ));
            }
        }
        let rules = self.effective_rules();
        let mut effects: Vec<Effect> = Vec::new();
        for (action, resources) in &normalized {
            for resource in resources {
                let last = rules
                    .iter()
                    .rev()
                    .find(|rule| rule.matches(action, resource).unwrap_or(false));
                let effect = last.map_or(self.inner.unmatched, |rule| rule.effect);
                effects.push(self.apply_external_floor(
                    action,
                    resource,
                    effect,
                    last.is_some(),
                    &rules,
                ));
            }
        }
        let combined = combine_effects(&effects).unwrap_or(self.inner.unmatched);
        match combined {
            Effect::Deny => GuardDecision::deny(
                "the request is denied by policy for at least one of the resources it names"
                    .to_owned(),
            ),
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

    /// The built-in external-directory floor (`DEC-024`, `ARCH/12`).
    ///
    /// An `fs.*` resource that names a path outside the granted roots is raised
    /// to the single `external_directory` ask unless a rule *deliberately* names
    /// that external area. The point is that a broad `**` allow of the workspace
    /// does not silently become an allow of the whole host: authorization is not
    /// reach (`REQ-SEC-010`), and the confinement layer is what actually bounds
    /// the read, so the ask is where a user learns their grant reached further
    /// than they wrote.
    ///
    /// The floor only ever **raises**: `deny` is returned untouched, an explicit
    /// external allow stands, and a configuration cannot set it to `allow`.
    fn apply_external_floor(
        &self,
        action: &str,
        resource: &str,
        effect: Effect,
        matched: bool,
        rules: &[Rule],
    ) -> Effect {
        if effect != Effect::Allow || !action.starts_with("fs.") || !matched {
            return effect;
        }
        if !self.names_an_external_path(resource) {
            return effect;
        }
        if self.names_the_area_deliberately(resource, rules) {
            return effect;
        }
        Effect::Ask
    }

    /// Returns whether a resource resolves to a path outside every granted root.
    ///
    /// An absolute or `~`-anchored resource is external unless a granted root
    /// contains it. A relative resource is resolved against the granted roots and
    /// is external only when it escapes all of them, so `src/main.rs` is
    /// unaffected while `../../etc/passwd` is caught; with no granted root there
    /// is nothing for a relative resource to escape.
    fn names_an_external_path(&self, resource: &str) -> bool {
        let text = resource.trim();
        if text.is_empty() {
            return false;
        }
        let candidate = if let Some(rest) = text.strip_prefix('~') {
            match self.inner.home.as_deref() {
                Some(home) => home.join(rest.trim_start_matches('/')),
                // No home is known, so a `~` path cannot be shown to be inside a
                // granted root.
                None => return true,
            }
        } else if text.starts_with('/') {
            PathBuf::from(text)
        } else {
            let relative = std::path::Path::new(text);
            if self.inner.granted_roots.is_empty() {
                // Nothing was declared in scope, so a relative resource has no
                // root to escape: the tool plane owns its workspace check, and an
                // absolute resource is already caught above.
                return false;
            }
            let inside = self
                .inner
                .granted_roots
                .iter()
                .any(|root| lexical_normalize(&root.join(relative)).starts_with(root));
            if inside {
                return false;
            }
            return true;
        };
        self.inner
            .granted_roots
            .iter()
            .all(|root| !candidate.starts_with(root))
    }

    /// Returns whether some allow rule names the external area on purpose.
    ///
    /// A rule whose resource is itself an absolute or `~` path (or a globstar
    /// anchored at one) is a deliberate grant for that location. A wildcard such
    /// as `**` is not: it is what the floor exists to bound.
    fn names_the_area_deliberately(&self, resource: &str, rules: &[Rule]) -> bool {
        rules.iter().any(|rule| {
            rule.effect == Effect::Allow
                && rule
                    .action_matches("fs.read")
                    .unwrap_or(false)
                && is_anchored_path_pattern(&rule.resource)
                && rule
                    .matches("fs.read", resource)
                    .unwrap_or(false)
        })
    }

    /// Issues a ticket after an allow decision.
    ///
    /// The ticket is **single-use and bounded**: it authorizes the one effect it
    /// was issued for, carries the approval window in force, and records the
    /// policy fingerprint it was issued under so a later validation can prove the
    /// policy has not moved underneath it (`ARCH/12` §Tickets).
    #[must_use]
    pub fn issue_ticket(&self, request: &GuardRequest, approval_ref: Option<String>) -> Ticket {
        let scope = if request.resources.is_empty() {
            vec!["**".to_owned()]
        } else {
            request.resources.clone()
        };
        let ttl = self.inner.approval_timeout_ms;
        let ticket = Ticket {
            id: format!("tkt_{}", uuid::Uuid::now_v7().simple()),
            action: canonical_action(&request.action).to_owned(),
            scope,
            uses: 1,
            single_use: true,
            expires_at_ms: now_ms().saturating_add(ttl),
            policy_hash: self.inner.policy_hash.clone(),
            approval_ref,
        };
        self.inner.tickets.issue(ticket)
    }

    /// Validates a ticket for an action and resource, consuming its single use.
    ///
    /// Every check the architecture names is performed: scope match, remaining
    /// uses, expiry, and the policy fingerprint. A ticket issued under a
    /// different policy is refused even when its id, action, and scope all
    /// match, so a rule that was widened or narrowed after the grant cannot be
    /// spent through the old grant.
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
            .validate(ticket_id, canonical_action(action), resource, &self.inner.policy_hash)
    }

    /// Spends one use of a ticket.
    ///
    /// This is the liveness half of ticket validation: the ticket must still
    /// exist, must not have expired, must have been issued under the current
    /// policy, and must have a use left. The scope half is checked by the caller
    /// against the exact `(action, resource)` set the grant was issued for, so a
    /// request that names more than the grant covered is refused before this
    /// point.
    ///
    /// # Errors
    /// Returns [`GuardError::InvalidTicket`] when the ticket is gone, expired,
    /// issued under a different policy, or out of uses.
    pub fn consume_ticket(&self, ticket_id: &str) -> Result<Ticket, GuardError> {
        self.inner
            .tickets
            .consume(ticket_id, &self.inner.policy_hash)
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
    approval_timeout_ms: Option<u64>,
    saved_path: Option<PathBuf>,
    granted_roots: Vec<PathBuf>,
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
            approval_timeout_ms: None,
            saved_path: None,
            granted_roots: Vec::new(),
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

    /// Sets the approval window in milliseconds.
    ///
    /// An explicit value overrides any discovered
    /// `guard.approval.default_timeout_ms`. A configured `0` is honoured: an
    /// approval that must be answered instantly fails closed.
    #[must_use]
    pub fn with_approval_timeout_ms(mut self, timeout_ms: u64) -> Self {
        self.approval_timeout_ms = Some(timeout_ms);
        self
    }

    /// Grants one additional root that a path resource may name without the
    /// external-directory floor raising it.
    ///
    /// This is the authorization-side notion of a granted root. The confinement
    /// layer owns reach independently (`REQ-SEC-010`); declaring a root here does
    /// not make it reachable, it only stops the floor from asking about a location
    /// the operator has already declared in scope.
    #[must_use]
    pub fn with_granted_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.granted_roots.push(root.into());
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
        // Posture is merged from every discovered document in the same order the
        // rules are: global first, then project outer-to-inner, so the nearest
        // document wins. A document that omits a key leaves the previous value
        // standing rather than resetting it.
        let mut posture = Posture::default();
        if let Some(path) = global_path
            && path.is_file()
        {
            match load_document(&path, RuleSource::Global) {
                Ok((layer, document)) => {
                    posture.absorb(&document);
                    push_layer(&mut layers, &mut ceiling, layer);
                }
                Err(error) => {
                    ceiling.push(deny_all());
                    degraded.get_or_insert_with(|| error.to_string());
                }
            }
        }

        if let Some(workspace) = &self.workspace {
            for path in project_config_paths(workspace) {
                match load_document(&path, RuleSource::Project) {
                    Ok((layer, document)) => {
                        posture.absorb(&document);
                        push_layer(&mut layers, &mut ceiling, layer);
                    }
                    Err(error) => {
                        ceiling.push(deny_all());
                        degraded.get_or_insert_with(|| error.to_string());
                    }
                }
            }
        }

        if self.mode.is_none()
            && let Some(document_mode) = posture.mode
        {
            mode = document_mode;
        }
        if self.unmatched.is_none()
            && let Some(document_unmatched) = posture.unmatched
        {
            unmatched = document_unmatched;
        }
        let approval_timeout_ms = self
            .approval_timeout_ms
            .or(posture.approval_timeout_ms)
            .unwrap_or(DEFAULT_TTL_MS);

        if !self.agent_rules.is_empty() {
            layers.push(RuleLayer::new(RuleSource::Agent, self.agent_rules));
        }
        if !self.session_rules.is_empty() {
            layers.push(RuleLayer::new(RuleSource::Session, self.session_rules));
        }
        if unmatched == Effect::Allow {
            unmatched = Effect::Deny;
        }

        let mut granted_roots: Vec<PathBuf> = Vec::new();
        if let Some(workspace) = &self.workspace {
            granted_roots.push(
                std::fs::canonicalize(workspace).unwrap_or_else(|_| lexical_normalize(workspace)),
            );
        }
        granted_roots.extend(self.granted_roots.iter().cloned());
        granted_roots.dedup();

        let policy_hash = compute_policy_hash(&layers, &ceiling, mode, unmatched);
        Guard {
            inner: Arc::new(GuardInner {
                layers,
                ceiling,
                mode,
                unmatched,
                approval_timeout_ms,
                degraded,
                saved: Mutex::new(Vec::new()),
                tickets: TicketStore::new(),
                policy_hash,
                saved_path: self.saved_path,
                granted_roots,
                home: dirs::home_dir(),
            }),
        }
    }
}

/// The posture discovered from config documents, merged nearest-wins.
#[derive(Clone, Copy, Debug, Default)]
struct Posture {
    mode: Option<GuardMode>,
    unmatched: Option<Effect>,
    approval_timeout_ms: Option<u64>,
}

impl Posture {
    /// Absorbs one document; a key the document omits leaves the previous value
    /// standing, so an inner document that sets only `mode` does not reset the
    /// global `unmatched`.
    fn absorb(&mut self, document: &GuardDocument) {
        if document.mode.is_some() {
            self.mode = document.mode;
        }
        if document.unmatched.is_some() {
            self.unmatched = document.unmatched;
        }
        if document.approval_timeout_ms.is_some() {
            self.approval_timeout_ms = document.approval_timeout_ms;
        }
    }
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
/// that collide. `horizoncode-audit` is the owner of that digest, so it is reused
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

/// Lexically normalizes `.` and `..` without touching the filesystem.
fn lexical_normalize(path: &std::path::Path) -> PathBuf {
    use std::path::Component;
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Returns whether a path pattern is *anchored* at an absolute or `~` location.
///
/// A wildcard such as `**` is not anchored: it matches inside the granted roots
/// and outside them equally, which is exactly what the external-directory floor
/// bounds. `src/**` is anchored at a relative location and can never name an
/// outside-root path in the first place.
fn is_anchored_path_pattern(pattern: &str) -> bool {
    let text = pattern.trim();
    text.starts_with('/') || text.starts_with('~') || text.starts_with("/**")
}

/// The domain label hashed ahead of a policy fingerprint.
const POLICY_HASH_LABEL: &[u8] = b"horizoncode/guard/policy/v1";
