//! Wiring: environment resolution, guard/sandbox construction, command dispatch.

use std::io::IsTerminal;
use std::path::PathBuf;
use std::sync::Arc;

use agentx_acp::AcpOptions;
use agentx_guard::{
    AutoApproveResolver, DenyAllResolver, Effect, Guard, GuardMode, Rule, canonical_action,
    default_rules,
};
use agentx_provider::{ChatCompletionsProvider, Provider, ProviderConfig};
use agentx_runner::{RunConfig, Runner};
use agentx_sandbox::{ConfinementProfile, FsProfile, NetworkPolicy, SandboxProvider};
use agentx_session::{ModelRef, SessionCreatedPayload, SessionStore, TurnEndStatus};
use agentx_tools::{
    BuiltinOptions, GuardPermissionGate, PermissionGate, ToolRegistry, register_all_builtins,
};
use agentx_types::{CancelToken, SessionId};
use thiserror::Error;

use crate::approval::InteractiveApprovalResolver;
use crate::args::{Cli, Command, ModeArg, OutputFormat, SandboxArg};
use crate::output::CliObserver;

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
    Session(#[from] agentx_session::SessionError),

    /// The ACP server failed.
    #[error("acp error: {0}")]
    Acp(#[from] agentx_acp::AcpError),

    /// The loop failed at the infrastructure level.
    #[error("run error: {0}")]
    Run(String),
}

/// Whether a `CliError` is a configuration error, for exit-code selection.
#[must_use]
pub fn is_config_error(error: &CliError) -> bool {
    matches!(error, CliError::Config(_))
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
}

/// Runs the requested command, returning a process exit code.
///
/// # Errors
/// Returns a [`CliError`] for configuration or infrastructure failures.
pub async fn run(args: Cli) -> Result<u8, CliError> {
    let context = build_context(&args)?;
    match args.command {
        Some(Command::Acp) => run_acp(context).await,
        None => run_headless(&args, &context).await,
    }
}

fn build_context(args: &Cli) -> Result<Context, CliError> {
    let workspace = resolve_workspace(args)?;
    let base_url = args
        .base_url
        .clone()
        .or_else(|| env_nonempty("AGENTX_BASE_URL"))
        .ok_or_else(|| {
            CliError::Config(
                "provider base url is required (set AGENTX_BASE_URL or pass --base-url)".to_owned(),
            )
        })?;
    let api_key = env_nonempty("AGENTX_API_KEY").ok_or_else(|| {
        CliError::Config("provider api key is required (set AGENTX_API_KEY)".to_owned())
    })?;
    let model = args
        .model
        .clone()
        .or_else(|| env_nonempty("AGENTX_MODEL"))
        .unwrap_or_else(|| "default".to_owned());

    let provider = ChatCompletionsProvider::new(ProviderConfig::new(
        args.provider.clone(),
        base_url,
        api_key,
        model.clone(),
    ))
    .map_err(|error| CliError::Config(format!("invalid provider configuration: {error}")))?;

    let store = Arc::new(SessionStore::open_default()?);
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

    let resolver: Arc<dyn agentx_guard::ApprovalResolver> = if guard.mode() == GuardMode::Yolo {
        Arc::new(AutoApproveResolver)
    } else if args.format == OutputFormat::Default && std::io::stdin().is_terminal() {
        Arc::new(InteractiveApprovalResolver)
    } else {
        Arc::new(DenyAllResolver)
    };
    let gate: Arc<dyn PermissionGate> = Arc::new(GuardPermissionGate::new(guard.clone(), resolver));

    let config = RunConfig {
        model,
        provider: args.provider.clone(),
        mode: guard.mode().as_str().to_owned(),
        workspace: workspace.clone(),
        output_dir: Some(spill),
        max_steps: args.max_steps,
        system: vec![system_prompt(&workspace, guard.mode())],
        sandbox: sandbox.provider.clone(),
        sandbox_resolved: sandbox.resolved.clone(),
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
    })
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
    for action in split_env("AGENTX_ASK_ACTIONS") {
        session_rules.push(Rule::new(canonical_action(&action), "**", Effect::Ask));
    }
    for action in split_env("AGENTX_DENY_ACTIONS") {
        session_rules.push(Rule::new(canonical_action(&action), "**", Effect::Deny));
    }

    let mut builder = Guard::builder()
        .with_workspace(workspace.to_path_buf())
        .with_default_rules(default_rules())
        .with_unmatched(Effect::Deny)
        .with_session_rules(session_rules)
        .with_saved_path(workspace.join(".agentx").join("saved-rules.json"));
    if let Some(mode) = explicit_mode {
        builder = builder.with_mode(mode);
    }
    let guard = builder.build();
    if let Some(reason) = guard.degraded() {
        eprintln!("agentx: guard policy failed to load; failing closed ({reason})");
    }
    Ok(Arc::new(guard))
}

fn build_sandbox(
    args: &Cli,
    workspace: &std::path::Path,
    spill: &std::path::Path,
) -> Result<SandboxSetup, CliError> {
    let provider = agentx_sandbox::local_provider();
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
                    "agentx: sandbox unavailable ({error}); shell effects will be refused rather \
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
    resolved: Option<Arc<agentx_sandbox::ResolvedProfile>>,
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
        server_name: "agentx".to_owned(),
        server_version: env!("CARGO_PKG_VERSION").to_owned(),
    };
    agentx_acp::run_stdio(options).await?;
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

fn system_prompt(workspace: &std::path::Path, mode: GuardMode) -> String {
    format!(
        "You are agentX, an autonomous coding agent working in the workspace {} in {} mode.\n\
         Use the available tools to inspect and change the repository. Shell commands run inside \
         a sandbox with workspace-scoped writes and no outbound network. Never invent file \
         contents or command output; verify before claiming success.",
        workspace.display(),
        mode.as_str()
    )
}
