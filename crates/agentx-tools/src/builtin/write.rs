//! The `write` tool: create or overwrite a workspace file.

use agentx_types::ToolDefinition;
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, check_sandbox_write, display_path, object_schema, require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

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
        assert_action(ctx, "edit", vec![raw.clone()]).await?;
        check_sandbox_write(ctx, &resolved)?;
        let existed = resolved.exists();
        if let Some(parent) = resolved.parent() {
            std::fs::create_dir_all(parent).map_err(|error| ToolError::Io {
                path: parent.to_path_buf(),
                message: error.to_string(),
            })?;
        }
        std::fs::write(&resolved, content).map_err(|error| ToolError::Io {
            path: resolved.clone(),
            message: error.to_string(),
        })?;
        let display = display_path(&ctx.workspace, &resolved);
        let verb = if existed { "Wrote" } else { "Created" };
        Ok(ToolOutput {
            model_content: vec![agentx_types::ContentPart::text(format!(
                "{verb} file successfully: {display}"
            ))],
            structured: Some(json!({
                "path": display,
                "bytes": content.len(),
                "created": !existed,
            })),
            ui_detail: None,
        })
    }
}
