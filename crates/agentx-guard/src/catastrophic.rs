//! The irreducible catastrophic gate (`ARCH/12-GUARD.md`).
//!
//! A small, curated catalogue of actions that are denied unconditionally —
//! after rule evaluation and after the mode ceiling, so neither an explicit
//! `allow` rule nor `--yolo` can bypass them. Matching is intentionally
//! conservative: only clearly irreversible or host-level operations are listed.

use crate::pattern::{MatchMode, Pattern};
use crate::rule::resource_mode;

/// A curated catastrophic entry.
struct Entry {
    /// The canonical action pattern.
    action: &'static str,
    /// The resource pattern.
    resource: &'static str,
    /// A short reason.
    reason: &'static str,
}

const CATALOGUE: &[Entry] = &[
    Entry {
        action: "fs.delete",
        resource: "/",
        reason: "deleting the filesystem root is irreversible",
    },
    Entry {
        action: "fs.delete",
        resource: "/**",
        reason: "deleting the filesystem root is irreversible",
    },
    Entry {
        action: "fs.delete",
        resource: "~",
        reason: "deleting the home directory is irreversible",
    },
    Entry {
        action: "fs.delete",
        resource: "~/**",
        reason: "deleting the home directory is irreversible",
    },
    Entry {
        action: "fs.write",
        resource: "**/.git/config",
        reason: "rewriting VCS configuration can subvert later reads",
    },
    Entry {
        action: "fs.write",
        resource: "**/.ssh/**",
        reason: "rewriting SSH material is credential-sensitive",
    },
    Entry {
        action: "exec.run",
        resource: "rm -rf /*",
        reason: "recursive deletion of the filesystem root",
    },
    Entry {
        action: "exec.run",
        resource: "rm -rf ~*",
        reason: "recursive deletion of the home directory",
    },
    Entry {
        action: "exec.run",
        resource: "rm -fr /*",
        reason: "recursive deletion of the filesystem root",
    },
    Entry {
        action: "exec.run",
        resource: "mkfs*",
        reason: "formatting a filesystem destroys data",
    },
    Entry {
        action: "exec.run",
        resource: "dd *of=/dev/*",
        reason: "raw device writes destroy data",
    },
    Entry {
        action: "exec.run",
        resource: ":(){*",
        reason: "fork bomb",
    },
    Entry {
        action: "exec.run",
        resource: "shutdown*",
        reason: "host power control",
    },
    Entry {
        action: "exec.run",
        resource: "reboot*",
        reason: "host power control",
    },
    Entry {
        action: "exec.run",
        resource: "poweroff*",
        reason: "host power control",
    },
    Entry {
        action: "exec.run",
        resource: "chmod -R * /",
        reason: "recursive permission change at the root",
    },
    Entry {
        action: "exec.run",
        resource: "chown -R * /",
        reason: "recursive ownership change at the root",
    },
];

/// Returns a reason when any `(action, resource)` pair hits the gate.
#[must_use]
pub fn catastrophic(action: &str, resources: &[String]) -> Option<String> {
    if resources.is_empty() {
        return None;
    }
    for entry in CATALOGUE {
        if !Pattern::compile(entry.action, MatchMode::Dotted)
            .map(|pattern| pattern.matches(action))
            .unwrap_or(false)
        {
            continue;
        }
        let mode = resource_mode(action);
        let Ok(pattern) = Pattern::compile(entry.resource, mode) else {
            continue;
        };
        if resources
            .iter()
            .any(|resource| pattern.matches(resource.trim()))
        {
            return Some(entry.reason.to_owned());
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn recursive_root_deletion_is_catastrophic() {
        assert!(catastrophic("exec.run", &["rm -rf /".to_owned()]).is_some());
        assert!(catastrophic("fs.delete", &["/".to_owned()]).is_some());
    }

    #[test]
    fn ordinary_commands_are_not_catastrophic() {
        assert!(catastrophic("exec.run", &["cargo test".to_owned()]).is_none());
        assert!(catastrophic("fs.write", &["src/main.rs".to_owned()]).is_none());
        assert!(catastrophic("exec.run", &[]).is_none());
    }
}
