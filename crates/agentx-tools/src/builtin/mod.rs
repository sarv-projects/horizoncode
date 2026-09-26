//! First-party read-only built-in tools.
//!
//! Every tool resolves paths inside the active workspace (refusing escapes),
//! declares a typed input schema, and never panics on hostile input.

mod glob;
mod grep;
mod list;
mod read;

pub use glob::GlobTool;
pub use grep::GrepTool;
pub use list::ListTool;
pub use read::ReadTool;

use serde_json::{Value, json};

use crate::error::ToolError;

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
pub(crate) fn display_path(workspace: &std::path::Path, path: &std::path::Path) -> String {
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
