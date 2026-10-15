//! Host-scoped owner for canonical effects.v2 operations.
//!
//! The service translates the canonical Core protocol into the existing durable,
//! Guarded EffectHost. A request's filesystem paths never establish authority;
//! registered Locations and authenticated peer principals do.

use crate::effect_host::{EffectHost, valid_environment_key};
use crate::messagepack::Value;
use crate::protocol::{
    CursorV1, ErrorCategoryV1, FrameFence, RetryClassV1, RpcControlV1, RpcEventV1, RpcMessageV1,
    RpcOutcomeV1, RpcRequestV1, RpcResponseV1, TypedErrorV1,
};
use crate::subscription::{BoundedSubscription, OfferResult};
use crate::terminal_process::{
    MAX_OUTPUT_BYTES, TerminalLaunchSpec, TerminalProcess, TerminationReason,
};
use crate::terminal_profile::{
    ResolvedShellProfile, ShellProfileKind, ShellProfileList, ShellProfileRegistration,
    ShellProfileRegistry,
};
use rusqlite::{Connection, OpenFlags, params};
use std::collections::{BTreeMap, HashMap};
use std::ffi::OsString;
use std::fs::{self, File};
use std::io::Read;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Component, Path, PathBuf};
use std::time::{Duration, Instant};

pub const EFFECTS_SERVICE_ID: &str = "effects.v2";
pub const TERMINAL_SERVICE_ID: &str = "terminal.v1";

/// A settled run's artifact is bounded by the same 100 MiB the durable EffectHost
/// store enforces when `settle_terminal_run` persists the captured output.
const MAX_TERMINAL_OUTPUT_BYTES: usize = 100 * 1024 * 1024;
/// Bounded, line-limited preview prefix served with every settled run.
const MAX_PREVIEW_BYTES: usize = 50 * 1024;
const MAX_PREVIEW_LINES: usize = 2_000;
/// Window allowed for observing exit after a timed-out run requested termination.
const TERMINATION_GRACE: Duration = Duration::from_secs(5);
const TERMINAL_COLUMNS: u16 = 80;
const TERMINAL_ROWS: u16 = 24;
/// Core owns one subscription per terminal; cap aggregate 31-event replay windows.
const MAX_TERMINAL_SUBSCRIPTIONS: usize = 16;
const MAX_TERMINAL_SUBSCRIPTIONS_PER_TERMINAL: usize = 1;

/// Ephemeral capability bindings are intentionally lost on owner restart. Durable
/// EffectHost challenges remain recoverable, but a previous epoch's lease is not.
#[derive(Clone)]
struct CapabilityBinding {
    challenge_id: String,
    effect_id: String,
    session_id: String,
    location_id: String,
    capability_id: String,
    principal: String,
    lease_digest: Option<String>,
    owner_epoch: u64,
}

#[derive(Clone)]
struct RegisteredLocation {
    canonical_root: PathBuf,
    workspace_id: String,
    effect_state_dir: PathBuf,
}

struct TerminalRunConfig {
    profile: ResolvedShellProfile,
    command: String,
    cwd: PathBuf,
    timeout: Duration,
    environment: BTreeMap<OsString, OsString>,
    canonical_arguments: Value,
}

struct TerminalStartConfig {
    profile: ResolvedShellProfile,
    argv: Vec<OsString>,
    cwd: PathBuf,
    environment: BTreeMap<OsString, OsString>,
    cols: u16,
    rows: u16,
    canonical_arguments: Value,
}
struct ActiveTerminal {
    process: TerminalProcess,
    effect_host: EffectHost,
    state: crate::terminal::TerminalState,
    effect_id: String,
    challenge_id: String,
    location_id: String,
    session_id: String,
    principal: String,
    attachments_by_ticket: HashMap<String, String>,
    cancellation_deadline_ms: Option<u64>,
}

struct TicketBinding {
    ticket_id: String,
    ticket: String,
    terminal_id: String,
    location_id: String,
    session_id: String,
    principal: String,
    origin: String,
    expires_at_ms: u64,
}

struct ActiveTicket {
    binding: TicketBinding,
}

struct TerminalSubscription {
    terminal_id: String,
    generation: u64,
    next_sequence: u64,
    byte_cursor: u64,
    window: BoundedSubscription,
}

pub struct HostKernel {
    state_dir: PathBuf,
    locations: HashMap<String, RegisteredLocation>,
    location_registry: Connection,
    shell_profiles: ShellProfileRegistry,
    challenges: HashMap<String, CapabilityBinding>,
    effects: HashMap<String, String>,
    terminals: HashMap<String, ActiveTerminal>,
    lost_terminals: HashMap<String, (String, u64)>,
    tickets: HashMap<String, ActiveTicket>,
    terminal_subscriptions: HashMap<String, TerminalSubscription>,
    revoked_tickets: HashMap<String, (String, String)>,
    /// Set from the negotiated hello; effect RPCs fail closed until effects.v2 is enabled.
    effects_enabled: bool,
}

impl HostKernel {
    /// Load trusted Locations and recover each per-Location EffectHost database
    /// before READY. Recovery settles only target-proven outcomes; unresolved
    /// effects remain durable UNKNOWN and are exposed as such, never retried.
    pub fn open(state_dir: &Path) -> Result<Self, String> {
        let location_state_root = state_dir.join("effect-locations");
        reject_unbound_legacy_effects(state_dir)?;
        ensure_private_directory(&location_state_root)?;
        let location_registry = open_location_registry(state_dir)?;
        let locations = load_locations(&location_registry, &location_state_root)?;
        let lost_terminals = load_lost_terminals(&location_registry)?;
        let shell_profiles =
            ShellProfileRegistry::open(&state_dir.join("shell-profiles.sqlite"))
                .map_err(|_| "shell profile registry could not be opened".to_owned())?;
        Ok(Self {
            state_dir: state_dir.to_owned(),
            locations,
            location_registry,
            shell_profiles,
            challenges: HashMap::new(),
            effects: HashMap::new(),
            terminals: HashMap::new(),
            lost_terminals,
            tickets: HashMap::new(),
            terminal_subscriptions: HashMap::new(),
            revoked_tickets: HashMap::new(),
            effects_enabled: false,
        })
    }

    /// Records the negotiated `effects.v2` feature for this connection.
    pub fn set_effects_enabled(&mut self, enabled: bool) {
        self.effects_enabled = enabled;
    }

    pub fn handle_request(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> RpcResponseV1 {
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
            .unwrap_or(u64::MAX);
        let result = if fence
            .validate_frame(request.owner_epoch, &request.process_incarnation)
            .is_err()
        {
            Err((
                "stale_fence",
                ErrorCategoryV1::Authorization,
                "request owner epoch or process incarnation is stale",
            ))
        } else if crate::protocol::validate_deadline(request.deadline_unix_ms, now_ms, false)
            .is_err()
        {
            Err((
                "deadline_exceeded",
                ErrorCategoryV1::Validation,
                "effect request deadline is expired or exceeds the allowed window",
            ))
        } else if !valid_principal(principal) {
            Err((
                "missing_principal",
                ErrorCategoryV1::Authorization,
                "authenticated peer principal is unavailable",
            ))
        } else if request.service_id != EFFECTS_SERVICE_ID
            && request.service_id != TERMINAL_SERVICE_ID
        {
            Err((
                "capability_unavailable",
                ErrorCategoryV1::Capability,
                "service is unavailable",
            ))
        } else if request.service_id == EFFECTS_SERVICE_ID && !self.effects_enabled {
            Err((
                "feature_not_negotiated",
                ErrorCategoryV1::Capability,
                "effects.v2 was not negotiated for this connection",
            ))
        } else if crate::protocol::validate_operation_body(
            &request.body,
            crate::protocol::MAX_BODY_BYTES,
        )
        .is_err()
        {
            Err(invalid())
        } else {
            match (request.service_id.as_str(), request.operation.as_str()) {
                (EFFECTS_SERVICE_ID, "register_location") => {
                    self.register_location(&request.body).map(Some)
                }
                (EFFECTS_SERVICE_ID, "prepare_tool_batch") => {
                    self.prepare_tool_batch(request, principal, fence)
                }
                (EFFECTS_SERVICE_ID, "prepare_user_effect") => {
                    self.prepare_user_effect(request, principal, fence)
                }
                (EFFECTS_SERVICE_ID, "resolve_approval") => {
                    self.resolve_approval(request, principal, fence)
                }
                (EFFECTS_SERVICE_ID, "execute_write") => {
                    self.execute_write(request, principal, fence)
                }
                (EFFECTS_SERVICE_ID, "execute_patch") => {
                    self.execute_patch(request, principal, fence)
                }
                (EFFECTS_SERVICE_ID, "reconcile_effect") => {
                    self.reconcile_effect(request, principal, fence)
                }
                (TERMINAL_SERVICE_ID, "register_shell_profiles") => {
                    self.register_shell_profiles(&request.body).map(Some)
                }
                (TERMINAL_SERVICE_ID, "run") => self.run_terminal(request, principal, fence),
                (TERMINAL_SERVICE_ID, "start") => self.start_terminal(request, principal, fence),
                (TERMINAL_SERVICE_ID, "input") => self.input_terminal(request, principal, fence),
                (TERMINAL_SERVICE_ID, "resize") => self.resize_terminal(request, principal, fence),
                (TERMINAL_SERVICE_ID, "cancel") => self.cancel_terminal(request, principal, fence),
                (TERMINAL_SERVICE_ID, "status") => self.status_terminal(request, principal, fence),
                (TERMINAL_SERVICE_ID, "ticket_acquire") => self
                    .acquire_terminal_ticket(&request.body, principal, fence)
                    .map(Some),
                (TERMINAL_SERVICE_ID, "ticket_consume") => self
                    .consume_terminal_ticket(&request.body, principal, fence)
                    .map(Some),
                (TERMINAL_SERVICE_ID, "ticket_revoke") => self
                    .revoke_terminal_ticket(&request.body, principal)
                    .map(Some),
                _ => Err((
                    "capability_unavailable",
                    ErrorCategoryV1::Capability,
                    "operation is unavailable",
                )),
            }
        };
        match result {
            Ok(Some(body)) => response_ok(request, fence, body),
            Ok(None) => response_error(
                request,
                fence,
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "effect operation is unavailable",
            ),
            Err((code, category, message)) => {
                response_error(request, fence, code, category, message)
            }
        }
    }
    pub fn handle_terminal_control(
        &mut self,
        control: &RpcControlV1,
        fence: &FrameFence,
    ) -> Vec<RpcMessageV1> {
        if fence
            .validate_message(&RpcMessageV1::Control(Box::new(control.clone())))
            .is_err()
        {
            return Vec::new();
        }
        match control {
            RpcControlV1::Subscribe {
                subscription_id,
                owner_kind,
                owner_id,
                after: Some(after),
                ..
            } if owner_kind == "terminal" && owner_id.starts_with("pty_") => {
                let Some(terminal) = self.terminals.get(owner_id) else {
                    return vec![resnapshot_message(fence, subscription_id, after, after)];
                };
                let latest = terminal_latest_cursor(&terminal.state.replay, owner_id)
                    .unwrap_or_else(|| after.clone());
                let per_terminal = self
                    .terminal_subscriptions
                    .values()
                    .filter(|subscription| subscription.terminal_id.as_str() == owner_id.as_str())
                    .count();
                if let Some(rejection) = terminal_subscription_rejection(
                    self.terminal_subscriptions.len(),
                    per_terminal,
                    self.terminal_subscriptions.contains_key(subscription_id),
                    fence,
                    subscription_id,
                    after,
                    &latest,
                ) {
                    return vec![rejection];
                }
                let Some(terminal) = self.terminals.get_mut(owner_id) else {
                    return vec![resnapshot_message(fence, subscription_id, after, &latest)];
                };
                if drain_interactive(terminal).is_err() {
                    mark_interactive_unknown(terminal);
                }
                if matches!(
                    terminal.state.status,
                    crate::terminal::TerminalStatus::Running
                ) {
                    match terminal.process.try_wait() {
                        Ok(Some(exit)) => observe_interactive_exit(terminal, exit),
                        Ok(None) => {}
                        Err(_) => mark_interactive_unknown(terminal),
                    }
                }
                let latest = terminal_latest_cursor(&terminal.state.replay, owner_id)
                    .unwrap_or_else(|| after.clone());
                let Ok(sequence) = after.seq.parse::<u64>() else {
                    return vec![resnapshot_message(fence, subscription_id, after, &latest)];
                };
                let Some((actual, byte_cursor)) =
                    terminal.state.replay.cursor_at(owner_id, sequence)
                else {
                    return vec![resnapshot_message(fence, subscription_id, after, &latest)];
                };
                if actual != *after {
                    return vec![resnapshot_message(fence, subscription_id, after, &latest)];
                }
                let Ok((gap, replay)) = terminal.state.replay.replay_after(
                    terminal.state.generation,
                    sequence,
                    byte_cursor,
                ) else {
                    return vec![resnapshot_message(fence, subscription_id, after, &latest)];
                };
                if gap.is_some() {
                    return vec![resnapshot_message(fence, subscription_id, after, &latest)];
                }
                let Ok(mut window) = BoundedSubscription::new(
                    subscription_id.clone(),
                    "terminal",
                    owner_id.clone(),
                    after.clone(),
                    31,
                    fence.clone(),
                ) else {
                    return Vec::new();
                };
                let mut next_sequence = sequence.saturating_add(1);
                let mut next_byte_cursor = byte_cursor;
                for chunk in replay {
                    let Some(event) = terminal_rpc_event(fence, subscription_id, owner_id, &chunk)
                    else {
                        return Vec::new();
                    };
                    match window.offer(event) {
                        Ok(OfferResult::Queued) => {
                            next_sequence = chunk.sequence.saturating_add(1);
                            next_byte_cursor = chunk.byte_cursor;
                        }
                        Ok(OfferResult::Backpressured | OfferResult::Duplicate) => break,
                        Err(_) => {
                            let latest = terminal_latest_cursor(&terminal.state.replay, owner_id)
                                .unwrap_or_else(|| after.clone());
                            return vec![resnapshot_message(
                                fence,
                                subscription_id,
                                after,
                                &latest,
                            )];
                        }
                    }
                }
                self.terminal_subscriptions.insert(
                    subscription_id.clone(),
                    TerminalSubscription {
                        terminal_id: owner_id.clone(),
                        generation: terminal.state.generation,
                        next_sequence,
                        byte_cursor: next_byte_cursor,
                        window,
                    },
                );
                self.take_terminal_events(subscription_id, fence)
            }
            RpcControlV1::Subscribe { .. } => Vec::new(),
            RpcControlV1::Unsubscribe {
                subscription_id, ..
            } => {
                self.terminal_subscriptions.remove(subscription_id);
                Vec::new()
            }
            RpcControlV1::Ack {
                subscription_id,
                through,
                ..
            } => {
                let Some(subscription) = self.terminal_subscriptions.get_mut(subscription_id)
                else {
                    return Vec::new();
                };
                if subscription.window.ack(through).is_err() {
                    return Vec::new();
                }
                self.pump_terminal_subscription(subscription_id, fence)
            }
            _ => Vec::new(),
        }
    }

    pub fn poll_terminal_events(&mut self, fence: &FrameFence) -> Vec<RpcMessageV1> {
        let ids = self
            .terminal_subscriptions
            .keys()
            .cloned()
            .collect::<Vec<_>>();
        let mut messages = Vec::new();
        for id in ids {
            messages.extend(self.pump_terminal_subscription(&id, fence));
        }
        messages
    }

    fn pump_terminal_subscription(
        &mut self,
        subscription_id: &str,
        fence: &FrameFence,
    ) -> Vec<RpcMessageV1> {
        let Some(subscription) = self.terminal_subscriptions.get(subscription_id) else {
            return Vec::new();
        };
        let terminal_id = subscription.terminal_id.clone();
        let Some(terminal) = self.terminals.get_mut(&terminal_id) else {
            self.terminal_subscriptions.remove(subscription_id);
            return Vec::new();
        };
        if drain_interactive(terminal).is_err() {
            mark_interactive_unknown(terminal);
        }
        if matches!(
            terminal.state.status,
            crate::terminal::TerminalStatus::Running
        ) {
            match terminal.process.try_wait() {
                Ok(Some(exit)) => observe_interactive_exit(terminal, exit),
                Ok(None) => {}
                Err(_) => mark_interactive_unknown(terminal),
            }
        }
        let Some(subscription) = self.terminal_subscriptions.get_mut(subscription_id) else {
            return Vec::new();
        };
        let after_sequence = subscription.next_sequence.saturating_sub(1);
        let (gap, chunks) = match terminal.state.replay.replay_after(
            subscription.generation,
            after_sequence,
            subscription.byte_cursor,
        ) {
            Ok(result) => result,
            Err(_) => {
                self.terminal_subscriptions.remove(subscription_id);
                return Vec::new();
            }
        };
        if gap.is_some() {
            let requested = subscription.window.acknowledged_cursor().clone();
            let latest = terminal
                .state
                .replay
                .cursor_at(
                    &terminal_id,
                    terminal.state.replay.next_sequence().saturating_sub(1),
                )
                .map(|(cursor, _)| cursor)
                .unwrap_or_else(|| requested.clone());
            self.terminal_subscriptions.remove(subscription_id);
            return vec![resnapshot_message(
                fence,
                subscription_id,
                &requested,
                &latest,
            )];
        }
        for chunk in chunks {
            let Some(event) = terminal_rpc_event(fence, subscription_id, &terminal_id, &chunk)
            else {
                self.terminal_subscriptions.remove(subscription_id);
                return Vec::new();
            };
            match subscription.window.offer(event) {
                Ok(OfferResult::Queued) => {
                    subscription.next_sequence = chunk.sequence.saturating_add(1);
                    subscription.byte_cursor = chunk.byte_cursor;
                }
                Ok(OfferResult::Backpressured) => break,
                Ok(OfferResult::Duplicate) => break,
                Err(_) => {
                    let requested = subscription.window.acknowledged_cursor().clone();
                    let latest = terminal
                        .state
                        .replay
                        .cursor_at(
                            &terminal_id,
                            terminal.state.replay.next_sequence().saturating_sub(1),
                        )
                        .map(|(cursor, _)| cursor)
                        .unwrap_or_else(|| requested.clone());
                    self.terminal_subscriptions.remove(subscription_id);
                    return vec![resnapshot_message(
                        fence,
                        subscription_id,
                        &requested,
                        &latest,
                    )];
                }
            }
        }
        self.take_terminal_events(subscription_id, fence)
    }

    fn take_terminal_events(
        &mut self,
        subscription_id: &str,
        fence: &FrameFence,
    ) -> Vec<RpcMessageV1> {
        let Some(subscription) = self.terminal_subscriptions.get_mut(subscription_id) else {
            return Vec::new();
        };
        let mut messages = Vec::new();
        while let Some(event) = subscription.window.next_event() {
            messages.push(RpcMessageV1::Event(Box::new(event)));
        }
        // ACK windows remain bounded; callers receive only the currently queued page.
        let _ = fence;
        messages
    }

    fn register_shell_profiles(&mut self, body: &Value) -> Result<Value, HostError> {
        let fields = strict_fields(body, &["defaultProfileKey", "profiles"], &[])?;
        let default_profile_key = text(fields, "defaultProfileKey")?;
        let Some(Value::Array(profiles)) = fields.get("profiles") else {
            return Err(invalid());
        };
        if profiles.is_empty() || profiles.len() > 32 {
            return Err(invalid());
        }
        let mut registrations = Vec::with_capacity(profiles.len());
        for value in profiles {
            let fields = strict_fields(
                value,
                &["profileKey", "kind", "executable", "login"],
                &["distribution"],
            )?;
            let kind = ShellProfileKind::parse(text(fields, "kind")?).ok_or((
                "profile_unavailable",
                ErrorCategoryV1::Unavailable,
                "shell profile kind is unsupported",
            ))?;
            if kind != ShellProfileKind::PosixBash {
                return Err((
                    "profile_unavailable",
                    ErrorCategoryV1::Unavailable,
                    "only the registered Linux Bash profile is available",
                ));
            }
            let executable = text(fields, "executable")?;
            if executable.len() > 4096 || !Path::new(executable).is_absolute() {
                return Err(invalid());
            }
            let login = match fields.get("login") {
                Some(Value::Bool(value)) => *value,
                _ => return Err(invalid()),
            };
            let distribution = match fields.get("distribution") {
                None => None,
                Some(Value::String(value)) if value.len() <= 128 => Some(value.clone()),
                _ => return Err(invalid()),
            };
            registrations.push(ShellProfileRegistration {
                profile_key: text(fields, "profileKey")?.to_owned(),
                kind,
                executable: PathBuf::from(executable),
                login,
                distribution,
            });
        }
        let list = self
            .shell_profiles
            .register_profiles(default_profile_key, registrations)
            .map_err(|_| {
                (
                    "profile_unavailable",
                    ErrorCategoryV1::Unavailable,
                    "shell profiles could not be registered",
                )
            })?;
        shell_profile_list_value(&list)
    }

    fn register_location(&mut self, body: &Value) -> Result<Value, HostError> {
        let fields = strict_fields(body, &["canonicalRoot"], &["workspaceID"])?;
        let requested = text(fields, "canonicalRoot")?;
        if requested.len() > 4096 || !Path::new(requested).is_absolute() {
            return Err(invalid());
        }
        let workspace_id = match fields.get("workspaceID") {
            None => "",
            Some(Value::String(value)) if value.len() <= 256 && !value.contains('\0') => {
                value.as_str()
            }
            _ => return Err(invalid()),
        };
        let canonical = fs::canonicalize(requested).map_err(|_| invalid())?;
        if !canonical.is_absolute()
            || !fs::metadata(&canonical).is_ok_and(|metadata| metadata.is_dir())
        {
            return Err(invalid());
        }
        let canonical_text = canonical.to_str().ok_or_else(invalid)?;
        let id = location_id(canonical_text, workspace_id);
        if self.locations.get(&id).is_some_and(|existing| {
            existing.canonical_root != canonical || existing.workspace_id != workspace_id
        }) {
            return Err((
                "location_conflict",
                ErrorCategoryV1::Conflict,
                "Location identifier is already bound",
            ));
        }
        let effect_state_dir = self.state_dir.join("effect-locations").join(&id);
        ensure_private_directory(&effect_state_dir).map_err(|_| {
            (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "Location effect state is unavailable",
            )
        })?;
        drop(
            EffectHost::open_live(&effect_state_dir, Some(&canonical)).map_err(|_| {
                (
                    "effect_unavailable",
                    ErrorCategoryV1::Unavailable,
                    "Location effect recovery failed",
                )
            })?,
        );
        let transaction = self.location_registry.transaction().map_err(|_| {
            (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "Location registry is unavailable",
            )
        })?;
        transaction.execute(
            "INSERT INTO locations(location_id, canonical_root, workspace_id) VALUES (?1, ?2, ?3)
             ON CONFLICT(location_id) DO NOTHING",
            params![id, canonical_text, workspace_id],
        ).map_err(|_| ("effect_unavailable", ErrorCategoryV1::Unavailable, "Location binding could not be persisted"))?;
        let stored: (String, String) = transaction
            .query_row(
                "SELECT canonical_root, workspace_id FROM locations WHERE location_id=?1",
                [&id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| {
                (
                    "effect_unavailable",
                    ErrorCategoryV1::Unavailable,
                    "Location binding could not be verified",
                )
            })?;
        if stored != (canonical_text.to_owned(), workspace_id.to_owned()) {
            return Err((
                "location_conflict",
                ErrorCategoryV1::Conflict,
                "Location identifier is already bound",
            ));
        }
        transaction.commit().map_err(|_| {
            (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "Location binding could not be committed",
            )
        })?;
        self.locations.insert(
            id.clone(),
            RegisteredLocation {
                canonical_root: canonical,
                workspace_id: workspace_id.to_owned(),
                effect_state_dir,
            },
        );
        Ok(map_value([
            ("status", Value::String("registered".to_owned())),
            ("locationID", Value::String(id)),
        ]))
    }

    fn prepare_user_effect(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &["locationID", "userActionID", "capabilityID", "arguments"],
            &["sessionID"],
        )?;
        let location = self.location(fields)?.clone();
        let action_id = text(fields, "userActionID")?;
        let capability = text(fields, "capabilityID")?;
        if capability != crate::guard::TERMINAL_RUN_ID
            && capability != crate::guard::TERMINAL_START_ID
        {
            return Err((
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "terminal capability is unsupported",
            ));
        }
        let session = match fields.get("sessionID") {
            None => "",
            Some(Value::String(value)) if !value.is_empty() && !value.contains('\0') => value,
            _ => return Err(invalid()),
        };
        let Some(arguments @ Value::Map(_)) = fields.get("arguments") else {
            return Err(invalid());
        };
        let (target_cwd, canonical_arguments, operation) = if capability
            == crate::guard::TERMINAL_RUN_ID
        {
            let config = validate_terminal_arguments(arguments, &location, &self.shell_profiles)?;
            (config.cwd, config.canonical_arguments, "run")
        } else {
            let config =
                validate_terminal_start_arguments(arguments, &location, &self.shell_profiles)?;
            (config.cwd, config.canonical_arguments, "start")
        };
        let mut inner_fields = BTreeMap::from([
            (
                "userActionId".to_owned(),
                Value::String(action_id.to_owned()),
            ),
            (
                "capabilityId".to_owned(),
                Value::String(capability.to_owned()),
            ),
            ("arguments".to_owned(), canonical_arguments),
        ]);
        if !session.is_empty() {
            inner_fields.insert("sessionId".to_owned(), Value::String(session.to_owned()));
        }
        let inner_body = Value::Map(inner_fields);
        let mut inner = request.clone();
        inner.service_id = EFFECTS_SERVICE_ID.to_owned();
        inner.operation = "prepare_user_effect".to_owned();
        inner.body = inner_body;
        let mut effect_host =
            EffectHost::open_live(&location.effect_state_dir, Some(&location.canonical_root))
                .map_err(|_| {
                    (
                        "effect_unavailable",
                        ErrorCategoryV1::Unavailable,
                        "EffectHost could not open the registered Location",
                    )
                })?;
        // The host does not own Session identity, so a user action is admitted with no
        // process Session; the principal and the explicit approval carry its authority.
        let response = effect_host.handle_request("", principal, &inner, true, fence);
        if response.outcome == RpcOutcomeV1::Error {
            let error = response.error.as_ref().ok_or_else(invalid)?;
            let (code, message) = match error.code.as_str() {
                "invalid_effect_request" => {
                    ("invalid_effect_request", "user-effect request is malformed")
                }
                "effect_outcome_unknown" => (
                    "effect_outcome_unknown",
                    "effect outcome is unknown and must not be retried",
                ),
                "effect_conflict" => (
                    "effect_conflict",
                    "user-effect challenge is expired or consumed",
                ),
                "effect_denied" => ("effect_denied", "Guard denied the user action"),
                _ => (
                    "effect_unavailable",
                    "EffectHost could not admit the user action",
                ),
            };
            return Err((code, error.category, message));
        }
        let Some(Value::Map(mut body)) = response.body else {
            return Err(invalid());
        };
        if get_text(&body, "status")? == "denied" {
            return Ok(Some(map_value([
                ("status", Value::String("denied".to_owned())),
                (
                    "reason",
                    body.remove("reason")
                        .unwrap_or(Value::String("Guard denied the user action".to_owned())),
                ),
            ])));
        }
        if get_text(&body, "status")? != "needs_approval" {
            return Err(invalid());
        }
        let challenge_id = get_text(&body, "challengeId")?.to_owned();
        let effect_id = get_text(&body, "effectId")?.to_owned();
        let input_digest = get_text(&body, "inputDigest")?.to_owned();
        let expires = get_unsigned(&body, "expiresAtUnixMs")?;
        let location_id = text(fields, "locationID")?.to_owned();
        let fallback_targets = Value::Array(vec![map_value([
            (
                "target",
                Value::String(target_cwd.to_string_lossy().into_owned()),
            ),
            (
                "resource",
                Value::String(relative_to_location(&location.canonical_root, &target_cwd)?),
            ),
            ("operation", Value::String(operation.to_owned())),
            ("existed", Value::Bool(false)),
        ])]);
        let normalized_targets = body.remove("normalizedTargets").unwrap_or(fallback_targets);
        self.challenges.insert(
            challenge_id.clone(),
            CapabilityBinding {
                challenge_id: challenge_id.clone(),
                effect_id: effect_id.clone(),
                session_id: session.to_owned(),
                location_id: location_id.clone(),
                capability_id: capability.to_owned(),
                principal: principal.to_owned(),
                lease_digest: None,
                owner_epoch: fence.owner_epoch(),
            },
        );
        self.effects.insert(effect_id.clone(), challenge_id.clone());
        Ok(Some(map_value([
            ("status", Value::String("needs_approval".to_owned())),
            ("challengeID", Value::String(challenge_id)),
            ("effectID", Value::String(effect_id)),
            ("capabilityID", Value::String(capability.to_owned())),
            ("locationID", Value::String(location_id)),
            ("inputDigest", Value::String(input_digest)),
            ("targets", normalized_targets.clone()),
            ("normalizedTargets", normalized_targets),
            ("expiresAtUnixMs", Value::Unsigned(expires)),
            (
                "policySummary",
                Value::String(
                    if capability == crate::guard::TERMINAL_START_ID {
                        "terminal.start requires explicit approval"
                    } else {
                        "terminal.run requires explicit approval"
                    }
                    .to_owned(),
                ),
            ),
        ])))
    }

    fn prepare_tool_batch(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "sessionID",
                "locationID",
                "batchID",
                "turnContextDigest",
                "calls",
            ],
            &[],
        )?;
        let location = self.location(fields)?.clone();
        let session = text(fields, "sessionID")?.to_owned();
        let batch = text(fields, "batchID")?.to_owned();
        let turn_digest = text(fields, "turnContextDigest")?.to_owned();
        if !crate::guard::is_sha256_digest(&turn_digest) {
            return Err(invalid());
        }
        let Some(Value::Array(calls)) = fields.get("calls") else {
            return Err(invalid());
        };
        if calls.is_empty() || calls.len() > 64 {
            return Err(invalid());
        }
        let mut canonical_calls = Vec::with_capacity(calls.len());
        let mut capabilities = Vec::with_capacity(calls.len());
        for call in calls {
            let call = strict_fields(call, &["callID", "capabilityID", "arguments"], &[])?;
            let call_id = text(call, "callID")?.to_owned();
            let capability = text(call, "capabilityID")?.to_owned();
            let Some(arguments @ Value::Map(_)) = call.get("arguments") else {
                return Err(invalid());
            };
            let canonical_arguments = if capability == crate::guard::TERMINAL_RUN_ID {
                validate_terminal_arguments(arguments, &location, &self.shell_profiles)?
                    .canonical_arguments
            } else if capability == crate::guard::FILES_WRITE_ID {
                let arguments = strict_fields(arguments, &["path", "content"], &[])?;
                text(arguments, "path")?;
                string_value(arguments, "content")?;
                call.get("arguments").ok_or_else(invalid)?.clone()
            } else if capability == crate::guard::FILES_PATCH_ID {
                let arguments = strict_fields(arguments, &["operations"], &[])?;
                validate_patch_operations(arguments.get("operations").ok_or_else(invalid)?)?;
                call.get("arguments").ok_or_else(invalid)?.clone()
            } else {
                call.get("arguments").ok_or_else(invalid)?.clone()
            };
            canonical_calls.push(map_value([
                ("callId", Value::String(call_id)),
                ("capabilityId", Value::String(capability.clone())),
                ("arguments", canonical_arguments),
            ]));
            capabilities.push(capability);
        }
        if calls.len() != 1 {
            return Err((
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "EffectHost currently admits one complete effectful call per batch",
            ));
        }
        let capability = capabilities[0].clone();
        if capability != crate::guard::FILES_WRITE_ID
            && capability != crate::guard::FILES_PATCH_ID
            && capability != crate::guard::TERMINAL_RUN_ID
        {
            return Err((
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "capability is not supported by EffectHost",
            ));
        }
        let inner = map_value([
            ("sessionId", Value::String(session.clone())),
            ("batchId", Value::String(batch)),
            ("turnContextDigest", Value::String(turn_digest)),
            ("calls", Value::Array(canonical_calls)),
        ]);
        let response =
            self.effect_request(request, principal, fence, &location, &session, inner)?;
        let Some(Value::Map(mut response_fields)) = response.body else {
            return Err((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "Guard denied the complete tool batch",
            ));
        };
        if get_text(&response_fields, "status")? == "denied" {
            return Ok(Some(map_value([
                ("status", Value::String("denied".to_owned())),
                (
                    "reason",
                    response_fields
                        .remove("reason")
                        .unwrap_or(Value::String("Guard denied the batch".to_owned())),
                ),
            ])));
        }
        if get_text(&response_fields, "status")? != "needs_approval" {
            return Err(invalid());
        }
        let challenge_id = get_text(&response_fields, "challengeId")?.to_owned();
        let effect_id = get_text(&response_fields, "effectId")?.to_owned();
        let input_digest = get_text(&response_fields, "inputDigest")?.to_owned();
        let expires = get_unsigned(&response_fields, "expiresAtUnixMs")?;
        let targets = response_fields
            .remove("normalizedTargets")
            .ok_or_else(invalid)?;
        let location_id = text(fields, "locationID")?.to_owned();
        self.challenges.insert(
            challenge_id.clone(),
            CapabilityBinding {
                challenge_id: challenge_id.clone(),
                effect_id: effect_id.clone(),
                session_id: session,
                location_id: location_id.clone(),
                capability_id: capability.clone(),
                principal: principal.to_owned(),
                lease_digest: None,
                owner_epoch: fence.owner_epoch(),
            },
        );
        self.effects.insert(effect_id.clone(), challenge_id.clone());
        let policy_summary = if capability == crate::guard::TERMINAL_RUN_ID {
            "terminal.run requires explicit approval"
        } else {
            "workspace-write.local.v1 requires explicit approval"
        };
        Ok(Some(map_value([
            ("status", Value::String("needs_approval".to_owned())),
            ("challengeID", Value::String(challenge_id)),
            ("effectID", Value::String(effect_id)),
            ("capabilityID", Value::String(capability)),
            ("locationID", Value::String(location_id)),
            ("inputDigest", Value::String(input_digest)),
            ("targets", targets.clone()),
            ("normalizedTargets", targets),
            ("expiresAtUnixMs", Value::Unsigned(expires)),
            ("policySummary", Value::String(policy_summary.to_owned())),
        ])))
    }

    fn resolve_approval(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(&request.body, &["challengeID", "decision"], &[])?;
        let challenge_id = text(fields, "challengeID")?;
        let decision = text(fields, "decision")?;
        if decision != "allow_once" && decision != "deny" {
            return Err(invalid());
        }
        let binding = self
            .challenges
            .get(challenge_id)
            .ok_or((
                "approval_not_found",
                ErrorCategoryV1::NotFound,
                "approval challenge was not found",
            ))?
            .clone();
        if binding.principal != principal
            || binding.owner_epoch != fence.owner_epoch()
            || binding.lease_digest.is_some()
        {
            return Err((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "approval principal, owner epoch, or one-use state does not match",
            ));
        }
        let location = self
            .locations
            .get(&binding.location_id)
            .ok_or((
                "location_not_registered",
                ErrorCategoryV1::Authorization,
                "trusted Location is not registered",
            ))?
            .clone();
        let inner = map_value([
            ("sessionId", Value::String(binding.session_id.clone())),
            ("challengeId", Value::String(binding.challenge_id.clone())),
            ("approved", Value::Bool(decision == "allow_once")),
        ]);
        let response = self.effect_request(
            request,
            principal,
            fence,
            &location,
            &binding.session_id,
            inner,
        )?;
        let Some(Value::Map(body)) = response.body else {
            return Err((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "Guard rejected the approval",
            ));
        };
        if get_text(&body, "status")?
            != if decision == "allow_once" {
                "approved"
            } else {
                "denied"
            }
        {
            return Err(invalid());
        }
        if decision == "deny" {
            return Ok(Some(map_value([(
                "status",
                Value::String("denied".to_owned()),
            )])));
        }
        let lease = issue_lease_digest(&binding, fence.owner_epoch())?;
        self.challenges.get_mut(challenge_id).unwrap().lease_digest = Some(lease.clone());
        Ok(Some(map_value([
            ("status", Value::String("approved".to_owned())),
            ("effectID", Value::String(binding.effect_id.clone())),
            ("capabilityLeaseDigest", Value::String(lease)),
        ])))
    }

    fn execute_write(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "sessionID",
                "locationID",
                "effectID",
                "capabilityLeaseDigest",
                "content",
            ],
            &[],
        )?;
        let content = string_value(fields, "content")?.to_owned();
        if content.len() > 768 * 1024 {
            return Err(invalid());
        }
        let binding = self.consume_lease(
            fields,
            principal,
            fence,
            crate::guard::FILES_WRITE_ID,
            text(fields, "sessionID")?,
        )?;
        let location = self
            .locations
            .get(&binding.location_id)
            .ok_or((
                "location_not_registered",
                ErrorCategoryV1::Authorization,
                "trusted Location is not registered",
            ))?
            .clone();
        let inner = map_value([
            ("sessionId", Value::String(binding.session_id.clone())),
            ("challengeId", Value::String(binding.challenge_id.clone())),
            ("content", Value::String(content)),
        ]);
        let response = self.effect_request(
            request,
            principal,
            fence,
            &location,
            &binding.session_id,
            inner,
        )?;
        let Some(Value::Map(mut body)) = response.body else {
            return Err((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "write did not settle",
            ));
        };
        let effect_id = body.remove("effectId").ok_or_else(invalid)?;
        body.insert("effectID".to_owned(), effect_id);
        Ok(Some(Value::Map(body)))
    }

    fn execute_patch(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "sessionID",
                "locationID",
                "effectID",
                "capabilityLeaseDigest",
                "operations",
            ],
            &[],
        )?;
        let Some(operations @ Value::Array(_)) = fields.get("operations") else {
            return Err(invalid());
        };
        validate_patch_operations(operations)?;
        let binding = self.consume_lease(
            fields,
            principal,
            fence,
            crate::guard::FILES_PATCH_ID,
            text(fields, "sessionID")?,
        )?;
        let location = self
            .locations
            .get(&binding.location_id)
            .ok_or((
                "location_not_registered",
                ErrorCategoryV1::Authorization,
                "trusted Location is not registered",
            ))?
            .clone();
        let inner = map_value([
            ("sessionId", Value::String(binding.session_id.clone())),
            ("challengeId", Value::String(binding.challenge_id.clone())),
            ("operations", operations.clone()),
        ]);
        let response = self.effect_request(
            request,
            principal,
            fence,
            &location,
            &binding.session_id,
            inner,
        )?;
        let Some(Value::Map(mut body)) = response.body else {
            return Err((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "patch did not settle",
            ));
        };
        let effect_id = body.remove("effectId").ok_or_else(invalid)?;
        body.insert("effectID".to_owned(), effect_id);
        Ok(Some(Value::Map(body)))
    }

    /// `terminal.v1` run: validate the Canonical arguments against the registered
    /// Location and shell-profile registry, consume the one-use capability lease, admit
    /// the durable terminal effect, execute exactly one registered profile command, and
    /// settle the observed outcome. An unobserved exit is left durably UNKNOWN.
    fn run_terminal(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "locationID",
                "effectID",
                "capabilityLeaseDigest",
                "shellProfileID",
                "command",
                "cwd",
                "timeoutMs",
                "resolvedEnvironment",
            ],
            &["sessionID"],
        )?;
        let location = self.location(fields)?.clone();
        // A user effect may be admitted without a Session; a tool-batch effect never is.
        let session = match fields.get("sessionID") {
            None => "",
            Some(Value::String(value)) if !value.contains('\0') => value.as_str(),
            _ => return Err(invalid()),
        };
        let arguments = select_fields(
            fields,
            &[
                "shellProfileID",
                "command",
                "cwd",
                "timeoutMs",
                "resolvedEnvironment",
            ],
        )?;
        let config = validate_terminal_arguments(&arguments, &location, &self.shell_profiles)?;
        let binding = self.consume_lease(
            fields,
            principal,
            fence,
            crate::guard::TERMINAL_RUN_ID,
            session,
        )?;
        let mut effect_host =
            EffectHost::open_live(&location.effect_state_dir, Some(&location.canonical_root))
                .map_err(|_| {
                    (
                        "effect_unavailable",
                        ErrorCategoryV1::Unavailable,
                        "Location effect recovery failed",
                    )
                })?;
        effect_host
            .prepare_terminal_run(
                &binding.session_id,
                principal,
                &binding.challenge_id,
                &config.canonical_arguments,
            )
            .map_err(|error| terminal_failure(&error))?;
        let spec = TerminalLaunchSpec {
            executable: config.profile.executable.clone(),
            argv: config
                .profile
                .command_argv(Some(&config.command), None)
                .into_iter()
                .map(OsString::from)
                .collect(),
            cwd: config.cwd.clone(),
            env: config.environment.clone(),
            cols: TERMINAL_COLUMNS,
            rows: TERMINAL_ROWS,
        };
        let mut process = match TerminalProcess::spawn(spec) {
            Ok(process) => process,
            // The effect is admitted but nothing was executed; only a durable UNKNOWN
            // keeps Core from treating an unstarted command as settled.
            Err(_) => {
                effect_host
                    .mark_terminal_unknown(&binding.effect_id)
                    .map_err(|error| terminal_failure(&error))?;
                return Err((
                    "effect_outcome_unknown",
                    ErrorCategoryV1::Uncertain,
                    "terminal process could not be started; the effect must not be retried",
                ));
            }
        };
        let deadline = Instant::now() + config.timeout;
        let mut output = Vec::new();
        let mut artifact_truncated = false;
        let mut status = "exited";
        let mut code = None;
        let mut observed = false;
        let mut terminated_at = None;
        loop {
            // Drain until the PTY would block so a fast writer never stalls on a full buffer.
            while capture_output(&mut process, &mut output, &mut artifact_truncated) {}
            match process.try_wait() {
                Ok(Some(exit)) => {
                    code = exit_code(exit);
                    observed = true;
                    break;
                }
                Ok(None) => {}
                Err(_) => break,
            }
            let now = Instant::now();
            match terminated_at {
                None if now < deadline => {}
                None => {
                    // A timed-out run has not exited; request process-group termination and
                    // keep observing, because only an observed exit may be settled.
                    if process
                        .request_terminate(TerminationReason::TimedOut)
                        .is_err()
                    {
                        break;
                    }
                    status = "timed_out";
                    terminated_at = Some(now);
                }
                Some(terminated) if now.duration_since(terminated) >= TERMINATION_GRACE => break,
                Some(_) => {}
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        // A PTY holds the tail of the output until its last writer closes, so drain the
        // remaining bounded reads once exit was observed.
        while capture_output(&mut process, &mut output, &mut artifact_truncated) {}
        let (preview, preview_truncated) = terminal_preview(&output);
        if !observed {
            effect_host
                .mark_terminal_unknown(&binding.effect_id)
                .map_err(|error| terminal_failure(&error))?;
            return Err((
                "effect_outcome_unknown",
                ErrorCategoryV1::Uncertain,
                "terminal exit was not observed; the effect must not be retried",
            ));
        }
        let body = effect_host
            .settle_terminal_run(
                &binding.effect_id,
                status,
                code,
                &output,
                &preview,
                artifact_truncated,
            )
            .map_err(|error| terminal_failure(&error))?;
        let Value::Map(mut settled) = body else {
            return Err(invalid());
        };
        // The durable `truncated` column flags artifact truncation; preview truncation is
        // a property of this bounded response and is reported separately.
        settled.remove("truncated");
        settled.insert(
            "artifactTruncated".to_owned(),
            Value::Bool(artifact_truncated),
        );
        settled.insert(
            "previewTruncated".to_owned(),
            Value::Bool(preview_truncated),
        );
        Ok(Some(Value::Map(settled)))
    }

    fn start_terminal(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "effectID",
                "capabilityLeaseDigest",
                "locationID",
                "terminalID",
                "shellProfileID",
                "command",
                "args",
                "cwd",
                "cols",
                "rows",
                "env",
            ],
            &["sessionID"],
        )?;
        let location = self.location(fields)?.clone();
        let session = match fields.get("sessionID") {
            None => "",
            Some(Value::String(value)) if !value.contains('\0') => value.as_str(),
            _ => return Err(invalid()),
        };
        let terminal_id = text(fields, "terminalID")?.to_owned();
        if self.terminals.contains_key(&terminal_id)
            || self.lost_terminals.contains_key(&terminal_id)
        {
            return Err((
                "effect_conflict",
                ErrorCategoryV1::Conflict,
                "terminal identifier is already active or lost",
            ));
        }
        let arguments = select_fields(
            fields,
            &[
                "terminalID",
                "shellProfileID",
                "command",
                "args",
                "cwd",
                "cols",
                "rows",
                "env",
            ],
        )?;
        let config =
            validate_terminal_start_arguments(&arguments, &location, &self.shell_profiles)?;
        // Fail closed before lease consumption, effect preparation, persistence, or spawn.
        if !TerminalProcess::owner_loss_tree_cleanup_supported() {
            return Err((
                "UNAVAILABLE",
                ErrorCategoryV1::Unavailable,
                "interactive terminal unavailable: Linux PTY cannot guarantee process-tree cleanup after hz-kernel owner loss",
            ));
        }
        let binding = self.consume_lease(
            fields,
            principal,
            fence,
            crate::guard::TERMINAL_START_ID,
            session,
        )?;
        let mut effect_host =
            EffectHost::open_live(&location.effect_state_dir, Some(&location.canonical_root))
                .map_err(|_| {
                    (
                        "effect_unavailable",
                        ErrorCategoryV1::Unavailable,
                        "Location effect recovery failed",
                    )
                })?;
        effect_host
            .prepare_terminal_start(
                &binding.session_id,
                principal,
                &binding.challenge_id,
                &config.canonical_arguments,
            )
            .map_err(|error| terminal_failure(&error))?;
        persist_terminal_session(&self.location_registry, &terminal_id, principal, 1)?;
        self.lost_terminals
            .insert(terminal_id.clone(), (principal.to_owned(), 1));
        let spec = TerminalLaunchSpec {
            executable: config.profile.executable.clone(),
            argv: config.argv.clone(),
            cwd: config.cwd.clone(),
            env: config.environment.clone(),
            cols: config.cols,
            rows: config.rows,
        };
        let process = match TerminalProcess::spawn(spec) {
            Ok(process) => process,
            Err(_) => {
                effect_host
                    .mark_terminal_unknown(&binding.effect_id)
                    .map_err(|error| terminal_failure(&error))?;
                return Err((
                    "UNKNOWN",
                    ErrorCategoryV1::Uncertain,
                    "interactive terminal launch outcome is unknown; recreation is required",
                ));
            }
        };
        let now = unix_ms();
        let expiry = now.saturating_add(crate::terminal::MAX_INTERACTIVE_GRANT_MS);
        let grant_id = random_terminal_id("grant")?;
        let encoded = crate::messagepack::encode(
            &config.canonical_arguments,
            crate::messagepack::FRAME_LIMITS,
        )
        .map_err(|_| invalid())?;
        let config_digest = format!("blake3:{}", blake3::hash(&encoded).to_hex());
        let grant = crate::terminal::InteractiveGrantV1 {
            grant_id: grant_id.clone(),
            principal: principal.to_owned(),
            host_id: format!("hz-kernel:{}", fence.owner_epoch()),
            location_id: binding.location_id.clone(),
            terminal_id: terminal_id.clone(),
            launch_digest: binding.effect_id.clone(),
            config_digest,
            backend: match process.backend() {
                crate::terminal_process::TerminalBackend::LinuxPty => "linux_pty",
                crate::terminal_process::TerminalBackend::WindowsConPty => "windows_conpty",
                crate::terminal_process::TerminalBackend::Unavailable => "unavailable",
            }
            .to_owned(),
            owner_epoch: fence.owner_epoch(),
            fence_generation: fence.owner_epoch(),
            issued_at_ms: now,
            expires_at_ms: expiry,
        };
        let pid = process.pid();
        let backend = grant.backend.clone();
        let mut state = crate::terminal::TerminalState::new(terminal_id.clone(), 1, grant);
        state
            .replay
            .append("state", b"running")
            .map_err(terminal_host_error)?;
        state
            .admit_attachment(format!("owner_{}", binding.effect_id))
            .map_err(|_| invalid())?;
        self.terminals.insert(
            terminal_id.clone(),
            ActiveTerminal {
                process,
                effect_host,
                state,
                effect_id: binding.effect_id.clone(),
                challenge_id: binding.challenge_id,
                location_id: binding.location_id,
                session_id: binding.session_id,
                principal: principal.to_owned(),
                attachments_by_ticket: HashMap::new(),
                cancellation_deadline_ms: None,
            },
        );
        self.lost_terminals.remove(&terminal_id);
        Ok(Some(map_value([
            ("status", Value::String("running".to_owned())),
            ("terminalID", Value::String(terminal_id)),
            ("generation", Value::Unsigned(1)),
            ("grantID", Value::String(grant_id.clone())),
            ("leaseRef", Value::String(grant_id)),
            ("expiresAt", Value::Unsigned(expiry)),
            ("backend", Value::String(backend)),
            ("cols", Value::Unsigned(config.cols as u64)),
            ("rows", Value::Unsigned(config.rows as u64)),
            ("byteCursor", Value::Unsigned(0)),
            ("pid", Value::Unsigned(pid as u64)),
        ])))
    }

    fn input_terminal(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "terminalID",
                "generation",
                "grantID",
                "attachmentID",
                "sequence",
                "bytes",
            ],
            &[],
        )?;
        let terminal_id = text(fields, "terminalID")?;
        let generation = get_unsigned(fields, "generation")?;
        let grant_id = text(fields, "grantID")?;
        let attachment = text(fields, "attachmentID")?;
        let sequence = get_unsigned(fields, "sequence")?;
        let Value::Binary(bytes) = fields.get("bytes").ok_or_else(invalid)? else {
            return Err(invalid());
        };
        if bytes.len() > crate::terminal::MAX_INPUT_FRAME {
            return Err(terminal_host_error(
                crate::terminal::TerminalError::TooLarge,
            ));
        }
        let terminal = self.terminals.get_mut(terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        if terminal.principal != principal {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        terminal
            .effect_host
            .authorize_terminal_continuation(
                &terminal.session_id,
                principal,
                &terminal.challenge_id,
                &terminal.effect_id,
            )
            .map_err(|error| terminal_failure(&error))?;
        if attachment.starts_with("owner_") {
            let _ = terminal.state.admit_attachment(attachment.to_owned());
        }
        let dispatch = terminal
            .state
            .accept_input(
                attachment,
                generation,
                grant_id,
                sequence,
                bytes,
                unix_ms(),
                fence.owner_epoch(),
                fence.owner_epoch(),
            )
            .map_err(terminal_host_error)?;
        if dispatch && terminal.process.write_input(bytes).is_err() {
            mark_interactive_unknown(terminal);
            return Err(terminal_host_error(crate::terminal::TerminalError::Unknown));
        }
        Ok(Some(map_value([
            ("terminalID", Value::String(terminal_id.to_owned())),
            ("generation", Value::Unsigned(generation)),
            ("attachmentID", Value::String(attachment.to_owned())),
            ("acknowledgedSequence", Value::Unsigned(sequence)),
            ("state", Value::String("running".to_owned())),
        ])))
    }

    fn resize_terminal(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &[
                "terminalID",
                "generation",
                "grantID",
                "attachmentID",
                "sequence",
                "cols",
                "rows",
            ],
            &[],
        )?;
        let terminal_id = text(fields, "terminalID")?;
        let generation = get_unsigned(fields, "generation")?;
        let grant_id = text(fields, "grantID")?;
        let attachment = text(fields, "attachmentID")?;
        let sequence = get_unsigned(fields, "sequence")?;
        let cols: u16 = get_unsigned(fields, "cols")?
            .try_into()
            .map_err(|_| terminal_host_error(crate::terminal::TerminalError::BadFrame))?;
        let rows: u16 = get_unsigned(fields, "rows")?
            .try_into()
            .map_err(|_| terminal_host_error(crate::terminal::TerminalError::BadFrame))?;
        let terminal = self.terminals.get_mut(terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        if terminal.principal != principal {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        terminal
            .effect_host
            .authorize_terminal_continuation(
                &terminal.session_id,
                principal,
                &terminal.challenge_id,
                &terminal.effect_id,
            )
            .map_err(|error| terminal_failure(&error))?;
        if attachment.starts_with("owner_") {
            let _ = terminal.state.admit_attachment(attachment.to_owned());
        }
        let dispatch = terminal
            .state
            .accept_resize(
                attachment,
                generation,
                grant_id,
                sequence,
                cols,
                rows,
                unix_ms(),
                fence.owner_epoch(),
                fence.owner_epoch(),
            )
            .map_err(terminal_host_error)?;
        if dispatch && terminal.process.resize(cols, rows).is_err() {
            mark_interactive_unknown(terminal);
            return Err(terminal_host_error(crate::terminal::TerminalError::Unknown));
        }
        Ok(Some(map_value([
            ("terminalID", Value::String(terminal_id.to_owned())),
            ("generation", Value::Unsigned(generation)),
            ("attachmentID", Value::String(attachment.to_owned())),
            ("acknowledgedSequence", Value::Unsigned(sequence)),
            ("state", Value::String("running".to_owned())),
        ])))
    }

    fn cancel_terminal(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &["effectID", "terminalID", "generation", "reason"],
            &[],
        )?;
        let terminal_id = text(fields, "terminalID")?;
        let effect_id = text(fields, "effectID")?;
        let generation = get_unsigned(fields, "generation")?;
        let terminal = self.terminals.get_mut(terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        if terminal.principal != principal || terminal.effect_id != effect_id {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if terminal.state.generation != generation {
            return Err(terminal_host_error(
                crate::terminal::TerminalError::StaleGeneration,
            ));
        }
        terminal.state.grant.fence_generation = fence.owner_epoch().saturating_add(1);
        if terminal
            .process
            .request_terminate(TerminationReason::Cancelled)
            .is_err()
        {
            mark_interactive_unknown(terminal);
            return Err(terminal_host_error(crate::terminal::TerminalError::Unknown));
        }
        terminal.cancellation_deadline_ms =
            Some(unix_ms().saturating_add(TERMINATION_GRACE.as_millis() as u64));
        let mut receipt_ref = terminal.effect_id.clone();
        match terminal.process.try_wait() {
            Ok(Some(exit)) => {
                if let Some(code) = exit_code(exit) {
                    terminal.state.status = crate::terminal::TerminalStatus::Cancelled;
                    terminal
                        .state
                        .replay
                        .append("state", b"cancelled")
                        .map_err(terminal_host_error)?;
                    terminal
                        .state
                        .replay
                        .append("exit", code.to_string().as_bytes())
                        .map_err(terminal_host_error)?;
                    let settled = terminal
                        .effect_host
                        .settle_terminal_start(&terminal.effect_id, "cancelled", Some(code))
                        .map_err(|error| terminal_failure(&error))?;
                    if let Some(Value::String(receipt)) = match settled {
                        Value::Map(mut fields) => fields.remove("receiptRef"),
                        _ => None,
                    } {
                        receipt_ref = receipt;
                    }
                } else {
                    mark_interactive_unknown(terminal);
                }
            }
            Ok(None) => {}
            Err(_) => {
                mark_interactive_unknown(terminal);
                return Err(terminal_host_error(crate::terminal::TerminalError::Unknown));
            }
        }
        let state = match terminal.state.status {
            crate::terminal::TerminalStatus::Cancelled => "cancelled",
            crate::terminal::TerminalStatus::Unknown => "unknown",
            _ => "cancelling",
        };
        Ok(Some(map_value([
            ("terminalID", Value::String(terminal_id.to_owned())),
            ("generation", Value::Unsigned(generation)),
            ("state", Value::String(state.to_owned())),
            ("receiptRef", Value::String(receipt_ref)),
        ])))
    }

    fn status_terminal(
        &mut self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(
            &request.body,
            &["terminalID", "generation"],
            &["afterSequence", "afterByteCursor", "maxBytes"],
        )?;
        let terminal_id = text(fields, "terminalID")?;
        let generation = get_unsigned(fields, "generation")?;
        if !self.terminals.contains_key(terminal_id) {
            if let Some((lost_principal, lost_generation)) = self.lost_terminals.get(terminal_id) {
                if lost_principal != principal {
                    return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
                }
                if *lost_generation != generation {
                    return Err(terminal_host_error(
                        crate::terminal::TerminalError::StaleGeneration,
                    ));
                }
                return Ok(Some(map_value([
                    ("terminalID", Value::String(terminal_id.to_owned())),
                    ("generation", Value::Unsigned(generation)),
                    ("status", Value::String("unknown".to_owned())),
                    ("byteCursor", Value::Unsigned(0)),
                    ("nextSequence", Value::Unsigned(1)),
                    ("ownerEpoch", Value::Unsigned(fence.owner_epoch())),
                    ("replay", Value::Array(Vec::new())),
                    ("sessionLost", Value::Bool(true)),
                ])));
            }
        }
        let after_sequence = match fields.get("afterSequence") {
            None => 0,
            Some(Value::Unsigned(value)) => *value,
            _ => return Err(invalid()),
        };
        let after_byte_cursor = match fields.get("afterByteCursor") {
            None => 0,
            Some(Value::Unsigned(value)) => *value,
            _ => return Err(invalid()),
        };
        let max_bytes = match fields.get("maxBytes") {
            None => 64 * 1024,
            Some(Value::Unsigned(value)) if *value <= 64 * 1024 => *value as usize,
            _ => {
                return Err(terminal_host_error(
                    crate::terminal::TerminalError::TooLarge,
                ));
            }
        };
        let terminal = self.terminals.get_mut(terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        if terminal.principal != principal {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if terminal.state.generation != generation {
            return Err(terminal_host_error(
                crate::terminal::TerminalError::StaleGeneration,
            ));
        }
        if let Err(error) = drain_interactive(terminal) {
            mark_interactive_unknown(terminal);
            return Err(error);
        }
        if matches!(
            terminal.state.status,
            crate::terminal::TerminalStatus::Running
        ) {
            match terminal.process.try_wait() {
                Ok(Some(exit)) => observe_interactive_exit(terminal, exit),
                Ok(None)
                    if terminal
                        .cancellation_deadline_ms
                        .is_some_and(|deadline| unix_ms() >= deadline) =>
                {
                    mark_interactive_unknown(terminal);
                }
                Ok(None) => {}
                Err(_) => mark_interactive_unknown(terminal),
            }
        }
        let (gap, chunks) = terminal
            .state
            .replay
            .replay_after_limited(generation, after_sequence, after_byte_cursor, max_bytes)
            .map_err(terminal_host_error)?;
        let status = match terminal.state.status {
            crate::terminal::TerminalStatus::Running => "running",
            crate::terminal::TerminalStatus::Exited(_) => "exited",
            crate::terminal::TerminalStatus::TimedOut => "timed_out",
            crate::terminal::TerminalStatus::Cancelled => "cancelled",
            crate::terminal::TerminalStatus::Unknown => "unknown",
        };
        let replay = chunks
            .into_iter()
            .map(|chunk| {
                map_value([
                    ("sequence", Value::Unsigned(chunk.sequence)),
                    ("byteCursor", Value::Unsigned(chunk.byte_cursor)),
                    ("kind", Value::String(chunk.kind)),
                    ("payload", Value::Binary(chunk.payload)),
                ])
            })
            .collect();
        let mut response = BTreeMap::from([
            (
                "terminalID".to_owned(),
                Value::String(terminal_id.to_owned()),
            ),
            ("generation".to_owned(), Value::Unsigned(generation)),
            ("status".to_owned(), Value::String(status.to_owned())),
            (
                "byteCursor".to_owned(),
                Value::Unsigned(terminal.state.replay.byte_cursor()),
            ),
            (
                "nextSequence".to_owned(),
                Value::Unsigned(terminal.state.replay.next_sequence()),
            ),
            (
                "ownerEpoch".to_owned(),
                Value::Unsigned(fence.owner_epoch()),
            ),
            ("replay".to_owned(), Value::Array(replay)),
        ]);
        if let Some(gap) = gap {
            response.insert(
                "gap".to_owned(),
                map_value([
                    ("firstSequence", Value::Unsigned(gap.first_sequence)),
                    (
                        "lastSequenceExclusive",
                        Value::Unsigned(gap.last_sequence_exclusive),
                    ),
                    ("firstByteCursor", Value::Unsigned(gap.first_byte_cursor)),
                    (
                        "lastByteCursorExclusive",
                        Value::Unsigned(gap.last_byte_cursor_exclusive),
                    ),
                ]),
            );
        }
        if let crate::terminal::TerminalStatus::Exited(code) = terminal.state.status {
            response.insert("exitCode".to_owned(), Value::Unsigned(code as u64));
        }
        Ok(Some(Value::Map(response)))
    }

    fn acquire_terminal_ticket(
        &mut self,
        body: &Value,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Value, HostError> {
        let fields = strict_fields(
            body,
            &[
                "terminalID",
                "locationID",
                "origin",
                "protocol",
                "principal",
            ],
            &["sessionID"],
        )?;
        let terminal_id = text(fields, "terminalID")?.to_owned();
        let location_id = text(fields, "locationID")?.to_owned();
        let origin = text(fields, "origin")?.to_owned();
        if !valid_terminal_origin(&origin) || text(fields, "protocol")? != "horizon.terminal.v1" {
            return Err(terminal_host_error(
                crate::terminal::TerminalError::BadFrame,
            ));
        }
        let session_id = match fields.get("sessionID") {
            None => String::new(),
            Some(Value::String(value)) if !value.contains('\0') => value.clone(),
            _ => return Err(invalid()),
        };
        validate_transport_principal(fields.get("principal").ok_or_else(invalid)?, principal)?;
        let terminal = self.terminals.get(&terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        if terminal.principal != principal
            || terminal.location_id != location_id
            || terminal.session_id != session_id
        {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if self.tickets.len() >= 1024 {
            return Err((
                "UNAVAILABLE",
                ErrorCategoryV1::Unavailable,
                "host ticket capacity is exhausted",
            ));
        }
        let expires_at_ms = unix_ms().saturating_add(30_000);
        let (ticket_id, ticket) = random_terminal_ticket()?;
        self.tickets.insert(
            ticket_id.clone(),
            ActiveTicket {
                binding: TicketBinding {
                    ticket_id: ticket_id.clone(),
                    ticket: ticket.clone(),
                    terminal_id,
                    location_id,
                    session_id,
                    principal: principal.to_owned(),
                    origin,
                    expires_at_ms,
                },
            },
        );
        Ok(map_value([
            ("ticketID", Value::String(ticket_id)),
            ("ticket", Value::String(ticket)),
            ("ownerEpoch", Value::Unsigned(fence.owner_epoch())),
            ("expiresAtUnixMs", Value::Unsigned(expires_at_ms)),
        ]))
    }

    fn consume_terminal_ticket(
        &mut self,
        body: &Value,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Value, HostError> {
        let fields = strict_fields(
            body,
            &[
                "ticket",
                "terminalID",
                "locationID",
                "origin",
                "protocol",
                "principal",
            ],
            &["sessionID", "ticketID"],
        )?;
        let ticket = text(fields, "ticket")?;
        let terminal_id = text(fields, "terminalID")?;
        let location_id = text(fields, "locationID")?;
        let origin = text(fields, "origin")?;
        if !valid_terminal_origin(origin) || text(fields, "protocol")? != "horizon.terminal.v1" {
            return Err(terminal_host_error(
                crate::terminal::TerminalError::BadFrame,
            ));
        }
        let session_id = match fields.get("sessionID") {
            None => "",
            Some(Value::String(value)) if !value.contains('\0') => value.as_str(),
            _ => return Err(invalid()),
        };
        validate_transport_principal(fields.get("principal").ok_or_else(invalid)?, principal)?;
        let ticket_id = self
            .tickets
            .iter()
            .find_map(|(id, ticket_binding)| {
                (ticket_binding.binding.ticket == ticket).then_some(id.clone())
            })
            .ok_or_else(|| terminal_host_error(crate::terminal::TerminalError::Denied))?;
        let binding = &self.tickets.get(&ticket_id).ok_or_else(invalid)?.binding;
        if fields
            .get("ticketID")
            .is_some_and(|value| value != &Value::String(ticket_id.clone()))
        {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if binding.terminal_id != terminal_id
            || binding.location_id != location_id
            || binding.session_id != session_id
            || binding.principal != principal
            || binding.origin != origin
        {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if unix_ms() >= binding.expires_at_ms {
            self.tickets.remove(&ticket_id);
            return Err(terminal_host_error(
                crate::terminal::TerminalError::GrantExpired,
            ));
        }
        let terminal = self.terminals.get_mut(terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        let attachment_id = random_terminal_id("att")?;
        terminal
            .state
            .admit_attachment(attachment_id.clone())
            .map_err(terminal_host_error)?;
        let generation = terminal.state.generation;
        terminal
            .attachments_by_ticket
            .insert(ticket_id.clone(), attachment_id.clone());
        self.tickets.remove(&ticket_id);
        Ok(map_value([
            ("ticketID", Value::String(ticket_id)),
            ("attachmentID", Value::String(attachment_id)),
            ("terminalID", Value::String(terminal_id.to_owned())),
            ("generation", Value::Unsigned(generation)),
            ("ownerEpoch", Value::Unsigned(fence.owner_epoch())),
        ]))
    }
    fn revoke_terminal_ticket(
        &mut self,
        body: &Value,
        principal: &str,
    ) -> Result<Value, HostError> {
        let fields = strict_fields(body, &["ticketID", "terminalID"], &["attachmentID"])?;
        let ticket_id = text(fields, "ticketID")?;
        let terminal_id = text(fields, "terminalID")?;
        let terminal = self.terminals.get_mut(terminal_id).ok_or((
            "effect_not_found",
            ErrorCategoryV1::NotFound,
            "terminal session is unavailable",
        ))?;
        if terminal.principal != principal {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if let Some(ticket) = self.tickets.get(ticket_id)
            && ticket.binding.terminal_id != terminal_id
        {
            return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
        }
        if let Some(attachment_id) = fields.get("attachmentID") {
            let attachment_id = value_text(attachment_id)?;
            if terminal
                .attachments_by_ticket
                .get(ticket_id)
                .is_some_and(|attached| attached == attachment_id)
            {
                terminal.state.revoke_attachment(attachment_id);
                terminal.attachments_by_ticket.remove(ticket_id);
                self.revoked_tickets.insert(
                    ticket_id.to_owned(),
                    (terminal_id.to_owned(), principal.to_owned()),
                );
            } else if self.revoked_tickets.get(ticket_id)
                != Some(&(terminal_id.to_owned(), principal.to_owned()))
            {
                return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
            }
        } else {
            let removed = self.tickets.remove(ticket_id).is_some();
            if !removed
                && !terminal.attachments_by_ticket.contains_key(ticket_id)
                && self.revoked_tickets.get(ticket_id)
                    != Some(&(terminal_id.to_owned(), principal.to_owned()))
            {
                return Err(terminal_host_error(crate::terminal::TerminalError::Denied));
            }
            if let Some(attachment_id) = terminal.attachments_by_ticket.remove(ticket_id) {
                terminal.state.revoke_attachment(&attachment_id);
            }
            self.revoked_tickets.insert(
                ticket_id.to_owned(),
                (terminal_id.to_owned(), principal.to_owned()),
            );
        }
        Ok(map_value([("revoked", Value::Bool(true))]))
    }

    fn reconcile_effect(
        &self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
    ) -> Result<Option<Value>, HostError> {
        let fields = strict_fields(&request.body, &["effectID", "locationID", "sessionID"], &[])?;
        let location = self.location(fields)?;
        let effect_id = text(fields, "effectID")?;
        let session_id = text(fields, "sessionID")?;
        let effect_host =
            EffectHost::open_live(&location.effect_state_dir, Some(&location.canonical_root))
                .map_err(|_| {
                    (
                        "effect_unavailable",
                        ErrorCategoryV1::Unavailable,
                        "Location effect recovery failed",
                    )
                })?;
        let body = effect_host
            .reconcile_effect(session_id, principal, effect_id)
            .map_err(|error| match error.code.as_str() {
                "approval_not_found" => (
                    "effect_not_found",
                    ErrorCategoryV1::NotFound,
                    "effect receipt was not found",
                ),
                "effect_denied" => (
                    "effect_denied",
                    ErrorCategoryV1::Authorization,
                    "effect receipt is outside the authenticated principal or Session",
                ),
                "effect_outcome_unknown" => (
                    "effect_outcome_unknown",
                    ErrorCategoryV1::Uncertain,
                    "effect remains UNKNOWN; it must not be retried",
                ),
                _ => (
                    "effect_unavailable",
                    error.category,
                    "effect receipt is unavailable",
                ),
            })?;
        if request.owner_epoch != fence.owner_epoch() {
            return Err((
                "stale_fence",
                ErrorCategoryV1::Authorization,
                "receipt request owner epoch is stale",
            ));
        }
        Ok(Some(body))
    }

    fn consume_lease(
        &mut self,
        fields: &BTreeMap<String, Value>,
        principal: &str,
        fence: &FrameFence,
        capability: &str,
        session: &str,
    ) -> Result<CapabilityBinding, HostError> {
        let location = text(fields, "locationID")?;
        let effect_id = text(fields, "effectID")?;
        let digest = text(fields, "capabilityLeaseDigest")?;
        if digest.len() != 71
            || !digest.starts_with("blake3:")
            || !digest[7..]
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(invalid());
        }
        let challenge_id = self
            .effects
            .get(effect_id)
            .ok_or((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "capability lease is missing or consumed",
            ))?
            .clone();
        let binding = self
            .challenges
            .get(&challenge_id)
            .ok_or((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "capability lease is missing or consumed",
            ))?
            .clone();
        if binding.session_id != session
            || binding.location_id != location
            || binding.effect_id != effect_id
            || binding.capability_id != capability
            || binding.principal != principal
            || binding.owner_epoch != fence.owner_epoch()
            || binding.lease_digest.as_deref() != Some(digest)
        {
            return Err((
                "effect_denied",
                ErrorCategoryV1::Authorization,
                "capability lease binding mismatch",
            ));
        }
        self.challenges.remove(&challenge_id).ok_or_else(invalid)?;
        self.effects.remove(effect_id);
        Ok(binding)
    }

    fn effect_request(
        &self,
        request: &RpcRequestV1,
        principal: &str,
        fence: &FrameFence,
        location: &RegisteredLocation,
        session_id: &str,
        body: Value,
    ) -> Result<RpcResponseV1, HostError> {
        let mut effect_host =
            EffectHost::open_live(&location.effect_state_dir, Some(&location.canonical_root))
                .map_err(|_| {
                    (
                        "effect_unavailable",
                        ErrorCategoryV1::Unavailable,
                        "EffectHost could not open the registered Location",
                    )
                })?;
        let mut inner = request.clone();
        inner.service_id = EFFECTS_SERVICE_ID.to_owned();
        inner.body = body;
        let response = effect_host.handle_request(session_id, principal, &inner, true, fence);
        if response.outcome == RpcOutcomeV1::Error {
            let error = response.error.as_ref().ok_or_else(invalid)?;
            let (code, message) = match error.code.as_str() {
                "invalid_effect_request" => {
                    ("invalid_effect_request", "effect request is malformed")
                }
                "effect_outcome_unknown" => (
                    "effect_outcome_unknown",
                    "effect outcome is unknown and must not be retried",
                ),
                "effect_conflict" => (
                    "effect_conflict",
                    "effect challenge is expired, consumed, or no longer applicable",
                ),
                "approval_not_found" => ("approval_not_found", "approval challenge was not found"),
                "effect_denied" => ("effect_denied", "EffectHost denied the requested effect"),
                _ => ("effect_unavailable", "EffectHost operation is unavailable"),
            };
            return Err((code, error.category, message));
        }
        Ok(response)
    }

    fn location<'a>(
        &'a self,
        fields: &BTreeMap<String, Value>,
    ) -> Result<&'a RegisteredLocation, HostError> {
        let id = text(fields, "locationID")?;
        self.locations.get(id).ok_or((
            "location_not_registered",
            ErrorCategoryV1::Authorization,
            "trusted Location is not registered",
        ))
    }
}
fn mark_interactive_unknown(terminal: &mut ActiveTerminal) {
    if !matches!(
        terminal.state.status,
        crate::terminal::TerminalStatus::Unknown
    ) {
        terminal
            .state
            .mark_owner_lost(terminal.state.grant.fence_generation.saturating_add(1));
        let _ = terminal.state.replay.append("state", b"unknown");
    }
    let _ = terminal
        .effect_host
        .mark_terminal_unknown(&terminal.effect_id);
}
fn observe_interactive_exit(terminal: &mut ActiveTerminal, exit: std::process::ExitStatus) {
    let Some(code) = exit_code(exit) else {
        mark_interactive_unknown(terminal);
        return;
    };
    let cancelled = terminal.cancellation_deadline_ms.is_some();
    terminal.state.status = if cancelled {
        crate::terminal::TerminalStatus::Cancelled
    } else {
        crate::terminal::TerminalStatus::Exited(code)
    };
    if terminal
        .state
        .replay
        .append("state", if cancelled { b"cancelled" } else { b"exited" })
        .is_err()
        || terminal
            .state
            .replay
            .append("exit", code.to_string().as_bytes())
            .is_err()
        || terminal
            .effect_host
            .settle_terminal_start(
                &terminal.effect_id,
                if cancelled { "cancelled" } else { "exited" },
                Some(code),
            )
            .is_err()
    {
        mark_interactive_unknown(terminal);
    }
}

fn unix_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis().try_into().unwrap_or(u64::MAX))
        .unwrap_or(u64::MAX)
}

fn random_terminal_id(prefix: &str) -> Result<String, HostError> {
    let mut entropy = [0u8; 24];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut entropy))
        .map_err(|_| {
            (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "terminal entropy is unavailable",
            )
        })?;
    Ok(format!("{prefix}_{}", blake3::hash(&entropy).to_hex()))
}

fn random_terminal_ticket() -> Result<(String, String), HostError> {
    let mut entropy = [0u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut entropy))
        .map_err(|_| {
            (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "terminal ticket entropy is unavailable",
            )
        })?;
    let hex = blake3::hash(&entropy).to_hex().to_string();
    Ok((format!("ticket_{}", &hex[..32]), hex))
}

fn validate_transport_principal(
    value: &Value,
    authenticated_principal: &str,
) -> Result<(), HostError> {
    let fields = strict_fields(value, &["source"], &["username"])?;
    match text(fields, "source")? {
        "host_os"
            if !fields.contains_key("username")
                && authenticated_principal.starts_with("host_os_uid:") =>
        {
            Ok(())
        }
        "server_auth"
            if fields.contains_key("username")
                && text(fields, "username")?.len() <= 256
                && authenticated_principal
                    == format!("server_auth:{}", text(fields, "username")?) =>
        {
            Ok(())
        }
        _ => Err(terminal_host_error(crate::terminal::TerminalError::Denied)),
    }
}
fn valid_terminal_origin(origin: &str) -> bool {
    matches!(
        origin,
        "oc://renderer"
            | "tauri://localhost"
            | "http://tauri.localhost"
            | "https://tauri.localhost"
    )
}
fn terminal_rpc_event(
    fence: &FrameFence,
    subscription_id: &str,
    terminal_id: &str,
    chunk: &crate::terminal::ReplayChunk,
) -> Option<RpcEventV1> {
    Some(RpcEventV1 {
        owner_epoch: fence.owner_epoch(),
        process_incarnation: fence.process_incarnation().to_owned(),
        subscription_id: subscription_id.to_owned(),
        cursor: chunk.cursor(terminal_id).ok()?,
        event_type: format!("terminal.{}", chunk.kind),
        payload: map_value([
            ("terminalID", Value::String(terminal_id.to_owned())),
            ("generation", Value::Unsigned(chunk.generation)),
            ("sequence", Value::Unsigned(chunk.sequence)),
            ("byteCursor", Value::Unsigned(chunk.byte_cursor)),
            ("kind", Value::String(chunk.kind.clone())),
            ("payload", chunk.event_payload().ok()?),
        ]),
    })
}
fn terminal_latest_cursor(
    replay: &crate::terminal::ReplayRing,
    terminal_id: &str,
) -> Option<CursorV1> {
    let sequence = replay.next_sequence().saturating_sub(1);
    replay
        .cursor_at(terminal_id, sequence)
        .map(|(cursor, _)| cursor)
}
fn can_add_terminal_subscription(total: usize, per_terminal: usize, id_in_use: bool) -> bool {
    !id_in_use
        && total < MAX_TERMINAL_SUBSCRIPTIONS
        && per_terminal < MAX_TERMINAL_SUBSCRIPTIONS_PER_TERMINAL
}

fn resnapshot_message(
    fence: &FrameFence,
    subscription_id: &str,
    requested: &CursorV1,
    latest: &CursorV1,
) -> RpcMessageV1 {
    RpcMessageV1::Control(Box::new(RpcControlV1::ResnapshotRequired {
        owner_epoch: fence.owner_epoch(),
        process_incarnation: fence.process_incarnation().to_owned(),
        subscription_id: subscription_id.to_owned(),
        requested: requested.clone(),
        latest: latest.clone(),
    }))
}
fn terminal_subscription_rejection(
    total: usize,
    per_terminal: usize,
    id_in_use: bool,
    fence: &FrameFence,
    subscription_id: &str,
    requested: &CursorV1,
    latest: &CursorV1,
) -> Option<RpcMessageV1> {
    (!can_add_terminal_subscription(total, per_terminal, id_in_use))
        .then(|| resnapshot_message(fence, subscription_id, requested, latest))
}

fn terminal_host_error(error: crate::terminal::TerminalError) -> HostError {
    (
        error.code(),
        error.typed_error().category,
        "terminal request could not be admitted or completed",
    )
}

fn drain_interactive(terminal: &mut ActiveTerminal) -> Result<(), HostError> {
    loop {
        let output = terminal
            .process
            .read_output(MAX_OUTPUT_BYTES)
            .map_err(|_| terminal_host_error(crate::terminal::TerminalError::Unknown))?;
        if output.is_empty() {
            return Ok(());
        }
        terminal
            .state
            .replay
            .append("output", &output)
            .map_err(terminal_host_error)?;
    }
}

type HostError = (&'static str, ErrorCategoryV1, &'static str);

fn issue_lease_digest(binding: &CapabilityBinding, owner_epoch: u64) -> Result<String, HostError> {
    let mut entropy = [0_u8; 32];
    File::open("/dev/urandom")
        .and_then(|mut random| random.read_exact(&mut entropy))
        .map_err(|_| {
            (
                "effect_unavailable",
                ErrorCategoryV1::Unavailable,
                "capability lease entropy is unavailable",
            )
        })?;
    let owner_epoch_bytes = owner_epoch.to_be_bytes();
    let mut hasher = blake3::Hasher::new();
    for field in [
        binding.challenge_id.as_bytes(),
        binding.effect_id.as_bytes(),
        binding.session_id.as_bytes(),
        binding.location_id.as_bytes(),
        binding.capability_id.as_bytes(),
        binding.principal.as_bytes(),
        owner_epoch_bytes.as_slice(),
        &entropy,
    ] {
        hasher.update(&(field.len() as u64).to_be_bytes());
        hasher.update(field);
    }
    Ok(format!("blake3:{}", hasher.finalize().to_hex()))
}

fn shell_profile_list_value(list: &ShellProfileList) -> Result<Value, HostError> {
    let default_shell_profile_id = list.default_shell_profile_id.clone().ok_or((
        "profile_unavailable",
        ErrorCategoryV1::Unavailable,
        "default shell profile is unavailable",
    ))?;
    Ok(map_value([
        (
            "defaultProfileKey",
            Value::String(list.default_profile_key.clone()),
        ),
        (
            "defaultShellProfileID",
            Value::String(default_shell_profile_id),
        ),
        (
            "profiles",
            Value::Array(
                list.profiles
                    .iter()
                    .map(|profile| {
                        map_value([
                            ("profileKey", Value::String(profile.profile_key.clone())),
                            (
                                "shellProfileID",
                                Value::String(profile.shell_profile_id.clone()),
                            ),
                            ("kind", Value::String(profile.kind.profile_key().to_owned())),
                            (
                                "executable",
                                Value::String(profile.executable.to_string_lossy().into_owned()),
                            ),
                            ("login", Value::Bool(profile.login)),
                            (
                                "distribution",
                                match &profile.distribution {
                                    Some(distribution) => Value::String(distribution.clone()),
                                    None => Value::Nil,
                                },
                            ),
                            ("configDigest", Value::String(profile.config_digest.clone())),
                            (
                                "profileDigest",
                                Value::String(profile.profile_digest.clone()),
                            ),
                            ("generation", Value::Unsigned(profile.generation)),
                            (
                                "availability",
                                Value::String(profile.availability.as_str().to_owned()),
                            ),
                        ])
                    })
                    .collect(),
            ),
        ),
    ]))
}

/// Resolve one Canonical terminal.run argument tuple against the registered Location and
/// the host-owned shell profile registry. Exactly one registered profile command is
/// admitted, and the environment is never inherited from the owner process.
fn validate_terminal_start_arguments(
    arguments: &Value,
    location: &RegisteredLocation,
    profiles: &ShellProfileRegistry,
) -> Result<TerminalStartConfig, HostError> {
    // probe #1
    let fields = strict_fields(
        arguments,
        &[
            "terminalID",
            "shellProfileID",
            "command",
            "args",
            "cwd",
            "cols",
            "rows",
            "env",
        ],
        &[],
    )?;
    // probe #2
    let terminal_id = text(fields, "terminalID")?;
    if terminal_id.len() > 128 {
        return Err(invalid());
    }
    let profile = profiles
        .resolve(text(fields, "shellProfileID")?)
        .map_err(|_| {
            (
                "profile_unavailable",
                ErrorCategoryV1::Unavailable,
                "shell profile is not registered",
            )
        })?
        .clone();
    if profile.kind != ShellProfileKind::PosixBash {
        return Err((
            "profile_unavailable",
            ErrorCategoryV1::Unavailable,
            "only the registered Linux Bash profile is available",
        ));
    }
    if profile.executable.to_string_lossy().as_ref() != text(fields, "command")? {
        return Err(invalid());
    }
    let Value::Array(args) = fields.get("args").ok_or_else(invalid)? else {
        return Err(invalid());
    };
    if args.len() > 256 {
        return Err(invalid());
    }
    let mut argv = Vec::with_capacity(args.len());
    let mut args_bytes = 0usize;
    for arg in args {
        let Value::String(arg) = arg else {
            return Err(invalid());
        };
        if arg.contains('\0') {
            return Err(invalid());
        }
        args_bytes = args_bytes.checked_add(arg.len()).ok_or_else(invalid)?;
        argv.push(OsString::from(arg));
    }
    if args_bytes > 256 * 1024 {
        return Err(invalid());
    }
    // probe #8
    let requested_cwd = text(fields, "cwd")?;
    if requested_cwd.len() > 4096 {
        return Err(invalid());
    }
    // probe #10
    let cwd = fs::canonicalize(requested_cwd).map_err(|_| {
        (
            "effect_denied",
            ErrorCategoryV1::Authorization,
            "terminal working directory is outside the registered Location",
        )
    })?;
    if cwd.to_str() != Some(requested_cwd)
        || !cwd.starts_with(&location.canonical_root)
        || !fs::metadata(&cwd).is_ok_and(|metadata| metadata.is_dir())
    {
        return Err((
            "effect_denied",
            ErrorCategoryV1::Authorization,
            "terminal working directory is outside the registered Location",
        ));
    }
    let cols = match fields.get("cols") {
        Some(Value::Unsigned(value @ 1..=500)) => *value as u16,
        _ => return Err(invalid()),
    };
    let rows = match fields.get("rows") {
        Some(Value::Unsigned(value @ 1..=300)) => *value as u16,
        _ => return Err(invalid()),
    };
    let Value::Map(environment_fields) = fields.get("env").ok_or_else(invalid)? else {
        return Err(invalid());
    };
    if environment_fields.len() > 128 {
        return Err(invalid());
    }
    let mut environment = BTreeMap::new();
    let mut environment_bytes = 0usize;
    for (key, value) in environment_fields {
        let Value::String(value) = value else {
            return Err(invalid());
        };
        if !valid_environment_key(key)
            || value.contains('\0')
            || matches!(
                key.as_str(),
                "BASH_ENV" | "ENV" | "SHELLOPTS" | "BASHOPTS" | "IFS"
            )
            || key.starts_with("LD_")
        {
            return Err(invalid());
        }
        environment_bytes = environment_bytes
            .checked_add(key.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or_else(invalid)?;
        if environment_bytes > 64 * 1024 {
            return Err(invalid());
        }
        environment.insert(OsString::from(key.as_str()), OsString::from(value.as_str()));
    }
    Ok(TerminalStartConfig {
        profile,
        argv,
        cwd,
        environment,
        cols,
        rows,
        canonical_arguments: arguments.clone(),
    })
}

fn validate_terminal_arguments(
    arguments: &Value,
    location: &RegisteredLocation,
    profiles: &ShellProfileRegistry,
) -> Result<TerminalRunConfig, HostError> {
    let fields = strict_fields(
        arguments,
        &[
            "shellProfileID",
            "command",
            "cwd",
            "timeoutMs",
            "resolvedEnvironment",
        ],
        &[],
    )?;
    let profile = profiles
        .resolve(text(fields, "shellProfileID")?)
        .map_err(|_| {
            (
                "profile_unavailable",
                ErrorCategoryV1::Unavailable,
                "shell profile is not registered",
            )
        })?
        .clone();
    if profile.kind != ShellProfileKind::PosixBash {
        return Err((
            "profile_unavailable",
            ErrorCategoryV1::Unavailable,
            "only the registered Linux Bash profile is available",
        ));
    }
    let command = text(fields, "command")?;
    if command.len() > 64 * 1024 {
        return Err(invalid());
    }
    let requested_cwd = text(fields, "cwd")?;
    if requested_cwd.len() > 4096 {
        return Err(invalid());
    }
    let denied = (
        "effect_denied",
        ErrorCategoryV1::Authorization,
        "terminal working directory is outside the registered Location",
    );
    let cwd = match fs::canonicalize(requested_cwd) {
        Ok(cwd)
            if cwd.to_str() == Some(requested_cwd) && cwd.starts_with(&location.canonical_root) =>
        {
            cwd
        }
        _ => return Err(denied),
    };
    if !fs::metadata(&cwd).is_ok_and(|metadata| metadata.is_dir()) {
        return Err(denied);
    }
    let relative = cwd
        .strip_prefix(&location.canonical_root)
        .map_err(|_| denied)?;
    if relative
        .components()
        .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(denied);
    }
    let timeout_ms = get_unsigned(fields, "timeoutMs")?;
    if !(1..=600_000).contains(&timeout_ms) {
        return Err(invalid());
    }
    let Some(Value::Map(environment_fields)) = fields.get("resolvedEnvironment") else {
        return Err(invalid());
    };
    if environment_fields.len() > 128 {
        return Err(invalid());
    }
    let mut environment = BTreeMap::new();
    let mut environment_bytes = 0_usize;
    for (key, value) in environment_fields {
        let Value::String(value) = value else {
            return Err(invalid());
        };
        if !valid_environment_key(key)
            || value.contains('\0')
            || matches!(
                key.as_str(),
                "BASH_ENV" | "ENV" | "SHELLOPTS" | "BASHOPTS" | "IFS"
            )
            || key.starts_with("LD_")
        {
            return Err(invalid());
        }
        environment_bytes = environment_bytes
            .checked_add(key.len())
            .and_then(|size| size.checked_add(value.len()))
            .ok_or_else(invalid)?;
        if environment_bytes > 64 * 1024 {
            return Err(invalid());
        }
        environment.insert(OsString::from(key.as_str()), OsString::from(value.as_str()));
    }
    Ok(TerminalRunConfig {
        profile,
        command: command.to_owned(),
        cwd,
        timeout: Duration::from_millis(timeout_ms),
        environment,
        canonical_arguments: arguments.clone(),
    })
}

fn relative_to_location(root: &Path, cwd: &Path) -> Result<String, HostError> {
    let relative = cwd.strip_prefix(root).map_err(|_| {
        (
            "effect_denied",
            ErrorCategoryV1::Authorization,
            "terminal working directory is outside the registered Location",
        )
    })?;
    if relative.as_os_str().is_empty() {
        Ok(".".to_owned())
    } else {
        Ok(relative.to_string_lossy().replace('\\', "/"))
    }
}

fn select_fields(fields: &BTreeMap<String, Value>, keys: &[&str]) -> Result<Value, HostError> {
    let mut selected = BTreeMap::new();
    for key in keys {
        selected.insert(
            (*key).to_owned(),
            fields.get(*key).ok_or_else(invalid)?.clone(),
        );
    }
    Ok(Value::Map(selected))
}

/// Append one bounded non-blocking read to the artifact buffer. Returns whether the
/// artifact grew, so a full buffer ends a drain instead of spinning. Reads past the
/// artifact cap only flag truncation.
fn capture_output(
    process: &mut TerminalProcess,
    output: &mut Vec<u8>,
    truncated: &mut bool,
) -> bool {
    match process.read_output(MAX_OUTPUT_BYTES) {
        Ok(bytes) if bytes.is_empty() => false,
        Ok(bytes) => {
            let room = MAX_TERMINAL_OUTPUT_BYTES.saturating_sub(output.len());
            let kept = bytes.len().min(room);
            output.extend_from_slice(&bytes[..kept]);
            if kept < bytes.len() {
                *truncated = true;
            }
            kept > 0
        }
        Err(_) => {
            *truncated = true;
            false
        }
    }
}

/// The bounded preview prefix served with a settled run: at most 50 KiB and 2000 lines,
/// never splitting a UTF-8 sequence. Returns whether the preview omits artifact bytes.
fn terminal_preview(output: &[u8]) -> (String, bool) {
    let mut end = output.len().min(MAX_PREVIEW_BYTES);
    while end > 0 {
        match std::str::from_utf8(&output[..end]) {
            Ok(_) => break,
            Err(error) if error.error_len().is_none() => end -= 1,
            Err(_) => break,
        }
    }
    let preview = String::from_utf8_lossy(&output[..end]).into_owned();
    let truncated = end < output.len();
    if preview.lines().count() <= MAX_PREVIEW_LINES {
        return (preview, truncated);
    }
    (
        preview
            .lines()
            .take(MAX_PREVIEW_LINES)
            .collect::<Vec<_>>()
            .join("\n"),
        true,
    )
}

/// The Canonical exit code of an observed exit. A signal-terminated child reports the
/// conventional `128 + signal` shell code, because a settled "exited" run must carry a
/// code and the durable store persists non-negative codes only.
fn exit_code(status: std::process::ExitStatus) -> Option<i32> {
    status.code().or_else(|| {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            status.signal().map(|signal| 128 + signal)
        }
        #[cfg(not(unix))]
        {
            None
        }
    })
}

fn terminal_failure(error: &TypedErrorV1) -> HostError {
    match error.code.as_str() {
        "invalid_effect_request" => (
            "invalid_effect_request",
            ErrorCategoryV1::Validation,
            "terminal request is malformed",
        ),
        "effect_denied" => (
            "effect_denied",
            ErrorCategoryV1::Authorization,
            "EffectHost denied the terminal run",
        ),
        "approval_not_found" => (
            "approval_not_found",
            ErrorCategoryV1::NotFound,
            "terminal approval challenge was not found",
        ),
        "effect_conflict" => (
            "effect_conflict",
            ErrorCategoryV1::Conflict,
            "terminal challenge is expired, consumed, or no longer applicable",
        ),
        "effect_outcome_unknown" => (
            "effect_outcome_unknown",
            ErrorCategoryV1::Uncertain,
            "terminal outcome is unknown and must not be retried",
        ),
        _ => (
            "effect_unavailable",
            ErrorCategoryV1::Unavailable,
            "terminal effect storage is unavailable",
        ),
    }
}

fn response_ok(request: &RpcRequestV1, fence: &FrameFence, body: Value) -> RpcResponseV1 {
    RpcResponseV1 {
        owner_epoch: fence.owner_epoch(),
        process_incarnation: fence.process_incarnation().to_owned(),
        request_id: request.request_id.clone(),
        outcome: RpcOutcomeV1::Ok,
        owner_cursor: None,
        receipt_digest: None,
        body: Some(body),
        error: None,
    }
}

fn get_text<'a>(fields: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a str, HostError> {
    match fields.get(key) {
        Some(Value::String(value)) if !value.is_empty() => Ok(value),
        _ => Err(invalid()),
    }
}

fn get_unsigned(fields: &BTreeMap<String, Value>, key: &str) -> Result<u64, HostError> {
    match fields.get(key) {
        Some(Value::Unsigned(value)) => Ok(*value),
        _ => Err(invalid()),
    }
}

fn strict_fields<'a>(
    value: &'a Value,
    required: &[&str],
    optional: &[&str],
) -> Result<&'a BTreeMap<String, Value>, (&'static str, ErrorCategoryV1, &'static str)> {
    let Value::Map(fields) = value else {
        return Err(invalid());
    };
    if required.iter().any(|key| !fields.contains_key(*key))
        || fields
            .keys()
            .any(|key| !required.contains(&key.as_str()) && !optional.contains(&key.as_str()))
    {
        return Err(invalid());
    }
    Ok(fields)
}

fn text<'a>(
    fields: &'a BTreeMap<String, Value>,
    key: &str,
) -> Result<&'a str, (&'static str, ErrorCategoryV1, &'static str)> {
    fields.get(key).ok_or_else(invalid).and_then(value_text)
}

fn value_text(value: &Value) -> Result<&str, (&'static str, ErrorCategoryV1, &'static str)> {
    match value {
        Value::String(value) if !value.is_empty() && !value.contains('\0') => Ok(value),
        _ => Err(invalid()),
    }
}

fn string_value<'a>(fields: &'a BTreeMap<String, Value>, key: &str) -> Result<&'a str, HostError> {
    match fields.get(key) {
        Some(Value::String(value)) if !value.contains('\0') => Ok(value),
        _ => Err(invalid()),
    }
}

fn validate_patch_operations(value: &Value) -> Result<(), HostError> {
    let Value::Array(operations) = value else {
        return Err(invalid());
    };
    if operations.is_empty() || operations.len() > 64 {
        return Err(invalid());
    }
    for operation in operations {
        let Value::Map(fields) = operation else {
            return Err(invalid());
        };
        match text(fields, "operation")? {
            "write" => {
                let fields = strict_fields(
                    operation,
                    &["operation", "path", "expectedBeforeBase64", "contentBase64"],
                    &["executable"],
                )?;
                text(fields, "path")?;
                let before = fields.get("expectedBeforeBase64").ok_or_else(invalid)?;
                if !matches!(before, Value::Nil | Value::String(_)) {
                    return Err(invalid());
                }
                let content = string_value(fields, "contentBase64")?;
                if content.len() > 2_800_000 {
                    return Err(invalid());
                }
                if let Some(executable) = fields.get("executable") {
                    if !matches!(executable, Value::Bool(_)) {
                        return Err(invalid());
                    }
                }
            }
            "delete" => {
                let fields = strict_fields(
                    operation,
                    &["operation", "path", "expectedBeforeBase64"],
                    &[],
                )?;
                text(fields, "path")?;
                if !matches!(fields.get("expectedBeforeBase64"), Some(Value::String(_))) {
                    return Err(invalid());
                }
            }
            _ => {
                return Err((
                    "effect_unavailable",
                    ErrorCategoryV1::Unavailable,
                    "patch operation is unsupported",
                ));
            }
        }
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    if !path.exists() {
        fs::create_dir(path)
            .map_err(|_| "private host directory could not be created".to_owned())?;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| "private host directory permissions could not be secured".to_owned())?;
    }
    let metadata = fs::symlink_metadata(path)
        .map_err(|_| "private host directory could not be inspected".to_owned())?;
    if metadata.file_type().is_symlink()
        || !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err("host directory is not private and owner-controlled".to_owned());
    }
    Ok(())
}

fn reject_unbound_legacy_effects(state_dir: &Path) -> Result<(), String> {
    let path = state_dir.join("effects.sqlite");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(_) => return Err("legacy effect database could not be inspected".to_owned()),
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.nlink() != 1
        || metadata.mode() & 0o077 != 0
    {
        return Err("legacy effect database is not private and regular".to_owned());
    }
    let connection = Connection::open_with_flags(&path, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|_| "legacy effect database could not be inspected".to_owned())?;
    let has_challenges: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='effect_challenges')",
        [],
        |row| row.get(0),
    ).map_err(|_| "legacy effect database schema could not be inspected".to_owned())?;
    if has_challenges {
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM effect_challenges", [], |row| {
                row.get(0)
            })
            .map_err(|_| "legacy effect records could not be inspected".to_owned())?;
        if count != 0 {
            return Err(
                "legacy effects have no durable Location binding and cannot be recovered safely"
                    .to_owned(),
            );
        }
    }
    Ok(())
}
fn open_location_registry(state_dir: &Path) -> Result<Connection, String> {
    let path = state_dir.join("host-locations.sqlite");
    if let Ok(metadata) = fs::symlink_metadata(&path)
        && (metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.uid() != unsafe { libc::geteuid() }
            || metadata.nlink() != 1
            || metadata.mode() & 0o077 != 0)
    {
        return Err("Location registry is not a private regular file".to_owned());
    }
    let connection =
        Connection::open(&path).map_err(|_| "Location registry could not be opened".to_owned())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o600))
        .map_err(|_| "Location registry permissions could not be secured".to_owned())?;
    connection
        .pragma_update(None, "journal_mode", "DELETE")
        .map_err(|_| "Location registry journaling could not be configured".to_owned())?;
    connection
        .pragma_update(None, "synchronous", "FULL")
        .map_err(|_| "Location registry durability could not be configured".to_owned())?;
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS locations (
            location_id TEXT PRIMARY KEY,
            canonical_root TEXT NOT NULL,
            workspace_id TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS terminal_sessions (
            terminal_id TEXT PRIMARY KEY,
            principal TEXT NOT NULL,
            generation INTEGER NOT NULL,
            outcome TEXT NOT NULL DEFAULT 'unknown'
        );",
        )
        .map_err(|_| "Location registry schema could not be initialized".to_owned())?;
    let has_outcome: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('terminal_sessions') WHERE name='outcome')",
        [],
        |row| row.get(0),
    ).map_err(|_| "terminal session schema could not be inspected".to_owned())?;
    if !has_outcome {
        connection
            .execute(
                "ALTER TABLE terminal_sessions ADD COLUMN outcome TEXT NOT NULL DEFAULT 'unknown'",
                [],
            )
            .map_err(|_| "terminal session outcome schema could not be migrated".to_owned())?;
    }
    connection
        .execute("UPDATE terminal_sessions SET outcome='unknown'", [])
        .map_err(|_| "terminal recovery outcome could not be reset to UNKNOWN".to_owned())?;
    Ok(connection)
}

fn location_id(canonical_root: &str, workspace_id: &str) -> String {
    format!(
        "loc_{}",
        blake3::hash(format!("horizon.location.v1\0{canonical_root}\0{workspace_id}").as_bytes())
            .to_hex()
    )
}

fn load_locations(
    registry: &Connection,
    location_state_root: &Path,
) -> Result<HashMap<String, RegisteredLocation>, String> {
    let mut statement = registry
        .prepare(
            "SELECT location_id, canonical_root, workspace_id FROM locations ORDER BY location_id",
        )
        .map_err(|_| "Location registry could not be queried".to_owned())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|_| "Location registry could not be read".to_owned())?;
    let mut locations = HashMap::new();
    for row in rows {
        let (id, root_text, workspace_id) =
            row.map_err(|_| "Location registry row is malformed".to_owned())?;
        let root = fs::canonicalize(&root_text)
            .map_err(|_| "registered Location root is unavailable".to_owned())?;
        if root.to_str() != Some(root_text.as_str())
            || !fs::metadata(&root).is_ok_and(|metadata| metadata.is_dir())
            || location_id(&root_text, &workspace_id) != id
        {
            return Err("registered Location binding is not canonical".to_owned());
        }
        let effect_state_dir = location_state_root.join(&id);
        ensure_private_directory(&effect_state_dir)?;
        drop(EffectHost::open(&effect_state_dir, Some(&root))?);
        locations.insert(
            id,
            RegisteredLocation {
                canonical_root: root,
                workspace_id,
                effect_state_dir,
            },
        );
    }
    Ok(locations)
}
fn load_lost_terminals(registry: &Connection) -> Result<HashMap<String, (String, u64)>, String> {
    let mut statement = registry
        .prepare("SELECT terminal_id, principal, generation FROM terminal_sessions")
        .map_err(|_| "terminal session registry could not be queried".to_owned())?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .map_err(|_| "terminal session registry could not be read".to_owned())?;
    let mut terminals = HashMap::new();
    for row in rows {
        let (terminal_id, principal, generation) =
            row.map_err(|_| "terminal session record is malformed".to_owned())?;
        let generation = u64::try_from(generation)
            .map_err(|_| "terminal session generation is malformed".to_owned())?;
        terminals.insert(terminal_id, (principal, generation));
    }
    Ok(terminals)
}

fn persist_terminal_session(
    registry: &Connection,
    terminal_id: &str,
    principal: &str,
    generation: u64,
) -> Result<(), HostError> {
    let generation = i64::try_from(generation).map_err(|_| invalid())?;
    registry.execute(
        "INSERT INTO terminal_sessions(terminal_id, principal, generation, outcome) VALUES (?1, ?2, ?3, 'unknown')",
        params![terminal_id, principal, generation],
    ).map_err(|_| ("effect_unavailable", ErrorCategoryV1::Unavailable, "terminal recovery record could not be persisted"))?;
    Ok(())
}

fn valid_principal(principal: &str) -> bool {
    principal.strip_prefix("host_os_uid:").is_some_and(|uid| {
        !uid.is_empty() && uid.len() <= 10 && uid.bytes().all(|byte| byte.is_ascii_digit())
    }) || principal
        .strip_prefix("server_auth:")
        .is_some_and(|subject| {
            !subject.is_empty() && subject.len() <= 256 && !subject.chars().any(char::is_control)
        })
}
fn invalid() -> (&'static str, ErrorCategoryV1, &'static str) {
    (
        "invalid_effect_request",
        ErrorCategoryV1::Validation,
        "effect request is malformed",
    )
}

fn map_value<const N: usize>(items: [(&str, Value); N]) -> Value {
    Value::Map(
        items
            .into_iter()
            .map(|(key, value)| (key.to_owned(), value))
            .collect(),
    )
}

fn response_error(
    request: &RpcRequestV1,
    fence: &FrameFence,
    code: &'static str,
    category: ErrorCategoryV1,
    message: &'static str,
) -> RpcResponseV1 {
    RpcResponseV1 {
        owner_epoch: fence.owner_epoch(),
        process_incarnation: fence.process_incarnation().to_owned(),
        request_id: request.request_id.clone(),
        outcome: RpcOutcomeV1::Error,
        owner_cursor: None,
        receipt_digest: None,
        body: None,
        error: Some(TypedErrorV1 {
            code: code.to_owned(),
            category,
            message: message.to_owned(),
            retry_class: RetryClassV1::Never,
            retry_after_ms: None,
            owner_cursor: None,
            subject_ids: Vec::new(),
            details: None,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::protocol::FrameFence;
    use std::os::unix::fs::PermissionsExt;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn state_dir() -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let path =
            std::env::temp_dir().join(format!("hz-host-kernel-{}-{nonce}", std::process::id()));
        fs::create_dir(&path).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn request(operation: &str, body: Value, epoch: u64, incarnation: &str) -> RpcRequestV1 {
        RpcRequestV1 {
            owner_epoch: epoch,
            process_incarnation: incarnation.to_owned(),
            request_id: "req_test".to_owned(),
            service_id: EFFECTS_SERVICE_ID.to_owned(),
            operation: operation.to_owned(),
            delivery_id: None,
            expected_cursor: None,
            deadline_unix_ms: std::time::SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as u64
                + 30_000,
            trace_id: "trace_test".to_owned(),
            body,
        }
    }

    fn fence() -> FrameFence {
        FrameFence::new(7, "inc_test").unwrap()
    }

    fn map(items: &[(&str, Value)]) -> Value {
        Value::Map(
            items
                .iter()
                .map(|(key, value)| ((*key).to_owned(), value.clone()))
                .collect(),
        )
    }

    fn string(value: &str) -> Value {
        Value::String(value.to_owned())
    }

    #[test]
    fn registers_only_canonical_trusted_location_ids() {
        let directory = state_dir();
        let mut host = HostKernel::open(&directory).unwrap();
        host.set_effects_enabled(true);
        let canonical = fs::canonicalize(&directory).unwrap();
        let body = map(&[("canonicalRoot", string(canonical.to_str().unwrap()))]);
        let response = host.handle_request(
            &request("register_location", body.clone(), 7, "inc_test"),
            "host_os_uid:1000",
            &fence(),
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
        let expected = format!(
            "loc_{}",
            blake3::hash(
                format!("horizon.location.v1\0{}\0", canonical.to_str().unwrap()).as_bytes()
            )
            .to_hex()
        );
        let Some(Value::Map(fields)) = response.body else {
            panic!("missing registration response")
        };
        assert_eq!(fields.get("locationID"), Some(&string(&expected)));
        let again = host.handle_request(
            &request("register_location", body, 7, "inc_test"),
            "host_os_uid:1000",
            &fence(),
        );
        let Some(Value::Map(fields)) = again.body else {
            panic!("missing repeated registration")
        };
        assert_eq!(fields.get("locationID"), Some(&string(&expected)));
        drop(host);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unregistered_location_and_malformed_batch_without_effects() {
        let directory = state_dir();
        let mut host = HostKernel::open(&directory).unwrap();
        host.set_effects_enabled(true);
        let body = map(&[
            ("sessionID", string("ses_test")),
            ("locationID", string("loc_unregistered")),
            ("batchID", string("batch_test")),
            ("turnContextDigest", string("sha256:bad")),
            ("calls", Value::Array(vec![])),
        ]);
        let response = host.handle_request(
            &request("prepare_tool_batch", body, 7, "inc_test"),
            "host_os_uid:1000",
            &fence(),
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("location_not_registered")
        );
        drop(host);
        assert!(!directory.join("unrelated-effect-target").exists());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_stale_fence_before_registration_or_effect_dispatch() {
        let directory = state_dir();
        let mut host = HostKernel::open(&directory).unwrap();
        let body = map(&[("canonicalRoot", string(directory.to_str().unwrap()))]);
        let response = host.handle_request(
            &request("register_location", body, 6, "inc_test"),
            "host_os_uid:1000",
            &fence(),
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("stale_fence")
        );
        drop(host);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn rejects_unknown_fields_in_effect_requests() {
        let directory = state_dir();
        let mut host = HostKernel::open(&directory).unwrap();
        host.set_effects_enabled(true);
        let body = map(&[
            ("canonicalRoot", string(directory.to_str().unwrap())),
            ("workspaceRoot", string("/")),
        ]);
        let response = host.handle_request(
            &request("register_location", body, 7, "inc_test"),
            "host_os_uid:1000",
            &fence(),
        );
        assert_eq!(response.outcome, RpcOutcomeV1::Error);
        assert_eq!(
            response.error.as_ref().map(|error| error.code.as_str()),
            Some("invalid_effect_request")
        );
        drop(host);
        fs::remove_dir_all(directory).unwrap();
    }
    #[test]
    fn terminal_subscription_capacity_returns_explicit_resnapshot_at_boundary() {
        let requested = CursorV1 {
            owner_kind: "terminal".to_owned(),
            owner_id: "pty_limit_test".to_owned(),
            seq: "0".to_owned(),
            event_digest: format!("blake3:{}", "0".repeat(64)),
        };
        assert!(
            terminal_subscription_rejection(
                MAX_TERMINAL_SUBSCRIPTIONS - 1,
                0,
                false,
                &fence(),
                "sub_next",
                &requested,
                &requested,
            )
            .is_none()
        );
        assert!(!can_add_terminal_subscription(
            0,
            MAX_TERMINAL_SUBSCRIPTIONS_PER_TERMINAL,
            false
        ));
        assert!(matches!(
            terminal_subscription_rejection(
                MAX_TERMINAL_SUBSCRIPTIONS, 0, false, &fence(), "sub_overflow", &requested, &requested,
            ),
            Some(RpcMessageV1::Control(control))
                if matches!(control.as_ref(), RpcControlV1::ResnapshotRequired { subscription_id, .. }
                    if subscription_id == "sub_overflow")
        ));
        assert!(!can_add_terminal_subscription(0, 0, true));
    }

    #[test]
    fn restart_reports_persisted_terminal_unknown_without_replay() {
        let directory = state_dir();
        let host = HostKernel::open(&directory).unwrap();
        persist_terminal_session(
            &host.location_registry,
            "pty_restart_unknown",
            "host_os_uid:1000",
            3,
        )
        .unwrap();
        drop(host);

        let mut restarted = HostKernel::open(&directory).unwrap();
        let mut status_request = request(
            "status",
            map_value([
                (
                    "terminalID",
                    Value::String("pty_restart_unknown".to_owned()),
                ),
                ("generation", Value::Unsigned(3)),
            ]),
            7,
            "inc_test",
        );
        status_request.service_id = TERMINAL_SERVICE_ID.to_owned();
        let response = restarted.handle_request(&status_request, "host_os_uid:1000", &fence());
        assert_eq!(response.outcome, RpcOutcomeV1::Ok);
        let Some(Value::Map(body)) = response.body else {
            panic!("missing terminal restart status")
        };
        assert_eq!(
            body.get("status"),
            Some(&Value::String("unknown".to_owned()))
        );
        assert_eq!(body.get("generation"), Some(&Value::Unsigned(3)));
        assert_eq!(body.get("sessionLost"), Some(&Value::Bool(true)));
        assert_eq!(body.get("byteCursor"), Some(&Value::Unsigned(0)));
        assert_eq!(body.get("nextSequence"), Some(&Value::Unsigned(1)));
        assert_eq!(body.get("ownerEpoch"), Some(&Value::Unsigned(7)));
        assert_eq!(body.get("replay"), Some(&Value::Array(Vec::new())));
        drop(restarted);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn observed_terminal_exit_is_encoded_as_typed_event_payload() {
        let spec = TerminalLaunchSpec {
            executable: PathBuf::from("/bin/sh"),
            argv: vec![
                std::ffi::OsString::from("-c"),
                std::ffi::OsString::from("exit 7"),
            ],
            cwd: std::env::current_dir().unwrap(),
            env: BTreeMap::new(),
            cols: TERMINAL_COLUMNS,
            rows: TERMINAL_ROWS,
        };
        let mut process = TerminalProcess::spawn(spec).unwrap();
        assert!(!TerminalProcess::owner_loss_tree_cleanup_supported());
        let guarantees = process.guarantees();
        assert!(!guarantees.tree_kill_on_owner_close);
        assert!(!guarantees.process_tree_termination);
        let deadline = Instant::now() + Duration::from_secs(2);
        let status = loop {
            if let Some(status) = process.try_wait().unwrap() {
                break status;
            }
            assert!(Instant::now() < deadline, "test terminal did not exit");
            std::thread::sleep(Duration::from_millis(5));
        };
        let code = exit_code(status).expect("observed exit must have an exit code");
        assert_eq!(code, 7);
        let mut replay = crate::terminal::ReplayRing::new(1);
        let chunk = replay
            .append("exit", code.to_string().as_bytes())
            .unwrap()
            .remove(0);
        let event = terminal_rpc_event(&fence(), "sub_exit", "pty_exit_test", &chunk).unwrap();
        assert_eq!(
            event.payload,
            map(&[
                ("terminalID", string("pty_exit_test")),
                ("generation", Value::Unsigned(1)),
                ("sequence", Value::Unsigned(1)),
                ("byteCursor", Value::Unsigned(0)),
                ("kind", string("exit")),
                ("payload", map(&[("exitCode", Value::Unsigned(7))])),
            ]),
        );
        let canonical = Value::Map(BTreeMap::from([
            ("terminalID".to_owned(), string("pty_exit_test")),
            ("generation".to_owned(), Value::Unsigned(1)),
            ("sequence".to_owned(), Value::Unsigned(1)),
            ("byteCursor".to_owned(), Value::Unsigned(0)),
            ("kind".to_owned(), string("exit")),
            (
                "payload".to_owned(),
                map(&[("exitCode", Value::Unsigned(7))]),
            ),
        ]));
        let encoded =
            crate::messagepack::encode(&canonical, crate::messagepack::FRAME_LIMITS).unwrap();
        assert_eq!(event.cursor, chunk.cursor("pty_exit_test").unwrap());
        assert_eq!(
            event.cursor.event_digest,
            format!("blake3:{}", blake3::hash(&encoded).to_hex())
        );
    }
}
