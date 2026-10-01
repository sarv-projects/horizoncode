//! The `edit` tool: a unique string replacement with a bounded diff preview.

use async_trait::async_trait;
use horizoncode_types::{ContentPart, ToolDefinition};
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, check_sandbox_write, display_path, object_schema, optional_bool, optional_str,
    require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};
use crate::write::{check_base_pin, file_digest, write_with_base_check};

/// The maximum number of preview lines in the model-visible diff.
const MAX_DIFF_LINES: usize = 40;

/// Replaces `oldString` with `newString` in a workspace file.
#[derive(Debug, Default)]
pub struct EditTool;

#[async_trait]
impl Tool for EditTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "edit",
            "Replace an exact string in a workspace file. `oldString` must match \
             exactly once unless `replaceAll` is true; empty or identical \
             `oldString`/`newString` are rejected.",
            object_schema(
                json!({
                    "path": {
                        "type": "string",
                        "description": "Workspace-relative or in-workspace absolute path."
                    },
                    "oldString": {
                        "type": "string",
                        "description": "The exact text to replace (must be unique unless replaceAll)."
                    },
                    "newString": {
                        "type": "string",
                        "description": "The replacement text (may be empty to delete)."
                    },
                    "replaceAll": {
                        "type": "boolean",
                        "description": "Replace every occurrence instead of requiring a unique match."
                    },
                    "expectedBaseHash": {
                        "type": "string",
                        "description": "Optional hex digest of the file as you last read it. A mismatch is a typed conflict instead of a silent overwrite."
                    }
                }),
                &["path", "oldString", "newString"],
            ),
            None,
        )
    }

    fn action(&self) -> String {
        "edit".to_owned()
    }

    fn supports_parallel(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let raw = require_str(&input, "path")?;
        let old = require_str(&input, "oldString")?;
        let new = input
            .get("newString")
            .and_then(Value::as_str)
            .ok_or_else(|| ToolError::InvalidInput("`newString` must be a string".to_owned()))?;
        if old == new {
            return Err(ToolError::InvalidInput(
                "`oldString` and `newString` are identical; nothing to replace".to_owned(),
            ));
        }
        let replace_all = optional_bool(&input, "replaceAll")?;
        let resolved = resolve_workspace_path(&ctx.workspace, &raw)?;
        let bytes = std::fs::read(&resolved).map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                ToolError::NotFound(raw.clone())
            } else {
                ToolError::Io {
                    path: resolved.clone(),
                    message: error.to_string(),
                }
            }
        })?;
        let text = String::from_utf8(bytes.clone()).map_err(|_| {
            ToolError::InvalidInput(format!("`{raw}` is not valid UTF-8; use write instead"))
        })?;
        check_base_pin(
            optional_str(&input, "expectedBaseHash").as_deref(),
            &resolved,
            &bytes,
        )?;
        let matches = text.matches(&old).count();
        if matches == 0 {
            return Err(ToolError::InvalidInput(format!(
                "`oldString` was not found in `{raw}`"
            )));
        }
        if matches > 1 && !replace_all {
            return Err(ToolError::InvalidInput(format!(
                "`oldString` matched {matches} times in `{raw}`; add more context or set replaceAll"
            )));
        }
        assert_action(ctx, "edit", vec![raw.clone()], Vec::new()).await?;
        check_sandbox_write(ctx, &resolved)?;
        let updated = if replace_all {
            text.replace(&old, new)
        } else {
            text.replacen(&old, new, 1)
        };
        // The bytes read above are the approved base: re-read and compare, so a
        // change made while the call was awaiting approval is a typed conflict
        // rather than a silent overwrite (`ARCH/10` §Mutations).
        write_with_base_check(&resolved, &bytes, updated.as_bytes())?;
        let display = display_path(&ctx.workspace, &resolved);
        let diff = diff_preview(&old, new);
        Ok(ToolOutput {
            model_content: vec![ContentPart::text(format!(
                "Edited {display} ({matches} replacement{}):\n{diff}",
                if matches == 1 { "" } else { "s" }
            ))],
            structured: Some(json!({
                "path": display,
                "replacements": if replace_all { matches } else { 1 },
                "baseHash": file_digest(updated.as_bytes()),
            })),
            ui_detail: Some(json!({ "path": display, "diff": diff })),
        })
    }
}

fn diff_preview(old: &str, new: &str) -> String {
    let mut lines = Vec::new();
    for line in old.lines() {
        lines.push(format!("-{line}"));
        if lines.len() >= MAX_DIFF_LINES {
            break;
        }
    }
    if lines.len() < MAX_DIFF_LINES {
        for line in new.lines() {
            lines.push(format!("+{line}"));
            if lines.len() >= MAX_DIFF_LINES {
                break;
            }
        }
    }
    if lines.len() == MAX_DIFF_LINES {
        lines.push("… [diff preview truncated]".to_owned());
    }
    lines.join("\n")
}
