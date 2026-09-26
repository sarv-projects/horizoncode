//! Permission requests to the ACP client (`REQ-PROTO-002`, `REQ-PROTO-006`).
//!
//! The gate first evaluates the local policy. An `allow` or `deny` is answered
//! locally; an `ask` becomes a `session/request_permission` request and the
//! client's decision is honored. A client that cancels resolves to deny — never
//! auto-allow.

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{Client, ConnectionTo};
use agentx_tools::{GateDecision, PermissionGate, PermissionRequest, PolicyGate, PolicyOutcome};

/// A permission gate that forwards `ask` decisions to the connected client.
#[derive(Debug, Clone)]
pub struct AcpPermissionGate {
    policy: PolicyGate,
    connection: ConnectionTo<Client>,
    session: acp::SessionId,
}

impl AcpPermissionGate {
    /// Builds a gate bound to one session's connection.
    #[must_use]
    pub fn new(
        policy: PolicyGate,
        connection: ConnectionTo<Client>,
        session: acp::SessionId,
    ) -> Self {
        Self {
            policy,
            connection,
            session,
        }
    }

    async fn prompt(&self, request: &PermissionRequest) -> GateDecision {
        let tool_call_id: acp::ToolCallId = request.source.as_str().to_owned().into();
        let title = format!("{} {}", request.tool_name, request.resources.join(" "));
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
                    let option = selected.option_id.0.as_ref();
                    if option == "allow_once" || option == "allow_always" {
                        GateDecision::Allow
                    } else {
                        GateDecision::Deny {
                            reason: format!("permission rejected for `{}`", request.tool_name),
                        }
                    }
                }
                acp::RequestPermissionOutcome::Cancelled => GateDecision::Deny {
                    reason: "permission request cancelled by the client".to_owned(),
                },
                _ => GateDecision::Deny {
                    reason: "unknown permission outcome".to_owned(),
                },
            },
            Err(error) => GateDecision::Deny {
                reason: format!("permission request failed: {error}"),
            },
        }
    }
}

#[async_trait::async_trait]
impl PermissionGate for AcpPermissionGate {
    async fn authorize(&self, request: &PermissionRequest) -> GateDecision {
        match self.policy.evaluate(&request.action) {
            PolicyOutcome::Allow => GateDecision::Allow,
            PolicyOutcome::Deny { reason } => GateDecision::Deny { reason },
            PolicyOutcome::Ask => self.prompt(request).await,
        }
    }

    fn wholly_denied(&self, action: &str) -> bool {
        self.policy.wholly_denied(action)
    }
}
