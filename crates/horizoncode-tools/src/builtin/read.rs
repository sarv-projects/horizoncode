//! The `read` tool: a file page or a directory listing.

use async_trait::async_trait;
use horizoncode_types::ToolDefinition;
use serde_json::{Value, json};
use std::io::Read;

use crate::builtin::{
    assert_action, check_sandbox_read, display_path, object_schema, optional_usize, require_str,
    sort_entries,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

const DEFAULT_LIMIT: usize = 2000;
const MAX_LIMIT: usize = 20_000;
pub(super) const MAX_READ_FILE_BYTES: u64 = 16_777_216;

/// Reads a file page (with optional line window) or lists a directory.
#[derive(Debug, Default)]
pub struct ReadTool;

#[async_trait]
impl Tool for ReadTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "read",
            "Read a UTF-8 text file up to 16 MiB from the workspace, or list a directory. \
             Use offset/limit to page through files; larger files return a typed size error.",
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
        // workspace check above (`ARCH/security/SANDBOX.md`, `REQ-SEC-025`).
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
        if !metadata.is_file() {
            return Err(ToolError::UnsupportedTarget(display_path(
                &ctx.workspace,
                &resolved,
            )));
        }

        let display = display_path(&ctx.workspace, &resolved);
        let mut file = std::fs::File::open(&resolved).map_err(|error| ToolError::Io {
            path: resolved.clone(),
            message: error.to_string(),
        })?;
        let opened_metadata = file.metadata().map_err(|error| ToolError::Io {
            path: resolved.clone(),
            message: error.to_string(),
        })?;
        if opened_metadata.is_dir() {
            return Ok(ToolOutput::text(list_directory(&ctx.workspace, &resolved)?));
        }
        if !opened_metadata.is_file() {
            return Err(ToolError::UnsupportedTarget(display.clone()));
        }
        let bytes = read_file_bounded(&mut file, &resolved, &display, opened_metadata.len())?;
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

pub(super) fn read_file_bounded(
    file: &mut std::fs::File,
    path: &std::path::Path,
    resource: &str,
    reported_bytes: u64,
) -> Result<Vec<u8>, ToolError> {
    read_file_bounded_to(file, path, resource, reported_bytes, MAX_READ_FILE_BYTES)
}

pub(super) fn read_file_bounded_to(
    file: &mut std::fs::File,
    path: &std::path::Path,
    resource: &str,
    reported_bytes: u64,
    byte_limit: u64,
) -> Result<Vec<u8>, ToolError> {
    let byte_limit = byte_limit.min(MAX_READ_FILE_BYTES);
    if reported_bytes > byte_limit {
        return Err(ToolError::OutputLimit {
            resource: resource.to_owned(),
            limit_bytes: byte_limit,
            observed_bytes: reported_bytes,
        });
    }

    let capacity = usize::try_from(reported_bytes).unwrap_or(MAX_READ_FILE_BYTES as usize);
    let mut bytes = Vec::with_capacity(capacity);
    file.take(byte_limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| ToolError::Io {
            path: path.to_path_buf(),
            message: error.to_string(),
        })?;
    if bytes.len() as u64 > byte_limit {
        return Err(ToolError::OutputLimit {
            resource: resource.to_owned(),
            limit_bytes: byte_limit,
            observed_bytes: bytes.len() as u64,
        });
    }
    Ok(bytes)
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

#[cfg(test)]
mod tests {
    use super::{MAX_READ_FILE_BYTES, read_file_bounded};
    use crate::error::ToolError;
    use std::io::Seek;

    #[test]
    fn bounded_reader_accepts_exact_limit_and_detects_growth_after_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("at-limit.bin");
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.set_len(MAX_READ_FILE_BYTES).unwrap();
        let bytes =
            read_file_bounded(&mut file, &path, "at-limit.bin", MAX_READ_FILE_BYTES).unwrap();
        assert_eq!(bytes.len() as u64, MAX_READ_FILE_BYTES);

        let path = dir.path().join("grew.bin");
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.set_len(MAX_READ_FILE_BYTES + 1).unwrap();
        // Simulate a stale metadata observation. The reader still detects growth
        // while retaining no partial bytes in its error result.
        let result = read_file_bounded(&mut file, &path, "grew.bin", 0);
        assert!(matches!(
            result,
            Err(ToolError::OutputLimit {
                limit_bytes: MAX_READ_FILE_BYTES,
                observed_bytes,
                ..
            }) if observed_bytes == MAX_READ_FILE_BYTES + 1
        ));
        assert_eq!(file.stream_position().unwrap(), MAX_READ_FILE_BYTES + 1);
    }

    #[test]
    fn bounded_reader_refuses_reported_oversize_before_reading() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("over-limit.bin");
        let mut file = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&path)
            .unwrap();
        file.set_len(MAX_READ_FILE_BYTES + 1).unwrap();
        let result = read_file_bounded(&mut file, &path, "over-limit.bin", MAX_READ_FILE_BYTES + 1);
        assert!(matches!(
            result,
            Err(ToolError::OutputLimit {
                limit_bytes: MAX_READ_FILE_BYTES,
                observed_bytes,
                ..
            }) if observed_bytes == MAX_READ_FILE_BYTES + 1
        ));
        assert_eq!(file.stream_position().unwrap(), 0);
    }
}
