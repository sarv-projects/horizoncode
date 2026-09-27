//! Export sanitization (`ARCH/20-ANALYTICS.md` §Failure modes).
//!
//! Prompts, completions, and file contents are **excluded by construction**:
//! the ledger schema has no field for them. What sanitization adds is a
//! deny-list scrub over the fields that do exist, so an operator can export
//! without carrying a workspace path or a route id they did not intend to
//! share.

use crate::event::{AnalyticsEvent, ToolMeasurement};

/// Field names scrubbed from an export.
pub const DENY_FIELDS: &[&str] = &["project", "provider", "model", "tool", "error_class"];

/// The placeholder substituted for a scrubbed value.
pub const SCRUBBED: &str = "[scrubbed]";

/// Scrubs one event in place.
pub fn scrub(event: &mut AnalyticsEvent) {
    if DENY_FIELDS.contains(&"project") {
        event.project = None;
    }
    if DENY_FIELDS.contains(&"provider") {
        event.provider = None;
    }
    if DENY_FIELDS.contains(&"model") {
        event.model = None;
    }
    if let Some(tool) = event.tool.as_mut() {
        scrub_tool(tool);
    }
}

fn scrub_tool(tool: &mut ToolMeasurement) {
    if DENY_FIELDS.contains(&"tool") {
        tool.tool = None;
    }
    if DENY_FIELDS.contains(&"error_class") {
        tool.error_class = None;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::event::{EventKind, Tokens};

    #[test]
    fn scrubbing_removes_the_denied_fields_and_keeps_the_counts() {
        let mut event = AnalyticsEvent::new(0, 1, "ses_1", EventKind::StepUsage)
            .with_project("/home/user/secret-project")
            .with_route("compatible", "mock-model")
            .with_tokens(Tokens::observed(10, 20))
            .with_tool(ToolMeasurement {
                tool: Some("write".to_owned()),
                error_class: Some("auth".to_owned()),
                ..ToolMeasurement::default()
            });
        scrub(&mut event);
        assert!(event.project.is_none());
        assert!(event.provider.is_none());
        assert!(event.model.is_none());
        let tool = event.tool.clone().unwrap();
        assert!(tool.tool.is_none());
        assert!(tool.error_class.is_none());
        // Token counts survive: sanitization hides identity, not magnitude.
        assert_eq!(event.tokens.input, 10);
        let line = event.to_line();
        assert!(!line.contains("secret-project"), "{line}");
        assert!(!line.contains("mock-model"), "{line}");
        assert!(line.contains("\"input\":10"), "{line}");
    }
}
