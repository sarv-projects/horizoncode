//! The `apply_patch` tool: add/update/delete hunks applied sequentially.

use agentx_types::{ContentPart, ToolDefinition};
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, check_sandbox_write, display_path, object_schema, require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

/// A parsed file operation.
#[derive(Clone, Debug)]
enum Op {
    Add { path: String, content: String },
    Update { path: String, hunks: Vec<Hunk> },
    Delete { path: String },
}

impl Op {
    fn path(&self) -> &str {
        match self {
            Self::Add { path, .. } | Self::Update { path, .. } | Self::Delete { path } => path,
        }
    }
}

/// One contiguous update hunk.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Hunk {
    old: Vec<String>,
    new: Vec<String>,
}

/// Applies a structured patch to workspace files.
#[derive(Debug, Default)]
pub struct ApplyPatchTool;

#[async_trait]
impl Tool for ApplyPatchTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "apply_patch",
            "Apply a structured patch with `*** Add File:`, `*** Update File:` \
             (with `@@` hunks) and `*** Delete File:` sections, wrapped in \
             `*** Begin Patch`/`*** End Patch`. Update hunks must match uniquely.",
            object_schema(
                json!({
                    "patchText": {
                        "type": "string",
                        "description": "The patch body."
                    }
                }),
                &["patchText"],
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
        let patch = require_str(&input, "patchText")?;
        let ops = parse_patch(&patch)?;

        // Resolve and approve every target before reading or writing contents.
        let mut targets = Vec::with_capacity(ops.len());
        for op in &ops {
            let resolved = resolve_workspace_path(&ctx.workspace, op.path())?;
            targets.push((op.clone(), resolved));
        }
        let resources: Vec<String> = ops.iter().map(|op| op.path().to_owned()).collect();
        assert_action(ctx, "edit", resources).await?;

        let mut applied: Vec<String> = Vec::new();
        let mut summary: Vec<String> = Vec::new();
        for (op, resolved) in &targets {
            let display = display_path(&ctx.workspace, resolved);
            check_sandbox_write(ctx, resolved)?;
            let step = apply_one(op, resolved, ctx)?;
            summary.push(format!("{step} {display}"));
            applied.push(format!("{step} {display}"));
        }
        Ok(ToolOutput {
            model_content: vec![ContentPart::text(summary.join("\n"))],
            structured: Some(json!({ "operations": summary })),
            ui_detail: None,
        })
    }
}

fn apply_one(op: &Op, resolved: &std::path::Path, ctx: &ToolContext) -> Result<char, ToolError> {
    match op {
        Op::Add { content, .. } => {
            let existed = resolved.exists();
            if let Some(parent) = resolved.parent() {
                std::fs::create_dir_all(parent).map_err(|error| ToolError::Io {
                    path: parent.to_path_buf(),
                    message: error.to_string(),
                })?;
            }
            std::fs::write(resolved, content).map_err(|error| ToolError::Io {
                path: resolved.to_path_buf(),
                message: error.to_string(),
            })?;
            Ok(if existed { 'M' } else { 'A' })
        }
        Op::Delete { .. } => {
            if !resolved.exists() {
                return Err(ToolError::NotFound(display_path(&ctx.workspace, resolved)));
            }
            std::fs::remove_file(resolved).map_err(|error| ToolError::Io {
                path: resolved.to_path_buf(),
                message: error.to_string(),
            })?;
            Ok('D')
        }
        Op::Update { hunks, path } => {
            let bytes = std::fs::read(resolved).map_err(|error| ToolError::Io {
                path: resolved.to_path_buf(),
                message: error.to_string(),
            })?;
            let text = String::from_utf8(bytes)
                .map_err(|_| ToolError::InvalidInput(format!("`{path}` is not valid UTF-8")))?;
            let updated = apply_hunks(&text, hunks, path)?;
            std::fs::write(resolved, updated).map_err(|error| ToolError::Io {
                path: resolved.to_path_buf(),
                message: error.to_string(),
            })?;
            Ok('M')
        }
    }
}

fn parse_patch(text: &str) -> Result<Vec<Op>, ToolError> {
    let mut ops = Vec::new();
    let lines: Vec<&str> = text.lines().collect();
    let mut index = 0;
    while index < lines.len() {
        let line = lines[index].trim_end();
        index += 1;
        if line.is_empty()
            || line.starts_with("*** Begin Patch")
            || line.starts_with("*** End Patch")
        {
            continue;
        }
        if let Some(path) = line.strip_prefix("*** Add File:") {
            let mut content = String::new();
            while index < lines.len() && !lines[index].trim_end().starts_with("*** ") {
                let body = lines[index]
                    .strip_prefix('+')
                    .ok_or_else(|| invalid("add-file lines must start with `+`"))?;
                content.push_str(body);
                content.push('\n');
                index += 1;
            }
            ops.push(Op::Add {
                path: path.trim().to_owned(),
                content,
            });
        } else if let Some(path) = line.strip_prefix("*** Delete File:") {
            ops.push(Op::Delete {
                path: path.trim().to_owned(),
            });
        } else if let Some(path) = line.strip_prefix("*** Update File:") {
            let mut body = Vec::new();
            while index < lines.len() && !lines[index].trim_end().starts_with("*** ") {
                body.push(lines[index].to_owned());
                index += 1;
            }
            ops.push(Op::Update {
                path: path.trim().to_owned(),
                hunks: parse_hunks(&body)?,
            });
        } else {
            return Err(invalid(format!("unexpected patch line `{line}`")));
        }
    }
    if ops.is_empty() {
        return Err(invalid("patch contains no file operations"));
    }
    Ok(ops)
}

fn parse_hunks(body: &[String]) -> Result<Vec<Hunk>, ToolError> {
    let mut hunks = Vec::new();
    let mut current: Vec<String> = Vec::new();
    for line in body {
        if line.trim_start().starts_with("@@") {
            if !current.is_empty() {
                hunks.push(build_hunk(&current)?);
                current.clear();
            }
            continue;
        }
        current.push(line.clone());
    }
    if !current.is_empty() {
        hunks.push(build_hunk(&current)?);
    }
    if hunks.is_empty() {
        return Err(invalid("update hunk is empty"));
    }
    Ok(hunks)
}

fn build_hunk(lines: &[String]) -> Result<Hunk, ToolError> {
    let mut old = Vec::new();
    let mut new = Vec::new();
    for line in lines {
        if let Some(rest) = line.strip_prefix(' ') {
            old.push(rest.to_owned());
            new.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('-') {
            old.push(rest.to_owned());
        } else if let Some(rest) = line.strip_prefix('+') {
            new.push(rest.to_owned());
        } else if line.is_empty() {
            old.push(String::new());
            new.push(String::new());
        } else {
            return Err(invalid(format!("invalid hunk line `{line}`")));
        }
    }
    if old == new {
        return Err(invalid("hunk contains no changes"));
    }
    Ok(Hunk { old, new })
}

fn apply_hunks(text: &str, hunks: &[Hunk], path: &str) -> Result<String, ToolError> {
    let trailing_newline = text.ends_with('\n');
    let mut lines: Vec<String> = text.lines().map(str::to_owned).collect();
    for hunk in hunks {
        if hunk.old.is_empty() {
            return Err(invalid("cannot apply an empty hunk"));
        }
        let mut found: Option<usize> = None;
        let mut count = 0usize;
        let limit = lines.len().saturating_sub(hunk.old.len());
        for start in 0..=limit {
            if lines[start..start + hunk.old.len()] == hunk.old[..] {
                count += 1;
                found = Some(start);
            }
        }
        match (count, found) {
            (0, _) => return Err(invalid(format!("hunk did not match `{path}`"))),
            (1, Some(start)) => {
                lines.splice(start..start + hunk.old.len(), hunk.new.iter().cloned());
            }
            _ => {
                return Err(invalid(format!(
                    "hunk matched {count} locations in `{path}`; add more context"
                )));
            }
        }
    }
    let mut out = lines.join("\n");
    if trailing_newline && !out.is_empty() {
        out.push('\n');
    }
    Ok(out)
}

fn invalid(message: impl Into<String>) -> ToolError {
    ToolError::InvalidInput(message.into())
}
