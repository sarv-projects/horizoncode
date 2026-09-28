//! The typed slash-command registry and composer-reference parser
//! (`ARCH/27` §Target slash-command registry, §Composer references).
//!
//! Two rules from the architecture drive this crate:
//!
//! 1. **Strict parse, no fall-through.** An unknown command, a malformed
//!    argument, or a command whose owner is unavailable returns a typed error.
//!    It never becomes model text and never becomes a plausible no-op.
//! 2. **Typed references, literal text preserved.** A composer mention is only a
//!    reference when it carries a known namespace delimiter; anything else stays
//!    literal text with, at most, a non-blocking diagnostic. A mention never
//!    launches an agent, reads a file, or grants authority by itself.
//!
//! Help and completion are generated from the same validated registry, so a
//! command cannot be documented without being declared, or declared without a
//! parse rule.
//!
//! ## Registered commands
//!
//! Only commands whose owning service exists are registered, each naming that
//! owner. The rest of the product's proposed command set (`ARCH/27` §Target
//! slash-command registry) registers as its owner lands; an unregistered
//! command is an error with suggestions, never a silent no-op.

#![forbid(unsafe_code)]

mod command;
mod reference;

pub use command::{
    Availability, CommandDescriptor, CommandError, DEFAULT_INSIGHTS_DAYS, EffectClass, Invocation,
    Surface, complete, parse, parse_on, registry, render_commands, render_help, search,
};
pub use reference::{Diagnostic, Reference, ReferenceNamespace, Scan, scan_references};
