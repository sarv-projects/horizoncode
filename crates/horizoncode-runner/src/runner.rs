//! The turn engine.

use std::collections::{BTreeMap, HashSet};
use std::sync::Arc;

use futures::StreamExt;
use horizoncode_analytics::FailureClass;
use horizoncode_provider::Provider;
use horizoncode_session::{
    AssistantMessagePayload, InputPromotedPayload, SessionStatus, SessionStore, StepEndPayload,
    StepStartPayload, ToolCallPayload, ToolResultPayload, TurnEndPayload, TurnEndStatus,
    TurnStartPayload,
};
use horizoncode_tools::{
    Materialization, PermissionGate, PolicyOutcome, Settlement, ToolContext, ToolRegistry,
};
use horizoncode_types::{
    CancelToken, ContentPart, Event, EventKind, FinishReason, Message, ModelEvent, ModelRequest,
    ProviderErrorKind, SessionId, ToolCall, ToolChoice, ToolStatus, TurnId, Usage,
};
use serde_json::Value;

use crate::WRAP_UP_INSTRUCTION;
use crate::config::RunConfig;
use crate::error::LoopError;
use crate::observer::{RunEvent, RunObserver};
use crate::recorder::{AuditedGate, RecordError};

/// The outcome of one completed turn.
#[derive(Clone, Debug)]
pub struct RunOutcome {
    /// The turn identity.
    pub turn_id: TurnId,
    /// The single terminal status (`REQ-LOOP-004`).
    pub status: TurnEndStatus,
    /// A human-readable reason.
    pub reason: String,
    /// The final assistant text, when one was produced.
    pub final_text: Option<String>,
    /// The number of model steps executed.
    pub steps: usize,
    /// Usage folded across the turn's steps.
    pub usage: Usage,
}

/// The bounded agent loop.
#[derive(Debug)]
pub struct Runner {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    store: Arc<SessionStore>,
    gate: Arc<dyn PermissionGate>,
    config: RunConfig,
}

impl Runner {
    /// Builds a runner.
    #[must_use]
    pub fn new(
        provider: Arc<dyn Provider>,
        tools: Arc<ToolRegistry>,
        store: Arc<SessionStore>,
        gate: Arc<dyn PermissionGate>,
        config: RunConfig,
    ) -> Self {
        Self {
            provider,
            tools,
            store,
            gate,
            config,
        }
    }

    /// Runs one turn to exactly one terminal state.
    ///
    /// # Errors
    /// Returns [`LoopError`] only for infrastructure failures (a session that
    /// cannot be read/appended, a closed session, or bad configuration). Model
    /// and tool failures are recorded as a `failed` turn outcome.
    pub async fn run_turn(
        &self,
        session_id: &SessionId,
        prompt: &str,
        cancel: CancelToken,
        observer: &mut dyn RunObserver,
    ) -> Result<RunOutcome, LoopError> {
        if self.config.model.trim().is_empty() {
            return Err(LoopError::Config("model id must not be empty".to_owned()));
        }
        if self.config.max_steps == 0 {
            return Err(LoopError::Config("max_steps must be at least 1".to_owned()));
        }
        if self.config.max_tool_calls_per_response == 0
            || self.config.max_tool_argument_bytes_per_response == 0
            || self.config.max_response_bytes == 0
        {
            return Err(LoopError::Config(
                "per-response admission limits must be greater than zero".to_owned(),
            ));
        }
        let loaded = self.store.load(session_id)?;
        if loaded.status == SessionStatus::Closed {
            return Err(LoopError::Closed(session_id.clone()));
        }

        let turn_id = TurnId::generate();
        // The permission seam is wrapped so every decision it makes is
        // recorded. The wrapper forwards unchanged: it is a watcher, not a
        // second gate.
        // The permission seam is created once per process, so its observers
        // queue their surface events on the shared recorder; the loop drains
        // them at the next boundary and forwards them to the borrowed observer.
        let gate = Arc::new(AuditedGate::new(
            self.gate.clone(),
            self.config.recorder.clone(),
            session_id.clone(),
        ));
        self.config.recorder.set_session(Some(session_id.clone()));
        self.config.recorder.set_turn(Some(turn_id.clone()));
        // The audit chain and the analytics ledger record the run boundary
        // before the turn's first effect, so a run that is refused has already
        // left evidence that it was attempted.
        self.config
            .recorder
            .run_started(session_id, &turn_id, self.config.max_steps)?;
        self.record_sandbox_profile(session_id, &turn_id)?;
        self.append(
            session_id,
            Event::payload(
                EventKind::TurnStart,
                &TurnStartPayload {
                    turn_id: turn_id.clone(),
                    prompt: prompt.to_owned(),
                },
            ),
        )?;
        observer.on_event(RunEvent::TurnStarted {
            turn_id: turn_id.clone(),
        });
        self.append(
            session_id,
            Event::payload(
                EventKind::InputPromoted,
                &InputPromotedPayload {
                    input_id: format!("{turn_id}:user"),
                    delivery: "user".to_owned(),
                    text: prompt.to_owned(),
                },
            ),
        )?;

        let mut history = loaded.history();
        history.push(Message::user(prompt));

        let prior_usage = loaded.usage_totals();
        let mut total_usage = Usage::default();
        let mut last_text: Option<String> = None;
        let mut step = 1usize;
        // Every tool-call id admitted in this turn. A provider that reuses one is
        // refused at admission, so the conversation never carries two calls or two
        // results under one correlation id (`AX-356`).
        let mut used_call_ids: HashSet<String> = HashSet::new();

        while step <= self.config.max_steps {
            if cancel.is_cancelled() {
                return self.finish(
                    session_id,
                    turn_id,
                    TurnEndStatus::Interrupted,
                    "interrupted before the next step".to_owned(),
                    last_text,
                    step.saturating_sub(1),
                    total_usage,
                    observer,
                );
            }

            if let Some(budget) = self.config.token_budget {
                let used = prior_usage.total().saturating_add(total_usage.total());
                if used >= budget {
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Failed,
                        format!("token budget exhausted ({used}/{budget})"),
                        last_text,
                        step.saturating_sub(1),
                        total_usage,
                        observer,
                    );
                }
            }

            let last_step = step == self.config.max_steps;
            let tools_enabled = !last_step;
            let materialization = if tools_enabled {
                self.tools.materialize(gate.as_ref())
            } else {
                Materialization::default()
            };
            let advertised_tool_names = materialization.names.clone();

            let mut system = self.config.system.clone();
            if !tools_enabled {
                system.push(WRAP_UP_INSTRUCTION.to_owned());
            }
            let mut request = ModelRequest::new(self.config.model.clone())
                .with_system(system)
                .with_messages(history.clone());
            request.tools = materialization.definitions;
            request.tool_choice = if tools_enabled {
                ToolChoice::Auto
            } else {
                ToolChoice::None
            };
            request.temperature = self.config.temperature;
            request.max_output_tokens = self.config.max_output_tokens;

            self.config
                .recorder
                .step_started(session_id, &turn_id, step as u64)?;
            self.append(
                session_id,
                Event::payload(
                    EventKind::StepStart,
                    &StepStartPayload {
                        turn_id: turn_id.clone(),
                        step: step as u64,
                    },
                ),
            )?;
            self.append(
                session_id,
                Event::payload(
                    EventKind::ModelStarted,
                    &serde_json::json!({
                        "turn_id": turn_id.as_str(),
                        "step": step,
                        "model": self.config.model,
                    }),
                ),
            )?;

            let opening = self.provider.stream(request, cancel.clone());
            let stream_result = tokio::select! {
                biased;
                () = cancel.cancelled() => Err(horizoncode_types::ProviderError::cancelled()),
                result = opening => result,
            };
            let mut stream = match stream_result {
                Ok(stream) => stream,
                Err(error) => {
                    if cancel.is_cancelled() || error.kind == ProviderErrorKind::Cancelled {
                        self.close_step(
                            session_id,
                            &turn_id,
                            step,
                            Usage::default(),
                            false,
                            observer,
                        )?;
                        return self.finish(
                            session_id,
                            turn_id,
                            TurnEndStatus::Interrupted,
                            "interrupted while acquiring the provider stream".to_owned(),
                            last_text,
                            step,
                            total_usage,
                            observer,
                        );
                    }
                    self.record_attempt(session_id, &turn_id, step, &error.to_string())?;
                    self.config.recorder.retry(
                        session_id,
                        &turn_id,
                        step as u64,
                        1,
                        failure_class_of(&error),
                    )?;
                    self.close_step(
                        session_id,
                        &turn_id,
                        step,
                        Usage::default(),
                        false,
                        observer,
                    )?;
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Failed,
                        format!("model request failed: {error}"),
                        last_text,
                        step,
                        total_usage,
                        observer,
                    );
                }
            };

            let mut accumulator = StepAccumulator::default();
            let mut cancelled = false;
            let mut stream_error: Option<String> = None;
            let mut assembly_error: Option<ResponseAssemblyError> = None;
            loop {
                tokio::select! {
                    biased;
                    () = cancel.cancelled() => {
                        cancelled = true;
                        break;
                    }
                    item = stream.next() => {
                        match item {
                            None => break,
                            Some(Ok(event)) => {
                                if let Err(error) = accumulator.apply(
                                    event,
                                    observer,
                                    ResponseLimits {
                                        max_tool_calls: self.config.max_tool_calls_per_response,
                                        max_tool_argument_bytes: self.config.max_tool_argument_bytes_per_response,
                                        max_response_bytes: self.config.max_response_bytes,
                                    },
                                ) {
                                    assembly_error = Some(error);
                                    break;
                                }
                            }
                            Some(Err(error)) => {
                                if cancel.is_cancelled() || error.kind == ProviderErrorKind::Cancelled {
                                    cancelled = true;
                                    break;
                                }
                                stream_error = Some(error.to_string());
                                break;
                            }
                        }
                    }
                }
            }

            if let Some(error) = stream_error {
                if cancel.is_cancelled() {
                    cancelled = true;
                } else {
                    total_usage.add_assign(accumulator.usage);
                    self.record_attempt(session_id, &turn_id, step, &error)?;
                    self.config.recorder.retry(
                        session_id,
                        &turn_id,
                        step as u64,
                        1,
                        FailureClass::Timeout,
                    )?;
                    self.close_step(
                        session_id,
                        &turn_id,
                        step,
                        accumulator.usage,
                        !tools_enabled,
                        observer,
                    )?;
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Failed,
                        format!("model stream failed: {error}"),
                        Some(accumulator.text).filter(|text| !text.is_empty()),
                        step,
                        total_usage,
                        observer,
                    );
                }
            }

            if let Some(error) = assembly_error.filter(|_| !cancelled) {
                let usage = accumulator.usage;
                let partial_text = (!accumulator.text.is_empty()).then_some(accumulator.text);
                total_usage.add_assign(usage);
                self.record_response_outcome(
                    session_id,
                    &turn_id,
                    step,
                    ResponseAdmissionOutcome {
                        outcome: "rejected",
                        code: error.code(),
                        limit: error.limit(),
                        observed: error.observed(),
                    },
                )?;
                self.close_step(session_id, &turn_id, step, usage, !tools_enabled, observer)?;
                return self.finish(
                    session_id,
                    turn_id,
                    TurnEndStatus::Failed,
                    error.to_string(),
                    partial_text,
                    step,
                    total_usage,
                    observer,
                );
            }

            total_usage.add_assign(accumulator.usage);
            let step_usage = accumulator.usage;
            if cancelled {
                // Tool deltas are provisional until the provider completes the
                // whole response. Keep only bounded partial text; never put
                // provisional calls into the durable transcript on interrupt.
                let text = accumulator.text;
                let content = if text.is_empty() {
                    Vec::new()
                } else {
                    vec![ContentPart::text(text.clone())]
                };
                self.append(
                    session_id,
                    Event::payload(
                        EventKind::AssistantMessage,
                        &AssistantMessagePayload {
                            turn_id: turn_id.clone(),
                            message_id: None,
                            content,
                            tool_calls: Vec::new(),
                            interrupted: true,
                        },
                    ),
                )?;
                observer.on_event(RunEvent::AssistantMessage {
                    step: step as u64,
                    text: text.clone(),
                    tool_calls: Vec::new(),
                });
                self.close_step(
                    session_id,
                    &turn_id,
                    step,
                    step_usage,
                    !tools_enabled,
                    observer,
                )?;
                return self.finish(
                    session_id,
                    turn_id,
                    TurnEndStatus::Interrupted,
                    "interrupted during the model step".to_owned(),
                    Some(text).filter(|text| !text.is_empty()),
                    step,
                    total_usage,
                    observer,
                );
            }

            let finish_reason = accumulator.finish_reason.clone();
            match finish_reason.as_ref() {
                Some(FinishReason::Length) => {
                    let text = accumulator.text;
                    self.record_response_outcome(
                        session_id,
                        &turn_id,
                        step,
                        ResponseAdmissionOutcome {
                            outcome: "incomplete",
                            code: "OUTPUT_LIMIT_REACHED",
                            limit: None,
                            observed: None,
                        },
                    )?;
                    self.close_step(
                        session_id,
                        &turn_id,
                        step,
                        step_usage,
                        !tools_enabled,
                        observer,
                    )?;
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Partial,
                        "provider output limit reached; partial response retained without tool dispatch".to_owned(),
                        Some(text).filter(|text| !text.is_empty()),
                        step,
                        total_usage,
                        observer,
                    );
                }
                Some(FinishReason::ContentFilter) => {
                    let text = accumulator.text;
                    self.record_response_outcome(
                        session_id,
                        &turn_id,
                        step,
                        ResponseAdmissionOutcome {
                            outcome: "rejected",
                            code: "PROVIDER_CONTENT_FILTER",
                            limit: None,
                            observed: None,
                        },
                    )?;
                    self.close_step(
                        session_id,
                        &turn_id,
                        step,
                        step_usage,
                        !tools_enabled,
                        observer,
                    )?;
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Failed,
                        "provider stopped the response for a content filter".to_owned(),
                        Some(text).filter(|text| !text.is_empty()),
                        step,
                        total_usage,
                        observer,
                    );
                }
                Some(FinishReason::Other(_)) | None => {
                    let text = accumulator.text;
                    let (code, reason) = if finish_reason.is_none() {
                        (
                            "MISSING_FINISH_REASON",
                            "provider stream ended without a finish marker",
                        )
                    } else {
                        (
                            "UNSUPPORTED_FINISH_REASON",
                            "provider returned an unsupported finish reason",
                        )
                    };
                    self.record_response_outcome(
                        session_id,
                        &turn_id,
                        step,
                        ResponseAdmissionOutcome {
                            outcome: "rejected",
                            code,
                            limit: None,
                            observed: None,
                        },
                    )?;
                    self.close_step(
                        session_id,
                        &turn_id,
                        step,
                        step_usage,
                        !tools_enabled,
                        observer,
                    )?;
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Failed,
                        reason.to_owned(),
                        Some(text).filter(|text| !text.is_empty()),
                        step,
                        total_usage,
                        observer,
                    );
                }
                Some(FinishReason::Stop | FinishReason::ToolCalls) => {}
            }

            let provisional_text = accumulator.text.clone();
            let (text, calls) = match accumulator.settle_calls() {
                Ok(response) => response,
                Err(error) => {
                    self.record_response_outcome(
                        session_id,
                        &turn_id,
                        step,
                        ResponseAdmissionOutcome {
                            outcome: "rejected",
                            code: error.code(),
                            limit: error.limit(),
                            observed: error.observed(),
                        },
                    )?;
                    self.close_step(
                        session_id,
                        &turn_id,
                        step,
                        step_usage,
                        !tools_enabled,
                        observer,
                    )?;
                    return self.finish(
                        session_id,
                        turn_id,
                        TurnEndStatus::Failed,
                        error.to_string(),
                        Some(provisional_text).filter(|text| !text.is_empty()),
                        step,
                        total_usage,
                        observer,
                    );
                }
            };
            let finish_matches_calls = match finish_reason {
                Some(FinishReason::Stop) => calls.is_empty(),
                Some(FinishReason::ToolCalls) => !calls.is_empty(),
                _ => false,
            };
            let malformed_arguments = calls.iter().any(|(_, error)| error.is_some());
            let unadvertised_tool = calls.iter().find(|(call, _)| {
                tools_enabled && !advertised_tool_names.iter().any(|name| name == &call.name)
            });
            let invalid_schema_tool = if tools_enabled {
                calls.iter().find_map(|(call, parse_error)| {
                    if parse_error.is_some() {
                        return None;
                    }
                    self.tools
                        .validate_input(call)
                        .err()
                        .map(|_| call.name.clone())
                })
            } else {
                None
            };
            let rejection = if !finish_matches_calls {
                Some((
                    "FINISH_CALLS_MISMATCH",
                    "provider finish reason did not match the response tool calls".to_owned(),
                ))
            } else if malformed_arguments {
                Some((
                    "INVALID_TOOL_ARGUMENTS",
                    "provider returned malformed tool arguments; rejecting the entire batch"
                        .to_owned(),
                ))
            } else if let Some((call, _)) = unadvertised_tool {
                Some((
                    "UNADVERTISED_TOOL",
                    format!(
                        "provider returned unadvertised tool `{}`; rejecting the entire batch",
                        call.name
                    ),
                ))
            } else {
                invalid_schema_tool.map(|name| (
                    "TOOL_SCHEMA_VALIDATION",
                    format!(
                        "provider arguments fail the `{name}` input schema; rejecting the entire batch"
                    ),
                ))
            };
            if let Some((code, reason)) = rejection {
                self.record_response_outcome(
                    session_id,
                    &turn_id,
                    step,
                    ResponseAdmissionOutcome {
                        outcome: "rejected",
                        code,
                        limit: None,
                        observed: None,
                    },
                )?;
                self.close_step(
                    session_id,
                    &turn_id,
                    step,
                    step_usage,
                    !tools_enabled,
                    observer,
                )?;
                return self.finish(
                    session_id,
                    turn_id,
                    TurnEndStatus::Failed,
                    reason,
                    Some(text).filter(|text| !text.is_empty()),
                    step,
                    total_usage,
                    observer,
                );
            }
            // A tool result is correlated to its call by the call id, so two calls
            // that share one id in the same turn cannot be told apart — and a
            // reused id is indistinguishable from a replay of the call that
            // already spent its authorization. Refuse the response rather than
            // invent a correlation the provider never issued (`AX-356`).
            if let Err(reason) =
                admit_call_ids(&mut used_call_ids, calls.iter().map(|(call, _)| call))
            {
                self.record_response_outcome(
                    session_id,
                    &turn_id,
                    step,
                    ResponseAdmissionOutcome {
                        outcome: "rejected",
                        code: "DUPLICATE_TOOL_CALL_ID",
                        limit: None,
                        observed: None,
                    },
                )?;
                self.config.recorder.retry(
                    session_id,
                    &turn_id,
                    step as u64,
                    1,
                    FailureClass::Protocol,
                )?;
                self.close_step(
                    session_id,
                    &turn_id,
                    step,
                    step_usage,
                    !tools_enabled,
                    observer,
                )?;
                return self.finish(
                    session_id,
                    turn_id,
                    TurnEndStatus::Failed,
                    reason,
                    last_text.or(Some(text).filter(|text| !text.is_empty())),
                    step,
                    total_usage,
                    observer,
                );
            }
            if !text.is_empty() {
                last_text = Some(text.clone());
            }
            let content = if text.is_empty() {
                Vec::new()
            } else {
                vec![ContentPart::text(text.clone())]
            };
            let proposed: Vec<ToolCall> = calls.iter().map(|(call, _)| call.clone()).collect();
            self.append(
                session_id,
                Event::payload(
                    EventKind::AssistantMessage,
                    &AssistantMessagePayload {
                        turn_id: turn_id.clone(),
                        message_id: None,
                        content,
                        tool_calls: proposed.clone(),
                        interrupted: cancelled,
                    },
                ),
            )?;
            observer.on_event(RunEvent::AssistantMessage {
                step: step as u64,
                text: text.clone(),
                tool_calls: proposed.clone(),
            });

            if calls.is_empty() {
                history.push(Message::assistant(text.clone()));
                self.close_step(
                    session_id,
                    &turn_id,
                    step,
                    step_usage,
                    !tools_enabled,
                    observer,
                )?;
                let (status, reason) = if tools_enabled {
                    (
                        TurnEndStatus::Completed,
                        "model finished without tool calls".to_owned(),
                    )
                } else {
                    (
                        TurnEndStatus::Partial,
                        "step limit reached; tool-less wrap-up produced".to_owned(),
                    )
                };
                return self.finish(
                    session_id,
                    turn_id,
                    status,
                    reason,
                    Some(text).filter(|text| !text.is_empty()),
                    step,
                    total_usage,
                    observer,
                );
            }

            history.push(Message::assistant_tool_calls(
                text.clone(),
                proposed.clone(),
            ));

            // Tools disabled after the maximum steps: fail every call unsettled.
            if !tools_enabled {
                for call in &proposed {
                    self.append_tool_result(
                        session_id,
                        &turn_id,
                        &call.id,
                        ToolStatus::Error,
                        vec![ContentPart::text(
                            "tools are disabled after the maximum steps",
                        )],
                        Some("TOOLS_DISABLED"),
                        None,
                    )?;
                    history.push(Message::tool_result(
                        call.id.clone(),
                        "tools are disabled after the maximum steps",
                    ));
                }
                self.close_step(session_id, &turn_id, step, step_usage, true, observer)?;
                return self.finish(
                    session_id,
                    turn_id,
                    TurnEndStatus::Partial,
                    "step limit reached with pending tool calls".to_owned(),
                    Some(text).filter(|text| !text.is_empty()),
                    step,
                    total_usage,
                    observer,
                );
            }

            // Record every call durably before its effects begin.
            for (call, _) in &calls {
                let action = self.action_for(&call.name);
                self.append(
                    session_id,
                    Event::payload(
                        EventKind::ToolCall,
                        &ToolCallPayload {
                            turn_id: turn_id.clone(),
                            action: action.clone(),
                            tool_call: call.clone(),
                        },
                    ),
                )?;
                observer.on_event(RunEvent::ToolStarted {
                    tool_call: call.clone(),
                    action,
                });
                // Surface an approval request before the async authorization
                // runs, so an interactive surface can show it (`REQ-GUARD-003`).
                let ctx = self.tool_context(session_id, &turn_id, &gate, call, &cancel);
                if let Some(request) = self.tools.permission_request(call, &ctx)
                    && matches!(gate.classify(&request), Some(PolicyOutcome::Ask))
                {
                    observer.on_event(RunEvent::ApprovalRequested {
                        tool_call_id: call.id.clone(),
                        tool: call.name.clone(),
                        action: request.action.clone(),
                        resources: request.resources.clone(),
                    });
                }
            }

            let settlements = self
                .execute_calls(session_id, &turn_id, &gate, &calls, &cancel)
                .await;
            for event in self.config.recorder.drain_events() {
                observer.on_event(event);
            }
            for settlement in settlements {
                self.record_settlement(session_id, &turn_id, &settlement)?;
                self.append_tool_result(
                    session_id,
                    &turn_id,
                    &settlement.tool_call_id,
                    settlement.status,
                    settlement.model_content.clone(),
                    settlement.error_code.as_deref(),
                    settlement.ui_detail.clone(),
                )?;
                history.push(Message::tool_result(
                    settlement.tool_call_id.clone(),
                    settlement.model_text(),
                ));
                observer.on_event(RunEvent::ToolFinished { settlement });
            }

            self.close_step(session_id, &turn_id, step, step_usage, false, observer)?;
            step += 1;
        }

        self.finish(
            session_id,
            turn_id,
            TurnEndStatus::Partial,
            "step limit reached".to_owned(),
            last_text,
            step,
            total_usage,
            observer,
        )
    }

    fn action_for(&self, name: &str) -> String {
        // The registry mirrors the tool's declared action; fall back to the name.
        self.tools
            .action_for(name)
            .unwrap_or_else(|| name.to_owned())
    }

    fn tool_context(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        gate: &Arc<AuditedGate>,
        call: &ToolCall,
        cancel: &CancelToken,
    ) -> ToolContext {
        ToolContext {
            session_id: session_id.clone(),
            turn_id: Some(turn_id.clone()),
            tool_call_id: call.id.clone(),
            workspace: self.config.workspace.clone(),
            output_dir: self.config.output_dir.clone(),
            gate: Some(gate.clone()),
            sandbox: self.config.sandbox.clone(),
            resolved: self.config.sandbox_resolved.clone(),
            cancel: cancel.clone(),
        }
    }

    async fn execute_calls(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        gate: &Arc<AuditedGate>,
        calls: &[(ToolCall, Option<String>)],
        cancel: &CancelToken,
    ) -> Vec<Settlement> {
        let all_parallel = calls
            .iter()
            .all(|(call, error)| error.is_some() || self.tools.supports_parallel(&call.name));
        let limit = self.config.max_parallel_tools.max(1);

        if all_parallel {
            // Chunked so at most `limit` calls run concurrently. Explicit
            // boxed-free futures built in a loop avoid a higher-ranked
            // lifetime inference issue with iterator-returned async blocks.
            let mut results: Vec<(usize, Settlement)> = Vec::with_capacity(calls.len());
            for (chunk_index, chunk) in calls.chunks(limit).enumerate() {
                let base = chunk_index * limit;
                let mut futures = Vec::with_capacity(chunk.len());
                for (offset, (call, error)) in chunk.iter().enumerate() {
                    let index = base + offset;
                    let call = call.clone();
                    let error = error.clone();
                    let session_id = session_id.clone();
                    let turn_id = turn_id.clone();
                    let gate = gate.clone();
                    let cancel = cancel.clone();
                    futures.push(async move {
                        (
                            index,
                            self.settle_one(&session_id, &turn_id, &gate, &call, error, &cancel)
                                .await,
                        )
                    });
                }
                results.extend(futures::future::join_all(futures).await);
            }
            results.sort_by_key(|(index, _)| *index);
            results
                .into_iter()
                .map(|(_, settlement)| settlement)
                .collect()
        } else {
            let mut settlements = Vec::with_capacity(calls.len());
            for (call, error) in calls {
                settlements.push(
                    self.settle_one(session_id, turn_id, gate, call, error.clone(), cancel)
                        .await,
                );
            }
            settlements
        }
    }

    async fn settle_one(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        gate: &Arc<AuditedGate>,
        call: &ToolCall,
        argument_error: Option<String>,
        cancel: &CancelToken,
    ) -> Settlement {
        if let Some(error) = argument_error {
            return Settlement {
                tool: call.name.clone(),
                tool_call_id: call.id.clone(),
                status: ToolStatus::Error,
                model_content: vec![ContentPart::text(format!(
                    "Invalid tool input for `{}`: {error}",
                    call.name
                ))],
                structured: None,
                ui_detail: None,
                output_paths: Vec::new(),
                error_code: Some("TOOL_INVALID_INPUT".to_owned()),
            };
        }
        let ctx = self.tool_context(session_id, turn_id, gate, call, cancel);
        self.tools
            .settle(call, &ctx, gate.as_ref(), &self.config.output_bounds)
            .await
    }

    /// Records one settled tool call: the call, any file write, any confinement
    /// denial, and the matching analytics measurement.
    fn record_settlement(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        settlement: &Settlement,
    ) -> Result<(), RecordError> {
        let action = self.action_for(&settlement.tool);
        let call = ToolCall::new(
            settlement.tool_call_id.clone(),
            settlement.tool.clone(),
            serde_json::Value::Object(serde_json::Map::new()),
        );
        self.config.recorder.tool_settled(
            session_id,
            turn_id,
            &settlement.tool,
            &action,
            &call.arguments,
            settlement.status,
            settlement.error_code.as_deref(),
            settlement.structured.as_ref(),
            &format!("rcpt_{turn_id}_{}", settlement.tool_call_id.as_str()),
        )
    }

    fn append(&self, session_id: &SessionId, event: Event) -> Result<Event, LoopError> {
        Ok(self.store.append(session_id, event)?)
    }

    fn record_attempt(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        step: usize,
        message: &str,
    ) -> Result<(), LoopError> {
        self.append(
            session_id,
            Event::payload(
                EventKind::ModelAttempt,
                &serde_json::json!({
                    "turn_id": turn_id.as_str(),
                    "step": step,
                    "error": message,
                }),
            ),
        )?;
        Ok(())
    }

    fn record_response_outcome(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        step: usize,
        outcome: ResponseAdmissionOutcome,
    ) -> Result<(), LoopError> {
        self.append(
            session_id,
            Event::payload(
                EventKind::ModelAttempt,
                &serde_json::json!({
                    "turn_id": turn_id.as_str(),
                    "step": step,
                    "phase": "response_admission",
                    "outcome": outcome.outcome,
                    "code": outcome.code,
                    "limit": outcome.limit,
                    "observed": outcome.observed,
                }),
            ),
        )?;
        Ok(())
    }

    fn close_step(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        step: usize,
        usage: Usage,
        tools_disabled: bool,
        observer: &mut dyn RunObserver,
    ) -> Result<(), LoopError> {
        self.append(
            session_id,
            Event::payload(
                EventKind::StepEnd,
                &StepEndPayload {
                    turn_id: turn_id.clone(),
                    step: step as u64,
                    input_tokens: usage.input_tokens,
                    output_tokens: usage.output_tokens,
                    cached_read_tokens: usage.cached_read_tokens,
                    cached_write_tokens: usage.cached_write_tokens,
                    reasoning_tokens: usage.reasoning_tokens,
                    tools_disabled,
                },
            ),
        )?;
        // A per-step receipt reference, derived from the session and step so it
        // is stable and references the detail rather than duplicating it.
        self.config.recorder.step_settled(
            session_id,
            turn_id,
            step as u64,
            usage,
            &format!("rcpt_{turn_id}_{step}"),
            usage_observed(usage),
        )?;
        observer.on_event(RunEvent::StepFinished {
            step: step as u64,
            usage,
        });
        Ok(())
    }

    /// Records the confinement profile in force, or its typed absence.
    fn record_sandbox_profile(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
    ) -> Result<(), RecordError> {
        let profile = self
            .config
            .sandbox_resolved
            .as_ref()
            .map(|resolved| resolved.profile.as_str().to_owned());
        let applied = profile.is_some() && self.config.sandbox.is_some();
        self.config
            .recorder
            .sandbox_profile(session_id, turn_id, profile.as_deref(), applied)
    }

    #[allow(clippy::too_many_arguments)]
    fn append_tool_result(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        tool_call_id: &horizoncode_types::ToolCallId,
        status: ToolStatus,
        model_content: Vec<ContentPart>,
        error_code: Option<&str>,
        ui_detail: Option<Value>,
    ) -> Result<(), LoopError> {
        self.append(
            session_id,
            Event::payload(
                EventKind::ToolResult,
                &ToolResultPayload {
                    turn_id: turn_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                    status,
                    model_content,
                    error_code: error_code.map(str::to_owned),
                    ui_detail,
                },
            ),
        )?;
        Ok(())
    }

    #[allow(clippy::too_many_arguments)]
    fn finish(
        &self,
        session_id: &SessionId,
        turn_id: TurnId,
        status: TurnEndStatus,
        reason: String,
        final_text: Option<String>,
        steps: usize,
        usage: Usage,
        observer: &mut dyn RunObserver,
    ) -> Result<RunOutcome, LoopError> {
        self.append(
            session_id,
            Event::payload(
                EventKind::TurnEnd,
                &TurnEndPayload {
                    turn_id: turn_id.clone(),
                    status,
                    reason: reason.clone(),
                    final_text: final_text.clone(),
                },
            ),
        )?;
        // The terminal boundary is an audited boundary (`REQ-LOOP-004`), and
        // sealing here is what anchors the segment so the run's evidence is
        // covered by a signed root rather than left in the unanchored tail.
        self.config
            .recorder
            .turn_finished(session_id, &turn_id, status, steps, usage)?;
        observer.on_event(RunEvent::TurnFinished {
            status,
            reason: reason.clone(),
            final_text: final_text.clone(),
        });
        Ok(RunOutcome {
            turn_id,
            status,
            reason,
            final_text,
            steps,
            usage,
        })
    }
}

/// Returns whether a step's usage was reported by the provider rather than
/// defaulted. A provider that reports nothing is `false`, so analytics never
/// renders a fabricated zero.
fn usage_observed(usage: horizoncode_types::Usage) -> bool {
    usage.total() > 0
}

/// Maps a provider error onto the analytics failure taxonomy. Only the class is
/// recorded, never the message.
/// Admits the tool-call ids of one provider response, refusing a duplicate.
///
/// A tool-call id is a **correlation token**, not a globally unique identity: the
/// tool result is matched to its call by that id, and the conversation sent to the
/// provider carries both. Two calls sharing one id inside a turn therefore make
/// the exchange ambiguous — either result could belong to either call — and the
/// second call is also indistinguishable from a replay of the first, whose
/// single-use authorization is already spent (`ARCH/12` §Tickets).
///
/// # Errors
/// Returns the typed reason naming the offending id. A refusal ends the turn:
/// repairing the id would mint a value the provider never issued and silently
/// re-point the correlation, which is exactly the class of quiet repair the
/// architecture forbids.
fn admit_call_ids<'a>(
    prior: &mut HashSet<String>,
    calls: impl Iterator<Item = &'a ToolCall>,
) -> Result<(), String> {
    for call in calls {
        if !prior.insert(call.id.to_string()) {
            return Err(format!(
                "provider returned duplicate tool-call id `{}` in one turn; refusing the response \
                 rather than correlating two results to one call",
                call.id
            ));
        }
    }
    Ok(())
}

fn failure_class_of(error: &horizoncode_types::ProviderError) -> FailureClass {
    use horizoncode_types::ProviderErrorKind;
    match error.kind {
        ProviderErrorKind::Auth => FailureClass::Auth,
        ProviderErrorKind::RateLimit | ProviderErrorKind::Quota => FailureClass::RateLimit,
        ProviderErrorKind::Transport => FailureClass::Timeout,
        _ => FailureClass::ToolError,
    }
}

/// Hard memory ceilings applied while the provider response is still streaming.
#[derive(Clone, Copy, Debug)]
struct ResponseLimits {
    max_tool_calls: usize,
    max_tool_argument_bytes: usize,
    max_response_bytes: usize,
}

#[derive(Clone, Copy, Debug)]
struct ResponseAdmissionOutcome {
    outcome: &'static str,
    code: &'static str,
    limit: Option<usize>,
    observed: Option<usize>,
}

type SettledToolCalls = Vec<(ToolCall, Option<String>)>;

/// A response that cannot be admitted as one complete bounded batch.
#[derive(Debug, thiserror::Error)]
enum ResponseAssemblyError {
    #[error("response tool-call count exceeds the configured limit ({limit})")]
    ToolCallCount { limit: usize, observed: usize },
    #[error("response tool-argument bytes exceed the configured limit ({limit})")]
    ToolArgumentBytes { limit: usize, observed: usize },
    #[error("retained response bytes exceed the configured limit ({limit})")]
    ResponseBytes { limit: usize, observed: usize },
    #[error("provider emitted response data after its finish marker")]
    EventsAfterFinish,
    #[error("provider emitted more than one finish marker")]
    DuplicateFinish,
    #[error("provider emitted conflicting tool-call identity fragments")]
    ConflictingToolIdentity,
    #[error("provider response omitted a tool-call id")]
    MissingToolCallId,
    #[error("provider response omitted a tool name")]
    MissingToolName,
    #[error("provider emitted an unsupported response event")]
    UnsupportedEvent,
}

impl ResponseAssemblyError {
    fn code(&self) -> &'static str {
        match self {
            Self::ToolCallCount { .. } => "TOOL_CALL_COUNT_LIMIT",
            Self::ToolArgumentBytes { .. } => "TOOL_ARGUMENT_BYTES_LIMIT",
            Self::ResponseBytes { .. } => "RESPONSE_BYTES_LIMIT",
            Self::EventsAfterFinish => "EVENT_AFTER_FINISH",
            Self::DuplicateFinish => "DUPLICATE_FINISH",
            Self::ConflictingToolIdentity => "CONFLICTING_TOOL_IDENTITY",
            Self::MissingToolCallId => "MISSING_TOOL_CALL_ID",
            Self::MissingToolName => "MISSING_TOOL_NAME",
            Self::UnsupportedEvent => "UNSUPPORTED_RESPONSE_EVENT",
        }
    }

    fn limit(&self) -> Option<usize> {
        match self {
            Self::ToolCallCount { limit, .. }
            | Self::ToolArgumentBytes { limit, .. }
            | Self::ResponseBytes { limit, .. } => Some(*limit),
            _ => None,
        }
    }

    fn observed(&self) -> Option<usize> {
        match self {
            Self::ToolCallCount { observed, .. }
            | Self::ToolArgumentBytes { observed, .. }
            | Self::ResponseBytes { observed, .. } => Some(*observed),
            _ => None,
        }
    }
}

impl Default for ResponseLimits {
    fn default() -> Self {
        Self {
            max_tool_calls: crate::DEFAULT_MAX_TOOL_CALLS_PER_RESPONSE,
            max_tool_argument_bytes: crate::DEFAULT_MAX_TOOL_ARGUMENT_BYTES_PER_RESPONSE,
            max_response_bytes: crate::DEFAULT_MAX_RESPONSE_BYTES,
        }
    }
}

/// Accumulates one provider stream into a bounded provisional response.
#[derive(Debug, Default)]
struct StepAccumulator {
    text: String,
    usage: Usage,
    calls: BTreeMap<u32, PartialCall>,
    argument_bytes: usize,
    response_bytes: usize,
    finish_reason: Option<FinishReason>,
}

#[derive(Debug, Default)]
struct PartialCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl StepAccumulator {
    fn apply(
        &mut self,
        event: ModelEvent,
        observer: &mut dyn RunObserver,
        limits: ResponseLimits,
    ) -> Result<(), ResponseAssemblyError> {
        if self.finish_reason.is_some() && !matches!(&event, ModelEvent::Finished { .. }) {
            return Err(ResponseAssemblyError::EventsAfterFinish);
        }
        match event {
            ModelEvent::Started => {}
            ModelEvent::TextDelta { text } => {
                self.retain_response_bytes(text.len(), limits.max_response_bytes)?;
                self.text.push_str(&text);
                observer.on_event(RunEvent::TextDelta { text });
            }
            ModelEvent::ReasoningDelta { text } => {
                self.retain_response_bytes(text.len(), limits.max_response_bytes)?;
            }
            ModelEvent::Usage(usage) => self.usage = usage,
            ModelEvent::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => {
                if !self.calls.contains_key(&index) && self.calls.len() >= limits.max_tool_calls {
                    return Err(ResponseAssemblyError::ToolCallCount {
                        limit: limits.max_tool_calls,
                        observed: self.calls.len().saturating_add(1),
                    });
                }
                let argument_bytes = self.argument_bytes.saturating_add(arguments_delta.len());
                if argument_bytes > limits.max_tool_argument_bytes {
                    return Err(ResponseAssemblyError::ToolArgumentBytes {
                        limit: limits.max_tool_argument_bytes,
                        observed: argument_bytes,
                    });
                }
                let response_delta = id
                    .as_ref()
                    .map_or(0, String::len)
                    .saturating_add(name.as_ref().map_or(0, String::len))
                    .saturating_add(arguments_delta.len());
                self.retain_response_bytes(response_delta, limits.max_response_bytes)?;
                let entry = self.calls.entry(index).or_default();
                if let Some(id) = id {
                    if entry.id.as_ref().is_some_and(|existing| existing != &id) {
                        return Err(ResponseAssemblyError::ConflictingToolIdentity);
                    }
                    entry.id = Some(id);
                }
                if let Some(name) = name {
                    if entry
                        .name
                        .as_ref()
                        .is_some_and(|existing| existing != &name)
                    {
                        return Err(ResponseAssemblyError::ConflictingToolIdentity);
                    }
                    entry.name = Some(name);
                }
                entry.arguments.push_str(&arguments_delta);
                self.argument_bytes = argument_bytes;
            }
            ModelEvent::Finished { reason } => {
                if self.finish_reason.is_some() {
                    return Err(ResponseAssemblyError::DuplicateFinish);
                }
                if let FinishReason::Other(value) = &reason {
                    self.retain_response_bytes(value.len(), limits.max_response_bytes)?;
                }
                self.finish_reason = Some(reason);
            }
            _ => return Err(ResponseAssemblyError::UnsupportedEvent),
        }
        Ok(())
    }

    fn retain_response_bytes(
        &mut self,
        additional: usize,
        limit: usize,
    ) -> Result<(), ResponseAssemblyError> {
        let observed = self.response_bytes.saturating_add(additional);
        if observed > limit {
            return Err(ResponseAssemblyError::ResponseBytes { limit, observed });
        }
        self.response_bytes = observed;
        Ok(())
    }

    /// Returns the assistant text and parsed calls, refusing missing identity.
    fn settle_calls(self) -> Result<(String, SettledToolCalls), ResponseAssemblyError> {
        let mut calls = Vec::with_capacity(self.calls.len());
        for (_index, partial) in self.calls {
            let id = partial.id.ok_or(ResponseAssemblyError::MissingToolCallId)?;
            let name = partial.name.ok_or(ResponseAssemblyError::MissingToolName)?;
            if name.is_empty() {
                return Err(ResponseAssemblyError::MissingToolName);
            }
            let arguments = if partial.arguments.trim().is_empty() {
                Ok(Value::Object(serde_json::Map::new()))
            } else {
                serde_json::from_str::<Value>(&partial.arguments)
            };
            match arguments {
                Ok(value) => calls.push((ToolCall::new(id, name, value), None)),
                Err(error) => calls.push((
                    ToolCall::new(id, name, Value::Object(serde_json::Map::new())),
                    Some(error.to_string()),
                )),
            }
        }
        Ok((self.text, calls))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observer::NullObserver;

    fn call(id: &str) -> ToolCall {
        ToolCall::new(id, "read", serde_json::json!({"path": "a.txt"}))
    }

    /// `AX-356`: a response whose calls share one correlation id is refused,
    /// naming the id, rather than admitted into an ambiguous conversation.
    #[test]
    fn a_response_that_reuses_a_tool_call_id_is_refused() {
        let mut used = HashSet::new();
        let calls = [call("call_1"), call("call_2")];
        assert!(admit_call_ids(&mut used, calls.iter()).is_ok());

        // The same id in a later response of the same turn is a reuse too.
        let error = admit_call_ids(&mut used, [call("call_1")].iter())
            .expect_err("a reused id must be refused");
        assert!(error.contains("duplicate tool-call id `call_1`"), "{error}");
        assert!(error.contains("refusing the response"), "{error}");

        // A duplicate inside one response is caught before anything is admitted.
        let mut fresh = HashSet::new();
        let error = admit_call_ids(&mut fresh, [call("call_9"), call("call_9")].iter())
            .expect_err("a duplicate within one response must be refused");
        assert!(error.contains("call_9"), "{error}");
    }

    /// The refusal must not fire for ordinary unique ids, or every run breaks.
    #[test]
    fn unique_ids_are_admitted_and_remembered() {
        let mut used = HashSet::new();
        assert!(admit_call_ids(&mut used, [call("a"), call("b")].iter()).is_ok());
        assert_eq!(used.len(), 2);
        assert!(admit_call_ids(&mut used, [call("c")].iter()).is_ok());
        assert_eq!(used.len(), 3);
    }

    #[test]
    fn tool_call_fragments_accumulate_in_index_order() {
        let mut observer = NullObserver;
        let mut accumulator = StepAccumulator::default();
        accumulator
            .apply(
                ModelEvent::ToolCallDelta {
                    index: 0,
                    id: Some("call_1".to_owned()),
                    name: Some("read".to_owned()),
                    arguments_delta: "{\"pa".to_owned(),
                },
                &mut observer,
                ResponseLimits::default(),
            )
            .unwrap();
        accumulator
            .apply(
                ModelEvent::ToolCallDelta {
                    index: 0,
                    id: None,
                    name: None,
                    arguments_delta: "th\":\"a.txt\"}".to_owned(),
                },
                &mut observer,
                ResponseLimits::default(),
            )
            .unwrap();
        let (text, calls) = accumulator.settle_calls().unwrap();
        assert!(text.is_empty());
        assert_eq!(calls.len(), 1);
        let (call, error) = &calls[0];
        assert_eq!(call.id.as_str(), "call_1");
        assert_eq!(call.name, "read");
        assert_eq!(call.arguments["path"], "a.txt");
        assert!(error.is_none());
    }

    #[test]
    fn invalid_tool_arguments_are_flagged_not_dropped() {
        let mut observer = NullObserver;
        let mut accumulator = StepAccumulator::default();
        accumulator
            .apply(
                ModelEvent::ToolCallDelta {
                    index: 0,
                    id: Some("call_9".to_owned()),
                    name: Some("read".to_owned()),
                    arguments_delta: "{not json".to_owned(),
                },
                &mut observer,
                ResponseLimits::default(),
            )
            .unwrap();
        let (_, calls) = accumulator.settle_calls().unwrap();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1.is_some());
    }

    #[test]
    fn empty_arguments_default_to_an_empty_object() {
        let mut observer = NullObserver;
        let mut accumulator = StepAccumulator::default();
        accumulator
            .apply(
                ModelEvent::ToolCallDelta {
                    index: 0,
                    id: Some("call_2".to_owned()),
                    name: Some("list".to_owned()),
                    arguments_delta: String::new(),
                },
                &mut observer,
                ResponseLimits::default(),
            )
            .unwrap();
        let (_, calls) = accumulator.settle_calls().unwrap();
        assert_eq!(calls[0].0.arguments, serde_json::json!({}));
    }
}
