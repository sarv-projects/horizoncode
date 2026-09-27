//! The `read` tool: a file page or a directory listing.

use horizoncode_types::ToolDefinition;
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, check_sandbox_read, display_path, object_schema, optional_usize, require_str,
    sort_entries,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

const DEFAULT_LIMIT: usize = 2000;
const MAX_LIMIT: usize = 20_000;

/// Reads a file page (with optional line window) or lists a directory.
#[derive(Debug, Default)]
pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "read",
            "Read a UTF-8 text file from the workspace, or list a directory. \
             Use offset/limit to page through large files.",
            object_schema(
                json!({
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute path."
                    },
                    "offset": {
                        "type": "integer",
                        "description": "1-based first line to return (default 1).",
                        "minimum": 1
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum lines to return (default 2000).",
                        "minimum": 1
                    }
                }),
                &["path"],
            ),
            None,
        )
    }

    fn supports_parallel(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let raw = require_str(&input, "path")?;
        let resolved = resolve_workspace_path(&ctx.workspace, &raw)?;
        // A read is reach, not authorization: it is scoped to the granted roots
        // and the deny set here, at the enforcement layer, not only by the
        // workspace check above (`ARCH/13`, `REQ-SEC-025`).
        assert_action(ctx, "read", vec![raw.clone()], Vec::new()).await?;
        check_sandbox_read(ctx, &resolved)?;
        let metadata = std::fs::metadata(&resolved).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ToolError::NotFound(raw.clone())
            } else {
                ToolError::Io {
                    path: resolved.clone(),
                    message: error.to_string(),
                }
            }
        })?;

        if metadata.is_dir() {
            return Ok(ToolOutput::text(list_directory(&ctx.workspace, &resolved)?));
        }

        let bytes = std::fs::read(&resolved).map_err(|error| ToolError::Io {
            path: resolved.clone(),
            message: error.to_string(),
        })?;
        let display = display_path(&ctx.workspace, &resolved);
        if crate::builtin::is_binary(&bytes) {
            return Ok(ToolOutput::text(format!(
                "{display} is a binary file ({} bytes); not shown",
                bytes.len()
            )));
        }
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text.lines().collect();
        let total = lines.len();
        let offset = optional_usize(&input, "offset")?.unwrap_or(1).max(1);
        let limit = optional_usize(&input, "limit")?
            .unwrap_or(DEFAULT_LIMIT)
            .clamp(1, MAX_LIMIT);
        let start = (offset - 1).min(total);
        let end = start.saturating_add(limit).min(total);
        let page = lines[start..end].join("\n");
        let mut output = format!(
            "{display} (lines {}-{} of {total})\n{page}",
            if total == 0 { 0 } else { start + 1 },
            end
        );
        if end < total {
            output.push_str(&format!(
                "\n… [{} more lines; call read with offset={}]",
                total - end,
                end + 1
            ));
        }
        Ok(ToolOutput::text(output))
    }
}

fn list_directory(workspace: &std::path::Path, dir: &std::path::Path) -> Result<String, ToolError> {
    let read = std::fs::read_dir(dir).map_err(|error| ToolError::Io {
        path: dir.to_path_buf(),
        message: error.to_string(),
    })?;
    let mut entries: Vec<std::fs::DirEntry> = read.flatten().collect();
    sort_entries(&mut entries);
    let display = display_path(workspace, dir);
    let mut output = format!("{display}/");
    for entry in entries {
        let name = entry.file_name().to_string_lossy().into_owned();
        let suffix = if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            "/"
        } else {
            ""
        };
        output.push('\n');
        output.push_str(&name);
        output.push_str(suffix);
    }
    Ok(output)
}
