//! The ACP stdio server.

use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use agent_client_protocol::schema::v1 as acp;
use agent_client_protocol::{Agent, Client, ConnectionTo, Stdio};
use agentx_provider::Provider;
use agentx_runner::{RunConfig, Runner};
use agentx_session::{ModelRef, SessionCreatedPayload, SessionStore, TurnEndStatus};
use agentx_tools::{PermissionGate, PolicyGate, ToolRegistry};
use agentx_types::{CancelToken, SessionId as AxSessionId};
use serde_json::json;

use crate::error::AcpError;
use crate::observer::AcpObserver;
use crate::permission::AcpPermissionGate;

/// Options for the ACP server.
#[derive(Debug)]
pub struct AcpOptions {
    /// The model provider.
    pub provider: Arc<dyn Provider>,
    /// The tool registry (with spill configured by the caller).
    pub tools: Arc<ToolRegistry>,
    /// The durable session store.
    pub store: Arc<SessionStore>,
    /// The base run configuration.
    pub config: RunConfig,
    /// The permission policy; `ask` actions prompt the client.
    pub policy: PolicyGate,
    /// The advertised implementation name.
    pub server_name: String,
    /// The advertised implementation version.
    pub server_version: String,
}

impl AcpOptions {
    /// Builds options with the default read-only policy and `agentx` identity.
    #[must_use]
    pub fn new(
        provider: Arc<dyn Provider>,
        tools: Arc<ToolRegistry>,
        store: Arc<SessionStore>,
        config: RunConfig,
    ) -> Self {
        Self {
            provider,
            tools,
            store,
            config,
            policy: PolicyGate::read_only(),
            server_name: "agentx".to_owned(),
            server_version: env!("CARGO_PKG_VERSION").to_owned(),
        }
    }
}

#[derive(Clone, Debug)]
struct AcpState {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    store: Arc<SessionStore>,
    config: RunConfig,
    policy: PolicyGate,
    server_name: String,
    server_version: String,
    active: Arc<Mutex<HashSet<String>>>,
    cancels: Arc<Mutex<HashMap<String, CancelToken>>>,
}

impl AcpState {
    fn new(options: AcpOptions) -> Self {
        Self {
            provider: options.provider,
            tools: options.tools,
            store: options.store,
            config: options.config,
            policy: options.policy,
            server_name: options.server_name,
            server_version: options.server_version,
            active: Arc::new(Mutex::new(HashSet::new())),
            cancels: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    fn capabilities() -> acp::AgentCapabilities {
        // Advertise only what is implemented (`REQ-PROTO-006`): text prompts
        // and the core session lifecycle. `session/load` is not offered.
        acp::AgentCapabilities::new().prompt_capabilities(acp::PromptCapabilities::new())
    }
}

/// Runs the ACP server over stdio until the transport closes.
///
/// # Errors
/// Returns [`AcpError::Protocol`] when the connection fails.
pub async fn run_stdio(options: AcpOptions) -> Result<(), AcpError> {
    let state = AcpState::new(options);
    Agent
        .builder()
        .name("agentx")
        .on_receive_request(
            {
                let state = state.clone();
                async move |request: acp::InitializeRequest, responder, _cx| {
                    responder.respond(
                        acp::InitializeResponse::new(request.protocol_version)
                            .agent_capabilities(AcpState::capabilities())
                            .agent_info(acp::Implementation::new(
                                state.server_name.clone(),
                                state.server_version.clone(),
                            )),
                    )
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |request: acp::NewSessionRequest, responder, _cx| {
                    handle_new_session(&state, request, responder)
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |request: acp::CloseSessionRequest, responder, _cx| {
                    handle_close_session(&state, request, responder)
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_request(
            {
                let state = state.clone();
                async move |request: acp::PromptRequest, responder, cx| {
                    handle_prompt(&state, request, responder, cx)
                }
            },
            agent_client_protocol::on_receive_request!(),
        )
        .on_receive_notification(
            {
                let state = state.clone();
                async move |notification: acp::CancelNotification, _cx| {
                    handle_cancel(&state, &notification);
                    Ok(())
                }
            },
            agent_client_protocol::on_receive_notification!(),
        )
        .connect_to(Stdio::new())
        .await
        .map_err(|error| AcpError::Protocol(error.to_string()))
}

fn handle_new_session(
    state: &AcpState,
    request: acp::NewSessionRequest,
    responder: agent_client_protocol::Responder<acp::NewSessionResponse>,
) -> Result<(), agent_client_protocol::Error> {
    if !request.cwd.is_absolute() {
        return responder.respond_with_error(invalid_params(format!(
            "cwd must be an absolute path, got {}",
            request.cwd.display()
        )));
    }
    let workspace = request.cwd.to_string_lossy().into_owned();
    let title = request
        .cwd
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| workspace.clone());
    let header = SessionCreatedPayload::new(
        workspace,
        title,
        ModelRef {
            id: state.config.model.clone(),
            provider: state.config.provider.clone(),
            variant: None,
        },
        state.config.mode.clone(),
        json!({
            "allow": state.policy.allowed_actions(),
            "ask": state.policy.ask_actions(),
            "deny": state.policy.deny_actions(),
        }),
    );
    match state.store.create(header) {
        Ok(session) => {
            let id: acp::SessionId = session.id.as_str().to_owned().into();
            responder.respond(acp::NewSessionResponse::new(id))
        }
        Err(error) => responder.respond_with_error(internal_error(error.to_string())),
    }
}

fn handle_close_session(
    state: &AcpState,
    request: acp::CloseSessionRequest,
    responder: agent_client_protocol::Responder<acp::CloseSessionResponse>,
) -> Result<(), agent_client_protocol::Error> {
    let key = request.session_id.to_string();
    if let Some(token) = lock(&state.cancels).remove(&key) {
        token.cancel();
    }
    lock(&state.active).remove(&key);
    let id = AxSessionId::new(key);
    // Closing an already-missing session is treated as success (idempotent).
    if state.store.exists(&id)
        && let Err(error) = state.store.close(&id)
    {
        return responder.respond_with_error(internal_error(error.to_string()));
    }
    responder.respond(acp::CloseSessionResponse::new())
}

fn handle_prompt(
    state: &AcpState,
    request: acp::PromptRequest,
    responder: agent_client_protocol::Responder<acp::PromptResponse>,
    cx: ConnectionTo<Client>,
) -> Result<(), agent_client_protocol::Error> {
    let key = request.session_id.to_string();
    let session_id = AxSessionId::new(key.clone());
    let loaded = match state.store.load(&session_id) {
        Ok(loaded) => loaded,
        Err(error) => {
            return responder
                .respond_with_error(invalid_params(format!("unknown session `{key}`: {error}")));
        }
    };
    let Some(prompt) = collect_text(&request.prompt) else {
        return responder.respond_with_error(invalid_params(
            "prompt must contain at least one text content block",
        ));
    };
    if !lock(&state.active).insert(key.clone()) {
        return responder
            .respond_with_error(invalid_params("session already has an active prompt"));
    }

    let cancel = CancelToken::new();
    lock(&state.cancels).insert(key.clone(), cancel.clone());

    let workspace = PathBuf::from(loaded.header.workspace_id);
    let gate: Arc<dyn PermissionGate> = Arc::new(AcpPermissionGate::new(
        state.policy.clone(),
        cx.clone(),
        request.session_id.clone(),
    ));
    let config = RunConfig {
        workspace,
        ..state.config.clone()
    };
    let runner = Runner::new(
        state.provider.clone(),
        state.tools.clone(),
        state.store.clone(),
        gate,
        config,
    );
    let observer = AcpObserver::new(cx.clone(), request.session_id.clone());
    let state = state.clone();

    cx.spawn(async move {
        let mut observer = observer;
        let result = runner
            .run_turn(&session_id, &prompt, cancel, &mut observer)
            .await;
        lock(&state.active).remove(&key);
        lock(&state.cancels).remove(&key);
        match result {
            Ok(outcome) => responder.respond(acp::PromptResponse::new(map_stop(outcome.status))),
            Err(error) => responder.respond_with_error(internal_error(error.to_string())),
        }
    })
}

fn handle_cancel(state: &AcpState, notification: &acp::CancelNotification) {
    let key = notification.session_id.to_string();
    if let Some(token) = lock(&state.cancels).get(&key).cloned() {
        token.cancel();
    }
}

fn collect_text(prompt: &[acp::ContentBlock]) -> Option<String> {
    let mut out = String::new();
    for block in prompt {
        if let acp::ContentBlock::Text(text) = block {
            if !out.is_empty() {
                out.push('\n');
            }
            out.push_str(&text.text);
        }
    }
    if out.trim().is_empty() {
        None
    } else {
        Some(out)
    }
}

fn map_stop(status: TurnEndStatus) -> acp::StopReason {
    match status {
        TurnEndStatus::Completed => acp::StopReason::EndTurn,
        TurnEndStatus::Interrupted => acp::StopReason::Cancelled,
        TurnEndStatus::Partial => acp::StopReason::MaxTurnRequests,
        TurnEndStatus::Failed | TurnEndStatus::Declined => acp::StopReason::Refusal,
    }
}

fn invalid_params(message: impl Into<String>) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(-32602, message.into())
}

fn internal_error(message: impl Into<String>) -> agent_client_protocol::Error {
    agent_client_protocol::Error::new(-32603, message.into())
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}
