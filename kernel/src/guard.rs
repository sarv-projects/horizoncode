//! Canonical authorization decisions for kernel-owned effects.
//!
//! The workspace policy admits same-Session `files.write` and `files.patch` requests that
//! have already been resolved beneath the pinned workspace handle. The decision is ASK;
//! the host may resolve that exact durable challenge after the PermissionV2 path returns.

use std::path::{Component, Path};

/// HostKernel-derived direct-session permission mode. This projection is private to the
/// Rust host boundary: callers may request a mode change, but cannot provide these pins.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DirectSandboxModeV1 {
    ReadOnly,
    WorkspaceWrite,
    DangerFullAccess,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DirectApprovalPolicyV1 {
    OnRequest,
    Always,
    Never,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DirectPermissionModeSourceV1 {
    Default,
    UserSession,
    UserConfig,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct DirectSessionPermissionModeProjectionV1 {
    pub(crate) session_id: String,
    pub(crate) owner_epoch: u64,
    pub(crate) location_id: String,
    pub(crate) workspace_id: String,
    pub(crate) workspace_root_digest: String,
    pub(crate) execution_backend_id: String,
    pub(crate) policy_digest: String,
    pub(crate) sandbox_mode: DirectSandboxModeV1,
    pub(crate) approval_policy: DirectApprovalPolicyV1,
    pub(crate) source: DirectPermissionModeSourceV1,
    pub(crate) revision: u64,
    pub(crate) digest: String,
}

impl DirectSessionPermissionModeProjectionV1 {
    /// Decode only the exact strict HostKernel projection shape. This parser is for the
    /// private in-process HostKernel -> EffectHost boundary, never a public RPC body.
    pub(crate) fn from_value(value: &crate::messagepack::Value) -> Option<Self> {
        use crate::messagepack::Value;
        let Value::Map(fields) = value else { return None; };
        const KEYS: [&str; 13] = [
            "schemaVersion", "sessionId", "ownerEpoch", "locationId", "workspaceId",
            "workspaceRootDigest", "executionBackendId", "policyDigest", "sandboxMode",
            "approvalPolicy", "source", "revision", "digest",
        ];
        if fields.len() != KEYS.len() || KEYS.iter().any(|key| !fields.contains_key(*key)) {
            return None;
        }
        let text = |key: &str| match fields.get(key) { Some(Value::String(value)) => Some(value.as_str()), _ => None };
        let decimal = |key: &str| -> Option<u64> {
            let value = text(key)?;
            if value.is_empty() || value.len() > 20 || value.starts_with('0') || !value.bytes().all(|b| b.is_ascii_digit()) { return None; }
            value.parse::<u64>().ok().filter(|value| *value > 0)
        };
        if !matches!(fields.get("schemaVersion"), Some(Value::Unsigned(1))) { return None; }
        let sandbox_mode = match text("sandboxMode")? {
            "read-only" => DirectSandboxModeV1::ReadOnly,
            "workspace-write" => DirectSandboxModeV1::WorkspaceWrite,
            "danger-full-access" => DirectSandboxModeV1::DangerFullAccess,
            _ => return None,
        };
        let approval_policy = match text("approvalPolicy")? {
            "on-request" => DirectApprovalPolicyV1::OnRequest,
            "always" => DirectApprovalPolicyV1::Always,
            "never" => DirectApprovalPolicyV1::Never,
            _ => return None,
        };
        let source = match text("source")? {
            "default" => DirectPermissionModeSourceV1::Default,
            "user-session" => DirectPermissionModeSourceV1::UserSession,
            "user-config" => DirectPermissionModeSourceV1::UserConfig,
            _ => return None,
        };
        let projection = Self {
            session_id: text("sessionId")?.to_owned(),
            owner_epoch: decimal("ownerEpoch")?,
            location_id: text("locationId")?.to_owned(),
            workspace_id: text("workspaceId")?.to_owned(),
            workspace_root_digest: text("workspaceRootDigest")?.to_owned(),
            execution_backend_id: text("executionBackendId")?.to_owned(),
            policy_digest: text("policyDigest")?.to_owned(),
            sandbox_mode,
            approval_policy,
            source,
            revision: decimal("revision")?,
            digest: text("digest")?.to_owned(),
        };
        projection.validate().then_some(projection)
    }

    pub(crate) fn validate(&self) -> bool {
        let valid_id = |value: &str| !value.is_empty() && value.len() <= 256
            && value.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
        self.owner_epoch > 0 && self.revision > 0
            && valid_id(&self.session_id) && valid_id(&self.location_id)
            && valid_id(&self.workspace_id) && valid_id(&self.execution_backend_id)
            && self.execution_backend_id == DIRECT_SESSION_EFFECT_BACKEND_ID
            && is_digest(&self.workspace_root_digest) && is_digest(&self.policy_digest)
            && is_digest(&self.digest)
            && (self.source != DirectPermissionModeSourceV1::Default
                || (self.sandbox_mode == DirectSandboxModeV1::WorkspaceWrite
                    && self.approval_policy == DirectApprovalPolicyV1::OnRequest))
            && (self.sandbox_mode != DirectSandboxModeV1::DangerFullAccess
                || (self.source == DirectPermissionModeSourceV1::UserSession
                    && self.approval_policy == DirectApprovalPolicyV1::Never))
            && self.digest == self.recompute_digest()
    }

    pub(crate) fn recompute_digest(&self) -> String {
        use crate::messagepack::Value;
        let sandbox = match self.sandbox_mode {
            DirectSandboxModeV1::ReadOnly => "read-only",
            DirectSandboxModeV1::WorkspaceWrite => "workspace-write",
            DirectSandboxModeV1::DangerFullAccess => "danger-full-access",
        };
        let approval = match self.approval_policy {
            DirectApprovalPolicyV1::OnRequest => "on-request",
            DirectApprovalPolicyV1::Always => "always",
            DirectApprovalPolicyV1::Never => "never",
        };
        let source = match self.source {
            DirectPermissionModeSourceV1::Default => "default",
            DirectPermissionModeSourceV1::UserSession => "user-session",
            DirectPermissionModeSourceV1::UserConfig => "user-config",
        };
        let value = Value::Map(std::collections::BTreeMap::from([
            ("schemaVersion".to_owned(), Value::Unsigned(1)),
            ("sessionId".to_owned(), Value::String(self.session_id.clone())),
            ("ownerEpoch".to_owned(), Value::String(self.owner_epoch.to_string())),
            ("locationId".to_owned(), Value::String(self.location_id.clone())),
            ("workspaceId".to_owned(), Value::String(self.workspace_id.clone())),
            ("workspaceRootDigest".to_owned(), Value::String(self.workspace_root_digest.clone())),
            ("executionBackendId".to_owned(), Value::String(self.execution_backend_id.clone())),
            ("policyDigest".to_owned(), Value::String(self.policy_digest.clone())),
            ("sandboxMode".to_owned(), Value::String(sandbox.to_owned())),
            ("approvalPolicy".to_owned(), Value::String(approval.to_owned())),
            ("source".to_owned(), Value::String(source.to_owned())),
            ("revision".to_owned(), Value::String(self.revision.to_string())),
        ]));
        let encoded = crate::messagepack::encode(&value, crate::messagepack::FRAME_LIMITS)
            .expect("validated direct permission mode projection is bounded");
        let mut hasher = blake3::Hasher::new();
        hasher.update(b"horizoncode.direct-session-permission-mode.v1\0");
        hasher.update(&encoded);
        format!("blake3:{}", hasher.finalize().to_hex())
    }
}

pub const FILES_WRITE_ID: &str = "files.write";
pub const FILES_PATCH_ID: &str = "files.patch";
pub const FILES_READ_ID: &str = "files.read";
pub const TERMINAL_RUN_ID: &str = "terminal.run";
pub const TERMINAL_START_ID: &str = "terminal.start";
pub const WEB_SEARCH_ID: &str = "web.search";
/// Internal authorization for one managed model-provider request. This action is
/// never projected as a model tool and is accepted only with HostKernel-minted
/// ManagedRun Attempt scope and exact selected route/request pins.
pub const PROVIDERS_INFER_ID: &str = "providers.infer";
/// Supervised language-service process control (§30.14/§33.23). The executable is never
/// model-chosen: it must match a host-configured trusted executable profile exactly.
/// The canonical lifecycle capabilities are `language.start` and `language.stop`.
pub const LANGUAGE_SERVER_START_ID: &str = "language.start";
pub const LANGUAGE_SERVER_STOP_ID: &str = "language.stop";
pub const LANGUAGE_DIAGNOSTICS_ID: &str = "language.diagnostics";
pub const DEFINITIONS_FIND_ID: &str = "definitions.find";
pub const REFERENCES_FIND_ID: &str = "references.find";
pub const SYMBOLS_OUTLINE_ID: &str = "symbols.outline";
pub const SYMBOLS_SEARCH_ID: &str = "symbols.search";
/// Guard action for the existing public `agents.message` capability. The private
/// direct.message.v1 RPC never introduces a second public authority surface.
pub const AGENTS_MESSAGE_ID: &str = "agents.message";
/// User-authenticated automation definition mutations. This policy never authorizes
/// runNow/invocation, which remains a separate supervised effect.
pub const AUTOMATION_CREATE_ID: &str = "automations.create";
pub const AUTOMATION_UPDATE_ID: &str = "automations.update";
pub const AUTOMATION_ENABLE_ID: &str = "automations.enable";
pub const AUTOMATION_DISABLE_ID: &str = "automations.disable";
/// Debug-adapter session control and expression evaluation (§33.9/§37.7). IDs are the
/// canonical `debug.*` family from the capability catalog.
pub const DEBUG_START_ID: &str = "debug.start";
pub const DEBUG_ATTACH_ID: &str = "debug.attach";
pub const DEBUG_STOP_ID: &str = "debug.stop";
pub const DEBUG_EVALUATE_ID: &str = "debug.evaluate";
pub const DEBUG_BREAKPOINT_SET_ID: &str = "debug.breakpoint.set";
pub const DEBUG_CONTINUE_ID: &str = "debug.continue";
pub const DEBUG_PAUSE_ID: &str = "debug.pause";
pub const DEBUG_STEP_OVER_ID: &str = "debug.step.over";
pub const DEBUG_STEP_INTO_ID: &str = "debug.step.into";
pub const DEBUG_STEP_OUT_ID: &str = "debug.step.out";
pub const DEBUG_STACK_ID: &str = "debug.stack";
pub const DEBUG_SCOPES_ID: &str = "debug.scopes";
pub const DEBUG_VARIABLES_ID: &str = "debug.variables";
/// Bounded REPL interpreter start/execute/reset/stop (§33.9/§37.8); canonical `repl.*`.
pub const REPL_START_ID: &str = "repl.start";
pub const REPL_EXECUTE_ID: &str = "repl.execute";
pub const REPL_RESET_ID: &str = "repl.reset";
pub const REPL_STOP_ID: &str = "repl.stop";
/// Outer CodeMode capability. Nested calls must use their original canonical IDs.
pub const CODE_MODE_EXECUTE_ID: &str = "codemode.execute";
/// User-only external editor launch. HostKernel must bind this action to an
/// authenticated root Session and a trusted immutable Core Config profile;
/// it is never a model-visible tool or an implicit file-open side effect.
pub const EDITOR_LAUNCH_ID: &str = "editor.launch";
/// Host-registered verifier execution. Requests must bind to an immutable host profile;
/// model-originated batches cannot initiate verification.
pub const BUILTIN_VERIFIER_ID: &str = "builtin.verifier";
/// Root-scoped P8 worktree lifecycle operations. These are HostKernel-only
/// actions; model ToolBatch input cannot select their paths or executable.
pub const GIT_WORKTREE_ACQUIRE_ID: &str = "git.worktree.acquire";
pub const GIT_WORKTREE_LIST_ID: &str = "git.worktree.list";
pub const GIT_WORKTREE_RELEASE_ID: &str = "git.worktree.release";
pub const WORKSPACE_WRITE_POLICY_ID: &str = "workspace-write.local.v1";
pub const WORKSPACE_READ_POLICY_ID: &str = "workspace-read.local.v1";
pub const BROKER_PROCESS_POLICY_ID: &str = "broker-process.local.v1";
pub const PROTOCOL_IO_POLICY_ID: &str = "protocol-io.local.v1";
pub const OUTBOUND_HTTP_POLICY_ID: &str = "outbound-http.local.v1";
pub const PROVIDER_INFERENCE_POLICY_ID: &str = "provider-inference.managed.v1";
pub const AGENT_MESSAGE_POLICY_ID: &str = "agent-message.local.v1";
pub const AUTOMATION_POLICY_ID: &str = "automation-definition.local.v1";
pub const CODE_MODE_POLICY_ID: &str = "codemode-helper.local.v1";
pub const EDITOR_PROCESS_POLICY_ID: &str = "external-editor.local.v1";
const POLICY_BYTES: &[u8] =
    b"horizoncode.guard.workspace-write.local.v1:ask;beneath-root;no-symlink;no-hardlink;one-use";
const READ_POLICY_BYTES: &[u8] =
    b"horizoncode.guard.workspace-read.local.v1:allow;beneath-root;no-symlink;generation-pinned";
const GUARANTEES: &[&str] = &[
    "beneath_workspace_root",
    "no_symlink",
    "no_hardlink",
    "one_use",
];
const BROKER_POLICY_BYTES: &[u8] = b"horizoncode.guard.broker-process.local.v1:ask;configured-executable;bounded-argv-env;beneath-root;one-use";
const PROTOCOL_IO_POLICY_BYTES: &[u8] = b"horizoncode.guard.protocol-io.local.v1:ask;authenticated-process-generation;current-workspace-revision;bounded-protocol-payload;one-use";
pub(crate) const BROKER_GUARANTEES: &[&str] = &[
    "configured_executable",
    "bounded_argv_env",
    "beneath_workspace_root",
    "one_use",
];
const HTTP_POLICY_BYTES: &[u8] = b"horizoncode.guard.outbound-http.local.v1:https-only;host-allowlist;dns-pin;no-redirect;bounded;one-use";
const PROVIDER_INFERENCE_POLICY_BYTES: &[u8] = b"horizoncode.guard.provider-inference.managed.v1:managed-attempt;selected-provider-model-harness-route-endpoint;request-transport-secret-operation-digests;consent-budget;one-use;no-fallback";
const AGENT_MESSAGE_POLICY_BYTES: &[u8] = b"horizoncode.guard.agent-message.local.v1:authenticated-parent-child;profile-pinned;bounded-mailbox;one-use";
const AUTOMATION_POLICY_BYTES: &[u8] = b"horizoncode.guard.automation-definition.local.v1:server-auth-owner;definition-cas;durable-idempotent-receipt;one-use";
const CODE_MODE_POLICY_BYTES: &[u8] = b"horizoncode.guard.codemode-helper.local.v1:ask;explicit-enablement;fixed-host-resolved-helper;exact-resource-profile;bounded-source-tool-set;one-use";
const EDITOR_PROCESS_POLICY_BYTES: &[u8] = b"horizoncode.guard.external-editor.local.v1:user-only;root-session;trusted-profile;literal-argv;permission-mode;process-tree-containment;workspace-fence;one-use";
pub(crate) const CODE_MODE_GUARANTEES: &[&str] = &["explicit_codemode_enablement","fixed_host_resolved_helper","exact_resource_profile","bounded_source_tool_set","one_use"];
pub(crate) const EDITOR_PROCESS_GUARANTEES: &[&str] = &[
    "authenticated_root_session_user_action",
    "trusted_profile_revision_and_executable",
    "literal_bounded_argv_and_sanitized_environment",
    "permission_mode_bound",
    "process_tree_containment",
    "workspace_write_fence",
    "one_use",
];
pub(crate) const HTTP_GUARANTEES: &[&str] = &[
    "https_only",
    "host_allowlisted",
    "public_dns_pinned",
    "no_redirect",
    "bounded_request_response",
    "one_use",
];
pub(crate) const PROVIDER_INFERENCE_GUARANTEES: &[&str] = &[
    "live_managed_attempt", "selected_route_revision", "normalized_request_digest",
    "transport_request_digest", "secret_operation_digest", "explicit_route_consent",
    "budget_bound", "one_use", "no_fallback",
];
pub(crate) const AGENT_MESSAGE_GUARANTEES: &[&str] = &[
    "authenticated_parent_child_sessions",
    "immutable_profile_and_permission_scope",
    "bounded_mailbox",
    "one_use",
];
pub(crate) const AUTOMATION_GUARANTEES: &[&str] = &[
    "authenticated_workspace_owner",
    "definition_compare_and_swap",
    "durable_idempotent_receipt",
    "one_use",
];
pub(crate) const PROTOCOL_IO_GUARANTEES: &[&str] = &[
    "authenticated_process_generation",
    "current_workspace_revision",
    "bounded_protocol_payload",
    "one_use",
];
pub const PROTOCOL_IO_CAPABILITY_IDS: &[&str] = &[
    LANGUAGE_SERVER_START_ID,
    LANGUAGE_SERVER_STOP_ID,
    LANGUAGE_DIAGNOSTICS_ID,
    DEFINITIONS_FIND_ID,
    REFERENCES_FIND_ID,
    SYMBOLS_OUTLINE_ID,
    SYMBOLS_SEARCH_ID,
    DEBUG_START_ID,
    DEBUG_STOP_ID,
    DEBUG_BREAKPOINT_SET_ID,
    DEBUG_CONTINUE_ID,
    DEBUG_PAUSE_ID,
    DEBUG_STEP_OVER_ID,
    DEBUG_STEP_INTO_ID,
    DEBUG_STEP_OUT_ID,
    DEBUG_STACK_ID,
    DEBUG_SCOPES_ID,
];

pub const fn is_automation_definition_action(action_id: &str) -> bool {
    matches!(action_id, AUTOMATION_CREATE_ID | AUTOMATION_UPDATE_ID | AUTOMATION_ENABLE_ID | AUTOMATION_DISABLE_ID)
}

/// Internal managed provider dispatch action. Deliberately not a model tool.
pub const fn is_provider_inference_action(action_id: &str) -> bool {
    matches!(action_id, PROVIDERS_INFER_ID)
}

/// Per-operation LSP/DAP effects on a HostKernel-minted process. These actions
/// still require fresh Guard admission, but their process/profile pins come from
/// the retained HostProcessRef rather than a caller-supplied executable.
pub fn is_protocol_io_action(action_id: &str) -> bool {
    PROTOCOL_IO_CAPABILITY_IDS.contains(&action_id)
}

/// Direct workspace-code grants cover only typed, read-only protocol queries.
/// Process lifecycle, document synchronization, debugger control, mutation
/// proposals, and server callbacks still require an exact approval.
pub fn is_direct_grant_read_protocol_action(action_id: &str) -> bool {
    matches!(
        action_id,
        LANGUAGE_DIAGNOSTICS_ID
            | DEFINITIONS_FIND_ID
            | REFERENCES_FIND_ID
            | SYMBOLS_OUTLINE_ID
            | SYMBOLS_SEARCH_ID
            | DEBUG_STACK_ID
            | DEBUG_SCOPES_ID
    )
}

/// Grant eligibility is method-level, not just capability-level: several LSP
/// notifications share `language.diagnostics` but send workspace content to a
/// process and therefore must not inherit a read-query grant.
pub fn is_direct_grant_read_protocol_operation(
    operation: &crate::protocol::ExecutionProtocolOperationV1,
) -> bool {
    use crate::protocol::ExecutionProtocolOperationV1;
    match operation {
        ExecutionProtocolOperationV1::Lsp(operation) => matches!(
            operation.method.as_str(),
            "textDocument/diagnostic"
                | "workspace/diagnostic"
                | "textDocument/definition"
                | "textDocument/references"
                | "textDocument/codeAction"
                | "textDocument/rename"
                | "textDocument/documentSymbol"
                | "workspace/symbol"
        ),
        ExecutionProtocolOperationV1::Dap(operation) => {
            matches!(operation.command.as_str(), "threads" | "stackTrace" | "scopes")
        }
        ExecutionProtocolOperationV1::LspReply(_) => false,
    }
}

/// Canonical actions that start or control a supervised broker process (language server,
/// debug adapter/debuggee, REPL interpreter, CodeMode helper, external editor, or
/// host-registered verifier). Their Guard decision additionally requires a host-resolved
/// trusted executable binding: implementors must never let a caller-supplied executable
/// string establish authority.
pub fn is_broker_process_action(action_id: &str) -> bool {
    matches!(
        action_id,
        LANGUAGE_SERVER_START_ID
            | LANGUAGE_SERVER_STOP_ID
            | DEBUG_START_ID
            | DEBUG_ATTACH_ID
            | DEBUG_STOP_ID
            | DEBUG_EVALUATE_ID
            | REPL_START_ID
            | REPL_EXECUTE_ID
            | REPL_RESET_ID
            | REPL_STOP_ID
            | CODE_MODE_EXECUTE_ID
            | EDITOR_LAUNCH_ID
            | BUILTIN_VERIFIER_ID
            | GIT_WORKTREE_ACQUIRE_ID
            | GIT_WORKTREE_LIST_ID
            | GIT_WORKTREE_RELEASE_ID
    )
}

/// Maps the deliberately small LSP protocol surface to canonical Guard actions.
/// The caller must still present a fresh one-use lease for the returned action,
/// bind it to the retained HostProcessRef/workspace generation, and persist the
/// bounded IO receipt before returning a response. This classifier is not itself
/// authorization and unknown methods always deny.
pub fn language_protocol_capability(method: &str) -> Option<&'static str> {
    match method {
        "initialize" => Some(LANGUAGE_SERVER_START_ID),
        "workspace/didChangeConfiguration" => Some(LANGUAGE_SERVER_START_ID),
        "initialized"
        | "textDocument/didOpen"
        | "textDocument/didChange"
        | "textDocument/didClose"
        | "workspace/didChangeWatchedFiles"
        | "$/cancelRequest" => Some(LANGUAGE_DIAGNOSTICS_ID),
        "shutdown" | "exit" => Some(LANGUAGE_SERVER_STOP_ID),
        "textDocument/diagnostic" => Some(LANGUAGE_DIAGNOSTICS_ID),
        "workspace/diagnostic" => Some(LANGUAGE_DIAGNOSTICS_ID),
        "textDocument/definition" => Some(DEFINITIONS_FIND_ID),
        "textDocument/references" => Some(REFERENCES_FIND_ID),
        // These return proposed edits only. Core must route an accepted proposal
        // through the ordinary versioned files.patch Guard flow.
        "textDocument/codeAction" => Some(LANGUAGE_DIAGNOSTICS_ID),
        "textDocument/rename" => Some(REFERENCES_FIND_ID),
        "textDocument/documentSymbol" => Some(SYMBOLS_OUTLINE_ID),
        "workspace/symbol" => Some(SYMBOLS_SEARCH_ID),
        _ => None,
    }
}

/// LSP message class used to enforce request-ID semantics before encoding a
/// protocol frame. `true` means request/response; `false` means notification.
pub fn language_protocol_is_request(method: &str) -> Option<bool> {
    match method {
        "initialize"
        | "shutdown"
        | "textDocument/diagnostic"
        | "workspace/diagnostic"
        | "textDocument/definition"
        | "textDocument/references"
        | "textDocument/codeAction"
        | "textDocument/rename"
        | "textDocument/documentSymbol"
        | "workspace/symbol" => Some(true),
        "initialized"
        | "workspace/didChangeConfiguration"
        | "workspace/didChangeWatchedFiles"
        | "textDocument/didOpen"
        | "textDocument/didChange"
        | "textDocument/didClose"
        | "$/cancelRequest"
        | "exit" => Some(false),
        _ => None,
    }
}

/// Guard family for the finite server→Core callback surface. Core may answer only
/// after resolving the corresponding exact lease and immutable initialization
/// projection; unsupported requests are rejected before reaching application code.
pub fn language_server_request_capability(method: &str) -> Option<&'static str> {
    match method {
        "workspace/configuration"
        | "client/registerCapability"
        | "client/unregisterCapability" => Some(LANGUAGE_SERVER_START_ID),
        "window/workDoneProgress/create"
        | "workspace/workspaceFolders"
        | "workspace/diagnostic/refresh" => Some(LANGUAGE_DIAGNOSTICS_ID),
        _ => None,
    }
}

/// Only diagnostics publications are projected from server notifications in V1.
/// The event consumer still enforces URI containment, document/read revision and
/// per-event size limits before storing or rendering the data.
pub fn language_server_event_capability(method: &str) -> Option<&'static str> {
    match method {
        "textDocument/publishDiagnostics" => Some(LANGUAGE_DIAGNOSTICS_ID),
        _ => None,
    }
}

/// DAP command allowlist and canonical Guard mapping. `launch` is intentionally
/// absent: an adapter profile cannot authorize a debuggee process. P4 must create
/// that process through a separate Guarded process effect and pass only its minted
/// HostProcessRef into an attach flow.
pub fn debug_protocol_capability(command: &str) -> Option<&'static str> {
    match command {
        "initialize" | "configurationDone" => Some(DEBUG_START_ID),
        "setBreakpoints" | "setFunctionBreakpoints" | "setExceptionBreakpoints" => {
            Some(DEBUG_BREAKPOINT_SET_ID)
        }
        "continue" => Some(DEBUG_CONTINUE_ID),
        "pause" => Some(DEBUG_PAUSE_ID),
        "next" => Some(DEBUG_STEP_OVER_ID),
        "stepIn" => Some(DEBUG_STEP_INTO_ID),
        "stepOut" => Some(DEBUG_STEP_OUT_ID),
        "threads" | "stackTrace" => Some(DEBUG_STACK_ID),
        "scopes" => Some(DEBUG_SCOPES_ID),
        "attach" => Some(DEBUG_ATTACH_ID),
        "evaluate" => Some(DEBUG_EVALUATE_ID),
        // `attach` and `evaluate` are accepted only by the strict typed DAP
        // envelope, which binds a HostKernel-minted target and bounded expression.
        // Variables can invoke lazy getters/formatters and remain unavailable.
        "disconnect" | "terminate" => Some(DEBUG_STOP_ID),
        _ => None,
    }
}

/// Actions the policy keeps unavailable to model-originated batches: a model query never
/// controls a language-service or verifier process (§30.14, §33.23). Human-originated user
/// actions may still request them through the normal explicit approval.
fn is_model_control_denied(action_id: &str) -> bool {
    matches!(
        action_id,
        LANGUAGE_SERVER_START_ID | LANGUAGE_SERVER_STOP_ID | BUILTIN_VERIFIER_ID
    )
}

/// Bind authorization to the canonical workspace path and the opened directory inode.
pub fn workspace_binding(root: &Path, device: u64, inode: u64) -> String {
    digest(&[
        b"horizoncode.workspace-binding.v1",
        root.as_os_str().as_encoded_bytes(),
        &device.to_be_bytes(),
        &inode.to_be_bytes(),
    ])
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DecisionKind {
    Ask,
    Deny,
}

/// How an effect was originated. The kind is fixed by the Canonical operation that
/// admitted the effect and is never supplied by a request body, so a model-originated
/// batch cannot present itself as a human-originated user action.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum EffectOriginKindV1 {
    /// Model-originated tool batch, bound to the Session, its turn context, and the
    /// batch/call identifiers.
    SessionBatch,
    /// Human-originated user action, bound to the authenticated principal and an explicit
    /// one-use approval. The host does not own Session identity, so a user action asserts
    /// no Session or turn-context binding.
    UserAction,
    /// RunController-owned managed verification. This origin is host-selected from an
    /// accepted Run and is never supplied by a client; only the built-in verifier action
    /// may use it, with a distinct authenticated reviewer and explicit approval.
    ManagedRun,
    /// HostKernel-owned pre-Task worktree lifecycle, scoped to an authenticated P8
    /// root-coordinator operation. This is never a user/model supplied origin and may
    /// authorize only the three canonical Git worktree broker capabilities.
    ManagedRoot,
}

#[derive(Clone, Copy, Debug)]
pub struct EffectOriginV1<'a> {
    pub kind: EffectOriginKindV1,
    pub session_id: &'a str,
    pub batch_id: &'a str,
    pub call_id: &'a str,
    /// Digest of the opaque P8 root lifecycle operation and current authenticated root
    /// proof. Required only for ManagedRoot; never accepted from RPC request fields.
    pub scope_digest: Option<&'a str>,
}

#[derive(Clone, Copy, Debug)]
pub struct ResourceResolutionV1<'a> {
    pub workspace_root: &'a Path,
    pub workspace_binding: &'a str,
    pub target: &'a Path,
    pub resource: &'a str,
}

/// Host-resolved executable binding for a broker-process action. `requested_path` is what
/// the caller asked to run; `resolved_path`, `digest` and `profile_digest` are resolved by
/// the host from an immutable configured profile and are never supplied by the caller's
/// request body. The Guard only establishes that the binding is complete and consistent;
/// host-side profile configuration is the source of executable trust.
#[derive(Clone, Copy, Debug)]
pub struct ExecutableResolutionV1<'a> {
    pub requested_path: &'a str,
    pub resolved_path: &'a str,
    pub digest: &'a str,
    pub profile_digest: &'a str,
}

#[derive(Clone, Copy, Debug)]
pub struct AuthorizationRequestV1<'a> {
    pub request_id: &'a str,
    pub principal: &'a str,
    pub origin: EffectOriginV1<'a>,
    pub action_id: &'a str,
    /// BLAKE3 digest of the complete proposed arguments, never raw tool content.
    pub argument_digest: &'a str,
    pub turn_context_digest: &'a str,
    pub resource_resolution: ResourceResolutionV1<'a>,
    /// Required for broker-process actions; must be absent for every other action.
    pub executable: Option<ExecutableResolutionV1<'a>>,
    pub policy_snapshot_ids: &'a [&'a str],
    pub requested_guarantees: &'a [&'a str],
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct GuardDecisionV1 {
    pub decision_id: String,
    pub decision: DecisionKind,
    pub policy_digest: String,
    pub resource_digest: String,
    pub normalized_action: String,
    pub reason_code: Option<&'static str>,
}

/// Opaque, per-Attempt ceiling computed by Guard from the accepted Task/Spec,
/// exact Task-pinned AgentProfile revision, and this Guard build's current policy.
/// It establishes an upper bound only; every effect still needs a fresh Guard
/// decision, durable PREPARE, approval, one-use lease and settlement.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EffectiveCapabilityCeilingProofV1 {
    attempt_id: String,
    owner_epoch: u64,
    run_id: String,
    task_id: String,
    accepted_scope_digest: String,
    profile_id: String,
    profile_revision: u64,
    profile_digest: String,
    profile_owner_binding_digest: String,
    profile_permission_digest: String,
    guard_policy_revision: String,
    effective_ceiling_digest: String,
    capabilities: Vec<String>,
}

impl EffectiveCapabilityCeilingProofV1 {
    pub(crate) fn attempt_id(&self) -> &str {
        &self.attempt_id
    }
    pub(crate) fn owner_epoch(&self) -> u64 {
        self.owner_epoch
    }
    pub(crate) fn run_id(&self) -> &str {
        &self.run_id
    }
    pub(crate) fn task_id(&self) -> &str {
        &self.task_id
    }
    pub(crate) fn accepted_scope_digest(&self) -> &str {
        &self.accepted_scope_digest
    }
    pub(crate) fn profile_id(&self) -> &str {
        &self.profile_id
    }
    pub(crate) fn profile_revision(&self) -> u64 {
        self.profile_revision
    }
    pub(crate) fn profile_digest(&self) -> &str {
        &self.profile_digest
    }
    pub(crate) fn profile_owner_binding_digest(&self) -> &str {
        &self.profile_owner_binding_digest
    }
    pub(crate) fn profile_permission_digest(&self) -> &str {
        &self.profile_permission_digest
    }
    pub(crate) fn guard_policy_revision(&self) -> &str {
        &self.guard_policy_revision
    }
    pub(crate) fn effective_ceiling_digest(&self) -> &str {
        &self.effective_ceiling_digest
    }
    pub(crate) fn capabilities(&self) -> &[String] {
        &self.capabilities
    }

    /// Synthetic proof for isolated OwnerLog unit tests only. Production callers
    /// must use `derive_effective_capability_ceiling` after resolving owner proofs.
    #[cfg(test)]
    pub(crate) fn test_fixture(capabilities: Vec<String>) -> Self {
        Self::test_fixture_for(
            "attempt-test",
            1,
            "run-test",
            "task-test",
            &format!("blake3:{}", "a".repeat(64)),
            "profile-test",
            1,
            &format!("blake3:{}", "b".repeat(64)),
            &format!("blake3:{}", "c".repeat(64)),
            capabilities,
        )
    }

    /// Synthetic P2 composition fixture. Only unit tests can create this type;
    /// production admission uses `derive_effective_capability_ceiling`.
    #[cfg(test)]
    pub(crate) fn test_fixture_for(
        attempt_id: &str,
        owner_epoch: u64,
        run_id: &str,
        task_id: &str,
        accepted_scope_digest: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
        profile_permission_digest: &str,
        capabilities: Vec<String>,
    ) -> Self {
        let guard_policy_revision = current_capability_policy_revision();
        let effective_ceiling_digest = effective_capability_ceiling_digest(
            attempt_id,
            owner_epoch,
            run_id,
            task_id,
            accepted_scope_digest,
            profile_id,
            profile_revision,
            profile_digest,
            &crate::agent_profile::ProfileOwnerBindingV1::Builtin.digest(),
            profile_permission_digest,
            &guard_policy_revision,
            &capabilities,
        )
        .expect("test ceiling fixture must have canonical digest inputs");
        Self {
            attempt_id: attempt_id.to_owned(),
            owner_epoch,
            run_id: run_id.to_owned(),
            task_id: task_id.to_owned(),
            accepted_scope_digest: accepted_scope_digest.to_owned(),
            profile_id: profile_id.to_owned(),
            profile_revision,
            profile_digest: profile_digest.to_owned(),
            profile_owner_binding_digest: crate::agent_profile::ProfileOwnerBindingV1::Builtin
                .digest(),
            profile_permission_digest: profile_permission_digest.to_owned(),
            guard_policy_revision,
            effective_ceiling_digest,
            capabilities,
        }
    }

    /// Synthetic owner-bound proof for P2 integration tests. This does not
    /// expose a production mint path; tests use it to prove subject mismatch
    /// denial before any managed effect is prepared.
    #[cfg(test)]
    pub(crate) fn test_fixture_for_owner(
        attempt_id: &str,
        owner_epoch: u64,
        run_id: &str,
        task_id: &str,
        accepted_scope_digest: &str,
        profile_id: &str,
        profile_revision: u64,
        profile_digest: &str,
        profile_owner_binding_digest: &str,
        profile_permission_digest: &str,
        capabilities: Vec<String>,
    ) -> Self {
        let mut proof = Self::test_fixture_for(
            attempt_id,
            owner_epoch,
            run_id,
            task_id,
            accepted_scope_digest,
            profile_id,
            profile_revision,
            profile_digest,
            profile_permission_digest,
            capabilities,
        );
        proof.profile_owner_binding_digest = profile_owner_binding_digest.to_owned();
        proof.effective_ceiling_digest = effective_capability_ceiling_digest(
            &proof.attempt_id,
            proof.owner_epoch,
            &proof.run_id,
            &proof.task_id,
            &proof.accepted_scope_digest,
            &proof.profile_id,
            proof.profile_revision,
            &proof.profile_digest,
            &proof.profile_owner_binding_digest,
            &proof.profile_permission_digest,
            &proof.guard_policy_revision,
            &proof.capabilities,
        )
        .expect("owner-bound test ceiling fixture must have canonical digest inputs");
        proof
    }
}

/// Build the managed Attempt's capability ceiling only from durable accepted
/// Task/Spec facts, the exact profile proof resolved for the Task pin, and the
/// authenticated Attempt admission proof. This is a scope ceiling; the effect
/// path still re-runs `authorize` for each concrete operation.
pub(crate) fn derive_effective_capability_ceiling(
    attempt: &crate::managed_control::AuthenticatedAttemptAdmissionProofV1,
    accepted: &crate::managed_control::AcceptedTaskCapabilityScopeFactsV1,
    profile: &crate::managed_control::RegisteredAgentProfileProofV1,
) -> Result<EffectiveCapabilityCeilingProofV1, &'static str> {
    let Some(pin) = accepted.profile_revision() else {
        return Err("task_profile_pin_missing");
    };
    if !pin.is_valid()
        || attempt.attempt_id().is_empty()
        || attempt.owner_epoch() == 0
        || attempt.run_id() != accepted.run_id()
        || attempt.task_id() != accepted.task_id()
        || pin.profile_id != profile.profile_id()
        || pin.revision != profile.profile_revision()
        || pin.definition_digest != profile.profile_digest()
        || accepted.profile_owner_binding() != Some(profile.owner_binding().digest().as_str())
        || accepted
            .capability_scope()
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || accepted
            .required_capabilities()
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || accepted.required_capabilities().iter().any(|capability| {
            accepted
                .capability_scope()
                .binary_search(capability)
                .is_err()
        })
        || profile
            .capability_ceiling()
            .windows(2)
            .any(|pair| pair[0] >= pair[1])
        || !is_digest(profile.profile_digest())
        || !is_digest(profile.permission_ceiling_digest())
        || !profile.owner_binding().is_valid()
    {
        return Err("managed_capability_proof_mismatch");
    }

    if !profile_owner_matches_authenticated_executor(
        attempt.executor_principal(),
        profile.owner_binding(),
    ) {
        return Err("managed_profile_owner_mismatch");
    }

    let policy_capabilities = guard_supported_managed_capabilities();
    let capabilities = accepted
        .required_capabilities()
        .iter()
        .filter(|capability| {
            profile
                .capability_ceiling()
                .binary_search(capability)
                .is_ok()
                && policy_capabilities.binary_search(capability).is_ok()
        })
        .cloned()
        .collect::<Vec<_>>();
    let accepted_scope_digest = accepted
        .digest()
        .map_err(|_| "managed_capability_digest_failed")?;
    let guard_policy_revision = current_capability_policy_revision();
    let effective_ceiling_digest = effective_capability_ceiling_digest(
        attempt.attempt_id(),
        attempt.owner_epoch(),
        accepted.run_id(),
        accepted.task_id(),
        &accepted_scope_digest,
        profile.profile_id(),
        profile.profile_revision(),
        profile.profile_digest(),
        &profile.owner_binding().digest(),
        profile.permission_ceiling_digest(),
        &guard_policy_revision,
        &capabilities,
    )
    .map_err(|_| "managed_capability_digest_failed")?;

    Ok(EffectiveCapabilityCeilingProofV1 {
        attempt_id: attempt.attempt_id().to_owned(),
        owner_epoch: attempt.owner_epoch(),
        run_id: accepted.run_id().to_owned(),
        task_id: accepted.task_id().to_owned(),
        accepted_scope_digest,
        profile_id: profile.profile_id().to_owned(),
        profile_revision: profile.profile_revision(),
        profile_digest: profile.profile_digest().to_owned(),
        profile_owner_binding_digest: profile.owner_binding().digest(),
        profile_permission_digest: profile.permission_ceiling_digest().to_owned(),
        guard_policy_revision,
        effective_ceiling_digest,
        capabilities,
    })
}

fn profile_owner_matches_authenticated_executor(
    executor_principal: &str,
    owner_binding: &crate::agent_profile::ProfileOwnerBindingV1,
) -> bool {
    match owner_binding {
        crate::agent_profile::ProfileOwnerBindingV1::Builtin => true,
        crate::agent_profile::ProfileOwnerBindingV1::User { .. } => {
            let Some(subject) = executor_principal.strip_prefix("server_auth:") else {
                return false;
            };
            let principal = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
                subject: subject.to_owned(),
            };
            crate::agent_profile::ProfileOwnerBindingV1::from_authenticated_principal(
                "user", &principal,
            )
            .is_some_and(|resolved| &resolved == owner_binding)
        }
    }
}

/// Capabilities currently admitted by Guard for managed effects. Keep this
/// list narrower than the public registry: adding an ID requires a dispatch
/// path and a complete positive/denial/recovery acceptance journey.
fn guard_supported_managed_capabilities() -> Vec<String> {
    [
        BUILTIN_VERIFIER_ID,
        DEBUG_ATTACH_ID,
        DEBUG_EVALUATE_ID,
        DEBUG_START_ID,
        DEBUG_STOP_ID,
        LANGUAGE_SERVER_START_ID,
        LANGUAGE_SERVER_STOP_ID,
        REPL_EXECUTE_ID,
        REPL_RESET_ID,
        REPL_START_ID,
        REPL_STOP_ID,
    ]
    .into_iter()
    .map(str::to_owned)
    .collect()
}

fn current_capability_policy_revision() -> String {
    let policy = crate::messagepack::Value::Map(std::collections::BTreeMap::from([
        (
            "capabilities".to_owned(),
            crate::messagepack::Value::Array(
                guard_supported_managed_capabilities()
                    .into_iter()
                    .map(crate::messagepack::Value::String)
                    .collect(),
            ),
        ),
        (
            "brokerPolicy".to_owned(),
            crate::messagepack::Value::String(digest(&[BROKER_POLICY_BYTES])),
        ),
        (
            "readPolicy".to_owned(),
            crate::messagepack::Value::String(digest(&[READ_POLICY_BYTES])),
        ),
        (
            "writePolicy".to_owned(),
            crate::messagepack::Value::String(digest(&[POLICY_BYTES])),
        ),
        (
            "schemaVersion".to_owned(),
            crate::messagepack::Value::Unsigned(1),
        ),
    ]));
    let encoded = crate::messagepack::encode(&policy, crate::messagepack::FRAME_LIMITS)
        .expect("bounded Guard policy map must encode");
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.guard-effective-capability-policy.v1\0");
    hasher.update(&encoded);
    format!("blake3:{}", hasher.finalize().to_hex())
}

/// Stable direct filesystem Guard backend identity used only for DirectSessionGrant
/// pinning. This names the existing handle-relative workspace effect boundary; it
/// makes no claim that arbitrary child processes are OS confined.
pub(crate) const DIRECT_SESSION_EFFECT_BACKEND_ID: &str = "horizoncode.effect-host.workspace-root.v1";

/// Canonical policy digest for grant issuance and exact-pin lookup. The grant
/// schema stores the digest, not a caller-controlled numeric revision.
pub(crate) fn direct_session_policy_digest() -> String {
    current_capability_policy_revision()
}

/// Digest the exact Guarded workspace-root guarantees that ordinary direct
/// read/edit operations currently enforce. Process/build/test actions remain
/// independently gated by their own OS-enforced backend evidence.
pub(crate) fn direct_session_guarantee_set_digest() -> String {
    let mut guarantees = GUARANTEES.to_vec();
    guarantees.sort_unstable();
    let value = crate::messagepack::Value::Array(
        guarantees.into_iter().map(|value| crate::messagepack::Value::String(value.to_owned())).collect(),
    );
    let encoded = crate::messagepack::encode(&value, crate::messagepack::FRAME_LIMITS)
        .expect("small Guard guarantee set must encode");
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.direct-session-guarantees.v1\0");
    hasher.update(&encoded);
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn effective_capability_ceiling_digest(
    attempt_id: &str,
    owner_epoch: u64,
    run_id: &str,
    task_id: &str,
    accepted_scope_digest: &str,
    profile_id: &str,
    profile_revision: u64,
    profile_digest: &str,
    profile_owner_binding_digest: &str,
    profile_permission_digest: &str,
    guard_policy_revision: &str,
    capabilities: &[String],
) -> Result<String, crate::messagepack::MessagePackError> {
    use crate::messagepack::Value;
    let value = Value::Map(std::collections::BTreeMap::from([
        (
            "acceptedScopeDigest".into(),
            Value::String(accepted_scope_digest.into()),
        ),
        ("attemptID".into(), Value::String(attempt_id.into())),
        (
            "capabilities".into(),
            Value::Array(capabilities.iter().cloned().map(Value::String).collect()),
        ),
        (
            "guardPolicyRevision".into(),
            Value::String(guard_policy_revision.into()),
        ),
        ("ownerEpoch".into(), Value::String(owner_epoch.to_string())),
        ("profileDigest".into(), Value::String(profile_digest.into())),
        ("profileID".into(), Value::String(profile_id.into())),
        (
            "profileOwnerBindingDigest".into(),
            Value::String(profile_owner_binding_digest.into()),
        ),
        (
            "profilePermissionDigest".into(),
            Value::String(profile_permission_digest.into()),
        ),
        (
            "profileRevision".into(),
            Value::String(profile_revision.to_string()),
        ),
        ("runID".into(), Value::String(run_id.into())),
        ("schemaVersion".into(), Value::Unsigned(1)),
        ("taskID".into(), Value::String(task_id.into())),
    ]));
    let encoded = crate::messagepack::encode(&value, crate::messagepack::FRAME_LIMITS)?;
    let mut preimage = b"horizoncode.effective-capability-ceiling.v1\0".to_vec();
    preimage.extend_from_slice(&encoded);
    Ok(format!("blake3:{}", blake3::hash(&preimage).to_hex()))
}

/// Guard proof for a bounded read-only RepoIntel root. It grants no write, process,
/// network, or reusable source authority; HostKernel binds it to the authenticated
/// Session/Location/principal and query before invoking the in-process adapter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct RepoReadScopeV1 {
    principal_binding: String,
    canonical_root: std::path::PathBuf,
    relative_root: String,
    workspace_binding: String,
    source_generation: String,
    policy_digest: String,
}

impl RepoReadScopeV1 {
    pub(crate) fn principal_binding(&self) -> &str {
        &self.principal_binding
    }
    pub(crate) fn canonical_root(&self) -> &Path {
        &self.canonical_root
    }

    pub(crate) fn relative_root(&self) -> &str {
        &self.relative_root
    }

    pub(crate) fn workspace_binding(&self) -> &str {
        &self.workspace_binding
    }

    pub(crate) fn source_generation(&self) -> &str {
        &self.source_generation
    }

    pub(crate) fn policy_digest(&self) -> &str {
        &self.policy_digest
    }
}

/// Validate a read-only repository subroot and bind it to the host-measured current
/// source generation. The caller must supply the binding and generation from trusted
/// HostKernel observations; values from the query DTO cannot satisfy this check.
pub(crate) fn authorize_repo_read_scope(
    authenticated_principal: &crate::protocol::AuthenticatedPrincipalV1,
    registered_principal_binding: Option<&str>,
    capability_id: &str,
    registered_root: &Path,
    relative_root: &str,
    workspace_binding_value: &str,
    expected_source_generation: &str,
    current_source_generation: &str,
) -> Result<RepoReadScopeV1, &'static str> {
    const MAX_RELATIVE_ROOT_BYTES: usize = 4096;
    let subject = match authenticated_principal {
        crate::protocol::AuthenticatedPrincipalV1::ServerAuth { subject }
            if !subject.is_empty()
                && subject.len() <= 256
                && !subject.chars().any(char::is_control) =>
        {
            subject.as_str()
        }
        _ => return Err("invalid_read_principal"),
    };
    if capability_id != FILES_READ_ID {
        return Err("unsupported_read_capability");
    }
    let principal_binding = location_principal_binding(subject);
    if registered_principal_binding != Some(principal_binding.as_str()) {
        return Err("location_owner_mismatch");
    }
    if relative_root.is_empty()
        || relative_root.len() > MAX_RELATIVE_ROOT_BYTES
        || relative_root.bytes().any(|byte| byte.is_ascii_control())
        || !is_digest(workspace_binding_value)
        || !is_digest(expected_source_generation)
        || !is_digest(current_source_generation)
    {
        return Err("invalid_read_scope");
    }
    if expected_source_generation != current_source_generation {
        return Err("stale_read_scope");
    }
    let root_metadata =
        std::fs::symlink_metadata(registered_root).map_err(|_| "read_root_unavailable")?;
    if root_metadata.file_type().is_symlink() || !root_metadata.is_dir() {
        return Err("invalid_read_root");
    }
    let canonical_root =
        std::fs::canonicalize(registered_root).map_err(|_| "read_root_unavailable")?;
    if canonical_root != registered_root {
        return Err("invalid_read_root");
    }
    let relative_path = if relative_root == "." {
        Path::new("")
    } else {
        Path::new(relative_root)
    };
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err("invalid_read_scope");
    }
    let mut target = canonical_root.clone();
    if relative_root != "." {
        for component in relative_path.components() {
            let Component::Normal(name) = component else {
                return Err("invalid_read_scope");
            };
            target.push(name);
            let metadata =
                std::fs::symlink_metadata(&target).map_err(|_| "read_target_unavailable")?;
            if metadata.file_type().is_symlink() || !metadata.is_dir() {
                return Err("invalid_read_scope");
            }
        }
    }
    Ok(RepoReadScopeV1 {
        principal_binding,
        canonical_root: target,
        relative_root: relative_root.to_owned(),
        workspace_binding: workspace_binding_value.to_owned(),
        source_generation: current_source_generation.to_owned(),
        policy_digest: digest(&[READ_POLICY_BYTES]),
    })
}

pub(crate) fn location_principal_binding(subject: &str) -> String {
    let mut hasher = blake3::Hasher::new();
    hasher.update(b"horizoncode.location-owner-binding.v1\0");
    hasher.update(&(subject.len() as u64).to_be_bytes());
    hasher.update(subject.as_bytes());
    format!("blake3:{}", hasher.finalize().to_hex())
}

/// Stable host policy facts used to build a bounded consent projection. These values come
/// only from the canonical Guard policy table; they are never decoded from RPC input.
pub fn approval_policy(action_id: &str) -> Option<(&'static str, String, Vec<&'static str>)> {
    if !crate::managed_control::canonical_capability_id_is_registered(action_id) {
        return None;
    }
    let (policy_id, policy_bytes, guarantees) = if action_id == EDITOR_LAUNCH_ID {
        (EDITOR_PROCESS_POLICY_ID, EDITOR_PROCESS_POLICY_BYTES, EDITOR_PROCESS_GUARANTEES)
    } else if is_protocol_io_action(action_id) {
        (PROTOCOL_IO_POLICY_ID, PROTOCOL_IO_POLICY_BYTES, PROTOCOL_IO_GUARANTEES)
    } else if action_id == CODE_MODE_EXECUTE_ID {
        (CODE_MODE_POLICY_ID, CODE_MODE_POLICY_BYTES, CODE_MODE_GUARANTEES)
    } else if is_broker_process_action(action_id) {
        (
            BROKER_PROCESS_POLICY_ID,
            BROKER_POLICY_BYTES,
            BROKER_GUARANTEES,
        )
    } else if action_id == WEB_SEARCH_ID {
        (OUTBOUND_HTTP_POLICY_ID, HTTP_POLICY_BYTES, HTTP_GUARANTEES)
    } else if is_provider_inference_action(action_id) {
        (PROVIDER_INFERENCE_POLICY_ID, PROVIDER_INFERENCE_POLICY_BYTES, PROVIDER_INFERENCE_GUARANTEES)
    } else if action_id == AGENTS_MESSAGE_ID {
        (AGENT_MESSAGE_POLICY_ID, AGENT_MESSAGE_POLICY_BYTES, AGENT_MESSAGE_GUARANTEES)
    } else if is_automation_definition_action(action_id) {
        (AUTOMATION_POLICY_ID, AUTOMATION_POLICY_BYTES, AUTOMATION_GUARANTEES)
    } else if action_id == FILES_WRITE_ID
        || action_id == FILES_PATCH_ID
        || action_id == TERMINAL_RUN_ID
        || action_id == TERMINAL_START_ID
    {
        (WORKSPACE_WRITE_POLICY_ID, POLICY_BYTES, GUARANTEES)
    } else {
        return None;
    };
    Some((policy_id, digest(&[policy_bytes]), guarantees.to_vec()))
}

pub fn authorize(request: &AuthorizationRequestV1<'_>, decision_id: &str) -> GuardDecisionV1 {
    let protocol_io_action = is_protocol_io_action(request.action_id);
    let broker_action = is_broker_process_action(request.action_id) && !protocol_io_action;
    let code_mode_action = request.action_id == CODE_MODE_EXECUTE_ID;
    let editor_action = request.action_id == EDITOR_LAUNCH_ID;
    let http_action = request.action_id == WEB_SEARCH_ID;
    let provider_inference_action = is_provider_inference_action(request.action_id);
    let agent_message_action = request.action_id == AGENTS_MESSAGE_ID;
    let automation_action = is_automation_definition_action(request.action_id);
    let (policy_bytes, expected_policy_id, expected_guarantees) = if agent_message_action {
        (AGENT_MESSAGE_POLICY_BYTES, AGENT_MESSAGE_POLICY_ID, AGENT_MESSAGE_GUARANTEES)
    } else if protocol_io_action {
        (PROTOCOL_IO_POLICY_BYTES, PROTOCOL_IO_POLICY_ID, PROTOCOL_IO_GUARANTEES)
    } else if editor_action {
        (EDITOR_PROCESS_POLICY_BYTES, EDITOR_PROCESS_POLICY_ID, EDITOR_PROCESS_GUARANTEES)
    } else if code_mode_action {
        (CODE_MODE_POLICY_BYTES, CODE_MODE_POLICY_ID, CODE_MODE_GUARANTEES)
    } else if broker_action {
        (
            BROKER_POLICY_BYTES,
            BROKER_PROCESS_POLICY_ID,
            BROKER_GUARANTEES,
        )
    } else if http_action {
        (HTTP_POLICY_BYTES, OUTBOUND_HTTP_POLICY_ID, HTTP_GUARANTEES)
    } else if provider_inference_action {
        (PROVIDER_INFERENCE_POLICY_BYTES, PROVIDER_INFERENCE_POLICY_ID, PROVIDER_INFERENCE_GUARANTEES)
    } else if automation_action {
        (AUTOMATION_POLICY_BYTES, AUTOMATION_POLICY_ID, AUTOMATION_GUARANTEES)
    } else {
        (POLICY_BYTES, WORKSPACE_WRITE_POLICY_ID, GUARANTEES)
    };
    let policy_digest = digest(&[policy_bytes]);
    let normalized_action = request.action_id.to_owned();
    // Process, HTTP and mailbox actions use the registered workspace root as their
    // resource boundary (`.`). Filesystem actions keep the stricter non-empty relative
    // path rule; mailbox payload authority is separately pinned to child/profile facts.
    let terminal_like = request.action_id == TERMINAL_RUN_ID
        || request.action_id == TERMINAL_START_ID
        || code_mode_action
        || editor_action
        || automation_action
        || http_action
        || provider_inference_action
        || agent_message_action
        || protocol_io_action
        || broker_action;
    let resolved_relative = if terminal_like
        && request.resource_resolution.target == request.resource_resolution.workspace_root
    {
        Some(".".to_owned())
    } else {
        request
            .resource_resolution
            .target
            .strip_prefix(request.resource_resolution.workspace_root)
            .ok()
            .filter(|relative| !relative.as_os_str().is_empty())
            .filter(|relative| {
                relative
                    .components()
                    .all(|component| matches!(component, Component::Normal(_)))
            })
            .and_then(Path::to_str)
            .map(|relative| relative.replace('\\', "/"))
    };
    let resource_digest = resource_digest(request);
    let supported_action = crate::managed_control::canonical_capability_id_is_registered(request.action_id)
        && (request.action_id == FILES_WRITE_ID
        || request.action_id == FILES_PATCH_ID
        || request.action_id == TERMINAL_RUN_ID
        || request.action_id == TERMINAL_START_ID
        || code_mode_action
        || editor_action
        || http_action
        || provider_inference_action
        || agent_message_action
        || automation_action
        || protocol_io_action
        || broker_action);
    // A Session label is optional for actions that a human can originate directly
    // (`terminal.run`/`terminal.start`, and broker process control from a user action);
    // their authority then comes from the principal plus explicit approval. A
    // model-originated batch still has to carry its Session binding, which is enforced by
    // `origin_binding_missing` below.
    let session_optional = request.action_id == TERMINAL_RUN_ID
        || request.action_id == TERMINAL_START_ID
        || provider_inference_action
        || automation_action
        || (broker_action
            && matches!(
                request.origin.kind,
                EffectOriginKindV1::UserAction | EffectOriginKindV1::ManagedRun
                    | EffectOriginKindV1::ManagedRoot
            ));
    let session_missing = request.origin.session_id.is_empty() && !session_optional;
    // The origin kind decides which binding the effect must carry. A model-originated
    // batch always requires its Session and turn-context binding, including for
    // `terminal.run`; a human-originated user action requires the authenticated principal
    // and its explicit approval instead, and must not carry a turn context.
    let origin_binding_missing = match request.origin.kind {
        EffectOriginKindV1::SessionBatch => {
            request.origin.session_id.is_empty() || !is_sha256_digest(request.turn_context_digest)
        }
        EffectOriginKindV1::UserAction => !request.turn_context_digest.is_empty(),
        EffectOriginKindV1::ManagedRun if provider_inference_action => {
            request.origin.session_id.is_empty() || !request.turn_context_digest.is_empty()
                || request.origin.scope_digest.is_none_or(|digest| !is_digest(digest))
        }
        EffectOriginKindV1::ManagedRun => {
            !request.origin.session_id.is_empty() || !request.turn_context_digest.is_empty()
        }
        EffectOriginKindV1::ManagedRoot => {
            request.origin.session_id.is_empty()
                || !request.turn_context_digest.is_empty()
                || request.origin.scope_digest.is_none_or(|digest| !is_digest(digest))
                || !matches!(request.action_id,
                    GIT_WORKTREE_ACQUIRE_ID | GIT_WORKTREE_LIST_ID | GIT_WORKTREE_RELEASE_ID)
        }
    };
    let executable_reason = executable_reason(request, broker_action);
    let reason_code = if !supported_action {
        Some("unsupported_action")
    } else if provider_inference_action && request.origin.kind != EffectOriginKindV1::ManagedRun {
        Some("provider_inference_requires_managed_attempt")
    } else if request.origin.kind == EffectOriginKindV1::UserAction
        && request.action_id != TERMINAL_RUN_ID
        && request.action_id != TERMINAL_START_ID
        && !agent_message_action
        && !automation_action
        && !protocol_io_action
        && !broker_action
    {
        Some("unsupported_user_action")
    } else if request.origin.kind == EffectOriginKindV1::ManagedRun
        && !provider_inference_action
        && !broker_action
        && !protocol_io_action
    {
        Some("unsupported_managed_run_action")
    } else if request.origin.kind == EffectOriginKindV1::ManagedRoot
        && (!broker_action || !matches!(request.action_id,
            GIT_WORKTREE_ACQUIRE_ID | GIT_WORKTREE_LIST_ID | GIT_WORKTREE_RELEASE_ID))
    {
        Some("unsupported_managed_root_action")
    } else if automation_action && request.origin.kind != EffectOriginKindV1::UserAction {
        Some("automation_requires_authenticated_user_action")
    } else if broker_action
        && request.origin.kind == EffectOriginKindV1::SessionBatch
        && is_model_control_denied(request.action_id)
    {
        // §30.14: a model query never controls a language-service process.
        Some("model_process_control_denied")
    } else if let Some(reason) = executable_reason {
        Some(reason)
    } else if request.principal.is_empty()
        || request.principal.chars().any(char::is_control)
        || session_missing
        || origin_binding_missing
        || request.request_id.is_empty()
        || request.request_id != request.origin.batch_id
        || request.origin.batch_id.is_empty()
        || request.origin.call_id.is_empty()
    {
        Some("invalid_principal_or_origin")
    } else if !is_digest(request.argument_digest)
        || !is_digest(request.resource_resolution.workspace_binding)
    {
        Some("invalid_effect_digest")
    } else if resolved_relative.as_deref() != Some(request.resource_resolution.resource) {
        Some("resource_outside_workspace")
    } else if request.policy_snapshot_ids != [expected_policy_id]
        || request.requested_guarantees != expected_guarantees
    {
        Some("unsupported_policy_or_guarantee")
    } else {
        None
    };

    GuardDecisionV1 {
        decision_id: decision_id.to_owned(),
        decision: if reason_code.is_some() {
            DecisionKind::Deny
        } else {
            DecisionKind::Ask
        },
        policy_digest,
        resource_digest,
        normalized_action,
        reason_code,
    }
}

/// A broker-process action must carry a complete host-resolved executable binding whose
/// requested path is exactly the configured resolved path. Every other action must carry
/// no executable binding at all, so an unrelated effect cannot smuggle process trust.
fn executable_reason(
    request: &AuthorizationRequestV1<'_>,
    broker_action: bool,
) -> Option<&'static str> {
    match (broker_action, request.executable) {
        (true, None) => Some("executable_unverified"),
        (false, Some(_)) => Some("unexpected_executable_binding"),
        (false, None) => None,
        (
            true,
            Some(ExecutableResolutionV1 {
                requested_path,
                resolved_path,
                digest,
                profile_digest,
            }),
        ) => {
            if requested_path.is_empty()
                || requested_path != resolved_path
                || resolved_path.is_empty()
                || !Path::new(resolved_path).is_absolute()
                || resolved_path.contains('\0')
            {
                return Some("untrusted_executable");
            }
            if !is_digest(digest) || !is_digest(profile_digest) {
                return Some("invalid_executable_digest");
            }
            None
        }
    }
}

/// Digest the authorization decision with every input that can change its authority.
pub fn intent_digest(request: &AuthorizationRequestV1<'_>, decision: &GuardDecisionV1) -> String {
    let mut hasher = blake3::Hasher::new();
    let decision_kind = match decision.decision {
        DecisionKind::Ask => b"ASK".as_slice(),
        DecisionKind::Deny => b"DENY".as_slice(),
    };
    let reason_code = decision.reason_code.unwrap_or("");
    let origin_kind = match request.origin.kind {
        EffectOriginKindV1::SessionBatch => b"session_batch".as_slice(),
        EffectOriginKindV1::UserAction => b"user_action".as_slice(),
        EffectOriginKindV1::ManagedRun => b"managed_run".as_slice(),
        EffectOriginKindV1::ManagedRoot => b"managed_root".as_slice(),
    };
    for value in [
        request.request_id.as_bytes(),
        request.principal.as_bytes(),
        origin_kind,
        request.origin.session_id.as_bytes(),
        request.origin.batch_id.as_bytes(),
        request.origin.call_id.as_bytes(),
        request.origin.scope_digest.unwrap_or("").as_bytes(),
        request.action_id.as_bytes(),
        request.argument_digest.as_bytes(),
        request
            .resource_resolution
            .workspace_root
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.workspace_binding.as_bytes(),
        request
            .resource_resolution
            .target
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.resource.as_bytes(),
        decision.decision_id.as_bytes(),
        decision.policy_digest.as_bytes(),
        decision.resource_digest.as_bytes(),
        decision_kind,
        request.turn_context_digest.as_bytes(),
        reason_code.as_bytes(),
    ] {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    // The executable binding is part of the decision authority: a mutated resolved path,
    // executable digest or trusted-profile digest must never reuse an existing approval.
    match request.executable {
        None => {
            hasher.update(&0_u64.to_be_bytes());
        }
        Some(executable) => {
            for value in [
                executable.requested_path.as_bytes(),
                executable.resolved_path.as_bytes(),
                executable.digest.as_bytes(),
                executable.profile_digest.as_bytes(),
            ] {
                hasher.update(&(value.len() as u64).to_be_bytes());
                hasher.update(value);
            }
        }
    }
    for value in request
        .policy_snapshot_ids
        .iter()
        .chain(request.requested_guarantees)
    {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value.as_bytes());
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

/// Bind the authenticated managed Attempt envelope to the normal Guard decision. The
/// scope is an additional narrowing constraint, never a source of capability authority.
/// `None` preserves the existing direct-session and user-action contract.
pub fn intent_digest_with_managed_scope(
    request: &AuthorizationRequestV1<'_>,
    decision: &GuardDecisionV1,
    managed_scope_digest: Option<&str>,
) -> String {
    let intent = intent_digest(request, decision);
    match managed_scope_digest {
        None => intent,
        Some(scope_digest) => digest(&[
            b"horizoncode.guard.managed-attempt-binding.v1",
            intent.as_bytes(),
            scope_digest.as_bytes(),
        ]),
    }
}

/// Bind the full tool argument tuple without storing the raw content.
pub fn argument_digest(
    session_id: &str,
    batch_id: &str,
    call_id: &str,
    action_id: &str,
    requested_path: &str,
    content_digest: &str,
) -> String {
    digest(&[
        session_id.as_bytes(),
        batch_id.as_bytes(),
        call_id.as_bytes(),
        action_id.as_bytes(),
        requested_path.as_bytes(),
        content_digest.as_bytes(),
    ])
}

fn resource_digest(request: &AuthorizationRequestV1<'_>) -> String {
    digest(&[
        request.principal.as_bytes(),
        request.origin.session_id.as_bytes(),
        request.action_id.as_bytes(),
        request
            .resource_resolution
            .workspace_root
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.workspace_binding.as_bytes(),
        request
            .resource_resolution
            .target
            .as_os_str()
            .as_encoded_bytes(),
        request.resource_resolution.resource.as_bytes(),
    ])
}

fn digest(values: &[&[u8]]) -> String {
    let mut hasher = blake3::Hasher::new();
    for value in values {
        hasher.update(&(value.len() as u64).to_be_bytes());
        hasher.update(value);
    }
    format!("blake3:{}", hasher.finalize().to_hex())
}

fn is_digest(value: &str) -> bool {
    value.strip_prefix("blake3:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}
pub(crate) fn is_sha256_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn external_editor_is_a_distinct_registered_user_process_effect() {
        assert!(crate::managed_control::canonical_capability_id_is_registered(
            EDITOR_LAUNCH_ID
        ));
        assert!(is_broker_process_action(EDITOR_LAUNCH_ID));
        let (policy_id, policy_digest, guarantees) =
            approval_policy(EDITOR_LAUNCH_ID).expect("canonical editor policy");
        assert_eq!(policy_id, EDITOR_PROCESS_POLICY_ID);
        assert!(is_digest(&policy_digest));
        for required in [
            "authenticated_root_session_user_action",
            "trusted_profile_revision_and_executable",
            "literal_bounded_argv_and_sanitized_environment",
            "permission_mode_bound",
            "process_tree_containment",
            "workspace_write_fence",
            "one_use",
        ] {
            assert!(guarantees.contains(&required), "missing {required}");
        }
    }

    #[test]
    fn direct_workspace_grants_cover_only_read_only_protocol_queries() {
        for action in [
            LANGUAGE_DIAGNOSTICS_ID,
            DEFINITIONS_FIND_ID,
            REFERENCES_FIND_ID,
            SYMBOLS_OUTLINE_ID,
            SYMBOLS_SEARCH_ID,
            DEBUG_STACK_ID,
            DEBUG_SCOPES_ID,
        ] {
            assert!(is_direct_grant_read_protocol_action(action), "{action}");
        }
        for action in [
            LANGUAGE_SERVER_START_ID,
            LANGUAGE_SERVER_STOP_ID,
            DEBUG_START_ID,
            DEBUG_ATTACH_ID,
            DEBUG_EVALUATE_ID,
            DEBUG_CONTINUE_ID,
            DEBUG_BREAKPOINT_SET_ID,
            FILES_PATCH_ID,
            "unknown",
        ] {
            assert!(!is_direct_grant_read_protocol_action(action), "{action}");
        }
    }

    #[test]
    fn direct_workspace_grants_do_not_cover_lsp_notifications_or_callbacks() {
        use crate::protocol::{
            DebugProtocolOperationV1, ExecutionProtocolOperationV1,
            LanguageProtocolOperationV1, LanguageProtocolReplyV1, Value,
        };
        let lsp = |method: &str| ExecutionProtocolOperationV1::Lsp(LanguageProtocolOperationV1 {
            request_sequence: 1,
            method: method.to_owned(),
            request_id: Some(Value::Unsigned(1)),
            params: Value::Map(std::collections::BTreeMap::new()),
        });
        for method in ["textDocument/definition", "textDocument/diagnostic", "workspace/symbol"] {
            assert!(is_direct_grant_read_protocol_operation(&lsp(method)));
        }
        for method in ["textDocument/didOpen", "textDocument/didChange", "workspace/didChangeWatchedFiles", "initialized"] {
            assert!(!is_direct_grant_read_protocol_operation(&lsp(method)));
        }
        let callback = ExecutionProtocolOperationV1::LspReply(LanguageProtocolReplyV1 {
            request_sequence: 1,
            server_request_id: Value::Unsigned(1),
            method: "workspace/configuration".to_owned(),
            result: Value::Array(Vec::new()),
        });
        assert!(!is_direct_grant_read_protocol_operation(&callback));
        for command in ["threads", "stackTrace", "scopes"] {
            let operation = ExecutionProtocolOperationV1::Dap(DebugProtocolOperationV1 {
                request_sequence: 1,
                request_id: 1,
                command: command.to_owned(),
                arguments: Value::Map(std::collections::BTreeMap::new()),
            });
            assert!(is_direct_grant_read_protocol_operation(&operation));
        }
        let continue_operation = ExecutionProtocolOperationV1::Dap(DebugProtocolOperationV1 {
            request_sequence: 1,
            request_id: 1,
            command: "continue".to_owned(),
            arguments: Value::Map(std::collections::BTreeMap::new()),
        });
        assert!(!is_direct_grant_read_protocol_operation(&continue_operation));
    }

    const ARGUMENT_DIGEST: &str =
        "blake3:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const WORKSPACE_BINDING: &str =
        "blake3:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const TURN_CONTEXT_DIGEST: &str =
        "sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    fn request<'a>(
        root: &'a Path,
        target: &'a Path,
        resource: &'a str,
    ) -> AuthorizationRequestV1<'a> {
        AuthorizationRequestV1 {
            request_id: "batch_1",
            principal: "ses_1",
            origin: EffectOriginV1 {
                kind: EffectOriginKindV1::SessionBatch,
                session_id: "ses_1",
                batch_id: "batch_1",
                call_id: "call_1",
                scope_digest: None,
            },
            action_id: FILES_WRITE_ID,
            argument_digest: ARGUMENT_DIGEST,
            turn_context_digest: TURN_CONTEXT_DIGEST,
            resource_resolution: ResourceResolutionV1 {
                workspace_root: root,
                workspace_binding: WORKSPACE_BINDING,
                target,
                resource,
            },
            executable: None,
            policy_snapshot_ids: &[WORKSPACE_WRITE_POLICY_ID],
            requested_guarantees: GUARANTEES,
        }
    }

    const EXECUTABLE_DIGEST: &str =
        "blake3:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    const PROFILE_DIGEST: &str =
        "blake3:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";

    fn broker_request<'a>(
        root: &'a Path,
        action_id: &'a str,
        executable: Option<ExecutableResolutionV1<'a>>,
    ) -> AuthorizationRequestV1<'a> {
        AuthorizationRequestV1 {
            request_id: "batch_1",
            principal: "ses_1",
            origin: EffectOriginV1 {
                kind: EffectOriginKindV1::SessionBatch,
                session_id: "ses_1",
                batch_id: "batch_1",
                call_id: "call_1",
                scope_digest: None,
            },
            action_id,
            argument_digest: ARGUMENT_DIGEST,
            turn_context_digest: TURN_CONTEXT_DIGEST,
            resource_resolution: ResourceResolutionV1 {
                workspace_root: root,
                workspace_binding: WORKSPACE_BINDING,
                target: root,
                resource: ".",
            },
            executable,
            policy_snapshot_ids: &[BROKER_PROCESS_POLICY_ID],
            requested_guarantees: BROKER_GUARANTEES,
        }
    }

    fn trusted_executable<'a>(path: &'a str) -> ExecutableResolutionV1<'a> {
        ExecutableResolutionV1 {
            requested_path: path,
            resolved_path: path,
            digest: EXECUTABLE_DIGEST,
            profile_digest: PROFILE_DIGEST,
        }
    }

    #[test]
    fn asks_for_one_bound_workspace_write_and_denies_outside_resources() {
        let root = Path::new("/workspace");
        let target = Path::new("/workspace/file.txt");
        let authorized_request = request(root, target, "file.txt");
        let decision = authorize(&authorized_request, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.normalized_action, FILES_WRITE_ID);
        assert_eq!(decision.reason_code, None);

        let outside = request(root, Path::new("/outside/file.txt"), "file.txt");
        let decision = authorize(&outside, "challenge_2");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("resource_outside_workspace"));
    }

    #[test]
    fn authorization_digest_changes_when_a_bound_argument_changes() {
        let root = Path::new("/workspace");
        let first = request(root, Path::new("/workspace/one.txt"), "one.txt");
        let first_decision = authorize(&first, "challenge_1");
        let first_digest = intent_digest(&first, &first_decision);

        let second = request(root, Path::new("/workspace/two.txt"), "two.txt");
        let second_decision = authorize(&second, "challenge_1");
        assert_ne!(first_digest, intent_digest(&second, &second_decision));

        let mut changed_context = first;
        changed_context.turn_context_digest =
            "sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
        let context_decision = authorize(&changed_context, "challenge_1");
        assert_ne!(
            first_digest,
            intent_digest(&changed_context, &context_decision)
        );
    }
    #[test]
    fn authenticated_principal_is_independent_of_session_and_bound_to_decision() {
        let root = Path::new("/workspace");
        let mut request = request(root, Path::new("/workspace/file.txt"), "file.txt");
        request.principal = "host_os_uid:1000";
        let decision = authorize(&request, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);
        let first = intent_digest(&request, &decision);

        request.principal = "server_auth:alice";
        let other_decision = authorize(&request, "challenge_1");
        assert_eq!(other_decision.decision, DecisionKind::Ask);
        assert_ne!(first, intent_digest(&request, &other_decision));
    }

    #[test]
    fn session_batch_terminal_run_requires_its_session_and_turn_context_binding() {
        let root = Path::new("/workspace");
        let mut bound = request(root, root, ".");
        bound.action_id = TERMINAL_RUN_ID;
        let decision = authorize(&bound, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        let mut sessionless = bound;
        sessionless.origin.session_id = "";
        let decision = authorize(&sessionless, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));

        let mut contextless = bound;
        contextless.turn_context_digest = "";
        let decision = authorize(&contextless, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));

        let mut unbound = sessionless;
        unbound.turn_context_digest = "";
        let decision = authorize(&unbound, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));
    }

    #[test]
    fn user_action_origin_needs_only_the_principal_and_cannot_claim_a_batch_or_write() {
        let root = Path::new("/workspace");
        let mut user = request(root, root, ".");
        user.action_id = TERMINAL_RUN_ID;
        user.origin.kind = EffectOriginKindV1::UserAction;
        user.origin.session_id = "ses_1";
        user.turn_context_digest = "";
        let decision = authorize(&user, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        // A user action carries no turn context, so a batch-shaped user origin is denied.
        let mut batch_shaped = user;
        batch_shaped.turn_context_digest = TURN_CONTEXT_DIGEST;
        let decision = authorize(&batch_shaped, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("invalid_principal_or_origin"));

        // The user origin never authorizes a filesystem effect.
        let mut write = user;
        write.action_id = FILES_WRITE_ID;
        write.resource_resolution.target = Path::new("/workspace/file.txt");
        write.resource_resolution.resource = "file.txt";
        let decision = authorize(&write, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("unsupported_user_action"));

        // The origin kind is bound into the decision digest.
        let batch = request(root, root, ".");
        let mut batch = batch;
        batch.action_id = TERMINAL_RUN_ID;
        let batch_digest = intent_digest(&batch, &authorize(&batch, "challenge_1"));
        let user_digest = intent_digest(&user, &authorize(&user, "challenge_1"));
        assert_ne!(batch_digest, user_digest);
    }

    #[test]
    fn broker_action_requires_a_host_resolved_trusted_executable() {
        let root = Path::new("/workspace");
        let trusted = broker_request(
            root,
            REPL_START_ID,
            Some(trusted_executable("/usr/bin/python3")),
        );
        let decision = authorize(&trusted, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);
        assert_eq!(decision.normalized_action, REPL_START_ID);

        // No binding at all: an executable supplied by the request body must never
        // establish authority.
        let missing = broker_request(root, REPL_START_ID, None);
        let decision = authorize(&missing, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("executable_unverified"));

        // A caller-supplied path that differs from the configured resolved path is refused.
        let substituted = broker_request(
            root,
            REPL_START_ID,
            Some(ExecutableResolutionV1 {
                requested_path: "/tmp/attacker",
                resolved_path: "/usr/bin/python3",
                digest: EXECUTABLE_DIGEST,
                profile_digest: PROFILE_DIGEST,
            }),
        );
        let decision = authorize(&substituted, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("untrusted_executable"));

        // A relative or empty resolved path is never a trusted executable.
        let relative = broker_request(
            root,
            REPL_START_ID,
            Some(ExecutableResolutionV1 {
                requested_path: "python3",
                resolved_path: "python3",
                digest: EXECUTABLE_DIGEST,
                profile_digest: PROFILE_DIGEST,
            }),
        );
        let decision = authorize(&relative, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("untrusted_executable"));

        // Unverified/missing digests are refused.
        for invalid in [
            ExecutableResolutionV1 {
                requested_path: "/usr/bin/python3",
                resolved_path: "/usr/bin/python3",
                digest: "",
                profile_digest: PROFILE_DIGEST,
            },
            ExecutableResolutionV1 {
                requested_path: "/usr/bin/python3",
                resolved_path: "/usr/bin/python3",
                digest: EXECUTABLE_DIGEST,
                profile_digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            },
        ] {
            let request = broker_request(root, REPL_START_ID, Some(invalid));
            let decision = authorize(&request, "challenge_1");
            assert_eq!(decision.decision, DecisionKind::Deny);
            assert_eq!(decision.reason_code, Some("invalid_executable_digest"));
        }
    }

    #[test]
    fn broker_action_decision_digest_binds_the_executable_binding() {
        let root = Path::new("/workspace");
        let first = broker_request(
            root,
            DEBUG_EVALUATE_ID,
            Some(trusted_executable("/usr/bin/gdb")),
        );
        let first_digest = intent_digest(&first, &authorize(&first, "challenge_1"));

        let other_version = broker_request(
            root,
            DEBUG_EVALUATE_ID,
            Some(ExecutableResolutionV1 {
                requested_path: "/usr/bin/gdb",
                resolved_path: "/usr/bin/gdb",
                digest: "blake3:1111111111111111111111111111111111111111111111111111111111111111",
                profile_digest: PROFILE_DIGEST,
            }),
        );
        let other_digest = intent_digest(&other_version, &authorize(&other_version, "challenge_1"));
        assert_ne!(first_digest, other_digest);

        let other_profile = broker_request(
            root,
            DEBUG_EVALUATE_ID,
            Some(ExecutableResolutionV1 {
                requested_path: "/usr/bin/gdb",
                resolved_path: "/usr/bin/gdb",
                digest: EXECUTABLE_DIGEST,
                profile_digest: "blake3:2222222222222222222222222222222222222222222222222222222222222222",
            }),
        );
        assert_ne!(
            first_digest,
            intent_digest(&other_profile, &authorize(&other_profile, "challenge_1"))
        );

        let without = broker_request(root, DEBUG_EVALUATE_ID, None);
        assert_ne!(
            first_digest,
            intent_digest(&without, &authorize(&without, "challenge_1"))
        );
    }

    #[test]
    fn language_server_control_is_denied_for_model_originated_batches_only() {
        let root = Path::new("/workspace");
        let model = broker_request(
            root,
            LANGUAGE_SERVER_START_ID,
            Some(trusted_executable("/usr/bin/rust-analyzer")),
        );
        let decision = authorize(&model, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("model_process_control_denied"));

        // A human-originated user action may request the same supervised start; its
        // authority comes from the authenticated principal and explicit approval.
        let mut user = model;
        user.origin.kind = EffectOriginKindV1::UserAction;
        user.origin.session_id = "";
        user.turn_context_digest = "";
        let decision = authorize(&user, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        // The model-originated denial does not extend to debugger or REPL actions.
        let debugger = broker_request(
            root,
            DEBUG_START_ID,
            Some(trusted_executable("/usr/bin/gdb")),
        );
        let decision = authorize(&debugger, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);
    }

    #[test]
    fn builtin_verifier_requires_trusted_managed_run_or_user_action_and_never_a_model_batch() {
        let root = Path::new("/workspace");
        let mut user = broker_request(
            root,
            "builtin.verifier",
            Some(trusted_executable("/usr/bin/verifier")),
        );
        user.principal = "server_auth:reviewer";
        user.origin.kind = EffectOriginKindV1::UserAction;
        user.origin.session_id = "";
        user.turn_context_digest = "";
        let decision = authorize(&user, "verifier_challenge");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        let mut managed = user;
        managed.origin.kind = EffectOriginKindV1::ManagedRun;
        managed.origin.batch_id = "verification_run_1";
        managed.origin.call_id = "criterion_1";
        managed.request_id = "verification_run_1";
        let decision = authorize(&managed, "managed_verifier_challenge");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        let model = broker_request(
            root,
            "builtin.verifier",
            Some(trusted_executable("/usr/bin/verifier")),
        );
        let decision = authorize(&model, "model_verifier_challenge");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("model_process_control_denied"));

        let mut missing_profile_binding = broker_request(root, BUILTIN_VERIFIER_ID, None);
        missing_profile_binding.principal = "server_auth:reviewer";
        missing_profile_binding.origin.kind = EffectOriginKindV1::UserAction;
        missing_profile_binding.origin.session_id = "";
        missing_profile_binding.turn_context_digest = "";
        let decision = authorize(&missing_profile_binding, "missing_verifier_profile");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("executable_unverified"));
    }

    #[test]
    fn unregistered_catalog_actions_stay_typed_unsupported() {
        // §33.10 catalog IDs that this Guard owner has NOT registered (artifact reads and
        // export, automation targets). They must keep denying with the exact stable
        // `unsupported_action` reason so a caller can never mistake a missing registration
        // for an approval or an admission.
        let root = Path::new("/workspace");
        for action_id in [
            "artifacts.list",
            "artifacts.inspect",
            "artifacts.read_range",
            "artifacts.export",
        ] {
            let mut request = request(root, root, ".");
            request.action_id = action_id;
            let decision = authorize(&request, "challenge_1");
            assert_eq!(decision.decision, DecisionKind::Deny, "{action_id}");
            assert_eq!(
                decision.reason_code,
                Some("unsupported_action"),
                "{action_id}"
            );
        }
    }

    #[test]
    fn non_broker_actions_cannot_carry_an_executable_binding() {
        let root = Path::new("/workspace");
        let mut write = request(root, Path::new("/workspace/file.txt"), "file.txt");
        write.executable = Some(trusted_executable("/usr/bin/python3"));
        let decision = authorize(&write, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("unexpected_executable_binding"));
    }

    #[test]
    fn terminal_like_actions_resolve_a_workspace_relative_directory() {
        let root = Path::new("/workspace");
        // A subdirectory cwd is a valid resource for terminal/broker actions; it must
        // resolve to the exact normalized relative path.
        let mut run = request(root, Path::new("/workspace/src"), "src");
        run.action_id = TERMINAL_RUN_ID;
        let decision = authorize(&run, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Ask);
        assert_eq!(decision.reason_code, None);

        // A mismatched resource label is still refused.
        let mut mismatched = run;
        mismatched.resource_resolution.resource = ".";
        let decision = authorize(&mismatched, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("resource_outside_workspace"));

        // A directory outside the workspace root never resolves.
        let mut outside = request(root, Path::new("/outside"), "outside");
        outside.action_id = TERMINAL_RUN_ID;
        let decision = authorize(&outside, "challenge_1");
        assert_eq!(decision.decision, DecisionKind::Deny);
        assert_eq!(decision.reason_code, Some("resource_outside_workspace"));
    }

    #[test]
    fn managed_attempt_scope_changes_the_guard_intent_and_is_stable() {
        let root = Path::new("/workspace");
        let request = request(root, Path::new("/workspace/file.txt"), "file.txt");
        let decision = authorize(&request, "challenge_1");
        let scope = crate::protocol::ManagedAttemptScopeV1 {
            goal_id: "goal_1".to_owned(),
            run_id: "run_1".to_owned(),
            task_id: "task_1".to_owned(),
            attempt_id: "attempt_1".to_owned(),
            owner_epoch: 7,
            expected_managed_revision: 12,
            location_id: "loc_1".to_owned(),
            session_id: "ses_1".to_owned(),
            workspace_revision: format!("blake3:{}", "a".repeat(64)),
            delegation_binding_digest: format!("blake3:{}", "b".repeat(64)),
            effective_max_tokens: 100,
            remaining_tokens: 100,
            request_id: None, request_sequence: None, context_selection_digest: None,
            worktree_target: None,
        };
        let scope_digest = scope.digest().unwrap();
        let first = intent_digest_with_managed_scope(&request, &decision, Some(&scope_digest));
        assert_eq!(
            first,
            intent_digest_with_managed_scope(&request, &decision, Some(&scope.digest().unwrap()))
        );
        assert_ne!(first, intent_digest(&request, &decision));

        let mut other_attempt = scope;
        other_attempt.attempt_id = "attempt_2".to_owned();
        let other_digest = other_attempt.digest().unwrap();
        assert_ne!(
            first,
            intent_digest_with_managed_scope(&request, &decision, Some(&other_digest))
        );
    }

    #[test]
    fn user_profile_owner_mismatch_denies_before_capability_ceiling_is_minted() {
        let owner_principal = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
            subject: "profile-owner-a".to_owned(),
        };
        let other_principal = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
            subject: "profile-owner-b".to_owned(),
        };
        let owner = crate::agent_profile::ProfileOwnerBindingV1::from_authenticated_principal(
            "user",
            &owner_principal,
        )
        .unwrap();
        assert!(profile_owner_matches_authenticated_executor(
            "server_auth:profile-owner-a",
            &owner
        ));
        assert!(!profile_owner_matches_authenticated_executor(
            "server_auth:profile-owner-b",
            &owner
        ));
        assert!(!profile_owner_matches_authenticated_executor(
            "host_os:1000",
            &owner
        ));

        let builtin = crate::agent_profile::ProfileOwnerBindingV1::from_authenticated_principal(
            "builtin",
            &other_principal,
        )
        .unwrap();
        assert!(profile_owner_matches_authenticated_executor(
            "server_auth:profile-owner-b",
            &builtin
        ));
    }

    #[test]
    fn repo_read_scope_requires_beneath_root_path_and_current_generation() {
        let root = std::env::temp_dir().join(format!(
            "horizon-guard-read-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), b"fn main() {}\n").unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let workspace_binding = workspace_binding(&root, 1, 2);
        let generation = format!("blake3:{}", "a".repeat(64));
        let principal = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
            subject: "reader-a".to_owned(),
        };
        let owner_binding = location_principal_binding("reader-a");

        let scope = authorize_repo_read_scope(
            &principal,
            Some(&owner_binding),
            FILES_READ_ID,
            &root,
            "src",
            &workspace_binding,
            &generation,
            &generation,
        )
        .unwrap();
        assert_eq!(scope.relative_root(), "src");
        assert_eq!(scope.principal_binding(), owner_binding);
        assert_eq!(scope.source_generation(), generation);
        assert_eq!(scope.workspace_binding(), workspace_binding);

        assert!(
            authorize_repo_read_scope(
                &principal,
                Some(&owner_binding),
                FILES_READ_ID,
                &root,
                "../outside",
                &workspace_binding,
                &generation,
                &generation,
            )
            .is_err()
        );
        assert!(
            authorize_repo_read_scope(
                &principal,
                Some(&owner_binding),
                FILES_READ_ID,
                &root,
                "src",
                &workspace_binding,
                &generation,
                &format!("blake3:{}", "b".repeat(64)),
            )
            .is_err()
        );
        let foreign = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
            subject: "reader-b".to_owned(),
        };
        assert_eq!(
            authorize_repo_read_scope(
                &foreign,
                Some(&owner_binding),
                FILES_READ_ID,
                &root,
                "src",
                &workspace_binding,
                &generation,
                &generation,
            )
            .unwrap_err(),
            "location_owner_mismatch"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn repo_read_scope_rejects_symlinked_subroots() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "horizon-guard-read-link-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&root).unwrap();
        let outside = root.with_extension("outside");
        std::fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join("linked")).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let workspace_binding = workspace_binding(&root, 1, 2);
        let generation = format!("blake3:{}", "a".repeat(64));
        let principal = crate::protocol::AuthenticatedPrincipalV1::ServerAuth {
            subject: "reader-a".to_owned(),
        };
        let owner_binding = location_principal_binding("reader-a");

        assert!(
            authorize_repo_read_scope(
                &principal,
                Some(&owner_binding),
                FILES_READ_ID,
                &root,
                "linked",
                &workspace_binding,
                &generation,
                &generation,
            )
            .is_err()
        );
        std::fs::remove_dir_all(root).unwrap();
        std::fs::remove_dir_all(outside).unwrap();
    }
}
