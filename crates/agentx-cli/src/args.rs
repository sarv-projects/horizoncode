//! Command-line surface (`CMP-headless`, `ARCH/15-PROTOCOLS.md`).

use std::path::PathBuf;

use clap::{Parser, Subcommand, ValueEnum};

/// Exit-code contract, documented in `--help`.
pub const EXIT_CODES_HELP: &str = "\
Exit codes:
  0  turn completed (or partial work saved)
  1  the agent failed to complete the turn
  2  the turn was declined or denied by policy
  3  the turn was interrupted
  4  configuration error (missing or invalid settings)
  5  internal error";

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

/// Standalone, protocol-native command-line coding agent.
#[derive(Debug, Parser)]
#[command(
    name = "agentx",
    version,
    about = "A standalone, protocol-native command-line coding agent.",
    long_about = "Run a one-shot prompt with -p, or start the ACP stdio server with the `acp` subcommand. \
Provider settings come from the environment: AGENTX_BASE_URL, AGENTX_API_KEY, AGENTX_MODEL \
(and AGENTX_HOME to relocate the session store).",
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
}

/// Subcommands.
#[derive(Clone, Copy, Debug, Subcommand)]
pub enum Command {
    /// Run the ACP server over stdio.
    Acp,
}
