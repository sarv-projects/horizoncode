//! Tool-call and tool-definition vocabulary shared by the loop, the tool plane
//! and provider schemas.

use std::fmt;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::ids::ToolCallId;

/// The maximum accepted tool-name length (`REQ-TOOL-005`).
pub const MAX_TOOL_NAME_LEN: usize = 64;

/// Validates a tool name against `^[A-Za-z][A-Za-z0-9_-]{0,63}$` (`REQ-TOOL-005`).
///
/// # Errors
/// Returns `false` when the name is empty, too long, starts with a non-letter,
/// or contains a character outside `[A-Za-z0-9_-]`.
#[must_use]
pub fn is_valid_tool_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    if !first.is_ascii_alphabetic() {
        return false;
    }
    let rest = chars.as_str();
    if rest.len() + first.len_utf8() > MAX_TOOL_NAME_LEN {
        return false;
    }
    rest.chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-')
}

/// A tool invocation proposed by the model.
///
/// `arguments` is the parsed JSON object emitted by the model. During streaming
/// the provider accumulates the argument string and parses it once the call is
/// complete; a parse failure is surfaced as a typed tool failure rather than a
/// malformed call.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolCall {
    /// Provider-assigned (or synthesized) call identifier.
    pub id: ToolCallId,
    /// The registered tool name.
    pub name: String,
    /// Parsed JSON arguments.
    pub arguments: Value,
}

impl ToolCall {
    /// Builds a tool call.
    #[must_use]
    pub fn new(id: impl Into<ToolCallId>, name: impl Into<String>, arguments: Value) -> Self {
        Self {
            id: id.into(),
            name: name.into(),
            arguments,
        }
    }
}

/// A tool as advertised to the model.
///
/// The definition is generated from a tool's typed schemas, not hand-written
/// (`ARCH/10-TOOLS.md`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct ToolDefinition {
    /// Registered name, validated by [`is_valid_tool_name`].
    pub name: String,
    /// Human/model-readable description.
    pub description: String,
    /// JSON Schema for the accepted input.
    pub input_schema: Value,
    /// Optional JSON Schema for the structured output.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_schema: Option<Value>,
}

impl ToolDefinition {
    /// Builds a tool definition from its parts.
    #[must_use]
    pub fn new(
        name: impl Into<String>,
        description: impl Into<String>,
        input_schema: Value,
        output_schema: Option<Value>,
    ) -> Self {
        Self {
            name: name.into(),
            description: description.into(),
            input_schema,
            output_schema,
        }
    }
}

/// The outcome class of a settled tool call.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ToolStatus {
    /// The tool succeeded.
    Success,
    /// The tool failed with a typed error.
    Error,
    /// The tool was denied by policy.
    Denied,
    /// The tool was aborted by interruption.
    Aborted,
}

impl ToolStatus {
    /// Returns the stable wire name.
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Success => "success",
            Self::Error => "error",
            Self::Denied => "denied",
            Self::Aborted => "aborted",
        }
    }
}

/// A tool name together with the action used for policy evaluation.
///
/// `write`, `edit` and `apply_patch` all assert the `edit` action; a read-only
/// tool asserts its own name (`ARCH/10-TOOLS.md`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ToolAction {
    /// The advertised tool name.
    pub tool: String,
    /// The policy action the guard evaluates.
    pub action: String,
}

impl ToolAction {
    /// Builds a tool/action pair.
    #[must_use]
    pub fn new(tool: impl Into<String>, action: impl Into<String>) -> Self {
        Self {
            tool: tool.into(),
            action: action.into(),
        }
    }
}

impl fmt::Display for ToolAction {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.tool, self.action)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_valid_names() {
        let max_len = "x".repeat(MAX_TOOL_NAME_LEN);
        for name in [
            "read",
            "glob",
            "apply_patch",
            "a-b",
            "a_b9",
            "A",
            max_len.as_str(),
        ] {
            assert!(is_valid_tool_name(name), "expected {name:?} to be valid");
        }
    }

    #[test]
    fn rejects_invalid_names() {
        for name in ["", "9read", "_read", "a b", "a.b", "a/b", "réad"] {
            assert!(!is_valid_tool_name(name), "expected {name:?} to be invalid");
        }
        assert!(!is_valid_tool_name(&"x".repeat(65)));
    }
}
