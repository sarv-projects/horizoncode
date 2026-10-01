//! The `write` tool: create or overwrite a workspace file.

use async_trait::async_trait;
use horizoncode_types::ToolDefinition;
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, check_sandbox_write, display_path, object_schema, optional_str, require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};
use crate::write::{check_base_pin, file_digest, write_with_base_check};

/// The maximum accepted write payload.
const MAX_WRITE_BYTES: usize = 4 * 1024 * 1024;

/// Creates or overwrites a UTF-8 file inside the workspace.
#[derive(Debug, Default)]
pub struct WriteTool;

#[async_trait]
impl Tool for WriteTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "write",
            "Create or overwrite a file in the workspace. Parent directories are \
             created as needed. Provide the full new contents.",
            object_schema(
                json!({
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute path."
                    },
                    "content": {
                        "type": "string",
                        "description": "The complete new file contents."
                    },
                    "expectedBaseHash": {
                        "type": "string",
                        "description": "Optional hex digest of the file as you last read it. A mismatch is a typed conflict instead of a silent overwrite."
                    }
                }),
                &["path", "content"],
            ),
            None,
        )
    }

    fn action(&self) -> String {
        // `write`, `edit` and `apply_patch` share one governed write action.
        "edit".to_owned()
    }

    fn supports_parallel(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let raw = require_str(&input, "path")?;
        let content = input
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`content` must be a string".to_owned()))?;
        if content.len() > MAX_WRITE_BYTES {
            return Err(ToolError::InvalidInput(format!(
                "`content` is {} bytes; the maximum is {MAX_WRITE_BYTES}",
                content.len()
            )));
        }
        let resolved = resolve_workspace_path(&ctx.workspace, &raw)?;
        // The approved base is the file as it stands *before* authorization:
        // anything that changes it afterwards is a concurrent change, and the
        // write is refused rather than silently overwriting it (`ARCH/10`).
        let base = std::fs::read(&resolved).unwrap_or_default();
        check_base_pin(
            optional_str(&input, "expectedBaseHash").as_deref(),
            &resolved,
            &base,
        )?;
        assert_action(ctx, "edit", vec![raw.clone()], Vec::new()).await?;
        check_sandbox_write(ctx, &resolved)?;
        let existed = resolved.exists();
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).map_err(|error| ToolError::Io {
                path: parent.to_path_buf(),
                message: error.to_string(),
            })?;
            // Creating the parent can follow a symlink, so re-resolve and re-check
            // the scope before the write (`REQ-SEC-004`).
            let recheck = resolve_workspace_path(&ctx.workspace, &raw)?;
            check_sandbox_write(ctx, &recheck)?;
        }
        write_with_base_check(&resolved, &base, content.as_bytes())?;
        let display = display_path(&ctx.workspace, &resolved);
        let verb = if existed { "Wrote" } else { "Created" };
        Ok(ToolOutput {
            model_content: vec![horizoncode_types::ContentPart::text(format!(
                "{verb} file successfully: {display}"
            ))],
            structured: Some(json!({
                "path": display,
                "bytes": content.len(),
                "created": !existed,
                // The digest of what is now on disk, so a later write or edit can
                // pin the base it approved instead of trusting its own read.
                "baseHash": file_digest(content.as_bytes()),
            })),
            ui_detail: None,
        })
    }
}
