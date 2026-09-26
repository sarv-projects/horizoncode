//! The tool plane (`CMP-tools`, `ARCH/10-TOOLS.md`).
//!
//! One registry, one execution path. A tool is a pure definition with a typed
//! execution function; the registry materializes a permission-filtered set for
//! the model and settles every call into a model-visible projection and a
//! separate UI-facing detail (`REQ-TOOL-002`, `REQ-TOOL-003`, `REQ-TOOL-004`).
//!
//! This slice ships the read-only built-ins (`read`, `glob`, `grep`, `list`)
//! plus the permission-assertion seam invoked before every execution. The
//! default gate allows the read-only action set and fails closed for anything
//! else.

#![forbid(unsafe_code)]

mod bound;
mod builtin;
mod error;
mod path;
mod policy;
mod registry;

pub use bound::{Bounded, OutputBounds, bound};
pub use error::ToolError;
pub use path::resolve_workspace_path;
pub use policy::{
    AskResolution, GateDecision, PermissionGate, PermissionRequest, PolicyGate, PolicyOutcome,
};
pub use registry::{Materialization, Settlement, Tool, ToolContext, ToolOutput, ToolRegistry};

/// Registers all first-party read-only built-ins into a registry.
///
/// # Errors
/// Returns [`ToolError`] if any built-in declares an invalid name.
pub fn register_read_only_builtins(registry: &mut ToolRegistry) -> Result<(), ToolError> {
    registry.register_all(vec![
        std::sync::Arc::new(builtin::ReadTool),
        std::sync::Arc::new(builtin::GlobTool),
        std::sync::Arc::new(builtin::GrepTool),
        std::sync::Arc::new(builtin::ListTool),
    ])
}
