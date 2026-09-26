//! Policy guard (`CMP-guard`, `ARCH/12-GUARD.md`).
//!
//! Guard is the single authority that answers *may this run now?* for every
//! effectful action. It owns ordered allow/ask/deny rules evaluated
//! find-last-wins with a non-overridable deny ceiling and a fail-closed default
//! (`REQ-GUARD-001`, `REQ-GUARD-002`), the ask/approve lifecycle
//! (`REQ-GUARD-003`), scoped TTL'd tickets, and the `plan | act | yolo` mode
//! ceiling. It decides; it never executes (`ARCH/03` §4.3).
//!
//! ## Fail-closed guarantees
//! - An unmatched action resolves to `deny` (or `ask` when configured); never
//!   `allow` (`REQ-GUARD-002`).
//! - A `deny` in the global or project layer is a non-overridable ceiling; a
//!   more specific agent/session `allow` cannot widen it.
//! - A malformed config layer is rejected and a deny-all ceiling is installed
//!   for that layer position, so a typo can never widen the posture.
//! - The catastrophic gate is applied after rule evaluation and after the mode
//!   ceiling, so neither an explicit `allow` nor `yolo` bypasses it.
//!
//! ## Ownership
//! This crate owns rule semantics, tickets and approvals. It performs no
//! filesystem, process or network effect; that is `CMP-sandbox`/`CMP-tools`.

#![forbid(unsafe_code)]

mod approval;
mod catastrophic;
mod config;
mod decision;
mod error;
mod guard;
mod pattern;
mod rule;
mod ticket;

pub use approval::{
    ApprovalReply, ApprovalRequest, ApprovalResolver, AutoApproveResolver, DenyAllResolver,
    SavedRule,
};
pub use catastrophic::catastrophic;
pub use config::{
    CONFIG_FILE, GuardDocument, PROJECT_CONFIG_DIR, global_config_path, load_layer, parse_document,
    project_config_paths, strip_jsonc,
};
pub use decision::{GuardDecision, GuardMode};
pub use error::GuardError;
pub use guard::{Guard, GuardBuilder, GuardRequest, canonical_action, is_mutating};
pub use pattern::{MatchMode, Pattern};
pub use rule::{Effect, Rule, RuleLayer, RuleSource};
pub use ticket::{DEFAULT_TTL_MS, FsOp, Ticket, TicketStore, now_ms, validate_fs};

use rule::Rule as RuleAlias;

/// The default first-party posture: reads/questions/planning allowed, writes and
/// execution allowed in the sandbox, network and extension installs denied
/// (fail closed). Sandbox confinement, not Guard, bounds writes and egress.
#[must_use]
pub fn default_rules() -> Vec<RuleAlias> {
    use Effect::{Allow, Deny};
    vec![
        RuleAlias::new("fs.read", "**", Allow),
        RuleAlias::new("fs.write", "**", Allow),
        RuleAlias::new("exec.run", "**", Allow),
        RuleAlias::new("todo", "**", Allow),
        RuleAlias::new("question", "**", Allow),
        RuleAlias::new("net.connect", "**", Deny),
        RuleAlias::new("mcp.call", "**", Deny),
        RuleAlias::new("skill.install", "**", Deny),
    ]
}
