//! The `list` tool: a flat directory listing.

use agentx_types::ToolDefinition;
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::builtin::{display_path, object_schema, optional_str, optional_usize, sort_entries};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

const DEFAULT_LIMIT: usize = 1000;
const MAX_LIMIT: usize = 10_000;

/// Lists a workspace directory.
#[derive(Debug, Default)]
pub struct ListTool;

#[async_trait]
impl Tool for ListTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "list",
            "List the entries of a workspace directory (directories first).",
            object_schema(
                json!({
                    "path": {
                        "type": "string",
                        "description": "Directory to list (default '.')."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum entries to return (default 1000).",
                        "minimum": 1
                    }
                }),
                &[],
            ),
            None,
        )
    }

    fn supports_parallel(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let raw = optional_str(&input, "path").unwrap_or_else(|| ".".to_owned());
        let resolved = resolve_workspace_path(&ctx.workspace, &raw)?;
        let limit = optional_usize(&input, "limit")?
            .unwrap_or(DEFAULT_LIMIT)
            .clamp(1, MAX_LIMIT);

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
        let display = display_path(&ctx.workspace, &resolved);
        if !metadata.is_dir() {
            return Ok(ToolOutput::text(format!("{display}\n(not a directory)")));
        }
        let read = std::fs::read_dir(&resolved).map_err(|error| ToolError::Io {
            path: resolved.clone(),
            message: error.to_string(),
        })?;
        let mut entries: Vec<std::fs::DirEntry> = read.flatten().collect();
        sort_entries(&mut entries);
        let total = entries.len();
        let mut output = format!("{display}/");
        for entry in entries.iter().take(limit) {
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
        if total > limit {
            output.push_str(&format!("\n… [{} more entries]", total - limit));
        }
        Ok(ToolOutput::text(output))
    }
}
