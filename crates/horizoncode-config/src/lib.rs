//! Layered configuration and instruction discovery (`CMP-config`,
//! `ARCH/18-CONFIG.md`; instruction walk `ARCH/09-CONTEXT.md` §6,
//! `REQ-CTX-005`).
//!
//! This crate owns **discovery and validation only**. It resolves every winning
//! value with provenance and it never executes, enables, or launches anything:
//! a project file may express a preference, but it cannot grant authority
//! (`ARCH/18`, `DEC-031`). Permission rules stay owned by `CMP-guard`, which
//! validates and evaluates them there.
//!
//! ## What the first slice covers
//!
//! - `jsonc` — the one JSONC reader, shared with the guard instead of copied.
//! - `discovery` — the global layer plus the project walk, outer to nearest.
//! - `settings` — a typed registry with per-key provenance, the documented
//!   fail-safe behavior for a malformed or unreadable layer, and an effective
//!   digest for run pinning.
//! - `instructions` — hierarchical `AGENTS.md` discovery, deduped, rendered as
//!   one typed source for the context plane; an unreadable discovered file is a
//!   typed failure, never a silent omission.
//!
//! ## Fail-safe rules
//!
//! A malformed or unreadable layer contributes **nothing**: its values are
//! dropped, a diagnostic names the file and the parse error, and the previous
//! layer's value stands (or the compiled default). A value of the wrong type is
//! not silently coerced: the effective value stays on the last valid one and
//! the view carries the validation error, so `/settings` can show the requested
//! value next to the effective one. Unknown keys are reported, never accepted.
//! The guard keeps its own stricter rule for security policy, where a malformed
//! layer installs a deny-all ceiling rather than falling back.

#![forbid(unsafe_code)]

pub mod discovery;
pub mod instructions;
pub mod jsonc;
pub mod settings;
pub mod state_fs;

pub use discovery::{
    CONFIG_FILE, ConfigLayer, ConfigSource, Discovery, DiscoveryIssue, PROJECT_CONFIG_DIR,
    discover, discover_with, global_config_path, project_config_paths, state_root,
};
pub use instructions::{
    INSTRUCTION_FILE, InstructionScope, InstructionSource, InstructionsError,
    discover_instructions, discover_instructions_with, read_instruction, render_instructions,
};
pub use settings::{
    ApplyBoundary, ArtifactLimits, ConfigDiagnostic, EffectiveConfig, LogLimits, SettingScope,
    SettingView, load, schema_keys,
};
pub use state_fs::{
    OwnerOnly, PathEntry, classify, refuse_group_or_other_access, refuse_symlink, set_owner_only,
};
