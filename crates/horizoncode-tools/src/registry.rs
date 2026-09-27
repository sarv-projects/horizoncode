//! The tool registry: name validation, permission-filtered materialization, and
//! settlement.

use std::collections::BTreeMap;
use std::fmt::Debug;
use std::path::PathBuf;
use std::sync::Arc;

use horizoncode_types::{
    ContentPart, SessionId, ToolCall, ToolCallId, ToolDefinition, ToolStatus, TurnId,
    is_valid_tool_name,
};
use async_trait::async_trait;
use serde_json::Value;

use crate::bound::{OutputBounds, bound};
use crate::error::ToolError;
use crate::policy::{GateDecision, PermissionGate, PermissionRequest, PermissionTarget};

/// Borrowed context handed to a tool execution.
#[derive(Clone, Debug)]
pub struct ToolContext {
    /// The owning session.
    pub session_id: SessionId,
    /// The owning turn, when the call is inside one.
    pub turn_id: Option<TurnId>,
    /// The call identity.
    pub tool_call_id: ToolCallId,
    /// The workspace root for path-scoped tools.
    pub workspace: PathBuf,
    /// Where to spill oversized output, when managed output is enabled.
    pub output_dir: Option<PathBuf>,
    /// The guard seam, when the caller wants tools to re-assert before effects.
    pub gate: Option<Arc<dyn PermissionGate>>,
    /// The confinement backend, when shell effects are available.
    pub sandbox: Option<Arc<dyn horizoncode_sandbox::SandboxProvider>>,
    /// The resolved confinement plan matching `sandbox`.
    pub resolved: Option<Arc<horizoncode_sandbox::ResolvedProfile>>,
}

impl ToolContext {
    /// Builds a context with no turn, gate, sandbox or managed-output directory.
    #[must_use]
    pub fn new(
        session_id: impl Into<SessionId>,
        tool_call_id: impl Into<ToolCallId>,
        workspace: impl Into<PathBuf>,
    ) -> Self {
        Self {
            session_id: session_id.into(),
            turn_id: None,
            tool_call_id: tool_call_id.into(),
            workspace: workspace.into(),
            output_dir: None,
            gate: None,
            sandbox: None,
            resolved: None,
        }
    }

    /// Attaches the guard seam so mutating tools re-assert before an effect.
    #[must_use]
    pub fn with_gate(mut self, gate: Arc<dyn PermissionGate>) -> Self {
        self.gate = Some(gate);
        self
    }

    /// Attaches the confinement backend and resolved plan.
    #[must_use]
    pub fn with_sandbox(
        mut self,
        sandbox: Arc<dyn horizoncode_sandbox::SandboxProvider>,
        resolved: Arc<horizoncode_sandbox::ResolvedProfile>,
    ) -> Self {
        self.sandbox = Some(sandbox);
        self.resolved = Some(resolved);
        self
    }

    /// Attaches only the resolved reach plan.
    ///
    /// An in-process path operation is scoped by the plan alone — the spawn
    /// backend is only needed to *run* something — so a caller that performs no
    /// shell effects still gets the full filesystem scope.
    #[must_use]
    pub fn with_resolved_scope(mut self, resolved: horizoncode_sandbox::ResolvedProfile) -> Self {
        self.resolved = Some(Arc::new(resolved));
        self
    }

    /// Returns whether a reach plan is in force.
    ///
    /// `false` means the confinement layer resolved nothing, so no filesystem
    /// operation is enforced and every effectful tool must fail closed.
    #[must_use]
    pub fn has_scope(&self) -> bool {
        self.resolved.is_some()
    }
}

/// A tool's execution result before settlement.
#[derive(Clone, Debug)]
pub struct ToolOutput {
    /// The model-visible content.
    pub model_content: Vec<ContentPart>,
    /// An optional machine-readable projection.
    pub structured: Option<Value>,
    /// UI-only detail (full diffs, absolute paths, timing).
    pub ui_detail: Option<Value>,
}

impl ToolOutput {
    /// Builds a text-only output.
    #[must_use]
    pub fn text(text: impl Into<String>) -> Self {
        Self {
            model_content: vec![ContentPart::text(text)],
            structured: None,
            ui_detail: None,
        }
    }
}

/// The settled result of one tool call.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct Settlement {
    /// The tool name.
    pub tool: String,
    /// The answered call.
    pub tool_call_id: ToolCallId,
    /// The outcome class.
    pub status: ToolStatus,
    /// The model-visible content (`REQ-TOOL-004`).
    pub model_content: Vec<ContentPart>,
    /// An optional structured projection.
    pub structured: Option<Value>,
    /// UI-only detail (`REQ-TOOL-004`).
    pub ui_detail: Option<Value>,
    /// Managed output files written for oversized content.
    pub output_paths: Vec<String>,
    /// A stable error code for failures.
    pub error_code: Option<String>,
}

impl Settlement {
    /// Concatenates the model-visible text.
    #[must_use]
    pub fn model_text(&self) -> String {
        self.model_content
            .iter()
            .filter_map(|part| part.as_text())
            .collect::<Vec<_>>()
            .join("")
    }

    fn failure(
        tool: String,
        tool_call_id: ToolCallId,
        status: ToolStatus,
        message: impl Into<String>,
        code: &str,
    ) -> Self {
        Self {
            tool,
            tool_call_id,
            status,
            model_content: vec![ContentPart::text(message)],
            structured: None,
            ui_detail: None,
            output_paths: Vec::new(),
            error_code: Some(code.to_owned()),
        }
    }
}

/// The permission-filtered set advertised to the model.
#[derive(Clone, Debug, Default)]
pub struct Materialization {
    /// Advertised definitions.
    pub definitions: Vec<ToolDefinition>,
    /// Advertised names, in the same order.
    pub names: Vec<String>,
}

/// A model-facing capability.
#[async_trait]
pub trait Tool: Send + Sync + Debug {
    /// Returns this tool's advertisement.
    fn definition(&self) -> ToolDefinition;

    /// Returns the policy action asserted before execution.
    ///
    /// Defaults to the tool name (`ARCH/10-TOOLS.md`).
    fn action(&self) -> String {
        self.definition().name
    }

    /// Returns whether independent calls may run concurrently.
    fn supports_parallel(&self) -> bool {
        true
    }

    /// Executes the tool with validated input.
    ///
    /// # Errors
    /// Returns a typed [`ToolError`] on any failure; it is never a panic.
    async fn execute(&self, input: Value, ctx: &ToolContext) -> Result<ToolOutput, ToolError>;
}

/// The single registry of first-party and bridged tools.
#[derive(Debug, Default)]
pub struct ToolRegistry {
    tools: BTreeMap<String, Arc<dyn Tool>>,
    spill_dir: Option<PathBuf>,
}

impl ToolRegistry {
    /// Builds an empty registry.
    #[must_use]
    pub fn new() -> Self {
        Self::default()
    }

    /// Registers one tool, validating its name first.
    ///
    /// # Errors
    /// Returns [`ToolError::InvalidInput`] when the name is invalid.
    pub fn register(&mut self, tool: Arc<dyn Tool>) -> Result<(), ToolError> {
        let name = tool.definition().name;
        if !is_valid_tool_name(&name) {
            return Err(ToolError::InvalidInput(format!(
                "invalid tool name `{name}` (must match ^[A-Za-z][A-Za-z0-9_-]{{0,63}}$)"
            )));
        }
        self.tools.insert(name, tool);
        Ok(())
    }

    /// Registers a batch atomically: if any name is invalid, nothing is stored.
    ///
    /// # Errors
    /// Returns [`ToolError::InvalidInput`] naming the first invalid tool.
    pub fn register_all(&mut self, tools: Vec<Arc<dyn Tool>>) -> Result<(), ToolError> {
        for tool in &tools {
            let name = tool.definition().name;
            if !is_valid_tool_name(&name) {
                return Err(ToolError::InvalidInput(format!(
                    "invalid tool name `{name}`; registration batch rejected"
                )));
            }
        }
        for tool in tools {
            self.tools.insert(tool.definition().name, tool);
        }
        Ok(())
    }

    /// Returns whether a tool is registered.
    #[must_use]
    pub fn contains(&self, name: &str) -> bool {
        self.tools.contains_key(name)
    }

    /// Returns whether independent calls to `name` may run concurrently.
    ///
    /// Unknown tools report `true`; the settle path answers them with a typed
    /// `TOOL_UNKNOWN` result.
    #[must_use]
    pub fn supports_parallel(&self, name: &str) -> bool {
        self.tools
            .get(name)
            .is_none_or(|tool| tool.supports_parallel())
    }

    /// Returns the policy action for a tool, when registered.
    #[must_use]
    pub fn action_for(&self, name: &str) -> Option<String> {
        self.tools.get(name).map(|tool| tool.action())
    }

    /// Returns the number of registered tools.
    #[must_use]
    pub fn len(&self) -> usize {
        self.tools.len()
    }

    /// Returns whether the registry is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.tools.is_empty()
    }

    /// Materializes the permission-filtered advertised set.
    ///
    /// A wholly-denied action removes the tool entirely (`REQ-TOOL-003`).
    #[must_use]
    pub fn materialize(&self, gate: &dyn PermissionGate) -> Materialization {
        let mut materialization = Materialization::default();
        for tool in self.tools.values() {
            if gate.wholly_denied(&tool.action()) {
                continue;
            }
            let definition = tool.definition();
            materialization.names.push(definition.name.clone());
            materialization.definitions.push(definition);
        }
        materialization
    }

    /// Builds the policy request for a call, when the tool is registered.
    #[must_use]
    pub fn permission_request(
        &self,
        call: &ToolCall,
        ctx: &ToolContext,
    ) -> Option<PermissionRequest> {
        let tool = self.tools.get(&call.name)?;
        let action = tool.action();
        Some(PermissionRequest {
            action: action.clone(),
            tool_name: call.name.clone(),
            resources: resources_from_input(&call.arguments),
            session_id: ctx.session_id.clone(),
            source: call.id.clone(),
            metadata: serde_json::json!({
                "action": action,
                "tool": call.name,
                "workspace": ctx.workspace.to_string_lossy(),
            }),
            targets: additional_targets_from_input(&call.arguments),
        })
    }

    /// Settles one tool call.
    ///
    /// Returns a typed [`Settlement`] in every case, so the loop always has a
    /// model-visible result (`REQ-LOOP-004`).
    pub async fn settle(
        &self,
        call: &ToolCall,
        ctx: &ToolContext,
        gate: &dyn PermissionGate,
        bounds: &OutputBounds,
    ) -> Settlement {
        let Some(tool) = self.tools.get(&call.name).cloned() else {
            return Settlement::failure(
                call.name.clone(),
                call.id.clone(),
                ToolStatus::Error,
                format!("Unknown tool: {}", call.name),
                "TOOL_UNKNOWN",
            );
        };
        let Some(request) = self.permission_request(call, ctx) else {
            return Settlement::failure(
                call.name.clone(),
                call.id.clone(),
                ToolStatus::Error,
                format!("Unknown tool: {}", call.name),
                "TOOL_UNKNOWN",
            );
        };
        if let GateDecision::Deny { reason } = gate.authorize(&request).await {
            return Settlement::failure(
                call.name.clone(),
                call.id.clone(),
                ToolStatus::Denied,
                format!("Permission denied for `{}`: {reason}", call.name),
                "TOOL_DENIED",
            );
        }

        match tool.execute(call.arguments.clone(), ctx).await {
            Ok(output) => self.success_settlement(call, output, bounds),
            Err(error) => {
                let status = match error {
                    ToolError::Denied(_) => ToolStatus::Denied,
                    ToolError::Aborted(_) => ToolStatus::Aborted,
                    _ => ToolStatus::Error,
                };
                Settlement::failure(
                    call.name.clone(),
                    call.id.clone(),
                    status,
                    error.model_message(),
                    error.code(),
                )
            }
        }
    }

    fn success_settlement(
        &self,
        call: &ToolCall,
        output: ToolOutput,
        bounds: &OutputBounds,
    ) -> Settlement {
        let mut output_paths = Vec::new();
        let mut model_content = Vec::with_capacity(output.model_content.len());
        for part in output.model_content {
            match part {
                ContentPart::Text { text } => {
                    let bounded = bound(&text, bounds);
                    if bounded.truncated
                        && let Some(dir) = &self.spill_dir
                        && let Ok(path) = spill(dir, call, &text)
                    {
                        output_paths.push(path);
                    }
                    model_content.push(ContentPart::text(bounded.text));
                }
                other => model_content.push(other),
            }
        }
        Settlement {
            tool: call.name.clone(),
            tool_call_id: call.id.clone(),
            status: ToolStatus::Success,
            model_content,
            structured: output.structured,
            ui_detail: output.ui_detail,
            output_paths,
            error_code: None,
        }
    }
}

/// Writes oversized content to a managed output file, returning its path.
fn spill(dir: &std::path::Path, call: &ToolCall, text: &str) -> Result<String, ToolError> {
    std::fs::create_dir_all(dir).map_err(|error| ToolError::Io {
        path: dir.to_path_buf(),
        message: error.to_string(),
    })?;
    let path = dir.join(format!("{}.txt", call.id.as_str()));
    std::fs::write(&path, text).map_err(|error| ToolError::Io {
        path: path.clone(),
        message: error.to_string(),
    })?;
    Ok(path.to_string_lossy().into_owned())
}

/// Collects the non-secret resources a call names, for policy metadata.
fn resources_from_input(input: &Value) -> Vec<String> {
    let mut resources = Vec::new();
    for key in ["path", "url", "pattern", "include", "command"] {
        if let Some(value) = input.get(key).and_then(Value::as_str) {
            resources.push(value.to_owned());
        }
    }
    resources
}

/// The additional `(action, resources)` pairs a call names.
///
/// A shell command is judged as a command prefix for `exec.run` **and** as the
/// `fs.*` paths its arguments name, in one request, so a path protection and the
/// external-directory floor both apply to a spawned command
/// (`ARCH/10` §Permission assertion, `DEC-024`, `DEC-025`). A `patchText` names
/// its targets in the patch headers, so an `apply_patch` approval shows the files
/// it will touch rather than a wildcard.
///
/// This is **extraction, not decision**. The tool plane never says allow, ask or
/// deny about a path: it attaches the resource and the guard evaluates it with the
/// one shared path matcher. An extracted path can only raise the outcome.
pub fn additional_targets_from_input(input: &Value) -> Vec<PermissionTarget> {
    let mut targets = Vec::new();
    if let Some(command) = input.get("command").and_then(Value::as_str) {
        let paths = extract_path_arguments(command);
        if !paths.is_empty() {
            targets.push(PermissionTarget::new("fs.read", paths.clone()));
            targets.push(PermissionTarget::new("fs.write", paths));
        }
    }
    if let Some(patch) = input.get("patchText").and_then(Value::as_str)
        && !patch.trim().is_empty()
    {
        targets.push(PermissionTarget::new(
            "fs.write",
            extract_patch_paths(patch),
        ));
    }
    targets
}

/// The maximum command text scanned for path arguments, and the maximum number
/// of resources extracted from it.
///
/// Both bounds are fixed, not derived from the input, so a hostile command
/// cannot drive an unbounded scan or an unbounded policy request
/// (`REQ-SEC-022`).
const MAX_SCAN_BYTES: usize = 64 * 1024;
const MAX_EXTRACTED_PATHS: usize = 64;
/// The longest single token considered a path.
const MAX_TOKEN_CHARS: usize = 4096;

/// Extracts the path-shaped arguments of a shell command.
///
/// The scan is deliberately lexical and conservative, and it is explicitly **not**
/// the control: a shell re-parses its arguments, so no lexical scan is sound
/// (`DEC-024`). Its whole job is to make a path protection and the
/// external-directory floor see a path that a shell argument names. Spawn-time
/// confinement remains the hard control.
#[must_use]
pub fn extract_path_arguments(command: &str) -> Vec<String> {
    let scanned: String = command.chars().take(MAX_SCAN_BYTES).collect();
    let mut found: Vec<String> = Vec::new();
    for token in scanned.split(|c: char| c.is_whitespace() || SHELL_DELIMITERS.contains(c)) {
        let token = unquote(token);
        if token.is_empty() || token.chars().count() > MAX_TOKEN_CHARS {
            continue;
        }
        if !is_path_shaped(&token) {
            continue;
        }
        if !found.contains(&token) {
            found.push(token);
        }
        if found.len() >= MAX_EXTRACTED_PATHS {
            break;
        }
    }
    found
}

/// Shell metacharacters that terminate a token.
const SHELL_DELIMITERS: &str = "|&;<>()[{}$*?!\"'\\";

/// Returns whether a token is shaped like a path.
///
/// A token that can name a location *outside* the granted roots is one that
/// carries a separator or a `~` anchor. A single-segment name is extracted only
/// when it is shaped like a file — a dot-leading name (`.env`) or one with an
/// extension (`id_rsa.pub`) — because that is the shape a deny glob names;
/// extracting every bare word would put `cargo` and `test` through the path
/// matcher and let an unrelated deny pattern match a command word.
fn is_path_shaped(token: &str) -> bool {
    if token.contains('/') || token.starts_with('~') || token.contains("**") {
        return true;
    }
    if token.len() > 1 && token.starts_with('.') {
        // A dot-leading name (`.env`) is the shape a deny glob names.
        return true;
    }
    token
        .rsplit_once('.')
        .is_some_and(|(stem, extension)| !stem.is_empty() && !extension.is_empty())
}

/// Strips one layer of shell quoting.
fn unquote(token: &str) -> String {
    for quote in ['"', '\''] {
        if token.len() >= 2 && token.starts_with(quote) && token.ends_with(quote) {
            return token[1..token.len() - 1].to_owned();
        }
    }
    token.to_owned()
}

/// Extracts the file paths a `patchText` names, from its section headers.
#[must_use]
pub fn extract_patch_paths(patch: &str) -> Vec<String> {
    let mut found = Vec::new();
    for line in patch.lines().take(MAX_EXTRACTED_PATHS * 2) {
        let header = line.trim();
        let path = ["*** Add File:", "*** Update File:", "*** Delete File:"]
            .into_iter()
            .find_map(|prefix| header.strip_prefix(prefix))
            .map(|path| path.trim().to_owned())
            .filter(|path| !path.is_empty());
        if let Some(path) = path
            && !found.contains(&path)
        {
            found.push(path);
        }
        if found.len() >= MAX_EXTRACTED_PATHS {
            break;
        }
    }
    found
}

// The registry caches its managed-output directory so settlement can spill
// without threading it through every call. `None` disables spilling.
impl ToolRegistry {
    /// Sets the managed-output directory used when content is truncated.
    pub fn set_spill_dir(&mut self, dir: Option<PathBuf>) {
        self.spill_dir = dir;
    }

    /// Returns the configured managed-output directory.
    #[must_use]
    pub fn spill_dir(&self) -> Option<&std::path::Path> {
        self.spill_dir.as_deref()
    }
}
