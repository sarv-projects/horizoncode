//! Translates loop progress into streamed `session/update` notifications.

use std::sync::Arc;

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{Client, ConnectionTo};
use agentx_analytics::{AnalyticsLog, CostStatus};
use agentx_runner::{RunEvent, RunObserver};
use agentx_types::{ToolStatus, Usage};

/// Streams a running turn's progress to the ACP client.
#[derive(Debug)]
pub struct AcpObserver {
    connection: ConnectionTo<Client>,
    session: acp::SessionId,
    /// The agentx session id the analytics ledger is keyed by.
    usage_session: Option<String>,
    /// The declared context-window size.
    ///
    /// There is deliberately no default: with no declared window, no
    /// `usage_update` is emitted, because a fabricated window is a false claim
    /// about the model's capacity.
    context_window: Option<u64>,
    /// The ledger the cumulative cost is read from.
    analytics: Option<Arc<AnalyticsLog>>,
    /// Cumulative tokens observed so far in this turn, from the provider.
    observed_tokens: u64,
}

impl AcpObserver {
    /// Builds an observer bound to one session's connection.
    #[must_use]
    pub fn new(connection: ConnectionTo<Client>, session: acp::SessionId) -> Self {
        Self {
            connection,
            session,
            usage_session: None,
            context_window: None,
            analytics: None,
            observed_tokens: 0,
        }
    }

    /// Declares the model's context-window size.
    #[must_use]
    pub fn with_context_window(mut self, context_window: Option<u64>) -> Self {
        self.context_window = context_window;
        self
    }

    /// Attaches the analytics ledger the cumulative cost is read from.
    #[must_use]
    pub fn with_analytics(mut self, analytics: Option<Arc<AnalyticsLog>>) -> Self {
        self.analytics = analytics;
        self
    }

    /// Sets the agentx session id the ledger is keyed by.
    #[must_use]
    pub fn with_usage_session(mut self, session: impl Into<String>) -> Self {
        self.usage_session = Some(session.into());
        self
    }

    fn send(&self, update: acp::SessionUpdate) {
        // A closed transport is not an error the loop can act on; the prompt
        // response still carries the terminal state.
        let _ = self
            .connection
            .send_notification(acp::SessionNotification::new(self.session.clone(), update));
    }

    /// Emits `usage_update` when both the window and a cost are known.
    ///
    /// The cumulative cost is attached only when its status is not `unknown`: an
    /// unpriced route is reported as unpriced, never as a cost of zero.
    fn send_usage(&self) {
        let Some(size) = self.context_window else {
            return;
        };
        let mut update = acp::UsageUpdate::new(self.observed_tokens, size);
        if let (Some(analytics), Some(session)) = (&self.analytics, &self.usage_session)
            && let Ok(Some(usage)) = analytics
                .rollups()
                .and_then(|rollups| rollups.session_usage(session))
            // A cost whose status is `unknown` is reported as unpriced, not as
            // a cost of zero.
            && let (Some(micros), status) = (usage.cost_micros_usd, usage.cost_status)
            && status != CostStatus::Unknown
        {
            update = update.cost(acp::Cost::new(micros as f64 / 1_000_000.0, "USD"));
        }
        self.send(acp::SessionUpdate::UsageUpdate(update));
    }
}

impl RunObserver for AcpObserver {
    fn on_event(&mut self, event: RunEvent) {
        match event {
            RunEvent::TextDelta { text } => {
                self.send(acp::SessionUpdate::AgentMessageChunk(
                    acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(text))),
                ));
            }
            RunEvent::ToolStarted { tool_call, action } => {
                let id: acp::ToolCallId = tool_call.id.as_str().to_owned().into();
                let title = format!("{} ({})", tool_call.name, action);
                self.send(acp::SessionUpdate::ToolCall(
                    acp::ToolCall::new(id, title)
                        .name(tool_call.name.clone())
                        .kind(kind_for(&action))
                        .status(acp::ToolCallStatus::InProgress)
                        .raw_input(Some(tool_call.arguments.clone())),
                ));
            }
            RunEvent::ApprovalRequested {
                tool_call_id,
                tool,
                action,
                resources,
            } => {
                // The approval request is surfaced on the call it belongs to, so
                // the client's surface shows the pending decision against the
                // right call rather than as an unrelated message.
                let id: acp::ToolCallId = tool_call_id.as_str().to_owned().into();
                let detail = if resources.is_empty() {
                    format!("{tool}: awaiting approval for `{action}`")
                } else {
                    format!(
                        "{tool}: awaiting approval for `{action}` on {}",
                        resources.join(", ")
                    )
                };
                self.send(acp::SessionUpdate::ToolCallUpdate(
                    acp::ToolCallUpdate::new(
                        id,
                        acp::ToolCallUpdateFields::new().title(Some(detail)),
                    ),
                ));
            }
            RunEvent::ApprovalResolved {
                tool_call_id,
                outcome,
                remembered,
            } => {
                // The resolved approval is recorded on the record too; this is
                // the client-visible half (`ACC-P1-03`).
                let id: acp::ToolCallId = tool_call_id.as_str().to_owned().into();
                let title = match remembered {
                    Some(pattern) => format!("approval {outcome} (remembered `{pattern}`)"),
                    None => format!("approval {outcome}"),
                };
                self.send(acp::SessionUpdate::ToolCallUpdate(
                    acp::ToolCallUpdate::new(
                        id,
                        acp::ToolCallUpdateFields::new().title(Some(title)),
                    ),
                ));
            }
            RunEvent::AuditRecorded { class, summary } => {
                // The audit outcome is a first-class fact for a client that
                // shows the evidence surface; it is a content chunk rather than
                // an agent message so it is not mistaken for model output.
                self.send(acp::SessionUpdate::AgentThoughtChunk(
                    acp::ContentChunk::new(acp::ContentBlock::Text(acp::TextContent::new(
                        format!("[audit] {class}: {summary}"),
                    ))),
                ));
            }
            RunEvent::ToolFinished { settlement } => {
                let id: acp::ToolCallId = settlement.tool_call_id.as_str().to_owned().into();
                let status = match settlement.status {
                    ToolStatus::Success => acp::ToolCallStatus::Completed,
                    _ => acp::ToolCallStatus::Failed,
                };
                self.send(acp::SessionUpdate::ToolCallUpdate(
                    acp::ToolCallUpdate::new(id, acp::ToolCallUpdateFields::new().status(status)),
                ));
            }
            RunEvent::StepFinished { usage, .. } => {
                self.observed_tokens = self.observed_tokens.saturating_add(observed(&usage));
                self.send_usage();
            }
            _ => {}
        }
    }
}

/// Tokens counted for a `usage_update` figure.
///
/// Reasoning tokens are excluded: they are not context the model holds, and
/// counting them would overstate how full the window is.
fn observed(usage: &Usage) -> u64 {
    usage
        .input_tokens
        .saturating_add(usage.output_tokens)
        .saturating_add(usage.cached_read_tokens)
}

fn kind_for(action: &str) -> acp::ToolKind {
    match action {
        "read" | "glob" | "grep" | "list" => acp::ToolKind::Read,
        _ => acp::ToolKind::Other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reasoning_tokens_are_excluded_from_the_context_figure() {
        let usage = Usage {
            input_tokens: 10,
            output_tokens: 5,
            cached_read_tokens: 3,
            cached_write_tokens: 100,
            reasoning_tokens: 999,
        };
        assert_eq!(observed(&usage), 18);
    }
}
