//! First-party built-in tools.
//!
//! Every tool resolves paths inside the active workspace (refusing escapes),
//! declares a typed input schema, and never panics on hostile input. Mutating
//! and exec tools re-assert the guard immediately before the effect, so a tool
//! invoked directly cannot bypass policy (`ARCH/10-TOOLS.md`).

mod bash;
mod edit;
mod glob;
mod grep;
mod list;
mod patch;
mod question;
mod read;
mod todo;
mod write;

pub use bash::BashTool;
pub use edit::EditTool;
pub use glob::GlobTool;
pub use grep::GrepTool;
pub use list::ListTool;
pub use patch::ApplyPatchTool;
pub use question::{QuestionHandler, QuestionTool};
pub use read::ReadTool;
pub use todo::{TodoItem, TodoStatus, TodoStore, TodoTool};
pub use write::WriteTool;

use std::path::Path;

use agentx_sandbox::FsOp;
use serde_json::{Value, json};

use crate::error::ToolError;
use crate::policy::{GateDecision, PermissionRequest};
use crate::registry::ToolContext;

/// Builds an object JSON schema.
pub(crate) fn object_schema(properties: Value, required: &[&str]) -> Value {
    json!({
        "type": "object",
        "properties": properties,
        "required": required,
        "additionalProperties": false,
    })
}

/// Reads a required string field.
pub(crate) fn require_str(input: &Value, key: &str) -> Result<String, ToolError> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ToolError::InvalidInput(format!("`{key}` must be a non-empty string")))
}

/// Reads an optional string field.
pub(crate) fn optional_str(input: &Value, key: &str) -> Option<String> {
    input
        .get(key)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .filter(|value| !value.is_empty())
}

/// Reads an optional boolean field.
pub(crate) fn optional_bool(input: &Value, key: &str) -> Result<bool, ToolError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(false),
        Some(value) => value
            .as_bool()
            .ok_or_else(|| ToolError::InvalidInput(format!("`{key}` must be a boolean"))),
    }
}

/// Reads an optional non-negative integer field.
pub(crate) fn optional_usize(input: &Value, key: &str) -> Result<Option<usize>, ToolError> {
    match input.get(key) {
        None | Some(Value::Null) => Ok(None),
        Some(value) => value
            .as_u64()
            .map(|value| Some(value as usize))
            .ok_or_else(|| {
                ToolError::InvalidInput(format!("`{key}` must be a non-negative integer"))
            }),
    }
}

/// Returns whether a byte slice is likely binary (contains a NUL byte).
pub(crate) fn is_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8192).any(|byte| *byte == 0)
}

/// Renders a path relative to the workspace when possible.
pub(crate) fn display_path(workspace: &Path, path: &Path) -> String {
    path.strip_prefix(workspace)
        .unwrap_or(path)
        .to_string_lossy()
        .replace('\\', "/")
}

/// Sorts directory entries with directories first, then by name.
pub(crate) fn sort_entries(entries: &mut [std::fs::DirEntry]) {
    entries.sort_by(|a, b| {
        let a_dir = a.file_type().map(|t| t.is_dir()).unwrap_or(false);
        let b_dir = b.file_type().map(|t| t.is_dir()).unwrap_or(false);
        b_dir
            .cmp(&a_dir)
            .then_with(|| a.file_name().cmp(&b.file_name()))
    });
}

/// Re-asserts the guard for a mutating/exec tool immediately before its effect.
///
/// When the caller already authorized this call, the guard gate recognizes the
/// call identity and returns `allow` without a second prompt.
pub(crate) async fn assert_action(
    ctx: &ToolContext,
    action: &str,
    resources: Vec<String>,
) -> Result<(), ToolError> {
    let Some(gate) = &ctx.gate else {
        return Ok(());
    };
    let request = PermissionRequest {
        action: action.to_owned(),
        tool_name: action.to_owned(),
        resources,
        session_id: ctx.session_id.clone(),
        source: ctx.tool_call_id.clone(),
        metadata: json!({ "self_assert": true }),
    };
    match gate.authorize(&request).await {
        GateDecision::Allow => Ok(()),
        GateDecision::Deny { reason } => Err(ToolError::Denied(reason)),
    }
}

/// Consults the sandbox for an in-process write when a plan is available.
pub(crate) fn check_sandbox_write(ctx: &ToolContext, path: &Path) -> Result<(), ToolError> {
    if let (Some(sandbox), Some(resolved)) = (&ctx.sandbox, &ctx.resolved) {
        sandbox
            .check_path(FsOp::Write, path, resolved)
            .map_err(|error| {
                ToolError::Denied(format!(
                    "sandbox refused write to {}: {error}",
                    path.display()
                ))
            })?;
    }
    Ok(())
}
