//! Approval requests to the ACP client (`REQ-PROTO-002`, `REQ-PROTO-006`).
//!
//! The guard decides allow/ask/deny. An `ask` is forwarded to the client as a
//! `session/request_permission` request and the client's decision is honored. A
//! client that cancels resolves to reject — never auto-allow.

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{Client, ConnectionTo};
use horizoncode_guard::{ApprovalReply, ApprovalRequest, ApprovalResolver};
use async_trait::async_trait;

/// An approval resolver that forwards `ask` decisions to the connected client.
#[derive(Debug, Clone)]
pub struct AcpApprovalResolver {
    connection: ConnectionTo<Client>,
    session: acp::SessionId,
}

impl AcpApprovalResolver {
    /// Builds a resolver bound to one session's connection.
    #[must_use]
    pub fn new(connection: ConnectionTo<Client>, session: acp::SessionId) -> Self {
        Self {
            connection,
            session,
        }
    }
}

#[async_trait]
impl ApprovalResolver for AcpApprovalResolver {
    async fn resolve(&self, request: &ApprovalRequest) -> ApprovalReply {
        let tool_call_id: acp::ToolCallId = request.source.clone().into();
        let title = format!("{} {}", request.tool, request.resources.join(" "));
        let tool_call = acp::ToolCallUpdate::new(
            tool_call_id,
            acp::ToolCallUpdateFields::new()
                .title(title)
                .status(acp::ToolCallStatus::Pending),
        );
        let options = vec![
            acp::PermissionOption::new(
                "allow_once",
                "Allow once",
                acp::PermissionOptionKind::AllowOnce,
            ),
            acp::PermissionOption::new(
                "allow_always",
                "Allow always",
                acp::PermissionOptionKind::AllowAlways,
            ),
            acp::PermissionOption::new(
                "reject_once",
                "Reject once",
                acp::PermissionOptionKind::RejectOnce,
            ),
        ];
        let outgoing = acp::RequestPermissionRequest::new(self.session.clone(), tool_call, options);
        match self.connection.send_request(outgoing).block_task().await {
            Ok(response) => match response.outcome {
                acp::RequestPermissionOutcome::Selected(selected) => {
                    match selected.option_id.0.as_ref() {
                        "allow_once" => ApprovalReply::Once,
                        "allow_always" => ApprovalReply::Always,
                        _ => ApprovalReply::Reject,
                    }
                }
                acp::RequestPermissionOutcome::Cancelled => ApprovalReply::Reject,
                _ => ApprovalReply::Reject,
            },
            Err(_) => ApprovalReply::Reject,
        }
    }
}
