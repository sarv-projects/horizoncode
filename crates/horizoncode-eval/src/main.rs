//! `hz-eval` command entry point.

use std::io::Read;
use std::path::PathBuf;
use std::process::ExitCode;

use clap::{Parser, Subcommand};
use horizoncode_eval::fixture::{FixtureError, run_smoke};
use horizoncode_eval::{RecordError, validate_bytes};

#[derive(Debug, Parser)]
#[command(
    name = "hz-eval",
    about = "Validate records and run fixed offline evaluation fixtures"
)]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Debug, Subcommand)]
enum Command {
    /// Validate one bounded, integrity-sealed EvaluationRunV1 JSON record.
    Validate {
        /// Path to the evaluation record.
        record: PathBuf,
    },
    /// Run a bounded deterministic offline fixture through the production Runner.
    Run {
        /// The built-in development fixture to run.
        #[arg(long)]
        fixture: String,
        /// New or existing parent directory for immutable evaluation artifacts.
        #[arg(long)]
        output_dir: PathBuf,
    },
}

#[tokio::main]
async fn main() -> ExitCode {
    match run(Cli::parse()).await {
        Ok(()) => ExitCode::SUCCESS,
        Err(error) => {
            eprintln!("hz-eval: {error}");
            ExitCode::FAILURE
        }
    }
}

async fn run(cli: Cli) -> Result<(), String> {
    match cli.command {
        Command::Validate { record } => {
            let file = std::fs::File::open(&record)
                .map_err(|_| "cannot open evaluation record".to_owned())?;
            let mut bytes = Vec::new();
            file.take((horizoncode_eval::MAX_RECORD_BYTES + 1) as u64)
                .read_to_end(&mut bytes)
                .map_err(|_| "cannot read evaluation record".to_owned())?;
            let validated = validate_bytes(&bytes).map_err(|error| match error {
                RecordError::TooLarge => {
                    "evaluation record exceeds the 1 MiB input limit".to_owned()
                }
                RecordError::InvalidSchema | RecordError::Invalid => {
                    "evaluation record failed schema or integrity validation".to_owned()
                }
            })?;
            println!("valid EvaluationRunV1: {}", validated.evaluation_id);
            Ok(())
        }
        Command::Run {
            fixture,
            output_dir,
        } => {
            if fixture != "smoke" {
                return Err("only the `smoke` fixture is supported".to_owned());
            }
            let report = run_smoke(&output_dir).await.map_err(|error| match error {
                FixtureError::OutputPath => {
                    "fixture output directory is not fresh or safe".to_owned()
                }
                FixtureError::Output => "fixture artifact output failed".to_owned(),
                FixtureError::UnsupportedPlatform => {
                    "private fixture artifact publication is unavailable on this platform or filesystem".to_owned()
                }
                FixtureError::Setup => "fixture setup failed".to_owned(),
                FixtureError::TimedOut => "fixture exceeded its wall-time limit".to_owned(),
                FixtureError::TrajectoryLimit => "fixture trajectory exceeded its bound".to_owned(),
                FixtureError::WorkspaceLimit => {
                    "fixture workspace snapshot exceeded its bound".to_owned()
                }
                FixtureError::Runner => "fixture Runner failed".to_owned(),
            })?;
            let summary = serde_json::to_string(&report)
                .map_err(|_| "cannot encode fixture summary".to_owned())?;
            println!("{summary}");
            Ok(())
        }
    }
}
