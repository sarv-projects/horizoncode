//! Wiring: environment resolution, guard/sandbox construction, command dispatch.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::Arc;

use horizoncode_acp::AcpOptions;
use horizoncode_analytics::{AnalyticsConfig, AnalyticsLog};
use horizoncode_audit::{AuditConfig, AuditLog, RedactionConfig};
use horizoncode_guard::{
    AutoApproveResolver, DenyAllResolver, Effect, Guard, GuardMode, Rule, canonical_action,
    default_rules,
};
use horizoncode_provider::{ChatCompletionsProvider, Provider, ProviderConfig};
use horizoncode_runner::{ApprovalRecorder, PolicySnapshot, Recorder, RouteRef, RunConfig, Runner};
use horizoncode_sandbox::{ConfinementProfile, FsProfile, NetworkPolicy, SandboxProvider};
use horizoncode_session::{ModelRef, SessionCreatedPayload, SessionStore, TurnEndStatus};
use horizoncode_tools::{
    BuiltinOptions, GuardPermissionGate, PermissionGate, ToolRegistry, register_all_builtins,
};
use horizoncode_types::{CancelToken, SessionId};
use thiserror::Error;

use crate::approval::InteractiveApprovalResolver;
use crate::args::{Cli, Command, ModeArg, OutputFormat, SandboxArg};
use crate::output::CliObserver;
use crate::surfaces;

/// Exit code: the turn completed.
pub const EXIT_SUCCESS: u8 = 0;
/// Exit code: the agent failed.
pub const EXIT_AGENT_FAILED: u8 = 1;
/// Exit code: declined or denied.
pub const EXIT_DECLINED: u8 = 2;
/// Exit code: interrupted.
pub const EXIT_INTERRUPTED: u8 = 3;
/// Exit code: configuration error.
pub const EXIT_CONFIG: u8 = 4;
/// Exit code: internal error.
pub const EXIT_INTERNAL: u8 = 5;
/// Exit code: audit verification or the coverage census failed.
pub const EXIT_AUDIT_FAILED: u8 = 6;
/// Exit code: the audit access record could not be written, so nothing was
/// disclosed. This is distinct from `EXIT_AUDIT_FAILED`: the evidence is not
/// bad, the record of reading it could not be kept.
pub const EXIT_ACCESS_FAILED: u8 = 7;

/// A CLI failure.
#[derive(Debug, Error)]
#[non_exhaustive]
pub enum CliError {
    /// Configuration is missing or invalid.
    #[error("{0}")]
    Config(String),

    /// A filesystem operation failed.
    #[error("io error: {0}")]
    Io(String),

    /// The session store failed.
    #[error("session error: {0}")]
    Session(#[from] horizoncode_session::SessionError),

    /// The ACP server failed.
    #[error("acp error: {0}")]
    Acp(#[from] horizoncode_acp::AcpError),

    /// The loop failed at the infrastructure level.
    #[error("run error: {0}")]
    Run(String),

    /// The audit or analytics store refused an operation.
    #[error("audit error: {0}")]
    Audit(String),

    /// The analytics store refused an operation.
    #[error("analytics error: {0}")]
    Analytics(String),

    /// The audit access record could not be written, so nothing was disclosed.
    #[error("audit access error: {0}")]
    Access(String),
}

/// Whether a `CliError` is a configuration error, for exit-code selection.
#[must_use]
pub fn is_config_error(error: &CliError) -> bool {
    matches!(error, CliError::Config(_))
}

/// The on-disk state roots a run reads and writes.
///
/// Resolution is explicit and total: a surface never falls back to a process
/// global, so two concurrent invocations with different `HORIZONCODE_HOME` values
/// cannot interfere, and a test can point every store at its own temp root.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StateDir {
    home: PathBuf,
}

impl StateDir {
    /// Resolves the state root from `HORIZONCODE_HOME`, falling back to the user's
    /// home directory.
    #[must_use]
    pub fn from_env() -> Self {
        Self {
            home: std::env::var_os("HORIZONCODE_HOME")
                .filter(|value| !value.is_empty())
                .map(PathBuf::from)
                .or_else(dirs::home_dir)
                .unwrap_or_else(|| PathBuf::from(".")),
        }
    }

    /// The session log root.
    #[must_use]
    pub fn sessions_root(&self) -> PathBuf {
        self.home.join("sessions")
    }

    /// The audit store root.
    #[must_use]
    pub fn audit_root(&self) -> PathBuf {
        self.home.join("audit")
    }

    /// The analytics root.
    #[must_use]
    pub fn analytics_root(&self) -> PathBuf {
        self.home.join("analytics")
    }
}

struct Context {
    provider: Arc<dyn Provider>,
    tools: Arc<ToolRegistry>,
    store: Arc<SessionStore>,
    guard: Arc<Guard>,
    gate: Arc<dyn PermissionGate>,
    config: RunConfig,
    sandbox: Option<Arc<dyn SandboxProvider>>,
    sandbox_profile: Option<ConfinementProfile>,
    analytics: Option<Arc<AnalyticsLog>>,
}

/// Runs the requested command, returning a process exit code.
///
/// # Errors
/// Returns a [`CliError`] for configuration or infrastructure failures.
pub async fn run(args: Cli) -> Result<u8, CliError> {
    // The inspection surfaces run before any provider configuration is
    // resolved, because they must work when a run is not possible.
    let state = StateDir::from_env();
    match &args.command {
        Some(Command::Audit(command)) => return surfaces::run_audit(&state, command),
        Some(Command::Analytics(command)) => return surfaces::run_analytics(&state, command),
        Some(Command::Acp) | None => {}
    }
    // A prompt-shaped invocation of `/usage` or `/insights` is an analytics
    // query, not a run: it must not require provider settings.
    if let Some(prompt) = &args.print
        && prompt.trim().starts_with('/')
    {
        return run_slash_command(&state, &parse_slash_command(prompt)?);
    }
    let context = build_context(&args, state)?;
    match args.command {
        Some(Command::Acp) => run_acp(context).await,
        _ => run_headless(&args, &context).await,
    }
}

/// A `/usage`-style command parsed out of a prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SlashCommand {
    /// The command name, without its leading slash.
    pub name: String,
    /// The numeric argument, when the command takes one.
    pub argument: Option<u32>,
}

/// Parses a `/usage` or `/insights` invocation.
///
/// # Errors
/// Returns [`CliError::Config`] when a slash command names an unknown
/// subcommand or a malformed argument, rather than silently treating it as a
/// prompt.
pub fn parse_slash_command(prompt: &str) -> Result<SlashCommand, CliError> {
    let trimmed = prompt.trim();
    if !trimmed.starts_with('/') {
        return Err(CliError::Config("not a slash command".to_owned()));
    }
    let mut parts = trimmed.split_whitespace();
    let name = parts
        .next()
        .unwrap_or_default()
        .trim_start_matches('/')
        .to_owned();
    let rest: Vec<&str> = parts.collect();
    match (name.as_str(), rest.as_slice()) {
        ("usage", []) | ("usage", ["--all"]) => Ok(SlashCommand {
            name,
            argument: None,
        }),
        ("insights", []) => Ok(SlashCommand {
            name,
            argument: Some(DEFAULT_INSIGHTS_DAYS),
        }),
        // Both `--days 7` and `--days=7` are accepted; a bare `--days` with no
        // value is a configuration error rather than a silent default.
        ("insights", ["--days", value]) => Ok(SlashCommand {
            name,
            argument: Some(parse_days(value)?),
        }),
        ("insights", [value]) if value.starts_with("--days=") => Ok(SlashCommand {
            name,
            argument: Some(parse_days(value.trim_start_matches("--days="))?),
        }),
        ("insights", _) => Err(CliError::Config(
            "/insights takes `--days N` and nothing else".to_owned(),
        )),
        (other, _) => Err(CliError::Config(format!(
            "unknown slash command `/{other}`; supported: /usage, /insights [--days N]"
        ))),
    }
}

/// The window `/insights` uses when none is given.
pub const DEFAULT_INSIGHTS_DAYS: u32 = 7;

fn parse_days(value: &str) -> Result<u32, CliError> {
    value.parse::<u32>().map_err(|_| {
        CliError::Config(format!(
            "/insights takes `--days N`; `{value}` is not a number"
        ))
    })
}

fn run_slash_command(state: &StateDir, command: &SlashCommand) -> Result<u8, CliError> {
    match command.name.as_str() {
        "usage" => surfaces::run_usage(state, None),
        "insights" => surfaces::run_insights(state, command.argument),
        other => Err(CliError::Config(format!(
            "unknown slash command `/{other}`"
        ))),
    }
}

fn build_context(args: &Cli, state: StateDir) -> Result<Context, CliError> {
    let workspace = resolve_workspace(args)?;
    let base_url = args
        .base_url
        .clone()
        .or_else(|| env_nonempty("HORIZONCODE_BASE_URL"))
        .ok_or_else(|| {
            CliError::Config(
                "provider base url is required (set HORIZONCODE_BASE_URL or pass --base-url)"
                    .to_owned(),
            )
        })?;
    let api_key = env_nonempty("HORIZONCODE_API_KEY").ok_or_else(|| {
        CliError::Config("provider api key is required (set HORIZONCODE_API_KEY)".to_owned())
    })?;
    let model = args
        .model
        .clone()
        .or_else(|| env_nonempty("HORIZONCODE_MODEL"))
        .unwrap_or_else(|| "default".to_owned());

    let provider = ChatCompletionsProvider::new(ProviderConfig::new(
        args.provider.clone(),
        base_url,
        api_key,
        model.clone(),
    ))
    .map_err(|error| CliError::Config(format!("invalid provider configuration: {error}")))?;

    let store = Arc::new(SessionStore::open(state.sessions_root())?);
    let spill = store
        .root()
        .parent()
        .unwrap_or_else(|| store.root())
        .join("tool-output");

    let mut registry = ToolRegistry::new();
    register_all_builtins(&mut registry, BuiltinOptions::headless())
        .map_err(|error| CliError::Config(format!("failed to register built-in tools: {error}")))?;
    registry.set_spill_dir(Some(spill.clone()));

    let guard = build_guard(args, &workspace)?;
    let sandbox = build_sandbox(args, &workspace, &spill)?;

    // The audit store is opened for the run. Its configured sink is validated
    // here, so a configured-but-unreachable anchor stops the run before any
    // effect is attempted rather than degrading afterwards (`DEC-022`).
    let audit = open_audit(&state)?;
    let analytics = open_analytics(&state)?;
    let recorder = Recorder::new()
        .with_audit(audit.clone())
        .with_analytics(analytics.clone())
        .with_policy(PolicySnapshot {
            policy_hash: guard.policy_hash().to_owned(),
            mode: guard.mode().as_str().to_owned(),
            unmatched: guard.unmatched().as_str().to_owned(),
        })
        .with_route(RouteRef {
            provider: args.provider.clone(),
            model: model.clone(),
        })
        // The project label is the workspace's *name*, not its absolute path:
        // these records are exported, and a home directory on every entry is
        // avoidable PII (`ARCH/14-AUDIT.md` §Privacy / PII handling).
        .with_project(workspace_label(&workspace));

    let resolver: Arc<dyn horizoncode_guard::ApprovalResolver> = if guard.mode() == GuardMode::Yolo
    {
        Arc::new(AutoApproveResolver)
    } else if args.format == OutputFormat::Default && std::io::stdin().is_terminal() {
        Arc::new(InteractiveApprovalResolver)
    } else {
        Arc::new(DenyAllResolver)
    };
    // The approval observer watches the single permission seam: it records the
    // reply — including `always` and the exact remembered pattern — and cannot
    // change a decision (`ACC-P1-03`). It shares the *same* recorder the loop
    // publishes the current session and turn on, so a reply is attributed to
    // the turn that asked for it.
    let gate: Arc<dyn PermissionGate> = Arc::new(
        GuardPermissionGate::new(guard.clone(), resolver)
            .with_approval_observer(Arc::new(ApprovalRecorder::new(recorder.clone()))),
    );

    let config = RunConfig {
        model: model.clone(),
        provider: args.provider.clone(),
        mode: guard.mode().as_str().to_owned(),
        workspace: workspace.clone(),
        output_dir: Some(spill),
        max_steps: args.max_steps,
        system: vec![system_prompt(&workspace, guard.mode())],
        sandbox: sandbox.provider.clone(),
        sandbox_resolved: sandbox.resolved.clone(),
        context_window: args.context_window,
        // The loop and the permission seam must share **one** recorder: the loop
        // publishes the current session and turn on it, and the seam's observers
        // read them from it to attribute a decision to its turn.
        recorder,
        ..RunConfig::default()
    };

    Ok(Context {
        provider: Arc::new(provider),
        tools: Arc::new(registry),
        store,
        guard,
        gate,
        config,
        sandbox: sandbox.provider,
        sandbox_profile: sandbox.profile,
        analytics,
    })
}

/// Opens the audit store, registering the environment-derived secrets the
/// redaction pass must never let into the chain.
fn open_audit(state: &StateDir) -> Result<Option<Arc<AuditLog>>, CliError> {
    let config = AuditConfig {
        root: state.audit_root(),
        redaction: RedactionConfig::default(),
        ..AuditConfig::default()
    };
    let env: Vec<(String, String)> = std::env::vars().collect();
    match AuditLog::open(config, &env) {
        Ok(log) => Ok(Some(Arc::new(log))),
        // A refused anchor is a fail-closed stop, not a warning: the run must
        // not proceed with an evidence trail that cannot be anchored.
        Err(error) => Err(CliError::Audit(error.to_string())),
    }
}

/// Opens the analytics ledger. A telemetry posture this build cannot provide is
/// a typed refusal, not silence.
fn open_analytics(state: &StateDir) -> Result<Option<Arc<AnalyticsLog>>, CliError> {
    let config = AnalyticsConfig::new(state.analytics_root());
    match AnalyticsLog::open(config) {
        Ok(log) => Ok(Some(Arc::new(log))),
        Err(error) => Err(CliError::Analytics(error.to_string())),
    }
}

fn build_guard(args: &Cli, workspace: &std::path::Path) -> Result<Arc<Guard>, CliError> {
    let explicit_mode = if args.yolo {
        Some(GuardMode::Yolo)
    } else {
        args.mode.map(|mode| match mode {
            ModeArg::Plan => GuardMode::Plan,
            ModeArg::Act => GuardMode::Act,
            ModeArg::Yolo => GuardMode::Yolo,
        })
    };

    let mut session_rules = Vec::new();
    for action in split_env("HORIZONCODE_ASK_ACTIONS") {
        session_rules.push(Rule::new(canonical_action(&action), "**", Effect::Ask));
    }
    for action in split_env("HORIZONCODE_DENY_ACTIONS") {
        session_rules.push(Rule::new(canonical_action(&action), "**", Effect::Deny));
    }

    let mut builder = Guard::builder()
        .with_workspace(workspace.to_path_buf())
        .with_default_rules(default_rules())
        .with_unmatched(Effect::Deny)
        .with_session_rules(session_rules)
        .with_saved_path(workspace.join(".horizoncode").join("saved-rules.json"));
    if let Some(mode) = explicit_mode {
        builder = builder.with_mode(mode);
    }
    let guard = builder.build();
    if let Some(reason) = guard.degraded() {
        eprintln!("horizoncode: guard policy failed to load; failing closed ({reason})");
    }
    Ok(Arc::new(guard))
}

fn build_sandbox(
    args: &Cli,
    workspace: &std::path::Path,
    spill: &std::path::Path,
) -> Result<SandboxSetup, CliError> {
    let provider = horizoncode_sandbox::local_provider();
    let mut profile = ConfinementProfile::workspace_write(workspace.to_path_buf());
    profile.profile = match args.sandbox {
        SandboxArg::ReadOnly => FsProfile::ReadOnly,
        SandboxArg::WorkspaceWrite => FsProfile::WorkspaceWrite,
        SandboxArg::FullAccess => FsProfile::FullAccess,
    };
    profile.session_dir = Some(spill.to_path_buf());
    if profile.profile == FsProfile::FullAccess {
        profile.network = NetworkPolicy::Full;
    }
    let resolved = match provider.resolve(&profile) {
        Ok(resolved) => Some(Arc::new(resolved)),
        Err(error) => {
            if profile.profile != FsProfile::FullAccess {
                eprintln!(
                    "horizoncode: sandbox unavailable ({error}); shell effects will be refused rather \
                     than run unconfined"
                );
            }
            None
        }
    };
    Ok(SandboxSetup {
        provider: Some(provider),
        profile: Some(profile),
        resolved,
    })
}

/// The resolved sandbox wiring for one CLI invocation.
struct SandboxSetup {
    provider: Option<Arc<dyn SandboxProvider>>,
    profile: Option<ConfinementProfile>,
    resolved: Option<Arc<horizoncode_sandbox::ResolvedProfile>>,
}

async fn run_acp(context: Context) -> Result<u8, CliError> {
    let options = AcpOptions {
        provider: context.provider,
        tools: context.tools,
        store: context.store,
        config: context.config,
        guard: context.guard,
        sandbox: context.sandbox,
        sandbox_profile: context.sandbox_profile,
        server_name: "horizoncode".to_owned(),
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
        analytics: context.analytics.clone(),
    };
    horizoncode_acp::run_stdio(options).await?;
    Ok(EXIT_SUCCESS)
}

async fn run_headless(args: &Cli, context: &Context) -> Result<u8, CliError> {
    let prompt = build_prompt(args)?;
    let session_id = resolve_session(args, context)?;

    let cancel = CancelToken::new();
    {
        // SIGINT/SIGTERM map to cooperative cancel (`ARCH/15-PROTOCOLS.md`).
        let cancel = cancel.clone();
        tokio::spawn(async move {
            let _ = tokio::signal::ctrl_c().await;
            cancel.cancel();
        });
    }

    let runner = Runner::new(
        context.provider.clone(),
        context.tools.clone(),
        context.store.clone(),
        context.gate.clone(),
        context.config.clone(),
    );
    let mut observer = CliObserver::new(args.format);
    let outcome = runner
        .run_turn(&session_id, &prompt, cancel, &mut observer)
        .await
        .map_err(|error| CliError::Run(error.to_string()))?;

    if args.format == OutputFormat::Default {
        // Terminate any streamed text with a newline.
        println!();
    }
    Ok(exit_code_for(outcome.status))
}

fn build_prompt(args: &Cli) -> Result<String, CliError> {
    let mut parts = Vec::new();
    if let Some(prompt) = &args.print {
        parts.push(prompt.clone());
    }
    if args.stdin {
        use std::io::Read;
        let mut buffer = String::new();
        std::io::stdin()
            .read_to_string(&mut buffer)
            .map_err(|error| CliError::Io(error.to_string()))?;
        parts.push(buffer);
    }
    let prompt = parts.join("\n");
    if prompt.trim().is_empty() {
        return Err(CliError::Config(
            "no prompt provided; use -p/--print or --stdin".to_owned(),
        ));
    }
    Ok(prompt)
}

fn resolve_session(args: &Cli, context: &Context) -> Result<SessionId, CliError> {
    if let Some(id) = &args.session {
        let session_id = SessionId::new(id.clone());
        if !context.store.exists(&session_id) {
            return Err(CliError::Config(format!("session not found: {id}")));
        }
        return Ok(session_id);
    }
    if args.continue_session
        && let Some(latest) = context.store.latest()
    {
        return Ok(latest);
    }
    let workspace = context.config.workspace.to_string_lossy().into_owned();
    let title = context
        .config
        .workspace
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| workspace.clone());
    let header = SessionCreatedPayload::new(
        workspace,
        title,
        ModelRef {
            id: context.config.model.clone(),
            provider: context.config.provider.clone(),
            variant: None,
        },
        context.config.mode.clone(),
        context.guard.snapshot(),
    );
    let created = context.store.create(header)?;
    Ok(created.id)
}

fn exit_code_for(status: TurnEndStatus) -> u8 {
    match status {
        TurnEndStatus::Completed => EXIT_SUCCESS,
        TurnEndStatus::Partial | TurnEndStatus::Failed => EXIT_AGENT_FAILED,
        TurnEndStatus::Declined => EXIT_DECLINED,
        TurnEndStatus::Interrupted => EXIT_INTERRUPTED,
    }
}

fn resolve_workspace(args: &Cli) -> Result<PathBuf, CliError> {
    let path = match &args.cwd {
        Some(path) => path.clone(),
        None => std::env::current_dir().map_err(|error| CliError::Io(error.to_string()))?,
    };
    let canonical = std::fs::canonicalize(&path).map_err(|error| {
        CliError::Config(format!(
            "workspace {} is not accessible: {error}",
            path.display()
        ))
    })?;
    if !canonical.is_dir() {
        return Err(CliError::Config(format!(
            "workspace {} is not a directory",
            canonical.display()
        )));
    }
    Ok(canonical)
}

fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

fn split_env(name: &str) -> Vec<String> {
    env_nonempty(name)
        .map(|value| {
            value
                .split(',')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_owned)
                .collect()
        })
        .unwrap_or_default()
}

/// The recorded project label for a workspace: its directory name, falling back
/// to the full path only when a workspace has no name to give.
#[must_use]
pub fn workspace_label(workspace: &std::path::Path) -> Option<String> {
    Some(
        workspace
            .file_name()
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_else(|| workspace.to_string_lossy().into_owned()),
    )
}

fn system_prompt(workspace: &std::path::Path, mode: GuardMode) -> String {
    format!(
        "You are HorizonCode, an autonomous coding agent working in the workspace {} in {} mode.\n\
         Use the available tools to inspect and change the repository. Shell commands run inside \
         a sandbox with workspace-scoped writes and no outbound network. Never invent file \
         contents or command output; verify before claiming success.",
        workspace.display(),
        mode.as_str()
    )
}
