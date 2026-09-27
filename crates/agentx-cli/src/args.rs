//! The command-line surface (`CMP-headless`, `ARCH/15-PROTOCOLS.md`).

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

/// Exit-code contract, documented in `--help` (`ACC-P1-08`).
pub const EXIT_CODES_HELP: &str = "\
Exit codes:
  0  turn completed (or partial work saved)
  1  the agent failed to complete the turn
  2  the turn was declined or denied by policy
  3  the turn was interrupted
  4  configuration error (missing or invalid settings)
  5  internal error
  6  audit verification or the coverage census failed";

/// Output format for headless runs.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum OutputFormat {
    /// Human-readable: streamed text on stdout, status on stderr.
    Default,
    /// One JSON event object per line on stdout.
    Json,
    /// One JSON event object per line on stdout (alias of `json`).
    Ndjson,
}

/// The interaction posture.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum ModeArg {
    /// Read-only planning: mutating actions are refused.
    Plan,
    /// Normal evaluation.
    Act,
    /// Auto-approve non-catastrophic asks; deny rules still apply.
    Yolo,
}

/// The sandbox filesystem profile.
#[derive(Clone, Copy, Debug, PartialEq, Eq, ValueEnum)]
pub enum SandboxArg {
    /// Scoped read; writes only to session state and temp.
    ReadOnly,
    /// Scoped read; workspace writes; network off (default).
    WorkspaceWrite,
    /// No confinement; explicit, audited opt-in only.
    FullAccess,
}

/// `audit` subcommands (`ARCH/14-AUDIT.md`).
#[derive(Clone, Debug, Subcommand)]
pub enum AuditCommand {
    /// Recompute the chain, the roots, and the anchor, and report the first
    /// divergence.
    Verify {
        /// Verify only this session's entries.
        #[arg(long, value_name = "ID")]
        session: Option<String>,
        /// Verify every recorded session.
        #[arg(long)]
        all: bool,
    },
    /// Reconstruct a session's decision/effect timeline from the record.
    Replay {
        /// The session to replay.
        #[arg(long, value_name = "ID")]
        session: String,
        /// First audit `seq` to include.
        #[arg(long, value_name = "N")]
        from: Option<u64>,
        /// Last audit `seq` to include.
        #[arg(long, value_name = "N")]
        to: Option<u64>,
    },
    /// Map every declared security-relevant effect class to recorded entries,
    /// and fail loudly on any gap.
    Census {
        /// Census only this session.
        #[arg(long, value_name = "ID")]
        session: Option<String>,
        /// Write the evidence artifact here.
        #[arg(long, value_name = "PATH")]
        out: Option<PathBuf>,
        /// Report the gaps instead of failing on them.
        ///
        /// Coverage is a property of a *window* chosen to exercise every
        /// declared effect class. An ordinary run legitimately covers only the
        /// classes it exercised, so inspecting one needs this flag; a release
        /// gate does not use it.
        #[arg(long)]
        allow_uncovered: bool,
    },
}

/// The analytics surfaces (`ARCH/20-ANALYTICS.md`).
#[derive(Clone, Debug, Subcommand)]
pub enum AnalyticsCommand {
    /// Show recorded usage and cost, with unpriced routes reported as unknown.
    Stats {
        /// Only this session.
        #[arg(long, value_name = "ID")]
        session: Option<String>,
        /// Output format.
        #[arg(long, value_enum, default_value_t = OutputFormat::Default)]
        format: OutputFormat,
    },
    /// Stream the analytics ledger as newline-delimited JSON.
    Export {
        /// Scrub denied fields (project, route, tool, error class) first.
        #[arg(long)]
        sanitize: bool,
    },
}

/// Subcommands.
#[derive(Clone, Debug, Subcommand)]
pub enum Command {
    /// Run the ACP server over stdio.
    Acp,
    /// Verify, replay, and census the audit record.
    #[command(subcommand)]
    Audit(AuditCommand),
    /// Show usage and cost, or export the ledger.
    #[command(subcommand)]
    Analytics(AnalyticsCommand),
}

/// Standalone, protocol-native command-line coding agent.
#[derive(Debug, Parser)]
#[command(
    name = "agentx",
    version,
    about = "A standalone, protocol-native command-line coding agent.",
    long_about = "Run a one-shot prompt with -p, or start the ACP stdio server with the `acp` subcommand. \
    Audit history is inspected with `audit verify|replay|census`; usage and cost with `analytics stats`, \
    `/usage`, and `/insights`. Provider settings come from the environment: AGENTX_BASE_URL, \
    AGENTX_API_KEY, AGENTX_MODEL (and AGENTX_HOME to relocate the session, audit, and analytics stores).",
    after_help = EXIT_CODES_HELP,
    arg_required_else_help = true
)]
pub struct Cli {
    /// Subcommand to run.
    #[command(subcommand)]
    pub command: Option<Command>,

    /// One-shot prompt to run non-interactively.
    #[arg(short = 'p', long = "print", value_name = "PROMPT")]
    pub print: Option<String>,

    /// Read additional prompt text from stdin (composable with -p).
    #[arg(long)]
    pub stdin: bool,

    /// Output format.
    #[arg(long, value_enum, default_value_t = OutputFormat::Default)]
    pub format: OutputFormat,

    /// Model id; overrides AGENTX_MODEL.
    #[arg(long, value_name = "MODEL")]
    pub model: Option<String>,

    /// Workspace root (defaults to the current directory).
    #[arg(long, alias = "dir", value_name = "PATH")]
    pub cwd: Option<PathBuf>,

    /// Resume an existing session by id.
    #[arg(long, value_name = "ID")]
    pub session: Option<String>,

    /// Resume the most recently active session.
    #[arg(long = "continue")]
    pub continue_session: bool,

    /// Provider base URL; overrides AGENTX_BASE_URL.
    #[arg(long, value_name = "URL")]
    pub base_url: Option<String>,

    /// Provider/route id.
    #[arg(long, value_name = "NAME", default_value = "compatible")]
    pub provider: String,

    /// Maximum model steps per turn.
    #[arg(long, value_name = "N", default_value_t = 25)]
    pub max_steps: usize,

    /// Interaction mode; overrides any mode discovered from configuration.
    #[arg(long, value_enum, value_name = "MODE")]
    pub mode: Option<ModeArg>,

    /// Shorthand for `--mode yolo`.
    #[arg(long)]
    pub yolo: bool,

    /// Sandbox filesystem profile.
    #[arg(long, value_enum, default_value_t = SandboxArg::WorkspaceWrite)]
    pub sandbox: SandboxArg,

    /// The model's advertised context-window size, in tokens.
    ///
    /// A surface that reports a context-window figure must not invent one, so
    /// this has no default: with no declared window, no window is reported.
    #[arg(long, value_name = "TOKENS")]
    pub context_window: Option<u64>,
}
