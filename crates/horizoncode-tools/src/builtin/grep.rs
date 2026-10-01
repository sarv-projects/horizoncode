//! The `grep` tool: regex content search within the workspace.

use super::read::{MAX_READ_FILE_BYTES, read_file_bounded_to};
use crate::builtin::{
    assert_action, check_sandbox_read, display_path, is_binary, object_schema, optional_str,
    optional_usize, read_only_walk, require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};
use async_trait::async_trait;
use globset::Glob;
use horizoncode_types::ToolDefinition;
use regex::Regex;
use serde_json::{Value, json};
use std::fs::File;

const DEFAULT_LIMIT: usize = 100;
const MAX_LIMIT: usize = 1000;
const MAX_LINE_CHARS: usize = 400;
const MAX_SEARCH_INPUT_BYTES: u64 = 67_108_864;

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
        let mut visited = 0usize;
        let mut scanned_bytes = 0u64;
        'outer: for entry in read_only_walk(ctx, &base)? {
            let entry = entry?;
            visited += 1;
            if visited % 64 == 0 {
                tokio::task::yield_now().await;
                if ctx.cancel.is_cancelled() {
                    return Err(ToolError::Aborted("grep search cancelled".to_owned()));
                }
            }
            let relative = display_path(&ctx.workspace, entry.path());
            let file_type = entry.file_type().ok_or_else(|| ToolError::Io {
                path: entry.path().to_path_buf(),
                message: "could not determine entry type during traversal".to_owned(),
            })?;
            if file_type.is_dir() {
                // Check before the next iterator step can descend into this
                // directory. A denied subtree invalidates the complete search.
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            if let Some(include) = &include
                && !include.is_match(&relative)
            {
                continue;
            }
            check_sandbox_read(ctx, entry.path())?;
            let mut file = File::open(entry.path()).map_err(|error| ToolError::Io {
                path: entry.path().to_path_buf(),
                message: error.to_string(),
            })?;
            let metadata = file.metadata().map_err(|error| ToolError::Io {
                path: entry.path().to_path_buf(),
                message: error.to_string(),
            })?;
            if !metadata.is_file() {
                return Err(ToolError::UnsupportedTarget(relative));
            }
            let bytes = read_search_file(
                &mut file,
                entry.path(),
                &relative,
                metadata.len(),
                scanned_bytes,
            )?;
            scanned_bytes = scanned_bytes.saturating_add(bytes.len() as u64);
            if is_binary(&bytes) {
                continue;
            }
            let text = String::from_utf8_lossy(&bytes);
            for (index, line) in text.lines().enumerate() {
                if index % 256 == 255 {
                    tokio::task::yield_now().await;
                    if ctx.cancel.is_cancelled() {
                        return Err(ToolError::Aborted("grep search cancelled".to_owned()));
                    }
                }
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

fn read_search_file(
    file: &mut File,
    path: &std::path::Path,
    resource: &str,
    reported_bytes: u64,
    already_scanned_bytes: u64,
) -> Result<Vec<u8>, ToolError> {
    if reported_bytes > MAX_READ_FILE_BYTES {
        return Err(ToolError::OutputLimit {
            resource: resource.to_owned(),
            limit_bytes: MAX_READ_FILE_BYTES,
            observed_bytes: reported_bytes,
        });
    }
    let remaining = MAX_SEARCH_INPUT_BYTES.saturating_sub(already_scanned_bytes);
    if reported_bytes > remaining {
        return Err(ToolError::SearchLimit {
            resource: "aggregate grep input bytes".to_owned(),
            limit: MAX_SEARCH_INPUT_BYTES,
            observed: already_scanned_bytes.saturating_add(reported_bytes),
        });
    }
    read_file_bounded_to(file, path, resource, reported_bytes, remaining)
}

#[cfg(test)]
mod tests {
    use super::read_search_file;
    use crate::error::ToolError;
    use std::io::Seek;

    #[test]
    fn aggregate_grep_budget_accepts_exact_total_and_rejects_the_next_byte() {
        const TEST_BUDGET: u64 = 8;
        let dir = tempfile::tempdir().unwrap();
        let first_path = dir.path().join("first.txt");
        let second_path = dir.path().join("second.txt");
        std::fs::write(&first_path, b"12345678").unwrap();
        std::fs::write(&second_path, b"x").unwrap();
        let mut first = std::fs::File::open(&first_path).unwrap();
        let mut second = std::fs::File::open(&second_path).unwrap();

        // The pure boundary is factored through the production helper by
        // temporarily exercising its fixed budget with a pre-consumed amount.
        // An exact-limit read is accepted; the next byte is refused before IO.
        let exact = read_search_file(
            &mut first,
            &first_path,
            "first.txt",
            TEST_BUDGET,
            super::MAX_SEARCH_INPUT_BYTES - TEST_BUDGET,
        )
        .unwrap();
        assert_eq!(exact.len() as u64, TEST_BUDGET);
        let result = read_search_file(
            &mut second,
            &second_path,
            "second.txt",
            1,
            super::MAX_SEARCH_INPUT_BYTES,
        );
        assert!(matches!(
            result,
            Err(ToolError::SearchLimit {
                resource,
                limit,
                observed
            }) if resource == "aggregate grep input bytes"
                && limit == super::MAX_SEARCH_INPUT_BYTES
                && observed == super::MAX_SEARCH_INPUT_BYTES + 1
        ));
        assert_eq!(second.stream_position().unwrap(), 0);
    }
}
