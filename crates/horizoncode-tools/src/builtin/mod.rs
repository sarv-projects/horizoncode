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

use horizoncode_sandbox::FsOp;
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

/// Re-asserts the guard for a tool immediately before its effect.
///
/// This is the second authorization of the one call, and on a gate that issues
/// tickets it is the point where the ticket is **validated and spent**: the
/// effect runs against a grant that was checked for scope, expiry, uses, and
/// policy fingerprint, not against a remembered decision. It carries the same
/// `(action, resources, targets)` shape the registry used, so a request that grew
/// after authorization cannot pass on a narrower grant.
pub(crate) async fn assert_action(
    ctx: &ToolContext,
    action: &str,
    resources: Vec<String>,
    targets: Vec<crate::policy::PermissionTarget>,
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
        targets,
    };
    match gate.authorize(&request).await {
        GateDecision::Allow => Ok(()),
        GateDecision::Deny { reason } => Err(ToolError::Denied(reason)),
    }
}

/// Consults the confinement layer for an in-process filesystem operation.
///
/// This is the tool plane's only reach check, and it is **fail-closed**: when no
/// resolved plan is in force there is no enforcement at all — no deny glob, no
/// protected subpath, no root scope — so the operation is refused rather than
/// performed unenforced (`ARCH/13` §Failure modes, `REQ-SEC-010`). A tool that
/// treated "no plan" as "no restriction" would let a `write` install a hook or a
/// `read` return a deny-globbed secret on any host whose backend failed to
/// probe.
///
/// The plan alone is enough: an in-process path operation is scoped by
/// [`horizoncode_sandbox::check_path`], and the spawn backend is only needed to *run*
/// something. That is also why the single shared implementation is called
/// directly instead of through a provider, so the tool plane and every tier reach
/// the same policy rather than a second copy of it.
pub(crate) fn check_reach(ctx: &ToolContext, op: FsOp, path: &Path) -> Result<(), ToolError> {
    let Some(resolved) = ctx.resolved.as_deref() else {
        return Err(ToolError::Denied(format!(
            "no confinement profile is resolved, so the reach of {} cannot be bounded; \
             refusing the operation rather than performing it unenforced",
            path.display()
        )));
    };
    horizoncode_sandbox::check_path(op, path, resolved).map_err(|error| {
        ToolError::Denied(format!(
            "confinement refused {} of {}: {error}",
            match op {
                FsOp::Read => "read",
                FsOp::Write => "write",
            },
            path.display()
        ))
    })
}

/// Consults the confinement layer for an in-process write.
pub(crate) fn check_sandbox_write(ctx: &ToolContext, path: &Path) -> Result<(), ToolError> {
    check_reach(ctx, FsOp::Write, path)
}

/// Consults the confinement layer for an in-process read.
pub(crate) fn check_sandbox_read(ctx: &ToolContext, path: &Path) -> Result<(), ToolError> {
    check_reach(ctx, FsOp::Read, path)
}
