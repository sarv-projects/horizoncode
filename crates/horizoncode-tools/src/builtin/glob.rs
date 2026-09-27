//! The `glob` tool: filename matching within the workspace.

use horizoncode_types::ToolDefinition;
use async_trait::async_trait;
use globset::{Glob, GlobMatcher};
use serde_json::{Value, json};
use walkdir::WalkDir;

use crate::builtin::{
    assert_action, check_sandbox_read, display_path, object_schema, optional_str, optional_usize,
    require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

const DEFAULT_LIMIT: usize = 200;
const MAX_LIMIT: usize = 5000;

/// Matches files by glob pattern.
#[derive(Debug, Default)]
pub struct GlobTool;

#[async_trait]
impl Tool for GlobTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "glob",
            "Find files by glob pattern (for example `src/**/*.rs`). Returns \
             workspace-relative paths, one per line.",
            object_schema(
                json!({
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern matched against workspace-relative paths."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search under (default '.')."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum paths to return (default 200).",
                        "minimum": 1
                    }
                }),
                &["pattern"],
            ),
            None,
        )
    }

    fn supports_parallel(&self) -> bool {
        true
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let pattern = require_str(&input, "pattern")?;
        let matcher = build_matcher(&pattern)?;
        let base_raw = optional_str(&input, "path").unwrap_or_else(|| ".".to_owned());
        let base = resolve_workspace_path(&ctx.workspace, &base_raw)?;
        assert_action(ctx, "glob", vec![pattern.clone()], Vec::new()).await?;
        check_sandbox_read(ctx, &base)?;
        let limit = optional_usize(&input, "limit")?
            .unwrap_or(DEFAULT_LIMIT)
            .clamp(1, MAX_LIMIT);

        let mut matches = Vec::new();
        let mut truncated = false;
        for entry in WalkDir::new(&base)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".git")
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = display_path(&ctx.workspace, entry.path());
            if matcher.is_match(&relative) {
                matches.push(relative);
                if matches.len() >= limit {
                    truncated = true;
                    break;
                }
            }
        }
        matches.sort();
        let mut output = if matches.is_empty() {
            format!("no files matched `{pattern}`")
        } else {
            matches.join("\n")
        };
        if truncated {
            output.push_str(&format!("\n… [stopped at {limit} matches]"));
        }
        Ok(ToolOutput::text(output))
    }
}

fn build_matcher(pattern: &str) -> Result<GlobMatcher, ToolError> {
    Glob::new(pattern)
        .map(|glob| glob.compile_matcher())
        .map_err(|error| ToolError::InvalidInput(format!("invalid glob `{pattern}`: {error}")))
}
