//! The tool plane (`CMP-tools`, `ARCH/10-TOOLS.md`).
//!
//! One registry, one execution path. A tool is a pure definition with a typed
//! execution function; the registry materializes a permission-filtered set for
//! the model and settles every call into a model-visible projection and a
//! separate UI-facing detail (`REQ-TOOL-002`, `REQ-TOOL-003`, `REQ-TOOL-004`).
//!
//! The built-in set is `read`, `glob`, `grep`, `list`, `write`, `edit`,
//! `apply_patch`, `bash`, `todo` and (interactive only) `question`. Mutating and
//! exec tools re-assert the guard immediately before their effect and route
//! shell execution through `agentx-sandbox`. [`GuardPermissionGate`] binds the
//! registry seam to the `agentx-guard` policy engine.

#![forbid(unsafe_code)]

mod bound;
mod builtin;
mod error;
mod guard_gate;
mod path;
mod policy;
mod registry;

use std::sync::Arc;

pub use bound::{Bounded, OutputBounds, bound};
pub use builtin::{QuestionHandler, QuestionTool, TodoItem, TodoStatus, TodoStore};
pub use error::ToolError;
pub use guard_gate::GuardPermissionGate;
pub use path::resolve_workspace_path;
pub use policy::{
    AskResolution, GateDecision, PermissionGate, PermissionRequest, PolicyGate, PolicyOutcome,
};
pub use registry::{Materialization, Settlement, Tool, ToolContext, ToolOutput, ToolRegistry};

/// Options controlling which built-ins are registered.
#[derive(Clone, Debug)]
pub struct BuiltinOptions {
    /// Whether interactive tools (`question`) are advertised.
    pub interactive: bool,
    /// The shared per-session todo store.
    pub todo_store: Arc<TodoStore>,
    /// The interactive question handler, when `interactive` is set.
    pub question_handler: Option<Arc<dyn QuestionHandler>>,
}

impl Default for BuiltinOptions {
    fn default() -> Self {
        Self {
            interactive: false,
            todo_store: Arc::new(TodoStore::new()),
            question_handler: None,
        }
    }
}

impl BuiltinOptions {
    /// Options for a non-interactive (headless) run: `question` is absent.
    #[must_use]
    pub fn headless() -> Self {
        Self::default()
    }

    /// Options for an interactive run with a question handler.
    #[must_use]
    pub fn interactive(handler: Arc<dyn QuestionHandler>) -> Self {
        Self {
            interactive: true,
            todo_store: Arc::new(TodoStore::new()),
            question_handler: Some(handler),
        }
    }
}

/// Registers all first-party built-ins into a registry.
///
/// # Errors
/// Returns [`ToolError`] if any built-in declares an invalid name.
pub fn register_all_builtins(
    registry: &mut ToolRegistry,
    options: BuiltinOptions,
) -> Result<(), ToolError> {
    let mut tools: Vec<Arc<dyn Tool>> = vec![
        Arc::new(builtin::ReadTool),
        Arc::new(builtin::GlobTool),
        Arc::new(builtin::GrepTool),
        Arc::new(builtin::ListTool),
        Arc::new(builtin::WriteTool),
        Arc::new(builtin::EditTool),
        Arc::new(builtin::ApplyPatchTool),
        Arc::new(builtin::BashTool),
        Arc::new(builtin::TodoTool::new(options.todo_store.clone())),
    ];
    if options.interactive {
        match options.question_handler {
            Some(handler) => tools.push(Arc::new(builtin::QuestionTool::new(handler))),
            None => tools.push(Arc::new(builtin::QuestionTool::unavailable())),
        }
    }
    registry.register_all(tools)
}

/// Registers all first-party read-only built-ins into a registry.
///
/// # Errors
/// Returns [`ToolError`] if any built-in declares an invalid name.
pub fn register_read_only_builtins(registry: &mut ToolRegistry) -> Result<(), ToolError> {
    registry.register_all(vec![
        Arc::new(builtin::ReadTool),
        Arc::new(builtin::GlobTool),
        Arc::new(builtin::GrepTool),
        Arc::new(builtin::ListTool),
    ])
}
