//! Guard modes and decisions (`ARCH/12-GUARD.md`).

use serde::{Deserialize, Serialize};

use crate::error::GuardError;

/// The interaction posture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GuardMode {
    /// Read-only planning: every mutating action is forced to deny.
    Plan,
    /// Normal evaluation.
    Act,
    /// `ask` is auto-resolved to allow; deny and the catastrophic gate remain.
    Yolo,
}

impl GuardMode {
    /// Parses a mode name, falling back to the most restrictive mode.
    ///
    /// # Errors
    /// Returns [`GuardError::Config`] for an unknown mode so a caller cannot
    /// silently widen the posture.
    pub fn parse(value: &str, path: &str) -> Result<Self, GuardError> {
        match value {
            "plan" => Ok(Self::Plan),
            "act" => Ok(Self::Act),
            "yolo" => Ok(Self::Yolo),
            other => Err(GuardError::config(
                path,
                format!("unknown guard mode `{other}` (expected plan|act|yolo)"),
            )),
        }
    }

    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Plan => "plan",
            Self::Act => "act",
            Self::Yolo => "yolo",
        }
    }
}

/// The resolved policy answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum GuardDecision {
    /// The action may proceed.
    Allow,
    /// The action must be approved before it runs.
    Ask,
    /// The action must not run.
    Deny {
        /// A short reason surfaced to the model.
        reason: String,
    },
}

impl GuardDecision {
    /// Builds a deny with a reason.
    #[must_use]
    pub fn deny(reason: impl Into<String>) -> Self {
        Self::Deny {
            reason: reason.into(),
        }
    }

    /// Returns whether the decision is an allow.
    #[must_use]
    pub fn is_allow(&self) -> bool {
        matches!(self, Self::Allow)
    }

    /// Returns the stable name.
    #[must_use]
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Allow => "allow",
            Self::Ask => "ask",
            Self::Deny { .. } => "deny",
        }
    }
}
