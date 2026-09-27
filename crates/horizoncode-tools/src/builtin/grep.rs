//! The `grep` tool: regex content search within the workspace.

use horizoncode_types::ToolDefinition;
use async_trait::async_trait;
use globset::Glob;
use regex::Regex;
use serde_json::{Value, json};
use walkdir::WalkDir;

use crate::builtin::{
    assert_action, check_sandbox_read, display_path, is_binary, object_schema, optional_str,
    optional_usize, require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;
const MAX_LINE_CHARS: usize = 400;

/// Searches file contents by regular expression.
#[derive(Debug, Default)]
pub struct GrepTool;

#[async_trait]
impl Tool for GrepTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "grep",
            "Search workspace file contents with a regular expression. Results \
             are grouped per file as `path:line: text`.",
            object_schema(
                json!({
                    "pattern": {
                        "type": "string",
                        "description": "Rust `regex` pattern."
                    },
                    "path": {
                        "type": "string",
                        "description": "Directory to search under (default '.')."
                    },
                    "include": {
                        "type": "string",
                        "description": "Optional glob limiting which files are searched."
                    },
                    "limit": {
                        "type": "integer",
                        "description": "Maximum matching lines (default 100).",
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
        let regex = Regex::new(&pattern).map_err(|error| {
            ToolError::InvalidInput(format!("invalid regex `{pattern}`: {error}"))
        })?;
        let include = match optional_str(&input, "include") {
            Some(glob) => Some(
                Glob::new(&glob)
                    .map(|glob| glob.compile_matcher())
                    .map_err(|error| {
                        ToolError::InvalidInput(format!("invalid include glob `{glob}`: {error}"))
                    })?,
            ),
            None => None,
        };
        let base_raw = optional_str(&input, "path").unwrap_or_else(|| ".".to_owned());
        let base = resolve_workspace_path(&ctx.workspace, &base_raw)?;
        assert_action(ctx, "grep", vec![pattern.clone()], Vec::new()).await?;
        check_sandbox_read(ctx, &base)?;
        let limit = optional_usize(&input, "limit")?
            .unwrap_or(DEFAULT_LIMIT)
            .clamp(1, MAX_LIMIT);

        let mut hits: Vec<String> = Vec::new();
        let mut truncated = false;
        'outer: for entry in WalkDir::new(&base)
            .follow_links(false)
            .into_iter()
            .filter_entry(|entry| entry.file_name() != ".git")
            .flatten()
        {
            if !entry.file_type().is_file() {
                continue;
            }
            let relative = display_path(&ctx.workspace, entry.path());
            if let Some(include) = &include
                && !include.is_match(&relative)
            {
                continue;
            }
            let Ok(bytes) = std::fs::read(entry.path()) else {
                continue;
            };
            if is_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                if regex.is_match(line) {
                    let mut line = line.trim_end().to_owned();
                    if line.chars().count() > MAX_LINE_CHARS {
                        line = line.chars().take(MAX_LINE_CHARS).collect::<String>() + "…";
                    }
                    hits.push(format!("{relative}:{}: {line}", index + 1));
                    if hits.len() >= limit {
                        truncated = true;
                        break 'outer;
                    }
                }
            }
        }
        let mut output = if hits.is_empty() {
            format!("no matches for `{pattern}`")
        } else {
            hits.join("\n")
        };
        if truncated {
            output.push_str(&format!("\n… [stopped at {limit} matches]"));
        }
        Ok(ToolOutput::text(output))
    }
}
