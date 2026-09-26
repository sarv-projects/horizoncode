//! Translates loop progress into streamed `session/update` notifications.

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{Client, ConnectionTo};
use agentx_runner::{RunEvent, RunObserver};
use agentx_types::ToolStatus;

/// Streams a running turn's progress to the ACP client.
#[derive(Debug)]
pub struct AcpObserver {
    connection: ConnectionTo<Client>,
    session: acp::SessionId,
}

impl AcpObserver {
    /// Builds an observer bound to one session's connection.
    #[must_use]
    pub fn new(connection: ConnectionTo<Client>, session: acp::SessionId) -> Self {
        Self {
            connection,
            session,
        }
    }

    fn send(&self, update: acp::SessionUpdate) {
        // A closed transport is not an error the loop can act on; the prompt
        // response still carries the terminal state.
        let _ = self
            .connection
            .send_notification(acp::SessionNotification::new(self.session.clone(), update));
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
            _ => {}
        }
    }
}

fn kind_for(action: &str) -> acp::ToolKind {
    match action {
        "read" | "glob" | "grep" | "list" => acp::ToolKind::Read,
        _ => acp::ToolKind::Other,
    }
}
