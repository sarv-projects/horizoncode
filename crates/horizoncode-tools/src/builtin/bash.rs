//! The `bash` tool: run a shell command through the confinement backend.

use horizoncode_sandbox::{SandboxCommand, SandboxError, SandboxOutcome};
use horizoncode_types::{ContentPart, ToolDefinition};
use async_trait::async_trait;
use serde_json::{Value, json};

use crate::builtin::{
    assert_action, display_path, object_schema, optional_str, optional_usize, require_str,
};
use crate::error::ToolError;
use crate::path::resolve_workspace_path;
use crate::registry::{Tool, ToolContext, ToolOutput};

/// The default shell timeout in milliseconds.
const DEFAULT_TIMEOUT_MS: u64 = 120_000;
/// The maximum shell timeout in milliseconds.
const MAX_TIMEOUT_MS: u64 = 600_000;

/// Runs a shell command under the resolved sandbox profile.
#[derive(Debug, Default)]
pub struct BashTool;

#[async_trait]
impl Tool for BashTool {
    fn definition(&self) -> ToolDefinition {
        ToolDefinition::new(
            "bash",
            "Run a shell command inside the sandbox. The default profile allows \
             workspace writes and no outbound network. `timeout` is bounded.",
            object_schema(
                json!({
                    "command": {
                        "type": "string",
                        "description": "The shell command to run (executed with `sh -c`)."
                    },
                    "workdir": {
                        "type": "string",
                        "description": "Working directory inside the workspace (default the workspace root)."
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Wall-clock timeout in milliseconds (default 120000, max 600000).",
                        "minimum": 1
                    }
                }),
                &["command"],
            ),
            None,
        )
    }

    fn action(&self) -> String {
        "bash".to_owned()
    }

    fn supports_parallel(&self) -> bool {
        false
    }

    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError> {
        let command = require_str(&input, "command")?;
        let targets = crate::registry::additional_targets_from_input(&input);
        assert_action(ctx, "bash", vec![command.clone()], targets).await?;

        let (Some(sandbox), Some(resolved)) = (&ctx.sandbox, &ctx.resolved) else {
            return Err(ToolError::Unavailable(
                "no sandbox backend is available; refusing to run a shell unconfined".to_owned(),
            ));
        };
        let workdir = match optional_str(&input, "workdir") {
            Some(raw) => resolve_workspace_path(&ctx.workspace, &raw)?,
            None => ctx.workspace.clone(),
        };
        let timeout = optional_usize(&input, "timeout")?
            .map(|value| value as u64)
            .unwrap_or(DEFAULT_TIMEOUT_MS)
            .clamp(1, MAX_TIMEOUT_MS);

        let mut resolved = (**resolved).clone();
        resolved.limits.wall_clock_ms = Some(timeout);
        let sandbox = sandbox.clone();
        let sandbox_command = SandboxCommand::new("/bin/sh")
            .arg("-c")
            .arg(&command)
            .cwd(workdir.clone());
        let outcome =
            tokio::task::spawn_blocking(move || sandbox.spawn(&sandbox_command, &resolved))
                .await
                .map_err(|error| ToolError::Execute(format!("shell task failed: {error}")))?
                .map_err(map_sandbox_error)?;

        Ok(ToolOutput {
            model_content: vec![ContentPart::text(render(
                &command,
                &workdir,
                &ctx.workspace,
                &outcome,
                timeout,
            ))],
            structured: Some(json!({
                "exit_code": outcome.exit_code,
                "timed_out": outcome.timed_out,
                "backend": outcome.backend,
                "profile": outcome.profile.as_str(),
            })),
            ui_detail: Some(json!({
                "stdout": outcome.stdout,
                "stderr": outcome.stderr,
            })),
        })
    }
}

fn render(
    command: &str,
    workdir: &std::path::Path,
    workspace: &std::path::Path,
    outcome: &SandboxOutcome,
    timeout: u64,
) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "$ {command}  (in {})\n",
        display_path(workspace, workdir)
    ));
    if !outcome.stdout.is_empty() {
        out.push_str(&outcome.stdout);
    }
    if !outcome.stderr.is_empty() {
        if !out.is_empty() && !out.ends_with('\n') {
            out.push('\n');
        }
        out.push_str("[stderr]\n");
        out.push_str(&outcome.stderr);
    }
    if outcome.timed_out {
        out.push_str(&format!("\n[timed out after {timeout} ms]"));
    } else {
        let code = outcome
            .exit_code
            .map_or_else(|| "signal".to_owned(), |code| code.to_string());
        out.push_str(&format!("\n[exit code: {code}]"));
    }
    out
}

fn map_sandbox_error(error: SandboxError) -> ToolError {
    match error {
        SandboxError::Unsupported { .. } | SandboxError::Unavailable { .. } => {
            ToolError::Unavailable(error.to_string())
        }
        other => ToolError::Execute(other.to_string()),
    }
}
