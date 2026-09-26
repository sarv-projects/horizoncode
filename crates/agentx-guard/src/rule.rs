//! The rule model and its evaluation primitives (`ARCH/12-GUARD.md`).

use serde::{Deserialize, Serialize};

use crate::error::GuardError;
use crate::pattern::{MatchMode, Pattern};

/// The effect a matching rule requests.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Effect {
    /// The action is permitted.
    Allow,
    /// The action must be approved before it runs.
    Ask,
    /// The action must not run.
    Deny,
}

impl Effect {
    /// Parses an effect name, rejecting anything unknown (fail closed).
    ///
    /// # Errors
    /// Returns [`GuardError::Config`] for an unrecognized effect.
    pub fn parse(value: &str, path: &str) -> Result<Self, GuardError> {
        match value {
            "allow" => Ok(Self::Allow),
            "ask" => Ok(Self::Ask),
            "deny" => Ok(Self::Deny),
            other => Err(GuardError::config(
                path,
                format!("unknown rule effect `{other}` (expected allow|ask|deny)"),
            )),
        }
    }

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny => "deny",
        }
    }

    fn rank(self) -> u8 {
        match self {
            Self::Allow => 0,
            Self::Ask => 1,
            Self::Deny => 2,
        }
    }
}

/// Where a rule layer came from; order is precedence (later wins).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum RuleSource {
    /// User/global configuration.
    Global,
    /// Project configuration discovered by walking the workspace.
    Project,
    /// An agent-level policy override.
    Agent,
    /// Ephemeral session overrides.
    Session,
    /// A saved "always allow" rule.
    Saved,
}

impl RuleSource {
    /// Returns the stable name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Global => "global",
            Self::Project => "project",
            Self::Agent => "agent",
            Self::Session => "session",
            Self::Saved => "saved",
        }
    }
}

/// One ordered rule: `{ action, resource, effect }`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rule {
    /// The capability action pattern (for example `fs.write`).
    pub action: String,
    /// The resource pattern (path, command prefix, `host:port`).
    pub resource: String,
    /// The effect requested.
    pub effect: Effect,
}

impl Rule {
    /// Builds a rule.
    #[must_use]
    pub fn new(action: impl Into<String>, resource: impl Into<String>, effect: Effect) -> Self {
        Self {
            action: action.into(),
            resource: resource.into(),
            effect,
        }
    }

    /// Returns whether this rule's action matches `action`.
    ///
    /// # Errors
    /// Returns [`GuardError::Pattern`] when the rule action is malformed.
    pub fn action_matches(&self, action: &str) -> Result<bool, GuardError> {
        Ok(Pattern::compile(&self.action, MatchMode::Dotted)?.matches(action))
    }

    /// Returns whether this rule matches both the action and the resource.
    ///
    /// # Errors
    /// Returns [`GuardError::Pattern`] when a rule pattern is malformed.
    pub fn matches(&self, action: &str, resource: &str) -> Result<bool, GuardError> {
        if !Pattern::compile(&self.action, MatchMode::Dotted)?.matches(action) {
            return Ok(false);
        }
        let mode = resource_mode(action);
        Ok(Pattern::compile(&self.resource, mode)?.matches(resource))
    }

    /// Validates both patterns at load time so a malformed rule is detected
    /// before evaluation.
    ///
    /// # Errors
    /// Returns [`GuardError::Pattern`] when either pattern is malformed.
    pub fn validate(&self) -> Result<(), GuardError> {
        Pattern::compile(&self.action, MatchMode::Dotted)?;
        Pattern::compile(&self.resource, resource_mode(&self.action))?;
        Ok(())
    }
}

/// Chooses the resource match mode from the action domain.
#[must_use]
pub fn resource_mode(action: &str) -> MatchMode {
    if action.starts_with("fs.") {
        MatchMode::Path
    } else if action.starts_with("net.") {
        MatchMode::Authority
    } else {
        MatchMode::Raw
    }
}

/// A parsed layer of rules with its origin.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RuleLayer {
    /// Where the layer came from.
    pub source: RuleSource,
    /// The rules, in file order.
    pub rules: Vec<Rule>,
    /// The file the layer was read from, when it came from disk.
    pub file: Option<String>,
}

impl RuleLayer {
    /// Builds a layer.
    #[must_use]
    pub fn new(source: RuleSource, rules: Vec<Rule>) -> Self {
        Self {
            source,
            rules,
            file: None,
        }
    }

    /// Attaches the originating file path.
    #[must_use]
    pub fn with_file(mut self, file: impl Into<String>) -> Self {
        self.file = Some(file.into());
        self
    }
}

/// Combines a set of per-resource effects into one decision:
/// deny dominates, then ask, then allow.
#[must_use]
pub fn combine_effects(effects: &[Effect]) -> Option<Effect> {
    effects.iter().copied().max_by_key(|effect| effect.rank())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resource_mode_follows_the_action_domain() {
        assert_eq!(resource_mode("fs.write"), MatchMode::Path);
        assert_eq!(resource_mode("net.connect"), MatchMode::Authority);
        assert_eq!(resource_mode("exec.run"), MatchMode::Raw);
    }

    #[test]
    fn deny_dominates_combine() {
        assert_eq!(
            combine_effects(&[Effect::Allow, Effect::Ask, Effect::Deny]),
            Some(Effect::Deny)
        );
        assert_eq!(
            combine_effects(&[Effect::Allow, Effect::Ask]),
            Some(Effect::Ask)
        );
        assert_eq!(combine_effects(&[]), None);
    }

    #[test]
    fn unknown_effect_fails_closed() {
        assert!(Effect::parse("permit", "x").is_err());
    }
}
