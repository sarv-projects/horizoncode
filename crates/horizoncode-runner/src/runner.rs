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
    CancelToken, ContentPart, Event, EventKind, Message, ModelEvent, ModelRequest, SessionId,
    ToolCall, ToolChoice, ToolStatus, TurnId, Usage,
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

            let mut stream = match self.provider.stream(request, cancel.clone()).await {
                Ok(stream) => stream,
                Err(error) => {
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
            loop {
                tokio::select! {
                    () = cancel.cancelled() => {
                        cancelled = true;
                        break;
                    }
                    item = stream.next() => {
                        match item {
                            None => break,
                            Some(Ok(event)) => accumulator.apply(event, observer),
                            Some(Err(error)) => {
                                stream_error = Some(error.to_string());
                                break;
                            }
                        }
                    }
                }
            }

            if let Some(error) = stream_error {
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

            total_usage.add_assign(accumulator.usage);
            let step_usage = accumulator.usage;
            let (text, calls) = accumulator.settle_calls();
            // A tool result is correlated to its call by the call id, so two calls
            // that share one id in the same turn cannot be told apart — and a
            // reused id is indistinguishable from a replay of the call that
            // already spent its authorization. Refuse the response rather than
            // invent a correlation the provider never issued (`AX-356`).
            if let Err(reason) =
                admit_call_ids(&mut used_call_ids, calls.iter().map(|(call, _)| call))
            {
                self.record_attempt(session_id, &turn_id, step, &reason)?;
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

            if cancelled {
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
                let ctx = self.tool_context(session_id, &turn_id, &gate, call);
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
                .execute_calls(session_id, &turn_id, &gate, &calls)
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
        }
    }

    async fn execute_calls(
        &self,
        session_id: &SessionId,
        turn_id: &TurnId,
        gate: &Arc<AuditedGate>,
        calls: &[(ToolCall, Option<String>)],
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
                    futures.push(async move {
                        (
                            index,
                            self.settle_one(&session_id, &turn_id, &gate, &call, error)
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
                    self.settle_one(session_id, turn_id, gate, call, error.clone())
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
        let ctx = self.tool_context(session_id, turn_id, gate, call);
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

/// Accumulates one provider stream into a settled assistant message.
#[derive(Debug, Default)]
struct StepAccumulator {
    text: String,
    usage: Usage,
    calls: BTreeMap<u32, PartialCall>,
}

#[derive(Debug, Default)]
struct PartialCall {
    id: Option<String>,
    name: Option<String>,
    arguments: String,
}

impl StepAccumulator {
    fn apply(&mut self, event: ModelEvent, observer: &mut dyn RunObserver) {
        match event {
            ModelEvent::Started | ModelEvent::Finished { .. } => {}
            ModelEvent::TextDelta { text } => {
                self.text.push_str(&text);
                observer.on_event(RunEvent::TextDelta { text });
            }
            ModelEvent::ReasoningDelta { .. } => {}
            ModelEvent::Usage(usage) => self.usage = usage,
            ModelEvent::ToolCallDelta {
                index,
                id,
                name,
                arguments_delta,
            } => {
                let entry = self.calls.entry(index).or_default();
                if id.is_some() {
                    entry.id = id;
                }
                if name.is_some() {
                    entry.name = name;
                }
                entry.arguments.push_str(&arguments_delta);
            }
            _ => {}
        }
    }

    /// Returns the assistant text and the parsed calls (with any argument
    /// decode error attached to the call).
    fn settle_calls(self) -> (String, Vec<(ToolCall, Option<String>)>) {
        let mut calls = Vec::with_capacity(self.calls.len());
        for (index, partial) in self.calls {
            let id = partial.id.unwrap_or_else(|| format!("call_{index}"));
            let name = partial.name.unwrap_or_default();
            if name.is_empty() {
                continue;
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
        (self.text, calls)
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
        accumulator.apply(
            ModelEvent::ToolCallDelta {
                index: 0,
                id: Some("call_1".to_owned()),
                name: Some("read".to_owned()),
                arguments_delta: "{\"pa".to_owned(),
            },
            &mut observer,
        );
        accumulator.apply(
            ModelEvent::ToolCallDelta {
                index: 0,
                id: None,
                name: None,
                arguments_delta: "th\":\"a.txt\"}".to_owned(),
            },
            &mut observer,
        );
        let (text, calls) = accumulator.settle_calls();
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
        accumulator.apply(
            ModelEvent::ToolCallDelta {
                index: 0,
                id: Some("call_9".to_owned()),
                name: Some("read".to_owned()),
                arguments_delta: "{not json".to_owned(),
            },
            &mut observer,
        );
        let (_, calls) = accumulator.settle_calls();
        assert_eq!(calls.len(), 1);
        assert!(calls[0].1.is_some());
    }

    #[test]
    fn empty_arguments_default_to_an_empty_object() {
        let mut observer = NullObserver;
        let mut accumulator = StepAccumulator::default();
        accumulator.apply(
            ModelEvent::ToolCallDelta {
                index: 0,
                id: Some("call_2".to_owned()),
                name: Some("list".to_owned()),
                arguments_delta: String::new(),
            },
            &mut observer,
        );
        let (_, calls) = accumulator.settle_calls();
        assert_eq!(calls[0].0.arguments, serde_json::json!({}));
    }
}
